/* ===========================================================================
   NZ-STREET-ENTRANCE  --  the destination of 233. Sokak.

   Owns everything inside the door recess FACADE left open at x [240,244],
   z [148.2, 152.34], y [0, 11.2] on the north plane of SEYDIKENT B-BLOK, plus
   the foyer interior behind it (x [236,252], z [124,148]).  The street leads
   here, so this is the most-looked-at object in the level and every number
   below is a real one.

   THIS IS A PHOTOGRAPH NOW, not an invention.  _ref/ref7-bblok-pink-full.png
   shows B-BLOK's entrance: a 1.0 m deep slot cut into flat salmon render at
   PAVEMENT GRADE -- no raised stoop, no flight of steps, no piers -- with a
   glazed door at the back of it, a small white name board over the door, a
   fanlight over that, and a shallow hood at the mouth.  The tan brick garden
   wall and its dark steel railing panels stand in FRONT of all of it and
   belong to nz-street-props.js this round; this module publishes the
   keepClear box that tells PROPS where to leave its gate.

     the recessed porch: salmon render reveals, grimy, and a ceiling;
     ONE 120 mm riser at the mouth -- the grid's own pavement/foyer step,
       at z = 152.00 exactly, so nothing about it is a lie -- and a 57 mm
       ceramic threshold at the door;
     a glazed aluminium door in a bronze frame with an obscured fanlight --
       built ON the game's own door mesh at cell (60,37), so it still opens;
     the buzzer/intercom bank, the bell push, the number plaque;
     the gas meter cabinet, the telecom bundle, the stopcock cover;
     the block name on a white board over the door, per the photograph;
     a doormat, a swept pile of grit, a rubbish bag, a slipper, a cat;
     and the foyer -- terrazzo, mailboxes, a stair going up out of sight, a
     radiator, a bicycle, a notice board, a fire-hose cabinet -- seen through
     the glass down a cone that is now +/- 16.8 degrees wide, not 23.

   It does NOT own the facade (nz-street.js), the road/kerb/paving
   (nz-street-ground.js), the sky (nz-street-sky.js) or the garden wall,
   railings, cars, trees and wires (nz-street-props.js).

   Zero external assets.  Classic script.  three.js r149 core UMD surface only:
   no BufferGeometryUtils (Pile is the hand-written merge), no CapsuleGeometry,
   no loaders.  No lights are added -- r149 cannot mask a light per object and
   the night half of the level shares the scene.  Every outdoor material goes
   through NZ.street.day() and every outdoor geometry through NZ.street.bake()
   with the porch reveal and the cikma soffit as occluders, which is what makes
   this porch the darkest thing on the facade.  1 unit = 0.2857 m (M = 3.5), so
   every dimension is written m(metres).
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.streetEntrance === undefined) NZ.flags.streetEntrance = false;

  var QS = /[?&]nzentrance=(0|off|low|med|high)/i.exec(
    global.location ? global.location.search : '') || null;
  if (QS && /^(0|off)$/i.test(QS[1])) {
    NZ.log && NZ.log('street-entrance disabled by query string');
    return;
  }

  var THREE = null, scene = null, renderer = null;
  var dead = false, installed = false;

  var OWN = { tex: [], mat: [], geo: [], obj: [], restore: [], timer: 0 };
  var STATS = { sets: 0, texBytes: 0, props: 0, steps: 0, addedCalls: 0,
                tris: 0, verts: 0, clearanceClamps: 0, ms: 0, bakeMs: 0,
                doorReskinned: 0 };
  var DIAG = { sets: [], piles: [], warnings: [], notes: [] };
  function warn(msg) { DIAG.warnings.push(msg); try { console.warn('[nz-street-entrance] ' + msg); } catch (e) {} }
  function note(msg) { DIAG.notes.push(msg); }

  /* ---- small math -------------------------------------------------------- */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  function ss(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  /* THE deterministic seed.  Every random choice in this file is hash1() of a
     fixed multiple of it, so two loads of the level are pixel-identical and a
     critic's screenshot reproduces. */
  var SEED = 20233;
  function rnd(a, b) { return hash1(SEED * 0.017 + a * 131.7 + (b || 0) * 7.13); }

  /* sRGB byte/hex -> linear.  Vertex colours are consumed LINEAR by three and
     are never decoded (material.color IS decoded; ours is always white), so
     every palette entry is converted exactly once, here. */
  function s2l(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  var ALB = 0.90;                    /* the same global albedo trim nz-street.js
                                        uses, so the porch and the wall it is cut
                                        into agree.  STREET-MODULE-CONTRACT 5.4:
                                        if a surface comes out hot, lower the
                                        albedo, never the light. */
  function L(hex) {
    return [s2l((hex >> 16) & 255) * ALB, s2l((hex >> 8) & 255) * ALB, s2l(hex & 255) * ALB];
  }
  function mulc(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
  function mixc(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

  /* ---- scale ------------------------------------------------------------- */
  var U = 3.5;                       /* world units per metre (NUKEM.html:360)  */
  var METRES_PER_UNIT = 1 / U;       /* 0.2857 -- NOT nz-env.js:607's stale 0.6 */
  function m(x) { return x * U; }

  /* ---- the game's lexical globals ---------------------------------------- */
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
      S_DOOR: fin(tryGet(function () { return S_DOOR; }), 2),
      cellAt: tryGet(function () { return cellAt; }) || null,
      isWallCell: tryGet(function () { return isWallCell; }) || null,
      regAt: tryGet(function () { return regAt; }) || null,
      inb: tryGet(function () { return inb; }) || null,
      lightAt: tryGet(function () { return lightAt; }) || null,
      DOORS: tryGet(function () { return DOORS; }) || null
    };
    if (!g.MW || !g.MH || !g.cellAt || !g.regAt || !g.inb) return null;
    return g;
  }

  /* the REAL apex-of-jump eye line.  nz-env's jumpTop(f) = f + 6.7 is 1.55
     units short; every overhead clearance here depends on the true number. */
  function apex() { return (G.JUMPV * G.JUMPV) / (2 * G.GRAV); }   /* 2.258 */
  function camTop(f) { return f + G.EYE + apex(); }                /* f + 8.243 */
  function jumpTop(f) { return camTop(f) + 0.45; }                 /* f + 8.70  */
  var HUG = 0.98;                    /* PRAD - 0.17: max protrusion from a wall */
  function hug(d) {
    if (d > HUG) { STATS.clearanceClamps++; return HUG; }
    return d;
  }

  /* ---- the shared street namespace, degrading gracefully ------------------ */
  var ST = NZ.street || null;
  var GRD = NZ.streetGround || null;
  var PLANE = (ST && ST.PLANE) || { north: 152, south: 192, west: 168, east: 252 };
  var BOX = (ST && ST.BOX) || { x0: 168, x1: 252, z0: 152, z1: 192, y0: 0, y1: 52 };
  var FOYER = (ST && ST.FOYER) || { x0: 236, x1: 252, z0: 124, z1: 148 };
  var DOORB = (ST && ST.DOOR) || { x0: 240, x1: 244, z: 152, z0: 148, z1: 152 };
  var STOREY = (ST && ST.STOREY) || { ground: 11.2, floor: 10.15, eaves: 51.8, count: 5 };
  var PAVE_Y = (GRD && GRD.Y && fin(GRD.Y.pavement, 0)) || 0.56;

  function sday(mat, opts) {
    try { if (ST && ST.day) return ST.day(mat, opts); }
    catch (e) { warn('day() threw: ' + (e && e.message)); }
    if (mat && String(mat.name || '').indexOf('nzday:') !== 0)
      mat.name = 'nzday:' + ((opts && opts.name) || 'ent');
    return mat;
  }
  function sbake(geo, opts) {
    try { if (ST && ST.bake) return ST.bake(geo, opts); }
    catch (e) { warn('bake() threw: ' + (e && e.message)); }
    /* no sky module: a flat mid grey, so nothing ever renders black */
    try {
      var n = geo.attributes.position.count, c = new Float32Array(n * 3), i;
      for (i = 0; i < c.length; i++) c[i] = 0.55;
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      if (geo.attributes.uv && !geo.attributes.uv2) geo.setAttribute('uv2', geo.attributes.uv);
    } catch (e2) {}
    return geo;
  }

  /* ---- quality tier ------------------------------------------------------- */
  var TIER = 'high';
  var RES = { hi: 512, md: 256 };
  var DENSITY = 1.0, RAYS = 20, SIGNW = 1024, TSEG = 8;
  function pickTier() {
    if (QS) return QS[1].toLowerCase();
    var q = (NZ.render && NZ.render.quality) || null;
    if (q === 'ultra') return 'high';
    if (q === 'high' || q === 'med' || q === 'low') return q;
    if (ST && ST.tier) return ST.tier;
    var nav = global.navigator || {};
    var cores = fin(nav.hardwareConcurrency, 4), mem = fin(nav.deviceMemory, 0), maxTex = 4096;
    try { maxTex = renderer.capabilities.maxTextureSize; } catch (e) {}
    if (maxTex < 4096 || cores <= 2 || (mem && mem <= 2)) return 'low';
    if (cores <= 4 || (mem && mem <= 4)) return 'med';
    return 'high';
  }
  function applyTier() {
    TIER = pickTier();
    if (TIER === 'low') { RES = { hi: 256, md: 128 }; DENSITY = 0.45; RAYS = 12; SIGNW = 512; TSEG = 6; }
    else if (TIER === 'med') { RES = { hi: 256, md: 256 }; DENSITY = 0.75; RAYS = 16; SIGNW = 512; TSEG = 7; }
    else { RES = { hi: 512, md: 256 }; DENSITY = 1.00; RAYS = 20; SIGNW = 1024; TSEG = 8; }
  }

  /* =========================================================================
     1.  NOISE + FIELD TOOLKIT
     Memoised lattice value-noise and worley, same shape as nz-env.js:264-500
     and nz-street.js section 1.  The memoisation is why five 512 px sets bake
     in tens of milliseconds instead of seconds.  Closure-private: there is no
     shared cache between modules and there must not be (ENV-PLAYBOOK 9.1).
     ====================================================================== */
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
    var inv = 1 / total;
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

  /* separable box blur with wrap.  r MUST be an integer -- a fractional radius
     walks src[11.63], goes NaN, and the whole albedo bakes black
     (ENV-PLAYBOOK 9.4). */
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
    var mm = fnew(res), id = fnew(res), r = NZ.tex.mulberry32(seed);
    var rid = new Float32Array(rows * cols);
    for (var i = 0; i < rid.length; i++) rid[i] = r();
    var rh = res / rows, cw = res / cols, x, y;
    for (y = 0; y < res; y++) {
      var rr = Math.floor(y / rh) % rows;
      var off = (stagger && (rr & 1)) ? cw * 0.5 : 0;
      var ly = y - Math.floor(y / rh) * rh;
      for (x = 0; x < res; x++) {
        var fx = (((x - off) % res) + res) % res;
        var cc = Math.floor(fx / cw) % cols;
        var lx = fx - Math.floor(fx / cw) * cw;
        var d = Math.min(ly, rh - ly, lx, cw - lx);
        var k = y * res + x;
        mm[k] = d < joint ? clamp(d / joint, 0, 1) : 1;
        id[k] = rid[rr * cols + cc];
      }
    }
    return { m: mm, id: id };
  }
  function fieldPlank(res, n, joint, seed, vertical) {
    return fieldBond(res, vertical ? 1 : n, vertical ? n : 1, joint, seed, false);
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
      var mv = mLo + (mHi - mLo) * t;
      a[j] *= mv; a[j + 1] *= mv; a[j + 2] *= mv;
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
  function albUnits(a, id, mask, cols, amt) {
    var n = cols.length;
    for (var i = 0, j = 0; i < id.length; i++, j += 3) {
      var c = cols[Math.min(n - 1, Math.floor(id[i] * n))];
      var t = clamp(mask[i], 0, 1) * amt;
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

  /* =========================================================================
     2.  TEXTURE EMISSION
     ====================================================================== */
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

  /* relief.mm is REAL millimetres and emitSet solves the Sobel strength from the
     measured SD of the height field so the number is honoured whatever tier
     baked it.  relief.hp is the high-pass cutoff in mm: content broader than it
     is removed before differentiating, so the albedo keeps the whole story and
     only the normal is restricted to genuine relief.  hp = 0 only where the
     pattern IS the geometry. */
  function emitSet(res, alb, height, rough, metal, aoStrength, relief, name) {
    var q, bad = 0, sumR = 0, sumG = 0, sumB = 0, sumS = 0, np = 0, i;
    for (q = 0; q < alb.length; q += 3) {
      if (!(alb[q] >= 0) || !(alb[q + 1] >= 0) || !(alb[q + 2] >= 0)) {
        bad++; alb[q] = 128; alb[q + 1] = 126; alb[q + 2] = 120;
      }
      var rr = clamp(alb[q], 0, 255), gg = clamp(alb[q + 1], 0, 255), bb = clamp(alb[q + 2], 0, 255);
      sumR += rr; sumG += gg; sumB += bb;
      var mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
      sumS += mx > 0 ? (mx - mn) / mx : 0;
      np++;
    }
    if (bad) warn('set "' + name + '" had ' + bad + ' non-finite texels (would bake BLACK)');

    var ao = cavityAO(height, res, aoStrength === undefined ? 1 : aoStrength);
    relief = relief || {};
    var refTile = relief.tile > 0 ? relief.tile : 4.0;
    var rmsMM = relief.mm > 0 ? relief.mm : 1.0;
    var hpMM = relief.hp > 0 ? relief.hp : 0;
    var rCouple = relief.rough === undefined ? 0.16 : relief.rough;
    var mmPerTexel = refTile * METRES_PER_UNIT * 1000 / res;

    var hn = height;
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

    var nrm = NZ.tex.texFromData(THREE, normalRaw(hn, res, sobelS), res, false);
    nrm.anisotropy = ANISO;
    OWN.tex.push(nrm);
    STATS.texBytes += res * res * 4 * 1.34;

    var set = {
      res: res, refTile: refTile, reliefMM: rmsMM,
      map: texCanvas(albToCanvas(alb, res), true),
      normalMap: nrm,
      ormMap: packORM(ao, rough, metal, res)
    };
    var mR = sumR / np, mG = sumG / np, mB = sumB / np;
    set.lum = mR * 0.299 + mG * 0.587 + mB * 0.114;
    set.sat = sumS / np;
    DIAG.sets.push({
      name: name, res: res, rgb: [Math.round(mR), Math.round(mG), Math.round(mB)],
      lum: +set.lum.toFixed(1), sat: +set.sat.toFixed(3), black: set.lum < 6,
      reliefMM: rmsMM, refTile: refTile,
      swingMM: +(reliefA * METRES_PER_UNIT * 1000).toFixed(1)
    });
    if (reliefA * METRES_PER_UNIT * 1000 > 120)
      warn('set "' + name + '" implies ' + (reliefA * METRES_PER_UNIT * 1000).toFixed(0) +
           ' mm of relief per swing -- that is a rock face, not a wall');
    if (set.lum < 6) warn('baked set "' + name + '" is BLACK (lum ' + set.lum.toFixed(1) + ')');
    STATS.sets++;
    return set;
  }

  var SETS = Object.create(null), BUILD = Object.create(null);
  function getSet(name) {
    if (SETS[name]) return SETS[name];
    var b = BUILD[name];
    if (!b) { warn('no builder for set "' + name + '"'); return null; }
    return (SETS[name] = b());
  }

  /* =========================================================================
     3.  THE FIVE SETS
     Every architectural albedo is baked NEUTRAL and near-white; the colour
     arrives as a LINEAR per-vertex tint that makeMesh multiplies into the
     overcast bake.  That is what lets one draw call carry grey ceramic, beige
     concrete, oxide-red steel and a yellow gas cabinet at once.
     Tile sizes are metres * 3.5 (ENV-PLAYBOOK 3.6), NOT nz-env's stale numbers.
     ====================================================================== */

  /* --- 3.1 glazed ceramic step tile ---------------------------------------
     300 x 300 mm units on a 1.2 m tile: fieldBond(res, 4, 4, ...).  A stair
     tread in this country is a 300 mm porcelain unit with a 6 mm grout joint,
     and the whole read of a stoop at 1 m is the joint grid plus the chipping
     at the nosing.  Derived from nz-env's BUILD.tile with the grid re-pitched
     and the traffic wear elongated ALONG the flight. */
  var T_STEP = m(1.2);                     /* 4.2 */
  BUILD.step = function () {
    var res = RES.md, i;
    var bond = fieldBond(res, 4, 4, Math.max(2, res / 64), 811, false);
    var grain = fbmC(res, { octaves: 4, frequency: 26, seed: 812 });
    var traffic = blurAxis(fbmC(res, { octaves: 3, frequency: 4, seed: 813 }), res,
                           Math.max(1, res / 7), true);
    var chip = worC(res, { cells: 26, seed: 814, invert: true });
    var crack = fbmC(res, { octaves: 5, frequency: 16, seed: 815, ridged: true });
    var grime = fbmC(res, { octaves: 4, frequency: 9, seed: 816 });
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [212, 208, 198]);
    for (i = 0; i < h.length; i++) {
      var jn = 1 - bond.m[i];                              /* 1 inside the joint */
      var ck = clamp((chip[i] - 0.80) * 6, 0, 1) * clamp(jn * 3, 0, 1);
      var cr = clamp((crack[i] - 0.94) * 16, 0, 1);
      h[i] = clamp(0.72 - jn * 0.44 - ck * 0.30 - cr * 0.22 + (grain[i] - 0.5) * 0.05, 0, 1);
      rough[i] = clamp(0.30 + jn * 0.44 + ck * 0.30 + traffic[i] * 0.20 +
                       (grain[i] - 0.5) * 0.10, 0.06, 1);
    }
    /* the unit-to-unit spread: a Turkish stair tile run is never one colour */
    albUnits(a, bond.id, bond.m, [[218, 213, 200], [204, 198, 184], [212, 206, 196],
                                  [196, 190, 176], [214, 210, 202]], 0.85);
    albMul(a, bond.m, 0, 1, 0.52, 1.0);                     /* grey cement grout  */
    albTint(a, traffic, [176, 172, 164], 0.34, 0.42, 0.90); /* the polished path  */
    albTint(a, grime, [128, 124, 112], 0.30, 0.62, 1.0);    /* dirt in the joints */
    albTint(a, fnewChip(chip, res, 0.80), [172, 166, 152], 0.65, 0, 1);
    return emitSet(res, a, h, rough, null, 1.05,
            { mm: 1.2, tile: T_STEP, hp: 160, rough: 0.12 }, 'step');
  };
  function fnewChip(src, res, thr) {
    var o = new Float32Array(src.length);
    for (var i = 0; i < src.length; i++) o[i] = clamp((src[i] - thr) * 6, 0, 1);
    return o;
  }

  /* --- 3.2 porch concrete / painted render ---------------------------------
     Serves the reveals, the porch ceiling, the step risers and stringers, the
     threshold, the canopy and the low cheek walls.  Derived from nz-env's
     BUILD.plaster with the frequency dropped for a 2.4 m tile and a float
     trowel swirl added -- two smeared fields at right angles is the only thing
     that separates render from drywall at 3 m. */
  var T_CONC = m(1.7);                     /* 5.95 */
  BUILD.conc = function () {
    var res = RES.hi, i;
    var orange = fbmC(res, { octaves: 4, frequency: 28, seed: 821 });
    var broad = fbmC(res, { octaves: 4, frequency: 5, seed: 822 });
    var agg = worC(res, { cells: 30, seed: 823, invert: true });
    /* THE 1.2-UNIT MOTTLE.  This was worley at 5 cells on a 5.95-unit tile --
       0.34 m blobs at 16 % albedo strength -- and at 1 m it read as a stone,
       not as a painted wall.  Two cells (0.85 m) at half the strength is a
       genuine patch repair: a wash you notice only because the panel next to it
       is a shade different, which is what the photographs actually show. */
    var patch = worC(res, { cells: 2, seed: 824 });
    var crack = fbmC(res, { octaves: 5, frequency: 22, seed: 825, ridged: true });
    var swH = fieldStreak(res, 826, 5, 9, false);
    var swV = fieldStreak(res, 827, 5, 9, true);
    var runoff = fieldStreak(res, 828, 7, 24, true);
    var soil = fieldStreak(res, 829, 4, 6, true);             /* broad soiling   */
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [226, 222, 212]);
    for (i = 0; i < h.length; i++) {
      var sw = lerp(swH[i], swV[i], 0.20);
      /* the crack network was thresholded at 0.955 with a gain of 18 and then
         tinted at 0.55 -- black hairlines 5 cm apart, which at 0.5 m read as
         cracked dried mud and did not match nz-street.js's almost invisible
         pale web twelve metres along the same painted wall.  A softer threshold,
         a third of the gain and a PALE ink make it the same material. */
      var ck = clamp((crack[i] - 0.968) * 11, 0, 1);
      var ag = clamp((agg[i] - 0.78) * 4, 0, 1);
      h[i] = clamp(0.52 + (orange[i] - 0.5) * 0.26 + (sw - 0.5) * 0.055 +
                   ag * 0.07 - ck * 0.22, 0, 1);
      rough[i] = clamp(0.84 + (orange[i] - 0.5) * 0.09 + ck * 0.08 +
                       (broad[i] - 0.5) * 0.04, 0.40, 1);
    }
    albMul(a, broad, 0, 1, 0.955, 1.035);                     /* colour drift    */
    albTint(a, patch, [214, 209, 197], 0.075, 0.30, 0.92);    /* patch repairs   */
    /* the variance now comes from GRIME, which is where a photograph's comes
       from: STREET-BRIEF 8 ranks weather streaks first and ground-line soiling
       second of eight, and a porch gets both worse than the open wall does. */
    albTint(a, runoff, [178, 173, 160], 0.34, 0.56, 1.0);     /* run-off streaks */
    albTint(a, soil, [166, 163, 150], 0.24, 0.50, 1.0);       /* general soiling */
    albTint(a, swV, [216, 213, 205], 0.10, 0.34, 0.92);       /* float-trowel    */
    albTint(a, fnewChip(crack, res, 0.968), [190, 186, 176], 0.26, 0, 1);
    albTint(a, agg, [212, 206, 193], 0.13, 0.76, 1.0);        /* aggregate pop   */
    return emitSet(res, a, h, rough, null, 0.92,
            { mm: 0.8, tile: T_CONC, hp: 95, rough: 0.10 }, 'conc');
  };

  /* --- 3.3 painted steel worn to bare metal, with rust ---------------------
     Handrails, base plates, letterbox bank, meter cabinets, gas pipe, radiator,
     door furniture.  This is nz-env's BUILD.steel recipe re-pitched to a 0.4 m
     tile, which gives a 40 mm rail a tenth of a repeat across it -- the right
     density for a thin section (ENV-PLAYBOOK 2.4.9).  Metalness is real:
     paint 0.02, rust 0.20, bare steel 0.92. */
  var T_STEEL = m(0.4);                    /* 1.4 */
  BUILD.steel = function () {
    var res = RES.md, i;
    var grain = fbmC(res, { octaves: 4, frequency: 22, seed: 831 });
    var peel = worC(res, { cells: 11, seed: 832 });
    var rust = fbmC(res, { octaves: 4, frequency: 8, seed: 833 });
    var pit = worC(res, { cells: 34, seed: 834, invert: true });
    var scratch = fbmC(res, { octaves: 3, frequency: 44, seed: 835, ridged: true });
    var bleed = fieldStreak(res, 836, 6, 20, true);
    var h = fnew(res), rough = fnew(res), metal = fnew(res);
    var a = albNew(res, [206, 202, 196]);                     /* neutral: tinted  */
    for (i = 0; i < h.length; i++) {
      var pl = clamp((peel[i] - 0.56) * 3.6, 0, 1);            /* paint gone       */
      var rs = clamp((rust[i] - 0.50) * 2.6, 0, 1) * (0.35 + pl * 0.65);
      var pt = clamp((pit[i] - 0.74) * 5, 0, 1) * rs;
      var sc = clamp((scratch[i] - 0.90) * 12, 0, 1);
      h[i] = clamp(0.58 + (grain[i] - 0.5) * 0.10 - pl * 0.10 - pt * 0.30 - sc * 0.14, 0, 1);
      rough[i] = clamp(0.40 + pl * 0.20 + rs * 0.34 - sc * 0.22, 0.08, 1);
      metal[i] = clamp(0.02 + pl * 0.90 - rs * 0.72, 0, 1);
    }
    albMul(a, grain, 0, 1, 0.92, 1.05);
    albTint(a, peel, [188, 186, 182], 0.55, 0.56, 1.0);        /* bare primer     */
    albTint(a, rust, [150, 82, 44], 0.72, 0.56, 1.0);          /* corrosion       */
    albTint(a, pit, [104, 56, 32], 0.60, 0.76, 1.0);
    albTint(a, bleed, [156, 100, 62], 0.34, 0.60, 1.0);        /* the bleed       */
    albTint(a, fnewChip(scratch, res, 0.90), [226, 224, 220], 0.55, 0, 1);
    return emitSet(res, a, h, rough, metal, 1.00,
            { mm: 0.55, tile: T_STEEL, hp: 60, rough: 0.16 }, 'steel');
  };

  /* --- 3.4 entrance glazing -----------------------------------------------
     Derived from nz-env's BUILD.glassfac with the mullion bond DELETED (the
     frame here is geometry, not a painted-on grid).  What is left is what a
     door light actually shows: hand smear at push-bar height, dried rain
     runnels, dust in the corners and the ghost of a wiped-off sticker.
     The same material also carries the door leaf's own frame members, tinted
     bronze -- one transparent material, per-vertex alpha (section 5). */
  var T_GLASS = m(2.0);                    /* 7.0 */
  BUILD.glass = function () {
    var res = RES.md, i;
    var dirt = fbmC(res, { octaves: 4, frequency: 10, seed: 841 });
    var runnel = fieldStreak(res, 842, 12, 26, true);
    var smear = blurAxis(fbmC(res, { octaves: 3, frequency: 7, seed: 843 }), res,
                         Math.max(1, res / 9), false);
    var corner = fbmC(res, { octaves: 3, frequency: 3, seed: 844 });
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [214, 216, 218]);
    for (i = 0; i < h.length; i++) {
      var dd = clamp((dirt[i] - 0.44) * 2.2, 0, 1);
      h[i] = clamp(0.50 + (dirt[i] - 0.5) * 0.10 + (runnel[i] - 0.5) * 0.12, 0, 1);
      rough[i] = clamp(0.10 + dd * 0.26 + runnel[i] * 0.16 + smear[i] * 0.14, 0.05, 0.72);
    }
    albMul(a, corner, 0, 1, 0.90, 1.04);
    albTint(a, dirt, [176, 178, 176], 0.42, 0.46, 1.0);
    albTint(a, runnel, [190, 192, 190], 0.34, 0.55, 1.0);
    albTint(a, smear, [200, 200, 198], 0.26, 0.50, 1.0);
    return emitSet(res, a, h, rough, null, 0.55,
            { mm: 0.10, tile: T_GLASS, hp: 120, rough: 0.05 }, 'glass');
  };

  /* --- 3.5 terrazzo / foyer interior --------------------------------------
     The whole foyer runs on ONE set and ONE draw call: a fine grey terrazzo
     with a chip aggregate and a 900 mm panel joint.  Per-vertex tint turns it
     into painted wall, mailbox steel, a radiator and a stair, and because the
     interior is on the NIGHT path there is no daylight probe to give the game
     away.  Derived from nz-env's BUILD.tile with the bond loosened and a real
     worley chip layer added -- the chip IS terrazzo. */
  var T_TERR = m(1.6);                     /* 5.6 */
  BUILD.terr = function () {
    var res = RES.md, i;
    var bond = fieldBond(res, 2, 2, Math.max(2, res / 96), 851, false);
    var chipA = worC(res, { cells: 40, seed: 852, invert: true });
    var chipB = worC(res, { cells: 22, seed: 853, invert: true });
    var grain = fbmC(res, { octaves: 4, frequency: 30, seed: 854 });
    var wear = blurAxis(fbmC(res, { octaves: 3, frequency: 5, seed: 855 }), res,
                        Math.max(1, res / 8), true);
    var scuff = fbmC(res, { octaves: 4, frequency: 14, seed: 856 });
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [200, 197, 190]);
    for (i = 0; i < h.length; i++) {
      var jn = 1 - bond.m[i];
      h[i] = clamp(0.66 - jn * 0.34 + (chipA[i] - 0.5) * 0.10 + (grain[i] - 0.5) * 0.06, 0, 1);
      rough[i] = clamp(0.34 + jn * 0.34 + wear[i] * 0.14 + (grain[i] - 0.5) * 0.10, 0.08, 1);
    }
    albTint(a, fnewChip(chipA, res, 0.62), [126, 122, 116], 0.70, 0, 1);   /* dark chip  */
    albTint(a, fnewChip(chipB, res, 0.74), [232, 228, 218], 0.62, 0, 1);   /* pale chip  */
    albTint(a, fnewChip(chipB, res, 0.86), [150, 118, 96], 0.40, 0, 1);    /* warm chip  */
    albMul(a, bond.m, 0, 1, 0.66, 1.0);
    albTint(a, wear, [172, 168, 160], 0.30, 0.46, 0.94);
    albTint(a, scuff, [154, 150, 142], 0.22, 0.66, 1.0);
    return emitSet(res, a, h, rough, null, 0.86,
            { mm: 0.5, tile: T_TERR, hp: 140, rough: 0.14 }, 'terr');
  };

  /* =========================================================================
     4.  MATERIALS
     One per pile.  No onBeforeCompile of our own: every colour story here is
     carried by the baked albedo and the per-vertex LINEAR tint, so there is
     nothing to inject.  Leaving onBeforeCompile unset means the material
     inherits THREE.Material.prototype.onBeforeCompile, which IS nz-render's
     AO / contact-shadow / PCSS patch -- and NZ.street.day() then chains its
     daylight block on top of that.
     ====================================================================== */
  var MATS = Object.create(null);
  function mkMat(setName, key, o) {
    if (MATS[key]) return MATS[key];
    o = o || {};
    var set = getSet(setName);
    if (!set) return null;
    var tile = o.tile || set.refTile;
    var nsc = (o.nrm === undefined ? 1.0 : o.nrm) * (set.refTile / tile);
    var mt = new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap,
      roughnessMap: set.ormMap, metalnessMap: set.ormMap, aoMap: set.ormMap,
      color: 0xffffff,
      roughness: o.rough === undefined ? 1.0 : o.rough,
      metalness: o.metal === undefined ? 1.0 : o.metal,
      vertexColors: true, dithering: true, fog: true,
      side: o.side || THREE.FrontSide,
      transparent: !!o.transparent,
      depthWrite: o.depthWrite === undefined ? true : o.depthWrite,
      alphaTest: o.alphaTest || 0,
      polygonOffset: !!o.poly,
      polygonOffsetFactor: o.poly ? -4 : 0,
      polygonOffsetUnits: o.poly ? -8 : 0
    });
    mt.normalScale = new THREE.Vector2(nsc, nsc);
    mt.aoMapIntensity = o.ao === undefined ? 0.9 : o.ao;
    if (o.night) {
      /* INDOORS.  No daylight probe, no day() shader block.  The 'nzenv:' prefix
         is what puts this material's vertex bake on the same exposure curve as
         the rest of the night level (nz-render.js:2282-2288 bakedMatName).
         ENV-PLAYBOOK 9.2: the prefix is a namespace of the bake, not a claim of
         ownership. */
      mt.name = 'nzenv:ent-' + key;
      mt.envMapIntensity = o.env === undefined ? 0.55 : o.env;
    } else {
      sday(mt, { name: 'ent-' + key, intensity: o.env === undefined ? 1.0 : o.env, spec: o.spec });
    }
    OWN.mat.push(mt);
    MATS[key] = mt;
    return mt;
  }

  /* =========================================================================
     5.  GEOMETRY TOOLKIT -- Pile / poly / box / tube
     There is no BufferGeometryUtils in r149, so Pile IS the merge.  Two
     differences from nz-env's:

       1. it records a LINEAR tint per vertex instead of baking the game's night
          point lights into `color`.  makeMesh multiplies the tint into whatever
          NZ.street.bake() wrote, which is what lets one draw call carry grey
          ceramic, oxide-red steel and a yellow gas cabinet;
       2. it records an ALPHA per vertex.  r149 defines USE_COLOR_ALPHA when the
          colour attribute has itemSize 4 (WebGLPrograms: vertexAlphas) and
          color_fragment then does `diffuseColor *= vColor` as a vec4 -- so ONE
          transparent material carries a bronze door frame at alpha 1.0 and its
          glazed panel at 0.46, and the door needs no second draw call.
     ====================================================================== */
  function Pile(wantAlpha) {
    this.p = []; this.nm = []; this.uv = []; this.t = []; this.idx = []; this.n = 0;
    this.al = wantAlpha ? [] : null;
    this.ctxTile = 1 / 8.4;
    this.ctxTint = [1, 1, 1];
    this.ctxAlpha = 1;
    this.grad = null;                 /* {y0,y1,k} ground-line soiling ramp */
  }
  Pile.prototype.tile = function (u) { this.ctxTile = 1 / (u || 4); return this; };
  Pile.prototype.tint = function (c) { this.ctxTint = c || [1, 1, 1]; return this; };
  Pile.prototype.alpha = function (a) { this.ctxAlpha = a === undefined ? 1 : a; return this; };
  Pile.prototype.ramp = function (y0, y1, k) {
    this.grad = (k === undefined || k >= 1) ? null : { y0: y0, y1: y1, k: k };
    return this;
  };
  Pile.prototype.empty = function () { return this.n === 0; };
  Pile.prototype.vert = function (x, y, z, nx, ny, nz, u, v, r, g, b) {
    if (this.grad) {
      var t = clamp((y - this.grad.y0) / ((this.grad.y1 - this.grad.y0) || 1), 0, 1);
      var kk = lerp(this.grad.k, 1, ss(t));
      r *= kk; g *= kk; b *= kk;
    }
    this.p.push(x, y, z); this.nm.push(nx, ny, nz); this.uv.push(u, v);
    this.t.push(r, g, b);
    if (this.al) this.al.push(this.ctxAlpha);
    return this.n++;
  };
  Pile.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Pile.prototype.geometry = function () {
    var g = new THREE.BufferGeometry(), i;
    for (i = 0; i < this.p.length; i++) if (!isFinite(this.p[i])) this.p[i] = 0;
    for (i = 0; i < this.uv.length; i++) if (!isFinite(this.uv[i])) this.uv[i] = 0;
    for (i = 0; i < this.t.length; i++) if (!isFinite(this.t[i])) this.t[i] = 0.5;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nm, 3));
    var uv = new THREE.Float32BufferAttribute(this.uv, 2);
    g.setAttribute('uv', uv);
    g.setAttribute('uv2', uv);        /* r149's aoMap samples vUv2; share it */
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) g.boundingSphere = null;
    this.tintArr = new Float32Array(this.t);
    this.alphaArr = this.al ? new Float32Array(this.al) : null;
    OWN.geo.push(g);
    return g;
  };

  /* the only vertex emitter.  (rx,ry,rz) is any point demonstrably INSIDE the
     solid: it is what makes 26 facets of a chamfered box all face outward
     without tracking winding by hand. */
  function poly(pile, pts, rx, ry, rz, ao) {
    var n = pts.length, i;
    if (n < 3) return;
    var cx = 0, cy = 0, cz = 0;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
    cx /= n; cy /= n; cz /= n;
    var nx = 0, ny = 0, nz = 0;
    for (i = 0; i < n; i++) {                        /* Newell */
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
    var sh = (ao === undefined ? 1 : ao) * (1 - 0.20 * clamp(-ny, 0, 1));
    var c = pile.ctxTint;
    var r = c[0] * sh, gg = c[1] * sh, bb = c[2] * sh;
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

  /* plain 6-face box: 24 verts / 12 tris, for the many small joinery members
     where a chamfer would be sub-pixel anyway */
  function box6(pile, x0, x1, y0, y1, z0, z1, ao) {
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], cx, cy, cz, ao);
    poly(pile, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], cx, cy, cz, ao);
    poly(pile, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], cx, cy, cz, ao);
  }

  /* chamfered box: 96 verts / 44 tris.  A pure 90-degree arris is the number
     one tell of a prototype, so anything with a real silhouette gets one. */
  function boxC(pile, cx, cy, cz, hx, hy, hz, k, ao) {
    k = Math.min(k, hx * 0.49, hy * 0.49, hz * 0.49);
    if (!(k > 0.0005)) { box6(pile, cx - hx, cx + hx, cy - hy, cy + hy, cz - hz, cz + hz, ao); return; }
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
      poly(pile, q, cx, cy, cz, ao);
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
        poly(pile, q2, cx, cy, cz, ao);
      }
    }
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var cq = 0; cq < 2; cq++) {
      var t0 = S[a], t1 = S[b], t2 = S[cq];
      poly(pile, [P(0, t0, t1, t2), P(1, t0, t1, t2), P(2, t0, t1, t2)], cx, cy, cz, ao);
    }
  }

  function tube(pile, ax, ay, az, bx, by, bz, r, seg, ao, cap) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var Ln = Math.sqrt(dx * dx + dy * dy + dz * dz); if (Ln < 1e-4) return;
    dx /= Ln; dy /= Ln; dz /= Ln;
    var ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.92) { ux = 1; uy = 0; uz = 0; }
    var px = uy * dz - uz * dy, py = uz * dx - ux * dz, pz = ux * dy - uy * dx;
    var pl = Math.sqrt(px * px + py * py + pz * pz) || 1; px /= pl; py /= pl; pz /= pl;
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

  /* explicit-UV quad, for the sign atlas.  v = u x n (NOT n x u): on a wall
     facing +Z with u = +X that gives +Y, so lettering lands the right way up
     instead of mirrored (nz-env.js:2027-2029). */
  function atlasQuad(pile, cx, cy, cz, nx, ny, nz, ux, uy, uz, hw, hh, rect, tintScale) {
    var vx = uy * nz - uz * ny, vy = uz * nx - ux * nz, vz = ux * ny - uy * nx;
    if (vy < -1e-6) { vx = -vx; vy = -vy; vz = -vz; }
    var pts = [
      [cx - ux * hw - vx * hh, cy - uy * hw - vy * hh, cz - uz * hw - vz * hh],
      [cx + ux * hw - vx * hh, cy + uy * hw - vy * hh, cz + uz * hw - vz * hh],
      [cx + ux * hw + vx * hh, cy + uy * hw + vy * hh, cz + uz * hw + vz * hh],
      [cx - ux * hw + vx * hh, cy - uy * hw + vy * hh, cz - uz * hw + vz * hh]
    ];
    var uvs = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
    var s = tintScale === undefined ? 1 : tintScale;
    var c = pile.ctxTint, i, base = pile.n;
    for (i = 0; i < 4; i++)
      pile.vert(pts[i][0], pts[i][1], pts[i][2], nx, ny, nz, uvs[i][0], uvs[i][1],
                c[0] * s, c[1] * s, c[2] * s);
    pile.tri(base, base + 1, base + 2);
    pile.tri(base, base + 2, base + 3);
  }

  /* A pane of glass, banded top to bottom.  `sky` is what the top band
     reflects, `deep` what the bottom shows of the interior; alpha runs from
     nearly opaque at the top (a reflection you cannot see past) to open at the
     bottom (the foyer floor).  n bands, 2 triangles each. */
  function glassPane(pile, x0, x1, y0, y1, z, nrmZ, sky, deep, aTop, aBot, n) {
    var i;
    n = n || 6;
    for (i = 0; i < n; i++) {
      var t0 = i / n, t1 = (i + 1) / n;
      var tm = (t0 + t1) * 0.5;                     /* 0 = bottom, 1 = top */
      var k = ss(tm);
      var band = mixc(deep, sky, k * k);
      /* the two horizontal wipes a squeegee leaves, which is what stops a
         gradient reading as a gradient */
      var wipe = 1 + 0.10 * Math.sin(tm * 7.0 + 1.3) + (rnd(i, 71) - 0.5) * 0.07;
      pile.tint(mulc(band, wipe)).alpha(lerp(aBot, aTop, k));
      var by0 = lerp(y0, y1, t0), by1 = lerp(y0, y1, t1);
      poly(pile, [[x0, by0, z], [x1, by0, z], [x1, by1, z], [x0, by1, z]],
           (x0 + x1) * 0.5, (by0 + by1) * 0.5, z + nrmZ, 1);
    }
    pile.alpha(1);
  }

  /* an axis-aligned quad facing a given axis direction; the reference point is
     pushed 1 unit the other way so poly() always winds it outward */
  function quadX(pile, x, y0, y1, z0, z1, dir, ao) {
    poly(pile, [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]],
         x - dir, (y0 + y1) * 0.5, (z0 + z1) * 0.5, ao);
  }
  function quadY(pile, y, x0, x1, z0, z1, dir, ao) {
    poly(pile, [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]],
         (x0 + x1) * 0.5, y - dir, (z0 + z1) * 0.5, ao);
  }
  function quadZ(pile, z, x0, x1, y0, y1, dir, ao) {
    poly(pile, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]],
         (x0 + x1) * 0.5, (y0 + y1) * 0.5, z - dir, ao);
  }
  /* a world-AABB box, chamfered if k > 0 */
  function abox(pile, x0, x1, y0, y1, z0, z1, k, ao) {
    if (x1 - x0 < 1e-4) { x0 -= 5e-4; x1 += 5e-4; }
    if (y1 - y0 < 1e-4) { y0 -= 5e-4; y1 += 5e-4; }
    if (z1 - z0 < 1e-4) { z0 -= 5e-4; z1 += 5e-4; }
    if (k > 0) boxC(pile, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
                    (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, k, ao);
    else box6(pile, x0, x1, y0, y1, z0, z1, ao);
  }

  /* =========================================================================
     6.  THE SIGN ATLAS -- everything on this porch that has to be READ
     ENV-PLAYBOOK 8.5: an OPAQUE atlas at ~4x the density of a decal atlas,
     mapped onto quads that are part of real geometry.  No alpha edge to
     dissolve in the mip chain, no sorting, depth writes normally, and one draw
     call for the block name, the number plaque, the intercom name cards, the
     letterbox labels, the meter cabinet fronts, the doormat and the notices.

     Turkish characters are COMPOSED, not trusted to the font: the base ASCII
     letter is drawn with fillText and the diacritic is drawn as geometry, so
     I S G U O C never come back as tofu on a headless box with three fonts
     installed.  This is exactly nz-street.js's treatment and exactly its ink,
     so the two signs on this building agree.
     ====================================================================== */
  var SIGN = { tex: null, mat: null, R: {}, W: 1024 };
  var SIGN_INK = '#a02f24';           /* nz-street.js's OZGURKENT red, verbatim */
  var SIGN_BG = '#cfc6b2';

  var TR_MAP = {
    'İ': ['I', 'dot'], 'Ş': ['S', 'ced'], 'Ğ': ['G', 'breve'],
    'Ü': ['U', 'diaer'], 'Ö': ['O', 'diaer'], 'Ç': ['C', 'ced'],
    'ı': ['i', null], 'ş': ['s', 'ced'], 'ğ': ['g', 'breve'],
    'ü': ['u', 'diaer'], 'ö': ['o', 'diaer'], 'ç': ['c', 'ced'], 'İ': ['I', 'dot']
  };
  function canvasWH(w, h) {
    var c = (global.document && document.createElement) ? document.createElement('canvas') : null;
    if (!c) return null;
    c.width = w; c.height = h;
    return c;
  }
  /* THE DIACRITIC BUG, fixed the way nz-street.js fixed it (nz-street.js:1196).
     This routine used to be handed `top = baseline - fontSize`, i.e. the top of
     the EM BOX, and then placed the marks a further 0.25 - 0.42 of the font size
     above that.  A 900-weight grotesque has a cap height of about 0.72 em, so
     the umlaut on O and U landed roughly half a cap height clear of the letter
     it belongs to -- floating in the blank top quarter of the tile.  OZTURK and
     SAHIN came back with no dots at all; only the cedillas survived, because
     they hang BELOW the baseline, which was measured correctly.
     `capH` is now the REAL cap height (TextMetrics.actualBoundingBoxAscent where
     the platform has it, 0.716 em where it does not), `top` is the top of the
     glyph, `base` is the baseline, and every mark is sized and placed off those.
     The two signs on this building now agree, glyph for glyph. */
  function drawMark(g, kind, cx, top, capH, ink, base) {
    if (!kind) return;
    g.save();
    g.fillStyle = ink;
    if (kind === 'dot') {
      var r = capH * 0.128;
      g.beginPath(); g.arc(cx, top - capH * 0.19, r, 0, TAU); g.fill();
    } else if (kind === 'diaer') {
      var r2 = capH * 0.118, dx = capH * 0.215;
      g.beginPath(); g.arc(cx - dx, top - capH * 0.18, r2, 0, TAU); g.fill();
      g.beginPath(); g.arc(cx + dx, top - capH * 0.18, r2, 0, TAU); g.fill();
    } else if (kind === 'breve') {
      g.strokeStyle = ink; g.lineWidth = capH * 0.15; g.lineCap = 'round';
      g.beginPath();
      g.arc(cx, top - capH * 0.30, capH * 0.28, 0.16 * PI, 0.84 * PI);
      g.stroke();
    } else if (kind === 'ced') {
      /* the cedilla hangs off the baseline, which is `base` */
      g.strokeStyle = ink; g.lineWidth = capH * 0.095; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx, base - capH * 0.02);
      g.bezierCurveTo(cx + capH * 0.05, base + capH * 0.15, cx - capH * 0.16, base + capH * 0.11,
                      cx - capH * 0.11, base + capH * 0.27);
      g.stroke();
    }
    g.restore();
  }
  /* one line of tracked capitals, condensed rather than clipped, with the 2 mm
     paint-film shadow that stops flat text reading as a sticker */
  function drawText(g, text, x0, y0, w, h, cap, ink, track, align) {
    if (!text) return;
    g.font = '900 ' + Math.round(cap) + 'px "Arial Narrow","Helvetica Neue",Arial,"DejaVu Sans",sans-serif';
    g.textBaseline = 'alphabetic';
    /* the REAL cap height, measured, so the marks sit ON the letter */
    var capH = cap * 0.716;
    try {
      var mm = g.measureText('H');
      if (mm && mm.actualBoundingBoxAscent > 0) capH = mm.actualBoundingBoxAscent;
    } catch (eM) {}
    var glyphs = [], adv = [], tw = 0, i;
    for (i = 0; i < text.length; i++) {
      var ch = text.charAt(i), dec = TR_MAP[ch];
      var bse = dec ? dec[0] : ch, mk = dec ? dec[1] : null;
      var aw = g.measureText(bse).width;
      glyphs.push({ b: bse, m: mk, w: aw });
      adv.push(aw); tw += aw + cap * track;
    }
    tw -= cap * track;
    var sc = Math.min(1, (w * 0.92) / (tw || 1));
    var sx = align === 'left' ? x0 + w * 0.05 : x0 + (w - tw * sc) / 2;
    /* centre the LETTERS in the tile, leaving room above the cap line for an
       umlaut and below the baseline for a cedilla */
    var by = y0 + h * 0.5 + capH * 0.42;
    var pass, px2, off;
    for (pass = 0; pass < 2; pass++) {
      px2 = sx; off = pass === 0 ? Math.max(1, cap * 0.026) : 0;
      g.fillStyle = pass === 0 ? 'rgba(38,26,22,0.32)' : ink;
      for (i = 0; i < glyphs.length; i++) {
        g.save(); g.translate(px2 + off, by + off); g.scale(sc, 1);
        g.fillText(glyphs[i].b, 0, 0);
        g.restore();
        if (glyphs[i].m)
          drawMark(g, glyphs[i].m, px2 + off + glyphs[i].w * sc * 0.5, by + off - capH,
                   capH, pass === 0 ? 'rgba(38,26,22,0.32)' : ink, by + off);
        px2 += (adv[i] + cap * track) * sc;
      }
    }
  }

  function buildSignAtlas() {
    var W = SIGNW, S = W / 1024;                 /* everything below in 1024-space */
    SIGN.W = W;
    var c = canvasWH(W, W);
    if (!c) { warn('no document: sign atlas skipped'); return; }
    var g = c.getContext('2d', { willReadFrequently: true });
    var r = NZ.tex.mulberry32(3121);
    var grain = fbmC(128, { octaves: 5, frequency: 20, seed: 861 });
    var i, j;
    function px(v) { return v * S; }
    /* rect in 1024-space -> [uMin, vBottom, uMax, vTop], flipY like every atlas
       in this project: the tile's visual TOP is the LARGER v */
    /* Inset each tile by a FRACTION of itself, not by a texel and a half.  This
       atlas packs its tiles 8-16 units apart in 1024-space; by mip level 3 that
       gap is one texel wide and at a 1-texel margin the neighbouring tile bleeds
       straight through -- which is the faint ghost line that used to appear
       under the letterbox labels and along the top of the fascia band.  Six per
       cent, clamped, clears the whole mip chain and costs a sliver of a tile
       nothing is drawn in. */
    function R(x, y, w, h) {
      var pX = Math.max(3, Math.min(w * 0.06, 14)) / 1024;
      var pY = Math.max(3, Math.min(h * 0.06, 16)) / 1024;
      return [x / 1024 + pX, 1 - (y + h) / 1024 + pY, (x + w) / 1024 - pX, 1 - y / 1024 - pY];
    }
    function panel(x, y, w, h, fill) {
      g.fillStyle = fill; g.fillRect(px(x), px(y), px(w), px(h));
    }
    function edge(x, y, w, h, col, lw) {
      g.strokeStyle = col; g.lineWidth = px(lw || 2);
      g.strokeRect(px(x) + px(lw || 2) * 0.5, px(y) + px(lw || 2) * 0.5,
                   px(w) - px(lw || 2), px(h) - px(lw || 2));
    }
    g.fillStyle = SIGN_BG; g.fillRect(0, 0, W, W);

    /* --- 0. the fascia band over the door: B BLOK, the block's own red ------
       The top row used to be the full 1024 wide, which made the fascia a 6.4:1
       strip.  It is now 588 wide -- a 3.675:1 band, which is both a better
       proportion for a name over a door and frees the right-hand 416 px of the
       row for the BLADE BOARD.  The blade cannot live anywhere else in this
       atlas: it has to be landscape (a blade sign has to fit between the jump
       apex at y = 9.25 and the cikma soffit at 11.2, so it is 1.6 units tall and
       as long as I like), and the first place I put it -- (8, 580, 496, 156) --
       overlapped the bottom-right quadrant of the letterbox bank at
       (224, 348, 288, 452) and painted 'B BLOK' across four of its doors. */
    panel(0, 0, 588, 160, SIGN_BG);
    drawText(g, 'A  BLOK', px(0), px(0), px(588), px(160), px(80), SIGN_INK, 0.14);
    SIGN.R.fascia = R(0, 0, 588, 160);

    /* --- 0b. THE BLADE BOARD ------------------------------------------------
       The recess is cut into the NORTH plane, so the fascia band across its
       mouth, FACADE's name at first-floor level and the number plaque are all
       seen edge-on from either end of the canyon and carry none of the distance
       read.  The one surface on this building that faces straight down the
       street is a board projecting perpendicular to the facade, and this is its
       artwork: a cream ground with a heavy oxide-red band top and bottom, so
       that even when the letters have gone to two pixels the SHAPE is still a
       red-banded rectangle hanging over the pavement at the dead end. */
    (function () {
      var x = 600, y = 0, w = 416, h = 160;
      panel(x, y, w, h, '#dfd7c4');
      panel(x, y, w, 15, SIGN_INK);
      panel(x, y + h - 15, w, 15, SIGN_INK);
      /* twenty years up: the ground has yellowed unevenly */
      g.save(); g.globalAlpha = 0.24;
      for (i = 0; i < 18; i++) {
        var sx2 = x + r() * w, sy2 = y + 18 + r() * (h - 36), sr = 10 + r() * 40;
        var gr2 = g.createRadialGradient(px(sx2), px(sy2), 0, px(sx2), px(sy2), px(sr));
        gr2.addColorStop(0, 'rgba(150,138,110,0.55)'); gr2.addColorStop(1, 'rgba(150,138,110,0)');
        g.fillStyle = gr2; g.beginPath(); g.arc(px(sx2), px(sy2), px(sr), 0, TAU); g.fill();
      }
      g.restore();
      drawText(g, 'A  BLOK', px(x), px(y + 20), px(w), px(h - 40), px(72), SIGN_INK, 0.12);
      edge(x, y, w, h, '#6d5a3a', 3);
      SIGN.R.blade = R(x, y, w, h);
    })();

    /* --- 1. the number plaque: white enamel, black numerals, blue border ---- */
    panel(0, 168, 248, 168, '#e9e6de');
    g.strokeStyle = '#2d4f86'; g.lineWidth = px(9);
    g.strokeRect(px(10), px(178), px(228), px(148));
    drawText(g, 'No 17', px(0), px(168), px(248), px(168), px(84), '#1d2126', 0.06);
    SIGN.R.number = R(0, 168, 248, 168);

    /* --- 2. the street plate: the standard blue-and-white Turkish sokak sign  */
    panel(264, 168, 264, 168, '#1f4d8f');
    g.strokeStyle = '#e8ecf2'; g.lineWidth = px(7);
    g.strokeRect(px(276), px(180), px(240), px(144));
    drawText(g, '233. SK.', px(264), px(168), px(264), px(168), px(72), '#f0f2f5', 0.08);
    SIGN.R.street = R(264, 168, 264, 168);

    /* --- 3. the notice taped inside the glass ------------------------------- */
    panel(544, 168, 480, 168, '#e4e0d2');
    drawText(g, 'KAPIYI KAPATINIZ', px(544), px(168), px(480), px(96), px(52), '#7a2b26', 0.09);
    drawText(g, 'LÜTFEN', px(544), px(250), px(480), px(78), px(44), '#3a3a3c', 0.10);
    SIGN.R.notice = R(544, 168, 480, 168);

    /* --- 4. the intercom / buzzer panel: brushed plate, buttons, name cards -- */
    (function () {
      var x = 8, y = 348, w = 200, h = 452;
      panel(x, y, w, h, '#b9bcbe');
      /* the brushed grain: horizontal strokes, which is what says "metal" */
      g.save(); g.globalAlpha = 0.16;
      for (i = 0; i < 150; i++) {
        var yy = y + r() * h;
        g.strokeStyle = r() < 0.5 ? '#ffffff' : '#5f6467';
        g.lineWidth = px(1 + r());
        g.beginPath(); g.moveTo(px(x + 2), px(yy)); g.lineTo(px(x + w - 2), px(yy)); g.stroke();
      }
      g.restore();
      edge(x, y, w, h, '#6d7174', 4);
      /* speaker grille */
      panel(x + 18, y + 16, w - 36, 68, '#3d4145');
      for (i = 0; i < 7; i++)
        panel(x + 26, y + 24 + i * 9, w - 52, 4, '#8b9094');
      /* six name cards behind scratched plastic, with a button each */
      var names = ['YILMAZ', 'ÖZTÜRK', 'ŞAHİN', 'DEMİR', 'KAYA', 'ÇELİK'];
      for (i = 0; i < 6; i++) {
        var cy = y + 100 + i * 56;
        panel(x + 16, cy, w - 76, 44, i === 3 ? '#cfc9b6' : '#e7e3d6');
        edge(x + 16, cy, w - 76, 44, '#93979a', 2);
        drawText(g, names[i], px(x + 18), px(cy + 4), px(w - 80), px(36), px(24), '#2b2f33', 0.05, 'left');
        /* the button: a chrome ring with a white pip */
        g.fillStyle = '#8d9295';
        g.beginPath(); g.arc(px(x + w - 34), px(cy + 22), px(17), 0, TAU); g.fill();
        g.fillStyle = '#e8e6df';
        g.beginPath(); g.arc(px(x + w - 34), px(cy + 22), px(10), 0, TAU); g.fill();
      }
      /* the scratches in the plastic that make it twenty years old */
      g.save(); g.globalAlpha = 0.30; g.strokeStyle = '#ffffff'; g.lineWidth = px(1.5);
      for (i = 0; i < 26; i++) {
        var ax = x + 14 + r() * (w - 28), ay = y + 96 + r() * (h - 110);
        g.beginPath(); g.moveTo(px(ax), px(ay));
        g.lineTo(px(ax + (r() - 0.5) * 40), px(ay + (r() - 0.5) * 14)); g.stroke();
      }
      g.restore();
      SIGN.R.intercom = R(x, y, w, h);
    })();

    /* --- 5. the letterbox bank: 8 doors, slot, label, keyhole --------------- */
    (function () {
      var x = 224, y = 348, w = 288, h = 452;
      panel(x, y, w, h, '#9aa39c');
      for (j = 0; j < 4; j++) for (i = 0; i < 2; i++) {
        var bx = x + 8 + i * (w - 16) / 2, by = y + 8 + j * (h - 16) / 4;
        var bw = (w - 16) / 2 - 6, bh = (h - 16) / 4 - 6;
        var t = 0.86 + r() * 0.2;
        g.fillStyle = 'rgb(' + Math.round(126 * t) + ',' + Math.round(136 * t) + ',' + Math.round(128 * t) + ')';
        g.fillRect(px(bx), px(by), px(bw), px(bh));
        edge(bx, by, bw, bh, '#5c6560', 2);
        panel(bx + 10, by + 12, bw - 20, 9, '#33383a');          /* the slot     */
        panel(bx + 12, by + bh - 34, bw * 0.52, 20, '#ded9c8');  /* the label    */
        drawText(g, String(1 + j * 2 + i), px(bx + 12), px(by + bh - 36), px(bw * 0.52), px(22),
                 px(16), '#2a2e31', 0.04);
        g.fillStyle = '#2c3134';
        g.beginPath(); g.arc(px(bx + bw - 22), px(by + bh - 24), px(7), 0, TAU); g.fill();
      }
      SIGN.R.letterbox = R(x, y, w, h);
    })();

    /* --- 6. the electricity meter box front -------------------------------- */
    (function () {
      var x = 528, y = 348, w = 232, h = 216;
      panel(x, y, w, h, '#c3c5c0');
      edge(x, y, w, h, '#7d817c', 4);
      panel(x + 22, y + 30, w - 44, 96, '#e6e5df');            /* the window   */
      edge(x + 22, y + 30, w - 44, 96, '#6d7069', 3);
      panel(x + 34, y + 52, w - 68, 40, '#26292b');            /* the register */
      for (i = 0; i < 6; i++)
        panel(x + 40 + i * 24, y + 58, 18, 28, i === 5 ? '#a83a2c' : '#dcdcd6');
      drawText(g, 'kWh', px(x + 22), px(y + 92), px(w - 44), px(32), px(22), '#3a3d3f', 0.05);
      panel(x + 22, y + 142, w - 44, 44, '#d9d6cb');
      drawText(g, 'ELEKTRİK', px(x + 22), px(y + 142), px(w - 44), px(44), px(28), '#33383a', 0.08);
      SIGN.R.elec = R(x, y, w, h);
    })();

    /* --- 7. the gas meter cabinet front: the yellow one ---------------------- */
    (function () {
      var x = 776, y = 348, w = 232, h = 216;
      panel(x, y, w, h, '#d8b22c');
      edge(x, y, w, h, '#8e7418', 4);
      panel(x + 20, y + 26, w - 40, 30, '#f0dc8c');
      drawText(g, 'DOĞALGAZ', px(x + 20), px(y + 24), px(w - 40), px(34), px(24), '#3a2f10', 0.07);
      panel(x + 34, y + 74, w - 68, 84, '#c8a526');            /* louvres      */
      for (i = 0; i < 5; i++)
        panel(x + 40, y + 82 + i * 16, w - 80, 6, '#7f6a18');
      /* the yellow triangle */
      g.fillStyle = '#f2e3a0'; g.strokeStyle = '#3a2f10'; g.lineWidth = px(4);
      g.beginPath();
      g.moveTo(px(x + w * 0.5), px(y + 168)); g.lineTo(px(x + w * 0.5 + 26), px(y + 204));
      g.lineTo(px(x + w * 0.5 - 26), px(y + 204)); g.closePath(); g.fill(); g.stroke();
      SIGN.R.gas = R(x, y, w, h);
    })();

    /* --- 8. a taped estate-agent bill --------------------------------------- */
    (function () {
      var x = 528, y = 580, w = 232, h = 216;
      panel(x, y, w, h, '#efece0');
      drawText(g, 'SATILIK', px(x), px(y + 18), px(w), px(60), px(48), '#8e2b22', 0.10);
      drawText(g, 'DAİRE', px(x), px(y + 74), px(w), px(48), px(36), '#2f4a72', 0.10);
      for (i = 0; i < 5; i++) panel(x + 20, y + 132 + i * 15, w - 40, 6, '#9a978d');
      /* the corner has curled */
      g.fillStyle = SIGN_BG;
      g.beginPath(); g.moveTo(px(x + w), px(y + h - 46)); g.lineTo(px(x + w), px(y + h));
      g.lineTo(px(x + w - 46), px(y + h)); g.closePath(); g.fill();
      SIGN.R.bill = R(x, y, w, h);
    })();

    /* --- 9. the fire-hose cabinet front -------------------------------------- */
    (function () {
      var x = 776, y = 580, w = 232, h = 216;
      panel(x, y, w, h, '#9c2b22');
      edge(x, y, w, h, '#5d1a14', 4);
      panel(x + 24, y + 26, w - 48, 92, '#7e221b');
      g.strokeStyle = '#e8e2d4'; g.lineWidth = px(5);
      g.beginPath(); g.arc(px(x + w * 0.5), px(y + 72), px(34), 0, TAU); g.stroke();
      drawText(g, 'YANGIN', px(x), px(y + 132), px(w), px(46), px(34), '#f0e9dc', 0.09);
      drawText(g, 'DOLABI', px(x), px(y + 174), px(w), px(38), px(26), '#e6ddcd', 0.09);
      SIGN.R.hose = R(x, y, w, h);
    })();

    /* --- 10. the doormat ----------------------------------------------------- */
    (function () {
      var x = 8, y = 812, w = 248, h = 200;
      panel(x, y, w, h, '#3f4038');
      /* coir texture: short crossed strokes, dense */
      g.save();
      for (i = 0; i < 900; i++) {
        var ax = x + 6 + r() * (w - 12), ay = y + 6 + r() * (h - 12);
        g.strokeStyle = 'rgba(' + (96 + r() * 60 | 0) + ',' + (92 + r() * 56 | 0) + ',' +
                        (76 + r() * 44 | 0) + ',0.55)';
        g.lineWidth = px(1.6);
        var an = r() < 0.5 ? 0.25 : -0.25;
        g.beginPath(); g.moveTo(px(ax), px(ay));
        g.lineTo(px(ax + Math.cos(an) * 9), px(ay + Math.sin(an) * 9)); g.stroke();
      }
      g.restore();
      edge(x, y, w, h, '#26271f', 6);
      drawText(g, 'HOŞGELDİNİZ', px(x), px(y + 62), px(w), px(72), px(38), '#b9b09a', 0.06);
      SIGN.R.mat = R(x, y, w, h);
    })();

    /* --- 11. the foyer mailbox bank (seen through the glass) ---------------- */
    (function () {
      var x = 272, y = 812, w = 240, h = 200;
      panel(x, y, w, h, '#7d8a80');
      for (j = 0; j < 3; j++) for (i = 0; i < 3; i++) {
        var bx = x + 8 + i * (w - 16) / 3, by = y + 8 + j * (h - 16) / 3;
        var bw = (w - 16) / 3 - 5, bh = (h - 16) / 3 - 5;
        var t = 0.84 + r() * 0.24;
        g.fillStyle = 'rgb(' + (104 * t | 0) + ',' + (116 * t | 0) + ',' + (108 * t | 0) + ')';
        g.fillRect(px(bx), px(by), px(bw), px(bh));
        edge(bx, by, bw, bh, '#4c554f', 2);
        panel(bx + 7, by + 8, bw - 14, 6, '#2b2f30');
      }
      SIGN.R.mailbox = R(x, y, w, h);
    })();

    /* --- 12. the stopcock cover in the paving -------------------------------- */
    (function () {
      var x = 528, y = 812, w = 200, h = 200;
      panel(x, y, w, h, '#8f8c84');
      edge(x, y, w, h, '#5e5c56', 8);
      panel(x + 26, y + 26, w - 52, h - 52, '#7c7973');
      drawText(g, 'SU', px(x), px(y + 60), px(w), px(80), px(58), '#4a4843', 0.12);
      g.strokeStyle = '#55534e'; g.lineWidth = px(4);
      for (i = 1; i < 4; i++) {
        g.beginPath(); g.moveTo(px(x + 26), px(y + 26 + i * (h - 52) / 4));
        g.lineTo(px(x + w - 26), px(y + 26 + i * (h - 52) / 4)); g.stroke();
      }
      SIGN.R.stopcock = R(x, y, w, h);
    })();

    /* --- 13. the bulkhead light lens (off: it is the middle of the day) ------ */
    (function () {
      var x = 744, y = 812, w = 136, h = 136;
      panel(x, y, w, h, '#cfd0cc');
      g.save(); g.globalAlpha = 0.5;
      for (i = 0; i < 9; i++) panel(x + 8 + i * 14, y + 8, 7, h - 16, '#e6e7e3');
      g.restore();
      edge(x, y, w, h, '#8a8d88', 5);
      SIGN.R.lens = R(x, y, w, h);
    })();

    /* --- the aging pass.  Grain over everything, so no tile is a crisp
           sticker, and then alpha forced fully opaque: this atlas must never
           enter the transparent pass (ENV-PLAYBOOK 8.5, trap 5). ------------- */
    var id = g.getImageData(0, 0, W, W), d = id.data, x2, y2;
    for (y2 = 0; y2 < W; y2++) for (x2 = 0; x2 < W; x2++) {
      var gv = (grain[(y2 % 128) * 128 + (x2 % 128)] - 0.5) * 19;
      var k = (y2 * W + x2) * 4;
      d[k] = clamp(d[k] + gv, 0, 255);
      d[k + 1] = clamp(d[k + 1] + gv, 0, 255);
      d[k + 2] = clamp(d[k + 2] + gv, 0, 255);
      d[k + 3] = 255;
    }
    g.putImageData(id, 0, 0);

    SIGN.tex = texCanvas(c, true, true);
    SIGN.mat = new THREE.MeshStandardMaterial({
      map: SIGN.tex, roughness: 0.82, metalness: 0.0,
      vertexColors: true, fog: true, dithering: true, side: THREE.FrontSide
    });
    /* NO onBeforeCompile of our own: the red is the one colour on this porch
       that has to survive, and it is already pre-desaturated in the canvas
       (#a02f24 is HSV sat 0.78, value 0.63 -- a faded Turkish signage red). */
    sday(SIGN.mat, { name: 'ent-sign', intensity: 0.80 });
    OWN.mat.push(SIGN.mat);
  }

  /* =========================================================================
     7.  THE ENTRANCE FRAME -- every number, resolved once
     FACADE publishes the recess in NZ.street.facades[n].entrance.  Everything
     below is derived from it, so if the orchestrator moves the door this file
     follows it; the literals are only the fallback for a build where FACADE
     is switched off.
     ====================================================================== */
  var E = null;
  function resolveEntrance() {
    var F = (ST && ST.facades) || [], i, e = null, run = null;
    for (i = 0; i < F.length; i++) if (F[i] && F[i].entrance) { e = F[i].entrance; run = F[i]; break; }
    if (!e) {
      warn('NZ.street.facades carries no entrance -- falling back to the carve literals');
      e = { x: 242, z: 152, steps: 1, width: 4, x0: 240, x1: 244, plane: 152,
            headY: 11.2, soffitY: 11.9, bay: 4.2, wallDepth: 0.34, plinthDepth: 0.52,
            plinthTop: 5.08, plinthKind: 'render', bodyLinear: null };
    }
    var X0 = fin(e.x0, fin(DOORB.x0, 240)), X1 = fin(e.x1, fin(DOORB.x1, 244));
    var PZ = fin(e.plane, fin(PLANE.north, 152));
    /* WHICH FACE IS THE MOUTH.  `entrance.bay` is FACADE's generic cikma depth
       and it is WRONG for this building: SEYDIKENT B-BLOK is flat-fronted
       (nz-street.js:4072 sets faceD = WALL_D for kind 'bblok'), so there is no
       projecting bay to recess into and the mouth of the porch is the render
       skin itself.  Read the RUN's own faceDepth and only fall back to `bay`
       if a future facade really does hang a cikma over this door. */
    var wallD = fin(e.wallDepth, 0.34);
    var faceD = (run && typeof run.faceDepth === 'number' && isFinite(run.faceDepth))
                ? run.faceDepth : fin(e.bay, wallD);
    var inw = (run && (run.inward === -1)) ? -1 : 1;    /* N run: +1 = into the canyon */
    var o = {
      X0: X0, X1: X1, XC: (X0 + X1) * 0.5,
      PZ: PZ,
      kind: (run && run.kind) || 'generic',
      WALLF: PZ + inw * wallD,                     /* 152.34 the render skin     */
      PLINF: PZ + inw * fin(e.plinthDepth, 0.52),  /* 152.52 the plinth face     */
      MOUTH: PZ + inw * faceD,                     /* 152.34 -- flat-fronted     */
      HEAD: fin(e.headY, 11.2),                    /* 11.2  the porch head       */
      SOFT: fin(e.soffitY, 11.9),
      body: (e.bodyLinear && e.bodyLinear.length === 3) ? e.bodyLinear.slice() : L(0xcb948d),
      nSteps: 1
    };
    /* the reveal lining stands 0.16 inside the world wall plane, so it hides
       the night-lit world:stone quads on cells (59,37) and (61,37) -- the two
       solid cells that flank the door cell -- without ever z-fighting them */
    o.LX = o.X0 + 0.16;
    o.RX = o.X1 - 0.16;
    /* THE BACK OF THE PORCH.  The recess IS the door cell (60,37), z 148..152,
       and behind it at z = 148 the foyer opens to its full 16-unit width -- the
       cells either side of the door at row 37 are solid, so nothing closes the
       tunnel.  0.20 of lining inside the foyer wall line. */
    o.BACK = fin(DOORB.z0, fin(FOYER.z1, 148)) + 0.02;       /* 148.02 */
    o.DEPTH = o.MOUTH - o.BACK;                              /*   4.14 = 1.18 m */
    return o;
  }

  /* ---- the level section, in world Y --------------------------------------
     THE OLD FLIGHT IS GONE AND GOOD RIDDANCE.  The last build climbed four
     0.52 risers to a landing at 2.64 and gave the height back inside over four
     more, which meant the player walked the whole porch with their feet 0.75 m
     under the tile they could see.  The grid does not support a stoop and the
     photograph does not ask for one: _ref/ref7 puts B-BLOK's door at pavement
     grade behind the garden wall.

     What the grid actually says, and what this file now builds EXACTLY:

       pavement cell (60,38)   rResWalk   f = 0.5, GROUND paves it at y = 0.56
       door cell    (60,37)    rResFoyer  f = 0,   tiled here at y = 0.14
       foyer        (59..62, 31..36)      f = 0,   tiled here at y = 0.14

     so there is ONE step in this entrance, it is 0.42 units = 120 mm, it goes
     DOWN, and it sits at z = 152.00 -- the cell boundary where the engine
     itself changes the floor.  The visible riser and the collision step are
     the same step.  The lie is zero, and the eye lands at 1.67 m inside and
     1.69 m outside instead of the old 0.9 m.  The second "step" the brief
     allows is the 57 mm ceramic threshold at the door, which is a threshold
     and not a step and is walked over, not up. */
  var RISE = 0.42;                     /* 120 mm: PAVE_Y - FLOOR_Y, exactly    */
  var GO = 1.15;                       /* 329 mm -- still the tread module     */
  var NOSE_D = 0.16;                   /* the nosing strip, 46 mm              */
  var SILL_H = 0.20;                   /* 57 mm of ceramic + aluminium sill    */
  var LAND_Y = 0.14, NOSE0 = 0, FLOOR_Y = 0.14;

  /* ---- the door elevation and the hood, resolved once in install() ---------
     WHAT SAYS "FRONT DOOR" FROM THE WEST END, now that the two gate piers and
     the bright railing that used to do it belong to PROPS.  Three things are
     left to this module and these are their numbers:

       the hood at the mouth, whose fascia is the one surface of this entrance
         that faces straight down the canyon (CAN_*);
       the white name board over the door, which is what _ref/ref7 actually
         has and which reads as a bright rectangle deep in a dark slot;
       and the recess itself, which section 17 makes the darkest thing on the
         street -- the dark-hole half of the bright-frame / dark-hole pair.

     THE GARDEN WALL IS NOT HERE ANY MORE.  _ref/ref7 and _ref/ref2 both show
     it as tan BRICK with a concrete coping and ornate dark steel panels over
     it, which is a whole texture set this module cannot afford a draw call for
     and which PROPS is building this round for the length of the north
     pavement anyway.  What this module owes PROPS instead is an honest
     keepClear box (section 20): the gate opening it must leave, and no more. */
  var CAN_X0 = 0, CAN_X1 = 0, CAN_Y0 = 0, CAN_Y1 = 0, CAN_Z1 = 0;

  /* ---- the door elevation, all of it derived, none of it guessed ----------
     Read straight off _ref/ref7: a 2.06 m leaf, a small white name board
     immediately over it, a fanlight over that, and 0.46 m of salmon render
     between the frame head and the porch ceiling.  FACADE's opening is the
     full ground storey (y 0..11.2 = 3.2 m), so the porch keeps that height and
     the door assembly sits inside it rather than filling it. */
  var SILL_Y = 0.34;                   /* FLOOR_Y + SILL_H                     */
  var LEAF_TOP = 7.30;                 /* 1.99 m of leaf over the threshold    */
  var TRAN_TOP = 7.64;                 /* the transom rail, 86 mm              */
  var BOARD_Y0 = 7.70, BOARD_Y1 = 8.56;/* the white name board, 0.25 m tall    */
  var FAN_TOP = 9.30;                  /* the fanlight, 0.21 m                 */
  var FRM_TOP = 9.60;                  /* the frame head                       */
  /* THE PORCH CEILING, and why it is not FACADE's head.  FACADE's ground-storey
     gap runs the full 0..11.2 = 3.2 m, and a 1.05 m wide hole 3.2 m tall does
     not read as a doorway -- the first render of it came back as a lift shaft.
     _ref/ref7's opening is about 2.9 m under a lintel, so the porch takes a
     ceiling at 10.24 and the 0.96 units of FACADE's gap above it are closed by
     a render infill in the plane of the mouth (porchShell).  jumpTop(0) = 8.69
     in the door cell, so 10.24 is 1.55 clear. */
  var PORCH_CEIL = 10.24;

  function resolveFrame() {
    /* the hood.  It sits ON the head of the opening, not 0.4 m under it: a lip
       that crosses the middle of a slot reads as a shelf, one that lands on the
       lintel reads as a hood.  Rule B: its underside is at 10.30 against
       jumpTop(PAVE_Y) = 0.56 + 8.70 = 9.26, so 1.04 clear. */
    CAN_Y0 = PORCH_CEIL + 0.06;        /* 10.30                                */
    CAN_Y1 = CAN_Y0 + 0.62;            /* 10.92                                */
    CAN_X0 = E.X0 - m(0.20);           /* 239.30                               */
    CAN_X1 = E.X1 + m(0.20);           /* 244.70                               */
    CAN_Z1 = E.WALLF + m(0.50);        /* 154.09 -- 500 mm proud of the render  */
    SILL_Y = FLOOR_Y + SILL_H;
  }

  /* ---- palette, LINEAR ---------------------------------------------------- */
  var C = {
    conc:   L(0xcfcabc), concDk: L(0xb2ac9c), concLt: L(0xdcd7c8),
    tread:  L(0xc9c5b6), treadW: L(0xb2ada0), nosing: L(0x85826f),
    rail:   L(0x9c4b38), railDk: L(0x7d3a2b), rust: L(0x8a4a28),
    bronze: L(0x6f5e3f), bronzeL: L(0x8b7754),
    glass:  L(0x3d464e), glassSky: L(0x828e97), frost: L(0xa9b1b1),
    gasYel: L(0xd8b22c), grey: L(0xa8aaa6), steel: L(0x8f948f),
    white:  L(0xe4e1d8), terr: L(0xbfbcb2), wallIn: L(0xd6d0be),
    skirt:  L(0x6d6858), mailG: L(0x7e8b81), red: L(0x9c2b22),
    dark:   L(0x3c403e), black: L(0x232628), wood: L(0x6f5a3e),
    plastic: L(0x9a4a3c), cat: L(0x5a544a),
    /* kept for the grab rail and the render behind it: the oxide red of every
       painted pipe on this street, and the pale cement under a flaked film */
    oxide:  L(0x8e3327), render0: L(0xd9d2c2), earth: L(0x574a3a)
  };

  var PILES = null, OCC = [];

  /* the boxes handed to NZ.street.bake().  Together with the sky module's own
     analytic canyon these are what make the porch the darkest thing on the
     facade.  NZ.street.bake() charges a blocked ray `floor x nearAtten(t)`,
     where t is how far the ray went before something stopped it and
     nearAtten(9) = 1, nearAtten(1) = 0.33 -- so an occluder ONE unit away is
     worth three times one nine units away, and the reveal walls of a 1.05 m
     wide slot are the strongest darkening term available.

     Boxes bigger than 26 units on a side are deliberately left oversized:
     nz-street-sky.js:1121 refuses to register those in its shared replay list,
     which is what keeps a building-mass stand-in from darkening the street
     twice. */
  /* WHY THIS LIST MATTERS MORE THAN IT DID.  The re-carve moved the north plane
     from z = 156 to z = 152, which is also NZ.street.BOX.z0 -- so where the old
     porch had half of itself inside the canyon footprint, EVERY vertex of this
     one is at or behind it and nz-street-sky.js:1450 hands all of them
     `t < NEAR_R ? t : NEAR_R` on the analytic canyon test.  Without the boxes
     below the whole recess would read nearAtten(9) = 1 on every blocked ray and
     come back as the brightest thing on the building instead of the darkest. */
  function buildOccluders() {
    var CEIL = PORCH_CEIL - 0.06;
    OCC = [
      /* the west jamb mass and the east jamb mass -- the building either side,
         stopped at the real lining face rather than at the cell boundary.  The
         door cell is a 4-unit tunnel through 3.4 m of building: these two are
         most of the darkness. */
      { x0: E.X0 - 30, x1: E.LX, y0: -2, y1: 52, z0: 120, z1: E.MOUTH },
      { x0: E.RX, x1: E.X1 + 30, y0: -2, y1: 52, z0: 120, z1: E.MOUTH },
      /* the building mass over the recess mouth: FACADE's ground-storey head
         band at y 11.2..12.4 and the four storeys above it */
      { x0: E.X0 - 1, x1: E.X1 + 1, y0: E.HEAD, y1: 52, z0: E.PZ - 4, z1: E.WALLF + 1.3 },
      /* my own porch ceiling, which closes the tunnel over the whole door cell,
         and the render infill that fills FACADE's gap above it at the mouth */
      { x0: E.X0 - 1, x1: E.X1 + 1, y0: CEIL - 0.2, y1: E.HEAD + 0.2,
        z0: E.BACK - 1, z1: E.MOUTH + 0.2 },
      /* THE BACK OF THE PORCH.  The foyer is a lit interior on the night path;
         from the daylight bake's point of view it is a hole that returns no sky
         at all, and without this box a reveal vertex looking straight into it
         reads nearAtten(9) = 1.  Deliberately 24 deep so nz-street-sky.js:1121
         refuses it for the shared replay list and the street is not darkened
         twice by a stand-in. */
      { x0: E.X0 - 8, x1: E.X1 + 8, y0: -2, y1: E.HEAD, z0: E.BACK - 24, z1: E.BACK },
      /* the head panel over the door frame, and the door screen itself: solid
         from the bake's point of view, which is what puts the shadow gradient
         on the two reveals either side of it */
      { x0: E.LX, x1: E.RX, y0: FRM_TOP, y1: CEIL, z0: DOORZ - 0.5, z1: DOORZ + 0.5 },
      { x0: E.LX, x1: E.RX, y0: -0.3, y1: FRM_TOP, z0: DOORZ - 0.2, z1: DOORZ + 0.2 },
      /* the hood at the mouth: what turns the opening from a slot into a
         doorway with a lid, and the only thing on this entrance that casts
         onto the pavement */
      { x0: CAN_X0, x1: CAN_X1, y0: CAN_Y0, y1: CAN_Y1, z0: E.WALLF - 0.2, z1: CAN_Z1 },
      /* the porch floor and its riser.  A floor 3.2 m under a 1.05 m wide slot
         is what puts the contact line along the bottom of both reveals. */
      { x0: E.LX, x1: E.RX, y0: -0.3, y1: FLOOR_Y, z0: E.BACK, z1: E.PZ },
      { x0: E.X0, x1: E.X1, y0: -0.3, y1: PAVE_Y, z0: E.PZ - 0.4, z1: E.PZ + 0.1 },
      /* FACADE's plinth either side of the recess: 1.45 m of render standing
         0.52 proud of the plane, which shades the bottom of the mouth */
      { x0: E.X0 - 12, x1: E.X0, y0: -0.3, y1: 5.08, z0: E.PZ, z1: E.PLINF },
      { x0: E.X1, x1: E.X1 + 8, y0: -0.3, y1: 5.08, z0: E.PZ, z1: E.PLINF }
    ];
  }

  /* =========================================================================
     8.  THE PORCH SHELL -- reveals, ceiling, arrises, the plinth return
     ====================================================================== */
  function porchShell() {
    var p = PILES.conc, i;
    p.tile(T_CONC);
    /* STREET-BRIEF 8.2: the first 1.0-1.5 m of every wall is dirtier than the
       rest, and in a porch it is worse because the mop never reaches. */
    p.ramp(LAND_Y, LAND_Y + m(1.6), 0.80);

    var z0 = E.BACK, z1 = E.MOUTH, y1 = PORCH_CEIL;

    /* THE ALBEDO OF A PORCH.  STREET-MODULE-CONTRACT 5.4: if a surface comes
       out hot, lower the albedo, not the light.  Section 17's occluder work
       carries most of the recess ratio from 0.90 down toward the reference's
       0.44 - 0.50, but not all of it, and the rest is honestly albedo: the
       inside of a porch is never repainted when the facade is, never washed by
       rain, and carries twenty years of hands, prams and cigarette smoke.  It
       is a DIFFERENT, dirtier colour from the wall outside it, and painting it
       the same cream at 0.90 was the flattering lie. */
    p.tint(mulc(mixc(E.body, C.dark, 0.20), 0.86));
    quadX(p, E.LX, 0, y1, z0, z1, +1, 0.78);
    quadX(p, E.RX, 0, y1, z0, z1, -1, 0.78);
    /* THE WEATHER STREAKS.  _ref/ref7's whole character is the grime running
       down B-BLOK's render, and a reveal that has had rain blowing into it for
       twenty years carries more of it than the open wall does.  Nine vertical
       bands per reveal, hashed, darkest at the top where the run starts. */
    for (i = 0; i < 9; i++) {
      var sy1 = y1 - 0.4 - rnd(i, 81) * 2.2;
      var sy0 = sy1 - (2.4 + rnd(i, 82) * 5.0);
      var sz = lerp(z0 + 0.25, z1 - 0.25, (i + 0.5) / 9) + (rnd(i, 83) - 0.5) * 0.30;
      var sw = 0.12 + rnd(i, 84) * 0.22;
      p.tint(mulc(mixc(E.body, C.dark, 0.34), 0.58 + rnd(i, 85) * 0.10));
      quadX(p, E.LX + 0.012, sy0, sy1, sz - sw, sz + sw, +1, 0.74);
      sz = lerp(z0 + 0.25, z1 - 0.25, (8.5 - i) / 9) + (rnd(i, 86) - 0.5) * 0.30;
      quadX(p, E.RX - 0.012, sy0, sy1, sz - sw, sz + sw, -1, 0.74);
    }
    /* the arris you actually see from the street: the 46 mm return at the mouth
       where the wall turns into the reveal.  This one is the OUTSIDE of the
       frame and has to stay bright -- it is half of the bright-frame /
       dark-hole pair that makes an entrance read at distance, and at 1.06 it
       came back at 39/255 against the open wall's 200, a black picture frame.
       The bake cannot help it: the strip stands ON the front face of both jamb
       occluders with a hood over it, so it reads as the deepest part of the
       recess when it is in fact the shallowest.  The tint carries it instead --
       a returned arris in every one of the photographs is the brightest line on
       the entrance because it catches the pavement bounce edge-on. */
    p.tint(mulc(E.body, 1.38));
    quadZ(p, z1, E.X0, E.LX, 0, y1, +1, 0.92);
    quadZ(p, z1, E.RX, E.X1, 0, y1, +1, 0.92);
    /* the ground-floor plinth returns into the recess: FACADE stops its skin
       at x = 240 / 244, so without this the wall shows its own thickness */
    p.tint(mulc(mixc(E.body, C.dark, 0.16), 0.62));
    quadZ(p, E.WALLF, E.X0 - 0.001, E.LX, 0, y1, +1, 0.70);
    quadZ(p, E.WALLF, E.RX, E.X1 + 0.001, 0, y1, +1, 0.70);

    /* the porch ceiling at 10.24, and the render infill that closes the 0.96
       units of FACADE's gap above it in the plane of the mouth.  Without the
       infill the opening is 3.2 m tall on a 1.05 m width and reads as a lift
       shaft; with it, it is a 2.87 m doorway under a lintel, which is what
       _ref/ref7 has.  The brief is explicit that under-slab soffits are the
       darkest surfaces on a facade; this ceiling is the darkest in the level. */
    p.tint(mulc(mixc(E.body, C.dark, 0.28), 0.48));
    quadY(p, y1 - 0.06, E.LX, E.RX, z0, z1, -1, 0.55);
    p.tint(mulc(E.body, 1.00));
    abox(p, E.X0 - 0.02, E.X1 + 0.02, y1 - 0.06, E.HEAD + 0.02,
         E.WALLF - 0.28, E.WALLF, 0.03, 0.90);
    /* the soffit of that infill, which is the lintel line over the door */
    p.tint(mulc(mixc(E.body, C.dark, 0.34), 0.54));
    quadY(p, y1 - 0.07, E.X0, E.X1, E.WALLF - 0.28, E.WALLF, -1, 0.50);
    /* a shallow perimeter cornice: the shadow line that says "this is a room,
       not a hole" */
    p.tint(mulc(E.body, 0.86));
    abox(p, E.LX, E.LX + 0.22, y1 - 0.44, y1 - 0.06, z0, z1, 0.03, 0.70);
    abox(p, E.RX - 0.22, E.RX, y1 - 0.44, y1 - 0.06, z0, z1, 0.03, 0.70);
    abox(p, E.LX, E.RX, y1 - 0.44, y1 - 0.06, z1 - 0.22, z1, 0.03, 0.80);

    /* --- THE HEAD PANEL over the door frame.  0.18 m of salmon render between
           the frame head at 9.60 and the ceiling at 10.18, which is what
           _ref/ref7 shows and which is also the wall the white name board is
           screwed to.  It is a box, not a quad, because it is read from the
           foyer side as well as from the street. */
    p.tint(mulc(mixc(E.body, C.dark, 0.10), 0.72));
    abox(p, E.LX, E.RX, FRM_TOP, y1 - 0.06, DOORZ - 0.34, DOORZ + 0.34, 0.03, 0.72);
    /* the drip lip under it, 60 mm proud: the shadow line over the door */
    p.tint(mulc(E.body, 0.92));
    abox(p, E.LX, E.RX, FRM_TOP - 0.06, FRM_TOP + 0.16, DOORZ + 0.30, DOORZ + 0.52, 0.02, 0.84);

    /* --- THE HOOD at the mouth.  STREET-BRIEF 3.7: "above: a small flat canopy
           or a projecting slab", and _ref/ref7's is a lip, not a porte-cochere.
           Its FASCIA is the one surface of this whole entrance that faces
           straight down the canyon, so it is painted the brightest thing on the
           building and carries a band of the signage red under it.  Rule B: the
           underside is at 9.42, above jumpTop(0.56) = 9.26. ---------------- */
    p.tint(mulc(E.body, 0.62));                       /* the soffit, and dark   */
    quadY(p, CAN_Y0, CAN_X0, CAN_X1, E.WALLF, CAN_Z1, -1, 0.52);
    p.tint(mulc(C.white, 1.14));                      /* the fascia, and bright */
    quadZ(p, CAN_Z1, CAN_X0, CAN_X1, CAN_Y0, CAN_Y1, +1, 1.0);
    quadX(p, CAN_X0, CAN_Y0, CAN_Y1, E.WALLF, CAN_Z1, -1, 0.98);
    quadX(p, CAN_X1, CAN_Y0, CAN_Y1, E.WALLF, CAN_Z1, +1, 0.98);
    quadY(p, CAN_Y1, CAN_X0, CAN_X1, E.WALLF, CAN_Z1, +1, 1.0);
    /* the red band along the bottom of the fascia: 46 mm of the same oxide as
       FACADE's SEYDIKENT B-BLOK letters at first floor, and at 60 units it is
       the only saturated horizontal at ground level on the north side.  It was
       0.28 of a 0.40 fascia in the first render, which is 70 % of the board and
       came back reading as a maroon beam rather than as a stripe on a white
       one; 0.16 of 0.62 is a quarter, which is a stripe. */
    p.tint(mulc(C.red, 1.10));
    abox(p, CAN_X0 - 0.02, CAN_X1 + 0.02, CAN_Y0 + 0.03, CAN_Y0 + 0.19,
         CAN_Z1 - 0.02, CAN_Z1 + 0.03, 0, 1.0);
    /* two struts back to the wall: a 0.5 m lip does not need them structurally
       and every one of these on the street has them anyway */
    PILES.metal.tile(T_STEEL).tint(mulc(C.steel, 0.90));
    tube(PILES.metal, CAN_X0 + 0.24, CAN_Y0 - 0.02, CAN_Z1 - 0.35,
         CAN_X0 + 0.24, CAN_Y0 + 1.5, E.WALLF + 0.08, m(0.017), 5, 0.92, true);
    tube(PILES.metal, CAN_X1 - 0.24, CAN_Y0 - 0.02, CAN_Z1 - 0.35,
         CAN_X1 - 0.24, CAN_Y0 + 1.5, E.WALLF + 0.08, m(0.017), 5, 0.92, true);

    p.ramp(0, 0, 1);
    STATS.props += 8;
  }

  /* =========================================================================
     9.  THE PORCH FLOOR -- one riser, a tiled slot, a threshold
     The old four-tread stoop is gone (see the level-section note in section 7).
     What is left is what _ref/ref7 actually shows and what the grid actually
     supports: a 120 mm riser at the mouth, a ceramic-tiled porch floor level
     with the foyer, and a 57 mm threshold at the door.

     The riser and the tile live in two different piles because a pile has one
     index buffer and one material -- the riser core is T_CONC, the tread, the
     nosing and the floor are T_STEP.
     ====================================================================== */
  function porchFloor() {
    var pc = PILES.conc, pt = PILES.step, i;
    pc.tile(T_CONC); pt.tile(T_STEP);
    var x0 = E.LX, x1 = E.RX;

    /* --- THE RISER, at z = 152.00.  This is the cell boundary between the
           pavement (f = 0.5, paved by GROUND at 0.56) and the door cell
           (f = 0, tiled here at 0.14), so the visible step and the collision
           step are the same step and the player never walks through it.  It
           runs the FULL cell width x 240..244, not the lining width, because
           the reveal linings start behind it. */
    pc.tint(mulc(C.concDk, 0.96));
    abox(pc, E.X0, E.X1, -0.20, PAVE_Y - 0.09, E.PZ - 0.62, E.PZ + 0.02, 0, 0.86);
    /* the riser face, set back 30 mm under the nosing as a real one is */
    pc.tint(mulc(C.conc, 0.94));
    quadZ(pc, E.PZ - 0.03, E.X0, E.X1, FLOOR_Y, PAVE_Y - 0.09, +1, 0.80);
    /* the nosing tile that caps it: a darker unit, 46 mm proud, chipped twice.
       A real chip on a twenty-year-old porcelain tread takes 120-180 mm of the
       corner away, right through the glaze, and shows the grey bedding mortar
       under it -- so it reads by VALUE as well as by silhouette, which is what
       survives at range. */
    var cA = 0.16 + rnd(3, 7) * 0.40, cB = cA + 0.26 + rnd(3, 8) * 0.26;
    var cuts = [0, clamp(cA, 0.04, 0.82), clamp(cA + 0.150, 0.06, 0.88),
                clamp(cB, 0.10, 0.88), clamp(cB + 0.125, 0.12, 0.98), 1];
    for (i = 0; i < 5; i++) {
      var a0 = E.X0 + (E.X1 - E.X0) * cuts[i], a1 = E.X0 + (E.X1 - E.X0) * cuts[i + 1];
      if (a1 - a0 < 0.02) continue;
      var chipped = (i === 1 || i === 3);
      var top = chipped ? PAVE_Y - 0.15 : PAVE_Y;
      var out = chipped ? E.PZ - 0.19 : E.PZ;
      pt.tint(mulc(chipped ? mixc(C.nosing, C.concDk, 0.86) : C.nosing,
                   (chipped ? 0.74 : 0.95) + rnd(i, 9) * 0.09));
      abox(pt, a0, a1, top - 0.28, top, out - NOSE_D - 0.02, out, 0.022, 0.94);
      if (chipped) {
        pt.tint(mulc(mixc(C.concDk, C.nosing, 0.35), 0.80));
        quadY(pt, top + 0.004, a0, a1, out - NOSE_D - 0.02, E.PZ, +1, 0.80);
        quadZ(pt, out - 0.004, a0, a1, top - 0.16, PAVE_Y, +1, 0.78);
      }
    }
    STATS.steps++;

    /* --- THE PORCH FLOOR.  300 mm porcelain, laid in three bands across so the
           middle one can carry the polished path twenty years of feet have worn
           through the middle of it.  It is the FLOOR of the darkest room on the
           street and half of what the camera sees inside it, and it is also the
           dirtiest tile in the building: every pair of boots in eight flats
           crosses it and nobody has ever washed it. */
    var w1 = x0 + (x1 - x0) * 0.26, w2 = x1 - (x1 - x0) * 0.26;
    var fz0 = E.BACK - 0.10, fz1 = E.PZ - 0.03;
    pt.tint(mulc(mixc(C.tread, C.dark, 0.12), 0.82));
    quadY(pt, FLOOR_Y, x0, w1, fz0, fz1, +1, 0.96);
    pt.tint(mulc(mixc(C.treadW, C.dark, 0.17), 0.74));
    quadY(pt, FLOOR_Y, w1, w2, fz0, fz1, +1, 0.92);
    pt.tint(mulc(mixc(C.tread, C.dark, 0.12), 0.80));
    quadY(pt, FLOOR_Y, w2, x1, fz0, fz1, +1, 0.96);
    /* the joint grid, three lines across and two along: at 1.05 m wide the
       porch is three and a half tiles and the grout is what says so */
    pt.tint(mulc(mixc(C.tread, C.dark, 0.46), 0.70));
    for (i = 1; i < 4; i++) {
      var jz = lerp(fz0, fz1, i / 4);
      quadY(pt, FLOOR_Y + 0.004, x0, x1, jz - 0.035, jz + 0.035, +1, 0.86);
    }
    for (i = 1; i < 3; i++) {
      var jx = lerp(x0, x1, i / 3);
      quadY(pt, FLOOR_Y + 0.004, jx - 0.035, jx + 0.035, fz0, fz1, +1, 0.86);
    }
    /* the concrete bed under it, so no gap can open at the arris whatever
       surface GROUND laid outside */
    pc.tint(mulc(C.concDk, 0.90));
    abox(pc, E.X0, E.X1, -0.20, FLOOR_Y - 0.02, E.BACK - 0.30, E.PZ, 0, 0.84);

    /* --- THE THRESHOLD, at the door line.  A ceramic nib and, on section 11's
           metal pile, the aluminium weather sill over it.  57 mm: it is walked
           over, not up, and it is the second of the brief's "1-2 shallow
           steps". */
    pt.tint(mulc(mixc(C.nosing, C.tread, 0.30), 0.92));
    abox(pt, x0, x1, FLOOR_Y - 0.02, SILL_Y, DOORZ - 0.34, DOORZ + 0.34, 0.02, 0.90);

    /* --- the swept pile of grit in the west corner.  STREET-BRIEF 8.7, and the
           cheapest human trace there is. */
    pt.tint(mulc(C.concDk, 0.76));
    for (i = 0; i < 7; i++) {
      var gx = x0 + 0.12 + rnd(i, 21) * 0.50, gz = E.BACK + 0.6 + rnd(i, 22) * 2.2;
      abox(pt, gx, gx + 0.14 + rnd(i, 23) * 0.20, FLOOR_Y, FLOOR_Y + 0.05 + rnd(i, 24) * 0.08,
           gz, gz + 0.16 + rnd(i, 25) * 0.28, 0.02, 0.72);
    }
    STATS.props += 2;
  }

  /* =========================================================================
     10.  THE GRAB RAIL
     There is no flight left to hold on to, so the raked handrails -- the
     "thicket" of four crossing maroon runs the critic counted -- go with the
     stoop.  What _ref/ref7 does show beside its door is one short painted pipe
     against the reveal, and that is all this is: a 40 mm tube on two stubs,
     oxide red, rusting at both plates.
     Rule A: the rail centre is 0.30 off the reveal lining, so the furthest
     thing from the x = 244 wall plane is 0.30 + 0.16 + 0.07 = 0.53 << HUG.
     ====================================================================== */
  var RAIL_R = m(0.020);               /* 0.07 -- a 40 mm tube */
  var RAIL_H = m(0.90);                /* 3.15 above the porch floor */

  function grabRail() {
    var pm = PILES.metal, pt = PILES.step, i;
    pm.tile(T_STEEL);
    var rx = E.RX - 0.30;                       /* against the east reveal only */
    var y = FLOOR_Y + RAIL_H;
    var zA = DOORZ + 0.75, zB = E.PZ - 0.45;    /* 149.65 -> 151.55, 0.54 m long */
    var seg = TIER === 'low' ? 5 : 6;

    pm.tint(mulc(C.rail, 0.97));
    tube(pm, rx, y, zA, rx, y, zB, RAIL_R, seg, 0.96, true);
    /* both ends die straight into the lining, level, no curl */
    tube(pm, rx, y, zA, E.RX - 0.04, y, zA - 0.10, RAIL_R * 0.92, seg, 0.90, true);
    tube(pm, rx, y, zB, E.RX - 0.04, y, zB + 0.10, RAIL_R * 0.92, seg, 0.90, true);
    /* two stubs down to the floor -- nothing here is plumb */
    for (i = 0; i < 2; i++) {
      var zv = i ? zB - 0.26 : zA + 0.26;
      var lean = (rnd(i, 31) - 0.5) * 0.05;
      pm.tint(mulc(C.rail, 0.94 + rnd(i, 32) * 0.10));
      tube(pm, rx + lean, FLOOR_Y, zv, rx, y, zv, RAIL_R * 0.78, seg, 0.94, true);
      pm.tint(mulc(mixc(C.rail, C.rust, 0.55), 0.96));
      abox(pm, rx - 0.17, rx + 0.17, FLOOR_Y, FLOOR_Y + 0.07, zv - 0.17, zv + 0.17, 0.02, 0.90);
      pm.tint(mulc(C.rust, 1.02));
      tube(pm, rx, FLOOR_Y + 0.07, zv, rx, FLOOR_Y + 0.16, zv, RAIL_R * 0.95, seg, 0.92, false);
      /* THE rust bleed.  STREET-BRIEF 8.5 ranks this fifth of eight for
         believability and it costs two triangles: a stain on the tile,
         fanning out from the plate. */
      pt.tint(mulc(mixc(C.tread, C.rust, 0.52), 0.92));
      quadY(pt, FLOOR_Y + 0.012, rx - 0.24, rx + 0.24, zv - 0.20, zv + 0.42, +1, 0.86);
      pt.tint(mulc(mixc(C.tread, C.rust, 0.26), 0.95));
      quadY(pt, FLOOR_Y + 0.010, rx - 0.36, rx + 0.36, zv + 0.26, zv + 0.78, +1, 0.90);
    }
    STATS.props++;
  }

  /* =========================================================================
     11.  THE DOOR
     A glazed aluminium screen in an anodised bronze frame with an obscured
     fanlight over.  The static frame, the fanlight and the threshold are built
     here; the LEAF is built into the game's own door mesh in reskinDoor(),
     because NUKEM.html:4356-4368 moves d.mesh.position every frame and the only
     way a new leaf can still open is to BE that mesh.
     ====================================================================== */
  /* THE SCREEN PLANE.  The game's door mesh for cell (60,37) is a 0.7-deep box
     centred at (242, 4.1, 150) -- NUKEM.html:3441-3471, h = min(c, 8.2) = 8.2,
     baseY = f + h/2 = 4.1, slideDir = (0, 8.036, 0).  Nothing forces the SCREEN
     to sit at the box centre, because reskinDoor() replaces that geometry
     outright and the only thing the game still owns is mesh.position; so the
     screen goes where the photograph puts it, 0.90 units in front of the foyer
     wall line at z = 148, which leaves a 0.98 m deep reveal in front of it.
     Put it at the cell centre instead and the porch is 0.57 m deep and there is
     nowhere to hang the buzzer panel. */
  var DOORZ = 148.90;
  var FRM = 0.30;                      /* frame section, 86 mm */

  function doorScreen() {
    var pm = PILES.metal, pg = PILES.glass, ps = PILES.sign;
    pm.tile(T_STEEL); pg.tile(T_GLASS);
    var x0 = E.LX, x1 = E.RX, y0 = FLOOR_Y, y1 = FRM_TOP;
    var zf = DOORZ + 0.15, zb = DOORZ - 0.15;

    /* the two jambs and the head, in bronze anodised aluminium */
    pm.tint(mulc(C.bronze, 1.0));
    abox(pm, x0, x0 + FRM, y0, y1, zb, zf, 0.03, 0.92);
    abox(pm, x1 - FRM, x1, y0, y1, zb, zf, 0.03, 0.92);
    abox(pm, x0, x1, y1 - FRM, y1, zb, zf, 0.03, 0.86);
    /* the transom rail the fanlight sits on, and the plain rail over the leaf
       that the white name board is screwed across */
    abox(pm, x0, x1, LEAF_TOP, TRAN_TOP, zb, zf, 0.03, 0.88);
    /* the threshold: an aluminium weather sill, 60 mm, over section 9's ceramic
       nib -- which is also what stops the porch tile and the foyer terrazzo
       meeting in a raw arris */
    pm.tint(mulc(C.steel, 1.04));
    abox(pm, x0, x1, SILL_Y - 0.05, SILL_Y + 0.08, zb - 0.12, zf + 0.12, 0.035, 0.94);

    /* the fanlight: obscured glass, which is what a real one is, and which is
       also what hides the leaf when it has slid up behind it */
    glassPane(pg, x0 + FRM, x1 - FRM, BOARD_Y1 + 0.10, FAN_TOP, DOORZ, -1.0,
              mulc(C.frost, 1.30), mulc(C.frost, 0.92), 0.94, 0.80, 3);
    /* its single glazing bar */
    pm.tint(mulc(C.bronze, 0.94)).alpha(1);
    abox(pm, E.XC - 0.08, E.XC + 0.08, BOARD_Y1 + 0.10, FAN_TOP, zb + 0.06, zf - 0.06, 0.02, 0.90);

    /* the notice taped inside the glass, on the transom rail */
    ps.tint(mulc(C.white, 0.92));
    atlasQuad(ps, E.XC, TRAN_TOP + 0.30, zf + 0.012, 0, 0, 1, 1, 0, 0,
              m(0.26), m(0.091), SIGN.R.notice, 1);
    STATS.props += 3;
  }

  /* --- the leaf, built into the game's door mesh --------------------------- */
  function reskinDoor() {
    if (!G.DOORS || !G.DOORS.length) { warn('no DOORS array: the game door cannot be reskinned'); return; }
    /* THE DOOR MOVED.  The re-carve took the north plane from z = 156 to
       z = 152 and the door cell from (60,38) to (60,37) -- NUKEM.html's dd[]
       list ends [60, 37] and paint() claims that cell for rResFoyer so the
       opening takes its headroom from the foyer ceiling.  Search the box SKY
       publishes (NZ.street.DOOR.z0/z1 = 148/152) rather than deriving the cell
       from the plane, which is what silently missed it last round. */
    var DZ0 = fin(DOORB.z0, E.PZ - G.CELL), DZ1 = fin(DOORB.z1, E.PZ);
    var i, d = null;
    for (i = 0; i < G.DOORS.length; i++) {
      var dd = G.DOORS[i];
      if (!dd || !dd.mesh || !dd.mesh.isMesh) continue;
      var wx = dd.cx * G.CELL + G.CELL * 0.5, wz = dd.cy * G.CELL + G.CELL * 0.5;
      if (wx > E.X0 - 0.5 && wx < E.X1 + 0.5 && wz > DZ0 - 0.5 && wz < DZ1 + 0.5) { d = dd; break; }
    }
    if (!d) { warn('the foyer door mesh was not found at cell (' +
                   ((E.XC / G.CELL) | 0) + ', ' + (((DZ0 + DZ1) * 0.5 / G.CELL) | 0) + ')'); return; }

    var mesh = d.mesh;
    var ox = mesh.position.x, oy = mesh.position.y, oz = mesh.position.z;
    var pile = new Pile(true);
    pile.tile(T_GLASS);

    /* LOCAL space: the game sets mesh.position every frame from
       (cx*CELL+CELL/2, baseY + slideDir.y * open, cy*CELL+CELL/2), so anything
       built about the origin travels with it and the door still works. */
    function LX2(x) { return x - ox; }
    function LY2(y) { return y - oy; }
    function LZ2(z) { return z - oz; }

    var x0 = E.LX + FRM + 0.05, x1 = E.RX - FRM - 0.05;
    var y0 = SILL_Y + 0.06, y1 = LEAF_TOP - 0.02;
    var zc = DOORZ, hz = 0.11;
    var st = 0.34;                                  /* stile / rail width, 97 mm */

    function lbox(ax0, ax1, ay0, ay1, az0, az1, k, ao) {
      abox(pile, LX2(ax0), LX2(ax1), LY2(ay0), LY2(ay1), LZ2(az0), LZ2(az1), k, ao);
    }
    /* the frame of the leaf: two stiles, a top rail, a bottom rail and the
       middle rail the push bar is fixed through.  alpha 1 -- opaque bronze. */
    pile.tint(mulc(C.bronze, 1.02)).alpha(1);
    lbox(x0, x0 + st, y0, y1, zc - hz, zc + hz, 0.03, 0.94);
    lbox(x1 - st, x1, y0, y1, zc - hz, zc + hz, 0.03, 0.94);
    lbox(x0, x1, y1 - st, y1, zc - hz, zc + hz, 0.03, 0.90);
    pile.tint(mulc(C.bronze, 0.96));
    lbox(x0, x1, y0, y0 + m(0.34), zc - hz, zc + hz, 0.03, 0.90);   /* bottom rail */

    /* the kick plate: a scuffed brushed panel over the bottom rail, which is
       the part of any apartment door that actually gets destroyed */
    pile.tint(mulc(C.steel, 0.62));
    lbox(x0 + 0.06, x1 - 0.06, y0 + 0.10, y0 + m(0.30), zc + hz, zc + hz + 0.06, 0.015, 0.88);

    /* THE glass: one large fixed pane, dark and barely reflective under
       overcast, at alpha 0.46 so the foyer is half-seen through it.  r149
       gives us that alpha for free because the colour attribute is itemSize 4. */
    /* IT CAME BACK AS A MIRROR.  At the old 0.78/0.54 with C.glassSky straight
       the pane read as a sheet of polished chrome in the middle of a dark slot
       -- an overcast sky reflected at 0.95 envMapIntensity is BRIGHTER than
       anything else in the recess, so the one thing the player is meant to see
       THROUGH became the one thing they could not see past.  A real entrance
       pane in a 1 m deep reveal never catches the sky at all: it catches the
       pavement and the building opposite.  Two thirds of the sky term and a
       third off the alpha is what puts the foyer back behind it. */
    glassPane(pile, LX2(x0 + st), LX2(x1 - st), LY2(y0 + m(0.34)), LY2(y1 - st), LZ2(zc),
              -4.0, mulc(C.glassSky, 0.58), mulc(C.glass, 0.85), 0.60, 0.34, 7);

    /* the horizontal push bar, both faces, on stand-offs */
    pile.tint(mulc(C.steel, 1.06)).alpha(1);
    var pby = FLOOR_Y + m(1.03);
    var seg = TIER === 'low' ? 5 : 6;
    tube(pile, LX2(x0 + st * 0.6), LY2(pby), LZ2(zc + hz + 0.22),
               LX2(x1 - st * 0.6), LY2(pby), LZ2(zc + hz + 0.22), m(0.017), seg, 0.96, true);
    tube(pile, LX2(x0 + st * 1.1), LY2(pby), LZ2(zc + hz),
               LX2(x0 + st * 1.1), LY2(pby), LZ2(zc + hz + 0.22), m(0.014), seg, 0.90, true);
    tube(pile, LX2(x1 - st * 1.1), LY2(pby), LZ2(zc + hz),
               LX2(x1 - st * 1.1), LY2(pby), LZ2(zc + hz + 0.22), m(0.014), seg, 0.90, true);
    /* the inside pull handle -- a plain U, which is what these all have */
    tube(pile, LX2(x1 - st * 0.9), LY2(pby - m(0.16)), LZ2(zc - hz - 0.20),
               LX2(x1 - st * 0.9), LY2(pby + m(0.16)), LZ2(zc - hz - 0.20), m(0.015), seg, 0.94, true);
    /* the lock cylinder and its escutcheon */
    pile.tint(mulc(C.bronzeL, 1.0));
    tube(pile, LX2(x1 - st * 0.5), LY2(pby - m(0.20)), LZ2(zc + hz),
               LX2(x1 - st * 0.5), LY2(pby - m(0.20)), LZ2(zc + hz + 0.05), m(0.026), seg, 0.94, true);
    /* the closer arm at the head, which every one of these doors has */
    pile.tint(mulc(C.steel, 0.86));
    lbox(x1 - st * 2.2, x1 - st * 0.4, y1 - st * 0.9, y1 - st * 0.25,
         zc - hz - 0.22, zc - hz, 0.02, 0.86);

    var geo = pile.geometry();
    var mtx = new THREE.Matrix4();
    if (mtx.makeTranslation) mtx.makeTranslation(ox, oy, oz);
    finishGeo(pile, geo, { occluders: OCC, rays: RAYS, matrix: mtx, floor: PORCH_FLOOR + 0.05 });

    var mat = MATS.glass;
    if (!mat) { warn('glass material missing: door left as it was'); return; }

    /* Swap the reference only.  nz-env already replaced this mesh's geometry
       and material at its own -20 hook and snapshotted the ORIGINAL in its
       OWN.restore; we snapshot what WE found, so panic() hands nz-env's door
       back and its own teardown still resolves.  Nothing nz-env owns is
       mutated -- ENV-PLAYBOOK 9.1 forbids touching the material itself, and we
       do not. */
    OWN.restore.push({ mesh: mesh, material: mesh.material, geometry: mesh.geometry });
    mesh.geometry = geo;
    mesh.material = mat;
    mesh.castShadow = false;            /* a glazed screen casts nothing useful */
    mesh.receiveShadow = true;
    STATS.doorReskinned = 1;
    note('door mesh at cell (' + d.cx + ',' + d.cy + ') reskinned in place; ' +
         'slideDir ' + (d.slideDir ? d.slideDir.y.toFixed(2) : '?') + ' preserved');
  }

  /* =========================================================================
     12.  THE FURNITURE -- buzzer bank, bell push, number plaque
     Everything on this list is mounted on a reveal lining, which is 0.16 off a
     real wall plane, so rule A holds for all of it with a wide margin.  The
     EAST reveal carries the things you read (it is the face the street sees
     obliquely as you come up the canyon); the WEST reveal carries the services.

     THE LETTERBOX BANK IS NOT OUT HERE ANY MORE, and that is not a cut.  The
     recess lost 4 units of depth in the re-carve -- the porch reveal is now
     z 148.90..152.34, 0.98 m, and a 1.35 m bank of eight boxes does not fit on
     it at any height.  It is also, in fact, wrong: in a Turkish block the post
     boxes are INSIDE the entrance hall where the postman has to be let in to
     reach them, which is where section 16 now puts them -- on the foyer's west
     wall, the first thing on your left as you come through the door and clearly
     visible through the glass from the mouth.  What stays outside is what is
     outside in _ref/ref7: the buzzer panel with the flat names on it.
     ====================================================================== */
  function furniture() {
    var pm = PILES.metal, ps = PILES.sign;
    pm.tile(T_STEEL);
    var rx = E.RX;                                  /* the east reveal, faces -x */

    /* --- the buzzer / intercom panel: a brushed plate 157 x 429 mm, at
           1.14 m over the porch floor and 0.30 m in front of the door frame,
           which is exactly where a hand reaches for it ------------------- */
    var iz0 = DOORZ + 0.62, iz1 = iz0 + m(0.16);
    var iy0 = FLOOR_Y + m(1.14), iy1 = iy0 + m(0.44);
    pm.tint(mulc(C.steel, 1.02));
    abox(pm, rx - 0.34, rx, iy0 - 0.06, iy1 + 0.06, iz0 - 0.05, iz1 + 0.05, 0.025, 0.92);
    ps.tint(mulc(C.white, 1.0));
    atlasQuad(ps, rx - 0.352, (iy0 + iy1) * 0.5, (iz0 + iz1) * 0.5, -1, 0, 0, 0, 0, 1,
              (iz1 - iz0) * 0.5, (iy1 - iy0) * 0.5, SIGN.R.intercom, 1);
    /* its conduit, chased up into the ceiling */
    pm.tint(mulc(C.grey, 0.94));
    tube(pm, rx - 0.10, iy1 + 0.06, (iz0 + iz1) * 0.5, rx - 0.10, PORCH_CEIL - 0.30, (iz0 + iz1) * 0.5,
         m(0.011), 5, 0.90, false);
    /* the rust bleed from its two fixing screws, on the render below */
    PILES.conc.tint(mulc(mixc(C.conc, C.rust, 0.34), 0.92));
    quadX(PILES.conc, rx - 0.014, iy0 - 1.7, iy0 - 0.06, iz0 + 0.08, iz0 + 0.36, -1, 0.88);
    quadX(PILES.conc, rx - 0.014, iy0 - 1.2, iy0 - 0.06, iz1 - 0.34, iz1 - 0.06, -1, 0.88);

    /* --- the bell push, right beside the door frame ------------------------- */
    pm.tint(mulc(C.bronzeL, 1.02));
    abox(pm, rx - 0.20, rx, FLOOR_Y + m(1.16), FLOOR_Y + m(1.30),
         DOORZ + 0.28, DOORZ + 0.52, 0.02, 0.94);
    pm.tint(mulc(C.white, 1.05));
    tube(pm, rx - 0.21, FLOOR_Y + m(1.23), DOORZ + 0.40, rx - 0.26, FLOOR_Y + m(1.23),
         DOORZ + 0.40, m(0.012), 6, 0.96, true);

    /* --- the number plaque and the street plate.  These go on FACADE's own
           skin beside the recess, because a number you cannot read from the
           pavement is not a number.  Rule A: 0.52 off the z = 152 wall plane,
           well inside HUG = 0.98. */
    var pz = E.PLINF + 0.012;
    ps.tint(mulc(C.white, 1.0));
    atlasQuad(ps, E.X1 + m(0.42), PAVE_Y + m(1.30), pz, 0, 0, 1, 1, 0, 0,
              m(0.145), m(0.098), SIGN.R.number, 1);
    atlasQuad(ps, E.X1 + m(0.42), PAVE_Y + m(1.74), pz, 0, 0, 1, 1, 0, 0,
              m(0.18), m(0.115), SIGN.R.street, 1);
    /* the estate agent's bill, taped to the render on the other side */
    ps.tint(mulc(C.white, 0.94));
    atlasQuad(ps, E.X0 - m(0.40), PAVE_Y + m(1.42), pz, 0, 0, 1, 1, 0, 0,
              m(0.13), m(0.121), SIGN.R.bill, 1);
    STATS.props += 6;
  }

  /* =========================================================================
     13.  THE SERVICES CLUSTER
     STREET-BRIEF 3.7's last paragraph, and the thing that makes a Turkish
     entrance unmistakable.  nz-street.js already stands the tall yellow riser
     on the facade 1.3 m east of the recess, so this is deliberately NOT a
     second riser: it is the meter cabinet the riser feeds, the electricity box
     beside it, the telecom bundle stapled along the reveal, and the stopcock.
     ====================================================================== */
  function services() {
    var pm = PILES.metal, ps = PILES.sign, i;
    pm.tile(T_STEEL);
    var lx = E.LX;                                  /* the west reveal, faces +x */

    /* --- the gas meter cabinet: 400 x 500 mm, and it is yellow.  The porch
           reveal is 0.98 m long, so this is what fits on it and it is the one
           thing on this entrance that is not negotiable -- STREET-BRIEF 3.7
           calls the yellow cabinet the single most Turkish object on a block. */
    var gz0 = DOORZ + 0.55, gz1 = gz0 + m(0.40);
    var gy0 = FLOOR_Y + m(0.46), gy1 = gy0 + m(0.50);
    pm.tint(mulc(C.gasYel, 1.0));
    abox(pm, lx, lx + 0.52, gy0, gy1, gz0, gz1, 0.03, 0.92);
    ps.tint(mulc(C.white, 1.0));
    atlasQuad(ps, lx + 0.532, (gy0 + gy1) * 0.5, (gz0 + gz1) * 0.5, 1, 0, 0, 0, 0, 1,
              (gz1 - gz0) * 0.5, (gy1 - gy0) * 0.5, SIGN.R.gas, 1);
    /* the yellow drop from FACADE's riser, down the reveal into the cabinet */
    pm.tint(mulc(C.gasYel, 0.96));
    var gx = lx + 0.26;
    tube(pm, gx, gy1, gz1 - 0.2, gx, PORCH_CEIL - 0.42, gz1 - 0.2, m(0.028), 6, 0.92, true);
    tube(pm, gx, PORCH_CEIL - 0.42, gz1 - 0.2, gx, PORCH_CEIL - 0.42, E.MOUTH - 0.30, m(0.028), 6, 0.92, true);
    for (i = 0; i < 3; i++) {                                        /* the clips */
      var cz = lerp(gz1 + 0.30, E.MOUTH - 0.55, (i + 0.5) / 3);
      pm.tint(mulc(C.steel, 0.90));
      abox(pm, lx, lx + 0.34, PORCH_CEIL - 0.58, PORCH_CEIL - 0.30, cz - 0.06, cz + 0.06, 0.015, 0.88);
    }
    /* the isolation valve on the cabinet's underside: a stub and a lever */
    pm.tint(mulc(C.steel, 0.96));
    tube(pm, gx, gy0 - 0.34, gz0 + 0.3, gx, gy0, gz0 + 0.3, m(0.024), 6, 0.90, true);
    abox(pm, gx - 0.05, gx + 0.05, gy0 - 0.40, gy0 - 0.30, gz0 + 0.18, gz0 + 0.42, 0.01, 0.90);

    /* --- the electricity meter box.  It went INSIDE with the letterboxes: the
           west reveal is 0.98 m long and the gas cabinet has 0.40 m of it, so
           two 0.40 m boxes side by side would have been touching.  It is on the
           foyer's east wall in section 16, which is where these actually are. */

    /* --- the telecom bundle: five cables stapled along the reveal and turned
           up into the ceiling.  STREET-BRIEF 7: a Turkish facade with tidy
           services is wrong. */
    for (i = 0; i < 5; i++) {
      var cy = PORCH_CEIL - m(0.52) - i * m(0.045);
      var wob = (rnd(i, 41) - 0.5) * 0.09;
      pm.tint(mulc(i === 2 ? C.black : mixc(C.dark, C.grey, 0.35), 0.95 + rnd(i, 42) * 0.10));
      tube(pm, lx + 0.10 + wob, cy, E.BACK + 0.3, lx + 0.10 + wob, cy + 0.05, E.MOUTH - 0.15,
           m(0.008), 5, 0.90, false);
    }
    for (i = 0; i < 4; i++) {                                       /* the staples */
      var sz = lerp(E.BACK + 0.7, E.MOUTH - 0.6, i / 3);
      pm.tint(mulc(C.steel, 0.88));
      abox(pm, lx, lx + 0.16, PORCH_CEIL - m(0.60), PORCH_CEIL - m(0.42), sz - 0.05, sz + 0.05, 0.01, 0.86);
    }

    /* --- the water stopcock cover, flat in the porch floor.  Rule E: it is
           0.03 units proud, which is a fifth of a kerb. */
    ps.tint(mulc(C.grey, 0.90));
    atlasQuad(ps, lx + m(0.30), FLOOR_Y + 0.03, E.PZ - 1.15, 0, 1, 0, 1, 0, 0,
              m(0.115), m(0.115), SIGN.R.stopcock, 1);

    /* --- the bulkhead light over the door.  OFF: it is the middle of an
           overcast day, and this module adds no lights (r149 cannot mask one
           per object).  It is here because an entrance without one is wrong. */
    pm.tint(mulc(C.white, 0.94));
    abox(pm, E.XC - m(0.10), E.XC + m(0.10), FRM_TOP + 0.30, FRM_TOP + 0.68,
         DOORZ + 0.40, DOORZ + 0.86, 0.03, 0.86);
    ps.tint(mulc(C.grey, 0.86));
    atlasQuad(ps, E.XC, FRM_TOP + 0.49, DOORZ + 0.88, 0, 0, 1, 1, 0, 0,
              m(0.085), m(0.055), SIGN.R.lens, 1);
    STATS.props += 5;
  }

  /* =========================================================================
     14.  THE BLOCK NAME -- the white board over the door
     ENV-PLAYBOOK 8.5.  The letters are painted INTO an opaque atlas tile -- no
     alpha edge, no sorting -- and the board they are on is a real object screwed
     to the head panel.

     WHAT CHANGED, AND WHY THE BLADE SIGN IS GONE.  Both were answers to "the
     recess is cut into the north plane, so nothing on it faces the camera from
     either end of the canyon" -- a fascia band across a cikma mouth that no
     longer exists, and a board hanging out over the pavement that _ref/ref7
     does not have.  B-BLOK carries its name where the photograph puts it:
     SEYDIKENT B-BLOK in red block capitals at first-floor level, which FACADE
     builds as cut letters (nz-street.js buildLetterAtlas entry 2), and a small
     white name board immediately over the door, which is this.  Two signs, both
     real, neither invented -- and the entrance's distance read is now carried
     by the hood fascia and its red band instead.

     Rule B does not apply: the board is INSIDE the recess at z = 148.9, over a
     doorway, and the nearest the player's head can get to it is the door cell
     at f = 0 where jumpTop = 8.70.  The board's underside is at 7.70 -- but it
     is flat on a wall the player cannot stand inside, not a soffit over the
     walking line, so what governs is rule A: it stands 0.34 off the head panel.
     ====================================================================== */
  function nameBoard() {
    if (!SIGN.mat) return;
    var pc = PILES.conc, ps = PILES.sign;
    var h = BOARD_Y1 - BOARD_Y0;
    var w = h * 3.675;                          /* the fascia tile's own aspect */
    var yc = (BOARD_Y0 + BOARD_Y1) * 0.5;
    var half = Math.min(w * 0.5, (E.RX - E.LX) * 0.5 - 0.24);
    var zf = DOORZ + 0.30;                      /* clear of the transom rail    */
    /* the board itself: a white-painted panel with a shadow gap behind it */
    pc.tile(T_CONC).tint(mulc(C.white, 1.12));
    abox(pc, E.XC - half - 0.06, E.XC + half + 0.06, BOARD_Y0 - 0.06, BOARD_Y1 + 0.06,
         zf - 0.14, zf, 0.03, 0.96);
    ps.tint(mulc(C.white, 1.06));
    atlasQuad(ps, E.XC, yc, zf + 0.012, 0, 0, 1, 1, 0, 0,
              half, h * 0.5, SIGN.R.fascia, 1);
    /* the four screws that hold it, and the two rust runs from the top pair */
    PILES.metal.tile(T_STEEL).tint(mulc(C.steel, 0.88));
    var sx, sy, k;
    for (k = 0; k < 4; k++) {
      sx = E.XC + (k & 1 ? half - 0.10 : -half + 0.10);
      sy = (k < 2) ? BOARD_Y1 - 0.10 : BOARD_Y0 + 0.10;
      tube(PILES.metal, sx, sy, zf + 0.012, sx, sy, zf + 0.05, m(0.010), 5, 0.92, true);
    }
    pc.tint(mulc(mixc(C.white, C.rust, 0.42), 0.90));
    quadZ(pc, zf + 0.016, E.XC - half + 0.06, E.XC - half + 0.16, BOARD_Y0 - 0.02, BOARD_Y1 - 0.10, +1, 0.90);
    quadZ(pc, zf + 0.016, E.XC + half - 0.16, E.XC + half - 0.06, BOARD_Y0 + 0.18, BOARD_Y1 - 0.10, +1, 0.90);
    STATS.props += 2;
  }

  /* =========================================================================
     15.  HUMAN TRACES
     STREET-BRIEF 8.7.  Everything here sits on the porch floor at y = 0.14, at
     most 1.5 units tall, so its highest point is 1.64 -- 4.3 units below the
     standing eye in the door cell and 7.1 below the jump apex.  Nothing can be
     walked into and nothing can be seen through.

     The child's scooter is gone with the stoop it was leaning on: at 2.05 units
     tall it needed a 1.4 m reveal to stand against and the reveal is now 0.98 m
     long, which put its handlebar through the buzzer panel.
     ====================================================================== */
  function traces() {
    var pm = PILES.metal, ps = PILES.sign, pt = PILES.step, i;
    var LY = FLOOR_Y;

    /* --- the doormat, at the threshold, 20 mm proud and slightly askew ------ */
    ps.tint(mulc(C.dark, 1.0));
    atlasQuad(ps, E.XC - 0.10, LY + 0.035, DOORZ + 0.72, 0, 1, 0, 0.998, 0, 0.062,
              m(0.30), m(0.24), SIGN.R.mat, 1);

    /* --- the bag of rubbish in the west corner: three lumps of black
           polythene, tied.  Nothing says "somebody lives here" faster. */
    pm.tile(T_STEEL).tint(mulc(C.black, 1.06));
    var bx = E.LX + 0.52, bz = E.PZ - 0.90;
    abox(pm, bx - 0.40, bx + 0.40, LY, LY + 0.78, bz - 0.38, bz + 0.38, 0.22, 0.86);
    abox(pm, bx - 0.28, bx + 0.32, LY + 0.64, LY + 1.10, bz - 0.26, bz + 0.28, 0.18, 0.84);
    pm.tint(mulc(C.black, 0.92));
    tube(pm, bx, LY + 1.06, bz, bx + 0.12, LY + 1.38, bz - 0.08, m(0.03), 5, 0.86, true);

    /* --- a pair of plastic slippers, kicked off by the door ----------------- */
    pm.tint(mulc(C.plastic, 0.86));
    for (i = 0; i < 2; i++) {
      var px2 = E.XC + 0.50 + i * 0.34, pz2 = DOORZ + 1.30 + i * 0.16;
      abox(pm, px2 - 0.13, px2 + 0.13, LY + 0.01, LY + 0.11,
           pz2 - 0.34, pz2 + 0.34, 0.045, 0.86);
      abox(pm, px2 - 0.11, px2 + 0.11, LY + 0.08, LY + 0.18,
           pz2 - 0.10, pz2 + 0.16, 0.04, 0.84);
    }

    /* --- the cat, asleep just inside the mouth in the sun that is not there.
           Five tubes and a wedge; it only has to read as a cat at 2 m. */
    var cx = E.RX - 0.60, cz = E.PZ - 0.75, cy = LY;
    pm.tint(mulc(C.cat, 1.0));
    tube(pm, cx - 0.24, cy + 0.30, cz - 0.34, cx + 0.20, cy + 0.34, cz + 0.30, m(0.10), 7, 0.92, true);
    tube(pm, cx - 0.30, cy + 0.26, cz - 0.10, cx + 0.24, cy + 0.30, cz + 0.10, m(0.085), 7, 0.90, true);
    /* the head, tucked in */
    tube(pm, cx + 0.16, cy + 0.30, cz + 0.34, cx + 0.30, cy + 0.34, cz + 0.46, m(0.085), 7, 0.94, true);
    pm.tint(mulc(mixc(C.cat, C.white, 0.35), 1.0));
    /* two ears */
    abox(pm, cx + 0.20, cx + 0.27, cy + 0.42, cy + 0.56, cz + 0.36, cz + 0.42, 0.015, 0.92);
    abox(pm, cx + 0.30, cx + 0.37, cy + 0.42, cy + 0.56, cz + 0.40, cz + 0.46, 0.015, 0.92);
    /* the tail, curled round the front */
    pm.tint(mulc(C.cat, 0.94));
    tube(pm, cx - 0.28, cy + 0.22, cz - 0.32, cx + 0.06, cy + 0.20, cz + 0.52, m(0.036), 6, 0.90, true);

    /* the dark patch of grime the cat and the mat have kept off the tile */
    pt.tint(mulc(C.treadW, 0.90));
    quadY(pt, LY + 0.010, cx - 0.5, cx + 0.5, cz - 0.6, cz + 0.6, +1, 0.90);
    STATS.props += 5;
  }

  /* =========================================================================
     16.  THE FOYER
     Indoors, and therefore NOT on the daylight path: the level lights this room
     with two warm lamps at cells (60,34) and (61,32) -- NUKEM.html:3092, world
     (242,10,138) r 18 and (246,10,130) r 14 -- and the whole point of a glazed
     entrance door is that you see a warm interior through a cold pane.  So this
     pile is baked with the game's own lightAt() and its material is named
     'nzenv:ent-foyer', which is what puts it on the same exposure curve as the
     rest of the night level (nz-render.js:2282-2288).

     THE ROOM MOVED AND SHRANK.  The re-carve took it from x [236,252],
     z [124,152] to x [236,252], z [124,148]: the south end came 4 units north
     because row 37 is now solid except for the door cell itself.  Everything
     below is re-derived from FOYER, not shifted by hand.

     THE VISIBLE CONE, REDONE.  It is not +/- 23 degrees any more.  The limiting
     aperture is no longer the recess mouth -- it is the DOOR FRAME, 3.08 units
     clear between the jambs at z = 148.90, and the eye that matters is on the
     pavement cell (60,38) at (242, 6.485, 154.0), 5.1 units in front of it.
     That gives a visible half-width of 1.54 * d / 5.1 = 0.302 d, an angle of
     atan(0.302) = 16.8 degrees, and these consequences:

       west wall  (x = 236.16, 5.84 off the centreline)  visible for z <= 134.7
       east wall  (x = 251.84, 9.84 off)                 NEVER visible: it would
                                                         need z <= 121.4 and the
                                                         room stops at 124
       END WALL   (z = 124.16, 29.84 away)               visible over
                                                         x [233.0, 251.0] --
                                                         i.e. all of it

     So the east wall carries what you find on ENTERING (the meter box, the
     hose cabinet, the stair) and the two things a player is rewarded with for
     putting their face to the glass go where the cone actually reaches: the
     notice board and the bicycle on the west wall BEYOND z = 134.7, and a
     ground-floor flat's door on the end wall, dead ahead down 30 units of lit
     corridor.  Standing in the mouth instead (eye at z = 152.2) opens the cone
     to +/- 25.0 degrees and z <= 139.7 on the west wall, which is what brings
     the mailbox bank into view as you arrive.
     ====================================================================== */
  var FOY_AMB = [0.20, 0.19, 0.18];
  function foyer() {
    var p = PILES.foyer, i;
    p.tile(T_TERR);
    var fx0 = FOYER.x0 + 0.16, fx1 = FOYER.x1 - 0.16;
    var fz0 = FOYER.z0 + 0.16, fz1 = fin(FOYER.z1, 148);
    var CEIL = 12;

    /* --- the terrazzo floor, and the walls it dies into ----------------------
           FLAT, at the same 0.14 as the porch tile: the old four-step drop was
           there to give back a stoop that no longer exists. */
    p.tint(mulc(C.terr, 1.0));
    quadY(p, FLOOR_Y, fx0, fx1, fz0, fz1, +1, 0.96);
    p.ramp(FLOOR_Y, FLOOR_Y + m(1.5), 0.86);          /* scuffed at ankle height */
    p.tint(mulc(C.wallIn, 1.0));
    quadX(p, fx0, FLOOR_Y, CEIL - 0.14, fz0, fz1, +1, 0.90);
    quadX(p, fx1, FLOOR_Y, CEIL - 0.14, fz0, fz1, -1, 0.90);
    quadZ(p, fz0, fx0, fx1, FLOOR_Y, CEIL - 0.14, +1, 0.88);
    /* the south wall, either side of the doorway, facing back into the room */
    quadZ(p, fz1 - 0.02, fx0, E.X0, FLOOR_Y, CEIL - 0.14, -1, 0.86);
    quadZ(p, fz1 - 0.02, E.X1, fx1, FLOOR_Y, CEIL - 0.14, -1, 0.86);
    p.ramp(0, 0, 1);
    /* the skirting: 170 mm of darker terrazzo, which is what these all have */
    p.tint(mulc(C.skirt, 1.0));
    abox(p, fx0, fx0 + 0.13, FLOOR_Y, FLOOR_Y + m(0.17), fz0, fz1, 0.02, 0.80);
    abox(p, fx1 - 0.13, fx1, FLOOR_Y, FLOOR_Y + m(0.17), fz0, fz1, 0.02, 0.80);
    abox(p, fx0, fx1, FLOOR_Y, FLOOR_Y + m(0.17), fz0, fz0 + 0.13, 0.02, 0.80);

    /* --- the doorway reveal INSIDE the glass.  The porch lining (section 8) is
           on the daylight path and stops at the door; from here on the surfaces
           are lit by the entry globe, and the 0.9 m between the leaf and the
           foyer wall line is the first thing the player's eye lands on.  Tinted
           warm so the door reads as a lit interior and not as a hole. */
    var wIn = mixc(C.wallIn, [1.0, 0.86, 0.62], 0.34);
    p.tint(mulc(wIn, 0.92));
    quadX(p, E.LX, FLOOR_Y, FRM_TOP + 0.6, fz1 - 0.02, DOORZ, +1, 0.86);
    quadX(p, E.RX, FLOOR_Y, FRM_TOP + 0.6, fz1 - 0.02, DOORZ, -1, 0.86);
    quadY(p, PORCH_CEIL - 0.08, E.LX, E.RX, fz1 - 0.02, DOORZ, -1, 0.60);
    /* the head over the door from the inside */
    p.tint(mulc(wIn, 0.80));
    quadZ(p, DOORZ - 0.36, E.LX, E.RX, FRM_TOP, PORCH_CEIL - 0.08, -1, 0.72);
    /* the two returns the doorway makes on the hall side, which is what tells
       you from the street that the room is WIDER than the hole you are looking
       through */
    p.tint(mulc(wIn, 1.02));
    quadZ(p, fz1 - 0.02, E.X0 - 0.9, E.X0, FLOOR_Y, CEIL - 0.14, -1, 0.94);
    quadZ(p, fz1 - 0.02, E.X1, E.X1 + 0.9, FLOOR_Y, CEIL - 0.14, -1, 0.94);

    /* --- the mailbox bank on the west wall, right where the post lands ------
           Eight doors for eight flats.  It came in from the porch reveal, which
           is 0.98 m long and cannot take a 1.35 m bank -- and this is where a
           Turkish block actually keeps them.  It stands on a dark recessed
           backboard and carries a pale cornice, so the silhouette separates
           whatever the exposure does. */
    var mz0 = 142.2, mz1 = mz0 + m(1.35), my0 = FLOOR_Y + m(0.68), my1 = my0 + m(0.96);
    p.tint(mulc(C.dark, 0.86));
    abox(p, fx0, fx0 + 0.20, my0 - 0.30, my1 + 0.34, mz0 - 0.30, mz1 + 0.30, 0.02, 0.72);
    p.tint(mulc(C.mailG, 1.22));
    abox(p, fx0 + 0.06, fx0 + 0.50, my0, my1, mz0, mz1, 0.03, 0.94);
    p.tint(mulc(C.white, 1.10));
    abox(p, fx0 + 0.02, fx0 + 0.58, my1 + 0.02, my1 + 0.16, mz0 - 0.10, mz1 + 0.10, 0.02, 1.0);
    PILES.sign.tint(mulc(C.mailG, 1.55));
    atlasQuad(PILES.sign, fx0 + 0.512, (my0 + my1) * 0.5, (mz0 + mz1) * 0.5, 1, 0, 0, 0, 0, 1,
              (mz1 - mz0) * 0.5, (my1 - my0) * 0.5, SIGN.R.mailbox, 1);
    /* the post that missed the boxes, in a drift on the floor under them */
    p.tint(mulc(C.white, 0.94));
    for (i = 0; i < 5; i++) {
      var pz3 = mz0 + rnd(i, 63) * (mz1 - mz0);
      abox(p, fx0 + 0.30, fx0 + 0.30 + 0.62, FLOOR_Y + 0.01, FLOOR_Y + 0.04,
           pz3, pz3 + 0.42, 0.01, 0.74);
    }

    /* --- the notice board: two bills and a strip of tape, on the west wall at
           z 128.6..132.2.  That placement is measured, not decorative: the cone
           above reaches the west wall only past z = 134.7, so anything nearer
           the door than that cannot be part of the reward for looking in.  This
           is 3 to 6 units clear of the limit at 320 px. */
    PILES.sign.tint(mulc(C.white, 1.45));
    atlasQuad(PILES.sign, fx0 + 0.16, FLOOR_Y + m(1.62), 131.60, 1, 0, 0, 0, 0, 1,
              m(0.28), m(0.34), SIGN.R.bill, 1);
    atlasQuad(PILES.sign, fx0 + 0.16, FLOOR_Y + m(1.42), 129.20, 1, 0, 0, 0, 0, 1,
              m(0.26), m(0.20), SIGN.R.notice, 1);
    p.tint(mulc(C.wood, 1.06));
    abox(p, fx0 + 0.02, fx0 + 0.14, FLOOR_Y + m(1.05), FLOOR_Y + m(2.16), 128.4, 132.4, 0.02, 0.86);

    /* --- a bicycle propped against the west wall at z 133..135, the far edge of
           the pavement cone.  Two wheels, a frame triangle and a bar: six tubes,
           and the single most human thing in a Turkish apartment foyer. */
    var bkz = 134.0, bky = FLOOR_Y, bkx = fx0 + 0.68;
    p.tint(mulc(C.dark, 1.06));
    tube(p, bkx - 0.16, bky + 0.92, bkz + 1.05, bkx + 0.16, bky + 0.92, bkz + 1.05, m(0.30), 9, 0.86, false);
    tube(p, bkx - 0.16, bky + 0.92, bkz - 1.05, bkx + 0.16, bky + 0.92, bkz - 1.05, m(0.30), 9, 0.86, false);
    p.tint(mulc(C.red, 1.20));
    tube(p, bkx, bky + 0.92, bkz + 1.02, bkx - 0.10, bky + 2.10, bkz - 0.22, m(0.024), 5, 0.94, true);
    tube(p, bkx, bky + 0.92, bkz - 1.02, bkx - 0.10, bky + 2.10, bkz - 0.22, m(0.024), 5, 0.94, true);
    tube(p, bkx, bky + 0.92, bkz + 1.02, bkx, bky + 1.00, bkz - 1.02, m(0.020), 5, 0.92, true);
    p.tint(mulc(C.steel, 1.10));
    tube(p, bkx - 0.34, bky + 2.34, bkz + 0.62, bkx + 0.34, bky + 2.34, bkz + 0.62, m(0.016), 5, 0.96, true);
    tube(p, bkx - 0.10, bky + 2.10, bkz - 0.22, bkx - 0.02, bky + 2.36, bkz + 0.58, m(0.020), 5, 0.94, true);

    /* --- the radiator under the west wall, with its two pipes -------------- */
    var rz0 = 136.6, rz1 = rz0 + m(1.1);
    p.tint(mulc(C.white, 1.0));
    for (i = 0; i < 9; i++) {
      var fzr = lerp(rz0, rz1, i / 9);
      abox(p, fx0 + 0.06, fx0 + 0.36, FLOOR_Y + m(0.16), FLOOR_Y + m(0.70), fzr, fzr + m(0.075), 0.02, 0.88);
    }
    abox(p, fx0 + 0.06, fx0 + 0.36, FLOOR_Y + m(0.66), FLOOR_Y + m(0.72), rz0, rz1, 0.02, 0.90);
    p.tint(mulc(C.steel, 0.94));
    tube(p, fx0 + 0.2, FLOOR_Y, rz0 - 0.2, fx0 + 0.2, FLOOR_Y + m(0.34), rz0 - 0.2, m(0.014), 5, 0.90, true);

    /* --- THE END WALL, at z = 124.16 and 30 units dead ahead through the glass.
           The one surface in this room the cone shows COMPLETELY, so it carries
           the thing worth seeing: the ground-floor flat's door, panelled timber
           with a number plate, under the hall's second globe.  This is what the
           player is looking at when they stand on the pavement and look in. */
    var dcx = 242.0, dhw = 1.60, dh = FLOOR_Y + 7.35;
    p.tint(mulc(mixc(C.wallIn, C.dark, 0.30), 0.92));       /* the frame reveal */
    abox(p, dcx - dhw - 0.34, dcx + dhw + 0.34, FLOOR_Y, dh + 0.34, fz0 - 0.02, fz0 + 0.30, 0.03, 0.82);
    p.tint(mulc(C.wood, 1.05));                             /* the leaf         */
    abox(p, dcx - dhw, dcx + dhw, FLOOR_Y, dh, fz0 + 0.24, fz0 + 0.46, 0.03, 0.94);
    p.tint(mulc(mulc(C.wood, 0.80), 1));                    /* two sunk panels  */
    abox(p, dcx - dhw + 0.36, dcx + dhw - 0.36, FLOOR_Y + 0.55, FLOOR_Y + 3.10,
         fz0 + 0.22, fz0 + 0.30, 0.02, 0.86);
    abox(p, dcx - dhw + 0.36, dcx + dhw - 0.36, FLOOR_Y + 3.66, dh - 0.55,
         fz0 + 0.22, fz0 + 0.30, 0.02, 0.86);
    p.tint(mulc(C.bronzeL, 1.30));                          /* handle + number  */
    tube(p, dcx + dhw - 0.42, FLOOR_Y + 3.60, fz0 + 0.46, dcx + dhw - 0.42, FLOOR_Y + 3.60,
         fz0 + 0.70, m(0.026), 6, 0.94, true);
    PILES.sign.tint(mulc(C.white, 1.50));
    atlasQuad(PILES.sign, dcx, dh - 0.66, fz0 + 0.48, 0, 0, -1, -1, 0, 0,
              m(0.13), m(0.088), SIGN.R.number, 1);
    /* the doormat outside it, and the electricity board over the frame */
    PILES.sign.tint(mulc(C.dark, 1.20));
    atlasQuad(PILES.sign, dcx, FLOOR_Y + 0.04, fz0 + 1.30, 0, 1, 0, 1, 0, 0,
              m(0.30), m(0.22), SIGN.R.mat, 1);

    /* --- the fire-hose cabinet on the east wall, and the meter board beside the
           door.  Neither is ever in the cone from the pavement -- the east wall
           would need z <= 121.4 -- so both are placed for the player who has
           walked IN, which is when a hose cabinet is worth having. */
    var hz0 = 141.0, hz1 = hz0 + m(0.72), hy0 = FLOOR_Y + m(0.84), hy1 = hy0 + m(0.72);
    p.tint(mulc(C.dark, 0.84));
    abox(p, fx1 - 0.18, fx1, hy0 - 0.24, hy1 + 0.24, hz0 - 0.24, hz1 + 0.24, 0.02, 0.70);
    p.tint(mulc(C.red, 1.30));
    abox(p, fx1 - 0.46, fx1 - 0.04, hy0, hy1, hz0, hz1, 0.03, 0.94);
    PILES.sign.tint(mulc(C.red, 1.55));
    atlasQuad(PILES.sign, fx1 - 0.472, (hy0 + hy1) * 0.5, (hz0 + hz1) * 0.5, -1, 0, 0, 0, 0, 1,
              (hz1 - hz0) * 0.5, (hy1 - hy0) * 0.5, SIGN.R.hose, 1);
    /* the electricity meter board -- the one that came in off the west reveal */
    var ez0 = 145.1, ez1 = ez0 + m(0.36), ey0 = FLOOR_Y + m(0.66), ey1 = ey0 + m(0.42);
    p.tint(mulc(C.grey, 1.16));
    abox(p, fx1 - 0.44, fx1, ey0, ey1, ez0, ez1, 0.03, 0.92);
    PILES.sign.tint(mulc(C.white, 1.40));
    atlasQuad(PILES.sign, fx1 - 0.452, (ey0 + ey1) * 0.5, (ez0 + ez1) * 0.5, -1, 0, 0, 0, 0, 1,
              (ez1 - ez0) * 0.5, (ey1 - ey0) * 0.5, SIGN.R.elec, 1);
    /* the caretaker's corner: a galvanised bucket, a broom and a dustpan */
    p.tint(mulc(C.steel, 1.16));
    tube(p, fx1 - 0.66, FLOOR_Y + 0.02, hz0 - 1.20, fx1 - 0.66, FLOOR_Y + 0.74, hz0 - 1.20,
         m(0.13), 8, 0.86, true);
    p.tint(mulc(C.wood, 1.14));
    tube(p, fx1 - 0.30, FLOOR_Y + 0.05, hz0 - 2.00, fx1 - 0.10, FLOOR_Y + 3.05, hz0 - 1.70,
         m(0.014), 5, 0.92, true);
    p.tint(mulc(C.skirt, 1.20));
    abox(p, fx1 - 0.44, fx1 - 0.16, FLOOR_Y + 0.02, FLOOR_Y + 0.16, hz0 - 2.18, hz0 - 1.80, 0.02, 0.88);

    /* --- the stair going up out of sight, against the east wall ------------
           Eight risers rising north, then a soffit that cuts it off: you see it
           leave the hall and you never see where it goes, which is the whole
           read the brief asks for.  Its west stringer at x = 244.84 is 2.84 off
           the centreline, so from the pavement its lower flight IS in the cone
           (visible for z <= 144.6) even though the wall behind it never is. */
    var sx0 = fx1 - m(2.0), sx1 = fx1 - 0.14;
    var sz = 139.0, srise = m(0.175), sgo = m(0.29), nsteps = 8;
    for (i = 0; i < nsteps; i++) {
      var sy = FLOOR_Y + (i + 1) * srise;
      var az1 = sz - i * sgo, az0 = az1 - sgo;
      p.tint(mulc(C.terr, 0.94 + rnd(i, 61) * 0.09));
      abox(p, sx0, sx1, FLOOR_Y - 0.1, sy, az0, az1, 0, 0.90);
      p.tint(mulc(C.skirt, 1.04));
      abox(p, sx0, sx1, sy - 0.20, sy, az0 - 0.04, az0 + 0.09, 0.02, 0.94);
    }
    /* the handrail.  A free-standing balustrade would stand 3.15 above the
       treads and put its top rail straight through the player's head, so the
       rail is WALL-MOUNTED on the east wall instead: 0.30 off the x = 252 plane,
       legal by rule A whatever height it runs at, and what half these stairs
       actually have. */
    p.tint(mulc(C.wood, 1.02));
    tube(p, fx1 - 0.30, FLOOR_Y + srise + m(0.90), sz - sgo * 0.5,
         fx1 - 0.30, FLOOR_Y + nsteps * srise + m(0.90), sz - (nsteps - 0.5) * sgo,
         m(0.028), 6, 0.94, true);
    for (i = 0; i < nsteps; i += 3) {
      var by = FLOOR_Y + (i + 1) * srise + m(0.90), bz = sz - (i + 0.5) * sgo;
      p.tint(mulc(C.steel, 0.94));
      tube(p, fx1, by, bz, fx1 - 0.30, by, bz, m(0.014), 5, 0.90, true);
    }
    /* the soffit that takes the flight out of sight.  Rule B: its underside is
       at 8.80, above jumpTop(0) = 8.70, so it can never be jumped into. */
    p.tint(mulc(C.wallIn, 0.86));
    abox(p, sx0 - 0.3, fx1, FLOOR_Y + 8.66, CEIL - 0.14, fz0, sz - (nsteps - 1) * sgo, 0.03, 0.72);

    /* --- the globe fittings.  The brief asks for "a bare bulb or a globe
           fitting", and they are also the visible sources for the ENTRY_BULB and
           HALL_BULB terms in the night bake -- an unmotivated light is a realism
           failure (nz-env.js:49-52) and so is an unlit fitting.  Rule B: the
           bottom of a globe is at 10.06, well over jumpTop(0) = 8.70. */
    globe(p, ENTRY_BULB, CEIL, 1.00);
    globe(p, HALL_BULB, CEIL, 0.88);

    STATS.props += 12;
  }
  /* rose, drop and opal globe.  Two of these now: see HALL_BULB. */
  function globe(p, B, CEIL, k) {
    p.tint(mulc(C.white, 0.90));
    abox(p, B.x - 0.24, B.x + 0.24, CEIL - 0.30, CEIL - 0.14, B.z - 0.24, B.z + 0.24, 0.04, 0.80);
    tube(p, B.x, CEIL - 0.30, B.z, B.x, B.y + 0.34, B.z, m(0.012), 5, 0.84, false);
    /* the opal globe: three stacked rings, cheaper and rounder than a sphere,
       and tinted well over 1 so it reads as the source it is */
    p.tint([2.6 * k, 2.42 * k, 2.05 * k]);
    tube(p, B.x, B.y + 0.34, B.z, B.x, B.y + 0.16, B.z, m(0.075), 8, 1, false);
    tube(p, B.x, B.y + 0.16, B.z, B.x, B.y - 0.16, B.z, m(0.098), 8, 1, false);
    tube(p, B.x, B.y - 0.16, B.z, B.x, B.y - 0.34, B.z, m(0.068), 8, 1, true);
  }

  /* =========================================================================
     17.  BAKE, MERGE, MESH
     ====================================================================== */
  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  /* the night bake, for the foyer only.  Uses the game's own lightAt() so the
     interior sits in exactly the light the level author placed; falls back to a
     hand-rolled solve over the two foyer lamps if the global is not reachable. */
  var NIGHT_LAMPS = [
    { x: 242, y: 10, z: 138, c: [1.0, 0.88, 0.66], r: 18, i: 0.95 },
    { x: 246, y: 10, z: 130, c: [0.98, 0.90, 0.74], r: 14, i: 0.70 }
  ];
  /* the globe fitting over the entry landing.  It exists as GEOMETRY (see
     foyer()) and as a term in this bake, and as nothing else: adding a real
     THREE light would light the night half of the level too, because r149 has
     no per-object light masking.  Without it the first four metres of the foyer
     -- the only part anyone sees through the glass -- sit at ambient 0.20 and
     the door reads as a hole in the wall. */
  var ENTRY_BULB = { x: 242, y: 10.4, z: 145.6, c: [1.0, 0.90, 0.70], r: 26, i: 1.05 };
  /* THE SECOND FITTING, and what makes the foyer worth looking into.  With one
     globe over the entry landing the whole room fell off a cliff four metres in:
     the mailbox bank, the fire-hose cabinet and the stair -- everything the
     player is actually looking at when they put their face to the glass -- sat
     at the region ambient of 0.20 and were silhouettes of the same value as the
     wall behind them.  A hall this long has a second fitting halfway down it;
     the geometry for it is in foyer() and this is its term, exactly as
     ENTRY_BULB is.  Still no THREE light: r149 cannot mask one per object. */
  /* IT MOVED NORTH, AND THAT IS THE COMPUTATION, NOT A NUDGE.  The end wall at
     z = 124.16 is the one surface the visible cone shows completely (section
     16), so it has to be lit or the reward for looking in is a black rectangle.
     From z = 131.0 it is 6.8 away and reads att = (1 - 6.8/25)^2 = 0.53; from
     the old 141.2 it was 17 away and read 0.10, which is why the far half of
     the hall used to fall off a cliff.  The near half is covered by ENTRY_BULB
     and by the level's own lamp at (242,10,138).  Still no THREE light: r149
     cannot mask one per object. */
  var HALL_BULB = { x: 242.6, y: 10.4, z: 131.0, c: [1.0, 0.90, 0.72], r: 25, i: 0.86 };
  function litAt(x, y, z, nx, ny, nz, out) {
    var base = null;
    if (G && G.lightAt) {
      try {
        var c = G.lightAt(x, y, z, nx, ny, nz, FOY_AMB, false, false);
        base = [c[0], c[1], c[2]];
      } catch (e) { base = null; }
    }
    var r, g, b, k, lamps;
    if (base) { r = base[0]; g = base[1]; b = base[2]; lamps = [ENTRY_BULB, HALL_BULB]; }
    else {
      r = FOY_AMB[0]; g = FOY_AMB[1]; b = FOY_AMB[2];
      lamps = NIGHT_LAMPS.concat([ENTRY_BULB, HALL_BULB]);
    }
    for (k = 0; k < lamps.length; k++) {
      var Lp = lamps[k];
      var dx = Lp.x - x, dy = Lp.y - y, dz = Lp.z - z;
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > Lp.r * Lp.r) continue;
      var d = Math.sqrt(d2) || 1e-4;
      var nd = (dx * nx + dy * ny + dz * nz) / d;
      if (nd <= 0.02) continue;
      nd = 0.28 + 0.72 * nd;
      var att = 1 - d / Lp.r; att *= att;
      var kk = att * nd * Lp.i;
      r += Lp.c[0] * kk; g += Lp.c[1] * kk; b += Lp.c[2] * kk;
    }
    out[0] = clamp(r, 0, 1.45); out[1] = clamp(g, 0, 1.45); out[2] = clamp(b, 0, 1.45);
    return out;
  }
  function bakeNight(geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var n = pos.count, col = new Float32Array(n * 3), tmp = [0, 0, 0], i;
    for (i = 0; i < n; i++) {
      var nx = nrm ? nrm.getX(i) : 0, ny = nrm ? nrm.getY(i) : 1, nz = nrm ? nrm.getZ(i) : 0;
      litAt(pos.getX(i) + nx * 0.3, pos.getY(i) + ny * 0.3, pos.getZ(i) + nz * 0.3,
            nx, ny, nz, tmp);
      col[i * 3] = tmp[0]; col[i * 3 + 1] = tmp[1]; col[i * 3 + 2] = tmp[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (geo.attributes.uv && !geo.attributes.uv2) geo.setAttribute('uv2', geo.attributes.uv);
    return geo;
  }

  /* multiply the pile's LINEAR tint into whatever the bake wrote, and -- if the
     pile carries alpha -- widen the colour attribute to itemSize 4, which is
     what makes r149 define USE_COLOR_ALPHA and hand us per-vertex transparency. */
  /* THE INTER-REFLECTION LEVEL INSIDE THE RECESS, and the single number this
     whole file was getting wrong.

     0.355 was chosen against the OLD bake, where `floor` was charged flat to
     every blocked ray however close the blocker was, so it had to be generous
     or a 1.1 m wide porch went black.  nz-street-sky.js now charges
     `floor x nearAtten(t)` -- nearAtten(9) = 1, nearAtten(1) = 0.33,
     nearAtten(0) = 0.20 -- so the same constant no longer means the same thing:
     what it sets is what a blocker NINE UNITS AWAY returns, and everything the
     porch is actually made of is one to four units away and reads a third to
     two thirds of it.  Combined with section 7's occluder set, which stops the
     back half of the porch falling outside the canyon footprint and reading
     nearAtten(9) = 1 for free, 0.20 is what lands the recess on the reference.

     Measured against _ref/ref1, where the porch recess of the cream block
     reads 0.44 - 0.50 of the open render on the same facade.  It is not zero
     and must not be: a porch bounded by pale render, a pale ceramic stoop and a
     lit pavement does bounce, and at zero the letterboxes and the intercom --
     which the player is supposed to walk up to and read -- go to black.

     RE-MEASURED FOR THE NEW RECESS, and the old number was wrong for it.  The
     re-carve made the porch a 1.05 m wide, 1.18 m deep, 2.87 m tall slot behind
     BOX.z0, which is a far stronger occluder set than the old 2.3 m deep cikma
     recess in front of it, and 0.085 came back at 0.442 overall with the reveal
     surfaces themselves at 0.197 -- inside the reference band on the whole
     opening but with the mouth arris rendering as a black picture frame.

     The measurement is fixed and repeatable so the next agent can redo it:
     render `--at=242,5.4,160 --lookat=242,4.6,150 --w=420 --h=264`, then take

       recess = mean LINEAR luminance of x[160,262] y[30,178]   (the opening)
       open   = mean of x[130,157] and x[264,294], same rows     (the render)
       ratio  = recess / open

     _ref/ref1 measures 0.44 - 0.50 for the same pair; the critic's ref2 figure
     is 0.57.  Measured here:

         0.085  ->  0.442 overall, 0.197 on the reveals   (too flat a frame)
         0.125  ->  0.443 overall, 0.182 on the reveals   SHIPPED

     The floor barely moves it and that is not a bug: nz-street-sky.js charges
     `floor x nearAtten(t)` and every occluder in this porch is 0.1 to 1.5 units
     away, where nearAtten is 0.22 to 0.40 -- so 0.04 of floor is worth 0.01 of
     radiance.  What actually sets the recess ratio here is the OCCLUDER SET in
     section 7 and the reveal albedo in section 8, and those are the two knobs
     to reach for next time.  Measured bake values, straight out of
     NZ.street.bake() with this occluder list: open wall 0.20-0.25, mouth arris
     0.15-0.17, reveal lining 0.075-0.089.  The wall/reveal pair is 1:0.37,
     which is the shape a 1.05 m wide, 1.18 m deep slot should have. */
  var PORCH_FLOOR = 0.125;

  function finishGeo(pile, geo, opts) {
    opts = opts || {};
    var t0 = now();
    if (opts.night) bakeNight(geo);
    else sbake(geo, {
      occluders: opts.occluders || OCC, rays: opts.rays || RAYS,
      bias: fin(opts.bias, 0.05), floor: fin(opts.floor, 0.30),
      roofY: BOX.y1, matrix: opts.matrix || null
    });
    try {
      var ca = geo.attributes.color, ta = pile.tintArr, aa = pile.alphaArr, i;
      if (!ca || !ta) return geo;
      var n = geo.attributes.position.count;
      if (aa && aa.length === n) {
        var out = new Float32Array(n * 4);
        for (i = 0; i < n; i++) {
          out[i * 4] = ca.array[i * 3] * ta[i * 3];
          out[i * 4 + 1] = ca.array[i * 3 + 1] * ta[i * 3 + 1];
          out[i * 4 + 2] = ca.array[i * 3 + 2] * ta[i * 3 + 2];
          out[i * 4 + 3] = aa[i];
        }
        geo.setAttribute('color', new THREE.BufferAttribute(out, 4));
      } else if (ta.length === ca.array.length) {
        var arr = ca.array;
        for (i = 0; i < arr.length; i++) arr[i] *= ta[i];
        ca.needsUpdate = true;
      } else {
        warn('tint/colour length mismatch');
      }
    } catch (e) { warn('tint merge failed: ' + (e && e.message)); }
    STATS.bakeMs += Math.round(now() - t0);
    return geo;
  }

  function makeMesh(pile, mat, name, opts) {
    if (!pile || pile.empty() || !mat) {
      DIAG.piles.push({ name: name, tris: 0, added: false });
      return null;
    }
    var geo = pile.geometry();
    finishGeo(pile, geo, opts);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (opts && opts.order) mesh.renderOrder = opts.order;
    scene.add(mesh);
    OWN.obj.push(mesh);
    STATS.addedCalls++;
    var tris = (pile.idx.length / 3) | 0;
    STATS.tris += tris; STATS.verts += pile.n;
    DIAG.piles.push({ name: name, tris: tris, verts: pile.n, added: true });
    return mesh;
  }

  /* =========================================================================
     18.  CLEARANCE -- proved, not asserted
     Grid collision knows nothing about any of this, so every emitter has to be
     legal by one of ENV-PLAYBOOK 7.3's five rules.  The two that matter here:

       A  a prop protrudes at most HUG = 0.98 from a real wall plane;
       B  a prop's lowest point is above jumpTop(f) = f + 8.70.

     and the stoop itself, which is neither: it is geometry the player passes
     THROUGH at foot level.  That is only acceptable while its highest point
     stays clear of the camera, so the margin is computed here and reported,
     rather than being asserted in a comment.
     ====================================================================== */
  function checkClearance() {
    var fWalk = 0.5, fFoyer = 0;
    var camWalk = fWalk + G.EYE;                       /* 6.485 */
    var over = jumpTop(fWalk);                         /* 9.19  */
    var i, worst = 1e9;

    /* things that hang over a walking line: rule B.  The porch floor is at
       f = 0 (the door cell is painted rResFoyer) so anything over the RECESS is
       measured against jumpTop(0) = 8.70; only the hood is over the pavement at
       f = 0.5 and its apex is jumpTop(0.5) = 9.20.  Getting this pair the wrong
       way round is how a canopy ends up 0.5 units too low. */
    var overhead = [
      ['porch ceiling', PORCH_CEIL - 0.06, fFoyer],
      ['porch cornice', PORCH_CEIL - 0.44, fFoyer],
      ['door frame head', FRM_TOP, fFoyer],
      ['head panel underside', FRM_TOP - 0.06, fFoyer],
      ['hood soffit', CAN_Y0, fWalk],
      ['bulkhead light', FRM_TOP + 0.30, fFoyer],
      ['foyer stair soffit', FLOOR_Y + 8.66, fFoyer]
      /* the ground-floor flat's door on the foyer end wall is NOT in this list.
         Its head is at 7.49, under jumpTop(0) = 8.69, and that is fine: it is
         not a soffit over a walking line, it is a door in a wall, and its
         deepest point stands 0.62 off the z = 124 plane -- legal by rule A,
         checked in `prot` below.
         the gas run and the telecom bundle are NOT in this list either: they hug the
         west reveal at 0.27 off the x = 240 wall plane and are therefore legal
         by rule A whatever height they run at.  They are checked below. */
    ];
    for (i = 0; i < overhead.length; i++) {
      var lo = overhead[i][1], need = jumpTop(overhead[i][2]);
      if (lo < need) warn('OVERHEAD ' + overhead[i][0] + ' at y=' + lo.toFixed(2) +
                          ' is below jumpTop(' + overhead[i][2] + ') = ' + need.toFixed(2));
      worst = Math.min(worst, lo - need);
    }
    /* things the player walks through: they must stay clear of the camera.
       THE LIST IS SHORT NOW.  The stoop is gone, the garden enclosure belongs
       to PROPS, and the porch floor is at the grid's own floor -- so the only
       walk-through geometry left in the recess is 200 mm of threshold and the
       traces standing on the tile. */
    var camFoyer = fFoyer + G.EYE;                     /* 5.985 */
    var solids = [
      ['porch floor', FLOOR_Y, camFoyer],
      ['threshold + sill', SILL_Y + 0.08, camFoyer],
      ['mouth riser nosing', PAVE_Y, camWalk],
      ['rubbish bag', FLOOR_Y + 1.38, camFoyer],
      ['cat', FLOOR_Y + 0.56, camFoyer],
      ['grab rail', FLOOR_Y + RAIL_H, camFoyer],
      ['foyer stair', FLOOR_Y + 8 * m(0.175), camFoyer],
      ['foyer bicycle', FLOOR_Y + 2.36, camFoyer]
    ];
    for (i = 0; i < solids.length; i++) {
      var margin = solids[i][2] - solids[i][1];
      if (margin < 0.60)
        warn('WALK-THROUGH ' + solids[i][0] + ' tops at ' + solids[i][1].toFixed(2) +
             ', only ' + margin.toFixed(2) + ' below the camera at ' + solids[i][2].toFixed(2));
    }
    /* rule A: the deepest thing off a wall plane */
    var prot = [
      ['reveal lining', 0.16], ['grab rail', 0.30 + 0.16 + RAIL_R],
      ['buzzer panel', 0.16 + 0.34], ['gas cabinet', 0.16 + 0.52],
      ['number plaque', (E.PLINF + 0.012) - E.PZ],
      ['gas run', 0.26 + m(0.028)], ['telecom bundle', 0.10 + 0.05 + m(0.008)],
      ['foyer flat door', 0.62], ['foyer mailbox bank', 0.16 + 0.50],
      ['hood over the pavement', CAN_Z1 - E.PZ]
    ];
    for (i = 0; i < prot.length; i++) {
      /* the hood is legal by rule B, not rule A: it is above the jump apex.
         Everything else has to hug. */
      if (i === prot.length - 1) continue;
      hug(prot[i][1]);
      if (prot[i][1] > HUG) warn('PROTRUSION ' + prot[i][0] + ' = ' + prot[i][1].toFixed(2) +
                                 ' exceeds HUG ' + HUG);
    }
    STATS.camMargin = +(camFoyer - FLOOR_Y).toFixed(2);
    STATS.headMargin = +worst.toFixed(2);
    note('clearance: porch floor at ' + FLOOR_Y.toFixed(2) + ' (grid f=0), eye ' +
         STATS.camMargin + ' above it = ' + (STATS.camMargin / U).toFixed(2) +
         ' m; lowest overhead is ' + STATS.headMargin.toFixed(2) + ' above its jump apex');
  }

  /* =========================================================================
     19.  BUILD
     ====================================================================== */
  function buildEverything() {
    PILES = {
      conc: new Pile(false),
      step: new Pile(false),
      metal: new Pile(false),
      glass: new Pile(true),          /* per-vertex alpha: see section 5 */
      sign: new Pile(false),
      foyer: new Pile(false)
    };
    PILES.conc.tile(T_CONC);
    PILES.step.tile(T_STEP);
    PILES.metal.tile(T_STEEL);
    PILES.glass.tile(T_GLASS);
    PILES.sign.tile(4);
    PILES.foyer.tile(T_TERR);

    porchShell();
    porchFloor();
    grabRail();
    doorScreen();
    furniture();
    services();
    nameBoard();
    traces();
    foyer();
    checkClearance();
  }

  /* the carve may not be in this build, and this module must be inert rather
     than wrong if it is not */
  function hasEntrance() {
    if (!G.inb || !G.regAt) return false;
    /* the door cell itself -- (60,37) now, not (60,38) */
    var cx = Math.floor(E.XC / G.CELL);
    var cy = Math.floor(((fin(DOORB.z0, E.PZ - 4) + fin(DOORB.z1, E.PZ)) * 0.5) / G.CELL);
    if (!G.inb(cx, cy)) return false;
    /* A painted outdoor region is not an entrance.  The long 233 Sk rebuild
       deliberately removes the old residential gameplay doorway while the
       public fight entrance moves to the last building opposite the park.
       Requiring the actual grid door keeps this legacy porch module from
       materialising at its former coordinates on otherwise walkable road. */
    if (G.cellAt(cx, cy) !== G.S_DOOR) return false;
    if (!G.regAt(cx, cy)) return false;
    /* the walkable pavement cell in front of it */
    var wy = Math.floor((E.PZ + 1) / G.CELL);
    if (!G.inb(cx, wy)) return false;
    /* and the foyer cell behind it */
    var by = Math.floor((fin(DOORB.z0, E.PZ - 4) - 1) / G.CELL);
    if (!G.inb(cx, by)) return false;
    return true;
  }

  /* =========================================================================
     20.  INSTALL
     ====================================================================== */
  function install(ctx) {
    if (dead || installed) return;
    /* Later missions have no street: without this gate the module builds its
       fallback recess in solid rock and emits a misleading diagnostic. */
    if (NZ.level !== undefined && NZ.level !== 1 && NZ.level !== 4) {
      NZ.log && NZ.log('street-entrance: level ' + NZ.level + ', module inert');
      return;
    }
    var t0 = now();
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
    renderer = (ctx && ctx.renderer) || (NZ.ctx && NZ.ctx.renderer);
    if (!THREE || !scene) throw new Error('nz-street-entrance: renderer context missing');
    if (!NZ.tex || !NZ.tex.mulberry32) throw new Error('nz-street-entrance: NZ.tex missing');

    G = bindGame();
    if (!G) { NZ.log && NZ.log('street-entrance: game level globals unavailable, module inert'); return; }

    /* re-read the namespaces: the sky and the ground publish at script-parse
       time, but FACADE fills NZ.street.facades in its own hook, which fires
       immediately before this one (STREET-MODULE-CONTRACT section 5) */
    ST = NZ.street || ST;
    GRD = NZ.streetGround || GRD;
    if (ST) {
      PLANE = ST.PLANE || PLANE; BOX = ST.BOX || BOX;
      FOYER = ST.FOYER || FOYER; DOORB = ST.DOOR || DOORB;
      STOREY = ST.STOREY || STOREY;
    }
    if (GRD && GRD.Y) PAVE_Y = fin(GRD.Y.pavement, PAVE_Y);
    else note('nz-street-ground absent: standing the porch on the fallback paving y=' + PAVE_Y);

    applyTier();
    try { ANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } catch (e) { ANISO = 8; }

    E = resolveEntrance();
    /* THE LEVEL SECTION, resolved from GROUND and the grid rather than assumed.
       FLOOR_Y is the porch/foyer tile datum over the grid's f = 0; the ONE
       riser is whatever GROUND actually paved the pavement at, minus that. */
    FLOOR_Y = 0.14;
    LAND_Y = FLOOR_Y;
    RISE = PAVE_Y - FLOOR_Y;
    NOSE0 = E.PZ;                          /* the riser IS the cell boundary   */
    SILL_Y = FLOOR_Y + SILL_H;
    if (RISE < 0.10 || RISE > 1.05) {
      warn('the mouth riser is ' + RISE.toFixed(2) + ' units (' +
           (RISE / U * 1000).toFixed(0) + ' mm) -- GROUND paved at ' +
           PAVE_Y.toFixed(2) + ' against a foyer floor at ' + FLOOR_Y.toFixed(2));
    }
    if (E.DEPTH < 2.4) {
      warn('the recess is only ' + E.DEPTH.toFixed(2) + ' units deep (' +
           (E.DEPTH / U).toFixed(2) + ' m): the door screen at ' + DOORZ.toFixed(2) +
           ' leaves no reveal for the buzzer panel or the gas cabinet');
    }
    if (DOORZ < E.BACK + 0.4 || DOORZ > E.MOUTH - 0.8) {
      warn('the door screen at z=' + DOORZ.toFixed(2) + ' is outside the recess [' +
           E.BACK.toFixed(2) + ',' + E.MOUTH.toFixed(2) + ']');
    }
    resolveFrame();
    buildOccluders();

    if (!hasEntrance()) {
      /* Residential portals are now visual-only.  The sole public gameplay
         entrance belongs to the park-end arena module, so absence of the old
         apartment door is an intentional inert state rather than a failed
         install. */
      installed = true;
      NZ.flags.streetEntrance = true;
      NZ.streetEntrance = {
        ok: true, inert: true, reason: 'fight entrance owned by NZ.streetPark',
        keepClear: null, report: function () { return 'NZ-STREET-ENTRANCE inert: fight entrance owned by STREET-PARK'; },
        dispose: function () { panic('manual dispose'); }
      };
      NZ.log && NZ.log('street-entrance: old residential carve absent; park-end fight entrance owns gameplay');
      return;
    }

    buildSignAtlas();

    /* THE REVEALS CAME BACK BLUE.  NZ.street.SKY.zenith is [0.94,1.25,1.71] --
       a strongly blue overcast dome -- and a 1 m deep reveal is seen from the
       pavement at 85 degrees off its normal, where a MeshStandardMaterial's
       envMap term climbs steeply.  At env 0.85 the salmon render inside the
       porch rendered (99,110,125): blue-grey steel, not the render of
       _ref/ref7.  A matt cement render has almost no specular at any angle, so
       the fix is the material, not the tint. 0.42 puts the albedo back in
       charge and leaves just enough sheen for the arris to catch: 0.62 with the
       reveal albedo lifted to compensate lands the render back on salmon
       without the steel. */
    var mConc = mkMat('conc', 'conc', { tile: T_CONC, metal: 0, nrm: 0.62, env: 0.62 });
    var mStep = mkMat('step', 'step', { tile: T_STEP, metal: 0, nrm: 0.92, env: 0.66, ao: 1.0 });
    var mMetal = mkMat('steel', 'metal', { tile: T_STEEL, metal: 1, nrm: 1.05, env: 1.15 });
    /* the glazing.  transparent + depthWrite: the foyer behind it is opaque and
       has already been drawn, so back-to-front is satisfied, and writing depth
       keeps the door in front of anything else transparent that turns up later.
       DoubleSide because the leaf is read from the foyer as well as the street. */
    var mGlass = mkMat('glass', 'glass', {
      tile: T_GLASS, metal: 0, nrm: 0.45, env: 0.95, ao: 0.5,
      transparent: true, depthWrite: true, side: THREE.DoubleSide
    });
    var mFoyer = mkMat('terr', 'foyer', { tile: T_TERR, metal: 0, nrm: 0.88, night: true, env: 0.40 });
    if (!mConc || !mStep || !mMetal || !mGlass || !mFoyer) throw new Error('a material failed to bake');

    buildEverything();

    makeMesh(PILES.conc, mConc, 'nzent-porch-render', { rays: RAYS, floor: PORCH_FLOOR });
    makeMesh(PILES.step, mStep, 'nzent-porch-ceramic', { rays: RAYS, floor: PORCH_FLOOR });
    makeMesh(PILES.metal, mMetal, 'nzent-metalwork', { rays: RAYS, floor: PORCH_FLOOR });
    makeMesh(PILES.sign, SIGN.mat, 'nzent-signage', { rays: Math.max(8, RAYS >> 1), floor: PORCH_FLOOR });
    makeMesh(PILES.foyer, mFoyer, 'nzent-foyer', { night: true });
    makeMesh(PILES.glass, mGlass, 'nzent-glazing', { rays: Math.max(8, RAYS >> 1), floor: PORCH_FLOOR + 0.05, order: 2 });

    STATS.ms = Math.round(now() - t0);
    installed = true;
    NZ.flags.streetEntrance = true;
    NZ.streetEntrance = {
      ok: true, tier: TIER,
      stats: STATS, diag: DIAG,
      /* KEEPCLEAR, SHRUNK ON PURPOSE.  Last round this box was x [237.9, 246.1]
         by z [152.2, 164.4] -- 8.2 by 12.2 units -- because the entrance built
         its own garden wall, piers and gate and had to reserve the whole
         forecourt for them.  PROPS owns the brick wall and the railing panels
         this round, so what the entrance actually needs is only the DOOR
         APPROACH: the recess itself plus the strip of pavement the hood covers
         and a hand's breadth beyond it.  That is 6.94 by 7.38 units --
         a 1.98 m gate opening and 2.11 m of clear forecourt -- and it leaves
         PROPS the 4.6 units of pavement between z = 155.4 and the kerb at 160
         for its wall line, its trees and the tree pit at x 248..252 that
         AMENDMENT 2 section 6.2 puts east of the door to frame it.

         PROPS must leave its wall/railing OPEN over [x0,x1] and must stand
         nothing inside the box at all.  `gate` below is the same opening said
         plainly, for a module that wants to centre a gate on it. */
      keepClear: { x0: E.X0 - m(0.42), x1: E.X1 + m(0.42),
                   z0: E.BACK, z1: CAN_Z1 + 1.30 },
      gate: { x0: E.X0 - m(0.42), x1: E.X1 + m(0.42), xc: E.XC,
              widthM: (E.X1 - E.X0 + m(0.84)) / U, groundY: PAVE_Y },
      /* the recess, for anything that wants to aim at it */
      recess: { x0: E.X0, x1: E.X1, z0: E.BACK, z1: E.MOUTH,
                lx: E.LX, rx: E.RX, headY: E.HEAD, ceilY: PORCH_CEIL,
                openingY: PORCH_CEIL - 0.06, depth: E.DEPTH,
                floorY: FLOOR_Y, mouthPlane: E.MOUTH },
      hood: { x0: CAN_X0, x1: CAN_X1, y0: CAN_Y0, y1: CAN_Y1, z1: CAN_Z1 },
      landingY: LAND_Y, floorY: FLOOR_Y, paveY: PAVE_Y,
      steps: 1, rise: RISE, riserZ: E.PZ, sillY: SILL_Y,
      doorCell: [Math.floor(E.XC / 4), Math.floor((fin(DOORB.z0, 148) + 2) / 4)],
      doorPlane: DOORZ, headY: E.HEAD, railColour: 0x9c4b38,
      recessRatio: PORCH_FLOOR,
      megabytes: +(STATS.texBytes / 1048576).toFixed(2),
      report: report,
      dispose: function () { panic('manual dispose'); }
    };
    NZ.log && NZ.log('street-entrance installed: tier=' + TIER + ' draws +' + STATS.addedCalls +
                     ' tris ' + STATS.tris + ' in ' + STATS.ms + 'ms');
    if (DIAGON) installOverlay();
  }

  /* =========================================================================
     21.  TEARDOWN -- the level must run with this file deleted
     ====================================================================== */
  function panic(err) {
    if (dead) return;
    dead = true;
    if (NZ.flags) NZ.flags.streetEntrance = false;
    if (NZ.streetEntrance) NZ.streetEntrance.ok = false;
    if (err) { try { console.error('[nz-street-entrance] disabled after error:', err); } catch (e) {} }
    try {
      var i;
      if (OWN.timer) { try { global.clearInterval(OWN.timer); } catch (e0) {} OWN.timer = 0; }
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      /* the door first: hand back exactly the geometry and material we found,
         which is nz-env's, so ITS teardown still resolves to the original */
      for (i = 0; i < OWN.restore.length; i++) {
        var s = OWN.restore[i];
        if (!s.mesh) continue;
        if (s.material) s.mesh.material = s.material;
        if (s.geometry) s.mesh.geometry = s.geometry;
        s.mesh.castShadow = true;
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
      SETS = Object.create(null); MATS = Object.create(null);
      NOISE = Object.create(null); LATTICE = Object.create(null); AXIS = Object.create(null);
      SIGN = { tex: null, mat: null, R: {}, W: 1024 };
      PILES = null; installed = false;
    } catch (e4) { try { console.error('[nz-street-entrance] teardown failed:', e4); } catch (e5) {} }
  }

  /* =========================================================================
     22.  SELF-REPORT -- a module that cannot see the screen must prove itself
     ====================================================================== */
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function report() {
    var Ls = [], i;
    Ls.push('NZ-STREET-ENTRANCE tier=' + TIER + ' install=' + STATS.ms + 'ms bake=' +
            STATS.bakeMs + 'ms vram~' + (STATS.texBytes / 1048576).toFixed(1) + 'MB');
    if (E) {
      Ls.push('  recess x[' + E.X0 + ',' + E.X1 + '] z[' + E.BACK.toFixed(2) + ',' +
              E.MOUTH.toFixed(2) + '] depth ' + (E.DEPTH / U).toFixed(2) + ' m  head ' +
              E.HEAD.toFixed(2) + '  run=' + E.kind + '  plane z=' + E.PZ);
      Ls.push('  section: paving ' + PAVE_Y.toFixed(2) + ' -> ONE riser of ' +
              RISE.toFixed(2) + ' (' + (RISE / U * 1000).toFixed(0) + ' mm) at z=' +
              E.PZ + ' -> porch/foyer floor ' + FLOOR_Y.toFixed(2) +
              ' -> sill ' + SILL_Y.toFixed(2) + '   (grid lie = 0.00)');
      Ls.push('  door screen z=' + DOORZ.toFixed(2) + '  leaf ' + SILL_Y.toFixed(2) + '..' +
              LEAF_TOP.toFixed(2) + '  board ' + BOARD_Y0.toFixed(2) + '..' + BOARD_Y1.toFixed(2) +
              '  fanlight ..' + FAN_TOP.toFixed(2) + '  frame head ' + FRM_TOP.toFixed(2) +
              '   hood ' + CAN_Y0.toFixed(2) + '..' + CAN_Y1.toFixed(2) + ' out to z=' +
              CAN_Z1.toFixed(2));
      Ls.push('  foyer x[' + FOYER.x0 + ',' + FOYER.x1 + '] z[' + FOYER.z0 + ',' + FOYER.z1 +
              ']  visible cone +/-16.8 deg from the pavement, +/-25.0 from the mouth' +
              '   bulbs z=' + ENTRY_BULB.z + ' / ' + HALL_BULB.z);
      if (NZ.streetEntrance && NZ.streetEntrance.keepClear) {
        var k = NZ.streetEntrance.keepClear;
        Ls.push('  keepClear x[' + k.x0.toFixed(2) + ',' + k.x1.toFixed(2) + '] z[' +
                k.z0.toFixed(2) + ',' + k.z1.toFixed(2) + ']  = ' +
                ((k.x1 - k.x0) / U).toFixed(2) + ' m gate x ' +
                ((k.z1 - k.z0) / U).toFixed(2) + ' m deep   porchFloor=' + PORCH_FLOOR);
      }
    }
    for (i = 0; i < DIAG.sets.length; i++) {
      var b = DIAG.sets[i];
      Ls.push('  set ' + pad(b.name, 8) + b.res + 'px lum ' + pad(b.lum.toFixed(0), 4) +
              ' sat ' + b.sat.toFixed(3) + ' relief ' + pad(b.reliefMM + 'mm', 7) +
              ' swing ' + pad(b.swingMM + 'mm', 8) + (b.black ? '  <<< BLACK' : ''));
    }
    for (i = 0; i < DIAG.piles.length; i++) {
      var p = DIAG.piles[i];
      Ls.push('  pile ' + pad(p.name || '?', 22) + ' tris ' + pad(String(p.tris), 7) +
              (p.added ? '' : '  (EMPTY - not added)'));
    }
    Ls.push('props=' + STATS.props + ' steps=' + STATS.steps + ' draws +' + STATS.addedCalls +
            ' tris ' + STATS.tris + ' verts ' + STATS.verts +
            ' door=' + (STATS.doorReskinned ? 'reskinned' : 'UNTOUCHED') +
            ' clearanceClamps=' + STATS.clearanceClamps);
    for (i = 0; i < DIAG.notes.length; i++) Ls.push('  . ' + DIAG.notes[i]);
    if (DIAG.warnings.length) {
      Ls.push('WARNINGS (' + DIAG.warnings.length + '):');
      for (i = 0; i < DIAG.warnings.length; i++) Ls.push('  ! ' + DIAG.warnings[i]);
    }
    return Ls.join('\n');
  }

  var DIAGON = /[?&]nzdiag=1/.test(global.location ? global.location.search : '');
  var overlay = null;
  function installOverlay() {
    try {
      if (overlay || !global.document || !document.body) return;
      overlay = document.createElement('div');
      overlay.id = 'nzent-diag';
      /* nz-env's overlay is bottom-left and nz-street's bottom-right, so this
         one takes the bottom centre and a lower z-index than either */
      overlay.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:0;' +
        'max-height:40vh;max-width:min(720px,44vw);overflow:auto;z-index:99995;' +
        'background:rgba(6,8,10,.90);color:#d8c49a;font:11px/1.35 Consolas,monospace;' +
        'padding:6px 8px;white-space:pre;border-top:2px solid #8d6a34;pointer-events:none';
      overlay.textContent = report();
      document.body.appendChild(overlay);
    } catch (e) { /* diagnostics must never break the game */ }
  }

  /* =========================================================================
     23.  HOOK
     NO priority argument.  nz-core.js:42-44 sorts listeners DESCENDING
     (b.p - a.p), so the negative priorities in STREET-MODULE-CONTRACT section 2
     would run the five street modules backwards.  Every module registers at the
     default p = 0 and relies on Array.prototype.sort being stable, which makes
     the firing order identical to the script-tag order:
       nz-render, nz-env, sky, ground, facade, ENTRANCE, props.
     That is what guarantees NZ.street.facades is already filled when this runs.
     ====================================================================== */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); }
    catch (err) { panic(err); }
  });

  /* the door, after nz-env has had its go at it.  See section 11. */
  NZ.on('ready', function () {
    if (dead || !installed || STATS.doorReskinned) return;
    try { reskinDoor(); }
    catch (err) { warn('door reskin failed: ' + (err && err.message)); }
    /* A module that cannot see the screen has to prove from inside the page
       that it ran and what it cost.  render-level.mjs:577 only surfaces a
       console line whose TEXT matches /error|fail|panic|threw|missing/, so the
       marker below is what makes a self-report visible in a shot log -- the
       same idiom nz-street.js:2560-2566 uses.

       THE ONE-LINER IS NOT DECORATION.  render-level.mjs:976 prints
       `issues.slice(0, OPT.diag ? 40 : 6)` and nz-street-ground.js plus
       nz-street.js already emit 39 lines between them BEFORE this module's hook
       fires -- so a 22-line report from here is truncated to nothing and the
       last round's `the foyer door mesh was not found` never reached a shot log
       at all.  One dense line, emitted FIRST, lands at index 39 and survives.
       Read the rest with NZ.streetEntrance.report() from a page evaluate, or
       on screen with ?nzdiag=1.  Dumping the whole 23-line report here took the
       shot log from 45 issue lines to 87 and pushed GROUND's and FACADE's
       reports out of the first 40 as well, which is a cost this module has no
       right to impose on its neighbours. */
    try {
      var head = 'ENT ok recess z[' + (E ? E.BACK.toFixed(1) : '?') + ',' +
        (E ? E.MOUTH.toFixed(1) : '?') + '] door z=' + DOORZ.toFixed(1) +
        ' cell(' + (E ? (E.XC / 4) | 0 : '?') + ',' +
        (((fin(DOORB.z0, 148) + 2) / 4) | 0) + ')=' +
        (STATS.doorReskinned ? 'reskinned' : 'MISSING') +
        ' floor=' + FLOOR_Y.toFixed(2) + ' rise=' + RISE.toFixed(2) +
        ' draws+' + STATS.addedCalls + ' tris' + STATS.tris +
        ' warn' + DIAG.warnings.length;
      console.warn('[nz-ent] threw:0 ' + head);
      for (var wj = 0; wj < DIAG.warnings.length; wj++)
        console.warn('[nz-ent] threw:0 ! ' + DIAG.warnings[wj]);
    } catch (e2) {}
  }, -900);

  NZ.log && NZ.log('street-entrance module loaded');
})(typeof window !== 'undefined' ? window : this);
