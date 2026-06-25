export const meta = {
  name: 'gerar-docs-sincronizadores',
  description: 'Pesquisa o codigo de sincronizadoresgab e gera site MkDocs (pt-BR) de regras de negocio + devops em bdeskapp-sincronizadores-gab',
  whenToUse: 'Gerar/atualizar a documentacao GitHub Pages dos Sincronizadores GAB a partir do codigo-fonte C#.',
  phases: [
    { title: 'Pesquisa', detail: 'Um agente por dominio (AD, SAP, Ferias, Grupos, Quarentena, DevOps) le o codigo C# como verdade e reconcilia com docs existentes' },
    { title: 'Verificacao', detail: 'Verificador adversarial confere cada afirmacao de regra de negocio contra o codigo' },
    { title: 'Sintese', detail: 'Define a estrutura do site (nav, paginas) a partir dos achados verificados' },
    { title: 'Escrita', detail: 'Um agente escreve cada pagina markdown pt-BR' },
    { title: 'Montagem', detail: 'Gera mkdocs.yml, workflow de deploy, README e roda mkdocs build --strict' },
  ],
}

const SRC = 'D:/projects/sincronizadoresgab'
const DST = 'D:/projects/bdeskapp-sincronizadores-gab'

// ---------------------------------------------------------------------------
// Contexto compartilhado dado a todos os agentes. O CLAUDE.md raiz do projeto
// fonte e um mapa de altissima qualidade (ground-truth scaffold) — todos os
// agentes devem le-lo primeiro e tratar o CODIGO C# como verdade final.
// ---------------------------------------------------------------------------
const CONTEXTO = `
Projeto fonte: ${SRC} — "Sincronizadores GAB", suite de apps console C# .NET 8.0
que sincronizam usuarios/grupos entre Active Directory, SAP, Azure AD e o sistema
de chamados BDesk. TODO o codigo (identificadores, comentarios, strings) esta em
portugues.

REGRAS PARA TODOS OS AGENTES:
- O CODIGO C# em ${SRC}/src e a VERDADE. Documentos existentes em ${SRC}/docs e os
  arquivos CLAUDE.md sao INSUMOS, mas podem estar desatualizados (o ultimo commit
  do repo foi "Corrige imprecisoes nos CLAUDE.md apos pesquisa do codigo").
- Comece SEMPRE lendo ${SRC}/CLAUDE.md (mapa geral) e o CLAUDE.md do sub-projeto
  relevante listado nele.
- Toda saida textual destinada ao site DEVE ser em portugues do Brasil (pt-BR).
- Cite caminhos de arquivo e nomes de classe/metodo reais (ex: ExecutorQuarentena
  em src/SincronizadorAd/Executores/...). Nunca invente nomes.
- Quando o documento existente divergir do codigo, a versao do CODIGO vence e a
  divergencia deve ser registrada na lista "discrepancias".
`

