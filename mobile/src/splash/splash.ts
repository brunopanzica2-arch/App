/** Abertura "Panzica Productions": fica até o app realmente abrir (React montado + primeira tela pronta), com tempo mínimo e uma saída de segurança. */
const MIN_MS = 1600;      // tempo mínimo de exibição (a marca precisa ser vista)
const t0 = performance.now();
let done = false;

export function hideSplash() {
  if (done) return;
  done = true;
  clearTimeout((window as any).__splashT);
  const el = document.getElementById("splash");
  if (!el) return;
  const wait = Math.max(0, MIN_MS - (performance.now() - t0));
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 450);
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
