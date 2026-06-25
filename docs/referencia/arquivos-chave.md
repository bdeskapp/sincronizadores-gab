# Arquivos-Chave

Este é o índice de referência técnica da suíte **Sincronizadores GAB**: um mapa dos
arquivos de código-fonte mais importantes de cada aplicação, com uma frase
descrevendo a responsabilidade de cada um. Use esta página para localizar
rapidamente onde uma regra de negócio ou comportamento está implementado.

!!! warning "A fonte de verdade é o código em `src/`"
    O código C# em `D:/projects/sincronizadoresgab/src` é a **VERDADE**. Os
    documentos em `docs/` e os arquivos `CLAUDE.md` são **insumos** — apoiam o
    entendimento, mas podem estar desatualizados. Sempre que um documento divergir
    do código, **a versão do código vence**.

!!! note "Convenção de caminhos"
    Todos os caminhos são relativos à raiz do repositório
    (`D:/projects/sincronizadoresgab`). Os quatro aplicativos são apps console
    .NET 8.0 (Windows-only, com dependências COM interop ADODB e
    `System.DirectoryServices`).

---

## Sincronizador AD

Aplicação que executa mutações no Active Directory a partir de 10 ações roteadas
por linha de comando (`-acao`), consumindo requisições abertas no BDesk.

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/SincronizadorAd/Program.cs` | Ponto de entrada do executável; faz o roteamento do parâmetro `-acao` para o executor correspondente. |
| `src/SincronizadorAd/ExecutorSincronizadorAd.cs` | Executor principal e contexto compartilhado das ações; contém `GerarSenhaAleatoria` (senha forte com mínimo 8 caracteres, garantindo minúscula/maiúscula/número/especial via secure random) e os defaults de quarentena (ex.: `ExtensionAttributeOuOriginal = "msDS-cloudExtensionAttribute1"`). |
| `src/SincronizadorAd/Executores/ExecutorAuxiliarBase.cs` | Classe base das 10 ações; expõe a busca de usuários no AD via `ObterUnicoUsuarioAD`/`ObterUsuarioAD` e o controle de status de conta (`userAccountControl`). |
| `src/SincronizadorAd/Executores/ExecutorInsercao.cs` | Criação de conta: geração de login por algoritmo de 8 tentativas, prefixo `ps.` para prestadores de serviço, cap de 90 dias a partir da data de abertura e disparo condicional dos desdobramentos. |
| `src/SincronizadorAd/Executores/ExecutorExclusao.cs` | Exclusão de contas por login ou CPF; guarda-corpo `PodeExcluir` (só exclui após a "Data da exclusão efetiva"), verificação de recontratação (apenas na exclusão por login) e exigência de conta inativa. |
| `src/SincronizadorAd/Executores/ExecutorQuarentena.cs` | Entrada em quarentena via `MoverParaQuarentena`: salva a OU original, move para a OU mensal `5S-{MM-yyyy}`, grava timestamp em `info` e desabilita a conta. |
| `src/SincronizadorAd/Executores/ExecutorRetornarQuarentena.cs` | Retorno de quarentena: move o usuário de volta à OU original e limpa metadados, com intervalo mínimo de 12 horas; **não** reabilita a conta. |
| `src/SincronizadorAd/Executores/ExecutorManutencao.cs` | Atualização de dados/senha: gera senha aleatória, busca a requisição de exclusão correspondente em 4 filtros e posta a ação na requisição de exclusão encontrada. |
| `src/SincronizadorAd/Executores/ExecutorAzure.cs` | Registro de MFA no Azure AD: obtém a identidade direto da requisição BDesk (sem busca no AD), normaliza o telefone e aguarda a sincronização do usuário no Azure. |

!!! tip "As 10 ações do Sincronizador AD"
    `inserir`, `atualizar`, `manutencao`, `quarentena`, `retornar_quarentena`,
    `azure`, `marcar_pendente`, `marcar_pendente_cpf`, `excluir`, `excluir_cpf` —
    todas herdam de `ExecutorAuxiliarBase`.

**Insumos (podem estar desatualizados):**
`src/SincronizadorAd/CLAUDE.md`, `docs/negocio/sincronizador-ad-regras.md`.

---

## Sincronizador SAP

Passada principal que sincroniza usuários de três origens (SAP HR via SOAP, Metadados
via HTTP e Active Directory via ADODB) produzindo colações de Novos/Alterados/Excluidos
para abertura de requisições no BDesk, além de gerenciar o ciclo de quarentena.

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/SincronizadorSAP/ExecutorSincronizadorSAP.cs` | Orquestra o *main pass*: merge das três fontes, regra nova de exclusão (100% desligados por CPF normalizado), limites de lote por execução e deduplicação por janela de 7 dias (`LocalData/yyyyMMdd.json`). |
| `src/SincronizadorSAP/ServicoSincronizadorSAP.cs` | Serviços de domínio: `DicionarioDeDados`, `CamposAComparar` (apenas DA16/Cargo e DA19/Centro de Custo), `MapearSolicitante` (participante ANTE derivado da última OU do DN) e `Diferentes` (comparação case-insensitive). |
| `src/SincronizadorSAP/Acoes/AcaoSincronizadorSAP.cs` | Base das ações de quarentena; provê `ParseTimestampQuarentena` (parse do prefixo `"Movido para quarentena em "`), `ParseLastLogonTimestamp` e `ObterDiasParaExpiracao` (config ou default 30). |
| `src/SincronizadorSAP/Acoes/AcaoMonitorarQuarentena.cs` | Ação `monitorar_quarentena`: detecta login pós-quarentena (`lastLogonTimestamp > timestamp`) e abre requisição de retorno, com deduplicação via API de requisições abertas. |
| `src/SincronizadorSAP/Acoes/AcaoExpirarQuarentena.cs` | Ação `expirar_quarentena`: detecta inatividade por `DiasParaExpiracao` (30 dias padrão) sem login posterior e abre exclusão definitiva, com deduplicação via API. |

