# RENDER CONTRACT — nz-core / nz-render, and how to build a daylight zone

**Agent:** RESEARCH-RENDER (read-only). **Nothing in the game was edited.**
Every line number below is against the working tree as of this pass. Verbatim
snippets are copied from source; measured numbers were read out of a live
headless boot of `NUKEM.html` (see §6.4), not inferred.

Files read in full or in the parts that matter:
`nz-core.js` (419 L), `nz-render.js` (4267 L), `nz-env.js` (3540 L),
`nz-shots.js` (1509 L), `NUKEM.html` (8038 L), `scripts/render-critic.mjs`
(494 L), `_critic_operators.html` (2452 L), `vendor/three.r149.min.js`,
`CS2-BRIEF.md`, `CRITIC-REPORT.md`, `VERIFY-REPORT.md`.

---

## 0. TL;DR for the implementer

| question | answer |
|---|---|
| current tonemapper | ACES (three r149's RRT/ODT fit), `nz-render.js:175` |
| `P.exposure` | **0.95** (`nz-render.js:181`) — never auto, never per-view |
| exposure actually sent to the composite | **`0.95 × (1/0.6) = 1.5833`** (`nz-render.js:3730`) |
| contrast / saturation | **0.16** display-space S / **1.02** (`nz-render.js:182-183`) |
| were the 1.7 stops fixed by exposure? | **No.** `P.exposure` was never touched. The *light* was wrong. See §2.4 |
| `scene.environment` | procedural sky → CubeCamera → PMREM, `nz-render.js:1690`. `envMapIntensity = 1.0` everywhere |
| probe mean radiance | `P.envIrradiance = 0.285`, renormalised by measurement (`nz-render.js:281`, `1512`) |
| shadow casters | **exactly one**: `lights.sunKey` (`nz-render.js:1762`) |
| fog (live, measured) | `THREE.Fog`, colour `#bab8ae`, near **70**, far **520** |
| headless renderer runnable? | **Yes, after a 3-command install** — see §6.2. Verified end-to-end this session |
| recommended daylight strategy | **(c)+(b) hybrid, no new lights** — see §3.6 |

---

# 1. `nz-core.js` — the whole file, in contract form

`nz-core.js` is 419 lines and owns three things and nothing else: the hook bus,
the procedural PBR bakery, the spring math. **It is orchestrator-owned; per
`CS2-BRIEF.md:47` you may not edit it — request core changes.**

Wrapper (`nz-core.js:14`, `:419`):

```js
(function (global) {
  'use strict';
  const NZ = global.NZ = global.NZ || {};
  ...
})(typeof window !== 'undefined' ? window : this);
```

## 1.1 `NZ.flags` — `nz-core.js:22-27`

```js
NZ.flags = {
  render: false,    // nz-render.js  owns the post stack + IBL
  enemies: false,   // nz-enemies.js owns enemy meshes + animation
  weapons: false,   // nz-weapons.js owns the 3D viewmodel
  audio: false      // nz-audio.js   owns sfx synthesis
};
```

`env` is **not** in this literal. `nz-env.js:73` adds it defensively (verbatim):

```js
if (NZ.flags && NZ.flags.env === undefined) NZ.flags.env = false;
```

A new module must do the same for its own key. A module sets its flag `true`
only after a clean install (`nz-env.js:3327`, `nz-render.js:4198`) and back to
`false` first thing in `panic()` (`nz-env.js:3479`, `nz-render.js:3997`).

## 1.2 `NZ.debug` / `NZ.log` — `nz-core.js:29-30`

```js
NZ.debug = /[?&]nzdebug=1/.test(global.location ? global.location.search : '');
NZ.log = function () { if (NZ.debug) console.log.apply(console, ['[nz]'].concat([].slice.call(arguments))); };
```

`NZ.log` is a **no-op unless `?nzdebug=1`**. Anything you want a critic or a
harness to see unconditionally must go through `console.warn` / `console.error`
or through a `NZ.<module>.report()`-style accessor (`nz-env.js:3357`).

## 1.3 The hook bus — `nz-core.js:40-67`

```js
const H = Object.create(null);
NZ.on = function (name, fn, priority) {
  (H[name] || (H[name] = [])).push({ fn: fn, p: priority || 0, dead: false });
  H[name].sort((a, b) => b.p - a.p);
  return NZ;
};
NZ.has = function (name) { return !!(H[name] && H[name].some(l => !l.dead)); };
NZ.call = function (name) { /* fires every live listener; returns true if any ran */ };
NZ.first = function (name) { /* fires in order, returns the first non-undefined result */ };
```

Semantics that matter:

* **Priority sorts DESCENDING** (`b.p - a.p`). Higher priority runs **first**.
  `nz-shots.js` registers at `1000` to win the camera (`nz-shots.js:932`);
  `nz-env.js` registers `ready` at `-20` (`nz-env.js:3533-3538`); `nz-render.js`
  registers its late sweep at `-1000` (`nz-render.js:4249`) so it is the very
  last thing to touch the world.
* **A throwing listener is killed, not propagated** (`nz-core.js:54`, `:64`):
  `l.dead = true; console.error('[nz] hook "' + name + '" disabled after error:', err);`
  So a hook that throws once is silently gone for the rest of the session. Do
  not rely on that as your error handling — wrap your own body.
* `NZ.first` is the *override* channel: return `undefined` to decline,
  return anything else to claim.
* `NZ.call` is the *notify* channel: return value ignored.

### 1.3.1 Hook names, argument signatures, firing order

Fired from `NUKEM.html` unless noted. Order is the real boot order.

| # | hook | fired at | signature | channel |
|---|---|---|---|---|
| 1 | `rendererInit` | `NUKEM.html:7970` | `NZ.call('rendererInit', NZ.ctx)` | call |
| 2 | `ready` | `NUKEM.html:8016` | `NZ.call('ready', NZ.ctx)` | call |
| 3 | `resize` | `NUKEM.html:7859` | `NZ.call('resize', w, h, dpr)` | call |
| 4 | `render` | `NUKEM.html:7923` | `NZ.first('render', dt) === true` → game skips its own `renderer.render` | **first** |
| 5 | `scenePass` | `nz-render.js:3669` | `NZ.call('scenePass', { renderer, target, camera, dt, quality })` | call |
| 6 | `viewmodel` | `NUKEM.html:7705` | `NZ.call('viewmodel', dt, w, h, ovc, gun)` | call |
| 7 | `sfx` | `NUKEM.html:3368` | `NZ.first('sfx', name, x, z, AU) === true` | **first** |
| 8 | `createEnemyRig` | `NUKEM.html:5370` | `NZ.first('createEnemyRig', e)` | **first** |
| 9 | `animateEnemyRig` | `NUKEM.html:5398` | `NZ.first('animateEnemyRig', e, speed, now) === true` | **first** |
| 10 | `animateEnemyRigDeath` | `NUKEM.html:5433` | `NZ.first('animateEnemyRigDeath', e, t, fall) === true` | **first** |
| 11 | `enemyDamaged` | `NUKEM.html:6895` | `NZ.call('enemyDamaged', e, dmg, dir, hitPoint)` | call |
| 12 | `enemyKilled` | `NUKEM.html:6963` | `NZ.call('enemyKilled', e, dmg, dir, hitPoint)` | call |

**Exact firing order at boot** (`NUKEM.html:7940-8016`):

```
scene / camera / 4 lights created            (7940-7962)
NZ.ctx populated, NZ.call('rendererInit')    (7968-7970)   <-- NO GEOMETRY YET
  stage 1 buildTextures()
  stage 2 buildSprites()
  stage 3 buildMap()
  stage 4 buildWorld()      <-- vertex light bake happens here
  stage 5 placeEntities(); finishBoot()
finishBoot(): colorTexture/aniso, bindInput, resize, ...
NZ.call('ready', NZ.ctx)                     (8016)        <-- WORLD EXISTS
requestAnimationFrame(frame)
```

**`rendererInit` fires before a single level material exists.** That is why
`nz-render.js` flips colour management and installs the shader patch there
(`nz-render.js:4074-4113`). **`ready` fires once, after the whole level is
built.** A new module that needs to see the level installs on `ready`.

`ready` listener order in the shipping build (descending priority):

```
  0    nz-render.js:4205    buildEnvironment(), applyLighting, upgradeMaterials (phong->standard)
 -20   nz-env.js:3533       nz-env install(): material sets, UVs, trim, props, decals
-1000  nz-render.js:4249    wrapForeignMaterials(); neutralizeBakedLighting(); applyLighting()
-1000  nz-shots.js:1476     bootGame() (only when armed)
```

**A daylight module must sit between −20 and −1000**, i.e. register `ready`
at something like `-100`: after nz-env has built and retargeted the world
materials, but **before** `nz-render.js` neutralises the vertex bake and does
its final `wrapForeignMaterials()` sweep — so any material you create is picked
up by that sweep for free.

## 1.4 `NZ.ctx` — `nz-core.js:71`

```js
NZ.ctx = { renderer: null, scene: null, camera: null, THREE: null };
```

`NUKEM.html:7968-7969` fills it and **adds a fifth key not in the literal**:

```js
NZ.ctx.THREE = THREE; NZ.ctx.renderer = renderer; NZ.ctx.scene = scene; NZ.ctx.camera = camera;
NZ.ctx.lights = { ambient, skyFill, sunKey, coolRim };
```

## 1.5 `NZ.math` — `nz-core.js:74-113`

```js
NZ.math = {
  clamp, lerp, damp, TAU, Spring,
  smoothstep:   t => { t = clamp(t,0,1); return t*t*(3-2*t); },
  smootherstep: t => { t = clamp(t,0,1); return t*t*t*(t*(t*6-15)+10); },
  easeOutCubic: t => 1 - Math.pow(1-t, 3),
  easeOutExpo:  t => t >= 1 ? 1 : 1 - Math.pow(2, -10*t),
  easeInOutQuad:t => t < .5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2,
  hash: (i) => { let h = Math.sin(i*127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
};
```

`damp` is the frame-rate-independent exponential smoother
(`nz-core.js:102`): `damp = (a, b, rate, dt) => b + (a - b) * Math.pow(rate, dt)`
where `rate` is *"fraction remaining after 1 second"*. **This is the correct
primitive for a daylight-zone blend factor** — a per-frame `lerp(a, b, 0.1)`
is frame-rate dependent and will change speed with the tier.

`Spring` (`nz-core.js:81-98`) is critically damped by default
(`d = 2*sqrt(k)`, `k = 170`), sub-stepped at `1/240` with `dt` clamped to
`0.1`, so a hitch cannot explode it. API: `new NZ.math.Spring(v, k, d)`,
`.step(dt) -> x`, `.set(v)`, `.impulse(v)`, fields `.x .v .target`.

## 1.6 `NZ.tex` — the procedural PBR bakery

Public surface, `nz-core.js:408-416`:

```js
NZ.tex = {
  fbm, worley, normalFromHeight, bake, applySet, mulberry32,
  texFromScalar, texFromData, canvasOf,
  cache: Object.create(null),
  shared: function (key, specFn) {
    return NZ.tex.cache[key] || (NZ.tex.cache[key] = bake(specFn()));
  }
};
```

### 1.6.1 Noise primitives

| fn | line | signature | returns |
|---|---|---|---|
| `mulberry32(seed)` | 118 | `-> function(): float 0..1` | deterministic PRNG |
| `fbm(res, opts)` | 148 | `opts = { octaves=5, frequency=4, gain=0.5, lacunarity=2, seed=1337, ridged=false }` | `Float32Array(res*res)`, 0..1, **tiling** |
| `worley(res, opts)` | 176 | `opts = { cells=8, seed=99, invert=false }` | `Float32Array(res*res)`, F1 distance, **tiling**, 3×3 neighbourhood with wrap |
| `normalFromHeight(h, res, strength=2)` | 211 | Sobel on a wrapping height field | `Uint8ClampedArray(res*res*4)` RGBA, ready for `putImageData` |

Both noise functions **tile**. `nz-core.js:129`: *"Wrapping is essential — a
seam on a weapon receiver reads instantly as amateur work."*

There is **no** simplex, no curl, no domain warp, no 3-D noise in `NZ.tex`.
3-D value noise exists but only as GLSL, inside `nz-env.js`'s `FRAG_HEAD`
(`nz-env.js:1554-1566`, `nzHash(vec3)` / `nzN(vec3)`), and inside
`nz-render.js`'s `SKY_FN` as 2-D (`nzVN` / `nzFbm2`, `nz-render.js:1238-1249`).

### 1.6.2 Canvas + colour space

`canvasOf(res)` (`nz-core.js:236`) makes a square canvas.
`ctx2d(c)` (`:241`) always passes `{ willReadFrequently: true }` —
*"without this hint Chrome keeps them GPU-backed and warns on each readback."*

Colour space is handled in exactly two places and the rule is explicit
(`nz-core.js:248`):

```js
/* r149: colour maps are sRGB, data maps (normal/rough/metal/ao) are linear */
if (srgb) { if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding; }
```

* **`bake().map` (albedo) IS tagged sRGB** — `nz-core.js:332`.
* **`normalMap` / `roughnessMap` / `metalnessMap` / `aoMap` are left linear** —
  `texFromData(..., false)` at `:336`, and `texFromScalar` hard-codes
  `texFromData(THREE, data, res, false)` at `:261`.
* Every texture gets `wrapS = wrapT = RepeatWrapping` and `anisotropy = 8`
  (`:247`, `:251`, `:331`, `:333`). **`bake()` does not set mipmap filters or
  `generateMipmaps`**, so they take three's defaults. `nz-env.js:521-527`
  explicitly overrides that for world surfaces
  (`LinearMipmapLinearFilter` + `generateMipmaps = true`) — copy that if your
  new area's textures will be seen at grazing angles.

There is **no resolution cap and no automatic caching in `bake()` itself.**
Caching is opt-in through `NZ.tex.shared(key, specFn)`, which memoises the
whole baked set under a string key (`:413`). `NZ.tex.cache` is a plain object
you can inspect or clear.

### 1.6.3 `NZ.tex.bake(spec)` — the exact contract

Documented spec, verbatim from `nz-core.js:264-277`:

```
bake(spec) -> { map, normalMap, roughnessMap, metalnessMap, aoMap, dispose() }
spec = {
  res:        256,
  seed:       1,
  base:       '#3a4048' | [r,g,b] 0-255,
  paint:      fn(ctx, res, helpers)   optional freehand pass on the albedo
  height:     fn(res) -> Float32Array optional; defaults to fbm grain
  normalScale:2,
  rough:      { base:.55, variance:.28, map: Float32Array|fn }
  metal:      { base:.0,  variance:.1 }
  ao:         { strength:.6 }
  wear:       { amount:.35, colour:'#8d939c' }  edge-ish scuffing
}
```

Actual defaults read out of the body (the doc comment above is slightly stale
on two of them):

| field | default | line |
|---|---|---|
| `res` | `256` | 282 |
| `seed` | `1` | 283 |
| `height` | `fbm(res, { octaves:6, frequency:6, seed, gain:.52 })` | 288 |
| `base` | `'#3d434b'` | 292 |
| `grain` | `0.16` (undocumented in the header comment) | 297 |
| `wear.cells` | `10`, `wear.colour` `'#9aa1ab'` | 312, 316 |
| `normalScale` | `2` | 336 |
| `rough.base` | `0.55` | 340 |
| `rough.variance` | **`0.26`** (header says .28) | 341 |
| `metal.base` | `0` — **`metalnessMap` is `null` unless `base > 0` or `variance` set** | 358-365 |
| `ao.strength` | **`0.55`** (header says .6) | 370 |

**What `bake()` actually returns** (`nz-core.js:387-392`) — note the three
extra keys the header does not mention:

```js
const set = { map, normalMap, roughnessMap, metalnessMap, aoMap,
              canvas: c, height: height, res: res };
set.dispose = function () {
  for (const k of ['map','normalMap','roughnessMap','metalnessMap','aoMap'])
    if (set[k]) set[k].dispose();
};
```

`set.height` is the `Float32Array` height field — reuse it rather than
re-generating noise. `set.canvas` is the live albedo canvas.

`paint(ctx, res, helpers)` receives
`{ fbm, worley, height, lerp, clamp, TAU, rnd: mulberry32(seed + 91) }`
(`nz-core.js:327`).

Order of operations inside `bake()`: height → flat base fill → grain modulation
→ worley wear → `paint()` → sRGB `CanvasTexture` → normal (Sobel of `height`)
→ roughness (fbm, minus `worley * .35` so worn areas polish smoother, `:349`)
→ metalness → cavity AO (box-blur of `height` at radius `res/64`, `:374`).
**The AO pass is `O(n·r²)`** — `nz-env.js:399` calls this out and ships its own
separable `blurAxis` because *"at 512 that difference is the whole load-time
budget."*

`applySet(params, set, repeat)` (`nz-core.js:396-406`) copies the five maps
onto a `MeshStandard/Physical` parameter object and optionally sets
`repeat.set(repeat[0], repeat[1])` on all of them.

### 1.6.4 How to bake a new material — copy-paste

`nz-env.js` does **not** call `NZ.tex.bake()`; it has its own bakery layered on
`NZ.tex`'s primitives (`fbm`, `worley`, `mulberry32`, `canvasOf`,
`texFromData`) because it needs a packed ORM and a separable blur. The
canonical real `NZ.tex.bake()` call site is `nz-weapons.js:768` (and
`nz-enemies.js:1761`). Verbatim, `nz-weapons.js:761-786`:

