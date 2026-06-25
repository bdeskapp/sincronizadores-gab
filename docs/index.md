# Visão Geral

Bem-vindo à documentação dos **Sincronizadores GAB**, uma suíte de **4 aplicações console .NET 8.0** que mantêm usuários e grupos consistentes entre o **Active Directory**, o **SAP HR**, os **Metadados** (RH interno), o **Azure AD** e o sistema de chamados **BDesk**.

!!! info "Características da suíte"
    - **Plataforma:** Windows-only (`net8.0-windows8.0`), com dependências de **COM interop ADODB** e **System.DirectoryServices**.
    - **Idioma:** **TODO** o código-fonte — identificadores, comentários e strings — está em **português**.
    - **Execução:** linha de comando via **Windows Task Scheduler** (não há IIS nem serviço web).

!!! warning "Fonte de verdade"
    O **código C# em `src/`** é a **única fonte de verdade**. Os documentos em `docs/` e os arquivos `CLAUDE.md` são insumos úteis, porém podem estar desatualizados. Sempre que esta documentação divergir do código, **vale o que está no código**, e a divergência é registrada nas páginas de referência.

## As quatro aplicações

| Aplicação | Caminho | O que faz |
|---|---|---|
| **SincronizadorAD** | `src/SincronizadorAd` | Executa mutações no Active Directory a partir de **10 ações** roteadas por linha de comando (`-acao`), consumindo requisições abertas no BDesk. |
| **SincronizadorSAP** | `src/SincronizadorSAP` | É a **passada principal de merge** de três origens (SAP SOAP + Metadados HTTP + AD via ADODB), que abre requisições BDesk de **Novos / Alterados / Excluídos** e gerencia as ações de quarentena. |
| **SincronizadorFerias** | `src/SincronizadorFerias` | Desabilita contas durante o período de férias via `accountExpires`, marcando a propriedade da alteração com o watermark `:CheckedOut:` no campo `streetAddress`. |
| **SincronizadorGrupos** | `src/SincronizadorGrupos` | Audita a associação de usuários a grupos e os campos de perfil **por OU**, organizados em árvore hierárquica configurada de forma descentralizada. |

!!! note "Detalhes de cada aplicação"
    As regras de negócio detalhadas de cada sincronizador estão na seção **Negócio** deste site. A operação, o agendamento e a configuração estão na seção **DevOps**.

## Fluxo de dados

A suíte conecta as **origens de dados** aos **alvos** (Active Directory e BDesk) por meio dos quatro sincronizadores. O BDesk atua simultaneamente como **fila de requisições** (origem para o SincronizadorAD) e como **registro de auditoria** (destino dos demais).

```text
            ORIGENS                       SINCRONIZADORES                  ALVOS
  ┌───────────────────────────┐                                  ┌──────────────────────┐
  │ SAP HR        (SOAP/XML)   │──┐                               │                      │
  │ Metadados RH  (HTTP/SQL)   │──┼──▶  SincronizadorSAP    ──────▶│  BDesk (requisições) │
  │ Active Directory (ADODB)   │──┘     (merge de 3 origens)       │  Novos/Alterados/    │
  └───────────────────────────┘                                   │  Excluídos           │
                                                                   └──────────┬───────────┘
  ┌───────────────────────────┐                                              │ requisições
  │ Requisições BDesk abertas  │──────▶  SincronizadorAD     ─────────────────┘ abertas
  └───────────────────────────┘         (10 ações via -acao)                  │
                                                ▼                             ▼
  ┌───────────────────────────┐         mutações no       ┌──────────────────────────────┐
  │ SAP + Metadados + AD       │──────▶  SincronizadorFerias│  Active Directory             │
  │ (períodos de férias)       │         accountExpires +  │  contas, grupos, OUs,         │
  └───────────────────────────┘         watermark          │  accountExpires, quarentena   │
                                                            └──────────────────────────────┘
  ┌───────────────────────────┐
  │ Estrutura de OUs + config  │──────▶  SincronizadorGrupos ─────▶  AD (grupos/perfil) + BDesk
  │ (config.txt por OU)        │
  └───────────────────────────┘
```

Em resumo:

- **SAP HR**, **Metadados** e **AD** alimentam o **SincronizadorSAP**, que decide quem é novo, alterado ou excluído e abre as requisições correspondentes no BDesk.
- O **SincronizadorAD** consome essas requisições (e outras) do BDesk e aplica as mutações reais no Active Directory.
- O **SincronizadorFerias** e o **SincronizadorGrupos** atuam diretamente sobre o AD e registram suas ações no BDesk.

!!! tip "Ciclo de quarentena (fluxo cross-project)"
    A quarentena de contas inativas é um fluxo que **atravessa SAP e AD**: o SincronizadorSAP **monitora e detecta** (ações `monitorar_quarentena` e `expirar_quarentena`, abrindo requisições no BDesk), enquanto o SincronizadorAD **executa** (ações `retornar_quarentena` e `excluir`). Veja a página dedicada ao **Ciclo de Vida da Quarentena** na seção Negócio.

## Como navegar neste site

O site está organizado em três seções, pensadas para perfis de leitura diferentes:

| Seção | Conteúdo | Indicada para |
|---|---|---|
| **Negócio** | Regras de negócio de cada sincronizador e do ciclo de quarentena, descritas a partir do código real. | Analistas de negócio, RH, suporte. |
| **DevOps** | Servidores, agendamento, deploy, configuração (INI/JSON/listas negras) e riscos operacionais. | Operadores, administradores de infraestrutura. |
| **Referência** | Detalhes técnicos, nomes de classes/métodos e discrepâncias registradas entre documento e código. | Desenvolvedores e quem precisa do detalhe fino. |

!!! note "Por onde começar"
    - **É analista de negócio?** Comece pela seção **Negócio**, escolhendo o sincronizador que interessa ao seu processo.
    - **É operador ou DevOps?** Comece pela seção **DevOps**, que cobre servidores, agendamento e configuração.
    - Precisa do detalhe técnico exato (classe, método, linha)? Consulte a seção **Referência** e, em última instância, o código em `src/`.

## Ambiente de produção

A suíte roda em dois servidores Windows, em modelo ativo/standby:

| Servidor | Papel |
|---|---|
| **GAB13013i** | **Ativo** — o serviço é executado a partir deste host. |
| **GAB13011i** | **Standby**. |

!!! warning "Deploy nos dois servidores"
    O caminho de deploy é **`F:\BusinessDesk\ASK\`** (por exemplo, `F:\BusinessDesk\ASK\SincronizadorSAP\`). Embora o serviço seja executado a partir do **GAB13013i** (ativo), qualquer alteração deve ser aplicada em **ambos os servidores** (GAB13013i **e** GAB13011i) para manter o standby consistente.

---

!!! info "Lembrete sobre o idioma"
    Por convenção do projeto, **todo o código está em português** — incluindo nomes de classes, métodos, variáveis, comentários e mensagens. Esta documentação cita os identificadores reais (por exemplo, `ExecutorQuarentena` em `src/SincronizadorAd/Executores/`) exatamente como aparecem no código.
