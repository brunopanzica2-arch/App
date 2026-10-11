/** Ações dos cartões de resultado da busca: adicionar carta, traçar rota até o ponto e corrigir posição. Nada aqui chama a rede. */
import { type Address, db } from "./db";
import { commitImport } from "./importer";
import { normalizeAddress } from "./normalize";
import type { PlanResult } from "./plan";
import type { AddressHit } from "./search";
import { getSettings, runPlan, saveSettings } from "./service";
import { confirmPin } from "./address";

const streetOf = (title: string, number: string | null) => (number ? title.replace(new RegExp(`,\\s*${number}$`), "") : title);

/** Cria uma carta manual a partir do resultado. O número digitado é preservado; a posição vem do resultado com a precisão REAL dele. */
export async function addLetterFromHit(hit: AddressHit, batchId: string | null): Promise<{ batchId: string; addressKey: string }> {
  const street = streetOf(hit.title, hit.numberAsked);
  const number = hit.numberAsked ?? "";
  const headers = ["street", "number", "city", "state"];
  const t = { headers, rows: [[street, number, "Santos", "SP"]], original: JSON.stringify({ street, number, from: "busca" }), hasHeader: false };
  const map = Object.fromEntries(["street", "number", "city", "state", "neighborhood", "cep", "complement", "recipient", "external_id"].map((f) => [f, headers.includes(f) ? f : null]));
  const b = await commitImport(t, map, "Busca de endereço", new Date().toISOString().slice(0, 10), "manual", undefined, batchId ?? undefined, true);
  await saveSettings({ currentBatch: b.id });
  const na = normalizeAddress(street, number || null, null, "Santos", null);
  const ex = await db.addresses.get(na.key);
  const keep = !!ex && (!!ex.confirmedAt || !!ex.entrance || ["exact", "interpolated", "manual", "test"].includes(ex.precision));
  if (!keep) {
    const exact = hit.numberConfirmed;
    const addr: Address = {
      ...(ex ?? ({} as Address)),
      key: na.key, display: na.display, original: na.original, street: na.street, number: na.number, neighborhood: na.neighborhood, city: na.city, cep: na.cep,
      lat: hit.lat, lon: hit.lon, precision: hit.precision === "exact" || hit.precision === "interpolated" ? hit.precision : "street",
      confidence: exact ? 0.85 : 0.4, source: `busca|${hit.source}`, candidates: ex?.candidates ?? [], needsReview: !exact,
      reason: exact ? null : hit.note, verifiedAt: new Date().toISOString(), confirmedAt: null,
    };
    await db.addresses.put(addr);
  }
  return { batchId: b.id, addressKey: na.key };
}

/** Corrige a posição de um endereço já cadastrado: vira "confirmado pelo usuário" com data (nunca "exato do provedor"). */
export async function correctPosition(addressKey: string, lat: number, lon: number) { await confirmPin(addressKey, lat, lon); }

/** Rota a pé do ponto atual até o resultado, com o MESMO perfil urbano seguro da navegação. Não grava lote nem sessão (prévia). */
export async function previewRouteTo(dest: { lat: number; lon: number; label: string }, here: { lat: number; lon: number }): Promise<PlanResult> {
  const s = await getSettings();
  return runPlan({
    start: here, end: null, mode: "open", strategy: "global", timeLimitMs: 3000, maxSnap: 150, snapReviewM: 30,
    profile: { ...s.profile, avoid_edges: (s.reportedEdges ?? []).map((x) => x.key) },
    stops: [{ key: "destino", lat: dest.lat, lon: dest.lon, label: dest.label, service: 0 }],
  });
}
