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
export function useCurrentBatch(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const s = await getSettings();
      if (s.currentBatch && (await db.batches.get(s.currentBatch))) return setId(s.currentBatch);
      const last = (await db.batches.orderBy("createdAt").reverse().first())?.id ?? null;
      setId(last);
    })();
  }, []);
  return [id, (v) => { setId(v); void saveSettings({ currentBatch: v }); }];
}
