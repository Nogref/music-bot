// Apex stats: the API client, ranks and weeks, /apex commands, the leaderboard and rank-up shout-outs.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApexMock } from "./mockApex.mjs";
import { FakeLink, fakeClient, fakeConfig, fakeInteraction, settle, json } from "./helpers.mjs";
import { SubsonicClient } from "../dist/services/subsonic.js";
import { Store } from "../dist/core/db.js";
import { buildApp } from "../dist/app.js";
import { ApexClient } from "../dist/apex/client.js";
import { rankLabel, rankValue, weekStart } from "../dist/apex/ranks.js";
import { setDefaultTimeout } from "../dist/core/http.js";
import { redact } from "../dist/core/logger.js";

let mock;
before(async () => {
  mock = await startApexMock();
  setDefaultTimeout(2000);
});
after(() => mock.close());
beforeEach(() => mock.reset());

const apexCfg = () => ({ apiKey: "apex-key", url: mock.base, pollMinutes: 15, timezone: "America/Chicago" });

function setup() {
  const cfg = fakeConfig({ apex: apexCfg() });
  const store = new Store(cfg.dataDir);
  const client = fakeClient();
  const app = buildApp({ cfg, store, client, subsonic: new SubsonicClient(cfg.subsonic), link: () => new FakeLink(), renderDelayMs: 0, apexGapMs: 0 });
  const guild = client.addGuild("g1", { name: "Apex squad" });
  store.saveGuild({ id: "g1", name: "Apex squad", status: "approved", addedAt: Date.now(), present: true });
  const run = async (opts) => {
    const i = fakeInteraction(client, { guild, ...opts });
    await app.router.handle(i);
    await settle();
    return i;
  };
  return { cfg, store, client, app, guild, run, tracker: app.apex.tracker, astore: app.apex.astore };
}
const text = (i) => i.last()?.content ?? "";
const embed = (i, n = 0) => json(i.last().embeds[n]);

test("API client: players, the 200-with-an-Error quirk, slowing down when told to, and no key in logs", async () => {
  const c = new ApexClient(apexCfg(), 0);
  mock.setPlayer({ name: "SamTheSniper", uid: "1001", score: 8123, rank: "Platinum", div: 3, online: 1 });
  const p = await c.player("samthesniper", "PC");
  assert.equal(p.name, "SamTheSniper");
  assert.deepEqual(p.rank, { score: 8123, name: "Platinum", div: 3, img: "https://api.mozambiquehe.re/assets/ranks/platinum3.png", season: "season27_split_1", ladderPos: undefined });
  assert.equal(p.state, "In lobby (02:14)");
  assert.deepEqual(p.trackers, [{ name: "BR Kills", value: 1234 }]);
  assert.equal(p.trackedKills, 1234);
  assert.equal(mock.calls.at(-1).query.auth, "apex-key");

  await assert.rejects(c.player("nobody", "PC"), (e) => e.status === 404);
  mock.state.slowDownOnce = true;
  assert.equal((await c.playerByUid("1001", "PC")).name, "SamTheSniper", "retried after 'slow down'");
  assert.equal(redact(`${mock.base}/bridge?player=x&auth=apex-key`), `${mock.base}/bridge?player=x&auth=***`);
});

