/** Regras de negócio do app (dados locais). */
import { Capacitor } from "@capacitor/core";
import { type Address, db, type DeliveryEvent, type Letter, type LetterStatus, type Route, type Settings, uid } from "./db";
import { resolve } from "./geocode";
import { normalizeAddress } from "./normalize";
import type { PlanRequest, PlanResult } from "./plan";
import { DEFAULT_PROFILE } from "./router";

export const ROUTABLE = ["exact", "interpolated", "manual", "street"];
export const TERMINAL: LetterStatus[] = ["delivered", "not_delivered", "returned", "address_not_found"];

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get("main");
  return {
    key: "main", start: null, startAddress: "Rua Joaquim Távora, 480, Santos/SP", profile: { ...DEFAULT_PROFILE },
    serviceTime: 45, perLetterService: 10, routeMode: "open", nominatimEmail: "", currentBatch: null,
    ...(s || {}),
  };
}

export async function saveSettings(patch: Partial<Settings>) {
  await db.settings.put({ ...(await getSettings()), ...patch, key: "main" });
}

// ------------------------------------------------------------ geocodificação

export async function geocodeBatch(batchId: string, onProgress?: (done: number, total: number) => void) {
  const s = await getSettings();
  const letters = await db.letters.where("batchId").equals(batchId).toArray();
  const groups = new Map<string, Letter[]>();
  for (const l of letters) if (l.addressKey && !l.excluded) groups.set(l.addressKey, [...(groups.get(l.addressKey) || []), l]);
  let i = 0;
  const errors: string[] = [];
  for (const [, ls] of groups) {
    const l = ls[0];
    const na = normalizeAddress(l.street, l.number, l.neighborhood, l.city, l.cep);
    try {
      await resolve(na, s.nominatimEmail);
    } catch (e) {
      errors.push(`${na.display}: ${(e as Error).message}`);
    }
    onProgress?.(++i, groups.size);
  }
  return { addresses: groups.size, errors };
}

// ------------------------------------------------------------ paradas (1 por imóvel)

export interface StopView {
  key: string;
  address: Address;
  letters: Letter[];
  status: "pending" | "partial" | "completed" | "postponed" | "problem";
  uncertain: boolean;
}

export function stopStatus(ls: Letter[]): StopView["status"] {
  const st = ls.map((l) => l.status);
  if (st.length && st.every((s) => TERMINAL.includes(s))) return st.some((s) => s !== "delivered") ? "problem" : "completed";
  if (st.length && st.every((s) => TERMINAL.includes(s) || s === "postponed")) return "postponed";
  if (st.some((s) => TERMINAL.includes(s) || s === "postponed")) return "partial";
  return "pending";
}

export async function stopsOf(batchId: string) {
  const letters = await db.letters.where("batchId").equals(batchId).toArray();
  const keys = [...new Set(letters.map((l) => l.addressKey).filter(Boolean) as string[])];
  const addrs = new Map((await db.addresses.bulkGet(keys)).filter(Boolean).map((a) => [a!.key, a!]));
  const stops: StopView[] = [];
  const unlocated: Letter[] = [];
  const byKey = new Map<string, Letter[]>();
  for (const l of letters) {
    if (l.excluded) continue;
    const a = l.addressKey ? addrs.get(l.addressKey) : undefined;
    if (!a || a.lat == null || !ROUTABLE.includes(a.precision)) { unlocated.push(l); continue; }
    byKey.set(a.key, [...(byKey.get(a.key) || []), l]);
  }
  for (const [k, ls] of byKey) {
    const a = addrs.get(k)!;
    stops.push({ key: k, address: a, letters: ls.sort((x, y) => x.row - y.row), status: stopStatus(ls), uncertain: !["exact", "manual", "interpolated"].includes(a.precision) });
  }
  return { stops, unlocated, letters, addresses: [...addrs.values()] };
}

// ------------------------------------------------------------ planejamento

let worker: Worker | null = null;
let reqId = 0;
export function runPlan(req: PlanRequest, onProgress?: (stage: string, p: number) => void): Promise<PlanResult> {
  worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const id = ++reqId;
  const graphUrl = new URL("santos-graph.bin", document.baseURI).href;
  return new Promise((ok, fail) => {
    const h = (ev: MessageEvent) => {
      if (ev.data.id !== id) return;
      if (ev.data.progress) return onProgress?.(ev.data.progress.stage, ev.data.progress.p);
      worker!.removeEventListener("message", h);
      if (ev.data.error) fail(new Error(ev.data.error));
      else ok(ev.data.result);
    };
    worker!.addEventListener("message", h);
    worker!.postMessage({ id, graphUrl, req });
  });
}

