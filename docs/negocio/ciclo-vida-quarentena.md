# Ciclo de Vida da Quarentena

O **Ciclo de Vida da Quarentena** é um fluxo *cross-project* que envolve dois aplicativos da suíte — **SincronizadorSAP** e **SincronizadorAD** — para gerenciar contas desligadas no Active Directory por meio de **estados temporários isolados**. Em vez de excluir imediatamente uma conta inativa, o sistema a move para uma área de quarentena, monitora se o colaborador volta a logar e, somente após um período sem atividade, dispara a exclusão definitiva.

A separação de responsabilidades é clara:

- O **SincronizadorSAP** observa a OU de quarentena e **abre requisições** no BDesk (não toca no AD nesse fluxo).
- O **SincronizadorAD** **executa as mutações** no AD (mover de volta ou excluir), consumindo essas requisições.

!!! info "Onde estão os horários e os parâmetros"
    Esta página descreve a **jornada de negócio** e a lógica de cada etapa. Para os horários completos do agendador (Task Scheduler), consulte a página de **Agendamento (DevOps)**. Para os parâmetros configuráveis em `[ActiveDirectory][Quarentena]`, consulte a página de **Configuração**.

---

## Visão geral da jornada

A conta percorre uma sequência de estados. Em cada transição, ou o SAP detecta uma condição e abre uma requisição, ou o AD executa a operação correspondente.

```text
                          ┌──────────────────────────────────────────────┐
                          │                  ATIVA (AD)                   │
                          └──────────────────────────────────────────────┘
                                                │
              SincronizadorAD -acao quarentena  │  (entrada na quarentena)
                                                ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │  EM QUARENTENA                                                                  │
   │  - movida para OU mensal 5S-{MM-yyyy} (conta DESABILITADA)                      │
   │  - OU original salva em extensionAttribute / timestamp gravado em 'info'        │
   └───────────────────────────────────────────────────────────────────────────────┘
              │                                                       │
   logou após quarentena                                  30+ dias SEM login posterior
   (monitorar_quarentena, SAP)                            (expirar_quarentena, SAP)
              │                                                       │
              ▼                                                       ▼
   abre requisição de RETORNO                              abre requisição de EXCLUSÃO
   (retornar-quarentena.json)                              (excluir-definitivo.json)
              │                                                       │
   retornar_quarentena (AD)                                excluir (AD)
              ▼                                                       ▼
   ┌──────────────────────────────┐                    ┌──────────────────────────────┐
   │  RETORNADA À OU ORIGINAL      │                    │  EXCLUÍDA (lixeira AD)        │
   │  (permanece DESABILITADA)     │                    │  com verificação de           │
   │                               │                    │  recontratação                │
   └──────────────────────────────┘                    └──────────────────────────────┘
```

### Agendamento e responsabilidades

| Horário | Aplicativo / Ação | Papel | O que faz |
|---------|-------------------|-------|-----------|
| 06:00 | `SincronizadorSAP.exe -acao monitorar_quarentena` | **Detecta** | Identifica logins *pós-quarentena* e abre requisição de **retorno** no BDesk |
| 06:15 | `SincronizadorSAP.exe -acao expirar_quarentena` | **Detecta** | Identifica inatividade de **30+ dias** e abre requisição de **exclusão** no BDesk |
| 06:30 | `SincronizadorAD.exe -executar -acao retornar_quarentena` | **Executa** | Move a conta de volta para a OU original |
| 07:00 | `SincronizadorAD.exe -executar -acao excluir` | **Executa** | Exclui a conta expirada (com verificação de recontratação) |

!!! warning "Ordem obrigatória: monitorar ANTES de expirar"
    A ação `monitorar_quarentena` (06:00) **deve** rodar **antes** de `expirar_quarentena` (06:15) para capturar logins de "última hora". Essa ordem **não é forçada internamente** — depende do agendador externo —, mas a implementação a **assume explicitamente**: `AcaoExpirarQuarentena` não expira contas cujo `lastLogonTimestamp` seja posterior ao timestamp de quarentena, pressupondo que o monitoramento de retorno já tenha aberto a requisição correspondente (`AcaoExpirarQuarentena.cs:75-81`). Se a ordem for invertida no agendador, ainda assim a guarda de `expirar_quarentena` evita exclusões indevidas de quem logou.

---

## Etapa 1 — Entrada em quarentena

