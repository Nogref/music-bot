// Slash commands and buttons, end to end through the router (with a fake voice link).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSubsonicMock } from "./mockSubsonic.mjs";
import { FakeLink, fakeClient, fakeConfig, fakeInteraction, settle, json } from "./helpers.mjs";
import { SubsonicClient } from "../dist/services/subsonic.js";
import { Store } from "../dist/core/db.js";
import { buildApp } from "../dist/app.js";
import { setDefaultTimeout } from "../dist/core/http.js";

let mock;
before(async () => {
  mock = await startSubsonicMock();
  setDefaultTimeout(2000);
});
after(() => mock.close());
beforeEach(() => mock.reset());

function setup({ approved = true } = {}) {
  const cfg = fakeConfig({ subsonic: { url: mock.base, user: "bot", password: "pw", bitrate: 128 } });
  const store = new Store(cfg.dataDir);
  const client = fakeClient();
  const subsonic = new SubsonicClient(cfg.subsonic);
  const links = [];
  const app = buildApp({ cfg, store, client, subsonic, link: () => links.push(new FakeLink()) && links.at(-1), renderDelayMs: 0 });
  const guild = client.addGuild("g1", { name: "Friends" });
  if (approved) store.saveGuild({ id: "g1", name: "Friends", status: "approved", addedAt: Date.now(), present: true });
  const run = async (opts) => {
    const i = fakeInteraction(client, { guild, ...opts });
    await app.router.handle(i);
    await settle();
    return i;
  };
  const text = (i) => i.last()?.content ?? "";
  const cardIn = (channelId) => {
    const m = client.sent.filter((s) => s.channelId === channelId && s.payload.embeds?.length).at(-1)?.message;
    return m ? json(m.latest.embeds[0]) : undefined;
  };
  return { cfg, store, client, app, guild, links, run, text, cardIn, link: () => links.at(-1) };
}

test("/play: needs a voice channel, plays from the library, and puts the card in the voice channel's chat", async () => {
  const env = setup();
  const away = await env.run({ command: "play", options: { query: "s:s1" }, inVoice: false });
  assert.match(env.text(away), /Join a voice channel first/);

  const p = await env.run({ command: "play", options: { query: "s:s1" } });
  assert.equal(env.text(p), "▶️ Playing **Paranoid Android by Radiohead** in <#g1-voice>.");
  assert.deepEqual(env.link().played, ["s1"]);
  assert.match(env.cardIn("g1-voice").title, /Paranoid Android/);
  assert.equal(env.cardIn("g1-voice").footer.text, "Added by u1-nick");

  const album = await env.run({ command: "play", options: { query: "a:a2" } });
  assert.equal(env.text(album), "➕ Queued the album **Mezzanine** by Massive Attack (2 songs).");
  const artist = await env.run({ command: "play", options: { query: "ar:ar3", next: true } });
  assert.equal(env.text(artist), "➕ Queued top songs by **Portishead** (2) to play next.");
  assert.deepEqual(env.app.player.sessions.get("g1").queue.list().map((t) => t.song.id), ["s6", "s7", "s4", "s5"]);
  const typed = await env.run({ command: "play", options: { query: "karma" } });
  assert.match(env.text(typed), /Queued \*\*Karma Police by Radiohead\*\*/, "typed without picking: best song match");
  const none = await env.run({ command: "play", options: { query: "zzzz" } });
  assert.match(env.text(none), /Nothing in the library matches/);
});

test("/play suggestions: artists, albums, playlists and songs", async () => {
  const env = setup();
  const i = await env.run({ command: "play", focused: "trip" });
  assert.deepEqual(i.log.at(-1).choices, [{ name: "📃 Trip hop night (playlist)", value: "p:p1" }]);
  const j = await env.run({ command: "play", focused: "portis" });
  assert.deepEqual(j.log.at(-1).choices.map((c) => c.value), ["ar:ar3", "a:a3", "s:s6", "s:s7"]);
  assert.equal(j.log.at(-1).choices[0].name, "👤 Portishead (top songs)");
});

