# Rota Santos: roteirização de correspondências

Sistema full-stack para importar, geocodificar, agrupar, otimizar, mapear e acompanhar a entrega de 300 ou mais correspondências por dia em Santos/SP. A operação é feita **de bicicleta**, mas o cálculo das rotas usa a **rede de pedestres (perfil foot)** do OpenStreetMap.

- Não aplica sentidos únicos de automóveis. Esses trechos aparecem apenas sinalizados como "contramão de veículos".
- Não prioriza ciclovias.
- Considera ruas, calçadas, praças, travessas e passagens. Só cria ligações que existem na malha do OSM.
- O tempo é calculado pela **velocidade operacional da bicicleta**, que o usuário configura. Trechos em que é preciso **conduzir a bicicleta a pé** (calçadas, `bicycle=no/dismount`) e escadas têm velocidades próprias.
- Escadas, acessos privados e barreiras são **sinalizados**. Para cada tipo existe uma política: permitir, penalizar ou evitar.
- Objetivo da otimização: **menor tempo total**, somando deslocamento e atendimento. Em caso de empate, vale a menor distância. Rota **aberta** por padrão; circular ou com destino fixo são opcionais.

> **App Android offline (sem servidor):** veja [`mobile/README.md`](mobile/README.md). O APK pronto está em [`releases/rota-santos-1.0.apk`](releases/rota-santos-1.0.apk).

A arquitetura, as decisões técnicas e os riscos estão em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md). Os benchmarks medidos estão em [`docs/benchmarks.md`](docs/benchmarks.md) e as capturas do E2E em [`docs/screenshots/`](docs/screenshots).

## Estrutura

```
backend/     FastAPI + SQLAlchemy/GeoAlchemy2 + Alembic + OR-Tools
  roteamento/  motor de roteamento pedestre (malha OSM, Dijkstra/scipy)
  app/         API, serviços (importação, geocodificação, planejamento…), workers
  alembic/     migrations (PostgreSQL + PostGIS)
  tests/       unitários, integração/API (PostGIS real), adaptadores (HTTP simulado), testes com internet
  scripts/     benchmark reproduzível
frontend/    Next.js 16 + React 19 + TypeScript + Tailwind 4 + MapLibre GL (PWA)
  e2e/         fluxo ponta a ponta no navegador (Playwright)
docker-compose.yml   PostGIS, Redis, API, worker RQ, web (+ Valhalla opcional)
```

## Execução com Docker Compose

```bash
cp .env.example .env            # defina POSTGRES_PASSWORD, JWT_SECRET, NOMINATIM_EMAIL…
# Malha de pedestres: coloque um recorte .osm.pbf de Santos em um volume e aponte OSM_PBF_PATH,
# ou use OSM_SOURCE=overpass (instância própria) / osmapi (apenas desenvolvimento).
docker compose up -d --build
docker compose exec api python -m app.cli create-admin --org "Minha agência" --email voce@exemplo.com --name "Seu nome"
docker compose exec api python -m app.cli build-network     # baixa/constrói a malha (cache em /data)
# abra http://localhost:3000
```

Recorte PBF recomendado para produção:

```bash
wget https://download.geofabrik.de/south-america/brazil/sudeste-latest.osm.pbf
osmium extract -b -46.415,-24.005,-46.295,-23.915 sudeste-latest.osm.pbf -o santos.osm.pbf
```

> O Compose foi validado com `docker compose config`. A construção das imagens **não foi testada neste ambiente**, porque o Docker Hub recusou o download das imagens base (HTTP 429). Veja "Verificação" abaixo.

## Execução local (sem Docker)

Pré-requisitos: Python 3.12+, Node 22+, PostgreSQL 16 com PostGIS 3 e, opcionalmente, Redis.

```bash
# banco
createdb rota && psql rota -c "CREATE EXTENSION postgis"

# backend
cd backend
pip install -r requirements.txt -r requirements-dev.txt
cat > .env <<EOF
DATABASE_URL=postgresql+psycopg://USUARIO:SENHA@localhost:5432/rota
JWT_SECRET=um-segredo-longo-e-aleatorio
OSM_SOURCE=osmapi           # dev: API do OSM em blocos; produção: pbf/overpass próprios
GEOCODER=nominatim
NOMINATIM_EMAIL=seu-email@exemplo.com
EOF
alembic upgrade head
python -m app.cli create-admin --org "Agência" --email admin@exemplo.com --name Admin
python -m app.cli build-network            # ~5 min na 1ª vez via osmapi; depois usa o cache
uvicorn app.main:app --port 8000           # sem REDIS_URL, as tarefas rodam em thread
# com Redis: REDIS_URL=redis://localhost:6379/0 e, em outro terminal: rq worker roteirizacao

# frontend
cd ../frontend
npm install                                # o postinstall copia o worker do MapLibre para public/
BACKEND_URL=http://localhost:8000 npm run dev
```

