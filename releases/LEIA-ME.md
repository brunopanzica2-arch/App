# APKs

| Arquivo | Tipo | Instalável? |
|---|---|---|
| `rota-santos-2.5.0-DEBUG.apk` | **debug**, `br.santos.rota`, versionCode 10, 2.5.0-debug | Sim; mesma chave debug (atualiza por cima; backup antes). SHA-256 `8b1435f97d4a875cadd7608062de38e1af7b8a10265eae346fe14f7427f8583e`. Perfil urbano seguro (corrige rota por trilha), busca de endereços, **2.5: identifica todos os números mesmo com a lista colada numa linha só, estima números que o mapa não tem e marca a porta com GPS (`docs/IMPORTACAO_E_BUSCA_GEOGRAFICA.md`)**; abertura em 2 cenas (cartão Panzica Productions → rota até o pino), pular, skeletons, banner offline, progresso por etapas (`docs/ABERTURA_2_4.md`). **NÃO testado em Android** (`docs/TESTES_ANDROID_CAPTURAS_2_3.md`). |
| `rota-santos-2.1.0-DEBUG.apk` | **debug**, `br.santos.rota`, versionCode 6, 2.1.0-debug, minSdk 24 | Sim; mesma chave debug das versões anteriores (atualiza por cima; faça backup antes). SHA-256 `183c5bf2350bbc96d619dbf03d51c8cb429556a47bf99d5666c725fbf57c8f09`. **Não testado em Android** (veja `docs/TESTES_VISUAIS_ANDROID_ROTA_SANTOS.md`). Release assinado: BLOQUEADO (sem sua chave). |
| `rota-santos-2.0.1-DEBUG.apk` | **debug**, `br.santos.rota`, versionCode 5, 2.0.1-debug | Sim; mesma chave debug (atualiza por cima da 1.2.0/2.0.0, faça backup antes). Corrige o mapa em branco (altura 0), GPS automático, perfil de pedestre, importação. **NÃO testado em Android** (veja `docs/TESTES_VISUAIS_ANDROID.md`). |
| `rota-santos-2.0.0-DEBUG.apk` | **debug**, `br.santos.rota`, versionCode 4, versionName 2.0.0-debug, minSdk 24 | Sim. Mesma chave debug da 1.2.0 (SHA-256 do certificado `556b8b16…e9a9b`, conferido com `apksigner`): atualiza **por cima** sem apagar dados (faça backup cifrado antes). Migração testada só em Node/Chromium. **Não testado em aparelho.** Release assinado: BLOQUEADO (sem sua chave; ver `mobile/SIGNING.md`). |
| `rota-santos-1.2.0-DEBUG.apk` | **debug** (chave `CN=Android Debug`), versão 1.2.0 (auditoria V3: mapa de ruas offline, portaria, fila de geocodificação) | Sim. Atualiza a 1.0/1.1 por cima (mesma chave debug, conferido com `apksigner`; a migração dos dados foi testada em Node e no Chromium, **não** num Android real). Faça o backup cifrado antes. Uso pessoal/testes. |
| `rota-santos-1.2.0-RELEASE-UNSIGNED.apk` | release (sem depuração, sem assinatura) | **Não**: precisa ser assinado com a sua chave (ver `mobile/SIGNING.md`). |
| `rota-santos-1.0.apk` | debug antigo (antes da auditoria V2) | Obsoleto. |

Confira o arquivo com `sha256sum -c SHA256SUMS.txt`.

**Atenção com o APK que sai do GitHub Actions:** cada máquina cria a sua própria chave *debug*. O APK debug do CI tem outra assinatura e o Android **não** o instala por cima destes arquivos (nem o contrário). Para trocar de origem: Ajustes → exportar backup (com senha) → desinstalar → instalar → restaurar backup.
