# Regras do Sincronizador AD

O **SincronizadorAD** é uma aplicação console **.NET 8.0** (Windows-only, com dependências de `System.DirectoryServices` e COM interop ADODB) que aplica **mutações no Active Directory** a partir de requisições abertas no BDesk. Ele lê as requisições via API REST do BDesk, executa a operação correspondente no AD e devolve o resultado (sucesso, insucesso ou aguardando) para a requisição.

Toda a operação é roteada por linha de comando através do parâmetro **`-acao`**, que mapeia o nome da ação para uma classe executora concreta. A definição do roteamento está em `Program.cs` (método `Validar()`).

```bash
SincronizadorAD.exe -executar -acao inserir    # modo escrita (CommitChanges no AD + POST no BDesk)
SincronizadorAD.exe -consultar -acao inserir   # dry-run (sem mutações no AD nem na API)
```

!!! info "Dez ações, um tronco comum"
    As **10 ações** abaixo herdam todas de `ExecutorAuxiliarBase` (`src/SincronizadorAd/Executores/ExecutorAuxiliarBase.cs`), que concentra a infraestrutura compartilhada: carga de templates JSON, leitura de listas de exceção, busca no AD (`ObterUnicoUsuarioAD`) e seleção de solicitante por OU.

## As 10 ações roteadas por `-acao`

| `-acao` | Classe executora | O que faz |
|---|---|---|
| `inserir` | `ExecutorInsercao` | Cria usuário no AD, gera login, define senha temporária e dispara desdobramentos |
| `atualizar` | `ExecutorAtualizacao` | Atualiza cargo/departamento/centro de custo por CPF |
| `manutencao` | `ExecutorManutencao` | Redefine senha, reativa conta, aplica cap de 90 dias |
| `quarentena` | `ExecutorQuarentena` | Move usuário para OU mensal de quarentena e desabilita a conta |
| `retornar_quarentena` | `ExecutorRetornarQuarentena` | Retorna o usuário à OU original a partir do extensionAttribute |
| `azure` | `ExecutorAzure` | Registra telefone de MFA via Microsoft Graph |
| `marcar_pendente` | `ExecutorMarcarPendenteExclusaoPorLogin` | Desabilita conta por login |
| `marcar_pendente_cpf` | `ExecutorMarcarPendenteExclusaoPorCPF` | Desabilita conta por CPF |
| `excluir` | `ExecutorExclusaoPorLogin` | Exclui conta por login (com verificação de recontratação) |
| `excluir_cpf` | `ExecutorExclusaoPorCPF` | Exclui conta por CPF (sem verificação de recontratação) |

O fluxo de cada requisição, orquestrado por `ExecutorSincronizadorAD`, segue o padrão: buscar detalhes → `ObterUnicoUsuarioAD()` → `VerificaListasExcecao()` → `AlterarAD()` → postar a ação no BDesk.

---

## Inserção — `ExecutorInsercao`

A ação de inserção (`src/SincronizadorAd/Executores/ExecutorInsercao.cs`) é a mais complexa: cria o usuário no AD, gera o login, define a senha temporária e, ao final, dispara as sub-requisições de provisionamento de acesso.

### (a) Rejeição por CPF duplicado — antes de gerar o login

Antes de qualquer tentativa de geração de login, a inserção verifica se já existe alguma conta no AD com o mesmo CPF.

!!! warning "Bloqueio por CPF duplicado"
    Nas **linhas 74-88**, o executor consulta o AD via `ObterUsuarioAD(itemHistorico, ExecutorPrincipal.CampoCPF, cpf, ...)`. Se qualquer usuário for encontrado (`usuarioscpf.Any()`), a inserção é **rejeitada**: `itemHistorico.Insucesso = true` e o método retorna imediatamente.

    A mensagem de insucesso **lista todos os `sAMAccountName`** que compartilham aquele CPF (linhas 82-85), facilitando o diagnóstico. Como essa verificação ocorre **antes** da geração do login, nenhuma conta nova é criada se o CPF já estiver cadastrado.

### (b) Prefixo `ps.` automático para Prestador de Serviço

Quando o campo **`1.11 Prestador de Serviço?`** da requisição é igual a `True`, todos os logins gerados recebem o prefixo `ps.`.

```csharp
// ExecutorInsercao.cs, linhas 122-130 (resumo)
var prefixo = ps == "True" ? "ps." : "";
```

O `prefixo` é concatenado em **todas as 8 tentativas** de geração de login (linhas 132-188), garantindo que qualquer login de prestador comece com `ps.`.

### (c) Algoritmo de geração de login — 8 tentativas exatas

