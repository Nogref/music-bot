/**
 * Which servers may use the bot. When someone adds it, the owner gets a DM
 * with Approve / Leave buttons; until then the server sees no commands.
 * Servers the owner owns, and ALLOWED_GUILD_IDS, are approved straight away.
 * The owner also has /servers in DMs to list, approve or remove servers.
 */
import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  Team,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type MessageComponentInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SendableChannels,
} from "discord.js";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { GuildRecord, Store } from "../core/db.js";
import { Colors, dm, truncate } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { Feature } from "../core/router.js";

/** What the bot needs in a server: see channels, post the card (with cover art), play in voice. */
export const BOT_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);

export function inviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS.bitfield}`;
}

export interface ServersDeps {
  cfg: Config;
  store: Store;
  client: Client;
  /** The music commands every approved server gets. */
  guildCommands: () => RESTPostAPIChatInputApplicationCommandsJSONBody[];
}

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");

export function serversFeature(d: ServersDeps): Feature & {
  isApproved(guildId: string): boolean;
  joined(guild: Guild, atStartup?: boolean): Promise<void>;
  left(guild: Guild): void;
  syncAll(): Promise<void>;
  ownerId(): Promise<string | undefined>;
} {
  const { cfg, store, client } = d;
  let owner: string | undefined = cfg.ownerId;

  async function ownerId(): Promise<string | undefined> {
    if (owner) return owner;
    try {
      const app = await client.application!.fetch();
      owner = app.owner instanceof Team ? app.owner.ownerId ?? undefined : app.owner?.id;
    } catch (err) {
      log.warn(`servers: couldn't look up the bot's owner (${(err as Error).message}); set OWNER_ID`);
    }
    return owner;
  }

  const isApproved = (guildId: string) => cfg.preApproved.includes(guildId) || store.guild(guildId)?.status === "approved";

  /** Gives approved servers the music commands and takes them away from everyone else (only when something changed). */
  async function syncCommands(guild: Guild) {
    const want = isApproved(guild.id) ? d.guildCommands() : [];
    const key = `commands.${guild.id}`;
    const h = hash(want);
    if (store.kvGet<string>(key) === h) return;
    if (!want.length && store.kvGet<string>(key) === undefined) return; // never had any
    try {
      await guild.commands.set(want);
      store.kvSet(key, h);
      log.info(`servers: ${want.length ? `registered ${want.length} commands in` : "removed the commands from"} "${guild.name}"`);
    } catch (err) {
      log.error(`servers: couldn't update the commands in "${guild.name}": ${(err as Error).message}. Re-invite the bot with the applications.commands scope.`);
    }
  }

  /** Somewhere in the server the bot can say hello. */
  function noticeChannel(guild: Guild): SendableChannels | undefined {
    const me = guild.members.me;
    const canPost = (ch: unknown): ch is SendableChannels => {
      const c = ch as { isSendable?: () => boolean; permissionsFor?: (m: unknown) => PermissionsBitField | null } | null;
      if (!c?.isSendable?.()) return false;
      const p = me && c.permissionsFor ? c.permissionsFor(me) : null;
      return !p || p.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    };
    if (canPost(guild.systemChannel)) return guild.systemChannel as unknown as SendableChannels;
    return guild.channels.cache.find((c) => c.type === ChannelType.GuildText && canPost(c)) as SendableChannels | undefined;
  }

  async function say(guild: Guild, rec: GuildRecord | undefined, text: string) {
    const ch = (rec?.noticeChannelId ? (guild.channels.cache.get(rec.noticeChannelId) as unknown as SendableChannels | undefined) : undefined) ?? noticeChannel(guild);
    if (!ch?.isSendable?.()) return undefined;
    const m = await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => undefined);
    return m?.channelId;
  }

  const buttons = (id: string, withLeave = true) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`srv:approve:${id}`).setEmoji("✅").setLabel("Approve").setStyle(ButtonStyle.Success),
      ...(withLeave ? [new ButtonBuilder().setCustomId(`srv:leave:${id}`).setEmoji("🚪").setLabel("Leave").setStyle(ButtonStyle.Danger)] : []),
    );

  async function askOwner(guild: Guild, rec: GuildRecord) {
    const who = await ownerId();
    if (!who) {
      log.warn(`servers: "${guild.name}" (${guild.id}) is waiting for approval, but I don't know who the owner is. Set OWNER_ID.`);
      return;
    }
    const guildOwner = await guild.fetchOwner().catch(() => undefined);
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(truncate(`🎵 Can "${guild.name}" use the music bot?`, 256))
      .setDescription("Someone added the music bot to this server. Approve it and they can play your library; leave it and the bot leaves.")
      .addFields(
        { name: "Members", value: String(guild.memberCount ?? "?"), inline: true },
        { name: "Server owner", value: guildOwner ? `${guildOwner.user.username} (<@${guildOwner.id}>)` : "unknown", inline: true },
        { name: "Added", value: `<t:${Math.floor(rec.addedAt / 1000)}:R>`, inline: true },
      )
      .setFooter({ text: `Server ID ${guild.id} · /servers lists every server` });
    const icon = guild.iconURL?.();
    if (icon) e.setThumbnail(icon);
    const m = await dm(client, who, { embeds: [e], components: [buttons(guild.id)] });
    if (m) rec.ownerDm = { channelId: m.channelId, messageId: m.id };
    else log.warn(`servers: couldn't DM the owner about "${guild.name}". Open your DMs, or approve it with /servers approve in a DM with the bot.`);
  }

  /** Edits the approval DM to show what was decided. */
  async function closeOwnerDm(rec: GuildRecord, text: string, color: number) {
    if (!rec.ownerDm) return;
    try {
      const ch = await client.channels.fetch(rec.ownerDm.channelId);
      if (ch && "messages" in ch) {
        const m = await ch.messages.fetch(rec.ownerDm.messageId);
        const e = new EmbedBuilder().setColor(color).setTitle(truncate(rec.name, 256)).setDescription(text);
        await m.edit({ embeds: [e], components: [] });
      }
    } catch {
      /* the DM is gone; nothing to update */
    }
  }

  async function joined(guild: Guild, atStartup = false) {
    const now = Date.now();
    let rec = store.guild(guild.id);
    const who = await ownerId();
    if (cfg.preApproved.includes(guild.id) || (who && guild.ownerId === who)) {
      rec = { ...(rec ?? { addedAt: now }), id: guild.id, name: guild.name, status: "approved", decidedAt: rec?.decidedAt ?? now, present: true };
      store.saveGuild(rec);
      await syncCommands(guild);
      return;
    }
    if (rec?.status === "approved") {
      store.saveGuild({ ...rec, name: guild.name, present: true });
      await syncCommands(guild);
      return;
    }
    if (rec?.status === "denied") {
      log.info(`servers: "${guild.name}" added me again; leaving (the owner turned it down before)`);
      await say(guild, rec, "👋 My owner hasn't approved this server, so I'm leaving.");
      await guild.leave().catch(() => undefined);
      store.saveGuild({ ...rec, name: guild.name, present: false });
      if (who && !atStartup) {
        await dm(client, who, {
          content: `🚪 **${guild.name}** added the music bot again, so I left (you turned it down before). Changed your mind? Approve it, and they can add me again.`,
          components: [buttons(guild.id, false)],
        });
      }
      return;
    }
    if (rec?.status === "pending") {
      // Already asked. If that DM never went out (DMs were closed), try again.
      const next = { ...rec, name: guild.name, present: true };
      if (!next.ownerDm) await askOwner(guild, next);
      store.saveGuild(next);
      await syncCommands(guild);
      return;
    }
    rec = { id: guild.id, name: guild.name, status: "pending", addedAt: now, present: true };
    rec.noticeChannelId = await say(
      guild,
      undefined,
      "👋 Thanks for adding the music bot! My owner needs to approve this server first. Once they do, the music commands (`/play` and friends) show up here.",
    );
    await askOwner(guild, rec);
    store.saveGuild(rec);
    await syncCommands(guild);
    log.info(`servers: "${guild.name}" (${guild.id}) added me; waiting for approval`);
  }

  function left(guild: Guild) {
    const rec = store.guild(guild.id);
    if (rec) store.saveGuild({ ...rec, present: false });
    store.kvDelete(`commands.${guild.id}`); // the commands go with the bot
    log.info(`servers: no longer in "${guild.name}"`);
  }

  async function approve(id: string): Promise<string> {
    const rec = store.guild(id);
    if (!rec) return "I don't know that server.";
    if (rec.status === "approved") return `**${rec.name}** is already approved.`;
    const next: GuildRecord = { ...rec, status: "approved", decidedAt: Date.now() };
    store.saveGuild(next);
    const guild = client.guilds.cache.get(id);
    if (guild) {
      await syncCommands(guild);
      await say(guild, rec, "✅ This server is approved! Join a voice channel and use `/play` to start the music. `/help` shows everything I can do.");
      await closeOwnerDm(next, "✅ Approved. They can use the music commands now.", Colors.ok);
      log.info(`servers: approved "${rec.name}"`);
      return `✅ Approved **${rec.name}**. Their music commands are ready.`;
    }
    await closeOwnerDm(next, "✅ Approved. The bot isn't in this server any more, so they'll need to add it again.", Colors.ok);
    return `✅ Approved **${rec.name}**. I'm not in that server any more, so they'll need to add me again with the invite link: ${inviteUrl(client.application!.id)}`;
  }

  /** Leaves a server. `block` = leave again straight away if they re-add it; otherwise they'll be asked about again. */
  async function remove(id: string, block: boolean): Promise<string> {
    const rec = store.guild(id);
    const guild = client.guilds.cache.get(id);
    const label = rec?.name ?? guild?.name ?? id;
    if (!rec && !guild) return "I don't know that server.";
    if (guild) {
      await say(guild, rec, block || rec?.status === "pending" ? "👋 My owner didn't approve this server, so I'm leaving." : "👋 My owner has removed the music bot from this server. Bye!");
      await guild.leave().catch((err) => log.warn(`servers: couldn't leave "${label}": ${(err as Error).message}`));
    }
    if (block) {
      const next: GuildRecord = { ...(rec ?? { id, name: label, addedAt: Date.now() }), status: "denied", decidedAt: Date.now(), present: false };
      store.saveGuild(next);
      await closeOwnerDm(next, "🚪 Turned down. I left, and I'll leave again if they add me back.", Colors.muted);
    } else {
      if (rec) await closeOwnerDm(rec, "🚪 Removed. If they add me again, you'll be asked again.", Colors.muted);
      store.forgetGuild(id);
    }
    store.kvDelete(`commands.${id}`);
    log.info(`servers: ${block ? "turned down" : "removed"} "${label}"`);
    return block ? `🚪 Left **${label}**. If they add me again, I'll leave again (and let you know).` : `🚪 Left **${label}**. If they add me again, you'll get a new approval request.`;
  }

  async function syncAll() {
    const inCache = new Set(client.guilds.cache.keys());
    for (const guild of client.guilds.cache.values()) {
      try {
        await joined(guild, true);
      } catch (err) {
        log.error(`servers: couldn't check "${guild.name}"`, err);
      }
    }
    for (const rec of store.guilds()) if (rec.present && !inCache.has(rec.id)) store.saveGuild({ ...rec, present: false });
    const approved = store.guilds("approved").filter((g) => g.present).length;
    const pending = store.guilds("pending").filter((g) => g.present).length;
    log.info(`servers: in ${inCache.size} server(s): ${approved} approved, ${pending} waiting for approval`);
  }

  // ---- owner controls -----------------------------------------------------------------------------
  async function ownerOnly(i: ChatInputCommandInteraction | MessageComponentInteraction): Promise<boolean> {
    if (i.user.id === (await ownerId())) return true;
    await i.reply({ content: "Only the music bot's owner can do that.", flags: MessageFlags.Ephemeral });
    return false;
  }

  function listEmbed(): EmbedBuilder {
    const line = (g: GuildRecord) => `• **${truncate(g.name, 60)}**${g.present ? "" : " *(not in it now)*"} · \`${g.id}\``;
    const section = (title: string, rows: GuildRecord[]) => (rows.length ? `**${title} (${rows.length})**\n${rows.map(line).join("\n")}` : "");
    const pre = cfg.preApproved.filter((id) => !store.guild(id));
    const text = [
      section("✅ Approved", store.guilds("approved")),
      section("⏳ Waiting for you", store.guilds("pending")),
      section("🚪 Turned down", store.guilds("denied")),
      pre.length ? `**Pre-approved (ALLOWED_GUILD_IDS), not joined yet**\n${pre.map((id) => `• \`${id}\``).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle("🎵 Music bot servers")
      .setDescription(truncate(text || "I'm not in any servers yet. Share the invite link from the container log.", 4000))
      .setFooter({ text: "/servers approve · /servers remove" });
  }

  const serverOption = (o: import("discord.js").SlashCommandStringOption) => o.setName("server").setDescription("Start typing the server's name").setRequired(true).setAutocomplete(true);
  const serversJson = new SlashCommandBuilder()
    .setName("servers")
    .setDescription("(Owner) Which servers can use the music bot")
    .addSubcommand((s) => s.setName("list").setDescription("Every server the bot is in or has been asked about"))
    .addSubcommand((s) => s.setName("approve").setDescription("Let a server use the bot").addStringOption(serverOption))
    .addSubcommand((s) =>
      s
        .setName("remove")
        .setDescription("Make the bot leave a server")
        .addStringOption(serverOption)
        .addBooleanOption((o) => o.setName("block").setDescription("Leave again automatically if they re-add it (default: ask me again)")),
    )
    .toJSON();

  return {
    name: "servers",
    isApproved,
    joined,
    left,
    syncAll,
    ownerId,
    globalCommands: [
      {
        json: { ...serversJson, contexts: [InteractionContextType.BotDM], integration_types: [ApplicationIntegrationType.GuildInstall] },
        execute: async (i) => {
          if (!(await ownerOnly(i))) return;
          const sub = i.options.getSubcommand();
          if (sub === "list") return void (await i.reply({ embeds: [listEmbed()] }));
          const id = i.options.getString("server", true).trim();
          await i.deferReply();
          await i.editReply(sub === "approve" ? await approve(id) : await remove(id, i.options.getBoolean("block") ?? false));
        },
        autocomplete: async (i) => {
          if (i.user.id !== (await ownerId())) return void (await i.respond([]));
          const typed = i.options.getFocused().toLowerCase();
          const sub = i.options.getSubcommand();
          const rows = store.guilds().filter((g) => (sub === "approve" ? g.status !== "approved" : g.present || g.status !== "denied"));
          const icon = { approved: "✅", pending: "⏳", denied: "🚪" } as const;
          await i.respond(
            rows
              .filter((g) => g.name.toLowerCase().includes(typed) || g.id.includes(typed))
              .slice(0, 25)
              .map((g) => ({ name: truncate(`${icon[g.status]} ${g.name}${g.present ? "" : " (not in it now)"}`, 100), value: g.id })),
          );
        },
      },
    ],
    components: {
      srv: async (i) => {
        if (!(await ownerOnly(i))) return;
        const [, action, id] = i.customId.split(":");
        await i.deferReply();
        await i.editReply(action === "approve" ? await approve(id) : await remove(id, true));
      },
    },
  };
}
