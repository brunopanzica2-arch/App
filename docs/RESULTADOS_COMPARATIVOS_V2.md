# Resultados comparativos V2

Todas as medições foram feitas num contêiner Linux (Intel Xeon 2,1 GHz, 4 vCPU). **Nenhuma é medição em
celular.** Não houve aparelho nem emulador (sem KVM); o desempenho num Moto G15 ou similar continua **não
medido**. Os pontos são POSIÇÕES TESTE (nós OSM) dentro de Centro, Paquetá e Vila Nova. As cartas são fictícias.

Arquivos de origem:
- `test-data/benchmarks/resultados_backend.json`
- `test-data/benchmarks/resultados_app_node.json`
- `test-data/benchmarks/antes_depois_150.json`
- `test-data/resultados/resumo_150.json`
- `test-data/benchmarks/<cenário>.json` (pontos)

## 1. Antes × depois — mesmo cenário, mesma matriz

Cenário: 150 posições TESTE, rota aberta, matriz real 151×151 (`paridade_150_open.json`).

| Implementação | Antes (commit `42d7976`) | Depois |
|---|---|---|
| Backend, OR-Tools 30 s | 201,9 min · 15,53 km · 0 arcos inválidos | 201,9 min · 15,53 km · 0 arcos inválidos |
| App, semente 1 (6 s) | 201,6 min · 15,47 km | 200,8 min · 15,35 km |
| App, semente 2 | 201,1 min · 15,42 km | 201,3 min · 15,50 km |
| App, semente 3 | 201,9 min · 15,54 km | 201,1 min · 15,44 km |

**Leitura honesta.** Numa malha bem conectada, a qualidade da rota antes e depois é equivalente: a diferença
fica abaixo de 0,5% e varia com a semente. As correções da V2 são de **correção e segurança**, não de ganho de
quilômetros:

| Situação | Antes | Depois |
|---|---|---|
| Matriz com par impossível `[[0,5,5],[∞,0,∞],[∞,∞,0]]` (app) | ordem `[2,1]` com arco `Infinity` aceita como melhor | 1 parada roteada, 1 excluída com motivo, status **PARCIAL** |
| Mesmo caso (backend) | sequência com arco de custo 10¹¹ | rota parcial válida + exclusão com motivo |
| Origem numa componente menor | "Ponto de partida fora da malha" | roteia na componente da origem |
| CSV com BOM e campo com quebra de linha | cabeçalho quebrado / carta duplicada | 1 registro, cabeçalho correto |
| Exportação de `=HYPERLINK(...)` | fórmula ativa na planilha | texto neutralizado com `'` |

## 2. Benchmark histórico × V2

O benchmark histórico (`docs/benchmarks.md`, preservado) sorteava nós por **toda** a malha de Santos. Por
isso os números eram 121,42 km, 10,4 h e 16 exclusões para 300 cartas e 150 paradas. **Não é comparável** com
a V2, que concentra os pontos nos 3 bairros. A queda para 15,5 km é efeito do cenário, não do algoritmo. As 16
exclusões antigas vinham de nós sorteados longe da malha de pedestres (ilhas, morros, porto).

## 3. Benchmarks V2 — backend × app nos mesmos pontos

Solver limitado a 15 s nas duas implementações. Atendimento: 45 s por parada + 10 s por carta extra. Rota
aberta a partir da origem TESTE.

