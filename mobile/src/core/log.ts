/** Log estruturado local (sem dados pessoais): componente, evento, detalhe curto. Fica num buffer circular e vai ao console. */
export interface LogEntry { t: number; sid: string; src: string; ev: string; d?: Record<string, unknown> }
const SID = Math.random().toString(36).slice(2, 8);
const buf: LogEntry[] = [];
export function log(src: string, ev: string, d?: Record<string, unknown>) {
  const e: LogEntry = { t: Date.now(), sid: SID, src, ev, d };
  buf.push(e);
  if (buf.length > 300) buf.shift();
  // eslint-disable-next-line no-console
  console.info(`[rota:${src}] ${ev}${d ? " " + JSON.stringify(d).slice(0, 200) : ""} sid=${SID}`);
}
export const logBuffer = () => buf.slice();
