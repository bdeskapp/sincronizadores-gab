# Documentacao dos Sincronizadores GAB

Site de documentacao (MkDocs Material, pt-BR) das regras de negocio e da operacao
da suite **Sincronizadores GAB** — quatro aplicacoes console .NET 8.0 que mantem
usuarios e grupos consistentes entre **Active Directory**, **SAP HR**,
**Metadados** (RH interno), **Azure AD** e o sistema de chamados **BDesk**.

## As quatro aplicacoes

| Aplicacao | O que faz |
|-----------|-----------|
| **SincronizadorAD** | Aplica mutacoes no Active Directory a partir de 10 acoes roteadas por `-acao`, consumindo requisicoes do BDesk. |
| **SincronizadorSAP** | Passada principal: faz o merge de SAP + Metadados + AD e abre requisicoes de Novos / Alterados / Excluidos no BDesk; gerencia a quarentena. |
| **SincronizadorFerias** | Desabilita contas durante as ferias via `accountExpires`, com watermark `:CheckedOut:` em `streetAddress`. |
| **SincronizadorGrupos** | Audita e sincroniza associacao a grupos e campos de perfil por OU. |

## Estrutura do site

- **Inicio** — visao geral da suite e do fluxo de dados.
- **Negocio** — regras de cada sincronizador e o ciclo de vida da quarentena.
- **DevOps** — servidores, agendamento, deploy/build e configuracao.
- **Referencia** — glossario e indice de arquivos-chave.

## Desenvolvimento local

Pre-requisito: `mkdocs-material` instalado (`pip install mkdocs-material`).

```bash
# servidor local com auto-reload
mkdocs serve

# build de validacao (mesmo do CI)
mkdocs build --strict
```

## Deploy

O deploy para **GitHub Pages** e automatico via GitHub Actions
(`.github/workflows/deploy-docs.yml`) a cada push na branch `main`. O workflow
roda `mkdocs build --strict` e publica o diretorio `site/` gerado.

## Fonte de verdade

O **codigo C# em `src/`** (no repositorio dos Sincronizadores) e a unica fonte de
verdade. Esta documentacao e um insumo de apoio; quando divergir do codigo, **vale
o codigo**. As divergencias conhecidas estao registradas nas secoes de
*Discrepancias* de cada pagina.