Implementada em `ExecutorQuarentena.cs`, método `MoverParaQuarentena` (`src/SincronizadorAd/Executores/ExecutorQuarentena.cs`). A ordem das operações é importante porque o *distinguishedName* muda assim que a conta é movida.

### 1. Salva a OU original ANTES de mover

A OU de origem (o DN **sem o CN**) é extraída do `distinguishedName` e gravada no atributo configurável `ExtensionAttributeOuOriginal` (padrão `msDS-cloudExtensionAttribute1`) **antes** do `MoveTo`, com `CommitChanges()` imediato — porque o DN muda após o move (`ExecutorQuarentena.cs:178-191`).

```csharp
// Salvar OU original ANTES de mover (o DN muda após MoveTo)
var distinguishedName = userEntry.Properties["distinguishedName"].Value.ToString();
var ouOriginal = ExtrairOuDoDistinguishedName(distinguishedName);
userEntry.Properties[ExecutorPrincipal.ExtensionAttributeOuOriginal].Value = ouOriginal;
userEntry.CommitChanges();   // persiste a OU original
// ...
userEntry.MoveTo(ouMensal);  // só então move
```

### 2. Move para a OU mensal `5S-{MM-yyyy}`

A conta é movida para uma OU mensal nomeada `5S-{MM-yyyy}` (ex.: `5S-06-2026`), localizada sob a OU de quarentena configurada (`OuDestino`). Se a OU mensal ainda não existir, ela é criada (`ObterOuCriarOuMensal` em `ExecutorQuarentena.cs:59-80`; `CriarOuMensal` em `82-111`).

!!! note "Descrição da OU mensal inclui o prefixo `5S-`"
    A descrição gravada na OU criada é `OU de quarentena para 5S-{MM-yyyy}` (`ExecutorQuarentena.cs:94`). O nome `nomeOu` já contém o prefixo `5S-`, portanto a descrição final fica, por exemplo, `OU de quarentena para 5S-06-2026`. Documentação anterior que omitia o prefixo `5S-` está corrigida (ver **Discrepâncias**).

### 3. Grava o timestamp de quarentena no campo `info`

O campo `info` recebe a marcação no **formato exato** `Movido para quarentena em yyyy-MM-dd HH:mm:ss` (`ExecutorQuarentena.cs:200`). Esse formato é um **contrato** entre projetos: as ações do SAP fazem o *parse* desse texto.

```csharp
userEntry.Properties["info"].Value = $"Movido para quarentena em {DateTime.Now:yyyy-MM-dd HH:mm:ss}";
```

### 4. Desabilita a conta

A conta é desabilitada via `userAccountControl |= ADS_UF_ACCOUNTDISABLE` (`0x0002`), aplicando o bit de desativação com `CommitChanges()` (`ExecutorQuarentena.cs:204-207`). O acesso é bloqueado imediatamente.

### 5. Usuários em grupos de exceção NÃO são movidos

Antes de mover, o executor lê `GruposExcecao` de `lista-negra-quarentena-grupos.txt` (`ExecutorQuarentena.cs:23-24`) e calcula a interseção (`Intersect`) com os grupos do usuário (`MemberOf`). Se houver qualquer interseção, a conta **não** é movida: a operação é marcada como insucesso e retorna sem executar `MoverParaQuarentena` (`ExecutorQuarentena.cs:126-137`).

---

## Etapa 2 — Monitoramento de retorno (login pós-quarentena)

Implementada em `AcaoMonitorarQuarentena.cs` (`src/SincronizadorSAP/Acoes/`), executada às 06:00 pelo SincronizadorSAP. Objetivo: detectar quem **voltou a logar** enquanto estava na quarentena e reverter o isolamento.

Para cada conta na OU de quarentena:

1. **Valida o timestamp** — faz o *parse* do campo `info` exigindo o prefixo `Movido para quarentena em ` seguido do formato `yyyy-MM-dd HH:mm:ss` (`ParseTimestampQuarentena`, `AcaoSincronizadorSAP.cs:142-164`). Contas sem timestamp válido são puladas.
2. **Ignora quem nunca logou** — se `lastLogonTimestamp` for nulo (conta nunca usada), o usuário é ignorado (`AcaoMonitorarQuarentena.cs:63-70`; `ParseLastLogonTimestamp`, `AcaoSincronizadorSAP.cs:170-185`). Apenas logins com sucesso contam.
3. **Compara** — se `lastLogonTimestamp > timestampQuarentena`, houve login *após* a entrada em quarentena.
4. **Evita duplicata** — antes de abrir, chama `JaExisteRequisicaoAberta` para verificar se já existe requisição de retorno em aberto para o mesmo login (`AcaoMonitorarQuarentena.cs:82-89`).
5. **Abre a requisição** — `retornar-quarentena.json` (**Formulário 1584, Atividade 3037**).

