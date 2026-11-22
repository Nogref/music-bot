/** /help: what the bot can do, in plain words. */
import { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { Colors } from "../core/discord.js";
import type { Feature } from "../core/router.js";

export function helpFeature(): Feature {
  const embed = () =>
    new EmbedBuilder()
      .setColor(Colors.music)
      .setTitle("🎶 Music bot")
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
        {
          name: "🔧 Server admins",
          value: "`/setup nowplaying` keeps a now-playing board in a channel. Admins can also control the music from anywhere.",
        },
      )
      .setFooter({ text: "I leave the voice channel when the music's been stopped or everyone's left for a few minutes." });
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
