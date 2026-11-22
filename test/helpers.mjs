// Doubles for Discord and voice, so commands and the player run without a real connection.
import { Collection } from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "music-bot-test-"));
export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
export const json = (e) => (e?.toJSON ? e.toJSON() : e);

export function fakeConfig(overrides = {}) {
  return {
    discordToken: "x",
    ownerId: "owner1",
    preApproved: [],
    subsonic: { url: "http://127.0.0.1:9", user: "bot", password: "pw", bitrate: 128 },
    idleMinutes: 5,
    dataDir: tmpDir(),
    http: { port: 0, timeoutMs: 2000 },
    ...overrides,
  };
}

/** A Discord client double: guilds, channels and DMs record what was sent. */
export function fakeClient({ ownerId = "owner1" } = {}) {
  const channels = new Map();
  const sent = [];
  const dms = [];
  const closedDMs = new Set();
  const globalCommandSets = [];
  const listeners = new Map();
  let nextId = 1;

  const makeMessage = (channelId, payload) => {
    const msg = {
      id: `m${nextId++}`,
      channelId,
      payload,
      edits: [],
      deleted: false,
      async edit(p) {
        if (msg.deleted) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        msg.edits.push(p);
        return msg;
      },
      async delete() {
        msg.deleted = true;
      },
      get latest() {
        return msg.edits.at(-1) ?? msg.payload;
      },
    };
    return msg;
  };

  function textChannel(id, extra = {}) {
    const messages = new Map();
    const ch = {
      id,
      type: 0,
      isSendable: () => true,
      permissionsFor: () => null,
      async send(payload) {
        const m = makeMessage(id, payload);
        messages.set(m.id, m);
        sent.push({ channelId: id, payload, message: m });
        return m;
      },
      messages: {
        async fetch(mid) {
          const m = messages.get(mid);
          if (!m || m.deleted) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return m;
        },
        async delete(mid) {
          const m = messages.get(mid);
          if (m) m.deleted = true;
        },
      },
      ...extra,
    };
    channels.set(id, ch);
    return ch;
  }

  const client = {
    sent,
    dms,
    closedDMs,
    globalCommandSets,
    user: { id: "bot" },
    isReady: () => true,
    guilds: { cache: new Collection() },
    channels: { fetch: async (id) => channels.get(id) ?? null },
    application: {
      id: "app1",
      fetch: async () => ({ owner: { id: ownerId } }),
      commands: { set: async (j) => void globalCommandSets.push(j) },
    },
    users: {
      fetch: async (id) => ({
        id,
        async send(p) {
          if (closedDMs.has(id)) throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
          const ch = channels.get(`dm-${id}`) ?? textChannel(`dm-${id}`);
          const m = await ch.send(p);
          dms.push({ to: id, payload: p, message: m });
          return m;
        },
      }),
    },
    on(ev, fn) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
    },
    emit(ev, ...args) {
      for (const fn of listeners.get(ev) ?? []) fn(...args);
    },
    textChannel,
  };

  /** Adds a server the bot is in, with a text channel and a voice channel. */
  client.addGuild = (id, { name = `Server ${id}`, ownerId: gOwner = "someone", members = 12 } = {}) => {
    const commandSets = [];
    const guild = {
      id,
      name,
      ownerId: gOwner,
      memberCount: members,
      commandSets,
      left: false,
      channels: { cache: new Collection() },
      members: { me: null },
      commands: { set: async (j) => void commandSets.push(j) },
      iconURL: () => null,
      async fetchOwner() {
        return { id: gOwner, user: { username: `owner-of-${id}` } };
      },
      async leave() {
        guild.left = true;
        client.guilds.cache.delete(id);
      },
      get voiceAdapterCreator() {
        return () => ({});
      },
    };
    const general = textChannel(`${id}-general`, { guild });
    guild.systemChannel = general;
    const voice = textChannel(`${id}-voice`, { type: 2, guild, members: new Collection() });
    guild.channels.cache.set(general.id, general);
    guild.channels.cache.set(voice.id, voice);
    guild.general = general;
    guild.voice = voice;
    client.guilds.cache.set(id, guild);
    return guild;
  };
  return client;
}

