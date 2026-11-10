import type { MiddlewareHandler } from "hono";

interface RateLimitOptions {
  windowMs: number;
  limit: number;
  keyPrefix: string;
}

interface Counter {
  count: number;
  resetAt: number;
}

function clientAddress(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const counters = new Map<string, Counter>();
  return async (context, next) => {
    const now = Date.now();
    const key = `${options.keyPrefix}:${clientAddress(context.req.raw.headers)}`;
    const previous = counters.get(key);
    const counter = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : previous;
    counter.count += 1;
    counters.set(key, counter);

    if (counters.size > 10_000) {
      for (const [storedKey, stored] of counters) {
        if (stored.resetAt <= now) counters.delete(storedKey);
      }
    }

    const remaining = Math.max(0, options.limit - counter.count);
    context.header("RateLimit-Limit", String(options.limit));
    context.header("RateLimit-Remaining", String(remaining));
    context.header("RateLimit-Reset", String(Math.ceil(counter.resetAt / 1_000)));
    if (counter.count > options.limit) {
      const retryAfter = Math.max(1, Math.ceil((counter.resetAt - now) / 1_000));
      context.header("Retry-After", String(retryAfter));
      return context.json({ error: "too_many_requests", error_description: "Rate limit exceeded" }, 429);
    }
    await next();
  };
}
