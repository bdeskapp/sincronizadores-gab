# Regras do Sincronizador AD

O **SincronizadorAD** é uma aplicação console em C# (.NET 8.0) que processa
requisições abertas no BDesk e executa as mutações correspondentes no
**Active Directory**. Cada execução é roteada por um parâmetro `-acao`, que
determina qual operação será aplicada às contas: criação, atualização,
manutenção, quarentena, retorno de quarentena, exclusão (por login ou CPF),
marcação como pendente de exclusão e provisionamento de MFA no Azure.

Ao final de cada ação, o resultado (sucesso, insucesso ou aguardando) é
postado de volta na requisição via API REST do BDesk.

!!! info "Onde está o código"
    Os executores ficam em `src/SincronizadorAd/Executores/`. O roteamento
    por `-acao` e o fluxo comum (busca do usuário, verificação de listas de
    exceção e aplicação das alterações) estão em
    `src/SincronizadorAd/ExecutorSincronizadorAd.cs`.

## As 10 ações

Todas as ações são implementadas por executores que herdam de
`ExecutorAuxiliarBase` (`src/SincronizadorAd/Executores/ExecutorAuxiliarBase.cs`).

| `-acao` | Executor | Arquivo | O que faz |
|---|---|---|---|
| `inserir` | `ExecutorInsercao` | `ExecutorInsercao.cs` | Cria a conta, gera o login em até 8 tentativas, define senha temporária e dispara 8 desdobramentos automáticos. |
| `atualizar` | `ExecutorAtualizacao` | `ExecutorAtualizacao.cs` | Atualiza Cargo, Departamento e Centro de Custo usando o CPF como chave. |
| `manutencao` | `ExecutorManutencao` | `ExecutorManutencao.cs` | Gera senha aleatória, reativa a conta desabilitada e posta a ação na requisição de exclusão correspondente. |
| `quarentena` | `ExecutorQuarentena` | `ExecutorQuarentena.cs` | Move o usuário para a OU mensal de quarentena e desabilita a conta. |
| `retornar_quarentena` | `ExecutorRetornarQuarentena` | `ExecutorRetornarQuarentena.cs` | Move o usuário de volta para a OU original (sem reativar a conta). |
| `excluir` | `ExecutorExclusaoPorLogin` | `ExecutorExclusaoPorLogin.cs` | Exclui a conta por login, com verificação de recontratação. |
| `excluir_cpf` | `ExecutorExclusaoPorCPF` | `ExecutorExclusaoPorCPF.cs` | Exclui a conta por CPF, sem verificação de recontratação. |
| `marcar_pendente` | `ExecutorMarcarPendenteExclusaoPorLogin` | `ExecutorMarcarPendenteExclusao.cs` | Desabilita a conta localizada por login. |
| `marcar_pendente_cpf` | `ExecutorMarcarPendenteExclusaoPorCPF` | `ExecutorMarcarPendenteExclusao.cs` | Desabilita a conta localizada por CPF. |
| `azure` | `ExecutorAzure` | `ExecutorAzure.cs` | Provisiona MFA/dados via Microsoft Graph, sem busca no AD. |

!!! note "Quarentena e retorno de quarentena"
    As ações `quarentena` e `retornar_quarentena` fazem parte de um fluxo
    cross-project (SAP + AD). As regras detalhadas desse ciclo — OU mensal,
    metadados gravados, retorno e expiração — estão na página
    [Ciclo de Vida da Quarentena](ciclo-vida-quarentena.md). Aqui descrevemos
    apenas o que o SincronizadorAD executa por requisição.

---

## Inserção (`ExecutorInsercao`)

A inserção é a ação mais complexa: cria a conta no AD, calcula o login,
define a senha temporária, aplica regras específicas de prestador de serviço
e dispara desdobramentos automáticos para os demais sistemas.

### Geração de login em 8 tentativas

A partir do nome do usuário, o código extrai `primeiro`, `segundo`, `terceiro`
e `ultimo` (último nome) e constrói uma lista ordenada de até 8 candidatos a
login (`ExecutorInsercao.cs`, linhas 132-188). Cada candidato é testado em
sequência; o primeiro que **não** cair em palavra pejorativa e **não** já
existir no AD é adotado.

| # | Composição do login | Exemplo (João Carlos Silva Souza) |
|---|---|---|
| 1 | `primeiro` | `joao` |
| 2 | `primeiro` + inicial do `segundo` | `joaoc` |
| 3 | `primeiro` + iniciais do `segundo` e `terceiro` | `joaocs` |
| 4 | `primeiro` + inicial do `terceiro` | `joaos` |
| 5 | `primeiro` + inicial do `segundo` + `ultimo` (sobrenome) | `joaocsouza` |
| 6 | `primeiro` + `segundo` | `joaocarlos` |
| 7 | `primeiro` + `terceiro` | `joaosilva` |
| 8 | `primeiro` + `segundo` + `terceiro` | `joaocarlossilva` |

