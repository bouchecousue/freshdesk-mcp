import { convert } from "html-to-text";

import type {
  FreshdeskAgent,
  FreshdeskAttachment,
  FreshdeskCannedResponse,
  FreshdeskCannedResponseFolder,
  FreshdeskCompany,
  FreshdeskContact,
  FreshdeskConversation,
  FreshdeskGroup,
  FreshdeskSatisfactionRating,
  FreshdeskSolutionArticle,
  FreshdeskTicket,
  FreshdeskTicketField,
  FreshdeskTimeEntry,
} from "./types.js";
import { ticketPriorityLabel, ticketSourceLabel, ticketStatusLabel } from "./labels.js";

function plainText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const text = convert(value, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  })
    .replaceAll("\u0000", "")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function safeCustomFields(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
  return Object.fromEntries(
    entries.map(([key, child]) => {
      if (child === null || typeof child === "boolean" || typeof child === "number") return [key, child];
      if (typeof child === "string") return [key, child.slice(0, 500)];
      if (Array.isArray(child)) return [key, child.slice(0, 20).map((item) => String(item).slice(0, 200))];
      return [key, "[complex value omitted]"];
    }),
  );
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function publicAttachment(attachment: FreshdeskAttachment): Record<string, unknown> {
  return {
    id: attachment.id === undefined || attachment.id === null ? null : String(attachment.id),
    name: typeof attachment.name === "string" ? attachment.name.slice(0, 500) : null,
    contentType: typeof attachment.content_type === "string" ? attachment.content_type.slice(0, 200) : null,
    sizeBytes: typeof attachment.size === "number" && attachment.size >= 0 ? attachment.size : null,
    url: safeHttpsUrl(attachment.attachment_url),
    createdAt: attachment.created_at ?? null,
  };
}

export function publicContact(contact: FreshdeskContact): Record<string, unknown> {
  return {
    id: contact.id,
    name: contact.name ?? null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
    mobile: contact.mobile ?? null,
    companyId: contact.company_id ?? null,
    jobTitle: contact.job_title ?? null,
    active: contact.active ?? null,
    createdAt: contact.created_at ?? null,
    updatedAt: contact.updated_at ?? null,
    customFields: safeCustomFields(contact.custom_fields),
  };
}

export function publicCompany(company: FreshdeskCompany): Record<string, unknown> {
  return {
    id: company.id,
    name: company.name ?? null,
    domains: Array.isArray(company.domains) ? company.domains.slice(0, 25) : [],
    note: plainText(company.note, 4_000),
    healthScore: company.health_score ?? null,
    accountTier: company.account_tier ?? null,
    renewalDate: company.renewal_date ?? null,
    createdAt: company.created_at ?? null,
    updatedAt: company.updated_at ?? null,
    customFields: safeCustomFields(company.custom_fields),
  };
}

export function publicTicket(ticket: FreshdeskTicket, agentUrl?: string): Record<string, unknown> {
  return {
    id: ticket.id,
    subject: ticket.subject ?? null,
    descriptionText: plainText(ticket.description_text, 12_000),
    status: ticket.status ?? null,
    statusLabel: ticketStatusLabel(ticket.status),
    priority: ticket.priority ?? null,
    priorityLabel: ticketPriorityLabel(ticket.priority),
    source: ticket.source ?? null,
    sourceLabel: ticketSourceLabel(ticket.source),
    type: ticket.type ?? null,
    requesterId: ticket.requester_id ?? null,
    responderId: ticket.responder_id ?? null,
    groupId: ticket.group_id ?? null,
    companyId: ticket.company_id ?? null,
    tags: Array.isArray(ticket.tags) ? ticket.tags.slice(0, 100) : [],
    createdAt: ticket.created_at ?? null,
    updatedAt: ticket.updated_at ?? null,
    dueBy: ticket.due_by ?? null,
    firstResponseDueBy: ticket.fr_due_by ?? null,
    escalated: ticket.is_escalated ?? false,
    customFields: safeCustomFields(ticket.custom_fields),
    requester: ticket.requester ? publicContact(ticket.requester) : null,
    company: ticket.company ? publicCompany(ticket.company) : null,
    stats: ticket.stats ?? null,
    attachments: Array.isArray(ticket.attachments) ? ticket.attachments.slice(0, 25).map(publicAttachment) : [],
    freshdeskUrl: agentUrl ?? null,
  };
}

export function publicTicketSummary(ticket: FreshdeskTicket, agentUrl?: string): Record<string, unknown> {
  return {
    id: ticket.id,
    subject: ticket.subject ?? null,
    status: ticket.status ?? null,
    statusLabel: ticketStatusLabel(ticket.status),
    priority: ticket.priority ?? null,
    priorityLabel: ticketPriorityLabel(ticket.priority),
    source: ticket.source ?? null,
    sourceLabel: ticketSourceLabel(ticket.source),
    type: ticket.type ?? null,
    requesterId: ticket.requester_id ?? null,
    responderId: ticket.responder_id ?? null,
    groupId: ticket.group_id ?? null,
    companyId: ticket.company_id ?? null,
    createdAt: ticket.created_at ?? null,
    updatedAt: ticket.updated_at ?? null,
    dueBy: ticket.due_by ?? null,
    firstResponseDueBy: ticket.fr_due_by ?? null,
    escalated: ticket.is_escalated ?? false,
    freshdeskUrl: agentUrl ?? null,
  };
}

export function publicConversation(conversation: FreshdeskConversation, maxBodyLength = 20_000): Record<string, unknown> {
  return {
    id: conversation.id,
    bodyText: plainText(conversation.body_text ?? conversation.body, maxBodyLength),
    private: conversation.private ?? null,
    incoming: conversation.incoming ?? null,
    source: conversation.source ?? null,
    userId: conversation.user_id ?? null,
    supportEmail: conversation.support_email ?? null,
    fromEmail: conversation.from_email ?? null,
    toEmails: Array.isArray(conversation.to_emails) ? conversation.to_emails.slice(0, 50) : [],
    ccEmails: Array.isArray(conversation.cc_emails) ? conversation.cc_emails.slice(0, 50) : [],
    bccEmails: Array.isArray(conversation.bcc_emails) ? conversation.bcc_emails.slice(0, 50) : null,
    notifiedTo: Array.isArray(conversation.notified_to) ? conversation.notified_to.slice(0, 50) : null,
    createdAt: conversation.created_at ?? null,
    updatedAt: conversation.updated_at ?? null,
    attachments: Array.isArray(conversation.attachments) ? conversation.attachments.slice(0, 25).map(publicAttachment) : [],
  };
}

export function publicAgent(agent: FreshdeskAgent): Record<string, unknown> {
  return {
    id: String(agent.id),
    name: agent.contact?.name ?? null,
    email: agent.contact?.email ?? null,
    type: agent.type ?? null,
    ticketScope: agent.ticket_scope ?? null,
    available: agent.available ?? null,
    occasional: agent.occasional ?? null,
    active: agent.active ?? null,
    groupIds: Array.isArray(agent.group_ids) ? agent.group_ids.slice(0, 100).map(String) : [],
  };
}

export function publicGroup(group: FreshdeskGroup): Record<string, unknown> {
  return {
    id: String(group.id),
    name: group.name ?? null,
    description: plainText(group.description, 2_000),
    escalateTo: group.escalate_to === undefined || group.escalate_to === null ? null : String(group.escalate_to),
    unassignedFor: group.unassigned_for ?? null,
    agentIds: Array.isArray(group.agent_ids) ? group.agent_ids.slice(0, 50).map(String) : [],
    createdAt: group.created_at ?? null,
    updatedAt: group.updated_at ?? null,
  };
}

function safeChoices(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => String(item).slice(0, 200));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 25).map(([key, item]) => [
      key.slice(0, 100),
      Array.isArray(item) ? item.slice(0, 25).map((child) => String(child).slice(0, 200)) : String(item).slice(0, 200),
    ]));
  }
  return null;
}