```js
function bakeAtlas() {
  var T = NZ.tex, res = 256, tiles = [];

  /* ---- 0 nitrided / phosphated steel ---------------------------------
     Real nitride is DARK, slightly warm, and very even: the give-away of a
     fake gun texture is roughness that varies too much. Fine bead blast
     under a whisper of broaching. */
  tiles.push(T.bake({
    res: res, seed: 7, base: '#949291', grain: .05, ao: { strength: 0 },
    height: function (r) {
      var blast = T.worley(r, { cells: 64, seed: 11, invert: true });
      var fine  = T.fbm(r, { octaves: 3, frequency: 40, seed: 13 });
      var o = new Float32Array(r * r);
      for (var y = 0; y < r; y++) for (var x = 0; x < r; x++) {
        var i = y * r + x;
        /* broaching marks. At y*3.05 the period was 2.06 texels: below
           Nyquist, so the sobel turned it into per-texel random normals
           and the finish read as gravel rather than as machining. */
        var mach = Math.sin(y * 1.12 + fine[i] * 0.9) * .5 + .5;
        o[i] = clamp(.50 + (blast[i] - .5) * .22 + (fine[i] - .5) * .20 + mach * .04, 0, 1);
      }
      return o;
    },
    normalScale: 1.1, rough: { base: T_ROUGH[0], variance: T_ROUGHV[0] },
    metal: { base: T_METAL[0], variance: T_METALV[0] }
  }));
```

And for a **world surface** — the nz-env style, which is the one to copy for a
new outdoor area — the shape is (paraphrased from `nz-env.js:508-700`):

```js
/* 1. fields */
var height = NZ.tex.fbm(res, { octaves: 6, frequency: 6, seed: 91 });
var rough  = NZ.tex.fbm(res, { octaves: 4, frequency: 9, seed: 92 });
var ao     = /* your cavity term, or reuse the blurred height */;

/* 2. albedo canvas -> sRGB texture with world-surface filtering */
var c = NZ.tex.canvasOf(res);
var g = c.getContext('2d', { willReadFrequently: true });
/* ... paint ... */
var map = new THREE.CanvasTexture(c);
map.wrapS = map.wrapT = THREE.RepeatWrapping;
map.minFilter = THREE.LinearMipmapLinearFilter;
map.magFilter = THREE.LinearFilter;
map.generateMipmaps = true;
map.anisotropy = 8;
if (THREE.SRGBColorSpace) map.colorSpace = THREE.SRGBColorSpace;
else if (THREE.sRGBEncoding !== undefined) map.encoding = THREE.sRGBEncoding;

/* 3. ONE packed ORM instead of three greyscale uploads -- nz-env.js:534-548.
      R = ao, G = roughness, B = metalness. r149 reads exactly these channels
      for aoMap / roughnessMap / metalnessMap, so one RGBA upload replaces 3. */
var d = new Uint8ClampedArray(res * res * 4);
for (var i = 0, j = 0; i < ao.length; i++, j += 4) {
  d[j]     = clamp(ao[i], 0, 1) * 255;
  d[j + 1] = clamp(rough[i], 0.03, 1) * 255;
  d[j + 2] = 0;
  d[j + 3] = 255;
}
var orm = NZ.tex.texFromData(THREE, d, res, false);   // false = LINEAR. never sRGB.
orm.anisotropy = 8;

/* 4. normal from the same height field */
var nrm = NZ.tex.texFromData(THREE, NZ.tex.normalFromHeight(height, res, 2.0), res, false);

/* 5. the material. aoMap needs uv2 in r149 -- copy uv into uv2 on the geometry. */
var mat = new THREE.MeshStandardMaterial({
  map: map, normalMap: nrm,
  aoMap: orm, roughnessMap: orm, metalnessMap: orm,
  roughness: 1.0, metalness: 1.0,      // scalars MULTIPLY the map channels
  vertexColors: true, fog: true, dithering: true
});
mat.envMapIntensity = 1.0;
mat.name = 'nzday:asphalt';            // see 3.4 -- the prefix is load-bearing
```

Two traps, both documented in the tree:

1. `roughness` / `metalness` **multiply** the map channels
   (`nz-render.js:2013`: `ROUGH_CENTER = 0.82; /* three MULTIPLIES roughnessMap.g
   by material.roughness */`, and the pre-divide at `nz-render.js:2148`).
2. `aoMap` in r149 samples **`uv2`**, not `uv`. `nz-env.js` maintains a `uv2`
   attribute for exactly this and restores it in `panic()`
   (`nz-env.js:3499-3500`).

---

# 2. `nz-render.js` — the post stack

## 2.1 The frame, in order

Header, `nz-render.js:9-31`, and the real call sites in `renderFrame()`
(`nz-render.js:3515`):

| pass | line | target | note |
|---|---|---|---|
| adaptive tier / degrade | 3520 | — | `adapt(now)` unless `tierPinned && degrade === 0` |
| TAA jitter into `camera.projectionMatrix` | 3544-3548 | — | Halton(2,3), 8 samples, `HALTON` built at 3499 |
| `followShadow()` | 3564 | — | slide + texel-snap the sun's ortho box |
| 1 G-buffer prepass | 3569-3570 | `gRT` | oct normal + rough + metal + world-only depth |
| 2 GTAO + contact shadows | 3578-3609 | `aoRT` | 2 slices × 4 steps at high |
| 2b bilateral denoise ×2 | 3615, 3618 | `aoRT2`→`aoRT` | |
| 3 SSR trace | 3626-3642 | `ssrRT` | needs TAA + GTAO + full-res gbuf + shader patch |
| 3b SSR blur ×2 | 3651, 3654 | `ssrRT2`→`ssrRT` | |
| 4 **scene colour** | 3661-3663 | `sceneRT` | `renderer.render(scene, camera)` — the only real scene draw |
| 5 `scenePass` hook | 3665-3672 | `sceneRT` | viewmodel draws into the same HDR buffer, with AO/SSR uniforms forced off |
| 6 TAA resolve | 3678-3693 | `taaA/taaB` | YCoCg neighbourhood clip, Catmull-Rom history |
| 7 bloom prefilter + 5 down + 4 up | 3702-3720 | `bloomRT[]` | soft knee, Karis average |
| 8 **composite** | 3725-3744 | `ldrRT` or screen | exposure → tonemap → contrast → grade → sRGB → grain → dither |
| 9 motion blur | 3750-3763 | `ldrRT2` or screen | camera reprojection |
| 10 FXAA / present | 3770-3773 | screen | only when TAA is off |

## 2.2 `detectTier()` — `nz-render.js:722-740`

```js
function detectTier() {
  var m = /[?&]nzq=(low|med|high|ultra)/i.exec(global.location ? global.location.search : '');
  if (m) { tierPinned = true; return m[1].toLowerCase(); }
  var name = ''; /* WEBGL_debug_renderer_info UNMASKED_RENDERER_WEBGL, else gl.RENDERER */
  if (!caps.hdr || !caps.depth) return 'low';
  if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
  if (/mali|adreno\s*[1-5]\d\d|powervr|videocore/i.test(name)) return 'low';
  if (/intel.*(hd|uhd)\s*graphics|intel.*(gma|g33|g41)/i.test(name)) return 'low';
  if (/intel|iris|apple a\d/i.test(name)) return 'med';
  if (/rtx\s*[34-9]\d\d\d|rtx\s*[2-9]\d\d\d\s*(ti|super)|radeon\s*rx\s*[6-9]\d\d\d|apple m[2-9]/i.test(name)) return 'ultra';
  return 'high';
}
```

**Every headless render in this sandbox runs SwiftShader, so it always
resolves to `low` unless you pass `?nzq=`.** That is confirmed by the live
probe in §6.4 (`tier: "low"`).

### The four tiers — `nz-render.js:138-159`

| knob | ultra | high | med | low |
|---|---|---|---|---|
| `scale` (render scale) | 1.00 | 1.00 | 0.90 | 0.78 |
| `taa` | 1 | 1 | 1 | **0** |
| `gbuf` (G-buffer scale) | 1.00 | 1.00 | 0.50 | **0.00** |
| `gtao` / `aoSlices` / `aoSteps` | 1 / 3 / 5 | 1 / 2 / 4 | 1 / 2 / 3 | **0 / 0 / 0** |
| `ssr` / `ssrSteps` / `ssrRefine` | 1 / 32 / 5 | 1 / 24 / 4 | **0** | **0** |
| `contact` / `csSteps` | 1 / 14 | 1 / 10 | 1 / 6 | **0 / 0** |
| `mblur` / `mbSamples` | 1 / 11 | 1 / 8 | 1 / 6 | **0 / 0** |
| `mips` (bloom) | 5 | 5 | 4 | 3 |
| **`shadow`** (map px) | **3072** | **2560** | **1792** | **1024** |
| **`extent`** (ortho half-size) | **50** | **44** | **38** | **30** |
| `pcss` | 1 | 1 | 1 | **0** |
| `worldCast` | 1 | 1 | 1 | 1 |
| `envCube` (probe face px) | 512 | 512 | 256 | 256 |

