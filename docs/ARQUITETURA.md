# Arquitetura técnica

## Visão geral

```
PWA (Next.js/React/MapLibre)  ──/api (proxy)──▶  FastAPI ──▶ PostgreSQL+PostGIS
   │  IndexedDB: fila offline + cópia da jornada        │  ├─ Redis + RQ worker (geocodificação, planejamento)
   │  Service worker: app shell + GET de rotas          │  ├─ Geocodificação: Nominatim (adaptador) + cache próprio
   └─ tiles: OpenFreeMap (estilo configurável)          │  └─ Roteamento: motor interno OSM-pedestre | Valhalla (pedestrian)
                                                        └─ OR-Tools (TSP aberto/circular/destino fixo + tempo de serviço)
```

## Decisões

### Motor de roteamento: interno (malha OSM de pedestres), com Valhalla como alternativa

Os requisitos determinantes são: rede de pedestres sem sentidos únicos de automóveis, nenhuma prioridade a ciclovias, distinção entre trecho pedalável e trecho em que se conduz a bicicleta a pé, sinalização de escadas, barreiras e acessos privados com política configurável, e velocidade operacional própria. Com o motor interno, cada uma dessas regras é explícita, testável e auditável:

- `backend/roteamento/network.py` classifica as vias e barreiras do OSM. Respeita apenas `oneway:foot`, `foot:forward` e `foot:backward`. `oneway` comum fica só como informação de contramão. `access=no`, `foot=no` e barreiras intransponíveis (muro, cerca, catraca de altura total) ficam fora da malha. Praças (`area=yes`) ganham travessia somente entre acessos reais e somente quando o segmento fica inteiramente dentro do polígono.
- `backend/roteamento/router.py`:
  - Aplica o perfil: velocidade pedalando, velocidade a pé, fator de escada e penalidades.
  - Usa a maior componente fortemente conexa, o que detecta "ilhas".
  - Faz o snapping projetando o ponto sobre o segmento real. A distância do snap é registrada, e o ponto é rejeitado acima de `max_snap_m`.
  - A matriz usa Dijkstra multi-origem em C (scipy) em blocos. Tempo e distância ao longo da árvore são acumulados por *pointer jumping* vetorizado, sem reconstruir cada par.
- Para Santos (porção insular + margem), a malha tem **41.598 nós e 48.747 trechos**: cabe em memória, e a matriz de 500 paradas leva cerca de 4 s.

GraphHopper e Valhalla têm perfil foot/pedestrian. Porém nenhum deles separa "pedalável" de "conduzir a pé" com velocidades distintas. A matriz e a rota do Valhalla usam um único `walking_speed`. O adaptador `ValhallaEngine` (`ROUTING_ENGINE=valhalla`) existe para quem preferir infraestrutura padrão. Ele foi testado com HTTP simulado. A integração com um servidor Valhalla próprio **não foi exercitada** neste ambiente.

Limitações conhecidas do motor interno:
- Não processa multipolígonos de praças.
- Não considera manobras em cruzamentos (custo de travessia). As travessias seguem a conectividade do OSM.
- Não usa relevo.

### Geocodificação: Nominatim por adaptador, cache próprio de imóveis confirmados

A ordem de resolução é:
1. Endereço já confirmado da organização (chave normalizada: tipo + logradouro + número + município).
2. Cache de consultas (`geocoding_cache`, com validade).
3. Provedor externo, com throttle, retry/backoff e cota diária.

A consulta enviada **nunca** inclui o destinatário nem o complemento.

A precisão é classificada de forma explícita:

| Nível | Quando |
|---|---|
| `exact` | O número retornado coincide com o pedido. |
| `interpolated` | Nominatim interpolou sobre uma linha de numeração. |
| `street` | Ponto aproximado na rua. Inclui o caso de o número retornado ser diferente do pedido. |
| `neighborhood` | Só o bairro foi localizado. |
| `not_found` | Nenhum resultado. |
| `manual` | Pino confirmado pelo usuário. |

Os seguintes casos marcam o endereço para revisão:
- logradouro retornado diferente do informado;
- resultado em outro município;
- CEP divergente;
- vários candidatos distintos.

Exemplo verificado: "Rua Joaquim Távora, 480" retorna no Nominatim apenas a **via**, sem o número. O sistema mostra "Aproximado na rua" e exige que o usuário confirme o pino. A coordenada não é inventada.

Em produção, recomenda-se um Nominatim próprio (importação do extrato Sudeste) ou um fornecedor contratado, implementando outra classe `Provider`.

### Otimização: OR-Tools

- Modelo: um entregador, origem fixa. O fim é livre (nó fictício de custo zero), igual à origem (circular) ou um destino fixo.
- Custo do arco: tempo em ms (deslocamento + atendimento da parada de origem) + 1 por metro (desempate) + penalidade de setor (modo por bairros).
- Prioridades: limite superior suave sobre o tempo acumulado de chegada.
- Paradas fixas: prefixo travado. O solver parte da última parada fixa.
- Para cada solução candidata (PATH_CHEAPEST_ARC, LOCAL_CHEAPEST_INSERTION e CHRISTOFIDES, todas com GUIDED_LOCAL_SEARCH, mais a linha de base "vizinho mais próximo") registram-se objetivo, tempo, distância e duração do cálculo. A melhor é escolhida. **Não há garantia de ótimo global.**

