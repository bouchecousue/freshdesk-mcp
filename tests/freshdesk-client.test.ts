import { describe, expect, it } from "vitest";

import { FreshdeskApiError, FreshdeskClient, normalizeFreshdeskOrigin } from "../src/freshdesk/client.js";

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Freshdesk API client", () => {
  it("accepts only native Freshdesk HTTPS tenant origins", () => {
    expect(normalizeFreshdeskOrigin("Acme")).toBe("https://acme.freshdesk.com");
    expect(() => normalizeFreshdeskOrigin("https://evil.example.com")).toThrow();
    expect(() => normalizeFreshdeskOrigin("https://acme.freshdesk.com/path")).toThrow();
  });

  it("retries bounded transient reads", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = (async () => {
      calls += 1;
      return calls === 1 ? json({ code: "rate_limit" }, 429, { "retry-after": "1" }) : json({ id: 123, subject: "OK" });
    }) as typeof fetch;
    const client = new FreshdeskClient({
      origin: "acme",
      apiKey: "key",
      fetchFn,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(client.getTicket(123)).resolves.toMatchObject({ id: 123 });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("never retries Freshdesk writes", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return json({ code: "unavailable" }, 503);
    }) as typeof fetch;
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", fetchFn });

    await expect(client.updateTicket(123, { status: 3 })).rejects.toBeInstanceOf(FreshdeskApiError);
    expect(calls).toBe(1);
  });

  it("parses official company autocomplete and beta filter shapes", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/companies/autocomplete")) return json({ companies: [{ id: 1, name: "Acme" }] });
      return json({ total: 1, results: [{ id: 1, name: "Acme", domains: ["acme.example"] }] });
    }) as typeof fetch;
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", fetchFn });

    await expect(client.searchCompanies({ name: "Acme" })).resolves.toMatchObject({ companies: [{ id: 1 }] });
    await expect(client.searchCompanies({ domain: "acme.example" })).resolves.toMatchObject({
      companies: [{ id: 1 }],
      total: 1,
      endpointStability: "beta",
    });
  });
});


describe("Read coverage and transient responses", () => {
  it("retries an HTML gateway error before parsing JSON", async () => {
    let calls = 0;
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", sleep: async () => {}, fetchFn: (async () =>
      ++calls === 1 ? new Response("<h1>Bad Gateway</h1>", { status: 502 }) : json({ id: 1 })) as typeof fetch });
    await expect(client.getTicket(1)).resolves.toMatchObject({ id: 1 });
    expect(calls).toBe(2);
  });

  it("does not retry before a long Retry-After expires", async () => {
    let calls = 0;
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", sleep: async () => { throw new Error("unexpected sleep"); },
      fetchFn: (async () => { calls++; return json({}, 429, { "retry-after": "120" }); }) as typeof fetch });
    await expect(client.getTicket(1)).rejects.toMatchObject({ status: 429, rateLimit: { retryAfterSeconds: 120 } });
    expect(calls).toBe(1);
  });

  it("includes historical tickets and labels the later page as a lower bound", async () => {
    const urls: URL[] = [];
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", fetchFn: (async (input) => {
      urls.push(new URL(String(input))); return json([{ id: 1 }]);
    }) as typeof fetch });
    const aggregate = await client.aggregateCompanyTickets(42);
    expect(aggregate.countState).toBe("exact");
    expect(urls[0]?.searchParams.get("company_id")).toBe("42");
    expect(urls[0]?.searchParams.get("updated_since")).toBe("1970-01-01T00:00:00Z");
    await expect(client.searchTickets({ requesterId: 1, page: 2 })).resolves.toMatchObject({ countState: "lower_bound" });
  });

  it("distinguishes API-reported totals from actual search coverage", async () => {
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", fetchFn: (async () => json({ total: 3, results: [{ id: 1 }, { id: 2 }] })) as typeof fetch });
    await expect(client.searchTickets({ query: "status:2" })).resolves.toMatchObject({ total: 3, countState: "lower_bound" });
    await expect(client.searchTickets({ query: "status:2", perPage: 1 })).resolves.toMatchObject({ tickets: [{ id: 1 }], countState: "truncated" });
    await expect(client.searchTickets({ query: "status:2", page: 11 })).rejects.toThrow(/10 pages/);
  });

  it("deduplicates unstable pages without claiming completeness", async () => {
    let page = 0;
    const first = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, status: 2 }));
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", fetchFn: (async () => json(page++ === 0 ? first : [first[0]])) as typeof fetch });
    await expect(client.aggregateRequesterTickets(1)).resolves.toMatchObject({ total: 100, countState: "lower_bound", byStatus: { "2": 100 } });
  });
});

describe("Retry-After HTTP dates", () => {
  it("returns a long server deadline without retrying early", async () => {
    let calls = 0;
    const client = new FreshdeskClient({ origin: "acme", apiKey: "key", sleep: async () => { throw new Error("unexpected sleep"); },
      fetchFn: (async () => { calls++; return json({}, 429, { "retry-after": new Date(Date.now() + 120_000).toUTCString() }); }) as typeof fetch });
    await expect(client.getTicket(1)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1);
  });
});
