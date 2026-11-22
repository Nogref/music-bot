/** /setup: server-admin settings, gathered from each feature (only admins see it). */
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type SlashCommandSubcommandBuilder } from "discord.js";
import type { Feature } from "../core/router.js";

export interface SetupPart {
  name: string;
  build: (sc: SlashCommandSubcommandBuilder) => SlashCommandSubcommandBuilder;
  run: (i: ChatInputCommandInteraction) => Promise<void>;
}

export function setupFeature(parts: SetupPart[]): Feature {
  const b = new SlashCommandBuilder().setName("setup").setDescription("Server settings for the music bot").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  for (const p of parts) b.addSubcommand((sc) => p.build(sc.setName(p.name)));
  return {
    name: "setup",
    guildCommands: [
      {
        json: { ...b.toJSON(), contexts: [InteractionContextType.Guild] },
        execute: async (i) => {
          const part = parts.find((p) => p.name === i.options.getSubcommand());
          if (part) await part.run(i);
        },
      },
    ],
  };
}
