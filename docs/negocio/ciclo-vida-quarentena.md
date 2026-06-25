# Ciclo de Vida da Quarentena

A **Quarentena** é uma automação *cross-project* que envolve dois aplicativos da suíte — o **SincronizadorSAP** e o **SincronizadorAD** — para gerenciar o ciclo completo de usuários desligados. Em vez de excluir contas imediatamente, o sistema as move para uma área de retenção no Active Directory (a "quarentena"), desabilitando o acesso mas preservando a possibilidade de retorno caso o colaborador volte a fazer login.

Todo o fluxo é **dirigido por requisições** (requisição-driven): o SincronizadorSAP atua como sensor, abrindo requisições no BDesk quando detecta retornos (logins pós-quarentena) ou expiração (30+ dias sem login); o SincronizadorAD atua como executor, processando essas requisições para mover o usuário de volta à OU original ou para excluí-lo definitivamente.

!!! info "Divisão de responsabilidades"
    - **SincronizadorSAP** — *observa* o Active Directory (varredura LDAP da OU de quarentena) e *abre requisições* no BDesk. Nunca move ou exclui contas.
    - **SincronizadorAD** — *processa requisições abertas* e executa as mutações reais no Active Directory (`MoveTo`, exclusão).

---

## Visão geral do ciclo

```text
                          ┌──────────────────────────────────────┐
                          │         ENTRADA EM QUARENTENA         │
                          │            (SincronizadorAD,          │
                          │          acao=quarentena)             │
                          │                                       │
                          │  1. Salva OU original (extensionAttr) │
                          │  2. Move p/ OU mensal 5S-{MM-yyyy}    │
                          │  3. Grava timestamp no campo info     │
                          │  4. Desabilita a conta (UAC)          │
                          └───────────────────┬──────────────────┘
                                              │
                                  conta desabilitada,
                                 aguardando na quarentena
                                              │
              ┌───────────────────────────────┴───────────────────────────────┐
              │                                                                 │
   ┌──────────▼───────────┐                                       ┌────────────▼───────────┐
   │  MONITORAMENTO        │                                       │  EXPIRAÇÃO              │
   │  (SAP, 06:00          │                                       │  (SAP, 06:15            │
   │   monitorar_quarentena│                                       │   expirar_quarentena)   │
   │                       │                                       │                         │
   │  lastLogon >          │                                       │  dias em quarentena ≥   │
   │  timestampQuarentena? │                                       │  30 E sem login após    │
   │  → abre requisição    │                                       │  → abre requisição      │
   │     de RETORNO        │                                       │     de EXCLUSÃO         │
   └──────────┬────────────┘                                       └────────────┬───────────┘
              │                                                                  │
   ┌──────────▼────────────┐                                       ┌────────────▼───────────┐
   │  RETORNO              │                                       │  EXCLUSÃO               │
   │  (AD, 06:30           │                                       │  (AD, 07:00             │
   │   retornar_quarentena)│                                       │   excluir)              │
   │                       │                                       │                         │
   │  Lê OU original →     │                                       │  Verifica recontratação │
   │  MoveTo(ouOriginal)   │                                       │  → envia p/ Lixeira     │
   │  Limpa metadados      │                                       │  (conta já desabilitada)│
   │  (conta SEGUE         │                                       │                         │
   │   desabilitada)       │                                       │                         │
   └───────────────────────┘                                       └─────────────────────────┘
```

---

## Metadados armazenados no Active Directory

A quarentena é *stateless* em código: não há banco de dados de controle. Todo o estado necessário ao ciclo de vida é gravado no próprio objeto de usuário no AD, em dois atributos:

| Metadado | Atributo AD | Conteúdo | Gravado por |
|----------|-------------|----------|-------------|
| OU de origem | `extensionAttribute` configurável (padrão `msDS-cloudExtensionAttribute1`) | DN da OU original do usuário (sem o `CN=`) | `ExecutorQuarentena.cs` |
| Momento de entrada | `info` | `Movido para quarentena em yyyy-MM-dd HH:mm:ss` | `ExecutorQuarentena.cs` |

!!! note "Atributo configurável"
    O atributo que guarda a OU original tem o padrão `msDS-cloudExtensionAttribute1`, definido em `ExecutorSincronizadorAd.cs` (linha 37), porém é configurável via `config.json` (`ExecutorSincronizadorAd.cs` linhas 69-72). Tanto a gravação (`ExecutorQuarentena.cs`) quanto a leitura (`ExecutorRetornarQuarentena.cs`) usam a mesma propriedade `ExecutorPrincipal.ExtensionAttributeOuOriginal`, garantindo a correspondência.

