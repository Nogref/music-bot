# music-bot

A self-hosted Discord music bot that plays **your own music library** in voice channels: Aurral's built-in Subsonic server (or Navidrome, gonic, any Subsonic server). It works in your server and your friends' servers, and **you approve each server** from a DM.

- `/play` with search-as-you-type: songs, albums, artists (their top songs) and playlists
- `/radio`: endless random songs, or `/radio like:` for songs like a song, album or artist you pick (also the **✨ More like this** button)
- `/lyrics`, with the current line marked when the lyrics are synced
- Loop (song or queue), previous, seek, volume per server, shuffle, queue management
- A now-playing card with buttons in the voice channel's chat, or a fixed board with `/setup nowplaying`
- One player per server, all playing from the same library at the same time
- Optional **Apex Legends stats**: link your account, `/apex me`, today's maps, the Predator cutoff, a squad leaderboard with RP gained this week, and rank-up shout-outs

Audio is streamed from the library as Opus and goes straight to Discord, so at 100% volume the bot does no audio work at all. Any other volume decodes and re-encodes in the bot (pure JavaScript, no ffmpeg). Plays through the bot aren't counted as plays in Aurral.

## Commands

| Command | What it does |
|---|---|
| `/play query [next]` | Play a song, album, artist or playlist. `next` puts it at the front of the queue |
| `/radio [like]` | Random songs from the library, or songs like the one you pick. Run it again to turn it off |
| `/pause` · `/skip` · `/previous` · `/stop` | Pause/resume, next song, back one song, stop and leave |
| `/seek time` | Jump to `1:30`, `90`, `2m`, or `+30` / `-15` from where it is |
| `/volume [level]` | 1–150 for this server (remembered). Empty shows the current volume |
| `/loop mode` | This song, the whole queue, or off |
| `/queue [page]` · `/remove number` · `/clear` · `/shuffle` | See and tidy the queue |
| `/lyrics [show_everyone]` | The words to what's playing (just for you unless you say otherwise) |
| `/nowplaying` | Move the now-playing card to this channel |
| `/help` | All of the above, in plain words |
| `/setup nowplaying [channel]` | 🔒 Server admins: keep a now-playing board in a channel; empty removes it |
| `/apex link · me · stats · map · predator · servers · leaderboard` | Apex Legends stats (when `APEX_API_KEY` is set; see below) |
| `/setup apex-leaderboard [channel]` · `/setup apex-shoutouts [channel]` | 🔒 Server admins: the squad leaderboard board, and where rank-up shout-outs go |
| `/servers list · approve · remove` | 👑 You, in a DM with the bot: manage which servers can use it |

**Who can control the music:** anyone in the bot's voice channel, and server admins (Manage Server) from anywhere. Anyone can start the music in an empty channel; if it's already playing somewhere else in that server, they have to join there.

The bot leaves the voice channel after `IDLE_MINUTES` (5) with nothing playing or nobody listening.

## Setup

### 1. Make a Discord application for it

Use a **new** application, separate from your media bot, so the two never fight over a voice channel.

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, name it (e.g. "Music"), give it an icon.
2. **Bot** → **Reset Token** → copy it for `DISCORD_TOKEN`. No privileged intents are needed (leave them all off).
3. Leave **Public Bot** on so your friends can add it themselves; approvals keep everyone else out. (Turn it off if you'd rather add it to their servers yourself; you'll need Manage Server there.)

### 2. Give the bot a login on Aurral

In Aurral, **Settings → Users**, add a local account for the bot (e.g. `discord`) and sign in with it once in a browser, so Aurral stores its Subsonic login. Aurral API keys don't work for Subsonic, so it needs a real password. The bot tries token login first and falls back to password login automatically.

### 3. Install on Unraid

Copy [`unraid/my-music-bot.xml`](unraid/my-music-bot.xml) to `/boot/config/plugins/dockerMan/templates-user/` on the flash drive, then **Docker → Add Container → Template → music-bot**.

- **Network Type**: the same custom Docker network as Aurral, so `SUBSONIC_URL=http://aurral:3001` works. On plain bridge, use `http://YOUR-UNRAID-IP:3001`.
- Fill in `DISCORD_TOKEN`, `SUBSONIC_URL`, `SUBSONIC_USER` and `SUBSONIC_PASSWORD`.
- `OWNER_ID` is optional: approvals go to whoever owns the Discord application unless you set it.

No ports need publishing. The image is `ghcr.io/nogref/music-bot:latest`, built by GitHub Actions on every push to `main`. Settings can also live in `/mnt/user/appdata/music-bot/bot.env` (same `NAME=value` lines as [.env.example](.env.example)); the container settings win when both are set.

Elsewhere: `docker run -d --name music-bot --env-file .env -v ./data:/data ghcr.io/nogref/music-bot:latest`.

