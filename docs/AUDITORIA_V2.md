# Auditoria V2 — Rota Santos

Branch `claude/pedestrian-routing-system-ktxozj`. Auditoria, correção e testes do código **existente**
(backend FastAPI/PostGIS/OR-Tools, frontend Next.js e app Android offline Vite + Capacitor).
Nada foi recriado do zero.

Ambiente de execução de todos os testes deste documento: contêiner Linux 6.18 x86_64, Intel Xeon 2,1 GHz,
4 vCPU, Python 3.13, Node 22, PostgreSQL 16 + PostGIS, Redis, Chromium headless (Playwright), Android SDK 36
(build-tools 36.0.0), JDK 21. **Não houve celular nem emulador** (o contêiner não tem `/dev/kvm`).

Commits da auditoria (em ordem): `5b823dc` fixtures · `2278518` backend · `446a6e5` app · `a83e78d` cenário real
150 + paridade · `cb66f12` E2E V2 e correções que ele revelou · `0563672` benchmarks backend · `25168dc` benchmark do app ·
`0a73480` APK 1.1.0 e assinatura release · documentação, teste [G] e correção de fixture (commit seguinte).

## Como reproduzir

```bash
cd backend && pytest -q                          # 82 passed, 2 skipped (test_live_network: exige RUN_NETWORK_TESTS=1 e internet)
cd backend && pytest tests/test_audit_v2.py -q   # 14 testes focados nos alertas
cd mobile  && npm test                           # 36 testes (vitest), inclui paridade backend x app; 1 pulado = benchmark
cd backend && python -m scripts.cenario_150_real --time-limit 30
cd backend && python -m scripts.benchmark_v2 --time-limit 15
cd mobile  && BENCH=1 npx vitest run bench/      # mesmos pontos, implementação do app (Node)
cd mobile  && node e2e/e2e_v2.mjs                # E2E no navegador (precisa de `npm run preview`)
```

A evidência "antes da correção" está em `docs/EVIDENCIAS_E2E_V2/repro_antes_correcao.txt`. É a saída dos testes
novos rodados contra o código anterior: 8 falharam e 1 passou. Os 4 testes restantes da época foram
desmarcados porque dependiam de funções que ainda não existiam.

## Matriz de alertas

Legenda de resultado: **CONFIRMADO** (o problema existia e foi reproduzido), **PARCIAL** (existia em parte),
**NÃO REPRODUZIDO** (o código já estava correto). Correção: **CORRIGIDO**, **PARCIAL** ou **PENDENTE**.

