# Auditoria Rota Santos 2.0

Escopo: app Android (Capacitor + React) de entregador a pé em Santos/SP. **Nada foi testado em aparelho ou emulador.** Dados de teste: fictícios; posições TESTE são nós OSM, não portas. Evidências: `docs/EVIDENCIAS_2_0/`.

## Bugs e causas raiz
| # | Problema | Causa raiz | Correção | Reprodução / teste | Resultado |
|---|---|---|---|---|---|
| 1 | 211 linhas viravam “28 inseridas + 183 duplicadas” | Coluna de identificador com poucos valores distintos era usada como chave única; linhas diferentes colidiam | Coluna de ID só vale se ≥50% distintos; duplicata = mesmo ID **e** mesmo conteúdo; ID igual com conteúdo diferente entra com aviso | `import_inference.test.ts` (repro e correção); saída “antes” em `EVIDENCIAS_2_0/repro_antes_importacao.txt` | 211 inseridas, 0 duplicadas |
| 2 | `Rua Itororó;118;Centro;Santos;SP` sem cabeçalho dava mapeamento errado (número como logradouro) | Mapeamento por nome de coluna; sem cabeçalho caía em posições fixas | Inferência por **conteúdo** (prefixos de rua, CEP, UF, cidade/bairro conhecidos, padrões de número); erro explícito se o logradouro for só um número | Teste unitário + E2E `IMP-01` | Logradouro, Número, Bairro, Município, UF |
| 3 | (achado nesta sessão) Na tela, o CSV inteiro virava texto livre: 301 “linhas” e linha colada em coluna única | A tela passava `delimiter: null` (= “sem separador”) em vez de “detectar” | `undefined` quando “Detectar” | E2E falhou antes (`IMP-01/02/03`) e passou depois | 300 linhas, 0 duplicadas |
| 4 | (achado nesta sessão) Aviso “Desfazer” da entrega ficava atrás do painel inferior, impossível de tocar | Posição fixa embaixo, sob o painel | Aviso no topo, acima do painel | E2E travou no clique, passou depois | Desfazer funciona |
| 5 | Navegação parava com a tela apagada | Temporizadores do WebView são suspensos | Motor, GPS e voz em Java num serviço em primeiro plano; eventos em buffer | JUnit do motor; **sem teste em aparelho** | Implementado, não validado em campo |
| 6 | Cartas, endereços e paradas misturados | — | Cartas ≠ endereço ≠ parada em todas as telas e contadores | E2E `UX-02`: 300 cartas / 150 paradas | ok |

## Entregue na 2.0 (ver checklist abaixo para o estado de cada item)
Importação inteligente (CSV/XLSX/TXT/colado, com ou sem cabeçalho, `;` `,` tab, aspas; linha original e esquema inferido guardados; desfazer lote sem tocar em outros) · mapa como tela inicial · 4 abas · painel inferior com Entregue / Não consegui / Pular / Detalhes · “Entregar todas” ou individual com confirmação · desfazer · busca global · contadores · retomar sessão interrompida · linha roxa estilo navegação (halo + contorno + núcleo) com trecho restante · HUD “Em 90 m, vire à direita na Rua…” · câmera 2D/3D · recálculo com histerese · voz pt-BR nativa · comandos de voz só ao tocar no microfone · serviço em primeiro plano com notificação privada · preferências de voz/GPS/tela de bloqueio.

## Limitações conhecidas
- Roteador próprio sobre grafo OSM (não Valhalla/GraphHopper). 20 de 137 manobras na rota de teste são “faça o retorno” (becos/acessos de ida e volta); não validado se incomoda em campo.
- Posição interpolada fala “próximo do número”; só a rua não afirma proximidade.
- Geocodificação em escala exige provedor próprio ou contratado (BLOQUEADO sem credenciais).
- Backend FastAPI/PostGIS: suíte pytest **não executada** nesta sessão (precisa de PostGIS); o CI do repositório a executa. Nada do backend foi alterado na 2.0.