Design note kept verbatim (`nz-render.js:123-133`): *"what matters is not
either number, it is the WORLD SIZE OF ONE TEXEL, 2\*extent/shadow"* — 0.033
units at high.

Degrade ladder on top of the tier (`computeEffects()`, `nz-render.js:809-829`):

```
>=1  ssr off
>=2  aoSlices-1, aoSteps-1, csSteps>>1, mbSamples-3, pcss off, gbuf capped 0.5
>=3  gtao off, contact off, gbuf 0
>=4  taa off, mblur off, worldCast off
>=5  scale *= 0.85, mips-1, shadow<=1024, extent<=36, envCube<=256
```

Hard capability gates follow at `:833-846`.

### Querying the tier from another module

```js
NZ.render.quality            // 'low' | 'med' | 'high' | 'ultra'  (nz-render.js:4141, kept in sync at 3493)
NZ.render.effects            // the whole resolved EFF object      (getter, 4178)
NZ.render.stats              // { ms, quality, degrade, locked, width, height, gbuf, patch, gpu }  (4184)
NZ.render.caps               // { hdr, depth, webgl2, halfLinear, shaderPatch, maxTex }  (4143)
NZ.render.params             // live P object -- reads take effect next frame (4142)
NZ.render.lightRig           // { key, probe, bounce, ambient, sunElevation, sunProbeShare, ... } (4171)
NZ.render.setQuality(q)      // pins a tier (4144)
NZ.render.setTonemap(name)   // 'agx'|'aces'|'neutral', rebuilds materials (4151)
NZ.render.rebuildEnvironment()   // re-reads P.sky* and re-bakes the probe (4189)
NZ.render.selfCheck() / .diag() / .blackScan(n) / .dispose()
```

`nz-enemies.js:8509` already does exactly this: *"adaptive quality: the render
module owns the tier, we follow it."* **Follow the tier, never set it.**

## 2.3 Tone mapping — the CURRENT calibrated numbers

**Renderer-level tone mapping is OFF.** `nz-render.js:4102-4105`:

```js
if (caps.hdr) {
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;
}
```

with the reason at `:4099`: *"r149 bakes tone mapping into every material
program and never re-checks it, so this must be set once, before anything
compiles, and never flipped per frame."* The game's own `1.18` is saved to
`stockExposure` purely for `panic()` (`:4098`).

Look parameters, `nz-render.js:167-220`:

```js
tonemap: 'aces',               /* 'agx' | 'aces' | 'neutral' */
exposure: 0.95,                /* photographic stop, tonemapper-neutral */
contrast: 0.16,                /* gentle S in display space */
saturation: 1.02,
lift: [0.000, 0.000, 0.000],
gain: [1.000, 1.000, 1.000],
bloom: 0.12,
bloomThreshold: 1.25,  bloomKnee: 0.55,  bloomClamp: 16.0,
grain: 0.016,  ca: 0.00060,  vignette: 0.20,  sharpen: 0.12,  shutter: 0.42,
```

**The exposure actually uploaded is not 0.95.** `nz-render.js:3730`:

```js
mComp.uniforms.uExposure.value = P.exposure * (P.tonemap === 'aces' ? (1 / 0.6) : (P.tonemap === 'neutral' ? 1.35 : 1.05));
```

| tonemap | multiplier | uploaded `uExposure` |
|---|---|---|
| **`aces` (shipping)** | **1/0.6 = 1.66667** | **1.58333** |
| `agx` | 1.05 | 0.9975 |
| `neutral` | 1.35 | 1.2825 |

Composite order of operations, `nz-render.js:3023-3076`, exactly:

```
1  chromatic aberration      c.r/c.b sampled at ±dir*r2*uCA          (uCA = 0.00060)
2  ratio sharpen (TAA only)  c *= clamp(1 + uSharpen*(lap/max(lc,0.02)), 0.70, 1.45)
3  AO fallback (no-patch)    c *= mix(1, ao.r*ao.b, uAO*(1-sat(luma*0.5)))
4  bloom add                 c += tBloom.rgb * uBloom     (uBloom = P.bloom / mips)
5  exposure vignette         vig = 1 - uVignette * pow(sat(len(dir*vec2(uAspect,1))*1.32), 2.2)
6  TONE CURVE                c = nzTonemap(c * uExposure * vig)      <-- 1.58333
7  display-space S           c = mix(c, c*c*(3-2*c), uContrast)      (0.16)
8  grade                     c = max(0, c*uGain + uLift)             (identity)
9  saturation                c = max(0, mix(vec3(luma(c)), c, uSat)) (1.02)
10 sRGB encode               srgb = nzLinearToSRGB(saturate(c))      <-- manual, in-shader
11 grain (display space)     srgb += g*uGrain*(0.35 + 0.65*sat(gw))  (0.016)
12 triangular dither         srgb += (d1 + d2 - 1) * uDither         (1/255)
```

The ACES fit (`nz-render.js:541-556`) is three r149's own `RRTAndODTFit`
term-for-term. AgX (`:528-539`) is Filament's 6th-order fit; the header at
`:168-175` explains why ACES ships instead: *"its LOOK is a long toe and a very
soft shoulder... Side by side against a CS2 frame that reads as milky."*

sRGB conversion is done **by hand in the composite** (step 10), and the target
is `LinearEncoding` (`makeRT`, `:663`). So by the time FXAA / motion-blur /
present run, the buffer already holds display-encoded bytes. **Do not add a
second encode anywhere downstream.**

### 2.4 The "1.7 stops hot" finding — what was actually corrected

`CRITIC-REPORT.md:39-73` is unambiguous, and the source agrees:

> **`P.exposure` was not touched.** It is still nz-render's shipping 0.95, and
> the arithmetic says it was always right: push scene-linear 0.180 through the
> shipping composite and it lands on 119/255 = 0.4665 sRGB … **Only the light
> was wrong, so only the light was changed.**

| probe | before | after | ideal |
|---|---|---|---|
| 18% grey card, facing lens | 204/255 (×3.25) | **117/255 (×0.975)** | 119/255 |
| exposure error | **+1.70 stop** | **−0.04 stop** | 0 |
| 2% black chip | ~73/255 | **28/255** | 17/255 |
| 90% white chip | clipped | **220/255** | 223/255 |
| key : fill at the card | ~1.5 : 1 | **2.87 : 1** | 3 : 1 |

The corrected values are **the harness's studio rig** (`keyIntensity 1.445`,
`envIrradiance 0.186`, in `_critic_operators.html`'s CALIB block).
**`nz-render.js`'s own level rig is a separate, separately-solved set**
(`nz-render.js:281`, `:299`, `:306`, `:332`, `:338`, `:352`):

```
envIrradiance   0.285      probe mean radiance = albedo multiplier from the sky
keyIntensity    1.45       (down from 3.80 -- the 1.16 stop measured error)
bounceIntensity 0.50       two cards, ±130 deg off the key, +7 deg elevation
kickerIntensity 0.26       one cool high card at the anti-key azimuth, 52 deg up
ambientFloor    0.035      readability floor, NOT a fill
sunProbeShare   0.050      share of probe flux given to the solar disc
sunElevation    34.0       deg (level ships 52; azimuth is left alone)
skyLum          0.94       visible dome exposure relative to the probe
```

Live-read this session: `NZ.render.lightRig -> { key: 1.45, probe: 0.285 }`,
`NZ.render.params.exposure -> 0.95`. **Those are the current shipping values.**

Every intensity is in **one unit**: *"the diffuse albedo multiplier a white
surface FACING that source receives"* (`nz-render.js:268-274`). A daylight zone
must be authored in the same unit or it will not sit next to the night rig.

## 2.5 IBL — how `scene.environment` is made

**Procedural GLSL sky → CubeCamera → PMREM.** Not an HDR file, not a
`CubeTextureLoader`. `buildEnvironment()`, `nz-render.js:1626-1700`:

```js
var keyDir = lights.sunKey.position.clone().sub(lights.sunKey.target.position).normalize();
var uniforms = skyUniforms(keyDir);
var cubeRes = Math.min(EFF && EFF.envCube ? EFF.envCube : 256, caps.maxTex);
if (caps.hdr) uniforms.uGain.value = measureSkyGain(uniforms, defines);   // 64x32 readback
applySunDisc(uniforms, cubeRes, envMeanRadiance);
installSkyDome(uniforms);        // re-shades the game's own night dome
applyAtmosphere(uniforms);       // retints the fog
...
envCubeRT = new THREE.WebGLCubeRenderTarget(cubeRes, {
  format: THREE.RGBAFormat, type: THREE.HalfFloatType,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
var cubeCam = new THREE.CubeCamera(0.5, 40, envCubeRT);
cubeCam.update(renderer, tmp);                     // tmp = a 10-unit BackSide box
var pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileCubemapShader();
envRT = pmrem.fromCubemap(envCubeRT.texture);
pmrem.dispose();

scene.environment = envRT.texture;   /* background is left to the game */
```

* The **same GLSL (`SKY_FN`, `nz-render.js:1231-1313`) drives both the visible
  dome and the probe** — *"They cannot disagree, because they are the same
  GLSL."*