| # | Sev. | Hipótese | Arquivo / função | Teste | Evidência antes | Resultado | Correção |
|---|---|---|---|---|---|---|---|
| A | Crítica | O solver aceita par impossível porque `UNREACH=10**11` é uma penalidade finita | `backend/app/services/optimization.py` `solve`; `planner.py` `plan` | `test_A_infeasible_pair_yields_partial_route_not_crash`, `test_A_solver_never_returns_impossible_arc` | O OR-Tools devolveu uma sequência com arco de custo ≥ 10¹¹; `plan()` não tinha o campo `status` | CONFIRMADO | CORRIGIDO |
| B | Alta | Eleger a maior componente fortemente conexa rejeita paradas alcançáveis a partir da origem | `backend/roteamento/router.py` (`main_comp`); `mobile/src/core/router.ts` (`mainComp`) | `test_B_origin_in_smaller_component_routes_there`, `test_B_stop_in_other_component_is_excluded_with_reason`; `audit.test.ts [B]` | Origem numa ilha menor gerava "Ponto de partida fora da malha" | CONFIRMADO | CORRIGIDO |
| C | Alta | Snap de até 150 m "teletransporta" o ponto através de quadras; o acesso não entra no ETA | `router.py` `snap`, `_crosses_other_edge`; `planner.py` | `test_C_access_crossing_other_street_is_flagged`, `test_C_access_time_included_in_eta`; `audit.test.ts [C]` | `KeyError: 'snap_review'` e `'access_time_s'`: não havia evidência nem tempo de acesso | CONFIRMADO | CORRIGIDO (portaria real: PARCIAL, ver G) |
| D | Alta | O CSV era cortado em linhas antes do parse e quebrava campos citados com quebra de linha | `mobile/src/core/importer.ts` `parseText`/`csvSplit`; `backend/app/services/importer.py` | `test_D_csv_quoted_newline_is_one_record`, `test_D_adversarial_fixture_counts`; `audit.test.ts [D]` | O cabeçalho saía como `'﻿id;rua;…'` (BOM não removido) | CONFIRMADO (BOM no backend; quebra de linha no app) | CORRIGIDO |
| E | Alta | No modo aberto o serviço da última parada some do objetivo do OR-Tools | `optimization.py` `solve`/`evaluate` | `test_E_objective_equals_evaluated_time[open/circular/fixed]`; `audit.test.ts [E]` | Divergência teórica; o teste novo prova igualdade nos 3 modos | PARCIAL | CORRIGIDO |
| F | Alta | O otimizador do app trata impossível como `BIG` finito e devolve a sequência | `mobile/src/core/optimizer.ts` | `audit.test.ts [F]` (par impossível, becos, 40/120/150/300 paradas × várias sementes × p(inf)) | `T=[[0,5,5],[inf,0,inf],[inf,inf,0]]` → ordem `[2,1]`, tempo `Infinity`, aceita como melhor | CONFIRMADO | CORRIGIDO |
| G | Alta | Chave de endereço e bairro: rua que cruza bairros, homônimos, complemento, entradas | `normalize.py` `key`; `normalize.ts` `normalizeAddress` | `test_G_address_key_ignores_neighborhood_and_complement_but_not_street_type` e `audit.test.ts [G]` (ADV07/08/09/10/11/12/25/26/27) | A chave já ignorava bairro e complemento e distinguia tipo de via e município | NÃO REPRODUZIDO na chave; PENDENTE na separação posição/entrada/snap | PARCIAL |
| H | Alta | Importação e segurança: injeção de fórmula, duplicidade, idempotência, backup | `reports.py` `safe_cell`; `service.ts` `safeCell`, `recordEvent`, `backupJson` | `test_H_csv_xlsx_formula_injection_neutralized`; `data.test.ts`; E2E-04/05/20 | `=HYPERLINK(...)`, `+55…` e `-2+3` exportados sem escape | CONFIRMADO | CORRIGIDO |
| I | Alta | Benchmark antigo (pontos aleatórios em toda a malha; 121,42 km e 16 exclusões) não representa a zona | `backend/scripts/benchmark.py`, `docs/benchmarks.md` | `backend/scripts/benchmark_v2.py` + `mobile/bench/benchmark_v2.test.ts` | Pontos espalhados por Santos inteira, e não nos 3 bairros | CONFIRMADO | CORRIGIDO (benchmark novo; histórico preservado) |
| J | Alta | "Offline" no README, mas o fundo do mapa depende de internet; APK listado era debug | `RouteMap.tsx`; `worker.ts`; `android/app/build.gradle` | E2E "J-mapa-offline", E2E-13; `apksigner verify` | Mapa em branco sem rede; só existia `assembleDebug` | CONFIRMADO | CORRIGIDO (sem tiles offline completos: ver limites) |
| K | Média/Alta | Praças só como polígono simples (sem multipolígono); cruzamentos sem nó; pontes e túneis | `backend/roteamento/network.py` | `test_crossing_without_shared_node_is_not_a_connection`, `test_parallel_streets_close_but_unconnected_are_flagged`, `test_degenerate_and_concave_areas_do_not_create_shortcuts`, `test_wall_and_locked_gate_block` | Cruzamento sem nó e camadas diferentes já não conectavam; multipolígono de praça não suportado | PARCIAL | PARCIAL (multipolígono: PENDENTE) |
| L | Média | Prefixo fixo inválido era ignorado em silêncio | `planner.py` `_validate_fixed`; `plan.ts` | `test_L_invalid_fixed_ids_are_rejected` (duplicada, inexistente, excluída, sem cartas pendentes) | Um ID inválido sumia e a rota era calculada mesmo assim | CONFIRMADO | CORRIGIDO |

## Detalhes por alerta

### A — par impossível no solver (crítico, P0)