O login é gerado por uma sequência de **8 padrões testados nesta ordem exata** (linhas 132-188). A primeira candidata que passar nas duas validações é adotada.

| # | Padrão | Composição |
|---|---|---|
| 1 | `primeiro` | primeiro nome completo |
| 2 | `primeiroI2` | primeiro nome + inicial do segundo nome |
| 3 | `primeiroI2I3` | primeiro nome + iniciais do segundo e terceiro nomes |
| 4 | `primeiroI3` | primeiro nome + inicial do terceiro nome |
| 5 | `primeiroI2sobrenome` | primeiro nome + inicial do segundo nome + sobrenome (último nome) |
| 6 | `primeirosegundo` | primeiro e segundo nomes completos |
| 7 | `primeiroterceiro` | primeiro e terceiro nomes completos |
| 8 | `primeirosegundoterceiro` | os três nomes completos |

Cada candidato é validado por **dois filtros** dentro do loop `foreach` (linhas 193-233):

1. **Filtro de palavras pejorativas** (linhas 196-203) — case-insensitive. Antes da comparação, o prefixo `ps.` é removido do candidato via `Split('.').Last()` (ex.: `ps.joao` → `joao`); a comparação usa `StringComparison.OrdinalIgnoreCase` contra a lista carregada de `mapeamento-palavras.txt`. Se houver match, o candidato é descartado com `continue`.
2. **Disponibilidade no AD** (linhas 208-219) — consulta `ExecutorPrincipal.Servico.ObterUsuarioAD()`; o candidato só é aceito (`break`, linha 228) quando `disponivel = !usuarios.Any()`.

!!! note "Origem da lista de palavras pejorativas"
    O arquivo `mapeamento-palavras.txt` é carregado em `CONFIG/` (linha 49), via `ExecutorPrincipal.LerArquivoTexto("mapeamento-palavras.txt")`.

### (d) Senha temporária determinística

A senha temporária de inserção segue um formato **determinístico**, gerado pela função local `GerarSenhaUsuario` (linhas 250-256):

```
@{PrimeiraLetraDoNome}{ddMMyyyy}
```

Por exemplo, um usuário cujo nome começa com "J", criado em 25/06/2025, recebe a senha **`@J25062025`**. A senha é aplicada ao AD via `userEntry.Invoke("SetPassword", new object[] { s })` (linha 462).

!!! tip "Não confundir com a senha de manutenção"
    Esta senha **determinística** `@{L}{ddMMyyyy}` é exclusiva da **inserção**. A ação `manutencao` usa uma senha **aleatória e criptograficamente segura** (descrita mais abaixo).

### (e) Cap de validade de 90 dias para prestador

Para contas de **prestador de serviço** (quando `ps == "True"`, linha 390), a validade da conta é limitada a no máximo **90 dias a contar da data de abertura da requisição**.

```csharp
// ExecutorInsercao.cs, linhas 393-418 (resumo)
var dataExpiracaoMaxima = dataAbertura.AddDays(90);
if (dataExpiracaoSolicitada > dataExpiracaoMaxima)
    dataExpiracao = dataExpiracaoMaxima;   // o cap de 90 dias prevalece
```

Se a data de expiração solicitada exceder o limite, o cap de 90 dias prevalece.

### (f) Desdobramentos disparados condicionalmente

Ao final da inserção, o executor pode disparar até **8 sub-requisições de desdobramento** via `POST /v1/requisicoes/desdobrar`, para provisionar os acessos: **rede, internet, email, sap, sistemas, vpn, telefonia e azure**.

!!! warning "Disparo condicional, não automático"
    Embora o sistema **suporte os 8 desdobramentos em sequência**, eles **não são todos disparados automaticamente**. Cada desdobramento só é acionado quando há **solicitação explícita** do acesso correspondente no formulário BDesk.

    Exemplo: o desdobramento de **SAP só é disparado** se o campo `Acesso Sistemas` > `2.1 - SAP` for igual a `True`. Os templates de cada desdobramento são carregados de `CONFIG/inserir/desdobrar-inclusao-*.json` (linhas 40-45).

---

## Manutenção — `ExecutorManutencao`

A ação `manutencao` (`src/SincronizadorAd/Executores/ExecutorManutencao.cs`) redefine senha, reativa contas desabilitadas e aplica um cap de validade — mas com uma particularidade importante quanto a **onde** a ação de resultado é postada.

### (a) Posta o resultado na requisição de EXCLUSÃO correspondente

A manutenção carrega **4 templates JSON de busca** (linhas 34-39) para localizar a requisição de exclusão correlata ao usuário:

- `marcar_pendente`
- `marcar_pendente_cpf`
- `excluir`
- `excluir_cpf`

