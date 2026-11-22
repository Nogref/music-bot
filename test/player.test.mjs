// The player on its own: queue order, loop, previous, seek, volume, radio, failures.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSubsonicMock } from "./mockSubsonic.mjs";
import { FakeLink, settle, json } from "./helpers.mjs";
import { SubsonicClient } from "../dist/services/subsonic.js";
import { MusicSession } from "../dist/player/session.js";
import { buildCard } from "../dist/player/card.js";
import { setDefaultTimeout } from "../dist/core/http.js";

let mock;
before(async () => {
  mock = await startSubsonicMock();
  setDefaultTimeout(2000);
});
after(() => mock.close());
beforeEach(() => mock.reset());

function session(opts = {}) {
  const link = new FakeLink();
  const cards = [];
  let ended = 0;
  const subsonic = new SubsonicClient({ url: mock.base, user: "bot", password: "pw", bitrate: 128 });
  const s = new MusicSession({
    guildId: opts.guildId ?? `g${Math.random()}`,
    subsonic,
    link,
    idleMinutes: 5,
    volume: opts.volume ?? 100,
    display: async (payload, isEnd) => void cards.push({ payload, ended: isEnd }),
    card: buildCard,
    renderDelayMs: 0,
    onEnd: () => ended++,
  });
  return { s, link, cards, ended: () => ended };
}
const songs = (...ids) => ids.map((id) => ({ song: mock.lib.songs.find((x) => x.id === id), requestedBy: "Sam" }));
const card = (cards) => json(cards.at(-1).payload.embeds[0]);

test("plays in order, moves on when a song ends, and leaves an idle card when the queue runs out", async () => {
  const { s, link, cards } = session();
  await s.enqueue(songs("s1", "s2"));
  assert.deepEqual(link.played, ["s1"]);
  link.finish();
  await settle();
  assert.deepEqual(link.played, ["s1", "s2"]);
  await settle();
  const c = card(cards);
  assert.match(c.title, /🎶 Karma Police/);
  assert.match(c.description, /\*\*Radiohead\*\* · \*OK Computer\*/);
  assert.match(c.description, /▶️ 0:00 \/ 4:24 · ends <t:\d+:R>/);
  assert.equal(c.footer.text, "Added by Sam");
  link.finish();
  await settle();
  assert.equal(s.current, undefined);
  assert.match(card(cards).title, /Queue finished/);
  s.destroy();
});

test("loop: one song repeats; the whole queue sends finished songs to the back", async () => {
  const { s, link } = session();
  await s.enqueue(songs("s1", "s2"));
  s.setLoop("song");
  link.finish();
  await settle();
  assert.deepEqual(link.played, ["s1", "s1"]);
  s.setLoop("queue");
  link.finish();
  await settle();
  link.finish();
  await settle();
  assert.deepEqual(link.played, ["s1", "s1", "s2", "s1"]);
  assert.deepEqual(s.queue.list().map((t) => t.song.id), ["s2"]);
  s.destroy();
});

test("previous goes back and puts the current song next; skip moves on", async () => {
  const { s, link } = session();
  await s.enqueue(songs("s1", "s2", "s3"));
  await s.skip();
  assert.deepEqual(link.played, ["s1", "s2"]);
  const back = await s.previous();
  assert.equal(back.song.id, "s1");
  assert.deepEqual(s.queue.list().map((t) => t.song.id), ["s2", "s3"]);
  // Nothing before the first song: start it again.
  const again = await s.previous();
  assert.equal(again.song.id, "s1");
  assert.deepEqual(link.plays.slice(-2).map((p) => [p.songId, p.offset]), [["s1", 0], ["s1", 0]]);
  s.destroy();
});

test("seek restarts the stream at that point (clamped to the song), keeping pause", async () => {
  const { s, link, cards } = session();
  await s.enqueue(songs("s2"));
  assert.equal(await s.seek(90), 90);
  assert.deepEqual(link.current, { songId: "s2", offset: 90, volume: 100, token: 2 });
  link.pos = 5000;
  assert.equal(Math.round(s.position), 95);
  await s.togglePause();
  assert.equal(await s.seek(9999), 263, "clamped to the end of the song");
  assert.equal(link.paused, true);
  assert.equal(s.paused, true);
  await settle();
  assert.match(card(cards).description, /⏸️ Paused at 4:23 \/ 4:24/);
  s.destroy();
});

