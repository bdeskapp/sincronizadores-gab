# Configuração

Os Sincronizadores GAB usam um modelo de configuração em **três camadas** complementares, cada uma com um papel bem definido:

| Camada | Arquivo(s) | Papel |
| --- | --- | --- |
| **INI** | `conf.ini` | Infraestrutura e parâmetros operacionais (servidores, URLs, limites de lote, credenciais cifradas). |
| **JSON** | `config.json` + templates por ação | Configuração de comportamento (quarentena, Azure) e modelos de requisição/ação BDesk. |
| **Credenciais XOR** | valores embutidos no `conf.ini` | Logins, senhas e tokens cifrados com algoritmo XOR de chaves fixas. |

!!! info "Princípio geral"
    O `conf.ini` define **onde** o sistema atua (endpoints, credenciais, limites). Os `config.json` e os templates definem **como** ele atua (ações, OUs, tokens de substituição). As listas negras definem **quem** é incluído ou excluído.

---

## 1. Camada INI: `conf.ini`

Cada aplicação tem o seu próprio `conf.ini`, dividido em seções. A validação de campos obrigatórios é feita por um dicionário `CamposObrigatoriosIni` em cada executor; **se um campo obrigatório faltar, a inicialização lança exceção e a execução é abortada** antes de qualquer mutação no Active Directory.

### 1.1 SincronizadorSAP e SincronizadorAD

Ambas as aplicações compartilham a mesma estrutura de seções no `conf.ini`.

#### `[ActiveDirectory]`

| Chave | Descrição | Cifrada (XOR) |
| --- | --- | --- |
| `Servidor` | Host/IP do controlador de domínio (LDAP / ADODB). | Não |
| `Caminho` | DN base da árvore AD (ex.: `DC=herocorp,DC=com,DC=br`). | Não |
| `Login` | Conta de serviço com permissão R/W no AD. | **Sim** |
| `Senha` | Senha da conta de serviço. | **Sim** |
| `CampoCPF` | Atributo AD que armazena o CPF (chave de correlação). | Não |

#### `[SAP]`

| Chave | Descrição | Cifrada (XOR) |
| --- | --- | --- |
| `URL` | Endpoint SOAP do SAP HR. | Não |
| `Login` | Usuário SAP. | **Sim** |
| `Senha` | Senha SAP. | **Sim** |

#### `[Metadados]`

| Chave | Descrição | Cifrada (XOR) |
| --- | --- | --- |
| `URL` | Endpoint HTTP do serviço Metadados. | Não |
| `Login` | Usuário Metadados. | **Sim** |
| `Senha` | Senha Metadados. | **Sim** |
| `DeveProcessar` | `true`/`false`. Em modo não-consulta, controla se Metadados é sincronizado. | Não |

#### `[BDesk]`

| Chave | Descrição | Padrão / Observação |
| --- | --- | --- |
| `URL` | Endpoint REST da API BDesk. | — |
| `Token` | Bearer token OAuth (cifrado). | **XOR** |
| `Formulario` | Formulário BDesk usado nas requisições. | — |
| `AtividadeInserir` | ID de atividade para inserção. | — |
| `AtividadeAtualizar` | ID de atividade para atualização. | — |
| `AtividadeExcluir` | ID de atividade para exclusão. | — |
| `Criticidade` | Criticidade aplicada às requisições. | — |
| `QuantidadeMaximaDeInsercoes` | Teto de inserções por execução. | `0` = sem limite |
| `QuantidadeMaximaDeAtualizacoes` | Teto de atualizações por execução. | `0` = sem limite |
| `QuantidadeMaximaDeExclusoes` | Teto de exclusões por execução. | `0` = sem limite |
| `DiasDeEsperaPorExclusoes` | Janela de deduplicação de exclusões (por `sAMAccountName`, via `LocalData/yyyyMMdd.json`). | `7` (default no código; `EXEMPLOS/SECRETOS` sobrescreve para `14`) |
| `Solicitante` | Login solicitante de fallback quando o mapeamento por OU não resolve. | — |
| `Telefone` | Telefone usado nas requisições. | — |
| `Origem` | Origem das requisições. | — |
| `ExecutarSomenteUsuariosDaListaDeUsuariosPermitidos` | Ativa a whitelist `usuarios-permitidos.txt`. | `true` ativa whitelist |

!!! note "Deduplicação de exclusões"
    A deduplicação remove do lote qualquer **login (sAMAccountName)** já submetido em `LocalData/yyyyMMdd.json` dentro da janela de `DiasDeEsperaPorExclusoes`. **Não há deduplicação por CPF.**

