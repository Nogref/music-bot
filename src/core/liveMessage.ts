/**
 * A single bot message that lives in a channel and is edited in place (each
 * server's now-playing board). Its location is remembered in the DB so it
 * survives restarts; if someone deletes it, the next update posts a fresh one
 * in the same channel.
 */
import type { Client, Message, MessageCreateOptions, MessageEditOptions, SendableChannels } from "discord.js";
import type { Store } from "./db.js";
import { DiscordCodes, discordErrorCode } from "./discord.js";
import { log } from "./logger.js";

export type LivePayload = Pick<MessageCreateOptions, "content" | "embeds" | "components" | "files" | "allowedMentions">;

interface Location {
  channelId: string;
  messageId: string;
}

export class LiveMessage {
  private cached?: Message;

  constructor(
    private readonly client: Client,
    private readonly store: Store,
    readonly key: string,
  ) {}

  get location(): Location | undefined {
    return this.store.kvGet<Location>(`live.${this.key}`);
  }

  link(guildId: string): string | undefined {
    const l = this.location;
    return l ? `https://discord.com/channels/${guildId}/${l.channelId}/${l.messageId}` : undefined;
  }

  private async channel(id: string): Promise<SendableChannels | undefined> {
    const ch = await this.client.channels.fetch(id).catch(() => null);
    return ch?.isSendable() ? (ch as SendableChannels) : undefined;
  }

  /** Posts a new message in `channelId` and makes it the live one (the old one is deleted). */
  async place(channelId: string, payload: LivePayload): Promise<Message> {
    const ch = await this.channel(channelId);
    if (!ch) throw new Error(`I can't post in <#${channelId}>. Give me View Channel and Send Messages there.`);
    const old = this.location;
    const msg = await ch.send(payload);
    this.store.kvSet(`live.${this.key}`, { channelId: msg.channelId, messageId: msg.id });
    this.cached = msg;
    if (old && old.messageId !== msg.id) {
      const oldCh = await this.channel(old.channelId);
      if (oldCh && "messages" in oldCh) await oldCh.messages.delete(old.messageId).catch(() => undefined);
    }
    return msg;
  }

  /** Takes it down for good (deletes the message and forgets where it was). */
  async remove(): Promise<boolean> {
    const loc = this.location;
    if (!loc) return false;
    this.store.kvDelete(`live.${this.key}`);
    this.cached = undefined;
    const ch = await this.channel(loc.channelId);
    if (ch && "messages" in ch) await ch.messages.delete(loc.messageId).catch(() => undefined);
    return true;
  }

  /** Edits the live message; reposts it if it was deleted. No-op when it was never placed. */
  async update(payload: LivePayload): Promise<boolean> {
    const loc = this.location;
    if (!loc) return false;
    // New files replace the old ones; without files the existing attachment (cover art) stays.
    const edit = { ...payload, content: payload.content ?? null, ...(payload.files ? { attachments: [] } : {}) } as MessageEditOptions;
    try {
      let msg = this.cached?.id === loc.messageId ? this.cached : undefined;
      if (!msg) {
        const ch = await this.channel(loc.channelId);
        if (!ch || !("messages" in ch)) throw Object.assign(new Error("channel gone"), { code: DiscordCodes.UnknownChannel });
        msg = await ch.messages.fetch(loc.messageId);
      }
      this.cached = await msg.edit(edit);
      return true;
    } catch (err) {
      const code = discordErrorCode(err);
      if (code === DiscordCodes.UnknownMessage) {
        log.warn(`live: message "${this.key}" was deleted; posting a new one`);
        this.cached = undefined;
        await this.place(loc.channelId, payload);
        return true;
      }
      if (code === DiscordCodes.UnknownChannel) {
        log.warn(`live: channel for "${this.key}" is gone; run /setup nowplaying again to place it`);
        this.store.kvDelete(`live.${this.key}`);
        return false;
      }
      throw err;
    }
  }
}
