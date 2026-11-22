/** /help: what the bot can do, in plain words. */
import { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { Colors } from "../core/discord.js";
import type { Feature } from "../core/router.js";

export function helpFeature(opts: { apex?: boolean } = {}): Feature {
  const embed = () => {
    const e = new EmbedBuilder()
      .setColor(Colors.music)
      .setTitle(opts.apex ? "🎶 Music bot (and Apex stats)" : "🎶 Music bot")
      .setDescription("I play music from our library in voice channels. Join a voice channel first, then:")
      .addFields(
        {
          name: "▶️ Playing",
          value: [
            "`/play`: a song, album, artist or playlist (start typing and pick a suggestion). Add `next` to play it next.",
            "`/radio`: endless random songs. `/radio like:` plays songs like a song, album or artist you pick.",
            "`/lyrics`: the words to what's playing.",
          ].join("\n"),
        },
        {
          name: "⏯️ Controls",
          value: [
            "`/pause` · `/skip` · `/previous` · `/stop`",
            "`/seek 1:30` (or `+30`, `-15`) · `/volume 80` · `/loop`",
            "The buttons on the now-playing card do the same. Anyone in my voice channel can use them.",
          ].join("\n"),
        },
        {
          name: "📜 The queue",
          value: "`/queue` shows what's next · `/shuffle` · `/remove` a song by its number · `/clear` everything after this song",
        },
      );
    if (opts.apex) {
      e.addFields({
        name: "🎯 Apex Legends",
        value: [
          "`/apex link`: link your account once (puts you on the squad leaderboard).",
          "`/apex me` · `/apex stats @friend`: rank, RP, level and banner trackers.",
          "`/apex map`: Pubs and Ranked maps now and next · `/apex predator` · `/apex servers` · `/apex leaderboard`",
        ].join("\n"),
      });
    }
    e.addFields({
      name: "🔧 Server admins",
      value: `\`/setup nowplaying\` keeps a now-playing board in a channel.${opts.apex ? " `/setup apex-leaderboard` keeps the squad leaderboard in one (rank-up shout-outs go there too; `/setup apex-shoutouts` moves or stops them)." : ""} Admins can also control the music from anywhere.`,
    });
    return e.setFooter({ text: "I leave the voice channel when the music's been stopped or everyone's left for a few minutes." });
  };
  return {
    name: "help",
    guildCommands: [
      {
        json: { ...new SlashCommandBuilder().setName("help").setDescription("What the music bot can do").toJSON(), contexts: [InteractionContextType.Guild] },
        execute: async (i) => void (await i.reply({ embeds: [embed()], flags: MessageFlags.Ephemeral })),
      },
    ],
  };
}
