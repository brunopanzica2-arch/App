/**
 * Geocodificação em lote, desacoplada da importação (V3 §5).
 *
 *  - uma tarefa por ENDEREÇO ÚNICO ainda não resolvido (nunca por carta), persistida no IndexedDB;
 *  - retomável: tarefas "running" deixadas por um fechamento forçado voltam a "pending";
 *  - tentativas com backoff exponencial, circuit breaker, cancelamento e progresso real;
 *  - falha isolada por registro: o resto continua e o que não foi resolvido fica visível como pendente;
 *  - Nominatim PÚBLICO: no máximo PUBLIC_BATCH_CAP por execução (política de uso); para volume, use instância própria;
 *  - só o ENDEREÇO vai ao provedor (queryFor): nunca nome do destinatário nem complemento.
 */
import { db, type Address, type GeoJob, type Letter } from "./db";
import { isPublicProvider, QuotaError, resolve } from "./geocode";
import { normalizeAddress } from "./normalize";

export const PUBLIC_BATCH_CAP = 30;
export const MAX_ATTEMPTS = 4;
export const BREAKER_THRESHOLD = 5;
const backoffMs = (attempts: number) => Math.min(60_000, 1000 * 2 ** attempts);

export type StopReason = "completed" | "cancelled" | "circuit_open" | "quota" | "public_cap";
export interface QueueResult {
  total: number; done: number; failed: number; remaining: number; attempted: number;
  stopped: StopReason; message: string; errors: string[];
}
export interface RunOpts {
  email?: string;
  signal?: { aborted: boolean };
  onProgress?: (done: number, total: number) => void;
  /** injeção para teste (provedor simulado) */
  resolver?: (letter: Letter, email: string) => Promise<Address | void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  publicCap?: number;
}

const unresolved = (a?: Address) => !a || a.precision === "pending" || (!a.confirmedAt && a.precision === "not_found" && !a.verifiedAt);

/** Cria tarefas para os endereços únicos sem posição. Não duplica e não reabre o que já foi resolvido. */
export async function enqueueBatch(batchId: string, now = Date.now()): Promise<number> {
  const letters = (await db.letters.where("batchId").equals(batchId).toArray()).filter((l) => l.addressKey && !l.excluded);
  const keys = [...new Set(letters.map((l) => l.addressKey!))];
  const addrs = await db.addresses.bulkGet(keys);
  const jobs = await db.geojobs.bulkGet(keys);
  let added = 0;
  await db.transaction("rw", db.geojobs, async () => {
    for (let i = 0; i < keys.length; i++) {
      const a = addrs[i], j = jobs[i];
      if (!unresolved(a)) continue; // já tem resposta do provedor ou foi confirmado
      if (j && j.state !== "failed" && j.state !== "skipped") {
        if (j.state === "running") await db.geojobs.update(j.key, { state: "pending" }); // retomada após crash
        continue;
      }
      await db.geojobs.put({ key: keys[i], batchId, state: "pending", attempts: 0, nextAt: now, error: null, updatedAt: new Date(now).toISOString() });
      added++;
    }
  });
  return added;
}

export async function queueStats(batchId: string) {
  const jobs = await db.geojobs.where("batchId").equals(batchId).toArray();
  const by = (s: GeoJob["state"]) => jobs.filter((j) => j.state === s).length;
  return { total: jobs.length, pending: by("pending") + by("running"), done: by("done"), failed: by("failed"), skipped: by("skipped") };
}

export async function runQueue(batchId: string, opts: RunOpts = {}): Promise<QueueResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const publicCap = isPublicProvider() ? (opts.publicCap ?? PUBLIC_BATCH_CAP) : Infinity;
  await enqueueBatch(batchId, now());
  const letters = await db.letters.where("batchId").equals(batchId).toArray();
  const firstLetter = new Map<string, Letter>();
  for (const l of letters) if (l.addressKey && !l.excluded && !firstLetter.has(l.addressKey)) firstLetter.set(l.addressKey, l);
  const resolver = opts.resolver ?? (async (l: Letter, email: string) => {
    await resolve(normalizeAddress(l.street, l.number, l.neighborhood, l.city, l.cep), email);
  });

  const errors: string[] = [];
  let attempted = 0, consecutive = 0;
  let stopped: StopReason = "completed";
  const total0 = (await queueStats(batchId)).total;
  const report = async () => opts.onProgress?.((await queueStats(batchId)).done + (await queueStats(batchId)).failed, total0);

  for (;;) {
    if (opts.signal?.aborted) { stopped = "cancelled"; break; }
    const pending = (await db.geojobs.where("batchId").equals(batchId).toArray()).filter((j) => j.state === "pending" || j.state === "running");
    if (!pending.length) break;
    pending.sort((a, b) => a.nextAt - b.nextAt);
    const job = pending[0];
    if (attempted >= publicCap) { stopped = "public_cap"; break; }
    const wait = job.nextAt - now();
    if (wait > 0) { await sleep(Math.min(wait, 60_000)); continue; }
    const letter = firstLetter.get(job.key);
    if (!letter) { await db.geojobs.update(job.key, { state: "skipped", error: "Sem carta ativa para este endereço.", updatedAt: new Date(now()).toISOString() }); continue; }
    await db.geojobs.update(job.key, { state: "running" });
    attempted++;
    try {
      await resolver(letter, opts.email ?? "");
      await db.geojobs.update(job.key, { state: "done", error: null, updatedAt: new Date(now()).toISOString() });
      consecutive = 0;
    } catch (e) {
      if (e instanceof QuotaError) {
        await db.geojobs.update(job.key, { state: "pending" });
        errors.push(e.message);
        stopped = "quota";
        break;
      }
      const attempts = job.attempts + 1, msg = (e as Error).message;
      consecutive++;
      if (attempts >= MAX_ATTEMPTS) {
        await db.geojobs.update(job.key, { state: "failed", attempts, error: msg, updatedAt: new Date(now()).toISOString() });
        errors.push(`${normalizeAddress(letter.street, letter.number, letter.neighborhood, letter.city, letter.cep).display}: ${msg}`);
      } else {
        await db.geojobs.update(job.key, { state: "pending", attempts, nextAt: now() + backoffMs(attempts), error: msg, updatedAt: new Date(now()).toISOString() });
      }
      if (consecutive >= BREAKER_THRESHOLD) { stopped = "circuit_open"; break; }
    }
    await report();
  }
  await report();
  const st = await queueStats(batchId);
  const message = {
    completed: "Geocodificação concluída.",
    cancelled: "Geocodificação cancelada. O que já foi resolvido foi mantido; retome quando quiser.",
    circuit_open: `Interrompida após ${BREAKER_THRESHOLD} falhas seguidas (provedor indisponível?). Nada foi perdido: tente de novo em alguns minutos.`,
    quota: errors[0] ?? "Cota diária atingida.",
    public_cap: `Nominatim público: no máximo ${PUBLIC_BATCH_CAP} endereços por execução (política de uso). Configure um provedor próprio em Ajustes, confirme no mapa ou importe coordenadas. ${st.pending} endereço(s) seguem pendentes.`,
  }[stopped];
  return { total: st.total, done: st.done, failed: st.failed, remaining: st.pending, attempted, stopped, message, errors };
}

/** Consumo por dia e provedor (consultas/erros) e custo estimado SOMENTE se o usuário informou o preço. */
export async function usageReport(costPerQueryBRL?: number) {
  const rows = await db.geousage.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date)).map((r) => ({
    ...r, costBRL: costPerQueryBRL != null ? +(r.queries * costPerQueryBRL).toFixed(2) : null,
  }));
}