test("volume: applied live when the stream allows it, otherwise restarted at the same spot", async () => {
  const { s, link, cards } = session();
  await s.enqueue(songs("s1"));
  link.pos = 30_000;
  await s.setVolume(70);
  assert.deepEqual(link.current, { songId: "s1", offset: 30, volume: 70, token: 2 }, "100% streams aren't decoded, so it restarts");
  await s.setVolume(40);
  assert.equal(link.plays.length, 2, "no restart needed now");
  assert.equal(link.liveVolume, 40);
  await settle();
  assert.match(card(cards).description, /🔊 40%/);
  s.destroy();
});

test("random radio keeps the queue topped up without repeating what's played or queued", async () => {
  const { s, link, cards } = session();
  await s.setRadio({ mode: "random" });
  assert.equal(link.current.songId, "s6");
  assert.deepEqual(s.queue.list().map((t) => t.song.id), ["s2", "s7", "s5", "s3"]);
  assert.ok(s.queue.list().every((t) => t.radio));
  // Something requested goes before the radio picks.
  await s.enqueue(songs("s1"));
  assert.equal(s.queue.list()[0].song.id, "s1");
  await settle();
  assert.match(card(cards).description, /📻 Radio: random songs from the library/);
  await s.setRadio(undefined);
  assert.deepEqual(s.queue.list().map((t) => t.song.id), ["s1"], "radio picks go when radio's turned off");
  s.destroy();
});

test("similar-song radio: songs like the seed; random ones (with a note) when there aren't any", async () => {
  const { s, link, cards } = session();
  await s.setRadio({ mode: "similar", seedId: "ar2", seedLabel: "**Massive Attack**" });
  assert.equal(link.current.songId, "s5");
  assert.deepEqual(s.queue.list().map((t) => t.song.id), ["s6"]);
  await settle();
  assert.match(card(cards).description, /📻 Radio: songs like \*\*Massive Attack\*\*/);

  const other = session();
  mock.lib.similarSupported = false;
  await other.s.setRadio({ mode: "similar", seedId: "s4", seedLabel: "**Teardrop**" });
  assert.equal(other.link.current.songId, "s6", "random instead");
  await settle();
  assert.match(card(other.cards).description, /I couldn't find more songs like \*\*Teardrop\*\*, so here are random ones/);
  s.destroy();
  other.s.destroy();
});

test("a song that won't play is skipped; five in a row stops the music", async () => {
  const { s, link, cards, ended } = session();
  link.failing.add("s1");
  await s.enqueue(songs("s1", "s2"));
  assert.deepEqual(link.played, ["s2"]);
  link.finish(new Error("decoder blew up"));
  await settle();
  for (const id of ["s3", "s4", "s5", "s6", "s7"]) link.failing.add(id);
  await s.enqueue(songs("s3", "s4", "s5", "s6", "s7"));
  await settle();
  assert.equal(ended(), 1);
  assert.match(card(cards).description, /stopped after several songs failed to play/);
  assert.equal(cards.at(-1).ended, true);
});

test("a stream replaced on purpose (seek, skip) doesn't count as the song ending", async () => {
  const { s, link } = session();
  await s.enqueue(songs("s1", "s2"));
  const oldToken = link.token;
  await s.seek(10);
  link.endCb(oldToken); // the replaced stream reports it ended
  await settle();
  assert.deepEqual(link.played, ["s1", "s1"]);
  s.destroy();
});

test("the card shows what's next and the status of loop and radio", async () => {
  const { s, cards } = session();
  await s.enqueue(songs("s4", "s5", "s6", "s7"));
  await settle();
  s.setLoop("queue");
  await settle();
  const c = card(cards);
  assert.equal(c.fields[0].name, "Up next");
  assert.equal(c.fields[0].value, "1. Angel by Massive Attack\n2. Glory Box by Portishead\n3. Roads by Portishead");
  assert.match(c.description, /🔁 Looping the queue/);
  assert.equal(c.footer.text, "Added by Sam · 3 in the queue");
  const buttons = cards.at(-1).payload.components.flatMap((r) => r.toJSON().components.map((b) => b.custom_id));
  assert.deepEqual(buttons, ["player:previous", "player:pause", "player:skip", "player:loop", "player:stop", "player:shuffle", "player:radio", "player:similar", "player:lyrics", "player:queue"]);
  assert.equal(cards.at(-1).payload.files?.length ?? 0, 0, "cover was attached on the first card, not every edit");
  assert.equal(cards[0].payload.files.length, 1);
  s.destroy();
});
