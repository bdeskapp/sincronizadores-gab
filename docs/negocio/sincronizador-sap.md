# Regras do Sincronizador SAP

O **SincronizadorSAP** é a *passada principal* (main pass) da suíte. É ele quem
faz o **merge de três origens de dados** e produz as colações de usuários
**Novos**, **Alterados** e **Excluídos** que viram requisições no BDesk.

As três origens consolidadas são:

| Origem | Transporte | Detalhe técnico |
|--------|-----------|-----------------|
| **SAP HR** | SOAP / XML | Folha e dados de RH dos colaboradores |
| **Metadados** | HTTP / XML | Base de RH interna complementar |
| **Active Directory** | ADODB COM | Estado atual das contas no AD |

!!! info "Arquivos-chave"
    - `src/SincronizadorSAP/ExecutorSincronizadorSAP.cs` — orquestração do fluxo (merge, montagem de JSONs, limites, deduplicação).
    - `src/SincronizadorSAP/ServicoSincronizadorSAP.cs` — dicionário de dados, comparação de campos, mapeamento de solicitante, conexão ADODB.
    - `src/SincronizadorSAP/Acoes/AcaoSincronizadorSAP.cs` — base das ações de quarentena (busca LDAP, listas de exceção).

O fluxo de consolidação acontece em `CarregarDadosDosServicos()`:
`MontarUsuariosSap` (linha 242) → `AddRange` com `MontarUsuariosMetadados`
(linhas 250-254) → `Comparar_ViaRegraNova` (linha 256). SAP e Metadados são
unidos numa única lista `usuariosOrigem` antes da comparação com o AD.

---

## 1. Exclusão de usuários

### Regra Nova (ativa): 100% dos registros desligados

A exclusão de um CPF **só ocorre quando 100% dos registros consolidados
(SAP + Metadados) daquele CPF estão com `Desligado = true`**. Os registros são
agrupados por **CPF normalizado** via `SomenteDigitos()`.

```csharp
// ExecutorSincronizadorSAP.cs — UsuariosExcluidos_ViaRegraNova (523-536)
var inativos = agrupamentosOrigemSemTotalizar
    .Where(a => a.Where(u => u.Desligado).Count() == a.Count())   // 100% desligados
    ;

var mesmasPessoas =
    from agrupamento in inativos
    join uad in usuariosAD
    on agrupamento.Key equals uad.CPF.SomenteDigitos()           // join por CPF normalizado
    select new TuplaParaExclusao(agrupamento.ToList(), uad);
```

A normalização por CPF aparece tanto na chave do `groupBy` (linha 322) quanto na
condição de `join` (linha 532). O caminho desta regra é:
`Comparar_ViaRegraNova` (linha 256/384) → `UsuariosExcluidos_ViaRegraNova`
(linhas 523-536).

!!! tip "Por que 100%?"
    Um colaborador pode aparecer em mais de um registro (vínculos/matrículas
    distintos em SAP e Metadados). Exigir que **todos** estejam desligados evita
    excluir alguém que ainda mantém um vínculo ativo em outra origem.

### Regra Antiga (presente, mas desligada do fluxo)

A **Regra Antiga** `UsuariosExcluidos()` (linhas 507-520) ainda existe no código,
mas **não está ligada ao fluxo principal**. Ela usa um critério agressivo:
qualquer registro com `Desligado = true` já dispara a exclusão.

```csharp
// ExecutorSincronizadorSAP.cs — UsuariosExcluidos (507-520) — NÃO USADO no main pass
var inativos = usuariosOrigem
    .Where(u => u.Desligado)   // QUALQUER registro desligado dispara exclusão
    ;
```

!!! warning "Regra Antiga mantida apenas por compatibilidade"
    O método antigo `Comparar()` (linhas 391-475) — que invoca a `UsuariosExcluidos()`
    na linha 469 — **não é chamado** no fluxo principal. O fluxo principal usa
    exclusivamente `Comparar_ViaRegraNova()`. A Regra Antiga permanece no código
    por compatibilidade, mas seu critério agressivo está inativo.

---

## 2. Detecção de alteração

Apenas **dois campos** determinam se um usuário é considerado *alterado*, ambos
comparados de forma **case-insensitive** (via `ToLower()`):

| Campo SAP | Atributo AD | Significado |
|-----------|-------------|-------------|
| **DA16** | `title` | Cargo |
| **DA19** | `postalCode` | Centro de Custo |

```csharp
// ServicoSincronizadorSAP.cs — Diferentes (721-734)
foreach (var campo in CamposAComparar)            // só DA16 e DA19
{
    var v1 = ...ToLower();   // case-insensitive
    var v2 = ...ToLower();
    if (v1 != v2) { /* registra diferença */ }
}
```