// Dominios de pesquisa. key vira nome de arquivo; docExistente e o doc a reconciliar.
const DOMINIOS = [
  {
    key: 'sincronizador-ad',
    titulo: 'Sincronizador AD',
    foco: 'O sincronizador de Active Directory e seus 10 executores de acao (inserir, atualizar, manutencao, quarentena, retornar_quarentena, azure, marcar_pendente, marcar_pendente_cpf, excluir, excluir_cpf). Hierarquia ExecutorAuxiliarBase, fluxo por requisicao, geracao de login, sub-requisicoes de dissolucao.',
    codigo: 'src/SincronizadorAd/ (especialmente Executores/), src/SincronizadorAd/CLAUDE.md',
    docExistente: 'docs/negocio/sincronizador-ad-regras.md',
  },
  {
    key: 'sincronizador-sap',
    titulo: 'Sincronizador SAP',
    foco: 'Passada principal SAP: merge de SAP (SOAP XML) + Metadados (HTTP XML) + AD (ADODB) em Novos/Alterados/Excluidos. Regra antiga vs nova (todos os registros de CPF devem ser Desligado). Campos DA11/DA12/DA16/DA19, filtros, limites de lote, deduplicacao por LocalData.',
    codigo: 'src/SincronizadorSAP/ (ServicoSincronizadorSAP.cs, ExecutorSincronizadorSAP.cs), src/SincronizadorSAP/CLAUDE.md',
    docExistente: 'docs/negocio/sincronizador-sap-regras.md',
  },
  {
    key: 'sincronizador-ferias',
    titulo: 'Sincronizador Ferias',
    foco: 'Pipeline de 17 passos, sistema de watermark, merge de tres fontes, filtragem. Modifica AD: accountExpires (FILETIME), metadados em streetAddress. Lista de excecao propria lista-negra-ferias-grupos/logins.txt.',
    codigo: 'src/SincronizadorFerias/, src/SincronizadorFerias/CLAUDE.md',
    docExistente: 'docs/negocio/sincronizador-ferias-regras.md',
  },
  {
    key: 'sincronizador-grupos',
    titulo: 'Sincronizador Grupos',
    foco: 'Auditoria/sincronizacao de associacao de grupos AD via definicoes JSON. Processamento por OU, diff de campos, sumario.csv, secao INI [Geral], limites de lote (MaximoAlteracoesPorExecucao), mecanismos de seguranca.',
    codigo: 'src/SincronizadorGrupos/, src/SincronizadorGrupos/CLAUDE.md',
    docExistente: 'docs/negocio/sincronizador-grupos-regras.md',
  },
  {
    key: 'ciclo-quarentena',
    titulo: 'Ciclo de Vida da Quarentena',
    foco: 'O fluxo automatizado cross-project de quarentena: SAP monitorar_quarentena (06:00) e expirar_quarentena (06:15) abrem requisicoes no BDesk; AD retornar_quarentena (06:30) e excluir (07:00) as executam. ExecutorQuarentena (salva OU original em extensionAttribute, move para OU 5S-{MM-yyyy}, desabilita conta). Chaves de config de quarentena.',
    codigo: 'src/SincronizadorSAP/Acoes/, src/SincronizadorAd/Executores/ExecutorQuarentena.cs e ExecutorRetornarQuarentena.cs, docs/business-requirements/sincronizacao-ad-quarentena/, docs/plans/2026-03-04-quarentena-*.md',
    docExistente: 'docs/business-requirements/sincronizacao-ad-quarentena/prd-automacao-quarentena.md',
  },
]

const DOMINIO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titulo', 'resumo', 'regras', 'discrepancias', 'arquivosChave'],
  properties: {
    titulo: { type: 'string' },
    resumo: { type: 'string', description: 'Paragrafo pt-BR de visao geral do dominio' },
    regras: {
      type: 'array',
      description: 'Regras de negocio verificaveis, cada uma ancorada no codigo',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['regra', 'evidenciaCodigo'],
        properties: {
          regra: { type: 'string', description: 'Afirmacao de regra de negocio em pt-BR' },
          evidenciaCodigo: { type: 'string', description: 'arquivo:linha ou classe.metodo que comprova a regra' },
          parametrosConfig: { type: 'string', description: 'chaves de config/INI/JSON relacionadas, se houver' },
        },
      },
    },
    discrepancias: {
      type: 'array',
      description: 'Pontos onde o doc existente diverge do codigo (codigo vence)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['docDiz', 'codigoDiz'],
        properties: {
          docDiz: { type: 'string' },
          codigoDiz: { type: 'string' },
          arquivoDoc: { type: 'string' },
        },
      },
    },
    arquivosChave: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['regra', 'confirmada', 'justificativa'],
  properties: {
    regra: { type: 'string' },
    confirmada: { type: 'boolean', description: 'true se a regra realmente existe no codigo' },
    justificativa: { type: 'string', description: 'pt-BR: o que foi encontrado no codigo' },
    correcao: { type: 'string', description: 'se confirmada=false, a versao correta da regra' },
  },
}

