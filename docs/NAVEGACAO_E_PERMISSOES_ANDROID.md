# Navegação, voz e permissões no Android (Rota Santos 2.0)

> Estado de verificação: o motor de navegação (manobras, anúncios, desvio) e o texto pt-BR têm **testes JUnit na JVM**
> (`mobile/android/app/src/test`). A localização real, a voz do TTS, o serviço em primeiro plano e a tela de bloqueio
> **não foram testados em aparelho nem em emulador** nesta sessão (sem KVM/aparelho). Veja `TESTES_E_BENCHMARKS.md`.

## Arquitetura
O WebView do Capacitor tem os temporizadores JS suspensos com a tela apagada. Por isso a navegação contínua roda em Java:

| Peça | Arquivo | Função |
|---|---|---|
| Localização | `nav/LocationSource.java` | `FusedLocationProviderClient` (Play Services) com *fallback* para `LocationManager` (GPS + rede). 1 s em alta precisão; 3 s / 3 m na economia de bateria. |
| Motor | `nav/NavigationEngine.java` | Projeta a posição na rota, ignora fixes com precisão pior que 60 m, anuncia manobras (100 m, 50 m, agora), detecta desvio com histerese (≥3 fixes, ≥6 s, distância > max(30 m, 1,5× precisão)). |
| Voz | `nav/TtsController.java`, `PtBr.java` | `TextToSpeech` pt-BR, `AudioFocus` com *ducking* (`USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`). Números por extenso, abreviações (R., Av., Pç.) expandidas. O texto vem das manobras reais da rota — nenhum modelo generativo. |
| Sessão | `nav/NavSession.java` | Singleton do processo. Mantém o motor vivo sem o WebView; guarda até 60 eventos e entrega ao voltar (`drain`). |
| Serviço | `nav/NavForegroundService.java` | `foregroundServiceType="location"`, notificação com **Pausar/Retomar, Repetir, Abrir mapa, Encerrar**. |
| Ponte | `nav/RotaNavPlugin.java`, `src/native/rotaNav.ts` | Plugin Capacitor `RotaNav` + substituto web (geolocation + `speechSynthesis`). |

## Permissões
| Permissão | Quando é pedida | Por quê |
|---|---|---|
| `ACCESS_FINE_LOCATION` / `COARSE` | Ao tocar em *Iniciar navegação* ou no botão de localização | Posição enquanto o app navega (primeiro plano / serviço em primeiro plano). |
| `POST_NOTIFICATIONS` (API 33+) | Junto com a localização | Notificação obrigatória do serviço. |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` (API 34+) | Instalação | Serviço de localização em primeiro plano. |
| `RECORD_AUDIO` | Só ao tocar no ícone do microfone | Comandos de voz. **Nunca escuta em segundo plano.** |
| `WAKE_LOCK` | Instalação | Manter a CPU ligada durante a navegação (parcial, liberado ao encerrar). |
| **`ACCESS_BACKGROUND_LOCATION`** | **Não é declarada nem pedida** | O serviço em primeiro plano iniciado pelo usuário dispensa; evita o pedido “o tempo todo” e a revisão da Play. |
| `USE_FULL_SCREEN_INTENT` | **Não usada** | Seria abusiva para este caso. |

## Tela de bloqueio e segundo plano
- Com a navegação ativa e a tela apagada: o serviço mantém GPS e voz; as instruções continuam sendo faladas.
- Notificação **privada** na tela bloqueada: mostra só “Navegação ativa” (sem rua, número ou destinatário), via `publicVersion`.
  Em *Ajustes → Navegação* o usuário pode optar por exibir a instrução.
- *Abrir o mapa sobre a tela de bloqueio* (opcional, desligado por padrão): usa `setShowWhenLocked(true)` na Activity, acionado pela ação **Abrir mapa** da notificação. O Android ainda pode pedir o desbloqueio.
- Logs não contêm nomes, endereços nem coordenadas.

## O que esperar por versão do Android (documentação, não medição)
| API | Comportamento esperado |
|---|---|
| 26–28 | `startForegroundService`; sem tipo de serviço obrigatório. |
| 29–33 | `startForeground(..., FOREGROUND_SERVICE_TYPE_LOCATION)`. |
| 33+ | Permissão de notificações em tempo de execução; sem ela o serviço roda, mas a notificação fica oculta. |
| 34+ | Exige `FOREGROUND_SERVICE_LOCATION` e a permissão de localização concedida antes de iniciar; sem isso o serviço é recusado e o app mostra o erro. |
| Fabricantes (Xiaomi, Samsung, etc.) | A otimização de bateria pode matar o serviço. Orientação: desativar a otimização para o Rota Santos. **Não testado.** |

## Desvio e recálculo
O nativo emite `offRoute` uma vez por desvio (supressão de 20 s). O JS aplica uma segunda histerese: no máximo **1 recálculo a cada 45 s**; durante o cálculo a rota antiga continua desenhada e o HUD mostra “Recalculando a rota…”.

## Chegada ≠ entrega
O app **nunca marca entrega sozinho**. Ao chegar perto da parada ele fala “Você chegou ao número X. Confirme a entrega.” se a posição é uma portaria/pino confirmado; se é interpolada diz “Você está próximo do número X. Confira o endereço.”; se é só a rua, não afirma proximidade do número.

## Comandos de voz (opcionais, só após tocar no microfone)
Repetir · Próxima entrega · Quanto falta? · Pular · Pausar · Retomar · Marcar entregue (abre confirmação na tela — nunca executa direto).
