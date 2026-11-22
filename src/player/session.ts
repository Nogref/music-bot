/**
 * One server's player: the queue, what's playing, loop/radio/volume, and the
 * now-playing card. Every change goes through `exclusive()` so overlapping
 * button presses can't start two songs at once.
 */
import type { VoiceBasedChannel } from "discord.js";
import type { LivePayload } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { SubsonicClient, SubsonicSong } from "../services/subsonic.js";
import { TrackQueue, songLabel, type LoopMode, type Track } from "./queue.js";
import type { VoiceLink } from "./voice.js";

const RADIO_BATCH = 20;
const RADIO_LOW_WATER = 5;
const MAX_FAILURES = 5;

export type Radio = { mode: "random" } | { mode: "similar"; seedId: string; seedLabel: string };

/** Where the now-playing card goes (a board, or the voice channel's chat). `ended` = the session is over. */
export type NowPlayingDisplay = (payload: LivePayload, ended: boolean) => Promise<void>;
export type CardBuilder = (s: MusicSession, final?: string) => Promise<LivePayload>;

export interface SessionDeps {
  guildId: string;
  subsonic: SubsonicClient;
  link: VoiceLink;
  idleMinutes: number;
  volume: number;
  display: NowPlayingDisplay;
  card: CardBuilder;
  onEnd: () => void;
  /** How long to wait before redrawing the card after a change (tests use 0). */
  renderDelayMs?: number;
}

