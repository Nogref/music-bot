/** Linked Apex accounts and RP snapshots (for "RP this week" and rank-ups). */
import type { Store } from "../core/db.js";

export interface ApexLink {
  userId: string;
  uid: string;
  name: string;
  platform: string;
  linkedAt: number;
  lastPolledAt?: number;
}

export interface Snapshot {
  uid: string;
  at: number;
  season: string;
  score: number;
  rankName: string;
  rankDiv: number;
  level: number;
}

const KEEP_MS = 60 * 86_400_000;

export class ApexStore {
  constructor(private readonly store: Store) {
    store.sql.exec(`
      CREATE TABLE IF NOT EXISTS apex_links (user_id TEXT PRIMARY KEY, uid TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL, linked_at INTEGER NOT NULL, last_polled_at INTEGER);
      CREATE TABLE IF NOT EXISTS apex_snapshots (uid TEXT NOT NULL, at INTEGER NOT NULL, season TEXT NOT NULL, score INTEGER NOT NULL, rank_name TEXT NOT NULL, rank_div INTEGER NOT NULL, level INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS apex_snapshots_uid_at ON apex_snapshots (uid, at);
    `);
  }

  private static link(r: Record<string, any>): ApexLink {
    return { userId: r.user_id, uid: r.uid, name: r.name, platform: r.platform, linkedAt: r.linked_at, lastPolledAt: r.last_polled_at ?? undefined };
  }
  private static snap(r: Record<string, any>): Snapshot {
    return { uid: r.uid, at: r.at, season: r.season, score: r.score, rankName: r.rank_name, rankDiv: r.rank_div, level: r.level };
  }

  link(userId: string): ApexLink | undefined {
    const r = this.store.sql.prepare("SELECT * FROM apex_links WHERE user_id = ?").get(userId) as Record<string, any> | undefined;
    return r ? ApexStore.link(r) : undefined;
  }

  links(): ApexLink[] {
    return (this.store.sql.prepare("SELECT * FROM apex_links ORDER BY linked_at").all() as Array<Record<string, any>>).map(ApexStore.link);
  }

  setLink(l: Omit<ApexLink, "lastPolledAt">) {
    this.store.sql
      .prepare(
        "INSERT INTO apex_links (user_id, uid, name, platform, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET uid = excluded.uid, name = excluded.name, platform = excluded.platform, linked_at = excluded.linked_at, last_polled_at = NULL",
      )
      .run(l.userId, l.uid, l.name, l.platform, l.linkedAt);
  }

  unlink(userId: string): boolean {
    return this.store.sql.prepare("DELETE FROM apex_links WHERE user_id = ?").run(userId).changes > 0;
  }

  polled(userId: string, at: number, name?: string) {
    if (name) this.store.sql.prepare("UPDATE apex_links SET last_polled_at = ?, name = ? WHERE user_id = ?").run(at, name, userId);
    else this.store.sql.prepare("UPDATE apex_links SET last_polled_at = ? WHERE user_id = ?").run(at, userId);
  }

  addSnapshot(s: Snapshot) {
    this.store.sql
      .prepare("INSERT INTO apex_snapshots (uid, at, season, score, rank_name, rank_div, level) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(s.uid, s.at, s.season, s.score, s.rankName, s.rankDiv, s.level);
    this.store.sql.prepare("DELETE FROM apex_snapshots WHERE at < ?").run(s.at - KEEP_MS);
  }

  latest(uid: string): Snapshot | undefined {
    const r = this.store.sql.prepare("SELECT * FROM apex_snapshots WHERE uid = ? ORDER BY at DESC LIMIT 1").get(uid) as Record<string, any> | undefined;
    return r ? ApexStore.snap(r) : undefined;
  }

  /** Last snapshot before `at` (the value the week started from). */
  before(uid: string, at: number): Snapshot | undefined {
    const r = this.store.sql.prepare("SELECT * FROM apex_snapshots WHERE uid = ? AND at < ? ORDER BY at DESC LIMIT 1").get(uid, at) as Record<string, any> | undefined;
    return r ? ApexStore.snap(r) : undefined;
  }

  /** First snapshot at or after `at` in a season (when there's nothing from before the week). */
  firstSince(uid: string, at: number, season: string): Snapshot | undefined {
    const r = this.store.sql.prepare("SELECT * FROM apex_snapshots WHERE uid = ? AND at >= ? AND season = ? ORDER BY at ASC LIMIT 1").get(uid, at, season) as Record<string, any> | undefined;
    return r ? ApexStore.snap(r) : undefined;
  }

  /** Highest rank value reached this season, from snapshots. */
  seasonSnapshots(uid: string, season: string): Snapshot[] {
    return (this.store.sql.prepare("SELECT * FROM apex_snapshots WHERE uid = ? AND season = ? ORDER BY at").all(uid, season) as Array<Record<string, any>>).map(ApexStore.snap);
  }
}
