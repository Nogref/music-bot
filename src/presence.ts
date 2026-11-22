/** The bot's status line under its name, rotating every 30 s: how to start, where it is, and what's playing. */
import { ActivityType, type Client } from "discord.js";
import type { Feature } from "./core/router.js";

export interface PresenceStats {
  servers: number;
  playing: number;
}

export function presenceLines(s: PresenceStats): Array<{ name: string; type: ActivityType }> {
  const lines = [
    { name: "/play · /help", type: ActivityType.Listening },
    { name: `${s.servers.toLocaleString("en-US")} server${s.servers === 1 ? "" : "s"}`, type: ActivityType.Watching },
  ];
  if (s.playing > 0) lines.push({ name: `music in ${s.playing} server${s.playing === 1 ? "" : "s"}`, type: ActivityType.Playing });
  return lines;
}

export function presenceFeature(client: Client, stats: () => PresenceStats, everyMs = 30_000): Feature & { tick(): void } {
  let index = 0;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    const lines = presenceLines(stats());
    const line = lines[index % lines.length];
    index = (index + 1) % lines.length;
    client.user?.setPresence({ status: "online", activities: [line] });
  };
  return {
    name: "presence",
    tick,
    start: () => {
      tick();
      timer = setInterval(tick, everyMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
