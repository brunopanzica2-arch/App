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
      graph = parseGraph(await r.arrayBuffer());
    }
    const result = computePlan(graph, req, (stage, p) => self.postMessage({ id, progress: { stage, p } }));
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: (e as Error).message });
  }
};
