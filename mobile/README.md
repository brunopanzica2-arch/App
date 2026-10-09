# Rota Santos: app Android offline (sem servidor)

Este é o app que você instala no celular. **Não precisa de servidor nem de mensalidade.** O cálculo da rota é feito no próprio aparelho:

- **Malha de pedestres de Santos** embutida no APK (`public/santos-graph.bin`, 41.598 nós e 48.747 trechos do OpenStreetMap). Segue as mesmas regras do motor do servidor:
  - não aplica sentidos únicos de automóveis;
  - não prioriza ciclovias;
  - separa trecho pedalável de trecho em que se conduz a bicicleta a pé;
  - escadas, acessos privados e barreiras podem ser permitidos, penalizados ou evitados;
  - não cria ligações inexistentes;
  - detecta pontos fora da malha.
- **Otimização no aparelho**: inserção mais barata + 2-opt + Or-opt + busca local iterada, com limite de tempo. Nas matrizes reais de Santos (40, 120 e 60 paradas) chegou ao **mesmo resultado do OR-Tools do servidor** (razão 1,000). Veja `tests/core.test.ts`. Isso não garante ótimo global.
- **Dados só no celular** (IndexedDB): cartas, endereços confirmados, versões de rota, eventos de entrega. Há backup e restauração em JSON, além de exportação em CSV/XLSX.
- **Internet é usada apenas** para:
  - localizar endereços (Nominatim/OSM, 1 consulta por segundo, com cache local);
  - carregar o fundo do mapa (OpenFreeMap).

  Rotas, entregas e recálculos funcionam sem sinal. Os endereços já confirmados no mapa ficam salvos e não são consultados de novo.

## Instalar no celular (Android 7 ou superior)

1. Baixe o arquivo `rota-santos-1.0.apk`, que está em `releases/` no repositório ou foi enviado na conversa.
2. Abra o arquivo. O Android pede para permitir "instalar apps desconhecidos" para o navegador ou gerenciador de arquivos; autorize.
3. Toque em **Instalar**.
4. Na primeira abertura:
   - vá em **Ajustes**, toque em **Localizar endereço** e arraste o pino até a entrada da Rua Joaquim Távora, 480;
   - toque em **Confirmar**.

   O Nominatim só encontra a rua, não o número 480, por isso o pino precisa ser ajustado à mão.

Este APK é de **depuração** (assinado com chave de debug), próprio para uso pessoal. Para publicar na Play Store é preciso gerar um build *release* com chave própria.

## Desenvolvimento

```bash
npm install                    # copia o worker do MapLibre para public/
npm test                       # malha real + comparação com OR-Tools
npm run dev                    # versão web no navegador
npm run android:apk            # requer Android SDK (compileSdk 36) e JDK 21
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Para atualizar a malha (por exemplo, depois de mudanças no OSM), rode `cd ../backend && python -m app.cli build-network --refresh && python -m scripts.export_mobile_graph ../mobile/public/santos-graph.bin`.

O workflow `.github/workflows/android-apk.yml` gera o APK automaticamente no GitHub Actions a cada mudança em `mobile/`, na aba Actions, em Artifacts.

## Limitações (em relação à versão com servidor)

- Um único usuário e um único aparelho: não há login nem sincronização entre aparelhos. Use o backup para mover os dados.
- Não há fila de despachante nem papéis.
- O otimizador é heurístico. Foi validado contra o OR-Tools nos casos de teste, mas pode ser inferior em casos muito grandes ou com prioridades.
- A malha embutida cobre a porção insular de Santos (bbox `-24.005,-46.415,-23.915,-46.295`).
