# Regras do Sincronizador Ferias

O **SincronizadorFerias** e uma aplicacao console .NET 8.0 que sincroniza periodos de
ferias de funcionarios para o **Active Directory** (AD). Durante as ferias de um
colaborador, sua conta de AD e desabilitada por meio do atributo FILETIME
`accountExpires`; ao retornar, a conta volta a ficar liberada. Para nao sobrescrever
ajustes manuais feitos por administradores, a automacao "marca" as contas que ela
mesma manipula por meio de um **watermark** (`:CheckedOut:`) gravado no campo
`streetAddress`.

O sistema consolida **tres fontes** de dados com o AD:

| Fonte | Protocolo | Papel |
|-------|-----------|-------|
| SAP | SOAP / XML | Origem primaria de funcionarios |
| Metadados (HTTP) | HTTP / XML | Origem secundaria de funcionarios |
| Metadados (SQL) | SQL Server / OleDb | Origem das **datas de ferias** (`INICIOPROGFERIAS` / `TERMINOPROGFERIAS`) |

Arquivos-chave:

- `src/SincronizadorFerias/ExecutorSincronizadorFerias.cs` — orquestracao e regras de negocio
- `src/SincronizadorFerias/ServicoSincronizadorFerias.cs` — leitura e conversao de dados do AD/origens
- `src/SincronizadorFerias/Model/UsuarioAD.cs`, `UsuarioOrigem.cs`, `UsuarioJoin.cs` — modelos

---

## A logica central: `accountExpires`

O coracao do sincronizador e decidir o valor do atributo `accountExpires` de cada
conta com base nas datas de ferias da origem.

### Calculo da data de expiracao

Em `ExecutorSincronizadorFerias.cs` (linhas 484-490), para cada usuario de origem:

```csharp
var i = uOrigem.InicioFerias;
var f = uOrigem.FinalFerias;
if (i.HasValue && f.HasValue)
{
    if (f.Value > DateTime.Now.Date)
    {
        uOrigem.DataDeExpiracaoDaConta = i.Value;
    }
}
```

!!! note "Regra de decisao"
    - Quando **`FinalFerias > hoje`** (ainda ha ferias por vir ou em curso), a conta
      deve expirar na data de **inicio** das ferias: `DataDeExpiracaoDaConta = InicioFerias`.
    - Quando **`FinalFerias <= hoje`** ou **nao ha datas de ferias**,
      `DataDeExpiracaoDaConta` permanece **`null`**.

### Conversao para o atributo do AD

O valor calculado e entao convertido para `accountExpires`
(`ExecutorSincronizadorFerias.cs:246-253`):

```csharp
if (usuario.UsuarioOrigem.DataDeExpiracaoDaConta == null)
{
    camposAAlterar["accountExpires"] = "0";          // never expires -> libera acesso
}
else
{
    camposAAlterar["accountExpires"] =
        Convert.ToString(usuario.UsuarioOrigem.DataDeExpiracaoDaConta.Value.ToFileTime());
}
```

| Situacao | `DataDeExpiracaoDaConta` | `accountExpires` no AD | Efeito |
|----------|--------------------------|------------------------|--------|
| Em ferias (FinalFerias > hoje) | `InicioFerias` | FILETIME de `InicioFerias` | Conta expira na data de inicio das ferias |
| Sem ferias / ferias passadas | `null` | `"0"` (never expires) | Acesso liberado |

### Conversao inversa (leitura do AD)

Ao ler uma conta do AD, valores de "nunca expira" sao normalizados de volta para
`null`, o que dispara o **fluxo de retorno de ferias**
(`ServicoSincronizadorFerias.cs:244-255`):

```csharp
if (ae.HasValue)
{
    // https://learn.microsoft.com/en-us/windows/win32/adschema/a-accountexpires
    if (ae.Value != 9223372036854775807 && ae.Value != 0)
    {
        u.DataDeExpiracaoDaConta = DateTime.FromFileTime(ae.Value);
    }
}
```

