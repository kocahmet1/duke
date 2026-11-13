# STREET MODULE CONTRACT — the three new modules and the seams between them

The orchestrator owns `NUKEM.html`. The carve is **done and validating**
(`Level OK: 1790 traversable nodes, 20 doors, 4 lifts, 127 spawns`).
Three new modules are loaded from `NUKEM.html` in this order, after `nz-env.js`:

```html
<script src="nz-street-sky.js"></script>     <!-- SKY   agent -->
<script src="nz-street.js"></script>         <!-- FACADE agent -->
<script src="nz-street-props.js"></script>   <!-- PROPS agent -->
```

**One agent owns one file. Do not edit a file you were not assigned.
Do not edit `NUKEM.html`, `nz-core.js`, `nz-render.js`, `nz-env.js`, or another
street module — request changes from the orchestrator.**

---

## 1. Geometry of the carve — the numbers, in world units

`CELL = 4`, `M = 3.5` world units per metre, so **1 cell = 1.143 m**.
Cell `(cx, cy)` spans world `x ∈ [cx*4, cx*4+4]`, `z ∈ [cy*4, cy*4+4]`.
World **+Y is up**, **+X is east**, **+Z is south**.

### The street canyon

| thing | cells | world | metres |
|---|---|---|---|
| street body (road + both pavements) | x 42..62, y 39..46 | x ∈ [168, 252], z ∈ [156, 188] | 24.00 × 9.14 |
| north pavement | y 39..40 | z ∈ [156, 164] | 2.29 deep |
| roadway | y 41..44 | z ∈ [164, 180] | 4.57 wide |
| south pavement | y 45..46 | z ∈ [180, 188] | 2.29 deep |
| alley mouth (covered passage) | x 44..46, y 38 | x ∈ [176, 188], z ∈ [152, 156] | 3.43 wide |
| foyer (interior, behind the north facade) | x 59..62, y 31..37 | x ∈ [236, 252], z ∈ [124, 152] | 4.57 × 8.00 |
| foyer door | cell (60, 38) | x ∈ [240, 244], z ∈ [152, 156] | 1.14 wide |

### The four facade planes — where buildings meet the street

| plane | world | notes |
|---|---|---|
| **north facade** | `z = 156` | the long block the street leads to. Broken by the alley mouth at `x ∈ [176,188]` and by the foyer door at `x ∈ [240,244]`. |
| **south facade** | `z = 188` | the facing block, unbroken for the whole 84 units. |
| **west end** | `x = 168` | the blind gable of the corner block; the alley mouth is immediately north of it. |
| **east end** | `x = 252` | the **dead end** — the street terminates here, against the block whose entrance is the destination. |

### Heights

| | world Y | metres |
|---|---|---|
| roadway floor | `0` | 0 |
| pavement floor (kerb top) | `0.5` | 0.143 (a 143 mm kerb) |
| region ceiling `c` | `52` | 14.86 — the eaves line |
| ground-floor slab-to-slab | `0 → 11.2` | 3.20 |
| floors 1–4, each | `10.15` | 2.90 |
| eaves | `51.8` | 14.80 |
| roof ridge (built freely above `c` — `sky: true`, there is no ceiling quad) | `≈ 64` | ≈ 18.3 |

**Above `c = 52` is open sky.** Roofs, chimneys, water tanks, aerials, overhead
wires and the whole distant backdrop are built above and beyond the grid and are
never occluded by a ceiling.

### Region indices and material fallbacks

| region | `f` | `c` | `ftex` | `wtex` | `sky` | `amb` |
|---|---|---|---|---|---|---|
| `rResRoad` | 0 | 52 | `street` | `concrete` | yes | `[.52,.56,.62]` |
| `rResWalk` | 0.5 | 52 | `concrete` | `concrete` | yes | `[.53,.57,.63]` |
| `rResFoyer` | 0 | 12 | `tilefloor` | `stone` | no | `[.20,.19,.18]` |

