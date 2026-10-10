# V3 — Skills descobertas e como foram usadas

Descoberta feita no início da V3 (ambiente: Claude Code em contêiner de nuvem). Nada foi presumido: só consta
como "lida" a skill cujo `SKILL.md` foi realmente carregado nesta sessão.

## Encontradas, lidas e aplicadas

| Skill | Caminho real | Para que serve aqui | O que foi aplicado | Fase |
|---|---|---|---|---|
| `entregas-geocodificacao-enderecos` | `~/.claude/skills/synced/<id>/entregas-geocodificacao-enderecos/SKILL.md` | Normalização, deduplicação, níveis de precisão, cache, LGPD | Nível de precisão em todo resultado; "nunca inventar coordenada"; centro de rua nunca vira "exato" (`classify`); só o endereço vai ao provedor; fila com backoff e sem 300 consultas paralelas; correção manual vence o geocodificador; cache por chave canônica | V3-3 (precisão), V3-4 (fila em lote) |
| `entregas-mapas-app` | idem `.../entregas-mapas-app/SKILL.md` | MapLibre, 300+ marcadores, offline, PostGIS | Paradas como camada GeoJSON (sem marcadores DOM); PMTiles de Santos para offline; glifos locais (sem glyphs o mapa fica sem texto); atribuição OSM visível; checklist "funciona sem internet depois de carregado" virou o E2E de primeira abertura sem internet | V3-5 |
| `entregas-roteirizacao-vrp` | idem `.../entregas-roteirizacao-vrp/SKILL.md` | TSP/VRP, matriz, OR-Tools, reotimização | Teste com força bruta para instâncias pequenas (a skill pede ≤ 9 pontos; usamos DP exato até 16); rota aberta com nó fictício de fim; "melhor encontrada no limite de tempo", nunca "ótima"; reotimização mantendo o restante e partida a quente; instância com parada inalcançável | V3-2, V3-6 |
| `react-typescript-web-app` | idem `.../react-typescript-web-app/SKILL.md` | Engenharia React/TS, desempenho, a11y, testes | Lista virtualizada (TanStack Virtual) para centenas de paradas; estados carregando/erro/vazio; foco e contraste AA; `aria-label` em progressbar; regiões roláveis focáveis; Vitest + Playwright em viewport de celular | V3-7 |
| `python-api-backend` | idem `.../python-api-backend/SKILL.md` | FastAPI, Pydantic, SQLAlchemy, Alembic, segurança | Schemas com restrições (`Field(ge/le/max_length)`); autorização por recurso (`get_owned`) nos novos endpoints; migração Alembic reversível com teste de rollback; trabalho pesado fora da requisição (já existente); testes de sucesso e de falha | V3-3 (backend) |
| `frontend-design` | `/mnt/skills/public/frontend-design/SKILL.md` | Direção visual, tipografia, redação de interface | Usada só nos trechos que cabem num app operacional já existente: texto de botões em voz ativa e consistente ("Confirmar portaria" × "Confirmar posição"), erros que dizem o que fazer, nenhuma animação nova. **Não** houve redesenho visual: o app existente já tem sistema de cores/tipografia próprio e a prioridade da V3 é confiabilidade | V3-3, V3-7 |
| `security-review` (comando) | Skill nativa do Claude Code | Revisão de segurança do diff | Executada sobre o diff V2→V3 via subagente (resultado em `AUDITORIA_V3.md`). O subagente não abriu todos os arquivos pedidos; ver a ressalva lá | Final |

## Listadas mas NÃO relevantes (não usadas)
`docx`, `pdf`, `pptx`, `xlsx`, `docs`, `google-workspace`, `deep-research`, `skill-creator`, `import-memory`, `morning`,
skills de Roblox, FiveM, GTA/LSPDFR, Blender e licenças/IA de jogos.

## Pedidas pela V3 e NÃO disponíveis neste ambiente
Nenhuma skill com estes temas foi encontrada; o trabalho foi feito sem elas, com o método descrito nos próprios documentos:
- auditoria/revisão de arquitetura full-stack (além do `security-review`);
- Android/Capacitor, PWA e desempenho em aparelho modesto;
- QA/Playwright/E2E e acessibilidade (usamos `@axe-core/playwright` diretamente);
- PostGIS/GIS além do que está em `entregas-mapas-app`;
- LGPD/segurança, observabilidade, CI/CD.

Os skills `code-review` e `simplify` existem na sessão, mas **não foram executados**: o `security-review` já cobriu o diff
e a prioridade era implementar e testar. Se quiser, rode `/code-review` na branch.

## Limites respeitados
Nenhuma skill foi usada para contornar permissões, publicar dados pessoais, expor segredos ou declarar teste que não rodou.
