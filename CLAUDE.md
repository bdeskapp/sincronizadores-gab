# CLAUDE.md

Repositório **docs-only** (MkDocs Material, pt-BR) dos **Sincronizadores GAB**, publicado em GitHub Pages: https://bdeskapp.github.io/sincronizadores-gab/

## Fonte de verdade
- O **código C# é a verdade** e vive em um repo IRMÃO: `D:\projects\sincronizadoresgab` (`src/` + `CLAUDE.md` por subprojeto). Este repo só contém o site.

## Regenerar a documentação
- `Workflow({ name: "gerar-docs-sincronizadores" })` — pesquisa o código C#, verifica adversarialmente cada regra, reescreve as 12 páginas e roda `mkdocs build --strict`. O workflow **constrói mas NÃO faz deploy**.

## Build & Deploy
- `mkdocs build --strict` — gate de validação (links quebrados/páginas órfãs = erro). `mkdocs` está no PATH via pyenv (Material 9.5.x).
- **Deploy = `git push origin main`** → dispara `.github/workflows/deploy-docs.yml` (Actions → Pages). Verificar: `gh run watch <id> --exit-status` e `curl -so /dev/null -w "%{http_code}" <url>`.
- **Gotcha:** Pages precisa estar habilitado com `build_type: workflow` (`gh api --method POST repos/bdeskapp/sincronizadores-gab/pages -f build_type=workflow`). Sem isso o job `build` passa mas o `deploy` falha com 404 "Ensure GitHub Pages has been enabled".

## Diagramas (Mermaid)
- Mermaid já habilitado em `mkdocs.yml` (`pymdownx.superfences` → `custom_fences` mermaid). Use blocos ```mermaid em vez de ASCII art.
- Dentro de nós Mermaid: escape `>`/`<` como `&gt;`/`&lt;`; `<br/>`, `<b>`, `<small>` funcionam. Cores via `classDef`/`class` (acompanham tema claro/escuro).