The world meshes carry **no `name` and no `userData`** — the only handle is
`material.name === 'world:<tex>'`. Identify the street's own quads by testing
world-space vertex positions against the AABB above.

### Occupied cells — `S_BLOCK`, no crate mesh

`NUKEM.html` marks these `S_BLOCK` but deliberately keeps them **out of
`CRATES[]`**, so the cell is solid and nothing is drawn on it. They exist purely
so `nz-street-props.js` can stand a real obstacle there.

```
north kerb parking  y=41 : x 43,44,45,46 | 49,50,51,52 | 56,57,58,59
south kerb parking  y=44 : x 45,46,47,48 | 53,54,55,56 | 59,60,61
tree pits (N, outer) y=39: x 49, 53, 57
tree pits (S, outer) y=46: x 47, 54, 60
```

Each parking run of four cells is 16 units = **4.57 m** — one car plus a hand's
breadth. **Do not hardcode this list**: scan the grid for `S_BLOCK` inside the
street AABB and group contiguous runs, so the props stay correct if the
orchestrator moves a bay.

Rows `y = 42, 43` are never blocked. The roadway is open end to end and the
player is funnelled down the crown of the road — which is exactly where the
reference photographs were taken from. Frame the street for that eyeline.

---

## 2. The shared namespace `NZ.street`

`nz-street-sky.js` creates it. The other two read it and must degrade
gracefully — with a `NZ.log` warning, never a throw — if it is missing.

```js
NZ.street = {
  ok:      true,                 // sky installed cleanly
  tier:    'high' | 'med' | 'low',

  /* world-space AABBs, exactly as tabulated above */
  BOX:     { x0: 168, x1: 252, z0: 156, z1: 188, y0: 0, y1: 52 },
  MOUTH:   { x0: 176, x1: 188, z0: 152, z1: 156 },
  FOYER:   { x0: 236, x1: 252, z0: 124, z1: 152 },
  DOOR:    { x0: 240, x1: 244, z: 156 },
  PLANE:   { north: 156, south: 188, west: 168, east: 252 },
  KERB:    { northTop: 164, southTop: 180, height: 0.5 },
  STOREY:  { ground: 11.2, floor: 10.15, eaves: 51.8, count: 5 },

  /* the daylight environment. Assign per material — never touch
     scene.environment, which the night half of the level depends on. */
  probe:   THREE.Texture,        // PMREM cube-UV render target texture
  probeIntensity: Number,

  /* the one call every daylit material must make. Sets envMap, envMapIntensity,
     the name prefix nz-render's neutraliseBakedLighting keys off, and any
     onBeforeCompile the sky needs. Returns the material. */
  day:     function (material, opts) { ... },

  /* achromatic overcast vertex bake for a BufferGeometry the module built
     itself: sky-dome occlusion from above plus a soft ground bounce. Writes a
     'color' attribute. This is what replaces nz-env's litAt() point-light bake
     inside the daylight zone. */
  bake:    function (geometry, opts) { ... },

  /* sky colours, so props and facades can tint reflections and glass to match */
  SKY:     { zenith: [r,g,b], horizon: [r,g,b], ground: [r,g,b], lum: Number },

  /* filled by nz-street.js once its facades exist; read by nz-street-props.js */
  facades: [ { side:'N'|'S'|'E'|'W', a:Number, b:Number, plane:Number,
               body:0xRRGGBB, plinth:'travertine'|'brick'|'render',
               storeys:Number, name:String, bay:Number /* projection depth */,
               entrance: null | { x:Number, z:Number, steps:Number, width:Number } } ]
};
```

### Hook priorities — ordering is deterministic and load-bearing

| module | hook | priority |
|---|---|---|
| `nz-street-sky.js` | `ready` | **-60** (first; creates `NZ.street`) |
| `nz-street.js` | `ready` | **-50** (facades; fills `NZ.street.facades`) |
| `nz-street-props.js` | `ready` | **-40** (dressing; reads `facades`) |

`nz-env.js` uses `ready` at `-30`, so all three land before it and its passes
see the finished geometry.

### Flags and opt-outs

