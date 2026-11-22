/**
 * Subsonic API client for Aurral's built-in server (or Navidrome, gonic…).
 * Token auth (md5(password + salt)) by default; falls back to password auth
 * when the server can't do tokens (Subsonic error 41).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { ApiError, request } from "../core/http.js";

export interface SubsonicSong {
  id: string;
  title: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  duration?: number; // seconds
  coverArt?: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist?: string;
  year?: number;
  songCount?: number;
  coverArt?: string;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  songCount?: number;
}

export interface LyricLine {
  /** Milliseconds from the start, for synced lyrics. */
  start?: number;
  value: string;
}

export interface Lyrics {
  synced: boolean;
  lines: LyricLine[];
}

type Envelope<T> = { "subsonic-response": { status: "ok" | "failed"; error?: { code: number; message?: string } } & T };

const CLIENT = "music-bot";
const VERSION = "1.16.1";

export class SubsonicClient {
  /** How members see it in error messages ("I couldn't reach the music library"). */
  readonly name = "the music library";
  private usePassword = false;

  constructor(private readonly cfg: Config["subsonic"]) {}

  get bitrate(): number {
    return this.cfg.bitrate;
  }

  /** Query-string auth for every call. The result contains credentials: never show it to anyone. */
  private auth(): Record<string, string> {
    const base = { u: this.cfg.user, v: VERSION, c: CLIENT, f: "json" };
    if (this.usePassword) return { ...base, p: `enc:${Buffer.from(this.cfg.password).toString("hex")}` };
    const s = randomBytes(8).toString("hex");
    const t = createHash("md5").update(this.cfg.password + s).digest("hex");
    return { ...base, t, s };
  }

