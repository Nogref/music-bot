/** Wires the features together (shared by the real bot and the tests). */
import type { Client } from "discord.js";
import { apexFeature } from "./commands/apex.js";
import { helpFeature } from "./commands/help.js";
import { playerFeature } from "./commands/player.js";
import { serversFeature } from "./commands/servers.js";
import { setupFeature } from "./commands/setup.js";
import type { Config } from "./config.js";
import type { Store } from "./core/db.js";
import { Router, type Feature } from "./core/router.js";
import type { VoiceLinkFactory } from "./player/voice.js";
import { presenceFeature } from "./presence.js";
import type { SubsonicClient } from "./services/subsonic.js";

export interface AppDeps {
  cfg: Config;
  store: Store;
  client: Client;
  subsonic: SubsonicClient;
  link: VoiceLinkFactory;
  renderDelayMs?: number;
  /** Gap between Apex API calls (tests use 0). */
  apexGapMs?: number;
}

export function buildApp(d: AppDeps) {
  let router: Router | undefined;
  const servers = serversFeature({ cfg: d.cfg, store: d.store, client: d.client, guildCommands: () => router!.guildCommandJson });
  const player = playerFeature(d);
  const apex = d.cfg.apex ? apexFeature({ cfg: d.cfg.apex, store: d.store, client: d.client, isApproved: (id) => servers.isApproved(id), gapMs: d.apexGapMs }) : undefined;
  const help = helpFeature({ apex: Boolean(apex) });
  const setup = setupFeature([...player.setup, ...(apex?.setup ?? [])]);
  const presence = presenceFeature(d.client, () => ({
    servers: d.client.guilds.cache.filter((g) => servers.isApproved(g.id)).size,
    playing: [...player.sessions.values()].filter((s) => s.current && !s.ended).length,
  }));
  const features: Feature[] = [player, ...(apex ? [apex] : []), help, setup, servers, presence];
  router = new Router(features, (id) => servers.isApproved(id));
  return { router, player, apex, servers, help, presence, features };
}
