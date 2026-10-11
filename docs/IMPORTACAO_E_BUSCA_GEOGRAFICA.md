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
