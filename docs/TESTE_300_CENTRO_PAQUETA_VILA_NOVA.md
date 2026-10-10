# Teste 300 cartas — Centro, Paquetá e Vila Nova (Santos/SP)

> **Dados 100% fictícios.** Destinatários, IDs e números de porta são sintéticos. Os números **não foram
> verificados**. As posições usadas no roteamento são **POSIÇÕES TESTE** (nós OSM sobre as vias), não portas.
> Os tempos são estimativas do modelo, não medições de entrega.

## 1. Dados de entrada (cenário A — importação)

Gerador determinístico: `test-data/gerar_casos.py`, semente `20261009`. Manifesto com SHA-256 em
`test-data/manifesto_testes.json`.

| Item | Esperado | Verificado (backend, app e E2E) |
|---|---|---|
| Cartas | 300 | 300 |
| IDs distintos | 300 | 300 |
| Chaves de imóvel | 150 | 150 |
| Centro | 60 chaves / 120 cartas (10 vias) | 60 / 120 |
| Paquetá | 50 chaves / 101 cartas (10 vias) | 50 / 101 |
| Vila Nova | 40 chaves / 79 cartas (9 vias) | 40 / 79 |
| Multiplicidade | 10 × 4 cartas, 120 × 2, 20 × 1 | idem |
| Formato | UTF-8 com BOM, `;`, CRLF | detectado |

As ruas vêm da malha OSM de pedestres, dentro dos polígonos OSM dos bairros (relações 18922323 Centro,
18922322 Paquetá e 18933692 Vila Nova, em `test-data/bairros_osm.geojson`). Os números são distintos na mesma
rua, e os complementos são distintos na mesma entrada.

**Casos adversariais.** `casos_adversariais_30.csv` traz 30 linhas com expectativa por linha:
- quebra de linha em campo citado, `;` e aspas;
- injeção de fórmula, HTML/script, NBSP, emoji;
- CEP inválido, outro município;
- abreviações, bairro trocado, ID duplicado.

Resultado da importação isolada: 30 lidas, 29 inseridas, 1 duplicada no arquivo, 1 com erro. No E2E, sobre o
banco que já tinha as 300 cartas: 28 inseridas + 2 duplicadas (1 no arquivo + 1 já existente), 1 com erro.

**Geocodificação na importação:** zero consultas (E2E-06). A importação não geocodifica automaticamente mais de
20 endereços. Os 150 endereços ficam como "a conferir" até receber posição.

## 2. Malha

| Item | Valor |
|---|---|
| Fonte | OpenStreetMap (ODbL), malha de pedestres, extraída pela API 0.6 do OSM |
| Recorte | bbox −24,005/−46,415 a −23,915/−46,295 |
| Nós / arestas | 41 598 / 48 747 |
| Versão da malha | `462dd3ef7b847815` |
| SHA-256 do `santos-graph.bin` (app) | `203c8dcb52823d29dac9e41a37111fd83660066197629ef717f9e2326f21f172` |
| Perfil | bicicleta na malha de pedestres: 15 km/h pedalando, calçada/calçadão empurrando a 4,5 km/h, sentido único de carro ignorado, escadas penalizadas (+30 s, metade da velocidade a pé) |

## 3. Origem

**PONTO TESTE** `-23.9480025, -46.3406209`. É o centro da Rua Joaquim Távora devolvido pelo Nominatim numa
única consulta manual. O **nº 480 não foi localizado** pelo provedor nem validado em campo. No app, o ponto de
partida precisa ser confirmado manualmente (Ajustes → Ponto de partida); sem isso o app não calcula.

## 4. Cenário B — rota real com 150 posições TESTE

Posições: `test-data/posicoes_teste_osm.csv` (150 nós OSM dentro dos 3 polígonos, um por chave). Script:
`backend/scripts/cenario_150_real.py`. Atendimento: 45 s por parada + 10 s por carta extra + acesso (2 × snap /
velocidade a pé). O acesso é 0 porque as posições TESTE já são nós da malha.

| Métrica | Rota aberta | Rota circular |
|---|---|---|
| Paradas roteadas | **150 / 150** | 150 / 150 |
| Cartas roteadas | **300 / 300** | 300 / 300 |
| Excluídas (snap / factibilidade) | 0 / 0 | 0 / 0 |
| Status | completa | completa |
| Distância | **15,53 km** | 17,57 km |
| Tempo total | **201,9 min** | 210,0 min |
| Deslocamento | 64,4 min | 72,5 min |
| Atendimento | 137,5 min | 137,5 min |
| Snap máx. / confiança | 0 m / 150 "alta" | idem |
| Objetivo = avaliação = ETA | sim | sim |
| Matriz / solver / geometria | 1,71 s / 30,05 s (limite) / 0,59 s | 1,48 s / 30,05 s / 0,62 s |

Por bairro (rota aberta): Centro 60 paradas / 120 cartas; Paquetá 50 / 101; Vila Nova 40 / 79.

**Arquivos:**
- `test-data/resultados/rota_150_open.geojson` e `rota_150_circular.geojson`: linhas da rota sobre as vias e
  150 pontos numerados rotulados "POSIÇÃO TESTE";
- `test-data/resultados/itinerario_150_open.csv` e `itinerario_150_circular.csv`: sequência, chave, bairro, cartas,
  ETA, trecho, snap e confiança;
- `test-data/resultados/resumo_150.json`: todas as métricas e candidatos.

### Comparação com baselines (rota aberta, mesma matriz)

| Estratégia | Tempo | Distância |
|---|---|---|
| **OR-Tools path_cheapest_arc + Guided Local Search (escolhida)** | **201,9 min** | **15,53 km** |
| OR-Tools christofides | 202,2 min | 15,61 km |
| OR-Tools local_cheapest_insertion | 202,4 min | 15,77 km |
| Vizinho mais próximo | 211,7 min | 17,96 km |
| Ordem importada (K001…K150) | 282,8 min | 35,50 km |
| Bairro agrupado (bairro → rua → número) | 294,7 min | 38,50 km |
| Ordem alfabética | 413,6 min | 68,29 km |

### No app (mesmo cenário, navegador)

No E2E-07 o app calculou, no Chromium headless, sobre a malha embutida: 150 paradas, 15,0 km, 3 h 20 min,
cerca de 9 s de cálculo, status completa. A diferença para o backend (15,53 km) vem de otimizadores diferentes
sobre a mesma matriz; a matriz do app difere no máximo 0,137% da do backend (`parity.test.ts`). A captura
`docs/EVIDENCIAS_E2E_V2/06-mapa-150-paradas.png` mostra as 150 paradas numeradas.

## 5. Cenário C — geocodificação real

**Bloqueado.** Não há fonte cartográfica validada para os números sintéticos (que podem não existir), e a política
do Nominatim público proíbe consultas em lote. Foi feita só a consulta da origem (ver §3). O app limita a
geocodificação a 250 consultas por dia, configurável, e nunca geocodifica em lote na importação.

## 6. Limitações deste teste

- As posições TESTE estão sobre a via, então o snap é 0 m. O snapping de endereços reais (15/30/60 m, flags de
  travessia) foi testado à parte (`test_audit_v2.py [C]`, `audit.test.ts [C]`).
- Os tempos de atendimento não estão calibrados em campo.
- Não houve celular real nem emulador. Os tempos do app são de navegador e Node no desktop.
