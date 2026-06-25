# Configuracao

Esta pagina documenta o modelo completo de configuracao da suite **Sincronizadores GAB**: arquivos INI (`conf.ini`), arquivos JSON (`config.json`, templates de acao e mapeamento de participantes) e as listas negras / whitelist em texto puro. Tambem cobre o marcador (*watermark*) gravado pelo SincronizadorFerias e as feature flags carregadas de `funcionalidades.txt`.

!!! info "Onde ficam os arquivos"
    Em producao, cada aplicacao e implantada em `F:\BusinessDesk\ASK\{NomeDoExe}\`. Os arquivos de configuracao ficam relativos ao executavel: credenciais e parametros gerais em `conf.ini`; parametros estruturados e templates sob `CONFIG/`; listas negras / whitelist em `../ConfigComum/` e em `CONFIG/`.

---

## Visao geral das tres camadas

| Camada | Arquivo(s) | Finalidade |
|--------|------------|------------|
| **INI** | `conf.ini` | Credenciais (criptografadas XOR), endpoints, IDs de atividade BDesk, limites de lote, flags por app |
| **JSON** | `config.json`, templates de acao, `mapeamento-participantes.json` | Parametros de quarentena/Azure, templates de requisicao BDesk com tokens, mapeamento OU -> solicitante |
| **Texto** | listas negras e whitelist (`.txt`) | Whitelist/blacklist de grupos AD, logins e CPFs (1 entrada por linha) |

---

## Camada INI — `conf.ini`

O `conf.ini` e organizado em **secoes por dominio** (`[ActiveDirectory]`, `[SAP]`, `[Metadados]`, `[BDesk]`, etc.). O parsing e feito por `DictionaryComMensagensMelhores`, que produz mensagens de erro mais claras quando uma chave esperada esta ausente.

### Validacao no startup

Cada aplicacao valida o `conf.ini` na inicializacao contra a lista `CamposObrigatoriosIni`. **Se faltar qualquer campo obrigatorio, o app aborta** antes de qualquer mutacao.

Campos obrigatorios por secao (confirmados em codigo):

| Secao | Campos obrigatorios |
|-------|---------------------|
| `[ActiveDirectory]` | `Servidor`, `Caminho`, `Login`, `Senha`, `CampoCPF` (mais `DiasDeEsperaPorExclusoes` para AD/SAP) |
| `[SAP]` | `URL`, `Login`, `Senha` |
| `[Metadados]` | `URL`, `Login`, `Senha`, `DeveProcessar` |
| `[BDesk]` | `URL`, `Token` (mais IDs de atividade, limites, origem e solicitante para o SAP) |

!!! warning "Falha tardia: `AtividadeExcluir`"
    Nem todos os campos sao validados no startup. `AtividadeExcluir` **nao** consta em `CamposObrigatoriosIni` (`ServicoSincronizadorSAP.cs:188-209`). Sua ausencia so causa erro em runtime, quando `MontarJSONExclusao` (`ServicoSincronizadorSAP.cs:442`) tenta ler `config["BDesk"]["AtividadeExcluir"]` — ou seja, somente quando ha requisicoes de exclusao a processar. Confirme que essa chave esteja presente mesmo que a validacao inicial passe.

### Credenciais criptografadas (XOR)

Os campos `Login`/`Senha` de `[SAP]`, `[Metadados]`, `[ActiveDirectory]` e `[BDesk]` sao armazenados **criptografados** e decriptados em runtime.

- Algoritmo: cifra XOR com chaves fixas em `Cryptography.cs:10-12` — `EncKey=161`, `EncC1=109`, `EncC2=191`.
- Geracao do valor cifrado:

```bat
SincronizadorSAP.exe -criptografar <valor>
```

O comando imprime o valor cifrado em stdout para ser colado no `conf.ini`.

!!! note "Seguranca da cifra XOR"
    As chaves XOR sao fixas e embutidas no codigo. A criptografia ofusca as credenciais no arquivo, mas nao deve ser tratada como protecao criptografica forte.

### Feature flags — `funcionalidades.txt`

As feature flags sao carregadas em `GerenciadorVersao.VersaoLendoDoArquivo()` (`src/Cross-Cutting/GerenciadorVersao.cs:14`) a partir de:

```text
Path.Combine(%BUSINESS_DESK%, "funcionalidades.txt")
```

O arquivo e lido linha a linha; cada linha e comparada (apos `Trim().ToLower()`) contra os nomes dos campos `bool` de `BooleanosVersao` (20+ flags). Uma flag fica `true` quando seu nome aparece como uma linha do arquivo; caso contrario permanece `false`. Se o arquivo nao existir, todas as flags ficam em seu valor padrao (`false`).

!!! tip "A confirmar"
    O setup da variavel de ambiente `%BUSINESS_DESK%` e o caminho real de `funcionalidades.txt` em producao ainda precisam ser confirmados contra os hosts. Veja a secao [A confirmar](#a-confirmar).

---

## Camada JSON — `config.json`

O `config.json` (sob `CONFIG/`) guarda parametros estruturados de quarentena, do Azure MFA e o caminho de templates compartilhados.

### `[ActiveDirectory][Quarentena]`

| Campo | Obrigatorio | Default | Descricao |
|-------|-------------|---------|-----------|
| `OuDestino` | Sim | — | OU raiz de quarentena (sob ela sao criadas as OUs mensais `5S-{MM-yyyy}`) |
| `DiasInatividade` | **Sim** | — (lido via `ToObject<int>()`) | Dias sem login para entrar em quarentena (exemplo: `90`) |
| `MaximoAbertura` | **Sim** | — (lido via `ToObject<int>()`) | Maximo de requisicoes de quarentena abertas por execucao (exemplo: `2`) |
| `DiasParaExpiracao` | Nao | `30` | Dias em quarentena sem login posterior antes da exclusao definitiva (`AcaoSincronizadorSAP.cs:135`) |
| `ExtensionAttributeOuOriginal` | Nao | `msDS-cloudExtensionAttribute1` | Atributo AD onde a OU original e salva antes do move (`ExecutorSincronizadorAd.cs:37`) |

!!! warning "Campos sem default abortam por excecao"
    `OuDestino`, `DiasInatividade` e `MaximoAbertura` **nao** possuem default no codigo. `DiasInatividade` e `MaximoAbertura` sao lidos via `ToObject<int>()` — se ausentes, lançam excecao em runtime. Trate-os como obrigatorios.

### `[ActiveDirectory][CaminhoConfigSincronizadorAd]`

Caminho **relativo ao diretorio `CONFIG/` do SincronizadorAD**. O SincronizadorSAP usa esse caminho para ler os templates de quarentena que pertencem ao SincronizadorAD.

!!! danger "Dependencia critica das acoes de quarentena"
    As acoes `monitorar_quarentena` e `expirar_quarentena` do SAP dependem de `CaminhoConfigSincronizadorAd` apontar corretamente para o `CONFIG/` do SincronizadorAD. Se o caminho estiver incorreto, as acoes de quarentena nao localizam os templates de busca/abertura e o ciclo de quarentena quebra.

### `[AzureAD][TempoEsperaEmHoras]`

Define quanto tempo a acao `azure` (MFA) aguarda a sincronizacao do usuario no Azure AD antes de marcar a requisicao como insucesso. Quando a excecao `user could not be found` ocorre, compara-se o tempo decorrido desde a abertura da requisicao com esse valor (`ExecutorAzure.cs:146-167`). Exemplo: `400` horas.

### Exemplo (`EXEMPLOS/RODAVEIS/config.json`)

```json
{
  "ActiveDirectory": {
    "Quarentena": {
      "OuDestino": "OU=Quarentena,...",
      "DiasInatividade": 90,
      "MaximoAbertura": 2,
      "ExtensionAttributeOuOriginal": "msDS-cloudExtensionAttribute1"
    }
  }
}
```

---

## Templates JSON de acao (`CONFIG/{acao}/`)

Cada acao BDesk tem templates JSON sob `CONFIG/{acao}/`. Antes do envio ao BDesk, **tokens** dentro do template sao substituidos por valores reais.

### Tokens suportados

| Token | Substituido por |
|-------|-----------------|
| `%VERSAO%` | Versao do binario (`Versao.Release`) |
| `%LOGIN%` | Login (sAMAccountName) do usuario |
| `%DISPLAY-NAME%` | Display name do usuario |
| `%DETALHES%` | Detalhes da operacao |
| `%DATA%` | Data |
| `%PARTICIPANTE_POR_OU%` | Login do solicitante resolvido pela OU |
| `%LISTA%` | Lista (multiplos itens) |

Os tokens sao validados contra os campos do BDesk em `ExecutorSincronizador.cs:483`.

### Exemplos disponiveis no repositorio

- **SAP** (`SincronizadorSAP/EXEMPLOS/RODAVEIS/*.json`): `abrir-quarentena.json`, `retornar-quarentena.json`, `excluir-definitivo.json`.
- **AD** (`SincronizadorAd/EXEMPLOS/CONFIG/`): **43 arquivos** cobrindo as 10 acoes — `inserir/`, `atualizar/`, `manutencao/`, `quarentena/`, `retornar_quarentena/`, `azure/`, `marcar_pendente/`, `marcar_pendente_cpf/`, `excluir/`, `excluir_cpf/`.

---

## `mapeamento-participantes.json`

Array de objetos `{ Login, OUs: [] }` que mapeia **OU -> login BDesk** do solicitante. O solicitante (participante "ANTE") e derivado da ultima OU do DN do usuario (split do DN por virgula, ignorando partes `DC=`, tomando o valor da ultima parte). Esse valor e usado como chave de lookup; se nao houver mapeamento, usa-se o fallback `Config["BDesk"]["Solicitante"]` (`ServicoSincronizadorSAP.cs:326-362`; carregamento em `ExecutorSincronizadorSAP.cs:1122-1153`).

!!! note "Retry por solicitante alternativo"
    Quando o BDesk responde exatamente com `Participante 'ANTE' nao encontrado para o Login 'X'.`, o envio e retentado com um `LoginSolicitante` alternativo (`TentativasAPI` em `ExecutorSincronizadorSAP.cs:1057-1118`). A requisicao nao e descartada — apenas reprocessada com outro participante.

---

## Listas negras e whitelist (texto)

Sao arquivos de texto puro, **1 entrada por linha**. Linhas vazias e comentarios iniciados por `#` ou `;` sao ignorados. Grupos AD sao normalizados para `CN=...,DC=...` em **minusculo**. Ficam em `../ConfigComum/` e em `CONFIG/`.

| Lista | Arquivos | Usado em | Evidencia |
|-------|----------|----------|-----------|
| **AD Sync** | `lista-negra-ad-grupos.txt`, `lista-negra-ad-logins.txt` | inserir / atualizar / excluir | `ExecutorAtualizacao.cs:23-24` |
| **Quarentena** | `lista-negra-quarentena-grupos.txt`, `lista-negra-quarentena-logins.txt` | quarentena / monitor / expira / retorna | `ExecutorQuarentena.cs:23-24` |
| **Ferias** | `lista-negra-ferias-grupos.txt`, `lista-negra-ferias-logins.txt` | SincronizadorFerias | `ExecutorSincronizadorFerias.cs:85-86` |
| **Whitelist CPFs** | `usuarios-permitidos.txt` | SAP (se `ExecutarSomenteUsuariosDaListaDeUsuariosPermitidos=true`) | `ExecutorSincronizadorSAP.cs:159-161` |
| **Blacklist CPFs** | `usuarios-proibidos.txt` | SAP | `ExecutorSincronizadorSAP.cs:169-171` |

!!! note "Comportamento de listas de quarentena ausentes difere por contexto"
    No **main pass** do SAP, a ausencia de uma lista de quarentena gera erro (`ExecutorSincronizadorSAP.LerListaExcecao`, linhas 1172-1203). Nas **acoes** de quarentena (`monitorar_quarentena` / `expirar_quarentena`), a ausencia e tratada silenciosamente, retornando lista vazia (`AcaoSincronizadorSAP.LerListaExcecao`, linhas 371-391) — intencional, para que as acoes rodem mesmo sem listas.

!!! note "AD Sync: blacklist nao impede insercao"
    As listas `lista-negra-ad-*` pulam **atualizacao e exclusao**, mas permitem **insercao**. O filtro so e aplicado quando `acao != "inserir"` (`ExecutorSincronizadorSAP.cs:939-955`).

---

## Watermark do SincronizadorFerias

Durante as ferias, o SincronizadorFerias grava um bloco marcador no atributo `streetAddress` (limite de **1020 caracteres**, truncado com `.Truncar(1020)`), no formato:

```text
{Ferias: DD/MM/YYYY - DD/MM/YYYY
SincronizadorFerias {version}:CheckedOut:NAO REMOVER ESTE BLOCO!}
{conteudo original do streetAddress}
```

O bloco marca que a automacao e "proprietaria" da alteracao. No retorno de ferias, o bloco e removido fazendo split pelo sentinela `:CheckedOut:NAO REMOVER ESTE BLOCO!}\n`, preservando o conteudo original (`ExecutorSincronizadorFerias.cs:262-293`).

!!! danger "Nao remover o bloco manualmente"
    Remover o bloco de marcacao a mao deixa a conta em estado bloqueado: o SincronizadorFerias deixa de reconhecer que o periodo de ferias foi aberto pela automacao e o fluxo de retorno (que zera `accountExpires` e remove o watermark) deixa de atuar corretamente. A remocao deve ser sempre feita pelo proprio sincronizador, no retorno de ferias.

---

## Exemplos disponiveis no repositorio

| Aplicacao | Caminho | Conteudo |
|-----------|---------|----------|
| SincronizadorSAP | `SincronizadorSAP/EXEMPLOS/SECRETOS/conf.ini` | `conf.ini` com credenciais placeholder |
| SincronizadorSAP | `SincronizadorSAP/EXEMPLOS/RODAVEIS/*.json` | templates, `config.json`, `mapeamento-participantes.json` |
| SincronizadorAD | `SincronizadorAd/EXEMPLOS/CONFIG/` | **43 arquivos**, todas as 10 acoes |
| SincronizadorFerias | `SincronizadorFerias/EXEMPLOS/RODAVEIS/` | 6 templates + config |
| SincronizadorGrupos | `SincronizadorGrupos/instrucoes-configuracao/EXEMPLOS/` | exemplos de `conf.ini` / config por OU |

### Trechos do exemplo `EXEMPLOS/SECRETOS/conf.ini`

```ini
[SAP]
URL=http://sapaguiabranca
; Login/Senha criptografadas (XOR)

[ActiveDirectory]
Servidor=127.1.1.1
CampoCPF=l            ; exemplo

[BDesk]
URL=https://askrest
Formulario=68
AtividadeInserir=12144
AtividadeAtualizar=12871
AtividadeExcluir=12861
Criticidade=2571      ; Normal (ativo)

; limites de lote = 0 (sem limite)
DiasDeEsperaPorExclusoes=14   ; sobrescreve default 7
```

---

## Discrepancias

!!! warning "IDs de Atividades BDesk divergentes entre documentos"
    Tres fontes apresentam valores diferentes para os IDs de criticidade/atividade:

    | Fonte | Emergencial | Alta | Normal | Observacao |
    |-------|-------------|------|--------|------------|
    | `configuracao-servidores.md` §10 | 2573 | 2572 | 2571 | placeholders de exemplo |
    | `instrucoes.txt:88-91` | 2350 | 2351 | 2349 | valores **historicos**, desatualizados |
    | `EXEMPLOS/SECRETOS/conf.ini` | (2573 comentado) | (2572 comentado) | **2571 ativo** | exemplo |

    Todos esses sao **valores de exemplo**. Os IDs reais de producao devem ser confirmados diretamente no `conf.ini` implantado nos servidores antes de qualquer ajuste.

---

## A confirmar

Itens que dependem de validacao contra os hosts de producao:

- **Variavel de ambiente `%BUSINESS_DESK%`**: como e onde e configurada nos servidores.
- **Caminho real de `funcionalidades.txt`**: derivado de `Path.Combine(%BUSINESS_DESK%, "funcionalidades.txt")` em `GerenciadorVersao.cs:14`, mas o local fisico nos hosts ainda nao foi validado.