---

## Escalonamento diário

A ordem das quatro etapas é garantida **exclusivamente pelo agendamento** no Windows Task Scheduler — não há sincronização técnica em código entre os processos. Cada disparo é um executável independente, e os 15 a 30 minutos de espaçamento entre eles servem para garantir que cada etapa já encontre o trabalho da etapa anterior concluído.

| Horário | Comando | Projeto | Papel |
|---------|---------|---------|-------|
| 06:00 | `-acao monitorar_quarentena` | SincronizadorSAP | Detecta logins pós-quarentena e abre requisições de retorno |
| 06:15 | `-acao expirar_quarentena` | SincronizadorSAP | Detecta 30+ dias sem login e abre requisições de exclusão |
| 06:30 | `-executar -acao retornar_quarentena` | SincronizadorAD | Processa requisições de retorno (move de volta à OU original) |
| 07:00 | `-executar -acao excluir` | SincronizadorAD | Processa requisições de exclusão (envia para a Lixeira) |

!!! tip "Detalhe operacional"
    O detalhamento das tarefas agendadas, contas de serviço e servidores está na página **DevOps › Agendamento e Operação**. Esta página cobre apenas a lógica de negócio do ciclo.

!!! note "Por que a ordem importa, mas não trava"
    O monitoramento (06:00) roda antes da expiração (06:15) de propósito: se um usuário fez login no último dia antes de completar 30 dias, o monitoramento abre a requisição de **retorno** primeiro; quando a expiração roda, ela verifica `lastLogonTimestamp` e **pula** esse usuário, evitando abrir uma requisição de exclusão concorrente. A garantia vem do agendamento, não de um *lock* em código.

---

## 1. Entrada em quarentena

Implementada em `src/SincronizadorAd/Executores/ExecutorQuarentena.cs`, no método `MoverParaQuarentena`. A sequência de operações é deliberada — a OU original precisa ser salva **antes** do `MoveTo`, porque o `distinguishedName` muda assim que o objeto é movido.

### Passo a passo

1. **Salva a OU original (antes de mover).** O DN do usuário é lido e a OU é extraída removendo o `CN=...` via `ExtrairOuDoDistinguishedName`. O valor é gravado no `extensionAttribute` com `CommitChanges()` **antes** do `MoveTo` (linhas 178-185), pois o DN deixa de ser válido após a movimentação.

    ```csharp
    // Salvar OU original ANTES de mover (o DN muda após MoveTo)
    var distinguishedName = userEntry.Properties["distinguishedName"].Value.ToString();
    var ouOriginal = ExtrairOuDoDistinguishedName(distinguishedName);

    userEntry.Properties[ExecutorPrincipal.ExtensionAttributeOuOriginal].Value = ouOriginal;
    userEntry.CommitChanges();
    ```

2. **Cria ou reutiliza a OU mensal.** Dentro da OU de quarentena, o método `ObterOuCriarOuMensal` busca (ou cria, se ausente) uma sub-OU com o nome `5S-{MM-yyyy}` — por exemplo `5S-03-2026` (linhas 60-78).

3. **Move o usuário para a OU mensal** via `userEntry.MoveTo(ouMensal)` (linha 190).

4. **Grava o timestamp de entrada** no campo `info` (linha 200):

    ```csharp
    userEntry.Properties["info"].Value = $"Movido para quarentena em {DateTime.Now:yyyy-MM-dd HH:mm:ss}";
    ```

5. **Desabilita a conta** aplicando o bit `ADS_UF_ACCOUNTDISABLE` ao `userAccountControl` via OR bit a bit (linhas 204-207). A constante `ADS_UF_ACCOUNTDISABLE = 0x0002` está definida em `src/Sincronizadores.Lib/ActiveDirectory.cs`.

    ```csharp
    var uac = (int)userEntry.Properties[ExecutorPrincipal.CampoAccountControl][0];
    var uacNovo = uac | ActiveDirectory.ADS_UF_ACCOUNTDISABLE;
    userEntry.Properties[ExecutorPrincipal.CampoAccountControl][0] = uacNovo;
    userEntry.CommitChanges();
    ```

