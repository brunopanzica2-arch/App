# Importação e busca geográfica (2.3)

## Número nunca vira S/N
- `normalizeNumber` aceita `480`, `nº 480`, `n. 480`, `número 480`, `#480`, `1.234`, `480A`.
- Número informado e ilegível → exibido como pedido + "(número não confirmado)". "S/N" só aparece se o usuário escreveu S/N.
- Resultado só da rua: `numberConfirmed=false`, precisão "street", texto "Número 480 não confirmado: ponto aproximado na rua, não a porta." Testes: `tests/number_preserve.test.ts`, `tests/search.test.ts`.

## Busca universal (`core/search.ts`, UI no mapa)
- Aba **Endereços** (qualquer rua de Santos, mesmo sem entregas importadas) e aba **Minhas entregas**.
- Offline: índice dos nomes de ruas da malha, tolerante a acento/caixa/abreviação (`r. joaquim tav` → Rua Joaquim Távora).
- Provedor: filtro de município Santos + caixa de Santos; homônimo em outro município é descartado; proximidade só desempata.
- **Nominatim público**: sem autocomplete (política de uso). Digitar usa só a malha offline; a consulta ao provedor sai **só ao tocar na lupa/Enter** (1 req/s, cache). Com provedor próprio configurado, consulta ao digitar (debounce 300 ms, cancelamento).
- Estados: curto, offline, erro do provedor (mantém resultados offline), vazio.
- Cartão: Adicionar carta (preserva número; posição com a precisão real), Traçar rota até aqui (mesmo perfil urbano seguro), Ver no mapa, Corrigir posição (pino arrastável, marcado como ajuste do usuário).
- Não suporta 300 consultas em lote no Nominatim público: use provedor próprio/coordenadas importadas.

## Importação (colar e pronto)
Texto livre/CSV/TSV/XLSX sem expor separador (inferência de esquema). Medido em Node, **só parse+normalização+consolidação, sem rede** (`docs/evidencias-rotas/importacao_escala.json`):

| linhas | válidas | endereços únicos | ms |
|---|---|---|---|
| 1 | 1 | 1 | 8 |
| 10 | 10 | 10 | 8 |
| 28 | 28 | 27 | 14 |
| 211 | 211 | 132 | 52 |
| 300 | 300 | 150 | 52 |
| 500 | 500 | 150 | 41 |
| 1000 | 1000 | 150 | 94 |

Tempo de geocodificação de 300/500/1000 endereços **não foi medido** (depende do provedor; o público limita a ~1 req/s e a cota diária do app).

## 2.5 — "não está identificando o número" (causas encontradas e correções)
**Causa 1 (defeito do app):** a lista colada **numa linha só** ("Rua A 53, Avenida B 78, Rua C 197…", ou separada por `;`/`|`) era lida como **1 endereço**: só o 1º número era reconhecido e os outros 17 sumiam (com `;` nenhum número era reconhecido). Correção: `splitMultiAddress` / `explodeMultiAddressText` (`src/core/freetext.ts`) separam os endereços onde uma palavra de via (Rua, Av., Travessa, Praça…) vem depois de separador ou de um número. Não corta "Rua da Praça 15", não mexe em planilha com cabeçalho. A prévia avisa "Separei N endereços que estavam juntos na mesma linha" e mostra **"Números identificados: N de M"**. Testes: `tests/multi_address.test.ts` (10), `e2e/lista18.mjs`.

**Causa 2 (dados):** o OpenStreetMap tem poucos números de casa em Santos (medi 33 em ~1,3 km²). Para "Rua João Éboli 53" o Nominatim devolve só a rua. Isso **não dá para corrigir no app**; o que foi feito:
1. 2ª consulta em texto livre ("Rua X 53, Santos, SP") quando a estruturada não acha o número (no Nominatim público só enquanto a cota diária < 50 %).
2. **Estimativa pela numeração** (`src/core/anchors.ts`): se dois números da MESMA rua já têm posição confiável (provedor com número, porta marcada, coordenada importada) e **cercam** o procurado (≤ 450 m entre eles), o ponto é interpolado e marcado "ESTIMADA entre os nºs X e Y" (precisão `interpolated`, nunca exata, nunca porta). Não extrapola. Prefere o mesmo lado da rua (paridade). Nunca sobrescreve porta confirmada/exato/manual/teste.
3. **"Marcar a porta aqui (GPS)"** (Detalhes da parada): grava a posição real com GPS (precisão ≤ 30 m) como porta confirmada; ela vira âncora e melhora os vizinhos. É a forma de o app "aprender" os números que o mapa não tem.
4. Após importar, o resumo mostra: localizados/confirmados · estimados · só a rua (número NÃO confirmado) · não encontrados.

**Limite honesto:** o app não consegue inventar números que nenhuma fonte tem; sem âncoras que cerquem o número, ele fica "só a rua" e a rota avisa "Destinos aproximados — confirme no local".
