# Rota Santos: app Android offline (sem servidor)

Este é o app que você instala no celular. **Não precisa de servidor nem de mensalidade.** O cálculo da rota é feito no próprio aparelho:

- **Malha de pedestres de Santos** embutida no APK (`public/santos-graph.bin`, 41.598 nós e 48.747 trechos do OpenStreetMap). Segue as mesmas regras do motor do servidor:
  - não aplica sentidos únicos de automóveis;
  - não prioriza ciclovias;
  - separa trecho pedalável de trecho em que se conduz a bicicleta a pé;
  - escadas, acessos privados e barreiras podem ser permitidos, penalizados ou evitados;
  - não cria ligações inexistentes;
  - detecta pontos fora da malha.
- **Otimização no aparelho**: vizinho mais próximo e inserção mais barata, 2-opt e Or-opt corretos para matriz assimétrica, e busca local iterada multi-semente, com limite de tempo e cancelamento.
  - Toda rota passa por verificação formal: um trecho impossível nunca é aceito. Paradas sem caminho saem com motivo e a rota aparece como **PARCIAL**.
  - Nas 150 posições TESTE de Centro, Paquetá e Vila Nova, ficou entre 99,5% e 99,7% do tempo do OR-Tools (`tests/parity.test.ts`). Isso não garante ótimo global.
- **Dados só no celular** (IndexedDB): cartas, endereços confirmados, versões de rota, eventos de entrega. Há backup e restauração em JSON, além de exportação em CSV/XLSX.
- **Internet é usada apenas** para:
  - localizar endereços (Nominatim/OSM, 1 consulta por segundo, com cache local);
  - carregar o fundo do mapa (OpenFreeMap). Sem internet, o mapa troca para um fundo liso com rota e paradas numeradas; **não há ruas de fundo offline**.

  Rotas, entregas e recálculos funcionam sem sinal. A integridade da malha embutida é conferida por SHA-256 ao abrir. Os endereços já confirmados no mapa ficam salvos e não são consultados de novo.

## Instalar no celular (Android 7 ou superior)

1. Baixe `rota-santos-1.1.0-DEBUG.apk` em `releases/` e confira o SHA-256 em `releases/SHA256SUMS.txt`. Ele atualiza a 1.0 sem apagar os dados.
2. Abra o arquivo. O Android pede para permitir "instalar apps desconhecidos" para o navegador ou gerenciador de arquivos; autorize.
3. Toque em **Instalar**.
4. Na primeira abertura:
   - vá em **Ajustes**, toque em **Localizar endereço** e arraste o pino até a entrada da Rua Joaquim Távora, 480;
   - toque em **Confirmar**.

   O Nominatim só encontra a rua, não o número 480, por isso o pino precisa ser ajustado à mão.

Este APK é de **depuração** (assinado com a chave debug pública), próprio para uso pessoal. O build **release** (`releases/rota-santos-1.1.0-RELEASE-UNSIGNED.apk`) sai sem assinatura até você criar a sua chave: veja [`SIGNING.md`](SIGNING.md). A chave nunca vai para o repositório.

Uso no dia a dia: [`docs/TUTORIAL_USO_DIARIO.md`](../docs/TUTORIAL_USO_DIARIO.md). Auditoria V2: [`docs/AUDITORIA_V2.md`](../docs/AUDITORIA_V2.md).

## Desenvolvimento

```bash
npm install                    # copia o worker do MapLibre para public/
npm test                       # malha real + comparação com OR-Tools
npm run dev                    # versão web no navegador
npm run android:apk            # requer Android SDK (compileSdk 36) e JDK 21
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Para atualizar a malha (por exemplo, depois de mudanças no OSM), rode `cd ../backend && python -m app.cli build-network --refresh && python -m scripts.export_mobile_graph ../mobile/public/santos-graph.bin`.

O workflow `.github/workflows/android-apk.yml` roda os testes e gera o APK debug e o release no GitHub Actions (aba Actions, em Artifacts). O release é assinado se os GitHub Secrets existirem (`SIGNING.md`). O workflow publica o SHA-256 e falha se o release vier assinado com a chave debug.

Benchmark do app nos mesmos pontos do backend: `BENCH=1 npx vitest run bench/` (roda em Node; **não** é medição de celular).

## Limitações (em relação à versão com servidor)

- Um único usuário e um único aparelho: não há login nem sincronização entre aparelhos. Use o backup para mover os dados.
- Não há fila de despachante nem papéis.
- O otimizador é heurístico. Foi validado contra o OR-Tools nos casos de teste, mas pode ser inferior em casos muito grandes ou com prioridades.
- A malha embutida cobre a porção insular de Santos (bbox `-24.005,-46.415,-23.915,-46.295`).
