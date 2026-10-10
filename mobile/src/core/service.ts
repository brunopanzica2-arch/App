/** Regras de negócio do app (dados locais). */
import { Capacitor } from "@capacitor/core";
import { type Address, db, type DeliveryEvent, type Letter, type LetterStatus, type Route, type Settings, uid } from "./db";
import { routePoint, trustOf, type Trust } from "./address";
import { QuotaError, resolve, setDailyQuota } from "./geocode";
import { parseText } from "./importer";
import { normalizeAddress } from "./normalize";
import type { PlanRequest, PlanResult } from "./plan";
import { DEFAULT_PROFILE } from "./router";

export const ROUTABLE = ["exact", "interpolated", "manual", "test", "street"];
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
  setDailyQuota(s.geocodeDailyQuota ?? 250);
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
      if (e instanceof QuotaError) { errors.push(e.message); break; }
      errors.push(`${na.display}: ${(e as Error).message}`);
    }
    onProgress?.(++i, groups.size);
  }
  return { addresses: groups.size, errors };
}

/**
 * Importa coordenadas por endereço (CSV com logradouro;numero;lat;lon[;aviso]).
 * Linhas cujo aviso contém "TESTE" viram posições de TESTE (rotuladas, não são portas);
 * as demais entram como posição confirmada pelo usuário.
 */
export async function importPositions(text: string) {
  const t = parseText(text);
  const h = t.headers.map((x) => x.toLowerCase());
  const col = (...names: string[]) => h.findIndex((x) => names.includes(x));
  const iS = col("logradouro", "rua", "street"), iN = col("numero", "número", "number"), iLa = col("lat", "latitude"), iLo = col("lon", "lng", "longitude");
  const iC = col("municipio", "cidade", "city"), iA = col("aviso", "obs", "fonte");
  if (iS < 0 || iLa < 0 || iLo < 0) throw new Error("CSV precisa das colunas logradouro, numero, lat, lon.");
  let matched = 0, created = 0, invalid = 0;
  for (const r of t.rows) {
    const lat = +r[iLa], lon = +r[iLo];
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { invalid++; continue; }
    const na = normalizeAddress(r[iS], iN >= 0 ? r[iN] : null, null, iC >= 0 ? r[iC] : null, null);
    if (na.errors.length) { invalid++; continue; }
    const isTest = iA >= 0 && /TESTE/i.test(r[iA] || "");
    const prev = await db.addresses.get(na.key);
    await db.addresses.put({
      key: na.key, display: na.display, original: prev?.original ?? na.original, street: na.street, number: na.number,
      neighborhood: prev?.neighborhood ?? na.neighborhood, city: na.city, cep: na.cep, lat, lon,
      precision: isTest ? "test" : "manual", confidence: isTest ? 0 : 1, source: isTest ? "posicao_teste" : "importado",
      candidates: prev?.candidates ?? [], needsReview: isTest,
      reason: isTest ? "POSIÇÃO DE TESTE (nó OSM sobre a via) — não representa a porta do imóvel." : null,
      verifiedAt: new Date().toISOString(), confirmedAt: isTest ? null : new Date().toISOString(),
    });
    prev ? matched++ : created++;
  }
  return { matched, created, invalid };
}

// ------------------------------------------------------------ paradas (1 por imóvel)

export interface StopView {
  key: string;
  address: Address;
  letters: Letter[];
  status: "pending" | "partial" | "completed" | "postponed" | "problem";
  uncertain: boolean;
  trust: Trust;
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
  const block = (await getSettings()).approxPolicy === "block";
  const addrs = new Map((await db.addresses.bulkGet(keys)).filter(Boolean).map((a) => [a!.key, a!]));
  const stops: StopView[] = [];
  const unlocated: Letter[] = [];
  const byKey = new Map<string, Letter[]>();
  for (const l of letters) {
    if (l.excluded) continue;
    const a = l.addressKey ? addrs.get(l.addressKey) : undefined;
    if (!a || !routePoint(a) || !ROUTABLE.includes(a.precision) && !a.entrance) { unlocated.push(l); continue; }
    if (block && trustOf(a).code !== "test" && ["street", "interpolated"].includes(a.precision) && !a.entrance) { unlocated.push(l); continue; }
    byKey.set(a.key, [...(byKey.get(a.key) || []), l]);
  }
  for (const [k, ls] of byKey) {
    const a = addrs.get(k)!;
    stops.push({ key: k, address: a, letters: ls.sort((x, y) => x.row - y.row), status: stopStatus(ls), uncertain: trustOf(a).approximate, trust: trustOf(a) });
  }
  return { stops, unlocated, letters, addresses: [...addrs.values()] };
}

// ------------------------------------------------------------ planejamento

let worker: Worker | null = null;
let reqId = 0;
let pending: { id: number; fail: (e: Error) => void } | null = null;

/** Interrompe o cálculo em andamento (encerra o Web Worker; o próximo cálculo cria outro). */
export function cancelPlan() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  pending?.fail(new Error("Cálculo cancelado pelo usuário."));
  pending = null;
}

