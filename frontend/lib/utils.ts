import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtDist(m?: number | null) {
  if (m == null) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(m)} m`;
}

export function fmtTime(s?: number | null) {
  if (s == null) return "—";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  in_route: "Em rota",
  delivered: "Entregue",
  not_delivered: "Não entregue",
  postponed: "Adiada",
  returned: "Devolvida",
  address_not_found: "Endereço não localizado",
};

export const STOP_STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  partial: "Parcial",
  completed: "Concluída",
  postponed: "Adiada",
  problem: "Com ocorrência",
};

export const PRECISION_LABEL: Record<string, string> = {
  exact: "Imóvel exato",
  interpolated: "Interpolado (aproximado)",
  street: "Aproximado na rua",
  neighborhood: "Centro do bairro",
  not_found: "Não localizado",
  manual: "Confirmado manualmente",
  pending: "Aguardando",
};

export const REASON_LABEL: Record<string, string> = {
  ausente: "Destinatário ausente",
  recusado: "Recusado",
  endereco_inexistente: "Endereço inexistente",
  numero_inexistente: "Número inexistente",
  mudou_se: "Mudou-se",
  desconhecido: "Desconhecido",
  acesso_impedido: "Acesso impedido",
  area_de_risco: "Área de risco",
  outro: "Outro",
};