* **`measureSkyGain()`** (`:1467`) renders a 64×32 lat-long, reads it back as
  half-float, cosine-weights it and sets `uGain = P.envIrradiance / mean`
  (`:1512`). So the probe's mean radiance is **exactly `P.envIrradiance =
  0.285`** by construction. The solar disc is switched OFF during the
  measurement (`:1471`) and solved analytically afterwards.
* **Intensity:** there is no `scene.environmentIntensity` in r149.
  Every material is given `envMapIntensity = 1.0`
  (`nz-render.js:2101`, `:2153`). **The probe's strength is therefore
  entirely in `P.envIrradiance`, i.e. in the PMREM's own radiance values.**
  A single material can be brightened or darkened relative to the probe purely
  through `envMapIntensity` — that is the cheapest per-object handle in the
  whole engine.
* `envRT` is a `WebGLRenderTarget` held for the session; `rebuildEnvironment()`
  (`:4189`) kills and re-bakes it.

### Per-material environment override — verified in r149

Grepping `vendor/three.r149.min.js` yields `envMap||n.environment`, i.e.
`WebGLPrograms.getParameters` resolves

```
const envMap = cubeuvmaps.get( material.envMap || environment )
```

**So `material.envMap` takes precedence over `scene.environment` per material,
and r149 will happily accept a second PMREM texture on a subset of materials.**
This is the single most important fact for §3.

## 2.6 Shadows

* `renderer.shadowMap.enabled = true`, `type = THREE.PCFSoftShadowMap`
  (`nz-render.js:4106-4107`).
* **Exactly one caster: `lights.sunKey`** (`nz-render.js:1762`
  `S.castShadow = true`). The two bounce cards and the kicker are explicitly
  `castShadow = false` (`:1850`, `:1860`, `:1897`) — *"a shadowed kicker would
  carve a second sun-shaped shadow into every frame."*
* `applyShadowQuality()` (`:1927-1949`):

```js
S.shadow.mapSize.set(res, res);                   // res = EFF.shadow
c.left = -e; c.right = e; c.top = e; c.bottom = -e;   // e = EFF.extent
c.near = 1; c.far = SUN_DIST + e * 2.4;               // SUN_DIST = 128
var texelWorld = (2 * e) / res;
S.shadow.bias = -0.00012;
S.shadow.normalBias = Math.max(0.012, texelWorld * 1.45);
S.shadow.radius = 2;
```

* `followShadow()` (`:1953-1973`) puts the box `0.40 * extent` ahead of the
  camera, drops it 1.2 units and **snaps it to the shadow texel grid** in the
  sun's own basis so edges do not boil.
* PCSS replaces `getShadow()` wholesale by rewriting
  `THREE.ShaderChunk.shadowmap_pars_fragment` (`buildShadowChunk`, `:974-982`;
  `MAT_PCSS`, `:934-970`). 8-tap Vogel blocker search + 12-tap variable-radius
  PCF. Controlled by `uShadowP = (range/P.shadowSoftness, P.shadowSearch, 0.85,
  pcss?1:0)`, i.e. `P.shadowSoftness = 15.0` world units of gap to full
  penumbra, `P.shadowSearch = 3.4` texels max filter.
* `worldCast` (`upgradeMaterials`, `:2180-2184`) promotes every merged level
  mesh that already had `receiveShadow` and a colour attribute to
  `castShadow = true`, tracked in `worldCasters` and honoured by the degrade
  ladder via `setWorldCast()`.

### Cost of adding a second directional shadow-casting sun

Concrete, from this codebase:

* **A second shadow map.** At `high` that is another `2560²` `RGBA8` depth-pack
  target ≈ **26 MB** of VRAM, plus one extra full shadow pass over the ~13
  merged world meshes plus every enemy and prop. The header at `:153-156`
  already prices the *first* world-cast pass as "geometry-bound, not
  fill-bound"; a second one is the same bill again, paid every frame.
* **A second `followShadow()`**, or a static box big enough to cover the new
  area (which throws away the texel-size argument at `:123-133`).
* **The PCSS patch is written against exactly one shadow map.** `getShadow()`
  is a global override; a second directional light routes through the same
  function, so it gets PCSS too — with `uShadowP.x` derived from the *first*
  light's frustum range (`:1945-1947`). Penumbra scaling would be wrong on the
  second light.
* **It leaks.** `WebGLLights.setup()` in r149 accumulates every light in the
  scene into shared uniforms; there is **no per-object light filtering**
  (`Light.layers` is only tested against `camera.layers` when the light is
  *collected*, never against the lit object). A second sun lights the night half
  of the level too.

**Conclusion: do not add a second sun.** Overcast daylight has no hard sun
anyway — which is exactly what makes this the easy case. See §3.

## 2.7 Lights: `LIGHTS[]` vs real three lights

These are **two completely different things** and the names are confusingly
similar.

**Real lights** — four, created in `NUKEM.html:7945-7948`, published as
`NZ.ctx.lights`:

```js
const ambient = new THREE.AmbientLight(0xfff3df, .80);
const skyFill = new THREE.HemisphereLight(0x92bcff, 0x24150d, .27);
const sunKey  = new THREE.DirectionalLight(0xffd5a8, .62);
const coolRim = new THREE.DirectionalLight(0x628aff, .22);
```

`nz-render.js` rewrites all four in `applyLighting()` (`:1727-1788`) and adds
two of its own directly to the scene (`bounceB` at `:1858`, `kicker` at
`:1895`) — *"added to the scene rather than to NZ.ctx.lights (which is the
game's own record of its rig)"*. Post-rewrite:

| light | colour | intensity (with IBL) |
|---|---|---|
| `ambient` | `0xdfe9f5` | `P.ambientFloor = 0.035` |
| `skyFill` (hemi) | `0xcee2f8` / `0x7e7160` | **`0.0`** — off entirely while a probe exists |
| `sunKey` | `0xfff1dc` | `P.keyIntensity − sunDiscKeyOffset()` ≈ 1.45 − ~0.39 |
| `coolRim` → bounce A | `0xd8cfc0` | `P.bounceIntensity * 0.5 = 0.25`, aimed +130° |
| `nz:bounce-b` | `0xd8cfc0` | `0.25`, aimed −130° |
| `nz:sky-kicker` | `0xd6e4f6` | `P.kickerIntensity = 0.26`, anti-key azimuth, 52° up |

**Vertex-baked colour** — the `LIGHTS` array is *not* lights.
`NUKEM.html:2495-2499`:

```js
const LIGHTS = [];
function light(x, y, z, col, rad, inten) {
  LIGHTS.push({ x: x*CELL + CELL/2, y: z, z: y*CELL + CELL/2, c: col, r: rad, i: inten === undefined ? 1 : inten });
}
```

consumed only by `lightAt()` (`NUKEM.html:2886-2903`) during `buildWorld()`:
per-region ambient `R.amb` (0.06 .. 0.24, `NUKEM.html:2605-2650`) plus
`(1 - d/r)²` falloff × wrapped N·L (`0.28 + 0.72*nd`) × `L.i`, gated by
`losGrid()`, **clamped to 1.45**. `quad3()` (`:2915`) writes the result into the
`color` attribute; `makeWorldMaterial()` (`:3001`) sets `vertexColors: true`.
So **the night light solution is a multiplier on albedo, burned into geometry.**

`nz-render.js` then compresses it — `neutralizeBakedLighting()`, `:2293`, run at
`ready` priority −1000 — through `bakeCurve()` (`:2256`):

```js
var BAKE = { ref: 0.90, gamma: 0.68, shoulder: 0.70, head: 0.30,
             weight: 1.00, tint: 0.55, lo: 0.15, hi: 1.35 };
```

Only materials whose name starts with **`world:` or `nzenv:`** are touched
(`bakedMatName`, `:2282-2288`), `lens` and any `MeshBasicMaterial` excepted
(`:2306`). Dynamic range goes 20.7:1 → 6.3:1.

**This is the escape hatch a daylight module needs: name your materials
anything else and your vertex colours are left exactly as you wrote them.**

## 2.8 The shader patch, and how to compose with it

`installShaderPatch()` (`:1074`) replaces **`THREE.Material.prototype.onBeforeCompile`**
and `customProgramCacheKey`. Every lit material in the scene therefore gets
`nzAoTex`, `nzSsrTex`, `nzAoP`, `nzSsrP`, `nzShadowP`, `nzInvRes` and the
PCSS `getShadow()` for free — **unless** the material has an own-property
`onBeforeCompile`, which shadows the prototype.

`nz-env.js` hit exactly that bug and its fix is the template (`nz-env.js:1671-1685`):

```js
/* ---- CHAIN, do not replace ------------------------------------------ */
var proto = THREE.Material.prototype.onBeforeCompile;
if (typeof proto === 'function' && proto !== nzEnvPatch) {
  try { proto.call(this, shader, rendererArg); DIAG.chained++; }
  catch (e) { DIAG.chainErr = String(e && e.message || e); }
}
```

and from the other side `nz-render.js` sweeps foreign hooks up to 6 times
(`wrapForeignMaterials`, `:1041`; `wrapSweeps = 6`, re-run every 40 frames at
`:3534`), memoising one wrapper per inner function so program sharing survives
(`wrapOnBeforeCompile`, `:1025`). The injection is idempotent, guarded by
`MAT_MARK = '/*NZ_MAT_PATCH*/'` (`:872`, tested at `:993`).

**Varyings already available on every world material** (nz-env's `VERT_HEAD`,
`nz-env.js:1581-1588` + `:1706-1710`):

```glsl
varying vec3 vNzWP;   // world position   = (modelMatrix * vec4(transformed,1)).xyz
varying vec3 vNzWN;   // world normal     = normalize(mat3(modelMatrix) * objectNormal)
varying vec3 vNzFC;   // (floorY, ceilY, distance to nearest wall)
```

**`vNzWP` is exactly the world-space coordinate a daylight-zone mask needs, and
it is already there on every surface nz-env owns.**

Anchors nz-env uses (`:1654`, `:1662`), all of which are still free after it:

```
vertex:   #include <beginnormal_vertex>, #include <begin_vertex>
fragment: #include <color_fragment>, #include <roughnessmap_fragment>,
          #include <metalnessmap_fragment>, #include <lights_fragment_end>
```

nz-render splices at `#include <common>` and **prepends** at
`#include <lights_fragment_end>`; nz-env **appends** at `<color_fragment>`,
`<roughnessmap_fragment>`, `<metalnessmap_fragment>` and **prepends** at
`<lights_fragment_end>`. A third module can still append at
`<lights_fragment_end>` or splice at `<output_fragment>` without collision, but
must use a **distinct identifier prefix** — everything named `nz*` in the
fragment scope is taken twice over.

And the non-negotiable safety net, `nz-env.js:1597-1650`: **compile your
injected GLSL standalone against the real GL context before it reaches a
material.** *"A GLSL error inside onBeforeCompile does not throw — it just
silently renders black."*

---

# 3. THE DAYLIGHT PROBLEM

## 3.0 What "one region reads as overcast daylight" has to beat

Five things carry "night" in this engine, and all five must be answered:

| carrier | where it lives | global? |
|---|---|---|
| **1. vertex-baked night lighting** | `geometry.attributes.color`, written by `lightAt()`, remapped by `bakeCurve()` | **per-vertex** — the one thing that is already local |
| **2. `scene.environment`** (PMREM of the night-ish graded sky) | `nz-render.js:1690` | **global**, but overridable per material via `material.envMap` |
| **3. the light rig** (key + 2 bounce cards + kicker + 0.035 ambient) | scene lights | **global, unavoidably** — r149 has no per-object light filtering |
| **4. fog** `Fog(#bab8ae, 70, 520)` | `scene.fog` | **global**, one object, no per-object override except `material.fog = false` |
| **5. the sky dome** | one `BackSide` sphere r=460, re-shaded by nz-render | **global**, but *visibility* is local — it is only seen where a region has `sky: true` |

## 3.1 Strategy (a) — swap `scene.environment` per frame on player position

**What it touches:** `scene.environment` only, from a `render` hook returning
`undefined`.

**Can it live in a new module?** Yes, trivially, ~30 lines.

**Interaction with the rest:**
* No recompile cost — both textures are PMREM `CubeUVReflectionMapping`, so
  `WebGLPrograms`' cache key does not change.
* Fog, tone mapping, the light rig and the vertex bake are all untouched, i.e.
  all still say "night".

**Why it fails:** it is a **hard global switch with no spatial gradient.** The
instant the player crosses the threshold, *every pixel in the frame* flips —
including the night corridor visible behind them through the passage they just
walked out of. There is exactly one `scene.environment` and no way to blend
between two. A hysteresis band or a cross-fade only smears the pop in time; it
cannot make the two halves of a single frame correct simultaneously.

**Verdict: reject as a strategy.** It is however a *useful component* if
inverted — see §3.6, where the day materials get their own `envMap` and
`scene.environment` never changes at all.

## 3.2 Strategy (b) — `onBeforeCompile` world-space daylight blend on every material

**What it touches:** the fragment shader of every lit material you want to
participate. Requires chaining two existing hooks (§2.8).

**Can it live in a new module?** Yes — and this is exactly the mechanism
`nz-env.js` already uses on 16 world materials, so there is a working template
in the tree.

**Interaction:**
* `scene.environment` — untouched. You add an **analytic** hemisphere term to
  `irradiance` / `iblIrradiance` at `<lights_fragment_end>`, gated on the mask.
  No second probe needed.
* Vertex bake — you can neutralise it *per fragment*: after `<color_fragment>`
  the baked colour is already multiplied into `diffuseColor.rgb`. Dividing it
  back out is not possible (the value is gone), but you can **re-normalise**:
  `diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (uDayRef / max(vColorLuma, 0.05)), day)`
  if you also pass the raw vertex colour through as a varying. Cleanest is to
  inject at `<color_fragment>` and capture `vColor` before it is consumed.
* Fog — unaffected; must be handled separately (§3.4).
* Tone mapping — unaffected. Good: the day zone gets the same curve as
  everything else, which is what you want.

**Cost / risk:**
* One more layer on a chain that already has two, and `nz-render.js`'s
  `wrapForeignMaterials()` will wrap *your* hook, so the effective call order
  becomes `yours → nz-env's → nz-render's` (idempotent, guarded by `MAT_MARK`).
* A GLSL slip blacks the level silently. Mitigate with nz-env's
  `validateGLSL()` probe.
* `customProgramCacheKey` is `nzCacheKey()` (`:1067`) which stringifies the
  hook, so a *new* hook function = a new program variant. Keep it to **one**
  shared function so you add one program, not sixteen.

**Verdict: the only mechanism that can produce a smooth spatial blend across a
mesh that spans both zones.** Keep it, but scope it to the *transition
surfaces*, not to the whole level.

## 3.3 Strategy (c) — bake daylight into the new area's vertex colours + local lights

**Vertex colours: yes, and this is the cheapest, most robust half of the
answer.** If the new module builds the new area's geometry, it writes the
`color` attribute itself. And there is a documented escape hatch:
`neutralizeBakedLighting()` only remaps materials named `world:*` or `nzenv:*`
(`nz-render.js:2282-2288`). **Name your materials `nzday:*` and your vertex
colours are never touched.** For an overcast sky you want a gentle sky-occlusion
gradient — bright on up-facing and open surfaces, falling to ~0.55 deep under an
overhang — around a reference of ~1.0, not the 0.10–0.24 the night regions bake.

**Local hemisphere + directional light: no — it is not possible in r149.**
`WebGLLights.setup()` accumulates every scene light into shared uniforms;
`Light.layers` is only consulted against `camera.layers` when the light is
collected. **There is no "influence radius" for `DirectionalLight` or
`HemisphereLight` in three.js, and no per-object light masking in the forward
path.** The only distance-limited light r149 has is `PointLight.distance`
(and `SpotLight.distance`), whose `1/r²` shape is the wrong model for a sky and
which would cost a real light slot in every shader in the game.

So: **substitute `material.envMap` for the hemisphere light.** Build a second
PMREM from an overcast sky function and assign it to the day materials.
Verified in r149 (§2.5): `material.envMap || scene.environment`. This gives you
a true, prefiltered, roughness-correct sky on exactly the surfaces you choose,
with **zero effect on any other object, zero new lights, zero shadow cost, and
no recompile** (both are `CubeUVReflectionMapping`, so the program is shared).

**Verdict: the strong half. Keep the vertex bake and the per-material `envMap`;
drop the "limited influence radius" lights — they do not exist.**

## 3.4 Strategy (d) — per-region fog / exposure ramp

**Fog: mandatory, not optional.** `scene.fog` is one `THREE.Fog` object and its
`color/near/far` are uploaded per frame as plain uniforms — no recompile. A
module can lerp them from the camera's position every frame:

