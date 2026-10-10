# Resultados V3 — antes (V2) × depois (V3)

**Todas as medições vêm de contêiner Linux (Xeon 2,1 GHz, 4 vCPU), Node 22 e Chromium headless com WebGL por software.
Nenhuma é de celular.** Dados: cartas fictícias; posições TESTE (nós OSM sobre as vias), **não são portas**; ponto de partida TESTE.
Arquivos de origem em `test-data/v3/`, `test-data/benchmarks/` e `docs/EVIDENCIAS_V3/`.

## 1. Cenário B — 300 cartas / 150 paradas (Centro, Paquetá, Vila Nova), mesma matriz
Mesmos dados e mesma matriz (conferido: `paridade_150_open.json` V2 = V3, bit a bit). SHA-256 das entradas:
cenário `ad9a0dd4…`, posições `467295b3…`. Malha `462dd3ef7b847815` (41 598 nós / 48 747 trechos).

| | V2 (limite 30 s) | V3 (limite 30 s) |
|---|---|---|
| Aberta: paradas / cartas roteadas | 150 / 300 | 150 / 300 |
| Aberta: distância | 15,527 km | **15,478 km** |
| Aberta: tempo total | 201,9 min | **201,3 min** (viagem 63,8 + serviço 137,5 + acesso 0,0) |
| Aberta: estratégia vencedora | `path_cheapest_arc` | `ils_python+guided_local_search` |
| Circular: distância / tempo | 17,565 km / 210,0 min | **17,359 km / 209,2 min** |
| Exclusões (snap / factibilidade) | 0 / 0 | 0 / 0 |
| ETA = avaliação do objetivo | sim | sim |

A melhora é pequena (≈ 0,3 %) e **dentro da variação entre execuções**; o ganho útil da V3 aqui é no **orçamento curto**:

| Backend, matriz idêntica | 5 s | 15 s | 60 s |
|---|---|---|---|
| OR-Tools **V2** | 12 133,6 s · 15,61 km | 12 133,6 s · 15,61 km | 12 084,5 s · 15,54 km |
| OR-Tools **V3** (partida a quente) | 12 111,0 s · 15,52 km | **12 076,5 s · 15,48 km** | 12 101,0 s · 15,49 km |

(`comparacao_backend.json` = V3; saída bruta do código V2 em `comparacao_backend_otimizador_V2_saida_bruta.txt`.)
Com 60 s a V3 ficou *pior* que com 15 s: OR-Tools com Guided Local Search tem aleatoriedade e **não garante ótimo**; o tempo extra não é
garantia de melhora.

### App (TypeScript) × backend na MESMA matriz e MESMO objetivo (tempo físico)
| | menor | maior | média |
|---|---|---|---|
| App, 3 s (5 sementes) | 12 070,7 s | 12 094,5 s | 12 081,9 s |
| App, 6 s | 12 048,0 s | 12 094,5 s | 12 074,7 s |
| App, 15 s | 12 048,0 s | 12 078,0 s | 12 060,7 s |
| Backend V3, 15 s | 12 076,5 s | | |
| Backend V2, 15 s | 12 133,6 s | | |

Nesta instância o **app encontra rotas iguais ou melhores** que o OR-Tools. Isso **não** prova que o app seja melhor em geral (uma instância,
5 sementes), e **nenhum dos dois garante ótimo**. A diferença para a V2 ("app a 99,5 %–99,7 % do OR-Tools") é só a forma de
dizer: o app já estava um pouco melhor.

### Por que o E2E dava 15,0 km e o backend 15,53 km
Pontos de partida diferentes. O E2E usa a resposta ao vivo do Nominatim (−23,9489139; −46,3336801); o backend usa o ponto fixo
(−23,9480025; −46,3406209), ~700 m a oeste. Com a **mesma** origem o app dá 15,35–15,50 km. O Nominatim muda de ponto para a mesma
rua: por isso a origem tem que ser confirmada à mão.

## 2. Benchmarks de escala (8 cenários, 15 s por solver)
`Δ` = V3 menos V2. Backend e app no mesmo conjunto de pontos (Centro/Paquetá/Vila Nova), Node/desktop.

| Cenário | Paradas / cartas | Backend V2 km | Backend V3 km | Δ | App V2 km | App V3 km | Ganho V3 sobre vizinho-mais-próximo |
|---|---|---|---|---|---|---|---|
| c300_150 | 150 / 300 | 15,53 | 15,48 | −0,3 % | 15,36 | 15,36 | 4,9 % |
| c300_300 | 300 / 300 | 21,53 | 21,23 | −1,4 % | 21,34 | 21,34 | 5,5 % |
| c500_250 | 250 / 500 | 21,17 | 20,34 | −3,9 % | 20,28 | 20,28 | 4,2 % |
| c1000_500 | 500 / 1000 | 25,61 | 25,04 | −2,2 % | 25,21 | 25,51 | 3,1 % |
| meia_rua | 114 / 228 | 13,82 | 13,50 | −2,3 % | 13,62 | 13,62 | 7,1 % |
| meio_predio | 76 / 300 | 6,80 | 6,80 | 0 | 6,80 | 6,80 | 3,2 % |
| desconexo* | 150 / 290 | 17,28 | 16,82 | −2,7 % | 16,81 | 16,81 | 8,3 % |
| vizinhos | 120 / 240 | 13,64 | 13,64 | 0 | 13,67 | 13,67 | 4,6 % |

