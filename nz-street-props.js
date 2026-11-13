/* ===========================================================================
   NZ-STREET-PROPS  --  the dressing of 233. Sokak.

   Everything that stands ON the street rather than being the street: the
   parked cars, the dark spruce and bare fruit trees, the low painted garden
   walls with their steel railings and precast balusters, the cobra-head
   street lamps, the sagging bundles of overhead cable, the satellite dishes,
   the signage, the bins and the human litter of a provincial Turkish
   residential block on an overcast day in early spring.

   Owns nothing else.  nz-street-sky.js owns the light, nz-street-ground.js
   owns the road and the paving, and nz-street.js owns the facades and their
   six residential stairs.  This file reads those modules and stands things
   on top of them.

   COLLISION.  Collision in this game is grid-based and knows nothing about
   props (ENV-PLAYBOOK 7).  A legal camera position is >= PRAD (1.15) from a
   wall plane and the camera reaches f + 8.243 at the top of a jump -- so
   every prop here is legal by exactly one of:
     A  it protrudes at most HUG = 0.98 from a wall plane
     B  its lowest point is above jumpTop(f) = f + 8.70
     C  its footprint lies on an S_BLOCK cell (+ 0.98 of overhang)
     E  it is shorter than CLIMB = 1.15 above the walkable floor
   Every emitter says which rule makes it legal, and legalC()/hug() count the
   violations into STATS so a bug is legible in the report instead of being a
   prop the player walks through.

   Courier mesh data is supplied by nz-courier-asset.js, exported from Blender.
   Classic script.  three.js r149 core UMD only: no
   BufferGeometryUtils (Pile is the hand-written merge), no CapsuleGeometry,
   no added lights -- r149 cannot mask a light per object and the lamps on
   this street are switched off anyway, because it is the middle of the day.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.streetProps === undefined) NZ.flags.streetProps = false;

  var QS = /[?&]nzprops=(0|off|low|med|high)/i.exec(
    global.location ? global.location.search : '') || null;
  var DISABLED = !!(QS && /^(0|off)$/i.test(QS[1]));

  /* a build-stage gate, for bisecting a stall from the headless harness:
     ?nzpropsdbg=1 atlases only, 2 +materials, 3 +geometry, 4 (default) all */
  var DBGQ = /[?&]nzpropsdbg=(\d)/i.exec(global.location ? global.location.search : '');
  var DBG = DBGQ ? parseInt(DBGQ[1], 10) : 9;

  var THREE = null, scene = null, renderer = null;
  var dead = false, installed = false;

  var OWN = { tex: [], mat: [], geo: [], obj: [], timer: 0 };
  var STATS = {
    sets: 0, texBytes: 0, addedCalls: 0, tris: 0, verts: 0, ms: 0,
    cars: 0, trees: 0, cards: 0, props: 0, dishes: 0, wires: 0,
    bays: 0, pits: 0, islandCells: 0,
    clearanceClamps: 0, illegal: 0, flipped: 0
  };
  var DIAG = { sets: [], piles: [], warnings: [], legal: [] };
  function warn(msg) {
    DIAG.warnings.push(msg);
    try { console.warn('[nz-street-props] ' + msg); } catch (e) {}
  }

  /* ---- small math -------------------------------------------------------- */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function sstep(a, b, x) { return smooth((x - a) / ((b - a) || 1e-6)); }
  function bump(t) { t = clamp(t, -1, 1); return 1 - t * t; }

  /* Deterministic placement RNG (ENV-PLAYBOOK 6.9).  Every random choice in
     this file is seeded from one fixed constant plus a co-prime multiple of
     the emitter's own index, so two runs of the level are bit-identical and a
     critic's screenshot is reproducible. */
  var SEED = 20233;                       /* "233. Sokak", and nothing else */
  function h1(n) { var s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  function rnd(a, b) { return h1(SEED + a * 7919 + b * 104729); }
  function rr(a, b, lo, hi) { return lo + (hi - lo) * rnd(a, b); }
  /* a tiny local stream, for loops that want a sequence rather than a lattice */
  function Rng(s) { var n = s >>> 0; return function () { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; }; }

  /* world-space value noise, for macro tone break-up */
  function vh(i, j) { var s = Math.sin(i * 12.9898 + j * 78.233 + SEED * 0.017) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, z) {
    var xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    var sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    var a = vh(xi, zi), b = vh(xi + 1, zi), c = vh(xi, zi + 1), d = vh(xi + 1, zi + 1);
    var t = a + (b - a) * sx, u = c + (d - c) * sx;
    return t + (u - t) * sz;
  }

  /* ---- scale (ENV-PLAYBOOK section 0) ------------------------------------ */
  var U = 3.5;                            /* world units per metre */
  var M_PER_U = 1 / U;                    /* 0.2857 m -- the LIVE scale */
  function m(x) { return x * U; }

  /* =======================================================================
     SECTION 1 -- the neighbours.
     NZ.street is created by nz-street-sky.js at script-parse time and
     NZ.streetGround by nz-street-ground.js the same way, so both exist
     however the hooks resolve.  Everything here degrades to a warning and a
     sane constant rather than a throw.
     ==================================================================== */
  function ST() { return NZ.street || null; }
  function GR() { return NZ.streetGround || null; }

  function stDay(mat, opts) {
    var s = ST();
    if (s && typeof s.day === 'function') {
      try { return s.day(mat, opts); } catch (e) { warn('day() threw: ' + e.message); }
    }
    if (mat && String(mat.name || '').indexOf('nzday:') !== 0)
      mat.name = 'nzday:' + ((opts && opts.name) || mat.name || 'props');
    return mat;
  }
  /* register a box with the sky's shared occluder registry WITHOUT baking
     against it.  The replay in nz-street-sky.js re-sweeps the union of a
     geometry's own boxes and every box registered after it was baked, so this
     is how PROPS reaches a surface it does not own -- specifically the road
     under a parked car, which nz-street-ground.js baked three hooks earlier.
     It is a union re-trace, not a second multiply, so it cannot double-darken. */
  function stOcclude(boxes) {
    var s = ST();
    if (s && typeof s.occlude === 'function') {
      try { return s.occlude(boxes); } catch (e) { warn('occlude() threw: ' + e.message); }
    }
    return null;
  }
  function stBake(geo, opts) {
    var s = ST();
    if (s && typeof s.bake === 'function') {
      try { return s.bake(geo, opts); } catch (e) { warn('bake() threw: ' + e.message); }
    }
    try {
      if (geo && geo.attributes && geo.attributes.position && THREE) {
        var n = geo.attributes.position.count, c = new Float32Array(n * 3), i;
        for (i = 0; i < n * 3; i++) c[i] = 0.80;
        geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
        if (geo.attributes.uv && !geo.attributes.uv2) geo.setAttribute('uv2', geo.attributes.uv);
      }
    } catch (e2) {}
    return geo;
  }

  /* THE CARVE, AMENDMENT 2 (STREET-MODULE-CONTRACT section 6.1).  The street
     was widened from 32 to 40 units and given an origin -- a junction with a
     kerbed island at its west end -- so EVERY number below moved:

       street body   x [168,252]  z [152,192]   (was z [156,188])
       roadway                    z [160,184]   6.86 m, crown at 172
       throat        x [176,192]  z [152,160]   painted ROAD f = 0
       island        x [184,192]  z [168,176]   S_BLOCK, kerbed
       planes        north 152, south 192

     These are FALLBACKS.  Everything is read back from NZ.street (published at
     the sky module's parse time) and NZ.streetGround, so the orchestrator
     moves the street once and this file follows. */
  var BOX = { x0: 548, x1: 836, z0: 152, z1: 196, y0: 0, y1: 52 };
  /* MOUTH's MEANING CHANGED with the amendment: it is no longer a covered
     alley passage, it is the junction throat's opening in the north plane. */
  var MOUTH = { x0: 548, x1: 548, z0: 152, z1: 152, lintel: 28 };
  /* the street side of the same junction: two cell rows repainted ROAD f = 0 */
  var THROAT = { x0: 548, x1: 548, z0: 152, z1: 160 };
  /* the bridge band: solid building over the throat from y = 28 up, so the
     north wall IS closed above it and an occluder must say so */
  var BAND = { x0: 548, x1: 548, y0: 28, y1: 52, z: 152 };
  var PLANE = { north: 140, south: 208, west: 548, east: 836 };
  var RZ0 = 160, RZ1 = 188;               /* kerb face to kerb face */
  var Y_PAVE = 0.56, Y_KERB = 0.585, Y_GUT = 0.07, Y_CROWN = 0.35;
  var Y_ISLK = 0.95, Y_ISLS = 0.885;      /* island kerb top / soil           */
  /* the kerbed teardrop.  GROUND publishes the ring it actually laid --
     .ring / .inner polylines, .plant (where the conifer goes), .soilAt(x,z),
     .noseX -- and PROPS stands everything on it from those numbers.  The
     fallback is the raw S_BLOCK AABB with a circle inscribed in it. */
  var ISLE = null;
  function islandFallback(box) {
    var cx = (box.x0 + box.x1) * 0.5, cz = (box.z0 + box.z1) * 0.5;
    var R = Math.min(box.x1 - box.x0, box.z1 - box.z0) * 0.5 - 0.2;
    return {
      x0: box.x0, x1: box.x1, z0: box.z0, z1: box.z1, cx: cx, cz: cz,
      kerbTop: Y_ISLK, soilY: Y_ISLS, noseX: cx - R * 1.05,
      plant: { x: cx + 0.55, z: cz, r: R * 0.5, y: Y_ISLS },
      soilAt: function () { return Y_ISLS; },
      radiusAt: function () { return R; },
      synthetic: true
    };
  }
  function adoptGeometry() {
    var s = ST(), g = GR();
    if (s) {
      if (s.BOX) BOX = s.BOX;
      if (s.MOUTH) MOUTH = s.MOUTH;
      if (s.THROAT) THROAT = s.THROAT;
      if (s.BAND) BAND = s.BAND;
      if (s.PLANE) PLANE = s.PLANE;
    }
    if (g) {
      if (g.ROAD) { RZ0 = fin(g.ROAD.z0, RZ0); RZ1 = fin(g.ROAD.z1, RZ1); }
      if (g.THROAT) THROAT = g.THROAT;
      if (g.Y) {
        Y_PAVE = fin(g.Y.pavement, Y_PAVE);
        Y_KERB = fin(g.Y.kerbTop, Y_KERB);
        Y_GUT = fin(g.Y.gutter, Y_GUT);
        Y_CROWN = fin(g.Y.crown, Y_CROWN);
        Y_ISLK = fin(g.Y.islandKerb, Y_ISLK);
        Y_ISLS = fin(g.Y.islandSoil, Y_ISLS);
      }
    } else {
      warn('NZ.streetGround missing -- standing wheels on a local camber model');
    }
    ISLE = (g && g.ISLAND && isFinite(g.ISLAND.cx)) ? g.ISLAND : null;
    if (!ISLE) {
      var ib = (s && s.ISLAND) || { x0: 552, x1: 568, z0: 166, z1: 182 };
      ISLE = islandFallback(ib);
      warn('NZ.streetGround.ISLAND missing -- planting on a circle inscribed ' +
           'in the S_BLOCK cells at x ' + ib.x0 + '-' + ib.x1);
    }
    if (typeof ISLE.soilAt !== 'function') ISLE.soilAt = function () { return Y_ISLS; };
  }
  function inThroat(x, z) {
    return x > THROAT.x0 && x < THROAT.x1 && z > THROAT.z0 - 1e-6 && z < THROAT.z1;
  }
  function onIsland(x, z, pad) {
    if (!ISLE) return false;
    pad = pad || 0;
    return x > ISLE.x0 - pad && x < ISLE.x1 + pad && z > ISLE.z0 - pad && z < ISLE.z1 + pad;
  }
  /* stand a wheel HERE, never on y = 0 (GROUND's note: the road is cambered).
     `x` is optional and only matters inside the junction throat, where the
     side street leaves the main gutter line and rises into its own crossfall
     -- so every wheel that lands near the junction passes it. */
  function roadYAt(z, x) {
    var g = GR();
    if (g && typeof g.roadYAt === 'function') return fin(g.roadYAt(z, x), Y_GUT);
    if (z >= RZ0 && z <= RZ1) {
      var t = clamp((z - (RZ0 + RZ1) * 0.5) / ((RZ1 - RZ0) * 0.5), -1, 1);
      return Y_GUT + (Y_CROWN - Y_GUT) * (1 - t * t);
    }
    if (x !== undefined && inThroat(x, z)) return Y_GUT;
    return Y_GUT;
  }

  /* ---- the game's lexical globals (nz-env.js:130-163 idiom) -------------- */
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
      S_SOLID: fin(tryGet(function () { return S_SOLID; }), 0),
      S_EXIT: fin(tryGet(function () { return S_EXIT; }), 5),
      S_BLOCK: fin(tryGet(function () { return S_BLOCK; }), 6),
      cellAt: tryGet(function () { return cellAt; }) || null,
      isWallCell: tryGet(function () { return isWallCell; }) || null,
      regAt: tryGet(function () { return regAt; }) || null,
      inb: tryGet(function () { return inb; }) || null,
      liftOf: tryGet(function () { return liftOf; }) || null
    };
    if (!g.MW || !g.MH || !g.cellAt || !g.regAt || !g.inb || !g.isWallCell) return null;
    return g;
  }
  function regionAt(cx, cy) { if (!G.inb(cx, cy)) return null; return G.regAt(cx, cy) || null; }
  function openCell(t) { return t !== G.S_SOLID && t !== G.S_EXIT; }
  function liftCell(cx, cy) {
    if (!G.liftOf || !G.inb(cx, cy)) return false;
    return G.liftOf[cy * G.MW + cx] >= 0;
  }

  /* ---- build watchdog ----------------------------------------------------
     A module that cannot see the screen and runs inside somebody else's boot
     must never be able to hang the page.  Every emitter ticks this; if the
     build overruns its budget the tick throws, install()'s try/catch panics,
     and the level comes up WITHOUT the props and WITH a legible reason --
     which is the whole point of non-negotiable 4. */
  var T0 = 0, TICKS = 0, PHASE = 'idle';
  var BUDGET_MS = 26000;
  function phase(p) { PHASE = p; }
  function tick() {
    if (((++TICKS) & 511) === 0 && T0 && (Date.now() - T0) > BUDGET_MS)
      throw new Error('build budget ' + BUDGET_MS + 'ms exceeded in phase "' + PHASE +
                      '" after ' + TICKS + ' emits');
  }

  /* ---- clearance --------------------------------------------------------- */
  var HUG = 0.98;                         /* PRAD - 0.17 */
  function hug(d) {
    if (d > HUG) { STATS.clearanceClamps++; return HUG; }
    return d;
  }
  function apex() { return (G.JUMPV * G.JUMPV) / (2 * G.GRAV); }   /* 2.258 */
  function camTop(f) { return f + G.EYE + apex(); }                /* f + 8.243 */
  function jumpTop(f) { return camTop(f) + 0.45; }                 /* f + 8.70  */
  /* rule C: is this footprint inside a blocked rect plus HUG of overhang? */
  function legalC(name, x0, x1, z0, z1, bay) {
    var ok = (x0 >= bay.x0 - HUG - 1e-3) && (x1 <= bay.x1 + HUG + 1e-3) &&
             (z0 >= bay.z0 - HUG - 1e-3) && (z1 <= bay.z1 + HUG + 1e-3);
    if (!ok) {
      STATS.illegal++;
      DIAG.legal.push(name + ' overhangs its bay: [' + x0.toFixed(2) + ',' + x1.toFixed(2) +
        '] x [' + z0.toFixed(2) + ',' + z1.toFixed(2) + '] vs bay [' + bay.x0 + ',' + bay.x1 +
        '] x [' + bay.z0 + ',' + bay.z1 + ']');
    }
    return ok;
  }

  /* ---- WHICH MISSION -----------------------------------------------------
     Mission 1 is a NIGHT street calibrated against reference photographs and
     nothing here may move on it.  Mission 4 runs nz-street-sky's SUNNY
     profile: a clear blue sky, a 2.45 key from the south-west and a real
     environment probe.  Every behavioural difference in this file is gated on
     L4 and on nothing else, so mission 1 keeps the exact geometry, piles,
     materials and tones it shipped with. */
  var L4 = false;

  /* ---- quality tier ------------------------------------------------------ */
  var TIER = 'high';
  var RES = { hi: 512, md: 256 };
  var DENSITY = 1.0, SEG = 12, RAYS = 32;
  function pickTier() {
    if (QS) return QS[1].toLowerCase();
    var q = (NZ.render && NZ.render.quality) || null;
    if (q === 'ultra') return 'high';
    if (q === 'high' || q === 'med' || q === 'low') return q;
    var nav = global.navigator || {};
    var cores = fin(nav.hardwareConcurrency, 4), mem = fin(nav.deviceMemory, 0), maxTex = 4096;
    try { maxTex = renderer.capabilities.maxTextureSize; } catch (e) {}
    if (maxTex < 4096 || cores <= 2 || (mem && mem <= 2)) return 'low';
    if (cores <= 4 || (mem && mem <= 4)) return 'med';
    return 'high';
  }
  /* DENSITY never gates the cars or the trees.  They ARE the street; a low
     tier that deletes them is not a cheaper street, it is a different one.
     It gates litter, weeds, dishes and card counts only. */
  function applyTier() {
    TIER = pickTier();
    /* RAYS is deliberately low.  The overcast bake is O(verts x rays x
       occluders) and this module hands it 38 000 vertices against 20 boxes --
       at 32 rays that is 24 million ray-box tests inside somebody else's boot,
       which on a two-core box is a visible stall.  Props are small, convex and
       already shaded by their own facet term, so 12-24 rays is indistinguishable. */
    if (TIER === 'low') { RES = { hi: 256, md: 128 }; DENSITY = 0.55; SEG = 8; RAYS = 12; }
    else if (TIER === 'med') { RES = { hi: 512, md: 256 }; DENSITY = 0.80; SEG = 10; RAYS = 18; }
    else { RES = { hi: 512, md: 256 }; DENSITY = 1.00; SEG = 12; RAYS = 24; }
  }

  /* =======================================================================
     SECTION 2 -- the noise / field / albedo toolkit.
     Same algorithms as NZ.tex, with the per-pixel modulo hoisted into index
     tables and every result memoised (nz-env.js:253-515): a 512 fbm through
     NZ.tex costs ~700 ms of closure calls and seven sets would freeze the tab.
     ==================================================================== */
  var NOISE = Object.create(null), LATTICE = Object.create(null), AXIS = Object.create(null);

  function latticeOf(size, seed) {
    var k = size + ':' + seed;
    if (LATTICE[k]) return LATTICE[k];
    var r = NZ.tex.mulberry32(seed >>> 0), g = new Float32Array(size * size), i;
    for (i = 0; i < g.length; i++) g[i] = r();
    return (LATTICE[k] = g);
  }
  function axisTable(res, size) {
    var k = res + '/' + size;
    if (AXIS[k]) return AXIS[k];
    var i0 = new Int32Array(res), i1 = new Int32Array(res), w = new Float32Array(res), x;
    for (x = 0; x < res; x++) {
      var t = x * size / res, xi = Math.floor(t), f = t - xi;
      i0[x] = ((xi % size) + size) % size;
      i1[x] = (i0[x] + 1) % size;
      w[x] = f * f * (3 - 2 * f);
    }
    return (AXIS[k] = { i0: i0, i1: i1, w: w });
  }
  function fbmRaw(res, o) {
    var octaves = o.octaves || 5, freq = o.frequency || 4;
    var gain = o.gain === undefined ? 0.5 : o.gain, lac = o.lacunarity || 2;
    var seed = o.seed === undefined ? 1337 : o.seed;
    var out = new Float32Array(res * res);
    var amp = 1, total = 0, oi, x, y, i, CAP = res >> 1;
    for (oi = 0; oi < octaves; oi++) {
      var capped = Math.round(freq) >= CAP;
      var size = Math.max(2, Math.min(CAP, Math.round(freq)));
      var g = latticeOf(size, seed * 131 + oi * 7919 + 17);
      var T = axisTable(res, size), i0 = T.i0, i1 = T.i1, w = T.w;
      for (y = 0; y < res; y++) {
        var r0 = i0[y] * size, r1 = i1[y] * size, wy = w[y], row = y * res;
        for (x = 0; x < res; x++) {
          var a0 = i0[x], a1 = i1[x], wx = w[x];
          var a = g[r0 + a0], b = g[r0 + a1], c = g[r1 + a0], d = g[r1 + a1];
          var tp = a + (b - a) * wx, bt = c + (d - c) * wx;
          out[row + x] += (tp + (bt - tp) * wy) * amp;
        }
      }
      total += amp; amp *= gain; freq *= lac;
      if (capped) break;
    }
    var inv = 1 / (total || 1);
    if (o.ridged) { for (i = 0; i < out.length; i++) out[i] = 1 - Math.abs(out[i] * inv * 2 - 1); }
    else { for (i = 0; i < out.length; i++) out[i] *= inv; }
    return out;
  }
  function worleyRaw(res, cells, seed, invert) {
    var r = NZ.tex.mulberry32(seed >>> 0);
    var pts = new Float32Array(cells * cells * 2), i;
    for (i = 0; i < cells * cells; i++) {
      var cx0 = i % cells, cy0 = (i - cx0) / cells;
      pts[i * 2] = (cx0 + r()) / cells;
      pts[i * 2 + 1] = (cy0 + r()) / cells;
    }
    var out = new Float32Array(res * res), per = res / cells, np = new Float32Array(18);
    for (var cy = 0; cy < cells; cy++) for (var cx = 0; cx < cells; cx++) {
      var k = 0, ox, oy;
      for (oy = -1; oy <= 1; oy++) for (ox = -1; ox <= 1; ox++) {
        var ix = ((cx + ox) % cells + cells) % cells, iy = ((cy + oy) % cells + cells) % cells;
        np[k++] = (pts[(iy * cells + ix) * 2] + (cx + ox - ix) / cells) * res;
        np[k++] = (pts[(iy * cells + ix) * 2 + 1] + (cy + oy - iy) / cells) * res;
      }
      var x0 = Math.floor(cx * per), x1 = Math.floor((cx + 1) * per);
      var y0 = Math.floor(cy * per), y1 = Math.floor((cy + 1) * per);
      for (var y = y0; y < y1; y++) {
        var row = y * res;
        for (var x = x0; x < x1; x++) {
          var best = 1e18;
          for (k = 0; k < 18; k += 2) {
            var dx = np[k] - x, dy = np[k + 1] - y, d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
          }
          var v = Math.sqrt(best) / per;
          out[row + x] = v > 1 ? 1 : v;
        }
      }
    }
    if (invert) for (i = 0; i < out.length; i++) out[i] = 1 - out[i];
    return out;
  }
  function fbmC(res, o) {
    var k = 'f' + res + '|' + (o.octaves || 5) + '|' + (o.frequency || 4) + '|' +
            (o.seed || 0) + '|' + (o.gain === undefined ? 0.5 : o.gain) + '|' + (o.ridged ? 1 : 0);
    return NOISE[k] || (NOISE[k] = fbmRaw(res, o));
  }
  function worC(res, o) {
    var k = 'w' + res + '|' + (o.cells || 8) + '|' + (o.seed || 0) + '|' + (o.invert ? 1 : 0);
    return NOISE[k] || (NOISE[k] = worleyRaw(res, o.cells || 8, o.seed || 99, !!o.invert));
  }
  function fnew(res) { return new Float32Array(res * res); }
  function fcopy(a) { return new Float32Array(a); }

  /* separable box blur with wrap.  r MUST be an integer -- a fractional
     radius walks src[11.63], gets undefined, and bakes the set pure black. */
  function blurAxis(src, res, r, vertical) {
    r = Math.round(fin(r, 1));
    if (r < 1) return fcopy(src);
    if (r > (res >> 1) - 1) r = (res >> 1) - 1;
    var out = new Float32Array(res * res), inv = 1 / (2 * r + 1), x, y, i, s;
    var sub = new Int32Array(res), add = new Int32Array(res);
    for (x = 0; x < res; x++) {
      sub[x] = (((x - r) % res) + res) % res;
      add[x] = (((x + 1 + r) % res) + res) % res;
    }
    for (y = 0; y < res; y++) {
      s = 0;
      for (i = -r; i <= r; i++) {
        var q = ((i % res) + res) % res;
        s += vertical ? src[q * res + y] : src[y * res + q];
      }
      for (x = 0; x < res; x++) {
        if (vertical) out[x * res + y] = s * inv; else out[y * res + x] = s * inv;
        s -= vertical ? src[sub[x] * res + y] : src[y * res + sub[x]];
        s += vertical ? src[add[x] * res + y] : src[y * res + add[x]];
      }
    }
    return out;
  }
  function blur2(src, res, r) { return blurAxis(blurAxis(src, res, r, false), res, r, true); }

  function cavityAO(h, res, strength) {
    var near = blur2(h, res, Math.max(1, Math.round(res / 64)));
    var far = blur2(h, res, Math.max(2, Math.round(res / 18)));
    var ao = new Float32Array(h.length);
    for (var i = 0; i < h.length; i++) {
      var d = Math.max(0, near[i] - h[i]) * 4.2 + Math.max(0, far[i] - h[i]) * 1.5;
      ao[i] = clamp(1 - d * strength, 0.12, 1);
    }
    return ao;
  }

  function fieldBond(res, rows, cols, joint, seed, stagger) {
    var msk = fnew(res), id = fnew(res), r = NZ.tex.mulberry32(seed);
    var rid = new Float32Array(rows * cols), i;
    for (i = 0; i < rid.length; i++) rid[i] = r();
    var rh = res / rows, cw = res / cols, x, y;
    for (y = 0; y < res; y++) {
      var rw = Math.floor(y / rh) % rows;
      var off = (stagger && (rw & 1)) ? cw * 0.5 : 0;
      var ly = y - Math.floor(y / rh) * rh;
      for (x = 0; x < res; x++) {
        var fx = (((x - off) % res) + res) % res;
        var cc = Math.floor(fx / cw) % cols;
        var lx = fx - Math.floor(fx / cw) * cw;
        var d = Math.min(ly, rh - ly, lx, cw - lx);
        var k = y * res + x;
        msk[k] = d < joint ? clamp(d / joint, 0, 1) : 1;
        id[k] = rid[rw * cols + cc];
      }
    }
    return { m: msk, id: id };
  }
  function fieldPlank(res, n, joint, seed, vertical) {
    var msk = fnew(res), id = fnew(res), r = NZ.tex.mulberry32(seed);
    var pid = new Float32Array(n), i;
    for (i = 0; i < n; i++) pid[i] = r();
    var pw = res / n, x, y;
    for (y = 0; y < res; y++) for (x = 0; x < res; x++) {
      var t = vertical ? x : y;
      var p = Math.floor(t / pw) % n, lt = t - Math.floor(t / pw) * pw;
      var d = Math.min(lt, pw - lt), k = y * res + x;
      msk[k] = d < joint ? clamp(d / joint, 0, 1) : 1;
      id[k] = pid[p];
    }
    return { m: msk, id: id };
  }
  function fieldStreak(res, seed, freq, smear, vertical) {
    var n = fbmC(res, { octaves: 4, frequency: freq, seed: seed });
    return blurAxis(n, res, Math.max(1, Math.round(res / smear)), !!vertical);
  }

  function albNew(res, col) {
    var a = new Float32Array(res * res * 3);
    for (var i = 0; i < a.length; i += 3) { a[i] = col[0]; a[i + 1] = col[1]; a[i + 2] = col[2]; }
    return a;
  }
  function albMul(a, f, lo, hi, mLo, mHi) {
    for (var i = 0, j = 0; i < f.length; i++, j += 3) {
      var t = clamp((f[i] - lo) / (hi - lo || 1e-6), 0, 1);
      var mm = mLo + (mHi - mLo) * t;
      a[j] *= mm; a[j + 1] *= mm; a[j + 2] *= mm;
    }
  }
  function albTint(a, f, col, amt, lo, hi) {
    for (var i = 0, j = 0; i < f.length; i++, j += 3) {
      var t = clamp((f[i] - lo) / (hi - lo || 1e-6), 0, 1) * amt;
      if (t <= 0) continue;
      a[j] += (col[0] - a[j]) * t;
      a[j + 1] += (col[1] - a[j + 1]) * t;
      a[j + 2] += (col[2] - a[j + 2]) * t;
    }
  }
  function albUnits(a, id, mask, pal, amt) {
    var n = pal.length;
    for (var i = 0, j = 0; i < id.length; i++, j += 3) {
      var k = Math.min(n - 1, Math.floor(id[i] * n));
      var t = clamp(mask[i], 0, 1) * amt, c = pal[k];
      a[j] += (c[0] - a[j]) * t;
      a[j + 1] += (c[1] - a[j + 1]) * t;
      a[j + 2] += (c[2] - a[j + 2]) * t;
    }
  }
  function albToCanvas(a, res) {
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    var id = g.createImageData(res, res), d = id.data;
    for (var i = 0, j = 0; i < a.length; i += 3, j += 4) {
      d[j] = clamp(a[i], 0, 255); d[j + 1] = clamp(a[i + 1], 0, 255);
      d[j + 2] = clamp(a[i + 2], 0, 255); d[j + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    return c;
  }
  function normalRaw(h, res, s) {
    var out = new Uint8ClampedArray(res * res * 4);
    var xm = new Int32Array(res), xp = new Int32Array(res), x, y;
    for (x = 0; x < res; x++) { xm[x] = (x - 1 + res) % res; xp[x] = (x + 1) % res; }
    for (y = 0; y < res; y++) {
      var rm = ((y - 1 + res) % res) * res, r0 = y * res, rp = ((y + 1) % res) * res;
      for (x = 0; x < res; x++) {
        var a = xm[x], b = xp[x];
        var tl = h[rm + a], t = h[rm + x], tr = h[rm + b];
        var l = h[r0 + a], r = h[r0 + b];
        var bl = h[rp + a], bb = h[rp + x], br = h[rp + b];
        var gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        var gy = (bl + 2 * bb + br) - (tl + 2 * t + tr);
        var nx = -gx * s, ny = -gy * s;
        var len = Math.sqrt(nx * nx + ny * ny + 1) || 1;
        var o = (r0 + x) * 4;
        out[o] = (nx / len * 0.5 + 0.5) * 255;
        out[o + 1] = (ny / len * 0.5 + 0.5) * 255;
        out[o + 2] = (1 / len * 0.5 + 0.5) * 255;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  /* =======================================================================
     SECTION 3 -- texture emission.
     R = AO, G = roughness, B = metalness: the glTF packing r149 reads
     natively, so one RGBA upload serves roughnessMap + metalnessMap + aoMap.
     ==================================================================== */
  var ANISO = 8;
  function texCanvas(c, srgb, clampEdge) {
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = clampEdge ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = ANISO;
    if (srgb) {
      if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
      else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    }
    OWN.tex.push(t);
    STATS.texBytes += c.width * c.height * 4 * 1.34;
    return t;
  }
  function packORM(ao, rough, metal, res) {
    var d = new Uint8ClampedArray(res * res * 4);
    for (var i = 0, j = 0; i < ao.length; i++, j += 4) {
      d[j] = clamp(ao[i], 0, 1) * 255;
      d[j + 1] = clamp(rough[i], 0.03, 1) * 255;
      d[j + 2] = metal ? clamp(metal[i], 0, 1) * 255 : 0;
      d[j + 3] = 255;
    }
    var t = NZ.tex.texFromData(THREE, d, res, false);
    t.anisotropy = ANISO;
    OWN.tex.push(t);
    STATS.texBytes += res * res * 4 * 1.34;
    return t;
  }

  var METRES_PER_UNIT = M_PER_U;          /* 0.2857, not nz-env's stale 0.6 */

  function emitSet(res, alb, height, rough, metal, aoStrength, relief, name) {
    phase('bake:' + name); tick();
    var q, bad = 0, sumR = 0, sumG = 0, sumB = 0, np = 0;
    for (q = 0; q < alb.length; q += 3) {
      if (!(alb[q] >= 0) || !(alb[q + 1] >= 0) || !(alb[q + 2] >= 0)) {
        bad++; alb[q] = 128; alb[q + 1] = 126; alb[q + 2] = 120;
      }
      sumR += clamp(alb[q], 0, 255); sumG += clamp(alb[q + 1], 0, 255); sumB += clamp(alb[q + 2], 0, 255);
      np++;
    }
    if (bad) warn('albedo "' + name + '" had ' + bad + ' non-finite texels (would have baked BLACK)');

    var ao = cavityAO(height, res, aoStrength === undefined ? 1 : aoStrength);
    relief = relief || {};
    var refTile = relief.tile > 0 ? relief.tile : 4.0;
    var rmsMM = relief.mm > 0 ? relief.mm : 1.0;
    var hpMM = relief.hp > 0 ? relief.hp : 0;
    var rCouple = relief.rough === undefined ? 0.16 : relief.rough;
    var mmPerTexel = refTile * METRES_PER_UNIT * 1000 / res;

    var hn = height, i;
    if (hpMM > 0) {
      var rHP = Math.round(hpMM / mmPerTexel * 0.5);
      if (rHP >= 1 && rHP < (res >> 1) - 1) {
        var lo = blur2(height, res, rHP);
        hn = new Float32Array(height.length);
        for (i = 0; i < hn.length; i++) hn[i] = height[i] - lo[i] + 0.5;
      }
    }
    var hMean = 0;
    for (i = 0; i < hn.length; i++) hMean += hn[i];
    hMean /= hn.length || 1;
    var hVar = 0;
    for (i = 0; i < hn.length; i++) { var hd = hn[i] - hMean; hVar += hd * hd; }
    var hSD = Math.sqrt(hVar / (hn.length || 1));
    if (!(hSD > 1e-5)) hSD = 1e-5;

    var reliefA = (rmsMM / 1000 / METRES_PER_UNIT) / hSD;
    var sobelS = reliefA * res / (4 * refTile);
    if (!isFinite(sobelS) || sobelS < 0) sobelS = 0;

    if (rCouple > 0) {
      var invSD = 1 / (hSD * 2.5);
      for (i = 0; i < rough.length && i < hn.length; i++)
        rough[i] = clamp(rough[i] + clamp((hn[i] - hMean) * invSD, -1, 1) * rCouple, 0.03, 1);
    }

    var set = {
      res: res, refTile: refTile, reliefMM: rmsMM, sobelS: sobelS,
      map: texCanvas(albToCanvas(alb, res), true),
      normalMap: NZ.tex.texFromData(THREE, normalRaw(hn, res, sobelS), res, false),
      ormMap: packORM(ao, rough, metal, res)
    };
    set.normalMap.wrapS = set.normalMap.wrapT = THREE.RepeatWrapping;
    set.normalMap.anisotropy = ANISO;
    OWN.tex.push(set.normalMap);
    STATS.texBytes += res * res * 4 * 1.34;

    var mR = sumR / np, mG = sumG / np, mB = sumB / np;
    set.lum = mR * 0.299 + mG * 0.587 + mB * 0.114;
    var swing = reliefA * METRES_PER_UNIT * 1000;
    DIAG.sets.push({
      name: name, res: res, rgb: [Math.round(mR), Math.round(mG), Math.round(mB)],
      lum: +set.lum.toFixed(1), reliefMM: rmsMM, refTile: refTile,
      swingMM: +swing.toFixed(1), black: set.lum < 6
    });
    if (swing > 120) warn('set "' + name + '" implies ' + swing.toFixed(0) + ' mm of relief -- that is a rock face');
    if (set.lum < 6) warn('baked set "' + name + '" is BLACK (lum ' + set.lum.toFixed(1) + ')');
    STATS.sets++;
    return set;
  }

  /* =======================================================================
     SECTION 4 -- the seven tiling sets.
     Every tile is authored as metres * 3.5 (ENV-PLAYBOOK 3.6 / section 0).
     The COLOUR of a car, a railing or a bin is NOT baked: each set is baked
     near-neutral and the hue arrives as a per-vertex tone, exactly the
     door/keydoor trick generalised (ENV-PLAYBOOK 2.4.5).  One bake, a whole
     car park.
     ==================================================================== */
  var SETS = Object.create(null), BUILD = Object.create(null);
  function getSet(n) { return SETS[n] || (SETS[n] = BUILD[n]()); }

  var T_PAINT = m(2.0);    /* 7.00  car body panels                        */
  var T_GLASS = m(1.2);    /* 4.20  screens and side glass                 */
  var T_TRIM = m(0.5);     /* 1.75  bumpers, tyres, plastics               */
  var T_BARK = m(0.6);     /* 2.10  trunk fissures at their real pitch     */
  var T_WALL = m(1.90);    /* 6.65  the flaking garden wall -- the hero.
                              Was 0.95 m, which fitted a whole flake in the
                              wall's height but also laid the SAME flakes down
                              every 95 cm of a fifty-metre wall, and from
                              across the street that repeat was the first
                              thing the eye found.  At 1.90 m the wall's one
                              metre of height sees half a tile and no patch
                              comes round again inside six panels. */
  var T_CONC = m(0.6);     /* 2.10  precast: edging, balusters, poles      */
  var T_STEEL = m(0.4);    /* 1.40  a 40 mm rail gets a tenth of a repeat  */
  var T_BRICK = m(0.95);   /* 3.33  8 courses x 4 stretchers to the tile,
                              i.e. a 119 mm course and a 238 mm stretcher --
                              a 215 x 65 brick + 10 mm joint, within 6 %.   */

  /* ---- automotive paint --------------------------------------------------
     Baked near-white and colourless.  Flake, polish swirl and a road-film
     streak, and NOTHING else: a car panel is the smoothest thing on this
     street and any albedo story in the map reads as a dent. */
  BUILD.carpaint = function () {
    var res = RES.hi, i;
    var flake = worC(res, { cells: Math.max(24, res >> 2), seed: 241, invert: true });
    var swirl = fieldStreak(res, 242, 30, 5, false);
    var film = fieldStreak(res, 243, 4, 14, true);
    var grain = fbmC(res, { octaves: 4, frequency: 26, seed: 244 });
    var dent = fbmC(res, { octaves: 3, frequency: 5, seed: 245 });

    /* NEUTRAL, and this is a measurement, not a default.  A white car in
       _ref/ref1 and _ref/ref4 carries saturation 0.070-0.079 and it is BLUE:
       the Skoda's bonnet is rgb 204,212,221 and the Kartal's shoulder
       162,168,176.  That chroma is the sky's, not the paint's -- our own
       SKY.zenith is [0.94,1.25,1.71], which is exactly the same colour of
       light -- and the road, whose albedo is neutral, already picks it up at
       sat 0.112.  So the paint must not be tinted at all: a warm "yellowed
       white" albedo CANCELS the sky and lands the body at sat 0.002-0.010,
       which is the flat grey the last pass measured. */
    var a = albNew(res, [196, 196, 196]);
    albMul(a, dent, 0, 1, 0.985, 1.015);
    /* road film: a warm grey haze that climbs the lower body.  It is faint
       here because the strong version is painted per-vertex from the body's
       own height -- a texture cannot know which way is up. */
    albTint(a, film, [150, 143, 130], 0.16, 0.42, 1.0);
    albMul(a, grain, 0, 1, 0.99, 1.01);

    var h = fnew(res), rough = fnew(res), mt = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.5 + (dent[i] - 0.5) * 0.55 + (grain[i] - 0.5) * 0.12, 0, 1);
      rough[i] = clamp(0.19 + (swirl[i] - 0.5) * 0.06 + film[i] * 0.30, 0.05, 1);
      /* PAINT IS A DIELECTRIC, and this line is why the white cars blew out.
         It used to bake metalness 0.52, on the theory that metallic paint is
         metallic.  It is not: the flake is aluminium suspended in a clear
         binder, and every PBR pipeline in the world authors it at metalness ~0
         with the flake carried by the roughness and normal maps -- which is
         what the swirl and flake fields above are already doing.

         At m = 0.52 the reflectance at normal incidence is
         F0 = 0.04(1-m) + albedo*m = 0.243 for a white body, so 56 % of what
         came off a white panel was a specular term that scales with F0 and NOT
         with the vertex tone.  Measured on the money shot's kartal: roof
         scene-linear 1.42, flank 0.47 -- and every one of the road film, the
         body AO, the shut lines and the shoulder roll-off the last pass put
         into the section was multiplying the 44 % that was left, then landing
         on the flat top of the response curve.  The roof came out at 250-255,
         i.e. clipped and BRIGHTER THAN THE SKY IT REFLECTS, which no diffuse
         surface can be.  _ref/ref1 and _ref/ref4 put a white car roof at
         193-206 and never once above 245.

         At m = 0.045, F0 = 0.056 for the same body, the panel is ~87 % diffuse,
         and a tone move of x lands as x on screen.  That is what makes every
         other lever in this file work at all. */
      mt[i] = clamp(0.045 + (flake[i] - 0.5) * 0.05, 0, 1);
    }
    return emitSet(res, a, h, rough, mt, 0.55, { mm: 0.12, tile: T_PAINT, hp: 90, rough: 0.06 }, 'carpaint');
  };

  /* ---- car glass ---------------------------------------------------------
     Opaque, dark, high envMapIntensity.  NOT transparent and NOT
     transmission: sorting a transparent pane against the foliage cutouts and
     the decal piles is a bug farm, and r149's transmission needs a scene
     render target (ENV-PLAYBOOK 2.4.5).  The reflection IS the read. */
  BUILD.carglass = function () {
    var res = RES.md, i, x, y;
    var dirt = fbmC(res, { octaves: 5, frequency: 10, seed: 251 });
    var streak = fieldStreak(res, 252, 7, 9, true);
    var dust = fbmC(res, { octaves: 4, frequency: 30, seed: 253 });
    /* the wiper arc: two concentric sweeps from a pivot near the base, the
       one detail that says "this glass has been driven behind" */
    var wipe = fnew(res);
    var px = res * 0.14, py = res * 1.02;
    for (y = 0; y < res; y++) for (x = 0; x < res; x++) {
      var dx = x - px, dy = y - py, d = Math.sqrt(dx * dx + dy * dy) / res;
      var an = Math.atan2(-dy, dx);
      var band = Math.exp(-Math.pow((d - 0.86) / 0.20, 2));
      var swept = clamp((an - 0.12) / 0.55, 0, 1) * clamp((1.32 - an) / 0.30, 0, 1);
      wipe[y * res + x] = band * swept;
    }

    /* Under a flat overcast a car window is nearly BLACK with a weak sky
       gradient on it -- not a mirror.  The old base was 116/255 with a 1.90
       env intensity on top, which is why the greenhouses came out as light
       grey lids.  74/255 and a 0.95 env is the reference plate. */
    var a = albNew(res, [74, 79, 84]);
    albTint(a, dirt, [104, 103, 98], 0.34, 0.40, 1.0);
    albTint(a, streak, [118, 116, 109], 0.26, 0.55, 1.0);
    albMul(a, wipe, 0, 1, 1.0, 0.78);
    albMul(a, dust, 0, 1, 0.94, 1.08);

    var h = fnew(res), rough = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.5 + (dirt[i] - 0.5) * 0.4, 0, 1);
      /* ROUGHNESS IS THE ONLY LEVER ON A RAKED SCREEN, and this line is why
         the windscreen used to render as a painted metal roof panel.
         Measured on the same car, same frame, same albedo:

           car.front   (camera dead ahead, 45 deg to the screen)   36-50 of 255
           car.dlo     (camera at the flank, ~80 deg to it)       210-240

         i.e. the screen's pixel is ~92 % sky SPECULAR and view-dependent, and
         no vertex tone can touch it -- the DLO's own tone ramp only moves the
         pixel by the 0.109*albedo the greenhouse measured.  What moves it is
         three.js's split-sum EnvironmentBRDF, which at grazing incidence
         (dotNV -> 0) hands over

           roughness 0.15 -> 0.65    roughness 0.30 -> 0.38
           roughness 0.53 -> 0.13    roughness 0.75 -> 0.04

         of the dome, while at NORMAL incidence the same four values are all
         0.031-0.041.  So raising the base roughness costs nothing face-on --
         where the glass is already right -- and cuts the grazing blow-out by
         2.9x.  0.135 gave a mean of ~0.30; 0.40 gives ~0.53, which lands the
         screen at 95-110 of 255 against the 190 flank, i.e. where
         02-front34-right puts it.  It is also simply true: a windscreen is
         not a first-surface mirror, it is a laminate under a wiped film of
         road dust, and every one of the six reference photographs shows soft
         reflections on it, never sharp ones. */
      /* 0.400 -> 0.445 on the second pass.  0.400 (mean 0.53) took the screen
         from 205 to 139 of 255 at 80 degrees of incidence against a 200 body;
         0.445 (mean 0.57) is another 28 % off that grazing term and lands it
         near 115, while the side glass -- which every camera in the sheet sees
         within 30 degrees of normal, where the same curve is flat -- moved by
         5 of 255 between the two renders.  That asymmetry is the whole reason
         this is the right knob and envMapIntensity is not: env would have cost
         the DLO its gradient at the same rate. */
      rough[i] = clamp(0.445 + dirt[i] * 0.16 + streak[i] * 0.10 - wipe[i] * 0.06, 0.30, 1);
    }
    return emitSet(res, a, h, rough, null, 0.5, { mm: 0.10, tile: T_GLASS, hp: 200, rough: 0.05 }, 'carglass');
  };

  /* ---- automotive trim: bumper plastic, rubber, dull chrome -------------- */
  BUILD.trim = function () {
    var res = RES.md, i;
    var pebble = worC(res, { cells: Math.max(20, res >> 3), seed: 261, invert: true });
    var grain = fbmC(res, { octaves: 5, frequency: 34, seed: 262 });
    var scuff = fieldStreak(res, 263, 16, 7, false);
    var chalk = fbmC(res, { octaves: 4, frequency: 6, seed: 264 });

    var a = albNew(res, [178, 177, 174]);
    albMul(a, pebble, 0, 1, 0.90, 1.06);
    albMul(a, grain, 0, 1, 0.95, 1.05);
    albTint(a, scuff, [206, 205, 200], 0.20, 0.62, 1.0);   /* scratched plastic */
    albTint(a, chalk, [196, 192, 184], 0.14, 0.58, 1.0);   /* UV chalking       */

    var h = fnew(res), rough = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.46 + (pebble[i] - 0.5) * 0.5 + (grain[i] - 0.5) * 0.30, 0, 1);
      rough[i] = clamp(0.62 + (grain[i] - 0.5) * 0.14 - scuff[i] * 0.10, 0.16, 1);
    }
    return emitSet(res, a, h, rough, null, 0.9, { mm: 0.35, tile: T_TRIM, hp: 60, rough: 0.18 }, 'trim');
  };

  /* ---- tree bark ---------------------------------------------------------
     Derived from BUILD.plywood: it already has the directionally smeared
     grain and the knots.  The plank field becomes vertical fissures.  hp: 0
     -- bark relief really is 5-10 mm and the fissures ARE the geometry. */
  BUILD.bark = function () {
    var res = RES.md, i;
    var fis = blurAxis(fbmC(res, { octaves: 5, frequency: 20, seed: 271, ridged: true }),
                       res, Math.max(1, res / 6), true);
    var grain = blurAxis(fbmC(res, { octaves: 5, frequency: 40, seed: 272 }), res, Math.max(1, res / 14), true);
    var knot = worC(res, { cells: 7, seed: 273 });
    var moss = fieldStreak(res, 274, 5, 9, true);

    var a = albNew(res, [104, 96, 84]);
    albMul(a, fis, 0, 1, 0.66, 1.16);
    albMul(a, grain, 0, 1, 0.92, 1.08);
    albTint(a, knot, [72, 64, 55], 0.42, 0, 0.22);
    albTint(a, moss, [126, 130, 110], 0.13, 0.72, 1.0);      /* lichen */

    var h = fnew(res), rough = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.46 + (fis[i] - 0.5) * 0.46 + (grain[i] - 0.5) * 0.14 -
                   clamp((0.2 - knot[i]) * 4, 0, 1) * 0.20, 0, 1);
      rough[i] = clamp(0.86 + (grain[i] - 0.5) * 0.10, 0.5, 1);
    }
    return emitSet(res, a, h, rough, null, 1.15, { mm: 2.6, tile: T_BARK, hp: 0, rough: 0.18 }, 'bark');
  };

  /* ---- the garden wall: oxide red flaking off white render ---------------
     THE hero texture of ref1.  It is two materials in one map: a pale cement
     render substrate, and a maroon paint film that has let go in big irregular
     patches.  The paint film is ~0.4 mm proud, so the flake edge catches the
     sky exactly the way it does in the photograph, and the exposed render is
     both paler and much rougher.  A tint cannot produce this; it has to be
     baked, which is why this set is not shared with anything. */
  BUILD.wallpaint = function () {
    var res = RES.hi, i;
    /* a quantile of a field: thresholds are set by the SHARE of the wall they
       should claim, so retuning a noise never silently repaints the street */
    function quant(f, q) {
      var c = new Float32Array(f); c.sort();
      return c[Math.min(c.length - 1, Math.max(0, Math.floor(c.length * q)))];
    }
    /* the loss field: blobs at ~150 mm on a 1.9 m tile, broken up by three
       octaves of fbm so a flake edge is ragged, never cellular */
    var blob = worC(res, { cells: 13, seed: 281, invert: true });
    var edge = fbmC(res, { octaves: 5, frequency: 9, seed: 282 });
    var mid = fbmC(res, { octaves: 4, frequency: 26, seed: 289 });
    var fine = fbmC(res, { octaves: 4, frequency: 64, seed: 283 });
    var trow = fieldStreak(res, 284, 5, 9, false);          /* float-trowel arcs */
    var trov = fieldStreak(res, 285, 5, 9, true);
    var crack = fbmC(res, { octaves: 4, frequency: 30, seed: 286, ridged: true });
    var effl = worC(res, { cells: 20, seed: 287, invert: true });
    var grime = fieldStreak(res, 288, 4, 7, true);

    /* paint = 1 where the film survives.  LOSS is the share that has gone:
       the April 2026 frames show roughly half the field bare between the
       white panel lines, the 2015 and 2019 ones almost none. */
    var LOSS = 0.40;
    var v = fnew(res), paint = fnew(res), c1 = fnew(res), c2 = fnew(res);
    for (i = 0; i < v.length; i++) {
      v[i] = blob[i] * 0.22 + edge[i] * 0.46 + mid[i] * 0.24 + fine[i] * 0.08;
      c1[i] = fine[i] * 0.6 + mid[i] * 0.4;
      c2[i] = fine[i] * 0.5 + crack[i] * 0.5;
    }
    /* every edge is a PAIR of quantiles: a fixed slope on a field whose
       spread is a few hundredths turned 58% cover into a third of it, all
       soft-edged spots (the first render of this map was a leopard) */
    var thA = quant(v, LOSS - 0.025), thB = quant(v, LOSS + 0.025);
    var t1a = quant(c1, 0.925), t1b = quant(c1, 0.945);
    var t2a = quant(c2, 0.900), t2b = quant(c2, 0.925);
    for (i = 0; i < paint.length; i++) {
      var pv = clamp((v[i] - thA) / (thB - thA || 1e-6), 0, 1);
      /* small chips out of sound paint, and crumbs of paint left in a loss:
         a film does not let go along one clean outline */
      var chip = clamp((c1[i] - t1a) / (t1b - t1a || 1e-6), 0, 1);
      var crumb = clamp((c2[i] - t2a) / (t2b - t2a || 1e-6), 0, 1);
      paint[i] = clamp(pv * (1 - chip) + (1 - pv) * crumb * 0.85, 0, 1);
    }
    /* the ghost: render that carried paint for thirty years keeps a pink
       stain for a few millimetres round every surviving patch */
    var pb = blur2(paint, res, Math.max(1, Math.round(res / 110)));
    var halo = fnew(res), lip = fnew(res);
    for (i = 0; i < halo.length; i++) {
      halo[i] = clamp(pb[i] * 1.6, 0, 1) * (1 - paint[i]);
      lip[i] = clamp(1 - Math.abs(paint[i] - pb[i]) * 6.0, 0, 1);
    }

    /* substrate: pale grey-white cement render, floated, slightly dirty */
    var a = albNew(res, [196, 189, 180]);
    albMul(a, trow, 0, 1, 0.95, 1.05);
    albMul(a, trov, 0, 1, 0.97, 1.03);
    albMul(a, fine, 0, 1, 0.95, 1.05);
    albTint(a, effl, [214, 211, 205], 0.26, 0.70, 1.0);     /* efflorescence */
    albTint(a, crack, [150, 144, 136], 0.16, 0.84, 1.0);    /* hairline cracks */
    albTint(a, halo, [176, 128, 122], 0.62, 0.0, 1.0);
    /* THE FILM: an oxide maroon.  The first map carried 130,58,56 and came
       back from the renderer at 112,74,73 -- salmon -- against 80,33,35 for
       the same paint in the 2015 frame and 77,51,45 in the 2026 one.  The
       red was right and the other two channels were sitting on the
       material's specular floor, so the colour is taken further out here
       AND MATS.wall gives up half of that floor. */
    albTint(a, paint, [104, 30, 33], 0.985, 0.25, 1.0);
    /* the film is not uniform either: sun-bleached in patches, darker where
       it is still sound, chalking pink where the binder has gone */
    albMul(a, blob, 0, 1, 1.08, 0.94);
    for (i = 0; i < paint.length; i++) {
      var ck = clamp((fine[i] - 0.62) / 0.38, 0, 1) * paint[i] * 0.16, j = i * 3;
      if (ck > 0) {
        a[j] += (142 - a[j]) * ck; a[j + 1] += (66 - a[j + 1]) * ck; a[j + 2] += (62 - a[j + 2]) * ck;
      }
      /* the lip of a lifting flake is a soft shadow line, not an ink outline */
      var t = (1 - lip[i]) * 0.14;
      if (t > 0) { a[j] *= (1 - t); a[j + 1] *= (1 - t); a[j + 2] *= (1 - t); }
    }
    albTint(a, grime, [128, 124, 112], 0.16, 0.62, 1.0);

    var h = fnew(res), rough = fnew(res);
    for (i = 0; i < h.length; i++) {
      /* the film stands 0.4 mm proud and that is all: the crack term was 0.22
         deep, which cavityAO() turned into a net of black lines across both
         the paint and the render -- crazy paving, where the wall has none */
      h[i] = clamp(0.46 + paint[i] * 0.16 + (trow[i] - 0.5) * 0.14 + (fine[i] - 0.5) * 0.10 -
                   clamp((crack[i] - 0.86) * 6, 0, 1) * 0.05, 0, 1);
      /* exposed render is chalky; the surviving enamel is a low satin */
      rough[i] = clamp(0.94 - paint[i] * 0.30 + (fine[i] - 0.5) * 0.08, 0.28, 1);
    }
    return emitSet(res, a, h, rough, null, 0.32, { mm: 0.7, tile: T_WALL, hp: 240, rough: 0.16 }, 'wallpaint');
  };

  /* ---- the OTHER garden wall: tan facing brick ---------------------------
     _ref/ref7 and _ref/ref2 put a completely different wall in front of
     B-BLOK on the south side: not render at all, but a stretcher-bond facing
     brick in a buff-to-tan range, laid with a struck grey mortar joint, a
     precast coping over it and the dark ornate railing panels above that.
     The bricks vary A LOT unit to unit -- pale buff, tan, a few that fired
     pink -- and that per-unit variation is the whole read; a single-colour
     brick with a bump map is the CG version of this and reads as wallpaper.
     albUnits() is exactly the tool: it tints by the bond's own unit id.

     Tile 0.95 m: at 6 courses to the 0.5 m wall the bond has to fit its
     height, and the set is authored at 4 courses x 2 stretchers per tile,
     which puts a 215 x 65 mm brick within 6 % of its real size. */
  BUILD.gbrick = function () {
    var res = RES.hi, i;
    var bond = fieldBond(res, 8, 4, Math.max(2, res / 100), 271, true);
    var grain = fbmC(res, { octaves: 5, frequency: 30, seed: 272 });
    var pit = worC(res, { cells: Math.max(20, res >> 3), seed: 273, invert: true });
    var sand = fbmC(res, { octaves: 4, frequency: 60, seed: 274 });
    var soil = fieldStreak(res, 275, 4, 10, true);
    var moss = fieldStreak(res, 276, 7, 13, false);
    var effl = worC(res, { cells: 9, seed: 277, invert: true });

    /* the mortar first, then the units over it */
    var a = albNew(res, [150, 145, 134]);                    /* struck grey joint */
    albMul(a, sand, 0, 1, 0.92, 1.08);
    /* THE UNIT PALETTE, read off ref2's crop: a buff majority, a tan and a
       pink minority, one or two that went nearly grey in the kiln. */
    albUnits(a, bond.id, bond.m, [
      [186, 156, 118], [172, 140, 104], [198, 172, 134],
      [164, 128, 96], [190, 150, 122], [156, 138, 116],
      [204, 178, 140], [178, 146, 110]
    ], 1.0);
    /* face texture: the sanded face of a wire-cut brick, plus frost pitting */
    albMul(a, grain, 0, 1, 0.90, 1.10);
    albTint(a, pit, [140, 112, 88], 0.34, 0.66, 1.0);
    albTint(a, effl, [206, 202, 192], 0.26, 0.74, 1.0);      /* salt bloom */
    albTint(a, soil, [116, 108, 96], 0.30, 0.58, 1.0);       /* rain-track soiling */
    albTint(a, moss, [98, 110, 84], 0.20, 0.80, 1.0);

    var h = fnew(res), rough = fnew(res);
    for (i = 0; i < h.length; i++) {
      /* the unit stands 8 mm proud of the raked joint, and no two courses sit
         at quite the same plane -- which is what catches the overcast sky
         along every bed joint and is most of what says "brick" at 2 m */
      var lay = (bond.id[i] - 0.5) * 0.09;
      h[i] = clamp(0.30 + bond.m[i] * 0.52 + lay + (grain[i] - 0.5) * 0.14 -
                   clamp((pit[i] - 0.80) * 5, 0, 1) * 0.26, 0, 1);
      rough[i] = clamp(0.90 - bond.m[i] * 0.10 + (grain[i] - 0.5) * 0.10, 0.42, 1);
    }
    return emitSet(res, a, h, rough, null, 1.08, { mm: 3.4, tile: T_BRICK, hp: 300, rough: 0.14 }, 'gbrick');
  };

  /* ---- precast concrete: edging, balusters, poles, kerb rings ------------- */
  BUILD.gconc = function () {
    var res = RES.md, i;
    var agg = worC(res, { cells: Math.max(18, res >> 3), seed: 291, invert: true });
    var grain = fbmC(res, { octaves: 5, frequency: 20, seed: 292 });
    var form = fieldPlank(res, 4, Math.max(2, res / 90), 293, false);
    var chip = worC(res, { cells: 5, seed: 294, invert: true });
    var dirt = fieldStreak(res, 295, 5, 8, true);
    var moss = fieldStreak(res, 296, 8, 12, false);

    var a = albNew(res, [176, 173, 166]);
    albMul(a, grain, 0, 1, 0.90, 1.08);
    albTint(a, agg, [156, 152, 146], 0.30, 0.60, 1.0);
    albMul(a, form.m, 0.0, 1.0, 0.88, 1.0);
    albTint(a, chip, [196, 192, 184], 0.34, 0.84, 1.0);      /* chipped arris */
    albTint(a, dirt, [132, 128, 120], 0.30, 0.58, 1.0);
    albTint(a, moss, [112, 122, 100], 0.18, 0.78, 1.0);

    var h = fnew(res), rough = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.52 + (agg[i] - 0.5) * 0.34 + (grain[i] - 0.5) * 0.22 -
                   (1 - form.m[i]) * 0.20 - clamp((chip[i] - 0.86) * 6, 0, 1) * 0.16, 0, 1);
      rough[i] = clamp(0.88 + (grain[i] - 0.5) * 0.12, 0.45, 1);
    }
    /* cavity strength 0.45, was 1.0: at full strength every grain of the
       aggregate got its own dark outline and a white-painted coping read as
       pebbledash drawn in ink.  Precast is fine-grained; the relief stays in
       the normal map, where it only shows at grazing light. */
    return emitSet(res, a, h, rough, null, 0.45, { mm: 1.4, tile: T_CONC, hp: 200, rough: 0.16 }, 'gconc');
  };

  /* ---- painted / galvanised steel: railings, masts, wires, bins ----------
     Paint worn to bare metal, rust blooming out of the low spots.  The
     metalness map does the work: paint 0.03, rust 0.20, bare steel 0.92. */
  BUILD.steel = function () {
    var res = RES.md, i;
    var plate = fieldBond(res, 2, 2, Math.max(2, res / 100), 301, false);
    var edgew = worC(res, { cells: 9, seed: 302, invert: true });
    var grain = fbmC(res, { octaves: 5, frequency: 22, seed: 303 });
    var rust = fbmC(res, { octaves: 5, frequency: 7, seed: 304 });
    var scratch = fieldStreak(res, 305, 40, 5, false);
    var bleed = fieldStreak(res, 306, 5, 8, true);
    var spangle = worC(res, { cells: Math.max(14, res >> 4), seed: 307, invert: true });

    var a = albNew(res, [182, 183, 180]);                    /* galvanised grey */
    albMul(a, grain, 0, 1, 0.93, 1.07);
    albTint(a, spangle, [200, 202, 200], 0.22, 0.62, 1.0);   /* zinc spangle */
    albTint(a, scratch, [204, 205, 203], 0.14, 0.70, 1.0);  /* brush scratches */
    albTint(a, rust, [122, 68, 42], 0.62, 0.60, 1.0);
    albTint(a, bleed, [128, 82, 54], 0.26, 0.66, 1.0);       /* rust bleed */
    albTint(a, edgew, [206, 205, 200], 0.26, 0.80, 1.0);     /* bare metal at edges */

    var h = fnew(res), rough = fnew(res), mt = fnew(res);
    for (i = 0; i < h.length; i++) {
      var rv = clamp((rust[i] - 0.60) * 2.6, 0, 1);
      var bare = clamp((edgew[i] - 0.80) * 5, 0, 1);
      h[i] = clamp(0.52 + (1 - plate.m[i]) * -0.22 + (grain[i] - 0.5) * 0.20 + rv * 0.16, 0, 1);
      rough[i] = clamp(0.46 + rv * 0.40 - bare * 0.24 + (grain[i] - 0.5) * 0.10, 0.10, 1);
      mt[i] = clamp(0.03 + rv * 0.18 + bare * 0.90, 0, 1);
    }
    return emitSet(res, a, h, rough, mt, 1.0, { mm: 0.7, tile: T_STEEL, hp: 200, rough: 0.14 }, 'steel');
  };

  /* =======================================================================
     SECTION 5 -- the foliage atlas.
     NOT a tiling PBR set (ENV-PLAYBOOK 2.4.6).  A 4 x 4 alpha-cutout atlas
     drawn with plain 2D canvas strokes; the alpha comes out of the strokes
     for free and must NOT be post-multiplied.  Early spring: the conifers are
     full and almost black-green, everything deciduous is bare buds, and the
     one blossom tile is the only flower on the whole street.
     ==================================================================== */
  var LEAF = { tex: null, mat: null, rect: [], res: 512, n: 4 };
  var L_SPRIG0 = 0, L_SPRIG1 = 1, L_SPRIG2 = 2, L_MASS = 3,
      L_TWIG0 = 4, L_TWIG1 = 5, L_BLOSSOM = 6, L_ROSE = 7,
      L_WEED0 = 8, L_WEED1 = 9, L_IVY = 10, L_DRY = 11,
      L_SPRIG3 = 12, L_SHRUB = 13, L_VINE = 14, L_NEEDLE = 15;

  function buildLeafAtlas() {
    /* 512 at every tier.  At 256 the tile is 64 px and a needle stroke is
       under a pixel wide, which is precisely how the crown ended up as a
       translucent grey haze -- and the headless harness renders at low. */
    var res = LEAF.res = 512, N = LEAF.n, ts = res / N;
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    var R = Rng(SEED + 4111);
    g.clearRect(0, 0, res, res);

    function cell(i) { return [(i % N) * ts, Math.floor(i / N) * ts]; }
    function push(i) {
      var o = cell(i), pad = ts * 0.010;
      LEAF.rect[i] = [(o[0] + pad) / res, 1 - (o[1] + ts - pad) / res,
                      (o[0] + ts - pad) / res, 1 - (o[1] + pad) / res];
    }

    /* a conifer frond: a woody stem running left->right across the tile with
       needle pairs all along it, drooping slightly.  Drawn tip-right so the
       card can be laid stem-inward from the trunk.

       THE OPACITY PROBLEM.  A frond drawn only as 1 px strokes is 85 % empty
       texels; three mip levels later its alpha has averaged down below the
       alphaTest and the card dissolves, so the crown turns into a grey haze
       with the blown-out sky showing straight through it.  That is exactly the
       "frosted" spruce the critic saw.  The fix is a FILLED dark body under the
       needles -- a ragged lens along the shoot -- so the tile keeps alpha ~1
       through the whole mip chain, and the needles are only the silhouette. */
    function frond(i, cols, dens, droop, bodyCol, bodyW) {
      var o = cell(i), x0 = o[0] + ts * 0.02, y0 = o[1] + ts * 0.46;
      var Lf = ts * 0.965, k, s, n = 20;
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';

      /* --- the dark body: a tapered ragged blade along the shoot --------- */
      var up = [], dn = [], t, bx, by, w;
      for (s = 0; s <= n; s++) {
        t = s / n;
        bx = x0 + Lf * t; by = y0 + ts * droop * t * t;
        /* fat at the third, tapering to a point -- a real spruce spray */
        w = ts * bodyW * (0.16 + 0.96 * Math.sin(Math.pow(t, 0.42) * PI));
        up.push([bx, by - w * (0.58 + R() * 0.70)]);
        dn.push([bx, by + w * (0.58 + R() * 0.70)]);
      }
      g.fillStyle = bodyCol;
      g.beginPath();
      g.moveTo(up[0][0], up[0][1]);
      for (s = 1; s <= n; s++) g.lineTo(up[s][0], up[s][1]);
      for (s = n; s >= 0; s--) g.lineTo(dn[s][0], dn[s][1]);
      g.closePath(); g.fill();

      /* the shoot, and the four side shoots the whorl hangs from */
      g.strokeStyle = 'rgba(46,40,30,1)';
      g.lineWidth = ts * 0.026;
      g.beginPath(); g.moveTo(x0, y0);
      g.quadraticCurveTo(x0 + Lf * 0.5, y0 + ts * droop * 0.5, x0 + Lf, y0 + ts * droop);
      g.stroke();
      for (s = 0; s < 5; s++) {
        var st = 0.14 + s * 0.18, sx = x0 + Lf * st, sy = y0 + ts * droop * st * st;
        var side = (s & 1) ? 1 : -1;
        var sl = Lf * (0.16 + R() * 0.12);
        g.strokeStyle = 'rgba(42,38,30,1)'; g.lineWidth = ts * 0.016;
        g.beginPath(); g.moveTo(sx, sy);
        g.quadraticCurveTo(sx + sl * 0.6, sy + side * ts * 0.10,
                           sx + sl, sy + side * ts * (0.16 + R() * 0.10));
        g.stroke();
      }

      /* needles: short paired strokes, FAT enough to survive the mip chain,
         denser toward the stem, ragged at the tip so the silhouette is not a
         smooth outline */
      var nn = Math.round(dens * (TIER === 'low' ? 0.65 : 1));
      for (k = 0; k < nn; k++) {
        t = Math.pow(R(), 0.78);
        bx = x0 + Lf * t;
        by = y0 + ts * droop * t * t + (R() - 0.5) * ts * bodyW * 1.5;
        var side2 = R() < 0.5 ? 1 : -1;
        var spread = (0.34 - 0.19 * t) * (0.50 + R() * 1.05);
        var ln = ts * spread * 0.52;
        var ang = side2 * (0.80 + R() * 0.60) + (R() - 0.5) * 0.30;
        g.strokeStyle = cols[(R() * cols.length) | 0];
        g.lineWidth = ts * (0.016 + R() * 0.010);
        g.beginPath(); g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(ang * 0.5 + 0.22) * ln * 1.15, by + Math.sin(ang) * ln);
        g.stroke();
      }
      g.restore();
      push(i);
    }

    /* a dense interior mass: an opaque dark blob with a needled rim, used for
       the cards buried inside the crown so the cone is neither hollow nor
       translucent.  This is the tile that stops the sky coming through. */
    function mass(i, cols, bodyCol, n) {
      var o = cell(i), cx = o[0] + ts * 0.5, cy = o[1] + ts * 0.50, k, a, rad;
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
      /* the opaque core: a ragged disc */
      g.fillStyle = bodyCol;
      g.beginPath();
      for (k = 0; k <= 26; k++) {
        a = k / 26 * TAU;
        rad = ts * (0.30 + 0.13 * (0.4 + R() * 0.6));
        var px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad * 0.84;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fill();
      /* the needled rim and the tone break-up over the core */
      for (k = 0; k < n; k++) {
        a = R() * TAU; rad = ts * 0.44 * Math.pow(R(), 0.62);
        var bx = cx + Math.cos(a) * rad, by = cy + Math.sin(a) * rad * 0.86;
        var ln = ts * (0.055 + R() * 0.10), an = R() * TAU;
        g.strokeStyle = cols[(R() * cols.length) | 0];
        g.lineWidth = ts * (0.016 + R() * 0.012);
        g.beginPath(); g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(an) * ln, by + Math.sin(an) * ln);
        g.stroke();
      }
      g.restore(); push(i);
    }

    /* a bare twig spray with buds: the early-spring read.  Drawn stem-left. */
    function twigs(i, bark, budc, budR, n) {
      var o = cell(i), x0 = o[0] + ts * 0.04, y0 = o[1] + ts * 0.52, k;
      g.save(); g.lineCap = 'round';
      function limb(px, py, ang, len, w, depth) {
        var ex = px + Math.cos(ang) * len, ey = py + Math.sin(ang) * len;
        g.strokeStyle = bark; g.lineWidth = Math.max(0.6, w);
        g.beginPath(); g.moveTo(px, py);
        g.quadraticCurveTo(px + Math.cos(ang + 0.2) * len * 0.55,
                           py + Math.sin(ang + 0.2) * len * 0.55, ex, ey);
        g.stroke();
        if (depth <= 0) {
          if (budR > 0) {
            g.fillStyle = budc;
            g.beginPath(); g.arc(ex, ey, budR * (0.7 + R() * 0.7), 0, TAU); g.fill();
          }
          return;
        }
        var br = 2 + ((R() * 2) | 0);
        for (var b = 0; b < br; b++) {
          var t = 0.45 + 0.55 * (b / br) + R() * 0.12;
          var mx = px + Math.cos(ang) * len * t, my = py + Math.sin(ang) * len * t;
          limb(mx, my, ang + (R() - 0.5) * 1.5, len * (0.42 + R() * 0.26), w * 0.55, depth - 1);
        }
      }
      for (k = 0; k < n; k++)
        limb(x0, y0 + (R() - 0.5) * ts * 0.12, (R() - 0.5) * 0.9, ts * (0.34 + R() * 0.16),
             ts * 0.020, TIER === 'low' ? 2 : 3);
      g.restore(); push(i);
    }

    /* an upright tuft: weeds, dry grass, a cut-back rose */
    function tuft(i, cols, n, hgt, wob, seedh) {
      var o = cell(i), cx = o[0] + ts * 0.5, base = o[1] + ts * 0.97, k;
      g.save(); g.lineCap = 'round';
      for (k = 0; k < n; k++) {
        var sx = cx + (R() - 0.5) * ts * 0.72;
        var hh = ts * hgt * (0.4 + R() * 0.85);
        var lean = (R() - 0.5) * wob * ts;
        g.strokeStyle = cols[(R() * cols.length) | 0];
        g.lineWidth = ts * (0.007 + R() * 0.009);
        g.beginPath(); g.moveTo(sx, base);
        g.quadraticCurveTo(sx + lean * 0.35, base - hh * 0.6, sx + lean, base - hh);
        g.stroke();
        if (seedh && R() < 0.22) {
          g.fillStyle = seedh;
          g.beginPath(); g.ellipse(sx + lean, base - hh, ts * 0.011, ts * 0.030, lean * 0.02, 0, TAU); g.fill();
        }
      }
      g.restore(); push(i);
    }

    /* a leafy spray: ivy on the wall, a shrub, one blossoming branch */
    function leaves(i, bark, pal, n, lr, blossom) {
      var o = cell(i), x0 = o[0] + ts * 0.05, y0 = o[1] + ts * 0.54, k;
      g.save(); g.lineCap = 'round';
      g.strokeStyle = bark; g.lineWidth = ts * 0.018;
      g.beginPath(); g.moveTo(x0, y0);
      g.quadraticCurveTo(x0 + ts * 0.45, y0 - ts * 0.16, x0 + ts * 0.90, y0 - ts * 0.06);
      g.stroke();
      for (k = 0; k < 5; k++) {
        var t0 = 0.15 + k * 0.18;
        g.lineWidth = ts * 0.010;
        g.beginPath();
        g.moveTo(x0 + ts * 0.9 * t0, y0 - ts * 0.10 * t0);
        g.lineTo(x0 + ts * 0.9 * t0 + ts * 0.16, y0 - ts * 0.10 * t0 + ((k & 1) ? 1 : -1) * ts * 0.22);
        g.stroke();
      }
      for (k = 0; k < n; k++) {
        var tt = R(), px = x0 + ts * 0.92 * tt + (R() - 0.5) * ts * 0.20;
        var py = y0 - ts * 0.12 * tt + (R() - 0.5) * ts * 0.44;
        var rr2 = ts * lr * (0.6 + R() * 0.8), an2 = R() * TAU;
        g.fillStyle = pal[(R() * pal.length) | 0];
        g.save(); g.translate(px, py); g.rotate(an2);
        g.beginPath(); g.ellipse(0, 0, rr2, rr2 * 0.78, 0, 0, TAU); g.fill();
        g.restore();
      }
      if (blossom) {
        for (k = 0; k < n * 0.7; k++) {
          var bx2 = x0 + ts * 0.92 * R(), by2 = y0 + (R() - 0.5) * ts * 0.5;
          g.fillStyle = 'rgba(246,242,238,0.96)';
          for (var pn = 0; pn < 5; pn++) {
            var pa = pn / 5 * TAU;
            g.beginPath();
            g.ellipse(bx2 + Math.cos(pa) * ts * 0.014, by2 + Math.sin(pa) * ts * 0.014,
                      ts * 0.013, ts * 0.010, pa, 0, TAU);
            g.fill();
          }
          g.fillStyle = 'rgba(214,196,138,0.9)';
          g.beginPath(); g.arc(bx2, by2, ts * 0.006, 0, TAU); g.fill();
        }
      }
      g.restore(); push(i);
    }

    /* Very dark blue-green.  A spruce under an overcast sky in Konya reads
       38-64/255 in the reference plates and the shadowed interior is nearly
       black; anything brighter turns the street into an English summer.  The
       BODY colours are darker still -- they are the shaded mass the needles
       stand on, and they are what the eye reads at 20 m. */
    /* RE-CALIBRATED against the owner's own photographs of the junction
       (2026-08), which supersede the Street View plates the first pass used.
       Sampled over whole crown silhouettes those trees measure rgb 54-62 /
       62-69 / 41-43 -- luminance about 60, roughly 0.45 of the road beside
       them, green a tenth above red and blue only 60 % of green.  The old
       palette landed the island cedar at luminance 11.5, ratio 0.10: not a
       dark tree, a hole in the frame.  Everything below is that measurement
       walked back through alphaTest, the vertex tone and the bake. */
    var CON = ['rgba(113,148,72,1)', 'rgba(92,123,61,1)', 'rgba(137,171,85,1)', 'rgba(76,103,54,1)'];
    var CON2 = ['rgba(120,155,83,1)', 'rgba(144,178,96,1)', 'rgba(96,130,72,1)'];
    var BODY1 = 'rgba(72,96,48,1)';        /* the shaded mass of a spray      */
    var BODY2 = 'rgba(83,107,57,1)';
    var BODYM = 'rgba(57,77,38,1)';        /* the crown interior              */
    var DENS = TIER === 'low' ? 130 : 260;
    frond(L_SPRIG0, CON, DENS, 0.13, BODY1, 0.085);
    frond(L_SPRIG1, CON, DENS * 0.9, 0.21, BODY1, 0.075);
    frond(L_SPRIG2, CON2, DENS * 0.85, 0.07, BODY2, 0.095);
    mass(L_MASS, CON, BODYM, TIER === 'low' ? 200 : 420);
    frond(L_SPRIG3, CON2, DENS * 0.8, 0.17, BODY2, 0.070);
    mass(L_NEEDLE, CON2, BODYM, TIER === 'low' ? 170 : 350);

    /* early spring: thin, airy, pale grey-brown, buds only.  A twig spray that
       is too dense or too warm reads as a dead brown cloud instead of a fruit
       tree waiting to break. */
    twigs(L_TWIG0, 'rgba(138,131,120,1)', 'rgba(118,110,84,1)', ts * 0.0075, TIER === 'low' ? 2 : 3);
    twigs(L_TWIG1, 'rgba(150,143,132,1)', 'rgba(128,122,92,1)', ts * 0.0065, TIER === 'low' ? 2 : 3);
    twigs(L_ROSE, 'rgba(96,78,66,1)', 'rgba(108,92,70,1)', ts * 0.010, 4);

    leaves(L_BLOSSOM, 'rgba(128,116,104,1)', ['rgba(120,132,96,0.95)'], 10, 0.020, true);
    leaves(L_IVY, 'rgba(92,84,72,1)',
           ['rgba(58,84,54,0.98)', 'rgba(48,72,48,0.98)', 'rgba(70,94,60,0.98)'], 44, 0.038, false);
    leaves(L_SHRUB, 'rgba(104,94,80,1)',
           ['rgba(78,96,62,0.98)', 'rgba(64,84,54,0.98)'], 34, 0.030, false);
    leaves(L_VINE, 'rgba(112,98,80,1)', ['rgba(122,110,80,0.9)'], 14, 0.024, false);

    var WEED = ['rgba(96,110,68,1)', 'rgba(80,96,58,1)', 'rgba(110,120,76,1)', 'rgba(70,84,54,1)'];
    var DRY = ['rgba(150,138,100,1)', 'rgba(132,120,88,1)', 'rgba(162,150,112,1)'];
    tuft(L_WEED0, WEED, TIER === 'low' ? 26 : 52, 0.72, 0.22, null);
    tuft(L_WEED1, WEED, TIER === 'low' ? 20 : 40, 0.52, 0.30, 'rgba(126,132,86,1)');
    tuft(L_DRY, DRY, TIER === 'low' ? 22 : 44, 0.62, 0.26, 'rgba(178,166,124,1)');

    LEAF.tex = texCanvas(c, true, true);
    return LEAF.tex;
  }

  /* =======================================================================
     SECTION 6 -- the signage / panel atlas.
     Everything with letterforms or a hard graphic edge: the street plate, the
     number plates, the shop fascia, the crescent banner, the no-parking sign,
     the kilim thrown over a railing.  Opaque tiles with an alphaTest cutout
     so a round sign is round.
     ==================================================================== */
  var PANEL = { tex: null, mat: null, rect: [], res: 512, n: 6 };
  var P_STREET = 0, P_PLATE = 1, P_PLATE2 = 2, P_BANNER = 3,
      P_FASCIA = 4, P_NOPARK = 5, P_ABOARD = 6, P_KILIM = 7,
      P_SHUTTER = 8, P_TAIL = 9, P_HEAD = 10, P_GRILLE = 11,
      P_POSTER = 12, P_NUMBER = 13, P_HAZARD = 14, P_DISH = 15,
      /* the automotive row: a car at 3 m needs square lamps, a real grille, a
         wheel face and a hard contact shadow, and none of them is a tiling
         PBR surface.  Five extra columns cost nothing -- the atlas is one
         upload and one draw call either way. */
      P_SHADOW = 16, P_LAMPF = 17, P_LAMPR = 18, P_GRILLE2 = 19, P_WCAP = 20,
      P_WHEEL = 21, P_LAMPF2 = 22, P_LAMPR2 = 23, P_PLATE3 = 24,
      /* AMENDMENT 2: the junction.  _ref/ref8 puts four signs on and around
         the island and none of them is a shape a PBR tile can make -- a blue
         direction board with two town names, the round blue mandatory arrow,
         the red warning triangle and the black-on-yellow chevron board that
         protects the nose.  Plus the ornate steel railing panel that stands on
         B-BLOK's brick garden wall in ref2/ref7, which as a cutout card is one
         quad instead of forty balusters, and the minibus's flank graphic. */
      P_SIGNDIR = 25, P_SIGNARR = 26, P_WARN = 27, P_CHEV = 28,
      P_RAILP = 29, P_SWOOSH = 30,
      /* THE COURIER ROW.  The street now parks exactly one vehicle -- the
         owner's silver Ford Tourneo Courier, matched against the six
         reference photographs -- and three of its signature cues cannot be
         faked out of the 90s automotive tiles above: the big inverted-
         trapezoid gloss-black grille wearing the blue oval, the five-spoke
         alloys, and the tall tail clusters flanking a near-vertical
         tailgate.  Cells 31..33 were free; the atlas is 6 x 6. */
      P_GRILLEC = 31, P_WALLOY = 32, P_LAMPRC = 33;

  /* ---- ANISOTROPIC TILES -------------------------------------------------
     The atlas cell is SQUARE and several of these tiles are mapped onto quads
     that are nothing like square: the shop fascia is 2.29 x 0.48 m, so a
     letterform drawn round in the cell arrives on the wall 4.8x too wide.
     That -- not only the mirroring -- is why GUVEN MARKET was unreadable.
     Each tile that needs it is drawn with its glyphs pre-stretched VERTICALLY
     by the quad's aspect, so the quad's own horizontal stretch cancels it.
     The physical sizes live here so the two ends can never drift apart. */
  /* the corner shop moved off the hero blocks: A-BLOK's ground storey is the
     porch and its siding, and B-BLOK's is its own entrance, so the only run
     that can carry a market is the generic NC block on the junction corner --
     which is exactly where _ref/ref5 has one. */
  var SHOP = { x0: 194.4, x1: 203.0, y0: m(2.62), y1: m(3.10) };
  var BANNER = { w: m(2.70), h: m(0.84), x: 180.0, y: m(4.9) };
  var SPLATE = { w: m(1.04), h: m(0.60) };            /* the 233. SK. plate  */
  var CPLATE = { w: m(0.470), h: m(0.110) };          /* a 470 x 110 mm plate */
  var DIRSN = { w: m(1.10), h: m(0.62) };             /* the blue direction board */
  var RAILP = { w: m(1.35), h: m(0.80) };             /* one ornate infill panel  */
  var A_FASCIA = (SHOP.x1 - SHOP.x0) / (SHOP.y1 - SHOP.y0);
  var A_BANNER = BANNER.w / BANNER.h;
  var A_SPLATE = SPLATE.w / SPLATE.h;
  var A_CPLATE = CPLATE.w / CPLATE.h;
  var A_DIRSN = DIRSN.w / DIRSN.h;
  var A_RAILP = RAILP.w / RAILP.h;

  function buildPanelAtlas() {
    /* 6 x 6 now, for the junction signs.  The cell therefore has to grow with
       it or every letterform on the street loses a fifth of its resolution:
       1536/6 = 256 px a cell against the old 1024/5 = 205, and low tier keeps
       its old 1024/6 = 171 against 768/5 = 154.  One upload either way. */
    var res = PANEL.res = (TIER === 'low' ? 1024 : 1536), N = PANEL.n, ts = res / N;
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    var R = Rng(SEED + 5171);
    g.clearRect(0, 0, res, res);

    function cell(i) { return [(i % N) * ts, Math.floor(i / N) * ts]; }
    function push(i) {
      var o = cell(i), pad = ts * 0.008;
      PANEL.rect[i] = [(o[0] + pad) / res, 1 - (o[1] + ts - pad) / res,
                       (o[0] + ts - pad) / res, 1 - (o[1] + pad) / res];
    }
    function fitText(txt, font, maxW, cx, cy, col) {
      var size = ts * 0.28, w;
      for (var k = 0; k < 24; k++) {
        g.font = size + 'px ' + font;
        w = g.measureText(txt).width;
        if (w <= maxW) break;
        size *= 0.92;
      }
      g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, cx, cy);
      return size;
    }
    /* the same, pre-stretched vertically by `ky` so it arrives on a quad of
       aspect ky at its true proportions.  maxH caps the stretched cap height
       so the glyphs cannot climb out of their own cell. */
    function fitTextA(txt, font, maxW, maxH, cx, cy, col, ky) {
      var size = ts * 0.30, w, k;
      for (k = 0; k < 30; k++) {
        g.font = size + 'px ' + font;
        w = g.measureText(txt).width;
        if (w <= maxW && size * ky * 1.02 <= maxH) break;
        size *= 0.90;
      }
      g.save();
      g.translate(cx, cy); g.scale(1, ky); g.translate(-cx, -cy);
      g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, cx, cy);
      g.restore();
      return size;
    }
    /* every panel on this street has been outdoors for fifteen years */
    function weather(i, amt, dark) {
      var o = cell(i), k;
      g.save();
      g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
      for (k = 0; k < 40; k++) {
        var bx = o[0] + R() * ts, by = o[1] + R() * ts, br = ts * (0.01 + R() * 0.10);
        var gr = g.createRadialGradient(bx, by, 0, bx, by, br);
        var a = amt * (0.10 + R() * 0.30);
        gr.addColorStop(0, 'rgba(' + dark + ',' + a + ')');
        gr.addColorStop(1, 'rgba(' + dark + ',0)');
        g.fillStyle = gr; g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fill();
      }
      for (k = 0; k < 14; k++) {
        var sx = o[0] + R() * ts;
        var gr2 = g.createLinearGradient(sx, o[1], sx, o[1] + ts);
        gr2.addColorStop(0, 'rgba(' + dark + ',0)');
        gr2.addColorStop(1, 'rgba(' + dark + ',' + (amt * 0.22) + ')');
        g.fillStyle = gr2; g.fillRect(sx, o[1], ts * 0.03, ts);
      }
      g.restore();
    }
    var FONT = '"Arial Narrow",Arial,Helvetica,sans-serif';
    var FONTB = 'bold ' + FONT;

    /* 0 -- the blue and white street plate.  Turkish plates carry the
       neighbourhood above the street, both in white on a deep blue field. */
    var o0 = cell(P_STREET);
    g.fillStyle = '#12447e'; g.fillRect(o0[0], o0[1], ts, ts);
    g.strokeStyle = '#e9ecef'; g.lineWidth = ts * 0.020;
    g.strokeRect(o0[0] + ts * 0.045, o0[1] + ts * 0.070, ts * 0.91, ts * 0.86);
    fitTextA('ÖZGÜR MAH.', FONT, ts * 0.78, ts * 0.30,
             o0[0] + ts * 0.5, o0[1] + ts * 0.28, '#dfe6ee', A_SPLATE);
    fitTextA('233. SK.', FONTB, ts * 0.76, ts * 0.42,
             o0[0] + ts * 0.5, o0[1] + ts * 0.64, '#ffffff', A_SPLATE);
    weather(P_STREET, 0.7, '38,44,40');
    push(P_STREET);

    /* 1,2 -- number plates: white field, blue EU-style strip, Konya is 42 */
    /* the plate fills its cell now: the quad is 4.27:1 and the plate band used
       to be 2.4:1 inside it, so a 520 x 110 mm plate rendered as a 44 mm
       sliver with the registration stretched half as wide again */
    function plate(i, txt) {
      var o = cell(i), py = o[1] + ts * 0.02, ph = ts * 0.96;
      g.fillStyle = '#e6e4de'; g.fillRect(o[0] + ts * 0.02, py, ts * 0.96, ph);
      g.fillStyle = '#123f86'; g.fillRect(o[0] + ts * 0.02, py, ts * 0.135, ph);
      g.fillStyle = '#f0d24a';
      fitTextA('TR', FONTB, ts * 0.11, ts * 0.30, o[0] + ts * 0.088,
               py + ph * 0.76, '#f0d24a', A_CPLATE);
      g.strokeStyle = '#8d8b84'; g.lineWidth = ts * 0.010;
      g.strokeRect(o[0] + ts * 0.02, py, ts * 0.96, ph);
      fitTextA(txt, FONTB, ts * 0.78, ts * 0.76, o[0] + ts * 0.575,
               py + ph * 0.52, '#1b1c1e', A_CPLATE);
      weather(i, 0.55, '60,58,52');
      push(i);
    }
    plate(P_PLATE, '42 AK 4218');
    plate(P_PLATE2, '42 SN 073');

    /* 3 -- the red banner, white crescent and star */
    /* the banner quad is 3.21:1, so the crescent has to be drawn as an
       ellipse 3.21x tall to come out a circle on the wall */
    var o3 = cell(P_BANNER);
    g.fillStyle = '#b3242c'; g.fillRect(o3[0], o3[1], ts, ts);
    (function () {
      var cx = o3[0] + ts * 0.24, cy = o3[1] + ts * 0.50, rr = ts * 0.088, k;
      g.save();
      g.translate(cx, cy); g.scale(1, A_BANNER); g.translate(-cx, -cy);
      g.fillStyle = '#f4f2ee';
      g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.arc(cx + rr * 0.34, cy, rr * 0.80, 0, TAU); g.fill();
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#f4f2ee';
      var sx = cx + rr * 1.22, sy = cy, sr = rr * 0.44;
      g.beginPath();
      for (k = 0; k < 10; k++) {
        var ang = -PI / 2 + k * PI / 5, rad = (k & 1) ? sr * 0.40 : sr;
        if (k === 0) g.moveTo(sx + Math.cos(ang) * rad, sy + Math.sin(ang) * rad);
        else g.lineTo(sx + Math.cos(ang) * rad, sy + Math.sin(ang) * rad);
      }
      g.closePath(); g.fill();
      g.restore();
    })();
    fitTextA('MAHALLE ŞENLİĞİ', FONTB, ts * 0.62, ts * 0.62,
             o3[0] + ts * 0.63, o3[1] + ts * 0.50, '#f6f2ec', A_BANNER);
    weather(P_BANNER, 0.5, '52,26,26');
    push(P_BANNER);

    /* 4 -- a modest shop fascia.  The teal now fills the cell edge to edge,
       because the cell IS the board: 2.29 x 0.48 m of it.  Both lines of text
       are pre-stretched by A_FASCIA (4.76) so they come off the wall at their
       real proportions instead of smeared five times too wide. */
    var o4 = cell(P_FASCIA);
    g.fillStyle = '#1d5c46'; g.fillRect(o4[0], o4[1], ts, ts);
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(o4[0], o4[1], ts, ts * 0.16);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(o4[0], o4[1] + ts * 0.88, ts, ts * 0.12);
    fitTextA('GÜVEN MARKET', FONTB, ts * 0.88, ts * 0.60,
             o4[0] + ts * 0.5, o4[1] + ts * 0.40, '#f2ede2', A_FASCIA);
    fitTextA('BAKKALİYE · TÜP · SU', FONT, ts * 0.78, ts * 0.24,
             o4[0] + ts * 0.5, o4[1] + ts * 0.755, '#cfc6ae', A_FASCIA);
    weather(P_FASCIA, 0.6, '20,34,28');
    push(P_FASCIA);

    /* 5 -- no parking: blue disc, red ring and bar */
    var o5 = cell(P_NOPARK);
    (function () {
      var cx = o5[0] + ts * 0.5, cy = o5[1] + ts * 0.5, rr = ts * 0.44;
      g.fillStyle = '#15427d'; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill();
      g.strokeStyle = '#c02a26'; g.lineWidth = rr * 0.20;
      g.beginPath(); g.arc(cx, cy, rr * 0.90, 0, TAU); g.stroke();
      g.lineWidth = rr * 0.17; g.lineCap = 'butt';
      g.beginPath();
      g.moveTo(cx - rr * 0.62, cy + rr * 0.62); g.lineTo(cx + rr * 0.62, cy - rr * 0.62);
      g.stroke();
      g.strokeStyle = 'rgba(190,190,186,1)'; g.lineWidth = rr * 0.05;
      g.beginPath(); g.arc(cx, cy, rr * 0.995, 0, TAU); g.stroke();
    })();
    weather(P_NOPARK, 0.45, '40,44,50');
    push(P_NOPARK);

    /* 6 -- a pavement A-board */
    var o6 = cell(P_ABOARD);
    g.fillStyle = '#e8e2d4'; g.fillRect(o6[0] + ts * 0.06, o6[1] + ts * 0.05, ts * 0.88, ts * 0.90);
    g.strokeStyle = '#6d6656'; g.lineWidth = ts * 0.02;
    g.strokeRect(o6[0] + ts * 0.06, o6[1] + ts * 0.05, ts * 0.88, ts * 0.90);
    fitText('TÜP', FONTB, ts * 0.6, o6[0] + ts * 0.5, o6[1] + ts * 0.28, '#b3242c');
    fitText('BAYİ', FONTB, ts * 0.6, o6[0] + ts * 0.5, o6[1] + ts * 0.52, '#1b1c1e');
    fitText('0332 582 ..', FONT, ts * 0.7, o6[0] + ts * 0.5, o6[1] + ts * 0.75, '#333029');
    weather(P_ABOARD, 0.8, '58,54,44');
    push(P_ABOARD);

    /* 7 -- a kilim, thrown over a railing to air */
    var o7 = cell(P_KILIM);
    (function () {
      var k, r2;
      g.fillStyle = '#7d2f28'; g.fillRect(o7[0], o7[1], ts, ts);
      var bands = ['#a8442f', '#1f3f52', '#c8a24a', '#6f2a25', '#dcd0b4'];
      for (k = 0; k < 11; k++) {
        g.fillStyle = bands[k % bands.length];
        g.fillRect(o7[0], o7[1] + ts * (k / 11), ts, ts * (0.06 + R() * 0.03));
      }
      g.fillStyle = 'rgba(232,222,196,0.92)';
      for (k = 0; k < 34; k++) {
        var dx2 = o7[0] + ts * (0.06 + R() * 0.88), dy2 = o7[1] + ts * (0.05 + R() * 0.9);
        r2 = ts * 0.028;
        g.beginPath();
        g.moveTo(dx2, dy2 - r2); g.lineTo(dx2 + r2, dy2); g.lineTo(dx2, dy2 + r2); g.lineTo(dx2 - r2, dy2);
        g.closePath(); g.fill();
      }
      g.strokeStyle = 'rgba(40,30,26,0.55)'; g.lineWidth = ts * 0.012;
      g.strokeRect(o7[0] + ts * 0.02, o7[1] + ts * 0.02, ts * 0.96, ts * 0.96);
    })();
    weather(P_KILIM, 0.7, '44,32,26');
    push(P_KILIM);

    /* 8 -- roller-shutter corrugation */
    var o8 = cell(P_SHUTTER);
    (function () {
      var k, n = 26;
      for (k = 0; k < n; k++) {
        var yy = o8[1] + ts * k / n, hh = ts / n;
        var t = k / n;
        var gr = g.createLinearGradient(0, yy, 0, yy + hh);
        gr.addColorStop(0, 'rgba(126,128,124,1)');
        gr.addColorStop(0.45, 'rgba(176,178,172,1)');
        gr.addColorStop(1, 'rgba(104,106,102,1)');
        g.fillStyle = gr; g.fillRect(o8[0], yy, ts, hh + 0.5);
        void t;
      }
    })();
    weather(P_SHUTTER, 0.75, '52,54,50');
    push(P_SHUTTER);

    /* 9,10 -- lamp lenses.  Emissive is not wanted: these lamps are off and
       so is the sun; they are simply coloured, dirty plastic. */
    function lens(i, top, bot, ribs) {
      var o = cell(i), k;
      var gr = g.createLinearGradient(o[0], o[1], o[0], o[1] + ts);
      gr.addColorStop(0, top); gr.addColorStop(1, bot);
      g.fillStyle = gr; g.fillRect(o[0], o[1], ts, ts);
      g.strokeStyle = 'rgba(255,255,255,0.20)'; g.lineWidth = ts * 0.012;
      for (k = 0; k < ribs; k++) {
        var xx = o[0] + ts * (k + 0.5) / ribs;
        g.beginPath(); g.moveTo(xx, o[1]); g.lineTo(xx, o[1] + ts); g.stroke();
      }
      g.strokeStyle = 'rgba(30,26,24,0.45)'; g.lineWidth = ts * 0.05;
      g.strokeRect(o[0] + ts * 0.025, o[1] + ts * 0.025, ts * 0.95, ts * 0.95);
      weather(i, 0.45, '40,34,30');
      push(i);
    }
    lens(P_TAIL, 'rgba(168,42,36,1)', 'rgba(120,26,24,1)', 7);
    lens(P_HEAD, 'rgba(196,198,196,1)', 'rgba(148,152,152,1)', 9);

    /* 11 -- a grille mesh */
    var o11 = cell(P_GRILLE);
    g.fillStyle = 'rgba(28,30,32,1)'; g.fillRect(o11[0], o11[1], ts, ts);
    (function () {
      var k;
      g.strokeStyle = 'rgba(150,150,146,1)'; g.lineWidth = ts * 0.030;
      for (k = 0; k < 6; k++) {
        var yy = o11[1] + ts * (k + 0.5) / 6;
        g.beginPath(); g.moveTo(o11[0], yy); g.lineTo(o11[0] + ts, yy); g.stroke();
      }
      g.strokeStyle = 'rgba(120,120,116,1)'; g.lineWidth = ts * 0.020;
      for (k = 0; k < 3; k++) {
        var xx = o11[0] + ts * (k + 0.5) / 3;
        g.beginPath(); g.moveTo(xx, o11[1]); g.lineTo(xx, o11[1] + ts); g.stroke();
      }
    })();
    weather(P_GRILLE, 0.7, '20,20,18');
    push(P_GRILLE);

    /* 12 -- a fly-poster, half torn */
    var o12 = cell(P_POSTER);
    g.fillStyle = '#ded6c4'; g.fillRect(o12[0] + ts * 0.08, o12[1] + ts * 0.06, ts * 0.84, ts * 0.88);
    fitText('SATILIK', FONTB, ts * 0.72, o12[0] + ts * 0.5, o12[1] + ts * 0.30, '#b3242c');
    fitText('DAİRE', FONTB, ts * 0.72, o12[0] + ts * 0.5, o12[1] + ts * 0.52, '#22262b');
    g.fillStyle = '#4a4a48'; g.font = (ts * 0.048) + 'px ' + FONT;
    g.textAlign = 'center'; g.fillText('0532 ... .. ..', o12[0] + ts * 0.5, o12[1] + ts * 0.72);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(o12[0] + ts * 0.92, o12[1] + ts * 0.55);
    g.lineTo(o12[0] + ts * 0.62, o12[1] + ts * 0.94);
    g.lineTo(o12[0] + ts * 0.95, o12[1] + ts * 0.95);
    g.closePath(); g.fill();
    g.globalCompositeOperation = 'source-over';
    weather(P_POSTER, 0.9, '60,56,48');
    push(P_POSTER);

    /* 13 -- the building number plaque */
    var o13 = cell(P_NUMBER);
    g.fillStyle = '#12447e'; g.fillRect(o13[0] + ts * 0.20, o13[1] + ts * 0.20, ts * 0.60, ts * 0.60);
    g.strokeStyle = '#eceff2'; g.lineWidth = ts * 0.016;
    g.strokeRect(o13[0] + ts * 0.235, o13[1] + ts * 0.235, ts * 0.53, ts * 0.53);
    fitText('17', FONTB, ts * 0.42, o13[0] + ts * 0.5, o13[1] + ts * 0.52, '#ffffff');
    weather(P_NUMBER, 0.6, '36,42,44');
    push(P_NUMBER);

    /* 14 -- the yellow electrical hazard plate on a junction cabinet */
    var o14 = cell(P_HAZARD);
    g.fillStyle = '#d8c23a'; g.fillRect(o14[0] + ts * 0.12, o14[1] + ts * 0.14, ts * 0.76, ts * 0.72);
    (function () {
      var cx = o14[0] + ts * 0.5, cy = o14[1] + ts * 0.48, rr = ts * 0.26;
      g.fillStyle = '#1c1a16';
      g.beginPath();
      g.moveTo(cx + rr * 0.16, cy - rr * 0.72); g.lineTo(cx - rr * 0.34, cy + rr * 0.08);
      g.lineTo(cx - rr * 0.02, cy + rr * 0.08); g.lineTo(cx - rr * 0.18, cy + rr * 0.74);
      g.lineTo(cx + rr * 0.36, cy - rr * 0.10); g.lineTo(cx + rr * 0.02, cy - rr * 0.10);
      g.closePath(); g.fill();
      g.strokeStyle = '#1c1a16'; g.lineWidth = ts * 0.022;
      g.beginPath();
      g.moveTo(o14[0] + ts * 0.16, o14[1] + ts * 0.80);
      g.lineTo(o14[0] + ts * 0.84, o14[1] + ts * 0.80);
      g.stroke();
    })();
    weather(P_HAZARD, 0.8, '54,48,26');
    push(P_HAZARD);

    /* 15 -- the dish face: off-white with a maker's decal */
    var o15 = cell(P_DISH);
    (function () {
      var cx = o15[0] + ts * 0.5, cy = o15[1] + ts * 0.5, rr = ts * 0.47, k;
      var gr = g.createRadialGradient(cx - rr * 0.2, cy - rr * 0.3, rr * 0.1, cx, cy, rr);
      gr.addColorStop(0, 'rgba(232,231,226,1)');
      gr.addColorStop(1, 'rgba(186,187,184,1)');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(150,150,146,1)'; g.lineWidth = rr * 0.05;
      g.beginPath(); g.arc(cx, cy, rr * 0.97, 0, TAU); g.stroke();
      for (k = 0; k < 3; k++) {
        g.strokeStyle = 'rgba(160,160,156,0.5)'; g.lineWidth = rr * 0.02;
        g.beginPath(); g.arc(cx, cy, rr * (0.3 + k * 0.24), 0, TAU); g.stroke();
      }
    })();
    weather(P_DISH, 0.55, '60,62,60');
    push(P_DISH);

    /* ---- 16..24 : the automotive tiles ---------------------------------- */

    /* 16 -- the contact shadow.  The brief ranks "a hard dark AO patch under
       every car" as part of the first thing to get right, and the vertex bake
       cannot draw it: the road belongs to nz-street-ground.js and this module
       must not touch it.  So it is a decal -- opaque, dark, rounded, with a
       one-texel alpha ramp that alphaTest 0.5 turns into a clean edge. */
    (function () {
      var o = cell(P_SHADOW), k;
      var gr = g.createRadialGradient(o[0] + ts * 0.5, o[1] + ts * 0.5, ts * 0.06,
                                      o[0] + ts * 0.5, o[1] + ts * 0.5, ts * 0.50);
      gr.addColorStop(0.00, 'rgba(16,16,16,1)');
      gr.addColorStop(0.62, 'rgba(30,30,30,1)');
      gr.addColorStop(0.86, 'rgba(52,52,52,0.90)');
      gr.addColorStop(1.00, 'rgba(70,70,70,0)');
      g.save();
      g.translate(o[0] + ts * 0.5, o[1] + ts * 0.5);
      g.scale(1, 0.86);
      g.translate(-(o[0] + ts * 0.5), -(o[1] + ts * 0.5));
      g.fillStyle = gr;
      g.beginPath(); g.arc(o[0] + ts * 0.5, o[1] + ts * 0.5, ts * 0.50, 0, TAU); g.fill();
      g.restore();
      /* ragged the edge a little so it is not a stamped ellipse */
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (k = 0; k < 30; k++) {
        var a = R() * TAU, rad = ts * (0.40 + R() * 0.12);
        g.beginPath();
        g.arc(o[0] + ts * 0.5 + Math.cos(a) * rad, o[1] + ts * 0.5 + Math.sin(a) * rad * 0.86,
              ts * (0.02 + R() * 0.05), 0, TAU);
        g.fill();
      }
      g.restore();
      push(P_SHADOW);
    })();

    /* 17 -- the square sealed-beam headlamp of a Fiat-131 derivative: a
       chrome-framed rectangular lens with vertical flutes, an amber indicator
       to one side, and fifteen years of road film in the corners. */
    (function () {
      var o = cell(P_LAMPF), k;
      g.fillStyle = 'rgba(30,31,32,1)'; g.fillRect(o[0], o[1] + ts * 0.24, ts, ts * 0.52);
      /* the lens */
      var lx = o[0] + ts * 0.05, ly = o[1] + ts * 0.28, lw = ts * 0.62, lh = ts * 0.44;
      var gr = g.createLinearGradient(lx, ly, lx, ly + lh);
      gr.addColorStop(0, 'rgba(206,208,206,1)');
      gr.addColorStop(0.5, 'rgba(160,164,166,1)');
      gr.addColorStop(1, 'rgba(120,124,126,1)');
      g.fillStyle = gr; g.fillRect(lx, ly, lw, lh);
      g.strokeStyle = 'rgba(226,226,222,1)'; g.lineWidth = ts * 0.020;
      g.strokeRect(lx, ly, lw, lh);
      g.strokeStyle = 'rgba(232,234,232,0.42)'; g.lineWidth = ts * 0.012;
      for (k = 1; k < 9; k++) {
        var xx = lx + lw * k / 9;
        g.beginPath(); g.moveTo(xx, ly + ts * 0.01); g.lineTo(xx, ly + lh - ts * 0.01); g.stroke();
      }
      /* the reflector's hot spot */
      var rg = g.createRadialGradient(lx + lw * 0.5, ly + lh * 0.5, 0, lx + lw * 0.5, ly + lh * 0.5, lw * 0.36);
      rg.addColorStop(0, 'rgba(238,238,234,0.75)'); rg.addColorStop(1, 'rgba(238,238,234,0)');
      g.fillStyle = rg; g.fillRect(lx, ly, lw, lh);
      /* the amber indicator */
      g.fillStyle = 'rgba(196,132,44,1)';
      g.fillRect(o[0] + ts * 0.70, ly, ts * 0.25, lh);
      g.strokeStyle = 'rgba(214,214,210,1)'; g.lineWidth = ts * 0.016;
      g.strokeRect(o[0] + ts * 0.70, ly, ts * 0.25, lh);
      weather(P_LAMPF, 0.85, '46,44,38');
      push(P_LAMPF);
    })();

    /* 18 -- the square tail cluster: red / amber / reverse-white in three
       vertical bands behind a chrome surround */
    (function () {
      var o = cell(P_LAMPR), k;
      g.fillStyle = 'rgba(28,28,30,1)'; g.fillRect(o[0], o[1] + ts * 0.20, ts, ts * 0.60);
      var bx = o[0] + ts * 0.05, by = o[1] + ts * 0.24, bw = ts * 0.90, bh = ts * 0.52;
      var cols = ['rgba(158,34,30,1)', 'rgba(186,44,36,1)', 'rgba(180,124,40,1)', 'rgba(196,198,192,1)'];
      for (k = 0; k < 4; k++) {
        g.fillStyle = cols[k];
        g.fillRect(bx + bw * k / 4, by, bw / 4 + 1, bh);
      }
      /* the fluting */
      g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = ts * 0.010;
      for (k = 1; k < 14; k++) {
        var yy = by + bh * k / 14;
        g.beginPath(); g.moveTo(bx, yy); g.lineTo(bx + bw, yy); g.stroke();
      }
      g.strokeStyle = 'rgba(214,214,208,1)'; g.lineWidth = ts * 0.022;
      g.strokeRect(bx, by, bw, bh);
      weather(P_LAMPR, 0.85, '40,30,28');
      push(P_LAMPR);
    })();

    /* 19 -- the boxy saloon's grille: black plastic slats in a chrome frame,
       with the badge blank in the middle */
    (function () {
      var o = cell(P_GRILLE2), k;
      g.fillStyle = 'rgba(22,23,24,1)'; g.fillRect(o[0], o[1] + ts * 0.22, ts, ts * 0.56);
      for (k = 0; k < 7; k++) {
        var yy = o[1] + ts * 0.25 + ts * 0.50 * k / 7;
        var gr = g.createLinearGradient(0, yy, 0, yy + ts * 0.05);
        gr.addColorStop(0, 'rgba(88,89,88,1)');
        gr.addColorStop(0.5, 'rgba(44,45,46,1)');
        gr.addColorStop(1, 'rgba(16,17,18,1)');
        g.fillStyle = gr; g.fillRect(o[0] + ts * 0.03, yy, ts * 0.94, ts * 0.045);
      }
      g.strokeStyle = 'rgba(196,197,193,1)'; g.lineWidth = ts * 0.026;
      g.strokeRect(o[0] + ts * 0.02, o[1] + ts * 0.23, ts * 0.96, ts * 0.54);
      g.fillStyle = 'rgba(150,150,146,1)';
      g.beginPath(); g.arc(o[0] + ts * 0.5, o[1] + ts * 0.50, ts * 0.055, 0, TAU); g.fill();
      weather(P_GRILLE2, 0.75, '18,18,16');
      push(P_GRILLE2);
    })();

    /* 20 -- a plastic wheel trim: a dished disc with five slots.  Half the
       fleet has lost theirs, which is the detail that dates a Sahin. */
    (function () {
      var o = cell(P_WCAP), k, cx = o[0] + ts * 0.5, cy = o[1] + ts * 0.5, rr = ts * 0.48;
      var gr = g.createRadialGradient(cx - rr * 0.25, cy - rr * 0.30, rr * 0.05, cx, cy, rr);
      gr.addColorStop(0, 'rgba(196,196,192,1)');
      gr.addColorStop(0.72, 'rgba(150,151,148,1)');
      gr.addColorStop(1, 'rgba(104,105,103,1)');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill();
      g.fillStyle = 'rgba(24,25,26,1)';
      for (k = 0; k < 5; k++) {
        var a = k / 5 * TAU + 0.3;
        g.save(); g.translate(cx, cy); g.rotate(a);
        g.beginPath(); g.ellipse(rr * 0.56, 0, rr * 0.20, rr * 0.13, 0, 0, TAU); g.fill();
        g.restore();
      }
      g.strokeStyle = 'rgba(74,75,74,1)'; g.lineWidth = rr * 0.07;
      g.beginPath(); g.arc(cx, cy, rr * 0.90, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(132,133,130,1)';
      g.beginPath(); g.arc(cx, cy, rr * 0.22, 0, TAU); g.fill();
      weather(P_WCAP, 0.9, '48,46,42');
      push(P_WCAP);
    })();

    /* 21 -- the bare steel wheel underneath it: a dark dished pressing with
       four nuts, a valve and a lot of brake dust */
    (function () {
      var o = cell(P_WHEEL), k, cx = o[0] + ts * 0.5, cy = o[1] + ts * 0.5, rr = ts * 0.48;
      var gr = g.createRadialGradient(cx - rr * 0.20, cy - rr * 0.26, rr * 0.06, cx, cy, rr);
      gr.addColorStop(0, 'rgba(92,90,86,1)');
      gr.addColorStop(0.62, 'rgba(62,61,58,1)');
      gr.addColorStop(1, 'rgba(34,34,33,1)');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill();
      /* the dish: a darker recess with four vent slots */
      g.fillStyle = 'rgba(38,38,36,1)';
      g.beginPath(); g.arc(cx, cy, rr * 0.66, 0, TAU); g.fill();
      g.fillStyle = 'rgba(20,20,19,1)';
      for (k = 0; k < 4; k++) {
        var a = k / 4 * TAU + 0.8;
        g.save(); g.translate(cx, cy); g.rotate(a);
        g.beginPath(); g.ellipse(rr * 0.44, 0, rr * 0.13, rr * 0.09, 0, 0, TAU); g.fill();
        g.restore();
      }
      g.fillStyle = 'rgba(126,126,122,1)';
      g.beginPath(); g.arc(cx, cy, rr * 0.20, 0, TAU); g.fill();
      g.fillStyle = 'rgba(150,150,146,1)';
      for (k = 0; k < 4; k++) {
        var a2 = k / 4 * TAU + 0.4;
        g.beginPath();
        g.arc(cx + Math.cos(a2) * rr * 0.135, cy + Math.sin(a2) * rr * 0.135, rr * 0.052, 0, TAU);
        g.fill();
      }
      weather(P_WHEEL, 1.0, '36,32,26');
      push(P_WHEEL);
    })();

    /* 22, 23 -- the modern pair: a clear polycarbonate headlamp and a red
       tail lens with a clear reverse insert.  Same slot count, different era. */
    (function () {
      var o = cell(P_LAMPF2);
      g.fillStyle = 'rgba(26,27,28,1)';
      g.beginPath();
      g.moveTo(o[0] + ts * 0.03, o[1] + ts * 0.34);
      g.lineTo(o[0] + ts * 0.97, o[1] + ts * 0.28);
      g.lineTo(o[0] + ts * 0.97, o[1] + ts * 0.68);
      g.lineTo(o[0] + ts * 0.03, o[1] + ts * 0.72);
      g.closePath(); g.fill();
      var gr = g.createLinearGradient(o[0], o[1] + ts * 0.30, o[0], o[1] + ts * 0.70);
      gr.addColorStop(0, 'rgba(196,200,204,1)');
      gr.addColorStop(0.55, 'rgba(146,152,158,1)');
      gr.addColorStop(1, 'rgba(96,100,106,1)');
      g.save();
      g.beginPath();
      g.moveTo(o[0] + ts * 0.06, o[1] + ts * 0.36);
      g.lineTo(o[0] + ts * 0.94, o[1] + ts * 0.31);
      g.lineTo(o[0] + ts * 0.94, o[1] + ts * 0.65);
      g.lineTo(o[0] + ts * 0.06, o[1] + ts * 0.69);
      g.closePath(); g.clip();
      g.fillStyle = gr; g.fillRect(o[0], o[1], ts, ts);
      var rg = g.createRadialGradient(o[0] + ts * 0.32, o[1] + ts * 0.50, 0, o[0] + ts * 0.32, o[1] + ts * 0.50, ts * 0.22);
      rg.addColorStop(0, 'rgba(240,242,244,0.9)'); rg.addColorStop(1, 'rgba(240,242,244,0)');
      g.fillStyle = rg; g.fillRect(o[0], o[1], ts, ts);
      g.fillStyle = 'rgba(206,158,64,0.85)';
      g.fillRect(o[0] + ts * 0.72, o[1] + ts * 0.33, ts * 0.22, ts * 0.32);
      g.restore();
      weather(P_LAMPF2, 0.45, '44,46,50');
      push(P_LAMPF2);
    })();
    (function () {
      var o = cell(P_LAMPR2);
      g.fillStyle = 'rgba(26,27,28,1)'; g.fillRect(o[0], o[1] + ts * 0.26, ts, ts * 0.48);
      var gr = g.createLinearGradient(o[0], o[1] + ts * 0.28, o[0], o[1] + ts * 0.72);
      gr.addColorStop(0, 'rgba(178,44,38,1)');
      gr.addColorStop(0.6, 'rgba(140,28,26,1)');
      gr.addColorStop(1, 'rgba(96,20,20,1)');
      g.fillStyle = gr; g.fillRect(o[0] + ts * 0.04, o[1] + ts * 0.29, ts * 0.92, ts * 0.42);
      g.fillStyle = 'rgba(198,200,196,1)';
      g.fillRect(o[0] + ts * 0.06, o[1] + ts * 0.56, ts * 0.30, ts * 0.13);
      g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = ts * 0.010;
      for (var q = 1; q < 9; q++) {
        var xx2 = o[0] + ts * 0.04 + ts * 0.92 * q / 9;
        g.beginPath(); g.moveTo(xx2, o[1] + ts * 0.29); g.lineTo(xx2, o[1] + ts * 0.71); g.stroke();
      }
      weather(P_LAMPR2, 0.5, '40,28,26');
      push(P_LAMPR2);
    })();

    /* 24 -- a third registration, so no two cars in a row share a plate */
    plate(P_PLATE3, '42 EC 9140');

    /* ---- 31..33 : the Tourneo Courier tiles ------------------------------
       Drawn against the owner's reference plates.  Everything outside the
       painted shape stays transparent, and the panel material is alphaTest,
       so each card crops itself to the real outline. */

    /* 31 -- the PRE-FACELIFT face, both bands of it: the blue oval riding on
       its own cross-bar at the top, a transparent gap under it, then the
       grille opening.  The gap is the point -- alphaTest crops the card
       there and the nose's own paint carries the bar, so the badge floats
       on real body colour and there is no panel to colour-match.
         The opening is a broad trapezoid WIDER AT THE TOP with heavily
       rounded corners: 03-front-square measures 1044 mm across the top
       against 922 across the bottom, a 12 % taper, where the old path here
       was an INVERTED trapezoid narrowing 50 % to the bottom -- upside down
       for this car and much too tall for the 231 mm of aperture it has.
         Cell layout, because section 5's card is sized off it:
           v 0.150  oval centre        u 0.078 / 0.046 its half axes
           v 0.320  top of the opening u 0.045 .. 0.955
           v 0.870  bottom             u 0.098 .. 0.902           */
    (function () {
      var o = cell(P_GRILLEC), k, x0 = o[0], y0 = o[1];
      var gT = 0.320, gB = 0.870, uT = 0.455, uB = 0.402, rC = 0.072;
      function trap(inset) {
        var tT = uT - inset, tB = uB - inset, r = Math.max(rC - inset, 0.014);
        var yT = gT + inset * 0.9, yB = gB - inset * 0.9;
        g.beginPath();
        g.moveTo(x0 + ts * (0.5 - tT + r), y0 + ts * yT);
        g.lineTo(x0 + ts * (0.5 + tT - r), y0 + ts * yT);
        g.quadraticCurveTo(x0 + ts * (0.5 + tT), y0 + ts * yT,
                           x0 + ts * (0.5 + tT), y0 + ts * (yT + r));
        g.lineTo(x0 + ts * (0.5 + tB), y0 + ts * (yB - r));
        g.quadraticCurveTo(x0 + ts * (0.5 + tB), y0 + ts * yB,
                           x0 + ts * (0.5 + tB - r), y0 + ts * yB);
        g.lineTo(x0 + ts * (0.5 - tB + r), y0 + ts * yB);
        g.quadraticCurveTo(x0 + ts * (0.5 - tB), y0 + ts * yB,
                           x0 + ts * (0.5 - tB), y0 + ts * (yB - r));
        g.lineTo(x0 + ts * (0.5 - tT), y0 + ts * (yT + r));
        g.quadraticCurveTo(x0 + ts * (0.5 - tT), y0 + ts * yT,
                           x0 + ts * (0.5 - tT + r), y0 + ts * yT);
        g.closePath();
      }
      /* the thin bright bezel Titanium wears round the opening: the Turkish
         equipment list says "Krom Cerceveli On Izgara" in as many words */
      trap(0); g.fillStyle = 'rgba(150,154,158,1)'; g.fill();
      trap(0.010); g.fillStyle = 'rgba(17,18,19,1)'; g.fill();
      /* six gloss-black horizontal fins.  _z_bars.png counts six giving six
         slots; they are deep and slightly bowed, so each gets a bright top
         edge and the black behind it does the shadow -- that pair of lines
         is the entire read once the card is 40 px wide. */
      g.save(); trap(0.017); g.clip();
      var fN = 6, fSp = (gB - gT - 0.034) / fN;
      for (k = 0; k < fN; k++) {
        var fy = gT + 0.017 + fSp * (k + 0.40);
        g.fillStyle = 'rgba(46,48,51,1)';
        g.fillRect(x0, y0 + ts * fy, ts, ts * fSp * 0.54);
        g.fillStyle = 'rgba(96,100,105,0.70)';
        g.fillRect(x0, y0 + ts * fy, ts, ts * fSp * 0.24);
      }
      /* the sky the top of a recessed opening always catches */
      var shn = g.createLinearGradient(0, y0 + ts * gT, 0, y0 + ts * (gT + 0.24));
      shn.addColorStop(0, 'rgba(104,108,112,0.30)');
      shn.addColorStop(1, 'rgba(104,108,112,0)');
      g.fillStyle = shn; g.fillRect(x0, y0 + ts * gT, ts, ts * 0.24);
      g.restore();
      /* the blue oval, chrome-rimmed, ABOVE the opening with clear air
         between -- the one detail that dates this car (SPEC-FACTORY §7.1).
         The script is one pale sweep: at 20 px that is all a badge is. */
      var ocx = x0 + ts * 0.5, ocy = y0 + ts * 0.150;
      var orx = ts * 0.078, ory = ts * 0.046;
      var bg = g.createRadialGradient(ocx - orx * 0.30, ocy - ory * 0.55, ts * 0.006,
                                      ocx, ocy, orx);
      bg.addColorStop(0, 'rgba(58,94,170,1)'); bg.addColorStop(1, 'rgba(15,36,96,1)');
      g.fillStyle = bg;
      g.beginPath(); g.ellipse(ocx, ocy, orx, ory, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(206,210,214,1)'; g.lineWidth = ts * 0.012;
      g.beginPath(); g.ellipse(ocx, ocy, orx, ory, 0, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(214,220,228,0.85)'; g.lineWidth = ts * 0.009;
      g.beginPath(); g.moveTo(ocx - orx * 0.62, ocy + ory * 0.24);
      g.quadraticCurveTo(ocx, ocy - ory * 0.72, ocx + orx * 0.62, ocy + ory * 0.10);
      g.stroke();
      /* light on the weather: this tile is now mostly transparent, and
         every blob weather() lays down adds alpha to the cut-out */
      weather(P_GRILLEC, 0.22, '20,20,20');
      push(P_GRILLEC);
    })();

    /* 32 -- the five-spoke alloy of the photographs: five wide flat silver
       spokes, dark pockets, a bright outer flange and the oval on the centre
       cap.  Same footprint as P_WCAP so the wheel card needs no new maths. */
    /* MEASURED off the front wheel of 01-side-owner.png, which frames the
       wheel 320 px across the silver against 470 px across the tyre.  Every
       fraction below is of rr, the tile's own disc radius, and rr lands at
       0.96 of the wheel card's half-size, so rr IS the outer edge of the
       silver.  The previous pass stopped its brightest ring at 0.815 rr and
       left the outer 18 % as dark dish, which is why the alloy measured 0.59
       of the tyre in _shots/w1 against the 0.68 the photograph gives.
         flange   0.87 -> 1.00   bright, the machined rim edge at the bead
         spokes   0.17 -> 0.90   five, forking into a Y at the rim
         hub      0.00 -> 0.44   one continuous silver plate
         lugs     PCD 0.335, r 0.055, five, on the spoke centrelines
         cap      0.24, blue oval 0.150 x 0.092                            */
    (function () {
      var o = cell(P_WALLOY), k, cx = o[0] + ts * 0.5, cy = o[1] + ts * 0.5, rr = ts * 0.48;
      /* the barrel and the brake behind the spokes.  Not black: on an
         overcast day you can see the disc and the caliper in there. */
      var gr = g.createRadialGradient(cx - rr * 0.2, cy - rr * 0.24, rr * 0.05, cx, cy, rr);
      gr.addColorStop(0, 'rgba(52,52,51,1)'); gr.addColorStop(1, 'rgba(23,23,22,1)');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill();
      /* five spokes.  Chunky, and they WIDEN toward the rim -- a taper the
         other way is what made the old face read as a starfish.  The stop at
         0.52 is the crease that runs down the middle of each spoke on this
         wheel: it is the one thing that stops flat silver reading as card. */
      for (k = 0; k < 5; k++) {
        g.save(); g.translate(cx, cy); g.rotate(k / 5 * TAU - PI / 2);
        var sg2 = g.createLinearGradient(0, -rr * 0.26, 0, rr * 0.26);
        sg2.addColorStop(0.00, 'rgba(216,218,218,1)');
        sg2.addColorStop(0.42, 'rgba(194,196,197,1)');
        sg2.addColorStop(0.52, 'rgba(146,148,149,1)');
        sg2.addColorStop(1.00, 'rgba(114,116,117,1)');
        g.fillStyle = sg2;
        g.beginPath();
        g.moveTo(rr * 0.17, -rr * 0.150);
        g.lineTo(rr * 0.60, -rr * 0.212);
        g.lineTo(rr * 0.90, -rr * 0.256);
        g.lineTo(rr * 0.90, rr * 0.256);
        g.lineTo(rr * 0.60, rr * 0.212);
        g.lineTo(rr * 0.17, rr * 0.150);
        g.closePath(); g.fill();
        /* the fork.  Each spoke splits into two legs at the rim with a dark
           slot between them, so the wheel shows ten feet on the flange and
           five windows between the spokes -- the whole character of it. */
        g.fillStyle = 'rgba(27,27,26,1)';
        g.beginPath();
        g.moveTo(rr * 0.905, -rr * 0.092);
        g.lineTo(rr * 0.905, rr * 0.092);
        g.lineTo(rr * 0.585, 0);
        g.closePath(); g.fill();
        g.restore();
      }
      /* the flange, reaching the edge of the tile */
      var fg = g.createLinearGradient(cx, cy - rr, cx, cy + rr);
      fg.addColorStop(0.00, 'rgba(228,230,230,1)');
      fg.addColorStop(0.50, 'rgba(180,182,183,1)');
      fg.addColorStop(1.00, 'rgba(124,126,127,1)');
      g.strokeStyle = fg; g.lineWidth = rr * 0.13;
      g.beginPath(); g.arc(cx, cy, rr * 0.935, 0, TAU); g.stroke();
      /* the shadow line where the spokes drop away behind the flange */
      g.strokeStyle = 'rgba(66,67,67,0.90)'; g.lineWidth = rr * 0.024;
      g.beginPath(); g.arc(cx, cy, rr * 0.866, 0, TAU); g.stroke();
      /* the hub plate the spokes grow out of, then the five lug bolts sunk
         in their pockets: at 20 px they are a ring of dark dots, and a ring
         of dark dots is what says "this is a road wheel" and not a disc. */
      var hg = g.createRadialGradient(cx - rr * 0.14, cy - rr * 0.16, rr * 0.02, cx, cy, rr * 0.44);
      hg.addColorStop(0, 'rgba(206,208,208,1)'); hg.addColorStop(1, 'rgba(150,152,152,1)');
      g.fillStyle = hg; g.beginPath(); g.arc(cx, cy, rr * 0.44, 0, TAU); g.fill();
      for (k = 0; k < 5; k++) {
        var la = k / 5 * TAU - PI / 2;
        var lx = cx + Math.cos(la) * rr * 0.335, ly = cy + Math.sin(la) * rr * 0.335;
        g.fillStyle = 'rgba(54,54,53,1)';
        g.beginPath(); g.arc(lx, ly, rr * 0.055, 0, TAU); g.fill();
        g.fillStyle = 'rgba(132,133,133,1)';
        g.beginPath(); g.arc(lx - rr * 0.012, ly - rr * 0.014, rr * 0.030, 0, TAU); g.fill();
      }
      /* the centre cap and its oval.  0.150 rr of half-width, not the 0.100
         the last pass used: on the photograph the blue is 50 px of a 320 px
         wheel, and at street distance that blue dot is the badge. */
      g.strokeStyle = 'rgba(88,89,89,1)'; g.lineWidth = rr * 0.022;
      g.beginPath(); g.arc(cx, cy, rr * 0.240, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(186,188,188,1)';
      g.beginPath(); g.arc(cx, cy, rr * 0.230, 0, TAU); g.fill();
      var bo = g.createRadialGradient(cx - rr * 0.05, cy - rr * 0.05, rr * 0.01,
                                      cx, cy, rr * 0.150);
      bo.addColorStop(0, 'rgba(56,92,168,1)'); bo.addColorStop(1, 'rgba(16,38,98,1)');
      g.fillStyle = bo;
      g.beginPath(); g.ellipse(cx, cy, rr * 0.150, rr * 0.092, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(202,206,210,1)'; g.lineWidth = rr * 0.018;
      g.beginPath(); g.ellipse(cx, cy, rr * 0.150, rr * 0.092, 0, 0, TAU); g.stroke();
      /* weather INSIDE the disc: this tile's corners are transparent and the
         shared weather() clips to the square cell, so an unclipped pass hangs
         four dirty triangles off the wheel where there is no wheel. */
      g.save();
      g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.clip();
      weather(P_WALLOY, 0.42, '42,40,36');
      g.restore();
      push(P_WALLOY);
    })();

    /* 33 -- the tall tail cluster, redrawn off 06-rear34.png.
       MEASURED on that plate.  Calibrating on the number plate (110 mm tall,
       40 px in frame) the real unit is 345 mm tall by 210 mm across its
       rear-facing face, plus about a 65 mm wrap round the body corner: a
       1.6 : 1 upright capsule.  It is NOT the 3.5 : 1 stalk SPEC-FACTORY
       guesses at from the thumbnail, and it is certainly not the 2.8 : 1
       ribbon this tile used to draw -- which is most of why the old lamps
       read as two thin red bars stuck on the corners.

       Bands, as fractions of the LENS height, straight off the photograph:
         0.00-0.46  red brake/tail -- the deep one, with the horizontal flutes
         0.46-0.68  the clear indicator / reverse window: silver-white, with
                    the amber bulb showing through the top of it
         0.68-1.00  red again, the reflector foot

       The outline is deliberately SYMMETRIC.  card() flips `u` against the
       face hint (2733-2737), so a single call lands the same handedness in
       WORLD space on both sides of the car; anything asymmetric in here comes
       out mirrored on one lamp (the bug that put P_LAMPF2's amber corner on
       the wrong side of the nose).  So the real lamp's inboard-top chamfer is
       spent as a chamfer on BOTH top corners -- which is also what the photo
       shows once the perspective is taken out: narrow at the top, full width
       from about 16 % down, round-cornered at the foot.
       The card is 210 x 315 mm, so the cell arrives stretched 1.5 : 1 tall;
       nothing in here is a glyph, so that costs nothing. */
    (function () {
      var o = cell(P_LAMPRC), k;
      var lx0 = o[0] + ts * 0.075, lx1 = o[0] + ts * 0.925;
      var ly0 = o[1] + ts * 0.025, ly1 = o[1] + ts * 0.975;
      var lwd = lx1 - lx0, lht = ly1 - ly0, lcx = (lx0 + lx1) * 0.5;
      /* the capsule outline, inset by `ins` -- traced twice, once for the
         near-black bezel and once for the lens inside it */
      function lcaps(ins) {
        var hw2 = lwd * 0.500 - ins, tw2 = lwd * 0.430 - ins;
        var ty2 = ly0 + ins, by2 = ly1 - ins;
        var hh2 = by2 - ty2, r2 = hh2 * 0.065, sy2 = ty2 + hh2 * 0.16;
        g.beginPath();
        g.moveTo(lcx - tw2 + r2, ty2);
        g.lineTo(lcx + tw2 - r2, ty2);
        g.quadraticCurveTo(lcx + tw2, ty2, lcx + hw2, sy2);
        g.lineTo(lcx + hw2, by2 - r2);
        g.quadraticCurveTo(lcx + hw2, by2, lcx + hw2 - r2, by2);
        g.lineTo(lcx - hw2 + r2, by2);
        g.quadraticCurveTo(lcx - hw2, by2, lcx - hw2, by2 - r2);
        g.lineTo(lcx - hw2, sy2);
        g.quadraticCurveTo(lcx - tw2, ty2, lcx - tw2 + r2, ty2);
        g.closePath();
      }
      /* the bezel.  Everything outside it is left TRANSPARENT: the panel
         material is alphaTest 0.5 (2426), so the card crops itself to the
         capsule and the body colour behind carries the corners. */
      g.fillStyle = 'rgba(24,25,26,1)';
      lcaps(0); g.fill();
      var ins2 = ts * 0.040;
      var yl0 = ly0 + ins2, yl1 = ly1 - ins2, lhl = yl1 - yl0;
      g.save();
      lcaps(ins2); g.clip();
      /* 0.00-0.46 the brake/tail red.  Two stops, dark at the bottom of the
         band, because a lens this deep is lit from its own bulb and goes
         black where the reflector runs out. */
      var rg = g.createLinearGradient(0, yl0, 0, yl0 + lhl * 0.46);
      rg.addColorStop(0, 'rgba(196,52,44,1)');
      rg.addColorStop(0.55, 'rgba(158,32,30,1)');
      rg.addColorStop(1, 'rgba(116,22,22,1)');
      g.fillStyle = rg; g.fillRect(lx0, yl0, lwd, lhl * 0.47);
      /* 0.46-0.68 the clear window: silver-white with the amber bulb in the
         top half of it.  This is the one bright thing on the whole tail and
         at 30 px it is what stops the cluster reading as a red smear. */
      var cg = g.createLinearGradient(0, yl0 + lhl * 0.46, 0, yl0 + lhl * 0.68);
      cg.addColorStop(0, 'rgba(190,192,188,1)');
      cg.addColorStop(1, 'rgba(136,140,138,1)');
      g.fillStyle = cg; g.fillRect(lx0, yl0 + lhl * 0.46, lwd, lhl * 0.225);
      var ag = g.createLinearGradient(0, yl0 + lhl * 0.47, 0, yl0 + lhl * 0.57);
      ag.addColorStop(0, 'rgba(214,138,44,0.85)');
      ag.addColorStop(1, 'rgba(214,150,60,0)');
      g.fillStyle = ag;
      g.fillRect(lcx - lwd * 0.30, yl0 + lhl * 0.47, lwd * 0.60, lhl * 0.10);
      /* 0.68-1.00 the red foot, with the reflector's own darker inset */
      g.fillStyle = 'rgba(142,28,26,1)';
      g.fillRect(lx0, yl0 + lhl * 0.675, lwd, lhl * 0.33);
      g.fillStyle = 'rgba(104,18,20,1)';
      g.fillRect(lcx - lwd * 0.34, yl0 + lhl * 0.80, lwd * 0.68, lhl * 0.14);
      /* the horizontal flutes -- only through the two red bands, because the
         clear one is a smooth cover in the photograph */
      g.strokeStyle = 'rgba(255,255,255,0.13)'; g.lineWidth = ts * 0.008;
      for (k = 1; k < 14; k++) {
        var fy = yl0 + lhl * k / 14;
        if (fy > yl0 + lhl * 0.45 && fy < yl0 + lhl * 0.70) continue;
        g.beginPath(); g.moveTo(lx0, fy); g.lineTo(lx1, fy); g.stroke();
      }
      /* one soft specular column, CENTRED so mirroring cannot show it up */
      var sk = g.createLinearGradient(lcx - lwd * 0.22, 0, lcx + lwd * 0.22, 0);
      sk.addColorStop(0, 'rgba(255,255,255,0)');
      sk.addColorStop(0.5, 'rgba(255,255,255,0.22)');
      sk.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = sk;
      g.fillRect(lcx - lwd * 0.22, yl0, lwd * 0.44, lhl);
      g.restore();
      weather(P_LAMPRC, 0.30, '38,30,28');
      push(P_LAMPRC);
    })();

    /* ---- 25..30 : the junction (_ref/ref8) ------------------------------ */

    /* 25 -- the blue direction board at the island nose.  Turkish practice is
       a deep-blue field, a white 6 mm border inset from the edge, the place
       names left-ranged in white caps with a white arrow after each.  The
       quad is 1.10 x 0.62 m, so the glyphs are pre-stretched by that aspect. */
    (function () {
      var o = cell(P_SIGNDIR), k;
      g.fillStyle = '#17418c'; g.fillRect(o[0], o[1], ts, ts);
      /* the vitreous-enamel sheen: a faint vertical gradient, not a highlight */
      var sg = g.createLinearGradient(o[0], o[1], o[0], o[1] + ts);
      sg.addColorStop(0, 'rgba(255,255,255,0.10)');
      sg.addColorStop(0.55, 'rgba(255,255,255,0.02)');
      sg.addColorStop(1, 'rgba(0,0,0,0.10)');
      g.fillStyle = sg; g.fillRect(o[0], o[1], ts, ts);
      g.strokeStyle = '#eef1f5'; g.lineWidth = ts * 0.022;
      g.strokeRect(o[0] + ts * 0.055, o[1] + ts * 0.085, ts * 0.89, ts * 0.83);
      var rows = ['KONYA', 'MERKEZ'];
      for (k = 0; k < 2; k++) {
        var ry = o[1] + ts * (0.31 + k * 0.36);
        g.textAlign = 'left';
        (function (txt, yy) {
          var size = ts * 0.40, w;
          for (var q2 = 0; q2 < 26; q2++) {
            g.font = size + 'px ' + FONTB;
            w = g.measureText(txt).width;
            if (w <= ts * 0.60 && size * A_DIRSN * 1.02 <= ts * 0.34) break;
            size *= 0.93;
          }
          g.save();
          g.translate(o[0], yy); g.scale(1, A_DIRSN); g.translate(-o[0], -yy);
          g.fillStyle = '#ffffff'; g.textBaseline = 'middle';
          g.fillText(txt, o[0] + ts * 0.100, yy);
          g.restore();
        })(rows[k], ry);
        /* the arrow: a shaft and a solid head, pointing right */
        g.fillStyle = '#f4f7fa';
        var ax0 = o[0] + ts * 0.72, aw2 = ts * 0.16, ah = ts * 0.030 * A_DIRSN;
        g.fillRect(ax0, ry - ah * 0.5, aw2 * 0.62, ah);
        g.beginPath();
        g.moveTo(ax0 + aw2, ry);
        g.lineTo(ax0 + aw2 * 0.58, ry - ah * 2.3);
        g.lineTo(ax0 + aw2 * 0.58, ry + ah * 2.3);
        g.closePath(); g.fill();
      }
      g.textAlign = 'center';
      weather(P_SIGNDIR, 0.55, '26,34,52');
      push(P_SIGNDIR);
    })();

    /* 26 -- the round blue mandatory-direction plate, white arrow down-right.
       Round, so the cell corners must be cut: alphaTest 0.5 makes the disc. */
    (function () {
      var o = cell(P_SIGNARR);
      var cx = o[0] + ts * 0.5, cy = o[1] + ts * 0.5, rd = ts * 0.465;
      g.save();
      g.beginPath(); g.arc(cx, cy, rd, 0, TAU); g.clip();
      g.fillStyle = '#17418c'; g.fillRect(o[0], o[1], ts, ts);
      var sg2 = g.createLinearGradient(o[0], o[1], o[0], o[1] + ts);
      sg2.addColorStop(0, 'rgba(255,255,255,0.12)');
      sg2.addColorStop(1, 'rgba(0,0,0,0.12)');
      g.fillStyle = sg2; g.fillRect(o[0], o[1], ts, ts);
      /* the arrow, 45 degrees down and to the right */
      g.save();
      /* canvas rotate() is CLOCKWISE and the glyph is authored pointing +y
         (down), so +45 deg sends it down-LEFT.  _ref/ref8's plate points
         down-RIGHT: traffic keeps right of the island. */
      g.translate(cx, cy); g.rotate(-0.785398);
      g.fillStyle = '#f2f5f8';
      g.fillRect(-rd * 0.10, -rd * 0.62, rd * 0.20, rd * 0.78);
      g.beginPath();
      g.moveTo(0, rd * 0.60);
      g.lineTo(-rd * 0.34, rd * 0.10);
      g.lineTo(rd * 0.34, rd * 0.10);
      g.closePath(); g.fill();
      g.restore();
      g.restore();
      /* the rolled white rim */
      g.strokeStyle = 'rgba(228,231,234,1)'; g.lineWidth = ts * 0.030;
      g.beginPath(); g.arc(cx, cy, rd - ts * 0.014, 0, TAU); g.stroke();
      weather(P_SIGNARR, 0.5, '26,34,52');
      push(P_SIGNARR);
    })();

    /* 27 -- the red warning triangle with the hump pictogram (kasis).  An
       equilateral triangle point-up, thick red border, white field. */
    (function () {
      var o = cell(P_WARN);
      var cx = o[0] + ts * 0.5, ty = o[1] + ts * 0.055, by = o[1] + ts * 0.90;
      var hw = ts * 0.475, rC = ts * 0.055;
      function tri(inset, col) {
        var s = 1 - inset;
        g.beginPath();
        g.moveTo(cx, ty + (by - ty) * (1 - s) * 0.62);
        g.lineTo(cx + hw * s, by - (by - ty) * (1 - s) * 0.30);
        g.lineTo(cx - hw * s, by - (by - ty) * (1 - s) * 0.30);
        g.closePath();
        g.fillStyle = col; g.fill();
      }
      g.save();
      g.lineJoin = 'round'; g.lineCap = 'round';
      tri(0.00, '#b8231f');
      tri(0.20, '#f2f2ee');
      /* the hump: a low arc on a baseline */
      g.strokeStyle = '#1c1c1c'; g.lineWidth = ts * 0.045;
      g.beginPath();
      g.moveTo(cx - ts * 0.20, by - ts * 0.20);
      g.quadraticCurveTo(cx, by - ts * 0.42, cx + ts * 0.20, by - ts * 0.20);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - ts * 0.24, by - ts * 0.185); g.lineTo(cx + ts * 0.24, by - ts * 0.185);
      g.stroke();
      g.restore();
      void rC;
      weather(P_WARN, 0.55, '48,40,36');
      push(P_WARN);
    })();

    /* 28 -- the chevron hazard board that protects the island nose: black
       chevrons on a chrome-yellow field, pointing left (traffic passes left) */
    (function () {
      var o = cell(P_CHEV), k;
      g.fillStyle = '#e8c024'; g.fillRect(o[0], o[1], ts, ts);
      /* SOLID CHEVRONS, not a zigzag.  Two mitred half-strips per band drawn
         as one closed path was a lightning bolt on screen; a thick mitred
         polyline is what the board actually is. */
      g.strokeStyle = '#141414';
      g.lineWidth = ts * 0.105;
      g.lineJoin = 'miter'; g.lineCap = 'butt'; g.miterLimit = 8;
      for (k = 0; k < 4; k++) {
        var ymid = o[1] + ts * (0.145 + k * 0.235);
        g.beginPath();
        g.moveTo(o[0] + ts * 0.96, ymid - ts * 0.105);
        g.lineTo(o[0] + ts * 0.12, ymid);
        g.lineTo(o[0] + ts * 0.96, ymid + ts * 0.105);
        g.stroke();
      }
      /* the black border every one of these boards has */
      g.lineWidth = ts * 0.035; g.lineJoin = 'round';
      g.strokeRect(o[0] + ts * 0.018, o[1] + ts * 0.018, ts * 0.964, ts * 0.964);
      weather(P_CHEV, 0.75, '52,44,20');
      push(P_CHEV);
    })();

    /* 29 -- THE ORNATE RAILING PANEL, _ref/ref2 and _ref/ref7: the dark steel
       infill that stands on B-BLOK's brick garden wall.  Scrolled bar-work
       inside a flat frame, drawn as strokes so the alpha comes out for free
       and the panel is ONE quad instead of forty balusters.  A 1.35 x 0.80 m
       panel, so the scrollwork is pre-stretched by that aspect. */
    (function () {
      var o = cell(P_RAILP), k;
      var W = ts, H = ts, x0 = o[0], y0 = o[1];
      g.save();
      g.translate(x0 + W * 0.5, y0 + H * 0.5);
      g.scale(1, 1 / A_RAILP);
      g.translate(-(x0 + W * 0.5), -(y0 + H * 0.5));
      g.lineCap = 'round'; g.lineJoin = 'round';
      var barW = W * 0.030 * A_RAILP;
      /* the frame */
      g.strokeStyle = 'rgba(38,36,36,1)'; g.lineWidth = barW * 1.5;
      g.strokeRect(x0 + W * 0.03, y0 + H * 0.5 - H * 0.47 * A_RAILP,
                   W * 0.94, H * 0.94 * A_RAILP);
      /* four verticals */
      g.strokeStyle = 'rgba(44,41,41,1)'; g.lineWidth = barW;
      for (k = 1; k < 5; k++) {
        var vx = x0 + W * (0.03 + 0.94 * k / 5);
        g.beginPath();
        g.moveTo(vx, y0 + H * 0.5 - H * 0.45 * A_RAILP);
        g.lineTo(vx, y0 + H * 0.5 + H * 0.45 * A_RAILP);
        g.stroke();
      }
      /* the scrolls: an S in every bay, mirrored alternately */
      for (k = 0; k < 5; k++) {
        var bx = x0 + W * (0.03 + 0.94 * (k + 0.5) / 5);
        var by = y0 + H * 0.5, rs = W * 0.085, sgn2 = (k & 1) ? -1 : 1;
        g.strokeStyle = 'rgba(52,47,46,1)'; g.lineWidth = barW * 0.85;
        g.beginPath();
        g.arc(bx, by - rs * A_RAILP, rs, 0.5, 5.2, false);
        g.stroke();
        g.beginPath();
        g.arc(bx, by + rs * A_RAILP, rs, 3.64, 2.1, false);
        g.stroke();
        /* a little diagonal tie, which is what makes it read as wrought */
        g.beginPath();
        g.moveTo(bx - rs * sgn2, by - rs * 1.7 * A_RAILP);
        g.lineTo(bx + rs * sgn2, by + rs * 1.7 * A_RAILP);
        g.stroke();
      }
      /* the top scroll-rail spikes */
      g.strokeStyle = 'rgba(40,37,37,1)'; g.lineWidth = barW * 0.8;
      for (k = 0; k < 10; k++) {
        var sx2 = x0 + W * (0.05 + 0.90 * k / 9);
        g.beginPath();
        g.moveTo(sx2, y0 + H * 0.5 - H * 0.47 * A_RAILP);
        g.lineTo(sx2, y0 + H * 0.5 - H * 0.54 * A_RAILP);
        g.stroke();
      }
      g.restore();
      weather(P_RAILP, 0.9, '30,26,24');
      push(P_RAILP);
    })();

    /* 30 -- the minibus flank graphic: the blue wave every Turkish servis bus
       carries down its side, on a clear field so it decals onto white paint */
    (function () {
      var o = cell(P_SWOOSH), k;
      g.save();
      g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
      for (k = 0; k < 3; k++) {
        var amp = ts * (0.055 - k * 0.010), yb = o[1] + ts * (0.44 + k * 0.075);
        var cols2 = ['rgba(28,64,146,0.96)', 'rgba(58,110,190,0.94)', 'rgba(120,166,214,0.90)'];
        g.beginPath();
        g.moveTo(o[0] - ts * 0.02, yb);
        g.bezierCurveTo(o[0] + ts * 0.30, yb - amp * 3.4,
                        o[0] + ts * 0.62, yb + amp * 3.0,
                        o[0] + ts * 1.02, yb - amp * 1.1);
        g.lineTo(o[0] + ts * 1.02, yb + amp * 1.6);
        g.bezierCurveTo(o[0] + ts * 0.62, yb + amp * 4.6,
                        o[0] + ts * 0.30, yb + amp * 0.6,
                        o[0] - ts * 0.02, yb + amp * 1.8);
        g.closePath();
        g.fillStyle = cols2[k]; g.fill();
      }
      g.restore();
      push(P_SWOOSH);
    })();

    PANEL.tex = texCanvas(c, true, true);
    return PANEL.tex;
  }

  /* =======================================================================
     SECTION 7 -- materials.
     Every material goes through NZ.street.day().  Do NOT set .name
     afterwards: the 'nzday:' prefix is what keeps this geometry out of
     nz-render's neutralizeBakedLighting(), which is tuned for the night bake
     and would compress the only shading cue the street has.
     ==================================================================== */
  var MATS = null;

  function propMaterial(setName, usedTile, opts) {
    opts = opts || {};
    var set = getSet(setName);
    var nsc = fin(opts.nrm, 1.0) * (set.refTile > 0 && usedTile > 0 ? set.refTile / usedTile : 1);
    var mat = new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap,
      roughnessMap: set.ormMap, metalnessMap: set.ormMap, aoMap: set.ormMap,
      color: new THREE.Color(fin(opts.tint, 0xffffff)),
      roughness: 1.0, metalness: opts.metal === undefined ? 1.0 : opts.metal,
      vertexColors: true, dithering: true, fog: true,
      side: opts.side || THREE.FrontSide
    });
    mat.normalScale = new THREE.Vector2(nsc, nsc);
    mat.aoMapIntensity = fin(opts.ao, 1.0);
    stDay(mat, { name: 'props-' + setName, intensity: fin(opts.env, 1.0), spec: opts.spec });
    OWN.mat.push(mat);
    return mat;
  }

  /* Cabin upholstery and moulded fascia need a quiet, close-range response.
     Reusing the exterior trim atlas put half-metre rubber grain across seat
     cushions and gauge pods, which turned into checkerboard contrast once a
     window disappeared.  The cabin's small geometry supplies its texture;
     a matte vertex-colour material preserves that detail at gameplay range. */
  /* ---- THE OVERHEAD CABLE, AND WHY IT CAME OUT WHITE (mission 4 only) -----
     MEASURED, not guessed.  A probe dumped the shipped colour attribute of
     the wire vertices straight out of the built geometry:

         tone      0.043, 0.042, 0.041      (WCOL, weathered ACSR)
         bake*tone 0.0099, 0.0097, 0.0095   (after stBake + applyTone)

     -- so the "bake first, tone second" trap is NOT what is happening here.
     applyTone() multiplies AFTER stBake() writes the sky term, exactly as
     designed, and the cable's albedo in the shipped geometry is 0.0099, i.e.
     black.  Yet it rendered at 200-220 of 255 against a 112,154,201 sky.  A
     surface whose albedo is 0.01 and whose output is 0.8 is carrying no
     albedo at all: the whole value is SPECULAR, and it is the same mechanism
     the SPECULAR FLOOR note in section 10 describes -- MATS.trim carries the
     sky probe at envMapIntensity 0.85, the strand's one fixed normal is
     tipped 45 deg off vertical so a camera looking up at it sits at ~90 deg
     of incidence where Fresnel goes to 1, and EnvironmentBRDF then hands the
     cable the WHOLE dome radiance.  At roughness ~0.6 that dome sample is a
     wide blur of sky AND ground, which is why the line came out pale NEUTRAL
     rather than sky-blue.

     Three things had to change together and none of them is the tone:

       * its own material, so the fix cannot touch a bin or a bumper.  No map,
         no normal map, no roughness map: a 22 mm cable is 0.4 px at the dead
         end and every texel it samples is aliasing, not detail;
       * roughness 0.90 and envMapIntensity 0.14.  0.14 is a fifth of what the
         trim pile takes.  It leaves the cable a little sky fill -- an ACSR
         conductor really is faintly shiny along its lay -- and it stops the
         grazing lobe from delivering a whole hemisphere;
       * the SUN's own specular still reaches it through the key light, so the
         run still glints where it turns toward the south-west.  That is the
         glint the player is meant to catch, and it moves with the camera.

     Mission 1 gets none of this: MATS.wire is null there, PILES.wire stays
     empty, and every strand still lands in the trim pile. */
  function wireMaterial() {
    var mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xffffff),
      roughness: 0.90, metalness: 0.0,
      vertexColors: true, dithering: true, fog: true
    });
    stDay(mat, { name: 'props-wire', intensity: 0.14, spec: 0.05 });
    mat.envMapIntensity = 0.14;
    OWN.mat.push(mat);
    return mat;
  }

  function cabinMaterial() {
    var mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xffffff), roughness: 0.84, metalness: 0.0,
      vertexColors: true, dithering: true, fog: true, side: THREE.DoubleSide
    });
    stDay(mat, { name: 'props-cabin', intensity: 0.46, spec: 0.13 });
    OWN.mat.push(mat);
    return mat;
  }

  /* Car paint is the one place a clearcoat earns its program permutation.
     MeshPhysicalMaterial IS in the r149 core UMD bundle.  It is the single
     cheapest thing that stops a parked car reading as a painted box, and it
     is what puts the one soft highlight of the whole street on a wing. */
  function carPaintMaterial() {
    var set = getSet('carpaint');
    var nsc = set.refTile / T_PAINT;
    /* At low tier this drops to MeshStandardMaterial on purpose.  The whole
       headless harness renders at nzq=low on SwiftShader, and a physical +
       clearcoat + envmap shader that nz-render then wraps with its own AO
       block is minutes of LLVM in a software rasteriser.  The clearcoat is a
       look, not a requirement, and it comes back at med and high. */
    var desc = {
      map: set.map, normalMap: set.normalMap,
      roughnessMap: set.ormMap, metalnessMap: set.ormMap, aoMap: set.ormMap,
      color: new THREE.Color(0xffffff),
      /* roughness 1.0 -> 0.88 as a MULTIPLIER on the baked map, so the swirl,
         the flake and the road-film streaks all keep their relative structure
         and the whole surface just gets glossier: the map's 0.19 base lands at
         0.167 and the film streaks come down from 0.49 to 0.43.  A car is the
         only object on this street with a clearcoat on it, and 0.19 is a
         well-kept matt-finish plastic, not paint -- at 0.167 the sky probe's
         lobe is tight enough that the shoulder actually carries a highlight
         from it rather than a smear.  metalness stays 1.0 x the map's 0.045
         for the reason argued at length in BUILD.carpaint: paint is a
         dielectric, and the flake's contribution is now carried explicitly by
         carTone()'s mirror term instead of by an F0 that no vertex tone can
         modulate. */
      roughness: 0.88, metalness: 1.0,
      vertexColors: true, dithering: true, fog: true
    };
    var mat;
    if (TIER === 'low' || !THREE.MeshPhysicalMaterial) {
      mat = new THREE.MeshStandardMaterial(desc);
    } else {
      /* A THIRTY-YEAR-OLD CAR HAS NO CLEARCOAT LEFT.  1.0 / 0.075 is a mirror
         finish off the showroom floor: it hands a second, Fresnel-weighted copy
         of the dome to every panel on top of the base lobe, and at grazing
         incidence -- which is most of a parked car from eye height -- Fcc goes
         to 1 and the paint underneath stops mattering at all.  The chalked,
         oxidised whites in _ref/ref1 have a visible sheen and no reflection.
         0.55 / 0.17 keeps the one soft highlight on a wing that this was here
         for and gives up the mirror.  (Only med/high see this; the harness
         renders at low, so it is not what the measurements below moved.) */
      desc.clearcoat = 0.55;
      desc.clearcoatRoughness = 0.17;
      mat = new THREE.MeshPhysicalMaterial(desc);
    }
    mat.normalScale = new THREE.Vector2(nsc, nsc);
    mat.aoMapIntensity = 0.9;
    /* 1.15 was the highest envMapIntensity on the street -- higher than the
       facades, and twice GROUND's 0.55/0.62, which GROUND lowered for exactly
       this reason (SECTION 2 of nz-street-sky.js: the albedo-independent
       specular floor).  A parked car is not brighter than the render behind
       it.  0.95 is a 17 % cut and it comes off the specular floor first. */
    /* 0.95 -> 0.72, AND WHY IT IS THIS KNOB AND NOT THE ALBEDO.  See the note
       on buildMaterials(): a roof, a bonnet and a boot lid seen from eye
       height are grazing-incidence sky MIRRORS and carry no albedo at all --
       tint the whole material red and they stay white.  envMapIntensity is
       the only lever this file has on that, because day()'s documented `spec`
       option is inert once the probe exists (SKY sets __nzSkP.y = 1 and the
       whole analytic branch that reads __nzSkP.z is compiled past).

       envMapIntensity also scales the probe's DIFFUSE, so the 24 % cut is
       handed straight back as PAINT_LIFT inside carTone(): the specular keeps
       the cut, every diffuse-dominated pixel -- which is every flank, sill
       and shut line the last two passes calibrated against _ref/ref1 -- lands
       within a value of where it was. */
    stDay(mat, { name: 'props-carpaint', intensity: 0.72 });
    OWN.mat.push(mat);
    return mat;
  }

  /* Foliage gets NO grime, NO wetness and NO macro layer: a needle does not
     accumulate floor grime and a world-space blotch across a canopy is the
     loudest way to say "cards".  alphaTest, never transparent -- it writes
     depth and never sorts. */
  function leafMaterial() {
    var mat = new THREE.MeshStandardMaterial({
      map: LEAF.tex,
      /* a LOW alphaTest, deliberately.  The atlas now carries an opaque dark
         body under every needle, so the cut is made by the body's edge rather
         than by the needle strokes -- and a high threshold was eroding the
         crown into a translucent haze three mip levels down. */
      alphaTest: 0.30,
      side: THREE.DoubleSide,
      roughness: 0.95, metalness: 0.0,
      vertexColors: true, dithering: true, fog: true
    });
    /* a spruce reflects almost nothing.  At 0.80 the sky probe was lifting the
       needles a full stop above the reference plates. */
    stDay(mat, { name: 'props-foliage', intensity: 0.52 });
    OWN.mat.push(mat);
    return mat;
  }
  function panelMaterial() {
    var mat = new THREE.MeshStandardMaterial({
      map: PANEL.tex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.72, metalness: 0.0,
      vertexColors: true, dithering: true, fog: true
    });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -3;
    stDay(mat, { name: 'props-panel', intensity: 0.95 });
    OWN.mat.push(mat);
    return mat;
  }

  /* =======================================================================
     SECTION 8 -- Pile: the hand-written merge (ENV-PLAYBOOK 6.1).
     Nine piles, nine draw calls, one material each.  Each vertex carries a
     TONE triple; after NZ.street.bake() has written the achromatic overcast
     solution into `color`, applyTone() multiplies the two.  That is where the
     body colour of every car, the dust up its flanks, the grey of a tyre
     sidewall and the ground-line soiling of every wall live -- one bake, a
     whole car park (ENV-PLAYBOOK 2.4.5).
     ==================================================================== */
  function Pile(tile) {
    this.p = []; this.nm = []; this.uv = []; this.t = []; this.idx = [];
    this.n = 0;
    this.tl = tile || 4; this.inv = 1 / (tile || 4);
    this.tn = [1, 1, 1];
    this.mac = 1;
  }
  Pile.prototype.tile = function (t) { this.tl = t; this.inv = 1 / (t || 4); return this; };
  Pile.prototype.tint = function (c) { this.tn = c || [1, 1, 1]; return this; };
  Pile.prototype.macro = function (a) { this.mac = a === undefined ? 1 : a; return this; };
  Pile.prototype.vert = function (x, y, z, nx, ny, nz, u, v, tr, tg, tb) {
    this.p.push(x, y, z); this.nm.push(nx, ny, nz); this.uv.push(u, v);
    this.t.push(tr, tg, tb);
    return this.n++;
  };
  Pile.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Pile.prototype.empty = function () { return this.n === 0; };
  Pile.prototype.geometry = function () {
    var g = new THREE.BufferGeometry(), i;
    for (i = 0; i < this.p.length; i++) if (!isFinite(this.p[i])) this.p[i] = 0;
    for (i = 0; i < this.uv.length; i++) if (!isFinite(this.uv[i])) this.uv[i] = 0;
    for (i = 0; i < this.t.length; i++) if (!isFinite(this.t[i])) this.t[i] = 1;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) g.boundingSphere = null;
    OWN.geo.push(g);
    return g;
  };
  function applyTone(geo, pile) {
    var c = geo.attributes && geo.attributes.color;
    if (!c || !pile) return geo;
    var a = c.array, t = pile.t, n = Math.min(a.length, t.length), i;
    for (i = 0; i < n; i++) { var v = a[i] * t[i]; a[i] = isFinite(v) ? v : 0.4; }
    c.needsUpdate = true;
    return geo;
  }

  /* world-space macro break-up, paid for in vertex colour instead of a
     program permutation.  Off for the cars (a panel is not weathered by the
     street's noise field) and for the foliage. */
  var MACRO_AMT = 0.13;
  function macro(x, z, amt) {
    if (amt <= 0) return 1;
    var n = vnoise(x / 17.0, z / 17.0) * 0.62 + vnoise(x / 5.9 + 31.4, z / 5.9 - 12.1) * 0.38;
    return 1 + (n - 0.5) * MACRO_AMT * amt;
  }

  /* --- the only vertex emitter for solid surfaces (ENV-PLAYBOOK 6.2) ------
     `ref` is a point demonstrably inside the solid, which is what makes 26
     facets of a chamfered box face outward without tracking winding.
     `tone` may be an [r,g,b] or a function(point) -> [r,g,b]. */
  function poly(pile, pts, rx, ry, rz, ao, tone) {
    var n = pts.length, i;
    tick();
    if (n < 3) return;
    var cx = 0, cy = 0, cz = 0;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
    cx /= n; cy /= n; cz /= n;
    var nx = 0, ny = 0, nz = 0;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 1e-9)) return;                       /* a degenerate facet */
    nx /= len; ny /= len; nz /= len;
    var flip = (nx * (cx - rx) + ny * (cy - ry) + nz * (cz - rz)) < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }

    var ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    var mode = (ay >= ax && ay >= az) ? 1 : (ax >= az ? 0 : 2);
    var t = pile.inv;
    var sh = (ao === undefined || ao === null) ? 1 : ao;
    /* an up-facing facet sees the whole dome; a down-facing one sees nothing.
       The bake knows this too, but only at vertex resolution -- this keeps a
       car's underside dark even where the bake's rays escape sideways. */
    sh *= (1 - 0.30 * clamp(-ny, 0, 1));
    var fn = (typeof tone === 'function') ? tone : null;
    var base = pile.n, k;
    for (i = 0; i < n; i++) {
      var p = pts[i], u, v;
      if (mode === 1) { u = p[0] * t; v = p[2] * t; }
      else if (mode === 0) { u = p[2] * t; v = p[1] * t; }
      else { u = p[0] * t; v = p[1] * t; }
      /* the tone callback gets the facet's UP-FACING-NESS as well as the
         point.  Nothing that ignores the second argument changes behaviour;
         carTone() uses it to settle dust on a horizontal panel, which a
         function of position alone cannot know about. */
      var tv = fn ? fn(p, ny) : (tone || pile.tn);
      var mk = macro(p[0], p[2], pile.mac) * sh;
      pile.vert(p[0], p[1], p[2], nx, ny, nz, u, v, tv[0] * mk, tv[1] * mk, tv[2] * mk);
    }
    for (k = 1; k < n - 1; k++) {
      if (flip) pile.tri(base, base + k + 1, base + k);
      else pile.tri(base, base + k, base + k + 1);
    }
  }

  /* --- the same emitter with SUPPLIED per-vertex normals ------------------
     poly() writes one flat normal per facet.  That is right for a wall and it
     is exactly why the fleet rendered as plaster: a lofted flank is a column
     of quads that all share one horizontal normal, so every one of them
     samples the probe in the same place and the paint has no gradient left to
     show.  A car is a MIRROR OF A GRADIENT -- the shoulder rolls the
     reflection up into the bright dome, the door holds the horizon, the sill
     rolls it down into the tarmac -- and that only happens if the normal
     turns across the section.  So the loft hands its analytic section normal
     in here instead.  Creases (shut lines, the end faces, the arch lip) keep
     using poly() and stay hard.

     `ao` may be a number or a per-vertex array in the same order as `pts`. */
  function polyS(pile, pts, nrm, ao, tone) {
    var n = pts.length, i;
    tick();
    if (n < 3 || !nrm || nrm.length !== n) return;
    var ax = 0, ay = 0, az = 0;
    for (i = 0; i < n; i++) { ax += nrm[i][0]; ay += nrm[i][1]; az += nrm[i][2]; }
    var al = Math.sqrt(ax * ax + ay * ay + az * az);
    if (!(al > 1e-9)) return;
    ax /= al; ay /= al; az /= al;
    /* the geometric normal decides the WINDING, the supplied ones decide the
       SHADING; if the two disagree the facet is inside out */
    var gx = 0, gy = 0, gz = 0;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      gx += (a[1] - b[1]) * (a[2] + b[2]);
      gy += (a[2] - b[2]) * (a[0] + b[0]);
      gz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if (!(Math.sqrt(gx * gx + gy * gy + gz * gz) > 1e-9)) return;
    var flip = (gx * ax + gy * ay + gz * az) < 0;
    var bx = Math.abs(ax), by = Math.abs(ay), bz = Math.abs(az);
    var mode = (by >= bx && by >= bz) ? 1 : (bx >= bz ? 0 : 2);
    var t = pile.inv, arr = (ao && ao.length) ? ao : null;
    var fn = (typeof tone === 'function') ? tone : null;
    var base = pile.n, k;
    for (i = 0; i < n; i++) {
      var p = pts[i], u, v, nv = nrm[i];
      if (mode === 1) { u = p[0] * t; v = p[2] * t; }
      else if (mode === 0) { u = p[2] * t; v = p[1] * t; }
      else { u = p[0] * t; v = p[1] * t; }
      var sh = arr ? arr[i] : ((ao === undefined || ao === null) ? 1 : ao);
      /* the same down-facing term poly() applies, but at VERTEX resolution:
         it is what darkens a turned-under sill without a second material */
      sh *= (1 - 0.34 * clamp(-nv[1], 0, 1));
      /* ...and the same up-facing hint poly() passes, at vertex resolution,
         so the dust term ramps smoothly round a crowned roof instead of
         stepping from one section band to the next */
      var tv = fn ? fn(p, nv[1]) : (tone || pile.tn);
      var mk = macro(p[0], p[2], pile.mac) * sh;
      pile.vert(p[0], p[1], p[2], nv[0], nv[1], nv[2], u, v,
                tv[0] * mk, tv[1] * mk, tv[2] * mk);
    }
    for (k = 1; k < n - 1; k++) {
      if (flip) pile.tri(base, base + k + 1, base + k);
      else pile.tri(base, base + k, base + k + 1);
    }
  }

  /* --- a chamfered box: 96 verts, 44 tris.  A pure 90 degree edge is the
     number one tell of a prototype (CS2-BRIEF), so k is never 0. --------- */
  function boxC(pile, cx, cy, cz, hx, hy, hz, k, ao, tone) {
    k = Math.min(k, hx * 0.49, hy * 0.49, hz * 0.49);
    var h = [hx, hy, hz], c = [cx, cy, cz];
    function P(axis, s0, s1, s2) {
      var s = [s0, s1, s2], o = [0, 0, 0];
      for (var i = 0; i < 3; i++) o[i] = c[i] + s[i] * (i === axis ? h[i] : h[i] - k);
      return o;
    }
    var S = [-1, 1], i, j, l;
    for (i = 0; i < 3; i++) for (j = 0; j < 2; j++) {
      var s = S[j], a1 = (i + 1) % 3, a2 = (i + 2) % 3;
      var q = [], sg = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (l = 0; l < 4; l++) {
        var sv = [0, 0, 0]; sv[i] = s; sv[a1] = sg[l][0]; sv[a2] = sg[l][1];
        q.push(P(i, sv[0], sv[1], sv[2]));
      }
      poly(pile, q, cx, cy, cz, ao, tone);
    }
    for (i = 0; i < 3; i++) for (j = i + 1; j < 3; j++) {
      var ax3 = 3 - i - j;
      for (var si = 0; si < 2; si++) for (var sj = 0; sj < 2; sj++) {
        var s1 = S[si], s2 = S[sj], q2 = [];
        var vA = [0, 0, 0], vB = [0, 0, 0];
        vA[i] = s1; vA[j] = s2; vA[ax3] = -1;
        vB[i] = s1; vB[j] = s2; vB[ax3] = 1;
        q2.push(P(i, vA[0], vA[1], vA[2]));
        q2.push(P(i, vB[0], vB[1], vB[2]));
        q2.push(P(j, vB[0], vB[1], vB[2]));
        q2.push(P(j, vA[0], vA[1], vA[2]));
        poly(pile, q2, cx, cy, cz, ao, tone);
      }
    }
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var cq = 0; cq < 2; cq++) {
      poly(pile, [P(0, S[a], S[b], S[cq]), P(1, S[a], S[b], S[cq]), P(2, S[a], S[b], S[cq])],
           cx, cy, cz, ao, tone);
    }
  }

  /* --- a plain axis-aligned box, 6 quads, 12 tris.  For balusters, rails,
     bin bodies and everything else that is 40 mm across and does not repay a
     chamfer at 96 verts a go. --------------------------------------------- */
  function box6(pile, x0, x1, y0, y1, z0, z1, ao, tone) {
    var cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
    poly(pile, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, ao, tone);
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], cx, cy, cz, ao, tone);
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], cx, cy, cz, ao, tone);
    poly(pile, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, ao, tone);
    poly(pile, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], cx, cy, cz, ao, tone);
    poly(pile, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], cx, cy, cz, ao, tone);
  }

  /* --- a capped cylinder along any axis (ENV-PLAYBOOK 6.4) ---------------- */
  function tube(pile, ax, ay, az, bx, by, bz, r, seg, ao, cap, tone, r2) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(L > 1e-6) || !(r > 1e-6)) return;
    dx /= L; dy /= L; dz /= L;
    var ux, uy, uz;
    if (Math.abs(dy) < 0.9) { ux = 0; uy = 1; uz = 0; } else { ux = 1; uy = 0; uz = 0; }
    var e0x = uy * dz - uz * dy, e0y = uz * dx - ux * dz, e0z = ux * dy - uy * dx;
    var el = Math.sqrt(e0x * e0x + e0y * e0y + e0z * e0z) || 1;
    e0x /= el; e0y /= el; e0z /= el;
    var e1x = dy * e0z - dz * e0y, e1y = dz * e0x - dx * e0z, e1z = dx * e0y - dy * e0x;
    var rb = (r2 === undefined) ? r : r2;
    var A = [], B = [], i;
    for (i = 0; i < seg; i++) {
      var a = i / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
      A.push([ax + (e0x * ca + e1x * sa) * r, ay + (e0y * ca + e1y * sa) * r, az + (e0z * ca + e1z * sa) * r]);
      B.push([bx + (e0x * ca + e1x * sa) * rb, by + (e0y * ca + e1y * sa) * rb, bz + (e0z * ca + e1z * sa) * rb]);
    }
    var mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg;
      poly(pile, [A[i], A[j], B[j], B[i]], mx, my, mz, ao, tone);
    }
    if (cap !== false) {
      poly(pile, A, mx, my, mz, ao, tone);
      poly(pile, B, mx, my, mz, ao, tone);
    }
  }

  /* --- a loft between ordered cross-sections.  The car body tool. --------- */
  function loft(pile, secs, ao, tone, capA, capB, ref) {
    var ns = secs.length, i, j;
    if (ns < 2) return;
    var np = secs[0].length;
    var rx = ref ? ref[0] : 0, ry = ref ? ref[1] : 0, rz = ref ? ref[2] : 0;
    if (!ref) {
      var n = 0;
      for (i = 0; i < ns; i++) for (j = 0; j < np; j++) { rx += secs[i][j][0]; ry += secs[i][j][1]; rz += secs[i][j][2]; n++; }
      rx /= n; ry /= n; rz /= n;
    }
    for (i = 0; i < ns - 1; i++) {
      var s0 = secs[i], s1 = secs[i + 1];
      for (j = 0; j < np; j++) {
        var k = (j + 1) % np;
        poly(pile, [s0[j], s0[k], s1[k], s1[j]], rx, ry, rz, ao, tone);
      }
    }
    if (capA) poly(pile, secs[0].slice().reverse(), rx, ry, rz, ao, tone);
    if (capB) poly(pile, secs[ns - 1], rx, ry, rz, ao, tone);
  }

  /* --- an atlas-mapped quad.  c is the centre, u/v the HALF axes. ---------
     HANDEDNESS.  The quad is wound -u-v, +u-v, +u+v, -u+v, whose geometric
     front face is u x v -- so `card` is self-consistent, and the mirroring bug
     is always in the CALLER: pass u = +X and v = +Y on a wall whose outward
     direction is -Z and the text is drawn on the back of the quad, which under
     a DoubleSide material is a perfectly legible MIRROR IMAGE.  That is the
     shop fascia, the banner, the A-board, the street plate, every headlamp,
     every grille, every front number plate and every satellite dish.
     `face` is the direction the tile must be READ from.  When it opposes
     u x v, u is negated: the quad occupies exactly the same space, its UV
     handedness flips back, and its normal turns to face the viewer -- which
     also fixes the bake, since a wall-mounted sign whose normal points INTO
     the wall traces its hemisphere through the building. ------------------ */
  function card(pile, cx, cy, cz, ux, uy, uz, vx, vy, vz, rect, tone, ao, face) {
    tick();
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (face && (nx * face[0] + ny * face[1] + nz * face[2]) < 0) {
      ux = -ux; uy = -uy; uz = -uz;
      nx = -nx; ny = -ny; nz = -nz;
      STATS.flipped++;
    }
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    var u0 = rect[0], v0 = rect[1], u1 = rect[2], v1 = rect[3];
    var mk = macro(cx, cz, pile.mac) * ((ao === undefined) ? 1 : ao);
    var t = tone || pile.tn;
    var tr = t[0] * mk, tg = t[1] * mk, tb = t[2] * mk;
    var b = pile.n;
    pile.vert(cx - ux - vx, cy - uy - vy, cz - uz - vz, nx, ny, nz, u0, v0, tr, tg, tb);
    pile.vert(cx + ux - vx, cy + uy - vy, cz + uz - vz, nx, ny, nz, u1, v0, tr, tg, tb);
    pile.vert(cx + ux + vx, cy + uy + vy, cz + uz + vz, nx, ny, nz, u1, v1, tr, tg, tb);
    pile.vert(cx - ux + vx, cy - uy + vy, cz - uz + vz, nx, ny, nz, u0, v1, tr, tg, tb);
    pile.tri(b, b + 1, b + 2); pile.tri(b, b + 2, b + 3);
    STATS.cards++;
  }
  /* an upright cross of two cards -- weeds, tufts, a rose bush */
  function crossCard(pile, x, y, z, w, h, rot, rect, tone, ao) {
    var c1 = Math.cos(rot), s1 = Math.sin(rot);
    card(pile, x, y + h * 0.5, z, c1 * w * 0.5, 0, s1 * w * 0.5, 0, h * 0.5, 0, rect, tone, ao);
    card(pile, x, y + h * 0.5, z, -s1 * w * 0.5, 0, c1 * w * 0.5, 0, h * 0.5, 0, rect, tone, ao);
  }

  /* =======================================================================
     SECTION 9 -- reading the level.
     The bays are S_BLOCK cells NUKEM.html deliberately keeps out of CRATES[]
     so the cell is solid and nothing is drawn on it.  Do NOT hardcode the
     list: scan the rectangle and group contiguous runs, so the fleet stays
     correct if the orchestrator moves a bay.
     ==================================================================== */
  /* THREE KINDS OF S_BLOCK NOW, and telling them apart is the whole reason
     the contract says scan instead of hardcode: a run on a kerb road row is a
     parking bay, the 2 x 2 cluster inside the island AABB is the kerbed
     teardrop and takes NO car, and a single cell on an outer pavement row is
     a tree pit.  GROUND already did this scan and publishes the answer with
     a `.kind`; take its list when it is there so the two modules can never
     disagree about which cell is which, and fall back to an identical
     classifier when GROUND is disabled. */
  function classify(run) {
    run.cells = Math.round((run.x1 - run.x0) / 4);
    run.len = run.x1 - run.x0;
    run.island = onIsland((run.x0 + run.x1) * 0.5, (run.z0 + run.z1) * 0.5, -0.5);
    var road = (run.z0 >= RZ0 - 1e-6 && run.z1 <= RZ1 + 1e-6);
    run.barrier = run.x0 >= 832 - 1e-6 && run.x1 <= 836 + 1e-6;
    run.kind = run.barrier ? 'barrier' : (run.island ? 'island' : (road ? 'bay' : 'pit'));
    run.road = run.kind === 'bay';
    run.north = ((run.z0 + run.z1) * 0.5) < (RZ0 + RZ1) * 0.5;
    return run;
  }
  function scanBays() {
    var out = [], cy, cx, i;
    var g = GR();
    if (g && g.bays && g.bays.length) {
      for (i = 0; i < g.bays.length; i++) {
        var b = g.bays[i];
        if (!b || !isFinite(b.x0)) continue;
        var r = classify({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 });
        /* GROUND's own label wins where it has one -- it is the module that
           owns the surface, and `kind` is what it publishes it under */
        if (b.kind === 'bay' || b.kind === 'pit' || b.kind === 'island' || b.kind === 'barrier') {
          r.kind = b.kind; r.road = b.kind === 'bay'; r.island = b.kind === 'island';
        }
        out.push(r);
      }
      return out;
    }
    var cy0 = Math.floor((RZ0 - 8) / 4), cy1 = Math.ceil((RZ1 + 8) / 4) - 1;
    var cx0 = Math.floor(BOX.x0 / 4), cx1 = Math.ceil(BOX.x1 / 4) - 1;
    for (cy = cy0; cy <= cy1; cy++) {
      var run = null;
      for (cx = cx0; cx <= cx1 + 1; cx++) {
        var isBay = false;
        if (cx <= cx1 && G.inb(cx, cy) && !liftCell(cx, cy)) isBay = (G.cellAt(cx, cy) === G.S_BLOCK);
        if (isBay) {
          if (!run) run = { cy: cy, cx0: cx, cx1: cx };
          else run.cx1 = cx;
        } else if (run) {
          run.x0 = run.cx0 * 4; run.x1 = (run.cx1 + 1) * 4;
          run.z0 = cy * 4; run.z1 = (cy + 1) * 4;
          out.push(classify(run));
          run = null;
        }
      }
    }
    return out;
  }

  /* The facade descriptors nz-street.js publishes.  If FACADE is absent (or
     panicked) fall back to the carve's own numbers so the trees still know
     where the cikma is -- but say so, because a silent fallback that is
     wrong plants a spruce inside a balcony. */
  var FACES = [];
  var BAYD = m(1.20), SOFF_Y = 10.2, SOFF_TOP = 11.9, EAVES_Y = 51.8, EAVE_OUT = m(0.60);
  function adoptFacades() {
    var s = ST(), i;
    FACES = [];
    if (s && s.facades && s.facades.length) {
      for (i = 0; i < s.facades.length; i++) {
        var f = s.facades[i];
        FACES.push({
          id: f.id || ('f' + i), side: f.side, a: fin(f.a, 0), b: fin(f.b, 0),
          plane: fin(f.plane, 0), axis: f.axis || ((f.side === 'N' || f.side === 'S') ? 'z' : 'x'),
          inward: fin(f.inward, f.side === 'N' || f.side === 'W' ? 1 : -1),
          wallFace: fin(f.wallFace, f.plane), plinthFace: fin(f.plinthFace, f.plane),
          bayFace: fin(f.bayFace, f.plane), eaveFace: fin(f.eaveFace, f.plane),
          face: fin(f.face, f.bayFace), kind: f.kind || 'generic', entryBay: f.entryBay || null,
          bayA: fin(f.bayA, f.a), bayB: fin(f.bayB, f.b),
          soffitY: fin(f.soffitY, SOFF_Y), soffitTopY: fin(f.soffitTopY, SOFF_TOP),
          eavesY: fin(f.eavesY, EAVES_Y), plinthTop: fin(f.plinthTop, m(1.45)),
          gaps: f.gaps || [], body: fin(f.body, 0xd8d0c0), name: f.name || '',
          entrance: f.entrance || null, entrances: f.entrances || [], blind: !!f.blind
        });
      }
      BAYD = fin(FACES[0].bayFace - FACES[0].plane, BAYD) * (FACES[0].inward || 1);
      SOFF_Y = FACES[0].soffitY; SOFF_TOP = FACES[0].soffitTopY; EAVES_Y = FACES[0].eavesY;
      return true;
    }
    warn('NZ.street.facades is empty -- using the carve constants for the cikma');
    var defs = [
      { id: 'AB', side: 'N', a: 580, b: 756, plane: 140, inward: 1 },
      { id: 'BB', side: 'S', a: 580, b: 756, plane: 208, inward: -1 }
    ];
    for (i = 0; i < defs.length; i++) {
      var d = defs[i];
      FACES.push({
        id: d.id, side: d.side, a: d.a, b: d.b, plane: d.plane,
        axis: (d.side === 'N' || d.side === 'S') ? 'z' : 'x', inward: d.inward,
        wallFace: d.plane + d.inward * 0.34, plinthFace: d.plane + d.inward * 0.52,
        bayFace: d.plane + d.inward * BAYD, eaveFace: d.plane + d.inward * (BAYD + EAVE_OUT),
        bayA: d.a + BAYD, bayB: d.b - BAYD,
        soffitY: SOFF_Y, soffitTopY: SOFF_TOP, eavesY: EAVES_Y, plinthTop: m(1.45),
        gaps: [], body: 0xd8d0c0, name: '', entrance: null, entrances: [], blind: false
      });
    }
    return false;
  }
  function faceOf(side) {
    for (var i = 0; i < FACES.length; i++) if (FACES[i].side === side) return FACES[i];
    return null;
  }
  /* the run coordinate of a point on a given facade */
  function alongOf(f, x, z) { return f.axis === 'z' ? x : z; }
  function acrossOf(f, x, z) { return f.axis === 'z' ? z : x; }
  /* is this point inside a building mass?  Used to prune the tree canopies
     that are planted a hand's breadth from the wall, exactly as a real one is
     pruned: flat on the side the building is on. */
  function insideBuilding(x, y, z, margin) {
    var i, mg = margin === undefined ? 0.25 : margin;
    if (x < BOX.x0 + mg || x > BOX.x1 - mg || z < BOX.z0 + mg || z > BOX.z1 - mg) {
      /* outside the canyon rectangle: only the junction throat is open, and
         only BELOW the bridge band -- above y = 28 the side street is roofed
         by a building mass and a branch there is inside it */
      var open = (x > MOUTH.x0 && x < MOUTH.x1 && z > MOUTH.z0 - 6 && z < BOX.z0 &&
                  y < fin(MOUTH.lintel, BAND.y0) - mg);
      if (!open) return true;
    }
    for (i = 0; i < FACES.length; i++) {
      var f = FACES[i], s = alongOf(f, x, z), c = acrossOf(f, x, z);
      var face;
      if (y > f.eavesY - 0.2) { if (y > f.eavesY + m(1.4)) continue; face = f.eaveFace; }
      else if (y >= f.soffitTopY - 0.35) { if (s < f.bayA - 0.4 || s > f.bayB + 0.4) continue; face = f.bayFace; }
      else if (y >= f.plinthTop) { face = f.wallFace; }
      else { face = f.plinthFace; }
      if (f.inward * (c - face) < mg) {
        if (y < f.soffitTopY && s > f.a - 0.5 && s < f.b + 0.5) return true;
        if (y >= f.soffitTopY) return true;
      }
    }
    return false;
  }

  /* the occluder boxes handed to NZ.street.bake().  The sky module models the
     canyon as four vertical planes to the eaves, so the cikma soffit, the
     eaves overhang and the two masses either side of the alley mouth are all
     invisible to it -- and they are exactly what puts the dark band under the
     overhang and the shadow under a car. */
  var OCCL = [];
  function buildOccluders() {
    var i, o = [];
    o.push({ x0: BOX.x0 - 40, x1: MOUTH.x0, y0: 0, y1: 52, z0: 120, z1: BOX.z0 });
    o.push({ x0: MOUTH.x1, x1: BOX.x1 + 40, y0: 0, y1: 52, z0: 120, z1: BOX.z0 });
    /* THE BRIDGE BAND.  The side street is open at ground level and roofed
       from y = 28 up, and that mass is what keeps the junction apron the
       brightest asphalt on the street while the throat itself stays in shade.
       Without it the two boxes above leave an 84-unit-tall slot of open sky
       over the junction and every sign on the island bakes as if it stood in
       a field. */
    o.push({ x0: BAND.x0, x1: BAND.x1, y0: fin(BAND.y0, 28), y1: fin(BAND.y1, 52),
             z0: 120, z1: fin(BAND.z, BOX.z0) });
    for (i = 0; i < FACES.length; i++) {
      var f = FACES[i];
      var c0 = Math.min(f.plane, f.eaveFace), c1 = Math.max(f.plane, f.eaveFace);
      var b0 = Math.min(f.plane, f.bayFace), b1 = Math.max(f.plane, f.bayFace);
      if (f.axis === 'z') {
        o.push({ x0: f.bayA, x1: f.bayB, y0: f.soffitTopY - 0.1, y1: f.eavesY, z0: b0, z1: b1 });
        o.push({ x0: f.a - 1, x1: f.b + 1, y0: f.eavesY - 0.1, y1: f.eavesY + m(2.6), z0: c0, z1: c1 });
      } else {
        o.push({ x0: b0, x1: b1, y0: f.soffitTopY - 0.1, y1: f.eavesY, z0: f.bayA, z1: f.bayB });
        o.push({ x0: c0, x1: c1, y0: f.eavesY - 0.1, y1: f.eavesY + m(2.6), z0: f.a - 1, z1: f.b + 1 });
      }
    }
    OCCL = o;
    return o;
  }
  var SELF_OCC = [];       /* car bodies and tree canopies, added as we build */
  function occAll() { return OCCL.concat(SELF_OCC); }

  /* =======================================================================
     SECTION 10 -- the parked cars.  The signature of the street.

     LEGALITY, rule C, and it is the only rule a car can satisfy: a car is
     6 x 15 x 5 world units, so it is 6.4x too deep for rule A, sits on the
     road so rule B is out, and is four times too tall for rule E
     (ENV-PLAYBOOK 7.4).  Every car therefore stands on a run of S_BLOCK
     cells found by scanBays(), and its footprint is checked against that run
     plus HUG of overhang by legalC().  A car that is not on a blocked cell
     is a hologram the player walks through, and no amount of modelling
     rescues that.

     A bay is 4 cells = 16 units = 4.57 m long and ONE cell = 4 units = 1.14 m
     deep, so a 1.65 m car necessarily overhangs the bay sideways -- which is
     why every kerb-side car here has its nearside wheels up on the kerb,
     leaning 2-5 degrees into the road.  That is not a compromise: it is
     exactly what ref1 and ref5 show, and the tilt is solved from the real
     kerb and camber heights rather than authored.
     ==================================================================== */
  /* NOTE ON TONE.  Every set below is baked NEUTRAL and the colour arrives as
     a vertex tone that multiplies map x bake.  A tone of 1.0 therefore means
     "the albedo the map was baked at", not "white".  The carpaint map bakes at
     a linear 0.545, so a tone of 0.61 is a 0.33 white car.

     THE WHITES CAME DOWN 23 % THIS PASS, and the paragraph the old number was
     defended with was simply wrong: it claimed a 0.44 body "puts a horizontal
     panel around 235/255", and measured through ?nzgrade=0 the horizontal
     panel was at scene-linear 1.42, which the grade takes to 250-255.  It was
     clipped, and 0.43 % of the money shot -- almost all of it car roofs -- sat
     above 248 against _ref/ref1's 0.00 % on the same surfaces.

     An old white car is not 0.44 either.  It is chalked: the binder has gone,
     the surface is microscopically rough and it scatters like matt emulsion.
     0.33 linear reads as white in context and measures against the plates.
     The greys and the beige moved with it; the navy and the black did not,
     because for them the metalness change below was already a wash. */
  var DIRT = [0.165, 0.152, 0.130];       /* road film, cool grey not brown  */
  /* settled dust: the grey a horizontal panel goes after a winter outdoors.
     Kept NEUTRAL for the same reason the paint map is -- a warm dust on the one
     surface that faces the blue zenith is the fastest way to throw away the
     chroma the reference plates measure on exactly that surface. */
  /* 0.148 -> 0.108.  See DUST_AMT: the pair of them is one change. */
  var DUSTH = [0.108, 0.108, 0.111];
  /* 0.55 -> 0.70 -> 0.86.

     THE ARITHMETIC, so the next pass does not have to solve it again.  The
     grade is a power about a pivot with an exponent of 1.60 above r = 1.40
     (nz-street-sky.js:997), and everything on an up-facing panel is far above
     that knee, so an OUTPUT ratio r_out costs only r_out^(1/1.6) of
     scene-linear:

       245 -> 230 sRGB        post-ACES linear 0.911 -> 0.791
                              ACES-inverse     v 4.07 -> 1.89   (x 0.463)
                              scene-linear     x 0.463^0.625 = x 0.618

     -- and that inversion is independent of toneMappingExposure, because both
     ends of it are measured through the same one.  So an up-facing panel that
     is clipping needs about 38 % of its radiance taken out, which is FIVE
     TIMES what 0.55 -> 0.70 moved: at 0.70 a white roof still keeps 0.284 of
     its 0.601 tone.

     WHAT THIS DOES AND DOES NOT FIX, measured rather than assumed.  Probing
     _shots/pol/street.south34.png with DUST_AMT = 1.0 over a black dust moves
     the frame by 0.62 of a value and the brightest wedge in it by 4, and
     forcing every FLEET colour to 0.02 moves that wedge by nothing at all --
     so the clipping in that frame is NOT car paint.  It is the garden wall's
     precast coping, and it is fixed where it lives (see UPGRIME, section 12).
     This term is still worth moving, because the frames that DO see a roof
     plan-on -- street.high, and any camera that ends up beside a parked car --
     had one at 246-251.

     Both numbers move together, in the direction the photographs already said:
     the dust on a car that has stood out all winter is DARKER than 0.148 (it
     is street grit, not talc), and there is MORE of it on a dead-flat panel
     than 0.70.  At 0.108 / 0.86:

       kartal white  0.601 -> 0.177   (was 0.284, x 0.62)
       octavia       0.654 -> 0.185   (was 0.300, x 0.62)
       transit       0.658 -> 0.186   (was 0.301, x 0.62)   the minibus
       sahin beige   0.478 -> 0.160   (was 0.247, x 0.65)
       laguna navy   0.042 -> 0.062   (was 0.058, x 1.06)   dark cars unmoved
       mpv black     0.028 -> 0.041   (was 0.039, x 1.06)

     The flanks are ny = 0 and take neither term, so every number the previous
     two passes calibrated against _ref/ref1's belt / door / rubbing strip
     stands untouched. */
  var DUST_AMT = 0.86;                    /* mix at a dead-flat roof panel    */

  /* the height of whatever a wheel or a foot lands on at (x, z).  The island
     is a raised kerb ring in the middle of the roadway and the throat is
     asphalt where the map says pavement, so neither can be inferred from z. */
  function groundYAt(z, x) {
    if (x !== undefined && onIsland(x, z, 0)) return Y_ISLK;
    if (z >= RZ0 && z <= RZ1) return roadYAt(z, x);
    if (x !== undefined && inThroat(x, z)) return roadYAt(z, x);
    if (z >= RZ0 - 1.0 && z < RZ0) return Y_KERB;
    if (z > RZ1 && z <= RZ1 + 1.0) return Y_KERB;
    return Y_PAVE;
  }

  function mkT(px, py, pz, yaw, roll) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var cr = Math.cos(roll), sr = Math.sin(roll);
    return function (x, y, z) {
      var y2 = y * cr - z * sr, z2 = y * sr + z * cr;
      return [px + x * cy - z2 * sy, py + y2, pz + x * sy + z2 * cy];
    };
  }
  function TS(T, pts) {
    var o = [], i;
    for (i = 0; i < pts.length; i++) o.push(T(pts[i][0], pts[i][1], pts[i][2]));
    return o;
  }

  /* The fleet, straight off the reference plates and off the manufacturers'
     own figures.  Every dimension is metres; m() takes it to world units, so a
     number here can be checked against a workshop manual:

       Tofas Sahin      4.26 x 1.65 x 1.40   wb 2.51   165/80 R13  (r 0.310)
       Tofas Kartal SW  4.44 x 1.65 x 1.46   wb 2.51
       Renault 12 Toros 4.34 x 1.62 x 1.44   wb 2.44
       Skoda Octavia    4.66 x 1.81 x 1.46   wb 2.68   195/65 R15  (r 0.324)
       Fiat Doblo       4.16 x 1.72 x 1.82   wb 2.57

     Widths above 1.686 m (5.90 u) are trimmed by buildCars() so no flank ever
     crosses the HUG line -- the Octavia loses 12 cm nobody can measure and
     gains a body the player cannot walk through.

     `cab` is the greenhouse: [base of the backlight, top rear of the roof,
     top front of the roof, base of the windscreen], as fractions of L from
     the TAIL.  `box` is boxiness: 1 = Fiat 131 (flat sides, upright glass,
     thin pillars, chrome bumpers), 0 = a rounded 90s saloon.  Getting the two
     ends of that scale visibly different is what stops the row reading as six
     copies of one car. */
  var FLEET = {
    kartal: { nm: 'Tofas Kartal SW', kind: 'estate', L: m(4.44), W: m(1.65), H: m(1.46),
      wb: m(2.51), wr: m(0.313), tw: m(0.175), box: 1.00, grime: 0.66, clear: 0.42,
      cab: [0.038, 0.098, 0.645, 0.712], panes: 3, doors: 4, cap: 0, rails: 1,
      col: [0.601, 0.604, 0.610], plate: P_PLATE, lampF: P_LAMPF, lampR: P_LAMPR,
      grille: P_GRILLE2, chrome: 1, patch: 1 },
    toros: { nm: 'Renault 12 Toros', kind: 'saloon', L: m(4.34), W: m(1.62), H: m(1.44),
      wb: m(2.44), wr: m(0.308), tw: m(0.170), box: 0.92, grime: 0.74, clear: 0.36,
      cab: [0.242, 0.325, 0.622, 0.688], panes: 2, doors: 4, cap: 0,
      col: [0.567, 0.561, 0.540], plate: P_PLATE2, lampF: P_LAMPF, lampR: P_LAMPR,
      grille: P_GRILLE2, chrome: 1, dent: 1 },
    /* CHROMA, and the only place on the street where it is free.  Four of the
       five parked cars are the whites and silvers the reference plates
       actually show, which is right and is also why the lower half of our
       frame measures sat 0.13 against ref1's 0.187.  ONE period colour fixes a
       measurable amount of that at no cost to luma: this is the factory
       "bej" a Konya Sahin is as likely to be as white, it stands in the near
       left foreground where the shortfall is, and it lands at luma 155 --
       within 3 % of the white it replaces, so nothing in the exposure moves. */
    sahin: { nm: 'Tofas Sahin', kind: 'saloon', L: m(4.26), W: m(1.65), H: m(1.40),
      wb: m(2.51), wr: m(0.310), tw: m(0.175), box: 1.00, grime: 0.58, clear: 0.46,
      cab: [0.246, 0.324, 0.629, 0.698], panes: 2, doors: 4, cap: 1,
      col: [0.478, 0.404, 0.248], plate: P_PLATE3, lampF: P_LAMPF, lampR: P_LAMPR,
      grille: P_GRILLE2, chrome: 1, dent: 1 },
    laguna: { nm: 'dark blue 90s saloon', kind: 'saloon', L: m(4.55), W: m(1.75), H: m(1.42),
      wb: m(2.67), wr: m(0.328), tw: m(0.198), box: 0.16, grime: 0.42, clear: 0.82,
      cab: [0.215, 0.350, 0.585, 0.720], panes: 2, doors: 4, cap: 2,
      col: [0.042, 0.056, 0.122], plate: P_PLATE2, lampF: P_LAMPF2, lampR: P_LAMPR2,
      grille: P_GRILLE, chrome: 0 },
    octavia: { nm: 'Skoda Octavia', kind: 'saloon', L: m(4.66), W: m(1.81), H: m(1.46),
      wb: m(2.68), wr: m(0.324), tw: m(0.200), box: 0.36, grime: 0.14, clear: 1.0,
      cab: [0.205, 0.340, 0.590, 0.712], panes: 2, doors: 4, cap: 2,
      col: [0.654, 0.658, 0.667], plate: P_PLATE, lampF: P_LAMPF2, lampR: P_LAMPR2,
      grille: P_GRILLE, chrome: 0 },
    hatch: { nm: 'small white hatchback', kind: 'hatch', L: m(3.70), W: m(1.64), H: m(1.47),
      wb: m(2.40), wr: m(0.298), tw: m(0.175), box: 0.40, grime: 0.52, clear: 0.68,
      cab: [0.045, 0.190, 0.575, 0.730], panes: 2, doors: 2, cap: 1,
      col: [0.620, 0.623, 0.629], plate: P_PLATE2, lampF: P_LAMPF2, lampR: P_LAMPR2,
      grille: P_GRILLE, chrome: 0 },
    mpv: { nm: 'black compact MPV', kind: 'mpv', L: m(4.36), W: m(1.77), H: m(1.62),
      wb: m(2.72), wr: m(0.318), tw: m(0.195), box: 0.30, grime: 0.30, clear: 0.90,
      cab: [0.095, 0.255, 0.660, 0.812], panes: 3, doors: 4, cap: 2, rails: 1,
      col: [0.028, 0.028, 0.030], plate: P_PLATE, lampF: P_LAMPF2, lampR: P_LAMPR2,
      grille: P_GRILLE, chrome: 0 },
    doblo: { nm: 'small white panel van', kind: 'van', L: m(4.16), W: m(1.72), H: m(1.82),
      wb: m(2.57), wr: m(0.310), tw: m(0.185), box: 0.78, grime: 0.70, clear: 0.40,
      cab: [0.055, 0.135, 0.615, 0.775], panes: 1, doors: 2, cap: 0, van: 1,
      col: [0.610, 0.614, 0.622], plate: P_PLATE3, lampF: P_LAMPF2, lampR: P_LAMPR,
      grille: P_GRILLE, chrome: 0 },
    /* THE MINIBUS, _ref/ref8 and _ref/ref5: the white Transit-shaped servis
       bus that stands at every junction in the country, with the blue wave
       down its flank and a band of side glass the whole length of the body.
       Its real length is 5.6 m and the bay is 4.57 m; buildCars() shortens it
       to whatever bay + HUG allows (5.07 m, a short-wheelbase bus) rather than
       letting it hang into the running lane, and says so in the report.
       `panes: 4` is what turns the greenhouse into a window band instead of a
       cab; `box: 0.86` keeps the plan square, which is the whole silhouette. */
    transit: { nm: 'white Transit minibus', kind: 'minibus', L: m(5.30), W: m(1.70), H: m(2.24),
      wb: m(3.15), wr: m(0.352), tw: m(0.205), box: 0.86, grime: 0.62, clear: 0.52,
      /* [rear base, rear roof, front roof, screen base].  t = 0 is the TAIL.
         A minibus is a box: the roof runs almost the whole length and the
         windscreen rakes over the last 0.7 m, not the last 1.8 m -- at
         [.., 0.545, 0.905] the body came out a fastback with a two-metre
         screen, which is what made it read as a dark saloon in _shots/prz. */
      cab: [0.045, 0.115, 0.800, 0.935], panes: 4, doors: 3, cap: 0, van: 1, rails: 0,
      col: [0.658, 0.662, 0.670], plate: P_PLATE2, lampF: P_LAMPF2, lampR: P_LAMPR,
      grille: P_GRILLE, chrome: 0, swoosh: 1 },
    /* THE COURIER, off the owner's six reference photographs: a silver Ford
       Tourneo Courier (2014-2018), the only vehicle this street now parks.
       FACTORY FIGURES, checked against Ford's own EU press pack and the
       Owner's Manual rather than against the aggregator sites, which copy a
       transcription slip of the width from each other:

         length 4157   width 1764 (body) / 2060 (mirrors)   height 1723
         wheelbase 2489   front track 1494   rear track 1479
         front overhang ~870   rear overhang ~798   tyres 195/60 R15 (r 308)

       SIDE-PROFILE RECALIBRATION.  cab[] is [backlight base, rear roof,
       front roof, screen base] as fractions of L from the TAIL.  Reading the
       clean dealer profile against the axle centres puts the screen base
       compact-van proportions much closer to the front axle than a saloon's.
       The intermediate 0.595/0.735 pass pushed both screen stations too far
       rearward: the bonnet then occupied 26.5 % of the body and read as a
       sedan nose despite the correct overall length.

         0.022  the tailgate glass is 90 mm off the rearmost point
         0.040  the roof end gives the backlight its shallow rake
         0.660  the front roof/header station
         0.805  the screen base, almost over the front axle

       That leaves 0.81 m of visible bonnet ahead of the cowl and a 0.60 m
       windscreen run: short-nose, one-box proportions without making the
       windscreen a vertical bus panel.
       kind 'mpv' drops the beltline to 0.575 H, which is
       where the photographs put the glass on the tall body.
         alloy      the five-spoke wheel face (P_WALLOY) on every corner
         lampTall   upright tail clusters (P_LAMPRC) beside the tailgate
         grilleBig  the large low trapezoid grille + intake + fog pockets
         bodyBumper body-colour bumpers (the 90s cars wear grey plastic)
         darkPillars gloss-black B/C pillars, so the DLO reads as the one
                    continuous band of glass the side photos show
         slider     the black sliding-door track let into the rear quarter
         spoiler    the body-colour lip over the backlight
         roofAerial a short stub on the roof, not a 90s wing whip */
    courier: { nm: 'silver Ford Tourneo Courier', kind: 'mpv', L: m(4.157), W: m(1.764), H: m(1.723),
      /* grime 0.30 -> 0.21.  0.30 is the fleet's "stood out all winter on a
         Konya side street" number and it belongs to the 90s saloons.  This is
         the same washed car dustK 0.16 below is written for: in both side
         photographs the road film is a faint haze on the very bottom of the
         doors and behind each arch, and it never reaches the moulding.  At
         0.30 the film alone was taking the rocker line to 0.79 of the body
         colour before bodyAO's contact term even multiplied it. */
      /* 0.21 -> 0.135, the second half of the sill fix (bodyAO is the first).
         grime feeds `f = (1-yy)^2.15 * grime * 1.80`, so 0.21 put the film's
         full strength at 0.378 and took the rocker row to 0.79 of the body
         colour on its own.  01-side-owner x 790 has the rocker at 0.87 of the
         mid-door with bodyAO, SHEEN_DN and polyS's down-facing multiply ALL
         still to be paid out of that same 0.87.  0.135 lands the film's own
         share at 0.876 at the rocker and 0.971 at the mid-door -- a haze on
         the bottom of the doors that dies before the moulding, which is what
         both plates show, rather than a skirt. */
      wb: m(2.489), wr: m(0.3075), tw: m(0.195), box: 0.52, grime: 0.135, clear: 0.94,
      /* the roof is the second thing the eye checks after the silhouette, and
         the fleet's settled-dust term was painting it at 0.167 against a 0.53
         flank -- black.  This car is washed; 0.16 of the term is the film of
         road dust a clean car still carries, and no more.

         0.16 -> 0.58, WHICH IS THE OTHER HALF OF THE ROOF FIX.  0.16 was
         solved to stop the roof going BLACK and it did; what it did not do is
         stop it going white, and _shots/pp1/car.roofline.png measures the
         panel at 227 sRGB against a 148 flank -- 1.53, where the plates run
         0.85-1.14 (the numbers are written out at SHEEN_ZEN).  A dead-flat
         panel here is collecting 3x the irradiance of the door below it and
         only two terms in this file can answer that.  SHEEN_ZEN takes the
         larger share because it is the honest one for a washed car; this takes
         0.58 x 0.86 = 0.50 of the way to DUSTH, i.e. the roof's albedo drops
         0.352 -> 0.238.  That is not a filthy roof, it is the bloom a car
         standing outside a dealership carries on the one surface rain sits on,
         and 05-side-dealer -- the only plate with a camera low enough to read
         roof and door in one exposure -- shows exactly that: the roof at 160
         is BRIGHTER than the 140 door, but only by a seventh. */
      dustK: 0.58,
      cab: [0.022, 0.040, 0.660, 0.805], panes: 3, doors: 4, cap: 2, rails: 1,
      /* col x 0.85.  This is not a re-measurement, it is a MOVE OF ENERGY
         from the isotropic term to the directional one, and it has to happen
         together with SHEEN_UP.  A metallic silver returns a large part of
         its light off the flake as a view-dependent lobe, not as albedo; with
         no mirror term at all the only way to get a bright car was to make
         the albedo bright, and 0.524 x PAINT_LIFT x the 0.545 the map bakes
         at was landing the whole flank at 208-213 sRGB -- a value off a
         concrete pavement, flat across the entire panel, and with no headroom
         left for a highlight to be brighter than.  0.446 puts the door at
         ~180 and leaves the shoulder band somewhere to go.

         0.446 -> 0.392, x 0.88, AND THE MEASUREMENT THAT FIXES IT.  0.446 did
         land the mid-door at 180 sRGB, exactly as claimed -- and 180 is still
         white.  The trap is that neither of the previous two passes had a
         NEUTRAL in the reference frame to hang the number on, so both solved
         for the car's own numbers and both got a car that measures right and
         reads wrong.

         05-side-dealer is the frame that settles it, because it has a row of
         WHITE vans parked beside this car in the same light, i.e. a known
         albedo on a vertical panel two metres away:

           white van flank  (x 40-200, y 144-215)   190 sRGB  0.515 lin
           Courier door     (x 380-650, y 258-315)  130 sRGB  0.223 lin
                                                    -> ratio 0.43

         White car paint is ~0.78 diffuse, so this paint is ~0.34-0.38.  That
         is Moondust Silver: a mid grey, a shade under half a white van.  The
         same frame's paving is 76 sRGB and its tarmac 44, so the car is
         BRIGHTER than its ground and still obviously grey -- the read comes
         from the white beside it, not from the road.

         _shots/it7 had no white to lose to: mid-door 180 against a concrete
         pavement at 199 and a rendered wall at 194, i.e. the paint returning
         1.06 of the brightest large neutral in frame.  The two references put
         the same panel at 0.43 of the nearest white and at 0.95-1.00 of the
         road (01-side-owner: door 115, road 118).

         x 0.88 in scene-linear is what takes the mid-door from 180 to ~150
         sRGB through the 1.6-power grade above the knee (the arithmetic is
         written out at DUST_AMT: an output ratio costs r^0.625 of scene
         radiance, so 150/180 wants 0.876).  Together with the SHEEN_UP
         exponent narrowing above -- which is where the other ~15 % comes
         off the door and NONE of it off the shoulder -- the flank should land
         near shoulder 195 / upper door 170 / mid 150 / lower 125 / sill 95,
         which is 01-side-owner's 170/139/115/104/87 scaled by the 1.28 this
         scene is brighter than that photograph.

         The tilt is unchanged and it is the measured one: R/G 0.987, B/G
         1.023 here against 0.994 / 1.031 measured on 05-side-dealer's front
         door and 0.994 / 1.009 on 01-side-owner's rear door.  Near-neutral
         with a hair of cool in it, which is what a silver reads as against a
         warm ground under a cool sky. */
      /* 0.392 -> 0.352, AND WHY THE 0.446 -> 0.392 PASS DID NOT LAND.  That
         pass predicted the mid-door at ~150 sRGB.  MEASURED on _shots/it8:

           _shots/it8/car.side.png   front door mid (x 215-300, y 205-220)  183
                                     pavement       (x  60-200, y 330-370)  194
                                     rendered wall  (x  30-120, y  20- 60)  187

         -- the door came out at 0.94 of the brightest large neutral in frame,
         i.e. the car is the SAME VALUE as the concrete it stands on, which is
         the definition of a white van.  The x 0.88 was real but it was spent
         paying for something else that went up in the same pass (gwK 0.972 ->
         0.945 rolled the shoulder, so the whole upper half of the flank picked
         up ny and with it the sheen), and the net was +3 sRGB, not -30.

         WHAT THE NUMBER SHOULD BE.  The white-van ratio in 05-side-dealer is
         re-measured here on the file's own rects and it stands:

           white van flank  (x  40-200, y 144-215)  175 sRGB  0.427 lin
           Courier door     (x 380-650, y 258-315)  132 sRGB  0.229 lin
                                                    -> 0.535 linear, 0.75 sRGB

         White paint is ~0.75-0.78 diffuse, so this paint is 0.34-0.38.  0.392
         was ABOVE that window and 0.352 is inside it, near the middle.  The
         remaining 16 % of the cut is taken out of PAINT_LIFT (section 10),
         which is the term with the weaker claim -- see the note there.  Split
         that way, both halves of the cut have a measurement behind them and
         NEITHER of them touches SHEEN_UP, so the shoulder-to-door RANGE that
         the mirror term exists to build survives the change intact.

         Together: x 0.898 x 0.839 = x 0.753 in scene-linear on the whole
         tone.  Through the 1.6-power grade and the ACES shoulder that is
         183 -> ~150 at the mid-door and 213 -> ~190 at the shoulder crest,
         i.e. 0.77 of the pavement with a crest/door ratio of 1.27 -- against
         1.26 measured on 05-side-dealer (164/130) and 1.43 on 01-side-owner
         (175/122).  The ratio IMPROVES as the value comes down, because the
         crest was being flattened by the ACES shoulder, not by the sheen.

         The tilt is unchanged and it is still the measured one: R/G 0.987,
         B/G 1.023 against 0.994 / 1.031 on 05-side-dealer's front door and
         0.994 / 1.009 on 01-side-owner's rear door. */
      col: [0.352, 0.357, 0.365], plate: P_PLATE2, lampF: P_LAMPF2, lampR: P_LAMPR2,
      grille: P_GRILLEC, chrome: 0, alloy: 1, lampTall: 1, grilleBig: 1,
      bodyBumper: 1, darkPillars: 1, slider: 1, spoiler: 1, roofAerial: 1,
      cleanFlank: 1,
      /* the measured-curve pass, all keyed to the six reference photos:
         beltK   glass base at 1.06 m of 1.72, not the mpv default 0.99
         planK   the tailgate is 88 % of the mid-body in plan, not 85
         gwK     glazing near-FLUSH (2 cm inset) -- kills the deck shelf
         roofK   real tumblehome down to a 1.28 m roof panel
         roofCurve  the roofline's arc: -2 % H at the tail, -3.8 % at the
                 screen header, peaking behind mid-cab
         archR/archH  arch lips hugging the 195/60 within ~5 cm
         archN   13 stations per arch so the cut is a curve, not a heptagon
         bonnDrop  cowl 1.06 falling to a 0.80 m bonnet lip
         paneSplit  C pillar at the slider's trailing edge, B at the door
         quarterLift  the quarter glass 4 cm above the door glass line
         + sill cladding, low door moulding, cowl scuttle, lamp flanks,
         high rear plate, dark glazing, the lot */
      /* roofK 0.828, not 0.800: the manual's roof panel is 1.44 m across a
         1.764 m body, so gw*roofK has to land at 0.73 m of half-width.  At
         0.800 the tumblehome was steep enough to taper the backlight like a
         pyramid and to lean the side glass so far in that it never caught
         the sky -- which is half of why the DLO read as a black slab. */
      /* gwK 0.972 -> 0.945, and roofK 0.828 -> 0.852 to hold the roof panel
         exactly where it was.  0.972 reads as "a 25 mm inset from the widest
         point of the flank", but beam() has ALREADY tucked the flank back to
         0.974 of hw by the time it reaches the belt (CROWN, u^5), so the
         shoulder super-ellipse was solving between z = hw*0.974 and z =
         hw*0.972: 1.8 mm of z-travel across 152 mm of rise.  That is not a
         radius, it is a vertical wall with a crease on top of it, and it is
         why the shoulder highlight that the whole of carTone()'s SHEEN_UP term
         exists to paint had nothing to sit on -- there was no band of skin
         tilted 10-25 deg off vertical anywhere on this car.  0.945 buys 26 mm
         of z, which over the same 152 mm is a genuine quarter round and puts
         four section rows through the turn instead of one.
         It does NOT re-open the bright deck shelf the old 0.87 default
         painted, because the glass moves with it: ghwT starts at gw(t), so the
         deck's outer edge and the base of the DLO are still the SAME line.
         What changed is the corner underneath that line, not its position.
         roofK 0.852 x 0.945 = 0.8051 against the old 0.828 x 0.972 = 0.8048,
         i.e. roofHW is unmoved to a third of a millimetre and the roof panel
         is still the manual's 1.42 m. */
      beltK: 0.618, planK: 0.910, gwK: 0.945, roofK: 0.852,
      /* halfTrack: the wheel centre plane, in metres, straight off the manual
         (1494 front / 1479 rear, so 0.747).  The fleet default derives it from
         the average half-width and lands 40 mm a side further in, which is
         what sank this car's wheels into their own arches. */
      halfTrack: 0.744,
      /* archR 1.21 -> aR 372 mm.  Measured off 01-side-owner: the opening is
         210 px across at 3.55 mm/px, so 373 mm each side of the axle -- the
         lower ends come down to within a few mm of the sill, as they do in
         the photograph.  archH 1.23 puts the crown at wr*2.23 = 686 mm, i.e.
         71 mm of daylight over a 615 mm tyre, which is what the same picture
         measures (20 px).  At 1.10 it was 31 mm and the tyre was jammed into
         the lip.  archN 17: the cut is the read, and the lip, the liner and
         the skin now all share these stations (see section 2), so this one
         number controls how round the whole opening is. */
      /* shoulderK 2.35: box 0.52 would give pe = 3.20, a folded corner.  The
         Courier's shoulder is one continuous radius -- 02/04-front34 show the
         highlight running from the cant rail to the top of the door with no
         break in it at all -- and a round corner spreads that highlight over
         four rows instead of cramming it into one. */
      shoulderK: 2.35,
      /* The roof is a shallow pressed-steel arch, not a ruler-straight slab.
         It crests just behind the B-pillar and loses 34 mm at the tail header
         and 52 mm at the windscreen header.  Those are deliberately gentle
         values; the 24 mm transverse crown below adds the remaining softness
         without turning the car into a barrel. */
      roofCurve: [0.020, 0.030], roofPeak: 0.58,
      archR: 1.21, archH: 1.23, archN: 17,
      /* One uninterrupted bonnet fall.  The previous 0.070 L / 0.042 H
         leading-edge arc occupied 291 mm and flattened visibly before the
         fascia, producing a second slope/shelf above the headlamp.  The real
         Courier carries the cowl-to-nose line consistently into the front
         face; at this scale its tiny terminal roll belongs in the shading,
         not in a second silhouette segment. */
      noseK: 0.905, noseRun: 0.200, noseR: 0.024, noseD: 0,
      hoodLinear: 1,
      /* bonnDome 0.011 H = 19 mm at the crease.  See deckY(). */
      bonnDome: 0.011,
      /* The side glass does not meet the roof pressing.  The reference carries
         a substantial painted cant rail above the DLO: 160 mm roof edge to
         glass, leaving roughly 115 mm of visible silver sheet after the dark
         drip rail and bonded-window seal are accounted for. */
      bonnDrop: 0.150, dloSeal: 0.024, pillarW: 0.048, roofHeader: 0.160,
      /* the DLO, measured off 01-side-owner by fitting a 1-D projective map
         through tail / rear axle / front axle and reading the four vertical
         edges the glass band actually carries (photo x 1116, 969, 685, 424):
           dloRear   0.062  the quarter glass's trailing edge -- everything
                            aft of it is the wide BODY-COLOUR D pillar, which
                            is what closes the shape at the back.  The pane
                            used to start at 0.024, i.e. it ran round the tail
                            corner and there was no D pillar at all.
           paneSplit 0.190  C pillar (slider trailing edge; the shut at
                            +0.010 and the rail at +0.018 then land exactly
                            where the photograph puts them)
                     0.435  B pillar -- the two door handles straddle it
           dloFront  0.717  the SAIL's rear edge, i.e. where the movable door
                            glass actually begins at the belt
           dloTip    0.762  the door's own leading edge, i.e. where the DLO
                            closes.  It is NOT cab[3]=0.800: the windscreen
                            A pillar rakes further forward than the door cut,
                            and the wedge between them is the black plastic
                            sail panel the mirror is bolted to. */
      /* 0.660 -> 0.717 AND 0.745 -> 0.762, and these two are ONE change: they
         are what makes the front corner of the cabin read as three stacked
         parts instead of the single black wedge with a notch in it that
         _shots/it8/car.side and car.dlo show.  Both come off 01-side-owner,
         scanned rather than eyeballed (columns at photo x 300/340/380/420/470,
         the same projective map the rest of this block is fitted with):
           - the BODY-COLOUR A PILLAR.  The pillar quad's back edge lands on
             dloTip at the belt, and the screen's own edge is at t 0.794 there,
             so dloTip alone sets the pillar's width.  At 0.745 that was 0.049
             of L = 202 mm horizontally -- 170 mm measured square across the
             blade, which is a windscreen post off a lorry.  0.762 gives 131 mm
             horizontally / 110 mm square, against 113 mm / 95 mm where the
             same quad meets the drip rail: a near-parallel blade with the
             slight flare into the cowl that the photograph carries.
           - the SAIL.  Its base runs dloFront -> dloTip along the belt, and at
             0.660 -> 0.745 that base was 353 mm: a black triangle covering the
             whole front third of the DLO, from the beltline to the roof rail,
             which is the "dark angular void".  0.717 -> 0.762 is 187 mm, which
             is what the scan measures 100 mm above the seal (photo x 316-366).
             The sail now apexes barely past half the glass height (see the
             sail block in section 3) instead of at the header, and the 57 mm
             of DLO the old base was hiding comes back as GLASS -- which is
             where the door's clean near-vertical leading edge comes from. */
      /* The front stations move with the corrected windscreen.  At the rear,
         separate top/bottom stations chamfer the lower-rear corner of the
         quarter glass instead of cutting it as a vertical rectangle. */
      dloRear: 0.062, dloRearTop: 0.048, dloRearBot: 0.086,
      dloFront: 0.717, dloTip: 0.762, sailPanel: 1,
      paneSplit: [0.190, 0.435], quarterLift: 1, darkGlass: 1,
      sillClad: 1, doorStrip: 1, lampWrap: 1, cowl: 1, tailGlassK: 0.82,
      /* the backlight is near-RECTANGULAR in the rear three-quarter photo --
         0.82 of the greenhouse at its sill, still 0.90 at the header, and
         sitting 10 % of the tailgate's height up off the beltline so there is
         a body-colour band under it.  Keying its top width to roofK alone
         tapered it like a pyramid. */
      tailGlassT: 0.90, tailGlassLo: 0.10,
      /* THE FILLER.  Measured off 01-side-owner through the same projective
         map the DLO was fitted with (t = (1187.7 - photo_x) * 8.65e-4, which
         reproduces all four glass edges to under a pixel -- see
         _shots/flankmeas/01-quarter2.png).  The flap's circle runs photo x
         1030-1070, so its centre is t 0.120, not 0.115; and it sits 74 px =
         266 mm below the glass seal, i.e. ~850 mm off the ground, which is
         0.87 of the way from the rocker to the belt and not 0.80. */
      plateHigh: 1, fuelT: 0.120, fuelY: 0.87,
      /* THE DOOR HANDLES, off the same map (_shots/flankmeas/01-handles.png).
         The two oval pockets run photo x 595-671 and 715-792, so their centres
         are t 0.480 (front door) and t 0.376 (slider) -- they STRADDLE the B
         pillar at 0.435 by ~19 cm each way, which is exactly what the
         photograph shows.  [0.300, 0.565] put one 32 cm too far back, out on
         the quarter panel behind the slider's shut, and the other 35 cm too
         far forward, on the front wing over the wheel arch. */
      handleT: [0.376, 0.480] }
  };

  /* ---- the parametric hull -----------------------------------------------
     Four numbers decide whether a car reads as a car or as a bar of soap:

       wr    the wheel radius        a Sahin on 165/80 R13 is 0.310 m
       arch  the opening above it    the cut tops out at 0.68 m
       belt  the beltline            0.93 m -- the bottom edge of the glass
       roof  the roof                1.40 m

     The previous pass had no arch cut at all: the flank ran unbroken down to a
     sill line at 0.36 m while the tyre's outer face sat 85 mm INBOARD of it,
     so all four wheels were completely buried inside the body.  That single
     fact is most of why the fleet read as white loaves.  Here the flank stops
     at bottom(t) = max(rocker, archTop) and the wheel stands 25 mm inside the
     flank plane, where it is fully visible and throws a hard arch shadow. */
  function carShape(S) {
    /* Wbody, when buildCars() has decided the legal envelope had to pinch the
       body narrower than the factory figure: the SHEET METAL is built at the
       real width and only the collision hull keeps the clamp.  See the note
       at the clamp itself. */
    var L = S.L, W = S.Wbody || S.W, H = S.H, box = S.box;
    var hW = W * 0.5, wr = S.wr;
    var cab = S.cab;
    var tR = (L - S.wb) * 0.46 / L, tF = tR + S.wb / L;
    /* the arch cut.  archR/archH let a spec tighten the opening onto its
       tyre: the Courier's arches hug the 195/60 within ~5 cm where the 90s
       default leaves 9, and that gap is most of why its wheels looked lost. */
    var aR = wr * (S.archR || 1.30);        /* arch half-opening along x       */
    var aH = wr * (S.archH != null ? S.archH
                                   : (1.16 + 0.10 * (1 - box)));
    var rideY = wr * 0.50;                  /* floorpan                        */
    var rockY = m(0.150) + wr * 0.115;      /* the visible bottom of the flank */
    /* the waist.  A Sahin is 1.40 m tall with the base of its glass at 0.95,
       so the flat top of the body is 0.665 H -- and it is the SAME fraction on
       every saloon here, because what makes a 90s car look different is the
       shoulder radius and the tumblehome, not the height of its waist.  A van
       and an MPV carry theirs much lower relative to a very tall roof.
       beltK overrides the fraction outright: measured off the Courier
       photographs the glass base is 1.06 m of 1.72 -- 0.615, not 0.575. */
    var beltY = H * (S.beltK || ((S.van || S.kind === 'mpv') ? 0.575 : 0.665));
    var kc = S.planK || (0.790 + 0.170 * box); /* how square the TAIL plan is  */
    /* ...and the nose's own, which is a different shape entirely -- see hw().
       Defaults to the tail figure so no 90s spec changes shape. */
    var NOSEK = S.noseK != null ? S.noseK : kc;
    var NOSERUN = S.noseRun != null ? S.noseRun : 0.185;
    /* the bonnet's leading-edge radius: how far back it starts (fraction of L)
       and how far the deck falls through it (fraction of H).  Zero by default,
       because a 90s three-box really does meet its nose panel on a crease. */
    var NOSER = S.noseR || 1e-6, NOSED = S.noseD || 0;
    /* the bonnet's power dome, as a fraction of H -- see deckY().  Off by
       default: a 90s bonnet is a flat lid with a swage at the edges. */
    var DOME = S.bonnDome || 0;
    /* ---- THE SECTION.  The single most important four lines in the file.
       A flank is not a plane.  It turns under hard at the sill (a Sahin loses
       ~85 mm a side between the rubbing strip and the jacking point), carries
       a shallow crown through the door skin, and tucks back in a little at the
       waist.  beam() is that curve, keyed to ABSOLUTE height so an arch lip --
       which sits at 0.65 of the way up -- stays at full beam while the sill
       between the arches rolls away from the sky.  Without it the flank is one
       vertical plane with one normal, every quad samples the probe in the same
       place, and the paint reads as matte plaster no matter what the material
       says.  TUCK and CROWN are in units of the half width. */
    /* TUCK   the sill roll-under, at the rocker line, in half-widths
       CROWN  the tuck into the cant rail, in the TOP FIFTH of the flank only
       BARREL the crown of the DOOR SKIN itself -- see beam() */
    var TUCK = 0.104, CROWN = 0.026, BARREL = 0.018;
    var spanF = Math.max(beltY - rockY, 1e-4);
    /* shoulderK overrides the box dial outright.  box 0.52 lands pe at 3.20,
       which is a Fiat 131's folded corner; every photograph of the Courier
       shows one continuous radius from the door skin to the roof gutter with
       no crease anywhere in it, and a soft corner is also what spreads the
       shoulder highlight into a BAND instead of a one-quad sliver. */
    var pe = S.shoulderK || (2.0 + 2.3 * box); /* shoulder: 2 = round, 4.3 = crisp */
    var sh = null;
    sh = {
      L: L, W: W, H: H, hW: hW, box: box, wr: wr, tw: S.tw, cab: cab,
      tR: tR, tF: tF, aR: aR, aH: aH, rideY: rideY, rockY: rockY, roofY: H,
      beltY: beltY, spanF: spanF, pe: pe,
      panes: S.panes || 2, van: !!S.van,
      /* the wheel centre plane: the tyre's outer wall sits 25 mm inside the
         flank, which is where it is on every car in the reference plates */
      /* halfTrack, when a spec knows its own: the fleet default reconstructs
         the wheel centre plane from the average half-width, which is fine for
         a 90s saloon whose track really is inset from its widest point, and
         40 mm a side too narrow on a van built out to its arches. */
      trackH: S.halfTrack != null ? m(S.halfTrack)
                                  : hW * (0.5 * (kc + 1)) - m(0.025) - S.tw * 0.5,

      /* the plan.  A TAIL AND A NOSE ARE NOT THE SAME SHAPE and the one
         symmetric smoothstep could not say so.

         The tail keeps what it was measured at: a tailgate is a flat panel
         with a corner radius, so kc (planK 0.910) at the rearmost station
         easing out to full width by 10.5 % of L, with smooth()'s zero slope
         at t = 0 giving exactly the flat-fronted corner a tailgate has.

         The NOSE is one continuous arc from the front door shut to the badge
         and it needs three things that smoothstep cannot give at once:
           - a narrower tip.  noseK 0.845 = 1.49 m across the leading face
             against 1.77 at the door, which is what 03-front-square measures
             between the two bumper corners.
           - a LONGER run, 18.5 % of L, so the taper starts behind the lamps
             instead of turning the corner inside the last 40 cm.
           - INFINITE slope at the tip.  sqrt(f*(2-f)) is the unit quarter
             circle; smooth() leaves the end face flat and then breaks, which
             is the "boxy corner in plan" the plan shot shows, and it is half
             of why the nose read as one big triangular facet in side view --
             a flat plan corner plus a flat elevation corner IS a facet. */
      hw: function (t) {
        if (t > 0.5) {
          var f = clamp((1 - t) / NOSERUN, 0, 1);
          return hW * (NOSEK + (1 - NOSEK) * Math.sqrt(f * (2 - f)));
        }
        return hW * (kc + (1 - kc) * smooth(clamp(t / 0.105, 0, 1)));
      },
      /* the half-width MULTIPLIER of the body at local height y.

         THIS FUNCTION IS THE PAINT.  The two terms it used to have -- a cubic
         sill tuck and a quadratic waist tuck -- are both spent within 15 % of
         the flank's height, so from the top of the arch to the beltline the
         half-width moved 15 mm in 600 and the door skin was, to within a
         degree and a half, a PLANE.  A plane has one normal; one normal
         samples the sky probe in one place; and a panel that samples the sky
         in one place is matte clay no matter what roughness the material
         asks for.  That is the whole of why the body read as unpainted.

         Three terms now, and each is a measured feature of the real section
         (03-front-square, read across the front door at the mirror):

           TUCK    the sill rolls under 92 mm from the widest point.  The
                   exponent drops 3.1 -> 2.4 so the roll SPREADS over the
                   bottom third instead of hiding in the bottom eighth: that
                   band is what turns its normal down at the tarmac and gives
                   the lower body the darker value every photograph has.
           BARREL  the door skin is a shallow BARREL, crowning 16 mm proud of
                   the chord between sill and waist, widest at 0.41 of the way
                   up -- just above the moulding, which is where a pressed
                   door panel's crown always sits.  Zero at both ends by
                   construction, so it cannot fight the other two.  It is
                   DELIBERATELY small: a van door is nearly flat, and a fat
                   barrel turns the whole upper half of the flank up at the
                   sky, which paints a 40 %-tall pale slab instead of a band.
           CROWN   the flank gives 23 mm back into the cant rail, and it does
                   it as u^5 -- i.e. ENTIRELY inside the top fifth -- not as
                   the old u^2, which spread the same 20 mm over the whole
                   door and left nothing at the top.  This term is the
                   shoulder highlight: on a car whose glazing is near flush
                   (gwK 0.972) the shoulder RADIUS itself has only ~7 mm of z
                   to work with, so the panel has to have finished turning up
                   by the time it gets there.  u^5 puts a slope of -0.10 on
                   the last row against -0.04 for u^2, and with the barrel's
                   own -0.08 on top the top of the door leaves the flank at
                   ny = +0.18 -- the "peak" of the mirror band below.

         Net: the outward normal now sweeps 31 degrees between the rocker and
         the belt -- ny -0.34 at the sill (down-and-out, at the tarmac), 0 at
         two thirds of the way up the door, +0.19 at the top (up-and-out, at
         the sky).  Three different pieces of the dome, which is exactly the
         gradient a mirror-of-the-dome is supposed to show, and it is what the
         SHEEN terms in carTone() key off.  Peak beam is 1.0023 at u = 0.72,
         so the body is 4 mm wider than W across the shoulder and nowhere
         else -- inside the 50 mm the bay clamp works in. */
      beam: function (y) {
        var u = clamp((y - rockY) / spanF, 0, 1);
        /* u^0.78 puts the barrel's crest at u = 0.41 rather than 0.50 */
        var u2 = u * u;
        return 1 - TUCK * Math.pow(1 - u, 2.4) - CROWN * u2 * u2 * u
                 + BARREL * Math.sin(PI * Math.pow(u, 0.78));
      },
      /* the greenhouse is narrower than the body and leans in above the belt.
         gwK/roofK override the two insets independently: a modern one-box
         (the Courier) carries its glass nearly FLUSH with the flank -- gwK
         0.972 is a 2 cm inset -- while still rolling a real tumblehome to a
         roof at roofK of that.  The default 0.87 inset is what painted the
         bright 10 cm deck shelf under the DLO that no photograph shows. */
      gw: function (t) { return sh.hw(t) * (S.gwK || (0.845 + 0.075 * box)); },
      roofHW: function (t) { return sh.gw(t) * (S.roofK || (0.845 + 0.075 * box)); },
      /* the roofline in side view.  A roof is a shallow arc, not a plank:
         roofCurve = [rear droop, front droop] as fractions of H, eased in
         from a peak just behind mid-cab.  Everything that touches the roof
         -- panel, drip rail, pillars, screen and backlight headers, DLO
         tops -- reads this one function, so the arc cannot come apart. */
      roofYt: function (t) {
        if (!S.roofCurve) return H;
        var u = clamp((t - cab[1]) / Math.max(cab[2] - cab[1], 1e-4), 0, 1);
         var peak = S.roofPeak != null ? S.roofPeak : 0.42, d, amt;
        if (u < peak) { d = 1 - u / peak; amt = S.roofCurve[0]; }
        else { d = (u - peak) / (1 - peak); amt = S.roofCurve[1]; }
        return H - H * amt * d * d;
      },
      /* the greenhouse half-width at height y: the TUMBLEHOME.  A Sahin's
         glass leans in about 8 degrees, which is what stops the cabin reading
         as a rectangular box parked on top of the body. */
      ghw: function (t, y) {
        var d = sh.deck(t), f = clamp((y - d) / Math.max(H - d, 1e-4), 0, 1);
        return lerp(sh.gw(t), sh.roofHW(t), Math.pow(f, 1.10));
      },

      /* the deck is the primary profile -- the flat top of the body: boot lid,
         waist and bonnet.  The beltline is derived from it, never the other
         way round, so a rounded car's bonnet can fall below its waist without
         turning the shoulder chamfer inside out. */
      deck: function (t) {
        var waist = beltY;
        var boot = waist + H * (0.016 + 0.012 * box);
        /* bonnDrop: how far the bonnet falls from the waist to its leading
           edge.  The Courier's nose drops 0.26 m -- cowl 1.06, lip 0.80 --
           which the box-keyed default cannot reach. */
        var bonn = waist - H * (S.bonnDrop != null ? S.bonnDrop
                                                   : (0.010 + 0.092 * (1 - box)));
        if (t <= cab[0]) return lerp(waist, boot, smooth(clamp((cab[0] - t) / 0.10, 0, 1)));
        if (t >= cab[3]) {
          /* A short-nose van does not have a saloon's bonnet shoulder followed
             by a separate rounded prow.  Keep one constant cowl-to-tip fall;
             the front end cap supplies the final change to the vertical
             fascia.  This is opt-in so none of the older three-box cars move. */
          if (S.hoodLinear) {
            return lerp(waist, bonn,
                        clamp((t - cab[3]) / Math.max(1 - cab[3], 1e-4), 0, 1));
          }
          /* Spend the fall over the bonnet's ACTUAL run.  A fixed 0.145 of L
             worked only while the cowl sat at t=.80; after the side-profile
             correction it would finish the fall early and leave a long flat
             shelf before the nose radius. */
          var hoodEnd = NOSED > 0 ? 1 - NOSER : 1;
          var hoodRun = Math.max(hoodEnd - cab[3], 1e-4);
          var d = lerp(waist, bonn, smooth(clamp((t - cab[3]) / hoodRun, 0, 1)));
          /* THE LEADING EDGE IS A RADIUS, NOT A CORNER.  smooth() arrives at
             the lip with zero slope, so the bonnet was dead flat for its last
             125 mm and then met a vertical end cap on a knife edge: in side
             view that pair is one big triangular facet with a crease across
             it, which is exactly what _shots/it6/car.side shows.  1-sqrt(1-q^2)
             is the quarter circle that turns the deck DOWN into the cap over
             the last NOSER of the length, leaving vertically -- so the loft
             carries the corner and the cap shrinks to the flat panel between
             the lamps that the real car actually has.  NOSED 0.030 H = 52 mm
             of fall, measured off 05-side-dealer between the top of the wing
             and the highest point of the bumper skin. */
          var q = clamp((t - (1 - NOSER)) / NOSER, 0, 1);
          return d - H * NOSED * (1 - Math.sqrt(1 - q * q));
        }
        return waist;
      },
      /* the top of the flank: the shoulder RADIUS runs belt -> deck.  It was
         46 mm and a single flat chamfer, which at 1.5 m is one hard crease and
         reads as a folded sheet.  87 mm on a boxy car and 150 on a round one,
         rolled through a super-ellipse, is the highlight that says "panel". */
      belt: function (t) { return sh.deck(t) - H * (0.062 + 0.055 * (1 - box)); },
      /* the deck is crowned: a bonnet is never flat, and a 14 mm camber across
         1.5 m is the difference between a lid and a plank once the normal is
         allowed to turn (see polyS). */
      deckY: function (t, z) {
        var g = sh.gw(t), f = clamp(Math.abs(z) / Math.max(g, 1e-4), 0, 1);
        var y = sh.deck(t) + H * 0.020 * (1 - f * f);
        /* THE POWER DOME.  02-front34-right and 03-front-square both show two
           soft creases leaving the base of the A pillars and converging on the
           badge, and the panel between them is a shallow TROUGH: the highest
           line across the bonnet is the crease at about 0.60 of the half
           width, not the centreline, which is all the plain quadratic camber
           above could ever produce.  A ridge and a trough is also three
           normals across the panel instead of one, and the bonnet is the
           second-biggest flat area on the car after the roof.

           A Gaussian ridge at f = 0.60 minus a shallower Gaussian trough on
           the centreline.  It is worth 19 mm at the crest and 8 mm of dish,
           which is what a pressed steel bonnet carries -- any more and it
           reads as damage.  q fades it in from the cowl shut so the scuttle
           strip stays flat on the panel, w fades it out at the grille so it
           cannot fight the leading-edge radius in deck(). */
        if (DOME > 0 && t > cab[3]) {
          var q = smooth(clamp((t - cab[3]) / 0.09, 0, 1));
          var w = smooth(clamp((1 - t) / 0.070, 0, 1));
          var d = (f - 0.60) / 0.26, c = f / 0.34;
          y += H * DOME * q * w * (Math.exp(-d * d) - 0.42 * Math.exp(-c * c));
        }
        return y;
      },
      /* the visible bottom of the flank between the arches, dropping into the
         valance under each bumper */
      rock: function (t) {
        var e = Math.min(t, 1 - t);
        return rockY - (1 - smooth(clamp(e / 0.055, 0, 1))) * (rockY - rideY * 0.66);
      },
      /* a super-ellipse: flat-topped, near-vertical at the jambs, closing to
         the rocker line inside the last 3 % of its span */
      archTop: function (t) {
        var h = 0, k;
        for (k = 0; k < 2; k++) {
          var u = Math.abs(t - (k ? tF : tR)) * L / aR;
          if (u >= 1) continue;
          var v = (wr + aH) * Math.pow(1 - Math.pow(u, 2.1), 0.50);
          if (v > h) h = v;
        }
        return h;
      },
      bottom: function (t) {
        var r = sh.rock(t), a = sh.archTop(t);
        return a > r ? a : r;
      }
    };
    return sh;
  }

  /* the stations the flank is lofted through.  Dense across each arch, because
     the arch outline IS the read; sparse in between, where the flank is flat. */
  function carStations(sh, S) {
    var out = [0], i, k, ta;
    /* 0.952 / 0.974 / 0.9925 are NEW and they are the nose's radius: deck()
       turns the bonnet down through a quarter circle over the last 5.8 % of L
       and hw() turns the plan through another over the last 18.5 %, and at the
       old 0.938 / 0.966 / 0.986 / 1 spacing three stations had to carry both.
       Five across 241 mm is a curve; three was a chamfer with a crease in it.
       Dedup runs at 0.0045, so every one of these survives. */
    var base = [0.014, 0.034, 0.062, 0.100, 0.145, 0.245, 0.330, 0.420, 0.500,
                0.580, 0.660, 0.745, 0.840, 0.900, 0.938, 0.952, 0.966, 0.974,
                0.986, 0.9925];
    /* archN buys a spec more stations across each arch: the cut IS the read,
       and at 7 samples the Courier's tight opening came out a heptagon. */
    var nA = (S && S.archN) || (TIER === 'low' ? 7 : 9);
    for (i = 0; i < base.length; i++) out.push(base[i]);
    /* Put real stations on a shaped bonnet instead of asking the generic
       fleet table to chord across its cowl and radius.  This is especially
       visible in the Courier's true side view. */
    if (S && S.noseR) {
      var hs = sh.cab[3], he = 1 - S.noseR;
      out.push(hs, lerp(hs, he, 0.25), lerp(hs, he, 0.50),
               lerp(hs, he, 0.75), he);
    }
    for (k = 0; k < 2; k++) {
      ta = k ? sh.tF : sh.tR;
      for (i = 0; i <= nA; i++) {
        var u = -0.986 + 1.972 * i / nA;
        var t = ta + u * sh.aR / sh.L;
        if (t > 0.004 && t < 0.996) out.push(t);
      }
    }
    out.push(1);
    out.sort(function (a, b) { return a - b; });
    var ded = [out[0]];
    for (i = 1; i < out.length; i++) if (out[i] - ded[ded.length - 1] > 0.0045) ded.push(out[i]);
    return ded;
  }

  /* ---- the half-section ---------------------------------------------------
     Local (y, z) from the bottom of the flank, up over the shoulder radius,
     across the crowned deck to the centreline.  ONE polyline, so the loft is
     one continuous grid and the normal is free to turn all the way from
     pointing at the tarmac to pointing at the sky.  That turn is the whole
     job: it is what a "vertical falloff across a curved panel" IS.

     Rows are packed toward the sill and the shoulder, which is where the
     curvature -- and therefore the gradient -- actually lives. */
  /* THE TOP OF THIS TABLE MATTERS AS MUCH AS THE BOTTOM, and it did not used
     to.  The old rows ran ... 0.300, 0.450, 0.640, 0.830, 1.0: gaps of 0.19
     and 0.17 across exactly the band where beam() does its shoulder tuck.
     gridN() is a CENTRAL DIFFERENCE, so the top row's normal was averaged over
     297 mm of flank and came out at ny 0.10 where the analytic section says
     0.19 -- the curvature was there and the sampling threw half of it away.
     Two extra rows apiece, spaced so no gap in the top third exceeds 0.13. */
  var SEC_V = [0, 0.045, 0.105, 0.185, 0.285, 0.400, 0.520, 0.645, 0.765, 0.875, 1.0];
  var SEC_V_LO = [0, 0.060, 0.145, 0.265, 0.410, 0.570, 0.730, 0.875, 1.0];
  /* deck rows, as fractions of gw.  A row LANDS ON 0.60 at both tiers because
     that is where deckY() puts the bonnet's crease: sampling a ridge either
     side of its crest and never on it turns it into a flat chamfer, which is
     the same mistake the shoulder used to make.  0.66/0.34/0 -> 0.78/0.60/0.38/0
     and 0.50/0 -> 0.60/0.30/0. */
  var SEC_D = [0.78, 0.60, 0.38, 0];
  var SEC_D_LO = [0.60, 0.30, 0];
  var SHY = [], SHZ = [], SHC = [];        /* shoulder arc-length scratch      */
  function carSecRows(sh) {
    var vF = TIER === 'low' ? SEC_V_LO : SEC_V;
    var nS = TIER === 'low' ? 3 : 4;
    var dF = TIER === 'low' ? SEC_D_LO : SEC_D;
    return { vF: vF, nF: vF.length, nS: nS, dF: dF, nD: dF.length,
             n: vF.length + nS + dF.length };
  }
  /* fill `out` with [y, z] for one station.  `hwd` is the (possibly dented)
     half width at t; z is always the +z side and the caller mirrors. */
  function carSection(sh, t, hwd, R, out) {
    var belt = sh.belt(t), deck = sh.deck(t);
    var bot = Math.min(sh.bottom(t), belt - sh.H * 0.004);
    var gw = sh.gw(t), i, y, z, s, th, k = 2 / sh.pe;
    for (i = 0; i < R.nF; i++) {
      y = lerp(bot, belt, R.vF[i]);
      out[i] = [y, hwd * sh.beam(y)];
    }
    /* the shoulder: a super-ellipse corner, pe = 2 is a quarter round and 4.3
       is a Fiat 131.  Sampled by ARC LENGTH, not by angle: at pe > 3 an even
       sweep in theta puts 96 % of the rise in the first two steps and leaves a
       3 mm ledge at the top, which at 1.5 m is a sub-pixel sliver that
       speckled the whole beltline. */
    var zB = out[R.nF - 1][1], N = 14, cy = 0, cz = 0, tot = 0;
    for (i = 0; i <= N; i++) {
      th = i / N * PI * 0.5;
      y = belt + (deck - belt) * Math.pow(Math.sin(th), k);
      z = zB + (gw - zB) * (1 - Math.pow(Math.cos(th), k));
      SHY[i] = y; SHZ[i] = z;
      if (i) tot += Math.sqrt((y - cy) * (y - cy) + (z - cz) * (z - cz));
      SHC[i] = tot;
      cy = y; cz = z;
    }
    var seg = 1;
    for (i = 0; i < R.nS; i++) {
      var want = tot * (i + 1) / R.nS;
      while (seg < N && SHC[seg] < want) seg++;
      var d0 = SHC[seg - 1], d1 = SHC[seg];
      s = (d1 - d0) > 1e-9 ? (want - d0) / (d1 - d0) : 1;
      out[R.nF + i] = [lerp(SHY[seg - 1], SHY[seg], s), lerp(SHZ[seg - 1], SHZ[seg], s)];
    }
    for (i = 0; i < R.nD; i++) {
      z = gw * R.dF[i];
      out[R.nF + R.nS + i] = [sh.deckY(t, z), z];
    }
    return out;
  }

  /* the road film.  It climbs the lower body fast and is gone by the beltline,
     exactly as it is on a car that has been driven on a damp Konya street all
     winter.  PT is a mutable per-panel tint so one wing can be a mismatched
     replacement panel without needing a second tone function. */
  var PT = [1, 1, 1];
  /* ---- THE MIRROR TERM ----------------------------------------------------
     Everything else in carTone() is ALBEDO: the same number whichever way the
     panel points.  An albedo cannot produce the one thing every photograph of
     a painted car has and no render of this one had -- a bright band running
     the length of the shoulder, a mid-value door under it, and a distinctly
     darker lower body where the skin has rolled far enough under to be
     looking at the tarmac instead of at the sky.  That is not shading, it is
     a REFLECTION, and the material cannot deliver it here: paint bakes at
     metalness 0.045 (see BUILD.carpaint), so F0 is 0.056 and the specular
     lobe is under a sixteenth of what leaves the panel.  It has to be faked
     into the vertex tone, which is the same argument the settled-dust term
     above already makes and the same one the file makes for the roof.

     Keyed to ny, the world-up component of the vertex normal, which polyS
     hands us per vertex and poly per facet:

       SHEEN_UP  the sky.  sin(PI * ny^0.42) PEAKS AT ny = 0.19 and returns to
                 zero by ny = 1.  That is deliberate and it is what the
                 photographs show: the brightest thing on a parked car is not
                 the roof, it is the shoulder -- the band tilted 10-25 deg off
                 vertical, which at eye height mirrors the bright horizon-sky
                 and does it at grazing incidence where Fresnel is highest.  A
                 dead-flat roof mirrors the zenith straight down at the camera
                 and comes back DIMMER, which is why 05-side-dealer's roof is
                 darker than its cant rail.  Leaving the roof at zero also
                 keeps this term out of the dust term's way.
       SHEEN_DN  the road.  A plain power, because there is no band structure
                 down there -- the further under the panel turns the more
                 tarmac and less sky it sees, all the way to the arch lip.
                 0.26 on top of polyS's own 0.34 down-facing multiply, which
                 already carries part of this.

     HOW BIG.  Measured on 01-side-owner down the rear door, with the road
     beside it as the datum: road 112, sill 102, lower door 110, mid door 122,
     upper door 153, shoulder 179.  So the shoulder is 1.6x the road and 1.47x
     the mid-door IN sRGB, which is a factor of 2.3 in radiance, and the sill
     is 0.9x.  A +58 % / -26 % multiply on the vertex tone, with the zenith
     term below taking 22 % back off the flat panels, lands about two thirds
     of that once the grade has had it -- the rest is not available, because
     the shoulder would clip.  ---------------------------------------------- */
  /* SHEEN_ZEN: and the third piece of environment, which is the one the first
     cut of this term forgot.  A DEAD-FLAT panel does not mirror the bright
     horizon-sky at all -- from any camera above it, it mirrors the ZENITH
     straight back down, and under this overcast the zenith is the dimmest part
     of the dome as seen at normal incidence.  Without it the bonnet came out
     at 228-234 sRGB against a 168 flank and a 170 pavement: a white lid on a
     silver car, and clipping.  A cubic, so it is worth nothing on the shoulder
     (-0.4 % at ny 0.3) and all of it on the bonnet and the roof.

     0.22 -> 0.44, MEASURED, and it is the roof fault the critic reports.
     _shots/pp1/car.roofline.png (pitch -22, i.e. the camera that actually sees
     the panel):

       roof mid    (x 230-320, y 132-152)  227 sRGB
       roof rear   (x 330-450, y 130-155)  222
       front door  (x 200-280, y 240-265)  148
       rear door   (x 300-380, y 240-262)  145
                                           -> roof / flank 1.53

     Both plates put that ratio at or under 1: 02-front34-right reads the roof
     at 176-185 against a flank of 190-230, and 01-side-owner's roof edge at
     102 against a 120 door.  05-side-dealer, the only low camera of the three,
     is the highest at 160/140 = 1.14.  1.53 is off the end of the range.

     WHY THIS TERM AND NOT THE ALBEDO.  An up-facing panel in this canyon
     collects about 3x the irradiance of a vertical one (the number is measured
     out at the dust term below), and no albedo can be silver on a flank and
     grey on a roof.  The file already answers this twice -- with settled dust
     and with this term.  The dust half is a lie told about a car that is
     visibly washed in all six plates, so most of the correction goes HERE: the
     overcast dome is not uniform, the zenith is its dimmest part at normal
     incidence, and a dead-flat panel sees nothing else.  0.44 x on the tone at
     ny = 1 against 0.58 x from dustK on the same panel -- see the courier's
     dustK for the other half of the split. */
  /* SHEEN_DN 0.26 -> 0.20.  The term is right in kind and it was solved for a
     car standing on dark asphalt, but this one stands on a concrete pavement:
     the render's own ground measures 194 sRGB in car.side, and in 01-side-owner
     the sunlit concrete under the car measures 117 against a 115 mid-door.  A
     panel rolled under towards THAT is mirroring something as bright as what
     the door is mirroring, so the reflection it loses is small.  A quarter of
     the tone was a third of why the rocker line read as a black band. */
  var SHEEN_UP = 0.58, SHEEN_DN = 0.20, SHEEN_ZEN = 0.44;
  function carTone(baseY, sh, col, grime, dustK) {
    var span = sh.belt(0.5) * 0.92, i;
    /* dustK: how much of the settled-dust term this particular car gets.
       DUST_AMT 0.86 over DUSTH 0.108 takes a 0.53 silver roof down to 0.167 --
       a BLACK roof, which is what the whole fleet wanted when the street was
       six cars that had stood out all winter, and is flatly wrong for the one
       car the street parks now.  Every one of the owner's photographs shows
       the Courier's roof at least as bright as its doors, because it is a
       car somebody washes.  1 keeps the old behaviour for anything that does
       not ask; the Courier asks for 0.16. */
    dustK = (dustK == null) ? 1 : dustK;
    /* Road film is a thin layer, so it can DARKEN a white car a long way but
       it can only lighten a dark one a little -- capping the target at 1.9x
       the body colour is what stops the navy saloon growing a white skirt. */
    var tgt = [0, 0, 0], dst = [0, 0, 0];
    for (i = 0; i < 3; i++) {
      tgt[i] = Math.min(DIRT[i], col[i] * 1.9);
      /* SETTLED DUST, which is a different material from road film and has to
         be, because it goes the other way on a dark car: rain runs OFF a
         flank and sits ON a roof, so a car parked out all winter is dirtiest
         exactly where it is brightest.  1.55x rather than the film's 1.9x --
         a black MPV roof greys, it does not turn silver. */
      dst[i] = Math.min(DUSTH[i], col[i] * 1.55);
    }
    return function (p, ny) {
      var yy = clamp((p[1] - baseY) / span, 0, 1);
      /* 2.6 -> 2.15 and the cap 0.80 -> 0.88.  _ref/ref1's white Kartal runs
         191 at the belt, 150 at the bottom of the door, 140 below the rubbing
         strip and 22-52 in the sill shadow; ours ran 220/175/155/106, i.e. the
         film reached far enough but never got dark enough at the bottom.
         With the metallic specular gone this actually lands. */
      var f = Math.pow(1 - yy, 2.15) * grime * 1.80;
      if (f > 0.88) f = 0.88;
      var r = lerp(col[0], tgt[0], f), g = lerp(col[1], tgt[1], f), b = lerp(col[2], tgt[2], f);
      /* the horizontal-panel term.  An up-facing panel in this canyon receives
         3.0x what a vertical one does (measured: the money shot's kartal, roof
         scene-linear 1.42 against flank 0.47) and a photograph's response
         curve compresses that to about 1.2 -- _ref/ref1's Kartal reads 200 on
         the roof and 165 on the door.  We are not allowed to touch the grade,
         and no albedo can be white on the flank and dark on the roof, so the
         difference has to come from the one place it comes from in life:
         a parked car's roof, bonnet and boot lid are filthy.  _ref/ref4's
         white crossover measures 116-160 on the roof against 144-199 on the
         flank -- its roof is DARKER than its door. */
      if (ny > 0) {
        var d = Math.pow(clamp(ny, 0, 1), 1.35) * DUST_AMT * dustK;
        r = lerp(r, dst[0], d); g = lerp(g, dst[1], d); b = lerp(b, dst[2], d);
      }
      /* ...and the mirror.  A multiply, not a lerp: a reflection ADDS to what
         the paint already returns and scales with it, so a dark car gets the
         same shoulder band in proportion and does not grow a white stripe. */
      var sk = 1;
      /* ny^0.95, not ^0.42 and not ^0.60.  0.42 was 79 % of peak by ny = 0.05;
         0.60 was still 62 % of peak there, and MEASURED on _shots/it7's flank
         that is exactly the fault it was meant to cure: an MPV's door skin is
         3-6 deg off vertical over its whole height, i.e. ny 0.03-0.10, so the
         entire upper half of the flank was collecting 1.36-1.49 of the lift
         and the render came out shoulder 220 / upper door 212 -- a ratio of
         0.96 where BOTH photographs measure 0.82 (01-side-owner 170/139,
         05-side-dealer 161/132).  The band had eaten the door.

         0.95 keeps the crest AT THE SAME HEIGHT (the 1.32 normaliser goes to
         1.608, solved for the new lobe's max of 0.6220 at ny = 0.34) and only
         takes the skirt off it:

           ny     0.60-lobe   0.95-lobe
           0.02     1.222       1.055     the door skin: nearly nothing now
           0.05     1.364       1.162
           0.10     1.492       1.292
           0.15     1.558       1.399
           0.20     1.583       1.480
           0.30     1.550       1.571     the shoulder radius: unchanged
           0.34     1.571       1.571     crest, and it has not moved

         ny = 0.34 is 20 deg off vertical, which is where the file already
         says the band lives ("tilted 10-25 deg") and where 02/04-front34 put
         the highlight on the real shoulder. */
      if (ny > 0) {
        var nu = Math.min(ny, 1);
        /* x (1-ny)^0.9 x 1.608.  Without the taper the sin() lobe was still
           worth 15 % of peak at ny = 0.92 -- which is the RAKED BONNET, at 23
           degrees off flat -- so the horizon band and the zenith term were
           cancelling each other on the one panel that needed the zenith term
           most.  1.608 = 1 / 0.6220, the max of sin(PI*ny^0.95)*(1-ny)^0.9,
           so the crest is still worth exactly SHEEN_UP and nothing else in
           this expression had to move when the exponent did. */
        sk += SHEEN_UP * 1.608 * Math.sin(PI * Math.pow(nu, 0.95)) * Math.pow(1 - nu, 0.9)
              - SHEEN_ZEN * nu * nu * nu;
      } else if (ny < 0) sk -= SHEEN_DN * Math.pow(Math.min(-ny, 1), 0.60);
      r *= sk; g *= sk; b *= sk;
      return [r * PT[0] * PAINT_LIFT, g * PT[1] * PAINT_LIFT, b * PT[2] * PAINT_LIFT];
    };
  }
  /* WAS the exact reciprocal of the envMapIntensity cut in carPaintMaterial()
     (0.95 -> 0.72 = 1.319).  Applied to the finished tone, so it multiplies the
     paint, the road film, the settled dust and the sill floor by the same
     number and no RATIO inside carTone() moves -- which is the whole point:
     the cut is meant to land on the specular only.

     1.319 -> 1.107, AND WHY THE RECIPROCAL WAS ALWAYS TOO BIG.  The reciprocal
     is exact only if the probe is the ONLY thing lighting the paint, because
     envMapIntensity scales the probe and nothing else.  It is not: this tone is
     multiplied into a vertex colour that NZ.street.bake() has already written
     an achromatic overcast solution into (section 8), and stDay() puts its own
     key and fill on the material besides.  A full 1/0.72 therefore over-pays
     every non-probe source by 32 %, and it does it on the one object in the
     street that was already measuring brighter than the concrete behind it.

     0.72 restitution rather than 1.00 -- i.e. 1 + 0.72 x (1/0.72 - 1) = 1.107
     -- is the fraction of a parked car's diffuse that the sky probe actually
     supplies under this overcast, taken from the same 3.0x up-vs-vertical
     irradiance ratio the dust term is written against: a vertical flank in a
     canyon gets most of its light from the visible half of the dome (probe)
     and the rest from bounce off the road and the facade opposite (bake).
     x 0.839 on the finished tone.  It is a FLAT multiply, so like col it moves
     no ratio inside carTone() -- the shoulder band, the road film and the sill
     floor all keep their shape and only the level comes down.  See the note on
     the Courier's col for the other half of the cut and for the measurement
     both halves are solved against. */
  var PAINT_LIFT = 1.107;

  /* The car's own ambient occlusion against the road it stands on.  The box
     handed to NZ.street.bake() has to start above the sill (a vertex inside
     its own occluder reads as unoccluded), so the last 200 mm of body -- the
     one part a photograph shows as nearly black -- gets no shadow from it at
     all.  This is that shadow, at vertex resolution.  Measured on _ref/ref1
     the white Kartal runs 172 at the door and 40 at the sill; the film alone
     only gets to 0.6 of that. */
  function bodyAO(sh, ly) {
    var u = clamp((ly - sh.rockY) / sh.spanF, 0, 1);
    /* 0.25 + 0.75*u^0.50 -> two terms, because there are two shadows and they
       have completely different reaches.  The single power ramp was solved
       against _ref/ref1's white Kartal, which is a 90s saloon photographed
       in flat shade against a dark wall; it put 0.25 at the rocker and did not
       reach 0.90 until two thirds of the way up the door.  Stacked under
       carTone()'s road film that took the bottom 200 mm of the Courier to
       0.136 against 0.644 at the belt -- a factor of 4.7, i.e. a black skirt.
       Neither 01-side-owner nor 05-side-dealer has anything of the sort: the
       sill on both is BODY COLOUR, one stop down from the door and no more,
       and the only genuinely dark pixels are the last few centimetres above
       the tarmac and the roof of each arch.

       (a) SKY OCCLUSION.  A vertical panel low on the body sees less of the
           dome than one at the waist, but a hemisphere does not fall off
           fast: measured across the door of 05-side-dealer the loss from
           waist to sill is about a seventh, so 0.86 -> 1.00 over the whole
           flank, front-loaded with a 0.55 power.
       (b) THE CONTACT SHADOW, which is the one the bake box cannot deliver
           because a vertex inside its own occluder reads as unoccluded.  It
           is a SLOT between the sill and the road, so it is narrow and it is
           deep: 0.62 at the rocker line, gone within 17 % of the flank's
           height (150 mm).  smooth() rather than a power so it leaves the
           rocker crease with zero slope and does not band.
       Product at the rocker is 0.568 and at the belt 1.0.  MEASURED on the
       side render that came out of this: the flank runs 221 sRGB at the
       shoulder, 206 at the top of the door, 154 at the bottom of it and 117
       at the sill, against 179 / 153 / 110 / 102 down the rear door of
       01-side-owner -- the same distribution to within 4 % everywhere below
       the shoulder, where it used to be 214 / 210 / 165 / 113, i.e. flat. */
    /* 0.86 -> 0.90 (and the ramp 0.14 -> 0.10 so the belt still lands at 1.0).
       "About a seventh" was read across a door that has the car's own shut
       lines and a rubbing-strip highlight in it; re-read on 01-side-owner at
       x 790, which is clean quarter panel with no watermark and no moulding,
       the flank runs 115 at the mid-door (u 0.59) and 99 at the rocker
       (u 0.037) -- 0.861 in sRGB, a TENTH, and most of that tenth is the road
       film below.  A hemisphere really does not fall off faster than that. */
    var sky = 0.90 + 0.10 * Math.pow(u, 0.55);
    /* 0.62 -> 0.66 -> 0.82, and the reach 0.17 -> 0.115.
       MEASURED, _shots/it8/car.side.png against 01-side-owner x 790:

                            u     it8    01-side-owner
         mid door         0.59    183        115
         lower door       0.27    124        110   (0.96 of mid)
         rocker           0.08    105        100   (0.87 of mid)
         last band        0.02    116         85   (0.74 of mid)

       -- the render's bottom quarter sits at 0.57-0.68 of its mid-door where
       the photograph has 0.74-0.96.  That is the continuous dark band down the
       length of the car, and this term is the biggest single contributor to
       it: at u = 0.02 the old pair returned 0.875 x 0.673 = 0.589, i.e. it
       threw away 41 % of the tone on a row the photographs show as body colour.

       Three things already darken that same row before this one gets to it --
       carTone's road film, carTone's SHEEN_DN, and polyS's own -34 % on a
       down-facing vertex normal (beam()'s sill roll turns the rocker rows 21
       deg down).  A contact shadow between a sill and a road is real, but it
       is worth a fifth at the very bottom and not a third, and it is SHORT:
       0.115 of the flank is 100 mm, which is the "last few centimetres" both
       plates show and nothing above it.  Floor 0.82 x sky 0.90 = 0.738 at the
       rocker against 0.568 before, x 1.30 exactly where the band was. */
    var con = 0.82 + 0.18 * smooth(clamp(u / 0.115, 0, 1));
    /* (c) THE GROUND BOUNCE, and it is the term the whole function was missing.
       Re-measured on _shots/pp1/car.side.png down a clean stretch of front door
       (x 196-204, no shut line, no moulding), normalised on the mid-door at
       u = 0.59, against 01-side-owner x 790 and 05-side-dealer x 430 done the
       same way:

         u      pp1    01-side-owner   05-side-dealer
         0.50   0.92       0.98            0.94
         0.35   0.73       0.99            1.02
         0.26   0.68       0.96            0.99
         0.20   0.62       0.92            0.76
         0.15   0.58       0.91            0.74
         0.05   0.56       0.87            0.67

       Everything (a) and (b) and the road film and SHEEN_DN together can
       account for is about 0.78 of that fall; the rest is the shader doing the
       physically right thing with a sill that beam() rolls 21 deg under, and
       no amount of NOT darkening can answer it, because the answer is a term
       that goes ABOVE one.  A car stands on a lambertian sheet: the pavement in
       this frame measures 194 sRGB, brighter than the rendered facade behind
       it, and the rocker sees a large solid angle of it.  That bounce is why
       01-side-owner's rocker holds 0.87 of its mid-door with the sun overhead
       and why 05-side-dealer's -- parked on dark paving, low sun -- only holds
       0.67.  The probe here is a sky dome with no ground in it at all, so this
       is the only place the bounce can come from.

       Keyed to u and not to the normal, deliberately: the bounce reaches the
       flank because the flank is CLOSE TO the ground, and a vertical panel
       200 mm up catches it as surely as one rolled under.  1.6 power.

       REACH 0.50 -> 0.62.  At 0.50 the term did what it was built for at the
       rocker (0.56 -> 0.68 of the mid-door) but left a hole in the middle of
       the flank: pp2 measures u 0.35 at 0.76 of the mid-door where both plates
       have 0.99-1.02, because the bounce had already died and the road film
       and beam()'s roll had not.  0.62 fills it (0.79) and costs the datum
       almost nothing (+0.5 % at u = 0.474), which is why the mid-door only
       moves 144 -> ~150 -- into the middle of the 140-150 the brief asks for
       against a 195 pavement, rather than the low edge of it. */
    var bnc = 1 + 0.60 * Math.pow(1 - clamp(u / 0.62, 0, 1), 1.6);
    return sky * con * bnc;
  }

  /* a box built in the car's own frame, so it rolls with the kerb-mounted
     wheels instead of staying stubbornly axis-aligned */
  function boxT(pile, T, cx, cy, cz, hx, hy, hz, ao, tone) {
    var S = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
             [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    var C = [], i;
    for (i = 0; i < 8; i++) C.push(T(cx + S[i][0] * hx, cy + S[i][1] * hy, cz + S[i][2] * hz));
    var r = T(cx, cy, cz);
    poly(pile, [C[0], C[1], C[2], C[3]], r[0], r[1], r[2], ao, tone);
    poly(pile, [C[4], C[5], C[6], C[7]], r[0], r[1], r[2], ao, tone);
    poly(pile, [C[0], C[1], C[5], C[4]], r[0], r[1], r[2], ao * 0.72, tone);
    poly(pile, [C[3], C[2], C[6], C[7]], r[0], r[1], r[2], ao, tone);
    poly(pile, [C[0], C[3], C[7], C[4]], r[0], r[1], r[2], ao, tone);
    poly(pile, [C[1], C[2], C[6], C[5]], r[0], r[1], r[2], ao, tone);
  }
  /* the local axis directions of a transform, for orienting an atlas card */
  function dirT(T, vx, vy, vz) {
    var o = T(0, 0, 0), p = T(vx, vy, vz);
    return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  }
  function mulv(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
  /* a flat panel in the car's frame, from four local points */
  function quadT(pile, T, a, b, c, d, rx, ry, rz, ao, tone) {
    var r = T(rx, ry, rz);
    poly(pile, [T(a[0], a[1], a[2]), T(b[0], b[1], b[2]),
                T(c[0], c[1], c[2]), T(d[0], d[1], d[2])], r[0], r[1], r[2], ao, tone);
  }

  function buildCar(P, S, px, py, pz, yaw, roll, seed) {
    if (S.kind === 'mpv' && S.nm === 'silver Ford Tourneo Courier' && global.NZ_COURIER_ASSET) {
      buildBlenderCourier(S, px, py, pz, yaw, roll, seed);
      return;
    }
    var sh = carShape(S), T = mkT(px, py, pz, yaw, roll), i, j, k;
    var tone = carTone(py, sh, S.col, S.grime, S.dustK);
    /* darkGlass: the Courier's photographs show privacy-dark glazing that
       reads nearly black against silver -- two thirds of the default */
    var glassCol = S.darkGlass ? [0.100, 0.107, 0.116] : [0.155, 0.166, 0.178];
    /* rubber and satin-black plastic under a flat overcast: dark, but nowhere
       near the void black the first pass used -- a 20 mm shut line rendered at
       0.068 reads as a slot cut through the car */
    var trimDark = [0.145, 0.143, 0.140];
    var tyreCol = [0.112, 0.110, 0.105];         /* grey sidewalls, never black */
    var rimCol = [0.245, 0.244, 0.240];
    var chrome = [0.800, 0.802, 0.795];
    var cab = sh.cab, H = sh.H, L = sh.L;

    function windowPile(kind, side, paneIndex) {
      var pile = new Pile(T_GLASS);
      pile.tile(T_GLASS).macro(0);
      CAR_WINDOWS.push({
        id: 'car-' + seed + '-' + kind + (side ? '-' + side : '') +
            (paneIndex == null ? '' : '-' + paneIndex),
        kind: kind, side: side || 'centre', pane: paneIndex == null ? 0 : paneIndex,
        seed: seed + CAR_WINDOWS.length * 97, pile: pile, mesh: null
      });
      return pile;
    }

    var tyreTread = [0.098, 0.096, 0.092];
    var wheelTone = [0.62 + 0.20 * S.clear, 0.615 + 0.20 * S.clear, 0.605 + 0.20 * S.clear];
    var ONE = [1, 1, 1], PATCH = [1.15, 1.15, 1.18];
    var refX = L * 0.5, refY = sh.belt(0.5) * 0.55;

    /* ==================================================================
       1  THE HULL.  One lofted skin per side: sill -> flank -> shoulder
       radius -> crowned deck -> centreline, carried through every station,
       with ANALYTIC SECTION NORMALS.  The previous pass built the same
       surface out of three independent flat strips, so the flank had one
       horizontal normal from rocker to belt and the shoulder was a single
       hard crease.  A car under a flat overcast is a mirror of a gradient;
       a surface with one normal has no gradient to mirror, which is the
       whole of why the fleet read as plaster maquettes.
       ================================================================== */
    var TSTAT = carStations(sh, S), nT = TSTAT.length;
    var ROWS = carSecRows(sh), NJ = ROWS.n;
    var PR = [], t;
    for (i = 0; i < nT; i++) {
      t = TSTAT[i];
      PR.push({ t: t, x: t * L, hw: sh.hw(t), gw: sh.gw(t), rock: sh.rock(t),
                bot: sh.bottom(t), belt: sh.belt(t), deck: sh.deck(t) });
    }
    /* one dented wing on one car, one mismatched replacement panel on another */
    var dentT = sh.tF - 0.055, dentS = 1;
    function hwAt(p, sg) {
      if (!S.dent || sg !== dentS) return p.hw;
      return p.hw - Math.max(0, bump((p.t - dentT) / 0.085)) * m(0.070);
    }
    /* the local grid, one side at a time: LP[i][j] = [x, y, z] */
    var LP = [], sec = new Array(NJ);
    function buildGrid(sg) {
      var ii, jj, row;
      LP.length = 0;
      for (ii = 0; ii < nT; ii++) {
        carSection(sh, PR[ii].t, hwAt(PR[ii], sg), ROWS, sec);
        row = new Array(NJ);
        for (jj = 0; jj < NJ; jj++) row[jj] = [PR[ii].x, sec[jj][0], sg * sec[jj][1]];
        LP.push(row);
      }
    }
    /* the grid normal at (i, j), in the car's own frame.  Central differences
       along the station and along the section, crossed, then pointed away from
       the spine so a concave sill cannot flip. */
    var _n = [0, 0, 0];
    function gridN(ii, jj) {
      var i0 = ii > 0 ? ii - 1 : ii, i1 = ii < nT - 1 ? ii + 1 : ii;
      var j0 = jj > 0 ? jj - 1 : jj, j1 = jj < NJ - 1 ? jj + 1 : jj;
      var a = LP[i0][jj], b = LP[i1][jj], c = LP[ii][j0], d = LP[ii][j1];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var vx = d[0] - c[0], vy = d[1] - c[1], vz = d[2] - c[2];
      var nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
      var ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(ln > 1e-12)) { _n[0] = 0; _n[1] = 1; _n[2] = 0; return _n; }
      nx /= ln; ny /= ln; nz /= ln;
      var p = LP[ii][jj];
      /* the spine: on the centreline, a little below the deck */
      if (nx * 0 + ny * (p[1] - sh.beltY * 0.55) + nz * p[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      _n[0] = nx; _n[1] = ny; _n[2] = nz;
      return _n;
    }
    function wN(ii, jj) {
      var n = gridN(ii, jj);
      return dirT(T, n[0], n[1], n[2]);
    }

    P.body.tile(T_PAINT).macro(0);
    var Q = [null, null, null, null], QN = [null, null, null, null], QA = [1, 1, 1, 1];
    for (j = 0; j < 2; j++) {
      var sg = j ? 1 : -1;
      buildGrid(sg);
      for (i = 0; i < nT - 1; i++) {
        PT = (S.patch && sg > 0 && PR[i].t > sh.tF - 0.115 && PR[i + 1].t < 0.955)
             ? PATCH : ONE;
        for (k = 0; k < NJ - 1; k++) {
          var pa = LP[i][k], pb = LP[i + 1][k], pc = LP[i + 1][k + 1], pd = LP[i][k + 1];
          /* the flank collapses to nothing where an arch eats it; skip the
             degenerate band rather than emitting a sliver */
          if (Math.abs(pa[1] - pd[1]) < 1e-5 && Math.abs(pa[2] - pd[2]) < 1e-5 &&
              Math.abs(pb[1] - pc[1]) < 1e-5 && Math.abs(pb[2] - pc[2]) < 1e-5) continue;
          Q[0] = T(pa[0], pa[1], pa[2]); Q[1] = T(pb[0], pb[1], pb[2]);
          Q[2] = T(pc[0], pc[1], pc[2]); Q[3] = T(pd[0], pd[1], pd[2]);
          QN[0] = wN(i, k); QN[1] = wN(i + 1, k);
          QN[2] = wN(i + 1, k + 1); QN[3] = wN(i, k + 1);
          QA[0] = bodyAO(sh, pa[1]); QA[1] = bodyAO(sh, pb[1]);
          QA[2] = bodyAO(sh, pc[1]); QA[3] = bodyAO(sh, pd[1]);
          polyS(P.body, Q, QN, QA, tone);
        }
        /* the rocker return, tucking under to the floorpan.  Flat on purpose:
           the sill's bottom edge is a real crease. */
        quadT(P.body, T, [PR[i].x, PR[i].rock, sg * hwAt(PR[i], sg) * sh.beam(PR[i].rock)],
              [PR[i + 1].x, PR[i + 1].rock, sg * hwAt(PR[i + 1], sg) * sh.beam(PR[i + 1].rock)],
              [PR[i + 1].x, sh.rideY, sg * PR[i + 1].hw * 0.70],
              [PR[i].x, sh.rideY, sg * PR[i].hw * 0.70],
              refX, sh.rideY + 0.6, 0, 0.30, tone);
      }
      PT = ONE;
      /* the two end faces, closed off the section outline so the boot lid and
         the bonnet meet the tail and nose panels on a real crease.

         THE REF MUST BE IN THE SAME SPACE AS THE POINTS.  `fp` is built by
         running every outline vertex through T(), so it is in WORLD units --
         and the ref handed with it used to be the LOCAL (L*0.5, refY, 0).
         In this bay that is a point several hundred units away on the far
         side of the street, so poly()'s "point the facet away from the ref"
         test resolved to the SAME direction for both caps: whichever end of
         the car faced away from it came out inverted and was culled by
         carpaint's default FrontSide.  Here it was the NOSE, and the render
         showed the road and both front wheel wells straight through the face.
         One T() call fixes both caps for any yaw and any roll: the midpoint
         of the car really is inside the solid, seen from either end. */
      var eref = T(L * 0.5, refY, 0);
      for (i = 0; i < 2; i++) {
        var ei = i ? nT - 1 : 0, fp = [], jj;
        for (jj = NJ - 1; jj >= 0; jj--) fp.push(T(LP[ei][jj][0], LP[ei][jj][1], LP[ei][jj][2]));
        for (jj = 0; jj < NJ - 1; jj++) {
          var mp = LP[ei][jj];
          fp.push(T(mp[0], mp[1], -mp[2]));
        }
        if (sg > 0) poly(P.body, fp, eref[0], eref[1], eref[2], 0.94, tone);
      }
    }
    /* the floorpan, which is only ever seen as a dark line under the sill */
    quadT(P.trim, T, [L * 0.08, sh.rideY, -sh.hW * 0.70], [L * 0.92, sh.rideY, -sh.hW * 0.70],
          [L * 0.92, sh.rideY, sh.hW * 0.70], [L * 0.08, sh.rideY, sh.hW * 0.70],
          L * 0.5, H * 0.5, 0, 0.30, [0.030, 0.030, 0.030]);

    /* ==================================================================
       2  THE ARCHES AND THE WHEELS.  A car with no visible wheel is a bar
       of soap; the wheel is only visible if something is cut out of the
       flank for it to sit in, and it only reads as inset if the well
       behind it is dark.
       ================================================================== */
    /* THE LIP.  The wing does not stop at a knife edge: it rolls over and
       turns in, and in 01-side-owner that turned edge is a distinct bright
       band right round the top of each opening.  At the old 28 mm it was
       under a pixel wide at any distance the car is actually seen from.  It
       may not turn in further than the clear air between the flank and the
       tyre's outer wall (hw 0.867 - zO 0.842 = 26 mm) PLUS the 70 mm the
       arch clears the tread by, or it would slice the sidewall. */
    var LIPW = m(0.038), WELLD = m(0.185);
    /* THE LINER FLARE.  The previous pass tapered the well IN by 14 % as it
       ran inboard, and that did two fatal things.  (a) The back wall came out
       14 % smaller than the opening, so a crescent of raw BACKGROUND showed
       round the top of every arch: the red-brown "ring" in
       _shots/it3/car.wheel.png is A-BLOK's brick wall seen straight through
       the wing.  (b) A tube that tapers inboard has facets that face
       UP-and-INBOARD over the top of the arch -- away from any camera above
       the axle -- so they were backface-culled and covered nothing anyway.
       Flaring OUT by 3 % makes the back wall's silhouette strictly CONTAIN
       the opening, so the arch cannot leak from any angle. */
    var WELLF = 1.03;
    /* the liner is dark, but it is a SURFACE, not a hole.  At 0.045 x 0.20 ao
       it arrived at 0.009 -- darker than any pixel in the six photographs --
       and a black shape inside a body panel reads as a hole punched through
       the car.  A galvanised inner wing under Konya overcast sits at about a
       sixth of the flank's value, which is where this lands after ao. */
    var wellCol = [0.132, 0.130, 0.126];
    /* THE LIP'S OWN TONE.  poly() hands carTone the facet's up-facing-ness,
       and over the crown of the opening the lip ribbon is dead flat, ny = +1
       -- the full settled-dust term.  That painted a warm BROWN line round
       the top of each arch, which is the second half of what read as a
       "reddish ring" in _shots/it3.  A 38 mm rolled edge on the underside of
       a wing does not collect dust the way a bonnet does, so damp ny to a
       fifth and let it come out as the bright silver edge 01-side-owner
       shows.  Nothing else in the file may see the damped value. */
    var lipTone = function (p, ny) { return tone(p, ny * 0.20); };
    P.trim.tile(T_TRIM).macro(0);
    /* THE STATIONS.  The lip's outer edge has to be VERTEX-IDENTICAL to the
       bottom edge of the lofted skin.  When the two are sampled on different
       u-grids they cut different chords across the same super-ellipse, and
       every place the skin's chord sits higher than the lip's is a slot
       straight through the car.  So take the loft's OWN station list --
       carStations() is pure, so calling it a second time costs one array on
       the one car in the scene -- and keep the entries inside this arch.
       archN alone now controls how round the opening is: raise it and skin,
       lip and liner all get denser together and stay welded. */
    var ARCT = carStations(sh, S);
    for (k = 0; k < 2; k++) {
      var ta = k ? sh.tF : sh.tR, ax = ta * L, ay = sh.wr * 0.94;
      var arc = [], aSpan = sh.aR / L;
      for (i = 0; i < ARCT.length; i++) {
        var tt = ARCT[i];
        if (tt < ta - aSpan || tt > ta + aSpan) continue;
        var ty = sh.bottom(tt);
        /* the lip has to start ON THE SKIN.  hw() is the beam at the widest
           point; down at the jambs the section has already tucked 10 % in, so
           a lip at hw() stood out as a flange all round the bottom of the
           opening and the wheel read as falling off the car. */
        arc.push({ x: tt * L, y: ty, hw: sh.hw(tt) * sh.beam(ty) });
      }
      var nA = arc.length - 1;
      for (j = 0; j < 2; j++) {
        var sg2 = j ? 1 : -1, inner = [];
        for (i = 0; i <= nA; i++) {
          var q = arc[i];
          inner.push([ax + (q.x - ax) * WELLF, ay + (q.y - ay) * WELLF,
                      sg2 * (q.hw - LIPW - WELLD)]);
        }
        for (i = 0; i < nA; i++) {
          var c1 = arc[i], c2 = arc[i + 1];
          /* the painted lip turning in off the flank.  ao 0.90 against the
             skin's ~0.83 at this height: over the top of the opening this
             ribbon faces the sky, and it is the one highlight that tells the
             eye the wing has thickness rather than being cut from paper.
             THE OVERLAP.  Its outer edge is grown 10 mm radially and stood
             4 mm proud instead of being laid exactly on the skin's bottom
             row.  Sharing a mathematically identical edge with the loft still
             left a one-pixel warm line all round the opening -- A-BLOK's
             brick wall behind the car -- because the two quads reach that
             edge from different triangles and the rasteriser is free to drop
             the shared sample.  10 mm is 3 px on the wheel close-up, which is
             wider than any crack can be, and an arch lip IS the widest point
             of the wing in section, so a wing that stands proud of its own
             door skin is what the sheet metal does anyway. */
          var e1 = 1 + m(0.010) / (Math.sqrt((c1.x - ax) * (c1.x - ax) +
                                             (c1.y - ay) * (c1.y - ay)) || 1);
          var e2 = 1 + m(0.010) / (Math.sqrt((c2.x - ax) * (c2.x - ax) +
                                             (c2.y - ay) * (c2.y - ay)) || 1);
          quadT(P.body, T,
                [ax + (c1.x - ax) * e1, ay + (c1.y - ay) * e1, sg2 * (c1.hw + m(0.004))],
                [ax + (c2.x - ax) * e2, ay + (c2.y - ay) * e2, sg2 * (c2.hw + m(0.004))],
                [c2.x, c2.y, sg2 * (c2.hw - LIPW)], [c1.x, c1.y, sg2 * (c1.hw - LIPW)],
                ax, ay, 0,
                /* ao TRACKS THE SKIN.  A flat 0.90 all round the opening is
                   right over the crown, where the neighbouring flank is also
                   near the top of bodyAO's ramp -- and badly wrong down at the
                   jambs, where the skin has fallen to ~0.57 and the road-film
                   term in carTone is at its warmest.  A 0.90 ribbon there came
                   out BRIGHTER and BROWNER than the wing beside it: a thin
                   warm line tracing the whole arch, which is what still read
                   as "reddish" after the leak itself was closed.  Ride the
                   same ramp the flank does and take 14 % over it. */
                Math.min(1, bodyAO(sh, (c1.y + c2.y) * 0.5) * 1.14), lipTone);
          /* the liner running inboard behind it.  Its ref has to sit
             radially OUTSIDE the segment, at the segment's own depth -- a ref
             at the hub makes poly() point every facet AWAY from the wheel,
             i.e. into the sheet metal, and the whole liner vanishes.  Out
             here the facets turn to face the tyre, which is what makes the
             jambs read as a pocket you are looking into. */
          var mrx = (c1.x + c2.x) * 0.5 - ax, mry = (c1.y + c2.y) * 0.5 - ay;
          var mrr = Math.sqrt(mrx * mrx + mry * mry) || 1, mrk = 1 + m(0.30) / mrr;
          quadT(P.trim, T, [c1.x, c1.y, sg2 * (c1.hw - LIPW)], [c2.x, c2.y, sg2 * (c2.hw - LIPW)],
                [inner[i + 1][0], inner[i + 1][1], inner[i + 1][2]],
                [inner[i][0], inner[i][1], inner[i][2]],
                ax + mrx * mrk, ay + mry * mrk,
                sg2 * ((c1.hw + c2.hw) * 0.5 - LIPW - WELLD * 0.5), 0.62, wellCol);
        }
        /* the inner wing panel closing the hole.  This is what you actually
           see round the top of the tyre: the liner's own facets face down
           there and a camera above the axle cannot see them. */
        var disc = [], rp = T(ax, ay, 0);
        for (i = 0; i <= nA; i++) disc.push(T(inner[i][0], inner[i][1], inner[i][2]));
        poly(P.trim, disc, rp[0], rp[1], rp[2], 0.38, wellCol);
      }
    }

    var trackH = sh.trackH, wr = S.wr, tw = S.tw;
    /* WSEG.  At 14 the tyre's silhouette was a visible polygon in
       _shots/it3/car.wheel.png: the chord sag is wr*(1 - cos(pi/14)) = 7.7 mm,
       which is 2.5 px on that close-up and reads as a hubcap bolted to a stop
       sign.  32 takes it to 1.5 mm, under half a pixel even on the wheel
       close-up, and this is a software rasteriser with exactly ONE car in the
       scene -- 4 x ~150 extra triangles buys the single most obvious "not
       real" tell on the whole model. */
    /* the LOW tier gets 24, not the old 10.  The street's own diagnostic
       renders come out at tier=low, and that is the tier the octagon was
       actually reported on: a tyre is the one round thing on this car and a
       cheaper tier is not allowed to make it a stop sign.  The saving a
       10-sided tyre buys is 4 x 56 triangles on the single car in the scene,
       which is less than one shop sign. */
    var WSEG = TIER === 'low' ? 24 : 32;
    /* THE RUBBER'S GRAIN.  P.trim's world-space repeat is T_TRIM = 0.5 m,
       and a 615 mm tyre is barely one tile across: the trim map's blobs
       arrived 120 mm wide and the carcass read as a ring of cobblestones
       (_shots/w1/car.wheel.png).  Rubber is a fine matte grain.  0.13 m puts
       ~4.7 repeats across the tyre, which at the wheel close-up is a speckle
       and at street distance is flat black, which is what a tyre is.
       Section 4 re-sets this pile on its first line, but restore it at the
       end of the loop anyway so this block cannot leak state. */
    P.trim.tile(m(0.13)).macro(0);
    var ux = dirT(T, 1, 0, 0), uy = dirT(T, 0, 1, 0);
    for (i = 0; i < 4; i++) {
      var frontW = i < 2;
      var wx = (frontW ? sh.tF : sh.tR) * L;
      var ws = (i % 2) ? 1 : -1;
      var zc = ws * trackH, zO = zc + ws * tw * 0.5, zI = zc - ws * tw * 0.5;
      /* 195/60 R15: 615 mm over the tread, 381 mm at the bead.  So the matte
         black sidewall is a 117 mm band -- more than a third of the radius --
         and on this car the TYRE is a big part of the read, not a thin ring
         round a big wheel.  fr is the alloy's half-size; the atlas tile draws
         its disc at 0.96 of the cell, so the silver ends at 0.96*fr and the
         rubber has to close down onto THAT number. */
      var capped = (S.cap === 2) || (S.cap === 1 && i !== 3);
      var fr = wr * (capped ? 0.700 : 0.660);   /* silver reads 0.672 wr = 413 mm */
      var shou = tw * 0.16;                     /* 133 mm tread of a 195 section  */
      var A = T(wx, wr, zI), A1 = T(wx, wr, zI + ws * shou);
      var B = T(wx, wr, zO), B1 = T(wx, wr, zO - ws * shou);
      /* the tread band, and a sidewall at each end.  The sidewalls used to
         stop at wr*0.905 = 278 mm with cap=false, which left an 80 mm annular
         HOLE round the alloy on the outboard face: you looked straight past
         the rim into the wheel well, and that dark ring round the disc is
         most of why the wheels read as sunk and undersized.  They now close
         down to just inside the silver, so the bead laps the flange the way
         a mounted tyre does. */
      tube(P.trim, A1[0], A1[1], A1[2], B1[0], B1[1], B1[2], wr, WSEG, 0.86, false, tyreTread);
      tube(P.trim, A[0], A[1], A[2], A1[0], A1[1], A1[2], fr * 0.94, WSEG, 0.60, false, tyreCol, wr);
      tube(P.trim, B[0], B[1], B[2], B1[0], B1[1], B1[2], fr * 0.94, WSEG, 0.80, false, tyreCol, wr);
      /* the rim drum, capped at both ends and run the full width of the tyre,
         so no angle can see through the hub into the liner */
      var R0 = T(wx, wr, zI + ws * tw * 0.12), R1 = T(wx, wr, zO - ws * tw * 0.07);
      tube(P.trim, R0[0], R0[1], R0[2], R1[0], R1[1], R1[2], wr * 0.615, WSEG, 0.74, true,
           [rimCol[0] * (0.62 + 0.38 * S.clear), rimCol[1] * (0.62 + 0.38 * S.clear),
            rimCol[2] * (0.62 + 0.38 * S.clear)]);
      /* the face: a plastic trim on some wheels, bare steel on the rest --
         and one missing trim per car, which is what dates a Sahin.  Sat only
         35 mm of section inboard of the outer wall, so the rubber's inner lip
         (which is 6 mm proud of it) laps its edge and nothing can leak. */
      var fc = T(wx, wr, zO - ws * tw * 0.035);
      P.panel.macro(0);
      /* the wheel face is read from OUTBOARD, which is +z on one side of the
         car and -z on the other: without the facing hint half the fleet had
         its wheel discs wound backwards and normalled into the hub */
      card(P.panel, fc[0], fc[1], fc[2],
           ux[0] * fr, ux[1] * fr, ux[2] * fr, uy[0] * fr, uy[1] * fr, uy[2] * fr,
           PANEL.rect[capped ? (S.alloy ? P_WALLOY : P_WCAP) : P_WHEEL],
           wheelTone, 0.84, dirT(T, 0, 0, ws));
      STATS.props++;
    }
    P.trim.tile(T_TRIM).macro(0);   /* hand the pile back at street scale */

    /* NO CONTACT-SHADOW DECAL ANY MORE.  The previous pass painted a P_SHADOW
       quad on the road under every car, because bake() could not: the road is
       nz-street-ground.js's geometry and it is baked from GROUND's own hook,
       three hooks before a car exists.  nz-street-sky.js now keeps a shared
       occluder registry and REPLAYS every box that arrives late against every
       geometry already baked, so the body box registered below reaches the
       road on its own.  Painting a decal as well would darken the tarmac
       twice -- and the decal's normal pointed DOWN, so it was also the one
       surface in the street lit from underneath. */

    /* ==================================================================
       3  THE GREENHOUSE.  A separate object from the body: a beltline, a
       raked windscreen and a differently raked backlight, A/B/C pillars,
       side glass in separate panes and a distinct roof panel.  The glass
       is opaque and dark and the frames stand 12 mm proud of it, so
       nothing can z-fight and the pillars read as pillars.
       ================================================================== */
    var c0 = cab[0], c1 = cab[1], c2 = cab[2], c3 = cab[3];
    var yC0 = sh.deck(c0), yC3 = sh.deck(c3);
    /* the roof is a CURVE now (sh.roofYt); yR remains as the rear/front
       header heights so every straight quad that once used the constant
       reads the arc at its own station instead */
    var yR1 = sh.roofYt(c1), yR2 = sh.roofYt(c2);
    var gwC0 = sh.gw(c0), gwC1 = sh.gw(c1), gwC2 = sh.gw(c2), gwC3 = sh.gw(c3);
    var rwC1 = sh.roofHW(c1), rwC2 = sh.roofHW(c2);
    var PROUD = m(0.012);
    var PW = S.pillarW ? m(S.pillarW) : m(0.062 + 0.034 * (1 - sh.box));
    /* RAILD: the depth of the drip rail, hoisted out of the rail's own loop
       because the A and D pillars now have to know it.  Both of them used to
       run their top edge up to the ROOFLINE, which is where the rail's TOP
       edge is; and both of them LEAN, so a few centimetres below that edge
       they stand ~9 mm proud of the rail and paint it out in body colour.
       That is why the dark gutter stopped short at each end of the roof and
       the roof, the header and the pillar ran together into one bright wedge.
       They are capped at the rail's UNDERSIDE instead, so the rail crosses
       them -- which is what a drip moulding physically does. */
    var RAILD = H * 0.020;
    /* Vertical roof-edge-to-side-glass distance.  This is deliberately a
       metric dimension rather than a fraction of H: the cant rail is a
       pressed-steel section, and on the Courier it measures about 16 cm all
       along the doors.  Specs without the key retain the old roof-to-glass
       geometry. */
    var HEADERD = S.roofHeader ? m(S.roofHeader) : 0;
    var glassDust = [glassCol[0] * (1 + S.grime * 0.55), glassCol[1] * (1 + S.grime * 0.52),
                     glassCol[2] * (1 + S.grime * 0.46)];
    /* Under a flat overcast side glass is dark, but it is NOT a black slab:
       it is nearly vertical, so it mirrors the horizon -- the render on the
       building opposite -- low down, and the sky itself where the tumblehome
       leans it back at the top.  _ref/ref1 measures the Kartal's DLO at 59-79
       against 172 on the door, and it clearly carries that vertical ramp.  A
       single flat tone is what made the greenhouse read as a hole. */
    /* gTint: the PER-PANEL privacy tint, set immediately before each emit and
       read by glassTone while quadT/polyS walk that panel's vertices.  The
       photographs show three different glasses on this car -- a clear screen,
       lightly tinted front door glass, and properly dark privacy glass from
       the B pillar back -- and drawing all of them at one value is what made
       the whole upper body one flat shape. */
    var gTint = 1, gRamp = 6.5;
    function glassTone(p) {
      var f = clamp((p[1] - (py + sh.deck(0.5))) / Math.max(H - sh.deck(0.5), 1e-4), 0, 1);
      /* HOW MUCH RAMP IT TAKES.  Measured off the render, not guessed: a 4x
         albedo swing up the DLO came back as 45-72 of 255, i.e. 1.47x, which
         solves to pixel = 0.038 + 0.109*albedo in linear.  Two thirds of what
         you see on side glass is a specular floor that does not scale with the
         vertex colour at all, so to move the top of the pane from 58 to ~97 the
         albedo has to reach 0.7 -- absurd as a physical glass albedo, correct
         as the paint-by-numbers device this vertex colour actually is.
         f^1.5 keeps the lift in the top third, where a real pane picks up the
         sky; the bottom two thirds stay at the street's own darkness. */
      var g = gTint * (0.30 + gRamp * Math.pow(f, 1.5));
      return [glassDust[0] * g, glassDust[1] * g, glassDust[2] * g];
    }
    /* the gloss-black B and C pillars.  They have to be BLACK -- that is the
       car's side signature -- but not the SAME black as the glass beside them,
       or the band has no structure in it at all.  A shallower ramp than the
       glass's does it: level with the panes at the sill, less than a third of
       them under the drip rail, so the uprights appear out of the band exactly
       where the glass starts mirroring the sky. */
    var pillarBase = [0.038, 0.039, 0.041];
    function pillarTone(p) {
      var f = clamp((p[1] - (py + sh.deck(0.5))) / Math.max(H - sh.deck(0.5), 1e-4), 0, 1);
      var g = 0.88 + 1.30 * f;
      return [pillarBase[0] * g, pillarBase[1] * g, pillarBase[2] * g];
    }
    P.glass.tile(T_GLASS).macro(0);

    /* the roof panel: CROWNED across its width, and narrower than the waist,
       because a roof that is a flat rectangle the width of the body is the
       loudest single tell of a box with wheels */
    var nRC = TIER === 'low' ? 3 : 4, rc;
    var RQ = [null, null, null, null], RN = [null, null, null, null];
    function roofRW(tt) {
      return lerp(sh.roofHW(c1), sh.roofHW(c2), clamp((tt - c1) / ((c2 - c1) || 1e-6), 0, 1));
    }
    /* THE CROWN HAS TO CLOSE AT BOTH HEADERS, and until it did there was a
       45 mm SLOT across the front of the roof.  The roof is crowned by
       H*0.026 = 45 mm at the centreline; the windscreen's top edge and the
       backlight's top edge are both straight lines at roofYt(c2) / roofYt(c1)
       -- they have to be, they are the top of a flat quad -- so the lens
       between the crowned roof edge and the flat glass edge was open to the
       cabin, and from any camera above the waist you looked through it at the
       car's own dark interior.  That is the dark line across the front of the
       roof in front34b.  Tapering the crown to zero over the last 3 % of the
       cab length lands the roof's end sections exactly on those two straight
       lines -- 45 mm of camber given up in the last 130 mm of a 2.7 m roof,
       which is invisible -- and costs two extra loft stations, below. */
    /* ...BUT 45 mm OF CAMBER GIVEN UP IN 82 mm IS ITSELF A FAULT, and it is
       the one _shots/it7 shows.  The taper above closed the slot by ramping
       the whole crown away over 3 % of the cab length: at the centreline that
       is a 51 mm fall across 82 mm of x -- a 32 deg ramp across the full width
       of the front of the roof, facing up and forward.  From any camera ahead
       of the screen (car.dlo, front34b) you look straight into it and it
       renders as a bright wedge of card laid on the roof, and in side view its
       silhouette is a 51 mm notch punched in the roofline right where the A
       pillar lands.  Two changes, and they are one change:
         - the camber comes down from H*0.026 (45 mm) to H*0.014 (24 mm).  A
           Courier's roof is a panel with a rain camber, not a barrel; 24 mm
           across a 1.42 m roof is the 1.9 % the pressing actually carries, and
           roofN's own tilt at the edge -- 3.9 deg -- is all the normal
           variation a flat panel is allowed anyway.
         - it closes over 13 % of the cab length (357 mm) instead of 3 %, and
           it closes through smooth(), so both ends arrive at the header with
           ZERO SLOPE.  24 mm over 357 mm is 3.8 deg at its steepest and there
           is no crease anywhere in it, which is what "one clean corner" at the
           header means.  The crown is still at full value over 74 % of the
           roof, so the panel is not a plank.
       RSPL below carries two extra stations so the eased taper is sampled
       rather than chorded. */
    var RTAP = (c2 - c1) * 0.13;
    function roofCrown(f) { return H * 0.014 * (1 - f * f); }
    function roofTap(tt) {
      return smooth(clamp((tt - c1) / RTAP, 0, 1)) * smooth(clamp((c2 - tt) / RTAP, 0, 1));
    }
    function roofPt(tt, f) {
      return [tt * L, sh.roofYt(tt) + roofCrown(f) * roofTap(tt), roofRW(tt) * f];
    }
    /* the shading normal reads the UNTAPERED crown on purpose: the taper is a
       geometric seal, and letting it flatten the normal as well would put a
       band of differently-lit roof across the header 130 mm wide */
    function roofN(tt, f) {
      var dy = roofCrown(f + 0.02) - roofCrown(f - 0.02), dz = roofRW(tt) * 0.04;
      var ln = Math.sqrt(dy * dy + dz * dz) || 1;
      return dirT(T, 0, dz / ln, -dy / ln);
    }
    /* the roof is lofted through internal stations so roofYt's arc shows in
       silhouette; on a flat-roofed spec the extra stations are colinear and
       cost nothing but the tris.  The two RTAP stations are where the crown
       closes onto the headers -- without them the taper would be spread over
       a whole 0.55 m loft band and the roof would read as a plank. */
    /* nine stations, not seven.  RTAP is now 13 % of the cab at each end and
       the taper inside it is a smoothstep, so a single band across it would
       chord the ease off and put back exactly the crease the ease exists to
       remove; c1+RTAP*0.42 and c2-RTAP*0.42 sit on the steepest part of each
       ease.  0.28 / 0.42 / 0.62 carry roofYt's own arc through the middle.
       Sixteen extra quads a car. */
    var RSPL = S.roofCurve
      ? [c1, c1 + RTAP * 0.42, c1 + RTAP, lerp(c1, c2, 0.28), lerp(c1, c2, 0.42),
         lerp(c1, c2, 0.62), c2 - RTAP, c2 - RTAP * 0.42, c2]
      : [c1, c2];
    for (i = 0; i < 2; i++) {
      var rs2 = i ? 1 : -1;
      for (var rq2 = 0; rq2 < RSPL.length - 1; rq2++) {
      var rta = RSPL[rq2], rtb = RSPL[rq2 + 1];
      for (rc = 0; rc < nRC; rc++) {
        var f0 = rs2 * rc / nRC, f1 = rs2 * (rc + 1) / nRC;
        var ra0 = roofPt(rta, f0), ra1 = roofPt(rta, f1);
        var rb0 = roofPt(rtb, f0), rb1 = roofPt(rtb, f1);
        RQ[0] = T(ra0[0], ra0[1], ra0[2]); RQ[1] = T(rb0[0], rb0[1], rb0[2]);
        RQ[2] = T(rb1[0], rb1[1], rb1[2]); RQ[3] = T(ra1[0], ra1[1], ra1[2]);
        RN[0] = roofN(rta, f0); RN[1] = roofN(rtb, f0);
        RN[2] = roofN(rtb, f1); RN[3] = roofN(rta, f1);
        polyS(P.body, RQ, RN, 1.0, tone);
      }
      }
    }

    /* windscreen and backlight: raked differently, which is most of what
       tells a saloon from an estate at a glance.
       the screen and the backlight are raked, so they see far more of the sky
       than the near-vertical side glass and their specular floor is already
       high; give them a much flatter albedo ramp or the screen blows out to
       white paper and the wipers become the only thing on it */
    /* THE SCREEN NO LONGER USES glassTone AT ALL, and gTint/gRamp are not set
       for it.  With the grazing specular cut by the roughness (see
       BUILD.carglass) the screen finally responds to its own albedo, and the
       measurement it is now solved against is 02-front34-right itself:
       windscreen p25 53 / median 65 / p75 102 against a 248 flank, i.e. the
       screen sits at a quarter to two fifths of the body.  Face-on (car.nose)
       the specular is gone altogether and the old flat 0.09 albedo left it a
       dead black rectangle, which is the other way to fail -- so the screen
       needs a steep ramp, and glassTone's ramp runs the WRONG WAY for it.
       glassTone lifts the TOP of a pane,
       because a near-vertical pane mirrors the sky up there.  A windscreen
       does the opposite: it carries a graded SHADE BAND, 150 mm of dark tint
       under the header easing out by the wiper park, and 02-front34-right
       carries it plainly -- the screen's top eighth is its darkest region,
       not its brightest, and the light is down by the cowl where the dash and
       the bonnet reflect into it.  screenTone is that band: albedo 0.19 at
       the cowl falling to 0.03 under the header.  It costs nothing at grazing
       incidence, where the specular owns the pixel, and it is the whole read
       face-on. */
    function screenTone(p) {
      var f = clamp((p[1] - (py + yC3)) / Math.max(yR2 - yC3, 1e-4), 0, 1);
      var g = 0.26 + 1.34 * (1 - f) * (1 - f);
      return [glassDust[0] * g, glassDust[1] * g, glassDust[2] * g];
    }
    /* THE SCREEN IS LOFTED, NOT ONE QUAD, and the reason is the reason the
       roof is lofted: one flat quad gets one normal, so every pixel on it
       samples the probe in the same direction and it renders as a single flat
       value -- which on a surface this raked is a painted panel, not glass.
       A real windscreen is doubly curved: it wraps ~24 degrees into the A
       pillars, and it stands more upright at the header than at the cowl.
       Those two curvatures are the whole read.  With the wrap, the outer
       thirds of the screen turn away from the sky and pick up the buildings
       either side; with the stand, the top mirrors the render opposite and the
       bottom keeps the dome -- which is the soft vertical gradient
       02-front34-right shows and a flat quad cannot have.
       (The base of the screen stays flat at deck(c3): the crowned deck is
       H*0.020 = 34 mm higher at the centreline, so the bottom row is buried
       inside the cowl and cannot leave a seam.  The top is flat at roofYt(c2)
       and the roof's crown is tapered to meet it -- see RTAP.) */
    var scDX = (c2 - c3) * L, scDY = yR2 - yC3;
    var scLn = Math.sqrt(scDX * scDX + scDY * scDY) || 1;
    var scNX = scDY / scLn, scNY = -scDX / scLn;   /* the flat screen normal */
    function scrN(f, v) {
      var nx = scNX, ny = scNY * (1 - 0.30 * v), nz = 0.44 * f;
      var ln = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      return dirT(T, nx / ln, ny / ln, nz / ln);
    }
    var nSV = TIER === 'low' ? 2 : 3;
    var windscreenPile = windowPile('windscreen', 'front', 0);
    for (i = 0; i < 2; i++) {
      var ss2 = i ? 1 : -1;
      for (rc = 0; rc < nRC; rc++) {
        var sf0 = ss2 * rc / nRC, sf1 = ss2 * (rc + 1) / nRC;
        for (k = 0; k < nSV; k++) {
          var sv0 = k / nSV, sv1 = (k + 1) / nSV;
          var sx0 = lerp(c3, c2, sv0) * L, sx1 = lerp(c3, c2, sv1) * L;
          var sy0 = lerp(yC3, yR2, sv0), sy1 = lerp(yC3, yR2, sv1);
          var sz0 = lerp(gwC3, rwC2, sv0), sz1 = lerp(gwC3, rwC2, sv1);
          RQ[0] = T(sx0, sy0, sz0 * sf0); RQ[1] = T(sx1, sy1, sz1 * sf0);
          RQ[2] = T(sx1, sy1, sz1 * sf1); RQ[3] = T(sx0, sy0, sz0 * sf1);
          RN[0] = scrN(sf0, sv0); RN[1] = scrN(sf0, sv1);
          RN[2] = scrN(sf1, sv1); RN[3] = scrN(sf1, sv0);
          polyS(windscreenPile, RQ, RN, 1.0, screenTone);
        }
      }
    }

    /* THE BACKLIGHT.  The tailgate is the near-vertical rake (c0, deck) ->
       (c1, roof); fy parametrises it 0..1 so the glass can start part-way UP
       that rake and still lie in its plane.  06-rear34 puts a large, nearly
       square window across most of the tailgate with a body-colour margin all
       round it, and a body band under it about a tenth of the tailgate's
       height deep -- previously the glass ran wall-to-wall from the beltline
       and tapered to a pyramid, because its top width was rwC1*tgK and roofK
       had already pulled rwC1 well in. */
    var tgK = S.tailGlassK || 1.0, tgKT = S.tailGlassT || tgK;
    var tgLo = S.tailGlassLo || 0;
    function tgX(fy) { return lerp(c0, c1, fy) * L; }
    function tgY(fy) { return lerp(yC0, yR1, fy); }
    function tgHW(fy) { return lerp(gwC0, rwC1, fy); }          /* full half-width */
    function tgGW(fy) { return tgHW(fy) * lerp(tgK, tgKT, fy); } /* glass half-width */
    gTint = 0.88; gRamp = 3.2;        /* privacy glass, but far more raked than
                                         the side panes, so half the ramp     */
    var backlightPile = windowPile('backlight', 'rear', 0);
    quadT(backlightPile, T, [tgX(tgLo), tgY(tgLo), -tgGW(tgLo)], [tgX(1), tgY(1), -tgGW(1)],
          [tgX(1), tgY(1), tgGW(1)], [tgX(tgLo), tgY(tgLo), tgGW(tgLo)],
          refX, sh.rideY, 0, 1.0, glassTone);
    gTint = 1;
    for (j = 0; j < 2; j++) {
      var tgs = j ? 1 : -1;
      /* the margin down each side of the glass */
      if (tgK < 0.999 || tgKT < 0.999) {
        quadT(P.body, T, [tgX(tgLo), tgY(tgLo), tgs * tgGW(tgLo)], [tgX(1), tgY(1), tgs * tgGW(1)],
              [tgX(1), tgY(1), tgs * tgHW(1)], [tgX(tgLo), tgY(tgLo), tgs * tgHW(tgLo)],
              refX, sh.rideY, 0, 0.96, tone);
      }
    }
    /* the band of painted tailgate between the beltline and the sill of the
       glass -- half of what stops the rear reading as a glass wall */
    if (tgLo > 0.001) {
      quadT(P.body, T, [tgX(0), tgY(0), -tgHW(0)], [tgX(tgLo), tgY(tgLo), -tgHW(tgLo)],
            [tgX(tgLo), tgY(tgLo), tgHW(tgLo)], [tgX(0), tgY(0), tgHW(0)],
            refX, sh.rideY, 0, 0.96, tone);
    }
    /* the high-mounted brake light: a 24 cm strip inside the top of the
       backlight, dead centre, standing 8 mm proud of the glass.  It is two
       pixels at parking distance and it is the one warm thing on the back of
       the car, so it reads long before any of the geometry does. */
    var hmA = 0.855, hmB = 0.912, hmP = m(0.010);   /* proud is -x: the tailgate
                                                       leans FORWARD going up */
    quadT(P.trim, T, [tgX(hmA) - hmP, tgY(hmA), -m(0.120)],
          [tgX(hmA) - hmP, tgY(hmA), m(0.120)],
          [tgX(hmB) - hmP, tgY(hmB), m(0.120)],
          [tgX(hmB) - hmP, tgY(hmB), -m(0.120)],
          refX, sh.rideY, 0, 0.90, [0.235, 0.042, 0.038]);

    /* the side DLO: the trapezoid (c0,deck) (c1,roof) (c2,roof) (c3,deck) */
    /* dTip / dRear: where the DLO actually CLOSES at each end, which is not
       where the body closes.  Ahead of dTip the wedge between the door cut and
       the windscreen's A pillar is solid black plastic (the mirror sail) --
       02-front34-right shows the mirror bolted to it, and it is not a window.
       Aft of dRear the wedge is body-colour sheet: the D pillar. */
    var dTip = S.dloTip || c3;
    var dRear = S.dloRear != null ? S.dloRear : c0 + (c1 - c0) * 0.10;
    var dRearTop = S.dloRearTop != null ? S.dloRearTop : dRear;
    var dRearBot = S.dloRearBot != null ? S.dloRearBot : dRear;
    function dloTop(tt) {
      if (tt <= c1) return lerp(yC0, yR1 - HEADERD,
                                clamp((tt - c0) / ((c1 - c0) || 1e-6), 0, 1));
      /* the front of the DLO dives to the beltline at dTip, NOT at cab[3]:
         the door's leading edge is 5.5 % of L behind the cowl */
      if (tt >= c2) return lerp(yR2 - HEADERD, dloBot(dTip),
                                clamp((tt - c2) / ((dTip - c2) || 1e-6), 0, 1));
      return sh.roofYt(tt) - HEADERD;
    }
    /* the glass starts 30 mm of body height above the waist, not 20: the band
       between them is the black weatherstrip, and at 1.5 m a 20 mm one was
       thin enough to alias into a dotted line all along the beltline.
       quarterLift raises the rearmost pane's base a further step -- the
       Courier's quarter glass sits 4 cm above the door glass line, with the
       slider track in the gap, and that stepped line IS the rear quarter. */
    function dloBot(tt) { return sh.deck(tt) + H * (S.dloSeal || 0.030); }
    /* THE TUMBLEHOME HAS TO CLOSE ON THE ROOFLINE, NOT ON H, and this was the
       single bug behind two of the three faults on the greenhouse.
       sh.ghw(t,y) normalises the height against the CONSTANT H:

         f = (y - deck) / (H - deck),   ghw = lerp(gw, roofHW, f^1.10)

       but the roof is an arc now and roofYt(t) < H everywhere except the peak,
       so at the top of the glass f never reaches 1 and the pane never reaches
       roofHW.  Measured, this car:

         t 0.30  roofYt 1.723 (the peak)   pane over the roof edge   +0.2 mm
         t 0.50  roofYt 1.708              pane over the roof edge   +3.7 mm
         t 0.70  roofYt 1.658 (the header) pane over the roof edge  +16.2 mm

       The drip rail stands at roofHW + PROUD = +12 mm, so from about t 0.65
       forward the DARK GLASS CLIMBS OUT OVER THE RAIL -- which is exactly why
       the front of the roof read dark while the rear read silver, and why the
       A pillar / sail / door-glass junction was a stack of bright slivers with
       a 4 mm z-fight at the header.  Renormalising on roofYt(t) makes f reach
       1 at the actual roofline, so every pane's top edge lands ON the roof
       edge and the rail covers it by a clean 12 mm the whole way.
       Everything in this section uses ghwT; sh.ghw stays as it is because
       section 6's mirror base reads it at belt height, where the two agree to
       within a tenth of a millimetre. */
    function ghwT(tt, y) {
      var d = sh.deck(tt), r = sh.roofYt(tt);
      var f = clamp((y - d) / Math.max(r - d, 1e-4), 0, 1);
      return lerp(sh.gw(tt), sh.roofHW(tt), Math.pow(f, 1.10));
    }
    /* quarterLift is applied PER PANE (a step cannot live inside a quad):
       pane 0 -- the quarter glass -- rides 4 cm higher than the door glass,
       and the step lands exactly on the C pillar, as photographed. */
    var qLift = S.quarterLift ? H * 0.024 : 0;
    /* the tumblehome already tilts a pane's normal up by about 8 degrees; this
       bows it a further +-16 across the height of the glass */
    var tumb = (sh.gw(0.5) - sh.roofHW(0.5)) / Math.max(H - sh.deck(0.5), 1e-4);
    function paneN(gs2, v) {
      var ny = tumb + 0.46 * (2 * v - 1), ln = Math.sqrt(ny * ny + 1);
      return dirT(T, 0, ny / ln, gs2 / ln);
    }
    var GQ = [null, null, null, null], GN = [null, null, null, null];
    /* The cant rail used to stop square at dRearTop / hFront while the A and
       D pillars stopped on a single diagonal chord.  That left an uncovered
       triangular lens at both ends of the roof and made each join read as two
       sheets of card meeting at a seam.  Treat the entire painted section as
       one loft instead: its depth eases from zero at each roof corner to the
       full HEADERD above the glass, and its face rolls outward by 7 mm between
       the glass and the roof edge.  The pillar patches below use this exact
       lower curve, so there is no overlap, crack or independently-computed
       corner at either end. */
    var hFront = c2 - (PW * 1.9) / L;
    function cantDepth(tt) {
      if (HEADERD <= 0.001) return 0;
      if (tt < dRearTop)
        return HEADERD * smooth(clamp((tt - c1) / Math.max(dRearTop - c1, 1e-5), 0, 1));
      if (tt > hFront)
        return HEADERD * smooth(clamp((c2 - tt) / Math.max(c2 - hFront, 1e-5), 0, 1));
      return HEADERD;
    }
    function cantPoint(tt, v, gs2) {
      var ry = sh.roofYt(tt), dep = cantDepth(tt);
      var dk = HEADERD > 0.001 ? dep / HEADERD : 0;
      var ly = ry - dep, yy = lerp(ly, ry, v);
      var lz = ghwT(tt, ly) + PROUD * dk;
      var zz = lerp(lz, roofRW(tt), v) + m(0.007) * Math.sin(Math.PI * v) * smooth(dk);
      return [tt * L, yy, gs2 * zz];
    }
    /* Smooth normals for small parametric body patches.  Boundary positions
       remain exact; only their shared interior is rounded. */
    function patchN(fn, u, v, gs2) {
      var e = 0.002, ua = Math.max(0, u - e), ub = Math.min(1, u + e);
      var va = Math.max(0, v - e), vb = Math.min(1, v + e);
      var pu0 = fn(ua, v), pu1 = fn(ub, v), pv0 = fn(u, va), pv1 = fn(u, vb);
      var ax = pu1[0] - pu0[0], ay = pu1[1] - pu0[1], az = pu1[2] - pu0[2];
      var bx = pv1[0] - pv0[0], by = pv1[1] - pv0[1], bz = pv1[2] - pv0[2];
      var nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      if (nz * gs2 < 0) { nx = -nx; ny = -ny; nz = -nz; }
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-8) return dirT(T, 0, 0, gs2);
      return dirT(T, nx / nl, ny / nl, nz / nl);
    }
    function emitPatch(pile, fn, nu, nv, gs2, ao, shade) {
      for (var eu = 0; eu < nu; eu++) {
        var u0 = eu / nu, u1 = (eu + 1) / nu;
        for (var ev = 0; ev < nv; ev++) {
          var v0 = ev / nv, v1 = (ev + 1) / nv;
          var lp = [fn(u0, v0), fn(u1, v0), fn(u1, v1), fn(u0, v1)];
          var nn = [patchN(fn, u0, v0, gs2), patchN(fn, u1, v0, gs2),
                    patchN(fn, u1, v1, gs2), patchN(fn, u0, v1, gs2)];
          var ux = lp[1][0] - lp[0][0], uy = lp[1][1] - lp[0][1];
          var vx = lp[3][0] - lp[0][0], vy = lp[3][1] - lp[0][1];
          if ((ux * vy - uy * vx) * gs2 < 0) {
            lp = [lp[0], lp[3], lp[2], lp[1]];
            nn = [nn[0], nn[3], nn[2], nn[1]];
          }
          polyS(pile, [T(lp[0][0], lp[0][1], lp[0][2]), T(lp[1][0], lp[1][1], lp[1][2]),
                       T(lp[2][0], lp[2][1], lp[2][2]), T(lp[3][0], lp[3][1], lp[3][2])],
                nn, ao, shade);
        }
      }
    }
    var CANTS = [c1, lerp(c1, dRearTop, 0.25), lerp(c1, dRearTop, 0.50),
                 lerp(c1, dRearTop, 0.75), dRearTop, hFront,
                 lerp(hFront, c2, 0.25), lerp(hFront, c2, 0.50),
                 lerp(hFront, c2, 0.75), c2];
    for (var cs = 0; cs < RSPL.length; cs++)
      if (RSPL[cs] > dRearTop && RSPL[cs] < hFront) CANTS.push(RSPL[cs]);
    CANTS.sort(function (a, b) { return a - b; });
    for (cs = CANTS.length - 1; cs > 0; cs--)
      if (Math.abs(CANTS[cs] - CANTS[cs - 1]) < 1e-6) CANTS.splice(cs, 1);
    function cantMap(u) {
      var q = clamp(u, 0, 1) * (CANTS.length - 1), qi = Math.min(CANTS.length - 2, Math.floor(q));
      return lerp(CANTS[qi], CANTS[qi + 1], q - qi);
    }
    /* four bands, not three: the tone ramp up a pane is f^1.5 and the vertex
       colour between bands is LINEAR, so three bands turned the curve into a
       visible chord across the top third of the glass */
    var nPane = sh.panes, nGV = TIER === 'low' ? 3 : 4;
    for (j = 0; j < 2; j++) {
      var gs = j ? 1 : -1;
      /* THE PAINTED CANT RAIL.  Side glass used to terminate directly on the
         roof edge, leaving only the 34 mm dark drip moulding between glazing
         and silhouette.  The real Courier has a 10-15 cm visible body-colour
         pressing here.  Loft the new band through the same roof stations as
         the roof itself so its upper and lower edges inherit the particular
         rear droop, crown and forward fall instead of becoming a ruler-flat
         strip.  It starts/ends on the D/A pillars, avoiding coplanar overlap. */
      if (HEADERD > 0.001) {
        emitPatch(P.body, function (u, v) { return cantPoint(cantMap(u), v, gs); },
                  CANTS.length - 1, TIER === 'low' ? 2 : 3, gs, 0.98, tone);
        var HSPL = [dRearTop];
        for (var hs = 0; hs < RSPL.length; hs++) {
          if (RSPL[hs] > dRearTop + 1e-5 && RSPL[hs] < hFront - 1e-5)
            HSPL.push(RSPL[hs]);
        }
        HSPL.push(hFront);
        /* A narrow bonded-window bead outlines the glass without stealing the
           metal depth.  It sits proud of the silver band and follows the same
           station-by-station slope; glass, bead and body remain distinct. */
        var TOPSEAL = m(0.012);
        P.trim.tile(T_TRIM).macro(0);
        for (hs = 0; hs < HSPL.length - 1; hs++) {
          var ha = HSPL[hs], hb = HSPL[hs + 1];
          var hya = dloTop(ha), hyb = dloTop(hb);
          var hya1 = hya + TOPSEAL, hyb1 = hyb + TOPSEAL;
          quadT(P.trim, T,
                [ha * L, hya, gs * (ghwT(ha, hya) + PROUD * 1.15)],
                [hb * L, hyb, gs * (ghwT(hb, hyb) + PROUD * 1.15)],
                [hb * L, hyb1, gs * (ghwT(hb, hyb1) + PROUD * 1.15)],
                [ha * L, hya1, gs * (ghwT(ha, hya1) + PROUD * 1.15)],
                refX, sh.rideY, 0, 0.92, [0.075, 0.078, 0.080]);
        }
      }
      for (i = 0; i < nPane; i++) {
        /* paneSplit: ABSOLUTE pillar stations off the reference, because the
           even split is wrong for any car with a sliding door -- the
           Courier's C pillar stands at t 0.235 (slider trailing edge) and
           its B at 0.50, where thirds put them at 0.257/0.428. */
        var pa, pb;
        if (S.paneSplit && S.paneSplit.length === nPane - 1) {
          pa = i === 0 ? dRear : S.paneSplit[i - 1];
          pb = i === nPane - 1 ? dTip : S.paneSplit[i];
        } else {
          pa = lerp(c1, c2, i / nPane); pb = lerp(c1, c2, (i + 1) / nPane);
          if (i === 0) pa = c0 + (c1 - c0) * 0.10;
          if (i === nPane - 1) pb = c3 - (c3 - c2) * 0.10;
        }
        /* the pane, opaque and dark; on the van everything behind the cab
           is a blank steel panel instead.  Split in the vertical so the
           tumblehome bends it and the tone can ramp up it.
           SPLIT IN t AT THE ROOF BREAKS TOO.  A pane's top edge used to run
           straight from dloTop(pa) to dloTop(pb); when the span crossed c1
           or c2 the roofline's kink was cut off, which on a shallow saloon
           lost 3 cm nobody saw and on the Courier's tall cab -- backlight
           rising 0.7 m over 5 % of L -- collapsed the whole rear third of
           the greenhouse into a tent.  Wherever c1/c2 falls inside a pane,
           the pane is lofted through it as an internal station. */
        var solidPane = sh.van && i > 0;
        var sidePanePile = solidPane ? null : windowPile('side', gs < 0 ? 'left' : 'right', i);
        var subs = [pa];
        if (c1 > pa + 1e-4 && c1 < pb - 1e-4) subs.push(c1);
        if (c2 > pa + 1e-4 && c2 < pb - 1e-4) subs.push(c2);
        subs.push(pb);
        var liftI = (S.quarterLift && i === 0) ? qLift : 0;
        /* PRIVACY TINT, pane by pane.  01-side-owner: you can see the seat
           backs and the headrests through the front door glass and almost
           nothing through the slider or the quarter.  Grading the three panes
           0.74 / 0.82 / 1.00 keeps the band continuous at parking distance
           and puts a visible step on each of the black pillars up close --
           which is exactly how the real one separates. */
        gTint = i === 0 ? 0.74 : (i === 1 ? 0.82 : 1.00); gRamp = 6.5;
        for (var sp = 0; sp < subs.length - 1; sp++) {
        var qa = subs[sp], qb = subs[sp + 1];
        for (k = 0; k < nGV; k++) {
          var v0 = k / nGV, v1 = (k + 1) / nGV;
          /* The Courier's quarter pane has a forward-raked lower-rear corner.
             Only its first edge uses two t stations; every other pane remains
             a conventional vertical door glass. */
          var rearEdge = i === 0 && sp === 0;
          var qa0 = rearEdge ? lerp(dRearBot, dRearTop, v0) : qa;
          var qa1 = rearEdge ? lerp(dRearBot, dRearTop, v1) : qa;
          var ya0 = rearEdge
            ? lerp(dloBot(dRearBot) + liftI, dloTop(dRearTop), v0)
            : lerp(dloBot(qa) + liftI, dloTop(qa), v0);
          var ya1 = rearEdge
            ? lerp(dloBot(dRearBot) + liftI, dloTop(dRearTop), v1)
            : lerp(dloBot(qa) + liftI, dloTop(qa), v1);
          var yb0 = lerp(dloBot(qb) + liftI, dloTop(qb), v0), yb1 = lerp(dloBot(qb) + liftI, dloTop(qb), v1);
          if (solidPane) {
            quadT(P.body, T,
                  [qa0 * L, ya0, gs * ghwT(qa0, ya0)], [qb * L, yb0, gs * ghwT(qb, yb0)],
                  [qb * L, yb1, gs * ghwT(qb, yb1)], [qa1 * L, ya1, gs * ghwT(qa1, ya1)],
                  refX, sh.rideY, 0, 1.0, tone);
            continue;
          }
          /* SHADING NORMALS on a flat pane.  The glass material carries a
             specular sky term that does not scale with albedo, so a vertex
             tone ramp on its own moves the pixel about 11 % and the DLO stays
             a black slab.  Bowing the normal -- down at the sill of the glass,
             up under the drip rail -- makes the SPECULAR carry the ramp
             instead, which is what a real pane does: it shows the render on
             the building opposite low down and the dome at the top. */
          GQ[0] = T(qa0 * L, ya0, gs * ghwT(qa0, ya0));
          GQ[1] = T(qb * L, yb0, gs * ghwT(qb, yb0));
          GQ[2] = T(qb * L, yb1, gs * ghwT(qb, yb1));
          GQ[3] = T(qa1 * L, ya1, gs * ghwT(qa1, ya1));
          GN[0] = GN[1] = paneN(gs, v0); GN[2] = GN[3] = paneN(gs, v1);
          polyS(sidePanePile, GQ, GN, 1.0, glassTone);
        }
        }
        /* the B (and on a three-pane car, the C) pillar between panes.  It
           leans with the glass, and it is BODY COLOUR: against a dark DLO a
           white strip is the single clearest cue that a greenhouse has a
           structure rather than being a slot milled in the roof.
           darkPillars overrides that on purpose: the Courier's mid pillars
           are gloss black, and the resulting single unbroken band of dark
           glass from A-pillar to tail is the car's whole side signature --
           the whiter A and D pillars still say "structure" at each end. */
        if (i < nPane - 1) {
          var pz2 = pb, yp0 = dloBot(pz2), yp1 = dloTop(pz2);
          /* gloss-black pillars live on the GLASS pile: same smooth sky
             specular as the panes either side, so the band stays one band --
             on the trim pile their black showed T_TRIM's grain as speckle.
             Widths differ per pillar on a paneSplit car: the door pillar (B)
             is a structural 11 cm, the slider pillar (C) a 8 cm blade. */
          /* widths straight off the edge scan of 01-side-owner: the B pillar
             carries both door frames and measures 38 px of a 295 px/m photo,
             i.e. 13 cm; the C pillar is a single blade and reads as one edge,
             so 5.5 cm.  They were 11 cm and 8 cm, which made them the same
             width to the eye and neither of them the right one. */
          var PWi = S.paneSplit ? (i === 1 ? m(0.065) : m(0.028)) : PW;
          quadT(S.darkPillars ? P.glass : P.body, T,
                [pz2 * L - PWi, yp0, gs * (ghwT(pz2, yp0) + PROUD)],
                [pz2 * L + PWi, yp0, gs * (ghwT(pz2, yp0) + PROUD)],
                [pz2 * L + PWi, yp1, gs * (ghwT(pz2, yp1) + PROUD)],
                [pz2 * L - PWi, yp1, gs * (ghwT(pz2, yp1) + PROUD)],
                refX, sh.rideY, 0, S.darkPillars ? 0.80 : 0.90,
                S.darkPillars ? pillarTone : tone);
        }
      }
      /* THE A PILLAR, and it is a WEDGE, not a parallel blade.  Its front edge
         is the windscreen's own rake (c3, deck) -> (c2, roof); its back edge
         has to land on dTip at the beltline, because that is where the DLO
         closes.  Drawn as a parallel strip it left an unfilled sliver between
         its inner edge and the front of the glass, i.e. a hole straight
         through the cabin. */
      /* ...and its back edge is now SHARED, vertex for vertex, with the sail
         panel below it.  The two used to be independent quads at PROUD and
         0.55*PROUD that crossed each other about half way up: the pillar's z
         is interpolated linearly across a twisted quad, the sail's follows the
         tumblehome curve, and where the curve overtook the chord the black
         sail surfaced through the white pillar in stripes.  That -- plus the
         16 mm of pane hanging over the drip rail at the header, see ghwT --
         is the "handful of bright vertical splinters" at this junction.
         apX/apY/apZ are the shared corner; nothing may compute it twice. */
      /* ...and the top of it stops at the rail's UNDERSIDE (see RAILD), not on
         the roofline.  Landing it on (c2, yR2) put 95 mm of body-colour pillar
         over the front end of the drip rail -- the pillar's z climbs a quarter
         of a millimetre for every millimetre you drop below that corner, so it
         is 9 mm proud of the rail by the rail's own bottom edge and wins the
         depth test outright.  With the rail painted out there, the front of
         the roof, the header and the pillar were one continuous white mass:
         the "shard of card" in _shots/it7/car.dlo.  apV is how far up the
         windscreen's own rake the rail's underside falls, so the pillar's
         front edge still lies on the screen line to the last millimetre. */
      var aTipY = dloBot(dTip);
      /* ...and its FRONT edge carries no PROUD either, for the same reason the
         D pillar's rear edge does not.  PROUD lifted the whole blade 12 mm off
         the windscreen's own outer edge and left the step open at both ends --
         a 12 mm slot running the full length of the pillar with nothing inside
         it, and the cabin is hollow, so from any three-quarter camera you look
         straight down that slot and out the other side of the car.  That is
         the thin bright line beside the screen in car.front34b, and it is a
         hole, not a highlight.  It is also wrong as a shape: this screen is
         BONDED, flush with its surround (02-front34-right shows one continuous
         surface from glass to pillar with only the black bead between them),
         so the pillar's leading edge belongs ON the screen's edge, vertex for
         vertex.  The trailing edge keeps its PROUD, where it is standing off
         the DOOR glass and doing the job PROUD exists for. */
      /* Only the TRAILING corner drops to the rail's underside; the leading one
         stays on (c2, yR2, rwC2), which is the roof's own front corner and the
         windscreen's own top corner -- one vertex, shared three ways.  Dropping
         that one too pulled it 22 mm ahead of c2 (the screen's edge leans
         forward as it descends) and the rail stops AT c2, so it opened a 22 mm
         notch of daylight at the very top of the pillar.  Sloping the top edge
         instead does the whole job: the corner closes, and by the time the edge
         has run back the 91 mm to apX it is RAILD below the roofline and 6.6 mm
         inboard of the rail's face, so the gutter passes over it with no
         z-fight and no break. */
      var apX = hFront * L;
      var apY = HEADERD > 0.001 ? dloTop(apX / L) : yR2 - RAILD;
      var apZ = HEADERD > 0.001 ? ghwT(apX / L, apY) + PROUD : rwC2 + PROUD;
      var atZ = ghwT(dTip, aTipY) + PROUD;
      if (HEADERD > 0.001) {
        /* A rounded Coons-like patch replaces the single twisted quad.  Its
           windscreen edge remains exactly on the screen, its rear edge still
           meets the sail, and its curved top is cantPoint(..., 0): the same
           curve used by the painted header above it.  A restrained 6 mm crown
           in the interior turns the highlight without moving any seam. */
        emitPatch(P.body, function (u, v) {
          var bx = lerp(c3 * L, dTip * L, u), by = lerp(yC3, aTipY, u);
          var bz = lerp(gwC3, atZ, u);
          var tp = cantPoint(lerp(c2, hFront, u), 0, gs);
          var bulge = m(0.006) * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
          return [lerp(bx, tp[0], v), lerp(by, tp[1], v),
                  lerp(gs * bz, tp[2], v) + gs * bulge];
        }, TIER === 'low' ? 3 : 5, TIER === 'low' ? 3 : 4, gs, 0.96, tone);
      } else {
        quadT(P.body, T, [c3 * L, yC3, gs * gwC3],
              [c2 * L, yR2, gs * rwC2],
              [apX, apY, gs * apZ],
              [dTip * L, aTipY, gs * atZ],
              refX, sh.rideY, 0, 0.96, tone);
      }
      /* THE MIRROR SAIL.  Gloss black plastic, not glass: the wedge between
         the door's leading edge and the A pillar, wide at the belt where the
         mirror bolts to it (02-front34-right), apexing about half way up the
         glass.  Emitted on the glass pile so it carries the same smooth
         specular as the B/C pillars -- it is the same trim part on the real
         car -- and stands at PROUD, i.e. over the pane and level with the
         A pillar's own back edge. */
      /* IT NO LONGER APEXES ON THE ROOF RAIL, and that single change is most
         of what fixes the front corner.  A triangle from (dloFront, belt) to
         (dloTip, belt) to (apX, apY) is 600 mm tall: it swallows the whole
         front of the DLO, so the pillar, the sail and the glass arrive at the
         eye as ONE dark mass with a white blade beside it and a step where the
         pillar's top corner sits 34 mm under the roofline.  That is fault 1 in
         _shots/it8.
         What the photographs actually carry (01-side-owner, and unmistakably
         in 04-front34-left) is a sail whose REAR edge is NEARLY VERTICAL -- it
         is the door frame, and door frames are vertical -- running up from the
         belt until it meets the RAKED back edge of the A pillar.  Where those
         two lines cross IS the apex; nothing chooses it.  With the base
         187 mm and the pillar's back edge raking 0.084 of L over the 567 mm
         from the belt to the rail, they cross at
             sfF = (dTip - dloFront) / (dTip - apX/L) = 0.536
         i.e. 304 mm up, 51 % of the glass.  Above that the visible edge of the
         glass is the pillar's own back edge and there is no sail left at all,
         which is exactly the read: pillar, sail, glass, cleanly stacked.
         THE APEX IS LERPED FROM THE PILLAR'S TWO CORNERS, componentwise, and
         it has to be.  The pillar's back edge is a chord of a TWISTED quad --
         its z runs from atZ at the belt to apZ at the rail while ghwT's
         tumblehome between the same two heights is a curve -- so any apex
         computed from ghwT() would sit a few millimetres inboard of the chord
         half way up and the black sail would surface through the white pillar
         in stripes.  Lerping the corners puts the sail's front edge ON the
         pillar's back edge to the last bit. */
      if (S.sailPanel) {
        var sfB = S.dloFront != null ? S.dloFront : dTip;
        var syB = dloBot(sfB);
        var sfF = clamp((dTip - sfB) / Math.max(dTip - apX / L, 1e-6), 0, 1);
        var sapX = lerp(dTip * L, apX, sfF), sapY = lerp(aTipY, apY, sfF);
        var sapZ = lerp(atZ, apZ, sfF);
        /* A TRIANGLE, and at the SAME proud as the A pillar.  It was a quad
           whose top edge ran from c2 forward to lerp(sfB,c2,0.85) -- 6 mm of L
           of top edge, i.e. a spike, and the fan split it into two triangles of
           OPPOSITE winding, so poly() picked one facet normal, culled half of
           it and left a hole at the header.  A real triangle apexing on the A
           pillar's own back edge cannot do either: it shares the dTip corner
           exactly with the pillar and its apex is a point ON that pillar's
           edge, so the wedge is tiled with one seam and no overlap at all.
           The fourth vertex repeats the apex; poly()'s fan emits it as a
           zero-area triangle and drops it. */
        /* AND IT IS NOT pillarTone.  pillarTone lands at 0.033 at the belt and
           glassTone's front pane lands at 0.030 there, so at the one height
           the sail exists at they were the SAME BLACK and the panel simply was
           not in the picture.  This is matte plastic, not glazing: it does not
           mirror the render opposite, so it carries a flat albedo instead of a
           ramp, and 0.058 against the pane's 0.030 is the 1.9x that reads as a
           separate part at the belt without becoming a grey patch.  By the
           apex the pane is up to 0.27 and is four times the sail, which is
           also right -- from the shoulder up the glass is all sky. */
        quadT(P.glass, T,
              [sfB * L, syB, gs * (ghwT(sfB, syB) + PROUD)],
              [dTip * L, aTipY, gs * atZ],
              [sapX, sapY, gs * sapZ],
              [sapX, sapY, gs * sapZ],
              refX, sh.rideY, 0, 0.80, [0.058, 0.058, 0.059]);
      }
      /* THE D PILLAR: body colour, and WIDE -- 01-side-owner puts the quarter
         glass's trailing edge 18 cm ahead of the greenhouse's rear corner, and
         that painted wedge is the whole reason the back of the car reads as a
         shape closing rather than as glass running off the end.  Its rear edge
         is the tailgate rake (c0, deck) -> (c1, roof); its front edge is the
         vertical cut at dRear the quarter glass stops on. */
      /* ...and its REAR EDGE CARRIES NO PROUD, which is the whole of why the
         cabin read as a box balanced on the body in _shots/it7/car.side.
         PROUD exists to lift a frame off the GLASS beside it.  Down the
         tailgate corner there is no glass beside it -- the panel on the other
         side of that edge is the tailgate's own body-colour margin, which the
         backlight block draws at exactly lerp(gwC0, rwC1, fy).  Standing the
         pillar 12 mm outboard of that put a 12 mm step up the entire rear
         corner of the greenhouse, and because sh.hw() is still closing the
         plan in over the last 90 mm of the tail the step had the body falling
         away underneath it: a cabin hanging over its own tail.  Sharing the
         edge closes it, and the pillar still stands its full PROUD off the
         quarter glass at the dRear end where that is what it is for.
         The top corner at dRear drops to the rail's underside for the same
         reason the A pillar's does -- see RAILD. */
      var dpT = dloTop(dRearTop) - (HEADERD > 0.001 ? 0 : RAILD);
      var dpB = dloBot(dRearBot) + qLift;
      if (HEADERD > 0.001) {
        /* The rear corner is the same construction in reverse.  Subdivision
           across and down the D pillar removes the one huge planar facet, and
           its top row is shared with the header's eased rear roll. */
        var dpBZ = ghwT(dRearBot, dpB) + PROUD;
        emitPatch(P.body, function (u, v) {
          var bx = lerp(c0 * L, dRearBot * L, u), by = lerp(yC0, dpB, u);
          var bz = lerp(gwC0, dpBZ, u);
          var tp = cantPoint(lerp(c1, dRearTop, u), 0, gs);
          var bulge = m(0.006) * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
          return [lerp(bx, tp[0], v), lerp(by, tp[1], v),
                  lerp(gs * bz, tp[2], v) + gs * bulge];
        }, TIER === 'low' ? 3 : 5, TIER === 'low' ? 3 : 4, gs, 0.96, tone);
      } else {
        quadT(P.body, T, [c0 * L, yC0, gs * gwC0],
              [c1 * L, yR1, gs * rwC1],
              [dRearTop * L, dpT, gs * (ghwT(dRearTop, dpT) + PROUD)],
              [dRearBot * L, dpB, gs * (ghwT(dRearBot, dpB) + PROUD)],
              refX, sh.rideY, 0, 0.96, tone);
      }
      /* the gutter along the roof edge, and the black belt seal under the
         glass -- two thin lines that do more for the read than anything
         else on the greenhouse */
      /* the drip rail.  It was bright chrome, which against a near-black DLO
         is a one-pixel white line and aliases into dashes; a real one under an
         overcast reads as a DARK line with a highlight on its top face, which
         is exactly what a dull tone plus the up-facing bake gives.  It rides
         roofYt station by station so the arc carries into the rail. */
      for (var dr2 = 0; dr2 < RSPL.length - 1; dr2++) {
        var da2 = RSPL[dr2], db2 = RSPL[dr2 + 1];
        var dya = sh.roofYt(da2), dyb = sh.roofYt(db2);
        var dza = lerp(rwC1, rwC2, (da2 - c1) / ((c2 - c1) || 1e-6));
        var dzb = lerp(rwC1, rwC2, (db2 - c1) / ((c2 - c1) || 1e-6));
        /* 0.32 was a MID grey: against the silver roof it read as a shadow,
           which was right, but against the near-black DLO underneath it read
           as a bright line, which was not -- the photographs carry a dark
           channel there, and the roof's own bright edge above it is what
           separates the two.  0.15 and 2 % of H deep does both jobs. */
        /* PROUD*1.55, not PROUD.  The rail has to be the outermost thing on
           the roof edge or it is not a rail: the pillars either side of it all
           lean outward as they drop, so at the rail's own bottom edge a pillar
           face is already 6-9 mm outboard of rwC + PROUD and pokes through it.
           Six extra millimetres of z is under a pixel of silhouette at parking
           distance and it makes the gutter one unbroken dark line from the
           tailgate corner to the header, which is the single strongest read on
           the whole greenhouse.  RAILD is its depth, shared with the pillars. */
        quadT(P.trim, T, [da2 * L, dya, gs * (dza + PROUD * 1.55)],
              [db2 * L, dyb, gs * (dzb + PROUD * 1.55)],
              [db2 * L, dyb - RAILD, gs * (dzb + PROUD * 1.55)],
              [da2 * L, dya - RAILD, gs * (dza + PROUD * 1.55)], refX, 0, 0, 1.0,
              [0.150, 0.152, 0.150]);
      }
      /* THE BELT SEAL, and where it has to live.  The greenhouse is 46 mm
         narrower than the widest point of the flank, so anything hung on the
         waist at gw sits INSIDE the shoulder's silhouette; run it down to the
         deck and the shoulder grazes it edge-on for its whole length and it
         samples as a dotted line of beads.  Straddle the base of the glass
         instead -- 16 mm of body height clear of the deck -- and it is a
         clean black weatherstrip under a clean bright door top. */
      /* ...and it runs from the D pillar to the door cut, NOT from tail to
         cowl: aft of dRear and ahead of dTip there is no glass for it to seal.
         It also has to STEP UP over the C pillar with the quarter glass, or
         the 4 cm quarterLift leaves the seal hanging in mid-air under it. */
      /* ...AND IT IS NOT A BLACK STRIPE.  38 mm of flat trimDark (0.145 x ao
         0.86 = 0.125, against a flank near 0.39) is a bar of shadow drawn from
         the D pillar to the cowl, and in _shots/it8/car.side it is the loudest
         horizontal on the car -- louder than the shoulder highlight the whole
         of carTone's SHEEN_UP term exists to paint.  It is not what the
         photograph carries.  Column scan of 05-side-dealer at photo x 470 /
         540 / 610, i.e. right along the front door at 207 px/m:

           glass   ..193   55,56,65      ..189  57,56,68     ..185  58,57,71
           SEAL    194     41,45,54      190    41,45,57     186    45,48,63
           edge    195     54,60,69      191    74,84,99     187    78,88,105
           door    196     110,119,133   192    107,123,139  188    111,126,145

         ONE PIXEL of true dark and one of transition -- 5 to 10 mm -- and then
         the door skin at full value with no bright finisher over it at all.
         (The bright line the eye reads as "the top of the door" is the
         SHOULDER, 10-16 px lower, and the flank loft already paints it.)  The
         seal is also not black relative to what it sits on: 41 against 110 is
         12 % of the door in linear, where ours was 6.5 %.
         A hairline cannot be drawn at 105 px/m -- 10 mm is a tenth of a pixel
         and it would sample as a dotted line, which is the fault the previous
         pass was avoiding when it made the band fat.  So the band is drawn at
         the smallest size that still anti-aliases into a continuous line, 24
         mm, and everything else is done with VALUE: the top half is rubber
         lifted to 0.162 (the photograph's 12 % of the door, not 6.5 %) and the
         bottom half ramps up to 0.324, which is the door skin arriving.  Read
         from three metres that is one soft dark line about two pixels deep
         with an edge on it, which is what the scan above is.
         Neutral, not tone: the strip lies on the one up-facing corner on the
         whole flank, and a grey that cannot pick up the warm bounce off the
         building opposite is worth more here than three millimetres of
         accuracy -- an earlier pass had a yellow-green pinstripe the length of
         the car from exactly this facet.
         bsTop/bsDep are set per run immediately before the emit; deck() is
         dead flat from cab[0] to cab[3] (see carShape), so dloBot is the same
         at both ends of a run and one scalar top is exact, not an average. */
      var bsTop = 0, bsDep = 1;
      function beltTone(p) {
        var f = clamp((bsTop - p[1]) / bsDep, 0, 1);   /* 0 at the glass, 1 at the bottom */
        /* base 1.00 -> 1.30 and the lift 2.05 -> 1.30.  At base 1.00 the
           rubber solved to 0.125 against a flank near 0.39, i.e. 6.5 % of the
           door in linear where the photograph measures 12 %; and at 2.05 the
           lip came out at 0.44, BRIGHTER than the door it is supposed to sit
           on, which is a second chrome strip.  1.30 / 1.30 puts them at 0.162
           and 0.324 after ao: a dark line you can see the colour of, and an
           edge that is the door skin arriving rather than a highlight. */
        var g = 1.30 + 1.30 * smooth(clamp((f - 0.48) / 0.34, 0, 1));
        return [trimDark[0] * g, trimDark[1] * g, trimDark[2] * g];
      }
      var bsC = S.paneSplit ? S.paneSplit[0] : lerp(c1, c2, 0.34);
      for (k = 0; k < 2; k++) {
        var bs0 = k ? bsC : dRearBot, bs1 = k ? dTip : bsC;
        var bsL = k ? 0 : qLift;
        /* the quarter's run is deeper, because the sliding-door rail below it
           tops out at deck + 2.3 % of H and the lifted seal started at 2.8 %:
           a 9 mm painted sliver between two black bands is one pixel at
           parking distance and it sampled as a dotted line of speckle. */
        /* 0.020 -> 0.013 on the door run and 0.026 -> 0.017 on the quarter:
           24 mm and 31 mm.  The quarter keeps the extra 7 mm because the
           sliding-door rail below it tops out at deck + 2.3 % of H and a
           painted sliver between two dark bands is one pixel at parking
           distance and samples as speckle.  What is left uncovered under the
           door run is 17 mm of the deck's outer corner, which is up-facing and
           can pick up the warm bounce off the building opposite -- but that is
           what the photograph has there too (door skin at full value, right up
           to the rubber), and the ramp's own bottom row is now sitting on it
           at a neutral 0.324, so the corner has something to blend into. */
        var bsD = k ? H * 0.013 : H * 0.017;
        bsTop = py + dloBot(bs0) + bsL + H * 0.002;
        bsDep = bsD + H * 0.002;
        quadT(P.trim, T, [bs0 * L, dloBot(bs0) + bsL + H * 0.002, gs * (sh.gw(bs0) + PROUD)],
              [bs1 * L, dloBot(bs1) + bsL + H * 0.002, gs * (sh.gw(bs1) + PROUD)],
              [bs1 * L, dloBot(bs1) + bsL - bsD, gs * (sh.gw(bs1) + PROUD)],
              [bs0 * L, dloBot(bs0) + bsL - bsD, gs * (sh.gw(bs0) + PROUD)],
              refX, sh.rideY, 0, 0.86, beltTone);
      }
    }

    /* ==================================================================
       3B  THE CABIN.  Until a pane is broken this sits behind the opaque
       reflective glazing and contributes only the silhouettes a real car
       carries through its front window.  Once nz-destruct removes a pane it
       becomes the subject: a complete five-seat LHD cabin, not a black box.

       Every dimension is tied to the Courier's cabin envelope.  The seats
       sit on the floorpan, the dashboard follows the cowl, and nothing pokes
       through the body or the glazing.  A dedicated matte cabin material
       preserves the small sewn and mechanical forms; restrained vertex-value
       shifts separate cloth, carpet, plastic and metal in one draw call.
       ================================================================== */
    P.cabin.tile(T_TRIM).macro(0);
    var ciCarpet = [0.048, 0.052, 0.056];
    var ciPlastic = [0.090, 0.098, 0.106];
    var ciPlastic2 = [0.155, 0.166, 0.177];
    var ciCloth = [0.270, 0.288, 0.302];
    var ciCloth2 = [0.345, 0.363, 0.378];
    var ciBolster = [0.190, 0.203, 0.216];
    var ciStitch = [0.510, 0.530, 0.542];
    var ciMetal = [0.470, 0.492, 0.510];
    var ciScreen = [0.055, 0.078, 0.088];
    var ciRed = [0.420, 0.040, 0.030];
    var ciFloorY = sh.rideY + H * 0.055;
    var ciInner = Math.min(sh.gw(0.48) * 0.83, sh.hW * 0.78);
    var ciRef = [L * 0.48, H * 0.48, 0];

    /* A padded or moulded part as an arbitrary side profile extruded across
       local Z.  It gives the seat backs their rake and the fascia its rolled
       top without importing a model or paying a material per object. */
    function ciSlab(sec, z0, z1, ao, col) {
      var A = [], B = [], q, n = sec.length, sx = 0, sy = 0;
      for (var ci = 0; ci < n; ci++) {
        sx += sec[ci][0]; sy += sec[ci][1];
        A.push(T(sec[ci][0], sec[ci][1], z0));
        B.push(T(sec[ci][0], sec[ci][1], z1));
      }
      var rr0 = T(sx / n, sy / n, (z0 + z1) * .5);
      poly(P.cabin, A, rr0[0], rr0[1], rr0[2], ao, col);
      poly(P.cabin, B, rr0[0], rr0[1], rr0[2], ao, col);
      for (ci = 0; ci < n; ci++) {
        var cn = (ci + 1) % n;
        q = [A[ci], A[cn], B[cn], B[ci]];
        poly(P.cabin, q, rr0[0], rr0[1], rr0[2], ao, col);
      }
    }
    /* Upholstery is not a hard extrusion.  Recessing each end cap and lofting
       it through a full-size inner ring gives cushions, backrests and
       headrests a compact stitched edge radius on all four sides. */
    function ciRoundSec(sec) {
      var out=[];
      for(var ci=0;ci<sec.length;ci++){
        var a=sec[ci],b=sec[(ci+1)%sec.length];
        out.push([a[0]*.75+b[0]*.25,a[1]*.75+b[1]*.25]);
        out.push([a[0]*.25+b[0]*.75,a[1]*.25+b[1]*.75]);
      }
      return out;
    }
    function ciSoftSlab(sec, z0, z1, bevel, ao, col) {
      sec=ciRoundSec(sec);
      var cx=0,cy=0,ci,n=sec.length,rings=[],span=Math.abs(z1-z0);
      for(ci=0;ci<n;ci++){cx+=sec[ci][0];cy+=sec[ci][1];}
      cx/=n;cy/=n;bevel=Math.min(bevel,span*.24);
      function ciSoftRing(z,scale){
        var out=[];
        for(var si=0;si<n;si++) out.push(T(cx+(sec[si][0]-cx)*scale,cy+(sec[si][1]-cy)*scale,z));
        return out;
      }
      rings.push(ciSoftRing(z0,.86));
      rings.push(ciSoftRing(z0+bevel,1));
      rings.push(ciSoftRing(z1-bevel,1));
      rings.push(ciSoftRing(z1,.86));
      var rr=T(cx,cy,(z0+z1)*.5);
      loft(P.cabin,rings,ao,col,true,true,rr);
    }
    function ciTube(ax, ay, az, bx, by, bz, r, seg, ao, col, r2) {
      var a = T(ax, ay, az), b = T(bx, by, bz);
      tube(P.cabin, a[0], a[1], a[2], b[0], b[1], b[2], r, seg, ao, true, col, r2);
    }
    function ciRing(cx, cy, cz, rad, seg, thick, tilt, col) {
      var last = null, first = null;
      for (var ci = 0; ci <= seg; ci++) {
        var an = ci / seg * TAU;
        var p = [cx + Math.cos(an) * rad * tilt,
                 cy + Math.cos(an) * rad,
                 cz + Math.sin(an) * rad];
        if (!first) first = p;
        if (last) ciTube(last[0], last[1], last[2], p[0], p[1], p[2], thick, 5, .90, col);
        last = p;
      }
    }
    function ciRingH(cx, cy, cz, rad, seg, thick, col) {
      var last = null;
      for (var ci = 0; ci <= seg; ci++) {
        var an = ci / seg * TAU;
        var p = [cx + Math.cos(an) * rad, cy, cz + Math.sin(an) * rad];
        if (last) ciTube(last[0], last[1], last[2], p[0], p[1], p[2], thick, 4, .82, col);
        last = p;
      }
    }
    function ciRingXY(cx, cy, cz, rx, ry, seg, thick, col) {
      var last = null;
      for (var ci = 0; ci <= seg; ci++) {
        var an = ci / seg * TAU;
        var p = [cx + Math.cos(an) * rx, cy + Math.sin(an) * ry, cz];
        if (last) ciTube(last[0], last[1], last[2], p[0], p[1], p[2], thick, 4, .84, col);
        last = p;
      }
    }
    /* Fine raised piping around a side profile.  At this scale the rounded
       cord supplies the highlight that distinguishes sewn upholstery from a
       polygonal foam block, while the darker slab underneath keeps its mass. */
    function ciPiping(sec, z, col, scale) {
      sec=ciRoundSec(sec);
      scale=scale===undefined?1:scale;
      var cx=0,cy=0;
      for(var sj=0;sj<sec.length;sj++){cx+=sec[sj][0];cy+=sec[sj][1];}
      cx/=sec.length;cy/=sec.length;
      for (var ci = 0; ci < sec.length; ci++) {
        var a = sec[ci], b = sec[(ci + 1) % sec.length];
        ciTube(cx+(a[0]-cx)*scale,cy+(a[1]-cy)*scale,z,
               cx+(b[0]-cx)*scale,cy+(b[1]-cy)*scale,z,m(.0055),4,.90,col);
      }
    }

    /* Carpeted tub, transmission tunnel and the parcel shelf close every
       downward sight line through a shattered side window. */
    boxT(P.cabin, T, L * .45, ciFloorY, 0, L * .315, H * .027, ciInner, .46, ciCarpet);
    boxT(P.cabin, T, L * .50, ciFloorY + H * .075, 0,
         L * .235, H * .070, sh.hW * .105, .68, ciPlastic);
    boxT(P.cabin, T, L * .205, H * .405, 0,
         L * .085, H * .022, ciInner * .94, .72, ciCarpet);

    /* Rear bench.  The base is a rounded bolster carrying three individually
       padded seating positions; the back is split into separate upholstered
       sections instead of one enormous extruded wedge. */
    var ciRearZ = ciInner * .87;
    var ciRearCush = [[L*.190,H*.275],[L*.205,H*.247],[L*.352,H*.244],[L*.390,H*.272],
      [L*.386,H*.326],[L*.360,H*.355],[L*.222,H*.350],[L*.194,H*.326]];
    ciSoftSlab(ciRearCush,-ciRearZ,ciRearZ,m(.055),.78,ciBolster);
    ciPiping(ciRearCush,-ciRearZ,ciStitch,.86);
    ciPiping(ciRearCush, ciRearZ,ciStitch,.86);
    var ciRearGap=m(.022), ciRearStep=ciRearZ*2/3;
    for (j=0;j<3;j++) {
      var rz0=-ciRearZ+j*ciRearStep+ciRearGap;
      var rz1=-ciRearZ+(j+1)*ciRearStep-ciRearGap;
      ciSoftSlab([[L*.213,H*.284],[L*.228,H*.269],[L*.353,H*.267],[L*.372,H*.286],
              [L*.367,H*.325],[L*.347,H*.339],[L*.235,H*.336],[L*.216,H*.321]],
             rz0,rz1,m(.030),.86,ciCloth2);
    }
    var ciRearBack = [[L*.155,H*.370],[L*.172,H*.342],[L*.225,H*.343],[L*.253,H*.372],
      [L*.225,H*.646],[L*.205,H*.676],[L*.171,H*.674],[L*.148,H*.642]];
    for (j=0;j<3;j++) {
      rz0=-ciRearZ+j*ciRearStep+ciRearGap;
      rz1=-ciRearZ+(j+1)*ciRearStep-ciRearGap;
      ciSoftSlab(ciRearBack,rz0,rz1,m(.042),.80,ciBolster);
      ciSoftSlab([[L*.176,H*.385],[L*.190,H*.365],[L*.216,H*.365],[L*.233,H*.387],
              [L*.211,H*.624],[L*.197,H*.647],[L*.177,H*.643],[L*.164,H*.618]],
             rz0+m(.025),rz1-m(.025),m(.028),.88,ciCloth);
      ciTube(L*.169,H*.505,rz0+m(.018),L*.205,H*.515,rz1-m(.018),m(.0048),4,.88,ciStitch);
    }
    /* Three compact, corner-rounded headrests on visible steel guides. */
    for (j=-1;j<=1;j++) {
      var ciHZ=j*ciRearZ*.61;
      ciTube(L*.187,H*.652,ciHZ-m(.058),L*.183,H*.731,ciHZ-m(.058),m(.008),5,.92,ciMetal);
      ciTube(L*.187,H*.652,ciHZ+m(.058),L*.183,H*.731,ciHZ+m(.058),m(.008),5,.92,ciMetal);
      ciSoftSlab([[L*.151,H*.731],[L*.160,H*.708],[L*.202,H*.708],[L*.216,H*.729],
              [L*.212,H*.784],[L*.198,H*.806],[L*.159,H*.804],[L*.148,H*.782]],
             ciHZ-m(.105),ciHZ+m(.105),m(.035),.86,ciBolster);
      ciSoftSlab([[L*.160,H*.737],[L*.168,H*.722],[L*.195,H*.722],[L*.204,H*.738],
              [L*.201,H*.778],[L*.192,H*.791],[L*.164,H*.790],[L*.157,H*.776]],
             ciHZ-m(.092),ciHZ+m(.092),m(.024),.92,ciCloth);
    }

    /* Two independent front seats.  Each one now has a steel runner and dark
       moulded shell, a rounded lower cushion, a tapered/reclined backrest,
       lighter woven centre inserts, raised side bolsters, piping, a recliner
       hinge and a shaped headrest. */
    var ciSeatZ=ciInner*.48, ciSeatHW=ciInner*.34;
    var ciCushSec=[[L*.444,H*.285],[L*.458,H*.252],[L*.485,H*.237],[L*.598,H*.240],
      [L*.628,H*.268],[L*.626,H*.330],[L*.604,H*.369],[L*.478,H*.372],[L*.449,H*.343]];
    var ciBackSec=[[L*.382,H*.392],[L*.402,H*.356],[L*.455,H*.350],[L*.484,H*.381],
      [L*.454,H*.646],[L*.437,H*.683],[L*.397,H*.688],[L*.373,H*.659]];
    for (j=-1;j<=1;j+=2) {
      var csz=j*ciSeatZ;
      /* runners and the compact plastic seat pan */
      for (k=-1;k<=1;k+=2) {
        ciTube(L*.465,H*.218,csz+k*ciSeatHW*.62,L*.585,H*.222,csz+k*ciSeatHW*.62,
               m(.018),5,.74,ciMetal);
        boxT(P.cabin,T,L*.505,H*.245,csz+k*ciSeatHW*.74,L*.070,H*.026,m(.018),.72,ciPlastic);
      }
      ciSlab([[L*.445,H*.250],[L*.470,H*.225],[L*.600,H*.228],[L*.623,H*.253],
              [L*.612,H*.295],[L*.456,H*.297]],csz-ciSeatHW*.94,csz+ciSeatHW*.94,.72,ciPlastic);
      ciSoftSlab(ciCushSec,csz-ciSeatHW,csz+ciSeatHW,m(.050),.82,ciBolster);
      ciSoftSlab([[L*.472,H*.290],[L*.482,H*.268],[L*.505,H*.258],[L*.587,H*.260],
              [L*.607,H*.282],[L*.602,H*.329],[L*.585,H*.346],[L*.493,H*.349],[L*.474,H*.329]],
             csz-ciSeatHW*.57,csz+ciSeatHW*.57,m(.030),.90,ciCloth2);
      ciSoftSlab(ciBackSec,csz-ciSeatHW,csz+ciSeatHW,m(.050),.82,ciBolster);
      ciSoftSlab([[L*.403,H*.406],[L*.417,H*.382],[L*.444,H*.379],[L*.461,H*.399],
              [L*.435,H*.625],[L*.425,H*.651],[L*.405,H*.655],[L*.391,H*.633]],
             csz-ciSeatHW*.57,csz+ciSeatHW*.57,m(.030),.91,ciCloth);
      for (k=-1;k<=1;k+=2) {
        var faceZ=csz+k*(ciSeatHW+m(.004));
        ciPiping(ciCushSec,faceZ,ciStitch,.86);
        ciPiping(ciBackSec,faceZ,ciStitch,.86);
        ciRingXY(L*.406,H*.379,faceZ,L*.018,H*.032,9,m(.005),ciPlastic2);
      }
      /* lumbar and cushion seams cross the woven centre panel */
      ciTube(L*.405,H*.510,csz-ciSeatHW*.55,L*.423,H*.515,csz+ciSeatHW*.55,m(.0045),4,.90,ciStitch);
      ciTube(L*.495,H*.337,csz-ciSeatHW*.54,L*.580,H*.339,csz+ciSeatHW*.54,m(.0045),4,.90,ciStitch);
      for (k=-1;k<=1;k+=2)
        ciTube(L*.415,H*.671,csz+k*m(.071),L*.410,H*.746,csz+k*m(.071),m(.008),5,.92,ciMetal);
      ciSoftSlab([[L*.371,H*.749],[L*.382,H*.724],[L*.424,H*.724],[L*.440,H*.747],
              [L*.435,H*.810],[L*.421,H*.834],[L*.380,H*.833],[L*.368,H*.808]],
             csz-m(.126),csz+m(.126),m(.040),.86,ciBolster);
      ciSoftSlab([[L*.383,H*.754],[L*.390,H*.739],[L*.416,H*.739],[L*.427,H*.754],
              [L*.423,H*.802],[L*.414,H*.817],[L*.388,H*.817],[L*.380,H*.801]],
             csz-m(.112),csz+m(.112),m(.028),.92,ciCloth);
      /* red release button at the inboard buckle */
      boxT(P.cabin,T,L*.500,H*.318,j*(ciSeatZ-ciSeatHW-m(.030)),
           m(.028),m(.038),m(.022),.92,ciRed);
    }

    /* Dashboard shell and fascia.  The instrument binnacle is on local -Z:
       local +Z is the car's right side, so this is correctly left-hand-drive. */
    ciSlab([[L*.675,H*.430],[L*.807,H*.445],[L*.794,H*.592],[L*.692,H*.625]],
           -ciInner*.97, ciInner*.97, .86, ciPlastic);
    ciSlab([[L*.675,H*.452],[L*.708,H*.462],[L*.700,H*.565],[L*.662,H*.557]],
           -ciInner*.83, ciInner*.83, .78, ciPlastic2);
    var ciDriverZ = -ciInner * .49;
    ciSlab([[L*.667,H*.535],[L*.718,H*.545],[L*.710,H*.648],[L*.656,H*.630]],
           ciDriverZ-m(.245), ciDriverZ+m(.245), .88, ciPlastic);
    /* two recessed gauges, centre display, four vents and glovebox edge */
    for (j = -1; j <= 1; j += 2)
      boxT(P.cabin, T, L*.660, H*.575, ciDriverZ+j*m(.092),
           m(.010), m(.062), m(.064), .82, ciScreen);
    boxT(P.cabin, T, L*.659, H*.548, 0, m(.011), m(.075), m(.118), .82, ciScreen);
    for (j = 0; j < 4; j++) {
      var ciVZ = lerp(-ciInner*.77, ciInner*.77, j/3);
      boxT(P.cabin, T, L*.674, H*.565, ciVZ, m(.010), m(.040), m(.090), .72, ciCarpet);
      for (k = -1; k <= 1; k++)
        ciTube(L*.663,H*.565+k*m(.018),ciVZ-m(.072), L*.663,H*.565+k*m(.018),ciVZ+m(.072),
               m(.0035), 4, .72, ciPlastic2);
    }
    ciTube(L*.665,H*.475,ciInner*.12, L*.665,H*.475,ciInner*.82,
           m(.006), 4, .60, ciCarpet);

    /* Steering column, leather rim, three spokes and horn pad. */
    var ciSWX = L*.607, ciSWY = H*.525, ciSWR = m(.185);
    ciTube(L*.688,H*.500,ciDriverZ, ciSWX,H*.505,ciDriverZ,
           m(.026), 7, .86, ciPlastic2, m(.018));
    ciRing(ciSWX, ciSWY, ciDriverZ, ciSWR, 14, m(.014), .20, ciPlastic);
    for (j = 0; j < 3; j++) {
      var ciA = (-Math.PI*.5) + j * TAU/3;
      ciTube(ciSWX,H*.520,ciDriverZ,
             ciSWX+Math.cos(ciA)*ciSWR*.70*.20,
             ciSWY+Math.cos(ciA)*ciSWR*.70,
             ciDriverZ+Math.sin(ciA)*ciSWR*.70,
             m(.011), 5, .90, ciPlastic2);
    }
    boxT(P.cabin, T, ciSWX, ciSWY, ciDriverZ,
         m(.035), m(.075), m(.090), .88, ciPlastic2);

    /* Centre console: shifter boot, lever, handbrake and twin cup holders. */
    ciSlab([[L*.470,H*.245],[L*.632,H*.245],[L*.640,H*.365],[L*.486,H*.350]],
           -sh.hW*.105, sh.hW*.105, .80, ciPlastic);
    ciSlab([[L*.566,H*.346],[L*.610,H*.350],[L*.600,H*.397],[L*.556,H*.392]],
           -m(.105), m(.105), .78, ciCarpet);
    ciTube(L*.581,H*.390,0, L*.595,H*.485,0, m(.012), 6, .88, ciMetal, m(.009));
    boxT(P.cabin, T, L*.597,H*.493,0,m(.035),m(.045),m(.052),.88,ciPlastic2);
    ciTube(L*.488,H*.370,m(.060), L*.545,H*.405,m(.060),m(.014),6,.84,ciPlastic2);
    ciRingH(L*.515,H*.371,-m(.080),m(.052),10,m(.007),ciCarpet);
    ciRingH(L*.515,H*.371, m(.080),m(.052),10,m(.007),ciCarpet);

    /* Pedals and the small rear-view mirror are the bright mechanical cues
       that keep the revealed cabin from reading as upholstered scenery. */
    for (j = 0; j < 3; j++)
      boxT(P.cabin, T, L*(.716+j*.010), H*(.265+j*.018), ciDriverZ+m(.09-j*.09),
           m(.030), m(.050), m(.028), .62, ciMetal);
    boxT(P.cabin, T, L*.695,H*.775,0,m(.018),m(.060),m(.155),.88,ciPlastic);
    boxT(P.cabin, T, L*.680,H*.775,0,m(.008),m(.047),m(.132),.88,[.22,.255,.270]);

    /* Door cards, padded armrests, pull handles and belt webbing.  They sit
       7-10 cm inside the sheet metal, so the far-side card is visible through
       a broken near window while the near card still has a believable cap. */
    for (j = 0; j < 2; j++) {
      var ciGs = j ? 1 : -1;
      var ciDZ = ciGs * ciInner * .985;
      quadT(P.cabin, T, [L*.205,H*.245,ciDZ], [L*.700,H*.245,ciDZ],
            [L*.700,H*.545,ciDZ], [L*.205,H*.545,ciDZ],
            L*.45,H*.42,0,.74,ciPlastic);
      boxT(P.cabin,T,L*.485,H*.430,ciDZ-ciGs*m(.038),L*.150,m(.035),m(.046),.82,ciBolster);
      ciTube(L*.600,H*.455,ciDZ-ciGs*m(.070), L*.655,H*.490,ciDZ-ciGs*m(.070),
             m(.012),6,.86,ciMetal);
      /* front three-point belt and rear shoulder belt */
      quadT(P.cabin,T,[L*.455,H*.690,ciDZ-ciGs*m(.055)],[L*.468,H*.690,ciDZ-ciGs*m(.055)],
            [L*.525,H*.355,ciGs*(ciSeatZ+ciSeatHW*.78)],[L*.512,H*.355,ciGs*(ciSeatZ+ciSeatHW*.78)],
            ciRef[0],ciRef[1],ciRef[2],.70,[.085,.090,.095]);
      quadT(P.cabin,T,[L*.205,H*.645,ciDZ-ciGs*m(.050)],[L*.218,H*.645,ciDZ-ciGs*m(.050)],
            [L*.280,H*.355,ciGs*ciRearZ*.82],[L*.267,H*.355,ciGs*ciRearZ*.82],
            ciRef[0],ciRef[1],ciRef[2],.68,[.085,.090,.095]);
    }
    /* Warm-grey headliner and two sun visors, set just below the roof skin. */
    quadT(P.cabin,T,[c1*L+H*.025,yR1-H*.055,-rwC1*.88],[c2*L-H*.035,yR2-H*.055,-rwC2*.88],
          [c2*L-H*.035,yR2-H*.055,rwC2*.88],[c1*L+H*.025,yR1-H*.055,rwC1*.88],
          ciRef[0],ciRef[1],ciRef[2],.78,[.280,.278,.265]);
    for (j = -1; j <= 1; j += 2)
      boxT(P.cabin,T,L*.685,H*.715,j*ciInner*.46,L*.070,m(.018),m(.150),.82,[.245,.242,.232]);

    /* ==================================================================
       4  PANEL BREAKS.  Shut lines round the doors, the bonnet and the
       boot: a 12 mm dark groove standing a hair proud of the flank.  At
       three metres these are two pixels each and they are most of what
       separates a car from an extruded block.
       ================================================================== */
    /* 9 mm of half width, not 6.5.  At the harness's 520 px the whole car is
       500 px long, i.e. 8.3 mm per pixel, so the old 13 mm groove was 1.5 px
       and sampled as a dotted grey line; 18 mm is a solid two.  ao 0.50, not
       0.62: 01-side-owner's door cuts measure 0.30 of the panel either side of
       them and the old 0.62 x trimDark came out at 0.09 against a flank that
       renders near 0.38 -- readable in a still, invisible at three metres. */
    var SHW = m(0.009), OUT = m(0.007);
    P.trim.tile(T_TRIM).macro(0);
    /* A shut line is 7 mm proud of the skin, so once the skin has a section it
       has to be offset ALONG THE SECTION NORMAL, chain by chain.  The previous
       pass drew it as one flat strip at hw + OUT, which on a body that now
       turns 85 mm under at the sill would have left it hanging in mid air. */
    var _ss = new Array(NJ);
    /* tTop, when given, RAKES the cut: the station is lerped from tt at the
       bottom of the flank to tTop at the deck.  A door shut is only vertical on
       a slab-sided van -- 01-side-owner puts the front door's cut at photo x
       424 down by the sill and x 400 up at the belt, i.e. it leans FORWARD by
       85 mm over its height, and drawing it straight is what forced the old
       A-post cut out to 0.794 where it sliced across the front wheel arch. */
    function shutV(tt, sg3, tTop) {
      if (sh.deck(tt) - sh.bottom(tt) < 0.1) return;
      carSection(sh, tt, sh.hw(tt), ROWS, _ss);
      var top = ROWS.nF + ROWS.nS - 1, kk;
      var tT = (tTop == null) ? tt : tTop;
      var yb = sh.bottom(tt), yd = Math.max(sh.deck(tt) - yb, 1e-4);
      for (kk = 0; kk < top; kk++) {
        var A = _ss[kk], B = _ss[kk + 1];
        var dy = B[0] - A[0], dz = B[1] - A[1];
        var ln = Math.sqrt(dy * dy + dz * dz) || 1;
        var ay = A[0] - dz / ln * OUT, az = sg3 * (A[1] + dy / ln * OUT);
        var by = B[0] - dz / ln * OUT, bz = sg3 * (B[1] + dy / ln * OUT);
        var xa = lerp(tt, tT, clamp((A[0] - yb) / yd, 0, 1)) * L;
        var xb = lerp(tt, tT, clamp((B[0] - yb) / yd, 0, 1)) * L;
        quadT(P.trim, T, [xa - SHW, ay, az], [xa + SHW, ay, az],
              [xb + SHW, by, bz], [xb - SHW, by, bz], refX, refY, 0, 0.50, trimDark);
      }
    }
    function shutH(tt, z0, z1) {
      var kk, nq = 3;
      for (kk = 0; kk < nq; kk++) {
        var za = lerp(z0, z1, kk / nq), zb = lerp(z0, z1, (kk + 1) / nq);
        var ya = sh.deckY(tt, za) + OUT, yb = sh.deckY(tt, zb) + OUT;
        quadT(P.trim, T, [tt * L - SHW, ya, za], [tt * L + SHW, ya, za],
              [tt * L + SHW, yb, zb], [tt * L - SHW, yb, zb], refX, 0, 0, 0.66, trimDark);
      }
    }
    function shutL(t0, t1, zv) {
      var y0 = sh.deckY(t0, zv) + OUT, y1 = sh.deckY(t1, zv) + OUT;
      quadT(P.trim, T, [t0 * L, y0, zv - SHW], [t1 * L, y1, zv - SHW],
            [t1 * L, y1, zv + SHW], [t0 * L, y0, zv + SHW], refX, 0, 0, 0.66, trimDark);
    }
    for (j = 0; j < 2; j++) {
      var sd = j ? 1 : -1;
      /* THE FRONT DOOR'S LEADING CUT.  It is a DOOR shut, not a wing shut, and
         on this car it comes down immediately behind the front arch: the arch
         spans tF +/- aR/L = 0.694 to 0.873, and 01-side-owner puts the cut at
         t 0.700 at the sill raking forward to dloTip 0.745 at the belt.  The
         old c3 - (c3-c2)*0.06 = 0.794 was the COWL station -- dead centre of
         the wheel opening -- so the car carried a black line straight down
         through the middle of its own front wheel. */
      /* 0.700 -> 0.724 and not -> dloTip 0.745.  Raking the cut all the way to
         where the DLO closes gave 190 mm of lean over the door's height and it
         read as a slanted line; 05-side-dealer measures about 40 mm.  0.024 of
         L = 100 mm, which is as far as the rake can go before the foot of the
         cut climbs onto the front arch (its trailing edge is tF - aR/L =
         0.694) and stops reaching the sill.  The 20 mm that is left over
         between 0.724 and dloTip is not an error -- it is the sail panel. */
      shutV(0.700, sd, S.dloTip != null ? S.dloTip - 0.008 : 0.724);
      if (S.doors >= 4)                                  /* B-post            */
        shutV(S.paneSplit ? S.paneSplit[1] : lerp(c1, c2, 0.50), sd);
      shutV(c0 + (c1 - c0) * 0.10, sd);                  /* rear door / quarter */
      /* The slider's trailing shut.  It IS the C pillar: 01-side-owner has the
         cut and the pillar on one line at photo x 968 = t 0.190 = paneSplit[0],
         and the +0.010 the previous pass carried put it 42 mm forward of the
         pillar, so the quarter read as two panels with a sliver between. */
      if (S.paneSplit) shutV(S.paneSplit[0] + 0.002, sd);
      /* THE FUEL FLAP, on the nearside rear quarter.  It is ROUND -- a 144 mm
         disc, measured off 01-side-owner at photo x 1030-1070 -- and the old
         140 mm SQUARE boxT read as a service hatch.  Two flat 12-gons: a dark
         one for the gap the flap sits in, and a body-tone one 3 mm proud of it
         for the flap itself, each vertex carried out on beam() so the disc
         follows the section instead of sinking into it at top and bottom. */
      /* WHICH FLANK.  Local +x is the nose and +y is up, so right = x cross y =
         +z; the flap used to be emitted on sd > 0, i.e. the car's RIGHT.  Both
         side photographs are of the car's LEFT -- 01-side-owner shows the
         steering wheel through the near door glass and this is a Turkish LHD
         car -- and the filler is in them, so the real one is on the LEFT.
         That is also the only flank the street ever shows: CARPLAN parks this
         car at yaw 180, which turns its left side to the road and puts its
         right side 0.5 m off a garden wall (the sideoff frame is nothing but
         brickwork).  A filler on sd > 0 was geometry nobody could ever see. */
      if (sd < 0) {
        var ft = S.fuelT != null ? S.fuelT : lerp(c0, c1, 0.42);
        var fy = lerp(sh.rock(ft), sh.belt(ft), S.fuelY != null ? S.fuelY : 0.66);
        var fR = m(0.078), fGap = [], fLid = [], fA, fCy, fCz;
        for (k = 0; k < 12; k++) {
          fA = k / 12 * Math.PI * 2;
          fCy = fy + Math.sin(fA) * fR;
          fCz = sh.hw(ft) * sh.beam(fCy);
          fGap.push(T(ft * L + Math.cos(fA) * fR, fCy, sd * (fCz + m(0.003))));
          fCy = fy + Math.sin(fA) * fR * 0.86;
          fCz = sh.hw(ft) * sh.beam(fCy);
          fLid.push(T(ft * L + Math.cos(fA) * fR * 0.86, fCy, sd * (fCz + m(0.007))));
        }
        var fRef = T(refX, refY, 0);
        poly(P.trim, fGap, fRef[0], fRef[1], fRef[2], 0.34, [0.085, 0.084, 0.082]);
        poly(P.body, fLid, fRef[0], fRef[1], fRef[2], 0.96, tone);
      }
    }
    shutH(c3 + (1 - c3) * 0.05, -sh.gw(c3) * 0.90, sh.gw(c3) * 0.90);   /* bonnet rear  */
    shutH(c0 - c0 * 0.10, -sh.gw(c0) * 0.90, sh.gw(c0) * 0.90);         /* boot front   */
    shutL(c3 + (1 - c3) * 0.06, 0.965, -sh.gw(0.9) * 0.90);
    shutL(c3 + (1 - c3) * 0.06, 0.965, sh.gw(0.9) * 0.90);
    shutL(0.035, c0 - c0 * 0.12, -sh.gw(0.1) * 0.90);
    shutL(0.035, c0 - c0 * 0.12, sh.gw(0.1) * 0.90);

    /* ==================================================================
       5  BUMPERS, LAMPS, GRILLE, PLATES.
       ================================================================== */
    var bumpY = lerp(sh.rock(0.5), sh.belt(0.99), 0.44);
    var bumpH = m(0.062 + 0.070 * (1 - sh.box));
    /* A chrome bumper is a MIRROR, and what a horizontal mirror on the front
       of a car sees under a flat overcast is mostly tarmac.  Rendering it at
       the 0.80 the trim chrome uses put it within 2 % of a white Sahin's
       paint, so the bumper -- the one hard horizontal that breaks a nose --
       disappeared completely.  0.44 with the box's own top face left to catch
       the dome is what the reference plates show. */
    /* bodyBumper: a modern car's bumpers are painted panels a shade under the
       body (the moulding never quite matches the steel), not the dark grey
       plastic of the 90s hatch -- the photographs show silver to the sill. */
    var bcol = S.chrome ? [0.440, 0.443, 0.448]
             : S.bodyBumper ? [S.col[0] * 0.86, S.col[1] * 0.86, S.col[2] * 0.86]
                            : [S.col[0] * 0.42 + 0.030, S.col[1] * 0.42 + 0.030, S.col[2] * 0.42 + 0.030];

    /* ---- THE COURIER'S FACE, off 03-front-square.png -------------------
       Ruler calibrated on the body width (1764 mm across the wings) with
       the ground line dropped from the tyre contact patch; ±15 mm.  Every
       height below is millimetres above the ground written as a fraction
       of H (1723 mm on this spec) so the face travels if anyone rescales:

         806  sh.deck(1), the bonnet's leading edge  (photo says 791 at the
              centreline -- the real shut line RISES ~90 mm out over the
              wings, which sh.deck() cannot do, so the model's nose top is
              flat at 806 and every lamp corner below has to respect that)
         723  the blue oval, on the body-colour cross-bar ABOVE the grille.
              This is the PRE-FACELIFT car (SPEC-FACTORY §7.1); MY2018 moved
              the badge down into an enlarged grille.
         659  the top of the grille opening -- which is sh.belt(1) (654) to
              within 5 mm.  Not a coincidence: the opening starts exactly
              where the nose's shoulder radius ends.
         428  the bottom of the opening        (231 mm of aperture, not 430)
         572  the bumper moulding's shut line where it passes the wings
         326 / 194  the number plate, on the bumper face below the grille
         174 / 110  the lower intake slot, BELOW the plate  (SPEC §7.3)
         223  the fog pockets, 704 mm out from the centreline
         790 / 602  the headlamp where it turns the corner; 728 / 665 at its
              inboard tip, where it tapers to a point beside the oval bar

       Plan half-widths, from the same plate: 522 mm at the top of the
       grille, 461 at the bottom (a 12 % taper, WIDER AT THE TOP), 420 to
       the headlamp's inner tip, 882 to the widest point of the body.

       WHAT WAS HERE BEFORE, and why it went: a single boxT 520 mm deep and
       square in plan, 69 mm wider than the nose at bumper height and 240 mm
       wider at the bottom corners, with the grille card floating a further
       55 mm in front of it.  The hull's own end cap (see the end-face poly
       in section 1) already closes the nose from 101 mm to 806 mm in body
       colour, with the correct plan taper and the correct sill tuck, and
       01-side-owner shows the moulding sitting flush -- the leading face
       falls almost vertically with no chin standing proud of the bonnet
       lip.  So there is no bumper SOLID here at all any more: the face is
       ornament ON the cap, and the moulding is read by its shut line.  (The
       one thing the bumper does still emit is a copy of that cap, because
       section 1's is being back-face culled -- see the note in the loop.) */
    /* the half-width of an end cap at height y.  hw(t) is symmetric about
       mid-length, so hw(1) === hw(0) and this serves both ends: 802 mm at
       the waist rolling in to 719 mm at the valance, because beam()'s sill
       tuck is 10.4 % of the half width.  Anything hung on an end panel has
       to taper with this or it pokes out through the bottom corners. */
    function endHW(y) { return sh.hw(1) * sh.beam(y); }
    var fGrT = H * 0.3825, fGrB = H * 0.2484;     /* grille 659 / 428 mm     */
    var fGrHW = sh.hW * 0.592;                    /* 522 mm at its top edge  */
    var fBmT = H * 0.3320;                        /* front shut line, 572 mm */
    var fFogY = H * 0.1294;                       /* fog centres, 223 mm     */

    P.trim.tile(T_TRIM).macro(0);
    for (i = 0; i < 2; i++) {
      var fr2 = i === 1;
      var bt = fr2 ? 1 : 0, bx = fr2 ? L - m(0.055) : m(0.055);
      var bw = sh.hw(bt) * 0.995;
      if (S.chrome) {
        boxT(P.trim, T, bx, bumpY, 0, m(0.075), bumpH, bw, 0.94, bcol);
        boxT(P.trim, T, bx + (fr2 ? m(0.035) : -m(0.035)), bumpY, 0,
             m(0.048), m(0.019), bw * 0.985, 0.94, trimDark);
        for (j = 0; j < 2; j++)
          boxT(P.trim, T, bx + (fr2 ? m(0.020) : -m(0.020)), bumpY + m(0.020),
               (j ? 1 : -1) * bw * 0.56, m(0.055), m(0.105), m(0.060), 0.92, bcol);
      } else if (S.bodyBumper) {
        /* A painted moulding is not a bar bolted to the end panel: it IS
           the end panel, wearing a shut line.  02/04-front34 show no step
           at all across the nose -- one continuous silver surface from the
           bonnet lip to the valance -- so the only thing emitted here is
           that shut, 10 mm wide, carried round both corners onto the wings
           in three steps so it follows the loft instead of cutting the
           chord across it (a single flat quad from the cap's edge to the
           flank would sink inside the corner and vanish). */
        /* 572 mm front; 560 mm rear.  The rear number is measured off
           06-rear34: the groove across the tail at that height is BOTH the
           top of the bumper moulding AND the bottom edge of the tailgate,
           which is why it is the one line on the back of this car that runs
           corner to corner.  It was 700 mm, which is up inside the plate. */
        var swY = fr2 ? fBmT : H * 0.3250;
        var swH = m(0.005);
        var swZ = endHW(swY) - m(0.004);
        var swX = fr2 ? L + m(0.004) : -m(0.004);
        /* ...AND ON THE NOSE THE MOULDING HAS TO BE THE END PANEL LITERALLY.
           Section 1's end-face call is
             poly(P.body, fp, L * 0.5, refY, 0, 0.94, tone)
           -- `fp` is in WORLD coordinates and the ref is in LOCAL ones, so
           the outward test is run against a point six hundred units away on
           the far side of the street.  Both caps then get the same forced
           normal, so whichever end of the car faces away from that point is
           inverted and culled by carpaint's default FrontSide.  In this bay
           that end is the NOSE: the first render of this pass showed the
           road, a shop front and both front wheel wells straight through the
           middle of the face.  The real fix is one transformed ref in
           section 1 and it is not mine to make; until it lands the bumper
           closes the nose itself, off the same carSection() outline the loft
           runs through -- so the two cannot disagree about where the corner
           is -- and 6 mm proud, so it wins whether the cap comes back or not. */
        /* WITHDRAWN.  The real fix landed: section 1 now transforms its own
           reference point with T() before handing it to poly(), so both end
           caps resolve correctly at any yaw and the nose is solid again.  The
           duplicate cap survived only as a 6 mm-proud plate across the face,
           which is exactly the flat chamfer the loft's new rounded nose corner
           was built to get rid of -- it was hiding the fix. */
        /* the shut across the end panel.  Front only gets the corner runs
           below: at 572 mm a cross-nose shut would saw straight through the
           grille opening (428-659), and 02/04-front34 show no line there
           anyway -- on this car the moulding is genuinely flush. */
        if (!fr2)
          quadT(P.trim, T, [swX, swY - swH, -swZ], [swX, swY - swH, swZ],
                [swX, swY + swH, swZ], [swX, swY + swH, -swZ],
                refX, refY, 0, 0.44, [0.076, 0.076, 0.075]);
        /* 230 mm of return onto each wing -- as far back as 04-front34-left
           carries the line before the fog pocket's shadow takes over */
        var swE = m(0.230) / L;
        for (j = 0; j < 2; j++) {
          var sws = j ? 1 : -1;
          for (k = 0; k < 3; k++) {
            var swA = fr2 ? 1 - swE * k / 3 : swE * k / 3;
            var swB = fr2 ? 1 - swE * (k + 1) / 3 : swE * (k + 1) / 3;
            var swZA = sh.hw(swA) * sh.beam(swY) + m(0.004);
            var swZB = sh.hw(swB) * sh.beam(swY) + m(0.004);
            quadT(P.trim, T, [swA * L, swY - swH, sws * swZA],
                  [swB * L, swY - swH, sws * swZB], [swB * L, swY + swH, sws * swZB],
                  [swA * L, swY + swH, sws * swZA],
                  refX, refY, 0, 0.44, [0.076, 0.076, 0.075]);
          }
        }
      } else {
        /* the 90s grey-plastic bumper is still a bar hung off the end panel */
        var bcH = (sh.belt(bt) - sh.bottom(bt)) * 0.47;
        boxT(P.trim, T, bx, sh.bottom(bt) + bcH * 0.92, 0,
             m(0.078), bcH, bw * 1.004, 0.94, bcol);
      }
      /* THE VALANCE, which exists because the panel under a chrome bumper was
         the last big blank face on the car: on a Sahin or a Kartal the bumper
         is a 124 mm bar hung across the middle of the nose, leaving 200-250 mm
         of flat body colour below it with nothing on it but road film.  Every
         car on the reference plates carries a dark plastic apron down there
         (_ref/ref4's Skoda reads 8-40 under the bumper against 145-210 on the
         nose above it) and it is 40 cm of the car's silhouette that always
         faces the camera on a kerbside row.  Two boxes per car, 24 tris.
         Legal by rule C: it sits inside the body envelope, and inside the
         bumper's own overhang, so it can move no collision anywhere. */
      if (S.chrome) {
        var vTop = bumpY - bumpH - m(0.008), vBot = sh.bottom(bt) + m(0.012);
        if (vTop - vBot > m(0.035)) {
          var vHH = (vTop - vBot) * 0.5;
          boxT(P.trim, T, bx - (fr2 ? m(0.014) : -m(0.014)), vBot + vHH, 0,
               m(0.055), vHH, bw * 0.945, 0.46,
               [0.086, 0.085, 0.083]);
          /* and the air intake let into it: a wider, darker slot, low and
             central, which is the one thing that says "front" at 20 m */
          if (fr2) {
            boxT(P.trim, T, bx - m(0.004), vBot + vHH * 0.86, 0,
                 m(0.040), vHH * 0.44, bw * 0.50, 0.30, [0.041, 0.041, 0.040]);
          }
        }
      }
      STATS.props++;
    }
    /* head and tail lamps, let into the end faces above the bumper */
    P.panel.macro(0);
    for (i = 0; i < (S.grilleBig ? 2 : 4); i++) {
      /* on a grilleBig car this loop is the TAIL pair only; the headlamps
         have their own shaped path below, because a card cannot mirror. */
      var frL = S.grilleBig ? false : i < 2, ls = (i % 2) ? 1 : -1;
      var lt = frL ? 1 : 0;
      var lhw = sh.hw(lt);
      /* a Sahin's headlamp is 0.35 m across, not half the width of the car.
         The Courier's IS nearly half the width of the car -- a 0.42 m swept
         polycarbonate unit set high on the nose -- and its tail lamps are
         upright clusters standing on the BODY beside the tailgate opening,
         not horizontal bands under the boot lid.

         ---- THE COURIER'S TAIL LAMP, measured off 06-rear34.png ----------
         Calibrated on the number plate (110 mm tall, 40 px in frame; the
         wheel gives the same 2.75 mm/px within 1 %):

           345 mm tall, 210 mm across the rear face, ~65 mm of wrap round the
           body corner.  1.6 : 1 -- a stout capsule, not a stalk.
           top    1180 mm, i.e. level with the lower edge of the tailgate
                  glass where it passes the D pillar
           bottom  840 mm, level with the TOP of the number plate, with a
                  clear 280 mm of body colour under it down to the bumper

         The old numbers were 185 x 517 mm at 0.60 of the way from the bumper
         to the deck: too narrow, half as tall again as the real unit, and
         its top poked 25 mm through sh.deck(0) into the backlight.  That is
         the thin red bar the critic saw.

         The heights are keyed to sh.deck(0) rather than to bumpY, because
         this model's tail band (bumper shut 560 -> deck 1070) is 110 mm
         shorter than the real car's (560 -> 1180): hanging the lamp off the
         TOP of the band keeps it in the corner where it belongs and spends
         the missing 110 mm on the body colour below it instead.  315 mm of
         lamp, top 20 mm under the shoulder crease. */
      var lw = lhw * (frL ? (S.grilleBig ? 0.300 : 0.215)
                          : (S.lampTall ? 0.131 : 0.245));
      var lh = H * (frL ? (S.grilleBig ? 0.072 : 0.052)
                        : (S.lampTall ? 0.0915 : 0.066));
      var ly = (!frL && S.lampTall) ? sh.deck(0) - H * 0.008 - lh
             : lerp(bumpY + bumpH, sh.deck(lt),
                    frL ? (S.grilleBig ? 0.55 : 0.44) : 0.40);
      /* outboard edge ON the corner: hw alone over-reads the section by the
         beam() tuck, and a lamp hung 15 mm outside its own body panel is a
         floating card from every three-quarter view. */
      var lz = ls * ((!frL && S.lampTall)
                     ? lhw * sh.beam(ly) - m(0.006) - lw
                     : lhw - lw - m(0.040));
      var lc = T(lt * L + (frL ? m(0.030) : -m(0.018)), ly, lz);
      var uz2 = dirT(T, 0, 0, lw);
      var uy2 = dirT(T, 0, lh, 0);
      card(P.panel, lc[0], lc[1], lc[2], uz2[0], uz2[1], uz2[2], uy2[0], uy2[1], uy2[2],
           PANEL.rect[frL ? S.lampF : (S.lampTall ? P_LAMPRC : S.lampR)],
           [0.80, 0.80, 0.79], 1.0,
           dirT(T, frL ? 1 : -1, 0, 0));
      /* THE WRAP.  On this car the cluster turns the corner -- 01-side-owner
         and 05-side-dealer both carry a red sliver on the quarter panel
         ahead of the tail, and without it the lamp is a decal stuck on a
         flat plate and the corner has no lamp in it at all from the side.
         On P.body, so it takes the same clearcoat sky the lens on the cap
         does -- and so its red is the same red. */
      if (!frL && S.lampTall) {
        /* 100 mm of it, measured on 05-side-dealer: the sliver on the quarter
           is a fifth of the lamp's own width and it keeps almost all of its
           height -- 0.80 at the leading edge, not the 0.60 the first pass
           used, which read as a wedge rather than a wrap.  The clear band
           carries across too, because in that photograph the white middle of
           the cluster is the one thing on the flank you can see from 20 m. */
        var wpT = m(0.100) / L, wpH = lh * 0.80;
        var wpZ0 = lhw * sh.beam(ly) + m(0.004);
        var wpZ1 = sh.hw(wpT) * sh.beam(ly) + m(0.004);
        quadT(P.body, T, [0, ly - lh, ls * wpZ0], [wpT * L, ly - wpH, ls * wpZ1],
              [wpT * L, ly + wpH, ls * wpZ1], [0, ly + lh, ls * wpZ0],
              refX, refY, 0, 1.0, [0.285, 0.052, 0.046]);
        /* the clear band, at the tile's own 0.46-0.685 of the lens height
           measured DOWN from the top, so the wrap and the card cannot
           disagree about where the indicator is */
        quadT(P.body, T, [0, ly - lh * 0.37, ls * (wpZ0 + m(0.002))],
              [wpT * L, ly - lh * 0.30, ls * (wpZ1 + m(0.002))],
              [wpT * L, ly + lh * 0.06, ls * (wpZ1 + m(0.002))],
              [0, ly + lh * 0.08, ls * (wpZ0 + m(0.002))],
              refX, refY, 0, 1.0, [0.560, 0.556, 0.535]);
      }
    }
    /* ---- THE HEADLAMPS ------------------------------------------------
       A big swept teardrop: a narrow point inboard beside the oval bar,
       swelling as it goes out, turning the corner at full depth and dying
       to a point on the wing (that last part is the lampWrap quad in
       section 6).  It is NOT a card, and it cannot be: card() flips `u`
       against the `face` hint (2733-2737), so one call with face = +x
       always lands the tile the same way round in WORLD space and the two
       lamps come out translated, not mirrored -- which is why the old pair
       showed P_LAMPF2's amber corner pointing outboard on one side and
       inboard on the other (the yellow block).  quadT takes local
       coordinates and mirrors for free, so the lamp is emitted as an
       outline that is inset twice -- a near-black bezel, the clear lens
       inside it -- plus two reflector rectangles.

       Corner top 795, NOT the 866 the photograph measures: that part of the
       real lamp is already round the corner on a wing whose shut line has
       risen, and sh.deck(1) caps this nose flat at 806, so 11 mm of body
       colour is all that is left above it.
       The outline is THREE stations, not two, because a two-station wedge
       is a triangle and read as a chevron: the real lamp bellies out
       through its middle and only then runs to the corner.  z/bottom/top:
         420   670  730   the inboard tip beside the oval bar
         612   608  792   the belly
         780   570  795   the corner, where the lampWrap takes over        */
    var LZ = [sh.hW * 0.476, sh.hW * 0.694, endHW(H * 0.3308) - m(0.005)];
    var LB = [H * 0.3888, H * 0.3529, H * 0.3308];
    var LT = [H * 0.4237, H * 0.4597, H * 0.4614];
    var lcY = 0, lcZ = 0;
    for (k = 0; k < 3; k++) { lcY += LB[k] + LT[k]; lcZ += LZ[k] * 2; }
    lcY /= 6; lcZ /= 6;
    /* [inset toward that centroid, x proud, paint pile?, tone, ao].
       The first pass made the lens [0.56,0.60,0.64], which on a Moondust
       body of [0.52,0.53,0.54] is the SAME VALUE: the lens vanished into the
       paint and all that was left of the lamp was its bezel, i.e. a grey
       triangle.  A halogen unit on a silver car reads a good stop DARKER
       than the paint with two bright reflectors punched through it, so the
       lens goes to a third and the bowls carry the highlight.
       The lens and the bowls go on P.body, not P.glass.  Measured off the
       f5 render: the glass material (env 0.72, ao 0.7) lands a tone of 0.90
       at about 150 sRGB where carpaint lands 0.52 at 215, i.e. glass is
       three times darker for the same number.  A lens asked for 0.43 there
       came out at 77 against a 215 body -- a black hole with two windows in
       it.  Carpaint is also the right SURFACE for a lens: smooth, clearcoat,
       and it takes the same sky the paint beside it does. */
    var LRING = [[1.00, m(0.013), 0, [0.055, 0.058, 0.062], 0.50],
                 [0.93, m(0.020), 1, [0.300, 0.322, 0.350], 1.00]];
    /* the two reflectors, as plain rectangles: scaled copies of the outline
       came out as arrowheads, because a scaled copy of a leaf is a leaf.
       [z centre, y centre, z half, y half, tone] -- the big bowl inboard of
       centre and the smaller round element outboard, per SPEC §7.2. */
    var LBOWL = [[sh.hW * 0.652, H * 0.4092, m(0.050), m(0.038), [0.620, 0.635, 0.655]],
                 [sh.hW * 0.816, H * 0.4092, m(0.036), m(0.042), [0.480, 0.495, 0.515]]];
    for (i = 0; i < 2; i++) {
      var lms = i ? 1 : -1;
      for (k = 0; k < LRING.length; k++) {
        var lr = LRING[k], lz0, lz1, lb0, lb1, lt0, lt1;
        for (j = 0; j < 2; j++) {
          lz0 = lms * (lcZ + (LZ[j] - lcZ) * lr[0]);
          lz1 = lms * (lcZ + (LZ[j + 1] - lcZ) * lr[0]);
          lb0 = lcY + (LB[j] - lcY) * lr[0]; lb1 = lcY + (LB[j + 1] - lcY) * lr[0];
          lt0 = lcY + (LT[j] - lcY) * lr[0]; lt1 = lcY + (LT[j + 1] - lcY) * lr[0];
          quadT(lr[2] ? P.body : P.trim, T, [L + lr[1], lb0, lz0],
                [L + lr[1], lb1, lz1], [L + lr[1], lt1, lz1], [L + lr[1], lt0, lz0],
                refX, refY, 0, lr[4], lr[3]);
        }
      }
      for (k = 0; k < 2; k++) {
        var lbw = LBOWL[k], lbz = lms * lbw[0];
        quadT(P.body, T, [L + m(0.026), lbw[1] - lbw[3], lbz - lms * lbw[2]],
              [L + m(0.026), lbw[1] - lbw[3], lbz + lms * lbw[2]],
              [L + m(0.026), lbw[1] + lbw[3], lbz + lms * lbw[2]],
              [L + m(0.026), lbw[1] + lbw[3], lbz - lms * lbw[2]],
              refX, refY, 0, 1.0, lbw[4]);
      }
    }
    /* ---- THE GRILLE ---------------------------------------------------
       One card carrying BOTH bands of the pre-facelift face: the blue oval
       on its cross-bar at the top and the finned trapezoid below it.  The
       bar between them is left TRANSPARENT in the tile -- the panel
       material is alphaTest 0.5 (2426), so the card crops itself there and
       the nose's own paint carries the bar.  No colour to match, and the
       badge floats on body colour exactly as 03-front-square has it.

       The tile's landmarks and where they have to land (see P_GRILLEC):
         v 0.150  oval centre        ->  730 mm
         v 0.320  top of the opening ->  659 mm
         v 0.870  bottom             ->  428 mm
         u 0.045 .. 0.955  top edge  -> +-522 mm
         u 0.098 .. 0.902  bottom    -> +-461 mm
       0.550 of the cell has to span the 231 mm of aperture and 0.910 of it
       has to span the 1044 mm across its top, so the card solves out at
       1148 x 420 mm centred 583 mm up.  12 mm proud of the cap: the real
       opening is recessed, but a recessed card is a card you cannot see,
       and 12 mm is less than the depth of the chrome bezel it stands in for. */
    var ghw = sh.hw(1);
    var gCell = (fGrT - fGrB) / 0.550;            /* the cell, in car units */
    var gw2 = S.grilleBig ? fGrHW / 0.910 : ghw - 2 * (ghw * 0.215) - m(0.11);
    var gy2 = S.grilleBig ? fGrT + gCell * 0.320 - gCell * 0.5
                          : lerp(bumpY + bumpH, sh.deck(1), 0.44);
    var gc = T(L + m(S.grilleBig ? 0.012 : 0.024), gy2, 0);
    var guz = dirT(T, 0, 0, Math.max(m(0.12), gw2));
    var guy = dirT(T, 0, S.grilleBig ? gCell * 0.5 : H * 0.050, 0);
    card(P.panel, gc[0], gc[1], gc[2], guz[0], guz[1], guz[2], guy[0], guy[1], guy[2],
         PANEL.rect[S.grille],
         S.grilleBig ? [0.88, 0.88, 0.87] : [0.52, 0.52, 0.51],
         S.grilleBig ? 1.0 : 0.90, dirT(T, 1, 0, 0));
    /* the Courier's lower bumper: one wide dark intake slot low across the
       apron and a fog pocket at each corner.  Three boxes inside the cap's
       own plan outline, so rule C is untouched. */
    if (S.grilleBig && !S.chrome) {
      /* the intake: 834 x 55 mm, BELOW the plate, which is where
         SPEC-FACTORY §7.3 and the photograph both put it -- the old one was
         707 wide, 104 tall and 190 up, i.e. level with the plate.  The real
         car has it at 110-174, but this nose bottoms out at sh.bottom(1) =
         101 mm against the real bumper's ~60, so the whole lower stack has
         to be squeezed up by ~40 mm: valance lip 101-143, intake 150-205,
         plate 230-340.  Keeping the ORDER is what matters at 30 px. */
      boxT(P.trim, T, L - m(0.014), H * 0.1030, 0,
           m(0.024), H * 0.0160, sh.hW * 0.473, 0.30, [0.043, 0.043, 0.042]);
      /* the fog pockets: 124 x 90 mm dark recesses with a pale lens in
         them.  The photograph has them 704 mm out, but beam()'s sill tuck
         pulls this nose in to a 719 mm half-width down at 223 mm, so 644 is
         as far out as they can go and still land on the cap instead of
         hanging off its corner. */
      for (j = 0; j < 2; j++) {
        var fgz = (j ? 1 : -1) * (endHW(fFogY) - m(0.075));
        boxT(P.trim, T, L - m(0.012), fFogY, fgz,
             m(0.024), m(0.045), m(0.062), 0.34, [0.052, 0.052, 0.051]);
        quadT(P.body, T, [L + m(0.019), fFogY - m(0.030), fgz - m(0.032)],
              [L + m(0.019), fFogY - m(0.030), fgz + m(0.032)],
              [L + m(0.019), fFogY + m(0.030), fgz + m(0.032)],
              [L + m(0.019), fFogY + m(0.030), fgz - m(0.032)],
              refX, refY, 0, 1.0, [0.330, 0.348, 0.372]);
      }
    }
    /* cowl bundle: the black scuttle strip across the base of the screen,
       and the black lower lip along the very bottom of the front bumper --
       the two horizontal darks that anchor the Courier's face. */
    if (S.cowl) {
      var cwU = 0.055;
      var cwT = lerp(cab[3], cab[2], cwU), cwY = lerp(sh.deck(cab[3]), sh.roofYt(cab[2]), cwU);
      var cwZ0 = sh.gw(cab[3]) * 0.97, cwZ1 = lerp(sh.gw(cab[3]), sh.roofHW(cab[2]), cwU) * 0.97;
      quadT(P.trim, T, [cab[3] * L + m(0.010), sh.deck(cab[3]) + m(0.004), -cwZ0],
            [cab[3] * L + m(0.010), sh.deck(cab[3]) + m(0.004), cwZ0],
            [cwT * L + m(0.010), cwY, cwZ1],
            [cwT * L + m(0.010), cwY, -cwZ1], refX, 0, 0, 0.46, [0.058, 0.058, 0.057]);
      /* the black valance lip: 101 to 143 mm, clear of the intake slot above
         it (150-205), and tapered to the cap's own half-width at that height
         (719 mm) rather than a flat 0.90 of hw, which used to hang 3 mm
         outboard of the corner it was sitting on */
      boxT(P.trim, T, L - m(0.014), sh.bottom(1) + m(0.021), 0,
           m(0.026), m(0.021), endHW(sh.bottom(1) + m(0.021)) - m(0.010), 0.40,
           [0.056, 0.056, 0.055]);
    }
    /* the plates: white field, blue TR strip, on both bumpers.  plateHigh
       moves the REAR one up onto the tailgate between the lamps, which is
       where the Courier carries it. */
    for (i = 0; i < 2; i++) {
      var pf = i === 0;
      /* the front plate rides on the bumper face at 260 mm, in the gap
         between the grille (bottom 428) and the intake (top 174), and only
         12 mm proud -- it used to sit 420 mm up and 75 mm forward, which is
         a plate floating in the air ahead of the nose.  The rear one is
         untouched: plateHigh has it on the tailgate. */
      /* the REAR plate, off 06-rear34: it is recessed into the tailgate, not
         hung off it, so 14 mm proud and no more (it was 75 mm, a plate
         floating in the air behind the car).  749 mm, not 810: measured, the
         plate's centre sits 0.36 of the way up the tail band from the bumper
         groove to the glass, and this model's band is 110 mm short at the
         top, so 0.470 H put it level with the middle of the tail lamps. */
      var pc = T(pf ? L + m(S.grilleBig ? 0.012 : 0.075) : -m(S.plateHigh ? 0.014 : 0.075),
                 pf ? (S.grilleBig ? H * 0.1654 : bumpY + bumpH * 0.30)
                    : (S.plateHigh ? H * 0.415 : bumpY + bumpH * 0.30), 0);
      var puz = dirT(T, 0, 0, CPLATE.w * 0.5);
      var puy = dirT(T, 0, CPLATE.h * 0.5, 0);
      card(P.panel, pc[0], pc[1], pc[2], puz[0], puz[1], puz[2], puy[0], puy[1], puy[2],
           PANEL.rect[S.plate], [0.80, 0.80, 0.78], 1.0, dirT(T, pf ? 1 : -1, 0, 0));
    }

    /* ---- 5b  THE TAIL, off 06-rear34.png ------------------------------
       What the back of this car actually is, and what the previous pass had
       instead: ONE undifferentiated silver slab with two red bars on its
       corners.  Nothing on it said tailgate, nothing said bumper.

       The tailgate is a single top-hinged panel and it is enormous -- it is
       most of the back of the car -- so the only things that tell you it is
       there are its shut lines: two verticals running up just inboard of the
       lamps, and one horizontal across the bottom which doubles as the top
       of the bumper moulding (that one is emitted by the bodyBumper branch
       above at swY, and this block is keyed to the same height so the two
       cannot drift apart).

       Ruler, calibrated on the number plate (110 mm / 40 px) and confirmed on
       the rear wheel (621 mm OD / 224 px) to within 1 %.  Heights are mm
       above ground written as fractions of H = 1723:

         1180  the tail lamp's top -- the tailgate glass's lower edge at the
               D pillar.  THIS MODEL'S sh.deck(0) IS 1070, i.e. 110 mm short,
               so everything below is squeezed into the band that is left.
          859  the plate's top edge, level with the lamp's bottom
          839  the black grab / release strip, immediately over the plate
          785  the plate's centre                          (this model: 749)
          560  the tailgate's lower edge = the bumper's top groove  (0.325 H)
          460  the step between the bumper's upper face and its valance
          430  the reflectors, low and outboard              (0.248 H)
          395  the bumper's bottom edge -- below which, on the real car,
               there is nothing.  This model's end cap runs on down to 101,
               so the last 250 mm is painted as the shadow it stands for.

       All of it is flat quads on the end cap: about 300 tris for the whole
       back of the car, and the cap is a plane so none of them can be wrong
       about where the surface is. */
    P.trim.tile(T_TRIM).macro(0);
    /* a line across the tail that carries on round both corners, three
       segments a side so it follows the loft instead of cutting the chord
       across it -- the same idiom the bumper shut above uses, and for the
       same reason: a single flat quad from the cap's edge to the flank sinks
       inside the corner radius and vanishes. */
    function tailLine(yv, hh2, ao2, col2, ext) {
      /* 8 mm proud, not 5: the bumper band below is laid at 4 and a crease
         drawn in the same plane as the panel it is a crease IN z-fights. */
      var zc2 = sh.hw(0) * sh.beam(yv) - m(0.004), kk2, jj2;
      quadT(P.trim, T, [-m(0.008), yv - hh2, -zc2], [-m(0.008), yv - hh2, zc2],
            [-m(0.008), yv + hh2, zc2], [-m(0.008), yv + hh2, -zc2],
            refX, refY, 0, ao2, col2);
      if (!ext) return;
      for (jj2 = 0; jj2 < 2; jj2++) {
        var es2 = jj2 ? 1 : -1;
        for (kk2 = 0; kk2 < 3; kk2++) {
          var ta2 = ext / L * kk2 / 3, tb2 = ext / L * (kk2 + 1) / 3;
          var za2 = sh.hw(ta2) * sh.beam(yv) + m(0.004);
          var zb2 = sh.hw(tb2) * sh.beam(yv) + m(0.004);
          quadT(P.trim, T, [ta2 * L, yv - hh2, es2 * za2], [tb2 * L, yv - hh2, es2 * zb2],
                [tb2 * L, yv + hh2, es2 * zb2], [ta2 * L, yv + hh2, es2 * za2],
                refX, refY, 0, ao2, col2);
        }
      }
    }
    if (S.lampTall) {
      /* the lamp block above is re-solved here rather than read out of the
         loop's `var`s: they are function-scoped and still hold the last
         iteration, which is exactly the kind of coupling that breaks the
         moment somebody reorders the loop. */
      var tlHW = sh.hw(0), tlH = H * 0.0915;
      var tlY = sh.deck(0) - H * 0.008 - tlH;
      var tlOut = tlHW * sh.beam(tlY) - m(0.006);
      var tlIn = tlOut - tlHW * 0.262;              /* the lamp's inboard edge */
      var tgY = H * 0.3250;                         /* the tailgate's foot     */
      var SHT = m(0.006);                           /* half a shut, 12 mm      */
      /* the two tailgate shuts, 22 mm inboard of the lamps, running from the
         bumper groove up to the shoulder crease where the glass takes over */
      for (j = 0; j < 2; j++) {
        var tgS = j ? 1 : -1, tgZ = tgS * (tlIn - m(0.022));
        quadT(P.trim, T, [-m(0.005), tgY, tgZ - SHT], [-m(0.005), tgY, tgZ + SHT],
              [-m(0.005), sh.deck(0), tgZ + SHT], [-m(0.005), sh.deck(0), tgZ - SHT],
              refX, refY, 0, 0.55, trimDark);
      }
      /* the black grab / release strip over the plate.  On the real car this
         is the tailgate's handle: a recessed slot 560 x 34 mm, and it is the
         only hard dark on the middle of the tailgate, so it does the work
         the Ford oval and the script would otherwise have to. */
      quadT(P.trim, T, [-m(0.006), H * 0.4560, -m(0.250)], [-m(0.006), H * 0.4560, m(0.250)],
            [-m(0.006), H * 0.4840, m(0.250)], [-m(0.006), H * 0.4840, -m(0.250)],
            refX, refY, 0, 0.30, [0.062, 0.062, 0.061]);
      /* the bumper's step: 460 mm, a soft crease not a shut, so it is paler
         and thinner than the groove above it.  Carried 210 mm round each
         corner, which is as far as 06-rear34 tracks it before the quarter's
         own shadow takes over. */
      tailLine(H * 0.2670, m(0.006), 0.62, [0.170, 0.170, 0.168], m(0.210));
      /* the reflectors: a dark pocket with a red lens in it, low and 62 % of
         the way out to the corner.  Two quads a side; the lens goes on
         P.body for the same reason the headlamp lenses do -- carpaint is the
         surface that takes the sky, P.glass would render it three stops
         darker and it would read as a hole. */
      for (j = 0; j < 2; j++) {
        var rfS = j ? 1 : -1;
        var rfY = H * 0.2480, rfZ = rfS * sh.hw(0) * sh.beam(rfY) * 0.620;
        quadT(P.trim, T, [-m(0.008), rfY - m(0.028), rfZ - m(0.078)],
              [-m(0.008), rfY - m(0.028), rfZ + m(0.078)],
              [-m(0.008), rfY + m(0.028), rfZ + m(0.078)],
              [-m(0.008), rfY + m(0.028), rfZ - m(0.078)],
              refX, refY, 0, 0.34, [0.055, 0.055, 0.054]);
        quadT(P.body, T, [-m(0.013), rfY - m(0.017), rfZ - m(0.064)],
              [-m(0.013), rfY - m(0.017), rfZ + m(0.064)],
              [-m(0.013), rfY + m(0.017), rfZ + m(0.064)],
              [-m(0.013), rfY + m(0.017), rfZ - m(0.064)],
              refX, refY, 0, 1.0, [0.360, 0.055, 0.048]);
      }
      /* THE MOULDING ITSELF.  bodyBumper says a painted bumper is not a bar
         bolted on, it IS the panel wearing a shut line -- true on the nose,
         where 02/04 show one continuous silver surface.  The TAIL is not the
         same case: 06-rear34 has the rear moulding reading a clear stop
         darker than the tailgate above it, because it is a separate plastic
         pressing that never quite matches the steel and because it faces the
         road rather than the sky.  So the band between the groove and the
         valance is re-laid on P.body -- same carpaint, same tone closure, so
         it keeps the road film and the metallic flake -- at ao 0.86 instead
         of the cap's 0.94.  Six per cent.  It is the whole difference between
         "a bumper" and "the bottom of the tailgate". */
      var apT = H * 0.1520, apB = sh.bottom(0) + m(0.004);
      var bpZT = sh.hw(0) * sh.beam(tgY) - m(0.002);
      var bpZB = sh.hw(0) * sh.beam(apT) - m(0.002);
      quadT(P.body, T, [-m(0.004), apT, -bpZB], [-m(0.004), apT, bpZB],
            [-m(0.004), tgY, bpZT], [-m(0.004), tgY, -bpZT],
            refX, refY, 0, 0.80, tone);
      /* and under it the shadow the model has to paint because it has
         geometry the car does not: the real bumper's bottom edge is at
         395 mm and there is open air below it, but sh.bottom(0) carries this
         cap on down to 101, so the last 157 mm (105 -> 262) is filled with
         the dark it would be looking into.  Dark GREY, not black -- the
         first pass put 0.048 across 250 mm here and the tail grew a rubber
         skirt; three renders of walking it back land on 0.16 at ao 0.78,
         which is about a fifth of the paint above it.
         Tapered to the cap's own half width at each height (739 at the top,
         719 at the foot): beam()'s sill tuck is 10.4 % and a flat band would
         hang outside the bottom corners. */
      var apZT = sh.hw(0) * sh.beam(apT) - m(0.004);
      var apZB = sh.hw(0) * sh.beam(apB) - m(0.004);
      quadT(P.trim, T, [-m(0.004), apB, -apZB], [-m(0.004), apB, apZB],
            [-m(0.004), apT, apZT], [-m(0.004), apT, -apZT],
            refX, refY, 0, 0.78, [0.160, 0.157, 0.152]);
    }

    /* ==================================================================
       6  MIRRORS, WIPERS, HANDLES, AERIAL, EXHAUST, ROOF RAILS.
       ================================================================== */
    P.trim.tile(T_TRIM).macro(0);
    for (i = 0; i < 2; i++) {
      var ms = i ? 1 : -1;
      /* The rubbing strip along the flank: a flat 45 mm band, not a pipe.  On
         _ref/ref1 this is the single hardest line on the car -- 52 against 151
         above it and 137 below -- and it is what breaks the flank into an
         upper panel that holds the sky and a lower one that holds the road.
         It sits at the beam line, so it needs the section, not hw. */
      var ry = lerp(sh.rock(0.5), sh.belt(0.5), 0.56);
      var rHH = m(0.019), rlo = ry - rHH;
      /* The moulding sits BELOW the crown of the arch, exactly as it does on a
         Sahin, so it cannot run the length of the car: it has to stop at each
         opening and pick up again on the wing.  It used to be one quad end to
         end, and with the arches now genuinely cut out of the flank it hung
         across each opening as a black bar floating in front of the wheel.
         Solve the arch super-ellipse for the t at which it drops below the
         moulding and split the run there. */
      var aTot = sh.wr + sh.aH;
      var uCut = rlo < aTot
        ? Math.pow(clamp(1 - (rlo / aTot) * (rlo / aTot), 0, 1), 1 / 2.1) : 0;
      var dCut = uCut * sh.aR / L;
      var runs = [[0.085, sh.tR - dCut], [sh.tR + dCut, sh.tF - dCut],
                  [sh.tF + dCut, 0.915]];
      /* cleanFlank: the Courier carries NO black rubbing strip -- the
         reference flank is one silver surface, its only dark line the
         slider track above -- so the whole strip run is skipped. */
      for (k = 0; k < (S.cleanFlank ? 0 : 3); k++) {
        var ra2 = runs[k][0], rb2 = runs[k][1];
        if (rb2 - ra2 < 0.02) continue;
        var rz0 = sh.hw(ra2) * sh.beam(ry) + m(0.011);
        var rz1 = sh.hw(rb2) * sh.beam(ry) + m(0.011);
        /* darker than the rest of the trim on purpose: on _ref/ref1 this band
           measures 0.21 of the belt where a shut line measures 0.4, and it is
           the hardest single line on the car */
        quadT(P.trim, T, [ra2 * L, ry - rHH, ms * rz0], [rb2 * L, ry - rHH, ms * rz1],
              [rb2 * L, ry + rHH, ms * rz1], [ra2 * L, ry + rHH, ms * rz0],
              refX, refY, 0, 0.80, [0.094, 0.093, 0.091]);
      }
      /* THE SLIDING-DOOR RAIL.  On the real car this is the strongest single
         graphic on the flank -- a black cover over the roller track, running
         the whole rear quarter -- and it was invisible, for a reason worth
         writing down: it was drawn at deck + 0.010 H, i.e. ON the deck's outer
         corner, which is precisely where section 3 lays the black belt seal.
         One black line was hiding inside another.
         HEIGHT.  01-side-owner (crop _shots/flankmeas/01-quarter2.png) has the
         cover at photo y 356-378 against a glass seal at 340: its centre is
         30 px = 108 mm BELOW the seal and it is 22 px = 79 mm deep.  The seal
         is deck + dloSeal, so the centre is deck - 0.040 H and the half depth
         0.021 H.  That drops it clear of the seal and onto the quarter panel,
         where the photograph puts it.

         79 mm WAS THE SEAL AND THE GAP AND THE COVER MEASURED AS ONE THING,
         and it is why _shots/it7 has a stripe across the quarter instead of a
         detail on it.  Re-read straight off the full-size plates rather than
         off the crop, scanning the luminance row by row:

           01-side-owner, x 980-1130.  y 358 is a single dark row at 43-84 --
             that is the GLASS SEAL.  y 359-371 are 155-179, i.e. bare quarter
             panel, 13 px of it.  The cover is y 372-379, 8 px.  Scale on that
             plate is 4.18 mm/px (belt 1.065 m = 255 px), so the cover is
             33 mm and the seal is 59 mm above it.
           05-side-dealer, x 712-820.  Dark rows y 207-211, 5 px at 7.1 mm/px
             = 36 mm, against a flank of 133-140.

         So 33-43 mm, not 79.  half depth 0.021 H -> 0.0125 H puts the full
         depth at 43 mm, the top of that range, because at this render scale
         (12.5 mm/px on the 560-wide car views) 33 mm is 2.6 px and a 2-px
         black line on a moving car crawls.  Centre is untouched: the rail
         renders in the right PLACE in both it7 views, it was only too deep.

         VALUE.  railC 0.043 at ao 0.55 rendered the cover at 28-42 sRGB
         against a 215-220 flank -- 0.15 of the body, which is a hole.  Both
         plates measure it as trim: 05-side-dealer 26-45 against 133-140 flank
         is 0.26, and it is textured black PP, not paint, so it has no
         reflection to lose.  0.043 -> 0.062 and ao 0.55 -> 0.62 is x 1.63 on
         the tone, which lands ~0.26 of the (now darker) flank.

         EXTENT.  Photo x 958 -> 1145, i.e. from the slider's own trailing shut
         (t 0.196 = paneSplit[0]) back to t 0.041, where it does NOT stop
         square: the cover's underside climbs and it dies in a wedge just
         short of the tail lamp.  Two quads, run + wedge.
         13 mm proud: on the reference this band is still the darkest thing on
         the car after the glass, but only just -- see VALUE above. */
      /* SLIMMED AND LIFTED AGAIN, against _shots/it8.  Row-scanning
         car.side.png at x 502-566 the cover is 5 rows of a 105-row flank
         (163 -> 268), i.e. 4.8 % of the flank, at 32-42 sRGB against a 190
         flank -- 0.19 of the body.  Row-scanning 01-side-owner at x 972-1140
         it is 8 rows of a 218-row flank, 3.67 %.  So the render's rail is a
         THIRD too deep in proportion, and in car.rear34 the foreshortening
         stacks that extra depth into the black slab the critic calls a hole.

           sHH  0.0125 H -> 0.0096 H.  Full depth 43 mm -> 33 mm, which is the
                33 mm this comment already measured off the plate and then
                declined to use for fear of a 2-px line crawling.  The answer
                to a thin line crawling is not to make it thick, it is to make
                it lighter: contrast is what aliases, and 0.19 of the body at
                5 px was aliasing anyway.
           railC 0.062 -> 0.072 and ao 0.62 -> 0.68, x 1.27 on the tone.  With
                the flank now landing near 150 rather than 190 (see col), that
                takes the cover from 0.19 of the body to ~0.33 -- inside the
                0.20-0.34 that 05-side-dealer measures (26-45 against a 133-140
                flank) and reading as the textured black PP moulding it is
                rather than as a slot cut through the panel. */
      if (S.slider) {
        var sy = sh.deck(0.14) - H * 0.040, sHH = H * 0.0096;
        var st1 = (S.paneSplit ? S.paneSplit[0] : c1 + (c2 - c1) * 0.32) + 0.006;
        var sBm = sh.beam(sy), sPr = m(0.015);
        var railC = [0.072, 0.072, 0.073];
        /* SIX STATIONS, and the reason is a trap anything long on this flank
           falls into.  hw(t) is NOT constant back here: planK eases the plan
           in to 0.910 of the mid-body over the last 10.5 % of the length, on a
           smoothstep.  A single quad from 0.078 to 0.196 is a CHORD across
           that curve, and a chord across a convex curve lies inside it -- 9 mm
           inside at t = 0.11, against 13 mm of proud.  The rail was being
           swallowed by the body over a third of its length and rendered as two
           black bars with a silver notch between them.  Stationing it every
           2.8 % of L keeps every segment within a millimetre of the skin.
           The last two stations also carry the WEDGE: the top edge stays put
           and the bottom edge climbs, so the cover dies in a point beside the
           tail lamp exactly as 01-side-owner shows it. */
        /* THE WEDGE, re-cut.  sRK 0.30 at t 0.034 means the cover still has
           60 % of its depth left at the point where 01-side-owner shows it
           dying, and it reaches full depth by t 0.092 -- so 5.8 % of L carries
           the taper and the other 10 % is a full-depth bar.  Seen square on
           that is merely blunt; seen from car.rear34 the tail end is the part
           nearest the camera AND the part most foreshortened along x, so the
           blunt end piles up into the heavy dark wedge the critic reports
           beside the tail lamp.  0.06 / 0.34 / 0.72 / 0.94 / 1 / 1 brings the
           cover to a near point at t 0.034 and spreads the taper over 9 % of
           L, which is the run the photograph gives it (the underside climbs
           from x 1140 and the cover is gone by x 1152, the tail-lamp edge). */
        var sRT = [0.034, 0.062, 0.092, 0.124, 0.160, st1];
        var sRK = [0.06, 0.34, 0.72, 0.94, 1.00, 1.00];
        for (k = 0; k < 5; k++) {
          var sra = sRT[k], srb = sRT[k + 1];
          if (srb - sra < 0.004) continue;
          var sza = sh.hw(sra) * sBm + sPr, szb = sh.hw(srb) * sBm + sPr;
          quadT(P.trim, T,
                [sra * L, sy + sHH - 2 * sHH * sRK[k], ms * sza],
                [srb * L, sy + sHH - 2 * sHH * sRK[k + 1], ms * szb],
                [srb * L, sy + sHH, ms * szb], [sra * L, sy + sHH, ms * sza],
                refX, refY, 0, 0.68, railC);
        }
      }
      /* the black sill cladding under the doors -- the photographs carry a
         dark rocker band the full width between the arches, and it is what
         seats the body visually onto its shadow.  Same arch-solve as the
         rubbing strip, at its own height. */
      if (S.sillClad) {
        /* THE SILL IS NOT A SKIRT.  01-side-owner (crop
           _shots/flankmeas/01-sill.png) measures the dark band under the doors
           at photo y 565-601 -- 36 px = 130 mm -- and everything above it, all
           the way up to the door moulding, is plain silver.  The old band ran
           127 mm up from the rocker in [0.052] at ao 0.42, i.e. 0.022 against
           a body that renders near 0.38 down there once bodyAO has had its
           way: a black skirt bolted to the car, and with the flank otherwise
           bare it was the first thing the eye found.
           Now 112 mm of DARK GREY (it is unpainted PP on the real car, not
           paint, so it sits well above black) at ao 0.55, with a body-colour
           STEP lipped over its top edge -- the sill's own turn-under catching
           the sky, which is what stops the join reading as the bottom of the
           car and starts it reading as a moulding sitting on the car. */
        var scTop = sh.rockY + m(0.100), scBot = sh.rockY - m(0.012);
        var scTot = sh.wr + sh.aH;
        var scCut = scTop < scTot
          ? Math.pow(clamp(1 - (scTop / scTot) * (scTop / scTot), 0, 1), 1 / 2.1) * sh.aR / L : 0;
        var scRuns = [[0.075, sh.tR - scCut], [sh.tR + scCut, sh.tF - scCut],
                      [sh.tF + scCut, 0.930]];
        var scStep = scTop + m(0.026);
        for (k = 0; k < 3; k++) {
          var sca = scRuns[k][0], scb = scRuns[k][1];
          if (scb - sca < 0.02) continue;
          var scz0 = sh.hw(sca) * sh.beam(scTop) + m(0.006);
          var scz1 = sh.hw(scb) * sh.beam(scTop) + m(0.006);
          quadT(P.trim, T, [sca * L, scBot, ms * scz0], [scb * L, scBot, ms * scz1],
                [scb * L, scTop, ms * scz1], [sca * L, scTop, ms * scz0],
                refX, refY, 0, 0.55, [0.074, 0.073, 0.072]);
          /* the step: body colour, unshadowed, 26 mm of it.  ao 1.15 against
             the hull's own bodyAO (0.25 + 0.75*sqrt(u), so ~0.55 at the sill)
             is what makes it a highlight rather than another flat band. */
          var scs0 = sh.hw(sca) * sh.beam(scStep) + m(0.004);
          var scs1 = sh.hw(scb) * sh.beam(scStep) + m(0.004);
          quadT(P.body, T, [sca * L, scTop, ms * scz0], [scb * L, scTop, ms * scz1],
                [scb * L, scStep, ms * scs1], [sca * L, scStep, ms * scs0],
                refX, refY, 0, 1.15, tone);
        }
      }
      /* ================= THE TWO CREASES =================
         A flank with no creases is a plate, and this one was a plate.  The
         hull is a smooth loft: every normal along the side of the car points
         the same way, so a car that is "a mirror of a gradient" has exactly
         one value on it from sill to belt.  What the photographs carry, and
         what the model did not, is two horizontal breaks in that gradient:

           the SHOULDER, at the foot of the shoulder radius (sh.belt), a soft
           swage running the whole length of the body -- 01-side-owner shows it
           as a tone change at photo y ~417, about 230 mm under the glass seal,
           carried from the tail lamp right through to the front wing;

           the DOOR MOULDING, the pressed swage across the door skins.  It is
           NOT the black rubbing strip the fleet's other cars wear: crop
           _shots/flankmeas/01-sill.png shows a BODY-COLOUR moulding, a bright
           top face at photo y 494 and a soft shadow under it to y 520, i.e. a
           95 mm band centred 604 mm below the glass seal = 510 mm off the
           ground, running photo x 378-831 (t 0.700 -> 0.309) and tapering to a
           point at each end.  The old strip was m(0.415), 36 mm deep and
           [0.070] black -- 95 mm too low and the wrong colour entirely.

         Both are drawn the same way and it is the only way a flat quad can
         fake a crease: a LIGHT face above the line and a DARK face below it.
         The top face of a swage turns up into the sky and the under-face turns
         down into the road, and since a quadT on the flank has a horizontal
         normal it cannot get that from the lighting -- so it is put in by
         hand, ao 1.15 over ao 0.52, on P.body in the paint tone so the pair
         moves with the body colour and the road film. */
      var crK = [0.0, 1.0, 1.0, 0.0];            /* taper, run, run, taper     */
      if (S.doorStrip) {
        var dmY = m(0.510), dmT = m(0.017), dmB = m(0.032);
        /* the rear end runs to 0.276, which is the rear arch's own leading edge
           (tR + aR/L = 0.274): the reference carries the moulding right into
           the arch lip, and stopping at 0.300 left a visible 100 mm of bare
           silver between the taper and the wheel. */
        var dmS = [0.276, 0.332, 0.652, 0.706];
        for (k = 0; k < 3; k++) {
          var dma = dmS[k], dmb = dmS[k + 1], dka = crK[k], dkb = crK[k + 1];
          var dmz0 = sh.hw(dma) * sh.beam(dmY) + m(0.009);
          var dmz1 = sh.hw(dmb) * sh.beam(dmY) + m(0.009);
          quadT(P.body, T, [dma * L, dmY, ms * dmz0], [dmb * L, dmY, ms * dmz1],
                [dmb * L, dmY + dmT * dkb, ms * dmz1], [dma * L, dmY + dmT * dka, ms * dmz0],
                refX, refY, 0, 1.15, tone);
          quadT(P.body, T, [dma * L, dmY - dmB * dka, ms * dmz0],
                [dmb * L, dmY - dmB * dkb, ms * dmz1],
                [dmb * L, dmY, ms * dmz1], [dma * L, dmY, ms * dmz0],
                refX, refY, 0, 0.52, tone);
        }
      }
      /* THE SHOULDER.  Four stations so it can follow sh.belt(t), which lifts
         over the boot and falls away with the bonnet; it stops at c3 because
         forward of the cowl sh.belt is tracking the bonnet down to 0.65 m and
         a crease there would run off the wing and into the headlamp.  Sits at
         the foot of the shoulder radius, where the section already has its
         tangent break, so hw*beam is exact and nothing floats. */
      /* The two extra stations at 0.098 / 0.150 are the same planK trap the
         slider rail fell into: a chord from 0.060 straight to 0.230 sits 21 mm
         inside the skin at t = 0.105 against 7 mm of proud, so the crease
         simply vanished along the whole rear quarter. */
      var shS = [0.060, 0.098, 0.150, 0.230, 0.470, 0.680, 0.812];
      var shKt = [0.0, 0.70, 1.0, 1.0, 1.0, 1.0, 0.0];
      for (k = 0; k < 6; k++) {
        var sha = shS[k], shb = shS[k + 1];
        var shKa = shKt[k], shKb = shKt[k + 1];
        var shYa = sh.belt(sha), shYb = sh.belt(shb);
        var shT = m(0.013), shB = m(0.024);
        var shz0 = sh.hw(sha) * sh.beam(shYa) + m(0.007);
        var shz1 = sh.hw(shb) * sh.beam(shYb) + m(0.007);
        quadT(P.body, T, [sha * L, shYa, ms * shz0], [shb * L, shYb, ms * shz1],
              [shb * L, shYb + shT * shKb, ms * shz1], [sha * L, shYa + shT * shKa, ms * shz0],
              refX, refY, 0, 1.15, tone);
        quadT(P.body, T, [sha * L, shYa - shB * shKa, ms * shz0],
              [shb * L, shYb - shB * shKb, ms * shz1],
              [shb * L, shYb, ms * shz1], [sha * L, shYa, ms * shz0],
              refX, refY, 0, 0.56, tone);
      }
      /* THE HEADLAMP'S WING: the second half of the teardrop.  Section 5
         emits the lamp on the nose cap between 602 and 790 mm; this quad
         picks it up at the corner and carries it 375 mm back along the wing
         to die in a 40 mm point at 0.906 of the length, RISING as it goes
         (820-860 at the tail against 602-790 at the corner) because the
         real wing's shut line climbs ~90 mm out from the bonnet centreline
         and the lamp climbs with it -- 04-front34-left is the plate.
         Its tail sits in the shoulder radius, where hw*beam over-reads the
         true section by about 7 mm, so the quad floats ~12 mm proud there:
         that is inside the band the rest of the flank trim uses.
         Tone is a lens, not a hole: the old [0.096] near-black was the
         "black hole" read.  On the glass pile so it keeps the same smooth
         specular as the lens rings on the nose. */
      if (S.lampWrap) {
        var lwA = 0.892, lwB = 1.0;
        var topA = H * 0.5026, botA = H * 0.4806;   /* 866 / 828 -- the tip.
           lwB runs all the way to 1.0 and not to 0.99: the loft's last band
           is 0.986 -> 1.0, and stopping short of it left that band bare, so
           a silver corner facet opened up between the lamp on the cap and
           the lamp on the wing and the unit read as two parts. */
        var topB = H * 0.4614, botB = H * 0.3308;   /* 795 / 570 -- exactly
           the corner heights section 5's outline ends on, so the two halves
           of the lamp meet on the crease instead of stepping across it */
        var lwzA = sh.hw(lwA) * sh.beam((topA + botA) * 0.5) + m(0.005);
        var lwzB = sh.hw(lwB) * sh.beam((topB + botB) * 0.5) + m(0.003);
        quadT(P.body, T,
              [lwA * L, botA, ms * lwzA], [lwB * L, botB, ms * lwzB],
              [lwB * L, topB, ms * lwzB], [lwA * L, topA, ms * lwzA],
              refX, refY, 0, 1.0, [0.300, 0.322, 0.350]);
      }
      /* ================= THE DOOR MIRROR =================
         The most load-bearing appendage on the car.  Without a pair of these
         the silhouette is a loaf of bread: they are the only thing that breaks
         the roofline's profile, the only part that reads at a distance from
         head-on, and they are what says "this is a vehicle" before any of the
         panel work does.  The car had none -- the old code emitted one, but at
         hw + 76 mm it never cleared the flank's own shoulder and in every
         three-quarter frame it was inside the body's silhouette.

         HOW FAR OUT.  Ford quote the Courier at 1764 mm across the body and
         2060 mm across the mirrors (the header comment at the top of FLEET
         carries both), so each head clears the widest point of the flank by
         148 mm.  Cap centre at hw + 88 mm with a 36 mm half thickness puts the
         outer face at hw + 124 and the pair at 2012 mm -- 48 mm inside the
         quoted figure, deliberately, because SELF_OCC and stOcclude are built
         from spec.W and cannot follow a mirror (see CODE-MAP risk 5) and the
         bay clamp in buildCars has no idea it exists either.

         WHERE.  01-side-owner, crop _shots/flankmeas/01-mirror2.png: the cap
         runs photo x 385-435, which through the DLO's projective map is
         t 0.694 -> 0.652, so the head is centred at t 0.673.  Its base is
         forward of that, on the gloss-black sail triangle section 3 builds
         between dloFront 0.660 and dloTip 0.745 -- so the head hangs ~120 mm
         AFT of its own mount, which is what the arm is for.

         HOW HIGH.  The cap sits from +7 mm to +187 mm ABOVE the glass seal:
         these are van mirrors carried high on the sail, not saloon mirrors
         hung off the door skin.  Centre = dloBot + 86 mm.

         FOUR PARTS, and the split matters.  A single body-colour box up at the
         belt is a white postage stamp stuck on the black DLO -- that is what
         the first attempt rendered, because the only value in it was the
         paint's, and the paint's value against privacy glass is 1.0.  A real
         mirror has a BODY-COLOUR CAP on top of a BLACK LOWER SHELL, and it is
         that horizontal dark/light split, not the outline, that makes the eye
         call it a mirror at 500 px.  So: a tapered dark arm off the sail, the
         cap, the shell under it, and the GLASS across the rearward face of
         both, toed out at its outer edge so the glass and the cap carry
         different values in every three-quarter frame.

         ...AND IT IS A LOFT, NOT TWO BOXES, which is fault 2 in _shots/it8.
         The two-box version had the right four parts and still read as "a
         plain white box perched on the beltline", and the reason is that at
         parking distance a mirror is 25 px long: the ONLY things the eye can
         use are its OUTLINE and the one tonal split across it.  A box gives
         the eye a rectangle, and a rectangle at the beltline is a parcel-shelf
         speaker, a roof box, a wing mirror, anything.  What 04-front34-left
         and the crop of 05-side-dealer both show is a WEDGE: it starts at the
         sail as a stub barely a third of full height, swells over its first
         third, carries full section for the middle, and closes a little at the
         glass.  Every edge on it is a radius.  Four stations round an
         eight-sided super-ellipse is 24 quads a side and it buys the whole
         silhouette; the loft also lets the dark/light split fall on the same
         horizontal plane on the top, the outer face AND the underside, which
         two stacked boxes cannot do (they split the outer face only, and from
         directly ahead -- car.front34 -- the old cap was one flat white plate
         with nothing under it).

         HOW BIG, and it is smaller than the boxes were.  05-side-dealer at
         207 px/m measures the head 28 px long by 34 px tall, i.e. 135 x 164 mm
         of silhouette; 01-side-owner's column scan puts the bright cap between
         photo x 396 and 427 (t 0.685 -> 0.658) and photo y 300-332, which is
         the same 170 mm long by 115 mm of cap.  mmHX 0.104 -> 0.092 (184 mm
         over the full loft, of which the widest part is ~150) and mmHY 0.084
         -> 0.082.  It only gets 6 mm thicker (mmHZ 0.042 -> 0.044) and mmZ
         comes in by the same 2 mm, so mmZ + mmHZ is unmoved at hw + 142 mm and
         the pair still measures 2048 mm across -- the SELF_OCC/bay-clamp risk
         in the note above is exactly where it was.

         HOW HIGH, corrected.  The comment above says +7 to +187 above the seal
         and the code did not do it: mmY was dloBot + 40 mm with a half height
         of 84, i.e. the head hung from -44 to +124 and a third of it was below
         the glass line, sitting ON the belt seal.  That is the "perched on the
         beltline" read, and it is why the seal and the mirror merged into one
         dark blob in car.dlo.  dloBot + 92 mm with 82 of half height puts it
         at +10 to +174, which is the measurement.
         The cap goes on at ao 0.88 and the shell at 0.80: both are crowned
         plastic turning away from the sky on every side, so neither can be as
         bright as the flat door skin below however clean the car is. */
      /* 0.673 -> 0.686.  0.673 is where 01-side-owner's bright CAP measures,
         and it is right for the cap; but the head's nose tapers 30 mm forward
         of the cap's own front edge, and driving the loft off the cap centre
         put the nose 195 mm behind the sail with a 60 mm-thick dark arm
         bridging the gap.  At 500 px that arm is the most conspicuous thing on
         the car's flank -- a black strut -- and no photograph has one: 01's
         own scan has 26 px, 93 mm, of visible arm between the sail's rear edge
         at t 0.711 and the cap at 0.685.  0.686 puts the nose at t 0.702 and
         leaves exactly that. */
      var mmT = 0.686;
      var mmY = dloBot(mmT) + m(0.092);
      var mmHX = m(0.092), mmHY = m(0.082), mmHZ = m(0.044);
      var mmZ = sh.hw(mmT) * sh.beam(mmY) + m(0.098);
      /* 0.115 -> 0.165.  The lower shell is drawn against PRIVACY GLASS, not
         against paint: darkGlass renders the pane at 0.030 down at the belt,
         so a 0.115 shell was within a hair of the hole behind it and the whole
         bottom half of the head vanished into the DLO.  What survived was the
         cap on its own -- a white plate floating on black, which is the "plain
         white box" read wearing a different outline.  0.165 is still a satin
         black plastic against a 0.39 flank and it is 5x the pane it stands in
         front of, so the head keeps its full silhouette. */
      var mmDark = [0.165, 0.163, 0.162];
      /* the four stations, u = 0 at the stub where the arm enters and u = 1 at
         the glass.  MSX is fore-aft in units of mmHX (+1 forward), MSY/MSZ the
         half height and half thickness as fractions of mmHY/mmHZ, MSC how far
         the section's CENTRE rides above mmY (the stub is carried high, which
         is what tips the underside down and forward and gives the wedge its
         direction), MSO how far it is tucked inboard. */
      var MSX = [1.00, 0.26, -0.52, -1.00];
      var MSY = [0.46, 0.87, 1.00, 0.93];
      var MSZ = [0.58, 0.90, 1.00, 0.92];
      var MSC = [0.32, 0.10, 0.00, 0.02];
      var MSO = [-0.40, -0.12, 0.00, 0.00];
      /* the section is a SUPER-ELLIPSE, not a circle: |sin|^0.56 fills the
         corners out to about 70 % of a rectangle, which is a moulded cap.  A
         plain ellipse here reads as a length of drainpipe. */
      var nMS = TIER === 'low' ? 6 : 8, mmi, mmj;
      function mmPt(si, a) {
        var ca = Math.cos(a), sa = Math.sin(a);
        var ky = (sa < 0 ? -1 : 1) * Math.pow(Math.abs(sa), 0.56);
        var kz = (ca < 0 ? -1 : 1) * Math.pow(Math.abs(ca), 0.56);
        return [mmT * L + mmHX * MSX[si],
                mmY + mmHY * MSC[si] + mmHY * MSY[si] * ky,
                ms * (mmZ + mmHZ * MSO[si] + mmHZ * MSZ[si] * kz)];
      }
      /* the arm: off the SAIL, not off the door skin, SHORT and THIN.  maT
         0.22 of the way from dloFront to dloTip and 72 mm up the sail is
         inside the sail triangle at that height (its front edge is at t 0.751
         there), so the arm springs from black plastic rather than from glass;
         it lands on the head's nose 104 mm away.  48 mm across at the sail
         falling to 34 mm at the head, not 60 -> 42: the old radii made a strut
         thicker than the drip rail is deep, and 04-front34-left's arm is a
         stub you have to look for. */
      var maT = lerp(S.dloFront != null ? S.dloFront : mmT,
                     S.dloTip != null ? S.dloTip : c3, 0.22);
      var maY = dloBot(maT) + m(0.072);
      var mb = T(maT * L, maY, ms * (ghwT(maT, maY) + PROUD));
      var mo = T(mmT * L + mmHX * 0.78, mmY + mmHY * 0.16, ms * (mmZ - mmHZ * 0.40));
      tube(P.trim, mb[0], mb[1], mb[2], mo[0], mo[1], mo[2], m(0.024), 6, 0.66, false,
           mmDark, m(0.017));
      /* the head.  THE SPLIT IS A PLANE, tested on the quad's own mean height,
         so it lands on the same horizontal all the way round and the cap sits
         ON the shell instead of beside it.

         ...AND THE SECTION IS ROTATED HALF A STEP so the plane can land where
         the photograph puts it.  The colour is decided per QUAD, so the crease
         can only fall on a quad boundary: with the grid starting at theta = 0
         the boundaries sit at the outer and inner equators, the cap gets
         exactly the top half whatever the plane is set to, and the mirror
         reads as a white plate with a black bar under it -- which is half of
         why the first version still looked like a box.  Starting at -half a
         step puts a single quad ACROSS the outer equator, from -0.577 to
         +0.577 of the half height, and that quad's mean is 0 so it goes on the
         cap: the crease drops to 71 % down the OUTER face while staying high
         on the inner one.  That is what a mirror cap actually is -- it wraps
         over the outboard shoulder and the dark housing is the inner side and
         the underside -- and it is what 05-side-dealer shows, silver almost to
         the bottom with a thin dark strip under it. */
      var mmSpl = mmY - mmHY * 0.10;
      for (mmi = 0; mmi < MSX.length - 1; mmi++) {
        for (mmj = 0; mmj < nMS; mmj++) {
          var ma0 = (mmj - 0.5) / nMS * Math.PI * 2, ma1 = (mmj + 0.5) / nMS * Math.PI * 2;
          var mp0 = mmPt(mmi, ma0), mp1 = mmPt(mmi + 1, ma0);
          var mp2 = mmPt(mmi + 1, ma1), mp3 = mmPt(mmi, ma1);
          var mUp = (mp0[1] + mp1[1] + mp2[1] + mp3[1]) * 0.25 > mmSpl;
          quadT(mUp ? P.body : P.trim, T, mp0, mp1, mp2, mp3,
                mmT * L, mmY, ms * mmZ, mUp ? 0.88 : 0.80, mUp ? tone : mmDark);
        }
      }
      /* the two ends, closed off the same outlines.  The nose is dark: it is
         the collar the arm comes out of and it is in the sail's shadow all
         day.  The back of the head is dark too, and the glass then lies 4 mm
         behind it -- a 6 mm dark rim right round the glass, which is what
         stops the glass reading as the whole rear face of a slab. */
      var mmA = [], mmB = [], mmR = T(mmT * L, mmY, ms * mmZ), mmQ;
      for (mmj = 0; mmj < nMS; mmj++) {
        mmQ = mmPt(0, (mmj - 0.5) / nMS * Math.PI * 2);
        mmA.push(T(mmQ[0], mmQ[1], mmQ[2]));
        mmQ = mmPt(MSX.length - 1, (mmj - 0.5) / nMS * Math.PI * 2);
        mmB.push(T(mmQ[0], mmQ[1], mmQ[2]));
      }
      poly(P.trim, mmA, mmR[0], mmR[1], mmR[2], 0.74, mmDark);
      poly(P.trim, mmB, mmR[0], mmR[1], mmR[2], 0.78, mmDark);
      /* THE GLASS, and it is TOED two ways.  A mirror face square to the car
         is a flat plate that carries the same value as the cap in every frame;
         the real one is aimed back and out at the driver's blind spot and
         tipped down a few degrees at the kerb, so it holds a different part of
         the sky from the cap above it whichever side of the car you stand on.
         14 mm of yaw across 65 mm of half-thickness is ~12 deg, 8 mm of tip
         across 61 mm of half-height is ~7 deg.  ref is the HEAD's own centre,
         not the car's: poly flips the facet normal away from ref, and with
         refX/refY (which is aft of and inboard of the mirror) it would have
         pointed the glass forwards. */
      var mgX = mmT * L + mmHX * MSX[MSX.length - 1] - m(0.004);
      var mgY = mmY + mmHY * MSC[MSC.length - 1], mgHY = mmHY * MSY[MSY.length - 1] * 0.74;
      var mgZ = mmZ + mmHZ * MSO[MSO.length - 1], mgHZ = mmHZ * MSZ[MSZ.length - 1] * 0.74;
      quadT(P.glass, T,
            [mgX, mgY - mgHY, ms * (mgZ - mgHZ)],
            [mgX - m(0.014), mgY - mgHY, ms * (mgZ + mgHZ)],
            [mgX - m(0.014) - m(0.008), mgY + mgHY, ms * (mgZ + mgHZ)],
            [mgX - m(0.008), mgY + mgHY, ms * (mgZ - mgHZ)],
            mmT * L, mmY, ms * mmZ, 0.92, glassCol);
      /* two door handles, or one on the two-door cars */
      for (j = 0; j < (S.doors >= 4 ? 2 : 1); j++) {
        var ht = S.handleT ? S.handleT[j]
                           : (j ? lerp(c0, c1, 0.62) : lerp(c1, c2, 0.62));
        /* HEIGHT.  01-side-owner's pockets run photo y 363-386 against a glass
           seal at 343, so the centre is 113 mm BELOW the seal -- high on the
           door, tucked under the shoulder crease, not down at mid-door.  In
           terms the hull can supply that is deck + dloSeal - 113 mm, i.e.
           deck - 0.042 H.  sh.belt - 0.048 H had them 235 mm under the seal,
           level with nothing at all.  0.042 H lands inside the shoulder
           radius, where hw*beam over-reads the true section by a few mm; that
           only adds to how proud the handle stands, which is wanted. */
        /* 0.058 H, not 0.042: section 3's belt seal is a fat 45 mm rubber that
           runs from dloBot down to the deck, so at 0.042 the pocket's top edge
           came within 28 mm of it and the pair merged into one black line under
           the glass.  The photograph keeps 65 mm of clean silver between the
           seal and the pocket; 0.058 H restores it. */
        var hy = sh.deck(ht) - H * 0.058;
        var hz = sh.hw(ht) * sh.beam(hy);
        /* the POCKET.  Ford's is a long shallow oval scoop, 270 x 95 mm on the
           photograph (x 595-671 by y 363-386 plus the shadow under it), with
           the grab bar lying along its lower edge.  The old 170 x 60 mm patch
           at 0.075 was the "two small dark blobs" read: too short to have a
           direction, too dark to have a shape inside it.  0.135 is a mid grey
           at ao 0.52 -- dark enough to cut a hole in a 0.38 flank, light
           enough that the bar in front of it still separates. */
        quadT(P.trim, T, [ht * L - m(0.128), hy - m(0.040), ms * (hz + m(0.005))],
              [ht * L + m(0.128), hy - m(0.040), ms * (hz + m(0.005))],
              [ht * L + m(0.128), hy + m(0.040), ms * (hz + m(0.005))],
              [ht * L - m(0.128), hy + m(0.040), ms * (hz + m(0.005))],
              refX, refY, 0, 0.52, [0.135, 0.133, 0.130]);
        /* the grab bar: 196 mm of it, sitting low in the pocket and standing
           22 mm out, body colour on this trim level.  ao 1.28, i.e. brighter
           than the door skin around it: the bar is a horizontal cylinder with
           the sky on top of it and a 40 mm pocket immediately behind, so it
           carries the brightest value on the flank.  At ao 1.05 it matched the
           door exactly and all that survived was the dark slot, which is the
           "two small dark blobs" read again in a different size. */
        boxT(P.body, T, ht * L, hy - m(0.008), ms * (hz + m(0.022)),
             m(0.098), m(0.017), m(0.016), 1.28,
             S.chrome ? chrome : S.bodyBumper ? tone : trimDark);
      }
      /* a wiper lying on the screen */
      var w0 = T(lerp(c3, c2, 0.06) * L, lerp(yC3, yR2, 0.06) + m(0.012), ms * gwC3 * 0.30);
      var w1 = T(lerp(c3, c2, 0.62) * L, lerp(yC3, yR2, 0.62) + m(0.012), ms * gwC3 * 0.52);
      tube(P.trim, w0[0], w0[1], w0[2], w1[0], w1[1], w1[2], m(0.012), 4, 0.72, false,
           [0.055, 0.055, 0.055]);
    }
    /* THE REAR WIPER.  One bottom-pivoted arm parked along the lower edge of
       the tailgate glass, pivot offset to the car's left of centre -- photo
       06 and SPEC-FACTORY 7.9.  It is a 15 mm black line 0.6 m long lying on
       a near-black pane, so it is not going to shout; what it does is stop
       the backlight reading as a single flat sheet of tint, which at 3 m is
       the difference between a window and a hole.  Solved as a fraction of
       the way UP the backlight (c0 at the deck -> c1 at the roof) so it rides
       with the glass however the greenhouse is retuned. */
    if (S.spoiler) {                       /* i.e. the modern one-box tail   */
      var rwX0 = c0 * L, rwY0 = sh.deck(c0) + H * (S.dloSeal != null ? S.dloSeal : 0.030);
      var rwDX = c1 * L - rwX0, rwDY = sh.roofYt(c1) - rwY0;
      var rwU0 = 0.11, rwU1 = 0.21;        /* parked: 6 cm of rise in 0.64 m */
      var rq0 = T(rwX0 + rwDX * rwU0 - m(0.016), rwY0 + rwDY * rwU0, -sh.gw(c0) * 0.26);
      var rq1 = T(rwX0 + rwDX * rwU1 - m(0.016), rwY0 + rwDY * rwU1, sh.gw(c0) * 0.62);
      tube(P.trim, rq0[0], rq0[1], rq0[2], rq1[0], rq1[1], rq1[2], m(0.011), 4, 0.62, false,
           [0.048, 0.048, 0.047]);
      /* the pivot boss -- a 30 mm stub, because a wiper with no pivot reads
         as a scratch on the glass rather than a fitting on it */
      var rq2 = T(rwX0 + rwDX * rwU0 - m(0.030), rwY0 + rwDY * rwU0, -sh.gw(c0) * 0.26);
      tube(P.trim, rq0[0], rq0[1], rq0[2], rq2[0], rq2[1], rq2[2], m(0.022), 5, 0.55, true,
           [0.052, 0.052, 0.051]);
    }
    /* THE EXHAUST.  SPEC-FACTORY 4 is explicit: "no chrome tip, no visible
       tailpipe from a standard 3/4 view -- do NOT model a visible exhaust
       tip."  This pipe used to end 40 mm BEHIND the tail plane, i.e. poking
       out of the valance in every rear shot, which on a car whose real pipe
       turns down under the floor is a 90s hangover.  It now stops 75 mm short
       of the tail and drops as it goes, so what little of it can be seen from
       a low angle is a dark turned-down stub inside the bumper's shadow. */
    var ex0 = T(0.16 * L, sh.rideY * 0.86, -sh.hW * 0.42);
    var ex1 = T(m(0.150), sh.rideY * 0.76, -sh.hW * 0.46);
    tube(P.trim, ex0[0], ex0[1], ex0[2], ex1[0], ex1[1], ex1[2], m(0.024), 6, 0.34, true,
         [0.090, 0.088, 0.085]);
    /* Raised satin roof rails.  Segment them along roofYt() so they reinforce
       the roof's shallow arch instead of drawing a straight ruler above it. */
    if (S.rails) {
      for (i = 0; i < 2; i++) {
        var rs = i ? 1 : -1;
        var railA = c1 + m(0.10) / L, railB = c2 - m(0.10) / L;
        var railS = [railA, lerp(railA, railB, 0.32),
                     lerp(railA, railB, 0.68), railB];
        var railCol = [0.400, 0.410, 0.420];
        for (j = 0; j < railS.length - 1; j++) {
          var rta = railS[j], rtb = railS[j + 1];
          var ra = T(rta * L, sh.roofYt(rta) + m(0.052),
                     rs * sh.roofHW(rta) * 0.72);
          var rb = T(rtb * L, sh.roofYt(rtb) + m(0.052),
                     rs * sh.roofHW(rtb) * 0.72);
          tube(P.trim, ra[0], ra[1], ra[2], rb[0], rb[1], rb[2],
               m(0.015), 6, 0.92, true, railCol);
        }
        /* Three visible feet leave the characteristic gap under the rail. */
        for (j = 0; j < 3; j++) {
          var rtf = lerp(railA, railB, j / 2);
          var rf0 = T(rtf * L, sh.roofYt(rtf) + m(0.006),
                      rs * sh.roofHW(rtf) * 0.72);
          var rf1 = T(rtf * L, sh.roofYt(rtf) + m(0.050),
                      rs * sh.roofHW(rtf) * 0.72);
          tube(P.trim, rf0[0], rf0[1], rf0[2], rf1[0], rf1[1], rf1[2],
               m(0.021), 6, 0.86, true, railCol);
        }
      }
    }
    /* the tailgate spoiler: a body-colour lip carrying the roofline back
       over the backlight, which is what closes the Courier's silhouette --
       without it the near-vertical tail reads as a cut, not a design. */
    if (S.spoiler) {
      /* WHERE IT WAS: a 69 mm box centred 138 mm forward of the tail and
         floating 20 mm clear above the roof -- a lip that neither touched the
         roof it grows out of nor reached the glass it is supposed to shade,
         and which is invisible from behind because it stops 50 mm short of
         the backlight's own top edge.
         WHERE IT GOES: the roof panel ends at c1 (x = 166 mm) and the
         backlight falls away from that point; the spoiler is the roof
         CANTILEVERED PAST IT, 55 mm of overhang past the top of the glass,
         merging forward into the roof skin so there is no seam.  42 mm thick
         at the trailing edge and 96 % of the roof's half width, which is
         wider than the tailgate glass -- in 06-rear34 the spoiler's ends
         visibly stand outboard of the glass and turn down into the D pillar,
         and that overhang is what makes the roof read as finished rather than
         sawn off. */
      var spX0 = c0 * L - m(0.055), spX1 = c1 * L + m(0.006);
      boxT(P.body, T, (spX0 + spX1) * 0.5, sh.roofYt(c1) + m(0.001), 0,
           (spX1 - spX0) * 0.5, m(0.021), rwC1 * 0.96, 0.95, tone);
      /* the CHMSL: a dark red bar at the top centre of the backlight, under
         the spoiler.  Small -- 240 x 32 mm -- but it is the only saturated
         thing above the belt line on the whole car, and photo 06 shows it
         reading from 15 m.  Set 12 mm proud along the glass's own outward
         direction (the pane rakes 7 deg, so proud is very nearly -x). */
      var chX = lerp(c0 * L, c1 * L, 0.90) - m(0.012);
      var chY = lerp(sh.deck(c0) + H * 0.030, sh.roofYt(c1), 0.90);
      quadT(P.body, T, [chX, chY - m(0.016), -m(0.120)], [chX, chY - m(0.016), m(0.120)],
            [chX, chY + m(0.016), m(0.120)], [chX, chY + m(0.016), -m(0.120)],
            refX, sh.rideY, 0, 1.0, [0.300, 0.045, 0.040]);
    }
    /* the aerial: one line, and the only thing on the car above the roof.
       roofAerial swaps the 90s wing whip for the short stub the photographs
       show at the front of the roof panel. */
    var an0, an1;
    if (S.roofAerial) {
      /* SPEC-FACTORY 7.8, off photos 01/02: a 350-400 mm black rod on a small
         conical base, at the FRONT of the roof just behind the screen header,
         offset from the centreline and raked REARWARD 35-45 deg from
         vertical.  380 mm at 40 deg = 244 mm of run for 291 of rise.
         The base y has to come off roofYt AT THE MAST'S OWN STATION, not at
         c2: the roofline droops 10 mm in the 120 mm between them, which was
         enough to leave the old stub's foot hanging in the air over the
         panel.  It also floated a further 41 mm up on an H*0.024 offset that
         nothing measured. */
      var anT = c2 * L - m(0.120), anY = sh.roofYt(anT / L);
      an0 = T(anT, anY + m(0.026), -rwC2 * 0.34);
      an1 = T(anT - m(0.244), anY + m(0.026) + m(0.291), -rwC2 * 0.33);
      tube(P.trim, an0[0], an0[1], an0[2], an1[0], an1[1], an1[2], m(0.011), 4, 1.0, false,
           [0.085, 0.084, 0.083]);
      /* the base cone, sunk 8 mm into the roof so no crown can open a gap */
      var anB0 = T(anT, anY - m(0.008), -rwC2 * 0.34);
      var anB1 = T(anT, anY + m(0.030), -rwC2 * 0.34);
      tube(P.trim, anB0[0], anB0[1], anB0[2], anB1[0], anB1[1], anB1[2],
           m(0.030), 6, 0.90, true, [0.070, 0.069, 0.068], m(0.013));
    } else {
      an0 = T(c3 * L - m(0.10), sh.deck(c3) + H * 0.04, -gwC3 * 0.84);
      an1 = T(c3 * L - m(0.28), H + m(0.40), -gwC3 * 0.78);
      tube(P.trim, an0[0], an0[1], an0[2], an1[0], an1[1], an1[2], m(0.009), 4, 1.0, false,
           [0.105, 0.104, 0.102]);
    }

    void seed; void trackH;
    STATS.cars++;
    STATS.props++;
  }

  /* the largest yaw whose four ground corners are still inside the bay's
     legal envelope.  For a 4.3 m car in a 4.57 m bay that is a degree or so
     -- which is all a real kerb-side row ever shows anyway. */
  function maxYaw(Lc, Wc, ex, ez) {
    var lo = 0, hi = 0.20, i, mid;
    function ok(a) {
      var c = Math.cos(a), s = Math.sin(a);
      var hx = (Lc * c + Wc * s) * 0.5, hz = (Lc * s + Wc * c) * 0.5;
      return hx <= ex && hz <= ez;
    }
    if (!ok(0)) return 0;
    for (i = 0; i < 26; i++) { mid = (lo + hi) * 0.5; if (ok(mid)) lo = mid; else hi = mid; }
    return lo;
  }

  /* WHICH CAR STANDS IN WHICH BAY -- and there is now exactly ONE.  The
     owner's brief for this pass: the street carries a single vehicle, the
     silver Ford Tourneo Courier of the six reference photographs, parked
     close to SEYDIKENT A-BLOK's middle entrance.  That door's axis is
     x = 668 (NUKEM.html centres the two-cell garden gate on it), and the
     north kerb row's middle bay [652, 668] ends exactly on that axis, so
     the car stands with its nose across the gate walkway -- as close to
     the door as a parked car can legally be.

     nudge 1.0 slides the body as far east (doorward) as the bay + HUG
     envelope allows; flip faces the nose WEST, which is both the parking
     direction right-hand traffic puts on a north kerb and the face the
     player sees first walking up from the roundabout.

     A bay is 4 cells = 16 units = 4.57 m long and ONE cell = 4 units deep, so
     the body is wider than its bay and its kerbside wheels necessarily
     end up on the kerb -- the tilt is SOLVED from GROUND's real kerb and
     camber heights, not authored, and it is what ref1/ref2/ref8 all show. */
  var CARPLAN = [
    { key: 'courier', mount: 0.55, nudge: 1.00, flip: 1, yawK: 0.40 }
  ];

  /* the entrance is the thing this whole street exists to lead to; PROPS must
     not stand anything in front of it.  nz-street-entrance.js publishes the
     box; read it, never guess it. */
  function keepClear() {
    /* The six Seydikent doors are residential dressing only.  The sole combat
       entrance belongs to the arena beyond the park, outside this module's
       car/garden corridor, so an old foyer keepClear box must not shorten or
       displace cars here. */
    return null;
  }
  function inKeepClear(x0, x1, z0, z1, pad) {
    var kc = keepClear();
    if (!kc) return false;
    pad = pad || 0;
    return !(x1 < kc.x0 - pad || x0 > kc.x1 + pad || z1 < kc.z0 - pad || z0 > kc.z1 + pad);
  }

  function buildCars(P, bays) {
    var road = [], i;
    /* KIND, not geometry.  GROUND publishes a three-way classification and the
       island is a run of S_BLOCK cells sitting in the middle of the roadway --
       it passes every "is this inside the kerb faces" test a bay does, and the
       last build stood two cars on it. */
    for (i = 0; i < bays.length; i++) if (bays[i].kind === 'bay') road.push(bays[i]);
    if (!road.length) {
      warn('no road-side S_BLOCK bays found -- the street ships with NO cars ' +
           '(a car off a blocked cell is a hologram; ENV-PLAYBOOK 7.4)');
      return [];
    }
    road.sort(function (a, b) { return (a.north === b.north) ? a.x0 - b.x0 : (a.north ? -1 : 1); });
    /* ONE CAR ON THE WHOLE STREET.  Pick the north-side bay whose centre is
       nearest A-BLOK's middle residential door -- read off the published
       facade record when it exists, so a future re-cut of the grid moves
       the car WITH its door instead of stranding it on a stale coordinate.
       (NUKEM.html now keeps only that one road bay S_BLOCKed anyway; this
       filter is what makes the intent survive somebody putting the other
       five back.) */
    var doorX = 668, fac = (NZ.street && NZ.street.facades) || [], fi;
    for (fi = 0; fi < fac.length; fi++) {
      if (fac[fi].kind === 'ablok' && fac[fi].entrances && fac[fi].entrances.length >= 3) {
        doorX = fac[fi].entrances[1].x;
        break;
      }
    }
    var pick = null, pickD = 1e9;
    for (i = 0; i < road.length; i++) {
      var rdd = Math.abs((road[i].x0 + road[i].x1) * 0.5 - doorX);
      if (road[i].north && rdd < pickD) { pick = road[i]; pickD = rdd; }
    }
    road = pick ? [pick] : road.slice(0, 1);
    var out = [];
    for (i = 0; i < road.length; i++) {
      var b = road[i], plan = CARPLAN[i % CARPLAN.length];
      if (!plan.key) {
        DIAG.legal.push('road bay at x ' + b.x0 + '-' + b.x1 + ' left empty: ' +
                        (plan.why || 'no car planned'));
        continue;
      }
      var S = FLEET[plan.key];
      /* clamp the body so no flank crosses the HUG line, whatever the spec
         says.  A bay is one cell deep; the legal envelope is 4 + 2*0.98. */
      var envZ = (b.z1 - b.z0) * 0.5 + HUG - 0.06;
      var envX = (b.x1 - b.x0) * 0.5 + HUG - 0.06;
      var spec = {};
      for (var k in S) if (Object.prototype.hasOwnProperty.call(S, k)) spec[k] = S[k];
      spec.W = Math.min(S.W, envZ * 2 - 0.10);
      spec.L = Math.min(S.L, envX * 2 - 0.10);
      /* THE VISUAL WIDTH IS NOT THE LEGAL ONE, and on a one-cell-deep bay it
         cannot be.  The envelope here is 5.74 u = 1.64 m, so the Courier's
         real 1.764 m body was being squeezed by 124 mm -- 7 % -- and a 7 %
         narrow car parked broadside to the camera does not read as narrow, it
         reads as LONG.  That single clamp was doing more damage to the
         silhouette than any curve in the model.
         Legality, the occluders and the published record all keep the clamped
         width, so nothing the player can collide with or shoot moves.  Only
         the sheet metal is built at its true width, and the price is that a
         player pressed hard against the flank overlaps it by 62 mm -- which
         is the ordinary game-engine arrangement of a collision hull slightly
         inside the mesh, and is invisible at any distance the car is seen
         from.  Capped at 160 mm so this can never become a licence to park a
         minibus in a Fiat's bay. */
      spec.Wlegal = spec.W;
      if (S.W - spec.W <= m(0.16)) spec.Wbody = S.W;
      if (spec.L < S.L - 0.01)
        DIAG.legal.push(S.nm + ' shortened ' + ((S.L - spec.L) * M_PER_U * 100).toFixed(0) +
                        ' cm to fit a ' + (b.cells) + '-cell bay');
      spec.wb = Math.min(S.wb, spec.L * 0.62);
      /* the bumpers stand 20 mm proud of each end face; count them in */
      var envL = spec.L + m(0.04);

      var cx = (b.x0 + b.x1) * 0.5 + plan.nudge * Math.max(0, envX - envL * 0.5 - 0.15);
      var cxLo = b.x0 - HUG + envL * 0.5 + 0.06, cxHi = b.x1 + HUG - envL * 0.5 - 0.06;
      cx = clamp(cx, Math.min(cxLo, cxHi), Math.max(cxLo, cxHi));
      /* the car is wider than the bay is deep, so its centre has almost no
         freedom: it lands on the middle of the cell and its kerbside wheels
         end up on the kerb.  mount<1 pulls it back toward the gutter. */
      var slackZ = Math.max(0, envZ - spec.W * 0.5);
      var toKerb = b.north ? -1 : 1;
      var cz = (b.z0 + b.z1) * 0.5 + toKerb * slackZ * (plan.mount - 0.5) * 1.6;
      cz = clamp(cz, b.z0 - HUG + spec.W * 0.5 + 0.06, b.z1 + HUG - spec.W * 0.5 - 0.06);

      var yawMax = maxYaw(spec.L, spec.W, envX, envZ);
      var yaw = plan.yawK * yawMax + (b.north ? 0 : PI);
      if (plan.flip) yaw += PI;

      /* Protect the entrance from the car that ACTUALLY reaches it.  The old
         fleet plan carried an absolute maxX=236 on the Laguna slot.  CARPLAN
         repeats as more S_BLOCK bays are added, so that legacy coordinate was
         also imposed on distant bays at x312 and x432, producing impossible
         negative-length warnings.  Test the finished, yawed footprint against
         the entrance module's published box instead; if it is close enough to
         touch, slide it to the nearest legal side of that box. */
      var hx = (envL * Math.abs(Math.cos(yaw)) + spec.W * Math.abs(Math.sin(yaw))) * 0.5;
      var hz = (envL * Math.abs(Math.sin(yaw)) + spec.W * Math.abs(Math.cos(yaw))) * 0.5;
      var kcCar = keepClear(), clearGap = m(0.04);
      if (kcCar && inKeepClear(cx - hx, cx + hx, cz - hz, cz + hz, clearGap)) {
        var rotCxLo = b.x0 - HUG + hx + 0.06;
        var rotCxHi = b.x1 + HUG - hx - 0.06;
        var westCx = kcCar.x0 - hx - clearGap;
        var eastCx = kcCar.x1 + hx + clearGap;
        var westOK = westCx >= rotCxLo - 1e-6 && westCx <= rotCxHi + 1e-6;
        var eastOK = eastCx >= rotCxLo - 1e-6 && eastCx <= rotCxHi + 1e-6;
        if (westOK || eastOK) {
          if (westOK && eastOK) cx = Math.abs(westCx - cx) <= Math.abs(eastCx - cx) ? westCx : eastCx;
          else cx = westOK ? westCx : eastCx;
        }
      }

      var sh0 = carShape(spec);
      var zl = cz - sh0.trackH, zrr = cz + sh0.trackH;
      /* the x matters now: GROUND's roadYAt takes one, because the junction
         throat leaves the main gutter line and rises into its own crossfall */
      var yl = groundYAt(zl, cx), yrr = groundYAt(zrr, cx);
      /* pull the mounted wheel down a little: a tyre on a 143 mm kerb squats */
      var roll = Math.atan2((yrr - yl) * (1 - 0.12), 2 * sh0.trackH);
      var baseY = (yl + yrr) * 0.5 - m(0.012);
      if (plan.flip) roll = -roll;

      buildCar(P, spec, cx - Math.cos(yaw) * spec.L * 0.5, baseY, cz - Math.sin(yaw) * spec.L * 0.5,
               yaw, roll, i * 613 + 71);
      /* THE SERVIS BUS'S FLANK GRAPHIC.  Two decal cards rather than a place
         in the paint set: the wave is a one-off on one vehicle, it has to sit
         at a known height on a known flank, and a card is 2 tris against a
         whole extra 512 albedo.  The body is parked within a degree of
         axis-aligned, so a world-space quad tracks the flank exactly. */
      if (spec.swoosh) {
        var sw = Math.abs(Math.cos(yaw)) > 0.5;             /* runs along x  */
        var half = (sw ? spec.L : spec.W) * 0.5 - m(0.22);
        var off = (sw ? spec.W : spec.L) * 0.5 + 0.03;
        var swY = baseY + spec.H * 0.29, swH = spec.H * 0.155;
        P.panel.macro(0);
        for (var sgn3 = -1; sgn3 <= 1; sgn3 += 2) {
          if (sw) card(P.panel, cx, swY, cz + off * sgn3, half, 0, 0, 0, swH, 0,
                       PANEL.rect[P_SWOOSH], [0.92, 0.94, 0.98], 1.0, [0, 0, sgn3]);
          else card(P.panel, cx + off * sgn3, swY, cz, 0, 0, half, 0, swH, 0,
                    PANEL.rect[P_SWOOSH], [0.92, 0.94, 0.98], 1.0, [sgn3, 0, 0]);
        }
      }

      legalC(S.nm, cx - hx, cx + hx, cz - hz, cz + hz, b);
      if (inKeepClear(cx - hx, cx + hx, cz - hz, cz + hz, 0))
        DIAG.legal.push(S.nm + ' overlaps NZ.streetEntrance.keepClear');
      /* the body, for PROPS' own bake.  Its floor is a fifth of the way up the
         car ON PURPOSE: a rocker vertex sitting inside its own occluder reads
         as unoccluded, so the box has to start above the sill. */
      SELF_OCC.push({
        x0: cx - hx * 0.96, x1: cx + hx * 0.96,
        y0: baseY + spec.H * 0.20, y1: baseY + spec.H * 1.02,
        z0: cz - hz * 0.94, z1: cz + hz * 0.94
      });
      /* and the same car AGAIN, closed down to the tarmac and registered for
         the replay only.  This is what puts the hard dark patch under a parked
         car on GROUND's road -- the brief's first believability item, and the
         one number the critic measured at 0.99 where the photographs are
         0.41-0.46.  It is deliberately NOT in SELF_OCC: it would swallow the
         car's own sills. */
      /* Measured under-car ratio was 0.58 against 0.41-0.46 on the reference
         plates, i.e. the patch was too LIGHT.  For a sky-visibility integrator
         the lever is solid angle as seen from the tarmac: drop the box's floor
         onto the road and carry it up to the beltline rather than stopping at
         0.62 H, and the road beside the car darkens with it -- which is what
         _ref/ref1 shows.  Still exactly ONE replay box; the decal stays gone. */
      stOcclude([{
        x0: cx - hx, x1: cx + hx,
        y0: baseY + 0.015, y1: baseY + spec.H * 0.86,
        z0: cz - hz, z1: cz + hz
      }]);
      out.push({ x: cx, z: cz, y: baseY, spec: spec, bay: b, yaw: yaw });
    }
    return out;
  }

  /* =======================================================================
     SECTION 11 -- planting.

     LEGALITY.  A trunk is 0.9-1.4 units across, far too deep for rule A in
     the open, so every tree stands on a single S_BLOCK tree pit -- rule C,
     one cell per tree, which also buys the raised kerb ring and the garden
     around it (ENV-PLAYBOOK 7.5).  The canopy is legal by rule B: its lowest
     foliage is above jumpTop(0.5) = 9.19, which is 2.63 m -- and 2.5 m is
     exactly the clearance a real street tree is pruned to.  The physics
     constraint and the correct architecture are the same number.

     The lean is not decoration.  The garden strip here is 0.9 m deep and the
     cikma soffit lands 1.2 m off the wall at y = 11.9, so a plumb trunk on a
     pit would grow straight into a balcony.  A tree planted that close to a
     building leans to the light and is pruned flat on the wall side; doing
     both puts the whole crown in front of the facade, where the reference
     photographs put it, and the collision falls out for free.
     ==================================================================== */
  var CROWN_BASE = 9.45;                  /* jumpTop(0.5) = 9.19, plus margin */

  function pitAxis(pit) {
    var north = ((pit.z0 + pit.z1) * 0.5) < (RZ0 + RZ1) * 0.5;
    var sgn = north ? 1 : -1;
    return {
      north: north, sgn: sgn,
      cx: (pit.x0 + pit.x1) * 0.5,
      zBack: north ? pit.z0 : pit.z1,     /* the facade edge   */
      zFront: north ? pit.z1 : pit.z0     /* the pavement edge */
    };
  }

  /* the trunk axis: base on the pit, straightening out over the pavement.
     Below jumpTop it must stay inside pit + HUG; above it, rule B applies and
     it may go where the light is. */
  function trunkAxis(pit, seed, topY, leanOut, sway) {
    var A = pitAxis(pit), i;
    var zb = A.zFront - A.sgn * (1.05 + rr(seed, 3, 0, 0.5));
    var zLimit = A.zFront + A.sgn * (HUG - 0.30);
    var pts = [], n = 7;
    var xj = A.cx + (rr(seed, 5, 0, 1) - 0.5) * 1.6;
    for (i = 0; i <= n; i++) {
      var u = i / n, y = Y_PAVE + (topY - Y_PAVE) * u;
      var z;
      if (y <= CROWN_BASE) z = zb + (zLimit - zb) * smooth(y / CROWN_BASE);
      else z = zLimit + A.sgn * leanOut * smooth(clamp((y - CROWN_BASE) / (topY - CROWN_BASE), 0, 1));
      var x = xj + Math.sin(u * 2.4 + seed) * sway;
      pts.push([x, y, z]);
    }
    return pts;
  }
  function axisAt(pts, y) {
    var i;
    for (i = 0; i < pts.length - 1; i++) {
      if (y >= pts[i][1] && y <= pts[i + 1][1]) {
        var t = (y - pts[i][1]) / ((pts[i + 1][1] - pts[i][1]) || 1);
        return [lerp(pts[i][0], pts[i + 1][0], t), y, lerp(pts[i][2], pts[i + 1][2], t)];
      }
    }
    return y < pts[0][1] ? pts[0].slice() : pts[pts.length - 1].slice();
  }

  var BARKC = [0.78, 0.72, 0.63];         /* the bark map already IS the bark */
  /* THE CONIFER TONE.  Measured off the money shot, the crown came back at
     rgb 42.8, 50.0, 44.7 -- lum 48.1, B-R +1.9 -- against ref4's 37, 45, 32
     (lum 42.1, B-R -8) and ref1's 26, 35, 22.  So it is a fifth too light and,
     more visibly, its BLUE is 4 % above its red where the photograph's is
     14 % BELOW: a cool sage instead of a warm blue-black.  This is an albedo
     multiplier in linear, which is the contract's rule -- lower the albedo,
     never the light -- and 0.62/0.68/0.42 lands the crown on ref4 exactly.
     It is deliberately NOT applied to the deciduous twigs or the weeds, which
     already measure right. */
  var NEEDLE = [1.69, 1.33, 1.69];

  /* a plumb trunk with a little sway, for a tree that is NOT hard against a
     building: the island conifer has light on every side and no balcony to
     lean out from, so trunkAxis()'s garden-strip logic is simply wrong for it */
  function freeAxis(bx, by, bz, seed, topY, sway) {
    var pts = [], n = 7, i;
    for (i = 0; i <= n; i++) {
      var u = i / n, y = by + (topY - by) * u;
      pts.push([bx + Math.sin(u * 2.1 + seed) * sway - Math.sin(seed) * sway,
                y, bz + Math.sin(u * 1.7 + seed * 1.3) * sway * 0.7 -
                   Math.sin(seed * 1.3) * sway * 0.7]);
    }
    return pts;
  }

  /* ---- dark spruce.  After the buildings, the strongest vertical here. ---
     `opt` is how the ISLAND tree differs from a pavement one: a free plumb
     axis on a given base point, a much higher crown base (_ref/ref8's spruce
     has lost every branch below about 4 m and what is left is a bare trunk
     under a dark mass), and no garden-strip clamping. */
  function buildConifer(P, pit, seed, hM, opt) {
    opt = opt || {};
    var baseY = opt.baseY === undefined ? Y_PAVE : opt.baseY;
    var topY = baseY + m(hM);
    var A = pitAxis(pit);
    var CB = opt.crownBase === undefined ? CROWN_BASE : opt.crownBase;
    var ax = opt.base
      ? freeAxis(opt.base.x, baseY, opt.base.z, seed, topY, opt.sway === undefined ? 0.30 : opt.sway)
      : trunkAxis(pit, seed, topY, m(0.55), 0.35);
    var free = !!opt.base;
    var i, k, w;
    var r0 = m(0.115 + hM * 0.0075) * (opt.trunk || 1);

    P.bark.tile(T_BARK).macro(0.5).tint(opt.bark || BARKC);
    for (i = 0; i < ax.length - 1; i++) {
      var u0 = i / (ax.length - 1), u1 = (i + 1) / (ax.length - 1);
      tube(P.bark, ax[i][0], ax[i][1], ax[i][2], ax[i + 1][0], ax[i + 1][1], ax[i + 1][2],
           r0 * (1 - u0 * 0.86), 6, 0.92, false, null, r0 * (1 - u1 * 0.86));
    }
    /* dead stubs below the crown -- the lower branches are gone, and what is
       left is a ring of snapped-off 100 mm spurs.  Inside pit + HUG. */
    for (k = 0; k < 7; k++) {
      var sy = lerp(baseY + m(0.9), CB - 0.6, k / 6) + rr(seed, 40 + k, -0.3, 0.3);
      var sa = rr(seed, 60 + k, 0, TAU);
      var sp = axisAt(ax, sy), sl = m(0.16 + rr(seed, 80 + k, 0, 0.14));
      var ex = sp[0] + Math.cos(sa) * sl, ez = sp[2] + Math.sin(sa) * sl;
      if (!free) {
        if (ex < pit.x0 - HUG + 0.2 || ex > pit.x1 + HUG - 0.2) continue;
        if (A.sgn * (ez - A.zFront) > HUG - 0.25) continue;
      }
      tube(P.bark, sp[0], sp[1], sp[2], ex, sy - m(0.05), ez, m(0.022), 4, 0.85, true, null, m(0.012));
    }

    /* THE CROWN.  A spruce is not a smooth cone: it is a stack of distinct
       branch tiers with daylight between them, the tiers themselves ragged,
       one or two of them dead or broken back, and an interior that is nearly
       black because nothing gets light in there.  The previous pass built
       seventeen evenly spaced whorls of ten short cards each, which averages
       out to a smooth grey-green blob -- the exact opposite of the reference.

       Here: 10-14 tiers, spaced with real gaps, each with a strong radius
       jitter and a one-in-six chance of being a stunted tier; 6-9 long
       drooping branches per tier with roughly a sixth of them simply missing;
       and two opaque near-black mass cards on the axis at every tier so the
       silhouette never lets the blown-out sky through. */
    P.leaf.macro(0);
    var span = topY - CB;
    var whorls = Math.max(9, Math.round((TIER === 'low' ? 10 : 13) * (0.62 + hM / 16)));
    var Rmax = m(0.46 + hM * 0.112) * (opt.spread || 1);
    var kc2 = keepClear();
    function pruned(x, y, z) {
      if (insideBuilding(x, y, z, 0.45)) return true;
      if (kc2 && x > kc2.x0 - 0.6 && x < kc2.x1 + 0.6 &&
          z > kc2.z0 - 0.6 && z < kc2.z1 + 0.6) return true;
      return false;
    }
    for (w = 0; w < whorls; w++) {
      var uu = w / (whorls - 1);
      /* tiers bunch toward the top, which is what makes a conifer read as a
         conifer rather than as a stack of parasols */
      var wy = CB + span * (Math.pow(uu, 1.08) * 0.965 + 0.018);
      var cp = axisAt(ax, wy);
      var jit = rnd(seed + w, 11);
      var stunt = (rnd(seed + w * 3, 29) < 0.17) ? 0.46 : 1.0;
      var Rw = Rmax * Math.pow(1 - uu, 0.66) * (0.74 + 0.46 * jit) * stunt;
      if (Rw < m(0.09)) continue;
      /* two rings per tier: a long outer ring that makes the silhouette, and
         a short inner one that fills it.  One ring alone gives a starfish. */
      var nb = Math.max(7, Math.round((TIER === 'low' ? 8 : 11) * (0.62 + (1 - uu) * 0.62)));
      var a0 = rr(seed, 100 + w, 0, TAU);
      for (k = 0; k < nb * 2; k++) {
        var ring = k >= nb, kk = ring ? k - nb : k;
        /* one branch in eight is simply not there -- that is the gap */
        if (rnd(seed + w * 53, k * 11) < (ring ? 0.22 : 0.12)) continue;
        var an = a0 + (kk + (ring ? 0.5 : 0)) / nb * TAU + (rnd(seed + w * 31, k) - 0.5) * 0.55;
        var droop = 0.18 + 0.34 * (1 - uu) + rnd(seed + w, k * 7) * 0.22;
        var Lb = Rw * (ring ? 0.62 : 0.86) * (0.80 + rnd(seed + w, k * 13) * 0.40);
        var dx = Math.cos(an), dz = Math.sin(an), dy = -droop;
        var dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= dl; dy /= dl; dz /= dl;
        var mx = cp[0] + dx * Lb * 0.50, my = wy + dy * Lb * 0.50, mz = cp[2] + dz * Lb * 0.50;
        if (pruned(mx, my, mz)) continue;
        var tanx = -Math.sin(an), tanz = Math.cos(an);
        /* a spruce branch is a broad flat spray, not a spike */
        var Wb = Lb * (0.52 + rnd(seed + w, k * 17) * 0.30);
        /* THE SKIRT.  A drooping branch on the lowest whorl reached 1.0 m
           BELOW CROWN_BASE -- under jumpTop, under the eyeline, and straight
           across the pavement camera, where 2.2 m of unbroken dark green card
           filled two thirds of the frame.  Lift any card whose lowest corner
           breaks the line rather than dropping it, so the skirt stays dense
           and the clearance a street tree is actually pruned to is kept. */
        var lowY = my - Math.abs(dy) * Lb * 0.5 - Wb * 0.44;
        if (lowY < CB) my += CB - lowY;
        var tile = LEAF.rect[[L_SPRIG0, L_SPRIG1, L_SPRIG2, L_SPRIG3][(rnd(seed + w * 7, k) * 4) | 0]];
        /* the top of the crown sees the sky; the skirt sits in its own shade,
           and everything on the inner ring is in the crown's own shadow */
        var sh2 = (0.58 + 0.38 * uu + (rnd(seed + w, k * 23) - 0.5) * 0.16) * (ring ? 0.66 : 1);
        card(P.leaf, mx, my, mz, dx * Lb * 0.5, dy * Lb * 0.5, dz * Lb * 0.5,
             tanx * Wb * 0.5, 0, tanz * Wb * 0.5, tile, NEEDLE, sh2);
        /* the cross card, standing up so the branch has volume from the side */
        if (!ring)
          card(P.leaf, mx, my, mz, dx * Lb * 0.5, dy * Lb * 0.5, dz * Lb * 0.5,
               tanx * Wb * 0.16, Wb * 0.44, tanz * Wb * 0.16, tile, NEEDLE, sh2 * 0.72);
      }
      /* the interior: opaque, near black, and the whole reason the crown is
         not translucent.

         It used to be ONE card of radius 0.80 Rw per tier, which on the lowest
         whorl of a 9.4 m spruce is 2.2 m across and 1.75 m tall -- a single
         flat quad big enough to fill a 12 m camera edge to edge with one value
         and one straight silhouette.  Three smaller cards scattered inside the
         whorl fill exactly the same volume, are never bigger than the branch
         spray around them, and give the crown an interior that breaks up. */
      var mR = Rw * 0.42, q;
      if (mR > m(0.08)) {
        for (q = 0; q < 3; q++) {
          var qa = a0 + q * 2.094 + 0.55;
          var qd = q ? Rw * (0.30 + 0.20 * rnd(seed + w, 200 + q)) : 0;
          var mx2 = cp[0] + Math.cos(qa) * qd, mz2 = cp[2] + Math.sin(qa) * qd;
          var my2 = wy + (rnd(seed + w, 220 + q) - 0.5) * span * 0.030;
          var mh = Math.min(mR * 0.84, my2 - CB - 0.05);
          if (mh < m(0.07) || pruned(mx2, my2, mz2)) continue;
          var mt2 = LEAF.rect[((w + q) & 1) ? L_MASS : L_NEEDLE];
          var mao = 0.36 + 0.20 * uu + q * 0.05;
          card(P.leaf, mx2, my2, mz2, mR, 0, 0, 0, mh, 0, mt2, NEEDLE, mao);
          card(P.leaf, mx2, my2, mz2, 0, 0, mR, 0, mh, 0, mt2, NEEDLE, mao * 0.92);
        }
      }
    }
    /* the leader: a spruce ends in one thin shoot, never in a dome */
    var tp = ax[ax.length - 1];
    card(P.leaf, tp[0], tp[1] - m(0.34), tp[2], m(0.13), 0, 0, 0, m(0.46), 0,
         LEAF.rect[L_SPRIG2], NEEDLE, 0.92);
    card(P.leaf, tp[0], tp[1] - m(0.34), tp[2], 0, 0, m(0.13), 0, m(0.46), 0,
         LEAF.rect[L_SPRIG0], NEEDLE, 0.86);

    /* the crown is an occluder for everything built after it: without this the
       facade behind a spruce is as bright as the open sky */
    SELF_OCC.push({
      x0: ax[ax.length - 1][0] - Rmax * 0.62, x1: ax[ax.length - 1][0] + Rmax * 0.62,
      y0: CB + span * 0.10, y1: topY - span * 0.10,
      z0: axisAt(ax, CB + span * 0.5)[2] - Rmax * 0.55,
      z1: axisAt(ax, CB + span * 0.5)[2] + Rmax * 0.55
    });
    STATS.trees++; STATS.props++;
  }

  /* ---- THE SPRUCE, AS A FORM ----------------------------------------------
     The owner's April 2026 frames of 233 Sk and of the refuge by the pharmacy
     show the same plant three times over: a Picea, twelve to thirteen metres,
     narrow, pointed, its lowest branches gone to about three metres and
     everything above that a continuous dark cone with a ragged edge.  It is
     not buildCedar's stack of plates, and it is not buildConifer's thirteen
     whorls either -- at 30 cm a whorl is one tier per metre of crown and the
     tree reads as a pagoda with daylight between its floors.

     So this is neither a mesh nor a module-specific builder: it is the FORM,
     a list of cards in world space, and whoever calls it brings its own atlas
     and its own tone.  nz-street-props plants the A-BLOK row from it and
     nz-street-side plants the refuge tree, off the same function, so the two
     cannot drift into two different species.

       o.x o.y o.z   the foot of the trunk            o.h    total height
       o.cb          clear stem, above the foot        o.r    widest crown radius
       o.seed        any number; same seed, same tree  o.dens 1 = full
       o.axis(y)     optional, returns [x, y, z] of the stem at height y

     What makes it a spruce and not a cone of cards:
       * a whorl every 31 cm, each turned by the golden angle from the last, so
         no two tiers line their gaps up and no spoke repeats up the tree;
       * the branch ANGLE runs with height -- the skirt hangs at 27 degrees
         below level, the middle is flat, the top third reaches upward -- which
         is the one silhouette cue that says spruce rather than fir or pine;
       * every bough is a flattened fan of four sprays -- the inner run, the
         tip and a side shoot each way -- and under three of them hangs a
         curtain of pendulous shoots, standing in the spray's own vertical
         plane.  The fans are what the player sees looking up into the crown
         from the pavement, the curtains are what makes the edge of the cone
         from across the street;
       * short inner shoots between whorls and a near-black cross on the stem
         at every tier, so the overcast sky never shows through the middle.

     Returns rows of [kind, cx, cy, cz, ux, uy, uz, vx, vy, vz, shade]:
     kind 0 bough, 1 hanging spray, 2 interior mass, 3 leader.  u runs from
     the stem outward (or up, for the leader), v is the card's other half
     axis, and both are HALF extents. */
  function spruceForm(o) {
    var out = [], seed = fin(o.seed, 1);
    function H(a, b) {
      var s = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453;
      return s - Math.floor(s);
    }
    var h = o.h, cb = o.cb, span = h - cb, R = o.r, dens = o.dens || 1;
    var ax = o.axis || function (y) { return [o.x, y, o.z]; };
    if (!(span > 1) || !(R > 0.2)) return out;
    var tiers = Math.max(9, Math.round(span / 1.10 * dens));
    var dyT = span / tiers, GA = 2.39996323, t, k;
    for (t = 0; t < tiers; t++) {
      var q = clamp((t + (H(t, 1) - 0.5) * 0.5) / (tiers - 1), 0, 1);
      var y = o.y + cb + span * (0.015 + 0.95 * q);
      var c = ax(y);
      /* widest a hand above the lowest whorl, then a slightly concave taper:
         the real outline is fuller than a straight cone in its lower half */
      var prof = Math.pow(1 - q, 0.80);
      if (q < 0.07) prof *= 0.80 + 0.20 * (q / 0.07);
      var Rt = R * prof * (0.82 + 0.32 * H(t, 2));
      if (H(t, 3) < 0.09) Rt *= 0.60;            /* a whorl that broke back */
      if (Rt < 0.30) continue;
      var slope = -0.50 + 0.92 * Math.pow(q, 0.80);
      var nb = Math.max(4, Math.round((4.2 + 4.4 * (1 - q)) * Math.sqrt(dens)));
      var a0 = t * GA + H(t, 5) * 0.7;
      for (k = 0; k < nb; k++) {
        if (H(t * 31 + k, 6) < 0.06) continue;   /* one bough in sixteen is gone */
        var an = a0 + k / nb * TAU + (H(t * 17 + k, 7) - 0.5) * 0.55;
        var L = Rt * (0.78 + 0.36 * H(t * 13 + k, 8));
        var sl = slope + (H(t * 11 + k, 9) - 0.5) * 0.22;
        var inv = 1 / Math.sqrt(1 + sl * sl);
        var bx = Math.cos(an) * inv, by = sl * inv, bz = Math.sin(an) * inv;
        var yj = y + (H(t * 7 + k, 10) - 0.5) * dyT * 0.95;
        var sh = (0.58 + 0.48 * q) * (0.86 + 0.28 * H(t * 3 + k, 12));
        /* A BOUGH IS A FLATTENED FAN, NOT A FEATHER.  One card per branch put
           a single 1.5 m frond on every spoke and the crown read as a palm
           from underneath.  Four sprays -- the inner run, the tip, and one
           side shoot each way off the middle -- give the branched plan a
           spruce bough actually has, and bring the needle texture down to
           the scale the photographs show it at. */
        var SPR = [[0.06, 0.00, 0.50, 0.20, 0.80, 0.00, 0],
                   [0.46, 0.00, 0.56, 0.19, 1.00, 0.04, 1],
                   [0.34, 0.62, 0.42, 0.16, 0.94, 0.08, 1],
                   [0.34, -0.62, 0.42, 0.16, 0.94, 0.08, 1]];
        for (var j = 0; j < 4; j++) {
          var S = SPR[j], hj = t * 53 + k * 7 + j;
          var a2 = an + S[1] * (0.8 + 0.4 * H(hj, 20));
          var ex = Math.cos(a2), ez = Math.sin(a2);
          var sl3 = sl - S[5], iv = 1 / Math.sqrt(1 + sl3 * sl3);
          var ux = ex * iv, uy = sl3 * iv, uz = ez * iv;
          var s0 = L * S[0], hl = L * S[2] * 0.5, W = L * S[3];
          var px = c[0] + bx * s0 + ux * hl, py = yj + by * s0 + uy * hl, pz = c[2] + bz * s0 + uz * hl;
          /* a little roll, so a tier is never one flat disc seen edge on */
          var roll = (H(hj, 19) - 0.5) * 0.80, cr = Math.cos(roll), sr = Math.sin(roll);
          var shj = sh * S[4] * (0.92 + 0.16 * H(hj, 21));
          /* v is chosen so that u x v points UP, so a caller that derives
             its normal from the card gets the bough's top and its sky bake.
             (nz-street-side does not: it stores a normal leaning out of the
             crown instead -- see ncardN() there for why.) */
          out.push([0, px, py, pz, ux * hl, uy * hl, uz * hl, ez * W * cr, W * sr, -ex * W * cr, shj]);
          if (S[6]) {
            /* the curtain of pendulous shoots under it, in the spray's own
               vertical plane: longest on the skirt, almost nothing at the top */
            var hang = L * S[2] * (0.60 - 0.30 * q) * (0.70 + 0.60 * H(hj, 13));
            out.push([1, px, py - hang * 0.45, pz, ux * hl * 0.94, uy * hl * 0.94, uz * hl * 0.94,
                      0, hang * 0.5, 0, shj * 0.74]);
          }
        }
      }
      /* the short inner shoots that close the gap between two whorls */
      var ni = Math.max(3, Math.round(nb * 0.55));
      for (k = 0; k < ni; k++) {
        var an2 = a0 + 0.9 + k / ni * TAU + (H(t * 23 + k, 14) - 0.5) * 0.8;
        var L2 = Rt * (0.42 + 0.22 * H(t * 29 + k, 15));
        var sl2 = slope * 0.6 + (H(t * 37 + k, 16) - 0.5) * 0.3;
        var inv2 = 1 / Math.sqrt(1 + sl2 * sl2);
        var dx2 = Math.cos(an2), dz2 = Math.sin(an2);
        var y2 = y + dyT * (0.5 + (H(t * 41 + k, 17) - 0.5) * 0.5);
        var c2 = ax(y2), hl2 = L2 * 0.5;
        out.push([0, c2[0] + dx2 * inv2 * hl2, y2 + sl2 * inv2 * hl2, c2[2] + dz2 * inv2 * hl2,
                  dx2 * inv2 * hl2, sl2 * inv2 * hl2, dz2 * inv2 * hl2,
                  dz2 * L2 * 0.36, L2 * 0.10, -dx2 * L2 * 0.36,
                  (0.44 + 0.34 * q) * (0.9 + 0.2 * H(t, 18 + k))]);
      }
      /* the dark interior: two crossed cards on the stem */
      if (Rt > 0.9) {
        var mr = Rt * 0.40, mh = dyT * 1.25, ma = a0 + 0.4;
        out.push([2, c[0], y, c[2], Math.cos(ma) * mr, 0, Math.sin(ma) * mr, 0, mh, 0, 0.30 + 0.20 * q]);
        out.push([2, c[0], y, c[2], -Math.sin(ma) * mr, 0, Math.cos(ma) * mr, 0, mh, 0, 0.27 + 0.20 * q]);
      }
    }
    /* the leader: a spruce ends in one shoot, never in a dome */
    var tp = ax(o.y + h), lh = Math.max(1.2, span * 0.055);
    out.push([3, tp[0], tp[1] - lh * 0.5, tp[2], 0, lh * 0.62, 0, lh * 0.20, 0, 0, 1.02]);
    out.push([3, tp[0], tp[1] - lh * 0.5, tp[2], 0, lh * 0.62, 0, 0, 0, lh * 0.20, 0.96]);
    return out;
  }
  /* published at PARSE time, so it is there for nz-street-side whatever this
     module's own install() goes on to do */
  NZ.streetFlora = { spruce: spruceForm };

  /* THE SPRUCE'S OWN TONE.  NEEDLE was solved for the old tiers of pale
     sprigs; the same multiplier on this much card renders a spring green.
     Measured over the crown, first build against the April 2026 frames:
         ours   p10 33,45,22   p50 62,77,45
         photo  p10 14,20,10   p50 33,39,28   (A-BLOK row and the refuge tree)
     -- a Picea under cloud is very nearly black, and only its outermost
     sprays carry any green at all.  Linear multipliers on NEEDLE, so the
     sunny profile's hue shift still passes through. */
  var SPRUCE_K = [0.36, 0.32, 0.46];

  /* ---- the pavement spruce: spruceForm() on a pit, in this module's own
     foliage atlas.  Same legality as buildConifer: the stem stands on the
     pit's S_BLOCK cell (rule C) and no card is allowed below CROWN_BASE
     (rule B) -- a drooping skirt is lifted clear rather than cut, which is
     also what a municipal pruning gang does to it. */
  function buildSpruce(P, pit, seed, hM, opt) {
    opt = opt || {};
    var baseY = opt.baseY === undefined ? Y_PAVE : opt.baseY;
    var topY = baseY + m(hM);
    var CB = opt.crownBase === undefined ? CROWN_BASE + 0.35 : opt.crownBase;
    var A = pitAxis(pit), free = !!opt.base;
    var ax = free
      ? freeAxis(opt.base.x, baseY, opt.base.z, seed, topY, opt.sway === undefined ? 0.22 : opt.sway)
      : trunkAxis(pit, seed, topY, m(0.20), 0.20);
    var i, k;
    var r0 = m(0.105 + hM * 0.0085) * (opt.trunk || 1);

    P.bark.tile(T_BARK).macro(0.5).tint(opt.bark || BARKC);
    for (i = 0; i < ax.length - 1; i++) {
      var u0 = i / (ax.length - 1), u1 = (i + 1) / (ax.length - 1);
      tube(P.bark, ax[i][0], ax[i][1], ax[i][2], ax[i + 1][0], ax[i + 1][1], ax[i + 1][2],
           r0 * (1 - u0 * 0.88), 7, 0.92, false, null, r0 * (1 - u1 * 0.88));
    }
    /* the snapped-off spurs of the branches it has lost */
    for (k = 0; k < 8; k++) {
      var sy = lerp(baseY + m(0.8), CB - 0.4, k / 7) + rr(seed, 40 + k, -0.3, 0.3);
      var sa = rr(seed, 60 + k, 0, TAU);
      var sp = axisAt(ax, sy), sl = m(0.14 + rr(seed, 80 + k, 0, 0.16));
      var ex = sp[0] + Math.cos(sa) * sl, ez = sp[2] + Math.sin(sa) * sl;
      if (!free) {
        if (ex < pit.x0 - HUG + 0.2 || ex > pit.x1 + HUG - 0.2) continue;
        if (A.sgn * (ez - A.zFront) > HUG - 0.25) continue;
      }
      tube(P.bark, sp[0], sp[1], sp[2], ex, sy - m(0.05), ez, m(0.020), 4, 0.85, true, null, m(0.011));
    }

    P.leaf.macro(0);
    var Rmax = m(0.30 + hM * 0.125) * (opt.spread || 1);
    var cards = spruceForm({
      x: ax[0][0], y: baseY, z: ax[0][2], h: topY - baseY, cb: CB - baseY, r: Rmax,
      seed: seed, dens: TIER === 'low' ? 0.74 : 1,
      axis: function (y) { return axisAt(ax, y); }
    });
    var kc2 = keepClear();
    var SPR = [L_SPRIG0, L_SPRIG1, L_SPRIG2, L_SPRIG3];
    var tone = [NEEDLE[0] * SPRUCE_K[0], NEEDLE[1] * SPRUCE_K[1], NEEDLE[2] * SPRUCE_K[2]];
    for (i = 0; i < cards.length; i++) {
      var c = cards[i], cy = c[2];
      if (insideBuilding(c[1], cy, c[3], 0.45)) continue;
      if (kc2 && c[1] > kc2.x0 - 0.6 && c[1] < kc2.x1 + 0.6 &&
          c[3] > kc2.z0 - 0.6 && c[3] < kc2.z1 + 0.6) continue;
      var low = cy - Math.abs(c[5]) - Math.abs(c[8]);
      if (low < CB) cy += CB - low;
      var tile = c[0] === 2 ? LEAF.rect[(i & 1) ? L_MASS : L_NEEDLE]
                            : LEAF.rect[SPR[(rnd(seed + i, 7) * 4) | 0]];
      card(P.leaf, c[1], cy, c[3], c[4], c[5], c[6], c[7], c[8], c[9], tile, tone, c[10]);
    }
    /* an occluder for everything built after it, as buildConifer registers */
    var span = topY - CB;
    SELF_OCC.push({
      x0: ax[ax.length - 1][0] - Rmax * 0.55, x1: ax[ax.length - 1][0] + Rmax * 0.55,
      y0: CB + span * 0.08, y1: topY - span * 0.22,
      z0: axisAt(ax, CB + span * 0.5)[2] - Rmax * 0.55,
      z1: axisAt(ax, CB + span * 0.5)[2] + Rmax * 0.55
    });
    STATS.trees++; STATS.props++;
  }

  /* ---- CEDRUS.  The hero tree, and a different plant from buildConifer. ---
     _ref/ref8 and the owner's photographs of the roundabout are a mature
     open-grown cedar, and a cedar is not a cone with fronds stuck on it.  It
     is a stack of near-HORIZONTAL PLATES: each branch runs out almost level
     and carries its foliage on the UPPER surface, so what the eye reads from
     the road is five to eight dark discs floating one above another with real
     sky between them, widest a third of the way up, and a broad irregular
     head instead of a leader spike.

     buildConifer's spruce whorls put every card on a radial spoke tilted
     down, which from a 4 m camera is a starfish: the previous island tree
     read as a bottle brush on a pole.  This builds the plates instead --
     each branch gets three or four overlapping foliage clumps laid FLAT, a
     tilted twin so a low camera never sees a zero-thickness edge, and a rim
     of short upright candles, which is the one silhouette cue that says
     cedar rather than fir.

     LEGALITY unchanged: the trunk stands on the island's S_BLOCK cells (rule
     C) and the lowest plate is above jumpTop(0.5) = 9.19 (rule B). ------- */
  function buildCedar(P, seed, hM, opt) {
    opt = opt || {};
    var baseX = opt.base.x, baseZ = opt.base.z;
    var baseY = fin(opt.baseY, Y_PAVE);
    var topY = baseY + m(hM);
    var CB = fin(opt.crownBase, baseY + m(3.0));
    var R = Rng(SEED + seed * 7717);
    var i, k, t, w;

    /* ---- the trunk.  A cedar this size is 450-550 mm at the butt and it
       stays fat a long way up, which is most of what makes it read as an old
       tree rather than a sapling with a big hat. */
    var ax = freeAxis(baseX, baseY, baseZ, seed, topY, opt.sway === undefined ? 0.22 : opt.sway);
    var r0 = m(0.235) * (opt.trunk || 1);
    P.bark.tile(T_BARK).macro(0.55).tint(opt.bark || [0.58, 0.53, 0.47]);
    for (i = 0; i < ax.length - 1; i++) {
      var u0 = i / (ax.length - 1), u1 = (i + 1) / (ax.length - 1);
      /* the taper is a curve, not a line: fat butt, long parallel middle,
         and only the last fifth runs out to nothing */
      tube(P.bark, ax[i][0], ax[i][1], ax[i][2], ax[i + 1][0], ax[i + 1][1], ax[i + 1][2],
           r0 * (1 - 0.90 * Math.pow(u0, 1.55)), 7, 0.90, false, null,
           r0 * (1 - 0.90 * Math.pow(u1, 1.55)));
    }
    /* the root flare: three short cones leaning out of the soil, which is
       what stops a trunk looking like a pipe pushed into the ground */
    for (k = 0; k < 5; k++) {
      var fa = k / 5 * TAU + R() * 0.6;
      var fl = m(0.20 + R() * 0.14);
      tube(P.bark, baseX, baseY + m(0.42), baseZ,
           baseX + Math.cos(fa) * fl, baseY - m(0.06), baseZ + Math.sin(fa) * fl,
           m(0.055), 5, 0.72, false, null, m(0.105));
    }
    /* snapped-off spurs on the clear stem */
    for (k = 0; k < 5; k++) {
      var sy = lerp(baseY + m(1.1), CB - m(0.35), k / 4) + (R() - 0.5) * m(0.25);
      var sa = R() * TAU, sp = axisAt(ax, sy), sl = m(0.13 + R() * 0.13);
      tube(P.bark, sp[0], sp[1], sp[2],
           sp[0] + Math.cos(sa) * sl, sy - m(0.03), sp[2] + Math.sin(sa) * sl,
           m(0.030), 4, 0.80, true, null, m(0.014));
    }

    /* ---- the plates ---------------------------------------------------- */
    P.leaf.macro(0);
    var span = topY - CB;
    var nT = TIER === 'low' ? 6 : (TIER === 'med' ? 7 : 9);
    var Rmax = m(hM * (opt.spread === undefined ? 0.375 : opt.spread));
    var kc = keepClear();
    function blocked(x, y, z) {
      if (insideBuilding(x, y, z, 0.45)) return true;
      return !!(kc && x > kc.x0 - 0.6 && x < kc.x1 + 0.6 && z > kc.z0 - 0.6 && z < kc.z1 + 0.6);
    }
    var NEED = opt.needle || NEEDLE;
    var SPRIGS = [L_SPRIG0, L_SPRIG1, L_SPRIG2, L_SPRIG3];

    /* one foliage clump: a flat pad, a tilted twin and an upright wisp.
       `rad` is its half-width, `dir` the branch direction it lies along. */
    function clump(cx, cy, cz, dx, dz, rad, ao, up) {
      if (blocked(cx, cy, cz)) return;
      var px = -dz, pz = dx;
      var tile = LEAF.rect[SPRIGS[(R() * 4) | 0]];
      var jit = 0.82 + R() * 0.40;
      /* THE PAD.  Horizontal, laid along the branch.  This is the plate. */
      card(P.leaf, cx, cy, cz, dx * rad * jit, 0, dz * rad * jit,
           px * rad * 0.78, 0, pz * rad * 0.78, tile, NEED, ao);
      /* the tilted twin: 22-32 deg off level, so from the road the plate has
         thickness and from below it is still opaque */
      var tl = (0.38 + R() * 0.22) * (R() < 0.5 ? 1 : -1);
      card(P.leaf, cx, cy + rad * 0.16, cz, dx * rad * 0.92, rad * tl * 0.5, dz * rad * 0.92,
           px * rad * 0.62, rad * tl, pz * rad * 0.62,
           LEAF.rect[SPRIGS[(R() * 4) | 0]], NEED, ao * 0.86);
      /* the dark body under it -- a cedar plate is nearly black underneath */
      if (R() < 0.75)
        card(P.leaf, cx, cy - rad * 0.13, cz, dx * rad * 0.70, 0, dz * rad * 0.70,
             px * rad * 0.56, 0, pz * rad * 0.56,
             LEAF.rect[(R() < 0.5) ? L_MASS : L_NEEDLE], NEED, ao * 0.52);
      /* the candles: short upright shoots on the pad's top surface */
      if (up && R() < 0.85) {
        var cw = rad * (0.46 + R() * 0.28), ch = rad * (0.26 + R() * 0.20);
        crossCard(P.leaf, cx + (R() - 0.5) * rad * 0.7, cy + rad * 0.04,
                  cz + (R() - 0.5) * rad * 0.7, cw, ch, R() * PI,
                  LEAF.rect[SPRIGS[(R() * 4) | 0]], NEED, ao * 1.04);
      }
    }

    for (w = 0; w < nT; w++) {
      var uu = nT > 1 ? w / (nT - 1) : 0;
      /* tier heights: a real cedar's lowest gap is the biggest, and they
         crowd together toward the head */
      var wy = CB + span * (0.02 + 0.98 * Math.pow(uu, 1.16)) + (R() - 0.5) * span * 0.035;
      var cp = axisAt(ax, wy);
      /* THE PROFILE.  Widest at u ~ 0.22, not at the bottom: the lowest
         branches of an open-grown cedar have been shaded out and cut back,
         and the shoulder above them is the widest part of the tree. */
      var prof = Math.pow(1 - uu, 0.62) * (0.80 + 0.34 * Math.sin(clamp(uu / 0.30, 0, 1) * PI * 0.5));
      var Rw = Rmax * prof * (0.86 + R() * 0.28);
      if (uu > 0.94) Rw *= 0.55;
      if (Rw < m(0.20)) continue;
      var nb = Math.max(4, Math.round((TIER === 'low' ? 5 : 7) * (0.70 + (1 - uu) * 0.55)));
      var a0 = R() * TAU;
      var aoT = 0.56 + 0.40 * Math.pow(uu, 0.80);

      for (k = 0; k < nb; k++) {
        /* one branch in seven is missing, which is where the sky gets in */
        if (R() < 0.13) continue;
        var an = a0 + (k / nb) * TAU + (R() - 0.5) * 0.62;
        var dx = Math.cos(an), dz = Math.sin(an);
        var Lb = Rw * (0.72 + R() * 0.40);
        /* the branch: out and very slightly UP, then level.  A cedar limb
           rises from the trunk and flattens; it does not droop like a spruce. */
        var rise = m(0.10 + R() * 0.26);
        var ex = cp[0] + dx * Lb, ez = cp[2] + dz * Lb, ey = wy + rise;
        var midx = cp[0] + dx * Lb * 0.46, midz = cp[2] + dz * Lb * 0.46;
        var midy = wy + rise * 0.72;
        if (!blocked(ex, ey, ez)) {
          P.bark.tile(T_BARK).macro(0.55).tint(opt.bark || [0.58, 0.53, 0.47]);
          tube(P.bark, cp[0], wy, cp[2], midx, midy, midz,
               r0 * (0.30 - 0.16 * uu), 5, 0.72, false, null, r0 * (0.20 - 0.11 * uu));
          tube(P.bark, midx, midy, midz, ex, ey, ez,
               r0 * (0.20 - 0.11 * uu), 4, 0.68, false, null, r0 * 0.055);
          P.leaf.macro(0);
        }
        /* THE PADS.  Size matters more than count here: at Rw = 3.9 m the
           first pass sized a pad at 0.46 Rw, i.e. a 4.4 m quad, and half a
           dozen of those is a stack of flat sheets you can see the corners
           of.  A real cedar plate is built out of sprays about a metre and a
           half across, so the pad is capped at that and there are twice as
           many of them, staggered off the limb axis. */
        var nc = Lb > m(1.5) ? 6 : 4;
        for (i = 0; i < nc; i++) {
          t = 0.26 + 0.74 * (i / (nc - 1 || 1));
          var off = (i & 1) ? 0.42 : -0.34;
          var cx2 = cp[0] + dx * Lb * t - dz * Rw * 0.16 * off + (R() - 0.5) * Rw * 0.10;
          var cz2 = cp[2] + dz * Lb * t + dx * Rw * 0.16 * off + (R() - 0.5) * Rw * 0.10;
          var cy2 = wy + rise * t * 0.9 + (R() - 0.5) * Rw * 0.06;
          var rad = Math.min(m(0.95), Rw * (0.20 + 0.10 * t) * (0.80 + R() * 0.44));
          clump(cx2, cy2, cz2, dx, dz, rad, aoT * (0.86 + 0.22 * t), true);
        }
        /* THE RIM.  A cedar plate does not end in a spike; it feathers out
           into a fringe of short shoots and then stops.  The first pass hung
           one tall upright cross card on the end of every limb, which at
           plate scale is a 1.4 m thorn -- eight of them per tier turned the
           silhouette into a saw blade.  Two small FLAT pads laid past the
           limb tip, plus one short candle, give the same broken edge without
           anything standing proud of the plate. */
        for (i = 0; i < 2; i++) {
          var fa2 = an + (i ? 0.30 : -0.30) + (R() - 0.5) * 0.20;
          var fd = Lb * (0.92 + R() * 0.16);
          clump(cp[0] + Math.cos(fa2) * fd, ey - Rw * 0.02 + (R() - 0.5) * Rw * 0.05,
                cp[2] + Math.sin(fa2) * fd, Math.cos(fa2), Math.sin(fa2),
                Rw * (0.17 + R() * 0.12), aoT * 1.02, false);
        }
        if (R() < 0.55)
          crossCard(P.leaf, ex, ey - Rw * 0.02, ez, Rw * 0.16, Rw * 0.13, R() * PI,
                    LEAF.rect[SPRIGS[(R() * 4) | 0]], NEED, aoT * 1.04);
      }

      /* the plate's own dark middle, hugging the trunk: without it you see
         straight through the tree to the sky between the limbs */
      var mR = Rw * 0.40;
      if (mR > m(0.12)) {
        for (i = 0; i < 3; i++) {
          var ma = a0 + i * 2.094, md = i ? Rw * (0.16 + 0.18 * R()) : 0;
          var mx = cp[0] + Math.cos(ma) * md, mz = cp[2] + Math.sin(ma) * md;
          var my = wy + (R() - 0.5) * span * 0.02;
          if (blocked(mx, my, mz)) continue;
          card(P.leaf, mx, my, mz, mR, 0, 0, 0, 0, mR,
               LEAF.rect[(i & 1) ? L_MASS : L_NEEDLE], NEED, aoT * 0.44);
          card(P.leaf, mx, my + mR * 0.20, mz, mR * 0.86, 0, 0, 0, mR * 0.52, 0,
               LEAF.rect[L_MASS], NEED, aoT * 0.40);
        }
      }
    }

    /* ---- the head.  A mature cedar has NO leader: the top is a broad,
       slightly domed, deliberately lopsided cluster.  Building it as a spike
       is the single most recognisable mistake, so this is a small plate of
       its own with three or four upright candles standing out of it. */
    var tp = ax[ax.length - 1];
    var hR = Rmax * 0.30;
    for (i = 0; i < 5; i++) {
      var ha = i / 5 * TAU + R() * 0.8;
      var hd = hR * (0.20 + R() * 0.85);
      var hx = tp[0] + Math.cos(ha) * hd, hz = tp[2] + Math.sin(ha) * hd;
      var hy = tp[1] - m(0.55) + (R() - 0.5) * m(0.70);
      clump(hx, hy, hz, Math.cos(ha), Math.sin(ha), hR * (0.44 + R() * 0.32), 0.94, true);
    }
    for (i = 0; i < 3; i++)
      crossCard(P.leaf, tp[0] + (R() - 0.5) * hR * 1.1, tp[1] - m(0.50),
                tp[2] + (R() - 0.5) * hR * 1.1, hR * 0.30, m(0.32 + R() * 0.26),
                R() * PI, LEAF.rect[SPRIGS[(R() * 4) | 0]], NEED, 0.98);

    SELF_OCC.push({
      x0: baseX - Rmax * 0.80, x1: baseX + Rmax * 0.80,
      y0: CB, y1: topY - span * 0.06,
      z0: baseZ - Rmax * 0.80, z1: baseZ + Rmax * 0.80
    });
    STATS.trees++; STATS.props++;
  }

  /* ---- bare deciduous: buds only, thin irregular branching --------------- */
  function buildBareTree(P, pit, seed, hM, blossom) {
    var topY = Y_PAVE + m(hM);
    var ax = trunkAxis(pit, seed, topY * 0.44, m(0.75), 0.5);
    var i;
    var r0 = m(0.075 + hM * 0.011);
    var forkY = Y_PAVE + m(hM * 0.34);
    P.bark.tile(T_BARK).macro(0.5).tint([BARKC[0] * 1.35, BARKC[1] * 1.32, BARKC[2] * 1.24]);
    for (i = 0; i < ax.length - 1; i++) {
      if (ax[i][1] > forkY) break;
      var u0 = i / (ax.length - 1), u1 = (i + 1) / (ax.length - 1);
      tube(P.bark, ax[i][0], ax[i][1], ax[i][2], ax[i + 1][0], ax[i + 1][1], ax[i + 1][2],
           r0 * (1 - u0 * 0.5), 6, 0.92, false, null, r0 * (1 - u1 * 0.5));
    }
    var fork = axisAt(ax, forkY);
    var R = Rng(seed * 2654435761);
    var maxD = TIER === 'low' ? 3 : 4;
    var tips = [];

    var kcB = keepClear();
    function blockedB(x, y, z) {
      if (insideBuilding(x, y, z, 0.35)) return true;
      /* a bare crown is airy, but it must still not grow across the door */
      return !!(kcB && x > kcB.x0 - 0.4 && x < kcB.x1 + 0.4 &&
                z > kcB.z0 - 0.4 && z < kcB.z1 + 0.4);
    }
    function limb(px, py, pz, dx, dy, dz, len, rad, depth) {
      var ex = px + dx * len, ey = py + dy * len, ez = pz + dz * len;
      if (blockedB(ex, ey, ez) || ey < CROWN_BASE - 3.5) {
        /* steer it back out into the street rather than dropping the limb */
        var A = pitAxis(pit);
        ez = pz + A.sgn * len * 0.75; ey = py + Math.abs(dy) * len * 0.7;
        if (blockedB(ex, ey, ez)) return;
      }
      tube(P.bark, px, py, pz, ex, ey, ez, rad, depth > 2 ? 5 : 4, 0.90, false, null, rad * 0.62);
      if (depth >= maxD || rad < m(0.011)) { tips.push([ex, ey, ez, dx, dy, dz, len]); return; }
      var n = 2 + ((R() * 2) | 0);
      for (var b = 0; b < n; b++) {
        var yaw2 = R() * TAU, spread = 0.42 + R() * 0.75;
        var nx = dx + Math.cos(yaw2) * spread, nz = dz + Math.sin(yaw2) * spread;
        var ny = dy * (0.62 + R() * 0.42) + 0.24;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        var t0 = 0.55 + 0.45 * (b / n);
        limb(px + dx * len * t0, py + dy * len * t0, pz + dz * len * t0,
             nx / nl, ny / nl, nz / nl, len * (0.52 + R() * 0.22), rad * 0.60, depth + 1);
      }
    }
    var prim = 3 + ((R() * 3) | 0);
    for (i = 0; i < prim; i++) {
      var a = i / prim * TAU + R() * 0.6;
      var lx = Math.cos(a) * 0.62, lz = Math.sin(a) * 0.62, ly = 1.0;
      var ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
      limb(fork[0], fork[1], fork[2], lx / ll, ly / ll, lz / ll, m(hM * 0.24), r0 * 0.62, 1);
    }
    /* the twig fuzz: without it a bare tree is a bundle of sticks, and the
       fuzz is the whole early-spring read */
    P.leaf.macro(0);
    var twigC = [0.72, 0.70, 0.66];
    for (i = 0; i < tips.length; i++) {
      var tp = tips[i];
      if (tp[1] < CROWN_BASE - 1.5) continue;
      var sz = tp[6] * (1.25 + R() * 0.9);
      var t2 = (R() < 0.5) ? L_TWIG0 : L_TWIG1;
      var ux = tp[3] * sz * 0.5, uy = tp[4] * sz * 0.5, uz = tp[5] * sz * 0.5;
      var px2 = -tp[5], pz2 = tp[3];
      var pl = Math.sqrt(px2 * px2 + pz2 * pz2) || 1;
      card(P.leaf, tp[0] + ux, tp[1] + uy, tp[2] + uz, ux, uy, uz,
           px2 / pl * sz * 0.42, 0, pz2 / pl * sz * 0.42, LEAF.rect[t2], twigC, 0.94);
      card(P.leaf, tp[0] + ux, tp[1] + uy, tp[2] + uz, ux, uy, uz,
           0, sz * 0.40, 0, LEAF.rect[t2], twigC, 0.88);
      if (blossom && R() < 0.42)
        card(P.leaf, tp[0] + ux, tp[1] + uy, tp[2] + uz, ux * 1.1, uy * 1.1, uz * 1.1,
             px2 / pl * sz * 0.36, sz * 0.14, pz2 / pl * sz * 0.36,
             LEAF.rect[L_BLOSSOM], [0.92, 0.90, 0.88], 1.0);
    }
    STATS.trees++; STATS.props++;
  }

  /* =======================================================================
     SECTION 11B -- THE JUNCTION ISLAND (_ref/ref8-park-intersection.png).

     The street now begins at a junction, and the kerbed teardrop in the
     middle of it is the first thing the player sees.  GROUND owns the precast
     ring, the soil and the road markings around it; PROPS owns everything
     that stands ON it, and _ref/ref8 says exactly what that is:

       ONE dominant conifer, 9-10 m, its lower branches long gone so what
         reads from the road is a bare trunk under a dark mass that fills the
         top of the frame.  This is deliberate and it is the whole reason the
         crown base is 4.2 m here and 2.7 m on the pavements: at eye height
         the island tree must NOT close the street, and a conifer skirted to
         the ground at 4 m from the camera closes it completely;
       a blue rectangular direction board and a round blue mandatory arrow on
         galvanised poles at the west nose, where the traffic meets them;
       a black-on-yellow chevron board protecting the nose itself;
       a red warning triangle on a pole at the throat -- which is on the
         PAVEMENT RETURN east of it, not on the island, because the north
         pavement is cut away for the throat at x [176,192] and nothing may
         stand at pavement height in that gap;
       scruffy grass and two low spreading junipers on the bare soil.

     LEGALITY, rule C.  The island is a 2 x 2 run of S_BLOCK cells (8 x 8
     units), so everything here stands on solid ground with 0.98 of legal
     overhang -- and the poles are set well inside the precast ring anyway,
     because that is where a real one puts them.

     THE SIGHTLINE.  Nothing in this section is allowed to stand between the
     island and the foyer door along the crown of the road (x 184 -> 244,
     z ~ 172).  The signs are all WEST of x 186 and the conifer's canopy
     starts at 4.2 m, i.e. 2.4 m above the player's eye. */
  var ISLGRASS = [0.78, 0.80, 0.50];
  var SHRUBC = [0.73, 0.58, 0.64];

  /* ---- MISSION 4: THE PLANTING'S CHROMA ----------------------------------
     Every tone in this file was measured against the OVERCAST money shot,
     where the whole street sits inside one flat 0.22-lum dome and a green
     that is only just green still reads as green because nothing around it
     is coloured either.  Under the sunny profile the sky is 0.62 irradiance
     with a 1.30 saturation grade, the render, the brick and the road all
     gained chroma, and the planting did not: the island conifer measured
     rgb 58,59,44 on cordon.roundabout -- G one point above R, i.e. an olive
     drab, on a street where the sky behind it is 114,154,201.  A spruce in
     sun is the most saturated thing on a Turkish street after the shopfront
     awnings.

     These are ALBEDO multipliers on the per-vertex tone, applied AFTER the
     bake exactly like every other tone here, and they only ever move the
     hue balance -- the luminance of each triple is held to within 2 % of
     what it was, so nothing gets brighter, it only gets greener.  Mission 1
     never calls this. */
  var TONED = false;
  function sunnyTones() {
    if (TONED) return;      /* install() can run again after dispose() */
    TONED = true;
    NEEDLE = [NEEDLE[0] * 0.84, NEEDLE[1] * 1.14, NEEDLE[2] * 0.80];
    SHRUBC = [SHRUBC[0] * 0.82, SHRUBC[1] * 1.20, SHRUBC[2] * 0.78];
    ISLGRASS = [ISLGRASS[0] * 0.88, ISLGRASS[1] * 1.10, ISLGRASS[2] * 0.76];
  }

  function islandSoil(x, z) {
    var y = ISLE.soilAt(x, z);
    return isFinite(y) ? y : Y_ISLS;
  }

  /* a galvanised sign post with a tile on it, front and back.  Rule C: the
     footprint is a 60 mm tube on the island's own blocked cells. */
  function signPost(P, x, z, hM, faces) {
    var y0 = islandSoil(x, z) - 0.10, top = y0 + m(hM), i;
    var pr = m(0.030);
    P.steel.tile(T_STEEL).macro(0.2);
    tube(P.steel, x, y0 - 0.20, z, x, top, z, pr, 7, 0.94, true, POSTC, pr * 0.94);
    /* the cast collar at the base, and the concrete plug it is set in */
    tube(P.steel, x, y0 - 0.05, z, x, y0 + m(0.10), z, pr * 1.7, 7, 0.88, true,
         [POSTC[0] * 0.88, POSTC[1] * 0.88, POSTC[2] * 0.86], pr * 1.35);
    P.panel.macro(0);
    for (i = 0; i < faces.length; i++) {
      var F = faces[i];
      var sy = y0 + m(F.y), hw = F.w * 0.5, hh = F.h * 0.5;
      /* the two clamp bands that hold the plate to the post */
      P.steel.tile(T_STEEL);
      for (var b = 0; b < 2; b++) {
        var by = sy + (b ? hh * 0.55 : -hh * 0.55);
        tube(P.steel, x, by, z - m(0.02), x, by, z + m(0.02), pr * 1.45, 6, 0.90, true, POSTC);
      }
      P.panel.macro(0);
      /* the face that is read, and its grey back -- a sign is sheet steel and
         the back of one is never the same value as the front.  `nx` says the
         plate faces along X (the island signs are read from the approach, up
         the street), so the plate's own u-axis runs along Z and the 22 mm
         offset that separates front from back has to follow the normal. */
      var ux2 = F.nx ? 0 : hw, uz2 = F.nx ? hw : 0;
      var ox = F.nx ? m(0.022) : 0, oz = F.nx ? 0 : m(0.022);
      card(P.panel, x - F.n * ox, sy, z - F.n * oz, ux2, 0, uz2, 0, hh, 0,
           PANEL.rect[F.tile], [0.90, 0.90, 0.90], 1.0,
           F.nx ? [-F.n, 0, 0] : [0, 0, -F.n]);
      card(P.panel, x + F.n * ox, sy, z + F.n * oz, ux2, 0, uz2, 0, hh, 0,
           PANEL.rect[F.tile], [0.42, 0.43, 0.44], 0.80,
           F.nx ? [F.n, 0, 0] : [0, 0, F.n]);
    }
    STATS.props++;
    return { x: x, y: top, z: z };
  }

  /* a clipped evergreen ball -- juniper or thuja, the one the photographs put
     on the island beside the cedar.  It is NOT a low mat: in _ref/ref8 and in
     the owner's close-up of the kerb ring it stands about a metre and a
     quarter, is nearly as wide as it is tall, and its silhouette is a solid
     dome with a soft broken top.  The previous version laid six flat cards
     out at 0.4 m and read, correctly, as nothing at all.

     Built as a shell: an opaque core of crossed mass cards that owns the
     silhouette, then a skin of tangential sprays over a hemisphere so the
     outline breaks up and the thing has depth at two metres.
     Rule E -- under CLIMB = 1.15 it is a step; over it, it stands on the
     island's own S_BLOCK cells, so either way it is legal. */
  function buildShrub(P, x, z, rM, seed, baseY, hM) {
    var y = baseY === undefined ? islandSoil(x, z) : baseY, i, k;
    var R = Rng(SEED + seed * 3301);
    var rr2 = m(rM), hh = m(hM === undefined ? rM * 1.45 : hM);
    P.leaf.macro(0);

    /* the core: four crossed cards at three heights, tapering to the top.
       This is what makes it opaque -- the skin alone is a wire ball. */
    for (k = 0; k < 3; k++) {
      var q = (k + 0.5) / 3;
      var cy = y + hh * q * 0.94;
      var cr = rr2 * Math.sqrt(Math.max(0.06, 1 - Math.pow(q * 1.06, 2.1))) * 0.94;
      var ch = hh * (0.30 - 0.07 * k);
      if (cr < m(0.05)) continue;
      for (i = 0; i < 2; i++) {
        var a = (i * 0.5 + k * 0.22) * PI + R() * 0.4;
        card(P.leaf, x, cy, z, Math.cos(a) * cr, 0, Math.sin(a) * cr, 0, ch, 0,
             LEAF.rect[(k & 1) ? L_MASS : L_NEEDLE], SHRUBC, 0.40 + 0.26 * q);
      }
    }
    /* the skin: sprays laid tangentially over the dome, denser near the top
       where the light is, and each one tilted so no two share a plane */
    var n = Math.max(18, Math.round(34 * DENSITY));
    for (i = 0; i < n; i++) {
      var u = (i + 0.5) / n;
      /* a spiral over the hemisphere, so the cards never queue up in rings */
      var phi = Math.acos(clamp(1 - 1.06 * u, -1, 1));
      var th = i * 2.39996 + R() * 0.5;
      var sr = Math.sin(phi), sy2 = Math.cos(phi);
      var px = x + Math.cos(th) * sr * rr2 * 0.90;
      var pz = z + Math.sin(th) * sr * rr2 * 0.90;
      var py = y + hh * (0.06 + 0.92 * sy2 * 0.92 + 0.08);
      if (py < y + m(0.04)) py = y + m(0.04);
      var w = rr2 * (0.24 + R() * 0.18), hgt = hh * (0.20 + R() * 0.15);
      var tw = -Math.sin(th), tz = Math.cos(th);
      var tilt = 0.30 + R() * 0.45;
      card(P.leaf, px, py, pz,
           tw * w, (R() - 0.5) * w * 0.4, tz * w,
           Math.cos(th) * hgt * tilt, hgt, Math.sin(th) * hgt * tilt,
           LEAF.rect[(R() < 0.25) ? L_SHRUB : [L_SPRIG1, L_SPRIG3, L_SPRIG0, L_SPRIG2][(R() * 4) | 0]], SHRUBC,
           0.46 + 0.50 * sy2 + R() * 0.10);
    }
    /* the scruffy top: a clipped ball is never a perfect dome */
    for (i = 0; i < 3; i++)
      crossCard(P.leaf, x + (R() - 0.5) * rr2 * 0.8, y + hh * (0.80 + R() * 0.10),
                z + (R() - 0.5) * rr2 * 0.8, rr2 * (0.28 + R() * 0.20),
                hh * (0.16 + R() * 0.16), R() * PI,
                LEAF.rect[L_SHRUB], SHRUBC, 0.92 + R() * 0.12);
    /* the dark skirt where it meets the grass */
    card(P.leaf, x, y + hh * 0.10, z, rr2 * 0.92, 0, 0, 0, hh * 0.14, 0,
         LEAF.rect[L_MASS], SHRUBC, 0.30);
    card(P.leaf, x, y + hh * 0.10, z, 0, 0, rr2 * 0.92, 0, hh * 0.14, 0,
         LEAF.rect[L_MASS], SHRUBC, 0.28);
    STATS.props++;
  }

  function buildIsland(P) {
    if (!ISLE) { warn('no island footprint -- the junction ships bare'); return null; }
    var cx = fin(ISLE.cx, (ISLE.x0 + ISLE.x1) * 0.5);
    var cz = fin(ISLE.cz, (ISLE.z0 + ISLE.z1) * 0.5);
    var pl = ISLE.plant || { x: cx + 0.55, z: cz, r: 2.05 };
    var i, j;

    /* ---- the conifer.  9.6 m, and the ONE dominant thing at the junction.
       Its base sits on GROUND's soil, not on the pavement height every other
       tree in this file uses, because the island soil is 65 mm below its own
       kerb and 0.9 units above the road. */
    var soilY = islandSoil(pl.x, pl.z);
    buildCedar(P, 4177, 10.4, {
                   base: { x: pl.x, z: pl.z }, baseY: soilY,
                   /* THE CROWN BASE IS THE WHOLE COMPOSITION.  The island
                      camera stands 13 units -- 3.7 m -- from this trunk, so
                      every 3.5 units of crown base is 15 degrees of frame.
                      At ref8's literal 4.2 m the canopy is entirely ABOVE a
                      70 deg frame and all that is left is a bare pole; at
                      2.0 m it closes the street.  3.1 m puts the lowest whorl
                      at 24 deg elevation -- the canopy fills the top-left
                      exactly as the photograph does, and the foyer door
                      (3.8 deg, 73 units away) passes clean underneath it. */
                   crownBase: soilY + m(3.05), sway: 0.20, trunk: 1.06, spread: 0.375,
                   bark: [0.60, 0.54, 0.47]
                 });

    /* ---- the west nose: the two blue signs and the chevron board -------- */
    var noseX = fin(ISLE.noseX, ISLE.x0 + 0.6);
    /* keep every pole inside the ring: 0.45 u of soil between the kerb back
       and the post, which is where a real one is set */
    var px0 = Math.max(ISLE.x0 + 0.75, noseX + 0.45);
    /* the three faces are SPREAD, not stacked.  In _ref/ref8 the round blue
       plate stands alone on the near shoulder and the boards are set back
       past it, and that separation is what stops the nose reading as one
       billboard: at 13 units a 1.1 m board is already 5 degrees wide.
       All three face WEST, up the approach -- they are read by traffic coming
       down the side street and along the apron, never from the island. */
    signPost(P, px0 + 2.35, cz - 1.95, 2.60, [
      { tile: P_SIGNDIR, y: 2.00, w: DIRSN.w, h: DIRSN.h, n: 1, nx: 1 }
    ]);
    signPost(P, px0 + 0.85, cz + 1.85, 2.20, [
      { tile: P_SIGNARR, y: 1.66, w: m(0.60), h: m(0.60), n: 1, nx: 1 }
    ]);
    /* the chevron board on the nose itself: two short legs, a wide plate, and
       it faces due west because that is the direction the traffic hits it */
    (function () {
      var bx = px0 + 0.10, by = islandSoil(bx, cz), bw = m(0.80), bh = m(0.44);
      var syb = by + m(0.92);
      P.steel.tile(T_STEEL).macro(0.2);
      for (i = 0; i < 2; i++) {
        var lz = cz + (i ? 1 : -1) * bw * 0.34;
        /* 0.20 -> 0.55 into the soil, and a cast collar on top of it.  A 24 mm
           leg is 0.6 px at island range: with nothing at its foot the review
           reads the plate as floating over the nose, because the only thing
           saying "planted" was six pixels of grass in front of the last
           0.2 units of tube.  The signposts three metres away already carry a
           collar and a concrete plug (signPost, above) and this is the same
           detail at the same size -- 65 mm of spun collar and a 130 mm plug
           standing 40 mm proud of the soil, which is what a real chevron
           board's feet are set in. */
        tube(P.steel, bx, by - 0.55, lz, bx, syb + bh * 0.5, lz, m(0.024), 6, 0.92, true, POSTC);
        tube(P.steel, bx, by - 0.05, lz, bx, by + m(0.075), lz, m(0.038), 6, 0.88, true,
             [POSTC[0] * 0.88, POSTC[1] * 0.88, POSTC[2] * 0.86], m(0.030));
        P.conc.tile(T_CONC).macro(0.4);
        tube(P.conc, bx, by - 0.30, lz, bx, by + 0.04, lz, m(0.075), 7, 0.86, true,
             CONCC, m(0.060));
        P.steel.tile(T_STEEL).macro(0.2);
      }
      P.panel.macro(0);
      card(P.panel, bx - 0.05, syb, cz, 0, 0, bw * 0.5, 0, bh * 0.5, 0,
           PANEL.rect[P_CHEV], [0.92, 0.92, 0.90], 1.0, [-1, 0, 0]);
      card(P.panel, bx + 0.05, syb, cz, 0, 0, bw * 0.5, 0, bh * 0.5, 0,
           PANEL.rect[P_CHEV], [0.40, 0.40, 0.39], 0.78, [1, 0, 0]);
      STATS.props++;
    })();

    /* ---- what grows on it ------------------------------------------------
       GROUND already lays weed tufts over the whole soil surface, so this is
       the layer above that: two low junipers east of the trunk (ref8 has them
       exactly there, filling the wide end of the teardrop) and a scatter of
       taller grass where the mower never reaches, against the kerb back. */
    /* ONE dominant ball east of the trunk and two smaller ones behind it --
       that is the planting in the owner's close-up of the kerb ring, and the
       big one is what gives the island something at eye height between the
       kerb and the first branch four metres up. */
    /* Clear of the trunk.  The plant sits at cx + 0.55 and this island is
       only 8 units across, so a ball at cx + 1.75 is 340 mm off the bark and
       reads as a pile of clippings heaped against it rather than as a shrub.
       Everything goes to the wide east end, which is where the photographs
       put the planting anyway. */
    buildShrub(P, cx + 2.45, cz + 1.30, 0.62, 11, undefined, 1.05);
    buildShrub(P, cx + 2.30, cz - 1.55, 0.44, 23, undefined, 0.70);
    if (DENSITY > 0.7) buildShrub(P, cx - 1.35, cz + 1.95, 0.38, 37, undefined, 0.56);

    /* THE TURF.  GROUND paints the soil, but a painted plane seen from a
       standing camera four metres away is a plane, and twenty-six lonely
       tufts on it read as a building site.  The owner's close-up of this
       kerb ring is continuous rough grass with bare patches showing through,
       so the card layer has to be dense enough to BE the surface -- about
       one tuft per 0.35 m of island -- with a taller fringe against the kerb
       back where no mower reaches. */
    P.leaf.macro(0);
    var R = Rng(SEED + 6607);
    var isW = (ISLE.x1 - ISLE.x0), isD = (ISLE.z1 - ISLE.z0);
    var nT = Math.round(clamp(isW * isD * 3.6, 90, 300) * DENSITY);
    for (i = 0; i < nT; i++) {
      var a = R() * TAU, rr3 = Math.sqrt(R());
      var gx = cx + Math.cos(a) * rr3 * isW * 0.50;
      var gz = cz + Math.sin(a) * rr3 * isD * 0.50;
      if (!onIsland(gx, gz, -0.42)) continue;
      /* never inside the trunk, and never where a pole stands */
      var dtx = gx - pl.x, dtz = gz - pl.z;
      if (dtx * dtx + dtz * dtz < 1.1) continue;
      /* the fringe: everything in the outer fifth grows taller */
      var edge = clamp((rr3 - 0.74) / 0.26, 0, 1);
      /* SCALE, not colour, is what makes card grass read as grass.  The tone
         measured right first time (luminance 72 against the photographs' 72
         and 78) while the tufts still looked like a reed bed, because they
         were up to 550 mm tall on a 2.3 m island -- knee-high.  Mown-ish
         municipal turf is 60 to 250 mm and there is four times as much of it. */
      var hh2 = m(0.055 + R() * 0.085 + edge * 0.105);
      crossCard(P.leaf, gx, islandSoil(gx, gz) - 0.03, gz, hh2 * (0.85 + R() * 0.55), hh2,
                R() * PI, LEAF.rect[R() < 0.58 ? L_WEED0 : (R() < 0.86 ? L_WEED1 : L_DRY)],
                ISLGRASS, 0.72 + R() * 0.30);
    }
    void j;
    STATS.props++;
    return { x: pl.x, z: pl.z, y: soilY };
  }

  /* THE WARNING TRIANGLE AT THE THROAT.  Not on the island: on the pavement
     return east of the throat, on the tree-pit cell that is the first blocked
     ground east of the gap.  The north pavement does not exist between
     x = 176 and x = 192 -- GROUND repaints those cells ROAD at f = 0 for the
     side street -- so a pole planted there would stand on asphalt at pavement
     height, which is the one thing the amendment says must not happen. */
  function buildThroatSign(P, pit) {
    if (!pit) return null;
    var A = pitAxis(pit);
    var x = pit.x0 + 0.80;
    /* the pavement edge of the pit cell, exactly where the lamp column goes:
       a sign pole stands at the kerb, not in the bed behind the wall, and the
       wall is cut around it because a pole always predates a garden */
    var z = A.zFront + A.sgn * (HUG - 0.22);
    if (x > THROAT.x0 - 0.5 && x < THROAT.x1 + 0.5) {
      DIAG.legal.push('throat warning sign suppressed: x ' + x.toFixed(1) +
                      ' is inside the pavement gap [' + THROAT.x0 + ',' + THROAT.x1 + ']');
      return null;
    }
    var y0 = Y_PAVE, top = y0 + m(2.85), i;
    var pr = m(0.030);
    P.steel.tile(T_STEEL).macro(0.2);
    tube(P.steel, x, y0 - 0.20, z, x, top, z, pr, 7, 0.94, true, POSTC, pr * 0.94);
    P.panel.macro(0);
    /* the triangle reads from the WEST, i.e. from the junction approach */
    var sy = y0 + m(2.20), hw = m(0.44);
    for (i = 0; i < 2; i++) {
      var s2 = i ? 1 : -1;
      card(P.panel, x - s2 * m(0.020), sy, z, 0, 0, hw, 0, hw, 0,
           PANEL.rect[P_WARN], i ? [0.44, 0.44, 0.43] : [0.92, 0.92, 0.90],
           i ? 0.80 : 1.0, [-s2, 0, 0]);
    }
    P.steel.tile(T_STEEL);
    tube(P.steel, x, sy - hw * 0.55, z - m(0.02), x, sy - hw * 0.55, z + m(0.02), pr * 1.4, 6, 0.90, true, POSTC);
    STATS.props++;
    return { x: x, y: top, z: z, cut: [x - m(0.26), x + m(0.26)] };
  }

  /* =======================================================================
     SECTION 12 -- garden strips, walls, railings, gates.

     LEGALITY.  The strip between the facade and the pavement is only 0.9 m
     here (the carve gives 2.29 m of pavement, not the 4 m the photographs
     have), so the continuous garden edging is built to rule E: 0.30 m tall,
     which is under CLIMB = 1.15 and therefore a step, not an obstacle.  The
     full-height walls -- 500 mm of oxide-red render with the paint flaking
     off in big patches to show white beneath, which is the most specific
     texture in ref1 -- stand only where a tree pit gives a blocked cell to
     stand them on (rule C).  That is also what the photographs show: the
     pavement is not a clean continuous ribbon, it is interrupted by gardens.
     ==================================================================== */
  var EDGE_H = 1.12;                      /* 0.32 m: rule E, and it is a kerb */
  var WALL_H = m(0.50), COPE_H = m(0.035), RAIL_H = m(0.82);
  var WALLC = [1.0, 1.0, 1.0];            /* the flake is IN the map          */
  var BRICKC = [1.0, 1.0, 1.0];           /* the bond and its colour are IN the map */
  var CONCC = [0.92, 0.915, 0.90];
  var EARTH = [0.135, 0.118, 0.096];
  var WEEDC = [0.82, 0.86, 0.76];

  /* ---- SETTLED GRIME ON A HORIZONTAL SURFACE ---------------------------
     THE REVIEW SAID "car roofs read hot".  It is the right observation and
     the wrong object: measured on _shots/pol/street.south34.png, of the 1 233
     pixels at or above 240 in that frame, 1 232 are NOT car paint -- they are
     the precast COPING of the garden wall, which runs east along the kerb
     from two metres in front of the lens to the far end of the block and
     therefore owns a whole wedge of the lower frame.  Proved by two probes:
     with every fleet colour forced to 0.02 the wedge does not move a value,
     and with DUST_AMT at 1.0 over a black dust it moves by 4.

     Why it blows.  A coping is P.conc at tone 0.92 over a concrete map, i.e.
     an albedo near 0.5, and an up-facing surface in this street receives the
     full DAY_IRRADIANCE of 2.00 -- 1.0 of scene-linear before the grade has
     touched it, where the wall below it, at the same albedo and a vertical
     normal, gets a third of that.  No exposure can hold both.

     What a real one looks like: the top of a garden wall on a provincial
     street is the dirtiest horizontal surface in the frame.  It collects
     everything the road throws up and nothing washes it off sideways -- the
     same argument carTone() already makes for a bonnet, and the same shape of
     fix.  0.55 of a 0.15 grit at a dead-flat normal takes a coping to 0.497,
     which is x 0.54 of scene-linear and (through the grade's 1.6 exponent)
     245 -> ~220: the brightest legitimate thing in the frame, and not
     clipped.  A vertical face has ny = 0 and is not touched at all, so every
     wall value the previous passes calibrated stands. */
  var UPGRIME = [0.150, 0.148, 0.142];
  var UP_AMT = 0.55;
  function upTone(base) {
    return function (p, ny) {
      if (!(ny > 0.02)) return base;
      var d = Math.pow(clamp(ny, 0, 1), 1.5) * UP_AMT;
      return [lerp(base[0], UPGRIME[0], d), lerp(base[1], UPGRIME[1], d),
              lerp(base[2], UPGRIME[2], d)];
    };
  }
  var CONCT = upTone(CONCC);

  /* The present 233 Sk layout puts cream A-BLOK on the NORTH and salmon
     B-BLOK on the SOUTH.  Their boundary walls are deliberately different:
     flaking muted-red panelled render at A, tan stretcher-bond brick at B. */
  function wallPile(P, side) { return side === 'N' ? P.wall : P.brick; }
  function wallTile(side) { return side === 'N' ? T_WALL : T_BRICK; }
  function wallCol(side) { return side === 'N' ? WALLC : BRICKC; }

  function gardenLine(f) {
    /* Fixed survey line: 10 world units = 2.86 m off each street facade. */
    return f.side === 'N' ? 150 : 198;
  }

  function buildEdging(P, side, pits, skips) {
    var f = faceOf(side);
    if (!f || f.axis !== 'z') return;
    /* Low photographed boundary walls, parallel to 233 Sk and about three
       metres in front of the buildings.  Three gates line up with the three
       raised residential doors. */
    var zHero = side === 'N' ? 150 : 198;
    var zDoor = side === 'N' ? 140 : 208;
    var hz = m(0.09), base = Y_PAVE - 0.04;
    var cope = m(0.07), wallH = side === 'N' ? m(1.02) : m(0.92);
    var top = base + wallH, bodyTop = top - cope;
    var gates = [608, 668, 728], gateW = m(1.38), runsHero = [];
    var cursor = 580, gi, si;
    for (gi = 0; gi < gates.length; gi++) {
      var ga = gates[gi] - gateW * 0.5, gb = gates[gi] + gateW * 0.5;
      if (ga > cursor) runsHero.push([cursor, ga]);
      cursor = gb;
    }
    if (cursor < 756) runsHero.push([cursor, 756]);
    var WP = wallPile(P, side), WC = wallCol(side);
    WP.tile(wallTile(side)).macro(side === 'N' ? 0.58 : 0.68);
    P.conc.tile(T_CONC).macro(0.75);
    /* The three-metre setback is private garden, not extra pavement: a muted
       winter lawn with clipped shrubs, interrupted only by the three walks. */
    var gz0 = Math.min(zHero, zDoor), gz1 = Math.max(zHero, zDoor);
    poly(P.conc, [[580, Y_PAVE + 0.005, gz0], [756, Y_PAVE + 0.005, gz0],
                  [756, Y_PAVE + 0.005, gz1], [580, Y_PAVE + 0.005, gz1]],
         668, Y_PAVE - 2, (gz0 + gz1) * 0.5, 0.92, [0.46, 0.56, 0.31]);
    for (gi = 0; gi < 9; gi++) {
      var sxg = 590 + gi * 19.5;
      if (Math.abs(sxg - 608) < 5 || Math.abs(sxg - 668) < 5 || Math.abs(sxg - 728) < 5) continue;
      buildShrub(P, sxg, (gz0 + gz1) * 0.5 + ((gi & 1) ? 1.25 : -1.1),
                 0.48 + (gi % 3) * 0.08, 901 + gi + (side === 'N' ? 0 : 100),
                 Y_PAVE + 0.015);
    }
    for (si = 0; si < runsHero.length; si++) {
      var ra = runsHero[si][0], rb = runsHero[si][1];
      box6(WP, ra, rb, base, bodyTop, zHero - hz, zHero + hz, 1.0, function (p) {
        var q = clamp((p[1] - base) / m(0.42), 0, 1), kk = 0.68 + 0.32 * q;
        return [WC[0] * kk, WC[1] * kk, WC[2] * kk];
      });
      box6(P.conc, ra - m(0.025), rb + m(0.025), bodyTop, top,
           zHero - hz - m(0.025), zHero + hz + m(0.025), 1.0, CONCT);

      /* A-BLOK's surviving white rectangular panel borders are geometry, not
         noise in the paint map.  Their regular rhythm is visible even where
         most of the red film has flaked away.
         THE LAYOUT IS THE OWNER'S OWN FRAMES OF THIS WALL (2015, 2019, 2026):
         a ladder of near-square fields about 55 cm across -- not the 1.5 m
         bays this first drew -- between two white lines that leave a plain
         maroon band under the coping and a taller one above the pavement,
         each field carrying one small white boss at its centre.  A sixth of
         the bosses have dropped off by 2026 and so have ours. */
      if (side === 'N' && rb - ra > m(0.45)) {
        var ins = m(0.10), yLo = base + m(0.21), yHi = bodyTop - m(0.17);
        var band = m(0.042), fa = ra + ins, fb = rb - ins;
        var zf0 = zHero + hz + m(0.004), zf1 = zf0 + m(0.014);
        var frameC = [0.93, 0.91, 0.87];
        if (fb > fa + band * 2 && yHi > yLo + band * 2) {
          box6(P.conc, fa, fb, yLo, yLo + band, zf0, zf1, 0.94, frameC);
          box6(P.conc, fa, fb, yHi - band, yHi, zf0, zf1, 0.94, frameC);
          var panels = Math.max(1, Math.round((fb - fa) / m(0.56))), pi;
          for (pi = 0; pi <= panels; pi++) {
            var px = lerp(fa, fb, pi / panels);
            box6(P.conc, px - band * 0.5, px + band * 0.5, yLo, yHi,
                 zf0, zf1, 0.94, frameC);
          }
          var bw = m(0.048), bh = m(0.062), bcy = (yLo + yHi) * 0.5;
          for (pi = 0; pi < panels; pi++) {
            if (rnd(4410 + si * 61 + pi, 3) < 0.16) continue;
            var bx = lerp(fa, fb, (pi + 0.5) / panels);
            box6(P.conc, bx - bw, bx + bw, bcy - bh, bcy + bh,
                 zf0, zf1 + m(0.006), 0.94, frameC);
          }
        }
      }
    }
    /* Gate piers, OPEN dark-red steel leaves, and paver walks through the
       private strip make the three entrances unambiguous.  The grid openings
       are passable, so each half-leaf is folded back into the garden instead
       of drawing a closed collision-looking panel across the threshold. */
    for (gi = 0; gi < gates.length; gi++) {
      var gc = gates[gi], ga2 = gc - gateW * 0.5, gb2 = gc + gateW * 0.5;
      /* A-BLOK's gate piers stand head-high in every frame of them, well
         clear of the wall they close; B-BLOK's brick ones only just do */
      var pier = m(0.18), postTop = top + m(side === 'N' ? 0.80 : 0.22);
      box6(WP, ga2 - pier, ga2 + pier, base, postTop,
           zHero - hz * 1.45, zHero + hz * 1.45, 1.0, WC);
      box6(WP, gb2 - pier, gb2 + pier, base, postTop,
           zHero - hz * 1.45, zHero + hz * 1.45, 1.0, WC);
      box6(P.conc, ga2 - pier - m(0.025), ga2 + pier + m(0.025), postTop, postTop + cope,
           zHero - hz * 1.60, zHero + hz * 1.60, 1.0, CONCT);
      box6(P.conc, gb2 - pier - m(0.025), gb2 + pier + m(0.025), postTop, postTop + cope,
           zHero - hz * 1.60, zHero + hz * 1.60, 1.0, CONCT);
      P.steel.tile(T_STEEL).macro(0.36);
      var gy0 = base + m(0.12), gy1 = side === 'N' ? base + m(1.42) : top - m(0.10);
      var bars = side === 'N' ? 6 : 4;
      var gateDir = side === 'N' ? -1 : 1;
      var leafLen = gateW * 0.46;
      var hinges = [ga2, gb2], hi;
      var gateC = side === 'N' ? RAILCOL[2] : [0.105, 0.060, 0.052];
      for (hi = 0; hi < hinges.length; hi++) {
        var hxg = hinges[hi], zend = zHero + gateDir * leafLen;
        tube(P.steel, hxg, gy0, zHero, hxg, gy0, zend, m(0.018), 4, 0.94, true, gateC);
        tube(P.steel, hxg, gy1, zHero, hxg, gy1, zend, m(0.024), 4, 0.96, true, gateC);
        for (si = 0; si <= bars; si++) {
          var gz = lerp(zHero + gateDir * m(0.08), zend, si / bars);
          tube(P.steel, hxg, gy0, gz, hxg, gy1, gz, m(0.012), 4, 0.94, false, gateC);
        }
        if (side === 'N') {
          /* the sheet-steel kicking panel that fills the lower part of each
             leaf, and the mid rail it is welded under */
          var gym = lerp(gy0, gy1, 0.44);
          box6(P.steel, hxg - m(0.005), hxg + m(0.005), gy0, gym,
               Math.min(zHero + gateDir * m(0.08), zend), Math.max(zHero + gateDir * m(0.08), zend),
               0.94, gateC);
          tube(P.steel, hxg, gym, zHero, hxg, gym, zend, m(0.018), 4, 0.95, true, gateC);
        }
      }
      var z0p = Math.min(zHero, zDoor), z1p = Math.max(zHero, zDoor);
      poly(P.conc, [[ga2 + m(0.10), Y_PAVE + 0.015, z0p],
                    [gb2 - m(0.10), Y_PAVE + 0.015, z0p],
                    [gb2 - m(0.10), Y_PAVE + 0.015, z1p],
                    [ga2 + m(0.10), Y_PAVE + 0.015, z1p]],
           gc, Y_PAVE - 2, (z0p + z1p) * 0.5, 0.94, CONCC);
      STATS.props += 2;
    }

    /* The faded red-and-white garden wall in front of the yellow corner
       building turns the corner onto 232 Sk.  It is deliberately kept low,
       with a clear break at the apartment door, so the sidewalk remains
       usable and the wall reads as the same plot boundary as the long wall
       along 233 Sk. */
    if (side === 'N') {
      /* Pull the return 1.2 u toward the road so its flaking face is readable
         as a boundary wall instead of disappearing into the yellow façade. */
      var sx = 578.80, sw = m(0.10), sideRuns = [[104.0, 126.0], [134.0, 149.55]];
      var sideHz = m(0.09), sTop = base + wallH, sBodyTop = sTop - cope;
      for (si = 0; si < sideRuns.length; si++) {
        var szA = sideRuns[si][0], szB = sideRuns[si][1];
        box6(WP, sx - sw, sx + sw, base, sBodyTop,
             szA, szB, 1.0, function (p) {
               var q = clamp((p[1] - base) / m(0.42), 0, 1), kk = 0.68 + 0.32 * q;
               return [WC[0] * kk, WC[1] * kk, WC[2] * kk];
             });
        box6(P.conc, sx - sw - m(0.018), sx + sw + m(0.018), sBodyTop, sTop,
             szA - sideHz, szB + sideHz, 1.0, CONCT);
        /* the same ladder of white-lined fields on the road-facing (west)
           side: it is one wall, and it turns the corner without changing */
        var pBand = m(0.042), pInset = m(0.10), za = szA + pInset, zb = szB - pInset;
        var pLo = base + m(0.21), pHi = sBodyTop - m(0.17);
        var pX0 = sx - sw - m(0.018), pX1 = sx - sw - m(0.004), pCol = [0.93, 0.91, 0.87];
        if (zb > za + pBand * 2 && pHi > pLo + pBand * 2) {
          box6(P.conc, pX0, pX1, pLo, pLo + pBand, za, zb, 0.94, pCol);
          box6(P.conc, pX0, pX1, pHi - pBand, pHi, za, zb, 0.94, pCol);
          var pn = Math.max(1, Math.round((zb - za) / m(0.56)));
          for (var pj = 0; pj <= pn; pj++) {
            var pz = lerp(za, zb, pj / pn);
            box6(P.conc, pX0, pX1, pLo, pHi, pz - pBand * 0.5, pz + pBand * 0.5, 0.94, pCol);
          }
          for (pj = 0; pj < pn; pj++) {
            if (rnd(4470 + si * 67 + pj, 3) < 0.16) continue;
            var bz = lerp(za, zb, (pj + 0.5) / pn);
            box6(P.conc, pX0 - m(0.006), pX1, (pLo + pHi) * 0.5 - m(0.062), (pLo + pHi) * 0.5 + m(0.062),
                 bz - m(0.048), bz + m(0.048), 0.94, pCol);
          }
        }
      }
      STATS.props += sideRuns.length;
    }
    STATS.props += runsHero.length;
    /* =====================================================================
       THE GENERIC EDGING BELOW IS SUPERSEDED, NOT MERELY STALE, AND IT MUST
       STAY OFF.  Everything above is the fixed SEYDIKENT frontage wall that
       REPLACED it, and the two build on the SAME survey line: gardenLine()
       returns 150/198 and zHero is 150/198, so re-enabling this loop would
       stand a second wall inside the first.  Three further reasons, each on
       its own sufficient:

         * IT WOULD SEAL THE THREE GATES.  The cuts below are throat, gaps,
           pits, skips, f.entrance and keepClear().  nz-street.js publishes
           `entrance: null` on both hero faces (the doors arrive in
           `entrances`, plural) and NZ.streetEntrance.keepClear is null, so
           NOTHING here cuts x = 608 / 668 / 728 -- the run would close all
           three residential gates the loop above deliberately opens.
         * IT WOULD OVERRUN THE FRONTAGE.  runs starts at [BOX.x0 + 0.5,
           BOX.x1 - 0.5] = 548.5..835.5, but the facade it takes `back` from
           only exists over fN.a..fN.b = 580..756.  The rest of that 287-unit
           run is the junction, the park approach and the 230 Sk block, none
           of which has an A/B garden behind it.
         * ITS FILL FLOATS.  The EARTH poly sits at Y_PAVE + EDGE_H * 0.72,
           i.e. 0.81 units (0.23 m) proud of the pavement, which was right
           when this was a raised bed behind a 0.32 m kerb.  The loop above
           lays a winter lawn AT grade with clipped shrubs on it, so the slab
           would hang over the lawn and bury the shrubs.

       Kept rather than deleted: the cut() run-splitter and the weed scatter
       are the only working examples of either in this file, and the day the
       street grows a frontage that is generic again they are what it needs.
       ================================================================== */
    return;
    var zE = gardenLine(f), sgn = f.inward;
    var back = f.plinthFace + sgn * 0.06;
    var y0 = Y_PAVE - 0.04, y1 = Y_PAVE + EDGE_H;
    var runs = [[BOX.x0 + 0.5, BOX.x1 - 0.5]], i, j;
    function cut(a, b) {
      var out = [];
      for (j = 0; j < runs.length; j++) {
        var r = runs[j];
        if (b <= r[0] || a >= r[1]) { out.push(r); continue; }
        if (a > r[0]) out.push([r[0], a]);
        if (b < r[1]) out.push([b, r[1]]);
      }
      runs = out;
    }
    /* THE THROAT.  There is no north pavement between x = 176 and x = 192 any
       more: GROUND repaints those cells ROAD at f = 0 so the side street can
       pour in over a dropped kerb, and anything of mine standing at pavement
       height in that gap is a wall in the middle of a road. */
    if (side === 'N') cut(THROAT.x0 - 1.0, THROAT.x1 + 1.0);
    for (i = 0; i < f.gaps.length; i++) cut(f.gaps[i].a - 1.6, f.gaps[i].b + 1.6);
    for (i = 0; i < pits.length; i++) cut(pits[i].x0 - 0.35, pits[i].x1 + 0.35);
    for (i = 0; i < skips.length; i++) cut(skips[i][0], skips[i][1]);
    if (f.entrance) cut(f.entrance.x - m(1.9), f.entrance.x + m(1.9));
    /* the gate ENTRANCE publishes.  Read it, never guess it -- that module is
       rebuilding its porch in parallel with this one. */
    var kcE = keepClear();
    if (kcE && isFinite(kcE.x0)) {
      var near = (side === 'N') ? (kcE.z0 < (RZ0 + RZ1) * 0.5) : (kcE.z1 > (RZ0 + RZ1) * 0.5);
      if (near) cut(kcE.x0 - 0.6, kcE.x1 + 0.6);
    }

    /* It is 0.32 m tall and not the 0.9 m of the photograph because it must
       stay under CLIMB = 1.15 above the pavement (rule E) -- a full-height
       wall on an unblocked cell is something the player walks through, and
       the map gives PROPS no blocked cells between the tree pits.  The full
       0.5 m version, with its coping and its railing panels, stands on the
       pits, where there is an S_BLOCK cell to carry it. */
    var WP = wallPile(P, side);
    var WC = wallCol(side);
    var COPE = 0.22;
    WP.tile(wallTile(side)).macro(side === 'N' ? 0.45 : 0.6);
    P.conc.tile(T_CONC).macro(1);
    for (i = 0; i < runs.length; i++) {
      var a = runs[i][0], b = runs[i][1];
      if (b - a < 2.0) continue;
      var za = Math.min(zE, zE - sgn * 0.85), zb = Math.max(zE, zE - sgn * 0.85);
      var wob = (rnd(i, 91) - 0.5) * 0.10;
      /* the painted / brick face, with the first 150 mm dirtier than the rest */
      WP.tile(wallTile(side));
      box6(WP, a, b, y0, y1 - COPE + wob, za + 0.04, zb - 0.04, 1.0, function (p) {
        var d = clamp((p[1] - Y_PAVE) / 0.52, 0, 1);
        var kk = 0.66 + 0.34 * d;
        return [WC[0] * kk, WC[1] * kk, WC[2] * kk];
      });
      /* a precast coping, chipped, overhanging both faces */
      box6(P.conc, a - 0.05, b + 0.05, y1 - COPE + wob, y1 + wob,
           za - 0.07, zb + 0.07, 1.0, CONCT);
      /* the fill behind it: bare earth, gravel and the odd weed */
      var ba = Math.min(back, za), bb = Math.max(back, za);
      if (bb - ba > 0.3)
        poly(P.conc, [[a, Y_PAVE + EDGE_H * 0.72, ba], [b, Y_PAVE + EDGE_H * 0.72, ba],
                      [b, Y_PAVE + EDGE_H * 0.80, bb], [a, Y_PAVE + EDGE_H * 0.80, bb]],
             (a + b) * 0.5, 0, (ba + bb) * 0.5, 1.0, EARTH);
      /* weeds in the strip and at the wall base -- vegetation in every crack */
      var n = Math.round((b - a) * 0.42 * DENSITY);
      for (j = 0; j < n; j++) {
        var wx = lerp(a + 0.3, b - 0.3, (j + rnd(i * 7, j)) / Math.max(1, n));
        var wz = lerp(ba + 0.15, bb - 0.15, rnd(i * 13, j + 5));
        var hgt = m(0.16 + rnd(i * 17, j) * 0.34);
        crossCard(P.leaf, wx, Y_PAVE + EDGE_H * 0.74, wz, hgt * 0.85, hgt,
                  rnd(i * 19, j) * PI, LEAF.rect[rnd(i, j * 3) < 0.62 ? L_WEED0 : L_WEED1],
                  WEEDC, 0.92);
      }
      STATS.props++;
    }
  }

  /* a run of plain steel verticals with a top and bottom rail: the default
     Turkish garden railing.  Painted white, dark green or the same oxide red,
     with the paint gone from the top rail and rust at every weld. */
  function railRun(P, x0, x1, z0, z1, yBase, colr, seed) {
    var dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.6) return;
    var ux = dx / len, uz = dz / len, i;
    var nBar = Math.max(2, Math.round(len / m(0.115)));
    var yTop = yBase + RAIL_H;
    /* the top rail has lost its paint and gone to rust: warm, dark, and much
       redder than whatever the pickets were painted */
    var bare = [colr[0] * 0.34 + 0.185, colr[1] * 0.30 + 0.098, colr[2] * 0.28 + 0.062];
    P.steel.tile(T_STEEL).macro(0.4);
    for (i = 0; i <= nBar; i++) {
      var t = i / nBar, bx = x0 + dx * t, bz = z0 + dz * t;
      var w = m(0.011);
      box6(P.steel, bx - w, bx + w, yBase - 0.05, yTop - m(0.02), bz - w, bz + w, 0.96, colr);
    }
    /* rails: the top one has lost its paint, which is where the rust starts */
    var rw = m(0.016);
    tube(P.steel, x0 - ux * 0.05, yTop - m(0.05), z0 - uz * 0.05,
         x1 + ux * 0.05, yTop - m(0.05), z1 + uz * 0.05, rw * 1.5, 4, 1.0, true, bare);
    tube(P.steel, x0, yBase + m(0.13), z0, x1, yBase + m(0.13), z1, rw, 4, 0.94, true, colr);
    /* the standards, thicker, at the ends and every metre */
    var nSt = Math.max(2, Math.round(len / m(1.0)));
    for (i = 0; i <= nSt; i++) {
      var st = i / nSt, sx = x0 + dx * st, sz = z0 + dz * st, sw = m(0.019);
      box6(P.steel, sx - sw, sx + sw, yBase - 0.12, yTop + m(0.03), sz - sw, sz + sw, 0.94, colr);
      /* rust bleeding out of the base plate and down the wall */
      if (rnd(seed, i) < 0.55) {
        box6(P.steel, sx - sw * 1.9, sx + sw * 1.9, yBase - 0.16, yBase - 0.02,
             sz - sw * 1.9, sz + sw * 1.9, 0.80, [colr[0] * 0.75 + 0.06, colr[1] * 0.52 + 0.03, colr[2] * 0.40 + 0.02]);
      }
    }
    STATS.props++;
  }

  /* white precast balusters -- ref1, left of the porch stair */
  function balusterRun(P, x0, x1, z0, z1, yBase, seed) {
    var dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.6) return;
    var n = Math.max(2, Math.round(len / m(0.22))), i;
    var col = [1.02, 1.01, 0.99];
    P.conc.tile(T_CONC).macro(0.5);
    var yTop = yBase + RAIL_H;
    for (i = 0; i <= n; i++) {
      var t = (i + 0.5) / (n + 1), bx = x0 + dx * t, bz = z0 + dz * t;
      var R1 = m(0.048), R2 = m(0.026), R3 = m(0.036);
      var hs = [0, 0.12, 0.30, 0.52, 0.74, 0.88, 1.0];
      var rs = [R1, R3, R2, R2 * 1.16, R3 * 1.10, R3, R1 * 0.92];
      for (var k = 0; k < hs.length - 1; k++) {
        tube(P.conc, bx, yBase + RAIL_H * hs[k], bz, bx, yBase + RAIL_H * hs[k + 1], bz,
             rs[k], 6, 0.95, false, col, rs[k + 1]);
      }
      void seed;
    }
    /* the coping the balusters carry */
    var cw = m(0.075);
    var nx2 = -dz / len * cw, nz2 = dx / len * cw;
    poly(P.conc, [[x0 + nx2, yTop, z0 + nz2], [x1 + nx2, yTop, z1 + nz2],
                  [x1 - nx2, yTop, z1 - nz2], [x0 - nx2, yTop, z0 - nz2]],
         (x0 + x1) * 0.5, yTop - 2, (z0 + z1) * 0.5, 1.0, upTone(col));
    poly(P.conc, [[x0 + nx2, yTop - m(0.06), z0 + nz2], [x1 + nx2, yTop - m(0.06), z1 + nz2],
                  [x1 + nx2, yTop, z1 + nz2], [x0 + nx2, yTop, z0 + nz2]],
         (x0 + x1) * 0.5, yTop - 2, (z0 + z1) * 0.5, 0.92, col);
    STATS.props++;
  }

  var RAILCOL = [
    [0.905, 0.900, 0.880],                /* white, mostly gone             */
    [0.062, 0.115, 0.082],                /* dark green                     */
    [0.163, 0.052, 0.039]                 /* the same oxide red as the wall */
  ];
  /* the dark, almost-black steel of B-BLOK's railing panels.  In ref2 it is
     a very dark brown-red under fifteen years of weathering, not black. */
  var ORNC = [0.052, 0.040, 0.036];

  /* ORNATE RAILING PANELS on a brick garden wall (_ref/ref2, _ref/ref7).
     Frame + posts modelled in steel, the scrollwork carried by one cutout
     card per bay so a 5.4 m run costs 1 card and 6 tubes rather than sixty
     balusters.  Rule C: it stands on the pit's own blocked cell, inside the
     same envelope legalC() checks the wall against. */
  function panelRailRun(P, segs, zLine, yBase, sgn, seed) {
    var i, k;
    var yTop = yBase + RAIL_H;
    P.steel.tile(T_STEEL).macro(0.35);
    for (i = 0; i < segs.length; i++) {
      var a = segs[i][0], b = segs[i][1], L = b - a;
      if (L < 0.8) continue;
      var nP = Math.max(1, Math.round(L / RAILP.w));
      /* the bottom and top rails, and a post at every panel joint */
      tube(P.steel, a, yBase + m(0.06), zLine, b, yBase + m(0.06), zLine, m(0.018), 4, 0.94, true, ORNC);
      tube(P.steel, a, yTop - m(0.05), zLine, b, yTop - m(0.05), zLine, m(0.022), 4, 1.0, true, ORNC);
      for (k = 0; k <= nP; k++) {
        var pxp = lerp(a, b, k / nP), pw = m(0.026);
        box6(P.steel, pxp - pw, pxp + pw, yBase - 0.10, yTop + m(0.05),
             zLine - pw, zLine + pw, 0.92, ORNC);
      }
      /* the scrolled infill, one card per bay, read from the street side */
      P.panel.macro(0.15);
      for (k = 0; k < nP; k++) {
        var cxp = lerp(a, b, (k + 0.5) / nP);
        var hw2 = (L / nP) * 0.5 - m(0.03);
        var cyp = (yBase + yTop) * 0.5 - m(0.02);
        var hh2 = (yTop - yBase) * 0.5 - m(0.05);
        card(P.panel, cxp, cyp, zLine + sgn * 0.012, hw2, 0, 0, 0, hh2, 0,
             PANEL.rect[P_RAILP], [0.92, 0.90, 0.88], 0.96 - rnd(seed, k) * 0.10,
             [0, 0, sgn]);
        card(P.panel, cxp, cyp, zLine - sgn * 0.012, hw2, 0, 0, 0, hh2, 0,
             PANEL.rect[P_RAILP], [0.66, 0.64, 0.62], 0.80, [0, 0, -sgn]);
      }
      STATS.props++;
    }
  }

  /* one garden enclosure on one tree pit: a U of flaking maroon wall, a
     railing or a run of balusters on top, and the life behind it. */
  function buildEnclosure(P, pit, idx, opts) {
    var A = pitAxis(pit), sgn = A.sgn, f = faceOf(A.north ? 'N' : 'S');
    var zOut = A.zFront + sgn * (HUG - 0.12);
    var zIn = zOut - sgn * m(0.23);
    var zBack = f ? (f.plinthFace + sgn * 0.10) : (A.zBack + sgn * 0.4);
    /* legalC allows a bay plus HUG of overhang, so the wall and its railing
       run 0.80 units past the pit at each end -- 5.4 units instead of 3.8, a
       58 % longer run of the one texture the brief calls out by name */
    var x0 = pit.x0 - (HUG - 0.18), x1 = pit.x1 + (HUG - 0.18);
    var yTop = Y_PAVE + WALL_H, yCope = yTop + COPE_H;
    var za = Math.min(zOut, zIn), zb = Math.max(zOut, zIn);
    var i, j;

    /* NORTH is B-BLOK's tan brick (ref7/ref2), SOUTH is A-BLOK's flaking
       maroon (ref6/ref1).  One pile each; the tone below is the ground-line
       soiling only, because both colours live in their own map. */
    var side = A.north ? 'N' : 'S';
    var WPE = wallPile(P, side), WTE = wallTile(side), WCE = wallCol(side);
    WPE.tile(WTE).macro(side === 'N' ? 0.45 : 0.6);
    /* ground-line soiling: the first 300 mm of every wall is dirtier */
    function wtone(p) {
      var d = clamp((p[1] - Y_PAVE) / m(0.30), 0, 1);
      var k = 0.70 + 0.30 * d;
      return [WCE[0] * k, WCE[1] * k, WCE[2] * k];
    }
    var gateA = 0, gateB = 0;
    if (opts.gate) { gateA = lerp(x0, x1, 0.34); gateB = lerp(x0, x1, 0.72); }

    /* the front wall, broken for the gate and for anything standing through
       it -- a lamp column or a utility pole always predates the wall */
    var segs = opts.gate ? [[x0, gateA], [gateB, x1]] : [[x0, x1]];
    if (opts.cuts) {
      for (i = 0; i < opts.cuts.length; i++) {
        var ca = opts.cuts[i][0], cb = opts.cuts[i][1], nsg = [];
        for (j = 0; j < segs.length; j++) {
          var sg3 = segs[j];
          if (cb <= sg3[0] || ca >= sg3[1]) { nsg.push(sg3); continue; }
          if (ca > sg3[0]) nsg.push([sg3[0], ca]);
          if (cb < sg3[1]) nsg.push([cb, sg3[1]]);
        }
        segs = nsg;
      }
    }
    for (i = 0; i < segs.length; i++) {
      if (segs[i][1] - segs[i][0] < 0.25) continue;
      box6(WPE, segs[i][0], segs[i][1], Y_PAVE - 0.06, yTop, za, zb, 1.0, wtone);
      P.conc.tile(T_CONC).macro(0.5);
      box6(P.conc, segs[i][0] - 0.10, segs[i][1] + 0.10, yTop, yCope, za - 0.10, zb + 0.10, 1.0, CONCT);
      WPE.tile(WTE);
    }
    /* the returns to the facade */
    for (i = 0; i < 2; i++) {
      var sx = i ? x1 - m(0.23) : x0, sx2 = i ? x1 : x0 + m(0.23);
      var rz0 = Math.min(zBack, zb), rz1 = Math.max(zBack, zb);
      box6(WPE, sx, sx2, Y_PAVE - 0.06, yTop, rz0, rz1, 1.0, wtone);
      P.conc.tile(T_CONC);
      box6(P.conc, sx - 0.10, sx2 + 0.10, yTop, yCope, rz0, rz1 + 0.02, 1.0, CONCT);
      WPE.tile(WTE);
    }
    /* the fill: bare earth held 300 mm above the pavement */
    P.conc.tile(T_CONC).macro(1);
    var fz0 = Math.min(zIn, zBack), fz1 = Math.max(zIn, zBack);
    poly(P.conc, [[x0 + m(0.2), Y_PAVE + m(0.30), fz0], [x1 - m(0.2), Y_PAVE + m(0.30), fz0],
                  [x1 - m(0.2), Y_PAVE + m(0.32), fz1], [x0 + m(0.2), Y_PAVE + m(0.32), fz1]],
         (x0 + x1) * 0.5, 0, (fz0 + fz1) * 0.5, 1.0, EARTH);

    /* railing, balusters, or -- on B-BLOK's brick wall -- the ORNATE STEEL
       INFILL PANELS of _ref/ref2 and _ref/ref7.  A panel is one alpha-cutout
       card in a welded frame instead of forty modelled balusters: 6 tris
       against 900, and it is the only way to get scrolled bar-work at all
       inside this module's draw and triangle budget. */
    var rc = RAILCOL[opts.rail % RAILCOL.length];
    if (opts.panels) {
      panelRailRun(P, segs, zOut - sgn * m(0.11), yCope, sgn, idx * 53 + 7);
    } else if (opts.balusters) {
      balusterRun(P, x0 + 0.1, x1 - 0.1, zOut - sgn * m(0.11), zOut - sgn * m(0.11), yCope, idx * 31 + 5);
    } else {
      for (i = 0; i < segs.length; i++) {
        if (segs[i][1] - segs[i][0] < 0.4) continue;
        railRun(P, segs[i][0], segs[i][1], zOut - sgn * m(0.11), zOut - sgn * m(0.11), yCope, rc, idx * 37 + i);
      }
      railRun(P, x0 + m(0.11), x0 + m(0.11), zOut - sgn * m(0.11), zBack, yCope, rc, idx * 41);
      railRun(P, x1 - m(0.11), x1 - m(0.11), zOut - sgn * m(0.11), zBack, yCope, rc, idx * 43);
    }
    /* the gate, hanging open, because it always is */
    if (opts.gate) {
      var gw = gateB - gateA, sw = m(0.026);
      P.steel.tile(T_STEEL).macro(0.4);
      for (i = 0; i < 2; i++) {
        var px = i ? gateB : gateA;
        box6(P.steel, px - sw, px + sw, Y_PAVE - 0.10, yCope + RAIL_H * 0.94,
             zOut - sgn * m(0.11) - sw, zOut - sgn * m(0.11) + sw, 0.94, rc);
      }
      /* the leaf, swung 55 degrees into the garden */
      var ang = sgn > 0 ? -0.96 : 0.96;
      var hx = gateA + Math.cos(ang) * gw * 0.92;
      var hz = (zOut - sgn * m(0.11)) + Math.sin(ang) * gw * 0.92 * sgn;
      var gy0 = Y_PAVE + m(0.10), gy1 = gy0 + m(1.05);
      var nBar = Math.max(3, Math.round(gw / m(0.12)));
      for (i = 0; i <= nBar; i++) {
        var t = i / nBar;
        var bx2 = lerp(gateA, hx, t), bz2 = lerp(zOut - sgn * m(0.11), hz, t);
        box6(P.steel, bx2 - m(0.009), bx2 + m(0.009), gy0, gy1,
             bz2 - m(0.009), bz2 + m(0.009), 0.95, rc);
      }
      for (i = 0; i < 2; i++) {
        var ry = i ? gy1 - m(0.04) : gy0 + m(0.05);
        tube(P.steel, gateA, ry, zOut - sgn * m(0.11), hx, ry, hz, m(0.014), 4, 0.96, true, rc);
      }
      STATS.props++;
    }

    /* --- what lives in the garden ---------------------------------------- */
    var cx = (x0 + x1) * 0.5, gy = Y_PAVE + m(0.31);
    var R = Rng(SEED + idx * 7717);
    /* weeds and grass everywhere */
    var nw = Math.round(11 * DENSITY);
    for (i = 0; i < nw; i++) {
      var wx = lerp(x0 + 0.4, x1 - 0.4, R()), wz = lerp(fz0 + 0.25, fz1 - 0.25, R());
      var hh = m(0.14 + R() * 0.34);
      crossCard(P.leaf, wx, gy, wz, hh * 0.8, hh, R() * PI,
                LEAF.rect[R() < 0.55 ? L_WEED0 : (R() < 0.6 ? L_WEED1 : L_DRY)], WEEDC, 0.90);
    }
    /* a rose cut back for winter */
    if (opts.rose) {
      var rx = lerp(x0, x1, 0.30), rz2 = lerp(fz0, fz1, 0.5);
      for (i = 0; i < 5; i++)
        crossCard(P.leaf, rx + (R() - 0.5) * m(0.28), gy, rz2 + (R() - 0.5) * m(0.24),
                  m(0.30), m(0.44 + R() * 0.24), R() * PI, LEAF.rect[L_ROSE],
                  [0.60, 0.56, 0.50], 0.95);
    }
    /* stacked firewood against the return wall */
    if (opts.wood) {
      P.bark.tile(T_BARK).macro(0.4).tint([BARKC[0] * 1.5, BARKC[1] * 1.4, BARKC[2] * 1.25]);
      var lz = lerp(fz0, fz1, 0.30), lx = x0 + m(0.30);
      for (i = 0; i < 4; i++) for (j = 0; j < 4 - (i > 2 ? 1 : 0); j++) {
        if (R() < 0.10) continue;
        var ly = gy + m(0.055) + i * m(0.105);
        var lz2 = lz + j * m(0.11) + (R() - 0.5) * m(0.015);
        var ll = m(0.30 + R() * 0.10);
        tube(P.bark, lx, ly, lz2, lx + ll, ly + (R() - 0.5) * 0.05, lz2, m(0.048 + R() * 0.014),
             6, 0.88, true, null, m(0.044 + R() * 0.014));
      }
      STATS.props++;
    }
    /* a monobloc plastic chair, left out all winter */
    if (opts.chair) {
      var chx = lerp(x0, x1, 0.72), chz = lerp(fz0, fz1, 0.55), chy = gy;
      var pc = [0.800, 0.788, 0.744], sw2 = m(0.21), st = m(0.42);
      P.trim.tile(T_TRIM).macro(0.4);
      for (i = 0; i < 4; i++) {
        var lx2 = chx + ((i & 1) ? 1 : -1) * sw2 * 0.82, lz3 = chz + ((i & 2) ? 1 : -1) * sw2 * 0.82;
        tube(P.trim, lx2, chy, lz3, lx2 * 0.98 + chx * 0.02, chy + st, lz3 * 0.98 + chz * 0.02,
             m(0.018), 5, 0.9, false, pc);
      }
      box6(P.trim, chx - sw2, chx + sw2, chy + st, chy + st + m(0.035), chz - sw2, chz + sw2, 0.98, pc);
      var bz = chz + sgn * sw2 * 0.9;
      box6(P.trim, chx - sw2 * 0.94, chx + sw2 * 0.94, chy + st, chy + st + m(0.46),
           bz - m(0.02), bz + m(0.02), 0.96, pc);
      STATS.props++;
    }
    /* a hose, coiled and forgotten */
    if (opts.hose) {
      var hx2 = lerp(x0, x1, 0.20), hz2 = lerp(fz0, fz1, 0.72), hr = m(0.22);
      P.trim.tile(T_TRIM).macro(0.2);
      var hc = [0.052, 0.098, 0.062];
      for (i = 0; i < 22; i++) {
        var a0 = i / 22 * TAU * 2.4, a1 = (i + 1) / 22 * TAU * 2.4;
        var rr0 = hr * (1 - i / 60), rr1 = hr * (1 - (i + 1) / 60);
        tube(P.trim, hx2 + Math.cos(a0) * rr0, gy + m(0.022) + (i > 11 ? m(0.032) : 0), hz2 + Math.sin(a0) * rr0,
             hx2 + Math.cos(a1) * rr1, gy + m(0.022) + (i > 11 ? m(0.032) : 0), hz2 + Math.sin(a1) * rr1,
             m(0.014), 4, 0.86, false, hc);
      }
      STATS.props++;
    }
    /* ivy, or a grape vine, over the wall */
    if (opts.ivy) {
      var nIvy = Math.round(26 * DENSITY);
      for (i = 0; i < nIvy; i++) {
        var ix = lerp(x0, x1, R()), iy = Y_PAVE + m(0.06) + R() * (WALL_H * 1.5);
        var iz = zOut + sgn * 0.04;
        var isz = m(0.14 + R() * 0.16);
        card(P.leaf, ix, iy, iz, isz, 0, 0, 0, isz * 0.9, 0,
             LEAF.rect[R() < 0.75 ? L_IVY : L_VINE], [0.80, 0.86, 0.74], 0.9 + R() * 0.2,
             [0, 0, sgn]);
      }
      STATS.props++;
    }
    /* an old kilim thrown over the railing to air, and a wheelie bin in the
       gateway.  Human traces are ranked seventh in the brief's grime pass and
       they are the cheapest believability on the street. */
    if (opts.carpet) {
      var kw = Math.min(m(0.85), (x1 - x0) * 0.42), ky = yCope + RAIL_H;
      var kx = lerp(x0, x1, 0.62), kz = zOut - sgn * m(0.11);
      P.panel.macro(0.3);
      card(P.panel, kx, ky - m(0.30), kz + sgn * m(0.035), kw * 0.5, 0, 0, 0, m(0.30), 0,
           PANEL.rect[P_KILIM], [0.44, 0.42, 0.41], 1.0, [0, 0, sgn]);
      card(P.panel, kx, ky - m(0.26), kz - sgn * m(0.035), kw * 0.5, 0, 0, 0, m(0.26), 0,
           PANEL.rect[P_KILIM], [0.36, 0.35, 0.34], 0.86, [0, 0, -sgn]);
      card(P.panel, kx, ky + m(0.02), kz, kw * 0.5, 0, 0, 0, 0, sgn * m(0.036),
           PANEL.rect[P_KILIM], [0.50, 0.48, 0.47], 1.0, [0, 1, 0]);
      STATS.props++;
    }
    if (opts.bin) {
      var bx3 = opts.gate ? lerp(gateA, gateB, 0.5) : lerp(x0, x1, 0.5);
      var bz3 = zOut - sgn * m(0.32), by = Y_PAVE;
      var bcol = [0.048, 0.100, 0.068];
      P.trim.tile(T_TRIM).macro(0.3);
      boxC(P.trim, bx3, by + m(0.46), bz3, m(0.28), m(0.46), m(0.25), 0.06, 0.95, bcol);
      boxC(P.trim, bx3, by + m(0.95), bz3 + sgn * m(0.04), m(0.29), m(0.035), m(0.26), 0.05, 1.0,
           [bcol[0] * 1.2, bcol[1] * 1.2, bcol[2] * 1.2]);
      for (i = 0; i < 2; i++) {
        var wx2 = bx3 + (i ? 1 : -1) * m(0.22);
        tube(P.trim, wx2, by + m(0.055), bz3 - sgn * m(0.20), wx2, by + m(0.055), bz3 - sgn * m(0.14),
             m(0.055), 6, 0.85, true, [0.075, 0.074, 0.072]);
      }
      STATS.props++;
    }
    STATS.props++;
  }

  /* =======================================================================
     SECTION 13 -- street furniture and services.

     The lamps are SWITCHED OFF and this module adds NO lights: r149 has no
     per-object light masking, so anything added here would also light the
     night half of the level (NUKEM.html:2836 says the same thing from the
     other side).  A cobra head under an overcast sky is a grey plastic bowl,
     and that is all it is modelled as.
     ==================================================================== */
  var GALV = [0.610, 0.622, 0.615];
  var LUM = [0.650, 0.656, 0.650];
  /* A SIGN POST IS NOT A LAMP COLUMN.  A 60 mm galvanised sign tube is a
     small, mostly-vertical cylinder that sees very little sky and a lot of
     road, and at GALV it came back at the same value as the render behind it
     -- three chalk-white sticks across the island in _shots/prz/island2.
     _ref/ref8 measures them at about 60 % of the wall they stand against. */
  var POSTC = [0.295, 0.305, 0.308];

  /* a cobra-head column.  Rule C: the base stands on a tree pit, pushed to
     the pavement edge of the cell and kept clear of the cikma face -- there
     is no other legal spot for a free-standing 9 m mast on a 2.29 m pavement
     with a 1.2 m overhang above it. */
  function buildLamp(P, pit, seed, hM, signTile) {
    var A = pitAxis(pit), sgn = A.sgn, f = faceOf(A.north ? 'N' : 'S');
    var mr = m(0.068);                  /* 136 mm shaft: a real 9 m column   */
    var zLim = A.zFront + sgn * (HUG - mr - 0.045);
    var zMin = (f ? f.bayFace : A.zFront) + sgn * (mr + 0.07);
    var pz = zLim;
    if (sgn * (zLim - zMin) >= 0) pz = (zLim + zMin) * 0.5;
    else {
      warn('no legal column position on the pit at x ' + pit.x0 + ': the cikma reaches ' +
           (f ? f.bayFace.toFixed(2) : '?') + ' and the cell edge is ' + A.zFront);
      return null;
    }
    var px = pit.x0 + 1.15 + rr(seed, 3, 0, 0.4);
    var y0 = Y_PAVE, top = y0 + m(hM);
    var i;
    P.steel.tile(T_STEEL).macro(0.25);
    /* the base: a cast collar and four exposed holding-down bolts */
    tube(P.steel, px, y0 - 0.10, pz, px, y0 + m(0.30), pz, mr * 1.75, 8, 0.90, true, GALV, mr * 1.30);
    var segs2 = 4;
    for (i = 0; i < segs2; i++) {
      var a = y0 + m(0.30) + (top - y0 - m(0.30)) * (i / segs2);
      var b = y0 + m(0.30) + (top - y0 - m(0.30)) * ((i + 1) / segs2);
      tube(P.steel, px, a, pz, px, b, pz, mr * (1 - i * 0.09), 8, 0.94, false, GALV, mr * (1 - (i + 1) * 0.09));
    }
    /* the access door in the shaft, and its rust weep */
    box6(P.steel, px - mr * 0.55, px + mr * 0.55, y0 + m(0.55), y0 + m(1.05),
         pz + sgn * mr * 0.72, pz + sgn * mr * 0.98, 0.88, [GALV[0] * 0.85, GALV[1] * 0.80, GALV[2] * 0.76]);
    /* the single curved arm.  1.55 m of reach puts the luminaire over the
       kerb line, which is where every one of these is. */
    var reach = m(1.55), drop = m(0.42), N = 7;
    var prev = null;
    for (i = 0; i <= N; i++) {
      var t = i / N;
      var ax2 = px, ay = top - drop * t * t * 0.55 + Math.sin(t * PI) * m(0.16);
      var az = pz + sgn * reach * t;
      if (prev) tube(P.steel, prev[0], prev[1], prev[2], ax2, ay, az,
                     mr * (0.72 - t * 0.16), 6, 0.96, false, GALV, mr * (0.70 - t * 0.16));
      prev = [ax2, ay, az];
    }
    /* the cobra head: a tapered grey bowl with a flat lens under it */
    var hx = prev[0], hy = prev[1], hz = prev[2];
    var lz = hz + sgn * m(0.34);
    tube(P.steel, hx, hy - m(0.04), hz, hx, hy - m(0.10), lz, m(0.115), 8, 1.0, true, LUM, m(0.165));
    box6(P.steel, hx - m(0.14), hx + m(0.14), hy - m(0.20), hy - m(0.11),
         Math.min(hz, lz) - 0.02, Math.max(hz, lz) + 0.02, 0.72, [0.150, 0.155, 0.158]);
    /* the no-parking plate, bolted to the column facing along the street --
       which keeps a 600 mm disc inside the cell's legal envelope */
    if (signTile !== undefined && signTile !== null) {
      var sy = y0 + m(2.25), sr2 = m(0.30);
      P.steel.tile(T_STEEL);
      box6(P.steel, px - m(0.012), px + m(0.012), sy - sr2 * 1.05, sy + sr2 * 1.05,
           pz - m(0.012), pz + m(0.012), 0.94, GALV);
      P.panel.macro(0);
      card(P.panel, px, sy, pz + 0.035, sr2, 0, 0, 0, sr2, 0,
           PANEL.rect[signTile], [0.86, 0.86, 0.86], 1.0, [0, 0, 1]);
      card(P.panel, px, sy, pz - 0.035, -sr2, 0, 0, 0, sr2, 0,
           PANEL.rect[signTile], [0.62, 0.62, 0.62], 0.9, [0, 0, -1]);
    }
    STATS.props++;
    return { x: px, y: top, z: pz, cut: [px - m(0.30), px + m(0.30)] };
  }

  /* a concrete utility pole with its junction cabinet -- the other thing the
     wires hang from.  Rule C, same as the lamps. */
  function buildPole(P, pit, seed, hM) {
    var A = pitAxis(pit), sgn = A.sgn, f = faceOf(A.north ? 'N' : 'S');
    var pr = m(0.072);
    var pz = A.zFront + sgn * (HUG - pr * 1.35 - 0.045);
    var zMin = (f ? f.bayFace : A.zFront) + sgn * (pr * 1.35 + 0.07);
    if (sgn * (pz - zMin) >= 0) pz = (pz + zMin) * 0.5;
    else return null;
    var px = pit.x1 - 1.15 - rr(seed, 7, 0, 0.4);
    var y0 = Y_PAVE, top = y0 + m(hM), i;
    P.conc.tile(T_CONC).macro(0.4);
    /* a real Turkish pole is an octagonal spun-concrete section */
    tube(P.conc, px, y0 - 0.15, pz, px, top, pz, pr * 1.35, 8, 0.94, true, CONCC, pr * 0.72);
    P.steel.tile(T_STEEL).macro(0.3);
    /* the junction cabinet, strapped on at chest height */
    boxC(P.steel, px, y0 + m(1.35), pz + sgn * m(0.20), m(0.19), m(0.30), m(0.11), 0.04, 0.94,
         [0.430, 0.440, 0.432]);
    P.panel.macro(0);
    card(P.panel, px, y0 + m(1.42), pz + sgn * m(0.315), m(0.10), 0, 0, 0, m(0.10), 0,
         PANEL.rect[P_HAZARD], [0.90, 0.90, 0.88], 1.0, [0, 0, sgn]);
    /* two crossarms with their insulators */
    for (i = 0; i < 2; i++) {
      var cy2 = top - m(0.35) - i * m(0.75), aw = m(0.62 - i * 0.14);
      tube(P.steel, px - aw, cy2, pz, px + aw, cy2, pz, m(0.026), 5, 0.96, true, GALV);
      for (var k = 0; k < 3; k++) {
        var ix2 = px + (k - 1) * aw * 0.82;
        tube(P.steel, ix2, cy2, pz, ix2, cy2 + m(0.13), pz, m(0.030), 6, 1.0, true, [0.180, 0.140, 0.100]);
      }
    }
    STATS.props++;
    return { x: px, y: top - m(0.35), z: pz, cut: [px - m(0.32), px + m(0.32)] };
  }

  /* ---- overhead wires ----------------------------------------------------
     Rule B: every span is above y = 33, five times the jump apex.

     THE PREVIOUS PASS.  Thirty-nine strands radiating out of eight hardcoded
     anchor points, drawn as 4-segment TUBES.  A 4-segment tube has one facet
     pointing straight up and one straight down, so the up facet took the
     bake's full 2.00 up-facing term and the down facet took none of it: the
     cable alternated black and white along its length and read as a string of
     beads.  Two of the anchors sat in facade gaps (x = 176.5 is inside the
     alley mouth) so their spans ran through the buildings, and six diagonals
     across a 9 m street is a starburst, not a street.

     ref5-open-junction.png has about EIGHT cables, near-parallel, running the
     length of the street between poles and facade brackets, with one or two
     crossing.  So:

       * every anchor is derived from a REAL facade run -- inside [bayA,bayB],
         clear of every gap the facade published, and clear of the entrance --
         or from a real pole head, so no span can enter a building;
       * three cables per side, continuous end to end, plus two crossings and
         one service drop per column: ten catenaries, not thirty-nine;
       * a true catenary (cosh), not a parabola;
       * and a strand is a 4-facet extrusion whose vertices ALL carry the same
         normal and the same tone, so there is nothing left that can vary along
         the run.  22 mm cable: 0.4 px at the dead end, 3 px at the near
         bracket, and it holds one value at both. */
  var WIRE_R = m(0.011);                  /* 22 mm cable                     */
  var WIRE_Y = m(9.55);                   /* 9.55 m: below the 4th-floor sill */
  var WCOL = [0.043, 0.042, 0.041];       /* weathered ACSR, near black       */

  /* the cross-section, as (sideways, up) pairs.  s is chosen so that
     s x up = along, which is what makes the winding below face outward. */
  var WRING = [[0, 1], [1, 0], [0, -1], [-1, 0]];

  function wireStrand(P, A, B, sag, r, tone) {
    var n = TIER === 'low' ? 9 : 13, i, j;
    var dx = B[0] - A[0], dz = B[2] - A[2];
    var hl = Math.sqrt(dx * dx + dz * dz);
    if (!(hl > 1e-4)) return;
    var sx = dz / hl, sz = -dx / hl;
    /* one fixed normal for the whole strand, tipped 45 deg off vertical so it
       is neither a full up-facing surface nor a full down-facing one.

       MISSION 4 TIPS IT DOWN INSTEAD.  Under the overcast there is no key and
       the dome is uniform, so which way the normal leans changes nothing and
       leaning it up is the safe choice.  Under a sun it is the whole story: a
       player looks UP at a cable, so a normal tipped UP puts every visible
       pixel at ~90 deg of incidence, Fresnel goes to 1 and the environment
       term hands the cable the entire dome (measured: rgb 207,217,228 on a
       114,154,200 sky, from an albedo of 0.0099).  Tipped DOWN it is the
       honest thing -- what you see from the pavement is the cable's shaded
       underside -- N.V is healthy, F falls back to 0.04, and the run reads as
       the dark line it is.  The sun still catches the top of the section and
       the material's own roughness, not the normal, is what keeps that from
       becoming a needle. */
    var nx = sx * 0.71, ny = 0.71, nz = sz * 0.71;
    if (L4) { ny = -0.55; nx = sx * 0.835; nz = sz * 0.835; }
    var C = 1.62, ch = Math.cosh ? Math.cosh(C) : (Math.exp(C) + Math.exp(-C)) * 0.5;
    function cosh(v) { return Math.cosh ? Math.cosh(v) : (Math.exp(v) + Math.exp(-v)) * 0.5; }
    /* mission 4 keeps the cable in its own pile so it can have its own
       roughness and its own share of the probe; mission 1 is untouched. */
    var pile = (L4 && P.wire) ? P.wire : P.trim, prev = null, cur, k;
    pile.tile(T_TRIM);
    for (i = 0; i <= n; i++) {
      var t = i / n;
      var px = lerp(A[0], B[0], t), pz = lerp(A[2], B[2], t);
      /* the true catenary between two level-ish supports, normalised so the
         mid-span drop is exactly `sag`.  A parabola is close, but the cosh is
         flatter at the bottom and steeper at the terminations, which is the
         whole shape of the thing. */
      var py = lerp(A[1], B[1], t) - sag * (ch - cosh(C * (2 * t - 1))) / (ch - 1);
      cur = [];
      for (j = 0; j < 4; j++)
        cur.push(pile.vert(px + sx * WRING[j][0] * r, py + WRING[j][1] * r,
                           pz + sz * WRING[j][0] * r, nx, ny, nz,
                           t * 24, j * 0.25, tone[0], tone[1], tone[2]));
      if (prev) for (j = 0; j < 4; j++) {
        k = (j + 1) & 3;
        pile.tri(prev[j], cur[k], prev[k]);
        pile.tri(prev[j], cur[j], cur[k]);
      }
      prev = cur;
    }
    STATS.wires++;
  }

  /* a bundle of `count` cables between the same two supports, spread on the
     support's own cross-axis so they stay parallel however the span is aimed
     -- the old version offset them on world X, which fans a diagonal span. */
  function wireBundle(P, A, B, sag, count, gap) {
    var dx = B[0] - A[0], dz = B[2] - A[2];
    var hl = Math.sqrt(dx * dx + dz * dz) || 1;
    var sx = dz / hl, sz = -dx / hl, k;
    for (k = 0; k < count; k++) {
      var o = (k - (count - 1) * 0.5) * gap;
      wireStrand(P, [A[0] + sx * o, A[1] - Math.abs(o) * 0.30, A[2] + sz * o],
                 [B[0] + sx * o, B[1] - Math.abs(o) * 0.30, B[2] + sz * o],
                 sag * (1 + k * 0.055), WIRE_R * (k === 1 ? 1.18 : 1), WCOL);
    }
  }

  /* the little bracket a bundle is clipped to on a facade */
  function wireBracket(P, x, y, z, nx, nz) {
    P.steel.tile(T_STEEL).macro(0.2);
    /* a 0.55 m stand-off, so the bundle runs clear of the render instead of
       being glued to it -- at 0.30 m the whole run read as a line drawn ON the
       facade rather than as cable in the air */
    var ex = x + nx * m(0.55), ez = z + nz * m(0.55);
    tube(P.steel, x, y, z, ex, y + m(0.05), ez, m(0.022), 5, 0.94, true, GALV);
    /* the porcelain insulator the cable is actually tied to */
    tube(P.steel, ex, y - m(0.09), ez, ex, y + m(0.13), ez, m(0.030), 6, 1.0, true,
         [0.115, 0.088, 0.062]);
    STATS.props++;
    return [ex, y + m(0.06), ez];
  }

  /* every stretch of a facade that really exists at wire height: inside the
     cikma run, outside every published gap, and off the entrance.  A bracket
     anywhere else is bolted to thin air and its span crosses a building. */
  function cutRuns(runs, a, b) {
    var nr = [], j;
    for (j = 0; j < runs.length; j++) {
      var r = runs[j];
      if (b <= r[0] || a >= r[1]) { nr.push(r); continue; }
      if (a > r[0]) nr.push([r[0], a]);
      if (b < r[1]) nr.push([b, r[1]]);
    }
    return nr;
  }
  function wireRuns(side) {
    var out = [], i, k, f;
    for (i = 0; i < FACES.length; i++) {
      f = FACES[i];
      if (f.side !== side || f.axis !== 'z') continue;
      var runs = [[Math.max(f.bayA, BOX.x0) + 1.2, Math.min(f.bayB, BOX.x1) - 1.2]];
      for (k = 0; k < f.gaps.length; k++)
        runs = cutRuns(runs, f.gaps[k].a - 2.0, f.gaps[k].b + 2.0);
      if (f.entrance) runs = cutRuns(runs, f.entrance.x - m(1.6), f.entrance.x + m(1.6));
      /* the entrance tower stands 0.55 m proud of the rest of NB, so a
         bracket bolted at `face` inside it is buried in the masonry */
      if (f.entryBay) runs = cutRuns(runs, f.entryBay.a - 1.2, f.entryBay.b + 1.2);
      /* and nothing may be clipped to the bridge band's face either: the band
         is the mass OVER the junction throat and a span from it crosses it */
      if (f.side === 'N') runs = cutRuns(runs, THROAT.x0 - 1.5, THROAT.x1 + 1.5);
      for (k = 0; k < runs.length; k++)
        if (runs[k][1] - runs[k][0] > 3.0) out.push({ a: runs[k][0], b: runs[k][1], f: f });
    }
    out.sort(function (p, q) { return p.a - q.a; });
    return out;
  }

  function buildWires(P, anchors) {
    var i, k;
    var pts = { N: [], S: [] };
    /* two clips per usable facade run, at the quarter points, staggered
       north against south so the two sides never mirror each other */
    var SIDES = ['N', 'S'];
    for (k = 0; k < 2; k++) {
      var side = SIDES[k], runs = wireRuns(side);
      for (i = 0; i < runs.length; i++) {
        var r = runs[i], f = r.f;
        var nClip = (r.b - r.a) > 22 ? 2 : 1;
        for (var c = 0; c < nClip; c++) {
          var x = nClip === 1 ? (r.a + r.b) * 0.5
                              : lerp(r.a, r.b, c ? 0.80 : 0.20);
          var y = WIRE_Y + (side === 'N' ? 0 : m(0.42)) + rr(i * 7 + c, 21, -0.6, 0.6) * m(0.28);
          pts[side].push(wireBracket(P, x, y, hangFace(f, x), 0, f.inward));
        }
      }
    }
    if (!pts.N.length && !pts.S.length) { warn('no legal facade run for an overhead wire'); return; }

    /* the two longitudinal bundles: three cables a side, continuous from the
       west end to the dead end.  A 22 m span at 0.85 m of sag is the real
       thing -- 1 in 26, which is what ref5 shows. */
    for (k = 0; k < 2; k++) {
      var P2 = pts[SIDES[k]];
      for (i = 0; i < P2.length - 1; i++) {
        var span = Math.abs(P2[i + 1][0] - P2[i][0]);
        /* 1 in 30 is what a strung LV distributor actually sags at, and it is
           what ref5 measures: perceptibly curved, nowhere near a washing line */
        wireBundle(P, P2[i], P2[i + 1], span * 0.034, 3, m(0.26));
      }
    }
    /* THE CROSSINGS.  Three, spread down the street rather than six radiating
       out of one clip.  A cable is only silhouetted against the sky where it
       is over the ROADWAY -- looking straight up, the visible sky slot is only
       |z - 172| < 7 -- so these three are the only wires in the money shot's
       sky wedge, and they are what ref5 reads as. */
    var CX = [0.12, 0.50, 0.88], nearest = function (list, x) {
      var best = null, bd = 1e9, j2;
      for (j2 = 0; j2 < list.length; j2++) {
        var dd = Math.abs(list[j2][0] - x);
        if (dd < bd) { bd = dd; best = list[j2]; }
      }
      return best;
    };
    for (i = 0; i < CX.length; i++) {
      var xt = lerp(BOX.x0 + 6, BOX.x1 - 6, CX[i]);
      var a = nearest(pts.N, xt + (i === 1 ? -7 : 0)), b = nearest(pts.S, xt + (i === 1 ? 7 : 0));
      if (!a || !b) continue;
      var dxc = b[0] - a[0], dzc = b[2] - a[2];
      wireStrand(P, a, [b[0], b[1] - m(0.35), b[2]],
                 Math.sqrt(dxc * dxc + dzc * dzc) * 0.045, WIRE_R, WCOL);
    }
    /* THE JUNCTION CROSSING.  _ref/ref5 and _ref/ref8 both show a line taken
       diagonally across the open junction -- it is the single thing that
       stops the apron reading as a car park, because it is the only object
       in that whole volume of air.  It is strung between the two westmost
       lamp heads, which are real anchors on real blocked cells, and it clears
       the island conifer by height (9 m of column against a 4.2 m crown base
       is not a clearance, so the span is lifted to the column tops and the
       island tree's canopy is 20 units east of the line). */
    (function () {
      var wN = null, wS = null, j2;
      for (j2 = 0; j2 < anchors.length; j2++) {
        var an2 = anchors[j2];
        if (!an2) continue;
        if (an2.z < (RZ0 + RZ1) * 0.5) { if (!wN || an2.x < wN.x) wN = an2; }
        else if (!wS || an2.x < wS.x) wS = an2;
      }
      if (!wN || !wS) return;
      var dxj = wS.x - wN.x, dzj = wS.z - wN.z;
      var len = Math.sqrt(dxj * dxj + dzj * dzj);
      if (len < 6) return;
      wireBundle(P, [wN.x, wN.y - m(0.22), wN.z], [wS.x, wS.y - m(0.30), wS.z],
                 len * 0.038, 2, m(0.22));
    })();

    /* one service drop per column or pole, to the nearest clip on its own side */
    for (i = 0; i < anchors.length; i++) {
      var an = anchors[i];
      if (!an) continue;
      var near = null, bd = 1e9, j;
      var sidePts = an.z < (RZ0 + RZ1) * 0.5 ? pts.N : pts.S;
      for (j = 0; j < sidePts.length; j++) {
        var d = Math.abs(sidePts[j][0] - an.x);
        if (d < bd) { bd = d; near = sidePts[j]; }
      }
      if (near) wireStrand(P, near, [an.x, an.y - m(0.30), an.z],
                           Math.max(0.5, bd * 0.055), WIRE_R * 0.9, WCOL);
    }
  }

  /* ---- satellite dishes --------------------------------------------------
     Rule B: every one is above the ground storey.  Small white offset dishes,
     all at roughly the same azimuth because they all look at the same bird --
     and one or two hung at a rakish angle because somebody's brother did it. */
  function buildDish(P, x, y, z, nx, nz, seed, scale) {
    var R = m(0.30) * (scale || 1);
    var ax = x + nx * m(0.34), az = z + nz * m(0.34);
    var skew = (rnd(seed, 3) - 0.5) * 0.55;
    var tilt = -0.24 + (rnd(seed, 5) - 0.5) * 0.30;
    var dx = nx * Math.cos(skew) - nz * Math.sin(skew);
    var dz = nx * Math.sin(skew) + nz * Math.cos(skew);
    P.steel.tile(T_STEEL).macro(0.2);
    /* the wall bracket and its arm */
    box6(P.steel, x - m(0.045), x + m(0.045), y - m(0.07), y + m(0.07),
         Math.min(z, z + nz * m(0.05)) - 0.02, Math.max(z, z + nz * m(0.05)) + 0.02, 0.90, GALV);
    tube(P.steel, x, y, z, ax, y + m(0.05), az, m(0.020), 5, 0.94, true, GALV);
    /* the dish itself: a shallow cone, face outward */
    var cx = ax + dx * m(0.10), cz = az + dz * m(0.10);
    var cy = y + m(0.05) + tilt * m(0.10);
    tube(P.steel, ax, y + m(0.05), az, cx, cy, cz, R * 0.10, 6, 0.95, true, GALV);
    P.panel.macro(0);
    var upx = -dz, upz = dx;
    /* the dish face is read from outside, along (dx,dz).  u x v came out as
       -(dx,dz), so every dish on the street was wound into the wall. */
    card(P.panel, cx + dx * 0.06, cy, cz + dz * 0.06,
         upx * R, 0, upz * R, -dx * R * tilt * 0.5, R, -dz * R * tilt * 0.5,
         PANEL.rect[P_DISH], [0.84, 0.84, 0.83], 1.0, [dx, 0.10, dz]);
    /* the LNB on its arm */
    P.steel.tile(T_STEEL);
    tube(P.steel, cx, cy - R * 0.52, cz, cx + dx * R * 0.86, cy - R * 0.16, cz + dz * R * 0.86,
         m(0.016), 4, 0.92, true, [0.86, 0.86, 0.84]);
    tube(P.steel, cx + dx * R * 0.80, cy - R * 0.18, cz + dz * R * 0.80,
         cx + dx * R * 1.02, cy - R * 0.10, cz + dz * R * 1.02, m(0.032), 6, 0.95, true, [0.84, 0.84, 0.82]);
    STATS.dishes++; STATS.props++;
  }

  /* THE FACE A SIBLING HANGS THINGS ON.  FACADE's amendment-2 schema splits
     `bayFace` (where a cikma would be) from `face` (where this run's facade
     ACTUALLY is), because the two hero blocks are not parametric: B-BLOK is
     flat-fronted, its loggias are cut back into the mass, and a dish bolted
     to a notional cikma at bayFace hangs 1.2 m out in the air in front of it.
     `face` is also wrong inside NB's entrance tower, which stands 0.55 m
     further out again -- so anything between entryBay.a and entryBay.b must
     use entryBay.face or move clear. */
  function hangFace(f, s) {
    var base = isFinite(f.face) ? f.face : f.bayFace;
    var eb = f.entryBay;
    if (eb && isFinite(eb.face) && s > eb.a && s < eb.b) return eb.face;
    return base;
  }

  function buildDishes(P) {
    var i, k, n = 0;
    for (i = 0; i < FACES.length; i++) {
      var f = FACES[i];
      if (f.side === 'E' || f.side === 'W') continue;
      var a = f.bayA + 2, b = f.bayB - 2;
      if (b - a < 6) continue;
      var count = Math.max(3, Math.round((b - a) / 9 * (0.6 + 0.6 * DENSITY)));
      for (k = 0; k < count; k++) {
        var s = lerp(a, b, (k + 0.5 + (rnd(i * 7, k) - 0.5) * 0.55) / count);
        var st = Math.floor(rnd(i * 11, k) * 4);
        var y = f.soffitTopY + m(0.65) + st * m(2.90) + rnd(i * 13, k) * m(0.55);
        if (y > f.eavesY - m(1.2)) y = f.eavesY - m(1.2) - rnd(i, k) * m(1.4);
        buildDish(P, s, y, hangFace(f, s), 0, f.inward, i * 97 + k * 17,
                  0.85 + rnd(i, k * 3) * 0.35);
        n++;
      }
      /* and a row on the eaves, all at the same azimuth */
      for (k = 0; k < 3; k++) {
        var s2 = lerp(a + 4, b - 4, (k + 0.5) / 3);
        buildDish(P, s2, f.eavesY + m(0.9), f.eaveFace, 0, f.inward, i * 131 + k, 0.8);
        n++;
      }
    }
    if (!n) warn('no facades to hang a dish on');
  }

  /* ---- signage, shopfront and litter ------------------------------------- */
  function buildSignage(P) {
    /* WHAT IS LIVE HERE, AND WHAT IS NOT.  The former short canyon carried an
       invented market, a west-gable plate, a banner and bagged rubbish at
       absolute x=200-era coordinates.  Those props are not present on the
       surveyed A/B frontage and would now land inside the park, so the
       straight-route portrait still omits them -- they are kept below this
       function's `return`, with the reason each one is still omitted.

       TWO of them were never invented and never deliberately off-map: the
       233. SK. plate, whose x was DERIVED from THROAT and only went stale when
       Amendment 2 collapsed the throat onto the canyon's own west edge, and
       the numara plaque, which belongs beside a residential door and had one.
       Both are back.  Both are re-anchored to what nz-street.js publishes NOW
       -- the facade run and its three residential entrances -- so that neither
       can silently go stale again the next time the street is re-carved.
       nz-street.js:4787 has been holding an unused '233. SOKAK' sign-atlas row
       against exactly this pass, and the street has carried no name plate at
       all since the re-carve. */
    var fW = faceOf('W'), fN = faceOf('N'), fS = faceOf('S'), i;

    /* THE STREET PLATE, ON THE CORNER WHERE THE STREET BEGINS.  A Turkish
       street plate goes on the building corner where the street begins, and
       the street begins at the junction on BOX.x0 -- so it sits on the north
       facade at that facade's own WEST corner, the first wall the player walks
       past on the way in, rather than on the blind west gable Amendment 2
       deleted along with the dead end.

       AMENDMENT 2 STALED THE X AND THE CLAMP HID IT.  THROAT is degenerate
       now -- x0 = x1 = 548, the canyon's own west edge -- so THROAT.x1 + 1.6
       is 549.6 and the old clamp to BOX pinned the plate at x = 550, which is
       THIRTY units west of where A-BLOK starts (fN.a = 580): it hung in open
       air over the junction with no wall behind it.  Clamping to the FACADE
       RUN instead puts it just inside whichever corner nz-street.js actually
       built, and still lets it follow the throat east if a later re-carve
       gives the junction real width.

       Rule A: the card stands 0.10 off the wall face and the brackets 0.08
       behind it, both an order under HUG = 0.98, so no jump clearance is
       owed and legalC() has no bay to test it against.

       THE HEIGHT IS STALE TOO, AND FOR A DIFFERENT REASON.  The old m(2.90)
       was chosen against a ground storey this street no longer has.  A-BLOK's
       ground storey is now punched with windows from y = 4.7 to 9.2 AND has a
       continuous precast string course standing proud of the siding across
       y = 8.6..9.4, so a 2.10-tall plate centred at 10.15 comes out sawn in
       half by the course with its bottom corner over a window.  The only
       clean field on this frontage is the first-floor band, y 10.2..11.9 --
       fN.soffitY..fN.soffitTopY, both published -- so the plate is centred on
       that, which is also where a Turkish plate actually goes: just under the
       first-floor sills, above the shopfront line.  Bottom edge y = 10.0,
       which clears jumpTop(Y_PAVE) = 9.26 into the bargain. */
    if (fN) {
      var spx = clamp(THROAT.x1 + 1.6, fN.a + SPLATE.w, fN.b - SPLATE.w);
      var spy = (fN.soffitY + fN.soffitTopY) * 0.5;
      var spz = fN.wallFace + fN.inward * 0.10;
      P.panel.macro(0.2);
      card(P.panel, spx, spy, spz, SPLATE.w * 0.5, 0, 0, 0, SPLATE.h * 0.5, 0,
           PANEL.rect[P_STREET], [0.95, 0.95, 0.94], 1.0, [0, 0, fN.inward]);
      P.steel.tile(T_STEEL).macro(0.2);
      for (i = 0; i < 2; i++)
        box6(P.steel, spx + (i ? 1 : -1) * SPLATE.w * 0.44 - 0.05,
             spx + (i ? 1 : -1) * SPLATE.w * 0.44 + 0.05,
             spy - SPLATE.h * 0.44, spy + SPLATE.h * 0.44,
             Math.min(spz, spz - fN.inward * 0.08), Math.max(spz, spz - fN.inward * 0.08),
             0.9, GALV);
      STATS.props++;
    }

    /* THE NUMARA PLAQUE, BESIDE THE FIRST RESIDENTIAL DOOR.  This one hung at
       a bare literal x = 214, which Amendment 2 left 334 units west of the
       canyon and inside no building at all.  A numara plate is not decoration
       and not invented -- it goes on the pier beside the door it numbers -- so
       it is read off the entrance list nz-street.js publishes rather than
       written down again: the westernmost of A-BLOK's three residential doors,
       plus half its width, plus m(0.45) of pier.  Falls back to the east side
       of the same door if that would run off the end of the facade.
       Its height moved for the same reason the plate's did -- m(2.35) put the
       top 0.22 of it behind the string course at y 8.6 -- and it now sits on
       the clear pier between the plinth cap and that course, m(0.65) above
       fN.plinthTop.  0.32 m square, 0.10 off the wall: rule A. */
    if (fN && fN.entrances && fN.entrances.length) {
      var e0 = fN.entrances[0], ei;
      for (ei = 1; ei < fN.entrances.length; ei++)
        if (fN.entrances[ei].x < e0.x) e0 = fN.entrances[ei];
      var eHalf = fin(e0.width, m(1.37)) * 0.5 + m(0.45);
      var npx = e0.x + eHalf;
      if (npx > fN.b - m(0.30)) npx = e0.x - eHalf;
      var npy = fN.plinthTop + m(0.65);
      var npz = fN.wallFace + fN.inward * 0.10;
      P.panel.macro(0.2);
      card(P.panel, npx, npy, npz, m(0.16), 0, 0, 0, m(0.16), 0,
           PANEL.rect[P_NUMBER], [0.95, 0.95, 0.94], 1.0, [0, 0, fN.inward]);
      STATS.props++;
    }

    /* =====================================================================
       NOTHING BELOW THIS LINE IS BUILT, AND EACH BLOCK SAYS WHY.
       Amendment 2 re-carved the canyon to x 548..836, z 140..208 and left
       every literal below it pointing at the pre-amendment short street.
       These are kept rather than deleted because the panel atlas still builds
       and uploads all of their tiles -- P_BANNER, P_FASCIA, P_SHUTTER,
       P_ABOARD, P_POSTER -- and a later survey pass that wants any of them
       needs the geometry, not just the texture.
       ================================================================== */
    return;

    /* THE FLY-POSTER.  x = 204.5 is off the map, and unlike the plaque there
       is no published feature to re-anchor it to.  It is also invented
       dressing on a frontage that was photographed: A-BLOK's ground storey is
       its porch and its lap siding, which is the same objection that keeps the
       market below.  Its natural host on the current street is the flaking
       maroon garden wall at z = 150, but that wall's top is at y = 4.09 and
       this card is 0.56 tall centred at m(1.75) = 6.13 -- re-siting it is a
       new placement, not a corrected one, so it waits for a survey pass. */
    if (fN) {
      var nz2 = fN.wallFace + fN.inward * 0.10;
      P.panel.macro(0.2);
      card(P.panel, 204.5, m(1.75), nz2, m(0.20), 0, 0, 0, m(0.28), 0,
           PANEL.rect[P_POSTER], [0.90, 0.89, 0.86], 0.95, [0, 0, fN.inward]);
      STATS.props++;
    }
    /* THE WEST-GABLE PLATE.  There is no west gable any more: PLANE.west = 548
       is the open junction mouth, faceOf('W') returns null and FACES holds
       only the two z-axis runs AB and BB.  The block is unreachable as it
       stands, and its z = 176.0 is a pre-amendment literal, so it would put a
       plate at the wrong place on the day someone does add an E/W face.
       Left here as the record of what a corner block carries, not as code. */
    if (fW) {
      var sx = fW.wallFace + fW.inward * 0.10;
      P.panel.macro(0.2);
      card(P.panel, sx, m(2.70), 176.0, 0, 0, SPLATE.w * 0.5, 0, SPLATE.h * 0.5, 0,
           PANEL.rect[P_STREET], [0.95, 0.95, 0.94], 1.0, [fW.inward, 0, 0]);
      P.steel.tile(T_STEEL).macro(0.2);
      for (i = 0; i < 2; i++)
        box6(P.steel, sx - 0.06, sx + 0.02, m(2.70) - SPLATE.h * 0.44, m(2.70) + SPLATE.h * 0.44,
             176.0 + (i ? 1 : -1) * SPLATE.w * 0.44 - 0.05,
             176.0 + (i ? 1 : -1) * SPLATE.w * 0.44 + 0.05, 0.9, GALV);
      STATS.props++;
    }
    /* THE CRESCENT BANNER.  Still omitted, and the author's reason still
       holds: it is invented, it is not on the surveyed B-BLOK frontage, and
       BANNER.x = 180.0 is 368 units west of BOX.x0 = 548 -- off the canyon
       and past even the park route's x0 = 260.  There is nothing to correct
       it TO: unlike the plate and the plaque, no published feature says where
       a banner belongs, so re-siting it is a design decision, not a fix.
       Rule B: y = 17 is nearly twice the jump apex. */
    if (fS) {
      var by = BANNER.y, bz = hangFace(fS, BANNER.x) + fS.inward * m(0.10);
      P.panel.macro(0.15);
      card(P.panel, BANNER.x, by, bz, BANNER.w * 0.5, 0, 0, 0, BANNER.h * 0.5, 0,
           PANEL.rect[P_BANNER], [0.92, 0.90, 0.88], 1.0, [0, 0, fS.inward]);
      P.steel.tile(T_STEEL).macro(0);
      tube(P.steel, BANNER.x - BANNER.w * 0.54, by + BANNER.h * 0.52, bz,
           BANNER.x + BANNER.w * 0.54, by + BANNER.h * 0.52, bz,
           m(0.012), 4, 1.0, false, [0.052, 0.052, 0.052]);
      STATS.props++;
    }

    /* --- the corner market: fascia, shutter housing, awning frame, A-board
       STILL OMITTED, AND THIS BLOCK'S OWN COMMENT IS WHY.  It says the only
       run that can carry a market is "the generic NC block on the junction
       corner, x 192-204" -- and Amendment 2 deleted that block along with the
       short canyon.  SHOP.x0/x1 are 194.4/203.0, off the map; the run they
       now resolve against, fN, is SEYDIKENT A-BLOK, whose ground storey is
       the porch and the lap siding this comment already rules out.  A market
       on the current street needs a host block first, and there is none.
       AMENDMENT 2 MOVED IT.  It used to sit on the south ground storey at
       x 192-200, which the re-carve handed to SEYDIKENT A-BLOK -- and A-BLOK's
       ground floor is its porch and its lap siding, both photographed.  The
       only run left that can carry a market is the generic NC block on the
       junction corner, x 192-204, which is exactly where _ref/ref5 has one.
       The fascia, the housing, the shutter and the A-board are rule A (all
       inside 0.98 of the wall face); the awning frame is rule B -- folded
       back at the TOP of the fascia at y = 10.8, clear of jumpTop(0.5) = 9.20,
       where it used to hang at 7.8 and be jumpable. */
    if (fN) {
      var sgn = fN.inward, wf = fN.wallFace;
      var sx0 = SHOP.x0, sx1 = SHOP.x1, scx = (sx0 + sx1) * 0.5;
      var fy0 = SHOP.y0, fy1 = SHOP.y1;
      var fz = wf + sgn * m(0.14);
      P.panel.macro(0.2);
      /* THE MIRRORED FASCIA.  u = +X and v = +Y makes u x v = +Z, and the
         south facade is read from -Z: GUVEN MARKET was being drawn on the back
         of the quad and read right-to-left from the street.  `face` is what
         fixes it, and it is passed on every other lettered panel below. */
      card(P.panel, scx, (fy0 + fy1) * 0.5, fz + sgn * 0.06, (sx1 - sx0) * 0.5, 0, 0,
           0, (fy1 - fy0) * 0.5, 0, PANEL.rect[P_FASCIA], [0.94, 0.93, 0.92], 1.0,
           [0, 0, sgn]);
      P.conc.tile(T_CONC).macro(0.6);
      box6(P.conc, sx0 - 0.2, sx1 + 0.2, fy0 - 0.08, fy1 + 0.08,
           Math.min(wf, fz) - 0.02, Math.max(wf, fz) + 0.02, 0.92, CONCC);
      /* the roller-shutter housing, and a metre of curtain left down */
      P.steel.tile(T_STEEL).macro(0.3);
      box6(P.steel, sx0 + 0.4, sx1 - 0.4, fy0 - m(0.36), fy0 - 0.10,
           Math.min(wf, wf + sgn * m(0.14)) - 0.02, Math.max(wf, wf + sgn * m(0.14)) + 0.02,
           0.86, [0.520, 0.528, 0.520]);
      P.panel.macro(0.3);
      card(P.panel, scx, fy0 - m(0.72), wf + sgn * m(0.11), (sx1 - sx0) * 0.5 - 0.5, 0, 0,
           0, m(0.34), 0, PANEL.rect[P_SHUTTER], [0.80, 0.80, 0.79], 0.92, [0, 0, sgn]);
      /* the awning frame, folded back against the wall.  It hangs BELOW the
         fascia board, not across it: at m(2.62) the front rail stood 0.95 m
         proud of the wall right through the middle of GÜVEN MARKET. */
      P.steel.tile(T_STEEL).macro(0.2);
      var awY = fy1 + m(0.04), awY2 = fy1 - m(0.22);
      for (i = 0; i < 4; i++) {
        var ax3 = lerp(sx0 + 0.5, sx1 - 0.5, i / 3);
        tube(P.steel, ax3, awY, wf, ax3, awY2, wf + sgn * m(0.95), m(0.018), 4, 0.94, true, GALV);
      }
      tube(P.steel, sx0 + 0.5, awY2, wf + sgn * m(0.95), sx1 - 0.5, awY2, wf + sgn * m(0.95),
           m(0.022), 5, 1.0, true, GALV);
      /* the A-board, folded and leaning on the wall where it lives all week */
      P.panel.macro(0.3);
      var abx = sx1 + m(0.55);
      card(P.panel, abx, Y_PAVE + m(0.42), wf + sgn * m(0.14), m(0.24), 0, 0,
           0, m(0.42), sgn * m(0.06), PANEL.rect[P_ABOARD], [0.88, 0.87, 0.84], 1.0,
           [0, 0, sgn]);
      P.trim.tile(T_TRIM).macro(0.4);
      box6(P.trim, abx - m(0.26), abx + m(0.26), Y_PAVE, Y_PAVE + m(0.05),
           Math.min(wf, wf + sgn * m(0.22)) - 0.02, Math.max(wf, wf + sgn * m(0.22)) + 0.02,
           0.80, [0.155, 0.148, 0.130]);
      STATS.props++;
    }

    /* --- bagged rubbish and the galvanised bin.  Still omitted: the author
       listed "rubbish" among the props the straight-route portrait leaves
       out, and rx = 232.5 is off the map besides.  Rule A: nothing here
       reaches 0.98 off the plane, and the pile is 0.55 m tall. ----------- */
    if (fN) {
      var rz = fN.wallFace + fN.inward * m(0.22);
      var rx = 232.5, R = Rng(SEED + 8821);
      P.trim.tile(T_TRIM).macro(0.5);
      for (i = 0; i < 6; i++) {
        var bx = rx + (R() - 0.5) * m(0.95);
        var bz2 = rz + fN.inward * R() * m(0.10);
        var br = m(0.15 + R() * 0.09);
        var byy = Y_PAVE + br * (i > 3 ? 1.7 : 0.92);
        boxC(P.trim, bx, byy, bz2, br * 1.15, br * 0.92, br,
             br * 0.42, 0.92, [0.058, 0.057, 0.060]);
      }
      /* a galvanised bin beside them */
      var gx = rx - m(0.95);
      P.steel.tile(T_STEEL).macro(0.3);
      tube(P.steel, gx, Y_PAVE, rz, gx, Y_PAVE + m(0.72), rz, m(0.20), 10, 0.94, true, GALV, m(0.23));
      tube(P.steel, gx, Y_PAVE + m(0.72), rz, gx, Y_PAVE + m(0.78), rz, m(0.245), 10, 1.0, true,
           [GALV[0] * 1.1, GALV[1] * 1.1, GALV[2] * 1.1], m(0.20));
      STATS.props++;
    }

    /* --- a facade bracket lamp on the blind west gable.  Unreachable for
       the same reason as the west-gable plate: there is no blind west gable
       any more, faceOf('W') is null, and z = 172.0 is a pre-amendment
       literal.  (It emits a LUM tube, not a THREE.Light, so it was never the
       light itself that was the problem -- there is simply no wall.)
       Rule B: y = 16 is twice the jump apex, so the 0.9 m arm may reach out
       freely. ----------------------------------------------------------- */
    if (fW) {
      var bx3 = fW.bayFace, byy2 = m(4.6);
      P.steel.tile(T_STEEL).macro(0.2);
      box6(P.steel, Math.min(bx3, bx3 + fW.inward * m(0.10)) - 0.02,
           Math.max(bx3, bx3 + fW.inward * m(0.10)) + 0.02,
           byy2 - m(0.12), byy2 + m(0.12), 172.0 - m(0.10), 172.0 + m(0.10), 0.9, GALV);
      var ex = bx3 + fW.inward * m(0.80);
      tube(P.steel, bx3, byy2, 172.0, ex, byy2 + m(0.16), 172.0, m(0.022), 5, 0.96, true, GALV);
      tube(P.steel, ex, byy2 + m(0.16), 172.0, ex + fW.inward * m(0.10), byy2 + m(0.02), 172.0,
           m(0.115), 8, 1.0, true, LUM, m(0.145));
      STATS.props++;
    }
  }

  /* =======================================================================
     SECTION 14 -- assembly.
     Nine piles, nine draw calls, one material each.  A pile has a single
     index buffer and one material, which is the whole design constraint and
     is what drives the grouping (ENV-PLAYBOOK 6.7).
     ==================================================================== */
  var PILES = null, MESHES = null;
  /* Real car glazing is kept out of the merged P.glass pile.  Each entry owns
     one complete physical pane (all of its tessellation bands), which lets
     nz-destruct crack and remove exactly the window that was hit without
     taking the black pillars, seals or mirror sail with it. */
  var CAR_WINDOWS = [];
  var BLENDER_CAR = [];
  var CAR_SHADOW = [];

  /* THE COURIER AGAINST THE PHOTOGRAPHS.  Every silver car in the owner's
     April 2026 and August 2015 frames of this street reads as a MID grey under
     the overcast -- door panels 115-150 of 255, bright only along the roof and
     the shoulder -- with a film of road dirt on its lower 30 cm, dark wheels,
     and a black gap under the sills.  The export rendered its doors at
     175-190, clean as a showroom, on bright alloys, standing on a road with
     no shadow under it at all, so it read as pasted on.  k is a linear
     multiplier on the exported base colour (which is also F0 for the metallic
     part of the paint, so it takes the mirror down with it); the asset itself
     is untouched and a re-export lands on the same trims. */
  var COURIER_TRIM = {
    silver: { k: 0.60, rough: 0.38, cc: 0.20 },
    alloy: { k: 0.50, rough: 0.44 }
  };
  /* the road film: full at the sill, gone by half a metre up the door */
  function courierFilm(yM) {
    var q = clamp((0.52 - yM) / 0.42, 0, 1);
    q = q * q * (3 - 2 * q);
    return [1 - 0.30 * q, 1 - 0.32 * q, 1 - 0.37 * q];
  }

  // Blender owns the vehicle geometry; the street still owns placement,
  // materials, disposal, baked illumination and destructible pane records.
  function buildBlenderCourier(S, px, py, pz, yaw, roll, seed) {
    var asset = global.NZ_COURIER_ASSET;
    var sx = S.L / asset.dimensions[0], sy = m(1), sz = m(1);
    var wheels = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], mi, vi;
    /* where the export's tyres touch the ground, in its own metres */
    for (mi = 0; mi < asset.meshes.length; mi++) {
      var sr0 = asset.meshes[mi];
      if (sr0.material !== 'rubber') continue;
      for (vi = 0; vi < sr0.positions.length; vi += 3) {
        if (sr0.positions[vi + 1] >= 0.06) continue;
        var wk = (sr0.positions[vi] > asset.dimensions[0] * 0.5 ? 1 : 0) + (sr0.positions[vi + 2] > 0 ? 2 : 0);
        wheels[wk][0] += sr0.positions[vi]; wheels[wk][1] += sr0.positions[vi + 2]; wheels[wk][2]++;
      }
    }
    var contact = [];
    for (var wq = 0; wq < 4; wq++)
      if (wheels[wq][2] > 0) contact.push([wheels[wq][0] / wheels[wq][2], wheels[wq][1] / wheels[wq][2]]);
    /* THE POSE, solved again from those four patches.  buildCars() solves the
       roll for the procedural fleet, whose local +z is the other flank from
       the export's, and handed to this asset unchanged it leaned the van INTO
       the kerb: kerbside tyres 0.4 u inside the kerb stone, roadside tyres
       floating 0.29 u -- 8 cm -- clear of the road, measured by ray against
       nz-street-ground's own meshes.  Here each flank's two patches are put
       on GROUND's surface, the kerbside pair squatting 12 % of the step into
       its tyres as before, and the roadside pair touching. */
    if (contact.length === 4) {
      var T0 = mkT(px, 0, pz, yaw, 0), gP = 0, gN = 0, zP = 0, zN = 0, nP = 0, nN = 0;
      for (wq = 0; wq < 4; wq++) {
        var wc = T0(contact[wq][0] * sx, 0, contact[wq][1] * sz), gy = groundYAt(wc[2], wc[0]);
        if (contact[wq][1] > 0) { gP += gy; zP += contact[wq][1] * sz; nP++; }
        else { gN += gy; zN += contact[wq][1] * sz; nN++; }
      }
      if (nP && nN) {
        gP /= nP; gN /= nN; zP /= nP; zN /= nN;
        var srl = clamp((gN - gP) / (zP - zN) * (1 - 0.12), -0.35, 0.35);
        roll = Math.asin(srl);
        py = (gP < gN ? gP + zP * srl : gN + zN * srl) - m(0.012);
      }
    }
    var T = mkT(px, py, pz, yaw, roll), N = mkT(0, 0, 0, yaw, roll);
    for (mi = 0; mi < asset.meshes.length; mi++) {
      var src = asset.meshes[mi], pile = new Pile(1);
      var film = src.material === 'silver';
      for (vi = 0; vi < src.positions.length; vi += 3) {
        var p = T(src.positions[vi] * sx, src.positions[vi + 1] * sy, src.positions[vi + 2] * sz);
        var n = N(src.normals[vi] / sx, src.normals[vi + 1] / sy, src.normals[vi + 2] / sz);
        var len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
        var ft = film ? courierFilm(src.positions[vi + 1]) : null;
        if (ft) pile.vert(p[0], p[1], p[2], n[0] / len, n[1] / len, n[2] / len, 0, 0, ft[0], ft[1], ft[2]);
        else pile.vert(p[0], p[1], p[2], n[0] / len, n[1] / len, n[2] / len, 0, 0, 1, 1, 1);
      }
      pile.idx = src.indices.slice();
      var rec = { pile: pile, source: src, materialSpec: asset.materials[src.material] };
      if (src.window) {
        rec.id = 'car-' + seed + '-' + src.window.kind + '-' + src.window.side + '-' + src.window.pane;
        rec.kind = src.window.kind; rec.side = src.window.side; rec.pane = src.window.pane;
        rec.seed = seed + mi * 97; rec.mesh = null;
        CAR_WINDOWS.push(rec);
      }
      BLENDER_CAR.push(rec);
    }
    CAR_SHADOW.push({ px: px, pz: pz, yaw: yaw, sx: sx, sz: sz, x0: -0.03, x1: asset.dimensions[0] + 0.04,
                      hw: asset.dimensions[2] * 0.5 - 0.02, wheels: contact });
    STATS.cars++; STATS.props += 4;
  }

  /* ---- THE CONTACT SHADOW --------------------------------------------------
     Nothing else can put one under the car.  The street's shading is the sky
     bake, and the road is baked by nz-street-ground before this module has
     placed anything on it; the key light's shadow camera is a 102-unit box
     centred on the player, 540 units away (see the note in section 10).  A
     parked car on an overcast day stands in the darkest patch of road in the
     frame: under the sills the ground sees a 15 cm slot of sky, and each
     tyre sits in its own near-black wedge.  So: one soft rounded-rectangle
     card, conformed to the road, kerb and pavement it lies on, darkest at
     the four contact patches, drawn after the ground's own decals
     (renderOrder 1-3) and before the destruction decals (4).
     It is an UNLIT darkening, like the soldiers' contact shadows in
     NUKEM.html: the overcast rig has no direction for it to disagree with. */
  function carShadowCanvas(rec) {
    var W = 256, H = 128, c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
    var mg = 0.40, L0 = rec.x0 - mg, L1 = rec.x1 + mg, Z0 = -rec.hw - mg, Z1 = rec.hw + mg;
    var cxm = (rec.x0 + rec.x1) * 0.5, hl = (rec.x1 - rec.x0) * 0.5, hw = rec.hw, r = 0.30;
    function ss(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
    for (var y = 0; y < H; y++) {
      var zz = Z0 + (Z1 - Z0) * (y + 0.5) / H;
      for (var x = 0; x < W; x++) {
        var xx = L0 + (L1 - L0) * (x + 0.5) / W;
        /* signed distance to the body's rounded footprint, metres */
        var qx = Math.abs(xx - cxm) - (hl - r), qz = Math.abs(zz) - (hw - r);
        var dist = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qz, 0) * Math.max(qz, 0)) +
                   Math.min(Math.max(qx, qz), 0) - r;
        var a = 0.42 * ss(0.36, -0.08, dist) + 0.30 * ss(0.0, -0.55, dist);
        for (var k = 0; k < rec.wheels.length; k++) {
          var wx = (xx - rec.wheels[k][0]) / 0.34, wz = (zz - rec.wheels[k][1]) / 0.20;
          a = Math.max(a, 0.86 * Math.exp(-(wx * wx + wz * wz) * 1.6));
        }
        var j = (y * W + x) * 4;
        d[j] = d[j + 1] = d[j + 2] = 255;
        d[j + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  function meshCarShadows() {
    for (var ci = 0; ci < CAR_SHADOW.length; ci++) {
      var rec = CAR_SHADOW[ci], NU = 18, NV = 8, mg = 0.40;
      var L0 = rec.x0 - mg, L1 = rec.x1 + mg, Z0 = -rec.hw - mg, Z1 = rec.hw + mg;
      var T = mkT(rec.px, 0, rec.pz, rec.yaw, 0), pos = [], uv = [], idx = [], i, j;
      for (j = 0; j <= NV; j++) {
        for (i = 0; i <= NU; i++) {
          var w = T(lerp(L0, L1, i / NU) * rec.sx, 0, lerp(Z0, Z1, j / NV) * rec.sz);
          pos.push(w[0], groundYAt(w[2], w[0]) + 0.035, w[2]);
          uv.push(i / NU, 1 - j / NV);
        }
      }
      for (j = 0; j < NV; j++) {
        for (i = 0; i < NU; i++) {
          var a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, e = c + 1;
          idx.push(a, c, b, b, c, e);
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      var tex = texCanvas(carShadowCanvas(rec), false, true);
      var mat = new THREE.MeshBasicMaterial({
        map: tex, color: 0x101418, transparent: true, opacity: 1, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, fog: true
      });
      mat.name = 'nzprops-car-contact';
      OWN.mat.push(mat);
      OWN.geo.push(geo);
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'nzprops-car-contact-' + ci;
      mesh.renderOrder = 3.5;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      scene.add(mesh);
      OWN.obj.push(mesh);
      STATS.addedCalls++;
      STATS.tris += idx.length / 3;
      DIAG.piles.push({ name: mesh.name, tris: idx.length / 3, verts: pos.length / 3, added: true });
    }
  }

  function meshBlenderCourier(bakeOpts) {
    for (var i = 0; i < BLENDER_CAR.length; i++) {
      var rec = BLENDER_CAR[i], s = rec.materialSpec, pane = !!rec.source.window;
      var tr = pane ? null : COURIER_TRIM[rec.source.material], kc = tr ? tr.k : 1;
      var mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(s.color[0] * kc, s.color[1] * kc, s.color[2] * kc),
        metalness: s.metalness, roughness: tr ? Math.max(s.roughness, tr.rough) : s.roughness,
        clearcoat: rec.source.material === 'silver' ? (tr ? tr.cc : 0.38) : 0,
        clearcoatRoughness: 0.20, vertexColors: true, dithering: true, fog: true,
        transparent: pane, opacity: pane ? s.opacity : 1,
        depthWrite: !pane, side: pane ? THREE.DoubleSide : THREE.FrontSide
      });
      mat.name = 'nzday:props-blender-courier-' + rec.source.material;
      stDay(mat, { name: 'props-blender-courier-' + rec.source.material,
        intensity: pane ? 0.64 : 0.82, spec: pane ? 0.42 : 0.35 });
      OWN.mat.push(mat);
      // External scenery shades the asset; the coarse car occluder must not
      // darken every interior vertex as if it were enclosed in solid metal.
      var bk = { rays: Math.min(RAYS, 12), occluders: OCCL, floor: 0.58, scale: 0.94 };
      if (pane) {
        var wm = makeCarWindowMesh(rec, mat, bk);
        if (wm) MESHES.windows.push(wm);
      } else {
        var mesh = makeMesh(rec.pile, mat, 'nzprops-courier-' + rec.source.material, bk);
        if (mesh) {
          mesh.userData.blenderSource = 'assets/courier/courier.blend';
          if (rec.source.material === 'silver') MESHES.body = mesh;
          if (rec.source.material === 'seat') MESHES.cabin = mesh;
        }
      }
    }
  }
  var CARS_BUILT = [];   /* {x,z,y,spec,bay,yaw} per parked car, published so
                            nz-destruct.js can put a bullet hole on a body
                            panel instead of on the invisible bay plane */

  /* WHAT STANDS ON EACH TREE PIT, AMENDMENT 2.  The re-carve moved every one
     of them; this table is rewritten from the new scan and from the two money
     shots, not edited.  Everything here is deterministic.

     THE SIGHT LINE IS A PROGRAMME CONSTRAINT, NOT A PREFERENCE.  The whole
     street exists to lead from the junction to the foyer door, so the ray
     from the island (188.6, 172) and from the west-end camera (171, 6.4, 170)
     to the door at (242, 152) has to stay open.  Measured on the new map that
     ray passes x = 218 at z = 161 and x = 234 at z = 155.6, which is exactly
     where the two middle north pits are -- so neither of them gets a spruce.

     Pit order is north-then-x:
       [0] N x196-200  the junction corner, first blocked ground east of the
                       throat.  The tall cobra-head of _ref/ref2 stands here,
                       and the red warning triangle of _ref/ref8 goes on the
                       same cell at its west end -- that is the "pavement
                       return at the throat", and it is the only legal ground
                       for it, because the north pavement does not exist
                       between x = 176 and x = 192.  A LOW bare tree only: at
                       27 units from the west camera a spruce here is a 26 deg
                       cone across the whole left half of the money shot.
       [1] N x216-220  ON the sight line.  A bare fruit tree in blossom at
                       6.2 m -- thin verticals, no mass -- plus the ivy and the
                       kilim that make the bed read as tended.
       [2] N x248-252  EAST of the foyer door (the map put it there on purpose:
                       "the conifer at 62 frames the entrance").  A 9.0 m
                       spruce, and it is the one tree that may be big on the
                       north side, because it is BEYOND the door: it frames it
                       instead of covering it.  Plus the utility pole.
       [3] S x180-184  the south-west corner of the junction, opposite the
                       island.  A 8.6 m spruce -- the right-hand dark mass of
                       _ref/ref8 and _ref/ref5 -- and the south lamp.
       [4] S x196-200  where A-BLOK starts, and the pit _ref/ref1's left
                       foreground is: the flaking maroon wall with the white
                       precast balusters.  NO TREE: it is 2.3 m west of the
                       A-BLOK porch and from every camera on this street a
                       crown here lands squarely on the SEYDIKENT lettering.
       [5] S x232-236  THE A-BLOK PORCH CONIFER (_ref/ref6).  The map gives no
                       pit inside the porch bay (x 208-216), so it stands on
                       the nearest blocked cell EAST of it and leans west --
                       east, because the porch faces back up the street toward
                       the junction and a trunk on its west side would cross
                       the lettering from every westward camera, which is all
                       of them.  9.4 m, the biggest tree on the pavements. */
  var PIT_PLAN = [
    { tree: 'bare', h: 5.8, rail: 1, ivy: 1, lamp: 9.4, sign: P_NOPARK, panels: 1,
      warn: 1, rose: 0, bin: 0, hose: 0, chair: 0, wood: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'bare', h: 6.2, blossom: 1, rail: 1, ivy: 1, carpet: 1, chair: 1, panels: 1,
      rose: 0, bin: 0, hose: 0, wood: 0, balusters: 0, gate: 0 },
    { tree: 'conifer', h: 9.0, rail: 1, wood: 1, pole: 9.6, panels: 1,
      rose: 0, ivy: 0, bin: 0, hose: 0, chair: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'conifer', h: 8.6, rail: 1, hose: 1, lamp: 9.0,
      rose: 0, wood: 0, ivy: 0, bin: 0, chair: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'none', rail: 2, balusters: 1, rose: 1, ivy: 1, carpet: 1, bin: 1, gate: 1,
      hose: 0, wood: 0, chair: 0 },
    { tree: 'conifer', h: 9.4, lean: 1, rail: 2, wood: 1, chair: 1,
      rose: 0, ivy: 0, bin: 0, hose: 0, carpet: 0, balusters: 0, gate: 0 }
  ];

  /* MISSION 4 PLANTS FROM THE OWNER'S 233 Sk FRAME, NOT FROM THE OLD CANYON.
     PIT_PLAN above was written for six pits on the mission-1 street, where
     A-BLOK stood on the SOUTH side and a foyer door had a sight line to keep.
     The cordon has eight pits, the two blocks have changed sides, there is no
     foyer, and the table was simply being read modulo six -- which put the
     tallest conifer in front of B-BLOK and a blossom sapling in front of
     A-BLOK, the reverse of every photograph of this street.

     What the April 2026 frame shows, looking east from the roundabout:
       LEFT, A-BLOK   a bare street tree on the corner, then three dark
                      SPRUCES in the garden strip, each three to four storeys
                      tall and narrow, the first of them just past the first
                      entrance;
       RIGHT, B-BLOK  nothing taller than the garden wall for the whole
                      frontage except one clipped shrub by the first gate, a
                      lamp column two thirds of the way down, and tall
                      spruces only beyond the block's east end.
     Pit order is north-then-x, as above: N 596 / 644 / 700 / 748, then
     S 612 / 664 / 716 / 752. */
  var PIT_PLAN_L4 = [
    { tree: 'bare', h: 5.8, rail: 1, ivy: 1, lamp: 9.4, sign: P_NOPARK, panels: 1,
      warn: 1, rose: 0, bin: 0, hose: 0, chair: 0, wood: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'spruce', h: 11.8, rail: 1, ivy: 1, panels: 1,
      rose: 0, bin: 0, hose: 0, chair: 0, wood: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'spruce', h: 12.6, rail: 1, wood: 1, pole: 9.6, panels: 1,
      rose: 0, ivy: 0, bin: 0, hose: 0, chair: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'spruce', h: 10.4, rail: 1, hose: 1,
      rose: 0, wood: 0, ivy: 0, bin: 0, chair: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'shrub', h: 1.9, rail: 2, balusters: 1, rose: 1, ivy: 1, carpet: 1, bin: 1, gate: 1,
      hose: 0, wood: 0, chair: 0 },
    { tree: 'none', rail: 2, wood: 1, chair: 1, rose: 1,
      ivy: 0, bin: 0, hose: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'bare', h: 5.4, rail: 1, ivy: 1, lamp: 9.0, sign: P_NOPARK,
      rose: 0, bin: 0, hose: 0, chair: 0, wood: 0, carpet: 0, balusters: 0, gate: 0 },
    { tree: 'spruce', h: 11.2, rail: 1, hose: 1,
      rose: 0, wood: 0, ivy: 0, bin: 0, chair: 0, carpet: 0, balusters: 0, gate: 0 }
  ];

  function pitBlocked(pit) {
    /* never plant in the alley passage or in the entrance recess */
    var i, k, cx = (pit.x0 + pit.x1) * 0.5;
    /* nor anywhere inside the box the entrance module publishes, plus the
       0.80 the enclosure is allowed to overhang by */
    if (inKeepClear(pit.x0 - 0.9, pit.x1 + 0.9, pit.z0 - 0.9, pit.z1 + 0.9, 0)) return true;
    for (i = 0; i < FACES.length; i++) {
      var f = FACES[i];
      if (f.axis !== 'z') continue;
      var near = Math.abs(acrossOf(f, cx, (pit.z0 + pit.z1) * 0.5) - f.plane);
      if (near > 6) continue;
      for (k = 0; k < f.gaps.length; k++)
        if (cx > f.gaps[k].a - 2.2 && cx < f.gaps[k].b + 2.2) return true;
      if (f.entrance && Math.abs(cx - f.entrance.x) < m(2.1)) return true;
    }
    return false;
  }

  function buildAll() {
    CAR_WINDOWS = [];
    BLENDER_CAR = [];
    CAR_SHADOW = [];
    PILES = {
      body: new Pile(T_PAINT), glass: new Pile(T_GLASS), trim: new Pile(T_TRIM),
      cabin: new Pile(T_TRIM),
      /* MISSION 4 ONLY.  On mission 1 this pile stays empty, wireStrand()
         keeps writing into `trim` exactly as it always has, and makeMesh()
         drops the empty pile without a draw call. */
      wire: new Pile(T_TRIM),
      bark: new Pile(T_BARK), leaf: new Pile(1), wall: new Pile(T_WALL),
      brick: new Pile(T_BRICK),
      conc: new Pile(T_CONC), steel: new Pile(T_STEEL), panel: new Pile(1)
    };
    SELF_OCC.length = 0;
    var P = PILES, i;

    var bays = scanBays(), pits = [], isles = 0;
    /* KIND, not geometry.  The island is S_BLOCK too and it sits inside the
       kerb faces, so the old "not on the road => tree pit" test would have
       planted a spruce garden on it and the old "on the road => bay" test
       parked two cars across the junction, which is exactly what the last
       build shipped. */
    for (i = 0; i < bays.length; i++) {
      if (bays[i].kind === 'pit') pits.push(bays[i]);
      else if (bays[i].kind === 'island') isles++;
    }
    pits.sort(function (a, b) {
      var an = ((a.z0 + a.z1) * 0.5) < (RZ0 + RZ1) * 0.5;
      var bn = ((b.z0 + b.z1) * 0.5) < (RZ0 + RZ1) * 0.5;
      return (an === bn) ? a.x0 - b.x0 : (an ? -1 : 1);
    });
    STATS.bays = bays.length; STATS.pits = pits.length; STATS.islandCells = isles;

    /* the cars come first: their bodies become occluders for everything the
       bake does afterwards, which is what puts the hard dark patch under a
       parked car that the brief ranks as the first thing to get right. */
    phase('cars'); CARS_BUILT = buildCars(P, bays);

    /* THE ISLAND, second, and for the same reason: its conifer is the biggest
       single occluder on the street and everything baked after it -- the
       apron, the signs at its own nose, the near flank of the minibus -- has
       to see it. */
    phase('island'); buildIsland(P);

    /* the tree pits: a garden enclosure, a tree, and sometimes a column */
    var skipN = [], skipS = [], anchors = [];
    for (i = 0; i < pits.length; i++) {
      var pit = pits[i];
      var plan = (L4 && pits.length === PIT_PLAN_L4.length)
        ? PIT_PLAN_L4[i] : PIT_PLAN[i % PIT_PLAN.length];
      if (pitBlocked(pit)) {
        DIAG.legal.push('tree pit at x ' + pit.x0 + ' skipped: it is in a facade gap');
        continue;
      }
      var seed = i * 811 + 37, cuts = [], anch = null;
      phase('pit' + i);
      if (plan.lamp) {
        anch = buildLamp(P, pit, seed, plan.lamp, plan.sign);
        if (anch) { cuts.push(anch.cut); anchors.push(anch); }
      }
      if (plan.pole) {
        var ap = buildPole(P, pit, seed + 5, plan.pole);
        if (ap) { cuts.push(ap.cut); anchors.push(ap); }
      }
      /* the red triangle at the throat: on the pavement return, on this pit's
         own blocked cell, never in the pavement gap itself.  PIT_PLAN is
         indexed by scan order, so both of the side-specific entries below are
         re-tested against the pit the index actually landed on -- move a pit
         in NUKEM.html and the brick railing panels stay on the brick side and
         the warning sign stays at the throat, instead of silently swapping. */
      var pitN = ((pit.z0 + pit.z1) * 0.5) < (RZ0 + RZ1) * 0.5;
      if (plan.warn && pitN) {
        var aw2 = buildThroatSign(P, pit);
        if (aw2) cuts.push(aw2.cut);
      }
      buildEnclosure(P, pit, i, {
        rail: plan.rail || 0, balusters: !!plan.balusters, gate: !!plan.gate,
        panels: !!plan.panels && pitN,
        rose: !!plan.rose, wood: !!plan.wood, chair: !!plan.chair, hose: !!plan.hose,
        ivy: !!plan.ivy, carpet: !!plan.carpet, bin: !!plan.bin, cuts: cuts
      });
      /* 'none' is a real entry, not a missing one: see PIT_PLAN's header.  The
         enclosure above has already been built, so the pit still reads as a
         planted bed. */
      if (plan.tree === 'conifer')
        /* The pavement trees are the SAME plant as the island's, one size
           down: the photographs of the A/B corridor show cedars and black
           pines, not the narrow spruce whorls this file used to build.  The
           crown base stays at CROWN_BASE so the 2.5 m pruning clearance a
           street tree actually has is kept, and blocked() still cuts any
           branch that would grow into a balcony. */
        buildCedar(P, seed, plan.h, {
          base: { x: (pit.x0 + pit.x1) * 0.5, z: (pit.z0 + pit.z1) * 0.5 },
          baseY: Y_PAVE, crownBase: CROWN_BASE + 0.6,
          spread: plan.lean ? 0.315 : 0.285, trunk: 0.86, sway: 0.30
        });
      else if (plan.tree === 'spruce')
        /* the narrow dark spruce of the A/B corridor */
        buildSpruce(P, pit, seed, plan.h);
      else if (plan.tree === 'shrub')
        buildShrub(P, (pit.x0 + pit.x1) * 0.5, (pit.z0 + pit.z1) * 0.5,
                   plan.h * 0.58, seed, Y_PAVE + 0.10, plan.h);
      else if (plan.tree === 'bare') buildBareTree(P, pit, seed, plan.h, !!plan.blossom);
      else if (L4) { /* a planted bed with nothing tall in it */ }
      else DIAG.legal.push('tree pit at x ' + pit.x0 + ' is planted low on purpose: ' +
                           'it stands on the west-end sight line to the entrance');
      (((pit.z0 + pit.z1) * 0.5) < (RZ0 + RZ1) * 0.5 ? skipN : skipS)
        .push([pit.x0 - 1.2, pit.x1 + 1.2]);
    }
    if (!pits.length) warn('no tree-pit S_BLOCK cells found -- no trees, no garden walls');

    /* the continuous garden edging between the enclosures */
    var crossN = [], crossS = [], g = GR();
    if (g && g.crossovers) {
      for (i = 0; i < g.crossovers.length; i++) {
        var c = g.crossovers[i];
        (c.side === 'S' ? crossS : crossN).push([c.x0 - 1.0, c.x1 + 1.0]);
      }
    }
    phase('edging'); buildEdging(P, 'N', pits, skipN.concat(crossN));
    buildEdging(P, 'S', pits, skipS.concat(crossS));

    phase('dishes'); buildDishes(P);
    phase('signage'); buildSignage(P);
    phase('wires'); buildWires(P, anchors);
  }

  function makeMesh(pile, mat, name, bakeOpts, order) {
    if (!pile || pile.empty() || !mat) {
      DIAG.piles.push({ name: name, tris: 0, verts: 0, added: false });
      return null;
    }
    phase('mesh:' + name);
    var geo = pile.geometry();
    stBake(geo, bakeOpts);
    applyTone(geo, pile);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    if (order) mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    OWN.obj.push(mesh);
    STATS.addedCalls++;
    STATS.tris += (pile.idx.length / 3) | 0;
    STATS.verts += pile.n;
    DIAG.piles.push({ name: name, tris: (pile.idx.length / 3) | 0, verts: pile.n, added: true });
    return mesh;
  }

  function makeCarWindowMesh(rec, mat, bakeOpts) {
    if (!rec || !rec.pile || rec.pile.empty() || !mat) return null;
    phase('mesh:' + rec.id);
    var geo = rec.pile.geometry();
    stBake(geo, bakeOpts); applyTone(geo, rec.pile);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    var paneMat = mat.clone();
    paneMat.name = (mat.name || 'nzday:props-carglass') + ':' + rec.id;
    /* A side pane is seen from both directions.  FrontSide is correct for the
       exterior shell, but it culls the inside face of the intact pane across
       the cabin once the near window has fallen.  That made the far opening
       look empty even though its glass state was still intact. */
    paneMat.side = THREE.DoubleSide;
    paneMat.shadowSide = THREE.DoubleSide;
    paneMat.depthWrite = false;
    paneMat.needsUpdate = true;
    OWN.mat.push(paneMat);
    var mesh = new THREE.Mesh(geo, paneMat);
    mesh.name = 'nzprops-' + rec.id;
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    scene.add(mesh); OWN.obj.push(mesh);
    rec.mesh = mesh; rec.material = paneMat;
    if (geo.boundingSphere) {
      rec.center = [geo.boundingSphere.center.x, geo.boundingSphere.center.y, geo.boundingSphere.center.z];
      rec.radius = geo.boundingSphere.radius;
    }
    STATS.addedCalls++; STATS.tris += (rec.pile.idx.length / 3) | 0; STATS.verts += rec.pile.n;
    DIAG.piles.push({ name: mesh.name, tris: (rec.pile.idx.length / 3) | 0,
                      verts: rec.pile.n, added: true });
    return mesh;
  }

  function meshAll() {
    var occ = occAll();
    var bk = { rays: RAYS, occluders: occ };
    /* thin members -- railings, wires, dish arms, wheels -- carry a whole
       vertex per 40 mm of steel and no shading information worth the rays */
    var thin = { rays: Math.max(8, RAYS - 4), occluders: occ };
    MESHES = {};
    MESHES.body = makeMesh(PILES.body, MATS.body, 'nzprops-carbody', bk);
    MESHES.glass = makeMesh(PILES.glass, MATS.glass, 'nzprops-carglass', bk);
    MESHES.trim = makeMesh(PILES.trim, MATS.trim, 'nzprops-trim', thin);
    /* empty on mission 1, so this costs nothing there */
    MESHES.wire = makeMesh(PILES.wire, MATS.wire, 'nzprops-wire', thin);
    /* Never bake the cabin against SELF_OCC: those boxes intentionally wrap
       each whole car and would classify every seat, belt and dashboard vertex
       as buried inside sheet metal.  The opening is lit by the street and by
       a high inter-reflection floor, just like a real cabin under open sky. */
    MESHES.cabin = makeMesh(PILES.cabin, MATS.cabin, 'nzprops-car-cabin',
      { rays: Math.min(RAYS, 12), occluders: OCCL, floor: 0.58, scale: 0.94 });
    MESHES.windows = [];
    for (var wi = 0; wi < CAR_WINDOWS.length; wi++) {
      if (CAR_WINDOWS[wi].source) continue;
      var wm = makeCarWindowMesh(CAR_WINDOWS[wi], MATS.glass, bk);
      if (wm) MESHES.windows.push(wm);
    }
    meshBlenderCourier(bk);
    meshCarShadows();
    MESHES.wall = makeMesh(PILES.wall, MATS.wall, 'nzprops-gardenwall', bk);
    MESHES.brick = makeMesh(PILES.brick, MATS.brick, 'nzprops-brickwall', bk);
    MESHES.conc = makeMesh(PILES.conc, MATS.conc, 'nzprops-concrete', bk);
    MESHES.steel = makeMesh(PILES.steel, MATS.steel, 'nzprops-steel', thin);
    MESHES.bark = makeMesh(PILES.bark, MATS.bark, 'nzprops-bark', thin);
    /* foliage: fewer rays and a higher inter-reflection floor.  A canopy that
       is ray-traced against its own occluder box goes black, and a black
       spruce is a silhouette, not a tree. */
    if (DBG !== 5) MESHES.leaf = makeMesh(PILES.leaf, MATS.leaf, 'nzprops-foliage',
      { rays: Math.min(RAYS, 12), occluders: OCCL, floor: 0.52, scale: 0.96 });
    MESHES.panel = makeMesh(PILES.panel, MATS.panel, 'nzprops-signage',
      { rays: Math.min(RAYS, 10), occluders: occ }, 1);
  }

  /* ---- SHADOWS: WHY THERE IS NO castShadow CALL IN THIS FILE -------------
     Worth writing down, because it looks like an omission.  Every mesh here
     is created with castShadow = false, which is right for mission 1 and
     looks wrong for mission 4 -- but nz-street-sky.js:3262 promoteCasters()
     runs at hook -60, i.e. after this module, and sweeps the scene for every
     mesh that is (a) not already a caster, (b) receiveShadow, (c) named
     'nzday:'.  All ten piles here match, and a probe confirmed it at runtime:

       body=CRV/nzday:props-carpaint  trim=CRV  wall=CRV  brick=CRV
       conc=CRV  steel=CRV  bark=CRV  leaf=CRV  panel=CRV  wire=CRV

     Setting castShadow here would make (a) false and take those meshes OUT of
     the sky module's CASTERS array, which is what its panic() path uses to
     hand every flag back -- so this file deliberately does not touch the flag.
     A/B render (car eye view, castShadow forced true vs left alone) moved
     2005 of 256000 pixels by more than 10, all of it TAA noise: the flag was
     already true both times.

     The parked Courier still lays no shadow on the road, and it is NOT this:
     the same probe read the key light's shadow camera as a 102 x 102 unit
     orthographic box near 1 / far 250 centred on the PLAYER at (113,4,123),
     while the Courier stands at x 656, z 167 -- 540 units outside the map.
     Everything that reads as a shadow on this street is the sky-visibility
     bake, not the shadow map.  Reported to the orchestrator; it is a rig
     fix in nz-render/nz-street-sky, not a prop fix. */

  /* ---- THE SPECULAR FLOOR, AND WHY EVERY FLAT TOP IN THIS FILE WAS BLOWN
     This is the answer to "the up-facing panels read hot", and it is not the
     albedo -- three probes say so, all on _shots/pol/street.south34.png:

       * force every FLEET colour to 0.02        the wedge does not move
       * DUST_AMT 1.0 over a black dust          the wedge moves by 4
       * tint every props material a pure hue    the wedge stays WHITE, on a
                                                 car whose flanks are now red
       * uNzSkP.z = 0 and envMapIntensity = 0    the wedge falls to rgb 1,1,1

     -- i.e. the brightest surfaces in the frame are ~100 % sky SPECULAR and
     carry no albedo at all.  The mechanism is Fresnel, not intensity: a
     camera at eye height looking along a bonnet, a coping or a wall cap sees
     it at 80-88 degrees of incidence, where F goes to 1 and EnvironmentBRDF
     hands over the WHOLE dome radiance on a surface whose diffuse is 0.3.
     Every horizontal in this file is a mirror seen edge-on.

     A WARNING FOR WHOEVER READS THIS NEXT: day()'s documented `spec` option
     (nz-street-sky.js:1300) does NOT reach a material that has the probe.
     dayMaterial() sets __nzSkP.y = 1 whenever probeTex exists, and INJ_LIGHT
     wraps BOTH its irradiance and its radiance replacement in
     `if (uNzSkP.y < 0.5)` -- so __nzSkP.z is compiled past and the material is
     lit by the real PMREM through envMapIntensity instead.  The `spec` values
     declared below are therefore the no-probe fallback only, and measured to
     be worth exactly nothing in the shipped frame (proved: setting them and
     re-rendering moved street.south34 by 0.0).  The lever that WORKS is
     envMapIntensity, and because that scales the probe's diffuse as well, the
     cut has to be handed back as a tone lift -- see PAINT_LIFT in section 10.
     Reported to the orchestrator; SKY owns the fix. */
  function buildMaterials() {
    MATS = {
      body: carPaintMaterial(),
      /* spec was 0.85, which is a specular floor so high that nothing the
         vertex colour does to a pane survives it.  0.60 leaves the glass a
         mirror and lets the DLO's own ramp through. */
      glass: propMaterial('carglass', T_GLASS, { nrm: 0.70, env: 0.72, metal: 0.0, ao: 0.7, spec: 0.60 }),
      trim: propMaterial('trim', T_TRIM, { nrm: 1.00, env: 0.85, metal: 0.0, ao: 1.0, spec: 0.38 }),
      cabin: cabinMaterial(),
      wire: L4 ? wireMaterial() : null,
      bark: propMaterial('bark', T_BARK, { nrm: 1.00, env: 0.80, metal: 0.0, ao: 1.0, spec: 0.26 }),
      wall: propMaterial('wallpaint', T_WALL, { nrm: 1.00, env: 0.86, metal: 0.0, ao: 1.0, spec: 0.16 }),
      /* brick is rougher and matter than render, so it takes less of the
         probe: at env 0.95 the north wall came up a full stop over ref7 */
      brick: propMaterial('gbrick', T_BRICK, { nrm: 1.05, env: 0.80, metal: 0.0, ao: 1.0, spec: 0.28 }),
      conc: propMaterial('gconc', T_CONC, { nrm: 1.00, env: 0.95, metal: 0.0, ao: 1.0, spec: 0.30 }),
      steel: propMaterial('steel', T_STEEL, { nrm: 1.10, env: 1.10, ao: 0.9 }),
      leaf: leafMaterial(),
      panel: panelMaterial()
    };
  }

  function clearMeshes() {
    var i;
    for (i = 0; i < OWN.obj.length; i++) { var o = OWN.obj[i]; if (o && o.parent) o.parent.remove(o); }
    OWN.obj.length = 0;
    for (i = 0; i < OWN.geo.length; i++) { try { OWN.geo[i].dispose(); } catch (e) {} }
    OWN.geo.length = 0;
    STATS.addedCalls = 0; STATS.tris = 0; STATS.verts = 0;
    DIAG.piles.length = 0;
  }

  /* the carve may not be in this build; never assume it is */
  function hasStreet() {
    /* AMENDMENT 2 widened the canyon to cell rows 38..47 (z 152..192) */
    for (var cy = 38; cy <= 47; cy++) for (var cx = 42; cx <= 62; cx++) {
      var R = regionAt(cx, cy);
      if (R && R.sky && openCell(G.cellAt(cx, cy))) return true;
    }
    return false;
  }

  function install(ctx) {
    if (dead || installed) return;
    if (NZ.level !== undefined && NZ.level !== 1 && NZ.level !== 4) {
      NZ.log && NZ.log('street-props: level ' + NZ.level + ', module inert');
      return;
    }
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
    renderer = (ctx && ctx.renderer) || (NZ.ctx && NZ.ctx.renderer);
    if (!THREE || !scene || !renderer) throw new Error('nz-street-props: renderer context missing');
    if (!NZ.tex || !NZ.tex.canvasOf) throw new Error('nz-street-props: NZ.tex unavailable');

    G = bindGame();
    if (!G) { NZ.log && NZ.log('street-props: level globals unavailable, module inert'); return; }
    if (!hasStreet()) { NZ.log && NZ.log('street-props: carve not present, module inert'); return; }
    if (!ST()) warn('NZ.street missing -- running without the daylight probe or the overcast bake');

    L4 = (NZ.level === 4);
    if (L4) sunnyTones();
    applyTier();
    try { ANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } catch (e) { ANISO = 8; }

    T0 = Date.now(); TICKS = 0;
    phase('geometry'); adoptGeometry();
    phase('facades'); adoptFacades();
    phase('occluders'); buildOccluders();
    phase('leaf-atlas'); buildLeafAtlas();
    phase('panel-atlas'); buildPanelAtlas();
    if (DBG >= 2) { phase('materials'); buildMaterials(); }
    if (DBG >= 3) buildAll();
    if (DBG >= 4) { phase('mesh'); meshAll(); }
    phase('done');

    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    STATS.ms = Math.round(t1 - t0);
    installed = true;
    NZ.flags.streetProps = true;
    NZ.streetProps = {
      ok: true, tier: TIER, stats: STATS, diag: DIAG,
      megabytes: +(STATS.texBytes / 1048576).toFixed(2),
      report: report, dispose: function () { panic('manual dispose'); },
      /* the parked fleet, for nz-destruct.js: oriented boxes to catch a ray,
         and the two piles whose triangles a hole should actually hug */
      cars: CARS_BUILT,
      carWindows: CAR_WINDOWS,
      carMeshes: function () {
        return MESHES ? {
          body: MESHES.body || null,
          glass: MESHES.glass || null,
          cabin: MESHES.cabin || null,
          windows: MESHES.windows ? MESHES.windows.slice() : []
        } : null;
      }
    };
    NZ.log && NZ.log('street-props installed: tier=' + TIER + ' cars ' + STATS.cars +
      ' trees ' + STATS.trees + ' cards ' + STATS.cards + ' dishes ' + STATS.dishes +
      ' draws +' + STATS.addedCalls + ' tris ' + STATS.tris + ' in ' + STATS.ms + 'ms');
    if (STATS.illegal) warn(STATS.illegal + ' prop(s) overhang their blocked cell -- see report()');
    /* A MODULE THAT CANNOT SEE THE SCREEN HAS TO PROVE ITSELF IN THE LOG, and
       it has to prove itself EVEN WHEN report() IS BROKEN.  The old version
       wrapped the whole dump in `catch (e2) {}`, so a single bad field in the
       report -- a null island, a stat that had not been initialised -- put the
       module's entire self-report into a black hole and the harness showed
       nothing at all.  The summary is emitted line by line, each one
       independently, and a throw is REPORTED rather than swallowed.

       The one-line headline goes first and separately: the render harness
       keeps only the first 40 console lines of a boot, this module is the
       last of five to fire, and the four before it spend 39 of them. */
    /* `threw:0` is not decoration.  scripts/render-level.mjs only keeps a
       console line when its text matches /error|fail|panic|threw|missing|
       cannot/ (render-level.mjs:575), so a module whose report says nothing
       alarming is invisible to the harness -- which is why this file's
       self-report never once appeared in a --diag run.  GROUND and ENTRANCE
       both carry the same token for the same reason. */
    try {
      console.warn('[nz-props] threw:0 ' + STATS.addedCalls + ' draws, ' + STATS.tris +
        ' tris, ' + STATS.cars + ' cars, ' + STATS.trees + ' trees, ' +
        STATS.props + ' props, ' + STATS.illegal + ' illegal, ' +
        DIAG.warnings.length + ' warnings, ' + STATS.ms + 'ms');
      if (DIAG.warnings.length)
        console.warn('[nz-props] threw:0 W: ' + DIAG.warnings.join(' | ').slice(0, 320));
      if (DIAG.legal.length)
        console.warn('[nz-props] threw:0 L: ' + DIAG.legal.join(' | ').slice(0, 320));
    } catch (e0) {}
    if (NZ.debug) {
      var RL = null;
      try { RL = report().split('\n'); }
      catch (e2) { try { console.warn('[nz-props] report() threw: ' + (e2 && e2.message)); } catch (e3) {} }
      if (RL) for (var ri = 0; ri < RL.length; ri++) {
        try { console.warn('[nz-props] threw:0 ' + RL[ri]); } catch (e4) {}
      }
    }
    if (DIAGON) installOverlay();
  }

  /* ---- teardown ---------------------------------------------------------- */
  function panic(err) {
    if (dead) return;
    dead = true;
    NZ.flags.streetProps = false;
    if (NZ.streetProps) NZ.streetProps.ok = false;
    if (err) { try { console.error('[nz-street-props] disabled after error (phase "' + PHASE + '"):', err); } catch (e) {} }
    try {
      var i;
      if (OWN.timer) { try { global.clearInterval(OWN.timer); } catch (e0) {} OWN.timer = 0; }
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      for (i = 0; i < OWN.obj.length; i++) { var o = OWN.obj[i]; if (o && o.parent) o.parent.remove(o); }
      OWN.obj.length = 0;
      for (i = 0; i < OWN.geo.length; i++) { try { OWN.geo[i].dispose(); } catch (e1) {} }
      OWN.geo.length = 0;
      for (i = 0; i < OWN.mat.length; i++) { try { OWN.mat[i].dispose(); } catch (e2) {} }
      OWN.mat.length = 0;
      for (i = 0; i < OWN.tex.length; i++) { try { OWN.tex[i].dispose(); } catch (e3) {} }
      OWN.tex.length = 0;
      SETS = Object.create(null); NOISE = Object.create(null);
      LATTICE = Object.create(null); AXIS = Object.create(null);
      PILES = null; MESHES = null; MATS = null;
      LEAF.tex = null; PANEL.tex = null;
      SELF_OCC.length = 0; OCCL.length = 0;
      installed = false;
    } catch (e4) { try { console.error('[nz-street-props] teardown failed:', e4); } catch (e5) {} }
  }

  /* ---- self-report ------------------------------------------------------- */
  function pad(s2, n) { s2 = String(s2); while (s2.length < n) s2 += ' '; return s2; }
  function report() {
    var L = [], i;
    L.push('NZ-STREET-PROPS tier=' + TIER + ' install=' + STATS.ms + 'ms vram~' +
      (STATS.texBytes / 1048576).toFixed(1) + 'MB');
    for (i = 0; i < DIAG.sets.length; i++) {
      var b = DIAG.sets[i];
      L.push('  set ' + pad(b.name, 10) + b.res + 'px rgb ' + b.rgb.join(',') +
        ' lum ' + pad(b.lum.toFixed(0), 4) + ' tile ' + pad(b.refTile, 5) +
        ' relief ' + b.reliefMM + 'mm (swing ' + b.swingMM + 'mm)' + (b.black ? '  <<< BLACK' : ''));
    }
    for (i = 0; i < DIAG.piles.length; i++) {
      var p = DIAG.piles[i];
      L.push('  pile ' + pad(p.name, 24) + ' tris ' + pad(String(p.tris), 7) +
        ' verts ' + pad(String(p.verts), 7) + (p.added ? '' : ' (EMPTY - not added)'));
    }
    L.push('  cars ' + STATS.cars + '  trees ' + STATS.trees + '  dishes ' + STATS.dishes +
      '  wires ' + STATS.wires + '  cards ' + STATS.cards + '  props ' + STATS.props +
      '  cards re-wound ' + STATS.flipped);
    L.push('  S_BLOCK runs ' + STATS.bays + ' = bays ' +
      (STATS.bays - STATS.pits - STATS.islandCells) + ' + pits ' + STATS.pits +
      ' + island ' + STATS.islandCells +
      (ISLE ? ('  island plant ' + ISLE.plant.x.toFixed(2) + ',' + ISLE.plant.z.toFixed(2) +
               ' soil ' + fin(ISLE.soilY, Y_ISLS).toFixed(3) +
               (ISLE.synthetic ? ' (SYNTHETIC -- GROUND did not publish one)' : '')) : '  NO ISLAND'));
    L.push('  draws +' + STATS.addedCalls + '  tris ' + STATS.tris + '  verts ' + STATS.verts +
      '  clearanceClamps ' + STATS.clearanceClamps + '  illegal ' + STATS.illegal);
    for (i = 0; i < DIAG.legal.length; i++) L.push('  ! ' + DIAG.legal[i]);
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
      overlay.id = 'nzprops-diag';
      overlay.style.cssText = 'position:fixed;left:0;top:0;max-height:52vh;max-width:min(760px,46vw);' +
        'overflow:auto;z-index:99995;background:rgba(6,8,10,.92);color:#a8d0a0;' +
        'font:11px/1.35 Consolas,monospace;padding:6px 8px;white-space:pre;' +
        'border-bottom:2px solid #4f8d5a;border-right:2px solid #4f8d5a;pointer-events:none';
      overlay.textContent = report();
      document.body.appendChild(overlay);
    } catch (e) { /* diagnostics must never break the game */ }
  }

  /* ---- hooks -------------------------------------------------------------
     NO PRIORITY ARGUMENT.  nz-core.js:43 sorts (a,b) => b.p - a.p, i.e.
     DESCENDING, so the negative priorities in STREET-MODULE-CONTRACT section
     2 would have run the five street modules backwards.  Every module
     registers at the default p = 0 and relies on Array.prototype.sort being
     stable, which makes the firing order identical to the script-tag order:
     nz-render, nz-env, sky, ground, facade, entrance, PROPS.  This module is
     last of the five, which is exactly what it needs: NZ.street.facades and
     NZ.streetGround.crossovers are both already filled in. */
  if (DISABLED) {
    NZ.log && NZ.log('street-props disabled by query string (?nzprops=0)');
  } else {
    NZ.on('ready', function (ctx) {
      if (dead) return;
      try { install(ctx); }
      catch (err) { panic(err); }
    });
  }

  NZ.log && NZ.log('street-props module loaded');
})(typeof window !== 'undefined' ? window : this);
