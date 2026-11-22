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
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import { ApexClient, PLATFORMS, platformName, regionFlag, type ApexPlayer, type MapRotation, type PredatorCut } from "../apex/client.js";
import { fmtNum, rankEmoji, rankLabel, rankValue } from "../apex/ranks.js";
import { ApexStore } from "../apex/store.js";
import { ApexTracker } from "../apex/tracker.js";
import type { Config } from "../config.js";
import type { Store } from "../core/db.js";
import { Colors, isServerAdmin, respond, truncate } from "../core/discord.js";
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
const UID_RE = /^\d{4,25}$/;
/** Starting list for legend suggestions; anything the API returns is added as it's seen. */
const LEGENDS = [
  "Alter", "Ash", "Ballistic", "Bangalore", "Bloodhound", "Catalyst", "Caustic", "Conduit", "Crypto", "Fuse", "Gibraltar", "Horizon", "Lifeline", "Loba",
  "Mad Maggie", "Mirage", "Newcastle", "Octane", "Pathfinder", "Rampart", "Revenant", "Seer", "Sparrow", "Valkyrie", "Vantage", "Wattson", "Wraith",
];
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

  /** The player's card: rank, level, what they're doing now, and one legend's banner trackers (theirs, or the one asked for). */
  async function statsEmbed(p: ApexPlayer, discordName?: string, legendWanted?: string): Promise<EmbedBuilder> {
    remember(p);
    const label = rankLabel(p.rank);
    const lines = [`${rankEmoji(p.rank.name)} **${label}** · ${fmtNum(p.rank.score)} RP${p.rank.ladderPos ? ` · #${fmtNum(p.rank.ladderPos)} on ${platformName(p.platform)}` : ""}`];
    if (rankValue(p.rank) >= MASTER) {
      const cut = (await predator().catch(() => [] as PredatorCut[])).find((c) => c.platform === p.platform);
      if (cut) lines.push(p.rank.score >= cut.rp ? `🔴 Above the Predator cutoff (${fmtNum(cut.rp)} RP)` : `🔴 ${fmtNum(cut.rp - p.rank.score)} RP to the Predator cutoff (${fmtNum(cut.rp)})`);
    }
    const level = [`⭐ Level ${fmtNum(p.level)}${p.toNextLevelPercent !== undefined ? ` (${p.toNextLevelPercent}% to ${fmtNum(p.level + 1)})` : ""}`];
    if (p.prestige) level.push(`Prestige ${p.prestige}`);
    if (p.battlePassLevel) level.push(`Battle pass ${p.battlePassLevel}`);
    lines.push(level.join(" · "));
    const since = p.stateSince ? ` since ${ts(p.stateSince)}` : "";
    const as = p.legend ? `, playing **${p.legend}**` : "";
    if (p.currentState === "inMatch") lines.push(`🟠 In a match${since}${as}`);
    else if (p.currentState === "inLobby") lines.push(`🟢 In the lobby${since}${as}`);
    else if (p.online) lines.push(`🟢 ${p.state ?? (p.inGame ? "In a match" : "Online")}`);
    else lines.push("⚫ Offline");
    if (p.banned) lines.push("⛔ Has an active ban or matchmaking penalty");
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(truncate(`${p.name} · ${platformName(p.platform)}`, 256))
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Wrong or missing numbers? Equip those trackers on the legend's banner in-game, then check again · apexlegendsstatus.com" });
    if (p.profileUrl) e.setURL(p.profileUrl);
    if (discordName) e.setAuthor({ name: discordName });
    if (p.rank.img) e.setThumbnail(p.rank.img);

    // Which legend to show: the one asked for, else the one they have selected.
    const wanted = legendWanted?.trim();
    const key = wanted ? Object.keys(p.legends).find((k) => k.toLowerCase() === wanted.toLowerCase()) : p.legend;
    const legend = key ? p.legends[key] : undefined;
    const trackers = wanted ? (legend?.trackers ?? []) : p.trackers.length ? p.trackers : (legend?.trackers ?? []);
    const shownName = key ?? wanted;
    if (shownName) {
      e.addFields({
        name: `🎯 ${shownName}'s banner`,
        value: trackers.length
          ? trackers
              .slice(0, 6)
              .map((t) => `${t.name}: **${fmtNum(t.value)}**`)
              .join("\n")
          : wanted && !legend
            ? `*No stats for ${truncate(wanted, 40)} yet. They show up once ${p.name} has played them with trackers on the banner.*`
            : "*No trackers equipped on this legend's banner.*",
      });
    }
    const banner = (wanted ? legend?.banner : p.legendBanner ?? legend?.banner) ?? undefined;
    if (banner) e.setImage(banner);
    if (p.trackedKills && !wanted) e.addFields({ name: "💀 Kills on tracked banners", value: fmtNum(p.trackedKills), inline: true });
    return e;
  }

  // Legends seen in lookups, for the legend: suggestions (new legends show up here without a bot update).
  const seenLegends = new Set(LEGENDS);
  const legendsByUid = new Map<string, string[]>();
  function remember(p: ApexPlayer) {
    const names = Object.keys(p.legends);
    for (const n of names) seenLegends.add(n);
    if (p.uid && names.length) legendsByUid.set(p.uid, names);
  }

  async function legendSuggestions(i: AutocompleteInteraction) {
    const typed = i.options.getFocused().toLowerCase();
    const member = i.options.get("member")?.value as string | undefined;
    const link = astore.link(member ?? i.user.id);
    const theirs = link ? (legendsByUid.get(link.uid) ?? []) : [];
    const all = [...new Set([...theirs, ...[...seenLegends].sort()])];
    await i.respond(
      all
        .filter((n) => n.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((n) => ({ name: n, value: n })),
    );
  }

  const memberName = (i: ChatInputCommandInteraction) => (i.member as GuildMember | null)?.displayName ?? i.user.username;

  /** Server admins can link or unlink someone else; everyone else only themselves. Returns the target, or a refusal. */
  async function target(i: ChatInputCommandInteraction): Promise<{ id: string; self: boolean; name: string } | string> {
    const member = i.options.getUser("member");
    if (!member || member.id === i.user.id) return { id: i.user.id, self: true, name: memberName(i) };
    if (!isServerAdmin(i)) return "Only server admins can link or unlink someone else. Ask them to run `/apex link` themselves.";
    if (member.bot) return "Bots don't play Apex.";
    const shown = (i.guild ? await tracker.memberName(i.guild as Guild, member.id) : undefined) ?? member.username;
    return { id: member.id, self: false, name: shown };
  }

  /** Name or UID (exactly one), checked for shape. Returns a refusal string when it isn't usable. */
  function nameOrUid(i: ChatInputCommandInteraction): { name?: string; uid?: string } | string {
    const name = i.options.getString("player")?.trim() || undefined;
    const uid = i.options.getString("uid")?.trim() || undefined;
    if (name && uid) return "Use either `player:` or `uid:`, not both.";
    if (uid && !UID_RE.test(uid)) return "A UID is just digits, like `1000575543540`. It's the number at the end of your apexlegendsstatus.com profile link.";
    return { name, uid };
  }

  /** Looks a player up by name or UID, or explains that they weren't found. */
  async function lookup(q: { name?: string; uid?: string }, platform: string): Promise<ApexPlayer | string> {
    try {
      return q.uid ? await apex.playerByUid(q.uid, platform) : await apex.player(q.name!, platform);
    } catch (err) {
      if (q.uid && err instanceof ApiError && err.status === 404) {
        return `🔍 There's no ${platformName(platform)} player with UID \`${q.uid}\`. Check the number and the platform (it's the last part of the apexlegendsstatus.com profile link).`;
      }
      const nf = notFound(err, q.name ?? "", platform);
      if (nf) return nf;
      throw err;
    }
  }

  async function link(i: ChatInputCommandInteraction) {
    const platform = i.options.getString("platform", true);
    const q = nameOrUid(i);
    if (typeof q === "string") return void (await i.reply({ content: q, flags: MessageFlags.Ephemeral }));
    if (!q.name && !q.uid) return void (await i.reply({ content: "Give your in-game name with `player:`, or your UID with `uid:`.", flags: MessageFlags.Ephemeral }));
    const who = await target(i);
    if (typeof who === "string") return void (await i.reply({ content: who, flags: MessageFlags.Ephemeral }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const found = await lookup(q, platform);
    if (typeof found === "string") return void (await i.editReply(found));
    const p = found;
    const l = { userId: who.id, uid: p.uid, name: p.name, platform: p.platform, linkedAt: Date.now() };
    const before = astore.link(who.id);
    astore.setLink(l);
    tracker.forgetMember(who.id);
    await tracker.record({ ...l }, p);
    if (!who.self) log.info(`apex: ${i.user.id} linked ${who.id} to ${p.name} (${p.platform})`);
    await i.editReply({
      content: who.self
        ? `✅ Linked you to **${p.name}** on ${platformName(p.platform)}. You're on the squad leaderboard now, and \`/apex me\` shows your stats.`
        : `✅ Linked <@${who.id}> to **${p.name}** on ${platformName(p.platform)}${before && before.uid !== p.uid ? ` (was **${before.name}**)` : ""}. They're on the squad leaderboard now, and can undo it with \`/apex unlink\`.`,
      embeds: [await statsEmbed(p, who.name)],
      allowedMentions: { parse: [] },
    });
    if (i.guildId) await tracker.updateBoards(i.guildId);
  }

  async function unlink(i: ChatInputCommandInteraction) {
    const who = await target(i);
    if (typeof who === "string") return void (await i.reply({ content: who, flags: MessageFlags.Ephemeral }));
    const had = astore.unlink(who.id);
    const text = who.self
      ? had
        ? "👋 Unlinked. You're off the leaderboard."
        : "You haven't linked an Apex account."
      : had
        ? `👋 Unlinked <@${who.id}>. They're off the leaderboard.`
        : `<@${who.id}> hasn't linked an Apex account.`;
    await i.reply({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (had) await tracker.updateBoards();
  }

  async function stats(i: ChatInputCommandInteraction, self: boolean) {
    const member = self ? null : i.options.getUser("member");
    const q = self ? {} : nameOrUid(i);
    if (typeof q === "string") return void (await i.reply({ content: q, flags: MessageFlags.Ephemeral }));
    const platform = (self ? null : i.options.getString("platform")) ?? "PC";
    const legendWanted = i.options.getString("legend") ?? undefined;
    await i.deferReply();
    if (q.name || q.uid) {
      const found = await lookup(q, platform);
      if (typeof found === "string") return void (await i.editReply(found));
      return void (await i.editReply({ embeds: [await statsEmbed(found, undefined, legendWanted)] }));
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
    await i.editReply({ embeds: [await statsEmbed(p, shown, legendWanted)], allowedMentions: { parse: [] } });
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
    const icon = { UP: "✅", SLOW: "⚠️", DOWN: "❌" } as const;
    const bad = groups.some((g) => g.down);
    const slow = groups.some((g) => g.slow);
    const e = new EmbedBuilder()
      .setColor(bad ? Colors.bad : slow ? Colors.warn : Colors.ok)
      .setTitle(bad ? "🛰️ Apex servers: some are down" : slow ? "🛰️ Apex servers: some are slow" : "🛰️ Apex servers: all good")
      .setFooter({ text: "From apexlegendsstatus.com · not always the full picture" });
    if (i.options.getBoolean("details")) {
      e.addFields(
        groups.slice(0, 24).map((g) => ({
          name: g.name,
          value: truncate(g.regions.map((r) => `${icon[r.status]} ${regionFlag(r.name)} ${r.name}`).join("\n"), 1024) || "—",
          inline: true,
        })),
      );
    } else {
      e.setDescription(
        groups
          .map((g) => (!g.slow && !g.down ? `✅ **${g.name}:** all ${g.up} up` : `${g.down ? "❌" : "⚠️"} **${g.name}:** ${truncate(g.problems.join(", "), 200)}`))
          .join("\n") + "\n-# `/apex servers details:True` shows every region.",
      );
    }
    await i.editReply({ embeds: [e] });
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
        .setDescription("Link your Apex account by name or UID (puts you on the squad leaderboard)")
        .addStringOption((o) => o.setName("platform").setDescription("Where you play").setRequired(true).addChoices(...PLATFORMS))
        .addStringOption((o) => o.setName("player").setDescription("Your in-game name (on PC, your EA account name)").setMaxLength(64))
        .addStringOption((o) => o.setName("uid").setDescription("Or your UID (the number at the end of your apexlegendsstatus.com profile link)").setMaxLength(25))
        .addUserOption((o) => o.setName("member").setDescription("Server admins: link this member instead of yourself")),
    )
    .addSubcommand((s) =>
      s
        .setName("unlink")
        .setDescription("Unlink your Apex account and leave the leaderboard")
        .addUserOption((o) => o.setName("member").setDescription("Server admins: unlink this member instead of yourself")),
    )
    .addSubcommand((s) =>
      s
        .setName("me")
        .setDescription("Your rank, RP, level and banner stats")
        .addStringOption((o) => o.setName("legend").setDescription("Show this legend's banner stats instead").setAutocomplete(true).setMaxLength(40)),
    )
    .addSubcommand((s) =>
      s
        .setName("stats")
        .setDescription("Someone's rank, RP, level and banner stats")
        .addUserOption((o) => o.setName("member").setDescription("A member who's linked their account"))
        .addStringOption((o) => o.setName("player").setDescription("Or any in-game name").setMaxLength(64))
        .addStringOption((o) => o.setName("uid").setDescription("Or a UID (from an apexlegendsstatus.com profile link)").setMaxLength(25))
        .addStringOption((o) => o.setName("platform").setDescription("Platform for that name or UID (default PC)").addChoices(...PLATFORMS))
        .addStringOption((o) => o.setName("legend").setDescription("Show this legend's banner stats instead").setAutocomplete(true).setMaxLength(40)),
    )
    .addSubcommand((s) => s.setName("map").setDescription("The Pubs and Ranked maps right now, and what's next"))
    .addSubcommand((s) => s.setName("predator").setDescription("How much RP it takes to be Apex Predator right now"))
    .addSubcommand((s) =>
      s
        .setName("servers")
        .setDescription("Are the Apex servers up?")
        .addBooleanOption((o) => o.setName("details").setDescription("Show every region")),
    )
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
        autocomplete: (i) => legendSuggestions(i),
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
