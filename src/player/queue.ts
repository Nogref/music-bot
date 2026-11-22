/** Pure queue logic for the player (kept separate so it's easy to test). */
import type { SubsonicSong } from "../services/subsonic.js";

export interface Track {
  song: SubsonicSong;
  requestedBy: string;
  /** Added automatically by radio. */
  radio?: boolean;
}

export type LoopMode = "off" | "song" | "queue";

export const MAX_QUEUE = 500;
const MAX_HISTORY = 50;

export class TrackQueue {
  private items: Track[] = [];
  private played: Track[] = [];

  get length(): number {
    return this.items.length;
  }

  list(): readonly Track[] {
    return this.items;
  }

  history(): readonly Track[] {
    return this.played;
  }

  /** Adds tracks at the end (or up front with `next`). Returns how many fit. */
  add(tracks: Track[], next = false): number {
    const room = Math.max(0, MAX_QUEUE - this.items.length);
    const accepted = tracks.slice(0, room);
    if (next) {
      // Radio picks never jump ahead of what people asked for.
      this.items.unshift(...accepted);
    } else {
      const firstRadio = accepted.every((t) => !t.radio) ? this.items.findIndex((t) => t.radio) : -1;
      if (firstRadio >= 0) this.items.splice(firstRadio, 0, ...accepted);
      else this.items.push(...accepted);
    }
    return accepted.length;
  }

  /** Puts a track back at the front (used by "previous"). */
  unshift(track: Track): void {
    this.items.unshift(track);
  }

  shift(): Track | undefined {
    return this.items.shift();
  }

  /** Remembers a finished track for "previous" and for radio's "don't repeat" check. */
  remember(track: Track): void {
    this.played.push(track);
    if (this.played.length > MAX_HISTORY) this.played.shift();
  }

  /** The last finished track, taken off the history. */
  popHistory(): Track | undefined {
    return this.played.pop();
  }

  /** Removes the track at a 1-based queue position. */
  remove(position: number): Track | undefined {
    if (position < 1 || position > this.items.length) return undefined;
    return this.items.splice(position - 1, 1)[0];
  }

  /** Clears what's queued. Returns how many were removed. */
  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  /** Drops queued radio picks (radio switched off or changed). */
  clearRadio(): void {
    this.items = this.items.filter((t) => !t.radio);
  }

  get radioCount(): number {
    return this.items.filter((t) => t.radio).length;
  }

  /** Song IDs that were played recently or are already queued, so radio doesn't repeat them. */
  recentIds(): Set<string> {
    return new Set([...this.played, ...this.items].map((t) => t.song.id));
  }

  shuffle(rand: () => number = Math.random): void {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
  }

  /** Total queued time in seconds (unknown durations count as 0). */
  duration(): number {
    return this.items.reduce((a, t) => a + (t.song.duration ?? 0), 0);
  }
}

export function fmtDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return "?:??";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function songLabel(s: SubsonicSong): string {
  return `${s.title}${s.artist ? ` by ${s.artist}` : ""}`;
}

/**
 * Turns what someone typed for /seek into seconds: "1:23", "83", "1:02:03",
 * "90s", "2m", "1m30s", or relative "+30" / "-15" (from `current`).
 */
export function parseTime(input: string, current: number): number | undefined {
  const t = input.trim().toLowerCase().replace(/\s+/g, "");
  const rel = /^[+-]/.test(t) ? (t[0] === "+" ? 1 : -1) : 0;
  const body = rel ? t.slice(1) : t;
  let sec: number | undefined;
  if (/^\d+(\.\d+)?$/.test(body)) sec = Number(body);
  else if (/^\d+(:\d{1,2}){1,2}$/.test(body)) {
    const parts = body.split(":").map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return undefined;
    sec = parts.reduce((a, p) => a * 60 + p, 0);
  } else {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(body);
    if (m && (m[1] || m[2] || m[3])) sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  if (sec === undefined) return undefined;
  return Math.max(0, rel ? current + rel * sec : sec);
}
