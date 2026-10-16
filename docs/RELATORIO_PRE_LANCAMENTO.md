# Relatório de pré-lançamento — Rota Santos 2.7.0 (16/out/2026)

## Resumo honesto
**Pronto para uso piloto com acompanhamento.** Tudo o que pude testar aqui passa. **Não pude testar em Android real** (o emulador deste ambiente não roda) — por isso os itens de voz/GPS/tela bloqueada dependem do teste no aparelho (lista no fim).

## 1. Números das casas
**Fontes consultadas (todas as que pude):**
| Fonte | Resultado nos 18 endereços do usuário | Observação |
|---|---|---|
| **IBGE CNEFE 2022** (dentro do app, offline) | **17/18** com número no ponto do endereço; 1 candidato (Praça Narciso de Andrade) | fonte principal |
| Nominatim (OpenStreetMap) | **0/18** números (rua em 16) | 2 ruas nem achadas |
| Photon (OpenStreetMap) | **0/6** números | mesma base do OSM |
| BrasilAPI CEP | só coordenada por CEP (impreciso) | não usada para número |
| **Google Maps** | **NÃO consultado** | ver abaixo |

**Por que não o Google Maps:** (a) não há chave de API nem acesso nesta sessão; raspar o site viola os termos; (b) os Termos da Plataforma Google proíbem usar os resultados do Geocoding em mapa que não seja do Google e guardá-los (cache) — este app usa mapa OpenStreetMap/PMTiles e funciona offline, então integrar o Google seria **irregular**, mesmo com chave. A alternativa legal e offline adotada foi o IBGE.

**Validação independente (246 endereços mapeados à mão no OpenStreetMap, 10 áreas de Santos):**
| Métrica | Antes das correções de hoje | Agora |
|---|---|---|
| Endereços que recebem ponto (exato/face/estimado) | 78 % | **92 %** (228/246) |
| Mediana da distância ao ponto do OSM | 28 m | **28 m** |
| p90 da distância | 92 m | **92 m** |
| Dentro de 100 m | 91 % | **92 %** |
| "Exato" com erro > 300 m | 3 | 3 (Av. São Francisco 128 e Av. Senador Feijó 283: IBGE × OSM discordam em ~300 m) |
| Sem ponto (só a rua / pede confirmação / rua não achada) | 22 % | 8 % |
Por tipo: exato 189 (mediana 27 m), face da quadra 12 (29 m), estimado entre vizinhos 27 (54 m).

**Correções de hoje no casamento de nomes** (a maioria das falhas era grafia, não falta de dado): Luiz/Luis, Anna/Ana, Glycerio/Glicerio, Arthur/Artur, Adolpho/Adolfo, Victorino/Vitorino; "Doutor" a mais/a menos ("Rua Oswaldo Cruz" × "Rua Doutor Oswaldo Cruz"), só com o mesmo tipo de via; algarismos romanos preservados (Dom Pedro **I** ≠ **II** — bug que a própria validação revelou e foi corrigido).

**Limites (não esconder):** o ponto do IBGE é do **endereço** (estatístico), não a porta confirmada; dados de 2022; ~8 % ainda ficam "só a rua" ou pedem confirmação do nome; "Marcar a porta aqui (GPS)" fixa a porta no campo.

## 2. Navegação por voz
**Verificado (código + testes):** 14 testes JUnit do motor nativo e da fala pt-BR passam (números por extenso até 999.999, distâncias, abreviações de ruas, romanos, "na/no", chegada só com "Você chegou" quando a posição é confirmada, senão "Você está próximo… Confira o endereço"); TTS pt-BR com foco de áudio que **abaixa** a música (não pausa), voz escolhível/offline; `<queries>` do Android 11+ presente para TTS e reconhecimento; serviço em primeiro plano só durante a navegação; sem localização em segundo plano.
**Defeito achado e corrigido hoje:** o comando de voz **"repita"** (e "próximo", "de novo") **não era reconhecido**. Agora 25 casos de teste (repetir, próxima, quanto falta, pular, pausar, retomar, entregue) passam e frases fora do vocabulário não disparam nada; "entregue" só abre a confirmação (nunca marca sozinho).
**NÃO verificado (precisa do aparelho):** voz real saindo no alto-falante/fone Bluetooth, voz pt-BR instalada, tela apagada, interrupção por ligação, reconhecimento de fala no ruído da rua, GPS real.

## 3. Estado geral
- Vitest: **362** passam (3 pulados); JUnit: passam; E2E Chromium 2.0, 2.1 (visual 0,00 %), 2.3, abertura, lista de 18: passam.
- Rota da lista do usuário (20 endereços colados numa linha): 19 paradas, 8,2 km, 18 localizados offline.
- `npm audit` (produção): 0 vulnerabilidades. Sem permissão de localização em segundo plano.
- APK debug (não é release assinado: falta a sua chave).

## 4. Roteiro de teste no celular (10 min, antes de sair)
1. Instalar, abrir, deixar a abertura tocar. 2. Colar a lista (uma linha só) → conferir "Números identificados". 3. Em Ajustes → voz: ligar voz, tocar "testar voz" (ouvir pt-BR). 4. Calcular rota; iniciar; andar 100 m: ouvir "Em X metros, vire…". 5. Falar "repita" e "próxima entrega" no microfone. 6. Bloquear a tela e continuar andando: a voz deve seguir. 7. Receber uma ligação/tocar música: a voz deve sobrepor. 8. Perto de uma parada: "Você está próximo do número…" → "Marcar a porta aqui (GPS)". 9. Modo avião: abrir e marcar entregas. 10. Anotar qualquer endereço cujo número esteja errado e me mandar.