```js
NZ.on('render', function (dt) {
  var f = scene.fog; if (!f) return undefined;
  var d = dayMask(camera.position);              // 0..1
  f.color.copy(NIGHT_FOG).lerp(DAY_FOG, d);
  f.near = NZ.math.lerp(70, 26, d);
  f.far  = NZ.math.lerp(520, 190, d);
  return undefined;                              // never claim the render hook
});
```

Caveats:
* `nz-render.js` writes fog exactly once, in `applyAtmosphere()`
  (`:1591-1613`), called from `buildEnvironment()` at `ready` and again from
  `rebuildEnvironment()`. It does **not** touch fog per frame, so a per-frame
  writer will not fight it — but it saves the *pre-nz-render* values in
  `fogSaved` for `panic()`, so save your own baseline **after** `ready`.
* Fog is a **camera-position** ramp, not a per-fragment one. That is
  acceptable — it is exactly how every shipped game does area fog — but it
  means the transition is only smooth if the mask is smooth (use
  `NZ.math.damp`, not a step).

**Exposure: technically live, but do not use it as the main lever.**
`nz-render.js:3730` reads `P.exposure` fresh every frame and `P` is exposed as
`NZ.render.params`, so `NZ.render.params.exposure = x` takes effect on the next
frame with no recompile. **But** the module's own comment at `:176-180` is
explicit: *"Deliberately NOT auto-exposure. This is a competitive shooter … CS2
has no eye adaptation either."* And exposure is global: ramping it also moves
the night geometry in the same frame. **Budget ≤ 0.25 stop
(`exposure *= 0.84..1.19`) as a finishing touch only**, ramped on the same
smooth camera mask, and never more.

**Verdict: fog ramp = required component. Exposure ramp = optional garnish,
tightly capped.**

## 3.5 Ranking

| rank | strategy | new module only? | blend quality | risk | verdict |
|---|---|---|---|---|---|
| **1** | **(c′) per-material `envMap` + `envMapIntensity` + day vertex bake, materials named `nzday:*`** | **yes** | perfect *within* the zone, hard at the mesh boundary | **low** | **core of the answer** |
| **2** | **(d) fog ramp on camera position** | **yes** | smooth in time and depth | **low** | **required glue** |
| **3** | **(b) shader injection with a `vNzWP` mask** | yes | **the only true spatial gradient** | medium (GLSL) | **use on transition surfaces only** |
| 4 | second sky card / dome for the zone | yes | perfect | low | required if the sky is visible from the zone |
| 5 | (d′) exposure ramp | yes | global — moves the night too | low | ≤0.25 stop, garnish |
| 6 | (a) swap `scene.environment` per frame | yes | **binary, pops** | low | **reject** |
| 7 | (c″) second sun / hemisphere with a radius | yes | — | **high** | **impossible in r149** — no per-object light filtering |

## 3.6 RECOMMENDATION

**Build the daylight zone as a self-lit island: give its own geometry its own
PMREM `envMap`, its own daylight vertex bake under a material-name prefix
`nz-render` will not remap, and its own bright overcast sky card. Ramp only the
fog on camera position. Add no lights at all, and use one small
`onBeforeCompile` injection with a world-space mask solely on the handful of
surfaces that physically span the passage.**

Why this and not the others:

1. **Overcast has no sun.** That removes the single hardest requirement — a
   second shadow-casting directional — and turns the whole problem into "give
   these surfaces a different, brighter, achromatic environment", which r149
   supports natively per material.
2. **The existing light rig is nearly harmless in the day zone anyway.** With a
   probe present, `skyFill` is 0.0 and `ambient` is 0.035; the key
   (1.45, warm, 34° elevation) and the two 0.25 bounce cards are the only
   directional terms. If the day zone's own environment carries ~1.0–1.4 of
   albedo multiplier, the night key becomes a 20–30% modulation on top — which
   reads as *"the sun is somewhere behind that cloud deck"*, not as a bug. If it
   still reads warm, cancel it per fragment in the (b) injection rather than by
   touching the global rig.
3. **`scene.environment` is never touched**, so nothing else in the level moves,
   nothing recompiles, and `nz-render.panic()` still hands the level back
   correctly.
4. **Everything lives in one new file** and can be torn down completely, which is
   the house rule (§5).

### Key code sketch

```js
/* nz-day.js -- daylight zone. Owns this file and nothing else. */
(function (global) {
  'use strict';
  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;
  if (NZ.flags && NZ.flags.day === undefined) NZ.flags.day = false;
  if (/[?&]nzday=(0|off)/i.test(global.location ? global.location.search : '')) {
    NZ.log && NZ.log('daylight zone disabled by query string'); return;
  }

  var THREE = null, scene = null, renderer = null, camera = null;
  var dead = false;
  var OWN = { tex: [], mat: [], geo: [], obj: [], restore: [] };

  /* ---- the zone, in world units. Keep it as an AABB + a feather. -------- */
  var ZONE = { min: null, max: null, feather: 9.0 };   /* set in install() */
  var fogSaved = null;

  /* 0..1 daylight weight for a world point. Same function in JS and GLSL --
     if they disagree the fog and the shading part company at the doorway. */
  function dayMask(p) {
    var dx = Math.max(ZONE.min.x - p.x, 0, p.x - ZONE.max.x);
    var dy = Math.max(ZONE.min.y - p.y, 0, p.y - ZONE.max.y);
    var dz = Math.max(ZONE.min.z - p.z, 0, p.z - ZONE.max.z);
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return NZ.math.smoothstep(1.0 - d / ZONE.feather);
  }

  /* ====================================================================== */
  /*  1. the overcast probe -- ONE PMREM, ours, never scene.environment      */
  /* ====================================================================== */
  /* Flat white sky, no sun, slight zenith->horizon fall, cool-neutral grey
     ground bounce. Same construction as nz-render buildEnvironment(), but the
     result is assigned to material.envMap, which r149 resolves ahead of
     scene.environment (`material.envMap || scene.environment`). */
  var dayEnvRT = null;
  function buildDayProbe() {
    var res = 256;                                  /* follow the tier: */
    var q = NZ.render && NZ.render.effects;         /* EFF.envCube = 512 hi, 256 med/low */
    if (q && q.envCube) res = Math.min(q.envCube, NZ.render.caps.maxTex);

    var frag = [
      'varying vec3 vDir;',
      'uniform vec3 uZen, uHor, uGnd;',
      'uniform float uGain;',
      'void main(){',
      '  vec3 d = normalize(vDir);',
      '  float up = d.y;',
      /* overcast: luminance rises toward the zenith but only ~1.6:1, and the
         hue is dead neutral. A blue gradient here is the #1 tell that a
         "cloudy" sky was authored from a clear-sky model. */
      '  vec3 c = mix(uHor, uZen, pow(clamp(up,0.0,1.0), 0.60));',
      '  vec3 g = uGnd * (0.66 + 0.34 * (1.0 - clamp(-up,0.0,1.0)));',
      '  c = mix(c, g, smoothstep(-0.02, 0.36, clamp(-up,0.0,1.0)));',
      '  gl_FragColor = vec4(c * uGain, 1.0);',
      '}'
    ].join('\n');

    var uni = {
      uZen: { value: srgb(0xd9dcdf) },   /* neutral, only 1.6x the horizon */
      uHor: { value: srgb(0xc2c6c9) },
      uGnd: { value: srgb(0x8d8f90) },   /* wet-ish concrete, achromatic     */
      uGain: { value: 1.0 }
    };
    /* Normalise the SAME WAY nz-render does, so the two probes are in one
       unit: mean radiance = the albedo multiplier a white surface receives.
       Target ~4.5x the night probe: 0.285 -> ~1.30 reads as flat daylight
       without asking the tone curve for anything it cannot give. */
    uni.uGain.value = DAY_IRRADIANCE / measureMean(frag, uni);   /* DAY_IRRADIANCE = 1.30 */

    var cubeRT = new THREE.WebGLCubeRenderTarget(res, {
      format: THREE.RGBAFormat, type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    if (THREE.LinearEncoding !== undefined) cubeRT.texture.encoding = THREE.LinearEncoding;

    var box = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: 'varying vec3 vDir;\nvoid main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: frag, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false }));
    box.frustumCulled = false;
    var tmp = new THREE.Scene(); tmp.add(box);

    var prev = renderer.getRenderTarget();
    new THREE.CubeCamera(0.5, 40, cubeRT).update(renderer, tmp);
    renderer.setRenderTarget(prev);

    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    dayEnvRT = pmrem.fromCubemap(cubeRT.texture);
    pmrem.dispose();
    cubeRT.dispose();
    box.geometry.dispose(); box.material.dispose();
    return dayEnvRT.texture;
  }

  /* ====================================================================== */
  /*  2. the zone's own materials                                           */
  /* ====================================================================== */
  function dayMaterial(name, maps) {
    var m = new THREE.MeshStandardMaterial({
      map: maps.map, normalMap: maps.normalMap,
      aoMap: maps.orm, roughnessMap: maps.orm, metalnessMap: maps.orm,
      roughness: 1.0, metalness: 1.0,
      vertexColors: true, fog: true, dithering: true
    });
    /* THE WHOLE TRICK: a private probe on this material only. */
    m.envMap = dayEnvRT.texture;
    m.envMapIntensity = 1.0;
    /* NOT 'world:' and NOT 'nzenv:' -- nz-render.js:2282 bakedMatName()
       returns null for anything else, so neutralizeBakedLighting() leaves our
       daylight vertex colours exactly as we wrote them. */
    m.name = 'nzday:' + name;
    OWN.mat.push(m);
    return m;
  }

  /* Daylight vertex bake, written straight into the colour attribute. Ref 1.0
     instead of the night regions' 0.06..0.24, sky-occlusion shaped rather than
     lamp shaped: open sky = 1.05, under an overhang = 0.55, deep recess = 0.38. */
  function bakeDaylightVertexColours(geo, skyVis /* fn(x,y,z,nx,ny,nz)->0..1 */) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var col = new Float32Array(pos.count * 3);
    for (var i = 0; i < pos.count; i++) {
      var v = 0.38 + 0.67 * skyVis(pos.getX(i), pos.getY(i), pos.getZ(i),
                                   nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      /* dead neutral: an overcast sky has no hue to give */
      col[i*3] = col[i*3+1] = col[i*3+2] = v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv2', geo.attributes.uv);      /* r149 aoMap reads uv2 */
    return geo;
  }

  /* ====================================================================== */
  /*  3. the transition surfaces -- the ONLY place a shader touch is needed  */
  /* ====================================================================== */
  /* A wall that runs from the night corridor out into the daylight cannot be
     two materials, so it gets one injection with a world-space mask. vNzWP is
     ALREADY a varying on every nz-env world material (nz-env.js:1581,1706-1710),
     so we only have to declare it if it is missing. CHAIN, never replace. */
  var INJ_UNIFORMS = [
    '/*NZ_DAY*/',
    'uniform vec4 uDayMin;',    /* xyz = zone min,  w = feather   */
    'uniform vec4 uDayMax;',    /* xyz = zone max,  w = strength  */
    'uniform vec3 uDaySky;',    /* overcast irradiance, linear    */
    'uniform vec3 uDayGnd;',
    'float nzDayMask(vec3 p){',
    '  vec3 d = max(max(uDayMin.xyz - p, vec3(0.0)), p - uDayMax.xyz);',
    '  float t = 1.0 - length(d) / max(uDayMin.w, 1e-3);',
    '  t = clamp(t, 0.0, 1.0);',
    '  return t * t * (3.0 - 2.0 * t) * uDayMax.w;',
    '}'
  ].join('\n');

  /* Injected AFTER nz-env's contact AO and BEFORE lights_fragment_end, so it
     sees the final irradiance and can add a hemisphere term to it. */
  var INJ_LIGHT = [
    '{',
    '  float nzDay = nzDayMask(vNzWP);',
    '  if (nzDay > 0.001) {',
    /* 1. kill the night vertex bake's contribution as we cross over: the bake
          is already inside diffuseColor, so re-normalise toward daylight. */
    '    float nzBakeL = dot(vColor.rgb, vec3(0.2126,0.7152,0.0722));',
    '    diffuseColor.rgb *= mix(1.0, 1.0 / max(nzBakeL, 0.10), nzDay);',
    /* 2. analytic overcast hemisphere -- no second probe needed on these few
          surfaces, and no light in the scene, so nothing leaks into the night. */
    '    vec3 nzHemi = mix(uDayGnd, uDaySky, vNzWN.y * 0.5 + 0.5);',
    '    irradiance    += nzHemi * nzDay;',
    '    #if defined( RE_IndirectDiffuse )',
    '    iblIrradiance += nzHemi * nzDay * 0.35;',
    '    #endif',
    '  }',
    '}'
  ].join('\n');

  function dayPatch(shader, r) {
    var proto = THREE.Material.prototype.onBeforeCompile;      /* nz-render's */
    if (typeof proto === 'function' && proto !== dayPatch) {
      try { proto.call(this, shader, r); } catch (e) {}
    }
    var inner = this.__nzDayInner;                             /* nz-env's, if any */
    if (typeof inner === 'function') { try { inner.call(this, shader, r); } catch (e) {} }

    var f = shader.fragmentShader, v = shader.vertexShader;
    if (f.indexOf('/*NZ_DAY*/') >= 0) return;                  /* idempotent */
    if (f.indexOf('#include <lights_fragment_end>') < 0) return;
    if (f.indexOf('varying vec3 vNzWP;') < 0) {                /* nz-env absent */
      v = v.replace(/void\s+main\s*\(\s*\)\s*\{/, 'varying vec3 vNzWP;\nvarying vec3 vNzWN;\nvoid main() {')
           .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vNzWN = normalize(mat3(modelMatrix) * objectNormal);')
           .replace('#include <begin_vertex>',       '#include <begin_vertex>\n  vNzWP = (modelMatrix * vec4(transformed,1.0)).xyz;');
      f = f.replace(/void\s+main\s*\(\s*\)\s*\{/, 'varying vec3 vNzWP;\nvarying vec3 vNzWN;\nvoid main() {');
      shader.vertexShader = v;
    }
    f = f.replace('#include <common>', INJ_UNIFORMS + '\n#include <common>');
    f = f.replace('#include <lights_fragment_end>', INJ_LIGHT + '\n#include <lights_fragment_end>');
    shader.fragmentShader = f;
    shader.uniforms.uDayMin = U.min;      /* SHARED uniform objects, so one   */
    shader.uniforms.uDayMax = U.max;      /* write updates every material     */
    shader.uniforms.uDaySky = U.sky;
    shader.uniforms.uDayGnd = U.gnd;
  }
  /* One function object for every material -> nz-render's nzCacheKey()
     (:1067) yields ONE extra program variant, not one per surface. */

  /* ====================================================================== */
  /*  4. fog ramp -- camera position, frame-rate independent                */
  /* ====================================================================== */
  var fogW = 0;
  NZ.on('render', function (dt) {
    if (dead || !scene || !scene.fog) return undefined;
    var target = dayMask(camera.position);
    /* NZ.math.damp: 'fraction remaining after one second'. 0.02 = ~0.25 s to
       within 1%. A raw lerp here changes speed with the tier. */
    fogW = NZ.math.damp(fogW, target, 0.02, dt || 0.016);
    scene.fog.color.copy(FOG_NIGHT).lerp(FOG_DAY, fogW);
    scene.fog.near = NZ.math.lerp(fogSaved.near, DAY_FOG_NEAR, fogW);
    scene.fog.far  = NZ.math.lerp(fogSaved.far,  DAY_FOG_FAR,  fogW);
    return undefined;                         /* MUST return undefined:      */
  });                                         /* 'render' is a first() hook   */

  /* ====================================================================== */
  /*  5. install / teardown                                                 */
  /* ====================================================================== */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try {
      THREE = ctx.THREE || global.THREE;
      scene = ctx.scene; renderer = ctx.renderer; camera = ctx.camera;
      if (!validateGLSL()) throw new Error('daylight GLSL probe failed');
      buildDayProbe();
      buildZoneGeometry();          /* your new area */
      patchTransitionSurfaces();    /* the handful of meshes that span the door */
      fogSaved = { color: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far };
      NZ.flags.day = true;
      NZ.day = { stats: STATS, dispose: function () { panic('manual dispose'); } };
    } catch (err) { panic(err); }
  }, -100);   /* AFTER nz-env (-20), BEFORE nz-render's late sweep (-1000) */

})(typeof window !== 'undefined' ? window : this);
```

