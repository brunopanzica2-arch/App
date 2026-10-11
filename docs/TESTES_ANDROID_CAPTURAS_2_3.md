# Testes Android e capturas 2.3 — BLOQUEADO

Nenhuma das 40 capturas Android foi obtida. Não há capturas simuladas.

- Ambiente: contêiner sem KVM. Emulador Google APIs (WebView 113.0.5672.136) por emulação pura.
- Tentativa 2.3: APK 2.3.0 instalado e iniciado; o system_server entrou em ANR ("Process system isn't responding"), `docs/evidencias-android/emulador-sem-kvm/2_3_anr_system_server.png`. Tentativas anteriores: renderer do WebView com SIGTRAP; imagem AOSP com crash-loop de Bluetooth; `-gpu guest` não inicializou.
- Substituto (NÃO equivale a Android): Chromium 412×915 com Playwright — `docs/evidencias-chromium-2_3/` e `docs/evidencias-chromium-2_1/`, scripts `mobile/e2e/e2e_v2_3.mjs`, `e2e_v2_1.mjs`, `e2e_v2_0.mjs`, `splash.mjs`.
- Para validar em aparelho: instalar `releases/rota-santos-2.3.0-DEBUG.apk`, rodar `mobile/scripts/android/suite.mjs` com `adb` e um aparelho/emulador com aceleração.
- Não verificados: GPS real, TTS pt-BR, serviço em primeiro plano, tela bloqueada, permissões, rotação, splash nativo.
