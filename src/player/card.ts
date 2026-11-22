/** The now-playing card: song, progress, what's next, and the control buttons. */
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { Colors, truncate } from "../core/discord.js";
import type { LivePayload } from "../core/liveMessage.js";
import { fmtDuration, songLabel, type LoopMode } from "./queue.js";
import type { MusicSession } from "./session.js";

const LOOP_LABEL: Record<LoopMode, string> = { off: "Loop", song: "Loop: song", queue: "Loop: queue" };
export const NEXT_LOOP: Record<LoopMode, LoopMode> = { off: "queue", queue: "song", song: "off" };

export function controls(s: MusicSession): ActionRowBuilder<ButtonBuilder>[] {
  const b = (id: string, emoji: string, label: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`player:${id}`).setEmoji(emoji).setLabel(label).setStyle(style);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b("previous", "⏮️", "Back"),
      b("pause", s.paused ? "▶️" : "⏸️", s.paused ? "Resume" : "Pause", s.paused ? ButtonStyle.Success : ButtonStyle.Secondary),
      b("skip", "⏭️", "Skip"),
      b("loop", "🔁", LOOP_LABEL[s.loop], s.loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Success),
      b("stop", "⏹️", "Stop", ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b("shuffle", "🔀", "Shuffle"),
      b("radio", "📻", s.radio ? "Radio on" : "Radio", s.radio ? ButtonStyle.Success : ButtonStyle.Secondary),
      b("similar", "✨", "More like this", s.radio?.mode === "similar" ? ButtonStyle.Success : ButtonStyle.Secondary),
      b("lyrics", "📝", "Lyrics"),
      b("queue", "📜", "Queue"),
    ),
  ];
}

export function radioText(s: MusicSession): string | undefined {
  if (!s.radio) return undefined;
  return s.radio.mode === "similar" ? `📻 Radio: songs like ${s.radio.seedLabel}` : "📻 Radio: random songs from the library";
}

/** Covers are re-uploaded only when the song changes; edits in between keep the attachment. */
const lastCover = new Map<string, string>();

/** The next card will attach the cover again (it's going into a new message). */
export function forgetCover(guildId: string): void {
  lastCover.delete(guildId);
}

export async function buildCard(s: MusicSession, final?: string): Promise<LivePayload> {
  const t = s.current;
  const embed = new EmbedBuilder().setColor(Colors.music);
  if (final || !t) {
    lastCover.delete(s.guildId);
    embed
      .setColor(Colors.muted)
      .setTitle(final ? "⏹️ Music stopped" : "🎶 Queue finished")
      .setDescription(final ?? `Add more with \`/play\`, or I'll leave in ${s.idleMinutes} min.`);
    return { embeds: [embed], components: [], files: [], allowedMentions: { parse: [] } };
  }

  const song = t.song;
  const pos = Math.floor(s.position);
  const dur = song.duration;
  const progress = s.paused
    ? `⏸️ Paused at ${fmtDuration(pos)}${dur ? ` / ${fmtDuration(dur)}` : ""}`
    : `▶️ ${fmtDuration(pos)}${dur ? ` / ${fmtDuration(dur)} · ends <t:${Math.floor(Date.now() / 1000 + Math.max(0, dur - pos))}:R>` : ""}`;
  const upNext = s.queue
    .list()
    .slice(0, 3)
    .map((q, i) => `${i + 1}. ${truncate(songLabel(q.song), 70)}${q.radio ? " 📻" : ""}`)
    .join("\n");
  const status = [
    s.loop === "song" ? "🔂 Looping this song" : s.loop === "queue" ? "🔁 Looping the queue" : "",
    radioText(s) ?? "",
    s.volume !== 100 ? `🔊 ${s.volume}%` : "",
  ].filter(Boolean);

  embed
    .setAuthor({ name: "Now playing" })
    .setTitle(truncate(`${s.paused ? "⏸️" : "🎶"} ${song.title}`, 256))
    .setDescription(
      [
        [song.artist && `**${song.artist}**`, song.album && `*${song.album}*`].filter(Boolean).join(" · "),
        progress,
        s.voiceChannelId ? `🔊 <#${s.voiceChannelId}>` : "",
        status.join(" · "),
        s.radioNote ? `-# ${s.radioNote}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setFooter({ text: `${t.radio ? "📻 Radio pick" : `Added by ${t.requestedBy}`}${s.queue.length ? ` · ${s.queue.length} in the queue` : ""}` });
  if (upNext) embed.addFields({ name: "Up next", value: upNext });

  let files: AttachmentBuilder[] | undefined;
  if (song.coverArt) {
    if (lastCover.get(s.guildId) !== song.coverArt) {
      try {
        files = [new AttachmentBuilder(await s.subsonic.coverArt(song.coverArt, 300), { name: "cover.jpg" })];
        lastCover.set(s.guildId, song.coverArt);
      } catch {
        files = [];
        lastCover.delete(s.guildId);
      }
    }
    if (lastCover.has(s.guildId)) embed.setThumbnail("attachment://cover.jpg");
  } else if (lastCover.has(s.guildId)) {
    lastCover.delete(s.guildId);
    files = []; // clear the previous song's cover
  }
  return { embeds: [embed], components: controls(s), ...(files ? { files } : {}), allowedMentions: { parse: [] } };
}

/** A card shown when nothing is playing (for the board). */
export function idleCard(): LivePayload {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.muted)
        .setTitle("🎶 Nothing playing")
        .setDescription("Join a voice channel and use `/play` to pick something, or `/radio` for songs from the library."),
    ],
    components: [],
    files: [],
  };
}