Two ordering facts this sketch depends on, both verified:

* `ready` at **−100** runs after `nz-env` (−20) so the world materials exist,
  and before `nz-render`'s −1000 sweep, so `wrapForeignMaterials()` will see
  and wrap our hook and `neutralizeBakedLighting()` runs after our geometry
  is in the scene (and skips it, because of the `nzday:` name).
* The `render` hook is `NZ.first`, so **returning anything other than
  `undefined` steals the frame from `nz-render`.** Always `return undefined`.

### Calibrating the day zone against the night rig

Everything is in one unit — *albedo multiplier on a white surface facing the
source*. Night: probe 0.285 + key 1.45 (direct, 34° elevation) + bounce 0.50 +
kicker 0.26 + ambient 0.035. A flat overcast exterior wants a **single
omnidirectional term around 1.1–1.4** and essentially nothing else, so:

```
DAY_IRRADIANCE  1.30      probe mean radiance for the day PMREM
                          (=4.6x the night probe; ~2.2 stops brighter)
day vertex bake 0.38 .. 1.05   sky occlusion, achromatic, ref 1.0
FOG_DAY         #c6cacd   near-neutral, slightly cool; ~0.62 linear
DAY_FOG_NEAR    26        much nearer than night's 70: overcast air is dense
DAY_FOG_FAR     190       and it closes down fast -- that IS the overcast read
```

Check it the way the rest of the project checks light: put an 18% card in the
zone and read it back. Anything landing near **117–127/255** matches the
calibrated stage (`CRITIC-REPORT.md` table). If it clips, lower
`DAY_IRRADIANCE`, **not** the exposure.

---

# 4. Fog and sky

## 4.1 Fog

**Authored** (`NUKEM.html:7941-7942`):

```js
scene.background = new THREE.Color(0x01030a);
scene.fog = new THREE.Fog(0x01040b, 52, 338);
```

**Rewritten** by `applyAtmosphere()` at `ready` (`nz-render.js:1591-1613`):

```js
var horizon = uniforms.uHorizon.value, haze = uniforms.uHaze.value;
var gain = uniforms.uGain.value * P.skyLum;
tmpCol.setRGB((horizon.r*0.55 + haze.r*0.45) * gain,
              (horizon.g*0.55 + haze.g*0.45) * gain,
              (horizon.b*0.55 + haze.b*0.45) * gain);
scene.fog.color.copy(tmpCol);
if (scene.fog.near !== undefined) { scene.fog.near = 70; scene.fog.far = 520; }
if (scene.background && scene.background.isColor) scene.background.copy(tmpCol);
```

**Measured live this session** (§6.4): `fog: ["bab8ae", 70, 520]`.

* **Linear `THREE.Fog`, not `FogExp2`.** `near = 70`, `far = 520`, colour
  `#bab8ae` — a warm-neutral grey, the level's horizon+haze mix.
* **Global.** three has no per-object fog *value*; the only per-material control
  is `material.fog = false`, which removes fog entirely from that material
  (the sky dome uses this: `NUKEM.html:3149`, and `nz-render.js:1557`).
* `scene.background` is a `Color` and is copied to the same value — insurance
  only; the dome covers every sky pixel.

**What a daylight zone must do about fog:** ramp `color/near/far` on the
camera's smoothed zone weight (§3.4). This is safe — `nz-render` writes fog
once at `ready` and again only on `rebuildEnvironment()`. Two rules:

1. **Snapshot the post-`ready` values, not the authored ones.** Take your
   baseline inside your own `ready` listener at priority −100, i.e. after
   `nz-render`'s priority-0 `ready`.
2. **Ramp on the same mask as the shading, and smooth it with `NZ.math.damp`.**
   If the fog crossfades over 0.25 s while the shading is a hard geometric
   boundary, the passage will read as a colour-grade cut. Make the fog's
   feather *wider* than the geometry's: start the ramp ~9 units before the
   doorway on both sides so the player is already in day-tinted air when the
   first daylit surface enters the frame. That is what makes a connecting
   passage read as a passage rather than as a loading boundary.
3. Because fog `far` also compresses distance contrast, dropping it from 520 to
   ~190 is doing a lot of the "flat overcast" work for free. Do not fight it
   with exposure.

## 4.2 Sky

**Built** by `makeSky()` (`NUKEM.html:3146-3154`):

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

`skyMesh.position` is carried with the player every frame in `updatePlayer()`
(`nz-shots.js:629-632` has to re-do this by hand when the sim is frozen).

**Replaced** by `installSkyDome()` (`nz-render.js:1529-1571`). `findSkyMesh()`
(`:1442-1451`) identifies it by duck-typing:

```js
if (m.isMeshBasicMaterial && m.side === THREE.BackSide && m.fog === false && m.map) found = o;
```

and swaps in a `ShaderMaterial` running `nzSky()` × `uDomeGain` (`P.skyLum =
0.94`), clamped to 26.0 so the sun disc does not become a TAA firefly.
`mesh.userData.nzNoGBuffer = true` keeps 460 units of fake geometry out of the
prepass.

**Where is the sky actually visible?** Only where a region declares
`sky: true` — `rStreet`, `rAlley`, `rGallery`, `rFire[]`, `rRoofStep[]`,
`rRoof`, `rShB`, `rShC` (`NUKEM.html:2605-2646`). `buildWorld()` skips the
ceiling quad for those cells (`NUKEM.html:2949`: `if (!R.sky)`). Everywhere
else the sky is fully occluded by geometry.

### Can a second sky be shown from inside one region? — Yes, three ways

1. **Best: a local sky card, not a dome.** Because the sky is only visible
   through the ceiling opening of a `sky: true` region, you do not need a
   sphere at all. Put a horizontal `PlaneGeometry` (or a shallow shell) a few
   units above the new area's opening, sized to over-cover it, with
   `side: THREE.DoubleSide`, `fog: false`, `toneMapped: false`,
   `depthWrite: false`, and a `renderOrder` above the world (`0`) but below
   nothing else. The surrounding walls occlude it from every other region for
   free — this is exactly how a real level ships a second skybox, and it costs
   **one draw call and zero shader work**. The card runs the same overcast
   GLSL as the day probe, so the visible sky and the probe agree by
   construction (`nz-render.js:1223` makes the same argument).
2. **A second `BackSide` dome at a smaller radius** (say 120) centred on the
   zone, `depthWrite: false`, `renderOrder: -1`. Works, but it is visible from
   anywhere with line of sight to the zone's airspace, so it needs the same
   occlusion argument as (1) and buys nothing over it.
3. **Do not** try to swap `skyMesh.material` per frame — `nz-render` owns that
   material and `restoreSkyDome()` (`:1573`) expects it to be the one it
   installed.

**Getting the transition right:** the day card must be visible *before* the
player is fully in the zone (through the doorway), which is automatic if it is
geometry. The fog ramp is what stops it looking pasted on: at `fogW = 0.5` in
the passage, the day card is half-veiled by the ramping fog colour — except it
is `fog: false`, so **give the card its own manual fade** in the shader against
the same `uDayMask` uniform, or accept a hard-edged sky through the doorway
(usually fine and more readable).

---

# 5. Constraints checklist for a new module

## 5.1 The wrapper

```js
(function (global) {
  'use strict';
  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }              // nz-env.js:71-72 -- silent
  // or, if you want to be loud:  console.warn('[nz-day] nz-core.js missing, module inert');
  ...
})(typeof window !== 'undefined' ? window : this);
```

Classic script. `var`, not `const`/`let`, in the module scope if you match the
house style (`nz-render.js`, `nz-env.js`, `nz-weapons.js` all use `var`;
`nz-core.js` and `NUKEM.html` use `const`/`let`). **No `import`, no `export`,
no build step, no bundler** (`CS2-BRIEF.md:50`).

## 5.2 try/catch teardown + `NZ.flags`

Every module has the same shape:

* an `OWN` ledger of everything created (`nz-env.js:83-92`:
  `{ tex, mat, geo, obj, restore, timer }`),
* `panic(err)` that sets `dead = true`, sets `NZ.flags.<me> = false` **first**,
  restores everything, and never throws
  (`nz-env.js:3476-3527`, `nz-render.js:3994-4059`),
* `NZ.<me>.dispose = function () { panic('manual dispose'); }`,
* **every hook body wrapped**: `try { ... } catch (err) { panic(err); }`.

`nz-render.js`'s `panic()` is the reference for how much state must be handed
back: render target, `autoClear`, `shadowMap.autoUpdate`, `toneMapping`,
`toneMappingExposure`, `scene.environment = null`, sky dome, fog + background,
vertex bake, shader patch, colour-management flag, all six light intensities
and both saved light transforms, `worldCasters`, and every RT/material/geometry.

`nz-env.js` adds one discipline worth copying (`nz-env.js:3485-3492`):
**nothing original is ever disposed**; the originals sit in `OWN.restore` so
teardown really does hand the stock level back.

## 5.3 Query-string opt-out convention

| module | pattern | line |
|---|---|---|
| core debug | `?nzdebug=1` | `nz-core.js:29` |
| diagnostics overlay | `?nzdiag=1` | `NUKEM.html:258`, `nz-render.js:4072`, `nz-env.js:3412` |
| render tier pin | `?nzq=low\|med\|high\|ultra` | `nz-render.js:723` |
| colour management off | `?nzcm=0` | `nz-render.js:4080` |
| env module off / tier | `?nzenv=0\|off\|low\|med\|high` | `nz-env.js:76` |
| look-param overrides | `?nzkey= ?nzenv= ?nzlight=k:v,k:v` | `nz-render.js:749-751` |
| shots harness arm | `?shot=<scene>` or `window.NZ_SHOT` | `NUKEM.html:343`, `nz-shots.js:87` |

