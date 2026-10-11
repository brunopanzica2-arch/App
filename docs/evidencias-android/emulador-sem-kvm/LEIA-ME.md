# Emulador sem KVM — o que foi observado (evidência real, não é PASS)

Ambiente: contêiner Linux sem `/dev/kvm` (CPU sem vmx/svm), emulador 37.2.12, AVD `system-images;android-34;default;x86_64` (também testado `google_apis`), `-accel off` (TCG), `-gpu swiftshader_indirect`, 720x1600 / 280 dpi (e 1080x2400 / 420 dpi).

Resultado: o app **abre** (a splash do APK é capturada), mas o **processo de renderização da WebView (Chromium 113.0.5672.136) cai com SIGTRAP** (`CrRendererMain`, mesmo `pc` e mesmos registradores em todas as execuções) cerca de 45–60 s depois de iniciar, derrubando o app (`Render process … crash wasn't handled by all associated webviews`). A queda ocorre até com uma página HTML mínima de teste (sem MapLibre, sem o app), servida pelo host em `10.0.2.2`: nem o `fetch` de log dessa página chegou a executar. Portanto **não é causado pelo código do app** e **nenhuma captura da tela do app renderizado foi possível neste ambiente**.

Arquivos: `logcat_renderer_crash.txt` (trechos do Logcat).
Estado dos cenários que dependem da WebView: **BLOCKED** (veja `docs/TESTES_VISUAIS_ANDROID.md`).