export function runPlan(req: PlanRequest, onProgress?: (stage: string, p: number) => void): Promise<PlanResult> {
  worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  const id = ++reqId;
  const graphUrl = new URL("santos-graph.bin", document.baseURI).href;
  return new Promise((ok, fail) => {
    pending = { id, fail };
    const h = (ev: MessageEvent) => {
      if (ev.data.id !== id) return;
      if (ev.data.progress) return onProgress?.(ev.data.progress.stage, ev.data.progress.p);
      w.removeEventListener("message", h);
      pending = null;
      if (ev.data.error) fail(new Error(ev.data.error));
      else ok(ev.data.result);
    };
    w.addEventListener("message", h);
    w.addEventListener("error", (e) => { pending = null; fail(new Error(e.message || "Falha no motor de rotas.")); }, { once: true });
    w.postMessage({ id, graphUrl, req });
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
  const { stops, unlocated } = await stopsOf(batchId);
  const isPending = (l: Letter) => l.status === "pending" || l.status === "in_route" || (!!o.includePostponed && l.status === "postponed");
  const remaining = stops.filter((st) => st.letters.some(isPending));
  if (!remaining.length) throw new Error("Não há paradas pendentes neste lote.");
  const res = await runPlan({
    start: o.start, end: o.end ?? null, mode: o.mode, strategy: o.strategy, profile: s.profile,
    timeLimitMs: o.timeLimitMs, maxSnap: 150, snapReviewM: 30, fixedFirst: o.fixedFirst,
    stops: remaining.map((st) => {
      const pend = st.letters.filter(isPending).length;
      return {
        key: st.key, lat: routePoint(st.address)!.lat, lon: routePoint(st.address)!.lon, label: st.address.display,
        importRow: Math.min(...st.letters.map((l) => l.row)),
        service: s.serviceTime + s.perLetterService * Math.max(pend - 1, 0), sector: (st.address.neighborhood || "?").toUpperCase(),
      };
    }),
  }, onProgress);
  // cartas pendentes que NÃO entraram na rota (sem posição ou paradas excluídas) => rota PARCIAL
  const excludedKeys = new Set(res.excluded.map((e) => e.key));
  const notRouted = unlocated.filter(isPending).length
    + remaining.filter((st) => excludedKeys.has(st.key)).reduce((a, st) => a + st.letters.filter(isPending).length, 0);
  const prev = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version)[0];
  const route: Route = {
    id: uid(), batchId, version: (prev?.version ?? 0) + 1, status: "planned", createdAt: new Date().toISOString(),
    parentId: prev?.id ?? null, reason: o.reason ?? "plan",
    params: { mode: o.mode, strategy: o.strategy, profile: s.profile, serviceTime: s.serviceTime, perLetterService: s.perLetterService, timeLimitMs: o.timeLimitMs },
    start: o.start, end: o.end ?? null, totalTime: res.totalTime, travelTime: res.travelTime, serviceTime: res.serviceTime,
    totalDistance: res.totalDistance,
    metrics: {
      timings: res.timings, stops: res.order.length,
      letters: remaining.filter((st) => !excludedKeys.has(st.key)).reduce((a, st) => a + st.letters.filter(isPending).length, 0),
      status: res.status === "partial" || notRouted > 0 ? "partial" : "complete", notRoutedLetters: notRouted,
      pendingStops: remaining.length, byMode: res.byMode, flags: res.flags, strategy: res.strategy, excluded: res.excluded,
      snapReview: res.snapReview, accessTime: res.accessTime, timeBreakdown: res.timeBreakdown, originFlags: res.originFlags,
      objectiveRule: "factibilidade > cobertura > tempo+penalidades > distância",
      note: "Tempos e distâncias são ESTIMATIVAS pela malha OSM de pedestres; não verificados em campo.",
    },
    candidates: res.candidates, geojson: { type: "FeatureCollection", features: res.features },
    stops: res.order.map((x) => ({ key: x.key, seq: x.seq, eta: x.eta, legDistance: x.legDistance, legTime: x.legTime,
      snapDistance: x.snapDistance, access: x.access, confidence: x.confidence, flags: x.flags })),
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
  if (l.status === status) return null; // toque repetido: nenhum evento duplicado
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
  const pt = a ? routePoint(a) : null;
  return a && pt ? { label: `Última parada atendida: ${a.display}`, lat: pt.lat, lon: pt.lon } : null;
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

/** Neutraliza injeção de fórmula em CSV/XLSX sem perder o texto (= + - @ TAB CR). */
export function safeCell<T>(v: T): T | string {
  return typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

export async function exportRows(batchId: string) {
  const letters = (await db.letters.where("batchId").equals(batchId).toArray()).sort((a, b) => a.row - b.row);
  const routes = (await db.routes.where("batchId").equals(batchId).toArray()).sort((a, b) => b.version - a.version);
  const seq = new Map((routes[0]?.stops || []).map((s) => [s.key, s.seq]));
  const addrs = new Map((await db.addresses.toArray()).map((a) => [a.key, a]));
  const headers = ["identificador", "destinatario", "linha", "logradouro", "numero", "complemento", "bairro", "cep", "status", "precisao", "endereco_normalizado", "parada"];
  const rows = letters.map((l) => {
    const a = l.addressKey ? addrs.get(l.addressKey) : undefined;
    return ([l.externalId ?? "", l.recipient ?? "", l.row, l.street ?? "", l.number ?? "", l.complement ?? "", l.neighborhood ?? "", l.cep ?? "", l.status, a?.precision ?? "pendente", a?.display ?? "", l.addressKey ? seq.get(l.addressKey) ?? "" : ""] as (string | number)[]).map(safeCell);
  });
  return { headers, rows };
}

// ------------------------------------------------------------ desfazer

/** Desfaz o último registro de entrega (não apagado: fica marcado no histórico). */
export async function undoLastEvent(batchId: string) {
  const evs = (await db.events.where("batchId").equals(batchId).toArray()).filter((e) => !e.undoneAt).sort((a, b) => b.at.localeCompare(a.at));
  const ev = evs[0];
  if (!ev) return null;
  await db.transaction("rw", db.events, db.letters, async () => {
    await db.events.update(ev.id, { undoneAt: new Date().toISOString() });
    await db.letters.update(ev.letterId, { status: ev.previousStatus });
  });
  return ev;
}

// ------------------------------------------------------------ backup / restauração

const TABLES = ["batches", "letters", "addresses", "routes", "events", "settings"] as const;

async function snapshotJson() {
  const data: Record<string, unknown> = { app: "rota-santos", version: 2, exportedAt: new Date().toISOString() };
  for (const t of TABLES) data[t] = await (db as any)[t].toArray();
  return JSON.stringify(data);
}

async function deriveKey(password: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: 210000, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Backup completo. Com senha: AES-GCM 256 (chave PBKDF2-SHA256, 210 mil iterações). */
export async function backupJson(password?: string) {
  const json = await snapshotJson();
  if (!password) return json;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json)));
  let bin = "";
  for (let i = 0; i < ct.length; i += 0x8000) bin += String.fromCharCode(...ct.subarray(i, i + 0x8000));
  return JSON.stringify({ app: "rota-santos", encrypted: true, kdf: "PBKDF2-SHA256-210000", cipher: "AES-GCM-256", salt: b64(salt), iv: b64(iv), data: btoa(bin) });
}

export async function decodeBackup(text: string, password?: string): Promise<any> {
  const d = JSON.parse(text);
  if (d.app !== "rota-santos") throw new Error("Arquivo de backup inválido.");
  if (!d.encrypted) return d;
  if (!password) throw new Error("Este backup é protegido por senha.");
  const key = await deriveKey(password, unb64(d.salt));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(d.iv) as BufferSource }, key, unb64(d.data) as BufferSource);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error("Senha incorreta ou arquivo corrompido.");
  }
}

