/**
 * Entry point: config → store → library client → Discord client → features.
 * The music lives in Aurral (or another Subsonic server); the bot only keeps
 * which servers are approved and a few per-server settings.
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { createHash } from "node:crypto";
import { buildApp } from "./app.js";
import { inviteUrl } from "./commands/servers.js";
import { loadConfig } from "./config.js";
import { Store } from "./core/db.js";
import { setDefaultTimeout } from "./core/http.js";
import { log } from "./core/logger.js";
import { startHealthServer } from "./health.js";
import { DiscordVoiceLink } from "./player/voice.js";
import { SubsonicClient } from "./services/subsonic.js";

async function main() {
  const cfg = loadConfig();
  setDefaultTimeout(cfg.http.timeoutMs);
  const store = new Store(cfg.dataDir);
  const subsonic = new SubsonicClient(cfg.subsonic);
  // No privileged intents: servers (for approvals) and voice states (who's listening).
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const app = buildApp({ cfg, store, client, subsonic, link: () => new DiscordVoiceLink(subsonic) });
  const features = app.features;
  if (cfg.apex) log.info(`apex: stats are on (checking linked players every ${cfg.apex.pollMinutes} min; weeks start Monday in ${cfg.apex.timezone})`);

  client.once(Events.ClientReady, async (c) => {
    log.info(`discord: logged in as ${c.user.tag}`);
    log.info(`discord: invite link for your friends' servers: ${inviteUrl(c.application.id)}`);
    const owner = await app.servers.ownerId();
    log.info(owner ? `servers: approval requests go to Discord user ${owner}` : "servers: couldn't work out the owner; set OWNER_ID so approval requests reach you");
    subsonic
      .health()
      .then(() => log.info(`music: connected to the library at ${cfg.subsonic.url}`))
      .catch((err) => log.error(`music: can't reach the library at ${cfg.subsonic.url}: ${(err as Error).message}`));
    try {
      const global = app.router.globalCommandJson;
      const h = createHash("sha1").update(JSON.stringify(global)).digest("hex");
      if (store.kvGet<string>("commands.global") !== h) {
        await c.application.commands.set(global);
        store.kvSet("commands.global", h);
        log.info(`discord: registered ${global.length} DM command(s) for the owner`);
      }
    } catch (err) {
      log.error(`discord: couldn't register the owner's /servers command: ${(err as Error).message}`);
    }
    await app.servers.syncAll();
    for (const f of features) {
      try {
        await f.start?.();
      } catch (err) {
        log.error(`${f.name} failed to start`, err);
      }
    }
  });
  client.on(Events.GuildCreate, (g) => void app.servers.joined(g).catch((err) => log.error(`servers: couldn't handle joining "${g.name}"`, err)));
  client.on(Events.GuildDelete, (g) => app.servers.left(g));
  client.on(Events.InteractionCreate, (i) => void app.router.handle(i));
  client.on(Events.Error, (err) => log.error(`discord: client error: ${err.message}`));
  client.on(Events.Warn, (msg) => log.warn(`discord: ${msg}`));

  const health = startHealthServer(cfg.http.port, client, () => ({
    servers: client.guilds.cache.size,
    playing: [...app.player.sessions.values()].filter((s) => s.current && !s.ended).length,
  }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    for (const f of features) await Promise.resolve(f.stop?.()).catch(() => undefined);
    health.close();
    await client.destroy().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await client.login(cfg.discordToken);
}

// A bug in one handler must never take the bot down.
process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", reason));
process.on("uncaughtException", (err) => log.error("uncaught exception", err));

main().catch((err) => {
  log.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
