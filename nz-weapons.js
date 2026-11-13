/* ===========================================================================
   NZ-WEAPONS  --  CS2-grade first-person viewmodels for NUKE ZONE 3D.

   Replaces the software-rasterised 2D sprite viewmodel with real geometry,
   procedural PBR, spring animation, and Counter-Strike's actual ballistics.

     * proportion   every weapon is authored at true firearm dimensions
                    (metres) and framed through a dedicated viewmodel camera
                    at CS2's viewmodel_fov, not the world FOV.
     * materials    one 1024x512 eight-tile procedural PBR atlas baked
                    through NZ.tex.bake: nitrided steel, anodised alloy,
                    polymer, bright worn steel, glove, rubber, painted
                    stamped steel, trim. Edge wear is driven from real
                    curvature -- only convex chamfers and corners wear, and
                    a worn segment switches atlas tile so its ROUGHNESS
                    drops too, not just its albedo.
     * silhouette   every edge chamfered, chamfers subdivided so wear can
                    appear and vanish along a single edge. Ejection ports,
                    extractors, charging handles, selectors, sling loops,
                    gas blocks, floorplates, pins.
     * ballistics   CS2's model: a deterministic per-weapon spray table,
                    aim punch (moves the bullet AND the view, so crosshair
                    and bullet agree) separate from view punch (cosmetic),
                    index-based recovery that walks the pattern back to
                    centre, and a first-shot-accurate inaccuracy model that
                    grows with movement, air time, landing and consecutive
                    fire.
     * animation    springs only. Draw, holster, reload with real magazine
                    and bolt timing, inspect, sprint cant, lissajous idle
                    drift, landing impact, rotational recoil with a slow
                    settle.
     * effects      1-2 frame muzzle flash that lights the world, shell
                    ejection with a bounce, rare thin tracers, dissipating
                    smoke.

   Integration: nz-render fires 'scenePass' straight after the world lands
   in its HDR buffer, so we render there and inherit bloom / ACES / grade.
   Without nz-render we draw from the 'viewmodel' hook instead. We never
   register 'render'.

   ZERO external assets. Classic script, three.js r149 core API only.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;

  var THREE = null;

  /* ------------------------------------------------------------- helpers -- */
  var PI = Math.PI, TAU = PI * 2, D2R = PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function sstep2(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
  function smoothband(x, a, b) { return sstep((x - a) / Math.max(1e-6, b - a)); }
  /* window a global time into a 0..1 ramp between two stamps */
  function seg(t, t0, t1) { return t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp((t - t0) / (t1 - t0), 0, 1); }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  /* smooth 1D value noise -- used for wear so it fades along an edge rather
     than flickering per segment */
  function vnoise(x) {
    var i = Math.floor(x), f = x - i;
    var a = hash1(i), b = hash1(i + 1);
    var u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  }
  function fbm1(x, oct) {
    var v = 0, amp = 0.5, tot = 0;
    for (var i = 0; i < (oct || 3); i++) { v += vnoise(x) * amp; tot += amp; amp *= 0.5; x *= 2.07; }
    return v / tot;
  }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }

  /* Critically-damped spring. Uses nz-core's if present so the whole project
     shares one integrator, but carries its own identical implementation so a
     concurrent core rewrite can never leave the weapons without one.
     Substepped at 1/240 and dt-clamped, so a 33ms frame and a 4ms frame
     converge to the same curve and nothing can blow up at low framerate. */
  function LocalSpring(value, stiffness, damping) {
    this.x = value || 0; this.v = 0; this.target = this.x;
    this.k = stiffness === undefined ? 170 : stiffness;
    this.d = damping === undefined ? 2 * Math.sqrt(this.k) : damping;
  }
  LocalSpring.prototype.step = function (dt) {
    var remaining = Math.min(dt, 0.1), h = 1 / 240;
    while (remaining > 0) {
      var s = Math.min(h, remaining); remaining -= s;
      var a = (this.target - this.x) * this.k - this.v * this.d;
      this.v += a * s; this.x += this.v * s;
    }
    return this.x;
  };
  LocalSpring.prototype.set = function (v) { this.x = v; this.v = 0; return this; };
  LocalSpring.prototype.impulse = function (v) { this.v += v; return this; };
  var Spring = (NZ.math && NZ.math.Spring) ? NZ.math.Spring : LocalSpring;
  /* retune helper: keep the damping ratio explicit so "snappy" vs "heavy" is
     one readable number instead of a magic damping constant */
  function tuneSpring(sp, k, zeta) { sp.k = k; sp.d = 2 * Math.sqrt(k) * zeta; return sp; }

  /* Panic latch: any throw in a per-frame hook flips this. From then on we
     hide the viewmodel and hand the frame back rather than let the exception
     escape. Past the threshold we restore every game value we touched and
     drop NZ.flags.weapons so the stock 2D sprite path takes over cleanly. */
  var PANIC = 0, PANIC_LOG = 0;
  function panic(err) {
    PANIC++;
    if (PANIC_LOG < 4) { PANIC_LOG++; console.error('[nz-weapons] runtime error, degrading:', err); }
    if (PANIC > 30 && NZ.flags.weapons) {
      try { restoreGameTuning(); } catch (e) { }
      NZ.flags.weapons = false;
      console.error('[nz-weapons] too many errors -- handing the viewmodel back to the 2D path');
    }
  }

  /* =========================================================================
     1. GEOMETRY TOOLKIT
     ====================================================================== */

  /* Vertex accumulator. Vertices are never deduplicated, so smoothing is
     controlled purely by sharing: a loft ring shares its verts and comes out
     smooth, a chamfer face gets fresh verts and comes out crisp. It also
     tracks its own AABB, which is what the framing verifier measures. */
  function Pile() {
    this.p = []; this.uv = []; this.col = []; this.idx = []; this.n = 0;
    this.min = [1e9, 1e9, 1e9]; this.max = [-1e9, -1e9, -1e9];
  }
  Pile.prototype.vert = function (x, y, z, u, v, r, g, b) {
    this.p.push(x, y, z); this.uv.push(u, v); this.col.push(r, g, b);
    if (x < this.min[0]) this.min[0] = x; if (x > this.max[0]) this.max[0] = x;
    if (y < this.min[1]) this.min[1] = y; if (y > this.max[1]) this.max[1] = y;
    if (z < this.min[2]) this.min[2] = z; if (z > this.max[2]) this.max[2] = z;
    return this.n++;
  };
  Pile.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Pile.prototype.quad = function (a, b, c, d) { this.idx.push(a, b, c, a, c, d); };
  Pile.prototype.grow = function (o) {
    for (var i = 0; i < 3; i++) {
      if (o.min[i] < this.min[i]) this.min[i] = o.min[i];
      if (o.max[i] > this.max[i]) this.max[i] = o.max[i];
    }
  };

  function pileToGeometry(pile) {
    var g = new THREE.BufferGeometry(), i;
    /* Last line of defence. One non-finite position makes
       computeBoundingSphere return NaN, that fails the frustum test, and the
       whole mesh silently vanishes with no error anywhere. */
    var bad = 0, first = -1;
    for (i = 0; i < pile.p.length; i++) {
      if (!isFinite(pile.p[i])) { if (first < 0) first = i; pile.p[i] = 0; bad++; }
    }
    if (bad) {
      console.error('[nz-weapons] scrubbed ' + bad + ' non-finite position value(s), first at vertex ' +
        Math.floor(first / 3) + ' of ' + pile.n);
    }
    for (i = 0; i < pile.uv.length; i++) if (!isFinite(pile.uv[i])) pile.uv[i] = 0;
    for (i = 0; i < pile.col.length; i++) if (!isFinite(pile.col[i])) pile.col[i] = 0.5;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pile.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(pile.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(pile.col, 3));
    g.setIndex(pile.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) {
      console.error('[nz-weapons] bounding sphere is NaN after repair; disabling culling for this part');
      g.boundingSphere = null;
    }
    return g;
  }

  /* Atlas region. The 1.5px inset stops bilinear filtering pulling in the
     neighbouring tile at grazing angles, which on a weapon this close to the
     eye is instantly visible. */
  function region(px, py, pw, ph) {
    /* 4 rather than 1.5: the framing pass moved every weapon to roughly
       twice its old eye distance, which is one extra mip level, and a
       1.5-texel inset stops covering the neighbouring tile by mip 1. */
    var ix = 4;
    return {
      u0: (px + ix) / 1024, du: (pw - ix * 2) / 1024,
      v0: 1 - (py + ph - ix) / 512, dv: (ph - ix * 2) / 512
    };
  }
  function uvMap(reg, u, v, s, ou, ov) {
    return [
      reg.u0 + (ou + clamp(u, 0, 1) * s) * reg.du,
      reg.v0 + (ov + clamp(v, 0, 1) * s) * reg.dv
    ];
  }
  /* Tiling is impossible inside an atlas, so each part claims a slice sized
     by its physical extent: consistent texel density, no wrap seam, and a
     deterministic per-part offset so two identical boxes never show the same
     blemish. Never below 0.30 of the tile or the machining marks blur away. */
  function uvSlice(size, density, seed) {
    var s = clamp(size * density, 0.30, 1);
    var o1 = hash1(seed * 3.7 + 1.3) * (1 - s);
    var o2 = hash1(seed * 5.1 + 7.9) * (1 - s);
    return [s, o1, o2];
  }

  /* Emit one convex polygon with fresh vertices, auto-oriented so its normal
     faces away from `ref`. vcols (optional) gives a per-vertex tint so wear
     can fade across a face instead of switching on at its border. */
  var _pa = [0, 0, 0], _pb = [0, 0, 0];
  function poly(pile, pts, refx, refy, refz, reg, col, uvs, ao, vcols) {
    var n = pts.length, i;
    if (n < 3) return;
    var cx = 0, cy = 0, cz = 0;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
    cx /= n; cy /= n; cz /= n;
    /* Newell normal */
    var nx = 0, ny = 0, nz = 0;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    var flip = (nx * (cx - refx) + ny * (cy - refy) + nz * (cz - refz)) < 0;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    /* planar UV basis from the dominant axis of the normal */
    var ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ax >= ay && ax >= az) { _pa[0] = 0; _pa[1] = 0; _pa[2] = 1; }
    else { _pa[0] = 1; _pa[1] = 0; _pa[2] = 0; }
    void az;
    _pb[0] = ny * _pa[2] - nz * _pa[1];
    _pb[1] = nz * _pa[0] - nx * _pa[2];
    _pb[2] = nx * _pa[1] - ny * _pa[0];
    /* down-facing surfaces read as cavity: cheap, and it is most of what
       gives a procedural hard-surface part its sense of depth */
    var shade = ao * (1 - 0.26 * clamp(-ny, 0, 1)) * (1 + 0.06 * clamp(ny, 0, 1));
    var base = pile.n, k;
    for (i = 0; i < n; i++) {
      var p = pts[i];
      var dx = p[0] - refx, dy = p[1] - refy, dz = p[2] - refz;
      var u = (dx * _pa[0] + dy * _pa[1] + dz * _pa[2]) * uvs[3] + 0.5;
      var v = (dx * _pb[0] + dy * _pb[1] + dz * _pb[2]) * uvs[3] + 0.5;
      var t = uvMap(reg, u, v, uvs[0], uvs[1], uvs[2]);
      var c = vcols ? vcols[i] : col;
      pile.vert(p[0], p[1], p[2], t[0], t[1], c[0] * shade, c[1] * shade, c[2] * shade);
    }
    for (k = 1; k < n - 1; k++) {
      if (flip) pile.tri(base, base + k + 1, base + k);
      else pile.tri(base, base + k, base + k + 1);
    }
  }

  /* ------------------------------------------------------------ materials -- */
  /* A material descriptor bundles the atlas region, the linear-space tint,
     and where its finish goes when it wears through. Passing one object
     instead of (region, colour) is what makes edge wear possible without
     threading four extra arguments through every call. */
  function material(reg, col, wearAmt, wreg, wcol, density) {
    return {
      reg: reg, col: col,
      wear: wearAmt === undefined ? 0 : wearAmt,
      wreg: wreg || reg, wcol: wcol || col,
      density: density || 6
    };
  }
  var _wc0 = [0, 0, 0], _wc1 = [0, 0, 0], _wc2 = [0, 0, 0], _wc3 = [0, 0, 0];
  var _wcs = [_wc0, _wc1, _wc2, _wc3];
  function wearMix(dst, M, w) {
    var t = sstep((w - 0.10) / 0.80);
    dst[0] = M.col[0] + (M.wcol[0] - M.col[0]) * t;
    dst[1] = M.col[1] + (M.wcol[1] - M.col[1]) * t;
    dst[2] = M.col[2] + (M.wcol[2] - M.col[2]) * t;
    return dst;
  }

  /* -------------------------------------------------------- chamfer box --- */
  /* Centre c, half-extents h, uniform chamfer k. 6 faces + 12 edge strips +
     8 corner tris. The edge strips are subdivided into ESEG segments so the
     finish can rub through partway along an edge and grow back -- that
     patchiness is the single biggest realism cue on a hard-surface model.
     A worn segment ALSO switches to the bright-steel atlas tile, so its
     roughness and metalness change, not just its colour.

     opt.eseg drops the subdivision for parts too small to show it. A 6mm
     picatinny slot cut cannot carry a patchy wear gradient along its edge --
     it is four pixels long -- so paying 92 triangles for one is waste. At
     eseg 1 a box is 44 triangles instead of 92. Left UNSET everywhere the
     four original weapons build, so their geometry is unchanged: e/ESEG and
     e/3 are the same divisions. */
  var _bv = new Float32Array(24 * 3 * 3);
  var ESEG = 3;
  function addBox(pile, cx, cy, cz, hx, hy, hz, k, M, opt) {
    opt = opt || {};
    var es = Math.max(1, fin(opt.eseg, ESEG) | 0);
    cx = fin(cx); cy = fin(cy); cz = fin(cz);
    hx = Math.abs(fin(hx, 0.01)); hy = Math.abs(fin(hy, 0.01)); hz = Math.abs(fin(hz, 0.01));
    k = clamp(fin(k, 0.002), 0, Math.min(hx, Math.min(hy, hz)) * 0.48);
    var ao = fin(opt.ao, 1);
    var seed = fin(opt.seed, cx * 91 + cy * 57 + cz * 33 + hx * 17);
    var big = Math.max(hx, Math.max(hy, hz)) * 2;
    var sl = uvSlice(big, fin(opt.density, M.density), seed);
    var uvs = [sl[0], sl[1], sl[2], 1 / Math.max(1e-4, big)];
    var rot = fin(opt.rotZ, 0), cr = Math.cos(rot), sr = Math.sin(rot);
    var wearAmt = opt.wear === undefined ? M.wear : opt.wear;
    var sx, sy, sz, ci, a, e;

    function put(i, axis, x, y, z) {
      var rx = rot ? x * cr - y * sr : x;
      var ry = rot ? x * sr + y * cr : y;
      var o = (i * 3 + axis) * 3;
      _bv[o] = cx + rx; _bv[o + 1] = cy + ry; _bv[o + 2] = cz + z;
    }
    for (sz = -1; sz <= 1; sz += 2) for (sy = -1; sy <= 1; sy += 2) for (sx = -1; sx <= 1; sx += 2) {
      ci = ((sx > 0) ? 4 : 0) | ((sy > 0) ? 2 : 0) | ((sz > 0) ? 1 : 0);
      put(ci, 0, sx * hx, sy * (hy - k), sz * (hz - k));
      put(ci, 1, sx * (hx - k), sy * hy, sz * (hz - k));
      put(ci, 2, sx * (hx - k), sy * (hy - k), sz * hz);
    }
    function V(sx2, sy2, sz2, axis) {
      var i = ((sx2 > 0) ? 4 : 0) | ((sy2 > 0) ? 2 : 0) | ((sz2 > 0) ? 1 : 0);
      var o = (i * 3 + axis) * 3;
      return [_bv[o], _bv[o + 1], _bv[o + 2]];
    }
    var P4 = [null, null, null, null], P3 = [null, null, null];
    /* 6 faces -- flat surfaces never wear, only edges do */
    for (a = 0; a < 3; a++) {
      var b = (a + 1) % 3, c = (a + 2) % 3;
      for (var s = -1; s <= 1; s += 2) {
        var sg = [0, 0, 0]; sg[a] = s;
        var ord = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (var q = 0; q < 4; q++) {
          sg[b] = ord[q][0]; sg[c] = ord[q][1];
          P4[q] = V(sg[0], sg[1], sg[2], a);
        }
        poly(pile, P4, cx, cy, cz, M.reg, M.col, uvs, ao);
      }
    }
    /* 12 chamfer strips, ESEG segments each */
    var edgeId = 0;
    for (a = 0; a < 3; a++) {
      var b2 = (a + 1) % 3, c2 = (a + 2) % 3;
      for (var sb = -1; sb <= 1; sb += 2) for (var sc = -1; sc <= 1; sc += 2) {
        var g0 = [0, 0, 0], g1 = [0, 0, 0];
        g0[a] = -1; g0[b2] = sb; g0[c2] = sc;
        g1[a] = 1; g1[b2] = sb; g1[c2] = sc;
        var A0 = V(g0[0], g0[1], g0[2], b2), A1 = V(g0[0], g0[1], g0[2], c2);
        var B1 = V(g1[0], g1[1], g1[2], c2), B0 = V(g1[0], g1[1], g1[2], b2);
        /* upward and outward edges catch more handling than tucked ones */
        var expo = 0.55 + 0.45 * clamp((A0[1] + A1[1] + B0[1] + B1[1]) * 0.25 - cy, -hy, hy) / Math.max(1e-4, hy);
        for (e = 0; e < es; e++) {
          var t0 = e / es, t1 = (e + 1) / es;
          var w0 = wearAmt * expo * fbm1(seed * 1.7 + edgeId * 4.3 + t0 * 2.6, 3) * 1.9;
          var w1 = wearAmt * expo * fbm1(seed * 1.7 + edgeId * 4.3 + t1 * 2.6, 3) * 1.9;
          var wm = (w0 + w1) * 0.5;
          P4[0] = [lerp(A0[0], B0[0], t0), lerp(A0[1], B0[1], t0), lerp(A0[2], B0[2], t0)];
          P4[1] = [lerp(A1[0], B1[0], t0), lerp(A1[1], B1[1], t0), lerp(A1[2], B1[2], t0)];
          P4[2] = [lerp(A1[0], B1[0], t1), lerp(A1[1], B1[1], t1), lerp(A1[2], B1[2], t1)];
          P4[3] = [lerp(A0[0], B0[0], t1), lerp(A0[1], B0[1], t1), lerp(A0[2], B0[2], t1)];
          if (wm > 0.44) {
            wearMix(_wc0, M, w0); wearMix(_wc1, M, w0);
            wearMix(_wc2, M, w1); wearMix(_wc3, M, w1);
            poly(pile, P4, cx, cy, cz, M.wreg, M.wcol, uvs, ao * 1.06, _wcs);
          } else {
            /* below the threshold the finish is intact -- just the faint
               brightening of a polished-by-handling edge */
            wearMix(_wc0, M, w0 * 0.5); wearMix(_wc1, M, w0 * 0.5);
            wearMix(_wc2, M, w1 * 0.5); wearMix(_wc3, M, w1 * 0.5);
            poly(pile, P4, cx, cy, cz, M.reg, M.col, uvs, ao * 1.04, _wcs);
          }
        }
        edgeId++;
      }
    }
    /* 8 corner tris -- the most exposed points on the part */
    var cid = 0;
    for (sz = -1; sz <= 1; sz += 2) for (sy = -1; sy <= 1; sy += 2) for (sx = -1; sx <= 1; sx += 2) {
      P3[0] = V(sx, sy, sz, 0); P3[1] = V(sx, sy, sz, 1); P3[2] = V(sx, sy, sz, 2);
      var wc = wearAmt * 1.45 * fbm1(seed * 2.9 + cid * 11.7, 3) * 1.9;
      cid++;
      if (wc > 0.44) poly(pile, P3, cx, cy, cz, M.wreg, M.wcol, uvs, ao * 1.08);
      else poly(pile, P3, cx, cy, cz, M.reg, wearMix(_wc0, M, wc * 0.5), uvs, ao * 1.06);
    }
  }

  /* ----------------------------------------------------------- lathe / loft */
  /* superellipse cross-section: n=2 ellipse, n=4 rounded rect, n=8 near-box */
  function pf(a, r, n) {
    var c = Math.cos(a);
    if (n === 2) return r * c;
    return r * (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), 2 / n);
  }
  function pg(a, r, n) {
    var s = Math.sin(a);
    if (n === 2) return r * s;
    return r * (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), 2 / n);
  }

  /* Lathe along Z. sections = [{ z, cx, cy, rx, ry, n, ao, uv, wear }].
     rx/ry of ~0 makes a pole so a nose cone closes without a fan cap.
     Rings sitting on a radius discontinuity are convex edges, so a curvature
     term auto-wears them the same way a chamfer strip wears. */
  function addLatheZ(pile, secs, sides, M, opt) {
    opt = opt || {};
    var S = secs.length, i, s, rows = [];
    if (S < 2) return;
    for (s = 0; s < S; s++) {
      var q = secs[s];
      if (!isFinite(fin(q.z, NaN)) || !isFinite(fin(q.rx, NaN))) {
        console.error('[nz-weapons] addLatheZ: bad section', s, opt.name || '(unnamed)'); return;
      }
    }
    var ao0 = fin(opt.ao, 1);
    var seed = fin(opt.seed, secs[0].z * 133 + fin(secs[0].rx) * 411);
    var span = Math.abs(secs[S - 1].z - secs[0].z) + fin(secs[0].rx) * 2;
    var sl = uvSlice(span, fin(opt.density, M.density), seed);
    var rot = fin(opt.rot, 0);
    var wearAmt = opt.wear === undefined ? M.wear : opt.wear;
    /* curvature per ring: how hard the profile turns here */
    var curv = new Float32Array(S);
    for (s = 0; s < S; s++) {
      var rP = fin(secs[Math.max(0, s - 1)].rx), rN = fin(secs[Math.min(S - 1, s + 1)].rx);
      var zP = fin(secs[Math.max(0, s - 1)].z), zN = fin(secs[Math.min(S - 1, s + 1)].z);
      var dz = Math.abs(zN - zP);
      curv[s] = dz > 1e-6 ? clamp(Math.abs(rN - rP) / dz, 0, 1) : 1;
      if (s === 0 || s === S - 1) curv[s] = Math.max(curv[s], 0.75);
    }
    for (s = 0; s < S; s++) {
      var sec = secs[s], row = [];
      var rx = fin(sec.rx), ry = fin(sec.ry, fin(sec.rx));
      var ex = fin(sec.n, 2), aoS = fin(sec.ao, 1) * ao0;
      var uvv = fin(sec.uv, S > 1 ? s / (S - 1) : 0);
      var pole = (Math.abs(rx) < 1e-5 && Math.abs(ry) < 1e-5);
      var lim = pole ? 0 : sides;
      var wRing = wearAmt * (sec.wear === undefined ? curv[s] : sec.wear);
      for (i = 0; i <= lim; i++) {
        var ang = (i / sides) * TAU + rot;
        var px = fin(sec.cx) + pf(ang, rx, ex);
        var py = fin(sec.cy) + pg(ang, ry, ex);
        /* down-facing side of a cylinder darkens: the same cavity cue as the
           chamfer boxes, so lathed and boxed parts sit in the same light */
        var sh = aoS * (1 - 0.24 * clamp(-Math.sin(ang), 0, 1));
        var w = wRing * fbm1(seed * 3.1 + (i / sides) * 7.0 + s * 2.3, 3) * 2.0;
        var cc = wearMix(_wc0, M, w);
        var t = uvMap(M.reg, pole ? 0.5 : (i / sides), uvv, sl[0], sl[1], sl[2]);
        row.push(pile.vert(px, py, fin(sec.z), t[0], t[1], cc[0] * sh, cc[1] * sh, cc[2] * sh));
      }
      rows.push(row);
    }
    var fwd = secs[S - 1].z < secs[0].z;
    for (s = 0; s < S - 1; s++) {
      var A = rows[s], B = rows[s + 1];
      var pa = A.length === 1, pb = B.length === 1;
      for (i = 0; i < sides; i++) {
        var a0 = A[pa ? 0 : i], a1 = A[pa ? 0 : i + 1];
        var b0 = B[pb ? 0 : i], b1 = B[pb ? 0 : i + 1];
        if (pa) { if (fwd) pile.tri(a0, b1, b0); else pile.tri(a0, b0, b1); }
        else if (pb) { if (fwd) pile.tri(a0, a1, b0); else pile.tri(a0, b0, a1); }
        else { if (fwd) pile.quad(a0, a1, b1, b0); else pile.quad(a0, b0, b1, a1); }
      }
    }
    if (opt.capStart) capRing(pile, rows[0], sides, fwd ? 1 : -1);
    if (opt.capEnd) capRing(pile, rows[S - 1], sides, fwd ? -1 : 1);
  }

  /* Loft along Y. sections = [{ y, cx, cz, rx, rz, n, ao, uv }].
     Grips, magazines, foregrips -- anything that runs vertically. */
  function addLoftY(pile, secs, sides, M, opt) {
    opt = opt || {};
    var S = secs.length, i, s, rows = [];
    if (S < 2) return;
    var ao0 = fin(opt.ao, 1);
    var seed = fin(opt.seed, fin(secs[0].y) * 219 + fin(secs[0].rx) * 77);
    var span = Math.abs(fin(secs[S - 1].y) - fin(secs[0].y)) + fin(secs[0].rx) * 2;
    var sl = uvSlice(span, fin(opt.density, M.density), seed);
    var rot = fin(opt.rot, 0);
    var wearAmt = opt.wear === undefined ? M.wear * 0.5 : opt.wear;
    for (s = 0; s < S; s++) {
      var sec = secs[s], row = [];
      var rx = fin(sec.rx), rz = fin(sec.rz, fin(sec.rx));
      var ex = fin(sec.n, 3), aoS = fin(sec.ao, 1) * ao0;
      var uvv = fin(sec.uv, S > 1 ? s / (S - 1) : 0);
      var pole = (Math.abs(rx) < 1e-5 && Math.abs(rz) < 1e-5);
      var lim = pole ? 0 : sides;
      for (i = 0; i <= lim; i++) {
        var ang = (i / sides) * TAU + rot;
        var px = fin(sec.cx) + pf(ang, rx, ex);
        var pz = fin(sec.cz) + pg(ang, rz, ex);
        /* the corners of a superellipse are its convex edges */
        var corner = Math.pow(Math.abs(Math.sin(ang * 2)), 6);
        var w = wearAmt * corner * fbm1(seed * 5.3 + (i / sides) * 9.1 + s * 1.7, 3) * 2.0;
        var cc = wearMix(_wc0, M, w);
        var t = uvMap(M.reg, pole ? 0.5 : (i / sides), uvv, sl[0], sl[1], sl[2]);
        row.push(pile.vert(px, fin(sec.y), pz, t[0], t[1], cc[0] * aoS, cc[1] * aoS, cc[2] * aoS));
      }
      rows.push(row);
    }
    var up = fin(secs[S - 1].y) >= fin(secs[0].y);
    for (s = 0; s < S - 1; s++) {
      var A = rows[s], B = rows[s + 1];
      var pa = A.length === 1, pb = B.length === 1;
      for (i = 0; i < sides; i++) {
        var a0 = A[pa ? 0 : i], a1 = A[pa ? 0 : i + 1];
        var b0 = B[pb ? 0 : i], b1 = B[pb ? 0 : i + 1];
        if (pa) { if (up) pile.tri(a0, b0, b1); else pile.tri(a0, b1, b0); }
        else if (pb) { if (up) pile.tri(a0, b0, a1); else pile.tri(a0, a1, b0); }
        else { if (up) pile.quad(a0, b0, b1, a1); else pile.quad(a0, a1, b1, b0); }
      }
    }
    if (opt.capStart) capRing(pile, rows[0], sides, up ? -1 : 1);
    if (opt.capEnd) capRing(pile, rows[S - 1], sides, up ? 1 : -1);
  }

  function capRing(pile, row, sides, dir) {
    if (row.length < 3) return;
    for (var i = 1; i < sides - 1; i++) {
      if (dir > 0) pile.tri(row[0], row[i], row[i + 1]);
      else pile.tri(row[0], row[i + 1], row[i]);
    }
  }

  /* A straight tapered capsule between two points -- finger bones, struts,
     sling loops, charging handles. Builds its own frame so it can point
     anywhere. */
  function addBone(pile, x0, y0, z0, x1, y1, z1, r0, r1, sides, M, opt) {
    opt = opt || {};
    var dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    var L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(L > 1e-6)) return;
    dx /= L; dy /= L; dz /= L;
    var ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.94) { ux = 1; uy = 0; }
    var tx = uy * dz - uz * dy, ty = uz * dx - ux * dz, tz = ux * dy - uy * dx;
    var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    var bx = dy * tz - dz * ty, by = dz * tx - dx * tz, bz = dx * ty - dy * tx;
    var rings = fin(opt.rings, 2), i, s;
    var ao = fin(opt.ao, 1);
    var sl = uvSlice(L + r0 * 2, fin(opt.density, M.density), fin(opt.seed, x0 * 311 + y0 * 71 + z0 * 17));
    var rows = [];
    var n = fin(opt.n, 2), round = fin(opt.round, 0);
    var wearAmt = opt.wear === undefined ? 0 : opt.wear;
    for (s = 0; s <= rings; s++) {
      var t = s / rings;
      var rr = lerp(r0, r1, t);
      if (round) {
        if (t < round) rr *= Math.sqrt(Math.max(0, 1 - Math.pow(1 - t / round, 2)));
        if (t > 1 - round) rr *= Math.sqrt(Math.max(0, 1 - Math.pow((t - (1 - round)) / round, 2)));
      }
      var cx2 = x0 + dx * L * t, cy2 = y0 + dy * L * t, cz2 = z0 + dz * L * t;
      var row = [];
      for (i = 0; i <= sides; i++) {
        var a = (i / sides) * TAU;
        var ca = pf(a, rr, n), sa = pg(a, rr, n);
        var px = cx2 + tx * ca + bx * sa;
        var py = cy2 + ty * ca + by * sa;
        var pz = cz2 + tz * ca + bz * sa;
        var sh = ao * (1 - 0.22 * clamp(-(ty * ca + by * sa) / Math.max(1e-5, rr), 0, 1));
        var w = wearAmt * (t < 0.12 || t > 0.88 ? 1 : 0.25) * fbm1(i * 1.7 + s * 3.3 + fin(opt.seed, 0), 2) * 2;
        var cc = wearMix(_wc0, M, w);
        var uvp = uvMap(M.reg, i / sides, t, sl[0], sl[1], sl[2]);
        row.push(pile.vert(px, py, pz, uvp[0], uvp[1], cc[0] * sh, cc[1] * sh, cc[2] * sh));
      }
      rows.push(row);
    }
    for (s = 0; s < rings; s++) {
      for (i = 0; i < sides; i++) {
        pile.quad(rows[s][i], rows[s][i + 1], rows[s + 1][i + 1], rows[s + 1][i]);
      }
    }
    if (opt.capStart) capRing(pile, rows[0], sides, -1);
    if (opt.capEnd) capRing(pile, rows[rings], sides, 1);
  }

  /* =========================================================================
     2. SHARED SMALL PARTS
     The details that separate a real model from a blockout: serrations,
     screws, sling loops, sights that actually align, magazine floorplates.
     ====================================================================== */

  /* A flat disc used to close a lathe so an open tube never shows the world
     through its own backfaces. `fwd` faces -Z (downrange), otherwise +Z. */
  function capDisc(pile, x, y, z, r, sides, M, fwd) {
    addLatheZ(pile, [
      { z: z, cx: x, cy: y, rx: r, n: 2, uv: 0 },
      { z: z + (fwd ? 0.0003 : -0.0003), cx: x, cy: y, rx: 0, n: 2, uv: 1 }
    ], sides, M, { ao: 0.9, density: 26, wear: 0, seed: x * 53 + z * 11 });
  }

  /* A closed collar / band around a tube: a diamond profile with both ends
     capped down to the tube radius, so there is no open annulus anywhere.
     The apex ring is the convex edge and wears. */
  function collar(pile, x, y, z0, z1, rIn, rOut, sides, M, seed) {
    addLatheZ(pile, [
      { z: z0, cx: x, cy: y, rx: rIn, n: 2, uv: 0, wear: 0.2 },
      { z: (z0 + z1) * 0.5, cx: x, cy: y, rx: rOut, n: 2, uv: .5, wear: 1 },
      { z: z1, cx: x, cy: y, rx: rIn, n: 2, uv: 1, wear: 0.2 }
    ], sides, M, { capStart: true, capEnd: true, density: 14, seed: seed || 0 });
  }

  /* A screw / pin head standing proud of a surface whose outward normal is
     (nx,ny,nz), with a slot cut across it. */
  function screw(pile, x, y, z, r, nx, ny, nz, M, Mslot) {
    var h = r * 0.42;
    addBone(pile, x, y, z, x + nx * h, y + ny * h, z + nz * h, r, r * 0.88, 10, M,
      { rings: 1, capStart: true, capEnd: true, ao: 1.06, density: 34, wear: 0.5,
        seed: x * 71 + y * 29 + z * 17 });
    /* slot: a dark sliver across the head, oriented deterministically */
    var ang = hash1(x * 311 + y * 17 + z * 91) * PI;
    var ox = Math.cos(ang) * r * 0.72, oy = Math.sin(ang) * r * 0.72;
    /* lay the slot in the plane perpendicular to the head normal */
    var sxv, syv, szv;
    if (Math.abs(nx) > 0.7) { sxv = 0; syv = ox; szv = oy; }
    else if (Math.abs(ny) > 0.7) { sxv = ox; syv = 0; szv = oy; }
    else { sxv = ox; syv = oy; szv = 0; }
    addBone(pile, x + nx * h - sxv, y + ny * h - syv, z + nz * h - szv,
      x + nx * h + sxv, y + ny * h + syv, z + nz * h + szv,
      r * 0.13, r * 0.13, 4, Mslot || M,
      { rings: 1, ao: 0.42, density: 40, seed: x * 7 + z * 3 });
  }

  /* a plain roll pin, no slot */
  function pin(pile, x, y, z, r, nx, ny, nz, M) {
    addBone(pile, x, y, z, x + nx * 0.0022, y + ny * 0.0022, z + nz * 0.0022,
      r, r * 0.86, 8, M,
      { rings: 1, capStart: true, capEnd: true, ao: 1.05, density: 34, wear: 0.4,
        seed: x * 71 + y * 29 + z * 17 });
  }

  /* a run of cocking serrations along Z on both flanks of a slide */
  function serrations(pile, x, y0, y1, z0, dz, count, depth, M) {
    for (var i = 0; i < count; i++) {
      var z = z0 + i * dz;
      var cy = (y0 + y1) * .5, hy = Math.abs(y1 - y0) * .5;
      addBox(pile, x, cy, z, depth, hy, Math.abs(dz) * .30, depth * .45, M,
        { ao: .74, density: 16, seed: i * 7 + z * 91, wear: M.wear * 1.5 });
      addBox(pile, -x, cy, z, depth, hy, Math.abs(dz) * .30, depth * .45, M,
        { ao: .74, density: 16, seed: i * 11 + z * 53, wear: M.wear * 1.5 });
    }
  }

  /* picatinny-style slots on a top rail. eseg 1: a 6mm cross-cut is a few
     pixels long, so the wear subdivision would never be visible and thirty
     of them at full subdivision is a third of the whole weapon's budget. */
  function railSlots(pile, hx, y, z0, dz, count, M) {
    for (var i = 0; i < count; i++) {
      addBox(pile, 0, y, z0 + i * dz, hx, 0.0021, Math.abs(dz) * .30, 0.0009, M,
        { ao: .58, density: 18, seed: i * 5 + z0 * 33, wear: M.wear * 1.3, eseg: 1 });
    }
  }

  /* A sling loop: a flattened torus approximated by four bones, so it reads
     as a closed loop from any angle without a torus primitive. */
  function slingLoop(pile, x, y, z, r, M, seed) {
    var N = 8, i, t = r * 0.22;
    for (i = 0; i < N; i++) {
      var a0 = (i / N) * TAU, a1 = ((i + 1) / N) * TAU;
      addBone(pile,
        x, y + Math.sin(a0) * r, z + Math.cos(a0) * r,
        x, y + Math.sin(a1) * r, z + Math.cos(a1) * r,
        t, t, 6, M, { rings: 1, density: 40, wear: 0.5, seed: seed + i });
    }
  }

  /* trigger guard: a chamfered loop in the XY plane */
  function triggerGuard(pile, zFront, zRear, yTop, yBot, hx, M) {
    var t = 0.0032;
    addBox(pile, 0, (yTop + yBot) * .5, zFront, hx, Math.abs(yTop - yBot) * .5, t, t * .5, M,
      { ao: .9, density: 14, seed: 5 });
    addBox(pile, 0, yBot, (zFront + zRear) * .5, hx, t, Math.abs(zRear - zFront) * .5, t * .5, M,
      { ao: .82, density: 14, seed: 6 });
    addBox(pile, 0, yBot + 0.009, zRear, hx, 0.010, t, t * .5, M,
      { ao: .85, density: 14, seed: 7 });
  }

  /* ---------------------------------------------------------------- sights */
  /* Both of these top out at exactly `sy`. That is the whole contract: in ADS
     the pose puts the local point (0, sy, *) on the camera axis, so the top of
     the rear notch and the top of the front post land on the same screen pixel
     and the sight picture is correct by construction, not by eye. */
  function rearNotch(pile, z, sy, gap, wall, h, depth, M, Mdot, seed) {
    var hw = wall * 0.5, off = gap * 0.5 + hw;
    for (var i = 0; i < 2; i++) {
      var sx = i ? off : -off;
      addBox(pile, sx, sy - h * 0.5, z, hw, h * 0.5, depth, Math.min(hw, h * 0.5) * 0.32, M,
        { ao: 1.05, density: 22, seed: seed + i, wear: M.wear * 1.4 });
      if (Mdot) {
        addBox(pile, sx, sy - h * 0.62, z - depth * 0.92, hw * 0.42, hw * 0.42, depth * 0.16, 0, Mdot,
          { ao: 1, density: 30, seed: seed + 8 + i, wear: 0 });
      }
    }
    /* the bar the notch stands on, so it reads as one machined part */
    addBox(pile, 0, sy - h - 0.0016, z, off + hw, 0.0018, depth, 0.0007, M,
      { ao: .92, density: 20, seed: seed + 16 });
  }
  function frontPost(pile, z, sy, w, h, depth, M, Mdot, seed, wings) {
    addBox(pile, 0, sy - h * 0.5, z, w * 0.5, h * 0.5, depth, Math.min(w, h) * 0.16, M,
      { ao: 1.05, density: 26, seed: seed, wear: M.wear * 1.5 });
    if (Mdot) {
      addBox(pile, 0, sy - h * 0.30, z - depth * 0.94, w * 0.30, w * 0.30, depth * 0.14, 0, Mdot,
        { ao: 1, density: 30, seed: seed + 3, wear: 0 });
    }
    if (wings) {
      for (var i = 0; i < 2; i++) {
        var sx = i ? wings : -wings;
        addBox(pile, sx, sy - h * 0.42, z, 0.0016, h * 0.58, depth * 0.9, 0.0007, M,
          { ao: .95, density: 24, seed: seed + 5 + i, wear: M.wear });
      }
    }
  }

  /* =========================================================================
     3. PROCEDURAL PBR ATLAS
     One 1024x512 sheet, eight 256px tiles. Every weapon and both hands share
     it, so the whole viewmodel is a handful of draw calls against a single
     material. Hue is vertex colour; the tiles are near-neutral.
     ====================================================================== */
  var ATLAS = null, REG = {};

  function buildRegions() {
    REG.nitride = region(0, 0, 256, 256);
    REG.alloy = region(256, 0, 256, 256);
    REG.poly = region(512, 0, 256, 256);
    REG.worn = region(768, 0, 256, 256);
    REG.glove = region(0, 256, 256, 256);
    REG.rubber = region(256, 256, 256, 256);
    REG.paint = region(512, 256, 256, 256);
    REG.trim = region(768, 256, 256, 256);
    /* sub-regions of the trim tile -- these must match the paint/emissive
       layout below exactly or a brass case ends up glowing */
    REG.brass = region(768 + 4, 256 + 132, 112, 120);
    REG.hull = region(768 + 130, 256 + 132, 62, 90);
    REG.dotG = region(768 + 10, 256 + 10, 44, 44);
    REG.dotA = region(768 + 78, 256 + 10, 44, 44);
    REG.lens = region(768 + 146, 256 + 10, 44, 44);
    REG.glass = region(768 + 200, 256 + 8, 48, 110);
  }
  buildRegions();

  /* per-tile ORM constants -- these MUST mirror the bake specs below.
     Order: nitride, alloy, polymer, worn steel, glove, rubber, paint, trim.

     These were the other half of the chrome problem. Nitrided steel at
     roughness 0.42 and bright steel at 0.17, both at metalness 0.95+, make a
     near-mirror: the GGX peak at alpha=0.029 is ~380x the incident radiance,
     so ANY directional light on the rig produced a blown white highlight, and
     the broad lobe returned the sky probe undiffused. Real firearm finishes
     are matte -- parkerising is a phosphate conversion coating, closer to
     0.60 than 0.40, and even a rubbed-through bearing surface only reaches
     0.34. The VARIANCE is also roughly doubled: roughness variation is what
     separates metal from painted metal from plastic, and 0.07 across a whole
     tile is not variation, it is a constant.

     Paint drops from metalness 0.35 to 0.08 -- baked enamel is a dielectric.
     Its 0.28 variance is deliberate: the chips in the height map are what
     expose bare metal, so the metalness comes back exactly where the paint
     is gone and nowhere else. */
  var T_ROUGH = [.62, .54, .68, .34, .86, .92, .60, .38];
  var T_ROUGHV = [.20, .19, .18, .16, .16, .12, .24, .26];
  var T_METAL = [.82, .80, .02, .95, .02, .00, .08, .74];
  var T_METALV = [.10, .10, .02, .05, .02, .00, .28, .26];

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
        var fine = T.fbm(r, { octaves: 3, frequency: 40, seed: 13 });
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

    /* ---- 1 anodised / machined aluminium: fine directional grain -------- */
    tiles.push(T.bake({
      res: res, seed: 23, base: '#a09e9d', grain: .05, ao: { strength: 0 },
      height: function (r) {
        var f = T.fbm(r, { octaves: 3, frequency: 52, seed: 29 });
        var g2 = T.fbm(r, { octaves: 3, frequency: 9, seed: 31 });
        var o = new Float32Array(r * r);
        for (var y = 0; y < r; y++) for (var x = 0; x < r; x++) {
          var i = y * r + x;
          /* brushing runs along one axis only -- that anisotropy is the tell
             for extruded and anodised alloy */
          /* x*5.7 was a 1.10-texel period -- pure aliasing noise, which is
             what made the ammo box read as chainmail */
          var brush = Math.sin(x * 1.42 + f[i] * 2.6) * .5 + .5;
          o[i] = clamp(.5 + brush * .10 + (f[i] - .5) * .12 + (g2[i] - .5) * .10, 0, 1);
        }
        return o;
      },
      normalScale: .9, rough: { base: T_ROUGH[1], variance: T_ROUGHV[1] },
      metal: { base: T_METAL[1], variance: T_METALV[1] }
    }));

    /* ---- 2 polymer: fine moulded stipple, broad soft specular ----------- */
    tiles.push(T.bake({
      res: res, seed: 41, base: '#918f8e', grain: .07, ao: { strength: 0 },
      height: function (r) {
        var cell = T.worley(r, { cells: 46, seed: 43, invert: true });
        var fine = T.fbm(r, { octaves: 3, frequency: 30, seed: 47 });
        var mould = T.fbm(r, { octaves: 2, frequency: 5, seed: 51 });
        var o = new Float32Array(r * r);
        for (var i = 0; i < o.length; i++) {
          o[i] = clamp(.46 + Math.pow(cell[i], 1.8) * .26 + (fine[i] - .5) * .12 +
            (mould[i] - .5) * .10, 0, 1);
        }
        return o;
      },
      normalScale: 2.0, rough: { base: T_ROUGH[2], variance: T_ROUGHV[2] },
      metal: { base: T_METAL[2], variance: T_METALV[2] }
    }));

    /* ---- 3 bright worn steel: what the finish rubs through TO ----------- */
    tiles.push(T.bake({
      res: res, seed: 59, base: '#cfccc8', grain: .05, ao: { strength: 0 },
      wear: { amount: .34, cells: 13, colour: '#e2ded8' },
      height: function (r) {
        var f = T.fbm(r, { octaves: 4, frequency: 30, seed: 61 });
        var w = T.worley(r, { cells: 16, seed: 67, invert: true });
        var o = new Float32Array(r * r);
        for (var y = 0; y < r; y++) for (var x = 0; x < r; x++) {
          var i = y * r + x;
          /* a few deep scratches; keep them sparse or it reads as sandpaper */
          var sc = Math.abs(Math.sin((x * .62 + y * .17) + f[i] * 6.0));
          o[i] = clamp(.58 + (w[i] - .5) * .12 + (f[i] - .5) * .12 - Math.pow(sc, 30) * .26, 0, 1);
        }
        return o;
      },
      normalScale: .7, rough: { base: T_ROUGH[3], variance: T_ROUGHV[3] },
      metal: { base: T_METAL[3], variance: T_METALV[3] }
    }));

    /* ---- 4 glove: nylon weave, leather palm patch, stitching ------------ */
    tiles.push(T.bake({
      res: res, seed: 71, base: '#98948f', grain: .10, ao: { strength: 0 },
      height: function (r) {
        var f = T.fbm(r, { octaves: 4, frequency: 24, seed: 73 });
        var pore = T.worley(r, { cells: 40, seed: 79, invert: true });
        var o = new Float32Array(r * r);
        for (var y = 0; y < r; y++) for (var x = 0; x < r; x++) {
          var i = y * r + x;
          var weave = (Math.sin(x * PI / 2.2) * Math.sin(y * PI / 2.2)) * .5 + .5;
          o[i] = clamp(.44 + weave * .22 + pore[i] * .16 + (f[i] - .5) * .20, 0, 1);
        }
        return o;
      },
      paint: function (g, r, h) {
        g.strokeStyle = 'rgba(34,32,30,.5)'; g.lineWidth = 2.5;
        g.setLineDash([5, 7]);
        g.beginPath(); g.moveTo(0, r * .34); g.lineTo(r, r * .30); g.stroke();
        g.beginPath(); g.moveTo(0, r * .71); g.lineTo(r, r * .76); g.stroke();
        g.setLineDash([]);
        void h;
      },
      normalScale: 2.2, rough: { base: T_ROUGH[4], variance: T_ROUGHV[4] },
      metal: { base: T_METAL[4], variance: T_METALV[4] }
    }));

    /* ---- 5 rubber: fine ribbing, recoil pad / grip sleeve --------------- */
    tiles.push(T.bake({
      res: res, seed: 89, base: '#888785', grain: .05, ao: { strength: 0 },
      height: function (r) {
        var f = T.fbm(r, { octaves: 4, frequency: 22, seed: 97 });
        var o = new Float32Array(r * r);
        for (var y = 0; y < r; y++) for (var x = 0; x < r; x++) {
          var i = y * r + x;
          var rib = Math.pow(Math.abs(Math.sin(y * .52)), .7);
          o[i] = clamp(.38 + rib * .40 + (f[i] - .5) * .16, 0, 1);
        }
        return o;
      },
      normalScale: 2.6, rough: { base: T_ROUGH[5], variance: T_ROUGHV[5] },
      metal: { base: T_METAL[5], variance: T_METALV[5] }
    }));

    /* ---- 6 stamped steel under baked paint: orange peel + chips --------- 
       Orange peel is a LOW frequency ripple in the clearcoat, not a grain.
       Getting that wavelength right is what makes painted metal read as
       painted metal instead of plastic. */
    tiles.push(T.bake({
      res: res, seed: 101, base: '#93968f', grain: .05, ao: { strength: 0 },
      wear: { amount: .30, cells: 12, colour: '#5f625c' },
      height: function (r) {
        var peel = T.fbm(r, { octaves: 3, frequency: 13, seed: 103 });
        var chip = T.worley(r, { cells: 9, seed: 107, invert: true });
        var fine = T.fbm(r, { octaves: 3, frequency: 34, seed: 109 });
        var o = new Float32Array(r * r);
        for (var i = 0; i < o.length; i++) {
          var ch = clamp((chip[i] - .70) * 5.0, 0, 1);
          o[i] = clamp(.54 + (peel[i] - .5) * .30 + (fine[i] - .5) * .07 - ch * .16, 0, 1);
        }
        return o;
      },
      paint: function (g, r) {
        /* stencilled lot markings: unreadable at range, expensive up close */
        g.fillStyle = 'rgba(214,218,210,.30)';
        g.font = 'bold ' + Math.round(r * .070) + 'px monospace';
        g.fillText('PG-7VM', r * .07, r * .28);
        g.fillText('4-19', r * .07, r * .39);
      },
      normalScale: 1.4, rough: { base: T_ROUGH[6], variance: T_ROUGHV[6] },
      metal: { base: T_METAL[6], variance: T_METALV[6] }
    }));

    /* ---- 7 trim host: brass, shotshell hull, tritium dots, lens --------- */
    tiles.push(T.bake({
      res: res, seed: 113, base: '#d4d1cd', grain: .04, ao: { strength: 0 },
      height: function (r) {
        var f = T.fbm(r, { octaves: 4, frequency: 16, seed: 127 });
        var o = new Float32Array(r * r);
        for (var i = 0; i < o.length; i++) o[i] = clamp(.5 + (f[i] - .5) * .32, 0, 1);
        return o;
      },
      paint: function (g, r) {
        void r;
        /* Layout shared with the emissive sheet below; they must not overlap
           or brass cases glow green. Top strip: tritium/lens hosts, dark.
           Right column: glass. Bottom left: brass. Bottom middle: red hull. */
        g.fillStyle = '#23262a'; g.fillRect(0, 0, 256, 66);
        g.fillStyle = '#1a1d21'; g.fillRect(196, 0, 60, 128);
        var bg = g.createLinearGradient(0, 128, 120, 256);
        bg.addColorStop(0, '#d3aa4c'); bg.addColorStop(.55, '#b58c35'); bg.addColorStop(1, '#8a6924');
        g.fillStyle = bg; g.fillRect(0, 128, 120, 128);
        g.fillStyle = '#8f2420'; g.fillRect(126, 128, 70, 128);
        g.fillStyle = '#c2b184'; g.fillRect(126, 228, 70, 28);
      },
      normalScale: 1.0, rough: { base: T_ROUGH[7], variance: T_ROUGHV[7] },
      metal: { base: T_METAL[7], variance: T_METALV[7] }
    }));

    /* ---- composite the eight tiles ------------------------------------- */
    var AW = 1024, AH = 512, t, x, y;
    var alb = document.createElement('canvas'); alb.width = AW; alb.height = AH;
    var ga = alb.getContext('2d');
    var pos = [];
    for (t = 0; t < 8; t++) {
      var px = (t % 4) * 256, py = (t / 4 | 0) * 256;
      pos.push([px, py]);
      ga.drawImage(tiles[t].canvas, px, py);
    }

    var H = new Float32Array(AW * AH);
    for (t = 0; t < 8; t++) {
      var hp = tiles[t].height, ox = pos[t][0], oy = pos[t][1];
      for (y = 0; y < 256; y++) for (x = 0; x < 256; x++)
        H[(oy + y) * AW + ox + x] = hp[y * 256 + x];
    }
    /* 1.9 made every worley cell a lit pebble; at viewmodel distance that
       is the single loudest "procedural" tell on the model */
    var nrm = canvasFromRGBA(normalFromHeightRect(H, AW, AH, 1.25), AW, AH);

    /* ORM: three.js reads roughness from G and metalness from B */
    var orm = document.createElement('canvas'); orm.width = AW; orm.height = AH;
    var go = orm.getContext('2d');
    var oid = go.createImageData(AW, AH), od = oid.data;
    for (t = 0; t < 8; t++) {
      var hh = tiles[t].height, oxx = pos[t][0], oyy = pos[t][1];
      for (y = 0; y < 256; y++) for (x = 0; x < 256; x++) {
        var hi = hh[y * 256 + x];
        var j = ((oyy + y) * AW + oxx + x) * 4;
        od[j] = 255;
        od[j + 1] = clamp(T_ROUGH[t] + (hi - .5) * T_ROUGHV[t] * 2, .035, 1) * 255;
        od[j + 2] = clamp(T_METAL[t] + (hi - .5) * T_METALV[t] * 2, 0, 1) * 255;
        od[j + 3] = 255;
      }
    }
    go.putImageData(oid, 0, 0);

    /* Emissive sheet: black except the tritium dots and the optic lens.
       Restraint on purpose -- the old glowing charge strips and ammo LEDs
       were the campiest thing on the weapon and had no business on a
       photoreal firearm. */
    var emi = document.createElement('canvas'); emi.width = AW; emi.height = AH;
    var ge = emi.getContext('2d');
    ge.fillStyle = '#000'; ge.fillRect(0, 0, AW, AH);
    var ex = pos[7][0], ey = pos[7][1];
    function patch(cx2, cy2, r2, col) {
      var gg = ge.createRadialGradient(ex + cx2, ey + cy2, 1, ex + cx2, ey + cy2, r2);
      gg.addColorStop(0, col); gg.addColorStop(.5, col); gg.addColorStop(1, '#000');
      ge.fillStyle = gg; ge.beginPath(); ge.arc(ex + cx2, ey + cy2, r2, 0, TAU); ge.fill();
    }
    patch(32, 32, 22, '#4ad978');    /* green tritium, rear */
    patch(100, 32, 22, '#d9a63a');   /* amber tritium, front */
    patch(168, 32, 22, '#4f7fa8');   /* optic lens bloom */

    function mk(canvas, srgb) {
      var tx = new THREE.CanvasTexture(canvas);
      tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
      if (srgb) { if (THREE.SRGBColorSpace) tx.colorSpace = THREE.SRGBColorSpace; else tx.encoding = THREE.sRGBEncoding; }
      tx.anisotropy = 8;
      return tx;
    }

    ATLAS = { map: mk(alb, true), normalMap: mk(nrm, false), orm: mk(orm, false), emissiveMap: mk(emi, false) };
    for (t = 0; t < 8; t++) { try { tiles[t].dispose(); } catch (e) { } }
  }

  /* rectangular sobel; nz-core's height->normal is square-only */
  function normalFromHeightRect(h, w, hgt, strength) {
    var out = new Uint8ClampedArray(w * hgt * 4);
    function at(x, y) {
      x = x < 0 ? 0 : x >= w ? w - 1 : x;
      y = y < 0 ? 0 : y >= hgt ? hgt - 1 : y;
      return h[y * w + x];
    }
    for (var y = 0; y < hgt; y++) for (var x = 0; x < w; x++) {
      var tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      var l = at(x - 1, y), r = at(x + 1, y);
      var bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      var dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      var dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      var nx = -dx * strength, ny = -dy * strength, nz = 1;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      var i = (y * w + x) * 4;
      out[i] = (nx / len * .5 + .5) * 255;
      out[i + 1] = (ny / len * .5 + .5) * 255;
      out[i + 2] = (nz / len * .5 + .5) * 255;
      out[i + 3] = 255;
    }
    return out;
  }
  function canvasFromRGBA(data, w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'), id = g.createImageData(w, h);
    id.data.set(data); g.putImageData(id, 0, 0);
    return c;
  }

  /* Small standalone sprites (flash, smoke) -- these want alpha and their own
     shape, so they are painted directly rather than going through the bakery. */
  function flashTexture() {
    var r = 128, c = document.createElement('canvas'); c.width = c.height = r;
    var g = c.getContext('2d');
    g.clearRect(0, 0, r, r);
    var cx = r / 2, cy = r / 2;
    var gr = g.createRadialGradient(cx, cy, 1, cx, cy, r * .26);
    gr.addColorStop(0, 'rgba(255,255,248,1)');
    gr.addColorStop(.34, 'rgba(255,224,148,.80)');
    gr.addColorStop(1, 'rgba(255,138,42,0)');
    g.fillStyle = gr; g.fillRect(0, 0, r, r);
    /* a real flash is a short ragged star, not a disc and not a firework */
    g.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 7; i++) {
      var a = (i / 7) * TAU + hash1(i * 3.3) * .55;
      var len = r * (.16 + hash1(i * 7.1) * .22);
      var wdt = r * (.026 + hash1(i * 11.3) * .036);
      g.save(); g.translate(cx, cy); g.rotate(a);
      var pg2 = g.createLinearGradient(0, 0, len, 0);
      pg2.addColorStop(0, 'rgba(255,232,172,.78)');
      pg2.addColorStop(.5, 'rgba(255,162,54,.28)');
      pg2.addColorStop(1, 'rgba(255,92,18,0)');
      g.fillStyle = pg2;
      g.beginPath(); g.moveTo(0, -wdt); g.lineTo(len, -wdt * .18); g.lineTo(len, wdt * .18); g.lineTo(0, wdt); g.closePath(); g.fill();
      g.restore();
    }
    var t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function smokeTexture() {
    var r = 128, c = document.createElement('canvas'); c.width = c.height = r;
    var g = c.getContext('2d');
    g.clearRect(0, 0, r, r);
    for (var i = 0; i < 22; i++) {
      var a = hash1(i * 5.7) * TAU, d = hash1(i * 9.1) * r * .22;
      var x = r / 2 + Math.cos(a) * d, y = r / 2 + Math.sin(a) * d;
      var rad = r * (.10 + hash1(i * 13.7) * .17);
      var gr = g.createRadialGradient(x, y, 1, x, y, rad);
      gr.addColorStop(0, 'rgba(198,200,203,.18)');
      gr.addColorStop(1, 'rgba(146,148,152,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
    var vg = g.createRadialGradient(r / 2, r / 2, r * .30, r / 2, r / 2, r * .50);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = vg; g.fillRect(0, 0, r, r);
    var t = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding;
    return t;
  }

  /* =========================================================================
     4. PALETTE + MATERIAL TABLE
     Linear space. The frame runs ACES at exposure ~1.18, so authoring at sRGB
     brightness blows the metal out immediately. Real gun finishes are much
     darker than people expect: parkerised steel is roughly 4% reflectance.
     ====================================================================== */
  /* The WEAR targets are the numbers that were painting the chrome. A wear
     strip runs along every convex chamfer on the model, it switches to the
     bright-steel atlas tile, and at 0.30 albedo on a roughness-0.17 metal it
     drew a lit white outline around every edge of every part -- the "blinding
     chrome slab" read. Rubbed-through parkerising is a dull grey sheen, not
     nickel: the targets come down by a third and the tile they land on is now
     roughness 0.34 rather than 0.17. Base tones are nudged UP very slightly
     off pure black so the unlit side of the weapon still has form. */
  var C = {
    /* Every tint here used to run b > g > r. Combined with a blue light rig
       and a blue sky probe that is three coincident votes for violet, and ACES
       turns a bright saturated blue into magenta. Gun finishes are neutral to
       WARM grey -- parkerising is a manganese phosphate, nitride is a warm
       near-black. Only anodised alloy and glass stay cool, and only barely. */
    /* These are MULTIPLIERS on the atlas tile, whose own base sits around 0.28
       linear, so the number that matters is tint x 0.28. The old table put
       nitride at 0.062 x 0.29 = 0.018 final -- and on a metal the albedo IS
       F0, so that is a surface reflecting 1.8% of what hits it. Nothing is
       that dark. What made it LOOK bright was a mirror-sharp lobe (roughness
       0.17-0.42) concentrating the whole sky into a highlight; drop the
       roughness in and the same surface becomes a black hole instead.
       Metals go up ~2.6x into a real F0 band (nitride lands at 4.7%
       reflectance, worn steel at 25%) while the roughness rise, the probe cut
       and the rim cut take the specular energy back DOWN. The wear tints --
       the chamfer strips that were drawing a white outline around every part
       on the model -- go up only 2x, so they end up net darker than before.

       Dielectrics move much further. Olive paint at 0.052 x 0.29 = 0.015 is
       blacker than matte black; olive drab is 0.05. Polymer, glove, rubber
       and the shotshell hull were all in the same hole, which is what made
       the RPG read as a silhouette with no interior and the hand as a mitten. */
    nitride: [.161, .156, .151],   /* phosphate: near-black, faintly warm */
    nitrideW: [.310, .300, .290],  /* what it rubs through to */
    slide: [.130, .125, .120],
    alloy: [.221, .224, .234],     /* hard anodised, a touch cool */
    alloyD: [.151, .153, .161],
    alloyW: [.288, .286, .292],
    /* Type-III hard anodise on a modern rifle: near-black and WARM, several
       stops darker than the older mil-spec anodise above. Three tones because
       an upper, a lower and a handguard are three separate anodising batches
       and on a real rifle they never match -- that mismatch is one of the
       cheapest and most convincing realism cues available on a gun model. */
    anod: [.144, .141, .136],      /* upper: the reference batch */
    anodL: [.157, .153, .147],     /* lower: half a stop lighter */
    anodH: [.169, .164, .156],     /* handguard: a visibly different batch */
    anodD: [.121, .119, .115],     /* rail / small parts, darkest */
    anodW: [.276, .270, .261],     /* rubbed through to bare aluminium */
    poly: [.115, .112, .108],      /* polymer furniture */
    polyL: [.160, .156, .152],
    polyW: [.250, .244, .238],
    steel: [.390, .382, .374],
    steelD: [.255, .247, .239],
    steelW: [.398, .388, .378],
    dark: [.013, .013, .012],
    brass: [.950, .920, .850],
    olive: [.150, .168, .108],     /* RPG tube, drab green over steel */
    oliveD: [.108, .126, .078],
    oliveW: [.330, .312, .258],
    wood: [.200, .115, .062],
    rubber: [.090, .087, .084],
    glove: [.105, .102, .098],
    gloveL: [.150, .145, .140],
    warhead: [.290, .125, .082],
    glass: [.100, .120, .150],
    glow: [1, 1, 1]
  };

  /* Material descriptors. The fourth/fifth arguments are the wear target:
     where the finish goes when it rubs through. That is the ONE thing that
     makes a procedural gun stop looking procedural. */
  var M = {};
  function buildMaterials() {
    M.nitride = material(REG.nitride, C.nitride, 0.50, REG.worn, C.nitrideW, 6.5);
    M.nitrideLow = material(REG.nitride, C.nitride, 0.24, REG.worn, C.nitrideW, 6.5);
    M.slide = material(REG.nitride, C.slide, 0.58, REG.worn, C.nitrideW, 6.5);
    M.alloy = material(REG.alloy, C.alloy, 0.38, REG.worn, C.alloyW, 6.0);
    M.alloyD = material(REG.alloy, C.alloyD, 0.34, REG.worn, C.alloyW, 7.0);
    /* hard-anodised set. Same atlas tile (roughness 0.54 +/- 0.19, i.e. the
       ~0.55 satin of a Type-III finish), different tint and different wear
       budget per part: rail corners and the magwell lip take the most
       handling on a carbine, the receiver flats almost none. */
    M.anod = material(REG.alloy, C.anod, 0.40, REG.worn, C.anodW, 6.0);
    M.anodL = material(REG.alloy, C.anodL, 0.36, REG.worn, C.anodW, 6.5);
    M.anodH = material(REG.alloy, C.anodH, 0.32, REG.worn, C.anodW, 6.0);
    M.anodD = material(REG.alloy, C.anodD, 0.46, REG.worn, C.anodW, 8.0);
    M.anodLip = material(REG.alloy, C.anodL, 0.72, REG.worn, C.anodW, 7.0);
    M.poly = material(REG.poly, C.poly, 0.26, REG.poly, C.polyW, 6.5);
    M.polyL = material(REG.poly, C.polyL, 0.30, REG.poly, C.polyW, 7.5);
    M.steel = material(REG.worn, C.steel, 0.44, REG.worn, C.steelW, 9.0);
    M.steelD = material(REG.nitride, C.steelD, 0.46, REG.worn, C.steelW, 9.0);
    M.dark = material(REG.nitride, C.dark, 0.10, REG.worn, C.nitrideW, 9.0);
    M.paint = material(REG.paint, C.olive, 0.46, REG.worn, C.oliveW, 4.0);
    M.paintD = material(REG.paint, C.oliveD, 0.50, REG.worn, C.oliveW, 5.0);
    M.wood = material(REG.poly, C.wood, 0.22, REG.poly, C.polyW, 5.0);
    M.rubber = material(REG.rubber, C.rubber, 0.10, REG.rubber, C.rubber, 8.0);
    M.glove = material(REG.glove, C.glove, 0, REG.glove, C.glove, 9.0);
    M.gloveL = material(REG.glove, C.gloveL, 0, REG.glove, C.gloveL, 9.0);
    M.brass = material(REG.brass, C.brass, 0.25, REG.worn, C.steelW, 22.0);
    /* REG.hull is an already-red patch of the trim tile, so this tint is a
       near-neutral multiplier, not the hull colour. At .140/.030/.024 the
       red was multiplied twice and the shell came out black. */
    M.hull = material(REG.hull, [.620, .550, .520], 0.15, REG.hull, [.780, .620, .580], 22.0);
    M.dotG = material(REG.dotG, C.glow, 0, REG.dotG, C.glow, 30.0);
    M.dotA = material(REG.dotA, C.glow, 0, REG.dotA, C.glow, 30.0);
    M.lens = material(REG.lens, C.glow, 0, REG.lens, C.glow, 26.0);
    M.glass = material(REG.glass, C.glass, 0, REG.glass, C.glass, 26.0);
    M.warhead = material(REG.paint, C.warhead, 0.34, REG.worn, C.oliveW, 6.0);
  }
  buildMaterials();

  /* =========================================================================
     5. HANDS
     Built once as a right hand and instanced mirrored for the support hand.
     three.js flips the winding for a negative-determinant world matrix, so a
     scale.x of -1 is a correct mirror, not an inside-out mesh.
     Local frame: the gripped object's axis is +Y, +X is the back of the hand,
     -Z is downrange. Origin sits at the centre of the grip. Sized for a grip
     of half-width 0.015 and half-depth 0.027 -- a real service-pistol grip --
     so the fingers close on the front strap instead of floating off it.
     ====================================================================== */
  var HAND = { geo: null, finger: null, fingerW: null, arm: null, armLong: null };
  var WRIST = [0.028, -0.048, 0.014];

  function buildHands() {
    var pile = new Pile();
    var s = 8;

    /* Forearm + cuff on its own node. A support hand on a horizontal forend
       rotates 90 degrees to grip it, and without a wrist joint the arm would
       then point straight at the camera instead of down out of frame. */
    var arm = new Pile();
    addBone(arm, 0, 0, 0, 0.022, -0.098, 0.012, 0.0215, 0.0262, 10,
      material(REG.glove, [.082, .086, .078], 0, null, null, 9),
      { rings: 3, capEnd: true, n: 2.6, ao: .82, seed: 3 });
    addBone(arm, -0.001, 0.005, -0.002, 0.006, -0.026, 0.004, 0.0252, 0.0244, 10,
      M.gloveL, { rings: 1, n: 3.0, ao: .95, seed: 9 });
    addBone(arm, 0.000, 0.000, 0.000, 0.003, -0.013, 0.002, 0.0276, 0.0268, 10,
      material(REG.rubber, [.126, .122, .116], 0, null, null, 12),
      { rings: 1, n: 3.0, ao: .9, seed: 11 });
    HAND.arm = pileToGeometry(arm);

    /* The SUPPORT forearm. The 10cm stub above is sized for the firing hand,
       whose wrist already sits at the bottom edge of the frame -- its cut end
       never renders. The support hand rides the forend at MID-FRAME height,
       where the same stub ends in plain view: a capped tube hanging in the
       air. This one is wrist-to-past-the-frame-edge -- 36cm along the bone
       path, sized against the mid-handguard grip -- so, angled down and back
       toward the player's elbow by the per-weapon gl.arm channel, it leaves
       the frame before it ends. The bend is kept in +X only (screen-left
       after the mirror): an X drift stays lateral under the arm node's big X
       rotation, while a Z drift would rotate into 'up' and fight the drop
       that gets it off screen.

       It is dressed as a SLEEVE, not skin and not more glove: an olive
       combat-shirt forearm on the nylon-weave tile (density 7, so the weave
       reads at arm distance), pushed up and bunched above the wrist the way
       every shooter wears one. The first read of the old tube was 'thin
       pipe': radii now run 0.025 at the glove cuff to 0.043 at the cut --
       fabric over a forearm, thickening toward the elbow -- and the two
       bunch rings sit slightly PROUD of the taper with alternating AO, which
       is what says 'rolled cloth' instead of 'lathe'. AO falls gently to .66
       so the arm darkens as it leaves the lit weapon and never pulls the eye
       off the sights. Wear 0.18 with a pale threadbare accent keeps the
       cloth from reading as one flat green. */
    var armS = new Pile();
    var sleeve = material(REG.glove, [.148, .158, .118], 0.18, REG.glove, [.235, .245, .195], 7.0);
    var sleeveD = material(REG.glove, [.118, .128, .092], 0.18, REG.glove, [.205, .215, .168], 7.0);
    /* glove cuff + rubber ring at the wrist, same set as the firing arm */
    addBone(armS, -0.001, 0.005, -0.002, 0.006, -0.026, 0.004, 0.0252, 0.0244, 10,
      M.gloveL, { rings: 1, n: 3.0, ao: .95, seed: 9 });
    addBone(armS, 0.000, 0.000, 0.000, 0.003, -0.013, 0.002, 0.0276, 0.0268, 10,
      material(REG.rubber, [.126, .122, .116], 0, null, null, 12),
      { rings: 1, n: 3.0, ao: .9, seed: 11 });
    /* sleeve cuff: sits proud of the glove it covers */
    addBone(armS, 0.000, -0.020, 0.000, 0.005, -0.062, 0.001, 0.0250, 0.0298, 10,
      sleeveD, { rings: 2, capStart: true, n: 2.6, ao: .88, seed: 3 });
    /* forearm proper */
    addBone(armS, 0.005, -0.062, 0.001, 0.014, -0.160, 0.002, 0.0298, 0.0338, 10,
      sleeve, { rings: 3, n: 2.5, ao: .80, seed: 5 });
    /* bunched roll above the wrist-half: two proud rings, cloth gathered */
    addBone(armS, 0.014, -0.160, 0.002, 0.018, -0.196, 0.003, 0.0368, 0.0352, 10,
      sleeveD, { rings: 1, n: 2.4, ao: .84, seed: 13 });
    addBone(armS, 0.018, -0.196, 0.003, 0.022, -0.228, 0.003, 0.0374, 0.0360, 10,
      sleeve, { rings: 1, n: 2.4, ao: .74, seed: 15 });
    /* upper forearm to the cut, thickening toward the unseen elbow */
    addBone(armS, 0.022, -0.228, 0.003, 0.034, -0.360, 0.005, 0.0378, 0.0430, 10,
      sleeveD, { rings: 2, capEnd: true, n: 2.5, ao: .66, seed: 7 });
    HAND.armLong = pileToGeometry(armS);

    /* back of the hand: a rounded slab riding the +X flank of the grip */
    addLoftY(pile, [
      { y: 0.034, cx: 0.026, cz: 0.004, rx: 0.0125, rz: 0.0215, n: 3.4, ao: .96, uv: 0 },
      { y: 0.012, cx: 0.028, cz: 0.002, rx: 0.0152, rz: 0.0255, n: 3.6, ao: 1.0, uv: .3 },
      { y: -0.016, cx: 0.028, cz: 0.002, rx: 0.0152, rz: 0.0262, n: 3.6, ao: 1.0, uv: .65 },
      { y: -0.042, cx: 0.024, cz: 0.008, rx: 0.0122, rz: 0.0215, n: 3.2, ao: .92, uv: 1 }
    ], 12, M.glove, { capStart: true, capEnd: true, seed: 17, density: 9, wear: 0 });

    /* palm heel pressed against the backstrap */
    addLoftY(pile, [
      { y: 0.018, cx: 0.011, cz: 0.025, rx: 0.0115, rz: 0.0088, n: 3.2, ao: .82, uv: 0 },
      { y: -0.030, cx: 0.011, cz: 0.027, rx: 0.0132, rz: 0.0096, n: 3.2, ao: .78, uv: 1 }
    ], 10, M.gloveL, { capStart: true, capEnd: true, seed: 21, density: 11, wear: 0 });

    /* Knuckles and fingers. The previous pitch was 0.017 between finger axes
       against a 0.0173 combined diameter, so every finger touched its
       neighbours: three tubes with no gap and one flat glove tone between
       them merge into a single mass, which is exactly the mitten read. Pitch
       is now 0.0195-0.0190 against 0.0158-0.0142 of diameter, i.e. a real
       3.5-4.8 mm slot between fingers, and adjacent fingers alternate between
       the two glove tones so the separation survives even when the slot is
       edge-on to the key. 10 sides rather than 8: a finger is the closest
       thing on the model to the eye and 8 facets read at this distance. */
    var ky = [0.0200, 0.0030, -0.0165, -0.0355];
    var kr = [0.0082, 0.0085, 0.0078, 0.0068];
    var kM = [M.gloveL, M.glove, M.gloveL, M.glove];
    for (var i = 0; i < 4; i++) {
      addBone(pile, 0.024, ky[i], -0.013, 0.0312, ky[i] + 0.002, -0.018, kr[i], kr[i] * .82, 10,
        kM[i], { rings: 1, capStart: true, capEnd: true, round: .45, seed: 30 + i });
    }

    /* three wrapping fingers (the index is a separate node so it can work the
       trigger). Each is three phalanges curling around the front strap. */
    var fy = [0.0030, -0.0165, -0.0355];
    var fr = [0.0082, 0.0076, 0.0066];
    var fM = [M.glove, M.gloveL, M.glove];
    var fl = [[0.026, 0.019, 0.014], [0.025, 0.018, 0.013], [0.021, 0.015, 0.012]];
    for (i = 0; i < 3; i++) {
      wrapFinger(pile, 0.0288, fy[i], -0.0175, fr[i], fl[i], fM[i], 40 + i * 5, 10);
    }

    /* thumb: rides up and over to the left flank of the frame */
    addBone(pile, 0.028, 0.026, 0.013, 0.013, 0.043, -0.013, 0.0120, 0.0104, s,
      M.gloveL, { rings: 2, capStart: true, seed: 61, round: .2 });
    addBone(pile, 0.013, 0.043, -0.013, -0.004, 0.046, -0.045, 0.0104, 0.0085, s,
      M.glove, { rings: 2, capEnd: true, seed: 63, round: .28 });

    /* strap across the back of the hand + its buckle */
    addBox(pile, 0.028, -0.004, 0.002, 0.0165, 0.0052, 0.0278, 0.0016,
      material(REG.rubber, [.120, .114, .110], 0, null, null, 12), { ao: 1.02, seed: 71 });
    addBox(pile, 0.0445, -0.004, 0.010, 0.0032, 0.0070, 0.0070, 0.0011,
      M.steelD, { ao: 1.05, density: 22, seed: 73 });

    HAND.geo = pileToGeometry(pile);

    /* Index finger, origin at the MCP joint so one rotation curls the whole
       chain. Built pointing forward: the animation pulls it back onto the
       trigger and it lies along the frame when off it. */
    var fp = new Pile();
    wrapFinger(fp, 0, 0, 0, 0.0092, [0.022, 0.017, 0.013], M.glove, 81, s, true);
    HAND.finger = pileToGeometry(fp);

    /* A second, already-wrapped index for the support hand -- reusing the
       straight one there left a finger sticking out into space. */
    var fw = new Pile();
    wrapFinger(fw, 0, 0, 0, 0.0092, [0.025, 0.018, 0.014], M.glove, 91, s, false);
    HAND.fingerW = pileToGeometry(fw);
  }

  /* One finger curling around a grip: forward, inward, then back toward the
     palm. `straight` builds it laid out along -Z for the trigger finger. */
  function wrapFinger(pile, x, y, z, r, L, Mat, seed, sides, straight) {
    var p0 = [x, y, z], dirs;
    if (straight) {
      /* The trigger finger is built ON the trigger, not pointing off into
         space: solved so the pad lands at weapon-space (0, -0.025, -0.044),
         which is the middle of the trigger face after the grip node's own
         rotation and 0.96 scale. The animation then STRAIGHTENS it off the
         trigger, so the rest pose is the one that can never intersect. */
      dirs = [[-0.30, 0.02, -0.954], [-0.72, -0.12, -0.684], [-0.86, -0.36, -0.36]];
    } else {
      dirs = [[-0.42, -0.04, -0.90], [-0.94, -0.02, -0.28], [-0.62, 0.02, 0.78]];
    }
    var rr = r;
    for (var i = 0; i < 3; i++) {
      var d = dirs[i], l = L[i];
      var p1 = [p0[0] + d[0] * l, p0[1] + d[1] * l, p0[2] + d[2] * l];
      /* the shaft of each phalanx is shaded DOWN toward the tip and the joint
         knuckle is shaded UP, so a finger has an alternating light/dark rhythm
         along its length. That rhythm is what says "three joints" at a glance;
         a constant-tone tube says "sausage" however round it is. */
      addBone(pile, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], rr, rr * 0.86, sides,
        Mat, {
          rings: 2, capStart: i === 0, capEnd: i === 2, seed: seed + i,
          round: i === 2 ? 0.34 : 0, ao: 0.90 - i * 0.06
        });
      if (i < 2) {
        addBone(pile, p1[0], p1[1], p1[2] + 0.001, p1[0], p1[1], p1[2] - 0.001,
          rr * 1.02, rr * 1.02, sides, Mat,
          { rings: 1, capStart: true, capEnd: true, ao: 1.12 - i * 0.06, seed: seed + 20 + i });
      }
      p0 = p1; rr *= 0.86;
    }
  }

  /* =========================================================================
     6. WEAPON BUILDS
     Local frame: +X right, +Y up, -Z downrange. The origin is the web of the
     firing hand -- the top rear of the grip -- so every pose rotation happens
     where the hand actually holds it, and every dimension below can be read
     straight off a spec sheet.
     ====================================================================== */

  var WEAPONS = {};

  function makeNode(parent, name) {
    var o = new THREE.Group(); o.name = name; parent.add(o); return o;
  }
  function meshOf(pile, mat, name) {
    if (!pile.n) return null;
    var m = new THREE.Mesh(pileToGeometry(pile), mat);
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    m.frustumCulled = false;
    return m;
  }
  function push(A, node, pile, mat, name) {
    var m = meshOf(pile, mat, name);
    if (m) { node.add(m); A.meshes.push(m); }
    if (pile.n) {
      if (!A.bbox) A.bbox = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
      for (var i = 0; i < 3; i++) {
        if (pile.min[i] < A.bbox.min[i]) A.bbox.min[i] = pile.min[i];
        if (pile.max[i] > A.bbox.max[i]) A.bbox.max[i] = pile.max[i];
      }
    }
  }

  /* -------------------------------------------------------------- pistol --
     A 9mm service pistol. Slide 186mm, overall 204mm, grip 112mm, sight
     radius 158mm, slide 25.6mm wide. Those are Glock-17 numbers.
     ---------------------------------------------------------------------- */
  function buildPistol(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-pistol';
    var body = new Pile(), slide = new Pile(), mag = new Pile(), trig = new Pile();
    var i;
    var SY = 0.0400, zRearS = -0.0060, zFrontS = -0.1640;

    /* --- frame --- */
    addBox(body, 0, -0.0020, -0.0480, 0.0148, 0.0100, 0.0780, 0.0028, M.polyL, { ao: 1, density: 7 });
    /* dust cover forward of the trigger guard */
    addBox(body, 0, -0.0040, -0.1120, 0.0126, 0.0078, 0.0400, 0.0022, M.polyL, { ao: .94, density: 9, seed: 2 });
    /* accessory rail, three slots */
    addBox(body, 0, -0.0128, -0.1180, 0.0098, 0.0032, 0.0300, 0.0011, M.polyL, { ao: .82, density: 14, seed: 3 });
    for (i = 0; i < 3; i++)
      addBox(body, 0, -0.0132, -0.1000 - i * 0.0110, 0.0100, 0.0022, 0.0030, 0.0008, M.dark,
        { ao: .55, density: 22, seed: 10 + i });
    /* beavertail */
    addBox(body, 0, 0.0010, 0.0230, 0.0140, 0.0084, 0.0090, 0.0030, M.polyL, { ao: .95, density: 12, seed: 5 });
    /* takedown pin, slide stop, mag catch -- the three controls every frame has */
    screw(body, -0.0150, -0.0040, -0.0330, 0.0044, -1, 0, 0, M.steelD, M.dark);
    screw(body, 0.0150, -0.0040, -0.0330, 0.0044, 1, 0, 0, M.steelD, M.dark);
    addBox(body, -0.0158, 0.0018, -0.0180, 0.0022, 0.0038, 0.0175, 0.0010, M.steelD,
      { ao: 1.05, density: 20, seed: 7 });
    addBox(body, -0.0164, 0.0030, -0.0290, 0.0022, 0.0026, 0.0055, 0.0009, M.steelD,
      { ao: 1.06, density: 24, seed: 8 });
    addBox(body, -0.0162, -0.0090, -0.0165, 0.0026, 0.0044, 0.0050, 0.0012, M.polyL,
      { ao: 1.04, density: 22, seed: 9 });

    /* --- slide (recoils) --- */
    addBox(slide, 0, 0.0210, -0.0790, 0.0128, 0.0130, 0.0930, 0.0024, M.slide, { ao: 1, density: 6.5 });
    /* the flat sighting rib along the top */
    addBox(slide, 0, 0.0336, -0.0850, 0.0072, 0.0022, 0.0850, 0.0009, M.slide, { ao: 1.06, density: 12, seed: 12 });
    /* rear cocking serrations, then a shorter forward set */
    serrations(slide, 0.0130, 0.0100, 0.0320, -0.0180, -0.0072, 7, 0.0013, M.slide);
    serrations(slide, 0.0130, 0.0120, 0.0300, -0.1180, -0.0072, 4, 0.0012, M.slide);
    /* ejection port with the extractor claw inside it */
    addBox(slide, 0.0126, 0.0272, -0.0570, 0.0026, 0.0058, 0.0290, 0.0009, M.dark,
      { ao: .46, density: 12, seed: 21 });
    addBox(slide, 0.0120, 0.0316, -0.0570, 0.0020, 0.0022, 0.0270, 0.0007, M.steel,
      { ao: 1.12, density: 20, seed: 22 });
    /* extractor body just behind the port */
    addBox(slide, 0.0124, 0.0250, -0.0300, 0.0022, 0.0034, 0.0075, 0.0008, M.steelD,
      { ao: 1.05, density: 24, seed: 23 });
    /* breech face / rear plate */
    addBox(slide, 0, 0.0210, 0.0122, 0.0118, 0.0120, 0.0018, 0.0007, M.steelD,
      { ao: .9, density: 20, seed: 24 });
    /* barrel: closed at both ends, bore painted on as a dark disc standing
       0.4mm proud of the crown -- an actually-hollow bore leaves a
       backface-culled hole straight through to the world */
    addLatheZ(slide, [
      { z: -0.1560, cy: 0.0190, rx: 0.0086, n: 2, uv: 0 },
      { z: -0.1700, cy: 0.0190, rx: 0.0086, n: 2, uv: .7, wear: .3 },
      { z: -0.1740, cy: 0.0190, rx: 0.0079, n: 2, uv: 1, wear: 1 }
    ], 14, M.steel, { capStart: true, capEnd: true, density: 12, seed: 31 });
    capDisc(slide, 0, 0.0190, -0.17435, 0.0048, 12, M.dark, true);
    /* recoil spring guide rod peeking out under the barrel */
    addLatheZ(slide, [
      { z: -0.1600, cy: 0.0110, rx: 0.0034, n: 2, uv: 0 },
      { z: -0.1730, cy: 0.0110, rx: 0.0034, n: 2, uv: 1 }
    ], 10, M.steelD, { capStart: true, capEnd: true, density: 22, seed: 33 });

    /* --- sights: rear notch and front post, both topping out at exactly SY */
    rearNotch(slide, zRearS, SY, 0.0038, 0.0044, 0.0060, 0.0026, M.slide, M.dotG, 40);
    frontPost(slide, zFrontS, SY, 0.0032, 0.0062, 0.0022, M.slide, M.dotA, 46, 0);

    /* --- grip, raked back 18 degrees --- */
    var rake = 0.315;
    var gs = [], N = 6;
    for (i = 0; i <= N; i++) {
      var t = i / N, y = lerp(-0.004, -0.1120, t);
      gs.push({
        y: y, cx: 0, cz: 0.0040 + Math.tan(rake) * (-y - 0.004),
        rx: lerp(0.0150, 0.0142, t), rz: lerp(0.0280, 0.0225, t),
        n: lerp(3.6, 3.2, t), ao: lerp(.92, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 14, M.poly, { capStart: true, density: 7, seed: 51 });
    /* stippled side panels + front strap grooves */
    for (i = 0; i < 2; i++) {
      var px = i ? 0.0146 : -0.0146;
      addBox(body, px, -0.0640, 0.0230, 0.0014, 0.0330, 0.0150, 0.0007, M.polyL,
        { ao: 1.04, density: 10, seed: 55 + i });
    }
    for (i = 0; i < 5; i++)
      addBox(body, 0, -0.0300 - i * 0.0165, -0.0075 + Math.tan(rake) * (0.030 + i * 0.0165), 0.0128, 0.0028, 0.0022, 0.0008,
        M.polyL, { ao: .86, density: 18, seed: 60 + i });
    /* magwell mouth */
    addBox(body, 0, -0.1090, 0.0300, 0.0148, 0.0060, 0.0210, 0.0022, M.polyL, { ao: .9, density: 12, seed: 57 });
    /* lanyard loop */
    slingLoop(body, 0, -0.1120, 0.0400, 0.0052, M.steelD, 58);

    /* --- magazine (drops on reload) --- */
    addLoftY(mag, [
      { y: -0.0180, cz: 0.0080, rx: 0.0118, rz: 0.0192, n: 3.8, ao: .8, uv: 0 },
      { y: -0.1080, cz: 0.0320, rx: 0.0118, rz: 0.0192, n: 3.8, ao: .95, uv: .85 }
    ], 10, M.nitride, { density: 9, seed: 61 });
    addBox(mag, 0, -0.1155, 0.0345, 0.0134, 0.0050, 0.0206, 0.0018, M.polyL, { ao: 1, density: 12, seed: 63 });
    /* witness holes down the spine */
    for (i = 0; i < 4; i++)
      addBox(mag, 0.0117, -0.0400 - i * 0.0180, 0.0130 + i * 0.0048, 0.0009, 0.0022, 0.0022, 0, M.dark,
        { ao: .5, density: 30, seed: 65 + i });

    /* --- trigger (its own node) --- */
    addBox(trig, 0, -0.0180, -0.0210, 0.0034, 0.0110, 0.0030, 0.0010, M.steelD, { ao: .95, density: 22, seed: 65 });
    addBox(trig, 0, -0.0180, -0.0224, 0.0012, 0.0080, 0.0012, 0.0005, M.dark, { ao: .8, density: 30, seed: 66 });
    triggerGuard(body, -0.0620, -0.0100, -0.0122, -0.0340, 0.0052, M.polyL);

    var nSlide = makeNode(root, 'slide'), nMag = makeNode(root, 'mag'), nTrig = makeNode(root, 'trigger');
    nTrig.position.set(0, -0.0070, -0.0225);
    var A = {
      root: root, nodes: { slide: nSlide, mag: nMag, trigger: nTrig }, meshes: [], bbox: null
    };
    push(A, root, body, mat, 'body');
    push(A, nSlide, slide, mat, 'slide');
    push(A, nMag, mag, mat, 'mag');
    push(A, nTrig, trig, mat, 'trigger');

    A.sight = [0, SY, 0];
    A.zRear = zRearS; A.zFront = zFrontS;
    A.muzzle = [0, 0.0190, -0.1760];
    A.eject = [0.0140, 0.0300, -0.0560];
    A.ejectDir = [1.0, 0.58, 0.20];
    A.gripR = { p: [0, -0.0300, 0.0080], r: [-rake * 0.40, 0, 0], s: 0.96, arm: [0.26, -0.12, 0.10] };
    /* support hand cups the firing hand: same vertical axis, tucked in and
       slightly forward, thumbs-forward style */
    A.gripL = { p: [-0.0225, -0.0420, 0.0110], r: [-0.10, 0.22, -0.26], s: 0.93, arm: [-0.35, 0.16, -0.14] };
    A.triggerRest = 0; A.triggerPull = -0.42;
    A.magDrop = [0, -0.20, 0.050];
    A.slideBack = 0.026;
    return A;
  }

  /* ------------------------------------------------------------- shotgun --
     A 12-gauge pump. Receiver 200mm, barrel 470mm from the chamber face,
     forend 150mm, sight radius 595mm. Remington-870 proportions with a
     synthetic pistol-grip stock.
     ---------------------------------------------------------------------- */
  function buildShotgun(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-shotgun';
    var body = new Pile(), pump = new Pile(), shell = new Pile(), trig = new Pile();
    var i;
    var BORE = 0.0420, TUBE = 0.0140, SY = 0.0620;
    var zRearS = -0.0200, zFrontS = -0.5900;

    /* receiver: a milled block, not a tube */
    addBox(body, 0, 0.0300, -0.0700, 0.0205, 0.0260, 0.1000, 0.0035, M.alloy, { ao: 1, density: 5.5 });
    /* the flat top of the receiver, drilled and tapped */
    addBox(body, 0, 0.0568, -0.0750, 0.0150, 0.0022, 0.0880, 0.0012, M.alloyD, { ao: 1.05, density: 9, seed: 3 });
    screw(body, 0, 0.0592, -0.0290, 0.0034, 0, 1, 0, M.steelD, M.dark);
    screw(body, 0, 0.0592, -0.1300, 0.0034, 0, 1, 0, M.steelD, M.dark);
    /* ejection port on the right, loading port underneath */
    addBox(body, 0.0202, 0.0290, -0.0900, 0.0028, 0.0130, 0.0350, 0.0011, M.dark,
      { ao: .46, density: 11, seed: 5 });
    addBox(body, 0, 0.0055, -0.0820, 0.0110, 0.0026, 0.0330, 0.0010, M.dark,
      { ao: .46, density: 11, seed: 6 });
    /* carrier lip inside the loading port */
    addBox(body, 0, 0.0090, -0.0640, 0.0100, 0.0022, 0.0090, 0.0008, M.steelD,
      { ao: .8, density: 20, seed: 7 });
    pin(body, -0.0206, 0.0170, -0.0300, 0.0044, -1, 0, 0, M.steelD);
    pin(body, -0.0206, 0.0170, -0.1180, 0.0044, -1, 0, 0, M.steelD);
    pin(body, 0.0206, 0.0170, -0.0300, 0.0044, 1, 0, 0, M.steelD);
    pin(body, 0.0206, 0.0170, -0.1180, 0.0044, 1, 0, 0, M.steelD);
    /* cross-bolt safety through the rear of the trigger guard */
    addBone(body, -0.0130, -0.0060, -0.0100, 0.0130, -0.0060, -0.0100, 0.0034, 0.0034, 10,
      M.steelD, { rings: 1, capStart: true, capEnd: true, density: 26, wear: .6, seed: 8 });
    addBox(body, 0.0142, -0.0060, -0.0100, 0.0016, 0.0026, 0.0026, 0, M.dotA,
      { ao: 1, density: 30, seed: 9, wear: 0 });
    /* action release lever ahead of the trigger guard */
    addBox(body, -0.0150, -0.0080, -0.0430, 0.0024, 0.0044, 0.0090, 0.0010, M.steelD,
      { ao: 1.04, density: 22, seed: 10 });

    /* barrel */
    addLatheZ(body, [
      { z: -0.1600, cy: BORE, rx: 0.0132, n: 2, uv: 0 },
      { z: -0.1900, cy: BORE, rx: 0.0112, n: 2, uv: .06, wear: .8 },
      { z: -0.5700, cy: BORE, rx: 0.0100, n: 2, uv: .94 },
      { z: -0.6080, cy: BORE, rx: 0.0104, n: 2, uv: 1, wear: 1 }
    ], 16, M.nitride, { capStart: true, capEnd: true, density: 4.5, seed: 11 });
    capDisc(body, 0, BORE, -0.60825, 0.0078, 14, M.dark, true);
    /* magazine tube under the barrel + end cap */
    addLatheZ(body, [
      { z: -0.1620, cy: 0.0140, rx: 0.0122, n: 2, uv: 0 },
      { z: -0.5720, cy: 0.0140, rx: 0.0122, n: 2, uv: .92 },
      { z: -0.5840, cy: 0.0140, rx: 0.0104, n: 2, uv: 1, wear: 1 }
    ], 12, M.nitride, { capStart: true, capEnd: true, density: 5, seed: 13 });
    collar(body, 0, 0.0140, -0.5620, -0.5760, 0.0124, 0.0158, 12, M.nitride, 15);
    /* barrel/tube clamp */
    addBox(body, 0, 0.0280, -0.5490, 0.0128, 0.0165, 0.0090, 0.0022, M.nitride,
      { ao: .92, density: 12, seed: 17 });
    slingLoop(body, 0, 0.0110, -0.5880, 0.0060, M.steelD, 19);

    /* sights: a rear notch on the receiver flat, a front post on a barrel band */
    rearNotch(body, zRearS, SY, 0.0038, 0.0042, 0.0058, 0.0028, M.alloyD, M.dotG, 40);
    addBox(body, 0, BORE + 0.0080, zFrontS, 0.0062, 0.0080, 0.0060, 0.0016, M.nitride,
      { ao: .95, density: 20, seed: 44 });
    frontPost(body, zFrontS, SY, 0.0030, 0.0060, 0.0024, M.nitride, M.dotA, 46, 0.0058);

    /* pump / forend (slides on the tube) */
    addLoftY(pump, [
      { y: -0.0180, cz: -0.3650, rx: 0.0215, rz: 0.0720, n: 4.4, ao: .88, uv: 0 },
      { y: 0.0000, cz: -0.3650, rx: 0.0238, rz: 0.0760, n: 4.8, ao: .95, uv: .28 },
      { y: 0.0270, cz: -0.3650, rx: 0.0232, rz: 0.0755, n: 4.8, ao: 1.0, uv: .74 },
      { y: 0.0390, cz: -0.3650, rx: 0.0190, rz: 0.0700, n: 4.2, ao: .96, uv: 1 }
    ], 14, M.poly, { capStart: true, capEnd: true, density: 5.5, seed: 51 });
    for (i = 0; i < 8; i++)
      addBox(pump, 0, 0.0060, -0.3080 - i * 0.0160, 0.0248, 0.0180, 0.0050, 0.0016, M.polyL,
        { ao: .8, density: 12, seed: 60 + i });
    /* twin action bars linking the pump back to the receiver */
    addBox(pump, -0.0180, 0.0090, -0.2450, 0.0026, 0.0038, 0.0700, 0.0010, M.steelD,
      { ao: .9, density: 12, seed: 68 });
    addBox(pump, 0.0180, 0.0090, -0.2450, 0.0026, 0.0038, 0.0700, 0.0010, M.steelD,
      { ao: .9, density: 12, seed: 69 });

    /* grip + trigger group */
    var gs = [], N = 6;
    for (i = 0; i <= N; i++) {
      var t = i / N, y = lerp(-0.0100, -0.1180, t);
      gs.push({
        y: y, cx: 0, cz: 0.0120 + Math.tan(0.36) * (-y - 0.010),
        rx: lerp(0.0165, 0.0155, t), rz: lerp(0.0275, 0.0230, t),
        n: lerp(3.6, 3.2, t), ao: lerp(.9, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 14, M.poly, { capStart: true, capEnd: true, density: 6.5, seed: 71 });
    triggerGuard(body, -0.0480, 0.0040, -0.0060, -0.0320, 0.0062, M.alloyD);
    addBox(trig, 0, -0.0170, -0.0270, 0.0038, 0.0110, 0.0032, 0.0010, M.steelD, { ao: .95, density: 22, seed: 75 });

    /* stock: comb, wrist and pad. The rest is behind the eye, so it is cut
       where the pose carries it out of frame rather than modelled to the butt. */
    addLoftY(body, [
      { y: 0.0480, cz: 0.0700, rx: 0.0165, rz: 0.0520, n: 4.0, ao: .95, uv: 0 },
      { y: 0.0180, cz: 0.0620, rx: 0.0190, rz: 0.0560, n: 4.2, ao: 1.0, uv: .55 },
      { y: -0.0100, cz: 0.0560, rx: 0.0175, rz: 0.0500, n: 4.0, ao: .95, uv: 1 }
    ], 12, M.poly, { capStart: true, capEnd: true, density: 5, seed: 81 });
    addBox(body, 0, 0.0190, 0.1220, 0.0180, 0.0270, 0.0090, 0.0035, M.rubber, { ao: 1, density: 9, seed: 83 });
    slingLoop(body, 0, -0.0080, 0.1000, 0.0058, M.steelD, 85);

    /* the hull that ejects: lives on its own node */
    addLatheZ(shell, [
      { z: 0.0300, rx: 0.0092, n: 2, uv: 0 },
      { z: 0.0060, rx: 0.0092, n: 2, uv: .55 },
      { z: -0.0260, rx: 0.0088, n: 2, uv: 1 }
    ], 10, M.hull, { capEnd: true, density: 22, seed: 91 });
    addLatheZ(shell, [
      { z: 0.0340, rx: 0.0096, n: 2, uv: 0 },
      { z: 0.0120, rx: 0.0096, n: 2, uv: 1 }
    ], 10, M.brass, { capStart: true, density: 22, seed: 93 });

    var nPump = makeNode(root, 'pump'), nShell = makeNode(root, 'shell'), nTrig = makeNode(root, 'trigger');
    nShell.position.set(0.0180, 0.0300, -0.0900);
    nShell.visible = false;
    nTrig.position.set(0, -0.0080, -0.0300);
    var A = { root: root, nodes: { pump: nPump, shell: nShell, trigger: nTrig }, meshes: [], bbox: null };
    push(A, root, body, mat, 'body');
    push(A, nPump, pump, mat, 'pump');
    push(A, nShell, shell, mat, 'shell');
    push(A, nTrig, trig, mat, 'trigger');

    A.sight = [0, SY, 0];
    A.zRear = zRearS; A.zFront = zFrontS;
    A.muzzle = [0, BORE, -0.6120];
    A.eject = [0.0220, 0.0300, -0.0850];
    A.ejectDir = [1.0, 0.40, 0.08];
    A.gripR = { p: [0, -0.0320, 0.0160], r: [-0.170, 0, 0], s: 0.98, arm: [0.26, -0.12, 0.10] };
    /* The forend is a horizontal cylinder, so the hand rolls 90 degrees to
       wrap it -- and the wrist then has to counter-rotate or the forearm
       points straight down the barrel at the camera. */
    A.gripL = { p: [-0.0215, 0.0040, -0.3650], r: [-1.44, 0.10, 0.08], s: 1.0, arm: [0.79, 0.10, -0.10] };
    A.gripLNode = 'pump';
    A.triggerRest = 0; A.triggerPull = -0.40;
    A.pumpBack = 0.062;
    void TUBE;
    return A;
  }

  /* ------------------------------------------------------------ chaingun --
     A man-portable six-barrel rotary. Cluster pitch radius 26mm, barrels
     16.4mm OD x 345mm, receiver 250x100x88, ammo box on the right hip.
     Grounded hardware: no glowing panels, no sci-fi trim.
     ---------------------------------------------------------------------- */
  function buildChaingun(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-chaingun';
    var body = new Pile(), barrels = new Pile(), belt = new Pile(), trig = new Pile();
    var i;
    var AXIS = 0.0400, PITCH = 0.0260, SY = 0.1000;
    var zRearS = -0.0300, zFrontS = -0.5720;

    /* receiver */
    addBox(body, 0, AXIS, -0.0850, 0.0430, 0.0480, 0.1250, 0.0075, M.alloy, { ao: 1, density: 4 });
    /* top deck + feed cover with its latch */
    addBox(body, 0, 0.0890, -0.0900, 0.0330, 0.0060, 0.1000, 0.0022, M.alloyD, { ao: 1.04, density: 7, seed: 5 });
    addBox(body, 0, 0.0930, -0.1500, 0.0120, 0.0050, 0.0110, 0.0018, M.steelD, { ao: 1.05, density: 18, seed: 6 });
    for (i = 0; i < 4; i++) screw(body, 0, 0.0946, -0.0400 - i * 0.0330, 0.0040, 0, 1, 0, M.steelD, M.dark);
    /* cooling fins down both flanks: cheap silhouette, reads as machinery */
    for (i = 0; i < 7; i++) {
      addBox(body, -0.0442, AXIS, -0.0300 - i * 0.0150, 0.0026, 0.0400, 0.0042, 0.0012, M.alloyD,
        { ao: .85, density: 12, seed: 20 + i });
      addBox(body, 0.0442, AXIS, -0.0300 - i * 0.0150, 0.0026, 0.0400, 0.0042, 0.0012, M.alloyD,
        { ao: .85, density: 12, seed: 30 + i });
    }
    /* spin housing and the static front shroud */
    addLatheZ(body, [
      { z: -0.2050, cy: AXIS, rx: 0.0400, n: 2, uv: 0 },
      { z: -0.2200, cy: AXIS, rx: 0.0440, n: 2, uv: .3, wear: 1 },
      { z: -0.2600, cy: AXIS, rx: 0.0440, n: 2, uv: .8 },
      { z: -0.2720, cy: AXIS, rx: 0.0390, n: 2, uv: 1, wear: 1 }
    ], 18, M.nitride, { capStart: true, capEnd: true, density: 6, seed: 21 });
    /* Muzzle clamp plate. It sits BEHIND the barrel muzzles on purpose: a
       ring out at the tips would leave an open annulus you can see the world
       through, and a plate the barrels emerge from is a real gun feature. */
    addLatheZ(body, [
      { z: -0.5300, cy: AXIS, rx: 0.0380, n: 2, uv: 0 },
      { z: -0.5460, cy: AXIS, rx: 0.0430, n: 2, uv: .35, wear: 1 },
      { z: -0.5720, cy: AXIS, rx: 0.0430, n: 2, uv: .8 },
      { z: -0.5860, cy: AXIS, rx: 0.0380, n: 2, uv: 1, wear: 1 }
    ], 18, M.nitride, { capStart: true, capEnd: true, density: 6, seed: 23 });
    /* three struts tying the clamp back to the housing */
    for (i = 0; i < 3; i++) {
      var a = PI * 0.5 + i * TAU / 3;
      addBox(body, Math.cos(a) * 0.0405, AXIS + Math.sin(a) * 0.0405, -0.4000,
        0.0046, 0.0046, 0.1400, 0.0018, M.nitride, { ao: .88, density: 8, seed: 40 + i, rotZ: a });
    }

    /* sights: rear notch on the deck, front post on the muzzle clamp */
    rearNotch(body, zRearS, SY, 0.0038, 0.0042, 0.0058, 0.0028, M.alloyD, M.dotG, 50);
    frontPost(body, zFrontS, SY, 0.0032, 0.0180, 0.0026, M.nitride, M.dotA, 56, 0.0064);

    /* rotating barrel cluster: six tubes on a hub */
    addLatheZ(barrels, [
      { z: -0.2620, cy: AXIS, rx: 0.0355, n: 2, uv: 0 },
      { z: -0.2820, cy: AXIS, rx: 0.0355, n: 2, uv: 1 }
    ], 16, M.nitride, { capStart: true, capEnd: true, density: 10, seed: 51 });
    for (i = 0; i < 6; i++) {
      var ang = i * TAU / 6;
      var bx = Math.cos(ang) * PITCH, by = AXIS + Math.sin(ang) * PITCH;
      addLatheZ(barrels, [
        { z: -0.2680, cx: bx, cy: by, rx: 0.0088, n: 2, uv: 0 },
        { z: -0.5740, cx: bx, cy: by, rx: 0.0078, n: 2, uv: .95 },
        { z: -0.5880, cx: bx, cy: by, rx: 0.0086, n: 2, uv: 1, wear: 1 }
      ], 10, M.nitride, { capStart: true, capEnd: true, density: 5, seed: 60 + i });
      capDisc(barrels, bx, by, -0.58835, 0.0046, 8, M.dark, true);
      collar(barrels, bx, by, -0.3600, -0.3760, 0.0080, 0.0112, 10, M.nitride, 80 + i);
      collar(barrels, bx, by, -0.4900, -0.5060, 0.0080, 0.0112, 10, M.nitride, 90 + i);
    }

    /* ammo box on the right hip + a brass belt feeding up into the receiver */
    addBox(body, 0.0790, 0.0060, -0.0680, 0.0330, 0.0400, 0.0560, 0.0055, M.alloyD,
      { ao: .96, density: 5, seed: 101 });
    addBox(body, 0.0790, 0.0480, -0.0680, 0.0310, 0.0035, 0.0530, 0.0016, M.alloy,
      { ao: 1.04, density: 9, seed: 103 });
    addBox(body, 0.1126, 0.0180, -0.0680, 0.0022, 0.0130, 0.0330, 0.0010, M.steelD,
      { ao: 1.02, density: 14, seed: 105 });
    slingLoop(body, 0.0790, -0.0350, -0.0400, 0.0060, M.steelD, 107);
    /* feed chute from the box up to the receiver */
    addBox(body, 0.0560, 0.0640, -0.0680, 0.0180, 0.0110, 0.0300, 0.0028, M.alloyD,
      { ao: .9, density: 8, seed: 109, rotZ: -0.42 });
    for (i = 0; i < 5; i++) {
      var t2 = i / 4;
      addBox(belt, lerp(0.0480, 0.0180, t2), lerp(0.0430, 0.0640, t2), lerp(-0.0680, -0.0660, t2),
        0.0105, 0.0042, 0.0056, 0.0015, M.brass,
        { ao: .95, density: 20, seed: 120 + i, rotZ: -0.95 + t2 * 0.5 });
    }

    /* grips */
    var gs = [], N = 5;
    for (i = 0; i <= N; i++) {
      var t = i / N, y = lerp(-0.0100, -0.1300, t);
      gs.push({
        y: y, cx: 0, cz: 0.0140 + Math.tan(0.30) * (-y - 0.010),
        rx: lerp(0.0165, 0.0155, t), rz: lerp(0.0270, 0.0230, t),
        n: 3.4, ao: lerp(.9, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 14, M.poly, { capStart: true, capEnd: true, density: 6.5, seed: 131 });
    triggerGuard(body, -0.0500, 0.0060, -0.0140, -0.0400, 0.0064, M.alloyD);
    addBox(trig, 0, -0.0230, -0.0290, 0.0038, 0.0115, 0.0032, 0.0010, M.steelD, { ao: .95, density: 22, seed: 135 });
    /* forward vertical grip */
    addLoftY(body, [
      { y: -0.0080, cz: -0.1680, rx: 0.0168, rz: 0.0190, n: 3.4, ao: .88, uv: 0 },
      { y: -0.1200, cz: -0.1760, rx: 0.0152, rz: 0.0172, n: 3.2, ao: 1.0, uv: 1 }
    ], 12, M.poly, { capStart: true, capEnd: true, density: 7, seed: 137 });
    for (i = 0; i < 5; i++)
      addBox(body, 0, -0.0300 - i * 0.0190, -0.1900 - i * 0.0012, 0.0140, 0.0030, 0.0024, 0.0008, M.polyL,
        { ao: .84, density: 18, seed: 140 + i });

    var nBar = makeNode(root, 'barrels'), nBelt = makeNode(root, 'belt'), nTrig = makeNode(root, 'trigger');
    nTrig.position.set(0, -0.0110, -0.0320);
    var A = { root: root, nodes: { barrels: nBar, belt: nBelt, trigger: nTrig }, meshes: [], bbox: null };
    push(A, root, body, mat, 'body');
    /* the barrels get their own material clone so heat can drive emissive on
       them alone without lighting up the whole weapon */
    var hot = mat.clone();
    hot.emissiveMap = null;
    hot.emissive = new THREE.Color(0, 0, 0);
    hot.emissiveIntensity = 1.0;
    hot.name = 'nz-vm-hotbarrel';
    /* Material.copy() does not carry own onBeforeCompile / cache key, so the
       clone falls straight back onto nz-render's prototype patch */
    detachFromScenePatch(hot);
    A.hotMat = hot;
    push(A, nBar, barrels, hot, 'barrels');
    push(A, nBelt, belt, mat, 'belt');
    push(A, nTrig, trig, mat, 'trigger');

    A.sight = [0, SY, 0];
    A.zRear = zRearS; A.zFront = zFrontS;
    A.muzzle = [0, AXIS + PITCH, -0.5900];
    A.muzzleSpin = { r: PITCH, cy: AXIS, z: -0.5900 };
    A.eject = [0.0430, -0.0060, -0.1300];
    A.ejectDir = [0.72, -0.70, 0.10];
    A.gripR = { p: [0, -0.0320, 0.0180], r: [-0.150, 0, 0], s: 0.98, arm: [0.26, -0.12, 0.10] };
    A.gripL = { p: [-0.0215, -0.0560, -0.1700], r: [-0.06, 0.10, -0.16], s: 0.98, arm: [-0.54, 0.20, -0.16] };
    A.triggerRest = 0; A.triggerPull = -0.36;
    return A;
  }

  /* ----------------------------------------------------------------- rpg --
     RPG-7 proportions: 40mm launch tube (45mm OD), 70mm flare at the grip
     section, PG-7 warhead 93mm across, PGO-7 optic offset to the LEFT with
     its axis 42mm above the bore -- which is exactly why the ADS solve has
     to handle a sight that is not on the centreline.
     ---------------------------------------------------------------------- */
  function buildRpg(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-rpg';
    var body = new Pile(), rocket = new Pile(), trig = new Pile();
    var i;
    var BORE = 0.0300, SX = -0.0320, SY = 0.0720;
    var zRearS = -0.0750, zFrontS = -0.1850;

    /* launch tube: venturi bell, main tube, muzzle flare. The rear is
       CAPPED -- an open tube cut by the near plane shows its backfaces and
       reads as a hole punched through the model. */
    addLatheZ(body, [
      { z: 0.1140, cy: BORE, rx: 0.0400, n: 2, uv: 0, wear: 1 },
      { z: 0.0900, cy: BORE, rx: 0.0330, n: 2, uv: .06 },
      { z: 0.0560, cy: BORE, rx: 0.0228, n: 2, uv: .12, wear: .8 },
      { z: -0.0200, cy: BORE, rx: 0.0228, n: 2, uv: .2 },
      { z: -0.0320, cy: BORE, rx: 0.0310, n: 2, uv: .24, wear: 1 },
      { z: -0.1980, cy: BORE, rx: 0.0310, n: 2, uv: .46 },
      { z: -0.2120, cy: BORE, rx: 0.0228, n: 2, uv: .5, wear: 1 },
      { z: -0.5080, cy: BORE, rx: 0.0228, n: 2, uv: .93 },
      { z: -0.5240, cy: BORE, rx: 0.0262, n: 2, uv: 1, wear: 1 }
    ], 20, M.paint, { density: 3.4, seed: 5 });
    capDisc(body, 0, BORE, 0.1145, 0.0402, 16, M.dark, false);
    capDisc(body, 0, BORE, -0.5245, 0.0264, 18, M.dark, true);
    /* stencil bands */
    for (i = 0; i < 3; i++) {
      var bz = -0.2600 - i * 0.0800;
      collar(body, 0, BORE, bz, bz - 0.0140, 0.0230, 0.0244, 20, M.paintD, 12 + i);
    }
    /* polymer heat guard over the wide section */
    addLoftY(body, [
      { y: BORE - 0.0355, cz: -0.1150, rx: 0.0290, rz: 0.0860, n: 6, ao: .92, uv: 0 },
      { y: BORE, cz: -0.1150, rx: 0.0355, rz: 0.0880, n: 6, ao: 1.0, uv: .5 },
      { y: BORE + 0.0355, cz: -0.1150, rx: 0.0290, rz: 0.0860, n: 6, ao: .96, uv: 1 }
    ], 14, M.wood, { capStart: true, capEnd: true, density: 4.5, seed: 17 });
    for (i = 0; i < 9; i++)
      addBox(body, 0, BORE + 0.0362, -0.0450 - i * 0.0160, 0.0210, 0.0022, 0.0044, 0.0008, M.wood,
        { ao: .86, density: 14, seed: 20 + i });

    /* PGO-7 optic: offset LEFT of the bore, axis 42mm above it */
    addBox(body, SX, SY, -0.1300, 0.0140, 0.0150, 0.0500, 0.0032, M.alloyD, { ao: 1, density: 7, seed: 31 });
    /* eyepiece: an open collar with the lens filling the whole opening, so
       there is no annulus of culled inner wall to see through */
    addLatheZ(body, [
      { z: zRearS, cx: SX, cy: SY, rx: 0.0158, n: 2, uv: 0, wear: 1 },
      { z: zRearS - 0.0140, cx: SX, cy: SY, rx: 0.0152, n: 2, uv: 1 }
    ], 14, M.alloyD, { density: 12, seed: 33 });
    capDisc(body, SX, SY, zRearS + 0.0004, 0.0158, 14, M.glass, false);
    addLatheZ(body, [
      { z: zFrontS + 0.0100, cx: SX, cy: SY, rx: 0.0168, n: 2, uv: 0 },
      { z: zFrontS - 0.0120, cx: SX, cy: SY, rx: 0.0162, n: 2, uv: 1, wear: 1 }
    ], 14, M.alloyD, { capStart: true, density: 12, seed: 35 });
    capDisc(body, SX, SY, zFrontS - 0.0122, 0.0162, 14, M.lens, true);
    /* turrets */
    addBone(body, SX, SY + 0.0150, -0.1300, SX, SY + 0.0250, -0.1300, 0.0064, 0.0058, 10,
      M.alloy, { rings: 1, capStart: true, capEnd: true, density: 20, wear: .5, seed: 37 });
    addBone(body, SX + 0.0140, SY, -0.1000, SX + 0.0250, SY, -0.1000, 0.0058, 0.0052, 10,
      M.alloy, { rings: 1, capStart: true, capEnd: true, density: 20, wear: .5, seed: 38 });
    /* mount arm reaching down to the tube bracket */
    addBox(body, SX, SY - 0.0230, -0.1150, 0.0075, 0.0090, 0.0230, 0.0020, M.alloyD,
      { ao: .85, density: 14, seed: 39 });
    addBox(body, SX * 0.5, SY - 0.0350, -0.1150, 0.0180, 0.0055, 0.0210, 0.0018, M.alloyD,
      { ao: .82, density: 12, seed: 41 });
    screw(body, SX, SY - 0.0400, -0.1050, 0.0038, 0, -1, 0, M.steelD, M.dark);
    screw(body, SX, SY - 0.0400, -0.1250, 0.0038, 0, -1, 0, M.steelD, M.dark);

    /* iron backup sight leaf folded on the tube */
    addBox(body, 0.0230, BORE + 0.0200, -0.2600, 0.0018, 0.0130, 0.0060, 0.0007, M.steelD,
      { ao: 1.02, density: 22, seed: 43 });

    /* grips + trigger */
    var gs = [], N = 5;
    for (i = 0; i <= N; i++) {
      var t = i / N, y = lerp(-0.0060, -0.1260, t);
      gs.push({
        y: y, cx: 0, cz: 0.0100 + Math.tan(0.32) * (-y - 0.006),
        rx: lerp(0.0165, 0.0155, t), rz: lerp(0.0270, 0.0230, t),
        n: 3.4, ao: lerp(.9, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 14, M.poly, { capStart: true, capEnd: true, density: 6.5, seed: 45 });
    triggerGuard(body, -0.0460, 0.0020, -0.0100, -0.0360, 0.0064, M.alloyD);
    addBox(trig, 0, -0.0180, -0.0250, 0.0038, 0.0110, 0.0032, 0.0010, M.steelD, { ao: .95, density: 22, seed: 47 });
    /* hammer housing behind the grip */
    addBox(body, 0, 0.0020, 0.0180, 0.0120, 0.0130, 0.0140, 0.0028, M.paintD, { ao: .92, density: 10, seed: 49 });
    /* front grip */
    addLoftY(body, [
      { y: -0.0040, cz: -0.2300, rx: 0.0165, rz: 0.0185, n: 3.4, ao: .88, uv: 0 },
      { y: -0.1120, cz: -0.2400, rx: 0.0150, rz: 0.0170, n: 3.2, ao: 1.0, uv: 1 }
    ], 12, M.poly, { capStart: true, capEnd: true, density: 7, seed: 51 });
    slingLoop(body, 0.0230, BORE - 0.0260, -0.3400, 0.0058, M.steelD, 53);

    /* the round in the bore (hidden after launch, reinserted on reload) */
    addLatheZ(rocket, [
      { z: -0.4800, cy: BORE, rx: 0.0200, n: 2, uv: 0 },
      { z: -0.5300, cy: BORE, rx: 0.0200, n: 2, uv: .18 },
      { z: -0.5420, cy: BORE, rx: 0.0300, n: 2, uv: .28, wear: 1 },
      { z: -0.5720, cy: BORE, rx: 0.0465, n: 2, uv: .45 },
      { z: -0.6060, cy: BORE, rx: 0.0465, n: 2, uv: .62 },
      { z: -0.6300, cy: BORE, rx: 0.0330, n: 2, uv: .74 },
      { z: -0.6540, cy: BORE, rx: 0.0130, n: 2, uv: .94 },
      { z: -0.6620, cy: BORE, rx: 0.0001, n: 2, uv: 1 }
    ], 16, M.warhead, { capStart: true, density: 7, seed: 61 });
    collar(rocket, 0, BORE, -0.5740, -0.5860, 0.0466, 0.0482, 16, M.paintD, 63);

    var nRock = makeNode(root, 'rocket'), nTrig = makeNode(root, 'trigger');
    nTrig.position.set(0, -0.0070, -0.0280);
    var A = { root: root, nodes: { rocket: nRock, trigger: nTrig }, meshes: [], bbox: null };
    push(A, root, body, mat, 'body');
    push(A, nRock, rocket, mat, 'rocket');
    push(A, nTrig, trig, mat, 'trigger');

    A.sight = [SX, SY, 0];
    A.zRear = zRearS; A.zFront = zFrontS;
    A.muzzle = [0, BORE, -0.5300];
    A.backblast = [0, BORE, 0.1240];
    A.eject = null;
    A.gripR = { p: [0, -0.0280, 0.0140], r: [-0.160, 0, 0], s: 0.98, arm: [0.26, -0.12, 0.10] };
    A.gripL = { p: [-0.0215, -0.0500, -0.2320], r: [-0.06, 0.10, -0.14], s: 0.98, arm: [-0.54, 0.20, -0.16] };
    A.triggerRest = 0; A.triggerPull = -0.40;
    return A;
  }

  /* --------------------------------------------------------------- rifle --
     An AR-15 pattern carbine. Flat-top upper 35.6mm across, 14.5in barrel
     pinned to a 2.25in A2 birdcage (16.1in total, the classic carbine),
     mid-length free-float M-LOK handguard, 29.5mm buffer tube under a
     collapsible M4 stock, 30-round STANAG magazine. Sight radius 315mm.

     The sights are DEPLOYED low-profile back-up irons rather than folded
     flat. The module's ADS solve puts the local point (0, SY, *) exactly on
     the camera axis, and rearNotch/frontPost both top out at exactly SY, so
     a deployed pair costs nothing and gives the player a real sight picture;
     sighting down a bare rail would put the crosshair on a flat strip of
     aluminium with nothing to align. The hinge bases and the pin bosses are
     modelled so they still read as flip-ups that happen to be up.
     ---------------------------------------------------------------------- */
  function buildRifle(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-rifle';
    var body = new Pile(), bolt = new Pile(), mag = new Pile(), trig = new Pile();
    var can = new Pile();
    var i, t, y;
    var BORE = 0.0440;              /* bore axis over the web of the firing hand */
    var RAIL = BORE + 0.0290;       /* top face of the flat-top rail */
    var UX = 0.0176;                /* upper receiver half width */
    var HGZ0 = -0.1080, HGZ1 = -0.3450;   /* handguard, receiver end -> muzzle end */
    var zRearS = -0.0150, zFrontS = -0.3300;

    /* ------------------------------------------------------- upper ------- */
    addBox(body, 0, BORE + 0.0010, -0.0440, UX, 0.0185, 0.0640, 0.0030, M.anod,
      { ao: 1, density: 6 });
    /* the shell deck: the slab the rail is machined out of, one shade down */
    addBox(body, 0, BORE + 0.0208, -0.0460, 0.0150, 0.0034, 0.0620, 0.0016, M.anodD,
      { ao: 1.04, density: 10, seed: 3 });
    /* charging handle. On an AR it does NOT reciprocate, so it lives in the
       static pile: the latch wing on the left is the tell that says AR. */
    addBox(body, 0, BORE + 0.0142, 0.0248, 0.0224, 0.0040, 0.0104, 0.0015, M.anodD,
      { ao: 1.02, density: 12, seed: 5 });
    addBox(body, -0.0192, BORE + 0.0142, 0.0186, 0.0058, 0.0036, 0.0072, 0.0014, M.anodD,
      { ao: 1.06, density: 16, seed: 6, eseg: 1 });
    addBox(body, 0, BORE + 0.0142, 0.0120, 0.0092, 0.0032, 0.0058, 0.0012, M.anodD,
      { ao: .90, density: 14, seed: 7, eseg: 1 });

    /* ---------------------------------------- right flank: the ejection side
       The player sees mostly the LEFT flank and the top, so this side gets
       the parts that must be there and no more: port, hinged dust cover,
       brass deflector, forward assist. */
    /* The receiver is a solid box, so a "recessed" port would simply be
       invisible behind its own wall: the port plate, the carrier and the case
       all stand a fraction of a millimetre PROUD of the 17.6mm flank and let
       albedo do the work. 0.2mm at 0.5m of view depth is a thousand times the
       depth buffer's resolution there, so nothing z-fights. */
    addBox(body, UX - 0.0010, BORE + 0.0056, -0.0470, 0.0020, 0.0092, 0.0215, 0.0009, M.dark,
      { ao: .42, density: 12, seed: 11, eseg: 1 });
    /* dust cover hinged open, hanging under the port on its rod */
    addBox(body, UX + 0.0038, BORE - 0.0096, -0.0470, 0.0026, 0.0086, 0.0218, 0.0012, M.anodD,
      { ao: .88, density: 14, seed: 12, rotZ: -0.36 });
    addBone(body, UX + 0.0012, BORE - 0.0182, -0.0700, UX + 0.0012, BORE - 0.0182, -0.0240,
      0.0021, 0.0021, 8, M.steelD,
      { rings: 1, capStart: true, capEnd: true, density: 26, wear: .5, seed: 13 });
    /* brass deflector bump behind the port */
    addBox(body, UX + 0.0024, BORE + 0.0086, -0.0182, 0.0042, 0.0054, 0.0078, 0.0026, M.anod,
      { ao: 1.04, density: 14, seed: 14 });
    /* forward assist: a boss with the pawl button standing out of it */
    addBone(body, UX - 0.0010, BORE + 0.0126, -0.0068, UX + 0.0090, BORE + 0.0126, -0.0068,
      0.0062, 0.0048, 10, M.anod,
      { rings: 1, capStart: true, capEnd: true, density: 18, wear: .5, seed: 15 });
    addBone(body, UX + 0.0082, BORE + 0.0126, -0.0068, UX + 0.0118, BORE + 0.0126, -0.0068,
      0.0032, 0.0030, 8, M.steelD,
      { rings: 1, capEnd: true, density: 26, wear: .7, seed: 16 });

    /* ------------------------------------------------------- lower ------- */
    addBox(body, 0, BORE - 0.0300, -0.0180, 0.0163, 0.0125, 0.0500, 0.0028, M.anodL,
      { ao: .98, density: 6.5, seed: 21 });
    /* magwell, flared at the lip -- the lip is the single most rubbed edge on
       a carbine, so it carries triple the wear budget of the receiver flats */
    addLoftY(body, [
      { y: BORE - 0.0180, cz: -0.0640, rx: 0.0170, rz: 0.0348, n: 4.4, ao: .98, uv: 0 },
      { y: BORE - 0.0390, cz: -0.0645, rx: 0.0158, rz: 0.0332, n: 4.4, ao: .92, uv: .72 },
      { y: BORE - 0.0470, cz: -0.0650, rx: 0.0173, rz: 0.0352, n: 4.2, ao: .86, uv: 1 }
    ], 12, M.anodLip, { density: 6.5, seed: 23 });
    /* trigger guard + the trigger itself on its own node */
    triggerGuard(body, -0.0770, -0.0240, BORE - 0.0424, BORE - 0.0640, 0.0060, M.anodL);
    /* the rear guard boss. triggerGuard's rear post stops 2.5mm short of the
       receiver floor -- on the pistol the grip fills that gap, on a rifle the
       grip sits further back and you would see daylight through it. */
    addBox(body, 0, BORE - 0.0448, -0.0250, 0.0060, 0.0034, 0.0044, 0.0012, M.anodL,
      { ao: .86, density: 16, seed: 26, eseg: 1 });
    addBox(trig, 0, -0.0232, -0.0082, 0.0038, 0.0112, 0.0032, 0.0010, M.steelD,
      { ao: .95, density: 22, seed: 25 });

    /* ------------------------------------------- left flank: the used side
       Selector, bolt catch and both pins. Everything the player's eye
       actually lands on lives here. */
    /* safety selector on its boss, set to SEMI (lever forward and down) */
    addBone(body, -0.0158, BORE - 0.0296, -0.0142, -0.0198, BORE - 0.0296, -0.0142,
      0.0060, 0.0056, 10, M.anodD,
      { rings: 1, capStart: true, capEnd: true, density: 20, wear: .5, seed: 31 });
    addBox(body, -0.0204, BORE - 0.0334, -0.0228, 0.0022, 0.0032, 0.0102, 0.0012, M.steelD,
      { ao: 1.05, density: 18, seed: 32, rotZ: 0.34, eseg: 1 });
    /* bolt catch: the long paddle you slap, plus the release nub under it */
    addBox(body, -0.0172, BORE - 0.0248, -0.0458, 0.0022, 0.0056, 0.0068, 0.0014, M.steelD,
      { ao: 1.04, density: 18, seed: 33, eseg: 1 });
    addBox(body, -0.0178, BORE - 0.0328, -0.0534, 0.0024, 0.0036, 0.0046, 0.0012, M.steelD,
      { ao: 1.02, density: 20, seed: 34, eseg: 1 });
    /* takedown and pivot pins, captured both sides */
    screw(body, -0.0166, BORE - 0.0232, 0.0176, 0.0042, -1, 0, 0, M.steelD, M.dark);
    screw(body, 0.0166, BORE - 0.0232, 0.0176, 0.0042, 1, 0, 0, M.steelD, M.dark);
    screw(body, -0.0166, BORE - 0.0252, -0.0876, 0.0042, -1, 0, 0, M.steelD, M.dark);
    screw(body, 0.0166, BORE - 0.0252, -0.0876, 0.0042, 1, 0, 0, M.steelD, M.dark);
    /* magazine release, in its fence, on the right */
    addBone(body, 0.0162, BORE - 0.0276, -0.0428, 0.0198, BORE - 0.0276, -0.0428,
      0.0042, 0.0038, 8, M.anodD,
      { rings: 1, capStart: true, capEnd: true, density: 22, wear: .5, seed: 35 });

    /* --------------------------------------------- grip / stock / buffer -- */
    var rake = 0.32;
    var gs = [], N = 6;
    for (i = 0; i <= N; i++) {
      t = i / N; y = lerp(-0.0050, -0.1080, t);
      gs.push({
        y: y, cx: 0, cz: 0.0110 + Math.tan(rake) * (-y - 0.0050),
        rx: lerp(0.0160, 0.0150, t), rz: lerp(0.0252, 0.0212, t),
        n: lerp(3.6, 3.2, t), ao: lerp(.92, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 14, M.poly, { capStart: true, capEnd: true, density: 7, seed: 41 });
    /* stippled side panels and the finger swell on the front strap */
    for (i = 0; i < 2; i++) {
      addBox(body, i ? 0.0150 : -0.0150, -0.0560, 0.0280, 0.0014, 0.0300, 0.0138, 0.0007,
        M.polyL, { ao: 1.04, density: 10, seed: 43 + i, eseg: 1 });
    }
    addBox(body, 0, -0.0300, -0.0038, 0.0086, 0.0078, 0.0038, 0.0018, M.polyL,
      { ao: .90, density: 14, seed: 45, eseg: 1 });
    /* Buffer tube with its castle nut and endplate. The stock rides it one
       notch further IN than it used to (22mm, one real M4 detent): with the
       full-length support arm the pose was re-tucked toward the shoulder,
       and at the old extension the buttpad's top corner sat 5 points inside
       the frame -- a floating stock in the bottom-right of every hip frame.
       Collapsed a notch, the same corner rides the frame edge. The tube
       shortens with it so the pad still caps the tube. */
    addLatheZ(body, [
      { z: 0.0210, cy: BORE - 0.0020, rx: 0.0166, n: 2, uv: 0, wear: 1 },
      { z: 0.0396, cy: BORE - 0.0020, rx: 0.0164, n: 2, uv: .06 },
      { z: 0.0420, cy: BORE - 0.0020, rx: 0.0148, n: 2, uv: .10, wear: 1 },
      { z: 0.1770, cy: BORE - 0.0020, rx: 0.0148, n: 2, uv: .96 },
      { z: 0.1830, cy: BORE - 0.0020, rx: 0.0136, n: 2, uv: 1, wear: 1 }
    ], 14, M.anodD, { capStart: true, capEnd: true, density: 6, seed: 47 });
    /* collapsible M4 stock body. Mostly off-screen, but its silhouette is
       what sells the sprint and holster poses. */
    addLoftY(body, [
      { y: BORE - 0.0330, cz: 0.1210, rx: 0.0194, rz: 0.0636, n: 4.6, ao: .90, uv: 0 },
      { y: BORE - 0.0060, cz: 0.1228, rx: 0.0212, rz: 0.0678, n: 4.8, ao: .98, uv: .45 },
      { y: BORE + 0.0208, cz: 0.1266, rx: 0.0178, rz: 0.0616, n: 4.4, ao: .94, uv: 1 }
    ], 12, M.poly, { capStart: true, capEnd: true, density: 5.5, seed: 49 });
    addBox(body, 0, BORE - 0.0040, 0.1916, 0.0168, 0.0246, 0.0054, 0.0028, M.rubber,
      { ao: 1, density: 9, seed: 51 });
    /* adjustment lever under the stock, and the catch bar it swings on */
    addBox(body, 0, BORE - 0.0372, 0.1500, 0.0074, 0.0058, 0.0206, 0.0018, M.polyL,
      { ao: .86, density: 12, seed: 52, eseg: 1 });
    addBone(body, -0.0082, BORE - 0.0430, 0.1402, 0.0082, BORE - 0.0430, 0.1402,
      0.0040, 0.0040, 8, M.steelD,
      { rings: 1, capStart: true, capEnd: true, density: 26, wear: .6, seed: 53 });
    slingLoop(body, -0.0219, BORE + 0.0040, 0.0900, 0.0052, M.steelD, 55);

    /* --------------------------------------------------- rail + handguard - */
    /* the rail is continuous: receiver section then handguard section, in two
       different anodise batches, exactly as a real free-float build reads */
    addBox(body, 0, RAIL - 0.0050, -0.0460, 0.0106, 0.0050, 0.0660, 0.0016, M.anodD,
      { ao: 1.04, density: 9, seed: 61 });
    addBox(body, 0, RAIL - 0.0050, -0.2270, 0.0106, 0.0050, 0.1180, 0.0016, M.anodH,
      { ao: 1.02, density: 9, seed: 62 });
    /* Picatinny recoil grooves at the true 10mm pitch, cut from the rear of
       the receiver forward past the front sight base */
    /* 0.3mm proud, not recessed, for the same reason the ejection port is:
       a groove sunk into a solid box is hidden by the box's own top face. */
    railSlots(body, 0.0108, RAIL - 0.0018, 0.0060, -0.0100, 24, M.dark);

    /* free-float tube. A rounded-octagon superellipse, NOT a box: the
       cross-section is the single thing that says "modern handguard" and it
       is the part of the gun the player looks at most. */
    addLatheZ(body, [
      { z: HGZ0, cy: BORE, rx: 0.0206, ry: 0.0206, n: 3.8, uv: 0, wear: 1 },
      { z: HGZ0 - 0.0160, cy: BORE, rx: 0.0198, ry: 0.0198, n: 3.8, uv: .07 },
      { z: HGZ1 + 0.0200, cy: BORE, rx: 0.0190, ry: 0.0190, n: 4.0, uv: .93 },
      { z: HGZ1, cy: BORE, rx: 0.0180, ry: 0.0180, n: 4.0, uv: 1, wear: 1 }
    ], 14, M.anodH, { capStart: true, capEnd: true, density: 5.0, seed: 63 });
    /* barrel-nut shroud where the tube indexes onto the receiver */
    collar(body, 0, BORE, HGZ0 + 0.0030, HGZ0 - 0.0090, 0.0202, 0.0216, 14, M.anodH, 65);
    /* M-LOK slots down both flanks, 1.5in pitch, 1.5in long */
    for (i = 0; i < 5; i++) {
      var mz = -0.1560 - i * 0.0384;
      /* the tube tapers toward the muzzle, so each slot rides its own local
         radius instead of floating off the surface at the far end */
      var mc = lerp(0.0197, 0.0191, i / 4) + 0.0003 - 0.0018;
      addBox(body, -mc, BORE, mz, 0.0018, 0.0032, 0.0166, 0.0008, M.dark,
        { ao: .46, density: 14, seed: 70 + i, eseg: 1 });
      addBox(body, mc, BORE, mz, 0.0018, 0.0032, 0.0166, 0.0008, M.dark,
        { ao: .46, density: 14, seed: 80 + i, eseg: 1 });
    }
    /* QD sling socket on the left, forward */
    addBone(body, -0.0176, BORE - 0.0060, -0.2900, -0.0208, BORE - 0.0060, -0.2900,
      0.0044, 0.0042, 8, M.anodH,
      { rings: 1, capStart: true, capEnd: true, density: 24, wear: .5, seed: 87 });
    addBone(body, -0.0202, BORE - 0.0060, -0.2900, -0.0214, BORE - 0.0060, -0.2900,
      0.0019, 0.0019, 6, M.dark, { rings: 1, capEnd: true, density: 34, seed: 88 });

    /* ------------------------------------------------- barrel and muzzle -- */
    addLatheZ(body, [
      { z: HGZ1 + 0.0060, cy: BORE, rx: 0.0104, n: 2, uv: 0 },
      { z: -0.3510, cy: BORE, rx: 0.0097, n: 2, uv: .10, wear: .5 },
      { z: -0.4540, cy: BORE, rx: 0.0092, n: 2, uv: .84 },
      { z: -0.4620, cy: BORE, rx: 0.0088, n: 2, uv: .92, wear: 1 },
      { z: -0.4660, cy: BORE, rx: 0.0088, n: 2, uv: 1 }
    ], 14, M.nitride, { capStart: true, capEnd: true, density: 5, seed: 91 });
    /* low-profile gas block, with the gas tube running back under the rail */
    addBox(body, 0, BORE + 0.0026, -0.3606, 0.0098, 0.0122, 0.0172, 0.0020, M.nitride,
      { ao: .95, density: 12, seed: 93 });
    addLatheZ(body, [
      { z: -0.3436, cy: BORE + 0.0130, rx: 0.0026, n: 2, uv: 0 },
      { z: -0.3600, cy: BORE + 0.0130, rx: 0.0026, n: 2, uv: 1 }
    ], 8, M.steelD, { capStart: true, capEnd: true, density: 30, seed: 94 });
    screw(body, 0, BORE - 0.0092, -0.3560, 0.0026, 0, -1, 0, M.steelD, M.dark);
    /* A2 birdcage. Pinned at 14.5in so the whole barrel makes 16.1in. */
    addLatheZ(body, [
      { z: -0.4660, cy: BORE, rx: 0.0112, n: 2, uv: 0, wear: 1 },
      { z: -0.4740, cy: BORE, rx: 0.0106, n: 2, uv: .16 },
      { z: -0.5060, cy: BORE, rx: 0.0106, n: 2, uv: .76 },
      { z: -0.5140, cy: BORE, rx: 0.0114, n: 2, uv: .92, wear: 1 },
      { z: -0.5200, cy: BORE, rx: 0.0102, n: 2, uv: 1, wear: 1 }
    ], 14, M.nitride, { capStart: true, capEnd: true, density: 10, seed: 95 });
    capDisc(body, 0, BORE, -0.52035, 0.0054, 12, M.dark, true);
    /* five ports, upper half only: an A2 is closed underneath so it does not
       kick dust up off the prone shooter */
    for (i = 0; i < 5; i++) {
      var fa = PI * (0.10 + i * 0.20);
      /* radius 0.0090 + the 0.0018 half-extent puts the outer face 0.2mm
         proud of the 0.0106 cage: a slot, not a rib */
      addBox(body, Math.cos(fa) * 0.0090, BORE + Math.sin(fa) * 0.0090, -0.4900,
        0.0018, 0.0016, 0.0124, 0.0006, M.dark,
        { ao: .40, density: 20, seed: 100 + i, rotZ: fa, eseg: 1 });
    }
    /* the pin that holds it there */
    pin(body, 0, BORE + 0.0114, -0.4690, 0.0022, 0, 1, 0, M.steelD);

    /* ----------------------------------------------------- suppressor ----
       A quick-detach 5.56 can that indexes over the A2 birdcage -- which is
       why the birdcage stays on the gun and is not swapped out: a QD mount
       uses the flash hider as its locking taper, so the two are supposed to
       be seen together. 145 mm and 40 mm across.

       It goes in its OWN pile and its own node. Piles become one mesh each,
       so a node is the only granularity at which something can be taken off
       the gun without rebuilding it, and the whole point of this part is
       that it comes off. It is also why the geometry lives at the end: the
       body pile is closed by then and nothing here can leak into it.

       The rear third is M.steel rather than M.nitride on purpose. A can
       cooks its blast chamber first and the finish there straw-colours
       before the rest of the tube has warmed up at all, so the heat break
       sits about a third of the way down -- and it is the only thing that
       distinguishes a suppressor from a length of pipe at a glance.       */
    var SZ0 = -0.4560, SZ1 = -0.6010;   /* mount shoulder -> front cap face  */
    var SR = 0.0198;                    /* 40 mm tube                        */
    /* mount body: over the birdcage, tapering out to the tube */
    addLatheZ(can, [
      { z: SZ0 + 0.0120, cy: BORE, rx: 0.0146, n: 2, uv: 0, wear: 1 },
      { z: SZ0, cy: BORE, rx: 0.0182, n: 2, uv: .10, wear: 1 },
      { z: SZ0 - 0.0300, cy: BORE, rx: SR, n: 2, uv: .28 },
      { z: SZ1 - 0.0060, cy: BORE, rx: SR, n: 2, uv: .92 },
      { z: SZ1 - 0.0135, cy: BORE, rx: 0.0176, n: 2, uv: 1, wear: 1 }
    ], 16, M.steel, { capStart: true, density: 5.5, seed: 301 });
    /* the tube proper, laid over the blast chamber from a third of the way
       down. Two lathes, not one, because that is where the colour changes. */
    addLatheZ(can, [
      { z: SZ0 - 0.0440, cy: BORE, rx: SR + 0.0002, n: 2, uv: 0 },
      { z: SZ1 - 0.0058, cy: BORE, rx: SR + 0.0002, n: 2, uv: 1 }
    ], 16, M.nitride, { density: 5.5, seed: 302 });
    /* the QD collar and its ratchet teeth: the part your hand turns */
    collar(can, 0, BORE, SZ0 - 0.0034, SZ0 - 0.0214, 0.0196, 0.0212, 16, M.steelD, 303);
    for (i = 0; i < 10; i++) {
      var ta = (i / 10) * TAU;
      addBox(can, Math.cos(ta) * 0.0206, BORE + Math.sin(ta) * 0.0206, SZ0 - 0.0124,
        0.0016, 0.0030, 0.0072, 0.0006, M.steelD,
        { ao: .84, density: 22, seed: 310 + i, rotZ: ta, eseg: 1 });
    }
    /* three shallow flutes down the visible top and flanks. Real ones are
       for surface area; here they are for the highlight to break on. */
    for (i = 0; i < 3; i++) {
      var fz = -0.5120 - i * 0.0300;
      addBox(can, 0, BORE + SR - 0.0012, fz, 0.0044, 0.0018, 0.0104, 0.0007, M.nitrideLow,
        { ao: .78, density: 16, seed: 320 + i, eseg: 1 });
      addBox(can, -(SR - 0.0012), BORE, fz, 0.0018, 0.0044, 0.0104, 0.0007, M.nitrideLow,
        { ao: .78, density: 16, seed: 330 + i, eseg: 1 });
    }
    /* front cap, and the bore through it. The bore is the read: a capped
       tube is a silencer, a tube with a hole down the middle is a can. */
    collar(can, 0, BORE, SZ1 + 0.0020, SZ1 - 0.0074, 0.0180, 0.0202, 16, M.steelD, 304);
    capDisc(can, 0, BORE, SZ1 - 0.0132, 0.0174, 16, M.steelD, true);
    addLatheZ(can, [
      { z: SZ1 - 0.0128, cy: BORE, rx: 0.0072, n: 2, uv: 0 },
      { z: SZ1 - 0.0068, cy: BORE, rx: 0.0064, n: 2, uv: 1 }
    ], 12, M.dark, { capEnd: true, density: 24, seed: 305 });

    /* --------------------------------------------------- backup sights ---
       The rail carries a magnified optic (below), so both irons live FOLDED.
       That is not a dodge to save geometry: a standing rear leaf would sit
       inside the scope tube, and a standing front post would hang in the
       lower third of the sight picture at 3.6x. Every scoped carbine in the
       world folds its BUIS, and the folded hardware is a better silhouette
       read anyway -- two low blocks on the rail instead of two towers.
       The rear moves back to the tail of the receiver, behind the mount,
       which is also where it lives on a real gun. */
    zRearS = 0.0088;
    /* rear: hinge base with its pin bosses, then the leaf lying on its detent */
    addBox(body, 0, RAIL + 0.0014, zRearS, 0.0092, 0.0018, 0.0092, 0.0008, M.anodD,
      { ao: 1.02, density: 18, seed: 111, eseg: 1 });
    pin(body, -0.0094, RAIL + 0.0020, zRearS + 0.0062, 0.0022, -1, 0, 0, M.steelD);
    pin(body, 0.0094, RAIL + 0.0020, zRearS + 0.0062, 0.0022, 1, 0, 0, M.steelD);
    addBox(body, 0, RAIL + 0.0046, zRearS - 0.0016, 0.0068, 0.0016, 0.0074, 0.0007, M.anodD,
      { ao: .96, density: 20, seed: 112, eseg: 1 });
    /* the aperture drum, folded down flat and pointing forward. Its axis is
       across the gun, which is what makes it read as a hinge and not a lump. */
    addBone(body, -0.0032, RAIL + 0.0068, zRearS - 0.0072, 0.0032, RAIL + 0.0068, zRearS - 0.0072,
      0.0030, 0.0030, 10, M.steelD,
      { rings: 1, capStart: true, capEnd: true, density: 26, wear: .6, seed: 113 });
    /* front: same treatment out on the handguard rail, hood folded forward */
    addBox(body, 0, RAIL + 0.0022, zFrontS, 0.0090, 0.0026, 0.0086, 0.0008, M.anodH,
      { ao: 1.02, density: 18, seed: 115, eseg: 1 });
    pin(body, -0.0092, RAIL + 0.0026, zFrontS + 0.0056, 0.0021, -1, 0, 0, M.steelD);
    pin(body, 0.0092, RAIL + 0.0026, zFrontS + 0.0056, 0.0021, 1, 0, 0, M.steelD);
    addBox(body, 0, RAIL + 0.0062, zFrontS - 0.0094, 0.0058, 0.0018, 0.0092, 0.0007, M.anodD,
      { ao: .94, density: 20, seed: 117, eseg: 1 });
    for (i = 0; i < 2; i++) {
      addBox(body, i ? 0.0046 : -0.0046, RAIL + 0.0090, zFrontS - 0.0102, 0.0012, 0.0028, 0.0076, 0.0006,
        M.anodD, { ao: 1.02, density: 22, seed: 118 + i, eseg: 1 });
    }

    /* ---------------------------------------------------------- optic ----
       A 3.6x24 LPVO on a one-piece cantilever mount. Everything here is
       driven off three numbers so the whole assembly stays coherent if any
       of them move: the optical axis OY, the tube radius TR, and the two
       lens planes zOc / zObj.

       OY is 38 mm over the rail -- a 1.5in mount, the height that puts the
       ocular where your cheek already is on an M4 stock, rather than the
       1.93in height that needs a riser. TR is a 30 mm tube: the 25.4 mm
       tube would be period-correct and is also the one that reads as a
       cheap optic, and this is the gun the player carries all mission.

       The two lens planes are exported as A.zRear / A.zFront, which is what
       the ADS solve aligns on. Because both lenses sit on the same axis at
       x = 0, the solve puts the whole optic dead on the camera axis rather
       than merely close to it.                                             */
    var OY = RAIL + 0.0380;         /* optical axis over the bore            */
    var TR = 0.0150;                /* 30 mm main tube                       */
    var zOc = 0.0650;               /* ocular lens plane, at the rim         */
    var zObj = -0.1312;             /* objective lens plane, at the rim      */
    var zR1 = -0.0150, zR2 = -0.0740;   /* ring centres                      */

    /* mount base: a slab clamped along the receiver rail, cantilevered
       forward so both rings land on the tube and neither one lands on a bell */
    addBox(body, 0, RAIL + 0.0062, -0.0480, 0.0132, 0.0062, 0.0470, 0.0020, M.anod,
      { ao: .98, density: 7, seed: 201 });
    /* recoil lug dropping into a rail slot -- the one part that actually
       stops a scope walking, so it is worth the twelve triangles */
    addBox(body, 0, RAIL - 0.0004, -0.0290, 0.0062, 0.0028, 0.0026, 0.0008, M.anodD,
      { ao: .70, density: 20, seed: 202, eseg: 1 });
    addBox(body, 0, RAIL - 0.0004, -0.0690, 0.0062, 0.0028, 0.0026, 0.0008, M.anodD,
      { ao: .70, density: 20, seed: 203, eseg: 1 });
    /* clamp bar and its two QD throw levers, on the left where they are seen */
    addBox(body, -0.0138, RAIL + 0.0042, -0.0480, 0.0024, 0.0046, 0.0440, 0.0010, M.anodD,
      { ao: 1.04, density: 14, seed: 204, eseg: 1 });
    for (i = 0; i < 2; i++) {
      var lz = i ? -0.0700 : -0.0250;
      addBox(body, -0.0178, RAIL + 0.0034, lz, 0.0028, 0.0062, 0.0104, 0.0012, M.steelD,
        { ao: 1.06, density: 18, seed: 205 + i, rotZ: 0.30, eseg: 1 });
    }

    /* rings: pillar, band, machined top cap, cap screws. Two per ring on top
       is enough -- the lower two are never above the horizon. */
    for (i = 0; i < 2; i++) {
      var zr = i ? zR2 : zR1;
      addBox(body, 0, RAIL + 0.0177, zr, 0.0118, 0.0053, 0.0092, 0.0016, M.anod,
        { ao: .96, density: 10, seed: 211 + i * 10 });
      addLatheZ(body, [
        { z: zr + 0.0092, cy: OY, rx: TR + 0.0012, n: 2, uv: 0, wear: 1 },
        { z: zr + 0.0080, cy: OY, rx: TR + 0.0055, n: 2, uv: .12 },
        { z: zr - 0.0080, cy: OY, rx: TR + 0.0055, n: 2, uv: .88 },
        { z: zr - 0.0092, cy: OY, rx: TR + 0.0012, n: 2, uv: 1, wear: 1 }
      ], 16, M.anod, { capStart: true, capEnd: true, density: 11, seed: 213 + i * 10 });
      addBox(body, 0, OY + TR + 0.0042, zr, 0.0086, 0.0022, 0.0090, 0.0009, M.anod,
        { ao: 1.06, density: 14, seed: 215 + i * 10 });
      screw(body, -0.0078, OY + TR + 0.0058, zr + 0.0046, 0.0021, 0, 1, 0, M.steelD, M.dark);
      screw(body, 0.0078, OY + TR + 0.0058, zr + 0.0046, 0.0021, 0, 1, 0, M.steelD, M.dark);
      screw(body, -0.0078, OY + TR + 0.0058, zr - 0.0046, 0.0021, 0, 1, 0, M.steelD, M.dark);
      screw(body, 0.0078, OY + TR + 0.0058, zr - 0.0046, 0.0021, 0, 1, 0, M.steelD, M.dark);
    }

    /* main tube */
    addLatheZ(body, [
      { z: 0.0300, cy: OY, rx: TR, n: 2, uv: 0, wear: .5 },
      { z: -0.0840, cy: OY, rx: TR, n: 2, uv: 1, wear: .5 }
    ], 16, M.anodD, { capStart: true, capEnd: true, density: 6, seed: 231 });

    /* Ocular housing: bell, knurled diopter ring, rubber eyecup rim.
       NO capEnd on the eye end. capEnd lays a solid fan of anodise across the
       opening, and a lens dropped 1.6mm behind that fan is simply never
       drawn -- the eyepiece renders as a black disc and the one piece of
       glass on the gun is invisible. The rim is left open and the lens fills
       it, standing 0.2mm proud, which is what buildRpg does for the same
       reason and says so. */
    addLatheZ(body, [
      { z: 0.0300, cy: OY, rx: TR, n: 2, uv: 0 },
      { z: 0.0362, cy: OY, rx: 0.0184, n: 2, uv: .16 },
      { z: 0.0540, cy: OY, rx: 0.0206, n: 2, uv: .66 },
      { z: 0.0604, cy: OY, rx: 0.0212, n: 2, uv: .88, wear: 1 },
      { z: 0.0648, cy: OY, rx: 0.0198, n: 2, uv: 1, wear: 1 }
    ], 16, M.anodD, { capStart: true, density: 6, seed: 233 });
    collar(body, 0, OY, 0.0596, 0.0508, 0.0204, 0.0218, 16, M.rubber, 234);
    capDisc(body, 0, OY, zOc, 0.0198, 16, M.lens, false);
    /* magnification ring with its throw lever, right where the thumb finds it */
    collar(body, 0, OY, 0.0304, 0.0206, TR + 0.0008, TR + 0.0042, 16, M.anodD, 235);
    addBone(body, 0.0132, OY + 0.0132, 0.0256, 0.0214, OY + 0.0214, 0.0256,
      0.0032, 0.0026, 8, M.polyL,
      { rings: 1, capStart: true, capEnd: true, density: 16, wear: .4, seed: 236 });

    /* turret saddle, between the rings. Elevation up, windage right,
       illumination dial left -- the left one is the flank the player sees. */
    addBox(body, 0, OY, -0.0430, 0.0158, 0.0158, 0.0132, 0.0038, M.anodD,
      { ao: .96, density: 9, seed: 241 });
    addBone(body, 0, OY + 0.0140, -0.0430, 0, OY + 0.0248, -0.0430, 0.0094, 0.0088, 14, M.anodD,
      { rings: 1, capStart: true, capEnd: true, density: 14, wear: .5, seed: 242 });
    addBone(body, 0, OY + 0.0248, -0.0430, 0, OY + 0.0302, -0.0430, 0.0080, 0.0074, 14, M.anod,
      { rings: 1, capEnd: true, density: 20, wear: .8, seed: 243 });
    addBox(body, 0, OY + 0.0308, -0.0430, 0.0060, 0.0012, 0.0060, 0.0010, M.steelD,
      { ao: 1.08, density: 24, seed: 244, eseg: 1 });
    addBone(body, 0.0142, OY, -0.0430, 0.0250, OY, -0.0430, 0.0088, 0.0082, 14, M.anodD,
      { rings: 1, capStart: true, capEnd: true, density: 14, wear: .5, seed: 245 });
    addBone(body, 0.0250, OY, -0.0430, 0.0296, OY, -0.0430, 0.0074, 0.0070, 14, M.anod,
      { rings: 1, capEnd: true, density: 20, wear: .8, seed: 246 });
    addBone(body, -0.0142, OY, -0.0430, -0.0272, OY, -0.0430, 0.0096, 0.0092, 16, M.anodD,
      { rings: 1, capStart: true, capEnd: true, density: 13, wear: .5, seed: 247 });
    /* the illumination index, lit. One warm pip on a black gun, and it is on
       the side the camera is canted toward -- it does a lot of work. */
    addBox(body, -0.0276, OY + 0.0058, -0.0430, 0.0009, 0.0018, 0.0018, 0.0005, M.dotA,
      { ao: 1, density: 34, seed: 248, eseg: 1 });

    /* objective housing and the front lens */
    addLatheZ(body, [
      { z: -0.0840, cy: OY, rx: TR, n: 2, uv: 0 },
      { z: -0.0932, cy: OY, rx: 0.0186, n: 2, uv: .20 },
      { z: -0.1206, cy: OY, rx: 0.0208, n: 2, uv: .80 },
      { z: -0.1272, cy: OY, rx: 0.0214, n: 2, uv: .94, wear: 1 },
      { z: -0.1310, cy: OY, rx: 0.0200, n: 2, uv: 1, wear: 1 }
    ], 16, M.anodD, { capStart: true, density: 6, seed: 251 });
    collar(body, 0, OY, -0.1214, -0.1284, 0.0206, 0.0219, 16, M.anodD, 252);
    capDisc(body, 0, OY, zObj, 0.0200, 16, M.lens, true);

    /* ------------------------------------------------------- magazine ---- */
    var ms = [], MN = 6;
    for (i = 0; i <= MN; i++) {
      t = i / MN; y = lerp(BORE - 0.0400, BORE - 0.1960, t);
      ms.push({
        y: y, cx: 0, cz: -0.0640 - 0.0270 * t * t,
        rx: lerp(0.0124, 0.0118, t), rz: lerp(0.0296, 0.0288, t),
        n: lerp(4.4, 4.2, t), ao: lerp(.84, 1.0, t), uv: t
      });
    }
    addLoftY(mag, ms, 12, M.poly, { capStart: true, density: 7, seed: 121 });
    addBox(mag, 0, BORE - 0.2006, -0.0908, 0.0132, 0.0054, 0.0300, 0.0018, M.polyL,
      { ao: 1, density: 12, seed: 123 });
    /* witness ribs. Both flanks, because the magazine swings out of the well
       on reload and you see the far side of it as it goes. */
    for (i = 0; i < 3; i++) {
      var wy = BORE - 0.0740 - i * 0.0400;
      var wt = (BORE - 0.0400 - wy) / 0.1560;
      var wz = -0.0640 - 0.0270 * wt * wt;
      addBox(mag, -0.0120, wy, wz, 0.0009, 0.0030, 0.0228, 0.0006, M.polyL,
        { ao: .88, density: 16, seed: 130 + i, eseg: 1 });
      addBox(mag, 0.0120, wy, wz, 0.0009, 0.0030, 0.0228, 0.0006, M.polyL,
        { ao: .88, density: 16, seed: 140 + i, eseg: 1 });
    }

    /* --------------------------------------------------- bolt carrier ---- */
    /* Named 'slide' on purpose: the module already drives a node by that name
       off the slide spring and the slideOverride channel, so the carrier
       cycles on fire and locks back on an empty magazine with no new
       plumbing at all. */
    /* Sized and placed so the whole carrier stays INSIDE the 43mm port across
       its 21.2mm of travel: forward it fills the front of the port, back it
       fills the rear. A block that slid out onto the receiver flank would be
       the loudest artefact on the model. */
    addBox(bolt, UX - 0.0024, BORE + 0.0056, -0.0575, 0.0038, 0.0074, 0.0104, 0.0016, M.steelD,
      { ao: .76, density: 14, seed: 151 });
    /* the case rim on the bolt face. Bright brass -- the one warm accent on
       an otherwise black rifle, and it tracks the carrier back and forth. */
    addLatheZ(bolt, [
      { z: -0.0616, cx: UX - 0.0030, cy: BORE + 0.0044, rx: 0.0042, n: 2, uv: 0 },
      { z: -0.0664, cx: UX - 0.0030, cy: BORE + 0.0044, rx: 0.0040, n: 2, uv: 1, wear: 1 }
    ], 10, M.brass, { capStart: true, capEnd: true, density: 26, seed: 152 });
    addBox(bolt, UX + 0.0000, BORE + 0.0106, -0.0630, 0.0022, 0.0024, 0.0040, 0.0009, M.steel,
      { ao: 1.10, density: 22, seed: 153, eseg: 1 });

    var nBolt = makeNode(root, 'slide'), nMag = makeNode(root, 'mag'), nTrig = makeNode(root, 'trigger');
    var nCan = makeNode(root, 'can');
    nTrig.position.set(0, BORE - 0.0330, -0.0400);
    var A = { root: root, nodes: { slide: nBolt, mag: nMag, trigger: nTrig, can: nCan }, meshes: [], bbox: null };
    push(A, root, body, mat, 'body');
    push(A, nBolt, bolt, mat, 'bolt');
    push(A, nMag, mag, mat, 'mag');
    push(A, nTrig, trig, mat, 'trigger');
    /* The can is pushed like everything else, so it IS in A.bbox and the
       framing solve is done against the gun at its longest. That is the
       honest way round: a pose bisected on the bare rifle would put the
       muzzle past the far guard the moment the can went on, and the whole
       point of the far guard is that world geometry must never be able to
       draw over the weapon. Costs a few percent of on-screen size when the
       can is off, which nobody will ever see. */
    push(A, nCan, can, mat, 'can');
    nCan.visible = false;

    /* The sight line is the OPTIC's axis, not the folded irons'. The ADS
       solve puts A.sight on the camera axis and then checks that zRear and
       zFront project to the same pixel, so handing it the two lens planes
       makes it align the scope itself. */
    A.sight = [0, OY, 0];
    A.zRear = zOc; A.zFront = zObj;
    /* Two muzzles. Everything downstream -- flash, smoke, tracer origin --
       reads A.muzzle, so putting the can on is a matter of swapping which
       one it points at; get this wrong and the flash blooms out of the side
       of the suppressor 150 mm behind its own mouth. */
    A.muzzleBare = [0, BORE, -0.5230];
    A.muzzleCan = [0, BORE, SZ1 - 0.0150];
    A.muzzle = A.muzzleBare;
    A.suppressor = true;
    A.eject = [UX + 0.0044, BORE + 0.0090, -0.0470];
    /* an AR throws its brass to three-to-four o'clock: hard right, slightly
       up, and FORWARD -- not straight up like a pistol */
    A.ejectDir = [1.0, 0.34, -0.46];
    A.gripR = { p: [0, -0.0330, 0.0163], r: [-0.160, 0, 0], s: 0.98, arm: [0.26, -0.12, 0.10] };
    /* Support hand C-clamped on the handguard: rolled 82 degrees so the
       fingers wrap the tube and the thumb comes over the top. At z -0.270
       the hand sat at the far end of the handguard -- a competition-style
       full extension that, from the eye, put half a metre of forearm on
       screen. Pulled back to -0.210, mid-handguard: the natural fighting
       grip, and the visible arm is a third shorter for free. */
    A.gripL = { p: [-0.0212, BORE - 0.0030, -0.2100], r: [-1.44, 0.14, 0.06], s: 0.97, arm: [0.79, 0.10, -0.10] };
    A.triggerRest = 0; A.triggerPull = -0.40;
    A.magDrop = [0, -0.24, 0.030];
    A.slideBack = 0.0212;
    return A;
  }

  /* =========================================================================
     6b. FALLEN WEAPONS
     The three guns below are never bought, found or issued: each one is
     built here so a dead enemy can leave it behind and the player can pick
     it up. They copy the ENEMY hardware -- the trooper's AKM, the
     assaulter's red-dot M4, the marksman's bolt DMR -- not idealised
     versions of it, because the pickup on the floor and the gun in the
     hands have to read as the same object. Same local frame as everything
     else: +X right, +Y up, -Z downrange, origin at the web of the firing
     hand.
     ====================================================================== */

  /* ------------------------------------------------------------------ AK --
     An AKM. Stamped receiver 29mm wide, 415mm barrel, wood furniture,
     tangent rear at 128mm, post at 585mm, slant compensator. 7.62x39.
     ---------------------------------------------------------------------- */
  function buildAk(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-ak';
    var body = new Pile(), bolt = new Pile(), mag = new Pile(), trig = new Pile();
    var i, t;
    var BORE = 0.0410;
    var SY = BORE + 0.0210;            /* iron sight line over the web       */
    var zRearS = -0.1280, zFrontS = -0.5850;

    /* --- stamped receiver, its dust cover, and the cover's three ribs --- */
    addBox(body, 0, BORE - 0.0062, -0.0700, 0.0148, 0.0192, 0.1320, 0.0022, M.nitride,
      { ao: 1, density: 6 });
    addLatheZ(body, [
      { z: 0.0600, cy: BORE + 0.0104, rx: 0.0138, ry: 0.0096, n: 3.2, uv: 0, wear: 1 },
      { z: -0.0300, cy: BORE + 0.0112, rx: 0.0142, ry: 0.0100, n: 3.2, uv: .45 },
      { z: -0.1180, cy: BORE + 0.0108, rx: 0.0138, ry: 0.0092, n: 3.2, uv: .92 },
      { z: -0.1300, cy: BORE + 0.0096, rx: 0.0128, ry: 0.0078, n: 3.0, uv: 1, wear: 1 }
    ], 12, M.nitrideLow, { capStart: true, capEnd: true, density: 6, seed: 401 });
    for (i = 0; i < 3; i++)
      addBox(body, 0, BORE + 0.0206, 0.0330 - i * 0.0210, 0.0102, 0.0010, 0.0028, 0.0005, M.nitrideLow,
        { ao: 1.05, density: 16, seed: 404 + i, eseg: 1 });
    /* ejection port and the fixed ejector shadow inside it, right flank */
    addBox(body, 0.0142, BORE + 0.0028, -0.0380, 0.0018, 0.0072, 0.0210, 0.0008, M.dark,
      { ao: .44, density: 12, seed: 408, eseg: 1 });
    /* recoil lug dimples: the two stamped swells over the trunnion pins */
    screw(body, -0.0150, BORE - 0.0020, -0.1780, 0.0040, -1, 0, 0, M.steelD, M.dark);
    screw(body, 0.0150, BORE - 0.0020, -0.1780, 0.0040, 1, 0, 0, M.steelD, M.dark);
    screw(body, -0.0150, BORE - 0.0060, 0.0300, 0.0040, -1, 0, 0, M.steelD, M.dark);
    /* the long stamped selector lever on the right, set to AUTO (down) */
    addBox(body, 0.0154, BORE - 0.0128, -0.0300, 0.0016, 0.0030, 0.0480, 0.0007, M.steelD,
      { ao: 1.05, density: 16, seed: 411, eseg: 1 });
    screw(body, 0.0152, BORE - 0.0026, 0.0060, 0.0038, 1, 0, 0, M.steelD, M.dark);

    /* --- rear sight block + tangent leaf; the notch tops out at SY --- */
    addBox(body, 0, BORE + 0.0128, -0.1360, 0.0104, 0.0084, 0.0140, 0.0018, M.nitride,
      { ao: .98, density: 12, seed: 415 });
    addBox(body, 0, SY - 0.0052, -0.1180, 0.0052, 0.0014, 0.0250, 0.0006, M.steelD,
      { ao: 1.02, density: 16, seed: 416, eseg: 1 });
    rearNotch(body, zRearS, SY, 0.0034, 0.0040, 0.0054, 0.0022, M.steelD, null, 418);

    /* --- barrel group: trunnion, barrel, gas block, tube, slant brake --- */
    addLatheZ(body, [
      { z: -0.2020, cy: BORE, rx: 0.0108, n: 2, uv: 0, wear: .6 },
      { z: -0.3400, cy: BORE, rx: 0.0100, n: 2, uv: .40 },
      { z: -0.5450, cy: BORE, rx: 0.0086, n: 2, uv: 1, wear: .5 }
    ], 12, M.nitride, { density: 5, seed: 421 });
    /* gas block, canted the way every AK gas block is, and its tube */
    addBox(body, 0, BORE + 0.0096, -0.3480, 0.0090, 0.0130, 0.0130, 0.0018, M.nitride,
      { ao: .95, density: 12, seed: 423 });
    addLatheZ(body, [
      { z: -0.2060, cy: BORE + 0.0185, rx: 0.0062, n: 2, uv: 0 },
      { z: -0.3400, cy: BORE + 0.0185, rx: 0.0060, n: 2, uv: 1 }
    ], 10, M.steelD, { capStart: true, density: 9, seed: 424 });
    /* cleaning rod under the barrel: the thin bright line every AK has */
    addLatheZ(body, [
      { z: -0.2050, cy: BORE - 0.0138, rx: 0.0021, n: 2, uv: 0 },
      { z: -0.5300, cy: BORE - 0.0138, rx: 0.0021, n: 2, uv: 1 }
    ], 8, M.steel, { capEnd: true, density: 30, seed: 425 });
    /* slant compensator: a muzzle that points slightly UP at the cut */
    addBone(body, 0, BORE, -0.5450, 0, BORE + 0.0046, -0.6060, 0.0102, 0.0094, 12, M.nitride,
      { rings: 2, capEnd: true, density: 12, wear: .6, seed: 427 });
    capDisc(body, 0, BORE + 0.0046, -0.6068, 0.0048, 10, M.dark, true);
    pin(body, 0, BORE + 0.0100, -0.5480, 0.0020, 0, 1, 0, M.steelD);
    /* front sight: tall post between two protective wings */
    frontPost(body, zFrontS, SY, 0.0032, 0.0148, 0.0024, M.nitride, M.dotA, 431, 0.0058);
    addBox(body, 0, BORE + 0.0058, -0.5850, 0.0074, 0.0068, 0.0092, 0.0016, M.nitride,
      { ao: .96, density: 14, seed: 432 });

    /* --- wood: lower handguard with palm swell, upper over the gas tube --- */
    addLatheZ(body, [
      { z: -0.2080, cy: BORE - 0.0078, rx: 0.0158, ry: 0.0135, n: 3.4, uv: 0, wear: 1 },
      { z: -0.2700, cy: BORE - 0.0082, rx: 0.0176, ry: 0.0148, n: 3.4, uv: .5 },
      { z: -0.3380, cy: BORE - 0.0078, rx: 0.0150, ry: 0.0128, n: 3.4, uv: 1, wear: 1 }
    ], 12, M.wood, { capStart: true, capEnd: true, density: 5.5, seed: 435 });
    addLatheZ(body, [
      { z: -0.2100, cy: BORE + 0.0185, rx: 0.0088, ry: 0.0072, n: 3.0, uv: 0, wear: 1 },
      { z: -0.3350, cy: BORE + 0.0185, rx: 0.0080, ry: 0.0066, n: 3.0, uv: 1, wear: 1 }
    ], 10, M.wood, { capStart: true, capEnd: true, density: 6, seed: 436 });
    /* steel ferrules where wood meets metal */
    collar(body, 0, BORE - 0.0078, -0.2040, -0.2100, 0.0150, 0.0162, 12, M.steelD, 437);
    collar(body, 0, BORE - 0.0078, -0.3360, -0.3420, 0.0132, 0.0146, 12, M.steelD, 438);

    /* --- grip and stock, both wood, buttplate steel. The grip loft STARTS
       inside the receiver box (floor at +15.6mm) and grows down out of it;
       started at the origin plane it hangs in the air below the gun, which
       is exactly what the first render of this weapon did. --- */
    var rake = 0.30, gs = [], N = 5;
    for (i = 0; i <= N; i++) {
      t = i / N;
      var gy = lerp(0.0140, -0.0980, t);
      gs.push({
        y: gy, cx: 0, cz: 0.0085 + Math.tan(rake) * (-gy - 0.0040),
        rx: lerp(0.0142, 0.0132, t), rz: lerp(0.0235, 0.0198, t),
        n: lerp(3.5, 3.1, t), ao: lerp(.92, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 12, M.wood, { capStart: true, capEnd: true, density: 6.5, seed: 441 });
    addLatheZ(body, [
      { z: 0.0560, cy: BORE - 0.0135, rx: 0.0135, ry: 0.0205, n: 3.4, uv: 0, wear: 1 },
      { z: 0.1500, cy: BORE - 0.0235, rx: 0.0125, ry: 0.0245, n: 3.4, uv: .5 },
      { z: 0.2460, cy: BORE - 0.0330, rx: 0.0135, ry: 0.0290, n: 3.4, uv: 1, wear: 1 }
    ], 12, M.wood, { capStart: true, density: 5, seed: 443 });
    addBox(body, 0, BORE - 0.0330, 0.2500, 0.0138, 0.0292, 0.0040, 0.0016, M.steelD,
      { ao: 1, density: 10, seed: 445 });
    slingLoop(body, 0, BORE - 0.0560, 0.1650, 0.0050, M.steelD, 447);
    slingLoop(body, -0.0155, BORE + 0.0060, -0.3420, 0.0048, M.steelD, 449);

    /* --- trigger --- */
    triggerGuard(body, -0.0620, -0.0130, BORE - 0.0330, BORE - 0.0560, 0.0052, M.nitride);
    addBox(trig, 0, -0.0100, -0.0030, 0.0032, 0.0102, 0.0030, 0.0010, M.steelD,
      { ao: .95, density: 22, seed: 451 });

    /* --- bolt carrier (the 'slide' channel): the charging handle knob that
       reciprocates on every shot, riding the port cut in the cover --- */
    addBox(bolt, 0.0128, BORE + 0.0052, -0.0340, 0.0034, 0.0048, 0.0330, 0.0012, M.steel,
      { ao: .9, density: 12, seed: 455 });
    addBone(bolt, 0.0150, BORE + 0.0052, -0.0250, 0.0268, BORE + 0.0038, -0.0250,
      0.0052, 0.0044, 10, M.steelD,
      { rings: 2, capEnd: true, round: .35, density: 14, wear: .7, seed: 456 });

    /* --- the banana magazine, rocked into the well. The first ring starts
       INSIDE the stamped box (receiver floor is ~15mm above the origin
       plane) so the mag grows out of the magwell instead of hovering under
       it -- the gap read is the one thing that kills a side profile. --- */
    var mgs = [], MN = 6;
    for (i = 0; i <= MN; i++) {
      t = i / MN;
      var arc = t * 1.05;   /* radians of curve the mag sweeps through */
      mgs.push({
        y: BORE - 0.0290 - 0.1060 * Math.sin(arc),
        cx: 0, cz: -0.0760 - 0.1060 * (1 - Math.cos(arc)),
        rx: 0.0122 * (1 - t * 0.06), rz: 0.0335 * (1 - t * 0.08),
        n: 4.2, ao: 1 - t * 0.10, uv: t
      });
    }
    addLoftY(mag, mgs, 10, M.wood, { capEnd: true, density: 7, seed: 461 });
    addBox(mag, 0, BORE - 0.0265, -0.0760, 0.0126, 0.0028, 0.0340, 0.0012, M.steelD,
      { ao: .95, density: 12, seed: 463 });
    /* mag catch behind the well */
    addBox(body, 0, BORE - 0.0330, -0.0560, 0.0042, 0.0046, 0.0058, 0.0014, M.steelD,
      { ao: 1.02, density: 18, seed: 465, eseg: 1 });

    var nSlide = makeNode(root, 'slide'), nMag = makeNode(root, 'mag'), nTrig = makeNode(root, 'trigger');
    nTrig.position.set(0, BORE - 0.0290, -0.0300);
    var A = { root: root, nodes: { slide: nSlide, mag: nMag, trigger: nTrig }, meshes: [], bbox: null };
    push(A, root, body, mat, 'body');
    push(A, nSlide, bolt, mat, 'bolt');
    push(A, nMag, mag, mat, 'mag');
    push(A, nTrig, trig, mat, 'trigger');

    A.sight = [0, SY, 0];
    A.zRear = zRearS; A.zFront = zFrontS;
    A.muzzle = [0, BORE + 0.0046, -0.6080];
    A.eject = [0.0150, BORE + 0.0080, -0.0350];
    /* an AK throws brass hard right and forward off the fixed ejector */
    A.ejectDir = [1.0, 0.40, -0.34];
    A.gripR = { p: [0, -0.0310, 0.0110], r: [-0.145, 0, 0], s: 0.97, arm: [0.26, -0.12, 0.10] };
    A.gripL = { p: [-0.0190, BORE - 0.0078, -0.2720], r: [-1.44, 0.13, 0.06], s: 0.97, arm: [0.79, 0.10, -0.10] };
    A.triggerRest = 0; A.triggerPull = -0.40;
    /* AK mags ROCK out: down and noticeably forward */
    A.magDrop = [0, -0.20, 0.075];
    A.slideBack = 0.0200;
    return A;
  }

  /* ------------------------------------------------------------------ M4 --
     The assaulter's carbine: 14.5in barrel, carbine plastic handguard, A2
     birdcage, F-marked front sight base, and a tubed red dot on the flat
     top. Shares the rifle's receiver dimensions because it IS the same
     receiver -- what differs is everything hung on it.
     ---------------------------------------------------------------------- */
  function buildM4(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-m4';
    var body = new Pile(), bolt = new Pile(), mag = new Pile(), trig = new Pile();
    var i, t, y;
    var BORE = 0.0440;
    var RAIL = BORE + 0.0290;
    var UX = 0.0176;
    var DY = RAIL + 0.0245;            /* red dot optical axis                */
    var zRearS = -0.0190, zFrontS = -0.0560;   /* the dot's two window planes */

    /* --- upper receiver, deck, charging handle (static, as on the rifle) */
    addBox(body, 0, BORE + 0.0010, -0.0440, UX, 0.0185, 0.0640, 0.0030, M.anod,
      { ao: 1, density: 6, seed: 501 });
    addBox(body, 0, BORE + 0.0208, -0.0460, 0.0150, 0.0034, 0.0620, 0.0016, M.anodD,
      { ao: 1.04, density: 10, seed: 503 });
    addBox(body, 0, BORE + 0.0142, 0.0248, 0.0224, 0.0040, 0.0104, 0.0015, M.anodD,
      { ao: 1.02, density: 12, seed: 505 });
    addBox(body, -0.0192, BORE + 0.0142, 0.0186, 0.0058, 0.0036, 0.0072, 0.0014, M.anodD,
      { ao: 1.06, density: 16, seed: 506, eseg: 1 });
    /* ejection side: port, deflector, forward assist */
    addBox(body, UX - 0.0010, BORE + 0.0056, -0.0470, 0.0020, 0.0092, 0.0215, 0.0009, M.dark,
      { ao: .42, density: 12, seed: 511, eseg: 1 });
    addBox(body, UX + 0.0024, BORE + 0.0086, -0.0182, 0.0042, 0.0054, 0.0078, 0.0026, M.anod,
      { ao: 1.04, density: 14, seed: 514 });
    addBone(body, UX - 0.0010, BORE + 0.0126, -0.0068, UX + 0.0090, BORE + 0.0126, -0.0068,
      0.0062, 0.0048, 10, M.anod,
      { rings: 1, capStart: true, capEnd: true, density: 18, wear: .5, seed: 515 });

    /* --- lower: receiver, flared magwell, guard, selector, pins --- */
    addBox(body, 0, BORE - 0.0300, -0.0180, 0.0163, 0.0125, 0.0500, 0.0028, M.anodL,
      { ao: .98, density: 6.5, seed: 521 });
    addLoftY(body, [
      { y: BORE - 0.0180, cz: -0.0640, rx: 0.0170, rz: 0.0348, n: 4.4, ao: .98, uv: 0 },
      { y: BORE - 0.0390, cz: -0.0645, rx: 0.0158, rz: 0.0332, n: 4.4, ao: .92, uv: .72 },
      { y: BORE - 0.0470, cz: -0.0650, rx: 0.0173, rz: 0.0352, n: 4.2, ao: .86, uv: 1 }
    ], 12, M.anodLip, { density: 6.5, seed: 523 });
    triggerGuard(body, -0.0770, -0.0240, BORE - 0.0424, BORE - 0.0640, 0.0060, M.anodL);
    addBox(trig, 0, -0.0232, -0.0082, 0.0038, 0.0112, 0.0032, 0.0010, M.steelD,
      { ao: .95, density: 22, seed: 525 });
    addBone(body, -0.0158, BORE - 0.0296, -0.0142, -0.0198, BORE - 0.0296, -0.0142,
      0.0060, 0.0056, 10, M.anodD,
      { rings: 1, capStart: true, capEnd: true, density: 20, wear: .5, seed: 531 });
    addBox(body, -0.0204, BORE - 0.0334, -0.0228, 0.0022, 0.0032, 0.0102, 0.0012, M.steelD,
      { ao: 1.05, density: 18, seed: 532, rotZ: 0.34, eseg: 1 });
    screw(body, -0.0166, BORE - 0.0232, 0.0176, 0.0042, -1, 0, 0, M.steelD, M.dark);
    screw(body, -0.0166, BORE - 0.0252, -0.0876, 0.0042, -1, 0, 0, M.steelD, M.dark);
    addBone(body, 0.0162, BORE - 0.0276, -0.0428, 0.0198, BORE - 0.0276, -0.0428,
      0.0042, 0.0038, 8, M.anodD,
      { rings: 1, capStart: true, capEnd: true, density: 22, wear: .5, seed: 535 });

    /* --- grip, buffer tube, collapsible stock (rifle's own blocks) --- */
    var rake = 0.32, gs = [], N = 6;
    for (i = 0; i <= N; i++) {
      t = i / N; y = lerp(-0.0050, -0.1080, t);
      gs.push({
        y: y, cx: 0, cz: 0.0110 + Math.tan(rake) * (-y - 0.0050),
        rx: lerp(0.0160, 0.0150, t), rz: lerp(0.0252, 0.0212, t),
        n: lerp(3.6, 3.2, t), ao: lerp(.92, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 14, M.poly, { capStart: true, capEnd: true, density: 7, seed: 541 });
    addLatheZ(body, [
      { z: 0.0210, cy: BORE - 0.0020, rx: 0.0166, n: 2, uv: 0, wear: 1 },
      { z: 0.0420, cy: BORE - 0.0020, rx: 0.0148, n: 2, uv: .10, wear: 1 },
      { z: 0.1990, cy: BORE - 0.0020, rx: 0.0148, n: 2, uv: .96 },
      { z: 0.2050, cy: BORE - 0.0020, rx: 0.0136, n: 2, uv: 1, wear: 1 }
    ], 14, M.anodD, { capStart: true, capEnd: true, density: 6, seed: 547 });
    addLoftY(body, [
      { y: BORE - 0.0330, cz: 0.1430, rx: 0.0194, rz: 0.0636, n: 4.6, ao: .90, uv: 0 },
      { y: BORE - 0.0060, cz: 0.1448, rx: 0.0212, rz: 0.0678, n: 4.8, ao: .98, uv: .45 },
      { y: BORE + 0.0208, cz: 0.1486, rx: 0.0178, rz: 0.0616, n: 4.4, ao: .94, uv: 1 }
    ], 12, M.poly, { capStart: true, capEnd: true, density: 5.5, seed: 549 });
    addBox(body, 0, BORE - 0.0040, 0.2136, 0.0168, 0.0246, 0.0054, 0.0028, M.rubber,
      { ao: 1, density: 9, seed: 551 });
    addBox(body, 0, BORE - 0.0372, 0.1720, 0.0074, 0.0058, 0.0206, 0.0018, M.polyL,
      { ao: .86, density: 12, seed: 552, eseg: 1 });
    slingLoop(body, -0.0219, BORE + 0.0040, 0.0900, 0.0052, M.steelD, 555);

    /* --- flat-top rail over the receiver only --- */
    addBox(body, 0, RAIL - 0.0050, -0.0460, 0.0106, 0.0050, 0.0660, 0.0016, M.anodD,
      { ao: 1.04, density: 9, seed: 561 });
    railSlots(body, 0.0108, RAIL - 0.0018, 0.0060, -0.0100, 12, M.dark);

    /* --- carbine handguard: round, ribbed, plastic; delta ring; cap --- */
    addLatheZ(body, [
      { z: -0.1080, cy: BORE, rx: 0.0176, ry: 0.0176, n: 2.6, uv: 0, wear: 1 },
      { z: -0.1300, cy: BORE, rx: 0.0186, ry: 0.0186, n: 2.6, uv: .18 },
      { z: -0.2250, cy: BORE, rx: 0.0186, ry: 0.0186, n: 2.6, uv: .82 },
      { z: -0.2420, cy: BORE, rx: 0.0168, ry: 0.0168, n: 2.6, uv: 1, wear: 1 }
    ], 14, M.poly, { density: 5.5, seed: 563 });
    /* the vent rows every carbine guard has, one each flank */
    for (i = 0; i < 3; i++) {
      addBox(body, -0.0172, BORE, -0.1450 - i * 0.0330, 0.0016, 0.0028, 0.0100, 0.0007, M.dark,
        { ao: .46, density: 16, seed: 570 + i, eseg: 1 });
      addBox(body, 0.0172, BORE, -0.1450 - i * 0.0330, 0.0016, 0.0028, 0.0100, 0.0007, M.dark,
        { ao: .46, density: 16, seed: 574 + i, eseg: 1 });
    }
    collar(body, 0, BORE, -0.1040, -0.1180, 0.0180, 0.0198, 14, M.anodD, 565);
    collar(body, 0, BORE, -0.2420, -0.2500, 0.0150, 0.0170, 14, M.anodD, 566);

    /* --- barrel, FSB tower with A-frame legs, A2 birdcage --- */
    addLatheZ(body, [
      { z: -0.2500, cy: BORE, rx: 0.0090, n: 2, uv: 0, wear: .5 },
      { z: -0.3640, cy: BORE, rx: 0.0088, n: 2, uv: .9 },
      { z: -0.3700, cy: BORE, rx: 0.0084, n: 2, uv: 1, wear: 1 }
    ], 12, M.nitride, { density: 8, seed: 581 });
    /* F-base: post between wings, on its tower. The A-frame legs run the
       whole way from the gas block up to the post's base -- a front sight
       is a TOWER, and a post floating over a stub of a tower was the
       loudest error on the first render of this gun. */
    addBox(body, 0, BORE + 0.0060, -0.2580, 0.0080, 0.0090, 0.0110, 0.0016, M.nitride,
      { ao: .95, density: 12, seed: 583 });
    frontPost(body, -0.2580, RAIL + 0.0040, 0.0030, 0.0086, 0.0022, M.nitride, M.dotA, 585, 0.0056);
    for (i = 0; i < 2; i++)
      addBox(body, i ? 0.0052 : -0.0052, BORE + 0.0225, -0.2580, 0.0016, 0.0155, 0.0052, 0.0007, M.nitride,
        { ao: .92, density: 16, seed: 587 + i, rotZ: i ? -0.16 : 0.16, eseg: 1 });
    pin(body, 0, BORE - 0.0085, -0.2580, 0.0022, 0, -1, 0, M.steelD);
    /* A2 birdcage with its five upper ports */
    addLatheZ(body, [
      { z: -0.3700, cy: BORE, rx: 0.0108, n: 2, uv: 0, wear: 1 },
      { z: -0.3780, cy: BORE, rx: 0.0104, n: 2, uv: .2 },
      { z: -0.4120, cy: BORE, rx: 0.0104, n: 2, uv: .8 },
      { z: -0.4200, cy: BORE, rx: 0.0110, n: 2, uv: .94, wear: 1 },
      { z: -0.4250, cy: BORE, rx: 0.0098, n: 2, uv: 1, wear: 1 }
    ], 14, M.nitride, { capStart: true, capEnd: true, density: 10, seed: 591 });
    capDisc(body, 0, BORE, -0.42535, 0.0052, 12, M.dark, true);
    for (i = 0; i < 5; i++) {
      var fa = PI * (0.10 + i * 0.20);
      addBox(body, Math.cos(fa) * 0.0088, BORE + Math.sin(fa) * 0.0088, -0.3950,
        0.0018, 0.0016, 0.0110, 0.0006, M.dark,
        { ao: .40, density: 20, seed: 600 + i, rotZ: fa, eseg: 1 });
    }

    /* --- the red dot: riser, tube, two glass planes, the dot itself --- */
    addBox(body, 0, RAIL + 0.0052, -0.0375, 0.0098, 0.0052, 0.0225, 0.0016, M.anodD,
      { ao: .98, density: 10, seed: 611 });
    addBox(body, -0.0116, RAIL + 0.0040, -0.0375, 0.0022, 0.0042, 0.0200, 0.0010, M.anodD,
      { ao: 1.04, density: 14, seed: 612, eseg: 1 });
    screw(body, -0.0140, RAIL + 0.0040, -0.0375, 0.0036, -1, 0, 0, M.steelD, M.dark);
    addLatheZ(body, [
      { z: zRearS + 0.0026, cy: DY, rx: 0.0146, n: 2.4, uv: 0, wear: 1 },
      { z: zRearS - 0.0020, cy: DY, rx: 0.0132, n: 2.4, uv: .2 },
      { z: zFrontS + 0.0030, cy: DY, rx: 0.0132, n: 2.4, uv: .82 },
      { z: zFrontS - 0.0020, cy: DY, rx: 0.0148, n: 2.4, uv: 1, wear: 1 }
    ], 14, M.anodD, { density: 8, seed: 613 });
    /* emitter housing under the tube, where the LED actually lives */
    addBox(body, 0, DY - 0.0110, -0.0480, 0.0052, 0.0040, 0.0072, 0.0014, M.anodD,
      { ao: .9, density: 14, seed: 614, eseg: 1 });
    /* glass: ocular facing the eye, objective facing the world */
    capDisc(body, 0, DY, zRearS - 0.0002, 0.0124, 12, M.glass, false);
    capDisc(body, 0, DY, zFrontS + 0.0006, 0.0124, 12, M.glass, true);
    /* the dot: a 2 MOA emissive fleck floating mid-tube on the axis */
    addBox(body, 0, DY, -0.0430, 0.0012, 0.0012, 0.0005, 0, M.dotA,
      { ao: 1, density: 30, seed: 615, wear: 0, eseg: 1 });
    /* elevation + windage caps */
    addBone(body, 0, DY + 0.0128, -0.0430, 0, DY + 0.0164, -0.0430, 0.0052, 0.0050, 10, M.anodD,
      { rings: 1, capEnd: true, density: 20, wear: .4, seed: 616 });
    addBone(body, 0.0128, DY, -0.0430, 0.0164, DY, -0.0430, 0.0052, 0.0050, 10, M.anodD,
      { rings: 1, capEnd: true, density: 20, wear: .4, seed: 617 });

    /* --- folded rear BUIS on the receiver tail --- */
    addBox(body, 0, RAIL + 0.0014, 0.0088, 0.0092, 0.0018, 0.0092, 0.0008, M.anodD,
      { ao: 1.02, density: 18, seed: 621, eseg: 1 });
    addBox(body, 0, RAIL + 0.0046, 0.0072, 0.0068, 0.0016, 0.0074, 0.0007, M.anodD,
      { ao: .96, density: 20, seed: 622, eseg: 1 });

    /* --- bolt carrier + brass rim on the 'slide' channel --- */
    addBox(bolt, UX - 0.0024, BORE + 0.0056, -0.0575, 0.0038, 0.0074, 0.0104, 0.0016, M.steelD,
      { ao: .76, density: 14, seed: 631 });
    addLatheZ(bolt, [
      { z: -0.0616, cx: UX - 0.0030, cy: BORE + 0.0044, rx: 0.0042, n: 2, uv: 0 },
      { z: -0.0664, cx: UX - 0.0030, cy: BORE + 0.0044, rx: 0.0040, n: 2, uv: 1, wear: 1 }
    ], 10, M.brass, { capStart: true, capEnd: true, density: 26, seed: 632 });

    /* --- 30-round mag, the gentle 5.56 curve --- */
    addLoftY(mag, [
      { y: BORE - 0.0470, cx: 0, cz: -0.0645, rx: 0.0120, rz: 0.0330, n: 4.2, ao: .95, uv: 0 },
      { y: BORE - 0.0780, cx: 0, cz: -0.0700, rx: 0.0118, rz: 0.0325, n: 4.2, ao: .92, uv: .4 },
      { y: BORE - 0.1060, cx: 0, cz: -0.0810, rx: 0.0114, rz: 0.0318, n: 4.2, ao: .88, uv: .8 },
      { y: BORE - 0.1180, cx: 0, cz: -0.0880, rx: 0.0112, rz: 0.0312, n: 4.2, ao: .85, uv: 1 }
    ], 10, M.nitride, { density: 8, seed: 641 });
    addBox(mag, 0, BORE - 0.1240, -0.0900, 0.0124, 0.0042, 0.0330, 0.0016, M.polyL,
      { ao: 1, density: 12, seed: 643 });

    var nBolt = makeNode(root, 'slide'), nMag = makeNode(root, 'mag'), nTrig = makeNode(root, 'trigger');
    nTrig.position.set(0, BORE - 0.0330, -0.0400);
    var A = { root: root, nodes: { slide: nBolt, mag: nMag, trigger: nTrig }, meshes: [], bbox: null };
    push(A, root, body, mat, 'body');
    push(A, nBolt, bolt, mat, 'bolt');
    push(A, nMag, mag, mat, 'mag');
    push(A, nTrig, trig, mat, 'trigger');

    /* ADS aligns the dot's two window planes on the camera axis, exactly
       as the rifle aligns its two lens planes -- the dot ends up floating
       dead centre, which is the entire selling point of a red dot */
    A.sight = [0, DY, 0];
    A.zRear = zRearS; A.zFront = zFrontS;
    A.muzzle = [0, BORE, -0.4270];
    A.eject = [UX + 0.0044, BORE + 0.0090, -0.0470];
    A.ejectDir = [1.0, 0.34, -0.46];
    A.gripR = { p: [0, -0.0330, 0.0163], r: [-0.160, 0, 0], s: 0.98, arm: [0.26, -0.12, 0.10] };
    A.gripL = { p: [-0.0200, BORE - 0.0030, -0.1880], r: [-1.44, 0.14, 0.06], s: 0.97, arm: [0.79, 0.10, -0.10] };
    A.triggerRest = 0; A.triggerPull = -0.40;
    A.magDrop = [0, -0.24, 0.030];
    A.slideBack = 0.0212;
    return A;
  }

  /* ----------------------------------------------------------------- DMR --
     The marksman's bolt gun: cylindrical action in a full-length precision
     stock, heavy 7.62 barrel, 10-round box, folded bipod, and the largest
     glass on the rack. The bolt handle rides the 'slide' channel with a
     54mm throw, so the cycle after every shot is the handle coming back --
     the one motion that says bolt gun from across a room.
     ---------------------------------------------------------------------- */
  function buildDmr(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-dmr';
    var body = new Pile(), bolt = new Pile(), mag = new Pile(), trig = new Pile();
    var i, t;
    var BORE = 0.0430;
    var OY = BORE + 0.0470;            /* scope axis                          */
    var TR = 0.0165;                   /* 34mm main tube                      */
    var zOc = 0.0560, zObj = -0.1500;  /* ocular / objective lens planes      */

    /* --- action: round receiver, port cut, bolt shroud tail --- */
    addLatheZ(body, [
      { z: 0.0320, cy: BORE, rx: 0.0156, n: 2.4, uv: 0, wear: 1 },
      { z: -0.0400, cy: BORE, rx: 0.0158, n: 2.4, uv: .5 },
      { z: -0.1250, cy: BORE, rx: 0.0150, n: 2.4, uv: 1, wear: .6 }
    ], 14, M.steelD, { capStart: true, density: 6, seed: 701 });
    addBox(body, 0.0138, BORE + 0.0022, -0.0560, 0.0020, 0.0058, 0.0190, 0.0008, M.dark,
      { ao: .44, density: 12, seed: 703, eseg: 1 });
    /* loaded-chamber indicator + bolt release, left wall */
    addBox(body, -0.0148, BORE + 0.0020, -0.0260, 0.0018, 0.0030, 0.0074, 0.0009, M.steelD,
      { ao: 1.04, density: 18, seed: 705, eseg: 1 });

    /* --- heavy barrel to the crown --- */
    addLatheZ(body, [
      { z: -0.1250, cy: BORE, rx: 0.0128, n: 2, uv: 0, wear: .4 },
      { z: -0.3600, cy: BORE, rx: 0.0116, n: 2, uv: .55 },
      { z: -0.5520, cy: BORE, rx: 0.0104, n: 2, uv: .96 },
      { z: -0.5600, cy: BORE, rx: 0.0098, n: 2, uv: 1, wear: 1 }
    ], 14, M.nitride, { capEnd: true, density: 4.5, seed: 707 });
    /* recessed target crown */
    collar(body, 0, BORE, -0.5560, -0.5600, 0.0096, 0.0102, 12, M.steelD, 709);
    capDisc(body, 0, BORE, -0.5605, 0.0046, 10, M.dark, true);

    /* --- the stock: forend, grip, butt with cheek riser and pad --- */
    addLatheZ(body, [
      { z: -0.1150, cy: BORE - 0.0102, rx: 0.0168, ry: 0.0168, n: 3.6, uv: 0, wear: 1 },
      { z: -0.2100, cy: BORE - 0.0105, rx: 0.0172, ry: 0.0160, n: 3.6, uv: .45 },
      { z: -0.2900, cy: BORE - 0.0100, rx: 0.0160, ry: 0.0148, n: 3.6, uv: .85 },
      { z: -0.3120, cy: BORE - 0.0092, rx: 0.0138, ry: 0.0126, n: 3.4, uv: 1, wear: 1 }
    ], 12, M.polyL, { capEnd: true, density: 5, seed: 711 });
    /* mid-stock: the section a rifle stock is NOT allowed to skip. It
       bridges forend to wrist UNDER the action -- the magazine well and the
       grip both grow out of this, and without it both were floating in
       space below a naked receiver tube. */
    addLatheZ(body, [
      { z: -0.1300, cy: BORE - 0.0125, rx: 0.0168, ry: 0.0158, n: 3.6, uv: 0 },
      { z: -0.0300, cy: BORE - 0.0128, rx: 0.0170, ry: 0.0160, n: 3.6, uv: .5 },
      { z: 0.0450, cy: BORE - 0.0135, rx: 0.0165, ry: 0.0158, n: 3.6, uv: 1 }
    ], 12, M.polyL, { capEnd: true, density: 5, seed: 712 });
    var rake = 0.30, gs = [], N = 5;
    for (i = 0; i <= N; i++) {
      t = i / N;
      var gy = lerp(0.0160, -0.1000, t);
      gs.push({
        y: gy, cx: 0, cz: 0.0100 + Math.tan(rake) * (-gy - 0.0040),
        rx: lerp(0.0150, 0.0138, t), rz: lerp(0.0245, 0.0205, t),
        n: lerp(3.5, 3.1, t), ao: lerp(.92, 1.0, t), uv: t
      });
    }
    addLoftY(body, gs, 12, M.polyL, { capStart: true, capEnd: true, density: 6.5, seed: 713 });
    addLatheZ(body, [
      { z: 0.0350, cy: BORE - 0.0150, rx: 0.0150, ry: 0.0260, n: 3.4, uv: 0, wear: 1 },
      { z: 0.1400, cy: BORE - 0.0205, rx: 0.0140, ry: 0.0300, n: 3.4, uv: .5 },
      { z: 0.2450, cy: BORE - 0.0275, rx: 0.0150, ry: 0.0340, n: 3.4, uv: 1, wear: 1 }
    ], 12, M.polyL, { capStart: true, density: 4.5, seed: 715 });
    /* cheek riser: the raised comb that puts the eye behind the glass */
    addBox(body, 0, BORE + 0.0075, 0.1520, 0.0118, 0.0058, 0.0560, 0.0022, M.poly,
      { ao: .96, density: 8, seed: 717 });
    screw(body, -0.0125, BORE + 0.0060, 0.1300, 0.0034, -1, 0, 0, M.steelD, M.dark);
    screw(body, -0.0125, BORE + 0.0060, 0.1740, 0.0034, -1, 0, 0, M.steelD, M.dark);
    /* rubber recoil pad */
    addBox(body, 0, BORE - 0.0275, 0.2500, 0.0152, 0.0345, 0.0046, 0.0024, M.rubber,
      { ao: 1, density: 9, seed: 719 });
    slingLoop(body, 0, BORE - 0.0620, 0.1900, 0.0050, M.steelD, 721);
    slingLoop(body, 0, BORE - 0.0290, -0.2650, 0.0048, M.steelD, 723);

    /* --- trigger --- */
    triggerGuard(body, -0.0700, -0.0180, BORE - 0.0380, BORE - 0.0600, 0.0056, M.polyL);
    addBox(trig, 0, -0.0110, -0.0040, 0.0034, 0.0108, 0.0030, 0.0010, M.steelD,
      { ao: .95, density: 22, seed: 725 });

    /* --- bolt: shroud, body, and the bent handle with its ball --- */
    addLatheZ(bolt, [
      { z: 0.0320, cy: BORE, rx: 0.0118, n: 2, uv: 0 },
      { z: 0.0560, cy: BORE, rx: 0.0112, n: 2, uv: .7 },
      { z: 0.0620, cy: BORE, rx: 0.0084, n: 2, uv: 1, wear: 1 }
    ], 12, M.steel, { capEnd: true, density: 10, seed: 731 });
    addBone(bolt, 0.0120, BORE + 0.0010, -0.0060, 0.0300, BORE - 0.0140, 0.0030,
      0.0036, 0.0030, 8, M.steel, { rings: 2, density: 14, wear: .6, seed: 733 });
    addBone(bolt, 0.0300, BORE - 0.0140, 0.0030, 0.0368, BORE - 0.0196, 0.0064,
      0.0072, 0.0062, 10, M.steel,
      { rings: 2, capEnd: true, round: .5, density: 12, wear: .7, seed: 735 });

    /* --- 10-round steel box, seated up into the stock line so it emerges
       from the well rather than floating under it --- */
    addLoftY(mag, [
      { y: BORE - 0.0300, cx: 0, cz: -0.0505, rx: 0.0116, rz: 0.0295, n: 4.2, ao: .95, uv: 0 },
      { y: BORE - 0.0660, cx: 0, cz: -0.0545, rx: 0.0112, rz: 0.0288, n: 4.2, ao: .9, uv: .7 },
      { y: BORE - 0.0800, cx: 0, cz: -0.0565, rx: 0.0110, rz: 0.0284, n: 4.2, ao: .86, uv: 1 }
    ], 10, M.steelD, { density: 9, seed: 741 });
    addBox(mag, 0, BORE - 0.0850, -0.0565, 0.0122, 0.0038, 0.0300, 0.0014, M.steelD,
      { ao: .95, density: 12, seed: 743 });

    /* --- bipod, folded back along the forend --- */
    addBox(body, 0, BORE - 0.0262, -0.2960, 0.0078, 0.0048, 0.0100, 0.0016, M.steelD,
      { ao: .95, density: 14, seed: 751 });
    for (i = 0; i < 2; i++) {
      var bx = i ? 0.0062 : -0.0062;
      addBone(body, bx, BORE - 0.0295, -0.2920, bx * 1.5, BORE - 0.0230, -0.1800,
        0.0030, 0.0026, 8, M.steelD, { rings: 2, density: 16, wear: .5, seed: 753 + i });
      addBone(body, bx * 1.5, BORE - 0.0230, -0.1800, bx * 1.5, BORE - 0.0230, -0.1720,
        0.0034, 0.0034, 8, M.rubber, { rings: 1, capEnd: true, density: 20, seed: 757 + i });
    }

    /* --- the scope: rings, tube, bells, turrets, glass --- */
    for (i = 0; i < 2; i++) {
      var zr = i ? -0.0780 : -0.0060;
      addBox(body, 0, BORE + 0.0240, zr, 0.0100, 0.0095, 0.0110, 0.0018, M.anodD,
        { ao: .96, density: 10, seed: 761 + i });
      addLatheZ(body, [
        { z: zr + 0.0052, cy: OY, rx: TR + 0.0016, n: 2, uv: 0, wear: .8 },
        { z: zr - 0.0052, cy: OY, rx: TR + 0.0016, n: 2, uv: 1, wear: .8 }
      ], 14, M.anodD, { density: 12, seed: 764 + i });
      screw(body, -0.0106, BORE + 0.0250, zr, 0.0030, -1, 0, 0, M.steelD, M.dark);
    }
    addLatheZ(body, [
      { z: zOc, cy: OY, rx: 0.0198, n: 2, uv: 0, wear: 1 },
      { z: 0.0380, cy: OY, rx: 0.0172, n: 2, uv: .10 },
      { z: -0.0330, cy: OY, rx: TR, n: 2, uv: .42 },
      { z: -0.0980, cy: OY, rx: TR, n: 2, uv: .72 },
      { z: -0.1180, cy: OY, rx: 0.0225, n: 2, uv: .88 },
      { z: zObj, cy: OY, rx: 0.0258, n: 2, uv: 1, wear: 1 }
    ], 16, M.anodD, { density: 5.5, seed: 771 });
    /* turret saddle: elevation up, windage right, both knurled */
    addBone(body, 0, OY, -0.0560, 0, OY + 0.0245, -0.0560, 0.0088, 0.0082, 12, M.anodD,
      { rings: 2, capEnd: true, density: 14, wear: .5, seed: 773 });
    collar(body, 0, OY + 0.0205, -0.0560, -0.0562, 0.0082, 0.0090, 12, M.steelD, 774);
    addBone(body, 0.0165, OY, -0.0560, 0.0388, OY, -0.0560, 0.0082, 0.0076, 12, M.anodD,
      { rings: 2, capEnd: true, density: 14, wear: .5, seed: 775 });
    /* side-focus knob on the left, because a 10x without one cannot range */
    addBone(body, -0.0165, OY, -0.0560, -0.0330, OY, -0.0560, 0.0086, 0.0080, 12, M.anodD,
      { rings: 1, capEnd: true, density: 14, wear: .4, seed: 776 });
    /* glass, both ends; ocular carries the faint lens glow */
    capDisc(body, 0, OY, zOc + 0.0004, 0.0186, 14, M.glass, false);
    capDisc(body, 0, OY, zOc + 0.0002, 0.0120, 12, M.lens, false);
    capDisc(body, 0, OY, zObj + 0.0006, 0.0246, 14, M.glass, true);
    /* flip-up caps, open: the two hinged discs a working DMR always shows */
    addBox(body, 0, OY + 0.0198, zOc + 0.0058, 0.0092, 0.0090, 0.0016, 0.0007, M.rubber,
      { ao: .9, density: 12, seed: 781, rotZ: 0, eseg: 1 });
    addBox(body, 0, OY + 0.0252, zObj - 0.0026, 0.0118, 0.0112, 0.0016, 0.0007, M.rubber,
      { ao: .9, density: 12, seed: 783, eseg: 1 });

    var nBolt = makeNode(root, 'slide'), nMag = makeNode(root, 'mag'), nTrig = makeNode(root, 'trigger');
    nTrig.position.set(0, BORE - 0.0300, -0.0360);
    var A = { root: root, nodes: { slide: nBolt, mag: nMag, trigger: nTrig }, meshes: [], bbox: null };
    push(A, root, body, mat, 'body');
    push(A, nBolt, bolt, mat, 'bolt');
    push(A, nMag, mag, mat, 'mag');
    push(A, nTrig, trig, mat, 'trigger');

    /* the ADS solve aligns the scope's two lens planes, same contract as
       the rifle's LPVO; past mask 0.5 the game's 2D scope owns the picture */
    A.sight = [0, OY, 0];
    A.zRear = zOc; A.zFront = zObj;
    A.muzzle = [0, BORE, -0.5650];
    A.eject = [0.0140, BORE + 0.0060, -0.0550];
    /* a bolt gun tosses its case up and out on the lift, not back past the
       shooter's ear -- up-right with almost no rearward component */
    A.ejectDir = [1.0, 0.62, 0.06];
    A.gripR = { p: [0, -0.0330, 0.0170], r: [-0.130, 0, 0], s: 0.98, arm: [0.26, -0.12, 0.10] };
    A.gripL = { p: [-0.0195, BORE - 0.0140, -0.2280], r: [-1.44, 0.12, 0.06], s: 0.97, arm: [0.79, 0.10, -0.10] };
    A.triggerRest = 0; A.triggerPull = -0.40;
    A.magDrop = [0, -0.16, 0.030];
    /* the long throw: S.slide drives the whole bolt group 54mm rearward */
    A.slideBack = 0.0540;
    return A;
  }

  /* ------------------------------------------------------------- nullstar --
     NULLSTAR gravity-field projector. This is deliberately not a firearm
     with science-fiction trim: there is no barrel. Three open field vanes
     surround a disposable singularity seed, two exposed brass coils counter-
     rotate around a suspended containment core, and the whole front cage is
     fed by an asymmetric capacitor brick on the right flank.

     Local dimensions are still metres. The 870mm shoulder-to-vane silhouette
     puts it in the heavy-weapon class without borrowing the RPG's tube or the
     chaingun's barrel cluster. The seed is its own `payload` node so firing
     and reload choreography can remove/reseat the visible round without
     knowing anything about the gameplay implementation in NUKEM.html.
     ---------------------------------------------------------------------- */
  function buildNullstar(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-nullstar';
    var body = new Pile(), coilA = new Pile(), coilB = new Pile();
    var payload = new Pile(), trig = new Pile();
    var i;
    var BORE = 0.0430, SY = 0.1130;
    var zRearS = -0.0350, zFrontS = -0.3380;

    function fieldRing(pile, r, phase, Mat, seed) {
      var N = 12;
      for (var j = 0; j < N; j++) {
        var a0 = phase + j * TAU / N, a1 = phase + (j + 1) * TAU / N;
        addBone(pile,
          Math.cos(a0) * r, Math.sin(a0) * r, 0,
          Math.cos(a1) * r, Math.sin(a1) * r, 0,
          0.0035, 0.0035, 7, Mat,
          { rings: 1, density: 28, wear: .62, seed: seed + j });
      }
      /* Three deliberately unequal commutator shoes make rotation legible;
         a perfectly circular coil can spin forever without appearing to. */
      for (j = 0; j < 3; j++) {
        var a = phase + j * TAU / 3;
        addBox(pile, Math.cos(a) * r, Math.sin(a) * r, 0,
          0.0080 + j * 0.0012, 0.0048, 0.0085, 0.0015, M.anodD,
          { ao: 1.04, density: 16, seed: seed + 30 + j, rotZ: a });
      }
    }

    /* ---- shoulder chassis + firing grip ------------------------------ */
    addBox(body, 0, 0.0300, -0.0550, 0.0540, 0.0440, 0.1260, 0.0080, M.anod,
      { ao: .98, density: 4.8, seed: 801 });
    addBox(body, 0, 0.0760, -0.0580, 0.0450, 0.0060, 0.1120, 0.0022, M.anodD,
      { ao: 1.03, density: 8, seed: 803 });
    addBox(body, 0, -0.0160, -0.0400, 0.0460, 0.0050, 0.1030, 0.0020, M.anodL,
      { ao: .80, density: 7, seed: 805 });
    /* stamped ribs break the receiver's large black flank */
    for (i = 0; i < 5; i++) {
      addBox(body, -0.0545, 0.0310, 0.0300 - i * 0.0380,
        0.0026, 0.0310, 0.0110, 0.0010, M.anodD,
        { ao: .88, density: 13, seed: 807 + i, eseg: 1 });
    }

    var gs = [], GN = 5;
    for (i = 0; i <= GN; i++) {
      var gt = i / GN, gy = lerp(-0.0020, -0.1320, gt);
      gs.push({
        y: gy, cx: 0, cz: 0.0300 + Math.tan(0.28) * (-gy + 0.002),
        rx: lerp(0.0172, 0.0158, gt), rz: lerp(0.0280, 0.0230, gt),
        n: 3.5, ao: lerp(.90, 1.0, gt), uv: gt
      });
    }
    addLoftY(body, gs, 14, M.poly, { capStart: true, capEnd: true, density: 6.5, seed: 813 });
    triggerGuard(body, -0.0520, 0.0100, -0.0120, -0.0470, 0.0068, M.anodD);
    addBox(trig, 0, -0.0260, -0.0310, 0.0040, 0.0120, 0.0034, 0.0011, M.brass,
      { ao: 1.0, density: 24, seed: 815 });

    /* A skeletal shoulder brace keeps the silhouette industrial instead of
       turning the rear half into another rifle stock. */
    for (i = -1; i <= 1; i += 2) {
      addBone(body, i * 0.0340, 0.0470, 0.0450,
        i * 0.0420, 0.0310, 0.2260,
        0.0070, 0.0085, 8, M.anodD,
        { rings: 3, capStart: true, capEnd: true, n: 3.4, wear: .45, seed: 820 + i });
    }
    addBox(body, 0, 0.0240, 0.2360, 0.0500, 0.0430, 0.0120, 0.0050, M.rubber,
      { ao: .92, density: 7, seed: 823 });
    addBox(body, 0, 0.0670, 0.1710, 0.0360, 0.0065, 0.0520, 0.0022, M.anodL,
      { ao: .96, density: 7, seed: 825 });

    /* ---- asymmetric capacitor bank ----------------------------------- */
    addBox(body, 0.0860, 0.0270, -0.0520, 0.0380, 0.0520, 0.0940, 0.0070, M.anodD,
      { ao: .94, density: 4.5, seed: 831 });
    addBox(body, 0.0860, 0.0805, -0.0520, 0.0340, 0.0040, 0.0860, 0.0015, M.brass,
      { ao: 1.08, density: 18, seed: 833 });
    for (i = 0; i < 4; i++) {
      var cz = 0.0050 - i * 0.0380;
      addBone(body, 0.1245, -0.0020, cz, 0.1245, 0.0580, cz,
        0.0085, 0.0085, 10, M.brass,
        { rings: 2, capStart: true, capEnd: true, density: 20, wear: .35, seed: 835 + i });
      addBox(body, 0.1260, 0.0280, cz, 0.0022, 0.0220, 0.0120, 0.0008, M.anodD,
        { ao: .78, density: 16, seed: 841 + i, eseg: 1 });
    }
    /* exposed bus bars carry the capacitor into the field cage */
    addBone(body, 0.0940, 0.0740, -0.1420, 0.0520, 0.0780, -0.2420,
      0.0048, 0.0040, 8, M.brass,
      { rings: 2, capStart: true, capEnd: true, density: 24, wear: .55, seed: 847 });
    addBone(body, 0.0940, -0.0180, -0.1420, 0.0520, 0.0040, -0.2420,
      0.0048, 0.0040, 8, M.brass,
      { rings: 2, capStart: true, capEnd: true, density: 24, wear: .55, seed: 849 });

    /* ---- open containment cage --------------------------------------- */
    /* Four rails hold the core without enclosing it in a gun-shaped tube. */
    for (i = 0; i < 4; i++) {
      var ca = PI * 0.25 + i * PI * 0.5;
      var cx0 = Math.cos(ca) * 0.0410, cy0 = BORE + Math.sin(ca) * 0.0410;
      addBone(body, cx0, cy0, -0.1700, cx0, cy0, -0.2860,
        0.0056, 0.0048, 8, M.anodD,
        { rings: 2, capStart: true, capEnd: true, n: 3.2, wear: .42, seed: 853 + i });
    }
    collar(body, 0, BORE, -0.1560, -0.1740, 0.0460, 0.0520, 16, M.anodL, 859);
    /* the collar is capped by the helper, but the cyan centre remains visible
       from both flanks because it sits forward of the receiver and behind the
       next ring rather than inside the collar's thin plane */

    /* Three vanes flare around empty space. Their outer endpoints, not a
       barrel crown, define the muzzle. */
    for (i = 0; i < 3; i++) {
      var va = PI * 0.5 + i * TAU / 3;
      var sx = Math.cos(va) * 0.0440, sy = BORE + Math.sin(va) * 0.0440;
      var ex = Math.cos(va) * 0.0670, ey = BORE + Math.sin(va) * 0.0670;
      addBone(body, sx, sy, -0.2820, ex, ey, -0.5900,
        0.0105, 0.0070, 8, M.anodH,
        { rings: 4, capStart: true, capEnd: true, n: 4.2, wear: .62, seed: 863 + i });
      /* black field shoe with a bright emitter inset */
      addBox(body, ex, ey, -0.5940, 0.0130, 0.0100, 0.0200, 0.0035, M.anodD,
        { ao: 1.02, density: 10, seed: 869 + i, rotZ: va });
      addBox(body, ex * .93, BORE + (ey - BORE) * .93, -0.6150,
        0.0060, 0.0045, 0.0035, 0.0010, i === 1 ? M.dotA : M.dotG,
        { ao: 1.1, density: 30, seed: 873 + i, rotZ: va, eseg: 1 });
      /* a brass induction spine makes each vane read as powered machinery */
      addBone(body, sx * 1.02, BORE + (sy - BORE) * 1.02, -0.3050,
        ex * .96, BORE + (ey - BORE) * .96, -0.5550,
        0.0030, 0.0024, 7, M.brass,
        { rings: 3, capStart: true, capEnd: true, density: 30, wear: .55, seed: 877 + i });
    }

    /* A vertical foregrip under the rear of the cage gives the support hand
       an honest contact point and balances the side-heavy capacitor. */
    addLoftY(body, [
      { y: 0.0050, cz: -0.2300, rx: 0.0175, rz: 0.0200, n: 3.6, ao: .88, uv: 0 },
      { y: -0.1230, cz: -0.2380, rx: 0.0155, rz: 0.0175, n: 3.2, ao: 1.0, uv: 1 }
    ], 12, M.poly, { capStart: true, capEnd: true, density: 7, seed: 883 });
    for (i = 0; i < 5; i++)
      addBox(body, 0, -0.0240 - i * 0.0190, -0.2560,
        0.0140, 0.0030, 0.0025, 0.0008, M.polyL,
        { ao: .83, density: 18, seed: 885 + i, eseg: 1 });

    /* sights live above the machinery and obey the same exact two-plane ADS
       contract as every conventional weapon on the rack. */
    rearNotch(body, zRearS, SY, 0.0044, 0.0050, 0.0070, 0.0030, M.anodD, M.dotG, 891);
    frontPost(body, zFrontS, SY, 0.0034, 0.0200, 0.0030, M.anodD, M.dotA, 893, 0.0120);

    /* The counter-rotating coils are local around their own pivots. */
    fieldRing(coilA, 0.0550, PI / 12, M.brass, 901);
    fieldRing(coilB, 0.0600, -PI / 10, M.steelD, 921);
    /* axial teeth give the two rings different silhouettes */
    for (i = 0; i < 6; i++) {
      var ta = i * TAU / 6;
      addBox(coilB, Math.cos(ta) * 0.0600, Math.sin(ta) * 0.0600, -0.0060,
        0.0042, 0.0042, 0.0120, 0.0010, M.brass,
        { ao: 1.02, density: 22, seed: 941 + i, rotZ: ta, eseg: 1 });
    }

    /* The disposable seed is a brass spindle around a luminous kernel. It is
       built in payload-local coordinates; the node supplies muzzle position. */
    addLatheZ(payload, [
      { z: 0.0250, rx: 0.0070, n: 2, uv: 0, wear: 1 },
      { z: 0.0170, rx: 0.0140, n: 2, uv: .20 },
      { z: -0.0170, rx: 0.0140, n: 2, uv: .80 },
      { z: -0.0250, rx: 0.0070, n: 2, uv: 1, wear: 1 }
    ], 12, M.brass, { capStart: true, capEnd: true, density: 22, seed: 951 });
    collar(payload, 0, 0, 0.0040, -0.0040, 0.0142, 0.0170, 12, M.anodD, 953);

    var nCoilA = makeNode(root, 'coils'), nCoilB = makeNode(root, 'coil2');
    var nCore = makeNode(root, 'core'), nPayload = makeNode(root, 'payload');
    var nTrig = makeNode(root, 'trigger');
    nCoilA.position.set(0, BORE, -0.3260);
    nCoilB.position.set(0, BORE, -0.4140);
    nCore.position.set(0, BORE, -0.2250);
    nPayload.position.set(0, BORE, -0.5720);
    nTrig.position.set(0, -0.0100, -0.0340);

    var A = {
      root: root,
      nodes: { coils: nCoilA, coil2: nCoilB, core: nCore, payload: nPayload, trigger: nTrig },
      meshes: [], bbox: null
    };
    push(A, root, body, mat, 'body');
    push(A, nCoilA, coilA, mat, 'field-coil-a');
    push(A, nCoilB, coilB, mat, 'field-coil-b');
    push(A, nPayload, payload, mat, 'payload-shell');
    push(A, nTrig, trig, mat, 'trigger');

    /* Two additive, low-poly layers sell a contained object rather than a
       painted light. They are asset-local materials so their colour/opacity
       can breathe without changing the shared muzzle-flash material. */
    var cmat = new THREE.MeshBasicMaterial({
      color: 0x58ffd1, transparent: true, opacity: .88,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      toneMapped: true, fog: false
    });
    cmat.name = 'nz-nullstar-core'; detachFromScenePatch(cmat);
    var hmat = new THREE.MeshBasicMaterial({
      color: 0x79a8ff, transparent: true, opacity: .34,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      wireframe: true, toneMapped: true, fog: false
    });
    hmat.name = 'nz-nullstar-halo'; detachFromScenePatch(hmat);
    var pmat = new THREE.MeshBasicMaterial({
      color: 0x9d7dff, transparent: true, opacity: .78,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      toneMapped: true, fog: false
    });
    pmat.name = 'nz-nullstar-payload'; detachFromScenePatch(pmat);

    var coreSolid = new THREE.Mesh(new THREE.IcosahedronGeometry(0.0240, 2), cmat);
    var coreHalo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.0350, 1), hmat);
    coreSolid.name = 'containment-core'; coreHalo.name = 'containment-halo';
    coreSolid.frustumCulled = coreHalo.frustumCulled = false;
    nCore.add(coreSolid); nCore.add(coreHalo);
    A.meshes.push(coreSolid, coreHalo);

    var seed = new THREE.Mesh(new THREE.OctahedronGeometry(0.0125, 1), pmat);
    seed.name = 'nullstar-seed'; seed.frustumCulled = false;
    nPayload.add(seed); A.meshes.push(seed);
    A.coreMat = cmat; A.coreHaloMat = hmat; A.payloadMat = pmat;

    A.sight = [0, SY, 0];
    A.zRear = zRearS; A.zFront = zFrontS;
    A.muzzle = [0, BORE, -0.6260];
    A.eject = null;
    A.gripR = { p: [0, -0.0340, 0.0320], r: [-0.145, 0, 0], s: 0.99, arm: [0.27, -0.12, 0.10] };
    A.gripL = { p: [-0.0200, -0.0600, -0.2360], r: [-0.08, 0.12, -0.15], s: 0.99, arm: [-0.58, 0.20, -0.16] };
    A.triggerRest = 0; A.triggerPull = -0.42;
    A.payloadHome = [0, BORE, -0.5720];
    return A;
  }

  /* =========================================================================
     7. FRAMING + TUNING
     CS2 renders the viewmodel through its OWN projection at viewmodel_fov,
     not the world FOV. Source's fov cvars are horizontal at 4:3, so CS2's
     default viewmodel_fov 60 is 46.8 degrees VERTICAL, and the common
     competitive 68 is 53.7. three.js takes vertical, so VM_FOV below is
     directly comparable: 50 == viewmodel_fov 64. One value for every weapon,
     exactly like CS2 -- a per-weapon viewmodel FOV is a tell.
     ====================================================================== */
  var VM_FOV = 50, VM_FOV_ADS = 46;
  /* Uniform scale on the viewmodel ROOT. Because the camera sits at the root's
     origin, scaling the root scales geometry and pose translation together, so
     the projected image is bit-for-bit identical -- what changes is the range
     of view-space depths the viewmodel occupies. That is the whole point: the
     weapon has to fit between the 0.08 near plane and the ~1.15 the player's
     collision radius keeps world geometry at, and a 950mm launcher held at
     arm's length does not fit on its own.
     0.60 rather than 0.94 because the poses below now hold every weapon at
     roughly twice the eye distance they used to be (see FRAMING). */
  var VM_SCALE = 0.60;

  /* ---------------------------------------------------------- FRAMING -----
     The previous table held the grip 25-30 cm from the eye. At VM_FOV 50 that
     projected the RPG across 59% x 179% of a 16:9 frame with its top edge at
     y=0.23 -- above the crosshair, straight through the middle of the screen.
     The shotgun ran 41% x 120%, the chaingun 52% x 112%. Every one of them
     covered the centre, which is the single thing a competitive viewmodel may
     never do.

     Every pose below is SOLVED, not eyeballed. The weapon-local origin (the
     web of the firing hand) is placed at a fixed screen anchor -- around
     (0.70, 0.85), i.e. low and right -- and the eye distance is then bisected
     until the projected weapon AABB is the target fraction of frame height.
     The result at 16:9, weapon box only (hands hang off the bottom):

        pistol   x 0.61..0.77  y 0.67..1.19   15% x 52%
        shotgun  x 0.54..0.80  y 0.62..1.20   25% x 58%
        chaingun x 0.54..0.85  y 0.58..1.16   31% x 58%
        rpg      x 0.54..0.80  y 0.60..1.16   26% x 56%

     Nothing reaches left of x 0.54 or above y 0.58, so the crosshair box is
     clear on every weapon in every pose except ADS, where being on the axis
     is the whole point. verify() now ASSERTS these bounds; the old verifier
     computed them and printed them but never failed on them, which is how a
     gun covering 179% of the screen shipped with a clean bill of health.

     Yaw is also up (0.056-0.072 -> 0.115-0.150 rad). Pointed dead down the
     bore a weapon projects to a narrow wedge and reads as a stick; canting it
     8 degrees shows the flank of the receiver, which is where the ejection
     port, selector and charging handle live -- the parts that say WHICH gun. */
  /* ------------------------------------------------------------- grenade --
     An M26 fragmentation grenade, upright in the fist. The one weapon that
     is mostly HAND: the body is a superellipse loft (the same tool that made
     the AK magazine), the spoon is a thin loft that climbs over the shoulder
     and hugs the flank, and the pull ring is eight bone chords standing in
     for a torus. Everything lives under one 'nade' node so the hand can be
     shown empty for half a second after each throw.
     Dimensions are real: 57mm body, 99mm overall, in the same metres every
     other weapon on the rack is built in. ---------------------------------- */
  function buildGrenade(mat) {
    var root = new THREE.Group(); root.name = 'nz-vm-grenade';
    var nade = new Pile();
    var i;
    var BX = 0, BY = 0.020, BZ = -0.010;   /* body centre in grip space */

    /* --- cast body: a lemon, widest just under the middle, olive over
       steel with the wear concentrated on the poles and the mold band --- */
    addLoftY(nade, [
      { y: BY - 0.0480, cx: BX, cz: BZ, rx: 0.00005, n: 2, uv: 0, ao: .82 },
      { y: BY - 0.0430, cx: BX, cz: BZ, rx: 0.0130, n: 2, uv: .08 },
      { y: BY - 0.0330, cx: BX, cz: BZ, rx: 0.0224, n: 2, uv: .22 },
      { y: BY - 0.0160, cx: BX, cz: BZ, rx: 0.0281, n: 2, uv: .38 },
      { y: BY + 0.0040, cx: BX, cz: BZ, rx: 0.0290, n: 2, uv: .55 },
      { y: BY + 0.0230, cx: BX, cz: BZ, rx: 0.0258, n: 2, uv: .72 },
      { y: BY + 0.0370, cx: BX, cz: BZ, rx: 0.0188, n: 2, uv: .86 },
      { y: BY + 0.0455, cx: BX, cz: BZ, rx: 0.0102, n: 2, uv: .95, ao: .90 },
      { y: BY + 0.0475, cx: BX, cz: BZ, rx: 0.0058, n: 2, uv: 1, ao: .84 }
    ], 16, M.paint, { density: 18, seed: 731, wear: .55 });
    /* the raised mold band at the equator -- the M26 tell */
    addLoftY(nade, [
      { y: BY - 0.0022, cx: BX, cz: BZ, rx: 0.0294, n: 2, uv: 0, ao: .92 },
      { y: BY + 0.0052, cx: BX, cz: BZ, rx: 0.0295, n: 2, uv: 1, ao: .92 }
    ], 16, M.paintD, { density: 22, seed: 733, wear: .9 });

    /* --- fuze: neck collar, well, and the cap dome, machined steel --- */
    addLoftY(nade, [
      { y: BY + 0.0468, cx: BX, cz: BZ, rx: 0.0112, n: 2.4, uv: 0, ao: .88 },
      { y: BY + 0.0520, cx: BX, cz: BZ, rx: 0.0108, n: 2.4, uv: 1, ao: .92 }
    ], 12, M.steelD, { density: 26, seed: 737 });
    addLoftY(nade, [
      { y: BY + 0.0515, cx: BX, cz: BZ, rx: 0.0086, n: 2.2, uv: 0, ao: .95 },
      { y: BY + 0.0650, cx: BX, cz: BZ, rx: 0.0082, n: 2.2, uv: .8 },
      { y: BY + 0.0700, cx: BX, cz: BZ, rx: 0.0060, n: 2, uv: .92 },
      { y: BY + 0.0722, cx: BX, cz: BZ, rx: 0.00005, n: 2, uv: 1 }
    ], 12, M.steel, { density: 24, seed: 739, wear: .35 });

    /* --- safety lever: a 9mm-wide steel band from the cap top, over the
       shoulder, pressed down the flank by the thumb side of the fist.
       Cross-sections are thin rounded rectangles; the loft rides the body
       profile a couple of millimetres proud. --- */
    addLoftY(nade, [
      { y: BY + 0.0700, cx: BX + 0.0052, cz: BZ, rx: 0.0022, rz: 0.0044, n: 5, uv: 0, ao: .96 },
      { y: BY + 0.0712, cx: BX + 0.0128, cz: BZ, rx: 0.0026, rz: 0.0047, n: 5, uv: .10 },
      { y: BY + 0.0640, cx: BX + 0.0208, cz: BZ, rx: 0.0024, rz: 0.0047, n: 5, uv: .24 },
      { y: BY + 0.0480, cx: BX + 0.0272, cz: BZ, rx: 0.0020, rz: 0.0046, n: 5, uv: .42 },
      { y: BY + 0.0220, cx: BX + 0.0322, cz: BZ, rx: 0.0017, rz: 0.0045, n: 5, uv: .62 },
      { y: BY - 0.0060, cx: BX + 0.0330, cz: BZ, rx: 0.0016, rz: 0.0044, n: 5, uv: .82 },
      { y: BY - 0.0230, cx: BX + 0.0296, cz: BZ, rx: 0.0015, rz: 0.0040, n: 5, uv: 1, ao: .88 }
    ], 10, M.steel, { capStart: true, capEnd: true, density: 20, seed: 743, wear: .8 });
    /* the crimped attachment plate over the cap */
    addBox(nade, BX + 0.0028, BY + 0.0666, BZ, 0.0052, 0.0026, 0.0052, 0.0008, M.steelD,
      { ao: .92, density: 26, seed: 745, eseg: 1 });

    /* --- pull ring on the pin, hanging off the far side of the fuze:
       eight chords of 1.1mm wire stand in for the torus --- */
    var RC = [BX - 0.0165, BY + 0.0560, BZ + 0.0015], RR = 0.0078;
    for (i = 0; i < 8; i++) {
      var a0 = i / 8 * TAU, a1 = (i + 1) / 8 * TAU;
      /* ring plane: tilted ~20deg off vertical so it catches the key light */
      var p0 = [RC[0] - Math.sin(a0) * RR * 0.94, RC[1] + Math.cos(a0) * RR, RC[2] + Math.sin(a0) * RR * 0.34];
      var p1 = [RC[0] - Math.sin(a1) * RR * 0.94, RC[1] + Math.cos(a1) * RR, RC[2] + Math.sin(a1) * RR * 0.34];
      addBone(nade, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.0011, 0.0011, 6, M.steel,
        { rings: 1, density: 40, seed: 747 + i });
    }
    /* the pin itself, into the fuze well */
    addBone(nade, BX - 0.0058, BY + 0.0592, BZ, BX - 0.0160, BY + 0.0576, BZ + 0.0008,
      0.0013, 0.0011, 6, M.steelD, { rings: 1, capEnd: true, density: 40, seed: 757 });

    var nNade = makeNode(root, 'nade'), nTrig = makeNode(root, 'trigger');
    nTrig.position.set(0, -0.020, -0.014);
    var A = { root: root, nodes: { nade: nNade, trigger: nTrig }, meshes: [], bbox: null };
    push(A, nNade, nade, mat, 'nade');

    /* sight/zRear drive the raised "ready" pose the ads ramp pulls into;
       there is no glass here, just the fist coming up to the cheek */
    A.sight = [-0.105, 0.058, 0];
    A.zRear = -0.055; A.zFront = -0.095;
    A.muzzle = [0, 0.052, -0.060];
    A.eject = null;
    /* fist wrapped round the body, thumb pinning the lever; support hand
       parked far out of frame -- you do not two-hand a grenade */
    A.gripR = { p: [-0.010, 0.010, -0.024], r: [-0.20, -0.38, 0.06], s: 0.97, arm: [0.36, -0.10, 0.16] };
    A.gripL = { p: [-0.30, -0.92, 0.28], r: [0, 0, 0], s: 0.97, arm: [0.24, 0.10, -0.08] };
    A.triggerRest = 0; A.triggerPull = 0;
    return A;
  }

  var TUNE = {
    pistol: {
      build: buildPistol,
      hip: { p: [0.1592, -0.1478, -0.4801], r: [0.020, 0.115, 0.045] },
      adsEye: 0.460,
      sprint: { p: [0.1441, -0.2381, -0.4851], r: [0.240, 0.480, -0.520] },
      low: { p: [0.1215, -0.3285, -0.5071], r: [-0.400, 0.250, 0.190] },
      inspect: { p: [0.0123, -0.1515, -0.5201], r: [0.150, -0.560, 0.480] },
      recoil: { back: 0.0224, up: 0.0056, pitch: 0.130, yaw: 0.026, roll: 0.050, k: 720, z: 0.62 },
      lag: 0.78, bob: 0.80, mag: 15, reload: 1.62, shellDelay: 0.02, smoke: 0.50,
      flash: 0.028, tracer: 0.22
    },
    shotgun: {
      build: buildShotgun,
      hip: { p: [0.2066, -0.2085, -0.6389], r: [0.018, 0.150, 0.040] },
      adsEye: 0.520,
      sprint: { p: [0.1849, -0.3082, -0.6439], r: [0.230, 0.440, -0.480] },
      low: { p: [0.1502, -0.4121, -0.6519], r: [-0.300, 0.220, 0.170] },
      inspect: { p: [0.0463, -0.2172, -0.6989], r: [0.120, -0.480, 0.420] },
      recoil: { back: 0.0480, up: 0.0120, pitch: 0.240, yaw: 0.032, roll: 0.100, k: 300, z: 0.58 },
      lag: 1.10, bob: 1.00, mag: 6, reload: 2.45, shellDelay: 0.24, smoke: 1.0,
      flash: 0.038, tracer: 0
    },
    chaingun: {
      build: buildChaingun,
      hip: { p: [0.2081, -0.2049, -0.6277], r: [0.016, 0.140, 0.038] },
      adsEye: 0.520,
      sprint: { p: [0.1830, -0.2551, -0.6327], r: [0.220, 0.400, -0.440] },
      low: { p: [0.1496, -0.3597, -0.6397], r: [-0.300, 0.210, 0.160] },
      inspect: { p: [0.0533, -0.1756, -0.6877], r: [0.115, -0.450, 0.390] },
      recoil: { back: 0.0144, up: 0.0035, pitch: 0.058, yaw: 0.030, roll: 0.028, k: 950, z: 0.44 },
      lag: 1.30, bob: 1.12, mag: 100, reload: 3.00, shellDelay: 0.02, smoke: 0.40,
      flash: 0.024, tracer: 0.34
    },
    rpg: {
      build: buildRpg,
      hip: { p: [0.2346, -0.2309, -0.7075], r: [0.016, 0.145, 0.038] },
      adsEye: 0.540,
      sprint: { p: [0.2063, -0.3611, -0.7125], r: [0.220, 0.420, -0.460] },
      low: { p: [0.1667, -0.4969, -0.7555], r: [-0.290, 0.200, 0.150] },
      inspect: { p: [0.0365, -0.2479, -0.7825], r: [0.230, -0.400, 0.330] },
      recoil: { back: 0.0640, up: 0.0176, pitch: 0.300, yaw: 0.038, roll: 0.085, k: 220, z: 0.55 },
      lag: 1.38, bob: 1.08, mag: 1, reload: 0.94, shellDelay: 0, smoke: 1.40,
      flash: 0.046, tracer: 0
    },
    rifle: {
      build: buildRifle,
      /* solved: origin on the (0.685, 0.85) anchor, eye distance bisected to
         62% of frame height. The rifle sits further out than the shotgun
         (0.903 vs 0.639) purely because its AABB is the tallest on the rack
         -- magazine floorplate to elevation turret -- so an equal on-screen
         size needs more distance. Coverage lands at 22% x 62%, between the
         shotgun and the chaingun, left edge at x 0.58 -- clear of the
         crosshair. Every distance below was re-bisected when the optic went
         on: it added 59 mm to the AABB, which at the old distances put hip
         at 67% (verify's limit is 66) and left sprint and inspect a
         rounding error away from their own guards.
         The hip distance then came back IN by 2.5% when the suppressor was
         added: the can is 145 mm of extra barrel, and the far guard (0.94,
         the depth past which world geometry can draw over the weapon) is
         measured at the muzzle. Trading 2 points of height for 27 mm of
         depth is the right way round -- the height guard has four points
         spare and the far guard, with recoil, had thirteen millimetres.
         Re-tucked when the support arm went full-length: at the old height
         the BUTTSTOCK sat wholly on screen (pad top corner at 0.79, 0.87),
         which read as the rifle held at arm's length in front of the face.
         Solved against the verify guards (grid over dy/dz/yaw with the true
         pad corner, not the AABB): 7 cm down, 2 cm right, 2 cm away and
         0.03 of yaw, WITH the stock collapsed one notch in the build, puts
         the pad corner at (0.81, 0.95) -- riding the very corner of the
         frame, where a shouldered stock reads as shouldered. Fully off-frame
         is unreachable: the 66% height guard pins the eye distance, and the
         guard counts AABB corners that are already below the frame. h lands
         at 0.653 of the 0.655 budget, far at 0.913 of 0.94, muzzle x at
         0.53 of the 0.52 crosshair guard -- three guards near their walls,
         which is what 'solved' means on this rack. */
      hip: { p: [0.2901, -0.3574, -0.9004], r: [0.018, 0.165, 0.042] },
      adsEye: 0.545,
      sprint: { p: [0.2410, -0.4152, -0.9085], r: [0.260, 0.450, -0.520] },
      low: { p: [0.2377, -0.5189, -0.8430], r: [-0.310, 0.215, 0.165] },
      inspect: { p: [0.0515, -0.3063, -0.8876], r: [0.130, -0.470, 0.410] },
      /* light, ergonomic, gas-operated: a short sharp impulse on a stiff
         spring, well short of the shotgun's shove and well past the
         chaingun's buzz */
      recoil: { back: 0.0206, up: 0.0050, pitch: 0.112, yaw: 0.028, roll: 0.044, k: 880, z: 0.52 },
      lag: 0.96, bob: 0.92, mag: 30, reload: 2.40, shellDelay: 0.03, smoke: 0.45,
      flash: 0.026, tracer: 0.26
    },
    /* ---- fallen weapons. Poses follow the rack's grammar: origin near the
       (0.70, 0.85) anchor, eye distance scaled to each gun's AABB the same
       way the originals were -- the AK sits at shotgun-class distance (it
       is an 880mm gun with no glass), the M4 just inside the rifle (same
       receiver, 100mm less pipe, no can), the DMR outside everything
       because scope bell to magazine floorplate it is the tallest and
       longest thing the player will ever hold. */
    ak: {
      build: buildAk,
      hip: { p: [0.2180, -0.2280, -0.6750], r: [0.018, 0.140, 0.042] },
      adsEye: 0.500,
      sprint: { p: [0.1950, -0.3320, -0.6950], r: [0.240, 0.440, -0.490] },
      low: { p: [0.1700, -0.4300, -0.6750], r: [-0.300, 0.210, 0.160] },
      inspect: { p: [0.0480, -0.2360, -0.7150], r: [0.130, -0.480, 0.420] },
      /* 7.62x39 on a 3.1kg stamped gun: more shove than the M4 pattern,
         much less spring -- k sits low so the muzzle lopes instead of
         buzzing, which is the whole AK feel */
      recoil: { back: 0.0280, up: 0.0078, pitch: 0.152, yaw: 0.036, roll: 0.062, k: 590, z: 0.55 },
      lag: 1.04, bob: 0.96, mag: 30, reload: 2.45, shellDelay: 0.03, smoke: 0.60,
      flash: 0.032, tracer: 0.26
    },
    m4: {
      build: buildM4,
      hip: { p: [0.2540, -0.2700, -0.8150], r: [0.018, 0.135, 0.040] },
      adsEye: 0.530,
      sprint: { p: [0.2260, -0.3880, -0.8400], r: [0.260, 0.450, -0.520] },
      low: { p: [0.2230, -0.4850, -0.7800], r: [-0.310, 0.215, 0.165] },
      inspect: { p: [0.0500, -0.2870, -0.8300], r: [0.130, -0.470, 0.410] },
      /* the softest rifle on the rack: carbine gas on 5.56 behind a dot.
         Slightly quicker spring than the AR-15 because there is no can and
         no glass adding mass out front. */
      recoil: { back: 0.0192, up: 0.0046, pitch: 0.104, yaw: 0.027, roll: 0.042, k: 920, z: 0.52 },
      lag: 0.90, bob: 0.90, mag: 30, reload: 2.30, shellDelay: 0.03, smoke: 0.42,
      flash: 0.024, tracer: 0.30
    },
    dmr: {
      build: buildDmr,
      hip: { p: [0.2760, -0.2960, -0.9300], r: [0.018, 0.130, 0.044] },
      adsEye: 0.560,
      sprint: { p: [0.2460, -0.4280, -0.9550], r: [0.260, 0.450, -0.520] },
      low: { p: [0.2420, -0.5320, -0.8850], r: [-0.310, 0.215, 0.165] },
      inspect: { p: [0.0520, -0.3160, -0.9300], r: [0.130, -0.470, 0.410] },
      /* one full-power round off the shoulder: the biggest single impulse
         after the RPG, on the slowest spring -- the gun rolls up and comes
         back down while the bolt is being worked, so the recovery and the
         cycle read as one motion */
      recoil: { back: 0.0520, up: 0.0142, pitch: 0.262, yaw: 0.030, roll: 0.092, k: 275, z: 0.56 },
      lag: 1.14, bob: 1.00, mag: 10, reload: 2.90, shellDelay: 0.55, smoke: 0.75,
      flash: 0.040, tracer: 0
    },
    nullstar: {
      build: buildNullstar,
      /* A long, side-heavy projector: held farther out than the RPG so the
         open vanes and capacitor remain below/right of the crosshair. */
      hip: { p: [0.2720, -0.2860, -0.8550], r: [0.018, 0.155, 0.042] },
      adsEye: 0.770,
      sprint: { p: [0.2380, -0.4220, -0.9100], r: [0.270, 0.470, -0.540] },
      low: { p: [0.2280, -0.5220, -0.8400], r: [-0.320, 0.220, 0.170] },
      inspect: { p: [0.0860, -0.3020, -0.9000], r: [0.155, -0.510, 0.450] },
      /* The field collapses toward the shoulder rather than kicking like a
         cartridge. Slow, deep rotation makes one shot feel consequential. */
      recoil: { back: 0.0680, up: 0.0170, pitch: 0.325, yaw: 0.040, roll: 0.118, k: 235, z: 0.57 },
      lag: 1.34, bob: 1.06, mag: 1, reload: 1.48, shellDelay: 9, smoke: 0.18,
      flash: 0.072, tracer: 0
    },
    grenade: {
      build: buildGrenade,
      /* the smallest thing on the rack sits the closest: 99mm of grenade at
         rifle distance is a dot, at 0.43m it fills the pistol's screen share.
         Yaw cant shows the spoon and the ring -- the parts that say LIVE. */
      hip: { p: [0.1900, -0.1690, -0.4320], r: [0.030, 0.140, 0.060] },
      adsEye: 0.375,
      sprint: { p: [0.1520, -0.2600, -0.4550], r: [0.260, 0.460, -0.500] },
      low: { p: [0.1220, -0.3300, -0.4700], r: [-0.400, 0.250, 0.190] },
      inspect: { p: [0.0125, -0.1600, -0.4800], r: [0.150, -0.560, 0.480] },
      /* the "recoil" is the arm snapping through the release: one big loose
         impulse on a slow spring, all pitch and roll, no bore to push back */
      recoil: { back: 0.0310, up: 0.0125, pitch: 0.245, yaw: 0.052, roll: 0.105, k: 295, z: 0.62 },
      /* mag 999: there is no magazine and nothing to reload -- the count
         gate in the tick can never fire. flash/smoke/tracer 0: a throw is
         not a discharge. shellDelay 9 is never reached with eject null. */
      lag: 0.80, bob: 0.92, mag: 999, reload: 0.01, shellDelay: 9, smoke: 0,
      flash: 0, tracer: 0
    }
  };
  /* Every translational animation amplitude below is authored in metres at the
     weapon, so doubling the eye distance would have halved all of them on
     screen. MOTION scales them back up; angles are distance-invariant and are
     deliberately NOT in here. */
  var MOTION = 1.90;
  /* index-parallel to the game's WPN table. 'grenade' holds slot 5 so the
     three fallen weapons behind it land on their own BAL keys instead of
     inheriting the pistol's cone through the || fallback. */
  var WKEYS = ['pistol', 'shotgun', 'chaingun', 'rpg', 'rifle', 'grenade', 'ak', 'm4', 'dmr', 'nullstar'];

  /* =========================================================================
     8. BALLISTICS  --  Counter-Strike's actual model
     ------------------------------------------------------------------------
     Three things, and they are separate on purpose:

     AIM PUNCH   a deterministic per-weapon spray table. Each shot advances a
                 recoil index; the aim punch is the CUMULATIVE sum of the
                 table up to that index, so the pattern is learnable and,
                 crucially, recovery is the same walk in reverse -- the view
                 slides back DOWN the pattern instead of snapping. It rotates
                 the view, so the crosshair and the bullet always agree.
     VIEW PUNCH  the game's own cosmetic `player.kick` channel. Purely
                 visual, never touches the bullet. Left alone deliberately.
     INACCURACY  a cone that is near-zero standing still (first shot is
                 dead accurate), grows quadratically with movement, spikes in
                 the air, decays after landing, and adds a per-shot term
                 while the spray index is up.

     Every table's horizontal column sums to zero, which is what makes a
     pattern feel like a pattern rather than a drift: hold the trigger and
     the spray returns to the vertical axis instead of walking off screen.
     ====================================================================== */
  var BAL = {
    pistol: {
      /* semi-auto: a tight vertical ladder with an alternating side kick */
      pattern: [
        [1.90, 0.00], [1.75, 0.30], [1.60, -0.35], [1.50, 0.40], [1.40, -0.45], [1.30, 0.42],
        [1.20, -0.40], [1.10, 0.30], [1.00, -0.28], [0.95, 0.22], [0.90, -0.20], [0.85, 0.04]
      ],
      tailFrom: 6, scale: 0.85, jitter: 0.09, hold: 0.230, tau: 0.085,
      inacc: { stand: 0.0016, move: 0.0220, jump: 0.0520, land: 0.0100, fire: 0.0022, fireCap: 6, ads: 0.45, crouch: 0.80 }
    },
    shotgun: {
      pattern: [
        [4.20, 0.00], [4.00, 0.55], [3.80, -0.60], [3.60, 0.58], [3.40, -0.55], [3.20, 0.50], [3.00, -0.48]
      ],
      tailFrom: 3, scale: 1.30, jitter: 0.12, hold: 0.320, tau: 0.130,
      inacc: { stand: 0.0380, move: 0.0180, jump: 0.0400, land: 0.0090, fire: 0.0040, fireCap: 3, ads: 0.66, crouch: 0.86 }
    },
    chaingun: {
      /* the recognisable T: up hard for six, out right, sweep left, sweep
         right, settle. 13.3 degrees of climb over thirty rounds. */
      pattern: [
        [2.20, 0.00], [2.00, 0.10], [1.80, -0.05], [1.50, 0.15], [1.20, 0.35], [0.95, 0.55],
        [0.75, 0.70], [0.55, 0.75], [0.40, 0.60], [0.30, 0.30], [0.25, -0.25], [0.20, -0.70],
        [0.18, -0.95], [0.15, -1.05], [0.12, -0.95], [0.10, -0.70], [0.10, -0.35], [0.08, 0.10],
        [0.08, 0.50], [0.06, 0.80], [0.06, 0.85], [0.05, 0.70], [0.05, 0.40], [0.04, 0.05],
        [0.04, -0.30], [0.03, -0.55], [0.03, -0.60], [0.03, -0.45], [0.02, -0.20], [0.02, 0.20]
      ],
      tailFrom: 18, scale: 1.0, jitter: 0.10, hold: 0.130, tau: 0.115,
      inacc: { stand: 0.0035, move: 0.0300, jump: 0.0660, land: 0.0120, fire: 0.0016, fireCap: 12, ads: 0.48, crouch: 0.80 }
    },
    rpg: {
      pattern: [[5.50, 0.00]],
      tailFrom: 0, scale: 1.50, jitter: 0.05, hold: 0.200, tau: 0.200,
      inacc: { stand: 0.0, move: 0.0, jump: 0.0, land: 0.0, fire: 0.0, fireCap: 1, ads: 1, crouch: 1 }
    },
    rifle: {
      /* the M4 shape: nine hard up the ladder, a pull left, a sweep right,
         then a low oscillation that never leaves the axis. 14.6 degrees of
         climb over thirty rounds -- learnable, and controllable at range if
         you pull down through the first nine. */
      pattern: [
        [2.30, 0.00], [2.05, 0.06], [1.80, -0.10], [1.55, 0.14], [1.30, 0.30], [1.05, 0.46],
        [0.85, 0.52], [0.66, 0.40], [0.50, 0.10], [0.38, -0.34], [0.30, -0.72], [0.24, -0.92],
        [0.20, -0.95], [0.17, -0.78], [0.15, -0.44], [0.13, -0.05], [0.12, 0.36], [0.11, 0.68],
        [0.10, 0.84], [0.09, 0.80], [0.08, 0.58], [0.07, 0.26], [0.06, -0.08], [0.06, -0.38],
        [0.05, -0.56], [0.05, -0.58], [0.04, -0.44], [0.04, -0.20], [0.03, 0.30], [0.03, 0.54]
      ],
      tailFrom: 18, scale: 1.0, jitter: 0.09, hold: 0.150, tau: 0.100,
      inacc: { stand: 0.0022, move: 0.0260, jump: 0.0580, land: 0.0110, fire: 0.0019, fireCap: 10, ads: 0.36, crouch: 0.78 }
    },
    ak: {
      /* the AK shape: seven hard and nearly straight up, then a wide lazy
         S that never fully settles -- 7.62x39 keeps shoving to the last
         round, so the tail oscillation is twice the M4's amplitude and the
         settled cone stays honest-loose. Climbs ~17 degrees over thirty. */
      pattern: [
        [2.75, 0.00], [2.50, 0.12], [2.20, -0.15], [1.90, 0.22], [1.60, 0.42], [1.30, 0.58],
        [1.05, 0.66], [0.85, 0.48], [0.68, 0.10], [0.55, -0.42], [0.46, -0.85], [0.40, -1.10],
        [0.35, -1.15], [0.31, -0.92], [0.28, -0.52], [0.26, -0.05], [0.24, 0.45], [0.22, 0.85],
        [0.20, 1.05], [0.18, 1.00], [0.17, 0.72], [0.16, 0.30], [0.15, -0.15], [0.14, -0.55],
        [0.13, -0.80], [0.12, -0.82], [0.11, -0.62], [0.10, -0.28], [0.10, 0.35], [0.09, 0.65]
      ],
      tailFrom: 16, scale: 1.12, jitter: 0.11, hold: 0.155, tau: 0.105,
      inacc: { stand: 0.0028, move: 0.0300, jump: 0.0620, land: 0.0115, fire: 0.0026, fireCap: 9, ads: 0.42, crouch: 0.78 }
    },
    m4: {
      /* the enforcer's carbine: the M4 ladder with a shorter first leg than
         the AR-15's -- carbine gas starts pushing sooner and softer -- and
         a low, tight tail. The easiest spray on the rack to hold. */
      pattern: [
        [2.10, 0.00], [1.90, 0.05], [1.65, -0.08], [1.40, 0.12], [1.18, 0.26], [0.95, 0.40],
        [0.76, 0.46], [0.60, 0.34], [0.46, 0.06], [0.36, -0.30], [0.28, -0.62], [0.23, -0.80],
        [0.19, -0.82], [0.16, -0.66], [0.14, -0.38], [0.12, -0.04], [0.11, 0.30], [0.10, 0.56],
        [0.09, 0.70], [0.08, 0.66], [0.07, 0.48], [0.07, 0.22], [0.06, -0.06], [0.06, -0.30],
        [0.05, -0.46], [0.05, -0.48], [0.04, -0.36], [0.04, -0.16], [0.03, 0.24], [0.03, 0.44]
      ],
      tailFrom: 18, scale: 0.94, jitter: 0.09, hold: 0.145, tau: 0.098,
      inacc: { stand: 0.0022, move: 0.0255, jump: 0.0560, land: 0.0105, fire: 0.0017, fireCap: 10, ads: 0.38, crouch: 0.78 }
    },
    dmr: {
      /* one round, all of it vertical, and the recovery IS the bolt time:
         tau 0.34 walks the punch back down over about a second, so the
         glass settles right as the gun comes back into battery. Standing
         cone near zero -- the first shot is the weapon. */
      pattern: [[6.20, 0.00], [5.60, 0.35]],
      tailFrom: 0, scale: 1.25, jitter: 0.06, hold: 0.280, tau: 0.340,
      inacc: { stand: 0.0011, move: 0.0340, jump: 0.0720, land: 0.0140, fire: 0.0042, fireCap: 2, ads: 0.16, crouch: 0.74 }
    },
    nullstar: {
      /* A single collapse impulse: nearly vertical and intentionally slow to
         recover. The projectile remains accurate from a planted stance but
         a heavy projector fired on the run develops a meaningful cone. */
      pattern: [[5.40, 0.00]],
      tailFrom: 0, scale: 1.28, jitter: 0.045, hold: 0.310, tau: 0.260,
      inacc: { stand: 0.0014, move: 0.0280, jump: 0.0680, land: 0.0130, fire: 0.0038, fireCap: 1, ads: 0.24, crouch: 0.76 }
    }
  };

  /* prefix sums, computed once. cum[i] is the total punch after i shots. */
  function prepPatterns() {
    for (var k in BAL) {
      var b = BAL[k], p = b.pattern, up = 0, ri = 0;
      b.cum = [[0, 0]];
      for (var i = 0; i < p.length; i++) {
        up += p[i][0]; ri += p[i][1];
        b.cum.push([up, ri]);
      }
      b.sumUp = up; b.sumRight = ri; b.len = p.length;
    }
  }
  prepPatterns();

  /* Sample the cumulative pattern at a fractional index. Past the end of the
     table the index ping-pongs over the tail, so a hundred-round belt keeps
     oscillating around the settled point instead of climbing forever or
     snapping back to the start. Continuous at the seam by construction. */
  function patternAt(b, idx, out, seed) {
    var L = b.len, i = idx;
    if (i <= 0) { out[0] = 0; out[1] = 0; return out; }
    if (i > L) {
      var tail = Math.max(1, L - b.tailFrom);
      var period = 2 * tail;
      var q = (i - L) % period;
      var w = q <= tail ? q : period - q;
      i = L - w;
    }
    var i0 = Math.floor(i), i1 = Math.min(L, i0 + 1), f = i - i0;
    var a = b.cum[i0], c = b.cum[i1];
    var up = a[0] + (c[0] - a[0]) * f;
    var ri = a[1] + (c[1] - a[1]) * f;
    /* a small smooth-in-index random component: recognisable pattern, never
       two identical sprays, and no discontinuity while the index recovers */
    if (b.jitter) {
      var j = b.jitter;
      up += (fbm1(seed * 0.37 + i * 0.73, 2) - 0.5) * j * 2.0;
      ri += (fbm1(seed * 0.91 + i * 0.61 + 40, 2) - 0.5) * j * 3.0;
    }
    out[0] = up * b.scale; out[1] = ri * b.scale;
    return out;
  }

  /* Ballistics runtime state + the game values we borrow and must give back */
  var bal = { idx: 0, since: 99, seed: 0, land: 0, punchUp: 0, punchRight: 0, active: true, applied: false };
  var SPREAD0 = null, RECOIL_ON = true;
  var _pt = [0, 0];

  function captureGameTuning() {
    if (SPREAD0 || !G.WPN) return;
    SPREAD0 = [];
    for (var i = 0; i < G.WPN.length; i++) {
      var w = G.WPN[i];
      SPREAD0.push({ spread: fin(w.spread, 0), adsSpread: fin(w.adsSpread, 0) });
    }
  }
  function restoreGameTuning() {
    if (SPREAD0 && G.WPN) {
      for (var i = 0; i < G.WPN.length && i < SPREAD0.length; i++) {
        G.WPN[i].spread = SPREAD0[i].spread;
        G.WPN[i].adsSpread = SPREAD0[i].adsSpread;
      }
    }
    if (G.player && bal.applied) {
      G.player.recoilPitch = 0; G.player.recoilYaw = 0;
      G.player.recoilPitchV = 0; G.player.recoilYawV = 0;
    }
    bal.applied = false;
  }

  function ballisticsShot() {
    if (bal.idx <= 0.001) bal.seed = Math.random() * 997;
    bal.idx += 1;
    bal.since = 0;
  }

  /* Advance the recoil index and hand the punch back to the game.
     The game integrates its own recoil spring once per frame BEFORE it sets
     camera.rotation and BEFORE it fires, so writing the punch here lands on
     the next frame's aim -- which is exactly right: shot N leaves along the
     punch accumulated by shots 1..N-1, so the first shot of a spray is dead
     on the crosshair. The tiny O(dt^2) bite the game's spring takes out of
     our value before it reads it is compensated below. */
  function ballisticsStep(dt, P, key, ads, crouch, onGround, moveBlend, sprint) {
    var b = BAL[key];
    if (!b) return;
    bal.since += dt;
    if (bal.idx > 0 && bal.since > b.hold) {
      bal.idx *= Math.exp(-dt / Math.max(0.01, b.tau));
      if (bal.idx < 0.004) bal.idx = 0;
    }
    patternAt(b, bal.idx, _pt, bal.seed);
    bal.punchUp = _pt[0]; bal.punchRight = _pt[1];
    bal.land = Math.max(0, bal.land - dt / 0.38);

    if (!RECOIL_ON || !P || typeof P.recoilPitch !== 'number') return;
    var pitchRad = bal.punchUp * D2R;
    /* three.js YXZ with -Z forward: +rotation.y turns LEFT, so a rightward
       pattern step is a negative yaw */
    var yawRad = -bal.punchRight * D2R;
    var cp = clamp(1 - 72 * dt * dt, 0.55, 1);
    var cy = clamp(1 - 88 * dt * dt, 0.55, 1);
    P.recoilPitch = clamp(pitchRad / cp, -0.9, 0.9);
    P.recoilYaw = clamp(yawRad / cy, -0.9, 0.9);
    P.recoilPitchV = 0; P.recoilYawV = 0;
    bal.applied = true;

    /* ---- inaccuracy ---------------------------------------------------- */
    if (!G.WPN || !SPREAD0) return;
    var mv = clamp(moveBlend * (1 + sprint * 0.45), 0, 1.25);
    var mvT = mv * mv;
    /* the game adds its own movement and jump terms on top of whatever we
       write, so divide them back out and land exactly on the target cone */
    var gameMul = 1 + (moveBlend * 0.22 + sprint * 0.42);
    var gameJump = onGround ? 0 : 0.012;
    for (var i = 0; i < G.WPN.length; i++) {
      var kk = WKEYS[i] || 'pistol';
      var q = (BAL[kk] || BAL.pistol).inacc;
      var cone = q.stand + q.move * mvT + (onGround ? 0 : q.jump) + q.land * bal.land;
      if (kk === key) cone += q.fire * Math.min(bal.idx, q.fireCap);
      cone *= lerp(1, q.ads, ads);
      if (crouch) cone *= q.crouch;
      var v = clamp((cone - gameJump) / gameMul, 0, 0.25);
      G.WPN[i].spread = v;
      G.WPN[i].adsSpread = v;
    }
  }

  /* =========================================================================
     9. SCENE, MATERIALS, EFFECTS
     ====================================================================== */
  var vmScene = null, vmCam = null, vmRoot = null, vmSway = null, vmPose = null, vmRecoil = null;
  var baseMat = null, flashMat = null, smokeMat = null, coreMat = null, tracerMat = null;
  var keyLight = null, fillLight = null, rimLight = null, flashLight = null, ambLight = null;
  var flashGroup = null, flashQuad = null, flashCore = null, flashCone = null;
  var smokeMesh = null, smokePos = null, smokeUv = null, smokeCol = null, smokeIdx = null;
  var shellMesh = null, shellDummy = null;
  var handR = null, handL = null, fingerR = null, fingerL = null, handRNode = null, handLNode = null;
  var armR = null, armL = null;
  var built = false, aspect = 16 / 9, shadowsOn = true;
  var tracerGroup = null, tracers = [];

  var SMOKE_MAX = 16, SHELL_MAX = 12, TRACER_MAX = 6;
  var smoke = [], shells = [];

  /* preallocated temporaries: a Vector3 inside the update loop is a GC hitch
     on a 4ms budget, and this runs every frame forever */
  var _v = null, _v2 = null, _m = null;

  /* nz-render patches THREE.Material.prototype.onBeforeCompile globally, so a
     material that declares nothing inherits its AO/SSR/PCSS injection even in
     a scene nz-render has never traversed. An OWN property shadows the
     prototype; an own customProgramCacheKey pins the program identity so a
     tier change on nz-render's side cannot force a viewmodel recompile mid
     firefight. Both are plain data, so this stays correct if nz-render is
     absent, torn down, or replaced. Idempotent. */
  var VM_PROGRAM_KEY = 'nz-vm-1';
  function vmCacheKey() { return VM_PROGRAM_KEY + '|' + (this.name || ''); }
  function vmNoPatch() { }
  function detachFromScenePatch(m) {
    if (!m) return m;
    try {
      m.onBeforeCompile = vmNoPatch;
      m.customProgramCacheKey = vmCacheKey;
    } catch (e) { /* frozen material: leave it, the patch is inert anyway */ }
    return m;
  }

  function buildScene() {
    vmScene = new THREE.Scene();
    vmScene.name = 'nz-viewmodel';
    /* MATCH the world camera near/far exactly. The post stack linearises the
       shared depth texture with the world camera's planes, so a different
       near here would make our depth read wrong to SSAO and motion blur. */
    var wc = NZ.ctx.camera;
    vmCam = new THREE.PerspectiveCamera(VM_FOV, aspect, wc ? wc.near : 0.08, wc ? wc.far : 900);
    vmCam.position.set(0, 0, 0);
    vmCam.rotation.set(0, 0, 0);

    vmRoot = new THREE.Group(); vmRoot.name = 'vm-root'; vmRoot.scale.setScalar(VM_SCALE); vmScene.add(vmRoot);
    vmSway = new THREE.Group(); vmSway.name = 'vm-sway'; vmRoot.add(vmSway);
    vmPose = new THREE.Group(); vmPose.name = 'vm-pose'; vmSway.add(vmPose);
    vmRecoil = new THREE.Group(); vmRecoil.name = 'vm-recoil'; vmPose.add(vmRecoil);
    vmRoot.rotation.order = 'YXZ';
    vmSway.rotation.order = 'YXZ';
    vmPose.rotation.order = 'YXZ';
    vmRecoil.rotation.order = 'YXZ';

    /* Lighting. The key follows the world sun in view space so the weapon
       does not look pasted on when you turn away from it; the fill and rim
       are constant so the silhouette always reads, even in a dark room.

       The rig this replaced summed to 1.85 warm key + 0.50 + 0.95 of SATURATED
       BLUE directional (0x9dc0ff / 0xbcd6ff) + 0.36 of blue hemisphere. Three
       directional sources each put their own specular lobe on a metal, two of
       them blue, and ACES skews a bright blue specular toward magenta -- which
       is exactly the lilac cast the weapon had in play. The world, by contrast,
       runs ONE key at nz-render's P.keyIntensity with ambient at 0.035 and the
       rim at 0.09: the viewmodel was carrying twenty times the world's fill.

       One key, and everything else is a whisper. Colours are pulled most of
       the way to neutral -- a fill may be COOLER than the key, it may not be
       BLUE. Total non-key direct light: 1.81 -> 0.40. */
    ambLight = new THREE.HemisphereLight(0x8f9cae, 0x241d16, 0.10);
    vmScene.add(ambLight);
    keyLight = new THREE.DirectionalLight(0xffe0b6, 1.55);
    keyLight.position.set(-0.55, 0.85, 0.45);
    vmScene.add(keyLight); vmScene.add(keyLight.target);
    fillLight = new THREE.DirectionalLight(0xa6b2c2, 0.14);
    fillLight.position.set(0.75, -0.15, 0.62);
    vmScene.add(fillLight);
    /* a rim on a metal is a white edge; at 0.95 it was drawing the chrome
       outline that made every gun read as a chromed prop */
    rimLight = new THREE.DirectionalLight(0xb0bccc, 0.26);
    rimLight.position.set(0.35, 0.42, -1.0);
    vmScene.add(rimLight);
    flashLight = new THREE.PointLight(0xffc27a, 0, 2.6, 2.0);
    flashLight.position.set(0, 0, -0.4);
    vmScene.add(flashLight);

    if (shadowsOn) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(512, 512);
      var sc = keyLight.shadow.camera;
      sc.left = -0.90; sc.right = 0.90; sc.top = 0.90; sc.bottom = -0.90;
      sc.near = 0.02; sc.far = 4.2;
      sc.updateProjectionMatrix();
      keyLight.shadow.bias = -0.0008;
      keyLight.shadow.normalBias = 0.008;
      keyLight.shadow.radius = 2;
    }

    baseMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: ATLAS.map,
      normalMap: ATLAS.normalMap,
      roughnessMap: ATLAS.orm,
      metalnessMap: ATLAS.orm,
      emissiveMap: ATLAS.emissiveMap,
      emissive: new THREE.Color(1, 1, 1),
      emissiveIntensity: 0.80,
      roughness: 1.0, metalness: 1.0,
      vertexColors: true, dithering: true, fog: false,
      /* DoubleSide is deliberate. A hand-built model with ~50 lathes will
         always have one tube end somebody forgot to cap, and a see-through
         hole in the weapon is the single worst artefact available. Backfaces
         are early-Z rejected almost everywhere. */
      side: THREE.DoubleSide,
      shadowSide: THREE.BackSide
    });
    baseMat.normalScale.set(0.85, 0.85);
    /* nz-render normalises the probe to P.envIrradiance (0.205) MEAN radiance,
       but the sky lobe of that probe is several times the mean, and a metal
       returns the specular lobe undivided. At 1.15 the weapon was a mirror of
       the sky -- bright, blue, and wrong. The world's own surfaces run this at
       1.0 and are dielectric; a viewmodel that is mostly metal needs less. */
    baseMat.envMapIntensity = 0.40;
    baseMat.name = 'nz-vm-base';
    /* Opt every viewmodel material OUT of nz-render's global material patch.
       nz-render installs Material.prototype.onBeforeCompile, so it reaches
       anything without its own hook -- including ours, in a scene it has never
       seen. It does zero its AO/SSR uniforms before firing scenePass, so the
       injected lighting is inert today, but it ALSO swaps in a PCSS getShadow
       parameterised in world units (uShadowP is sized from the sun's 300-metre
       shadow frustum) and applies it to our 0.02..4.2 viewmodel shadow camera.
       An own-property hook shadows the prototype; an own cache key keeps our
       programs off nz-render's patchKey, so a quality-tier change no longer
       recompiles the viewmodel. nz-render's wrapForeignMaterials() only
       traverses NZ.ctx.scene, and vmScene is not it, so nothing rewraps us. */
    detachFromScenePatch(baseMat);

    var ft = flashTexture();
    flashMat = new THREE.MeshBasicMaterial({
      map: ft, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false, toneMapped: true
    });
    coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff0d0, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false, toneMapped: true
    });
    smokeMat = new THREE.MeshBasicMaterial({
      map: smokeTexture(), color: 0xffffff, transparent: true, opacity: 1,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false,
      vertexColors: true
    });
    detachFromScenePatch(flashMat);
    detachFromScenePatch(coreMat);
    detachFromScenePatch(smokeMat);

    buildFlash();
    buildSmoke();
    buildShells();
  }

  function buildFlash() {
    flashGroup = new THREE.Group();
    flashGroup.name = 'vm-flash';
    flashGroup.visible = false;
    /* the vm camera never rotates relative to this scene, so a screen-facing
       card is simply an XY quad -- no billboard maths per frame */
    var q = new THREE.PlaneGeometry(1, 1);
    flashQuad = new THREE.Mesh(q, flashMat);
    flashQuad.frustumCulled = false;
    flashGroup.add(flashQuad);
    /* a short cone down the bore gives the flash a direction in 3D, which is
       what a flat card alone can never do */
    var cone = new THREE.ConeGeometry(0.30, 1.0, 10, 1, true);
    cone.rotateX(-PI / 2);
    cone.translate(0, 0, -0.5);
    flashCone = new THREE.Mesh(cone, flashMat);
    flashCone.frustumCulled = false;
    flashGroup.add(flashCone);
    flashCore = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), coreMat);
    flashCore.frustumCulled = false;
    flashGroup.add(flashCore);
    vmScene.add(flashGroup);
  }

  /* One quad batch for every smoke wisp: one draw call, positions rewritten
     on the CPU only while wisps are alive. */
  function buildSmoke() {
    var g = new THREE.BufferGeometry();
    smokePos = new Float32Array(SMOKE_MAX * 4 * 3);
    smokeUv = new Float32Array(SMOKE_MAX * 4 * 2);
    /* itemSize 4: three.js only enables USE_COLOR_ALPHA for a 4-component
       colour attribute. With three components the fade would darken the
       wisps to black instead of dissolving them. */
    smokeCol = new Float32Array(SMOKE_MAX * 4 * 4);
    smokeIdx = new Uint16Array(SMOKE_MAX * 6);
    for (var i = 0; i < SMOKE_MAX; i++) {
      var o = i * 4;
      smokeUv[o * 2 + 0] = 0; smokeUv[o * 2 + 1] = 0;
      smokeUv[o * 2 + 2] = 1; smokeUv[o * 2 + 3] = 0;
      smokeUv[o * 2 + 4] = 1; smokeUv[o * 2 + 5] = 1;
      smokeUv[o * 2 + 6] = 0; smokeUv[o * 2 + 7] = 1;
      smokeIdx[i * 6 + 0] = o; smokeIdx[i * 6 + 1] = o + 1; smokeIdx[i * 6 + 2] = o + 2;
      smokeIdx[i * 6 + 3] = o; smokeIdx[i * 6 + 4] = o + 2; smokeIdx[i * 6 + 5] = o + 3;
    }
    g.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(smokeUv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(smokeCol, 4));
    g.setIndex(new THREE.BufferAttribute(smokeIdx, 1));
    g.setDrawRange(0, 0);
    smokeMesh = new THREE.Mesh(g, smokeMat);
    smokeMesh.frustumCulled = false;
    smokeMesh.renderOrder = 6;
    vmScene.add(smokeMesh);
  }

  function buildShells() {
    var p = new Pile();
    /* a 9mm case: rim, extractor groove, body, mouth */
    addLatheZ(p, [
      { z: 0.0095, rx: 0.0049, n: 2, uv: 0 },
      { z: 0.0080, rx: 0.0052, n: 2, uv: .08, wear: 1 },
      { z: 0.0062, rx: 0.0043, n: 2, uv: .16 },
      { z: 0.0044, rx: 0.0049, n: 2, uv: .24 },
      { z: -0.0080, rx: 0.0048, n: 2, uv: .92 },
      { z: -0.0095, rx: 0.0047, n: 2, uv: 1, wear: 1 }
    ], 10, M.brass, { capStart: true, density: 40, seed: 3 });
    /* the mouth is a shallow dark cup, not a hole through the case */
    addLatheZ(p, [
      { z: -0.0095, rx: 0.0042, n: 2, uv: 0 },
      { z: -0.0070, rx: 0.0040, n: 2, uv: .6 },
      { z: -0.0066, rx: 0.0001, n: 2, uv: 1 }
    ], 8, material(REG.brass, [.150, .110, .048], 0, null, null, 50),
      { ao: .4, density: 50, seed: 5 });
    var geo = pileToGeometry(p);
    shellMesh = new THREE.InstancedMesh(geo, baseMat, SHELL_MAX);
    shellMesh.frustumCulled = false;
    shellMesh.castShadow = false;
    shellMesh.count = 0;
    shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    vmScene.add(shellMesh);
    shellDummy = new THREE.Object3D();
    for (var i = 0; i < SHELL_MAX; i++) {
      shells.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, ax: 0, ay: 0, az: 0, t: 0, life: 0, s: 1, bounced: 0 });
    }
  }

  /* -------------------------------------------------------------- tracers --
     World-space, because a tracer that stops at the muzzle is worse than no
     tracer at all. Rare (roughly one round in four), thin, additive, and
     stopped at the first solid cell so it never streaks through a wall.
     Lives in the game's own scene; torn down with the module. */
  function buildTracers() {
    if (!NZ.ctx.scene) return;
    tracerGroup = new THREE.Group();
    tracerGroup.name = 'nz-tracers';
    tracerGroup.frustumCulled = false;
    tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false, toneMapped: true
    });
    var g = new THREE.PlaneGeometry(1, 1);
    g.translate(0, 0.5, 0);
    for (var i = 0; i < TRACER_MAX; i++) {
      var m1 = new THREE.Mesh(g, tracerMat);
      var m2 = new THREE.Mesh(g, tracerMat);
      m2.rotation.y = PI / 2;
      var grp = new THREE.Group();
      grp.add(m1); grp.add(m2);
      grp.visible = false;
      grp.frustumCulled = false;
      tracerGroup.add(grp);
      tracers.push({ node: grp, live: false, t: 0, life: 0, dist: 0, travel: 0, max: 0, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1 });
    }
    NZ.ctx.scene.add(tracerGroup);
  }

  function spawnTracer() {
    var wc = NZ.ctx.camera, P = G.player;
    if (!tracerGroup || !wc || !P) return;
    var slot = null;
    for (var i = 0; i < tracers.length; i++) if (!tracers[i].live) { slot = tracers[i]; break; }
    if (!slot) return;
    wc.updateMatrixWorld();
    var e = wc.matrixWorld.elements;
    /* camera basis: right = col0, up = col1, forward = -col2 */
    var rx = e[0], ry = e[1], rz = e[2];
    var ux = e[4], uy = e[5], uz = e[6];
    var fx = -e[8], fy = -e[9], fz = -e[10];
    var ox = e[12] + fx * 0.75 + rx * 0.22 + ux * -0.16;
    var oy = e[13] + fy * 0.75 + ry * 0.22 + uy * -0.16;
    var oz = e[14] + fz * 0.75 + rz * 0.22 + uz * -0.16;
    /* The muzzle is beside the lens only in first person. A view module that
       has moved the camera off the eye says where the round really leaves
       from, and which way: { x, y, z, dx, dy, dz }, world space, unit dir. */
    var ext = NZ.first('tracerFrom');
    if (ext && isFinite(ext.x + ext.y + ext.z + ext.dx + ext.dy + ext.dz)) {
      ox = ext.x; oy = ext.y; oz = ext.z; fx = ext.dx; fy = ext.dy; fz = ext.dz;
    }
    var maxD = 90;
    if (G.castWall) {
      try {
        var d = G.castWall({ x: ox, y: oy, z: oz }, { x: fx, y: fy, z: fz }, 90);
        if (isFinite(d) && d > 0.5) maxD = d;
      } catch (err) { G.castWall = null; }
    }
    slot.live = true; slot.t = 0; slot.life = 0.26;
    slot.ox = ox; slot.oy = oy; slot.oz = oz;
    slot.dx = fx; slot.dy = fy; slot.dz = fz;
    slot.max = maxD; slot.travel = 0; slot.dist = 0;
    slot.node.visible = true;
  }

  function updateTracers(dt) {
    if (!tracerGroup) return;
    var any = false;
    for (var i = 0; i < tracers.length; i++) {
      var t = tracers[i];
      if (!t.live) continue;
      t.t += dt;
      /* ~260 world units per second: fast enough to read as a streak, slow
         enough that a 90-unit corridor shot is visible for a third of a
         second, which is where CS2 sits */
      t.travel += 260 * dt;
      var head = Math.min(t.travel, t.max);
      var len = Math.min(head, 7.5);
      if (t.t >= t.life || head >= t.max - 0.01) { t.live = false; t.node.visible = false; continue; }
      any = true;
      var tail = head - len;
      t.node.position.set(t.ox + t.dx * tail, t.oy + t.dy * tail, t.oz + t.dz * tail);
      /* the quad grows along +Y, so point +Y down the flight path */
      t.node.quaternion.setFromUnitVectors(_v.set(0, 1, 0), _v2.set(t.dx, t.dy, t.dz));
      var fade = 1 - clamp(t.t / t.life, 0, 1);
      t.node.scale.set(0.05, Math.max(0.01, len), 0.05);
      t.node.userData.fade = fade;
    }
    if (tracerMat) tracerMat.opacity = 0.85;
    tracerGroup.visible = any;
  }

  /* =========================================================================
     10. RUNTIME STATE
     ====================================================================== */
  var S = null;

  function makeState() {
    return {
      /* recoil: impulse-driven, target 0. A spring hit with impulse() gives
         x(t) = v*t*e^-wt -- a sharp rise and a slow settle, which is the
         shape of a real recoil pulse and NOT a translation. */
      recBack: new Spring(0, 720, 42), recUp: new Spring(0, 720, 42),
      recPitch: new Spring(0, 720, 40), recYaw: new Spring(0, 560, 40), recRoll: new Spring(0, 560, 38),
      /* lag: the gun trails the camera and catches up. Softer = heavier gun. */
      lagX: new Spring(0, 120, 17), lagY: new Spring(0, 120, 17),
      lagYaw: new Spring(0, 95, 15), lagPitch: new Spring(0, 95, 15), lagRoll: new Spring(0, 80, 14),
      /* part springs */
      slide: new Spring(0, 1500, 62), pump: new Spring(0, 900, 50), trigger: new Spring(0, 900, 46),
      hide: new Spring(1, 150, 22),
      landS: new Spring(0, 190, 22),
      /* draw settle. Under-damped on purpose (zeta 0.55): the raise blend is
         linear in `low`, so without this the muzzle arrives and stops dead.
         One impulse as the weapon clears the holster buys an overshoot and a
         settle for the cost of a single spring. */
      drawS: new Spring(0, 300, 19), lowPrev: 1, reloadCue: 0,
      heat: 0, spin: 0, spinV: 0, coilA: 0, coilB: 0,
      bobPhase: 0, breathe: 0,
      cur: -1, asset: null, tune: null, key: '', supp: false,
      lastAmmo: -1, sinceShot: 99, shotCount: 0,
      magLeft: 0, reloadT: -1, reloadDur: 0,
      inspectT: -1, inspectDur: 2.35,
      flashT: 0, flashDur: 0.03, flashSeed: 0, flashScale: 1,
      /* every optional field gets a real value up front: an `undefined`
         reaching arithmetic is the exact failure that silently deletes
         geometry elsewhere in this codebase */
      pumpQueued: 0, pumpCycle: 0, shellShow: 0, ejectAt: -1,
      slideOverride: 0, pumpOverride: 0, recTuned: -1,
      wasGround: true, alive: true, time: 0
    };
  }

  /* =========================================================================
     11. GAME GLOBALS
     Top-level const/let in a classic script live in the global lexical scope,
     so they resolve by bare name from this file. Probed once, never assumed.
     ====================================================================== */
  var G = {};
  function probeGlobals() {
    /* eslint-disable no-undef */
    G.player = (typeof player !== 'undefined') ? player : null;
    G.WPN = (typeof WPN !== 'undefined') ? WPN : null;
    G.state = (typeof state !== 'undefined') ? state : null;
    G.EYE = (typeof EYE === 'number') ? EYE : 2.85;
    G.EYE_CROUCH = (typeof EYE_CROUCH === 'number') ? EYE_CROUCH : 1.5;
    G.castWall = (typeof castWall === 'function') ? castWall : null;
    /* The game's own cue bus. It fires NZ.first('sfx', ...) first, so an audio
       module gets the cue and can own it; a cue nobody implements falls
       through the game's switch with no default and is silently dropped.
       That is exactly the contract the mechanical cues below want. */
    G.sfx = (typeof sfx === 'function') ? sfx : null;
    /* The game draws the rifle's optic as a 2D sight picture, because a
       magnified scope cannot be rendered from this geometry without a second
       scene pass. It owns the ramp; we only read it, so the frame where the
       glass goes opaque and the frame where the weapon comes off are the
       same frame. Absent (older NUKEM.html), the weapon simply stays up. */
    G.scopeMask = (typeof scopeMask === 'function') ? scopeMask : null;
    G.muzzleLight = null;
    /* eslint-enable no-undef */
    return !!(G.player && G.WPN && G.state);
  }

  /* Positional, the same way the game calls it for the weapon report itself
     (sfx(w.snd, player.x, player.z)), so a mechanical cue pans and attenuates
     with the player rather than sitting flat in the centre. */
  function cue(name) {
    if (!G.sfx) return;
    try {
      var P = G.player;
      G.sfx(name, P ? P.x : undefined, P ? P.z : undefined);
    } catch (e) { G.sfx = null; }
  }
  function probeMuzzleLight() {
    /* eslint-disable no-undef */
    try { G.muzzleLight = (typeof muzzleLight !== 'undefined') ? muzzleLight : null; }
    catch (e) { G.muzzleLight = null; }
    /* eslint-enable no-undef */
  }

  /* =========================================================================
     12. ANIMATION
     ====================================================================== */

  function setWeapon(idx) {
    var gunDef = G.WPN ? G.WPN[idx] : null;
    var key = (gunDef && gunDef.vm) ? gunDef.vm : WKEYS[idx] || 'pistol';
    var A = WEAPONS[key];
    if (!A) {
      /* A weapon this module has no asset for (the grenade: the game draws
         that one itself, on the 2D overlay -- see sprite2d in NUKEM.html).
         The one job here is to get our geometry OFF the screen and park the
         state machine somewhere safe: every root hidden (the hands ride the
         roots, so they go too), asset and tune nulled so the tick's
         `if (!A || !T) return` gate holds every frame until a real weapon
         comes back through this function. Returning true, not false --
         "handled, nothing to animate" -- so the caller does not re-enter
         every frame and the old gun does not stay up. */
      for (var kk in WEAPONS) if (WEAPONS[kk] && WEAPONS[kk].root) WEAPONS[kk].root.visible = false;
      S.cur = idx; S.asset = null; S.tune = null; S.key = key;
      S.reloadT = -1; S.inspectT = -1; S.reloadCue = 0;
      clearReloadParts();
      return true;
    }
    for (var k in WEAPONS) if (WEAPONS[k] && WEAPONS[k].root) WEAPONS[k].root.visible = (k === key);
    S.cur = idx; S.asset = A; S.tune = TUNE[key]; S.key = key;
    S.magLeft = S.tune.mag;
    /* every clock resets on a swap: nothing survives a weapon change, so no
       animation state can be left stranded on a weapon you are not holding */
    S.reloadT = -1; S.inspectT = -1; S.reloadCue = 0;
    S.pumpQueued = 0; S.pumpCycle = 0; S.shellShow = 0; S.ejectAt = -1;
    S.slideOverride = 0; S.pumpOverride = 0;
    S.coilA = 0; S.coilB = 0;
    S.slide.set(0); S.pump.set(0); S.trigger.set(0);
    S.drawS.set(0); S.lowPrev = 1;
    bal.idx = 0; bal.since = 99;
    attachHands(A);
    clearReloadParts();
    if (A.nodes.rocket) A.nodes.rocket.visible = true;
    if (A.nodes.payload) A.nodes.payload.visible = true;
    if (A.nodes.shell) A.nodes.shell.visible = false;
    return true;
  }

  function attachHands(A) {
    if (!handRNode || !handLNode) return;
    if (handRNode.parent) handRNode.parent.remove(handRNode);
    if (handLNode.parent) handLNode.parent.remove(handLNode);
    A.root.add(handRNode);
    var lp = (A.gripLNode && A.nodes[A.gripLNode]) ? A.nodes[A.gripLNode] : A.root;
    lp.add(handLNode);
    var gr = A.gripR, gl = A.gripL;
    handRNode.position.set(gr.p[0], gr.p[1], gr.p[2]);
    handRNode.rotation.set(gr.r[0], gr.r[1], gr.r[2]);
    handRNode.scale.set(gr.s, gr.s, gr.s);
    handLNode.position.set(gl.p[0], gl.p[1], gl.p[2]);
    handLNode.rotation.set(gl.r[0], gl.r[1], gl.r[2]);
    /* mirrored: three.js flips the winding for a negative determinant */
    handLNode.scale.set(-gl.s, gl.s, gl.s);
    /* wrist bend, so the forearm always leaves the frame downward no matter
       which way the hand had to rotate to grip the thing it is holding */
    var ar = gr.arm || [0.22, -0.10, 0.08];
    var al = gl.arm || [0.22, 0.10, -0.08];
    if (armR) armR.rotation.set(ar[0], ar[1], ar[2]);
    if (armL) armL.rotation.set(al[0], al[1], al[2]);
  }

  function fireEvent(gun) {
    var T = S.tune, A = S.asset;
    if (!T || !A) return;
    var weight = fin(gun && gun.weight, 1);
    var kick = fin(gun && gun.kick, 1);
    var R = T.recoil;
    /* the heavier the gun the less it moves for the same impulse, and the
       harder the round the more impulse there is */
    var g = Math.sqrt(clamp(kick, 0.2, 6)) / Math.max(0.55, weight);
    var jit = (hash1(S.shotCount * 7.3) - 0.5);
    var jit2 = (hash1(S.shotCount * 13.7) - 0.5);
    /* Auto-fire progression. The first round out of a settled gun is the
       sharpest thing the shooter feels; five rounds in, the gun is already
       moving and the shoulder is loaded, so the visible kick drops and what
       is left is a rhythmic bounce rather than five identical whips. The
       spray SPREAD is the game's business -- this is only the visual rhythm.
       bal.idx is still the pre-shot index here (ballisticsShot runs below),
       so shot one reads idx 0 and gets the full impulse. prog is exactly 1
       for every other weapon, so their impulses are bit-identical. */
    var prog = 1;
    if (S.key === 'rifle' || S.key === 'm4' || S.key === 'ak') {
      var ai = clamp(bal.idx / 5, 0, 1);
      /* the ripple is gated on ai and is purely SUBTRACTIVE, so shot one is
         exactly 1.0 and nothing later can ever exceed it -- a second shot
         that kicks harder than the first is the one thing this must not do */
      prog = lerp(1.0, 0.70, ai) * (1 - 0.09 * ai * (0.5 + 0.5 * Math.sin(S.shotCount * 2.09)));
    }
    /* the VIEWMODEL kick is deliberately larger and snappier than the aim
       punch. That decoupling is what makes CS2 feel violent while staying
       controllable: the gun whips, the aim point barely moves. */
    S.recBack.impulse(R.back * g * 26 * prog);
    S.recUp.impulse(R.up * g * 26 * prog);
    S.recPitch.impulse(R.pitch * g * 24 * (1 + jit * 0.18) * prog);
    S.recYaw.impulse(R.yaw * g * 24 * jit2 * 2.0 * prog);
    S.recRoll.impulse(R.roll * g * 22 * (1 + jit2 * 0.5) * prog);
    S.shotCount++;
    S.sinceShot = 0;
    S.magLeft = Math.max(0, S.magLeft - 1);
    /* firing always cancels a reload or an inspect -- gameplay never stops */
    S.reloadT = -1; S.inspectT = -1;
    S.trigger.set(1); S.trigger.target = 0;
    ballisticsShot();

    /* flash: one to two frames, no more. A muzzle flash you can watch is a
       muzzle flash that is wrong. */
    S.flashT = S.flashDur = fin(T.flash, 0.03);
    S.flashSeed = Math.random() * TAU;
    /* 5.56 out of a birdcage is a small hard star, not a fireball: the
       hider's whole job is to break the plume up, and the round burns most
       of its charge inside a 14.5in barrel. Smallest flash on the rack. */
    /* per-gun flash: 5.56 out of a birdcage is a small star (rifle, m4);
       7.62x39 off a slant cut throws a wider softer bloom; a full-power
       7.62x51 out of a bare crown is the biggest flash short of the RPG. */
    S.flashScale = (S.key === 'rifle' ? 0.86 : S.key === 'm4' ? 0.88
      : S.key === 'ak' ? 1.22 : S.key === 'dmr' ? 1.65
        : S.key === 'nullstar' ? 2.05
          : S.cur === 3 ? 2.35 : S.cur === 1 ? 1.70 : S.cur === 2 ? 1.15 : 1.0) * (0.88 + Math.random() * 0.24);
    /* A can does not delete the flash, it moves it 150 mm forward and eats
       most of it -- what is left is a dull glow at the mouth and a lot more
       smoke, because the gas that was burning in front of the hider is now
       burning inside the tube and leaving slowly. */
    if (S.supp && A && A.suppressor) S.flashScale *= 0.32;

    /* action */
    if (S.cur === 0) { S.slide.set(1); S.slide.target = 0; }
    if (S.cur === 1) S.pumpQueued = 0.13;
    if (S.cur === 2) { S.spinV = Math.min(30, S.spinV + 15); S.heat = Math.min(1, S.heat + 0.070); }
    if (S.cur === 3 && A.nodes.rocket) A.nodes.rocket.visible = false;
    /* Any weapon that publishes a payload node owns a visible, disposable
       round. Nullstar uses it for the singularity seed; the node contract is
       intentionally generic so the animation does not depend on slot 10. */
    if (A.nodes.payload) A.nodes.payload.visible = false;
    /* the bolt carrier rides the same spring channel the pistol slide does --
       the node is called 'slide', so no new plumbing. The AK's charging
       handle and the M4's carrier cycle the same way; the DMR's bolt group
       makes its full 54mm throw on the channel too, which against the slow
       recoil spring reads as the shooter running the bolt on the way down. */
    if (S.key === 'rifle' || S.key === 'm4' || S.key === 'ak' || S.key === 'dmr') {
      S.slide.set(1); S.slide.target = 0;
    }

    spawnSmoke(T.smoke * (S.cur === 3 ? 1.0 : 0.80) * (S.supp && A && A.suppressor ? 1.75 : 1));
    if (T.tracer > 0 && Math.random() < T.tracer) spawnTracer();
    /* the shotgun's hull leaves on the pump stroke, not the shot -- ejecting
       here as well would put two cases in the air for one shell */
    if (A.eject && S.cur !== 1) S.ejectAt = fin(T.shellDelay, 0.02);
  }

  function spawnSmoke(amount) {
    var A = S.asset; if (!A) return;
    var n = amount > 1.2 ? 4 : amount > 0.8 ? 3 : amount > 0.5 ? 2 : 1;
    for (var i = 0; i < n; i++) {
      var slot = null;
      for (var j = 0; j < smoke.length; j++) if (!smoke[j].live) { slot = smoke[j]; break; }
      if (!slot) { if (smoke.length >= SMOKE_MAX) return; slot = {}; smoke.push(slot); }
      slot.live = true;
      slot.x = A.muzzle[0] + (Math.random() - .5) * 0.010;
      slot.y = A.muzzle[1] + (Math.random() - .5) * 0.010;
      slot.z = A.muzzle[2] + (Math.random() - .5) * 0.010;
      slot.vx = (Math.random() - .5) * 0.09;
      slot.vy = 0.05 + Math.random() * 0.10;
      slot.vz = -0.14 - Math.random() * 0.20;
      slot.rot = Math.random() * TAU;
      slot.spin = (Math.random() - .5) * 1.5;
      slot.life = slot.max = 0.40 + Math.random() * 0.40;
      slot.size = (0.018 + Math.random() * 0.022) * clamp(amount, 0.3, 1.6);
      slot.grow = 0.10 + Math.random() * 0.14;
      slot.alpha = 0.26 * clamp(amount, 0.35, 1.4);
    }
  }

  function ejectShell() {
    var A = S.asset; if (!A || !A.eject) return;
    var slot = null;
    for (var i = 0; i < shells.length; i++) if (!shells[i].live) { slot = shells[i]; break; }
    if (!slot) return;
    var d = A.ejectDir;
    slot.live = true;
    slot.x = A.eject[0]; slot.y = A.eject[1]; slot.z = A.eject[2];
    slot.vx = d[0] * (0.85 + Math.random() * 0.4);
    slot.vy = d[1] * (0.85 + Math.random() * 0.4) + 0.22;
    slot.vz = d[2] * (0.7 + Math.random() * 0.6) + 0.18;
    slot.rx = Math.random() * TAU; slot.ry = Math.random() * TAU; slot.rz = Math.random() * TAU;
    slot.ax = (Math.random() - .5) * 34; slot.ay = (Math.random() - .5) * 26; slot.az = (Math.random() - .5) * 40;
    slot.t = 0; slot.life = 0.92 + Math.random() * 0.25;
    slot.bounced = 0;
    /* a 5.56 case is longer and slimmer than the 9mm the case mesh is; a
       uniform 1.25 is the closest an instanced mesh gets without a second
       geometry, and it is airborne for well under a second */
    slot.s = (S.cur === 1) ? 1.85
      : (S.key === 'dmr') ? 1.50           /* 7.62x51: the longest case out */
        : (S.key === 'ak') ? 1.30            /* 7.62x39: short, fat            */
          : (S.key === 'rifle' || S.key === 'm4') ? 1.25 : 1.0;
  }

  /* ------------------------------------------------------------- reloads -- */
  function startReload() {
    var T = S.tune; if (!T || S.reloadT >= 0) return;
    /* nothing about a grenade reloads: not on R, not on the pickup-while-
       held ammo bump the reload detector reads as a fresh magazine */
    if (S.key === 'grenade') return;
    var P = G.player, gun = G.WPN ? G.WPN[S.cur] : null;
    if (!P || !gun) return;
    if (fin(P.ammo && P.ammo[gun.ammo], 0) <= 0) return;
    S.reloadT = 0;
    S.reloadDur = T.reload;
    S.reloadCue = 0;
    S.inspectT = -1;
  }
  function startInspect() {
    if (!S || !S.tune || S.reloadT >= 0 || S.inspectT >= 0) return;
    S.inspectT = 0;
  }

  /* Per-weapon reload choreography. Writes straight into the part nodes and
     an additive pose offset. Purely cosmetic -- firing at any point cancels
     it, because the game's rate of fire is not ours to change. */
  var _rp = [0, 0, 0], _rr = [0, 0, 0];
  function reloadPose(t01) {
    var A = S.asset, T = S.tune;
    if (!A || !T) return;
    var t = t01;
    if (S.cur === 0) {
      /* pistol: cant in, mag out, fresh mag in, slide release */
      var tilt = seg(t, 0, .16) - seg(t, .80, 1);
      _rr[2] = -0.42 * tilt; _rr[0] = 0.20 * tilt; _rr[1] = 0.30 * tilt;
      _rp[0] = -0.018 * tilt; _rp[1] = -0.014 * tilt;
      /* out = 1 when the well is empty. The same curve run backwards seats
         the fresh magazine, so one number drives the whole exchange. */
      var out = Math.max(0, seg(t, .18, .40) - seg(t, .48, .70));
      var m = A.nodes.mag;
      if (m) {
        m.position.set(A.magDrop[0] * out, A.magDrop[1] * out, A.magDrop[2] * out);
        m.visible = out < 0.99;
      }
      /* slide locks back on the empty magazine, then is released home */
      S.slideOverride = seg(t, .18, .26) * (1 - seg(t, .76, .84));
      if (handLNode) {
        var reach = Math.sin(seg(t, .16, .74) * PI);
        handLNode.position.y = A.gripL.p[1] - 0.075 * reach;
        handLNode.position.z = A.gripL.p[2] + 0.055 * reach;
      }
    } else if (S.cur === 1) {
      /* shotgun: cant over, shells thumbed into the loading port, hard pump */
      var tilt2 = seg(t, 0, .12) - seg(t, .84, 1);
      _rr[2] = 0.50 * tilt2; _rr[0] = 0.26 * tilt2; _rr[1] = -0.24 * tilt2;
      _rp[0] = -0.012 * tilt2; _rp[1] = -0.018 * tilt2;
      var k = clamp(Math.floor((t - .12) / .16), 0, 3);
      var sub = clamp((t - .12 - k * .16) / .16, 0, 1);
      if (t > .12 && t < .76) {
        var pushV = Math.sin(clamp(sub, 0, 1) * PI);
        _rp[1] += -0.005 * pushV;
        if (handLNode) {
          handLNode.position.y = A.gripL.p[1] - 0.050 * pushV;
          handLNode.position.z = A.gripL.p[2] + 0.215 * pushV;
        }
      }
      S.pumpOverride = seg(t, .80, .90) - seg(t, .90, .99);
    } else if (S.cur === 2) {
      /* chaingun: feed cover up, belt swapped in, cover slammed shut */
      var tilt3 = seg(t, 0, .14) - seg(t, .86, 1);
      _rr[2] = -0.34 * tilt3; _rr[1] = 0.46 * tilt3; _rr[0] = 0.16 * tilt3;
      _rp[0] = -0.028 * tilt3; _rp[1] = -0.010 * tilt3;
      var b = A.nodes.belt;
      if (b) {
        var outB = seg(t, .18, .38), inB = seg(t, .52, .74);
        var off = Math.max(0, outB - inB);
        b.position.set(0.045 * off, -0.09 * off, 0.03 * off);
        b.visible = off < 0.98;
      }
      if (handLNode && t > .16 && t < .80) {
        var swing = Math.sin(seg(t, .16, .80) * PI);
        handLNode.position.y = A.gripL.p[1] + 0.070 * swing;
        handLNode.position.z = A.gripL.p[2] + 0.140 * swing;
      }
    } else if (S.key === 'nullstar') {
      /* Nullstar: collapse the cage toward the eye, bring a fresh singularity
         seed up from the capacitor-side pouch, and push it between the three
         field vanes. The visible payload, not an invisible magazine counter,
         is the beat the player reads. */
      var tiltN = sstep2(seg(t, 0, .14)) - sstep2(seg(t, .84, 1));
      _rr[2] = -0.34 * tiltN;
      _rr[0] = 0.18 * tiltN;
      _rr[1] = 0.38 * tiltN;
      _rp[0] = -0.020 * tiltN;
      _rp[1] = -0.018 * tiltN;

      var seatN = sstep2(seg(t, .28, .74));
      var payN = A.nodes.payload;
      var homeN = A.payloadHome || [0, 0, 0];
      if (payN) {
        payN.visible = t >= .18;
        payN.position.set(
          homeN[0] + 0.125 * (1 - seatN),
          homeN[1] - 0.190 * (1 - seatN),
          homeN[2] + 0.205 * (1 - seatN)
        );
      }
      if (handLNode) {
        var fetchN = Math.sin(seg(t, .10, .58) * PI);
        var guideN = Math.sin(seg(t, .42, .86) * PI);
        handLNode.position.x = A.gripL.p[0] + 0.105 * fetchN + 0.040 * guideN;
        handLNode.position.y = A.gripL.p[1] - 0.165 * fetchN + 0.018 * guideN;
        handLNode.position.z = A.gripL.p[2] + 0.125 * fetchN - 0.270 * guideN;
      }
      /* Containment catches with a short physical clack already available on
         both audio paths; the field's electronic charge sound is gameplay-
         owned and may outlive this cosmetic sequence. */
      if (S.reloadCue < 1 && t >= .735) { S.reloadCue = 1; cue('switch'); }
      var lockN = Math.exp(-Math.pow((t - .75) / .035, 2));
      _rp[2] += 0.010 * lockN;
      _rr[0] -= 0.035 * lockN;
    } else if (S.key === 'rifle' || S.key === 'm4' || S.key === 'ak' || S.key === 'dmr') {
      /* One box-magazine exchange serves all four rifles: the AK rocks its
         mag on a longer forward arc (magDrop z carries that), the DMR's ten
         rounds ride the same beats, and the closing slap doubles as bolt
         release on the ARs and bolt-close on the DMR. The cues are the
         rifle's own magout/magin/bolt set -- one cartridge family of
         mechanical sounds, and the AI cannot hear the difference from
         inside a firefight. */
      /* AR magazine change, 2.40s. Four beats, CS2 pacing -- the gun barely
         moves, the support hand does all the work, and every key is eased so
         nothing arrives at constant velocity:

            0.31s  mag release pressed, magazine breaks free   -> rifle_magout
            0.31 - 0.82s  magazine falls clear, hand dives left
            1.15 - 1.92s  fresh magazine up into the well
            1.80s  seated with a tap                           -> rifle_magin
            2.06s  bolt catch slapped, carrier slams home      -> rifle_bolt

         The carrier is held BACK for the whole sequence: on an AR the bolt
         locks open on the empty magazine, which is exactly why the last beat
         is a bolt release and not a charging-handle rack. */
      var tiltR = sstep2(seg(t, 0, .12)) - sstep2(seg(t, .88, 1));
      _rr[2] = -0.26 * tiltR;          /* roll the magwell toward the eye */
      _rr[0] = 0.13 * tiltR;
      _rr[1] = 0.30 * tiltR;
      _rp[0] = -0.014 * tiltR; _rp[1] = -0.011 * tiltR;

      var outR = Math.max(0, sstep2(seg(t, .11, .34)) - sstep2(seg(t, .56, .78)));
      var mR = A.nodes.mag;
      if (mR) {
        mR.position.set(A.magDrop[0] * outR, A.magDrop[1] * outR, A.magDrop[2] * outR);
        mR.visible = outR < 0.99;
      }
      /* bolt hold-open, released on the slap */
      S.slideOverride = 1 - sstep2(seg(t, .845, .895));

      if (handLNode) {
        var fetchR = Math.sin(clamp(seg(t, .10, .60), 0, 1) * PI);
        var seatR = Math.sin(clamp(seg(t, .46, .82), 0, 1) * PI);
        var slapR = Math.sin(clamp(seg(t, .78, .97), 0, 1) * PI);
        handLNode.position.x = A.gripL.p[0] - 0.062 * fetchR + 0.004 * seatR + 0.010 * slapR;
        handLNode.position.y = A.gripL.p[1] - 0.185 * fetchR - 0.056 * seatR - 0.020 * slapR;
        handLNode.position.z = A.gripL.p[2] + 0.115 * fetchR + 0.203 * seatR + 0.224 * slapR;
      }
      /* two impulses you can feel: the magazine seating, and 0.26s later the
         carrier arriving. Gaussian rather than a ramp -- a seat is an impact */
      var tapR = Math.exp(-Math.pow((t - .755) / .030, 2));
      _rp[1] += 0.0055 * tapR; _rr[0] += 0.028 * tapR;
      var joltR = Math.exp(-Math.pow((t - .872) / .026, 2));
      _rp[2] += 0.0090 * joltR; _rr[0] -= 0.024 * joltR;

      /* edge-triggered: a stalled frame, a re-entry or a 4ms frame can only
         ever fire each cue once, because the counter never goes backwards
         inside a sequence and is reset only by startReload/setWeapon */
      if (S.reloadCue < 1 && t >= .130) { S.reloadCue = 1; cue('rifle_magout'); }
      else if (S.reloadCue < 2 && t >= .750) { S.reloadCue = 2; cue('rifle_magin'); }
      else if (S.reloadCue < 3 && t >= .860) { S.reloadCue = 3; cue('rifle_bolt'); }
    } else {
      /* rpg: drop the tube off the shoulder, thumb a round into the muzzle */
      var tilt4 = seg(t, 0, .18) - seg(t, .82, 1);
      _rr[2] = 0.30 * tilt4; _rr[0] = -0.30 * tilt4; _rr[1] = -0.20 * tilt4;
      _rp[1] = -0.030 * tilt4;
      var r = A.nodes.rocket;
      if (r) {
        var ins2 = seg(t, .30, .74);
        r.visible = ins2 > 0.01;
        r.position.set(-0.09 * (1 - ins2), -0.14 * (1 - ins2), -0.09 * (1 - ins2));
      }
      if (handLNode) {
        var sw = Math.sin(seg(t, .16, .84) * PI);
        handLNode.position.y = A.gripL.p[1] - 0.028 * sw;
        handLNode.position.z = A.gripL.p[2] - 0.24 * sw;
      }
    }
    /* the pose offsets above are eye-relative, the hand offsets are
       weapon-local: only the first set follows the framing distance */
    _rp[0] *= MOTION; _rp[1] *= MOTION; _rp[2] *= MOTION;
  }

  /* Reset every part the reload and inspect layers can touch. Called EVERY
     frame before those layers run, so there is no ordering by which a
     cancelled animation can leave a magazine on the floor or a hand in the
     air -- the rest state is re-established unconditionally. */
  function clearReloadParts() {
    var A = S.asset; if (!A) return;
    _rp[0] = _rp[1] = _rp[2] = 0; _rr[0] = _rr[1] = _rr[2] = 0;
    if (A.nodes.mag) { A.nodes.mag.position.set(0, 0, 0); A.nodes.mag.visible = true; }
    if (A.nodes.belt) { A.nodes.belt.position.set(0, 0, 0); A.nodes.belt.visible = true; }
    if (A.nodes.rocket) { A.nodes.rocket.position.set(0, 0, 0); }
    if (A.nodes.payload && A.payloadHome) {
      A.nodes.payload.position.set(A.payloadHome[0], A.payloadHome[1], A.payloadHome[2]);
    }
    S.slideOverride = 0; S.pumpOverride = 0;
    if (handLNode && A.gripL) {
      handLNode.position.set(A.gripL.p[0], A.gripL.p[1], A.gripL.p[2]);
    }
  }

  /* ------------------------------------------------------------- the tick - */
  function update(dt) {
    if (!built || !S) return;
    dt = clamp(fin(dt, 0.016), 0, 0.1);
    var P = G.player, WP = G.WPN, ST = G.state;
    if (!P || !WP) return;
    S.time += dt;

    /* visibility: the 2D path was hidden by the overlay's CSS opacity on the
       title, death and win screens. Ours is real geometry in the HDR buffer,
       so it has to opt out explicitly or it floats over the menus. */
    var shouldShow = !!(ST && ST.booted && !ST.ended && (ST.playing || ST.paused));
    S.hide.target = shouldShow ? 0 : 1;
    if (!shouldShow && S.hide.x > 0.985) {
      if (vmRoot) vmRoot.visible = false;
      S.hide.step(dt);
      /* hand the camera back before we stop updating it, or a punch we wrote
         on the last live frame stays on the eye angles for the whole menu */
      if (bal.applied) { bal.idx = 0; bal.since = 99; restoreGameTuning(); }
      return;
    }
    /* Scoped, the sight picture is the game's 2D eyepiece and the only part
       of this weapon still inside the glass is a 10%-wide strip of receiver
       hanging off the bottom of the optic. It comes off at mask 0.5, which
       is exactly where the game's surround reaches full opacity, so there is
       no frame with a transparent tube and no gun in it.

       Visibility only -- the tick below still runs, so recoil, the spray
       index, the bolt, the reload and the world muzzle light all keep their
       state. The flash, smoke and ejecting brass live on vmScene rather than
       vmRoot, so renderVM's early-out takes those too: the game draws a wash
       through the glass in their place, and brass you cannot see through a
       scope is not a loss. */
    if (vmRoot) vmRoot.visible = !(G.scopeMask && fin(G.scopeMask(), 0) > 0.5);

    var wi = P.weapon | 0;
    /* The suppressor. The game owns the boolean because the game owns what it
       MEANS -- the noise radius the AI hears, the report, the mount time --
       and we own the only part of it that is geometry. Applied on change
       rather than every frame so a hidden node is not re-hidden 144 times a
       second, and re-applied on weapon change because setWeapon swaps which
       asset A points at. */
    var supp = !!(P.suppressed);
    if (supp !== S.supp || wi !== S.cur) {
      S.supp = supp;
      for (var sk in WEAPONS) {
        var SA = WEAPONS[sk];
        if (!SA || !SA.suppressor || !SA.nodes.can) continue;
        SA.nodes.can.visible = supp;
        SA.muzzle = supp ? SA.muzzleCan : SA.muzzleBare;
      }
    }

    if (wi !== S.cur) {
      if (!setWeapon(wi)) return;
      S.lastAmmo = -1;
    }
    var A = S.asset, T = S.tune;
    if (!A || !T) return;
    var gun = WP[wi] || null;

    /* ---- events -------------------------------------------------------- */
    var ammoKey = gun ? gun.ammo : null;
    var ammo = (ammoKey && P.ammo) ? fin(P.ammo[ammoKey], 0) : 0;
    if (S.lastAmmo >= 0 && ammo < S.lastAmmo) fireEvent(gun);
    else if (S.lastAmmo >= 0 && ammo > S.lastAmmo && S.magLeft < T.mag) {
      if (S.sinceShot > 0.8 && S.reloadT < 0) { S.magLeft = T.mag; startReload(); }
    }
    S.lastAmmo = ammo;
    S.sinceShot += dt;

    /* the grenade leaves with the throw: the hand stays up empty for the
       arc of the swing, then the next one appears from the pouch -- unless
       that was the last, in which case the game is already swapping away */
    if (S.key === 'grenade' && A.nodes.nade)
      A.nodes.nade.visible = S.sinceShot > 0.44 && ammo > 0;

    if (S.ejectAt >= 0) {
      S.ejectAt -= dt;
      if (S.ejectAt <= 0) { ejectShell(); S.ejectAt = -1; }
    }
    if (S.pumpQueued > 0) {
      S.pumpQueued -= dt;
      if (S.pumpQueued <= 0) { S.pump.set(0); S.pump.target = 1; S.pumpCycle = 0.30; S.pumpQueued = 0; }
    }
    if (S.pumpCycle > 0) {
      S.pumpCycle -= dt;
      if (S.pumpCycle < 0.15 && S.pump.target === 1) {
        S.pump.target = 0;
        if (A.nodes.shell) { A.nodes.shell.visible = true; S.shellShow = 0.10; }
      }
      if (S.pumpCycle <= 0) S.pumpCycle = 0;
    }
    if (S.shellShow > 0) {
      S.shellShow -= dt;
      /* the hull rides out of the port, then hands off to a real physics
         case at the instant it clears */
      if (S.shellShow <= 0) { if (A.nodes.shell) A.nodes.shell.visible = false; ejectShell(); }
    }

    /* Auto reload once the virtual magazine is dry and the trigger is idle.
       Purely cosmetic: the game's cooldown, ammo and rate of fire are
       untouched, and firing cancels the sequence instantly. */
    var idleT = (S.cur === 3) ? 0.10 : 0.26;
    if (S.reloadT < 0 && S.magLeft <= 0 && S.sinceShot > idleT && ammo > 0) startReload();

    /* ---- inputs -------------------------------------------------------- */
    var ads = clamp(fin(P.ads, 0), 0, 1);
    var sprint = clamp(fin(P.sprint, 0), 0, 1) * (1 - ads);
    var moveBlend = clamp(fin(P.moveBlend, 0), 0, 1);
    var swayX = clamp(fin(P.swayX, 0), -0.45, 0.45);
    var swayY = clamp(fin(P.swayY, 0), -0.45, 0.45);
    var bobPhase = fin(P.bobPhase, 0);
    var vmKick = clamp(fin(P.vmKick, 0), 0, 2.4);
    var weight = fin(gun && gun.weight, 1);
    var alive = P.alive !== false;
    var onGround = P.onGround !== false;
    /* crouch is a local in the game's update, so read it off the eye height
       the camera actually ended up at */
    var crouch = false;
    var wc = NZ.ctx.camera;
    if (wc) {
      var eyeH = wc.position.y - (fin(P.y, 0) - fin(P.stepSm, 0)) - fin(P.bob, 0);
      crouch = eyeH < (G.EYE + G.EYE_CROUCH) * 0.5;
    }
    /* landing impact */
    if (onGround && !S.wasGround) {
      var vimp = clamp(-fin(P.vy, 0), 0, 60);
      if (vimp > 6) { S.landS.impulse((-0.020 - vimp * 0.0016) * MOTION); bal.land = clamp(vimp / 34, 0, 1); }
    }
    S.wasGround = onGround;

    /* ---- ballistics ---------------------------------------------------- */
    if (!alive) { bal.idx = 0; bal.since = 99; }
    ballisticsStep(dt, P, S.key, ads, crouch, onGround, moveBlend, sprint);

    /* lowered amount: 0 up, 1 stowed. Same curve the sprite path used, so
       swap timing still matches the sound and the game's cooldown. */
    var swapDur = Math.max(0.02, fin(P.swapDur, 0.22));
    var raiseDur = Math.max(0.02, fin(P.raiseDur, 0.22));
    var low = (fin(P.pending, -1) >= 0)
      ? clamp(1 - Math.max(0, fin(P.swapT, 0)) / swapDur, 0, 1)
      : (fin(P.raiseT, 0) > 0 ? clamp(fin(P.raiseT, 0) / raiseDur, 0, 1) : 0);
    if (!alive) low = 1;

    /* ---- springs ------------------------------------------------------- */
    var R = T.recoil;
    if (S.recTuned !== S.cur) {
      S.recTuned = S.cur;
      var k = R.k, z = R.z;
      tuneSpring(S.recBack, k * 0.9, z); tuneSpring(S.recUp, k * 0.9, z);
      tuneSpring(S.recPitch, k, z);
      tuneSpring(S.recYaw, k * 0.8, z + 0.12);
      tuneSpring(S.recRoll, k * 0.7, z + 0.15);
      var lk = 150 / Math.max(0.5, weight * T.lag);
      tuneSpring(S.lagX, lk, 0.85); tuneSpring(S.lagY, lk, 0.85);
      tuneSpring(S.lagYaw, lk * 0.8, 0.80); tuneSpring(S.lagPitch, lk * 0.8, 0.80);
      tuneSpring(S.lagRoll, lk * 0.6, 0.78);
    }

    /* two scales on purpose: the first three targets are METRES at the weapon
       and follow the framing distance, the last three are RADIANS and do not */
    var lagRot = (1 - ads * 0.86);
    var lagPos = lagRot * MOTION;
    S.lagX.target = -swayX * 0.175 * T.lag * lagPos;
    S.lagY.target = -swayY * 0.125 * T.lag * lagPos;
    S.lagYaw.target = swayX * 0.68 * T.lag * lagRot;
    S.lagPitch.target = -swayY * 0.56 * T.lag * lagRot;
    S.lagRoll.target = -swayX * 0.90 * T.lag * lagRot;
    S.recBack.step(dt); S.recUp.step(dt);
    S.recPitch.step(dt); S.recYaw.step(dt); S.recRoll.step(dt);
    S.lagX.step(dt); S.lagY.step(dt);
    S.lagYaw.step(dt); S.lagPitch.step(dt); S.lagRoll.step(dt);
    S.slide.step(dt); S.pump.step(dt); S.trigger.step(dt); S.hide.step(dt);
    S.landS.step(dt);
    /* Draw settle, rifle only. `low` runs 1 -> 0 across the raise, so the
       moment it crosses 0.30 the weapon has cleared the holster: one impulse
       there and the under-damped spring supplies the overshoot and ring-down
       that a linear raise blend can never have. Held at exactly zero for the
       other four, so their draw is unchanged. */
    if (S.key === 'rifle') {
      if (S.lowPrev > 0.30 && low <= 0.30) S.drawS.impulse(1.20);
      S.drawS.step(dt);
    } else if (S.drawS.x !== 0 || S.drawS.v !== 0) S.drawS.set(0);
    S.lowPrev = low;

    /* ---- reload / inspect ---------------------------------------------- */
    clearReloadParts();
    if (S.reloadT >= 0) {
      S.reloadT += dt;
      var rt = S.reloadT / Math.max(0.05, S.reloadDur);
      /* watchdog: a clock that can only ever move forward, with a hard exit.
         There is no input, no state and no framerate that leaves it running. */
      if (rt >= 1 || S.reloadT > S.reloadDur * 3 + 1) {
        S.reloadT = -1; S.magLeft = T.mag;
        if (A.nodes.rocket) A.nodes.rocket.visible = true;
        if (A.nodes.payload) A.nodes.payload.visible = true;
      } else reloadPose(rt);
    }
    var insp = 0;
    if (S.inspectT >= 0) {
      S.inspectT += dt;
      if (S.inspectT >= S.inspectDur || low > 0.02 || sprint > 0.02 || ads > 0.02) S.inspectT = -1;
      else {
        var it = S.inspectT / S.inspectDur;
        insp = sstep2(seg(it, 0, .18)) * (1 - sstep2(seg(it, .74, 1)));
      }
    }

    /* ---- pose blend ---------------------------------------------------- */
    var hp = T.hip.p, hr = T.hip.r;
    /* ADS: put the sight line exactly on the camera axis. With an identity
       ADS rotation, a local point (sx, sy, z) maps to (0, 0, z + zAds), so
       the rear notch and the front post land on the SAME pixel -- not
       approximately, exactly, and for an offset optic too. */
    var zAds = -T.adsEye - A.zRear;
    var ax = -A.sight[0], ay = -A.sight[1], az = zAds;
    /* The rifle is the lightest thing on the rack to shoulder, so its POSE is
       front-loaded against the game's linear ads ramp -- two thirds of the way
       up at the halfway point, which reads as a faster mount than the shotgun
       without the module touching the game's transition at all. Endpoints are
       exact (0 -> 0, 1 -> 1), so the solved sight alignment still holds, and
       the ballistics cone above still reads the raw ads. */
    var adsP = ads;
    if (S.key === 'rifle') adsP = sstep(clamp(ads * 1.22, 0, 1));

    var px = lerp(hp[0], ax, adsP);
    var py = lerp(hp[1], ay, adsP);
    var pz = lerp(hp[2], az, adsP);
    var rx = lerp(hr[0], 0, adsP);
    var ry = lerp(hr[1], 0, adsP);
    var rz = lerp(hr[2], 0, adsP);

    if (sprint > 0.001) {
      var sp = T.sprint.p, sr = T.sprint.r, ss = sstep(sprint);
      px = lerp(px, sp[0], ss); py = lerp(py, sp[1], ss); pz = lerp(pz, sp[2], ss);
      rx = lerp(rx, sr[0], ss); ry = lerp(ry, sr[1], ss); rz = lerp(rz, sr[2], ss);
    }
    if (insp > 0.001 && T.inspect) {
      var ip = T.inspect.p, ir = T.inspect.r;
      px = lerp(px, ip[0], insp); py = lerp(py, ip[1], insp); pz = lerp(pz, ip[2], insp);
      rx = lerp(rx, ir[0], insp); ry = lerp(ry, ir[1], insp); rz = lerp(rz, ir[2], insp);
    }
    /* draw / holster */
    var lowE = sstep(clamp(S.hide.x + low, 0, 1));
    if (lowE > 0.001) {
      var lp = T.low.p, lr = T.low.r;
      px = lerp(px, lp[0], lowE); py = lerp(py, lp[1], lowE); pz = lerp(pz, lp[2], lowE);
      rx = lerp(rx, lr[0], lowE); ry = lerp(ry, lr[1], lowE); rz = lerp(rz, lr[2], lowE);
    }
    /* the additive reload offset rides on top of everything */
    px += _rp[0]; py += _rp[1]; pz += _rp[2];
    rx += _rr[0]; ry += _rr[1]; rz += _rr[2];
    /* ...and the draw settle on top of that. Exactly zero unless the rifle is
       out and mid-raise, so it cannot bias a resting pose. */
    if (S.drawS.x !== 0) {
      rx += S.drawS.x * 1.25;
      rz += S.drawS.x * 0.45;
      py += S.drawS.x * 0.22 * MOTION;
    }

    vmPose.position.set(px, py, pz);
    vmPose.rotation.set(rx, ry, rz);

    /* ---- sway / bob / breathing on the root ---------------------------- */
    var amp = (1 - ads * 0.94);
    var walk = moveBlend * (1 - ads * 0.72);
    var bobA = T.bob * 0.0125 * MOTION * walk * (1 + sprint * 0.55);
    var bx = Math.sin(bobPhase) * bobA;
    var by = -Math.abs(Math.cos(bobPhase)) * bobA * 0.78 + bobA * 0.38;
    var bRoll = Math.sin(bobPhase) * 0.028 * walk * T.bob;
    var bPitch = Math.cos(bobPhase * 2) * 0.015 * walk * T.bob;
    /* idle drift: a lissajous, not a sine. Two incommensurate frequencies on
       each axis mean the figure never repeats, so a player staring at a wall
       never sees the loop -- the thing that gives idle animation away. */
    S.breathe += dt;
    var bt = S.breathe, idleAmt = (1 - sprint) * (1 - moveBlend * 0.62);
    var brX = (Math.sin(bt * 0.61) * 0.62 + Math.sin(bt * 1.43 + 1.7) * 0.38) * 0.0026 * MOTION * idleAmt;
    var brY = (Math.sin(bt * 0.87 + 0.9) * 0.58 + Math.sin(bt * 1.97 + 2.4) * 0.42) * 0.0030 * MOTION * idleAmt;
    var brR = (Math.sin(bt * 0.47 + 2.1) * 0.7 + Math.sin(bt * 1.13 + 0.3) * 0.3) * 0.0115 * idleAmt;
    var brP = (Math.sin(bt * 0.71 + 1.2)) * 0.0075 * idleAmt;

    /* the game's own view kick, mirrored into the gun so the two agree */
    var kickY = (-clamp(fin(P.kick, 0), -12, 12) * 0.0016 - vmKick * 0.0115) * MOTION;

    vmSway.position.set(
      (S.lagX.x + bx + brX) * amp,
      (S.lagY.x + by + brY) * amp + kickY + S.landS.x,
      0
    );
    vmSway.rotation.set(
      /* landS is a metre spring; the pitch it drives is an angle, so the
         MOTION gain that was added to its impulse comes back off here */
      (S.lagPitch.x + bPitch + brP) * amp - (S.landS.x / MOTION) * 1.6,
      S.lagYaw.x * amp,
      (S.lagRoll.x + bRoll + brR) * amp - sprint * 0.10
    );

    /* ---- recoil node --------------------------------------------------- */
    /* rotation first-class, translation almost incidental: a gun that
       TRANSLATES backward reads as a toy on a spring */
    vmRecoil.position.set(
      -S.recYaw.x * 0.14 * MOTION,
      S.recUp.x,
      S.recBack.x
    );
    vmRecoil.rotation.set(S.recPitch.x, S.recYaw.x, S.recRoll.x);

    /* ---- moving parts -------------------------------------------------- */
    var slideAmt = Math.max(S.slide.x, fin(S.slideOverride, 0));
    if (A.nodes.slide) A.nodes.slide.position.z = clamp(slideAmt, 0, 1.2) * fin(A.slideBack, 0.026);
    var pumpAmt = Math.max(S.pump.x, fin(S.pumpOverride, 0));
    if (A.nodes.pump) A.nodes.pump.position.z = clamp(pumpAmt, 0, 1.2) * fin(A.pumpBack, 0.062);
    if (A.nodes.trigger) A.nodes.trigger.rotation.x = A.triggerPull * clamp(S.trigger.x, 0, 1);
    /* built curled onto the trigger, so pulling the trigger takes the finger
       TO zero rotation and releasing lifts it clear -- 8mm of visible travel
       with the pad on the trigger face at full pull */
    if (fingerR) fingerR.rotation.x = 0.22 * (1 - clamp(S.trigger.x, 0, 1));

    /* chaingun spin-up / spin-down and barrel heat */
    if (A.nodes.barrels) {
      S.spinV *= Math.pow(0.10, dt);
      S.spin += S.spinV * dt;
      if (S.spin > TAU) S.spin -= TAU;
      A.nodes.barrels.rotation.z = S.spin;
      S.heat = Math.max(0, S.heat - dt * 0.16);
      if (A.hotMat) {
        var h = clamp(S.heat, 0, 1);
        var hv = h * h;
        A.hotMat.emissive.setRGB(hv * 1.10, hv * 0.24, hv * 0.045);
      }
    }
    /* Nullstar's machinery never sits perfectly still. The two exposed field
       coils counter-rotate, accelerate on collapse, and the suspended core
       precesses on incommensurate axes. The phases live in runtime state so a
       changing speed never creates the discontinuity `time * speed` would. */
    if (S.key === 'nullstar' && A.nodes.coils && A.nodes.core) {
      var collapseN = Math.exp(-Math.max(0, S.sinceShot) * 6.5);
      var reloadN = S.reloadT >= 0 ? clamp(S.reloadT / Math.max(.05, S.reloadDur), 0, 1) : 0;
      var armedN = A.nodes.payload && A.nodes.payload.visible ? 1 : 0;
      var spinN = 1.25 + collapseN * 11.0 + reloadN * 2.2;
      S.coilA = (S.coilA + dt * spinN) % TAU;
      S.coilB = (S.coilB - dt * spinN * 1.31) % TAU;
      A.nodes.coils.rotation.z = S.coilA;
      if (A.nodes.coil2) A.nodes.coil2.rotation.z = S.coilB;

      var pulseN = 0.5 + 0.5 * Math.sin(S.time * 5.7 + Math.sin(S.time * 1.9));
      var coreScaleN = 0.88 + pulseN * 0.16 + collapseN * 0.42;
      A.nodes.core.scale.setScalar(coreScaleN);
      A.nodes.core.rotation.set(S.time * .47, -S.time * .71, S.time * .33);
      if (A.coreMat) {
        A.coreMat.color.setRGB(
          0.22 + collapseN * 0.75,
          1.65 + pulseN * 0.55,
          1.05 + pulseN * 0.42 + collapseN * 1.15
        );
        A.coreMat.opacity = clamp(.72 + pulseN * .18 + collapseN * .10, 0, 1);
      }
      if (A.coreHaloMat) {
        A.coreHaloMat.color.setRGB(0.48 + collapseN * 1.20, 0.72 + pulseN * .35, 2.15 + collapseN * 1.35);
        A.coreHaloMat.opacity = .22 + pulseN * .18 + collapseN * .30;
      }
      if (A.nodes.payload && A.nodes.payload.visible) {
        A.nodes.payload.rotation.z = -S.time * (2.6 + reloadN * 3.5);
        var seedN = 0.96 + Math.sin(S.time * 8.2) * .045;
        A.nodes.payload.scale.setScalar(seedN);
        if (A.payloadMat) {
          A.payloadMat.color.setRGB(1.35 + pulseN * .45, .70 + armedN * .25, 2.55 + pulseN * .65);
          A.payloadMat.opacity = .68 + pulseN * .22;
        }
      }
    }
    if (A.nodes.shell && A.nodes.shell.visible) {
      var ep = 1 - clamp(S.shellShow / 0.10, 0, 1);
      A.nodes.shell.position.set(0.018 + 0.020 * ep, 0.030 + 0.026 * ep, -0.090 + 0.010 * ep);
      A.nodes.shell.rotation.z += dt * 9;
    }

    /* ---- effects ------------------------------------------------------- */
    updateFlash(dt);
    updateSmoke(dt);
    updateShells(dt);
    updateTracers(dt);
    updateLights();
  }

  function updateFlash(dt) {
    var A = S.asset;
    if (S.flashT > 0) S.flashT -= dt;
    var on = S.flashT > 0 && A;
    flashGroup.visible = !!on;
    if (!on) { flashLight.intensity = Math.max(0, flashLight.intensity - dt * 120); return; }
    var k = clamp(S.flashT / Math.max(0.001, S.flashDur), 0, 1);
    /* pops instantly and dies on a curve; a symmetric fade reads as a light
       bulb rather than a detonation */
    var env = Math.pow(k, 0.5);
    var m = A.muzzle;
    var mx = m[0], my = m[1], mz = m[2];
    if (A.muzzleSpin) {
      /* the flash comes from whichever barrel is at top dead centre */
      var a = S.spin + PI * 0.5;
      mx = Math.cos(a) * A.muzzleSpin.r;
      my = A.muzzleSpin.cy + Math.sin(a) * A.muzzleSpin.r;
      mz = A.muzzleSpin.z;
    }
    /* the flash must ride the weapon, so hang it off the recoil node's world
       transform rather than the scene root */
    vmRecoil.updateWorldMatrix(true, false);
    _v.set(mx, my, mz).applyMatrix4(vmRecoil.matrixWorld);
    flashGroup.position.copy(_v);
    var sc = S.flashScale * (0.55 + env * 0.55) * 0.095 * VM_SCALE;
    var fieldFlash = S.key === 'nullstar';
    flashQuad.scale.set(sc * (fieldFlash ? 2.55 : 2.0), sc * (fieldFlash ? 2.55 : 2.0), 1);
    flashQuad.position.set(0, 0, -sc * 0.30);
    flashQuad.rotation.z = S.flashSeed;
    flashCone.scale.set(sc * (fieldFlash ? 1.20 : .90), sc * (fieldFlash ? 1.20 : .90), sc * (fieldFlash ? 1.45 : 2.2));
    flashCore.scale.setScalar(sc * (fieldFlash ? .62 : .40));
    flashMat.opacity = env;
    coreMat.opacity = Math.pow(k, 0.9);
    /* above nz-render's bloom threshold in linear HDR, so it actually blooms
       instead of just being bright -- but only just, because CS2 does not
       wash the screen out every time you pull the trigger */
    if (fieldFlash) {
      /* Violet field shear around a cyan-white collapse core. The ordering is
         intentionally opposite the warm firearm palette, so one frame is
         enough to identify the Nullstar without seeing the weapon. */
      flashMat.color.setRGB(1.55 * env, 1.05 * env, 4.60 * env);
      coreMat.color.setRGB(1.45 * k, 6.20 * k, 5.10 * k);
    } else {
      flashMat.color.setRGB(3.2 * env, 2.1 * env, 1.05 * env);
      coreMat.color.setRGB(5.4 * k, 4.3 * k, 2.8 * k);
    }
    flashLight.position.copy(_v);
    /* inverse-square from ~5 cm off the barrel: 24 was several thousand at
       the surface, which blew the front half of every weapon to white */
    flashLight.intensity = (fieldFlash ? 11.5 : 9.5) * env * S.flashScale;
    if (fieldFlash) flashLight.color.setRGB(0.34, 0.92, 1.0);
    else flashLight.color.setRGB(1.0, 0.72, 0.40);

    /* Put the game's world muzzle light where the muzzle actually is instead
       of at the player's feet, so the flash lights the wall in front of you
       from the right place. Read-only on the game's side apart from moving
       an object it re-positions on every shot anyway. */
    if (!G.muzzleLight) probeMuzzleLight();
    var wcam = NZ.ctx.camera;
    if (G.muzzleLight && G.muzzleLight.position && wcam) {
      var e = wcam.matrixWorld.elements;
      G.muzzleLight.position.set(
        e[12] - e[8] * 0.85 + e[0] * 0.22 - e[4] * 0.14,
        e[13] - e[9] * 0.85 + e[1] * 0.22 - e[5] * 0.14,
        e[14] - e[10] * 0.85 + e[2] * 0.22 - e[6] * 0.14
      );
    }
  }

  function updateSmoke(dt) {
    var n = 0, i;
    for (i = 0; i < smoke.length; i++) {
      var p = smoke[i]; if (!p.live) continue;
      p.life -= dt;
      if (p.life <= 0) { p.live = false; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= Math.pow(0.28, dt); p.vz *= Math.pow(0.24, dt);
      p.vy += 0.09 * dt; p.vy *= Math.pow(0.55, dt);
      p.rot += p.spin * dt;
      n++;
    }
    if (!n) { smokeMesh.geometry.setDrawRange(0, 0); smokeMesh.visible = false; return; }
    smokeMesh.visible = true;
    /* the vm camera is fixed at the origin looking down -Z, so a screen
       aligned card is an XY quad -- rotate it in-plane and be done */
    vmRecoil.updateWorldMatrix(true, false);
    var q = 0;
    for (i = 0; i < smoke.length && q < SMOKE_MAX; i++) {
      var s = smoke[i]; if (!s.live) continue;
      var k = clamp(s.life / s.max, 0, 1);
      var sz = s.size * (1 + (1 - k) * s.grow * 8) * VM_SCALE;
      var c = Math.cos(s.rot) * sz, sn = Math.sin(s.rot) * sz;
      _v.set(s.x, s.y, s.z).applyMatrix4(vmRecoil.matrixWorld);
      var o = q * 4 * 3;
      smokePos[o + 0] = _v.x - c + sn; smokePos[o + 1] = _v.y - sn - c; smokePos[o + 2] = _v.z;
      smokePos[o + 3] = _v.x + c + sn; smokePos[o + 4] = _v.y + sn - c; smokePos[o + 5] = _v.z;
      smokePos[o + 6] = _v.x + c - sn; smokePos[o + 7] = _v.y + sn + c; smokePos[o + 8] = _v.z;
      smokePos[o + 9] = _v.x - c - sn; smokePos[o + 10] = _v.y - sn + c; smokePos[o + 11] = _v.z;
      /* punch in over the first few milliseconds, then thin out slowly */
      var al = s.alpha * Math.min(1, (1 - k) * 7) * k * k;
      var oc = q * 4 * 4;
      for (var v = 0; v < 4; v++) {
        smokeCol[oc + v * 4 + 0] = 0.54;
        smokeCol[oc + v * 4 + 1] = 0.56;
        smokeCol[oc + v * 4 + 2] = 0.60;
        smokeCol[oc + v * 4 + 3] = al;
      }
      q++;
    }
    smokeMesh.geometry.attributes.position.needsUpdate = true;
    smokeMesh.geometry.attributes.color.needsUpdate = true;
    smokeMesh.geometry.setDrawRange(0, q * 6);
  }

  function updateShells(dt) {
    var live = 0, i;
    for (i = 0; i < shells.length; i++) {
      var s = shells[i]; if (!s.live) continue;
      s.t += dt;
      if (s.t >= s.life) { s.live = false; continue; }
      s.vy -= 2.6 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.rx += s.ax * dt; s.ry += s.ay * dt; s.rz += s.az * dt;
      /* one bounce off the imaginary floor below the gun, then it tumbles
         out of frame -- brass that bounces twice reads as a ping-pong ball */
      if (s.y < -0.34 && s.vy < 0 && s.bounced < 1) {
        s.bounced++;
        s.y = -0.34; s.vy *= -0.32; s.vx *= 0.60; s.vz *= 0.60;
        s.ax *= 0.5; s.ay *= 0.5; s.az *= 0.5;
      }
      live++;
    }
    if (!live) { shellMesh.count = 0; shellMesh.visible = false; return; }
    shellMesh.visible = true;
    vmRecoil.updateWorldMatrix(true, false);
    var q = 0;
    for (i = 0; i < shells.length && q < SHELL_MAX; i++) {
      var sh = shells[i]; if (!sh.live) continue;
      _v.set(sh.x, sh.y, sh.z).applyMatrix4(vmRecoil.matrixWorld);
      shellDummy.position.copy(_v);
      shellDummy.rotation.set(sh.rx, sh.ry, sh.rz);
      var fade = clamp((sh.life - sh.t) / 0.18, 0, 1);
      shellDummy.scale.setScalar(sh.s * (0.4 + 0.6 * fade) * VM_SCALE);
      shellDummy.updateMatrix();
      shellMesh.setMatrixAt(q, shellDummy.matrix);
      q++;
    }
    shellMesh.count = q;
    shellMesh.instanceMatrix.needsUpdate = true;
  }

  /* Rotate the vm key light to match the world sun in view space, so the gun
     is lit by the same source as everything behind it. */
  function updateLights() {
    var wc = NZ.ctx.camera, L = NZ.ctx.lights;
    /* Share the world's IBL probe FIRST. This used to sit at the bottom of the
       function, behind three early returns -- so on any boot where the game
       had not published NZ.ctx.lights, or where the sun sat on its own target,
       the viewmodel silently rendered with no environment at all while the
       world had one. A weapon lit by a different indirect term than the level
       behind it is the definition of "pasted on". */
    if (NZ.ctx.scene && vmScene && vmScene.environment !== NZ.ctx.scene.environment) {
      vmScene.environment = NZ.ctx.scene.environment || null;
    }
    if (!wc || !L || !L.sunKey) return;
    var sun = L.sunKey;
    _v.copy(sun.position);
    if (sun.target) _v.sub(sun.target.position);
    if (_v.lengthSq() < 1e-6) return;
    _v.normalize();
    wc.updateMatrixWorld();
    _m.copy(wc.matrixWorld);
    _m.setPosition(0, 0, 0);
    _m.invert();
    _v.applyMatrix4(_m).normalize();
    /* keep the key from ever going fully behind the weapon: a viewmodel with
       no key light at all reads as a black cutout */
    if (_v.z < 0.15) _v.z = 0.15;
    if (_v.y < -0.20) _v.y = -0.20;
    _v.normalize();
    keyLight.position.set(_v.x * 2, _v.y * 2, _v.z * 2);
  }

  /* =========================================================================
     13. RENDER
     ====================================================================== */
  function setAspect(a) {
    if (!vmCam || !(a > 0.05) || !isFinite(a)) return;
    if (Math.abs(vmCam.aspect - a) < 1e-4) return;
    vmCam.aspect = a;
    vmCam.updateProjectionMatrix();
  }

  function renderVM(target, worldCam) {
    var r = NZ.ctx.renderer;
    if (!r || !vmScene || !vmCam || !built || !S) return;
    if (vmRoot && !vmRoot.visible) return;
    /* Third person (nz-hero.js): the weapon is in the figure's hands out in
       the world. Draw only -- update() has already run this frame, so recoil,
       the spray index, the reload and the world muzzle light keep their
       state exactly as they do behind the scope. */
    if (NZ.view && NZ.view.hideVM) return;

    var ads = clamp(fin(G.player && G.player.ads, 0), 0, 1);
    var fov = lerp(VM_FOV, VM_FOV_ADS, ads);
    if (Math.abs(vmCam.fov - fov) > 0.01) { vmCam.fov = fov; vmCam.updateProjectionMatrix(); }

    /* Match nz-render's TAA jitter. A symmetric perspective frustum has
       elements 8 and 9 at exactly zero, so whatever is there during
       scenePass is the jitter -- copying it lets TAA resolve our edges
       instead of leaving the weapon as the one aliased thing on screen. */
    if (worldCam && target) {
      var je = worldCam.projectionMatrix.elements;
      var jx = je[8], jy = je[9];
      if (isFinite(jx) && isFinite(jy) && Math.abs(jx) < 0.02 && Math.abs(jy) < 0.02 && (jx || jy)) {
        vmCam.projectionMatrix.elements[8] = jx;
        vmCam.projectionMatrix.elements[9] = jy;
        vmCam.projectionMatrixInverse.copy(vmCam.projectionMatrix).invert();
      }
    }

    var prevTarget = r.getRenderTarget();
    var prevAuto = r.autoClear;
    r.autoClear = false;
    if (target) {
      /* Into nz-render's HDR buffer, on top of the world, KEEPING the world
         depth. We deliberately do NOT clear depth: every weapon is authored
         and posed so no vertex reaches past 0.94 view units, and the player
         collision radius (PRAD 1.15) keeps solid world geometry beyond that,
         so the viewmodel is always in front without a clear. That matters
         because TAA, SSAO and motion blur all read this same depth texture
         immediately after us -- wiping it would break the entire post stack.
         NZ.weapons.verify() asserts the 0.94 bound on every pose. */
      r.setRenderTarget(target);
      r.render(vmScene, vmCam);
      r.setRenderTarget(prevTarget);
    } else {
      /* No post stack: straight onto the framebuffer. Nothing downstream
         reads this depth, so a clear is free insurance. */
      r.setRenderTarget(null);
      r.clearDepth();
      r.render(vmScene, vmCam);
    }
    r.autoClear = prevAuto;
    if (worldCam && target) vmCam.updateProjectionMatrix();
  }

  /* =========================================================================
     14. STATIC VERIFICATION
     Everything here is pure maths over the built geometry, so it can run in
     node against a THREE stub as well as in the browser console. It is the
     only honest way to check framing, sight alignment and depth safety
     without looking at the screen.
     ====================================================================== */
  /* three.js Euler order YXZ builds R = Ry * Rx * Rz. Applied by hand so the
     verifier does not need a matrix library. */
  function applyYXZ(v, rx, ry, rz) {
    var x = v[0], y = v[1], z = v[2];
    var c, s, nx, ny, nz;
    c = Math.cos(rz); s = Math.sin(rz);
    nx = x * c - y * s; ny = x * s + y * c; x = nx; y = ny;
    c = Math.cos(rx); s = Math.sin(rx);
    ny = y * c - z * s; nz = y * s + z * c; y = ny; z = nz;
    c = Math.cos(ry); s = Math.sin(ry);
    nx = x * c + z * s; nz = -x * s + z * c; x = nx; z = nz;
    v[0] = x; v[1] = y; v[2] = z;
    return v;
  }
  function project(v, fovDeg, asp) {
    var tanY = Math.tan(fovDeg * D2R * 0.5);
    var d = -v[2];
    if (d < 1e-5) return null;
    return [0.5 + (v[0] / d) / (tanY * asp) * 0.5, 0.5 - (v[1] / d) / tanY * 0.5];
  }
  /* the hands add reach behind and below the grip that the weapon AABB does
     not know about; treated conservatively */
  var HAND_EXT = { x: [-0.055, 0.062], y: [-0.170, 0.055], z: [-0.055, 0.048] };

  function poseFor(key, ads) {
    var T = TUNE[key], A = WEAPONS[key];
    if (!T || !A) return null;
    var zAds = -T.adsEye - A.zRear;
    return {
      p: [lerp(T.hip.p[0], -A.sight[0], ads), lerp(T.hip.p[1], -A.sight[1], ads), lerp(T.hip.p[2], zAds, ads)],
      r: [lerp(T.hip.r[0], 0, ads), lerp(T.hip.r[1], 0, ads), lerp(T.hip.r[2], 0, ads)]
    };
  }
  function xform(local, pose) {
    var v = [local[0], local[1], local[2]];
    applyYXZ(v, pose.r[0], pose.r[1], pose.r[2]);
    v[0] += pose.p[0]; v[1] += pose.p[1]; v[2] += pose.p[2];
    return v;
  }

  function verify(opt) {
    opt = opt || {};
    var asp = opt.aspect || 16 / 9;
    var issues = [], out = { weapons: {}, recoil: {}, issues: issues, ok: true };
    var key, i;

    for (key in TUNE) {
      var A = WEAPONS[key], T = TUNE[key];
      if (!A || !A.bbox) { issues.push(key + ': not built'); continue; }
      var rec = { };
      /* ---- sight alignment at full ADS ---- */
      var pAds = poseFor(key, 1);
      var pr = xform([A.sight[0], A.sight[1], A.zRear], pAds);
      var pf2 = xform([A.sight[0], A.sight[1], A.zFront], pAds);
      var sr = project(pr, VM_FOV_ADS, asp), sf = project(pf2, VM_FOV_ADS, asp);
      rec.rearSightPx = sr; rec.frontSightPx = sf;
      rec.sightErr = Math.max(
        Math.abs(sr[0] - 0.5) + Math.abs(sr[1] - 0.5),
        Math.abs(sf[0] - 0.5) + Math.abs(sf[1] - 0.5));
      if (rec.sightErr > 1e-6) { issues.push(key + ': sights do not land on the camera axis (err ' + rec.sightErr.toExponential(2) + ')'); out.ok = false; }
      rec.sightRadius = Math.abs(A.zFront - A.zRear);

      /* ---- depth + framing over every pose, corners of the AABB ---- */
      var bmin = [Math.min(A.bbox.min[0], A.gripR.p[0] + HAND_EXT.x[0]),
                  Math.min(A.bbox.min[1], A.gripR.p[1] + HAND_EXT.y[0]),
                  Math.min(A.bbox.min[2], A.gripR.p[2] + HAND_EXT.z[0])];
      var bmax = [Math.max(A.bbox.max[0], A.gripR.p[0] + HAND_EXT.x[1]),
                  Math.max(A.bbox.max[1], A.gripR.p[1] + HAND_EXT.y[1]),
                  Math.max(A.bbox.max[2], A.gripR.p[2] + HAND_EXT.z[1])];
      rec.sizeM = [A.bbox.max[0] - A.bbox.min[0], A.bbox.max[1] - A.bbox.min[1], A.bbox.max[2] - A.bbox.min[2]];
      rec.lengthM = A.bbox.max[2] - A.bbox.min[2];
      var poses = { hip: poseFor(key, 0), ads: pAds, sprint: { p: T.sprint.p, r: T.sprint.r }, low: { p: T.low.p, r: T.low.r }, inspect: { p: T.inspect.p, r: T.inspect.r } };
      rec.poses = {};
      for (var pk in poses) {
        var pose = poses[pk];
        var near = 1e9, far = -1e9, x0 = 9, y0 = 9, x1 = -9, y1 = -9;
        var fv = pk === 'ads' ? VM_FOV_ADS : VM_FOV;
        for (i = 0; i < 8; i++) {
          var c = [(i & 1) ? bmax[0] : bmin[0], (i & 2) ? bmax[1] : bmin[1], (i & 4) ? bmax[2] : bmin[2]];
          var w = xform(c, pose);
          var d = -w[2] * VM_SCALE;
          if (d < near) near = d;
          if (d > far) far = d;
        }
        /* the on-screen box is the WEAPON, not the arms hanging out of frame */
        for (i = 0; i < 8; i++) {
          var c2 = [(i & 1) ? A.bbox.max[0] : A.bbox.min[0], (i & 2) ? A.bbox.max[1] : A.bbox.min[1], (i & 4) ? A.bbox.max[2] : A.bbox.min[2]];
          var w2 = xform(c2, pose);
          var s = project(w2, fv, asp);
          if (s) { if (s[0] < x0) x0 = s[0]; if (s[0] > x1) x1 = s[0]; if (s[1] < y0) y0 = s[1]; if (s[1] > y1) y1 = s[1]; }
        }
        rec.poses[pk] = { near: near, far: far, screen: [x0, y0, x1, y1], w: x1 - x0, h: y1 - y0 };
        if (pk === 'hip' || pk === 'ads') {
          rec.poses[pk].muzzlePx = project(xform(A.muzzle, pose), fv, asp);
          rec.poses[pk].breechPx = project(xform([0, A.sight[1], A.zRear], pose), fv, asp);
          rec.poses[pk].gripPx = project(xform([A.gripR.p[0], A.gripR.p[1] - 0.03, A.gripR.p[2]], pose), fv, asp);
        }
        /* recoil can only push the weapon further from the eye (positive z),
           so the near bound is the one that needs headroom */
        if (near < 0.105) { issues.push(key + '/' + pk + ': nearest vertex at ' + near.toFixed(3) + ' is inside the 0.08 near plane margin'); out.ok = false; }
        if (far > 0.94) { issues.push(key + '/' + pk + ': farthest vertex at ' + far.toFixed(3) + ' can be overdrawn by world geometry (PRAD 1.15)'); out.ok = false; }
        /* ---- FRAMING. The bound that was missing. A competitive viewmodel
           lives in the lower-right corner: it may run off the right edge and
           off the bottom, but it may never reach the crosshair. ADS is the
           one exemption -- the sights are ON the axis by construction, and
           sprint/low/inspect are transient enough to allow a little more. */
        if (pk !== 'ads') {
          var lim = (pk === 'hip') ? { x: 0.52, y: 0.56, w: 0.42, h: 0.66 }
                                   : { x: 0.38, y: 0.42, w: 0.52, h: 0.86 };
          if (x0 < lim.x) { issues.push(key + '/' + pk + ': weapon reaches x=' + x0.toFixed(2) + ', left of the ' + lim.x + ' centre guard'); out.ok = false; }
          if (y0 < lim.y) { issues.push(key + '/' + pk + ': weapon top edge at y=' + y0.toFixed(2) + ' is above the ' + lim.y + ' centre guard'); out.ok = false; }
          if (x1 - x0 > lim.w) { issues.push(key + '/' + pk + ': covers ' + ((x1 - x0) * 100).toFixed(0) + '% of frame width (max ' + (lim.w * 100) + '%)'); out.ok = false; }
          if (y1 - y0 > lim.h) { issues.push(key + '/' + pk + ': covers ' + ((y1 - y0) * 100).toFixed(0) + '% of frame height (max ' + (lim.h * 100) + '%)'); out.ok = false; }
        } else if (x1 - x0 > 0.34) {
          issues.push(key + '/ads: covers ' + ((x1 - x0) * 100).toFixed(0) + '% of frame width at full ADS (max 34%)'); out.ok = false;
        }
      }
      out.weapons[key] = rec;
    }

    /* ---- recoil tables ---- */
    for (key in BAL) {
      var b = BAL[key];
      var t = [0, 0];
      patternAt(b, 0, t, 1);
      var zeroOk = (t[0] === 0 && t[1] === 0);
      /* walk the whole pattern and then far past its end to prove the
         ping-ponged tail stays bounded and continuous */
      var maxUp = 0, maxAbsRight = 0, prev = null, maxJump = 0;
      for (var s2 = 0; s2 <= b.len * 4; s2 += 0.05) {
        patternAt(b, s2, t, 1);
        if (t[0] > maxUp) maxUp = t[0];
        if (Math.abs(t[1]) > maxAbsRight) maxAbsRight = Math.abs(t[1]);
        if (prev) maxJump = Math.max(maxJump, Math.abs(t[0] - prev[0]) + Math.abs(t[1] - prev[1]));
        prev = [t[0], t[1]];
      }
      out.recoil[key] = {
        shots: b.len, sumUpDeg: b.sumUp, sumRightDeg: b.sumRight,
        maxUpDeg: maxUp, maxAbsRightDeg: maxAbsRight, maxStepDeg: maxJump, zeroAtRest: zeroOk
      };
      if (!zeroOk) { issues.push(key + ': recoil index 0 is not zero punch (first-shot accuracy broken)'); out.ok = false; }
      if (Math.abs(b.sumRight) > 0.35) { issues.push(key + ': horizontal recoil sums to ' + b.sumRight.toFixed(2) + ' deg, the pattern does not return to centre'); out.ok = false; }
      if (maxJump > 1.2) { issues.push(key + ': recoil pattern is discontinuous (step ' + maxJump.toFixed(2) + ' deg)'); out.ok = false; }
    }

    /* ---- spring frame-rate independence ---- */
    var dts = [1 / 30, 1 / 60, 1 / 100, 1 / 144, 1 / 240], res = [];
    for (i = 0; i < dts.length; i++) {
      var sp = new Spring(0, 720, 42);
      sp.impulse(3.0);
      var tt = 0;
      while (tt < 1.0 - 1e-9) { sp.step(dts[i]); tt += dts[i]; }
      res.push(sp.x);
    }
    var spread = Math.max.apply(null, res) - Math.min.apply(null, res);
    out.spring = { at: res, spread: spread, converged: Math.abs(res[res.length - 1]) < 1e-3 };
    if (spread > 2e-3) { issues.push('spring is not frame-rate independent (spread ' + spread.toExponential(2) + ')'); out.ok = false; }
    if (!out.spring.converged) { issues.push('spring does not settle to zero within 1s'); out.ok = false; }

    return out;
  }

  /* =========================================================================
     15. INSTALL
     ====================================================================== */
  var didRenderThisFrame = false;

  function install() {
    if (built) return;
    if (!probeGlobals()) throw new Error('game globals not visible (player/WPN/state)');
    THREE = NZ.ctx.THREE || global.THREE;
    if (!THREE) throw new Error('THREE not available');
    if (!NZ.ctx.renderer) throw new Error('renderer not available');
    if (!NZ.tex || !NZ.tex.bake) throw new Error('nz-core texture bakery not available');

    _v = new THREE.Vector3(); _v2 = new THREE.Vector3(); _m = new THREE.Matrix4();

    var t0 = (global.performance && performance.now) ? performance.now() : 0;
    bakeAtlas();
    var t1 = (global.performance && performance.now) ? performance.now() : 0;

    buildScene();
    buildHands();
    buildTracers();

    /* hand nodes: one geometry, instanced mirrored for the support hand */
    handRNode = new THREE.Group(); handRNode.name = 'handR';
    handLNode = new THREE.Group(); handLNode.name = 'handL';
    handR = new THREE.Mesh(HAND.geo, baseMat); handR.frustumCulled = false;
    handR.castShadow = true; handR.receiveShadow = true;
    handL = new THREE.Mesh(HAND.geo, baseMat); handL.frustumCulled = false;
    handL.castShadow = true; handL.receiveShadow = true;
    fingerR = new THREE.Group(); fingerR.name = 'fingerR';
    var fmR = new THREE.Mesh(HAND.finger, baseMat); fmR.frustumCulled = false;
    fmR.castShadow = true; fingerR.add(fmR);
    fingerR.position.set(0.028, 0.018, -0.016);
    fingerL = new THREE.Group(); fingerL.name = 'fingerL';
    var fmL = new THREE.Mesh(HAND.fingerW, baseMat); fmL.frustumCulled = false;
    fmL.castShadow = true; fingerL.add(fmL);
    fingerL.position.set(0.028, 0.018, -0.016);
    armR = new THREE.Group(); armR.name = 'armR';
    armR.position.set(WRIST[0], WRIST[1], WRIST[2]);
    var amR = new THREE.Mesh(HAND.arm, baseMat);
    amR.frustumCulled = false; amR.castShadow = true; armR.add(amR);
    armL = new THREE.Group(); armL.name = 'armL';
    armL.position.set(WRIST[0], WRIST[1], WRIST[2]);
    /* the SUPPORT arm gets the full-length forearm: its wrist is at
       mid-frame, so the short stub's cut end would hang in plain view */
    var amL = new THREE.Mesh(HAND.armLong, baseMat);
    amL.frustumCulled = false; amL.castShadow = true; armL.add(amL);
    handRNode.add(handR); handRNode.add(fingerR); handRNode.add(armR);
    handLNode.add(handL); handLNode.add(fingerL); handLNode.add(armL);

    for (var key in TUNE) {
      WEAPONS[key] = TUNE[key].build(baseMat);
      WEAPONS[key].root.visible = false;
      vmRecoil.add(WEAPONS[key].root);
    }
    var t2 = (global.performance && performance.now) ? performance.now() : 0;

    S = makeState();
    built = true;
    captureGameTuning();
    setWeapon(fin(G.player.weapon, 0));
    bindKeys();

    NZ.log('weapons built: atlas ' + (t1 - t0).toFixed(0) + 'ms, geometry ' + (t2 - t1).toFixed(0) + 'ms');
    if (NZ.debug) {
      var v = verify();
      if (!v.ok) console.warn('[nz-weapons] verify:', v.issues);
      else NZ.log('verify clean');
    }
  }

  /* R reloads, F inspects. Both are cosmetic and both are cancelled by
     anything the player does that matters, so neither can wedge the weapon.
     Registered here rather than in the game so this module stays the only
     thing that knows the viewmodel has animations at all. */
  var keysBound = false;
  function bindKeys() {
    if (keysBound || !global.document) return;
    keysBound = true;
    global.document.addEventListener('keydown', function (e) {
      try {
        if (!built || !NZ.flags.weapons || e.repeat) return;
        var ST = G.state;
        if (!ST || !ST.playing || ST.paused || ST.ended) return;
        if (e.code === 'KeyR') { S.magLeft = 0; startReload(); }
        else if (e.code === 'KeyF') startInspect();
      } catch (err) { panic(err); }
    });
  }

  NZ.on('rendererInit', function (ctx) {
    try {
      THREE = ctx.THREE || global.THREE;
      var r = ctx.renderer;
      if (r) {
        var sz = r.getSize(new THREE.Vector2());
        if (sz.y > 0) aspect = sz.x / sz.y;
      }
    } catch (err) { console.error('[nz-weapons] rendererInit failed:', err); }
  });

  NZ.on('ready', function () {
    try {
      install();
      NZ.flags.weapons = true;
      NZ.log('weapons installed');
    } catch (err) {
      NZ.flags.weapons = false;
      built = false;
      try { restoreGameTuning(); } catch (e2) { }
      console.error('[nz-weapons] install failed, the 2D sprite viewmodel is retained:', err);
    }
  });

  NZ.on('resize', function (w, h) {
    try {
      if (w > 0 && h > 0) { aspect = w / h; setAspect(aspect); }
    } catch (err) { panic(err); }
  });

  /* nz-render fires this right after the world lands in its HDR buffer and
     before TAA / bloom / composite, which is exactly where a viewmodel
     belongs: the muzzle flash gets real bloom and the whole weapon gets the
     same ACES, exposure and grade as the world behind it. */
  NZ.on('scenePass', function (p) {
    if (!built || !NZ.flags.weapons || PANIC > 30) return;
    try {
      var ST = G.state;
      var dt = (ST && !ST.playing) ? 0 : fin(p && p.dt, 0.016);
      update(dt);
      if (p && p.target) setAspect(p.target.width / Math.max(1, p.target.height));
      renderVM(p ? p.target : null, p ? p.camera : null);
      didRenderThisFrame = true;
    } catch (err) { panic(err); }
  });

  /* Fired from drawOverlay, after the frame. This is the fallback path when
     nz-render is absent or has torn itself down. */
  NZ.on('viewmodel', function (dt, w, h) {
    if (!built || !NZ.flags.weapons || PANIC > 30) return;
    try {
      if (!didRenderThisFrame) {
        if (w > 0 && h > 0) setAspect(w / h);
        update(fin(dt, 0.016));
        renderVM(null, null);
      }
      didRenderThisFrame = false;
    } catch (err) { panic(err); }
  });

  /* debug / capture / verification surface */
  NZ.weapons = {
    get ready() { return built; },
    reload: function () { try { if (built) { S.magLeft = 0; startReload(); } } catch (e) { } },
    inspect: function () { try { if (built) startInspect(); } catch (e) { } },
    setShadows: function (on) {
      shadowsOn = !!on;
      if (keyLight) keyLight.castShadow = shadowsOn;
    },
    /* Debug only. Clamped, because every pose in TUNE was SOLVED against
       VM_FOV 50 -- a stray fov=90 from a capture harness would undo the entire
       framing pass and put the weapon back across the crosshair. */
    setFov: function (v) {
      v = clamp(fin(v, VM_FOV), 38, 62);
      VM_FOV = v; VM_FOV_ADS = v - 4;
    },
    setRecoilModel: function (on) {
      RECOIL_ON = !!on;
      if (!RECOIL_ON) restoreGameTuning();
    },
    verify: verify,
    tune: TUNE,
    ballistics: BAL,
    internals: {
      Pile: Pile, addBox: addBox, addLatheZ: addLatheZ, addLoftY: addLoftY, addBone: addBone,
      material: material, REG: REG, M: M, C: C, WEAPONS: WEAPONS,
      builders: {
        pistol: buildPistol, shotgun: buildShotgun, chaingun: buildChaingun,
        rpg: buildRpg, rifle: buildRifle,
        ak: buildAk, m4: buildM4, dmr: buildDmr, nullstar: buildNullstar
      },
      buildMaterials: buildMaterials, patternAt: patternAt, Spring: Spring,
      setThree: function (t) { THREE = t; }
    },
    stats: function () {
      var live = 0, i;
      for (i = 0; i < shells.length; i++) if (shells[i].live) live++;
      var sm = 0;
      for (i = 0; i < smoke.length; i++) if (smoke[i].live) sm++;
      var tr = 0;
      for (i = 0; i < tracers.length; i++) if (tracers[i].live) tr++;
      var tris = 0;
      var A = S && S.asset;
      if (A) for (i = 0; i < A.meshes.length; i++) {
        var g = A.meshes[i].geometry;
        if (g && g.index) tris += g.index.count / 3;
      }
      return {
        weapon: S ? S.cur : -1, tris: tris, shells: live, smoke: sm, tracers: tr,
        drawCalls: (A ? A.meshes.length : 0) + 6 + (live ? 1 : 0) + (sm ? 1 : 0),
        mag: S ? S.magLeft : 0, heat: S ? S.heat : 0,
        sprayIndex: bal.idx, punch: [bal.punchUp, bal.punchRight], panic: PANIC
      };
    }
  };

})(typeof window !== 'undefined' ? window : this);