*"desconexo" **não excluiu nada**: os nós inalcançáveis sorteados ficaram a < 150 m de arestas alcançáveis e foram encaixados nelas; a exclusão
está provada nos testes unitários, não neste cenário.
App `c1000_500`: 25,51 km na V3 × 25,21 na V2 (+1,2 %), mesmo código do otimizador: é variação entre execuções (limite de tempo), não regressão deliberada.
Exclusões: 0 em todos os cenários. Pico de RAM do backend (RSS): 237–414 MB; heap JS do app em Node: 64–190 MB.
Tempo total de cálculo do app em Node: 3,5 s (76 paradas) a 23 s (500 paradas).

## 3. Cache de matriz (150 paradas, Node)
| Situação | Tempo (mediana de 5) |
|---|---|
| Matriz completa | 338,8 ms |
| Só mudou o status (100 pendentes), sem cache | 217,8 ms |
| Idem, **com cache** (0 árvores de Dijkstra) | **35,0 ms** |
| Uma portaria movida, com cache | 175,8 ms |

Os ganhos são reais mas **pequenos em valor absoluto**: a matriz é a parte barata do cálculo (o otimizador gasta segundos). No celular os
tempos serão maiores e **não foram medidos**. A partida a quente é o ganho mais útil para replanejar.

## 4. Escala no navegador — 1000 cartas / 500 paradas (E2E, Chromium headless)
| Medida | Resultado |
|---|---|
| Importação (1000 linhas, 500 imóveis) | 0,6 s |
| Cálculo no navegador (limite 10 s) | 20,5 s; 500 paradas, 25,5 km, completa |
| Linhas de lista no DOM | **14** (de 500; lista virtualizada) |
| Rolar a lista inteira | com o mapa ligado: 17,2 s, 170/172 quadros > 50 ms; **sem o mapa: 3,3 s, 3/169 > 50 ms** |
| Heap JS reportado | 48 MB (granularidade grosseira do Chromium) |
| Erros de página | 0 |

A lentidão com mapa ligado vem do WebGL **por software** do Chromium headless (500 marcadores + camadas de texto); o custo da lista é pequeno.
Num celular com GPU o comportamento pode ser bem diferente: **não medido**.

## 5. Mapa-base offline
Primeira abertura **sem internet** (toda requisição externa bloqueada e contada): selo "Mapa offline (pacote de Santos)", ruas e nomes visíveis,
rota e 150 paradas, **0 requisições externas**, 0 erros (`e2e_v3_offline_map_resultados.json`, capturas 20–22).
Pacote: `santos.pmtiles` 2 463 210 bytes, SHA-256 `c00cfe90…`, 189 tiles, zoom 0–15, compilação Protomaps 2026-10-10, © OpenStreetMap (ODbL).
O APK passou de 5,8 MB (1.1.0) para 8,7 MB (1.2.0).

## 6. Acessibilidade (axe-core, WCAG 2 A/AA, mapa excluído)
| | Violações sérias/críticas |
|---|---|
| Antes (V2 reexecutada) | **21** (contraste do botão "Entregue" 3,3:1, selos, progressbar sem nome, regiões roláveis) |
| Depois (V3) | **0** em 11 telas × claro/escuro |
Só cobre o que o axe detecta; **não** substitui teste com leitor de tela no aparelho.

## 7. Testes
| Suíte | V2 (baseline) | V3 |
|---|---|---|
| Backend `pytest` | 82 passaram, 2 pulados | **100 passaram, 2 pulados** (os 2: internet) |
| App `vitest` | 36 passaram, 1 pulado | **82 passaram, 2 pulados** (benchmarks `BENCH=1`) |
| Parser ADB | — | 3 passaram |
| `ruff` / `tsc --noEmit` | — / limpo | limpo / limpo |
| E2E V2 reexecutado (E2E-01,04,05,06,07,08,09,11,12,13,14,16,20 e mapa) | todos passaram (15 itens) | **todos passaram (15 itens)** (E2E-14 agora cobre o ramo "GPS fora da malha") |
| E2E V3: mapa offline / a11y / escala | — | passaram (3/3, 0 violações, 6/6) |
Não executados: E2E-15 (tempo real × ETA), E2E-17 de ponta a ponta no navegador (coberto no nível do cache), E2E-19 com 2000 cartas, Android real.

## 8. Rotas de 300 cartas / 300 paradas (pior caso)
Backend 21,23 km / 5,30 h; app 21,34 km / 5,31 h (benchmark `c300_300`, posições TESTE). Exclusões: 0.
