export type FreshdeskJson = null | boolean | number | string | FreshdeskJson[] | { [key: string]: FreshdeskJson };

export interface FreshdeskAgent {
  id: number | string;
  contact?: {
    name?: string | null;
    email?: string | null;
  } | null;
  ticket_scope?: number | string | null;
  type?: string | null;
  available?: boolean;
  group_ids?: Array<number | string> | null;
  occasional?: boolean | null;
  active?: boolean | null;
}

export interface FreshdeskGroup {
  id: number | string;
  name?: string | null;
  description?: string | null;
  escalate_to?: number | string | null;
  unassigned_for?: string | null;
  agent_ids?: Array<number | string> | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface FreshdeskAttachment {
  id?: number | string | null;
  name?: string | null;
  content_type?: string | null;
  size?: number | null;
  attachment_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface FreshdeskAccount {
  account_id?: number | string | null;
  account_name?: string | null;
  plan?: string | null;
  time_zone?: string | null;
}

export interface FreshdeskContact {
  id: number | string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  company_id?: number | string | null;
  job_title?: string | null;
  active?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  custom_fields?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface FreshdeskCompany {
  id: number | string;
  name?: string | null;
  domains?: string[] | null;
  note?: string | null;
  health_score?: string | null;
  account_tier?: string | null;
  renewal_date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  custom_fields?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface FreshdeskTicket {
  id: number | string;
  subject?: string | null;
  description_text?: string | null;
  status?: number | null;
  priority?: number | null;
  source?: number | null;
  type?: string | null;
  requester_id?: number | string | null;
  responder_id?: number | string | null;
  group_id?: number | string | null;
  company_id?: number | string | null;
  tags?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  due_by?: string | null;
  fr_due_by?: string | null;
  is_escalated?: boolean;
  custom_fields?: Record<string, unknown> | null;
  requester?: FreshdeskContact | null;
  company?: FreshdeskCompany | null;
  stats?: Record<string, unknown> | null;
  attachments?: FreshdeskAttachment[] | null;
  [key: string]: unknown;
}

export interface FreshdeskConversation {
  id: number | string;
  body?: string | null;
  body_text?: string | null;
  private?: boolean;
  incoming?: boolean;
  source?: number | null;
  user_id?: number | string | null;
  support_email?: string | null;
  from_email?: string | null;
  to_emails?: string[] | null;
  cc_emails?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  attachments?: FreshdeskAttachment[] | null;
  [key: string]: unknown;
}

export interface FreshdeskTimeEntry {
  id: number | string;
  ticket_id?: number | string | null;
  agent_id?: number | string | null;
  time_spent?: string | null;
  billable?: boolean | null;
  note?: string | null;
  executed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface FreshdeskSatisfactionRating {
  id?: number | string | boolean | null;
  survey_id?: number | string | null;
  user_id?: number | string | null;
  agent_id?: number | string | null;
  group_id?: number | string | null;
  ticket_id?: number | string | null;
  feedback?: string | null;
  ratings?: Record<string, number | string | null> | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface FreshdeskTicketField {
  id: number | string;
  name?: string | null;
  label?: string | null;
  label_for_customers?: string | null;
  type?: string | null;
  position?: number | null;
  required_for_closure?: boolean | null;
  required_for_agents?: boolean | null;
  required_for_customers?: boolean | null;
  customers_can_edit?: boolean | null;
  displayed_to_customers?: boolean | null;
  choices?: unknown;
  [key: string]: unknown;
}

export interface FreshdeskSolutionArticle {
  id: number | string;
  title?: string | null;
  description?: string | null;
  description_text?: string | null;
  status?: number | null;
  type?: number | null;
  category_id?: number | string | null;
  folder_id?: number | string | null;
  agent_id?: number | string | null;
  tags?: string[] | null;
  thumbs_up?: number | null;
  thumbs_down?: number | null;
  hits?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface FreshdeskCannedResponseFolder {
  id: number | string;
  name?: string | null;
  personal?: boolean | null;
  responses_count?: number | null;
  canned_responses?: Array<{ id: number | string; title?: string | null }> | null;
  [key: string]: unknown;
}

export interface FreshdeskCannedResponse {
  id: number | string;
  title?: string | null;
  folder_id?: number | string | null;
  content?: string | null;
  content_html?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  attachments?: FreshdeskAttachment[] | null;
  [key: string]: unknown;
}

export interface RateLimitSnapshot {
  total?: number;
  remaining?: number;
  usedCurrentRequest?: number;
  retryAfterSeconds?: number;
}

export type CountState = "exact" | "lower_bound" | "truncated";

export interface TicketAggregate {
  total: number;
  byStatus: Record<string, number>;
  countState: CountState;
  tickets: FreshdeskTicket[];
  scannedTickets: FreshdeskTicket[];
  scannedPages: number;
}
