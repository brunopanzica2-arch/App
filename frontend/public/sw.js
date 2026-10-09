/* Service worker: app shell em cache; API GET com rede primeiro e cópia local.
   Registros de entrega offline ficam no IndexedDB (lib/offline.ts), não aqui.
   Mapas offline NÃO são oferecidos (tiles exigem licença/infra própria). */
const SHELL = "rota-shell-v1";
const API = "rota-api-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/rota", "/manifest.webmanifest", "/icons/icon.svg"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, API].includes(k)).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // tiles e serviços externos: sem cache
  if (url.pathname.startsWith("/api/")) {
    // dados pessoais: só respostas de rotas/lotes, e somente neste aparelho
    if (!/^\/api\/(routes|batches|settings)/.test(url.pathname)) return;
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(API).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((r) => r || new Response(JSON.stringify({ detail: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })))
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req).then((r) => r || caches.match("/rota") || caches.match("/"))));
  }
});
