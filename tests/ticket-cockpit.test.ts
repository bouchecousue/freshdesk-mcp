import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { TICKET_COCKPIT_HTML, TICKET_COCKPIT_URI } from "../src/mcp/ticket-cockpit.js";

describe("Ticket Cockpit MCP App lifecycle", () => {
  it("uses a cache-busting resource URI and completes the view initialization handshake", async () => {
    expect(TICKET_COCKPIT_URI).toBe("ui://freshdesk/ticket-cockpit-v3.html");

    const script = TICKET_COCKPIT_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    const messages: Array<Record<string, unknown>> = [];
    let messageHandler: ((event: { source: unknown; data: Record<string, unknown> }) => void) | undefined;
    const parent = {
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    };
    const app = {
      innerHTML: "",
      setAttribute() {},
    };
    const window = {
      parent,
      addEventListener(type: string, handler: typeof messageHandler) {
        if (type === "message") messageHandler = handler;
      },
    };

    runInNewContext(script!, {
      window,
      document: {
        documentElement: { lang: "fr-FR" },
        getElementById: () => app,
      },
      Array,
      Date,
      Intl,
      Map,
      Number,
      Object,
      Promise,
      String,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        appInfo: { name: "freshdesk-ticket-cockpit", version: "0.3.4" },
        appCapabilities: { availableDisplayModes: ["inline"] },
        protocolVersion: "2026-01-26",
      },
    });

    expect(messageHandler).toBeDefined();
    messageHandler!({
      source: parent,
      data: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "test-host", version: "1.0.0" },
          hostCapabilities: {},
          hostContext: {},
        },
      },
    });
    await Promise.resolve();

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
    });
  });
});
