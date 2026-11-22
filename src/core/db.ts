/**
 * Small SQLite store: which servers are approved, per-server settings
 * (volume, now-playing board) and a key/value table. Nothing about the music
 * itself is stored; the library lives in Aurral (or another Subsonic server).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type GuildStatus = "approved" | "pending" | "denied";

export interface GuildRecord {
  id: string;
  name: string;
  status: GuildStatus;
  addedAt: number;
  decidedAt?: number;
  /** Where the "waiting for approval" note was posted, so the approval can follow up there. */
  noticeChannelId?: string;
  /** The owner's approval DM, so it can be updated once decided. */
  ownerDm?: { channelId: string; messageId: string };
  /** Still in the server? (false once the bot leaves or is removed). */
  present: boolean;
}

export interface GuildSettings {
  /** 1-150, 100 = as recorded. */
  volume: number;
}

const DEFAULT_SETTINGS: GuildSettings = { volume: 100 };

export class Store {
  readonly sql: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.sql = new Database(path.join(dataDir, "music-bot.db"));
    this.sql.pragma("journal_mode = WAL");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guilds (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }

  kvGet<T>(key: string): T | undefined {
    const r = this.sql.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }
  kvSet(key: string, value: unknown) {
    this.sql.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
  kvDelete(key: string) {
    this.sql.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  guild(id: string): GuildRecord | undefined {
    const r = this.sql.prepare("SELECT data FROM guilds WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as GuildRecord) : undefined;
  }
  saveGuild(g: GuildRecord) {
    this.sql
      .prepare("INSERT INTO guilds (id, status, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
      .run(g.id, g.status, JSON.stringify(g));
  }
  forgetGuild(id: string) {
    this.sql.prepare("DELETE FROM guilds WHERE id = ?").run(id);
  }
  guilds(status?: GuildStatus): GuildRecord[] {
    const rows = (status
      ? this.sql.prepare("SELECT data FROM guilds WHERE status = ?").all(status)
      : this.sql.prepare("SELECT data FROM guilds").all()) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as GuildRecord).sort((a, b) => a.name.localeCompare(b.name));
  }

  settings(guildId: string): GuildSettings {
    return { ...DEFAULT_SETTINGS, ...this.kvGet<Partial<GuildSettings>>(`settings.${guildId}`) };
  }
  updateSettings(guildId: string, patch: Partial<GuildSettings>): GuildSettings {
    const next = { ...this.settings(guildId), ...patch };
    this.kvSet(`settings.${guildId}`, next);
    return next;
  }

  close() {
    this.sql.close();
  }
}
