# Teste físico no Android — roteiro reproduzível

> **Status: NÃO EXECUTADO.** A V3 foi feita num contêiner sem celular nem emulador (sem KVM). Este roteiro e os scripts
> existem para você (ou outra pessoa) rodar num aparelho real. Nada aqui foi medido num celular.

Alvos: Moto G15 e um segundo Android modesto (ideal: 3 GB de RAM, Android 10–12).

## Preparação (uma vez)
1. Ative *Opções do desenvolvedor → Depuração USB* e conecte ao computador com `adb` (`adb devices` deve listar o aparelho).
2. Copie para o aparelho os dados **fictícios**: `adb push test-data/cenario_300_cartas_centro_paqueta_vila_nova.csv /sdcard/Download/` e
   `adb push test-data/posicoes_teste_osm.csv /sdcard/Download/`. Para escala: `test-data/v3/cenario_1000_cartas_500_paradas.csv` e `posicoes_teste_1000.csv`.
3. Confira o APK: `sha256sum -c releases/SHA256SUMS.txt`.

## Medição automatizada
`mobile/scripts/adb/bench_device.sh releases/rota-santos-1.2.0-DEBUG.apk [serial]`
- instala, limpa os dados, faz 5 partidas a frio (`am start -W`), lê memória (`dumpsys meminfo`), quadros (`dumpsys gfxinfo`),
  falhas (`logcat`: ANR, FATAL, OOM) e grava `device-results/<modelo>-<data>.json` + saídas brutas;
- o `parse_adb.py` só extrai o que está nas saídas (o que faltar vira `null`); o parser tem teste próprio
  (`scripts/adb/test_parse_adb.py`, com trechos de exemplo — não são medições).

## Checklist manual (marque só o que você viu acontecer)
| # | Passo | Resultado esperado | Passou? |
|---|---|---|---|
| 1 | Abrir o app com internet; **Ajustes → Localizar endereço → arrastar o pino até a Rua Joaquim Távora, 480 → Confirmar** | Ponto confirmado; sem isso o app recusa calcular | ☐ |
| 2 | Confirmar 10 portarias conhecidas (**Validar endereços → Confirmar portaria**) | Selo "Portaria confirmada"; reverter funciona | ☐ |
| 3 | Importar o CSV de 300 cartas | 300 cartas / 150 imóveis / 3 bairros | ☐ |
| 4 | Importar as posições TESTE; **Planejar → Calcular** | 150 paradas, rota completa; anotar o tempo de cálculo (cronômetro) | ☐ |
| 5 | Modo avião **antes** de abrir o app (primeira abertura sem internet) | Mapa com ruas e nomes (selo "Mapa offline (pacote de Santos)"), rota e paradas | ☐ |
| 6 | Entregar 15–30 paradas TESTE | Cada toque grava; Desfazer funciona | ☐ |
| 7 | Alternar para outro app e voltar; bloquear/desbloquear a tela; girar | Contexto preservado | ☐ |
| 8 | Fechar o app à força durante uma entrega e reabrir | Nenhum registro perdido (conferir contagem) | ☐ |
| 9 | Ativar/desativar GPS; negar permissão; "Minha localização" | Aviso claro em ≤ 15 s; o app continua | ☐ |
| 10 | Importar 1000 cartas / 500 paradas e rolar a lista | Sem travar; anotar quadros perdidos (`gfxinfo`) | ☐ |
| 11 | **Ajustes → Exportar diagnóstico de desempenho** | JSON sem nomes/endereços; guardar para comparação | ☐ |
| 12 | Backup cifrado → desinstalar → reinstalar → restaurar | Mesmos números de cartas/entregas | ☐ |
| 13 | Atualizar 1.0/1.1 → 1.2.0 por cima (mesma chave debug) | Dados mantidos | ☐ |

## Métricas a registrar (e como)
| Métrica | Como medir |
|---|---|
| Tempo de cálculo 150 e 500 paradas | cronômetro + `ultimosCalculos` do diagnóstico (`matriz_ms`, `solver_ms`) |
| Partida a frio | `bench_device.sh` (5 amostras, mediana) |
| RAM (PSS) | `dumpsys meminfo br.santos.rota` ocioso e após o plano |
| Quadros perdidos | `dumpsys gfxinfo` após rolar lista/mapa 30 s |
| ANR / crash | `logcat` (o script conta) |
| Bateria | `adb shell dumpsys batterystats --reset`, usar o app 1 h com tela ligada e GPS, ler `batterystats` (método e percentual; só vale como estimativa) |
| Erro do ETA | comparar o horário previsto de cada parada com o registrado nos eventos, em jornada real e **com consentimento**; não confundir com tempo "real" calculado pelo próprio planejador |
