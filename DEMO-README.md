# Demo flow + recorder

`demo.js` sits next to `NUKEM.html` and does nothing until you ask for it. The
game still plays exactly as before.

## Recording a clip

1. Open `NUKEM.html`.
2. On the title screen click **RECORD A 30s DEMO CLIP** (reloads with `?demo=1`).
3. Click **RECORD DEMO**.
4. Sit back. The game plays itself for 30 seconds, then a preview panel appears
   and the file lands in your Downloads folder.

Or go straight there: `NUKEM.html?demo=1`

## The flow it plays

| beat | what happens |
|---|---|
| 0:00 | spawn on the street, brief look up the road |
| 0:01 | trooper #1 — pistol, then **I GOT THE SHOTGUN** off the tarmac |
| 0:04 | trooper #2 further up the street |
| 0:06 | presses **E** on a suspicious wall → *A SECRET PLACE!* → armour + shells |
| 0:10 | west into the alley, trooper #3 |
| 0:13 | theatre lobby, pig cop #4 |
| 0:17 | back east, kicks open the hotel lobby door |
| 0:20 | lobby brawl — pig, trooper, octabrain, pig |
| 0:26 | corridor door, long corridor push |
| 0:28.5 | automap flourish over the last 1.5s, then stop |

Roughly 8–10 kills, 1 secret, 5 rooms, two doors, one weapon upgrade. Timings
are approximate — enemies move, so the fights breathe a bit.

## What it captures

- 1280×720, 60fps, ~12 Mbps
- world + weapon model composited with a HUD painted to match the in-game one
  (health, ammo, weapon, T/K/S, crosshair, messages, damage flash)
- game audio, recorded off the WebAudio master bus

**Format note:** Chrome records straight to MP4, which is what Twitter/X wants.
If your browser falls back to WebM the preview panel will say so — run it
through any converter before uploading.

## Knobs

Append to the URL, e.g. `NUKEM.html?demo=1&len=45&speed=2.4`

| param | default | meaning |
|---|---|---|
| `len` | `30` | clip length, real seconds |
| `speed` | `1.8` | game-time multiplier. Capped at 3.0 — above that the engine's 50 ms dt clamp kicks in and it stops getting faster |
| `w` / `h` | `1280` / `720` | capture size |
| `fps` | `60` | capture frame rate |
| `mbps` | `12` | video bitrate |
| `hud` | on | `hud=0` for raw gameplay, no overlay |
| `audio` | on | `audio=0` for a silent clip |
| `map` | on | `map=0` drops the automap outro |
| `secret` | on | `secret=0` skips the pushwall beat |
| `save` | on | `save=0` shows the preview without auto-downloading |

The route runs longer than 30s on purpose, so a longer `len` just gets you more
of the level rather than dead air. If the script does run out, the bot switches
to hunting whatever is still alive nearby.

## How it works

- **Fast mode** scales the timestamp handed to the game's `requestAnimationFrame`
  callback. The engine's own `dt` does the rest, so physics, animation and audio
  timing all stay coherent.
- **The bot** drives the real input path — it writes `keysDown`, `mouseDown`,
  `yaw` and `pitch`, nothing else. So the footage has the same head bob, recoil,
  weapon switching and hit detection a human gets. It aims with a little sway and
  leaves ~28% of the recoil uncompensated so the kick reads on camera.
- **Capture** pins the renderer to exactly 1280×720 (letterboxed on screen) so the
  video is a 1:1 copy of the framebuffer rather than a rescale, then composites
  `#view` + `#overlay` + HUD into a canvas and pipes `captureStream` into
  `MediaRecorder`.
- Incoming damage is scaled to 34% during the demo so a stray plasma ball can't
  end the clip early.

`window.NUKEDEMO` exposes `{ start, stop, cfg, D, tick, route }` from the console
if you want to poke at it.