---

## Etapa 3 — Expiração (inatividade prolongada)

Implementada em `AcaoExpirarQuarentena.cs`, executada às 06:15 pelo SincronizadorSAP. Objetivo: marcar para **exclusão definitiva** quem permaneceu na quarentena sem logar.

A conta expira quando:

```text
(DateTime.Now - timestampQuarentena).TotalDays >= DiasParaExpiracao
```

onde `DiasParaExpiracao` tem **default 30** (`ObterDiasParaExpiracao`, `AcaoSincronizadorSAP.cs:135`), configurável em `[ActiveDirectory][Quarentena][DiasParaExpiracao]`. A contagem é em **dias corridos** (`TotalDays`).

Guardas de segurança antes de abrir a exclusão:

- **Não expira se houve login posterior** — se `lastLogonTimestamp > timestampQuarentena`, a conta é poupada, pois o monitoramento de retorno já deve ter atuado (`AcaoExpirarQuarentena.cs:75-81`).
- **Evita duplicata de exclusão** — verifica `JaExisteRequisicaoAberta` na atividade de exclusão antes de abrir (`AcaoExpirarQuarentena.cs:85-92`).

Quando todas as condições são satisfeitas, abre `excluir-definitivo.json` (**Formulário 1584, Atividade 1038**).

---

## Etapa 4 — Retorno à OU original

Implementada em `ExecutorRetornarQuarentena.cs`, executada às 06:30 pelo SincronizadorAD ao consumir a requisição de retorno aberta pelo SAP.

1. **Lê a OU original** do `ExtensionAttributeOuOriginal` (`ExecutorRetornarQuarentena.cs:28`).
2. **Valida que a OU original existe** — cria um `DirectoryEntry` para o caminho LDAP e força a leitura da propriedade `name` (o `DirectoryEntry` é *lazy*; o acesso à propriedade é que confirma a existência no AD). Se falhar, marca insucesso com a mensagem "OU original não encontrada ou inacessível" (`ExecutorRetornarQuarentena.cs:54-76`).
3. **Move de volta** com `MoveTo` + `CommitChanges` e, em seguida, **limpa** os campos `ExtensionAttributeOuOriginal` e `info` (`ExecutorRetornarQuarentena.cs:87-109`).

!!! warning "O retorno NÃO reabilita a conta"
    `ExecutorRetornarQuarentena` **nunca** modifica `userAccountControl` — a conta **permanece desabilitada** após o retorno. A reabilitação é responsabilidade de um **sincronizador subsequente** (conforme PRD, seção 3.3), não do retorno imediato. Esse é um ponto comum de chamado de suporte ("a conta voltou para a OU mas continua bloqueada"); o comportamento é intencional.

### Guarda anti-corrida de 12 horas

Se o `ExtensionAttributeOuOriginal` estiver **vazio**, o executor não falha imediatamente: ele consulta `UltimaAcaoQuando` da requisição BDesk e, se a última ação ocorreu há **menos de 12 horas** (`IntervaloMinimoEntreExecucoes = TimeSpan.FromHours(12)`, constante `static readonly` em `ExecutorRetornarQuarentena.cs:15`), **aguarda** — retorna sem marcar insucesso. Só após 12 horas a ausência da OU original é tratada como insucesso (`ExecutorRetornarQuarentena.cs:29-47`).

!!! tip "Por que esperar 12 horas?"
    Evita uma **condição de corrida** com o `ExecutorQuarentena`: se a requisição de retorno for processada logo após a entrada em quarentena (antes de o atributo ser totalmente persistido/propagado), o intervalo mínimo dá margem para que o estado se estabilize antes de declarar erro.

---

## Etapa 5 — Exclusão definitiva

A exclusão (07:00) reaproveita o executor já existente do Sincronizador AD (`ExecutorExclusaoPorLogin`), que aplica a **verificação de recontratação** (consulta por CPF em Metadados e SAP; se recontratado, reativa a conta e bloqueia a exclusão).