!!! note "Tentativas condicionais"
    As tentativas que dependem do segundo ou terceiro nome só são geradas se
    esses nomes existirem. Para um usuário com apenas dois nomes, por exemplo,
    a lista é mais curta. A primeira tentativa (`primeiro`) está sempre
    presente.

### Prefixo `ps.` para prestador de serviço

Quando o campo `1.11 Prestador de Serviço?` da requisição é `True`, o prefixo
`ps.` é prependado a **todas** as 8 tentativas de login (linhas 122-188). Não
há remoção ou alteração condicional do prefixo após sua atribuição inicial.

```text
prefixo = (ps == "True") ? "ps." : ""
login   = prefixo + ...
```

### Filtro de palavras pejorativas

Antes de aceitar um candidato, o login é normalizado removendo o prefixo
`ps.` (`Split('.').Last()`) e comparado, de forma **case-insensitive**
(`StringComparison.OrdinalIgnoreCase`), contra a lista de palavras pejorativas
(linhas 196-203). Se houver correspondência, o candidato é descartado
(`continue`) e a próxima tentativa é avaliada.

A lista é carregada em `LerJSONsProprios()` a partir do arquivo
`mapeamento-palavras.txt` em `CONFIG/`.

### Senha temporária determinística

A senha inicial segue o padrão determinístico
`@{PrimeiraLetra}{ddMMyyyy}` (linhas 250-256):

- `PrimeiraLetra` = primeira letra do nome, em maiúscula;
- `ddMMyyyy` = data de execução.

!!! example "Exemplo"
    Usuário **João** processado em **25/06/2025** recebe a senha
    `@J25062025`. Como depende da data do sistema no momento da execução, a
    senha é previsível para a data corrente.

### Cap de 90 dias para prestador de serviço

Para prestadores de serviço (`ps == "True"`), o campo `accountExpires`
(FILETIME) é limitado a **90 dias** a partir da data de abertura da requisição
(linhas 390-423). Se a data de expiração solicitada exceder esse máximo,
prevalece o cap:

```csharp
dataExpiracaoMaxima = dataAbertura.Value.AddDays(90);
if (dataExpiracaoSolicitada.Value > dataExpiracaoMaxima)
    dataExpiracao = dataExpiracaoMaxima;
```

### Desdobramentos automáticos

A inserção dispara **8 sub-requisições de desdobramento**, uma por sistema,
carregadas de templates `desdobrar-inclusao-*.json` (linhas 38-45) e
executadas em sequência ao final de `AlterarAD()` (linhas 545-1024):

| Desdobramento | Template |
|---|---|
| SAP | `desdobrar-inclusao-sap.json` |
| Sistemas | `desdobrar-inclusao-sistemas.json` |
| Rede | `desdobrar-inclusao-rede.json` |
| Internet | `desdobrar-inclusao-internet.json` |
| Email | `desdobrar-inclusao-email.json` |
| VPN | `desdobrar-inclusao-vpn.json` |
| Telefonia | `desdobrar-inclusao-telefonia.json` |
| Azure | `desdobrar-inclusao-azure.json` |

!!! tip "Internet e VPN são processadas internamente"
    Além de abrir a sub-requisição, **Internet** e **VPN** são tratadas dentro
    do próprio SincronizadorAD: o usuário é adicionado ao `GrupoInternet`
    (linhas 735-795) e ao `GrupoVPN` (linhas 835-934) via
    `DirectoryEntry.Children.Find(...)` seguido de `groupEntry.Invoke("Add", ...)`.
    A VPN é concedida **somente se o usuário não for prestador de serviço**.

---

## Atualização (`ExecutorAtualizacao`)

A atualização localiza a conta usando o **CPF como chave** (campo
`1.2 - CPF` na seção `Dados do Cliente`) e modifica exatamente três campos no
AD (`ExecutorAtualizacao.cs`, linhas 63-65, 84-86):

| Campo da requisição | Atributo AD |
|---|---|
| Cargo | `title` |
| Departamento | `department` |
| Centro de Custo | `postalCode` |

---

## Manutenção (`ExecutorManutencao`)

A manutenção redefine o acesso de uma conta e reativa contas desabilitadas.

- **Senha aleatória**: gera uma senha de no mínimo **8 caracteres**,
  garantindo pelo menos 1 minúscula, 1 maiúscula, 1 número e 1 caractere
  especial. A implementação está em
  `ExecutorSincronizadorAd.GerarSenhaAleatoria` (linhas 422-480), usando
  `RandomNumberGenerator` (criptograficamente seguro) e embaralhamento
  Fisher-Yates.
- **Reativação**: se a conta estiver desabilitada, o bit
  `ADS_UF_ACCOUNTDISABLE` é **limpo** via operação bit a bit
  (`old_UAC & ~ADS_UF_ACCOUNTDISABLE`).
- **Cap de 90 dias**: a data de manutenção é limitada a 90 dias a partir da
  data de abertura da requisição.

!!! warning "A ação é postada na requisição de EXCLUSÃO"
    A manutenção busca a requisição de exclusão correspondente ao usuário em
    **4 consultas** (`marcar_pendente`, `marcar_pendente_cpf`, `excluir`,
    `excluir_cpf`) e posta o resultado na **requisição de exclusão**, não na de
    manutenção. O endpoint usa `reqExclusao.RequisicaoId`, não
    `req.RequisicaoId` (`ExecutorManutencao.cs`).

