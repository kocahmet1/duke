# Multiplayer

Send a friend a link, they click it, you're both in the same match. Each
browser connects straight to the other ones (WebRTC). The server only
introduces them, so it adds no lag, and restarting it doesn't end a match.

## Two maps

Clicking **ÇOK OYUNCULU** (multiplayer) asks which one:

- **ER MEYDANI**: Mission 2 (The Crucible), the whole map.
- **ABLUKA**: a fenced-off part of Mission 4 around the roundabout where
  232. Sokak meets 233. Sokak, with GÜVEN ECZANESİ on the corner:
  - 232 Sk north to the mission's own police line, and south to a bariyer
    past the spot where the armoured car waits in single player;
  - 233 Sk east past the parked car and the 230 Sk crossing to the
    mission's police line, and west up the slope (it climbs 5 m) to a
    bariyer in front of the hilltop checkpoint;
  - the ground floors of A-BLOK and B-BLOK (the rooms and the corridor
    behind them, with doors onto both streets) and the SEYDIKENT C-BLOK
    hall at the top of the slope.

  It's about 160 × 100 m end to end, three times the floor of the first
  version, with 40 spawn points. The open stretches of street have the
  mission's plywood crates as cover, in pairs (34 crates). Like every crate
  they break, the same way on every screen, and stay broken until the room
  closes. Where the mission has no closure of its own, the edge is the same
  red-and-white police bariyer the mission uses. Nobody can walk past it,
  players or bots, but bullets fly over it.

The lobby shows the map. While you're alone in the room and not yet
playing, **DEĞİŞTİR** (change) switches it. Like the mode switch, that
reloads into the same room, so a link you already sent still brings your
friend to you.

## Two modes

The lobby's **MOD** row picks one. A room has one mode, set by whoever opens
it first; the invite link carries it.

### Team match (TAKIM 2v2 + BOT), the default

- **Two against two.** Bots take every seat nobody has taken, so a match can
  always start:
  - alone: you and a bot against two bots
  - with a friend on your side: the two of you against two bots
  - with a friend on the other side: each of you with a bot
- **Pick a side** in the lobby (**TAKIMIN**: FARK ETMEZ / KIRMIZI / MAVİ), or
  during the match from the pause menu (ESC); a change counts from the next
  round. Players who don't pick are split between the two sides.
- **Rounds, no respawning.** A side that's all down loses the round. After 2
  minutes the side with more players standing wins it, then the one with
  more health between them. First to **5 rounds** takes the match, and a new
  match starts a few seconds later.
- **When you're down** you watch a team-mate over his shoulder until the
  round ends.
- **Friendly fire is off**: your rounds go straight through your team-mates.
- Red and blue jackets show the sides. Your team-mates have their names
  over their heads. The scoreboard (top left) lists both sides with the
  score, the round and the clock.
- **Bot difficulty** (**BOTLAR**: KOLAY / ORTA / ZOR, also in the pause
  menu). Whoever runs the match sets it (see "How it works"); the others see
  it but can't change it. Bots carry the AK. They walk the level's
  navigation grid, react after a moment, and aim with a wobble that
  tightens the longer they keep you in view. The levels only change those
  numbers.

### Deathmatch (HERKES TEK)

The original free-for-all, no bots: you respawn 3 seconds after dying, at
the spawn point farthest from the others, and can't be hurt for 1.25 s
after that. Its links end in `&mode=dm`.

## Both modes

- **Either map** (above), up to **4 players** per room.
- Everyone shows up as the third-person figure from `nz-hero.js`. Works
  whether you play in first or third person (V).
- No enemies, pickups or lifts. Normal doors start open; secret doors and
  the key door stay shut. E does nothing, and you can't save.
- Everyone spawns with the same guns: pistol, shotgun, chaingun, rifle, AK,
  M4, DMR. No RPG, grenades or NULLSTAR yet.
- Headshots do 2.5x damage, arms and legs 0.75x.
- **Breakable things break the same for everyone.** Every bullet that hits a
  wall, a player's or a bot's, is replayed on the other screens through the
  same destruction code that handled it on the shooter's screen. A cracked
  window, a broken car window or a smashed crate (which also opens the way
  through) therefore looks the same everywhere. Someone who joins
  mid-match is sent what's already broken.
