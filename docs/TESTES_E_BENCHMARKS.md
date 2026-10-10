# Testes e benchmarks — Rota Santos 2.0

**O que NÃO foi feito:** nenhum teste em aparelho Android nem em emulador (ambiente sem KVM/aparelho). GPS real, TTS, serviço em primeiro plano, tela de bloqueio, consumo de bateria e desempenho em celular **não foram medidos**. Dados de teste: 300 cartas e posições TESTE fictícias (nós OSM, não portas). Nenhum benchmark novo de desempenho foi produzido nesta etapa; os números de otimização continuam os de `RESULTADOS_COMPARATIVOS_V2.md`, medidos em contêiner Linux.

## Executados nesta sessão
| Camada | Comando | Resultado |
|---|---|---|
| Unidade/integração TS | `cd mobile && npx vitest run` | ver registro final no checklist |
| Importação inteligente | `tests/import_inference.test.ts` (24 casos): linha `Rua Itororó;118;Centro;Santos;SP`, repro 211→28+183 e correção, matriz de formatos, volumes 1..1000, desfazer lote | passam |
| Manobras | `tests/navroute.test.ts` (6) + `tests/navroute_real.test.ts`: rota real de 150 paradas → 15,45 km, 137 manobras (≈113 m/manobra), 99% com nome de rua, 20 retornos (“faça o retorno”: becos e acessos de ida e volta) | passam |
| Motor nativo (JVM) | `cd mobile/android && ./gradlew :app:testDebugUnitTest` — `PtBrTest` (5) + `NavigationEngineTest` (9): ordem dos avisos, texto de chegada por precisão, ruído de GPS ≠ desvio, 1 evento de desvio, baixa precisão ignorada, progresso monotônico, pausa, repetir | passam |
| Compilação Android | `./gradlew :app:assembleDebug` | compila (Fused Location, plugin, serviço, manifesto) |
| E2E navegador | `node e2e/e2e_v2_0.mjs` (Chromium, 412×915): 17 verificações — linha sem cabeçalho, 300 cartas, rota em um toque, botões sem corte, entrega/desfazer, busca, 4 abas, desfazer importação, axe WCAG A/AA nas 4 telas, 0 consultas ao Nominatim | todas passaram |

## Reprodução do bug de importação (211 → “28 + 183”)
Causa raiz: uma coluna de identificador com poucos valores distintos era tratada como chave única, então linhas diferentes viravam “duplicadas”. Correção: coluna de ID só vale se ≥50% dos valores forem distintos; duplicata = mesmo ID **e** mesmo conteúdo. Evidência “antes”: `docs/EVIDENCIAS_2_0/repro_antes_importacao.txt`.

## Para testar no aparelho (não feito)
Veja `mobile/scripts/adb/` e `NAVEGACAO_E_PERMISSOES_ANDROID.md`. Roteiro mínimo: instalar o APK; conceder localização e notificações; importar; calcular rota; iniciar navegação; apagar a tela e caminhar 200 m ouvindo as instruções; trocar de app; encerrar pela notificação; medir bateria em 30 min.
