/** Armazenamento local (IndexedDB via Dexie). Tudo fica no aparelho. */
import Dexie, { type Table } from "dexie";
import type { Profile } from "./router";

export type LetterStatus = "pending" | "in_route" | "delivered" | "not_delivered" | "postponed" | "returned" | "address_not_found";
export type Precision = "exact" | "interpolated" | "street" | "neighborhood" | "not_found" | "manual" | "pending";

export interface Batch {
  id: string;
  reference: string;
  date: string;
  createdAt: string;
  sourceType: "csv" | "xlsx" | "text" | "manual";
  filename?: string;
  original: string; // entrada original preservada
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
}

export interface RouteStop {
  key: string; // addressKey
  seq: number;
  eta: number;
  legDistance: number;
  legTime: number;
  snapDistance: number;
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
}

export interface Settings {
  key: "main";
  start: { label: string; lat: number; lon: number; confirmed: boolean } | null;
  startAddress: string;
  profile: Profile;
  serviceTime: number;
  perLetterService: number;
  routeMode: "open" | "circular";
  nominatimEmail: string;
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
  }
}

export const db = new RotaDB();
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
