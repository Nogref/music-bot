// Server approvals: the owner's DM, Approve / Leave, re-adds, and /servers in DMs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeLink, fakeClient, fakeConfig, fakeInteraction, settle, json } from "./helpers.mjs";
import { SubsonicClient } from "../dist/services/subsonic.js";
import { Store } from "../dist/core/db.js";
import { buildApp } from "../dist/app.js";

function setup(cfgOverrides = {}) {
  const cfg = fakeConfig(cfgOverrides);
  const store = new Store(cfg.dataDir);
  const client = fakeClient();
  const app = buildApp({ cfg, store, client, subsonic: new SubsonicClient(cfg.subsonic), link: () => new FakeLink(), renderDelayMs: 0 });
  /** Owner (or someone else) using /servers or pressing a button in DMs. */
  const inDm = async (opts, userId = "owner1") => {
    const i = fakeInteraction(client, { userId, ...opts });
    i.channel = null;
    await app.router.handle(i);
    await settle();
    return i;
  };
  return { cfg, store, client, app, inDm };
}
const posts = (client, channelId) => client.sent.filter((s) => s.channelId === channelId).map((s) => s.payload.content ?? "");

test("a new server waits: a hello there, a DM to you with Approve / Leave, and no commands until you approve", async () => {
  const env = setup();
  const g = env.client.addGuild("g2", { name: "Pizza Night", members: 40 });
  await env.app.servers.joined(g);
  assert.match(posts(env.client, "g2-general")[0], /My owner needs to approve this server first/);
  assert.equal(g.commandSets.length, 0, "no commands yet");
  assert.equal(env.store.guild("g2").status, "pending");

  const ask = env.client.dms.find((d) => d.to === "owner1");
  const e = json(ask.payload.embeds[0]);
  assert.equal(e.title, '🎵 Can "Pizza Night" use the music bot?');
  assert.deepEqual(e.fields.map((f) => [f.name, f.value.replace(/<t:\d+:R>/, "<time>")]), [
    ["Members", "40"],
    ["Server owner", "owner-of-g2 (<@someone>)"],
    ["Added", "<time>"],
  ]);
  assert.deepEqual(ask.payload.components[0].toJSON().components.map((b) => b.custom_id), ["srv:approve:g2", "srv:leave:g2"]);

  const notMe = await env.inDm({ customId: "srv:approve:g2" }, "rando");
  assert.match(notMe.last().content, /Only the music bot's owner/);
  assert.equal(env.store.guild("g2").status, "pending");

  const yes = await env.inDm({ customId: "srv:approve:g2" });
  assert.match(yes.last().content, /Approved \*\*Pizza Night\*\*/);
  assert.equal(env.store.guild("g2").status, "approved");
  assert.ok(g.commandSets[0].some((c) => c.name === "play"), "music commands registered there");
  assert.match(posts(env.client, "g2-general").at(-1), /This server is approved! Join a voice channel and use `\/play`/);
  const dmEdit = ask.message.latest;
  assert.match(json(dmEdit.embeds[0]).description, /Approved/);
  assert.deepEqual(dmEdit.components, [], "buttons gone once decided");
});

test("Leave turns a server down; if they add the bot again it leaves and tells you, with a way to change your mind", async () => {
  const env = setup();
  const g = env.client.addGuild("g3", { name: "Randos" });
  await env.app.servers.joined(g);
  const no = await env.inDm({ customId: "srv:leave:g3" });
  assert.match(no.last().content, /Left \*\*Randos\*\*. If they add me again, I'll leave again/);
  assert.equal(g.left, true);
  assert.match(posts(env.client, "g3-general").at(-1), /hasn't approved|didn't approve/);
  assert.equal(env.store.guild("g3").status, "denied");

  const again = env.client.addGuild("g3", { name: "Randos" });
  await env.app.servers.joined(again);
  assert.equal(again.left, true, "left straight away");
  const note = env.client.dms.at(-1);
  assert.match(note.payload.content, /added the music bot again, so I left/);
  assert.deepEqual(note.payload.components[0].toJSON().components.map((b) => b.custom_id), ["srv:approve:g3"]);
  const changed = await env.inDm({ customId: "srv:approve:g3" });
  assert.match(changed.last().content, /they'll need to add me again with the invite link: https:\/\/discord\.com\/oauth2\/authorize\?client_id=app1/);
  const third = env.client.addGuild("g3", { name: "Randos" });
  await env.app.servers.joined(third);
  assert.equal(third.left, false);
  assert.equal(third.commandSets.length, 1, "approved now, so it gets the commands");
});

test("your own servers and ALLOWED_GUILD_IDS are approved without asking; commands are only re-sent when they change", async () => {
  const env = setup({ preApproved: ["g5"] });
  const mine = env.client.addGuild("g4", { ownerId: "owner1" });
  const listed = env.client.addGuild("g5");
  await env.app.servers.syncAll();
  assert.equal(env.store.guild("g4").status, "approved");
  assert.equal(env.store.guild("g5").status, "approved");
  assert.equal(env.client.dms.length, 0, "nothing to ask");
  assert.equal(mine.commandSets.length, 1);
  assert.equal(listed.commandSets.length, 1);
  assert.deepEqual(posts(env.client, "g4-general"), [], "no hello needed");
  await env.app.servers.syncAll();
  assert.equal(mine.commandSets.length, 1, "unchanged commands aren't re-registered on restart");
});

test("restarts don't ask twice; a pending server whose DM never went out gets asked again", async () => {
  const env = setup();
  env.client.closedDMs.add("owner1");
  const g = env.client.addGuild("g6");
  await env.app.servers.joined(g);
  assert.equal(env.store.guild("g6").ownerDm, undefined);
  env.client.closedDMs.delete("owner1");
  await env.app.servers.syncAll();
  assert.equal(env.client.dms.length, 1, "asked once DMs worked");
  await env.app.servers.syncAll();
  assert.equal(env.client.dms.length, 1, "not again");
  assert.equal(posts(env.client, "g6-general").length, 1, "one hello in the server");

  env.app.servers.left(g);
  assert.equal(env.store.guild("g6").present, false);
});

test("/servers in DMs: list, approve, remove (ask again next time) and block", async () => {
  const env = setup();
  const a = env.client.addGuild("g7", { name: "Approved Place" });
  const p = env.client.addGuild("g8", { name: "Pending Place" });
  env.store.saveGuild({ id: "g7", name: "Approved Place", status: "approved", addedAt: 1, present: true });
  await env.app.servers.joined(p);

  const list = await env.inDm({ command: "servers", sub: "list" });
  const d = json(list.last().embeds[0]).description;
  assert.match(d, /\*\*✅ Approved \(1\)\*\*\n• \*\*Approved Place\*\* · `g7`/);
  assert.match(d, /\*\*⏳ Waiting for you \(1\)\*\*\n• \*\*Pending Place\*\* · `g8`/);
  const notMe = await env.inDm({ command: "servers", sub: "list" }, "rando");
  assert.match(notMe.last().content, /Only the music bot's owner/);

  const ac = await env.inDm({ command: "servers", sub: "approve", focused: "place" });
  assert.deepEqual(ac.log.at(-1).choices, [{ name: "⏳ Pending Place", value: "g8" }], "only ones that aren't approved yet");
  const ok = await env.inDm({ command: "servers", sub: "approve", options: { server: "g8" } });
  assert.match(ok.last().content, /Approved \*\*Pending Place\*\*/);

  const rm = await env.inDm({ command: "servers", sub: "remove", options: { server: "g7" } });
  assert.match(rm.last().content, /Left \*\*Approved Place\*\*. If they add me again, you'll get a new approval request/);
  assert.equal(a.left, true);
  assert.equal(env.store.guild("g7"), undefined);
  assert.match(posts(env.client, "g7-general").at(-1), /removed the music bot from this server/);

  const block = await env.inDm({ command: "servers", sub: "remove", options: { server: "g8", block: true } });
  assert.match(block.last().content, /I'll leave again/);
  assert.equal(env.store.guild("g8").status, "denied");
});
