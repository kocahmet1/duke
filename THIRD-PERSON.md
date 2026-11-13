# Third-person view

An optional GTA-style view: the camera sits behind and over the right shoulder of a visible 3D player figure. First person is unchanged and is still the default.

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

## What changed

| File | Change |
|---|---|
| `nz-hero.js` | **New.** View state and its UI, the boom camera, the aim correction, the figure (mesh, skeleton, painted texture atlas) and its animation. |
| `NUKEM.html` | One `<script src="nz-hero.js">` tag after `nz-weapons.js`. `viewDir(org)` asks the `aimDir` hook. `drawOverlay` skips the 2D weapon sprite and keeps the crosshair lit in third person. |
| `nz-weapons.js` | `renderVM` returns early when `NZ.view.hideVM` (the first-person gun is not drawn; its recoil and reload state still run). `spawnTracer` asks the `tracerFrom` hook for the muzzle. |
| `build-static.mjs` | `nz-hero.js` added to the module manifest, so `npm run build` ships it and its script-tag check passes. |

Not touched: `public/game/NUKEM.html` (the old duplicate), every other module, git.

The three files as they were before this change are in `.backup-third-person/`.

In first person every hook in `nz-hero.js` returns before doing anything. Removing the script tag removes the feature; the other edits are null-guarded and fall back to the old behaviour on their own.

## The figure's look is data

Who the figure is lives in one object, `LOOK`, at the top of `nz-hero.js`. Anything in it can be overridden by a script loaded **before** `nz-hero.js`:

```html
<script src="nz-hero-look.js"></script>   <!-- window.NZ_HERO_LOOK = { ... } -->
<script src="nz-hero.js"></script>
```

Fields: `skin`, `hair {color, style: short|buzz|medium|long|bald, line}`, `beard` (0..1), `brow`, `eye`, `build {bulk, shoulders, head}`, `top {type: jacket|hoodie|tshirt|shirt, color, trim, under, sleeves, hood, zip}`, `bottom {type: jeans|trousers|shorts, color, stitch, length}`, `belt`, `shoes {type, color, sole, accent}`, `gloves`, `face`.

`face` takes a photograph: `{ image: 'data:image/jpeg;base64,...' }`, a frontal portrait already warped so its features sit where this head's are. The exact positions are listed in the `LOOK` comment in `nz-hero.js`. It is projected onto the front of the head and feathered into the painted skin round the sides. Use a data URL: a plain file path cannot be read by the page when the game is opened from disk.

This is how the figure gets modelled on photographs: the photos are measured (face landmarks, skin / hair / clothing colours, proportions) and turned into an `nz-hero-look.js`. No changes to `nz-hero.js` are needed for that.

Trying a look from the browser console:

```js
NZ.hero.restyle({ top: { type: 'hoodie', color: '#7a1f1f' }, hair: { style: 'buzz' } })
NZ.hero.orbit(Math.PI, 0.1, 2.2)    // look at the figure from the front
NZ.hero.orbit(null)                 // give the camera back
```

Other console handles: `NZ.hero.setThird(true|false)`, `NZ.hero.stats()`, `NZ.hero.tune.cam` (boom distances, live-editable).

## Checked

Headless Chromium with software rendering, the only renderer available where this was built:

- Missions 1 to 4 in third person at `nzq=low`, missions 1 and 4 at `nzq=high` (TAA, G-buffer, GTAO, SSR, contact shadows): no console errors, module never tripped its error latch.
- Shots land on the crosshair to within 0.1 degree with the aim correction (1.9 to 8.4 degrees off without it).
- First person: frames drawn by this build and by the previous one are pixel-identical on missions 1 and 4, the camera is bit-identical on every frame of a scripted run, and `viewDir(org)` equals `viewDir()`.
- `npm test` passes.

Not checked: frame rate and feel on a real GPU with a real mouse.

## Known limits

- The figure is built in code (about 11,000 triangles, one skinned mesh, one 1024 texture). It is a clean stylised human, not a scan. Photographs will drive the face texture, colours, hair and build; they will not turn it into a photoreal likeness.
- The levels were built for first person. Indoors, in narrow corridors, the view will fall back to first person often.
- The camera collides with the level grid and with free-standing dressing (signs, posts, awnings). Glass does not stop it, and very thin props can still cut the frame.
- Third person lets you see round corners. Enemy behaviour and difficulty are unchanged, so it plays a little easier.
