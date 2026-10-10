# APKs

| Arquivo | Tipo | Instalável? |
|---|---|---|
| `rota-santos-1.2.0-DEBUG.apk` | **debug** (chave `CN=Android Debug`), versão 1.2.0 (auditoria V3: mapa de ruas offline, portaria, fila de geocodificação) | Sim. Atualiza a 1.0/1.1 por cima (mesma chave debug, conferido com `apksigner`; a migração dos dados foi testada em Node e no Chromium, **não** num Android real). Faça o backup cifrado antes. Uso pessoal/testes. |
| `rota-santos-1.2.0-RELEASE-UNSIGNED.apk` | release (sem depuração, sem assinatura) | **Não**: precisa ser assinado com a sua chave (ver `mobile/SIGNING.md`). |
| `rota-santos-1.0.apk` | debug antigo (antes da auditoria V2) | Obsoleto. |

Confira o arquivo com `sha256sum -c SHA256SUMS.txt`.

**Atenção com o APK que sai do GitHub Actions:** cada máquina cria a sua própria chave *debug*. O APK debug do CI tem outra assinatura e o Android **não** o instala por cima destes arquivos (nem o contrário). Para trocar de origem: Ajustes → exportar backup (com senha) → desinstalar → instalar → restaurar backup.