### Dados

PostgreSQL + PostGIS. As tabelas são `organizations`, `users`, `delivery_batches`, `correspondences`, `addresses`, `stops`, `stop_correspondences`, `routes`, `route_stops`, `delivery_events`, `geocoding_cache`, `route_matrix_metadata`, `audit_logs`, `sync_events` e `jobs`. As geometrias usam `geography(Point|MultiLineString, 4326)` com índice GiST.

As matrizes ficam em arquivos `.npz` (`DATA_DIR/matrices`), com metadados no banco: motor, versão da malha, hash do perfil, hash dos pontos e pares inalcançáveis. Isso evita guardar matrizes grandes em um único registro.

As migrations Alembic são reversíveis (upgrade e downgrade testados).

### Execução e eventos

- Os eventos são append-only. O status atual é o do evento mais recente por `occurred_at`.
- Idempotência por `client_event_id`, inclusive com envios concorrentes, coberto por teste.
- Um evento offline mais antigo que o último aplicado é registrado como **conflito**: entra no histórico, mas não altera o status.
- Correções apontam para o evento corrigido.
- O status da parada é derivado das cartas (pendente, parcial, concluída, adiada ou com ocorrência). Uma parada com 5 cartas, 3 entregues e 2 pendentes fica "parcial".
- Um recálculo cria a versão N+1 apenas com as paradas restantes. As versões anteriores permanecem, e a diferença (`diff`) é registrada.

### Segurança e LGPD

- Autenticação JWT com bcrypt.
- Papéis `admin`, `dispatcher` e `courier`.
- Isolamento por organização em todas as consultas.
- Nomes de destinatários mascarados para quem não tem `can_view_recipients`.
- Rate limit no login, na importação e na geocodificação.
- Auditoria sem nomes de destinatários.
- Retenção configurável (`RETENTION_DAYS`) com anonimização.
- Remoção de dados pessoais por lote.
- Upload validado (tamanho, tipo, conteúdo).
- Segredos ficam no `.env`, fora do Git.
- O proxy do Next expõe a API no mesmo domínio.

Pendências:
- HTTPS deve ser terminado no proxy reverso de produção.
- O rate limit em memória deve passar para Redis quando houver várias instâncias.
- É necessário **verificar com o responsável pelo serviço postal a autorização para processar correspondências em sistema externo.**

## Riscos

1. **Qualidade do OSM em Santos**: muitos imóveis não têm número no OSM, então o resultado tende a "aproximado na rua". A revisão manual e o cache de imóveis confirmados mitigam isso ao longo das jornadas.
2. **Calçadas pouco mapeadas**: sem calçadas desenhadas, a rede pedestre segue o eixo das vias, o que é coerente com o tráfego de bicicleta. Travessias seguem os nós do OSM.
3. **Estimativas**: os tempos vêm da malha e das velocidades configuradas. Não foram verificados em campo, e a interface informa isso.
4. **Serviços públicos** (Nominatim, API do OSM, OpenFreeMap): sujeitos a quota e termos. O uso em produção exige instância própria ou contrato.
5. **Escala de cálculo**: 500 paradas significam matriz de cerca de 4 s mais solver de 20 s em 4 vCPUs. Com mais de 1.000 paradas, o solver precisa de mais tempo ou de setorização.

## Situação por fase

| Fase | Situação |
|---|---|
| 1. Arquitetura, banco, migrations, autenticação | Feito. Docker Compose escrito; build das imagens não testado (HTTP 429 no Docker Hub). |
| 2. Importação, validação, normalização | Feito (CSV, XLSX, texto e manual). PDF/imagem: arquitetura preparada (adaptador de `ParsedTable`), extração não implementada. |
| 3. Geocodificação, confiança, cache, revisão manual | Feito |
| 4. Roteamento pedestre e matriz | Feito (interno, testado com OSM real). Valhalla com HTTP simulado. |
| 5. OR-Tools e geometria | Feito |
| 6. Painel, mapa, interface mobile | Feito (PWA responsiva, modo claro/escuro, legenda textual) |
| 7. Execução, ocorrências, recálculo, histórico | Feito |
| 8. PWA e sincronização offline | Feito: fila IndexedDB, idempotência, conflitos, cópia local da jornada. **Sem mapas offline** e sem recálculo offline. |
| 9. Testes, benchmarks, segurança | Feito (ver README e `benchmarks.md`) |
| 10. Documentação | Este documento + README |

Evoluções previstas e ainda não implementadas:
- múltiplos entregadores (o modelo OR-Tools já aceita vários veículos);
- janelas horárias (dimensão de tempo já criada para as prioridades);
- calibração do tempo de atendimento pelo histórico;
- importação de PDF/imagem com OCR revisado;
- testes automatizados de interface além do fluxo E2E principal.
