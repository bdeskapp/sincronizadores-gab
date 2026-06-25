# Agendamento e Operacao

Esta pagina documenta o **agendamento operacional** da suite Sincronizadores GAB, executada via **Windows Task Scheduler** nos servidores GAB13013i (ativo) e GAB13011i (standby), a partir de `F:\BusinessDesk\ASK\`.

A suite nao possui orquestrador interno: cada execucao e uma chamada independente de um executavel console (`SincronizadorSAP.exe`, `SincronizadorAD.exe`, etc.), agendada externamente. A ordem e os horarios formam um **fluxo cross-projeto** que precisa ser respeitado pelo agendador para que o ciclo de quarentena funcione corretamente.

!!! warning "Distincao entre CONFIRMADO e A CONFIRMAR"
    Apenas o horario das **03:00** (main pass do `SincronizadorSAP`) esta confirmado em documentacao operacional (`instrucoes-configuracao/instrucoes.txt:4`). Os horarios do ciclo de quarentena (06:00 / 06:15 / 06:30 / 07:00) vem de `agendamento-operacao.md` secao 2.2 e **ainda precisam ser conferidos contra a producao real**. Os parametros temporais (intervalos, dias, defaults) marcados como CONFIRMADO foram validados diretamente no codigo-fonte e estao com as referencias de arquivo/linha.

---

## Tabela de tarefas agendadas

| Horario | Tarefa | Comando | Acao no fluxo | Status |
|---------|--------|---------|---------------|--------|
| **03:00** | Main pass SAP | `SincronizadorSAP.exe` | Merge SAP + Metadados + AD; abre Novos/Alterados/Excluidos e candidatos a quarentena no BDesk | **CONFIRMADO** (`src/SincronizadorSAP/CLAUDE.md:303`; `instrucoes-configuracao/instrucoes.txt:4`) |
| **06:00** | Monitorar quarentena | `SincronizadorSAP.exe -acao monitorar_quarentena` | Detecta login pos-quarentena (`lastLogonTimestamp > timestamp`) e abre `retornar-quarentena.json` | A CONFIRMAR (horario) |
| **06:15** | Expirar quarentena | `SincronizadorSAP.exe -acao expirar_quarentena` | Detecta inatividade >= `DiasParaExpiracao` (30) sem login posterior e abre `excluir-definitivo.json` | A CONFIRMAR (horario) |
| **06:30** | Retornar quarentena | `SincronizadorAD.exe -executar -acao retornar_quarentena` | Move usuario de volta da OU mensal para a OU original | A CONFIRMAR (horario) |
| **07:00** | Excluir | `SincronizadorAD.exe -executar -acao excluir` | Deleta contas expiradas (com verificacao de recontratacao) | A CONFIRMAR (horario) |

!!! note "Ordem obrigatoria do ciclo de quarentena"
    `monitorar_quarentena` (06:00) deve rodar **antes** de `expirar_quarentena` (06:15) para capturar usuarios que logaram "de ultima hora". A implementacao assume essa sequencia: `AcaoExpirarQuarentena` ignora usuarios cujo `lastLogonTimestamp` e posterior ao timestamp de quarentena, presumindo que o monitoramento ja atuou. A ordem **nao e forcada internamente** — depende exclusivamente do agendador externo. Veja o detalhamento em [Ciclo de Vida da Quarentena](../negocio/ciclo-vida-quarentena.md).

---

## Parametros temporais confirmados em codigo

Os seguintes parametros foram verificados diretamente no codigo-fonte e governam o comportamento temporal do ciclo:

| Parametro | Valor | Origem | Observacao |
|-----------|-------|--------|------------|
| Intervalo minimo de retorno de quarentena | **12 horas** | `ExecutorRetornarQuarentena.cs:15` (`TimeSpan.FromHours(12)`) | Quando `ExtensionAttributeOuOriginal` esta vazio, aguarda 12h antes de marcar insucesso (evita corrida com `ExecutorQuarentena`) |
| Dias padrao de exclusao por inatividade (SAP) | **7 dias** | `ExecutorSincronizadorSAP.cs:541` (default code) | Janela de deduplicacao de exclusoes; exemplo `SECRETOS` sobrescreve para **14** via `DiasDeEsperaPorExclusoes` |
| `DiasParaExpiracao` | **30 dias** | `AcaoSincronizadorSAP.cs:135` (default code) | Configuravel via `config.json` `[ActiveDirectory][Quarentena][DiasParaExpiracao]` |

!!! tip "Como o codigo le esses valores"
    `ObterDiasParaExpiracao()` (`AcaoSincronizadorSAP.cs:132-136`) retorna o valor de `config.json[ActiveDirectory][Quarentena][DiasParaExpiracao]` ou, na ausencia, o default `30`. O intervalo de 12 horas e uma constante estatica nao configuravel.

---

## Parametros de `config.json` `[ActiveDirectory][Quarentena]`

A secao de quarentena controla a abertura de requisicoes no main pass e o ciclo de expiracao. Campos sem default sao **obrigatorios** e a ausencia provoca erro de leitura (lidos via `ToObject<int>()` no main pass).

| Parametro | Obrigatorio | Default | Exemplo (`RODAVEIS/config.json`) | Funcao |
|-----------|-------------|---------|----------------------------------|--------|
| `OuDestino` | **Sim** | _(nenhum)_ | `OU=Quarentena` | OU raiz de quarentena; sob ela sao criadas as OUs mensais `5S-{MM-yyyy}` |
| `DiasInatividade` | **Sim** | _(nenhum)_ | `90` | Limiar de inatividade (`lastLogonTimestamp`) para candidatar a quarentena |
| `MaximoAbertura` | **Sim** | _(nenhum)_ | `2` | Maximo de requisicoes de quarentena abertas por execucao (limita blast radius) |
| `DiasParaExpiracao` | Nao | `30` | `30` | Dias em quarentena, sem login posterior, ate exclusao definitiva |
| `ExtensionAttributeOuOriginal` | Nao | `msDS-cloudExtensionAttribute1` | `msDS-cloudExtensionAttribute1` | Atributo AD onde a OU original e salva antes do move (confirmado `ExecutorSincronizadorAd.cs:37`) |

!!! note
    `DiasInatividade` e `MaximoAbertura` nao tem default no codigo e sao lidos via `ToObject<int>()` no main pass — um valor ausente provoca falha de leitura da configuracao. O exemplo de producao usa `DiasInatividade=90` e `MaximoAbertura=2`.

---

## A confirmar contra producao

!!! warning "Pendencias de validacao operacional"
    Os itens abaixo nao puderam ser confirmados a partir do codigo ou da documentacao versionada e dependem de inspecao das tarefas reais no Windows Task Scheduler dos servidores GAB13013i / GAB13011i.

    - **Horarios completos do ciclo de quarentena** — 06:00 / 06:15 / 06:30 / 07:00 vem de `agendamento-operacao.md` secao 2.2. Apenas o horario das **03:00** esta confirmado em `instrucoes.txt`.
    - **Agendamento de `SincronizadorFerias`** — frequencia e horario nao evidenciados em codigo nem documentacao.
    - **Agendamento de `SincronizadorGrupos`** — frequencia e horario nao evidenciados em codigo nem documentacao.

---

## Risco operacional

!!! danger "Falha silenciosa na verificacao de recontratacao pode deletar conta AD ativa"
    A acao de exclusao (`07:00`, `SincronizadorAD.exe -executar -acao excluir`) executa uma verificacao de recontratacao antes de deletar a conta. Essa verificacao consulta duas fontes por CPF: **Metadados (HTTP)** e, em seguida, **SAP (SOAP)**, no metodo `VerificarRecontratacao()` de `ExecutorExclusao.cs` (linhas 308-319).

    O metodo `VerificarRecontratacaoSAP` (linhas 308-319) realiza a consulta sem tratamento de erro visivel. Se o `WebClient` falhar (timeout, indisponibilidade do servico, erro de rede), o retorno e interpretado como `false` = **"nao encontrado"** = **nao recontratado**, o que **libera a delecao de uma conta AD que poderia estar ativa** (referencia: `agendamento-operacao.md` secao 8.1).

    **Mitigacao operacional:** garantir disponibilidade de SAP e Metadados durante a janela das 07:00, e monitorar os logs de exclusao (`Log/SincronizadorAD/excluir/`) para falhas de consulta antes de assumir que as exclusoes do dia foram seguras.

!!! note "Guarda-corpos relacionados (contexto)"
    - A verificacao de recontratacao **so se aplica a exclusao por login** (`ExecutorExclusaoPorLogin`). A exclusao por CPF (`ExecutorExclusaoPorCPF`) pula essa verificacao por design (`ExecutorExclusao.cs:300-304`).
    - Usuarios que ja estao em quarentena tambem nao passam pela verificacao de recontratacao — o fluxo de exclusao segue normalmente (`ExecutorExclusao.cs:290-298`).
    - A exclusao so executa para contas **inativas** (`userAccountControl & ADS_UF_ACCOUNTDISABLE`); contas ativas retornam erro sem deletar (`ExecutorExclusao.cs:114-133`).

---

## Referencias cruzadas

- [Ciclo de Vida da Quarentena](../negocio/ciclo-vida-quarentena.md) — detalhamento de negocio do fluxo cross-projeto (entrada, monitoramento, retorno e expiracao), incluindo a regra de ordem `monitorar_quarentena` antes de `expirar_quarentena`.