**Repro mínimo:** origem com caminho para `a` e para `b`, mas `T[a,b]` e `T[b,a]` infinitos (dois becos sem
saída de mão única de pedestre). Antes, o OR-Tools recebia `10**11` como custo e, sem alternativa, devolvia
`[a, b]`. Depois a geometria `session.leg(a,b)` falhava.

**Correção** (`optimization.py`):
1. `feasibility()` aplica Tarjan sobre a relação "j alcançável a partir de i" restrita às paradas. Monta o DAG
   da condensação e escolhe a cadeia de maior peso a partir da origem (e até o fim, se houver). As paradas
   fora da cadeia saem com motivo: *"inalcançável a partir da origem"*, *"sem caminho para/de outras paradas
   nesta ordem"* etc.
2. `solve()` avalia cada candidato com `validate()`: zero arcos infinitos, visitas únicas, início e fim
   corretos. Um candidato inválido é marcado `feasible: false` e nunca vence. Se ainda houver arco inválido,
   `repair()` reordena por posto de componente.
3. `planner.plan()` publica `status: "partial"` com a lista `excluded`, levanta `PlanError("Rota inválida")` se
   `validate` falhar e confere ETA = `evaluate()` ao fim.

Na interface (web e app), a rota parcial mostra uma faixa **PARCIAL — N paradas não roteadas** com os motivos.
Ela nunca aparece como sucesso.

### B — componente operacional a partir da origem

`main_comp`/`mainComp` foram removidos. O router indexa todas as arestas utilizáveis.
`snap_origin` testa os candidatos a até 30 m do mais próximo e fica com o que alcança mais nós. A partir dele,
`reach_from` (BFS no CSR) define a componente operacional. As paradas são encaixadas apenas em arestas cujo
extremo seja alcançável (`edge_reachable`). Se a origem alcança menos de 1% da malha, ela recebe a flag
`origem_em_trecho_isolado` e o app avisa "confira o pino de partida".

### C — snapping com evidência

O `Snap` passou a ter `confidence` (alta ≤ 15 m, boa ≤ 30 m, média ≤ 60 m, baixa acima disso), `nearest_any_m` e
`flags`:
- `acesso_cruza_outra_via`: o segmento ponto→snap cruza outra aresta (`_seg_cross`);
- `via_mais_proxima_desconectada`: há uma via mais perto que não pertence à componente operacional.

O tempo de acesso `2 × snap / velocidade a pé` entra no serviço da parada, portanto no objetivo e no ETA.
Paradas com snap acima de `snap_review_m` (30 m por padrão) ou com flags vão para `snap_review` e aparecem como
"Conferir posição". O app aceita marcar a posição manualmente. A separação formal entre
`position_of_address`, `entrance_point` e `snapped_network_point` no banco do backend **não foi feita** (ver G).

### D — CSV RFC 4180

- **App:** `csvRecords()` percorre o texto inteiro, respeitando aspas, `""`, CRLF/LF e quebras de linha dentro de
  campos. `detectDelimiter()` escolhe `;`, `,`, TAB ou `|` pela consistência do número de campos por registro
  (vírgula só com cabeçalho). O BOM é removido.
- **Backend:** `csv.reader` sobre o texto inteiro, com `newline=""` e BOM removido.
- **Fixture:** `casos_adversariais_30.csv` → 30 registros, 1 erro (ADV04 sem logradouro). Nenhuma linha some.

### E — objetivo único

Arco OR-Tools = `tempo_ms × 10^6 + metros` (lexicográfico: tempo, depois distância). No modo aberto, o arco até
o nó fictício carrega o serviço da última parada. A prioridade usa limite superior suave com coeficiente
`p·W`; a troca de setor custa 300 s.

`evaluate()` (Python e TS) calcula a mesma soma. O teste prova
`objetivo_solver/10^6 ≈ evaluate ≈ ETA final` (1 s de tolerância) nos modos aberto, circular e destino fixo.
Critério de escolha entre candidatos: factível → cobre todas as paradas mantidas → `cost_s` → distância.

### F — otimizador do app

