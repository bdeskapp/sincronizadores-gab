# Servidores e Credenciais

Esta página documenta os servidores de produção da suíte **Sincronizadores GAB** e o
modelo de credenciais usado pelas quatro aplicações console .NET 8.0
(SincronizadorAD, SincronizadorSAP, SincronizadorFerias e SincronizadorGrupos).

!!! info "Referências cruzadas"
    - Para o processo de compilação e os artefatos gerados, consulte a página **Deploy e Build**.
    - Para o detalhamento de `conf.ini`, `config.json`, templates e listas negras, consulte a página **Configuração**.

## Servidores de produção

A suíte é executada via **Windows Task Scheduler** (não há hospedagem em IIS).
A instalação acompanha a estrutura do sistema BDesk e está replicada em dois
servidores.

| Servidor | Papel | Evidência |
|----------|-------|-----------|
| **GAB13013i** | Servidor **ativo** — o serviço é executado **a partir** dele | `instrucoes.txt:2,6` + `CLAUDE.md` |
| **GAB13011i** | Servidor **standby** | `instrucoes.txt:2,6` |

!!! warning "Toda alteração deve ser aplicada em AMBOS os servidores"
    Embora o serviço seja executado **a partir de GAB13013i**, qualquer alteração
    de configuração, binários ou templates **deve ser replicada manualmente nos
    dois servidores** (GAB13013i **e** GAB13011i), conforme `instrucoes.txt:6`:

    > "Por se tratar de um serviço, o sincronizador será executado a partir do
    > servidor GAB13013i, porém, as alterações devem ser aplicadas nos dois
    > servidores onde o sincronizador está configurado (GAB13013i e GAB13011i)."

!!! danger "Sem lock/failover automatizado"
    **Não há mecanismo de lock ou failover automatizado evidenciado** entre
    GAB13013i e GAB13011i. A consistência entre os dois servidores depende de
    procedimento operacional manual; não existe sincronização automática de
    binários nem eleição de servidor ativo.

## Caminhos de deploy

O único caminho **confirmado em código/documentação** é o do SincronizadorSAP
(`instrucoes.txt:2`):

```text
F:\BusinessDesk\ASK\SincronizadorSAP\
```

