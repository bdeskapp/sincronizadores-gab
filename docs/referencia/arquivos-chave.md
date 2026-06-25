# Arquivos-Chave

Esta página de referência técnica reúne, de forma consolidada, os **arquivos-chave** de cada sub-projeto dos Sincronizadores GAB e a **lista de discrepâncias** verificadas entre a documentação existente e o código-fonte C#.

!!! info "A verdade está no código"
    Todos os caminhos, classes e métodos citados abaixo refletem o estado do código-fonte em `D:/projects/sincronizadoresgab/src`. Onde a documentação de negócio divergir do código, a versão do **código vence** — essas divergências estão registradas na seção [Discrepâncias documento-vs-código](#discrepancias-documento-vs-codigo).

---

## Mapa de arquivos-chave

### Comum (bibliotecas compartilhadas)

| Arquivo | Propósito |
|---|---|
| `src/Sincronizadores.Lib/ExecutorSincronizador.cs` | Classe base de todos os executores. Define a API pública, a **FILA** persistente de requisições BDesk (commit em duas fases via `FILA/` → `ENVIADOS/`) e os métodos de integração com a API REST do BDesk (abrir requisição, postar ação, desdobrar, buscar requisições abertas). |
| `src/Sincronizadores.Lib/ActiveDirectory.cs` | Constantes de Active Directory. Define `ADS_UF_ACCOUNTDISABLE` (`0x0002`, linha 9) e as demais constantes `ADS_UF_*` usadas nas operações de bit sobre `userAccountControl`. |
| `src/Cross-Cutting/Security/Cryptography.cs` | Criptografia XOR de credenciais. `Decrypt()` usa as chaves fixas 109 (`EncC1`), 191 (`EncC2`) e 161 (`EncKey`). A geração de valores criptografados é feita via `<exe> -criptografar <valor>`. |

### SincronizadorAD

| Arquivo | Propósito |
|---|---|
| `src/SincronizadorAd/Program.cs` | Ponto de entrada. Roteia a execução conforme `-acao` (10 ações). |
| `src/SincronizadorAd/ExecutorSincronizadorAd.cs` | Executor principal. Define `ExtensionAttributeOuOriginal` (padrão `msDS-cloudExtensionAttribute1`, linha 37), `GerarSenhaAleatoria()` (linhas 422-480) e chama `VerificaListasExcecao` em `AlterarConta` (linha 315). |
| `src/SincronizadorAd/Executores/ExecutorAuxiliarBase.cs` | Base dos executores auxiliares. `ObterUnicoUsuarioAD()`, `VerificaListasExcecao()` (login e grupo) e `AtualizarStatusConta()` (remove/aplica o bit `ADS_UF_ACCOUNTDISABLE`, linha 281). |
| `src/SincronizadorAd/Executores/ExecutorInsercao.cs` | Ação `inserir`: geração de login (8 tentativas), senha temporária `@{Letra}{ddMMyyyy}`, cap de 90 dias para prestador (`accountExpires`) e 8 desdobramentos automáticos (SAP, Sistemas, Rede, Internet, Email, VPN, Telefonia, Azure). |
| `src/SincronizadorAd/Executores/ExecutorManutencao.cs` | Ação `manutencao`: reset de senha aleatória + reativação da conta; posta a ação na requisição de **exclusão** correspondente, não na de manutenção. |
| `src/SincronizadorAd/Executores/ExecutorQuarentena.cs` | Ação `quarentena`: salva a OU original no extensionAttribute, move para a OU mensal `5S-{MM-yyyy}`, grava timestamp em `info` e desabilita a conta (`userAccountControl |= ADS_UF_ACCOUNTDISABLE`). |
| `src/SincronizadorAd/Executores/ExecutorRetornarQuarentena.cs` | Ação `retornar_quarentena`: lê a OU original do extensionAttribute, move de volta e limpa metadados. **Nunca** altera `userAccountControl`. Intervalo mínimo de 12h apenas quando o atributo está vazio (linha 15). |
| `src/SincronizadorAd/Executores/ExecutorExclusao.cs` | Ação `excluir` (base): verifica recontratação, exige conta desabilitada, envia para lixeira recursivamente e abre desdobramento com `MemberOf`. |
| `src/SincronizadorAd/Executores/ExecutorExclusaoPorLogin.cs` | Exclusão por login/`sAMAccountName` (com verificação de recontratação). |
| `src/SincronizadorAd/Executores/ExecutorExclusaoPorCPF.cs` | Exclusão por CPF; desabilita a verificação de recontratação via checagem `this is ExecutorExclusaoPorCPF`. |
| `src/SincronizadorAd/Executores/ExecutorAzure.cs` | Ação `azure`: MFA via Microsoft Graph. Não consulta o AD — identidade vem dos campos BDesk (`UserPrincipalName` em "DADOS DO USUÁRIO AZURE"). |
| `src/SincronizadorAd/Executores/ExecutorAtualizacao.cs` | Ação `atualizar`: modifica `title` (Cargo), `department` (Departamento) e `postalCode` (Centro de Custo) por CPF. |
| `src/SincronizadorAd/Executores/ExecutorMarcarPendenteExclusao.cs` | Ações `marcar_pendente` / `marcar_pendente_cpf`: desabilita a conta (`userAccountControl |= ADS_UF_ACCOUNTDISABLE`). |
| `src/SincronizadorAd/ServicoSincronizadorAd.cs` | `ObterUsuarioAD()`: monta o filtro LDAP por login ou CPF conforme a ação. |

### SincronizadorSAP

| Arquivo | Propósito |
|---|---|
| `src/SincronizadorSAP/ExecutorSincronizadorSAP.cs` | Executor principal. Passada principal (merge SAP+Metadados+AD), `Comparar_ViaRegraNova` (CPF excluído só se 100% dos registros estiverem desligados), `Agregar()`, `ObterUsuariosAD()` (query LDAP via ADODB) e `ExecutarQuarentena()`. |
| `src/SincronizadorSAP/ServicoSincronizadorSAP.cs` | Comparação de campos (`Diferentes()`, case-insensitive, só DA16/DA19), `MapearSolicitante()` (última OU não-DC, com fallback) e montagem dos JSONs BDesk. |
| `src/SincronizadorSAP/Acoes/AcaoSincronizadorSAP.cs` | Base das ações de quarentena. `BuscarUsuariosNaQuarentena()` (DirectorySearcher subtree, PageSize 1000), `EstaEmListaExcecao()`, `ParseTimestampQuarentena()` e `JaExisteRequisicaoAberta()`. |
| `src/SincronizadorSAP/Acoes/AcaoMonitorarQuarentena.cs` | Ação `monitorar_quarentena`: detecta login pós-quarentena (`lastLogonTimestamp` > timestamp de entrada) e abre requisição de retorno. |
| `src/SincronizadorSAP/Acoes/AcaoExpirarQuarentena.cs` | Ação `expirar_quarentena`: detecta 30+ dias em quarentena sem login posterior e abre requisição de exclusão (template `excluir-definitivo.json`). |
| `src/SincronizadorSAP/Program.cs` | Ponto de entrada. Roteia a passada principal e as ações de quarentena. |
| `src/SincronizadorSAP/ServicoSincronizadorSAP.cs` | (ver acima — serviço de domínio compartilhado pela passada e pelas ações). |

### SincronizadorFerias

| Arquivo | Propósito |
|---|---|
| `src/SincronizadorFerias/ExecutorSincronizadorFerias.cs` | Pipeline de 17 passos. Manipula `accountExpires` (FILETIME), o watermark `:CheckedOut:` em `streetAddress`, os grupos L1/L2, filtros (CPF, deduplicação, cargos proibidos, empresa, listas negras) e o limite `QuantidadeMaximaDeAtualizacoes`. |
| `src/SincronizadorFerias/ServicoSincronizadorFerias.cs` | Conversão de `accountExpires` (MaxValue/0 → `DataDeExpiracaoDaConta = null`) e correlação por `CPF.SomenteDigitos()`. Injeção SQL de férias (Metadados SQL) somente para CPFs presentes no banco. |
| `src/SincronizadorFerias/Model/UsuarioAD.cs` | Modelo do usuário lido do Active Directory. |
| `src/SincronizadorFerias/Model/UsuarioOrigem.cs` | Modelo do usuário das origens (SAP / Metadados HTTP / Metadados SQL). |
| `src/SincronizadorFerias/Model/UsuarioJoin.cs` | Modelo do join entre AD e origem usado na comparação. |

### SincronizadorGrupos

| Arquivo | Propósito |
|---|---|
| `src/SincronizadorGrupos/ExecutorSincronizadorGrupos.cs` | Executor principal. Sincroniza 6 campos de perfil e grupos por OU, backup integral, teto `MaximoAlteracoesPorExecucao`, remoção de grupos desabilitada (`if(false)`) e sumário CSV. |
| `src/SincronizadorGrupos/Program.cs` | Ponto de entrada. Roteia `-executar` / `-consultar`. |
| `src/SincronizadorGrupos/instrucoes-configuracao/EXEMPLOS/conf.ini` | Exemplo de configuração: seções `[Geral]`, `[ActiveDirectory]`, `[BDesk]`. |
| `src/SincronizadorGrupos/instrucoes-configuracao/EXEMPLOS/abertura.json` | Template JSON de abertura de requisição BDesk. |
| `src/SincronizadorGrupos/instrucoes-configuracao/EXEMPLOS/encerramento.json` | Template JSON de encerramento imediato (auditoria no mesmo ciclo). |

---

## Discrepâncias documento-vs-código {#discrepancias-documento-vs-codigo}

!!! warning "Regra de precedência"
    Quando a documentação existente diverge do código, **o código prevalece**. A tabela abaixo consolida as divergências verificadas. Os arquivos de documentação citados (ex.: `docs/negocio/sincronizador-ad-regras.md`, `docs/business-requirements/sincronizacao-ad-quarentena/prd-automacao-quarentena.md`) são insumos e podem estar desatualizados.

| Tema | O que o documento dizia | O que o código diz | Arquivo do doc |
|---|---|---|---|
| Descrição da OU mensal de quarentena | Descrição usaria `{nomeOu}` (ex.: "OU de quarentena para 5S-03-2026") | Deveria usar `{MM-yyyy}`: `description = $"OU de quarentena para {DateTime.Now:MM-yyyy}"`, resultando em "OU de quarentena para 03-2026" (sem o prefixo `5S-`). Verificado em `ExecutorQuarentena.cs`. | `docs/negocio/sincronizador-ad-regras.md` |
| Retorno de quarentena reativa a conta | PRD afirma que o retorno reabilitaria a conta | O retorno **nunca** modifica `userAccountControl`; a conta permanece desabilitada. A reabilitação é passo separado, via `manutencao`. Verificado em `ExecutorRetornarQuarentena.cs:87-100`. | `prd-automacao-quarentena.md:81` |
| Intervalo mínimo de 12h no retorno | Intervalo de 12h aplicado sempre entre execuções | O intervalo de 12h só se aplica **quando o `extensionAttribute` está vazio** (OU original não recuperável). Valor fixo, não parametrizável. O PRD não menciona. `ExecutorRetornarQuarentena.cs:15`. | `prd-automacao-quarentena.md` |
| Deduplicação de exclusões no SAP | Deduplicação por CPF na janela de 7 dias | A deduplicação é por **login/`sAMAccountName`**, não por CPF. Janela `DiasDeEsperaPorExclusoes` (default 7). Verificado em `ExecutorSincronizadorSAP.cs`. | `infraestrutura-deploy.md` |
| Query PageSize 10000 / Timeout 30s | Atribuída a uma consulta SAP SOAP | É a query **LDAP do Active Directory via ADODB** (`ObterUsuariosAD`), não SAP SOAP. | `infraestrutura-deploy.md` |
| Remoção de prestadores | Filtraria por padrão genérico `ps.*` | Filtra login iniciando por `ps.` (`RemoverComPS` usa `StartsWith("ps.", OrdinalIgnoreCase)`). | — |
| Injeção de férias via SQL (Ferias) | SQL sobrescreveria sempre os valores HTTP | A injeção SQL (`INICIOPROGFERIAS`/`TERMINOPROGFERIAS`) só ocorre para **CPFs presentes no banco**; usuários ausentes mantêm os campos HTTP. `ServicoSincronizadorFerias.cs`. | — |
| Normalização de celular no Azure | Sempre prepende `55` e `+` | Só prepende `55` e `+` para números com **≤ 11 dígitos**; números maiores ficam `+{numeroOriginal}`. `ExecutorAzure.cs`. | — |
| Listas de exceção no SAP | Aplicar-se-iam a todas as ações, inclusive `inserir` | O filtro de exceção AD **não se aplica a `inserir`** (`Agregar`: `if (acao != "inserir")`). `ExecutorSincronizadorSAP.cs:939-955`. | — |
| Rename de CN em modo consulta (Grupos) | Rename protegido por `ModoConsultar` | O `userEntry.Rename()` ocorre mesmo em `-consultar` (bug não protegido). `ExecutorSincronizadorGrupos.cs:548-550`. | `agendamento-operacao.md` |
| `[ActiveDirectory] Caminho` (Grupos) | Validado na inicialização | `Caminho` é obrigatório em runtime (linha 302) mas **não validado na init** — latent bug (`KeyNotFoundException` se ausente). `ExecutorSincronizadorGrupos.cs`. | — |
| `MaximoAlteracoesPorExecucao` (Grupos) | Teria default | Lido da config **sem default hardcoded** visível. `ExecutorSincronizadorGrupos.cs:121`. | — |
| Quarentena "sem alterações no banco BDesk" | PRD afirma não haver alterações no BDesk | O código **abre requisições via API REST** do BDesk no fluxo de quarentena. | `prd-automacao-quarentena.md` |
| Template de expiração de quarentena | Usaria o `MontarJSONExclusao` tradicional | `AcaoExpirarQuarentena` usa o template `excluir-definitivo.json` (fluxo próprio de quarentena). `AcaoExpirarQuarentena.cs`. | — |
| `JaExisteRequisicaoAberta` | Filtraria corretamente por requisição aberta do mesmo login | Deveria filtrar por **`AtividadeId` específico**, não apenas pelo `nomeConjunto` (correção recomendada). `AcaoSincronizadorSAP.cs`. | — |

!!! tip "Defaults confirmados em código"
    Como contraponto às discrepâncias, alguns valores de documentação foram **confirmados** no código: `DiasDeEsperaPorExclusoes` default `7` (`ExecutorSincronizadorSAP.cs`), `DiasParaExpiracao` default `30` (`AcaoSincronizadorSAP.cs:135`, `?? 30`), e `DiasInatividade=90` obrigatório sem fallback (`ExecutorSincronizadorSAP.cs:1221`).
