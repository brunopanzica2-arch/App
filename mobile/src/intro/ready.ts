/** Sinal de "dados prontos": a primeira tela chama assim que terminou de ler cache/IndexedDB. A abertura espera por ele (com limite). */
let isReady = false;
export const dataReady = () => isReady;
export function signalDataReady() {
  if (isReady) return;
  isReady = true;
  window.dispatchEvent(new Event("rota:data-ready"));
}
/** só para testes */
export function __resetReady() { isReady = false; }
