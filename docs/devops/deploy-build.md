# Deploy e Build

Esta página descreve como compilar, versionar, implantar e executar a suíte
**Sincronizadores GAB** — as quatro aplicações console .NET 8.0 que sincronizam
usuários e grupos entre Active Directory, SAP, Metadados, Azure AD e o sistema de
chamados BDesk.

!!! info "Plataforma de execução"
    Todas as aplicações são **Windows-only** e executadas por linha de comando via
    **Windows Task Scheduler** (não há hospedagem em IIS). As dependências COM
    (ADODB) e `System.DirectoryServices` exigem ambiente Windows tanto em build de
    produção quanto em runtime.

## Build

### Configurações de compilação

A solução `src/Sincronizadores.sln` define três configurações:

| Configuração          | Plataforma | Observação                          |
|-----------------------|------------|-------------------------------------|
| `Debug`               | Any CPU    | Build de desenvolvimento            |
| `Release`             | Any CPU    | Build otimizado                     |
| `Homologacao`         | Any CPU    | **Alias de `Release`** (homologação)|

Os arquivos `.csproj` são **SDK-style** com `GenerateAssemblyInfo=false` — ou seja,
os metadados do assembly são declarados manualmente em `PropertyGroup` dentro do
próprio `.csproj`, em vez de gerados automaticamente.

### Comando de build

```bash
dotnet build src/Sincronizadores.sln -c Debug
dotnet build src/Sincronizadores.sln -c Release
dotnet build src/Sincronizadores.sln -c Homologacao
```

### CAVEAT — referência COM e o erro MSB4803

As aplicações que dependem de COM interop (ADODB) — **SincronizadorSAP** e
**SincronizadorFerias** — têm comportamento de build sensível ao ambiente:

| Ambiente                              | Resultado                                       |
|---------------------------------------|-------------------------------------------------|
| **Windows + Visual Studio MSBuild**   | A referência COM resolve corretamente ✓         |
| **Linux/WSL + `dotnet build`**        | **ERRO FATAL MSB4803** — a referência COM falha |

No Linux/WSL o código C# até compila, mas a resolução da referência COM falha com
`MSB4803`, porque o `dotnet build` não dispõe da tarefa MSBuild que processa
referências COM.

!!! warning "Builds de produção em Windows"
    Builds de produção de **SincronizadorSAP** e **SincronizadorFerias** **DEVEM**
    ocorrer em **Windows com o MSBuild do Visual Studio**. Não use `dotnet build`
    em Linux/WSL para gerar artefatos de produção desses dois aplicativos.

!!! note "Frameworks-alvo"
    Os sincronizadores têm `TargetFramework` `net8.0-windows8.0`; a biblioteca
    compartilhada `Atendame.Core` é `net8.0` puro (portável). As referências COM
    (ADODB) usam `EmbedInteropTypes=true`, e `System.DirectoryServices 8.0.0` é
    usado em AD, Férias e Grupos.

## Geração de versão

A versão do build é injetada por um script batch do Windows:

- **Script:** `tools/RegistrarRevisaoEmResources.bat`
- **Saída:** sobrescreve `src\Atendame.Core\Versao.cs`, gerando a classe
  `Atendame.Core.Versao` com:

```csharp
namespace Atendame.Core
{
    public class Versao
    {
        public const string Release = "%1";
    }
}
```

O valor `%1` é o argumento passado ao script (a revisão/release).

- **Placeholder de desenvolvimento:** quando a versão não foi registrada, o valor é
  `(em desenvolvimento)`.
- **Consumo da versão:**
    - via token `%VERSAO%` nos templates JSON de requisição do BDesk;
    - no **watermark de férias** gravado em `streetAddress` pelo SincronizadorFerias
      (formato `SincronizadorFerias {version}:CheckedOut:...`, onde `{version}` vem
      de `Versao.Release`).

## Runtime e execução

A execução é sempre por **CLI agendada no Windows Task Scheduler**. Na primeira
execução, cada aplicação cria automaticamente um conjunto de diretórios de runtime,
**relativos ao executável**.

### Diretórios de runtime

| Diretório                       | Finalidade                                                                 |
|---------------------------------|---------------------------------------------------------------------------|
| `LocalData/`                    | Deduplicação SAP — registros diários em `yyyyMMdd.json`                    |
| `LocalData-modo-consultar/`     | Versão dry-run de `LocalData/`, usada apenas com `-consultar`              |
| `FILA/{url_underscored}/`       | Write-ahead das requisições BDesk a submeter (URL com `_` no lugar de `/`) |
| `FILA-MODO-CONSULTA/`           | Fila de dry-run (`-consultar`); **nunca submete** ao BDesk                 |
| `ENVIADOS/`                     | Requisições já confirmadas no BDesk                                        |
| `Log/`                          | Arquivo de trace por execução                                             |

