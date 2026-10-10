/**
 * Posição do endereço × entrada (portaria) × ponto na malha (V3 §4).
 *
 * - `lat/lon` do Address = localização POSTAL do número (fonte + precisão registradas).
 * - `entrance` = ponto de acesso/portaria CONFIRMADO pelo entregador. Só existe com confirmação explícita.
 * - o ponto na malha (snap) e o percurso de acesso são calculados pelo roteador a partir de `routePoint()`.
 *
 * Hierarquia de confiança (1 = mais confiável):
 *  1 portaria confirmada · 2 pino confirmado · 3 número verificado na fonte · 4 interpolado (aproximado)
 *  5 só a rua (não confirmado) · 6 bairro / não localizado (nunca roteado)
 */
import { db, type Address } from "./db";

export type TrustCode = "entrance" | "pin" | "verified" | "test" | "interpolated" | "street" | "unlocated";
export interface Trust {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  code: TrustCode;
  label: string;
  /** true = posição aproximada ou não verificada; nunca apresentar como precisa */
  approximate: boolean;
}

export const STALE_DAYS = 365;

export function trustOf(a: Pick<Address, "precision" | "entrance">): Trust {
  if (a.entrance) return { level: 1, code: "entrance", label: "Portaria confirmada", approximate: false };
  switch (a.precision) {
    case "manual": return { level: 2, code: "pin", label: "Pino confirmado (não é portaria)", approximate: false };
    case "exact": return { level: 3, code: "verified", label: "Número localizado na fonte", approximate: false };
    case "test": return { level: 3, code: "test", label: "Posição de TESTE", approximate: true };
    case "interpolated": return { level: 4, code: "interpolated", label: "Interpolado — aproximado", approximate: true };
    case "street": return { level: 5, code: "street", label: "Só a rua — não confirmado", approximate: true };
    default: return { level: 6, code: "unlocated", label: "Não localizado", approximate: true };
  }
}

/** Ponto usado para rotear/mostrar/navegar: a entrada confirmada, se houver; senão a posição do endereço. */
export function routePoint(a: Pick<Address, "lat" | "lon" | "entrance">): { lat: number; lon: number; kind: "entrance" | "address" } | null {
  if (a.entrance) return { lat: a.entrance.lat, lon: a.entrance.lon, kind: "entrance" };
  if (a.lat != null && a.lon != null) return { lat: a.lat, lon: a.lon, kind: "address" };
  return null;
}

export function isStale(a: Pick<Address, "confirmedAt">, days = STALE_DAYS, now = Date.now()): boolean {
  return !!a.confirmedAt && now - Date.parse(a.confirmedAt) > days * 86_400_000;
}

type Snapshot = NonNullable<Address["history"]>[number]["before"];
const snap = (a: Address): Snapshot => ({
  lat: a.lat, lon: a.lon, precision: a.precision, confidence: a.confidence, source: a.source, needsReview: a.needsReview,
  reason: a.reason, confirmedAt: a.confirmedAt, entrance: a.entrance ?? null,
});

async function change(key: string, action: NonNullable<Address["history"]>[number]["action"], patch: Partial<Address>, by = "entregador") {
  const a = await db.addresses.get(key);
  if (!a) throw new Error("Endereço não encontrado.");
  const history = [...(a.history ?? []), { at: new Date().toISOString(), action, by, before: snap(a) }].slice(-20);
  await db.addresses.update(key, { ...patch, history });
  return (await db.addresses.get(key))!;
}

const checkCoord = (lat: number, lon: number) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Coordenada inválida.");
};

/** Confirma a posição do endereço (pino). NÃO afirma portaria. */
export function confirmPin(key: string, lat: number, lon: number, by = "entregador") {
  checkCoord(lat, lon);
  return change(key, "confirm_pin", {
    lat, lon, precision: "manual", confidence: 1, source: "manual", needsReview: false, reason: null, confirmedAt: new Date().toISOString(),
  }, by);
}

/** Confirma a PORTARIA/entrada. Mantém a posição postal anterior como referência (se houver). */
export async function confirmEntrance(key: string, lat: number, lon: number, note: string | null = null, by = "entregador") {
  checkCoord(lat, lon);
  const a = await db.addresses.get(key);
  const now = new Date().toISOString();
  return change(key, "set_entrance", {
    entrance: { lat, lon, note, confirmedAt: now, by },
    needsReview: false, reason: null, confirmedAt: now,
    ...(a && a.lat == null ? { lat, lon, precision: "manual" as const, confidence: 1, source: "manual" } : {}),
  }, by);
}

export const clearEntrance = (key: string) => change(key, "clear_entrance", { entrance: null });

/** Invalida uma confirmação antiga/duvidosa: volta para revisão sem apagar coordenadas. */
export async function invalidateConfirmation(key: string) {
  const a = await db.addresses.get(key);
  return change(key, "invalidate", {
    entrance: null, confirmedAt: null, needsReview: true, reason: "Confirmação invalidada: confira de novo no mapa.",
    ...(a?.precision === "manual" ? { precision: "street" as const, confidence: 0.3 } : {}),
  });
}

/** Desfaz a última alteração de posição/entrada (restaura o estado anterior). */
export async function revertLast(key: string) {
  const a = await db.addresses.get(key);
  const h = a?.history ?? [];
  if (!a || !h.length) throw new Error("Nada para reverter.");
  const last = h[h.length - 1];
  await db.addresses.update(key, { ...last.before, history: h.slice(0, -1) });
  return (await db.addresses.get(key))!;
}

/** Resumo de confiança de um conjunto de endereços (para o painel e relatórios). */
export function trustSummary(addrs: Pick<Address, "precision" | "entrance">[]) {
  const out = { entrance: 0, pin: 0, verified: 0, test: 0, interpolated: 0, street: 0, unlocated: 0, total: addrs.length };
  for (const a of addrs) out[trustOf(a).code]++;
  return out;
}