A healthy start logs `logged in as …`, the **invite link**, `connected to the library at …` and how many servers it's in.

### 4. Add it to servers

Open the invite link from the log. It asks for: View Channels, Send Messages, Embed Links, Attach Files (for cover art), Read Message History, Connect and Speak.

- **Servers you own** are approved straight away (so are any in `ALLOWED_GUILD_IDS`).
- **Anyone else's server:** share the same link. When they add the bot, it says hello in their server ("my owner needs to approve this server first") and **DMs you** the server's name, member count and owner, with **✅ Approve** and **🚪 Leave** buttons. Their music commands appear the moment you approve. Leave makes the bot leave, and if they add it again it leaves straight away and lets you know (with an Approve button in case you change your mind).
- In a DM with the bot, `/servers list` shows every server, `/servers approve` approves one, and `/servers remove` makes the bot leave (add `block:True` to leave again automatically if they re-add it).

If your DMs are closed to the bot, the request waits; open them (Server → Privacy Settings → Direct Messages) and it asks again on the next restart, or use `/servers approve`.

## Apex Legends stats

Turn it on with a free key from [apexlegendsapi.com](https://apexlegendsapi.com) (Apex Legends Status) in `APEX_API_KEY`. Without one, the `/apex` commands don't appear.

- **`/apex link player platform`**: each person links their in-game name once (on PC, the EA account name, even if they play through Steam). The bot checks the name exists before saving it. Server admins can link someone else with `member:@friend` (and `/apex unlink member:@friend`); they can still unlink themselves.
- **`/apex me`**, **`/apex stats member:@friend`** (or `player:` for anyone): rank and RP (and how far from the Predator cutoff, for Masters), level and progress to the next one, battle pass level, whether they're in the lobby or a match (and since when), and the trackers on their current legend's banner, with the legend's banner art. Add `legend:` to see another legend's banner stats. The title links to their apexlegendsstatus.com profile.
- **`/apex map`**: the Pubs and Ranked maps right now, when they change, and what's next, with the map pictures.
- **`/apex predator`**: the RP it takes to be Apex Predator on each platform. **`/apex servers`**: whether EA login and matchmaking are up; `details:True` lists every region.
- **Squad leaderboard**: `/setup apex-leaderboard channel:#apex` posts a board that updates itself, with everyone who's linked and in this server, best rank first, and **RP gained since Monday 12 AM** (`TIMEZONE`, Central by default). `/apex leaderboard` shows it to anyone, anywhere.
- **Rank-up shout-outs**: when someone reaches a new high for the season (e.g. Platinum III → Platinum II), the bot celebrates in the leaderboard's channel. Dropping and re-climbing doesn't count twice, and the reset at a new ranked season is ignored. `/setup apex-shoutouts channel:#…` moves them; without a channel it turns them off.

The bot checks each linked player every `APEX_POLL_MINUTES` (15). Things to know about the data:

- There's no official Apex stats API. Kills, damage and wins only exist for **trackers equipped on legends' banners**; rank, RP and level are always there.
- RP this week starts counting from the first check, so it's partial for the week someone links.
- Match history isn't available on free keys, so the bot can't list games or per-match stats.

The bot's status line rotates between `/play · /help`, how many servers it's in, and how many are playing music.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `can't reach the library` in the log | Check `SUBSONIC_URL` from inside the container's network (container name on a shared network, or the Unraid IP) |
| `wrong Subsonic username or password` | Sign in to Aurral once as the bot's user, or reset its password in Aurral |
| Songs skip straight away, or "stopped after several songs failed to play" | The library couldn't send Opus. Aurral does this by default; for Navidrome, make sure its ffmpeg works |
| "I couldn't connect to the voice channel" | Give the bot **Connect** and **Speak** in that channel |
| Commands don't show up in a friend's server | You haven't approved it yet (`/servers list`), or it was added without the `applications.commands` scope: re-invite with the link from the log |
| No `/servers` in your DMs | Discord can take a few minutes to show new DM commands; restart the Discord app |
| Similar-song radio says it's playing random songs | The library found nothing similar for that pick |
| `/apex link` can't find someone | Use the exact in-game name and the right platform (PC players: the EA account name) |
| Apex commands say the stats service had a problem | Check `APEX_API_KEY`; apexlegendsstatus.com may also be busy, try again in a minute |

## Development

```sh
npm ci
npm test            # builds, then runs the tests (fake Discord, fake voice, fake Subsonic server)
cp .env.example .env && node --env-file=.env dist/index.js
```

Layout: `src/player/` is the player (queue, session, now-playing card, voice), `src/commands/` the slash commands and server approvals, `src/services/subsonic.ts` the library client. Change `.env.example` → run `node scripts/gen-unraid-template.mjs` → commit both (CI checks they match).
