# LEVEL-CONTRACT.md — how to carve a new area into Nuke Zone 3D without breaking anything

Research pass, read-only. Every claim below was checked against
`C:\Users\Test1\Desktop\duke nukem\NUKEM.html` (8038 lines) and the modules, and the
recommended carve in §8 was **actually executed through `scripts/validate-level.mjs`
in a scratch copy and comes back green**. Line numbers are for the current
`NUKEM.html` (git `master`, `de3b722` + working changes).

Baseline before any edit:

```
Level OK: 1619 traversable nodes, 19 doors, 4 lifts, 119 spawns, elevations
-9, -8, -7, -6, -5, -4, -3.3, -3, -2.2, -2, -1.1, -1, 0, 0.7, 1, 1.4, 2, 2.1,
3, 4, 5, 6, 7, 8, 9, 10, 11, 12
NUKEM.html: 5 inline scripts parsed
public/game/NUKEM.html: 5 inline scripts parsed
```

---

## 1. Grid + constants — the scale you can trust

### 1.1 The numbers

`NUKEM.html:2368-2369`:

```js
const MW = 64, MH = 48, CELL = 4;
const S_SOLID = 0, S_FLOOR = 1, S_DOOR = 2, S_KEY = 3, S_SECRET = 4, S_EXIT = 5, S_BLOCK = 6;
```

| symbol | value | meaning |
|---|---|---|
| `MW` | 64 | grid columns (x, world +X = east) |
| `MH` | 48 | grid rows (y, world +Z = south) |
| `CELL` | 4 | **world units per cell edge** |
| `M` | 3.5 | **world units per metre** |

Cell → world: `worldX = cellX * CELL`, `worldZ = cellY * CELL`, cell centre is
`+CELL/2` on both. The whole map is `64*4 = 256` × `48*4 = 192` world units
= 73.1 m × 54.9 m.

### 1.2 Units per metre — the number to trust is **3.5**

`NUKEM.html:355-360` (the definition):

```js
/* World units per metre. The single number the whole build is dimensioned
   from; see the SCALE note above ECFG. 6.40 units / 1.83 m = 3.50. Every
   constant below that has a real-world analogue is written `metres * M` and
   carries the millimetre value in a comment, so a wrong figure is legible on
   the page instead of only in a render. */
const M = 3.5;
```

`NUKEM.html:4303-4311` (the SCALE note the brief asked for, above `ECFG`):

```
   ---- SCALE ---------------------------------------------------------------
   `M` is the one number the whole game is dimensioned from, and CS2-ENEMY-
   BRIEF.md section 2 fixes it: the RIFLEMAN is the 1.83 m baseline operator at
   h = 6.40, so 6.40 / 1.83 = 3.50 units per metre. The level was already built
   to it - corridor ceilings are 9 (2.57 m), doors 8.2 (2.34 m), the step height
   1.15 (0.33 m), the player's hull radius 1.15 (0.66 m across). Anything below
   with a real-world analogue is written as `metres * M` and carries the
   millimetre value in a comment, so a wrong number is visible on the page
   instead of only in the render.
```

**Derived, all verified against source:**

| quantity | world units | metric |
|---|---|---|
| **1 metre** | **3.5 units** | — |
| **1 cell (`CELL`)** | **4 units** | **1.143 m (1143 mm)** |
| 1 cell diagonal | 5.657 | 1.62 m |
| corridor ceiling (`c: 9`) | 9 | 2.571 m |
| door opening (`min(c, f+8.2)`) | 8.2 | 2.343 m |
| step / climb (`CLIMB`, `NUKEM.html:3157`) | 1.15 | 0.329 m |
| player hull radius (`PRAD`, `:3651`) | 1.15 | 0.329 m (0.657 m across) |
| eye height (`EYE = 1.71 * M`, `:3649`) | 5.985 | 1.710 m |
| crouch eye (`EYE_CROUCH = 1.15 * M`) | 4.025 | 1.150 m |
| crate height (`CRATE_H`, `:2491`) | 4.2 | 1.200 m |
| RIFLEMAN height (`ECFG.trooper.h`) | 6.40 | 1.829 m |
| jump apex (`JUMPV 17.0 / GRAV 64`) | 2.26 | 0.645 m |
| street region ceiling (`rStreet.c = 34`) | 34 | 9.71 m |
| alley region ceiling (`rAlley.c = 28`) | 28 | 8.00 m |

**Ignore** the "~3.95 u/m" table in `nz-enemies.js:5540-5560` — that is a Round-1
derivation kept as a historical comment inside a block that concludes `EYE` was the
outlier; the shipped number is `M = 3.5`.

Rule of thumb for authoring: **a real street lane is 3 m ≈ 10.5 units ≈ 2.6 cells**;
a 5-cell roadway is 20 units = 5.7 m, i.e. two lanes. A 2-cell pavement is 2.29 m.

### 1.3 The grid arrays (`NUKEM.html:2371-2389`)

```js
const grid = new Uint8Array(MW * MH);          /* S_* cell type              */
const regionOf = new Int16Array(MW * MH);      /* index into REG, default 0  */
const seen = new Uint8Array(MW * MH);          /* for the automap            */
const chamberOf = new Int16Array(MW * MH).fill(-1);
let CHAMBERS = 0;
const GRACE_ZONE = new Uint8Array(MW * MH);
const idx = (x, y) => y * MW + x;
const inb = (x, y) => x >= 0 && y >= 0 && x < MW && y < MH;
function cellAt(x, y) { return inb(x, y) ? grid[idx(x, y)] : S_SOLID; }
function isWallCell(x, y) { const t = cellAt(x, y); return t === S_SOLID || t === S_SECRET || t === S_EXIT; }
```

Cell-type semantics (this table is the contract; everything downstream reads it):

| const | val | geometry emitted? | player passes? | AI walks? | LOS blocks? | in a chamber? |
|---|---|---|---|---|---|---|
| `S_SOLID` | 0 | no (it is the rock) | no | no | yes | no |
| `S_FLOOR` | 1 | floor + ceiling + walls | yes | yes | no | yes |
| `S_DOOR` | 2 | floor/ceiling/walls + header + door box | when open | yes | while shut | **no** (chamber boundary) |
| `S_KEY` | 3 | as `S_DOOR`, red panel | needs red key | no | while shut | **no** |
| `S_SECRET` | 4 | as `S_DOOR`, pushwall | after push | no | **yes** (`isWallCell`) | **no** |
| `S_EXIT` | 5 | none — treated as solid, gets a `switch` decal on the facing wall | no | no | yes | no |
| `S_BLOCK` | 6 | floor + ceiling + a crate box `CRATE_H` tall | no (blocks) | no | standing: no, crouched: yes | **yes** |

Out of bounds always reads `S_SOLID` (`cellAt`), so a carve that touches the map
border still gets a wall. Verified for every consumer: `losGrid` (2873), `losFast`
(4568, explicit bounds return `false`), `canStand`/`blockedCell` (3162-3186),
`navBuild` (4606), `markSeen` (3990), nz-env `solidCell`/`wallDist`/`cornerOcc`
(nz-env.js:172, 2093, 2110), nz-env `wallHere` (nz-env.js:2249).
**But** the shipped map keeps a 1-cell rock margin everywhere (carved extent is
x 1..61, y 1..46) — keep it.

---

## 2. The authoring API

All of it lives between `NUKEM.html:2368` and `NUKEM.html:2862`. That range is
also the **bare-vm window** the level validator extracts (see §7) — anything you
add must be self-contained inside it.

### 2.1 `region(o)` — `NUKEM.html:2391-2398`

```js
const REG = [];
function region(o) {
  const r = Object.assign({
    f: 0, c: 11, ftex: 'tilefloor', ctex: 'ceildark', wtex: 'concrete',
    amb: [.10, .10, .12], sky: false, fit: false, rect: null
  }, o);
  REG.push(r); return REG.length - 1;
}
```

Returns the **index** into `REG`, which is what you hand to `paint()`.
A region is a *material + height record*, not a place — the same region index is
painted onto disjoint rooms all over the map (all eight secret rooms share `rHide`).

| field | type | default | meaning |
|---|---|---|---|
| `f` | number | `0` | **Floor height in ABSOLUTE world Y units.** Not relative to anything. Negative is legal (`rTun` is `-9`). Read by `floorAt` (2482), `buildWorld` (2934), `NAV.fl` (4613), the validator, `drawMap`, nz-env, nz-audio. |
| `c` | number | `11` | **Ceiling height in ABSOLUTE world Y units.** *Not* relative to `f`. Headroom is `c - f`, and **`c - f >= 7.5` is a hard validator assert**. `rTun` is `{f:-9, c:-1}` = 8 units of headroom. |
| `ftex` | string | `'tilefloor'` | key into `TEX` for the floor quad. |
| `ctex` | string | `'ceildark'` | key into `TEX` for the ceiling quad. Ignored entirely when `sky: true`. |
| `wtex` | string | `'concrete'` | key into `TEX` for every wall quad this region emits. Also what a secret pushwall borrows (`3103-3110`, nz-env.js:3050-3062) and what nz-env's trim/dressing branches on (`R.wtex === 'hotelwall'` → chair rail; `metal`/`concrete` → "industrial" props). |
| `amb` | `[r,g,b]` | `[.10,.10,.12]` | the ambient floor added to every baked vertex colour in this region *before* the point lights (`lightAt`, 2888). It is the region's darkness floor. Outdoor regions run `.10–.16` per channel with a blue bias; interiors `.06–.15` warm. |
| `sky` | bool | `false` | **`true` suppresses the ceiling quad entirely** (`2947`). Everything else about `c` still applies (wall tops, headroom, audio, validator). See §4. |
| `fit` | bool | `false` | wall UV mode. `false` = world-tiled (`u = cell index`, `v = y / CELL`). `true` = each wall quad gets UV `0..1` stretched to the quad (`addWall`, 3054-3056). Used only by the hotel interiors. Has **no** effect after nz-env installs — nz-env recomputes all world UVs as a world-space planar projection (nz-env.js:2166-2172). |
| `rect` | any | `null` | **DEAD FIELD.** Zero readers anywhere in `NUKEM.html`, `nz-*.js`, or the scripts. Carried only by the defaults object. Do not bother setting it. |
| `hidden` | bool | *absent* | not in the defaults; set only on `rHide` (`2621`). Read by exactly two places: `makeDoorMeshes` (`3109`) and nz-env `secretWallKey` (nz-env.js:3059). Both mean "do not let a pushwall borrow this room's look and give the secret away". |

