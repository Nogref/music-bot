/** Discord helpers: colors, safe replies, error codes, permission checks. */
import {
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  type BaseInteraction,
  type Client,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type RepliableInteraction,
} from "discord.js";
import { friendlyError } from "./http.js";
import { log } from "./logger.js";

export const Colors = {
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  bad: 0xe74c3c,
  info: 0x5865f2,
  muted: 0x95a5a6,
  music: 0x1db954,
} as const;

/** Server admins (Manage Server or Administrator) can always control the music. */
export function isServerAdmin(i: BaseInteraction): boolean {
  return i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

/** Replies, edits or follows up depending on interaction state, always privately. */
export async function respond(i: RepliableInteraction, content: InteractionReplyOptions | string): Promise<void> {
  const opts: InteractionReplyOptions = typeof content === "string" ? { content } : content;
  try {
    if (i.deferred || i.replied) {
      const { flags: _flags, ...rest } = opts;
      await i.editReply(rest);
    } else {
      await i.reply({ ...opts, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    log.warn(`discord: could not respond to interaction: ${(err as Error).message}`);
  }
}

export async function respondError(i: RepliableInteraction, err: unknown): Promise<void> {
  if (!(err instanceof Error) || err.name !== "ApiError") log.error("handler error", err);
  else log.warn(`handler: ${(err as Error).message}`);
  await respond(i, { content: friendlyError(err), embeds: [], components: [], files: [] });
}

export function discordErrorCode(err: unknown): number | undefined {
  if (err instanceof DiscordAPIError) return typeof err.code === "number" ? err.code : undefined;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export const DiscordCodes = {
  UnknownChannel: 10003,
  UnknownMessage: 10008,
  MissingAccess: 50001,
  CannotDM: 50007,
  MissingPermissions: 50013,
} as const;

/** Sends a DM; returns the message, or undefined (never throws) when DMs are closed. */
export async function dm(client: Client, userId: string, payload: MessageCreateOptions | string) {
  try {
    const user = await client.users.fetch(userId);
    return await user.send(payload);
  } catch (err) {
    log.info(`discord: couldn't DM ${userId}: ${(err as Error).message}`);
    return undefined;
  }
}

export function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}
