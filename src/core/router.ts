/**
 * Routes interactions to features: slash commands by name, autocomplete, and
 * buttons/menus by the customId prefix before the first ":". Any error turns
 * into a friendly private reply instead of a crash.
 */
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Interaction,
  MessageComponentInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { respond, respondError } from "./discord.js";
import { log } from "./logger.js";

export interface CommandDef {
  json: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(i: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(i: AutocompleteInteraction): Promise<void>;
}

export interface Feature {
  name: string;
  /** Registered in every approved server. */
  guildCommands?: CommandDef[];
  /** Registered globally (used for the owner's DM-only /servers). */
  globalCommands?: CommandDef[];
  components?: Record<string, (i: MessageComponentInteraction) => Promise<void>>;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export class Router {
  private readonly commands = new Map<string, CommandDef>();
  private readonly components = new Map<string, (i: MessageComponentInteraction) => Promise<void>>();

  constructor(
    readonly features: Feature[],
    /** Is this server allowed to use the bot? Commands in others get a polite "not yet". */
    private readonly allowed: (guildId: string) => boolean,
  ) {
    for (const f of features) {
      for (const c of [...(f.guildCommands ?? []), ...(f.globalCommands ?? [])]) this.commands.set(c.json.name, c);
      for (const [prefix, fn] of Object.entries(f.components ?? {})) this.components.set(prefix, fn);
    }
  }

  get guildCommandJson(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    return this.features.flatMap((f) => f.guildCommands ?? []).map((c) => c.json);
  }

  get globalCommandJson(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    return this.features.flatMap((f) => f.globalCommands ?? []).map((c) => c.json);
  }

  async handle(i: Interaction): Promise<void> {
    try {
      if (i.isAutocomplete()) {
        const c = this.commands.get(i.commandName);
        if (!c?.autocomplete || (i.guildId && !this.allowed(i.guildId))) return void (await i.respond([]).catch(() => undefined));
        await c.autocomplete(i).catch(async (err) => {
          log.debug(`autocomplete ${i.commandName} failed: ${(err as Error).message}`);
          await i.respond([]).catch(() => undefined);
        });
        return;
      }
      if (!i.isRepliable()) return;
      if (i.guildId && !this.allowed(i.guildId) && !(i.isMessageComponent() && i.customId.startsWith("srv:"))) {
        await respond(i, "⏳ This server is waiting for the bot's owner to approve it. Once they do, the music commands show up here.");
        return;
      }
      if (i.isChatInputCommand()) {
        const c = this.commands.get(i.commandName);
        if (!c) return void (await respond(i, "That command isn't available any more. Discord may take a minute to update the list."));
        await c.execute(i);
        return;
      }
      if (i.isMessageComponent()) {
        const fn = this.components.get(i.customId.split(":")[0]);
        if (!fn) return void (await respond(i, "That button has expired."));
        await fn(i);
      }
    } catch (err) {
      if (i.isRepliable()) await respondError(i, err);
      else log.error("interaction failed", err);
    }
  }
}
