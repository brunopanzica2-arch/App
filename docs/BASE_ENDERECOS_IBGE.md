# Base offline de endereços com número — IBGE/CNEFE (2.6)

## Por que
Teste real (13/out/2026) com as 18 ruas do usuário: o Nominatim público achou a rua em 16 e o número em **0**. O OpenStreetMap quase não tem números de casa em Santos (33 numa área de ~1,3 km²). O CNEFE do IBGE (Censo 2022) tem **231.082** pontos de endereço de Santos com número e coordenadas, e é dado aberto.

## O que o app faz
- `backend/scripts/export_cnefe.py` converte `3548500_SANTOS.zip` (3,9 MB) em `mobile/public/santos-enderecos.bin` (**1,0 MB**, 57.582 números em 1.319 logradouros; formato RSA1). Um registro por (logradouro, número, sufixo, **bairro**): ruas/números homônimos em bairros diferentes **não** são misturados (214 casos têm pontos a > 300 m).
- `src/core/cnefe.ts`: casa o nome digitado (sem acento; dígitos = palavras, "7 de Setembro" = "Sete de Setembro"; título omitido "Av. Nébias" → "Av. Conselheiro Nébias" com aviso), acha o número, desempata por bairro e, se o número não existe, estima entre vizinhos da mesma rua (≤ 350 m).
- `src/core/localgeo.ts`: aplica ao lote **antes** da fila do provedor online (offline, sem cota). Só o que sobra vai à rede. Nunca sobrescreve porta/pino confirmado, número exato ou coordenada manual/teste.
- Busca universal e "Corrigir endereço" usam a mesma base. Em Ajustes há a citação da fonte.

## Regras de honestidade
| Situação | Resultado no app |
|---|---|
| Nome idêntico + número no CNEFE, nível 1 | `exact` "Número localizado na fonte" (ponto do endereço, **não** porta confirmada) |
| Nível 2 (face da quadra) | `interpolated` + aviso |
| Número ausente, vizinhos que cercam | `interpolated` "ESTIMADA entre os nºs X e Y" |
| Nome diferente (falta/sobra palavra, erro de digitação) | **nunca aceito sozinho**: candidato + "Confirme" |
| Mesmo nº em mais de um bairro | ambíguo: pede o bairro (ou confirmação no mapa) |
| Rua inexistente / sem número | segue para o provedor online; "só a rua" |

## Resultados medidos
- Lista do usuário (18): **17** com ponto do endereço (nível 1); 1 candidato a confirmar (Praça Narciso de Andrade).
- Navegador (E2E `lista18.mjs`, 20 endereços colados numa linha): 18 localizados + 1 estimado offline; **3 consultas** à rede (antes: ~54); rota com 19 paradas.
- Desempenho: 2.000 consultas < 1,5 s (Node).

## Limites
- Pontos do CNEFE são **estatísticos** (centro do edifício/face de quadra), não a porta; confirme com "Marcar a porta aqui (GPS)".
- Dados de 2022: imóveis novos podem faltar. Só Santos (3548500); outras cidades usam o provedor online.
- Fonte e licença: IBGE, dados abertos; citar "IBGE, Censo Demográfico 2022, CNEFE". Arquivo original não é versionado (39 MB): baixar com a URL em `santos-enderecos.json` e rodar o script.
