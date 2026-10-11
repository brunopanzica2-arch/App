# Testes visuais — Rota Santos 2.1

## Veredito honesto
- **Android (aparelho ou emulador): NÃO executado com sucesso.** O emulador desta máquina não tem KVM; a WebView do sistema (Chromium 113) cai com SIGTRAP no processo de renderização ~45–60 s depois de abrir, até com uma página HTML mínima (evidência e logs em `docs/evidencias-android/emulador-sem-kvm/` e `TESTES_VISUAIS_ANDROID.md`). Nenhuma captura da 2.1 em Android existe. Todos os cenários Android abaixo estão **BLOCKED** ou **NOT TESTED**.
- **Chromium (navegador, viewport de celular 412×915, MapLibre real com ruas, WebGL por software): executado e aprovado.** Não é Android: o que ele cobre é a interface, o estado, o mapa e a câmera; não cobre GPS nativo, TTS, serviço em primeiro plano, notificação nem tela de bloqueio. As imagens estão em `docs/evidencias-chromium-2_1/` e foram abertas e analisadas uma a uma.

## Cenários pedidos (seção 9.2) × estado
| # | Captura pedida | Android | Chromium (evidência) |
|---|---|---|---|
| 1 | Home sem entregas | BLOCKED | PASS `01_home_sem_entregas.png` (mapa operacional, marcador, chip GPS, CTA) |
| 2 | Home com entregas e sem rota | BLOCKED | PASS `05_home_com_entregas_sem_rota.png` |
| 3 | Home com rota calculada | BLOCKED | PASS `06_home_rota_calculada.png` |
| 4 | Navegação 2D | BLOCKED | PASS `08_navegacao_2d.png` (pitch 0°) |
| 5 | Navegação imersiva 3D | BLOCKED | PASS `07_navegacao.png` (zoom 18,4, pitch 60°, lido da câmera real) |
| 6 | Após concluir 1 entrega | BLOCKED | PASS `09_apos_uma_entrega_recompensa.png` |
| 7 | Após concluir todas | BLOCKED | PASS `10_rota_concluida.png` (rota fora do mapa, resumo) |
| 8 | Após encerrar navegação | BLOCKED | PASS `12_apos_encerrar.png`, `11_apos_limpar.png` |
| 9 | Importação por texto livre | BLOCKED | PASS `02_importacao_vazia.png`, `03_importacao_texto_livre.png` |
| 10 | Revisão de endereço ambíguo | BLOCKED | PARCIAL: `04_revisao_enderecos.png` (a lógica de ambiguidade é testada em `rank.test.ts`; a tela com “Alternativa/Usar este ponto” não teve captura com um caso realmente ambíguo) |
| 11 | Ajustes de localização | BLOCKED | PASS `15_ajustes_localizacao.png` |
| 12 | Sem internet | BLOCKED | NOT TESTED nesta bateria (o pacote offline foi testado na V3 e o estado do pacote aparece em Ajustes) |
| 13 | Retorno da sessão após fechar/reabrir | BLOCKED | PASS `14_reabrir_app.png` (estado coerente: rota planejada + “Retomar”) |
| 14 | Lockscreen/notificação | NOT TESTED | só aparelho |

## Verificações funcionais (E2E Chromium — `mobile/e2e/e2e_v2_1.mjs`, 2 execuções idênticas)
Mapa operacional e GPS automático sem ponto manual · 9 linhas livres sem separador (3 cartas no mesmo imóvel = 1 parada) · Santos/SP em todas as consultas (viewbox+cidade+UF; 14 consultas interceptadas, nenhuma saiu para a rede) · estados B/C/D · câmera 3D real (pitch 60°) e 2D (0°) · recompensa curta · **rota some do mapa ao concluir e ao encerrar**, sem “Iniciar navegação”, com “Retomar rota”/resumo · reabrir app coerente · 3 origens em Ajustes · axe WCAG A/AA sem violações · sem erros de página.
Regressão visual (pixelmatch, limiar 2%, regiões dinâmicas mascaradas): `01`, `03` e `10` com 0,00% de diferença contra `mobile/e2e/baseline/`. A suíte falha se a home voltar a ficar sem detalhe (variância de cor < 12) ou se o mapa não ficar `operational`.
Também passam: `e2e_v2_0.mjs` (20 verificações), 158 testes TypeScript, 15 JUnit do motor nativo.

## O que ainda precisa de aparelho
GPS real e seguimento · voz (TTS) e anúncios · serviço em primeiro plano e notificação · tela apagada/bloqueada · recuperação após o Android matar o app · bateria · desempenho da WebView em celular de entrada.

## Como repetir
```bash
cd mobile && npm run build && npx vite preview --port 4173 &
node e2e/e2e_v2_1.mjs                 # compara com e2e/baseline; --update-baseline recria
# Android (precisa de KVM ou aparelho): node scripts/android/suite.mjs ../releases/rota-santos-2.1.0-DEBUG.apk run-1
```
