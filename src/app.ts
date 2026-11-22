/** Wires the features together (shared by the real bot and the tests). */
import type { Client } from "discord.js";
import { helpFeature } from "./commands/help.js";
import { playerFeature } from "./commands/player.js";
import { serversFeature } from "./commands/servers.js";
import type { Config } from "./config.js";
import type { Store } from "./core/db.js";
import { Router } from "./core/router.js";
import type { VoiceLinkFactory } from "./player/voice.js";
import type { SubsonicClient } from "./services/subsonic.js";

export interface AppDeps {
  cfg: Config;
  store: Store;
  client: Client;
  subsonic: SubsonicClient;
  link: VoiceLinkFactory;
  renderDelayMs?: number;
}

export function buildApp(d: AppDeps) {
  const player = playerFeature(d);
  const help = helpFeature();
  let router: Router | undefined;
  const servers = serversFeature({ cfg: d.cfg, store: d.store, client: d.client, guildCommands: () => router!.guildCommandJson });
  router = new Router([player, help, servers], (id) => servers.isApproved(id));
  return { router, player, servers, help };
}
