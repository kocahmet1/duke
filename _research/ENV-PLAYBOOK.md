# ENV-PLAYBOOK.md — how to write a sibling of `nz-env.js`

Target readers: the two agents who will write **`nz-street.js`** (building facades)
and **`nz-street-props.js`** (street dressing) for the new east residential street.
Everything here is extracted from `nz-env.js` (3540 lines) with real line numbers,
cross-checked against `NUKEM.html`, `nz-core.js` and `nz-render.js`.

Companions (read them, do not duplicate them):
`_research/LEVEL-CONTRACT.md` — the grid/region/geometry pipeline.
`_research/RENDER-CONTRACT.md` — nz-core/nz-render, daylight, the headless harness.

---

## 0. READ THIS BEFORE ANYTHING ELSE — the scale trap

`nz-env.js:607`:

```js
var METRES_PER_UNIT = 0.6;      /* EYE 2.85 units reads as a 1.71 m eye line */
```

**This constant is stale.** `NUKEM.html:360` now says:

```js
const M = 3.5;                  /* world units per metre */
```

and `NUKEM.html:3649` says `const EYE = 1.71 * M` — i.e. **5.985** units, not 2.85.
So the live scale is **1 unit = 0.2857 m**, not 0.6 m. `nz-env` was authored against
the old scale and never re-based. Verified against `CRITIC-REPORT.md:301`
("The 3.5 units/metre convention is holding") and the whole table in
`LEVEL-CONTRACT.md §1.2`.

Three consequences you inherit:

| what | nz-env claims | what actually ships |
|---|---|---|
| `emitSet` relief `mm:1.4` on concrete | 1.4 mm RMS | **0.67 mm** (×0.476) |
| `SURF.concrete.tile = 8.0` | "a 4.8 m pour" | **2.29 m** repeat |
| `SURF.brick.tile = 4.0`, 32 courses | "75 mm coursing" | **35.7 mm** per course — half-scale brick |
| `jumpTop(f) = f + 6.7` (`:2066`) | above the jump apex | **1.55 units too low** (real apex-eye is `f + 8.243`) |
| `rebuildCrates` box height 3.4 (`:2940`) | "matches the stock crate" | stock `CRATE_H = 4.2` (`NUKEM.html:2491`) |

**Your rule.** In your modules define:

```js
  var M_PER_U = 1 / 3.5;        /* 0.2857 m, the live scale (NUKEM.html:360)   */
  var U = 3.5;                  /* units per metre; author every size as m * U */
```

and author **every tile size, every relief figure and every prop dimension in
metres × 3.5**. Do not copy `SURF`'s tile numbers. A facade is the hero read of
the street and half-scale brick is exactly the "wallpaper, not masonry" failure
`nz-env.js:814-823` writes a paragraph about.

Do **not** fix `nz-env.js`. You do not own it (`CS2-BRIEF.md:46`). Report the
discrepancy to the orchestrator; ship correct numbers in your own files.

---

## 0.1 Ground-truth constants (all verified in `NUKEM.html`)

```
M          3.5      units per metre                      :360
MW, MH     64, 48   grid size                            :2368
CELL       4        units per cell = 1.143 m             :2368
S_SOLID..S_BLOCK  0,1,2,3,4,5,6                          :2369
CLIMB      1.15     tallest walkable step = 0.329 m      :3157
PRAD       1.15     player hull radius = 0.329 m         :3651
EYE        5.985    (1.71 * M)                           :3649
EYE_CROUCH 4.025    (1.15 * M)                           :3650
PHEAD      0.42     (0.12 * M) eye -> crown              :3652
GRAV       64                                            :3653
JUMPV      17.0     apex = 17^2/(2*64) = 2.258 u         :3654
CRATE_H    4.2      = 1.200 m chest-high cover           :2491
```

Derived and load-bearing:

```
jump apex                 2.258 u
MAX CAMERA Y above floor  EYE + apex = 8.243 u   (camera = player.y + eye, :3955)
                          capped by  R.c - 0.06 - (eyeH + PHEAD)   (:3884)
safe "above the player"   floor + 8.70 u  (8.243 + bob + 0.4 margin)
safe wall protrusion      0.98 u  (PRAD - 0.17), = nz-env's HUG (:2058)
```

Region record (`NUKEM.html:2392-2397`):

```js
{ f: 0, c: 11, ftex: 'tilefloor', ctex: 'ceildark', wtex: 'concrete',
  amb: [.10,.10,.12], sky: false, fit: false, rect: null }
```

The three street regions the carve plan adds (`LEVEL-CONTRACT.md:1306-1308`):

```js
const rTRoad  = region({ f: 0,  c: 28, ftex: 'street',    wtex: 'brick', sky: true,  amb: [.16,.17,.24] });
const rTWalk  = region({ f: .5, c: 28, ftex: 'concrete',  wtex: 'brick', sky: true,  amb: [.16,.17,.24] });
const rTFoyer = region({ f: 0,  c: 12, ftex: 'tilefloor', wtex: 'stone', ctex: 'ceil', amb: [.15,.14,.12] });
```

Street body `x 42..62, y 39..46`; roadway `y 41..44` (f=0); pavements `y 39..40`
and `y 45..46` (f=0.5, a 143 mm kerb); mouth `x 44..46, y 38`.

---

# 1. Module skeleton

## 1.1 The five structural facts

1. **Load order.** `NUKEM.html:8029-8033` lists the module `<script>` tags:
   `nz-render.js, nz-env.js, nz-enemies.js, nz-weapons.js, nz-audio.js`.
   The orchestrator must add yours **after `nz-env.js`**. `build-static.mjs:58-61`
   carries the same list (`MODULES`) and must be updated too. You cannot do
   either — request it.
2. **Wrapper.** `(function (global) { 'use strict'; ... })(typeof window !== 'undefined' ? window : this)`.
   Classic script, `var` only, no ES modules, no `import`, no build step.
   (`nz-env.js:68-69`, `:3540`.)
3. **Flag.** `NZ.flags` is created in `nz-core.js:22-27` with four keys. `nz-env`
   adds its own defensively at `:73`. Do the same with your key.
4. **Hook.** `NZ.on('ready', fn, priority)`. Priority sorts **descending**
   (`nz-core.js:43`), so a larger number runs first. See §9.3 for the number to use.
5. **Teardown.** Everything you create goes in `OWN`; `panic()` puts it back.
   `NZ.flags.<you> = false` on any throw. (`CS2-BRIEF.md:59-61`, `nz-env.js:3476-3525`.)

## 1.2 The template

Copy verbatim. Replace `street` / `nzstreet` / `nzst` with your module's names.
It passes `node --check` as written, installs cleanly, and is inert (adds nothing)
until you fill in `buildEverything()`.

```js
/* ===========================================================================
   NZ-STREET  --  <one paragraph on what this module owns and why>.

   Installs on the 'ready' hook at priority -30 (after nz-env's -20, before
   nz-render's late sweep at -1000) and adds geometry to NZ.ctx.scene. Touches
   nothing that nz-env owns.

   Zero external assets. Classic script. three.js r149 core UMD surface only.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.street === undefined) NZ.flags.street = false;

  /* opt-out / force a tier: ?nzstreet=0 | low | med | high */
  var QS = /[?&]nzstreet=(0|off|low|med|high)/i.exec(
    global.location ? global.location.search : '') || null;
  if (QS && /^(0|off)$/i.test(QS[1])) { NZ.log && NZ.log('street disabled by query string'); return; }

  var THREE = null, scene = null, renderer = null;
  var dead = false, installed = false;

  /* everything this module owns, so panic() can put the level back */
  var OWN = { tex: [], mat: [], geo: [], obj: [], restore: [], timer: 0 };
  var STATS = { sets: 0, texBytes: 0, props: 0, decals: 0, addedCalls: 0, ms: 0 };
  var DIAG  = { sets: [], piles: [], glslProbe: null, warnings: [] };
  function warn(msg) { DIAG.warnings.push(msg); console.warn('[nz-street] ' + msg); }

  /* ---- small math ------------------------------------------------------- */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }

  /* ---- scale ------------------------------------------------------------ */
  var U = 3.5;                       /* world units per metre  (NUKEM.html:360) */
  var M_PER_U = 1 / U;               /* 0.2857 m per unit                       */
  function m(x) { return x * U; }    /* author everything as m(1.8) etc.        */

  /* ---- the game's lexical globals --------------------------------------
     NUKEM.html declares its level state with top-level const/let: visible as
     bare identifiers, NOT properties of window, ReferenceError if read early.
     Same thunk idiom nz-env.js:135-163 and nz-audio.js use. Nothing below is
     named after a game global, so no shadowing can break a lookup. */
  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }
  var G = null;
  function bindGame() {
    var g = {
      MW: fin(tryGet(function () { return MW; }), 0),
      MH: fin(tryGet(function () { return MH; }), 0),
      CELL: fin(tryGet(function () { return CELL; }), 4),
      PRAD: fin(tryGet(function () { return PRAD; }), 1.15),
      EYE: fin(tryGet(function () { return EYE; }), 5.985),
      CLIMB: fin(tryGet(function () { return CLIMB; }), 1.15),
      GRAV: fin(tryGet(function () { return GRAV; }), 64),
      JUMPV: fin(tryGet(function () { return JUMPV; }), 17),
      CRATE_H: fin(tryGet(function () { return CRATE_H; }), 4.2),
      S_SOLID: fin(tryGet(function () { return S_SOLID; }), 0),
      S_DOOR: fin(tryGet(function () { return S_DOOR; }), 2),
      S_KEY: fin(tryGet(function () { return S_KEY; }), 3),
      S_SECRET: fin(tryGet(function () { return S_SECRET; }), 4),
      S_EXIT: fin(tryGet(function () { return S_EXIT; }), 5),
      S_BLOCK: fin(tryGet(function () { return S_BLOCK; }), 6),
      cellAt: tryGet(function () { return cellAt; }) || null,
      isWallCell: tryGet(function () { return isWallCell; }) || null,
      regAt: tryGet(function () { return regAt; }) || null,
      inb: tryGet(function () { return inb; }) || null,
      lightAt: tryGet(function () { return lightAt; }) || null,
      liftOf: tryGet(function () { return liftOf; }) || null,
      LIGHTS: tryGet(function () { return LIGHTS; }) || null,
      DOORS: tryGet(function () { return DOORS; }) || null,
      CRATES: tryGet(function () { return CRATES; }) || null
    };
    if (!g.MW || !g.MH || !g.cellAt || !g.regAt || !g.inb || !g.isWallCell) return null;
    return g;
  }
  function regionAt(cx, cy) { if (!G.inb(cx, cy)) return null; return G.regAt(cx, cy) || null; }
  function openCell(t) { return t !== G.S_SOLID && t !== G.S_EXIT; }
  function solidCell(cx, cy) { return !G.inb(cx, cy) || G.isWallCell(cx, cy); }

  /* ---- clearance (see ENV-PLAYBOOK section 7) --------------------------- */
  var HUG = 0.98;                    /* max protrusion from a wall plane      */
  var HUGVIOL = 0;
  function hug(d) {
    if (d > HUG) { HUGVIOL++; if (NZ.debug) console.warn('[nz-street] depth ' + d.toFixed(2) + ' clamped'); return HUG; }
    return d;
  }
  /* the REAL apex-of-jump eye line, unlike nz-env's stale f + 6.7 */
  function apex() { return (G.JUMPV * G.JUMPV) / (2 * G.GRAV); }      /* 2.258 */
  function camTop(f) { return f + G.EYE + apex(); }                   /* 8.243 */
  function jumpTop(f) { return camTop(f) + 0.45; }                    /* 8.70  */

  /* ---- quality tier ------------------------------------------------------ */
  var TIER = 'high';
  var RES = { hi: 512, md: 256 };
  var DENSITY = 1.0;
  function pickTier() {
    if (QS) return QS[1].toLowerCase();
    var q = (NZ.render && NZ.render.quality) || null;
    /* nz-render also emits 'ultra' (nz-render.js:722-740); treat it as high */
    if (q === 'ultra') return 'high';
    if (q === 'high' || q === 'med' || q === 'low') return q;
    var nav = global.navigator || {};
    var cores = fin(nav.hardwareConcurrency, 4), mem = fin(nav.deviceMemory, 0), maxTex = 4096;
    try { maxTex = renderer.capabilities.maxTextureSize; } catch (e) {}
    if (maxTex < 4096 || cores <= 2 || (mem && mem <= 2)) return 'low';
    if (cores <= 4 || (mem && mem <= 4)) return 'med';
    return 'high';
  }
  function applyTier() {
    TIER = pickTier();
    if (TIER === 'low') { RES = { hi: 128, md: 128 }; DENSITY = 0.30; }
    else if (TIER === 'med') { RES = { hi: 256, md: 256 }; DENSITY = 0.62; }
    else { RES = { hi: 512, md: 256 }; DENSITY = 1.00; }
  }

  /* ==== PASTE SECTION 2 HERE: noise + field toolkit + emitSet + BUILD sets */
  /* ==== PASTE SECTION 4 HERE: FRAG_HEAD / VERT_HEAD / INJ_* / nzStPatch    */
  /* ==== PASTE SECTION 5 HERE: litAt / desatRGB                             */
  /* ==== PASTE SECTION 6 HERE: Pile / poly / boxC / tube / decalQuad        */

  /* ---- the actual content ------------------------------------------------ */
  var PILES = null;
  function buildEverything() {
    PILES = { render: new Pile(), stone: new Pile(), joinery: new Pile(), decal: new Pile() };
    /* ... emit geometry into the piles here ... */
  }

  function makeMesh(pile, mat, name, cast) {
    if (!pile || pile.empty() || !mat) {
      DIAG.piles.push({ name: name, verts: pile ? pile.n : 0, tris: 0, added: false });
      return null;
    }
    var mesh = new THREE.Mesh(pile.geometry(), mat);
    mesh.name = name;
    mesh.castShadow = !!cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    OWN.obj.push(mesh);
    STATS.addedCalls++;
    DIAG.piles.push({ name: name, verts: pile.n, tris: (pile.idx.length / 3) | 0, added: true });
    return mesh;
  }

  /* ---- install ----------------------------------------------------------- */
  function install(ctx) {
    if (dead || installed) return;
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    THREE = (ctx && ctx.THREE) || NZ.ctx.THREE || global.THREE;
    scene = (ctx && ctx.scene) || NZ.ctx.scene;
    renderer = (ctx && ctx.renderer) || NZ.ctx.renderer;
    if (!THREE || !scene || !renderer) throw new Error('nz-street: renderer context missing');

    G = bindGame();
    if (!G) { NZ.log('street: game level globals unavailable, module inert'); panic(null); return; }

    applyTier();
    try { ANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } catch (e) { ANISO = 8; }
    GLSL_OK = validateGLSL();
    DIAG.glslProbe = GLSL_OK;
    VDESAT = GLSL_OK ? 0.15 : 0.55;

    /* bail out cleanly if the level does not have the area we dress */
    if (!hasStreet()) { NZ.log('street: carve not present, module inert'); panic(null); return; }

    buildEverything();
    /* ... makeMesh() each pile with its material ... */

    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    STATS.ms = Math.round(t1 - t0);
    STATS.clearanceClamps = HUGVIOL;
    installed = true;
    NZ.flags.street = true;
    NZ.street = {
      stats: STATS, tier: TIER, diag: DIAG,
      megabytes: +(STATS.texBytes / 1048576).toFixed(2),
      shaderDetail: GLSL_OK,
      report: report,
      dispose: function () { panic('manual dispose'); }
    };
    NZ.log('street installed: tier=' + TIER + ' props=' + STATS.props +
           ' draws +' + STATS.addedCalls + ' in ' + STATS.ms + 'ms');
    if (DIAGON) installOverlay();
  }

  /* the carve may not be in this build; never assume it is */
  function hasStreet() {
    var found = false;
    for (var y = 39; y <= 46 && !found; y++) for (var x = 42; x <= 62; x++) {
      var R = regionAt(x, y);
      if (R && R.sky && openCell(G.cellAt(x, y))) { found = true; break; }
    }
    return found;
  }

  /* ---- teardown ---------------------------------------------------------- */
  function panic(err) {
    if (dead) return;
    dead = true;
    NZ.flags.street = false;
    if (err) console.error('[nz-street] disabled after error:', err);
    try {
      var i;
      if (OWN.timer) { try { global.clearInterval(OWN.timer); } catch (e0) {} OWN.timer = 0; }
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      for (i = 0; i < OWN.restore.length; i++) {
        var s = OWN.restore[i];
        if (s.readd) { if (!s.readd.parent && s.parent) s.parent.add(s.readd); continue; }
        if (!s.mesh) continue;
        if (s.material) s.mesh.material = s.material;
        if (s.geometry) s.mesh.geometry = s.geometry;
      }
      OWN.restore.length = 0;
      for (i = 0; i < OWN.obj.length; i++) { var o = OWN.obj[i]; if (o && o.parent) o.parent.remove(o); }
      OWN.obj.length = 0;
      for (i = 0; i < OWN.geo.length; i++) { try { OWN.geo[i].dispose(); } catch (e1) {} }
      OWN.geo.length = 0;
      for (i = 0; i < OWN.mat.length; i++) { try { OWN.mat[i].dispose(); } catch (e2) {} }
      OWN.mat.length = 0;
      for (i = 0; i < OWN.tex.length; i++) { try { OWN.tex[i].dispose(); } catch (e3) {} }
      OWN.tex.length = 0;
      SETS = Object.create(null); MATS = Object.create(null); NOISE = Object.create(null);
      PILES = null; installed = false;
    } catch (e4) { console.error('[nz-street] teardown failed:', e4); }
  }

  /* ---- self-report (a module that cannot see the screen must prove itself) */
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function report() {
    var L = [], i;
    L.push('NZ-STREET tier=' + TIER + ' install=' + STATS.ms + 'ms vram~' +
           (STATS.texBytes / 1048576).toFixed(1) + 'MB glsl=' + DIAG.glslProbe);
    for (i = 0; i < DIAG.sets.length; i++) {
      var b = DIAG.sets[i];
      L.push('  set ' + pad(b.name, 12) + b.res + 'px lum ' + pad(b.lum.toFixed(0), 4) +
             ' sat ' + b.sat.toFixed(3) + ' relief ' + b.reliefMM + 'mm' + (b.black ? '  <<< BLACK' : ''));
    }
    for (i = 0; i < DIAG.piles.length; i++) {
      var p = DIAG.piles[i];
      L.push('  pile ' + pad(p.name || '?', 22) + ' tris ' + pad(String(p.tris), 7) +
             (p.added ? '' : '  (EMPTY - not added)'));
    }
    L.push('props=' + STATS.props + ' decals=' + STATS.decals +
           ' draws +' + STATS.addedCalls + ' clearanceClamps=' + HUGVIOL);
    if (DIAG.warnings.length) {
      L.push('WARNINGS (' + DIAG.warnings.length + '):');
      for (i = 0; i < DIAG.warnings.length; i++) L.push('  ! ' + DIAG.warnings[i]);
    }
    return L.join('\n');
  }

  var DIAGON = /[?&]nzdiag=1/.test(global.location ? global.location.search : '');
  var overlay = null;
  function installOverlay() {
    try {
      if (overlay || !global.document || !document.body) return;
      overlay = document.createElement('div');
      overlay.id = 'nzstreet-diag';
      /* nz-env's overlay is bottom-LEFT (nz-env.js:3419); sit bottom-RIGHT */
      overlay.style.cssText = 'position:fixed;right:0;bottom:0;max-height:52vh;max-width:min(760px,46vw);' +
        'overflow:auto;z-index:99997;background:rgba(6,8,10,.92);color:#9fc8e8;' +
        'font:11px/1.35 Consolas,monospace;padding:6px 8px;white-space:pre;' +
        'border-top:2px solid #2f5d8d;border-left:2px solid #2f5d8d;pointer-events:none';
      overlay.textContent = report();
      document.body.appendChild(overlay);
      var n = 0;
      var iv = global.setInterval(function () {
        if (!overlay || ++n > 12) { global.clearInterval(iv); return; }
        overlay.textContent = report();
      }, 500);
      OWN.timer = iv;
    } catch (e) { /* diagnostics must never break the game */ }
  }

  /* ---- hooks -------------------------------------------------------------
     -30: after nz-env (-20) so the world meshes already carry their nzFC
     attribute and their nzenv materials, and well before nz-render's late
     sweep (-1000) which neutralises baked vertex lighting and composes its
     AO/PCSS patch into every foreign material -- including ours. */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); }
    catch (err) { panic(err); }
  }, -30);

  NZ.log && NZ.log('street module loaded');
})(typeof window !== 'undefined' ? window : this);
```

