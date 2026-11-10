import { readBoundedBody, ResponseTooLargeError } from "../http-body.js";
import type {
  FreshdeskAccount,
  FreshdeskAgent,
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
  RateLimitSnapshot,
  TicketAggregate,
} from "./types.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const TRANSIENT_READ_STATUSES = new Set([429, 502, 503, 504]);
export const TICKET_HISTORY_START = "1970-01-01T00:00:00Z";

export class FreshdeskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly rateLimit: RateLimitSnapshot,
  ) {
    super(message);
    this.name = "FreshdeskApiError";
  }
}

export function normalizeFreshdeskOrigin(value: string, allowUnsafeTestOrigin = false): string {
  const trimmed = value.trim().toLowerCase().replace(/\/+$/, "");
  const candidate = trimmed.includes("://")
    ? trimmed
    : trimmed.endsWith(".freshdesk.com")
      ? `https://${trimmed}`
      : `https://${trimmed}.freshdesk.com`;
  const url = new URL(candidate);
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Freshdesk domain must be a native HTTPS origin without a path, port, or credentials");
  }
  if (allowUnsafeTestOrigin && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return url.origin;
  if (url.protocol !== "https:" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.freshdesk\.com$/.test(url.hostname)) {
    throw new Error("Freshdesk domain must match https://<tenant>.freshdesk.com");
  }
  return url.origin;
}

function ensureRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Freshdesk ${label} response`);
  return value as Record<string, unknown>;
}

function ensureArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    throw new Error(`Invalid Freshdesk ${label} response`);
  }
  return value as Record<string, unknown>[];
}

function optionalHeaderInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function rateLimitFromHeaders(headers: Headers): RateLimitSnapshot {
  const snapshot: RateLimitSnapshot = {};
  const total = optionalHeaderInt(headers, "x-ratelimit-total");
  const remaining = optionalHeaderInt(headers, "x-ratelimit-remaining");
  const used = optionalHeaderInt(headers, "x-ratelimit-used-currentrequest");
  let retryAfter = optionalHeaderInt(headers, "retry-after");
  if (retryAfter === undefined && headers.has("retry-after")) {
    const retryAt = Date.parse(headers.get("retry-after") ?? "");
    if (Number.isFinite(retryAt)) retryAfter = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
  }
  if (total !== undefined) snapshot.total = total;
  if (remaining !== undefined) snapshot.remaining = remaining;
  if (used !== undefined) snapshot.usedCurrentRequest = used;
  if (retryAfter !== undefined) snapshot.retryAfterSeconds = retryAfter;
  return snapshot;
}

function safeErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") return "freshdesk_error";
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && /^[a-z0-9_-]{1,80}$/i.test(code) ? code : "freshdesk_error";
}

export interface FreshdeskClientOptions {
  origin: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxReadRetries?: number;
  allowUnsafeTestOrigin?: boolean;
}

export class FreshdeskClient {
  readonly origin: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #maxReadRetries: number;

  constructor(options: FreshdeskClientOptions) {
    this.origin = normalizeFreshdeskOrigin(options.origin, options.allowUnsafeTestOrigin);
    if (!options.apiKey || options.apiKey.length > 1_000) throw new Error("Invalid Freshdesk API key");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchFn ?? fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxReadRetries = options.maxReadRetries ?? 2;
  }

  ticketUrl(ticketId: number | string): string {
    return `${this.origin}/a/tickets/${encodeURIComponent(String(ticketId))}`;
  }

  async getAccount(): Promise<FreshdeskAccount> {
    return ensureRecord(await this.request("GET", "/account"), "account") as FreshdeskAccount;
  }

  async getMe(): Promise<FreshdeskAgent> {
    const value = ensureRecord(await this.request("GET", "/agents/me"), "agent");
    if (typeof value.id !== "number" && typeof value.id !== "string") throw new Error("Invalid Freshdesk agent response");
    return value as unknown as FreshdeskAgent;
  }

  async listAgents(page = 1, perPage = 100): Promise<FreshdeskAgent[]> {
    return ensureArray(await this.request("GET", "/agents", { page, per_page: perPage }), "agents") as unknown as FreshdeskAgent[];
  }

  async listGroups(page = 1, perPage = 100): Promise<FreshdeskGroup[]> {
    return ensureArray(await this.request("GET", "/groups", { page, per_page: perPage }), "groups") as FreshdeskGroup[];
  }

  async listTicketFields(): Promise<FreshdeskTicketField[]> {
    return ensureArray(await this.request("GET", "/ticket_fields"), "ticket fields") as FreshdeskTicketField[];
  }

  async getContact(contactId: number): Promise<FreshdeskContact> {
    return ensureRecord(await this.request("GET", `/contacts/${contactId}`), "contact") as FreshdeskContact;
  }

  async searchContacts(input: {
    email?: string;
    term?: string;
    phone?: string;
    companyId?: number;
    page?: number;
    perPage?: number;
  }): Promise<FreshdeskContact[]> {
    if (input.term) {
      return ensureArray(await this.request("GET", "/contacts/autocomplete", { term: input.term }), "contacts") as FreshdeskContact[];
    }
    const data = await this.request("GET", "/contacts", {
      email: input.email,
      phone: input.phone,
      company_id: input.companyId,
      page: input.page ?? 1,
      per_page: input.perPage ?? 30,
    });
    return ensureArray(data, "contacts") as FreshdeskContact[];
  }

  async getCompany(companyId: number): Promise<FreshdeskCompany> {
    return ensureRecord(await this.request("GET", `/companies/${companyId}`), "company") as FreshdeskCompany;
  }

  async searchCompanies(input: { name?: string; domain?: string; page?: number }): Promise<{
    companies: FreshdeskCompany[];
    endpointStability: "stable" | "beta";
    total?: number;
  }> {
    if (input.domain) {
      const data = ensureRecord(
        await this.request("GET", "/search/companies", { query: `\"domain:'${input.domain}'\"`, page: input.page ?? 1 }),
        "company search",
      );
      const companies = ensureArray(data.results ?? [], "company search results") as FreshdeskCompany[];
      const result: { companies: FreshdeskCompany[]; endpointStability: "beta"; total?: number } = {
        companies,
        endpointStability: "beta",
      };
      if (typeof data.total === "number") result.total = data.total;
      return result;
    }
    const data = ensureRecord(await this.request("GET", "/companies/autocomplete", { name: input.name ?? "" }), "companies");
    const companies = ensureArray(data.companies ?? data, "companies") as FreshdeskCompany[];
    return { companies, endpointStability: "stable" };
  }

  async listIndexTickets(page = 1, orderBy: "created_at" | "updated_at" = "created_at"): Promise<FreshdeskTicket[]> {
    return ensureArray(await this.request("GET", "/tickets", {
      updated_since: TICKET_HISTORY_START, page, per_page: 100, order_by: orderBy, order_type: "desc", include: "description",
    }), "index tickets") as FreshdeskTicket[];
  }

  async listChangedIndexTickets(updatedSince: string, page = 1): Promise<FreshdeskTicket[]> {
    return ensureArray(await this.request("GET", "/tickets", {
      updated_since: updatedSince, page, per_page: 100, order_by: "updated_at", order_type: "asc", include: "description",
    }), "changed index tickets") as FreshdeskTicket[];
  }

  async getHistoricalTicket(ticketId: number): Promise<FreshdeskTicket> {
    try { return ensureRecord(await this.request("GET", `/tickets/${ticketId}`), "historical ticket") as FreshdeskTicket; }
    catch (error) {
      if (!(error instanceof FreshdeskApiError) || error.status !== 404) throw error;
      return ensureRecord(await this.request("GET", `/tickets/archived/${ticketId}`), "archived ticket") as FreshdeskTicket;
    }
  }

  async historicalConversations(ticketId: number, archived = false): Promise<FreshdeskConversation[]> {
    const result: FreshdeskConversation[] = [];
    for (let page = 1; page <= 300; page++) {
      const batch = ensureArray(await this.request("GET", `/tickets/${archived ? "archived/" : ""}${ticketId}/conversations`, { page, per_page: 100 }), "conversations") as FreshdeskConversation[];
      result.push(...batch);
      // Freshdesk conversation endpoints may ignore per_page and return 30.
      if (batch.length < 30) return result;
    }
    throw new Error("Conversation pagination limit reached");
  }

  async getTicket(ticketId: number): Promise<FreshdeskTicket> {
    return ensureRecord(
      await this.request("GET", `/tickets/${ticketId}`, { include: "requester,company,stats" }),
      "ticket",
    ) as FreshdeskTicket;
  }

  async listConversations(ticketId: number, maxPages = 5): Promise<{ conversations: FreshdeskConversation[]; truncated: boolean }> {
    const conversations: FreshdeskConversation[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = ensureArray(await this.request("GET", `/tickets/${ticketId}/conversations`, { page }), "conversations") as FreshdeskConversation[];
      conversations.push(...batch);
      if (batch.length < 30) return { conversations, truncated: false };
    }
    return { conversations, truncated: true };
  }

  async listTimeEntries(ticketId: number, maxPages = 3): Promise<{ timeEntries: FreshdeskTimeEntry[]; truncated: boolean }> {
    const timeEntries: FreshdeskTimeEntry[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = ensureArray(
        await this.request("GET", `/tickets/${ticketId}/time_entries`, { page, per_page: 100 }),
        "time entries",
      ) as FreshdeskTimeEntry[];
      timeEntries.push(...batch);
      if (batch.length < 100) return { timeEntries, truncated: false };
    }
    return { timeEntries, truncated: true };
  }

  async listSatisfactionRatings(ticketId: number): Promise<FreshdeskSatisfactionRating[]> {
    return ensureArray(
      await this.request("GET", `/tickets/${ticketId}/satisfaction_ratings`),
      "satisfaction ratings",
    ) as FreshdeskSatisfactionRating[];
  }

  async searchSolutionArticles(term: string): Promise<FreshdeskSolutionArticle[]> {
    return ensureArray(await this.request("GET", "/search/solutions", { term }), "solution articles") as FreshdeskSolutionArticle[];
  }

  async listCannedResponseFolders(): Promise<FreshdeskCannedResponseFolder[]> {
    return ensureArray(await this.request("GET", "/canned_response_folders"), "canned response folders") as FreshdeskCannedResponseFolder[];
  }

  async listCannedResponses(folderId: number): Promise<FreshdeskCannedResponse[]> {
    const data = await this.request("GET", `/canned_response_folders/${folderId}/responses`);
    const values = Array.isArray(data) ? data : ensureRecord(data, "canned responses").responses ?? [];
    return ensureArray(values, "canned responses") as FreshdeskCannedResponse[];
  }

  async searchTickets(input: { query?: string; filter?: string; requesterId?: number; companyId?: number; page?: number; perPage?: number }): Promise<{
    tickets: FreshdeskTicket[];
    total?: number;
    countState: "exact" | "lower_bound" | "truncated";
    hasMore: boolean;
    nextPage: number | null;
    pageSize: number;
  }> {
    if (input.query) {
      if ((input.page ?? 1) > 10) throw new Error("Freshdesk search is limited to 10 pages");
      const data = ensureRecord(
        await this.request("GET", "/search/tickets", { query: `\"${input.query}\"`, page: input.page ?? 1 }),
        "ticket search",
      );
      const rawTickets = ensureArray(data.results ?? [], "ticket search results") as FreshdeskTicket[];
      const page = input.page ?? 1;
      const pageSize = 30;
      const result: { tickets: FreshdeskTicket[]; total?: number; countState: "exact" | "lower_bound" | "truncated"; hasMore: boolean; nextPage: number | null; pageSize: number } = {
        tickets: rawTickets,
        countState: "lower_bound",
        hasMore: false,
        nextPage: null,
        pageSize,
      };
      if (typeof data.total === "number") result.total = data.total;
      result.hasMore = page < 10 && (result.total !== undefined ? page * pageSize < result.total : rawTickets.length === pageSize);
      result.nextPage = result.hasMore ? page + 1 : null;
      result.countState = page === 1 && result.total === rawTickets.length ? "exact" : "lower_bound";
      if (result.tickets.length > (input.perPage ?? 30)) {
        result.tickets = result.tickets.slice(0, input.perPage ?? 30);
        result.countState = "truncated";
      }
      return result;
    }
    const tickets = ensureArray(
      await this.request("GET", "/tickets", {
        filter: input.filter,
        requester_id: input.requesterId,
        company_id: input.companyId,
        updated_since: TICKET_HISTORY_START,
        page: input.page ?? 1,
        per_page: input.perPage ?? 30,
        order_by: "updated_at",
        order_type: "desc",
      }),
      "tickets",
    ) as FreshdeskTicket[];
    const page = input.page ?? 1;
    const pageSize = input.perPage ?? 30;
    const hasMore = page < 300 && tickets.length === pageSize;
    return {
      tickets,
      countState: page === 1 && !hasMore ? "exact" : "lower_bound",
      hasMore,
      nextPage: hasMore ? page + 1 : null,
      pageSize,
    };
  }

  async aggregateRequesterTickets(requesterId: number, maxPages = 5, recentLimit = 20): Promise<TicketAggregate> {
    return this.aggregateTickets({ requester_id: requesterId }, maxPages, recentLimit);
  }

  async aggregateCompanyTickets(companyId: number, maxPages = 5, recentLimit = 20): Promise<TicketAggregate> {
    return this.aggregateTickets({ company_id: companyId }, maxPages, recentLimit);
  }

  private async aggregateTickets(selector: Record<string, number>, maxPages: number, recentLimit: number): Promise<TicketAggregate> {
    const byId = new Map<string, FreshdeskTicket>();
    let repeatedId = false;
    let scannedPages = 0;
    let exact = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = ensureArray(
        await this.request("GET", "/tickets", {
          ...selector,
          updated_since: TICKET_HISTORY_START,
          page,
          per_page: 100,
          order_by: "updated_at",
          order_type: "desc",
        }),
        "tickets",
      ) as FreshdeskTicket[];
      scannedPages = page;
      for (const ticket of batch) {
        const id = String(ticket.id);
        if (byId.has(id)) repeatedId = true;
        byId.set(id, ticket);
      }
      if (batch.length < 100) {
        exact = !repeatedId;
        break;
      }
    }
    const byStatus: Record<string, number> = {};
    const tickets = [...byId.values()];
    for (const ticket of tickets) {
      const status = String(ticket.status ?? "unknown");
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    tickets.sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
    return {
      total: tickets.length,
      byStatus,
      countState: exact ? "exact" : "lower_bound",
      tickets: tickets.slice(0, recentLimit),
      scannedTickets: tickets,
      scannedPages,
    };
  }

  async createTicket(payload: Record<string, unknown>): Promise<FreshdeskTicket> {
    return ensureRecord(await this.request("POST", "/tickets", undefined, payload), "ticket") as FreshdeskTicket;
  }

  async updateTicket(ticketId: number, payload: Record<string, unknown>): Promise<FreshdeskTicket> {
    return ensureRecord(await this.request("PUT", `/tickets/${ticketId}`, undefined, payload), "ticket") as FreshdeskTicket;
  }

  async addNote(ticketId: number, payload: Record<string, unknown>): Promise<FreshdeskConversation> {
    return ensureRecord(await this.request("POST", `/tickets/${ticketId}/notes`, undefined, payload), "conversation") as FreshdeskConversation;
  }

  async reply(ticketId: number, payload: Record<string, unknown>): Promise<FreshdeskConversation> {
    return ensureRecord(await this.request("POST", `/tickets/${ticketId}/reply`, undefined, payload), "conversation") as FreshdeskConversation;
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    apiPath: string,
    query?: Record<string, string | number | undefined>,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!apiPath.startsWith("/") || apiPath.includes("..")) throw new Error("Invalid Freshdesk API path");
    const url = new URL(`/api/v2${apiPath}`, this.origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (url.origin !== this.origin) throw new Error("Freshdesk request escaped the configured origin");
    const attempts = method === "GET" ? this.#maxReadRetries + 1 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${this.#apiKey}:X`, "utf8").toString("base64")}`,
      });
      let body: string | undefined;
      if (payload !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(payload);
      }
      let response: Response;
      try {
        const requestInit: RequestInit = {
          method,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(this.#timeoutMs),
        };
        if (body !== undefined) requestInit.body = body;
        response = await this.#fetch(url, requestInit);
      } catch {
        if (method === "GET" && attempt < attempts) {
          await this.#sleep(100 * attempt);
          continue;
        }
        throw new FreshdeskApiError("Freshdesk network error", 0, "network_error", {});
      }
      const rateLimit = rateLimitFromHeaders(response.headers);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new FreshdeskApiError("Freshdesk redirects are refused", response.status, "redirect_refused", rateLimit);
      }
      if (method === "GET" && TRANSIENT_READ_STATUSES.has(response.status) && attempt < attempts) {
        // Long server delays are returned to the caller, never shortened into an early retry.
        const delaySeconds = rateLimit.retryAfterSeconds ?? attempt;
        if (delaySeconds <= 10) {
          await response.body?.cancel();
          await this.#sleep(delaySeconds * 1_000);
          continue;
        }
      }
      let buffer: Buffer;
      try {
        buffer = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        throw new FreshdeskApiError(
          "Freshdesk response could not be read",
          error instanceof ResponseTooLargeError ? response.status : 0,
          error instanceof ResponseTooLargeError ? "response_too_large" : "network_error",
          rateLimit,
        );
      }
      let data: unknown = null;
      if (buffer.length > 0) {
        try {
          data = JSON.parse(buffer.toString("utf8"));
        } catch {
          if (response.ok) throw new FreshdeskApiError("Freshdesk returned invalid JSON", response.status, "invalid_json", rateLimit);
        }
      }
      if (response.ok) return data;
      throw new FreshdeskApiError(`Freshdesk request failed with status ${response.status}`, response.status, safeErrorCode(data), rateLimit);
    }
    throw new FreshdeskApiError("Freshdesk request failed", 0, "network_error", {});
  }
}
