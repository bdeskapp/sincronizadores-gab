# Glossario

Esta pagina reune os termos recorrentes do dominio de negocio e da implementacao
dos **Sincronizadores GAB**. Os significados refletem o comportamento real do
codigo-fonte C# (.NET 8.0); quando um termo cita um atributo do Active Directory,
uma classe ou um arquivo, o nome utilizado e o nome real encontrado no codigo.

!!! note "Convencao"
    Todo o codigo (identificadores, comentarios e strings) esta em portugues do
    Brasil. Atributos do Active Directory (ex.: `accountExpires`,
    `userAccountControl`) seguem o esquema oficial da Microsoft e por isso
    aparecem em ingles.

## Conceitos do BDesk e do fluxo de requisicoes

| Termo | Significado |
|-------|-------------|
| **BDesk** | Sistema de chamados/requisicoes que atua como fila de trabalho e trilha de auditoria. Os sincronizadores consomem requisicoes abertas no BDesk e, ao concluir cada acao, postam o resultado (sucesso/erro) de volta via API REST (`/v1/requisicoes/...`). |
| **Requisicao** | Item de trabalho aberto no BDesk e consumido pelos sincronizadores. Cada requisicao carrega os dados de entrada (login, CPF, datas, campos do formulario) que orientam a mutacao a ser aplicada no AD/Azure. |
| **Desdobramento** | Sub-requisicao automatica derivada de uma requisicao principal. No `ExecutorInsercao`, a criacao de uma conta dispara ate 8 desdobramentos (SAP, Sistemas, Rede, Internet, Email, VPN, Telefonia, Azure) via `POST /v1/requisicoes/desdobrar`. |
| **Solicitante** | Login que figura como autor da requisicao aberta. E derivado da OU do usuario (ver `%PARTICIPANTE_POR_OU%`); se nao houver mapeamento, usa-se o fallback `Config["BDesk"]["Solicitante"]`. |
| **%PARTICIPANTE_POR_OU%** | Token de template substituido pelo login do solicitante mapeado por OU (via `mapeamento-participantes.json`). Quando nao ha mapa para a OU, aplica-se o fallback do robo de execucao (login sem o 1o caractere, `Login.Substring(1)`). |
| **FILA / ENVIADOS** | Pastas de uma fila persistente em disco que implementam um *two-phase commit* das requisicoes BDesk: o JSON e gravado em `FILA/`, processado (abertura + acoes) e movido para `ENVIADOS/` apos sucesso, evitando perda em falhas transitorias. |
| **FILA-MODO-CONSULTA** | Pasta de fila usada quando `Config["BDesk"]["Executar"]` nao e `"true"`. As requisicoes sao geradas para inspecao, mas **nunca submetidas** ao BDesk (modo *dry-run*). |
| **ItemHistorico.Insucesso / Aguardando** | Flags de controle por requisicao. `Insucesso = true` marca falha definitiva (posta erro no BDesk); `Aguardando = true` adia o processamento sem postar falha (ex.: data de exclusao ainda nao atingida, ou usuario Azure ainda nao propagado dentro do `TempoEsperaEmHoras`). |

## Roteamento e modos de execucao

| Termo | Significado |
|-------|-------------|
| **Acao (`-acao`)** | Parametro de linha de comando que roteia o comportamento do executavel. No SincronizadorAD seleciona uma das 10 acoes (`inserir`, `atualizar`, `manutencao`, `quarentena`, `retornar_quarentena`, `excluir`, `excluir_cpf`, `marcar_pendente`, `marcar_pendente_cpf`, `azure`). No SincronizadorSAP seleciona a passada principal ou as acoes de quarentena (`monitorar_quarentena`, `expirar_quarentena`). |
| **Passada principal** | Modo de *merge* completo do SincronizadorSAP: compara dados de SAP + Metadados + AD e produz lotes de Novos / Alterados / Excluidos. Contrasta com as acoes de quarentena, que apenas monitoram/expiram. O fluxo ativo usa `Comparar_ViaRegraNova`. |
| **ModoConsultar (`-consultar` vs `-executar`)** | `-consultar` e o modo *dry-run* (apenas simula e registra); `-executar` aplica de fato as mutacoes no AD e submete as requisicoes. |
| **Regra Nova vs Regra Antiga** | Criterio de exclusao no SincronizadorSAP. **Regra Nova** (`UsuariosExcluidos_ViaRegraNova`, ativa): marca um CPF para exclusao apenas quando **100%** dos registros daquele CPF (agregando SAP + Metadados) estao desligados. **Regra Antiga** (`UsuariosExcluidos`, compilada mas nao invocada): marcava exclusao se **qualquer** registro estivesse desligado. |

## Active Directory: atributos e flags