- **Frame rate first.** If frames run slow (under ~36 fps) once the renderer
  has dropped what effects it can, the game lowers the resolution:
  1. the pixel ratio to 1 on a high-DPI laptop screen;
  2. the 3D scene's resolution, in two steps.
  The HUD stays sharp. A step that doesn't help is undone, and resolution
  comes back when there's headroom. On an Intel HD 620 laptop at 150%
  scaling, ABLUKA ran at 15–19 fps before; the first step alone measured
  about 25 fps on the same views. `?nzgov=0` in the address turns this off.

## Try it on your own PC

1. Double-click `SERVE-MP.cmd` (or run `npm run mp` in this folder). It uses
   the `ws` package that's already in `node_modules`; if it's ever missing,
   run `npm install`. Close `SERVE.cmd`'s window first: both use port 4173.
2. The browser opens <http://127.0.0.1:4173/>. Click **ÇOK OYUNCULU** and
   pick a map.
3. Click **MAÇA KATIL** to play against the bots. For a second player, click
   **KOPYALA** and open the link in another browser window.

`127.0.0.1` only works on this PC. To play with a friend, put it online.

## Put it online (Render)

Render deploys from a Git repository (GitHub, GitLab or Bitbucket).

1. **Push this folder to a new GitHub repo.** The screenshot and scratch
   folders (about 650 MB: `_shots/`, `_critic_shots/`, `_tmp/`, `_to_delete/`,
   `.backup-*/`) are already in `.gitignore`, so they stay out of it.

   One heads-up: there's a leftover `.git/index.lock` from August in this
   folder. Git won't commit here until you delete that file.

2. **In Render: New → Blueprint**, pick the repo. Render reads `render.yaml`
   and creates one web service, `nuke-zone-mp`:
   - region **Frankfurt** (closest to Turkey; a region can't be changed later)
   - plan **free**: sleeps after 15 minutes with no visitors and takes about a
     minute to wake on the next page load; matches themselves are unaffected.
     For instant loading, switch the service to **0.5c-512mb** ($7 a month,
     never sleeps) in Render → the service → Settings → Instance Type.
   - build `npm install --omit=dev && npm run build`, start
     `node server/mp-server.mjs --dist`

   It asks for `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN`. Leave them empty
   for now (see the relay section below).

3. When the deploy is done, open the address Render gives you (something like
   `https://nuke-zone-mp.onrender.com`), click **ÇOK OYUNCULU**, pick a map,
   click **KOPYALA** and send the link to your friend.

The page and the server go together: a browser holding a page from before an
update is told to refresh instead of joining.

A bigger plan won't lower lag: the server isn't in the gameplay path. What
matters is the connection between you and your friend. On the free plan the
server can fall asleep in the middle of a match; that's fine, because the
players are already connected to each other. Only a new arrival has to wait
the minute it takes to wake.

## If your friend can't connect: the relay

The lobby lists each player as **DOĞRUDAN** (direct), **AKTARMALI**
(relayed) or **BAĞLANTI YOK** (no connection). No connection means your two
networks won't allow a direct link (this happens on some mobile and ISP
connections). The fix is Cloudflare's relay (TURN):

1. Cloudflare dashboard → **Realtime** → under **TURN Server**, **Create**.
   Copy the **Turn Token ID** and the **API Token**.
2. Render → your service → **Environment**: set `CF_TURN_KEY_ID` to the token
   ID and `CF_TURN_KEY_API_TOKEN` to the API token, then save (Render
   redeploys).

The relay connects each player to the nearest Cloudflare location. The first
1,000 GB a month are free, and a match uses well under 100 MB an hour. Direct
connections are still used whenever they work; the relay only catches the
ones that fail.

## More players

Rooms hold 4 (`NZ_MAX_PLAYERS` in `render.yaml`, up to 8). The team match is
2v2 (`TEAM_SIZE` in `nz-net.js`); with more people in a room than seats, the
extra ones watch. Every player connects to every other, which is fine up to
about 6 to 8 players. More figures on screen cost frame rate, which is why
the team match is 2v2.

