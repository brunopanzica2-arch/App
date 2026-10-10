/// <reference lib="webworker" />
import { type Graph, parseGraph } from "./graph";
import { computePlan, type PlanRequest } from "./plan";

let graph: Graph | null = null;

self.onmessage = async (ev: MessageEvent<{ id: number; graphUrl: string; req: PlanRequest }>) => {
  const { id, graphUrl, req } = ev.data;
  try {
    if (!graph) {
      const r = await fetch(graphUrl);
      if (!r.ok) throw new Error("Não foi possível carregar a malha de Santos.");
      const buf = await r.arrayBuffer();
      // integridade: hash do arquivo confere com o manifesto (versão/área/data da extração OSM)
      const meta = await fetch(graphUrl.replace(/\.bin$/, ".json")).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (meta?.sha256 && crypto?.subtle) {
        const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (h !== meta.sha256) throw new Error("Malha de Santos corrompida (hash não confere). Reinstale o app.");
      }
      graph = parseGraph(buf);
    }
    const result = computePlan(graph, req, (stage, p) => self.postMessage({ id, progress: { stage, p } }));
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: (e as Error).message });
  }
};