## 1.3 Where the template came from

| piece | nz-env.js |
|---|---|
| IIFE + NZ guard + flag default | `68-73` |
| query-string opt-out / tier force | `75-78` |
| `OWN` / `STATS` / `DIAG` / `warn` | `84-119` |
| `tryGet` / `bindGame` thunk idiom | `130-163` |
| tier detect + apply | `228-251` |
| `hug` / `jumpTop` | `2058-2066` |
| `makeMesh` | `3149-3165` |
| `install` shape | `3187-3348` |
| `report` / `pad` / overlay | `3356-3435` |
| `panic` | `3476-3525` |
| hook registration | `3533-3537` |

---

# 2. The material library

## 2.1 How a set is produced

```
BUILD.<name>()                       nz-env.js:756-1271, one function per set
   |  builds scalar fields (fbmC / worC / fieldBond / fieldPlank / fieldStreak)
   |  builds an albedo Float32Array (albNew / albMul / albTint / albUnitsMasked)
   |  builds `rough` and optional `metal` Float32Arrays
   v
emitSet(res, alb, height, rough, metal, aoStrength, relief, name)      :609-728
   |  sanity-gates the albedo (NaN -> neutral grey + a loud warn)
   |  cavityAO(height)                       -> the R channel
   |  solves the Sobel strength from relief.mm in REAL millimetres
   |  optional high-pass of the height before differentiating (relief.hp)
   |  couples roughness to the high-passed height (relief.rough)
   v
{ res, refTile, reliefMM, hpMM, sobelS, map, normalMap, ormMap, mean, sd, lum, sat }
```

Three textures per set, never five:

* `map` — sRGB `CanvasTexture` from `albToCanvas` (`:507-515`, `:684`).
* `normalMap` — linear, `normalRaw` Sobel (`:362-385`, `:685`).
* `ormMap` — **R = AO, G = roughness, B = metalness**, the glTF packing r149
  reads natively, so one RGBA upload replaces three (`packORM`, `:536-549`).
  It is assigned to `roughnessMap`, `metalnessMap` **and** `aoMap` on the same
  material (`:1801-1803`).

**Resolution.** `RES.hi` / `RES.md` from the tier (`:229`, `:248-250`):
high 512/256, med 256/256, low 128/128. Big architectural surfaces
(`concrete`, `brick`, `plaster`, `asphalt`) take `RES.hi`; everything else `RES.md`.

**Anisotropy.** `ANISO` is set once in `install()` from
`renderer.capabilities.getMaxAnisotropy()` capped at 16 (`:3199`), and applied in
`texCanvas` (`:527`), `packORM` (`:545`) and to `normalMap` explicitly (`:688`).

**Filtering.** `LinearMipmapLinearFilter` / `LinearFilter`, `generateMipmaps: true`,
`RepeatWrapping` (`:522-527`). Decal atlases override to `ClampToEdgeWrapping`
(`:2595`).

**Laziness + sharing.** `SETS` / `BUILD` (`:736-737`) and `getSet(name)` (`:742-750`):
a set that no surface asks for is never baked. `CURSET` (`:741`) is a module-level
"currently baking" name so `emitSet` can label its own DIAG row without threading
an argument through every builder. Sets are shared across `SURF` entries —
`concrete` serves `concrete` + `ceildark`, `plaster` serves `hotelwall`,
`paint` serves `door` + `keydoor`, `plywood` serves `wood` + `crate`.

**Noise memoisation.** `NOISE` (`:264`) caches every `fbmC`/`worC` result by a
string key (`:387-395`), `LATTICE` (`:266`) caches lattices, `AXIS` (`:275`) caches
the interpolation index tables. This is why 13 sets bake in tens of milliseconds
instead of 22 seconds — see the note at `:253-262`.

## 2.2 The 13 sets, and the 16 `SURF` entries that use them

`SURF` is at `nz-env.js:1311-1332`. Verbatim, all sixteen rows:

```js
concrete:  { set:'concrete', tile: 8.0,  tint:0xf2f3f5, nrm:1.00, macro:0.46, grime:4.2, soot:2.4, grimeAmt:0.78, wetY:-4.0, wet:0.55, desat:0.52, occ:1.00, det:[8.0,0.55], polish:0.34 }
ceildark:  { set:'concrete', tile:10.0,  tint:0xb1b4b8, nrm:0.80, macro:0.34, grime:0.0, soot:0.0, grimeAmt:0.0 , wetY:-99 , wet:0.0 , desat:0.52, occ:0.60, det:[8.0,0.30], polish:0.0  }
stone:     { set:'precast',  tile: 6.0,  tint:0xf2f3f5, nrm:1.00, macro:0.42, grime:3.4, soot:2.0, grimeAmt:0.72, wetY:-99 , wet:0.0 , desat:0.55, occ:1.00, det:[7.0,0.35], polish:0.24 }
brick:     { set:'brick',    tile: 4.0,  tint:0xf4f2f0, nrm:1.00, macro:0.52, grime:4.4, soot:0.0, grimeAmt:0.80, wetY:-99 , wet:0.0 , desat:0.46, occ:1.00, det:[6.0,0.40], polish:0.0  }
hotelwall: { set:'plaster',  tile: 6.0,  tint:0xeff0f2, nrm:0.85, macro:0.44, grime:3.2, soot:1.8, grimeAmt:0.76, wetY:-99 , wet:0.0 , desat:0.56, occ:1.00, det:[7.0,0.10], polish:0.0  }
metal:     { set:'steel',    tile: 4.0,  tint:0xf2f4f6, nrm:1.10, macro:0.30, grime:2.8, soot:1.6, grimeAmt:0.66, wetY:-4.0, wet:0.60, desat:0.50, occ:0.90, det:[6.0,0.10], polish:0.18 }
street:    { set:'asphalt',  tile:10.0,  tint:0xf4f5f7, nrm:0.95, macro:0.44, grime:0.0, soot:0.0, grimeAmt:0.0 , wetY:999 , wet:0.28, desat:0.58, occ:1.00, det:[9.0,0.70], polish:0.30 }
carpet:    { set:'carpet',   tile: 3.4,  tint:0xffffff, nrm:0.50, macro:0.32, grime:1.8, soot:0.0, grimeAmt:0.52, wetY:-99 , wet:0.0 , desat:0.34, occ:0.85, det:[5.0,0.35], polish:0.10 }
tilefloor: { set:'tile',     tile: 3.2,  tint:0xf2f3f5, nrm:0.90, macro:0.30, grime:1.6, soot:0.0, grimeAmt:0.55, wetY:-4.0, wet:0.70, desat:0.52, occ:0.95, det:[6.0,0.12], polish:0.26 }
wood:      { set:'plywood',  tile: 4.2,  tint:0xf6f2ec, nrm:0.80, macro:0.32, grime:1.8, soot:0.0, grimeAmt:0.55, wetY:-99 , wet:0.0 , desat:0.42, occ:0.85, det:[6.0,0.20], polish:0.20 }
ceil:      { set:'ceiltile', tile: 4.0,  tint:0xeef0f2, nrm:0.70, macro:0.28, grime:0.0, soot:0.0, grimeAmt:0.0 , wetY:-99 , wet:0.0 , desat:0.55, occ:0.55, det:[6.0,0.20], polish:0.0  }
grate:     { set:'grating',  tile: 2.2,  tint:0xf2f4f6, nrm:1.00, macro:0.20, grime:1.2, soot:0.0, grimeAmt:0.42, wetY:-4.0, wet:0.65, desat:0.48, occ:0.70, det:[0,0],     polish:0.0  }
glass:     { set:'glassfac', tile: 8.0,  tint:0xffffff, nrm:0.60, macro:0.22, grime:2.0, soot:0.0, grimeAmt:0.50, wetY:-99 , wet:0.0 , desat:0.30, occ:0.70, det:[0,0],     polish:0.0  }
crate:     { set:'plywood',  tile: 2.6,  tint:0xf0ede6, nrm:0.90, macro:0.28, grime:1.2, soot:0.0, grimeAmt:0.40, wetY:-99 , wet:0.0 , desat:0.46, occ:0.80, det:[5.0,0.20], polish:0.0  }
door:      { set:'paint',    tile: 3.0,  tint:0xbfc2c5, nrm:0.85, macro:0.22, grime:1.0, soot:0.0, grimeAmt:0.35, wetY:-99 , wet:0.0 , desat:0.45, occ:0.60, det:[6.0,0.06], polish:0.0  }
keydoor:   { set:'paint',    tile: 3.0,  tint:0xe27e72, nrm:0.85, macro:0.22, grime:1.0, soot:0.0, grimeAmt:0.35, wetY:-99 , wet:0.0 , desat:0.22, occ:0.60, det:[6.0,0.06], polish:0.0  }
```

Plus a 14th set, `rust`, which has no `SURF` row — it is wired by hand in
`makeRustMaterial()` (`:3438-3468`) and used for pipes, drums and heavy corrosion.
`'switch'` is deliberately **absent** from `SURF` (`:1369-1371`): the exit panel is
a gameplay-critical `ACCESS/LOCKED` read authored to fitted UVs, and a tiling PBR
set would destroy it, so it keeps the stock material.

### The 13 `BUILD` functions

| set | line | res | what it is | fields it composes | relief `{mm, tile, hp, rough}` |
|---|---|---|---|---|---|
| `concrete` | 756 | hi | fair-faced pour: form-board seams, tie holes, patch repairs, aggregate pop-out, hairline | fbm grain, worley agg 26, worley patch 5, ridged crack 26, 2× `fieldPlank` seams, `fieldStreak` | `1.4, 8.0, 200, 0.20` |
| `brick` | 812 | hi | weathered city brick, 32×10 running bond | `fieldBond(32,10,res/200,stagger)`, fbm 22, `fieldStreak` soot, worley efflorescence | `2.4, 4.0, 220, 0.14` |
| `plaster` | 873 | hi | painted plaster/drywall; the roughness showcase | orange-peel fbm 30, broad fbm 5, worley patch 6, worley scuff 18, ridged crack 22, streak, worley dimple 12 | `0.35, 6.0, 110, 0.22` |
| `asphalt` | 919 | hi | chip-seal road | worley agg **84**, fbm 26, ridged crack 6, worley patch 4, `fieldStreak` wheel lanes | `1.6, 10.0, 130, 0.20` |
| `precast` | 975 | md | cut stone / sandstone, 4×2 bond | `fieldBond(4,2,res/52)`, fbm 14, ridged vein 9, worley wear 14, streak | `2.0, 6.0, 320, 0.16` |
| `steel` | 1008 | md | painted structural steel worn to bare metal, rust in the low spots, **rivets** | `fieldBond(2,2)` plate, worley edge 9, fbm 20, fbm rust 7, ridged scratch 40, streak bleed, `stampDisc` rivets | `0.8, 4.0, 260, 0.14` |
| `rust` | 1065 | md | heavy corrosion for pipes and drums | worley flake 16, fbm 16, worley pit 34, fbm surviving-paint 6 | `0.6, 2.4, 90, 0.24` |
| `paint` | 1093 | md | smooth industrial enamel (doors, housings) | fbm peel 34, fbm broad 5, worley chip 22, `fieldStreak` scuff | `0.2, 3.0, 120, 0.20` |
| `grating` | 1119 | md | galvanised bar grating | `fieldPlank(12)` bearing bars, `fieldPlank(4)` cross rods, fbm, worley spangle 20, fbm rust | `5.0, 2.2, **0**, 0.10` |
| `tile` | 1151 | md | grimy ceramic tile, 8×8 grid | `fieldBond(8,8,res/60)`, fbm 18, worley traffic 5, ridged crack 12, fbm grime 9 | `1.0, 3.2, 200, 0.10` |
| `plywood` | 1182 | md | plywood / timber, 5 planks | `fieldPlank(5)`, **`blurAxis`-smeared** fbm grain, worley knot 7, worley wear 16 | `0.9, 4.2, 180, 0.18` |
| `carpet` | 1208 | md | worn commercial carpet | fbm pile 44, worley loop 40, worley traffic 4, fbm stain 7 | `0.9, 3.4, 55, 0.08` |
| `ceiltile` | 1229 | md | acoustic ceiling tile, 4×4 | `fieldBond(4,4,res/44)`, worley pin 46, fbm stain 6, fbm grain 20 | `1.1, 4.0, 300, 0.12` |
| `glassfac` | 1252 | md | dirty glazing with mullions | `fieldBond(4,4,res/30)` frame, fbm dirt 10, `fieldStreak` | `1.4, 8.0, 340, 0.06` |

### `SURF` parameter glossary — what each one physically does