**Convention: `?nz<module>=0` must make your file a complete no-op, checked
before you touch anything.** Copy `nz-env.js:75-78` verbatim in shape:

```js
var QS = /[?&]nzday=(0|off|low|med|high)/i.exec(global.location ? global.location.search : '') || null;
if (QS && /^(0|off)$/i.test(QS[1])) { NZ.log && NZ.log('day disabled by query string'); return; }
```

Note the guards: `global.location ? ... : ''` and `NZ.log &&` — both modules
are written to survive being loaded in a bare VM
(`scripts/validate-level.mjs` does exactly that).

## 5.4 "One agent one file" — `CS2-BRIEF.md:46-49`

> 1. **One agent owns one file.** Do not edit a file you were not assigned.
>    Do not edit `nz-core.js` — request core changes from the orchestrator.
>    Do not edit `NUKEM.html` — the orchestrator owns it. Reach the level by
>    traversing `NZ.ctx.scene` on the `ready` hook.

`nz-shots.js:44` states its own boundary: *"Owns: nz-shots.js, \_shot\_\*.html.
Edits nothing else."* `scripts/render-critic.mjs:20`: *"Owned by the CRITIC-RIG
agent (this file + \_critic\_operators.html + /tmp)."*

**Practical consequence for the daylight zone:** the new area's *level data*
(`grid`, `REG`, `region()`, `LIGHTS`, `SPAWNS`) lives in `NUKEM.html` and is
orchestrator-owned. A render-side module therefore either (i) builds the new
area's geometry itself, in world space, on `ready` — which is what `nz-env.js`
does for all its trim, props and fixtures — or (ii) waits for the orchestrator
to add the region and only re-lights it. **Option (i) is fully within a new
module's rights** and is the assumption in §3.6's sketch.

Also from `NUKEM.html:2495`: collision is grid-based and knows nothing about
anything a module adds (`nz-env.js:60-66`). Anything you add must sit where the
camera cannot go — `hug()` within `(PRAD − 0.15)` of a wall plane, or above the
jump apex, or on an already-solid cell.

## 5.5 What r149 does NOT have that people reach for

Confirmed by grepping `vendor/three.r149.min.js` and by `CS2-BRIEF.md:52-54`.

**Not in the UMD build at all (they live in `examples/`):**
`EffectComposer`, `RenderPass`, `ShaderPass`, `UnrealBloomPass`, `SSAOPass`,
`SMAAPass`, `OrbitControls`, `PointerLockControls`, `GLTFLoader`, `RGBELoader`,
`EXRLoader`, `DRACOLoader`, `BufferGeometryUtils` (**including
`mergeBufferGeometries` / `mergeVertices`** — `nz-enemies.js:53-55` ships its
own), `SkeletonUtils`, `Sky`, `Water`, `Lensflare`, `CSM`, `Reflector`,
`TransformControls`, `Line2`/`LineMaterial`, `TextGeometry`/`FontLoader`.

**Not in r149 *at all*, regardless of build:**

| thing | status in r149 | do instead |
|---|---|---|
| `WebGPURenderer` | no | — |
| `scene.environmentIntensity` | **added in r163** | `material.envMapIntensity` per material |
| `scene.environmentRotation` / `backgroundRotation` | **r163** | rebuild the PMREM |
| `material.dispersion`, `iridescenceMap` on Standard | partial | — |
| `THREE.ColorManagement.enabled` | **r152+**; r149 has `legacyMode` | `nz-render.js:618-627` handles both |
| `texture.colorSpace` | r152+ name; r149 has both `colorSpace`\* and `encoding` | the `if (THREE.SRGBColorSpace) … else …` idiom |
| `renderer.outputColorSpace` | r152+ name | `outputEncoding` fallback (`_critic_operators.html:290`) |
| **per-object light masking / light `layers` influence** | **does not exist in the forward path, any version** | shader mask on world position |
| `DirectionalLight` / `HemisphereLight` `.distance` | does not exist | see above |
| **per-object fog** | does not exist | `material.fog = false`, or ramp the global fog |
| cascaded shadow maps | no | one snapped, camera-following box (`followShadow`) |
| `Texture.compareFunction`, RG/R formats on all paths | partial | pack into RGBA (`packORM`) |
| MRT (`WebGLMultipleRenderTargets`) | exists but unused here | the G-buffer is a single RGBA |

\* r149 does expose `SRGBColorSpace`/`colorSpace` on `Texture`, which is why
every write in this project is guarded with `if (THREE.SRGBColorSpace)`.

And the r149-specific landmine documented at length in `nz-render.js:38-100`
and `CRITIC-REPORT.md:82-107`:

> three r149 ships `ColorManagement.legacyMode = true`, and with it
> `Color.setHex()` returns early out of `toWorkingColorSpace()`. So
> `new THREE.MeshStandardMaterial({ color: 0x767676 })` is **not** an 18%
> reflectance surface.

`nz-render.js` turns `legacyMode` off globally at `rendererInit`
(`:4081`), so **in a new module a hex literal means the sRGB colour it looks
like**, and you must use `srgbHex()`-style decoding only if you might run
without nz-render. Never call `convertSRGBToLinear()` on a hex — that is a
double decode.

## 5.6 Perf budget conventions, as stated in the existing headers

There is no numeric budget table in the repo; the conventions are stated as
claims each module makes about itself and proves at runtime.

**Draw calls — the stated unit is "calls added vs calls removed":**

* `nz-env.js:44-47`: *"skirting, cornice, chair rail, door frames …, barrels,
  pallets and debris — every one chamfered, every one merged into a handful of
  piles so the whole pass costs **~8 draw calls and REMOVES 22** (the crates
  become one mesh)."*
* `nz-env.js:3283`: *"the 22 stock crate meshes are now one merged pile: 22
  draw calls gone."*
* `nz-enemies.js:29`, `:194`: *"all in the same draw call"* / *"gives us
  **exactly one draw call per character**."*
* `nz-weapons.js:713`: *"the whole viewmodel is **a handful of draw calls**
  against a single [atlas]."*
* `nz-weapons.js:2994`: *"One quad batch for every smoke wisp: **one draw
  call**."*
* Tracked live: `STATS.addedCalls` / `STATS.removedCalls` (`nz-env.js:94`).

**Textures — the stated unit is "how many uploads per material" and MB of VRAM:**

* `nz-env.js:15-19`: *"Each emits albedo + normal + a single packed ORM texture
  (R=AO, G=roughness, B=metalness …) so **a full PBR surface costs 3 textures,
  not 5**. Sets are shared between surfaces that are really the same material
  with a different tint or tiling."*
* `nz-env.js:530`, `:547`, `:690`: every texture adds
  `res * res * 4 * 1.34` to `STATS.texBytes` — **the 1.34 is the mipmap chain**.
* Reported as `vram~<n>MB` in `NZ.env.report()` and the install log
  (`nz-env.js:3346`, `:3358`), and as `NZ.env.megabytes` (`:3333`).
* `nz-enemies.js:33`: *"a **1024×1024 16-region atlas**"* — one atlas, 16
  materials.
* `nz-env.js:733`: *"a [set] no surface in the level asks for is never baked, so
  the VRAM bill is [only what is used]"* — **lazy baking is the convention.**

**Frame time:** `nz-render.js` owns adaptation. `medianFrame()` (`:3388`) over a
48-frame ring, `adapt()` (`:3427`) moves `degrade` 0..5. A new module's
obligation is only to **follow `NZ.render.quality` / `NZ.render.effects`**
(`nz-env.js:232` `pickTier()`, `nz-enemies.js:8509`) and to shed work at `low`.
`nz-env.js:248-249` is the template:

```js
if (TIER === 'low') { RES = { hi: 128, md: 128 }; DENSITY = 0.30; }
else if (TIER === 'med') { RES = { hi: 256, md: 256 }; DENSITY = 0.62; }
```

**Install time:** measured and logged by every module
(`STATS.ms`, `nz-env.js:3326`; `nz-weapons.js:4366` logs atlas ms and geometry
ms separately). The whole level boot is ~30 s under SwiftShader and ~5 s of
that is module install, so a new module should target **well under 1 s** of
bake on a real GPU and must be lazy at `low`.

**Validation gate** (`CS2-BRIEF.md:62-63`):
`node --check <yourfile>.js` and `npm test` (= `check:level` + `check:game`).

---

# 6. The headless render harness

## 6.1 What exists

| file | what it is |
|---|---|
| `scripts/render-critic.mjs` | Node runner. Launches `chrome-headless-shell` under SwiftShader, drives `_critic_operators.html`, pulls PNGs off the page. **Character look-dev only — it does not load `NUKEM.html`.** |
| `_critic_operators.html` | Standalone operator studio. Loads three + nz-core + nz-render + nz-enemies, shims the game globals, drives the rig through the NZ hook bus. Boot to first frame ~5 s. |
| `nz-shots.js` + `_shot_*.html` | In-game harness. Arms on `?shot=<scene>` or `window.NZ_SHOT`. **This is the only thing that can render the real level.** |
| `scripts/enemy-harness.mjs` | Non-visual enemy regression (40 checks). |
| `scripts/validate-level.mjs`, `validate-game.mjs` | Static/VM level checks, no browser. |

`_critic_operators.html:8-13` states the reason for the split explicitly:

> Does NOT load NUKEM.html: the game spends ~35 s building a level and baking
> five modules' worth of textures before the first frame, which does not fit in
> a 45 s shell call.

## 6.2 Environment — `/tmp/chsenv.sh` and whether Chrome still exists

`/tmp/chsenv.sh` is referenced by `CRITIC-REPORT.md:12` and `VERIFY-REPORT.md:30`
but **is not in the repo and does not survive a sandbox restart** — `/tmp` is
per-session. `render-critic.mjs:41-45` names the three things it sets:

```js
const PP_DIR   = process.env.CRITIC_PP   || '/tmp/pp';
const CHROME   = process.env.CRITIC_CHROME ||
  '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell';
const LIB_DIRS = process.env.CRITIC_LIBS ||
  '/tmp/root/lib/x86_64-linux-gnu:/tmp/root/usr/lib/x86_64-linux-gnu:/tmp/root/usr/lib/x86_64-linux-gnu/nss';
```

and `render-critic.mjs:250-253` prints the intended re-creation recipe:

```
chrome-headless-shell not found at <path>
  re-create it: unzip ~/.cache/puppeteer/dl/chs.zip -d /tmp/chs
  and the libs: for d in /tmp/deb/*.deb; do dpkg-deb -x "$d" /tmp/root; done
```

**State at the start of this pass (checked):**

| path | present? |
|---|---|
| `/tmp/chsenv.sh` | **NO** |
| `/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell` | **NO** |
| `/tmp/pp` (puppeteer) | **NO** |
| `/tmp/root` (extracted libs) | **NO** |
| `~/.cache/puppeteer/dl/chs.zip` | **NO** (`~/.cache` does not exist) |
| repo `node_modules/@puppeteer/browsers` | **present but EMPTY** — `lib/browser-data/` only, no `package.json`, not requireable |
| repo `node_modules/puppeteer` | present but the tree is broken the same way |
| `node` / `npm` / `apt-get` / `dpkg-deb` | present (node v22.22.3, npm 10.9.8) |
| network to `registry.npmjs.org` / `storage.googleapis.com` | **reachable** |

**Also important: each `bash` call runs in its own `bwrap --unshare-pid
--die-with-parent` sandbox with a hard 45 s cap. Backgrounded processes are
killed when the call returns**, so a long download cannot be nursed across
calls with `nohup`. Everything below is sized to fit in one call each.

### Exactly what must be installed — verified working this session

```bash
# 1. Chrome for Testing headless shell (~120 MB zip; took ~20 s here)
V=$(curl -sS https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).channels.Stable.version))")
curl -sS -C - -o /tmp/chs.zip \
  "https://storage.googleapis.com/chrome-for-testing-public/$V/linux64/chrome-headless-shell-linux64.zip"
unzip -qo /tmp/chs.zip -d /tmp/chs
chmod +x /tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell

# 2. The ONE missing shared library on this image. `ldd` reports only
#    libXdamage.so.1; everything else in deb.deps is already present.
mkdir -p /tmp/deb && cd /tmp/deb && apt-get download libxdamage1   # no root needed
for d in /tmp/deb/*.deb; do dpkg-deb -x "$d" /tmp/root; done

# 3. puppeteer. The repo's node_modules is broken and must NOT be repaired
#    (the project deliberately has no node_modules of its own). Install
#    puppeteer-core into /tmp and alias it, so no browser is downloaded twice.
mkdir -p /tmp/pp && cd /tmp/pp && echo '{"name":"pp","private":true}' > package.json
npm install puppeteer-core@23 --no-audit --no-fund      # ~9 s, 84 packages
mkdir -p /tmp/pp/node_modules/puppeteer
printf '{"name":"puppeteer","version":"0.0.0","main":"index.cjs"}' > /tmp/pp/node_modules/puppeteer/package.json
printf "module.exports = require('puppeteer-core');" > /tmp/pp/node_modules/puppeteer/index.cjs
echo noop > /tmp/pp/noop.cjs      # render-critic.mjs:259 createRequire anchor
```

