# V3 — Linha de base (estado real da branch antes de mexer)

Legenda: **[EXEC]** executado nesta sessão com saída real · **[ESTÁTICA]** lido no código, não executado ·
**[HIPÓTESE]** suspeita ainda sem teste · **[BLOQUEIO]** não dá para fazer neste ambiente.

## Estado do git
- Branch `claude/pedestrian-routing-system-ktxozj`, **commit inicial `a018b35`** ("CI: keep running the Android workflow on branch pushes…"). [EXEC]
- Árvore limpa no início; nenhum trabalho pendente foi sobrescrito. `CLAUDE.md` e `.claude/skills/` **não existem** no repositório. [EXEC]
- O workflow do GitHub Actions desse commit passou (run 4, `success`). [EXEC via API do GitHub]

## Arquitetura real
| Camada | Tecnologia (versões fixas em `requirements.txt` / `package.json`) |
|---|---|
| Backend | FastAPI 0.143, SQLAlchemy 2.1, Alembic 1.20, PostGIS 16, OR-Tools 9.15, scipy 1.18, NumPy 2.5 |
| Roteamento servidor | `backend/roteamento/` (OSM → grafo de pedestres, Dijkstra, snap), `app/services/{planner,optimization}.py` |
| Web (Next.js) | `frontend/` — existente, **não alterado na V3** |
| App Android offline | `mobile/` — Vite 8 + React 19 + Capacitor 8.5 + Dexie 4 (IndexedDB) + MapLibre 6 |
| Núcleo no aparelho | `mobile/src/core/` (router, optimizer, plan, importer, normalize, geocode, service, worker) |
| Malha | `santos-graph.bin` (41 598 nós / 48 747 trechos, OSM), SHA-256 `203c8dcb…` |
| Ambiente de teste | Linux 6.18, Xeon 2,1 GHz 4 vCPU, Python 3.13.16, Node 22.22, JDK 21, Android SDK 36, Chromium headless |

## Testes na linha de base [EXEC]
| Suíte | Resultado |
|---|---|
| `pytest` (backend) | **82 passaram, 2 pulados** (92,9 s) — os 2 pulados exigem internet |
| `vitest` (app) | **36 passaram, 1 pulado** |
| `tsc --noEmit` | sem erros |

## Os números da V2 foram reexecutados? [EXEC]
| Afirmação da V2 | Reexecução V3 (mesma matriz, mesmos dados) | Veredito |
|---|---|---|
| Rota aberta 150 paradas: 15,53 km / 201,9 min | OR-Tools 5 s/15 s/60 s sobre a **mesma matriz** (SHA-256 da entrada em `test-data/v3/comparacao_backend.json`): V2 dava 12 133,5 s (202,2 min) e 15,61 km com 15 s; com 60 s, 12 084,5 s (201,4 min). A rota de 15,53 km/201,9 min saiu de uma execução de 30 s | **Confirmado** como resultado de uma execução; variação de ±0,5 % entre limites de tempo |
| Matrizes do app e do backend diferem ≤ 0,137 % | `parity.test.ts` segue passando | Confirmado |
| App entre 99,46 % e 99,71 % do tempo do OR-Tools | Sobre a mesma matriz, o app (3–15 s, 5 sementes) fica entre **12 048 e 12 094 s**; o OR-Tools V2 ficou entre 12 085 e 12 134 s. Ou seja, **o app ficou igual ou melhor** que o OR-Tools nessa instância | Confirmado; a frase "app a X % do OR-Tools" não é um piso: o app pode ganhar |
| **E2E mostrou 15,0 km / 3 h 20 min, enquanto o backend 15,53 km** | **Explicado:** o E2E usa o ponto de partida devolvido ao vivo pelo Nominatim para "Rua Joaquim Távora, 480", que é **(−23,9489139; −46,3336801)**; o cenário do backend usa **(−23,9480025; −46,3406209)**, ~700 m a oeste. Entradas diferentes → rotas diferentes. Com o mesmo ponto de partida, o app dá 15,35–15,50 km | Não era erro de cálculo: eram duas origens diferentes. Mostra por que a origem **tem que ser confirmada manualmente** |
| E2E-14: o ramo "GPS fora da malha" não tinha rodado de ponta a ponta | Na reexecução V3 rodou: "Sua posição está fora da malha de pedestres… Recalculado a partir de: Última parada atendida" | A ressalva da V2 está resolvida |

## Achados na linha de base
| # | Achado | Tipo | Tratado em |
|---|---|---|---|
| 1 | `feasibility` (cadeia de SCC) só é exata se a matriz for de caminhos mínimos (fecho transitivo). Em matriz arbitrária com buracos de ligação o conjunto mantido **podia não ser visitável** (probe: mantido > ótimo). A matriz do motor real é fechada (provado por teste, inclusive a matriz real de 151×151) | [EXEC] reproduzido | V3-2 |
| 2 | `service_time_s` guardava serviço **+ acesso** somados; o relatório do app não mostrava o acesso | [ESTÁTICA] → [EXEC] | V3-2 |
| 3 | Os docs da V2 diziam que endereços "só a rua" não entravam na rota; o código **roteava** (`ROUTABLE` inclui `street`), apenas marcando "incerto" | [ESTÁTICA] | V3-3 (política `approxPolicy`; doc corrigido) |
| 4 | `classify()` devolvia `exact` para resultado com número de casa mas sem número pedido (S/N) | [ESTÁTICA] → [EXEC] | V3-3 |
| 5 | `allowBackup="true"` no manifesto: o Android poderia copiar o IndexedDB (nomes/endereços) para a nuvem do Google | [ESTÁTICA] | V3-7 |
| 6 | Geocodificação: consulta por carta/endereço sem fila persistente; Nominatim público sem teto de lote | [ESTÁTICA] | V3-4 |
| 7 | Sem mapa de ruas offline (fundo liso) | [EXEC] (V2 documentou) | V3-5 |
| 8 | Lista de paradas sem virtualização (500 `<li>` no DOM) | [ESTÁTICA] | V3-7 |
| 9 | Contraste insuficiente (botão "Entregue" branco/#16a34a = 3,3:1; vários selos) e `progressbar` sem nome | [EXEC] axe: 21 violações sérias | V3-7 |
| 10 | Docker: imagem não construída por limite do Docker Hub | [BLOQUEIO] | — |
| 11 | Teste em celular/emulador | [BLOQUEIO] (sem KVM) | roteiro em `TESTE_FISICO_ANDROID.md` |
