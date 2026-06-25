# Agendamento e Operação

Esta página descreve **como** os Sincronizadores GAB são disparados em produção e **quando** cada executável roda ao longo do dia. A lógica de negócio de cada ação está documentada em [Ciclo de Vida da Quarentena](../negocio/ciclo-vida-quarentena.md); aqui o foco é a orquestração temporal e a operação.

!!! info "Onde vivem os horários"
    **Não há agendamento fixo em código.** Nenhum dos quatro executáveis (`SincronizadorAD.exe`, `SincronizadorSAP.exe`, `SincronizadorFerias.exe`, `SincronizadorGrupos.exe`) contém um relógio interno ou cron embutido. Todos os horários vivem na configuração do **Windows Task Scheduler** do servidor, que **não é versionada** neste repositório. Os executáveis apenas recebem `-executar`/`-consultar` e, quando aplicável, `-acao <nome>` na linha de comando; a decisão de "quando rodar" é externa.

## Ciclo diário confirmado em produção

O ciclo abaixo foi confirmado no servidor **GAB13013i** (servidor ativo), com referência de execução em **08/02/2026**. Ele encadeia a passada principal do SAP de madrugada com a automação de quarentena entre 06:00 e 07:00, atravessando dois executáveis (`SincronizadorSAP.exe` abre requisições no BDesk; `SincronizadorAD.exe` as processa contra o Active Directory).

| Horário | Comando | O que faz |
|---|---|---|
| **03:00** | `SincronizadorSAP.exe` | **Passada principal.** Merge de SAP + Metadados + AD. Produz lotes de Novos / Alterados / Excluídos e abre requisições BDesk de inserção, atualização e exclusão. |
| **06:00** | `SincronizadorSAP.exe -acao monitorar_quarentena` | Varredura LDAP _subtree_ da OU de quarentena (`PageSize` 1000). Detecta `lastLogonTimestamp` posterior ao timestamp de entrada em quarentena → abre **requisição de retorno** no BDesk. |
| **06:15** | `SincronizadorSAP.exe -acao expirar_quarentena` | Varredura LDAP _subtree_. Detecta usuários com **30+ dias** em quarentena **sem login posterior** → abre **requisição de exclusão** no BDesk. |
| **06:30** | `SincronizadorAD.exe -executar -acao retornar_quarentena` | Processa as requisições de retorno abertas. Lê o `extensionAttribute` (`msDS-cloudExtensionAttribute1`), executa `MoveTo(ouOriginal)` e limpa os metadados. Aplica intervalo mínimo de **12 h** entre reprocessamentos **quando o `extensionAttribute` está vazio**. |
| **07:00** | `SincronizadorAD.exe -executar -acao excluir` | Processa as requisições de exclusão abertas. Verifica recontratação em SAP/Metadados e, se confirmada a exclusão, envia a conta para a Lixeira do AD. |

!!! note "A ordem é garantida apenas pelo espaçamento no Task Scheduler"
    A garantia de que o **monitoramento** (06:00) executa **antes** da **expiração** (06:15) é fornecida **exclusivamente pelo espaçamento de 15 minutos no Windows Task Scheduler** — não existe qualquer mecanismo de sincronização, _lock_, fila de barreira ou dependência declarada em código entre `AcaoMonitorarQuarentena` e `AcaoExpirarQuarentena`. Em `ExecutorSincronizadorSAP.Executar()` cada ação é roteada para uma execução independente do processo. Se os horários do Task Scheduler forem alterados de forma que a expiração rode antes ou simultaneamente ao monitoramento, um usuário que logou após a quarentena poderia, em tese, ser expirado antes de o retorno ser detectado. Mantenha o espaçamento ao reagendar.

!!! warning "Agendamento de Férias e Grupos não confirmado"
    O agendamento de **`SincronizadorFerias.exe`** e **`SincronizadorGrupos.exe`** **não está documentado em código** e não aparece no ciclo confirmado acima. Os horários devem ser confirmados diretamente com a operação / configuração do Task Scheduler nos servidores. Não assuma horários para esses dois executáveis.

## Limiares e seus defaults

Os limiares abaixo controlam quando cada ação atua. A coluna "Origem do default" indica se o valor padrão vem do **código** (assumido quando a chave está ausente) ou se é **obrigatório no `config.json`/`conf.ini`** (sem fallback — a ausência quebra a execução).

| Limiar | Valor de referência | Origem do default | Onde |
|---|---|---|---|
| `DiasInatividade` | **90** | **Obrigatório em `config.json`** — sem default no código (lido via `ToObject<int>()` sem fallback). | Passada principal — `ExecutorSincronizadorSAP.cs:1221` |
| `DiasParaExpiracao` | **30** | **Default em código** (`?? 30`). Configurável em `config.json`. | `AcaoSincronizadorSAP.cs:135` |
| `MaximoAbertura` | **2** (exemplo) | **Obrigatório em `config.json`** (`ActiveDirectory.Quarentena.MaximoAbertura`). Limita aberturas de quarentena por execução via `.Take()`. | `ExecutorSincronizadorSAP.cs` (`ProcessarUsuariosParaQuarentena`) |
| `DiasDeEsperaPorExclusoes` | **7** | **Default em código** (`?.OuDefault("7")`). Sobrescrito para **14** nos `EXEMPLOS/SECRETOS`. Controla a janela de deduplicação de exclusões em `LocalData/yyyyMMdd.json`. | seção `[BDesk]` do `conf.ini` |
| `QuantidadeMaximaDeInsercoes` / `Atualizacoes` / `Exclusoes` | **0** | **Sem limite** quando `0`. Overridável na seção `[BDesk]` do `conf.ini`. | Lotes de Novos / Alterados / Excluídos |
| `MaximoAlteracoesPorExecucao` | — | **Sem default no código** (lido da config sem fallback visível). | `SincronizadorGrupos`, seção `[Geral]` |

