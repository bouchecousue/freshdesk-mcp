const STATUS_LABELS: Record<number, string> = {
  2: "Ouvert",
  3: "En attente",
  4: "Résolu",
  5: "Fermé",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "Faible",
  2: "Moyenne",
  3: "Haute",
  4: "Urgente",
};

const SOURCE_LABELS: Record<number, string> = {
  1: "E-mail",
  2: "Portail",
  3: "Téléphone",
  4: "X / Twitter",
  5: "Facebook",
  6: "E-commerce",
  7: "Chat",
  8: "Mobile",
  9: "Widget de feedback",
  10: "E-mail sortant",
};

function labelFor(value: number | null | undefined, dictionary: Record<number, string>, prefix: string): string | null {
  if (value === null || value === undefined) return null;
  return dictionary[value] ?? `${prefix} ${value}`;
}

export function ticketStatusLabel(value: number | null | undefined): string | null {
  return labelFor(value, STATUS_LABELS, "Statut");
}

export function ticketPriorityLabel(value: number | null | undefined): string | null {
  return labelFor(value, PRIORITY_LABELS, "Priorité");
}

export function ticketSourceLabel(value: number | null | undefined): string | null {
  return labelFor(value, SOURCE_LABELS, "Source");
}