`optimizer.ts` foi reescrito com construção NN e inserção mais barata, 2-opt e Or-opt com delta O(1) correto
para matriz **assimétrica** (somas de prefixo nos sentidos direto e reverso, mais contagem de infinitos) e ILS
multi-semente com *double-bridge* e parada por estagnação. Toda solução passa por `validateRoute()`; uma
sequência com arco infinito nunca é aceita. Testes com 40, 120, 150 e 300 paradas, `p(inf)` de 0 a 0,05 e várias
sementes. Na matriz real de 150 paradas, o app ficou entre 99,46% e 99,71% do tempo do OR-Tools
(`parity.test.ts`).

### G — chave de endereço e bairro

Chave = `tipo|nome|número|município|UF`, normalizada (acentos, abreviações `R.`, `Av.`, `Cons.`, maiúsculas,
NBSP, espaços, `108.0`→`108`, `0110`→`110`).
- O **bairro** fica fora da chave. Assim, a Av. Conselheiro Nébias, que cruza Vila Nova e Paquetá, não vira duas
  paradas, e um bairro errado no CSV não duplica a parada.
- O **complemento** também fica fora. Apartamentos da mesma entrada são uma parada com várias cartas, e cada
  carta mantém seu ID e status.
- O **tipo de via** e o **município** entram na chave. Rua × Avenida Conselheiro Nébias são chaves distintas
  (ADV27), assim como Santos × São Vicente.

**Correção de fixture.** O gerador rotulava ADV12 como "mesma chave do ADV11", mas usava uma *Praça* em ADV12 e
"R." (Rua) em ADV11. O app estava certo em separar as duas. O gerador agora usa um logradouro do tipo Rua nos
dois casos, e o novo teste exige ADV11 = ADV12, ADV25 = ADV26 e ADV25 ≠ ADV27.

**Pendente:**
- tabela própria de entradas (portaria confirmada pelo entregador, separada da posição do endereço);
- uso do CEP para desambiguar homônimos;
- interpolação numérica sinalizada.

Hoje a hierarquia de confiança é `manual` (pino confirmado) > `exact` > `street` (via encontrada, número não) >
`neighborhood` > não encontrado. Somente `manual`, `exact` e `test` entram na rota; `street` exige confirmação.

### H — importação e segurança

- **Injeção de fórmula:** `safe_cell`/`safeCell` prefixam `'` em células que começam com `= + - @ TAB CR`. No
  XLSX a célula é forçada a texto. O texto original é preservado.
- **XSS:** o React escapa por padrão e não há `dangerouslySetInnerHTML`. ADV15 (`<script>`, `<img onerror>`)
  aparece como texto (captura `03-adversariais-previa.png`).
- **Reimportação:**
  - o app calcula o `sha256` do conteúdo e pede confirmação explícita (`DuplicateImportError`);
  - IDs repetidos no arquivo ou no banco são contados como duplicados, não inseridos;
  - no backend, a restrição única `(usuário, client_event_id)` torna o envio concorrente do mesmo evento idempotente (`IntegrityError` → devolve o evento já gravado).
- **Idempotência:** `recordEvent` não grava evento se o status não muda. A UI otimista bloqueia toque duplo.
  Este bug foi **achado pelo E2E** e corrigido em `cb66f12`.
- **Backup:** JSON opcionalmente cifrado (AES-GCM, PBKDF2-SHA256 210k iterações, senha do usuário).
  - A restauração valida a integridade antes de tocar no banco.
  - Ela grava um *snapshot* pré-restauração e permite desfazer.
  - Um backup inconsistente é recusado sem alterar dados (`data.test.ts`).

### I — benchmark representativo

O benchmark novo (`benchmark_v2.py`) gera 8 cenários com **nós OSM dentro dos polígonos OSM** de Centro (relação
18922323), Paquetá (18922322) e Vila Nova (18933692). Os pontos são salvos em `test-data/benchmarks/*.json`, e o
app roda **os mesmos pontos**. O histórico (`docs/benchmarks.md`) foi preservado. Resultados em
`RESULTADOS_COMPARATIVOS_V2.md`.

### J — offline e APK

- **Malha:** embutida (`santos-graph.bin`), com `sha256`, data de extração e fonte em `santos-graph.json`. O worker
  confere o hash antes de usar.