// ===========================================================================
// FASE 1 + 2: pesquisa por dominio, depois verificacao adversarial de cada
// regra — em PIPELINE, para que um dominio entre em verificacao assim que
// sua pesquisa termina (sem barreira global).
// ===========================================================================
phase('Pesquisa')
const dominiosVerificados = await pipeline(
  DOMINIOS,
  // Estagio 1: pesquisa profunda do dominio
  (d) => agent(
    `${CONTEXTO}

Voce e o pesquisador do dominio "${d.titulo}".
FOCO: ${d.foco}
CODIGO A LER (verdade): ${d.codigo}
DOC EXISTENTE A RECONCILIAR: ${SRC}/${d.docExistente}

Leia o codigo C# relevante e o doc existente. Extraia as regras de negocio REAIS,
cada uma ancorada em evidencia de codigo (arquivo:linha ou classe.metodo). Registre
toda divergencia entre o doc e o codigo em "discrepancias". Saida em pt-BR.`,
    { label: `pesquisa:${d.key}`, phase: 'Pesquisa', schema: DOMINIO_SCHEMA, agentType: 'Explore' }
  ),
  // Estagio 2: verificacao adversarial — confere cada regra contra o codigo
  (pesquisa, d) => {
    if (!pesquisa) return null
    return parallel(
      (pesquisa.regras || []).map((r) => () =>
        agent(
          `${CONTEXTO}

Verificacao adversarial para o dominio "${d.titulo}".
Tente REFUTAR esta regra de negocio lendo o codigo em ${SRC}/${d.codigo}.
REGRA: "${r.regra}"
EVIDENCIA ALEGADA: ${r.evidenciaCodigo}

Abra os arquivos citados. Se o codigo nao comprovar a regra exatamente, marque
confirmada=false e forneca a correcao. Na duvida, prefira confirmada=false.`,
          { label: `verifica:${d.key}`, phase: 'Verificacao', schema: VERDICT_SCHEMA, agentType: 'Explore' }
        )
      )
    ).then((verdicts) => ({
      ...pesquisa,
      key: d.key,
      titulo: d.titulo,
      regrasConfirmadas: (verdicts || [])
        .filter(Boolean)
        .filter((v) => v.confirmada)
        .map((v) => ({ regra: v.regra, justificativa: v.justificativa })),
      regrasCorrigidas: (verdicts || [])
        .filter(Boolean)
        .filter((v) => !v.confirmada && v.correcao)
        .map((v) => ({ original: v.regra, correcao: v.correcao })),
    }))
  }
)

const dominios = dominiosVerificados.filter(Boolean)
log(`Pesquisa+verificacao concluida para ${dominios.length}/${DOMINIOS.length} dominios`)

// ===========================================================================
// FASE 1b: DevOps / Infra / Config — track separado (le docs/devops + config + EXEMPLOS)
// ===========================================================================
const DEVOPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumo', 'agendamento', 'servidores', 'deploy', 'configuracao', 'discrepancias'],
  properties: {
    resumo: { type: 'string' },
    agendamento: { type: 'string', description: 'pt-BR: tarefas agendadas (Task Scheduler), horarios, ordem do ciclo de quarentena' },
    servidores: { type: 'string', description: 'pt-BR: requisitos de servidor, Windows, DirectoryServices, COM interop' },
    deploy: { type: 'string', description: 'pt-BR: build (Debug/Release/Homologacao), publicacao, Up2Date, .bat de revisao' },
    configuracao: { type: 'string', description: 'pt-BR: conf.ini, CONFIG/{acao}/, credenciais XOR, EXEMPLOS, mapeamento-participantes' },
    discrepancias: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['docDiz', 'codigoDiz'], properties: { docDiz: { type: 'string' }, codigoDiz: { type: 'string' } } } },
  },
}
const devops = await agent(
  `${CONTEXTO}

Voce e o pesquisador de DEVOPS / INFRAESTRUTURA / CONFIGURACAO.
Leia (verdade): ${SRC}/docs/devops/ (agendamento-operacao.md, configuracao-servidores.md,
infraestrutura-deploy.md), os arquivos conf.ini/CONFIG/EXEMPLOS de cada projeto,
${SRC}/tools/RegistrarRevisaoEmResources.bat, .editorconfig, .csproj (configs de build
Debug/Release/Homologacao), e a secao Configuration/Logging do ${SRC}/CLAUDE.md.

Documente como o sistema e agendado (Windows Task Scheduler, ciclo de quarentena
06:00-07:00), requisitos de servidor (Windows, COM interop ADODB/MSB4803), processo de
build/deploy, e o modelo de configuracao (INI + JSON + credenciais XOR + EXEMPLOS).
Tudo em pt-BR. Registre divergencias entre docs/devops e a realidade do codigo.`,
  { label: 'pesquisa:devops', phase: 'Pesquisa', schema: DEVOPS_SCHEMA, agentType: 'Explore' }
)