export class MusicSession {
  readonly queue = new TrackQueue();
  current?: Track;
  loop: LoopMode = "off";
  radio?: Radio;
  /** Shown on the card when radio had to change plan (e.g. no similar songs). */
  radioNote?: string;
  volume: number;
  paused = false;
  /** Where in the song the current stream started (seconds); position = offset + time played. */
  private offset = 0;
  private token = 0;
  private failures = 0;
  private destroyed = false;
  private idleTimer?: NodeJS.Timeout;
  private renderTimer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: SessionDeps) {
    this.volume = d.volume;
    d.link.onEnd((token, error) => {
      if (token !== this.token) return; // a stream we replaced on purpose
      void this.exclusive(() => {
        if (error && this.d.link.position() < 1500) {
          log.warn(`music: "${this.current?.song.title}" failed to play: ${error.message}`);
          if (++this.failures >= MAX_FAILURES) return this.destroy("I stopped after several songs failed to play. The music library might be having trouble.");
          return this.advance("error");
        }
        this.failures = 0;
        return this.advance("ended");
      });
    });
    d.link.onDisconnect(() => void this.destroy("I was disconnected from the voice channel."));
  }

  get guildId(): string {
    return this.d.guildId;
  }
  get voiceChannelId(): string | undefined {
    return this.d.link.channelId;
  }
  get idleMinutes(): number {
    return this.d.idleMinutes;
  }
  get subsonic(): SubsonicClient {
    return this.d.subsonic;
  }
  get ended(): boolean {
    return this.destroyed;
  }
  /** Seconds into the current song. */
  get position(): number {
    return this.current ? this.offset + this.d.link.position() / 1000 : 0;
  }

  /** Runs state changes one at a time. */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => (this.destroyed ? (undefined as T) : fn()));
    this.chain = run.catch(() => undefined);
    return run;
  }

  join(channel: VoiceBasedChannel): Promise<void> {
    return this.d.link.connect(channel);
  }

  /** Queues tracks; starts playing if nothing is. Returns how many fit. */
  enqueue(tracks: Track[], next = false): Promise<number> {
    return this.exclusive(async () => {
      const added = this.queue.add(tracks, next);
      this.clearIdle();
      if (!this.current) await this.advance("ended");
      else this.render();
      return added;
    });
  }

  /** Turns radio on (random or "more like this") or off. */
  setRadio(radio: Radio | undefined): Promise<void> {
    return this.exclusive(async () => {
      this.radio = radio;
      this.radioNote = undefined;
      this.queue.clearRadio();
      if (radio) {
        await this.topUpRadio();
        if (!this.current) await this.advance("ended");
      }
      this.render();
    });
  }

  togglePause(): Promise<boolean> {
    return this.exclusive(() => {
      if (!this.current) return false;
      if (this.paused) this.d.link.resume();
      else this.d.link.pause();
      this.paused = !this.paused;
      this.render();
      return this.paused;
    });
  }

  skip(): Promise<void> {
    return this.exclusive(() => this.advance("skip"));
  }

  /** Back to the previous song (or the start of this one if there's nothing before it). */
  previous(): Promise<Track | undefined> {
    return this.exclusive(async () => {
      const prev = this.queue.popHistory();
      if (!prev) {
        if (this.current) await this.start(this.current, 0);
        return this.current;
      }
      if (this.current) this.queue.unshift(this.current);
      await this.start(prev, 0);
      return prev;
    });
  }

  seek(seconds: number): Promise<number | undefined> {
    return this.exclusive(async () => {
      const t = this.current;
      if (!t) return undefined;
      const max = t.song.duration ? Math.max(0, t.song.duration - 1) : seconds;
      const to = Math.max(0, Math.min(seconds, max));
      await this.restart(to);
      return to;
    });
  }

  setLoop(mode: LoopMode): void {
    this.loop = mode;
    this.render();
  }

  /** 1-150. Applies straight away; restarts the stream at the same spot if it has to. */
  setVolume(volume: number): Promise<void> {
    return this.exclusive(async () => {
      this.volume = volume;
      if (this.current && !this.d.link.setVolume(volume)) await this.restart(this.position);
      this.render();
    });
  }

  shuffle(): void {
    this.queue.shuffle();
    this.render();
  }

  remove(position: number): Track | undefined {
    const t = this.queue.remove(position);
    if (t) this.render();
    return t;
  }

  clearQueue(): number {
    const n = this.queue.clear();
    this.render();
    return n;
  }

  /** Same song, from `seconds`, keeping pause state. */
  private async restart(seconds: number): Promise<void> {
    const t = this.current;
    if (!t) return;
    const wasPaused = this.paused;
    await this.start(t, seconds);
    if (wasPaused && this.current === t) {
      this.d.link.pause();
      this.paused = true;
    }
  }

  /** Moves on after a song ends, is skipped or fails. */
  private async advance(reason: "ended" | "skip" | "error"): Promise<void> {
    if (this.destroyed) return;
    const finished = this.current;
    if (finished) {
      if (reason === "ended" && this.loop === "song") return this.start(finished, 0);
      this.queue.remember(finished);
      if (reason !== "error" && this.loop === "queue" && !finished.radio) this.queue.add([{ ...finished }]);
    }
    await this.topUpRadio();
    const next = this.queue.shift();
    this.current = next;
    if (!next) {
      this.token = 0;
      this.d.link.stop();
      this.paused = false;
      this.render();
      this.armIdle("The queue finished");
      return;
    }
    await this.start(next, 0);
  }

  private async start(track: Track, offset: number): Promise<void> {
    this.current = track;
    this.clearIdle();
    try {
      this.token = await this.d.link.play(track.song.id, offset, this.volume);
      this.offset = offset;
      this.paused = false;
      this.render();
    } catch (err) {
      log.warn(`music: couldn't play "${track.song.title}": ${(err as Error).message}`);
      if (++this.failures >= MAX_FAILURES) {
        await this.destroy("I stopped after several songs failed to play. The music library might be having trouble.");
        return;
      }
      await this.advance("error");
    }
  }

  private async topUpRadio(): Promise<void> {
    const radio = this.radio;
    if (!radio || this.queue.length >= RADIO_LOW_WATER) return;
    const recent = this.queue.recentIds();
    if (this.current) recent.add(this.current.song.id);
    const fresh = (songs: SubsonicSong[]) => songs.filter((s) => !recent.has(s.id));
    let songs: SubsonicSong[] = [];
    try {
      if (radio.mode === "similar") {
        songs = fresh(await this.d.subsonic.similarSongs(radio.seedId, 40));
        // Nothing new yet, but picks are still queued: use those up first.
        if (!songs.length && this.queue.radioCount > 0) return;
        // Ran out of new ones: keep going from the song that's playing now.
        if (!songs.length && this.current && this.current.song.id !== radio.seedId) songs = fresh(await this.d.subsonic.similarSongs(this.current.song.id, 40));
        if (!songs.length) {
          this.radioNote = `I couldn't find more songs like ${radio.seedLabel}, so here are random ones.`;
          songs = fresh(await this.d.subsonic.randomSongs(RADIO_BATCH));
        }
        songs = songs.slice(0, RADIO_BATCH);
      } else {
        songs = fresh(await this.d.subsonic.randomSongs(RADIO_BATCH));
      }
    } catch (err) {
      log.warn(`music: radio refill failed: ${(err as Error).message}`);
      return;
    }
    this.queue.add(songs.map((song) => ({ song, requestedBy: "radio", radio: true })));
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Leaves after IDLE_MINUTES with nothing to play (or nobody listening). */
  armIdle(reason: string) {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.destroy(`${reason}, so I left the channel.`), this.d.idleMinutes * 60_000);
    this.idleTimer.unref?.();
  }

  noteMoved(channelId: string) {
    this.d.link.noteMoved(channelId);
    this.render();
  }

  noteListeners(count: number) {
    if (count === 0) this.armIdle("Everyone left");
    else if (this.current) this.clearIdle();
  }

  /** Redraws the card (bursts of changes become one edit). */
  render(): void {
    if (this.destroyed) return;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.show();
    }, this.d.renderDelayMs ?? 750);
    this.renderTimer.unref?.();
  }

  /** Draws the card now (and waits for it). */
  async show(final?: string): Promise<void> {
    try {
      await this.d.display(await this.d.card(this, final), Boolean(final));
    } catch (err) {
      log.warn(`music: couldn't update the now-playing card: ${(err as Error).message}`);
    }
  }

  async destroy(reason = "Stopped."): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdle();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.queue.clear();
    this.token = 0;
    this.d.link.destroy();
    await this.show(reason);
    this.d.onEnd();
  }

  /** Short description for logs and replies. */
  describe(): string {
    return this.current ? songLabel(this.current.song) : "nothing";
  }
}