export function publicTicketField(field: FreshdeskTicketField): Record<string, unknown> {
  return {
    id: String(field.id),
    name: field.name ?? null,
    label: field.label ?? null,
    customerLabel: field.label_for_customers ?? null,
    type: field.type ?? null,
    position: field.position ?? null,
    requiredForClosure: field.required_for_closure ?? null,
    requiredForAgents: field.required_for_agents ?? null,
    requiredForCustomers: field.required_for_customers ?? null,
    customersCanEdit: field.customers_can_edit ?? null,
    displayedToCustomers: field.displayed_to_customers ?? null,
    choices: safeChoices(field.choices),
  };
}

export function publicTimeEntry(entry: FreshdeskTimeEntry): Record<string, unknown> {
  return {
    id: String(entry.id),
    ticketId: entry.ticket_id === undefined || entry.ticket_id === null ? null : String(entry.ticket_id),
    agentId: entry.agent_id === undefined || entry.agent_id === null ? null : String(entry.agent_id),
    timeSpent: entry.time_spent ?? null,
    billable: entry.billable ?? null,
    note: plainText(entry.note, 2_000),
    executedAt: entry.executed_at ?? null,
    createdAt: entry.created_at ?? null,
    updatedAt: entry.updated_at ?? null,
  };
}

export function publicSatisfactionRating(rating: FreshdeskSatisfactionRating): Record<string, unknown> {
  return {
    id: rating.id === undefined || rating.id === null ? null : String(rating.id),
    surveyId: rating.survey_id === undefined || rating.survey_id === null ? null : String(rating.survey_id),
    agentId: rating.agent_id === undefined || rating.agent_id === null ? null : String(rating.agent_id),
    groupId: rating.group_id === undefined || rating.group_id === null ? null : String(rating.group_id),
    ticketId: rating.ticket_id === undefined || rating.ticket_id === null ? null : String(rating.ticket_id),
    feedback: plainText(rating.feedback, 4_000),
    ratings: safeCustomFields(rating.ratings),
    createdAt: rating.created_at ?? null,
    updatedAt: rating.updated_at ?? null,
  };
}

