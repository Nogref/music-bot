/**
 * /apex: link your Apex account, check stats, today's maps, the Predator
 * cutoff and server status, plus the squad leaderboard and rank-up shout-outs
 * (/setup apex-leaderboard, /setup apex-shoutouts). Only on when APEX_API_KEY is set.
 */
import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import { ApexClient, PLATFORMS, platformName, type ApexPlayer, type MapRotation, type PredatorCut } from "../apex/client.js";
import { fmtNum, rankEmoji, rankLabel, rankValue } from "../apex/ranks.js";
import { ApexStore } from "../apex/store.js";
import { ApexTracker } from "../apex/tracker.js";
import type { Config } from "../config.js";
import type { Store } from "../core/db.js";
import { Colors, respond, truncate } from "../core/discord.js";
import { ApiError } from "../core/http.js";
import { log } from "../core/logger.js";
import type { Feature } from "../core/router.js";
import { TtlCache } from "../core/ttlCache.js";
import type { SetupPart } from "./setup.js";

export interface ApexDeps {
  cfg: NonNullable<Config["apex"]>;
  store: Store;
  client: Client;
  isApproved: (guildId: string) => boolean;
  /** Tests make calls instantly. */
  gapMs?: number;
}

const MASTER = rankValue({ name: "Master", div: 0 });
const ts = (ms: number, style = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function apexFeature(d: ApexDeps): Feature & { tracker: ApexTracker; astore: ApexStore; setup: SetupPart[] } {
  const apex = new ApexClient(d.cfg, d.gapMs);
  const astore = new ApexStore(d.store);
  const tracker = new ApexTracker({ client: d.client, store: d.store, apex, astore, cfg: d.cfg, isApproved: d.isApproved });
  const cache = new TtlCache<string, unknown>(60_000);

  async function cached<T>(key: string, ttl: number, fn: () => Promise<T>, fresh?: (v: T) => boolean): Promise<T> {
    const hit = cache.get(key) as T | undefined;
    if (hit !== undefined && (!fresh || fresh(hit))) return hit;
    const v = await fn();
    cache.set(key, v, ttl);
    return v;
  }
  const maps = () => cached<MapRotation>("maps", 60_000, () => apex.maps(), (m) => !m.pubs?.current.end || m.pubs.current.end > Date.now());
  const predator = () => cached<PredatorCut[]>("predator", 10 * 60_000, () => apex.predator());

  /** "That player doesn't exist" reads better than an API error. */
  function notFound(err: unknown, who: string, platform: string): string | undefined {
    if (err instanceof ApiError && err.status === 404) {
      return `🔍 I couldn't find **${truncate(who, 40)}** on ${platformName(platform)}. Use the exact in-game name (on PC, the EA account name), and check the platform.`;
    }
    return undefined;
  }

  async function statsEmbed(p: ApexPlayer, discordName?: string): Promise<EmbedBuilder> {
    const label = rankLabel(p.rank);
    const lines = [`${rankEmoji(p.rank.name)} **${label}** · ${fmtNum(p.rank.score)} RP${p.rank.ladderPos ? ` · #${fmtNum(p.rank.ladderPos)} on ${platformName(p.platform)}` : ""}`];
    if (rankValue(p.rank) >= MASTER) {
      const cut = (await predator().catch(() => [] as PredatorCut[])).find((c) => c.platform === p.platform);
      if (cut) lines.push(p.rank.score >= cut.rp ? `🔴 Above the Predator cutoff (${fmtNum(cut.rp)} RP)` : `🔴 ${fmtNum(cut.rp - p.rank.score)} RP to the Predator cutoff (${fmtNum(cut.rp)})`);
    }
    lines.push(`⭐ Level ${fmtNum(p.level)}${p.prestige ? ` · Prestige ${p.prestige}` : ""}`);
    lines.push(p.online ? `🟢 ${p.state ?? (p.inGame ? "In a match" : "Online")}` : "⚫ Offline");
    if (p.banned) lines.push("⛔ Has an active ban or matchmaking penalty");
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(truncate(`${p.name} · ${platformName(p.platform)}`, 256))
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Kills and other stats only count trackers equipped on banners · apexlegendsstatus.com" });
    if (discordName) e.setAuthor({ name: discordName });
    if (p.rank.img) e.setThumbnail(p.rank.img);
    if (p.legend) {
      const trackers = p.trackers.slice(0, 3).map((t) => `${t.name}: **${fmtNum(t.value)}**`);
      e.addFields({ name: `🎯 ${p.legend}'s banner`, value: trackers.length ? trackers.join("\n") : "*No trackers equipped on this legend's banner.*" });
    }
    if (p.trackedKills) e.addFields({ name: "💀 Kills on tracked banners", value: fmtNum(p.trackedKills), inline: true });
    return e;
  }

  const memberName = (i: ChatInputCommandInteraction) => (i.member as GuildMember | null)?.displayName ?? i.user.username;

  async function link(i: ChatInputCommandInteraction) {
    const name = i.options.getString("player", true).trim();
    const platform = i.options.getString("platform", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let p: ApexPlayer;
    try {
      p = await apex.player(name, platform);
    } catch (err) {
      const nf = notFound(err, name, platform);
      if (nf) return void (await i.editReply(nf));
      throw err;
    }
    const l = { userId: i.user.id, uid: p.uid, name: p.name, platform: p.platform, linkedAt: Date.now() };
    astore.setLink(l);
    tracker.forgetMember(i.user.id);
    await tracker.record({ ...l }, p);
    await i.editReply({
      content: `✅ Linked you to **${p.name}** on ${platformName(p.platform)}. You're on the squad leaderboard now, and \`/apex me\` shows your stats.`,
      embeds: [await statsEmbed(p, memberName(i))],
    });
    if (i.guildId) await tracker.updateBoards(i.guildId);
  }

  async function unlink(i: ChatInputCommandInteraction) {
    const had = astore.unlink(i.user.id);
    await i.reply({ content: had ? "👋 Unlinked. You're off the leaderboard." : "You haven't linked an Apex account.", flags: MessageFlags.Ephemeral });
    if (had) await tracker.updateBoards();
  }

  async function stats(i: ChatInputCommandInteraction, self: boolean) {
    const member = self ? null : i.options.getUser("member");
    const typed = self ? null : i.options.getString("player")?.trim();
    const platform = (self ? null : i.options.getString("platform")) ?? "PC";
    await i.deferReply();
    if (typed) {
      try {
        return void (await i.editReply({ embeds: [await statsEmbed(await apex.player(typed, platform))] }));
      } catch (err) {
        const nf = notFound(err, typed, platform);
        if (nf) return void (await i.editReply(nf));
        throw err;
      }
    }
    const userId = member?.id ?? i.user.id;
    const l = astore.link(userId);
    if (!l) {
      return void (await i.editReply(
        userId === i.user.id
          ? "You haven't linked your Apex account yet. Use `/apex link` with your in-game name and platform."
          : `<@${userId}> hasn't linked an Apex account. You can look anyone up with \`/apex stats player:\`.`,
      ));
    }
    const p = await apex.playerByUid(l.uid, l.platform);
    await tracker.record(l, p);
    const shown = member ? ((i.guild ? await tracker.memberName(i.guild as Guild, userId) : undefined) ?? member.username) : memberName(i);
    await i.editReply({ embeds: [await statsEmbed(p, shown)], allowedMentions: { parse: [] } });
  }

  async function mapsCmd(i: ChatInputCommandInteraction) {
    await i.deferReply();
    const m = await maps();
    const embeds: EmbedBuilder[] = [];
    const one = (title: string, color: number, slot: NonNullable<MapRotation["pubs"]>) => {
      const lines = [slot.current.end ? `Changes ${ts(slot.current.end)} (at ${ts(slot.current.end, "t")})` : ""];
      if (slot.next) lines.push(`Next: **${slot.next.map}**${slot.next.minutes ? ` for ${slot.next.minutes >= 120 ? `${Math.round(slot.next.minutes / 60)} hours` : `${slot.next.minutes} min`}` : ""}`);
      const e = new EmbedBuilder().setColor(color).setTitle(`${title}: ${slot.current.map}`).setDescription(lines.filter(Boolean).join("\n") || "​");
      if (slot.current.image) e.setImage(slot.current.image);
      embeds.push(e);
    };
    if (m.pubs) one("🗺️ Pubs", Colors.info, m.pubs);
    if (m.ranked) one("🏆 Ranked", Colors.warn, m.ranked);
    if (!embeds.length) return void (await i.editReply("I couldn't get the map rotation right now. Try again in a minute."));
    embeds.at(-1)!.setFooter({ text: "Map rotation from apexlegendsstatus.com" });
    await i.editReply({ embeds });
  }

  async function predatorCmd(i: ChatInputCommandInteraction) {
    await i.deferReply();
    const cuts = await predator();
    if (!cuts.length) return void (await i.editReply("I couldn't get the Predator cutoff right now. Try again in a minute."));
    const order = ["PC", "PS4", "X1", "SWITCH"];
    const lines = [...cuts]
      .sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform))
      .map((c) => `**${platformName(c.platform)}:** ${fmtNum(c.rp)} RP${c.mastersAndPreds ? ` · ${fmtNum(c.mastersAndPreds)} Masters & Preds` : ""}`);
    const updated = cuts.map((c) => c.updatedAt ?? 0).sort((a, b) => b - a)[0];
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.bad)
          .setTitle("🔴 Apex Predator cutoff")
          .setDescription(`${lines.join("\n")}\n\nPredator is the top 750 players on each platform, so the cutoff moves as people play.${updated ? `\nUpdated ${ts(updated)}.` : ""}`)
          .setFooter({ text: "From apexlegendsstatus.com" }),
      ],
    });
  }

  async function serversCmd(i: ChatInputCommandInteraction) {
    await i.deferReply();
    const groups = await cached("servers", 2 * 60_000, () => apex.servers());
    if (!groups.length) return void (await i.editReply("I couldn't get the server status right now. Try again in a minute."));
    const lines = groups.map((g) => {
      const total = g.up + g.slow + g.down;
      if (!g.slow && !g.down) return `✅ **${g.name}:** all ${total} up`;
      return `${g.down ? "❌" : "⚠️"} **${g.name}:** ${truncate(g.problems.join(", "), 200)}`;
    });
    const bad = groups.some((g) => g.down);
    const slow = groups.some((g) => g.slow);
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(bad ? Colors.bad : slow ? Colors.warn : Colors.ok)
          .setTitle(bad ? "🛰️ Apex servers: some are down" : slow ? "🛰️ Apex servers: some are slow" : "🛰️ Apex servers: all good")
          .setDescription(lines.join("\n"))
          .setFooter({ text: "From apexlegendsstatus.com · not always the full picture" }),
      ],
    });
  }

  async function leaderboard(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const b = tracker.board(i.guildId!);
    await i.editReply({
      content: b.location ? `The live leaderboard is here: ${b.link(i.guildId!)}` : "",
      embeds: [await tracker.boardEmbed(i.guild as Guild)],
    });
  }

  const json = new SlashCommandBuilder()
    .setName("apex")
    .setDescription("Apex Legends: stats, maps, the squad leaderboard")
    .addSubcommand((s) =>
      s
        .setName("link")
        .setDescription("Link your Apex account (puts you on the squad leaderboard)")
        .addStringOption((o) => o.setName("player").setDescription("Your in-game name (on PC, your EA account name)").setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName("platform").setDescription("Where you play").setRequired(true).addChoices(...PLATFORMS)),
    )
    .addSubcommand((s) => s.setName("unlink").setDescription("Unlink your Apex account and leave the leaderboard"))
    .addSubcommand((s) => s.setName("me").setDescription("Your rank, RP, level and banner stats"))
    .addSubcommand((s) =>
      s
        .setName("stats")
        .setDescription("Someone's rank, RP, level and banner stats")
        .addUserOption((o) => o.setName("member").setDescription("A member who's linked their account"))
        .addStringOption((o) => o.setName("player").setDescription("Or any in-game name").setMaxLength(64))
        .addStringOption((o) => o.setName("platform").setDescription("Platform for that name (default PC)").addChoices(...PLATFORMS)),
    )
    .addSubcommand((s) => s.setName("map").setDescription("The Pubs and Ranked maps right now, and what's next"))
    .addSubcommand((s) => s.setName("predator").setDescription("How much RP it takes to be Apex Predator right now"))
    .addSubcommand((s) => s.setName("servers").setDescription("Are the Apex servers up?"))
    .addSubcommand((s) => s.setName("leaderboard").setDescription("The squad leaderboard for this server"))
    .toJSON();

  const setup: SetupPart[] = [
    {
      name: "apex-leaderboard",
      build: (sc) =>
        sc
          .setDescription("Keep the Apex squad leaderboard in a channel (leave the channel empty to remove it)")
          .addChannelOption((o) => o.setName("channel").setDescription("Where the leaderboard lives").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      run: async (i) => {
        const channel = i.options.getChannel("channel");
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const b = tracker.board(i.guildId!);
        if (!channel) {
          const removed = await b.remove();
          return void (await i.editReply(removed ? "🗑️ Removed the leaderboard." : "There's no leaderboard to remove."));
        }
        const msg = await b.place(channel.id, { embeds: [await tracker.boardEmbed(i.guild as Guild)], components: [] });
        const shout = tracker.shoutoutChannel(i.guildId!);
        await i.editReply(
          `🏆 Leaderboard posted in <#${msg.channelId}>. It updates every ${d.cfg.pollMinutes} minutes. ` +
            (shout === msg.channelId ? "Rank-up shout-outs go there too (`/setup apex-shoutouts` to change that)." : shout ? `Rank-up shout-outs go to <#${shout}>.` : "Rank-up shout-outs are off."),
        );
      },
    },
    {
      name: "apex-shoutouts",
      build: (sc) =>
        sc
          .setDescription("Where rank-up shout-outs go (leave the channel empty to turn them off)")
          .addChannelOption((o) => o.setName("channel").setDescription("Where to celebrate rank-ups").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      run: async (i) => {
        const channel = i.options.getChannel("channel");
        tracker.setShoutouts(i.guildId!, channel?.id ?? "off");
        await i.reply({
          content: channel ? `🎉 Rank-up shout-outs go to <#${channel.id}> now.` : "🔕 Rank-up shout-outs are off. Run this again with a channel to turn them back on.",
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ];

  return {
    name: "apex",
    tracker,
    astore,
    setup,
    guildCommands: [
      {
        json: { ...json, contexts: [InteractionContextType.Guild] },
        execute: async (i) => {
          try {
            await run(i);
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            log.warn(`apex: /apex ${i.options.getSubcommand()} failed: ${err.message}`);
            await respond(
              i,
              err.status === 403
                ? "⚠️ The Apex stats service didn't accept the bot's API key. The bot's owner needs to check `APEX_API_KEY`."
                : err.status === 429
                  ? "⏳ The Apex stats service is busy. Try again in a few seconds."
                  : "⚠️ The Apex stats service isn't answering properly right now. Try again in a minute.",
            );
          }
        },
      },
    ],
    start: async () => {
      tracker.start();
      // One cheap call so a bad key or a blocked request shows up in the log straight away.
      try {
        const m = await maps();
        log.info(`apex: connected to the Apex stats service (pubs map: ${m.pubs?.current.map ?? "?"})`);
      } catch (err) {
        log.error(`apex: the Apex stats service refused the bot: ${(err as Error).message}`);
      }
    },
    stop: () => tracker.stop(),
  };

  async function run(i: ChatInputCommandInteraction) {
    switch (i.options.getSubcommand()) {
      case "link":
        return link(i);
      case "unlink":
        return unlink(i);
      case "me":
        return stats(i, true);
      case "stats":
        return stats(i, false);
      case "map":
        return mapsCmd(i);
      case "predator":
        return predatorCmd(i);
      case "servers":
        return serversCmd(i);
      case "leaderboard":
        return leaderboard(i);
    }
  }
}