### 1.2 SincronizadorFerias

O SincronizadorFerias herda as seções `[ActiveDirectory]`, `[SAP]` e `[BDesk]` (mesmas chaves descritas acima) e acrescenta uma fonte de dados SQL própria.

#### `[BancoDeDadosMetadados]` (SQL / OleDb)

| Chave | Descrição | Cifrada (XOR) |
| --- | --- | --- |
| `Servidor` | Host do SQL Server. | Não |
| `Banco` | Nome do banco de dados. | Não |
| `Login` | Usuário do banco. | **Sim** |
| `Senha` | Senha do banco. | **Sim** |
| `View` | View consultada para datas de programação de férias. | Não |

!!! tip "Por que SQL no SincronizadorFerias?"
    Os dados de férias do Metadados SQL (`INICIOPROGFERIAS` / `TERMINOPROGFERIAS`) são injetados nos usuários do Metadados HTTP **apenas** para CPFs que existem no banco. Usuários presentes no HTTP mas ausentes no SQL mantêm os campos de férias como `null`.

### 1.3 SincronizadorGrupos

#### `[Geral]`

| Chave | Descrição | Obrigatório |
| --- | --- | --- |
| `CaminhoDados` | Raiz da árvore de `config.txt` por OU (estrutura espelhada). | **Sim** |
| `CaminhoBackups` | Destino do backup integral por execução. | **Sim** |
| `MaximoAlteracoesPorExecucao` | Teto de usuários alterados por execução. | **Sim** (lido sem default visível) |

Além de `[Geral]`, o SincronizadorGrupos usa `[ActiveDirectory]` e `[BDesk]`.

!!! warning "Discrepância confirmada: latent bug em `[ActiveDirectory] Caminho`"
    No SincronizadorGrupos, a chave **`[ActiveDirectory] Caminho` é usada obrigatoriamente em tempo de execução** (em `ExecutorSincronizadorGrupos.cs`, linha 302), mas **NÃO está incluída** no `CamposObrigatoriosIni` validado na inicialização (linhas 25-30). Se `Caminho` estiver ausente, o sistema **lança `KeyNotFoundException` em tempo de execução** em vez de uma mensagem de validação clara. A chave `CaminhoGrupos` é verdadeiramente opcional (verificada via `ContainsKey` na linha 304).

!!! warning "Discrepância confirmada: `[BDesk]` e o modo FILA-MODO-CONSULTA"
    A seção `[BDesk]` (`URL` + `Token`) é obrigatória **apenas em modo `-executar`**. Em `-consultar` é validada condicionalmente. Quando `[BDesk]` existe mas `Executar != "true"`, ativa-se o **modo FILA-MODO-CONSULTA**: as requisições são escritas na fila local, mas **nenhuma requisição BDesk é aberta** (linhas 216-220). Esse mesmo comportamento de `Executar != "true"` rege o SincronizadorFerias, que grava em `FILA-MODO-CONSULTA/` e nunca submete requisições.

---

## 2. Camada de Criptografia XOR

Credenciais sensíveis (`Login`, `Senha`, `Token`) são armazenadas cifradas no `conf.ini`. O algoritmo está em `src/Cross-Cutting/Security/Cryptography.cs` e usa **chaves fixas** embutidas no código:

| Constante | Valor |
| --- | --- |
| `EncC1` | `109` |
| `EncC2` | `191` |
| `EncKey` | `161` |

A descriptografia (`Decrypt`) deriva a chave inicial de `(EncKey * EncC1 + EncC2) % 65536` e aplica XOR byte a byte sobre a representação numérica do valor. O método `Encrypt` faz o caminho inverso, produzindo uma string de dígitos.

### Gerar um valor cifrado

Cada executável aceita o parâmetro `-criptografar`, que imprime o valor cifrado no **stdout**:

```text
SincronizadorSAP.exe -criptografar <valor>
```

O resultado deve ser copiado para a chave correspondente no `conf.ini` (`Login`, `Senha` ou `Token`).

!!! warning "Limitação de segurança"
    As chaves de criptografia são **fixas e embutidas no binário**. O algoritmo XOR oferece apenas ofuscação — não substitui um cofre de segredos. O acesso aos arquivos `conf.ini` e aos binários deve ser controlado por permissões de sistema de arquivos.

---

## 3. Camada JSON: `config.json` (por ação)

O `config.json` configura o comportamento das ações que não cabem no INI, principalmente quarentena (SincronizadorAD/SAP) e Azure (SincronizadorAD).

