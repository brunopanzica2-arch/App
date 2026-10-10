# Provedores de mapa, geocodificação e roteamento (Rota Santos 2.0)

Regra: nada abaixo finge um serviço que exige conta, chave ou contrato. O que não está implementado está marcado **BLOQUEADO**.

## Mapa
| Camada | Situação |
|---|---|
| Mapa-base offline (Santos) | **Pacote PMTiles** embutido (OSM, ODbL, extraído e documentado em `scripts/extract_basemap.py`). Ruas e nomes sem internet. Não cobre fora do recorte. |
| Mapa-base online | `tiles.openfreemap.org` (estilo Liberty) quando não há pacote ou o ponto está fora dele. Sem chave. |
| Contingência | Fundo liso com a rota e as paradas numeradas. |
| Tiles ≠ grafo | Os tiles só **desenham**. A rota é calculada no grafo de pedestres próprio (abaixo). “Offline completo” **não** é afirmado: o geocodificador e as correções de OSM dependem de rede. |
| Google Maps | Não é raspado nem usado como mapa. O botão externo antigo continua apenas como link de navegação opcional. |

## Roteamento a pé
- **Motor:** roteador próprio em TypeScript sobre o grafo OSM de pedestres de Santos (`public/santos-graph.bin`), dentro de um Web Worker. Não é Valhalla/GraphHopper/OSRM; esses exigiriam servidor (BLOQUEADO sem infraestrutura).
- **Geometria:** vem das arestas reais do grafo (calçadas, travessias, escadas sinalizadas). Cada segmento carrega o nome da via (`segStreets`), usado pelas manobras.
- **Travessia da rua:** permitida pelo grafo (arestas de travessia). O app não impõe “lado da rua”; o otimizador minimiza a **distância/tempo a pé real**.
- **Otimização:** matriz por pares (Dijkstra com cache) + construção + busca local, com semente e limite de tempo. A interface mostra o método e as estimativas; **não** afirma “ótimo”. Paridade medida contra OR-Tools no backend: ver `TESTES_E_BENCHMARKS.md`.
- **Limitação:** se uma passagem real não existe no OSM, o app não a usa.

## Geocodificação
Pipeline: normalizar → cache (IndexedDB) → `GeocoderProvider` configurável → confiança → proveniência → fila persistente com retomada.
| Provedor | Uso permitido |
|---|---|
| Nominatim **público** | Só consulta pontual (ponto de partida, correção de um endereço) e lotes pequenos com cota diária (padrão 250). **Nunca** autocomplete nem importação em massa. User-Agent/Referer padrão do navegador, sem esconder identidade. |
| Instância própria ou contratada compatível com a API de busca do Nominatim | Configurável em Ajustes (URL, intervalo mínimo, custo por consulta). A chave fica no aparelho e **não entra** no backup nem no APK. |
| Google Geocoding / Mapbox / HERE / Geoapify | **BLOQUEADO**: exigem conta, chave e cobrança. A interface do provedor existe; nenhum desses foi implementado nem testado. |
| Coordenadas importadas (CSV) | Suportado; precisão “manual/importada”. |

Níveis de precisão exibidos: portaria confirmada > pino confirmado > número na fonte > interpolado (aproximado) > só a rua (não confirmado) > sem posição. O app nunca chama de “chegou à portaria” uma posição aproximada.

## Voz e localização
- TTS: `TextToSpeech` do Android (pt-BR), texto montado por regras a partir das manobras reais. Nenhum modelo generativo.
- Localização: Fused Location (Google Play Services) com *fallback* para `LocationManager`.
