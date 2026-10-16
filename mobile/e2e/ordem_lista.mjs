// A lista do usuário no formato "Rua X, números: …": a rota deve seguir EXATAMENTE a ordem escrita (inclusive mesma rua com outros números).
import { chromium } from "playwright";
const BASE = process.env.E2E_BASE || "http://localhost:4173/";
const LISTA = `rua Júlio conceição, números :
365

Rua cunha Moreira, números :
197, 200

Avenida senador Feijó, números :
768, 811

Avenida Washington Luiz, números :
224, 193, 239,

Rua Barão de Paranapiacaba, números :
138, 87, 42, 36,

Avenida conselheiro nebias, números :
532,

Rua doutor Leôncio de Rezende filho, números :
46

Avenida conselheiro Rodrigues, números :
415, 484,

Rua pérsio Queiroz filho, números :
160, 159, 130,

Rua Luís de Camões, números :
212, 198,

Rua cunha Moreira, números :
56,

Rua doutor Guedes coelho, números :
94, 90, 81, 37, 20,

Avenida conselheiro nebias 444`;
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block", geolocation: { latitude: -23.9372, longitude: -46.3318, accuracy: 10 }, permissions: ["geolocation"] });
await ctx.addInitScript(() => { try { localStorage.setItem("rota.intro.skip", "1"); } catch {} });
await ctx.route(/nominatim|photon|overpass/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
const p = await ctx.newPage(); p.setDefaultTimeout(240000); p.on("dialog", (d) => d.accept());
await p.goto(BASE); await p.waitForSelector("[data-testid=map-home]");
await p.goto(BASE + "#/importar");
await p.getByRole("tab", { name: /Colar texto/ }).click();
await p.locator("#text").fill(LISTA);
await p.getByRole("button", { name: "Pré-visualizar" }).click();
await p.getByTestId("inferred").waitFor();
const t = await p.locator("main").innerText();
console.log("prévia:", (t.match(/Linhas lidas:\s*\d+/) || ["?"])[0], "|", (t.match(/Números identificados:[^\n]*/) || ["?"])[0]);
await p.getByRole("button", { name: /Confirmar e localizar/ }).click();
await p.getByRole("button", { name: "Localizar agora" }).click({ timeout: 20000 }).catch(() => {});
await p.getByTestId("number-status").waitFor({ timeout: 100000 }).catch(async (e) => { console.log("TEXTO:", (await p.locator("main").innerText()).slice(0, 900)); throw e; });
await p.goto(BASE + "#/"); await p.waitForSelector("[data-testid=map-home]"); await p.waitForTimeout(2500);
await p.getByRole("button", { name: "Calcular rota" }).click();
await p.waitForFunction(() => document.querySelector("[data-testid=map-home]")?.dataset.phase === "planned", null, { timeout: 240000 });
const got = await p.evaluate(() => new Promise((res) => {
  const o = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]);
  o.then(async (dbs) => { const name = dbs[0].name; const rq = indexedDB.open(name); rq.onsuccess = () => {
    const d = rq.result; const tx = d.transaction(["routes", "letters", "addresses"].filter((n) => d.objectStoreNames.contains(n)), "readonly");
    const routes = tx.objectStore("routes").getAll(); routes.onsuccess = () => {
      const r = routes.result.sort((a, b) => b.version - a.version)[0];
      const lt = tx.objectStore("letters").getAll(); lt.onsuccess = () => {
        const rowOf = {}; for (const l of lt.result) if (l.addressKey) rowOf[l.addressKey] = Math.min(rowOf[l.addressKey] ?? 1e9, l.row);
        res({ order: r.stops.map((s) => rowOf[s.key]), n: r.stops.length, excluded: r.metrics.excluded });
      }; }; }; });
}));
const asc = got.order.every((v, i, a) => i === 0 || a[i - 1] < v);
console.log("linhas na ordem da rota:", got.order.join(","), "| excluídas:", JSON.stringify(got.excluded));
console.log(asc ? "PASSOU: rota na ordem da lista" : "FALHOU: ordem diferente da lista");
await p.screenshot({ path: "../docs/evidencias-chromium-2_4/ordem_lista.png" });
await b.close(); process.exit(asc ? 0 : 1);
