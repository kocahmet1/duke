/* ===========================================================================
   NZ-ENV  --  environment art pass for NUKE ZONE 3D.

   The level in NUKEM.html is a Build-engine style blockout: one merged mesh
   per texture name, a 256px canvas painting on each, vertex-baked point
   lighting, and pure 90 degree edges everywhere. This module takes it to a
   CS2-grade read WITHOUT touching NUKEM.html: it installs on the 'ready'
   hook, walks NZ.ctx.scene and upgrades what it finds in place.

     1. MATERIAL LIBRARY   13 lazily-baked procedural PBR sets. Each emits
                           albedo + normal + a single packed ORM texture
                           (R=AO, G=roughness, B=metalness -- the glTF
                           convention three.js r149 already reads natively),
                           so a full PBR surface costs 3 textures, not 5.
                           Sets are shared between surfaces that are really
                           the same material with a different tint or tiling
                           (poured concrete serves walls AND soffits, painted
                           steel serves plating, doors and light housings).

     2. TEXEL DENSITY      every UV on the level is thrown away and rebuilt
                           from world space: a planar projection on the face's
                           dominant axis divided by a per-material tile size
                           in world units. Adjacent surfaces therefore cannot
                           disagree about scale, which is the single loudest
                           amateur tell in a blockout.

     3. SURFACE STORY      one shared onBeforeCompile injection gives every
                           surface: macro-scale albedo + roughness variation
                           (kills the tiling read), grime that accumulates at
                           the floor line and under the ceiling measured
                           against the room's REAL floor/ceiling height fed in
                           as a vertex attribute, and a wetness term for the
                           flooded service tunnels and the rained-on street.
                           Clean vs dirty vs wet vs polished inside one
                           material is what roughness is FOR.

     4. VERTEX AO          contact darkening baked into the existing vertex
                           colours from grid solidity: floors get darker where
                           they meet a wall, walls get darker in inside
                           corners. Plus a per-cell tone jitter.

     5. TRIM + PROPS       skirting, cornice, chair rail, door frames with
                           reveals, pipe runs, conduit, vents, junction boxes,
                           barrels, pallets and debris -- every one chamfered,
                           every one merged into a handful of piles so the
                           whole pass costs ~8 draw calls and REMOVES 22
                           (the crates become one mesh).

     6. FIXTURES           every point light in LIGHTS that sits inside a real
                           room gets a visible housing: ceiling pan, pendant,
                           or an exterior bracket lamp. An unmotivated light
                           is a realism failure.

     7. DECALS             a 16-tile atlas of streaks, stains, scuffs, cracks,
                           stencils, graffiti and floor drains, placed where
                           water runs and where people touch.

   Collision safety: the game's collision is grid-based and knows nothing
   about anything added here, so nothing added here may sit where the CAMERA
   can go. The player's collision radius is PRAD, so a legal camera position
   is always >= PRAD from a wall plane; every prop in this file therefore
   hugs a wall within (PRAD - 0.15) units, or sits above the jump apex, or
   stands on an already-solid crate cell. See hug() and jumpTop() and the
   notes on each emitter.

   Zero external assets. Classic script. three.js r149 core UMD surface only.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.env === undefined) NZ.flags.env = false;

  /* opt-out / force a tier: ?nzenv=0 | low | med | high */
  var QS = /[?&]nzenv=(0|off|low|med|high)/i.exec(
    global.location ? global.location.search : '') || null;
  if (QS && /^(0|off)$/i.test(QS[1])) { NZ.log && NZ.log('env disabled by query string'); return; }

  var THREE = null, scene = null, renderer = null;
  var dead = false, installed = false;

  /* everything this module owns, so panic() can put the level back */
  var OWN = {
    tex: [],        /* textures we baked            */
    mat: [],        /* materials we created         */
    geo: [],        /* geometries we created        */
    obj: [],        /* objects we added to scene    */
    restore: [],    /* {mesh, material, geometry, uv, uv2, color} snapshots,
                       or {readd, parent} for meshes we pulled out of the scene */
    timer: 0        /* the ?nzdiag=1 overlay refresh interval                  */
  };

  var STATS = { sets: 0, texBytes: 0, meshes: 0, props: 0, decals: 0, fixtures: 0, runs: 0, addedCalls: 0, removedCalls: 0, ms: 0 };

  /* Runtime self-report. This module cannot see the screen, so every claim it
     makes has to be measurable from inside the running page: which mesh got
     which material set, whether the shader detail layer actually compiled or
     silently fell back, whether a baked albedo came out black. Surfaced by
     NZ.env.report() and, with ?nzdiag=1, as an on-screen panel. */
  var DIAG = {
    sets: [],          /* {name, res, meanRGB, lum, sat, black} per baked set   */
    surfaces: [],      /* {mesh, key, set, tris, tile} per upgraded world mesh  */
    skipped: [],       /* world meshes we deliberately left alone               */
    piles: [],         /* {name, verts, tris} per merged detail mesh            */
    glslProbe: null,   /* true = injection compiles standalone on this GL       */
    patchCalls: 0,     /* how many times onBeforeCompile actually ran           */
    anchorsOK: 0,      /* ...and found every #include anchor it needs           */
    anchorsBad: 0,
    chained: 0,        /* ...and successfully chained nz-render's own patch     */
    chainErr: null,
    detailOK: 0,       /* materials that got the detail-normal substitution      */
    detailMiss: 0,
    warnings: []
  };
  function warn(msg) {
    DIAG.warnings.push(msg);
    console.warn('[nz-env] ' + msg);
  }

  /* ======================================================================
     0. small math / helpers
     =================================================================== */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }

  /* NUKEM.html declares its level state with top-level const/let, which live
     in the global LEXICAL environment: visible as bare identifiers from this
     file, but NOT properties of window, and a ReferenceError if read too
     early. Same thunk idiom nz-audio.js uses. Nothing below is named after a
     game global, so no shadowing can silently break a lookup. */
  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }
  var G = null;
  function bindGame() {
    var g = {
      MW: fin(tryGet(function () { return MW; }), 0),
      MH: fin(tryGet(function () { return MH; }), 0),
      CELL: fin(tryGet(function () { return CELL; }), 4),
      PRAD: fin(tryGet(function () { return PRAD; }), 1.15),
      EYE: fin(tryGet(function () { return EYE; }), 2.85),
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
      LIFTS: tryGet(function () { return LIFTS; }) || null,
      CRATES: tryGet(function () { return CRATES; }) || null
    };
    if (!g.MW || !g.MH || !g.cellAt || !g.regAt || !g.inb || !g.isWallCell) return null;
    return g;
  }

  function cellOf(wx, wz) { return [Math.floor(wx / G.CELL), Math.floor(wz / G.CELL)]; }
  function regionAt(cx, cy) {
    if (!G.inb(cx, cy)) return null;
    var r = G.regAt(cx, cy);
    return r || null;
  }
  function openCell(t) { return t !== G.S_SOLID && t !== G.S_EXIT; }
  function solidCell(cx, cy) { return !G.inb(cx, cy) || G.isWallCell(cx, cy); }
  function liftCell(cx, cy) {
    if (!G.liftOf || !G.inb(cx, cy)) return false;
    return G.liftOf[cy * G.MW + cx] >= 0;
  }

  /* ---- baked point light sampling, exactly the game's own function -------
     lightAt() walks all 94 lights and raycasts the grid for each, so calling
     it once per emitted polygon (~40k) is minutes of work. Quantising the
     sample to 0.7 units and six normal buckets collapses a whole chamfered
     prop to a handful of real evaluations without any visible banding: the
     result is a vertex colour on geometry that is centimetres across. */
  var AMB_FALLBACK = [0.11, 0.11, 0.13];
  var _col = [0, 0, 0];
  var LITC = null, LITHITS = 0, LITMISS = 0;

  /* The baked point lights are warm enough that a neutral grey concrete comes
     out of them at HSV saturation 0.4. The shader does the main chroma pull
     (uNzC.y), but it only exists if the GLSL probe passed, and a fallback that
     leaves the level salmon-pink is not a fallback. So the vertex colours get
     a share of the pull too: a small one when the shader is live, the whole
     job when it is not. Set once in install(), before any vertex is emitted. */
  var VDESAT = 0.15;
  function desatRGB(c) {
    if (VDESAT <= 0) return c;
    var L = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    c[0] += (L - c[0]) * VDESAT;
    c[1] += (L - c[1]) * VDESAT;
    c[2] += (L - c[2]) * VDESAT;
    return c;
  }
  function litAt(x, y, z, nx, ny, nz, amb) {
    if (!G.lightAt) { _col[0] = 0.55; _col[1] = 0.55; _col[2] = 0.58; return _col; }
    if (!LITC) LITC = new Map();
    var q = 1 / 0.7;
    var nb = (Math.abs(nx) > Math.abs(ny) && Math.abs(nx) > Math.abs(nz)) ? (nx > 0 ? 0 : 1)
           : (Math.abs(ny) >= Math.abs(nz) ? (ny > 0 ? 2 : 3) : (nz > 0 ? 4 : 5));
    /* plain integer key, no bit packing: the level is 256x192 units and 60
       tall, so these products stay far inside the safe-integer range */
    var key = ((((Math.round(x * q) + 64) * 1024 + (Math.round(z * q) + 64)) * 512) +
               (Math.round(y * q) + 64)) * 8 + nb;
    var hit = LITC.get(key);
    if (hit !== undefined) { LITHITS++; _col[0] = hit[0]; _col[1] = hit[1]; _col[2] = hit[2]; return _col; }
    LITMISS++;
    var c;
    try { c = G.lightAt(x, y, z, nx, ny, nz, amb || AMB_FALLBACK, false, true); }
    catch (e) { _col[0] = _col[1] = _col[2] = 0.5; return _col; }
    _col[0] = fin(c[0], .4); _col[1] = fin(c[1], .4); _col[2] = fin(c[2], .4);
    desatRGB(_col);
    LITC.set(key, [_col[0], _col[1], _col[2]]);
    return _col;
  }

  /* ======================================================================
     1. quality tier
     =================================================================== */
  var TIER = 'high';
  var RES = { hi: 512, md: 256 };
  var DENSITY = 1.0;          /* prop + decal density multiplier */

  function pickTier() {
    if (QS) return QS[1].toLowerCase();
    var q = (NZ.render && NZ.render.quality) || null;
    if (q === 'high' || q === 'med' || q === 'low') return q;
    /* nz-render is absent or failed: probe the device ourselves */
    var nav = global.navigator || {};
    var cores = fin(nav.hardwareConcurrency, 4);
    var mem = fin(nav.deviceMemory, 0);
    var maxTex = 4096;
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

  /* ======================================================================
     2. scalar field toolkit  (all fields are tileable, res x res, 0..1)

     NZ.tex ships fbm / worley / normalFromHeight and they are correct, but
     they are also per-pixel-closure implementations: one 512 fbm costs ~700ms
     and a 13-set library would freeze the tab for 22 seconds. These are the
     same algorithms (same tiling lattice, same F1 worley, same Sobel) with
     the per-pixel modulo and function-call work hoisted into precomputed
     index tables, and the octave lattice capped at the output resolution.
     Roughly 25x faster, bit-for-bit equivalent output shape.
     =================================================================== */
  var NOISE = Object.create(null);

  var LATTICE = Object.create(null);
  function latticeOf(size, seed) {
    var k = size + ':' + seed;
    if (LATTICE[k]) return LATTICE[k];
    var rnd = NZ.tex.mulberry32(seed >>> 0), g = new Float32Array(size * size), i;
    for (i = 0; i < g.length; i++) g[i] = rnd();
    return (LATTICE[k] = g);
  }
  /* smoothstep-interpolated axis tables: index pair + weight for every pixel */
  var AXIS = Object.create(null);
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
    var gain = o.gain === undefined ? .5 : o.gain, lac = o.lacunarity || 2;
    var seed = o.seed === undefined ? 1337 : o.seed;
    var out = new Float32Array(res * res);
    var amp = 1, total = 0, oi, x, y, i;
    /* Nyquist cap: a lattice finer than one cell per two texels is pixel
       noise that the mip chain throws away, and generating it costs more
       than sampling every other octave put together. Clamp and stop. */
    var CAP = res >> 1;
    for (oi = 0; oi < octaves; oi++) {
      var capped = Math.round(freq) >= CAP;
      var size = Math.max(2, Math.min(CAP, Math.round(freq)));
      var g = latticeOf(size, seed * 131 + oi * 7919 + 17);
      var T = axisTable(res, size);
      var i0 = T.i0, i1 = T.i1, w = T.w;
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
    var inv = 1 / total;
    if (o.ridged) { for (i = 0; i < out.length; i++) out[i] = 1 - Math.abs(out[i] * inv * 2 - 1); }
    else { for (i = 0; i < out.length; i++) out[i] *= inv; }
    return out;
  }

  function worleyRaw(res, cells, seed, invert) {
    var rnd = NZ.tex.mulberry32(seed >>> 0);
    var pts = new Float32Array(cells * cells * 2), i;
    for (i = 0; i < cells * cells; i++) {
      var cx0 = i % cells, cy0 = (i - cx0) / cells;
      pts[i * 2] = (cx0 + rnd()) / cells;
      pts[i * 2 + 1] = (cy0 + rnd()) / cells;
    }
    var out = new Float32Array(res * res);
    var per = res / cells;
    var np = new Float32Array(18);
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
            var dx = np[k] - x, dy = np[k + 1] - y;
            var d2 = dx * dx + dy * dy;
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

  /* Sobel on a tiling height field -> RGBA tangent-space normal */
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
        var nx = -gx * s, ny = -gy * s, nz = 1;
        var len = Math.sqrt(nx * nx + ny * ny + 1) || 1;
        var o = (r0 + x) * 4;
        out[o] = (nx / len * .5 + .5) * 255;
        out[o + 1] = (ny / len * .5 + .5) * 255;
        out[o + 2] = (nz / len * .5 + .5) * 255;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  function fbmC(res, o) {
    var k = 'f' + res + '|' + (o.octaves || 5) + '|' + (o.frequency || 4) + '|' +
            (o.seed || 0) + '|' + (o.gain === undefined ? .5 : o.gain) + '|' + (o.ridged ? 1 : 0);
    return NOISE[k] || (NOISE[k] = fbmRaw(res, o));
  }
  function worC(res, o) {
    var k = 'w' + res + '|' + (o.cells || 8) + '|' + (o.seed || 0) + '|' + (o.invert ? 1 : 0);
    return NOISE[k] || (NOISE[k] = worleyRaw(res, o.cells || 8, o.seed || 99, !!o.invert));
  }
  function fnew(res) { return new Float32Array(res * res); }
  function fcopy(a) { return new Float32Array(a); }

  /* separable box blur with wrap; O(n) per axis, unlike the O(n*r^2) blur in
     NZ.tex.bake -- at 512 that difference is the whole load-time budget */
  function blurAxis(src, res, r, vertical) {
    /* r MUST be an integer. `for (i = -r; i <= r; i++)` with r = 11.63 walks
       fractional indices, src[11.63] is undefined, the accumulator goes NaN and
       the whole field -- and every albedo built from it -- bakes to pure black.
       That is exactly what happened to plywood (res/22) and ceiltile (res/20):
       the 22 crates and every ceiling in the level rendered as solid black
       boxes. Round first, always. */
    r = Math.round(fin(r, 1));
    if (r < 1) return fcopy(src);
    if (r > (res >> 1) - 1) r = (res >> 1) - 1;
    var out = new Float32Array(res * res), inv = 1 / (2 * r + 1), x, y, i, s;
    /* precomputed wrap tables kill the four modulos that were in this loop */
    var sub = new Int32Array(res), add = new Int32Array(res);
    for (x = 0; x < res; x++) {
      /* moving the window from x to x+1 drops (x-r) and gains (x+1+r) */
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

  /* cavity AO from a height field: what is below its own local average is
     occluded. Two radii so both mortar joints and broad dents read. */
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

  /* --- pattern fields ---------------------------------------------------- */
  /* running bond masonry. m: 1 inside a unit, 0 in the joint. id: per-unit
     random, which is what lets each brick take its own colour. */
  function fieldBond(res, rows, cols, joint, seed, stagger) {
    var m = fnew(res), id = fnew(res), rnd = NZ.tex.mulberry32(seed);
    var rid = new Float32Array(rows * cols);
    for (var i = 0; i < rid.length; i++) rid[i] = rnd();
    var rh = res / rows, cw = res / cols, x, y;
    for (y = 0; y < res; y++) {
      var r = Math.floor(y / rh) % rows;
      var off = (stagger && (r & 1)) ? cw * 0.5 : 0;
      var ly = y - Math.floor(y / rh) * rh;
      for (x = 0; x < res; x++) {
        var fx = (((x - off) % res) + res) % res;
        var cc = Math.floor(fx / cw) % cols;
        var lx = fx - Math.floor(fx / cw) * cw;
        var d = Math.min(ly, rh - ly, lx, cw - lx);
        var k = y * res + x;
        m[k] = d < joint ? clamp(d / joint, 0, 1) : 1;
        id[k] = rid[r * cols + cc];
      }
    }
    return { m: m, id: id };
  }
  /* one-directional planks / bearing bars */
  function fieldPlank(res, n, joint, seed, vertical) {
    return fieldBond(res, vertical ? 1 : n, vertical ? n : 1, joint, seed, false);
  }
  /* anisotropic streaking: noise smeared along one axis, the shape every
     run-off stain on a real wall has */
  function fieldStreak(res, seed, freq, smear, vertical) {
    var n = fbmC(res, { octaves: 4, frequency: freq, seed: seed });
    return blurAxis(n, res, Math.max(1, Math.round(res / smear)), !vertical ? false : true);
  }

  /* --- albedo buffer ----------------------------------------------------- */
  function albNew(res, col) {
    var a = new Float32Array(res * res * 3);
    for (var i = 0; i < a.length; i += 3) { a[i] = col[0]; a[i + 1] = col[1]; a[i + 2] = col[2]; }
    return a;
  }
  /* multiply by a field remapped from [lo,hi] -> [mLo,mHi] */
  function albMul(a, f, lo, hi, mLo, mHi) {
    for (var i = 0, j = 0; i < f.length; i++, j += 3) {
      var t = clamp((f[i] - lo) / (hi - lo || 1e-6), 0, 1);
      var m = mLo + (mHi - mLo) * t;
      a[j] *= m; a[j + 1] *= m; a[j + 2] *= m;
    }
  }
  /* lerp toward a colour by field*amount */
  function albTint(a, f, col, amt, lo, hi) {
    for (var i = 0, j = 0; i < f.length; i++, j += 3) {
      var t = clamp((f[i] - lo) / (hi - lo || 1e-6), 0, 1) * amt;
      if (t <= 0) continue;
      a[j] += (col[0] - a[j]) * t;
      a[j + 1] += (col[1] - a[j + 1]) * t;
      a[j + 2] += (col[2] - a[j + 2]) * t;
    }
  }
  function albToCanvas(a, res) {
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    var id = g.createImageData(res, res), d = id.data;
    for (var i = 0, j = 0; i < a.length; i += 3, j += 4) {
      d[j] = clamp(a[i], 0, 255); d[j + 1] = clamp(a[i + 1], 0, 255); d[j + 2] = clamp(a[i + 2], 0, 255); d[j + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  /* ======================================================================
     3. texture emission
     =================================================================== */
  var ANISO = 8;
  function texCanvas(c, srgb) {
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = ANISO;
    if (srgb) { if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding; }
    OWN.tex.push(t);
    STATS.texBytes += c.width * c.height * 4 * 1.34;
    return t;
  }
  /* R = ambient occlusion, G = roughness, B = metalness. three r149 reads
     exactly these channels for aoMap / roughnessMap / metalnessMap, so one
     RGBA upload replaces three. */
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

  /* ------------------------------------------------------------------------
     RELIEF SCALE -- the bug this module actually had.

     A tangent-space normal baked by Sobel from a 0..1 height field encodes a
     SLOPE, not a height:  nx/nz = 4 * s * dh/d(texel).  Convert the texel to
     world units and the physical relief the map claims is

         A  =  4 * s * tile / res     (world units for a full 0->1 swing)

     -- proportional to the TILE SIZE and completely independent of the raster
     resolution. The old code picked `s` as a bare artistic number and then
     multiplied it by res/256 to hold the *texture-space* slope constant across
     quality tiers, which is exactly the wrong invariant: it pins the one
     quantity nobody looks at and lets the one that matters float with tile.

     Measured on the shipped build, with 1 unit = 0.6 m:

         concrete  s 4.40  tile 8.0   ->  165 mm per swing,  114 mm peak-to-trough
         asphalt   s 5.20  tile 10.0  ->  244 mm            ,  173 mm
         precast   s 2.00  tile 6.0   ->  112 mm            ,   88 mm
         brick     s 4.80  tile 3.6   ->   81 mm            ,   61 mm
         plaster   s 3.20  tile 6.0   ->   90 mm            ,   33 mm

     Eleven centimetres of relief on a corridor wall. That is not a normal map,
     that is a rock face, and it is exactly the "melted rock / cottage cheese"
     in the review frame. The floor was worse.

     So relief is authored where it belongs now: in MILLIMETRES of real surface,
     as an RMS figure. emitSet measures the field it was handed and solves for
     s, so the millimetre number is honoured whatever amplitude the author's
     expression happened to have and whatever tier the raster is baked at:

         s = (rmsMM / 1000 / 0.6) / sd(h) * res / (4 * tile)

     Real construction, for reference: rolled emulsion on plaster is 0.2-0.4 mm
     RMS, a fair-faced concrete pour 1-2 mm, brickwork 2-3 mm and essentially
     all of that lives in the raked joint, bar grating 5 mm. Nothing on a
     building is a centimetre deep except a joint, and a joint is a thin line,
     not a blob.

     HIGH PASS. Amplitude alone was only half of it. The same measurement
     showed most of the height energy sitting at 300-1200 mm wavelength -- the
     blob scale. A real wall is FLAT at that scale; the low-frequency part of
     these fields is paint (pour colour, staining, damp patches), not geometry.
     `hp` subtracts a wide box blur before differentiating, so the albedo and
     the cavity AO keep the whole broad story and only the normal is restricted
     to the frequencies that are genuinely relief. Thin features -- form-board
     seams, mortar joints, cracks -- are high-frequency by construction and
     survive the filter untouched; it is only the meandering fbm swell that
     dies, which is the entire point.

     ROUGHNESS COUPLING. Crowns caught a uniform blown specular because
     roughness knew nothing about the height field. `rough` here nudges
     roughness with the same high-passed field, so raised, rain-washed,
     abraded crowns read chalkier than the sheltered pits. Decorrelating the
     specular from the relief is what stops a surface glittering. */
  var METRES_PER_UNIT = 0.6;      /* EYE 2.85 units reads as a 1.71 m eye line */

  function emitSet(res, alb, height, rough, metal, aoStrength, relief, name) {
    if (name === undefined) name = CURSET;
    /* --- albedo sanity gate ------------------------------------------------
       A single NaN anywhere in a field propagates through albMul/albTint into
       every texel, and Uint8ClampedArray turns NaN into 0 -- a silently pure
       black texture with no error anywhere. Catch it here, repair it, and say
       so loudly, because from a screenshot it looks like a lighting bug and
       costs a whole review round. Also grade the finished albedo: too dark or
       too saturated is a CS2 failure even when it is not a crash. */
    var q, bad = 0, sum = 0, sumR = 0, sumG = 0, sumB = 0, sumS = 0, np = 0;
    for (q = 0; q < alb.length; q += 3) {
      if (!(alb[q] >= 0) || !(alb[q + 1] >= 0) || !(alb[q + 2] >= 0)) {
        bad++; alb[q] = 128; alb[q + 1] = 126; alb[q + 2] = 120;
      }
      var rr = alb[q] < 0 ? 0 : alb[q] > 255 ? 255 : alb[q];
      var gg = alb[q + 1] < 0 ? 0 : alb[q + 1] > 255 ? 255 : alb[q + 1];
      var bb = alb[q + 2] < 0 ? 0 : alb[q + 2] > 255 ? 255 : alb[q + 2];
      sumR += rr; sumG += gg; sumB += bb;
      var mx = Math.max(rr, gg, bb), mnv = Math.min(rr, gg, bb);
      sumS += mx > 0 ? (mx - mnv) / mx : 0;
      np++;
    }
    if (bad) warn('albedo set "' + (name || '?') + '" had ' + bad +
      ' non-finite texels (would have baked BLACK); substituted neutral grey');

    /* cavity AO keeps the FULL field: broad soft occlusion in the hollows is
       honest even where the corresponding relief is not worth a normal */
    var ao = cavityAO(height, res, aoStrength === undefined ? 1 : aoStrength);

    /* ---- relief solve, see the note above -------------------------------- */
    if (typeof relief === 'number') relief = { mm: 1.2, tile: 4.0 };   /* legacy call */
    relief = relief || {};
    var refTile = relief.tile > 0 ? relief.tile : 4.0;
    var rmsMM = relief.mm > 0 ? relief.mm : 1.0;
    var hpMM = relief.hp > 0 ? relief.hp : 0;
    var rCouple = relief.rough === undefined ? 0.16 : relief.rough;
    var mmPerTexel = refTile * METRES_PER_UNIT * 1000 / res;

    var hn = height, i;
    if (hpMM > 0) {
      /* box radius of half the cutoff wavelength: content broader than hpMM
         is inside the blur and cancels, content finer than it passes */
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
    if (!(hSD > 1e-5)) hSD = 1e-5;                 /* a flat field asks for no normal */

    /* world units of displacement a full 0->1 height swing now stands for */
    var reliefA = (rmsMM / 1000 / METRES_PER_UNIT) / hSD;
    var sobelS = reliefA * res / (4 * refTile);
    if (!isFinite(sobelS) || sobelS < 0) sobelS = 0;

    /* crowns chalkier than pits, using the very field the normal came from */
    if (rCouple > 0) {
      var invSD = 1 / (hSD * 2.5);
      for (i = 0; i < rough.length && i < hn.length; i++)
        rough[i] = clamp(rough[i] + clamp((hn[i] - hMean) * invSD, -1, 1) * rCouple, 0.03, 1);
    }

    var set = {
      res: res,
      refTile: refTile,
      reliefMM: rmsMM,
      hpMM: hpMM,
      sobelS: sobelS,
      map: texCanvas(albToCanvas(alb, res), true),
      normalMap: NZ.tex.texFromData(THREE, normalRaw(hn, res, sobelS), res, false),
      ormMap: packORM(ao, rough, metal, res)
    };
    set.normalMap.anisotropy = ANISO;
    OWN.tex.push(set.normalMap);
    STATS.texBytes += res * res * 4 * 1.34;
    /* Mean and standard deviation of the albedo's LINEAR green. Reported by
       NZ.env.report() as the grading of each set, and kept as uNzB.w. It used
       to drive the macro layer's re-centring; that layer now runs on real
       world-space noise instead, because a procedural albedo has almost no
       low-frequency content to re-centre -- measured on a rendered 48-unit
       wall the old albedo-tap macro moved the surface by +-3%, which is
       nothing. See INJ_MAP. */
    var n = 0, sum2 = 0;
    for (q = 1; q < alb.length; q += 3 * 7) {               /* every 7th texel */
      var v = clamp(alb[q], 0, 255) / 255;
      v = v * v * (0.8 + 0.2 * v);                          /* cheap sRGB->linear */
      sum += v; sum2 += v * v; n++;
    }
    set.mean = n ? sum / n : 0.2;
    if (!isFinite(set.mean) || set.mean <= 0) set.mean = 0.2;   /* NaN here = NaN macro = black */
    var sd = n ? Math.sqrt(Math.max(0, sum2 / n - set.mean * set.mean)) : 0.03;
    set.sd = isFinite(sd) ? sd : 0.03;
    var mR = sumR / np, mG = sumG / np, mB = sumB / np;
    set.lum = (mR * 0.299 + mG * 0.587 + mB * 0.114);
    set.sat = sumS / np;
    DIAG.sets.push({
      name: name || '?', res: res,
      rgb: [Math.round(mR), Math.round(mG), Math.round(mB)],
      lum: +set.lum.toFixed(1), sat: +set.sat.toFixed(3),
      mean: +set.mean.toFixed(3), black: set.lum < 6,
      /* relief is a claim about the real world, so it is reported in the
         units of the real world and can be checked from inside the page */
      reliefMM: rmsMM, hpMM: hpMM, refTile: refTile,
      sobelS: +sobelS.toFixed(3),
      swingMM: +(reliefA * METRES_PER_UNIT * 1000).toFixed(1)
    });
    if (reliefA * METRES_PER_UNIT * 1000 > 120)
      warn('set "' + (name || '?') + '" implies ' + (reliefA * METRES_PER_UNIT * 1000).toFixed(0) +
        ' mm of relief per height swing -- that is a rock face, not a wall');
    if (set.lum < 6) warn('baked set "' + (name || '?') + '" is BLACK (mean luminance ' + set.lum.toFixed(1) + ')');
    STATS.sets++;
    return set;
  }

  /* ======================================================================
     4. THE MATERIAL LIBRARY
     Every builder returns {map, normalMap, ormMap}. Built lazily: a set that
     no surface in the level asks for is never baked, so the VRAM bill is
     exactly what is on screen.
     =================================================================== */
  var SETS = Object.create(null);
  var BUILD = Object.create(null);

  /* the set currently being baked, so emitSet can name itself in the report
     without threading an argument through all fourteen builders */
  var CURSET = '?';
  function getSet(name) {
    if (SETS[name]) return SETS[name];
    var b = BUILD[name];
    if (!b) return null;
    var prev = CURSET; CURSET = name;
    try { SETS[name] = b(); }
    finally { CURSET = prev; }
    return SETS[name];
  }

  /* ---- poured concrete -------------------------------------------------- */
  /* Form-board seams, tie-hole dimples with rust bleed, patch repairs that
     are smoother than the parent pour (the roughness break is what sells it),
     aggregate pop-out and hairline cracks. */
  BUILD.concrete = function () {
    var res = RES.hi, i;
    var grain = fbmC(res, { octaves: 6, frequency: 8, seed: 11, gain: .52 });
    var agg = worC(res, { cells: 26, seed: 12, invert: true });
    var patch = worC(res, { cells: 5, seed: 13 });
    /* Hairline. A ridged fbm at frequency 9 puts its contour loops ~0.9 world
       units apart, which on a 4.8 m concrete pour is a 55 cm wide "crack" --
       in the shipped frame the walls read as a doodle of dark scribbled loops
       and it was the single loudest material tell on screen. Real cracking is
       fine, sparse and low contrast; it belongs in the normal map far more
       than in the albedo. */
    var crack = fbmC(res, { octaves: 4, frequency: 26, seed: 14, ridged: true });
    var seams = fieldPlank(res, 2, Math.max(2, res / 90), 15, false).m;   /* horizontal form joints */
    var vseam = fieldPlank(res, 2, Math.max(2, res / 120), 16, true).m;
    var streak = fieldStreak(res, 17, 7, 14, true);

    /* Same hairline discipline as asphalt, and it took two passes. At the
       shipped 0.90 / depth 0.34 the crest network was a dark tendril lattice
       on every wall in the level -- readable as a texture at 2 m and, once
       cavityAO() bottomed out inside it, as a second darker lattice on top of
       that. Measured off a close-up of a real alley wall in the running game,
       0.93 / 0.22 still left 10.3% of the panel below (mean - 1.2 sd) at half
       the panel's luma. A concrete wall is not 10% crack. 0.95 / 16 / 0.14
       takes it to hairline, which is where a 0.3 mm crack belongs: in the
       normal map, not in the albedo. */
    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      var cr = clamp((crack[i] - 0.95) * 16, 0, 1);
      h[i] = clamp(0.52 + (grain[i] - .5) * .30 + (agg[i] - .5) * .16
        - (1 - seams[i]) * .34 - (1 - vseam[i]) * .18 - cr * .14
        + clamp((patch[i] - .72) * 2.2, 0, 1) * .05, 0, 1);
    }

    var a = albNew(res, [146, 145, 138]);
    albMul(a, grain, 0, 1, 0.80, 1.14);
    albTint(a, agg, [176, 173, 163], .30, .55, 1);              /* exposed aggregate */
    albTint(a, patch, [128, 128, 124], .40, .74, 1);            /* patch repairs */
    albTint(a, seams, [86, 84, 79], .70, .55, 0);               /* dark form joints */
    albTint(a, vseam, [92, 90, 85], .45, .55, 0);
    albTint(a, crack, [112, 109, 104], .22, .955, 1);
    albTint(a, streak, [104, 98, 86], .34, .60, 1);             /* run-off staining */
    albTint(a, fbmC(res, { octaves: 3, frequency: 24, seed: 18 }), [122, 96, 66], .12, .70, 1);

    var rough = fnew(res), metal = null;
    for (i = 0; i < rough.length; i++) {
      rough[i] = clamp(0.80 + (grain[i] - .5) * .18
        - clamp((patch[i] - .74) * 2.4, 0, 1) * .26          /* trowelled patch = smoother */
        + (1 - seams[i]) * .10
        + streak[i] * .06, .30, 1);
    }
    /* 1.4 mm RMS: aggregate pop-out and form-board seams on a fair-faced
       pour. Everything broader than 200 mm is pour colour, not geometry. */
    return emitSet(res, a, h, rough, metal, 1.0, { mm: 1.4, tile: 8.0, hp: 200, rough: 0.20 });
  };

  /* ---- weathered city brick -------------------------------------------- */
  BUILD.brick = function () {
    var res = RES.hi, i;
    /* COURSING. 16 rows x 6 columns on a 3.6-unit tile put one course at
       3.6 * 0.6 / 16 = 135 mm and one brick at 360 x 135 mm. Real metric
       brickwork courses at 75 mm (65 mm brick + 10 mm bed) and a brick is
       215 x 65 mm, so every course was 1.8x oversize -- which is exactly why
       the courtyard walls read as wallpaper rather than masonry, and why the
       tile repeat was so easy to see: only 16 courses before it came round
       again. 32 x 10 on a 4.0-unit tile gives a 75 mm course and a 240 mm
       brick -- real coursing -- and doubles the number of courses in a repeat.
       The joint narrows to match: res/200 is 2.6 texels, which at 4.69 mm per
       texel is a 12 mm bed. */
    var bond = fieldBond(res, 32, 10, Math.max(2, res / 200), 21, true);
    var grain = fbmC(res, { octaves: 5, frequency: 22, seed: 22 });
    var soot = fieldStreak(res, 23, 5, 10, true);
    var eff = worC(res, { cells: 7, seed: 24 });

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.28 + bond.m[i] * .58 + (grain[i] - .5) * .16
        + (bond.id[i] - .5) * .05 * bond.m[i], 0, 1);
    }

    var a = albNew(res, [92, 74, 62]);
    /* mortar first, then the bricks stamped over it */
    albTint(a, bond.m, [143, 137, 126], 1.0, .55, 0);
    albUnitsMasked(a, bond.id, bond.m, [
      [128, 74, 55], [112, 66, 52], [96, 58, 48], [138, 92, 68], [78, 52, 44], [120, 80, 62]
    ], 0.92);
    albMul(a, grain, 0, 1, .82, 1.14);
    albTint(a, eff, [168, 162, 150], .22, .78, 1);              /* efflorescence */
    albTint(a, soot, [46, 42, 40], .40, .58, 1);                /* soot run-off */
    albTint(a, fbmC(res, { octaves: 3, frequency: 4, seed: 25 }), [70, 56, 50], .26, .55, 1);

    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) {
      rough[i] = clamp(0.86 + (1 - bond.m[i]) * .08 + (grain[i] - .5) * .14 - eff[i] * .04, .45, 1);
    }
    /* 2.4 mm RMS and effectively all of it in the raked joint: a brick FACE
       is flat, which is what the 220 mm high-pass leaves behind. */
    return emitSet(res, a, h, rough, null, 1.05, { mm: 2.4, tile: 4.0, hp: 220, rough: 0.14 });
  };

  /* per-unit tint that only applies inside the unit, never over the joint */
  function albUnitsMasked(a, id, mask, cols, amt) {
    var n = cols.length;
    for (var i = 0, j = 0; i < id.length; i++, j += 3) {
      var w = clamp(mask[i], 0, 1) * amt;
      if (w <= 0) continue;
      var t = clamp(id[i], 0, 0.999) * (n - 1);
      var k = Math.floor(t), u = t - k;
      var c0 = cols[k], c1 = cols[Math.min(n - 1, k + 1)];
      a[j] += ((c0[0] + (c1[0] - c0[0]) * u) - a[j]) * w;
      a[j + 1] += ((c0[1] + (c1[1] - c0[1]) * u) - a[j + 1]) * w;
      a[j + 2] += ((c0[2] + (c1[2] - c0[2]) * u) - a[j + 2]) * w;
    }
  }

  /* ---- painted plaster / drywall ---------------------------------------- */
  /* The roughness showcase: patched repairs and hand-rolled paint leave a
     sheen map that is nothing like the albedo map. */
  BUILD.plaster = function () {
    var res = RES.hi, i;
    var orange = fbmC(res, { octaves: 4, frequency: 30, seed: 31 });   /* orange peel */
    var broad = fbmC(res, { octaves: 5, frequency: 5, seed: 32 });
    var patch = worC(res, { cells: 6, seed: 33 });
    var scuff = worC(res, { cells: 18, seed: 34, invert: true });
    /* same hairline correction as concrete: frequency 7 gave 1.2 m contour
       loops on a plaster wall, which is what the shipped frame's "cream wall
       covered in dark squiggles" actually was */
    var crack = fbmC(res, { octaves: 4, frequency: 22, seed: 35, ridged: true });
    var streak = fieldStreak(res, 36, 6, 12, true);
    var dimple = worC(res, { cells: 12, seed: 37 });

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      var cr = clamp((crack[i] - 0.92) * 11, 0, 1);
      h[i] = clamp(0.56 + (orange[i] - .5) * .13 + (broad[i] - .5) * .10
        - cr * .30 - clamp((0.16 - dimple[i]) * 4, 0, 1) * .12
        + clamp((patch[i] - .78) * 3, 0, 1) * .05, 0, 1);
    }

    var a = albNew(res, [176, 170, 156]);
    albMul(a, broad, 0, 1, .88, 1.08);
    albMul(a, orange, 0, 1, .95, 1.05);
    /* plaster is the most-seen wall in the level, so it carries the most
       story: filler patches, hand scuffing at touch height, and hairline
       crazing. Amounts pushed up after the crack fix left it too clean --
       detail that cannot be seen is the same as no detail. */
    albTint(a, patch, [190, 186, 177], .44, .74, 1);
    albTint(a, scuff, [118, 113, 105], .46, .56, 1);            /* hand scuffs */
    albTint(a, crack, [132, 127, 119], .34, .93, 1);
    albTint(a, streak, [128, 118, 100], .30, .62, 1);
    albTint(a, fbmC(res, { octaves: 3, frequency: 3, seed: 38 }), [152, 140, 120], .22, .58, 1);

    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) {
      rough[i] = clamp(0.58 + (orange[i] - .5) * .16
        + clamp((patch[i] - .78) * 3, 0, 1) * .30          /* filler kills the sheen */
        + scuff[i] * .10 + streak[i] * .08, .28, 1);
    }
    /* rolled emulsion over plaster: 0.35 mm RMS. This is the surface the
       critic saw as blown white lumps; it should barely perturb shading. */
    return emitSet(res, a, h, rough, null, .85, { mm: 0.35, tile: 6.0, hp: 110, rough: 0.22 });
  };

  /* ---- asphalt / street ------------------------------------------------- */
  BUILD.asphalt = function () {
    var res = RES.hi, i;
    /* AGGREGATE SIZE. cells 30 on a 512 map at tile 10 (a 6 m repeat) put one
       "chip" at 20 cm, so the road rendered as a field of rounded cobbles --
       visible in the near-field road crop as pebbles the size of a fist. A
       chip seal is 5-10 mm aggregate. 84 cells is 7 cm, which is as fine as
       this map can carry (the tile is what it is), and the detail-normal layer
       -- which is now actually reachable, see nzEnvPatch -- re-samples the
       same map at rate 9 and lands a second copy of that grain at 8 mm, which
       IS the real chip. Height weight comes down with it: 0.34 of the range
       from a 20 cm lump is a cobblestone, 0.22 from a 7 cm one is a chip. */
    var agg = worC(res, { cells: 84, seed: 41, invert: true });
    var fine = fbmC(res, { octaves: 6, frequency: 26, seed: 42 });
    var crack = fbmC(res, { octaves: 5, frequency: 6, seed: 43, ridged: true });
    var patch = worC(res, { cells: 4, seed: 44 });
    var lane = fieldStreak(res, 45, 3, 6, false);

    /* CRACK WIDTH, and it was the loudest world-material tell in the build.
       A ridged fbm crest is only a hairline where you threshold it HARD. At
       (crack - 0.84)/0.16 x 0.90 toward near-black, the crest network came out
       roughly 10 cm wide on a 6 m tile and 90% opaque, so the courtyard floor
       in VERIFY_op_mid_level.png reads as cracked dried mud rather than as
       asphalt -- and it is the strongest thing in that frame, louder than the
       operator standing on it. Real shrinkage cracking in a chip seal is 2-6
       mm wide, sparse, and grey-black not black, because the crack is full of
       the same dust as everything else.
       Threshold band 0.84->0.92 (half the width), amount 0.90->0.50, colour
       [34,33,35]->[48,47,50]. Same for the height trench: a 0.40-deep, 17%-
       of-the-map-wide gouge was also driving cavityAO() to its 0.12 floor over
       the whole network, which is where the second, darker copy of the same
       pattern was coming from. */
    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      var cr = clamp((crack[i] - 0.93) * 15, 0, 1);
      h[i] = clamp(0.5 + (agg[i] - .5) * .22 + (fine[i] - .5) * .26 - cr * .18, 0, 1);
    }

    var a = albNew(res, [78, 78, 82]);
    albMul(a, fine, 0, 1, .78, 1.16);
    albTint(a, agg, [104, 103, 101], .34, .60, 1);
    albTint(a, patch, [60, 60, 64], .40, .72, 1);               /* tar patch */
    albTint(a, crack, [56, 55, 58], .34, .945, 1);
    albTint(a, lane, [92, 91, 92], .22, .60, 1);                /* polished wheel lanes */
    albTint(a, fbmC(res, { octaves: 3, frequency: 3, seed: 46 }), [58, 57, 58], .30, .55, 1);

    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) {
      rough[i] = clamp(0.88 + (fine[i] - .5) * .16 - lane[i] * .26
        - clamp((patch[i] - .74) * 3, 0, 1) * .12, .34, 1);
    }
    /* 1.6 mm RMS -- chip seal aggregate and shrinkage cracking. The old
       173 mm was the courtyard floor's crumpled-foil read. */
    return emitSet(res, a, h, rough, null, 1.0, { mm: 1.6, tile: 10.0, hp: 130, rough: 0.20 });
  };

  /* ---- precast / cut stone (the Dust2 sandstone note) ------------------- */
  BUILD.precast = function () {
    var res = RES.md, i;
    var bond = fieldBond(res, 4, 2, Math.max(2, res / 52), 51, true);
    var grain = fbmC(res, { octaves: 5, frequency: 14, seed: 52 });
    var vein = fbmC(res, { octaves: 4, frequency: 9, seed: 53, ridged: true });
    var wear = worC(res, { cells: 14, seed: 54, invert: true });
    var streak = fieldStreak(res, 55, 6, 10, true);

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.30 + bond.m[i] * .56 + (grain[i] - .5) * .16 - clamp((vein[i] - .85) * 6, 0, 1) * .12, 0, 1);
    }
    var a = albNew(res, [128, 122, 108]);
    albTint(a, bond.m, [98, 93, 84], 1.0, .5, 0);               /* recessed joint */
    albUnitsMasked(a, bond.id, bond.m, [
      [176, 168, 148], [162, 155, 138], [150, 143, 128], [182, 174, 154]
    ], .90);
    albMul(a, grain, 0, 1, .86, 1.10);
    albTint(a, vein, [128, 122, 110], .30, .80, 1);
    albTint(a, wear, [190, 184, 168], .22, .62, 1);             /* chipped arrises */
    albTint(a, streak, [112, 104, 88], .28, .62, 1);

    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) rough[i] = clamp(.80 + (grain[i] - .5) * .18 - wear[i] * .10 + (1 - bond.m[i]) * .08, .38, 1);
    /* 2.0 mm RMS, nearly all of it the recessed joint between units */
    return emitSet(res, a, h, rough, null, 1.0, { mm: 2.0, tile: 6.0, hp: 320, rough: 0.16 });
  };

  /* ---- painted / rusted structural steel -------------------------------- */
  /* Paint over steel, worn through on the raised edges, rust blooming out of
     the low spots. Metalness comes almost entirely from the map: paint 0,
     rust 0.18, bare steel 0.95. That single channel is what separates this
     from "a grey box". */
  BUILD.steel = function () {
    var res = RES.md, i;
    var plate = fieldBond(res, 2, 2, Math.max(2, res / 64), 61, false);
    var edge = worC(res, { cells: 9, seed: 62, invert: true });
    var grain = fbmC(res, { octaves: 5, frequency: 20, seed: 63 });
    var rustF = fbmC(res, { octaves: 5, frequency: 7, seed: 64 });
    var scratch = fbmC(res, { octaves: 3, frequency: 40, seed: 65, ridged: true });
    var bleed = fieldStreak(res, 66, 8, 9, true);

    /* rivets on the plate borders */
    var rivet = fnew(res);
    var rn = 8, rr = Math.max(1.5, res / 78);
    for (var k = 0; k < rn; k++) {
      var rx = (k + .5) / rn * res, ry0 = res * 0.03, ry1 = res * 0.53;
      stampDisc(rivet, res, rx, ry0, rr, 1);
      stampDisc(rivet, res, rx, ry1, rr, 1);
      stampDisc(rivet, res, res * 0.03, (k + .5) / rn * res, rr, 1);
      stampDisc(rivet, res, res * 0.53, (k + .5) / rn * res, rr, 1);
    }

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.50 + (grain[i] - .5) * .12 - (1 - plate.m[i]) * .40
        + rivet[i] * .40 - clamp((scratch[i] - .88) * 8, 0, 1) * .12
        + clamp((rustF[i] - .70) * 3, 0, 1) * .10, 0, 1);
    }

    var wear = fnew(res), rust = fnew(res);
    for (i = 0; i < wear.length; i++) {
      wear[i] = clamp((edge[i] * .7 + grain[i] * .3 - .60) * 3.4, 0, 1);
      rust[i] = clamp((rustF[i] - .60) * 3.0, 0, 1) * (0.35 + 0.65 * (1 - plate.m[i])) + bleed[i] * .28;
      rust[i] = clamp(rust[i], 0, 1);
    }

    var a = albNew(res, [96, 104, 110]);                        /* machinery grey-blue paint */
    albMul(a, grain, 0, 1, .88, 1.10);
    albTint(a, plate.m, [54, 58, 62], .85, .5, 0);
    albTint(a, wear, [158, 162, 166], .85, 0, 1);               /* paint worn to bright steel */
    albTint(a, rust, [104, 62, 34], .88, .12, 1);
    albTint(a, bleed, [92, 58, 36], .34, .60, 1);
    albTint(a, rivet, [126, 132, 138], .45, .25, 1);
    albTint(a, scratch, [176, 180, 184], .30, .90, 1);

    var rough = fnew(res), metal = fnew(res);
    for (i = 0; i < rough.length; i++) {
      var r0 = 0.48 + (grain[i] - .5) * .14;                    /* semi-gloss enamel */
      r0 = lerp(r0, 0.28, wear[i]);                             /* polished bare metal */
      r0 = lerp(r0, 0.92, rust[i]);                             /* corrosion is matte */
      rough[i] = clamp(r0 + (1 - plate.m[i]) * .10, .12, 1);
      metal[i] = clamp(lerp(lerp(0.02, 0.95, wear[i]), 0.18, rust[i]), 0, 1);
    }
    /* 0.8 mm RMS: plate seams, rivet crowns, a little scale. Painted sheet
       steel is one of the flattest things in a building. */
    return emitSet(res, a, h, rough, metal, 1.0, { mm: 0.8, tile: 4.0, hp: 260, rough: 0.14 });
  };

  /* ---- heavy corrosion, for pipes and drums ----------------------------- */
  BUILD.rust = function () {
    var res = RES.md, i;
    var flake = worC(res, { cells: 16, seed: 71 });
    var grain = fbmC(res, { octaves: 6, frequency: 16, seed: 72 });
    var pit = worC(res, { cells: 34, seed: 73, invert: true });
    var paint = fbmC(res, { octaves: 4, frequency: 6, seed: 74 });

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(.5 + (grain[i] - .5) * .30 + (pit[i] - .5) * .26
        - clamp((0.22 - flake[i]) * 4, 0, 1) * .22, 0, 1);
    }
    var a = albNew(res, [112, 62, 34]);
    albMul(a, grain, 0, 1, .74, 1.22);
    albTint(a, pit, [72, 40, 24], .55, .55, 0);
    albTint(a, flake, [148, 96, 52], .38, .55, 1);
    albTint(a, paint, [78, 96, 88], .42, .70, 1);               /* surviving green paint */
    var rough = fnew(res), metal = fnew(res);
    for (i = 0; i < rough.length; i++) {
      var pm = clamp((paint[i] - .70) * 3.2, 0, 1);
      rough[i] = clamp(lerp(0.94, 0.52, pm) + (grain[i] - .5) * .12, .30, 1);
      metal[i] = clamp(lerp(0.16, 0.02, pm), 0, 1);
    }
    /* 0.6 mm RMS -- lifting scale and pitting. Corrosion is shallow. */
    return emitSet(res, a, h, rough, metal, 1.0, { mm: 0.6, tile: 2.4, hp: 90, rough: 0.24 });
  };

  /* ---- smooth industrial enamel (doors, housings) ----------------------- */
  BUILD.paint = function () {
    var res = RES.md, i;
    var peel = fbmC(res, { octaves: 4, frequency: 34, seed: 81 });
    var broad = fbmC(res, { octaves: 4, frequency: 5, seed: 82 });
    var chip = worC(res, { cells: 22, seed: 83, invert: true });
    var scuff = fieldStreak(res, 84, 10, 8, false);

    var h = fnew(res);
    for (i = 0; i < h.length; i++) h[i] = clamp(.55 + (peel[i] - .5) * .12 - clamp((chip[i] - .74) * 4, 0, 1) * .18, 0, 1);
    var a = albNew(res, [166, 170, 172]);
    albMul(a, broad, 0, 1, .90, 1.08);
    albMul(a, peel, 0, 1, .96, 1.04);
    albTint(a, chip, [96, 78, 62], .70, .76, 1);                /* chipped to primer/rust */
    albTint(a, scuff, [132, 134, 136], .26, .58, 1);
    var rough = fnew(res), metal = fnew(res);
    for (i = 0; i < rough.length; i++) {
      var c = clamp((chip[i] - .74) * 4, 0, 1);
      rough[i] = clamp(lerp(0.36 + (peel[i] - .5) * .14, 0.86, c) + scuff[i] * .08, .14, 1);
      metal[i] = clamp(lerp(0.02, 0.40, c), 0, 1);
    }
    /* 0.2 mm RMS. Industrial enamel is a mirror with chips in it; all the
       character has to come from roughness and metalness, not from relief. */
    return emitSet(res, a, h, rough, metal, .8, { mm: 0.2, tile: 3.0, hp: 120, rough: 0.20 });
  };

  /* ---- galvanised bar grating ------------------------------------------ */
  BUILD.grating = function () {
    var res = RES.md, i;
    var bars = fieldPlank(res, 12, Math.max(2, res / 22), 91, true);   /* bearing bars */
    var cross = fieldPlank(res, 4, Math.max(2, res / 40), 92, false);  /* cross rods    */
    var grain = fbmC(res, { octaves: 4, frequency: 26, seed: 93 });
    var spangle = worC(res, { cells: 20, seed: 94 });
    var rustF = fbmC(res, { octaves: 4, frequency: 9, seed: 95 });

    var h = fnew(res), solid = fnew(res);
    for (i = 0; i < h.length; i++) {
      /* bearing bars stand proud; the cross rods sit slightly lower */
      var s = Math.max(bars.m[i], cross.m[i] * .85);
      solid[i] = s;
      h[i] = clamp(0.06 + s * .88 + (grain[i] - .5) * .06, 0, 1);
    }
    var a = albNew(res, [22, 24, 26]);                          /* the void between bars */
    albTint(a, solid, [138, 144, 148], 1.0, .18, .85);
    albTint(a, spangle, [168, 172, 174], .26, .55, 1);
    albMul(a, grain, 0, 1, .88, 1.10);
    albTint(a, rustF, [108, 66, 40], .30, .74, 1);
    var rough = fnew(res), metal = fnew(res);
    for (i = 0; i < rough.length; i++) {
      var ru = clamp((rustF[i] - .74) * 4, 0, 1);
      rough[i] = clamp(lerp(0.95, lerp(0.44, 0.90, ru), solid[i]) + (grain[i] - .5) * .10, .18, 1);
      metal[i] = clamp(solid[i] * lerp(0.90, 0.20, ru), 0, 1);
    }
    /* the one surface whose relief really is deep: 25 mm bearing bars, so
       5 mm RMS and NO high-pass -- the bar structure IS the geometry. */
    return emitSet(res, a, h, rough, metal, 1.25, { mm: 5.0, tile: 2.2, hp: 0, rough: 0.10 });
  };

  /* ---- grimy ceramic tile ---------------------------------------------- */
  BUILD.tile = function () {
    var res = RES.md, i;
    var grid = fieldBond(res, 8, 8, Math.max(2, res / 60), 101, false);
    var grain = fbmC(res, { octaves: 5, frequency: 18, seed: 102 });
    var traffic = worC(res, { cells: 5, seed: 103 });
    var crack = fbmC(res, { octaves: 4, frequency: 12, seed: 104, ridged: true });
    var grime = fbmC(res, { octaves: 5, frequency: 9, seed: 105 });

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(.34 + grid.m[i] * .56 + (grain[i] - .5) * .08 - clamp((crack[i] - .90) * 9, 0, 1) * .22, 0, 1);
    }
    var a = albNew(res, [96, 92, 86]);
    albTint(a, grid.m, [70, 66, 60], 1.0, .5, 0);               /* dark grout */
    albUnitsMasked(a, grid.id, grid.m, [
      [168, 164, 152], [152, 148, 138], [178, 174, 162], [140, 138, 130]
    ], .95);
    albMul(a, grain, 0, 1, .92, 1.06);
    albTint(a, traffic, [112, 108, 100], .34, .68, 1);          /* traffic soiling */
    albTint(a, grime, [88, 82, 72], .26, .68, 1);
    albTint(a, crack, [72, 68, 62], .70, .92, 1);
    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) {
      rough[i] = clamp(lerp(0.88, 0.26, grid.m[i])              /* glaze vs grout */
        + traffic[i] * .22 + grime[i] * .12 + (grain[i] - .5) * .08, .12, 1);
    }
    /* 1.0 mm RMS: glazed faces are dead flat, the grout sits ~2 mm below */
    return emitSet(res, a, h, rough, null, 1.1, { mm: 1.0, tile: 3.2, hp: 200, rough: 0.10 });
  };

  /* ---- plywood / timber ------------------------------------------------- */
  BUILD.plywood = function () {
    var res = RES.md, i;
    var planks = fieldPlank(res, 5, Math.max(2, res / 64), 111, false);
    var grain = blurAxis(fbmC(res, { octaves: 6, frequency: 30, seed: 112 }), res, Math.max(1, res / 22), false);
    var knot = worC(res, { cells: 7, seed: 113 });
    var wear = worC(res, { cells: 16, seed: 114, invert: true });

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(.42 + planks.m[i] * .40 + (grain[i] - .5) * .22 - clamp((.18 - knot[i]) * 4, 0, 1) * .16, 0, 1);
    }
    var a = albNew(res, [128, 92, 54]);
    albTint(a, planks.m, [58, 40, 24], .95, .5, 0);
    albUnitsMasked(a, planks.id, planks.m, [
      [150, 110, 66], [128, 92, 54], [162, 124, 78], [116, 84, 50]
    ], .70);
    albMul(a, grain, 0, 1, .78, 1.18);
    albTint(a, knot, [82, 54, 28], .60, .22, 0);
    albTint(a, wear, [172, 142, 100], .26, .62, 1);
    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) rough[i] = clamp(.78 + (grain[i] - .5) * .16 - wear[i] * .14 + (1 - planks.m[i]) * .08, .30, 1);
    /* 0.9 mm RMS -- plank joints and raised grain */
    return emitSet(res, a, h, rough, null, .95, { mm: 0.9, tile: 4.2, hp: 180, rough: 0.18 });
  };

  /* ---- worn commercial carpet ------------------------------------------ */
  BUILD.carpet = function () {
    var res = RES.md, i;
    var pile = fbmC(res, { octaves: 6, frequency: 44, seed: 121 });
    var loop = worC(res, { cells: 40, seed: 122, invert: true });
    var traffic = worC(res, { cells: 4, seed: 123 });
    var stain = fbmC(res, { octaves: 4, frequency: 7, seed: 124 });
    var h = fnew(res);
    for (i = 0; i < h.length; i++) h[i] = clamp(.5 + (pile[i] - .5) * .34 + (loop[i] - .5) * .24, 0, 1);
    var a = albNew(res, [88, 40, 36]);
    albMul(a, pile, 0, 1, .74, 1.22);
    albTint(a, loop, [110, 54, 46], .34, .5, 1);
    albTint(a, traffic, [64, 38, 34], .48, .62, 1);             /* worn walking lane */
    albTint(a, stain, [52, 36, 30], .34, .70, 1);
    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) rough[i] = clamp(.94 + (pile[i] - .5) * .08 - traffic[i] * .06, .70, 1);
    /* 0.9 mm RMS: loop pile is soft and shallow and reads through diffuse,
       not through a specular lobe */
    return emitSet(res, a, h, rough, null, .8, { mm: 0.9, tile: 3.4, hp: 55, rough: 0.08 });
  };

  /* ---- acoustic ceiling tile ------------------------------------------- */
  BUILD.ceiltile = function () {
    var res = RES.md, i;
    var grid = fieldBond(res, 4, 4, Math.max(2, res / 44), 131, false);
    var pin = worC(res, { cells: 46, seed: 132, invert: true });
    var stain = fbmC(res, { octaves: 4, frequency: 6, seed: 133 });
    var grain = fbmC(res, { octaves: 5, frequency: 20, seed: 134 });
    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(.34 + grid.m[i] * .52 - clamp((.30 - pin[i]) * 3, 0, 1) * .22 * grid.m[i] + (grain[i] - .5) * .08, 0, 1);
    }
    var a = albNew(res, [122, 120, 114]);
    albTint(a, grid.m, [178, 176, 168], 1.0, .35, 1);
    albMul(a, grain, 0, 1, .92, 1.06);
    albTint(a, pin, [138, 136, 130], .30, .5, 0);
    albTint(a, stain, [150, 132, 96], .40, .74, 1);             /* water damage */
    albTint(a, blurAxis(stain, res, Math.max(1, res / 20), true), [126, 112, 86], .22, .70, 1);
    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) rough[i] = clamp(.90 - grid.m[i] * .06 + (grain[i] - .5) * .10, .55, 1);
    /* 1.1 mm RMS -- the reveal between tiles plus the pinholes */
    return emitSet(res, a, h, rough, null, .9, { mm: 1.1, tile: 4.0, hp: 300, rough: 0.12 });
  };

  /* ---- dirty glazing ---------------------------------------------------- */
  BUILD.glassfac = function () {
    var res = RES.md, i;
    var frame = fieldBond(res, 4, 4, Math.max(3, res / 30), 141, false);
    var dirt = fbmC(res, { octaves: 5, frequency: 10, seed: 142 });
    var streak = fieldStreak(res, 143, 8, 8, true);
    var h = fnew(res);
    for (i = 0; i < h.length; i++) h[i] = clamp(.30 + (1 - frame.m[i]) * .55 + (dirt[i] - .5) * .06, 0, 1);
    var a = albNew(res, [30, 38, 48]);
    albUnitsMasked(a, frame.id, frame.m, [[22, 28, 36], [38, 48, 60], [26, 32, 40], [58, 66, 76]], .9);
    albTint(a, frame.m, [64, 66, 70], 1.0, .5, 0);
    albTint(a, dirt, [78, 78, 74], .34, .62, 1);
    albTint(a, streak, [92, 92, 88], .26, .60, 1);
    var rough = fnew(res), metal = fnew(res);
    for (i = 0; i < rough.length; i++) {
      rough[i] = clamp(lerp(0.62, 0.12, frame.m[i]) + dirt[i] * .30 + streak[i] * .16, .06, 1);
      metal[i] = clamp((1 - frame.m[i]) * 0.55, 0, 1);
    }
    /* 1.4 mm RMS: the mullion reveal. Glass itself is optically flat. */
    return emitSet(res, a, h, rough, metal, .8, { mm: 1.4, tile: 8.0, hp: 340, rough: 0.06 });
  };

  function stampDisc(f, res, cx, cy, r, v) {
    var x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
    var y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      var w = clamp(1 - d / r, 0, 1);
      var k = (((y % res) + res) % res) * res + (((x % res) + res) % res);
      f[k] = Math.max(f[k], w * v);
    }
  }

  /* ======================================================================
     5. surface table
     tile = the world-space size in game units that one texture repeat covers.
     One unit is about 0.6 m here (EYE 2.85 units reads as a 1.7 m eye line),
     so tile 8 is a 4.8 m concrete pour and tile 3.6 is 2.2 m of brickwork at
     roughly 20 courses -- real masonry coursing, not wallpaper.
     =================================================================== */
  /* desat = how hard this surface is pulled toward its own luminance in the
     shader. The level's 94 baked point lights are strongly warm and they
     multiply every surface, which is where the cream walls and the salmon
     floor come from -- measured off the shipped frame the floor sat at HSV
     saturation 0.43 and the walls at 0.26, against a CS2 interior reference of
     roughly 0.06-0.15. Nothing about the albedo library is that warm (concrete
     bakes at 0.06, plaster at 0.12); it is entirely the light. So the pull has
     to happen after the vertex colour, and it has to be hard.
     occ = contact-occlusion amount at the floor/ceiling junction. */
  /* nrm = artistic trim on the whole normal, 1.0 = exactly the millimetres the
     set was authored for. It is no longer load-bearing for scale: emitSet
     solves the amplitude and surfaceMaterial corrects for retiling.
     det = [ rate, mm ] -- the detail-normal layer. `rate` is how many times
     tighter the second lookup tiles (so the base map's 150 mm band lands at
     150/rate mm) and `mm` is the RMS relief it should contribute, in real
     millimetres, at that finer scale. det[0] = 0 switches it off, which is
     right for grating and glazing where the base map already IS the geometry.
     floorPolish = extra roughness break on up-facing faces, so a floor reads
     as a walked-on floor rather than a wall lying down. */
  var SURF = {
    concrete:  { set: 'concrete', tile: 8.0,  tint: 0xf2f3f5, nrm: 1.00, macro: 0.46, grime: 4.2, soot: 2.4, grimeAmt: 0.78, wetY: -4.0, wet: 0.55, desat: 0.52, occ: 1.00, det: [8.0, 0.55], polish: 0.34 },
    ceildark:  { set: 'concrete', tile: 10.0, tint: 0xb1b4b8, nrm: 0.80, macro: 0.34, grime: 0.0, soot: 0.0, grimeAmt: 0.0,  wetY: -99,  wet: 0.0,  desat: 0.52, occ: 0.60, det: [8.0, 0.30], polish: 0.0 },
    stone:     { set: 'precast',  tile: 6.0,  tint: 0xf2f3f5, nrm: 1.00, macro: 0.42, grime: 3.4, soot: 2.0, grimeAmt: 0.72, wetY: -99,  wet: 0.0,  desat: 0.55, occ: 1.00, det: [7.0, 0.35], polish: 0.24 },
    brick:     { set: 'brick',    tile: 4.0,  tint: 0xf4f2f0, nrm: 1.00, macro: 0.52, grime: 4.4, soot: 0.0, grimeAmt: 0.80, wetY: -99,  wet: 0.0,  desat: 0.46, occ: 1.00, det: [6.0, 0.40], polish: 0.0 },
    hotelwall: { set: 'plaster',  tile: 6.0,  tint: 0xeff0f2, nrm: 0.85, macro: 0.44, grime: 3.2, soot: 1.8, grimeAmt: 0.76, wetY: -99,  wet: 0.0,  desat: 0.56, occ: 1.00, det: [7.0, 0.10], polish: 0.0 },
    metal:     { set: 'steel',    tile: 4.0,  tint: 0xf2f4f6, nrm: 1.10, macro: 0.30, grime: 2.8, soot: 1.6, grimeAmt: 0.66, wetY: -4.0, wet: 0.60, desat: 0.50, occ: 0.90, det: [6.0, 0.10], polish: 0.18 },
    /* wet 0.42 -> 0.28: wetY 999 means "wet everywhere", and at 0.42 the
       roughness floor (0.085) turned the whole street into a mirror for a blue
       sky, which is half of why the shaded asphalt measured blue. A damp
       street still reads damp at 0.28 and stops being a lake. */
    street:    { set: 'asphalt',  tile: 10.0, tint: 0xf4f5f7, nrm: 0.95, macro: 0.44, grime: 0.0, soot: 0.0, grimeAmt: 0.0,  wetY: 999,  wet: 0.28, desat: 0.58, occ: 1.00, det: [9.0, 0.70], polish: 0.30 },
    carpet:    { set: 'carpet',   tile: 3.4,  tint: 0xffffff, nrm: 0.50, macro: 0.32, grime: 1.8, soot: 0.0, grimeAmt: 0.52, wetY: -99,  wet: 0.0,  desat: 0.34, occ: 0.85, det: [5.0, 0.35], polish: 0.10 },
    tilefloor: { set: 'tile',     tile: 3.2,  tint: 0xf2f3f5, nrm: 0.90, macro: 0.30, grime: 1.6, soot: 0.0, grimeAmt: 0.55, wetY: -4.0, wet: 0.70, desat: 0.52, occ: 0.95, det: [6.0, 0.12], polish: 0.26 },
    wood:      { set: 'plywood',  tile: 4.2,  tint: 0xf6f2ec, nrm: 0.80, macro: 0.32, grime: 1.8, soot: 0.0, grimeAmt: 0.55, wetY: -99,  wet: 0.0,  desat: 0.42, occ: 0.85, det: [6.0, 0.20], polish: 0.20 },
    ceil:      { set: 'ceiltile', tile: 4.0,  tint: 0xeef0f2, nrm: 0.70, macro: 0.28, grime: 0.0, soot: 0.0, grimeAmt: 0.0,  wetY: -99,  wet: 0.0,  desat: 0.55, occ: 0.55, det: [6.0, 0.20], polish: 0.0 },
    grate:     { set: 'grating',  tile: 2.2,  tint: 0xf2f4f6, nrm: 1.00, macro: 0.20, grime: 1.2, soot: 0.0, grimeAmt: 0.42, wetY: -4.0, wet: 0.65, desat: 0.48, occ: 0.70, det: [0, 0],      polish: 0.0 },
    glass:     { set: 'glassfac', tile: 8.0,  tint: 0xffffff, nrm: 0.60, macro: 0.22, grime: 2.0, soot: 0.0, grimeAmt: 0.50, wetY: -99,  wet: 0.0,  desat: 0.30, occ: 0.70, det: [0, 0],      polish: 0.0 },
    crate:     { set: 'plywood',  tile: 2.6,  tint: 0xf0ede6, nrm: 0.90, macro: 0.28, grime: 1.2, soot: 0.0, grimeAmt: 0.40, wetY: -99,  wet: 0.0,  desat: 0.46, occ: 0.80, det: [5.0, 0.20], polish: 0.0 },
    door:      { set: 'paint',    tile: 3.0,  tint: 0xbfc2c5, nrm: 0.85, macro: 0.22, grime: 1.0, soot: 0.0, grimeAmt: 0.35, wetY: -99,  wet: 0.0,  desat: 0.45, occ: 0.60, det: [6.0, 0.06], polish: 0.0 },
    keydoor:   { set: 'paint',    tile: 3.0,  tint: 0xe27e72, nrm: 0.85, macro: 0.22, grime: 1.0, soot: 0.0, grimeAmt: 0.35, wetY: -99,  wet: 0.0,  desat: 0.22, occ: 0.60, det: [6.0, 0.06], polish: 0.0 }
  };
  /* ---- COLOUR MANAGEMENT: these sixteen tints ARE the funnel ---------------
     nz-render sets THREE.ColorManagement.legacyMode = false at rendererInit,
     which is global and is set before this module builds a single material.
     `new THREE.Color(S.tint)` and `m.color.setHex()` below are therefore now
     sRGB-decoded, where before the flag they went to the shader RAW AS LINEAR.
     Twelve of these are near-white trims over a real textured albedo and moved
     under 0.11 stop. Four were authored as COLOURS and moved a stop or more;
     following nz-render's stated rule -- "if any of them now reads too dark,
     re-author the HEX, never re-add a multiplier" -- those four were re-solved
     as reflectances rather than left where the arithmetic dropped them.

     The number that matters is not the tint, it is tint_linear x
     albedo_linear, because every one of these multiplies a real textured
     albedo that was ALWAYS decoded (a CanvasTexture tagged sRGB is decoded in
     the shader whatever the flag says). Measured against the baked sets:

       surf      set        legacy    flag-off   re-authored   real-world
       ceildark  concrete   14.3%  ->  7.0%   ->  11.5%   dark concrete soffit
       crate     plywood     9.2%  ->  6.3%   ->  10.5%   used site plywood
       door      paint      23.3%  -> 13.1%   ->  20.0%   grubby grey enamel
       keydoor   paint      14.2%  ->  5.1%   ->  12.0%   red enamel, and it is
                                                          a GAMEPLAY read
     7.0% is coal; a concrete ceiling is not coal. 5.1% for the keycard door
     was the worst of them -- that door has to be findable across a room.
     The other twelve are left exactly as they are, which is the whole point
     of the flag: they finally MEAN what they say.
     Cross-check any change here with:
       node -e "..."  s2l(hex) luma x set albedo luma  -> effective reflectance
     and keep every wall inside 18-32%, every floor inside 4-22%. */
  /* global multipliers, so the whole palette can be dialled from one place */
  var DESAT = 1.00;            /* scales every SURF.desat                     */
  /* 0.75, up from 0.55. See the note on the cool term in INJ_MAP: this is the
     level's half of the operator-vs-wall hue collision VERIFY measured, and
     it is the only half anybody owns. */
  var COOL = 0.75;             /* cool bias in the shadows, CS2 signature     */
  var MACROC = 2.2;            /* contrast of the world-space macro field     */
  /* 'switch' is deliberately absent: the exit panel is a gameplay-critical
     read (ACCESS / LOCKED) authored to fitted UVs, and a tiling PBR set would
     destroy it. It keeps the stock material. */

  /* what grime multiplies the albedo by at full strength: a cool-neutral
     soot, never a brown wash. CS2 dirt desaturates far more than it tints. */
  var GRIME_COL = [0.60, 0.57, 0.51];

  /* ======================================================================
     6. the shared shader injection
     One function object for every material in this module, so three's
     customProgramCacheKey (which is onBeforeCompile.toString()) resolves to
     ONE program for the whole level instead of one per material.
     =================================================================== */
  var INJ_MAP = [
    '  {',
    /* --- macro breakup ---------------------------------------------------
       This used to take three low-frequency taps of the albedo map itself and
       re-centre them on the albedo's mean. Measured on a rendered 48-unit
       wall, the result was a +-3% wobble: a procedural albedo is essentially
       all high-frequency grain, and stretching it 3x does not create low
       frequencies -- the mip chain averages them straight back out. So the
       macro field is now real world-space value noise, two octaves at 21 and
       7.3 units. It is per-pixel smooth, it does not repeat with the texture
       (which is the entire point of a macro layer), and its contrast is a
       uniform rather than a hostage to the albedo's histogram. --- */
    '    nzMacro = clamp( ( nzN( vNzWP * 0.0476 ) * 0.64 + nzN( vNzWP * 0.137 + 31.7 ) * 0.36',
    '                       - 0.5 ) * uNzC.w + 0.5, 0.0, 1.0 );',
    '    diffuseColor.rgb *= mix( 1.0, 0.60 + 0.80 * nzMacro, uNzA.y );',
    /* --- vertical story: grime rising off the floor, soot under the ceiling.
       vNzFC carries the REAL floor/ceiling height of the room this fragment is
       in, so a 34-unit street canyon and a 7-unit corridor grime at their own
       scale instead of at some global constant. --- */
    '    float nzSpan = vNzFC.y - vNzFC.x;',
    '    float nzHF = vNzWP.y - vNzFC.x;',
    '    if ( nzSpan > 0.5 ) {',
    '      float nzG = smoothstep( uNzA.z, 0.0, nzHF ) * ( 0.30 + 1.00 * nzMacro );',
    '      float nzS = smoothstep( uNzA.w, 0.0, vNzFC.y - vNzWP.y ) * step( nzSpan, 21.0 );',
    '      nzGrime = clamp( ( nzG + nzS * 0.65 ) * uNzB.x, 0.0, 1.0 );',
    '      diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uNzGrime, nzGrime );',
    '    }',
    /* --- contact occlusion at the wall/floor junction. The level is one quad
       per 4-unit cell, so its four corner vertices cannot carry a 1-unit
       gradient -- vertex AO physically cannot draw this. Doing it per-pixel
       against the room floor is what stops two flat planes meeting in a bright
       hard line, which is the single strongest "unlit blockout" tell. Vertical
       faces darken off the floor, up-facing faces darken under the ceiling. --- */
    '    float nzSide = 1.0 - abs( vNzWN.y );',
    '    nzOcc  = nzSide * ( 1.0 - smoothstep( 0.0, 1.35, max( nzHF, 0.0 ) ) );',
    '    if ( nzSpan > 0.5 && nzSpan < 21.0 ) {',
    '      nzOcc = max( nzOcc, nzSide * 0.72 * ( 1.0 - smoothstep( 0.0, 1.10, max( vNzFC.y - vNzWP.y, 0.0 ) ) ) );',
    '    }',
    /* --- and the other half of the junction. Everything above darkens the
       WALL as it comes down to the floor; the floor itself had nothing but a
       four-unit vertex gradient, so a corner still met in a bright hard line
       from the floor side. vNzFC.z is the real distance to the nearest solid
       cell, carried per vertex and interpolated, so this is an exact 1.4-unit
       contact ramp on up-facing faces however coarse the geometry is. --- */
    /* Gated on nzSpan for the same reason the grime is: geometry that never
       got an nzFC attribute reads (0,0,0), and an ungated ramp would take
       every up-facing facet in the level to 92% occlusion on the strength of
       a missing buffer. No room data, no contact term. */
    '    if ( nzSpan > 0.5 ) {',
    '      float nzUpO = clamp( vNzWN.y, 0.0, 1.0 );',
    '      nzOcc = max( nzOcc, nzUpO * 0.92 * ( 1.0 - smoothstep( 0.0, 1.40, max( vNzFC.z, 0.0 ) ) ) );',
    '    }',
    '    nzOcc = clamp( nzOcc, 0.0, 1.0 ) * uNzC.x;',
    '    diffuseColor.rgb *= ( 1.0 - 0.62 * nzOcc );',
    /* --- standing water on up-facing surfaces below the flood line --- */
    '    float nzUp = clamp( vNzWN.y, 0.0, 1.0 );',
    '    nzWet = clamp( smoothstep( uNzB.y + 3.5, uNzB.y - 1.0, vNzWP.y ) * nzUp * uNzB.z',
    '                   * smoothstep( 0.28, 0.74, nzMacro ), 0.0, 1.0 );',
    '    diffuseColor.rgb *= mix( 1.0, 0.52, nzWet );',
    /* --- final desaturation toward the CS2 palette. The level's baked point
       lights are strongly warm and they multiply everything; pulling chroma
       here is the only place that catches albedo AND vertex light AND grime in
       one go. uNzC.y is the amount, uNzC.z a slight cool bias in the shadows. --- */
    '    float nzL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( nzL ), uNzC.y );',
    /* THE COOL BIAS IS ALSO A LEGIBILITY TERM, not just a look.
       Measured off VERIFY_op_mid_level.png (the real game, real level): the
       courtyard wall behind the operator reads 137/129/123 -- warm -- and the
       operator reads 86/75/63, which is the SAME hue family at 0.22 stop of
       difference against the shaded wall. A khaki man in front of a khaki wall
       is invisible however well he is lit, and no exposure change can fix it.
       Concrete is not warm; the warmth is entirely the level's 94 baked point
       lights multiplying through. So the pull is now weighted rather than
       gated on darkness alone -- (0.35 + 0.65*(1-nzL)) instead of (1-nzL) --
       which lets it reach the mid-value wall that was carrying the collision,
       and the target tint is deepened to (0.90, 0.96, 1.07).
       At the measured wall value that turns 137/129/123 into a near-neutral
       130/126/127 while the operator (not ours, not touched) stays warm: the
       separation becomes HUE, which survives every heading, instead of value,
       which does not. Restraint still applies -- 6% is a cast you feel and do
       not see. */
    /* ...but WEIGHTED BY nzSide, because the two halves of the level have
       opposite problems and one global cool would trade one for the other.
       The WALLS are too warm (the baked point lights are sodium and they
       multiply every vertical surface, which is where the operator collision
       is). The FLOORS are already too cool -- a floor's cosine lobe is centred
       on the zenith, so it drinks the sky, and the measured near-field road
       was reading B-R +17/255. So: full pull on verticals, 30% of it on
       up-facing faces. Same term, two jobs, no fight. */
    '    diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.90, 0.96, 1.07 ),',
    '                             uNzC.z * ( 0.35 + 0.65 * ( 1.0 - nzL ) )',
    '                             * mix( 0.30, 1.0, nzSide ) );',
    '  }'
  ].join('\n');

  var INJ_ROUGH = [
    '  roughnessFactor *= mix( 1.0, 0.74 + 0.52 * nzMacro, uNzA.y );',
    /* --- TRAFFIC POLISH. The corridor floor read as a flat featureless
       salmon plane: correct tint, correct tiling, no identity. A floor is not
       a wall lying down -- feet burnish it into lanes and leave the sheltered
       edges chalky, and that gradient in ROUGHNESS is most of what tells you a
       surface has been walked on. Two world-space octaves, elongated 4:1 along
       X so it reads as traffic flow rather than as more blobs, and gated to
       up-facing faces so it can never touch a wall. --- */
    '  if ( uNzD.z > 0.0 ) {',
    '    float nzUpF = smoothstep( 0.55, 0.92, vNzWN.y );',
    '    float nzTr = nzN( vNzWP * vec3( 0.031, 0.4, 0.124 ) + 11.3 ) * 0.62',
    '               + nzN( vNzWP * vec3( 0.087, 0.4, 0.348 ) + 57.1 ) * 0.38;',
    '    roughnessFactor *= mix( 1.0, 0.70 + 0.62 * nzTr, uNzD.z * nzUpF );',
    '    diffuseColor.rgb *= mix( 1.0, 0.86 + 0.26 * nzTr, uNzD.z * nzUpF * 0.75 );',
    '  }',
    '  roughnessFactor = mix( roughnessFactor, min( 1.0, roughnessFactor * 1.20 + 0.12 ), nzGrime );',
    '  roughnessFactor = mix( roughnessFactor, min( 1.0, roughnessFactor * 1.12 + 0.06 ), nzOcc );',
    '  roughnessFactor = mix( roughnessFactor, 0.085, nzWet );',
    '  roughnessFactor = clamp( roughnessFactor, 0.035, 1.0 );'
  ].join('\n');

  var INJ_METAL = [
    '  metalnessFactor *= ( 1.0 - 0.55 * nzGrime );'
  ].join('\n');

  /* AO belongs on the indirect term too, not just on albedo: a crease that is
     only albedo-dark still reads as a painted stripe under a bright probe. */
  var INJ_AO = [
    '  #if defined( RE_IndirectDiffuse )',
    '    irradiance *= ( 1.0 - 0.55 * nzOcc );',
    '    iblIrradiance *= ( 1.0 - 0.70 * nzOcc );',
    '  #endif'
  ].join('\n');

  /* --- DETAIL NORMAL ------------------------------------------------------
     The second half of the blobby-wall bug. Fixing the amplitude got the
     relief down from 114 mm to 1.4 mm, but the SPECTRUM was still
     architectural: measured per octave band, the concrete height field carried
     more energy at 150-300 mm than at 19 mm, so what survived was a very
     shallow version of the same 30-60 cm lumps. A concrete wall's relief is
     aggregate and form marks -- millimetres to a couple of centimetres.

     The obstacle is texel density, and it is a hard one. A 4.8 m concrete tile
     on a 512 map is 9.4 mm per texel, so the map physically cannot hold a 5 mm
     stone. Dropping the tile to fix that would make the texture repeat every
     1.2 m, which is worse.

     So: sample the same normal map a SECOND time at a much tighter UV rate and
     add the two. This is the standard detail-normal trick (Source 2 and CS2
     ship it on essentially every world material) and here it is free -- no
     extra texture, no extra VRAM, one extra fetch. At rate 8 the map's 150 mm
     band lands at 19 mm and its 600 mm band at 75 mm, which is exactly the
     scale aggregate and form-marks live at, and because the second lookup has
     8x the UV derivative the mip chain fades it out with distance by itself,
     so it costs nothing in the distance and cannot alias.

     The detail UV is rotated 90 degrees and offset by an irrational-ish amount
     so the two layers never line up and re-create the base pattern.

     uNzD = ( rate, amount, floor-polish, unused ). */
  var FRAG_HEAD = [
    'uniform vec4 uNzA;',
    'uniform vec4 uNzB;',
    'uniform vec4 uNzC;',
    'uniform vec4 uNzD;',
    'uniform vec3 uNzGrime;',
    'varying vec3 vNzWP;',
    'varying vec3 vNzWN;',
    'varying vec3 vNzFC;',
    'float nzMacro = 0.5;',
    'float nzGrime = 0.0;',
    'float nzWet = 0.0;',
    'float nzOcc = 0.0;',
    /* 3D value noise. World coordinates here run 0..256 and are scaled down
       before use, so the lattice index stays small and mediump-safe. */
    'float nzHash( vec3 p ) {',
    '  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );',
    '  p *= 17.0;',
    '  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );',
    '}',
    'float nzN( vec3 x ) {',
    '  vec3 i = floor( x ), f = fract( x );',
    '  f = f * f * ( 3.0 - 2.0 * f );',
    '  return mix( mix( mix( nzHash( i + vec3( 0.0, 0.0, 0.0 ) ), nzHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),',
    '                   mix( nzHash( i + vec3( 0.0, 1.0, 0.0 ) ), nzHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),',
    '              mix( mix( nzHash( i + vec3( 0.0, 0.0, 1.0 ) ), nzHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),',
    '                   mix( nzHash( i + vec3( 0.0, 1.0, 1.0 ) ), nzHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );',
    '}',
    /* Sits in for the stock `texture2D( normalMap, vUv ).xyz * 2.0 - 1.0`.
       Guarded because the normalMap sampler only exists under USE_NORMALMAP,
       and the substitution only happens when that exact expression is found. */
    '#ifdef USE_NORMALMAP',
    'vec3 nzMapN( vec2 uv ) {',
    '  vec3 b = texture2D( normalMap, uv ).xyz * 2.0 - 1.0;',
    '  if ( uNzD.y <= 0.0 ) return b;',
    '  vec2 duv = vec2( uv.y, -uv.x ) * uNzD.x + vec2( 0.3173, 0.6817 );',
    '  vec3 d = texture2D( normalMap, duv ).xyz * 2.0 - 1.0;',
    '  return vec3( b.xy + d.xy * uNzD.y, b.z );',
    '}',
    '#endif'
  ].join('\n');

  var VERT_HEAD = [
    'attribute vec3 nzFC;',
    'varying vec3 vNzWP;',
    'varying vec3 vNzWN;',
    /* (floorY, ceilY, distance to the nearest wall) -- the third component is
       what lets the floor side of a wall junction draw a real contact ramp */
    'varying vec3 vNzFC;'
  ].join('\n');

  var GLSL_OK = true;
  var MAIN_RE = /void\s+main\s*\(\s*\)\s*\{/;

  /* Compile the injected snippets standalone against the real GL context
     before letting them anywhere near the level. A GLSL error inside
     onBeforeCompile does not throw -- it just silently renders black -- and
     this module cannot see the screen, so this is the only honest check. */
  function validateGLSL() {
    var gl;
    try { gl = renderer.getContext(); } catch (e) { return false; }
    if (!gl) return false;
    var vs = [
      'attribute vec3 position; attribute vec3 normal; attribute vec2 uv;',
      'uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix; uniform mat3 normalMatrix;',
      'varying vec2 vUv;',
      VERT_HEAD,
      'void main(){',
      '  vec3 objectNormal = vec3( normal );',
      '  vNzWN = normalize( mat3( modelMatrix ) * objectNormal );',
      '  vec3 transformed = vec3( position );',
      '  vNzWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      '  vNzFC = nzFC; vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4( transformed, 1.0 );',
      '}'
    ].join('\n');
    var fs = [
      'precision highp float;',
      /* USE_NORMALMAP is defined here on purpose: nzMapN lives behind that
         guard, and a probe that does not compile it is a probe that cannot
         catch a typo in the one function every surface in the level routes its
         normal through. The sampler has to be declared before FRAG_HEAD for
         the same reason three declares it in normalmap_pars_fragment. */
      '#define USE_NORMALMAP',
      'uniform sampler2D map;',
      'uniform sampler2D normalMap;',
      'varying vec2 vUv;',
      FRAG_HEAD,
      'void main(){',
      '  vec4 diffuseColor = texture2D( map, vUv );',
      '  float roughnessFactor = 0.5;',
      '  float metalnessFactor = 0.5;',
      '  vec3 irradiance = vec3( 0.5 );',
      '  vec3 iblIrradiance = vec3( 0.5 );',
      '  vec3 nzProbeN = nzMapN( vUv );',
      INJ_MAP,
      INJ_ROUGH,
      INJ_METAL,
      INJ_AO.split('\n').filter(function (L) { return L.indexOf('#if') < 0 && L.indexOf('#endif') < 0; }).join('\n'),
      '  gl_FragColor = vec4( diffuseColor.rgb * roughnessFactor * metalnessFactor * irradiance * iblIrradiance + nzProbeN * 0.0001, 1.0 );',
      '}'
    ].join('\n');
    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      var ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
      if (!ok) warn('GLSL probe failed: ' + gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return !!ok;
    }
    return compile(gl.VERTEX_SHADER, vs) && compile(gl.FRAGMENT_SHADER, fs);
  }

  /* Every anchor this injection needs. If three ever renames a chunk the patch
     must report that it fell back, not pretend it worked. */
  var ANCHORS_V = ['#include <beginnormal_vertex>', '#include <begin_vertex>'];
  /* NOTE the anchor: <color_fragment>, not <map_fragment>. three applies the
     vertex colours in color_fragment, which runs AFTER map_fragment -- and the
     vertex colours here are the game's baked point lighting, which is where
     essentially all of the level's salmon/cream cast comes from. Injecting
     before them would leave the one term that most needs desaturating
     untouched, and would let grime and contact AO be multiplied straight back
     out again by a warm light. */
  var ANCHORS_F = ['#include <color_fragment>', '#include <roughnessmap_fragment>',
                   '#include <metalnessmap_fragment>', '#include <lights_fragment_end>'];

  function nzEnvPatch(shader, rendererArg) {
    /* `this` is the material; three r149 invokes onBeforeCompile(parameters,
       renderer) with the material as the receiver. */
    var P = this.__nzEnv;
    if (!P) return;

    /* ---- CHAIN, do not replace ------------------------------------------
       nz-render.js patches THREE.Material.prototype.onBeforeCompile to splice
       its screen-space AO, contact shadows, specular occlusion and PCSS into
       every lit material. Assigning our own onBeforeCompile as an OWN property
       shadows that prototype method, so before this call every surface in the
       level -- the entire world -- silently opted out of nz-render's whole
       lighting patch while enemies and weapons kept it. That is why the level
       read as unlit planes. Call the prototype first (it is a plain function
       that ignores `this`, it only rewrites the shader object), then layer our
       own injection on top: the two touch disjoint anchors. */
    var proto = THREE.Material.prototype.onBeforeCompile;
    if (typeof proto === 'function' && proto !== nzEnvPatch) {
      try { proto.call(this, shader, rendererArg); DIAG.chained++; }
      catch (e) { DIAG.chainErr = String(e && e.message || e); }
    }

    DIAG.patchCalls++;
    var v = shader.vertexShader, f = shader.fragmentShader, i, ok = true;
    for (i = 0; i < ANCHORS_V.length; i++) if (v.indexOf(ANCHORS_V[i]) < 0) ok = false;
    for (i = 0; i < ANCHORS_F.length; i++) if (f.indexOf(ANCHORS_F[i]) < 0) ok = false;
    if (!MAIN_RE.test(v) || !MAIN_RE.test(f)) ok = false;
    if (!ok) {
      DIAG.anchorsBad++;
      if (DIAG.anchorsBad === 1) warn('shader anchors missing on "' + (this.name || '?') +
        '" -- detail layer skipped for this material');
      return;
    }
    DIAG.anchorsOK++;

    shader.uniforms.uNzA = { value: P.a };
    shader.uniforms.uNzB = { value: P.b };
    shader.uniforms.uNzC = { value: P.c };
    shader.uniforms.uNzD = { value: P.d };
    shader.uniforms.uNzGrime = { value: P.grime };

    v = v.replace(MAIN_RE, VERT_HEAD + '\nvoid main() {');
    v = v.replace('#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  vNzWN = normalize( mat3( modelMatrix ) * objectNormal );');
    v = v.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vNzWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vNzFC = nzFC;');
    f = f.replace(MAIN_RE, FRAG_HEAD + '\nvoid main() {');
    f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + INJ_MAP);
    f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + INJ_ROUGH);
    f = f.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + INJ_METAL);
    f = f.replace('#include <lights_fragment_end>', INJ_AO + '\n#include <lights_fragment_end>');

    /* detail normal: swap every base normal fetch for the two-tap version.
       THE ANCHOR HAS TO BE THE #include DIRECTIVE, NOT THE EXPRESSION.
       The expression `texture2D( normalMap, vUv ).xyz * 2.0 - 1.0` lives
       INSIDE ShaderChunk.normal_fragment_maps, and three resolves #include
       directives in WebGLProgram -- AFTER onBeforeCompile has returned. So at
       this moment shader.fragmentShader still holds the bare directive and the
       expression is not in the source at all: the old test could never match,
       which is exactly why this one substitution reported detailMiss on every
       material in the level while every other anchor in this function (all of
       which target directives) reported OK. nzMapN() was compiled into all 16
       world shaders and never called, and every wall, floor, crate and prop in
       the game rendered with base relief only.

       Fix: expand the chunk OURSELVES, substitute inside the expansion, and
       splice the result in place of the directive. three's resolveIncludes()
       then finds no directive left to expand, and since normal_fragment_maps
       contains no nested #includes the inlined text needs no further work.
       split/join rather than replace() because the chunk carries the same
       expression twice (object-space and tangent-space branches -- only one
       compiles, but both have to parse).

       Both fallbacks are kept honest: if a future three renames the chunk, or
       rewrites that line, or has already expanded the include for us, we take
       whichever path is actually available and otherwise leave the surface on
       its (already correct) base normal and say so. */
    var NRM_INC = '#include <normal_fragment_maps>';
    var NRM_SRC = 'texture2D( normalMap, vUv ).xyz * 2.0 - 1.0';
    var NRM_CHUNK = (THREE.ShaderChunk && THREE.ShaderChunk.normal_fragment_maps) || '';
    if (f.indexOf(NRM_INC) >= 0 && NRM_CHUNK.indexOf(NRM_SRC) >= 0) {
      f = f.split(NRM_INC).join(NRM_CHUNK.split(NRM_SRC).join('nzMapN( vUv )'));
      DIAG.detailOK++;
    } else if (f.indexOf(NRM_SRC) >= 0) {
      /* includes already resolved by something upstream -- substitute direct */
      f = f.split(NRM_SRC).join('nzMapN( vUv )');
      DIAG.detailOK++;
    } else {
      DIAG.detailMiss++;
      if (DIAG.detailMiss === 1) warn('normal-map fetch not found in the r149 shader -- ' +
        'detail normal layer skipped; surfaces keep base relief only');
    }

    shader.vertexShader = v;
    shader.fragmentShader = f;
  }

  /* ======================================================================
     7. material factory
     =================================================================== */
  var MATS = Object.create(null);

  /* Solve the detail layer for one surface, in millimetres end to end.
       rateEff = rate * tile/refTile      keeps the detail at a fixed WORLD
                                          wavelength however the set is retiled
       baseRMS = set.reliefMM * S.nrm     (the tile ratio cancels against
                                          normalScale -- that is the point of
                                          normalising the bake in the first
                                          place)
       amount  = rateEff * detMM / set.reliefMM
     so the detail lands at det[1] millimetres RMS, trimmed by S.nrm along with
     everything else. Clamped at 6 because an amount that large means somebody
     asked a 0.2 mm enamel for centimetre grain and the answer is no. */
  function detailVec(S, set) {
    var rate = (S.det && S.det[0] > 0) ? S.det[0] : 0;
    var detMM = (S.det && S.det[1] > 0) ? S.det[1] : 0;
    var polish = S.polish > 0 ? S.polish : 0;
    if (!GLSL_OK || rate <= 0 || detMM <= 0 || !(set.reliefMM > 0))
      return new THREE.Vector4(1, 0, GLSL_OK ? polish : 0, 0);
    var ratio = (set.refTile > 0 && S.tile > 0) ? S.tile / set.refTile : 1;
    var rateEff = rate * ratio;
    var amount = clamp(rateEff * detMM / set.reliefMM, 0, 6);
    return new THREE.Vector4(rateEff, amount, polish, 0);
  }

  function surfaceMaterial(key, extra) {
    var ck = key + (extra && extra.tag ? '|' + extra.tag : '');
    if (MATS[ck]) return MATS[ck];
    var S = SURF[key];
    if (!S) return null;
    var set = getSet(S.set);
    if (!set) return null;

    var m = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.ormMap,
      metalnessMap: set.ormMap,
      aoMap: set.ormMap,
      color: new THREE.Color(S.tint),
      roughness: 1.0,
      metalness: 1.0,
      vertexColors: true,
      dithering: true,
      fog: true
    });
    m.name = 'nzenv:' + ck;
    m.aoMapIntensity = 0.9;
    m.envMapIntensity = 1.0;
    /* A set is baked for ONE reference tiling (set.refTile) and then reused at
       whatever tile this surface wants -- concrete serves walls at 8 and
       soffits at 10, plywood serves sheeting at 4.2 and crates at 2.6. Stretch
       a normal map without correcting for it and its implied relief stretches
       with it, which is how the same bake ends up meaning 1.4 mm on a wall and
       1.75 mm on a soffit. The ratio puts every reuse back on its millimetre.
       S.nrm is therefore now a pure artistic trim: 1.0 means "as authored". */
    var nsc = S.nrm * (set.refTile > 0 && S.tile > 0 ? set.refTile / S.tile : 1);
    m.normalScale = new THREE.Vector2(nsc, nsc);
    /* This surface's relief is solved in millimetres against a real height
       field; a normal derived from its albedo would be a guess layered on top
       of a measurement. Flag it so any pass that wants to can skip us, and
       keep a reference so auditNormals() can tell if one did not. */
    m.userData.nzNoDerivedNormal = true;
    m.userData.nzReliefMM = set.reliefMM;
    m.__nzOwnNormal = set.normalMap;
    if (extra) {
      if (extra.side !== undefined) m.side = extra.side;
      if (extra.tint !== undefined) m.color.setHex(extra.tint);
      if (extra.rough !== undefined) m.roughness = extra.rough;
      if (extra.metal !== undefined) m.metalness = extra.metal;
    }

    /* the macro period is ~24 world units regardless of the tile size, so
       every surface breaks up at the same architectural scale */
    m.__nzEnv = {
      a: new THREE.Vector4(S.tile / 24, GLSL_OK ? S.macro : 0, S.grime, S.soot),
      b: new THREE.Vector4(S.grimeAmt, S.wetY, S.wet, fin(set.mean, 0.2) || 0.2),
      c: new THREE.Vector4(S.occ === undefined ? 1 : S.occ,
                           clamp((S.desat === undefined ? 0.5 : S.desat) * DESAT, 0, 1),
                           COOL, MACROC),
      d: detailVec(S, set),
      grime: new THREE.Vector3(GRIME_COL[0], GRIME_COL[1], GRIME_COL[2])
    };
    if (GLSL_OK) m.onBeforeCompile = nzEnvPatch;

    OWN.mat.push(m);
    MATS[ck] = m;
    return m;
  }

  /* ======================================================================
     8. geometry toolkit  (own merge / chamfer; examples/js does not exist)
     =================================================================== */
  function Pile() {
    this.p = []; this.nm = []; this.uv = []; this.c = []; this.fc = []; this.idx = [];
    this.n = 0;
    this.ctxF = 0; this.ctxC = 0; this.ctxAmb = AMB_FALLBACK; this.ctxTile = 0.25;
    /* Door and lift piles are authored around the mesh origin because the
       game animates mesh.position. Their vertices are therefore in local
       space, so the baked point-light sample has to be nudged back to where
       the object actually stands or every door takes the lighting of world
       (0,0,0) -- which is inside a wall. */
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
    /* third component is the wall-contact distance used by the floor-junction
       occlusion. Props are already hugging a wall by construction and carry
       their own chamfer AO, so they opt out with a large distance rather than
       inheriting a default 0 and going black along every up-facing facet. */
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
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nm, 3));
    var uv = new THREE.Float32BufferAttribute(this.uv, 2);
    g.setAttribute('uv', uv);
    g.setAttribute('uv2', uv);           /* aoMap reads vUv2; share the buffer */
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('nzFC', new THREE.Float32BufferAttribute(this.fc, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) g.boundingSphere = null;
    OWN.geo.push(g);
    return g;
  };

  /* Emit one planar convex polygon. Winding is derived from a reference
     interior point, so 26 faces of a chamfered box cannot ship one facet
     inside out. UVs are a world-space planar projection on the dominant
     normal axis -- exactly the rule the level surfaces use, so a pipe and the
     wall behind it agree on texel density for free. */
  function poly(pile, pts, rx, ry, rz, ao) {
    var n = pts.length, i;
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
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    var flip = (nx * (cx - rx) + ny * (cy - ry) + nz * (cz - rz)) < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }

    var ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    var mode = (ay >= ax && ay >= az) ? 1 : (ax >= az ? 0 : 2);
    var t = pile.ctxTile;
    /* down-facing polygons read as cavity: cheap contact shading */
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

  /* Chamfered box: 6 faces + 12 edge quads + 8 corner tris. The chamfer is
     the entire point -- a pure 90 degree edge is the number one tell of a
     blockout, and the thin bright line a chamfer catches is what makes trim
     read as trim. */
  function boxC(pile, cx, cy, cz, hx, hy, hz, k, ao) {
    k = Math.min(k, hx * .49, hy * .49, hz * .49);
    var h = [hx, hy, hz], c = [cx, cy, cz];
    function P(axis, s0, s1, s2) {
      var s = [s0, s1, s2], o = [0, 0, 0];
      for (var i = 0; i < 3; i++) o[i] = c[i] + s[i] * (i === axis ? h[i] : h[i] - k);
      return o;
    }
    var S = [-1, 1], i, j, l;
    /* faces */
    for (i = 0; i < 3; i++) for (j = 0; j < 2; j++) {
      var s = S[j], a1 = (i + 1) % 3, a2 = (i + 2) % 3;
      var q = [], sg = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (l = 0; l < 4; l++) {
        var sv = [0, 0, 0]; sv[i] = s; sv[a1] = sg[l][0]; sv[a2] = sg[l][1];
        q.push(P(i, sv[0], sv[1], sv[2]));
      }
      poly(pile, q, cx, cy, cz, ao);
    }
    /* edges: for every pair of axes and sign combination */
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
        poly(pile, q2, cx, cy, cz, ao);
      }
    }
    /* corners */
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var cq = 0; cq < 2; cq++) {
      var t0 = S[a], t1 = S[b], t2 = S[cq];
      poly(pile, [P(0, t0, t1, t2), P(1, t0, t1, t2), P(2, t0, t1, t2)], cx, cy, cz, ao);
    }
  }

  /* Capped tube between two points. Used for every pipe, conduit, rail and
     drum in the level. */
  function tube(pile, ax, ay, az, bx, by, bz, r, seg, ao, cap) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var L = Math.hypot(dx, dy, dz); if (L < 1e-4) return;
    dx /= L; dy /= L; dz /= L;
    var ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > .92) { ux = 1; uy = 0; uz = 0; }
    var px = uy * dz - uz * dy, py = uz * dx - ux * dz, pz = ux * dy - uy * dx;
    var pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
    var qx = dy * pz - dz * py, qy = dz * px - dx * pz, qz = dx * py - dy * px;
    var i, ring0 = [], ring1 = [];
    for (i = 0; i < seg; i++) {
      var t = i / seg * TAU, cs = Math.cos(t) * r, sn = Math.sin(t) * r;
      ring0.push([ax + px * cs + qx * sn, ay + py * cs + qy * sn, az + pz * cs + qz * sn]);
      ring1.push([bx + px * cs + qx * sn, by + py * cs + qy * sn, bz + pz * cs + qz * sn]);
    }
    var mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg;
      poly(pile, [ring0[i], ring0[j], ring1[j], ring1[i]], mx, my, mz, ao);
    }
    if (cap !== false) {
      poly(pile, ring0.slice().reverse(), mx, my, mz, ao);
      poly(pile, ring1.slice(), mx, my, mz, ao);
    }
  }

  /* Flat quad with explicit atlas UVs -- decals only. v = u x n (not n x u):
     on a wall facing -Z with u = +X that gives +Y, so stencilled text lands
     the right way up instead of mirrored. */
  function decalQuad(pile, cx, cy, cz, nx, ny, nz, ux, uy, uz, hw, hh, rect, tintScale) {
    var vx = uy * nz - uz * ny, vy = uz * nx - ux * nz, vz = ux * ny - uy * nx;
    var pts = [
      [cx - ux * hw - vx * hh, cy - uy * hw - vy * hh, cz - uz * hw - vz * hh],
      [cx + ux * hw - vx * hh, cy + uy * hw - vy * hh, cz + uz * hw - vz * hh],
      [cx + ux * hw + vx * hh, cy + uy * hw + vy * hh, cz + uz * hw + vz * hh],
      [cx - ux * hw + vx * hh, cy - uy * hw + vy * hh, cz - uz * hw + vz * hh]
    ];
    var uvs = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
    var col = litAt(cx + nx * .3 + pile.ox, cy + ny * .3 + pile.oy, cz + nz * .3 + pile.oz,
      nx, ny, nz, pile.ctxAmb);
    var s = tintScale === undefined ? 1 : tintScale;
    var base = pile.n, i;
    for (i = 0; i < 4; i++) {
      pile.vert(pts[i][0], pts[i][1], pts[i][2], nx, ny, nz, uvs[i][0], uvs[i][1],
        col[0] * s, col[1] * s, col[2] * s);
    }
    pile.tri(base, base + 1, base + 2);
    pile.tri(base, base + 2, base + 3);
  }

  /* ======================================================================
     9. clearance
     The camera always sits at a legal player centre, which canStand() keeps
     at least PRAD from any solid cell. So anything that stays within
     (PRAD - margin) of a wall plane can never be entered by the camera --
     that is the rule every emitter below is built around.
     =================================================================== */
  var HUG = 0.98;              /* max protrusion from a wall plane (PRAD 1.15) */
  var HUGVIOL = 0;
  /* single source of truth for "how far may this stick out of the wall".
     Anything that trips the clamp is a bug in an emitter, so say so. */
  function hug(d) {
    if (d > HUG) { HUGVIOL++; if (NZ.debug) console.warn('[nz-env] prop depth ' + d.toFixed(2) + ' clamped to ' + HUG); return HUG; }
    return d;
  }
  function jumpTop(f) { return f + 6.7; }   /* eye 2.85 + jump apex 3.44 + margin */

  /* ======================================================================
     10. world mesh upgrade
     =================================================================== */
  function isWorldMerged(o) {
    return !!(o && o.isMesh && o.geometry && o.geometry.attributes &&
      o.geometry.attributes.color && o.geometry.index === null && !o.isInstancedMesh);
  }
  function matKey(m) {
    if (!m || !m.name) return null;
    var s = String(m.name);
    return s.indexOf('world:') === 0 ? s.slice(6) : null;
  }

  /* Distance in world units from a point on the floor to the nearest solid
     cell, capped at CAP. This is the missing half of the contact occlusion:
     the shader already darkens a WALL as it approaches the floor, but the
     floor itself had nothing -- its only contact cue was cornerOcc, and the
     level is one quad per 4-unit cell, so the softest gradient a vertex can
     draw there is four units wide, which reads as a vague stain rather than
     as two surfaces meeting. A distance interpolates linearly across a quad
     and a straight wall really is a linear distance field, so carrying it per
     vertex and running the falloff per pixel gives an exact 1-unit contact
     ramp out of geometry that cannot represent one.
     Cells are searched out to +-2 (8 units), comfortably past the ramp. */
  function wallDist(wx, wz) {
    var CAP = 6;
    var gx = Math.floor(wx / G.CELL), gz = Math.floor(wz / G.CELL);
    var best = CAP * CAP, a, b;
    for (a = -2; a <= 2; a++) for (b = -2; b <= 2; b++) {
      var cx = gx + a, cy = gz + b;
      if (!solidCell(cx, cy)) continue;
      /* distance to that cell's AABB */
      var x0 = cx * G.CELL, x1 = x0 + G.CELL;
      var z0 = cy * G.CELL, z1 = z0 + G.CELL;
      var dx = wx < x0 ? x0 - wx : (wx > x1 ? wx - x1 : 0);
      var dz = wz < z0 ? z0 - wz : (wz > z1 ? wz - z1 : 0);
      var d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; if (best <= 0) return 0; }
    }
    var d = Math.sqrt(best);
    return d > CAP ? CAP : d;
  }

  /* occlusion of a floor/ceiling corner from the four cells that touch it */
  function cornerOcc(wx, wz, refF) {
    var gx = Math.round(wx / G.CELL), gz = Math.round(wz / G.CELL), s = 0;
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) {
      var cx = gx - 1 + a, cy = gz - 1 + b;
      if (solidCell(cx, cy)) { s++; continue; }
      var R = regionAt(cx, cy);
      if (R && R.f > refF + 1.4) s++;
    }
    return s / 4;
  }

  function retargetWorldMesh(mesh, key) {
    var S = SURF[key];
    /* Resolve the replacement material BEFORE touching a single vertex. If a
       bake failed we must leave the mesh exactly as we found it -- half-new
       UVs under the old tiling texture is the one state worse than either. */
    var newMat = surfaceMaterial(key, null);
    if (!newMat) return false;

    var geo = mesh.geometry;
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var colA = geo.attributes.color;
    var n = pos.count;
    var pa = pos.array, na = nrm.array, ca = colA.array;

    var snap = {
      mesh: mesh,
      material: mesh.material,
      uv: geo.attributes.uv || null,
      uv2: geo.attributes.uv2 || null,
      color: new Float32Array(ca)
    };
    OWN.restore.push(snap);

    var uv = new Float32Array(n * 2);
    var fc = new Float32Array(n * 3);
    var wdCache = Object.create(null);        /* floor verts are shared 4-6 ways */
    var inv = 1 / S.tile;
    var CELLSZ = G.CELL;
    var i, t, v, k, _vc = [0, 0, 0];

    for (t = 0; t + 2 < n; t += 3) {
      var nx = na[t * 3], ny = na[t * 3 + 1], nz = na[t * 3 + 2];
      var ccx = (pa[t * 3] + pa[(t + 1) * 3] + pa[(t + 2) * 3]) / 3;
      var ccy = (pa[t * 3 + 1] + pa[(t + 1) * 3 + 1] + pa[(t + 2) * 3 + 1]) / 3;
      var ccz = (pa[t * 3 + 2] + pa[(t + 1) * 3 + 2] + pa[(t + 2) * 3 + 2]) / 3;
      var vertical = Math.abs(ny) > 0.7;
      var sx = ccx + (vertical ? 0 : nx * 0.6);
      var sz = ccz + (vertical ? 0 : nz * 0.6);
      var cx = Math.floor(sx / CELLSZ), cy = Math.floor(sz / CELLSZ);
      var R = regionAt(cx, cy);
      var fY = R ? R.f : 0, cY = R ? R.c : 11;

      for (v = 0; v < 3; v++) {
        i = t + v;
        var x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
        var u0, v0;
        if (vertical) { u0 = x * inv; v0 = z * inv; }
        else if (Math.abs(nx) > Math.abs(nz)) { u0 = z * inv; v0 = y * inv; }
        else { u0 = x * inv; v0 = y * inv; }
        uv[i * 2] = u0; uv[i * 2 + 1] = v0;
        fc[i * 3] = fY; fc[i * 3 + 1] = cY;
        /* only up/down-facing faces need it; a wall's own contact ramp comes
           from its height above the floor, which the shader already has */
        if (vertical) {
          var wk = (x * 0.25) + ':' + (z * 0.25);
          var wd = wdCache[wk];
          if (wd === undefined) wd = wdCache[wk] = wallDist(x, z);
          fc[i * 3 + 2] = wd;
        } else {
          fc[i * 3 + 2] = 9;
        }

        /* contact darkening: floors and ceilings from the four cells that
           share the corner, walls from the perpendicular cell their end runs
           into. This is what a level artist vertex-paints by hand, and it is
           the cheapest realism per byte in the whole module. */
        var ao = 1;
        if (vertical) {
          /* An up-facing quad is one 4-unit cell wide, so its only chance at a
             wall-contact gradient is these four corners -- hence the strength.
             0.40 was invisible in the shipped frame (the floor measured 5%
             darker at the wall than in the open, which reads as nothing). */
          ao = 1 - 0.62 * Math.pow(cornerOcc(x, z, fY), 0.75);
        } else {
          /* a wall whose normal runs along X is a wall that RUNS along Z */
          var alongZ = Math.abs(nx) > Math.abs(nz);
          var coord = alongZ ? z : x;
          var cellIdx = alongZ ? cy : cx;
          var low = (coord / CELLSZ - cellIdx) < 0.5;
          var step = low ? -1 : 1;
          if (solidCell(cx + (alongZ ? 0 : step), cy + (alongZ ? step : 0))) ao = 0.62;
          /* the smooth part of the floor-line darkening is per-pixel in the
             shader (nzOcc); this is just the vertex end of the same ramp */
          if (Math.abs(y - fY) < 0.05) ao *= 0.78;
          if (cY - fY > 0.5 && cY - fY < 21 && Math.abs(y - cY) < 0.05) ao *= 0.86;
        }
        /* No per-cell tone jitter here on purpose: these faces are one quad
           per 4-unit cell, so any per-face constant lands as a hard-edged
           checkerboard at the cell boundaries -- the exact opposite of the
           break-up it is meant to give. The shader's macro layer does that
           job at a scale that ignores the grid. The AO below is a pure
           function of the vertex position, so it stays continuous across
           adjacent quads. */
        k = i * 3;
        _vc[0] = snap.color[k] * ao;
        _vc[1] = snap.color[k + 1] * ao;
        _vc[2] = snap.color[k + 2] * ao;
        desatRGB(_vc);
        ca[k] = _vc[0]; ca[k + 1] = _vc[1]; ca[k + 2] = _vc[2];
      }
    }

    var uvAttr = new THREE.Float32BufferAttribute(uv, 2);
    geo.setAttribute('uv', uvAttr);
    geo.setAttribute('uv2', uvAttr);
    geo.setAttribute('nzFC', new THREE.Float32BufferAttribute(fc, 3));
    colA.needsUpdate = true;

    mesh.material = newMat;
    mesh.receiveShadow = true;
    STATS.meshes++;
    DIAG.surfaces.push({
      mesh: mesh.name || '(unnamed)', key: key, set: S.set,
      tris: (n / 3) | 0, tile: S.tile, macro: S.macro, desat: S.desat, mat: newMat.name
    });
    return true;
  }

  /* ======================================================================
     11. wall-face runs -- the spine of every piece of trim and pipework
     Mirrors buildWorld()'s own wall rule exactly, so trim can never appear
     on an edge that has no wall.
     =================================================================== */
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function wallHere(x, y, d) {
    var t = G.cellAt(x, y);
    if (!openCell(t)) return null;
    if (t === G.S_DOOR || t === G.S_KEY || t === G.S_SECRET) return null;
    var R = regionAt(x, y); if (!R) return null;
    var nt = G.cellAt(x + d[0], y + d[1]);
    if (nt === G.S_SOLID || nt === G.S_EXIT) return { f: R.f, top: R.c, R: R, full: true };
    var NR = regionAt(x + d[0], y + d[1]);
    var nf = NR ? NR.f : 0;
    if (nf > R.f + 0.6) return { f: R.f, top: Math.min(nf, R.c), R: R, full: false };
    return null;
  }

  function collectRuns() {
    var runs = [], di, a, b, cur;
    for (di = 0; di < 4; di++) {
      var d = DIRS[di];
      var alongX = d[0] === 0;         /* wall faces +-Z -> the run goes along X */
      var outer = alongX ? G.MH : G.MW;
      var inner = alongX ? G.MW : G.MH;
      for (a = 0; a < outer; a++) {
        cur = null;
        for (b = 0; b < inner; b++) {
          var x = alongX ? b : a, y = alongX ? a : b;
          var w = wallHere(x, y, d);
          if (w && cur && cur.R === w.R && Math.abs(cur.f - w.f) < 0.01 &&
              Math.abs(cur.top - w.top) < 0.01 && cur.end === b - 1) {
            cur.end = b; continue;
          }
          if (cur) runs.push(cur);
          cur = w ? { d: d, alongX: alongX, a: a, start: b, end: b, f: w.f, top: w.top, R: w.R, full: w.full } : null;
        }
        if (cur) runs.push(cur);
      }
    }
    STATS.runs = runs.length;
    return runs;
  }

  /* world-space frame of a run: the wall plane, the tangent, and the inward
     normal (pointing into the open cell, away from the solid) */
  function runFrame(r) {
    var C = G.CELL;
    var d = r.d;
    var fx, fz, tx = 0, tz = 0, nx = -d[0], nz = -d[1];
    if (r.alongX) {
      /* faces +-Z: plane at z = (a + (d[1]>0?1:0)) * C, tangent along X */
      fz = (r.a + (d[1] > 0 ? 1 : 0)) * C;
      fx = r.start * C;
      tx = 1; tz = 0;
      return { px: fx, pz: fz, tx: tx, tz: tz, nx: 0, nz: nz, len: (r.end - r.start + 1) * C };
    }
    fx = (r.a + (d[0] > 0 ? 1 : 0)) * C;
    fz = r.start * C;
    return { px: fx, pz: fz, tx: 0, tz: 1, nx: nx, nz: 0, len: (r.end - r.start + 1) * C };
  }

  /* Sweep a moulding cross-section along a wall run. profile is a list of
     [out, up] points from the wall face outward; consecutive points become
     quads, the two ends get caps. A skirting board this way is 26 vertices
     instead of the 96 a chamfered box costs, and the profile itself supplies
     the chamfer -- which is the whole reason trim exists in the first place. */
  function sweepProfile(pile, F, baseY, prof, inset) {
    var L = F.len - inset * 2;
    if (L <= 0.25 || prof.length < 2) return;
    var t0 = inset, t1 = inset + L, i;
    function pt(t, p) {
      return [F.px + F.tx * t + F.nx * p[0], baseY + p[1], F.pz + F.tz * t + F.nz * p[0]];
    }
    /* interior reference so poly() can orient every facet outward */
    var mid = (prof[0][1] + prof[prof.length - 1][1]) * 0.5;
    var rx = F.px + F.tx * (t0 + L / 2) - F.nx * 0.5;
    var ry = baseY + mid;
    var rz = F.pz + F.tz * (t0 + L / 2) - F.nz * 0.5;
    for (i = 0; i < prof.length - 1; i++) {
      poly(pile, [pt(t0, prof[i]), pt(t1, prof[i]), pt(t1, prof[i + 1]), pt(t0, prof[i + 1])], rx, ry, rz, 1);
    }
    /* end caps, slightly darker: they only ever show at a run terminus.
       Every profile starts and ends on the wall face (out = 0), so the
       section is already a closed polygon. */
    var capA = [], capB = [];
    for (i = 0; i < prof.length; i++) { capA.push(pt(t0, prof[i])); capB.push(pt(t1, prof[i])); }
    poly(pile, capA, rx, ry, rz, 0.86);
    poly(pile, capB, rx, ry, rz, 0.86);
  }

  /* moulding cross-sections, [out, up] in world units. Every one starts and
     ends at out = 0 (flush to the wall) and ends in a bevel rather than a
     square arris. Max protrusion 0.30, well inside the HUG envelope. */
  /* Scaled up from the first pass. The walls in this level are 12 to 34 units
     tall -- 7 to 20 metres -- and a 0.55-unit band course on a 20 m facade is
     a 3-pixel line at gameplay distance, which is why the shipped frame read
     as bare planes. Every protrusion here is still <= 0.34, comfortably inside
     the HUG envelope (0.98) so nothing can be walked into. */
  var PROF = {
    /* skirting: 0.86 tall, 0.28 proud, splayed top */
    skirt: [[0, 0], [0.28, 0.08], [0.28, 0.64], [0.17, 0.86], [0, 0.86]],
    /* chair rail / dado cap */
    rail: [[0, 0], [0.20, 0.06], [0.24, 0.26], [0.20, 0.44], [0.07, 0.54], [0, 0.54]],
    /* cornice, hung the other way up (grows toward the ceiling) */
    cornice: [[0, 0], [0.12, 0.14], [0.34, 0.42], [0.34, 0.66], [0, 0.76]],
    /* exterior string course / band course */
    band: [[0, 0], [0.34, 0.13], [0.34, 0.62], [0.20, 0.82], [0, 0.82]],
    sill: [[0, 0], [0.26, 0.06], [0.26, 0.24], [0, 0.34]]
  };

  /* ======================================================================
     12. decal atlas
     =================================================================== */
  var DECAL = { tex: null, mat: null, rect: [] };
  function buildDecalAtlas() {
    var res = TIER === 'low' ? 256 : 512;
    var N = 4, ts = res / N;
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, res, res);
    var rnd = NZ.tex.mulberry32(9001);
    function cell(i) { return [(i % N) * ts, Math.floor(i / N) * ts]; }
    /* [uMin, vBottom, uMax, vTop] -- the canvas grows downward and the texture
       is flipY, so the tile's visual top is the LARGER v */
    function push(i) {
      var o = cell(i), pad = ts * 0.012;
      DECAL.rect.push([(o[0] + pad) / res, 1 - (o[1] + ts - pad) / res,
                       (o[0] + ts - pad) / res, 1 - (o[1] + pad) / res]);
    }
    function vgrad(x, y, w, h, col, a0, a1) {
      var gr = g.createLinearGradient(x, y, x, y + h);
      gr.addColorStop(0, 'rgba(' + col + ',' + a0 + ')');
      gr.addColorStop(1, 'rgba(' + col + ',' + a1 + ')');
      g.fillStyle = gr; g.fillRect(x, y, w, h);
    }
    function blob(x, y, r, col, a) {
      var gr = g.createRadialGradient(x, y, r * .1, x, y, r);
      gr.addColorStop(0, 'rgba(' + col + ',' + a + ')');
      gr.addColorStop(.6, 'rgba(' + col + ',' + (a * .5) + ')');
      gr.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    var o, i, j;

    /* 0 dirt streak run-off */
    o = cell(0);
    for (i = 0; i < 22; i++) {
      var sw = ts * (0.012 + rnd() * 0.05), sx = o[0] + ts * (0.06 + rnd() * 0.86);
      var sh = ts * (0.35 + rnd() * 0.6);
      vgrad(sx, o[1] + ts * 0.02, sw, sh, '38,33,27', 0.55 + rnd() * .3, 0);
    }
    blob(o[0] + ts * .5, o[1] + ts * .12, ts * .34, '40,35,28', .45);
    push(0);

    /* 1 water stain */
    o = cell(1);
    for (i = 0; i < 7; i++) blob(o[0] + ts * (.25 + rnd() * .5), o[1] + ts * (.25 + rnd() * .5), ts * (.16 + rnd() * .22), '70,64,50', .30);
    g.strokeStyle = 'rgba(52,46,34,.42)'; g.lineWidth = ts * .018;
    for (i = 0; i < 3; i++) {
      g.beginPath();
      g.ellipse(o[0] + ts * .5, o[1] + ts * .52, ts * (.16 + i * .10), ts * (.13 + i * .09), rnd() * 1, 0, TAU);
      g.stroke();
    }
    push(1);

    /* 2 scuff smear */
    o = cell(2);
    for (i = 0; i < 26; i++) {
      g.strokeStyle = 'rgba(' + (28 + rnd() * 40 | 0) + ',' + (26 + rnd() * 36 | 0) + ',' + (24 + rnd() * 30 | 0) + ',' + (0.14 + rnd() * .3).toFixed(2) + ')';
      g.lineWidth = ts * (0.01 + rnd() * .03);
      var yy = o[1] + ts * (.15 + rnd() * .7);
      g.beginPath(); g.moveTo(o[0] + ts * (.05 + rnd() * .3), yy);
      g.lineTo(o[0] + ts * (.5 + rnd() * .45), yy + ts * (rnd() - .5) * .08);
      g.stroke();
    }
    push(2);

    /* 3 rust bleed */
    o = cell(3);
    for (i = 0; i < 14; i++) {
      vgrad(o[0] + ts * (.1 + rnd() * .78), o[1] + ts * .04, ts * (.02 + rnd() * .05), ts * (.4 + rnd() * .55), '112,62,28', .5 + rnd() * .3, 0);
    }
    blob(o[0] + ts * .5, o[1] + ts * .1, ts * .3, '124,68,30', .5);
    push(3);

    /* 4 graffiti tag A */
    o = cell(4);
    g.save(); g.translate(o[0] + ts * .5, o[1] + ts * .5);
    g.strokeStyle = 'rgba(196,72,54,.85)'; g.lineWidth = ts * .055; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(-ts * .34, ts * .1);
    g.bezierCurveTo(-ts * .2, -ts * .3, ts * .0, ts * .28, ts * .14, -ts * .16);
    g.bezierCurveTo(ts * .22, ts * .1, ts * .3, -ts * .2, ts * .36, ts * .06);
    g.stroke();
    g.strokeStyle = 'rgba(232,220,190,.62)'; g.lineWidth = ts * .018;
    g.beginPath(); g.moveTo(-ts * .3, ts * .22); g.lineTo(ts * .3, ts * .2); g.stroke();
    g.restore();
    push(4);

    /* 5 graffiti block tag */
    o = cell(5);
    g.save(); g.translate(o[0] + ts * .5, o[1] + ts * .5); g.rotate(-0.07);
    for (i = 0; i < 4; i++) {
      g.fillStyle = ['rgba(70,96,138,.80)', 'rgba(186,168,66,.78)', 'rgba(150,60,52,.78)', 'rgba(94,120,84,.74)'][i];
      g.fillRect(-ts * .34 + i * ts * .17, -ts * .16 + (rnd() - .5) * ts * .06, ts * .13, ts * (.24 + rnd() * .14));
    }
    g.strokeStyle = 'rgba(18,16,14,.7)'; g.lineWidth = ts * .022;
    g.strokeRect(-ts * .36, -ts * .2, ts * .72, ts * .4);
    g.restore();
    push(5);

    /* 6 stencil arrow */
    o = cell(6);
    g.save(); g.translate(o[0] + ts * .5, o[1] + ts * .5);
    g.fillStyle = 'rgba(214,208,190,.72)';
    g.beginPath();
    g.moveTo(-ts * .3, -ts * .09); g.lineTo(ts * .06, -ts * .09); g.lineTo(ts * .06, -ts * .24);
    g.lineTo(ts * .34, 0); g.lineTo(ts * .06, ts * .24); g.lineTo(ts * .06, ts * .09);
    g.lineTo(-ts * .3, ts * .09); g.closePath(); g.fill();
    g.restore();
    push(6);

    /* 7 stencil text */
    o = cell(7);
    g.fillStyle = 'rgba(206,202,188,.66)';
    g.font = 'bold ' + Math.round(ts * .30) + 'px monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('SUB-3', o[0] + ts * .5, o[1] + ts * .38);
    g.font = 'bold ' + Math.round(ts * .17) + 'px monospace';
    g.fillText('NO ENTRY', o[0] + ts * .5, o[1] + ts * .66);
    push(7);

    /* 8 hazard chevrons */
    o = cell(8);
    g.save(); g.beginPath(); g.rect(o[0] + ts * .04, o[1] + ts * .3, ts * .92, ts * .4); g.clip();
    g.fillStyle = 'rgba(176,150,44,.88)'; g.fillRect(o[0], o[1] + ts * .3, ts, ts * .4);
    g.fillStyle = 'rgba(24,22,20,.9)';
    for (i = -1; i < 7; i++) {
      g.beginPath();
      var bx = o[0] + i * ts * .17;
      g.moveTo(bx, o[1] + ts * .7); g.lineTo(bx + ts * .085, o[1] + ts * .7);
      g.lineTo(bx + ts * .085 + ts * .12, o[1] + ts * .3); g.lineTo(bx + ts * .12, o[1] + ts * .3);
      g.closePath(); g.fill();
    }
    g.restore();
    push(8);

    /* 9 numbered plate */
    o = cell(9);
    g.fillStyle = 'rgba(88,92,96,.92)';
    g.fillRect(o[0] + ts * .18, o[1] + ts * .24, ts * .64, ts * .5);
    g.strokeStyle = 'rgba(24,26,28,.8)'; g.lineWidth = ts * .02;
    g.strokeRect(o[0] + ts * .18, o[1] + ts * .24, ts * .64, ts * .5);
    g.fillStyle = 'rgba(210,206,196,.9)';
    g.font = 'bold ' + Math.round(ts * .26) + 'px monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('B-14', o[0] + ts * .5, o[1] + ts * .5);
    for (i = 0; i < 4; i++) {
      g.fillStyle = 'rgba(40,42,44,.8)';
      g.beginPath();
      g.arc(o[0] + ts * (i < 2 ? .23 : .77), o[1] + ts * ((i % 2) ? .69 : .29), ts * .022, 0, TAU); g.fill();
    }
    push(9);

    /* 10 crack */
    o = cell(10);
    g.strokeStyle = 'rgba(20,18,16,.62)';
    (function branch(x, y, ang, len, w, depth) {
      if (depth > 3 || len < ts * .04) return;
      g.lineWidth = w;
      var steps = 5, cx2 = x, cy2 = y;
      g.beginPath(); g.moveTo(cx2, cy2);
      for (var s = 0; s < steps; s++) {
        ang += (rnd() - .5) * .8;
        cx2 += Math.cos(ang) * len / steps; cy2 += Math.sin(ang) * len / steps;
        g.lineTo(cx2, cy2);
      }
      g.stroke();
      if (rnd() < .8) branch(cx2, cy2, ang + (rnd() - .5) * 1.2, len * .62, w * .6, depth + 1);
      if (rnd() < .5) branch(cx2, cy2, ang + (rnd() - .5) * 1.6, len * .5, w * .55, depth + 1);
    })(o[0] + ts * .5, o[1] + ts * .05, 1.5, ts * .42, ts * .022, 0);
    push(10);

    /* 11 torn poster */
    o = cell(11);
    g.save(); g.translate(o[0] + ts * .5, o[1] + ts * .5); g.rotate((rnd() - .5) * .1);
    g.fillStyle = 'rgba(178,170,150,.85)';
    g.beginPath();
    g.moveTo(-ts * .28, -ts * .34); g.lineTo(ts * .28, -ts * .32);
    g.lineTo(ts * .26, ts * .3); g.lineTo(-ts * .18, ts * .34);
    g.lineTo(-ts * .3, ts * .04); g.closePath(); g.fill();
    g.fillStyle = 'rgba(120,44,38,.8)'; g.fillRect(-ts * .22, -ts * .26, ts * .44, ts * .1);
    g.fillStyle = 'rgba(52,50,46,.62)';
    for (i = 0; i < 5; i++) g.fillRect(-ts * .22, -ts * .1 + i * ts * .07, ts * (.2 + rnd() * .24), ts * .028);
    g.restore();
    push(11);

    /* 12 oil stain (floor) */
    o = cell(12);
    for (i = 0; i < 9; i++) blob(o[0] + ts * (.3 + rnd() * .4), o[1] + ts * (.3 + rnd() * .4), ts * (.14 + rnd() * .26), '16,15,14', .34);
    for (i = 0; i < 12; i++) blob(o[0] + ts * (.1 + rnd() * .8), o[1] + ts * (.1 + rnd() * .8), ts * (.02 + rnd() * .05), '18,16,14', .4);
    push(12);

    /* 13 floor drain */
    o = cell(13);
    g.fillStyle = 'rgba(46,48,50,.95)';
    g.beginPath(); g.arc(o[0] + ts * .5, o[1] + ts * .5, ts * .34, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(120,126,130,.9)'; g.lineWidth = ts * .03;
    g.beginPath(); g.arc(o[0] + ts * .5, o[1] + ts * .5, ts * .33, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(14,15,16,.95)'; g.lineWidth = ts * .045;
    for (i = -3; i <= 3; i++) {
      g.beginPath();
      var dy = i * ts * .075, dr = Math.sqrt(Math.max(0, (ts * .3) * (ts * .3) - dy * dy));
      g.moveTo(o[0] + ts * .5 - dr, o[1] + ts * .5 + dy);
      g.lineTo(o[0] + ts * .5 + dr, o[1] + ts * .5 + dy);
      g.stroke();
    }
    blob(o[0] + ts * .5, o[1] + ts * .5, ts * .48, '30,30,26', .30);
    push(13);

    /* 14 splatter */
    o = cell(14);
    for (i = 0; i < 30; i++) {
      var r2 = ts * (0.008 + rnd() * rnd() * 0.06);
      g.fillStyle = 'rgba(' + (34 + rnd() * 20 | 0) + ',26,20,' + (0.25 + rnd() * .35).toFixed(2) + ')';
      g.beginPath(); g.arc(o[0] + ts * (.2 + rnd() * .6), o[1] + ts * (.2 + rnd() * .6), r2, 0, TAU); g.fill();
    }
    push(14);

    /* 15 warning triangle */
    o = cell(15);
    g.save(); g.translate(o[0] + ts * .5, o[1] + ts * .5);
    g.fillStyle = 'rgba(184,158,44,.9)';
    g.beginPath(); g.moveTo(0, -ts * .32); g.lineTo(ts * .34, ts * .26); g.lineTo(-ts * .34, ts * .26); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(20,18,16,.9)'; g.lineWidth = ts * .035; g.stroke();
    g.fillStyle = 'rgba(20,18,16,.92)';
    g.fillRect(-ts * .035, -ts * .12, ts * .07, ts * .22);
    g.beginPath(); g.arc(0, ts * .17, ts * .045, 0, TAU); g.fill();
    g.restore();
    push(15);

    /* light aging pass so nothing reads as a crisp sticker */
    var idata = g.getImageData(0, 0, res, res), dd = idata.data;
    for (i = 0, j = 0; j < dd.length; i++, j += 4) {
      var nv = (hash1(i * .173) - .5) * 26;
      dd[j] = clamp(dd[j] + nv, 0, 255);
      dd[j + 1] = clamp(dd[j + 1] + nv, 0, 255);
      dd[j + 2] = clamp(dd[j + 2] + nv, 0, 255);
    }
    g.putImageData(idata, 0, 0);

    DECAL.tex = texCanvas(c, true);
    DECAL.tex.wrapS = DECAL.tex.wrapT = THREE.ClampToEdgeWrapping;
    DECAL.mat = new THREE.MeshStandardMaterial({
      map: DECAL.tex, transparent: true, opacity: 1, alphaTest: 0.02,
      roughness: 0.92, metalness: 0.0, vertexColors: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      fog: true, dithering: true, side: THREE.FrontSide
    });
    DECAL.mat.name = 'nzenv:decal';
    DECAL.mat.envMapIntensity = 0.5;
    OWN.mat.push(DECAL.mat);
  }

  /* ======================================================================
     13. trim, props, fixtures
     =================================================================== */
  var PILES = null;

  function trimStyleFor(R) {
    var w = R.wtex || 'concrete';
    if (w === 'hotelwall') return 'plaster';
    if (w === 'metal' || w === 'grate') return 'steel';
    if (w === 'brick') return 'concreteTrim';
    return 'concreteTrim';
  }

  function buildTrim(runs) {
    var i;
    for (i = 0; i < runs.length; i++) {
      var r = runs[i];
      var R = r.R;
      if (!R) continue;
      var F = runFrame(r);
      var style = trimStyleFor(R);
      var pile = style === 'steel' ? PILES.steel : (style === 'plaster' ? PILES.plaster : PILES.concrete);
      var tile = style === 'steel' ? SURF.metal.tile : (style === 'plaster' ? SURF.hotelwall.tile : SURF.concrete.tile);
      pile.context(r.f, R.sky ? r.f + 200 : R.c, R.amb, tile);

      var interior = !R.sky;
      var height = R.c - r.f;

      /* A "wall" that is only a 1-unit floor step is a stair riser, not a
         wall: trim on it makes no architectural sense, and the player can
         climb it (canStand allows a rise of CLIMB), which puts the camera
         right on top of anything sitting there. Only dress real walls and
         real level changes. */
      var realWall = r.full || (r.top - r.f) > 2.0;

      /* skirting / kick strip. 0.24 proud, 0.62 tall: inside the HUG envelope
         and under the crouched eye line, so the camera can never enter it.
         Outside, a street wall gets a plinth instead -- buildings sit on a
         base course, they do not grow straight out of the asphalt. */
      if (realWall && interior) sweepProfile(pile, F, r.f + 0.01, PROF.skirt, 0);
      else if (r.full && !interior) sweepProfile(pile, F, r.f + 0.01, PROF.band, 0);

      /* chair rail in the finished hotel spaces -- full walls only, it sits
         at eye height and must stay behind the PRAD standoff */
      if (R.wtex === 'hotelwall' && interior && r.full) sweepProfile(pile, F, r.f + 2.55, PROF.rail, 0);

      /* cornice where there is a real ceiling to meet */
      if (interior && r.full && height >= 7.2 && height <= 22) {
        /* anchored off the taller profile so the crown still lands flush with
           the ceiling plane rather than poking through it */
        sweepProfile(pile, F, R.c - 0.78, PROF.cornice, 0);
      }

      /* exterior band courses: a 34-unit brick canyon with nothing crossing it
         reads as a flat backdrop, and these are what real streets have */
      if (!interior && r.full && height > 12) {
        sweepProfile(pile, F, r.f + 8.0, PROF.band, 0);
        if (height > 20) sweepProfile(pile, F, r.f + 15.6, PROF.sill, 0);
      }
    }
  }

  function buildServices(runs) {
    var i, k;
    for (i = 0; i < runs.length; i++) {
      var r = runs[i];
      var R = r.R;
      if (!R || R.sky || !r.full) continue;
      var height = R.c - r.f;
      if (height < 7.4 || height > 24) continue;
      var runLen = r.end - r.start + 1;
      if (runLen < 2) continue;
      var industrial = (R.wtex === 'metal' || R.wtex === 'concrete' || R.ftex === 'grate');
      var seed = r.a * 977 + r.start * 131 + (r.d[0] * 3 + r.d[1] * 7);
      var roll = hash1(seed);
      if (roll > (industrial ? 0.56 : 0.22) * DENSITY + 0.04) continue;

      var F = runFrame(r);
      var pile = industrial ? PILES.rust : PILES.steel;
      var tile = industrial ? SURF.metal.tile * 0.6 : SURF.metal.tile;
      pile.context(r.f, R.c, R.amb, tile);

      /* pipe run just under the ceiling: 0.46 out + 0.26 radius = 0.72 proud,
         inside the 0.98 hug envelope */
      /* vary the height per run: an identical pipe at an identical height on
         every wall is worse than no pipe at all */
      var py = Math.min(R.c - 1.05, r.f + height * (0.64 + hash1(seed + 21) * 0.17));
      var rad = 0.24 + hash1(seed + 3) * 0.12;
      var off = hug(0.46 + rad) - rad;
      var inset = 0.25;
      var L = F.len - inset * 2;
      if (L < 1.2) continue;
      var ax = F.px + F.tx * inset + F.nx * off, az = F.pz + F.tz * inset + F.nz * off;
      var bx = F.px + F.tx * (inset + L) + F.nx * off, bz = F.pz + F.tz * (inset + L) + F.nz * off;
      tube(pile, ax, py, az, bx, py, bz, rad, 8, 1, true);
      if (hash1(seed + 11) < 0.55) {
        var py2 = py - rad * 2.6;
        tube(pile, ax, py2, az, bx, py2, bz, rad * 0.62, 7, 1, true);
      }
      /* brackets every two cells */
      var nBr = Math.max(2, Math.round(L / (G.CELL * 2)));
      for (k = 0; k <= nBr; k++) {
        var t = inset + L * (k / nBr);
        var bxx = F.px + F.tx * t, bzz = F.pz + F.tz * t;
        boxC(pile, bxx + F.nx * off * 0.5, py, bzz + F.nz * off * 0.5,
          F.tx ? 0.09 : off * 0.5 + 0.02, rad + 0.12, F.tz ? 0.09 : off * 0.5 + 0.02, 0.03, 0.95);
      }
      STATS.props++;
    }
  }

  /* wall furniture: vents, junction boxes, conduit drops */
  function buildWallDressing(runs) {
    var i;
    for (i = 0; i < runs.length; i++) {
      var r = runs[i];
      var R = r.R;
      if (!R || !r.full) continue;
      var height = R.c - r.f;
      var F = runFrame(r);
      var runLen = r.end - r.start + 1;
      var base = r.a * 613 + r.start * 271 + (r.d[0] * 5 + r.d[1] * 13);
      for (var c = 0; c < runLen; c++) {
        var seed = base + c * 89;
        var roll = hash1(seed);
        if (roll > 0.24 * DENSITY) continue;
        var t = (c + 0.5) * G.CELL;
        var pick = hash1(seed + 5);
        var industrial = (R.wtex === 'metal' || R.wtex === 'concrete' || R.ftex === 'grate');
        var pile = industrial ? PILES.steel : PILES.plaster;
        pile.context(r.f, R.sky ? r.f + 200 : R.c, R.amb, SURF.metal.tile);
        var wx = F.px + F.tx * t, wz = F.pz + F.tz * t;

        if (pick < 0.34 && height > 7) {
          /* louvred vent high on the wall */
          var vy = Math.min(R.c - 1.3, r.f + height * 0.66);
          var hw = 0.72, hh = 0.5, dep = 0.16;
          boxC(pile, wx + F.nx * dep, vy, wz + F.nz * dep,
            F.tx ? hw : dep, hh, F.tz ? hw : dep, 0.05, 1);
          for (var l = 0; l < 4; l++) {
            var ly = vy - hh + 0.16 + l * 0.24;
            boxC(pile, wx + F.nx * (dep + 0.07), ly, wz + F.nz * (dep + 0.07),
              F.tx ? hw * .82 : 0.05, 0.055, F.tz ? hw * .82 : 0.05, 0.02, 0.85);
          }
          STATS.props++;
        } else if (pick < 0.60) {
          /* junction box + conduit drop to the floor */
          var by = r.f + 2.4 + hash1(seed + 9) * 1.2;
          boxC(pile, wx + F.nx * 0.13, by, wz + F.nz * 0.13,
            F.tx ? 0.34 : 0.13, 0.42, F.tz ? 0.34 : 0.13, 0.05, 1);
          tube(pile, wx + F.nx * 0.10, by - 0.42, wz + F.nz * 0.10,
            wx + F.nx * 0.10, r.f + 0.05, wz + F.nz * 0.10, 0.065, 6, 0.9, true);
          if (!R.sky && height < 22) {
            tube(pile, wx + F.nx * 0.10, by + 0.42, wz + F.nz * 0.10,
              wx + F.nx * 0.10, R.c - 0.3, wz + F.nz * 0.10, 0.065, 6, 0.9, true);
          }
          STATS.props++;
        } else if (pick < 0.78 && !R.sky) {
          /* floor-standing drum, hugging the wall: outer face lands at 0.96
             from the wall plane, and a legal camera position is never closer
             than PRAD (1.15), so it cannot be walked into */
          var dr = 0.46, dh = 1.28, dOff = hug(dr * 2 + 0.04) - dr;
          var dx = wx + F.nx * dOff, dz = wz + F.nz * dOff;
          var pl2 = PILES.rust;
          pl2.context(r.f, R.c, R.amb, SURF.metal.tile * 0.55);
          tube(pl2, dx, r.f + 0.03, dz, dx, r.f + dh, dz, dr, 12, 1, true);
          tube(pl2, dx, r.f + dh * 0.24, dz, dx, r.f + dh * 0.24 + 0.10, dz, dr * 1.06, 12, 0.9, false);
          tube(pl2, dx, r.f + dh * 0.72, dz, dx, r.f + dh * 0.72 + 0.10, dz, dr * 1.06, 12, 0.9, false);
          STATS.props++;
        } else if (pick < 0.90 && !R.sky) {
          /* leaning pallet / timber stack */
          var pw = PILES.wood;
          pw.context(r.f, R.c, R.amb, SURF.wood.tile * 0.5);
          var stack = 2 + Math.floor(hash1(seed + 17) * 3);
          var pOff = hug(0.94) - 0.42;
          for (var s2 = 0; s2 < stack; s2++) {
            boxC(pw, wx + F.nx * pOff, r.f + 0.12 + s2 * 0.26, wz + F.nz * pOff,
              F.tx ? 0.85 : 0.42, 0.11, F.tz ? 0.85 : 0.42, 0.035, 1);
          }
          STATS.props++;
        }
      }
    }
  }

  /* ---- door frames ------------------------------------------------------ */
  function buildDoorFrames() {
    if (!G.DOORS) return;
    var C = G.CELL;
    for (var i = 0; i < G.DOORS.length; i++) {
      var d = G.DOORS[i];
      if (d.secret) continue;
      var R = regionAt(d.cx, d.cy); if (!R) continue;
      var wx = d.cx * C + C / 2, wz = d.cy * C + C / 2;
      var alongX = solidCell(d.cx - 1, d.cy) && solidCell(d.cx + 1, d.cy);
      var h = fin(d.h, Math.min(R.c, 8.2));
      var pile = PILES.steel;
      pile.context(R.f, R.c, R.amb, SURF.metal.tile);
      var jamb = 0.26, half = C / 2;
      /* two jambs against the flanking solid cells + a head over the opening */
      for (var s = -1; s <= 1; s += 2) {
        if (alongX) {
          boxC(pile, wx + s * (half - jamb / 2), R.f + h / 2, wz, jamb / 2, h / 2 + 0.1, 0.62, 0.05, 1);
        } else {
          boxC(pile, wx, R.f + h / 2, wz + s * (half - jamb / 2), 0.62, h / 2 + 0.1, jamb / 2, 0.05, 1);
        }
      }
      if (alongX) boxC(pile, wx, R.f + h + 0.18, wz, half, 0.26, 0.62, 0.06, 1);
      else boxC(pile, wx, R.f + h + 0.18, wz, 0.62, 0.26, half, 0.06, 1);
      /* threshold plate */
      if (alongX) boxC(pile, wx, R.f + 0.035, wz, half - 0.1, 0.035, 0.42, 0.02, 1);
      else boxC(pile, wx, R.f + 0.035, wz, 0.42, 0.035, half - 0.1, 0.02, 1);
      STATS.props++;
    }
  }

  /* ---- light fixtures ---------------------------------------------------- */
  function buildFixtures() {
    if (!G.LIGHTS) return;
    var C = G.CELL, i;
    for (i = 0; i < G.LIGHTS.length; i++) {
      var L = G.LIGHTS[i];
      var cx = Math.floor(L.x / C), cy = Math.floor(L.z / C);
      if (!G.inb(cx, cy) || solidCell(cx, cy)) continue;
      if (liftCell(cx, cy)) continue;
      var R = regionAt(cx, cy); if (!R) continue;
      if (L.y < R.f - 1 || L.y > R.c + 1) continue;   /* outside the room entirely */
      /* The 30-46 unit lights are the moon and sky wash the level author put
         in for atmosphere. They have no physical source and must not get a
         fixture; every real lamp in this level has a radius of 26 or less. */
      if (fin(L.r, 0) >= 30) continue;
      var lc = L.c || [1, .9, .7];
      var pile = PILES.steel;
      pile.context(R.f, R.sky ? R.f + 200 : R.c, R.amb, SURF.metal.tile);
      var lens = PILES.lens;
      lens.context(R.f, R.c, R.amb, 4);
      var glow = 1.55 + fin(L.i, .8) * 0.9;

      if (!R.sky && R.c - R.f <= 24) {
        /* ceiling pan, dropped on a stem if the light sits low */
        var cy2 = R.c - 0.18;
        var drop = clamp(cy2 - Math.max(L.y, jumpTop(R.f) + 0.4), 0, 2.2);
        var fy = cy2 - drop;
        if (drop > 0.25) {
          tube(pile, L.x, cy2, L.z, L.x, fy + 0.16, L.z, 0.055, 6, .9, true);
        }
        boxC(pile, L.x, fy, L.z, 0.95, 0.16, 0.34, 0.05, 1);
        boxC(pile, L.x, fy - 0.06, L.z, 1.02, 0.05, 0.40, 0.03, 1);
        emissivePanel(lens, L.x, fy - 0.13, L.z, 0.80, 0.27, lc, glow, 'down');
        STATS.fixtures++;
      } else {
        /* Exterior. Nearly every street lamp in this level sits in the middle
           of the road with no wall within a cell of it, so a wall bracket
           reaches nothing -- hence the catenary: a cable strung from the
           facade to a hanging cowl, which is what a real narrow street looks
           like (and what Inferno and Overpass do). Everything here lives 8+
           units up, far above the jump apex. */
        /* Floor is the jump apex plus the housing depth: outdoors there is no
           ceiling to hide behind, and a rooftop lamp authored at f+3 would sit
           exactly where a jumping player's camera passes through. */
        var ly = clamp(L.y, jumpTop(R.f) + 0.7, R.f + 22);
        var anchors = [], k, n;
        for (k = 0; k < 4; k++) {
          var d = DIRS[k];
          for (n = 1; n <= 5; n++) {
            if (!G.inb(cx + d[0] * n, cy + d[1] * n)) break;
            if (solidCell(cx + d[0] * n, cy + d[1] * n)) {
              var pxA = (cx + d[0] * n + (d[0] > 0 ? 0 : 1)) * C;
              var pzA = (cy + d[1] * n + (d[1] > 0 ? 0 : 1)) * C;
              anchors.push({
                x: d[0] !== 0 ? pxA : L.x, z: d[1] !== 0 ? pzA : L.z,
                nx: -d[0], nz: -d[1], n: n
              });
              break;
            }
          }
        }
        if (!anchors.length) continue;
        anchors.sort(function (p, q) { return p.n - q.n; });
        var A = anchors[0];
        if (A.n <= 1) {
          /* wall close enough for a rigid bracket arm */
          boxC(pile, A.x + A.nx * 0.12, ly, A.z + A.nz * 0.12,
            A.nx ? 0.12 : 0.26, 0.30, A.nz ? 0.12 : 0.26, 0.04, 1);
          tube(pile, A.x + A.nx * 0.14, ly, A.z + A.nz * 0.14,
            A.x + A.nx * 0.86, ly + 0.22, A.z + A.nz * 0.86, 0.075, 6, .95, true);
          boxC(pile, A.x + A.nx * 0.94, ly + 0.26, A.z + A.nz * 0.94, 0.36, 0.14, 0.36, 0.05, 1);
          emissivePanel(lens, A.x + A.nx * 0.94, ly + 0.12, A.z + A.nz * 0.94, 0.28, 0.28, lc, glow, 'down');
        } else {
          /* catenary: cable(s) from the facade(s) down to a hanging cowl */
          var hy = ly + 0.44;
          var use = anchors.length > 1 ? 2 : 1;
          for (k = 0; k < use; k++) {
            var Ak = anchors[k];
            boxC(pile, Ak.x + Ak.nx * 0.10, hy + 1.5, Ak.z + Ak.nz * 0.10,
              Ak.nx ? 0.10 : 0.20, 0.20, Ak.nz ? 0.10 : 0.20, 0.03, 1);
            tube(pile, Ak.x + Ak.nx * 0.14, hy + 1.5, Ak.z + Ak.nz * 0.14,
              L.x, hy + 0.55, L.z, 0.045, 5, .9, true);
          }
          tube(pile, L.x, hy + 0.60, L.z, L.x, hy + 0.08, L.z, 0.05, 5, .9, true);
          /* conical cowl */
          tube(pile, L.x, hy + 0.10, L.z, L.x, hy - 0.16, L.z, 0.42, 10, 1, true);
          boxC(pile, L.x, hy - 0.20, L.z, 0.36, 0.05, 0.36, 0.03, 1);
          emissivePanel(lens, L.x, hy - 0.26, L.z, 0.30, 0.30, lc, glow, 'down');
        }
        STATS.fixtures++;
      }
    }
  }

  /* a small unlit emissive card: this is the visible SOURCE for each light */
  function emissivePanel(pile, x, y, z, hw, hh, col, gain, facing) {
    var r = clamp(col[0] * gain, 0, 6), g = clamp(col[1] * gain, 0, 6), b = clamp(col[2] * gain, 0, 6);
    var base = pile.n, i;
    var pts;
    if (facing === 'down') {
      pts = [[x - hw, y, z - hh], [x + hw, y, z - hh], [x + hw, y, z + hh], [x - hw, y, z + hh]];
      for (i = 0; i < 4; i++) pile.vert(pts[i][0], pts[i][1], pts[i][2], 0, -1, 0, 0, 0, r, g, b);
      pile.tri(base, base + 1, base + 2); pile.tri(base, base + 2, base + 3);
    }
  }

  /* ---- crates: 22 individual meshes become one merged, chamfered pile ---- */
  /* Per-crate index/vertex ranges in that merged pile, recorded so a
     destruction module can knock ONE crate out of it (degenerate its index
     range) instead of orphan-removing a stock mesh that is no longer drawn.
     Published as NZ.env.crates = { mesh, ranges } after makeMesh below. */
  var CRATE_RANGES = [];
  function rebuildCrates(crateMeshes) {
    if (!G.CRATES || !G.CRATES.length) return;
    var C = G.CELL, pile = PILES.crate, i;
    for (i = 0; i < G.CRATES.length; i++) {
      var c = G.CRATES[i];
      var R = regionAt(c[0], c[1]); if (!R) continue;
      var i0 = pile.idx.length, n0 = pile.n;
      CRATE_RANGES.push({ cx: c[0], cy: c[1], start: i0, end: 0, v0: n0, v1: 0 });
      var wx = c[0] * C + C / 2, wz = c[1] * C + C / 2;
      pile.context(R.f, R.sky ? R.f + 200 : R.c, R.amb, SURF.crate.tile);
      /* the footprint and 3.4-unit height match the stock crate exactly, so
         the waist-high cover the level design relies on is unchanged */
      var hw = C * 0.46, hh = 1.70, bt = 0.075, s, t;
      var jitter = (hash1(i * 3.7) - 0.5) * 0.06;
      var cxp = wx + jitter, czp = wz + jitter * 0.7;
      var variant = Math.floor(hash1(i * 5.3 + 1.1) * 3);

      if (variant === 1) {
        /* two stacked cases, the upper one inset and nudged off-square:
           merged geometry cannot be rotated per instance, so the silhouette
           variety has to come from the composition */
        var ox2 = (hash1(i * 7.7) - 0.5) * 0.34, oz2 = (hash1(i * 9.1) - 0.5) * 0.34;
        boxC(pile, cxp, R.f + hh * 0.5, czp, hw, hh * 0.5, hw, 0.09, 1);
        boxC(pile, cxp + ox2, R.f + hh * 1.5, czp + oz2, hw * 0.82, hh * 0.5, hw * 0.82, 0.09, 1);
        boxC(pile, cxp, R.f + hh * 0.98, czp, hw + bt * .5, 0.09, hw + bt * .5, 0.03, 0.92);
        for (s = -1; s <= 1; s += 2) for (t = -1; t <= 1; t += 2) {
          boxC(pile, cxp + s * hw, R.f + hh * 0.5, czp + t * hw, bt, hh * 0.48, bt, 0.03, 0.9);
        }
      } else {
        boxC(pile, cxp, R.f + hh, czp, hw, hh, hw, 0.10, 1);
        /* corner banding: real crates have edge protection, and the extra
           silhouette break is what stops them reading as grey cubes */
        boxC(pile, cxp, R.f + hh * 0.32, czp, hw + bt * .5, 0.10, hw + bt * .5, 0.03, 0.94);
        boxC(pile, cxp, R.f + hh * 1.68, czp, hw + bt * .5, 0.10, hw + bt * .5, 0.03, 0.94);
        for (s = -1; s <= 1; s += 2) for (t = -1; t <= 1; t += 2) {
          boxC(pile, cxp + s * hw, R.f + hh, czp + t * hw, bt, hh * 0.98, bt, 0.03, 0.92);
        }
        if (variant === 2) {
          /* a smaller case tipped on top, breaking the flat lid */
          boxC(pile, cxp + 0.30, R.f + hh * 2 + 0.42, czp - 0.22, hw * 0.46, 0.42, hw * 0.52, 0.06, 1);
        }
      }
      var rng = CRATE_RANGES[CRATE_RANGES.length - 1];
      rng.end = pile.idx.length; rng.v1 = pile.n;
      STATS.props++;
    }
    void crateMeshes;
  }

  /* ---- decal placement --------------------------------------------------- */
  function placeDecals(runs) {
    if (!DECAL.mat) return;
    var pile = PILES.decal, i, C = G.CELL;
    var FLOOR_D = [12, 13, 14, 1];
    for (i = 0; i < runs.length; i++) {
      var r = runs[i];
      var R = r.R; if (!R || !r.full) continue;
      var F = runFrame(r);
      var runLen = r.end - r.start + 1;
      var height = R.c - r.f;
      var base = r.a * 401 + r.start * 173 + (r.d[0] * 11 + r.d[1] * 29);
      for (var c = 0; c < runLen; c++) {
        var seed = base + c * 61;
        var n = hash1(seed) < 0.55 * DENSITY ? 1 : 0;
        if (!n) continue;
        var t = (c + 0.2 + hash1(seed + 1) * 0.6) * C;
        var wx = F.px + F.tx * t + F.nx * 0.055;
        var wz = F.pz + F.tz * t + F.nz * 0.055;
        var pick = hash1(seed + 2);
        var id, sz, yy;
        /* Weighted toward weathering, not signage. Dirt is everywhere in a
           real space; a stencilled plaque every eight units is set dressing
           gone wrong, so signage gets 8% and the streaks get the rest. */
        if (pick < 0.42) {                       /* grime at the floor line */
          id = pick < 0.21 ? 0 : 2;
          sz = 1.5 + hash1(seed + 3) * 1.4;
          yy = r.f + sz * 0.75;
        } else if (pick < 0.66 && height > 8) {  /* run-off from above */
          id = hash1(seed + 4) < 0.5 ? 0 : 3;
          sz = 2.2 + hash1(seed + 5) * 2.2;
          yy = r.f + Math.min(height - 1.2, 6.5 + hash1(seed + 6) * 5);
        } else if (pick < 0.74) {                /* signage / plates at eye line */
          id = [6, 7, 9, 15][Math.floor(hash1(seed + 7) * 4) % 4];
          sz = 1.0 + hash1(seed + 8) * 0.7;
          yy = r.f + 3.1 + hash1(seed + 9) * 1.4;
        } else if (pick < 0.86 && (R.sky || R.wtex === 'concrete')) {
          id = hash1(seed + 10) < 0.5 ? 4 : 5;   /* graffiti where it belongs */
          sz = 1.8 + hash1(seed + 11) * 1.6;
          yy = r.f + 2.6 + hash1(seed + 12) * 1.8;
        } else {
          id = [1, 10, 11, 14][Math.floor(hash1(seed + 13) * 4) % 4];
          sz = 1.3 + hash1(seed + 14) * 1.5;
          yy = r.f + 1.6 + hash1(seed + 15) * Math.min(4, height * .4);
        }
        if (yy - sz * 0.5 < r.f + 0.05) yy = r.f + sz * 0.5 + 0.05;
        if (yy + sz * 0.5 > r.f + height - 0.1) continue;
        pile.context(r.f, R.sky ? r.f + 200 : R.c, R.amb, 4);
        decalQuad(pile, wx, yy, wz, F.nx, 0, F.nz, F.tx, 0, F.tz,
          sz * 0.5, sz * 0.5, DECAL.rect[id], 1);
        STATS.decals++;
      }
    }
    /* floor decals: only in cells the player will actually cross */
    for (var y = 0; y < G.MH; y++) for (var x = 0; x < G.MW; x++) {
      var tt = G.cellAt(x, y);
      if (!openCell(tt) || tt === G.S_BLOCK) continue;
      if (liftCell(x, y)) continue;
      var Rg = regionAt(x, y); if (!Rg) continue;
      var sd = x * 733 + y * 197;
      if (hash1(sd) > 0.16 * DENSITY) continue;
      var idf = FLOOR_D[Math.floor(hash1(sd + 3) * FLOOR_D.length) % FLOOR_D.length];
      var szf = 1.8 + hash1(sd + 4) * 1.6;
      var fx = x * C + C * (0.3 + hash1(sd + 5) * 0.4);
      var fz = y * C + C * (0.3 + hash1(sd + 6) * 0.4);
      PILES.decal.context(Rg.f, Rg.sky ? Rg.f + 200 : Rg.c, Rg.amb, 4);
      decalQuad(PILES.decal, fx, Rg.f + 0.045, fz, 0, 1, 0, 1, 0, 0,
        szf * 0.5, szf * 0.5, DECAL.rect[idf], 1);
      STATS.decals++;
    }
  }

  /* ======================================================================
     14. doors, lifts
     =================================================================== */
  /* A pushwall has to read as the wall it is hiding, so it borrows the wtex
     of the first VISIBLE room next to it -- exactly what makeDoorMeshes does.
     Taking the secret cell's own region instead would paint every pushwall in
     the hidden room's stone and give the secret away. */
  function secretWallKey(d) {
    for (var k = 0; k < 4; k++) {
      var nx = d.cx + DIRS[k][0], ny = d.cy + DIRS[k][1];
      if (solidCell(nx, ny)) continue;
      var rr2 = regionAt(nx, ny);
      if (rr2 && !rr2.hidden && SURF[rr2.wtex]) return rr2.wtex;
    }
    var R = regionAt(d.cx, d.cy);
    return (R && SURF[R.wtex]) ? R.wtex : 'concrete';
  }

  function upgradeDoors() {
    if (!G.DOORS) return;
    for (var i = 0; i < G.DOORS.length; i++) {
      var d = G.DOORS[i];
      var m = d.mesh;
      if (!m || !m.isMesh) continue;
      var R = regionAt(d.cx, d.cy); if (!R) continue;
      var key = d.secret ? secretWallKey(d) : (d.kind === 'key' ? 'keydoor' : 'door');
      if (!SURF[key]) key = 'door';
      var mat = surfaceMaterial(key, null);
      if (!mat) continue;

      var h = fin(d.h, Math.min(R.c, 8.2));
      var alongX = d.axis ? d.axis === 'x' : (solidCell(d.cx - 1, d.cy) && solidCell(d.cx + 1, d.cy));
      var halfW = (alongX ? G.CELL : 0.7) / 2;
      var halfD = (alongX ? 0.7 : G.CELL) / 2;

      var pile = new Pile();
      /* span 0: doors travel, so the shader's world-space floor grime would
         slide down the leaf as it opens. The baked material carries the dirt
         for anything that moves. */
      pile.context(0, 0, R.amb, SURF[key].tile);
      pile.origin(m.position.x, m.position.y, m.position.z);
      /* built around the mesh origin: the game moves d.mesh.position */
      boxC(pile, 0, 0, 0, halfW, h / 2, halfD, 0.09, 1);

      if (!d.secret) {
        /* raised leaf panels on both faces -- thickness in the silhouette */
        var pw = (alongX ? halfW : halfD) * 0.62;
        var ph = h * 0.30;
        for (var s = -1; s <= 1; s += 2) {
          var oz = alongX ? halfD * 0.88 * s : 0;
          var ox = alongX ? 0 : halfW * 0.88 * s;
          boxC(pile, ox, -h * 0.20, oz, alongX ? pw : 0.07, ph * 0.5, alongX ? 0.07 : pw, 0.03, 0.92);
          boxC(pile, ox, h * 0.22, oz, alongX ? pw : 0.07, ph * 0.5, alongX ? 0.07 : pw, 0.03, 0.92);
        }
        /* mid rail standing proud of BOTH faces, so the scale of a 4.9 m
           blast door reads as a door and not as a wall panel */
        boxC(pile, 0, h * 0.02, 0,
          alongX ? halfW * 0.94 : halfW * 1.06, 0.13,
          alongX ? halfD * 1.06 : halfD * 0.94, 0.04, 0.95);
      }

      var geo = pile.geometry();
      var oldGeo = m.geometry, oldMat = m.material;
      m.geometry = geo;
      m.material = mat;
      m.castShadow = true; m.receiveShadow = true;
      OWN.restore.push({ mesh: m, material: oldMat, geometry: oldGeo });
    }
  }

  function upgradeLifts() {
    if (!G.LIFTS) return;
    for (var i = 0; i < G.LIFTS.length; i++) {
      var L = G.LIFTS[i];
      var m = L.mesh;
      if (!m || !m.isMesh) continue;
      var mat = surfaceMaterial('grate', null);
      if (!mat) continue;
      var w = (L.x1 - L.x0 + 1) * G.CELL, dd = (L.y1 - L.y0 + 1) * G.CELL;
      var R = regionAt(L.x0, L.y0) || { f: 0, c: 11, amb: AMB_FALLBACK };
      var pile = new Pile();
      /* span 0 for the same reason as doors: a lift deck moves 12 units */
      pile.context(0, 0, R.amb, SURF.grate.tile);
      pile.origin(m.position.x, L.hi, m.position.z);
      boxC(pile, 0, 0, 0, w * 0.48, 0.25, dd * 0.48, 0.07, 1);
      /* kerb rail around the platform edge */
      var kb = 0.10;
      boxC(pile, 0, 0.30, -dd * 0.48 + kb, w * 0.48, 0.10, kb, 0.03, 0.95);
      boxC(pile, 0, 0.30, dd * 0.48 - kb, w * 0.48, 0.10, kb, 0.03, 0.95);
      boxC(pile, -w * 0.48 + kb, 0.30, 0, kb, 0.10, dd * 0.48, 0.03, 0.95);
      boxC(pile, w * 0.48 - kb, 0.30, 0, kb, 0.10, dd * 0.48, 0.03, 0.95);
      var geo = pile.geometry();
      var oldGeo = m.geometry, oldMat = m.material;
      m.geometry = geo; m.material = mat;
      m.castShadow = true; m.receiveShadow = true;
      OWN.restore.push({ mesh: m, material: oldMat, geometry: oldGeo });
    }
  }

  /* ======================================================================
     15. install
     =================================================================== */
  function makeMesh(pile, mat, name, cast) {
    if (!pile || pile.empty() || !mat) {
      DIAG.piles.push({ name: name, verts: pile ? pile.n : 0, tris: 0, mat: mat ? mat.name : null, added: false });
      return null;
    }
    var m = new THREE.Mesh(pile.geometry(), mat);
    m.name = name;
    m.castShadow = !!cast;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    scene.add(m);
    OWN.obj.push(m);
    STATS.addedCalls++;
    DIAG.piles.push({ name: name, verts: pile.n, tris: (pile.idx.length / 3) | 0, mat: mat.name, added: true });
    return m;
  }

  /* Verify nothing has re-derived a normal map onto a material we own, and
     that the relief we shipped is the relief we authored. Reported through
     DIAG so ?nzdiag=1 and NZ.env.report() both show it. */
  function auditNormals() {
    var ours = 0, hijacked = 0, i;
    for (i = 0; i < OWN.mat.length; i++) {
      var m = OWN.mat[i];
      if (!m || !m.__nzEnv) continue;
      ours++;
      if (m.normalMap && m.__nzOwnNormal && m.normalMap !== m.__nzOwnNormal) {
        hijacked++;
        m.normalMap = m.__nzOwnNormal;              /* take it back */
        m.needsUpdate = true;
      }
    }
    DIAG.normalAudit = { materials: ours, hijacked: hijacked };
    if (hijacked) warn(hijacked + ' of ' + ours + ' env materials had their normal map ' +
      'replaced after bake (a derived-normal pass ran over us); restored ours');
  }

  function install(ctx) {
    if (dead || installed) return;
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    THREE = (ctx && ctx.THREE) || NZ.ctx.THREE || global.THREE;
    scene = (ctx && ctx.scene) || NZ.ctx.scene;
    renderer = (ctx && ctx.renderer) || NZ.ctx.renderer;
    if (!THREE || !scene || !renderer) throw new Error('nz-env: renderer context missing');

    G = bindGame();
    if (!G) { NZ.log('env: game level globals unavailable, module inert'); panic(null); return; }

    applyTier();
    try { ANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } catch (e) { ANISO = 8; }
    GLSL_OK = validateGLSL();
    DIAG.glslProbe = GLSL_OK;
    /* with the shader live it only needs to take the edge off the specular
       tint; without it, the vertex colours are the ONLY place the level's warm
       cast can be pulled out at all */
    VDESAT = GLSL_OK ? 0.15 : 0.55;
    if (!GLSL_OK) warn('shader detail layer disabled (GLSL probe failed); materials still upgrade, vertex fallback engaged');

    /* ---- 1. find the level --------------------------------------------
       makeWorldMaterial() in NUKEM.html names every level material
       'world:<texture>'. nz-render's own 'ready' has already swapped those
       MeshPhongMaterials for MeshStandardMaterials but kept the names, which
       is exactly why this module registers at priority -20. The merged level
       meshes are the ones carrying a vertex-colour attribute and no index;
       doors, lifts and crates are indexed BoxGeometry with the same naming. */
    var worldMeshes = [], crateMeshes = [];
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      var key = matKey(o.material);
      if (!key) return;
      if (isWorldMerged(o)) worldMeshes.push({ mesh: o, key: key });
      else if (key === 'crate') crateMeshes.push(o);
    });
    if (!worldMeshes.length) { NZ.log('env: no world meshes matched, module inert'); panic(null); return; }

    /* ---- 2. materials + world-space UVs ------------------------------- */
    var upgraded = 0;
    for (var i = 0; i < worldMeshes.length; i++) {
      var w = worldMeshes[i];
      if (!SURF[w.key]) {                         /* e.g. 'switch': leave alone */
        DIAG.skipped.push({ mesh: w.mesh.name || '(unnamed)', key: w.key, why: 'no SURF entry (kept stock)' });
        continue;
      }
      if (retargetWorldMesh(w.mesh, w.key)) upgraded++;
      else DIAG.skipped.push({ mesh: w.mesh.name || '(unnamed)', key: w.key, why: 'material bake failed' });
    }
    if (!upgraded) { NZ.log('env: nothing upgraded'); panic(null); return; }

    /* ---- 3. detail geometry ------------------------------------------- */
    buildDecalAtlas();
    PILES = {
      concrete: new Pile(), plaster: new Pile(), steel: new Pile(),
      rust: new Pile(), wood: new Pile(), crate: new Pile(),
      lens: new Pile(), decal: new Pile()
    };

    var runs = collectRuns();
    buildTrim(runs);
    buildServices(runs);
    buildWallDressing(runs);
    buildDoorFrames();
    buildFixtures();
    rebuildCrates(crateMeshes);
    placeDecals(runs);

    var mConcrete = surfaceMaterial('concrete', null);
    var mPlaster = surfaceMaterial('hotelwall', null);
    var mSteel = surfaceMaterial('metal', null);
    var mWood = surfaceMaterial('wood', null);
    var mCrate = surfaceMaterial('crate', null);
    var mRust = makeRustMaterial();

    makeMesh(PILES.concrete, mConcrete, 'nzenv-trim-concrete', false);
    makeMesh(PILES.plaster, mPlaster, 'nzenv-trim-plaster', false);
    makeMesh(PILES.steel, mSteel, 'nzenv-detail-steel', true);
    makeMesh(PILES.rust, mRust, 'nzenv-detail-rust', true);
    makeMesh(PILES.wood, mWood, 'nzenv-detail-wood', true);
    var crateMesh = makeMesh(PILES.crate, mCrate, 'nzenv-crates', true);
    if (crateMesh && NZ) {
      /* handed to nz-destruct.js: the mesh whose triangles a crate hit should
         decal against, and the range to degenerate when one breaks */
      NZ.envCrates = { mesh: crateMesh, ranges: CRATE_RANGES };
    }
    makeMesh(PILES.decal, DECAL.mat, 'nzenv-decals', false);

    if (!PILES.lens.empty()) {
      var lensMat = new THREE.MeshBasicMaterial({
        vertexColors: true, fog: true, side: THREE.DoubleSide, dithering: true
      });
      lensMat.name = 'nzenv:lens';
      OWN.mat.push(lensMat);
      var lm = new THREE.Mesh(PILES.lens.geometry(), lensMat);
      lm.name = 'nzenv-lenses';
      lm.matrixAutoUpdate = false; lm.updateMatrix();
      scene.add(lm); OWN.obj.push(lm);
      STATS.addedCalls++;
    }

    /* the 22 stock crate meshes are now one merged pile: 22 draw calls gone */
    for (i = 0; i < crateMeshes.length; i++) {
      var cm = crateMeshes[i];
      OWN.restore.push({ readd: cm, parent: cm.parent || scene });
      if (cm.parent) cm.parent.remove(cm);
      STATS.removedCalls++;
    }

    /* ---- 4. doors and lifts ------------------------------------------- */
    upgradeDoors();
    upgradeLifts();

    /* ---- 4b. normal-map audit ------------------------------------------
       nz-render.js runs a global pass that derives a normal map by Sobel-
       filtering each material's ALBEDO and hangs it on the material. On a
       hand-painted or blotchy albedo that produces exactly the embossed blobs
       this module was just accused of, so it is worth being explicit about why
       our surfaces are not double-mapped:

         - that pass converts MeshPhongMaterial only, and returns early on
           anything already MeshStandard/MeshPhysical;
         - every material here is MeshStandardMaterial from birth;
         - and it runs at 'ready' priority 0 while this module runs at -20, so
           by the time we retarget a mesh its pass is already finished and our
           material replaces whatever it produced.

       Three independent reasons, none of which this module controls. So audit
       it rather than assume it: walk what we own and check the normal map on
       the material is still the texture we baked. A silent regression here
       costs a whole review round; a warning costs nothing. */
    auditNormals();

    /* ---- 5. commit -----------------------------------------------------
       Nothing original is disposed, ever. The 13 stock world materials, the
       19 door boxes, the 4 lift boxes and the 22 crate meshes all stay
       parked in OWN.restore: that snapshot is what panic() (mid-install
       failure) and NZ.env.dispose() (debugging) hand the level back with.
       This costs nothing measurable -- their maps are the game's own TEXLIST
       canvases, or clones that share the same THREE.Source, and none of them
       is ever bound again, so no GPU memory is held either. */

    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    STATS.ms = Math.round(t1 - t0);
    installed = true;
    NZ.flags.env = true;
    STATS.litCacheHitRate = LITMISS ? +(LITHITS / (LITHITS + LITMISS)).toFixed(3) : 0;
    STATS.clearanceClamps = HUGVIOL;
    NZ.env = {
      stats: STATS,
      tier: TIER,
      megabytes: +(STATS.texBytes / 1048576).toFixed(2),
      shaderDetail: GLSL_OK,
      diag: DIAG,
      report: report,
      /* Full teardown. Every original material, geometry and mesh is still
         held in OWN.restore, so this really does hand the stock blockout
         back -- it is the same path panic() takes on a mid-install throw. */
      dispose: function () { panic('manual dispose'); }
    };
    NZ.log('env installed: tier=' + TIER + ' sets=' + STATS.sets +
      ' surfaces=' + STATS.meshes + ' runs=' + STATS.runs +
      ' props=' + STATS.props + ' fixtures=' + STATS.fixtures +
      ' decals=' + STATS.decals +
      ' vram~' + (STATS.texBytes / 1048576).toFixed(1) + 'MB in ' + STATS.ms + 'ms');
    if (DIAGON) installOverlay();
  }

  /* ======================================================================
     15b. self-report
     A module that cannot see the screen has to be able to prove what it did.
     report() is plain text so it can go straight into an overlay, the console
     or an agent's stdout; NZ.env.diag is the structured version.
     =================================================================== */
  function report() {
    var L = [], i;
    L.push('NZ-ENV  tier=' + TIER + '  install=' + STATS.ms + 'ms  vram~' +
      (STATS.texBytes / 1048576).toFixed(1) + 'MB');
    L.push('shader detail: probe=' + (DIAG.glslProbe === null ? 'n/a' : DIAG.glslProbe) +
      '  compiles=' + DIAG.anchorsOK + '  fellBack=' + DIAG.anchorsBad +
      '  onBeforeCompile calls=' + DIAG.patchCalls +
      '  chained nz-render=' + DIAG.chained + (DIAG.chainErr ? ' ERR:' + DIAG.chainErr : ''));
    L.push('vertex desat=' + VDESAT.toFixed(2) + '  global desat=' + DESAT.toFixed(2) + '  cool=' + COOL.toFixed(2));
    L.push('detail normal: substituted=' + DIAG.detailOK + '  missed=' + DIAG.detailMiss +
      '   normal audit: ' + (DIAG.normalAudit
        ? DIAG.normalAudit.materials + ' ours, ' + DIAG.normalAudit.hijacked + ' hijacked'
        : 'not run'));
    L.push('world surfaces upgraded: ' + DIAG.surfaces.length +
      '   (skipped ' + DIAG.skipped.length + ')');
    for (i = 0; i < DIAG.surfaces.length; i++) {
      var s = DIAG.surfaces[i];
      L.push('  ' + pad(s.key, 10) + ' -> set ' + pad(s.set, 9) + ' tile ' + pad(String(s.tile), 5) +
        ' macro ' + pad(String(s.macro), 5) + ' desat ' + pad(String(s.desat), 5) + ' tris ' + s.tris);
    }
    for (i = 0; i < DIAG.skipped.length; i++) {
      L.push('  SKIP ' + pad(DIAG.skipped[i].key, 10) + ' ' + DIAG.skipped[i].why);
    }
    /* Relief is printed in millimetres of real surface because that is the
       only form in which the claim can be argued with. A wall is a couple of
       millimetres; anything reading in centimetres here is the bug back. */
    L.push('baked sets: ' + DIAG.sets.length + '   (relief RMS / high-pass cutoff, real mm)');
    for (i = 0; i < DIAG.sets.length; i++) {
      var b = DIAG.sets[i];
      L.push('  ' + pad(b.name, 10) + ' ' + b.res + 'px  rgb ' +
        pad(String(b.rgb[0]), 4) + pad(String(b.rgb[1]), 4) + pad(String(b.rgb[2]), 4) +
        '  lum ' + pad(b.lum.toFixed(0), 4) + ' sat ' + b.sat.toFixed(3) +
        '  relief ' + pad(b.reliefMM + 'mm', 8) + ' hp ' + pad(b.hpMM + 'mm', 7) +
        ' swing ' + pad(b.swingMM + 'mm', 8) + ' s=' + b.sobelS +
        (b.black ? '   <<< BLACK' : ''));
    }
    L.push('detail meshes: ' + DIAG.piles.length);
    for (i = 0; i < DIAG.piles.length; i++) {
      var p = DIAG.piles[i];
      L.push('  ' + pad(p.name || '?', 22) + ' tris ' + pad(String(p.tris), 7) +
        (p.added ? '' : '  (EMPTY - not added)'));
    }
    L.push('runs=' + STATS.runs + ' props=' + STATS.props + ' fixtures=' + STATS.fixtures +
      ' decals=' + STATS.decals + ' draws +' + STATS.addedCalls + '/-' + STATS.removedCalls +
      ' clearanceClamps=' + HUGVIOL + ' litCacheHit=' + STATS.litCacheHitRate);
    if (DIAG.warnings.length) {
      L.push('WARNINGS (' + DIAG.warnings.length + '):');
      for (i = 0; i < DIAG.warnings.length; i++) L.push('  ! ' + DIAG.warnings[i]);
    }
    return L.join('\n');
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  /* ?nzdiag=1 -> put the report on the page so it can be screenshotted.
     NUKEM.html's own nzdiag overlay is pinned to the top and only shows
     console errors, so this one sits bottom-left and never overlaps it. */
  var DIAGON = /[?&]nzdiag=1/.test(global.location ? global.location.search : '');
  var overlay = null;
  function installOverlay() {
    try {
      if (overlay || !global.document || !document.body) return;
      overlay = document.createElement('div');
      overlay.id = 'nzenv-diag';
      overlay.style.cssText = 'position:fixed;left:0;bottom:0;max-height:52vh;max-width:min(760px,52vw);' +
        'overflow:auto;z-index:99998;background:rgba(6,8,10,.92);color:#9fe8a0;' +
        'font:11px/1.35 Consolas,monospace;padding:6px 8px;white-space:pre;' +
        'border-top:2px solid #2f7d32;border-right:2px solid #2f7d32;pointer-events:none';
      overlay.textContent = report();
      document.body.appendChild(overlay);
      /* the shader only compiles on the first frame that draws each material,
         so the patch counters are still zero right now -- refresh once the
         renderer has actually been through them */
      var n = 0;
      var iv = global.setInterval(function () {
        if (!overlay || ++n > 12) { global.clearInterval(iv); return; }
        overlay.textContent = report();
      }, 500);
      OWN.timer = iv;
    } catch (e) { /* diagnostics must never break the game */ }
  }

  /* rust shares the steel surface entry but its own baked set */
  function makeRustMaterial() {
    if (MATS['__rust']) return MATS['__rust'];
    var set = getSet('rust');
    if (!set) return surfaceMaterial('metal', null);
    var m = new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap,
      roughnessMap: set.ormMap, metalnessMap: set.ormMap, aoMap: set.ormMap,
      roughness: 1, metalness: 1, vertexColors: true, dithering: true, fog: true
    });
    m.name = 'nzenv:rust';
    m.aoMapIntensity = 0.9;
    m.envMapIntensity = 1.0;
    /* rust bakes at refTile 2.4 and is used at 2.4, so the correction is 1 --
       written out anyway so a future retile cannot silently break the scale */
    var rsc = 1.0 * (set.refTile > 0 ? set.refTile / 2.4 : 1);
    m.normalScale = new THREE.Vector2(rsc, rsc);
    m.userData.nzNoDerivedNormal = true;
    m.userData.nzReliefMM = set.reliefMM;
    m.__nzOwnNormal = set.normalMap;
    m.__nzEnv = {
      a: new THREE.Vector4(2.4 / 24, GLSL_OK ? 0.30 : 0, 1.6, 0),
      b: new THREE.Vector4(0.45, -4, 0.5, fin(set.mean, 0.12) || 0.12),
      c: new THREE.Vector4(0.85, clamp(0.40 * DESAT, 0, 1), COOL, MACROC),
      d: detailVec({ det: [6.0, 0.22], polish: 0, tile: 2.4, nrm: 1.0 }, set),
      grime: new THREE.Vector3(GRIME_COL[0], GRIME_COL[1], GRIME_COL[2])
    };
    if (GLSL_OK) m.onBeforeCompile = nzEnvPatch;
    OWN.mat.push(m);
    MATS['__rust'] = m;
    return m;
  }

  /* ======================================================================
     16. teardown
     Restores the stock blockout exactly if anything throws before we commit.
     After a clean install there is nothing to restore, so dispose() simply
     removes everything this module added.
     =================================================================== */
  function panic(err) {
    if (dead) return;
    dead = true;
    NZ.flags.env = false;
    if (err) console.error('[nz-env] disabled after error:', err);
    try {
      var i;
      if (OWN.timer) { try { global.clearInterval(OWN.timer); } catch (e0) {} OWN.timer = 0; }
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      /* put the original materials / geometry / attributes back */
      for (i = 0; i < OWN.restore.length; i++) {
        var s = OWN.restore[i];
        if (s.readd) { if (!s.readd.parent && s.parent) s.parent.add(s.readd); continue; }
        if (!s.mesh) continue;
        if (s.material) s.mesh.material = s.material;
        if (s.geometry) s.mesh.geometry = s.geometry;
        var g = s.mesh.geometry;
        if (g && g.attributes) {
          if (s.uv) g.setAttribute('uv', s.uv);
          if (s.uv2) g.setAttribute('uv2', s.uv2); else if (g.attributes.uv2) g.deleteAttribute('uv2');
          if (g.attributes.nzFC) g.deleteAttribute('nzFC');
          if (s.color && g.attributes.color) {
            g.attributes.color.array.set(s.color);
            g.attributes.color.needsUpdate = true;
          }
        }
      }
      OWN.restore.length = 0;
      /* remove what we added */
      for (i = 0; i < OWN.obj.length; i++) {
        var o = OWN.obj[i];
        if (o && o.parent) o.parent.remove(o);
      }
      OWN.obj.length = 0;
      for (i = 0; i < OWN.geo.length; i++) { try { OWN.geo[i].dispose(); } catch (e) {} }
      OWN.geo.length = 0;
      for (i = 0; i < OWN.mat.length; i++) { try { OWN.mat[i].dispose(); } catch (e2) {} }
      OWN.mat.length = 0;
      for (i = 0; i < OWN.tex.length; i++) { try { OWN.tex[i].dispose(); } catch (e3) {} }
      OWN.tex.length = 0;
      SETS = Object.create(null);
      MATS = Object.create(null);
      NOISE = Object.create(null);
      PILES = null;
      installed = false;
    } catch (e4) {
      console.error('[nz-env] teardown failed:', e4);
    }
  }

  /* ======================================================================
     17. hooks
     Priority -20 so nz-render's own 'ready' (phong -> standard, IBL probe)
     has already run and we upgrade the materials it produced, not the ones
     it is about to replace.
     =================================================================== */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); }
    catch (err) { panic(err); }
  }, -20);

  NZ.log && NZ.log('env module loaded');
})(typeof window !== 'undefined' ? window : this);