| Cenário | Paradas | Cartas | Backend: matriz | Backend: km / h | Backend: RSS pico | App (Node): matriz | App: km / h | App: heap pico | App ÷ backend (tempo) |
|---|---|---|---|---|---|---|---|---|---|
| c300_150 (fixture oficial) | 150 | 300 | 1,46 s | 15,53 / 3,36 | 235 MB | 0,29 s | 15,36 / 3,35 | 68 MB | 0,998 |
| c300_300 (pior caso) | 300 | 300 | 2,80 s | 21,53 / 5,32 | 311 MB | 0,48 s | 21,34 / 5,31 | 121 MB | 0,998 |
| c500_250 | 250 | 500 | 2,35 s | 21,17 / 5,38 | 311 MB | 0,42 s | 20,28 / 5,32 | 146 MB | 0,989 |
| c1000_500 | 500 | 1000 | 3,97 s | 25,61 / 9,55 | 411 MB | 0,86 s | 25,21 / 9,52 | 184 MB | 0,997 |
| meia_rua (metade numa via) | 114 | 228 | 1,10 s | 13,82 / 2,70 | — | 0,25 s | 13,62 / 2,68 | 192 MB¹ | 0,993 |
| meio_predio (150 cartas num prédio) | 76 | 300 | 0,74 s | 6,80 / 2,03 | — | 0,10 s | 6,80 / 2,03 | 70 MB | 1,001 |
| desconexo² | 150 | 290 | 1,24 s | 17,28 / 3,58 | — | 0,28 s | 16,81 / 3,55 | 63 MB | 0,991 |
| vizinhos (0–20 m) | 120 | 240 | 1,13 s | 13,64 / 2,75 | — | 0,20 s | 13,67 / 2,75 | 86 MB | 1,000 |

Tempo total de cálculo do app em Node (matriz + otimização + geometria):

| Cenário | Tempo |
|---|---|
| c300_150 | 11,9 s |
| c300_300 | 18,2 s |
| c500_250 | 17,7 s |
| c1000_500 | 20,8 s |
| meia_rua | 4,9 s |
| meio_predio | 2,8 s |
| desconexo | 12,9 s |
| vizinhos | 7,3 s |

O app para por estagnação antes do limite quando não acha melhora. O backend usa sempre os 15 s inteiros, porque
o OR-Tools com Guided Local Search roda até o limite.

O "—" na coluna RSS do backend indica que o pico já tinha sido atingido num cenário anterior do mesmo processo:
`ru_maxrss` só cresce, então o valor não é atribuível ao cenário.

¹ O heap do app é amostrado nos callbacks de progresso e não é zerado entre cenários; é uma medida aproximada.

² **desconexo:** pretendia testar 10 paradas fora do alcance da origem. Os 10 nós sorteados como inalcançáveis
ficavam a menos de 150 m de arestas alcançáveis e foram encaixados nelas (com snap > 0). Por isso **nada foi
excluído**. O cenário, como construído, não exercitou a exclusão. A exclusão está provada nos testes
`test_A_*`/`test_B_*` e `audit.test.ts [B]/[F]`. Registrado aqui em vez de ajustar o cenário até "dar certo".

Ganho do backend sobre o vizinho mais próximo (mesma matriz, em tempo):

| Cenário | Ganho |
|---|---|
| c300_150 | 4,6% |
| c300_300 | 5,2% |
| c500_250 | 3,2% |
| c1000_500 | 2,6% |
| meia_rua | 6,4% |
| meio_predio | 3,2% |
| desconexo | 7,4% |
| vizinhos | 4,6% |

Ganhos sobre baselines manuais no cenário oficial (rota aberta):

| Baseline | Tempo | Distância | Ganho do otimizador |
|---|---|---|---|
| Ordem importada | 282,8 min | 35,5 km | −28,6% |
| Bairro agrupado | 294,7 min | 38,5 km | −31,5% |
| Alfabética | 413,6 min | 68,3 km | −51,2% |

Nos três casos o otimizador fica em 201,9 min e 15,5 km.

## 4. Paridade backend × app (mesma matriz)

`mobile/tests/parity.test.ts`:
- A matriz de tempo e distância do app tem diferença relativa máxima de **0,137%** em relação à do backend, nos
  151×151 pares.
- As finitudes são iguais, e snaps e flags são idênticos.
- O otimizador do app, com 6 s e 3 sementes, ficou entre **0,9946 e 0,9971** do tempo do OR-Tools (30 s). Nesses
  casos o app achou rota ligeiramente melhor.

## 5. O que estes números NÃO dizem

- Não medem celular. Um aparelho de entrada é mais lento que este Xeon, e quanto mais lento **não foi medido**. O app roda a otimização num Web Worker, com progresso e cancelamento, e tem limite de
  tempo configurável.
- Não medem o tempo real de entrega. O atendimento (45 s + 10 s por carta) não está calibrado em campo.
- Não validam portas: o snap é 0 m porque os pontos são nós da malha.
