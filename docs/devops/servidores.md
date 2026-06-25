# Servidores e Credenciais

Esta página descreve a infraestrutura de produção dos Sincronizadores GAB: os servidores onde a suíte está instalada, os caminhos de deploy, os requisitos de sistema operacional e runtime, as dependências técnicas, os endpoints externos consumidos, a conta de serviço necessária e o modelo de credenciais criptografadas.

!!! info "Origem dos fatos"
    Os dados de servidor e caminho de deploy desta página foram confirmados em `src/SincronizadorSAP/instrucoes-configuracao/instrucoes.txt`. Itens marcados como **(a confirmar)** não estão evidenciados em código nem em `instrucoes.txt` e exigem validação com a equipe de operação.

## Servidores de produção

A suíte está instalada em dois servidores Windows, ambos confirmados em `instrucoes.txt`:

| Host | Papel | Evidência |
| --- | --- | --- |
| `GAB13013i` | **Ativo** — o serviço é executado a partir deste host | `instrucoes.txt:6` ("Por se tratar de um serviço, o sincronizador será executado a partir do servidor GAB13013i") |
| `GAB13011i` | **Standby** — instalação espelhada, não executa o serviço por padrão | `instrucoes.txt:2,6` |

O texto de `instrucoes.txt:2` confirma: *"o sincronizador está instalado nos servidores GAB13011i e GAB13013i e, em ambos servidores o caminho para a instalação é `F:\BusinessDesk\ASK\SincronizadorSAP\`"*.

!!! warning "Não há failover automático e ambos os servidores devem ser mantidos consistentes"
    Não existe nenhum mecanismo de failover automático evidenciado no código — `instrucoes.txt` apenas **menciona** os dois hosts. O `GAB13013i` é o host ativo (executa o serviço via Task Scheduler) e o `GAB13011i` é mantido como standby por instalação espelhada, sem promoção automática.

    Por isso, conforme `instrucoes.txt:6`, **toda alteração de configuração deve ser aplicada em AMBOS os servidores** ("as alterações devem ser aplicadas nos dois servidores onde o sincronizador está configurado (GAB13013i e GAB13011i)"). Aplicar uma mudança apenas no host ativo deixa o standby desatualizado e inconsistente, comprometendo a recuperação caso seja necessário operar a partir do `GAB13011i`.

## Caminhos de deploy

| Aplicação | Caminho de instalação | Status |
| --- | --- | --- |
| `SincronizadorSAP` | `F:\BusinessDesk\ASK\SincronizadorSAP\` | Confirmado (`instrucoes.txt:2`) |
| `SincronizadorAD` | `F:\BusinessDesk\ASK\SincronizadorAD\` | **A confirmar** (análogo, não evidenciado) |
| `SincronizadorFerias` | `F:\BusinessDesk\ASK\SincronizadorFerias\` | **A confirmar** (análogo, não evidenciado) |
| `SincronizadorGrupos` | `F:\BusinessDesk\ASK\SincronizadorGrupos\` | **A confirmar** (análogo, não evidenciado) |

!!! note "Estrutura de deploy"
    Apenas o caminho do `SincronizadorSAP` está documentado em `instrucoes.txt`. A suíte acompanha a estrutura de instalação do BDesk (`instrucoes.txt:2`: *"Este sincronizador acompanha a estrutura de instalação do sistema Bdesk"*), o que sugere o padrão `F:\BusinessDesk\ASK\{NomeApp}\` para as demais aplicações, mas isso **não foi verificado em código nem em documento** — trate os caminhos de AD/Ferias/Grupos como "a confirmar".

## Requisitos de sistema operacional e runtime

| Requisito | Valor | Motivo |
| --- | --- | --- |
| Sistema operacional | **Windows obrigatório** (x64/x86) | Uso de **ADODB COM** e **System.DirectoryServices**, que são específicos de Windows |
| Runtime | **.NET 8.0** (`net8.0-windows8.0`) | Todas as 4 aplicações console têm como alvo este runtime |

!!! warning "Windows é obrigatório — não há suporte a Linux/WSL em produção"
    As aplicações dependem de interoperabilidade COM (ADODB) e de `System.DirectoryServices`, que só funcionam em Windows. `SincronizadorSAP` e `SincronizadorFerias` declaram `COMReference` para ADODB (`EmbedInteropTypes=true`), o que faz o build falhar em Linux/WSL. A execução em produção deve ocorrer exclusivamente em Windows.

## Dependências técnicas

A tabela abaixo lista as dependências e seu papel em cada sincronizador.

| Dependência | Versão | Papel |
| --- | --- | --- |
| `System.DirectoryServices` | (BCL) | Acesso LDAP/AD: criação, alteração, movimentação e exclusão de contas (`CommitChanges`, `MoveTo`) |
| ADODB COM (`ADODB.Connection` + provider `ADSDSOObject`) | COM interop | Consultas e mutações via OLE DB ao SAP (SOAP), ao Ferias e ao Active Directory |
| `System.DirectoryServices.DirectorySearcher` | (BCL) | Busca de usuários no AD em AD/Ferias/Grupos e nas ações de quarentena do SAP |
| `Microsoft.Graph` | 5.75.0 | Ação `azure` do `SincronizadorAD` — configuração de MFA via Microsoft Graph |
| `Microsoft.Identity.Client` (MSAL) | 4.70.0 | Autenticação de identidade para a integração Azure/MFA do `SincronizadorAD` |
| `ini-parser` | 2.5.2 | Leitura do `conf.ini` (configuração por cliente) |
| `HtmlAgilityPack` | 1.11.65 | Parsing do XML retornado pelo SAP |

!!! tip "Onde cada dependência aparece"
    - **ADODB COM** é usado para queries via `ADODB.Connection` com o provider `ADSDSOObject`, tanto para SAP/Ferias (SOAP) quanto para consultas ao AD.
    - **Microsoft.Graph + MSAL** são exclusivos da ação `azure` do `SincronizadorAD` (ver `src/SincronizadorAd/Executores/ExecutorAzure.cs`).

## Endpoints externos

Os endpoints **não são fixos em código** — são configurados por cliente no `conf.ini`. Os valores abaixo são **placeholders de exemplo**, não os endereços reais de produção.

| Sistema | Protocolo | Placeholder de exemplo | Consumido por |
| --- | --- | --- | --- |
| SAP | SOAP (XML) | `http://sapaguiabranca` | SAP, Ferias |
| Metadados | HTTP (XML) | `http://metadados` | AD, SAP, Ferias |
| Metadados (Ferias) | SQL Server via OleDb | (servidor/banco no `conf.ini`) | Ferias |
| BDesk | REST | `https://askrest` | Todas as aplicações |
| Active Directory | LDAP / ADODB | `127.1.1.1` | Todas as aplicações |