O método `BuscarReqExclusao` (linhas 77-129) itera sobre as requisições de exclusão buscando a correspondência por login ou por CPF.

!!! warning "A ação é postada na requisição de exclusão, não na de manutenção"
    Na **linha 206**, o resultado (sucesso ou erro) é postado no endpoint da requisição de **exclusão** encontrada (`reqExclusao.RequisicaoId`), e **não** na requisição de manutenção (`req.RequisicaoId`).

### (b) Senha aleatória criptograficamente segura

Diferentemente da inserção, a manutenção gera uma **senha aleatória** via `ExecutorSincronizadorAD.GerarSenhaAleatoria(8)` (definida em `ExecutorSincronizadorAd.cs`, linhas 422-452; chamada em `ExecutorManutencao.cs:150`).

A senha garante:

- mínimo de **8 caracteres**;
- pelo menos **1 letra minúscula**, **1 maiúscula**, **1 número** e **1 caractere especial** (posicionados em `password[0..3]`);
- geração via `System.Security.Cryptography.RandomNumberGenerator.Create()` (criptograficamente seguro);
- **embaralhamento Fisher-Yates** com `RandomNumberGenerator` (`ShuffleArray`), para que os caracteres garantidos não fiquem sempre nas mesmas posições.

### (c) Cap de 90 dias na data final

A data final de manutenção também é limitada a no máximo **90 dias a partir da data de abertura da requisição de manutenção** (linhas 155-160):

```csharp
if (dataManutencao > req.DataAbertura.AddDays(90))
    dataManutencao = req.DataAbertura.AddDays(90);   // excesso é truncado
```

---

## Exclusão — `ExecutorExclusao`

A exclusão é uma família de executores abstratos com duas variantes concretas: `ExecutorExclusaoPorLogin` (`excluir`) e `ExecutorExclusaoPorCPF` (`excluir_cpf`). O código está em `src/SincronizadorAd/Executores/ExecutorExclusao.cs`.

### (a) Só executa se a conta estiver inativa

A exclusão só prossegue se a conta já estiver **desabilitada** no AD.

!!! danger "Guarda contra exclusão de conta ativa"
    Nas **linhas 114-133**, o executor lê `userAccountControl` e faz a operação bitwise `AND` com `ADS_UF_ACCOUNTDISABLE` (`= 0x0002`, conforme `ActiveDirectory.cs:9`). Se a conta **não** estiver inativa, registra o erro *"O usuário não se encontra inativo, não será excluído"*, marca `itemHistorico.Insucesso = true` e retorna. Apenas após esse check é que `EnviarParaLixeira` é chamado (linha 143).

### (b) `PodeExcluir()` — só após a data de exclusão efetiva

O método `PodeExcluir()` (linhas 195-204) extrai o campo **`Data da exclusão efetiva`** da requisição e compara com `DateTime.Now`. A exclusão só procede quando a data atual **atinge ou ultrapassa** essa data (`>=`).

Quando `PodeExcluir()` retorna `false` (linhas 107-111), a requisição é marcada como **Aguardando** e o processamento termina com `return` — a requisição é reprocessada em execuções futuras até a data limite ser atingida.

### (c) Verificação de recontratação por CPF

Para a exclusão **por login**, o executor verifica se o colaborador foi **recontratado**, consultando duas fontes por CPF, em ordem (método `VerificarRecontratacao`, linhas 290-320):

1. **Metadados** (HTTP) — 1ª fonte consultada (linha 308);
2. **SAP** (SOAP) — 2ª fonte consultada (linha 313).

!!! danger "Recontratação reativa a conta e bloqueia a exclusão"
    Se o usuário for identificado como recontratado, `ProcessarRecontratacao()` chama `AtualizarStatusConta()`, que **remove o flag `ADS_UF_ACCOUNTDISABLE`** (reativando a conta), marca `itemHistorico.Insucesso = true` e retorna — **bloqueando a exclusão** (a conta nunca chega a `EnviarParaLixeira()`).

!!! warning "Risco operacional: falha silenciosa"
    A verificação de recontratação via SAP/Metadados não possui tratamento de exceção visível. Se a consulta HTTP/SOAP falhar, o resultado é interpretado como "não recontratado", o que pode levar à **exclusão de uma conta de colaborador recontratado**. Este é um ponto de atenção operacional registrado.

### (d) Exclusão por CPF não tem guarda-corpo de recontratação