Anything else you put in `o` is carried on the object and read by nobody.

### 2.2 `carve` / `paint` / `regAt` — `NUKEM.html:2399-2407`

```js
function carve(x0, y0, x1, y1, type) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
    if (inb(x, y)) grid[idx(x, y)] = type === undefined ? S_FLOOR : type;
}
function paint(x0, y0, x1, y1, r) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
    if (inb(x, y) && grid[idx(x, y)] !== S_SOLID) regionOf[idx(x, y)] = r;
}
function regAt(x, y) { return REG[inb(x, y) ? regionOf[idx(x, y)] : 0]; }
```

* Bounds are **inclusive on both ends**. `carve(42,39,62,46)` is 21 × 8 = 168 cells.
* `carve` with no 5th arg writes `S_FLOOR`. Pass `S_SOLID` to re-solidify — the map
  already uses that idiom at `2574-2575`.
* **`paint` skips only `S_SOLID`.** It *does* paint `S_DOOR`, `S_KEY`, `S_SECRET`,
  `S_BLOCK` and `S_EXIT` cells. So a `paint` rectangle can safely overshoot into
  rock, and a door cell inherits whichever region you paint last over it.
* **Order matters.** Later `paint` wins. That is how the drain stair at x=40 steals
  cells back from `rAlley` (`paint(40,21,48,37,rAlley)` at 2653, then
  `paint(40,y,40,y,rDrain[36-y])` at 2690).
* An unpainted open cell is region `0` = `rDefault` = `{f:0, c:11, tilefloor/ceildark/concrete}`.
  This will not fail the validator; it will just look wrong. **Always paint.**

### 2.3 `door` / `light` / `spawn` — `NUKEM.html:2499-2501`

```js
function light(x, y, z, col, rad, inten) { LIGHTS.push({ x: x * CELL + CELL / 2, y: z, z: y * CELL + CELL / 2, c: col, r: rad, i: inten === undefined ? 1 : inten }); }
function door(cx, cy, kind) { DOORS.push({ cx, cy, kind, open: 0, tgt: 0, mesh: null, locked: kind === 'key', secret: kind === 'secret', used: false }); }
function spawn(kind, x, y) { SPAWNS.push({ kind, x, y }); }
```

* **`light(x, y, z, ...)` — the argument order is a trap.** `x` and `y` are **cell**
  coordinates; `z` is the **world height in units**. Internally it becomes
  `{x: worldX, y: height, z: worldZ}`. Radius `rad` and intensity `inten` are the
  falloff (`att = (1 - d/r)^2`, `2899`).
* `door()` does **not** touch `grid`. You must set the cell type yourself:
  `grid[idx(cx,cy)] = S_DOOR` (or `S_KEY`/`S_SECRET`) alongside the `door()` call.
  The map does both in one loop at `2578-2585`.
  `kind` is `'norm' | 'key' | 'secret'`.
* `spawn(kind, x, y)` — cell coords. `kind` is dispatched in `placeEntities` (7863):
  `'player'` → the camera; a key in `ECFG` → `spawnEnemy`; a key in `PICKDEF` → `makePickup`.
  * enemy kinds: `trooper`, `pig`, `enforcer`, `octa`
  * pickup kinds: `clip shells cbelt rockets medkit firstaid atomic armor medpack keyred wshotgun wchain wrpg wrifle rmag`
  * an unrecognised kind is **silently dropped**.

### 2.4 `makeLift` — `NUKEM.html:2502-2517`

```js
function makeLift(x0, y0, x1, y1, lo, hi, o) {
  const L = Object.assign({
    x0, y0, x1, y1, lo, hi, y: lo, tgt: lo, spd: 7.5,
    waitT: 0, standT: 0, mesh: null, sndT: 0, aiT: 0,
    cx: (x0 * CELL + (x1 + 1) * CELL) / 2, cz: (y0 * CELL + (y1 + 1) * CELL) / 2
  }, o || {});
  L.y = L.start === 'hi' ? hi : lo; L.tgt = L.y;
  LIFTS.push(L);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (inb(x, y)) liftOf[idx(x, y)] = LIFTS.length - 1;
  }
  return L;
}
```

`lo`/`hi` are absolute world Y. `o.start` is `'hi'` or `'lo'`. `o.spd` units/s.
The lift cells must already be carved and painted. `floorAt` returns the **live**
car height for a lift cell (2482-2485), which is why the player, the AI and
collision all ride it for free. Note `buildWorld` bakes with every car parked at
`lo` and drops a static shaft floor at `f - .5` (2928-2938) so there is never a
hole. The validator gives a lift cell **two** traversal nodes (`lo` and `hi`).

### 2.5 `CRATES` / `S_BLOCK` — `NUKEM.html:2590-2600`, `2491`

```js
const CRATE_H = 4.2;   /* 1200 mm of chest-high cover */
...
for (const c of [[5, 2], ... ]) { grid[idx(c[0], c[1])] = S_BLOCK; CRATES.push(c); }
```

A crate is *two* things written together: the cell type (blocks movement, blocks a
crouched sightline via `losFastLow` at 4588, does **not** block a standing one via
`losFast` at 4568) and an entry in `CRATES` (which is what grows the box mesh,
`makeCrates`, 3130). Write both or you get invisible cover / floating cover.
The crate box sits at `R.f + CRATE_H*.5` and inherits the region under it.

> Footnote: nz-env's `rebuildCrates` (nz-env.js:2930-2945) re-emits crates at
> `hh = 1.70` (3.4 units total), i.e. the pre-1200 mm height. The **gameplay**
> height (`shotBlocked` at 4059, `losFastLow`) is still `CRATE_H = 4.2`. Pre-existing
> mismatch, not something a new carve introduces — but do not be surprised if a
> crate in your new street looks 20 % shorter than it shoots.

---

## 3. Geometry build — grid → meshes

### 3.1 The walk: `buildWorld()` — `NUKEM.html:2927-2987`

Called from `boot()`'s stage list (`7977`), immediately after `buildMap()`.

```js
function buildWorld() {
  for (const L of LIFTS) { L._bake = L.y; L.y = L.lo; }
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const t = grid[idx(x, y)];
    if (!geomOpen(t)) continue;                       /* geomOpen = t !== S_SOLID && t !== S_EXIT */
    const R = regAt(x, y), f = R.f, c = R.c;
    const x0 = x * CELL, x1 = x0 + CELL, z0 = y * CELL, z1 = z0 + CELL;
    const fq = liftOf[idx(x, y)] >= 0 ? f - .5 : f;

    /* floor */
    quad3(R.ftex, [[x0,fq,z1],[x1,fq,z1],[x1,fq,z0],[x0,fq,z0]], [0,1,0],
          [[x,y+1],[x+1,y+1],[x+1,y],[x,y]], R.amb);

    /* ceiling */
    if (!R.sky) {
      quad3(R.ctex, [[x0,c,z0],[x1,c,z0],[x1,c,z1],[x0,c,z1]], [0,-1,0],
            [[x,y],[x+1,y],[x+1,y+1],[x,y+1]], R.amb);
    }

    /* walls */
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const d of dirs) {
      const nx2 = x + d[0], ny2 = y + d[1];
      const nt = cellAt(nx2, ny2);
      let segs = null, wtex = R.wtex, fitUV = R.fit;
      if (nt === S_EXIT) { segs = [[f, c]]; addDecal(x, y, d[0], d[1], f + 3.5, 1.45, 'switch', R.amb); }
      else if (nt === S_SOLID) { segs = [[f, c]]; }
      else {
        const nf = floorAt(nx2, ny2), nc = ceilAt(nx2, ny2);
        segs = [];
        if (nf > f + .02) segs.push([f, nf]);        /* step up into the neighbour */
        if (nc < c - .02) segs.push([nc, c]);        /* lintel above the opening   */
      }
      for (const s of segs) addWall(x, y, d[0], d[1], s[0], s[1], wtex, fitUV, R.amb, false);
    }

    /* door headers (visible from both sides) */
    if (t === S_DOOR || t === S_KEY) { const dh = Math.min(c, f + 8.2); ... }
  }
  makeMeshes(); makeDoorMeshes(); makeLiftMeshes(); makeCrates(); makeSky();
  ...
}
```

**This is the whole wall rule.** Two regions that touch produce a wall only where
their floors or ceilings disagree:

* neighbour floor higher → `[f, nf]` (a riser / kerb / cliff face),
* neighbour ceiling lower → `[nc, c]` (a lintel / parapet step).

Practical consequence for a new outdoor region: if your street's `c` differs from
`rAlley`'s `28`, the mouth between them grows a brick band `|c - 28|` units tall.
Match `c` for a seamless join.

### 3.2 Per-texture batching: `BUF` → `makeMeshes` — `2907-2925`, `3075-3092`

```js
const BUF = {};
function buf(tex) { let b = BUF[tex]; if (!b) b = BUF[tex] = { p: [], n: [], u: [], c: [] }; return b; }
function quad3(tex, v, nrm, uv, amb) {
  const b = buf(tex);
  const order = [0, 1, 2, 0, 2, 3];
  for (const i of order) {
    const P = v[i];
    b.p.push(P[0], P[1], P[2]); b.n.push(nrm[0], nrm[1], nrm[2]); b.u.push(uv[i][0], uv[i][1]);
    const c = lightAt(P[0], P[1], P[2], nrm[0], nrm[1], nrm[2], amb, false, true);
    b.c.push(c[0], c[1], c[2]);
  }
}
```

Everything is accumulated into **one bucket per texture NAME** (`R.ftex`, `R.ctex`,
`R.wtex`, plus `'switch'` for decals), then flushed:

```js
function makeMeshes() {
  for (const name in BUF) {
    const b = BUF[name];
    if (!b.p.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.p), 3));
    g.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(b.n), 3));
    g.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(b.u), 2));
    g.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(b.c), 3));
    g.computeBoundingSphere();
    const m = makeWorldMaterial(name, TEX[name], true);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = true; mesh.receiveShadow = true;
    scene.add(mesh); worldMeshes.push(mesh);
    delete BUF[name];
  }
}
```

Non-indexed, un-transformed (world space), 3 verts per triangle, no sharing.
**One draw call per texture, for the whole map.** A new region reusing `street`/
`brick`/`concrete` adds **zero** draw calls — it just grows existing buffers.
A new region introducing a texture name that is not already in use adds one mesh.

`makeWorldMaterial` — `3001-3009`:

```js
const SURFACE_STYLE = Object.freeze({
  metal: [52, 0x526679], grate: [44, 0x53687b], door: [38, 0x5d6872],
  keydoor: [42, 0x645f58], switch: [48, 0x66707a], glass: [90, 0x8aa8c9],
  tilefloor: [26, 0x4e5358], wood: [14, 0x4b3826], crate: [15, 0x493726],
  street: [8, 0x30363d], concrete: [7, 0x34373a], brick: [8, 0x382f2a],
  stone: [7, 0x35383c], hotelwall: [10, 0x403a34], ceil: [12, 0x46484b],
  ceildark: [7, 0x2b3037], carpet: [4, 0x282321]
});
function makeWorldMaterial(name, map, vertexColors) {
  const style = SURFACE_STYLE[name] || [9, 0x343a40];
  const mat = new THREE.MeshPhongMaterial({
    map, vertexColors: !!vertexColors, fog: true,
    shininess: style[0], specular: style[1], dithering: true
  });
  mat.name = 'world:' + name;
  return mat;
}
```

**Valid texture names** (i.e. keys actually present in `TEX`, `mkTex` calls at
`NUKEM.html:434-689`):

`concrete, brick, glass, hotelwall, stone, metal, crate, street, carpet,
tilefloor, wood, ceil, ceildark, grate, door, keydoor, switch, sky`

Anything else gives `TEX[name] === undefined`, i.e. an untextured material. Also
note `WORLD_TEX_REPEAT` (`410-413`) and `WORLD_MIRRORED` (`414`) apply per name.

### 3.3 Vertex-baked lighting: `lightAt` — `NUKEM.html:2885-2905`

```js
function lightAt(x, y, z, nx, ny, nz, amb, flat, shadows) {
  let r = amb[0], g = amb[1], b = amb[2];
  for (let i = 0; i < LIGHTS.length; i++) {
    const L = LIGHTS[i];
    const dx = L.x - x, dy = L.y - y, dz = L.z - z;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 > L.r * L.r) continue;
    const d = Math.sqrt(d2) || 1e-4;
    let nd = flat ? .78 : (dx*nx + dy*ny + dz*nz) / d;
    if (nd <= .02) continue;
    nd = .28 + .72 * nd;
    if (shadows !== false && !losGrid(x, z, L.x, L.z)) continue;
    let att = 1 - d / L.r; att *= att;
    const k = att * nd * L.i;
    r += L.c[0]*k; g += L.c[1]*k; b += L.c[2]*k;
  }
  _lc[0] = clamp(r, 0, 1.45); _lc[1] = clamp(g, 0, 1.45); _lc[2] = clamp(b, 0, 1.45);
  return _lc;
}
```

* Called **once per emitted vertex** (`quad3`), so cost is `verts × LIGHTS`, each
  with a `losGrid` grid march. Currently 94 lights. Adding 8-10 is ~10 % more bake
  time in the `BAKING LIGHTMAPS...` stage; adding 50 would be noticeable.
* Shadowing is a **2-D** grid march (`losGrid`, 2873) using `isWallCell`, so a light
  is occluded by walls, pushwalls and the exit block — *not* by floors or ceilings.
  A light placed in a region above yours will bleed through. Keep new lights
  inside the cells they belong to.
* `losGrid` treats `S_SECRET` as a wall, which is how the secret rooms stay dark.

### 3.4 What the finished scene graph looks like

After `buildWorld()` (stock, no modules):

| object | count | `.name` | `material.name` | `userData` |
|---|---|---|---|---|
| merged world meshes | one per texture in use (13 today) | **`''` — NOT SET** | `'world:<tex>'` | **none** |
| door boxes | 19 | `''` | `'world:door'` / `'world:keydoor'` / `'world:<wtex>'` | none |
| lift cars | 4 | `''` | `'world:grate'` | none |
| crate boxes | 22 | `''` | `'world:crate'` | none |
| sky dome | 1 | `''` | unnamed `MeshBasicMaterial`, `side: BackSide`, `fog: false`, `map: TEX.sky`, `renderOrder = -1` | none |
| lights | 4 | `'ambient-fill'`, `'sky-fill'`, `'warm-key'`, `'cool-rim'` | — | — |

`NUKEM.html` sets **no `userData` at all** (grep returns nothing) and names no mesh.
The only stable handles are:

1. **`material.name === 'world:<tex>'`** — this is the documented contract; nz-env's
   `matKey` (nz-env.js:2075-2079) is written to it.
2. **`geometry.attributes.color` present + `geometry.index === null` + not instanced**
   — nz-env's `isWorldMerged` (nz-env.js:2071-2074), which is how it separates the
   merged level from the indexed door/lift/crate boxes that share the naming.
3. The module-global `const worldMeshes = []` (`NUKEM.html:2867`) — a top-level
   lexical binding, **not** a `window` property, reachable from a classic script only
   via the `tryGet(() => worldMeshes)` thunk idiom nz-env/nz-audio use
   (nz-env.js:130-163).

Names/userData added **later** by the modules, on the `ready` hook:

| set by | key | value |
|---|---|---|
| nz-render | `skyDomeMesh.userData.nzNoGBuffer` | `true` |
| nz-render | `skyDomeMesh.material.name` | `'nz:sky-dome'`, `material.__nzSkyDome = true` |
| nz-render | `geometry.userData.nzBakeFixed` | `1` after `neutralizeBakedLighting()` |
| nz-env | `mesh.name` | `'nzenv-trim-concrete'`, `'nzenv-trim-plaster'`, `'nzenv-detail-steel'`, `'nzenv-detail-rust'`, `'nzenv-detail-wood'`, `'nzenv-crates'`, `'nzenv-decals'`, `'nzenv-lenses'` |
| nz-env | `material.name` | `'nzenv:<key>'`, `'nzenv:rust'`, `'nzenv:decal'`, `'nzenv:lens'` |
| nz-env | `mesh.userData.nzNoDerivedNormal`, `.nzReliefMM` | on its own materials |

**There is no per-region or per-area identifier on any mesh.** A module that wants
to find "the new street's geometry" on `ready` must do it **spatially** — the world
meshes are in world space, so an AABB test on `x ∈ [42*4, 63*4)`, `z ∈ [38*4, 47*4)`
against `geometry.attributes.position` is the only route. If you want a cleaner
handle, the minimal, non-breaking addition would be `mesh.userData.nzTex = name` in
`makeMeshes` — but that is a change to the geometry section, not the level section,
and it is *not* required by anything today.

### 3.5 The per-vertex floor/ceiling attribute (`nzFC`)

Added by **nz-env**, not by `NUKEM.html`. Two producers:

`nz-env.js:2225-2229` (retargeting the game's merged world meshes):

```js
var uvAttr = new THREE.Float32BufferAttribute(uv, 2);
geo.setAttribute('uv', uvAttr);
geo.setAttribute('uv2', uvAttr);           /* aoMap reads vUv2; share the buffer */
geo.setAttribute('nzFC', new THREE.Float32BufferAttribute(fc, 3));
```

`nz-env.js:1900` (its own detail piles, via `Pile.prototype.vert`):

```js
this.c.push(r, g, b); this.fc.push(this.ctxF, this.ctxC, 9);
```

**Layout: `vec3(floorY, ceilY, wallDist)`.**

* `.x` = the **region floor height** of the cell that triangle sits in
  (`fc[i*3] = fY`, nz-env.js:2175).
* `.y` = the **region ceiling height** — except that everywhere a `Pile` is filled
  the convention is `R.sky ? R.f + 200 : R.c` (nz-env.js:2630, 2737, 2840, 2937,
  3022, 3040), i.e. **an outdoor region reports its ceiling as `f + 200`** so the
  ceiling-contact darkening ramp can never fire outdoors.
* `.z` = distance in world units from that vertex to the nearest solid cell,
  capped at 6, and only computed for up/down-facing faces; wall verts get the
  sentinel `9` (nz-env.js:2178-2186). This is the floor-junction contact occlusion.

Declared in the injected GLSL at `nz-env.js:1582` (`attribute vec3 nzFC;`), varied
at `:1611` / `:1710`, and deleted on dispose at `:3497`.

**A new region gets all of this for free** as long as it is a normal region on the
grid — nz-env walks `MW × MH` and `regionAt(cx, cy)` and needs nothing else.

---

## 4. Sky

### 4.1 The stock chain

1. `TEX.sky` — `NUKEM.html:669-689`, a 1024 × 512 canvas painted as a **night** sky:
   vertical gradient `#05070f → #0d1426 → #243354 → #5c4a3a`, 420 stars, a moon at
   `(0.74w, 0.2h)`, and a warm sodium haze band across the bottom 38 %.
2. `makeSky()` — `NUKEM.html:3146-3154`:

```js
function makeSky() {
  const g = new THREE.SphereGeometry(460, 24, 16);
  const m = new THREE.MeshBasicMaterial({
    map: TEX.sky, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false, dithering: true
  });
  skyMesh = new THREE.Mesh(g, m);
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
}
```

   Radius 460 world units, `renderOrder = -1`, and it is **re-centred on the camera
   every frame** (`NUKEM.html:3965`: `if (skyMesh) skyMesh.position.copy(camera.position);`).

3. `region.sky === true` → `buildWorld` skips the ceiling quad (`2947`). That is the
   *entire* mechanism. You see the dome through the hole. Walls still stop at `c`.

### 4.2 nz-render replaces it with a procedural **daylight** sky

`nz-render.js:1442-1450` finds the dome by shape, not by name:

```js
function findSkyMesh() {
  var found = null;
  scene.traverse(function (o) {
    if (found || !o.isMesh || !o.material || Array.isArray(o.material)) return;
    var m = o.material;
    if (m.__nzSkyDome) { found = o; return; }
    if (m.isMeshBasicMaterial && m.side === THREE.BackSide && m.fog === false && m.map) found = o;
  });
  return found;
}
```

`installSkyDome` (`nz-render.js:1529-1581`) swaps the material for a `ShaderMaterial`
running `nzSky()` and sets `mesh.userData.nzNoGBuffer = true`. The palette
(`nz-render.js:359, 384-391`) is unambiguously **daytime**:

```js
sunElevation: 34.0,
skyLum: 0.94,
skyZenith:  0x758696,
skyHorizon: 0xc9d2d4,
skyHaze:    0xe6d8bd,
skyGround:  0x9a8b74,
skyCloud:   0xf2ece2,
skyKeyCol:  0xffe4c0
```

**So the game already renders in daylight whenever `nz-render.js` loads.** A new
outdoor region needs nothing more than `sky: true` to be lit by the same sun and
the same IBL probe. `TEX.sky` (the night canvas) is only what you see if nz-render
fails its GLSL probe and falls back.

### 4.3 Can two regions have different sky / lighting?

* **Different sky: no.** There is exactly one `skyMesh`, one dome material, one set
  of sky uniforms. Every `sky: true` region shows the *same* sky.
* **Different lighting: yes, three ways** — per-region `amb`, per-region point
  `LIGHTS` (which do respect walls in 2-D), and the choice of `c` (which controls
  how much dome you can actually see and how deep the canyon reads). What you
  cannot do is give one street a night sky and another a day sky.
* Region `sky` also drives **audio** (`nz-audio.js:3244-3272`: `sky` → the
  `'outdoor'` IR, `space.wet = 0.055` instead of `0.09–0.34`; `NUKEM.html:3292`:
  reverb send `.025` outdoors; `NUKEM.html:3350` `weaponTail` takes the exterior
  branch) and **nz-env dressing** (no floor-standing drums, no pallets, no ceiling
  conduits outdoors; exterior band courses instead of skirting; catenary street
  lamps instead of ceiling pans).

### 4.4 Fog — global, single instance

`NUKEM.html:7940-7942`:

```js
scene = new THREE.Scene();
scene.background = new THREE.Color(0x01030a);
scene.fog = new THREE.Fog(0x01040b, 52, 338);
```

Linear fog, **one `scene.fog` for the whole level** — there is no per-region or
per-material fog control beyond the `fog: true/false` flag on each material
(`makeWorldMaterial` sets `fog: true`; the sky dome sets `fog: false`).

nz-render retints and pushes it back (`nz-render.js:1585-1620`):

```js
/* The level ships scene.fog = Fog(0x01040b, 52, 338) -- a near-black haze
   that starts 52 units out. Under a night sky that was consistent; under a
   lit one it is a grey-out ... so the fog is retinted to the measured horizon
   radiance and pushed back out of the play space. */
...
scene.fog.color.copy(tmpCol);
if (scene.fog.near !== undefined) { scene.fog.near = 70; scene.fog.far = 520; }
```

So in the shipped build the fog is **near 70 / far 520**, tinted to the sky
horizon. A 21-cell street is 84 units long — comfortably inside `near`, so fog will
barely touch it. Nothing to configure.

---

## 5. Free grid space

### 5.1 Full occupancy of the 64 × 48 grid

Produced by running `buildMap()` in a bare vm exactly as `validate-level.mjs` does.
Legend: `#` `S_SOLID` · `.` `S_FLOOR` · `D` `S_DOOR` · `K` `S_KEY` · `S` `S_SECRET`
· `X` `S_EXIT` · `B` `S_BLOCK` (crate).

```
     0         1         2         3         4         5         6
     0123456789012345678901234567890123456789012345678901234567890123
  0 |################################################################|
  1 |#...................##########..................################|
  2 |#....BB.............##########..................################|
  3 |#....B..............##########...B..............################|
  4 |#........................K......................X###############|
  5 |#...................##########............BB....################|
  6 |#..B.....B.......B..#...##...S..................################|
  7 |#...............BB..S...##...#..................################|
  8 |#...................#...########################################|
  9 |##.##D#########D################################..............##|
 10 |#......................................#########..............##|
 11 |####D#########D###############D#################..............##|
 12 |#........#.........###.................#########.###D#####D#####|
 13 |#........#.........###...........................#.....#......##|
 14 |#........#.........###.................###########..B..#.B....##|
 15 |#........#.........###.................#........##.....#....B.##|
 16 |#........#..B......###.................#........##.....#......##|
 17 |#........#.........###.................#........#.............##|
 18 |#........#.........#.S.................#........#.............##|
 19 |#........#.........###.................#........#.###########.##|
 20 |#........#.........###.................D........#.###########.##|
 21 |##############S###################D#########D##...###########.##|
 22 |############.....#####.............######..................##.##|
 23 |############.....#####.............#....#..................##.##|
 24 |############.....#####.............S....#.....................##|
 25 |###......########....#.............#....#..................#####|
 26 |###......########....S.............######..................#####|
 27 |###......########....#.............######...BB.............#####|
 28 |#####S################....BB.......######..................#####|
 29 |####.......###########.............######..................#####|
 30 |####.......###########.....................................#####|
 31 |####.......###########.............######..................#####|
 32 |####...............................######..................#####|
 33 |####.......###########.............#....#..................#####|
 34 |####.......###########.............#....S..................#####|
 35 |####.......###########.........B...#....#..................#####|
 36 |#######.##############.............#####...................#####|
 37 |#####......###########.............#####........################|
 38 |#####......###################.#########.#######################|
 39 |#####......##################...########.#######################|
 40 |#####......##################...########.#######################|
 41 |#####......##################...########.#######################|
 42 |#####..................................#.#######################|
 43 |#####..............................B...#.#######################|
 44 |#####....................................#######################|
 45 |##################################....B.########################|
 46 |##################################......########################|
 47 |################################################################|
```

Totals: 3072 cells, 64 chambers, 57 regions, 94 lights, 19 doors, 4 lifts,
119 spawns (1 player + 30 operators + 88 pickups), 208 `GRACE_ZONE` cells.

Reference — the full `buildMap()` carve list, `NUKEM.html:2519-2600`:

* ground floor: street `(22,22)-(34,37)`; theatre alley `(11,32)-(21,32)`;
  theatre lobby `(4,29)-(10,35)`; street→east-alley passage `(35,30)-(40,30)`;
  east alley `(41,22)-(47,37)`; hotel lobby `(22,12)-(38,20)`;
  main corridor `(1,10)-(38,10)`; west suites `(1,12)-(8,20)`;
  east suites `(10,12)-(18,20)`; pawn shop `(40,12)-(47,20)`;
  warehouse `(1,1)-(19,8)`; security corridor `(20,4)-(29,4)`;
  reactor/exit `(30,1)-(47,7)`
* hotel upper wing: `(48,9)-(61,11)`, `(39,13)-(48,13)`, `(48,12)`,
  `(50,13)-(54,16)`, `(56,13)-(61,16)`, `(49,17)-(61,18)`, `(49,19)-(49,21)`,
  `(47,21)-(48,21)`, `(61,19)-(61,24)`, `(59,24)-(60,24)`
* pit lift `(2,9)`
* hidden rooms A-H: `(17,25)-(20,27)`, `(3,25)-(8,27)`, `(36,33)-(39,35)`,
  `(20,18)`, `(12,22)-(16,24)`, `(21,6)-(23,8)`, `(26,6)-(28,7)`, `(36,23)-(39,25)`
* vertical: rooftop `(48,22)-(58,36)` @ +12; service lift `(7,36)`;
  tunnel plant `(5,37)-(10,44)` @ −9; long tunnel `(11,42)-(31,44)`;
  riser `(29,39)-(31,41)`; street lift shaft `(30,38)`;
  pump station `(32,42)-(38,44)` + `(39,44)` + `(34,45)-(39,46)`;
  drain stair `(40,36)-(40,44)` @ 0 → −8
* re-solidified bands: `x = 40..47` at `y = 12` and `y = 14`
* doors: `(34,21) (30,11) (4,11) (14,11) (5,9) (15,9) (39,20) (44,21) (52,12) (58,12)`;
  key door `(25,4)`
* pushwalls: `(21,26) (5,28) (40,34) (21,18) (14,21) (20,7) (29,6) (35,24)`
* exit: `(48,4)`
* crates (22): `(5,2) (6,2) (5,3) (9,6) (3,6) (16,7) (17,7) (17,6) (26,28) (27,28)
  (31,35) (44,27) (45,27) (12,16) (33,3) (42,5) (43,5) (52,14) (57,14) (60,15)
  (35,43) (38,45)`

### 5.2 The largest contiguous all-SOLID rectangles

Every maximal all-`S_SOLID` rectangle, top 25 by area:

| area | w × h | x range | y range | notes |
|---|---|---|---|---|
| **230** | **23 × 10** | **41..63** | **38..47** | **the block in the brief — CONFIRMED FREE** |
| **176** | **16 × 11** | **48..63** | **37..47** | **CONFIRMED FREE** (overlaps the above) |
| 135 | 15 × 9 | 49..63 | 0..8 | NE corner, above the upper hall |
| 115 | 5 × 23 | 59..63 | 25..47 | E edge column — reachable from both blocks above |
| 102 | 34 × 3 | 0..33 | 45..47 | SW strip, only 3 deep |
| 99 | 11 × 9 | 11..21 | 33..41 | between theatre nook and tunnels |
| 96 | 2 × 48 | 62..63 | 0..47 | the east border margin |
| 81 | 3 × 27 | 0..2 | 21..47 | west border margin |
| 80 | 4 × 20 | 0..3 | 28..47 | SW corner |
| 72 | 18 × 4 | 11..28 | 38..41 | over the long tunnel |
| 72 | 24 × 3 | 40..63 | 45..47 | south strip |
| 64 | 64 × 1 | 0..63 | 0..0 | north border |
| 64 | 16 × 4 | 48..63 | 0..3 | |
| 64 | 16 × 4 | 48..63 | 5..8 | |
| 64 | 64 × 1 | 0..63 | 47..47 | south border |
| 60 | 5 × 12 | 0..4 | 36..47 | |
| 48 | 1 × 48 | 0..0 | 0..47 | west border |
| 48 | 24 × 2 | 24..47 | 8..9 | |
| 48 | 12 × 4 | 0..11 | 21..24 | |
| 45 | 9 × 5 | 39..47 | 8..12 | |
| 44 | 11 × 4 | 11..21 | 28..31 | |
| 42 | 6 × 7 | 11..16 | 25..31 | |
| 40 | 10 × 4 | 20..29 | 0..3 | |
| 40 | 40 × 1 | 24..63 | 8..8 | |
| 33 | 11 × 3 | 50..60 | 19..21 | |

### 5.3 Verdict on the blocks in the brief

* **`x = 41..63, y = 38..47` — VERIFIED 100 % SOLID.** 230 cells. It is the single
  largest free rectangle on the map.
* **`x = 48..63, y = 37..47` — VERIFIED 100 % SOLID.** 176 cells.
* **True maximum extent of the SE void.** The union of those two rectangles is the
  whole SE void; it is not itself rectangular, because `(41..47, 37)` is the east
  alley. Written as a union:
  * `x = 41..63, y = 38..47` (23 × 10), **plus** `x = 48..63, y = 37` (16 × 1)
    = **246 free cells**.
  * The adjoining `x = 59..63, y = 25..47` column (5 × 23 = 115) is *part of the
    same void* and joins it at `y = 38`, so if you want a building mass north of
    the street, `x = 59..62, y = 25..37` is available and touches the rooftop's
    east edge at `x = 58`.
* **Recommended usable extent, keeping the map's 1-cell rock margin**
  (the shipped map carves only `x ∈ 1..61`, `y ∈ 1..46`):
  **`x = 41..62, y = 38..46` = 22 × 9 = 198 cells.**
* **HARD CONSTRAINT the brief did not anticipate: column x = 41 is NOT usable for
  y = 39..44.** Cell `(40, y)` is the nine-step drain stair
  (`carve(40,36,40,44)`, painted `rDrain[36-y]`), so:

  | cell | region | `f` | `c` |
  |---|---|---|---|
  | (40,36) | `rDrain[0]` | 0 | 9 |
  | (40,37) | `rDrain[-1]` | −1 | 9 |
  | (40,38) | `rDrain[-2]` | −2 | 9 |
  | (40,39) | `rDrain[-3]` | −3 | 9 |
  | (40,40) | `rDrain[-4]` | −4 | 9 |
  | (40,41) | `rDrain[-5]` | −5 | 9 |
  | (40,42) | `rDrain[-6]` | −6 | 9 |
  | (40,43) | `rDrain[-7]` | −7 | 9 |
  | (40,44) | `rDrain[-8]` | −8 | 9 |
  | (40,45) | SOLID | | |
  | (40,46) | SOLID | | |

  Carving `x = 41` at `y = 39..44` puts an `f = 0` cell directly against an
  `f = −3..−8` stairwell. The validator would still *pass* (aperture
  `min(c,9) − max(f,−3) = 9 ≥ 7.5`), but you would have punched a one-way drop
  into the drain shaft at every step. **Start the street at `x = 42`.**

### 5.4 The east alley's south edge — exact confirmation

Queried directly from the built grid:

| x | `(x,36)` | `(x,37)` | `(x,38)` | region of `(x,37)` |
|---|---|---|---|---|
| 39 | SOLID | SOLID | SOLID | — |
| 40 | `S_FLOOR` | `S_FLOOR` | `S_FLOOR` | **55 = `rDrain[-1]`, f = −1** ← the drain stair, NOT the alley |
| **41** | `S_FLOOR` | **`S_FLOOR`** | **SOLID** | **2 = `rAlley`** |
| **42** | `S_FLOOR` | **`S_FLOOR`** | **SOLID** | **2 = `rAlley`** |
| **43** | `S_FLOOR` | **`S_FLOOR`** | **SOLID** | **2 = `rAlley`** |
| **44** | `S_FLOOR` | **`S_FLOOR`** | **SOLID** | **2 = `rAlley`** |
| **45** | `S_FLOOR` | **`S_FLOOR`** | **SOLID** | **2 = `rAlley`** |
| **46** | `S_FLOOR` | **`S_FLOOR`** | **SOLID** | **2 = `rAlley`** |
| **47** | `S_FLOOR` | **`S_FLOOR`** | **SOLID** | **2 = `rAlley`** |
| 48 | `S_FLOOR` (**rooftop, f = 12**) | SOLID | SOLID | — |

**Confirmed: `(41..47, 37)` are all seven `S_FLOOR`, all region 2 = `rAlley`
(`{f: 0, c: 28, ftex:'street', wtex:'brick', sky: true, amb:[.10,.11,.17]}`), and
every cell directly south of them at `y = 38` is `S_SOLID`.** These are the cells
to open into. `(40,37)` is *not* alley — do not touch it.

Also note `(48..58, 36)` is the **rooftop at f = 12**. Keep `y = 37` solid for
`x = 48..62` or you open a one-way drop from the rooftop into the new area.

---

## 6. Everything that reads the grid and must not break

### 6.1 Collision

| what | where | reads | a new `f = 0` region implies |
|---|---|---|---|
| `PRAD = 1.15` | `3651` | — | player hull is 0.657 m across; a 1-cell (4 u) gap is 6× the hull — always passable |
| `blockedCell` | `3162-3170` | `cellAt`, `doorAt` | nothing to update; `S_FLOOR` is passable, doors below 0.82 open are not |
| `canStand` | `3178-3186` | `blockedCell`, `floorAt`, `CLIMB` | **any floor step > 1.15 is an impassable wall to the player.** A 0.5-unit kerb is fine; a 1.5-unit one is a cliff |
| `moveSlide` | `3172-3177` | `canStand` | — |
| `highestFloor` | `3187-3196` | `floorAt`, `grid` | the player stands on the **highest** floor under his radius — a kerb cell touching the road puts him at kerb height while overlapping the road |
| `floorAt` | `2482-2485` | `liftOf`, `regAt` | returns `LIFTS[..].y` for lift cells, else `region.f` |
| `shotBlocked` | `4053-4066` | `grid`, `regAt`, `CRATE_H` | bullets stop at `S_SOLID`/`S_EXIT`, at a crate below `f + 4.2`, and at a shut door below `f + 8.2` |

**Nothing to update.** Collision is entirely derived. Just respect `CLIMB = 1.15`.

### 6.2 AI navigation — `navBuild()` at `4606-4650`, called from `placeEntities` `7875`

```js
NAV.walk[i] = (t === S_FLOOR || t === S_DOOR) ? 1 : 0;
NAV.door[i] = t === S_DOOR ? 1 : 0;
NAV.fl[i]   = isDoor || t === S_FLOOR || t === S_BLOCK ? (REG[regionOf[i]] || REG[0]).f : 0;
```

then `wallN`/`hard` (8-neighbour cover counts, `4615-4625`), `open` (a 12-ray
exposure fan out to 10 cells, `4626-4639`), `navSyncLifts`, and an 8-neighbour
adjacency table gated by `navLink` (`4693-4705`) which refuses
`|Δfloor| > CLIMB` and refuses corner-cutting.

**Implications of a new region at `f = 0`:**

* **`S_KEY` and `S_SECRET` are not walkable for the AI, by design.** If your new
  area's *only* connection to the level is a key door or a pushwall, no operator
  can ever reach it and no operator inside it can ever leave. Use a plain opening
  or a `'norm'` door.
* Everything else rebakes automatically. `NAV.*` are `MW*MH` arrays already sized
  for the whole grid — **nothing to resize, nothing to register.**
* `NAV.open` on a wide open street is near 1.0, which the cover scorer reads as
  "middle of a room". Expect operators placed there to prefer edges — which is
  what you want, and which is why pavements/kerbs/crates matter.
* `buildSquads()` (`5015-5037`) partitions operators by proximity (≤ 26 units),
  |Δy| ≤ 6, and mutual `losFast`. A new isolated street will form its own squad(s)
  automatically. Nothing to declare.
* `losFast`/`losFastLow` (`4568`, `4588`) treat `S_SECRET` and `S_EXIT` as opaque
  and `S_BLOCK` as crouch-only cover — this is what makes crates real cover.

### 6.3 `buildChambers()` — `2427-2451`, called at `2700`

```js
function buildChambers() {
  chamberOf.fill(-1); CHAMBERS = 0;
  const blocked = i => {
    const t = grid[i];
    return t === S_SOLID || t === S_EXIT || t === S_DOOR || t === S_KEY || t === S_SECRET;
  };
  ...
  if (chamberOf[k] >= 0 || blocked(k) || regionOf[k] !== regionOf[c]) continue;
  ...
}
```

**A chamber is the flood fill of connected walkable cells that stops at a door AND
at a change of region.** The doc comment at `2409-2426` explains why both:

> Region alone is not enough, because a region is a material record and the same
> one is painted on disjoint rooms - all eight secret rooms share rHide ... The
> fill alone is not enough either: the street, both alleys, the theatre lobby, the
> rooftop and the tunnels are all reachable from one another without passing a
> door ... The stair strips (rMs, rDrain, rFire, rRoofStep) fragment into one-cell
> chambers because each step is its own region; nobody holds a staircase, so this
> costs nothing.

**How a new region fragments chambers — this is the single most under-appreciated
consequence of adding regions.**

* **One region → one chamber** (if contiguous).
* **A kerbed street with road + two pavements = three regions = three chambers,**
  even though a player walks between them freely. In the recommended plan this
  measures **64 → 68 chambers**: road (1) + north pavement (1) + south pavement (1)
  + foyer (1); the three mouth cells are deliberately painted `rAlley` so they
  merge into the existing alley chamber instead of forming a fifth.
* The **only** consumer is the suppressor (§6.6). The cost of fragmenting is that a
  silenced kill on the pavement does not alert a man standing in the road one cell
  away. If you want a single acoustically-coherent street, use **one** region and
  drop the kerb.
* `buildChambers()` must be called **after every carve, paint and door** — it
  already is, at `2700`. **Put every new `carve`/`paint`/`grid[...] = S_DOOR`
  above line 2700.**

### 6.4 `GRACE_ZONE` — `2380-2385`, `2696-2697`, `7281-7311`

```js
GRACE_ZONE.fill(0);
for (let i = 0; i < GRACE_ZONE.length; i++) if (regionOf[i] === rStreet) GRACE_ZONE[i] = 1;
```

It is derived **purely from `regionOf === rStreet`** and re-derived after every
paint, on purpose (the comment at `2693-2695` explains that the passage cell at
`(35,30)` and the lift shaft at `(30,38)` get overpainted and must fall out).

**A new region is automatically NOT in the grace zone.** Measured: 208 cells before
and after. **Nothing to update** — unless you deliberately want the opening quiet
extended, in which case add a second loop, *not* a second region check inside the
existing one.

Two rules it enforces (`enemyStep` at `5938-5945`, `aiSee` `4938`, `aiKnow` `5004`):
no operator body may enter it, and no operator may take a contact on a player
standing in it. Neither is affected by a distant new area.

### 6.5 The automap — `seen`, TAB

* `seen = new Uint8Array(MW*MH)` (`2373`), already whole-grid.
* `markSeen()` (`3990-3996`) marks a 9 × 9 cell box around the player, gated by
  `losGrid`. New cells reveal themselves.
* `drawMap()` (`7796-7846`) colours by storey:
  ```js
  const f = regAt(x, y).f;
  let col = f >= 9 ? '#c2801d' : f >= 3 ? '#8a6a30' : f > -1 ? '#2b3d52'
          : f > -6 ? '#256b5e' : '#1a8a78';
  if (liftAt(x, y)) col = '#e0c23a';
  if (t === S_DOOR) col = '#c9a318';
  else if (t === S_KEY) col = '#d03a2a';
  else if (t === S_BLOCK) col = '#6b4522';
  ```
  A new region at `f = 0` (or `f = 0.5`) falls in the `f > -1` bucket = `#2b3d52`,
  the "STREET" colour, and the legend already says STREET. **Nothing to update.**
* `drawMap` also hard-codes the exit marker at `seen[idx(47,4)]` drawn at cell 48
  (`7819`) — cosmetic, unrelated.
* Scale is `Math.min(w/(MW*1.35), h/(MH*1.35))`, so the map already draws the
  whole 64 × 48. **Nothing to update.**

### 6.6 The suppressor

Two halves:

1. **Noise radius** (`4023-4030`): a suppressed shot drops `aiNoise` radius from
   140 to 40 units (≈ 11 m). Purely a distance test — no grid state.
2. **Containment of the man-down callout** — `alarmChamber` (`6875-6889`):

```js
function alarmChamber(e, level, conf) {
  let n = 0;
  for (const m of enemies) {
    if (m === e || m.dead || !m.ai) continue;
    if (!sameChamber(m.x, m.z, e.x, e.z)) continue;
    ...
  }
  return n;
}
```

`sameChamber` (`2477-2481`) **fails closed**: two positions with no chamber under
either are *not* room-mates. A doorway belongs to *both* rooms it joins
(`chambersAt`, `2458-2471`).

**Implication:** every region boundary you draw is an acoustic boundary for quiet
kills. A three-region street means three separate containment zones. Decide this
deliberately. **Nothing to update in code** — but be aware that a kerb is not
free.

### 6.7 Spawn tables

* `SPAWNS` is one flat array; `placeEntities` (`7863-7897`) dispatches by kind.
* The doc block at `2761-2777` states the design contract: **thirty operators,
  every entry a HOLDING (2-4 men covering one approach from cover), marksmen only
  where a long lane exists.** A 21-cell street *is* a long lane — if you put an
  `octa` in it, it will own the whole thing.
* `AI_CAP = Math.max(...SKILLS.map(s => s.cap))` (`4498`) and `aiFireSlots`
  (`4502-4547`) give a per-squad allowance of 1/2/3 guns by squad size, with a
  global backstop. Adding a squad does not touch the cap.
* **Validator constraints on spawns:** exactly one `'player'`, exactly one
  `'keyred'`, and every spawn cell must be passable (not `S_SOLID`/`S_EXIT`/`S_BLOCK`).
  Do not add a second keycard.
* A spawn on a lift cell resolves to the car's parked height (`floorAt`).

### 6.8 `winLevel` / `S_EXIT`

* `grid[idx(48,4)] = S_EXIT` (`2588`). One cell, no `door()` entry.
* `S_EXIT` is **solid** to geometry (`geomOpen`, `2870`), to movement
  (`blockedCell`, `3164`), to LOS (`isWallCell`, `losFast`) and to the AI. The only
  thing it does is give the wall facing it a `switch` decal (`2960`) and answer the
  `use` key (`4237`: `if (t === S_EXIT) { winLevel(); return; }`).
* `winLevel` (`7464-7471`) just ends the level. It reads no grid state.
* **A new area must not add a second `S_EXIT`** — the validator does not check for
  it, but two exits would be two ways to win. Leave the exit alone.
* HUD tallies hard-code `SECRETS FOUND x / 8` (`7462`, `7511`). **If you add a
  pushwall you must also change both `/ 8` strings.** Do not add pushwalls unless
  you intend to.

### 6.9 Things a new region needs **nothing** done to

`losGrid`, `losFast`, `losFastLow`, `ceilAt`, `regAt`, `chambersAt`, `doorAt`,
`updateDoors`, `updateLifts`, all of `nz-render.js` (which never reads the grid),
`nz-audio.js`'s space classifier (it reads `regAt(cx,cz)` per frame), and all of
`nz-env.js` (it walks `MW × MH` and `G.regAt`). Every one of them is written
against the arrays, not against a list of rooms.

---

## 7. Validators — what `npm test` actually asserts

```json
"check:level": "node scripts/validate-level.mjs",
"check:game":  "node scripts/validate-game.mjs",
"test": "npm run check:level && npm run check:game"
```

### 7.1 `scripts/validate-level.mjs` — the bare-vm extraction

```js
const LEVEL_START = "const MW =";
const LEVEL_END = "/* ================================================== world geometry";
const CLIMB = 1.15;

function extractLevel(path) {
  const html = readFileSync(path, "utf8");
  const start = html.indexOf(LEVEL_START);
  const end = html.indexOf(LEVEL_END, start);
  if (start < 0 || end < 0) throw new Error(`${path}: level markers are missing`);
  return html.slice(start, end);
}

const publicLevel = extractLevel("public/game/NUKEM.html");
const rootLevel = extractLevel("NUKEM.html");
if (publicLevel !== rootLevel) throw new Error("Root and deployed level engines are out of sync");

const context = vm.createContext({ console });
vm.runInContext(
  publicLevel + `
    buildMap();
    globalThis.level = {
      MW, MH, grid: Array.from(grid), regionOf: Array.from(regionOf), REG,
      LIFTS, DOORS, SPAWNS, CRATES,
      S_SOLID, S_DOOR, S_KEY, S_SECRET, S_EXIT, S_BLOCK
    };
  `,
  context,
  { filename: "public/game/NUKEM.html#level" },
);
```

**THE MARKERS, EXACTLY:**

* start marker: the first occurrence of the literal string **`const MW =`** —
  today at **`NUKEM.html:2368`**.
* end marker: the first occurrence of the literal string
  **`/* ================================================== world geometry`** —
  today at **`NUKEM.html:2863`**.
* Extracted window: **lines 2368 through 2862 inclusive.** Note the `indexOf` is a
  plain substring search, and it takes `public/game/NUKEM.html` **first**, so the
  *deployed* file is the one actually executed; the root one is only compared for
  equality.

**Rules that fall straight out of this:**

1. **Every edit must land between those two markers** (or, for non-level code,
   entirely outside the window without disturbing either marker string).
2. **`public/game/NUKEM.html` and `NUKEM.html` must produce byte-identical
   windows.** They are currently byte-identical *whole files*. The simplest
   discipline: after editing the root, copy the whole file over
   `public/game/NUKEM.html`. `build-static.mjs:86-93` also warns (not errors) if
   the whole files differ, and ships the root one.
3. **The window runs in a bare `vm` context whose only global is `console`.**
   There is **no `window`, no `document`, no `THREE`, no `Math` helpers from the
   utils block, no `M`, no `clamp`, no `rr`, no `TAU`, no `PI`.** (`Math`,
   `Object`, `Array`, `Uint8Array` etc. are intrinsics and *are* available.)
   This is exactly why `CRATE_H` is written as a literal, `NUKEM.html:2488-2491`:

   > `/* 1200 mm of chest-high cover (1.20 * M). Written as a literal rather than`
   > `` `1.20 * M` because scripts/validate-level.mjs runs this section on its own ``
   > `in a bare vm, where the utils block above does not exist. */`
   > `const CRATE_H = 4.2;`

   **So: never write `metres * M` inside the level window. Write the literal and
   put the millimetre value in a comment.** Same for `PI`, `TAU`, `clamp`, `lerp`,
   `rr`, `ri`, `pick`, `sign`, `el`, `TEX`, `THREE`, `player`, `SKILLS`, `ECFG`,
   `PICKDEF` — **all of them are outside the window.**
4. The window's code must **parse and execute top-to-bottom with no side effects
   beyond the arrays** — `buildMap()` is called immediately after it.
5. `buildMap()` must be idempotent enough to be called once cold. (It is: it
   `grid.fill(S_SOLID)` first, and `region()` pushes into `REG`. Note `REG`,
   `LIGHTS`, `DOORS`, `SPAWNS`, `CRATES`, `LIFTS` are **appended to**, never
   cleared — calling `buildMap()` twice would double them. Nothing does.)

### 7.2 Every assertion in `validate-level.mjs`

Graph model: a node is `(x, y, height)`. `passable(x,y)` = not
`S_SOLID`/`S_EXIT`/`S_BLOCK` (`S_DOOR`, `S_KEY`, `S_SECRET` **are** passable, and
`S_KEY` is additionally blocked in the "before you have the key" pass).
`cellHeights` gives a lift cell two nodes (`lo`, `hi`) and every other cell one
(`REG[regionOf].f`). Edges: lift cells link their two heights; orthogonal
neighbours link when `neighbourHeight <= height + CLIMB + 1e-9` (`CLIMB = 1.15`).

| # | assertion | message |
|---|---|---|
| 1 | root and public level windows are byte-identical | throws `Root and deployed level engines are out of sync` |
| 2 | exactly **one** `kind === 'player'` spawn | `Expected one player spawn, found N` |
| 3 | exactly **one** `kind === 'keyred'` spawn | `Expected one red keycard, found N` |
| 4 | every spawn sits in a passable cell | `<kind> is placed in a blocked cell at x,y` |
| 5 | every **non-secret** door has **exactly two** passable orthogonal neighbours and they are **opposite** | `Door at x,y is bypassable or has ambiguous orientation` |
| 6 | door headroom: `Math.min(R.c, R.f + 8.2) - R.f >= 7.5` for the door cell's region | `Door at x,y has only N units of headroom` |
| 7 | every passable cell has a region (`REG[regionOf[i]]` truthy) | `Open cell x,y has no region` |
| 8 | **headroom**: `R.c - height >= 7.5` for every height of every passable cell | `Low headroom at x,y: N` |
| 9 | **aperture**: for each passable cell and its `+x`/`+y` passable neighbour, `|f_a - f_b| <= 1.15` **OR** `aperture <= 0` **OR** `aperture >= 7.5`, where `aperture = min(c_a, c_b) - max(f_a, f_b)` | `Cramped one-way drop between a and b: N units` |
| 10 | **full forward reachability** from the player spawn: `reachable.size === graph.nodes.size` | `N traversal nodes cannot be reached` |
| 11 | **full return reachability** (reverse BFS to the player spawn): `returnable.size === graph.nodes.size` | `N traversal nodes cannot return to the main level` |
| 12 | seven landmarks exist as nodes, are reachable, and are returnable | `<name> landmark is not on a traversable floor` / `cannot be reached` / `has no return route` |
| 13 | the red keycard is reachable **without** passing an `S_KEY` cell | `Red keycard requires passing its own locked door` |

The landmark list (`x, y, height`), which pins the level's shape and must keep
working:

```js
["upper key room",   59, 14,  5],
["mezzanine bridge", 43, 13,  5],
["rooftop",          55, 30, 12],
["pump station",     36, 46, -9],
["service tunnels",  18, 43, -9],
["warehouse pit",     4,  7, -3.3],
["exit approach",    47,  4,  0],
```

### 7.3 `scripts/validate-game.mjs`

```js
const files = ["NUKEM.html", "public/game/NUKEM.html"];
for (const file of files) {
  const html = await readFile(file, "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim()).filter(Boolean);
  if (!scripts.length) throw new Error(`${file}: no inline game script found`);
  for (const [index, source] of scripts.entries()) {
    try { Function(source); }
    catch (error) { throw new Error(`${file}: inline script ${index + 1} failed to parse: ${error.message}`); }
  }
  console.log(`${file}: ${scripts.length} inline script${scripts.length === 1 ? "" : "s"} parsed`);
}
```

Syntax check only, on the **inline** scripts of both files (5 each). It does not
execute anything and it does **not** look at `nz-*.js` at all — the build-time
verification of the module `<script src>` tags lives in `build-static.mjs:119-135`.

### 7.4 The complete checklist a new carve must satisfy to keep `npm test` green

1. Stay inside `const MW =` … `/* ===... world geometry`.
2. Reference nothing outside that window — **no `M`, `clamp`, `lerp`, `rr`, `PI`,
   `TAU`, `THREE`, `TEX`, `player`, `document`, `window`.** Numeric literals only.
3. Mirror the edit into `public/game/NUKEM.html` byte-for-byte.
4. Every new region: `c - f >= 7.5`.
5. Every new region boundary: `|Δf| <= 1.15`, or `min(c) - max(f) <= 0`, or
   `min(c) - max(f) >= 7.5`.
6. Every new area is reachable from `(28,36)` **and** can walk back.
7. Any new `S_DOOR` cell: exactly two passable orthogonal neighbours, opposite,
   and its painted region satisfies `min(c, f+8.2) - f >= 7.5`.
8. Don't add a player spawn. Don't add a `keyred`. Don't put any spawn on
   `S_SOLID`, `S_EXIT` or `S_BLOCK`.
9. Don't add `S_EXIT`. Don't add `S_SECRET` unless you also change both
   `SECRETS FOUND … / 8` strings at `7462` and `7511`.
10. Don't disturb the seven landmark cells.
11. Keep every `carve` / `paint` / `grid[...] = S_DOOR` **above** `buildChambers()`
    at line 2700 and above the `GRACE_ZONE` loop at 2696.
12. Keep `region()` calls in the `/* ---- regions ---- */` block (2602-2650), i.e.
    before the first `paint`.
13. Only use texture names that exist in `TEX`.
14. Keep the 1-cell rock margin (`x ∈ 1..62`, `y ∈ 1..46`).

---

## 8. Recommended carve plan — an outdoor Turkish residential street

**Status: this exact patch was applied to a scratch copy and run through
`scripts/validate-level.mjs` and the `validate-game.mjs` parse check. Both pass.**

```
Level OK: 1819 traversable nodes, 20 doors, 4 lifts, 127 spawns, elevations
-9, -8, -7, -6, -5, -4, -3.3, -3, -2.2, -2, -1.1, -1, 0, 0.5, 0.7, 1, 1.4, 2,
2.1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
5 inline scripts parsed
```

Deltas vs baseline: **1619 → 1819** traversal nodes, **19 → 20** doors,
**119 → 127** spawns, **94 → 102** lights, **57 → 60** regions,
**64 → 68** chambers, **208 → 208** GRACE_ZONE cells, **200** grid cells changed.

### 8.1 The layout

```
     0         1         2         3         4         5         6
     0123456789012345678901234567890123456789012345678901234567890123
 ...
 30 |####.......###########.....................................#####|
 31 |####.......###########.............######..................++++#|   foyer
 32 |####...............................######..................++++#|   x=59..62
 33 |####.......###########.............#....#..................++++#|   y=31..37
 34 |####.......###########.............#....S..................++++#|   f=0 c=12
 35 |####.......###########.........B...#....#..................++++#|
 36 |#######.##############.............#####...................++++#|
 37 |#####......###########.............#####........###########++++#|
 38 |#####......###################.#########.###+++#############D###|   mouth 44..46 + door 60
 39 |#####......##################...########.#+++++++++++++++++++++#|   N pavement  f=0.5
 40 |#####......##################...########.#+++++++++++++++++++++#|   N pavement  f=0.5
 41 |#####......##################...########.#+++++++++++++++++++++#|   roadway     f=0
 42 |#####..................................#.#+++++++++++++++++++++#|   roadway     f=0
 43 |#####..............................B...#.#+++++++++++++++++++++#|   roadway     f=0
 44 |#####....................................#+++++++++++++++++++++#|   roadway     f=0
 45 |##################################....B.##+++++++++++++++++++++#|   S pavement  f=0.5
 46 |##################################......##+++++++++++++++++++++#|   S pavement  f=0.5
 47 |################################################################|
```

* **Street body** `x = 42..62, y = 39..46` — 21 × 8 cells = 84 × 32 world units =
  **24.0 m long × 9.14 m wide**. Nine cells deep counting the mouth row.
* **Roadway** `y = 41..44` — 4 cells = 16 units = **4.57 m**, a two-lane
  residential road.
* **Pavements** `y = 39..40` and `y = 45..46` — 2 cells each = 8 units = **2.29 m**,
  raised to `f = 0.5` (**a 143 mm kerb** — a real kerb is 100-150 mm, and 0.5 is
  well under `CLIMB = 1.15` so it is walkable in both directions and passes the
  validator on `|Δf| <= 1.15` alone).
* **Mouth** `x = 44..46, y = 38` — a 3-cell (3.43 m) opening into the east alley,
  at alley level `f = 0`, painted `rAlley` so it belongs to the alley acoustically.
* **Apartment ground-floor foyer** `x = 59..62, y = 31..37` — 4 × 7 cells
  = 4.57 m × 8.0 m, `f = 0`, `c = 12`, entered by a `'norm'` door at `(60, 38)`.
  This is the "building entrance the street terminates at".
* **Why `x = 42` and not `41`:** column 40 is the drain stair (§5.3).
* **Why `y = 38` is solid for `x = 48..62`:** it keeps the rooftop at
  `(48..58, 36)`, `f = 12`, from acquiring a one-way drop into the new street.
* **Why the foyer is `c = 12`:** its west neighbours `(58, 31..36)` are the rooftop
  at `f = 12`. With `c = 12` the aperture is exactly `min(12,46) - max(0,12) = 0`,
  which satisfies the validator's `aperture <= 0` branch, **and** the wall segment
  the rooftop emits is `[12, 46]` — bit-identical to the `[f, c]` it emits today
  against solid rock. **The rooftop is visually unchanged.** Verified.

### 8.2 The patch — exact lines, exact placement

Six insertion points, all inside the validator window (2368-2862).

---

**(A) Carves — insert immediately AFTER `NUKEM.html:2572`**
(`carve(40, 36, 40, 44); /* nine-step drain stair to east alley */`),
i.e. at the end of the vertical-expansion block, before the solid-band loop at 2574:

```js
  /* ===== east residential street ==========================================
     An outdoor ground-level block hung off the south edge of the east alley,
     in the largest solid rectangle on the map (x 41..63, y 38..47). It stops
     at x = 42 because column 40 is the drain stair (f = -3 .. -8) and a floor
     at 0 next to it would be a one-way drop into the shaft, and it stops at
     y = 38 because (48..58, 36) is the rooftop at +12. */
  carve(42, 39, 62, 46);          /* street body, 21 x 8, ground level     */
  carve(44, 38, 46, 38);          /* three-cell mouth from the east alley  */
  carve(59, 31, 62, 37);          /* apartment ground-floor foyer          */
```

---

**(B) The building-entrance door — edit `NUKEM.html:2578-2579` in place.**

Before:
```js
  const dd = [[34, 21], [30, 11], [4, 11], [14, 11], [5, 9], [15, 9], [39, 20], [44, 21],
    [52, 12], [58, 12]];
```
After:
```js
  const dd = [[34, 21], [30, 11], [4, 11], [14, 11], [5, 9], [15, 9], [39, 20], [44, 21],
    [52, 12], [58, 12], [60, 38]];
```
(The loop on 2580 does both `grid[idx()] = S_DOOR` and `door(..., 'norm')`.)

---

**(C) Regions — insert immediately AFTER `NUKEM.html:2650`**
(the `rDrain[f] = region({...})` line closing the `/* ---- regions ---- */`
block), i.e. just before `paint(21, 21, 35, 37, rStreet);` at 2652.
Appending here means **REG indices 0..56 do not move.**

```js
  /* --- east residential street. Appended last so REG 0..56 keep their
     indices. c = 28 matches rAlley exactly, so the mouth has no lintel step;
     raise it to 34 (= rStreet) if you want a taller canyon and can live with
     a 6-unit brick band over the opening. --- */
  const rTRoad = region({ f: 0, c: 28, ftex: 'street', wtex: 'brick', sky: true, amb: [.16, .17, .24] });
  const rTWalk = region({ f: .5, c: 28, ftex: 'concrete', wtex: 'brick', sky: true, amb: [.16, .17, .24] });
  const rTFoyer = region({ f: 0, c: 12, ftex: 'tilefloor', wtex: 'stone', ctex: 'ceil', amb: [.15, .14, .12] });
```

---

**(D) Paints — insert immediately AFTER `NUKEM.html:2691`**
(`paint(7, 36, 7, 36, rShA); paint(30, 38, 30, 38, rShB); paint(46, 23, 47, 23, rShC);`),
i.e. **before** the `GRACE_ZONE` block at 2696 and **before** `buildChambers()` at 2700.
**Order inside this block is load-bearing** — later paint wins:

```js
  /* east residential street. Road first over the whole carve, then the two
     pavements on top of it, then the foyer (which also claims its own doorway
     cell at 60,38 so the door gets its headroom from the foyer's ceiling), and
     finally the mouth cells back to rAlley so they stay part of the alley's
     chamber instead of forming a three-cell island of their own. */
  paint(42, 38, 62, 46, rTRoad);
  paint(42, 39, 62, 40, rTWalk);
  paint(42, 45, 62, 46, rTWalk);
  paint(59, 31, 62, 38, rTFoyer);
  paint(44, 38, 46, 38, rAlley);
```

---

**(E) Lights — insert immediately AFTER `NUKEM.html:2753`**
(`light(30, 39, -3, ...); light(40, 40, 3, ...);`), before the `/* hidden rooms */`
block at 2755.
Remember the signature: `light(cellX, cellY, worldHeight, [r,g,b], radius, intensity)`.

```js
  /* east residential street. The two r >= 30 entries are the daylight wash and
     get NO fixture built for them (nz-env buildFixtures skips r >= 30, which is
     its rule for "this is sky, not a lamp"); the r <= 20 ones become real
     catenary lamps strung off the facades. */
  light(48, 42, 20, [.62, .72, 1.0], 44, .70); light(58, 42, 20, [.60, .70, 1.0], 40, .60);
  light(45, 40, 9, [1.0, .70, .30], 20, .85); light(52, 40, 9, [1.0, .70, .30], 20, .85);
  light(56, 45, 9, [1.0, .70, .30], 20, .85); light(60, 39, 8, [1.0, .82, .46], 16, .95);
  light(60, 34, 10, [1.0, .86, .62], 18, .90); light(61, 32, 10, [.95, .88, .70], 14, .70);
```

---

**(F) Spawns — two edits.**

Operators, `NUKEM.html:2815` (last entry of `const E`):

```js
    ['trooper', 36, 45],
    /* east residential street: a pair holding the road from the pavements and
       one man inside the foyer covering the door */
    ['trooper', 50, 43], ['enforcer', 57, 41], ['pig', 61, 35]
  ];
```

Pickups, `NUKEM.html:2857` (last entry of `const P`):

```js
    ['medkit', 38, 14], ['clip', 36, 18], ['rockets', 3, 7], ['firstaid', 5, 8],
    /* east residential street */
    ['shells', 45, 41], ['clip', 53, 45], ['firstaid', 60, 40], ['medkit', 61, 33], ['cbelt', 62, 36]
```

---

**(G) Sync.** After editing, copy the whole `NUKEM.html` over
`public/game/NUKEM.html`, then run `npm test`.

### 8.3 Optional refinements, with their costs

| refinement | how | cost |
|---|---|---|
| **Single acoustic street** (no kerb) | drop `rTWalk`, `paint(42,38,62,46,rTRoad)` only | 68 → 65 chambers; a quiet kill anywhere on the street alerts the whole street. Loses the kerb and the pavement material change. |
| **Taller canyon** | `c: 34` on `rTRoad`/`rTWalk` (matching `rStreet`) | a 6-unit brick lintel appears over the alley mouth. Harmless and arguably correct — the alley parapet is genuinely lower. |
| **Crates as cover** | add e.g. `[47,42],[54,44],[58,40]` to the `CRATES` loop at 2596-2600 | none; but note the nz-env visual crate is 3.4 units while the gameplay one is 4.2 (§2.5). |
| **A true 22-cell run** | extend to `x = 63` | breaks the 1-cell rock margin the rest of the map keeps. Functionally safe (every consumer treats out-of-bounds as solid — verified) but it is a convention break. |
| **Balconies / upper storey** | a second region at `f = 12`, `c = 28`, reached from the rooftop at `(58, 36)` | changes rooftop traversal and the `["rooftop", 55, 30, 12]` landmark's neighbourhood. Re-validate carefully. |
| **Extending the grace zone into the street** | a second explicit loop after 2697 | do **not** widen the `regionOf[i] === rStreet` test — the comment at 2693-2695 explains why that test is exact. |

---

## Top 5 gotchas

1. **The validator runs the level section in a BARE VM.** Nothing above
   `const MW =` (line 2368) and nothing below
   `/* ==...== world geometry` (line 2863) exists in it — no `M`, no `clamp`,
   no `THREE`, no `TEX`, no `PI/TAU`. Write numeric literals with the millimetre
   value in a comment, the way `const CRATE_H = 4.2;` does at line 2491. And the
   *deployed* copy `public/game/NUKEM.html` is the one actually executed, with the
   root copy only compared for equality — so mirror every edit or the test throws
   `Root and deployed level engines are out of sync`.

2. **`x = 41` is a trap for `y = 39..44`: the cell to its west, `(40, y)`, is the
   nine-step drain stair at `f = −3 .. −8`.** The `41..63 × 38..47` rectangle really
   is 100 % solid, but carving the west column of it puts an `f = 0` floor
   flush against a stairwell and silently opens a one-way drop into the shaft.
   The validator will *not* catch it (aperture 9 ≥ 7.5). Start at `x = 42`.
   Same class of trap: `(48..58, 36)` is the **rooftop at f = +12**, so `y = 37`
   must stay solid for `x ≥ 48`.

3. **`c` is ABSOLUTE world Y, not headroom, and `sky: true` only deletes the
   ceiling quad — it does not change what `c` means.** Walls still run to `c`,
   headroom is still `c - f` and still must be `>= 7.5`, audio still reads
   `c - f`, and the neighbour rule `if (nc < c - .02) segs.push([nc, c])` still
   drops a lintel wherever two regions disagree on `c`. Match your outdoor `c` to
   `rAlley`'s 28 for a seamless junction.

4. **Every extra region is an extra chamber, and chambers are the suppressor's
   containment model.** `buildChambers()` (2427) stops the flood fill at a door
   **and at a change of `regionOf`**, so a road + two pavements = three chambers,
   and a silenced kill on the pavement is inaudible to a man standing one cell
   away in the road. Painting the alley mouth back to `rAlley` (instead of leaving
   it as a third road fragment) is the difference between 68 and 69 chambers.
   And `buildChambers()`/`GRACE_ZONE` are computed at lines 2696-2700 — **every
   carve, paint and door must go above them.**

5. **The merged world meshes carry no `name` and no `userData` — the only handle
   is `material.name === 'world:<tex>'` plus the non-`window` lexical global
   `worldMeshes`.** A module hooking `ready` cannot ask "which mesh is the new
   street"; the whole map is one non-indexed buffer per texture, so it has to test
   world-space positions against an AABB. Corollary: reusing `street`/`brick`/
   `concrete` for the new area costs **zero** extra draw calls, and a brand-new
   texture name costs exactly one — and a name that is not a `TEX` key silently
   yields an untextured material.

### Bonus: the numbers to quote

* **3.5 world units = 1 metre.** `const M = 3.5;` (`NUKEM.html:360`), derived at
  `4303-4311` from the 1.83 m RIFLEMAN at `h = 6.40`.
* **1 cell = `CELL` = 4 units = 1.143 m.** The 64 × 48 grid is 73.1 m × 54.9 m.
* **Recommended free rectangle: `x = 42..62, y = 38..46`** (inside the
  `x = 41..63, y = 38..47` maximal void, minus the drain-stair column and keeping
  the map's 1-cell rock margin) — **21 × 9 = 189 cells = 24.0 m × 10.3 m**,
  plus `x = 59..62, y = 31..37` (28 cells) for the building it terminates at.
