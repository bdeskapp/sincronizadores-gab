# Regras do Sincronizador Ferias

O **SincronizadorFerias** e uma aplicacao console **.NET 8.0** que automatiza a sincronizacao de periodos de ferias entre tres fontes de dados (SAP via SOAP, Metadados via HTTP e SQL) e o **Active Directory**. Durante o periodo de ferias, a conta do funcionario e desabilitada por meio do atributo `accountExpires` (formato FILETIME do AD), e um marcador (*watermark*) `:CheckedOut:` e gravado no campo `streetAddress` para rastrear que a alteracao pertence a automacao.

!!! info "Arquivos-chave"
    - `src/SincronizadorFerias/ExecutorSincronizadorFerias.cs` — orquestracao do pipeline, decisao de entrada/retorno, watermark, comparacao L1/L2, ordenacao e batch.
    - `src/SincronizadorFerias/ServicoSincronizadorFerias.cs` — montagem dos usuarios de origem/AD e consulta SQL de ferias (`ObterUsuariosMetadadosEmFeriasNoBancoDeDados`).
    - `src/SincronizadorFerias/Model/UsuarioOrigem.cs`, `UsuarioAD.cs`, `UsuarioJoin.cs` — modelos de dados.

---

## 1. Consolidacao de tres fontes (MERGE)

O metodo `CarregarDadosDosServicos()` (linhas 390-472) consolida tres origens de dados. A **chave de correlacao entre TODAS as fontes** e o CPF normalizado via `CPF.SomenteDigitos()`.

| Etapa | Fonte | O que ocorre |
|-------|-------|--------------|
| 1 | **SAP (SOAP)** | Carregado na linha 390; montado em `usuariosOrigem` (linha 450). |
| 2 | **Metadados (HTTP)** | Carregado na linha 400; montado em `usuariosOrigemMetadados` (linhas 457-461) e consolidado com o SAP. |
| 3 | **Metadados (SQL)** | Carregado na linha 410; **injeta** `InicioFerias`/`FinalFerias` nos usuarios Metadados HTTP. |

O *merge* SQL → HTTP (linhas 463-472) percorre cada usuario Metadados HTTP, extrai seu `CPF.SomenteDigitos()` (linha 466), busca no dicionario `usuariosMetadadosBanco` (linha 467) e injeta as datas de ferias (linhas 469-470).

O dicionario SQL e construido em `ServicoSincronizadorFerias.ObterUsuariosMetadadosEmFeriasNoBancoDeDados()` (linha 655), **chaveado por `CPF.SomenteDigitos()`**.

!!! note "Por que CPF e a unica chave"
    As tres fontes nao compartilham um identificador comum de login. A normalizacao por digitos do CPF (`SomenteDigitos()`) e o que permite alinhar SAP, Metadados e AD. Por isso, usuarios sem CPF sao removidos *antes* de qualquer processamento (ver secao 6).

---

## 2. Regra de decisao: entrada e retorno de ferias

A decisao e tomada em `Determinar()` (linhas 484-489) e materializada na gravacao do AD (linhas 246-253).

```text
se InicioFerias e FinalFerias existem:
    se FinalFerias > DateTime.Now.Date:
        DataDeExpiracaoDaConta = InicioFerias    // ENTRA em ferias
    senao:
        DataDeExpiracaoDaConta permanece null     // RETORNA de ferias
```

`DataDeExpiracaoDaConta` e uma propriedade do tipo `DateTime?` (anulavel). Ao gravar no AD, o valor e convertido conforme o caso:

| Situacao | Condicao | `DataDeExpiracaoDaConta` | `accountExpires` gravado |
|----------|----------|--------------------------|--------------------------|
| **Entrada em ferias** | `FinalFerias > hoje` | recebe `InicioFerias` | `DataDeExpiracaoDaConta.Value.ToFileTime()` (linha 252) |
| **Retorno de ferias** | `FinalFerias <= hoje` | `null` | `"0"` — *never expires* (linha 248) |

!!! tip "Conversao para FILETIME ocorre na gravacao"
    `DataDeExpiracaoDaConta` recebe um `DateTime` (`InicioFerias`). A conversao para FILETIME via `ToFileTime()` so acontece **no momento da gravacao** do campo `accountExpires` (linha 252), nao na atribuicao.

---

## 3. Watermark `:CheckedOut:` no campo streetAddress

