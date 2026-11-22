/**
 * Apex Legends Status API (apexlegendsapi.com): player stats, map rotation,
 * Predator cutoffs and server status. Free keys allow about 2 requests a
 * second, so calls are spaced out. The API sometimes answers 200 with an
 * "Error" field instead of a real status code; that's handled here.
 */
import type { Config } from "../config.js";
import { ApiError, request } from "../core/http.js";

type Json = Record<string, any>;

export type ApexPlatform = "PC" | "PS4" | "X1" | "SWITCH";
export const PLATFORMS: Array<{ name: string; value: ApexPlatform }> = [
  { name: "PC (EA / Steam)", value: "PC" },
  { name: "PlayStation", value: "PS4" },
  { name: "Xbox", value: "X1" },
  { name: "Switch", value: "SWITCH" },
];
export const platformName = (p: string) => ({ PC: "PC", PS4: "PlayStation", X1: "Xbox", SWITCH: "Switch" })[p] ?? p;

export interface ApexPlayer {
  uid: string;
  name: string;
  platform: string;
  level: number;
  prestige: number;
  rank: { score: number; name: string; div: number; img?: string; season?: string; ladderPos?: number };
  online: boolean;
  inGame: boolean;
  /** "In lobby (02:14)", "In match (12:01)", "Offline" … */
  state?: string;
  legend?: string;
  legendIcon?: string;
  /** Trackers on the selected legend's banner. */
  trackers: Array<{ name: string; value: number }>;
  /** BR kills summed over legends' banner trackers, when any are equipped. */
  trackedKills?: number;
  banned: boolean;
}

export interface MapSlot {
  map: string;
  /** Epoch ms. */
  start?: number;
  end?: number;
  image?: string;
  minutes?: number;
}
export interface MapRotation {
  pubs?: { current: MapSlot; next?: MapSlot };
  ranked?: { current: MapSlot; next?: MapSlot };
}

export interface PredatorCut {
  platform: string;
  rp: number;
  mastersAndPreds?: number;
  updatedAt?: number;
}

export interface ServerGroup {
  name: string;
  up: number;
  slow: number;
  down: number;
  /** Regions that aren't UP. */
  problems: string[];
}

/** The API sits behind a firewall that turns away anonymous clients (HTTP 406), so say who we are. */
export const USER_AGENT = "music-bot/1.0 (+https://github.com/Nogref/music-bot)";

/** What its status codes mean (the API's own error list), for logs and replies. */
const STATUS_TEXT: Record<number, string> = {
  400: "the request was refused; try again in a few minutes",
  403: "the API key wasn't accepted",
  404: "player not found",
  405: "EA's servers didn't answer the stats service",
  406: "the request was blocked by the stats service's firewall",
  410: "unknown platform",
  429: "too many requests",
};

const SERVER_GROUPS: Record<string, string> = {
  Origin_login: "EA login",
  EA_novafusion: "Matchmaking",
  EA_accounts: "EA accounts",
  ApexOauth_Crossplay: "Crossplay login",
  otherPlatforms: "PlayStation / Xbox",
};

