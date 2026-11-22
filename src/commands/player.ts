/**
 * The music commands: /play, /radio, /pause, /skip, /previous, /stop,
 * /shuffle, /loop, /seek, /volume, /queue, /remove, /clear, /nowplaying,
 * /lyrics and /setup nowplaying. One player per server. Anyone in the bot's
 * voice channel (and server admins) can use the controls.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type BaseInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Message,
  type MessageComponentInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SendableChannels,
  type VoiceBasedChannel,
} from "discord.js";
import type { Config } from "../config.js";
import type { Store } from "../core/db.js";
import { Colors, isServerAdmin, truncate } from "../core/discord.js";
import { LiveMessage, type LivePayload } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { CommandDef, Feature } from "../core/router.js";
import { TtlCache } from "../core/ttlCache.js";
import { NEXT_LOOP, buildCard, forgetCover, idleCard } from "../player/card.js";
import { fmtDuration, parseTime, songLabel, type LoopMode, type Track } from "../player/queue.js";
import { MusicSession, type NowPlayingDisplay, type Radio } from "../player/session.js";
import type { VoiceLinkFactory } from "../player/voice.js";
import type { Lyrics, SubsonicClient, SubsonicPlaylist, SubsonicSong } from "../services/subsonic.js";

const PAGE = 10;

export interface PlayerDeps {
  cfg: Config;
  store: Store;
  client: Client;
  subsonic: SubsonicClient;
  link: VoiceLinkFactory;
  /** Card redraw delay; tests use 0. */
  renderDelayMs?: number;
}

type Interactive = ChatInputCommandInteraction | MessageComponentInteraction;