### 3.1 Bloco `ActiveDirectory.Quarentena`

| Chave | Descrição | Valor |
| --- | --- | --- |
| `OuDestino` | OU base de quarentena (sob a qual são criadas as OUs mensais `5S-{MM-yyyy}`). | — |
| `ExtensionAttributeOuOriginal` | Atributo que guarda a OU original antes do `MoveTo`. | `msDS-cloudExtensionAttribute1` (**confirmado**) |
| `DiasParaExpiracao` | Dias em quarentena, sem login posterior, até abrir requisição de exclusão. | `30` (**default no código**) |
| `DiasInatividade` | Dias sem login para enviar usuário à quarentena (main pass). | `90` (exemplo; **obrigatório** no SAP, sem fallback) |
| `MaximoAbertura` | Máximo de aberturas de quarentena por execução. | `2` (exemplo; **obrigatório** no SAP) |

```json
{
  "ActiveDirectory": {
    "Quarentena": {
      "OuDestino": "OU=Quarentena,OU=Desligados,DC=herocorp,DC=com,DC=br",
      "ExtensionAttributeOuOriginal": "msDS-cloudExtensionAttribute1",
      "DiasParaExpiracao": 30,
      "DiasInatividade": 90,
      "MaximoAbertura": 2
    }
  }
}
```

!!! note "Onde a OU original é gravada"
    O `ExecutorQuarentena` extrai a OU original do `distinguishedName` (removendo o `CN=`) e a grava em `ExtensionAttributeOuOriginal` **antes** do `MoveTo` (pois o DN muda após a movimentação). O `ExecutorRetornarQuarentena` lê esse mesmo atributo para mover o usuário de volta, limpando o atributo e o campo `info` após o sucesso.

### 3.2 Bloco `AzureAD`

| Chave | Descrição | Valor |
| --- | --- | --- |
| `TempoEsperaEmHoras` | Janela máxima de espera para que o usuário apareça no Microsoft Graph antes de marcar insucesso. | exemplo `400` (a confirmar) |

Enquanto a requisição Azure estiver dentro de `TempoEsperaEmHoras` e o usuário não for encontrado no Graph, a requisição é marcada como **Aguardando**; após o limite, é marcada como **insucesso**.

### 3.3 `CaminhoConfigSincronizadorAd`

Chave que aponta para o diretório de configuração e templates do SincronizadorAD, usada pelas ações de quarentena do SincronizadorSAP para carregar os templates JSON de busca/ação (via `LerJSONConfigDoSincronizadorAd()`).

---

## 4. Templates por ação: `CONFIG/{acao}/*.json`

Cada ação tem um diretório `CONFIG/{acao}/` com dois tipos de template:

| Template | Função |
| --- | --- |
| `busca-atividade-{acao}.json` | Detecção de duplicatas — busca requisições já abertas (status `Aberta` / `Em Andamento`) antes de abrir uma nova. |
| `acao-sucesso-{acao}.json` | Fechamento da requisição e ações pós-sucesso. |

### 4.1 Tokens de substituição

Os templates JSON usam tokens que são substituídos em tempo de execução pelos dados reais da requisição/usuário:

| Token | Substituição |
| --- | --- |
| `%VERSAO%` | Versão do executável (de `Versao.cs`). |
| `%LOGIN%` / `%LOGIN_ALTERADO%` | `sAMAccountName` do usuário. |
| `%DISPLAY-NAME%` | Display name do usuário. |
| `%DETALHES%` / `%ALTERACOES%` | Texto acumulado de alterações. |
| `%DATA%` | Data corrente. |
| `%PARTICIPANTE_POR_OU%` | Login solicitante mapeado pela OU (`mapeamento-participantes.json`, OU→login); fallback para o robô (login sem o 1º caractere). |
| `%LISTA%` | Lista (ex.: grupos `MemberOf` na exclusão). |

!!! note "Mapeamento de participante por OU"
    O solicitante é derivado da **OU mais profunda** (último nível hierárquico, após filtrar cláusulas `DC=`) consultando `mapeamento-participantes.json`. Se a OU não estiver mapeada (caso típico das OUs de quarentena `5S-MM-yyyy`), usa-se o fallback configurado em `[BDesk] Solicitante` ou o login do robô sem o primeiro caractere.

---

## 5. Listas (negras e brancas): `ConfigComum/`

As listas controlam quem é processado por cada automação. São arquivos texto (um item por linha; linhas vazias e comentários `#`/`;` ignorados em alguns contextos).

