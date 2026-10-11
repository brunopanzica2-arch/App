import { useState } from "react";
import { introSkip, introSound, setIntroSkip, setIntroSound } from "../intro/policy";
import { Card } from "../ui/misc";

const store = () => { try { return window.localStorage; } catch { return null; } };

/** Opções da abertura (guardadas no aparelho, lidas antes de o banco abrir). Tocar na tela também pula a abertura. */
export function IntroPrefsCard() {
  const [skip, setSkip] = useState(() => introSkip(store()));
  const [sound, setSound] = useState(() => introSound(store()));
  return (
    <Card className="space-y-2" data-testid="intro-prefs">
      <div className="font-semibold">Abertura do app</div>
      <label className="flex items-start gap-3 py-1">
        <input type="checkbox" className="mt-1 h-5 w-5" checked={skip} onChange={(e) => { setSkip(e.target.checked); setIntroSkip(store(), e.target.checked); }} />
        <span><span className="block">Pular abertura</span><span className="block text-xs muted">Vai direto para o app. Você também pode tocar na tela durante a abertura para pulá-la.</span></span>
      </label>
      <label className="flex items-start gap-3 py-1">
        <input type="checkbox" className="mt-1 h-5 w-5" checked={sound} disabled={skip} onChange={(e) => { setSound(e.target.checked); setIntroSound(store(), e.target.checked); }} />
        <span><span className="block">Som discreto na abertura</span><span className="block text-xs muted">Desligado por padrão, volume baixo. O app não consegue saber se o celular está no silencioso: use este botão para desligar.</span></span>
      </label>
    </Card>
  );
}