O arquivo de trace segue o padrão (relativo ao exe):

```text
../Log/{ExeName}/{Action}/{ExeName}-{action}-{timestamp}.log
```

!!! note "A confirmar — caminho de logs em produção"
    O padrão acima foi derivado da documentação do projeto, mas o **caminho exato
    dos logs nos servidores de produção** não foi validado nos hosts.

### Modos de linha de comando (comuns a todos os apps)

| Modo                    | Comportamento                                                                                   |
|-------------------------|-------------------------------------------------------------------------------------------------|
| `-executar`             | **Modo escrita**: aplica `CommitChanges` no AD, faz `POST` no BDesk e escreve em `FILA/`        |
| `-consultar`            | **Dry-run read-only**: usa `FILA-MODO-CONSULTA/` e `LocalData-modo-consultar/`, sem mutação      |
| `-criptografar <valor>` | Utilitário de credenciais — criptografa um valor via XOR e imprime no stdout                    |
| `-before <bat>`         | Hook de pré-execução — executa um script batch antes do processamento                            |
| `-acao <nome>`          | Roteia para uma ação específica (ver abaixo)                                                     |

Ações roteadas por `-acao`:

- **SincronizadorSAP:** `monitorar_quarentena`, `expirar_quarentena`.
- **SincronizadorAD:** 10 ações (`inserir`, `atualizar`, `manutencao`, `quarentena`,
  `retornar_quarentena`, `azure`, `marcar_pendente`, `marcar_pendente_cpf`,
  `excluir`, `excluir_cpf`).

!!! danger "Dry-run não é totalmente seguro no SincronizadorGrupos"
    Existe um **bug** no SincronizadorGrupos: quando `NomeEmpresa` está configurado
    no `config.txt` da OU, o **rename do CN** do objeto é executado **mesmo em modo
    `-consultar`**, pois a chamada `userEntry.Rename(...)` não está protegida por uma
    guarda `if(!ModoConsultar)`.

    Referência: `src/SincronizadorGrupos/ExecutorSincronizadorGrupos.cs:548-550`. Em
    contraste, as demais alterações de campo desse mesmo executor respeitam o modo
    de consulta. **Portanto, o dry-run do SincronizadorGrupos não é totalmente seguro
    até a correção** — o rename de CN ocorre no Active Directory mesmo numa simulação.

## Limites de lote (segurança operacional)

Para limitar o *blast radius* de cada execução, há limites de lote configuráveis. O
objetivo é evitar que um defeito ou dado anômalo propague mutações em massa.

| Limite                                | App        | Default / Configuração                                                            |
|---------------------------------------|------------|-----------------------------------------------------------------------------------|
| `QuantidadeMaximaDeInsercoes`         | SAP        | `0` = sem limite; configurável em `conf.ini` seção `[BDesk]`                       |
| `QuantidadeMaximaDeAtualizacoes`      | SAP        | `0` = sem limite; configurável em `conf.ini` seção `[BDesk]`                       |
| `QuantidadeMaximaDeExclusoes`         | SAP        | `0` = sem limite; configurável em `conf.ini` seção `[BDesk]`                       |
| `MaximoAlteracoesPorExecucao`         | Grupos     | Sem default explícito no código                                                   |
| `DiasDeEsperaPorExclusoes`            | AD / SAP   | Default `7`; o exemplo `EXEMPLOS/SECRETOS/conf.ini` sobrescreve para `14`          |
| `QuantidadeMaximaDeAtualizacoes`      | Férias     | Sem default explícito documentado no código                                       |

!!! tip "Comportamento ao atingir o teto (Grupos)"
    No SincronizadorGrupos, quando `MaximoAlteracoesPorExecucao` é atingido, o bot
    **para de aplicar modificações no AD** mas **continua o logging para auditoria** —
    ou seja, o teto limita a mutação, não o rastreamento.

## A confirmar

Itens cujo valor exato não pôde ser determinado apenas pelo código e que devem ser
validados contra o ambiente de produção:

- **Caminho exato dos logs em produção** (o padrão `../Log/{ExeName}/{Action}/...`
  foi derivado, mas não validado nos hosts).
- **Default de `MaximoAlteracoesPorExecucao`** (SincronizadorGrupos) — sem default
  explícito no código.
- **Default de `QuantidadeMaximaDeAtualizacoes`** (SincronizadorFerias) — sem default
  documentado no código.