!!! tip "Defaults de código vs. obrigatórios"
    Quando o valor é **default em código**, omitir a chave na configuração é seguro — o sistema assume o padrão. Quando é **obrigatório**, omitir a chave provoca falha de validação (`DiasInatividade`, `MaximoAbertura`) ou comportamento indefinido. Trate `DiasInatividade` e `MaximoAbertura` como campos que devem sempre constar no `config.json`.

## Resiliência operacional

### Fila `FILA/` para requisições BDesk (two-phase commit)

As requisições destinadas ao BDesk não são enviadas diretamente: são primeiro gravadas como JSON em `FILA/` e depois processadas por `ProcessarFilaRequisicoesPendentes()`, que faz o **POST de abertura**, **move o arquivo para `ENVIADOS/`** e então executa o POST de encerramento/ação. Esse padrão **two-phase commit** garante que, se o processo morrer no meio do envio, a requisição não fica perdida nem é duplicada — o arquivo permanece em `FILA/` até ser comprovadamente enviado.

Em **dry-run** (`-consultar` / `BDesk.Executar != "true"`), as requisições são escritas em **`FILA-MODO-CONSULTA/`** e **nunca submetidas** ao BDesk.

### Reexecução agendada para retry de falhas transitórias

Não há _retry loop_ síncrono dentro de uma única execução para a maioria das falhas. A estratégia de resiliência é a **reexecução agendada**: requisições que não puderam ser concluídas são marcadas como **`Aguardando`** (em vez de `Insucesso`) e simplesmente reprocessadas na próxima passada agendada. Exemplos:

- **Retorno de quarentena** com `extensionAttribute` ainda vazio: aguarda **12 h** (`IntervaloMinimoEntreExecucoes = TimeSpan.FromHours(12)`) entre tentativas antes de marcar insucesso definitivo — dando tempo para a propagação do atributo no AD (`ExecutorRetornarQuarentena.cs:37-41`).
- **Exclusão** cuja "Data da exclusão efetiva" ainda não chegou: marcada `Aguardando` e revisitada na próxima execução (`ExecutorExclusao.cs`, `PodeExcluir()`).
- **Azure** quando o usuário ainda não apareceu no Microsoft Graph: marcada `Aguardando` enquanto a requisição for mais nova que `TempoEsperaEmHoras`.

### Modos `-executar` vs. `-consultar`

| Modo | Efeito |
|---|---|
| `-executar` | Aplica as mutações reais (AD `CommitChanges`/`MoveTo`, envio de requisições BDesk a partir de `FILA/`). |
| `-consultar` | _Dry-run_: escreve em `FILA-MODO-CONSULTA/` e não submete requisições. **Ver alerta abaixo sobre `SincronizadorGrupos`.** |

## Comportamento que exige atenção operacional

### Retorno de quarentena NÃO reativa a conta

`ExecutorRetornarQuarentena` apenas move o usuário de volta para a OU original e limpa os metadados (`extensionAttribute` e `info`). Ele **não modifica `userAccountControl`** — confirmado em `ExecutorRetornarQuarentena.cs` (a sequência é `MoveTo` + `CommitChanges` + `Clear()`, sem qualquer operação sobre a flag de conta). Como a conta foi **desabilitada** ao entrar em quarentena (`userAccountControl |= ADS_UF_ACCOUNTDISABLE` em `ExecutorQuarentena`), ela **permanece desabilitada após o retorno**.

!!! warning "Reabilitação requer manutenção posterior"
    Um usuário "retornado" da quarentena volta para a OU certa, mas **continua sem acesso** (conta desabilitada). A reabilitação efetiva depende de uma ação posterior — por exemplo, a ação `manutencao` do `SincronizadorAD`, que limpa `ADS_UF_ACCOUNTDISABLE`. Operacionalmente, não trate "retorno de quarentena concluído" como "acesso restaurado".

### BUG: Rename de CN ocorre também em `-consultar`

No `SincronizadorGrupos`, quando o `config.txt` da OU define `NomeEmpresa`, o `displayName` recebe o sufixo `({NomeEmpresa})` e o CN é renomeado para refletir o novo `displayName`. A chamada de `Rename` **não está protegida por `ModoConsultar`**:

```csharp
// ExecutorSincronizadorGrupos.cs:548-550
if (!displayName_Novo.Equals(userEntry.Properties["cn"].Value))
{
    userEntry.Rename("CN=" + displayName_Novo); // executa mesmo em -consultar
}
```

Diferente das demais mutações desse executável (alteração de `Properties` e `CommitChanges()`, ambas guardadas por `if (ModoConsultar)`), o `Rename` aplica a mudança **imediatamente no AD** (não depende de `CommitChanges`).

!!! danger "Dry-run não é totalmente seguro no SincronizadorGrupos"
    Rodar `SincronizadorGrupos.exe -consultar` **pode renomear CNs reais no Active Directory** quando há `NomeEmpresa` configurado para a OU e o `displayName` calculado diverge do CN atual. Não confie no modo `-consultar` desse executável como um _dry-run_ completo. Demais campos de perfil e operações de grupo respeitam `ModoConsultar`; apenas o `Rename` de CN não.

## Referências de lógica de negócio

Para a regra de negócio detalhada de cada ação de quarentena (detecção de login pós-quarentena, contagem de dias corridos, validação de OU original, listas de exceção, etc.), consulte a página de [Ciclo de Vida da Quarentena](../negocio/ciclo-vida-quarentena.md). Esta página de DevOps cobre apenas a orquestração temporal e a operação.