```js
NZ.flags.streetSky   // nz-street-sky.js
NZ.flags.street      // nz-street.js
NZ.flags.streetProps // nz-street-props.js
```

Query strings, matching `nz-env.js`'s convention:
`?nzsky=0|low|med|high`, `?nzstreet=0|low|med|high`, `?nzprops=0|low|med|high`.

---

## 3. Non-negotiables

1. **three.js r149 UMD core only.** No `examples/js`, no `EffectComposer`,
   no `BufferGeometryUtils`, no loaders, no `CapsuleGeometry`. `nz-env.js` has a
   hand-written geometry merge (`Pile`, `nz-env.js:1858-1906`) — copy that
   approach, do not import one.
2. **Zero external assets.** Every texture, mesh, letterform and colour is
   generated at runtime from `NZ.tex` / canvas / procedural noise.
3. **Classic script**, wrapped `(function (global) { 'use strict'; ... })(window);`.
4. **Never break the game.** Wrap the whole install in `try/catch`; on any throw,
   tear your own additions back out, set your `NZ.flags` entry `false`, log, and
   return. The game must still run with your module deleted.
5. **Collision is grid-based and knows nothing about props.** A legal camera
   position is `>= PRAD` (1.15) from a wall plane and the camera can reach
   `f + 8.243` at the top of a jump — `nz-env.js`'s `jumpTop(f) = f + 6.7` is
   **1.55 units too low, do not trust it**. Anything the player can walk or jump
   into must either sit on an `S_BLOCK` cell, or hug a wall within
   `PRAD - 0.15 = 1.0` units, or start above `f + 8.30`.
6. **Scale drift warning.** `nz-env.js:607` hardcodes `METRES_PER_UNIT = 0.6`,
   but the truth is `1 u = 0.2857 m`. Every `SURF.tile` in `nz-env.js` is 2.1×
   finer than its comment claims. **Author new tiles as `metres × 3.5`** and do
   not copy nz-env's numbers assuming they mean what they say.
7. **Material naming is load-bearing for exposure.** `nz-render.js:2282-2288`
   only remaps baked vertex lighting for materials named `world:*` or `nzenv:*`.
   Follow whatever prefix `nz-street-sky.js` establishes in `NZ.street.day()` —
   getting this wrong lands the street up to 4.5 stops out of exposure.
8. **Draw-call budget.** The whole street — three modules together — gets
   **≤ 40 draw calls at `high`**, scaling down with tier. Merge aggressively into
   piles; use `InstancedMesh` for repeated elements (windows, balusters, pavers,
   railings, roof tiles). Report your own count via `NZ.street` stats.
9. **Determinism.** Seed every random placement from a fixed constant so two
   runs of the level are identical and a critic's screenshot is reproducible.
10. **Everything must be believable at 2 m.** The player walks the whole 24 m of
    this street looking at the walls from arm's length. No visible tiling, no
    untextured flats, no z-fighting, no floating props.

---

## 4. Required reading, in this order

1. `_research/STREET-BRIEF.md` — **and open the five images in `_ref/`.**
   Looking at them is not optional; the brief is a checklist, not a substitute.
2. `_research/ENV-PLAYBOOK.md` — the module skeleton, the material library, the
   `Pile`/`poly`/`boxC`/`tube` toolkit, decals, lettering, collision rules.
3. `_research/RENDER-CONTRACT.md` — `NZ.tex`, the post stack, tone mapping, the
   daylight strategy, the headless renderer.
4. `_research/LEVEL-CONTRACT.md` §3 (geometry build) and §4 (sky/fog) — how the
   world meshes you are decorating were made.
5. `CS2-BRIEF.md` — the house rules and the quality bar.

---

## 5. AMENDMENT — final module split and hook order

Five modules, loaded from `NUKEM.html` in this order:

```html
<script src="nz-street-sky.js"></script>       <!-- SKY      : done -->
<script src="nz-street-ground.js"></script>    <!-- GROUND   : road, kerbs, pavement -->
<script src="nz-street.js"></script>           <!-- FACADE   : the apartment blocks -->
<script src="nz-street-entrance.js"></script>  <!-- ENTRANCE : porch, steps, door, foyer -->
<script src="nz-street-props.js"></script>     <!-- PROPS    : cars, trees, lamps, walls, wires -->
```

**Hook priority: pass NO priority argument.** `nz-core.js:42-44` sorts
`(a, b) => b.p - a.p` — *descending* — so the negative priorities in §2 above
would run in reverse. Every existing module registers `ready` at the default
`p = 0` and relies on `Array.prototype.sort` being stable, which makes the
firing order identical to the script-tag order. Do the same. Firing order is
therefore: `nz-render`, `nz-env`, **sky, ground, facade, entrance, props**,
`nz-enemies`, `nz-weapons`.

`NZ.street` is created by `nz-street-sky.js` **at script-parse time**, not in its
hook, so it is available to everyone regardless of ordering.

### Seam: the entrance

`nz-street.js` (FACADE) owns the north facade plane `z = 156` **except** the door
recess at `x ∈ [240, 244], y ∈ [0, 11.2]`, which it leaves open and describes in
`NZ.street.facades[n].entrance`. `nz-street-entrance.js` builds everything inside
that recess plus the foyer interior behind it.

### Seam: the ground

`nz-street-ground.js` owns everything at and below `y = 1.0` inside the canyon —
the asphalt, its patching and tar seams, the kerbs, the pavement, drainage
covers, puddles and ground decals. FACADE owns the plinth from `y = 0` upward on
the wall planes; GROUND must not paint the wall. PROPS stands objects on the
ground GROUND made and must not modify it.

### Seam: what the SKY agent requires of everybody

1. **Call `NZ.street.day(mat)` on every material you create.** Do not set
   `material.name` yourself afterwards — the `nzday:` prefix keeps you out of
   `nz-render.js`'s `neutralizeBakedLighting()`, which is tuned for night bakes
   and would compress this street's only shading cue.
2. **Call `NZ.street.bake(geo, { occluders: [...] })` on every geometry**, passing
   your own local boxes — balcony slabs, bay soffits, eaves, car bodies, tree
   canopies. At `low` tier (which every headless shot uses) GTAO is off, so this
   bake is the *only* ambient occlusion in frame.
3. **Add no lights.** r149 has no per-object light masking; anything you add
   lights the night half of the level. Emissive materials are fine.
4. **Author colours against `NZ.street.SKY`** — linear radiance at the visible-dome
   scale, not sRGB swatches. Calibration: an up-facing white surface receives
   2.00, a vertical one about 1.30. A cream render at albedo 0.65 with a
   wall-height bake of 0.41 lands at ~204/255, which is the brief's target.
   **If your surface comes out hot, lower the albedo, not the light.**
5. **Everything above `y = 52` is unoccluded sky.** Roofs, ridges, chimneys,
   tanks, aerials and wires paint over the sky quad normally.
6. **FACADE specifically:** build the north block's roof mass at `z < 156`,
   `y ∈ [52, 64]`. It closes two holes the sky module currently papers over with
   fade strips — above the alley mouth (`x ∈ [176, 188]`) and above the foyer
   door (`x ∈ [240, 244]`), where the facade stops at `y = 52` with open air
   behind and the night dome shows through.

### Verification is part of every job

```bash
node --check <your file>
npm test
node scripts/render-level.mjs --list
node scripts/render-level.mjs --shot=street.westend --diag
node scripts/render-level.mjs --sheet=street          # resumable, 2 calls
npm run shot -- --sheet=quick
```

Presets: `street.westend`, `street.deadend`, `street.north34`, `street.south34`,
`street.northwall`, `street.southwall`, `street.entrance`, `street.alley`,
`street.sky`, `street.high`, `street.kerb`. Shots land in `_shots/street/`.
**Read your PNGs back with the Read tool and compare them to `_ref/`.** Baseline
draw calls for the bare level: 562 calls / 173,928 tris (`--diag`).

