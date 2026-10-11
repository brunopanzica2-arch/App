import { History, ListChecks, Map as MapIcon, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { AddressesPage } from "./pages/Addresses";
import { DeliveriesPage } from "./pages/Deliveries";
import { MapHome } from "./pages/MapHome";
import { ImportPage } from "./pages/Import";
import { PlanPage } from "./pages/Plan";
import { ReportsPage } from "./pages/Reports";
import { RoutePage } from "./pages/RoutePage";
import { SettingsPage } from "./pages/SettingsPage";
import { cn } from "./ui/utils";

export type Nav = (path: string) => void;

const TABS = [
  { path: "/", label: "Mapa", icon: MapIcon },
  { path: "/entregas", label: "Entregas", icon: ListChecks },
  { path: "/relatorios", label: "Histórico", icon: History },
  { path: "/ajustes", label: "Ajustes", icon: Settings },
];

function usePath(): [string, Nav] {
  const get = () => location.hash.replace(/^#/, "") || "/";
  const [p, setP] = useState(get);
  useEffect(() => {
    const h = () => setP(get());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return [p, (to) => { location.hash = to; }];
}

export default function App() {
  // avisa a splash que o app abriu (primeira renderização concluída)
  useEffect(() => { requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event("rota:ready")))); }, []);
  const [path, nav] = usePath();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const d = !dark;
    setDark(d);
    localStorage.setItem("rota.theme", d ? "dark" : "light");
    document.documentElement.classList.toggle("dark", d);
  };
  const [pathOnly, query = ""] = path.split("?");
  const [, seg, arg] = pathOnly.split("/");
  const focusKey = new URLSearchParams(query).get("stop") ?? undefined;
  const isMap = !seg;
  let page: React.ReactNode;
  let title = "Rota Santos";
  switch (seg) {
    case "importar": page = <ImportPage nav={nav} />; title = "Importar cartas"; break;
    case "enderecos": page = <AddressesPage batchId={arg} />; title = "Validar endereços"; break;
    case "planejar": page = <PlanPage batchId={arg} nav={nav} />; title = "Planejar rota"; break;
    case "rota": page = <RoutePage routeId={arg} nav={nav} />; title = "Jornada"; break;
    case "entregas": page = <DeliveriesPage nav={nav} />; title = "Entregas"; break;
    case "relatorios": page = <ReportsPage />; title = "Histórico"; break;
    case "ajustes": page = <SettingsPage />; title = "Ajustes"; break;
    default: page = <MapHome nav={nav} focusKey={focusKey} />; title = "Mapa";
  }
  return (
    <div className={isMap ? "h-dvh overflow-hidden" : "min-h-dvh pb-20"}>
      <header hidden={isMap} className="sticky top-0 z-20 flex items-center gap-2 border-b border-app bg-[var(--bg)]/90 px-4 py-2 backdrop-blur">
        <h1 className="flex-1 truncate text-lg font-bold">{title}</h1>
        <button onClick={toggle} className="rounded-xl p-2" aria-label={dark ? "Modo claro" : "Modo escuro"}>
          {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
      </header>
      {isMap ? page : <main className="mx-auto max-w-5xl p-3">{page}</main>}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-app bg-[var(--card)] pb-[env(safe-area-inset-bottom)]" aria-label="Navegação principal">
        {TABS.map((t) => {
          const active = t.path === "/" ? isMap || seg === "rota" : seg === t.path.slice(1) || (t.path === "/entregas" && ["importar", "enderecos", "planejar"].includes(seg));
          return (
            <a key={t.path} href={`#${t.path}`} className={cn("flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold", active ? "text-brand" : "muted")}>
              <t.icon className="h-6 w-6" /> {t.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