/** A slash command / button / autocomplete double. */
export function fakeInteraction(client, { guild, command, sub, options = {}, customId, userId = "u1", inVoice = true, admin = false, channel, focused } = {}) {
  const log = [];
  const voiceChannel = inVoice === true ? guild?.voice : inVoice || null;
  const i = {
    log,
    client,
    user: { id: userId, username: userId, displayName: userId },
    guildId: guild?.id ?? null,
    guild,
    channel: channel ?? guild?.general ?? null,
    member: guild ? { displayName: `${userId}-nick`, voice: { channel: voiceChannel } } : null,
    memberPermissions: { has: () => admin },
    commandName: command,
    customId,
    message: { content: "" },
    deferred: false,
    replied: false,
    options: {
      getString: (n, req) => opt(n, req),
      getBoolean: (n) => options[n] ?? null,
      getInteger: (n, req) => opt(n, req),
      getChannel: (n, req) => opt(n, req),
      getSubcommand: () => sub ?? null,
      getFocused: () => focused ?? "",
    },
    isAutocomplete: () => focused !== undefined,
    isRepliable: () => focused === undefined,
    isChatInputCommand: () => Boolean(command) && focused === undefined,
    isMessageComponent: () => Boolean(customId),
    async reply(p) {
      i.replied = true;
      log.push({ type: "reply", p: typeof p === "string" ? { content: p } : p });
    },
    async deferReply(p) {
      i.deferred = true;
      log.push({ type: "defer", p });
    },
    async deferUpdate() {
      i.deferred = true;
      log.push({ type: "deferUpdate" });
    },
    async editReply(p) {
      log.push({ type: "edit", p: typeof p === "string" ? { content: p } : p });
    },
    async followUp(p) {
      log.push({ type: "followUp", p });
    },
    async update(p) {
      log.push({ type: "update", p });
    },
    async respond(choices) {
      log.push({ type: "respond", choices });
    },
    /** What the member saw last. */
    last() {
      return [...log].reverse().find((x) => x.p !== undefined || x.choices)?.p ?? [...log].reverse().find((x) => x.choices);
    },
  };
  function opt(n, req) {
    const v = options[n];
    if ((v === undefined || v === null) && req) throw new Error(`missing required option ${n}`);
    return v ?? null;
  }
  return i;
}

/** Stands in for the voice connection: records what was played and lets tests end songs. */
export class FakeLink {
  channelId = undefined;
  plays = [];
  pos = 0;
  paused = false;
  stops = 0;
  destroyed = false;
  failing = new Set();
  liveVolume = undefined;
  token = 0;
  async connect(ch) {
    this.channelId = ch.id;
  }
  async play(songId, offset, volume) {
    if (this.failing.has(songId)) throw new Error("stream returned HTTP 500");
    this.token++;
    this.plays.push({ songId, offset, volume, token: this.token });
    this.pos = 0;
    this.paused = false;
    return this.token;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  stop() {
    this.stops++;
    const t = this.token;
    queueMicrotask(() => this.endCb?.(t));
  }
  position() {
    return this.pos;
  }
  /** Like the real one: only streams started at a volume other than 100 can change live. */
  setVolume(v) {
    if (this.current?.volume === 100) return false;
    this.liveVolume = v;
    return true;
  }
  onEnd(cb) {
    this.endCb = cb;
  }
  onDisconnect(cb) {
    this.disconnectCb = cb;
  }
  noteMoved(id) {
    this.channelId = id;
  }
  destroy() {
    this.destroyed = true;
    this.channelId = undefined;
  }
  /** The current song finishes (or fails, with an error). */
  finish(error) {
    this.endCb?.(this.token, error);
  }
  get current() {
    return this.plays.at(-1);
  }
  get played() {
    return this.plays.map((p) => p.songId);
  }
}
