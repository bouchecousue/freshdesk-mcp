type LogLevel = "info" | "warn" | "error";

const sensitiveKey = /api.?key|authorization|cookie|secret|token|body|content|description/i;

function clean(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  // Library errors may embed credentials, URLs or response bodies in their message.
  if (value instanceof Error) return { name: value.name };
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => clean(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = sensitiveKey.test(key) ? "[redacted]" : clean(child, depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export class Logger {
  constructor(private readonly service = "freshdesk-mcp") {}

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    const record = clean({ timestamp: new Date().toISOString(), level, service: this.service, event, ...fields });
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}