Para os demais aplicativos, o padrão **inferido** segue
`F:\BusinessDesk\ASK\{ExeName}\`:

| Aplicativo | Caminho de deploy | Status |
|------------|-------------------|--------|
| SincronizadorSAP | `F:\BusinessDesk\ASK\SincronizadorSAP\` | Confirmado (`instrucoes.txt:2`) |
| SincronizadorAD | `F:\BusinessDesk\ASK\SincronizadorAD\` | **A confirmar** (inferido) |
| SincronizadorFerias | `F:\BusinessDesk\ASK\SincronizadorFerias\` | **A confirmar** (inferido) |
| SincronizadorGrupos | `F:\BusinessDesk\ASK\SincronizadorGrupos\` | **A confirmar** (inferido) |

## Runtime obrigatório

O runtime de produção é **.NET 8.0 para Windows (x64/x86)**. As dependências de
COM interop e `System.DirectoryServices` tornam a execução **Windows-only**.

| Componente | TargetFramework | Observação |
|------------|-----------------|------------|
| SincronizadorAD / SincronizadorSAP / SincronizadorFerias / SincronizadorGrupos | `net8.0-windows8.0` | Sincronizadores de produção |
| Atendame.Core | `net8.0` (puro) | Biblioteca portável (sem dependência Windows) |
| SincronizadorAD.Simulador (legacy) | `.NET Framework 4.0` | **Não está em produção** |

!!! note "Dependências nativas obrigatórias"
    - **COM interop ADODB** é obrigatório para **SAP** e **Férias**
      (`EmbedInteropTypes=true`). Builds em Linux/WSL falham com `MSB4803` — veja
      a página **Deploy e Build**.
    - **System.DirectoryServices 8.0.0** é usado por **AD**, **Férias** e **Grupos**.

## Modelo de credenciais

As credenciais sensíveis (logins e senhas de SAP, Metadados, Active Directory e
BDesk) são **criptografadas com XOR usando chaves fixas no binário** e
armazenadas no `conf.ini`. Elas são decriptadas em runtime, no momento da leitura
da configuração.

### Criptografia XOR com chaves fixas

As chaves estão fixas em código em
`src/Cross-Cutting/Security/Cryptography.cs` (linhas 10-12):

| Constante | Valor |
|-----------|-------|
| `EncKey` | `161` |
| `EncC1` | `109` |
| `EncC2` | `191` |

!!! warning "Chaves embutidas no binário"
    As chaves de criptografia são **constantes fixas no código**, não segredos
    rotacionáveis. Os valores cifrados no `conf.ini` protegem contra leitura
    casual, mas **não** constituem proteção criptográfica forte, pois qualquer
    cópia dos binários permite a decriptação.

### Geração de valor criptografado (CLI)

Para gerar o valor cifrado de um login ou senha, executa-se o próprio
sincronizador em modo utilitário; a saída é escrita em **stdout** e deve ser
copiada para o campo correspondente do `conf.ini` (`instrucoes.txt:57`):

```bash
SincronizadorSAP.exe -criptografar valor-a-criptografar
```

O modo `-criptografar` está disponível em todas as aplicações da suíte.

## Campos obrigatórios do `conf.ini`

O `conf.ini` é dividido em seções por sistema integrado. A validação ocorre na
inicialização (via `CamposObrigatoriosIni`): se um campo obrigatório estiver
ausente, o aplicativo aborta. Os campos **Login** e **Senha** são sempre
armazenados **criptografados** (XOR) e decriptados em runtime.

### `[ActiveDirectory]`

| Campo | Descrição |
|-------|-----------|
| `Servidor` | Endereço/IP do servidor Active Directory |
| `Caminho` | Caminho base LDAP de busca |
| `Login` | Login de acesso ao AD (**criptografado**) |
| `Senha` | Senha de acesso ao AD (**criptografada**) |
| `CampoCPF` | Atributo do AD que armazena o CPF |
| `DiasDeEsperaPorExclusoes` | Janela de espera (apenas **AD/SAP**); default 7 |

### `[SAP]`

| Campo | Descrição |
|-------|-----------|
| `URL` | Endpoint do sistema SAP (SOAP/HTTP) |
| `Login` | Login de acesso (**criptografado**) |
| `Senha` | Senha de acesso (**criptografada**) |

### `[Metadados]`

| Campo | Descrição |
|-------|-----------|
| `URL` | Endpoint do sistema Metadados |
| `Login` | Login de acesso (**criptografado**) |
| `Senha` | Senha de acesso (**criptografada**) |
| `DeveProcessar` | `true`/`false` — indica se os dados de Metadados devem ser processados |

!!! note "Metadados: HTTP/XML no SAP, SQL/OleDb no Férias"
    No **SincronizadorSAP**, Metadados é consumido via **HTTP/XML**. No
    **SincronizadorFerias**, além do HTTP, há acesso via **SQL/OleDb** configurado
    na seção adicional `[BancoDeDadosMetadados]`, usado para injetar as datas de
    férias.

### `[BDesk]`

| Campo | Descrição |
|-------|-----------|
| `URL` | Endpoint da API REST do BDesk |
| `Token` | Token de acesso à API REST do BDesk |

!!! info "Campos adicionais de `[BDesk]` no SincronizadorSAP"
    O **SincronizadorSAP** exige, além de `URL` e `Token`, campos específicos de
    abertura de requisição (`instrucoes.txt:77-99`):

    - **Activity IDs:** `Formulario` (suportado: 68), `AtividadeInserir`,
      `AtividadeAtualizar`, `AtividadeExcluir`.
    - **Criticidade** e **limites de lote:** `Criticidade`,
      `QuantidadeMaximaDeInsercoes`, `QuantidadeMaximaDeAtualizacoes`,
      `QuantidadeMaximaDeExclusoes`.
    - **Origem/solicitante:** `Solicitante` (participante solicitante padrão),
      `DescricaoOrigem`, `TelefoneContato`.
    - **Filtro:** `ExecutarSomenteUsuariosDaListaDeUsuariosPermitidos`.

## A confirmar

Os itens abaixo aparecem apenas como **placeholders** nos exemplos ou não foram
evidenciados em código; precisam ser confirmados contra o ambiente real de
produção.

!!! warning "Itens pendentes de confirmação contra produção"
    **Servidores e paths**

    - Servidores e caminhos de deploy de **SincronizadorAD**, **SincronizadorFerias**
      e **SincronizadorGrupos** (assume-se o padrão `F:\BusinessDesk\ASK\{ExeName}\`).
    - Mecanismo de lock/failover entre GAB13013i ↔ GAB13011i (nenhum automatizado
      evidenciado).

    **URLs/IPs reais (atualmente placeholders nos exemplos)**

    - SAP: `http://sapaguiabranca`
    - Metadados: `http://metadados`
    - BDesk: `https://askrest`
    - Active Directory: `127.1.1.1`

    **Outros placeholders**

    - Domínio AD: `@universe.heroes`
    - `GrupoInternet`: `CN=Web_Level 02 - BOT,OU=Proxy,OU=Groups,OU=GERAIS`
    - Variável de ambiente `%BUSINESS_DESK%` e a localização real de
      `funcionalidades.txt` (origem das feature flags / `BooleanosVersao`).

!!! note "Atenção aos IDs de Activity/Criticidade no SAP"
    O arquivo `instrucoes.txt:88-91` documenta valores **históricos** de
    criticidade (Emergencial `2350`, Alta `2351`, Normal `2349`), enquanto os
    exemplos atuais (`EXEMPLOS/SECRETOS/conf.ini`) usam `2573`/`2572`/`2571`.
    Confirme os IDs vigentes antes de configurar o ambiente de produção — veja a
    página **Configuração** para o detalhamento.
