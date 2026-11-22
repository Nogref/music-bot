// The library client, the queue and the little parsers.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSubsonicMock } from "./mockSubsonic.mjs";
import { SubsonicClient } from "../dist/services/subsonic.js";
import { TrackQueue, parseTime, fmtDuration, songLabel } from "../dist/player/queue.js";
import { redact } from "../dist/core/logger.js";
import { setDefaultTimeout } from "../dist/core/http.js";

let mock;
before(async () => {
  mock = await startSubsonicMock();
  setDefaultTimeout(2000);
});
after(() => mock.close());
beforeEach(() => mock.reset());

const client = (user = "bot") => new SubsonicClient({ url: mock.base, user, password: "pw", bitrate: 96 });

test("token auth by default, password auth when the server can't do tokens, clear error on a bad login", async () => {
  const r = await client().search("radiohead");
  assert.equal(r.songs[0].title, "Paranoid Android");
  const call = mock.calls.find((c) => c.method === "search3");
  assert.equal(call.query.u, "bot");
  assert.ok(call.query.t && call.query.s && !call.query.p, "token auth");
  assert.equal(call.query.c, "music-bot");

  await client("tokenless").health();
  assert.equal(mock.calls.at(-1).query.p, `enc:${Buffer.from("pw").toString("hex")}`);

  await assert.rejects(client("bad").health(), /wrong Subsonic username or password/);
});

test("stream URLs ask for Opus at the set bitrate, and start partway in for seek", () => {
  const u = new URL(client().streamUrl("s1"));
  assert.equal(u.pathname, "/rest/stream");
  assert.equal(u.searchParams.get("format"), "opus");
  assert.equal(u.searchParams.get("maxBitRate"), "96");
  assert.equal(u.searchParams.get("timeOffset"), null);
  assert.equal(new URL(client().streamUrl("s1", 83.7)).searchParams.get("timeOffset"), "83");
});

test("similar songs: getSimilarSongs2, falling back to nothing when the server can't", async () => {
  const c = client();
  assert.deepEqual((await c.similarSongs("s4")).map((s) => s.id), ["s5", "s6", "s7"]);
  mock.lib.similarSupported = false;
  assert.deepEqual(await c.similarSongs("s4"), []);
  assert.deepEqual(
    mock.calls.slice(-2).map((x) => x.method),
    ["getSimilarSongs2", "getSimilarSongs"],
  );
});

test("lyrics: synced per-song lyrics first, then the classic artist + title lookup", async () => {
  const c = client();
  const synced = await c.lyrics(mock.lib.songs.find((s) => s.id === "s4"));
  assert.equal(synced.synced, true);
  assert.equal(synced.lines[1].value, "Love is a doing word");
  assert.equal(synced.lines[1].start, 10_000);

  const plain = await c.lyrics(mock.lib.songs.find((s) => s.id === "s6"));
  assert.deepEqual(plain, { synced: false, lines: [{ value: "I'm so tired" }, { value: "of playing" }] });

  mock.lib.lyricsBySongIdSupported = false;
  assert.equal((await c.lyrics(mock.lib.songs.find((s) => s.id === "s6"))).lines.length, 2, "works without the per-song call too");
  assert.equal(await c.lyrics(mock.lib.songs.find((s) => s.id === "s1")), undefined);
});

test("logs never show library credentials", () => {
  assert.equal(redact("http://a/rest/stream?u=bot&t=abc&s=def&p=enc:00&id=1"), "http://a/rest/stream?u=bot&t=***&s=***&p=***&id=1");
});

test("queue: radio picks stay behind what people asked for; remove, clear and history", () => {
  const q = new TrackQueue();
  const t = (id, radio = false) => ({ song: { id, title: id }, requestedBy: "u", radio });
  q.add([t("r1", true), t("r2", true)]);
  q.add([t("a"), t("b")]);
  assert.deepEqual(q.list().map((x) => x.song.id), ["a", "b", "r1", "r2"]);
  q.add([t("now")], true);
  assert.equal(q.list()[0].song.id, "now");
  assert.equal(q.remove(2).song.id, "a");
  assert.equal(q.remove(99), undefined);
  q.remember(t("old"));
  assert.ok(q.recentIds().has("old") && q.recentIds().has("r1"));
  q.clearRadio();
  assert.deepEqual(q.list().map((x) => x.song.id), ["now", "b"]);
  assert.equal(q.clear(), 2);
  assert.equal(q.popHistory().song.id, "old");
});

test("seek times: clock times, seconds, units and relative jumps", () => {
  assert.equal(parseTime("1:30", 0), 90);
  assert.equal(parseTime("90", 0), 90);
  assert.equal(parseTime("1:02:03", 0), 3723);
  assert.equal(parseTime("2m", 0), 120);
  assert.equal(parseTime("1m30s", 0), 90);
  assert.equal(parseTime("+30", 100), 130);
  assert.equal(parseTime("-15", 10), 0, "never before the start");
  assert.equal(parseTime("1:75", 0), undefined);
  assert.equal(parseTime("soon", 0), undefined);
  assert.equal(fmtDuration(3723), "1:02:03");
  assert.equal(fmtDuration(65), "1:05");
  assert.equal(songLabel({ title: "Roads", artist: "Portishead" }), "Roads by Portishead");
});
