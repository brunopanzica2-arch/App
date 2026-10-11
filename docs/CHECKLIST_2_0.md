# Checklist final — Rota Santos 2.0

Legenda: **CONCLUÍDO** = implementado e coberto por teste automatizado; **PARCIAL** = implementado, mas só verificável em aparelho ou com limitação; **BLOQUEADO** = exige conta/infra/chave; **NÃO FEITO**.

| Item | Estado | Nota |
|---|---|---|
| Importação inteligente + regressão Itororó + 211→28/183 | CONCLUÍDO | 24 testes + E2E |
| Desfazer/reimportar lote sem apagar outros | CONCLUÍDO | teste + E2E |
| Linha original e esquema inferido guardados | CONCLUÍDO | `Letter.raw`, `Batch.schema` |
| Mapa na tela inicial, 4 abas, painel inferior, botões sem corte | CONCLUÍDO (navegador) | E2E + axe; safe-area por CSS, **não visto em aparelho** |
| TalkBack | PARCIAL | rótulos e axe automático; sem teste com leitor de tela |
| Entrega: botões grandes, individual/todas, desfazer, motivos | CONCLUÍDO | E2E |
| Correção de endereço / ajuste de portaria | PARCIAL | fluxo existente via “Corrigir endereço” (tela de validação V3); sem reexame do parser antes do pino nesta versão |
| Geocodificação: pipeline, cache, fila, proveniência, 5 níveis | CONCLUÍDO (V3, mantido) | Nominatim público limitado |
| Provedores pagos (Google/Mapbox/HERE) | BLOQUEADO | sem contas/chaves |
| Localização contínua nativa (Fused + fallback) | PARCIAL | compila; GPS real não testado |
| Linha roxa sobre ruas reais + HUD + câmera 3D | PARCIAL | geometria e manobras testadas; renderização no mapa verificada só como build/E2E web, **navegação ao vivo não testada** |
| Recálculo com histerese | PARCIAL | lógica nativa testada na JVM; fluxo completo não testado em campo |
| Otimização a pé com travessia | CONCLUÍDO (V2/V3) | paridade com OR-Tools ≤3% |
| Voz pt-BR (TTS, ducking, repetir, números) | PARCIAL | texto testado na JVM; áudio real não testado |
| Comandos de voz (só com toque no microfone) | PARCIAL | implementado; não testado em aparelho |
| Serviço em primeiro plano + notificação privada + ações | PARCIAL | compila e consta no manifesto; não testado |
| Tela de bloqueio / `setShowWhenLocked` opcional | PARCIAL | implementado, desligado por padrão; não testado |
| Sem `ACCESS_BACKGROUND_LOCATION` nem full-screen intent | CONCLUÍDO | conferido no manifesto do APK |
| Retomar sessão (“Retomar N entregas”) | PARCIAL | diário em Settings + banner; sem teste automatizado do banner |
| Mapa offline (tiles) | CONCLUÍDO (V3) | “offline completo” não afirmado |
| Busca global, contadores | CONCLUÍDO | E2E |
| Tela “Hoje” dedicada, relatórios novos | NÃO FEITO | Histórico usa os relatórios existentes |
| Modo economia de bateria | PARCIAL | GPS 3 s/3 m; consumo não medido |
| LGPD | PARCIAL | dados só no aparelho; backup cifrado; notificação sem dados pessoais; sem logs com PII |
| Benchmarks em celular | NÃO FEITO | sem aparelho |
| APK debug | CONCLUÍDO | `releases/rota-santos-2.0.0-DEBUG.apk`, SHA-256 `453947d474dde9e9681d2eea24658f30f016b8bb10a6ede388004ca9776aaa75`, `br.santos.rota`, versionCode 4, 2.0.0-debug |
| APK release assinado | BLOQUEADO | sem sua chave |
| Testes: vitest 113 ok/3 skip; JUnit 15 ok; E2E 17 ok; backend pytest | vitest/JUnit/E2E CONCLUÍDO; pytest NÃO EXECUTADO | pytest precisa de PostGIS |
| OCR, vibração, setores da bolsa, regra de lado da rua, gamificação | FORA DE ESCOPO | exclusões do pedido |

## Atualização 2.0.1
| Item | Estado |
|---|---|
| Mapa em branco (altura 0 do contêiner) | corrigido; comprovado **no Chromium**; **BLOCKED em Android** (WebView do emulador sem KVM cai) |
| GPS automático, marcador só com fix válido, ponto manual ≠ GPS | implementado; E2E Chromium PASS; Android **NOT TESTED** |
| Perfil de pedestre (sem “pedalar”) | CONCLUÍDO (teste na malha real) |
| “106, 106” / lotes antigos | CONCLUÍDO (bloqueio na entrada + diagnóstico/reprocessamento pela linha original) |
| Capturas reais do APK em Android | **BLOCKED** |