| Termo | Significado |
|-------|-------------|
| **`accountExpires`** | Atributo AD no formato FILETIME que controla a expiracao da conta. Os valores `0` e `MaxValue` (`9223372036854775807`) significam *never expires*. O SincronizadorFerias usa este atributo para desabilitar/liberar contas durante e apos as ferias. |
| **`userAccountControl`** | Bitmask de controle da conta no AD. Os sincronizadores leem e gravam este valor para habilitar/desabilitar contas via operacoes *bitwise*. |
| **`ADS_UF_ACCOUNTDISABLE`** | Bit `0x0002` do `userAccountControl` que desabilita a conta (constante definida em `src/Sincronizadores.Lib/ActiveDirectory.cs`). Aplicado com OR (`uac \| ADS_UF_ACCOUNTDISABLE`) para desabilitar e removido com AND/NOT (`uac & ~ADS_UF_ACCOUNTDISABLE`) para reativar. |
| **`extensionAttribute` / `msDS-cloudExtensionAttribute1`** | Atributo onde a OU original do usuario e salva durante a quarentena, **antes** do `MoveTo` (pois o DN muda apos a movimentacao). O atributo padrao e `msDS-cloudExtensionAttribute1` (configuravel via `config.json`). O `ExecutorRetornarQuarentena` le este valor para devolver o usuario a OU de origem. |
| **campo `info`** | Atributo AD onde o `ExecutorQuarentena` grava o carimbo de tempo de entrada em quarentena, no formato `Movido para quarentena em yyyy-MM-dd HH:mm:ss`. E parseado pelas acoes SAP (`ParseTimestampQuarentena`) para comparar com o ultimo login. |
| **`lastLogonTimestamp`** | Atributo AD do ultimo login **bem-sucedido**. Usado para detectar inatividade (quarentena no SAP) e logins pos-quarentena. Tentativas de login falhas nao o atualizam, portanto a filtragem por este atributo considera apenas logins com sucesso. |
| **`whenCreated`** | Atributo AD usado como *fallback* de inatividade quando `lastLogonTimestamp` e nulo/invalido (metodo `SemLogarHaTempos` do SincronizadorSAP). |
| **Watermark `:CheckedOut:`** | Marca de propriedade da automacao gravada no segundo paragrafo do `streetAddress` pelo SincronizadorFerias (bloco `:CheckedOut:NAO REMOVER ESTE BLOCO!}`). Sinaliza que o valor foi definido pela automacao, evitando sobrescrever ajustes manuais; e removido no retorno das ferias. |

## Quarentena

| Termo | Significado |
|-------|-------------|
| **OU mensal `5S-{MM-yyyy}`** | Sub-OU criada (se nao existir) dentro da OU de quarentena, nomeada com o mes corrente (ex.: `5S-03-2026`). O usuario em quarentena e movido para esta OU mensal via `MoveTo`. |

!!! tip "Sequencia da quarentena"
    No `ExecutorQuarentena`, a ordem e: (1) salvar a OU original no
    `extensionAttribute`; (2) mover o usuario para a OU mensal `5S-{MM-yyyy}`;
    (3) gravar o timestamp no campo `info`; (4) desabilitar a conta com
    `ADS_UF_ACCOUNTDISABLE`. O retorno (`ExecutorRetornarQuarentena`) **nunca**
    altera o `userAccountControl`: a conta permanece desabilitada apos voltar a
    OU original.

## Identificacao, normalizacao e listas

| Termo | Significado |
|-------|-------------|
| **`CPF.SomenteDigitos()`** | Normalizacao do CPF removendo formatacao (pontos/traco), usada como chave de agrupamento (`GroupBy`) e de junção (`join`) entre as fontes SAP, Metadados e AD. O CPF literal e preservado nos campos de saida das requisicoes. |
| **Prefixo `ps.`** | Indica prestador de servico. No SincronizadorAD, e prependado a cada tentativa de login quando o formulario marca "Prestador de Servico?" = True; prestadores tambem tem *cap* de 90 dias em `accountExpires` e nao entram no `GrupoVPN`. No SincronizadorSAP, logins iniciados por `ps.` sao removidos antes da comparacao (`RemoverComPS`). |
| **Listas negras / listas de excecao** | Logins e grupos ignorados pela sincronizacao. Existem conjuntos distintos: AD (`lista-negra-ad-*`), quarentena (`lista-negra-quarentena-*`) e ferias (`lista-negra-ferias-*`). Grupos sao normalizados para `CN=...,DC=...` em minusculas. Usuarios nessas listas sao pulados pelas automacoes correspondentes. |
| **usuarios-permitidos / usuarios-proibidos** | *Whitelist* / *blacklist* por CPF no SincronizadorSAP (`usuarios-permitidos.txt`, `usuarios-proibidos.txt`). A whitelist so e aplicada quando `[BDesk] ExecutarSomenteUsuariosDaListaDeUsuariosPermitidos = true`. |

## Tecnologias e padroes de implementacao

| Termo | Significado |
|-------|-------------|
| **XOR (criptografia de credenciais)** | Esquema de cifragem de credenciais no `conf.ini` usando chaves fixas em `Cross-Cutting/Security/Cryptography.cs`: `EncC1 = 109`, `EncC2 = 191`, `EncKey = 161`. Valores cifrados sao gerados via `-criptografar`. |
| **ADODB / ADSDSOObject** | Acesso COM ao Active Directory (provedor `ADSDSOObject`). Usado pelo SincronizadorSAP e SincronizadorFerias para consultas LDAP via `ADODB.Connection`. A `COMReference ADODB` (EmbedInteropTypes) exige build em Windows com Visual Studio. |
| **`DirectorySearcher`** | Classe de `System.DirectoryServices` para busca LDAP. As acoes de quarentena do SAP usam `SearchScope.Subtree` com `PageSize = 1000`; o SincronizadorGrupos usa `SearchScope.OneLevel` (apenas usuarios diretos de cada OU). |
| **Microsoft Graph / MSAL** | Bibliotecas usadas pela acao `azure` do SincronizadorAD para MFA no Azure AD (`Microsoft.Graph` + `Microsoft.Identity.Client`). A identidade vem direto dos campos BDesk (`UserPrincipalName` em "DADOS DO USUARIO AZURE"), sem busca no AD. |
| **Self pattern** | Uso de `Self.Metodo()` em vez de chamada direta para permitir interceptacao em testes (RhinoMocks). Ex.: a passada principal do SAP chama `Self.Comparar_ViaRegraNova`. |

!!! warning "O codigo e a verdade"
    Os significados acima refletem o comportamento verificado no codigo-fonte em
    `src/`. Documentos de negocio e arquivos `CLAUDE.md` sao insumos e podem estar
    desatualizados; em caso de divergencia, prevalece o codigo.