function validateBackup(d: any) {
  for (const t of TABLES) if (!Array.isArray(d[t])) throw new Error(`Backup incompleto: falta "${t}".`);
  const batchIds = new Set(d.batches.map((b: any) => b.id));
  const orphan = d.letters.filter((l: any) => !batchIds.has(l.batchId)).length;
  if (orphan) throw new Error(`Backup inconsistente: ${orphan} carta(s) sem lote.`);
}

/**
 * Restaura um backup. Antes, guarda um instantâneo do estado atual (tabela `snapshots`), para
 * permitir voltar atrás. `replace` apaga os dados atuais; `merge` mantém e sobrescreve pelos IDs.
 */
export async function restoreJson(text: string, opts: { password?: string; mode?: "merge" | "replace" } = {}) {
  const d = await decodeBackup(text, opts.password);
  validateBackup(d);
  const before = await snapshotJson();
  await db.snapshots.put({ id: "pre-restore", at: new Date().toISOString(), reason: "antes de restaurar backup", json: before });
  await db.transaction("rw", [db.batches, db.letters, db.addresses, db.routes, db.events, db.settings], async () => {
    if (opts.mode === "replace") for (const t of TABLES) await (db as any)[t].clear();
    for (const t of TABLES) await (db as any)[t].bulkPut(d[t]);
  });
  return { batches: d.batches.length, letters: d.letters.length, events: d.events.length };
}

export async function undoRestore() {
  const snap = await db.snapshots.get("pre-restore");
  if (!snap) throw new Error("Não há restauração para desfazer.");
  await restoreJson(snap.json, { mode: "replace" });
}

/** Verificação de integridade: nenhuma carta pode sumir. */
export async function verifyIntegrity() {
  const problems: string[] = [];
  for (const b of await db.batches.toArray()) {
    const n = await db.letters.where("batchId").equals(b.id).count();
    if (n !== b.report.inserted) problems.push(`Lote "${b.reference}": ${n} cartas no aparelho x ${b.report.inserted} importadas.`);
  }
  const letterIds = new Set((await db.letters.toArray()).map((l) => l.id));
  const orphanEv = (await db.events.toArray()).filter((e) => !letterIds.has(e.letterId)).length;
  if (orphanEv) problems.push(`${orphanEv} registro(s) de entrega sem carta.`);
  return problems;
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
