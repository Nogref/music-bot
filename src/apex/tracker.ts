/**
 * Keeps linked players' ranks fresh: checks each one every APEX_POLL_MINUTES,
 * stores RP snapshots (for "RP this week"), posts a shout-out when someone
 * reaches a new season-high rank, and redraws each server's leaderboard.
 */
import { EmbedBuilder, type Client, type Guild, type SendableChannels } from "discord.js";
import type { Config } from "../config.js";
import type { Store } from "../core/db.js";
import { Colors, discordErrorCode, truncate } from "../core/discord.js";
import { LiveMessage } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { ApexClient, ApexPlayer } from "./client.js";
import { fmtNum, rankEmoji, rankLabel, rankValue, weekStart } from "./ranks.js";
import type { ApexLink, ApexStore, Snapshot } from "./store.js";

const MEMBER_TTL = 6 * 3_600_000;
/** Store a snapshot when something changed, or at least this often (keeps the weekly baseline honest). */
const SNAPSHOT_EVERY = 6 * 3_600_000;

export interface Standing {
  link: ApexLink;
  displayName: string;
  snap: Snapshot;
  week: number;
}

export interface TrackerDeps {
  client: Client;
  store: Store;
  apex: ApexClient;
  astore: ApexStore;
  cfg: NonNullable<Config["apex"]>;
  isApproved: (guildId: string) => boolean;
}

export class ApexTracker {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private readonly boards = new Map<string, LiveMessage>();
  private readonly members = new Map<string, { name?: string; at: number }>();

  constructor(private readonly d: TrackerDeps) {}

