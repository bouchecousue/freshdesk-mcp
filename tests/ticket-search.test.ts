import { describe, expect, it } from "vitest";

import { buildStructuredTicketSearchQuery, hasStructuredTicketSearch } from "../src/mcp/ticket-search.js";

describe("structured Freshdesk ticket search", () => {
  it("builds a bounded query from documented Freshdesk fields", () => {
    const query = buildStructuredTicketSearchQuery({
      statuses: [2, 3],
      priorities: [4],
      groupIds: [9],
      unassigned: true,
      tags: ["vip"],
      updatedFrom: "2026-10-01",
      updatedTo: "2026-10-27",
    });

    expect(query).toBe("(status:2 OR status:3) AND priority:4 AND group_id:9 AND agent_id:null AND tag:'vip' AND updated_at:>'2026-10-01' AND updated_at:<'2026-10-27'");
    expect(query.length).toBeLessThanOrEqual(512);
  });

  it("rejects contradictory assignment and unsafe quoted values", () => {
    expect(() => buildStructuredTicketSearchQuery({ unassigned: true, agentIds: [42] })).toThrow(/cannot be combined/);
    expect(() => buildStructuredTicketSearchQuery({ tags: ["vip' OR status:5"] })).toThrow(/cannot contain quotes/);
    expect(hasStructuredTicketSearch({})).toBe(false);
  });
});
