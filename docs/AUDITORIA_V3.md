# Auditoria V3 — Rota Santos

Continuação da V2 na mesma branch (`claude/pedestrian-routing-system-ktxozj`), sem recriar nada. Linha de base: commit
`a018b35` (ver `V3_BASELINE.md`). Ambiente: contêiner Linux, Xeon 2,1 GHz, 4 vCPU, Python 3.13, Node 22, Chromium headless.
**Nada foi testado em celular ou emulador.** Skills usadas: `V3_SKILLS_UTILIZADAS.md`.

Commits (em ordem): `ad94dfd` matemática · `99f2eff` posição/portaria (app) · `6f59d9f` portaria (backend) · `dbf814d` geocodificação em lote ·
`0eccf27` mapa offline · `0ad771f` cache de matriz · `92345c4` observação de campo · `47a81c3` Android/ADB/diagnóstico ·
`c8d34d4` ILS no backend, lista virtualizada, E2E de escala, a11y · `0bbe3b7` APK 1.2.0, CI, testes metamórficos ·
`fc8a60f`…`98c8b79` documentação e benchmarks.

## 1. Achados, correção e prova

Formato: problema → como foi reproduzido **antes** → correção → teste que fica.

| # | Sev. | Problema | Evidência antes | Correção | Teste |
|---|---|---|---|---|---|
| 1 | Alta | `feasibility` (cadeia de SCC) mantinha conjunto **não visitável** em matriz sem fecho transitivo (a V2 supôs transitividade sem checar) | Sondagem: p=0,2 → `len(kept) > ótimo` (asserção quebrou) | `is_closed()`; se não for fechada: DP exato (≤ 16 paradas) com sequência-testemunha; senão sinaliza `exact=False`. Python e TS | `test_v3_math.py` (cadeia = ótimo em 160 matrizes de caminho mínimo aberta/circular; DP exato em 900 matrizes arbitrárias), `v3math.test.ts`; a matriz real de 151×151 e as do motor com paradas virtuais são fechadas (teste) |
| 2 | Média | `service_time_s` = serviço **+ acesso** (rótulo errado); relatório sem acesso | Teste V2 `acc == service_time_s` | `time_breakdown`: viagem, serviço, acesso, duração estimada, penalidade de prioridade, penalidade de setor, objetivo generalizado; `service_time_s` = só serviço | `test_time_breakdown_separates_physical_time_from_penalties`, `v3math.test.ts` |
| 3 | Alta (P0 de honestidade) | Endereço "só a rua" **era roteado** enquanto o doc V2 afirmava o contrário | Leitura de `ROUTABLE` + `stopsOf` | Política `approxPolicy` (incluir sinalizado / só após confirmar); selo de confiança em todas as telas; **docs V2 corrigidos** | `address.test.ts` (política include/block) |
| 4 | Média | `classify()` dava `exact` a resultado com número de casa quando não se pediu número (S/N) | Leitura + teste | Só `exact` se o número pedido bate; senão `street` | `address.test.ts` |
| 5 | Alta | Posição do endereço, portaria e ponto na malha misturados | — (alerta G da V2 ficou PARCIAL) | App: `entrance` + histórico (reverter/invalidar), hierarquia 1–6, `routePoint()`. Backend: colunas `entrance_*`, tabela `address_location_history`, endpoints PUT/DELETE `/entrance`, `/invalidate`, `/revert`, GET `/history`, migração 0002 reversível | `address.test.ts` (10), `test_v3_entrance.py` (3), `test_zz_migration_roundtrip.py` |
| 6 | Média (LGPD) | `allowBackup="true"`: Android poderia copiar nomes/endereços para a nuvem | Leitura do manifesto | `allowBackup=false`, `usesCleartextTraffic=false` (conferido no APK com `aapt2`) | verificação do APK |
| 7 | Alta | Geocodificação sem fila persistente, sem teto para o Nominatim público | Leitura | `geoqueue.ts`: 1 tarefa por **endereço único**, retomável, backoff 2 s/4 s/…, circuit breaker (5 falhas), cancelamento, teto de 30 por execução no Nominatim público, provedor configurável, relatório de consumo; chave do provedor **fora do backup** | `geoqueue.test.ts` (13) |
| 8 | Alta | Sem mapa de ruas offline | E2E V2 (fundo liso) | Pacote PMTiles de Santos (2,4 MB, 189 tiles, zoom 0–15), estilo local, fontes Noto locais, hash verificado, atribuição ODbL | E2E "primeira abertura sem internet": 0 requisições externas; `basemap.test.ts` |
| 9 | Média | Lista de paradas renderizava todas as linhas | Leitura | Virtualização (`@tanstack/react-virtual`) | E2E de escala: 14 linhas no DOM para 500 paradas |
| 10 | Média | 21 violações sérias de acessibilidade (contraste do botão "Entregue" 3,3:1, selos, `progressbar` sem nome, regiões roláveis sem foco) | `@axe-core/playwright` | Tokens de contraste AA em claro/escuro, `aria-label`, `tabIndex`/`role=region` | E2E `e2e_v3_a11y.mjs`: **0 violações** em 11 telas × 2 temas |
| 11 | Baixa | Perfil salvo por versão antiga sem campos novos fazia 4 paradas "sem caminho" (descoberto no E2E de mapa) | E2E mostrou ROTA PARCIAL | `getSettings` completa o perfil com os padrões | `basemap.test.ts` |
| 12 | Informativo | Backend ficava atrás do app na mesma matriz (12 134 s × 12 048–12 094 s) | `comparacao_*.json` | Partida a quente no OR-Tools: busca local iterada (2-opt/Or-opt assimétricos, delta provado) + `ReadAssignmentFromRoutes` | `test_best_move_delta_matches_real_cost_change…`, `test_solve_with_warm_start…` |
| 13 | — | Lint do backend não existia | — | `ruff` (E9/F/B), portão no CI | `ruff check` limpo |