// ===========================================================================
// FASE 3: Sintese — define a estrutura do site (nav + lista de paginas)
// ===========================================================================
phase('Sintese')
const ESTRUTURA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paginas'],
  properties: {
    paginas: {
      type: 'array',
      description: 'Cada pagina markdown do site',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['caminho', 'tituloNav', 'secaoNav', 'briefing'],
        properties: {
          caminho: { type: 'string', description: 'caminho relativo dentro de docs/, ex: negocio/sincronizador-ad.md' },
          tituloNav: { type: 'string' },
          secaoNav: { type: 'string', description: 'Inicio | Negocio | DevOps | Referencia' },
          briefing: { type: 'string', description: 'pt-BR: o que esta pagina deve conter, instrucoes para o redator' },
        },
      },
    },
  },
}
const estrutura = await agent(
  `${CONTEXTO}

Voce e o ARQUITETO DE INFORMACAO do site MkDocs Material (pt-BR), no padrao do site
bdeskapp-api existente (secoes: Inicio, Negocio, DevOps, Referencia).

Com base nos achados verificados abaixo, defina a lista de paginas markdown do site.
Inclua: uma pagina inicial (index.md), uma pagina de regras por dominio em Negocio,
uma pagina dedicada ao Ciclo de Vida da Quarentena, paginas de DevOps (agendamento,
servidores, deploy, configuracao) e uma referencia (glossario/arquivos-chave). Cada
briefing deve dizer ao redator exatamente o que cobrir, citando classes/arquivos reais.

ACHADOS POR DOMINIO (JSON):
${JSON.stringify(dominios.map((d) => ({ key: d.key, titulo: d.titulo, resumo: d.resumo, regrasConfirmadas: d.regrasConfirmadas, regrasCorrigidas: d.regrasCorrigidas, discrepancias: d.discrepancias, arquivosChave: d.arquivosChave })), null, 1)}

ACHADOS DEVOPS (JSON):
${JSON.stringify(devops, null, 1)}`,
  { label: 'sintese:estrutura', phase: 'Sintese', schema: ESTRUTURA_SCHEMA }
)

const paginas = (estrutura && estrutura.paginas) || []
log(`Estrutura do site: ${paginas.length} paginas`)

// ===========================================================================
// FASE 4: Escrita — um agente escreve cada pagina markdown (paralelo)
// ===========================================================================
phase('Escrita')
const PAGINA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caminho', 'markdown'],
  properties: {
    caminho: { type: 'string' },
    markdown: { type: 'string', description: 'Conteudo markdown completo da pagina, em pt-BR, pronto para MkDocs Material' },
  },
}
const achadosResumo = JSON.stringify({
  dominios: dominios.map((d) => ({ key: d.key, titulo: d.titulo, resumo: d.resumo, regrasConfirmadas: d.regrasConfirmadas, regrasCorrigidas: d.regrasCorrigidas, arquivosChave: d.arquivosChave })),
  devops,
})
const paginasEscritas = (await parallel(
  paginas.map((p) => () =>
    agent(
      `${CONTEXTO}

Voce escreve UMA pagina do site MkDocs Material em pt-BR.
PAGINA: ${p.caminho}  (secao "${p.secaoNav}", titulo "${p.tituloNav}")
BRIEFING: ${p.briefing}

Use recursos do MkDocs Material livremente: admonitions (!!! note/warning/tip),
tabelas, blocos de codigo, listas. Use APENAS fatos dos achados verificados abaixo —
nao invente regras nem nomes de arquivo. Se precisar confirmar um detalhe, voce pode
ler o codigo em ${SRC}. Comece a pagina com um titulo de nivel 1 (# ...).

ACHADOS VERIFICADOS (JSON):
${achadosResumo}

Retorne o markdown completo da pagina.`,
      { label: `escreve:${p.caminho}`, phase: 'Escrita', schema: PAGINA_SCHEMA }
    )
  )
)).filter(Boolean)

