# Deploy e Build

Esta página descreve como compilar, versionar, testar e implantar a suíte
**Sincronizadores GAB** — as quatro aplicações console .NET 8.0 que sincronizam
usuários e grupos entre Active Directory, SAP, Azure AD e o sistema de chamados
BDesk.

!!! info "Pré-requisitos resumidos"
    - **.NET 8.0 SDK** instalado.
    - **Windows + Visual Studio (MSBuild completo)** para compilar `SincronizadorSAP`
      e `SincronizadorFerias` (ver aviso sobre COM interop ADODB mais abaixo).
    - Acesso de leitura/escrita aos servidores de implantação (`GAB13013i` e
      `GAB13011i`) — consulte a página **Servidores** para detalhes de host.

---

## Build

A solução completa fica em `src/Sincronizadores.sln`. O comando padrão de build é:

```bash
dotnet build src/Sincronizadores.sln -c Debug
dotnet build src/Sincronizadores.sln -c Release
dotnet build src/Sincronizadores.sln -c Homologacao
```

### Configurações de build

São três configurações, **todas `Any CPU`** (não existe configuração `x86`):

| Configuração          | Plataforma | Observação                                         |
|-----------------------|------------|----------------------------------------------------|
| `Debug`               | `Any CPU`  | Build de desenvolvimento.                           |
| `Release`             | `Any CPU`  | Build de produção otimizado.                        |
| `Homologacao`         | `Any CPU`  | **Alias de `Release|Any CPU`** para todos os projetos. |

A configuração `Homologacao` mapeia para `Release|Any CPU` em todos os projetos —
não há diferença de saída em relação a `Release`, apenas o nome da configuração.

### Projetos SDK-style e metadados de assembly

Todos os projetos usam o formato **SDK-style** (`.csproj`) com
`<GenerateAssemblyInfo>false</GenerateAssemblyInfo>`. Como consequência, os
metadados de assembly (versão, produto, empresa etc.) ficam declarados
diretamente no `PropertyGroup` de cada `.csproj` — **não existe `AssemblyInfo.cs`
separado**.

### Caveat de COM interop (MSB4803) em Linux/WSL

!!! warning "Build de SincronizadorSAP e SincronizadorFerias exige Windows + Visual Studio"
    Os projetos **`SincronizadorSAP`** e **`SincronizadorFerias`** declaram uma
    `COMReference` para **ADODB** (`EmbedInteropTypes=true`). Em Linux/WSL,
    `dotnet build` **falha** para esses dois projetos com o erro fatal
    **`MSB4803`** (resolução de referência COM não suportada pelo `dotnet build`).

    Importante: a **compilação C# em si tem sucesso** (não há `error CS`); o que
    falha é exclusivamente a **resolução da referência COM**. Para compilar
    `SincronizadorSAP` e `SincronizadorFerias`, é necessário o **MSBuild completo
    do Visual Studio em Windows**.

    Os demais projetos (`SincronizadorAD`, `SincronizadorGrupos`, libs e testes)
    compilam normalmente via `dotnet build`.

---

## Geração de versão

A versão exibida pela suíte é gerada pelo script batch
**`tools/RegistrarRevisaoEmResources.bat`** (Windows). Ele recria o arquivo
**`src/Atendame.Core/Versao.cs`**, gravando a constante `Release` a partir do
primeiro argumento de linha de comando (`%1`):

```bat
echo         public const string Release = "%1";     >>src\Atendame.Core\Versao.cs
```

Uso típico:

```bat
tools\RegistrarRevisaoEmResources.bat "1.2.3"
```

O conteúdo gerado é a classe `Atendame.Core.Versao`:

```csharp
namespace Atendame.Core
{
    public class Versao
    {
        public const string Release = "(em desenvolvimento)";
    }
}
```

!!! note "Placeholder de versão"
    O valor atualmente versionado em `Versao.cs` é o placeholder
    **`"(em desenvolvimento)"`**. Ele só é substituído quando o batch é executado
    com a revisão real durante o empacotamento.

O valor de `Release` é consumido pelo token **`%VERSAO%`** nos templates JSON do
BDesk, permitindo registrar nas requisições qual revisão da automação executou a
ação.

---

## Artefatos gerados

| Artefato                          | Tipo            | Target Framework      | Observação                                  |
|-----------------------------------|-----------------|-----------------------|---------------------------------------------|
| `SincronizadorAD`                 | EXE (console)   | `net8.0-windows8.0`   | Mutações no AD por ação (`-acao`).          |
| `SincronizadorSAP`                | EXE (console)   | `net8.0-windows8.0`   | Passada principal + ações de quarentena. COM ADODB. |
| `SincronizadorFerias`             | EXE (console)   | `net8.0-windows8.0`   | Sincronização de férias. COM ADODB.         |
| `SincronizadorGrupos`             | EXE (console)   | `net8.0-windows8.0`   | Auditoria/sincronização de grupos por OU.   |
| `Ask`                             | Lib             | `net8.0-windows8.0`   | Framework de CLI + DI.                       |
| `Atendame.Core`                   | Lib             | `net8.0-windows8.0`   | Tipos compartilhados + `Versao`.            |
| `Cross-Cutting`                   | Lib             | `net8.0-windows8.0`   | Utilitários, criptografia, logging.         |
| `Sincronizadores.Lib`             | Lib             | `net8.0-windows8.0`   | Base `ExecutorSincronizador`, fila FILA, API BDesk. |
| `Cross-Cutting.Testes`            | Test lib        | `net8.0-windows8.0`   | Infraestrutura de testes (bases de mock).   |
| `SincronizadorAD.Simulador`       | EXE legado      | `net4.0`              | Ferramenta de dry-run; **fora do build principal**. |