- **Fundo do mapa:** sem internet ou após 10 s sem carregar, o MapLibre troca para um estilo de contingência
  local (fundo liso + rota + paradas numeradas, fonte Noto Sans embutida) e exibe a faixa "Mapa-base
  indisponível". O roteamento continua 100% local. **Não há tiles offline**: as ruas de fundo só aparecem com
  internet ou cache.
- **Geocodificação:** depende de internet, com cota diária configurável (250 por padrão). Não há geocodificação
  automática na importação de mais de 20 endereços.
- **APK:**
  - a assinatura release é separada da debug e vem só de variáveis de ambiente ou GitHub Secrets;
  - `*.jks`, `*.keystore` e `keystore.properties` estão no `.gitignore`;
  - o CI publica o SHA-256 e falha se o release vier assinado com `CN=Android Debug`;
  - ver `mobile/SIGNING.md`.

### K — geometria OSM

Cobertos por teste:
- vias que se cruzam sem nó comum não conectam (inclusive ponte sobre rua com `layer` diferente);
- vias paralelas próximas sem ligação recebem a flag;
- muro e portão trancado bloqueiam;
- polígono côncavo ou degenerado não cria atalho;
- escadas permitir/penalizar/proibir;
- *oneway* de carro ignorado e *oneway* de pedestre respeitado;
- matriz igual à do NetworkX em grafos de referência.

**Pendente:** praças mapeadas como multipolígono (relação `type=multipolygon`) não ganham travessias internas e
são percorridas só pelo contorno. Isso é conservador (nunca inventa caminho), mas pode alongar trechos.

### L — prefixo fixo

`_validate_fixed` (backend) e `computePlan` (app) recusam uma parada fixa **duplicada**, **inexistente**,
**excluída** ou **sem cartas pendentes** com mensagem explícita. O trecho livre é otimizado a partir da última
fixa, e o prefixo entra em `validate`, no ETA e na prioridade.

## Bugs encontrados pelos testes novos (além dos alertas)

| Achado | Onde | Correção |
|---|---|---|
| Toque duplo em "Entregue" gravava dois eventos | `RoutePage.tsx`, `service.ts recordEvent` | UI otimista + evento idempotente |
| Permissão de GPS sem resposta travava "Recalcular da minha localização" para sempre | `RoutePage.tsx getPosition` | Watchdog de 15 s; segue sem GPS |
| GPS fora da malha (outra cidade) gerava erro no recálculo | `RoutePage.tsx` | Recalcula a partir da última parada atendida, com aviso |
| Fixture adversarial ADV11/ADV12 com tipos de via diferentes | `test-data/gerar_casos.py` | Gerador corrigido (ver G) |
| Cenário "desconexo" do benchmark não excluiu nada: os 10 nós fora do alcance encaixaram em arestas alcançáveis a menos de 150 m | `benchmark_v2.py` | Registrado sem maquiar; a exclusão está provada nos testes unitários [A]/[B] |

## Resumo honesto de testes

### Passaram (executados neste ambiente)

**Automatizados:**
- Backend `pytest`: 82 passaram e 2 foram pulados (os dois dependem de rede externa).
- App `vitest`: 36 passaram.
- Paridade backend × app: matriz 151×151 com diferença relativa máxima de 0,137%. A ordem do app ficou a 0,54% do
  OR-Tools no pior caso. Snaps e flags iguais.

**Cenário B real (150 posições TESTE):**
- Rota aberta: 150/150 paradas, 300/300 cartas, 15,53 km, 201,9 min.
- Rota circular: 17,57 km, 210,0 min.
- GeoJSON e itinerário gravados.

**E2E no navegador** (Chromium headless, build de produção do app):
- **E2E-01:** importação de 300 cartas.
- **E2E-04:** reimportação exige confirmação.
- **E2E-05:** 30 casos adversariais.
- **E2E-06:** zero consultas de geocodificação na importação.
- **E2E-07:** 150 paradas, 15,0 km, 3 h 20 min.
- **E2E-08:** rota aberta.
- **E2E-09:** rota circular.
- **E2E-11:** parada parcial.
- **E2E-12:** 50 entregues persistem após recarregar e o recálculo só visita pendentes.
- **E2E-13:** offline, 30 entregas a mais persistem.
- **E2E-14:** parcial, ver abaixo.
- **E2E-16:** cancelar a otimização não grava versão.
- **E2E-20:** exportação das 300 cartas com SHA-256.
- **J:** mapa de contingência.

