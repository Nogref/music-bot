/** Apex ranks in order, how they're shown, and when the leaderboard's week starts. */

export const TIERS = ["Rookie", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Apex Predator"] as const;

const EMOJI: Record<string, string> = {
  Rookie: "🔰",
  Bronze: "🥉",
  Silver: "🥈",
  Gold: "🥇",
  Platinum: "💠",
  Diamond: "💎",
  Master: "🟣",
  "Apex Predator": "🔴",
};

const ROMAN = ["", "I", "II", "III", "IV"];

export interface RankLike {
  name: string;
  div: number;
}

/** A number that grows with rank: tier first, then division (IV is lowest, I highest). Unknown = -1. */
export function rankValue(r: RankLike): number {
  const tier = TIERS.findIndex((t) => t.toLowerCase() === r.name.toLowerCase());
  if (tier < 0) return -1;
  return tier * 10 + (r.div >= 1 && r.div <= 4 ? 5 - r.div : 0);
}

export function rankEmoji(name: string): string {
  return EMOJI[TIERS.find((t) => t.toLowerCase() === name.toLowerCase()) ?? ""] ?? "▫️";
}

/** "Diamond II", "Master", "Apex Predator". */
export function rankLabel(r: RankLike): string {
  const tier = TIERS.find((t) => t.toLowerCase() === r.name.toLowerCase()) ?? r.name;
  const hasDivs = tier !== "Master" && tier !== "Apex Predator";
  return hasDivs && r.div >= 1 && r.div <= 4 ? `${tier} ${ROMAN[r.div]}` : tier;
}

export const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US");

/** The wall-clock parts of `ms` in a time zone. */
function partsIn(ms: number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second), wd: p.weekday as string };
}

/** The instant a local wall-clock time happens in a time zone (handles daylight saving). */
function zonedToUtc(y: number, mo: number, d: number, timeZone: string): number {
  let guess = Date.UTC(y, mo - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, timeZone);
    const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess -= asIfUtc - Date.UTC(y, mo - 1, d);
  }
  return guess;
}

/** Monday 00:00 of the current week in `timeZone`, as epoch ms. */
export function weekStart(now: number, timeZone: string): number {
  const p = partsIn(now, timeZone);
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.wd);
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d - Math.max(0, back)));
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), timeZone);
}