---

## Exclusão (`ExecutorExclusao` → por login / por CPF)

A exclusão envia a conta para a lixeira do AD, mas só após uma série de
verificações de segurança.

1. **Bloqueio por data**: se a data atual for anterior à `Data da exclusão
   efetiva`, a requisição é marcada como **Aguardando** e o processamento
   retorna (`PodeExcluir()`).
2. **Conta deve estar desabilitada**: se o bit `ADS_UF_ACCOUNTDISABLE` não
   estiver presente em `userAccountControl`, a ação falha
   (`itemHistorico.Insucesso = true`).
3. **Verificação de recontratação**: por CPF, o sistema consulta **Metadados
   (HTTP)** e **SAP (SOAP)**. Se o usuário foi recontratado, a conta é
   **reativada** (limpa `ADS_UF_ACCOUNTDISABLE`) e a ação retorna erro.
4. **Envio para lixeira**: a conta é removida via
   `userEntry.Parent.Children.Remove(userEntry)`, removendo recursivamente os
   filhos primeiro (`EnviarParaLixeira()`).
5. **Desdobramento**: abre uma sub-requisição com a lista de grupos
   `MemberOf` do usuário (que, por característica do AD, **não inclui o grupo
   primário**).

!!! note "Exceções na verificação de recontratação"
    - **`excluir_cpf`** (`ExecutorExclusaoPorCPF`) **desativa** a verificação de
      recontratação: o método `VerificarRecontratacao()` retorna `false`
      imediatamente via `if (this is ExecutorExclusaoPorCPF)`.
    - Se o usuário **já está em quarentena** (o DN contém `OuQuarentena`), a
      verificação de recontratação também é pulada e a exclusão prossegue.

---

## Marcar pendente de exclusão (`ExecutorMarcarPendenteExclusao`)

As ações `marcar_pendente` (por login) e `marcar_pendente_cpf` (por CPF)
**desabilitam** a conta, aplicando OR bit a bit com `ADS_UF_ACCOUNTDISABLE`:

```csharp
valorNovo = old_UAC | ActiveDirectory.ADS_UF_ACCOUNTDISABLE;
```

A alteração é persistida via `itemHistorico.SalvarEntry()`
(`ExecutorMarcarPendenteExclusao.cs`, linhas 44-101).

---

## Azure (`ExecutorAzure`)

A ação `azure` provisiona dados/MFA no **Microsoft Graph** e tem um fluxo
distinto das demais.

- **Sem busca no AD**: o executor não define
  `ConjuntoDadoAdicionalContendoChave`, de modo que `ObterUnicoUsuarioAD()`
  retorna sem efeito. A identidade vem diretamente dos campos da requisição —
  o `UserPrincipalName` é extraído da seção `DADOS DO USUÁRIO AZURE`.
- **Normalização de celular**: o número é limpo (remove tudo que não é
  dígito); se não contiver `55` **e** tiver **11 dígitos ou menos**, o prefixo
  `55` é prependado; por fim, adiciona-se `+`. O resultado típico é
  `+55DDNNNNNNNN`; para números com mais de 11 dígitos, mantém-se
  `+{numeroOriginal}`.
- **Aguardando vs. insucesso**: se o usuário **não for encontrado no Graph** e
  o tempo decorrido desde a abertura for **menor** que `TempoEsperaEmHoras`, a
  requisição é marcada como **Aguardando** (será reprocessada). Após esse
  limite, é marcada como **insucesso** (`ExecutorAzure.cs`, linhas 146-167).

---

## Listas de exceção

As listas de exceção bloqueiam ações em logins ou grupos sensíveis. A
verificação central está em `ExecutorSincronizadorAd.AlterarConta`, que chama
`ExecutorAuxiliarBase.VerificaListasExcecao` **antes** de aplicar a mutação;
se o login ou um grupo do usuário estiver em lista de exceção, a ação é
bloqueada com `itemHistorico.Insucesso = true`. Grupos e logins são
normalizados ao formato `CN=...,DC=...` em minúsculas.

!!! warning "Nem todas as ações verificam listas de exceção"
    | Ação | Verifica lista de exceção? | Lista usada |
    |---|---|---|
    | `atualizar` | Sim | Exceção AD (grupos + logins) |
    | `marcar_pendente` / `marcar_pendente_cpf` | Sim | Exceção AD (grupos + logins) |
    | `excluir` / `excluir_cpf` | Sim | Exceção AD (grupos + logins) |
    | `quarentena` / `retornar_quarentena` | Sim | Exceção de **quarentena** |
    | `inserir` | **Não** | — |
    | `azure` | **Não** | — |
    | `manutencao` | **Não** | — |

    Ou seja, `inserir`, `azure` e `manutencao` **não** consultam listas de
    exceção; as demais sim, distinguindo entre a lista de exceção do AD e a
    lista de exceção específica de quarentena.
