/** Armazenamento local (IndexedDB via Dexie). Tudo fica no aparelho. */
import Dexie, { type Table } from "dexie";
import type { Profile } from "./router";

export type LetterStatus = "pending" | "in_route" | "delivered" | "not_delivered" | "postponed" | "returned" | "address_not_found";
export type Precision = "exact" | "interpolated" | "street" | "neighborhood" | "not_found" | "manual" | "test" | "pending";

export interface Batch {
  id: string;
  reference: string;
  date: string;
  createdAt: string;
  sourceType: "csv" | "xlsx" | "text" | "manual";
  filename?: string;
  original: string; // entrada original preservada
  importHash?: string; // SHA-256 do conteúdo importado (detecta reimportação)
  report: { inserted: number; duplicates: { row: number; externalId: string }[]; withErrors: { row: number; errors: string[] }[] };
}

export interface Letter {
  id: string;
  batchId: string;
  row: number;
  externalId: string | null;
  recipient: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  cep: string | null;
  notes: string | null;
  status: LetterStatus;
  errors: string[];
  warnings: string[];
  excluded: boolean;
  exclusionReason?: string;
  addressKey: string | null;
  /** observação registrada pelo entregador em campo (separada de `notes`, que vem da importação) */
  fieldNote?: string | null;
}

export interface Candidate {
  lat: number;
  lon: number;
  label: string;
  precision: Precision;
  confidence: number;
  road?: string | null;
  houseNumber?: string | null;
  city?: string | null;
  postcode?: string | null;
}

export interface Address {
  key: string;
  display: string;
  original: string;
  street: string;
  number: string | null;
  neighborhood: string | null;
  city: string;
  cep: string | null;
  lat: number | null;
  lon: number | null;
  precision: Precision;
  confidence: number;
  source: string | null;
  candidates: Candidate[];
  needsReview: boolean;
  reason: string | null;
  verifiedAt: string | null;
  confirmedAt: string | null;
  /** portaria/entrada confirmada pelo entregador (V3); `lat/lon` continuam sendo a posição do endereço */
  entrance?: { lat: number; lon: number; note: string | null; confirmedAt: string; by: string } | null;
  /** histórico de alterações de posição (para reverter); máx. 20 */
  history?: {
    at: string; by: string; action: "confirm_pin" | "set_entrance" | "clear_entrance" | "invalidate";
    before: {
      lat: number | null; lon: number | null; precision: Precision; confidence: number; source: string | null;
      needsReview: boolean; reason: string | null; confirmedAt: string | null;
      entrance: { lat: number; lon: number; note: string | null; confirmedAt: string; by: string } | null;
    };
  }[];
}

export interface RouteStop {
  key: string; // addressKey
  seq: number;
  eta: number;
  legDistance: number;
  legTime: number;
  snapDistance: number;
  access?: number;       // ida e volta a pé até o ponto (s)
  confidence?: string;   // alta | boa | media | baixa
  flags?: string[];
}

export interface Route {
  id: string;
  batchId: string;
  version: number;
  status: "planned" | "active" | "superseded" | "finished";
  createdAt: string;
  parentId: string | null;
  reason: string;
  params: Record<string, unknown>;
  start: { label: string; lat: number; lon: number };
  end: { label: string; lat: number; lon: number } | null;
  totalTime: number;
  travelTime: number;
  serviceTime: number;
  totalDistance: number;
  metrics: Record<string, any>;
  candidates: any[];
  geojson: any;
  stops: RouteStop[];
  warnings: string[];
}

export interface DeliveryEvent {
  id: string;
  letterId: string;
  batchId: string;
  routeId: string | null;
  status: LetterStatus;
  previousStatus: LetterStatus;
  reason: string | null;
  notes: string | null;
  at: string;
  undoneAt?: string | null; // desfeito pelo usuário (o evento permanece no histórico)
}

/** Fila de geocodificação em lote (V3 §5): persistente, retomável, uma entrada por endereço ÚNICO. */
export interface GeoJob {
  key: string; // addressKey
  batchId: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  nextAt: number; // epoch ms (backoff)
  error: string | null;
  updatedAt: string;
}
export interface GeoUsage { id: string; date: string; provider: string; queries: number; errors: number }

export interface Settings {
  key: "main";
  start: { label: string; lat: number; lon: number; confirmed: boolean } | null;
  startAddress: string;
  profile: Profile;
  serviceTime: number;
  perLetterService: number;
  routeMode: "open" | "circular";
  nominatimEmail: string;
  geocodeDailyQuota?: number; // consultas públicas por dia (padrão 250)
  /** endereços aproximados (só a rua / interpolados): "include" = roteia sinalizando; "block" = só depois de confirmar */
  approxPolicy?: "include" | "block";
  /** provedor de geocodificação em lote: instância própria/contratada compatível com a API de busca do Nominatim.
   *  Vazio = Nominatim PÚBLICO (só uso pontual; lote limitado). A chave NÃO entra no backup. */
  geocoder?: { baseUrl: string; apiKey?: string; minIntervalMs?: number; costPerQueryBRL?: number } | null;
  currentBatch: string | null;
}

class RotaDB extends Dexie {
  batches!: Table<Batch, string>;
  letters!: Table<Letter, string>;
  addresses!: Table<Address, string>;
  geocache!: Table<{ q: string; at: string; result: Candidate[] }, string>;
  routes!: Table<Route, string>;
  events!: Table<DeliveryEvent, string>;
  settings!: Table<Settings, string>;
  snapshots!: Table<{ id: string; at: string; reason: string; json: string }, string>;
  geojobs!: Table<GeoJob, string>;
  geousage!: Table<GeoUsage, string>;

  constructor() {
    super("rota-santos");
    this.version(1).stores({
      batches: "id, date, createdAt",
      letters: "id, batchId, externalId, addressKey, status",
      addresses: "key, needsReview, precision",
      geocache: "q",
      routes: "id, batchId, version, status",
      events: "id, letterId, batchId, at",
      settings: "key",
    });
    // v2 (auditoria V2): hash de importação e marcação de "desfazer". Migração sem perda:
    // dados da v1 permanecem; campos novos recebem valores padrão.
    this.version(2).stores({
      batches: "id, date, createdAt, importHash",
      events: "id, letterId, batchId, at",
      snapshots: "id, at",
    }).upgrade(async (tx) => {
      await tx.table("events").toCollection().modify((e: any) => { if (e.undoneAt === undefined) e.undoneAt = null; });
    });
    // v3: fila de geocodificação e consumo por provedor. Só adiciona tabelas (nenhum dado existente muda).
    this.version(3).stores({
      geojobs: "key, batchId, state, nextAt",
      geousage: "id, date",
    });
  }
}

export const db = new RotaDB();
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