!!! tip "Valores never-expires"
    Tanto `9223372036854775807` (`Int64.MaxValue`) quanto `0` representam "nunca
    expira" no AD. Ambos sao convertidos para `DataDeExpiracaoDaConta = null`,
    sinalizando que a conta esta liberada (retorno de ferias).

---

## Watermark em `streetAddress`

Para marcar que uma conta esta sob controle da automacao e evitar sobrescrever
valores definidos manualmente, o sincronizador grava um **bloco watermark** no
campo `streetAddress`.

### Estrutura do `streetAddress`

O conteudo e montado em tres partes, separadas por quebras de linha
(`ExecutorSincronizadorFerias.cs:277-293`):

```text
{Férias: dd/MM/yyyy - dd/MM/yyyy          <- paragrafo 0 (indice 0): bloco Ferias com datas
SincronizadorFerias {versao}:CheckedOut:NÃO REMOVER ESTE BLOCO!}   <- paragrafo 1 (indice 1): watermark
<conteudo original do streetAddress>      <- paragrafo 2+ (indice 2+): conteudo preexistente
```

O delimitador exato gravado e a string
`:CheckedOut:NÃO REMOVER ESTE BLOCO!}`, escrita sempre no **segundo paragrafo**
(indice `1` ao dividir por `\n`).

### Truncamento

Apos montar bloco de ferias + watermark + conteudo original, o resultado e
truncado em **1020 caracteres** via `.Truncar(1020)`
(`ExecutorSincronizadorFerias.cs:277-293`).

### Retorno de ferias: remocao do watermark

Quando o usuario retorna de ferias (`DataDeExpiracaoDaConta == null`), o bloco e
**retirado**, restaurando o conteudo original que estava apos o delimitador
(`ExecutorSincronizadorFerias.cs:262-266`):

```csharp
var partes = (propsUsu["streetAddress"].OfType<string>().FirstOrDefault() ?? "")
    .Split(new[] { ":CheckedOut:NÃO REMOVER ESTE BLOCO!}\n" }, StringSplitOptions.None);
if (partes.Length > 1)
{
    novo_streetAddress = partes[1];   // conteudo original apos o delimitador
}
```

!!! warning "Proposito do watermark"
    A presenca do watermark no indice `1` e o criterio que distingue contas
    controladas pela automacao das contas com valores definidos manualmente. Isso
    e usado diretamente no grupo de comparacao **L2** (ver abaixo) para garantir
    que apenas valores definidos pela propria automacao sejam atualizados.

---

## Os dois grupos de comparacao: L1 e L2

A comparacao final entre origem e AD produz dois grupos distintos, no metodo
`UsuariosAlterados()` (`ExecutorSincronizadorFerias.cs:603-642`).

### Grupo L1 — entradas/saidas de ferias (linhas 603-623)

Usuarios que **nao** tem `accountExpires` definido no AD mas que **deveriam ter**
segundo a origem (novas entradas de ferias):

```csharp
var l1 = mesmasPessoas
    .Where(
        u => (u.UsuarioAD.DataDeExpiracaoDaConta == null)
        && (u.UsuarioOrigem.DataDeExpiracaoDaConta != null)
    )
    .ToList();
```

O grupo L1 **aplica filtros de lista negra**: logins em `UsuariosExcecaoAD` e
grupos em `GruposExcecaoAD` sao removidos (`ExecutorSincronizadorFerias.cs:611-623`,
comparacao case-insensitive via `.ToLower()`).

### Grupo L2 — retornos/atualizacoes (linhas 629-642)

Usuarios **ja marcados com o watermark** `:CheckedOut:` (indice 1) e cujo
`accountExpires` **diverge** do valor da origem:

```csharp
var l2 = mesmasPessoas
    .Where(
        u => ItemNContemValor(u.UsuarioAD.LogAlteracao.Split('\n'), 1, ":CheckedOut:")
        && (u.UsuarioAD.DataDeExpiracaoDaConta != null)
        && (u.UsuarioAD.DataDeExpiracaoDaConta != u.UsuarioOrigem.DataDeExpiracaoDaConta)
    )
    .ToList();
```