export function playerFeature(d: PlayerDeps): Feature & { sessions: Map<string, MusicSession> } {
  const { client, store, subsonic, cfg } = d;
  const sessions = new Map<string, MusicSession>();
  const boards = new Map<string, LiveMessage>();
  const playlistCache = new TtlCache<string, SubsonicPlaylist[]>(5 * 60_000);
  /** The card in the voice channel's chat, per server (when there's no board). */
  const chatCards = new Map<string, { channel: SendableChannels; message?: Message }>();

  const board = (guildId: string) => {
    let b = boards.get(guildId);
    if (!b) boards.set(guildId, (b = new LiveMessage(client, store, `nowplaying.${guildId}`)));
    return b;
  };

  const memberVoice = (i: BaseInteraction): VoiceBasedChannel | null => (i.member as GuildMember | null)?.voice?.channel ?? null;
  const name = (i: BaseInteraction) => (i.member as GuildMember | null)?.displayName ?? i.user.displayName ?? i.user.username;

  /** Controls are for people listening with the bot, and server admins. Returns why not, or null. */
  function cannotControl(i: BaseInteraction, s: MusicSession | undefined): string | null {
    if (!s || s.ended) return "Nothing is playing. Start something with `/play`.";
    if (isServerAdmin(i)) return null;
    return memberVoice(i)?.id === s.voiceChannelId ? null : `Join <#${s.voiceChannelId}> to control the music.`;
  }

  function displayFor(guildId: string): NowPlayingDisplay {
    return async (payload, ended) => {
      const b = board(guildId);
      if (b.location) {
        await b.update(ended ? idleCard() : payload);
        if (ended) chatCards.delete(guildId);
        return;
      }
      const chat = chatCards.get(guildId);
      if (!chat) return;
      if (chat.message) {
        const edited = await chat.message.edit({ ...payload, ...(payload.files ? { attachments: [] } : {}) } as never).catch(() => undefined);
        if (edited) {
          chat.message = edited;
          if (ended) chatCards.delete(guildId);
          return;
        }
      }
      if (ended) {
        chatCards.delete(guildId);
        return;
      }
      chat.message = await chat.channel.send(await freshPayload(guildId, payload)).catch(() => undefined);
    };
  }

  /** A brand-new message needs the cover attached again. */
  async function freshPayload(guildId: string, payload: LivePayload): Promise<LivePayload> {
    const s = sessions.get(guildId);
    if (!s || payload.files) return payload;
    forgetCover(guildId);
    return buildCard(s);
  }

  async function ensureSession(i: Interactive): Promise<MusicSession | string> {
    const voice = memberVoice(i);
    if (!voice) return "Join a voice channel first, then try again.";
    const guildId = voice.guild.id;
    let s = sessions.get(guildId);
    if (s && !s.ended && s.voiceChannelId && s.voiceChannelId !== voice.id && s.current && !isServerAdmin(i)) {
      return `I'm already playing in <#${s.voiceChannelId}>. Join there, or ask someone there to \`/stop\` first.`;
    }
    const me = voice.guild.members.me;
    const perms = me ? voice.permissionsFor(me) : null;
    if (perms && (!perms.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak))) {
      return `I need the **Connect** and **Speak** permissions in <#${voice.id}>.`;
    }
    if (!s || s.ended) {
      const created: MusicSession = new MusicSession({
        guildId,
        subsonic,
        link: d.link(),
        idleMinutes: cfg.idleMinutes,
        volume: store.settings(guildId).volume,
        display: displayFor(guildId),
        card: buildCard,
        renderDelayMs: d.renderDelayMs,
        onEnd: () => {
          if (sessions.get(guildId) === created) sessions.delete(guildId);
        },
      });
      s = created;
      sessions.set(guildId, s);
      // The card goes in the voice channel's chat (or wherever /play was used if that's not possible).
      const chat = voice.isSendable() ? (voice as SendableChannels) : i.channel?.isSendable() ? (i.channel as SendableChannels) : undefined;
      if (chat) chatCards.set(guildId, { channel: chat });
    }
    await s.join(voice);
    return s;
  }

  // ---- finding music ------------------------------------------------------------------------------
  async function resolve(query: string): Promise<{ tracks: SubsonicSong[]; label: string }> {
    const [kind, ...rest] = query.split(":");
    const id = rest.join(":");
    switch (kind) {
      case "s": {
        const s = await subsonic.song(id);
        return { tracks: [s], label: `**${songLabel(s)}**` };
      }
      case "a": {
        const a = await subsonic.album(id);
        return { tracks: a.song, label: `the album **${a.name}**${a.artist ? ` by ${a.artist}` : ""} (${a.song.length} songs)` };
      }
      case "p": {
        const p = await subsonic.playlist(id);
        return { tracks: p.entry, label: `the playlist **${p.name}** (${p.entry.length} songs)` };
      }
      case "ar": {
        const artist = await subsonic.artist(id);
        const songs = await subsonic.topSongs(artist.name, 25);
        return { tracks: songs, label: `top songs by **${artist.name}** (${songs.length})` };
      }
      default: {
        // Typed without picking a suggestion: the best song match.
        const r = await subsonic.search(query, { song: 1, album: 0, artist: 0 });
        const s = r.songs[0];
        return s ? { tracks: [s], label: `**${songLabel(s)}**` } : { tracks: [], label: "" };
      }
    }
  }

  async function suggestions(typed: string, withPlaylists: boolean) {
    if (typed.trim().length < 2) return [];
    const [r, lists] = await Promise.all([
      subsonic.search(typed, { song: 10, album: 6, artist: 4 }),
      !withPlaylists ? Promise.resolve([] as SubsonicPlaylist[]) : (playlistCache.get("all") ?? subsonic.playlists().catch(() => [] as SubsonicPlaylist[])),
    ]);
    if (withPlaylists) playlistCache.set("all", lists);
    const lower = typed.toLowerCase();
    return [
      ...r.artists.map((a) => ({ name: `👤 ${a.name}${withPlaylists ? " (top songs)" : ""}`, value: `ar:${a.id}` })),
      ...r.albums.map((a) => ({ name: `💿 ${a.name}${a.artist ? ` by ${a.artist}` : ""}`, value: `a:${a.id}` })),
      ...lists.filter((p) => p.name.toLowerCase().includes(lower)).map((p) => ({ name: `📃 ${p.name} (playlist)`, value: `p:${p.id}` })),
      ...r.songs.map((s) => ({ name: `🎵 ${songLabel(s)}`, value: `s:${s.id}` })),
    ]
      .filter((c) => c.value.length <= 100)
      .map((c) => ({ ...c, name: truncate(c.name, 100) }))
      .slice(0, 25);
  }

  // ---- commands -----------------------------------------------------------------------------------
  async function play(i: ChatInputCommandInteraction) {
    const query = i.options.getString("query", true).trim();
    const next = i.options.getBoolean("next") ?? false;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { tracks, label } = await resolve(query);
    if (!tracks.length) return void (await i.editReply(`🔍 Nothing in the library matches **${truncate(query, 80)}**. Pick from the suggestions as you type.`));
    const s = await ensureSession(i);
    if (typeof s === "string") return void (await i.editReply(s));
    const wasPlaying = Boolean(s.current);
    const added = await s.enqueue(
      tracks.map((song): Track => ({ song, requestedBy: name(i) })),
      next,
    );
    const capped = added < tracks.length ? ` (the queue is full, so I added ${added})` : "";
    await i.editReply(wasPlaying ? `➕ Queued ${label}${next ? " to play next" : ""}${capped}.` : `▶️ Playing ${label} in <#${s.voiceChannelId}>${capped}.`);
  }

  async function radio(i: ChatInputCommandInteraction) {
    const like = i.options.getString("like")?.trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const existing = sessions.get(i.guildId!);
    if (!like && existing?.radio && !existing.ended) {
      const denied = cannotControl(i, existing);
      if (denied) return void (await i.editReply(denied));
      await existing.setRadio(undefined);
      return void (await i.editReply("📻 Radio off. Anything you queued keeps playing."));
    }
    let r: Radio = { mode: "random" };
    if (like) {
      const seed = await seedFor(like);
      if (!seed) return void (await i.editReply(`🔍 Nothing in the library matches **${truncate(like, 80)}**. Pick from the suggestions as you type.`));
      r = { mode: "similar", ...seed };
    }
    const s = await ensureSession(i);
    if (typeof s === "string") return void (await i.editReply(s));
    await s.setRadio(r);
    await i.editReply(
      r.mode === "similar"
        ? `📻 Radio on: songs like ${r.seedLabel} in <#${s.voiceChannelId}>. \`/radio\` again turns it off.`
        : `📻 Radio on: random songs from the library in <#${s.voiceChannelId}>. \`/radio\` again turns it off.`,
    );
  }

  async function seedFor(value: string): Promise<{ seedId: string; seedLabel: string } | undefined> {
    const [kind, ...rest] = value.split(":");
    const id = rest.join(":");
    if (kind === "s") return { seedId: id, seedLabel: `**${songLabel(await subsonic.song(id))}**` };
    if (kind === "a") {
      const a = await subsonic.album(id);
      return { seedId: id, seedLabel: `**${a.name}**${a.artist ? ` by ${a.artist}` : ""}` };
    }
    if (kind === "ar") return { seedId: id, seedLabel: `**${(await subsonic.artist(id)).name}**` };
    const r = await subsonic.search(value, { song: 1, album: 0, artist: 1 });
    if (r.artists[0]) return { seedId: r.artists[0].id, seedLabel: `**${r.artists[0].name}**` };
    if (r.songs[0]) return { seedId: r.songs[0].id, seedLabel: `**${songLabel(r.songs[0])}**` };
    return undefined;
  }

  /** Runs a control after checking the member may use it; `fn` returns the reply text. */
  async function control(i: Interactive, fn: (s: MusicSession) => Promise<string | undefined> | string | undefined) {
    const s = sessions.get(i.guildId!);
    const denied = cannotControl(i, s);
    if (denied) return void (await i.reply({ content: denied, flags: MessageFlags.Ephemeral }));
    if (i.isMessageComponent()) await i.deferUpdate();
    else await i.deferReply({ flags: MessageFlags.Ephemeral });
    const text = await fn(s!);
    if (i.isMessageComponent()) {
      if (text && /^(⚠️|🔍|❌)/.test(text)) await i.followUp({ content: text, flags: MessageFlags.Ephemeral });
    } else await i.editReply(text ?? "✅ Done.");
  }

  const doPause = (s: MusicSession) => s.togglePause().then((p) => (p ? "⏸️ Paused." : "▶️ Resumed."));
  const doSkip = async (s: MusicSession) => {
    const was = s.current;
    await s.skip();
    return was ? `⏭️ Skipped **${truncate(songLabel(was.song), 80)}**.` : "⏭️ Skipped.";
  };
  const doPrevious = async (s: MusicSession) => {
    const t = await s.previous();
    return t ? `⏮️ Back to **${truncate(songLabel(t.song), 80)}**.` : "⏮️ Nothing to go back to.";
  };
  const doStop = async (s: MusicSession, by: string) => {
    await s.destroy(`Stopped by ${by}.`);
    return "⏹️ Stopped, cleared the queue and left the channel.";
  };
  const doShuffle = (s: MusicSession) => {
    if (s.queue.length < 2) return "🔀 There's not enough in the queue to shuffle.";
    s.shuffle();
    return `🔀 Shuffled ${s.queue.length} songs.`;
  };
  const doLoop = (s: MusicSession, mode: LoopMode) => {
    s.setLoop(mode);
    return mode === "song" ? "🔂 Looping this song." : mode === "queue" ? "🔁 Looping the queue: finished songs go to the back." : "➡️ Loop off.";
  };
  const doSimilar = async (s: MusicSession) => {
    const t = s.current;
    if (!t) return "⚠️ Nothing is playing.";
    const seedLabel = `**${truncate(songLabel(t.song), 80)}**`;
    await s.setRadio({ mode: "similar", seedId: t.song.id, seedLabel });
    return `✨ Radio on: songs like ${seedLabel}. Anything you queued plays first.`;
  };

  function queuePage(guildId: string, page: number): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const s = sessions.get(guildId);
    const e = new EmbedBuilder().setColor(Colors.music).setTitle("📜 Queue");
    if (!s?.current || s.ended) return { embeds: [e.setDescription("Nothing is playing. Start something with `/play`.")], components: [] };
    const list = s.queue.list();
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const lines = list
      .slice(p * PAGE, p * PAGE + PAGE)
      .map((t, idx) => `\`${p * PAGE + idx + 1}.\` ${truncate(songLabel(t.song), 80)} · ${fmtDuration(t.song.duration)}${t.radio ? " 📻" : ""}`);
    e.setDescription(`**Now:** ${truncate(songLabel(s.current.song), 100)} · ${fmtDuration(Math.floor(s.position))}${s.current.song.duration ? ` / ${fmtDuration(s.current.song.duration)}` : ""}\n\n${lines.join("\n") || "*Nothing else queued.*"}`).setFooter({
      text: `${list.length} queued · ${fmtDuration(s.queue.duration())}${pages > 1 ? ` · page ${p + 1} of ${pages}` : ""}${s.radio ? " · radio on" : ""} · /remove takes a number`,
    });
    const components =
      pages > 1
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`queue:${p - 1}`).setEmoji("◀️").setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
              new ButtonBuilder().setCustomId(`queue:${p + 1}`).setEmoji("▶️").setLabel("More").setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1),
            ),
          ]
        : [];
    return { embeds: [e], components };
  }

  function lyricsEmbed(s: MusicSession, lyrics: Lyrics | undefined): EmbedBuilder {
    const t = s.current!;
    const e = new EmbedBuilder().setColor(Colors.music).setTitle(truncate(`📝 ${songLabel(t.song)}`, 256));
    if (!lyrics?.lines.some((l) => l.value.trim())) return e.setDescription("I couldn't find lyrics for this song in the library.");
    let lines = lyrics.lines.map((l) => l.value);
    if (lyrics.synced) {
      const ms = s.position * 1000;
      let at = -1;
      lyrics.lines.forEach((l, idx) => {
        if ((l.start ?? Infinity) <= ms) at = idx;
      });
      if (at >= 0) lines = lines.map((v, idx) => (idx === at && v.trim() ? `▶ **${v}**` : v));
      // Long song: show from a few lines before the current one.
      const text = lines.join("\n");
      if (text.length > 3900 && at > 4) lines = ["…", ...lines.slice(at - 4)];
    }
    return e.setDescription(truncate(lines.join("\n").replace(/\n{3,}/g, "\n\n"), 4000)).setFooter({ text: lyrics.synced ? "▶ marks where the song is now" : "From the music library" });
  }

  async function lyrics(i: Interactive, visibleToAll = false) {
    const s = sessions.get(i.guildId!);
    if (!s?.current || s.ended) return void (await i.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral }));
    await i.deferReply(visibleToAll ? {} : { flags: MessageFlags.Ephemeral });
    const l = await subsonic.lyrics(s.current.song);
    await i.editReply({ embeds: [lyricsEmbed(s, l)] });
  }

  async function nowPlaying(i: ChatInputCommandInteraction) {
    const guildId = i.guildId!;
    const s = sessions.get(guildId);
    if (!s?.current || s.ended) return void (await i.reply({ content: "Nothing is playing. Start something with `/play`.", flags: MessageFlags.Ephemeral }));
    const b = board(guildId);
    if (b.location) return void (await i.reply({ content: `🎶 The now-playing board is here: ${b.link(guildId)}`, flags: MessageFlags.Ephemeral }));
    if (!i.channel?.isSendable()) return void (await i.reply({ content: "I can't post in this channel.", flags: MessageFlags.Ephemeral }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const old = chatCards.get(guildId)?.message;
    await old?.delete().catch(() => undefined);
    chatCards.set(guildId, { channel: i.channel as SendableChannels });
    forgetCover(guildId);
    await s.show();
    await i.editReply("🎶 Moved the now-playing card here.");
  }

  async function setupBoard(i: ChatInputCommandInteraction) {
    const guildId = i.guildId!;
    const channel = i.options.getChannel("channel");
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const b = board(guildId);
    if (!channel) {
      const removed = await b.remove();
      return void (await i.editReply(removed ? "🗑️ Removed the now-playing board. Cards go back to the voice channel's chat." : "There's no now-playing board to remove."));
    }
    const s = sessions.get(guildId);
    forgetCover(guildId);
    const msg = await b.place(channel.id, s?.current && !s.ended ? await buildCard(s) : idleCard());
    await old(guildId);
    await i.editReply(`🎶 Now-playing board posted in <#${msg.channelId}>. It updates with every song. Run this again without a channel to remove it.`);
  }

  /** Once a board exists, the chat card is retired. */
  async function old(guildId: string) {
    const chat = chatCards.get(guildId);
    if (chat?.message) await chat.message.delete().catch(() => undefined);
    if (chat) chat.message = undefined;
  }

  // ---- slash command definitions ------------------------------------------------------------------
  const cmd = (b: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }, execute: CommandDef["execute"], autocomplete?: CommandDef["autocomplete"]): CommandDef => ({
    json: { ...b.toJSON(), contexts: [InteractionContextType.Guild] },
    execute,
    autocomplete,
  });
  const simple = (nameStr: string, description: string, fn: (s: MusicSession, i: ChatInputCommandInteraction) => Promise<string | undefined> | string | undefined) =>
    cmd(new SlashCommandBuilder().setName(nameStr).setDescription(description), (i) => control(i, (s) => fn(s, i)));

  const guildCommands: CommandDef[] = [
    cmd(
      new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play a song, album, artist or playlist from the library")
        .addStringOption((o) => o.setName("query").setDescription("Start typing a song, album, artist or playlist").setRequired(true).setAutocomplete(true))
        .addBooleanOption((o) => o.setName("next").setDescription("Play it next instead of at the end of the queue")),
      play,
      async (i: AutocompleteInteraction) => void (await i.respond(await suggestions(i.options.getFocused(), true))),
    ),
    cmd(
      new SlashCommandBuilder()
        .setName("radio")
        .setDescription("Endless music: random songs, or songs like one you pick. Run it again to turn it off")
        .addStringOption((o) => o.setName("like").setDescription("Songs like this song, album or artist (leave empty for random)").setAutocomplete(true)),
      radio,
      async (i: AutocompleteInteraction) => void (await i.respond(await suggestions(i.options.getFocused(), false))),
    ),
    simple("pause", "Pause or resume the music", doPause),
    simple("skip", "Skip to the next song", doSkip),
    simple("previous", "Go back to the previous song", doPrevious),
    simple("stop", "Stop, clear the queue and leave the voice channel", (s, i) => doStop(s, name(i))),
    simple("shuffle", "Shuffle the queue", doShuffle),
    cmd(
      new SlashCommandBuilder()
        .setName("loop")
        .setDescription("Repeat this song, repeat the whole queue, or turn looping off")
        .addStringOption((o) =>
          o.setName("mode").setDescription("What to repeat").setRequired(true).addChoices({ name: "This song", value: "song" }, { name: "The whole queue", value: "queue" }, { name: "Off", value: "off" }),
        ),
      (i) => control(i, (s) => doLoop(s, i.options.getString("mode", true) as LoopMode)),
    ),
    cmd(
      new SlashCommandBuilder()
        .setName("seek")
        .setDescription("Jump to a time in the song, e.g. 1:30, or +30 / -15 to skip ahead or back")
        .addStringOption((o) => o.setName("time").setDescription("Like 1:30, 90, 2m, +30 or -15").setRequired(true).setMaxLength(12)),
      (i) =>
        control(i, async (s) => {
          const to = parseTime(i.options.getString("time", true), s.position);
          if (to === undefined) return "⚠️ I didn't understand that time. Try something like `1:30`, `90`, `+30` or `-15`.";
          const at = await s.seek(to);
          return at === undefined ? "⚠️ Nothing is playing." : `⏩ Jumped to ${fmtDuration(at)}.`;
        }),
    ),
    cmd(
      new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Set the music volume for this server (100 is normal)")
        .addIntegerOption((o) => o.setName("level").setDescription("1 to 150 (leave empty to see the current volume)").setMinValue(1).setMaxValue(150)),
      async (i) => {
        const level = i.options.getInteger("level");
        const guildId = i.guildId!;
        if (level === null) {
          return void (await i.reply({ content: `🔊 The volume is **${store.settings(guildId).volume}%**. \`/volume level:80\` changes it.`, flags: MessageFlags.Ephemeral }));
        }
        const s = sessions.get(guildId);
        if (!s || s.ended) {
          // Nothing playing: anyone can set it for next time.
          store.updateSettings(guildId, { volume: level });
          return void (await i.reply({ content: `🔊 Volume set to **${level}%** for this server.`, flags: MessageFlags.Ephemeral }));
        }
        await control(i, async (sess) => {
          store.updateSettings(guildId, { volume: level });
          await sess.setVolume(level);
          return `🔊 Volume set to **${level}%**.`;
        });
      },
    ),
    cmd(
      new SlashCommandBuilder()
        .setName("queue")
        .setDescription("See what's playing and what's next")
        .addIntegerOption((o) => o.setName("page").setDescription("Which page").setMinValue(1)),
      async (i) => void (await i.reply({ ...queuePage(i.guildId!, (i.options.getInteger("page") ?? 1) - 1), flags: MessageFlags.Ephemeral })),
    ),
    cmd(
      new SlashCommandBuilder()
        .setName("remove")
        .setDescription("Remove a song from the queue")
        .addIntegerOption((o) => o.setName("number").setDescription("Its number in /queue").setRequired(true).setMinValue(1)),
      (i) =>
        control(i, (s) => {
          const t = s.remove(i.options.getInteger("number", true));
          return t ? `🗑️ Removed **${truncate(songLabel(t.song), 80)}** from the queue.` : `⚠️ There's no song number ${i.options.getInteger("number", true)} in the queue.`;
        }),
    ),
    simple("clear", "Clear the queue (the current song keeps playing)", (s) => {
      const n = s.clearQueue();
      return n ? `🧹 Cleared ${n} song${n === 1 ? "" : "s"} from the queue.` : "The queue is already empty.";
    }),
    cmd(new SlashCommandBuilder().setName("nowplaying").setDescription("Show the now-playing card in this channel"), nowPlaying),
    cmd(
      new SlashCommandBuilder()
        .setName("lyrics")
        .setDescription("Show the lyrics of the song that's playing")
        .addBooleanOption((o) => o.setName("show_everyone").setDescription("Post them for everyone instead of just you")),
      (i) => lyrics(i, i.options.getBoolean("show_everyone") ?? false),
    ),
    cmd(
      new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Server settings for the music bot")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sc) =>
          sc
            .setName("nowplaying")
            .setDescription("Keep a now-playing board in a channel (leave the channel empty to remove it)")
            .addChannelOption((o) => o.setName("channel").setDescription("Where the board lives").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
        ),
      setupBoard,
    ),
  ];

  // ---- buttons --------------------------------------------------------------------------------------
  async function onButton(i: MessageComponentInteraction) {
    const action = i.customId.split(":")[1];
    const guildId = i.guildId!;
    const s = sessions.get(guildId);
    switch (action) {
      case "queue":
        return void (await i.reply({ ...queuePage(guildId, 0), flags: MessageFlags.Ephemeral }));
      case "lyrics":
        return lyrics(i);
      case "pause":
        return control(i, doPause);
      case "skip":
        return control(i, doSkip);
      case "previous":
        return control(i, doPrevious);
      case "stop":
        return control(i, (sess) => doStop(sess, name(i)));
      case "shuffle":
        return control(i, doShuffle);
      case "loop":
        return control(i, (sess) => doLoop(sess, NEXT_LOOP[sess.loop]));
      case "radio":
        return control(i, async (sess) => {
          await sess.setRadio(sess.radio ? undefined : { mode: "random" });
          return undefined;
        });
      case "similar":
        return control(i, (sess) => (sess.radio?.mode === "similar" ? sess.setRadio(undefined).then(() => undefined) : doSimilar(sess)));
    }
  }

  return {
    name: "player",
    sessions,
    guildCommands,
    components: {
      player: onButton,
      queue: async (i) => void (await i.update(queuePage(i.guildId!, Number(i.customId.split(":")[1]) || 0))),
    },
    start: () => {
      // Leave when nobody's left listening; follow the bot if someone drags it to another channel.
      client.on("voiceStateUpdate", (oldState, newState) => {
        const s = sessions.get(newState.guild.id);
        if (!s || s.ended) return;
        if (newState.id === client.user?.id && newState.channelId && newState.channelId !== s.voiceChannelId) s.noteMoved(newState.channelId);
        if (oldState.channelId !== s.voiceChannelId && newState.channelId !== s.voiceChannelId) return;
        const channel = s.voiceChannelId ? (newState.guild.channels.cache.get(s.voiceChannelId) as VoiceBasedChannel | undefined) : undefined;
        s.noteListeners(channel?.members.filter((m) => !m.user.bot).size ?? 0);
      });
    },
    stop: async () => {
      await Promise.all([...sessions.values()].map((s) => s.destroy("The music bot is restarting. Start the music again in a minute.")));
      log.info("music: stopped all players");
    },
  };
}
