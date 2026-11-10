import { convert } from "html-to-text";

import { canonicalJson } from "../util.js";
import type { FreshdeskConversation, FreshdeskTicket } from "./types.js";

function normalizedHtml(value: string): string {
  return convert(value, { wordwrap: false }).replace(/\s+/g, " ").trim();
}

function sameText(expected: unknown, html: unknown, text: unknown): boolean {
  if (typeof expected !== "string") return false;
  // Prefer HTML on both sides so links remain part of the comparison.
  const actual = typeof html === "string" ? normalizedHtml(html)
    : typeof text === "string" ? text.replace(/\s+/g, " ").trim() : null;
  return actual !== null && normalizedHtml(expected) === actual;
}

function sameSet(expected: unknown, actual: unknown, lowerCase = false): boolean {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
  const normalize = (values: unknown[]) => [...new Set(values.map((value) =>
    lowerCase ? String(value).toLowerCase() : String(value),
  ))].sort();
  return canonicalJson(normalize(expected)) === canonicalJson(normalize(actual));
}

/** Issues contain field names only, never the message or its recipients. */
export function verifyTicketFields(ticketId: number, payload: Record<string, unknown>, ticket: FreshdeskTicket): string[] {
  const issues = String(ticket.id) === String(ticketId) ? [] : ["ticket_id"];
  for (const [field, expected] of Object.entries(payload)) {
    let matches: boolean;
    if (field === "description") matches = sameText(expected, ticket.description, ticket.description_text);
    else if (field === "email") matches = typeof ticket.requester?.email === "string"
      && ticket.requester.email.toLowerCase() === String(expected).toLowerCase();
    else if (field === "tags") matches = sameSet(expected, ticket.tags);
    else matches = ticket[field] !== undefined && canonicalJson(expected) === canonicalJson(ticket[field]);
    if (!matches) issues.push(field);
  }
  return issues;
}

export function verifyConversationFields(
  ticketId: number,
  action: string,
  payload: Record<string, unknown>,
  conversation: FreshdeskConversation,
): string[] {
  const issues: string[] = [];
  if (conversation.ticket_id !== undefined && String(conversation.ticket_id) !== String(ticketId)) issues.push("ticket_id");
  if (!sameText(payload.body, conversation.body, conversation.body_text)) issues.push("body");
  if (conversation.private !== (action === "private_note")) issues.push("private");
  for (const [requested, returned] of [["notify_emails", "notified_to"], ["cc_emails", "cc_emails"], ["bcc_emails", "bcc_emails"]] as const) {
    if (payload[requested] !== undefined && !sameSet(payload[requested], conversation[returned], true)) {
      issues.push(requested);
    }
  }
  if (payload.from_email !== undefined && String(conversation.from_email ?? "").toLowerCase() !== String(payload.from_email).toLowerCase()) {
    issues.push("from_email");
  }
  return issues;
}