| Arquivo | Escopo |
| --- | --- |
| `lista-negra-ad-grupos.txt` / `lista-negra-ad-logins.txt` | Exceções do SincronizadorAD (ações `atualizar`, `marcar_pendente*`, `excluir*`). |
| `lista-negra-quarentena-grupos.txt` / `lista-negra-quarentena-logins.txt` | Exceções das ações de quarentena (`quarentena`, `retornar_quarentena`, e as ações SAP `monitorar_quarentena` / `expirar_quarentena`). |
| `lista-negra-ferias-grupos.txt` / `lista-negra-ferias-logins.txt` | Exceções do SincronizadorFerias (aplicadas a L1). |
| `usuarios-permitidos.txt` | **Whitelist** por CPF (SAP). |
| `usuarios-proibidos.txt` | Blacklist por CPF (SAP). |

!!! tip "Whitelist condicional"
    A whitelist `usuarios-permitidos.txt` só fica **ativa** se `[BDesk] ExecutarSomenteUsuariosDaListaDeUsuariosPermitidos=true`.

!!! note "Tolerância a arquivo ausente difere por contexto"
    No **main pass** do SincronizadorSAP, uma lista de exceção ausente é tratada como **erro** (a execução retorna cedo). Já nas **ações de quarentena** SAP, a lista ausente gera apenas um **aviso** (`Trace.WriteLine`) e a operação continua com lista vazia — comportamento intencional para que a quarentena rode mesmo sem listas configuradas.

---

## 6. Diretórios de exemplos por projeto

Cada projeto traz exemplos de configuração que servem de gabarito para o deploy:

| Projeto | Diretório | Conteúdo |
| --- | --- | --- |
| **SincronizadorSAP** | `EXEMPLOS/RODAVEIS` | 9 arquivos de `CONFIG` (templates de quarentena, `config.json`, `mapeamento-participantes.json`). |
| **SincronizadorSAP** | `EXEMPLOS/SECRETOS` | `conf.ini` de exemplo (54 linhas) com credenciais cifradas. |
| **SincronizadorAD** | `EXEMPLOS/CONFIG` | 43 arquivos cobrindo as 10 ações roteadas por `-acao`. |
| **SincronizadorFerias** | `EXEMPLOS/RODAVEIS` | 6 templates BDesk. |
| **SincronizadorGrupos** | `instrucoes-configuracao/EXEMPLOS` | 3 arquivos (`conf.ini`, `abertura.json`, `encerramento.json`). |

### Exemplo de `conf.ini` — SincronizadorGrupos

O `conf.ini` de exemplo do SincronizadorGrupos (`instrucoes-configuracao/EXEMPLOS/conf.ini`) ilustra as três seções obrigatórias:

```ini
[Geral]
CaminhoDados = D:\gitlab\sincronizador-grupos\dados-ou-qualquer-nome-de-pasta
CaminhoBackups = F:\em-outra-unidade\ou-mesmo-outra-maquina\backups-ou-qualquer-nome-de-pasta
MaximoAlteracoesPorExecucao = 10

[ActiveDirectory]
Servidor = 127.1.1.1
Caminho = DC=herocorp,DC=com,DC=br
CaminhoGrupos = CN=Users
Login = 17210
Senha = 17210

[BDesk]
URL = https://askrest
Executar = true
Token = 172101721017210172101721017210172101721017210
```

!!! warning "Nunca commitar credenciais reais"
    Os valores acima são **placeholders** de exemplo. Em produção, `Login`, `Senha` e `Token` devem ser cifrados com `-criptografar` e os arquivos `conf.ini` reais devem ficar fora do controle de versão, com permissões restritas no servidor de deploy.

---

## Resumo do fluxo de configuração

1. **`conf.ini`** define infraestrutura, limites e credenciais cifradas (validadas por `CamposObrigatoriosIni`).
2. **XOR** (chaves `109` / `191` / `161`) protege `Login`/`Senha`/`Token`; gere com `-criptografar`.
3. **`config.json`** parametriza quarentena (`OuDestino`, `ExtensionAttributeOuOriginal`, `DiasParaExpiracao`, `DiasInatividade`, `MaximoAbertura`) e Azure (`TempoEsperaEmHoras`).
4. **Templates `CONFIG/{acao}/*.json`** modelam busca de duplicatas e ações de sucesso, usando tokens de substituição.
5. **Listas em `ConfigComum/`** controlam exceções e whitelist por login, grupo ou CPF.
