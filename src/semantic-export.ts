import type { FreshdeskTicket, FreshdeskConversation } from "./freshdesk/types.js";

export function normalizeExportRecord(row: Record<string, unknown>): { ticket: FreshdeskTicket; conversations: FreshdeskConversation[] } {
  const raw = row.helpdesk_ticket as Record<string, unknown> | undefined;
  if (!raw || !Number.isSafeInteger(raw.display_id) || Number(raw.display_id) <= 0) throw new Error("Invalid native export ticket identifier");
  const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  // Native exports use internal IDs; API v2 uses display_id. Legacy owner_id maps to company_id,
  // verified against live tickets before import. Never substitute requester ownership.
  const ticket = {
    id: Number(raw.display_id), subject: raw.subject, description_text: raw.description,
    description: raw.description_html, company_id: raw.owner_id ?? null,
    status: raw.status, spam: raw.spam, deleted: raw.deleted,
    created_at: date(raw.created_at), updated_at: date(raw.updated_at),
  } as FreshdeskTicket;
  const notes = Array.isArray(raw.notes) ? raw.notes as Array<Record<string, unknown>> : [];
  const conversations = notes.filter(note => !note.deleted).map(note => ({
    id: note.id, body_text: note.body, body: note.body_html,
    incoming: note.incoming, private: note.private,
    created_at: date(note.created_at), updated_at: date(note.updated_at),
  } as FreshdeskConversation));
  return { ticket, conversations };
}
