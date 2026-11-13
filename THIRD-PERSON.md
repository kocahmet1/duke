# Third-person view

An optional GTA-style view: the camera sits behind and over the right shoulder of a visible 3D player figure, modelled on three photos of a real kid. First person is unchanged and is still the default.

## Switching

| Where | How |
|---|---|
| In play | **V** flips first / third person |
| Title screen | the **VIEW** row under the skill picker |
| Pause screen | the **VIEW: ...** button |
| URL | add `&view=3` (or `&view=1`) to the hash, e.g. `NUKEM.html#level=4&view=3` |

The choice is remembered between sessions (localStorage key `nuke-zone-3d:view:v1`).

## How it plays

- Mouse look, movement, weapons, damage and spread are the game's own. The crosshair still marks where rounds land: each shot is re-aimed at the point under the crosshair, because a camera over the shoulder no longer looks down the barrel.
- Right mouse pulls the camera in tight over the shoulder. A scoped weapon (AR-15 scope, DMR) drops to the first-person glass while scoped and comes back out after.
- With no room behind the figure (back against a wall, a cupboard-sized room) the view drops to first person until there is room again. That is deliberate; the alternative is a camera inside the wall.
- The figure walks, runs, strafes, back-pedals, sprints with the weapon lowered, jumps, crouches (kneels when still), crawls, reloads on **R**, swaps weapons, throws grenades, and falls when killed. It holds the real weapon models from `nz-weapons.js`.
- Tracers leave from the figure's muzzle. Spent brass keeps the shooter's speed in this view, so it drops beside him instead of hanging in the air behind a running player.

## Showcase (U)

Press **U** in play and the camera swings round from behind him to his front, framing his whole body. While it's up:

- the **mouse wheel** zooms in to his face, and back out
- **moving the mouse** turns the camera round him
- the game is in **inspect mode** (the **Y** switch): enemies freeze and stop firing, and nothing hurts you. If inspect mode was already on from Y, it stays on afterwards.
- your own controls are held: he stands still with his gun lowered, and the crosshair is hidden. A click made meanwhile is dropped, not saved for later.

Press **U** again and the camera swings back behind him. When it lands (about half a second) your controls and the enemies come back.

It works from first person too: U shows him, and the second U goes back to first person. In a multiplayer match it's only a camera (inspect mode is off there), so other players can still shoot you while you can't move. Phones have no U key; a touch button can call `NZ.hero.showcase.toggle()`.

## The figure: modelled on the photos

`nz-hero-look.js` says who the figure is. Everything in it was measured from the photos:

| | From the photos |
|---|---|
| Face | The front portrait, straightened (head turn and tilt taken out) and projected onto the front of the head. The photo is turned a little, so his left cheek is filled in from his right. The sides and back of the head are painted to match. |
| Head shape | Fitted to his proportions: a shorter nose, mouth and chin below the eyes than an adult's, and a narrower jaw. Ears sit where his do. |
| Hair | Short crop: a thick, messy top, a ragged fringe, sides and back clipped short and faded into the skin. The colour is sampled from the photo. |
| Clothes | A loose crew-neck sweatshirt with ribbed neck, cuffs and hem, in the sweater's colour. Black tracksuit pants with an elastic waist and cuffed ankles. |
| Build | Thin: slimmer trunk, limbs and neck, narrower shoulders, a slightly bigger head for his size. |

Two things are guesses, because no photo shows them: his **height** (`build.height: 0.86`, about 1.57 m against the game's 1.83 m adult; he's sitting in every photo) and his **shoes** (white sneakers). Both are plain fields in `nz-hero-look.js`.

His height only changes the figure and the camera. The game's own eye height, hit box and first-person view are unchanged.

To go back to the stock figure, take `<script src="nz-hero-look.js"></script>` out of `NUKEM.html`. The other edits keep working without it.

### Deploying

He's on the live site too. `nz-hero-look.js` is committed to the game's public GitHub repo, and `npm run build` ships it whenever the file is present. That was the owner's call (2026-11-14): the photo is public in the repo and on the site, and everyone who opens the link plays as him. Other players in a multiplayer match still see the stock figure.

To take him off the site, delete the file from the repo and redeploy (the build then drops its script tag and the stock figure comes back), or set `NZ_SHIP_LOOK=0` on Render. `node build-static.mjs --without-look` builds without him locally.

### Multiplayer

The other players' figures always wear the stock figure in their match colour. The look file only dresses your own figure, on your own screen.

## What changed