Logs em `docs/EVIDENCIAS_E2E_V2/e2e_v2_log.txt` e `e2e_v2_resultados.json`; 13 capturas na mesma pasta.

**Benchmarks:**
- backend: 8 cenários;
- app: os mesmos 8 cenários, em Node no desktop.

**Builds:**
- APK 1.1.0 debug e release sem assinatura (`assembleRelease`);
- assinatura release testada com uma chave descartável fora do repositório: `apksigner` verificou, sem
  `debuggable`.

### Parciais

- **E2E-02:** o conjunto importado independe da ordem das linhas (`data.test.ts`), e a mesma entrada dá o mesmo
  resultado (`test_reproducible_with_same_inputs`). A rota final com o CSV embaralhado não foi comparada
  ponta a ponta.
- **E2E-03:** coberto pela chave (G) e pelas 150 chaves do cenário; sem teste E2E dedicado na interface.
- **E2E-10:** o prefixo fixo foi validado em testes de unidade (L). O botão "fixar como próxima" existe, mas não
  foi exercitado no E2E.
- **E2E-14:**
  - Exercitado: GPS sem resposta → aviso, e o app continua.
  - Não exercitado: o Chromium headless não entregou a coordenada falsa de São Paulo, então o ramo "posição
    fora da malha → recalcular da última parada" ficou sem execução E2E. Esse ramo foi lido no código, mas não
    foi executado no navegador.
- **E2E-18:** coberto por testes de unidade [A]/[F] e por `validate` em todo plano; sem cenário E2E com malha
  quebrada.

### Não executados / bloqueados

- **Celular real (Moto G15 ou outro) e emulador Android:** bloqueado. O contêiner não tem KVM nem aparelho. Nenhum
  número deste repositório deve ser lido como medição em celular.
- **E2E-15:** tempo real × ETA exige jornada real em campo.
- **E2E-17:** editar um pino e invalidar só os trechos afetados. O app recalcula a matriz inteira a cada plano
  (cerca de 0,3 s para 150 paradas em Node), então não há invalidação parcial a testar.
- **E2E-19:** 2000 cartas não foram rodadas. 500 e 1000 cartas foram rodadas como benchmark (backend e app em
  Node).
- **Cenário C (geocodificação real de amostra verificada):** bloqueado. Não há fonte cartográfica validada de
  números de porta, e a política do Nominatim público proíbe lote. Só a origem foi consultada uma vez. O
  Nominatim devolveu o **centro** da Rua Joaquim Távora; o nº 480 não foi localizado. Por isso a origem é um
  **PONTO TESTE** e precisa ser confirmada no app (Ajustes → Ponto de partida → Localizar endereço → arrastar o
  pino até a porta → "Confirmar o pino como ponto de partida"). Sem isso o app não calcula a rota.
- **APK release assinado com a chave do dono:** depende de o usuário criar a chave e cadastrar os GitHub Secrets.
- **Imagem Docker do backend:** o build falhou por limite de taxa (429) do Docker Hub neste ambiente.
- **Rede instável a 20%, falta de armazenamento, fechamento forçado em aparelho:** não simulados. O E2E cobre
  só offline total e recarga da página.

## Limites conhecidos (documentados, não escondidos)

- OSM pode ter calçadas, travessias e portões desatualizados. O roteamento nunca cria ligação que não está no
  OSM.
- O ponto encaixado é sobre a via, não na porta. Os tempos usam 45 s por parada + 10 s por carta extra +
  acesso, e esses valores são configuráveis e **não calibrados em campo**.
- O mapa-base offline completo exigiria um pacote de tiles licenciado (por exemplo, PMTiles de Santos). Hoje há
  apenas o fundo de contingência.
- O Nominatim público serve para uso pessoal e pontual. Para centenas de endereços por dia, é preciso uma
  instância própria ou um serviço contratado.