export interface PlanOptions {
  mode: "open" | "circular" | "fixed_end";
  strategy: "global" | "sectors";
  start: { label: string; lat: number; lon: number };
  end?: { label: string; lat: number; lon: number } | null;
  timeLimitMs: number;
  fixedFirst?: string[];
  includePostponed?: boolean;
  reason?: string;
}

export async function planBatch(batchId: string, o: PlanOptions, onProgress?: (stage: string, p: number) => void): Promise<Route> {
  const s = await getSettings();
  const { stops } = await stopsOf(batchId);
  const remaining = stops.filter((st) => st.letters.some((l) => l.status === "pending" || l.status === "in_route" || (o.includePostponed && l.status === "postponed")));
  if (!remaining.length) throw new Error("Não há paradas pendentes neste lote.");
  const res = await runPlan({
    start: o.start, end: o.end ?? null, mode: o.mode, strategy: o.strategy, profile: s.profile,
    timeLimitMs: o.timeLimitMs, maxSnap: 150, fixedFirst: o.fixedFirst,
    stops: remaining.map((st) => {
      const pending = st.letters.filter((l) => !TERMINAL.includes(l.status)).length;
      return { key: st.key, lat: st.address.lat!, lon: st.address.lon!, service: s.serviceTime + s.perLetterService * Math.max(pending - 1, 0), sector: (st.address.neighborhood || "?").toUpperCase() };
    }),
  }, onProgress);
  const prev = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version)[0];
  const route: Route = {
    id: uid(), batchId, version: (prev?.version ?? 0) + 1, status: "planned", createdAt: new Date().toISOString(),
    parentId: prev?.id ?? null, reason: o.reason ?? "plan",
    params: { mode: o.mode, strategy: o.strategy, profile: s.profile, serviceTime: s.serviceTime, perLetterService: s.perLetterService, timeLimitMs: o.timeLimitMs },
    start: o.start, end: o.end ?? null, totalTime: res.totalTime, travelTime: res.travelTime, serviceTime: res.serviceTime,
    totalDistance: res.totalDistance,
    metrics: {
      timings: res.timings, stops: res.order.length, letters: remaining.reduce((a, st) => a + st.letters.length, 0),
      byMode: res.byMode, flags: res.flags, strategy: res.strategy, excluded: res.excluded,
      note: "Tempos e distâncias são ESTIMATIVAS pela malha OSM de pedestres; não verificados em campo.",
    },
    candidates: res.candidates, geojson: { type: "FeatureCollection", features: res.features },
    stops: res.order.map((x) => ({ key: x.key, seq: x.seq, eta: x.eta, legDistance: x.legDistance, legTime: x.legTime, snapDistance: x.snapDistance })),
    warnings: res.warnings,
  };
  await db.routes.add(route);
  return route;
}

export async function activateRoute(route: Route) {
  await db.transaction("rw", db.routes, db.letters, async () => {
    const others = await db.routes.where("batchId").equals(route.batchId).toArray();
    for (const r of others) if (r.id !== route.id && (r.status === "active" || r.status === "planned")) await db.routes.update(r.id, { status: "superseded" });
    await db.routes.update(route.id, { status: "active" });
    const keys = new Set(route.stops.map((s) => s.key));
    const ls = await db.letters.where("batchId").equals(route.batchId).toArray();
    for (const l of ls) if (l.status === "pending" && l.addressKey && keys.has(l.addressKey)) await db.letters.update(l.id, { status: "in_route" });
  });
}

// ------------------------------------------------------------ eventos

export async function recordEvent(letterId: string, status: LetterStatus, routeId: string | null, reason: string | null = null, notes: string | null = null) {
  const l = await db.letters.get(letterId);
  if (!l) throw new Error("Carta não encontrada.");
  const ev: DeliveryEvent = {
    id: uid(), letterId, batchId: l.batchId, routeId, status, previousStatus: l.status,
    reason: ["not_delivered", "returned", "address_not_found"].includes(status) ? reason || "outro" : null,
    notes, at: new Date().toISOString(),
  };
  await db.transaction("rw", db.events, db.letters, async () => {
    await db.events.add(ev);
    await db.letters.update(letterId, { status });
  });
  return ev;
}

