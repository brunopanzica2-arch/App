# Incidente: rota por trilha/morro/mato (Rota Santos 2.3)

## O que aconteceu
Uma rota calculada pelo app passou por um trecho de trilha/terra em vez de ruas urbanas.

## Causa raiz (provada com dados, não suposição)
1. A malha exportada (`santos-graph.bin`, formato antigo RSG1) **não trazia classe da via nem piso**. `highway=path/track` era tratado como via comum.
2. O perfil antigo penalizava `access=private` com apenas 120 s (custo, não proibição).
3. A via OSM **1381717600** (`highway=path`, `surface=dirt`, `access=private`, 390 m contínuos, ~-23.95949,-46.36314) e cerca de 1,7 km de vias privadas ficaram elegíveis.
4. Reprodução (`mobile/tests/trail_safety.test.ts`): origem em São Vicente (-23.964,-46.392) até o ponto configurado (-23.948914,-46.33368). Perfil antigo: **6781 m / 102 min**, usa os trechos acima. Perfil urbano: **7732 m / 103 min (+14%)**, nenhum trecho de trilha/privado. Arquivos: `docs/evidencias-rotas/incidente_*.{json,geojson}`.

## Correção (no pipeline, não um `if` no frontend)
- `backend/roteamento/network.py` + `backend/scripts/export_mobile_graph.py`: grafo **RSG2** com classe da via (`hw`), piso (`surf`), bits de acesso/iluminação/designação (`attr`) e comprimento contínuo de trilha (`trail`). `NETWORK_BUILD_VERSION = pedestrian-v2`.
- `mobile/src/core/router.ts` `classifyEdge`: acesso privado = **proibido** no perfil urbano; trilha contínua ≥150 m = proibida; trilha curta = ×6 e marcada; via nomeada mapeada como caminho = cautela ×2,5; sem piso pavimentado = cautela. A penalidade de segurança entra só na chave do Dijkstra (não infla o ETA).
- Mesmo perfil para matriz de custos (otimização de paradas) e navegação.
- Destino só é "encaixado" em aresta urbana; sem trajeto seguro → mensagem honesta, sem rota inventada.
- Auditoria: `backend/scripts/audit_trails.py` → `docs/evidencias-rotas/trilhas_santos.{md,json}` (69 vias, 15 vedadas).
- Guarda de segurança (`core/safety.ts`): "Rota revisada" só quando nenhum trecho é trilha/sem dados **e** nenhum destino é aproximado; senão "Trechos não verificados — revisar antes de seguir" / "Destinos aproximados — confirme no local" + confirmação antes de iniciar.
- "Reportar problema neste trecho": grava a chave estável da aresta (limite 40, local) e recalcula evitando-a (`avoid_edges`). E2E: `SEG-03`.

## O que NÃO foi feito / limites
- Valhalla/GraphHopper **não foram adotados nem medidos** (exigem servidor; o app é offline). Registrado como alternativa a avaliar com dados reais.
- O roteador legado em Python do backend não mudou de custos (testes de paridade `pedestrian:false` preservados).
- "Rota revisada" significa "sem trecho não urbano conhecido pelo OSM e sem destino aproximado" — **não** é verificação em campo. OSM pode estar errado.
- Nenhum teste em Android real.
