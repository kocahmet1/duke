# Multiplayer (deathmatch)

Send a friend a link, they click it, you're both in the same match. Each
browser connects straight to the other ones (WebRTC). The server only
introduces them, so it adds no lag, and restarting it doesn't end a match.

## What's in this first version

- **Deathmatch on Mission 2 (The Crucible)**, up to **4 players** per room.
- Everyone shows up as the third-person figure from `nz-hero.js`, each in a
  different jacket colour. Works whether you play in first or third person (V).
- No enemies, pickups or lifts. Normal doors start open; secret doors and the
  key door stay shut. E does nothing, and you can't save.
- Everyone spawns with the same guns: pistol, shotgun, chaingun, rifle, AK, M4,
  DMR. No RPG, grenades or NULLSTAR yet.
- Headshots do 2.5x damage, arms and legs 0.75x. You respawn 3 seconds after
  dying, at the spawn point farthest from the others, and can't be hurt for
  1.25 s after that.
- The scoreboard (top left) shows frags and each player's ping, plus whether
  you're connected DIRECT or RELAYED.

## Try it on your own PC

1. Double-click `SERVE-MP.cmd` (or run `npm run mp` in this folder). It uses
   the `ws` package that's already in `node_modules`; if it's ever missing,
   run `npm install`. Close `SERVE.cmd`'s window first: both use port 4173.
2. The browser opens <http://127.0.0.1:4173/>. Click **MULTIPLAYER**.
3. Click **COPY** and open the link in a second browser window, then click
   **JOIN MATCH** in both.

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
   - plan **0.5 CPU / 512 MB**: $7 a month, never sleeps
   - build `npm install --omit=dev && npm run build`, start
     `node server/mp-server.mjs --dist`

   It asks for `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN`. Leave them empty
   for now (see the relay section below).

3. When the deploy is done, open the address Render gives you (something like
   `https://nuke-zone-mp.onrender.com`), click **MULTIPLAYER**, **COPY**, and
   send the link to your friend.

A bigger plan won't lower lag: the server isn't in the gameplay path. What
matters is the connection between you and your friend.

## If your friend can't connect: the relay

The lobby lists each player as **DIRECT**, **RELAYED** or **NO CONNECTION**.
NO CONNECTION means your two networks won't allow a direct link (this happens
on some mobile and ISP connections). The fix is Cloudflare's relay (TURN):

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

Rooms already hold 4 (`NZ_MAX_PLAYERS` in `render.yaml`, up to 8). Every
player connects to every other, which is fine up to about 6 to 8 players.

## How it works

- `server/mp-server.mjs` serves the game files (gzipped: the 20 MB buildings
  file goes out as 2.4 MB) and runs the `/signal` WebSocket that puts players
  in rooms and passes their connection details. It also turns away a browser
  holding an old copy of the page, with a "refresh" message.
- `nz-net.js` (loaded last by `NUKEM.html`) does the multiplayer itself. Each
  pair of players gets two channels:
  - **`s`**: unordered, never resent. A 48-byte state packet every frame,
    pings, gunfire. A lost packet is just skipped, since the next one is a
    frame behind it.
  - **`e`**: reliable and in order. Hits, deaths, names.
- Each browser moves its own player exactly as in single player, so your own
  movement has no network delay. Other players are drawn a couple of packets
  in the past and smoothed between real positions (about 25 to 60 ms
  behind).
- **The shooter's screen decides hits**, tested against the other player's
  figure as it is drawn there (its real skeleton). The victim's browser
  applies the damage. Deaths are announced by the victim, and every browser
  keeps the score from those announcements.
- `nz-hero.js` section 11 ("puppets") builds and animates the other players'
  figures with the same animator as yours. Your own figure isn't affected.
- Without `#mp=` in the address, `nz-net.js` only adds the MULTIPLAYER button.
  Single player is unchanged.

## Checking it

`npm run check:mp` starts the server and two headless browsers. It checks that
they connect directly, see each other in the right place, and that a shot
kills, scores and respawns. It also checks that the server turns away an old
copy of the page, a full room and the wrong mission. Run
`npm run check:mp -- --players 3` for three. It needs Chrome; point `CHROME=`
at it if it isn't found.

## Known limits

- Players walk through each other.
- Because the shooter decides, you'll occasionally get hit just after ducking
  behind cover (the other player still saw you).
- If a player switches to another tab, the browser stops drawing their game,
  so they freeze on everyone else's screen until they come back.
- The first time a player appears there's a short hitch while their figure is
  built.
- Other missions can be picked with `&level=1..4` in the link, but only
  Mission 2 has been tested.

## Files

New: `nz-net.js`, `server/mp-server.mjs`, `scripts/mp-smoke.mjs`,
`render.yaml`, `SERVE-MP.cmd`, `MULTIPLAYER.md`.
Changed: `NUKEM.html` (one script tag at the end), `nz-hero.js` (section 11
plus two lines), `build-static.mjs` (`nz-net.js` added to the module list),
`package.json` (`ws` dependency; `mp`, `start` and `check:mp` scripts),
`.gitignore` (screenshot and scratch folders).
The originals of the changed files are in `.backup-multiplayer/`.