## Fluxo diário

1. Entrar.
2. **Ajustes**: geocodificar "Rua Joaquim Távora, 480, Santos/SP", **arrastar o pino até a entrada do imóvel** e confirmar. Isso só precisa ser feito uma vez.
3. **Importar** (CSV, XLSX, texto colado ou cadastro manual): mapear as colunas, conferir a prévia e confirmar. Linhas com erro e duplicadas aparecem no relatório da importação; nenhuma é descartada sem aviso.
4. A geocodificação roda em background. Cada endereço recebe um nível de precisão: exato, interpolado, aproximado na rua, centro do bairro ou não localizado.
5. **Validar endereços**: ver os candidatos no mapa, mover o pino e confirmar. A correção fica salva para as jornadas seguintes.
6. **Planejar**: escolher rota aberta, circular ou com destino fixo, a estratégia (global ou por bairros), as velocidades e as políticas. O sistema calcula a matriz de pedestres, otimiza com OR-Tools, compara as soluções candidatas e desenha a rota sobre a malha real.
7. **Ativar a jornada**: mapa operacional com a próxima parada e um painel recolhível. Cada carta recebe seu próprio status (entregue, não entregue, adiada, devolvida ou endereço não localizado). Funciona **offline**: os registros entram em uma fila local e são sincronizados depois.
8. **Recalcular** a partir da última parada atendida ou da localização atual (que exige consentimento). Cada recálculo gera uma nova versão; as anteriores ficam no histórico.
9. **Relatórios**: planejado (estimativa) separado do registrado (eventos), visão por bairro e por motivo, histórico e exportação em CSV ou XLSX.

## Verificação

| Item | Situação |
|---|---|
| `pytest` (backend), sobre PostgreSQL 16 + PostGIS 3.4 real | **43 passaram**, 2 pulados. Os pulados exigem internet e são executados à parte. |
| `RUN_NETWORK_TESTS=1 pytest -m network` (Nominatim e API do OSM reais) | **2 passaram** |
| `alembic upgrade` → `downgrade base` → `upgrade` → `alembic check` | ok |
| `next build` + `tsc --noEmit` | ok |
| E2E no navegador (`frontend/e2e/flow.mjs`) com API real, Nominatim real e malha OSM real de Santos | ok: login, ponto de partida, importação, geocodificação, revisão, planejamento, ativação, entrega, registro offline e sincronização, recálculo v2, relatório |
| Benchmarks 100/300/500/1000 cartas (malha sintética e malha real) | ver `docs/benchmarks.md` |
| `docker compose config` | ok |
| Build das imagens Docker | **não executado** (Docker Hub recusou o download, HTTP 429) |

Testes do backend:

```bash
cd backend
createdb rota_test
TEST_DATABASE_URL=postgresql+psycopg://USUARIO:SENHA@localhost:5432/rota_test pytest
RUN_NETWORK_TESTS=1 pytest -m network        # exige internet
python -m scripts.benchmark --network synthetic --sizes 100 300 500 1000
python -m scripts.benchmark --network real --sizes 100 300 500 1000   # depois do build-network
```

Os testes usam **dados sintéticos**: um geocodificador MOCK e uma malha em grade sintética, ambos identificados como tal. Nenhum dado real de destinatário aparece nas fixtures.

## Dados, licenças e serviços externos

- Dados de mapa: © colaboradores do OpenStreetMap (ODbL). Mapa-base: OpenFreeMap, configurável em `NEXT_PUBLIC_MAP_STYLE`.
- **Nominatim público**: limite de 1 requisição por segundo, identificação obrigatória e proibição de uso massivo. Em produção, use uma instância própria ou um fornecedor contratado. O sistema mantém um cache próprio e controla uma cota diária (`GEOCODER_DAILY_QUOTA`).
- **API 0.6 do OSM** (`OSM_SOURCE=osmapi`): serve apenas para desenvolvimento. Em produção, use um PBF próprio ou uma instância Overpass própria.
- Valhalla (motor alternativo): use o servidor do perfil `valhalla` do Compose, não o servidor público de demonstração.