---

## 6. AMENDMENT 2 — THE WIDENED STREET (supersedes §1 and parts of §5)

The user reviewed the first build against the photographs and rejected three
things: the street is **too narrow** (facade-to-facade and kerb-to-kerb), it is
**too short and has no origin** — it should begin at a small junction with a
kerbed island, per the new reference `_ref/ref8-park-intersection.png` — and
the two hero buildings must be **faithful recreations** of the two blocks in
`_ref/ref6-ablok-entrance-zoom.png` (SEYDİKENT A-BLOK) and
`_ref/ref7-bblok-pink-full.png` (SEYDİKENT B-BLOK), which face each other.

The re-carve is DONE and validating
(`Level OK: 1818 traversable nodes, 20 doors, 4 lifts, 128 spawns`).

### 6.1 New geometry — replaces the §1 tables everywhere

| thing | cells | world | metres |
|---|---|---|---|
| street body | x 42..62, y 38..47 | x ∈ [168,252], z ∈ [152,192] | 24.00 × 11.43 |
| north pavement | y 38..39 | z ∈ [152,160] | 2.29 deep |
| roadway | y 40..45 | z ∈ [160,184] | **6.86 wide** (photo: ~7.0) |
| south pavement | y 46..47 | z ∈ [184,192] | 2.29 deep |
| junction throat (side street) | x 44..47, y 38..39 painted ROAD f=0 | x ∈ [176,192], z ∈ [152,160] | 4.57 wide |
| junction island (S_BLOCK) | x 46..47, y 42..43 | x ∈ [184,192], z ∈ [168,176] | 2.29 × 2.29 |
| foyer (interior) | x 59..62, y 31..36 | x ∈ [236,252], z ∈ [124,148] | 4.57 × 6.86 |
| foyer door | cell (60,37) | x ∈ [240,244], z ∈ [148,152] | 1.14 wide |

Facade planes: **north z = 152**, **south z = 192**, west gable x = 168
(y 38..47), dead end x = 252. Crown of the road stays **z = 172**. Kerb lines:
**z = 160 (N)** and **z = 184 (S)**, kerb height 0.5. Heights (storeys, eaves
51.8, c = 52, roofs above) are unchanged from §1.

The side street entering from the north is the (night) east alley, x 41..47.
The corner block was grown south (x 42..43, y 33..37 now solid) so the throat
is exactly x 44..47, and the c 28→52 mismatch drops the **bridge band** — a
building mass spanning the side street, wall face at z = 152, y ∈ [28,52],
x ∈ [176,192]. FACADE must clad it as the corner building it is; it also masks
the day/night transition, so it must read as solid architecture.

Alley column x = 41 at y 33..37 stays OPEN (secret-room approach + drain-stair
top). It is a night-side nook outside the daylight zone.

### 6.2 S_BLOCK map (PROPS scans, as before)

```
N kerb bays  y=40: x 50..53 | 55..58        (junction apron x<=49: NO bays)
S kerb bays  y=45: x 50..53 | 56..59
island       y=42..43: x 46..47             (kerbed teardrop, conifer, signs)
N tree pits  y=38: x 49, 54, 62             (62 is EAST of the door: frames it)
S tree pits  y=47: x 45, 49, 58
```

Rows 41 and 44 are never blocked: the road flows around the island with two
clear cells (2.29 m) each side. The sightline island → foyer door must stay
open: nothing tall between x 184 and the door except the pit at x 49/54
(N pavement, low or bare trees there — PROPS judges against the render).

### 6.3 The hero buildings — read the two zoom photos until you can draw them

**North side, entrance block (x ≈ 208..252): SEYDİKENT B-BLOK** — the pink one
(`_ref/ref7`). Salmon-pink smooth render, 5 storeys, paired sash windows in
white PVC, two stacks of grey-glazed balconies, red block lettering
`SEYDİKENT B-BLOK` at first floor, heavy weather streaking under sills, tan
BRICK garden wall with concrete coping and dark ornate steel railing panels in
front of it (per ref7 and ref2), entrance recessed at pavement level. Our
gameplay door at x 240..244 is its entrance.