  start() {
    this.timer = setInterval(() => void this.pollDue(), 60_000);
    this.timer.unref?.();
    setTimeout(() => void this.pollDue(), 15_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  board(guildId: string): LiveMessage {
    let b = this.boards.get(guildId);
    if (!b) this.boards.set(guildId, (b = new LiveMessage(this.d.client, this.d.store, `apex.board.${guildId}`)));
    return b;
  }

  /** Where rank-up shout-outs go: their own channel, the leaderboard's channel, or nowhere ("off"). */
  shoutoutChannel(guildId: string): string | undefined {
    const set = this.d.store.kvGet<string>(`apex.shoutouts.${guildId}`);
    if (set === "off") return undefined;
    return set ?? this.board(guildId).location?.channelId;
  }

  setShoutouts(guildId: string, channelId: string | "off" | undefined) {
    if (channelId === undefined) this.d.store.kvDelete(`apex.shoutouts.${guildId}`);
    else this.d.store.kvSet(`apex.shoutouts.${guildId}`, channelId);
  }

  /** Checks everyone who's due, then redraws the boards. */
  async pollDue(now = Date.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const due = this.d.astore.links().filter((l) => !l.lastPolledAt || now - l.lastPolledAt >= this.d.cfg.pollMinutes * 60_000);
      for (const link of due) {
        try {
          await this.record(link, await this.d.apex.playerByUid(link.uid, link.platform));
        } catch (err) {
          log.debug(`apex: couldn't check ${link.name}: ${(err as Error).message}`);
          this.d.astore.polled(link.userId, Date.now());
        }
      }
      if (due.length) await this.updateBoards();
    } finally {
      this.polling = false;
    }
  }

  /** Saves what a fresh lookup showed, and celebrates a new season high. */
  async record(link: ApexLink, p: ApexPlayer, at = Date.now()): Promise<{ rankedUp: boolean }> {
    const snap: Snapshot = { uid: link.uid, at, season: p.rank.season ?? "unknown", score: p.rank.score, rankName: p.rank.name, rankDiv: p.rank.div, level: p.level };
    const prev = this.d.astore.latest(link.uid);
    const changed = !prev || prev.score !== snap.score || prev.season !== snap.season || prev.rankName !== snap.rankName || prev.rankDiv !== snap.rankDiv || prev.level !== snap.level;
    let rankedUp = false;
    if (prev && prev.season === snap.season) {
      const peak = Math.max(...this.d.astore.seasonSnapshots(link.uid, snap.season).map((s) => rankValue({ name: s.rankName, div: s.rankDiv })));
      const now = rankValue({ name: snap.rankName, div: snap.rankDiv });
      rankedUp = now > peak && now >= 0;
    }
    if (changed || at - prev!.at >= SNAPSHOT_EVERY) this.d.astore.addSnapshot(snap);
    this.d.astore.polled(link.userId, at, p.name);
    if (rankedUp) await this.shoutOut(link, p);
    return { rankedUp };
  }

  private async shoutOut(link: ApexLink, p: ApexPlayer) {
    for (const guild of this.d.client.guilds.cache.values()) {
      if (!this.d.isApproved(guild.id)) continue;
      const channelId = this.shoutoutChannel(guild.id);
      if (!channelId) continue;
      const name = await this.memberName(guild, link.userId);
      if (name === undefined) continue;
      const ch = (await this.d.client.channels.fetch(channelId).catch(() => null)) as SendableChannels | null;
      if (!ch?.isSendable?.()) continue;
      const label = rankLabel(p.rank);
      const e = new EmbedBuilder()
        .setColor(Colors.ok)
        .setTitle(truncate(`🎉 ${name} just hit ${rankEmoji(p.rank.name)} ${label}!`, 256))
        .setDescription(`<@${link.userId}> reached a new high for the season: **${label}** with **${fmtNum(p.rank.score)} RP**.`);
      if (p.rank.img) e.setThumbnail(p.rank.img);
      await ch.send({ embeds: [e], allowedMentions: { parse: [] } }).catch((err) => log.warn(`apex: couldn't post a shout-out in ${guild.name}: ${(err as Error).message}`));
    }
  }

  /** Their name in that server, or undefined if they're not in it. */
  async memberName(guild: Guild, userId: string): Promise<string | undefined> {
    const key = `${guild.id}:${userId}`;
    const hit = this.members.get(key);
    if (hit && Date.now() - hit.at < MEMBER_TTL) return hit.name;
    let name: string | undefined;
    try {
      const m = await guild.members.fetch(userId);
      name = m.displayName;
    } catch (err) {
      if (discordErrorCode(err) !== 10007 && discordErrorCode(err) !== 10013) {
        // Couldn't tell (Discord hiccup): keep whatever we knew.
        return hit?.name;
      }
    }
    this.members.set(key, { name, at: Date.now() });
    return name;
  }

  forgetMember(userId: string) {
    for (const k of [...this.members.keys()]) if (k.endsWith(`:${userId}`)) this.members.delete(k);
  }

  /** RP gained since Monday 00:00 (in TIMEZONE); a new ranked season starts from its first snapshot. */
  weekDelta(uid: string, latest: Snapshot, now = Date.now()): number {
    const ws = weekStart(now, this.d.cfg.timezone);
    let base = this.d.astore.before(uid, ws);
    if (!base || base.season !== latest.season) base = this.d.astore.firstSince(uid, ws, latest.season);
    return base ? latest.score - base.score : 0;
  }

  /** Linked members of this server, best first. */
  async standings(guild: Guild): Promise<Standing[]> {
    const rows: Standing[] = [];
    for (const link of this.d.astore.links()) {
      const snap = this.d.astore.latest(link.uid);
      if (!snap) continue;
      const displayName = await this.memberName(guild, link.userId);
      if (displayName === undefined) continue;
      rows.push({ link, displayName, snap, week: this.weekDelta(link.uid, snap) });
    }
    return rows.sort((a, b) => b.snap.score - a.snap.score || b.week - a.week);
  }

  async boardEmbed(guild: Guild): Promise<EmbedBuilder> {
    const rows = await this.standings(guild);
    const e = new EmbedBuilder().setColor(Colors.info).setTitle("🏆 Squad leaderboard");
    if (!rows.length) return e.setDescription("Nobody's linked their Apex account yet. Use `/apex link` to join the leaderboard.");
    const medal = ["🥇", "🥈", "🥉"];
    const lines = rows.slice(0, 25).map((r, i) => {
      const rank = { name: r.snap.rankName, div: r.snap.rankDiv };
      const week = r.week > 0 ? ` · ▲ ${fmtNum(r.week)}` : r.week < 0 ? ` · ▼ ${fmtNum(-r.week)}` : "";
      return `${medal[i] ?? `\`${i + 1}.\``} **${truncate(r.displayName, 32)}** · ${rankEmoji(rank.name)} ${rankLabel(rank)} · ${fmtNum(r.snap.score)} RP${week}`;
    });
    const top = [...rows].sort((a, b) => b.week - a.week)[0];
    e.setDescription(lines.join("\n"));
    if (top && top.week > 0) e.addFields({ name: "📈 Top climber this week", value: `**${truncate(top.displayName, 32)}**, ${fmtNum(top.week)} RP` });
    return e.setFooter({ text: `▲▼ = RP this week (since Monday 12 AM, ${this.d.cfg.timezone.replace(/_/g, " ")}) · /apex link to join` }).setTimestamp(new Date());
  }

  async updateBoards(onlyGuild?: string): Promise<void> {
    for (const guild of this.d.client.guilds.cache.values()) {
      if (onlyGuild && guild.id !== onlyGuild) continue;
      if (!this.d.isApproved(guild.id)) continue;
      const b = this.board(guild.id);
      if (!b.location) continue;
      try {
        await b.update({ embeds: [await this.boardEmbed(guild)], components: [] });
      } catch (err) {
        log.warn(`apex: couldn't update the leaderboard in ${guild.name}: ${(err as Error).message}`);
      }
    }
  }
}