!!! warning "Descrição da OU mensal — discrepância com o código atual"
    A descrição da OU mensal **deveria** ser `OU de quarentena para {MM-yyyy}` (ex.: `OU de quarentena para 03-2026`). No entanto, o código atual em `ExecutorQuarentena.cs` (linha 94) usa:

    ```csharp
    novaOu.Properties["description"].Value = $"OU de quarentena para {nomeOu}";
    ```

    Como `nomeOu` já contém o prefixo (`5S-03-2026`), a descrição resultante fica `OU de quarentena para 5S-03-2026`, com o prefixo `5S-` indevido. O esperado é formatar a descrição diretamente com `{DateTime.Now:MM-yyyy}`, sem o prefixo `5S-`. **Esta divergência está registrada na lista de discrepâncias.**

---

## 2. Monitoramento de retorno

Implementado em `src/SincronizadorSAP/Acoes/AcaoMonitorarQuarentena.cs`. Roda às 06:00. Faz uma varredura LDAP *subtree* da OU de quarentena (via `BuscarUsuariosNaQuarentena`, herdado de `AcaoSincronizadorSAP.cs`, com `PageSize 1000`) e, para cada usuário, detecta se houve login após a entrada em quarentena.

### Detecção de login

A comparação central (linhas 72-79) verifica se o último login é posterior ao momento de entrada na quarentena:

```csharp
// Verificar se logou DEPOIS da quarentena
if (lastLogon.Value <= timestampQuarentena.Value)
{
    // login anterior ou igual à quarentena — não houve retorno
    return;
}
// caso contrário: LOGIN DETECTADO após quarentena
```

!!! note "Por que apenas logins bem-sucedidos contam"
    O atributo `lastLogonTimestamp` só é atualizado pelo Active Directory em **logins bem-sucedidos**. Tentativas de login que falham (senha errada, conta bloqueada) atualizam `badPwdCount` e `badPasswordTime`, mas **não** o `lastLogonTimestamp`. Portanto, ao filtrar por esse atributo, o monitoramento considera implicitamente apenas autenticações concluídas com sucesso. Usuários com `lastLogonTimestamp` nulo (nunca logaram) são pulados (linhas 65-70).

### Abertura de requisição e prevenção de duplicatas

Antes de abrir uma nova requisição de retorno, o código consulta o BDesk via `JaExisteRequisicaoAberta` (linhas 82-89), que busca em `/v1/requisicoes/abertas` por requisições com status **Aberta** ou **Em Andamento** para o mesmo login. Apenas se nenhuma for encontrada é que `AbrirRequisicao` é chamado (linha 97), evitando requisições duplicadas para o mesmo usuário.

---

## 3. Retorno da quarentena

Implementado em `src/SincronizadorAd/Executores/ExecutorRetornarQuarentena.cs`. Roda às 06:30. Processa as requisições de retorno abertas pelo monitoramento.

### Fluxo normal

1. **Lê a OU original** do `extensionAttribute` (linha 28).
2. **Valida que a OU original existe** no AD, montando o caminho LDAP e forçando a leitura da propriedade `name` (linhas 54-76).
3. **Move o usuário de volta** via `userEntry.MoveTo(ouOriginal)` (linha 90).
4. **Limpa os metadados** — `extensionAttribute` e campo `info` — somente **após** a movimentação bem-sucedida (linhas 96-100):

    ```csharp
    userEntry.MoveTo(ouOriginal);
    userEntry.CommitChanges();
    // ...
    userEntry.Properties[ExecutorPrincipal.ExtensionAttributeOuOriginal].Clear();
    userEntry.Properties["info"].Clear();
    userEntry.CommitChanges();
    ```

!!! warning "O retorno NÃO reabilita a conta"
    O `ExecutorRetornarQuarentena.cs` **nunca modifica o `userAccountControl`**. Após o retorno, o usuário volta à OU original mas a conta **permanece DESABILITADA** — exatamente o estado em que foi colocada na entrada da quarentena (`ExecutorQuarentena.cs` linhas 204-207). O retorno apenas reposiciona o objeto na árvore e limpa os metadados de controle.

    A reabilitação efetiva é um **passo separado**, realizado pela ação `manutencao` (`ExecutorManutencao.cs`), que limpa o bit `ADS_UF_ACCOUNTDISABLE` via `AtualizarStatusConta` e reseta a senha.

    **Discrepância com a PRD:** a PRD da automação de quarentena afirma "reativação subsequente" como parte do retorno. O código mostra que a reativação **não** ocorre no retorno — ela depende de uma ação de manutenção independente. **A versão do código prevalece; a divergência está registrada na lista de discrepâncias.**

