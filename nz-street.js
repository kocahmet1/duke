/* ===========================================================================
   NZ-STREET  --  the apartment blocks of 233. Sokak.

   Owns the photographed pair along the extended residential corridor:
   A-BLOK on the north face (x = 580..756, z = 140) and B-BLOK on the south
   face (x = 580..756, z = 208), plus the bridge-band return at the junction.

   TWO OF THEM ARE PORTRAITS, NOT TYPES.  The user attached zoomed photographs
   of the two blocks that face each other across the real 233. Sokak and asked
   for those buildings, so:
     - north: SEYDIKENT A-BLOK, the cream block of _ref/ref6 --
       HORIZONTAL LAP SIDING, not render, with vertical trim strips, brown
       gutters and downpipes, exact open/glazed loggia floors, three raised
       entrances and its red SEYDIKENT / -A- BLOK letters;
     - south: SEYDIKENT B-BLOK, the salmon block of _ref/ref7 -- smooth
       stucco, five surveyed recessed loggia stacks, paired white PVC sashes,
       three raised entrances and its red two-line name over the centre bay.
   Plus the hipped pantile roofs above c = 52 -- which close the two sky-strip
   holes over the junction throat and over the door -- their eaves, gutters,
   downpipes, water tanks, chimneys and aerials, the wall-mounted gas and
   electricity services, the block names, and the grime pass that ties it
   together.

   It does NOT own: the road, kerbs and pavement (nz-street-ground.js), the
   porch/steps/door inside the recess at x [240,244] y [0,11.2]
   (nz-street-entrance.js), or any car, tree, lamp, wall or wire
   (nz-street-props.js).  It publishes NZ.street.facades for all of them.

   No lights are added.  Every material goes through NZ.street.day() and every
   geometry through NZ.street.bake().  Zero external assets; classic script;
   three.js r149 core UMD surface only; no BufferGeometryUtils, no
   CapsuleGeometry.  1 unit = 0.2857 m (M = 3.5), so every dimension below is
   written as m(metres).
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.street === undefined) NZ.flags.street = false;

  var QS = /[?&]nzstreet=(0|off|low|med|high)/i.exec(
    global.location ? global.location.search : '') || null;
  if (QS && /^(0|off)$/i.test(QS[1])) {
    NZ.log && NZ.log('street disabled by query string');
    return;
  }

  var THREE = null, scene = null, renderer = null;
  var dead = false, installed = false;

  var OWN = { tex: [], mat: [], geo: [], obj: [], timer: 0 };
  var STATS = { sets: 0, texBytes: 0, blocks: 0, windows: 0, balconies: 0,
                heroGlassPanes: 0,
                props: 0, decals: 0, addedCalls: 0, tris: 0, verts: 0,
                clearanceClamps: 0, ms: 0, bakeMs: 0,
                /* WHERE THE 3 s GOES.  This module is the largest single cost at
                   boot and every agent's verification budget is spent waiting
                   for it, so the breakdown is reported rather than guessed at:
                   atlasMs = the sign + grime canvases, setMs = the seven tiling
                   texture sets, geoMs = emitting the piles, bakeMs = the sky
                   integrator.  now() is called four times in total. */
                atlasMs: 0, setMs: 0, geoMs: 0 };
  function nowMs() {
    return (global.performance && performance.now) ? performance.now() : Date.now();
  }
  var DIAG = { sets: [], piles: [], warnings: [] };
  function warn(msg) { DIAG.warnings.push(msg); console.warn('[nz-street] ' + msg); }

  /* ---- small math -------------------------------------------------------- */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  function ss(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  /* sRGB byte/hex -> linear.  Vertex colours in three are consumed LINEAR and
     are never decoded, so every palette entry below is converted once here.
     (material.color IS decoded; ours is always white.) */
  function s2l(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  var ALB = 1.00;                     /* global albedo trim.  Raised from 0.90:
                                         the grime pass this round -- 769 decals,
                                         a positional soil/algae field and much
                                         darker reveals, soffits and glass --
                                         took the measured facade down 22-32%,
                                         and CRITIC-STREET section 0 is explicit
                                         that the street's MEAN was already
                                         right and only its SPREAD was wrong.
                                         The trim goes back into the base so the
                                         grime buys variance, not exposure.
                                         STREET-MODULE-CONTRACT 5.4 wants a
                                         cream render at ~0.65 effective; the
                                         map bakes at 0.75 linear, so a cream
                                         tint of 0.76 lands at 0.57 before the
                                         grime takes its share. */
  function L(hex) {
    return [s2l((hex >> 16) & 255) * ALB, s2l((hex >> 8) & 255) * ALB, s2l(hex & 255) * ALB];
  }
  function mulc(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
  function mixc(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

  /* ---- scale ------------------------------------------------------------- */
  var U = 3.5;                        /* world units per metre (NUKEM.html:360) */
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
      GRAV: fin(tryGet(function () { return GRAV; }), 64),
      JUMPV: fin(tryGet(function () { return JUMPV; }), 17),
      cellAt: tryGet(function () { return cellAt; }) || null,
      isWallCell: tryGet(function () { return isWallCell; }) || null,
      regAt: tryGet(function () { return regAt; }) || null,
      inb: tryGet(function () { return inb; }) || null
    };
    if (!g.MW || !g.MH || !g.cellAt || !g.regAt || !g.inb) return null;
    return g;
  }

  /* the REAL apex-of-jump eye line -- nz-env's jumpTop(f) = f + 6.7 is 1.55
     units short and every overhead clearance in this file depends on it */
  function apex() { return (G.JUMPV * G.JUMPV) / (2 * G.GRAV); }   /* 2.258 */
  function camTop(f) { return f + G.EYE + apex(); }                /* f + 8.243 */
  function jumpTop(f) { return camTop(f) + 0.45; }                 /* f + 8.70  */
  var HUG = 0.98;
  function hug(d) {
    if (d > HUG) { STATS.clearanceClamps++; return HUG; }
    return d;
  }

  /* ---- the shared street namespace, degrading gracefully ------------------ */
  /* AMENDMENT 2 GEOMETRY.  The street was re-carved wider and longer: the
     facade planes moved OUT (north 156 -> 152, south 188 -> 192) and the west
     gable and dead end now span the full z 152..192.  Nothing below is an
     offset of the old numbers -- every plane, run, roof and occluder in this
     file is re-derived from these six boxes. */
  var ST = NZ.street || null;
  var PLANE = (ST && ST.PLANE) || { north: 140, south: 208, west: 548, east: 836 };
  var BOX = (ST && ST.BOX) || { x0: 548, x1: 836, z0: 140, z1: 208, y0: 0, y1: 52 };
  /* MOUTH is no longer a covered passage: it is the JUNCTION THROAT, the hole
     in the north plane through which the side street enters, open y 0..28 with
     the bridge band above it. */
  var MOUTH = (ST && ST.MOUTH) || { x0: 176, x1: 192, z0: 148, z1: 152, lintel: 28 };
  var BAND = (ST && ST.BAND) || { x0: 176, x1: 192, y0: 28, y1: 52, z: 152 };
  /* Residential doors on the two Seydikent blocks are dressed, non-gameplay
     entrances.  The fight entrance is a different building beyond the park,
     so this module deliberately carries no DOOR / keep-clear contract. */
  var DOORB = null;
  var STOREY = (ST && ST.STOREY) || { ground: 11.2, floor: 10.15, eaves: 51.8, count: 5 };
  var SKYC = (ST && ST.SKY) || { lum: 1.0 };

  function sday(mat, opts) {
    try {
      if (ST && ST.day) return ST.day(mat, opts);
    } catch (e) { warn('day() threw: ' + (e && e.message)); }
    if (mat && String(mat.name || '').indexOf('nzday:') !== 0)
      mat.name = 'nzday:' + ((opts && opts.name) || 'st');
    return mat;
  }
  function sbake(geo, opts) {
    try {
      if (ST && ST.bake) return ST.bake(geo, opts);
    } catch (e) { warn('bake() threw: ' + (e && e.message)); }
    /* fallback: a flat mid grey so nothing renders black if the sky is absent */
    try {
      var n = geo.attributes.position.count, c = new Float32Array(n * 3), i;
      for (i = 0; i < c.length; i++) c[i] = 0.62;
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      if (geo.attributes.uv && !geo.attributes.uv2) geo.setAttribute('uv2', geo.attributes.uv);
    } catch (e2) {}
    return geo;
  }

  /* ---- quality tier ------------------------------------------------------- */
  var TIER = 'high';
  var RES = { hi: 512, md: 256, wall: 512 };
  var DENSITY = 1.0, RAYS = 20, SIGNW = 1024;
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
    /* RES.wall is 512 at EVERY tier.  The sIva is the surface the player spends
       the whole 24 m walking past at arm's length; at 256 over a 3 m tile it is
       11.7 mm per texel and the float texture disappears into the mip chain,
       which is exactly the "flat colour at one metre" defect.  One extra
       512 set costs ~3 MB and buys the largest area in every frame. */
    if (TIER === 'low') { RES = { hi: 256, md: 128, wall: 512 }; DENSITY = 0.55; RAYS = 12; SIGNW = 768; }
    else if (TIER === 'med') { RES = { hi: 256, md: 256, wall: 512 }; DENSITY = 0.80; RAYS = 16; SIGNW = 768; }
    else { RES = { hi: 512, md: 256, wall: 512 }; DENSITY = 1.00; RAYS = 20; SIGNW = 1024; }
  }

  /* =========================================================================
     1.  NOISE + FIELD TOOLKIT
     Memoised lattice value-noise and worley, lifted in shape from
     nz-env.js:264-500 (the memoisation is why thirteen 512px sets bake in tens
     of milliseconds).  NZ.tex's own fbm/worley are not used: they are not
     memoised and the blur in NZ.tex.bake is O(n*r^2).
     ====================================================================== */
  var NOISE = Object.create(null), LATTICE = Object.create(null), AXIS = Object.create(null);

  function latticeOf(size, seed) {
    var k = size + ':' + seed;
    if (LATTICE[k]) return LATTICE[k];
    var rnd = NZ.tex.mulberry32(seed >>> 0), g = new Float32Array(size * size), i;
    for (i = 0; i < g.length; i++) g[i] = rnd();
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
    var rnd = NZ.tex.mulberry32(seed >>> 0);
    var pts = new Float32Array(cells * cells * 2), i;
    for (i = 0; i < cells * cells; i++) {
      var cx0 = i % cells, cy0 = (i - cx0) / cells;
      pts[i * 2] = (cx0 + rnd()) / cells;
      pts[i * 2 + 1] = (cy0 + rnd()) / cells;
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

  /* THE VARIANCE BUG.  An fbm sum-of-octaves does not fill [0,1]: five octaves
     at gain 0.5 land in roughly 0.5 +- 0.10, and a SMEARED field (fieldStreak
     blurs one) is narrower still, 0.5 +- 0.04.  Every albMul/albTint window in
     this file was written as if the field filled the unit interval -- so a
     "0.55 to 1.0" window on a smeared field selected almost no texels and a
     "0.15 to 0.85" window on an fbm used a seventh of its authored range.
     That is why CRITIC-STREET section 4 measured the render at sd 6.5 against a
     reference 15-30: the variation was authored and then thrown away.
     fnorm rescales mean +- k sigma onto [0,1], after which the windows mean
     what they say.  It returns a NEW array; the memoised original is left
     alone so other sets still get the raw field. */
  function fnorm(f, k) {
    var n = f.length, i, s = 0, s2 = 0;
    for (i = 0; i < n; i++) { s += f[i]; s2 += f[i] * f[i]; }
    var mu = s / n, sd = Math.sqrt(Math.max(1e-12, s2 / n - mu * mu));
    var lo = mu - (k || 2) * sd, span = 2 * (k || 2) * sd;
    var out = new Float32Array(n);
    for (i = 0; i < n; i++) out[i] = clamp((f[i] - lo) / span, 0, 1);
    return out;
  }

  /* separable box blur with wrap.  r MUST be an integer -- a fractional radius
     walks src[11.63], goes NaN, and the whole albedo bakes black. */
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
    var mm = fnew(res), id = fnew(res), rnd = NZ.tex.mulberry32(seed);
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
        mm[k] = d < joint ? clamp(d / joint, 0, 1) : 1;
        id[k] = rid[r * cols + cc];
      }
    }
    return { m: mm, id: id };
  }
  function fieldPlank(res, n, joint, seed, vertical) {
    return fieldBond(res, vertical ? 1 : n, vertical ? n : 1, joint, seed, false);
  }
  /* bilinear 2x upsample with wrap, index tables precomputed once per size so
     the inner loop has no modulo in it */
  var UPT = Object.create(null);
  function upTable(half) {
    var k = 'u' + half;
    if (UPT[k]) return UPT[k];
    var res = half * 2, i0 = new Int32Array(res), i1 = new Int32Array(res);
    var w = new Float32Array(res), x;
    for (x = 0; x < res; x++) {
      var f = (x - 0.5) * 0.5, fi = Math.floor(f);
      i0[x] = ((fi % half) + half) % half;
      i1[x] = (i0[x] + 1) % half;
      w[x] = f - fi;
    }
    return (UPT[k] = { i0: i0, i1: i1, w: w });
  }
  function upsample2(src, half) {
    var res = half * 2, T = upTable(half), out = new Float32Array(res * res);
    var i0 = T.i0, i1 = T.i1, w = T.w, x, y;
    for (y = 0; y < res; y++) {
      var ra = i0[y] * half, rb = i1[y] * half, ty = w[y], row = y * res;
      for (x = 0; x < res; x++) {
        var xa = i0[x], xb = i1[x], tx = w[x];
        var v0 = src[ra + xa], v1 = src[rb + xa];
        out[row + x] = (v0 + (src[ra + xb] - v0) * tx) +
                       ((v1 + (src[rb + xb] - v1) * tx) - (v0 + (src[ra + xb] - v0) * tx)) * ty;
      }
    }
    return out;
  }
  /* A SMEARED FIELD HAS NO DETAIL LEFT TO LOSE.  Every fieldStreak is an fbm
     blurred by res/smear -- 26 to 85 texels at 512 -- so by construction it is
     band-limited an order of magnitude below the grid it was being built on.
     Four of them feed the 512 px render set, which is the single largest slice
     of this module's install (texsets measured 1420 ms of a 3.0 s boot cost,
     and every other agent's verification budget is spent waiting for it).
     Building them at half resolution and bilinearly upsampling costs a quarter
     of the fbm and half of the blur; the set's own reported lum / sd / sat do
     not move, which is the check.  Below 512 it is not worth the upsample. */
  function fieldStreak(res, seed, freq, smear, vertical) {
    if (res >= 512) {
      var hr = res >> 1;
      var nh = fbmC(hr, { octaves: 4, frequency: freq, seed: seed });
      return upsample2(blurAxis(nh, hr, Math.max(1, Math.round(hr / smear)), !!vertical), hr);
    }
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
  /* per-unit colour spread keyed off a bond's id field */
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

  /* THE LIVE SCALE.  nz-env.js:607 hardcodes 0.6 and every millimetre figure
     in that file therefore ships at 47.6% of its stated value.  1 u = 0.2857 m. */
  var METRES_PER_UNIT = 1 / 3.5;

  function emitSet(res, alb, height, rough, metal, aoStrength, relief, name) {
    var q, bad = 0, sumR = 0, sumG = 0, sumB = 0, sumS = 0, sumL = 0, sumL2 = 0, np = 0, i;
    for (q = 0; q < alb.length; q += 3) {
      if (!(alb[q] >= 0) || !(alb[q + 1] >= 0) || !(alb[q + 2] >= 0)) {
        bad++; alb[q] = 128; alb[q + 1] = 126; alb[q + 2] = 120;
      }
      var rr = clamp(alb[q], 0, 255), gg = clamp(alb[q + 1], 0, 255), bb = clamp(alb[q + 2], 0, 255);
      sumR += rr; sumG += gg; sumB += bb;
      var mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
      sumS += mx > 0 ? (mx - mn) / mx : 0;
      /* the critic measures albedo VARIANCE off the framebuffer, so the set has
         to be able to report its own -- a texture whose sd is 3 can never make
         a wall whose sd is 15 no matter what the lighting does */
      var lv = rr * 0.299 + gg * 0.587 + bb * 0.114;
      sumL += lv; sumL2 += lv * lv;
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
    set.sd = Math.sqrt(Math.max(0, sumL2 / np - (sumL / np) * (sumL / np)));
    DIAG.sets.push({
      name: name, res: res, rgb: [Math.round(mR), Math.round(mG), Math.round(mB)],
      lum: +set.lum.toFixed(1), sat: +set.sat.toFixed(3), sd: +set.sd.toFixed(1),
      black: set.lum < 6,
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
    var t = nowMs();
    SETS[name] = b();
    STATS.setMs += nowMs() - t;
    return SETS[name];
  }

  /* =========================================================================
     3.  THE SEVEN SETS
     Tile sizes are metres * 3.5, per ENV-PLAYBOOK section 3.6.  The albedo of
     every architectural set is baked NEUTRAL and near-white; the building
     colour arrives as a LINEAR per-vertex tint, so one bake serves salmon,
     cream, butter, sage and ice blue at no extra draw call or texture.
     ====================================================================== */

  /* --- painted cement render (siva), the dominant surface ------------------
     CRITIC-STREET section 4: this measured sd 6.53 at one metre against a
     reference 14.8 - 30.0, and read as "cracked dried mud" at 0.5 m.  Both
     halves of that are the same mistake -- ALL of the variance was in a single
     narrow-band crack field cut deep into the height map, and none of it in the
     albedo.  The rebuild inverts that: the story is carried by five albedo
     fields at five different scales (float arcs, aggregate, patchy fade,
     vertical dirt wash, hairline crazing), the crazing is 3x shallower in
     relief and 2x wider and softer in albedo so it is legible at 2 - 5 m
     instead of violent at 0.5 m, and the tile stays at 3 m so the repeat sits
     outside the arm's-length field of view.  Macro variation (the metres-wide
     patches, the damp corners, the ground-line soil) is NOT here -- it is the
     positional vertex field in section 9, which cannot tile by construction. */
  var T_RENDER = m(3.0);              /* 10.5 */
  BUILD.render = function () {
    var res = RES.wall, i;
    var orange = fnorm(fbmC(res, { octaves: 4, frequency: 40, seed: 701 }), 2.0);
    var agg = fnorm(fbmC(res, { octaves: 3, frequency: 110, seed: 709 }), 2.0);
    var broad = fnorm(fbmC(res, { octaves: 4, frequency: 3, seed: 702 }), 1.8);
    var mid = fnorm(fbmC(res, { octaves: 3, frequency: 9, seed: 712 }), 1.9);
    var patch = worC(res, { cells: 5, seed: 703 });                     /* trowel bays */
    var scuff = worC(res, { cells: 16, seed: 704, invert: true });
    var crack = fbmC(res, { octaves: 5, frequency: 15, seed: 705, ridged: true });
    /* a rendered wall is floated in overlapping arcs; two smeared fields at
       right angles is the only thing that separates render from drywall at 3 m */
    var swH = fieldStreak(res, 706, 6, 7, false);
    var swV = fieldStreak(res, 707, 6, 7, true);
    var runoff = fnorm(fieldStreak(res, 708, 9, 20, true), 1.6);  /* dirt wash */
    var wash = fnorm(fieldStreak(res, 710, 4, 13, true), 1.6);
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [250, 246, 238]);
    for (i = 0; i < h.length; i++) {
      var sw = lerp(swH[i], swV[i], 0.18);
      /* the crazing groove: 0.36 of the height range was 2 mm of relief at a
         12 cm pitch, i.e. dried mud.  0.11 is a hairline. */
      var ck = clamp((crack[i] - 0.90) * 9, 0, 1);
      h[i] = clamp(0.50 + (orange[i] - 0.5) * 0.26 + (sw - 0.5) * 0.14 +
                   (agg[i] - 0.5) * 0.10 - ck * 0.11, 0, 1);
      rough[i] = clamp(0.82 + (patch[i] - 0.5) * 0.16 + (orange[i] - 0.5) * 0.08 +
                       (1 - wash[i]) * 0.10, 0.52, 1);
    }
    /* Paint on render is flat only in the sense that it has no pattern.  It is
       not flat in VALUE: twenty years of weather leaves a 12-18% swing across
       any square metre, and that swing is most of the reference's sd. */
    /* The windows below are centred on 1.0 on purpose.  CRITIC-STREET section 0
       is explicit that the street's MEAN luminance is already right and only
       its spread is wrong, so every field here has to add variance without
       moving the average -- lowering the mean would break the one thing that
       measured correct. */
    albMul(a, broad, 0.06, 0.94, 0.880, 1.100);        /* patchy fade, 1 m     */
    albMul(a, mid, 0.08, 0.92, 0.888, 1.098);          /* 35 cm mottle         */
    albMul(a, patch, 0.10, 0.90, 0.922, 1.058);        /* trowel bays, 60 cm   */
    albMul(a, orange, 0.15, 0.85, 0.952, 1.046);       /* float arcs, 7 cm     */
    albMul(a, agg, 0.20, 0.80, 0.962, 1.036);          /* aggregate, 3 cm      */
    albTint(a, runoff, [150, 146, 132], 0.40, 0.50, 1.0);  /* vertical dirt    */
    albTint(a, wash, [196, 192, 178], 0.30, 0.44, 1.0);
    albTint(a, crack, [150, 146, 140], 0.40, 0.86, 1.0);   /* wide, soft, grey */
    albTint(a, scuff, [254, 250, 242], 0.26, 0.66, 1.0);   /* chalked highs    */
    return emitSet(res, a, h, rough, null, 0.30, { mm: 0.42, tile: T_RENDER, hp: 130, rough: 0.14 }, 'render');
  };

  /* --- HORIZONTAL LAP SIDING, and why it gets its own 512 px set -----------
     _ref/ref6 is a zoom on SEYDIKENT A-BLOK and the first thing it says is
     that the block is NOT rendered: it is clad in vinyl lap siding at roughly
     a 200 mm exposure, and every horizontal line on that facade -- fifteen of
     them per storey, seventy-five over the building -- is a shadow.  Nothing
     in the render set can fake that: the laps are a periodic RELIEF with a
     hard shadow at each nose and a soft swell above it, and they have to stay
     legible from 30 m (where they are the building's whole texture) down to
     1 m (where the individual board must read).

     3.0 m tile / 15 laps = 200 mm exposure exactly.  At 512 px that is 34
     texels per board and 4-5 texels of shadow line, which survives two mips.
     The albedo carries the shadow as well as the normal map, because at the
     grazing angles the street is actually seen from the normal map contributes
     almost nothing and a purely geometric lap would vanish.                */
  var T_SIDING = m(3.0);              /* 10.5 */
  var SIDING_LAPS = 15;               /* 200 mm exposure */
  BUILD.siding = function () {
    var res = RES.wall, i, x, y;
    var N = SIDING_LAPS, rowH = res / N;
    var grain = fbmC(res, { octaves: 4, frequency: 46, seed: 781 });
    var bow = fnorm(fieldStreak(res, 782, 5, 14, false), 1.8);   /* board waviness */
    var dirt = fnorm(fieldStreak(res, 783, 8, 20, true), 1.6);   /* vertical wash  */
    var patch = fnorm(fbmC(res, { octaves: 4, frequency: 3, seed: 784 }), 1.8);
    var chalk = worC(res, { cells: 13, seed: 785, invert: true });
    var rnd = NZ.tex.mulberry32(7717);
    var tone = new Float32Array(N), i2;
    for (i2 = 0; i2 < N; i2++) tone[i2] = rnd();
    var h = fnew(res), rough = fnew(res), lapId = fnew(res);
    var face = fnew(res), nose = fnew(res);
    /* canvas row 0 is v = 1, i.e. the TOP of the tile in world Y, so t runs
       from the top of a board down to its nose.  The nose is where the board
       below laps under it and the shadow lives. */
    for (y = 0; y < res; y++) {
      var fy2 = y / rowH, ri = Math.floor(fy2) % N, t = fy2 - Math.floor(fy2);
      var prof = 0.24 + 0.60 * ss(clamp(t / 0.84, 0, 1));   /* the swell       */
      var sh = ss(clamp((t - 0.865) / 0.135, 0, 1));        /* the shadow line */
      var row = y * res;
      for (x = 0; x < res; x++) {
        i = row + x;
        lapId[i] = tone[ri];
        face[i] = 1 - sh;
        nose[i] = sh;
        h[i] = clamp(prof - sh * 0.74 + (grain[i] - 0.5) * 0.045 +
                     (bow[i] - 0.5) * 0.085, 0, 1);
        rough[i] = clamp(0.56 + (grain[i] - 0.5) * 0.10 + dirt[i] * 0.16 +
                         sh * 0.14, 0.26, 1);
      }
    }
    var a = albNew(res, [239, 235, 226]);
    /* board-to-board value steps.  Vinyl fades per panel, not per wall, and
       this is what stops fifteen identical stripes reading as wallpaper. */
    albUnits(a, lapId, face, [[246, 243, 234], [233, 229, 219], [241, 237, 228],
                              [228, 224, 213], [237, 233, 224], [231, 228, 219]], 0.52);
    albTint(a, nose, [136, 132, 122], 0.86, 0.18, 1.0);      /* the shadow      */
    albTint(a, patch, [214, 210, 199], 0.34, 0.46, 1.0);     /* metre-scale fade */
    albTint(a, dirt, [178, 175, 163], 0.30, 0.52, 1.0);      /* vertical wash    */
    albTint(a, chalk, [250, 248, 242], 0.22, 0.72, 1.0);     /* chalked highs    */
    albMul(a, bow, 0.10, 0.90, 0.955, 1.040);
    /* 2.4 mm rms: a 10 mm lap step averaged over the whole tile.  Anything
       larger and emitSet's own guard calls it a rock face, correctly. */
    return emitSet(res, a, h, rough, null, 0.62,
                   { mm: 2.4, tile: T_SIDING, hp: 0, rough: 0.16 }, 'siding');
  };

  /* --- travertine cladding, the commonest plinth --------------------------- */
  var T_TRAV = m(2.4);                /* 8.4 */
  BUILD.travertine = function () {
    var res = RES.hi, i;
    var bond = fieldBond(res, 8, 4, Math.max(2, res / 140), 711, false);  /* stack bond */
    var grain = fbmC(res, { octaves: 5, frequency: 14, seed: 722 });
    var fig = fnorm(fbmC(res, { octaves: 4, frequency: 6, seed: 716 }), 1.8);
    var bed = fnorm(fieldStreak(res, 713, 9, 11, false), 1.7);
    var wear = worC(res, { cells: 14, seed: 714 });
    var soil = fnorm(fieldStreak(res, 717, 5, 18, true), 1.6);
    /* the whole identity of travertine: lens-shaped horizontal vugs */
    var vug = blurAxis(worC(res, { cells: 30, seed: 715, invert: true }), res, Math.max(1, res / 10), false);
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [204, 193, 172]);
    for (i = 0; i < h.length; i++) {
      var vv = clamp((vug[i] - 0.70) * 5, 0, 1);
      h[i] = clamp(0.30 + bond.m[i] * 0.44 + (grain[i] - 0.5) * 0.12 +
                   (bed[i] - 0.5) * 0.16 - vv * 0.22, 0, 1);
      rough[i] = clamp(0.52 + (grain[i] - 0.5) * 0.16 + vv * 0.30 + (1 - bond.m[i]) * 0.28, 0.12, 1);
    }
    /* CRITIC-STREET section 13: "one flat beige, sd 11.0, no veining, no
       tile-to-tile colour variation, no dirt in the joint".  A travertine run
       in ref1 steps a good 15% in value from tile to tile and every joint is
       a dark line with grime in it. */
    albUnits(a, bond.id, bond.m,
      [[220, 209, 187], [196, 185, 166], [211, 199, 178], [182, 172, 155],
       [206, 196, 177], [190, 179, 160]], 0.92);
    albTint(a, fig, [166, 156, 138], 0.30, 0.42, 0.94);      /* the figure     */
    albTint(a, vug, [160, 150, 132], 0.52, 0.70, 0.96);
    albTint(a, bed, [196, 185, 166], 0.24, 0.52, 1.0);
    albMul(a, bond.m, 0, 1, 0.58, 1.0);                      /* the joint      */
    albTint(a, bond.m, [126, 120, 108], 0.55, 0.30, 0.0);    /* grime in it    */
    albTint(a, wear, [186, 178, 164], 0.18, 0.60, 1.0);
    albTint(a, soil, [162, 156, 140], 0.22, 0.56, 1.0);
    return emitSet(res, a, h, rough, null, 0.80, { mm: 1.2, tile: T_TRAV, hp: 260, rough: 0.12 }, 'travertine');
  };

  /* --- wire-cut tan brick cladding, 75 mm coursing ------------------------- */
  var T_BRICK = m(2.4);               /* 8.4, 32 courses = 75 mm */
  BUILD.brick = function () {
    var res = RES.hi, i;
    var bond = fieldBond(res, 32, 10, Math.max(2, res / 200), 721, true);
    var grain = fbmC(res, { octaves: 5, frequency: 26, seed: 722 });
    var drag = fieldStreak(res, 723, 30, 8, false);      /* the wire-cut drag   */
    var eff = worC(res, { cells: 9, seed: 724, invert: true });
    var soot = fieldStreak(res, 725, 6, 22, true);
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [178, 142, 106]);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.24 + bond.m[i] * 0.56 + (grain[i] - 0.5) * 0.14 + (drag[i] - 0.5) * 0.18, 0, 1);
      rough[i] = clamp(0.76 + (grain[i] - 0.5) * 0.14 + (1 - bond.m[i]) * 0.16, 0.35, 1);
    }
    albUnits(a, bond.id, bond.m,
      [[186, 150, 112], [174, 138, 102], [192, 158, 120], [166, 132, 98], [180, 146, 110], [170, 140, 108]], 0.85);
    albTint(a, drag, [162, 130, 98], 0.14, 0.58, 1.0);
    albMul(a, bond.m, 0, 1, 0.90, 1.0);
    albTint(a, bond.m, [172, 166, 154], 0.85, 0.50, 0.0);     /* mortar          */
    albTint(a, eff, [204, 200, 192], 0.16, 0.74, 1.0);        /* efflorescence   */
    albTint(a, soot, [134, 124, 110], 0.12, 0.64, 1.0);
    return emitSet(res, a, h, rough, null, 0.72, { mm: 2.0, tile: T_BRICK, hp: 200, rough: 0.12 }, 'brick');
  };

  /* --- red-brown concrete pantile -----------------------------------------
     CRITIC-STREET section 9: the tiles rendered at lum 183 against ref5's 118,
     roof / sky 0.84 where the reference is 0.50.  A 25-30 degree pitch under an
     overcast sky sees close to the full hemisphere, so the bake hands it ~1.0
     and there is nothing to hold it down but the albedo -- which is the
     contract's own rule (section 5.4: "if your surface comes out hot, lower the
     albedo, not the light").  Faded concrete pantile is a DARK surface against
     an overcast sky; this base is roughly half the old one, plus twice the
     tile-to-tile spread and real lichen. */
  var T_ROOF = m(2.4);                /* 8.4 */
  BUILD.rooftile = function () {
    var res = RES.md, i, x, y;
    var rollN = 8;
    var roll = fnew(res);
    for (y = 0; y < res; y++) for (x = 0; x < res; x++)
      roll[y * res + x] = 0.5 + 0.5 * Math.cos(x / res * TAU * rollN);
    var lap = fieldPlank(res, 8, Math.max(2, res / 60), 731, false);
    var grain = fbmC(res, { octaves: 4, frequency: 30, seed: 732 });
    var lich = fnorm(fieldStreak(res, 733, 6, 12, true), 1.7);
    var moss = worC(res, { cells: 7, seed: 734, invert: true });
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [92, 55, 43]);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.30 + roll[i] * 0.52 + lap.m[i] * 0.14 + (grain[i] - 0.5) * 0.08, 0, 1);
      rough[i] = clamp(0.90 + (grain[i] - 0.5) * 0.10, 0.62, 1);
    }
    albUnits(a, lap.id, lap.m,
      [[102, 60, 46], [80, 48, 38], [68, 42, 34], [112, 68, 50], [88, 54, 42], [96, 66, 54]], 0.92);
    albTint(a, lich, [96, 98, 80], 0.42, 0.58, 1.0);          /* algae + lichen  */
    albTint(a, moss, [118, 116, 100], 0.34, 0.72, 1.0);       /* lichen crusts   */
    albMul(a, roll, 0, 1, 0.72, 1.12);
    return emitSet(res, a, h, rough, null, 1.15, { mm: 6.0, tile: T_ROOF, hp: 0, rough: 0.12 }, 'rooftile');
  };

  /* --- white PVC joinery --------------------------------------------------- */
  var T_PVC = m(1.0);                 /* 3.5 */
  BUILD.pvc = function () {
    var res = RES.md, i;
    var peel = fbmC(res, { octaves: 4, frequency: 34, seed: 741 });
    var broad = fbmC(res, { octaves: 3, frequency: 5, seed: 742 });
    var chip = worC(res, { cells: 22, seed: 743, invert: true });
    var dirt = fieldStreak(res, 744, 5, 16, true);
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [234, 233, 228]);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.5 + (peel[i] - 0.5) * 0.30 + (broad[i] - 0.5) * 0.16 -
                   clamp((chip[i] - 0.80) * 5, 0, 1) * 0.10, 0, 1);
      rough[i] = clamp(0.44 + (peel[i] - 0.5) * 0.14 + dirt[i] * 0.16, 0.16, 1);
    }
    albMul(a, broad, 0.2, 0.8, 0.95, 1.02);
    albTint(a, dirt, [196, 192, 180], 0.34, 0.58, 1.0);       /* dirt in the corners */
    albTint(a, chip, [214, 210, 200], 0.18, 0.78, 1.0);
    return emitSet(res, a, h, rough, null, 0.8, { mm: 0.15, tile: T_PVC, hp: 90, rough: 0.16 }, 'pvc');
  };

  /* --- painted / galvanised steel: railings, gutters, meters, grilles ------ */
  var T_STEEL = m(0.4);               /* 1.4 */
  BUILD.steel = function () {
    var res = RES.md, i;
    var plate = fieldBond(res, 2, 2, Math.max(2, res / 90), 751, false);
    var edge = worC(res, { cells: 9, seed: 752, invert: true });
    var grain = fbmC(res, { octaves: 4, frequency: 20, seed: 753 });
    var rust = fbmC(res, { octaves: 4, frequency: 7, seed: 754 });
    var scr = fbmC(res, { octaves: 3, frequency: 40, seed: 755, ridged: true });
    var bleed = fieldStreak(res, 756, 6, 20, true);
    var h = fnew(res), rough = fnew(res), metal = fnew(res);
    var a = albNew(res, [206, 208, 206]);
    for (i = 0; i < h.length; i++) {
      var rz = clamp((rust[i] - 0.60) * 3.2, 0, 1);
      h[i] = clamp(0.5 + (grain[i] - 0.5) * 0.22 + (plate.m[i] - 0.5) * 0.20 +
                   rz * 0.14 - clamp((scr[i] - 0.86) * 8, 0, 1) * 0.16, 0, 1);
      rough[i] = clamp(0.40 + rz * 0.44 + (grain[i] - 0.5) * 0.10, 0.14, 1);
      metal[i] = clamp(0.06 + rz * 0.14 + clamp((edge[i] - 0.80) * 4, 0, 1) * 0.80, 0, 1);
    }
    albTint(a, rust, [132, 74, 42], 0.90, 0.60, 0.92);
    albTint(a, bleed, [150, 96, 62], 0.24, 0.62, 1.0);
    albTint(a, edge, [186, 188, 190], 0.60, 0.80, 1.0);
    albMul(a, plate.m, 0, 1, 0.80, 1.0);
    return emitSet(res, a, h, rough, metal, 0.9, { mm: 0.35, tile: T_STEEL, hp: 90, rough: 0.14 }, 'steel');
  };

  /* --- dark glazing.  OPAQUE: transparent panes sort against the decals and
         the foliage and lose.  A dark pane with a hot envMap reads as glass.
     CRITIC-STREET section 11 measured glass / frame = 1.00 against ref4's 0.79.
     Two causes and both are fixed here: the base was a mid grey-blue at lum
     165, and the material carried envMapIntensity 1.7 at roughness 0.1, i.e. a
     near-mirror of a 219-code sky laid over it.  Under overcast, window glass is
     one of the DARKEST things on a facade -- it is a hole into an unlit room
     with a weak sky sheen on it, not a mirror. -------------------------------- */
  var T_GLASS = m(1.6);               /* 5.6 */
  BUILD.glass = function () {
    var res = RES.md, i;
    var dirt = fbmC(res, { octaves: 4, frequency: 10, seed: 761 });
    var rain = fieldStreak(res, 762, 8, 24, true);
    var haze = fieldStreak(res, 763, 4, 10, false);
    var room = fbmC(res, { octaves: 3, frequency: 4, seed: 764 });
    var h = fnew(res), rough = fnew(res);
    var a = albNew(res, [140, 148, 158]);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.5 + (dirt[i] - 0.5) * 0.10, 0, 1);
      rough[i] = clamp(0.22 + rain[i] * 0.22 + (dirt[i] - 0.5) * 0.10, 0.12, 0.7);
    }
    /* the top of a pane catches the sky, the bottom is the room */
    albTint(a, room, [54, 60, 68], 0.55, 0.52, 0.06);
    albTint(a, rain, [132, 138, 144], 0.28, 0.58, 1.0);
    albTint(a, haze, [92, 98, 106], 0.24, 0.60, 1.0);
    albMul(a, dirt, 0.2, 0.8, 0.86, 1.14);
    return emitSet(res, a, h, rough, null, 0.5, { mm: 0.10, tile: T_GLASS, hp: 200, rough: 0.05 }, 'glass');
  };

  /* =========================================================================
     4.  MATERIALS
     One per pile.  No onBeforeCompile of our own: every colour story on this
     street is carried by the baked albedo, the per-vertex LINEAR tint and the
     decal pass, so there is nothing to inject.  Leaving onBeforeCompile unset
     means the material inherits THREE.Material.prototype.onBeforeCompile,
     which IS nz-render's AO/contact-shadow/PCSS patch -- and NZ.street.day()
     then chains its daylight block on top of that.
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
      alphaTest: o.alphaTest || 0,
      depthWrite: o.depthWrite === undefined ? true : o.depthWrite,
      polygonOffset: !!o.poly,
      polygonOffsetFactor: o.poly ? -4 : 0,
      polygonOffsetUnits: o.poly ? -8 : 0
    });
    mt.normalScale = new THREE.Vector2(nsc, nsc);
    mt.aoMapIntensity = o.ao === undefined ? 0.9 : o.ao;
    sday(mt, { name: 'st-' + key, intensity: o.env === undefined ? 1.0 : o.env, spec: o.spec });
    OWN.mat.push(mt);
    MATS[key] = mt;
    return mt;
  }

  /* =========================================================================
     5.  GEOMETRY TOOLKIT -- Pile / poly / box / tube / sweep
     Pile is the hand-written merge (there is no BufferGeometryUtils in r149).
     It differs from nz-env's in one way that matters: it does NOT bake the
     game's night point lights into `color`.  It records a LINEAR tint per
     vertex instead, and after NZ.street.bake() has written the overcast
     sky-visibility term into `color`, makeMesh multiplies the two.  That is
     what lets one draw call carry salmon, cream, sage, yellow gas pipe and
     white PVC at once.
     ====================================================================== */
  function Pile() {
    this.p = []; this.nm = []; this.uv = []; this.t = []; this.idx = []; this.n = 0;
    this.ctxTile = 1 / 10.5;
    this.ctxTint = [1, 1, 1];
    this.grad = null;                 /* {y0,y1,k} ground-line soiling ramp */
    this.fieldFn = null;              /* world-space grime multiplier       */
  }
  Pile.prototype.tile = function (u) { this.ctxTile = 1 / (u || 4); return this; };
  Pile.prototype.tint = function (c) { this.ctxTint = c || [1, 1, 1]; return this; };
  Pile.prototype.ramp = function (y0, y1, k) {
    this.grad = (k === undefined || k >= 1) ? null : { y0: y0, y1: y1, k: k };
    return this;
  };
  /* A per-VERTEX multiplier evaluated in world space.  This is where the
     macro half of STREET-BRIEF section 8 lives -- patchy fade, algal
     green-black, ground-line soiling, render repairs.  It has to be positional
     rather than in the tiling set, because a 3 m tile that carries metres-wide
     blotches repeats them every 3 m and that is the one thing the brief calls
     out by name ("no visibly tiling texture").  Being per-vertex it also
     interpolates, so a 1.1 m cell grid reads as a smooth wash rather than as
     the checkerboard a per-quad tint would give. */
  Pile.prototype.field = function (fn) { this.fieldFn = fn || null; return this; };
  Pile.prototype.empty = function () { return this.n === 0; };
  Pile.prototype.vert = function (x, y, z, nx, ny, nz, u, v, r, g, b) {
    if (this.fieldFn) {
      var f = this.fieldFn(x, y, z, ny);
      r *= f[0]; g *= f[1]; b *= f[2];
    }
    if (this.grad) {
      var t = clamp((y - this.grad.y0) / ((this.grad.y1 - this.grad.y0) || 1), 0, 1);
      var kk = lerp(this.grad.k, 1, ss(t));
      r *= kk; g *= kk; b *= kk;
    }
    this.p.push(x, y, z); this.nm.push(nx, ny, nz); this.uv.push(u, v);
    this.t.push(r, g, b);
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
    g.setAttribute('uv2', uv);
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) g.boundingSphere = null;
    this.tintArr = new Float32Array(this.t);
    OWN.geo.push(g);
    return g;
  };

  /* the only vertex emitter.  (rx,ry,rz) is any point demonstrably INSIDE the
     solid; it is what makes 26 facets of a chamfered box face outward without
     tracking winding by hand. */
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

  /* plain 6-face box: 24 verts / 12 tris, for the hundred small joinery
     members where the chamfer would be sub-pixel anyway */
  function box6(pile, x0, x1, y0, y1, z0, z1, ao) {
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], cx, cy, cz, ao);
    poly(pile, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], cx, cy, cz, ao);
    poly(pile, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], cx, cy, cz, ao);
  }

  /* chamfered box: 96 verts / 44 tris.  A pure 90 degree arris is the number
     one tell of a prototype, so every element with a real silhouette gets one. */
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

  /* explicit-UV quad, for the sign atlas and the grime atlas.  v = u x n (not
     n x u): on a wall facing -Z with u = +X that gives +Y, so lettering lands
     the right way up instead of mirrored. */
  function atlasQuad(pile, cx, cy, cz, nx, ny, nz, ux, uy, uz, hw, hh, rect, tintScale) {
    var vx = uy * nz - uz * ny, vy = uz * nx - ux * nz, vz = ux * ny - uy * nx;
    /* on a wall the atlas tile must stand up: force v toward +Y, or half the
       facade gets its lettering and its run-off stains upside down */
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

  /* sweep a moulding cross-section along a run.  [out, up] pairs measured from
     the wall face outward; every profile closes back to out = 0 so the end
     caps are automatic.  A string course this way is 26 verts, not the 96 a
     chamfered box costs. */
  function sweepProfile(pile, F, s0, s1, baseY, prof, dBase, ao) {
    var i;
    if (s1 - s0 <= 0.05 || prof.length < 2) return;
    function pt(s, p) { return PT(F, s, dBase + p[0], baseY + p[1]); }
    var mid = (prof[0][1] + prof[prof.length - 1][1]) * 0.5;
    var R = PT(F, (s0 + s1) * 0.5, dBase - 0.6, baseY + mid);
    for (i = 0; i < prof.length - 1; i++)
      poly(pile, [pt(s0, prof[i]), pt(s1, prof[i]), pt(s1, prof[i + 1]), pt(s0, prof[i + 1])],
           R[0], R[1], R[2], ao === undefined ? 1 : ao);
    var capA = [], capB = [];
    for (i = 0; i < prof.length; i++) { capA.push(pt(s0, prof[i])); capB.push(pt(s1, prof[i])); }
    poly(pile, capA, R[0], R[1], R[2], 0.86);
    poly(pile, capB, R[0], R[1], R[2], 0.86);
  }

  var PROF = {
    sill:    [[0, 0], [0.30, 0.06], [0.30, 0.30], [0.10, 0.44], [0, 0.44]],
    band:    [[0, 0], [0.30, 0.10], [0.30, 0.62], [0.16, 0.80], [0, 0.80]],
    plinth:  [[0, 0], [0.30, 0.00], [0.30, 0.34], [0.10, 0.52], [0, 0.52]],
    cope:    [[0, 0], [0.26, 0.10], [0.26, 0.40], [0, 0.52]],
    fascia:  [[0, 0], [0.00, 1.30], [0.44, 1.30], [0.44, 0.16], [0.22, 0.00]]
  };

  /* run-space -> world.  Every run is axis-aligned, so a run-space box is a
     world AABB and boxC can be used directly. */
  function PT(F, s, d, y) {
    return [F.px + F.tx * s + F.nx * d, y, F.pz + F.tz * s + F.nz * d];
  }
  function rbox(pile, F, s0, s1, y0, y1, d0, d1, k, ao) {
    var A = PT(F, s0, d0, 0), B = PT(F, s1, d1, 0);
    var x0 = Math.min(A[0], B[0]), x1 = Math.max(A[0], B[0]);
    var z0 = Math.min(A[2], B[2]), z1 = Math.max(A[2], B[2]);
    if (x1 - x0 < 1e-4) { x0 -= 5e-4; x1 += 5e-4; }
    if (z1 - z0 < 1e-4) { z0 -= 5e-4; z1 += 5e-4; }
    if (y1 - y0 < 1e-4) { y0 -= 5e-4; y1 += 5e-4; }
    if (k > 0) boxC(pile, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
                    (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, k, ao);
    else box6(pile, x0, x1, y0, y1, z0, z1, ao);
  }
  function rbounds(F, s0, s1, y0, y1, d0, d1) {
    var A = PT(F, s0, d0, 0), B = PT(F, s1, d1, 0);
    return { x0: Math.min(A[0], B[0]), x1: Math.max(A[0], B[0]),
             y0: y0, y1: y1,
             z0: Math.min(A[2], B[2]), z1: Math.max(A[2], B[2]) };
  }
  /* a flat panel on the run at depth d, facing into the canyon */
  function rquad(pile, F, s0, s1, y0, y1, d, ao) {
    var R = PT(F, (s0 + s1) * 0.5, d - 1.0, (y0 + y1) * 0.5);
    poly(pile, [PT(F, s0, d, y0), PT(F, s1, d, y0), PT(F, s1, d, y1), PT(F, s0, d, y1)],
         R[0], R[1], R[2], ao === undefined ? 1 : ao);
  }
  /* Emit one hero-building pane into the intact fallback mesh and remember
     its run-space basis.  `source` is PILES.glass: callers continue choosing
     their surveyed tint exactly as before, and this helper copies that tint to
     the hero pile.  opts.room joins the small panes of one sash/loggia so the
     destruction module can reveal one coherent furnished flat behind them. */
  function heroPane(source, F, s0, s1, y0, y1, d, ao, opts) {
    opts = opts || {};
    if (!PILES || !PILES.heroGlass) {
      rquad(source, F, s0, s1, y0, y1, d, ao);
      return null;
    }
    var tint = source && source.ctxTint ? source.ctxTint.slice() : WHITE.slice();
    var v0 = PILES.heroGlass.n;
    PILES.heroGlass.tile(T_GLASS).tint(tint);
    rquad(PILES.heroGlass, F, s0, s1, y0, y1, d, ao);
    var c = PT(F, (s0 + s1) * 0.5, d, (y0 + y1) * 0.5);
    var rec = {
      id: 'hero-pane-' + HERO_PANES.length,
      building: F.id || F.kind || 'hero',
      center: [c[0], c[1], c[2]],
      tangent: [F.tx, 0, F.tz],
      normal: [F.nx, 0, F.nz],
      width: Math.max(0.02, s1 - s0),
      height: Math.max(0.02, y1 - y0),
      tint: tint,
      vertexStart: v0,
      vertexCount: PILES.heroGlass.n - v0,
      seed: isFinite(opts.seed) ? opts.seed : (F.seed * 97 + HERO_PANES.length * 13),
      room: opts.room || ((F.id || 'hero') + ':pane:' + HERO_PANES.length),
      roomKind: opts.kind || 'flat',
      floorY: isFinite(opts.floorY) ? opts.floorY : Math.max(0.5, y0 - Math.min(m(0.92), (y1 - y0) * 0.62)),
      roomDepth: isFinite(opts.depth) ? opts.depth : m(1.65)
    };
    HERO_PANES.push(rec);
    STATS.heroGlassPanes = HERO_PANES.length;
    return rec;
  }
  /* a horizontal panel (soffit or slab top) between two depths */
  function rdeck(pile, F, s0, s1, d0, d1, y, up, ao) {
    var R = PT(F, (s0 + s1) * 0.5, (d0 + d1) * 0.5, y + (up ? -1.0 : 1.0));
    poly(pile, [PT(F, s0, d0, y), PT(F, s1, d0, y), PT(F, s1, d1, y), PT(F, s0, d1, y)],
         R[0], R[1], R[2], ao === undefined ? 1 : ao);
  }
  /* a return cheek: a vertical panel perpendicular to the run */
  /* dir = +1 the face looks toward increasing s, -1 toward decreasing s.  The
     reference point therefore sits on the OTHER side, inside the solid. */
  function rcheek(pile, F, s, y0, y1, d0, d1, dir, ao) {
    var R = PT(F, s - dir * 1.0, (d0 + d1) * 0.5, (y0 + y1) * 0.5);
    poly(pile, [PT(F, s, d0, y0), PT(F, s, d1, y0), PT(F, s, d1, y1), PT(F, s, d0, y1)],
         R[0], R[1], R[2], ao === undefined ? 1 : ao);
  }

  /* a wall panel with rectangular openings punched in it.  Builds the s/y
     edge lattice from the holes and emits every cell that is not inside one --
     the cheapest correct "facade with windows" primitive there is, and each
     cell can take its own tint, which is where the patchy fading comes from. */
  function punched(pile, F, d, s0, s1, y0, y1, holes, ao, tintFn, step) {
    var sc = [s0, s1], yc = [y0, y1], i;
    for (i = 0; i < holes.length; i++) {
      var hl = holes[i];
      if (hl.s0 > s0 && hl.s0 < s1) sc.push(hl.s0);
      if (hl.s1 > s0 && hl.s1 < s1) sc.push(hl.s1);
      if (hl.y0 > y0 && hl.y0 < y1) yc.push(hl.y0);
      if (hl.y1 > y0 && hl.y1 < y1) yc.push(hl.y1);
    }
    /* Optional subdivision.  A storey of wall with two windows in it is three
       quads, and three quads cannot carry a metre-scale wash however good the
       field behind it is.  `step` (world units) cuts it to a lattice whose
       vertices sample grimeField, and it is what turns the flat colour the
       critic measured into a gradient.  It also gives NZ.street.bake() enough
       sample points to put a real contact line under a soffit. */
    if (step > 0) {
      var ns = Math.min(24, Math.max(1, Math.round((s1 - s0) / step)));
      for (i = 1; i < ns; i++) sc.push(s0 + (s1 - s0) * i / ns);
      var ny = Math.min(24, Math.max(1, Math.round((y1 - y0) / step)));
      for (i = 1; i < ny; i++) yc.push(y0 + (y1 - y0) * i / ny);
    }
    sc.sort(function (a, b) { return a - b; });
    yc.sort(function (a, b) { return a - b; });
    var base = pile.ctxTint;
    for (i = 0; i < sc.length - 1; i++) {
      if (sc[i + 1] - sc[i] < 1e-3) continue;
      for (var j = 0; j < yc.length - 1; j++) {
        if (yc[j + 1] - yc[j] < 1e-3) continue;
        var mS = (sc[i] + sc[i + 1]) * 0.5, mY = (yc[j] + yc[j + 1]) * 0.5, inside = false;
        for (var k = 0; k < holes.length; k++) {
          var q = holes[k];
          if (mS > q.s0 && mS < q.s1 && mY > q.y0 && mY < q.y1) { inside = true; break; }
        }
        if (inside) continue;
        if (tintFn) pile.tint(tintFn(mS, mY, base));
        rquad(pile, F, sc[i], sc[i + 1], yc[j], yc[j + 1], d, ao);
      }
    }
    pile.tint(base);
  }

  /* =========================================================================
     6.  THE SIGN ATLAS -- crisp painted capitals on a real fascia band
     ENV-PLAYBOOK 8.5: an OPAQUE atlas at ~4x the density of the decal atlas,
     mapped onto a band that is real geometry.  No alpha edge to dissolve in
     the mip chain, no sorting, depth writes normally, and the band is part of
     the building rather than a sticker on it.
     1024 x 1024, eight 1024 x 128 rows.  A 16-unit band is 64 texels per unit
     = 224 per metre, so a 90 mm stroke is still 20 texels at arm's length.

     Turkish characters are composed rather than trusted to the font: the base
     ASCII letter is drawn with fillText and the diacritic is drawn as
     geometry, so I S G U O C never come back as tofu on a headless box with
     three fonts installed.
     ====================================================================== */
  var SIGN = { tex: null, mat: null, rect: [], names: [], aspect: [], capFrac: [] };
  var TR_MAP = {
    'İ': ['I', 'dot'], 'Ş': ['S', 'ced'], 'Ğ': ['G', 'breve'],
    'Ü': ['U', 'diaer'], 'Ö': ['O', 'diaer'], 'Ç': ['C', 'ced'],
    'ı': ['I', null]
  };
  function canvasWH(w, h) {
    var c = (global.document && document.createElement) ? document.createElement('canvas') : null;
    if (!c) return null;
    c.width = w; c.height = h;
    return c;
  }
  /* THE DIACRITIC BUG.  This routine was handed `top = baseline - fontSize`,
     i.e. the top of the EM BOX, and then placed the marks a further 0.25 - 0.42
     of the font size above that.  A 900-weight grotesque has a cap height of
     about 0.72 em, so the umlaut on O and U landed roughly half a cap height
     clear of the letter it belongs to -- floating in the blank top quarter of
     the band, where the chalking pass then ate what was left of it.  The result
     was OZGURKENT rather than OZGURKENT with its dots.  The cedillas survived
     only because they hang BELOW the baseline, which is measured correctly.
     `capH` is now the real cap height (measured where the platform supports
     TextMetrics.actualBoundingBoxAscent, estimated where it does not), `top` is
     the top of the glyph, and every mark is sized and placed off that.
     nz-street-entrance.js copied this routine and has the same bug. */
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
  /* TWELVE ROWS, AND EVERY ROW CROPPED TO ITS OWN INK.
     The eight-row atlas forced every band to the row's 8:1 aspect, which meant
     a sixteen-character name and a six-character one were drawn at the same
     BAND width and therefore at wildly different letter sizes -- and roughly
     40 % of every band was empty background that the caller still had to pay
     for in world width.  Each row now records where its ink actually starts and
     stops (SIGN.rect is cropped to it) plus the cap height as a fraction of the
     cropped tile (SIGN.capFrac) and the tile's aspect (SIGN.aspect).  signSize()
     then sizes a band from a target CAP HEIGHT IN METRES, so every painted name
     on the street has the same 275 mm letters however long the name is, which
     is what the reference actually shows and what makes them read at 30 units
     instead of at 2. */
  function buildSignAtlas(names) {
    var W = SIGNW, ROWS = 12, ROW = W / ROWS;
    var c = canvasWH(W, W);
    if (!c) { warn('no document: sign atlas skipped'); return; }
    var g = c.getContext('2d', { willReadFrequently: true });
    var rnd = NZ.tex.mulberry32(9174);
    var res = 128;
    var grain = fbmC(res, { octaves: 5, frequency: 20, seed: 771 });
    var i, r;
    g.fillStyle = '#cfc6b2'; g.fillRect(0, 0, W, W);

    for (r = 0; r < ROWS; r++) {
      var y0 = r * ROW;
      var spec = names[r] || { text: '', bg: '#cfc6b2', ink: '#8e2b22' };
      g.fillStyle = spec.bg; g.fillRect(0, y0, W, ROW);

      var text = spec.text || '';
      var capH = ROW * 0.62 * 0.716, inkX0 = 3.5, inkX1 = W - 3.5;
      if (text) {
        var em = Math.round(ROW * 0.62);
        var track = spec.track === undefined ? 0.11 : spec.track;
        g.font = '900 ' + em + 'px "Arial Narrow","Helvetica Neue",Arial,"DejaVu Sans",sans-serif';
        g.textBaseline = 'alphabetic';
        /* the REAL cap height, so the marks can be placed off the letter rather
           than off the em box.  Headless Chrome has actualBoundingBoxAscent;
           0.716 is the fallback for anything that does not. */
        var capH = em * 0.716;
        try {
          var mm2 = g.measureText('H');
          if (mm2 && mm2.actualBoundingBoxAscent > 0) capH = mm2.actualBoundingBoxAscent;
        } catch (eM) {}
        /* decompose Turkish letters into base + mark */
        var glyphs = [], adv = [], w = 0;
        for (i = 0; i < text.length; i++) {
          var ch = text.charAt(i), dec = TR_MAP[ch];
          var bse = dec ? dec[0] : ch, mk = dec ? dec[1] : null;
          var aw = g.measureText(bse).width;
          glyphs.push({ b: bse, m: mk, w: aw });
          adv.push(aw);
          w += aw + em * track;
        }
        w -= em * track;
        /* condense rather than clip -- a clipped building name is a defect a
           critic screenshots */
        var sc = Math.min(1, (W * 0.90) / (w || 1));
        var sx = (W - w * sc) / 2;
        /* Centre the LETTERS in the band, leaving room above the cap line for
           an umlaut and below the baseline for a cedilla.  The old baseline at
           0.82 of the row put the text in the bottom half and the diacritics
           off the top of the ink. */
        var by = y0 + Math.round(ROW * 0.5 + capH * 0.42);
        var pass, px2, off;
        for (pass = 0; pass < 2; pass++) {
          px2 = sx; off = pass === 0 ? Math.max(1, em * 0.022) : 0;
          g.fillStyle = pass === 0 ? 'rgba(38,26,22,0.30)' : spec.ink;
          for (i = 0; i < glyphs.length; i++) {
            g.save(); g.translate(px2 + off, by + off); g.scale(sc, 1);
            g.fillText(glyphs[i].b, 0, 0);
            g.restore();
            if (glyphs[i].m)
              drawMark(g, glyphs[i].m, px2 + off + glyphs[i].w * sc * 0.5, by + off - capH,
                       capH, pass === 0 ? 'rgba(38,26,22,0.30)' : spec.ink, by + off);
            px2 += (adv[i] + em * track) * sc;
          }
        }
        inkX0 = sx; inkX1 = sx + w * sc;
      }
      /* twenty-year-old sign paint is chalky where the sun hits and intact
         under the drip line: erase a little ink, then put the panel back
         UNDERNEATH so the atlas stays fully opaque.  Kept off the top eighth,
         which is where the diacritics live. */
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (i = 0; i < 30; i++) {
        var bx = rnd() * W, byy = y0 + ROW * (0.24 + rnd() * 0.62);
        var br = ROW * (0.02 + rnd() * 0.09);
        var gr = g.createRadialGradient(bx, byy, 0, bx, byy, br);
        gr.addColorStop(0, 'rgba(0,0,0,0.30)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(bx, byy, br, 0, TAU); g.fill();
      }
      g.restore();
      g.save();
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = spec.bg; g.fillRect(0, y0, W, ROW);
      g.restore();

      /* Inset by 7.5% of the row, not by 1.5 texels.  A 12-row atlas mips down
         to 10 px per row by level 3, and at 1.5 texels of margin the row above
         bleeds its lettering into this one -- which is the faint second line of
         text visible under OZGURKENT A-BLOK in _shots/facfix/base-wall.png.
         Then crop HORIZONTALLY to the ink, so a short name is a short board and
         not a long board with a lot of empty paint at each end. */
      var padYpx = ROW * 0.075, marginPx = text ? ROW * 0.26 : 3.5;
      var ux0 = clamp(inkX0 - marginPx, 0, W), ux1 = clamp(inkX1 + marginPx, 0, W);
      if (!(ux1 - ux0 > 8)) { ux0 = 3.5; ux1 = W - 3.5; }
      SIGN.rect.push([ux0 / W, 1 - (y0 + ROW) / W + padYpx / W,
                      ux1 / W, 1 - y0 / W - padYpx / W]);
      SIGN.aspect.push((ux1 - ux0) / Math.max(1, ROW - 2 * padYpx));
      SIGN.capFrac.push(capH / Math.max(1, ROW - 2 * padYpx));
      SIGN.names.push(text);
    }

    var id = g.getImageData(0, 0, W, W), d = id.data, x, y;
    for (y = 0; y < W; y++) for (x = 0; x < W; x++) {
      var gv = (grain[(y % res) * res + (x % res)] - 0.5) * 20;
      var k = (y * W + x) * 4;
      d[k] = clamp(d[k] + gv, 0, 255);
      d[k + 1] = clamp(d[k + 1] + gv, 0, 255);
      d[k + 2] = clamp(d[k + 2] + gv, 0, 255);
      d[k + 3] = 255;                                    /* fully opaque, always */
    }
    g.putImageData(id, 0, 0);

    SIGN.tex = texCanvas(c, true, true);
    SIGN.mat = new THREE.MeshStandardMaterial({
      map: SIGN.tex, roughness: 0.86, metalness: 0.0,
      vertexColors: true, fog: true, dithering: true, side: THREE.FrontSide
    });
    sday(SIGN.mat, { name: 'st-sign', intensity: 0.8 });
    OWN.mat.push(SIGN.mat);
  }

  /* the world size of an atlas row, driven by the height of its LETTERS.
     275 mm is what ref1's SEYDIKENT A-BLOK measures against its own storey. */
  var SIGN_CAP = m(0.275);                 /* 0.9625 world units */
  function signSize(idx, capWorld, maxW) {
    var f = SIGN.capFrac[idx], a = SIGN.aspect[idx];
    if (!(f > 0.02)) f = 0.52;
    if (!(a > 0.1)) a = 8;
    var h = (capWorld || SIGN_CAP) / f, w = h * a;
    if (maxW > 0 && w > maxW) { h *= maxW / w; w = maxW; }
    return { w: w, h: h, a: a };
  }

  /* =========================================================================
     6b.  THE PROUD LETTERS -- the one mark both hero buildings actually carry
     Neither SEYDIKENT is painted on a board.  In _ref/ref6 they are individual
     cut letters screwed to the siding, standing 30-40 mm off it and throwing a
     hard shadow down and right; in _ref/ref7 the same letters sit on smooth
     render.  An OPAQUE atlas row cannot do that -- it would paste a flat
     rectangle of dead colour over fifteen courses of lap siding, which is
     exactly the defect the siding set exists to avoid.

     So this is a second, ALPHA-CUT atlas: RGBA, letters at alpha 1, their cast
     shadow at alpha 0.85 offset down-right, everything else at alpha 0, drawn
     with alphaTest so it still writes depth and never sorts.  Six rows of
     512 x 85, which at a 0.30 m cap height is ~150 texels per capital.
     ====================================================================== */
  var LETT = { tex: null, mat: null, rect: [], aspect: [], capFrac: [], names: [] };
  function buildLetterAtlas(rows) {
    var W = 512, ROWS = 6, ROW = W / ROWS;
    var c = canvasWH(W, W);
    if (!c) { warn('no document: letter atlas skipped'); return; }
    var g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, W, W);
    var r, i;
    for (r = 0; r < ROWS; r++) {
      var spec = rows[r] || null;
      var y0 = r * ROW;
      if (!spec || !spec.text) {
        LETT.rect.push([0.001, 1 - (y0 + ROW) / W + 0.001, 0.999, 1 - y0 / W - 0.001]);
        LETT.aspect.push(6); LETT.capFrac.push(0.6); LETT.names.push('');
        continue;
      }
      var em = Math.round(ROW * 0.70);
      var track = spec.track === undefined ? 0.13 : spec.track;
      g.font = '900 ' + em + 'px "Arial Narrow","Helvetica Neue",Arial,"DejaVu Sans",sans-serif';
      g.textBaseline = 'alphabetic';
      var capH = em * 0.716;
      try {
        var mm2 = g.measureText('H');
        if (mm2 && mm2.actualBoundingBoxAscent > 0) capH = mm2.actualBoundingBoxAscent;
      } catch (eM) {}
      var text = spec.text, glyphs = [], adv = [], w = 0;
      for (i = 0; i < text.length; i++) {
        var ch = text.charAt(i), dec = TR_MAP[ch];
        var bse = dec ? dec[0] : ch, mk = dec ? dec[1] : null;
        var aw = g.measureText(bse).width;
        glyphs.push({ b: bse, m: mk, w: aw });
        adv.push(aw);
        w += aw + em * track;
      }
      w -= em * track;
      var sc = Math.min(1, (W * 0.94) / (w || 1));
      var sx = (W - w * sc) / 2;
      var by = y0 + Math.round(ROW * 0.5 + capH * 0.44);
      var pass, px2, off;
      for (pass = 0; pass < 2; pass++) {
        px2 = sx;
        /* the cast shadow: a real letter standing 35 mm off the wall under an
           overcast sky throws a soft, short, DOWN-RIGHT shadow, not an outline */
        off = pass === 0 ? Math.max(1.5, em * 0.055) : 0;
        g.fillStyle = pass === 0 ? 'rgba(52,34,28,0.85)' : spec.ink;
        for (i = 0; i < glyphs.length; i++) {
          g.save(); g.translate(px2 + off, by + off); g.scale(sc, 1);
          g.fillText(glyphs[i].b, 0, 0);
          g.restore();
          if (glyphs[i].m)
            drawMark(g, glyphs[i].m, px2 + off + glyphs[i].w * sc * 0.5, by + off - capH,
                     capH, pass === 0 ? 'rgba(52,34,28,0.85)' : spec.ink, by + off);
          px2 += (adv[i] + em * track) * sc;
        }
      }
      /* crop to the ink plus the shadow's throw, so the caller sizes a band
         from the letters and not from 512 px of empty alpha */
      var padX = Math.max(2, em * 0.10), padY = ROW * 0.06;
      var ux0 = clamp(sx - padX, 0, W), ux1 = clamp(sx + w * sc + padX + em * 0.055, 0, W);
      LETT.rect.push([ux0 / W, 1 - (y0 + ROW - padY) / W, ux1 / W, 1 - (y0 + padY) / W]);
      LETT.aspect.push((ux1 - ux0) / Math.max(1, ROW - 2 * padY));
      LETT.capFrac.push(capH / Math.max(1, ROW - 2 * padY));
      LETT.names.push(text);
    }
    LETT.tex = texCanvas(c, true, true);
    LETT.mat = new THREE.MeshStandardMaterial({
      map: LETT.tex, roughness: 0.72, metalness: 0.0,
      vertexColors: true, fog: true, dithering: true, side: THREE.DoubleSide,
      transparent: false, alphaTest: 0.42, depthWrite: true
    });
    sday(LETT.mat, { name: 'st-letters', intensity: 0.9 });
    OWN.mat.push(LETT.mat);
  }
  function lettSize(idx, capWorld, maxW) {
    var f = LETT.capFrac[idx], a = LETT.aspect[idx];
    if (!(f > 0.02)) f = 0.58;
    if (!(a > 0.1)) a = 6;
    var h = (capWorld || SIGN_CAP) / f, w = h * a;
    if (maxW > 0 && w > maxW) { h *= maxW / w; w = maxW; }
    return { w: w, h: h, a: a };
  }
  /* one line of proud letters on a run, at s / y, standing `proud` off depth d */
  function letterLine(R, idx, s, y, capW, maxW, d) {
    if (!LETT.rect[idx]) return 0;
    var S = lettSize(idx, capW, maxW);
    var P = PT(R, s, d, y);
    PILES.letter.tint(C.letterRed);
    atlasQuad(PILES.letter, P[0], P[1], P[2], R.nx, 0, R.nz, R.tx, 0, R.tz,
              S.w * 0.5, S.h * 0.5, LETT.rect[idx], 1);
    STATS.props++;
    return S.h;
  }

  /* =========================================================================
     7.  THE GRIME ATLAS
     Sixteen tiles at 128 px, drawn with plain 2D canvas.  This is the whole of
     STREET-BRIEF section 8 that cannot live in a tiling set: the run-off is
     positional (it starts at a sill, a balcony nose, a gutter joint), so it
     has to be placed, not tiled.
     ====================================================================== */
  var DECAL = { tex: null, mat: null, rect: [] };
  var D_STREAK = 0, D_FAN = 1, D_GROUND = 2, D_ALGAE = 3, D_RUST = 4, D_DAMP = 5,
      D_FADE = 6, D_SPALL = 7, D_SOOT = 8, D_DRIP = 9, D_LIME = 10, D_BILL = 11,
      D_CORNER = 12, D_CHIP = 13, D_CABLE = 14, D_BLOB = 15;

  function buildDecalAtlas() {
    /* 512 at every tier.  At 256 each tile is 64 px and a streak bar is 1-3 px
       wide, so the whole of the brief's number one item dissolves in the first
       mip.  128 px tiles keep a 40 mm streak two texels wide at 3 m. */
    var res = 512, N = 4, ts = res / N;
    var c = canvasWH(res, res);
    if (!c) { warn('no document: grime atlas skipped'); return; }
    var g = c.getContext('2d', { willReadFrequently: true });
    var rnd = NZ.tex.mulberry32(5521);
    g.clearRect(0, 0, res, res);
    function cell(i) { return [(i % N) * ts, Math.floor(i / N) * ts]; }
    function push(i) {
      var o = cell(i), pad = ts * 0.012;
      DECAL.rect[i] = [(o[0] + pad) / res, 1 - (o[1] + ts - pad) / res,
                       (o[0] + ts - pad) / res, 1 - (o[1] + pad) / res];
    }
    function vgrad(x, y, w, h, col, a0, a1) {
      var gr = g.createLinearGradient(x, y, x, y + h);
      gr.addColorStop(0, 'rgba(' + col + ',' + a0 + ')');
      gr.addColorStop(1, 'rgba(' + col + ',' + a1 + ')');
      g.fillStyle = gr; g.fillRect(x, y, w, h);
    }
    function blob(x, y, r, col, a) {
      var gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(' + col + ',' + a + ')');
      gr.addColorStop(0.6, 'rgba(' + col + ',' + (a * 0.45) + ')');
      gr.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    var i, o, k;

    /* 0 -- the weather streak below a sill: narrow, dense at the top.
       Rebuilt heavier: 3 dominant runs that carry at 10 m plus 16 hairlines
       that carry at 1 m, and a dark drip band welded to the top edge. */
    o = cell(D_STREAK);
    vgrad(o[0], o[1], ts, ts * 0.10, '52,49,43', 0.72, 0.30);
    for (i = 0; i < 3; i++) {
      var mx0 = o[0] + ts * (0.16 + i * 0.28 + rnd() * 0.10);
      vgrad(mx0, o[1], ts * (0.055 + rnd() * 0.055), ts * (0.70 + rnd() * 0.30),
            '54,51,44', 0.78, 0);
    }
    for (i = 0; i < 16; i++) {
      var sx = o[0] + ts * (0.06 + rnd() * 0.88), sw = ts * (0.014 + rnd() * 0.045);
      vgrad(sx, o[1], sw, ts * (0.45 + rnd() * 0.55), '62,58,50', 0.42 + rnd() * 0.40, 0);
    }
    blob(o[0] + ts * 0.5, o[1] + ts * 0.09, ts * 0.40, '70,66,58', 0.34);
    push(D_STREAK);

    /* 1 -- the fan below a balcony nose or a coping: wide, splayed */
    o = cell(D_FAN);
    vgrad(o[0], o[1], ts, ts * 0.22, '58,55,48', 0.60, 0.06);
    for (i = 0; i < 26; i++) {
      var fx = o[0] + ts * (0.02 + rnd() * 0.96);
      var fw = ts * (0.018 + rnd() * 0.075);
      var fh = ts * (0.26 + rnd() * 0.72);
      vgrad(fx, o[1] + ts * 0.02, fw, fh, '64,60,52', 0.34 + rnd() * 0.38, 0);
    }
    for (i = 0; i < 6; i++)
      blob(o[0] + rnd() * ts, o[1] + ts * (0.05 + rnd() * 0.35), ts * (0.08 + rnd() * 0.16),
           '60,58,50', 0.22);
    push(D_FAN);

    /* 2 -- ground-line soiling: bottom-heavy, splashed and green */
    o = cell(D_GROUND);
    vgrad(o[0], o[1], ts, ts, '66,64,52', 0, 0.80);
    vgrad(o[0], o[1] + ts * 0.62, ts, ts * 0.38, '56,58,44', 0, 0.46);
    for (i = 0; i < 26; i++)
      blob(o[0] + rnd() * ts, o[1] + ts * (0.50 + rnd() * 0.50), ts * (0.04 + rnd() * 0.14),
           '58,64,46', 0.24 + rnd() * 0.22);
    /* the splash line: individual specks thrown up off the paving */
    for (i = 0; i < 40; i++)
      blob(o[0] + rnd() * ts, o[1] + ts * (0.62 + rnd() * 0.38), ts * (0.010 + rnd() * 0.022),
           '52,50,42', 0.42 + rnd() * 0.3);
    push(D_GROUND);

    /* 3 -- algal green-black in a shaded corner */
    o = cell(D_ALGAE);
    for (i = 0; i < 30; i++)
      blob(o[0] + ts * (0.02 + rnd() * 0.55), o[1] + rnd() * ts, ts * (0.06 + rnd() * 0.22),
           '40,52,36', 0.30 + rnd() * 0.30);
    vgrad(o[0], o[1] + ts * 0.3, ts * 0.60, ts * 0.7, '36,48,34', 0, 0.44);
    push(D_ALGAE);

    /* 4 -- rust bleeding from a steel fixing */
    o = cell(D_RUST);
    blob(o[0] + ts * 0.5, o[1] + ts * 0.10, ts * 0.13, '120,62,30', 0.62);
    for (i = 0; i < 7; i++) {
      var rx = o[0] + ts * (0.36 + rnd() * 0.28);
      vgrad(rx, o[1] + ts * 0.08, ts * (0.02 + rnd() * 0.05), ts * (0.45 + rnd() * 0.5),
            '132,72,34', 0.40 + rnd() * 0.24, 0);
    }
    push(D_RUST);

    /* 5 -- rising damp / splash-back */
    o = cell(D_DAMP);
    vgrad(o[0], o[1], ts, ts, '84,76,60', 0, 0.44);
    for (i = 0; i < 10; i++)
      blob(o[0] + rnd() * ts, o[1] + ts * (0.7 + rnd() * 0.3), ts * (0.04 + rnd() * 0.10),
           '92,84,68', 0.22);
    push(D_DAMP);

    /* 6 -- a patch where the paint has faded lighter */
    o = cell(D_FADE);
    for (i = 0; i < 18; i++)
      blob(o[0] + ts * (0.2 + rnd() * 0.6), o[1] + ts * (0.2 + rnd() * 0.6),
           ts * (0.10 + rnd() * 0.22), '230,226,214', 0.13 + rnd() * 0.12);
    push(D_FADE);

    /* 7 -- spalled render showing grey mortar */
    o = cell(D_SPALL);
    g.fillStyle = 'rgba(146,142,134,0.72)';
    g.beginPath();
    var ang = 0, rr = ts * 0.30;
    g.moveTo(o[0] + ts * 0.5 + rr, o[1] + ts * 0.5);
    for (i = 1; i <= 12; i++) {
      ang = i / 12 * TAU; rr = ts * (0.16 + rnd() * 0.22);
      g.lineTo(o[0] + ts * 0.5 + Math.cos(ang) * rr, o[1] + ts * 0.5 + Math.sin(ang) * rr * 0.7);
    }
    g.closePath(); g.fill();
    for (i = 0; i < 12; i++)
      blob(o[0] + ts * (0.3 + rnd() * 0.4), o[1] + ts * (0.34 + rnd() * 0.32),
           ts * 0.04, '112,108,100', 0.4);
    push(D_SPALL);

    /* 8 -- generic soot smudge */
    o = cell(D_SOOT);
    for (i = 0; i < 16; i++)
      blob(o[0] + rnd() * ts, o[1] + rnd() * ts, ts * (0.08 + rnd() * 0.22), '68,66,62', 0.16);
    push(D_SOOT);

    /* 9 -- the drip line: a dark band welded to the top edge with a ragged
       lower boundary.  Doubles as the downpipe joint stain. */
    o = cell(D_DRIP);
    vgrad(o[0], o[1], ts, ts * 0.72, '50,47,41', 0.80, 0);
    for (i = 0; i < 22; i++)
      vgrad(o[0] + rnd() * ts, o[1], ts * (0.02 + rnd() * 0.06), ts * (0.30 + rnd() * 0.68),
            '46,44,38', 0.5 + rnd() * 0.35, 0);
    push(D_DRIP);

    /* 10 -- lime efflorescence */
    o = cell(D_LIME);
    for (i = 0; i < 20; i++)
      blob(o[0] + rnd() * ts, o[1] + rnd() * ts, ts * (0.05 + rnd() * 0.14), '234,232,226', 0.20);
    push(D_LIME);

    /* 11 -- a torn election bill */
    o = cell(D_BILL);
    g.fillStyle = 'rgba(214,208,196,0.90)';
    g.fillRect(o[0] + ts * 0.20, o[1] + ts * 0.16, ts * 0.58, ts * 0.66);
    g.fillStyle = 'rgba(140,52,44,0.75)';
    g.fillRect(o[0] + ts * 0.24, o[1] + ts * 0.22, ts * 0.50, ts * 0.14);
    g.fillStyle = 'rgba(60,58,56,0.55)';
    for (i = 0; i < 5; i++)
      g.fillRect(o[0] + ts * 0.26, o[1] + ts * (0.44 + i * 0.07), ts * (0.20 + rnd() * 0.26), ts * 0.028);
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (i = 0; i < 8; i++)
      blob(o[0] + ts * (0.18 + rnd() * 0.62), o[1] + ts * (0.14 + rnd() * 0.70), ts * 0.09, '0,0,0', 0.9);
    g.restore();
    push(D_BILL);

    /* 12 -- corner grime, dense on one edge */
    o = cell(D_CORNER);
    vgrad(o[0], o[1], ts * 0.34, ts, '62,64,56', 0.40, 0.40);
    for (i = 0; i < 12; i++)
      blob(o[0] + ts * rnd() * 0.5, o[1] + rnd() * ts, ts * 0.10, '58,62,52', 0.20);
    push(D_CORNER);

    /* 13 -- render chipped away at bumper height, grey behind */
    o = cell(D_CHIP);
    g.fillStyle = 'rgba(152,148,140,0.85)';
    g.beginPath();
    g.moveTo(o[0] + ts * 0.10, o[1] + ts * 0.62);
    for (i = 1; i <= 10; i++)
      g.lineTo(o[0] + ts * (0.10 + i * 0.08), o[1] + ts * (0.34 + rnd() * 0.40));
    g.lineTo(o[0] + ts * 0.90, o[1] + ts);
    g.lineTo(o[0] + ts * 0.10, o[1] + ts);
    g.closePath(); g.fill();
    for (i = 0; i < 10; i++)
      blob(o[0] + ts * (0.1 + rnd() * 0.8), o[1] + ts * (0.6 + rnd() * 0.4), ts * 0.05, '120,116,110', 0.5);
    push(D_CHIP);

    /* 14 -- stapled telecom cable and its shadow */
    o = cell(D_CABLE);
    g.strokeStyle = 'rgba(46,44,42,0.80)'; g.lineWidth = ts * 0.035; g.lineCap = 'round';
    for (k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(o[0] + ts * 0.02, o[1] + ts * (0.30 + k * 0.10));
      g.bezierCurveTo(o[0] + ts * 0.34, o[1] + ts * (0.36 + k * 0.10),
                      o[0] + ts * 0.62, o[1] + ts * (0.24 + k * 0.10),
                      o[0] + ts * 0.98, o[1] + ts * (0.34 + k * 0.10));
      g.stroke();
    }
    push(D_CABLE);

    /* 15 -- a soft dirt blob, the workhorse */
    o = cell(D_BLOB);
    blob(o[0] + ts * 0.5, o[1] + ts * 0.5, ts * 0.46, '72,70,64', 0.34);
    push(D_BLOB);

    /* the aging pass: a +-13 luma hash over the whole atlas so nothing reads
       as a crisp sticker */
    var id2 = g.getImageData(0, 0, res, res), dd = id2.data;
    for (i = 0; i < dd.length; i += 4) {
      var n = (hash1(i * 0.017) - 0.5) * 26;
      dd[i] = clamp(dd[i] + n, 0, 255);
      dd[i + 1] = clamp(dd[i + 1] + n, 0, 255);
      dd[i + 2] = clamp(dd[i + 2] + n, 0, 255);
    }
    g.putImageData(id2, 0, 0);

    DECAL.tex = texCanvas(c, true, true);
    DECAL.mat = new THREE.MeshStandardMaterial({
      map: DECAL.tex, transparent: true, opacity: 1, alphaTest: 0.02,
      roughness: 0.94, metalness: 0.0, vertexColors: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      fog: true, dithering: true, side: THREE.FrontSide
    });
    /* 0.45 -> 0.38.  The grime layer is lit like everything else, and at 0.45
       the sky sheen was putting the streaks back up to within 20 codes of the
       wall they are supposed to be staining. */
    sday(DECAL.mat, { name: 'st-grime', intensity: 0.38 });
    OWN.mat.push(DECAL.mat);
  }

  /* =========================================================================
     8.  THE PALETTE AND THE BLOCKS
     Colours sampled off the five reference photographs and converted to
     LINEAR once, because that is how three consumes a vertex colour.  The
     baked render albedo is a neutral 236/233/227, so effective albedo =
     0.85 * tint; a cream at 0.72 lands at 0.61, which with a wall bake of
     ~0.41 and E(up) = 2.0 puts the wall at ~200/255 -- the brief's number.
     ====================================================================== */
  /* CHROMA.  Every body tint below was re-saturated this round and its LUMA
     (0.299/0.587/0.114 on the sRGB byte) held to within 1 % of the value it
     had before, because the sky agent measures the frame at saturation 0.096
     against the reference's 0.187 while the MEAN is already right.  The render
     set itself bakes neutral at sat 0.052 -- all of the street's colour is in
     these six numbers, and successive brightness fixes had walked them toward
     grey.  Old -> new, luma in brackets:
       cream   e4dbc6 -> e7d9ba (219 -> 218)   sat 0.13 -> 0.20
       butter  e6dfc0 -> e9dfb2 (220 -> 221)   sat 0.17 -> 0.24
       salmon  d0a49e -> d8a094 (177 -> 175)   sat 0.24 -> 0.32
       ice     c6d4d8 -> bcd6de (208 -> 207)   sat 0.08 -> 0.15
       sage    becdb9 -> b8d2ad (198 -> 198)   sat 0.10 -> 0.18
       salmonB c79a94 -> ce958a (167 -> 165)   sat 0.26 -> 0.33 */
  var C = {
    salmon:  L(0xd8a094), salmonB: L(0xce958a),
    /* NA'S SAND, AND WHY IT IS NOT CREAM ANY MORE.  NA (x 168-208) and NB
       (x 208-252) are the two halves of the north wall and they were cream 219
       and butter 221 -- the same value and nearly the same hue, which is the
       whole of "the street reads as two parallel walls".  ref1's canyon does
       the opposite: every block changes, and the eye is walked east by a value
       gradient that ENDS on the block with the door.  So the near half is now
       a Konya sand at luma 205 -- 7.5 % darker than the butter it hands over
       to, at the SAME chroma and a cooler hue -- which makes the far half read
       as lighter, further and more important, and puts the darkest mark on the
       whole north side (the entrance tower) on the palest wall.
       The chroma is deliberately NOT raised with it.  Measured on ref4 the
       "cream" block reads sat 0.058 and the "pink" one 0.065; the loudest mark
       in the whole of ref1, the red SEYDIKENT lettering, is 0.193.  A first cut
       of this took NA to sat 0.31, which put the rendered wall at 0.28 on
       screen -- four times the reference's wall and above its lettering.  The
       street's saturation shortfall is in the LOWER 57 % of the frame (ours
       0.14 against the plates' 0.17), and a facade is not in it. */
    cream:   L(0xdccca8), creamB:  L(0xd2c29c),
    butter:  L(0xe9dfb2),
    sage:    L(0xb8d2ad),
    ice:     L(0xbcd6de),
    /* THE ENTRANCE BAY.  ref1's canyon is not two parallel walls of one colour:
       the block that carries the door picks its entrance bay out in a warmer,
       darker render, and that vertical strip -- not the 1 m door at the bottom
       of it -- is what the eye follows up the street.  Deepened this round from
       d6a279 (luma 173) to luma 156: a 29 % VALUE step below butter's 221, and
       the value step is what does the work -- at 65 units the tower is 15 px
       wide and nothing on it resolves, so all it can be is the one dark warm
       column in a pale wall.
       The chroma stays high, and that IS defensible where NA's was not.  The
       tower is 11 px of a 320 px frame -- 1.7 % of it -- so its saturation
       moves the frame statistic by 0.003 and nothing else; NA is a third of the
       frame and moved it by 0.02.  Pulled to sat 0.40 the tower measured
       lum 173 against the butter wall beside it at 168, i.e. it stopped being a
       dark column at all and the whole hierarchy went with it.  Back to 0.60:
       the one place on this street where chroma buys legibility per pixel. */
    entry:   L(0xc79350), entryD: L(0xa87445),
    signBg:  L(0xf1ece0),          /* the cream ground of a painted name band */
    oxide:   L(0xa8392a),          /* the red rule under it, and ref1's own    */
    trim:    L(0xeae7e0),
    white:   L(0xf2f0ea),
    pvc:     L(0xeeece5),
    pvcB:    L(0xe4e2da),          /* the balcony frames are a DIFFERENT white */
    alu:     L(0xc8ccc9),
    timber:  L(0x6e4a30),
    grey:    L(0xb2b2ad),
    dgreen:  L(0x3d5142),
    gasYel:  L(0xd8b83a),
    galv:    L(0xb9bec0),
    lead:    L(0x8e9295),
    /* ref4 puts window glass at 0.79 of its frame, not at the 0.40 a pure
       "dark room" tint gives once the frame is a 236-code white.  These sit
       where that ratio lands after the sky sheen the pane still carries. */
    glass:   L(0x5d686f),          /* a window: a dark room behind a pane   */
    glassLo: L(0x454c4b),          /* ...an unlit one, at the back of a flat */
    glazing: L(0xadb9b9),          /* overcast reflection, below white PVC   */
    glazeLo: L(0x667372),          /* ...one you can see the balcony through */
    glassBz: L(0x8a6c48),
    net:     L(0xc3c0b4),
    curtain: L(0x9d9078),
    soil:    L(0x8d8a76),          /* the ground-line splash band            */
    algae:   L(0x69745e),          /* green-black in the damp corners        */
    repair:  L(0xb6b3ab),          /* a patch of newer, greyer render        */
    tile:    L(0xb4715a),
    tank:    L(0xe8e8e2),
    dark:    L(0x6d6a63),

    /* ---- THE TWO PORTRAITS -------------------------------------------------
       Sampled off the plates rather than invented.  _ref/ref7's render reads
       c9928c in the shade of its own loggias and d8a49e where sixteen years of
       rain has bleached it, and the difference between those two numbers IS
       the building: the pale patches are as much a feature as the windows.
       bblokD is the wet-looking dirty band under the sills and the parapet.

       THE CHROMA CAME DOWN 25 % THIS PASS, and not because the samples above
       were wrong -- they are what the photograph measures.  They were sampled
       as ALBEDO and then read back through a grade that multiplies chroma by
       GRADE_SAT = 1.62 (nz-street-sky.js:728), which no amount of care at the
       sampling end can cancel.  Measured over the whole elevation in
       _shots/final3/n34.png against the same crop of _ref/ref7:

         render   rgb(191,145,133)   H 11.7   S 0.301
         ref7     rgb(149,126,122)   H  7.8   S 0.182

       -- a 65 % saturation excess and a 4 degree hue swing toward orange,
       which is exactly the "strongly red-salmon" the review calls out.  0.301
       / 1.62 = 0.186 says the ALBEDO is right and the GRADE is the difference,
       so the compensation belongs here: the one block that is a photograph
       gets pre-graded albedo.  25 % of chroma out and the hue rotated back to
       ~3 deg lands the graded frame at S ~0.23 / H ~8.5, inside a quarter of
       the plate on both axes, and the block still reads pink beside the cream
       either side of it.  Luminance is held to +/- 1 %: nothing in the
       exposure moves. */
    bblok:   L(0xb78a8b), bblokW: L(0xc49b9a), bblokD: L(0x8f6e6a),
    bblokP:  L(0xaa8585),          /* the rendered plinth, greyer and dirtier */
    /* _ref/ref6's siding is an oatmeal cream that goes green-grey in the wet
       corners; the entrance bay and one other are clad in a taupe of the same
       range, which is what stops 16 m of horizontal boarding reading as one
       object.  The trim strips are a colder, brighter white than the boards. */
    sidCream: L(0xd7cda9), sidCreamB: L(0xc9bea0),
    sidTaupe: L(0x9b8c82), sidTaupeB: L(0x8c7e75),
    sidTrim:  L(0xe4e2d5),
    gutBrown: L(0x7c4034),         /* the brown gutter, downpipe and corner   */
    railRed:  L(0x8c5552),         /* faded rose-brown balcony/stair steel    */
    /* THE PROUD LETTERS' VERTEX TINT, AND WHY IT IS NOT RED.  The LETT atlas
       already carries the ink -- the letters are painted at spec.ink and their
       cast shadow at rgba(52,34,28,0.85) -- so a red vertex tint multiplies a
       red map by a red constant and lands the capitals at linear
       (0.206, 0.005, 0.002): a near-black smudge with 4 % of the wall's
       luminance, and a black shadow behind it.  In _ref/ref7 the letters
       measure sRGB (150-198, 65-110, 76-124) against a wall of (168,148,146):
       barely darker than the render in RED and only a fifth of it in green --
       a RED mark, not a dark one.  A neutral tint hands the atlas straight
       through, which is what an alpha-cut letterform atlas is for. */
    letterRed: L(0xf4efe9)         /* the individual proud letters, both blocks */
  };
  var WHITE = [1, 1, 1];

  /* =========================================================================
     THE SUNNY-DAY PALETTE.  MISSION 4 ONLY -- levelPalette() returns at the
     first line on every other level, so mission 1's night street keeps every
     hex authored above, unchanged, byte for byte.

     WHY IT EXISTS.  Every body colour in the C table above was sampled or
     solved as a PRE-GRADED albedo: the long comment on `bblok` states the
     arithmetic outright -- "they were sampled as ALBEDO and then read back
     through a grade that multiplies chroma by GRADE_SAT = 1.62", so 25 % of
     chroma was taken OUT of the authored hex to land the graded frame on the
     photograph.  Mission 4 no longer runs that grade.  Its sunny profile sets
     GRADE_SAT = 1.30 (nz-street-sky.js:645), and the same albedos therefore
     arrive on screen at 1.30/1.62 = 0.80 of the chroma they were solved for.
     That is the whole of "the palette reads chalky under the sun": it is not a
     taste disagreement with the sampling, it is a 20 % shortfall that appeared
     the day the grade changed underneath it.

     So the first pass RESTORES the chroma the compensation removed -- 1.246x
     about each colour's own luminance, which is the exact inverse of the grade
     that is no longer there -- and nothing else.  Luminance is untouched by
     construction (the expansion is about Y), so no exposure moves.

     The second pass is the only place any TASTE is spent.  Two things a
     photographed overcast street does not need and a sunlit one does:

       * VARIETY.  Under a flat sky two neighbouring walls at the same value
         read as two walls.  Under a raking sun they read as one wall with a
         join in it, because the sun's own falloff is now the dominant value
         signal and it swamps a 5 % albedo step.  A-BLOK's oatmeal and the
         butter gable that abuts it at x 580 were 11 luma apart; they are 26
         apart now.
       * WARMTH ON THE GRAZED FACE.  A-BLOK's street elevation faces SOUTH and
         the sun's azimuth is (-0.94, +0.34): N.L = 0.34 x cos 52 = 0.21, a
         fifth of what the west-facing 232 Sk flanks get.  A cool oatmeal at
         0.21 of key is a grey wall.  The hue goes 4 degrees toward amber and
         the value up 4 %, which is what a lime render actually does in low
         raking light, and it stops the one continuously-visible elevation on
         the level from being the dullest thing on it.

     B-BLOK is NOT re-hued.  Its street face is the north elevation, it is in
     shade for the whole mission, and it is the one surface with a photograph
     behind it -- the chroma restoration alone puts it back on the plate.
     ====================================================================== */
  function hexOf(c) {
    function q(v) {
      v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(clamp(v, 0, 1), 1 / 2.4) - 0.055;
      return clamp(Math.round(v * 255), 0, 255);
    }
    return (q(c[0]) << 16) | (q(c[1]) << 8) | q(c[2]);
  }
  /* the chroma the sampling took out, put back, about the colour's own Y */
  var SUN_CHROMA = 1.62 / 1.30;
  function chromaUp(c, k) {
    var y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], j;
    for (j = 0; j < 3; j++) c[j] = clamp(y + (c[j] - y) * k, 0, 1);
    return c;
  }
  function setC(key, hex) {
    var v = L(hex), c = C[key];
    if (!c) return;
    c[0] = v[0]; c[1] = v[1]; c[2] = v[2];
  }
  function levelPalette() {
    if (NZ.level !== 4) return;
    /* Every entry that carries HUE and is read as a surface albedo.  The
       neutrals (trim, white, pvc, alu, grey, galv, lead, repair, tank, net,
       signBg, letterRed) are left out on purpose: 1.246x of nothing is
       nothing, and running them through the expansion only risks rounding a
       near-neutral off its intended cast. */
    var keys = ['salmon', 'salmonB', 'cream', 'creamB', 'butter', 'sage', 'ice',
                'entry', 'entryD', 'oxide', 'timber', 'dgreen', 'gasYel',
                'glass', 'glassLo', 'glazing', 'glazeLo', 'glassBz',
                'curtain', 'soil', 'algae', 'tile', 'dark',
                'bblok', 'bblokW', 'bblokD', 'bblokP',
                'sidCream', 'sidCreamB', 'sidTaupe', 'sidTaupeB',
                'gutBrown', 'railRed'];
    for (var i = 0; i < keys.length; i++) if (C[keys[i]]) chromaUp(C[keys[i]], SUN_CHROMA);

    /* A-BLOK: oatmeal -> a warm Konya cream, 4 % up in value and 4 deg amber */
    setC('sidCream',  0xe0d4a6);
    setC('sidCreamB', 0xd2c596);
    /* its taupe fields go warm with it, or the block reads two-tone grey */
    setC('sidTaupe',  0xa68f79);
    setC('sidTaupeB', 0x95806c);
    /* the pantile: a red-brown concrete tile in full sun is redder than the
       overcast sample, and it is the only large warm mass above the eaves */
    setC('tile',      0xb2694e);
  }

  /* ---- the storey stack --------------------------------------------------- */
  var EAVES = STOREY.eaves;               /* 51.8 */
  var GH = STOREY.ground;                 /* 11.2 */
  var FH = STOREY.floor;                  /* 10.15 */
  function fy(i) { return i === 0 ? 0 : GH + (i - 1) * FH; }

  var WALL_D = 0.34;                      /* the render sits just proud of the
                                             world quad it hides             */
  var PLINTH_D = 0.52;                    /* travertine / brick cladding      */
  var PLINTH_TOP = m(1.45);               /* 5.08 */
  var BAY = m(1.20);                      /* 4.2  the cikma projection        */
  var SOF0 = 10.2;                        /* soffit springs off the wall      */
  var SOF1 = 11.9;                        /* ...and lands on the bay face     */
  var BALC = m(1.03);                     /* 3.6  balcony recess depth        */
  var PARA = m(1.00);                     /* 3.5  parapet height              */
  var SLAB = 0.75;                        /* balcony slab thickness           */
  var REV = 1.10;                         /* window reveal, upper floors.  0.50
                                             (14 cm) never cast: at 1 m the
                                             assembly read as flush.  1.10 is
                                             31 cm, which is what a 20 mm render
                                             on a 200 mm block with the frame on
                                             the inner face actually gives.    */
  var REV_G = 0.72;                       /* ...and on the ground, where the
                                             wall has less depth to give     */
  var EAVE_OUT = m(0.60);                 /* 2.1  eaves overhang              */
  var CELL_W = 4.2;                       /* wall subdivision, ~1.20 m.  The
                                             grime field and the sky bake both
                                             sample per vertex, so this is the
                                             resolution of every macro-scale
                                             story on the facade.            */

  /* Rule B check, once, loudly: the bay soffit is the lowest thing this
     module hangs over walkable ground.  jumpTop(0.5) = 9.19. */
  function checkClearance() {
    var need = jumpTop(0.5);
    if (SOF0 < need) warn('bay soffit at ' + SOF0 + ' is BELOW jumpTop ' + need.toFixed(2));
  }

  /* ---- the six facade runs ------------------------------------------------
     px/pz is the run origin, (tx,tz) the tangent, (nx,nz) the inward normal.
     gs0..gs1 is the ground-storey extent (which reaches the corners), bs0..bs1
     the bay extent (which stops on the neighbouring run's bay plane so the
     cikma turns the corner cleanly instead of interpenetrating). */
  /* The photographed 233 Sk sequence, stretched to the measured car/building
     proportions.  From the roundabout toward 230 Sk the cream A-BLOK is on the
     left (north), the salmon B-BLOK on the right (south).  Neither end receives
     a closing facade: the east end remains an open city/mountain sightline and
     the south branch at the roundabout continues beside Yildiz Tepesi park.
     NA stays first because nz-street-props.js reads its cikma depth. */
  var RUNS = null;
  function defineRuns() {
    return [
      /* ---- SEYDIKENT A-BLOK, _ref/ref6 -----------------------------------
         Fifty metres of cream horizontal siding.  Its street face is z=140,
         ten world units (2.86 m) behind the red garden wall at z=150.  Three
         ordinary residential entrances are distributed over the frontage;
         none is a gameplay doorway. */
      { id: 'AB', kind: 'ablok', side: 'N', seed: 37,
        px: 580, pz: 140 - BAY, tx: 1, tz: 0, nx: 0, nz: 1,
        len: 176, gs0: 0, gs1: 176, bs0: 0, bs1: 176,
        a: 580, b: 756, plane: 140 - BAY,
        body: C.sidCream, bodyB: C.sidCreamB, bodyHex: 0xd7cda9, plinth: 'render', sign: 0,
        bandTone: 1.0, soffit: 'none', gaps: [],
        entries: [{ s: 28, w: 4.8 }, { s: 88, w: 4.8 }, { s: 148, w: 4.8 }],
        /* Nine apartment-width fields, rather than sixteen narrow glass
           stripes.  The reference elevation is mostly cream siding and
           ordinary windows; only four full stacks are balconies. */
        /* Keep all three entrance axes in broad siding/window fields.  The
           four balcony stacks are distributed around, rather than swallowing,
           those doors, so the elevation reads as one cream wall with selective
           loggias rather than a continuous glazed screen. */
        /* Exact street elevation, lower upper-floor -> top upper-floor.
           The first stack alternates closed/open as it climbs; the other two
           were owner-enclosed on every photographed floor.  Keeping this as
           data (rather than a random hash) makes the silhouette agree from
           every camera and prevents a future rebuild from closing the two
           unmistakable dark recesses again. */
        pat: [[20, 'win'], [18, 'mix', ['glaze', 'open', 'glaze', 'open']],
              [20, 'win'], [20, 'win'],
              [20, 'mix', ['glaze', 'glaze', 'glaze', 'glaze']],
              [20, 'win'],
              [18, 'mix', ['glaze', 'glaze', 'glaze', 'glaze']],
              [20, 'win'], [20, 'win']],
        capA: true, capB: true },

      /* ---- SEYDIKENT B-BLOK, _ref/ref7 -----------------------------------
         One continuous dusty-salmon street plane at z=208: open loggias are
         recessed into it and owner-enclosed balconies finish flush with it.
         No sectional bay, cantilever or continuous dark undercroft is used. */
      { id: 'BB', kind: 'bblok', side: 'S', seed: 23,
        px: 756, pz: 208 + WALL_D, tx: -1, tz: 0, nx: 0, nz: -1,
        len: 176, gs0: 0, gs1: 176, bs0: 0, bs1: 176,
        a: 580, b: 756, plane: 208 + WALL_D,
        body: C.bblok, bodyB: C.bblokW, bodyHex: 0xb78a8b, plinth: 'render', sign: 1,
        bandTone: 1.0, soffit: 'none', gaps: [],
        entries: [{ s: 28, w: 4.8 }, { s: 88, w: 4.8 }, { s: 148, w: 4.8 }],
        /* Five narrow stacks read left-to-right on the photographed street
           elevation.  Their floor arrays run lowest upper-floor -> top:
             P1 G/O/G/G, P2 G/G/G/G, P3 G/G/G/G,
             P4 G/G/O/O, P5 G/O/O/G.
           The third-floor P5 dish is part of the reference, not decoration
           selected by a random seed.  Six wider fields carry paired sashes. */
        pat: [[20, 'pair'], [12, 'mix', ['glaze', 'open', 'glaze', 'glaze']],
              [19, 'pair'], [12, 'mix', ['mull', 'mull', 'mull', 'mull']],
              [19, 'pair'], [12, 'mix', ['glaze', 'mull', 'glaze', 'mull']],
              [19, 'pair'], [12, 'mix', ['glaze', 'glaze', 'open', 'open']],
              [19, 'pair'], [12, 'mix', ['glaze', 'open', 'openDish', 'glaze']],
              [20, 'pair']],
        capA: true, capB: true }
    ];
  }

  function inGap(R, s, y) {
    for (var i = 0; i < R.gaps.length; i++) {
      var g = R.gaps[i];
      if (s > g.s0 - 1e-6 && s < g.s1 + 1e-6 && y < g.y1 - 1e-6) return true;
    }
    return false;
  }
  function spanGaps(R, s0, s1, y0, y1) {
    /* -> list of [a,b] sub-spans of [s0,s1] with no gap over [y0,y1] */
    var cuts = [s0, s1], i;
    for (i = 0; i < R.gaps.length; i++) {
      var g = R.gaps[i];
      if (y0 >= g.y1 - 1e-6) continue;
      if (g.s0 > s0 && g.s0 < s1) cuts.push(g.s0);
      if (g.s1 > s0 && g.s1 < s1) cuts.push(g.s1);
    }
    cuts.sort(function (a, b) { return a - b; });
    var out = [];
    for (i = 0; i < cuts.length - 1; i++) {
      if (cuts[i + 1] - cuts[i] < 0.02) continue;
      var mid = (cuts[i] + cuts[i + 1]) * 0.5;
      if (!inGap(R, mid, (y0 + y1) * 0.5)) out.push([cuts[i], cuts[i + 1]]);
    }
    return out;
  }

  /* ---- the entrance bay ---------------------------------------------------
     THE ONE PIECE OF HIERARCHY THE STREET DID NOT HAVE.  From the west end the
     north plane is seen at 81 degrees off its normal: a 4.6 m name band on it
     foreshortens to 2.4 units and lands on sixteen screen pixels, so nothing
     painted on that plane -- name, stripe, canopy fascia -- can ever say "the
     door is here" from x = 172.  Two surfaces CAN: a face that squares up to
     the west, and a silhouette against the sky.  The entrance bay is therefore
     rebuilt as a projecting stair tower, 3.2 m wide, centred on the recess,
     0.55 m deeper than its neighbours' cikma, in a warmer and darker render,
     with an unlit stair slot up the middle of it, its name in two lines over
     the door AND on its west return, and a stair head that stands 1.75 m proud
     of the eaves line so the roofline breaks exactly above the front door. */
  /* HOW DEEP, AND WHY IT IS NOT A STYLE CHOICE.  Measured off _shots/hier:
     from (172, 6.4, 172) the north cikma face at z = 160.2 hides everything on
     a west-facing return behind it, so the VISIBLE width of that return is
     exactly (BAY_E - BAY) and nothing else -- a 1.7 m cheek behind a 1.2 m
     cikma shows 0.5 m of itself.  The frame measures 3.8 px per degree, so
     every extra unit of projection is worth 3.3 px of west-facing wall and
     there is no other lever: widening the tower along x only adds apparent
     width x sin(11 deg).  1.0 m of extra projection takes the bay from 11 px
     to 18 px and stops 0.3 units short of the kerb line at z = 164. */
  var BAY_E = BAY + m(1.00);              /* 7.70 -- z = 163.70, 2.2 m of cikma.
                                             1.4 units PAST the north roof's own
                                             eaves line at z = 162.3, on purpose:
                                             the tower has to break the fascia
                                             and read in front of the roof, not
                                             tuck under it.                    */
  var TOWER_TOP = EAVES + m(1.75);        /* 57.93 -- the stair head          */
  function entrySpan(R) {
    /* THE TOWER IS GONE.  It was the right answer to "the street has no
       hierarchy" when the block that carries the door was invented; it is the
       wrong answer now that the block is a photograph.  SEYDIKENT B-BLOK has
       no projecting stair tower, no oxide bands and no cream name boards -- it
       has a flat salmon elevation, a recessed door and two lines of red
       letters above it, and that is what bblokRun() builds.  entrySpan()
       therefore only ever fires on a generic run, of which none now carries an
       entrance, so the tower code below stays reachable only if a future run
       asks for it. */
    if (!R.entrance || R.blind || R.kind !== 'generic') return null;
    var half = m(1.60);                                    /* a 3.2 m bay */
    var lo = R.bs0 + m(0.90), hi = R.bs1 - m(0.06);
    if (hi - lo < half * 1.6) return null;
    var a = R.entrance.s - half, b = R.entrance.s + half;
    if (b > hi) { b = hi; a = b - half * 2; }
    if (a < lo) { a = lo; b = Math.min(hi, a + half * 2); }
    if (b - a < half) return null;
    return { s0: a, s1: b, sc: (a + b) * 0.5, d: BAY_E };
  }

  /* ---- column layout ------------------------------------------------------ */
  function columnsOf(R) {
    var ent = R.entryT;
    var lo = R.bs0, hi = ent ? ent.s0 : R.bs1;
    var Ln = hi - lo;
    var n = clamp(Math.round(Ln / m(2.9)), 1, 8);
    var w = Ln / n, cols = [], i;
    for (i = 0; i < n; i++) {
      var h = hash1(R.seed * 13.77 + i * 4.31);
      var kind;
      if (R.blind) kind = 'W';
      else if (n <= 2) kind = (i === 0) ? 'B' : 'W';
      else if (i === 0 || i === n - 1) kind = 'B';
      else kind = h < 0.44 ? 'B' : 'W';
      cols.push({ s0: lo + i * w, s1: lo + (i + 1) * w, kind: kind, i: i, w: w });
    }
    /* the entrance bay is a column of its own, and it is NOT a balcony stack:
       breaking the balcony rhythm is half of what marks it out */
    if (ent) cols.push({ s0: ent.s0, s1: ent.s1, kind: 'E', i: n, w: ent.s1 - ent.s0 });
    return cols;
  }

  /* =========================================================================
     9.  THE FACADE EMITTERS
     ====================================================================== */
  var PILES = null;
  /* A-BLOK and B-BLOK used to bake every pane into the generic glass pile.
     That was cheap, but it made the photographed buildings indivisible: the
     shot trace could only ever reach the grid wall behind the glazing.  Keep a
     second merged pile as the no-destruction fallback, and publish the exact
     pane rectangles beside it.  nz-destruct swaps this one mesh for a single
     dynamic InstancedMesh at ready time, so the intact facade remains one draw
     call while a hit can address one physical pane. */
  var HERO_PANES = [];
  var HERO_GLASS_MESH = null;
  var OCC = [];                             /* AABBs handed to NZ.street.bake */
  var OCCC = [];                            /* ...the coarse subset            */

  function tintJitter(R, s, y, base, amt) {
    var k = 1 + (hash1(R.seed * 7.13 + Math.floor(s / 3.1) * 2.71 + Math.floor(y / 5.3) * 5.17) - 0.5) * amt;
    return mulc(base, k);
  }

  /* ---- the positional grime field ----------------------------------------
     Smooth 2D value noise on world (x+z, y).  Cheap enough to run per vertex
     (four hash1 per octave) and, being world-space, it cannot tile with the
     3 m texture underneath it. */
  function vnoise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var u = ss(x - xi), v = ss(y - yi);
    var a = hash1(xi * 157.13 + yi * 311.71 + seed);
    var b = hash1((xi + 1) * 157.13 + yi * 311.71 + seed);
    var c = hash1(xi * 157.13 + (yi + 1) * 311.71 + seed);
    var d = hash1((xi + 1) * 157.13 + (yi + 1) * 311.71 + seed);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm2(x, y, seed, oct) {
    var s = 0, amp = 0.5, f = 1, tot = 0, i, n = oct || 3;
    for (i = 0; i < n; i++) {
      s += vnoise(x * f, y * f, seed + i * 97.3) * amp;
      tot += amp; amp *= 0.52; f *= 2.07;
    }
    return s / tot;
  }

  /* STREET-BRIEF section 8, items 1, 2, 6 and 8, as a world-space multiplier.
     `groundY` is the datum the ground line is measured from (0 for the street
     wall, the balcony floor for a parapet).  Everything below is a per-channel
     RATIO, not a colour, so one field serves salmon, cream, butter, sage and
     ice blue without knowing which of them it is standing on. */
  var SOIL_M = [0.80, 0.795, 0.70];    /* splashed: darker, warmer, less blue */
  var ALGAE_M = [0.70, 0.80, 0.64];    /* green-black                         */
  var REPAIR_M = [0.945, 0.955, 0.985];/* newer render: greyer and cooler     */
  function grimeField(seed, groundY, strength) {
    var k = strength === undefined ? 1 : strength;
    return function (x, y, z, ny) {
      var u = (x + z * 0.997) * 0.055, v = y * 0.055;      /* ~5 m blotches   */
      var fade = fbm2(u, v, seed, 3);
      var fine = vnoise(u * 3.3, v * 3.3, seed + 613);      /* ~1.5 m panels   */
      var fine2 = vnoise(u * 5.4 + 0.37, v * 4.6, seed + 811);  /* ~0.9 m      */
      /* fbm2 lands in 0.5 +- 0.13 and a single vnoise octave in 0.5 +- 0.29.
         The two fine terms are what a camera at ONE METRE can see -- the broad
         one only shows across a whole facade -- so they carry most of the
         weight.  Together this is about a 25% peak-to-peak wash over two metres
         of wall, against the reference's clean-render patches at sd 21-32. */
      var mul = 1 + (fade - 0.5) * 0.44 * k + (fine - 0.5) * 0.26 * k +
                (fine2 - 0.5) * 0.17 * k;
      var r = mul, g = mul, b = mul, t;
      /* a render repair: a patch of newer, greyer, slightly cooler render */
      var pr = vnoise(u * 0.62, v * 0.80, seed + 241);
      if (pr > 0.845) {
        t = clamp((pr - 0.845) * 9, 0, 1) * k;
        r *= lerp(1, REPAIR_M[0], t); g *= lerp(1, REPAIR_M[1], t); b *= lerp(1, REPAIR_M[2], t);
      }
      /* algal green-black wherever the field says it stays damp: low down, and
         under anything that faces down.  Brief section 3.2. */
      var damp = clamp((0.40 - fade) * 3.2, 0, 1) *
                 clamp(1 - (y - groundY) / m(5.0), 0, 1);
      if (ny < -0.5) damp = clamp(damp + 0.30, 0, 1);
      damp *= k;
      if (damp > 0) {
        t = damp * 0.46;
        r *= lerp(1, ALGAE_M[0], t); g *= lerp(1, ALGAE_M[1], t); b *= lerp(1, ALGAE_M[2], t);
      }
      /* ground-line soiling: the first 1.0-1.5 m is splashed, dirtier and
         greener than the wall above it.  Brief section 8 item 2. */
      var gl = clamp(1 - (y - groundY) / m(1.55), 0, 1);
      if (gl > 0) {
        gl = gl * gl * (0.70 + 0.40 * vnoise(u * 5.1, 0.5, seed + 907)) * k;
        r *= lerp(1, SOIL_M[0], gl); g *= lerp(1, SOIL_M[1], gl); b *= lerp(1, SOIL_M[2], gl);
      }
      return [r, g, b];
    };
  }

  /* --- the ground storey: plinth, wall, shopfront-height windows ----------- */
  function groundStorey(R) {
    var pr = PILES.render, i, sp, j;
    /* the entrance bay's colour runs all the way to the pavement: the point of
       the tower is that it is ONE vertical object from kerb to parapet, and a
       strip that changes colour at first-floor level is two objects */
    var ET = R.entryT;
    function bodyAt(s) {
      return (ET && s > ET.s0 && s < ET.s1) ? R.entryBody : R.body;
    }
    var plinthPile = R.plinth === 'travertine' ? PILES.stone :
                     R.plinth === 'brick' ? PILES.brick : PILES.render;
    var plinthTint = R.plinth === 'travertine' ? L(0xcdc3ad) :
                     R.plinth === 'brick' ? L(0xcfc9c0) : mulc(R.bodyB, 0.82);
    var plinthTile = R.plinth === 'travertine' ? T_TRAV :
                     R.plinth === 'brick' ? T_BRICK : T_RENDER;

    /* window openings on the ground floor */
    var gn = Math.max(2, Math.round((R.gs1 - R.gs0) / m(3.2)));
    var gw = (R.gs1 - R.gs0) / gn;
    var holes = [], gwin = [];
    for (i = 0; i < gn; i++) {
      var hg = hash1(R.seed * 17.3 + i * 5.11);
      var sc = R.gs0 + (i + 0.5) * gw + (hg - 0.5) * gw * 0.16;
      if (inGap(R, sc, 1)) continue;
      if (hg > 0.84) continue;                     /* a blank bay: a store, a
                                                      stair, a bricked opening */
      var hw = m(0.58 + hg * 0.34), y0 = m(1.50), y1 = y0 + m(1.20 + hg * 0.30);
      if (inGap(R, sc - hw, 1) || inGap(R, sc + hw, 1)) continue;
      holes.push({ s0: sc - hw, s1: sc + hw, y0: y0, y1: y1 });
      gwin.push({ sc: sc, hw: hw, y0: y0, y1: y1 });
    }

    /* the wall above the plinth.  CELL is the subdivision the positional grime
       field needs: 3.6 units is ~1.03 m, fine enough that the ground-line soil
       band and the damp corners read as gradients rather than as steps. */
    pr.tile(T_RENDER).tint(R.body).ramp(0, m(2.4), 0.80);
    sp = spanGaps(R, R.gs0, R.gs1, PLINTH_TOP, SOF0);
    for (j = 0; j < sp.length; j++) {
      /* the ground storey gets a finer lattice than the upper floors: it is the
         only wall the player ever stands one metre from, so it is where the
         positional field has to have enough vertices to say anything */
      punched(pr, R, WALL_D, sp[j][0], sp[j][1], PLINTH_TOP, SOF0, holes, 1,
              function (s, y) { return tintJitter(R, s, y, bodyAt(s), 0.07); }, CELL_W * 0.62);
      /* The cikma soffit above weeps down this wall for its whole length --
         look at the cream block in ref1 under the first-floor overhang.  It is
         the single most visible piece of weathering at standing eye height and
         nothing in this module was drawing it. */
      streakRun(R, sp[j][0], sp[j][1], SOF0 - 0.12, m(2.8), WALL_D + 0.06,
                R.seed * 12.7 + j, true);
    }

    /* The plinth.  CRITIC-STREET section 13: this ran 24 m as one flat beige
       band.  It is now cut into 1.5-2.5 m panels, each one a different tone,
       with a vertical joint line between them and a distinct lower course --
       which is what the reference actually shows, because a travertine plinth
       is laid in courses and the bottom one is always the dirty one. */
    var panelW = m(2.1), lowY = PLINTH_TOP * 0.42;
    plinthPile.tile(plinthTile);
    sp = spanGaps(R, R.gs0, R.gs1, 0, PLINTH_TOP);
    for (j = 0; j < sp.length; j++) {
      var pa = sp[j][0], pb = sp[j][1];
      var npn = Math.max(1, Math.round((pb - pa) / panelW));
      for (var pn = 0; pn < npn; pn++) {
        var q0 = lerp(pa, pb, pn / npn), q1 = lerp(pa, pb, (pn + 1) / npn);
        var hp1 = hash1(R.seed * 21.7 + pn * 6.13);
        var hp2 = hash1(R.seed * 33.1 + pn * 2.91);
        /* tile-to-tile value steps: ref1's travertine run swings ~15% */
        var qc = (q0 + q1) * 0.5;
        var pBase = (ET && qc > ET.s0 && qc < ET.s1) ? mulc(C.entryD, 0.80) : plinthTint;
        var pt0 = mulc(pBase, 0.86 + hp1 * 0.28);
        plinthPile.tint(pt0);
        punched(plinthPile, R, PLINTH_D, q0, q1, lowY, PLINTH_TOP, holes, 1, null, CELL_W);
        /* the lower course is a shade different again, and dirtier */
        plinthPile.tint(mulc(pt0, 0.88 + hp2 * 0.12));
        punched(plinthPile, R, PLINTH_D, q0, q1, 0, lowY, holes, 1, null, CELL_W);
        /* the joint between panels: a 30 mm shadow gap */
        if (pn > 0) {
          plinthPile.tint(mulc(plinthTint, 0.52));
          rbox(plinthPile, R, q0 - 0.045, q0 + 0.045, 0, PLINTH_TOP, PLINTH_D - 0.05, PLINTH_D + 0.006, 0, 0.62);
        }
        /* a chipped corner at bumper height on about a third of the panels */
        if (hp2 > 0.66) rdecal(R, lerp(q0, q1, 0.15 + hp1 * 0.7), m(0.55) + hp1 * m(0.5),
                               m(0.30), m(0.26), D_CHIP, 1.0, PLINTH_D + 0.05);
      }
      plinthPile.tint(plinthTint);
      /* the course line at the top of the lower course */
      plinthPile.tint(mulc(plinthTint, 0.60));
      rbox(plinthPile, R, pa, pb, lowY - 0.05, lowY + 0.02, PLINTH_D - 0.04, PLINTH_D + 0.005, 0, 0.70);
      plinthPile.tint(plinthTint);
      /* the return from the plinth face back to the wall, and its drip */
      rdeck(plinthPile, R, pa, pb, WALL_D, PLINTH_D, PLINTH_TOP, true, 0.86);
      rcheek(plinthPile, R, pa, 0, PLINTH_TOP, WALL_D, PLINTH_D, -1, 0.88);
      rcheek(plinthPile, R, pb, 0, PLINTH_TOP, WALL_D, PLINTH_D, 1, 0.88);
      /* the hard AO contact line where the plinth meets the paving, and the
         weeds and splash that always sit in it */
      rdecal(R, (pa + pb) * 0.5, m(0.20), (pb - pa) * 0.5, m(0.26), D_GROUND, 1.0, PLINTH_D + 0.05);
      if (R.plinth === 'render') {
        /* the splash-back band the painted variant always carries */
        pr.tile(T_RENDER).tint(mulc(R.bodyB, 0.72)).ramp(0, 0, 1);
        punched(pr, R, PLINTH_D + 0.02, pa, pb, 0, m(0.55), holes, 1, null, CELL_W);
      }
    }
    pr.ramp(0, 0, 1);

    /* the windows */
    for (i = 0; i < gwin.length; i++) {
      var W = gwin[i];
      makeWindow(R, W.sc, W.hw, W.y0, W.y1, PLINTH_D,
                 hash1(R.seed * 3.31 + i * 9.7), hash1(R.seed * 4.9 + i * 2.7) < 0.68, REV_G);
      STATS.windows++;
    }

    /* chipped render at the corners at bumper height */
    var corners = [R.gs0 + 0.6, R.gs1 - 0.6];
    for (i = 0; i < corners.length; i++) {
      if (inGap(R, corners[i], 1)) continue;
      rdecal(R, corners[i], m(0.5), 1.6, 1.1, D_CHIP, 1.0, PLINTH_D + 0.05);
    }
  }

  /* --- the sloped or stepped soffit that returns the cikma to the ground --- */
  function soffitBand(R) {
    var pr = PILES.render;
    pr.tile(T_RENDER).tint(mulc(R.body, 0.90));
    var sp = spanGaps(R, R.bs0, R.bs1, SOF0, SOF1), j;
    for (j = 0; j < sp.length; j++) {
      var s0 = sp[j][0], s1 = sp[j][1];
      if (R.soffit === 'step') {
        var yA = SOF0 + (SOF1 - SOF0) * 0.5, dA = WALL_D + BAY * 0.5;
        rdeck(pr, R, s0, s1, WALL_D, dA, SOF0, false, 0.68);
        rquad(pr, R, s0, s1, SOF0, yA, dA, 0.86);
        rdeck(pr, R, s0, s1, dA, BAY, yA, false, 0.66);
        rquad(pr, R, s0, s1, yA, SOF1, BAY, 0.90);
      } else {
        var Rf = PT(R, (s0 + s1) * 0.5, BAY * 0.4, SOF1 + 2.5);
        poly(pr, [PT(R, s0, WALL_D, SOF0), PT(R, s1, WALL_D, SOF0),
                  PT(R, s1, BAY, SOF1), PT(R, s0, BAY, SOF1)], Rf[0], Rf[1], Rf[2], 0.66);
      }
      /* the soffit's own end cheeks where it is cut by a gap */
      rcheek(pr, R, s0, SOF0, SOF1, WALL_D, BAY, -1, 0.80);
      rcheek(pr, R, s1, SOF0, SOF1, WALL_D, BAY, 1, 0.80);
    }
    /* over a gap (the entrance, the passage) the soffit is a flat lid instead */
    for (j = 0; j < R.gaps.length; j++) {
      var g = R.gaps[j];
      if (g.y1 >= SOF1) continue;
      pr.tint(mulc(R.body, 0.72));
      rdeck(pr, R, g.s0, g.s1, WALL_D, BAY, g.y1, false, 0.55);
      rquad(pr, R, g.s0, g.s1, g.y1, SOF1, BAY, 0.88);
    }
  }

  /* --- one window: reveal, PVC frame, glass, sill, lintel, grille ---------- */
  function makeWindow(R, sc, hw, y0, y1, d, seed, ground, rev) {
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal;
    var fd = d - (rev || REV);              /* the frame plane */
    var s0 = sc - hw, s1 = sc + hw;

    /* The reveal.  CRITIC-STREET section 11: "the whole assembly sits flush in
       the wall plane; there is no jamb, no head shadow, and no projecting
       sill".  With REV at 31 cm the head and the jambs are real surfaces that
       turn away from the sky, and the tints below say so -- 0.34 on the head is
       the darkest thing on the facade after the balcony soffits, which is
       exactly where a photograph of an overcast street puts it. */
    pr.tile(T_RENDER).tint(mulc(R.body, 0.66));
    rcheek(pr, R, s0, y0, y1, fd, d, 1, 0.50);
    rcheek(pr, R, s1, y0, y1, fd, d, -1, 0.50);
    pr.tint(mulc(R.body, 0.54));
    rdeck(pr, R, s0, s1, fd, d, y1, false, 0.40);          /* the head */
    pr.tint(mulc(R.body, 0.80));
    rdeck(pr, R, s0, s1, fd, d, y0, true, 0.86);           /* the cill board */

    /* frame: outer sections, a transom on the taller openings, one mullion */
    var fw = m(0.075);
    var wood = hash1(seed * 1.7) < 0.13;
    var alu = !wood && hash1(seed * 2.9) < 0.10;
    var fc = wood ? C.timber : alu ? C.alu : C.pvc;
    pj.tile(T_PVC).tint(fc);
    rbox(pj, R, s0, s1, y0, y0 + fw, fd, fd + m(0.07), 0, 0.92);
    rbox(pj, R, s0, s1, y1 - fw, y1, fd, fd + m(0.07), 0, 0.86);
    rbox(pj, R, s0, s0 + fw, y0, y1, fd, fd + m(0.07), 0, 0.92);
    rbox(pj, R, s1 - fw, s1, y0, y1, fd, fd + m(0.07), 0, 0.92);
    var hasT = (y1 - y0) > m(1.4);
    var ty = y1 - m(0.42);
    if (hasT) rbox(pj, R, s0, s1, ty - fw * 0.6, ty + fw * 0.6, fd, fd + m(0.07), 0, 0.88);
    rbox(pj, R, sc - fw * 0.55, sc + fw * 0.55, y0, hasT ? ty : y1, fd, fd + m(0.07), 0, 0.90);

    /* Glass.  Opaque, dark, sitting behind a 31 cm reveal.  Per pane, not per
       window: a flat looks lived-in when the left sash has a net and the right
       one does not, and the brief asks for exactly that mix -- nets in about a
       third, a closed curtain or a rolled blind in others, the rest showing an
       unlit room. */
    var rl = hash1(seed * 5.3);
    var gt = rl < 0.30 ? C.net : rl < 0.46 ? C.curtain : rl < 0.54 ? C.glassBz : C.glass;
    var gk = rl < 0.30 ? 0.98 : rl < 0.46 ? 0.86 : 1.0;
    var gd = fd + m(0.02);
    function pane(a, b, c, e, kk) {
      var hs = hash1(seed * 9.13 + a * 0.7 + c * 0.3);
      var t2 = hs < 0.22 ? C.glassLo : (hs > 0.86 ? C.net : gt);
      pg.tile(T_GLASS).tint(mulc(t2, gk * kk * (0.86 + hs * 0.26)));
      rquad(pg, R, a, b, c, e, gd, 1);
    }
    pane(s0 + fw, sc - fw * 0.55, y0 + fw, hasT ? ty - fw * 0.6 : y1 - fw, 1.0);
    pane(sc + fw * 0.55, s1 - fw, y0 + fw, hasT ? ty - fw * 0.6 : y1 - fw, 1.0);
    if (hasT) pane(s0 + fw, s1 - fw, ty + fw * 0.6, y1 - fw, 1.12);

    /* The sill.  It has to be a real projection with a drip and a shadow under
       it, because it is the origin of the brief's number one item. */
    pr.tile(T_RENDER).tint(C.trim);
    sweepProfile(pr, R, s0 - m(0.10), s1 + m(0.10), y0 - m(0.06), PROF.sill, d, 1);
    pr.tint(mulc(C.trim, 0.34));                            /* under the drip  */
    rdeck(pr, R, s0 - m(0.10), s1 + m(0.10), d + 0.02, d + 0.30, y0 - m(0.055), false, 0.34);
    streakRun(R, s0 - m(0.10), s1 + m(0.10), y0 - m(0.10),
              ground ? m(1.3) : m(2.1), d + 0.07, seed * 1.31, false);

    /* a shallow lintel band above, on the upper floors only */
    if (!ground) {
      pr.tint(mulc(R.body, 0.97));
      sweepProfile(pr, R, s0 - m(0.08), s1 + m(0.08), y1, PROF.sill, d, 0.96);
    }

    /* grilles on ground-floor windows only */
    if (ground) {
      var gc = hash1(seed * 8.1) < 0.34 ? C.white : C.dgreen;
      pm.tile(T_STEEL).tint(gc);
      var nb = Math.max(3, Math.round((s1 - s0) / m(0.19)));
      var rr = m(0.0075);
      for (var b = 1; b < nb; b++) {
        var bs = s0 + (s1 - s0) * b / nb;
        var A = PT(R, bs, d + m(0.055), y0 + m(0.04)), B2 = PT(R, bs, d + m(0.055), y1 - m(0.04));
        tube(pm, A[0], A[1], A[2], B2[0], B2[1], B2[2], rr, 4, 0.94, false);
      }
      rbox(pm, R, s0, s1, y0 + m(0.03), y0 + m(0.055), d + m(0.03), d + m(0.08), 0, 0.9);
      rbox(pm, R, s0, s1, y1 - m(0.055), y1 - m(0.03), d + m(0.03), d + m(0.08), 0, 0.9);
    }
  }

  /* --- one enclosed balcony ------------------------------------------------
     Cantilevered RC slab, a 1.0 m parapet that is either plain rendered or an
     openwork balustrade of white precast members, then the retrofit glazing.
     Randomised per flat: some never glazed, some half, some bronze, some with
     a curtain, a washing line or a dish.  A facade where every balcony matches
     reads as CG instantly, so this is where most of the variation budget went. */
  function makeBalcony(R, s0, s1, yF, yT, hasSlab, seed) {
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal;
    var dBack = BAY - BALC;                  /* the recessed back wall   */
    var r1 = hash1(seed * 1.13), r2 = hash1(seed * 2.29), r3 = hash1(seed * 3.41);
    var r4 = hash1(seed * 4.57), r5 = hash1(seed * 5.63), r6 = hash1(seed * 6.71);
    /* CRITIC-STREET section 12: "every bay uses the same white, the same pane
       count and the same division", glazing / wall = 1.02.  The distribution
       below deliberately puts a quarter of the bays UNGLAZED with their precast
       balustrade showing (the critic's one praised element, and the reference's
       most common state on the lower floors), and the rest across four glazing
       treatments whose panes are individually tinted. */
    var glazed = r1 < 0.24 ? 'none' : r1 < 0.40 ? 'half' : r1 < 0.54 ? 'bronze' : 'full';
    var openwork = r2 < 0.46;

    /* back wall with a door and a window */
    pr.tile(T_RENDER).tint(mulc(R.body, 1.02));
    var dw = m(0.85), dh = m(2.05);
    var doorS = lerp(s0, s1, 0.32);
    var winS = lerp(s0, s1, 0.74), ww = m(0.55), wy0 = yF + m(0.95), wy1 = wy0 + m(1.15);
    punched(pr, R, dBack, s0, s1, yF, yT, [
      { s0: doorS - dw * 0.5, s1: doorS + dw * 0.5, y0: yF + 0.1, y1: yF + 0.1 + dh },
      { s0: winS - ww, s1: winS + ww, y0: wy0, y1: wy1 }
    ], 0.86, null);
    /* the door and window openings read as dark glass with a white frame */
    pj.tile(T_PVC).tint(C.pvc);
    rbox(pj, R, doorS - dw * 0.5, doorS + dw * 0.5, yF + 0.1, yF + 0.1 + dh,
         dBack - m(0.06), dBack, 0, 0.80);
    pg.tile(T_GLASS).tint(mulc(r3 < 0.5 ? C.net : C.curtain, 0.72));
    rquad(pg, R, doorS - dw * 0.5 + m(0.07), doorS + dw * 0.5 - m(0.07),
          yF + 0.1 + m(0.07), yF + 0.1 + dh - m(0.07), dBack - m(0.03), 1);
    rquad(pg, R, winS - ww + m(0.05), winS + ww - m(0.05), wy0 + m(0.05), wy1 - m(0.05),
          dBack - m(0.03), 1);

    /* the side cheeks of the recess */
    pr.tint(mulc(R.body, 0.86));
    rcheek(pr, R, s0, yF, yT, dBack, BAY, 1, 0.62);
    rcheek(pr, R, s1, yF, yT, dBack, BAY, -1, 0.62);
    /* The soffit of the slab above.  Brief section 3.4: "under-slab soffits are
       the darkest surfaces on the facade and carry a hard AO contact line where
       they meet the wall".  The critic measured 0.82 of the wall face; the
       albedo below is what has to carry that, because the specular sky sheen
       lifts every dark surface in this street by about a fifth. */
    pr.tint(mulc(R.body, 0.50));
    rdeck(pr, R, s0, s1, dBack, BAY, yT, false, 0.40);
    /* and the contact line itself, hard against the back wall */
    pr.tint(mulc(R.body, 0.36));
    rquad(pr, R, s0, s1, yT - 0.30, yT - 0.006, dBack + 0.02, 0.34);

    /* the cantilevered slab and its nose.  Floor 1 sits straight on the bay
       soffit, so it has no exposed slab of its own. */
    if (hasSlab) {
      pr.tint(mulc(R.body, 0.94));
      rbox(pr, R, s0, s1, yF - SLAB, yF, dBack, BAY + m(0.05), 0.05, 0.92);
      streakRun(R, s0, s1, yF - SLAB - 0.04, m(2.4), BAY + m(0.06), seed * 2.17, true);
      /* the slab is the single most useful occluder on the facade: it is what
         puts a contact line under itself and darkens the head of the window
         below.  bake() is being rebuilt to honour these this round. */
      OCC.push(rbounds(R, s0, s1, yF - SLAB, yF + 0.2, dBack, BAY + m(0.06)));
    } else {
      pr.tint(mulc(R.body, 0.92));
      rdeck(pr, R, s0, s1, dBack, BAY, yF, true, 0.72);
    }

    /* parapet */
    if (openwork) {
      /* white precast balusters between a base rail and a coping */
      pr.tint(C.trim);
      rbox(pr, R, s0, s1, yF, yF + m(0.16), BAY - m(0.10), BAY + m(0.04), 0.03, 0.94);
      var nb = Math.max(4, Math.round((s1 - s0) / m(0.20)));
      pj.tile(T_PVC).tint(C.trim);
      for (var b = 0; b < nb; b++) {
        var bs = lerp(s0 + m(0.10), s1 - m(0.10), (b + 0.5) / nb);
        var A = PT(R, bs, BAY - m(0.03), yF + m(0.16)), B2 = PT(R, bs, BAY - m(0.03), yF + PARA - m(0.14));
        tube(pj, A[0], A[1], A[2], B2[0], B2[1], B2[2], m(0.035), 6, 0.92, false);
        tube(pj, A[0], A[1] + m(0.36), A[2], B2[0], B2[1] - m(0.30), B2[2], m(0.052), 6, 0.90, false);
      }
      pr.tint(C.trim);
      sweepProfile(pr, R, s0, s1, yF + PARA - m(0.14), PROF.cope, BAY - m(0.14), 0.96);
    } else {
      pr.tile(T_RENDER).tint(tintJitter(R, s0, yF, mulc(R.body, 0.98), 0.06));
      rbox(pr, R, s0, s1, yF, yF + PARA, BAY - m(0.12), BAY, 0.05, 0.96);
      rdeck(pr, R, s0, s1, BAY - m(0.12), BAY, yF + PARA, true, 0.90);
      pr.tint(C.trim);
      sweepProfile(pr, R, s0 - m(0.03), s1 + m(0.03), yF + PARA - m(0.10), PROF.cope, BAY - m(0.16), 0.98);
    }

    /* the coping weeps down the parapet face -- the second most common streak
       on the whole street after the sills */
    streakRun(R, s0, s1, yF + PARA - m(0.16), PARA * 0.86, BAY + 0.07, seed * 4.03, true);
    /* the retrofit glazing, parapet top to soffit, in 3-6 vertical panes and
       in a slightly different white from the balustrade */
    if (glazed !== 'none') {
      var gy0 = yF + PARA, gy1 = yT - m(0.03);
      var gs0 = s0, gs1 = s1;
      if (glazed === 'half') gs1 = lerp(s0, s1, 0.42 + r6 * 0.28);
      var np = clamp(Math.round((gs1 - gs0) / m(0.42 + r6 * 0.34)), 3, 6);
      var fw = m(0.055), fd0 = BAY - m(0.10), fd1 = BAY - m(0.02);
      pj.tile(T_PVC).tint(r4 < 0.18 ? C.alu : (r4 > 0.82 ? C.timber : C.pvcB));
      rbox(pj, R, gs0, gs1, gy0, gy0 + fw, fd0, fd1, 0, 0.92);
      rbox(pj, R, gs0, gs1, gy1 - fw, gy1, fd0, fd1, 0, 0.86);
      for (var p = 0; p <= np; p++) {
        var ps = lerp(gs0, gs1, p / np);
        rbox(pj, R, ps - fw * 0.5, ps + fw * 0.5, gy0, gy1, fd0, fd1, 0, 0.92);
      }
      /* PANE BY PANE.  This is the whole point of the detail: in ref1 and ref4
         roughly half the glazed bays show a dark interior and the other half a
         sky reflection, and inside one bay the sliders sit at different angles
         so no two panes match.  A single quad across the opening -- which is
         what this was -- cannot show any of that. */
      var bronze = glazed === 'bronze';
      var curt = r5 < 0.26;
      var lean = 0.30 + r5 * 0.5;            /* how sky-facing this bay is  */
      for (p = 0; p < np; p++) {
        var pa = lerp(gs0, gs1, p / np) + fw * 0.5;
        var pb = lerp(gs0, gs1, (p + 1) / np) - fw * 0.5;
        var hp = hash1(seed * 7.19 + p * 11.3);
        var col, k2;
        if (bronze) { col = C.glassBz; k2 = 0.84 + hp * 0.30; }
        else if (curt && hp < 0.72) { col = C.curtain; k2 = 0.86 + hp * 0.34; }
        else if (hp < lean) { col = C.glazing; k2 = 0.90 + hp * 0.24; }   /* sky */
        else if (hp > 0.88) { col = C.glassLo; k2 = 1.0; }                /* dark */
        else { col = C.glazeLo; k2 = 0.80 + hp * 0.46; }                  /* room */
        pg.tile(T_GLASS).tint(mulc(col, k2));
        rquad(pg, R, pa, pb, gy0 + fw, gy1 - fw, fd0 + m(0.035), 1);
      }
      if (glazed === 'half') {
        /* the unglazed half keeps its railing */
        pm.tile(T_STEEL).tint(C.white);
        var A2 = PT(R, gs1, BAY - m(0.05), gy0 + m(0.02)), B3 = PT(R, s1, BAY - m(0.05), gy0 + m(0.02));
        tube(pm, A2[0], A2[1], A2[2], B3[0], B3[1], B3[2], m(0.022), 5, 0.94, true);
        var A4 = PT(R, gs1, BAY - m(0.05), gy0 + m(0.60)), B4 = PT(R, s1, BAY - m(0.05), gy0 + m(0.60));
        tube(pm, A4[0], A4[1], A4[2], B4[0], B4[1], B4[2], m(0.018), 5, 0.94, true);
      }
    }
    /* human traces -- brief section 8 item 7.  Not decoration: it is the only
       thing that says somebody lives behind each of these forty-four openings. */
    if (r3 > 0.72 && glazed === 'none') {  /* a washing line across the opening */
      pm.tile(T_STEEL).tint(C.lead);
      var Ax = PT(R, s0 + m(0.25), BAY - m(0.28), yF + PARA + m(1.25));
      var Bx = PT(R, s1 - m(0.25), BAY - m(0.28), yF + PARA + m(1.15));
      tube(pm, Ax[0], Ax[1], Ax[2], Bx[0], Bx[1], Bx[2], m(0.012), 4, 1, false);
      /* and what is hanging on it */
      pj.tile(T_PVC).tint(mulc(r5 < 0.5 ? C.curtain : C.trim, 0.92));
      for (var wq = 0; wq < 3; wq++) {
        var wx = lerp(s0 + m(0.4), s1 - m(0.4), (wq + 0.5) / 3);
        rbox(pj, R, wx - m(0.20), wx + m(0.20), yF + PARA + m(0.40), yF + PARA + m(1.20),
             BAY - m(0.32), BAY - m(0.26), 0, 0.80);
      }
    }
    if (r4 > 0.76) dish(R, (s0 + s1) * 0.5 + m(0.5), yF + PARA + m(0.22), BAY + m(0.10), seed);
    if (r6 > 0.84) {          /* a carpet thrown over the parapet to air */
      pj.tile(T_PVC).tint(mulc(r5 < 0.5 ? L(0x7a4a3e) : L(0x50564e), 1.0));
      rbox(pj, R, lerp(s0, s1, 0.15), lerp(s0, s1, 0.62), yF + PARA - m(0.95), yF + PARA + m(0.05),
           BAY + m(0.01), BAY + m(0.07), 0.02, 0.92);
    }
    STATS.balconies++;
  }

  /* a small offset satellite dish, bolted at a rakish angle */
  function dish(R, s, y, d, seed) {
    var pm = PILES.metal;
    pm.tile(T_STEEL).tint(C.white);
    var az = (hash1(seed * 6.1) - 0.5) * 0.5;
    var A = PT(R, s, d, y), B2 = PT(R, s + az * 1.4, d + m(0.30), y + m(0.16));
    tube(pm, A[0], A[1], A[2], B2[0], B2[1], B2[2], m(0.018), 5, 0.92, true);
    var C0 = PT(R, s + az * 1.4, d + m(0.30), y + m(0.16));
    var C1 = PT(R, s + az * 1.5, d + m(0.36), y + m(0.18));
    tube(pm, C0[0], C0[1], C0[2], C1[0], C1[1], C1[2], m(0.24), 10, 0.94, true);
    STATS.props++;
  }

  /* --- a grime decal on the run plane -------------------------------------- */
  function rdecal(R, s, y, hw, hh, idx, ts, d) {
    if (!DECAL.rect[idx]) return;
    if (hash1(R.seed * 1.9 + s * 0.37 + y * 0.11) > DENSITY + 0.40) return;
    var P0 = PT(R, s, d, y);
    PILES.decal.tint(WHITE);
    atlasQuad(PILES.decal, P0[0], P0[1], P0[2], R.nx, 0, R.nz,
              -R.nz, 0, R.nx, hw, hh, DECAL.rect[idx], ts === undefined ? 1 : ts);
    STATS.decals++;
  }

  /* --- weather streaks -----------------------------------------------------
     STREET-BRIEF section 8 ranks this FIRST and CRITIC-STREET section 4 says
     it does not exist on any of the six blocks.  Every horizontal feature on a
     Turkish render facade weeps: a sill, a balcony nose, a coping, a gutter
     joint, a floor band.  A run of two or three overlapping quads of the streak
     tile, at slightly different widths and drops, breaks the tile's own rhythm
     so it does not read as a repeated sticker.
       yTop  the underside of the feature the water leaves
       drop  how far the stain runs (world units)
       d     depth off the run plane -- must clear whatever projects above    */
  function streakRun(R, s0, s1, yTop, drop, d, seed, wide) {
    var span = s1 - s0;
    if (span <= 0.4 || drop <= 0.2) return;
    var n = clamp(Math.round(span / m(1.15)), 1, 7);
    var i;
    for (i = 0; i < n; i++) {
      var h1 = hash1(seed * 3.17 + i * 7.71), h2 = hash1(seed * 5.29 + i * 3.13);
      var a = lerp(s0, s1, i / n), b = lerp(s0, s1, (i + 1) / n);
      var hw = (b - a) * 0.5 * (0.86 + h1 * 0.3);
      var hh = drop * (0.55 + h2 * 0.5) * 0.5;
      var cs = (a + b) * 0.5 + (h1 - 0.5) * (b - a) * 0.2;
      rdecal(R, cs, yTop - hh, hw, hh, wide ? D_FAN : D_STREAK, 1.0, d);
    }
    /* the drip line itself: a short dark band right under the nose, which is
       what actually reads at 10 m even when the streaks below it do not */
    rdecal(R, (s0 + s1) * 0.5, yTop - m(0.13), span * 0.5, m(0.13), D_DRIP, 1.0, d + 0.01);
  }

  /* --- the upper storeys: the cikma, its columns, windows and balconies ---- */
  function upperStoreys(R) {
    var pr = PILES.render, cols = columnsOf(R), i, f;
    R.cols = cols;
    for (f = 1; f <= 4; f++) {
      /* the storey band the wall actually occupies.  Slab lines fall at
         fy(f) - SLAB, so consecutive bands abut exactly and no 0.75-unit
         ribbon of nothing shows at every floor. */
      var wb = (f === 1) ? SOF1 : fy(f) - SLAB;
      var wt = (f === 4) ? EAVES : fy(f + 1) - SLAB;
      var yF = (f === 1) ? SOF1 : fy(f);
      var yT = (f === 4) ? EAVES - m(0.30) : fy(f + 1) - SLAB;
      for (i = 0; i < cols.length; i++) {
        var col = cols[i];
        var seed = R.seed * 101 + col.i * 37 + f * 13;
        if (col.kind === 'E') {
          if (f === 1) entryTower(R, col);      /* full height, built once */
        } else if (col.kind === 'B') {
          var mrg = m(0.34);
          var bs0 = col.s0 + mrg, bs1 = col.s1 - mrg;
          /* the piers either side of the balcony, full bay depth */
          pr.tile(T_RENDER).tint(tintJitter(R, col.s0, yF, R.body, 0.06));
          punched(pr, R, BAY, col.s0, bs0, wb, wt, [], 1, null, CELL_W);
          punched(pr, R, BAY, bs1, col.s1, wb, wt, [], 1, null, CELL_W);
          makeBalcony(R, bs0, bs1, yF, yT, f > 1, seed);
        } else {
          /* a window cell: solid bay face with one or two punched openings */
          var paired = hash1(seed * 1.77) < 0.28;
          var holes = [], wins = [];
          if (R.blind) {
            /* a gable window is small, high and off-centre */
            wins.push({ sc: lerp(col.s0, col.s1, 0.34 + 0.3 * hash1(seed * 2.9)), hw: m(0.38) });
          } else if (paired) {
            var hw2 = m(0.46), gap2 = m(0.22);
            var c0 = (col.s0 + col.s1) * 0.5 - hw2 - gap2 * 0.5;
            var c1 = (col.s0 + col.s1) * 0.5 + hw2 + gap2 * 0.5;
            wins.push({ sc: c0, hw: hw2 }, { sc: c1, hw: hw2 });
          } else {
            wins.push({ sc: (col.s0 + col.s1) * 0.5, hw: m(0.70) });
          }
          var y0 = yF + m(0.90), y1 = y0 + (R.blind ? m(1.05) : m(1.50));
          for (var k = 0; k < wins.length; k++)
            holes.push({ s0: wins[k].sc - wins[k].hw, s1: wins[k].sc + wins[k].hw, y0: y0, y1: y1 });
          pr.tile(T_RENDER).tint(R.body);
          punched(pr, R, BAY, col.s0, col.s1, wb, wt, holes, 1,
                  function (s, y) { return tintJitter(R, s, y, R.body, 0.055); }, CELL_W);
          for (k = 0; k < wins.length; k++) {
            makeWindow(R, wins[k].sc, wins[k].hw, y0, y1, BAY, seed * 3.1 + k * 7.3, false);
            STATS.windows++;
          }
        }
      }
      /* the floor-line band some blocks carry -- and its own weeping.  It stops
         at the entrance tower, which is 0.55 m in front of it. */
      var bE = R.entryT ? R.entryT.s0 : R.bs1;
      if (R.bandTone < 0.95 && f > 1 && bE - R.bs0 > 2) {
        pr.tile(T_RENDER).tint(mulc(R.body, R.bandTone));
        sweepProfile(pr, R, R.bs0, bE, wb - m(0.10), PROF.band, BAY, 0.96);
        streakRun(R, R.bs0, bE, wb - m(0.12), m(1.5), BAY + 0.09, R.seed * 3.7 + f, true);
      }
    }
    /* the bay end cheeks, where the cikma does NOT wrap a corner */
    if (R.capA) bayCheek(R, R.bs0, -1);
    if (R.capB) bayCheek(R, R.bs1, 1);
    /* a 300 mm painted stripe at first-floor level, on some blocks */
    if (R.seed % 2 === 1) {
      var qE = R.entryT ? R.entryT.s0 : R.bs1;
      pr.tile(T_RENDER).tint(mulc(R.body, 0.80));
      if (qE - R.bs0 > 2) rquad(pr, R, R.bs0, qE, fy(1) + m(0.10), fy(1) + m(0.40), BAY + 0.02, 1);
    }
  }

  /* --- THE BAY END CHEEK -------------------------------------------------
     A capped cikma return is 1.2 m of wall and 11.4 m of height, and it was
     ONE quad of flat body tint.  On six of the seven runs that quad faces a
     neighbouring block a metre away and nobody will ever see it; on NC it
     faces WEST into the junction throat, under the bridge band, and it is the
     nearest lit surface in the whole island composition -- the bare yellowish
     pier at the top left of _shots/final3/island2.png, 21 units from the
     camera and 40 units tall with not one horizontal on it.

     A real one is storeyed, because the floor bands of the front elevation do
     not stop at the arris: they turn the corner and die into the flank.  So
     this is the same three cues the front gets, wrapped:

       * every floor band from the second up, returned across the full 1.2 m;
       * a 200 mm white trim quoin down the outer arris, which is the one
         thing on a cheek that reads as an EDGE at 20 units;
       * the cornice band under the eaves, so the pier has a top.

     Cost: 5 quads per cheek, in the pile that was already drawing the cheek.  */
  function bayCheek(R, s, dir) {
    var pr = PILES.render, f;
    var so = s + dir * 0.05, qd = m(0.20);
    pr.tile(T_RENDER).tint(mulc(R.body, 0.86));
    rcheek(pr, R, s, SOF1, EAVES, WALL_D, BAY, dir, 0.74);
    /* the floor bands, turned round the corner.  The FIRST one is the soffit
       line itself, not fy(2): from the island camera only the bottom 8 units
       of NC's cheek are in frame at all, and a pier whose only horizontal is
       above the top of the picture is still a blank pier. */
    pr.tint(mulc(R.body, Math.min(R.bandTone === undefined ? 0.94 : R.bandTone, 0.90)));
    rcheek(pr, R, so, SOF1, SOF1 + m(0.34), WALL_D, BAY + m(0.04), dir, 0.88);
    rcheek(pr, R, so, SOF1 + m(1.55), SOF1 + m(1.85), WALL_D, BAY + m(0.04), dir, 0.90);
    for (f = 2; f <= 4; f++) {
      var yb = fy(f) - SLAB - m(0.10);
      if (yb < SOF1 + 0.5 || yb > EAVES - 1.5) continue;
      rcheek(pr, R, so, yb, yb + m(0.30), WALL_D, BAY + m(0.04), dir, 0.90);
    }
    /* the cornice band, so the pier has a head */
    rcheek(pr, R, so, EAVES - m(0.46), EAVES - m(0.10), WALL_D, BAY + m(0.04), dir, 0.92);
    /* the quoin down the arris -- the only mark on a 1.2 m cheek that survives
       the mip chain at junction range */
    pr.tint(mulc(C.white, 0.96));
    rcheek(pr, R, so, SOF1, EAVES, BAY - qd, BAY + 0.03, dir, 0.96);
    /* ONE NARROW LIGHT PER FLOOR.  A 1.1 m return on a corner block is exactly
       where a Turkish flat puts its bathroom window, and it is the difference
       between a pier and a piece of wall: at 21 units a 0.6 m opening is 8 px
       of the darkest value in that quarter of the frame, and the eye reads it
       as a building instantly.  Two quads each -- a white surround and an
       unlit pane -- because a punched reveal on a face this narrow would be
       three times the geometry for a detail nobody can resolve. */
    var pj = PILES.joinery, pg = PILES.glass, wd0 = BAY - m(0.92), wd1 = BAY - m(0.34), fq;
    for (fq = 1; fq <= 4; fq++) {
      var wy0 = fy(fq) + m(0.98), wy1 = wy0 + m(1.24);
      if (wy0 < SOF1 + 0.6 || wy1 > EAVES - m(0.8)) continue;
      pj.tile(T_PVC).tint(C.pvc);
      rcheek(pj, R, so + dir * 0.02, wy0 - m(0.08), wy1 + m(0.08), wd0 - m(0.08), wd1 + m(0.08), dir, 0.90);
      pg.tile(T_GLASS).tint(mulc(hash1(R.seed * 3.7 + fq * 5.1) < 0.45 ? C.net : C.glassLo, 0.86));
      rcheek(pg, R, so + dir * 0.05, wy0, wy1, wd0, wd1, dir, 0.88);
      STATS.windows++;
    }
    STATS.props++;
  }

  /* --- THE ENTRANCE TOWER --------------------------------------------------
     Everything the west end can actually see of the front door.  Four cues,
     in descending order of how far they carry:

       1. SILHOUETTE.  The stair head stands 1.75 m above the eaves line, and
          the sightline from (172, 6.4, 172) to its top passes SOUTH of the
          north roof's eaves edge for its whole length, so it is drawn against
          open sky.  A notch in a 24 m eaves line reads at any distance.
       2. THE WEST RETURN.  1.58 m of wall squarely facing the camera at the
          one point on the north side where any wall does.  It carries the
          name a second time -- a bright cream board with a red rule under it,
          which at 65 units is 30 x 20 px of high-contrast mark.
       3. COLOUR.  A warmer, 22 % darker render than the butter either side of
          it, carried all the way down past the plinth, so the whole vertical
          strip from pavement to parapet is one object.
       4. THE STAIR SLOT.  An unlit glazed strip up the middle: the darkest
          thing on the block, and a vertical line pointing at the door.        */
  function entryTower(R, T) {
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass;
    var s0 = T.s0, s1 = T.s1, sc = (s0 + s1) * 0.5;
    var dF = BAY_E, dB = BAY - BALC;
    var body = R.entryBody || mulc(R.body, 0.84);
    var i;

    /* --- the underside of the deeper cikma, and the contact line it casts -- */
    pr.tile(T_RENDER).tint(mulc(body, 0.50));
    rdeck(pr, R, s0, s1, BAY, dF, SOF1, false, 0.36);
    pr.tint(mulc(R.body, 0.42));
    rquad(pr, R, s0, s1, SOF1 + 0.02, SOF1 + 0.42, BAY - 0.02, 0.36);

    /* --- the sign panel zone, then the stair slot above it ---------------- */
    /* SIZED OFF THE TOWER, NOT OFF A CONSTANT.  ref1 paints the site name as
       large as the bay will take it and the block letter noticeably smaller
       under it; the old code asked for 275 mm capitals on both lines, which the
       long line could not have (it hit the width limit and shrank to 213 mm)
       and the short one did not need -- so B came out BIGGER than A, which is
       the opposite of the photograph.  Line A is now width-bound at whatever
       cap height 3.2 m of tower allows, and line B is 78 % of it. */
    var mxW = (s1 - s0) - m(0.55);
    var A = signSize(R.signTop, SIGN_CAP * 1.9, mxW);
    var capA = (SIGN.capFrac[R.signTop] || 0.52) * A.h;
    var B = signSize(R.signBot, capA * 0.78, mxW * 0.88);
    var panW = Math.min(Math.max(A.w, B.w) + m(0.42), (s1 - s0) - m(0.22));
    var panH = A.h + B.h + m(0.34);
    var py0 = SOF1 + m(0.62), py1 = py0 + panH;
    var slotHW = m(0.58), gy0 = py1 + m(0.72), gy1 = EAVES - m(1.30);

    /* --- the front face --------------------------------------------------- */
    pr.tile(T_RENDER).tint(body);
    punched(pr, R, dF, s0, s1, SOF1, EAVES, [
      { s0: sc - slotHW, s1: sc + slotHW, y0: gy0, y1: gy1 }
    ], 1, function (s, y) { return tintJitter(R, s, y, body, 0.055); }, CELL_W);

    /* --- the stair slot: reveal, frame, floor transoms, unlit glass -------- */
    pr.tint(mulc(body, 0.58));
    rcheek(pr, R, sc - slotHW, gy0, gy1, dF - REV, dF, 1, 0.44);
    rcheek(pr, R, sc + slotHW, gy0, gy1, dF - REV, dF, -1, 0.44);
    pr.tint(mulc(body, 0.46));
    rdeck(pr, R, sc - slotHW, sc + slotHW, dF - REV, dF, gy1, false, 0.34);
    pr.tint(mulc(body, 0.80));
    rdeck(pr, R, sc - slotHW, sc + slotHW, dF - REV, dF, gy0, true, 0.84);
    var fw = m(0.07), fd = dF - REV;
    pj.tile(T_PVC).tint(C.pvc);
    rbox(pj, R, sc - slotHW, sc + slotHW, gy0, gy0 + fw, fd, fd + m(0.07), 0, 0.90);
    rbox(pj, R, sc - slotHW, sc + slotHW, gy1 - fw, gy1, fd, fd + m(0.07), 0, 0.86);
    rbox(pj, R, sc - slotHW, sc - slotHW + fw, gy0, gy1, fd, fd + m(0.07), 0, 0.92);
    rbox(pj, R, sc + slotHW - fw, sc + slotHW, gy0, gy1, fd, fd + m(0.07), 0, 0.92);
    for (i = 2; i <= 5; i++) {
      var ty = fy(i) - SLAB * 0.5;
      if (ty <= gy0 + fw * 2 || ty >= gy1 - fw * 2) continue;
      rbox(pj, R, sc - slotHW, sc + slotHW, ty - fw * 0.5, ty + fw * 0.5, fd, fd + m(0.07), 0, 0.90);
    }
    for (i = 0; i < 9; i++) {
      var pa = lerp(gy0 + fw, gy1 - fw, i / 9), pb = lerp(gy0 + fw, gy1 - fw, (i + 1) / 9);
      var hp = hash1(R.seed * 5.93 + i * 3.71);
      pg.tile(T_GLASS).tint(mulc(hp < 0.22 ? C.glazeLo : C.glassLo, 0.84 + hp * 0.30));
      rquad(pg, R, sc - slotHW + fw, sc + slotHW - fw, pa, pb, fd + m(0.02), 1);
    }

    /* --- the two return cheeks.  The west one is the whole point. --------- */
    pr.tile(T_RENDER).tint(mulc(body, 0.88));
    rcheek(pr, R, s0, SOF1, EAVES, dB, dF, -1, 0.78);
    rcheek(pr, R, s1, SOF1, EAVES, dB, dF, 1, 0.78);
    streakRun(R, s0 + 0.4, s1 - 0.4, SOF1 - 0.06, m(2.6), BAY + 0.10, R.seed * 9.31, true);

    /* --- the quoins.  A 400 mm strip of the block's white trim wrapped round
       each vertical arris, full height.  The eye detects EDGES, not areas, and
       at 66 units this is a 3 px bright line hard against a dark warm one,
       running the entire height of the frame -- the cheapest legible thing on
       the whole facade and completely standard on this building type. */
    /* qd was 0.30 m, which ate a third of the 1.0 m of west-facing return this
       tower has -- the scarcest surface on the street.  0.20 m still reads as a
       bright edge on the silhouette (2 px) and hands 0.35 m back to the sign
       panel, which is a 31 % wider mark for nothing. */
    var qw = m(0.40), qd = m(0.20);
    pr.tint(mulc(C.white, 1.02));
    rquad(pr, R, s0, s0 + qw, SOF1, EAVES, dF + 0.05, 0.98);
    rquad(pr, R, s1 - qw, s1, SOF1, EAVES, dF + 0.05, 0.98);
    rcheek(pr, R, s0 - 0.05, SOF1, EAVES, dF - qd, dF, -1, 0.86);
    rcheek(pr, R, s1 + 0.05, SOF1, EAVES, dF - qd, dF, 1, 0.86);
    /* the second oxide ring, under the cornice: two red bands on one warm
       strip is a rhythm the eye reads as "signage" even at eleven pixels */
    pr.tint(C.oxide);
    rquad(pr, R, s0, s1, EAVES - m(0.78), EAVES - m(0.34), dF + 0.05, 1);
    rcheek(pr, R, s0 - 0.07, EAVES - m(0.78), EAVES - m(0.34), BAY, dF, -1, 1);
    rcheek(pr, R, s1 + 0.07, EAVES - m(0.78), EAVES - m(0.34), BAY, dF, 1, 1);

    /* --- the name, over the door, in two lines, ref1's own layout ---------- */
    nameBoard(R, py0, panW, A, B, s0, s1, dF);
    /* --- and again on each return, where it faces down the street --------- */
    cheekBoard(R, s0, -1, dB, dF, py0, panH, qd);
    cheekBoard(R, s1, 1, dB, dF, py0, panH, qd);

    /* --- the cornice, and the stair head that breaks the eaves line -------- */
    pr.tile(T_RENDER).tint(C.trim);
    rbox(pr, R, s0 - m(0.10), s1 + m(0.10), EAVES - m(0.18), EAVES + m(0.14),
         dF - m(0.04), dF + m(0.26), 0.04, 0.94);
    pr.tint(mulc(body, 0.98));
    rbox(pr, R, s0, s1, EAVES + m(0.14), TOWER_TOP, dB, dF, 0.06, 0.98);
    pr.tint(C.trim);
    sweepProfile(pr, R, s0 - m(0.07), s1 + m(0.07), TOWER_TOP - m(0.20), PROF.cope,
                 dF - m(0.20), 0.98);
    /* a small stair-head window, so the head is a room and not a lump */
    pg.tile(T_GLASS).tint(mulc(C.glassLo, 0.9));
    rquad(pg, R, sc - m(0.42), sc + m(0.42), TOWER_TOP - m(1.20), TOWER_TOP - m(0.44),
          dF + 0.02, 0.9);
    /* the coping weeps down the head, and the cornice down the tower face */
    streakRun(R, s0, s1, TOWER_TOP - m(0.24), m(1.8), dF + 0.09, R.seed * 4.17, true);
    streakRun(R, s0, s1, EAVES - m(0.20), m(3.2), dF + 0.09, R.seed * 6.29, true);
    for (i = 0; i < 4; i++) {
      var ds = lerp(s0 + 1, s1 - 1, (i + 0.5) / 4);
      var dy = lerp(py1 + 3, EAVES - 6, hash1(R.seed * 7.31 + i * 2.17));
      rdecal(R, ds, dy, m(0.9), m(1.3), (i & 1) ? D_FADE : D_SOOT, 1.0, dF + 0.10);
    }
    STATS.props++;
  }

  /* the two-line painted name, on a board that is real geometry.  hw/hh come
     from the atlas row's own ink extent, so the site name is as large as the
     tower will take and the block letter sits smaller under it -- ref1 exactly.
     Sized by the caller (entryTower), which needs the same numbers. */
  function nameBoard(R, py0, panW, A, B, s0, s1, dF) {
    var pr = PILES.render, ps = PILES.sign;
    var panH = A.h + B.h + m(0.34), py1 = py0 + panH;
    var sc = (s0 + s1) * 0.5;
    pr.tile(T_RENDER).tint(C.signBg);
    rbox(pr, R, sc - panW * 0.5, sc + panW * 0.5, py0, py1, dF, dF + 0.11, 0.03, 1);
    var yA = py1 - m(0.14) - A.h * 0.5, yB = py0 + m(0.14) + B.h * 0.5;
    ps.tint(mulc(C.signBg, 1.04));
    var Pa = PT(R, sc, dF + 0.13, yA);
    atlasQuad(ps, Pa[0], Pa[1], Pa[2], R.nx, 0, R.nz, R.tx, 0, R.tz, A.w * 0.5, A.h * 0.5,
              SIGN.rect[R.signTop], 1);
    var Pb = PT(R, sc, dF + 0.13, yB);
    atlasQuad(ps, Pb[0], Pb[1], Pb[2], R.nx, 0, R.nz, R.tx, 0, R.tz, B.w * 0.5, B.h * 0.5,
              SIGN.rect[R.signBot], 1);
    /* THE OXIDE RULE.  550 mm of the most saturated thing on the block, wrapped
       right round the tower -- front and both returns.  Once the letters have
       collapsed into the mip chain this is still an unbroken red line at
       first-floor level, and a red line is what ref1's canyon actually gives
       the eye at 25 m; the words are a bonus you collect at 10. */
    pr.tint(C.oxide);
    rbox(pr, R, s0 + m(0.05), s1 - m(0.05), py0 - m(0.70), py0 - m(0.14), dF, dF + 0.09, 0.02, 1);
    STATS.props++;
  }

  /* THE ONLY SURFACE ON THE WHOLE NORTH SIDE THAT SQUARES UP TO THE WEST END,
     and therefore the only one that can tell the arriving player where the door
     is.  The numbers are not a preference.  From (172, 6.4, 172) this return is
     seen 7-13 degrees off its OWN normal -- practically face on, where the
     facade behind it is at 83 -- but only the strip standing proud of the
     neighbouring cikma is ever unoccluded, and that strip is exactly
     BAY_E - BAY = 1.0 m: about 13 px at 65 units.  Thirteen pixels cannot carry
     a word.  They can carry a COLOUR, and in _ref/ref1 what carries the
     entrance IS a colour -- red lettering on the cikma at first-floor level,
     the loudest mark in the photograph and the thing the eye follows up the
     street.  So this is that mark, turned to face the player: a full
     first-floor panel of oxide red, a cream rule under it, and the block name
     in red on cream across the middle for anyone who walks close enough to
     read it.  It was a small cream board between two thin red rules, which at
     this size averaged out to a pale smudge on a pale wall; the field and the
     mark have swapped, because red on cream survives the mip chain and cream
     on cream does not.
     dir = -1 west-facing (the shot that matters), +1 east-facing. */
  function cheekBoard(R, s, dir, dB, dF, py0, panH, qd) {
    var pr = PILES.render, ps = PILES.sign;
    /* ONLY the part of the cheek in FRONT of the neighbouring cikma is ever
       seen from the ends of the street; everything from dB to BAY is behind a
       20 m wall.  So the panel occupies exactly that strip, minus the quoin. */
    var d0 = BAY + m(0.02), d1 = dF - (qd || m(0.20)) - m(0.06), avail = d1 - d0;
    if (avail < m(0.4)) return;
    /* the panel takes the WHOLE first-floor storey of the return, fy(1)=11.2 up
       to just under the second-floor slab, because at 65 units the return is
       5 px wide and the only dimension left to spend is height: 6.8 units of
       panel is 14 px, 8.4 is 17. */
    var y0 = py0 - m(0.62), y1 = py0 + panH + m(0.72);
    var sp = s + dir * 0.13;                       /* stand the panel proud */
    pr.tile(T_RENDER).tint(C.oxide);
    rcheek(pr, R, sp, y0, y1, d0, d1, dir, 1);
    /* the cream rule under it.  A saturated block sitting on a pale one is the
       rhythm the eye reads as signage rather than as painted wall, and unlike
       lettering it is still there at three pixels. */
    pr.tint(C.signBg);
    rcheek(pr, R, sp + dir * 0.02, y0 - m(0.42), y0, d0, d1, dir, 0.98);
    /* the returns of the panel onto the tower face, so it has a thickness */
    pr.tint(mulc(C.oxide, 0.74));
    rquad(pr, R, Math.min(s, sp), Math.max(s, sp), y0 - m(0.42), y1, d1, 0.88);
    var idx = R.signPlate;
    if (idx === undefined || !SIGN.rect[idx]) { STATS.props += 3; return; }
    var B = signSize(idx, SIGN_CAP * 0.95, avail * 0.92);
    if (B.h > (y1 - y0) * 0.36) B = signSize(idx, SIGN_CAP * 0.62, avail * 0.92);
    var Q = PT(R, sp + dir * 0.05, (d0 + d1) * 0.5, (y0 + y1) * 0.52);
    ps.tint(mulc(C.signBg, 1.06));
    atlasQuad(ps, Q[0], Q[1], Q[2], dir * R.tx, 0, dir * R.tz, -dir * R.nx, 0, -dir * R.nz,
              B.w * 0.5, B.h * 0.5, SIGN.rect[idx], 1);
    STATS.props += 4;
  }

  /* --- eaves: fascia, soffit, rafter ends, gutter -------------------------- */
  function eavesRun(R) {
    if (R.entryT) {
      eavesSpan(R, R.bs0, R.entryT.s0);
      eavesSpan(R, R.entryT.s1, R.bs1);
      return;
    }
    eavesSpan(R, R.bs0, R.bs1);
  }
  /* BD is the depth of the wall the eaves crown.  It was hardcoded to BAY,
     which is right for a cikma block and wrong for both heroes: B-BLOK is flat
     (BD = WALL_D) and A-BLOK's eaves are clad in the same siding as the wall
     with a brown gutter, not a white soffit and a galvanised one. */
  function eavesSpan(R, s0, s1) {
    if (s1 - s0 < 2) return;
    var pr = PILES.render, pm = PILES.metal;
    var BD = R.faceD === undefined ? BAY : R.faceD;
    var dF = BD + EAVE_OUT;
    var sid = R.kind === 'ablok';
    var sp = sid ? PILES.siding : pr;
    var gut = R.gutterTint || C.galv;
    /* soffit -- painted render, or the same boards as the wall */
    if (sid) sp.tile(T_SIDING).tint(mulc(C.sidCream, 0.90));
    else sp.tile(T_RENDER).tint(mulc(C.trim, 0.86));
    rdeck(sp, R, s0, s1, BD, dF, EAVES, false, 0.48);
    /* rafter ends, 800 mm centres */
    var step = m(0.80), n = Math.max(2, Math.floor((s1 - s0) / step)), i;
    if (!sid) {
      pr.tint(mulc(C.timber, 1.5));
      for (i = 0; i <= n; i++) {
        var rs = lerp(s0 + 0.3, s1 - 0.3, i / n);
        rbox(pr, R, rs - m(0.025), rs + m(0.025), EAVES - m(0.055), EAVES,
             BD + m(0.05), dF + m(0.02), 0, 0.72);
      }
    }
    /* fascia board + the first tile course sitting on it */
    pr.tile(T_RENDER).tint(sid ? C.sidTrim : C.trim);
    rbox(pr, R, s0, s1, EAVES - m(0.05), EAVES + m(0.30), dF - m(0.03), dF + m(0.02), 0.04, 0.94);
    PILES.roof.tile(T_ROOF).tint(WHITE);
    rbox(PILES.roof, R, s0, s1, EAVES + m(0.22), EAVES + m(0.52), BD - m(0.10), dF + m(0.06), 0.03, 1);
    /* half-round gutter, and its bracket rhythm */
    pm.tile(T_STEEL).tint(gut);
    var A = PT(R, s0, dF + m(0.06), EAVES + m(0.10)), B = PT(R, s1, dF + m(0.06), EAVES + m(0.10));
    tube(pm, A[0], A[1], A[2], B[0], B[1], B[2], m(0.075), 6, 0.92, true);
    for (i = 0; i <= n; i += 2) {
      var bs = lerp(s0 + 0.3, s1 - 0.3, i / n);
      rbox(pm, R, bs - m(0.015), bs + m(0.015), EAVES + m(0.02), EAVES + m(0.14),
           dF - m(0.02), dF + m(0.14), 0, 0.86);
    }
    /* the streak every gutter joint makes on the wall below.  A half-round
       gutter leaks at every bracket and every joint, and on a five-storey
       Turkish block that stain runs a full storey down the render. */
    streakRun(R, s0, s1, EAVES - m(0.15), m(3.4), BD + 0.09, R.seed * 8.11, true);
    for (i = 0; i < 4; i++) {
      var ds = lerp(s0 + 2, s1 - 2, (i + 0.5) / 4);
      if (hash1(R.seed * 5.3 + i * 2.9) < 0.55)
        rdecal(R, ds, EAVES - m(2.6), m(0.55), m(2.4), D_STREAK, 1.0, BD + 0.10);
    }
  }

  /* --- the block name, painted on a real fascia band ----------------------- */
  function signRun(R) {
    /* the entrance block's name lives on its tower, over the door, in two
       lines -- entryTower()/nameBoard() draw it and this must not draw it twice */
    if (R.entryT) return;
    /* the heroes carry PROUD LETTERS, not a painted board: see bblokRun() and
       ablokRun().  R.sign < 0 is the second piece of a two-piece block (NC),
       which must not repeat its neighbour's name three metres away. */
    if (R.kind !== 'generic' || R.sign < 0) return;
    if (!SIGN.mat || R.sign === undefined || !SIGN.rect[R.sign]) return;
    var pr = PILES.render, ps = PILES.sign;
    /* SIZED BY ITS LETTERS, not by an arbitrary fraction of the run.  A blind
       gable gets 340 mm capitals because it is seen from 40 m across the
       junction; everything else gets the street's standard 275 mm. */
    var lim = (R.bs1 - R.bs0) * (R.blind ? 0.86 : 0.62);
    var S = signSize(R.sign, R.blind ? m(0.34) : SIGN_CAP, lim);
    var bw = S.w, bh = S.h;
    var sc = R.blind ? (R.bs0 + R.bs1) * 0.5
                     : lerp(R.bs0, R.bs1, R.seed % 2 ? 0.30 : 0.68);
    sc = clamp(sc, R.bs0 + bw * 0.55, R.bs1 - bw * 0.55);
    var y0 = (R.blind ? fy(3) + m(1.20) : fy(1) + m(0.62)), y1 = y0 + bh;
    var proud = 0.10;
    /* the band is real geometry in the render pile, so it is the same material
       as the wall it is part of and reads as building, not sticker */
    pr.tile(T_RENDER).tint(mulc(R.body, 1.03));
    rbox(pr, R, sc - bw * 0.5, sc + bw * 0.5, y0, y1, BAY, BAY + proud, 0.03, 1);
    var P0 = PT(R, sc, BAY + proud + 0.012, (y0 + y1) * 0.5);
    ps.tint(mulc(R.body, 1.02));
    atlasQuad(ps, P0[0], P0[1], P0[2], R.nx, 0, R.nz, R.tx, 0, R.tz,
              bw * 0.5, bh * 0.5, SIGN.rect[R.sign], 1);
    STATS.props++;
  }

  /* --- wall-mounted services: gas riser, meters, downpipes, telecom -------- */
  function servicesRun(R) {
    var pm = PILES.metal, pj = PILES.joinery, i;
    var dW = WALL_D;
    var FD = R.faceD === undefined ? BAY : R.faceD;
    var PIPE = R.pipeTint || C.galv;

    /* the yellow gas riser and its meter cabinet -- on nearly every facade */
    var gs = R.entrance ? R.entrance.s + m(1.9) : lerp(R.gs0, R.gs1, 0.22);
    if (!inGap(R, gs, 1) && gs > R.gs0 + 1 && gs < R.gs1 - 1) {
      var d0 = hug(PLINTH_D + m(0.08));
      pm.tile(T_STEEL).tint(C.gasYel);
      var A = PT(R, gs, d0, m(0.30)), B = PT(R, gs, d0, SOF0 - m(0.20));
      tube(pm, A[0], A[1], A[2], B[0], B[1], B[2], m(0.028), 6, 0.94, true);
      /* the meter cabinet */
      rbox(pm, R, gs - m(0.26), gs + m(0.26), m(1.15), m(1.85), PLINTH_D, hug(PLINTH_D + m(0.13)), 0.04, 0.94);
      /* the horizontal run and the elbow into the wall */
      var A2 = PT(R, gs, d0, SOF0 - m(0.20)), B2 = PT(R, gs + m(1.6), d0, SOF0 - m(0.20));
      tube(pm, A2[0], A2[1], A2[2], B2[0], B2[1], B2[2], m(0.028), 6, 0.94, true);
      for (i = 0; i < 4; i++) {
        var cy = m(0.6) + i * m(2.3);
        if (cy > SOF0 - m(0.4)) break;
        rbox(pm, R, gs - m(0.05), gs + m(0.05), cy, cy + m(0.06), PLINTH_D, d0, 0, 0.9);
      }
      rdecal(R, gs, m(2.6), m(0.34), m(0.9), D_RUST, 1.0, PLINTH_D + 0.05);
      STATS.props++;
    }

    /* grey electricity meter boxes */
    var es = lerp(R.gs0, R.gs1, 0.62);
    if (!inGap(R, es, 1)) {
      pj.tile(T_PVC).tint(C.grey);
      rbox(pj, R, es - m(0.30), es + m(0.30), m(1.30), m(2.05), PLINTH_D, hug(PLINTH_D + m(0.12)), 0.03, 0.94);
      pj.tint(mulc(C.grey, 0.72));
      rbox(pj, R, es - m(0.24), es + m(0.24), m(1.38), m(1.72), hug(PLINTH_D + m(0.12)), hug(PLINTH_D + m(0.13)), 0, 0.9);
      STATS.props++;
    }

    /* a downpipe at each end of the run, full height */
    var spots = [R.gs0 + m(0.35), R.gs1 - m(0.35)];
    for (i = 0; i < spots.length; i++) {
      var ss2 = spots[i];
      if (inGap(R, ss2, 1)) continue;
      pm.tile(T_STEEL).tint(PIPE);
      var dp = hug(PLINTH_D + m(0.10));
      var P1 = PT(R, ss2, FD + m(0.10), EAVES + m(0.06));
      var P2 = PT(R, ss2, FD + m(0.10), Math.max(SOF1, m(3.4)) + m(0.4));
      tube(pm, P1[0], P1[1], P1[2], P2[0], P2[1], P2[2], m(0.048), 6, 0.92, false);
      var P3 = PT(R, ss2, dp, SOF0 - m(0.2)), P4 = PT(R, ss2, dp, m(0.10));
      tube(pm, P2[0], P2[1], P2[2], P3[0], P3[1], P3[2], m(0.048), 6, 0.92, false);
      tube(pm, P3[0], P3[1], P3[2], P4[0], P4[1], P4[2], m(0.048), 6, 0.92, true);
      /* a shoe at the bottom, brackets up the shaft */
      rbox(pm, R, ss2 - m(0.09), ss2 + m(0.09), m(0.02), m(0.20), dp - m(0.09), dp + m(0.16), 0.02, 0.9);
      for (var b = 0; b < 5; b++) {
        var by = m(1.2) + b * m(1.9);
        if (by > SOF0 - m(0.5)) break;
        rbox(pm, R, ss2 - m(0.07), ss2 + m(0.07), by, by + m(0.05), PLINTH_D, dp, 0, 0.88);
      }
      rdecal(R, ss2 + m(0.30), m(1.6), m(0.5), m(1.5), D_DRIP, 1.0, PLINTH_D + 0.06);
      STATS.props++;
    }

    /* stapled telecom cable across the render */
    var cs = lerp(R.gs0, R.gs1, 0.44);
    if (!inGap(R, cs, 1)) rdecal(R, cs, m(2.9), m(1.8), m(0.5), D_CABLE, 1.0, PLINTH_D + 0.05);
  }

  /* --- the grime and story pass ------------------------------------------- */
  function grimeRun(R) {
    var i, n;
    var FD = R.faceD === undefined ? BAY : R.faceD;
    /* Ground-line soiling, brief item 2, at 1.2 m spacing instead of 1.7 and
       covering the full 1.5 m the brief asks for rather than the plinth alone.
       The smooth part of this is the positional vertex field; these are the
       hard edges it cannot make -- splash specks, weeds, algae in the joint. */
    n = Math.max(6, Math.round((R.gs1 - R.gs0) / m(1.2)));
    for (i = 0; i < n; i++) {
      var s = lerp(R.gs0 + 0.8, R.gs1 - 0.8, (i + 0.5) / n);
      if (inGap(R, s, 1)) continue;
      rdecal(R, s, m(0.72), m(0.82), m(0.80), D_GROUND, 1.0, PLINTH_D + 0.05);
      var hgl = hash1(R.seed * 2.3 + i * 5.9);
      if (hgl < 0.42) rdecal(R, s + m(0.4), m(0.46), m(0.7), m(0.54), D_DAMP, 1.0, PLINTH_D + 0.06);
      else if (hgl < 0.66) rdecal(R, s - m(0.3), m(0.60), m(0.6), m(0.66), D_ALGAE, 1.0, PLINTH_D + 0.06);
      else if (hgl < 0.80) rdecal(R, s, m(1.45), m(0.7), m(0.32), D_CHIP, 1.0, PLINTH_D + 0.06);
      /* and the same band on the wall ABOVE the plinth, which is where the
         brief's 1.0-1.5 m actually lands on a render-plinth block */
      if (PLINTH_TOP < m(1.5) && hgl > 0.30)
        rdecal(R, s, PLINTH_TOP + m(0.30), m(0.75), m(0.34), D_GROUND, 1.0, WALL_D + 0.05);
    }
    /* algal green-black in the shaded corners */
    var cor = [R.gs0 + m(0.6), R.gs1 - m(0.6)];
    for (i = 0; i < cor.length; i++) {
      if (inGap(R, cor[i], 1)) continue;
      rdecal(R, cor[i], m(1.6), m(0.7), m(1.7), D_ALGAE, 1.0, PLINTH_D + 0.06);
      rdecal(R, cor[i], m(4.6), m(0.55), m(2.1), D_ALGAE, 1.0, WALL_D + 0.06);
      rdecal(R, cor[i], EAVES - m(3.0), m(0.8), m(2.4), D_CORNER, 1.0, FD + 0.10);
      rdecal(R, cor[i], fy(2) + m(1.0), m(0.7), m(2.6), D_CORNER, 1.0, FD + 0.10);
    }
    /* The ground storey between the plinth and the cikma soffit.  This band is
       what a standing player looks at for the whole 24 m, and until now it
       carried no decal at all -- the fade/spall/soot pass only ever ran on the
       bay face two storeys up.  CRITIC-STREET section 4 measured this exact
       band at sd 6.5. */
    n = Math.max(8, Math.round((R.gs1 - R.gs0) / m(0.95)));
    for (i = 0; i < n; i++) {
      var ws = lerp(R.gs0 + 0.6, R.gs1 - 0.6, (i + 0.5) / n);
      if (inGap(R, ws, PLINTH_TOP + 1)) continue;
      var hw2 = hash1(R.seed * 4.41 + i * 8.17);
      var wy2 = lerp(PLINTH_TOP + m(0.35), SOF0 - m(0.70), hash1(R.seed * 7.7 + i * 2.31));
      if (hw2 < 0.30) rdecal(R, ws, wy2, m(0.85), m(0.80), D_FADE, 1.0, WALL_D + 0.05);
      else if (hw2 < 0.50) rdecal(R, ws, wy2, m(0.60), m(0.75), D_SOOT, 1.0, WALL_D + 0.05);
      else if (hw2 < 0.66) rdecal(R, ws, wy2, m(0.34), m(0.90), D_STREAK, 1.0, WALL_D + 0.05);
      else if (hw2 < 0.78) rdecal(R, ws, wy2, m(0.40), m(0.55), D_ALGAE, 1.0, WALL_D + 0.05);
      else if (hw2 < 0.88) rdecal(R, ws, wy2, m(0.30), m(0.34), D_SPALL, 1.0, WALL_D + 0.05);
      else rdecal(R, ws, wy2, m(0.42), m(0.50), D_LIME, 1.0, WALL_D + 0.05);
    }
    /* patchy fading and the odd spall.  Twice the density of the first pass:
       the critic measured the wall's whole albedo spread at a fifth of the
       reference's, and this is half of what closes it. */
    n = Math.max(8, Math.round((R.bs1 - R.bs0) / m(1.6)));
    for (i = 0; i < n; i++) {
      var bs = lerp(R.bs0 + 1, R.bs1 - 1, (i + 0.5) / n);
      var h = hash1(R.seed * 6.7 + i * 3.13);
      var y = lerp(fy(1) + 2, EAVES - 4, hash1(R.seed * 8.9 + i * 1.7));
      if (h < 0.34) rdecal(R, bs, y, m(1.6), m(1.5), D_FADE, 1.0, FD + 0.10);
      else if (h < 0.48) rdecal(R, bs, y, m(0.5), m(0.6), D_SPALL, 1.0, FD + 0.10);
      else if (h < 0.66) rdecal(R, bs, y, m(1.0), m(1.4), D_SOOT, 1.0, FD + 0.10);
      else if (h < 0.78) rdecal(R, bs, y, m(0.6), m(0.9), D_LIME, 1.0, FD + 0.10);
      else if (h < 0.90) rdecal(R, bs, y, m(0.8), m(1.6), D_STREAK, 1.0, FD + 0.10);
    }
    /* a torn bill at eye height, once per block */
    if (hash1(R.seed * 9.1) < 0.55) {
      var ps = lerp(R.gs0, R.gs1, 0.36);
      if (!inGap(R, ps, 1)) rdecal(R, ps, m(1.7), m(0.42), m(0.58), D_BILL, 1.0, PLINTH_D + 0.07);
    }
  }

  /* =========================================================================
     9b.  SEYDIKENT B-BLOK  --  the salmon block, south side, _ref/ref7
     Everything below is measured off the plate rather than generated.  The
     three facts that make it that building and not a pink version of the
     generic one:
       1. IT IS FLAT.  No cikma.  The wall runs from plinth to eaves in one
          plane and the balconies are LOGGIAS cut back into the mass; only
          their slab noses stand proud, by about 40 mm.
       2. THE STACKS DIFFER.  One open with white railings at the corner, two
          glazed grey-blue in white PVC, one with heavy vertical mullions, one
          part-glazed with the dish on its pier.  A facade of identical
          balconies is the single loudest CG tell and the photograph does not
          have one.
       3. THE RUN-OFF IS THE SUBJECT.  Every sill, every slab nose and the
          whole parapet line weeps a grey fan.  On this block the streaks are
          not weathering laid over the design, they ARE half the value range.
     ====================================================================== */
  var BB_REC = m(1.15);                 /* 4.03  how far a loggia cuts back  */
  var BB_NOSE = m(0.14);                /* 0.49  the slab nose, proud        */
  var BB_UP = m(0.42);                  /* 1.47  the solid parapet up-stand  */
  var BB_PAR = m(0.98);                 /* 3.43  parapet / railing height    */

  function bblokCols(R) {
    var out = [], s = 0, i;
    for (i = 0; i < R.pat.length; i++) {
      out.push({ s0: s, s1: s + R.pat[i][0], kind: R.pat[i][1],
                 floors: R.pat[i][2] || null, i: i, w: R.pat[i][0] });
      s += R.pat[i][0];
    }
    return out;
  }

  /* one B-BLOK window: white PVC in a rendered reveal, a projecting cill and
     the fan of grey run-off under it that _ref/ref7 is really made of */
  function bbWindow(R, sc, hw, y0, y1, d, seed, ground) {
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass;
    var rev = ground ? REV_G : REV;
    var fd = d - rev, s0 = sc - hw, s1 = sc + hw, i;
    pr.tile(T_RENDER).tint(mulc(R.body, 0.64));
    rcheek(pr, R, s0, y0, y1, fd, d, 1, 0.50);
    rcheek(pr, R, s1, y0, y1, fd, d, -1, 0.50);
    pr.tint(mulc(R.body, 0.48));
    rdeck(pr, R, s0, s1, fd, d, y1, false, 0.38);
    pr.tint(mulc(R.body, 0.82));
    rdeck(pr, R, s0, s1, fd, d, y0, true, 0.86);
    /* the plate's sashes are a wide fixed light with a narrow opener each
       side, and a shallow top transom on the taller openings */
    var fw = m(0.07);
    pj.tile(T_PVC).tint(C.pvc);
    rbox(pj, R, s0, s1, y0, y0 + fw, fd, fd + m(0.07), 0, 0.92);
    rbox(pj, R, s0, s1, y1 - fw, y1, fd, fd + m(0.07), 0, 0.86);
    rbox(pj, R, s0, s0 + fw, y0, y1, fd, fd + m(0.07), 0, 0.92);
    rbox(pj, R, s1 - fw, s1, y0, y1, fd, fd + m(0.07), 0, 0.92);
    var q0 = lerp(s0, s1, 0.30), q1 = lerp(s0, s1, 0.70);
    var hasT = (y1 - y0) > m(1.55), ty = y1 - m(0.40);
    rbox(pj, R, q0 - fw * 0.5, q0 + fw * 0.5, y0, hasT ? ty : y1, fd, fd + m(0.07), 0, 0.90);
    rbox(pj, R, q1 - fw * 0.5, q1 + fw * 0.5, y0, hasT ? ty : y1, fd, fd + m(0.07), 0, 0.90);
    if (hasT) rbox(pj, R, s0, s1, ty - fw * 0.5, ty + fw * 0.5, fd, fd + m(0.07), 0, 0.88);
    var gd = fd + m(0.02), lanes = [[s0 + fw, q0], [q0, q1], [q1, s1 - fw]];
    var roomId = R.id + ':window:' + seed;
    var roomFloor = ground ? 0.50 : Math.max(0.50, y0 - m(0.92));
    for (i = 0; i < 3; i++) {
      var hp = hash1(seed * 9.13 + i * 4.7);
      var col = hp < 0.28 ? C.net : hp < 0.42 ? C.curtain : hp < 0.52 ? C.glassLo : C.glass;
      pg.tile(T_GLASS).tint(mulc(col, 0.86 + hp * 0.28));
      heroPane(pg, R, lanes[i][0], lanes[i][1], y0 + fw, hasT ? ty : y1 - fw, gd, 1,
        { room: roomId, seed: seed * 17 + i, floorY: roomFloor, depth: m(1.75), kind: 'flat' });
    }
    if (hasT) {
      pg.tint(mulc(C.glazing, 0.92));
      heroPane(pg, R, s0 + fw, s1 - fw, ty + fw * 0.5, y1 - fw, gd, 1,
        { room: roomId, seed: seed * 19 + 5, floorY: roomFloor, depth: m(1.75), kind: 'flat' });
    }
    /* the cill, its drip shadow, and the fan */
    pr.tile(T_RENDER).tint(C.trim);
    sweepProfile(pr, R, s0 - m(0.11), s1 + m(0.11), y0 - m(0.06), PROF.sill, d, 1);
    pr.tint(mulc(C.trim, 0.30));
    rdeck(pr, R, s0 - m(0.11), s1 + m(0.11), d + 0.02, d + 0.32, y0 - m(0.055), false, 0.30);
    streakRun(R, s0 - m(0.13), s1 + m(0.13), y0 - m(0.10),
              ground ? m(1.7) : m(3.2), d + 0.07, seed * 1.31, true);
    STATS.windows++;
  }

  /* one loggia storey.  kind decides how it is filled in; the shell is the
     same on all four stacks, because on the real building it is. */
  function bbLoggia(R, c, f, kind, seed) {
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal;
    var WF = WALL_D, RB = WALL_D - BB_REC;
    var yF = (f === 1) ? fy(1) : fy(f);
    var yT = (f === 4) ? EAVES - m(0.34) : fy(f + 1) - SLAB;
    var wb = fy(f) - SLAB, wt = (f === 4) ? EAVES : fy(f + 1) - SLAB;
    var s0 = c.s0 + m(0.32), s1 = c.s1 - m(0.32);
    var r1 = hash1(seed * 1.13), r2 = hash1(seed * 2.29), r3 = hash1(seed * 3.41);
    /* the piers each side, full wall depth */
    pr.tile(T_RENDER).tint(tintJitter(R, c.s0, yF, R.body, 0.05));
    punched(pr, R, WF, c.s0, s0, wb, wt, [], 1, null, CELL_W);
    punched(pr, R, WF, s1, c.s1, wb, wt, [], 1, null, CELL_W);
    /* the back wall of the loggia, in shade, with a door and a window */
    pr.tint(mulc(R.body, 0.88));
    var dw = m(0.88), dh = m(2.02), doorS = lerp(s0, s1, 0.30);
    var winS = lerp(s0, s1, 0.74), ww = m(0.50);
    var wy0 = yF + m(0.95), wy1 = wy0 + m(1.10);
    punched(pr, R, RB, s0, s1, yF, yT, [
      { s0: doorS - dw * 0.5, s1: doorS + dw * 0.5, y0: yF + 0.08, y1: yF + 0.08 + dh },
      { s0: winS - ww, s1: winS + ww, y0: wy0, y1: wy1 }
    ], 0.84, null, CELL_W);
    pj.tile(T_PVC).tint(C.pvc);
    rbox(pj, R, doorS - dw * 0.5, doorS + dw * 0.5, yF + 0.08, yF + 0.08 + dh,
         RB - m(0.06), RB, 0, 0.78);
    pg.tile(T_GLASS).tint(mulc(r3 < 0.5 ? C.net : C.curtain, 0.68));
    var backRoom = R.id + ':loggia-back:' + c.i + ':' + f;
    heroPane(pg, R, doorS - dw * 0.5 + m(0.07), doorS + dw * 0.5 - m(0.07),
          yF + 0.15, yF + 0.08 + dh - m(0.07), RB - m(0.03), 1,
          { room: backRoom, seed: seed * 13 + 1, floorY: yF, depth: m(1.45), kind: 'flat' });
    heroPane(pg, R, winS - ww + m(0.05), winS + ww - m(0.05), wy0 + m(0.05), wy1 - m(0.05),
          RB - m(0.03), 1,
          { room: backRoom, seed: seed * 13 + 2, floorY: yF, depth: m(1.45), kind: 'flat' });
    /* cheeks and the soffit of the slab above -- the darkest thing on the block */
    pr.tint(mulc(R.body, 0.80));
    rcheek(pr, R, s0, yF, yT, RB, WF, 1, 0.58);
    rcheek(pr, R, s1, yF, yT, RB, WF, -1, 0.58);
    pr.tint(mulc(R.body, 0.46));
    rdeck(pr, R, s0, s1, RB, WF, yT, false, 0.36);
    pr.tint(mulc(R.body, 0.34));
    rquad(pr, R, s0, s1, yT - 0.32, yT - 0.006, RB + 0.02, 0.32);
    /* the slab, its nose and the fan the nose makes */
    pr.tile(T_RENDER).tint(mulc(R.bodyB, 0.96));
    rbox(pr, R, s0, s1, yF - SLAB, yF, RB, WF + BB_NOSE, 0.04, 0.92);
    streakRun(R, s0, s1, yF - SLAB - 0.03, m(2.5), WF + BB_NOSE + 0.05, seed * 2.17, true);
    OCC.push(rbounds(R, s0, s1, yF - SLAB, yF + 0.2, RB, WF + BB_NOSE));
    /* the solid up-stand every one of them has */
    pr.tint(tintJitter(R, s0, yF, mulc(R.body, 0.99), 0.05));
    rbox(pr, R, s0, s1, yF, yF + BB_UP, WF - m(0.06), WF + BB_NOSE, 0.03, 0.94);
    rdeck(pr, R, s0, s1, WF - m(0.06), WF + BB_NOSE, yF + BB_UP, true, 0.90);

    /* Open/closed is survey data.  The earlier random exception could turn a
       photographed closed floor into an open one whenever a seed changed. */
    var open = (kind === 'open' || kind === 'openDish');
    if (open) {
      /* The original balcony steel is a faded rose-brown, not PVC white. */
      pm.tile(T_STEEL).tint(C.railRed);
      var ry0 = yF + BB_UP, ry1 = yF + BB_PAR;
      var A = PT(R, s0 + 0.2, WF + m(0.02), ry1), B = PT(R, s1 - 0.2, WF + m(0.02), ry1);
      tube(pm, A[0], A[1], A[2], B[0], B[1], B[2], m(0.030), 5, 0.94, true);
      var A2 = PT(R, s0 + 0.2, WF + m(0.02), ry0 + m(0.10));
      var B2 = PT(R, s1 - 0.2, WF + m(0.02), ry0 + m(0.10));
      tube(pm, A2[0], A2[1], A2[2], B2[0], B2[1], B2[2], m(0.022), 5, 0.94, true);
      var nb = Math.max(5, Math.round((s1 - s0) / m(0.16))), b;
      for (b = 0; b <= nb; b++) {
        var bs = lerp(s0 + 0.25, s1 - 0.25, b / nb);
        var U0 = PT(R, bs, WF + m(0.02), ry0), U1 = PT(R, bs, WF + m(0.02), ry1);
        tube(pm, U0[0], U0[1], U0[2], U1[0], U1[1], U1[2], m(0.012), 4, 0.94, false);
      }
    } else {
      /* glazed in.  np mullions, and the plate's grey-blue -- glass that is
         showing you a shaded loggia, not a sky reflection */
      var gy0 = yF + BB_UP, gy1 = yT - m(0.03);
      var heavy = (kind === 'mull');
      var np = clamp(Math.round((s1 - s0) / m(heavy ? 0.62 : 0.46)), 3, 7);
      var fw2 = m(heavy ? 0.085 : 0.055);
      var fd0 = WF - m(0.02), fd1 = WF + m(0.06), p;
      pj.tile(T_PVC).tint(r2 < 0.16 ? C.alu : C.pvcB);
      rbox(pj, R, s0, s1, gy0, gy0 + fw2, fd0, fd1, 0, 0.92);
      rbox(pj, R, s0, s1, gy1 - fw2, gy1, fd0, fd1, 0, 0.86);
      for (p = 0; p <= np; p++) {
        var ps = lerp(s0, s1, p / np);
        rbox(pj, R, ps - fw2 * 0.5, ps + fw2 * 0.5, gy0, gy1, fd0, fd1, 0, 0.92);
      }
      var ty2 = lerp(gy0, gy1, 0.68);
      var frontRoom = R.id + ':loggia-front:' + c.i + ':' + f;
      rbox(pj, R, s0, s1, ty2 - fw2 * 0.4, ty2 + fw2 * 0.4, fd0, fd1, 0, 0.88);
      for (p = 0; p < np; p++) {
        var pa = lerp(s0, s1, p / np) + fw2 * 0.5;
        var pb = lerp(s0, s1, (p + 1) / np) - fw2 * 0.5;
        var hp2 = hash1(seed * 7.19 + p * 11.3);
        var col2, k2;
        if (hp2 < 0.30) { col2 = C.glazeLo; k2 = 0.84 + hp2 * 0.30; }
        else if (hp2 < 0.52) { col2 = C.net; k2 = 0.80 + hp2 * 0.24; }
        else if (hp2 < 0.72) { col2 = C.glazing; k2 = 0.78 + hp2 * 0.22; }
        else if (hp2 < 0.88) { col2 = C.curtain; k2 = 0.84 + hp2 * 0.20; }
        else { col2 = C.glassLo; k2 = 1.0; }
        pg.tile(T_GLASS).tint(mulc(col2, k2));
        heroPane(pg, R, pa, pb, gy0 + fw2, ty2 - fw2 * 0.4, WF + m(0.035), 1,
          { room: frontRoom, seed: seed * 23 + p * 2, floorY: yF, depth: m(1.0), kind: 'balcony' });
        pg.tint(mulc(hp2 < 0.5 ? C.glazing : C.glazeLo, 0.86 + hp2 * 0.2));
        heroPane(pg, R, pa, pb, ty2 + fw2 * 0.4, gy1 - fw2, WF + m(0.035), 1,
          { room: frontRoom, seed: seed * 23 + p * 2 + 1, floorY: yF, depth: m(1.0), kind: 'balcony' });
      }
    }
    /* the up-stand weeps too */
    streakRun(R, s0, s1, yF + BB_UP - m(0.10), BB_UP * 0.90, WF + BB_NOSE + 0.06,
              seed * 4.03, true);
    if (kind === 'openDish')
      dish(R, c.s1 - m(0.20), yF + BB_PAR + m(0.30), WF + m(0.10), seed);
    if (r1 > 0.80 && open) {
      pj.tile(T_PVC).tint(mulc(r2 < 0.5 ? L(0x7a4a3e) : L(0x50564e), 1.0));
      rbox(pj, R, lerp(s0, s1, 0.18), lerp(s0, s1, 0.66), yF + BB_PAR - m(0.90),
           yF + BB_PAR + m(0.04), WF + m(0.03), WF + m(0.09), 0.02, 0.92);
    }
    STATS.balconies++;
  }

  /* The six photographed doors share one raised half-basement datum.  Keeping
     it here lets the wall punches and the stair geometry use exactly the same
     threshold instead of drawing a door over an unrelated ground window. */
  var HERO_PAVE_Y = 0.50;
  var HERO_STEPS = 7;
  var HERO_STEP_RISE = m(0.13);
  var HERO_STEP_TREAD = m(0.27);
  var HERO_LANDING_Y = HERO_PAVE_Y + HERO_STEPS * HERO_STEP_RISE;
  var HERO_DOOR_H = m(1.88);
  function heroEntryHit(R, sc, hw) {
    if (!R.entries) return false;
    for (var i = 0; i < R.entries.length; i++) {
      var e = R.entries[i];
      if (Math.abs(sc - e.s) < hw + e.w * 0.5 + m(0.16)) return true;
    }
    return false;
  }
  function addHeroDoorHoles(R, holes) {
    if (!R.entries) return;
    for (var i = 0; i < R.entries.length; i++) {
      var e = R.entries[i], hw = e.w * 0.5;
      holes.push({ s0: e.s - hw - m(0.04), s1: e.s + hw + m(0.04),
                   y0: HERO_LANDING_Y - m(0.03),
                   y1: HERO_LANDING_Y + HERO_DOOR_H + m(0.08) });
    }
  }

  function bblokRun(R) {
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal;
    var WF = WALL_D, cols = bblokCols(R), i, j, f, c;
    R.cols = cols;
    var GTOP = fy(1) - SLAB;            /* 10.45 -- the first-floor slab line */

    /* ---- the ground-storey openings ------------------------------------- */
    var holes = [], gwin = [], gver = [];
    for (i = 0; i < cols.length; i++) {
      c = cols[i];
      if (c.kind === 'entry') continue;
      /* The half-basement is a salmon wall with normal windows.  Treating
         every balcony stack as a ground-level glazed veranda made an almost
         continuous black undercroft, which the real block does not have. */
      var cc = (c.s0 + c.s1) * 0.5, hw = m(0.62);
      if (heroEntryHit(R, cc, hw)) continue;
      gwin.push({ sc: cc, hw: hw, y0: m(1.30), y1: m(1.30) + m(1.35) });
    }
    for (i = 0; i < gwin.length; i++)
      holes.push({ s0: gwin[i].sc - gwin[i].hw, s1: gwin[i].sc + gwin[i].hw,
                   y0: gwin[i].y0, y1: gwin[i].y1 });
    for (i = 0; i < gver.length; i++) holes.push(gver[i]);
    addHeroDoorHoles(R, holes);

    /* ---- the wall above the plinth --------------------------------------- */
    pr.tile(T_RENDER).tint(R.body).ramp(0, m(2.6), 0.84);
    var sp = spanGaps(R, R.gs0, R.gs1, PLINTH_TOP, GTOP);
    for (j = 0; j < sp.length; j++)
      punched(pr, R, WF, sp[j][0], sp[j][1], PLINTH_TOP, GTOP, holes, 1,
              function (s, y) { return tintJitter(R, s, y, R.body, 0.075); }, CELL_W * 0.62);
    pr.ramp(0, 0, 1);

    /* ---- the plinth: rendered, greyer, panelled, dirty at the bottom ----- */
    var panelW = m(2.4), lowY = PLINTH_TOP * 0.40;
    sp = spanGaps(R, R.gs0, R.gs1, 0, PLINTH_TOP);
    for (j = 0; j < sp.length; j++) {
      var pa = sp[j][0], pb = sp[j][1];
      var npn = Math.max(1, Math.round((pb - pa) / panelW)), pn;
      for (pn = 0; pn < npn; pn++) {
        var q0 = lerp(pa, pb, pn / npn), q1 = lerp(pa, pb, (pn + 1) / npn);
        var hp1 = hash1(R.seed * 21.7 + pn * 6.13);
        pr.tile(T_RENDER).tint(mulc(C.bblokP, 0.88 + hp1 * 0.24));
        punched(pr, R, PLINTH_D, q0, q1, lowY, PLINTH_TOP, holes, 1, null, CELL_W);
        pr.tint(mulc(C.bblokP, 0.74 + hp1 * 0.14));
        punched(pr, R, PLINTH_D, q0, q1, 0, lowY, holes, 1, null, CELL_W);
      }
      pr.tint(mulc(C.bblokP, 0.86));
      rdeck(pr, R, pa, pb, WF, PLINTH_D, PLINTH_TOP, true, 0.86);
      rcheek(pr, R, pa, 0, PLINTH_TOP, WF, PLINTH_D, -1, 0.88);
      rcheek(pr, R, pb, 0, PLINTH_TOP, WF, PLINTH_D, 1, 0.88);
      rdecal(R, (pa + pb) * 0.5, m(0.20), (pb - pa) * 0.5, m(0.28), D_GROUND, 1.0, PLINTH_D + 0.05);
    }

    /* ---- the ground windows and the glazed verandas ---------------------- */
    for (i = 0; i < gwin.length; i++)
      bbWindow(R, gwin[i].sc, gwin[i].hw, gwin[i].y0, gwin[i].y1, PLINTH_D,
               hash1(R.seed * 3.31 + i * 9.7), true);
    for (i = 0; i < gver.length; i++) {
      var v = gver[i], vd = WF - m(0.28), fw3 = m(0.06);
      pr.tile(T_RENDER).tint(mulc(R.body, 0.62));
      rcheek(pr, R, v.s0, v.y0, v.y1, vd, WF, 1, 0.52);
      rcheek(pr, R, v.s1, v.y0, v.y1, vd, WF, -1, 0.52);
      pr.tint(mulc(R.body, 0.46));
      rdeck(pr, R, v.s0, v.s1, vd, WF, v.y1, false, 0.36);
      pj.tile(T_PVC).tint(C.pvcB);
      rbox(pj, R, v.s0, v.s1, v.y0, v.y0 + m(0.55), vd, vd + m(0.07), 0, 0.90);
      rbox(pj, R, v.s0, v.s1, v.y1 - fw3, v.y1, vd, vd + m(0.07), 0, 0.86);
      var nv = clamp(Math.round((v.s1 - v.s0) / m(0.52)), 3, 7), p2;
      var verandaRoom = R.id + ':ground-veranda:' + i;
      for (p2 = 0; p2 <= nv; p2++) {
        var vs = lerp(v.s0, v.s1, p2 / nv);
        rbox(pj, R, vs - fw3 * 0.5, vs + fw3 * 0.5, v.y0, v.y1, vd, vd + m(0.07), 0, 0.92);
      }
      for (p2 = 0; p2 < nv; p2++) {
        var va = lerp(v.s0, v.s1, p2 / nv) + fw3 * 0.5;
        var vb = lerp(v.s0, v.s1, (p2 + 1) / nv) - fw3 * 0.5;
        var hv = hash1(R.seed * 5.7 + i * 3.1 + p2 * 8.3);
        pg.tile(T_GLASS).tint(mulc(hv < 0.34 ? C.net : hv < 0.62 ? C.glazeLo : C.curtain,
                                   0.80 + hv * 0.26));
        heroPane(pg, R, va, vb, v.y0 + m(0.55), v.y1 - fw3, vd + m(0.03), 1,
          { room: verandaRoom, seed: R.seed * 31 + i * 11 + p2,
            floorY: v.y0, depth: m(1.15), kind: 'balcony' });
      }
      STATS.windows++;
    }

    /* ---- floors 1 to 4 ---------------------------------------------------- */
    for (f = 1; f <= 4; f++) {
      var wb2 = fy(f) - SLAB, wt2 = (f === 4) ? EAVES : fy(f + 1) - SLAB;
      for (i = 0; i < cols.length; i++) {
        c = cols[i];
        var seed = R.seed * 101 + c.i * 37 + f * 13;
        var floorKind = c.floors ? c.floors[f - 1] : c.kind;
        if (floorKind === 'pair') {
          var cx = (c.s0 + c.s1) * 0.5, hw2 = m(0.68), gp2 = m(0.34);
          var wy0b = fy(f) + m(0.92), wy1b = wy0b + m(1.52);
          var wns = [cx - hw2 - gp2 * 0.5, cx + hw2 + gp2 * 0.5], k;
          var hls = [];
          for (k = 0; k < 2; k++)
            hls.push({ s0: wns[k] - hw2, s1: wns[k] + hw2, y0: wy0b, y1: wy1b });
          pr.tile(T_RENDER).tint(R.body);
          punched(pr, R, WF, c.s0, c.s1, wb2, wt2, hls, 1,
                  function (s, y) { return tintJitter(R, s, y, R.body, 0.075); }, CELL_W);
          for (k = 0; k < 2; k++)
            bbWindow(R, wns[k], hw2, wy0b, wy1b, WF, seed * 3.1 + k * 7.3, false);
        } else if (floorKind === 'entry') {
          var hls2 = [];
          var swc = (c.s0 + c.s1) * 0.5, shw = m(0.52);
          var sy0 = fy(f) + m(0.70), sy1 = fy(f) + m(2.30);
          hls2.push({ s0: swc - shw, s1: swc + shw, y0: sy0, y1: sy1 });
          if (f === 1) hls2.push({ s0: 36, s1: 40, y0: wb2 - 1, y1: GH });
          pr.tile(T_RENDER).tint(R.body);
          punched(pr, R, WF, c.s0, c.s1, f === 1 ? GH : wb2, wt2, hls2, 1,
                  function (s, y) { return tintJitter(R, s, y, R.body, 0.06); }, CELL_W);
          if (f === 1) {
            /* the head band over the door.  ENTRANCE owns everything below it. */
            pr.tint(mulc(R.bodyB, 0.94));
            rbox(pr, R, 35.4, 41.6, GH, GH + m(0.34), WF - 0.02, WF + m(0.34), 0.03, 0.92);
            streakRun(R, 35.4, 41.6, GH - 0.04, m(1.4), WF + m(0.36), R.seed * 6.1, true);
          }
          bbWindow(R, swc, shw, sy0, sy1, WF, seed * 2.7, false);
        } else {
          bbLoggia(R, c, f, floorKind, seed);
        }
      }
      /* the shallow floor band the plate carries at every slab line */
      pr.tile(T_RENDER).tint(mulc(R.bodyB, 0.93));
      var bsp = spanGaps(R, R.gs0, R.gs1, wb2, wb2 + 1);
      for (j = 0; j < bsp.length; j++) {
        rbox(pr, R, bsp[j][0], bsp[j][1], wb2 - m(0.06), wb2 + m(0.10),
             WF - 0.01, WF + m(0.07), 0.02, 0.94);
        streakRun(R, bsp[j][0], bsp[j][1], wb2 - m(0.08), m(1.8), WF + m(0.09),
                  R.seed * 3.7 + f, true);
      }
    }

    /* ---- THE NAME.  Two lines of proud red letters on the flat render,
       exactly where _ref/ref7 puts them and NOWHERE ELSE.

       WHERE THEY WERE.  Centred on s = 37 at y = fy(1) + 5.67 = 16.87 -- which
       is inside the entrance bay's stair window (s 36.2..39.8, y 13.65..19.25)
       and 0.16 units proud of its glass.  Measured on _shots/final3/n34.png
       they were an 18 x 5 px dark smear pasted across a lit window: illegible
       as a word and wrong as geometry.

       WHERE THE PHOTOGRAPH PUTS THEM.  On the BLANK SPANDREL -- the strip of
       plain render between the ground-storey head and the first-floor sills,
       which on this elevation is one continuous band from GTOP = 10.45 up to
       14.42 -- and left of centre, on the flat 'pair' column, with the shop
       and the entrance below and a pair of white sashes directly above.  That
       column (s 19..28, x 223..232) is the only bay on the whole block whose
       first floor is wall and not loggia, which is why the real building's
       sign is on its own equivalent of it.

       SIZED TO THE BAND, not to a constant: line A's cap is 265 mm and line B
       is 81 % of it, so the pair stands 3.23 units tall inside a 3.97-unit
       band with 0.37 clear top and bottom -- above the slab band at 10.24-10.80
       and below the sills at 14.42. */
    /* Centre the identity over the middle of the block's three real doors.
       That bay is deliberately a broad wall field in RUNS, giving both lines
       a clean salmon spandrel instead of an arbitrary far-end window bay. */
    var sL = (R.entries && R.entries[1]) ? R.entries[1].s : 88;
    var LW = m(4.5);
    letterLine(R, 0, sL, 13.35, m(0.265), LW, WF + m(0.055));
    letterLine(R, 2, sL - LW * 0.14, 11.60, m(0.215), LW * 0.66, WF + m(0.055));

    /* ---- the parapet line at the eaves, and the run-off down from it ------ */
    pr.tile(T_RENDER).tint(mulc(R.bodyB, 0.90));
    rbox(pr, R, R.gs0, R.gs1, EAVES - m(0.34), EAVES, WF - 0.01, WF + m(0.10), 0.02, 0.94);
    for (i = 0; i < 9; i++) {
      var ds = lerp(R.gs0 + 1.5, R.gs1 - 1.5, (i + 0.5) / 9);
      streakRun(R, ds - 2.0, ds + 2.0, EAVES - m(0.40), m(3.0 + 2.2 * hash1(R.seed * 5.1 + i)),
                WF + m(0.12), R.seed * 8.7 + i * 3.3, true);
    }
    /* The photographed stucco is softly sun-faded within its own salmon hue.
       Large grey/soot decals made this wall look patched with concrete.  Its
       low-strength vertex field and sill run-off now carry the weathering. */
    STATS.blocks++;
  }

  /* =========================================================================
     9c.  SEYDIKENT A-BLOK  --  the cream block, north side, _ref/ref6
     The cladding is the whole job.  Everything else on this elevation --
     the cikma, the glazed boxes, the porch -- exists on a hundred blocks in
     this town; the horizontal lap siding is what makes somebody who has seen
     the photograph say "that is the one with the boards".  So the siding runs
     over the wall, the cikma, the eaves soffit, the spandrels of the glass
     boxes and the entrance bay, and every vertical break between them is a
     white trim strip, because that is how the material is actually detailed.
     ====================================================================== */
  var AB_BOX = m(1.00);                 /* 3.5  the glass box, beyond the cikma */
  var AB_TRIM = m(0.14);                /* 0.49 the vertical trim strip         */

  function ablokCols(R) {
    var out = [], s = 0, i;
    for (i = 0; i < R.pat.length; i++) {
      out.push({ s0: s, s1: s + R.pat[i][0], kind: R.pat[i][1],
                 floors: R.pat[i][2] || null, i: i, w: R.pat[i][0] });
      s += R.pat[i][0];
    }
    return out;
  }

  /* a window in siding: no rendered reveal, a flat white surround, because a
     20 mm board cannot make a 300 mm jamb and the plate shows exactly that */
  function abWindow(R, sc, hw, y0, y1, d, seed, taupe, floorOverride) {
    var pj = PILES.joinery, pg = PILES.glass, ps = PILES.siding;
    var s0 = sc - hw, s1 = sc + hw, tw = m(0.13), fd = d - m(0.16), i;
    /* the trim surround, standing 20 mm proud of the boards */
    pj.tile(T_PVC).tint(C.sidTrim);
    rbox(pj, R, s0 - tw, s1 + tw, y1, y1 + tw, fd, d + m(0.03), 0, 0.92);
    rbox(pj, R, s0 - tw, s1 + tw, y0 - tw, y0, fd, d + m(0.05), 0, 0.90);
    rbox(pj, R, s0 - tw, s0, y0, y1, fd, d + m(0.03), 0, 0.92);
    rbox(pj, R, s1, s1 + tw, y0, y1, fd, d + m(0.03), 0, 0.92);
    /* the reveal behind the trim */
    ps.tile(T_SIDING).tint(mulc(taupe ? C.sidTaupeB : C.sidCreamB, 0.72));
    rcheek(ps, R, s0, y0, y1, fd, d, 1, 0.56);
    rcheek(ps, R, s1, y0, y1, fd, d, -1, 0.56);
    rdeck(ps, R, s0, s1, fd, d, y1, false, 0.42);
    /* the PVC casement: a fixed light and an opener, the plate's own division */
    var fw = m(0.065), mid = lerp(s0, s1, 0.46);
    pj.tint(C.pvc);
    rbox(pj, R, s0, s1, y0, y0 + fw, fd, fd + m(0.06), 0, 0.92);
    rbox(pj, R, s0, s1, y1 - fw, y1, fd, fd + m(0.06), 0, 0.86);
    rbox(pj, R, s0, s0 + fw, y0, y1, fd, fd + m(0.06), 0, 0.92);
    rbox(pj, R, s1 - fw, s1, y0, y1, fd, fd + m(0.06), 0, 0.92);
    rbox(pj, R, mid - fw * 0.55, mid + fw * 0.55, y0, y1, fd, fd + m(0.06), 0, 0.90);
    var hasT = (y1 - y0) > m(1.45), ty = y1 - m(0.38);
    if (hasT) rbox(pj, R, mid, s1, ty - fw * 0.5, ty + fw * 0.5, fd, fd + m(0.06), 0, 0.88);
    var lanes = [[s0 + fw, mid - fw * 0.55], [mid + fw * 0.55, s1 - fw]];
    var roomId = R.id + ':window:' + seed;
    var roomFloor = isFinite(floorOverride) ? floorOverride : Math.max(0.50, y0 - m(0.92));
    for (i = 0; i < 2; i++) {
      var hp = hash1(seed * 6.7 + i * 3.9);
      var col = hp < 0.26 ? C.net : hp < 0.40 ? C.curtain : hp < 0.52 ? C.glassLo : C.glass;
      pg.tile(T_GLASS).tint(mulc(col, 0.86 + hp * 0.26));
      heroPane(pg, R, lanes[i][0], lanes[i][1], y0 + fw,
            (hasT && i === 1) ? ty - fw * 0.5 : y1 - fw, fd + m(0.02), 1,
            { room: roomId, seed: seed * 17 + i, floorY: roomFloor,
              depth: m(1.75), kind: 'flat' });
    }
    if (hasT) {
      pg.tint(mulc(C.glazing, 0.90));
      heroPane(pg, R, mid + fw * 0.55, s1 - fw, ty + fw * 0.5, y1 - fw, fd + m(0.02), 1,
        { room: roomId, seed: seed * 19 + 5, floorY: roomFloor,
          depth: m(1.75), kind: 'flat' });
    }
    streakRun(R, s0 - tw, s1 + tw, y0 - tw - 0.02, m(1.5), d + m(0.09), seed * 1.7, false);
    STATS.windows++;
  }

  /* A-BLOK balcony stack on ONE street plane.  Open balconies cut back into
     the cream-sided mass; owner-enclosed balconies put their PVC/glass screen
     exactly on the same face as the ordinary windows.  Nothing cantilevers
     beyond that plane and the slab underside remains inside the recess. */
  function abFlatLoggia(R, c, f, kind, seed) {
    var ps = PILES.siding, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal;
    var FF = BAY, RB = FF - m(0.92);
    var yF = (f === 1) ? SOF1 : fy(f);
    var yT = (f === 4) ? EAVES - m(0.30) : fy(f + 1) - SLAB;
    var wb = (f === 1) ? SOF1 : fy(f) - SLAB;
    var wt = (f === 4) ? EAVES : fy(f + 1) - SLAB;
    var s0 = c.s0 + m(0.26), s1 = c.s1 - m(0.26), p;

    /* Full-depth cream piers preserve a single facade silhouette. */
    ps.tile(T_SIDING).tint(tintJitter(R, c.s0, wb, R.body, 0.05));
    punched(ps, R, FF, c.s0, s0, wb, wt, [], 1, null, CELL_W);
    punched(ps, R, FF, s1, c.s1, wb, wt, [], 1, null, CELL_W);
    /* Recess in the same siding family: shaded, but never a black void. */
    ps.tint(mulc(C.sidCreamB, 0.70));
    rquad(ps, R, s0, s1, yF, yT, RB, 0.68);
    ps.tint(mulc(C.sidCreamB, 0.78));
    rcheek(ps, R, s0, yF, yT, RB, FF, 1, 0.70);
    rcheek(ps, R, s1, yF, yT, RB, FF, -1, 0.70);
    ps.tint(mulc(C.sidCreamB, 0.58));
    rdeck(ps, R, s0, s1, RB, FF, yT, false, 0.58);
    /* A normal balcony door/window remains visible at the back. */
    abWindow(R, (s0 + s1) * 0.5, Math.min(m(0.62), (s1 - s0) * 0.30),
             yF + m(0.66), yT - m(0.38), RB, seed * 1.71, false, yF);

    /* Slab is contained behind the common facade plane. */
    ps.tile(T_SIDING).tint(mulc(C.sidCreamB, 0.88));
    rbox(ps, R, s0, s1, yF - SLAB, yF, RB, FF, 0.025, 0.86);
    OCC.push(rbounds(R, s0, s1, yF - SLAB, yF + 0.12, RB, FF));

    if (kind === 'open') {
      /* Open loggia: faded painted steel on the common line, depth behind it. */
      var ry0 = yF + m(0.42), ry1 = yF + m(1.02);
      pm.tile(T_STEEL).tint(C.railRed);
      var A = PT(R, s0 + m(0.08), FF - m(0.02), ry1);
      var B = PT(R, s1 - m(0.08), FF - m(0.02), ry1);
      tube(pm, A[0], A[1], A[2], B[0], B[1], B[2], m(0.028), 5, 0.94, true);
      var A2 = PT(R, s0 + m(0.08), FF - m(0.02), ry0);
      var B2 = PT(R, s1 - m(0.08), FF - m(0.02), ry0);
      tube(pm, A2[0], A2[1], A2[2], B2[0], B2[1], B2[2], m(0.018), 5, 0.92, true);
      var bars = Math.max(6, Math.round((s1 - s0) / m(0.17)));
      for (p = 0; p <= bars; p++) {
        var bs = lerp(s0 + m(0.10), s1 - m(0.10), p / bars);
        var U0 = PT(R, bs, FF - m(0.02), ry0);
        var U1 = PT(R, bs, FF - m(0.02), ry1);
        tube(pm, U0[0], U0[1], U0[2], U1[0], U1[1], U1[2], m(0.011), 4, 0.92, false);
      }
    } else {
      /* Glass-closed loggia: frame and glass finish FLUSH at FF. */
      var gy0 = yF + m(0.42), gy1 = yT - m(0.04);
      var np = clamp(Math.round((s1 - s0) / m(0.58)), 4, 7);
      var fw = m(0.060), fd0 = FF - m(0.055), fd1 = FF + m(0.005);
      pj.tile(T_PVC).tint(C.pvcB);
      rbox(pj, R, s0, s1, gy0, gy0 + fw, fd0, fd1, 0, 0.92);
      rbox(pj, R, s0, s1, gy1 - fw, gy1, fd0, fd1, 0, 0.88);
      for (p = 0; p <= np; p++) {
        var qs = lerp(s0, s1, p / np);
        rbox(pj, R, qs - fw * 0.5, qs + fw * 0.5, gy0, gy1, fd0, fd1, 0, 0.92);
      }
      var trans = lerp(gy0, gy1, 0.72);
      var frontRoom = R.id + ':loggia-front:' + c.i + ':' + f;
      rbox(pj, R, s0, s1, trans - fw * 0.4, trans + fw * 0.4, fd0, fd1, 0, 0.88);
      for (p = 0; p < np; p++) {
        var pa = lerp(s0, s1, p / np) + fw * 0.5;
        var pb = lerp(s0, s1, (p + 1) / np) - fw * 0.5;
        var hp = hash1(seed * 7.19 + p * 11.3);
        pg.tile(T_GLASS).tint(mulc(hp < 0.34 ? C.glazing : hp < 0.64 ? C.net : C.curtain,
                                   0.80 + hp * 0.22));
        heroPane(pg, R, pa, pb, gy0 + fw, trans - fw * 0.4, FF - m(0.025), 1,
          { room: frontRoom, seed: seed * 23 + p * 2, floorY: yF,
            depth: m(0.86), kind: 'balcony' });
        pg.tint(mulc(hp < 0.5 ? C.glazeLo : C.glass, 0.82 + hp * 0.18));
        heroPane(pg, R, pa, pb, trans + fw * 0.4, gy1 - fw, FF - m(0.025), 1,
          { room: frontRoom, seed: seed * 23 + p * 2 + 1, floorY: yF,
            depth: m(0.86), kind: 'balcony' });
      }
    }
    STATS.balconies++;
  }

  /* the projecting glazed balcony box -- _ref/ref1's big white glass boxes */
  function abBox(R, c, f, seed) {
    var ps = PILES.siding, pj = PILES.joinery, pg = PILES.glass;
    var d0 = BAY, d1 = BAY + AB_BOX;
    var yF = (f === 1) ? SOF1 : fy(f);
    var yT = (f === 4) ? EAVES - m(0.30) : fy(f + 1) - SLAB;
    var s0 = c.s0 + m(0.12), s1 = c.s1 - m(0.12);
    var r1 = hash1(seed * 1.9), p;
    /* the underside: a deck at the first floor, a slab nose above it */
    ps.tile(T_SIDING).tint(mulc(C.sidCreamB, 0.52));
    rdeck(ps, R, s0, s1, d0, d1, yF - (f === 1 ? 0 : SLAB), false, 0.36);
    if (f > 1) {
      ps.tint(mulc(C.sidCreamB, 0.94));
      rbox(ps, R, s0, s1, yF - SLAB, yF, d0, d1 + m(0.04), 0.03, 0.92);
      streakRun(R, s0, s1, yF - SLAB - 0.03, m(2.2), d1 + m(0.06), seed * 2.7, true);
    }
    OCC.push(rbounds(R, s0, s1, yF - SLAB - 0.1, yF + 0.2, d0, d1 + m(0.05)));
    /* the cheeks, clad in the same boards */
    ps.tint(mulc(C.sidCreamB, 0.84));
    rcheek(ps, R, s0, yF, yT, d0, d1, -1, 0.72);
    rcheek(ps, R, s1, yF, yT, d0, d1, 1, 0.74);
    /* the spandrel under the glass */
    var spY = yF + m(0.42);
    ps.tint(tintJitter(R, s0, yF, C.sidCream, 0.05));
    rquad(ps, R, s0, s1, yF, spY, d1, 0.92);
    /* the glazing: white PVC, four to six lights and a transom */
    var np = clamp(Math.round((s1 - s0) / m(0.66)), 3, 6);
    var fw = m(0.075), fd0 = d1 - m(0.07), fd1 = d1 + m(0.01);
    pj.tile(T_PVC).tint(r1 < 0.14 ? C.alu : C.pvcB);
    rbox(pj, R, s0, s1, spY, spY + fw, fd0, fd1, 0, 0.92);
    rbox(pj, R, s0, s1, yT - fw, yT, fd0, fd1, 0, 0.86);
    for (p = 0; p <= np; p++) {
      var qs = lerp(s0, s1, p / np);
      rbox(pj, R, qs - fw * 0.5, qs + fw * 0.5, spY, yT, fd0, fd1, 0, 0.92);
    }
    var ty = lerp(spY, yT, 0.74);
    var boxRoom = R.id + ':glass-box:' + c.i + ':' + f;
    rbox(pj, R, s0, s1, ty - fw * 0.4, ty + fw * 0.4, fd0, fd1, 0, 0.88);
    /* the returns are glazed too -- that is why they read as glass BOXES */
    rbox(pj, R, s0, s0 + fw, spY, yT, d0, d1, 0, 0.90);
    rbox(pj, R, s1 - fw, s1, spY, yT, d0, d1, 0, 0.90);
    for (p = 0; p < np; p++) {
      var pa = lerp(s0, s1, p / np) + fw * 0.5;
      var pb = lerp(s0, s1, (p + 1) / np) - fw * 0.5;
      var hp = hash1(seed * 7.19 + p * 11.3);
      var col, k2;
      if (hp < 0.34) { col = C.glazing; k2 = 0.86 + hp * 0.24; }
      else if (hp < 0.56) { col = C.glazeLo; k2 = 0.82 + hp * 0.28; }
      else if (hp < 0.74) { col = C.net; k2 = 0.84 + hp * 0.22; }
      else if (hp < 0.90) { col = C.curtain; k2 = 0.84 + hp * 0.22; }
      else { col = C.glassLo; k2 = 1.0; }
      pg.tile(T_GLASS).tint(mulc(col, k2));
      heroPane(pg, R, pa, pb, spY + fw, ty - fw * 0.4, d1 - m(0.03), 1,
        { room: boxRoom, seed: seed * 29 + p * 2, floorY: yF,
          depth: m(1.15), kind: 'balcony' });
      pg.tint(mulc(hp < 0.5 ? C.glazing : C.glazeLo, 0.88 + hp * 0.2));
      heroPane(pg, R, pa, pb, ty + fw * 0.4, yT - fw, d1 - m(0.03), 1,
        { room: boxRoom, seed: seed * 29 + p * 2 + 1, floorY: yF,
          depth: m(1.15), kind: 'balcony' });
    }
    /* the side lights */
    pg.tint(mulc(C.glazeLo, 0.80));
    rcheek(pg, R, s0 + fw, spY + fw, yT - fw, d0 + m(0.10), d1 - m(0.06), -1, 0.78);
    rcheek(pg, R, s1 - fw, spY + fw, yT - fw, d0 + m(0.10), d1 - m(0.06), 1, 0.78);
    STATS.balconies++;
  }

  /* the entrance porch replica: recessed (the pavement is only 2.3 m deep and
     Rule B forbids 2 m of steps standing on it), steps parallel to the facade
     rising west to east so the flight faces back up the street to the
     junction, a white balustrade at the mouth, a glazed door dressed shut, and
     the two lines of proud red letters above.  NOT enterable: the grid wall is
     still at z = 192 and the player is stopped by it. */
  function ablokPorch(R, P) {
    var ps = PILES.siding, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal, pr = PILES.render;
    var s0 = P.s0, s1 = P.s1, sd = P.sd;
    var BK = -m(1.30);                  /* -4.55 : z = 196.55 on the south run */
    var HD = 9.70;                      /* the porch head, clear of jumpTop    */
    var F0 = 0.50;                      /* the pavement                        */
    var RISE = 0.85, N = 3, LY = F0 + RISE * N;      /* 3.05 -- the landing    */
    var i;
    /* the reveal: three sides of the recess, clad in the taupe boards */
    ps.tile(T_SIDING).tint(mulc(C.sidTaupeB, 0.66));
    rcheek(ps, R, s0, F0 - 1, HD, BK, WALL_D, 1, 0.52);
    rcheek(ps, R, s1, F0 - 1, HD, BK, WALL_D, -1, 0.52);
    ps.tint(mulc(C.sidTaupeB, 0.44));
    rdeck(ps, R, s0, s1, BK, WALL_D, HD, false, 0.30);
    ps.tint(mulc(C.sidTaupeB, 0.60));
    punched(ps, R, BK, s0, s1, F0 - 1, HD, [
      { s0: sd - m(0.55), s1: sd + m(0.55), y0: LY, y1: LY + m(1.75) }
    ], 0.60, null, CELL_W);
    /* the landing and the flight.  Treads run along the facade. */
    pr.tile(T_RENDER).tint(mulc(C.trim, 0.86));
    rbox(pr, R, s0 - 0.1, sd + m(0.60), F0 - 1.2, LY, BK, WALL_D + 0.60, 0.04, 0.86);
    for (i = 0; i < N; i++) {
      var ta = sd + m(0.60) + i * (RISE * 1.32), tb = ta + RISE * 1.32 + 0.12;
      pr.tint(mulc(C.trim, 0.80 + 0.05 * (i & 1)));
      rbox(pr, R, ta, Math.min(tb, s1 + 0.1), F0 - 1.2, LY - (i + 1) * RISE,
           BK, WALL_D + 0.60, 0.03, 0.84);
    }
    /* the white balustrade across the mouth, hugging the plane (Rule B) */
    var bd = hug(WALL_D + m(0.16));
    pm.tile(T_STEEL).tint(C.white);
    for (i = 0; i <= 1; i++) {
      var ry = (i === 0) ? LY + m(0.98) : LY + m(0.10);
      var A = PT(R, s0 + 0.15, bd, ry), B = PT(R, sd + m(0.75), bd, ry);
      tube(pm, A[0], A[1], A[2], B[0], B[1], B[2], m(i === 0 ? 0.034 : 0.022), 5, 0.94, true);
      var A2 = PT(R, sd + m(0.75), bd, ry), B2 = PT(R, s1 - 0.15, bd, ry - RISE * N);
      tube(pm, A2[0], A2[1], A2[2], B2[0], B2[1], B2[2], m(i === 0 ? 0.034 : 0.022), 5, 0.94, true);
    }
    var nb = Math.max(8, Math.round((s1 - s0) / m(0.17))), b;
    for (b = 0; b <= nb; b++) {
      var bs = lerp(s0 + 0.2, s1 - 0.2, b / nb);
      var fl = bs <= sd + m(0.75) ? LY : LY - clamp((bs - sd - m(0.75)) / (RISE * 1.32), 0, N) * RISE;
      var U0 = PT(R, bs, bd, fl + m(0.02)), U1 = PT(R, bs, bd, fl + m(0.98));
      tube(pm, U0[0], U0[1], U0[2], U1[0], U1[1], U1[2], m(0.014), 4, 0.94, false);
    }
    /* the glazed entrance screen and its door, dressed shut */
    var scd = BK + m(0.10), fw = m(0.075);
    pj.tile(T_PVC).tint(C.pvcB);
    rbox(pj, R, sd - m(0.62), sd + m(0.62), LY, LY + m(1.86), scd, scd + m(0.08), 0, 0.88);
    rbox(pj, R, sd - m(0.55), sd + m(0.55), LY, LY + fw, scd + m(0.04), scd + m(0.10), 0, 0.90);
    rbox(pj, R, sd - m(0.55), sd + m(0.55), LY + m(1.75) - fw, LY + m(1.75),
         scd + m(0.04), scd + m(0.10), 0, 0.88);
    rbox(pj, R, sd - m(0.03), sd + m(0.03), LY, LY + m(1.75), scd + m(0.04), scd + m(0.10), 0, 0.90);
    pg.tile(T_GLASS).tint(mulc(C.glassLo, 0.72));
    heroPane(pg, R, sd - m(0.52), sd + m(0.52), LY + fw, LY + m(1.72), scd + m(0.07), 1,
      { room: R.id + ':porch-door', seed: R.seed * 43 + 7, floorY: LY,
        depth: m(1.25), kind: 'lobby' });
    pm.tile(T_STEEL).tint(C.alu);
    var H0 = PT(R, sd + m(0.16), scd + m(0.14), LY + m(1.00));
    var H1 = PT(R, sd + m(0.16), scd + m(0.14), LY + m(1.28));
    tube(pm, H0[0], H0[1], H0[2], H1[0], H1[1], H1[2], m(0.018), 5, 0.92, true);
    /* the canopy fascia over the mouth, and the lamp under it */
    pj.tile(T_PVC).tint(C.sidTrim);
    rbox(pj, R, s0 - m(0.18), s1 + m(0.18), HD, HD + m(0.46), WALL_D - 0.02, m(0.46), 0.03, 0.94);
    pr.tile(T_RENDER).tint(mulc(C.trim, 0.40));
    rdeck(pr, R, s0 - m(0.18), s1 + m(0.18), WALL_D, m(0.46), HD, false, 0.32);
    pm.tile(T_STEEL).tint(mulc(C.dark, 0.8));
    var L0 = PT(R, sd + m(0.95), WALL_D + m(0.10), HD - m(0.30));
    var L1 = PT(R, sd + m(0.95), WALL_D + m(0.10), HD - m(0.62));
    tube(pm, L0[0], L0[1], L0[2], L1[0], L1[1], L1[2], m(0.09), 6, 0.86, true);
    streakRun(R, s0 - m(0.18), s1 + m(0.18), HD - 0.05, m(1.2), m(0.50), R.seed * 11.3, true);
    STATS.props += 3;
  }

  function ablokRun(R) {
    var ps = PILES.siding, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal, pr = PILES.render;
    var cols = ablokCols(R), i, j, f, c;
    R.cols = cols;
    var P = R.porch;
    var AF = BAY, AP = BAY + m(0.08);       /* common facade / shallow plinth */

    /* ---- the ground storey: a painted base, then boards to the soffit ----- */
    var holes = [], gwin = [];
    for (i = 0; i < cols.length; i++) {
      c = cols[i];
      if (c.kind === 'porch') continue;
      var n2 = c.w > 10 ? 2 : 1, k;
      for (k = 0; k < n2; k++) {
        var sc2 = lerp(c.s0 + m(0.9), c.s1 - m(0.9), n2 === 1 ? 0.5 : (k + 0.5) / n2);
        var hw3 = m(0.62), y0b = m(1.35), y1b = y0b + m(1.28);
        if (inGap(R, sc2, 1) || heroEntryHit(R, sc2, hw3)) continue;
        gwin.push({ sc: sc2, hw: hw3, y0: y0b, y1: y1b });
        holes.push({ s0: sc2 - hw3, s1: sc2 + hw3, y0: y0b, y1: y1b });
      }
    }
    addHeroDoorHoles(R, holes);
    ps.tile(T_SIDING).tint(R.body).ramp(0, m(2.4), 0.86);
    var sp = spanGaps(R, R.gs0, R.gs1, PLINTH_TOP, SOF0);
    for (j = 0; j < sp.length; j++) {
      punched(ps, R, AF, sp[j][0], sp[j][1], PLINTH_TOP, SOF0, holes, 1,
              function (s, y) { return tintJitter(R, s, y, R.body, 0.055); }, CELL_W * 0.62);
      streakRun(R, sp[j][0], sp[j][1], SOF0 - 0.12, m(2.6), AF + 0.06, R.seed * 12.7 + j, true);
    }
    ps.ramp(0, 0, 1);
    /* the painted base course: siding never goes to the ground, it stops on a
       rendered plinth 400-500 mm up, and _ref/ref1 shows exactly that */
    sp = spanGaps(R, R.gs0, R.gs1, 0, PLINTH_TOP);
    for (j = 0; j < sp.length; j++) {
      var pa = sp[j][0], pb = sp[j][1];
      pr.tile(T_RENDER).tint(mulc(C.sidCreamB, 0.74));
      punched(pr, R, AP, pa, pb, m(0.55), PLINTH_TOP, holes, 1, null, CELL_W);
      pr.tint(mulc(C.sidCreamB, 0.56));
      punched(pr, R, AP, pa, pb, 0, m(0.55), holes, 1, null, CELL_W);
      pr.tint(mulc(C.sidCreamB, 0.80));
      rdeck(pr, R, pa, pb, AF, AP, PLINTH_TOP, true, 0.86);
      rcheek(pr, R, pa, 0, PLINTH_TOP, AF, AP, -1, 0.88);
      rcheek(pr, R, pb, 0, PLINTH_TOP, AF, AP, 1, 0.88);
      rdecal(R, (pa + pb) * 0.5, m(0.20), (pb - pa) * 0.5, m(0.26), D_GROUND, 1.0, AP + 0.05);
    }
    for (i = 0; i < gwin.length; i++)
      abWindow(R, gwin[i].sc, gwin[i].hw, gwin[i].y0, gwin[i].y1, AF,
               hash1(R.seed * 3.31 + i * 9.7), false);

    /* Flat continuation through the former cikma/soffit band.  This removes
       the continuous black underside and keeps the ground and upper storeys
       on one street plane. */
    ps.tile(T_SIDING).tint(mulc(R.body, 0.94));
    sp = spanGaps(R, R.bs0, R.bs1, SOF0, SOF1);
    for (j = 0; j < sp.length; j++) {
      var q0 = sp[j][0], q1 = sp[j][1];
      punched(ps, R, AF, q0, q1, SOF0, SOF1, holes, 0.90, null, CELL_W);
    }

    /* ---- floors 1 to 4 ---------------------------------------------------- */
    for (f = 1; f <= 4; f++) {
      var wb = (f === 1) ? SOF1 : fy(f) - SLAB;
      var wt = (f === 4) ? EAVES : fy(f + 1) - SLAB;
      for (i = 0; i < cols.length; i++) {
        c = cols[i];
        var seed = R.seed * 101 + c.i * 37 + f * 13;
        var floorKind = c.floors ? c.floors[f - 1] : c.kind;
        var taupe = (c.kind === 'porch');
        var tint = taupe ? C.sidTaupe : R.body;
        if (floorKind === 'open' || floorKind === 'glaze') {
          abFlatLoggia(R, c, f, floorKind, seed);
        } else {
          var wins = [], hls = [], k2;
          var n3 = c.w > 8.5 ? 2 : 1;
          var wy0 = fy(f) + m(0.86), wy1 = wy0 + m(1.42);
          /* THE NAME PANEL.  The porch bay's FIRST FLOOR carries the two lines
             of cut letters and nothing else -- in _ref/ref6 the taupe band over
             the porch is a blank field with SEYDIKENT across it, and a 2.3 m
             bay cannot hold a 2.7 m line of letters AND a 1.3 m casement.  It
             was holding both, and _shots/final3/s34.png shows the result: the
             capitals painted straight across the glass and the white surround
             of a lit window.  Floors 2-4 keep their sashes. */
          if (taupe && f === 1) n3 = 0;
          for (k2 = 0; k2 < n3; k2++) {
            var wsc = lerp(c.s0 + m(1.05), c.s1 - m(1.05), n3 === 1 ? 0.5 : (k2 + 0.5) / n3);
            wins.push(wsc);
            hls.push({ s0: wsc - m(0.66), s1: wsc + m(0.66), y0: wy0, y1: wy1 });
          }
          ps.tile(T_SIDING).tint(tint);
          punched(ps, R, BAY, c.s0, c.s1, wb, wt, hls, 1,
                  function (s, y) { return tintJitter(R, s, y, tint, 0.055); }, CELL_W);
          for (k2 = 0; k2 < wins.length; k2++)
            abWindow(R, wins[k2], m(0.66), wy0, wy1, BAY, seed * 3.1 + k2 * 7.3, taupe);
        }
      }
    }

    /* ---- the vertical trim strips, which is how siding is actually detailed */
    pj.tile(T_PVC).tint(C.sidTrim);
    for (i = 0; i <= cols.length; i++) {
      var ts = i === 0 ? R.bs0 : cols[i - 1].s1;
      if (i === cols.length) ts = R.bs1;
      var lo = ts - AB_TRIM * 0.5, hi = ts + AB_TRIM * 0.5;
      rbox(pj, R, lo, hi, SOF1, EAVES, BAY - 0.02, BAY + m(0.045), 0, 0.94);
      if (ts > R.gs0 + 0.5 && ts < R.gs1 - 0.5 && !inGap(R, ts, 3))
        rbox(pj, R, lo, hi, PLINTH_TOP, SOF0, AF - 0.02, AF + m(0.045), 0, 0.94);
    }

    /* ---- the porch ------------------------------------------------------- */
    if (P) {
      ablokPorch(R, P);
      /* the name, on the taupe boards above it.  In _ref/ref6 SEYDIKENT runs
         the full width of the bay and -A- BLOK sits smaller under its tail.
         Both lines now live on the blank first-floor panel (see the n3 = 0
         above), so they are sized to the BAY -- 0.265 m capitals, 7.7 units of
         line inside 8 units of taupe -- and pulled together to the 0.5-unit
         leading the photograph has rather than the 3.2 units they were flung
         apart by when the upper line was dodging a casement. */
      var LW = (P.s1 - P.s0) - m(0.10);
      letterLine(R, 0, (P.s0 + P.s1) * 0.5, fy(1) + m(1.60), m(0.265), LW, BAY + m(0.055));
      letterLine(R, 1, (P.s0 + P.s1) * 0.5 - LW * 0.14, fy(1) + m(1.05), m(0.215), LW * 0.66,
                 BAY + m(0.055));
    }

    /* ---- the brown gutter's downpipes, the loudest thing on the elevation - */
    var spots = [R.bs0 + m(0.30), P ? P.s0 - m(0.22) : R.gs1 * 0.5,
                 P ? P.s1 + m(0.22) : R.gs1 * 0.75, R.bs1 - m(0.30)];
    for (i = 0; i < spots.length; i++) {
      var xs = spots[i];
      if (!(xs > R.gs0 + 0.4 && xs < R.gs1 - 0.4)) continue;
      pm.tile(T_STEEL).tint(C.gutBrown);
      var dp = AF + m(0.08);
      var Q1 = PT(R, xs, BAY + m(0.13), EAVES + m(0.06));
      var Q2 = PT(R, xs, BAY + m(0.13), SOF1 + m(0.30));
      var Q3 = PT(R, xs, dp, SOF0 - m(0.25)), Q4 = PT(R, xs, dp, m(0.10));
      tube(pm, Q1[0], Q1[1], Q1[2], Q2[0], Q2[1], Q2[2], m(0.052), 6, 0.92, false);
      tube(pm, Q2[0], Q2[1], Q2[2], Q3[0], Q3[1], Q3[2], m(0.052), 6, 0.92, false);
      tube(pm, Q3[0], Q3[1], Q3[2], Q4[0], Q4[1], Q4[2], m(0.052), 6, 0.92, true);
      rbox(pm, R, xs - m(0.09), xs + m(0.09), m(0.02), m(0.20), dp - m(0.09), dp + m(0.16), 0.02, 0.9);
      rdecal(R, xs + m(0.30), m(1.6), m(0.5), m(1.5), D_DRIP, 1.0, AP + 0.06);
      STATS.props++;
    }
    /* and the brown corner strips at both ends of the block */
    pm.tile(T_STEEL).tint(C.gutBrown);
    rbox(pm, R, R.bs0 - m(0.05), R.bs0 + m(0.11), SOF1, EAVES + m(0.20), BAY - 0.03, BAY + m(0.07), 0, 0.92);
    rbox(pm, R, R.bs1 - m(0.11), R.bs1 + m(0.05), SOF1, EAVES + m(0.20), BAY - 0.03, BAY + m(0.07), 0, 0.92);
    STATS.blocks++;
  }

  /* Three raised residential entrances per Seydikent block.  The photographs
     show the same half-basement arrangement at all six doors: a recessed
     threshold, seven short risers, a landing and rose-brown steel handrails.
     These are visual-only; the playable threshold remains elsewhere. */
  function heroEntrances(R) {
    if (!R.entries || !R.entries.length) return;
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal;
    var FD = R.faceD, i, k;
    for (i = 0; i < R.entries.length; i++) {
      var e = R.entries[i], sc = e.s, hw = e.w * 0.5;
      var y0 = HERO_LANDING_Y, y1 = y0 + HERO_DOOR_H, frame = m(0.10);
      var RD = FD - m(0.24), DD = RD + m(0.025);
      var surround = mulc(R.kind === 'ablok' ? C.sidTaupeB : R.bodyB, 0.84);

      /* A real punched recess: dark back, rendered jamb returns, soffit and a
         worn landing.  The ground-storey builders cut this same rectangle. */
      pr.tile(T_RENDER).tint(mulc(C.dark, 0.34));
      rquad(pr, R, sc - hw, sc + hw, y0, y1, RD, 0.44);
      pr.tint(mulc(surround, 0.72));
      rcheek(pr, R, sc - hw, y0, y1, RD, FD, 1, 0.62);
      rcheek(pr, R, sc + hw, y0, y1, RD, FD, -1, 0.62);
      rdeck(pr, R, sc - hw, sc + hw, RD, FD, y1, false, 0.52);
      pr.tint(mulc(C.trim, 0.70));
      rbox(pr, R, sc - hw, sc + hw, y0 - m(0.08), y0, RD, FD + m(0.12), 0.02, 0.78);

      /* Narrow face surround; unlike the former single slab it leaves the
         opening and its depth legible from the road. */
      pr.tile(T_RENDER).tint(surround);
      rbox(pr, R, sc - hw - m(0.22), sc - hw, y0 - m(0.10), y1 + m(0.25),
           FD - m(0.03), FD + m(0.08), 0.02, 0.84);
      rbox(pr, R, sc + hw, sc + hw + m(0.22), y0 - m(0.10), y1 + m(0.25),
           FD - m(0.03), FD + m(0.08), 0.02, 0.84);
      rbox(pr, R, sc - hw - m(0.22), sc + hw + m(0.22), y1, y1 + m(0.25),
           FD - m(0.03), FD + m(0.08), 0.02, 0.84);

      pj.tile(T_PVC).tint(i === 1 ? C.pvc : C.alu);
      rbox(pj, R, sc - hw, sc + hw, y0, y0 + frame, DD, DD + m(0.06), 0, 0.90);
      rbox(pj, R, sc - hw, sc + hw, y1 - frame, y1, DD, DD + m(0.06), 0, 0.88);
      rbox(pj, R, sc - hw, sc - hw + frame, y0, y1, DD, DD + m(0.06), 0, 0.90);
      rbox(pj, R, sc + hw - frame, sc + hw, y0, y1, DD, DD + m(0.06), 0, 0.90);
      rbox(pj, R, sc - frame * 0.5, sc + frame * 0.5, y0, y1, DD, DD + m(0.06), 0, 0.90);
      var trans = y1 - m(0.42);
      rbox(pj, R, sc - hw, sc + hw, trans - frame * 0.45, trans + frame * 0.45,
           DD, DD + m(0.06), 0, 0.88);
      pg.tile(T_GLASS).tint(mulc(i === 1 ? C.glazeLo : C.glassLo, 0.72));
      var entryRoom = R.id + ':entry:' + i;
      heroPane(pg, R, sc - hw + frame, sc - frame * 0.55, y0 + frame, trans - frame * 0.45,
            DD + m(0.061), 0.80,
            { room: entryRoom, seed: R.seed * 47 + i * 7, floorY: y0,
              depth: m(1.35), kind: 'lobby' });
      heroPane(pg, R, sc + frame * 0.55, sc + hw - frame, y0 + frame, trans - frame * 0.45,
            DD + m(0.061), 0.80,
            { room: entryRoom, seed: R.seed * 47 + i * 7 + 1, floorY: y0,
              depth: m(1.35), kind: 'lobby' });
      heroPane(pg, R, sc - hw + frame, sc + hw - frame, trans + frame * 0.45, y1 - frame,
            DD + m(0.061), 0.82,
            { room: entryRoom, seed: R.seed * 47 + i * 7 + 2, floorY: y0,
              depth: m(1.35), kind: 'lobby' });

      /* Seven risers lead from the gate walk to the elevated landing. */
      var stairHW = hw + m(0.22), stairD0 = FD + m(0.12);
      for (k = 0; k < HERO_STEPS; k++) {
        var d0 = stairD0 + (HERO_STEPS - 1 - k) * HERO_STEP_TREAD;
        var d1 = d0 + HERO_STEP_TREAD;
        var ty = HERO_PAVE_Y + (k + 1) * HERO_STEP_RISE;
        pr.tile(T_RENDER).tint(mulc(C.trim, 0.70 + k * 0.025));
        rbox(pr, R, sc - stairHW, sc + stairHW, HERO_PAVE_Y - m(0.02), ty,
             d0, d1, 0.025, 0.84);
      }
      pr.tile(T_RENDER).tint(mulc(C.trim, 0.83));
      rbox(pr, R, sc - stairHW, sc + stairHW, y0 - m(0.12), y0,
           RD, stairD0 + HERO_STEP_TREAD, 0.02, 0.88);

      /* Sloping side rails and vertical standards track the actual treads. */
      pm.tile(T_STEEL).tint(C.railRed);
      var railH = m(0.86), dNear = stairD0;
      var dFar = stairD0 + HERO_STEPS * HERO_STEP_TREAD;
      for (var sideK = -1; sideK <= 1; sideK += 2) {
        var rs = sc + sideK * (stairHW - m(0.08));
        var A = PT(R, rs, dNear, y0 + railH);
        var B = PT(R, rs, dFar, HERO_PAVE_Y + HERO_STEP_RISE + railH);
        tube(pm, A[0], A[1], A[2], B[0], B[1], B[2], m(0.025), 5, 0.94, true);
        var A2 = PT(R, rs, dNear, y0 + railH - m(0.34));
        var B2 = PT(R, rs, dFar, HERO_PAVE_Y + HERO_STEP_RISE + railH - m(0.34));
        tube(pm, A2[0], A2[1], A2[2], B2[0], B2[1], B2[2], m(0.016), 5, 0.92, true);
        for (k = 0; k <= HERO_STEPS; k += 2) {
          var rf = k / HERO_STEPS, rd = lerp(dNear, dFar, rf);
          var sy = y0 - Math.min(k, HERO_STEPS - 1) * HERO_STEP_RISE;
          var rhy = lerp(y0 + railH, HERO_PAVE_Y + HERO_STEP_RISE + railH, rf);
          var U0 = PT(R, rs, rd, sy), U1 = PT(R, rs, rd, rhy);
          tube(pm, U0[0], U0[1], U0[2], U1[0], U1[1], U1[2], m(0.015), 4, 0.92, false);
        }
      }

      /* A shallow translucent hood, repeated consistently at all six doors. */
      pj.tile(T_PVC).tint(C.pvcB);
      rbox(pj, R, sc - hw - m(0.30), sc + hw + m(0.30), y1 + m(0.14), y1 + m(0.26),
           FD + m(0.04), FD + m(0.88), 0.025, 0.92);
      pm.tile(T_STEEL).tint(C.railRed);
      for (k = -1; k <= 1; k += 2) {
        var a = PT(R, sc + k * (hw + m(0.18)), FD + m(0.10), y1 + m(0.14));
        var b = PT(R, sc + k * (hw + m(0.18)), FD + m(0.82), y1 - m(0.18));
        tube(pm, a[0], a[1], a[2], b[0], b[1], b[2], m(0.025), 5, 0.92, true);
      }
      STATS.props += 2;
    }
    /* The block name belongs over the central entrance, not on a projecting
       tower.  Keep the photograph's two-line red lettering. */
    if (R.kind === 'ablok') {
      letterLine(R, 0, R.entries[1].s, fy(1) + m(1.55), m(0.265), m(4.5), FD + m(0.055));
      letterLine(R, 1, R.entries[1].s, fy(1) + m(1.00), m(0.215), m(2.7), FD + m(0.055));
    }
  }

  /* =========================================================================
     9d.  THE BRIDGE BAND
     The c 28 -> 52 mismatch across the junction throat drops a wall at z = 152
     from y = 28 to y = 52 over x 176..192.  It is the corner block spanning the
     side street and it has to read as that from BOTH sides: from the street it
     is the top two storeys of the block whose returns are NA and NC, and from
     the night alley it is the underside and back of a building bridging the
     road.  SKY measured its naked north face at lum 98; this replaces it.
     ====================================================================== */
  function bridgeBand() {
    var pr = PILES.render, pj = PILES.joinery, pg = PILES.glass, pm = PILES.metal;
    /* the band and the throat are the same opening seen from two sides, so the
       band's x extent falls back to the mouth's if SKY ever stops publishing
       BAND separately */
    var x0 = fin(BAND.x0, MOUTH.x0), x1 = fin(BAND.x1, MOUTH.x1), yS = fin(BAND.y0, 28);
    /* a synthetic run frame whose s IS world x and whose inward normal is +z */
    var F = { id: 'BAND', kind: 'generic', side: 'N', seed: 31, px: 0, pz: BAND.z,
              tx: 1, tz: 0, nx: 0, nz: 1, gaps: [], faceD: BAY,
              body: C.cream, bodyB: C.creamB, gs0: x0, gs1: x1, bs0: x0, bs1: x1 };
    var beamTop = fy(3);                            /* 31.5 -- a 1 m deep beam */
    var i, f, j;
    /* --- the soffit: what the side street drives under -------------------- */
    pr.tile(T_RENDER).tint(mulc(C.creamB, 0.42));
    rdeck(pr, F, x0, x1, -m(0.40), BAY, yS, false, 0.28);
    pr.tint(mulc(C.creamB, 0.34));
    rquad(pr, F, x0, x1, yS + 0.02, yS + 0.55, BAY - 0.02, 0.30);
    /* the steel channel lintel every one of these has, and its rust */
    pm.tile(T_STEEL).tint(mulc(C.lead, 0.88));
    rbox(pm, F, x0, x1, yS, yS + m(0.16), BAY - m(0.10), BAY + m(0.02), 0, 0.86);
    for (i = 0; i < 4; i++)
      rdecal(F, lerp(x0 + 1.5, x1 - 1.5, (i + 0.5) / 4), yS + m(1.1), m(0.7), m(1.0),
             D_RUST, 1.0, BAY + 0.07);
    /* --- the deep beam, then two storeys of wall over it ------------------ */
    pr.tile(T_RENDER).tint(mulc(C.creamB, 0.90));
    rbox(pr, F, x0, x1, yS, beamTop, BAY - m(0.06), BAY + m(0.10), 0.05, 0.92);
    streakRun(F, x0, x1, yS + m(0.05), m(2.0), BAY + m(0.12), 91.7, true);
    var holes = [], wins = [];
    for (f = 3; f <= 4; f++) {
      var wy0 = fy(f) + m(0.95), wy1 = wy0 + m(1.48);
      for (i = 0; i < 4; i++) {
        var wsc = lerp(x0 + 2.4, x1 - 2.4, (i + 0.5) / 4);
        wins.push({ sc: wsc, y0: wy0, y1: wy1, seed: 61 + f * 7 + i * 3 });
        holes.push({ s0: wsc - m(0.62), s1: wsc + m(0.62), y0: wy0, y1: wy1 });
      }
    }
    pr.tint(C.cream);
    punched(pr, F, BAY, x0, x1, beamTop, EAVES, holes, 1,
            function (s, y) { return tintJitter(F, s, y, C.cream, 0.06); }, CELL_W);
    for (i = 0; i < wins.length; i++)
      makeWindow(F, wins[i].sc, m(0.62), wins[i].y0, wins[i].y1, BAY, wins[i].seed, false);
    STATS.windows += wins.length;
    /* the two cheeks where the band meets its own returns */
    pr.tint(mulc(C.creamB, 0.84));
    rcheek(pr, F, x0, yS, EAVES, WALL_D, BAY, -1, 0.74);
    rcheek(pr, F, x1, yS, EAVES, WALL_D, BAY, 1, 0.74);
    eavesSpan(F, x0 + 0.3, x1 - 0.3);

    /* --- THE ALLEY SIDE.  A north elevation in permanent shade: a darker
       render, a soffit lip, four small unlit windows and a fascia, so the mass
       reads as a building and not as a lit card floating over the throat. --- */
    var NF = { id: 'BANDN', kind: 'generic', side: 'S', seed: 33, px: 0, pz: BAND.z,
               tx: 1, tz: 0, nx: 0, nz: -1, gaps: [], faceD: 0.10,
               body: mulc(C.creamB, 0.52), gs0: x0, gs1: x1, bs0: x0, bs1: x1 };
    var nh = [], nw = [];
    for (f = 3; f <= 4; f++) {
      var ny0 = fy(f) + m(1.05), ny1 = ny0 + m(1.15);
      for (i = 0; i < 3; i++) {
        var nsc = lerp(x0 + 3.0, x1 - 3.0, (i + 0.5) / 3);
        nw.push({ sc: nsc, y0: ny0, y1: ny1 });
        nh.push({ s0: nsc - m(0.45), s1: nsc + m(0.45), y0: ny0, y1: ny1 });
      }
    }
    pr.tile(T_RENDER).tint(mulc(C.creamB, 0.46));
    punched(pr, NF, 0.10, x0, x1, yS, EAVES, nh, 0.80,
            function (s, y) { return tintJitter(NF, s, y, mulc(C.creamB, 0.46), 0.07); }, CELL_W);
    pg.tile(T_GLASS).tint(mulc(C.glassLo, 0.52));
    for (i = 0; i < nw.length; i++) {
      rquad(pg, NF, nw[i].sc - m(0.42), nw[i].sc + m(0.42), nw[i].y0 + 0.1, nw[i].y1 - 0.1, 0.02, 0.8);
      pr.tile(T_RENDER).tint(mulc(C.trim, 0.44));
      rdeck(pr, NF, nw[i].sc - m(0.50), nw[i].sc + m(0.50), 0.10, m(0.24), nw[i].y0 - m(0.06), true, 0.66);
    }
    /* the soffit lip and the fascia, so it has a bottom and a top from below */
    pr.tint(mulc(C.creamB, 0.34));
    rdeck(pr, NF, x0, x1, 0.10, m(0.42), yS, false, 0.26);
    rquad(pr, NF, x0, x1, yS, yS + m(0.30), m(0.42), 0.40);
    pr.tint(mulc(C.creamB, 0.50));
    rbox(pr, NF, x0, x1, EAVES - m(0.16), EAVES + m(0.34), 0.06, m(0.44), 0.03, 0.60);
    /* and the two ends of the mass, so it is a box and not a pair of planes */
    pr.tint(mulc(C.creamB, 0.40));
    rcheek(pr, NF, x0, yS, EAVES + m(0.34), -BAY, m(0.42), -1, 0.48);
    rcheek(pr, NF, x1, yS, EAVES + m(0.34), -BAY, m(0.42), 1, 0.48);
    OCCC.push({ x0: x0, x1: x1, y0: yS - 0.4, y1: EAVES, z0: BAND.z - 1.2, z1: BAND.z + BAY });
    STATS.props += 4;
  }

  function buildRun(R) {
    R.entryT = entrySpan(R);
    /* Switch the positional grime field on for every surface that is painted
       render or clad stone.  It is a per-vertex multiplier, so it costs nothing
       at draw time and, being world-space, it is the one part of the story that
       provably cannot tile.  Joinery and metal get a weaker one: PVC yellows
       and a downpipe collects the same road film, just less of it. */
    /* the depth of the wall this run actually presents to the street.  It is
       the cikma face on every block but SEYDIKENT B-BLOK, which is flat -- and
       the grime, the services and the eaves all hang off it. */
    R.faceD = (R.kind === 'bblok') ? WALL_D : BAY;
    if (R.kind === 'ablok') { R.pipeTint = C.gutBrown; R.gutterTint = C.gutBrown; }

    /* The survey buildings are comparatively clean: A's vinyl has only road
       film and B's stucco fades within the salmon hue.  The full generic field
       plus grimeRun produced the conspicuous grey blotches in the old view. */
    var heroStrength = R.kind === 'ablok' ? 0.16 : R.kind === 'bblok' ? 0.28 : 1.0;
    var wf = grimeField(R.seed * 17 + 3, 0, heroStrength);
    var lf = grimeField(R.seed * 17 + 3, 0,
                        (R.kind === 'ablok' || R.kind === 'bblok') ? 0.12 : 0.45);
    PILES.render.field(wf); PILES.stone.field(wf); PILES.brick.field(wf);
    PILES.siding.field(wf);
    PILES.joinery.field(lf); PILES.metal.field(lf);

    if (R.kind === 'bblok') bblokRun(R);
    else if (R.kind === 'ablok') ablokRun(R);
    else { groundStorey(R); soffitBand(R); upperStoreys(R); }
    if (R.kind === 'bblok' || R.kind === 'ablok') heroEntrances(R);
    eavesRun(R);
    signRun(R);
    if (R.kind !== 'ablok') servicesRun(R);      /* A-BLOK runs its own, in brown */
    if (R.kind !== 'ablok' && R.kind !== 'bblok') grimeRun(R);

    PILES.render.field(null); PILES.stone.field(null); PILES.brick.field(null);
    PILES.siding.field(null);
    PILES.joinery.field(null); PILES.metal.field(null);
    /* occluders for NZ.street.bake: the cikma mass, the block behind the wall
       plane, and the eaves.  Kept coarse on purpose -- the bake is O(verts x
       rays x boxes) and eighteen boxes is already ~1M ray-box tests. */
    var FD = R.faceD;
    if (R.kind === 'bblok') {
      /* flat front: the only coarse masses are the block behind it and the
         eaves, plus the loggia stacks, which arrive one slab at a time in OCC */
      OCCC.push(rbounds(R, R.gs0, R.gs1, 0, EAVES + 12, -60, WALL_D - 0.05));
      OCCC.push(rbounds(R, R.gs0, R.gs1, EAVES + 0.1, EAVES + m(0.45), WALL_D,
                        WALL_D + EAVE_OUT + 0.3));
    } else {
      OCCC.push(rbounds(R, R.bs0, R.bs1, SOF1, EAVES, FD - BALC - 0.2, FD - m(0.30)));
      OCCC.push(rbounds(R, R.gs0, R.gs1, 0, EAVES + 12, -60, WALL_D - 0.05));
      OCCC.push(rbounds(R, R.bs0, R.bs1, EAVES + 0.1, EAVES + m(0.45), FD, FD + EAVE_OUT + 0.3));
      OCCC.push(rbounds(R, R.gs0, R.gs1, SOF1 - 0.1, SOF1 + m(1.2), WALL_D, FD + EAVE_OUT * 0.4));
    }
    if (R.kind === 'ablok' && R.porch)
      OCCC.push(rbounds(R, R.porch.s0 - 0.4, R.porch.s1 + 0.4, 9.4, 11.0, WALL_D, m(0.50)));
    /* the entrance tower is 0.55 m in front of the cikma and 1.75 m above the
       eaves: it shades its own returns, the wall either side of it and the
       porch under it, and none of that happens unless bake() is told */
    if (R.entryT)
      OCCC.push(rbounds(R, R.entryT.s0, R.entryT.s1, SOF1 - 0.1, TOWER_TOP,
                        BAY - BALC, BAY_E));
    STATS.blocks++;
  }

  /* =========================================================================
     10.  ROOFS -- above c = 52 everything is open sky and nothing is occluded
     The north block's roof mass at z < 156 is REQUIRED by the sky module: it
     closes the two holes it currently papers over with fade strips, above the
     alley mouth (x 176..188) and above the entrance recess (x 240..244).
     ====================================================================== */
  var ROOFS = [];
  function hipRoof(x0, x1, z0, z1, eaveY, ridgeY, alongX) {
    var pr = PILES.roof;
    pr.tile(T_ROOF).tint(WHITE);
    var mx = (x0 + x1) * 0.5, mz = (z0 + z1) * 0.5;
    var ref = [mx, eaveY - 6, mz];
    var A = [x0, eaveY, z0], B = [x1, eaveY, z0], Cc = [x1, eaveY, z1], D = [x0, eaveY, z1];
    var R0, R1, inset;
    if (alongX) {
      inset = Math.min((x1 - x0) * 0.28, (z1 - z0) * 0.5);
      R0 = [x0 + inset, ridgeY, mz]; R1 = [x1 - inset, ridgeY, mz];
      poly(pr, [A, B, R1, R0], ref[0], ref[1], ref[2], 1);
      poly(pr, [D, R0, R1, Cc], ref[0], ref[1], ref[2], 1);
      poly(pr, [B, Cc, R1], ref[0], ref[1], ref[2], 0.94);
      poly(pr, [D, A, R0], ref[0], ref[1], ref[2], 0.94);
    } else {
      inset = Math.min((z1 - z0) * 0.28, (x1 - x0) * 0.5);
      R0 = [mx, ridgeY, z0 + inset]; R1 = [mx, ridgeY, z1 - inset];
      poly(pr, [A, R0, R1, D], ref[0], ref[1], ref[2], 1);
      poly(pr, [B, Cc, R1, R0], ref[0], ref[1], ref[2], 1);
      poly(pr, [A, B, R0], ref[0], ref[1], ref[2], 0.94);
      poly(pr, [D, R1, Cc], ref[0], ref[1], ref[2], 0.94);
    }
    /* THE EAVES BOX.  Two jobs, both of them reported defects.
       (a) CRITIC-STREET section 10 / the fix brief: daylight leaks into the
           night alley as a hard-edged quad, lum 124.7 against a 72.3 night
           wall.  The roof mass IS built at z < 156 -- but its underside sits at
           eaveY - 0.02 = 53.04 while the world's north wall stops at c = 52, so
           a 1-unit slot runs the whole length of the street at the top of that
           wall and the canyon's daylight sky quad shines straight through it.
           A fascia band from 51.30 up to the eaves closes it: with the
           underside as the ceiling and this as the walls, the roof void is a
           sealed box and no ray from the night half can reach the day half.
       (b) The fix brief: "no soffit ... give it a closed underside and an
           eaves/fascia that reads from below."  This is that fascia, and it
           runs the whole perimeter, including over the alley mouth and the
           entrance where the facade's own eaves run stops. */
    var FASC = 51.30;
    PILES.render.tile(T_RENDER).tint(mulc(C.dark, 0.72));
    poly(PILES.render, [[x0, eaveY - 0.02, z0], [x1, eaveY - 0.02, z0],
                        [x1, eaveY - 0.02, z1], [x0, eaveY - 0.02, z1]],
         mx, eaveY + 4, mz, 0.42);
    PILES.render.tint(mulc(C.trim, 0.80));
    box6(PILES.render, x0, x1, FASC, eaveY, z0 - 0.001, z0 + 0.06, 0.90);
    box6(PILES.render, x0, x1, FASC, eaveY, z1 - 0.06, z1 + 0.001, 0.90);
    box6(PILES.render, x0 - 0.001, x0 + 0.06, FASC, eaveY, z0, z1, 0.86);
    box6(PILES.render, x1 - 0.06, x1 + 0.001, FASC, eaveY, z0, z1, 0.86);
    /* the ridge roll */
    PILES.roof.tint(mulc(C.tile, 1.05));
    tube(PILES.roof, R0[0], R0[1] + m(0.06), R0[2], R1[0], R1[1] + m(0.06), R1[2],
         m(0.10), 6, 1, true);
    /* which edge faces the canyon, and which way is "into the roof" from it */
    var street = alongX ? (mz > 172 ? z0 : z1) : (mx > 210 ? x0 : x1);
    var inward = alongX ? (mz > 172 ? 1 : -1) : (mx > 210 ? 1 : -1);
    var rf = { x0: x0, x1: x1, z0: z0, z1: z1, eaveY: eaveY, ridgeY: ridgeY,
               alongX: alongX, inset: inset, mx: mx, mz: mz,
               street: street, inward: inward };
    ROOFS.push(rf);
    return rf;
  }
  function roofY(rf, x, z) {
    var t;
    if (rf.alongX) {
      var half = (rf.z1 - rf.z0) * 0.5;
      t = 1 - Math.abs(z - rf.mz) / half;
    } else {
      var hx = (rf.x1 - rf.x0) * 0.5;
      t = 1 - Math.abs(x - rf.mx) / hx;
    }
    return rf.eaveY + (rf.ridgeY - rf.eaveY) * clamp(t, 0, 1);
  }

  /* white polyethylene tanks, solar thermal, chimney stacks, aerials, dishes */
  function roofClutter(rf, seed) {
    var pm = PILES.metal, pr = PILES.render, i;
    var n = Math.max(2, Math.round(6 * DENSITY));
    for (i = 0; i < n; i++) {
      var h1 = hash1(seed + i * 3.71), h2 = hash1(seed + i * 7.13), h3 = hash1(seed + i * 11.9);
      var x, z;
      if (rf.alongX) {
        x = lerp(rf.x0 + 5, rf.x1 - 5, h1);
        z = rf.street + rf.inward * (3 + h2 * 12);
      } else {
        z = lerp(rf.z0 + 5, rf.z1 - 5, h1);
        x = rf.street + rf.inward * (3 + h2 * 12);
      }
      var y = roofY(rf, x, z);
      if (h3 < 0.42) {
        /* a white water tank on a low stand */
        pm.tile(T_STEEL).tint(C.lead);
        tube(pm, x, y, z, x, y + m(0.35), z, m(0.30), 6, 0.9, false);
        pr.tile(T_RENDER).tint(C.tank);
        var tr = m(0.55 + h1 * 0.18), th = m(1.35 + h2 * 0.35);
        tube(pr, x, y + m(0.32), z, x, y + m(0.32) + th, z, tr, 10, 1, true);
        tube(pr, x, y + m(0.32) + th, z, x, y + m(0.32) + th + m(0.10), z, tr * 0.72, 8, 1, true);
      } else if (h3 < 0.58) {
        /* solar thermal: a tilted absorber and its cylinder */
        pm.tile(T_STEEL).tint(mulc(C.dark, 0.6));
        var pw = m(1.0), ph = m(0.9);
        poly(pm, [[x - pw, y + m(0.30), z - ph], [x + pw, y + m(0.30), z - ph],
                  [x + pw, y + m(1.15), z + ph], [x - pw, y + m(1.15), z + ph]],
             x, y - 2, z, 1);
        pr.tile(T_RENDER).tint(C.tank);
        tube(pr, x - pw, y + m(1.25), z + ph * 0.6, x + pw, y + m(1.25), z + ph * 0.6, m(0.22), 8, 1, true);
      } else if (h3 < 0.80) {
        /* a render chimney stack with a metal cowl */
        pr.tile(T_RENDER).tint(mulc(C.creamB, 0.94));
        var ch = m(1.6 + h1 * 1.1), cw = m(0.42 + h2 * 0.20);
        boxC(pr, x, y + ch * 0.5, z, cw, ch * 0.5, cw * 0.8, 0.06, 1);
        pr.tint(mulc(C.trim, 0.9));
        boxC(pr, x, y + ch + m(0.06), z, cw * 1.18, m(0.07), cw * 0.94, 0.03, 1);
        pm.tile(T_STEEL).tint(C.galv);
        tube(pm, x, y + ch + m(0.12), z, x, y + ch + m(0.40), z, m(0.16), 8, 1, false);
        tube(pm, x, y + ch + m(0.40), z, x, y + ch + m(0.50), z, m(0.28), 8, 1, true);
      } else {
        /* the forest of aerials */
        pm.tile(T_STEEL).tint(C.galv);
        var ah = m(2.2 + h1 * 1.8);
        tube(pm, x, y, z, x + (h2 - 0.5) * 0.6, y + ah, z + (h1 - 0.5) * 0.6, m(0.038), 4, 1, false);
        for (var k = 0; k < 6; k++) {
          var ey = y + ah * (0.45 + k * 0.09), ew = m(0.42 - k * 0.03);
          tube(pm, x - ew, ey, z, x + ew, ey, z, m(0.020), 4, 1, false);
        }
      }
      STATS.props++;
    }
    /* a couple of small dishes on the roof edge, all at a similar azimuth */
    for (i = 0; i < 2; i++) {
      var dx = rf.alongX ? lerp(rf.x0 + 8, rf.x1 - 8, hash1(seed + 91 + i * 2.3))
                         : rf.street + rf.inward * 2.4;
      var dz = rf.alongX ? rf.street + rf.inward * 2.4
                         : lerp(rf.z0 + 8, rf.z1 - 8, hash1(seed + 91 + i * 2.3));
      var dy = roofY(rf, dx, dz) + m(0.5);
      pm.tile(T_STEEL).tint(C.white);
      tube(pm, dx, dy - m(0.5), dz, dx, dy, dz, m(0.020), 5, 1, false);
      tube(pm, dx, dy, dz, dx - m(0.28), dy + m(0.10), dz + (rf.mz > 172 ? -m(0.16) : m(0.16)),
           m(0.26), 10, 0.95, true);
      STATS.props++;
    }
    /* a few slipped tiles near the eaves */
    PILES.roof.tile(T_ROOF).tint(mulc(WHITE, 0.92));
    for (i = 0; i < 3; i++) {
      var sx = rf.alongX ? lerp(rf.x0 + 6, rf.x1 - 6, hash1(seed + 51 + i * 4.7))
                         : rf.street + rf.inward * m(1.1);
      var sz = rf.alongX ? rf.street + rf.inward * m(1.1)
                         : lerp(rf.z0 + 6, rf.z1 - 6, hash1(seed + 51 + i * 4.7));
      var sy = roofY(rf, sx, sz);
      boxC(PILES.roof, sx, sy + m(0.05), sz, m(0.22), m(0.04), m(0.30), 0.02, 0.9);
    }
  }

  function buildRoofs() {
    /* Only the two photographed slabs receive roofs here.  The earlier
       canyon generator also emitted west/east closing roofs, which visually
       sealed a route that must remain open at both ends. */
    var eaveY = EAVES + m(0.36), deep = m(13.0), i;
    for (i = 0; i < RUNS.length; i++) {
      var R = RUNS[i];
      if (R.kind !== 'ablok' && R.kind !== 'bblok') continue;
      var face = R.pz + R.nz * R.faceD;
      var streetEdge = face + R.nz * EAVE_OUT;
      var backEdge = face - R.nz * deep;
      var z0 = Math.min(streetEdge, backEdge), z1 = Math.max(streetEdge, backEdge);
      var rf = hipRoof(R.a - EAVE_OUT, R.b + EAVE_OUT, z0, z1,
                       eaveY, 64.0, true);
      roofClutter(rf, R.kind === 'ablok' ? 311 : 733);
    }
  }

  /* =========================================================================
     11.  THE TWO SPECIAL PIECES
     ====================================================================== */
  /* The slot between SB and SEYDIKENT A-BLOK: 1.1 m of fenced, weedy gap with
     a third block's flank in shade behind it.  It buys the canyon the depth it
     cannot get from 24 m of length.  Moved to x 192..196 with the south plane;
     it is also what stops 16 m of lap siding butting straight into 7 m of ice
     blue render with no joint. */
  function southSlot() {
    var pr = PILES.render, pm = PILES.metal, pg = PILES.glass, i;
    var x0 = 192, x1 = 196, zF = PLANE.south - BAY, zB = PLANE.south - 0.6, zM = zF + 1.2;
    /* the two flanks, each in ITS OWN block's colour and in deep shade: SB's
       ice blue render to the west, A-BLOK's cream boards to the east */
    pr.tile(T_RENDER).tint(mulc(C.ice, 0.66));
    poly(pr, [[x0, 0, zM], [x0, 0, zB], [x0, EAVES, zB], [x0, EAVES, zM]],
         x0 - 3, 20, (zM + zB) / 2, 0.72);
    PILES.siding.tile(T_SIDING).tint(mulc(C.sidCreamB, 0.66));
    poly(PILES.siding, [[x1, 0, zM], [x1, 0, zB], [x1, EAVES, zB], [x1, EAVES, zM]],
         x1 + 3, 20, (zM + zB) / 2, 0.72);
    /* the two returns at the front, so the slot has a lip rather than an edge */
    pr.tint(mulc(C.ice, 0.92));
    poly(pr, [[x0 - BAY, 0, zM], [x0, 0, zM], [x0, EAVES, zM], [x0 - BAY, EAVES, zM]],
         x0 - 2, 20, zM + 2, 0.80);
    PILES.siding.tint(mulc(C.sidCreamB, 0.90));
    poly(PILES.siding, [[x1, 0, zM], [x1 + BAY, 0, zM], [x1 + BAY, EAVES, zM], [x1, EAVES, zM]],
         x1 + 2, 20, zM + 2, 0.80);
    /* the block behind: a different colour, in shade, with real windows so the
       eye reads DISTANCE rather than a grey slab.  It is what buys the canyon
       the depth 24 m of length cannot. */
    pr.tint(mulc(C.sage, 0.70));
    var holes = [], wy;
    for (i = 0; i < 4; i++) {
      wy = 7 + i * 10.15;
      holes.push({ s0: x0 + 1.2, s1: x0 + 3.4, y0: wy, y1: wy + 5.0 });
      holes.push({ s0: x1 - 3.4, s1: x1 - 1.2, y0: wy, y1: wy + 5.0 });
    }
    /* the back wall, punched, on a synthetic run frame whose s IS world x */
    var F2 = { px: 0, pz: zB, tx: 1, tz: 0, nx: 0, nz: -1 };
    pr.tile(T_RENDER);
    punched(pr, F2, 0, x0, x1, 0, EAVES, holes, 0.70, null);
    pg.tile(T_GLASS).tint(mulc(C.glass, 0.80));
    for (i = 0; i < holes.length; i++) {
      var q = holes[i];
      rquad(pg, F2, q.s0, q.s1, q.y0, q.y1, -0.30, 0.8);
    }
    /* a downpipe and the gas riser that is always in a slot like this */
    pm.tile(T_STEEL).tint(mulc(C.galv, 0.85));
    tube(pm, x0 + 1.0, 0.2, zB - 0.35, x0 + 1.0, EAVES - 2, zB - 0.35, m(0.05), 6, 0.82, false);
    pm.tint(mulc(C.gasYel, 0.88));
    tube(pm, x1 - 1.2, 0.3, zB - 0.35, x1 - 1.2, 20, zB - 0.35, m(0.03), 6, 0.82, false);
    /* the fence across the front, and its weathered rails */
    pm.tile(T_STEEL).tint(C.dgreen);
    var fy0 = 0.55, fh = m(1.7);
    tube(pm, x0 + 0.2, fy0 + m(0.10), zM + 0.4, x1 - 0.2, fy0 + m(0.10), zM + 0.4, m(0.024), 5, 0.94, true);
    tube(pm, x0 + 0.2, fy0 + fh, zM + 0.4, x1 - 0.2, fy0 + fh, zM + 0.4, m(0.024), 5, 0.94, true);
    for (i = 0; i <= 9; i++) {
      var fx = lerp(x0 + 0.3, x1 - 0.3, i / 9);
      tube(pm, fx, fy0, zM + 0.4, fx, fy0 + fh, zM + 0.4, m(0.013), 4, 0.94, false);
    }
    /* deep AO down the slot: the flanks are 4 m of solid block on each side */
    OCCC.push({ x0: x0 - 14, x1: x0, y0: 0, y1: EAVES, z0: zM, z1: zB });
    OCCC.push({ x0: x1, x1: x1 + 14, y0: 0, y1: EAVES, z0: zM, z1: zB });
    STATS.props += 2;
  }

  /* =========================================================================
     12.  BUILD, MERGE, PUBLISH
     ====================================================================== */
  function buildEverything() {
    PILES = {
      render: new Pile(), stone: new Pile(), brick: new Pile(),
      siding: new Pile(), joinery: new Pile(), metal: new Pile(), glass: new Pile(),
      heroGlass: new Pile(),
      roof: new Pile(), sign: new Pile(), letter: new Pile(), decal: new Pile()
    };
    HERO_PANES.length = 0;
    HERO_GLASS_MESH = null;
    STATS.heroGlassPanes = 0;
    OCC.length = 0; OCCC.length = 0; ROOFS.length = 0;
    checkClearance();
    var tA = nowMs();
    var SBG = '#edeae4';           /* == the render set's own base, so the band
                                      and the wall are one material to the eye */
    /* Rows 0 and 1 are the two REAL names.  Neither is drawn as a painted
       board any more -- the heroes carry cut letters off the LETT atlas -- but
       both rows stay so that NZ.street.facades[n].name publishes the string
       the user asked for, and so a future critic pass can put a name plate on
       either block without regenerating the atlas.  Rows 2..5 are the invented
       neighbours, in the same pattern, which is what the brief asks for. */
    buildSignAtlas([
      /* 0  */ { text: 'SEYDİKENT A-BLOK', bg: SBG, ink: '#a02f24' },
      /* 1  */ { text: 'SEYDİKENT B-BLOK', bg: SBG, ink: '#a02f24' },
      /* 2  */ { text: 'ÖZGÜRKENT A-BLOK', bg: SBG, ink: '#a5301f' },
      /* 3  */ { text: 'ÇINARKENT B-BLOK', bg: SBG, ink: '#962c22' },
      /* 4  */ { text: 'GÜLTEPE SİTESİ', bg: SBG, ink: '#8c2f28' },
      /* 5  */ { text: 'AKŞEHİRKENT C-BLOK', bg: SBG, ink: '#962c22' },
      /* 6  */ { text: 'B-BLOK', bg: SBG, ink: '#a5301f', track: 0.16 },
      /* 7  */ { text: 'GİRİŞ', bg: '#9c2c20', ink: '#f2ece0', track: 0.22 },
      /* 8  */ { text: '233. SOKAK', bg: SBG, ink: '#33507a' },
      /* 9  */ { text: 'YEŞİLKENT SİTESİ', bg: SBG, ink: '#a02f24' },
      /* 10 */ { text: 'ÖZGÜRKENT', bg: SBG, ink: '#a5301f' },
      /* 11 */ { text: 'A-BLOK', bg: SBG, ink: '#a5301f', track: 0.16 }
    ]);
    /* the cut letters.  0 and 1 are A-BLOK's two lines exactly as _ref/ref6
       spells them (the second line really is punctuated -A- BLOK); 2 is
       B-BLOK's second line.  b04a3c -> c2402f: the ink is now the whole of the
       letter's colour (C.letterRed went neutral, see the palette note), so it
       has to be the saturated post-box red both plates show rather than the
       brick that was being multiplied into a second red on top of it. */
    buildLetterAtlas([
      /* 0 */ { text: 'SEYDİKENT', ink: '#c2402f', track: 0.15 },
      /* 1 */ { text: '-A- BLOK', ink: '#c2402f', track: 0.17 },
      /* 2 */ { text: 'B-BLOK', ink: '#c2402f', track: 0.17 },
      /* 3 */ null, /* 4 */ null, /* 5 */ null
    ]);
    buildDecalAtlas();
    STATS.atlasMs = Math.round(nowMs() - tA);

    RUNS = defineRuns();
    /* mission 4 only; a no-op on every other level.  It runs AFTER defineRuns
       so the two bodyHex fields can be re-derived from the tones the runs
       actually got -- nz-street-props.js:3052 reads that hex off the published
       facade record and would otherwise paint its garden walls and awnings to
       a palette the street no longer uses. */
    levelPalette();
    for (var i = 0; i < RUNS.length; i++) {
      if (NZ.level === 4 && RUNS[i].body) RUNS[i].bodyHex = hexOf(RUNS[i].body);
      buildRun(RUNS[i]);
    }
    buildRoofs();
    publishFacades();
    /* OCC = the coarse canyon boxes plus every balcony slab.  The slabs are
       what put a contact line under a soffit, which is the one thing
       CRITIC-STREET section 2 says the whole street is missing, and the sky
       agent is rebuilding bake() this round to honour them. */
    for (var q = 0; q < OCCC.length; q++) OCC.push(OCCC[q]);
  }

  function publishFacades() {
    if (!ST) return;
    var out = [], i;
    for (i = 0; i < RUNS.length; i++) {
      var R = RUNS[i];
      var ent = null, k;
      R.inw = (R.nx + R.nz);
      var pA = PT(R, R.bs0, 0, 0), pB = PT(R, R.bs1, 0, 0);
      var ax = (R.side === 'N' || R.side === 'S') ? 0 : 2;
      var wA = pA[ax], wB = pB[ax];
      var gw = [];
      var residential = [];
      for (k = 0; k < R.gaps.length; k++) {
        var g0 = PT(R, R.gaps[k].s0, 0, 0)[ax], g1 = PT(R, R.gaps[k].s1, 0, 0)[ax];
        gw.push({ a: Math.min(g0, g1), b: Math.max(g0, g1), y1: R.gaps[k].y1 });
      }
      if (R.entrance) {
        var Pe = PT(R, R.entrance.s, 0, 0);
        ent = {
          x: Pe[0], z: Pe[2], steps: 4, width: R.entrance.w,
          /* extras the ENTRANCE agent needs to align to this facade */
          x0: DOORB.x0, x1: DOORB.x1, plane: R.plane,
          headY: GH, soffitY: SOF1, bay: BAY, wallDepth: WALL_D,
          plinthDepth: PLINTH_D, plinthTop: PLINTH_TOP, plinthKind: R.plinth,
          bodyLinear: R.body.slice()
        };
      }
      if (R.entries) {
        for (k = 0; k < R.entries.length; k++) {
          var Pr = PT(R, R.entries[k].s, R.faceD, 0);
          residential.push({ x: Pr[0], z: Pr[2], width: R.entries[k].w,
                             gameplay: false, index: k + 1 });
        }
      }
      /* The A-BLOK porch is also the shallow, usable residential doorway.
         The actual fight-arena threshold is separately owned by STREET-PARK,
         opposite the upper end of Yildiz Tepesi.  PROPS still needs this porch
         record for the maroon garden wall and adjacent conifer in _ref/ref6. */
      var por = null;
      if (R.porch) {
        var qa = PT(R, R.porch.s0, 0, 0)[ax], qb = PT(R, R.porch.s1, 0, 0)[ax];
        por = { a: Math.min(qa, qb), b: Math.max(qa, qb),
                face: R.plane + R.inw * WALL_D, backDepth: m(1.30),
                headY: 9.70, floorY: 0.5 + 0.85 * 3, enterable: false };
      }
      out.push({
        side: R.side, a: R.a, b: R.b, plane: R.plane,
        body: R.bodyHex, plinth: R.plinth, storeys: 5,
        name: SIGN.names[R.sign >= 0 ? R.sign : 2] || '', bay: BAY, entrance: ent,
        entrances: residential,
        gardenWall: { x0: 580, x1: 756, z: R.side === 'N' ? 150 : 198,
                      heightM: 1.5, colour: 'oxide-red', gates: residential.length },
        /* which recipe built this run: 'bblok' and 'ablok' are the two
           photographed buildings and are NOT parametric, so a sibling module
           that wants to hang something on them should read the faces below
           rather than assume a cikma. */
        kind: R.kind || 'generic', porch: por,
        faceDepth: R.faceD === undefined ? BAY : R.faceD,
        face: R.plane + R.inw * (R.faceD === undefined ? BAY : R.faceD),
        /* additional, and load-bearing for PROPS, GROUND and ENTRANCE.
           Every face below is a WORLD coordinate on the run's own axis (z for
           N/S, x for W/E), signed so that "further from the plane" always means
           "further into the canyon". */
        id: R.id,
        axis: (R.side === 'N' || R.side === 'S') ? 'z' : 'x',
        inward: (R.nx + R.nz),                  /* +1 or -1 along that axis     */
        wallFace: R.plane + R.inw * (R.kind === 'ablok' ? BAY : WALL_D),
        plinthFace: R.plane + R.inw * (R.kind === 'ablok' ? BAY + m(0.08) : PLINTH_D),
        bayFace: R.plane + R.inw * BAY,
        eaveFace: R.plane + R.inw * (BAY + EAVE_OUT),
        bayA: Math.min(wA, wB), bayB: Math.max(wA, wB),
        soffitY: SOF0, soffitTopY: SOF1, plinthTop: PLINTH_TOP,
        eavesY: EAVES, eaveOut: EAVE_OUT, ridgeY: 64,
        /* openings in the ground storey, in world coordinates on the run axis */
        gaps: gw, blind: !!R.blind, columns: (R.cols || []).length,
        /* THE ENTRANCE TOWER, additive and null on every run but NB.  It is the
           one place where the facade is NOT at bayFace: this bay stands
           0.55 m further into the canyon from y = soffitTopY up to topY, so
           anything a sibling hangs on bayFace between a and b (PROPS' dishes,
           wires and banners; a tree crown; a balcony awning) is buried inside
           it and should use `face` instead, or move clear of [a,b]. */
        entryBay: (function () {
          if (!R.entryT) return null;
          var eA = PT(R, R.entryT.s0, 0, 0)[ax], eB = PT(R, R.entryT.s1, 0, 0)[ax];
          return { a: Math.min(eA, eB), b: Math.max(eA, eB),
                   face: R.plane + R.inw * BAY_E, depth: BAY_E,
                   baseY: SOF1, topY: TOWER_TOP, bodyLinear: (R.entryBody || R.body).slice() };
        })()
      });
    }
    ST.facades.length = 0;
    for (i = 0; i < out.length; i++) ST.facades.push(out[i]);
  }

  function makeMesh(pile, mat, name, occ, rays) {
    if (!pile || pile.empty() || !mat) {
      DIAG.piles.push({ name: name, tris: 0, added: false });
      return null;
    }
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    var geo = pile.geometry();
    sbake(geo, { occluders: occ, rays: rays || RAYS, bias: 0.06, floor: 0.30, roofY: BOX.y1 });
    /* the overcast bake wrote an achromatic sky-visibility term into `color`;
       multiply the per-vertex LINEAR tint into it.  This is what lets one draw
       call carry salmon render, cream render, white PVC and a yellow gas riser
       without four materials. */
    try {
      var ca = geo.attributes.color, ta = pile.tintArr, i;
      if (ca && ta && ta.length === ca.array.length) {
        var arr = ca.array;
        for (i = 0; i < arr.length; i++) arr[i] *= ta[i];
        ca.needsUpdate = true;
      } else if (ca && ta) {
        warn('tint/colour length mismatch on pile ' + name);
      }
    } catch (e) { warn('tint merge failed on ' + name + ': ' + (e && e.message)); }

    /* Dynamic hero panes no longer own this baked geometry once destruction
       installs, but they must keep its overcast exposure.  Capture the mean
       final vertex colour for each recorded quad after sky visibility and
       authored tint have both been applied. */
    if (pile === PILES.heroGlass && geo.attributes.color) {
      var hc = geo.attributes.color.array;
      for (var hp = 0; hp < HERO_PANES.length; hp++) {
        var hpr = HERO_PANES[hp], hs = hpr.vertexStart | 0;
        var hn = Math.max(1, hpr.vertexCount | 0), hr = 0, hg = 0, hb = 0;
        for (var hv = 0; hv < hn; hv++) {
          var hi = (hs + hv) * 3;
          hr += hc[hi] || 0; hg += hc[hi + 1] || 0; hb += hc[hi + 2] || 0;
        }
        hpr.bakedTint = [hr / hn, hg / hn, hb / hn];
      }
    }

    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    OWN.obj.push(mesh);
    STATS.addedCalls++;
    var tris = (pile.idx.length / 3) | 0;
    STATS.tris += tris; STATS.verts += pile.n;
    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    STATS.bakeMs += Math.round(t1 - t0);
    DIAG.piles.push({ name: name, tris: tris, verts: pile.n, added: true,
                      ms: Math.round(t1 - t0) });
    return mesh;
  }

  /* the carve may not be in this build; never assume it is */
  function hasStreet() {
    /* Sample the actual A/B corridor.  The old 42..62 probe belonged to the
       pre-extension street and left the rebuilt hero facades inert even while
       their new x580..756 run was present. */
    for (var y = 38; y <= 48; y++) for (var x = 145; x <= 189; x++) {
      if (!G.inb(x, y)) continue;
      var R = G.regAt(x, y);
      if (R && R.sky && R.c >= 40) return true;
    }
    return false;
  }

  /* =========================================================================
     13.  INSTALL / TEARDOWN / REPORT
     ====================================================================== */
  function install(ctx) {
    if (dead || installed) return;
    if (NZ.level !== undefined && NZ.level !== 1 && NZ.level !== 4) {
      NZ.log && NZ.log('street: level ' + NZ.level + ', module inert');
      return;
    }
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
    renderer = (ctx && ctx.renderer) || (NZ.ctx && NZ.ctx.renderer);
    if (!THREE || !scene || !renderer) throw new Error('nz-street: renderer context missing');

    G = bindGame();
    if (!G) { NZ.log && NZ.log('street: level globals unavailable, module inert'); return; }
    if (!hasStreet()) { NZ.log && NZ.log('street: carve not present, module inert'); return; }
    if (!ST || !ST.day || !ST.bake) DIAG.warnings.push('NZ.street absent -- daylight and bake are degraded fallbacks');

    applyTier();
    // The reference buildings now come from the editable Blender scene. Keep
    // the original facade records for gates, street dressing and ray queries.
    if (global.NZ_BUILDINGS_ASSET && global.NZ_BLENDER_BUILDINGS) {
      ST = NZ.street || ST;
      RUNS = defineRuns();
      SIGN.names = ['SEYDİKENT A-BLOK', 'SEYDİKENT B-BLOK'];
      RUNS.forEach(function (r) { r.faceD = r.kind === 'ablok' ? BAY : WALL_D; });
      publishFacades();
      var imported = global.NZ_BLENDER_BUILDINGS.install({ THREE: THREE, scene: scene }, ST, OWN);
      HERO_GLASS_MESH = imported.heroGlass.mesh;
      HERO_PANES = imported.heroGlass.panes;
      STATS.blocks = 5; STATS.tris = imported.triangles;
      STATS.addedCalls = imported.meshes.length;
      STATS.heroGlassPanes = HERO_PANES.length;
      STATS.ms = Math.round(nowMs() - t0);
      installed = true; NZ.flags.street = true;
      NZ.streetFacade = { stats: STATS, tier: TIER, diag: DIAG, facades: ST ? ST.facades : [],
        source: imported.source, replacedRuns: imported.replacedRuns,
        heroGlass: imported.heroGlass, report: report,
        dispose: function () { panic('manual dispose'); } };
      if (ST) { ST.facadeReport = report; ST.facadeStats = STATS; }
      return;
    }
    try { ANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } catch (e) { ANISO = 8; }

    var tG = nowMs();
    buildEverything();
    STATS.geoMs = Math.round(nowMs() - tG - STATS.atlasMs);

    /* The render pile gets the FULL list -- it owns every soffit, reveal and
       parapet, i.e. every surface an occluder can do anything for.  The small
       piles get the coarse canyon boxes only: a window frame does not need
       forty-four balcony slabs tested against it, and the bake is
       O(verts x rays x boxes). */
    var coarse = OCCC;
    makeMesh(PILES.render, mkMat('render', 'render', { tile: T_RENDER, nrm: 0.85, env: 1.0, ao: 0.35 }),
             'nzstreet-render', OCC);
    makeMesh(PILES.stone, mkMat('travertine', 'travertine', { tile: T_TRAV, nrm: 1.0, env: 1.0, ao: 0.65 }),
             'nzstreet-travertine', coarse);
    makeMesh(PILES.brick, mkMat('brick', 'brick', { tile: T_BRICK, nrm: 1.0, env: 0.9, ao: 0.70 }),
             'nzstreet-brick', coarse);
    /* the siding gets the FULL occluder list like the render: it carries
       A-BLOK's cikma soffit, its glazed-box undersides and its porch reveal,
       which are the only shading cues that block has at low tier. */
    makeMesh(PILES.siding, mkMat('siding', 'siding', { tile: T_SIDING, nrm: 1.15, env: 0.95, ao: 0.45 }),
             'nzstreet-siding', OCC);
    makeMesh(PILES.joinery, mkMat('pvc', 'pvc', { tile: T_PVC, nrm: 0.45, env: 1.0 }),
             'nzstreet-joinery', coarse);
    makeMesh(PILES.metal, mkMat('steel', 'steel', { tile: T_STEEL, nrm: 1.0, env: 1.2 }),
             'nzstreet-metal', coarse);
    /* glass: env 1.7 at roughness 0.10 was a near-mirror of a 219-code sky laid
       over every pane, which is why glass / frame measured 1.00 instead of
       ref4's 0.79.  0.85 leaves the weak sheen an overcast pane really has. */
    var glassMat = mkMat('glass', 'glass', { tile: T_GLASS, nrm: 0.5, env: 0.85, ao: 0.5 });
    makeMesh(PILES.glass, glassMat, 'nzstreet-glass', coarse);
    HERO_GLASS_MESH = makeMesh(PILES.heroGlass, glassMat, 'nzstreet-hero-glass', coarse);
    /* roof: the pitch sees nearly the whole dome, so the bake hands it 1.0 and
       the specular sheen adds a flat ~0.2 on top of that.  Half the albedo (in
       the set) and 0.62 of the env is what lands roof / sky on ref5's 0.50. */
    makeMesh(PILES.roof, mkMat('rooftile', 'rooftile', { tile: T_ROOF, nrm: 1.0, env: 0.62 }),
             'nzstreet-roof', []);
    makeMesh(PILES.sign, SIGN.mat, 'nzstreet-sign', coarse);
    makeMesh(PILES.letter, LETT.mat, 'nzstreet-letters', coarse);
    makeMesh(PILES.decal, DECAL.mat, 'nzstreet-grime', coarse);

    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    STATS.ms = Math.round(t1 - t0);
    installed = true;
    NZ.flags.street = true;

    NZ.streetFacade = {
      stats: STATS, tier: TIER, diag: DIAG,
      megabytes: +(STATS.texBytes / 1048576).toFixed(2),
      facades: (ST && ST.facades) || [],
      heroGlass: {
        mesh: HERO_GLASS_MESH,
        panes: HERO_PANES,
        count: HERO_PANES.length
      },
      report: report,
      dispose: function () { panic('manual dispose'); }
    };
    if (ST) { ST.facadeReport = report; ST.facadeStats = STATS; }
    /* A module that cannot see the screen has to be able to prove from inside
       the page that it ran and what it cost.  Line by line, because the
       headless harness only surfaces console lines. */
    if (NZ.debug || DIAGON || SHOTMODE) {
      /* the headless harness (scripts/render-level.mjs:565) only surfaces a
         console line whose TEXT matches /error|fail|panic|threw|missing/, so
         the marker below is what makes a self-report visible in a shot log */
      var rl = report().split('\n');
      for (var wi = 0; wi < rl.length; wi++) console.warn('[nz-street] threw:0 ' + rl[wi]);
    } else if (DIAG.warnings.length) {
      for (var wj = 0; wj < DIAG.warnings.length; wj++)
        console.warn('[nz-street] ! ' + DIAG.warnings[wj]);
    }
    if (DIAGON) installOverlay();
  }

  function panic(err) {
    if (dead) return;
    dead = true;
    NZ.flags.street = false;
    if (err) console.error('[nz-street] disabled after error: ' + String((err && err.stack) || err));
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
      if (ST && ST.facades) ST.facades.length = 0;
      SETS = Object.create(null); MATS = Object.create(null); NOISE = Object.create(null);
      LATTICE = Object.create(null); AXIS = Object.create(null);
      SIGN = { tex: null, mat: null, rect: [], names: [], aspect: [], capFrac: [] };
      LETT = { tex: null, mat: null, rect: [], aspect: [], capFrac: [], names: [] };
      DECAL = { tex: null, mat: null, rect: [] };
      HERO_PANES.length = 0; HERO_GLASS_MESH = null;
      PILES = null; installed = false;
    } catch (e4) { console.error('[nz-street] teardown failed:', e4); }
  }

  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function report() {
    var Ls = [], i;
    Ls.push('NZ-STREET(facades) tier=' + TIER + ' install=' + STATS.ms + 'ms bake=' +
            STATS.bakeMs + 'ms vram~' + (STATS.texBytes / 1048576).toFixed(1) + 'MB');
    Ls.push('  install split: atlas ' + STATS.atlasMs + 'ms  geo ' + STATS.geoMs +
            'ms  texsets ' + Math.round(STATS.setMs) + 'ms  bake ' + STATS.bakeMs + 'ms');
    for (i = 0; i < DIAG.sets.length; i++) {
      var b = DIAG.sets[i];
      Ls.push('  set ' + pad(b.name, 11) + b.res + 'px rgb ' + b.rgb.join(',') +
              ' lum ' + pad(b.lum.toFixed(0), 4) + ' sd ' + pad(b.sd.toFixed(1), 5) +
              ' sat ' + b.sat.toFixed(3) +
              ' relief ' + b.reliefMM + 'mm swing ' + b.swingMM + 'mm' + (b.black ? '  <<< BLACK' : ''));
    }
    for (i = 0; i < DIAG.piles.length; i++) {
      var p = DIAG.piles[i];
      Ls.push('  pile ' + pad(p.name, 20) + ' tris ' + pad(String(p.tris), 7) +
              ' verts ' + pad(String(p.verts || 0), 7) + (p.added ? (p.ms + 'ms') : '  (EMPTY)'));
    }
    Ls.push('blocks=' + STATS.blocks + ' windows=' + STATS.windows + ' balconies=' + STATS.balconies +
            ' props=' + STATS.props + ' decals=' + STATS.decals);
    Ls.push('draws +' + STATS.addedCalls + '  tris ' + STATS.tris + '  verts ' + STATS.verts +
            '  clearanceClamps=' + STATS.clearanceClamps + '  occluders=' + OCC.length +
            ' (coarse ' + OCCC.length + ')');
    if (DIAG.warnings.length) {
      Ls.push('WARNINGS (' + DIAG.warnings.length + '):');
      for (i = 0; i < DIAG.warnings.length; i++) Ls.push('  ! ' + DIAG.warnings[i]);
    }
    return Ls.join('\n');
  }

  var DIAGON = /[?&]nzdiag=1/.test(global.location ? global.location.search : '');
  var SHOTMODE = /[?&]shot=/.test(global.location ? global.location.search : '');
  var overlay = null;
  function installOverlay() {
    try {
      if (overlay || !global.document || !document.body) return;
      overlay = document.createElement('div');
      overlay.id = 'nzstreet-diag';
      overlay.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:0;' +
        'max-height:44vh;max-width:min(720px,44vw);overflow:auto;z-index:99996;' +
        'background:rgba(6,8,10,.90);color:#d9c79f;font:11px/1.35 Consolas,monospace;' +
        'padding:6px 8px;white-space:pre;border-top:2px solid #8d6a2f;pointer-events:none';
      overlay.textContent = report();
      document.body.appendChild(overlay);
    } catch (e) {}
  }

  /* Hook priority: NONE.  nz-core.js:42-44 sorts (a,b) => b.p - a.p, i.e.
     DESCENDING, so the negative priorities in the original contract would run
     these modules in reverse.  Every module registers 'ready' at the default
     p = 0 and relies on Array.prototype.sort being stable, which makes the
     firing order identical to the script-tag order:
       nz-render, nz-env, sky, ground, FACADE, entrance, props. */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); }
    catch (err) { panic(err); }
  });

  NZ.log && NZ.log('street facade module loaded');
})(typeof window !== 'undefined' ? window : this);
