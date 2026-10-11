import { CheckCircle2, Flame, History, PartyPopper, RotateCcw, Sparkles, Trophy, Upload } from "lucide-react";
import type { DayStats } from "../core/db";
import { levelOf, type Reward } from "../core/progress";
import { Button } from "./button";
import { fmtTime } from "./utils";

/** Recompensa curta após uma entrega: sempre secundária à navegação (pequena, some sozinha, com Desfazer). */
export function RewardToast({ reward, onUndo, onClose, top }: { reward: Reward; onUndo: () => void; onClose: () => void; top: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="reward" className="reward-in absolute inset-x-3 z-30 flex items-center gap-3 rounded-2xl bg-[#2e1065] p-3 text-white shadow-2xl" style={{ top }}>
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/15"><CheckCircle2 className="h-7 w-7 text-emerald-300" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div className="text-lg font-extrabold leading-tight">{reward.title}</div>
        <div className="text-sm text-violet-100">{reward.subtitle}</div>
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs font-bold">
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-300 px-2 py-0.5 text-amber-950"><Sparkles className="h-3 w-3" aria-hidden /> +{reward.xp} XP</span>
          {reward.streak >= 2 && <span className="inline-flex items-center gap-1 rounded-full bg-orange-400 px-2 py-0.5 text-orange-950"><Flame className="h-3 w-3" aria-hidden /> Sequência {reward.streak}</span>}
        </div>
      </div>
      <button className="rounded-lg px-2 py-1 text-sm font-bold underline" onClick={onUndo}>Desfazer</button>
      <button className="sr-only" onClick={onClose}>Fechar</button>
    </div>
  );
}

export function Stat({ icon, v, l }: { icon: React.ReactNode; v: string | number; l: string }) {
  return <div className="rounded-xl bg-black/5 p-2 text-center dark:bg-white/10"><div className="flex items-center justify-center gap-1 text-lg font-extrabold">{icon}{v}</div><div className="text-[11px] muted">{l}</div></div>;
}

/** Estado final: rota concluída. O mapa já está limpo; aqui só o resumo e a saída clara. */
export function CompletionCard({ stats, outside, hasRoute, onClear, onHistory, onImport, onPlanRest }: {
  stats: DayStats; outside: number; hasRoute: boolean; onClear: () => void; onHistory: () => void; onImport: () => void; onPlanRest: (() => void) | null;
}) {
  const lv = levelOf(stats.xp);
  return (
    <div className="space-y-3" data-testid="completion">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-violet-100 text-violet-700"><PartyPopper className="h-7 w-7" aria-hidden /></span>
        <div>
          <div className="text-xl font-extrabold leading-tight">Rota concluída!</div>
          <div className="text-sm muted">Excelente trabalho. Todas as entregas desta rota foram tratadas.</div>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2" aria-label="Resumo da sessão">
        <Stat icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />} v={stats.delivered} l="entregues" />
        <Stat icon={<Flame className="h-4 w-4 text-orange-500" aria-hidden />} v={stats.bestStreak} l="melhor seq." />
        <Stat icon={<Trophy className="h-4 w-4 text-amber-500" aria-hidden />} v={`Nv ${lv.level}`} l={`${stats.xp} XP`} />
        <Stat icon={null} v={fmtTime(stats.activeMs / 1000)} l="tempo ativo" />
      </div>
      {outside > 0 && (
        <div className="rounded-xl border border-app p-3 text-sm" role="note">
          <b>{outside} carta(s) pendente(s) fora da rota</b> (não localizadas ou adiadas). Elas não fazem parte da rota concluída.
          {onPlanRest && <Button className="mt-2 w-full" variant="secondary" onClick={onPlanRest}>Calcular rota para as pendentes</Button>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" className="col-span-2" onClick={onClear}>{hasRoute ? "Encerrar e limpar o mapa" : "Voltar ao mapa"}</Button>
        <Button variant="secondary" onClick={onHistory}><History className="h-5 w-5" /> Histórico</Button>
        <Button variant="secondary" onClick={onImport}><Upload className="h-5 w-5" /> Novo lote</Button>
      </div>
    </div>
  );
}

/** Navegação encerrada manualmente: nada de rota no mapa; escolhas explícitas. */
export function EndedCard({ stopsLeft, lettersLeft, onResume, onReplan, onFinish }: { stopsLeft: number; lettersLeft: number; onResume: () => void; onReplan: () => void; onFinish: () => void }) {
  return (
    <div className="space-y-3" data-testid="ended">
      <div>
        <div className="text-xl font-extrabold leading-tight">Navegação encerrada</div>
        <div className="text-sm muted">{lettersLeft} carta(s) em {stopsLeft} parada(s) ainda pendentes. A rota saiu do mapa; nada foi apagado.</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" className="col-span-2" onClick={onResume}>Retomar rota</Button>
        <Button variant="secondary" onClick={onReplan}><RotateCcw className="h-5 w-5" /> Recalcular</Button>
        <Button variant="secondary" onClick={onFinish}>Concluir sessão</Button>
      </div>
    </div>
  );
}
