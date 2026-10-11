# Auditoria Rota Santos 2.1

Base: APK `rota-santos-2.0.1-DEBUG.apk` (SHA-256 `4f8e4dbe…3ff5`) comparado ao código. UI Pack 2.1 (tokens, componentes, textos de recompensa) usado como direção visual; nenhum asset de terceiros foi copiado.

**Aviso de verificação.** Nada abaixo foi testado em **Android** (aparelho ou emulador): o emulador desta máquina não tem KVM e o renderer da WebView 113 cai (veja `TESTES_VISUAIS_ANDROID_ROTA_SANTOS.md`). As evidências são do **Chromium** (viewport 412×915, MapLibre real, WebGL por software) e de testes unitários/JVM. As capturas estão em `docs/evidencias-chromium-2_1/`.

## Defeitos, causa e correção
| # | Defeito (do relato) | Causa raiz comprovada | Correção | Prova |
|---|---|---|---|---|
| 1 | Rota continua no mapa após concluir/encerrar | Não havia um dono do estado: cada componente decidia o que desenhar (rota, início, marcadores, CTA) a partir de variáveis soltas; “Encerrar” só parava o GPS | `core/session.ts › deriveView()`: **uma** função decide a fase (`empty/unplanned/planned/navigating/paused/ended/completed`) e o que o mapa pode desenhar. `RouteMap` recebe `route/start/ahead` nulos fora das fases ativas. `endSession` (some a rota, preserva cartas, permite retomar) e `finishRoute`; efeito que encerra a navegação quando as paradas acabam | `tests/session_progress.test.ts` (8) + E2E: `data-route="off"` ao concluir **e** ao encerrar; capturas 10, 11, 12 |
| 2 | “Iniciar navegação” em estado incoerente | CTA dependia só de “há rota” | `canStart` só em `planned`; em `ended` aparece “Retomar rota”; em `completed` não há CTA de navegação | E2E: 0 botões “Iniciar navegação” após concluir/encerrar |
| 3 | Navegação sem “primeira pessoa” cartográfica | Câmera 3D tinha inclinação mas o usuário ficava no centro e o zoom era fixo | Navegação imersiva: pitch 60°, rumo = direção do movimento (parado não gira), usuário no terço inferior (padding superior ~42%), zoom dinâmico (devagar/perto da manobra = mais perto), alternância 2D/3D, gesto livre com retorno automático em 8 s | E2E lê a câmera real do MapLibre: `zoom 18.4, pitch 60°` em 3D e `pitch 0°` em 2D |
| 4 | Marcador de usuário fraco | Ponto azul pequeno | Marcador roxo com halo, anel de precisão e “última posição” cinza quando não há fix | capturas 01, 10 |
| 5 | Importação dependia de separador/cabeçalho | Texto livre caía em colunas simples | `core/freetext.ts` (FreeTextAddressResolver) integrado ao importador; ver `IMPORTACAO_INTELIGENTE_ENDERECOS.md` | `tests/freetext.test.ts` (15) + `freetext_import.test.ts` (5) + E2E com 9 linhas livres |
| 6 | Santos/SP e proximidade | Consulta sem viés; escolha só por confiança do provedor | `core/rank.ts`: pontuação por município/recorte/bairro/CEP + proximidade do aparelho; consulta com `viewbox` de Santos; ambiguidade → revisão assistida com alternativa | `tests/rank.test.ts` (6) + E2E (todas as consultas com viewbox, city=Santos, state=SP) |
| 7 | **Achado desta rodada:** a geocodificação em segundo plano sobrescrevia posições importadas/portaria | `resolve()` só protegia `exact/interpolated/manual`; posição “test”/portaria era regeocodificada e virava “não localizada” (rota com 4 de 9 cartas) | `resolve()` também respeita `entrance` e `test`; o teste agora espera o fim da geocodificação | E2E determinístico: 2 execuções idênticas (9 entregues, melhor sequência 7) |
| 8 | **Achado nas capturas:** bloco “Próxima parada” duplicado na navegação | Reescrita do painel por fase duplicou o trecho | Removida a duplicação | captura 07 |
| 9 | **Achado nas capturas:** endereços sem acento (“Praca”, “Feijo”) | `display` era montado do texto normalizado (sem acento) | `prettyKeep()`: exibição com o texto original acentuado; chave/consulta continuam sem acento | `tests/display_accents.test.ts` |
| 10 | Texto secundário com contraste 4,44:1 | `--muted` mais claro que o fundo novo | `--muted: #566275` | axe sem violações nas 4 telas |
| 11 | Pós-entrega pouco gratificante | — | `core/progress.ts` + `GameUi`: toast “Muito bem!”, restantes, parada X de Y, +XP, sequência, nível, som opcional; falha/pulo zeram a sequência sem punir; Desfazer reverte; tela de conclusão com resumo | `tests/session_progress.test.ts`, capturas 09, 10 |
| 12 | Origem manual × GPS | Ajustes só tinha o ponto manual | Ajustes → “De onde a rota começa”: localização atual (padrão) / ponto manual / última posição, cada uma com rótulo próprio na rota | captura 15 |
| 13 | Registros antigos “106, 106” | Ver `AUDITORIA_ROTA_SANTOS_2_0_1.md` | Mantido; reprocessamento seguro na aba Entregas | `tests/legacy.test.ts` |

## Arquitetura (responsabilidades)
`LocationService` → `ui/useNavigation.ts` + `native/rotaNav.ts` · `NavigationSessionService`/`RouteOverlayController` → `core/session.ts` (+ `RouteMap`) · `RoutingService` → `core/plan.ts`, `router.ts`, `navroute.ts` · `ImportParser` → `schema.ts` · `FreeTextAddressResolver` → `freetext.ts` · `GeocodingService` → `geocode.ts`, `rank.ts` · `DuplicateDetector` → `importer.ts` · `AddressRepairService` → `service.ts` (`diagnoseLegacy/reprocessLegacy`) · `DeliveryProgressService`/`GameFeedbackService` → `progress.ts`, `ui/GameUi.tsx` · `OfflineMapService` → `ui/offlineMap.ts` · `AndroidNavigationBridge` → plugin `RotaNav`.

## Limitações restantes
- **Sem teste em Android** (GPS real, voz, serviço em primeiro plano, notificação, tela bloqueada, retomada após o sistema matar o app, consumo de bateria).
- Contas antigas: endereços já gravados continuam sem acento na exibição (só importações novas).
- Geocodificação em escala exige provedor próprio/contratado; o Nominatim público segue limitado por política.
- O XP é um indicador operacional local; não há metas configuráveis além do padrão (lote) nesta versão.