!!! note "Placeholders, não endereços reais"
    Os valores `http://sapaguiabranca`, `http://metadados`, `https://askrest` e `127.1.1.1` são apenas exemplos ilustrativos. Os endereços reais são definidos nas seções correspondentes do `conf.ini` de cada servidor (`[SAP]`, `[Metadados]`, `[BDesk]`, `[ActiveDirectory]`). Consulte a página de **Configuração** para o detalhe dos campos.

## Conta de serviço

A conta sob a qual o serviço executa precisa de **acesso de leitura e escrita (R/W) ao Active Directory**.

!!! warning "Permissão R/W no AD é obrigatória"
    Operações como `CommitChanges` (gravação de atributos) e `MoveTo` (movimentação entre OUs, p.ex. na quarentena) exigem permissão de escrita no AD. Sem ela, ações de inserção, atualização, quarentena, retorno de quarentena e exclusão falham. Garanta que a conta de serviço configurada no Task Scheduler do `GAB13013i` (e do `GAB13011i`, caso entre em operação) tenha esses direitos.

### Variável de ambiente `%BUSINESS_DESK%`

A variável de ambiente `%BUSINESS_DESK%` define o caminho do arquivo `funcionalidades.txt`, que controla *feature flags* da suíte (lidas via `GerenciadorVersao` / `BooleanosVersao`).

!!! note "Localização a confirmar"
    A existência da variável `%BUSINESS_DESK%` e seu uso para localizar `funcionalidades.txt` (feature flags) estão referenciados, mas a **localização exata do arquivo é a confirmar**. Como a variável é parte do ambiente do processo, ela também precisa estar definida de forma idêntica em ambos os servidores.

## Credenciais

As credenciais sensíveis do `conf.ini` (logins e senhas de SAP, Metadados, AD e o token do BDesk) são armazenadas **criptografadas**.

### Modelo de criptografia XOR

A criptografia é um esquema XOR com chaves fixas embutidas no código, implementado em `Cryptography.Encrypt` / `Cryptography.Decrypt` em `src/Cross-Cutting/Security/Cryptography.cs`:

| Constante | Valor |
| --- | --- |
| `EncC1` | `109` |
| `EncC2` | `191` |
| `EncKey` | `161` |

!!! warning "Chaves fixas no código"
    As chaves `109`, `191` e `161` são constantes estáticas no código-fonte (`Cryptography.cs`, linhas 10-12). Trata-se de ofuscação por XOR com chave fixa — adequada para impedir leitura casual do `conf.ini`, mas **não** equivalente a um cofre de segredos. Restrinja o acesso ao sistema de arquivos dos servidores e ao repositório de configuração.

### Geração de valor criptografado

Para gerar um valor criptografado, execute o próprio executável com o parâmetro `-criptografar` e copie o resultado impresso em `stdout` para o `conf.ini`:

```bat
SincronizadorSAP.exe -criptografar valor-a-criptografar
```

Conforme `instrucoes.txt:57`: *"O valor criptografado será escrito na tela e deve ser copiado no arquivo conf.ini na linha onde for necessário."* O mesmo padrão (`<exe> -criptografar <valor>`) vale para os demais executáveis da suíte.

!!! tip "Detalhe dos campos criptografados"
    Quais campos do `conf.ini` precisam estar criptografados (logins, senhas, token BDesk) e como preencher cada seção é descrito na página de **Configuração**.

## Discrepâncias

!!! warning "Configuração é por cliente — não há servidor AD padrão na infraestrutura"
    **Discrepância confirmada:** a configuração é **por cliente**, definida no `conf.ini` de cada instalação. **Não existe um servidor AD padrão (infra-wide)**: o campo `Config[ActiveDirectory][Servidor]` é **sempre obrigatório** e precisa ser informado explicitamente em cada `conf.ini`. Conforme `instrucoes.txt:72`, o campo `Servidor` da seção `[ActiveDirectory]` recebe o endereço IP do servidor Active Directory, sem valor padrão herdado da infraestrutura.