| key | consumed at | meaning |
|---|---|---|
| `set` | `:1795` `getSet(S.set)` | which baked set supplies map/normal/ORM |
| `tile` | `:1821`, `:2149`, `:1840` | **world units one texture repeat covers.** Divide world coords by it to get UVs. Also feeds `normalScale` correction and the macro period |
| `tint` | `:1804` `new THREE.Color(S.tint)` | material `.color`, a multiplier on the albedo. **sRGB-decoded** — `THREE.ColorManagement.legacyMode = false` is set by nz-render before this module builds anything. See the colour-management essay at `:1333-1361`: keep every wall inside 18–32 % effective reflectance, every floor 4–22 % |
| `nrm` | `:1821-1822` | pure artistic trim on the whole normal. `1.0` = exactly the millimetres the set was authored for. Scale correction for retiling is applied separately: `nsc = S.nrm * set.refTile / S.tile` |
| `macro` | `uNzA.y` `:1840` | strength of the world-space macro-breakup layer (albedo × roughness). Kills the tiling read. `0` disables |
| `grime` | `uNzA.z` `:1840` | **height in world units** over which floor grime fades out. `smoothstep(uNzA.z, 0.0, heightAboveFloor)` |
| `soot` | `uNzA.w` `:1840` | same but measured **down from the ceiling**. Killed outdoors by `step(nzSpan, 21.0)` |
| `grimeAmt` | `uNzB.x` `:1841` | overall multiplier on the combined grime+soot mask, `0..1` |
| `wetY` | `uNzB.y` `:1841` | **world Y of the flood line.** `-99` = never wet, `999` = wet everywhere (the rained-on street), `-4.0` = the flooded service tunnels |
| `wet` | `uNzB.z` `:1841` | strength of the wetness term. Drives roughness to `0.085` and albedo to `×0.52` |
| `desat` | `uNzC.y` `:1843` | how hard the surface is pulled toward its own luminance. **This is the level's chroma funnel** — the 94 baked point lights are sodium-warm and multiply everything (see `:1292-1299`). Scaled globally by `DESAT` (`:1363`, currently 1.00) |
| `occ` | `uNzC.x` `:1842` | contact-occlusion amount at the floor/ceiling junction |
| `det` | `uNzD.x/y` via `detailVec` `:1778-1788` | `[rate, mm]` — the detail-normal layer. `rate` is how many times tighter the second normal lookup tiles; `mm` is the RMS relief it should contribute at that finer scale, in real millimetres. `[0,0]` disables (correct for grating and glazing, where the base map already *is* the geometry) |
| `polish` | `uNzD.z` `:1781` | extra world-space roughness break on **up-facing faces only**: traffic lanes burnished into a floor. Elongated 4:1 along X |

Two module-level dials multiply the whole palette (`:1362-1368`):

```js
var DESAT  = 1.00;   /* scales every SURF.desat                */
var COOL   = 0.75;   /* cool bias in the shadows, CS2 signature */
var MACROC = 2.2;    /* contrast of the world-space macro field */
var GRIME_COL = [0.60, 0.57, 0.51];   /* cool-neutral soot, never a brown wash */
```

## 2.3 `emitSet` — the exact contract

```js
emitSet(res, alb, height, rough, metal, aoStrength, relief, name)
```

* `res` — `RES.hi` or `RES.md`.
* `alb` — `Float32Array(res*res*3)`, **0..255 per channel** (not 0..1). Built by
  `albNew(res, [r,g,b])` then mutated by `albMul` / `albTint` / `albUnitsMasked`.
* `height` — `Float32Array(res*res)`, 0..1, tileable.
* `rough` — `Float32Array(res*res)`, 0..1. Mutated in place by the roughness
  coupling.
* `metal` — `Float32Array(res*res)` or `null`.
* `aoStrength` — cavity-AO strength, typically 0.8–1.25.
* `relief` — `{ mm, tile, hp, rough }`:
  * `mm` — **RMS relief in real millimetres.** `emitSet` measures the actual
    standard deviation of the height field and solves the Sobel strength so the
    number is honoured whatever amplitude your expression happened to have and
    whatever tier the raster baked at (`:667-669`).
  * `tile` — the reference tiling in world units the number is quoted against.
  * `hp` — high-pass cutoff in millimetres. Content **broader** than this is
    removed from the height before differentiating, so the albedo and cavity AO
    keep the whole broad story and only the normal is restricted to genuine
    relief (`:648-657`). `0` disables — correct only when the pattern *is* the
    geometry (grating, bark, roof pantiles).
  * `rough` — how hard crowns are pushed chalkier than pits using the same
    high-passed field (`:672-676`). Decorrelating specular from relief is what
    stops a surface glittering.

`emitSet` will **warn loudly** if the implied swing exceeds 120 mm (`:722-724`) or
if the baked albedo comes out black (`:725`), and it repairs non-finite texels
rather than letting `Uint8ClampedArray` silently turn NaN into 0 (`:618-632`).
Real-construction reference, quoted at `:585-589`: rolled emulsion 0.2–0.4 mm RMS,
fair-faced concrete 1–2 mm, brickwork 2–3 mm (all of it in the raked joint),
bar grating 5 mm.

**Remember the scale trap (§0).** Set `METRES_PER_UNIT = 1/3.5` in your copy of
`emitSet` or every millimetre figure you write will ship at 47.6 % of its value.

## 2.4 The nine new sets you need

Tile sizes below are given at the **correct** scale, `tile_units = metres × 3.5`.

### 2.4.1 Painted cement render / stucco — `BUILD.render`
**Derive from `BUILD.plaster` (`:873-916`).** Copy it wholesale, then:

* frequency down: `orange` fbm 30 → 18, because the tile is now 3 m not 1.7 m.
* add a **float-trowel swirl**: `fieldStreak(res, seed, 5, 9, false)` *and*
  a second at `vertical = true`, blended at 0.18 — a rendered wall is finished
  in overlapping arcs and that is the only thing that separates render from
  drywall at 3 m.
