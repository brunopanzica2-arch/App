"use client";
/**
 * Fila offline (IndexedDB) de eventos de entrega + cache da jornada.
 * Cada evento tem client_event_id único (idempotência no servidor).
 */
import { createStore, del, get, keys, set } from "idb-keyval";
import { api } from "./api";

const queue = typeof window !== "undefined" ? createStore("rota-queue", "events") : (undefined as any);
const journey = typeof window !== "undefined" ? createStore("rota-journey", "routes") : (undefined as any);

export type QueuedEvent = {
  client_event_id: string;
  kind: "delivery_event";
  correspondence_id: string;
  status: string;
  reason?: string | null;
  notes?: string | null;
  occurred_at: string;
  route_id?: string | null;
};

type Listener = (s: SyncState) => void;
export type SyncState = { pending: number; syncing: boolean; lastError?: string; lastSync?: string };
let state: SyncState = { pending: 0, syncing: false };
const listeners = new Set<Listener>();

function emit(p: Partial<SyncState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l(state));
}

export function onSync(l: Listener) {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

export function clientId(): string {
  let id = localStorage.getItem("rota.client_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("rota.client_id", id);
  }
  return id;
}

export async function pendingCount() {
  return (await keys(queue)).length;
}

export async function enqueue(ev: Omit<QueuedEvent, "client_event_id" | "kind" | "occurred_at">) {
  const item: QueuedEvent = {
    ...ev,
    kind: "delivery_event",
    client_event_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
  };
  await set(item.client_event_id, item, queue);
  emit({ pending: await pendingCount() });
  void flush();
  return item;
}

let inflight: Promise<void> | null = null;

/** Envia a fila. Uma única execução por vez (trava síncrona, sem janela de corrida). */
export function flush(): Promise<void> {
  if (inflight) return inflight;
  inflight = doFlush().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doFlush(): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    emit({ pending: await pendingCount() });
    return;
  }
  const ids = await keys(queue);
  if (!ids.length) return emit({ pending: 0, lastError: undefined });
  emit({ syncing: true });
  try {
    const events = (await Promise.all(ids.map((k) => get(k, queue)))) as QueuedEvent[];
    const res = await api<{ results: { client_event_id: string; status: string }[] }>("/api/sync", {
      method: "POST",
      json: { client_id: clientId(), events },
    });
    for (const r of res.results) {
      // aplicado, duplicado, conflito ou rejeitado: o servidor já registrou o desfecho
      await del(r.client_event_id, queue);
    }
    emit({ syncing: false, lastError: undefined, lastSync: new Date().toISOString(), pending: await pendingCount() });
  } catch (e: any) {
    emit({ syncing: false, lastError: e?.message || "Falha de sincronização", pending: await pendingCount() });
  }
}

export async function saveJourney(routeId: string, data: unknown) {
  await set(routeId, { data, saved_at: new Date().toISOString() }, journey);
}

export async function loadJourney(routeId: string): Promise<{ data: any; saved_at: string } | undefined> {
  return get(routeId, journey);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flush());
  setInterval(() => void flush(), 30000);
}