!!! danger "`ExecutorExclusaoPorCPF` ignora a verificação de recontratação"
    A verificação de recontratação é **desabilitada** para `ExecutorExclusaoPorCPF` em dois pontos:

    - **Linhas 44-48** (`LerJSONsProprios()`): `if (this is ExecutorExclusaoPorCPF) { ... return; }` — pula o carregamento de credenciais de SAP/Metadados.
    - **Linhas 300-304** (`VerificarRecontratacao()`): `if (this is ExecutorExclusaoPorCPF) { ...; return false; }` — retorna sem consultar Metadados/SAP.

    Portanto, a **exclusão por CPF não tem guarda-corpo de recontratação**. Apenas `ExecutorExclusaoPorLogin` passa pelas duas verificações.

### (e) Usuário já em quarentena — exclusão segue sem verificar recontratação

!!! note "Quarentena dispensa a verificação de recontratação"
    Em `VerificarRecontratacao()` (linhas 290-298), se `JaEstaEmQuarentena()` retornar `true`, o método retorna `false` imediatamente, **pulando os checks de Metadados e SAP**. Isso vale para **ambas** as variantes — inclusive a exclusão **por login**. Ou seja, usuários que já estão em quarentena seguem o fluxo normal de exclusão **sem** ter a recontratação verificada.

---

## Azure (MFA) — `ExecutorAzure`

A ação `azure` (`src/SincronizadorAd/Executores/ExecutorAzure.cs`) registra o telefone de MFA no Azure AD via Microsoft Graph. Diferentemente das demais ações, **não realiza busca no Active Directory**.

!!! info "Para detalhes completos, veja a página dedicada"
    Esta seção cobre o essencial. O ciclo completo de MFA/Azure é tratado na página dedicada, quando disponível.

Pontos principais:

- **Não busca no AD:** `ConjuntoDadoAdicionalContendoChave` permanece `null`, de modo que `ObterUnicoUsuarioAD()` (em `ExecutorAuxiliarBase`) retorna cedo sem executar nenhuma busca no AD. `ChaveUsuarioAD()` retorna `"userPrincipalName"`, mas esse valor nunca é usado para busca.
- **Identidade vem da requisição:** o `UserPrincipalName` e o número de celular são lidos diretamente dos campos da requisição BDesk (seção `DADOS DO USUÁRIO AZURE`).
- **Espera por sincronização:** se o usuário ainda não foi encontrado no Azure AD, o executor calcula o tempo decorrido desde a abertura da requisição. Enquanto for menor que **`TempoEsperaEmHoras`** (lido de `CONFIG/azure/config.json`), define `Aguardando = true`; ao atingir o limite, marca `Insucesso = true`.
- **Normalização de telefone** (`FormatarNumeroCelular`): remove não-dígitos, prefixa `55` quando o número não começa com `55` e tem até 11 dígitos, e adiciona `+` (resultando em formato `+55...`).

---

## Quarentena e Retorno de Quarentena

As ações `quarentena` e `retornar_quarentena` (`ExecutorQuarentena` e `ExecutorRetornarQuarentena`) fazem parte de um fluxo automatizado **cross-projeto** que envolve também o SincronizadorSAP.

!!! info "Referência cruzada"
    O detalhamento completo dessas ações — incluindo a OU mensal `5S-{MM-yyyy}`, o salvamento da OU original em `msDS-cloudExtensionAttribute1`, o timestamp no campo `info`, o intervalo mínimo de 12 horas para retorno e a regra de que o retorno **não reabilita** a conta — está na página **Ciclo de Vida da Quarentena**.

---

## Discrepâncias

Registro das divergências entre a documentação anterior e o código atual (o código é a verdade):

!!! warning "Divergências corrigidas a partir do código"
    - **8 tentativas de geração de login agora confirmadas no código.** O algoritmo era anteriormente *inferido*; foi verificado em `ExecutorInsercao.cs` (linhas 132-188 / loop em 193-233) que existem **exatamente 8 tentativas, na ordem**: `primeiro`, `primeiroI2`, `primeiroI2I3`, `primeiroI3`, `primeiroI2sobrenome`, `primeirosegundo`, `primeiroterceiro`, `primeirosegundoterceiro`.

    - **Localização de `mapeamento-palavras.txt` é `CONFIG/`, não `EXEMPLOS/`.** O arquivo é carregado em produção a partir de `CONFIG/` (`ExecutorInsercao.cs:49`); referências anteriores a `EXEMPLOS/` descreviam apenas templates de exemplo, não o caminho de runtime.

    - **8 desdobramentos confirmados em sequência, porém disparados condicionalmente.** A documentação anterior afirmava que a inserção *sempre* dispara os 8 desdobramentos (rede, internet, email, sap, sistemas, vpn, telefonia, azure). O código confirma que os 8 templates existem e são suportados em sequência, mas **cada desdobramento só é disparado quando o acesso correspondente é solicitado no formulário** (ex.: SAP somente se `Acesso Sistemas` > `2.1 - SAP` == `True`).
