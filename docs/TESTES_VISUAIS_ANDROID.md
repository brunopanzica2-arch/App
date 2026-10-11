# Testes visuais em Android — Rota Santos 2.0.1

## Veredito
**A comprovação por capturas reais do APK na WebView do Android NÃO foi obtida nesta sessão.** O requisito P0.8 (“captura REAL do APK Android demonstra tela inicial, marcador e rota”) está **BLOCKED**. Nenhuma imagem de navegador foi apresentada como se fosse do Android.

## Ambiente tentado (sem aparelho físico, sem KVM)
- Contêiner Linux sem `/dev/kvm` (CPU sem vmx/svm). Emulador 37.2.12, TCG (`-accel off`).
- AVDs: `google_apis;x86_64` (API 34) e `default;x86_64` (API 34, AOSP), 1080×2400/420 dpi e 720×1600/280 dpi, 3–6 GB de RAM, `-gpu swiftshader_indirect` e `-gpu guest`.
- Android System WebView da imagem: **113.0.5672.136**.

## O que aconteceu (evidência em `docs/evidencias-android/emulador-sem-kvm/`)
1. A imagem `google_apis` entrou em ciclo de reinício do `system_server` (watchdog) e ANR do sistema — inutilizável sem aceleração.
2. Na imagem AOSP, o Bluetooth ficava em crash-loop e mantinha o `system_server` a >100% de CPU; **desativei o pacote** (`pm disable-user com.android.bluetooth`) e a carga caiu de ~9 para ~1.
3. Com o sistema estável o **app abre** (a splash do APK foi capturada em Android), mas o **processo de renderização da WebView cai com SIGTRAP** (`CrRendererMain`), sempre no mesmo `pc` e com os mesmos registradores, ~45–60 s após iniciar, o que derruba o app (`Render process … crash wasn't handled by all associated webviews`). Isso ocorreu com o APK 2.0.0, com o 2.0.1 e **até com uma página HTML mínima** servida do host (`10.0.2.2`), cujo `fetch` de log nem chegou a executar.
4. Conclusão: a falha está no renderer da WebView 113 sobre CPU emulada em TCG, **independente do código do app**. Não há como renderizar nenhuma tela do app neste ambiente. A tentativa com `-gpu guest` não chegou a concluir o boot.

Sem captura da falha original (2.0.0) renderizada, a “reprodução da tela branca” foi feita **no Chromium do navegador** (mesma pilha MapLibre/CSS): medição `{"w":412,"h":0,"canvas":true,"ch":300}` na 2.0.0 → altura 859 px e estado `operational` após a correção. Isso prova a causa do mapa em branco, mas **não substitui** o teste em Android.

## Matriz de cenários
| Cenário | Estado | Motivo |
|---|---|---|
| 01 Tela principal sem cartas (Android) | **BLOCKED** | renderer da WebView cai no emulador sem KVM |
| 02 GPS com marcador/movimento (Android) | **BLOCKED** | idem; `adb emu geo fix` e `pm grant` funcionam, a WebView não |
| 03 Rota desenhada (Android) | **BLOCKED** | idem |
| 04 Interface/legibilidade (Android) | **BLOCKED** | idem |
| 05 Importação (Android) | **BLOCKED** | idem |
| 06 Sem internet / offline (Android) | **BLOCKED** | idem |
| 07 Sessão, tela apagada, voz, bloqueio | **NOT TESTED** | exige aparelho; TTS e lockscreen não verificáveis aqui |
| 08 Confirmação de entregas (Android) | **BLOCKED** | idem |
| 09 Resiliência do mapa (Android) | **BLOCKED** | idem |
| 10 Antes/depois lado a lado | **BLOCKED** | sem captura Android da 2.0.0 |
| 01–05, 08 no **Chromium** (viewport 412×915) | **PASS** (não é Android) | `mobile/e2e/e2e_v2_0.mjs`: 20 verificações, incluindo mapa `operational` (canvas >300 px, PNG com detalhe), GPS automático, importação (Itororó, 300 linhas), entrega/desfazer, busca, abas, axe sem violações, 0 chamadas ao Nominatim |
| Permissões, serviço, notificação (manifesto) | PASS estático | `aapt2 dump permissions`: sem `ACCESS_BACKGROUND_LOCATION` |

## Como repetir em máquina com aceleração (KVM) ou aparelho físico
```bash
# aparelho físico: ativar depuração USB; emulador: AVD x86_64 API 34 com KVM
adb devices -l
cd mobile && npm run android:apk
node scripts/android/suite.mjs ../releases/rota-santos-2.0.1-DEBUG.apk run-$(date +%Y%m%d-%H%M)
```
`scripts/android/suite.mjs` (cenários 01 e 02: mapa operacional, GPS com 3 deslocamentos, permissão negada e retomada) e `lib.mjs` (adb, `screencap`, CDP do WebView) **foram escritos, mas só puderam ser exercitados até o ponto em que a WebView cai**: não há resultado PASS deles. Os demais cenários (03–10) **ainda não têm automação**; estão listados acima como BLOCKED/NOT TESTED.
