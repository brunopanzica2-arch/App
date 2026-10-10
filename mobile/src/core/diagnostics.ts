/**
 * Diagnóstico para medir desempenho REAL no aparelho (V3 §10/§15) sem ADB. Não contém nomes, endereços nem coordenadas:
 * só contagens, tempos e versões. O usuário decide se compartilha.
 */
import { db } from "./db";

export interface Diagnostics {
  geradoEm: string;
  app: { versao: string };
  aparelho: { userAgent: string; nucleos: number | null; memoriaGB: number | null; tela: string; online: boolean };
  armazenamento: { usadoMB: number | null; quotaMB: number | null };
  memoriaJS: { usadoMB: number | null; limiteMB: number | null };
  dados: { lotes: number; cartas: number; enderecos: number; rotas: number; eventos: number };
  ultimosCalculos: { lote: string; versao: number; paradas: number; matriz_ms: number | null; solver_ms: number | null; total_ms: number | null; cacheMatriz: string | null }[];
  malha: { sha256: string | null; nos: number | null; arestas: number | null };
  mapaOffline: { sha256: string | null; compilacao: string | null; bytes: number | null };
  nota: string;
}

export async function collectDiagnostics(appVersion = "dev"): Promise<Diagnostics> {
  const nav: any = typeof navigator !== "undefined" ? navigator : {};
  const perfMem: any = typeof performance !== "undefined" ? (performance as any).memory : null;
  let est: StorageEstimate | null = null;
  try { est = (await nav.storage?.estimate?.()) ?? null; } catch { /* sem API */ }
  const routes = (await db.routes.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const j = async (u: string) => { try { const r = await fetch(new URL(u, document.baseURI)); return r.ok ? await r.json() : null; } catch { return null; } };
  const [graph, pack] = await Promise.all([j("santos-graph.json"), j("map/santos.pmtiles.json")]);
  const mb = (n: number | null | undefined) => (n == null ? null : Math.round((n / 1048576) * 10) / 10);
  return {
    geradoEm: new Date().toISOString(),
    app: { versao: appVersion },
    aparelho: {
      userAgent: nav.userAgent ?? "", nucleos: nav.hardwareConcurrency ?? null, memoriaGB: nav.deviceMemory ?? null,
      tela: typeof screen !== "undefined" ? `${screen.width}x${screen.height}@${(globalThis as any).devicePixelRatio ?? 1}` : "", online: nav.onLine ?? true,
    },
    armazenamento: { usadoMB: mb(est?.usage), quotaMB: mb(est?.quota) },
    memoriaJS: { usadoMB: mb(perfMem?.usedJSHeapSize), limiteMB: mb(perfMem?.jsHeapSizeLimit) },
    dados: { lotes: await db.batches.count(), cartas: await db.letters.count(), enderecos: await db.addresses.count(), rotas: await db.routes.count(), eventos: await db.events.count() },
    ultimosCalculos: routes.map((r) => ({
      lote: r.batchId.slice(0, 8), versao: r.version, paradas: r.stops.length,
      matriz_ms: r.metrics?.timings?.matrix_ms ?? null, solver_ms: r.metrics?.timings?.solve_ms ?? null, total_ms: r.metrics?.timings?.total_ms ?? null,
      cacheMatriz: r.metrics?.matrixStats ? `${r.metrics.matrixStats.cleanPoints}/${r.metrics.matrixStats.cleanPoints + r.metrics.matrixStats.dirtyPoints} pontos reaproveitados${r.metrics.matrixStats.warmStart ? ", partida a quente" : ""}` : null,
    })),
    malha: { sha256: graph?.sha256 ?? null, nos: graph?.nodes ?? null, arestas: graph?.edges ?? null },
    mapaOffline: { sha256: pack?.sha256 ?? null, compilacao: pack?.compilacao ?? null, bytes: pack?.bytes ?? null },
    nota: "Sem nomes, endereços ou coordenadas. Tempos medidos neste aparelho; memória JS só existe em WebViews baseadas em Chromium.",
  };
}