### Retry inteligente quando o `extensionAttribute` está vazio

O `extensionAttribute` pode aparecer vazio em uma execução por replicação ainda não propagada no AD. Para não marcar insucesso prematuramente, o executor aplica um intervalo de retry — mas **apenas neste cenário específico**:

```text
Ao processar uma requisição de retorno:
  Se extensionAttribute está PREENCHIDO
      → move de volta à OU original e limpa metadados (fluxo normal)
  Se extensionAttribute está VAZIO
      → lê UltimaAcaoQuando da requisição
        Se última ação há MENOS de 12h
            → ignora a requisição (retentará na próxima execução)
        Se última ação há 12h+  OU  data indisponível
            → marca INSUCESSO
```

A constante é fixa em código: `IntervaloMinimoEntreExecucoes = TimeSpan.FromHours(12)` (`ExecutorRetornarQuarentena.cs` linha 15). A lógica está nas linhas 29-47.

!!! warning "Regra anterior corrigida"
    Documentação anterior afirmava que o intervalo de 12 horas se aplicava **sempre** entre execuções de retorno. Isso é **incorreto**: o intervalo de 12h só é considerado quando o `extensionAttribute` está vazio. Em condições normais (atributo preenchido), o retorno é processado de imediato, sem espera. **Discrepância registrada.**

### Casos de insucesso

| Condição | Resultado |
|----------|-----------|
| `extensionAttribute` preenchido e OU existe | Retorno executado (move + limpa metadados) |
| `extensionAttribute` vazio, última ação há **< 12h** | Requisição **ignorada** (retry automático) |
| `extensionAttribute` vazio, última ação há **12h+** ou data indisponível | **Insucesso** |
| OU original não existe / inacessível no AD | **Insucesso** (linhas 68-75) |

---

## 4. Expiração

Implementada em `src/SincronizadorSAP/Acoes/AcaoExpirarQuarentena.cs`. Roda às 06:15. Também varre a OU de quarentena (LDAP *subtree*, `PageSize 1000`) e detecta usuários que permaneceram tempo demais sem retornar.

### Critério de expiração

Um usuário é expirado (gerando uma requisição de **exclusão**) quando ambas as condições são verdadeiras:

1. Permaneceu **N dias ou mais** em quarentena (padrão `DiasParaExpiracao = 30`, configurável via `config.json` → `ActiveDirectory.Quarentena.DiasParaExpiracao`, com fallback `?? 30` em `AcaoSincronizadorSAP.cs` linha 135).
2. **Não** houve login após a entrada em quarentena.

```csharp
// Verificar se expirou (30 dias corridos)
var diasEmQuarentena = (DateTime.Now - timestampQuarentena.Value).TotalDays;
if (diasEmQuarentena < diasExpiracao)
{
    return; // ainda dentro do prazo
}

// Verificar se o usuário logou DEPOIS da quarentena (PRD: "sem login")
var lastLogon = ParseLastLogonTimestamp(usuario);
if (lastLogon.HasValue && lastLogon.Value > timestampQuarentena.Value)
{
    // logou após quarentena — não expira; monitoramento de retorno já atuou
    return;
}
```

!!! note "Contagem em dias corridos"
    A contagem usa `(DateTime.Now - timestampQuarentena.Value).TotalDays` (linha 66) — ou seja, **dias corridos**, incluindo fins de semana e feriados. Não há exclusão de dias não úteis.

!!! note "Interação com o monitoramento de retorno"
    A verificação de `lastLogonTimestamp` na expiração (linhas 75-81) garante que um usuário que voltou a logar **não** seja expirado por engano. Como o monitoramento roda às 06:00 (15 minutos antes), uma requisição de retorno já terá sido aberta para esse usuário, e a expiração simplesmente o pula.

A requisição de exclusão também passa pela verificação anti-duplicata via `JaExisteRequisicaoAberta` (linhas 85-92) antes de ser aberta.

---

## Listas de exceção

Usuários presentes em **listas de exceção** (por login individual ou por pertinência a grupo) são **pulados por todas as automações de quarentena** — tanto no lado SAP quanto no lado AD.