  /** URL for a binary endpoint (stream, getCoverArt). Contains credentials: keep it server-side. */
  url(method: string, params: Record<string, string | number> = {}): string {
    const u = new URL(`${this.cfg.url}/rest/${method}`);
    for (const [k, v] of Object.entries({ ...this.auth(), ...params })) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async call<T>(method: string, params: Record<string, string | number> = {}, retried = false): Promise<T> {
    const res = await request<Envelope<T>>(this.name, this.url(method, params));
    const body = res["subsonic-response"];
    if (!body) throw new ApiError(this.name, "parse", "The music library sent an unexpected response");
    if (body.status !== "ok") {
      const code = body.error?.code;
      if (code === 41 && !retried && !this.usePassword) {
        this.usePassword = true; // server can't verify tokens (no stored password); use password auth
        return this.call<T>(method, params, true);
      }
      if (code === 40) throw new ApiError(this.name, "http", "wrong Subsonic username or password", 401);
      if (code === 70) throw new ApiError(this.name, "http", body.error?.message ?? "not found", 404);
      if (code === 0 && /unknown|not (implemented|supported)/i.test(body.error?.message ?? "")) throw new ApiError(this.name, "http", `${method} isn't supported`, 501);
      throw new ApiError(this.name, "http", `Subsonic: ${body.error?.message ?? `error ${code}`}`, 400);
    }
    return body as unknown as T;
  }

  async health(): Promise<void> {
    await this.call("ping", {});
  }

  async search(query: string, counts = { song: 10, album: 6, artist: 4 }) {
    const r = await this.call<{ searchResult3?: { song?: SubsonicSong[]; album?: SubsonicAlbum[]; artist?: SubsonicArtist[] } }>("search3", {
      query,
      songCount: counts.song,
      albumCount: counts.album,
      artistCount: counts.artist,
    });
    return { songs: r.searchResult3?.song ?? [], albums: r.searchResult3?.album ?? [], artists: r.searchResult3?.artist ?? [] };
  }

  async album(id: string): Promise<SubsonicAlbum & { song: SubsonicSong[] }> {
    const r = await this.call<{ album: SubsonicAlbum & { song?: SubsonicSong[] } }>("getAlbum", { id });
    return { ...r.album, song: r.album.song ?? [] };
  }

  async artist(id: string): Promise<SubsonicArtist> {
    return (await this.call<{ artist: SubsonicArtist }>("getArtist", { id })).artist;
  }

  async song(id: string): Promise<SubsonicSong> {
    return (await this.call<{ song: SubsonicSong }>("getSong", { id })).song;
  }

  async topSongs(artistName: string, count = 25): Promise<SubsonicSong[]> {
    return (await this.call<{ topSongs?: { song?: SubsonicSong[] } }>("getTopSongs", { artist: artistName, count })).topSongs?.song ?? [];
  }

  async randomSongs(size = 25): Promise<SubsonicSong[]> {
    return (await this.call<{ randomSongs?: { song?: SubsonicSong[] } }>("getRandomSongs", { size })).randomSongs?.song ?? [];
  }

  /** Songs like a song, album or artist (ID). Empty when the server can't do it. */
  async similarSongs(id: string, count = 30): Promise<SubsonicSong[]> {
    try {
      const r = await this.call<{ similarSongs2?: { song?: SubsonicSong[] } }>("getSimilarSongs2", { id, count });
      if (r.similarSongs2?.song?.length) return r.similarSongs2.song;
    } catch (err) {
      if (!(err instanceof ApiError) || err.unreachable) throw err;
    }
    try {
      return (await this.call<{ similarSongs?: { song?: SubsonicSong[] } }>("getSimilarSongs", { id, count })).similarSongs?.song ?? [];
    } catch (err) {
      if (!(err instanceof ApiError) || err.unreachable) throw err;
      return [];
    }
  }

  /** Lyrics for a song: the OpenSubsonic per-song call first, then the classic artist + title one. */
  async lyrics(song: SubsonicSong): Promise<Lyrics | undefined> {
    try {
      const r = await this.call<{ lyricsList?: { structuredLyrics?: Array<{ synced?: boolean; line?: LyricLine[] }> } }>("getLyricsBySongId", { id: song.id });
      const all = (r.lyricsList?.structuredLyrics ?? []).filter((l) => l.line?.some((x) => x.value?.trim()));
      const best = all.find((l) => l.synced) ?? all[0];
      if (best?.line) return { synced: Boolean(best.synced) && best.line.every((l) => typeof l.start === "number"), lines: best.line.map((l) => ({ start: l.start, value: l.value ?? "" })) };
    } catch (err) {
      if (!(err instanceof ApiError) || err.unreachable) throw err;
    }
    if (!song.artist) return undefined;
    try {
      const r = await this.call<{ lyrics?: { value?: string } }>("getLyrics", { artist: song.artist, title: song.title });
      const text = r.lyrics?.value?.trim();
      return text ? { synced: false, lines: text.split(/\r?\n/).map((value) => ({ value })) } : undefined;
    } catch (err) {
      if (!(err instanceof ApiError) || err.unreachable) throw err;
      return undefined;
    }
  }

  async playlists(): Promise<SubsonicPlaylist[]> {
    return (await this.call<{ playlists?: { playlist?: SubsonicPlaylist[] } }>("getPlaylists")).playlists?.playlist ?? [];
  }

  async playlist(id: string): Promise<SubsonicPlaylist & { entry: SubsonicSong[] }> {
    const r = await this.call<{ playlist: SubsonicPlaylist & { entry?: SubsonicSong[] } }>("getPlaylist", { id });
    return { ...r.playlist, entry: r.playlist.entry ?? [] };
  }

  /** Opus-in-Ogg stream, so audio goes straight to Discord. `offset` starts partway in (seconds). */
  streamUrl(id: string, offset = 0): string {
    return this.url("stream", { id, format: "opus", maxBitRate: this.cfg.bitrate, ...(offset > 0 ? { timeOffset: Math.floor(offset) } : {}) });
  }

  async coverArt(id: string, size = 300): Promise<Buffer> {
    return request<Buffer>(this.name, this.url("getCoverArt", { id, size }), { as: "buffer", headers: { Accept: "image/*" } });
  }
}