!!! note "Simulador legado"
    O `SincronizadorAD.Simulador` permanece em **.NET Framework 4.0** (formato de
    projeto antigo) e **não faz parte do build da solução principal**. Ele
    sobrescreve o binding de `ServicoAD` via DI para simular o Active Directory.

---

## Pacotes NuGet relevantes

| Pacote                          | Versão    | Uso principal                                       |
|---------------------------------|-----------|-----------------------------------------------------|
| `Newtonsoft.Json`               | 13.0.3    | Serialização JSON (templates, config).              |
| `System.Diagnostics.EventLog`   | 8.0.0     | Logging no Windows Event Log.                        |
| `Microsoft.Graph`               | 5.75.0    | MFA Azure AD (`SincronizadorAD` ação `azure`).      |
| `Microsoft.Identity.Client`     | 4.70.0    | MSAL — autenticação de cliente para o Graph.        |
| `ini-parser`                    | 2.5.2     | Parsing de `conf.ini`.                               |
| `HtmlAgilityPack`               | 1.11.65   | Parsing de XML/SOAP do SAP.                          |
| `Castle.Core`                   | 5.1.1     | Suporte a mocks (testes).                            |
| `Moq`                           | 4.20.72   | Framework de mocks (testes).                         |
| `NUnit`                         | 4.2.2     | Framework de testes.                                 |
| `RhinoMocks`                    | 3.6.1     | Framework de mocks estritos (testes).               |

!!! tip "DLL local fora do NuGet"
    Em **`src/packages_nao_nuget/ADODB.dll`** há uma DLL local de ADODB, usada
    como **alternativa à referência COM** no `SincronizadorAD` (diferente de
    `SincronizadorSAP`/`SincronizadorFerias`, que declaram `COMReference` ADODB
    com `EmbedInteropTypes=true`).

---

## Testes

A execução de testes da suíte:

```bash
dotnet test src/Sincronizadores.sln
```

Para executar apenas o projeto principal de testes:

```bash
dotnet test src/SincronizadorSAP.Testes/SincronizadorSAP.Testes.csproj
```

**Stack de teste:** NUnit 4.2.2 + RhinoMocks 3.6.1 (modo **estrito**) + Moq
4.20.72, com a classe base genérica `TestadorMocks<T>` (em `Cross-Cutting.Testes`),
seguindo o padrão ARRANGE/ACT/ASSERT.

!!! warning "Cobertura de testes limitada"
    Apenas **`SincronizadorSAP.Testes`** e **`Cross-Cutting.Testes`** possuem
    testes. **Não há projetos de teste** para `SincronizadorAD`,
    `SincronizadorFerias`, `SincronizadorGrupos`, `Ask` nem `Atendame.Core`.

---

## Procedimento de deploy

A implantação consiste em copiar os artefatos compilados (EXE + libs + arquivos
de configuração `conf.ini` / `CONFIG` / listas) para o diretório de cada
aplicação nos servidores de produção.

**Caminho de deploy** (em ambos os servidores):

```
F:\BusinessDesk\ASK\{AppName}\
```

Onde `{AppName}` é `SincronizadorAD`, `SincronizadorSAP`, `SincronizadorFerias`
ou `SincronizadorGrupos`. O caminho `F:\BusinessDesk\ASK\SincronizadorSAP\` está
confirmado; os análogos para os demais aplicativos seguem o mesmo padrão.

Os artefatos devem ser copiados para **ambos os servidores**:

| Servidor    | Papel    |
|-------------|----------|
| `GAB13013i` | Ativo    |
| `GAB13011i` | Standby  |

!!! note "Detalhes de host"
    As características de cada servidor (sistema operacional, conta de serviço,
    permissões de AD, endpoints externos e agendamento via Task Scheduler) estão
    documentadas na página **Servidores**. Não há failover automático evidenciado
    no código — apenas a presença dos dois hosts.

!!! tip "Sequência sugerida de implantação"
    1. Compilar em Windows com Visual Studio MSBuild na configuração desejada
       (`Release` ou `Homologacao`).
    2. Rodar `tools\RegistrarRevisaoEmResources.bat "<versao>"` antes do build de
       release, para gravar a revisão em `Versao.cs`.
    3. Copiar os artefatos para `F:\BusinessDesk\ASK\{AppName}\` no servidor
       **standby** (`GAB13011i`), validar, e em seguida no **ativo** (`GAB13013i`).
    4. Preservar/atualizar os arquivos de configuração (`conf.ini`, `CONFIG`,
       listas negras) conforme a página **Configuração**.
