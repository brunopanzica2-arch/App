import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "br.santos.rota",
  appName: "Rota Santos",
  webDir: "dist",
  android: { allowMixedContent: false },
  // SOMENTE para APK de sonda (CAP_SERVER_URL=http://10.0.2.2:4173): nunca definido nos builds de entrega
  ...(process.env.CAP_SERVER_URL ? { server: { url: process.env.CAP_SERVER_URL, cleartext: true } } : {}),
};

export default config;
