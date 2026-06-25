# Regras do Sincronizador SAP

O **SincronizadorSAP** é uma aplicação console em C# .NET 8.0 que mantém os dados de
funcionários consistentes entre quatro sistemas:

| Papel | Sistema | Protocolo de acesso |
|-------|---------|---------------------|
| Origem primária | **SAP HR** | SOAP / XML |
| Origem secundária | **Metadados** | HTTP / XML |
| Destino das mutações | **Active Directory** | ADODB COM (LDAP) |
| Abertura de requisições | **BDesk** | REST |

O SAP HR é a fonte de verdade dos dados funcionais; o Metadados complementa essa
base; o Active Directory recebe as mutações; e o BDesk registra as requisições
(inserções, atualizações, exclusões e fluxo de quarentena).

Arquivos-chave:

- `src/SincronizadorSAP/ExecutorSincronizadorSAP.cs`
- `src/SincronizadorSAP/ServicoSincronizadorSAP.cs`
- `src/SincronizadorSAP/Acoes/AcaoSincronizadorSAP.cs`

!!! info "Convenção de português"
    Todo o código (identificadores, comentários e strings) está em português do
    Brasil. Os nomes de classe, método e linha citados nesta página são reais.

---

## Dois modos de operação

O SincronizadorSAP funciona em dois modos distintos, selecionados pela linha de
comando:

### 1. Passada principal

A passada principal é o merge completo. Ela carrega SAP + Metadados + Active
Directory, compara os dados, monta os lotes de **Novos**, **Alterados** e
**Excluídos**, abre as requisições correspondentes no BDesk e ainda dispara a
**abertura de quarentena** para usuários inativos.

### 2. Ações de quarentena

São executadas com o parâmetro `-acao`:

- `monitorar_quarentena` — detecta logins de usuários já em quarentena e abre
  requisições de retorno;
- `expirar_quarentena` — detecta usuários que ultrapassaram o prazo em quarentena
  sem login e abre requisições de exclusão.

!!! note "Detalhes do fluxo de quarentena"
    Os limiares (`DiasInatividade`, `DiasParaExpiracao`, `MaximoAbertura`) e as
    regras completas do ciclo são detalhados na página
    [Ciclo de Vida da Quarentena](ciclo-vida-quarentena.md). Aqui descrevemos
    apenas como o SincronizadorSAP participa desse ciclo.

---

## Regra de exclusão (regra nova)

!!! warning "Regra ativa: exclusão somente com 100% de registros desligados"
    Um CPF só é marcado para exclusão quando **todos** os registros daquele CPF —
    agregados de SAP **e** Metadados — estão com status `Desligado`. Se houver pelo
    menos um registro ativo, o CPF **não** é excluído.

Essa lógica está em `UsuariosExcluidos_ViaRegraNova`
(`ExecutorSincronizadorSAP.cs:523-536`). O agrupamento é feito por CPF normalizado
(`.SomenteDigitos()`), e o teste-chave é:

```csharp
// ExecutorSincronizadorSAP.cs:526
.Where(a => a.Where(u => u.Desligado).Count() == a.Count())
```

Ou seja, a quantidade de registros desligados precisa ser igual à quantidade total
de registros do agrupamento do CPF.

### Regra antiga (não invocada)

Existe também a **Regra Antiga** em `UsuariosExcluidos`
(`ExecutorSincronizadorSAP.cs:507-520`), que marcava o CPF para exclusão se
**qualquer** registro estivesse desligado. Ela permanece **compilada, mas nunca é
invocada** no fluxo principal: a linha `256` de `CarregarDadosDosServicos` chama
`Comparar_ViaRegraNova`, não `Comparar`. A versão antiga é mantida apenas por
compatibilidade de compilação.

---

## Campos comparados

Apenas dois campos são comparados para determinar se um usuário deve ser
**alterado**:

| Campo | Significado | Comparado? |
|-------|-------------|------------|
| **DA16** | Cargo | Sim |
| **DA19** | Centro de Custo | Sim |
| **DA13** | Data de Nascimento | Não (sincronizado, não comparado) |

Em `ServicoSincronizadorSAP.cs`, o método `NovoDicionario()` define `Comparar=true`
apenas para `DA16-Cargo` e `DA19-Centro-de-Custo`; os demais campos têm
`Comparar=false`. A coleção `CamposAComparar` é montada filtrando exatamente esses
dois campos.

A comparação é **case-insensitive**: o método `Diferentes()`
(`ServicoSincronizadorSAP.cs:721-734`) converte ambos os valores com `.ToLower()`
antes de compará-los.