| Lado | Método | Local | Quando é chamado |
|------|--------|-------|------------------|
| SAP | `EstaEmListaExcecao` | `AcaoSincronizadorSAP.cs` (linhas 213-235) | No início do processamento de cada usuário em `monitorar_quarentena` e `expirar_quarentena` |
| AD | `VerificaListasExcecao` | `ExecutorAuxiliarBase.cs` (linhas 227-277) | Antes de `AlterarAD`, em `ExecutorSincronizadorAd.cs` (linhas 315-320) |

O método SAP `EstaEmListaExcecao` verifica tanto o login (linha 217) quanto os grupos do usuário (linhas 222-230). O método AD `VerificaListasExcecao` faz a verificação equivalente e bloqueia a ação marcando `itemHistorico.Insucesso = true` se houver correspondência.

!!! tip "Carregamento tolerante no lado SAP"
    Nas ações SAP de quarentena, o carregamento das listas de exceção é **tolerante**: se o arquivo estiver ausente, o método `LerListaExcecao` (`AcaoSincronizadorSAP.cs` linhas 365-391) registra um **aviso** (`Trace.WriteLine`) e retorna lista vazia, **continuando a operação**. Isso difere da versão do executor principal (`ExecutorAuxiliarBase.LerListaExcecao`), que trata arquivo ausente como **erro fatal**. A intenção é que as ações de quarentena rodem mesmo sem listas configuradas.

---

## Mapeamento de solicitante das requisições

As requisições de quarentena (retorno e exclusão) precisam de um **solicitante** (participante BDesk). Esse valor é derivado da **última OU não-DC** do `distinguishedName` do usuário, consultada no mapeamento `mapeamento-participantes.json`. Se a OU não estiver mapeada, usa-se o *fallback* `Config["BDesk"]["Solicitante"]`.

A lógica está em `ServicoSincronizadorSAP.MapearSolicitante` (linhas 326-362), invocada por `AbrirRequisicao` em `AcaoSincronizadorSAP.cs` (linha 248).

!!! note "Fallback é o esperado para usuários em quarentena"
    Para um usuário em quarentena, a última OU do DN é a OU mensal `5S-{MM-yyyy}`, que **nunca** estará no `mapeamento-participantes.json`. Consequentemente, o mapeamento sempre cai no *fallback* `Config["BDesk"]["Solicitante"]` — esse é o comportamento esperado e correto para as requisições de quarentena.

---

## Resumo das discrepâncias registradas

| # | Documento / PRD afirma | O código mostra |
|---|------------------------|-----------------|
| 1 | Descrição da OU mensal = `OU de quarentena para {MM-yyyy}` | `ExecutorQuarentena.cs:94` usa `{nomeOu}`, resultando em `OU de quarentena para 5S-03-2026` (com prefixo `5S-` indevido) |
| 2 | O retorno reativa a conta ("reativação subsequente") | `ExecutorRetornarQuarentena.cs` **nunca** toca `userAccountControl`; a conta segue desabilitada. Reativação é feita à parte pela ação `manutencao` |
| 3 | Intervalo mínimo de 12h aplicado **sempre** entre execuções de retorno | O intervalo de 12h (`ExecutorRetornarQuarentena.cs:15`) só se aplica quando o `extensionAttribute` está **vazio** |

---

## Arquivos-chave

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/SincronizadorAd/Executores/ExecutorQuarentena.cs` | Entrada: salva OU original, move para OU mensal, grava timestamp, desabilita conta |
| `src/SincronizadorAd/Executores/ExecutorRetornarQuarentena.cs` | Retorno: lê OU original, move de volta, limpa metadados (sem reabilitar) |
| `src/SincronizadorSAP/Acoes/AcaoMonitorarQuarentena.cs` | Monitoramento: detecta login pós-quarentena, abre requisição de retorno |
| `src/SincronizadorSAP/Acoes/AcaoExpirarQuarentena.cs` | Expiração: detecta 30+ dias sem login, abre requisição de exclusão |
| `src/SincronizadorSAP/Acoes/AcaoSincronizadorSAP.cs` | Base das ações SAP: varredura LDAP, listas de exceção, anti-duplicata, mapeamento de solicitante |
| `src/Sincronizadores.Lib/ActiveDirectory.cs` | Constante `ADS_UF_ACCOUNTDISABLE = 0x0002` |