log(`${paginasEscritas.length} paginas escritas`)

// ===========================================================================
// FASE 5: Montagem — entrega tudo a UM agente que grava os arquivos no
// repo de destino, gera mkdocs.yml + workflow de deploy + README, e roda
// `mkdocs build --strict` como portao de qualidade, corrigindo ate passar.
// ===========================================================================
phase('Montagem')
const MONTAGEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['buildPassou', 'resumo', 'arquivosGerados'],
  properties: {
    buildPassou: { type: 'boolean' },
    resumo: { type: 'string', description: 'pt-BR: o que foi gerado e resultado do build --strict' },
    arquivosGerados: { type: 'array', items: { type: 'string' } },
    saidaBuild: { type: 'string', description: 'ultimas linhas da saida de mkdocs build --strict' },
  },
}
const navJson = JSON.stringify(paginas.map((p) => ({ caminho: p.caminho, tituloNav: p.tituloNav, secaoNav: p.secaoNav })), null, 1)
const paginasJson = JSON.stringify(paginasEscritas)

const montagem = await agent(
  `Voce monta o site MkDocs Material no repositorio de destino: ${DST}
(repo git vazio). Espelhe o padrao do site existente em D:/projects/bdeskapp-api
(MkDocs Material, pt-BR, tema indigo, deploy via GitHub Pages).

TAREFAS:
1. Para cada pagina abaixo, crie o arquivo em ${DST}/docs/<caminho> com o markdown dado.
   PAGINAS (JSON, campos caminho+markdown): ${paginasJson}

2. Crie ${DST}/mkdocs.yml seguindo o estilo de D:/projects/bdeskapp-api/mkdocs.yml
   (theme material, language pt-BR, palette indigo com toggle claro/escuro, features
   de navegacao e busca, markdown_extensions: admonition, pymdownx.details,
   pymdownx.superfences, pymdownx.highlight, pymdownx.inlinehilite, pymdownx.tabbed,
   tables, attr_list, md_in_html; plugin search lang pt). Defina:
     site_name: "Sincronizadores GAB — Documentacao"
     site_description: documentacao de regras de negocio e devops dos Sincronizadores GAB
   Monte o 'nav' a partir destas paginas agrupadas por secaoNav, na ordem
   Inicio, Negocio, DevOps, Referencia:
   ${navJson}
   IMPORTANTE: cada entrada de nav DEVE apontar para um arquivo que existe em docs/.

3. Crie ${DST}/.github/workflows/deploy-docs.yml identico em estrutura ao de
   D:/projects/bdeskapp-api/.github/workflows/deploy-docs.yml (build com
   mkdocs build --strict + upload-pages-artifact, depois deploy-pages; python 3.12;
   pip install mkdocs-material; permissions pages/id-token; concurrency group pages).

4. Crie ${DST}/README.md (pt-BR) e ${DST}/.gitignore (com 'site/' e '__pycache__/').

5. Rode \`mkdocs build --strict\` em ${DST} (o binario mkdocs ja esta instalado).
   Se houver QUALQUER warning/erro (links quebrados, paginas orfas, nav apontando
   para arquivo inexistente), CORRIJA (ajuste nav ou crie a pagina faltante) e
   rode de novo ate passar limpo. Limpe o diretorio site/ gerado ao final.

Retorne buildPassou, um resumo em pt-BR, a lista de arquivos gerados e as ultimas
linhas da saida do build.`,
  { label: 'montagem:site', phase: 'Montagem', schema: MONTAGEM_SCHEMA }
)

return {
  dominiosPesquisados: dominios.length,
  paginasEscritas: paginasEscritas.length,
  buildPassou: montagem && montagem.buildPassou,
  montagem,
}