!!! note "Detalhes da exclusão"
    A lógica completa de exclusão — incluindo a verificação de recontratação, a regra de "só exclui se a conta estiver inativa" e o tratamento de contas já em quarentena — está documentada na página do **Sincronizador AD**. Aqui basta saber que a requisição `excluir-definitivo.json` (Atividade 1038) aberta pelo SAP é consumida por esse executor.

---

## Contrato entre projetos e listas de exceção

### O campo `info` é o contrato de timestamp

O formato exato `Movido para quarentena em yyyy-MM-dd HH:mm:ss` é gravado pelo AD (`ExecutorQuarentena.cs:200`) e lido pelas ações do SAP (`ParseTimestampQuarentena`, `AcaoSincronizadorSAP.cs:142-164`). Alterar esse formato em um dos lados quebra o ciclo.

### Listas de exceção das ações são silenciosas

As ações de quarentena do SAP leem `lista-negra-quarentena-logins.txt` e `lista-negra-quarentena-grupos.txt` via `AcaoSincronizadorSAP.LerListaExcecao` (`AcaoSincronizadorSAP.cs:371-391`). Se os arquivos **não existirem**, o método retorna **lista vazia silenciosamente**, sem registrar erro — comportamento **intencional** (comentário em `AcaoSincronizadorSAP.cs:365-370`): as ações de quarentena devem executar mesmo sem listas de exceção.

!!! note "Diferença em relação ao main pass"
    No *main pass* do SAP (`ExecutorSincronizadorSAP.LerListaExcecao`), a ausência das mesmas listas é tratada como **erro** e aborta a execução. Apenas no contexto das **ações** (`monitorar_quarentena` / `expirar_quarentena`) o comportamento é silencioso.

---

## Discrepâncias

!!! warning "Divergências entre documentação anterior e o código"

    **(a) `MapearSolicitante` para usuários em quarentena**
    A documentação anterior afirmava que, para um usuário em quarentena (DN do tipo `OU=5S-MM-yyyy,OU=Quarentena,...`), o mapeamento de solicitante não seria encontrado e cairia no *fallback* `config[BDesk][Solicitante]`. **Correção:** `MapearSolicitante` (`ServicoSincronizadorSAP.cs:326-362`) usa a **última OU do DN**, que para um usuário em quarentena ainda corresponde à **OU original mapeada** (a OU de quarentena não entra como chave de busca da forma assumida). Portanto o comportamento é **idêntico ao de um usuário fora de quarentena**: se a OU original estiver mapeada em `mapeamento-participantes.json`, o solicitante é encontrado normalmente; o *fallback* só ocorre quando a OU original não está mapeada.

    **(b) Reabilitação no retorno**
    Documentação anterior sugeria que "um sincronizador subsequente reabilita a conta". **Confirmado** que `ExecutorRetornarQuarentena` **não** reabilita: o código nunca modifica `userAccountControl`/`CampoAccountControl` após o retorno (`ExecutorRetornarQuarentena.cs:23-110`). A reabilitação fica a cargo de etapa posterior (PRD seção 3.3).

    **(c) Contagem de dias para expiração**
    **Confirmado** que a expiração usa **dias corridos** via `TotalDays` na comparação `(DateTime.Now - timestampQuarentena).TotalDays >= DiasParaExpiracao` (`AcaoExpirarQuarentena.cs:66-71`), e não dias úteis.

    **(d) Descrição da OU mensal**
    Documentação anterior descrevia a descrição como `OU de quarentena para {MM-yyyy}`, **omitindo o prefixo `5S-`**. **Correção:** a descrição real é `OU de quarentena para 5S-{MM-yyyy}` (`ExecutorQuarentena.cs:94`).

---

## Referências cruzadas

- **Agendamento (DevOps)** — horários completos do ciclo (06:00 / 06:15 / 06:30 / 07:00) e do *main pass*.
- **Configuração** — parâmetros `[ActiveDirectory][Quarentena]`: `OuDestino`, `DiasInatividade`, `MaximoAbertura`, `DiasParaExpiracao` (default 30) e `ExtensionAttributeOuOriginal` (default `msDS-cloudExtensionAttribute1`).
- **Sincronizador AD** — detalhes do executor de exclusão (`ExecutorExclusaoPorLogin`) e da verificação de recontratação.
- **Sincronizador SAP** — *main pass*, detecção de candidatos a quarentena por inatividade (`DiasInatividade`, default 90) e abertura inicial das requisições de quarentena.
