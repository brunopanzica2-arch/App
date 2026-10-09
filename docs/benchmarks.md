
## Execução 2026-10-09T20:39:33+00:00 (commit 3723ccc)

- Hardware: Linux-6.18.44-fc-v80-x86_64-with-glibc2.39 · CPU Intel(R) Xeon(R) Processor @ 2.10GHz · 4 vCPU · RAM 16.5 GB · Python 3.13.16
- Malha: synthetic (1308 nós, 2498 trechos)
- Limite do solver: 10 s · geocodificação: MOCK (sintética) · cartas sintéticas

| Cartas | Paradas | Excluídas | Import (ms) | Geocod. mock (ms) | Consolid. (ms) | Matriz (ms) | Solver (ms) | Geometria (ms) | Distância (km) | Tempo est. (h) | Melhor estratégia |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 50 | 0 | 49 | 485 | 113 | 29 | 10015 | 14 | 10.8 | 1.48 | path_cheapest_arc |
| 300 | 150 | 0 | 165 | 1527 | 267 | 58 | 10065 | 33 | 11.81 | 3.08 | path_cheapest_arc |
| 500 | 250 | 0 | 124 | 2164 | 464 | 82 | 10172 | 39 | 12.59 | 4.66 | path_cheapest_arc |
| 1000 | 500 | 0 | 246 | 4781 | 963 | 170 | 10591 | 156 | 15.88 | 8.71 | path_cheapest_arc |

Comparação de candidatos (tempo estimado em h / distância km):

- 100 cartas: nearest_neighbor_baseline: 1.51 h / 11.3 km, path_cheapest_arc: 1.48 h / 10.8 km, local_cheapest_insertion: 1.48 h / 10.8 km, christofides: 1.48 h / 10.8 km
- 300 cartas: nearest_neighbor_baseline: 3.12 h / 12.4 km, path_cheapest_arc: 3.08 h / 11.8 km, local_cheapest_insertion: 3.09 h / 12.0 km, christofides: 3.15 h / 12.9 km
- 500 cartas: nearest_neighbor_baseline: 4.72 h / 13.5 km, path_cheapest_arc: 4.66 h / 12.6 km, local_cheapest_insertion: 4.69 h / 13.1 km, christofides: 4.73 h / 13.6 km
- 1000 cartas: nearest_neighbor_baseline: 8.99 h / 20.1 km, path_cheapest_arc: 8.71 h / 15.9 km, local_cheapest_insertion: 8.80 h / 17.2 km, christofides: 8.72 h / 16.0 km

## Execução 2026-10-09T20:42:56+00:00 (commit 3723ccc)

- Hardware: Linux-6.18.44-fc-v80-x86_64-with-glibc2.39 · CPU Intel(R) Xeon(R) Processor @ 2.10GHz · 4 vCPU · RAM 16.5 GB · Python 3.13.16
- Malha: real (41598 nós, 48747 trechos)
- Limite do solver: 20 s · geocodificação: MOCK (sintética) · cartas sintéticas

| Cartas | Paradas | Excluídas | Import (ms) | Geocod. mock (ms) | Consolid. (ms) | Matriz (ms) | Solver (ms) | Geometria (ms) | Distância (km) | Tempo est. (h) | Melhor estratégia |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 50 | 1 | 56 | 430 | 107 | 864 | 20019 | 233 | 79.79 | 6.24 | path_cheapest_arc |
| 300 | 150 | 16 | 96 | 1211 | 242 | 1524 | 20046 | 606 | 121.42 | 10.4 | local_cheapest_insertion |
| 500 | 250 | 22 | 218 | 1954 | 553 | 2223 | 20153 | 1253 | 184.15 | 17.12 | local_cheapest_insertion |
| 1000 | 500 | 45 | 386 | 4100 | 933 | 4293 | 20500 | 2731 | 226.01 | 24.2 | path_cheapest_arc |

Comparação de candidatos (tempo estimado em h / distância km):

- 100 cartas: nearest_neighbor_baseline: 6.65 h / 86.5 km, path_cheapest_arc: 6.24 h / 79.8 km, local_cheapest_insertion: 6.24 h / 79.8 km, christofides: 6.24 h / 79.8 km
- 300 cartas: nearest_neighbor_baseline: 12.59 h / 154.4 km, path_cheapest_arc: 10.72 h / 126.4 km, local_cheapest_insertion: 10.40 h / 121.4 km, christofides: 10.67 h / 125.8 km
- 500 cartas: nearest_neighbor_baseline: 20.37 h / 231.8 km, path_cheapest_arc: 17.27 h / 186.6 km, local_cheapest_insertion: 17.12 h / 184.1 km, christofides: 17.75 h / 193.2 km
- 1000 cartas: nearest_neighbor_baseline: 29.12 h / 299.7 km, path_cheapest_arc: 24.20 h / 226.0 km, local_cheapest_insertion: 24.69 h / 234.0 km, christofides: 25.05 h / 238.9 km
