import { describe, expect, it, vi } from "vitest";
import { readBoundedBody } from "../src/http-body.js";
import { Logger } from "../src/logger.js";

describe("Bounded transport and logs", () => {
  it("cancels a stream immediately when the byte cap is reached", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel,
    });
    await expect(readBoundedBody(new Response(stream), 5)).rejects.toThrow(/byte limit/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reads valid UTF-8 across chunks", async () => {
    const bytes = Buffer.from("été");
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 1)); controller.enqueue(bytes.subarray(1)); controller.close();
    } });
    expect((await readBoundedBody(new Response(stream), bytes.length)).toString()).toBe("été");
  });

  it("redacts nested secrets and exception messages", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      new Logger().warn("test", { error: new Error("credential-value"), nested: { apiKey: "credential-value", body: "message-value" } });
      const value = String(output.mock.calls[0]?.[0]);
      expect(value).not.toContain("credential-value");
      expect(value).not.toContain("message-value");
      expect(value).toContain('"name":"Error"');
    } finally { output.mockRestore(); }
  });
});
