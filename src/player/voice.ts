/**
 * The audio side of a session: one voice connection and one player per
 * server. Audio comes from the library already Opus-encoded (format=opus), so
 * at 100% volume nothing is transcoded; any other volume decodes and
 * re-encodes the stream in-process (pure-JS Opus, no ffmpeg).
 */
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { log } from "../core/logger.js";
import type { SubsonicClient } from "../services/subsonic.js";

/** What the player logic needs from voice. Tests swap in a fake. */
export interface VoiceLink {
  readonly channelId?: string;
  connect(channel: VoiceBasedChannel): Promise<void>;
  /** Opens the song's stream (from `offset` seconds) and starts it. Returns a token for onEnd. Throws if it can't. */
  play(songId: string, offset: number, volume: number): Promise<number>;
  pause(): void;
  resume(): void;
  /** Stops the current stream (onEnd fires for it). */
  stop(): void;
  /** Milliseconds played of the current stream. */
  position(): number;
  /** Changes the volume of what's playing; false when the stream has to be restarted for it. */
  setVolume(volume: number): boolean;
  onEnd(cb: (token: number, error?: Error) => void): void;
  onDisconnect(cb: () => void): void;
  /** Someone dragged the bot to another voice channel. */
  noteMoved(channelId: string): void;
  destroy(): void;
}

export type VoiceLinkFactory = () => VoiceLink;

interface Meta {
  token: number;
}

export class DiscordVoiceLink implements VoiceLink {
  channelId?: string;
  private connection?: VoiceConnection;
  private readonly player: AudioPlayer;
  private resource?: AudioResource<Meta>;
  private nextToken = 1;
  private lastError?: { token: number; error: Error };
  private endCb?: (token: number, error?: Error) => void;
  private disconnectCb?: () => void;

  constructor(private readonly subsonic: SubsonicClient) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on("stateChange", (oldState, newState) => {
      if (oldState.status === AudioPlayerStatus.Idle || newState.status !== AudioPlayerStatus.Idle) return;
      const token = (oldState.resource as AudioResource<Meta>).metadata.token;
      const err = this.lastError?.token === token ? this.lastError.error : undefined;
      this.endCb?.(token, err);
    });
    this.player.on("error", (err) => {
      const token = (err.resource as AudioResource<Meta>).metadata.token;
      this.lastError = { token, error: err };
      log.warn(`music: playback error: ${err.message}`);
    });
  }

  async connect(channel: VoiceBasedChannel): Promise<void> {
    if (this.connection && this.channelId === channel.id && this.connection.state.status !== VoiceConnectionStatus.Destroyed) return;
    this.connection?.destroy();
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: true,
    });
    this.connection = connection;
    this.channelId = channel.id;
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Moved to another channel → reconnects by itself; kicked or channel deleted → give up.
      try {
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]);
      } catch {
        this.disconnectCb?.();
      }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy();
      this.connection = undefined;
      this.channelId = undefined;
      throw new Error("I couldn't connect to the voice channel. Check I have **Connect** and **Speak** there.", { cause: err });
    }
    connection.subscribe(this.player);
  }

  async play(songId: string, offset: number, volume: number): Promise<number> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000); // connecting/headers only; the body streams for the whole song
    let res: Response;
    try {
      res = await fetch(this.subsonic.streamUrl(songId, offset), { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) throw new Error(`stream returned HTTP ${res.status}`);
    if ((res.headers.get("content-type") ?? "").includes("json")) throw new Error("the library sent an error instead of audio");
    const { stream, type } = await demuxProbe(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>));
    if (type !== StreamType.OggOpus && type !== StreamType.WebmOpus) {
      stream.destroy();
      throw new Error("the library didn't send Opus audio (check its Opus transcoding)");
    }
    const token = this.nextToken++;
    const resource = createAudioResource<Meta>(stream, { inputType: type, metadata: { token }, inlineVolume: volume !== 100 });
    resource.volume?.setVolumeLogarithmic(volume / 100);
    this.resource = resource;
    this.player.play(resource);
    return token;
  }

  pause(): void {
    this.player.pause(true);
  }

  resume(): void {
    this.player.unpause();
  }

  stop(): void {
    this.player.stop(true);
  }

  position(): number {
    return this.resource?.playbackDuration ?? 0;
  }

  setVolume(volume: number): boolean {
    if (!this.resource?.volume) return false;
    this.resource.volume.setVolumeLogarithmic(volume / 100);
    return true;
  }

  onEnd(cb: (token: number, error?: Error) => void): void {
    this.endCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  noteMoved(channelId: string): void {
    this.channelId = channelId;
  }

  destroy(): void {
    this.player.stop(true);
    try {
      this.connection?.destroy();
    } catch {
      /* already gone */
    }
    this.connection = undefined;
    this.channelId = undefined;
  }
}
