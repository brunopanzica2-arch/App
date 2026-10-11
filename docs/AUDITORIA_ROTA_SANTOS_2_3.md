# Auditoria Rota Santos 2.3

Legenda: PASSOU (evidência real) · PARCIAL · BLOQUEADO (não foi possível) · NÃO FEITO.

| Item | Estado | Evidência / observação |
|---|---|---|
| P0 causa raiz da rota por trilha | PASSOU | `INCIDENTE_ROTA_TRILHA_MORRO.md`, `tests/trail_safety.test.ts` |
| Perfil urbano no pipeline do grafo (matriz e navegação) | PASSOU | RSG2, `router.ts`; 8 testes |
| Mensagem honesta sem rota segura | PASSOU | teste de snap/plan |
| Valhalla/GraphHopper | NÃO FEITO | não avaliados com dados; sem servidor |
| Número nunca vira S/N | PASSOU | `number_preserve.test.ts` |
| Destino impreciso não é "entregável"/porta | PARCIAL | UI marca "Destinos aproximados"; "Você chegou à portaria" em baixa confiança **não foi revisado** no motor nativo |
| Guarda antes de navegar + confirmação | PASSOU (Chromium) | E2E SEG-01/02 |
| Reportar trecho + recálculo | PASSOU (Chromium) | E2E SEG-03 |
| Busca universal Endereços/Minhas entregas | PASSOU (Chromium, provedor interceptado) | E2E BUSCA-01..07, `search.test.ts` |
| Busca com provedor real | NÃO TESTADO | rede pública não usada nos testes |
| Importação colar-e-pronto | PASSOU (Chromium/Node) | E2E 2.0/2.1; escala só parse |
| Máquina de estados de sessão | PARCIAL | fases `deriveView` (2.1) testadas; nomes idle/importado/… do prompt não renomeados; confirmação ao Encerrar não adicionada |
| Câmera imersiva, GPS, TTS, foreground service | PARCIAL | código e E2E web; **nada validado em Android** |
| Offline real (mapa+motor) | PARCIAL | malha e PMTiles locais; não validado em aparelho |
| Splash Panzica Productions | PASSOU (Chromium) + nativo compilado | `docs/evidencias-chromium-2_3/splash_*.png`; splash nativo não visto em aparelho |
| P2 premium + recompensas | PASSOU (Chromium) | regressão visual 0,00% |
| 40 capturas Android | **BLOQUEADO** | ver `TESTES_ANDROID_CAPTURAS_2_3.md` |
| APK debug | PASSOU (build) | `releases/rota-santos-2.3.0-DEBUG.apk`, versionCode 7; sem `server.url`, sem ACCESS_BACKGROUND_LOCATION |
| APK release assinado | BLOQUEADO | sem sua chave |

Testes: Vitest 199 passam (3 pulados); E2E Chromium 2.0, 2.1 (visual 0,00%), 2.3 e splash passam; JUnit nativo da 2.1 não reexecutado nesta rodada.

Critérios de bloqueio de release: nenhum foi violado **nos testes que existem**, mas "rota sem aviso por trecho privado" e "mapa branco" só foram verificados no Chromium, não no Android → release não recomendado antes de teste físico.
