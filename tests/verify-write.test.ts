import { describe, expect, it } from "vitest";

import { verifyConversationFields, verifyTicketFields } from "../src/freshdesk/verify-write.js";

describe("Freshdesk readback verification", () => {
  it("requires the changed fields on the requested ticket", () => {
    expect(verifyTicketFields(123, { status: 3, priority: 4 }, { id: 123, status: 2 })).toEqual(["status", "priority"]);
    expect(verifyTicketFields(123, { status: 3 }, { id: 124, status: 3 })).toEqual(["ticket_id"]);
    expect(verifyTicketFields(123, { tags: ["one", "two"] }, { id: 123, tags: ["two", "one"] })).toEqual([]);
  });

  it("checks the created ticket requester and normalized description", () => {
    expect(verifyTicketFields(123, { email: "alice@example.com", description: "<p>Hello &amp; bye</p>" }, {
      id: 123, requester: { id: 1, email: "Alice@example.com" }, description: "<div>Hello &amp; bye</div>",
    })).toEqual([]);
  });

  it("requires message content, privacy and all requested notification recipients", () => {
    const payload = { body: "<p>Hello</p>", notify_emails: ["agent@example.com"] };
    expect(verifyConversationFields(123, "private_note", payload, { id: 1, body: "<div>Hello</div>", private: true,
      ticket_id: 123, notified_to: ["AGENT@example.com"] })).toEqual([]);
    expect(verifyConversationFields(123, "private_note", payload, { id: 1, body_text: "Changed", private: false }))
      .toEqual(["body", "private", "notify_emails"]);
  });

  it("does not truncate content or ignore a changed link when comparing", () => {
    const long = "a".repeat(21_000);
    expect(verifyConversationFields(123, "reply", { body: `<p>${long}old</p>` }, {
      id: 1, body: `<p>${long}new</p>`, private: false,
    })).toContain("body");
    expect(verifyConversationFields(123, "reply", { body: '<a href="https://one.example">Link</a>' }, {
      id: 1, body: '<a href="https://two.example">Link</a>', private: false,
    })).toContain("body");
  });

  it("leaves hidden BCC fields unverified", () => {
    expect(verifyConversationFields(123, "reply", { body: "Hello", bcc_emails: ["agent@example.com"] }, {
      id: 1, body_text: "Hello", private: false,
    })).toEqual(["bcc_emails"]);
  });
});
