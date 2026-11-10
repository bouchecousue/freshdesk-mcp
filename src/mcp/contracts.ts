import { z } from "zod";

const jsonObject = z.record(z.string(), z.json());
const nullableJsonObject = jsonObject.nullable();
const countState = z.enum(["exact", "lower_bound", "truncated"]);
const correlationId = z.string().min(1);

export const outputSchemas = {
  health: z.object({ ok: z.boolean(), tenantOrigin: z.string(), agentId: z.string(), correlationId }).strict(),
  me: z.object({ agent: jsonObject, account: jsonObject, tenantOrigin: z.string(), correlationId }).strict(),
  contactSearch: z.object({ contacts: z.array(jsonObject), count: z.number().int(), countState, correlationId }).strict(),
  contactContext: z.object({ contact: jsonObject, company: nullableJsonObject, tickets: jsonObject, correlationId }).strict(),
  companySearch: z.object({ companies: z.array(jsonObject), count: z.number().int(), countState, total: z.number().int().optional(), endpointStability: z.enum(["stable", "beta"]), correlationId }).strict(),
  companyContext: z.object({ company: jsonObject, contacts: z.array(jsonObject), contactsCountState: countState, tickets: jsonObject, correlationId }).strict(),
  ticketSearch: z.object({ tickets: z.array(jsonObject), page: z.number().int(), pageCount: z.number().int(), pageSize: z.number().int(), updatedSince: z.string().optional(), countState, total: z.number().int().optional(), hasMore: z.boolean(), nextPage: z.number().int().nullable(), correlationId }).strict(),
  triage: z.object({ tickets: z.array(jsonObject), candidateCount: z.number().int(), returnedCount: z.number().int(), generatedAt: z.string(), filters: jsonObject, coverage: jsonObject, correlationId }).strict(),
  ticketContext: z.object({ ticket: jsonObject, conversations: z.array(jsonObject), conversationCount: z.number().int(), conversationCountState: countState, timeEntries: z.array(jsonObject), timeEntryCount: z.number().int(), timeEntryCountState: countState, satisfactionRatings: z.array(jsonObject), satisfactionCount: z.number().int(), satisfactionCountState: countState, customerHistory: nullableJsonObject, ownership: jsonObject, enrichment: jsonObject, untrustedContentNotice: z.string(), correlationId }).strict(),
  ticketContexts: z.object({
    contexts: z.array(jsonObject),
    failures: z.array(z.object({
      ticketId: z.number().int(),
      stage: z.enum(["input_validation", "authorization", "freshdesk_api", "network", "application"]),
      status: z.number().int().nullable(),
      code: z.string().nullable(),
      message: z.string(),
    }).strict()),
    requestedCount: z.number().int(),
    successCount: z.number().int(),
    failureCount: z.number().int(),
    correlationId,
  }).strict(),
  ticketFields: z.object({ fields: z.array(jsonObject), count: z.number().int(), countState, correlationId }).strict(),
  agents: z.object({ agents: z.array(jsonObject), page: z.number().int(), pageSize: z.number().int(), count: z.number().int(), countState, hasMore: z.boolean(), nextPage: z.number().int().nullable(), correlationId }).strict(),
  groups: z.object({ groups: z.array(jsonObject), page: z.number().int(), pageSize: z.number().int(), count: z.number().int(), countState, hasMore: z.boolean(), nextPage: z.number().int().nullable(), correlationId }).strict(),
  knowledge: z.object({ query: z.string(), articles: z.array(jsonObject), cannedResponses: z.array(jsonObject), sources: jsonObject, correlationId }).strict(),
  customer360: z.object({ subjectType: z.enum(["contact", "company"]), contact: nullableJsonObject, company: nullableJsonObject, contacts: z.array(jsonObject), brief: jsonObject, tickets: jsonObject, correlationId }).strict(),
  preparedAction: z.object({ writeApplied: z.literal(false), intentId: z.string(), preview: jsonObject, correlationId }).strict(),
  executedAction: z.object({ writeApplied: z.literal(true), readbackVerified: z.boolean(), action: z.string(), ticketId: z.number().int().nullable(), created: nullableJsonObject, readback: nullableJsonObject, conversationReadback: nullableJsonObject, verificationIssues: z.array(z.string()), correlationId }).strict(),
} as const;
