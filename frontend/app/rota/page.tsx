"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";

export default function CurrentRoute() {
  const router = useRouter();
  const [none, setNone] = useState(false);
  useEffect(() => {
    const batch = localStorage.getItem("rota.batch");
    if (!batch) return setNone(true);
    api(`/api/batches/${batch}/routes`).then((rs: any[]) => {
      const r = rs.find((x) => x.status === "active") || rs[0];
      if (r) router.replace(`/rota/${r.id}`);
      else setNone(true);
    }).catch(() => setNone(true));
  }, [router]);
  return (
    <AppShell title="Rota">
      {none ? (
        <Card className="text-center">
          <p className="mb-3">Nenhuma rota calculada para o lote selecionado.</p>
          <Link href="/"><Button>Ir ao painel</Button></Link>
        </Card>
      ) : <Spinner />}
    </AppShell>
  );
}
