#!/usr/bin/env node
import { startObservabilityApi } from "./api.js";

const rawPort = process.env.CCE_OBSERVABILITY_PORT;
const port = rawPort === undefined ? 8765 : Number(rawPort);

try {
  const api = await startObservabilityApi({ port });
  process.stdout.write(`CCE observability API: ${api.url}\n`);
  const shutdown = async () => {
    try { await api.close(); }
    catch (error) {
      process.stderr.write(`CCE observability API shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  process.stderr.write(`CCE observability API startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
