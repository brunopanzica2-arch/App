"use client";

import { BarChart3, Home, Map as MapIcon, Moon, Settings, Sun, Upload, LogOut, CloudOff, RefreshCw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearSession, getUser, type User } from "@/lib/api";
import { flush, onSync, type SyncState } from "@/lib/offline";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Painel", icon: Home },
  { href: "/importar", label: "Importar", icon: Upload },
  { href: "/rota", label: "Rota", icon: MapIcon },
  { href: "/relatorios", label: "Relatórios", icon: BarChart3 },
  { href: "/configuracoes", label: "Ajustes", icon: Settings },
];

export function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("rota.theme");
    const d = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(d);
    document.documentElement.classList.toggle("dark", d);
  }, []);
  const toggle = () => {
    const d = !dark;
    setDark(d);
    localStorage.setItem("rota.theme", d ? "dark" : "light");
    document.documentElement.classList.toggle("dark", d);
  };
  return { dark, toggle };
}

export function SyncBadge() {
  const [s, setS] = useState<SyncState>({ pending: 0, syncing: false });
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const un = onSync(setS);
    void flush();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      un();
    };
  }, []);
  if (online && !s.pending && !s.lastError) return null;
  return (
    <button
      onClick={() => void flush()}
      className="flex items-center gap-1 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300"
      aria-label="Estado da sincronização"
    >
      {online ? <RefreshCw className={cn("h-3.5 w-3.5", s.syncing && "animate-spin")} /> : <CloudOff className="h-3.5 w-3.5" />}
      {online ? "" : "Offline · "}
      {s.pending} pendente(s) de envio
      {s.lastError && online ? " · erro" : ""}
    </button>
  );
}

export function AppShell({ children, title, wide = false }: { children: React.ReactNode; title?: string; wide?: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const { dark, toggle } = useTheme();

  useEffect(() => {
    const u = getUser();
    if (!u) router.replace("/login");
    setUser(u);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, [router]);

  if (!user) return null;
  return (
    <div className="min-h-dvh pb-20 md:pb-0 md:pl-56">
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-app bg-[var(--card)] p-3 md:flex">
        <div className="mb-6 px-2 text-lg font-extrabold text-brand">Rota Santos</div>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={cn("mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 font-medium", (n.href === "/" ? path === "/" : path.startsWith(n.href)) ? "bg-brand text-white" : "hover:bg-black/5 dark:hover:bg-white/5")}>
            <n.icon className="h-5 w-5" /> {n.label}
          </Link>
        ))}
        <div className="mt-auto text-xs muted px-2">{user.name} · {user.role}</div>
      </aside>
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-app bg-[var(--bg)]/90 px-4 py-2 backdrop-blur">
        <h1 className="flex-1 truncate text-lg font-bold">{title}</h1>
        <SyncBadge />
        <button onClick={toggle} className="rounded-xl p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label={dark ? "Modo claro" : "Modo escuro"}>
          {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
        <button onClick={() => { clearSession(); router.replace("/login"); }} className="rounded-xl p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Sair">
          <LogOut className="h-5 w-5" />
        </button>
      </header>
      <main className={cn("mx-auto p-4", wide ? "max-w-none" : "max-w-5xl")}>{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-app bg-[var(--card)] md:hidden" aria-label="Navegação principal">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={cn("flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold", (n.href === "/" ? path === "/" : path.startsWith(n.href)) ? "text-brand" : "muted")}>
            <n.icon className="h-6 w-6" /> {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function useCurrentBatch(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => setId(localStorage.getItem("rota.batch")), []);
  return [id, (v: string) => { localStorage.setItem("rota.batch", v); setId(v); }];
}