test("controls work for people in the bot's voice channel and for server admins", async () => {
  const env = setup();
  await env.run({ command: "play", options: { query: "a:a1" } });
  const other = { id: "elsewhere" };
  const denied = await env.run({ command: "skip", inVoice: other });
  assert.equal(env.text(denied), "Join <#g1-voice> to control the music.");
  const admin = await env.run({ command: "skip", inVoice: other, admin: true });
  assert.equal(env.text(admin), "⏭️ Skipped **Paranoid Android by Radiohead**.");
  const pressed = await env.run({ customId: "player:pause" });
  assert.equal(pressed.log[0].type, "deferUpdate");
  assert.equal(env.link().paused, true);
  assert.match(env.cardIn("g1-voice").title, /⏸️ Karma Police/);
  // Someone not listening can't take over the bot from another channel.
  const hijack = await env.run({ command: "play", options: { query: "s:s4" }, inVoice: { ...env.guild.voice, id: "other-voice", isSendable: () => true } });
  assert.match(env.text(hijack), /I'm already playing in <#g1-voice>/);
  const stop = await env.run({ command: "stop" });
  assert.equal(env.text(stop), "⏹️ Stopped, cleared the queue and left the channel.");
  assert.match(env.cardIn("g1-voice").description, /Stopped by u1-nick/);
  const nothing = await env.run({ command: "pause" });
  assert.match(env.text(nothing), /Nothing is playing/);
});

test("/queue pages, /remove, /clear and /shuffle", async () => {
  const env = setup();
  for (let n = 0; n < 3; n++) await env.run({ command: "play", options: { query: "a:a1" } });
  await env.run({ command: "play", options: { query: "p:p1" } });
  const q = await env.run({ command: "queue" });
  const e = json(q.last().embeds[0]);
  assert.match(e.description, /^\*\*Now:\*\* Paranoid Android by Radiohead · 0:00 \/ 6:23\n\n`1\.` Karma Police by Radiohead · 4:24/);
  assert.match(e.footer.text, /11 queued · .* · page 1 of 2/);
  const more = q.last().components[0].toJSON().components[1];
  assert.equal(more.custom_id, "queue:1");
  const page2 = await env.run({ customId: "queue:1" });
  assert.match(json(page2.last().embeds[0]).description, /`11\.` Roads by Portishead/);

  const rm = await env.run({ command: "remove", options: { number: 1 } });
  assert.equal(env.text(rm), "🗑️ Removed **Karma Police by Radiohead** from the queue.");
  const bad = await env.run({ command: "remove", options: { number: 99 } });
  assert.match(env.text(bad), /There's no song number 99/);
  const sh = await env.run({ command: "shuffle" });
  assert.equal(env.text(sh), "🔀 Shuffled 10 songs.");
  const clr = await env.run({ command: "clear" });
  assert.equal(env.text(clr), "🧹 Cleared 10 songs from the queue.");
  assert.deepEqual(env.link().played, ["s1"], "the current song keeps playing");
});

test("/seek, /volume (remembered per server) and /loop", async () => {
  const env = setup();
  await env.run({ command: "play", options: { query: "s:s1" } });
  const seek = await env.run({ command: "seek", options: { time: "1:30" } });
  assert.equal(env.text(seek), "⏩ Jumped to 1:30.");
  assert.equal(env.link().current.offset, 90);
  const huh = await env.run({ command: "seek", options: { time: "soon" } });
  assert.match(env.text(huh), /didn't understand that time/);

  const vol = await env.run({ command: "volume", options: { level: 80 } });
  assert.equal(env.text(vol), "🔊 Volume set to **80%**.");
  assert.deepEqual([env.link().current.volume, env.link().current.offset], [80, 90], "restarted at the same spot");
  const show = await env.run({ command: "volume" });
  assert.match(env.text(show), /The volume is \*\*80%\*\*/);
  assert.equal(env.store.settings("g1").volume, 80);

  const loop = await env.run({ command: "loop", options: { mode: "song" } });
  assert.equal(env.text(loop), "🔂 Looping this song.");
  await env.run({ customId: "player:loop" });
  assert.equal(env.app.player.sessions.get("g1").loop, "off", "the button cycles song → off");

  await env.run({ command: "stop" });
  await env.run({ command: "play", options: { query: "s:s2" } });
  assert.equal(env.link().current.volume, 80, "the next session starts at the server's volume");
});

test("/radio toggles random radio; /radio like: and ✨ More like this play similar songs", async () => {
  const env = setup();
  const on = await env.run({ command: "radio" });
  assert.match(env.text(on), /📻 Radio on: random songs from the library in <#g1-voice>/);
  assert.equal(env.link().current.songId, "s6");
  const off = await env.run({ command: "radio" });
  assert.match(env.text(off), /Radio off/);

  const like = await env.run({ command: "radio", options: { like: "ar:ar2" } });
  assert.match(env.text(like), /songs like \*\*Massive Attack\*\*/);
  const s = env.app.player.sessions.get("g1");
  assert.deepEqual(s.radio, { mode: "similar", seedId: "ar2", seedLabel: "**Massive Attack**" });

  await env.run({ command: "stop" });
  await env.run({ command: "play", options: { query: "s:s4" } });
  await env.run({ customId: "player:similar" });
  const s2 = env.app.player.sessions.get("g1");
  assert.equal(s2.radio.seedId, "s4");
  assert.deepEqual(s2.queue.list().map((t) => t.song.id), ["s5", "s6", "s7"]);
  const sugg = await env.run({ command: "radio", focused: "massive" });
  assert.equal(sugg.log.at(-1).choices[0].name, "👤 Massive Attack", "no '(top songs)' here");
});

test("/lyrics: the words to what's playing, marking the current line when they're synced", async () => {
  const env = setup();
  await env.run({ command: "play", options: { query: "s:s4" } });
  await env.run({ command: "play", options: { query: "s:s1" } });
  env.link().pos = 12_000;
  const l = await env.run({ command: "lyrics" });
  const e = json(l.last().embeds[0]);
  assert.equal(e.title, "📝 Teardrop by Massive Attack");
  assert.equal(e.description, "Love, love is a verb\n▶ **Love is a doing word**\nFearless on my breath");
  assert.equal(l.log[0].p.flags, 64, "private by default");
  const pub = await env.run({ command: "lyrics", options: { show_everyone: true } });
  assert.equal(pub.log[0].p.flags, undefined);
  await env.run({ command: "skip" });
  const none = await env.run({ customId: "player:lyrics" });
  assert.match(json(none.last().embeds[0]).description, /couldn't find lyrics/);
});

test("/setup nowplaying keeps a board in a channel; /nowplaying moves the chat card", async () => {
  const env = setup();
  await env.run({ command: "play", options: { query: "s:s1" } });
  const chatCard = env.client.sent.find((s) => s.channelId === "g1-voice").message;
  const text = env.client.textChannel("g1-music", { guild: env.guild });
  env.guild.channels.cache.set(text.id, text);
  const b = await env.run({ command: "setup", sub: "nowplaying", options: { channel: text }, admin: true });
  assert.match(env.text(b), /Now-playing board posted in <#g1-music>/);
  assert.equal(chatCard.deleted, true, "the chat card is retired");
  assert.match(env.cardIn("g1-music").title, /Paranoid Android/);
  await env.run({ command: "skip" });
  await settle();
  assert.match(env.cardIn("g1-music").title, /Queue finished/);
  const np = await env.run({ command: "nowplaying" });
  assert.match(env.text(np), /Nothing is playing/);

  await env.run({ command: "play", options: { query: "s:s2" } });
  const np2 = await env.run({ command: "nowplaying" });
  assert.match(env.text(np2), /The now-playing board is here: https:\/\/discord\.com\/channels\/g1\/g1-music\//);
  const rm = await env.run({ command: "setup", sub: "nowplaying", options: {}, admin: true });
  assert.match(env.text(rm), /Removed the now-playing board/);
  const moved = await env.run({ command: "nowplaying", channel: env.guild.general });
  assert.equal(env.text(moved), "🎶 Moved the now-playing card here.");
  assert.match(env.cardIn("g1-general").title, /Karma Police/);
});

test("servers that aren't approved get a polite 'not yet' instead of music", async () => {
  const env = setup({ approved: false });
  const i = await env.run({ command: "play", options: { query: "s:s1" } });
  assert.match(env.text(i), /waiting for the bot's owner to approve it/);
  assert.equal(env.links.length, 0);
  const ac = await env.run({ command: "play", focused: "radio" });
  assert.deepEqual(ac.log.at(-1).choices, []);
});

test("every command is valid for Discord: names, descriptions, option order", () => {
  const env = setup();
  const all = [...env.app.router.guildCommandJson, ...env.app.router.globalCommandJson];
  const names = env.app.router.guildCommandJson.map((c) => c.name).sort();
  assert.deepEqual(names, ["clear", "help", "loop", "lyrics", "nowplaying", "pause", "play", "previous", "queue", "radio", "remove", "seek", "setup", "shuffle", "skip", "stop", "volume"]);
  assert.deepEqual(env.app.router.globalCommandJson.map((c) => c.name), ["servers"]);
  const check = (o, where) => {
    assert.match(o.name, /^[-_\p{Ll}\p{N}]{1,32}$/u, `${where}: name`);
    assert.ok(o.description.length >= 1 && o.description.length <= 100, `${where}/${o.name}: description is ${o.description.length} long`);
    let optional = false;
    for (const c of o.options ?? []) {
      if (c.type === 1 || c.type === 2) check(c, `${where}/${o.name}`);
      else {
        check(c, `${where}/${o.name}`);
        if (c.required) assert.ok(!optional, `${where}/${o.name}: required option after an optional one`);
        else optional = true;
      }
    }
  };
  for (const c of all) check(c, "");
  const setupCmd = all.find((c) => c.name === "setup");
  assert.equal(setupCmd.default_member_permissions, "32", "only admins see /setup");
  assert.deepEqual(all.find((c) => c.name === "servers").contexts, [1], "/servers only in DMs with the bot");
});