!!! tip "DA13 é sincronizado, mas não dispara alteração"
    A Data de Nascimento (DA13) é levada ao AD durante a sincronização, mas como
    `Comparar=false`, uma divergência apenas nela **não** marca o usuário como
    alterado.

---

## Pipeline de agregação

A montagem de cada lote passa pelo método `Agregar`
(`ExecutorSincronizadorSAP.cs:909-977`), chamado uma vez por tipo de ação
(`inserir`, `atualizar`, `excluir`). A ordem dos filtros é:

1. **Permitidos** — se houver lista de usuários permitidos (whitelist), mantém
   apenas os CPFs presentes nela (linhas 921-931).
2. **Proibidos** — remove os CPFs presentes na lista de proibidos (linhas 936-937).
3. **Exceção AD** — remove usuários cujo login ou grupo esteja nas listas de
   exceção do AD (linhas 939-955), **somente se** `acao != "inserir"`.
4. **Limite de lote** — aplica `.Take(maximo)` (linha 963).

!!! note "Inserir nunca é filtrado por exceção AD"
    O bloco de exceção AD é condicionado a `if (acao != "inserir")`. Assim, um
    usuário em lista de exceção do AD **continua podendo ser inserido**; apenas
    `atualizar` e `excluir` respeitam essa exceção.

### Limites de lote

Os limites por execução vêm da seção `[BDesk]` do `conf.ini`:

- `QuantidadeMaximaDeInsercoes`
- `QuantidadeMaximaDeAtualizacoes`
- `QuantidadeMaximaDeExclusoes`

!!! info "Valor 0 significa sem limite"
    Quando um desses parâmetros é `0`, não há teto — todos os itens do lote são
    processados.

---

## Deduplicação de exclusões

Antes de submeter o lote de exclusões, o sistema remove qualquer **login**
(`sAMAccountName`) já submetido recentemente, evitando reabrir exclusões
duplicadas. A janela é dada por `BDesk.DiasDeEsperaPorExclusoes` (padrão **7**), e os
logins já submetidos são lidos dos arquivos `LocalData/yyyyMMdd.json`
(`RemoverRecentementeSolicitados`, `ExecutorSincronizadorSAP.cs:539+`).

!!! warning "A deduplicação é por LOGIN, não por CPF"
    A deduplicação compara o `sAMAccountName` (login) submetido nos últimos N dias.
    **Não existe** deduplicação por CPF. Esse ponto corrige uma imprecisão comum: a
    janela de espera olha apenas o login, nunca o CPF.

---

## Filtros de pré-comparação

Antes de comparar SAP/Metadados com o AD, várias remoções são aplicadas:

| Filtro | Onde aplica | Comportamento |
|--------|-------------|---------------|
| **Sem CPF** | SAP, Metadados e AD | Remove registros com CPF vazio (`RemoverSemCPF`, linhas 202/213/228) |
| **Conta AD desabilitada** | AD | Remove contas com `ADS_UF_ACCOUNTDISABLE` ligado, registrando em `ja-desabilitados.txt` (`RemoverUserDesabilitado`, linhas 600-620) |
| **Login `ps.`** | AD | Remove logins que começam com `ps.` (prestadores de serviço) via `RemoverComPS`, com `StartsWith("ps.", OrdinalIgnoreCase)` |

---

## Normalização de CPF

O CPF é tratado de duas formas distintas:

- **Para agrupamento e join**: usa-se `.SomenteDigitos()` (apenas os dígitos), de
  modo a harmonizar formatações diferentes entre as fontes (linhas 320, 322, 324,
  483, 497, 516, 532).
- **Para campos de saída**: o **CPF literal é preservado** — `DA12-CPF`, o assunto
  da requisição e o objeto `EnvioBDesk` recebem o CPF como veio da origem
  (`ServicoSincronizadorSAP.cs`, ex.: linha 218 grava `DA12-CPF`, linha 482 monta
  `(CPF: ...)` no assunto).

!!! note "SomenteDigitos só normaliza chaves"
    O `.SomenteDigitos()` aparece apenas em contextos de agrupamento, join e
    logging. Ele **nunca** sobrescreve o CPF literal enviado ao BDesk.

---

## Processamento condicional do Metadados

O Metadados só é sincronizado quando `Config["Metadados"]["DeveProcessar"] == true`
**e** a execução está em modo não-consulta. A flag `deveProcessarMetadados` é
inicializada como `false` e só recebe o valor da configuração fora do modo consulta
(`ExecutorSincronizadorSAP.cs:243-248`).

---

## Mapeamento de solicitante

