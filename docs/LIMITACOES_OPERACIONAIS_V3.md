# Limitações operacionais — V3

Prioridade: **P0** bloqueia uso real · **P1** necessário para operar bem · **P2** melhoria.
"Reprodução" diz como ver o problema; "Ação" diz o que fazer.

## P0 — nenhuma conhecida
Nenhum item P0 do critério da V3 ficou aberto *no que foi possível testar aqui*. **Mas** o gate P0 inclui comportamento em
aparelho real (persistência após fechamento forçado, memória), e isso **não foi testado num celular**. Até rodar o
roteiro de `TESTE_FISICO_ANDROID.md`, trate a V3 como **não validada em campo**.

## P1
| # | Limitação | Reprodução | Ação |
|---|---|---|---|
| 1 | **Nenhuma medição em Android real** (RAM, tempo de cálculo, bateria, quadros) | Todos os números do repositório são de contêiner Linux/Chromium headless | Rodar `scripts/adb/bench_device.sh` e o checklist |
| 2 | **Geocodificação em escala precisa de provedor próprio/contratado.** O Nominatim público fica limitado a 30 endereços por execução e à cota diária | Importar 300 cartas e tocar em "Localizar": para em 30 com a mensagem explicativa | Configurar URL de instância própria em Ajustes, ou confirmar no mapa / importar coordenadas |
| 3 | **Nenhum número de porta foi verificado em fonte cartográfica.** Os testes usam posições TESTE sobre as vias | `posicoes_teste_osm.csv` | Cenário C continua BLOQUEADO até haver fonte autorizada |
| 4 | Ponto de partida (Rua Joaquim Távora, 480) não validado | O Nominatim devolve o centro da rua e **muda de ponto** entre consultas (medido: −23,9480025/−46,3406209 numa e −23,9489139/−46,3336801 noutra, ~700 m de diferença) | Confirmar o pino manualmente no app (obrigatório) |
| 5 | Mapa offline cobre só o recorte (bbox −46,415/−24,005/−46,295/−23,915) e vai até zoom 15 (acima disso é ampliação) | Fora do recorte o mapa fica vazio | Rodar `mobile/scripts/extract_basemap.py` com outro bbox; atualizar o pacote periodicamente |
| 6 | Mapa offline sem ícones de POI (sprite não empacotado) e rótulos só em Latin-1/Latin Ext-A | Abrir o mapa | Aceitável para entrega; empacotar sprite se necessário |
| 7 | O tempo de atendimento (45 s + 10 s por carta extra + acesso) **não está calibrado** | Comparar ETA × jornada real | Coletar jornada real com consentimento e ajustar em Ajustes |

## P2
| # | Limitação | Detalhe |
|---|---|---|
| 8 | Acesso modelado como 2 × snap ÷ velocidade a pé por parada | Superestima (conservador) quando duas portas vizinhas estão do mesmo lado, e na última parada de rota aberta (a volta à via não é necessária). Máximo ≈ distância do snap ÷ velocidade a pé (30 m ≈ 24 s) por parada |
| 9 | Praças mapeadas como multipolígono não ganham travessia interna | Só o contorno é usado (nunca inventa caminho) |
| 10 | `cartographic_neighborhood` (bairro cartográfico) **não implementado** | O bairro continua o informado no arquivo; não entra na chave do endereço, então bairro errado não duplica parada, mas também não é corrigido por polígono |
| 11 | Sincronização entre vários aparelhos **não implementada** | Um aparelho por vez; mover dados por backup cifrado. O backend tem eventos idempotentes (`client_event_id`), base para uma sincronização futura |
| 12 | Cache de matriz só em memória (perde ao reiniciar o app) | O primeiro cálculo depois de abrir o app é completo (≈ 0,3 s por 150 paradas em Node; no celular não medido) |
| 13 | Rota circular/destino fixo e prioridade/setor não foram re-benchmarkados em escala | Cobertos por testes de unidade e pelos cenários de 150 paradas |
| 14 | Dependências com `npm audit` moderado | `npm audit` lista 3 avisos moderados nas dependências; não analisados um a um |
| 15 | APK release **sem assinatura** | Ver `mobile/SIGNING.md` |
| 16 | APK debug do GitHub Actions usa outra chave debug que os de `releases/` | Trocar de origem exige backup → desinstalar → reinstalar → restaurar |
