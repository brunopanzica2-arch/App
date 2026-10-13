# Lista de entrega — 18 endereços em Santos/SP

Arquivos:
- `entregas_santos_18.csv` — **use este**: Importar lista → Arquivo (UTF-8, `;`).
- `entregas_santos_18_colar.txt` — a mesma lista em texto para **colar** (uma por linha; também funciona tudo numa linha só).

## Conferência com a base do IBGE (CNEFE, Censo 2022 — a mesma que o app 2.6 usa offline)
Resultado: **17 de 18** têm o número no CNEFE com o **ponto do endereço** (nível 1). Nenhum veio do OpenStreetMap: o serviço público devolveu **0 de 18 números** em teste real.

| Linha | Endereço | IBGE | Nome oficial | Bairro (IBGE) |
|---|---|---|---|---|
| ENT001 | Rua João Éboli, 53 | ✓ ponto do endereço | Rua Joao Eboli | Vila Matias |
| ENT002 | Avenida Conselheiro Nébias, 78 | ✓ ponto do endereço | Avenida Conselheiro Nebias | Paquetá |
| ENT003 | Rua Doutor Cochrane, 197 | ✓ ponto do endereço | Rua Doutor Cochrane | Santos |
| ENT004 | Rua Tiro Naval, 8 | ✓ ponto do endereço | Rua Tiro Naval | Centro |
| ENT005 | Avenida Conselheiro Nébias, 95 | ✓ ponto do endereço | Avenida Conselheiro Nebias | Paquetá |
| ENT006 | Rua Sete de Setembro, 35 | ✓ ponto do endereço | Rua Sete de Setembro | Santos |
| ENT007 | Rua Cerquinho, 21 | ✓ ponto do endereço | Rua Cerquinho | Santos |
| ENT008 | Rua São Paulo, 94 | ✓ ponto do endereço | Rua Sao Paulo | Vila Belmiro |
| ENT009 | Rua Doutor Cesário Bastos, 1 | ✓ ponto do endereço | Rua Doutor Cesario Bastos | Vila Belmiro |
| ENT010 | Rua Antônio Bento, 278 | ✓ ponto do endereço | Rua Antonio Bento | Vila Belmiro |
| ENT011 | Rua Antônio Bento, 234 | ✓ ponto do endereço | Rua Antonio Bento | Vila Belmiro |
| ENT012 | Rua Silveira Lobo, 15 | ✓ ponto do endereço | Rua Silveira Lobo | Vila Mathias |
| ENT013 | Rua São Paulo, 37 | ✓ ponto do endereço | Rua Sao Paulo | Vila Mathias |
| ENT014 | Rua Joaquim Nabuco, 5 | ✓ ponto do endereço | Rua Joaquim Nabuco | Vila Matias |
| ENT015 | Rua General Câmara, 85 | ✓ ponto do endereço | Rua General Camara | Centro |
| ENT016 | Rua Professor Manuel de Abreu, 117 | ✓ ponto do endereço | Rua Professor Manuel de Abreu | Vila Mathias |
| ENT017 | Rua Capitão Adolfo Millon, 12 | ✓ ponto do endereço | Rua Capitao Adolfo Millon | Vila Mathias |
| ENT018 | Rua Pastor Narciso de Andrade, 42 | ⚠ confirmar | Praca Narciso de Andrade | Vila Matias |

O bairro já foi preenchido com o do IBGE (ajuda a separar ruas homônimas). Destinatário e CEP ficaram em branco: você não informou.

## Limites (honestos)
- Pontos do CNEFE são para fins **estatísticos**: nível 1 = ponto do endereço, não é a porta confirmada. Use "Marcar a porta aqui (GPS)" na rua para fixar a porta.
- **ENT018**: "Rua Pastor Narciso de Andrade" não existe no IBGE; existe a **Praça** Narciso de Andrade. O app mostra como candidato e **não aceita sozinho**.
- A base do IBGE tem os endereços de 2022; construções novas podem faltar.