export function publicSolutionArticle(article: FreshdeskSolutionArticle): Record<string, unknown> {
  return {
    id: String(article.id),
    title: article.title ?? null,
    excerpt: plainText(article.description_text ?? article.description, 4_000),
    status: article.status ?? null,
    type: article.type ?? null,
    categoryId: article.category_id === undefined || article.category_id === null ? null : String(article.category_id),
    folderId: article.folder_id === undefined || article.folder_id === null ? null : String(article.folder_id),
    agentId: article.agent_id === undefined || article.agent_id === null ? null : String(article.agent_id),
    tags: Array.isArray(article.tags) ? article.tags.slice(0, 50).map((tag) => tag.slice(0, 200)) : [],
    thumbsUp: article.thumbs_up ?? null,
    thumbsDown: article.thumbs_down ?? null,
    hits: article.hits ?? null,
    createdAt: article.created_at ?? null,
    updatedAt: article.updated_at ?? null,
  };
}

export function publicCannedResponseFolder(folder: FreshdeskCannedResponseFolder): Record<string, unknown> {
  return {
    id: String(folder.id),
    name: folder.name ?? null,
    personal: folder.personal ?? null,
    responsesCount: folder.responses_count ?? null,
  };
}

export function publicCannedResponse(response: FreshdeskCannedResponse): Record<string, unknown> {
  return {
    id: String(response.id),
    title: response.title ?? null,
    folderId: response.folder_id === undefined || response.folder_id === null ? null : String(response.folder_id),
    excerpt: plainText(response.content ?? response.content_html, 4_000),
    createdAt: response.created_at ?? null,
    updatedAt: response.updated_at ?? null,
    attachments: Array.isArray(response.attachments) ? response.attachments.slice(0, 25).map(publicAttachment) : [],
  };
}
