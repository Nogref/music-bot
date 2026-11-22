/**
 * Settings come from environment variables (the Unraid template), with an
 * optional bot.env file in the data folder filling in anything left blank.
 */
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { log } from "./core/logger.js";

export interface Config {
  discordToken: string;
  /** Who approves servers. Defaults to the Discord application's owner. */
  ownerId?: string;
  /** Servers that are approved without asking. */
  preApproved: string[];
  /** Aurral's built-in Subsonic server, or any other Subsonic server (Navidrome, gonic…). */
  subsonic: { url: string; user: string; password: string; bitrate: number };
  idleMinutes: number;
  /** Apex Legends stats (apexlegendsapi.com). Off without a key. */
  apex?: { apiKey: string; url: string; pollMinutes: number; timezone: string };
  dataDir: string;
  http: { port: number; timeoutMs: number };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function num(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    log.warn(`config: ${name}="${raw}" isn't a number between ${min} and ${max}; using ${fallback}`);
    return fallback;
  }
  return n;
}

function list(name: string): string[] {
  return (env(name) ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validates a base URL, strips trailing slashes (and a trailing /rest), warns about localhost inside Docker. */
function url(name: string): string | undefined {
  const raw = env(name);
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    log.error(`config: ${name}="${raw}" isn't a valid URL (expected e.g. http://aurral:3001).`);
    return undefined;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    log.error(`config: ${name} must start with http:// or https://.`);
    return undefined;
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    log.warn(
      `config: ${name} points at ${host}. Inside a container that's the bot itself, not your server. ` +
        `Use the container name on a shared Docker network (e.g. http://aurral:3001) or the Unraid host's IP.`,
    );
  }
  return raw.replace(/\/+$/, "").replace(/\/rest$/, "");
}

/** Optional settings file in the data folder (/data/bot.env). Container settings win when they're set. */
export function loadEnvFile(dataDir = process.env.DATA_DIR?.trim() || "/data"): string | undefined {
  const file = path.join(dataDir, "bot.env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let applied = 0;
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (!process.env[k]?.trim()) {
      process.env[k] = v;
      applied++;
    }
  }
  log.info(`config: read ${applied} setting(s) from ${file}`);
  return file;
}

export function loadConfig(): Config {
  loadEnvFile();
  const discordToken = env("DISCORD_TOKEN");
  const subsonicUrl = url("SUBSONIC_URL");
  const user = env("SUBSONIC_USER");
  const password = env("SUBSONIC_PASSWORD");
  const missing = [!discordToken && "DISCORD_TOKEN", !subsonicUrl && "SUBSONIC_URL", !user && "SUBSONIC_USER", !password && "SUBSONIC_PASSWORD"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. Set them in the container settings, ` +
        `or in bot.env in the data folder (/mnt/user/appdata/music-bot/bot.env on Unraid). See .env.example.`,
    );
  }
  const ownerId = env("OWNER_ID");
  if (ownerId && !/^\d{15,22}$/.test(ownerId)) log.warn(`config: OWNER_ID="${ownerId}" doesn't look like a Discord user ID; using the app's owner instead.`);
  const apexKey = env("APEX_API_KEY");
  const timezone = env("TIMEZONE") ?? "America/Chicago";
  let tzOk = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    tzOk = false;
    log.warn(`config: TIMEZONE="${timezone}" isn't a time zone (try America/Chicago); using America/Chicago`);
  }
  return {
    discordToken: discordToken!,
    ownerId: ownerId && /^\d{15,22}$/.test(ownerId) ? ownerId : undefined,
    preApproved: list("ALLOWED_GUILD_IDS").filter((id) => /^\d{15,22}$/.test(id)),
    subsonic: { url: subsonicUrl!, user: user!, password: password!, bitrate: num("MUSIC_BITRATE", 128, 32, 512) },
    idleMinutes: num("IDLE_MINUTES", 5, 1, 720),
    apex: apexKey
      ? {
          apiKey: apexKey,
          url: (env("APEX_API_URL") ?? "https://api.mozambiquehe.re").replace(/\/+$/, ""),
          pollMinutes: num("APEX_POLL_MINUTES", 15, 5, 1440),
          timezone: tzOk ? timezone : "America/Chicago",
        }
      : undefined,
    dataDir: env("DATA_DIR") ?? "/data",
    http: { port: num("HEALTH_PORT", 8080, 1, 65535), timeoutMs: num("HTTP_TIMEOUT_MS", 10_000, 1000) },
  };
}
