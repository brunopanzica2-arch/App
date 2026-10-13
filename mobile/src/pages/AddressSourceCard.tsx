import { useEffect, useState } from "react";
import { ensureLocalBase, localBase } from "../core/localgeo";
import { Card } from "../ui/misc";

/** Fonte dos endereços com número (citação exigida pelo IBGE) e o que ela garante — e o que não garante. */
export function AddressSourceCard() {
  const [info, setInfo] = useState<{ registros: number; logradouros: number; aviso: string } | null>(() => { const b = localBase(); return b ? { registros: b.meta.registros, logradouros: b.meta.logradouros, aviso: b.meta.aviso } : null; });
  const [err, setErr] = useState(false);
  useEffect(() => { void ensureLocalBase().then((b) => (b ? setInfo({ registros: b.meta.registros, logradouros: b.meta.logradouros, aviso: b.meta.aviso }) : setErr(true))); }, []);
  return (
    <Card className="space-y-1" data-testid="address-source">
      <div className="font-semibold">Base de endereços com número (offline)</div>
      {info ? (<>
        <p className="text-sm">Santos/SP · <b>{info.registros.toLocaleString("pt-BR")}</b> números em <b>{info.logradouros.toLocaleString("pt-BR")}</b> logradouros. Funciona sem internet e sem cota.</p>
        <p className="text-xs muted">Fonte: IBGE, Censo Demográfico 2022, Cadastro Nacional de Endereços para Fins Estatísticos (CNEFE). {info.aviso}</p>
      </>) : <p className="text-sm muted">{err ? "Base indisponível neste aparelho: o app usa só o provedor online." : "Carregando…"}</p>}
    </Card>
  );
}