O solicitante da requisição BDesk é derivado da **última OU** do
`distinguishedName` do usuário (após descartar as cláusulas `DC=`), usada como chave
no mapa `mapeamento-participantes.json`. Caso a OU não esteja mapeada, aplica-se o
fallback `Config["BDesk"]["Solicitante"]` (`MapearSolicitante`,
`ServicoSincronizadorSAP.cs:326-362`).

### Retry de solicitante alternativo

Quando o BDesk responde com erro de participante inexistente, o sistema tenta
solicitantes alternativos:

!!! tip "Critério exato do retry"
    O retry só itera sobre `AlternativaEnvioBDesk` quando a resposta tem
    **exatamente uma linha** **e** essa linha é exatamente
    `Participante 'ANTE' não encontrado...`. Qualquer outra resposta provoca
    `return` imediato (`TentativasAPI`, `ExecutorSincronizadorSAP.cs:1057-1120`).

---

## Limiares de quarentena (resumo)

Os valores abaixo pertencem ao fluxo de quarentena; a página
[Ciclo de Vida da Quarentena](ciclo-vida-quarentena.md) os detalha.

| Parâmetro | Padrão | Origem | Observação |
|-----------|--------|--------|------------|
| `DiasInatividade` | 90 | `config.json` | **Obrigatório, sem fallback no código** (`ExecutorSincronizadorSAP.cs:1221`) |
| `DiasParaExpiracao` | 30 | código | `?? 30` em `AcaoSincronizadorSAP.cs:135` |
| `MaximoAbertura` | — | `config.json` | Limita aberturas por execução via `.Take()` (linhas 979-1002) |

### Inatividade com fallback de data

Para medir inatividade, o método `SemLogarHaTempos`
(`ExecutorSincronizadorSAP.cs:1299-1321`) usa `lastLogonTimestamp`; quando esse
atributo é nulo ou inválido, faz **fallback para `whenCreated`** e compara o tempo de
existência contra o limite configurado.

---

## Parâmetros técnicos de LDAP

A busca de usuários no AD usa parâmetros diferentes em cada modo:

| Modo | Mecanismo | PageSize | Timeout |
|------|-----------|----------|---------|
| Passada principal | ADODB (`ObterUsuariosAD`) | 10000 | 30 s |
| Ações de quarentena | `DirectorySearcher` (subtree) | 1000 | — |

A busca das ações de quarentena (`BuscarUsuariosNaQuarentena`,
`AcaoSincronizadorSAP.cs:81-124`) varre a OU de quarentena em escopo `Subtree` com
filtro `(&(objectCategory=person)(objectClass=user))`.

---

## Comportamento das listas de exceção

O carregamento das listas de exceção difere entre os modos:

!!! warning "Ausência de lista: erro na passada principal, silêncio nas ações"
    - **Passada principal**: se um arquivo de lista de exceção estiver ausente,
      `LerListaExcecao` chama `ServicoMensagensErro` e a execução retorna cedo —
      ou seja, a ausência é tratada como **erro** (`ExecutorSincronizadorSAP.cs:138-147`).
    - **Ações de quarentena**: a versão própria de `LerListaExcecao`
      (`AcaoSincronizadorSAP.cs:365-391`) **retorna lista vazia silenciosamente**
      quando o arquivo não existe, permitindo que a ação prossiga mesmo sem listas.

---

## Resumo das regras de negócio

| Regra | Implementação |
|-------|---------------|
| Exclusão só com 100% dos registros do CPF desligados | `UsuariosExcluidos_ViaRegraNova` (`ExecutorSincronizadorSAP.cs:523-536`) |
| Regra antiga compilada, mas nunca invocada | `UsuariosExcluidos` (linhas 507-520); fluxo usa `Comparar_ViaRegraNova` (linha 256) |
| Apenas DA16 e DA19 comparados, case-insensitive | `NovoDicionario` + `Diferentes()` (`ServicoSincronizadorSAP.cs:721-734`) |
| Inserir não é filtrado por exceção AD | `Agregar`, `if (acao != "inserir")` (linha 939) |
| Deduplicação por login, nunca por CPF | `RemoverRecentementeSolicitados` (linha 539+), `DiasDeEsperaPorExclusoes` padrão 7 |
| CPF normalizado só em chaves; literal preservado na saída | `.SomenteDigitos()` vs. `DA12-CPF` |
| Retry de solicitante apenas com 1 linha 'ANTE não encontrado' | `TentativasAPI` (linhas 1057-1120) |
| Listas de exceção: erro na main pass, silenciosas nas ações | `LerListaExcecao` (executor) vs. `LerListaExcecao` (ação) |