A lista `CamposAComparar` é derivada (construtor, linhas 40-43) de
`DicionarioDeDados.Where(d => d.Comparar)`. Em `NovoDicionario()`
(linhas 103-119), apenas **DA16-Cargo** (linha 105) e **DA19-Centro-de-Custo**
(linha 119) recebem `Comparar = true`.

!!! note "Data de Nascimento (DA13) é sincronizada, mas não detecta alteração"
    O campo **DA13 (Data de Nascimento)** é definido em `ServicoSincronizadorSAP.cs`
    (linhas 58-62) **sem** o flag `Comparar` (portanto `false` por padrão). Ele é
    **incluído** no dicionário enviado ao BDesk em `MontarDadosCliente()` (linha 219),
    ou seja, **é sincronizado** — mas como não está em `CamposAComparar`, **nunca**
    dispara uma alteração por si só.

---

## 3. Solicitante (participante "ANTE")

O solicitante de cada requisição (o participante de papel **ANTE**) é derivado da
**última OU do Distinguished Name (DN)** do usuário no AD.

A lógica em `MapearSolicitante` (`ServicoSincronizadorSAP.cs:326-362`) é:

1. **Split do DN por vírgula** (linha 341).
2. Divide cada parte por `=` separando chave e valor (linhas 343-346).
3. **Filtra as partes cuja chave é `DC`** e extrai o valor (lado direito do `=`)
   (linhas 348-352).
4. Toma o `Last()` dessa sequência filtrada — a **última OU** (linha 354).
5. Faz *lookup* em `LoginsDoSolicitantePorOu` (linha 355).
6. **Fallback** para `Config["BDesk"]["Solicitante"]` se o lookup retornar nulo
   (linha 361).

O dicionário `LoginsDoSolicitantePorOu` é populado por
`CarregarMapeamentoParticipantes` (`ExecutorSincronizadorSAP.cs:1122-1153`),
que lê o arquivo **`mapeamento-participantes.json`**.

---

## 4. Retry de solicitante alternativo

Quando o BDesk recusa a requisição porque o participante ANTE não existe para
aquele login, o sistema **tenta logins alternativos** automaticamente.

O retry só dispara se a mensagem de erro for **exatamente**:

```text
Participante 'ANTE' não encontrado para o Login 'X'.
```

O método `TentativasAPI` (`ExecutorSincronizadorSAP.cs:1057-1118`) itera sobre a
coleção de `AlternativaEnvioBDesk`, cada uma com um `LoginSolicitante` diferente
(`EnvioBDesk.cs:65`):

- Se a submissão tiver sucesso, retorna (linhas 1083-1086).
- Se houver múltiplas linhas de erro, retorna imediatamente (linhas 1088-1090).
- Se a mensagem for **exatamente** a do participante ausente (linhas 1092-1096),
  passa para a **próxima alternativa**.
- Se todas as alternativas falharem, retorna o último resultado (linha 1117).

!!! warning "Match exato da mensagem"
    O retry depende da string de erro ser idêntica. Qualquer outro erro do BDesk
    **não** aciona o retry e é tratado como falha imediata.

---

## 5. Deduplicação de exclusões (janela de 7 dias)

Antes de montar os JSONs, o sistema **remove logins cuja exclusão já foi
bem-sucedida** nos últimos **7 dias** (janela configurável).

!!! danger "O que conta como 'já solicitado'"
    A deduplicação **não** remove "logins já submetidos". Ela remove **apenas
    logins cuja exclusão retornou um ID de requisição válido da API do BDesk** —
    ou seja, exclusões **bem-sucedidas** — impedindo retentativas acidentais.

A remoção ocorre em `RemoverRecentementeSolicitados` (chamada em
`ExecutorSincronizadorSAP.cs:264`), **antes** da montagem dos JSONs, lendo os
registros de **`LocalData/yyyyMMdd.json`** dos últimos dias. O número de dias vem
de `Config["BDesk"]["DiasDeEsperaPorExclusoes"]` com padrão **7**.

---

## 6. Limites por execução

Para conter o *blast radius*, cada execução respeita tetos configuráveis,
aplicados em `Agregar()`:

| Limite | Linha | Configuração |
|--------|-------|--------------|
| Máximo de inserções | 880 | `QuantidadeMaximaDeInsercoes` |
| Máximo de atualizações | 889 | `QuantidadeMaximaDeAtualizacoes` |
| Máximo de exclusões | 898 | `QuantidadeMaximaDeExclusoes` |

Parâmetros de busca no AD:

| Contexto | Mecanismo | PageSize | Timeout |
|----------|-----------|----------|---------|
| **Main pass** | ADODB COM (`ObterUsuariosAD`) | **10000** | **30 s** |
| **Ações de quarentena** | LDAP `DirectorySearcher` | **1000** | — |

- ADODB main pass: `cmd.Properties["Page Size"] = 10000` e `Timeout = 30`
  (`ServicoSincronizadorSAP.cs:886-887`).
- LDAP das ações: `PageSize = 1000` (`AcaoSincronizadorSAP.cs:98`).

---

## 7. Listas de exceção da sincronização

Duas listas controlam quais usuários/grupos são poupados da sincronização do AD:

- `lista-negra-ad-grupos.txt`
- `lista-negra-ad-logins.txt`

Carregadas na inicialização do main pass (`ExecutorSincronizadorSAP.cs:138-139`).

!!! note "Pulam atualização e exclusão — mas permitem inserção"
    No método `Agregar()` (linhas 939-955), o filtro das listas só é aplicado
    **quando a ação não é `inserir`**. Ou seja: usuários/grupos nessas listas
    **não** são atualizados nem excluídos, mas **podem ser inseridos**
    normalmente no AD.

---

## 8. Listas de exceção da quarentena

Outras duas listas controlam a quarentena:

- `lista-negra-quarentena-grupos.txt`
- `lista-negra-quarentena-logins.txt`

A diferença de comportamento **quando o arquivo está ausente** é importante:

| Contexto | Arquivo ausente | Evidência |
|----------|-----------------|-----------|
| **Main pass** | **ERRO** — adiciona mensagem de erro e aborta | `ExecutorSincronizadorSAP.cs` — `LerListaExcecao` (1172-1203), erro na linha 1179; verificação 144-147 |
| **Ações** (monitorar/expirar) | **SILENCIOSO** — retorna lista vazia | `AcaoSincronizadorSAP.cs` — `LerListaExcecao` (371-391), lista vazia na linha 377 |

!!! info "Comportamento silencioso é intencional nas ações"
    Há um comentário explícito em `AcaoSincronizadorSAP.cs` (linhas 365-370)
    explicando que as ações de quarentena **devem executar mesmo sem as listas
    de exceção** — por isso retornam lista vazia em vez de falhar.

---

## 9. `AtividadeExcluir` não é validado na inicialização

A validação de campos obrigatórios (`CamposObrigatoriosIni`,
`ServicoSincronizadorSAP.cs:188-209`) lista **apenas** `AtividadeAtualizar` e
`AtividadeInserir` na seção `[BDesk]`.

!!! warning "Falha tardia em exclusões"
    A chave `AtividadeExcluir` **não** é checada na inicialização. Ela só é
    consumida em runtime por `MontarJSONExclusao` (linha 442), invocada a partir
    de `MontarJSONs` (linha 901). Portanto, se a chave estiver ausente no
    `conf.ini`, **a falha só ocorre quando há exclusões a processar** — não na
    partida do programa.

---

## Quarentena por inatividade

O main pass também abre requisições de **quarentena por inatividade**
(`DiasInatividade`, padrão **90**), e as ações `monitorar_quarentena` /
`expirar_quarentena` gerenciam o restante do ciclo.

!!! note "Página dedicada"
    O ciclo completo (entrada na quarentena, monitoramento de retorno, expiração
    e exclusão definitiva, com os horários e as ações cross-projeto entre SAP e
    AD) está documentado em **[Ciclo de Vida da Quarentena](ciclo-vida-quarentena.md)**.

---

## Discrepâncias

!!! warning "Divergências entre documentação e código"

    1. **`AtividadeExcluir` não validado na inicialização.**
       A documentação existente lista `AtividadeExcluir` como campo obrigatório,
       mas o código (`CamposObrigatoriosIni`, `ServicoSincronizadorSAP.cs:188-209`)
       valida apenas `AtividadeAtualizar` e `AtividadeInserir`. A ausência de
       `AtividadeExcluir` resulta em **falha tardia** durante o processamento de
       exclusões (`MontarJSONExclusao`, linhas 442/901), e não na partida. **A
       versão do código vence.**

    2. **Dependência crítica de `CaminhoConfigSincronizadorAd` para as ações.**
       As ações de quarentena dependem de
       `Config["ActiveDirectory"]["CaminhoConfigSincronizadorAd"]` para localizar
       os templates do SincronizadorAD (`AcaoSincronizadorSAP.cs:62-73`). Essa
       dependência cross-projeto é essencial para as ações funcionarem e deve ser
       observada na configuração.