Then write `/tmp/chsenv.sh` — this is its full content, reconstructed from
`render-critic.mjs:41-45` and `:256-257`:

```bash
# /tmp/chsenv.sh
export CRITIC_PP=/tmp/pp
export CRITIC_CHROME=/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell
export CRITIC_LIBS=/tmp/root/usr/lib/x86_64-linux-gnu:/tmp/root/lib/x86_64-linux-gnu
export LD_LIBRARY_PATH="$CRITIC_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

(The original `CRITIC_LIBS` also listed `/tmp/root/usr/lib/x86_64-linux-gnu/nss`.
Not needed on this image — only `libXdamage.so.1` was missing.)

**Verification, this session:**

```
$ /tmp/chs/.../chrome-headless-shell --version
Google Chrome for Testing 151.0.7922.71
```

## 6.3 Running `render-critic.mjs`

```bash
. /tmp/chsenv.sh
node scripts/render-critic.mjs --cell=full --w=320 --h=420 --taa=1 --nzq=low --budget=34 --out=/tmp/shots/t1.png
```

**Real output, this session:**

```
[0.2s] plan: 1 cell(s) pending, 320x420 ss1 nzq=low, budget 34s
[1.6s] launch 1364ms
[1.6s] estimate: ~2.5s/cell + ~5.5s boot; page deadline 29.9s
[8.9s] domcontentloaded 7255ms
[11.0s] page [critic] {"marks":["three+core=141ms","ecfg=464ms","modules=540ms","gl=615ms",
        "stage=665ms","lights=667ms","rendererInit=1014ms","ready=6596ms","warm=7148ms"],"totalMs":9343}
[11.1s] ok  /tmp/shots/t1.png  (+9.4s)
[11.2s] page: ... tier=low
[11.2s]   cell trooper/aim/full: pose=88ms draw=236ms lod=0 dist=16.41
[11.2s] done in 11.2s, wrote 1 file(s)
```

**It works.**

### CLI flags — `render-critic.mjs:58-94`

```
--kind=trooper|pig|enforcer|octa       --pose=idle|aim|walk|run|crouch|turn|dead
--view=front|tq|side|back34|back|top   --cell=full|silhouette|calib|head|hands|weld|
                                             feet|weapon|maps|roster|anim|scale
--env=studio|level    studio = calibrated 18%->18% stage; level = NUKEM.html's rig verbatim
--sheet=<preset|a:b:c:d,...>  --cols=N  --one  --combined  --force  --list
--w= --h= --ss=1..3   --nzq=low|med|high|ultra   --nzr=0|1   --taa=N (default 3)
--fov= --key= --keyaz= --keyel= --keyi= --envi= --ev=<stops> --grid --seed=
--frames=N (cell=anim)  --budget=36  --out=<path>  --keep  --quiet  --dbg
```

Presets (`:100-134`): `roster turntable poses detail guns grips planted
silhouettes calib materials strip anim scale audit`.

### The 40 s budget — `render-critic.mjs:10-18`

> HARD BUDGET: one invocation must finish inside 40 s, because a shell call is
> capped at 45 s. Everything below is shaped by that:
> * the default is ONE cell, not a sheet;
> * `--sheet` renders as many still-missing cells as fit in the remaining
>   budget, writing each PNG as it completes, then prints what is left.
>   **Re-running picks up where it stopped**, so a full sheet is built over
>   several calls without ever redoing work;
> * every phase prints its elapsed time so the budget stays visible.

Mechanics: `--budget` (default 36 s) is converted at `:328` into a page-side
`deadline` query param — *"The page owns the stop decision … but it needs to be
told where the wall is."* Cost model at `:205-212`:
`cost = (w * h * frac * taa * 8.2 µs)/1e6 + 1.4`, with
`RENDER_FRACTION = { maps: 0.42, anim: 0.74, calib: 1, roster: 1, scale: 1 }`.
One page load serves the whole pending batch (`:316-321`) because the ~4.7 s
module boot and ~3 s of SwiftShader shader compilation are paid once.

Two SwiftShader workarounds that any new harness must copy:
* `--disable-accelerated-2d-canvas` (`:297`): *"an accelerated 2D canvas
  deadlocks on `toDataURL()` after a WebGL `drawImage` under SwiftShader."*
* `_critic_operators.html:283-292`: **`setRenderTarget(null)` is remapped to a
  capture RT** because *"gl.readPixels(0,…) on the canvas, drawImage(glCanvas)
  and toDataURL() on the result all block forever inside the compositor."*

### Pointing it at a camera position in the level — you can't

`render-critic.mjs` has **no camera position flag**, and
`_critic_operators.html` has **no level at all**. `--env=level` only mirrors
`NUKEM.html`'s *light rig* onto the standalone operator stage
(`_critic_operators.html:226-241`, `LEVEL_RIG`). It cannot show you a wall.

## 6.4 Rendering an arbitrary free camera in the level — the design, verified

There **is** an existing free-camera path, and it does not need a new page.
`nz-shots.js` in `mode=single` calls `applyPose()` from a **priority-1000
`render` hook every single frame** (`nz-shots.js:909-921`):

```js
if (CFG.mode === 'single') {
  if (RUN.f < CFG.warm) { try { holdCell(RUN.cells[0], RUN.f, CFG.warm); } catch (e) { } }
  applyPose();
  ...
}
```

and `NZ.shots.pose` is the live object it reads (`nz-shots.js:1501`).
`applyPose()` (`:620-647`) also carries the sky dome and syncs the game's
`player` record so LOD and sprite lighting agree. **So writing
`NZ.shots.pose.{x,y,z,yaw,pitch,fov}` from Puppeteer moves the camera on the
next frame — a complete free camera with no new page and no file edits.**

Verified live this session:

```
[9.2s]  title="SHOT SINGLE"
[9.3s]  probe={"cam":[114,5.985,143.6],"tier":"low","fog":["bab8ae",70,520],
         "envSet":true,"exposure":0.95,"lightRig":{"key":1.45,"probe":0.285}}
[11.8s] camera after = [214,14.85,122]       <-- moved to the rooftop, as requested
[35.2s] screenshot ok -> /tmp/shots/level_roof.png (374260 bytes)
```

Two findings worth recording:

* **Boot to `SHOT SINGLE` was 9.2 s, not the 30 s `VERIFY-REPORT.md:47` quotes.**
  `?nzq=low&ss=1&prewarm=0&warm=2&settle=4` at 640×400 is the difference.
  **`NUKEM.html` therefore *does* fit inside one 45 s shell call**, which the
  critic rig's split assumed it did not.
* **`page.screenshot()` works** under SwiftShader — no `toDataURL()`, no
  `drawImage(glCanvas)`, so it never touches the deadlocking path. That means a
  level harness does **not** need `_critic_operators.html`'s capture-RT
  redirection. Cost: the readback itself is expensive on a wide open view
  (23 s at the rooftop, ~7 s at 640×400 in a corridor). **Budget by view, not
  by resolution.**

### The smallest new harness file

**No new HTML page is needed.** One ~60-line Node script alongside
`render-critic.mjs`, owned by whoever owns the level look-dev:

`scripts/render-level.mjs`

```js
#!/usr/bin/env node
/* render-level.mjs -- free-camera stills of the REAL level, headless.
   Companion to render-critic.mjs (which renders operators on a studio stage
   and cannot show a wall). Same chrome, same env vars, same 40 s discipline.

     . /tmp/chsenv.sh
     node scripts/render-level.mjs --at=53,30 --yaw=1.5708 --pitch=-0.05 --out=roof.png
     node scripts/render-level.mjs --pos=214,14.8,122 --fov=70 --nzq=med
     node scripts/render-level.mjs --preset=3            # nz-shots' own env presets
*/
import fs from 'node:fs'; import path from 'node:path'; import url from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CRITIC_CHROME || '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell';
const PP_DIR = process.env.CRITIC_PP || '/tmp/pp';
process.env.LD_LIBRARY_PATH = (process.env.CRITIC_LIBS || '') + ':' + (process.env.LD_LIBRARY_PATH || '');
const puppeteer = createRequire(path.join(PP_DIR, 'noop.cjs'))('puppeteer');

/* ...flag parsing identical in shape to render-critic.mjs:49-94... */

const browser = await puppeteer.launch({ executablePath: CHROME, args: [
  '--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader',
  '--enable-unsafe-swiftshader','--disable-dev-shm-usage','--allow-file-access-from-files',
  '--enable-webgl','--ignore-gpu-blocklist','--hide-scrollbars',
  '--disable-accelerated-2d-canvas','--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', `--window-size=${W},${H}`] });
const page = (await browser.pages())[0];
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

/* nz-shots single mode: one preset, full screen, frozen sim, TAA converged. */
const qs = `?shot=env&mode=single&i=${OPT.preset}&width=${W}&height=${H}` +
           `&ss=1&nzq=${OPT.nzq}&prewarm=0&warm=2&settle=${OPT.settle}&seed=${OPT.seed}` +
           (OPT.q ? '&' + OPT.q : '');                 /* pass ?nzday=0 etc straight through */
page.goto('file://' + ROOT.split(path.sep).join('/').replace(/ /g,'%20') + '/NUKEM.html' + qs,
          { waitUntil: 'domcontentloaded' }).catch(()=>{});
await waitTitle(page, /^SHOT /, BUDGET);               /* ~9 s at nzq=low, 640x400 */

/* FREE CAMERA. nz-shots.js:909-921 calls applyPose() every frame from a
   priority-1000 'render' hook, so this is all it takes. Grid coords are
   world = g * CELL + CELL/2 (nz-shots.js:209-212, NUKEM.html:2499). */
await page.evaluate((p) => {
  const CELL = 4;                                      /* read it if you prefer */
  const P = NZ.shots.pose;
  if (p.pos) { P.x = p.pos[0]; P.y = p.pos[1]; P.z = p.pos[2]; }
  else       { P.x = p.at[0]*CELL + CELL/2; P.z = p.at[1]*CELL + CELL/2; P.y = p.eye; }
  P.yaw = p.yaw; P.pitch = p.pitch; P.fov = p.fov;
}, CAM);

/* let TAA reconverge: settle+2 frames is enough, and a frame is 0.2-2.5 s here */
await new Promise(r => setTimeout(r, OPT.hold));

/* Optional: prove the frame rather than trusting it. */
const diag = await page.evaluate(() => ({
  flags: NZ.flags, tier: NZ.render.quality, exposure: NZ.render.params.exposure,
  rig: NZ.render.lightRig, fog: [scene.fog.color.getHexString(), scene.fog.near, scene.fog.far],
  env: !!NZ.ctx.scene.environment, cam: NZ.ctx.camera.position.toArray(),
  render: NZ.render.selfCheck(), envmod: NZ.env && NZ.env.diag
})).catch(() => null);

fs.writeFileSync(OUT, await page.screenshot({ type: 'png' }));   /* NOT toDataURL */
console.log(JSON.stringify(diag));
await browser.close();
```

Budget guidance measured here: **9 s boot + 2 s pose + 7–23 s readback.** A
640×400 interior fits comfortably; a wide rooftop at `nzq=low` is 35 s and is
the practical ceiling for one shell call. For anything bigger, use
`render-critic.mjs`'s resumable pattern — write each shot as it lands and
re-run.

**For daylight-zone work specifically**, add `--at=` presets for: (1) deep
inside the night level, (2) mid-passage, (3) the doorway looking out,
(4) inside the day zone looking back at the doorway, (5) inside the day zone
looking at open sky. Shots (3) and (4) are where every one of the five
"carriers" in §3.0 either agrees or visibly does not.

---

## Appendix — one-line facts worth keeping

* `NZ.first('render', dt)` — **returning `true` means "I drew the frame"**;
  `nz-render.js:4257-4265` returns `true` only when `renderFrame()` succeeded.
  Any other module on this hook must return `undefined`.
* `NZ.on(name, fn, priority)` sorts **descending**; higher runs first.
* Colour management is **ON** by default (`?nzcm=0` opts out), so hex literals
  are sRGB — `nz-render.js:4081`.
* `envMapIntensity` is set to `1.0` on **every** material by `upgradeMaterials()`
  (`:2101`, `:2153`), which runs once at `ready`. A material created *after*
  that keeps whatever you set.
* `neutralizeBakedLighting()` only touches material names starting `world:` or
  `nzenv:` (`:2282-2288`). This is the daylight module's escape hatch.
* `material.envMap` beats `scene.environment` in r149 — verified against
  `vendor/three.r149.min.js`.
* There is **no per-object light masking in three.js**, at any version, in the
  forward path.
* Fog is one global linear `Fog(#bab8ae, 70, 520)` after nz-render; the only
  per-material control is `fog: false`.
* The sky is one 460-unit `BackSide` sphere whose material nz-render replaces;
  it is only *visible* where `region.sky === true`.
* `_critic_operators.html` never loads the level. `nz-shots.js` is the only
  path to a real level frame.
