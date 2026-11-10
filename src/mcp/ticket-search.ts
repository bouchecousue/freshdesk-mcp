export interface StructuredTicketSearchInput {
  statuses?: number[] | undefined;
  priorities?: number[] | undefined;
  groupIds?: number[] | undefined;
  agentIds?: number[] | undefined;
  unassigned?: boolean | undefined;
  tags?: string[] | undefined;
  types?: string[] | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
}

const STRING_VALUE = /^[^'"\r\n]+$/;

function integerClause(field: string, values: number[]): string {
  const clauses = values.map((value) => `${field}:${value}`);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
}

function stringClause(field: string, values: string[]): string {
  for (const value of values) {
    if (!STRING_VALUE.test(value)) throw new Error(`${field} values cannot contain quotes or line breaks`);
  }
  const clauses = values.map((value) => `${field}:'${value}'`);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
}

function dateClauses(field: string, from: string | undefined, to: string | undefined): string[] {
  const clauses: string[] = [];
  if (from) clauses.push(`${field}:>'${from}'`);
  if (to) clauses.push(`${field}:<'${to}'`);
  return clauses;
}

export function hasStructuredTicketSearch(input: StructuredTicketSearchInput): boolean {
  return Boolean(
    input.statuses?.length
      || input.priorities?.length
      || input.groupIds?.length
      || input.agentIds?.length
      || input.unassigned
      || input.tags?.length
      || input.types?.length
      || input.createdFrom
      || input.createdTo
      || input.updatedFrom
      || input.updatedTo
      || input.dueFrom
      || input.dueTo,
  );
}

export function buildStructuredTicketSearchQuery(input: StructuredTicketSearchInput): string {
  if (input.unassigned && input.agentIds?.length) throw new Error("unassigned cannot be combined with agentIds");
  const clauses: string[] = [];
  if (input.statuses?.length) clauses.push(integerClause("status", input.statuses));
  if (input.priorities?.length) clauses.push(integerClause("priority", input.priorities));
  if (input.groupIds?.length) clauses.push(integerClause("group_id", input.groupIds));
  if (input.unassigned) clauses.push("agent_id:null");
  else if (input.agentIds?.length) clauses.push(integerClause("agent_id", input.agentIds));
  if (input.tags?.length) clauses.push(stringClause("tag", input.tags));
  if (input.types?.length) clauses.push(stringClause("type", input.types));
  clauses.push(...dateClauses("created_at", input.createdFrom, input.createdTo));
  clauses.push(...dateClauses("updated_at", input.updatedFrom, input.updatedTo));
  clauses.push(...dateClauses("due_by", input.dueFrom, input.dueTo));
  if (clauses.length === 0) throw new Error("At least one structured ticket filter is required");
  const query = clauses.join(" AND ");
  if (query.length > 512) throw new Error("The generated Freshdesk ticket query exceeds 512 characters");
  return query;
}