| File | Change |
|---|---|
| `nz-hero.js` | **New.** View state and its UI, the boom camera, the aim correction, the figure (mesh, skeleton, painted texture atlas) and its animation, and the U showcase. For the showcase it wraps the game's `updatePlayer()` and `lookBy()` (to hold your controls and turn mouse-look into the orbit); both wrappers pass straight through while U is off. Section 11 (other players' figures) belongs to the multiplayer work. |
| `nz-hero-look.js` | **New.** His look: the face photo (embedded), head fit, hair, clothes, build. Data only. |
| `NUKEM.html` | Script tags for `nz-hero-look.js` and `nz-hero.js` after `nz-weapons.js`. `viewDir(org)` asks the `aimDir` hook. `drawOverlay` skips the 2D weapon sprite and keeps the crosshair lit in third person. |
| `nz-weapons.js` | `renderVM` returns early when `NZ.view.hideVM` (the first-person gun is not drawn; its recoil and reload state still run). `spawnTracer` asks the `tracerFrom` hook for the muzzle. |
| `build-static.mjs` | `nz-hero.js` in the module manifest. `nz-hero-look.js` ships when it's present; `--without-look` leaves it out (see Deploying). |

Backups: `.backup-third-person/` has the files from before the view existed, and `.backup-look/` has `NUKEM.html`, `build-static.mjs` and `nz-hero.js` from just before the look was added.

In first person every hook in `nz-hero.js` returns before doing anything. Removing its script tag removes the feature; the other edits are null-guarded and fall back to the old behaviour on their own.

## The look fields

`window.NZ_HERO_LOOK` (set by `nz-hero-look.js`, before `nz-hero.js` loads) overrides the `LOOK` block at the top of `nz-hero.js`, where every field is documented. The main ones:

- `skin`, `brow`, `eye`, `beard` (0..1)
- `hair {color, style: short|buzz|crop|medium|long|bald, ...}`. `crop` also takes `top`, `sides`, `back`, `fringe`, `jag`, `messy`.
- `build {bulk, shoulders, head, neck, height}`
- `head {y, w, f, nose, chin, earY, earOut, ...}`: fits the head to a face.
- `top {type: jacket|hoodie|sweater|tshirt|shirt, color, trim, loose}`
- `bottom {type: jeans|trousers|track|shorts, color, stripe}`
- `shoes {type, color, sole, accent}`
- `face {image, ...}`: a frontal portrait as a data URL, pre-warped to the head's feature positions (listed in `nz-hero.js`). A plain file path can't be read by the page when the game is opened from disk.

Trying a change from the browser console:

```js
NZ.hero.restyle({ top: { color: '#2f5fae' }, build: { height: 0.9 } })
NZ.hero.orbit(Math.PI, 0.05, 0.7, 1.68, 30)   // close-up of the face
NZ.hero.orbit(null)                             // give the camera back
```

Other handles: `NZ.hero.setThird(true|false)`, `NZ.hero.stats()`, `NZ.hero.tune.cam` (boom distances, live-editable).

## Checked

Headless Chromium with software rendering, the only renderer available where this was built:

- Missions 1 to 4 in third person at `nzq=low`, missions 1 and 4 at `nzq=high` (TAA, G-buffer, GTAO, SSR, contact shadows): no console errors, module never tripped its error latch.
- Shots land on the crosshair to within 0.1 degree with the aim correction (1.5 to 6.9 degrees off without it).
- First person: frames drawn with the look and without it are pixel-identical to the previous build on missions 1 and 4, and the camera is bit-identical on every frame of a scripted run.
- Without `nz-hero-look.js` the figure is byte-for-byte the stock figure it was before (mesh, skin weights and texture).
- The multiplayer test (`npm run check:mp`, 2 players) passes, and the other players' figures wear the stock figure, not the look.
- Showcase: U swings to the front with inspect mode on and the crosshair hidden; held W and trigger don't move or fire; the wheel zooms to the face; the mouse orbits without turning him; the second U returns everything (controls back, inspect mode off, or left on if Y had set it). Same from first person.
- `npm run build` with the look file, without it, and with `--without-look`. `npm test` passes.

Not checked: frame rate and feel on a real GPU with a real mouse.

## Known limits

- The face is a photo on a code-built head (about 12,000 triangles, one 1024 texture), not a 3D scan. From the front it reads as him. From the side and back it's the hair, colours and proportions doing the work.
- The hair is a shaped shell with a painted texture, not strands. It reads as a messy short crop, not as his exact hair.
- The levels were built for first person. Indoors, in narrow corridors, the view will fall back to first person often.
- The camera collides with the level grid and with free-standing dressing (signs, posts, awnings). Glass does not stop it, and very thin props can still cut the frame.
- Third person lets you see round corners. Enemy behaviour and difficulty are unchanged, so it plays a little easier.