Para sinalizar que a automacao e proprietaria da alteracao, um bloco e gravado no inicio de `streetAddress` (linhas 277-293). O formato exato e:

```text
{Férias: DD/MM/YYYY - DD/MM/YYYY
SincronizadorFerias {version}:CheckedOut:NÃO REMOVER ESTE BLOCO!}
{streetAddress original}
```

O token `{version}` vem de `Versao.Release` (linha 290). O sentinela completo usado como marcador e: `:CheckedOut:NÃO REMOVER ESTE BLOCO!}\n`.

### Remocao do watermark ao retornar

Quando o usuario retorna (`DataDeExpiracaoDaConta == null`) ou quando o valor de origem difere do valor no AD (linhas 257-259), o bloco e removido por `Split` pela string `:CheckedOut:NÃO REMOVER ESTE BLOCO!}\n` (linhas 262-274):

1. Se o sentinela completo for encontrado (`partes.Length > 1`), preserva-se `partes[1]` — o conteudo original (linha 266).
2. Senao, se `partes[0]` contiver o sentinela parcial `:CheckedOut:`, limpa-se o campo (`""`) — linhas 270-271.
3. Senao, mantem-se `partes[0]` (conteudo original intacto) — linha 273.

---

## 4. Truncamento e protecao do watermark

Apos montar o bloco completo (`{Férias...}\n{watermark}\n{conteudo original}`), o campo e truncado a **1020 caracteres** via `.Truncar(1020)` (linhas 277-293) — limite UTF-16 do `streetAddress` no AD.

!!! warning "O watermark nunca e cortado pelo truncamento"
    Como o bloco de watermark e montado **ANTES** do conteudo original, o truncamento a 1020 caracteres corta apenas o **final do conteudo original**, jamais o watermark. Documentacao anterior que sugeria risco de perda do watermark esta **incorreta** — o ordenamento garante a protecao do sentinela (ver secao Discrepancias).

---

## 5. Comparacao L1 / L2

A comparacao ocorre em `UsuariosAlterados()`, via *join* por `CPF.SomenteDigitos()` entre:

- **Origem** — `usuariosOrigem_Ativos_SemRepeticao`: somente ativos, sem repeticao de CPF, com `DeveProcessar == true`.
- **AD** — `usuariosAD_SemRepeticao`: sem repeticao de CPF, sem cargos-proibidos.

### L1 — novas entradas em ferias (linhas 603-623)

```text
L1 = AD.DataDeExpiracaoDaConta == null  E  Source.DataDeExpiracaoDaConta != null
```

L1 representa usuarios que o AD ainda nao expirou, mas que a origem indica que devem entrar em ferias. **L1 passa pelo filtro de listas negras** (grupos + logins): `UsuariosExcecaoAD` (login, linha 613) e `GruposExcecaoAD` (grupos, linhas 618-620).

### L2 — retornos e atualizacoes (linhas 629-638)

```text
L2 = ':CheckedOut:' presente na linha de indice 1 de streetAddress.Split('\n')   (via ItemNContemValor)
     E  AD.DataDeExpiracaoDaConta != null
     E  AD.DataDeExpiracaoDaConta != Source.DataDeExpiracaoDaConta
```

A verificacao do watermark usa `ItemNContemValor(u.UsuarioAD.LogAlteracao.Split('\n'), 1, ":CheckedOut:")` (linha 631). O indice `1` corresponde a segunda linha do bloco, onde fica o `:CheckedOut:`. `LogAlteracao` recebe o valor de `streetAddress` (em `ServicoSincronizadorFerias.cs:242`).

!!! warning "Listas negras NAO se aplicam a L2"
    L2 e adicionado diretamente ao resultado via `r.AddRange(l2)` (linha 638), **sem** qualquer filtro de excecao. Isso garante que um usuario ja marcado pela automacao tenha seu retorno/atualizacao processado mesmo que ele entre numa lista negra apos a entrada em ferias — caso contrario, o watermark ficaria preso indefinidamente.

---

## 6. Filtros de elegibilidade

Aplicados em sequencia, antes e durante a comparacao:

| Filtro | Onde | Regra |
|--------|------|-------|
| **RemoverSemCPF** | linhas 396 (SAP), 406 (Metadados), 433 (AD); metodo 653-665 | Remove registros com `CPF.Vazio()` de cada fonte **antes** de qualquer processamento. |
| **cargos-proibidos.txt** | carga linha 75; filtro 536-538 | *Case-insensitive* (titulos em minusculas). Bloqueia **L1 e L2**, pois e aplicado a `usuariosAD_SemRepeticao` antes do join. |
| **DeveProcessar** | SAP 683; Metadados 453; filtro 563-565 | SAP: coluna 2 de `empresas.txt == "true"`. Metadados: `Config["Metadados"]["DeveProcessar"] == "true"`. |
| **Deduplicacao por CPF** | `RemoverDuplicados` 690-696 (`.Key == 1`) | Remove CPFs com mais de uma ocorrencia, com escopo diferenciado (abaixo). |

### Escopo diferenciado da deduplicacao

!!! note "Deduplicacao por status"
    - **Na origem (SAP/Metadados):** a deduplicacao considera **apenas usuarios ativos** (`usuariosOrigem.Where(u => u.Ativo)`, linhas 502-505).
    - **No Active Directory:** a deduplicacao considera **todos os usuarios**, independentemente de status.

    Em ambos os casos, CPFs com contagem maior que 1 sao integralmente excluidos antes do join de comparacao.

O filtro de cargos-proibidos converte titulos para minusculas na carga (linha 52, `.ToLower()`) e na comparacao (`!CargosProibidos.Contains(u.Cargo.ToLower())`), garantindo o comportamento *case-insensitive*.

---

## 7. Ordenacao e limite de batch

Antes de processar, a lista de alteracoes e ordenada e limitada (linhas 174 e 182):

1. **Ordenacao** (linha 174): `OrderBy(u => u.UsuarioOrigem.DataDeExpiracaoDaConta)`. Como a propriedade e `DateTime?`, o `OrderBy` do .NET coloca **`null` primeiro** — ou seja, **retornos (null) antes de novas entradas (datas futuras)**.
2. **Limite** (linha 182): `Take(QuantidadeMaximaDeAtualizacoes)`.

!!! tip "Priorizacao de retornos sob volume alto"
    Como a ordenacao coloca os retornos (`null`) no inicio e o `Take` e aplicado **depois** da ordenacao, quando o volume excede `QuantidadeMaximaDeAtualizacoes` sao os **retornos** que entram primeiro no lote. Isso prioriza reabilitar quem ja voltou de ferias sobre desabilitar quem esta entrando. A mensagem de trace na linha 172 confirma: usuarios com o campo `null/never` sao os que devem retornar e sao processados primeiro.

---

## Discrepancias

Esta secao registra divergencias entre a documentacao anterior e o codigo (a versao do **codigo vence**).

!!! warning "Truncamento — watermark protegido (esclarecimento)"
    Documentacao anterior sugeria risco de o truncamento a 1020 caracteres cortar o watermark. **Isso esta incorreto.** Como o bloco de watermark e montado ANTES do conteudo original (linhas 277-293), o `.Truncar(1020)` corta apenas o final do conteudo original — o sentinela `:CheckedOut:NÃO REMOVER ESTE BLOCO!}` permanece sempre intacto.

!!! note "Confirmacao das regras L1/L2"
    - **L1** (linhas 603-623) = `AD.DataDeExpiracaoDaConta == null` **E** `Source.DataDeExpiracaoDaConta != null`; passa pelo filtro de listas negras (grupos + logins).
    - **L2** (linhas 629-638) = `:CheckedOut:` presente na linha de indice 1 de `streetAddress.Split('\n')` **E** `AD.DataDeExpiracaoDaConta != null` **E** `AD != Source`; **as listas negras NAO se aplicam** (adicionado via `r.AddRange(l2)` sem filtro).

!!! note "Correcoes pontuais confirmadas no codigo"
    - **FILETIME na gravacao:** `DataDeExpiracaoDaConta` recebe `InicioFerias` (um `DateTime`); a conversao via `ToFileTime()` ocorre somente ao gravar `accountExpires` (linha 252), nao na atribuicao.
    - **Formato do watermark:** o bloco correto e `SincronizadorFerias {version}:CheckedOut:NÃO REMOVER ESTE BLOCO!}\n{streetAddress original}`, com `{version}` proveniente de `Versao.Release`.
    - **Escopo da deduplicacao:** na origem aplica-se apenas a usuarios ativos; no AD aplica-se a todos, independentemente de status.
