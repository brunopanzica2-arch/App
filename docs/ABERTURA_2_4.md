# Abertura 2.4 — cartão do estúdio + rota até o pino

## O que mudou e por quê
| Antes (2.3.1) | Agora (2.4.0) |
|---|---|
| Uma cena só (logo + letras + roda) de 4,3 s, app pesado (1,7 MB num bloco) só começava 1,4 s depois | Cena 1 "PANZICA PRODUCTIONS" (2,0 s) → Cena 2 rota/pino (1,5 s) → entrada do app (320 ms). O app carrega **em paralelo** desde o início |
| Spinner/roda sem relação com o carregamento real | Sem spinner de tela cheia: se os dados não chegaram, entra **skeleton no formato do cartão de parada** |
| Sempre completa | Completa na 1ª abertura do dia; nas demais só a cena 2 curta (~0,7 s); tocar pula; "Pular abertura" em Ajustes; reduced motion = cartão estático ~0,8 s |
| Bundle único | Código dividido por tela: o mapa (MapLibre, ~1,1 MB) é um bloco à parte |

## Sequência (tempos reais do código, `src/intro/policy.ts`)
- **Cena 0**: splash nativo do Android = só fundo preto (ícone vazio) → emenda sem corte.
- **Cena 1** (2000 ms): fade-in 600 ms com escala 1,04→1,00, feixe de luz passando pelas letras (900 ms, `mix-blend-mode: overlay`), fade-out 500 ms. Fonte **Bebas Neue** (SIL OFL, local em `public/fonts/bebas-neue/`, `preload` + `font-display: block`). Sem elementos de terceiros.
- **Cena 2** (1500 ms): fundo do app entra do preto; ruas decorativas; a rota é desenhada (`stroke-dashoffset`, `cubic-bezier(0.16,1,0.3,1)`); o pino cai com assentamento curto (sem bounce); o logo e o nome aparecem.
- **Entrada** (320 ms): o logo encolhe e sobe em direção ao canto; a lista de paradas entra com stagger de 25 ms (≤ 7 itens, ≤ 250 ms no total).
- Só `transform`, `opacity` e `stroke-dashoffset` são animados.

## Regras (testadas)
- 1ª do dia/instalação nova → completa. Mesmo dia → só cena 2 curta. Dia seguinte → completa. (Interpretei "aberto do zero" como "primeira vez do dia"; ao fechar e reabrir no mesmo dia vale a regra do mesmo dia.)
- Tocar na tela (ou Esc/Enter) pula a qualquer momento; é idempotente.
- Opção "Pular abertura" (Ajustes → Abertura do app) tem prioridade. Som discreto: **desligado por padrão**; o navegador/WebView não informa se o celular está no silencioso, então o controle é o botão de desligar (honestidade: não dá para respeitar o modo silencioso automaticamente).
- Dados não prontos ao fim da cena 2: espera até 2,5 s com o fundo do app (não congela no pino) e entra; se não chegar, o skeleton assume.
- Acessibilidade: animação com `aria-hidden`; "Carregando rota" em `aria-live`; no fim o foco vai para `#main-content`.

## Estados cobertos
Vazio (botão grande **Importar lista**) · com rota no cache (abre direto, sem tela de espera) · offline (banner) · carregando (skeleton) · processamento com etapas reais e **Cancelar** (cálculo de rota: distâncias → ordem → trajeto; importação: "Localizando endereços 124/187") · erro (Error Boundary por tela, "Tentar de novo"/"Recarregar", dados locais intactos).

**Desvio consciente do pedido:** o banner offline diz "Sem internet · tudo continua salvo neste aparelho. Buscas de endereço retomam quando voltar." e **não** "ações serão enviadas depois", porque o app é local-first e não tem fila de envio para servidor; prometer isso seria falso.

## Defeito real encontrado e corrigido
`useCurrentBatch` devolvia `null` enquanto lia o cache, então o mapa mostrava "Nenhuma entrega ainda" por um instante mesmo com rota salva. Agora há o sinal `resolved` e a tela fica no skeleton até o cache responder.

## Medições (Lighthouse 13.5, perfil mobile simulado, Chromium headless, mesma máquina, 3 rodadas alternadas)
Versão antiga = 2.3.1; nova = 2.4.x com o cartão do estúdio estático no `index.html`.
| Métrica | Antiga (2.3.1) | Nova |
|---|---|---|
| FCP | 0,75–0,80 s | 1,44–1,50 s |
| LCP | 15,7–15,8 s | 4,5–4,6 s |
| TBT | 0,75–2,4 s | 3,7–3,9 s |
| Speed Index | 2,5–2,8 s | 4,6–4,7 s |
| Pontuação | 0,46–0,56 | 0,50–0,51 |

Leitura honesta: **LCP caiu ~70%** (a versão antiga só "terminava" de pintar quando a roda/animação acabava), mas **FCP, TBT e Speed Index ficaram piores** nesta máquina: a nova tela carrega o app (React + banco + 1,1 MB do mapa) em paralelo à abertura, então a thread principal fica ocupada durante a animação. Uma medição anterior em outra máquina deu o contrário para TBT/SI, o que mostra que **o Lighthouse aqui oscila muito**; use só como ordem de grandeza e meça no seu aparelho. Pontuação geral: praticamente igual.

