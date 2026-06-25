# Glossario

Glossario dos termos de dominio dos **Sincronizadores GAB**, em ordem alfabetica. Cada definicao e curta e cita, quando relevante, o arquivo ou classe onde o termo aparece no codigo (C# .NET 8.0). Quando um termo for uma configuracao, indica-se seu valor padrao.

!!! note "Convencao"
    Os caminhos abaixo sao relativos a `src/` no repositorio `sincronizadoresgab`, salvo indicacao em contrario. A versao do **codigo** prevalece sobre qualquer documento.

---

## A

### accountExpires
Atributo do Active Directory (formato **FILETIME**) usado pelo **SincronizadorFerias** para controlar a validade da conta durante o periodo de ferias. Quando o usuario esta de ferias (`FinalFerias > hoje`), recebe a data de inicio das ferias convertida via `ToFileTime()`. Quando o usuario retorna (`FinalFerias <= hoje`), recebe o valor literal `"0"`, que no AD significa **never expires** (conta sem expiracao). Implementado em `SincronizadorFerias/ExecutorSincronizadorFerias.cs` (linhas 246-248, 484-489).

### ADODB
Biblioteca COM (interop) usada para consultar o Active Directory **em massa**. E empregada na **main pass** do SincronizadorSAP e no SincronizadorFerias, configurando a conexao com `Page Size = 10000` e `Timeout = 30` segundos (`SincronizadorSAP/ServicoSincronizadorSAP.cs`, linhas 886-887, metodo `ObterUsuariosAD2()`). Requer `EmbedInteropTypes=true` e so resolve em build Windows (gera erro MSB4803 em Linux/WSL).

### ADS_UF_ACCOUNTDISABLE
Flag `0x0002` do atributo `userAccountControl` que **desabilita** a conta no AD. Definida em `ActiveDirectory.cs:9` com o comentario "Disable user account". Aplicada via OR bit a bit na entrada em quarentena (`ExecutorQuarentena.cs`, linhas 204-207) e removida (re-habilitacao) na reativacao por recontratacao em `ExecutorAuxiliarBase.cs`. A exclusao por login so prossegue se a conta tiver esta flag ligada (conta inativa).

### ANTE
Participante **solicitante** de uma requisicao BDesk, derivado da **ultima OU** do `distinguishedName` (DN) do usuario. O algoritmo faz split do DN por virgula, descarta as partes `DC=`, toma o valor da ultima parte restante e busca em `LoginsDoSolicitantePorOu`, com fallback para `Config["BDesk"]["Solicitante"]` (`SincronizadorSAP/ServicoSincronizadorSAP.cs`, metodo `MapearSolicitante`, linhas 326-362). Se o BDesk responder exatamente `Participante 'ANTE' nao encontrado`, o envio tenta um `LoginSolicitante` alternativo (`AlternativaEnvioBDesk`).

## B

### BDesk
Sistema de chamados (REST API) consumido e alimentado por **todos** os sincronizadores. As requisicoes sao abertas via `POST /v1/requisicoes/abrir` e fechadas com acoes via `POST /v1/requisicoes/{id}/acoes`; requisicoes abertas sao consultadas em `/v1/requisicoes/abertas` (deduplicacao). E a fonte de requisicoes processadas pelo SincronizadorAD e o destino das colacoes de Novos/Alterados/Excluidos da main pass do SAP.

## C

### CheckedOut / watermark
Marcador `:CheckedOut:` gravado pelo **SincronizadorFerias** no campo `streetAddress` para indicar que a automacao e **proprietaria** da alteracao. O bloco completo tem o formato:

```text
{Ferias: DD/MM/YYYY - DD/MM/YYYY
SincronizadorFerias {version}:CheckedOut:NAO REMOVER ESTE BLOCO!}
{conteudo original}
```

O `{version}` vem de `Versao.Release`. O sentinela de remocao e `:CheckedOut:NAO REMOVER ESTE BLOCO!}\n`. O campo e truncado em **1020 caracteres** (limite UTF-16 do AD). A presenca do marcador na linha de indice 1 do split por `\n` identifica os usuarios de retorno/atualizacao (regra **L2**). Ver `ExecutorSincronizadorFerias.cs` (linhas 262-293).

!!! warning "Remocao manual do watermark"
    Apagar manualmente o bloco watermark do `streetAddress` deixa a conta presa no fluxo de ferias. Nao remova o bloco a mao.

### CPF.SomenteDigitos()
Metodo de extensao que normaliza o CPF removendo tudo que nao for digito. E a **chave de correlacao** entre todas as fontes (SAP, Metadados, AD): agrupamentos, joins e deduplicacoes usam essa chave. Aparece, por exemplo, no agrupamento de exclusao do SAP (`ExecutorSincronizadorSAP.cs:322`) e nos joins do SincronizadorFerias.

## D

### DA13 / DA16 / DA19
Codigos de campo do dicionario de dados SAP:

| Codigo | Significado | Atributo AD | Usado em alteracao? |
|--------|-------------|-------------|---------------------|
| **DA13** | Data de Nascimento | — | Nao (sincronizada, mas `Comparar=false`) |
| **DA16** | Cargo | `title` | Sim (case-insensitive) |
| **DA19** | Centro de Custo | `postalCode` | Sim (case-insensitive) |

Apenas **DA16** e **DA19** disparam deteccao de alteracao no SAP; a comparacao e case-insensitive via `.ToLower()` (`SincronizadorSAP/ServicoSincronizadorSAP.cs`, metodo `Diferentes()`, linhas 103-119 e 721-734).

### Desdobramento
Sub-requisicao criada via `POST /v1/requisicoes/desdobrar` para provisionar acessos durante a **insercao** de um usuario. O SincronizadorAD suporta ate **8** tipos de desdobramento (SAP, Sistemas, Rede, Internet, Email, VPN, Telefonia, Azure), mas dispara cada um **condicionalmente**, apenas quando ha solicitacao explicita no formulario BDesk (ex.: SAP so e disparado se "Acesso Sistemas > 2.1 - SAP" = `True`). Ver `ExecutorInsercao.cs`.

### DeveProcessar
Flag de elegibilidade de empresa/origem. No SAP/Ferias e lido da coluna 2 de `empresas.txt` (`== "true"`); no Metadados vem de `Config["Metadados"]["DeveProcessar"]` (`== "true"`). Usuarios com `DeveProcessar=false` sao filtrados antes da comparacao (`SincronizadorFerias/ExecutorSincronizadorFerias.cs`, linhas 563-565 e 683).

### DiasInatividade
Limiar (em dias) de inatividade sem login para um usuario virar **candidato a quarentena** por inatividade. Valor de exemplo **90**. Lido de `ConfigJson["ActiveDirectory"]["Quarentena"]["DiasInatividade"]` na main pass do SAP (`ExecutorSincronizadorSAP.cs:1221`), comparando `lastLogonTimestamp` (com fallback para `whenCreated`).

### DiasParaExpiracao
Limiar (em dias) de permanencia em quarentena, sem login posterior, para disparar a **exclusao definitiva**. Padrao **30** (`AcaoSincronizadorSAP.cs:135`, metodo `ObterDiasParaExpiracao()`), configuravel em `config.json [ActiveDirectory][Quarentena][DiasParaExpiracao]`. Consumido por `AcaoExpirarQuarentena.cs`.

## E

### ENVIADOS
Diretorio (write-ahead) para onde as requisicoes BDesk **confirmadas** sao movidas apos o envio bem-sucedido. Faz parte do trio `FILA` / `FILA-MODO-CONSULTA` / `ENVIADOS`, criado em runtime relativo ao executavel.

### ExtensionAttributeOuOriginal
Atributo do AD usado para guardar a **OU original** do usuario enquanto ele esta em quarentena. Padrao `msDS-cloudExtensionAttribute1` (`ExecutorSincronizadorAd.cs:37`), configuravel via `config.json [ActiveDirectory][Quarentena][ExtensionAttributeOuOriginal]`. Gravado **antes** do move em `ExecutorQuarentena.cs:183` e lido no retorno em `ExecutorRetornarQuarentena.cs:28`.

## F

### FILA / FILA-MODO-CONSULTA / ENVIADOS
Diretorios **write-ahead** das requisicoes BDesk, criados em runtime:

- **`FILA/`** — requisicoes pendentes a serem submetidas (modo `-executar`).
- **`FILA-MODO-CONSULTA/`** — requisicoes geradas em modo `-consultar` (dry-run); **nunca** sao submetidas.
- **`ENVIADOS/`** — requisicoes ja confirmadas pela API.

No SincronizadorGrupos, a pasta usada e `FILA` quando `[BDesk]Executar == "true"` e `FILA-MODO-CONSULTA` caso contrario (`ExecutorSincronizadorGrupos.cs`, linhas 209-223).

### FILETIME
Formato de data de 64 bits do Windows/AD (intervalos de 100 ns desde 1601). Usado em `accountExpires` (Ferias) e em `lastLogonTimestamp`, este ultimo decodificado a partir de `HighPart`/`LowPart` via reflexao em `ConverterCOMParaFileTime()` (`SincronizadorSAP/ExecutorSincronizadorSAP.cs`, linhas 1333-1354).

### funcionalidades.txt
Arquivo de **feature flags** (mais de 20 flags) localizado em `%BUSINESS_DESK%`, carregado por `GerenciadorVersao.cs:14` (`BooleanosVersao`) via `Path.Combine(%BUSINESS_DESK%, "funcionalidades.txt")`.

## H

### Homologacao
Configuracao de build do solution, **alias de Release** (mesmas opcoes de compilacao). As configuracoes disponiveis sao `Debug`, `Release` e `Homologacao` (`dotnet build src/Sincronizadores.sln -c Homologacao`).

## L

### lastLogonTimestamp
Atributo AD (FILETIME) consultado para medir inatividade. Na deteccao de candidatos a quarentena, se for nulo ou `<= 0`, ha **fallback** para `whenCreated` (`ExecutorSincronizadorSAP.cs`, linhas 1288-1292). Tambem e a base para detectar login "pos-quarentena" nas acoes `monitorar_quarentena` e `expirar_quarentena`.

### LocalData
Diretorio de **deduplicacao** do SincronizadorSAP, com arquivos diarios no formato `yyyyMMdd.json`. Antes da montagem dos JSONs de exclusao (`ExecutorSincronizadorSAP.cs:264`), remove os logins cuja exclusao foi bem-sucedida (API retornou ID valido) nos ultimos **7 dias** (configuravel via `DiasDeEsperaPorExclusoes`), evitando retentativas acidentais. Em modo dry-run usa `LocalData-modo-consultar/`.

## M

### main pass
A passada **principal** do SincronizadorSAP, agendada para **03:00**. Faz o merge das tres origens (SAP SOAP + Metadados HTTP + AD via ADODB) e produz colacoes de Novos/Alterados/Excluidos para abertura de requisicoes BDesk. Confirmado em `SincronizadorSAP/CLAUDE.md:303` e `instrucoes.txt:4`.

### Metadados
Sistema de RH interno usado como fonte de dados. Possui duas faces: **HTTP/XML** (consumida por SAP, Ferias e pela verificacao de recontratacao do AD) e **SQL/OleDb** (usada pelo SincronizadorFerias via `[BancoDeDadosMetadados]` para injetar datas de ferias). A correlacao com as demais fontes e feita por `CPF.SomenteDigitos()`.

### modo -consultar
Modo de execucao **dry-run, read-only**: nao aplica `CommitChanges` no AD, nao faz `POST` no BDesk e escreve em `FILA-MODO-CONSULTA/` / `LocalData-modo-consultar/`. Disponivel em todos os apps.

!!! warning "Excecao no SincronizadorGrupos"
    O rename de CN (quando ha `NomeEmpresa`) e executado **mesmo em modo `-consultar`**, sem a guarda `if(!ModoConsultar)` que protege os demais campos (`ExecutorSincronizadorGrupos.cs:548-550`). E um comportamento divergente (bug conhecido), registrado nas discrepancias.

## O

### OU mensal 5S-{MM-yyyy}
Pasta (Organizational Unit) de **quarentena criada mensalmente** sob a OU de quarentena configurada. O nome segue `5S-{MM-yyyy}` (ex.: `5S-06-2026`) e, se nao existir, e criada com a descricao `OU de quarentena para 5S-{MM-yyyy}`. Ver `ExecutorQuarentena.cs` (linhas 59-111). O usuario em quarentena e movido para dentro dela.

## P

### ps. (prefixo de login)
Prefixo aplicado automaticamente ao login de um **Prestador de Servico**. Quando o campo "1.11 Prestador de Servico?" e `True`, define-se `prefixo = "ps."`, concatenado em todas as 8 tentativas de geracao de login (`ExecutorInsercao.cs`, linhas 122-188). Na validacao de palavras pejorativas, o prefixo e removido via `Split('.').Last()` antes da comparacao.

### Prestador de Servico
Conta cuja validade e **limitada a 90 dias** a partir da data de abertura da requisicao. Se a data de expiracao solicitada exceder esse limite, prevalece o cap de 90 dias (`dataAbertura.AddDays(90)`, `ExecutorInsercao.cs`, linhas 413-418). Seu login recebe o prefixo `ps.`.

## Q

### Quarentena
Estado **temporario** de uma conta desligada no AD. Na entrada (`ExecutorQuarentena.cs`), o sistema: (1) salva a OU original em `ExtensionAttributeOuOriginal` **antes** do move; (2) move o usuario para a **OU mensal `5S-{MM-yyyy}`**; (3) grava o timestamp `Movido para quarentena em yyyy-MM-dd HH:mm:ss` no campo `info`; (4) desabilita a conta (`userAccountControl |= ADS_UF_ACCOUNTDISABLE`). O retorno (`ExecutorRetornarQuarentena.cs`) move de volta e limpa `info`/extensionAttribute, mas **nao** re-habilita a conta. O ciclo e cross-project (SAP abre requisicoes, AD executa).

## R

### Recontratacao
Verificacao por **CPF** consultando primeiro **Metadados** (HTTP) e depois **SAP** (SOAP) para checar se um usuario marcado para exclusao foi recontratado. Se recontratado, a conta e reativada (remove `ADS_UF_ACCOUNTDISABLE`) e a exclusao e **bloqueada** (`ExecutorExclusao.cs`, `VerificarRecontratacao()`, linhas 290-320). Aplica-se apenas a **exclusao por login**: e desabilitada para `ExecutorExclusaoPorCPF` e pulada quando o usuario ja esta em quarentena.

## S

### SAP
Fonte de dados de RH via **SOAP/XML**. Fornece os usuarios da main pass (mesclados com Metadados e AD) e e a segunda fonte consultada na verificacao de **recontratacao** do SincronizadorAD.

## U

### userAccountControl
Atributo do AD que controla o estado da conta (entre outras flags). Manipulado via OR/AND bit a bit com `ADS_UF_ACCOUNTDISABLE` (`0x0002`) para desabilitar (quarentena) ou reabilitar (recontratacao). O retorno de quarentena **nao** modifica este atributo. Confirmado em `ExecutorSincronizador.cs:47` (`CampoAccountControl = "userAccountControl"`).

## X

### XOR
Algoritmo de criptografia das credenciais armazenadas no `conf.ini` ([SAP], [Metadados], [ActiveDirectory], [BDesk]). Usa **chaves fixas** definidas em `Cryptography.cs` (linhas 10-12): `EncKey=161`, `EncC1=109`, `EncC2=191`. A geracao/cifragem e feita pelo utilitario de linha de comando `<exe> -criptografar <valor>`.
