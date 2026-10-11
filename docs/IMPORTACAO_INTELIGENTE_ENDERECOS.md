# Importação inteligente de endereços (Rota Santos 2.1)

Objetivo: o entregador cola ou importa **sem configurar nada** — sem separador, sem cabeçalho, sem ordem de colunas.

## Fluxo principal
1. **Importar cartas** (botão na home) → colar texto, escolher CSV/XLSX/TXT.
2. O app lê o conteúdo, decide sozinho se é tabela ou linhas livres e mostra uma prévia: *linhas lidas*, *válidas*, *precisam de correção*, *ambíguas*, *imóveis únicos*.
3. **Confirmar**: as linhas válidas viram cartas; as inválidas **não são gravadas** (ficam no relatório com a linha original).
4. Mapa → **Calcular rota**. Endereços sem posição confiável vão para a revisão assistida.
A opção “Ajustar colunas” existe, mas fica escondida.

## O que é entendido (texto livre)
`mobile/src/core/freetext.ts` (regras e listas locais, sem modelo generativo):

| Entrada | Resultado |
|---|---|
| `Rua Joaquim Távora 480` | Rua Joaquim Távora · 480 |
| `R. Joaquim Távora, 480, Vila Belmiro` | idem + bairro Vila Belmiro |
| `Praça Visconde de Mauá 11` | Praça Visconde de Mauá · 11 |
| `Rua 7 de Setembro 120` | “7 de Setembro” é nome da rua; número 120 |
| `Av. Ana Costa 100 apto 3 Gonzaga Santos SP` | número 100 · complemento “apto 3” · bairro Gonzaga · Santos/SP |
| `1) Amador Bueno 25` | numeração de lista ignorada; sem tipo de logradouro → aviso |
| `Rua Braz Cubas, 20 - Centro - Santos/SP, 11010-000` | CEP, bairro, cidade e UF separados |
| `Rua Cidade de Toledo 15A casa 2 fundos` | número 15A · complemento “casa 2, fundos” |

Regras: o número é o último token numérico da rua que não faça parte de “N de Mês” e não seja complemento (“apto 12”); `nº/no/num/#` são aceitos; `S/N` é sem número (nunca inventa número); bairro desconhecido é **inferido e sinalizado**, não silencioso. Tabelas (CSV/XLSX) continuam sendo lidas pelo conteúdo das colunas (`schema.ts`).

## Escopo Santos/SP e desempate
- Sem cidade/UF informados → **Santos/SP**.
- Consulta ao geocodificador com `city=Santos`, `state=SP`, `countrycodes=br` e `viewbox` do município (viés, não filtro rígido).
- Os candidatos são pontuados (`rank.ts`): município coincide (+), dentro do recorte de Santos (+), bairro coincide (+), CEP coincide (+) e **proximidade da posição atual do aparelho** (+, decai com a distância). Homônimo em outra cidade perde mesmo com confiança maior.
- Dois pontos plausíveis em Santos com pontuação parecida → **revisão assistida** (mostra “Melhor sugestão” e “Alternativa”, “Usar este ponto”, confirmar posição/portaria). Se a posição do usuário resolve a dúvida, não pede revisão.
- A posição do usuário só desempata localmente; **não é enviada** ao provedor.
- Proveniência e motivo ficam salvos no endereço (`source`, `reason`).
- O Nominatim público continua só para uso pontual/lote pequeno com cota; para volume use instância própria (Ajustes).

## Duplicatas e várias cartas no mesmo imóvel
- Duas cartas para o mesmo imóvel são **duas cartas** e **uma parada**.
- Duplicata real = mesmo identificador **e** mesmo conteúdo. Identificador repetido com conteúdo diferente entra com aviso.
- Cartas ≠ endereço ≠ parada em todo o app.

## Reparo de importações antigas (“106, 106”)
Entregas → aviso “N carta(s) com cadastro inválido” → **Reprocessar a partir da linha original**. Usa a linha original guardada (`Letter.raw`), infere o esquema do lote pelo conteúdo e só corrige o que passa a ser válido. Sem linha original, nada é inventado. Nada é excluído sem confirmação.

## Limitações
- A resolução final de posição exige geocodificador (rede). Sem rede, as cartas entram e ficam “não localizadas”.
- Bairros reconhecidos por lista (Santos); bairros fora da lista são tratados como “inferidos”.
- O ranking por proximidade usa a última posição conhecida do aparelho (GPS); sem GPS, só município/bairro/CEP.