**Insumos (podem estar desatualizados):**
`src/SincronizadorSAP/CLAUDE.md`, `docs/negocio/sincronizador-sap-regras.md`,
`CLAUDE.md` (raiz).

---

## Sincronizador Férias

Automatiza a sincronização de períodos de férias entre SAP, Metadados (HTTP e SQL)
e Active Directory, desabilitando contas via `accountExpires` e mantendo um
*watermark* `:CheckedOut:` no campo `streetAddress`.

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/SincronizadorFerias/ExecutorSincronizadorFerias.cs` | Núcleo do app: merge das 3 fontes por `CPF.SomenteDigitos()`, comparação L1 (novas entradas) / L2 (retornos/atualizações), ordenação com *nulls first* (retornos antes de entradas), *watermark*, truncamento de `streetAddress` a 1020 caracteres e limite de lote pós-ordenação. |
| `src/SincronizadorFerias/ServicoSincronizadorFerias.cs` | Montagem dos usuários a partir das fontes e a consulta SQL que injeta as datas de férias dos usuários de Metadados (HTTP) por CPF. |
| `src/SincronizadorFerias/Model/UsuarioOrigem.cs` | Modelo do usuário vindo das fontes de origem (SAP/Metadados), incluindo `DataDeExpiracaoDaConta`. |
| `src/SincronizadorFerias/Model/UsuarioAD.cs` | Modelo do usuário lido do Active Directory (estado atual de `accountExpires`, `streetAddress`/`LogAlteracao`, cargo). |
| `src/SincronizadorFerias/Model/UsuarioJoin.cs` | Modelo do par correlacionado origem × AD (`UsuarioOrigem` + `UsuarioAD`) usado nas comparações L1/L2. |

!!! note "Regra-chave de decisão"
    `DataDeExpiracaoDaConta = InicioFerias` **somente se** `FinalFerias > DateTime.Now.Date`.
    Quando as férias terminam, o valor vira `null` → dispara o caminho de retorno
    (e `accountExpires` recebe `"0"` / *never expires*).

**Insumos (podem estar desatualizados):** `src/SincronizadorFerias/CLAUDE.md`.

---

## Sincronizador Grupos

Audita e sincroniza a associação de usuários a grupos de AD e campos de perfil,
organizados em árvore hierárquica de OUs com configuração descentralizada por
`config.txt`.

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/SincronizadorGrupos/ExecutorSincronizadorGrupos.cs` | Núcleo do app: teto de alterações por execução (`MaximoAlteracoesPorExecucao`), backup integral pré-execução, busca LDAP `SearchScope.OneLevel`, sufixo/rename de CN via `NomeEmpresa`, adição-apenas a grupos (remoção encapsulada em `if(false)`) e sumário CSV por execução. |
| `src/SincronizadorGrupos/Program.cs` | Ponto de entrada do executável e parsing dos parâmetros de linha de comando (`-executar`/`-consultar`). |

!!! warning "Remoção de grupos desabilitada e rename em dry-run"
    O bot **nunca remove** usuários de grupos (o bloco `REMOVE` está em `if(false)`),
    apenas adiciona. Há ainda uma divergência conhecida: o `Rename` de CN executa
    mesmo em modo `-consultar` (dry-run), sem a proteção `if(!ModoConsultar)` usada
    nos demais campos — comportamento registrado como bug.

**Insumos (podem estar desatualizados):**
`src/SincronizadorGrupos/CLAUDE.md`, `docs/negocio/sincronizador-grupos-regras.md`,
`CLAUDE.md` (raiz).

---

## Componentes comuns (Cross-Cutting / Atendame.Core)