## 2. Funcionalidades novas (funcionando e testadas)
- Cache de matriz por **assinatura do ponto na malha** + hash da malha/perfil; mover uma portaria recalcula 1 linha completa + colunas parciais; mudar só status = 0 árvores de Dijkstra. Prova: resultado incremental = reconstrução total (≤ 1e-6) em 4 cenários. Partida a quente na rota anterior.
- Observação por carta (separada do status), exportada.
- Diagnóstico de desempenho exportável **sem nomes, endereços nem coordenadas** (testado).
- Scripts ADB + parser com teste, roteiro de teste físico.
- Cenário de escala (1000 cartas/500 paradas), geradores determinísticos.
- CI: job de backend (PostGIS + ruff + pytest) e job do app com E2E de mapa offline e a11y.

## 3. Segurança
Revisão do diff V2→V3 feita por subagente (`security-review`): **nenhuma vulnerabilidade de alta confiança encontrada** nos pontos
que ele abriu: autorização dos novos endpoints (`get_owned` isola por organização; escrita exige papel), consultas por ORM,
`note` limitado a 200 caracteres, `innerHTML` de `RouteMap` só com texto estático (rótulos vão para `title`/`aria-label`),
workflow sem `pull_request_target` nem campos de evento não confiáveis.
**Ressalva honesta:** o subagente **não abriu** `locations.py`, os demais `core/*.ts`, `offlineMap.ts` nem `AndroidManifest.xml`. Esses eu escrevi
e revisei manualmente (coordenadas validadas, histórico limitado a 20, chave de provedor removida do backup, `allowBackup` desligado),
mas **não houve revisão independente** deles. O mesmo vale para `code-review`, que não foi executado.

## 4. Portões de aceitação (§16 do prompt)
Marcado **só** o que tem log/arquivo real.

**P0**
- [x] Importação íntegra: 300 cartas, 300 IDs, 150 chaves, 3 bairros; 1000/500 também (`data.test.ts`, E2E de escala).
- [x] Exato × aproximado sempre discriminados (selo de confiança 1–6; política `approxPolicy`; resumo no Painel).
- [ ] **Origem confirmada**: o app bloqueia o cálculo sem confirmação, mas a **portaria real do nº 480 não foi confirmada** (bloqueio orientativo mantido; ponto de partida é TESTE).
- [x] Rotas só por arcos da malha; nenhum arco infinito aceito (`validate` em todo plano; testes de força bruta).
- [x] 100 % das cartas contabilizadas como roteadas, a revisar ou excluídas com motivo (status `complete`/`partial`, `notRoutedLetters`).
- [x] GeoJSON e lista com a mesma ordem/quantidade (`itinerario_150_*.csv` × `rota_150_*.geojson`, 150 pontos numerados).
- [x] Entregas/eventos idempotentes e persistentes após recarga/offline/reimportação (E2E-12/13, `metamorphic.test.ts`).
- [x] Testes de regressão existentes continuam passando (V2 E2E reexecutado: tudo PASSOU; suítes abaixo).
- [ ] Persistência após **fechamento forçado em aparelho real** e memória em aparelho modesto: **não testado** (sem aparelho).