* add a **damp plinth**: `albMul(a, verticalRamp, ...)` where `verticalRamp[i] =
  clamp(1 - (i / res / res) * 4, 0, 1)` — rising damp is the single most Turkish
  detail on a ground-floor facade. (Or leave it to the shader's `grime`.)
* base colour: pick per-building from `[214,204,182]` cream, `[196,190,178]` grey,
  `[188,178,158]` ochre, `[176,182,180]` pale green. **One bake, four `SURF` rows
  with different `tint`** — that is how `door`/`keydoor` share `paint`.
* `emitSet(res, a, h, rough, null, 0.85, { mm: 0.9, tile: m(3.0), hp: 260, rough: 0.20 })`
  → `tile: 10.5`.

Nothing from scratch.

### 2.4.2 Travertine / limestone cladding — `BUILD.travertine`
**Derive from `BUILD.precast` (`:975-1001`).** Changes:

* bond → real cladding: 600 × 300 mm panels on a 2.4 m tile (`tile: m(2.4) = 8.4`)
  is `fieldBond(res, 8, 4, Math.max(2, res / 140), seed, false)` — **no stagger**,
  cladding is laid in a stack bond.
* joint: `res/140` at 512 is 3.7 texels ≈ 6 mm open joint. Correct.
* **new, and it is the whole identity of travertine**: elongated vugs. One line:
  ```js
  var vug = blurAxis(worC(res, { cells: 30, seed: 202, invert: true }), res, Math.max(1, res / 10), false);
  ```
  then threshold it hard (`clamp((vug[i] - 0.72) * 5, 0, 1)`) and subtract 0.18
  from the height, tint toward `[168,158,140]`. Lens-shaped horizontal holes.
* vein: replace `precast`'s ridged fbm with `fieldStreak(res, seed, 7, 16, false)` —
  travertine bedding is horizontal, not turbulent.
* base `[206,196,176]`; unit spread `[218,208,188] [200,190,170] [212,202,182] [190,182,164]`.
* `emitSet(..., 1.0, { mm: 1.6, tile: 8.4, hp: 300, rough: 0.14 })`.

### 2.4.3 Red concrete roof tile — `BUILD.rooftile`
**Derive from `BUILD.tile` (`:1151-1178`) for the grid, but the corrugation is new.**
It is four lines and analytic, not noise:

```js
  /* a pantile is a 300 mm sinusoidal roll along the eaves direction plus a
     lap every 320 mm up the slope. Both are exact, both belong in height. */
  var rollN = 8, lapN = 8;                       /* on a 2.4 m tile */
  var roll = fnew(res), lap = fieldPlank(res, lapN, Math.max(2, res / 60), 231, false);
  for (var y = 0; y < res; y++) for (var x = 0; x < res; x++)
    roll[y * res + x] = 0.5 + 0.5 * Math.cos(x / res * TAU * rollN);
```

* height: `h[i] = clamp(0.30 + roll[i] * 0.52 + lap.m[i] * 0.14 + (grain[i]-.5)*.08, 0, 1)`.
* albedo: terracotta spread via `albUnitsMasked(a, lap.id, lap.m, [[152,76,52],[134,66,46],[118,58,42],[164,88,60]], 0.9)`,
  then **algae/lichen** — `albTint(a, fieldStreak(res, 233, 6, 12, true), [118,124,96], .30, .62, 1)` —
  which is what actually reads as "an old roof" from the street.
* `emitSet(..., 1.05, { mm: 6.0, tile: 8.4, hp: 0, rough: 0.12 })` — **`hp: 0`**,
  same reasoning as `grating` (`:1145-1147`): the corrugation *is* the geometry.

If any roof edge comes within ~40 units of the camera, model the eaves course as
real geometry (`tube` along the ridge, `boxC` for the verge) and keep the normal
map for the field only.

### 2.4.4 White PVC window frame — `BUILD.pvc`
**Derive from `BUILD.paint` (`:1093-1116`), one-line changes:**

* `chip` amount `0.70 → 0.10` and its roughness lerp target `0.86 → 0.62`. PVC
  does not chip to primer; it yellows and collects dirt in the corners.
* base `[166,170,172] → [232,231,226]`.
* `metal[i] = 0` everywhere (delete the metal array, pass `null`).
* roughness base `0.36 → 0.44` with variance `0.14` — PVC is a low satin, not enamel.
* `emitSet(..., 0.8, { mm: 0.15, tile: m(1.0), hp: 90, rough: 0.16 })` → `tile: 3.5`.

`SURF` row: `pvc: { set:'pvc', tile: 3.5, tint: 0xf2f2ef, nrm: 0.35, macro: 0.08,
grime: 1.4, soot: 0.0, grimeAmt: 0.55, wetY: -99, wet: 0.0, desat: 0.18,
occ: 0.60, det: [6.0, 0.04], polish: 0.0 }`. Low `desat` on purpose: white PVC
against a warm render is a *value* contrast you want to keep.

### 2.4.5 Automotive paint + glass — `BUILD.carpaint`, `BUILD.carglass`
Two sets. Both derive from existing ones; the material *type* is the new part.

**`carpaint`** — derive from `BUILD.paint`, delete the chip term entirely, add:

```js
  var flake = worC(res, { cells: 120, seed: 241, invert: true });   /* metallic flake */
  var swirl = fieldStreak(res, 242, 30, 5, false);                  /* polish swirls  */
  var film  = fieldStreak(res, 243, 4, 14, true);                   /* road film      */
```
roughness `0.20 + (swirl-.5)*.05 + film*.28`, metalness `0.55 + (flake-.5)*0.15`.
`emitSet(..., 0.6, { mm: 0.12, tile: m(2.0), hp: 90, rough: 0.08 })` → `tile: 7.0`.

The colour is **not** baked — bake it near-white (`[214,214,214]`) and drive every
car's paint from `extra.tint` on `surfaceMaterial`, exactly the `door`/`keydoor`
trick. One bake, a whole car park.

**Clearcoat.** `THREE.MeshPhysicalMaterial` *is* in the r149 core UMD bundle and
supports `clearcoat` / `clearcoatRoughness`. Use it for car paint only:

```js
  var m = new THREE.MeshPhysicalMaterial({
    map: set.map, normalMap: set.normalMap,
    roughnessMap: set.ormMap, metalnessMap: set.ormMap, aoMap: set.ormMap,
    color: new THREE.Color(bodyColour),
    roughness: 1.0, metalness: 1.0,
    clearcoat: 1.0, clearcoatRoughness: 0.055,
    vertexColors: true, dithering: true, fog: true
  });
  m.name = 'nzenv:carpaint';       /* see section 9.2 -- the prefix matters */
  m.envMapIntensity = 1.25;
```
Cost: one extra program permutation and a handful of ALU. It is the single
cheapest thing that makes a parked car stop reading as a painted box.

**`carglass`** — derive from `BUILD.glassfac` (`:1252-1270`) with the mullion
`fieldBond` deleted (car glass has no frame in the map; the frame is geometry).
Keep the dirt and the streaks, add a wiper arc:
```js
  var wipe = fnew(res);   /* two concentric arcs swept from a pivot near the base */
```
**Do not use `transparent: true` and do not use `transmission`.** Sorting a
transparent car window against the decal pile, the foliage cutouts and the street
is a bug farm, and `transmission` in r149 needs a scene render target. Ship an
opaque dark glass instead:

```js
  new THREE.MeshStandardMaterial({
    map: set.map, normalMap: set.normalMap, roughnessMap: set.ormMap,
    color: 0x11161c, roughness: 1.0, metalness: 0.0,
    vertexColors: true, dithering: true, fog: true
  });   // envMapIntensity = 1.8 -- the reflection IS the read
```
A dark opaque pane with a high `envMapIntensity` reads as glass from the street
and cannot sort wrong.

### 2.4.6 Conifer foliage — **not a tiling PBR set**
This is the one thing on the list that is genuinely from scratch, and the mistake
to avoid is trying to make it a `SURF` row.

Build an **alpha-cutout atlas**: a 512 canvas, 2 × 2 sprig tiles, each drawn with
plain 2D canvas strokes:

```js
  function sprig(g, ox, oy, ts, rnd, hue) {
    var i, n = 46;
    g.save(); g.translate(ox + ts * 0.5, oy + ts * 0.92);
    g.strokeStyle = hue; g.lineCap = 'round';
    for (i = 0; i < n; i++) {
      var t = i / n, side = (i & 1) ? 1 : -1;
      var L = ts * (0.30 - 0.22 * t) * (0.7 + rnd() * 0.6);
      var a = -PI * 0.5 + side * (0.75 - 0.25 * t) + (rnd() - 0.5) * 0.25;
      var by = -ts * 0.86 * t;
      g.lineWidth = ts * 0.010;
      g.beginPath(); g.moveTo(0, by);
      g.lineTo(Math.cos(a) * L, by + Math.sin(a) * L);
      g.stroke();
    }
    g.lineWidth = ts * 0.016; g.strokeStyle = 'rgba(72,60,44,1)';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -ts * 0.86); g.stroke();
    g.restore();
  }
```
Four tiles with four green ramps: `rgba(58,84,52,1)`, `rgba(74,98,58,1)`,
`rgba(46,70,46,1)`, `rgba(88,106,64,1)`. The alpha channel comes out of the
strokes for free — do **not** post-multiply it.

Material — and note what it does **not** have:

```js
  var m = new THREE.MeshStandardMaterial({
    map: foliageTex,
    alphaTest: 0.45,          /* NOT transparent: no sorting, writes depth      */
    side: THREE.DoubleSide,   /* r149 flips the normal on back faces for you    */
    roughness: 0.88, metalness: 0.0,
    vertexColors: true, dithering: true, fog: true
  });
  m.name = 'nzenv:foliage';
  m.envMapIntensity = 1.0;
  /* NO onBeforeCompile. Foliage must NOT get the grime / wetness / macro
     injection -- a leaf does not accumulate floor grime, and the world-space
     macro layer would blotch the canopy. Leaving onBeforeCompile unset means
     it inherits THREE.Material.prototype.onBeforeCompile, which IS nz-render's
     AO/PCSS patch, so it still gets contact shadows and specular occlusion. */
```
Give the interior cards a darker vertex colour (0.55–0.7) and the outer cards
0.95–1.0: that fake wrap-lighting gradient is 90 % of what makes a card tree read
as volume. No wind in v1 — a `render` hook is a per-frame cost and a per-frame
risk for a static street.

### 2.4.7 Tree bark — `BUILD.bark`
**Derive from `BUILD.plywood` (`:1182-1204`)** — it already has the exact machinery
(a directionally smeared fbm grain plus knots). Replace the plank field with
vertical fissures:

```js
  var fis = blurAxis(fbmC(res, { octaves: 5, frequency: 20, seed: 251, ridged: true }),
                     res, Math.max(1, res / 6), true);      /* smear DOWN the trunk */
```
height `0.46 + (fis-.5)*.46 + (grain-.5)*.14 - clamp((0.2-knot)*4,0,1)*.20`;
base `[96,86,74]`; lichen `albTint(a, worC(res,{cells:9,seed:253}), [140,146,120], .26, .68, 1)`.
`emitSet(..., 1.15, { mm: 6.0, tile: m(0.6), hp: 0, rough: 0.18 })` → `tile: 2.1`,
**`hp: 0`** — bark relief really is 5–10 mm and the fissures *are* the geometry.

### 2.4.8 Interlocking concrete pavers — `BUILD.paver`
**Derive from `BUILD.tile` (`:1151-1178`).** Two changes:

* `fieldBond(res, 8, 4, Math.max(2, res / 90), 261, true)` — 200 × 100 mm units in
  a stretcher bond on a 0.8 m tile (`tile: m(0.8) = 2.8`), stagger on.
* **The arris is BRIGHT, not dark**, and this is the whole tell. A paver has a
  3 mm chamfer that catches sky; only the joint *centre* is dark. Two thresholds:
  ```js
  var e = clamp((1 - bond.m[i]) * 1.0, 0, 1);          /* distance into the joint */
  var arris = clamp((e - 0.15) / 0.45, 0, 1) * (1 - clamp((e - 0.60) / 0.40, 0, 1));
  ```
  `albTint(a, arris, [186,182,174], .55, 0, 1)` then `albTint(a, joint, [78,76,72], .85, .55, 1)`
  where `joint = clamp((e-0.7)/0.3, 0, 1)`.
* unit spread: five greys plus two reds — `[168,164,156] [152,148,142] [176,172,164]
  [140,138,132] [158,152,144] [150,102,86] [136,92,78]`.
* `emitSet(..., 1.1, { mm: 2.2, tile: 2.8, hp: 0, rough: 0.16 })` — `hp: 0`, the
  chamfer is real relief at exactly this frequency.

### 2.4.9 Rusted / painted steel railing — **nothing new to bake**
`BUILD.steel` (`:1008-1061`) already *is* painted steel worn to bright metal with
rust blooming from the low spots and a proper metalness map (paint 0.02, rust 0.18,
bare steel 0.95). `BUILD.rust` (`:1065-1089`) is the heavy-corrosion variant.
Add `SURF` rows only:

```js
railing: { set:'steel', tile: 1.4, tint: 0x5f6a63, nrm: 1.10, macro: 0.16,
           grime: 2.0, soot: 0.0, grimeAmt: 0.55, wetY: 999, wet: 0.22,
           desat: 0.42, occ: 0.75, det: [6.0, 0.08], polish: 0.0 }
```
`tile: 1.4` = 0.4 m, so a 40 mm rail member gets a tenth of a repeat across it —
the right density for a thin section. Use `makeRustMaterial()`'s pattern
(`:3438-3468`) verbatim if you want the heavily corroded variant for a
back-alley railing.

### Summary of derivations

| new set | derive from | genuinely new code |
|---|---|---|
| render / stucco | `plaster` | trowel swirl (2 lines) |
| travertine | `precast` | horizontal vugs (2 lines) |
| rooftile | `tile` | analytic cosine roll (4 lines) |
| pvc | `paint` | none — parameter changes only |
| carpaint | `paint` | flake + swirl + film (3 lines) + `MeshPhysicalMaterial` |
| carglass | `glassfac` | wiper arc (optional) |
| foliage | — | **all of it** (canvas sprig atlas, ~40 lines) |
| bark | `plywood` | vertical fissure smear (1 line) |
| paver | `tile` | bright-arris double threshold (3 lines) |
| railing | `steel` | none — a `SURF` row |

---

# 3. Texel density and UV rebuild

## 3.1 The rule, in one sentence

**Every UV in this pass is `worldCoordinate / tile`, projected on the face's
dominant normal axis.** No exceptions, no per-object unwrap, no fitted UVs.
That is what §2 of the file header (`nz-env.js:20-25`) means by "adjacent surfaces
cannot disagree about scale, which is the single loudest amateur tell in a
blockout."

## 3.2 The world-mesh path — `retargetWorldMesh` (`:2123-2239`)

```js
    var inv = 1 / S.tile;
    ...
    var vertical = Math.abs(ny) > 0.7;         /* NOTE: means the NORMAL is vertical,
                                                  i.e. a HORIZONTAL face. Misleading
                                                  name, but it is the shipped name. */
    ...
    if (vertical) { u0 = x * inv; v0 = z * inv; }                     /* floor/ceiling: XZ */
    else if (Math.abs(nx) > Math.abs(nz)) { u0 = z * inv; v0 = y * inv; }  /* wall facing X: ZY */
    else { u0 = x * inv; v0 = y * inv; }                              /* wall facing Z: XY */
```

Then both `uv` **and** `uv2` are set from the same buffer (`:2225-2227`) because
`aoMap` reads `vUv2` in r149. Sharing one `Float32BufferAttribute` object between
the two attribute slots is deliberate and costs nothing.

## 3.3 The prop path — `poly()` (`:1913-1952`)

Identical rule, computed per-polygon from the summed Newell normal:

```js
    var ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    var mode = (ay >= ax && ay >= az) ? 1 : (ax >= az ? 0 : 2);
    var t = pile.ctxTile;                       /* == 1 / tile */
    ...
      if (mode === 1) { u = p[0] * t; v = p[2] * t; }        /* up/down  -> XZ */
      else if (mode === 0) { u = p[2] * t; v = p[1] * t; }   /* +-X face -> ZY */
      else { u = p[0] * t; v = p[1] * t; }                   /* +-Z face -> XY */
```

`pile.ctxTile` is set by **`Pile.prototype.context(f, c, amb, tile)`** (`:1869-1873`),
which stores `this.ctxTile = 1 / (tile || 4)`. This is the single function a new
module must call before every emit, and getting it wrong is the difference between
a pipe that agrees with the wall behind it and one that does not.

**Consequence you must respect:** a prop can only be retiled by changing
`pile.context`'s 4th argument between emits. nz-env does exactly this — the drums
at `:2771` use `SURF.metal.tile * 0.55`, the pallets at `:2779` use
`SURF.wood.tile * 0.5`, the services at `:2686` use `SURF.metal.tile * 0.6`.
Because the *material* is shared across the whole pile, the only place the density
can vary is here.

## 3.4 The `normalScale` correction (`:1814-1822`)

A set is baked for **one** reference tiling (`set.refTile`, which is `relief.tile`)
and then reused at whatever `S.tile` the surface wants. Stretch a normal map
without correcting and its implied relief stretches with it:

```js
    var nsc = S.nrm * (set.refTile > 0 && S.tile > 0 ? set.refTile / S.tile : 1);
    m.normalScale = new THREE.Vector2(nsc, nsc);
```

Same correction inside `detailVec` (`:1778-1788`):

```js
    var ratio   = S.tile / set.refTile;
    var rateEff = rate * ratio;                      /* fixed WORLD wavelength   */
    var amount  = clamp(rateEff * detMM / set.reliefMM, 0, 6);
    return new THREE.Vector4(rateEff, amount, polish, 0);
```

## 3.5 The three helpers your module must call

1. **`pile.context(floorY, ceilY, amb, tile)`** — before every emit. Sets the UV
   scale, the `nzFC` attribute values, and the ambient used by `litAt`.
2. **`poly(pile, pts, refX, refY, refZ, ao)`** — the only vertex emitter. Never
   push vertices by hand except for decals and emissive cards.
3. **`surfaceMaterial(key, extra)`** (`:1790-1853`) — the only material factory.
   It applies `normalScale` correction, builds `__nzEnv`, and installs the patch.

## 3.6 Tile sizes to author for the street (at 3.5 u/m)

| surface | real repeat | `tile` (units) |
|---|---|---|
| painted render / stucco | 3.0 m | **10.5** |
| travertine cladding | 2.4 m | **8.4** |
| red roof tile | 2.4 m | **8.4** |
| brick (if you re-bake it correctly) | 2.4 m at 32 courses = 75 mm | **8.4** |
| PVC frame | 1.0 m | **3.5** |
| car paint | 2.0 m | **7.0** |
| bark | 0.6 m | **2.1** |
| concrete pavers | 0.8 m | **2.8** |
| steel railing | 0.4 m | **1.4** |
| asphalt road (match nz-env, do not fight it) | — | **10.0** |

The last row matters: the roadway mesh is a **world mesh** already owned by nz-env
(`ftex: 'street'`). Do not retile it. Your pavers and your kerbs must simply look
correct *next to* it.

---

# 4. The shared `onBeforeCompile` injection

## 4.1 Why there is exactly one function object

`nz-env.js:1377-1382`:

> One function object for every material in this module, so three's
> `customProgramCacheKey` (which is `onBeforeCompile.toString()`) resolves to
> ONE program for the whole level instead of one per material.

r149's `Material.prototype.customProgramCacheKey()` returns
`this.onBeforeCompile.toString()`. nz-render **overrides that prototype method**
(`nz-render.js:1080`) with `nzCacheKey` (`:1067-1072`), which returns
`patchKey + '|nz'` for its own function, `patchKey + '|w|' + String(inner)` for a
wrapped foreign one, and `patchKey + '|' + String(f)` otherwise.

**Practical consequence for you:** one distinct injection function = one extra
program. Use exactly one for your whole module. Two identical function *sources*
(even different objects) hash to the same key, so copying `nzEnvPatch` verbatim
would actually share nz-env's program — but do not rely on that; write your own
and accept one extra compile.

## 4.2 Everything the injection declares

**Vertex head — `VERT_HEAD` (`:1581-1588`):**

```glsl
attribute vec3 nzFC;
varying vec3 vNzWP;    // world position
varying vec3 vNzWN;    // world normal
varying vec3 vNzFC;    // (floorY, ceilY, distance to nearest solid cell)
```

**Vertex body — spliced at two anchors (`:1706-1710`):**

```js
v = v.replace(MAIN_RE, VERT_HEAD + '\nvoid main() {');
v = v.replace('#include <beginnormal_vertex>',
  '#include <beginnormal_vertex>\n  vNzWN = normalize( mat3( modelMatrix ) * objectNormal );');
v = v.replace('#include <begin_vertex>',
  '#include <begin_vertex>\n  vNzWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vNzFC = nzFC;');
```

**Fragment head — `FRAG_HEAD` (`:1539-1579`):**

```glsl
uniform vec4 uNzA;      // (tile/24, macro, grime, soot)
uniform vec4 uNzB;      // (grimeAmt, wetY, wet, set.mean)
uniform vec4 uNzC;      // (occ, desat*DESAT, COOL, MACROC)
uniform vec4 uNzD;      // (detailRate, detailAmount, floorPolish, unused)
uniform vec3 uNzGrime;  // GRIME_COL
varying vec3 vNzWP;
varying vec3 vNzWN;
varying vec3 vNzFC;
float nzMacro = 0.5;
float nzGrime = 0.0;
float nzWet   = 0.0;
float nzOcc   = 0.0;
float nzHash( vec3 p ) { ... }     // 3D value-noise hash
float nzN( vec3 x )    { ... }     // trilinear value noise
#ifdef USE_NORMALMAP
vec3 nzMapN( vec2 uv ) {           // two-tap detail normal
  vec3 b = texture2D( normalMap, uv ).xyz * 2.0 - 1.0;
  if ( uNzD.y <= 0.0 ) return b;
  vec2 duv = vec2( uv.y, -uv.x ) * uNzD.x + vec2( 0.3173, 0.6817 );
  vec3 d = texture2D( normalMap, duv ).xyz * 2.0 - 1.0;
  return vec3( b.xy + d.xy * uNzD.y, b.z );
}
#endif
```

## 4.3 The four fragment anchors and what goes at each

`ANCHORS_F` (`:1662-1663`):

| anchor | injected | lines |
|---|---|---|
| `#include <color_fragment>` | `INJ_MAP` | `1383-1476` |
| `#include <roughnessmap_fragment>` | `INJ_ROUGH` | `1478-1498` |
| `#include <metalnessmap_fragment>` | `INJ_METAL` | `1500-1502` |
| `#include <lights_fragment_end>` | `INJ_AO` (**before** it) | `1506-1511` |

`ANCHORS_V` (`:1654`): `#include <beginnormal_vertex>`, `#include <begin_vertex>`.

**Why `<color_fragment>` and not `<map_fragment>`** — `:1655-1661`. three applies
vertex colours in `color_fragment`, *after* `map_fragment`. The vertex colours here
are the game's baked point lighting, which is where essentially all of the level's
salmon/cream cast comes from. Injecting earlier would leave the one term that most
needs desaturating untouched, and would let grime and contact AO be multiplied
straight back out by a warm light.

## 4.4 The terms `INJ_MAP` computes, in order

1. **Macro breakup** (`:1395-1397`). Two octaves of world-space value noise at
   period 21 and 7.3 units, contrast `uNzC.w` (`MACROC` = 2.2), blended by
   `uNzA.y` (`S.macro`). Not an albedo tap — the note at `:1385-1394` explains why
   that measured ±3 % and was replaced.
2. **Vertical story** (`:1402-1409`). `nzSpan = vNzFC.y - vNzFC.x`,
   `nzHF = vNzWP.y - vNzFC.x`. Grime rises off the *real* floor of *this* room and
   soot falls from the *real* ceiling, so a 34-unit street canyon and a 7-unit
   corridor grime at their own scale. Soot is killed outdoors by `step(nzSpan, 21.0)`.
   Everything gated on `nzSpan > 0.5`.
3. **Contact occlusion** (`:1416-1436`). `nzSide = 1 - abs(vNzWN.y)`: vertical faces
   darken over the bottom 1.35 units, up-facing faces darken over 1.40 units of
   `vNzFC.z` (distance to the nearest solid cell). Result multiplies albedo by
   `1 - 0.62 * nzOcc`.
4. **Standing water** (`:1438-1441`). `smoothstep(wetY+3.5, wetY-1.0, y) * up * wet
   * smoothstep(0.28, 0.74, nzMacro)` — puddles follow the macro field so they are
   patchy, not a sheet.
5. **Desaturation** (`:1446-1447`) toward luminance by `uNzC.y`.
6. **Cool bias** (`:1472-1474`), weighted `(0.35 + 0.65*(1-nzL))` and by `nzSide`
   so walls get the full pull and floors 30 % of it. The essay at `:1448-1471`
   is worth reading before you touch `COOL`: it is a *legibility* term, not a look.

`INJ_ROUGH` adds the macro roughness break, the **traffic polish** term
(`uNzD.z`, up-facing only, elongated 4:1 along X), then folds grime, occlusion and
wetness into roughness and clamps to `0.035..1.0`.

`INJ_AO` puts occlusion on the **indirect** term too (`:1504-1511`):
`irradiance *= (1 - 0.55*nzOcc); iblIrradiance *= (1 - 0.70*nzOcc);` — a crease that
is only albedo-dark still reads as a painted stripe under a bright probe.

## 4.5 The vertex attribute — `nzFC`

`nzFC` is **created entirely by nz-env**. `grep -c nzFC NUKEM.html` → **0**.

* World meshes get it in `retargetWorldMesh` (`:2146`, `:2173-2183`, `:2228`):
  `(regionFloorY, regionCeilY, wallDistance)`. `wallDistance` is `wallDist(x,z)`
  (`:2092-2109`) for horizontal faces and the constant `9` for vertical ones.
* Prop piles get it in `Pile.prototype.vert` (`:1884`):
  `this.fc.push(this.ctxF, this.ctxC, 9)`. The constant `9` is an **opt-out**:
  props already hug a wall by construction and carry their own chamfer AO, so
  they must not inherit a default `0` and go black along every up-facing facet.
* Geometry with **no** `nzFC` attribute reads the generic constant `(0,0,0)`, so
  `nzSpan = 0`, and every term gated on `nzSpan > 0.5` switches itself off. That is
  the designed failure mode — see the note at `:1427-1430`.
* Doors and lifts pass `context(0, 0, ...)` (`:3086`, `:3129`) — span 0 — because
  they **move**, and world-space floor grime would slide down the leaf as it opens.
  **Any moving prop in your module must do the same.**

## 4.6 The chaining rule — the single most important paragraph in the file

`nz-env.js:1671-1685`:

```js
    var proto = THREE.Material.prototype.onBeforeCompile;
    if (typeof proto === 'function' && proto !== nzEnvPatch) {
      try { proto.call(this, shader, rendererArg); DIAG.chained++; }
      catch (e) { DIAG.chainErr = String(e && e.message || e); }
    }
```

nz-render patches `THREE.Material.prototype.onBeforeCompile` to splice its
screen-space AO, contact shadows, specular occlusion and PCSS into every lit
material. Assigning your own `onBeforeCompile` as an **own property shadows that
prototype method** — every surface you own would silently opt out of nz-render's
entire lighting patch. Call the prototype first, then layer yours on top; the two
touch disjoint anchors.

This is idempotent: `nzOnBeforeCompile` returns early if `MAT_MARK` is already in
the source (`nz-render.js:993`), and `wrapForeignMaterials` skips anything already
wrapped (`:1053`). So the belt-and-braces of manual chaining **plus** nz-render's
later wrap is safe.

## 4.7 How your module opts a material IN

Three things, all inside your `surfaceMaterial` equivalent:

```js
  m.__nzStreet = {                                       /* your own key name    */
    a: new THREE.Vector4(S.tile / 24, GLSL_OK ? S.macro : 0, S.grime, S.soot),
    b: new THREE.Vector4(S.grimeAmt, S.wetY, S.wet, fin(set.mean, 0.2) || 0.2),
    c: new THREE.Vector4(S.occ, clamp(S.desat * DESAT, 0, 1), COOL, MACROC),
    d: detailVec(S, set),
    grime: new THREE.Vector3(GRIME_COL[0], GRIME_COL[1], GRIME_COL[2])
  };
  if (GLSL_OK) m.onBeforeCompile = nzStPatch;
```

and the geometry must carry a `nzFC` attribute (your `Pile` does it automatically).

**`S.tile / 24`** is `uNzA.x`: the macro period is ~24 world units regardless of the
tile size, so every surface breaks up at the same architectural scale (`:1837-1838`).
It is currently unread by the GLSL — kept for symmetry; do not remove it.

## 4.8 How to opt a material OUT

Simply **do not set `onBeforeCompile`**. The material then inherits
`THREE.Material.prototype.onBeforeCompile`, which is nz-render's patch — so it
still gets AO, contact shadows and PCSS, but none of the grime/wetness/macro/desat.

Opt out for: **foliage** (a leaf has no floor grime), **car paint and car glass**
(a car is not a building; grime and the desat pull would flatten the body colour
you carefully chose), **emissive lens cards** (`MeshBasicMaterial`, `:3271-3274`),
and **any sign lettering** (§8.5).

Opt in for: facades, plinths, cladding, roofs, pavers, kerbs, railings, planters,
bins, meters, anything architectural.

## 4.9 `validateGLSL()` — copy it (`:1597-1650`)

A GLSL error inside `onBeforeCompile` **does not throw** — it silently renders black,
and a module cannot see the screen. `validateGLSL()` compiles the injected snippets
standalone against the real GL context before letting them near the level, and
`install()` gates everything on the result (`:3200-3206`):

```js
    GLSL_OK = validateGLSL();
    DIAG.glslProbe = GLSL_OK;
    VDESAT = GLSL_OK ? 0.15 : 0.55;
    if (!GLSL_OK) warn('shader detail layer disabled (GLSL probe failed); ...');
```

Note `#define USE_NORMALMAP` in the probe's fragment source (`:1622`) — deliberate,
so `nzMapN` is actually compiled. A probe that skips it cannot catch a typo in the
one function every surface routes its normal through.

## 4.10 The detail-normal substitution trap (`:1717-1756`)

Read this before you copy `nzEnvPatch`. The anchor **must be the `#include`
directive**, not the expression:

```js
    var NRM_INC   = '#include <normal_fragment_maps>';
    var NRM_SRC   = 'texture2D( normalMap, vUv ).xyz * 2.0 - 1.0';
    var NRM_CHUNK = (THREE.ShaderChunk && THREE.ShaderChunk.normal_fragment_maps) || '';
    if (f.indexOf(NRM_INC) >= 0 && NRM_CHUNK.indexOf(NRM_SRC) >= 0) {
      f = f.split(NRM_INC).join(NRM_CHUNK.split(NRM_SRC).join('nzMapN( vUv )'));
      DIAG.detailOK++;
    } else if (f.indexOf(NRM_SRC) >= 0) {
      f = f.split(NRM_SRC).join('nzMapN( vUv )');
      DIAG.detailOK++;
    } else {
      DIAG.detailMiss++;
      /* warn once */
    }
```

three resolves `#include` directives in `WebGLProgram`, **after** `onBeforeCompile`
returns, so at patch time the expression is not in the source at all. Expand the
chunk yourself, substitute inside the expansion, splice the result in place of the
directive. `split/join` rather than `replace()` because the chunk carries the same
expression twice.

---

# 5. Vertex AO and tone jitter

## 5.1 Where the vertex colour comes from

The game bakes a night-time light solution into the level's vertex colours
(`buildWorld` → `quad3` → `lightAt`, `NUKEM.html:2885-2905`), and
`makeWorldMaterial` sets `vertexColors: true`, so that bake is a **multiplier on
albedo**. nz-env keeps it and multiplies its own contact AO into the same attribute.

`litAt(x, y, z, nx, ny, nz, amb)` (`nz-env.js:203-223`) is nz-env's memoised wrapper
around the game's own `lightAt`:

```js
  var q = 1 / 0.7;
  var nb = (Math.abs(nx) > Math.abs(ny) && Math.abs(nx) > Math.abs(nz)) ? (nx > 0 ? 0 : 1)
         : (Math.abs(ny) >= Math.abs(nz) ? (ny > 0 ? 2 : 3) : (nz > 0 ? 4 : 5));
  var key = ((((Math.round(x*q)+64)*1024 + (Math.round(z*q)+64))*512) + (Math.round(y*q)+64))*8 + nb;
```

`lightAt` walks all 94 lights and raycasts the grid for each, so calling it once per
emitted polygon (~40k) is **minutes** of work. Quantising to 0.7 units and six
normal buckets collapses a whole chamfered prop to a handful of real evaluations
with no visible banding. `STATS.litCacheHitRate` reports the hit rate (`:3328`).

`desatRGB(c)` (`:195-202`) pulls each sample toward its own luminance by `VDESAT`,
which is `0.15` when the shader is live and `0.55` when it is not (`:3205`) —
because a fallback that leaves the level salmon-pink is not a fallback.

## 5.2 Contact darkening on world meshes (`:2185-2221`)

Two rules, both pure functions of vertex position so they stay continuous across
adjacent quads:

```js
  var ao = 1;
  if (vertical) {                                   /* up/down facing */
    ao = 1 - 0.62 * Math.pow(cornerOcc(x, z, fY), 0.75);
  } else {                                          /* a wall         */
    var alongZ = Math.abs(nx) > Math.abs(nz);
    var coord = alongZ ? z : x, cellIdx = alongZ ? cy : cx;
    var low = (coord / CELLSZ - cellIdx) < 0.5, step = low ? -1 : 1;
    if (solidCell(cx + (alongZ ? 0 : step), cy + (alongZ ? step : 0))) ao = 0.62;
    if (Math.abs(y - fY) < 0.05) ao *= 0.78;
    if (cY - fY > 0.5 && cY - fY < 21 && Math.abs(y - cY) < 0.05) ao *= 0.86;
  }
```

`cornerOcc(wx, wz, refF)` (`:2112-2121`) counts how many of the four cells sharing
a grid corner are solid or step up more than 1.4 units, and returns `s/4`.

**No per-cell tone jitter** — and the comment at `:2209-2215` is emphatic about why:
the level is one quad per 4-unit cell, so any per-face constant lands as a
hard-edged checkerboard at cell boundaries, the exact opposite of the break-up it
is meant to give. The shader's macro layer does that job at a scale that ignores
the grid.

## 5.3 Contact darkening on props

`poly()` (`:1934-1938`) does two things:

```js
    /* down-facing polygons read as cavity: cheap contact shading */
    var sh = (ao === undefined ? 1 : ao) * (1 - 0.22 * clamp(-ny, 0, 1));
    var col = litAt(cx + nx * 0.28 + pile.ox, cy + ny * 0.28 + pile.oy,
                    cz + nz * 0.28 + pile.oz, nx, ny, nz, pile.ctxAmb);
```

* the light is sampled at the face centre **pushed 0.28 units out along the
  normal**, so it does not sample inside its own solid;
* `pile.ox/oy/oz` is the `origin()` offset for meshes built around a local origin
  (doors, lifts) — without it a door takes the lighting of world (0,0,0), inside a
  wall (`:1862-1867`);
* down-facing polys are 22 % darker for free.

Per-facet `ao` values nz-env actually uses: `1` for main faces, `0.95` for brackets
and kerb rails, `0.94`/`0.92` for crate banding and door panels, `0.90`/`0.86` for
drum hoops and profile end caps.

## 5.4 What your module must add — ground contact

Props in nz-env **opt out** of the shader's floor-junction ramp (`nzFC.z = 9`) and
rely only on `poly`'s down-face term. For a street of parked cars and trees that is
not enough: a car with no contact darkening reads as a sticker on the road.

Add a per-vertex ground ramp to your copy of `poly()`. Three lines, marked below:

```js
  /* --- ADDED: ground contact -------------------------------------------- */
  var CONTACT_H = 1.6;      /* 0.46 m of ramp                                */
  var CONTACT_K = 0.42;     /* 42% darker where the prop meets the ground    */

  Pile.prototype.ground = function (y) { this.ctxG = y; return this; };
  /* ...and in Pile(): this.ctxG = -1e9;  (a prop that never calls ground()
     gets no ramp, exactly like nz-env today) */

  /* inside poly()'s vertex loop, replacing pile.vert(...): */
      var gk = 1 - CONTACT_K * (1 - clamp((p[1] - pile.ctxG) / CONTACT_H, 0, 1));
      pile.vert(p[0], p[1], p[2], nx, ny, nz, u, v, r * gk, gg * gk, bb * gk);
```

**And** drop a soft contact decal under every car and every tree — a radial-gradient
blob tile in your decal atlas, placed as a horizontal `decalQuad` at
`floorY + 0.04`. That is the CS2 way, it costs four vertices, and it is the single
highest-value thing on this list for making a car sit on a road.

## 5.5 The thing that will silently ruin your exposure

`nz-render.js:2282-2288`:

```js
  function bakedMatName(m) {
    if (!m || !m.name) return null;
    var s = String(m.name);
    if (s.indexOf('world:') === 0) return s.slice(6);
    if (s.indexOf('nzenv:') === 0) return s.slice(6);
    return null;
  }
```

`neutralizeBakedLighting()` (`:2293-2352`, run on `ready` at priority **-1000**)
walks the scene and remaps the vertex-colour attribute of every mesh whose material
name matches, through `bakeCurve` (`:2260-2268`): a calibrated compression that
takes the bake's 20.7:1 dynamic range down to 6.3:1 so the live light rig can carry
the image. Materials with `vertexColors: false` get the same treatment applied to
`material.color`.

**If you bake vertex colours from `litAt()` and your material is not named
`nzenv:*` or `world:*`, your geometry will be up to 4.5 stops out of exposure
against everything around it.** Name your materials `'nzenv:' + something`.
Yes, even though you are not nz-env — the prefix is the *namespace of the bake*,
not the owner. (`nz-env.js:1811` uses `'nzenv:' + ck`; `:2602` `'nzenv:decal'`;
`:3447` `'nzenv:rust'`; `:3274` `'nzenv:lens'`.)

`InstancedMesh` is **skipped** by this pass (`nz-render.js:2298`) — see §6.6.

---

# 6. Prop construction — the reusable toolkit

There is no `BufferGeometryUtils` in r149 (`CS2-BRIEF.md:52-54`). `Pile` **is** the
hand-written merge.

## 6.1 `Pile` — the merge (`nz-env.js:1858-1906`)

```js
  function Pile() {
    this.p = []; this.nm = []; this.uv = []; this.c = []; this.fc = []; this.idx = [];
    this.n = 0;
    this.ctxF = 0; this.ctxC = 0; this.ctxAmb = AMB_FALLBACK; this.ctxTile = 0.25;
    this.ox = 0; this.oy = 0; this.oz = 0;
  }
  Pile.prototype.context = function (f, c, amb, tile) {
    this.ctxF = f; this.ctxC = c; this.ctxAmb = amb || AMB_FALLBACK;
    this.ctxTile = 1 / (tile || 4);
    return this;
  };
  Pile.prototype.origin = function (x, y, z) {
    this.ox = x || 0; this.oy = y || 0; this.oz = z || 0;
    return this;
  };
  Pile.prototype.vert = function (x, y, z, nx, ny, nz, u, v, r, g, b) {
    this.p.push(x, y, z); this.nm.push(nx, ny, nz); this.uv.push(u, v);
    this.c.push(r, g, b); this.fc.push(this.ctxF, this.ctxC, 9);
    return this.n++;
  };
  Pile.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Pile.prototype.empty = function () { return this.n === 0; };
  Pile.prototype.geometry = function () {
    var g = new THREE.BufferGeometry(), i;
    for (i = 0; i < this.p.length; i++) if (!isFinite(this.p[i])) this.p[i] = 0;
    for (i = 0; i < this.uv.length; i++) if (!isFinite(this.uv[i])) this.uv[i] = 0;
    for (i = 0; i < this.c.length; i++) if (!isFinite(this.c[i])) this.c[i] = 0.4;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal',   new THREE.Float32BufferAttribute(this.nm, 3));
    var uv = new THREE.Float32BufferAttribute(this.uv, 2);
    g.setAttribute('uv', uv);
    g.setAttribute('uv2', uv);           /* aoMap reads vUv2; share the buffer */
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('nzFC',  new THREE.Float32BufferAttribute(this.fc, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) g.boundingSphere = null;
    OWN.geo.push(g);
    return g;
  };
```

Note the three non-finite scrubs before upload and the bounding-sphere guard:
a single NaN position gives you an infinite bounding sphere and the mesh either
never culls or never draws.

## 6.2 `poly` — the only vertex emitter (`:1913-1952`)

```js
  function poly(pile, pts, rx, ry, rz, ao) {
    var n = pts.length, i;
    if (n < 3) return;
    var cx = 0, cy = 0, cz = 0;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
    cx /= n; cy /= n; cz /= n;
    var nx = 0, ny = 0, nz = 0;
    for (i = 0; i < n; i++) {                       /* Newell */
      var a = pts[i], b = pts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    var flip = (nx * (cx - rx) + ny * (cy - ry) + nz * (cz - rz)) < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }

    var ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    var mode = (ay >= ax && ay >= az) ? 1 : (ax >= az ? 0 : 2);
    var t = pile.ctxTile;
    var sh = (ao === undefined ? 1 : ao) * (1 - 0.22 * clamp(-ny, 0, 1));
    var col = litAt(cx + nx * 0.28 + pile.ox, cy + ny * 0.28 + pile.oy,
                    cz + nz * 0.28 + pile.oz, nx, ny, nz, pile.ctxAmb);
    var r = col[0] * sh, gg = col[1] * sh, bb = col[2] * sh;

    var base = pile.n, k;
    for (i = 0; i < n; i++) {
      var p = pts[i], u, v;
      if (mode === 1) { u = p[0] * t; v = p[2] * t; }
      else if (mode === 0) { u = p[2] * t; v = p[1] * t; }
      else { u = p[0] * t; v = p[1] * t; }
      pile.vert(p[0], p[1], p[2], nx, ny, nz, u, v, r, gg, bb);
    }
    for (k = 1; k < n - 1; k++) {
      if (flip) pile.tri(base, base + k + 1, base + k);
      else pile.tri(base, base + k, base + k + 1);
    }
  }
```

The **reference interior point** `(rx, ry, rz)` is what makes 26 facets of a
chamfered box all face outward without you tracking winding. Pass the box centre,
the tube midpoint, or any point demonstrably inside the solid.

## 6.3 `boxC` — the chamfered box (`:1958-1997`)

```js
  function boxC(pile, cx, cy, cz, hx, hy, hz, k, ao) {
    k = Math.min(k, hx * .49, hy * .49, hz * .49);
    var h = [hx, hy, hz], c = [cx, cy, cz];
    function P(axis, s0, s1, s2) {
      var s = [s0, s1, s2], o = [0, 0, 0];
      for (var i = 0; i < 3; i++) o[i] = c[i] + s[i] * (i === axis ? h[i] : h[i] - k);
      return o;
    }
    var S = [-1, 1], i, j, l;
    for (i = 0; i < 3; i++) for (j = 0; j < 2; j++) {          /* 6 faces */
      var s = S[j], a1 = (i + 1) % 3, a2 = (i + 2) % 3;
      var q = [], sg = [[-1,-1],[1,-1],[1,1],[-1,1]];
      for (l = 0; l < 4; l++) {
        var sv = [0,0,0]; sv[i] = s; sv[a1] = sg[l][0]; sv[a2] = sg[l][1];
        q.push(P(i, sv[0], sv[1], sv[2]));
      }
      poly(pile, q, cx, cy, cz, ao);
    }
    for (i = 0; i < 3; i++) for (j = i + 1; j < 3; j++) {      /* 12 edge quads */
      var ax3 = 3 - i - j;
      for (var si = 0; si < 2; si++) for (var sj = 0; sj < 2; sj++) {
        var s1 = S[si], s2 = S[sj], q2 = [];
        var vA = [0,0,0], vB = [0,0,0];
        vA[i] = s1; vA[j] = s2; vA[ax3] = -1;
        vB[i] = s1; vB[j] = s2; vB[ax3] =  1;
        q2.push(P(i, vA[0], vA[1], vA[2]));
        q2.push(P(i, vB[0], vB[1], vB[2]));
        q2.push(P(j, vB[0], vB[1], vB[2]));
        q2.push(P(j, vA[0], vA[1], vA[2]));
        poly(pile, q2, cx, cy, cz, ao);
      }
    }
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var cq = 0; cq < 2; cq++) {
      var t0 = S[a], t1 = S[b], t2 = S[cq];                    /* 8 corner tris */
      poly(pile, [P(0,t0,t1,t2), P(1,t0,t1,t2), P(2,t0,t1,t2)], cx, cy, cz, ao);
    }
  }
```

Cost: **96 vertices, 44 triangles** per box. Chamfer `k` is typically 0.03–0.10.
`CS2-BRIEF.md:72-73`: "a pure 90° edge is the #1 tell of a prototype."

## 6.4 `tube` — capped cylinder (`:2001-2025`)

```js
  function tube(pile, ax, ay, az, bx, by, bz, r, seg, ao, cap) { ... }
```

Builds an orthonormal frame from the axis, emits `seg` side quads and (unless
`cap === false`) two end polygons. Used for every pipe, conduit, rail, drum and
cable in the level. Cost at `seg = 8` capped: **48 vertices, 28 triangles**.
`seg` values nz-env uses: 5–6 for cables and conduit, 8 for pipes, 10–12 for drums
and cowls.

## 6.5 `sweepProfile` + `PROF` — the cheapest silhouette in the file (`:2310-2352`)

```js
  function sweepProfile(pile, F, baseY, prof, inset) { ... }

  var PROF = {
    skirt:   [[0,0],[0.28,0.08],[0.28,0.64],[0.17,0.86],[0,0.86]],
    rail:    [[0,0],[0.20,0.06],[0.24,0.26],[0.20,0.44],[0.07,0.54],[0,0.54]],
    cornice: [[0,0],[0.12,0.14],[0.34,0.42],[0.34,0.66],[0,0.76]],
    band:    [[0,0],[0.34,0.13],[0.34,0.62],[0.20,0.82],[0,0.82]],
    sill:    [[0,0],[0.26,0.06],[0.26,0.24],[0,0.34]]
  };
```

A profile is `[out, up]` pairs in world units, measured from the wall face outward.
Every one starts and ends at `out = 0` so the section is a closed polygon and the
end caps are automatic. Max protrusion 0.34, comfortably inside `HUG` (0.98).

**A skirting board this way is 26 vertices instead of the 96 a chamfered box costs**
(`:2308-2309`). For a facade module this is the primary tool: string courses,
sills, lintels, cornices, plinths, balcony slabs, drip mouldings. Add your own:

```js
  PROF.lintel  = [[0,0],[0.30,0.00],[0.30,0.42],[0.18,0.52],[0,0.52]];
  PROF.plinth  = [[0,0],[0.42,0.00],[0.42,1.30],[0.22,1.55],[0,1.55]];  /* 0.44 m base course */
  PROF.balcony = [[0,0],[0.90,0.10],[0.90,0.38],[0.55,0.52],[0,0.52]];  /* NEEDS jumpTop, see s7 */
```

`runFrame(r)` (`:2289-2303`) turns a wall run into
`{px, pz, tx, tz, nx, nz, len}` — plane origin, unit tangent, inward unit normal
and length — which is what `sweepProfile` consumes. `collectRuns()` (`:2261-2285`)
and `wallHere()` (`:2248-2259`) mirror `buildWorld()`'s own wall rule exactly, so
trim can never appear on an edge that has no wall.

## 6.6 Instancing, and why nz-env does not use it

`grep InstancedMesh nz-env.js` → one hit, and it is an **exclusion**
(`:2073`, in `isWorldMerged`). Merging is preferred throughout.

The r149 core does have `THREE.InstancedMesh` (`nz-weapons.js:3044` uses it for
shell casings, `nz-enemies.js:7993` for the far-LOD pose bank). Use it only when
**all** of these hold:

* more than ~40 identical instances of the same geometry;
* you need **per-instance rotation** — merged geometry cannot be rotated per
  instance, which is exactly why `rebuildCrates` gets its variety from composition
  instead (`:2946-2948`);
* you can live without baked vertex lighting, because
  `neutralizeBakedLighting` explicitly skips `isInstancedMesh`
  (`nz-render.js:2298`).

For an outdoor daylight street that last point is a **feature**: an instanced prop
with no baked vertex colour is lit purely by the live sun + IBL rig, which is
exactly right outdoors. Candidate: nothing in the current brief. Cars are ~6 units
and each is unique; trees are ~8 and want different heights. **Merge everything.**

## 6.7 Draw-call accounting

nz-env's ledger (`STATS.addedCalls` / `STATS.removedCalls`, `:3162`, `:3288`):

| pile | material | mesh name | line |
|---|---|---|---|
| `concrete` | `surfaceMaterial('concrete')` | `nzenv-trim-concrete` | 3262 |
| `plaster` | `surfaceMaterial('hotelwall')` | `nzenv-trim-plaster` | 3263 |
| `steel` | `surfaceMaterial('metal')` | `nzenv-detail-steel` | 3264 |
| `rust` | `makeRustMaterial()` | `nzenv-detail-rust` | 3265 |
| `wood` | `surfaceMaterial('wood')` | `nzenv-detail-wood` | 3266 |
| `crate` | `surfaceMaterial('crate')` | `nzenv-crates` | 3267 |
| `decal` | `DECAL.mat` | `nzenv-decals` | 3268 |
| `lens` | `MeshBasicMaterial` | `nzenv-lenses` | 3276 |

**+8 draws, −22** (the 22 stock crate meshes become one pile). Net **−14**.

Your budget, and hold to it:

* `nz-street.js` — **4 piles**: `render` (stucco facades + plinths + bands),
  `stone` (travertine cladding + sills + steps), `joinery` (PVC frames + doors +
  shutters + railings, all on the `steel`/`paint`/`pvc` sets), `glass`
  (window panes). Plus **1** sign-atlas mesh (§8.5). = **5 draws**.
* `nz-street-props.js` — **5 piles**: `carbody`, `carglass+trim`, `bark+planters`,
  `foliage` (alphaTest, must be its own material), `decal`. = **5 draws**.

Ten new draws for an entire street block. Anything more and you are not merging.

**One material per pile.** A pile has a single index buffer and one material — if
two props need different materials they need different piles. That is the whole
design constraint and it is what drives the grouping above.

## 6.8 Tier gating

nz-env has no LOD system. It has two dials, both set in `applyTier()` (`:246-251`):

* `RES` — texture resolution (512/256/128).
* `DENSITY` — a probability multiplier: `0.30` low, `0.62` med, `1.00` high.

Every optional emitter multiplies its threshold by it:

```js
  if (roll > (industrial ? 0.56 : 0.22) * DENSITY + 0.04) continue;   /* :2682 */
  if (roll > 0.24 * DENSITY) continue;                                /* :2732 */
  var n = hash1(seed) < 0.55 * DENSITY ? 1 : 0;                       /* :2989 */
  if (hash1(sd) > 0.16 * DENSITY) continue;                           /* :3035 */
```

Do the same. Additionally, for a street: gate **whole categories** on tier —
e.g. `if (TIER !== 'low') buildFoliage();`, `var carSeg = TIER === 'high' ? 12 : 8;`.
Never hard-lock quality (`CS2-BRIEF.md:9-10`).

## 6.9 The deterministic RNG

Two, for two different jobs:

* **`hash1(n)`** (`:127`) — `fract(sin(n * 127.1 + 311.7) * 43758.5453)`, used for
  *placement* decisions. Seeded from grid coordinates so the level is identical on
  every reload:

  ```js
  var seed = r.a * 977 + r.start * 131 + (r.d[0] * 3 + r.d[1] * 7);   /* :2680 */
  var base = r.a * 613 + r.start * 271 + (r.d[0] * 5 + r.d[1] * 13);  /* :2728 */
  var base = r.a * 401 + r.start * 173 + (r.d[0] * 11 + r.d[1] * 29); /* :2986 */
  var sd   = x * 733 + y * 197;                                       /* :3034 */
  var jitter = (hash1(i * 3.7) - 0.5) * 0.06;                         /* :2941 */
  ```
  Then `hash1(seed + 1)`, `hash1(seed + 3)`, `hash1(seed + 9)`… for each independent
  decision. **Use different large co-prime multipliers per emitter** so two emitters
  on the same cell do not correlate.

* **`NZ.tex.mulberry32(seed)`** (`nz-core.js:118-126`) — a real PRNG, used for
  *texture* bakes (`latticeOf`, `worleyRaw`, `buildDecalAtlas` at `:2363`).

## 6.10 Worked example — building one prop and merging it

A pavement bollard, hugging nothing, standing on a pavement at `f = 0.5`.
This is the complete pattern: context → emit → merge → material → mesh.

```js
  /* A 900 mm cast-iron bollard: 0.9 m tall, 140 mm shaft, a domed cap and a
     base flange. Real dimensions, written as metres * U so they survive any
     future rescale. Sits on the pavement, so it needs a ground ramp and a
     contact decal -- and it is 0.49 units in radius, well under HUG, so it may
     stand anywhere the pavement is walkable. */
  function bollard(pile, wx, wz, floorY, seed) {
    var hR   = m(0.070);            /* 0.245 u  shaft radius   */
    var hH   = m(0.90);             /* 3.15  u  height         */
    var baseR = m(0.11), baseH = m(0.12);
    var lean = (hash1(seed) - 0.5) * 0.08;        /* nothing on a street is plumb */

    pile.context(floorY, floorY + 200, R.amb, m(0.4));   /* tile 1.4 u = 0.4 m */
    pile.ground(floorY);

    /* base flange -- chamfered so the arris catches the sun */
    boxC(pile, wx, floorY + baseH * 0.5, wz, baseR, baseH * 0.5, baseR, 0.04, 0.88);
    /* shaft, leaning a hair */
    tube(pile, wx, floorY + baseH, wz,
               wx + lean, floorY + hH, wz + lean * 0.6, hR, 10, 1, false);
    /* two raised bands, the classic cast-iron detail */
    var k;
    for (k = 0; k < 2; k++) {
      var by = floorY + hH * (0.62 + k * 0.14);
      tube(pile, wx, by, wz, wx, by + m(0.03), wz, hR * 1.18, 10, 0.94, false);
    }
    /* domed cap: three stacked rings, cheaper and rounder than a hemisphere */
    var cy0 = floorY + hH;
    tube(pile, wx + lean, cy0, wz + lean * 0.6, wx + lean, cy0 + m(0.03), wz + lean * 0.6, hR * 1.10, 10, 1, false);
    tube(pile, wx + lean, cy0 + m(0.03), wz + lean * 0.6, wx + lean, cy0 + m(0.06), wz + lean * 0.6, hR * 0.86, 10, 1, false);
    tube(pile, wx + lean, cy0 + m(0.06), wz + lean * 0.6, wx + lean, cy0 + m(0.08), wz + lean * 0.6, hR * 0.50, 10, 1, true);
    STATS.props++;
  }

  /* ...and the merge, once, for every bollard in the street: */
  function buildBollards() {
    var pile = PILES.joinery, i;                       /* SHARED with railings   */
    for (i = 0; i < BOLLARD_SPOTS.length; i++) {
      var s = BOLLARD_SPOTS[i];
      bollard(pile, s.x, s.z, s.f, i * 613 + 71);
    }
    /* no mesh here -- makeMesh(PILES.joinery, ...) runs ONCE in install() */
  }
```

Cost: 1 `boxC` (44 tris) + 6 `tube`s (~140 tris) ≈ **184 triangles per bollard**,
**zero extra draw calls** because it shares `PILES.joinery` with the railings, the
window frames and the door furniture.

## 6.11 Top 5 helpers, by name

1. **`Pile`** (+`.context()` / `.origin()` / `.vert()` / `.tri()` / `.geometry()`)
   — `nz-env.js:1858-1906`. The hand-written merge. Replaces `BufferGeometryUtils`.
2. **`poly(pile, pts, rx, ry, rz, ao)`** — `:1913-1952`. The only vertex emitter.
   Auto-winding, world-space planar UVs, baked light, contact shading.
3. **`boxC(pile, cx,cy,cz, hx,hy,hz, k, ao)`** — `:1958-1997`. Chamfered box,
   96 verts / 44 tris.
4. **`tube(pile, ax,ay,az, bx,by,bz, r, seg, ao, cap)`** — `:2001-2025`.
   Capped cylinder for every round thing.
5. **`litAt(x,y,z, nx,ny,nz, amb)`** — `:203-223`. Memoised access to the game's
   own baked point-light solution. Without it your props are unlit; with it
   naively, your load time is minutes.

Runners-up you will also want: **`sweepProfile` + `PROF`** (`:2310-2352`) for every
piece of facade trim, **`decalQuad`** (`:2030-2049`) for every decal and sign,
**`hug` / `jumpTop`** (`:2062-2066`) for clearance, **`emitSet`** (`:609`) for every
new material, **`fieldBond` / `fieldPlank` / `fieldStreak`** (`:451-481`) for every
masonry pattern.

---

# 7. Collision safety

## 7.1 The physics, exactly

`canStand(x, z, rad, climb)` (`NUKEM.html:3178-3187`) tests every cell overlapping
the AABB `[x±rad, z±rad]` and rejects if any is `blockedCell`. `blockedCell`
(`:3162-3172`) is true for `S_SOLID`, `S_EXIT`, `S_BLOCK`, and for a shut
`S_DOOR`/`S_KEY`/`S_SECRET`. The player moves through `moveSlide(..., PRAD, ...)`
(`:3860`).

Therefore:

* **The camera centre is never closer than `PRAD = 1.15` units to the face of any
  blocked cell.** Free space begins 1.15 units out from a wall plane.
* `HUG = 0.98` (`nz-env.js:2058`) = `PRAD − 0.17`. A prop that protrudes at most
  0.98 units from a wall plane can never be entered.
* Vertical: the camera sits at `player.y + eye` (`:3955`), `eye = EYE = 5.985`
  standing or `EYE_CROUCH = 4.025` crouched, plus `player.bob`. `player.y` is
  bounded below by `highestFloor(x, z, PRAD*0.85)` and above by the jump apex
  `2.258` — and additionally clamped by the ceiling
  (`lid = R.c − 0.06 − (eyeH + PHEAD)`, `:3884`).
  **Max camera height above floor = 8.243 units.**
* The player can walk **up** a step of `CLIMB = 1.15` units (0.33 m). Anything
  shorter than that which you place on the ground is a step, not an obstacle.

## 7.2 `hug()` and `jumpTop()`

```js
  var HUG = 0.98;              /* max protrusion from a wall plane (PRAD 1.15) */
  var HUGVIOL = 0;
  function hug(d) {
    if (d > HUG) { HUGVIOL++; if (NZ.debug) console.warn('[nz-env] prop depth ' + d.toFixed(2) + ' clamped to ' + HUG); return HUG; }
    return d;
  }
  function jumpTop(f) { return f + 6.7; }   /* eye 2.85 + jump apex 3.44 + margin */
```

`hug()` is a **single source of truth plus an assertion**: anything that trips the
clamp is a bug in an emitter, and `STATS.clearanceClamps` (`:3329`) reports the
count. Usage pattern — always convert "how far out do I want the far face" into
"where do I put the centre":

```js
  var off = hug(0.46 + rad) - rad;                 /* pipe,  :2695 */
  var dOff = hug(dr * 2 + 0.04) - dr;              /* drum,  :2768 */
  var pOff = hug(0.94) - 0.42;                     /* pallet,:2781 */
```

**`jumpTop` is wrong now (§0).** Use:

```js
  function apex()   { return (G.JUMPV * G.JUMPV) / (2 * G.GRAV); }   /* 2.258 */
  function camTop(f){ return f + G.EYE + apex(); }                   /* f + 8.243 */
  function jumpTop(f){ return camTop(f) + 0.45; }                    /* f + 8.70  */
```

## 7.3 The complete rule set

The grid-based collision knows **nothing** about anything you add. A prop is legal
if and only if **at least one** of these holds:

| # | rule | test |
|---|---|---|
| **A** | it protrudes at most `HUG = 0.98` units from a wall plane | `hug(d)` |
| **B** | its **lowest** point is above `jumpTop(floorY)` = `f + 8.70` | overhead |
| **C** | its footprint lies inside a **blocked cell** (`S_SOLID`, `S_BLOCK`, `S_EXIT`, or a shut door cell), optionally overhanging by up to `HUG` on each side | grid |
| **D** | it is below the floor plane (a sunken drain, a basement light well) | `y < f` |
| **E** | it is shorter than `CLIMB = 1.15` units **and** the player walking over it is acceptable (a kerb, a threshold, a manhole cover, a paint line) | height |

Anything else is walk-through, and walk-through is a defect.

Note rule **E**: it is why the 0.5-unit kerb in the carve plan works, and it is your
licence to lay pavers, road markings, gutter channels and manhole covers flat on
the ground without any grid work at all.

Note rule **C**'s overhang: a car body on a 2×4 block of `S_BLOCK` cells may
overhang the blocked rectangle by 0.98 units on every side, which is exactly enough
for wing mirrors, bumpers and a wheel arch.

## 7.4 PARKED CARS — the answer

A car is 1.8 m × 4.3 m × 1.45 m = **6.3 × 15.1 × 5.1 world units**. Compare:

* rule **A** allows 0.98 units of protrusion — a car is 6.4× too deep. **Impossible.**
* rule **B** needs the lowest point above `f + 8.70` — a car sits on the road.
  **Impossible.**
* rule **E** needs it under 1.15 units tall. **Impossible.**
* rule **D** is a car in a pit. Not what we want.

**Only rule C works.** A parked car must stand on cells that the grid already
treats as blocked.

### What to do

`S_BLOCK` is the right cell type: it blocks the player and the AI, and `losGrid`
treats it as chest-high cover (`NUKEM.html:4059`: `if (t === S_BLOCK) return py <
R.f + CRATE_H;`) — LOS is blocked below 4.2 units and clear above, which is *exactly*
how a real parked car behaves in CS2. A car occupying `2 × 4` cells = 8 × 16 units
= 2.29 m × 4.57 m holds a 6.3 × 15.1-unit body with room to spare.

But `S_BLOCK` cells are set in `NUKEM.html`, which **you do not own**
(`CS2-BRIEF.md:47-49`). So:

1. **Request the parking bays from the orchestrator.** Ask for `grid[idx(x,y)] =
   S_BLOCK` on the bay cells, and ask that they are **NOT** pushed into `CRATES[]` —
   the crate box mesh comes from the `CRATES` array (`NUKEM.html:3131-3139`), not
   from the grid value, so an `S_BLOCK` cell that is absent from `CRATES` is
   blocked with no geometry, which is precisely what a car needs.
   Suggested bays along the south kerb of the carve (`y = 45..46` is pavement, so
   park against the *north* pavement in the roadway edge lane, `y = 41`):
   `(47..48, 41)`, `(51..52, 41)`, `(56..57, 41)` — three 2×1 bays; ask for 2×2 if
   you want the full 4.57 m length. Each costs 4 traversal nodes and must be
   re-validated with `npm test` (`LEVEL-CONTRACT.md §7`).
2. **Write the module so it discovers the bays rather than assuming them.**
   Scan the street rectangle for contiguous `S_BLOCK` runs, group them into
   rectangles, and build one car per rectangle sized to it. Exactly what
   `rebuildCrates` does with `G.CRATES` (`:2930-2973`), and it means your module is
   correct whether or not the carve has landed:

   ```js
   function findBays(x0, y0, x1, y1) {
     var bays = [], used = {}, x, y;
     for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) {
       if (used[x + ',' + y]) continue;
       if (G.cellAt(x, y) !== G.S_BLOCK) continue;
       /* grow east then south */
       var w = 0, h = 0, i, j;
       while (G.cellAt(x + w + 1, y) === G.S_BLOCK && !used[(x + w + 1) + ',' + y]) w++;
       outer: while (true) {
         for (i = 0; i <= w; i++) if (G.cellAt(x + i, y + h + 1) !== G.S_BLOCK) break outer;
         h++;
       }
       for (j = 0; j <= h; j++) for (i = 0; i <= w; i++) used[(x + i) + ',' + (y + j)] = 1;
       bays.push({ cx0: x, cy0: y, cw: w + 1, ch: h + 1 });
     }
     return bays;
   }
   ```
3. **If `findBays()` returns nothing, build no cars** and `warn()` about it, so
   the failure is legible in `NZ.street.report()` instead of showing up as a
   ghost car in a screenshot.
4. **Never** place a car "outside the walkable rectangle" as a fallback. A car
   embedded in a solid block is a car sticking half-way out of a building, which
   is a worse defect than no car.

### If the bays cannot be had

Ship the street with **no cars** and put the budget into things that are legal
without grid changes: kerbs, pavers, gutter channels, drain covers, road markings
(all rule **E**), wall-hugging meters/downpipes/bins under 0.98 deep (rule **A**),
balconies and A/C units and awnings above `f + 8.70` (rule **B**), and a parked car
visible **beyond** the street through the mouth as pure background geometry inside
solid rock (rule **C** for free). A street with no cars and correct dressing beats
a street with cars you walk through.

## 7.5 TREES — the answer

A street tree splits into two parts with two different rules.

**Trunk** — 0.25–0.4 m diameter = **0.9–1.4 units**.
* Too deep for rule **A** if free-standing in the open.
* Legal by rule **C** on a **single `S_BLOCK` tree pit** — one cell is 4 units
  (1.14 m), which holds a 1.4-unit trunk with 1.3 units of margin on every side,
  and lets you build a real cast-iron tree grille and a raised kerb ring on the
  same cell. **This is the correct solution and it costs one cell per tree.**
* Alternatively legal by rule **A** if you plant it against a facade with the trunk
  centre **on the wall plane**, so only `radius ≤ 0.98` protrudes. It reads as a
  tree growing out of a wall. Do not.

**Canopy** — 3–5 m across = 10–17 units, but its **lowest foliage** is what matters.
* Legal by rule **B** if the crown base is above `f + 8.70` units = **2.49 m**.
* A real street tree is pruned to a 2.5 m clearance over a footway. **The physics
  constraint and the correct architecture are the same number.** Free.
* So: `crownBase = floorY + jumpTop(0) + 0.1`, and the canopy may then spread as
  wide as you like over the pavement and the road.

**Conifers / cypress** — the Mediterranean reference is a fastigiate cypress, which
is foliated **from near the ground**. That breaks rule **B** outright.
* Correct answer: plant cypresses **only on `S_BLOCK` tree pits** (rule **C**), and
  keep the foliage inside `cell ± 0.98` units — a 5.96-unit-wide column, which is
  1.70 m: exactly right for a fastigiate cypress.
* Or plant them **outside the walkable rectangle** entirely — in the solid block
  behind the facades, visible over a courtyard wall. Costs nothing, reads as depth,
  and is the cheapest way to get greenery into the skyline.

**Planters and pots** — a 0.6 m planter is 2.1 units, over the `HUG` limit. Either
put it on an `S_BLOCK` cell, or make it a long shallow **wall-hugging** trough:
0.98 units deep × as long as you like × 1.0 unit tall. That *is* legal, and a run
of troughs along a facade is a very Turkish detail.

## 7.6 The checklist for every prop you emit

```
[ ] Which rule (A/B/C/D/E) makes this legal? Write it in a comment.
[ ] If A: every offset goes through hug(). STATS.clearanceClamps must be 0.
[ ] If B: lowest vertex >= jumpTop(regionFloorY). Use the corrected jumpTop.
[ ] If C: footprint verified against G.cellAt() at build time, not assumed.
[ ] If E: total height < CLIMB (1.15) above the walkable floor.
[ ] Does it sit on a lift cell? (liftCell(cx,cy)) -- if so, do not.
[ ] Does it sit on a door cell? (S_DOOR/S_KEY/S_SECRET) -- if so, do not.
[ ] Does it block a spawn point or a pickup? (SPAWNS / the P table)
[ ] Does it sit inside GRACE_ZONE? (see LEVEL-CONTRACT 6.4)
```

`nz-env` checks the lift case explicitly in two places (`:2831`, `:3032`) — copy it:

```js
  function liftCell(cx, cy) {
    if (!G.liftOf || !G.inb(cx, cy)) return false;
    return G.liftOf[cy * G.MW + cx] >= 0;
  }
```

---

# 8. Decals and fixtures

## 8.1 The atlas — `buildDecalAtlas()` (`:2358-2605`)

* **Resolution**: `TIER === 'low' ? 256 : 512` (`:2359`). `N = 4`, so `ts = res/N`
  is **128 px per tile at high tier**. Remember that number — it is why signage
  text in the atlas is mush (§8.5).
* Drawn with plain 2D canvas onto a transparent canvas (`g.clearRect`), with three
  local helpers: `cell(i)` (tile origin), `push(i)` (record the UV rect),
  `vgrad(x,y,w,h,col,a0,a1)` (vertical gradient), `blob(x,y,r,col,a)` (radial).
* **UV rects** (`:2365-2371`) — note the flip:

  ```js
  function push(i) {
    var o = cell(i), pad = ts * 0.012;
    DECAL.rect.push([(o[0] + pad) / res, 1 - (o[1] + ts - pad) / res,
                     (o[0] + ts - pad) / res, 1 - (o[1] + pad) / res]);
  }
  ```
  `[uMin, vBottom, uMax, vTop]`. The canvas grows downward and the texture is
  `flipY`, so the tile's **visual top is the LARGER v**. The 1.2 % pad stops
  neighbouring tiles bleeding in through the mip chain.
* **The 16 tiles**: `0` dirt streak run-off, `1` water stain, `2` scuff smear,
  `3` rust bleed, `4` graffiti tag A, `5` graffiti block tag, `6` stencil arrow,
  `7` stencil text, `8` hazard chevrons, `9` numbered plate, `10` crack (recursive
  branching), `11` torn poster, `12` oil stain, `13` floor drain, `14` splatter,
  `15` warning triangle.
* **The aging pass** (`:2584-2592`) — a ±13 luma hash noise over the whole atlas
  "so nothing reads as a crisp sticker". Do not skip it.
* **The material** (`:2596-2603`):

  ```js
  DECAL.mat = new THREE.MeshStandardMaterial({
    map: DECAL.tex, transparent: true, opacity: 1, alphaTest: 0.02,
    roughness: 0.92, metalness: 0.0, vertexColors: true,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    fog: true, dithering: true, side: THREE.FrontSide
  });
  DECAL.mat.name = 'nzenv:decal';
  DECAL.mat.envMapIntensity = 0.5;
  ```
  `ClampToEdgeWrapping` on the texture (`:2595`) — mandatory for an atlas.
  No `onBeforeCompile`: decals opt **out** of the injection and inherit nz-render's
  prototype patch.

## 8.2 Placing a decal — `decalQuad()` (`:2030-2049`) and `placeDecals()` (`:2976-3045`)

```js
  function decalQuad(pile, cx, cy, cz, nx, ny, nz, ux, uy, uz, hw, hh, rect, tintScale)
```

`v = u × n` (**not** `n × u`) — on a wall facing −Z with `u = +X` that gives `+Y`,
so stencilled text lands the right way up instead of mirrored (`:2027-2029`).

Placement geometry:

* **Wall decals**: offset **0.055 units** off the wall plane along the inward
  normal (`:2992-2993`), then `polygonOffset -4 / -8` on top of that.
* **Floor decals**: `Rg.f + 0.045` (`:3041`), normal `(0,1,0)`, `u = (1,0,0)`.
* Depth: `depthWrite: false` plus `transparent: true` means they draw in the
  transparent pass, sorted back-to-front, and never write depth — so two overlapping
  decals blend instead of z-fighting.
* Colour: `litAt` at the quad centre pushed 0.3 out, times `tintScale`.

Weighting (`:2994-3019`) — worth copying wholesale, because the ratios are the
result of a review round: **42 %** floor-line grime, **24 %** run-off from above,
**8 %** signage, **12 %** graffiti (and only where `R.sky || R.wtex === 'concrete'`),
the rest miscellaneous. `:2996-2998`: "a stencilled plaque every eight units is set
dressing gone wrong, so signage gets 8 % and the streaks get the rest."

Guards: `if (yy - sz*0.5 < r.f + 0.05) yy = r.f + sz*0.5 + 0.05;` and
`if (yy + sz*0.5 > r.f + height - 0.1) continue;` — a decal must never hang off the
end of its wall. Floor decals skip `S_BLOCK` cells and lift cells (`:3031-3032`).

## 8.3 Adding new decal tiles

The atlas is 4×4 = 16 and **full**. You have two options:

* **Option 1 — your own atlas.** Build a second 4×4 (or 8×8) atlas in your module
  with your own tiles and your own material. One extra draw call, one extra
  texture. This is the right choice: you are a separate module and must not touch
  `DECAL` (§9).
* **Option 2 — 8×8 = 64 tiles at 64 px each.** Only if the tiles are all soft
  stains. Anything with an edge (a drain grille, lettering) dies at 64 px.

Recommended new tiles for a street, in a `4×4` atlas at 512 (128 px/tile):

| # | tile | how |
|---|---|---|
| 0 | **tar seam** | 2–3 near-vertical `vgrad` strips, `'26,25,27'`, width `ts*0.03`, with a wobbly `bezierCurveTo` centreline |
| 1 | **patched asphalt** | a rounded rect at `rgba(52,52,56,.85)` with a ragged `lineTo` outline, then `blob` noise inside |
| 2 | **drain cover / rain gully** | rectangular, `fillRect` frame + 7 parallel slot bars — copy tile 13's slot loop (`:2552-2559`) but rectangular |
| 3 | **manhole cover** | a circle + a hexagonal cast pattern (`arc` + a 6-way `lineTo` star), plus a `blob` of dirt |
| 4 | **water stain / damp patch** | copy tile 1 verbatim; enlarge and lower the alpha |
| 5 | **rising damp** | `vgrad` from the *bottom* up: `col '84,76,60'`, `a0 = 0` at top, `a1 = 0.42` at bottom |
| 6 | **graffiti tag (Latin)** | copy tile 4 |
| 7 | **graffiti (block, Turkish)** | copy tile 5 |
| 8 | **painted road line** | a single `fillRect` at `rgba(214,208,186,.75)` with 30 % of its length erased by `globalCompositeOperation='destination-out'` blobs — worn paint |
| 9 | **parking bay marking** | an L or a corner tick, same treatment |
| 10 | **contact shadow blob** | `blob(cx, cy, ts*0.46, '10,10,12', 0.55)` — **build this one first**, it is what makes cars and trees sit down |
| 11 | **poster / election bill** | copy tile 11 |
| 12 | **AC drip stain** | a narrow `vgrad` plus a `blob` at the bottom |
| 13 | **cigarette/litter scatter** | 20 tiny `fillRect`s at random angles |
| 14 | **leaf litter** | 25 small rotated ellipses in three browns |
| 15 | **cracked kerb / spalled concrete** | copy tile 10's recursive `branch()` |

## 8.4 Fixtures — `buildFixtures()` (`:2824-2915`)

The rule (`:49-52`): every point light in `LIGHTS` that sits inside a real room
gets a visible housing. An unmotivated light is a realism failure.

Filters applied before building anything:
* cell must be in bounds, not solid (`:2830`), not a lift cell (`:2831`);
* light must be inside the room's `[f-1, c+1]` band (`:2833`);
* **`if (fin(L.r, 0) >= 30) continue;`** (`:2837`) — "the 30-46 unit lights are the
  moon and sky wash the level author put in for atmosphere. They have no physical
  source and must not get a fixture." The carve plan's two `r = 40/44` daylight
  washes are deliberately in that band (`LEVEL-CONTRACT.md:1345-1347`).

Interior → ceiling pan on a stem (`:2845-2856`). Exterior → **catenary** if no wall
is within one cell (`:2895-2911`): a cable strung from the facade to a hanging cowl,
which is what a real narrow street looks like. `ly = clamp(L.y, jumpTop(R.f) + 0.7,
R.f + 22)` (`:2867`) — outdoors there is no ceiling to hide behind, so the housing
is pushed above the jump apex. **This is the line whose `jumpTop` is stale.**

Every fixture ends in an `emissivePanel` (`:2918-2927`), an unlit
`MeshBasicMaterial` card with `vertexColors: true` carrying `col * gain` where
`gain = 1.55 + L.i * 0.9`. This is the *visible source*. Note the lens material is
excluded from `neutralizeBakedLighting` by name and by `isMeshBasicMaterial`
(`nz-render.js:2306-2307`) — the lens cards **must** stay hot.

For a street you should add: wall-mounted lantern brackets over doorways, an
illuminated shop sign, a stairwell window glow behind the foyer glazing. All of
them need a matching entry in `LIGHTS` — request it from the orchestrator, or
place a *dark* fixture with no light, which is honest and still reads.

## 8.5 CRISP PAINTED CAPITALS ON A FACADE — the recommendation

**Recommendation: a dedicated opaque sign atlas at ~4× the density of the decal
atlas, mapped onto flat quads that are part of a real fascia band. Not the 16-tile
decal atlas. Not extruded geometry. Not an alpha-mapped plane.**

### Why the other three lose

* **Decal atlas tile** — a tile is `512/4 = 128 px`. "SEYDIKENT A-BLOK" is 16
  glyphs; that is 8 px per glyph, and the strokes fall below one texel. It is mush
  at any distance. Rejected on measurement, not taste.
* **Extruded geometry** — physically wrong. The reference lettering is *painted*,
  and painted letters have no silhouette. It also costs ~5 `boxC` strokes per glyph
  = 16 × 5 × 44 = **3520 triangles** for one sign. Reserve extrusion for a
  genuinely raised cast-metal building name, and then place it by rule **A**
  (a 0.15-unit-proud letter is well inside `HUG`) or rule **B**.
* **Alpha-mapped plane** — works, but the alpha edge is the problem. `alphaTest`
  plus mipmaps dissolves thin strokes with distance; `transparent: true` puts your
  sign in the sorted pass with the decals and the foliage, where it will
  occasionally draw in front of a car. And the sign material would not receive
  the same `desat` pull as the wall behind it, so your red reads hotter than
  everything else in the frame.

### Why the opaque fascia wins

The lettering in the references sits on a **painted band** — a render panel above
the entrance. So make that band real geometry with the letters painted **into its
albedo**. The texture is fully opaque, so: no alpha edge to dissolve, no sorting,
depth writes normally, and the panel gets the *same* render material story as the
wall it is part of. It is also one draw call for every sign on the street.

### The code

```js
  /* ---------------------------------------------------------------------
     SIGN ATLAS.  1024 x 1024, four 1024 x 256 rows, one building name each.
     A 3 m sign band is 10.5 units wide, so 1024 texels across it is 340
     texels per metre -- four times the density of the render behind it, and
     enough that a 90 mm stroke is still 30 texels at arm's length.
     Opaque: the panel colour IS the render colour, so there is no alpha edge
     and no sort. One texture, one material, one draw call for every sign.
     ------------------------------------------------------------------- */
  var SIGN = { tex: null, mat: null, rect: [], n: 0 };

  function canvasWH(w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  function buildSignAtlas(names) {
    var W = TIER === 'low' ? 512 : 1024, ROW = W / 4;
    var c = canvasWH(W, W), g = c.getContext('2d', { willReadFrequently: true });
    var res = 256;
    var grain = fbmC(res, { octaves: 5, frequency: 20, seed: 771 });
    var i, r;

    for (r = 0; r < 4; r++) {
      var y0 = r * ROW;
      var spec = names[r] || { text: '', bg: '#cfc6b2', ink: '#8e2b22' };

      /* 1. the panel: the render colour the band is painted, with the same
            grain the stucco set carries, so band and wall read as one material */
      g.fillStyle = spec.bg; g.fillRect(0, y0, W, ROW);

      /* 2. the letters. Drawn glyph by glyph: Turkish apartment names are
            always widely tracked, and canvas letterSpacing is not in the
            r149-era baseline. Two passes -- a 2 px dark offset first, which is
            the shadow a real 2 mm paint film casts and is what stops flat text
            reading as a sticker. */
      var text = spec.text;
      var cap = Math.round(ROW * 0.52);
      var track = spec.track === undefined ? 0.12 : spec.track;
      g.font = '900 ' + cap + 'px "Arial Narrow","Helvetica Neue",Arial,sans-serif';
      g.textBaseline = 'alphabetic';
      var adv = [], w = 0;
      for (i = 0; i < text.length; i++) { var a = g.measureText(text[i]).width; adv.push(a); w += a + cap * track; }
      w -= cap * track;
      /* if it does not fit, condense rather than clip -- a clipped building
         name is a bug the critic WILL find */
      var sc = Math.min(1, (W * 0.90) / (w || 1));
      var sx = (W - w * sc) / 2, by = y0 + Math.round(ROW * 0.70);
      var pass, px2, off;
      for (pass = 0; pass < 2; pass++) {
        px2 = sx; off = pass === 0 ? Math.max(1, cap * 0.022) : 0;
        g.fillStyle = pass === 0 ? 'rgba(38,26,22,0.30)' : spec.ink;
        g.save(); g.translate(0, 0); g.scale(sc, 1);
        for (i = 0; i < text.length; i++) {
          g.fillText(text[i], (px2 + off) / sc, by + off);
          px2 += (adv[i] + cap * track) * sc;
        }
        g.restore();
      }

      /* 3. age it. Twenty-year-old sign paint is chalky at the top where the
            sun hits and intact under the drip line. Erase a little of the ink
            with destination-out blobs, then dust the whole band. */
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (i = 0; i < 26; i++) {
        var bx = Math.random() * W, byy = y0 + Math.random() * ROW * 0.55;
        var br = ROW * (0.01 + Math.random() * 0.035);
        var gr = g.createRadialGradient(bx, byy, 0, bx, byy, br);
        gr.addColorStop(0, 'rgba(0,0,0,0.30)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(bx, byy, br, 0, TAU); g.fill();
      }
      g.restore();

      /* the erased pixels must not be transparent -- this atlas is OPAQUE.
         Composite the panel colour back underneath. */
      g.save();
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = spec.bg; g.fillRect(0, y0, W, ROW);
      g.restore();

      /* 4. UV rect, same flipY convention as the decal atlas */
      var pad = 1 / W;
      SIGN.rect.push([pad, 1 - (y0 + ROW) / W + pad, 1 - pad, 1 - y0 / W - pad]);
    }

    /* 5. grain + soiling over the whole atlas, so no sign is a crisp sticker */
    var id = g.getImageData(0, 0, W, W), d = id.data, x, y;
    for (y = 0; y < W; y++) for (x = 0; x < W; x++) {
      var gv = (grain[(y % res) * res + (x % res)] - 0.5) * 22;
      var k = (y * W + x) * 4;
      d[k] = clamp(d[k] + gv, 0, 255);
      d[k + 1] = clamp(d[k + 1] + gv, 0, 255);
      d[k + 2] = clamp(d[k + 2] + gv, 0, 255);
      d[k + 3] = 255;                                  /* fully opaque, always */
    }
    g.putImageData(id, 0, 0);

    SIGN.tex = texCanvas(c, true);
    SIGN.tex.wrapS = SIGN.tex.wrapT = THREE.ClampToEdgeWrapping;
    SIGN.tex.anisotropy = ANISO;
    SIGN.mat = new THREE.MeshStandardMaterial({
      map: SIGN.tex,
      roughness: 0.84, metalness: 0.0,
      vertexColors: true, fog: true, dithering: true,
      side: THREE.FrontSide
      /* opaque: no transparent, no alphaTest, no depthWrite:false, no
         polygonOffset -- the panel is real geometry standing 0.10 units proud
         of the facade, so there is nothing to z-fight with. */
    });
    SIGN.mat.name = 'nzenv:sign';       /* prefix matters -- see section 5.5 */
    SIGN.mat.envMapIntensity = 1.0;
    /* NO onBeforeCompile: the desat/grime injection would eat the red, which
       is the one colour on this facade that has to survive. The prototype
       patch (nz-render AO/PCSS/contact shadows) is inherited automatically. */
    OWN.mat.push(SIGN.mat);
  }

  /* Place one sign. `F` is a runFrame(); `t` is the distance along the run.
     The band is a real box so it has a silhouette and casts a shadow; the
     lettering lives on its outward face only. */
  function placeSign(pile, F, t, baseY, wUnits, hUnits, rect) {
    var proud = 0.10;                       /* rule A: 0.10 << HUG (0.98)     */
    var cxp = F.px + F.tx * t + F.nx * proud * 0.5;
    var czp = F.pz + F.tz * t + F.nz * proud * 0.5;
    /* the band itself, in the render pile, so it is the same material as the
       wall and reads as part of the building */
    boxC(PILES.render, cxp, baseY + hUnits * 0.5, czp,
         F.tx ? wUnits * 0.5 : proud * 0.5, hUnits * 0.5,
         F.tz ? wUnits * 0.5 : proud * 0.5, 0.04, 1);
    /* the lettering, 0.01 in front of the band's outward face */
    var fx = F.px + F.tx * t + F.nx * (proud + 0.012);
    var fz = F.pz + F.tz * t + F.nz * (proud + 0.012);
    pile.context(baseY, baseY + 200, R.amb, 4);
    decalQuad(pile, fx, baseY + hUnits * 0.5, fz,
              F.nx, 0, F.nz, F.tx, 0, F.tz,
              wUnits * 0.5, hUnits * 0.5, rect, 1);
    STATS.props++;
  }

  /* usage */
  buildSignAtlas([
    { text: 'SEYDIKENT A-BLOK', bg: '#cfc6b2', ink: '#8e2b22' },
    { text: 'SEYDIKENT B-BLOK', bg: '#c8c0ad', ink: '#8e2b22' },
    { text: 'GUNES APARTMANI',  bg: '#d2c9b6', ink: '#2f4a72' },
    { text: 'BAHAR SITESI',     bg: '#cdc4b0', ink: '#7a2b26' }
  ]);
```

### Six things that will bite you

1. **sRGB.** `texCanvas(c, true)` sets `colorSpace = SRGBColorSpace` (`:528`).
   Miss it and the red goes fluorescent.
2. **Anisotropy.** A sign band is almost always seen at a glancing angle down the
   street. `SIGN.tex.anisotropy = ANISO` (16 on a real GPU) is the difference
   between crisp and smeared.
3. **The red must be pre-desaturated in the canvas**, because this material has no
   `onBeforeCompile` and so no `uNzC.y` pull. `#8e2b22` is already a faded
   Turkish signage red — HSV sat ≈ 0.76, value ≈ 0.56 — not `#cc0000`.
   `CS2-BRIEF.md:76`: "Resist neon, resist saturation."
4. **Name it `nzenv:sign`.** Otherwise `neutralizeBakedLighting` skips it and your
   sign sits at a different exposure from the wall it is painted on (§5.5).
5. **Fully opaque alpha.** The `destination-out` aging pass punches holes in the
   alpha channel; the `destination-over` refill and the final `d[k+3] = 255` put
   them back. Skip either and you have a transparent material pretending to be
   opaque, and it will sort wrong.
6. **Do not clip the name.** The `sc` condense factor exists because a clipped
   building name is the kind of defect a critic screenshots.

### If a sign must be raised cast-metal letters instead

Rule **A** covers it (0.15 units proud ≪ 0.98). Build each glyph from `boxC`
strokes into `PILES.joinery` with the `steel` set, chamfer 0.02, and budget
~44 tris per stroke. One hero sign only.

---

# 9. What a sibling module must NOT do

## 9.1 Do not touch anything nz-env owns

| forbidden | why |
|---|---|
| Re-assigning `.material` or `.geometry` on any mesh named `nzenv-*` | `panic()`'s `OWN.restore` snapshot (`:3487-3503`) becomes a lie; teardown restores stale state |
| Re-assigning `.material` on a mesh whose material name starts `world:` | those meshes are nz-env's; it has already snapshotted their `uv`, `uv2` and `color` (`:2137-2144`). A second module overwriting them means neither teardown works |
| Rewriting `geometry.attributes.color` on a world mesh | nz-env multiplied its contact AO into that array (`:2217-2221`) and nz-render's `neutralizeBakedLighting` will remap it again at -1000. A third writer produces triple-counted AO |
| Deleting or re-setting the `nzFC` attribute on a world mesh | it is the input to every gated term in the injection (§4.5) |
| Mutating any material with `__nzEnv` set, or its `normalMap` | `auditNormals()` (`:3170-3185`) actively detects a stolen normal map, takes it back and warns. You will be named in the report |
| Calling `NZ.env.dispose()` | it is `panic('manual dispose')` — it tears down the entire environment pass |
| Adding tiles to `DECAL.rect` or drawing into `DECAL.tex`'s canvas | the canvas is already uploaded; the atlas is full; and `DECAL` is a closure-private object you cannot legally reach anyway |
| Re-baking a `SURF` key | `SETS`/`MATS` are closure-private. There is no shared cache between modules. Bake your own |
| Assigning `THREE.Material.prototype.onBeforeCompile` | that is nz-render's. Assign per-material and **chain** (§4.6) |
| Assigning `material.customProgramCacheKey` on a material you want nz-render to patch | `wrapForeignMaterials` explicitly skips any material that owns a `customProgramCacheKey` (`nz-render.js:1056`) — you would opt out of AO/PCSS |
| `THREE.ColorManagement.legacyMode = true` | global, set false by nz-render at `rendererInit`, and every tint in the level is authored against it (`:1333-1341`) |
| Editing `NUKEM.html`, `nz-core.js`, or each other's files | `CS2-BRIEF.md:46-49`. Request changes from the orchestrator |

## 9.2 Naming rules

* **Materials**: `'nzenv:' + something`. This is a *namespace of the bake*, not an
  ownership claim — `bakedMatName` (`nz-render.js:2282-2288`) is the only thing that
  reads it, and it is what puts your vertex colours on the same exposure curve as
  the rest of the level (§5.5). Pick distinct suffixes: `nzenv:st-render`,
  `nzenv:st-travertine`, `nzenv:sp-carpaint`, and so on.
* **Meshes**: `'nzstreet-...'` / `'nzprops-...'`. Never `nzenv-*` — a human
  debugging a draw-call list must be able to tell whose mesh it is.
* **Material userData / private keys**: `__nzStreet`, `__nzProps`. Never `__nzEnv`
  (`auditNormals` walks `OWN.mat` looking for it) and never `__nzPatched`,
  `__nzPcss`, `__nzBakeFixed`, `__nzWrap`, `__nzInnerKey` (all nz-render's).
* **Geometry userData**: `nzBakeFixed` is nz-render's flag; do not set it, or your
  vertex colours will be skipped by the exposure remap.
* **Query strings**: `?nzstreet=` / `?nzprops=`. Taken already: `nzenv`, `nzq`,
  `nzdiag`, `nzdebug`, `shot`, `mode`, `width`, `height`, `ss`, `warm`, `settle`,
  `prewarm`, `fov`, `hud`.
* **Flags**: `NZ.flags.street`, `NZ.flags.streetProps`.
* **Exports**: `NZ.street`, `NZ.streetProps`. Never overwrite `NZ.env`.
* **Overlays**: nz-env's `?nzdiag=1` overlay is `#nzenv-diag`, pinned **bottom-left**,
  `z-index 99998`. NUKEM.html's own is pinned top. Use bottom-right / bottom-centre
  and a lower z-index.

## 9.3 Hook priority — the deterministic ordering

`nz-core.js:41-45`: listeners are sorted **descending** by priority, so **a larger
number runs first**. The complete `ready` ordering in the shipped build:

| priority | module | what it does |
|---|---|---|
| `0` | `nz-render.js:4205` | IBL probe, `applyLighting`, `upgradeMaterials` (Phong → Standard, keeping `world:` names), `buildMaterials`, shadow quality |
| `0` | `nz-enemies.js:8584` | enemy rigs |
| `0` | `nz-weapons.js:4402` | viewmodel |
| `-20` | `nz-env.js:3533` | **world mesh upgrade**: materials, world-space UVs, `nzFC`, vertex AO, trim, props, fixtures, decals, doors, lifts, crates |
| **`-30`** | **`nz-street.js`** | **facades — after nz-env, so `nzFC` and the upgraded materials exist** |
| **`-40`** | **`nz-street-props.js`** | **dressing — after the facades it must sit against** |
| `-1000` | `nz-render.js:4237` | `wrapForeignMaterials()` then `neutralizeBakedLighting()` then `applyLighting` / `applyShadowQuality` again |
| `-1000` | `nz-shots.js:1476` | `bootGame()` |

Why `-20` for nz-env (`:3527-3532`): "so nz-render's own `ready` (phong → standard,
IBL probe) has already run and we upgrade the materials it produced, not the ones it
is about to replace."

Why `-1000` for nz-render's late sweep (`nz-render.js:4232-4236`): "Must be last:
nz-env rewrites the very colour attribute we are about to remap (it multiplies its
own contact AO into it) at priority -20, so running any earlier would either be
undone or double-counted."

**Your window is between -20 and -1000.** Use **-30** and **-40**. Do not use
`-1000` (you would race nz-shots' `bootGame` and nz-render's remap) and do not use
`0` or higher (nz-env would not have run).

Two more ordering facts:

* A **throwing listener is disabled, not fatal** (`nz-core.js:53-54`) — the hook bus
  catches, logs and marks it dead. So a throw in your `ready` does not kill the
  frame, but it also does not run your `panic()`. **Always** wrap your own
  `install()` in try/catch and call `panic(err)` yourself, as the template does.
* `NZ.first(name, ...)` (`nz-core.js:58-67`) is the **override** mechanism —
  first non-`undefined` result wins. Neither street module should register a
  `first` hook; you are additive, not an override.

## 9.4 The specific ways nz-env breaks

Concrete failure modes, so you can recognise them in a screenshot:

* **Level renders as unlit flat planes** → something shadowed
  `THREE.Material.prototype.onBeforeCompile` without chaining (§4.6). The whole
  world silently opts out of nz-render's AO/contact-shadow/PCSS patch.
* **Everything is black** → a NaN in a scalar field propagated into an albedo, and
  `Uint8ClampedArray` turned NaN into 0 (`:611-632`). Historically caused by a
  fractional blur radius (`:399-408`). `emitSet` now catches it and warns.
* **Every up-facing facet is 92 % occluded** → geometry with no `nzFC` attribute
  reaching a material that has the injection, and the `nzSpan > 0.5` gate removed
  (`:1427-1430`).
* **Walls covered in dark squiggles** → a ridged fbm crack thresholded too softly
  (`:761-766`, `:879-882`, `:936-949`). Threshold hard, keep it in the normal map.
* **Melted rock / cottage cheese** → relief authored as a bare Sobel number instead
  of millimetres (`:551-606`).
* **Rooms three stops apart** → the baked vertex lighting was not neutralised,
  because the material name did not start `world:` or `nzenv:` (§5.5).
* **Detail normal compiled but never called** → the substitution anchored on the
  expression rather than the `#include` directive (§4.10). `DIAG.detailMiss` counts
  it; `NZ.env.report()` prints it.
* **A prop you can walk into** → `STATS.clearanceClamps > 0`, or a prop placed by
  no rule at all (§7.3).

---

# 10. Before you finish

## 10.1 Validation (mandatory — `CS2-BRIEF.md:62-63`)

```
node --check nz-street.js
node --check nz-street-props.js
npm test                      # = check:level && check:game
```

`npm test` is `scripts/validate-level.mjs` (grid/region/traversal assertions, run
in a bare `vm` over `NUKEM.html:2368-2862`) plus `scripts/validate-game.mjs`
(parses `NUKEM.html` **and** `public/game/NUKEM.html` — both copies must be in sync).
Neither one loads your module, so a green `npm test` proves you did not break the
level; it does **not** prove your module works.

## 10.2 Runtime proof

Your module cannot see the screen, so every claim it makes has to be measurable
from inside the running page (`nz-env.js:96-100`). Ship `report()` and the
`?nzdiag=1` overlay from the template, and check:

```
NZ.street.report()          in the console
?nzdiag=1                   on-screen, screenshottable
NZ.street.stats.clearanceClamps === 0
NZ.street.diag.glslProbe === true
NZ.street.diag.warnings.length === 0
NZ.street.stats.addedCalls  <= 5   (facades)  /  <= 5 (props)
NZ.street.megabytes                 report it; nz-env's is the comparator
```

For every baked set, `DIAG.sets[i].black` must be `false` and `lum` must be
plausible (a wall 18–32 % effective reflectance, a floor 4–22 %, per `:1361`).

## 10.3 Visual proof

`_shot_env.html` launches the 9-preset environment contact sheet
(`NUKEM.html?shot=env&mode=grid&width=1920&height=1080&ss=2&warm=10&settle=18&prewarm=60&fov=60&hud=0`).
Wait for the tab title to read `SHOT READY`. `nz-shots.js` owns it. The headless
harness (`scripts/render-critic.mjs`, Chrome for Testing + puppeteer-core) is
documented in `RENDER-CONTRACT.md §6` including the exact install commands.

Ask the critic to look at, specifically: the facade at grazing angle down the
street (texel density and the sign), the kerb/pavement/road junction (contact
occlusion and the paver scale), a parked car's contact shadow and clearcoat
highlight, and the canopy silhouette against the sky.

## 10.4 The five numbers to quote in your report

```
1 unit = 0.2857 m  (M = 3.5)            -- and every tile you authored, in metres
draws added / removed
triangles per pile
VRAM (STATS.texBytes / 1048576)
install ms, and clearanceClamps (must be 0)
```
