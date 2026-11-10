import { describe, expect, it } from "vitest";

import { publicCompany, publicConversation } from "../src/freshdesk/sanitize.js";
import { verifyConversationFields } from "../src/freshdesk/verify-write.js";

describe("Freshdesk HTML conversion", () => {
  it("keeps useful text while omitting image and link targets", () => {
    const company = publicCompany({
      id: 1,
      note: '<p>Bonjour&nbsp;<strong>équipe</strong></p><p><img src="https://example.com/private.png" alt="secret">Consultez <a href="https://example.com/private">le guide</a>.</p>',
    });

    expect(company.note).toBe("Bonjour équipe\n\nConsultez le guide.");
  });

  it("drops script and style content from Freshdesk conversations", () => {
    const conversation = publicConversation({
      id: 2,
      body: "<div>Texte <script>alert(1)</script><style>.x{color:red}</style>final</div>",
    });

    expect(conversation.bodyText).toBe("Texte final");
  });

  it("keeps readback verification stable across equivalent HTML and entities", () => {
    expect(verifyConversationFields(123, "reply", { body: "<p>Bonjour &amp; au revoir</p>" }, {
      id: 3,
      ticket_id: 123,
      body: "<div>Bonjour & au revoir</div>",
      private: false,
    })).toEqual([]);
  });
});