Bibliotecas compartilhadas entre os quatro aplicativos.

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/Atendame.Core/Versao.cs` | Define a constante `Release` (placeholder `"(em desenvolvimento)"`), consumida pelo token `%VERSAO%` nos templates BDesk e no *watermark* de férias. |
| `src/Cross-Cutting/Security/Cryptography.cs` | Criptografia XOR de credenciais (chaves fixas `EncKey=161`, `EncC1=109`, `EncC2=191`); usada pelo utilitário CLI `-criptografar`. |
| `src/Cross-Cutting/GerenciadorVersao.cs` | Carrega as *feature flags* (`BooleanosVersao`) a partir de `funcionalidades.txt` (localizado via variável de ambiente `%BUSINESS_DESK%`). |

!!! warning "Discrepância de caminho — briefing × código"
    O briefing indicava `src/Atendame.Core/Cryptography.cs` e
    `src/Atendame.Core/GerenciadorVersao.cs`. Na verdade, no código esses arquivos
    estão em **`src/Cross-Cutting/Security/Cryptography.cs`** e
    **`src/Cross-Cutting/GerenciadorVersao.cs`**. Apenas `Versao.cs` reside em
    `src/Atendame.Core/`. Como o código é a fonte de verdade, prevalecem os
    caminhos de `Cross-Cutting`.

---

## Exemplos de configuração

Modelos de referência (INI + JSON) para configurar cada aplicação. Servem de ponto
de partida — os valores em produção são definidos por servidor.

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/SincronizadorSAP/EXEMPLOS/SECRETOS/conf.ini` | Exemplo de `conf.ini` do Sincronizador SAP: seções `[SAP]`, `[Metadados]`, `[ActiveDirectory]` e `[BDesk]`, com credenciais criptografadas (placeholder), IDs de atividades e limites de lote. |
| `src/SincronizadorSAP/EXEMPLOS/RODAVEIS/config.json` | Exemplo de `config.json` *rodável* do SAP: bloco `[ActiveDirectory][Quarentena]` com `OuDestino`, `DiasInatividade` (ex.: 90), `MaximoAbertura` (ex.: 2) e `ExtensionAttributeOuOriginal`. |
| `src/SincronizadorAd/EXEMPLOS/CONFIG/config.json` | Exemplo de `config.json` do Sincronizador AD: parâmetros de quarentena e do Azure MFA (`TempoEsperaEmHoras`) usados pelas 10 ações. |
| `src/SincronizadorGrupos/instrucoes-configuracao/EXEMPLOS/conf.ini` | Exemplo de `conf.ini` do Sincronizador Grupos, modelo de configuração geral do app. |

!!! tip "Mais exemplos disponíveis"
    Há ainda 43 templates de ação em `src/SincronizadorAd/EXEMPLOS/CONFIG/`
    (cobrindo todas as 10 ações) e os templates de quarentena do SAP em
    `src/SincronizadorSAP/EXEMPLOS/RODAVEIS/` (ex.: `retornar-quarentena.json`,
    `excluir-definitivo.json`).

---

## Ciclo de vida da quarentena (cross-project)

O ciclo de quarentena é um fluxo que atravessa o Sincronizador SAP (deteta e abre
requisições) e o Sincronizador AD (executa as operações). Os arquivos-chave já
listados acima participam deste fluxo na seguinte ordem:

1. **`ExecutorQuarentena.cs`** (AD, `-acao quarentena`) — entrada em quarentena.
2. **`AcaoMonitorarQuarentena.cs`** (SAP, `-acao monitorar_quarentena`) — deteta login pós-quarentena e abre requisição de retorno.
3. **`AcaoExpirarQuarentena.cs`** (SAP, `-acao expirar_quarentena`) — deteta inatividade e abre exclusão definitiva.
4. **`ExecutorRetornarQuarentena.cs`** (AD, `-acao retornar_quarentena`) — move o usuário de volta.
5. **`ExecutorExclusao.cs`** (AD, `-acao excluir`) — exclui contas expiradas.

A base `AcaoSincronizadorSAP.cs` provê o parse do *timestamp* gravado por
`ExecutorQuarentena.cs`, garantindo o acoplamento entre os dois aplicativos.

**Insumos (podem estar desatualizados):**
`docs/business-requirements/sincronizacao-ad-quarentena/prd-automacao-quarentena.md`,
`docs/plans/2026-03-04-quarentena-lifecycle-design.md`.

---

## Documentos de origem (insumos)

Os arquivos abaixo descrevem regras e operação, mas são **insumos** — quando
divergirem do código em `src/`, o código prevalece.

- `docs/negocio/sincronizador-ad-regras.md`
- `docs/negocio/sincronizador-sap-regras.md`
- `docs/negocio/sincronizador-grupos-regras.md`
- `docs/devops/agendamento-operacao.md`
- `docs/devops/configuracao-servidores.md`
- `docs/devops/infraestrutura-deploy.md`
- `docs/business-requirements/sincronizacao-ad-quarentena/prd-automacao-quarentena.md`
- `docs/plans/2026-03-04-quarentena-lifecycle-design.md`
- `CLAUDE.md` (raiz) e os `CLAUDE.md` de cada sub-projeto.