## How it works

- `server/mp-server.mjs` serves the game files (gzipped: the 20 MB buildings
  file goes out as 2.4 MB) and runs the `/signal` WebSocket that puts players
  in rooms and passes their connection details. It also remembers each
  room's mode and turns away a browser holding an old copy of the page, with
  a "refresh" message.
- `nz-net.js` (loaded last by `NUKEM.html`) does the multiplayer itself. Each
  pair of players gets two channels:
  - **`s`**: unordered, never resent. A 48-byte state packet every frame (one
    per bot as well) and pings. A lost packet is just skipped, since the next
    one is a frame behind it.
  - **`e`**: reliable and in order. Gunfire, hits, deaths, names, sides, the
    round, and the "what's broken" snapshot for a new arrival. Gunfire is
    here because each shot's wall impacts are replayed on the other screens.
    A lost shot would mean a window broken on one screen and whole on
    another.
- Each browser moves its own player exactly as in single player, so your own
  movement has no network delay. Other players and bots are drawn a couple
  of packets in the past and smoothed between real positions (about 25 to
  60 ms behind).
- **The shooter's screen decides hits**, tested against the other figure as
  it is drawn there (its real skeleton). The victim's browser applies the
  damage. Deaths are announced by the victim, and every browser keeps the
  score from those announcements.
- **One browser runs a team match**: of the players in the match, the one
  who came into the room first (usually whoever sent the link). It deals the
  sides, starts and ends the rounds, runs the bots and sends each bot out
  like a player. A round that hits a bot is sent to that browser; a bot's
  round that hits you comes from it. If that player leaves, the next browser
  takes over at once and the round is dealt again.
- `nz-bots.js` is the bots' brain: it moves them with the same collision as
  the player and walks them along the navigation grid the single-player
  enemies use. It does nothing outside a team match.
- `nz-hero.js` section 11 ("puppets") builds and animates the other players'
  figures, and the bots', with the same animator as yours. Your own figure
  isn't affected.
- **ABLUKA's fence:** `nz-net.js` lists the arena as rectangles of map
  cells (`MAPS`).
  - A step out of it is refused in `canStand()`, the same check that stops
    you at walls, so it holds for bots too.
  - The bots' paths keep to it (`NZ.bots.setAllow`).
  - The bariyer runs are built by `nz-street-side.js` through its
    `streetSideCordon` hook while it builds the street. They're lit and
    merged like the mission's own police lines, so no extra draw calls.
  - Only doors inside the arena open, and only spawn points inside it are
    used.
  - A long line stands as sections of about 22 u, each with its own
    chevron board, the way the mission's own police lines are pieced.
  - The cover crates are listed in `MAPS[].cover`. They're added to the
    level's crate list before the level builds its crates, so the merged
    crate pile (`nz-env.js`), breaking (`nz-destruct.js`), the damage
    snapshot and the bots' walls all treat them as stock crates. On the
    slope the street is drawn on a smooth grade up to half a unit under the
    stepped floor you walk on, so `NZ.crateBase` (read by `nz-env.js`) sets
    those crates down on the grade instead of in the air.
- The resolution step-down uses `NZ.render.setScale()` (in `nz-render.js`)
  for the 3D scene and the page's pixel ratio for the rest.
- Without `#mp=` in the address, `nz-net.js` only adds the ÇOK OYUNCULU
  button (and its map choice). Single player is unchanged.

## Checking it

Both need Chrome; point `CHROME=` at it if it isn't found.

- `npm run check:team` checks the team match. Alone: the lobby, a 2v2 round
  with three bots, the bots setting off, a player killing a bot, friendly
  fire doing nothing, a bot killing the player who then watches his
  team-mate, rounds and a whole match. Two players on the same side: the
  bots drawn on the second page where the first page has them, the bot
  difficulty, the second player killing a bot and a bot shooting him, and
  the second page taking the bots over when the first one leaves.