export class ApexClient {
  readonly name = "the Apex stats service";
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly cfg: NonNullable<Config["apex"]>,
    /** Gap between calls; free keys allow about 2 a second. */
    private readonly gapMs = 600,
  ) {}

  /** One call at a time, spaced out; retries once when told to slow down. */
  private call<T = Json>(path: string, params: Record<string, string> = {}): Promise<T> {
    const run = this.chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = this.last + this.gapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.last = Date.now();
        const u = new URL(`${this.cfg.url}${path}`);
        for (const [k, v] of Object.entries({ ...params, auth: this.cfg.apiKey })) u.searchParams.set(k, v);
        try {
          // Read as text: errors don't always come back as JSON, whatever the Accept header says.
          const raw = await request<string>(this.name, u.toString(), { as: "text", headers: { Accept: "application/json, text/plain, */*", "User-Agent": USER_AGENT } });
          let body: Json;
          try {
            body = JSON.parse(raw) as Json;
          } catch {
            const plain = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
            if (/not found/i.test(plain)) throw new ApiError(this.name, "http", plain, 404);
            throw new ApiError(this.name, "parse", `the Apex stats service sent something that isn't JSON: ${plain || "(empty)"}`);
          }
          const err = typeof body?.Error === "string" ? body.Error : typeof body?.error === "string" ? body.error : undefined;
          if (err) {
            if (/slow down|rate limit|too many/i.test(err)) throw new ApiError(this.name, "http", err, 429);
            if (/not found|unknown|doesn't exist|does not exist|never played/i.test(err)) throw new ApiError(this.name, "http", err, 404);
            if (/api key|auth/i.test(err)) throw new ApiError(this.name, "http", err, 403);
            throw new ApiError(this.name, "http", err, 400);
          }
          return body as T;
        } catch (e) {
          if (e instanceof ApiError && e.kind === "http" && e.status && STATUS_TEXT[e.status] && !e.message.includes(STATUS_TEXT[e.status])) {
            // Name what the code means (the raw reply is kept in the message for the log).
            e = new ApiError(this.name, "http", `${e.message} (${STATUS_TEXT[e.status]})`, e.status, (e as ApiError).body);
          }
          if (e instanceof ApiError && e.status === 429 && attempt === 0) {
            await new Promise((r) => setTimeout(r, Math.max(2000, this.gapMs * 3)));
            continue;
          }
          throw e;
        }
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async player(name: string, platform: string): Promise<ApexPlayer> {
    return parsePlayer(await this.call("/bridge", { player: name, platform }), platform);
  }

  async playerByUid(uid: string, platform: string): Promise<ApexPlayer> {
    return parsePlayer(await this.call("/bridge", { uid, platform }), platform);
  }

  async maps(): Promise<MapRotation> {
    const r = await this.call("/maprotation", { version: "2" });
    const slot = (x: Json | undefined): MapSlot | undefined =>
      x?.map
        ? {
            map: String(x.map),
            start: typeof x.start === "number" ? x.start * 1000 : undefined,
            end: typeof x.end === "number" ? x.end * 1000 : undefined,
            image: typeof x.asset === "string" ? x.asset : undefined,
            minutes: typeof x.DurationInMinutes === "number" ? x.DurationInMinutes : undefined,
          }
        : undefined;
    const pair = (x: Json | undefined) => {
      const current = slot(x?.current);
      return current ? { current, next: slot(x?.next) } : undefined;
    };
    return { pubs: pair(r.battle_royale), ranked: pair(r.ranked) };
  }

  async predator(): Promise<PredatorCut[]> {
    const r = await this.call("/predator");
    const rp = (r.RP ?? {}) as Json;
    return Object.entries(rp)
      .filter(([, v]) => v && typeof v === "object" && Number.isFinite(Number(v.val)))
      .map(([platform, v]) => ({
        platform,
        rp: Number(v.val),
        mastersAndPreds: Number.isFinite(Number(v.totalMastersAndPreds)) ? Number(v.totalMastersAndPreds) : undefined,
        updatedAt: typeof v.updateTimestamp === "number" ? v.updateTimestamp * 1000 : undefined,
      }));
  }

  async servers(): Promise<ServerGroup[]> {
    const r = await this.call("/servers");
    const out: ServerGroup[] = [];
    for (const [key, regions] of Object.entries(r)) {
      if (!SERVER_GROUPS[key] || !regions || typeof regions !== "object") continue;
      const g: ServerGroup = { name: SERVER_GROUPS[key], up: 0, slow: 0, down: 0, problems: [] };
      for (const [region, info] of Object.entries(regions as Json)) {
        const status = String((info as Json)?.Status ?? "").toUpperCase();
        if (status === "UP") g.up++;
        else if (status === "SLOW") {
          g.slow++;
          g.problems.push(`${region.replace(/[-_]/g, " ")} (slow)`);
        } else if (status) {
          g.down++;
          g.problems.push(`${region.replace(/[-_]/g, " ")} (down)`);
        }
      }
      if (g.up + g.slow + g.down) out.push(g);
    }
    return out;
  }
}

function parsePlayer(r: Json, platform: string): ApexPlayer {
  const g = (r.global ?? {}) as Json;
  if (!g.name && !g.uid) throw new ApiError("the Apex stats service", "http", "Player not found", 404);
  const rank = (g.rank ?? {}) as Json;
  const rt = (r.realtime ?? {}) as Json;
  const sel = (r.legends?.selected ?? {}) as Json;
  const trackers = (Array.isArray(sel.data) ? sel.data : [])
    .map((t: Json) => ({ name: String(t.name ?? t.key ?? "Tracker"), value: Number(t.value) }))
    .filter((t: { value: number }) => Number.isFinite(t.value));
  let trackedKills: number | undefined;
  const totalKills = Number(r.total?.kills?.value);
  if (Number.isFinite(totalKills) && totalKills > 0) trackedKills = totalKills;
  return {
    uid: String(g.uid ?? ""),
    name: String(g.name ?? "Unknown"),
    platform: String(g.platform ?? platform),
    level: Number(g.level) || 0,
    prestige: Number(g.levelPrestige) || 0,
    rank: {
      score: Number(rank.rankScore) || 0,
      name: String(rank.rankName ?? "Unranked"),
      div: Number(rank.rankDiv) || 0,
      img: typeof rank.rankImg === "string" ? rank.rankImg : undefined,
      season: typeof rank.rankedSeason === "string" ? rank.rankedSeason : undefined,
      ladderPos: Number(rank.ladderPosPlatform) > 0 ? Number(rank.ladderPosPlatform) : undefined,
    },
    online: Number(rt.isOnline) === 1,
    inGame: Number(rt.isInGame) === 1,
    state: typeof rt.currentStateAsText === "string" ? rt.currentStateAsText : undefined,
    legend: typeof sel.LegendName === "string" ? sel.LegendName : typeof rt.selectedLegend === "string" ? rt.selectedLegend : undefined,
    legendIcon: typeof sel.ImgAssets?.icon === "string" ? sel.ImgAssets.icon : undefined,
    trackers,
    trackedKills,
    banned: g.bans?.isActive === true,
  };
}