test("gets past the API's firewall (it turns away Node's default agent); explains a refusal in the log and politely to members", async () => {
  const plain = await fetch(`${mock.base}/maprotation?auth=apex-key&version=2`);
  assert.equal(plain.status, 406, "the fake really does block plain fetch");
  const c = new ApexClient(apexCfg(), 0);
  assert.equal((await c.maps()).pubs.current.map, "World's Edge");
  assert.match(mock.calls.at(-1).userAgent, /^music-bot\/1\.0/);

  mock.state.blockAll = true;
  await assert.rejects(c.maps(), (e) => {
    assert.match(e.message, /returned HTTP 406: 406 Not Acceptable Not Acceptable! An appropriate representation .* \(the request was blocked by the stats service's firewall\)/);
    return true;
  });
  const env = setup();
  const i = await env.run({ command: "apex", sub: "map" });
  assert.equal(i.last().content, "⚠️ The Apex stats service isn't answering properly right now. Try again in a minute.");
  mock.state.blockAll = false;
});

test("the bot's status rotates through how to start, how many servers, and what's playing", async () => {
  const { presenceLines } = await import("../dist/presence.js");
  assert.deepEqual(presenceLines({ servers: 3, playing: 0 }).map((l) => l.name), ["/play · /help", "3 servers"]);
  assert.deepEqual(presenceLines({ servers: 1, playing: 2 }).map((l) => l.name), ["/play · /help", "1 server", "music in 2 servers"]);
  const env = setup();
  const set = [];
  env.client.user.setPresence = (p) => set.push(p.activities[0].name);
  env.app.presence.tick();
  env.app.presence.tick();
  env.app.presence.tick();
  assert.deepEqual(set, ["/play · /help", "1 server", "/play · /help"]);
});

test("ranks order and read naturally; weeks start Monday midnight Central, daylight saving included", () => {
  assert.ok(rankValue({ name: "Diamond", div: 1 }) > rankValue({ name: "Diamond", div: 4 }));
  assert.ok(rankValue({ name: "Master", div: 0 }) > rankValue({ name: "Diamond", div: 1 }));
  assert.ok(rankValue({ name: "Apex Predator", div: 0 }) > rankValue({ name: "Master", div: 0 }));
  assert.equal(rankValue({ name: "Unranked", div: 0 }), -1);
  assert.equal(rankLabel({ name: "Diamond", div: 2 }), "Diamond II");
  assert.equal(rankLabel({ name: "Master", div: 0 }), "Master");
  // Sunday Nov 22 2026, 2 PM Central → Monday Nov 16, 00:00 CST (06:00 UTC).
  assert.equal(new Date(weekStart(Date.UTC(2026, 10, 22, 20), "America/Chicago")).toISOString(), "2026-11-16T06:00:00.000Z");
  // Monday 00:30 Central is already the new week.
  assert.equal(new Date(weekStart(Date.UTC(2026, 10, 23, 6, 30), "America/Chicago")).toISOString(), "2026-11-23T06:00:00.000Z");
  // Tuesday Mar 10 2026, after clocks went forward on Sunday → Monday Mar 9, 00:00 CDT (05:00 UTC).
  assert.equal(new Date(weekStart(Date.UTC(2026, 2, 10, 18), "America/Chicago")).toISOString(), "2026-03-09T05:00:00.000Z");
});

test("/apex link checks the name, then /apex me and /apex stats show rank, RP, level and banner trackers", async () => {
  const env = setup();
  mock.setPlayer({ name: "SamTheSniper", uid: "1001", score: 16200, rank: "Master", div: 0, online: 1, trackers: [{ name: "BR Kills", value: 4321 }, { name: "BR Damage", value: 1234567 }] });
  const bad = await env.run({ command: "apex", sub: "link", options: { player: "Sam The Typo", platform: "PC" } });
  assert.match(text(bad), /couldn't find \*\*Sam The Typo\*\* on PC/);

  const ok = await env.run({ command: "apex", sub: "link", options: { player: "samthesniper", platform: "PC" } });
  assert.match(text(ok), /Linked you to \*\*SamTheSniper\*\* on PC/);
  assert.deepEqual(env.astore.link("u1"), { userId: "u1", uid: "1001", name: "SamTheSniper", platform: "PC", linkedAt: env.astore.link("u1").linkedAt, lastPolledAt: env.astore.link("u1").lastPolledAt });

  const me = await env.run({ command: "apex", sub: "me" });
  const e = embed(me);
  assert.equal(e.title, "SamTheSniper · PC");
  assert.equal(e.author.name, "u1-nick");
  assert.equal(
    e.description,
    "🟣 **Master** · 16,200 RP\n🔴 1,441 RP to the Predator cutoff (17,641)\n⭐ Level 250 (40% to 251) · Prestige 1 · Battle pass 45\n🟢 In the lobby since <t:1795370000:R>, playing **Wraith**",
  );
  assert.deepEqual(e.fields[0], { name: "🎯 Wraith's banner", value: "BR Kills: **4,321**\nBR Damage: **1,234,567**" });
  assert.equal(e.thumbnail.url, "https://api.mozambiquehe.re/assets/ranks/master0.png");
  assert.equal(e.image.url, "https://example.test/Wraith_banner.jpg");
  assert.equal(e.url, "https://apexlegendsstatus.com/profile/uid/PC/1001");
  assert.match(e.footer.text, /Equip those trackers on the legend's banner/);

  // Another legend's banner stats, and one they haven't played.
  const hound = await env.run({ command: "apex", sub: "me", options: { legend: "bloodhound" } });
  assert.deepEqual(embed(hound).fields[0], { name: "🎯 Bloodhound's banner", value: "BR Wins: **87**\nBR Kills: **950**" });
  assert.equal(embed(hound).image.url, "https://example.test/Bloodhound_banner.jpg");
  assert.equal(embed(hound).fields.length, 1, "no all-legends kill total on a single-legend view");
  const life = await env.run({ command: "apex", sub: "me", options: { legend: "Lifeline" } });
  assert.equal(embed(life).fields[0].value, "*No trackers equipped on this legend's banner.*");
  const nope = await env.run({ command: "apex", sub: "me", options: { legend: "Bigfoot" } });
  assert.match(embed(nope).fields[0].value, /No stats for Bigfoot yet/);
  const ac = await env.run({ command: "apex", focused: "", sub: "me" });
  const names = ac.log.at(-1).choices.map((c) => c.name);
  assert.deepEqual(names.slice(0, 3), ["Wraith", "Bloodhound", "Lifeline"], "their own legends come first");
  assert.ok(names.includes("Octane"), "then everyone else");
  const typed = await env.run({ command: "apex", focused: "blood", sub: "me" });
  assert.deepEqual(typed.log.at(-1).choices, [{ name: "Bloodhound", value: "Bloodhound" }]);

  const friend = await env.run({ command: "apex", sub: "stats", options: { member: { id: "u2", username: "u2" } } });
  assert.match(text(friend), /<@u2> hasn't linked an Apex account/);
  mock.setPlayer({ name: "Rando", uid: "2002", platform: "PS4", score: 300, rank: "Bronze", div: 4 });
  const lookup = await env.run({ command: "apex", sub: "stats", options: { player: "Rando", platform: "PS4" } });
  assert.equal(embed(lookup).title, "Rando · PlayStation");
  const notMe = await env.run({ command: "apex", sub: "me", userId: "u3" });
  assert.match(text(notMe), /haven't linked your Apex account yet/);
  const gone = await env.run({ command: "apex", sub: "unlink" });
  assert.match(text(gone), /Unlinked/);
});

test("link and look up by UID instead of name", async () => {
  const env = setup();
  mock.setPlayer({ name: "Ünïcødé Näme", uid: "1000575543540", platform: "PC", score: 7000, rank: "Platinum", div: 4 });
  const ok = await env.run({ command: "apex", sub: "link", options: { platform: "PC", uid: "1000575543540" } });
  assert.match(text(ok), /Linked you to \*\*Ünïcødé Näme\*\* on PC/);
  assert.equal(env.astore.link("u1").uid, "1000575543540");
  assert.equal(mock.calls.filter((c) => c.path === "/bridge").at(-1).query.uid, "1000575543540");

  const both = await env.run({ command: "apex", sub: "link", options: { platform: "PC", uid: "1000575543540", player: "x" } });
  assert.match(text(both), /either `player:` or `uid:`, not both/);
  const neither = await env.run({ command: "apex", sub: "link", options: { platform: "PC" } });
  assert.match(text(neither), /Give your in-game name with `player:`, or your UID with `uid:`/);
  const junk = await env.run({ command: "apex", sub: "link", options: { platform: "PC", uid: "my uid" } });
  assert.match(text(junk), /A UID is just digits/);
  const missing = await env.run({ command: "apex", sub: "link", options: { platform: "PS4", uid: "1000575543540" } });
  assert.match(text(missing), /There's no PlayStation player with UID `1000575543540`/);

  const look = await env.run({ command: "apex", sub: "stats", options: { uid: "1000575543540" } });
  assert.equal(embed(look).title, "Ünïcødé Näme · PC");
});

test("server admins can link and unlink someone else; members can only do themselves", async () => {
  const env = setup();
  mock.setPlayer({ name: "JoPlays", uid: "3003", platform: "PS4", score: 6000, rank: "Gold", div: 1 });
  const jo = { id: "u2", username: "u2", bot: false };
  const notAdmin = await env.run({ command: "apex", sub: "link", options: { player: "JoPlays", platform: "PS4", member: jo } });
  assert.match(text(notAdmin), /Only server admins can link or unlink someone else/);
  assert.equal(env.astore.link("u2"), undefined);

  const ok = await env.run({ command: "apex", sub: "link", options: { player: "JoPlays", platform: "PS4", member: jo }, admin: true });
  assert.equal(text(ok), "✅ Linked <@u2> to **JoPlays** on PlayStation. They're on the squad leaderboard now, and can undo it with `/apex unlink`.");
  assert.equal(embed(ok).author.name, "u2-nick");
  assert.deepEqual(ok.last().allowedMentions, { parse: [] });
  assert.equal(env.astore.link("u2").uid, "3003");
  assert.equal(env.astore.link("u1"), undefined, "the admin isn't linked");

  mock.setPlayer({ name: "JoAlt", uid: "3004", platform: "PS4" });
  const swap = await env.run({ command: "apex", sub: "link", options: { player: "JoAlt", platform: "PS4", member: jo }, admin: true });
  assert.match(text(swap), /\(was \*\*JoPlays\*\*\)/);
  const bot = await env.run({ command: "apex", sub: "link", options: { player: "JoPlays", platform: "PS4", member: { id: "b1", username: "b1", bot: true } }, admin: true });
  assert.match(text(bot), /Bots don't play Apex/);

  const denied = await env.run({ command: "apex", sub: "unlink", options: { member: jo } });
  assert.match(text(denied), /Only server admins/);
  const removed = await env.run({ command: "apex", sub: "unlink", options: { member: jo }, admin: true });
  assert.equal(text(removed), "👋 Unlinked <@u2>. They're off the leaderboard.");
  assert.equal(env.astore.link("u2"), undefined);
  // Anyone can still pass themselves.
  const self = await env.run({ command: "apex", sub: "link", options: { player: "JoPlays", platform: "PS4", member: { id: "u1", username: "u1", bot: false } } });
  assert.match(text(self), /Linked you to \*\*JoPlays\*\*/);
});

test("/apex map shows Pubs and Ranked, now and next, with the map pictures", async () => {
  const env = setup();
  const m = await env.run({ command: "apex", sub: "map" });
  const [pubs, ranked] = m.last().embeds.map(json);
  assert.equal(pubs.title, "🗺️ Pubs: World's Edge");
  assert.match(pubs.description, /^Changes <t:\d+:R> \(at <t:\d+:t>\)\nNext: \*\*Olympus\*\* for 40 min$/);
  assert.equal(pubs.image.url, "https://apexlegendsstatus.com/assets/maps/Worlds_Edge.png");
  assert.equal(ranked.title, "🏆 Ranked: Storm Point");
  assert.match(ranked.description, /Next: \*\*Broken Moon\*\* for 24 hours/);
  assert.equal(ranked.image.url, "https://apexlegendsstatus.com/assets/maps/Storm_Point.png");
  assert.equal(m.last().embeds.length, 2, "no Mixtape");
  await env.run({ command: "apex", sub: "map" });
  assert.equal(mock.calls.filter((c) => c.path === "/maprotation").length, 1, "cached for a minute");
});

test("/apex predator and /apex servers", async () => {
  const env = setup();
  const p = await env.run({ command: "apex", sub: "predator" });
  assert.match(embed(p).description, /^\*\*PC:\*\* 17,641 RP · 2,786 Masters & Preds\n\*\*PlayStation:\*\* 16,553 RP · 1,620 Masters & Preds\n\*\*Xbox:\*\* 16,000 RP/);
  const s = await env.run({ command: "apex", sub: "servers" });
  const e = embed(s);
  assert.equal(e.title, "🛰️ Apex servers: some are slow");
  assert.match(e.description, /✅ \*\*EA login:\*\* all 2 up\n⚠️ \*\*Matchmaking:\*\* US Central \(slow\)/);
  assert.doesNotMatch(e.description, /selfCoreTest|Status website/, "the status site's own check isn't listed");
  const d = await env.run({ command: "apex", sub: "servers", options: { details: true } });
  const fields = embed(d).fields;
  assert.deepEqual(fields.find((f) => f.name === "Matchmaking"), { name: "Matchmaking", value: "✅ 🇪🇺 EU West\n⚠️ 🇺🇸 US Central", inline: true });
  assert.equal(fields.find((f) => f.name === "PlayStation / Xbox").value, "✅ 🌐 PlayStation Network\n✅ 🌐 Xbox Live");
});

test("the leaderboard: linked members of this server, best first, with RP gained since Monday", async () => {
  const env = setup();
  const ws = weekStart(Date.now(), "America/Chicago");
  const link = (userId, uid, name) => env.astore.setLink({ userId, uid, name, platform: "PC", linkedAt: 1 });
  link("u1", "1001", "SamTheSniper");
  link("u2", "1002", "Jo");
  link("u9", "1009", "NotInThisServer");
  const snap = (uid, at, score, rankName, rankDiv, season = "season27_split_1") => env.astore.addSnapshot({ uid, at, season, score, rankName, rankDiv, level: 100 });
  snap("1001", ws - 3_600_000, 9000, "Platinum", 2); // end of last week
  snap("1001", Date.now() - 60_000, 9420, "Platinum", 2);
  snap("1002", ws - 86_400_000, 12000, "Diamond", 4);
  snap("1002", Date.now() - 60_000, 11900, "Diamond", 4);
  snap("1009", Date.now() - 60_000, 20000, "Master", 0);

  const text = await env.run({ command: "setup", sub: "apex-leaderboard", options: { channel: env.guild.general }, admin: true });
  assert.match(text.last().content, /Leaderboard posted in <#g1-general>.*Rank-up shout-outs go there too/);
  const board = env.client.sent.find((s) => s.channelId === "g1-general").message;
  const e = json(board.latest.embeds[0]);
  assert.equal(e.title, "🏆 Squad leaderboard");
  assert.equal(e.description, "🥇 **u2-nick** · 💎 Diamond IV · 11,900 RP · ▼ 100\n🥈 **u1-nick** · 💠 Platinum II · 9,420 RP · ▲ 420");
  assert.deepEqual(e.fields, [{ name: "📈 Top climber this week", value: "**u1-nick**, 420 RP" }]);
  assert.match(e.footer.text, /since Monday 12 AM, America\/Chicago/);

  const mine = await env.run({ command: "apex", sub: "leaderboard" });
  assert.match(mine.last().content, /The live leaderboard is here: https:\/\/discord\.com\/channels\/g1\/g1-general\//);
});

test("checks linked players on a schedule, celebrates a new season-high rank once, and starts fresh in a new season", async () => {
  const env = setup();
  const sent = () => env.client.sent.filter((s) => s.channelId === "g1-general" && s.payload.embeds?.some((x) => /just hit/.test(json(x).title)));
  await env.run({ command: "setup", sub: "apex-leaderboard", options: { channel: env.guild.general }, admin: true });
  mock.setPlayer({ name: "Sam", uid: "1001", score: 7900, rank: "Platinum", div: 4 });
  await env.run({ command: "apex", sub: "link", options: { player: "Sam", platform: "PC" } });

  const later = (minutes) => Date.now() + minutes * 60_000;
  mock.setPlayer({ name: "Sam", uid: "1001", score: 8100, rank: "Platinum", div: 3 });
  await env.tracker.pollDue(later(5));
  assert.equal(sent().length, 0, "not due yet (every 15 minutes)");
  await env.tracker.pollDue(later(16));
  assert.equal(sent().length, 1);
  const shout = json(sent()[0].payload.embeds[0]);
  assert.equal(shout.title, "🎉 u1-nick just hit 💠 Platinum III!");
  assert.match(shout.description, /<@u1> reached a new high for the season: \*\*Platinum III\*\* with \*\*8,100 RP\*\*/);
  assert.deepEqual(sent()[0].payload.allowedMentions, { parse: [] }, "no ping, just a mention");
  const board = env.client.sent.find((s) => s.channelId === "g1-general" && /Squad leaderboard/.test(json(s.payload.embeds[0]).title)).message;
  assert.match(json(board.latest.embeds[0]).description, /Platinum III · 8,100 RP/, "the board updated after the check");

  // Dropping back and climbing again isn't a new high.
  const link = () => env.astore.link("u1");
  mock.setPlayer({ name: "Sam", uid: "1001", score: 7950, rank: "Platinum", div: 4 });
  await env.tracker.record(link(), await new ApexClient(apexCfg(), 0).playerByUid("1001", "PC"));
  mock.setPlayer({ name: "Sam", uid: "1001", score: 8050, rank: "Platinum", div: 3 });
  await env.tracker.record(link(), await new ApexClient(apexCfg(), 0).playerByUid("1001", "PC"));
  assert.equal(sent().length, 1);

  // New season: ranks reset, nothing to celebrate, and the week counts from the new season.
  mock.setPlayer({ name: "Sam", uid: "1001", score: 1000, rank: "Bronze", div: 4, season: "season28_split_1" });
  await env.tracker.record(link(), await new ApexClient(apexCfg(), 0).playerByUid("1001", "PC"));
  assert.equal(sent().length, 1);
  const latest = env.astore.latest("1001");
  assert.equal(env.tracker.weekDelta("1001", latest), 0);

  // Shout-outs can go elsewhere, or nowhere.
  const off = await env.run({ command: "setup", sub: "apex-shoutouts", options: {}, admin: true });
  assert.match(off.last().content, /shout-outs are off/);
  mock.setPlayer({ name: "Sam", uid: "1001", score: 3500, rank: "Silver", div: 4, season: "season28_split_1" });
  await env.tracker.record(link(), await new ApexClient(apexCfg(), 0).playerByUid("1001", "PC"));
  assert.equal(sent().length, 1);
});

test("/apex and its /setup options only exist when APEX_API_KEY is set; everything is valid for Discord", () => {
  const env = setup();
  const cmds = env.app.router.guildCommandJson;
  const apex = cmds.find((c) => c.name === "apex");
  assert.deepEqual(apex.options.map((o) => o.name), ["link", "unlink", "me", "stats", "map", "predator", "servers", "leaderboard"]);
  assert.deepEqual(apex.options.find((o) => o.name === "stats").options.map((o) => o.name), ["member", "player", "uid", "platform", "legend"]);
  assert.deepEqual(apex.options.find((o) => o.name === "link").options.map((o) => [o.name, Boolean(o.required)]), [["platform", true], ["player", false], ["uid", false], ["member", false]]);
  assert.deepEqual(cmds.find((c) => c.name === "setup").options.map((o) => o.name), ["nowplaying", "apex-leaderboard", "apex-shoutouts"]);
  for (const sub of apex.options) {
    assert.ok(sub.description.length <= 100, sub.name);
    let optional = false;
    for (const o of sub.options ?? []) {
      assert.ok(o.description.length <= 100 && /^[-_a-z0-9]{1,32}$/.test(o.name), `${sub.name}/${o.name}`);
      if (o.required) assert.ok(!optional, `${sub.name}: required after optional`);
      else optional = true;
    }
  }
  const noKey = buildApp({ cfg: fakeConfig(), store: new Store(fakeConfig().dataDir), client: fakeClient(), subsonic: new SubsonicClient(fakeConfig().subsonic), link: () => new FakeLink() });
  assert.ok(!noKey.router.guildCommandJson.some((c) => c.name === "apex"));
  assert.deepEqual(noKey.router.guildCommandJson.find((c) => c.name === "setup").options.map((o) => o.name), ["nowplaying"]);
});