!!! note "L2 nao aplica listas negras"
    O grupo L2 **NAO** aplica filtros de lista negra — o retorno/atualizacao
    **sempre procede**. A justificativa e que essas contas ja foram tocadas pela
    automacao (possuem watermark), entao sua restauracao deve sempre acontecer,
    independentemente de listas de excecao.

| Grupo | Criterio | Lista negra (logins/grupos) |
|-------|----------|-----------------------------|
| **L1** | AD sem `accountExpires`, origem com data | **Aplica** (`UsuariosExcecaoAD` / `GruposExcecaoAD`) |
| **L2** | Watermark presente + `accountExpires` divergente | **Nao aplica** — retorno sempre procede |

---

## Cargos proibidos (bloqueiam L1 e L2)

Antes do join que origina L1 e L2, os cargos proibidos sao filtrados sobre
`usuariosAD_SemRepeticao` (`ExecutorSincronizadorFerias.cs:535-538`):

```csharp
usuariosAD_SemRepeticao = usuariosAD_SemRepeticao
    .Where(u => !CargosProibidos.Contains(u.Cargo.ToLower()))
    .ToList();
```

!!! warning "Cargos proibidos bloqueiam tudo"
    Como o filtro e aplicado **antes do join**, ele bloqueia **tanto L1 quanto L2** —
    usuarios com cargo proibido nem entram na comparacao. A comparacao e
    case-insensitive (`.ToLower()`); a lista `CargosProibidos` e carregada tambem em
    minusculas.

---

## Deduplicacao por CPF

Usuarios cujo CPF (apenas digitos, via `.SomenteDigitos()`) aparece **mais de uma
vez** em qualquer das tres fontes ou no AD sao **removidos integralmente** do
processamento — nao recebem entrada nem retorno.

A correlacao entre as fontes e a deduplicacao usam sempre `CPF.SomenteDigitos()`,
permitindo harmonizar formatos diferentes de CPF
(`ExecutorSincronizadorFerias.cs:502-508`, `588`). A remocao ocorre em
`RemoverDuplicados`, que mantem somente grupos com `Key == 1`
(`ExecutorSincronizadorFerias.cs:532-533` e `690-696`).

```csharp
// RemoverDuplicados mantem apenas grupos sem duplicata (Key == 1)
.Where(a => a.Key == 1)
```

!!! note "Por seguranca, descarta integralmente"
    Um CPF duplicado pode indicar ambiguidade de identidade. O sistema prefere nao
    arriscar e remove **todas** as ocorrencias daquele CPF.

---

## Filtro de ativos e `DeveProcessar`

Somente usuarios **ativos** de empresas/configuracoes habilitadas entram na
comparacao final.

- **Ativo** (`ExecutorSincronizadorFerias.cs:503`):
  apenas `u.Ativo == true`.
  - SAP: `Ativo = uRaw["Situacao"] == "A"` (linha 155)
  - Metadados: `Ativo = uRaw["ativo"] == "1"` (linha 193)
- **DeveProcessar** (`ExecutorSincronizadorFerias.cs:563-565`): segunda filtragem
  garante que apenas usuarios de empresas/config com `DeveProcessar == true` entram
  na comparacao com o AD. Empresas com `DeveProcessar == false` sao completamente
  ignoradas.

---

## Remocao de usuarios sem CPF

Antes de qualquer comparacao ou filtragem, usuarios sem CPF (`CPF.Vazio()`) sao
removidos de **todas** as fontes via `RemoverSemCPF()`
(`ExecutorSincronizadorFerias.cs:396`, `406`, `433`):

| Fonte | Chave | Linha |
|-------|-------|-------|
| SAP | `u["CPF"]` | 396 |
| Metadados HTTP | `u["cpf"]` | 406 |
| Active Directory | `u.CPF` | 433 |

---

## Injecao de dados de ferias do Metadados SQL

