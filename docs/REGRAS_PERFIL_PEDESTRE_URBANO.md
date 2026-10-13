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

## 2.6.1 — correção: via particular urbana (vila/condomínio)
**Erro relatado:** "Nenhuma parada alcançável pela malha de pedestres a partir da origem" com 3 paradas pendentes.
**Causa provada na malha real:** a 2.3 tratava TODO `access=private` como vedado. Isso é certo para trilha/terra privada (o incidente), mas errado para vilas e ruas particulares calçadas, onde moram destinatários. Paradas nesses locais (e origens perto delas) ficavam sem acesso na malha.
**Regra agora:**
| Acesso privado em… | Tratamento |
|---|---|
| trilha / path / track / piso sem pavimento | **vedado** (incidente do morro continua barrado) |
| via urbana (residential, service, footway pavimentado…) | **permitido** com penalidade (≈ 240 s × trecho; nó/portão 180 s), marcado "via particular: confirmar a entrada"; a rota vira "Trechos não verificados — revisar antes de seguir" |
Origem "isolada" no perfil urbano caiu de 164 para 79 pontos da grade (= o legado). Os 25 pontos restantes sem malha ficam no morro do incidente (só há trilha privada).
**Mensagem de erro:** agora lista as paradas excluídas e o motivo ("Rua X, 10: Há vias a N m, mas nenhuma conectada à origem…").
**Não reproduzido com os dados reais do usuário** (as 3 paradas pendentes são desconhecidas): a correção foi provada em teste sobre a malha real (`tests/trail_safety.test.ts`, bloco 2.6).