- `npm run check:mp` checks the deathmatch. It starts the server and two
  headless browsers, and checks that they connect directly, see each other
  in the right place, and that a shot kills, scores and respawns. It also
  checks that the server turns away an old copy of the page, a full room
  and the wrong mission. Run `npm run check:mp -- --players 3` for three.
- Add `-- --level 4` to either check to play ABLUKA. The team check then
  also watches the bots for 8 s: every seat dealt and every step they take
  has to be inside the fence. The deathmatch check also checks that every
  spawn point is inside the fence, that a window and a crate shot on one
  screen break the same way on the other, and that a player who joins
  afterwards gets the same damage.

## Known limits

- Players and bots walk through each other.
- Because the shooter decides, you'll occasionally get hit just after ducking
  behind cover (the other player still saw you).
- If a player switches to another tab, the browser stops drawing their game,
  so they freeze on everyone else's screen until they come back. If that
  player is running a team match, the bots freeze too. The rounds and the
  clock keep going.
- Someone joining in the middle of a round, or the player running the match
  leaving, starts that round again.
- Bots don't take cover or throw anything. They know roughly where you are
  (a fix a few seconds old), so hiding only works for a while.
- The first time a player or bot appears there's a short hitch while its
  figure is built.
- The frame rate with three other figures on screen hasn't been measured on
  a real graphics card yet.
- Missions 1 and 3 can still be played with `&level=1` / `&level=3` in the
  link, but they aren't offered and haven't been tested.
- ABLUKA loads Mission 4's street buildings (about 25 MB, 2–3 MB over the
  wire), so its first load is slower than ER MEYDANI's, especially on a
  phone.
- On ABLUKA you can walk through GÜVEN ECZANESİ's shop windows. The
  mission's map has no wall there; it's the same in single player.
- The trees on 233 Sk's median, up the slope, are scenery: you walk through
  them and they don't stop bullets (same in single player). The crates,
  the planters and the parked car are the cover.
- A crate shot apart stays gone for the rest of the room's life; new rounds
  don't rebuild it.

## Files

New: `nz-net.js`, `nz-bots.js`, `server/mp-server.mjs`,
`scripts/mp-smoke.mjs`, `scripts/team-smoke.mjs`, `render.yaml`,
`SERVE-MP.cmd`, `MULTIPLAYER.md`.
Changed: `NUKEM.html` (two script tags at the end), `nz-hero.js` (section 11
plus two lines), `build-static.mjs` (`nz-bots.js` and `nz-net.js` added to
the module list), `package.json` (`ws` dependency; `mp`, `start`,
`check:mp` and `check:team` scripts), `.gitignore` (screenshot and scratch
folders).
Originals: `.backup-multiplayer/` (before multiplayer) and `.backup-bots/`
(before the team match).

ABLUKA, synced destruction and the frame-rate step-down changed:
- `nz-net.js`: maps, arena and fence, impact replay, damage snapshot, frame
  governor.
- `nz-bots.js`: `setAllow`.
- `nz-street-side.js`: the `streetSideCordon` hook.
- `nz-render.js`: `setScale()`, plus `scale` and `pinned` in `stats`.
- `NUKEM.html` and `public/game/NUKEM.html`: the Mission 4 car's post is
  only set when the car was really made.
- `scripts/mp-smoke.mjs` and `scripts/team-smoke.mjs`: `--level 4`.
- `scripts/tr/ceviri.txt`: four entries that had drifted from the lobby
  code.
- `MULTIPLAYER.md`.

Their originals are in `.backup-cordon-mp/`.

The bigger ABLUKA (every street pushed back, the block ground floors, the
cover crates) changed:
- `nz-net.js`: the arena's rectangles, `cover` and the crates it adds,
  long fence lines in sections, `NET.map().cover`, the lobby note.
- `nz-env.js`: `NZ.crateBase`, an opt-in base height for a crate (single
  player never sets it).
- `scripts/team-smoke.mjs`: the test's shooting spot no longer gives up when
  the target's team-mate stands beside it.
- `MULTIPLAYER.md`.

Their originals are in `.backup-abluka-v2/`.
