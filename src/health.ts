/** GET /healthz for Docker's health check: is Discord connected, and how busy is the bot. */
import http from "node:http";
import type { Client } from "discord.js";
import { log } from "./core/logger.js";

export function startHealthServer(port: number, client: Client, stats: () => Record<string, unknown>): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url?.split("?")[0] !== "/healthz") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    const ready = client.isReady();
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: ready, discord: ready ? "connected" : "connecting", ...stats() }));
  });
  server.on("error", (err) => log.error(`health: ${err.message}`));
  server.listen(port, () => log.info(`health: listening on :${port}/healthz`));
  return server;
}
