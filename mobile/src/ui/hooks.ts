import { useCallback, useEffect, useState } from "react";
import { db } from "../core/db";
import { getSettings, saveSettings } from "../core/service";

/** Carrega dados assíncronos e permite recarregar. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | undefined, () => void, string | null] {
  const [v, setV] = useState<T>();
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    fn().then((x) => alive && setV(x)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return [v, useCallback(() => setN((x) => x + 1), []), err];
}

/** Lote atual (o mais recente se nenhum foi escolhido). */
/** O 3º item indica que a leitura do cache terminou (antes disso `null` não significa "sem lote"). */
export function useCurrentBatch(): [string | null, (id: string) => void, boolean] {
  const [id, setId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    (async () => {
      const s = await getSettings();
      if (s.currentBatch && (await db.batches.get(s.currentBatch))) { setId(s.currentBatch); setResolved(true); return; }
      const last = (await db.batches.orderBy("createdAt").reverse().first())?.id ?? null;
      setId(last);
      setResolved(true);
    })();
  }, []);
  return [id, (v) => { setId(v); setResolved(true); void saveSettings({ currentBatch: v }); }, resolved];
}