**South side, facing it (x ≈ 196..252): SEYDİKENT A-BLOK** — the cream one
(`_ref/ref6`). CRITICAL, its cladding is not render: it is **horizontal lap
siding** (vinyl-look, ~200 mm exposure) in pale cream, with vertical corner
trim strips, brown gutters and downpipes, glazed balcony stacks in white PVC,
and the entrance porch: 6–8 steps rising parallel to the facade behind a
maroon flaking-paint garden wall, white balustrade-look railing, and the red
individual letters `SEYDİKENT` / `-A- BLOK` on two lines beside the door at
first-floor height. Its porch is a full replica but NON-enterable (door
dressed shut). A big conifer stands right beside the porch (photo ref6 —
the trunk passes in front of the lettering).

Use the real names — the user asked for these exact buildings. Other blocks
on the street keep invented names in the same pattern.

### 6.4 The junction + island (`_ref/ref8`)

Wide open asphalt apron (x 42..49: no bays, no crown parking), the side street
pouring in from the north under the bridge band over a dropped kerb (the
junction throat is painted road at f = 0 — GROUND owns the surface change),
and the island: precast kerb ring with chamfered units, scruffy grass and bare
soil, ONE dominant conifer (8–10 m), a blue rectangular direction sign and a
blue arrow sign on poles at its west nose, a red-triangle warning sign on a
pole at the throat, a worn white painted arrow on the approach asphalt,
patch seams and puddle darkening. PROPS owns everything standing on it;
GROUND owns its kerb ring, soil and the road markings around it.

### 6.5 Who does what, this round

- **SKY** (`nz-street-sky.js`): zone boxes/masks/fades to the new AABB
  (z 152..192, junction at x 176..192 z<=152 under the band y 28..52), sky
  quad extent, backdrop reposition, `NZ.street.BOX/MOUTH/DOOR/PLANE/KERB`
  republished with the new numbers. `probe`, `day()`, `bake()` semantics
  unchanged.
- **GROUND** (`nz-street-ground.js`): resurface to the new rows; junction
  apron + throat (dropped kerbs, no centre crown breaks across the junction);
  island kerb ring + soil; worn arrow + patching per ref8; bays/pits from the
  new scan.
- **FACADE** (`nz-street.js`): planes to z=152/z=192; the two hero buildings
  per §6.3; bridge-band cladding; W gable, E dead-end block; roof masses
  (incl. over the throat); `facades[]` republished (keep the schema;
  `facades[n].entrance` for B-BLOK at x 240..244 z=152).
- **ENTRANCE** (`nz-street-entrance.js`): door/recess renumbered to z=152 and
  cell (60,37); porch per B-BLOK photo (recessed at pavement level behind the
  brick garden wall, canopy, letterbox); keepClear republished.
- **PROPS** (`nz-street-props.js`): island planting/signs; cars re-stood on
  the wider road (bays moved); garden walls per §6.3 (brick N, maroon
  flaking S); lamps, wires, dishes; the A-BLOK-porch conifer.

Everything else in §3 (non-negotiables) and §5 (seams, `day()`/`bake()`,
no lights, budgets, determinism) stands.

### 6.6 Render presets (updated in scripts/render-level.mjs)

`street.westend` `street.island` (NEW — the ref8 composition)
`street.deadend` `street.north34` `street.south34` `street.northwall`
`street.southwall` `street.entrance` `street.junction` (NEW) `street.alley`
`street.sky` `street.high` `street.kerb`. Money shots for the user:
`street.island` and `street.westend`.

Boot now costs 25–36 s of a 45 s shell call. What lands reliably:
`--w=420 --h=264 --budget=32 --taa=1 --wait=70`, retried once or twice;
`--w=320 --h=200` lands more often. Check `wrote 1 file(s)`. Do not
`pkill -f chrome-headless-shell` (it matches your own call); check
`pgrep -c chrome` — stray processes make the next boot fail.
