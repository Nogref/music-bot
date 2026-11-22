// The real voice code against a real Opus stream (no Discord connection needed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSubsonicMock } from "./mockSubsonic.mjs";
import { settle } from "./helpers.mjs";
import { SubsonicClient } from "../dist/services/subsonic.js";
import { DiscordVoiceLink } from "../dist/player/voice.js";
import { setDefaultTimeout } from "../dist/core/http.js";

let mock;
before(async () => {
  mock = await startSubsonicMock();
  setDefaultTimeout(2000);
});
after(() => mock.close());

test("streams Opus from the library; volume only decodes when it isn't 100%; seek asks for an offset", async () => {
  const link = new DiscordVoiceLink(new SubsonicClient({ url: mock.base, user: "bot", password: "pw", bitrate: 128 }));
  const ends = [];
  link.onEnd((token, err) => ends.push({ token, err }));

  const t1 = await link.play("s1", 0, 100);
  assert.equal(link.setVolume(50), false, "100% is passed straight through, so changing it needs a restart");
  const t2 = await link.play("s1", 42, 70);
  assert.ok(t2 > t1);
  assert.equal(link.setVolume(50), true, "a decoded stream changes volume live");
  const stream = mock.calls.filter((c) => c.method === "stream").at(-1);
  assert.equal(stream.query.timeOffset, "42");
  assert.equal(stream.query.format, "opus");
  assert.deepEqual(ends, [], "replacing a stream on purpose doesn't report an end");

  link.stop();
  await settle(50);
  assert.deepEqual(ends.map((e) => e.token), [t2], "stopping reports the current stream's token");

  await assert.rejects(link.play("broken", 0, 100), /error instead of audio/);
  link.destroy();
});
