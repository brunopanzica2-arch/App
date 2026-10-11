# Perfil "entrega urbana a pé" — regras (router.ts `classifyEdge`)

| Situação na aresta | Tratamento |
|---|---|
| `access=private` / `foot=private` | **Proibida** (a menos que `private_policy="allow"`) |
| Trilha contínua (path/track/bridleway, footway/cycleway sem piso pavimentado) ≥ 150 m (`trail_forbid_m`) | **Proibida** |
| Trilha curta (<150 m) | Permitida ×6, marcada `trilha`, rota vira "não verificada" |
| Via nomeada mapeada como path/track sem dica de uso urbano | Cautela ×2,5 |
| Footway/cycleway iluminado ou designado, pavimentado | Cautela ×1,5 |
| Piso não pavimentado | Cautela ×2 |
| Motorway / vias sem calçada | Cautela ×3 |
| Service | ×1,15 |
| Calçadas, travessias legais, ruas | Normal |
| Trecho reportado pelo usuário (`avoid_edges`) | Proibido nas próximas rotas |

- Destino: encaixe só em arestas urbanas (suit < 2). Sem alcance → "Não foi possível confirmar um trajeto urbano seguro até este destino".
- Penalidades afetam a escolha do caminho, não o tempo exibido.
- Limiares são julgamento de engenharia sobre dados OSM; não foram calibrados em campo.
