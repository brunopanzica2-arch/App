import { createRoot } from "react-dom/client";
import { Abertura } from "./intro/Abertura";

// A abertura monta primeiro (entrada pequena) e o app carrega EM PARALELO por trás: cache/IndexedDB + sincronização.
// Quando a abertura termina, os dados normalmente já estão prontos; se não, o skeleton aparece (nunca uma tela de espera extra).
const hideShell = () => {
  clearTimeout((window as any).__bootT);
  document.getElementById("boot-shell")?.remove();
};
createRoot(document.getElementById("abertura-root")!).render(<Abertura onDone={() => undefined} />);
requestAnimationFrame(() => requestAnimationFrame(hideShell));
void import("./boot");
