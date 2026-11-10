import { serve } from "@hono/node-server";

import { createFreshdeskMcpApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";

const logger = new Logger();
const config = loadConfig();
const service = createFreshdeskMcpApp(config, { logger });
const nodeServer = serve({ fetch: service.app.fetch, hostname: config.host, port: config.port }, (info) => {
  logger.info("server_started", {
    localAddress: `http://${config.host}:${info.port}`,
    publicUrl: config.publicUrl.origin,
    mcpEndpoint: config.resourceUrl.href,
  });
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("server_stopping", { signal });
  nodeServer.close();
  await service.close();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void stop(signal).finally(() => process.exit(0));
  });
}