export async function lastServedPoint(route: Route) {
  const evs = (await db.events.where("batchId").equals(route.batchId).toArray()).filter((e) => e.routeId === route.id).sort((a, b) => b.at.localeCompare(a.at));
  if (!evs.length) return null;
  const l = await db.letters.get(evs[0].letterId);
  const a = l?.addressKey ? await db.addresses.get(l.addressKey) : null;
  return a && a.lat != null ? { label: `Última parada atendida: ${a.display}`, lat: a.lat, lon: a.lon! } : null;
}

// ------------------------------------------------------------ relatórios e backup

export async function report(batchId: string) {
  const letters = await db.letters.where("batchId").equals(batchId).toArray();
  const events = await db.events.where("batchId").equals(batchId).toArray();
  const routes = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version);
  const route = routes.find((r) => r.status === "active" || r.status === "finished") || routes[0];
  const counts: Record<string, number> = {};
  for (const l of letters) counts[l.status] = (counts[l.status] || 0) + 1;
  const reasons: Record<string, number> = {};
  for (const e of events) if (e.reason) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  const nb: Record<string, { total: number; delivered: number }> = {};
  for (const l of letters) {
    const k = l.neighborhood || "(sem bairro)";
    nb[k] ??= { total: 0, delivered: 0 };
    nb[k].total++;
    if (l.status === "delivered") nb[k].delivered++;
  }
  const times = events.map((e) => e.at).sort();
  const elapsed = times.length > 1 ? (Date.parse(times.at(-1)!) - Date.parse(times[0])) / 1000 : null;
  const { stops } = await stopsOf(batchId);
  return { letters: letters.length, stops: stops.length, counts, reasons, neighborhoods: nb, route, routes, events: events.length, elapsed, firstEvent: times[0], lastEvent: times.at(-1) };
}

export async function exportRows(batchId: string) {
  const letters = (await db.letters.where("batchId").equals(batchId).toArray()).sort((a, b) => a.row - b.row);
  const routes = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version);
  const seq = new Map((routes[0]?.stops || []).map((s) => [s.key, s.seq]));
  const addrs = new Map((await db.addresses.toArray()).map((a) => [a.key, a]));
  const headers = ["identificador", "destinatario", "linha", "logradouro", "numero", "complemento", "bairro", "cep", "status", "precisao", "endereco_normalizado", "parada"];
  const rows = letters.map((l) => {
    const a = l.addressKey ? addrs.get(l.addressKey) : undefined;
    return [l.externalId ?? "", l.recipient ?? "", l.row, l.street ?? "", l.number ?? "", l.complement ?? "", l.neighborhood ?? "", l.cep ?? "", l.status, a?.precision ?? "pendente", a?.display ?? "", l.addressKey ? seq.get(l.addressKey) ?? "" : ""];
  });
  return { headers, rows };
}

export async function backupJson() {
  const data = {
    app: "rota-santos", version: 1, exportedAt: new Date().toISOString(),
    batches: await db.batches.toArray(), letters: await db.letters.toArray(), addresses: await db.addresses.toArray(),
    routes: await db.routes.toArray(), events: await db.events.toArray(), settings: await db.settings.toArray(),
  };
  return JSON.stringify(data);
}

export async function restoreJson(text: string) {
  const d = JSON.parse(text);
  if (d.app !== "rota-santos") throw new Error("Arquivo de backup inválido.");
  await db.transaction("rw", [db.batches, db.letters, db.addresses, db.routes, db.events, db.settings], async () => {
    await db.batches.bulkPut(d.batches);
    await db.letters.bulkPut(d.letters);
    await db.addresses.bulkPut(d.addresses);
    await db.routes.bulkPut(d.routes);
    await db.events.bulkPut(d.events);
    await db.settings.bulkPut(d.settings);
  });
}

/** Salva/compartilha um arquivo (no Android abre a folha de compartilhamento). */
export async function shareFile(name: string, data: string | Blob, mime: string) {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const b64 = await new Promise<string>((ok) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result).split(",")[1]);
      fr.readAsDataURL(blob);
    });
    const w = await Filesystem.writeFile({ path: name, data: b64, directory: Directory.Cache });
    await Share.share({ title: name, url: w.uri });
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}