**P1**
- [x] Geocodificação em lote com fluxo seguro: fila, teto no Nominatim público, provedor configurável (testado com provedor **simulado**).
- [ ] Geocodificação **ao vivo** com provedor contratado/próprio: **não executada** (sem credenciais/serviço). Cenário C **BLOQUEADO**.
- [x] Portarias reutilizáveis e versionadas (histórico + reversão) — app e backend.
- [x] Mapa offline com ruas implementado e testado no Chromium (E2E, 0 chamadas externas).
- [ ] Benchmark em Android real: **NÃO EXECUTADO**; roteiro e scripts prontos.
- [x] Comparativo backend × TS em entradas idênticas, com discrepâncias explicadas (`RESULTADOS_V3.md`).
- [~] Termos/status consistentes entre backend, web e app: backend e app alinhados (hierarquia de confiança, `time_breakdown`); o frontend Next.js **não foi atualizado** (não consome os campos novos).

**P2**
- [x] Fluxo mobile responsivo auditado visualmente (capturas em `EVIDENCIAS_V3/`) e por axe.
- [x] Relatório e exportações seguras (fórmulas neutralizadas; observação de campo coberta).
- [x] Documento de operação (`TUTORIAL_USO_DIARIO.md`) e limitações (`LIMITACOES_OPERACIONAIS_V3.md`).

## 5. Pedidos do prompt V3 que NÃO foram feitos
| Pedido | Situação |
|---|---|
| Entidades `access_path` e `network_snap` persistidas | O ponto na malha e o tempo de acesso são calculados a cada plano e vão em `metrics`/itinerário; **não há tabela própria**. Persistidos: posição, portaria e histórico |
| `cartographic_neighborhood` separado do bairro informado | Não implementado |
| Edição em lote de várias portarias com seleção múltipla | Há sequência rápida (confirma e abre a próxima), **sem** seleção múltipla; nunca autoconfirma por proximidade |
| Sincronização opcional entre aparelhos | Não implementada |
| Tempo de acesso calibrável e modelagem por arco | Mantida a fórmula 2×snap÷velocidade a pé (analisada em `LIMITACOES_OPERACIONAIS_V3.md` #8); não é configurável |
| Estimativa de serviço por tipo de parada (casa/portaria/comercial) | Não implementada (só base + por carta extra) |
| Multipolígonos de praça | Não implementado (conservador) |
| Cache de geocodificação com validade/termos por provedor | Há aviso de confirmação antiga (> 365 dias) e invalidação manual; o cache de consultas não expira |
| `code-review` / `simplify` | Não executados |
| APK release assinado | Depende da sua chave (`mobile/SIGNING.md`) |
| Teste em celular | BLOQUEADO |

## 6. Como reproduzir
```bash
cd backend && ruff check app roteamento scripts tests && python -m pytest -q          # 100 passaram, 2 pulados
cd mobile  && npx tsc --noEmit && npx vitest run                                       # 82 passaram, 2 pulados (benchmarks BENCH=1)
cd mobile  && python3 -m pytest -q scripts/adb/test_parse_adb.py                       # 3 passaram
cd mobile  && npm run build && npx vite preview --port 4173 &                          # depois:
node e2e/e2e_v3_offline_map.mjs && node e2e/e2e_v3_a11y.mjs && node e2e/e2e_v3_scale.mjs && node e2e/e2e_v2.mjs
cd backend && python -m scripts.cenario_150_real --time-limit 30 --out test-data/v3/rota_150
cd backend && python -m scripts.benchmark_v2 --time-limit 15 --tag v3
cd mobile  && BENCH=1 npx vitest run bench/                                            # benchmarks do app (Node)
python mobile/scripts/extract_basemap.py                                               # refaz o pacote de mapa offline
```
