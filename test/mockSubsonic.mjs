// A small fake Subsonic server (shaped like Aurral's built-in one).
import fs from "node:fs";
import http from "node:http";

export function freshLibrary() {
  const song = (id, title, artist, artistId, album, albumId, duration = 200) => ({ id, title, artist, artistId, album, albumId, duration, coverArt: `al-${albumId}` });
  const songs = [
    song("s1", "Paranoid Android", "Radiohead", "ar1", "OK Computer", "a1", 383),
    song("s2", "Karma Police", "Radiohead", "ar1", "OK Computer", "a1", 264),
    song("s3", "No Surprises", "Radiohead", "ar1", "OK Computer", "a1", 229),
    song("s4", "Teardrop", "Massive Attack", "ar2", "Mezzanine", "a2", 330),
    song("s5", "Angel", "Massive Attack", "ar2", "Mezzanine", "a2", 379),
    song("s6", "Glory Box", "Portishead", "ar3", "Dummy", "a3", 306),
    song("s7", "Roads", "Portishead", "ar3", "Dummy", "a3", 305),
  ];
  return {
    songs,
    artists: [
      { id: "ar1", name: "Radiohead" },
      { id: "ar2", name: "Massive Attack" },
      { id: "ar3", name: "Portishead" },
    ],
    albums: [
      { id: "a1", name: "OK Computer", artist: "Radiohead" },
      { id: "a2", name: "Mezzanine", artist: "Massive Attack" },
      { id: "a3", name: "Dummy", artist: "Portishead" },
    ],
    playlists: [{ id: "p1", name: "Trip hop night", entry: ["s4", "s6", "s7"] }],
    /** id → song ids that are "similar" (getSimilarSongs2). */
    similar: { s4: ["s5", "s6", "s7"], ar2: ["s5", "s6"], s1: ["s2", "s3"] },
    similarSupported: true,
    lyricsById: {
      s4: [{ synced: true, line: [{ start: 0, value: "Love, love is a verb" }, { start: 10_000, value: "Love is a doing word" }, { start: 20_000, value: "Fearless on my breath" }] }],
    },
    lyricsBySongIdSupported: true,
    /** "artist|title" → plain text, for the classic getLyrics. */
    lyricsText: { "Portishead|Glory Box": "I'm so tired\nof playing" },
    /** Random songs come back in this order. */
    randomOrder: ["s6", "s2", "s7", "s5", "s3"],
  };
}

export async function startSubsonicMock() {
  const calls = [];
  let lib = freshLibrary();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const q = Object.fromEntries(url.searchParams);
    const method = url.pathname.replace(/^\/rest\//, "");
    calls.push({ method, query: q });
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    const ok = (body = {}) => send(200, { "subsonic-response": { status: "ok", version: "1.16.1", ...body } });
    const fail = (code, message) => send(200, { "subsonic-response": { status: "failed", version: "1.16.1", error: { code, message } } });
    if (!url.pathname.startsWith("/rest/")) return send(404, { error: "nope" });
    if (q.u === "bad") return fail(40, "Wrong username or password");
    if (q.u === "tokenless" && q.t) return fail(41, "Token authentication not supported");
    const S = (id) => lib.songs.find((s) => s.id === id);
    switch (method) {
      case "ping":
        return ok();
      case "search3": {
        const t = String(q.query ?? "").toLowerCase();
        const has = (v) => v?.toLowerCase().includes(t);
        return ok({
          searchResult3: {
            song: lib.songs.filter((s) => has(s.title) || has(s.artist)).slice(0, Number(q.songCount ?? 10)),
            album: lib.albums.filter((a) => has(a.name) || has(a.artist)).slice(0, Number(q.albumCount ?? 6)),
            artist: lib.artists.filter((a) => has(a.name)).slice(0, Number(q.artistCount ?? 4)),
          },
        });
      }
      case "getSong":
        return S(q.id) ? ok({ song: S(q.id) }) : fail(70, "Song not found");
      case "getAlbum": {
        const a = lib.albums.find((x) => x.id === q.id);
        return a ? ok({ album: { ...a, song: lib.songs.filter((s) => s.albumId === a.id) } }) : fail(70, "Album not found");
      }
      case "getArtist": {
        const a = lib.artists.find((x) => x.id === q.id);
        return a ? ok({ artist: a }) : fail(70, "Artist not found");
      }
      case "getTopSongs":
        return ok({ topSongs: { song: lib.songs.filter((s) => s.artist === q.artist).slice(0, Number(q.count ?? 25)) } });
      case "getRandomSongs":
        return ok({ randomSongs: { song: lib.randomOrder.map(S).slice(0, Number(q.size ?? 10)) } });
      case "getSimilarSongs2":
        if (!lib.similarSupported) return fail(0, "Unknown method");
        return ok({ similarSongs2: { song: (lib.similar[q.id] ?? []).map(S) } });
      case "getSimilarSongs":
        return lib.similarSupported ? ok({ similarSongs: { song: (lib.similar[q.id] ?? []).map(S) } }) : fail(0, "Unknown method");
      case "getLyricsBySongId":
        if (!lib.lyricsBySongIdSupported) return send(404, "Not Found", "text/plain");
        return ok({ lyricsList: { structuredLyrics: lib.lyricsById[q.id] ?? [] } });
      case "getLyrics": {
        const text = lib.lyricsText[`${q.artist}|${q.title}`];
        return ok({ lyrics: text ? { artist: q.artist, title: q.title, value: text } : {} });
      }
      case "getPlaylists":
        return ok({ playlists: { playlist: lib.playlists.map(({ id, name, entry }) => ({ id, name, songCount: entry.length })) } });
      case "getPlaylist": {
        const p = lib.playlists.find((x) => x.id === q.id);
        return p ? ok({ playlist: { id: p.id, name: p.name, entry: p.entry.map(S) } }) : fail(70, "Playlist not found");
      }
      case "stream":
        if (q.id === "broken") return fail(70, "Track file missing");
        return send(200, fs.readFileSync(new URL("./fixtures/tone.opus", import.meta.url)), "audio/ogg");
      case "getCoverArt":
        return send(200, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg");
      default:
        return fail(0, `Unknown method ${method}`);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    get lib() {
      return lib;
    },
    reset() {
      lib = freshLibrary();
      calls.length = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