As datas de ferias (`INICIOPROGFERIAS` / `TERMINOPROGFERIAS`) vem do **banco SQL**
do Metadados e sao injetadas nos usuarios do **Metadados HTTP**
(`ExecutorSincronizadorFerias.cs:464-472`):

```csharp
foreach (var uom in usuariosOrigemMetadados)
{
    var c = uom.CPF.SomenteDigitos();
    if (usuariosMetadadosBanco.ContainsKey(c))
    {
        uom.InicioFerias = usuariosMetadadosBanco[c].InicioFerias;
        uom.FinalFerias  = usuariosMetadadosBanco[c].FinalFerias;
    }
}
```

!!! warning "Correcao de imprecisao: o SQL NAO sobrescreve sempre o HTTP"
    A injecao acontece **apenas para CPFs presentes no banco SQL**. Usuarios que
    existem no Metadados HTTP mas **estao ausentes** do banco SQL **mantem seus
    campos de ferias como `null`** — nao ha sobrescrita incondicional do HTTP pelo
    SQL.

A busca em `usuariosMetadadosBanco` e um **lookup em dicionario em memoria**
indexado por `CPF.SomenteDigitos()` — nao ha execucao de SQL nesse ponto do
codigo.

---

## Ordenacao e teto de processamento

Apos a comparacao, os usuarios sao ordenados e limitados antes de serem aplicados
ao AD (`ExecutorSincronizadorFerias.cs:169-182`):

```csharp
usuariosAlterados = usuariosAlterados.OrderBy(u => u.UsuarioOrigem.DataDeExpiracaoDaConta);
...
var maximo = int.Parse(Config["BDesk"]["QuantidadeMaximaDeAtualizacoes"]);
var usuariosAModificar = usuariosAlterados.Take(maximo).ToList();
```

!!! note "Nulls primeiro: retornos antes das entradas"
    `DataDeExpiracaoDaConta` e `DateTime?`. No LINQ `OrderBy`, valores `null` vem
    **primeiro**. Como `null` representa **retorno de ferias** e valor preenchido
    representa **saida/entrada de ferias**, os **retornos sao processados antes** das
    entradas (linha 174). Em seguida, `.Take(maximo)` limita o lote ao teto
    `QuantidadeMaximaDeAtualizacoes` por execucao.

---

## Modo consulta (`-consultar`)

Em modo consulta, o sincronizador escreve os JSONs de requisicao para uma pasta
separada e **nunca submete** requisicoes ao BDesk
(`ExecutorSincronizadorFerias.cs:148-150`):

```csharp
if (Config["BDesk"].CampoSeExistir("Executar") != "true")
{
    pastaFila = "FILA-MODO-CONSULTA";
    ...
}
```

!!! tip "Comportamento em consulta"
    - A fila de requisicoes e gravada em **`FILA-MODO-CONSULTA/`** em vez de `FILA/`.
    - `ProcessarFilaRequisicoesPendentes` retorna imediatamente sem submeter quando
      `Config["BDesk"]["Executar"]` nao e `"true"`.
    - Nenhuma alteracao e persistida no AD (verificacoes de `ModoConsultar` nas
      linhas 212-214 e 315-319).

---

## Registro da descricao de alteracoes

Para cada usuario processado, e construida uma descricao com os valores **antigos** e
**novos** de `accountExpires` e `streetAddress`
(`ExecutorSincronizadorFerias.cs:234-310`):

- `valoresAntigos` captura o `accountExpires` bruto (`null` ou FILETIME `long`) e o
  `streetAddress` atual do AD (linhas 234-242).
- `camposAAlterar` guarda os novos valores calculados (linhas 244-300).
- O registro itera os campos gravando `"Valor atual"` (linha 308) e
  `"Alterado para"` (linha 310).

!!! note "Tratamento de quebras de linha"
    Como `streetAddress` contem multiplos paragrafos, as quebras de linha sao
    substituidas pelo marcador legivel `[quebra de linha]` via
    `.Replace("\n", "[quebra de linha]")` ao montar a descricao de alteracoes.
