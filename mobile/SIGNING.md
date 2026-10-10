# Assinatura do APK RELEASE

O APK **debug** (`rota-santos-DEBUG.apk`) é assinado com a chave debug pública do Android
(`CN=Android Debug`). Serve para testes; **não é release**.

O APK **release** é gerado sem assinatura (`app-release-unsigned.apk`, não instalável) até você
configurar uma chave própria. A chave nunca entra no repositório (`*.jks`, `*.keystore`,
`keystore.properties` estão no `.gitignore`).

## 1. Criar a chave (uma vez, no seu computador)

```bash
keytool -genkeypair -keystore rota-release.jks -alias rota -keyalg RSA -keysize 4096 -validity 10000
```

Guarde o `.jks` e as senhas em local seguro, com cópia de segurança fora do computador.
**Se perder a chave, não será possível atualizar o app instalado; será preciso desinstalar.**

## 2a. Assinar no GitHub Actions (recomendado)

Em *Settings → Secrets and variables → Actions*, crie:

| Secret | Valor |
|---|---|
| `ROTA_KEYSTORE_BASE64` | saída de `base64 -w0 rota-release.jks` |
| `ROTA_KEYSTORE_PASSWORD` | senha do keystore |
| `ROTA_KEY_ALIAS` | `rota` |
| `ROTA_KEY_PASSWORD` | senha da chave |

Rode o workflow **APK Android (app offline)** (*Actions → Run workflow*). O artefato
`rota-santos-RELEASE-apk` traz `rota-santos-RELEASE.apk`, `SHA256SUMS.txt` e `signing.txt`.
O job falha se o release sair assinado com a chave debug.

## 2b. Assinar localmente

Crie `mobile/android/keystore.properties` (ignorado pelo git):

```
ROTA_KEYSTORE=/caminho/rota-release.jks
ROTA_KEYSTORE_PASSWORD=...
ROTA_KEY_ALIAS=rota
ROTA_KEY_PASSWORD=...
```

e rode `npm run android:sync && cd android && ./gradlew assembleRelease`.

## 3. Conferir antes de instalar

```bash
sha256sum rota-santos-RELEASE.apk          # compare com SHA256SUMS.txt
apksigner verify --print-certs rota-santos-RELEASE.apk   # não pode aparecer CN=Android Debug
```

## Trocar de debug para release no celular

Android não instala um APK por cima de outro assinado com chave diferente. Antes de trocar:
**Configurações → Backup criptografado** → guarde o arquivo; desinstale o debug; instale o release;
**Configurações → Restaurar backup**.
