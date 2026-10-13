# Lista de entrega — 18 endereços em Santos/SP

Arquivos:
- `entregas_santos_18.csv` — **use este**: Importar lista → Arquivo. UTF-8, separador `;`, colunas que o app reconhece sozinho.
- `entregas_santos_18_colar.txt` — a mesma lista em texto livre (uma por linha) para **colar** em Importar lista → Colar texto.

Conferido com o próprio importador do app: 18 linhas, 18 válidas, 18 endereços distintos, 0 erros. Os números foram mantidos exatamente como você mandou (nenhum virou S/N). Bairro, CEP e destinatário ficaram em branco de propósito: você não os informou e o app não inventa.

## Conferir antes de sair (a coluna `observacoes` já traz o aviso)
| Linha | Endereço | Por quê |
|---|---|---|
| ENT001 | Rua João Éboli, 53 | na malha de Santos só existe "Rua **Doutor** João Éboli" |
| ENT005 | Av. Conselheiro Nébias, 95 | você digitou "avenida nebias"; assumi Conselheiro Nébias (a mesma da linha 2) |
| ENT006 | Rua Sete de Setembro, 35 | na malha aparece como "Rua 7 de Setembro" (mesma rua) |
| ENT010, ENT011 | Rua Antônio Bento, 278 e 234 | há "Rua Antonio Bento" e "Rua Doutor Antônio Bento" |
| ENT017 | Rua Capitão Adolfo Millon, 12 | na malha consta "Rua Adolfo Millon" |
| ENT018 | Rua Pastor Narciso de Andrade, 42 | **não encontrada** na malha offline; só existe "Praça Coronel Narciso de Andrade" |

Acentos foram acrescentados só onde o nome é conhecido (João, Nébias, Cesário, Antônio, Câmara); o app compara sem acento.

## Limites (honestos)
- Não consultei o geocodificador online: **as posições ainda serão calculadas pelo app** ao importar. Endereços em que o provedor achar só a rua ficam marcados "número não confirmado" e a rota avisa "Destinos aproximados — confirme no local".
- A checagem de existência das ruas foi só contra a malha de pedestres offline do app (OpenStreetMap), que pode estar incompleta.
