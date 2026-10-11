/**
 * Abertura "Panzica Productions". A animação roda em CSS (transform/opacity) e o app só começa a carregar depois da entrada
 * (main.tsx adia o boot), para que o parse do JS não trave a animação. Fica até o app abrir, com tempo mínimo e saída animada.
 */
const MIN_MS = 4300;     // entrada completa + um respiro com a roda girando
const EXIT_MS = 1150;    // saída animada (letras, roda, logo e fade do fundo)
const SAFETY_MS = 9000;  // se o app já montou mas o evento "pronto" não veio, sai mesmo assim
let done = false;

export function hideSplash() {
  if (done) return;
  done = true;
  clearTimeout((window as any).__splashT);
  const el = document.getElementById("splash");
  if (!el) return;
  const wait = Math.max(0, MIN_MS - performance.now());
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), EXIT_MS);
  }, wait);
}

function showFailure(msg: string) {
  const el = document.getElementById("splash");
  const m = document.getElementById("splash-msg");
  if (!el || !m || done) return;
  m.textContent = msg;
  if (!el.querySelector("button")) {
    const b = document.createElement("button");
    b.textContent = "Tentar de novo";
    b.onclick = () => location.reload();
    m.after(b);
  }
}

window.addEventListener("rota:ready", hideSplash, { once: true });
window.addEventListener("error", (e) => showFailure(`Falha ao iniciar: ${String(e.message).slice(0, 80)}`));
// rede de segurança: app montado (há conteúdo no #root) mas o evento não chegou
setTimeout(() => { if (!done && (document.getElementById("root")?.childElementCount ?? 0) > 0) hideSplash(); }, SAFETY_MS);