Quadros durante a abertura (Chromium com GL por software, pior caso): 190 quadros, 4 acima de 50 ms, pior 350 ms (momento em que o bloco do mapa é processado). **60 fps em Android barato não foi medido.**

## Testes
- Vitest: `tests/intro_policy.test.ts` (8), `tests/abertura.test.tsx` (10), `tests/states.test.tsx` (11), `tests/home_states.test.tsx` (5: vazio, carregando/skeleton, com rota no cache, offline, volta online). Suíte completa: 231 passam, 3 puladas.
- Playwright (viewport 412×915): `e2e/abertura.mjs` — 1ª do dia, 2ª do dia, tocar para pular, opção "Pular abertura", reduced motion, fonte, aria, foco, jank. `e2e/e2e_v2_0|1|3.mjs` seguem passando (regressão visual 0,00–0,14%).
- Quadros: `docs/evidencias-chromium-2_4/` (`filmstrip_abertura.png`).

## NÃO testado / depende de você no aparelho
- Android real (o emulador desta máquina não roda): splash nativo preto sem corte, 60 fps, som, tela de bloqueio.
- Modo silencioso (não detectável pelo app), rede lenta/avião no meio da importação, reabrir o app várias vezes no dia, fechar durante a geocodificação.
- PWA: o projeto **não tem manifest nem service worker** (é Capacitor); não implementei "splash de manifest".
- Skills `app-entregas-*` foram aplicadas depois de aparecerem com o prefixo `anthropic-skills:`; `frontend-design` não existe nesta conta/sessão (não carregada).

## Lista para testar no celular
1. Instalar o APK 2.4.0; abrir pela primeira vez: ver cartão → rota/pino → app. Medir se está liso.
2. Fechar e abrir de novo no mesmo dia: só a rota curta.
3. Tocar na tela no meio: pula sem travar.
4. Ajustes → Abertura do app → "Pular abertura": abrir direto.
5. Acessibilidade → remover animações: cartão estático ~0,8 s.
6. Modo avião antes de abrir: banner "Sem internet" e paradas do cache.
7. Rede lenta (3G) com a lista grande: skeleton aparece, sem tela branca.
8. Importar 187+ endereços: ver "Localizando endereços n/total", tocar Cancelar.
9. Modo silencioso com o som da abertura ligado: confirmar o volume baixo (o app não detecta silencioso).

---

## Addendum 2.8.0 — abertura em TODA abertura, mais cinematográfica, com som

**O que mudou**
- **Sempre toca:** `decideIntro` não usa mais a regra "1ª do dia". Cada abertura do app (inclusive várias no mesmo dia) roda cena 1 + cena 2 (~4,3 s). O modo "short" ficou só como legado (não é mais escolhido). Continuam valendo: tocar na tela / Esc / Enter pulam, "Pular abertura" em Ajustes, `prefers-reduced-motion` (cartão estático ~800 ms, sem som).
- **Cena 1 (estúdio):** halo roxo que expande atrás do título, duas linhas de luz que se abrem acima/abaixo, 14 partículas de "poeira de luz" subindo, título entra com escala 1,10→1 e brilho passando (1000 ms). Tudo no HTML estático do `index.html` (pinta antes do JS); só `transform`/`opacity`.
- **Cena 2 (rota):** rota agora 1400 ms; ponto branco (entregador) percorre a rota junto com o traço (SMIL `animateMotion`, mesma curva de desaceleração); mapa com zoom lento; ondas ao redor do pino quando pousa; logo desenhado em traço (anel + "P"); "ROTA SANTOS" aparece letra a letra. `TIMING.route` = 2300 ms.
- **Som (novo, `src/intro/sound.ts`):** sintetizado com Web Audio (sem arquivo/licença). Eventos agendados no relógio da animação (t=0 = início da página): crescendo grave + "whoosh" (0,1 s), batida + acorde (0,7 s), faíscas (1,0 s), tiques ascendentes da rota (2,0 s), "plop" + sino do pino (3,38 s), campainha do nome (3,66 s). Compressor no mestre; pular desvanece em 180 ms. **Ligado por padrão**; desliga em Ajustes → "Som discreto na abertura". Usa o volume de MÍDIA (o app não sabe se o celular está no silencioso).

**Evidências (Chromium, NÃO é Android)**
- Vitest: política, componente (2ª abertura do dia também completa, som liga/desliga/reduced) e agendamento do som (`tests/intro_sound.test.tsx`).
- E2E `e2e/abertura.mjs`: 2ª abertura do mesmo dia = `full` (~4,4 s). Jank sob GL por software oscila em torno do limite (6–9 quadros >50 ms em 5 execuções; limite 8; o pior quadro ~400 ms é o boot do JS, não a animação).
- Som renderizado offline (OfflineAudioContext → `docs/evidencias-chromium-2_4/abertura_som_preview.wav`, 5,2 s): pico 0,68, sem clipping, eventos nos instantes esperados.

**NÃO TESTADO:** reprodução real de áudio no aparelho Android (alto-falante, silencioso/Não perturbe, foco de áudio), sincronia som×imagem percebida em aparelho real, fluidez em celular real.
