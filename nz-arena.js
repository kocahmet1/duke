/* ===========================================================================
   NZ-ARENA -- visual dressing for MISSION 2 "THE CRUCIBLE" (level 2 only).

   ART DECO PASS. The rotunda is dressed as a luminous 1928 grand hall: pale
   smoke marble with gold veining, polished champagne brass, ivory glass and
   malachite accents. On the carved grid this module hangs: telescoping stepped Deco
   pilasters + chevron-leaf infill panels + brass-fan-crowned glowing arch
   niches on every riser wall, black-marble parapets with brass top rails and
   fan infill, a warm white-gold arched clerestory drum with radiating spoke
   mullions, brass-edged rib beams meeting a sunburst oculus collar, gilt
   sunburst/malachite murals, an ivory-marble pit floor with a giant brass
   sunburst medallion, brass torchiere wall sconces on every sconce light, a
   tiered brass-and-amber-glass chandelier over the pit (slow rotation), the
   brass elevator cage, trench portal surrounds, the ref-3 stepped door
   treatment on the exit switch and the red-key door, and the brass spawn
   medallion.

   CONTRACT WITH THE REST OF THE STACK
   - Installs on NZ.on('ready') at priority -60: after nz-render's priority-0
     pass (phong->standard, IBL) and after nz-env's -20 (which auto-hangs
     fixtures on every LIGHTS entry with radius < 30 -- the arena sconces get
     their housings from nz-env, this module must NOT duplicate them), and
     BEFORE nz-render's -1000 sweep (nz-render.js:4237) so that
     neutralizeBakedLighting() remaps our per-vertex light bake through the
     same exposure curve as the rest of the world.
   - Lit cladding materials are therefore named 'nzenv:arena-*'
     (nz-render.js:2282 bakedMatName matches the 'nzenv:' prefix). Emissive
     strips ride MeshBasicMaterial, which that pass skips (nz-render.js:2306),
     so they stay hot.
   - Per-frame animation uses the NZ.first('render') chain (NUKEM.html:8640):
     a listener at priority 30 runs before nz-render's priority-0 frame claim
     and returns undefined so the chain carries on.
   - Placement is DERIVED from the live grid (regAt/floorAt deltas), never
     from a copy of the ARENA-SPEC table, so slice tuning cannot desync it:
       riser wall   = adjacent open cells with floor delta >= 4
       gallery edge = open cell whose neighbour's floor is >= 4 lower
       stair cell   = intermediate floor -> deltas < 4 -> gaps fall out free
   - Level 1: total no-op. Zero scene adds, zero material bakes.

   Budget: <= 26 draw calls (11 used: 8 merged piles + chandelier lit/glass
   + sparkle band), <= 230k tris, textures <= 512, castShadow=false,
   receiveShadow=true, matrixAutoUpdate=false, no per-frame allocations.

   Headless testing: with global NZ_ARENA_TEST truthy the texture bakery is
   bypassed (plain vertex-colour materials), so geometry can be verified in
   node without a DOM. The browser path always bakes.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;

  if (NZ.flags && NZ.flags.arena === undefined) NZ.flags.arena = false;

  var TESTMODE = !!global.NZ_ARENA_TEST;

  /* ---- small utils ------------------------------------------------------ */
  var TAU = Math.PI * 2;
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function warn(msg) { try { console.warn('[nz-arena] ' + msg); } catch (e) {} }

  var THREE = null, scene = null, renderer = null;
  var dead = false, installed = false;
  var G = null;

  var STATS = { calls: 0, tris: 0, verts: 0, bakeMs: 0, geoMs: 0,
                faces: 0, parapets: 0, banners: 0, ribs: 0, struts: 0,
                torchieres: 0, floorCells: 0 };
  var OWN = { geo: [], mat: [], obj: [], tex: [] };

  /* ---- the game's lexical globals (street/env tryGet pattern) ------------
     Top-level let/const in classic scripts live in the shared global lexical
     scope, so a closure here resolves them at call time; anything missing
     throws ReferenceError and tryGet turns that into undefined. */
  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }
  function bindGame() {
    var g = {
      MW: fin(tryGet(function () { return MW; }), 0),
      MH: fin(tryGet(function () { return MH; }), 0),
      CELL: fin(tryGet(function () { return CELL; }), 4),
      S_SOLID: fin(tryGet(function () { return S_SOLID; }), 0),
      S_DOOR: fin(tryGet(function () { return S_DOOR; }), 2),
      S_KEY: fin(tryGet(function () { return S_KEY; }), 3),
      S_SECRET: fin(tryGet(function () { return S_SECRET; }), 4),
      S_EXIT: fin(tryGet(function () { return S_EXIT; }), 5),
      cellAt: tryGet(function () { return cellAt; }) || null,
      isWallCell: tryGet(function () { return isWallCell; }) || null,
      regAt: tryGet(function () { return regAt; }) || null,
      floorAt: tryGet(function () { return floorAt; }) || null,
      inb: tryGet(function () { return inb; }) || null,
      lightAt: tryGet(function () { return lightAt; }) || null,
      liftOf: tryGet(function () { return liftOf; }) || null,
      grid: tryGet(function () { return grid; }) || null,
      LIGHTS: tryGet(function () { return LIGHTS; }) || null,
      LIFTS: tryGet(function () { return LIFTS; }) || null,
      DOORS: tryGet(function () { return DOORS; }) || null,
      SPAWNS: tryGet(function () { return SPAWNS; }) || null
    };
    if (!g.MW || !g.MH || !g.cellAt || !g.regAt || !g.inb || !g.isWallCell) return null;
    return g;
  }

  function liftCell(cx, cy) {
    if (!G.liftOf || !G.inb(cx, cy)) return false;
    return G.liftOf[cy * G.MW + cx] >= 0;
  }
  /* cells this module may treat as dressable open floor: not solid rock, not
     a secret pushwall (dressing would ride the slab or betray it worse than
     the stock wall does), not a door slot, not the express lift car */
  function walkable(cx, cy) {
    if (!G.inb(cx, cy) || G.isWallCell(cx, cy)) return false;
    var t = G.cellAt(cx, cy);
    if (t === G.S_DOOR || t === G.S_KEY) return false;
    if (liftCell(cx, cy)) return false;
    return true;
  }
  function regionAt(cx, cy) {
    if (!G.inb(cx, cy)) return null;
    return G.regAt(cx, cy) || null;
  }

  /* ---- baked point-light sampling (nz-env.js:203 idiom) ------------------
     lightAt() walks every light and raycasts the grid, so it is sampled once
     per emitted polygon, quantised to 0.7 units and six normal buckets. */
  var AMB_FALLBACK = [0.18, 0.18, 0.19];
  var VDESAT = 0.08;
  var _col = [0, 0, 0];
  var LITC = null;
  function litAt(x, y, z, nx, ny, nz, amb) {
    if (!G.lightAt) { _col[0] = 0.5; _col[1] = 0.5; _col[2] = 0.55; return _col; }
    if (!LITC) LITC = new Map();
    var q = 1 / 0.7;
    var nb = (Math.abs(nx) > Math.abs(ny) && Math.abs(nx) > Math.abs(nz)) ? (nx > 0 ? 0 : 1)
           : (Math.abs(ny) >= Math.abs(nz) ? (ny > 0 ? 2 : 3) : (nz > 0 ? 4 : 5));
    var key = ((((Math.round(x * q) + 64) * 1024 + (Math.round(z * q) + 64)) * 512) +
               (Math.round(y * q) + 64)) * 8 + nb;
    var hit = LITC.get(key);
    if (hit !== undefined) { _col[0] = hit[0]; _col[1] = hit[1]; _col[2] = hit[2]; return _col; }
    var c;
    try { c = G.lightAt(x, y, z, nx, ny, nz, amb || AMB_FALLBACK, false, true); }
    catch (e) { _col[0] = _col[1] = _col[2] = 0.5; return _col; }
    _col[0] = fin(c[0], .4); _col[1] = fin(c[1], .4); _col[2] = fin(c[2], .4);
    if (VDESAT > 0) {
      var L = _col[0] * 0.2126 + _col[1] * 0.7152 + _col[2] * 0.0722;
      _col[0] += (L - _col[0]) * VDESAT;
      _col[1] += (L - _col[1]) * VDESAT;
      _col[2] += (L - _col[2]) * VDESAT;
    }
    LITC.set(key, [_col[0], _col[1], _col[2]]);
    return _col;
  }

  /* ======================================================================
     geometry toolkit -- merged piles, one draw call per material
     (nz-env.js:1858 idiom: context carries the region so the light sample
     lands in the right room)
     =================================================================== */
  function Pile() {
    this.p = []; this.nm = []; this.uv = []; this.c = []; this.idx = [];
    this.n = 0;
    this.ctxAmb = AMB_FALLBACK; this.ctxTile = 0.25;
  }
  Pile.prototype.context = function (amb, tile) {
    this.ctxAmb = amb || AMB_FALLBACK;
    this.ctxTile = 1 / (tile || 4);
    return this;
  };
  Pile.prototype.vert = function (x, y, z, nx, ny, nz, u, v, r, g, b) {
    this.p.push(x, y, z); this.nm.push(nx, ny, nz); this.uv.push(u, v);
    this.c.push(r, g, b);
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
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) g.boundingSphere = null;
    OWN.geo.push(g);
    return g;
  };

  /* one planar convex polygon; winding from a reference interior point, UVs
     world-planar on the dominant axis, colour = baked light at the centroid */
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
    var sh = (ao === undefined ? 1 : ao) * (1 - 0.22 * clamp(-ny, 0, 1));
    var col = litAt(cx + nx * 0.28, cy + ny * 0.28, cz + nz * 0.28, nx, ny, nz, pile.ctxAmb);
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

  /* chamfered box (nz-env.js:1958): the thin bright line a chamfer catches is
     what makes trim read as trim rather than blockout */
  function boxC(pile, cx, cy, cz, hx, hy, hz, k, ao) {
    k = Math.min(k, hx * .49, hy * .49, hz * .49);
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

  /* plain box, 12 tris: for members whose chamfer could never read (posts,
     mullions, mid-rails) -- the 44-tri chamfered box is spent where it shows */
  function box6(pile, cx, cy, cz, hx, hy, hz, ao) {
    var x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    poly(pile, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]], cx, cy, cz, ao);
    poly(pile, [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], cx, cy, cz, ao);
    poly(pile, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], cx, cy, cz, ao);
  }

  /* capped tube between two points -- rods, rails, pedestal drum */
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

  /* emissive quad: vertex colour IS the emission, no light sample */
  function glowQuad(pile, pts, r, g, b, nx, ny, nz) {
    var base = pile.n, i;
    for (i = 0; i < 4; i++)
      pile.vert(pts[i][0], pts[i][1], pts[i][2], nx || 0, ny || 1, nz || 0, 0, 0, r, g, b);
    pile.tri(base, base + 1, base + 2);
    pile.tri(base, base + 2, base + 3);
  }

  /* quad with explicit UV rect + baked light -- the banner cloth */
  function texQuad(pile, pts, uvs, nx, ny, nz, amb, shade) {
    var cx = (pts[0][0] + pts[2][0]) / 2, cy = (pts[0][1] + pts[2][1]) / 2, cz = (pts[0][2] + pts[2][2]) / 2;
    var col = litAt(cx + nx * .3, cy + ny * .3, cz + nz * .3, nx, ny, nz, amb);
    var s = shade === undefined ? 1 : shade;
    var base = pile.n, i;
    for (i = 0; i < 4; i++)
      pile.vert(pts[i][0], pts[i][1], pts[i][2], nx, ny, nz, uvs[i][0], uvs[i][1],
                col[0] * s, col[1] * s, col[2] * s);
    pile.tri(base, base + 1, base + 2);
    pile.tri(base, base + 2, base + 3);
  }

  /* emissive n-gon fan: hot centre vert, cooler rim -- the "lit from within"
     gradient every Deco arch in the refs has */
  function glowFan(pile, cx, cy, cz, rim, cCol, rCol, nx, ny, nz) {
    var base = pile.n, i;
    pile.vert(cx, cy, cz, nx, ny, nz, 0, 0, cCol[0], cCol[1], cCol[2]);
    for (i = 0; i < rim.length; i++)
      pile.vert(rim[i][0], rim[i][1], rim[i][2], nx, ny, nz, 0, 0, rCol[0], rCol[1], rCol[2]);
    for (i = 0; i < rim.length - 1; i++) pile.tri(base, base + 1 + i, base + 2 + i);
    /* close the loop -- without this the wedge between the last and first
       rim points is a hole (it read as a dark pyramid in every arch) */
    pile.tri(base, base + rim.length, base + 1);
  }

  /* radiating brass blades -- the sunburst fan (ref 1 arch crown, ref 3 door
     wings). Emitted on a wall face f at local (t0,y0), blades sweep a0..a1. */
  function fanBlades(pile, f, tC, yC, d, r0, r1, n, a0, a1, wIn, wOut) {
    for (var i = 0; i < n; i++) {
      var a = a0 + (a1 - a0) * (i + 0.5) / n;
      var ca = Math.cos(a), sa = Math.sin(a);
      var lng = (i % 2 === 0) ? r1 : r0 + (r1 - r0) * 0.62;   /* long/short alternation */
      var px = -sa, py = ca;                                   /* blade-width direction  */
      var q = [
        pt(f, tC + ca * r0 - px * wIn, yC + sa * r0 - py * wIn, d),
        pt(f, tC + ca * r0 + px * wIn, yC + sa * r0 + py * wIn, d),
        pt(f, tC + ca * lng + px * wOut, yC + sa * lng + py * wOut, d),
        pt(f, tC + ca * lng - px * wOut, yC + sa * lng - py * wOut, d)
      ];
      poly(pile, q, f.mx - f.nx * 2, yC, f.mz - f.nz * 2, 1);
    }
  }

  /* ======================================================================
     materials -- NZ.tex bakes, shared-cache keys prefixed 'arena:'
     =================================================================== */
  var MATS = {};

  function bakeSet(key, specFn) {
    if (TESTMODE || !NZ.tex || !NZ.tex.shared) return null;
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    var set = null;
    try { set = NZ.tex.shared(key, specFn); }
    catch (e) { warn('bake "' + key + '" failed: ' + (e && e.message)); }
    STATS.bakeMs += Math.round(((global.performance && performance.now) ? performance.now() : Date.now()) - t0);
    return set;
  }

  function stdMat(name, set, opts) {
    opts = opts || {};
    var params = {
      vertexColors: true, dithering: true, fog: true,
      roughness: set ? 1.0 : fin(opts.rough, .7),
      metalness: (set && set.metalnessMap) ? 1.0 : fin(opts.metal, 0)
    };
    if (set && NZ.tex && NZ.tex.applySet) NZ.tex.applySet(params, set);
    var m = new THREE.MeshStandardMaterial(params);
    /* The bakery ships anisotropy 8 (nz-core.js:250), tuned for street walls
       seen a few metres away. THIS cladding is read across a 100-unit void
       and along 40-unit floors -- angles oblique enough that 8 taps collapse
       the chevron ribs and the ivory slab joints into moire well before the
       far arcade. 16 is the desktop hardware ceiling, the bakes are 256 px,
       and the maps are shared, so the retune is one flag per texture. */
    var maxA = 16;
    try { maxA = Math.min(16, renderer.capabilities.getMaxAnisotropy() || 16); } catch (eA) {}
    var mapKeys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'];
    for (var mi = 0; mi < mapKeys.length; mi++) {
      var tx = m[mapKeys[mi]];
      if (tx && (tx.anisotropy || 0) < maxA) { tx.anisotropy = maxA; tx.needsUpdate = true; }
    }
    /* 'nzenv:' prefix = baked-lit cladding: nz-render's neutralizeBakedLighting
       remaps our vertex bake through the same curve as the world's */
    m.name = 'nzenv:arena-' + name;
    m.aoMapIntensity = 0.9;
    m.envMapIntensity = fin(opts.env, 1.0);
    if (opts.side !== undefined) m.side = opts.side;
    OWN.mat.push(m);
    MATS[name] = m;
    return m;
  }

  /* gold vein network: jagged polylines, the faint veining ref 1's black
     marble carries. Shared by the marble and noir paints. */
  function paintVeins(g, res, H, n, col, wide) {
    var rnd = H.rnd, i, k;
    for (i = 0; i < n; i++) {
      var x = rnd() * res, y = rnd() * res;
      g.strokeStyle = col; g.lineWidth = (wide ? 1.6 : 1) + rnd() * 1.2;
      g.beginPath(); g.moveTo(x, y);
      var steps = 4 + (rnd() * 5 | 0);
      for (k = 0; k < steps; k++) {
        x += (rnd() - 0.5) * res * 0.3; y += (rnd() - 0.35) * res * 0.22;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }

  function buildMaterials() {
    /* Pale smoke marble, faint gold + white veining.  The veining and polish
       preserve the original Deco read; only the value range has moved out of
       near-black so the architecture remains visible between sconces. */
    var setMarble = bakeSet('arena:marble', function () {
      return {
        res: 256, seed: 421, base: '#8d8b90', grain: .09,
        wear: { amount: .14, colour: '#aaa5a3', cells: 8 },
        rough: { base: .34, variance: .14 },
        metal: { base: .08, variance: .05 },
        normalScale: 0.55, ao: { strength: .35 },
        paint: function (g, res, H) {
          paintVeins(g, res, H, 12, 'rgba(128,92,36,0.20)', false);
          paintVeins(g, res, H, 7, 'rgba(245,239,224,0.22)', false);
          paintVeins(g, res, H, 4, 'rgba(112,78,25,0.24)', true);
        }
      };
    });
    /* polished brass -- trim, fans, rails, cage, chandelier */
    var setBrass = bakeSet('arena:brass', function () {
      return {
        res: 256, seed: 422, base: '#c3a05a', grain: .10,
        wear: { amount: .32, colour: '#ead18e', cells: 12 },
        rough: { base: .26, variance: .14 },
        metal: { base: .96, variance: .04 },
        normalScale: 0.5, ao: { strength: .3 },
        paint: function (g, res, H) {
          /* soft vertical brush streaks */
          var rnd = H.rnd, i;
          for (i = 0; i < 46; i++) {
            var x = rnd() * res, w = 1 + rnd() * 3;
            g.fillStyle = 'rgba(255,232,170,' + (0.03 + rnd() * 0.05).toFixed(3) + ')';
            g.fillRect(x, 0, w, res);
          }
          for (i = 0; i < 18; i++) {
            var x2 = rnd() * res, w2 = 1 + rnd() * 2;
            g.fillStyle = 'rgba(70,50,16,' + (0.05 + rnd() * 0.06).toFixed(3) + ')';
            g.fillRect(x2, 0, w2, res);
          }
        }
      };
    });
    /* Smoke-blue lacquer -- door surrounds, rib beams and fittings retain a
       strong outline without becoming black cut-outs against the hall. */
    var setNoir = bakeSet('arena:noir', function () {
      return {
        res: 256, seed: 423, base: '#555e68', grain: .07,
        wear: { amount: .18, colour: '#737b83', cells: 10 },
        rough: { base: .28, variance: .11 },
        metal: { base: .55, variance: .1 },
        normalScale: 0.45, ao: { strength: .3 },
        paint: function (g, res, H) {
          paintVeins(g, res, H, 5, 'rgba(226,194,124,0.13)', false);
        }
      };
    });
    /* Chevron-leaf relief panel (ref 1 infill): brass leaf-work on warm stone,
       double gold border. One panel per texture, UV 0..1. */
    var setPanel = bakeSet('arena:panel', function () {
      return {
        res: 256, seed: 424, base: '#77736d', grain: .07,
        wear: { amount: 0 },
        rough: { base: .42, variance: .12 },
        metal: { base: .18, variance: .06 },
        normalScale: 1.4, ao: { strength: .4 },
        paint: function (g, res) {
          var cx = res / 2;
          /* double border */
          g.strokeStyle = '#a8853d'; g.lineWidth = 4; g.strokeRect(8, 8, res - 16, res - 16);
          g.strokeStyle = '#5e4a1f'; g.lineWidth = 2; g.strokeRect(17, 17, res - 34, res - 34);
          /* central stem */
          g.strokeStyle = '#8a6a2f'; g.lineWidth = 5;
          g.beginPath(); g.moveTo(cx, 26); g.lineTo(cx, res - 26); g.stroke();
          /* nested chevron leaves climbing the stem, distributed over the
             full height so tall stretched panels keep their rhythm */
          var rows = 7, r;
          for (r = 0; r < rows; r++) {
            var y0 = res * 0.94 - r * res * 0.115;
            var sp = (res * 0.34) * (1 - r * 0.07);
            var lift = res * 0.11;
            var pal = ['#c9a75c', '#8a6a2f', '#b08d3f'];
            for (var k = 0; k < 3; k++) {
              var o = k * 8;
              g.strokeStyle = pal[k]; g.lineWidth = 6 - k;
              g.beginPath();
              g.moveTo(cx - sp + o, y0);
              g.lineTo(cx, y0 - lift + o * 0.5);
              g.lineTo(cx + sp - o, y0);
              g.stroke();
            }
          }
          /* corner fan ticks */
          g.strokeStyle = '#7a5f2a'; g.lineWidth = 3;
          for (var q = 0; q < 4; q++) {
            var ox = (q % 2) ? res - 24 : 24, oy = (q < 2) ? 24 : res - 24;
            g.beginPath(); g.moveTo(ox, oy);
            g.lineTo(ox + ((q % 2) ? -18 : 18), oy + ((q < 2) ? 18 : -18)); g.stroke();
          }
        }
      };
    });
    /* gilt murals, two designs side by side (ref 5): gold sunburst + emerald
       diamonds + checkerboard. UV picks u [0,.5] or [.5,1]. */
    var setMural = bakeSet('arena:mural', function () {
      return {
        res: 512, seed: 425, base: '#686864', grain: .08,
        wear: { amount: 0 },
        rough: { base: .4, variance: .14 },
        metal: { base: .16, variance: .06 },
        normalScale: 0.8, ao: { strength: .3 },
        paint: function (g, res, H) {
          var rnd = H.rnd;
          function foil(x, y, w, h, tone) {
            g.fillStyle = tone; g.fillRect(x, y, w, h);
            for (var i = 0; i < w * h / 90; i++) {
              g.fillStyle = 'rgba(255,236,180,' + (0.04 + rnd() * 0.10).toFixed(3) + ')';
              g.fillRect(x + rnd() * w, y + rnd() * h, 2 + rnd() * 5, 1 + rnd() * 4);
              g.fillStyle = 'rgba(60,40,10,' + (0.05 + rnd() * 0.09).toFixed(3) + ')';
              g.fillRect(x + rnd() * w, y + rnd() * h, 2 + rnd() * 4, 1 + rnd() * 3);
            }
          }
          function diamond(cx, cy, rw, rh) {
            g.beginPath();
            g.moveTo(cx, cy - rh); g.lineTo(cx + rw, cy); g.lineTo(cx, cy + rh); g.lineTo(cx - rw, cy);
            g.closePath();
            var gr = g.createLinearGradient(cx - rw, cy - rh, cx + rw, cy + rh);
            gr.addColorStop(0, '#2f9a63'); gr.addColorStop(.45, '#175c39'); gr.addColorStop(1, '#0d3a24');
            g.fillStyle = gr; g.fill();
            g.strokeStyle = '#c9a75c'; g.lineWidth = 3; g.stroke();
            g.strokeStyle = 'rgba(230,255,240,0.25)'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(cx - rw * .5, cy - rh * .5); g.lineTo(cx + rw * .3, cy + rh * .4); g.stroke();
          }
          function checker(x0, y0, w, h, s) {
            for (var yy = 0; yy < h / s; yy++) for (var xx = 0; xx < w / s; xx++) {
              if ((xx + yy) % 2) continue;
              foil(x0 + xx * s, y0 + yy * s, s, s, '#b08d3f');
            }
          }
          var W2 = res / 2;
          /* ---- panel A: sunburst over arch ---- */
          (function () {
            var cx = W2 / 2, cy = res * 0.66;
            var i, n = 13;
            for (i = 0; i < n; i++) {
              var a = Math.PI * (0.06 + 0.88 * i / (n - 1));
              var r1 = res * (i % 2 ? 0.34 : 0.46);
              var x1 = cx + Math.cos(a) * 26, y1 = cy - Math.sin(a) * 26;
              var x2 = cx + Math.cos(a) * r1, y2 = cy - Math.sin(a) * r1;
              g.strokeStyle = (i % 2) ? '#8a6a2f' : '#c9a75c';
              g.lineWidth = (i % 2) ? 7 : 11;
              g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
            }
            g.beginPath(); g.arc(cx, cy, 30, Math.PI, 0);
            g.fillStyle = '#c9a75c'; g.fill();
            g.beginPath(); g.arc(cx, cy, 19, Math.PI, 0); g.fillStyle = '#464b50'; g.fill();
            /* emerald diamond row under the burst */
            diamond(cx, cy + 42, 26, 34);
            diamond(cx - 52, cy + 42, 16, 22);
            diamond(cx + 52, cy + 42, 16, 22);
            /* checkerboard base band */
            checker(18, res - 74, W2 - 36, 40, 10);
            g.strokeStyle = '#c9a75c'; g.lineWidth = 4;
            g.strokeRect(12, 12, W2 - 24, res - 24);
            g.strokeStyle = '#5e4a1f'; g.lineWidth = 2; g.strokeRect(22, 22, W2 - 44, res - 44);
          })();
          /* ---- panel B: emerald lozenge column + gold chevrons ---- */
          (function () {
            var x0 = W2, cx = W2 + W2 / 2, i;
            checker(x0 + 18, 30, W2 - 36, 30, 10);
            checker(x0 + 18, res - 60, W2 - 36, 30, 10);
            for (i = 0; i < 3; i++) diamond(cx, res * 0.30 + i * res * 0.19, 30, 42);
            for (i = 0; i < 4; i++) {
              var y = res * 0.22 + i * res * 0.19;
              g.strokeStyle = '#b08d3f'; g.lineWidth = 5;
              g.beginPath(); g.moveTo(x0 + 30, y + 26); g.lineTo(x0 + 74, y); g.stroke();
              g.beginPath(); g.moveTo(x0 + W2 - 30, y + 26); g.lineTo(x0 + W2 - 74, y); g.stroke();
            }
            foil(x0 + 26, res * 0.16, 12, res * 0.68, '#8a6a2f');
            foil(x0 + W2 - 38, res * 0.16, 12, res * 0.68, '#8a6a2f');
            g.strokeStyle = '#c9a75c'; g.lineWidth = 4;
            g.strokeRect(x0 + 12, 12, W2 - 24, res - 24);
            g.strokeStyle = '#5e4a1f'; g.lineWidth = 2; g.strokeRect(x0 + 22, 22, W2 - 44, res - 44);
          })();
        }
      };
    });
    /* ivory calacatta marble -- pit floor field, warm cream */
    var setIvory = bakeSet('arena:ivory', function () {
      return {
        res: 256, seed: 426, base: '#d3c4a2', grain: .09,
        wear: { amount: .2, colour: '#bfae8b', cells: 7 },
        rough: { base: .5, variance: .16 },
        metal: { base: 0 },
        normalScale: 0.5, ao: { strength: .3 },
        paint: function (g, res, H) {
          paintVeins(g, res, H, 9, 'rgba(148,132,100,0.16)', true);
          paintVeins(g, res, H, 5, 'rgba(110,96,70,0.10)', false);
          /* slab joints */
          g.strokeStyle = 'rgba(90,80,60,0.35)'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(0, res / 2); g.lineTo(res, res / 2); g.stroke();
          g.beginPath(); g.moveTo(res / 2, 0); g.lineTo(res / 2, res); g.stroke();
        }
      };
    });

    stdMat('marble', setMarble, { env: 1.35, rough: .35, metal: .1 });
    stdMat('brass', setBrass, { env: 1.65, rough: .3, metal: .95 });
    stdMat('noir', setNoir, { env: 1.45, rough: .3, metal: .55 });
    stdMat('panel', setPanel, { env: 0.95, rough: .42, metal: .18, side: THREE.DoubleSide });
    stdMat('mural', setMural, { env: 0.95, rough: .4, metal: .16 });
    var ivory = stdMat('ivory', setIvory, { env: 0.9, rough: .5, metal: 0 });
    /* floor overlays sit 0.045 above world quads; offset is belt to that
       brace (nz-street-ground.js:1012 idiom) */
    ivory.polygonOffset = true; ivory.polygonOffsetFactor = -1; ivory.polygonOffsetUnits = -2;
    /* brass floor inlays ride 0.03 above the ivory with a deeper offset; a
       whisper of emissive keeps the gold legible under the high ceiling */
    var inlay = stdMat('inlay', setBrass, { env: 2.2, rough: .3, metal: .95 });
    inlay.polygonOffset = true; inlay.polygonOffsetFactor = -2; inlay.polygonOffsetUnits = -4;
    inlay.emissive = new THREE.Color(0x4a3518);
    MATS.brass.emissive = new THREE.Color(0x30210e);

    /* emissive: MeshBasicMaterial is skipped by nz-render's bake neutraliser
       (nz-render.js:2306), so vertex colours stay hot */
    var glow = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true,
      side: THREE.DoubleSide, dithering: true });
    glow.name = 'nzenv:arenaglow';
    OWN.mat.push(glow); MATS.glow = glow;

    var holo = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true,
      transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide });
    holo.name = 'nzenv:arenaholo';
    OWN.mat.push(holo); MATS.holo = holo;
  }

  /* ======================================================================
     world scan -- everything below places off THIS, not off spec numbers
     =================================================================== */
  var W = null;   /* { cx, cz, groundF, levels, ceilC, faces, edges, sky } */

  function scanWorld() {
    var C = G.CELL, x, y;

    /* oculus disc: the only sky region; its centroid is the rotunda centre */
    var skyCells = [], skySum = [0, 0];
    var openCells = 0;
    var fHist = new Map(), cHist = new Map();
    for (y = 0; y < G.MH; y++) for (x = 0; x < G.MW; x++) {
      if (!walkable(x, y)) continue;
      openCells++;
      var R = regionAt(x, y); if (!R) continue;
      if (R.sky) { skyCells.push([x, y]); skySum[0] += x; skySum[1] += y; continue; }
      var fk = Math.round(R.f * 2) / 2;
      fHist.set(fk, (fHist.get(fk) || 0) + 1);
      var ck = Math.round(R.c);
      cHist.set(ck, (cHist.get(ck) || 0) + 1);
    }
    if (skyCells.length < 4 || openCells < 200) return null;   /* carve absent */

    var cxCell = skySum[0] / skyCells.length, cyCell = skySum[1] / skyCells.length;
    var cx = (cxCell + 0.5) * C, cz = (cyCell + 0.5) * C;

    var groundF = 1e9;
    fHist.forEach(function (n, f) { if (n >= 6 && f < groundF) groundF = f; });
    if (groundF > 1e8) return null;

    /* gallery floor levels: well-populated floors above ground; stair regions
       are 2 cells each and fall out of the histogram */
    var levels = [];
    fHist.forEach(function (n, f) { if (n >= 6 && f > groundF + 3.5) levels.push(f); });
    levels.sort(function (a, b) { return a - b; });

    /* ring ceiling: the modal high ceiling */
    var ceilC = 40, best = 0;
    cHist.forEach(function (n, c) { if (c >= groundF + 20 && n > best) { best = n; ceilC = c; } });

    /* riser faces: adjacent open cells with floor delta >= 4. Face plane at
       the shared boundary, normal pointing INTO the lower cell. */
    var faces = [], edges = [], skyFaces = [];
    var D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (y = 0; y < G.MH; y++) for (x = 0; x < G.MW; x++) {
      if (!walkable(x, y)) continue;
      var A = regionAt(x, y); if (!A || A.sky) continue;
      for (var d = 0; d < 4; d++) {
        var bx = x + D4[d][0], by = y + D4[d][1];

        /* clerestory drum: open non-sky cell against the sky disc, drum band
           between the ring ceiling and the oculus lid */
        if (G.inb(bx, by) && !G.isWallCell(bx, by)) {
          var B = regionAt(bx, by);
          if (B && B.sky && !A.sky && B.c - A.c >= 3) {
            skyFaces.push(facePlane(x, y, bx, by, A.c, B.c, A));
          }
          if (B && !B.sky && walkable(bx, by)) {
            var dF = B.f - A.f;
            if (dF >= 4) faces.push(facePlane(x, y, bx, by, A.f, B.f, A, B));
            if (-dF >= 4) edges.push(facePlane(x, y, bx, by, B.f, A.f, B, A)); /* A is upper */
          }
        }
      }
    }
    STATS.faces = faces.length;
    if (faces.length < 24) return null;    /* not the arena carve */

    return { C: C, cx: cx, cz: cz, cxCell: cxCell, cyCell: cyCell,
             groundF: groundF, levels: levels, ceilC: ceilC,
             faces: faces, edges: edges, skyFaces: skyFaces, skyCells: skyCells };
  }

  /* face record between lower cell (ax,ay) and upper cell (bx,by).
     mx/mz = face midpoint on the boundary, ux/uz = along-face unit (len CELL),
     nx/nz = horizontal normal into the LOWER cell. */
  function facePlane(ax, ay, bx, by, f0, f1, regLo, regHi) {
    var C = G.CELL;
    var nx = ax - bx, nz = ay - by;                 /* into lower cell */
    var mx, mz, ux, uz;
    if (nx !== 0) {                                  /* boundary plane x=const */
      mx = (Math.max(ax, bx)) * C; mz = ay * C + C / 2;
      ux = 0; uz = 1;
    } else {
      mx = ax * C + C / 2; mz = (Math.max(ay, by)) * C;
      ux = 1; uz = 0;
    }
    return { ax: ax, ay: ay, bx: bx, by: by, f0: f0, f1: f1,
             mx: mx, mz: mz, ux: ux, uz: uz, nx: nx, nz: nz,
             amb: (regLo && regLo.amb) || AMB_FALLBACK,
             ambHi: (regHi && regHi.amb) || AMB_FALLBACK };
  }

  /* ======================================================================
     builders
     =================================================================== */
  var PILES = null;
  var HUG = 0.98;                 /* max protrusion from a wall plane (PRAD 1.15) */
  var AMBER = [1.0, 0.66, 0.30];  /* 2700K sconce amber                      */
  var CHAMP = [1.0, 0.76, 0.42];  /* champagne glass -- arch glow, trim      */
  var CHDIM = [0.30, 0.19, 0.08]; /* champagne rim falloff (stays amber)     */
  var EMER = [0.30, 0.95, 0.55];  /* malachite accent -- trench/lift/key     */
  var NULLCYAN = [0.18, 0.86, 1.0]; /* Nullstar containment field             */
  var CLERE = [1.0, 0.87, 0.58];  /* warm white-gold clerestory              */

  /* telescoping stepped Deco pilaster + chevron-leaf infill + brass-fan
     arch niches on every riser face; double brass trim at each gallery
     floor level so the storeys read as gilt rings across the void */
  function buildRisers() {
    var marble = PILES.marble, brass = PILES.brass, panel = PILES.panel, glow = PILES.glow;
    var i, f;
    for (i = 0; i < W.faces.length; i++) {
      f = W.faces[i];
      marble.context(f.amb, 8);
      brass.context(f.amb, 3);
      panel.context(f.amb, 4);
      var h = f.f1 - f.f0;
      var C = W.C;
      /* face frame: outward = proud of the wall plane into the lower cell */
      var px = f.nx, pz = f.nz;

      /* telescoping half pilasters at both cell seams (adjacent faces
         complete them): wide marble base step, narrower marble mid step,
         and a thin full-height brass blade catching the sconce light */
      var e;
      for (e = -1; e <= 1; e += 2) {
        var ex = f.mx + f.ux * (C / 2) * e, ez = f.mz + f.uz * (C / 2) * e;
        /* base step: widest, shallowest */
        box6(marble,
             ex - f.ux * 0.34 * e + px * 0.19, (f.f0 + f.f1) / 2, ez - f.uz * 0.34 * e + pz * 0.19,
             Math.abs(f.ux) * 0.34 + Math.abs(px) * 0.19 + 0.001,
             h / 2,
             Math.abs(f.uz) * 0.34 + Math.abs(pz) * 0.19 + 0.001, 1);
        /* mid step: narrower, prouder, stops short of the cap */
        box6(marble,
             ex - f.ux * 0.20 * e + px * 0.30, (f.f0 + f.f1 - 0.7) / 2, ez - f.uz * 0.20 * e + pz * 0.30,
             Math.abs(f.ux) * 0.20 + Math.abs(px) * 0.30 + 0.001,
             (h - 0.7) / 2,
             Math.abs(f.uz) * 0.20 + Math.abs(pz) * 0.30 + 0.001, 1);
        /* brass blade: thin, proudest, the vertical gold line of ref 1 */
        box6(brass,
             ex - f.ux * 0.065 * e + px * 0.38, (f.f0 + f.f1 - 1.3) / 2, ez - f.uz * 0.065 * e + pz * 0.38,
             Math.abs(f.ux) * 0.065 + Math.abs(px) * 0.38 + 0.001,
             (h - 1.3) / 2,
             Math.abs(f.uz) * 0.065 + Math.abs(pz) * 0.38 + 0.001, 1);
      }
      /* stepped brass cap at the top edge */
      boxC(brass, f.mx + px * 0.2, f.f1 - 0.12, f.mz + pz * 0.2,
           Math.abs(f.ux) * (C / 2 - 0.03) + Math.abs(px) * 0.24, 0.08,
           Math.abs(f.uz) * (C / 2 - 0.03) + Math.abs(pz) * 0.24, 0.03, 1);
      boxC(brass, f.mx + px * 0.26, f.f1 - 0.30, f.mz + pz * 0.26,
           Math.abs(f.ux) * (C / 2 - 0.42) + Math.abs(px) * 0.20, 0.06,
           Math.abs(f.uz) * (C / 2 - 0.42) + Math.abs(pz) * 0.20, 0.02, 1);

      /* per >= 5.5-unit band segment: fan-crowned glowing arch niches
         ALTERNATE with smoke-stone chevron-leaf panels along the wall (ref 1's
         rhythm: glowing openings separated by dark leaf-work); shorter
         bands always get the panel */
      var alongEven = (((f.ux !== 0) ? f.ax : f.ay) % 2) === 0 && !f._mural;
      var segs = bandSegments(f.f0, f.f1);
      for (var s = 0; s < segs.length; s++) {
        var y0 = segs[s][0], y1 = segs[s][1];
        if (y1 - y0 >= 5.5 && alongEven) nicheOn(f, y0, y1);
        else if (y1 - y0 >= 3.4 && !f._mural) {
          /* chevron-leaf infill between the pilasters */
          var pw2 = C / 2 - 0.62, pb = y0 + 0.55, pt2 = y1 - 0.75;
          if (pt2 - pb > 1.2) {
            texQuad(panel,
              [pt(f, -pw2, pb, 0.06), pt(f, pw2, pb, 0.06),
               pt(f, pw2, pt2, 0.06), pt(f, -pw2, pt2, 0.06)],
              [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]],
              f.nx, 0, f.nz, f.amb, 1);
          }
        }
        /* double brass trim at the segment top = a gallery floor level:
           a lit brass band + a champagne glow line under it */
        box6(brass, f.mx + px * 0.10, y1 - 0.50, f.mz + pz * 0.10,
             Math.abs(f.ux) * (C / 2 - 0.02) + Math.abs(px) * 0.10, 0.045,
             Math.abs(f.uz) * (C / 2 - 0.02) + Math.abs(pz) * 0.10, 1);
        glowStripOn(glow, f, y1 - 0.24, 0.09, 0.10, CHAMP, 1.05);
      }
    }
  }

  /* split [f0,f1] at every gallery level strictly inside */
  function bandSegments(f0, f1) {
    var out = [], last = f0, i, L;
    for (i = 0; i < W.levels.length; i++) {
      L = W.levels[i];
      if (L > f0 + 0.5 && L <= f1 + 0.25) { out.push([last, L]); last = L; }
    }
    if (f1 > last + 0.5) out.push([last, f1]);
    if (!out.length) out.push([f0, f1]);
    return out;
  }

  function nicheOn(f, y0, y1) {
    var marble = PILES.marble, brass = PILES.brass, glow = PILES.glow;
    var px = f.nx, pz = f.nz;
    var w = 0.95;                             /* niche half-width  */
    var sill = y0 + 0.85, spring = y1 - 2.15; /* jamb range        */
    var arcR = w, aSeg = 6;
    var jw = 0.16, proud = 0.2, i, a;

    /* the glow from within (refs 1-2): champagne panel filling the arch,
       hot at the springline centre, fading to the edges */
    var rim = [], panelP = 0.06;
    rim.push(pt(f, -w, sill - 0.15, panelP));
    for (i = 0; i <= aSeg; i++) {
      a = Math.PI * (aSeg - i) / aSeg;        /* pi..0 */
      rim.push(pt(f, Math.cos(a) * arcR, spring + Math.sin(a) * arcR, panelP));
    }
    rim.push(pt(f, w, sill - 0.15, panelP));
    var cP = pt(f, 0, (sill + spring) / 2, panelP);
    glowFan(glow, cP[0], cP[1], cP[2], rim,
            [CHAMP[0] * 1.12, CHAMP[1] * 1.02, CHAMP[2] * 0.92],
            CHDIM,
            px, 0, pz);
    marble.context(f.amb, 8);

    /* marble jambs + sill */
    boxC(marble, f.mx + f.ux * (-w - jw) + px * proud * 0.5, (sill + spring) / 2,
         f.mz + f.uz * (-w - jw) + pz * proud * 0.5,
         Math.abs(f.ux) * jw + Math.abs(px) * proud * 0.5 + 0.001, (spring - sill) / 2 + 0.001,
         Math.abs(f.uz) * jw + Math.abs(pz) * proud * 0.5 + 0.001, 0.04, 1);
    boxC(marble, f.mx + f.ux * (w + jw) + px * proud * 0.5, (sill + spring) / 2,
         f.mz + f.uz * (w + jw) + pz * proud * 0.5,
         Math.abs(f.ux) * jw + Math.abs(px) * proud * 0.5 + 0.001, (spring - sill) / 2 + 0.001,
         Math.abs(f.uz) * jw + Math.abs(pz) * proud * 0.5 + 0.001, 0.04, 1);
    boxC(marble, f.mx + px * proud * 0.55, sill - 0.24, f.mz + pz * proud * 0.55,
         Math.abs(f.ux) * (w + jw * 2) + Math.abs(px) * proud * 0.55 + 0.001, 0.1,
         Math.abs(f.uz) * (w + jw * 2) + Math.abs(pz) * proud * 0.55 + 0.001, 0.03, 1);
    /* brass sill line */
    box6(brass, f.mx + px * proud * 0.6, sill - 0.12, f.mz + pz * proud * 0.6,
         Math.abs(f.ux) * (w + jw * 2) + Math.abs(px) * proud * 0.6, 0.035,
         Math.abs(f.uz) * (w + jw * 2) + Math.abs(pz) * proud * 0.6, 1);

    /* brass arch band following the semicircle */
    brass.context(f.amb, 3);
    for (i = 0; i < aSeg; i++) {
      var a0 = Math.PI * i / aSeg, a1 = Math.PI * (i + 1) / aSeg;
      var q = [
        pt(f, Math.cos(a0) * (arcR + jw * 2), spring + Math.sin(a0) * (arcR + jw * 2), proud),
        pt(f, Math.cos(a0) * arcR, spring + Math.sin(a0) * arcR, proud),
        pt(f, Math.cos(a1) * arcR, spring + Math.sin(a1) * arcR, proud),
        pt(f, Math.cos(a1) * (arcR + jw * 2), spring + Math.sin(a1) * (arcR + jw * 2), proud)
      ];
      poly(brass, q, f.mx - px * 2, spring, f.mz - pz * 2, 1);
    }
    /* the signature move: radiating brass sunburst fan crowning the arch
       (ref 1). Nine blades, long/short alternation, widening outward. */
    fanBlades(brass, f, 0, spring, proud + 0.02,
              arcR + jw * 2 + 0.06, arcR + jw * 2 + 0.55, 9,
              Math.PI * 0.12, Math.PI * 0.88, 0.045, 0.11);
  }

  /* point on a face: t along the face, y up, d proud of the plane */
  function pt(f, t, y, d) {
    return [f.mx + f.ux * t + f.nx * d, y, f.mz + f.uz * t + f.nz * d];
  }

  /* A 0.07-0.09-unit hot line at the 40-60 units the opposite arcade is seen
     from is under a pixel and a half: the raster grid slides across it and it
     STROBES, and no post pass can rebuild a line the rasteriser missed. Two
     changes, both aimed at that: the hot core is held at >= 0.10 units so the
     line survives the distance, and a feather row is added above and below,
     fading to near-marble, so the only hard silhouette the strip shows the
     rasteriser is dark-on-dark. The gradient edge antialiases itself -- the
     same trick the glowFan rims already play with CHDIM -- and the strip
     still reads as a thin lit reveal, not as a fatter bar, because only the
     core carries full emission. */
  function glowStripOn(glow, f, y, hh, d, col, gain) {
    var C = W.C;
    var core = Math.max(hh, 0.10), fth = Math.max(0.055, core * 0.55);
    var t0 = -C / 2 + 0.02, t1 = C / 2 - 0.02;
    var r = col[0] * gain, g = col[1] * gain, b = col[2] * gain;
    /* 7% of the band colour sits within a stop of the marble it hangs on */
    var rows = [
      [y - core / 2 - fth, 0.07], [y - core / 2, 1],
      [y + core / 2, 1], [y + core / 2 + fth, 0.07]
    ];
    var base = glow.n, i, k;
    for (i = 0; i < rows.length; i++) {
      k = rows[i][1];
      var pL = pt(f, t0, rows[i][0], d), pR = pt(f, t1, rows[i][0], d);
      glow.vert(pL[0], pL[1], pL[2], f.nx, 0, f.nz, 0, 0, r * k, g * k, b * k);
      glow.vert(pR[0], pR[1], pR[2], f.nx, 0, f.nz, 0, 0, r * k, g * k, b * k);
    }
    for (i = 0; i < 3; i++) {
      var a = base + i * 2;
      glow.tri(a, a + 1, a + 3); glow.tri(a, a + 3, a + 2);
    }
  }

  /* the tall PERIMETER walls (G3's outer drum wall, the vestibule shell,
     the trench dead-end): solid-rock faces get the same telescoping Deco
     treatment as the risers -- pilaster blades at every seam, chevron-leaf
       panels at eye level, glowing arch rows on the upper storeys, brass +
     champagne trim at each band. This kills the last of the bare concrete.
     Secret pushwalls, doors, the exit switch and hidden pockets are all
     skipped (dressing would betray or bury them). */
  function buildPerimeter() {
    var C = W.C, x, y, d;
    var D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (y = 0; y < G.MH; y++) for (x = 0; x < G.MW; x++) {
      if (!walkable(x, y)) continue;
      var R = regionAt(x, y);
      if (!R || R.sky || R.hidden) continue;
      for (d = 0; d < 4; d++) {
        var bx = x + D4[d][0], by = y + D4[d][1];
        var t = G.inb(bx, by) ? G.cellAt(bx, by) : G.S_SOLID;
        if (t === G.S_SECRET || t === G.S_EXIT || t === G.S_DOOR || t === G.S_KEY) continue;
        if (G.inb(bx, by) && !G.isWallCell(bx, by)) continue;   /* open: not a wall */
        var f = {
          mx: (D4[d][0] > 0 ? (x + 1) * C : D4[d][0] < 0 ? x * C : x * C + C / 2),
          mz: (D4[d][1] > 0 ? (y + 1) * C : D4[d][1] < 0 ? y * C : y * C + C / 2),
          ux: D4[d][0] !== 0 ? 0 : 1, uz: D4[d][0] !== 0 ? 1 : 0,
          nx: -D4[d][0], nz: -D4[d][1],
          ax: x, ay: y, amb: R.amb
        };
        var f0 = R.f, f1 = Math.min(R.c, W.ceilC);
        if (f1 - f0 < 3.4) continue;
        dressPerimeterFace(f, f0, f1);
      }
    }
  }
  function dressPerimeterFace(f, f0, f1) {
    var marble = PILES.marble.context(f.amb, 8);
    var brass = PILES.brass.context(f.amb, 3);
    var panel = PILES.panel.context(f.amb, 4);
    var glow = PILES.glow;
    var C = W.C, px = f.nx, pz = f.nz, e, i;
    var h = f1 - f0;
    /* telescoping half-pilasters at the seams: marble step + brass blade */
    for (e = -1; e <= 1; e += 2) {
      var ex = f.mx + f.ux * (C / 2) * e, ez = f.mz + f.uz * (C / 2) * e;
      box6(marble, ex - f.ux * 0.30 * e + px * 0.16, (f0 + f1) / 2, ez - f.uz * 0.30 * e + pz * 0.16,
           Math.abs(f.ux) * 0.30 + Math.abs(px) * 0.16 + 0.001, h / 2,
           Math.abs(f.uz) * 0.30 + Math.abs(pz) * 0.16 + 0.001, 1);
      box6(brass, ex - f.ux * 0.055 * e + px * 0.24, (f0 + f1 - 1.1) / 2, ez - f.uz * 0.055 * e + pz * 0.24,
           Math.abs(f.ux) * 0.055 + Math.abs(px) * 0.24 + 0.001, (h - 1.1) / 2,
           Math.abs(f.uz) * 0.055 + Math.abs(pz) * 0.24 + 0.001, 1);
    }
    /* stacked bands: split at gallery levels, halve anything over 9 units */
    var segs = bandSegments(f0, f1), bands = [];
    for (i = 0; i < segs.length; i++) {
      var s0 = segs[i][0], s1 = segs[i][1];
      if (s1 - s0 > 9) { bands.push([s0, (s0 + s1) / 2]); bands.push([(s0 + s1) / 2, s1]); }
      else bands.push([s0, s1]);
    }
    var alongEven = (((f.ux !== 0) ? f.ax : f.ay) % 2) === 0;
    for (i = 0; i < bands.length; i++) {
      var y0 = bands[i][0], y1 = bands[i][1];
      /* upper storeys glow; the eye-level band stays panelled (torchieres
         and gameplay live down there) */
      if (y0 >= f0 + 7.9 && y1 - y0 >= 5.5 && alongEven) nicheOn(f, y0, y1);
      else {
        var pw2 = C / 2 - 0.56, pb = y0 + 0.5, pt3 = y1 - 0.7;
        if (pt3 - pb > 1.1) {
          texQuad(panel,
            [pt(f, -pw2, pb, 0.05), pt(f, pw2, pb, 0.05),
             pt(f, pw2, pt3, 0.05), pt(f, -pw2, pt3, 0.05)],
            [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]],
            f.nx, 0, f.nz, f.amb, 1);
        }
      }
      box6(brass, f.mx + px * 0.09, y1 - 0.42, f.mz + pz * 0.09,
           Math.abs(f.ux) * (C / 2 - 0.02) + Math.abs(px) * 0.09, 0.04,
           Math.abs(f.uz) * (C / 2 - 0.02) + Math.abs(pz) * 0.09, 1);
      glowStripOn(glow, f, y1 - 0.20, 0.07, 0.08, CHAMP, 0.9);
    }
  }

  /* knee-high Deco parapet at every gallery void edge: smoke-marble base
     curb, chevron-leaf infill panel, polished brass top rail, brass posts.
     Stair mouths (delta < 4) and the lift shaft never trigger, so the gaps
     come free. Envelope unchanged: nothing prouder than 0.5 into the cell. */
  function buildParapets() {
    var marble = PILES.marble, brass = PILES.brass, panel = PILES.panel;
    var i, e;
    for (i = 0; i < W.edges.length; i++) {
      e = W.edges[i];   /* first cell (ax,ay) is the UPPER one for edges[] */
      var C = W.C;
      var inx = e.nx, inz = e.nz;        /* facePlane n points at its 1st cell */
      marble.context(e.ambHi, 8);
      brass.context(e.ambHi, 3);
      panel.context(e.ambHi, 4);
      var f1 = e.f1;
      var railD = 0.3;                    /* centreline distance from the lip */
      var cxm = e.mx + inx * railD, czm = e.mz + inz * railD;
      /* smoke-marble base curb */
      box6(marble, cxm, f1 + 0.09, czm,
           Math.abs(e.ux) * (C / 2) + Math.abs(inx) * 0.14, 0.09,
           Math.abs(e.uz) * (C / 2) + Math.abs(inz) * 0.14, 1);
      /* chevron-leaf infill panel between curb and rail (DoubleSide) */
      var pw = C / 2 - 0.34, pb = f1 + 0.20, pt3 = f1 + 0.78;
      texQuad(panel,
        [[cxm + e.ux * -pw, pb, czm + e.uz * -pw], [cxm + e.ux * pw, pb, czm + e.uz * pw],
         [cxm + e.ux * pw, pt3, czm + e.uz * pw], [cxm + e.ux * -pw, pt3, czm + e.uz * -pw]],
        [[0.06, 0.30], [0.94, 0.30], [0.94, 0.72], [0.06, 0.72]],
        inx, 0, inz, e.ambHi, 1);
      /* polished brass cap rail */
      boxC(brass, cxm, f1 + 0.88, czm,
           Math.abs(e.ux) * (C / 2) + Math.abs(inx) * 0.09,
           0.065,
           Math.abs(e.uz) * (C / 2) + Math.abs(inz) * 0.09,
           0.03, 1);
      /* brass posts at the cell seams (shared with the neighbouring edge) */
      var s;
      for (s = -1; s <= 1; s += 2) {
        box6(brass, cxm + e.ux * (C / 2 - 0.12) * s, f1 + 0.45, czm + e.uz * (C / 2 - 0.12) * s,
             Math.abs(e.ux) * 0.075 + Math.abs(inx) * 0.11,
             0.45,
             Math.abs(e.uz) * 0.075 + Math.abs(inz) * 0.11, 1);
      }
      /* champagne strip on the VOID face under the cap rail: the storey
         line that carries each gallery across the darkness (theatre-aisle
         warmth, ref 2's horizontal gold bands). Same feathered profile as
         glowStripOn and for the same reason: this line is read from the
         opposite gallery, where 0.1 units is around a pixel and a hard
         bright-on-black edge strobes as the camera moves. The hot core
         keeps the 0.70..0.80 band; the feather rows fade to near-black so
         the silhouette edge carries no contrast. */
      var gw = C / 2 - 0.16, vd = railD - 0.13;
      var vgR = CHAMP[0] * 0.6, vgG = CHAMP[1] * 0.52, vgB = CHAMP[2] * 0.4;
      var vRows = [[f1 + 0.635, 0.07], [f1 + 0.70, 1], [f1 + 0.80, 1], [f1 + 0.865, 0.07]];
      var vBase = PILES.glow.n, vi, vk;
      for (vi = 0; vi < vRows.length; vi++) {
        vk = vRows[vi][1];
        PILES.glow.vert(e.mx + inx * vd - e.ux * gw, vRows[vi][0], e.mz + inz * vd - e.uz * gw,
                        -inx, 0, -inz, 0, 0, vgR * vk, vgG * vk, vgB * vk);
        PILES.glow.vert(e.mx + inx * vd + e.ux * gw, vRows[vi][0], e.mz + inz * vd + e.uz * gw,
                        -inx, 0, -inz, 0, 0, vgR * vk, vgG * vk, vgB * vk);
      }
      for (vi = 0; vi < 3; vi++) {
        var va = vBase + vi * 2;
        PILES.glow.tri(va, va + 1, va + 3); PILES.glow.tri(va, va + 3, va + 2);
      }
      STATS.parapets++;
    }
  }

  /* clerestory drum: one arched frosted panel per cell face, warm white-gold
     glow hot at the springline (ref 1's crowning window), radiating noir
     spoke mullions over the glass, brass sill + head bands, brass mullions
     at the seams. Panels nudged into the sky column so they sit proud of the
     game's own drum wall. */
  function buildClerestory() {
    var glow = PILES.glow, brass = PILES.brass, noir = PILES.noir;
    var i, f;
    for (i = 0; i < W.skyFaces.length; i++) {
      f = W.skyFaces[i];              /* f0 = ring ceiling, f1 = oculus lid */
      var y0 = f.f0 + 0.7, y1 = f.f1 - 0.7;
      if (y1 - y0 < 1.5) continue;
      var d = 0.12;                   /* proud INTO the sky cell (against -n) */
      brass.context(f.amb, 3);
      noir.context(f.amb, 5);
      /* brass sill + head bands */
      boxC(brass, f.mx - f.nx * 0.1, y0 - 0.18, f.mz - f.nz * 0.1,
           Math.abs(f.ux) * (W.C / 2) + Math.abs(f.nx) * 0.16, 0.12,
           Math.abs(f.uz) * (W.C / 2) + Math.abs(f.nz) * 0.16, 0.03, 1);
      boxC(brass, f.mx - f.nx * 0.1, y1 + 0.18, f.mz - f.nz * 0.1,
           Math.abs(f.ux) * (W.C / 2) + Math.abs(f.nx) * 0.16, 0.12,
           Math.abs(f.uz) * (W.C / 2) + Math.abs(f.nz) * 0.16, 0.03, 1);
      /* arched panel: rectangle to the springline, half-arch above, emitted
         as a fan from the bottom-centre so the glow radiates upward */
      var hw = W.C / 2 - 0.32, spring = y1 - (y1 - y0) * 0.42;
      var arcR2 = hw, aSeg2 = 6, rim = [], k;
      rim.push([f.mx + f.ux * -hw - f.nx * d, y0, f.mz + f.uz * -hw - f.nz * d]);
      for (k = 0; k <= aSeg2; k++) {
        var aa = Math.PI * (aSeg2 - k) / aSeg2;
        var tx = Math.cos(aa) * arcR2, ty = Math.min(spring + Math.sin(aa) * arcR2, y1);
        rim.push([f.mx + f.ux * tx - f.nx * d, ty, f.mz + f.uz * tx - f.nz * d]);
      }
      rim.push([f.mx + f.ux * hw - f.nx * d, y0, f.mz + f.uz * hw - f.nz * d]);
      glowFan(glow, f.mx - f.nx * d, y0 + (spring - y0) * 0.55, f.mz - f.nz * d, rim,
              [CLERE[0] * 1.18, CLERE[1] * 1.10, CLERE[2] * 0.98],
              [CLERE[0] * 0.34, CLERE[1] * 0.26, CLERE[2] * 0.16],
              -f.nx, 0, -f.nz);
      /* radiating spoke mullions over the glass (the ref 1 fan window):
         thin flat quads from the springline hub out to the arc */
      var nSp = 5, sI, hubY = y0 + 0.25, dSp = d + 0.03;
      for (sI = 0; sI < nSp; sI++) {
        var sa = Math.PI * (0.16 + 0.68 * sI / (nSp - 1));
        var ex2 = Math.cos(sa) * arcR2 * 0.94;
        var ey2 = Math.min(hubY + Math.sin(sa) * (arcR2 * 0.94 + (spring - hubY)), y1 - 0.08);
        var ddx = ex2, ddy = ey2 - hubY, dl = Math.hypot(ddx, ddy) || 1;
        var wx = -ddy / dl * 0.055, wy = ddx / dl * 0.055;
        var q2 = [
          [f.mx + f.ux * (0 - wx) - f.nx * dSp, hubY - wy, f.mz + f.uz * (0 - wx) - f.nz * dSp],
          [f.mx + f.ux * (0 + wx) - f.nx * dSp, hubY + wy, f.mz + f.uz * (0 + wx) - f.nz * dSp],
          [f.mx + f.ux * (ex2 + wx) - f.nx * dSp, ey2 + wy, f.mz + f.uz * (ex2 + wx) - f.nz * dSp],
          [f.mx + f.ux * (ex2 - wx) - f.nx * dSp, ey2 - wy, f.mz + f.uz * (ex2 - wx) - f.nz * dSp]
        ];
        poly(noir, q2, f.mx + f.nx * 2, (hubY + ey2) / 2, f.mz + f.nz * 2, 1);
      }
      /* brass mullions at the cell seams */
      var mSet = [-W.C / 2 + 0.12, W.C / 2 - 0.12], mI;
      for (mI = 0; mI < 2; mI++) {
        box6(brass, f.mx + f.ux * mSet[mI] - f.nx * 0.05, (y0 + y1) / 2,
             f.mz + f.uz * mSet[mI] - f.nz * 0.05,
             Math.abs(f.ux) * 0.09 + Math.abs(f.nx) * 0.14,
             (y1 - y0) / 2 + 0.1,
             Math.abs(f.uz) * 0.09 + Math.abs(f.nz) * 0.14, 1);
      }
    }
  }

  /* radial rib beams under the ring ceiling, meeting the oculus collar --
     now a stepped brass sunburst ring (the ref 5 halo, horizontal) */
  function buildRibs() {
    var noir = PILES.noir, brass = PILES.brass, glow = PILES.glow;
    var C = W.C;

    /* collar radius: average distance from centre to the drum faces */
    var rSum = 0, i;
    for (i = 0; i < W.skyFaces.length; i++)
      rSum += Math.hypot(W.skyFaces[i].mx - W.cx, W.skyFaces[i].mz - W.cz);
    var collarR = (W.skyFaces.length ? rSum / W.skyFaces.length : 6.5 * C) - 0.35;
    var yTop = W.ceilC - 0.05;
    var yBot = W.ceilC - 1.1;
    W.collarR = collarR; W.collarY = yBot;      /* the chandelier hangs off this */

    /* collar: 32-segment noir ring, brass under-band, champagne glow line,
       and an inward-radiating brass sunburst on the underside plane */
    var SEG = 32, a0, a1, s;
    noir.context(AMB_FALLBACK, 6);
    brass.context(AMB_FALLBACK, 3);
    for (s = 0; s < SEG; s++) {
      a0 = s / SEG * TAU; a1 = (s + 1) / SEG * TAU;
      var iA = [W.cx + Math.cos(a0) * (collarR - 0.35), 0, W.cz + Math.sin(a0) * (collarR - 0.35)];
      var iB = [W.cx + Math.cos(a1) * (collarR - 0.35), 0, W.cz + Math.sin(a1) * (collarR - 0.35)];
      var oA = [W.cx + Math.cos(a0) * (collarR + 0.35), 0, W.cz + Math.sin(a0) * (collarR + 0.35)];
      var oB = [W.cx + Math.cos(a1) * (collarR + 0.35), 0, W.cz + Math.sin(a1) * (collarR + 0.35)];
      var ref = [W.cx + Math.cos((a0 + a1) / 2) * collarR, (yTop + yBot) / 2,
                 W.cz + Math.sin((a0 + a1) / 2) * collarR];
      /* underside, inner and outer skirts */
      poly(noir, [[iA[0], yBot, iA[2]], [iB[0], yBot, iB[2]], [oB[0], yBot, oB[2]], [oA[0], yBot, oA[2]]],
           ref[0], yTop + 1, ref[2], 0.85);
      poly(noir, [[iA[0], yBot, iA[2]], [iA[0], yTop, iA[2]], [iB[0], yTop, iB[2]], [iB[0], yBot, iB[2]]],
           ref[0], ref[1], ref[2], 1);
      poly(noir, [[oA[0], yBot, oA[2]], [oA[0], yTop, oA[2]], [oB[0], yTop, oB[2]], [oB[0], yBot, oB[2]]],
           ref[0], ref[1], ref[2], 1);
      /* brass under-band at the inner lip */
      poly(brass, [
        [W.cx + Math.cos(a0) * (collarR - 0.35), yBot - 0.09, W.cz + Math.sin(a0) * (collarR - 0.35)],
        [W.cx + Math.cos(a1) * (collarR - 0.35), yBot - 0.09, W.cz + Math.sin(a1) * (collarR - 0.35)],
        [W.cx + Math.cos(a1) * (collarR + 0.05), yBot - 0.09, W.cz + Math.sin(a1) * (collarR + 0.05)],
        [W.cx + Math.cos(a0) * (collarR + 0.05), yBot - 0.09, W.cz + Math.sin(a0) * (collarR + 0.05)]
      ], ref[0], yTop + 1, ref[2], 1);
      /* champagne glow line under the collar */
      var g0 = [W.cx + Math.cos(a0) * (collarR - 0.2), yBot - 0.13, W.cz + Math.sin(a0) * (collarR - 0.2)];
      var g1 = [W.cx + Math.cos(a1) * (collarR - 0.2), yBot - 0.13, W.cz + Math.sin(a1) * (collarR - 0.2)];
      var g2 = [W.cx + Math.cos(a1) * (collarR + 0.2), yBot - 0.13, W.cz + Math.sin(a1) * (collarR + 0.2)];
      var g3 = [W.cx + Math.cos(a0) * (collarR + 0.2), yBot - 0.13, W.cz + Math.sin(a0) * (collarR + 0.2)];
      glowQuad(glow, [g0, g1, g2, g3], CHAMP[0] * 1.25, CHAMP[1] * 1.25, CHAMP[2] * 1.25, 0, -1, 0);
      /* sunburst blade radiating inward on the underside plane (every other
         segment long: the ref 5 ray alternation) */
      var am = (a0 + a1) / 2, ca2 = Math.cos(am), sa2 = Math.sin(am);
      var rIn2 = collarR - 0.5, rTip = collarR - ((s % 2) ? 1.15 : 1.85);
      var px2 = -sa2, pz2 = ca2, wA = 0.16, wB = 0.05;
      poly(brass, [
        [W.cx + ca2 * rIn2 - px2 * wA, yBot - 0.02, W.cz + sa2 * rIn2 - pz2 * wA],
        [W.cx + ca2 * rIn2 + px2 * wA, yBot - 0.02, W.cz + sa2 * rIn2 + pz2 * wA],
        [W.cx + ca2 * rTip + px2 * wB, yBot - 0.02, W.cz + sa2 * rTip + pz2 * wB],
        [W.cx + ca2 * rTip - px2 * wB, yBot - 0.02, W.cz + sa2 * rTip - pz2 * wB]
      ], W.cx + ca2 * collarR, yTop + 1, W.cz + sa2 * collarR, 1);
    }

    /* 16 radial ribs: march outward from the collar while the cell is open
       with the ring ceiling overhead; stop at rock, the vestibule or a door */
    var RIBS = 16, k;
    for (k = 0; k < RIBS; k++) {
      var a = k / RIBS * TAU + TAU / (RIBS * 2);
      var dx = Math.cos(a), dz = Math.sin(a);
      var r = collarR + 0.2, rEnd = r, step = C / 2, guard = 0;
      while (guard++ < 80) {
        var wx = W.cx + dx * (rEnd + step), wz = W.cz + dz * (rEnd + step);
        var cxI = Math.floor(wx / C), cyI = Math.floor(wz / C);
        if (!G.inb(cxI, cyI) || G.isWallCell(cxI, cyI)) break;
        var R = regionAt(cxI, cyI);
        if (!R || (!R.sky && R.c < W.ceilC - 0.5)) break;
        rEnd += step;
      }
      rEnd -= 0.3;
      if (rEnd - r < C) { continue; }
      var ax = W.cx + dx * r, az = W.cz + dz * r;
      var bx2 = W.cx + dx * rEnd, bz2 = W.cz + dz * rEnd;
      noir.context(AMB_FALLBACK, 6);
      brass.context(AMB_FALLBACK, 3);
      ribBeam(noir, ax, az, bx2, bz2, yBot, yTop, 0.34);
      /* brass edge strip along the rib underside centreline */
      poly(brass, [
        [ax - dz * 0.09, yBot - 0.02, az + dx * 0.09],
        [ax + dz * 0.09, yBot - 0.02, az - dx * 0.09],
        [bx2 + dz * 0.09, yBot - 0.02, bz2 - dx * 0.09],
        [bx2 - dz * 0.09, yBot - 0.02, bz2 + dx * 0.09]
      ], (ax + bx2) / 2, yTop + 1, (az + bz2) / 2, 1);
      /* faint champagne filament under the brass so the radial structure
         still reads once the hall goes dark between sconce pools. 0.08
         units wide over a 30-unit run 25 units overhead was the worst
         strobing wire in the hall: feather it like glowStripOn -- hot core
         held near the original width, edge rails fading to near-black, so
         its silhouette carries no contrast for the raster grid to chew. */
      var fRails = [[-0.10, 0.07], [-0.045, 1], [0.045, 1], [0.10, 0.07]];
      var fR = CHAMP[0] * 0.5, fG = CHAMP[1] * 0.44, fB = CHAMP[2] * 0.34;
      var fBase = glow.n, fj, fk;
      for (fj = 0; fj < fRails.length; fj++) {
        var fo = fRails[fj][0]; fk = fRails[fj][1];
        glow.vert(ax - dz * fo, yBot - 0.04, az + dx * fo, 0, -1, 0, 0, 0, fR * fk, fG * fk, fB * fk);
        glow.vert(bx2 - dz * fo, yBot - 0.04, bz2 + dx * fo, 0, -1, 0, 0, 0, fR * fk, fG * fk, fB * fk);
      }
      for (fj = 0; fj < 3; fj++) {
        var fa = fBase + fj * 2;
        glow.tri(fa, fa + 1, fa + 3); glow.tri(fa, fa + 3, fa + 2);
      }
      STATS.ribs++;
    }
  }

  /* a beam as an axis-arbitrary box: underside + two skirts (top face is
     buried in the ceiling; not emitted) */
  function ribBeam(pile, ax, az, bx, bz, yBot, yTop, hw) {
    var dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    var px = -dz / L * hw, pz = dx / L * hw;
    var mx = (ax + bx) / 2, mz = (az + bz) / 2, my = (yBot + yTop) / 2;
    poly(pile, [[ax + px, yBot, az + pz], [bx + px, yBot, bz + pz],
                [bx - px, yBot, bz - pz], [ax - px, yBot, az - pz]],
         mx, yTop + 0.5, mz, 0.85);
    poly(pile, [[ax + px, yBot, az + pz], [ax + px, yTop, az + pz],
                [bx + px, yTop, bz + pz], [bx + px, yBot, bz + pz]],
         mx, my, mz, 1);
    poly(pile, [[ax - px, yBot, az - pz], [ax - px, yTop, az - pz],
                [bx - px, yTop, bz - pz], [bx - px, yBot, bz - pz]],
         mx, my, mz, 1);
    /* end cap at the collar side */
    poly(pile, [[ax + px, yBot, az + pz], [ax - px, yBot, az - pz],
                [ax - px, yTop, az - pz], [ax + px, yTop, az + pz]],
         mx, my, mz, 1);
  }

  /* 4-6 gilt murals on the G2/G3 risers, spread around the hall, never at a
     stair mouth: brass-framed sunburst / malachite panels (ref 5) */
  function buildMurals() {
    var cands = [], i, f;
    for (i = 0; i < W.faces.length; i++) {
      f = W.faces[i];
      if (f.f1 - f.f0 < 7.5) continue;          /* only full-storey risers    */
      if (f.f1 < (W.levels[1] || 14)) continue; /* G2/G3 (+ tall trench) only */
      if (nearStair(f)) continue;
      cands.push(f);
    }
    if (!cands.length) return;
    cands.sort(function (a, b) { return angOf(a) - angOf(b); });
    var picked = [], want = Math.min(6, cands.length);
    var lastA = -9;
    for (i = 0; i < cands.length && picked.length < want; i++) {
      var aa = angOf(cands[i]);
      if (picked.length && Math.abs(aa - lastA) < TAU / 9) continue;
      picked.push(cands[i]); lastA = aa;
    }
    var mural = PILES.mural, brass = PILES.brass, noir = PILES.noir;
    for (i = 0; i < picked.length; i++) {
      f = picked[i];
      f._mural = true;               /* buildRisers keeps its arch off this face */
      mural.context(f.amb, 4); brass.context(f.amb, 3); noir.context(f.amb, 5);
      var col = i % 2;                                   /* design column */
      var u0 = col * 0.5 + 0.012, u1 = (col + 1) * 0.5 - 0.012;
      var w = 1.15, top = f.f1 - 1.05, bot = Math.max(f.f0 + 1.3, top - 4.4);
      var dP = 0.24;
      /* noir backing slab, slightly larger than the canvas */
      box6(noir, f.mx + f.nx * (dP - 0.10) / 2 + f.nx * 0.05, (top + bot) / 2, f.mz + f.nz * (dP - 0.10) / 2 + f.nz * 0.05,
           Math.abs(f.ux) * (w + 0.22) + Math.abs(f.nx) * (dP - 0.10) / 2,
           (top - bot) / 2 + 0.22,
           Math.abs(f.uz) * (w + 0.22) + Math.abs(f.nz) * (dP - 0.10) / 2, 1);
      /* the gilt canvas */
      texQuad(mural,
        [pt(f, -w, bot, dP), pt(f, w, bot, dP), pt(f, w, top, dP), pt(f, -w, top, dP)],
        [[u0, 0.03], [u1, 0.03], [u1, 0.97], [u0, 0.97]],
        f.nx, 0, f.nz, f.amb, 1);
      /* brass frame: two side stiles, head + sill rails, stepped pediment */
      var fr = 0.09;
      for (var e2 = -1; e2 <= 1; e2 += 2) {
        box6(brass, f.mx + f.ux * (w + 0.10) * e2 + f.nx * dP / 2 + f.nx * 0.03,
             (top + bot) / 2, f.mz + f.uz * (w + 0.10) * e2 + f.nz * dP / 2 + f.nz * 0.03,
             Math.abs(f.ux) * fr + Math.abs(f.nx) * (dP / 2 + 0.03),
             (top - bot) / 2 + 0.14,
             Math.abs(f.uz) * fr + Math.abs(f.nz) * (dP / 2 + 0.03), 1);
      }
      box6(brass, f.mx + f.nx * dP / 2 + f.nx * 0.03, top + 0.12, f.mz + f.nz * dP / 2 + f.nz * 0.03,
           Math.abs(f.ux) * (w + 0.19) + Math.abs(f.nx) * (dP / 2 + 0.03), fr,
           Math.abs(f.uz) * (w + 0.19) + Math.abs(f.nz) * (dP / 2 + 0.03), 1);
      box6(brass, f.mx + f.nx * dP / 2 + f.nx * 0.03, bot - 0.12, f.mz + f.nz * dP / 2 + f.nz * 0.03,
           Math.abs(f.ux) * (w + 0.19) + Math.abs(f.nx) * (dP / 2 + 0.03), fr,
           Math.abs(f.uz) * (w + 0.19) + Math.abs(f.nz) * (dP / 2 + 0.03), 1);
      /* stepped pediment cap */
      box6(brass, f.mx + f.nx * 0.14, top + 0.30, f.mz + f.nz * 0.14,
           Math.abs(f.ux) * (w * 0.55) + Math.abs(f.nx) * 0.14, 0.055,
           Math.abs(f.uz) * (w * 0.55) + Math.abs(f.nz) * 0.14, 1);
      STATS.banners++;
    }
  }
  function angOf(f) { return Math.atan2(f.mz - W.cz, f.mx - W.cx); }
  /* a stair is a region with intermediate floor: any 8-neighbour of the face's
     two cells whose floor sits strictly between the face's bands */
  function nearStair(f) {
    var cells = [[f.ax, f.ay], [f.bx, f.by]], i, dx, dy;
    for (i = 0; i < 2; i++) {
      for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) {
        var x = cells[i][0] + dx, y = cells[i][1] + dy;
        if (!walkable(x, y)) continue;
        var R = regionAt(x, y);
        if (!R || R.sky) continue;
        if (R.f > f.f0 + 0.6 && R.f < f.f1 - 0.6 && !isLevelF(R.f)) return true;
      }
    }
    return false;
  }
  function isLevelF(fv) {
    if (Math.abs(fv - W.groundF) < 0.6) return true;
    for (var i = 0; i < W.levels.length; i++) if (Math.abs(fv - W.levels[i]) < 0.6) return true;
    return false;
  }

  /* teleporter spawn pad: brass sunburst floor medallion (ref 5) with a
     champagne glow ring, smoke-marble surround, <= 0.4 tall */
  function buildSpawnPad() {
    var sp = findSpawn('player');
    if (!sp) return;
    var C = W.C;
    var x = sp.x * C + C / 2, z = sp.y * C + C / 2;
    var R = regionAt(sp.x, sp.y);
    var f = R ? R.f : W.groundF;
    var marble = PILES.marble.context(R ? R.amb : null, 4);
    var inlay = PILES.inlay.context(R ? R.amb : null, 3);
    var glow = PILES.glow;
    var i, a0, a1;

    /* brass sunburst: 16 rays, long/short alternation, on the inlay layer */
    for (i = 0; i < 16; i++) {
      var ra = i / 16 * TAU, ca = Math.cos(ra), sa = Math.sin(ra);
      var tip = (i % 2) ? 1.06 : 1.5;
      var px2 = -sa, pz2 = ca;
      poly(inlay, [
        [x + ca * 0.34 - px2 * 0.10, f + 0.085, z + sa * 0.34 - pz2 * 0.10],
        [x + ca * 0.34 + px2 * 0.10, f + 0.085, z + sa * 0.34 + pz2 * 0.10],
        [x + ca * tip + px2 * 0.03, f + 0.085, z + sa * tip + pz2 * 0.03],
        [x + ca * tip - px2 * 0.03, f + 0.085, z + sa * tip - pz2 * 0.03]
      ], x, f - 1, z, 1);
    }
    /* centre brass boss */
    var SEG = 16, base2 = inlay.n;
    for (i = 0; i < SEG; i++) {
      a0 = i / SEG * TAU; a1 = (i + 1) / SEG * TAU;
      poly(inlay, [
        [x, f + 0.085, z],
        [x + Math.cos(a0) * 0.26, f + 0.085, z + Math.sin(a0) * 0.26],
        [x + Math.cos(a1) * 0.26, f + 0.085, z + Math.sin(a1) * 0.26]
      ], x, f - 1, z, 1);
    }
    void base2;

    /* champagne glow ring between rays and surround */
    for (i = 0; i < SEG; i++) {
      a0 = i / SEG * TAU; a1 = (i + 1) / SEG * TAU;
      glowQuad(glow, [
        [x + Math.cos(a0) * 1.58, f + 0.095, z + Math.sin(a0) * 1.58],
        [x + Math.cos(a1) * 1.58, f + 0.095, z + Math.sin(a1) * 1.58],
        [x + Math.cos(a1) * 1.78, f + 0.095, z + Math.sin(a1) * 1.78],
        [x + Math.cos(a0) * 1.78, f + 0.095, z + Math.sin(a0) * 1.78]
      ], CHAMP[0] * 1.5, CHAMP[1] * 1.5, CHAMP[2] * 1.5, 0, 1, 0);
    }

    /* smoke-marble surround: flat annulus + 4 brass lugs + champagne ticks */
    var rIn = 1.82, rOut = 2.05;
    for (i = 0; i < SEG; i++) {
      a0 = i / SEG * TAU; a1 = (i + 1) / SEG * TAU;
      poly(marble, [
        [x + Math.cos(a0) * rIn, f + 0.12, z + Math.sin(a0) * rIn],
        [x + Math.cos(a1) * rIn, f + 0.12, z + Math.sin(a1) * rIn],
        [x + Math.cos(a1) * rOut, f + 0.12, z + Math.sin(a1) * rOut],
        [x + Math.cos(a0) * rOut, f + 0.12, z + Math.sin(a0) * rOut]
      ], x, f - 1, z, 1);
      poly(marble, [
        [x + Math.cos(a0) * rOut, f + 0.12, z + Math.sin(a0) * rOut],
        [x + Math.cos(a1) * rOut, f + 0.12, z + Math.sin(a1) * rOut],
        [x + Math.cos(a1) * rOut, f + 0.01, z + Math.sin(a1) * rOut],
        [x + Math.cos(a0) * rOut, f + 0.01, z + Math.sin(a0) * rOut]
      ], x, f, z, 0.9);
    }
    var brass = PILES.brass.context(R ? R.amb : null, 3);
    for (i = 0; i < 4; i++) {
      var la = i / 4 * TAU + TAU / 8;
      boxC(brass, x + Math.cos(la) * 1.92, f + 0.20, z + Math.sin(la) * 1.92,
           0.20, 0.14, 0.20, 0.05, 1);
      var g0 = la - 0.09, g1 = la + 0.09;
      glowQuad(glow, [
        [x + Math.cos(g0) * 1.78, f + 0.30, z + Math.sin(g0) * 1.78],
        [x + Math.cos(g1) * 1.78, f + 0.30, z + Math.sin(g1) * 1.78],
        [x + Math.cos(g1) * 2.02, f + 0.30, z + Math.sin(g1) * 2.02],
        [x + Math.cos(g0) * 2.02, f + 0.30, z + Math.sin(g0) * 2.02]
      ], CHAMP[0] * 1.6, CHAMP[1] * 1.6, CHAMP[2] * 1.6, 0, 1, 0);
    }
  }

  function findSpawn(kind) {
    if (!G.SPAWNS) return null;
    for (var i = 0; i < G.SPAWNS.length; i++)
      if (G.SPAWNS[i] && G.SPAWNS[i].kind === kind) return G.SPAWNS[i];
    return null;
  }

  /* key pedestal on the G3 east lip -- smoke-marble drum, brass column,
     malachite glow (the emerald accent lives at trench/lift/key only) */
  function buildKeyPedestal() {
    var sp = findSpawn('keyred');
    if (!sp) return;
    var C = W.C;
    var x = sp.x * C + C / 2, z = sp.y * C + C / 2;
    var R = regionAt(sp.x, sp.y);
    var f = (R && !liftCell(sp.x, sp.y)) ? R.f : (G.floorAt ? G.floorAt(sp.x, sp.y) : 24);
    var marble = PILES.marble.context(R ? R.amb : null, 4);
    var brass = PILES.brass.context(R ? R.amb : null, 3);
    var glow = PILES.glow;
    /* stepped marble drum so the pickup floats clear: total 0.46 */
    boxC(marble, x, f + 0.07, z, 0.66, 0.07, 0.66, 0.03, 1);
    boxC(marble, x, f + 0.17, z, 0.52, 0.06, 0.52, 0.03, 1);
    tube(brass, x, f + 0.22, z, x, f + 0.46, z, 0.36, 8, 1, true);
    /* emerald floor ring + 4 ticks */
    var SEG = 12, i;
    for (i = 0; i < SEG; i++) {
      var a0 = i / SEG * TAU, a1 = (i + 1) / SEG * TAU;
      glowQuad(glow, [
        [x + Math.cos(a0) * 0.95, f + 0.04, z + Math.sin(a0) * 0.95],
        [x + Math.cos(a1) * 0.95, f + 0.04, z + Math.sin(a1) * 0.95],
        [x + Math.cos(a1) * 1.2, f + 0.04, z + Math.sin(a1) * 1.2],
        [x + Math.cos(a0) * 1.2, f + 0.04, z + Math.sin(a0) * 1.2]
      ], EMER[0] * 1.6, EMER[1] * 1.6, EMER[2] * 1.6, 0, 1, 0);
    }
    /* glow crown under the pickup */
    glowQuad(glow, [
      [x - 0.3, f + 0.48, z - 0.3], [x + 0.3, f + 0.48, z - 0.3],
      [x + 0.3, f + 0.48, z + 0.3], [x - 0.3, f + 0.48, z + 0.3]
    ], EMER[0] * 2.0, EMER[1] * 2.0, EMER[2] * 2.0, 0, 1, 0);
  }

  /* Nullstar dais in the oculus: a broad, low containment altar rather than
     the key's small column. The spawn record is the single source of truth,
     so map tuning cannot leave this set-piece behind. Black-marble octagons
     step up into eight brass locking rails; nested cyan/malachite rings and a
     hot crown make the weapon read from either court entrance. */
  function buildNullstarDais() {
    var sp = findSpawn('wnullstar');
    if (!sp) return;
    var C = W.C;
    var x = sp.x * C + C / 2, z = sp.y * C + C / 2;
    var R = regionAt(sp.x, sp.y);
    var f = (R && !liftCell(sp.x, sp.y)) ? R.f :
      (G.floorAt ? G.floorAt(sp.x, sp.y) : W.groundF);
    var marble = PILES.marble.context(R ? R.amb : null, 4);
    var brass = PILES.brass.context(R ? R.amb : null, 3);
    var glow = PILES.glow;
    var SEG = 20, i;

    /* Three octagonal black-marble steps give it the mass of an altar while
       staying low enough that the floating pickup remains completely legible. */
    tube(marble, x, f + 0.02, z, x, f + 0.16, z, 1.62, 12, 0.94, true);
    tube(marble, x, f + 0.16, z, x, f + 0.31, z, 1.31, 12, 0.98, true);
    tube(marble, x, f + 0.31, z, x, f + 0.45, z, 1.02, 12, 1.00, true);

    /* Eight radial brass clamps converge on the field without becoming a
       cage: alternating long/short rails preserve the Deco sunburst rhythm. */
    for (i = 0; i < 8; i++) {
      var a = i / 8 * TAU + TAU / 16;
      var ca = Math.cos(a), sa = Math.sin(a);
      var outer = (i % 2) ? 1.18 : 1.34;
      var inner = 0.48;
      tube(brass,
        x + ca * outer, f + 0.48, z + sa * outer,
        x + ca * inner, f + 0.57, z + sa * inner,
        0.055, 6, 1, true);
      /* Upright locking tooth at the weapon end of each rail. */
      tube(brass,
        x + ca * inner, f + 0.48, z + sa * inner,
        x + ca * inner, f + 0.76, z + sa * inner,
        0.075, 6, 1, true);
    }

    function energyRing(r0, r1, y, col, power) {
      for (var j = 0; j < SEG; j++) {
        var a0 = j / SEG * TAU, a1 = (j + 1) / SEG * TAU;
        glowQuad(glow, [
          [x + Math.cos(a0) * r0, y, z + Math.sin(a0) * r0],
          [x + Math.cos(a1) * r0, y, z + Math.sin(a1) * r0],
          [x + Math.cos(a1) * r1, y, z + Math.sin(a1) * r1],
          [x + Math.cos(a0) * r1, y, z + Math.sin(a0) * r1]
        ], col[0] * power, col[1] * power, col[2] * power, 0, 1, 0);
      }
    }

    /* The cyan perimeter is visible before the player enters the oculus; the
       emerald inner circuit ties it back to the Crucible's alien machinery. */
    energyRing(1.72, 1.96, f + 0.035, NULLCYAN, 1.65);
    energyRing(1.17, 1.40, f + 0.47, EMER, 1.45);
    energyRing(0.66, 0.84, f + 0.59, NULLCYAN, 2.05);

    /* Gradient crown immediately under the pickup, plus four translucent
       energy vanes that imply a containment field without hiding the gun. */
    var rim = [];
    for (i = 0; i < 12; i++) {
      var ar = i / 12 * TAU;
      rim.push([x + Math.cos(ar) * 0.56, f + 0.60, z + Math.sin(ar) * 0.56]);
    }
    glowFan(glow, x, f + 0.605, z, rim,
      [NULLCYAN[0] * 2.7, NULLCYAN[1] * 2.7, NULLCYAN[2] * 2.7],
      [EMER[0] * 0.75, EMER[1] * 0.75, EMER[2] * 0.75], 0, 1, 0);
    for (i = 0; i < 4; i++) {
      var av = i / 4 * TAU + TAU / 8;
      var ux = Math.cos(av), uz = Math.sin(av);
      var tx = -uz * 0.09, tz = ux * 0.09;
      glowQuad(glow, [
        [x + ux * 0.53 - tx, f + 0.60, z + uz * 0.53 - tz],
        [x + ux * 0.53 + tx, f + 0.60, z + uz * 0.53 + tz],
        [x + ux * 0.31 + tx, f + 1.02, z + uz * 0.31 + tz],
        [x + ux * 0.31 - tx, f + 1.02, z + uz * 0.31 - tz]
      ], NULLCYAN[0] * 1.65, NULLCYAN[1] * 1.65, NULLCYAN[2] * 1.65,
      ux, 0, uz);
    }
  }

  /* lift shaft as a brass elevator cage: corner rails, horizontal band
     rhythm, malachite deco chevrons on the solid shaft walls */
  function buildLift() {
    if (!G.LIFTS || !G.LIFTS.length) return;
    var C = W.C, brass = PILES.brass, glow = PILES.glow;
    for (var li = 0; li < G.LIFTS.length; li++) {
      var L = G.LIFTS[li];
      if (!isFinite(L.lo) || !isFinite(L.hi) || L.hi - L.lo < 4) continue;
      var x0 = L.x0 * C, x1 = (L.x1 + 1) * C, z0 = L.y0 * C, z1 = (L.y1 + 1) * C;
      brass.context(AMB_FALLBACK, 5);
      /* brass guide rails hug the shaft corners INSIDE the 2% gap the car
         leaves (makeLiftMeshes: BoxGeometry(w*.96) -> 0.16 clear) */
      var inset = 0.08, yTop = Math.min(L.hi + 8, W.ceilC - 1);
      var corners = [[x0 + inset, z0 + inset], [x1 - inset, z0 + inset],
                     [x1 - inset, z1 - inset], [x0 + inset, z1 - inset]];
      for (var k = 0; k < 4; k++) {
        box6(brass, corners[k][0], (L.lo + yTop) / 2, corners[k][1],
             0.06, (yTop - L.lo) / 2, 0.06, 1);
      }
      /* cage sides: chevrons + horizontal brass bands on walls backed by
         solid cells, at both storeys */
      var sides = [
        { cx: (L.x0 + L.x1) / 2, cy: L.y0 - 1, mx: (x0 + x1) / 2, mz: z0, ux: 1, uz: 0, nx: 0, nz: 1 },
        { cx: (L.x0 + L.x1) / 2, cy: L.y1 + 1, mx: (x0 + x1) / 2, mz: z1, ux: 1, uz: 0, nx: 0, nz: -1 },
        { cx: L.x0 - 1, cy: (L.y0 + L.y1) / 2, mx: x0, mz: (z0 + z1) / 2, ux: 0, uz: 1, nx: 1, nz: 0 },
        { cx: L.x1 + 1, cy: (L.y0 + L.y1) / 2, mx: x1, mz: (z0 + z1) / 2, ux: 0, uz: 1, nx: -1, nz: 0 }
      ];
      var halfW = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)) / 2 - 0.15;
      for (var s = 0; s < sides.length; s++) {
        var sd = sides[s];
        if (!G.inb(Math.round(sd.cx), Math.round(sd.cy))) continue;
        if (!G.isWallCell(Math.round(sd.cx), Math.round(sd.cy))) continue;  /* open side = a doorway */
        decoVees(glow, sd, L.lo + 2.7, EMER, 1.35);
        decoVees(glow, sd, L.hi + 2.7, EMER, 1.35);
        /* horizontal brass cage bands every 4 units up the shaft */
        for (var by = L.lo + 4; by < yTop - 0.5; by += 4) {
          box6(brass, sd.mx + sd.nx * 0.07, by, sd.mz + sd.nz * 0.07,
               Math.abs(sd.ux) * halfW + Math.abs(sd.nx) * 0.05, 0.055,
               Math.abs(sd.uz) * halfW + Math.abs(sd.nz) * 0.05, 1);
        }
        STATS.struts++;
      }
    }
  }
  /* nested Deco V-chevrons (ref 3's side pilasters): three chevrons pointing
     up, drawn as mirrored strip pairs on the glow pile */
  function decoVees(glow, sd, y, col, gain) {
    var n = 3, hw = 1.15, sh = 0.62, th = 0.16, d = 0.09, i;
    for (i = 0; i < n; i++) {
      var yb = y - 0.95 + i * 0.62;
      for (var m = -1; m <= 1; m += 2) {
        var q = [
          [sd.mx + sd.ux * 0 + sd.nx * d, yb + sh, sd.mz + sd.uz * 0 + sd.nz * d],
          [sd.mx + sd.ux * (th * m) + sd.nx * d, yb + sh, sd.mz + sd.uz * (th * m) + sd.nz * d],
          [sd.mx + sd.ux * (hw * m + th * m) + sd.nx * d, yb, sd.mz + sd.uz * (hw * m + th * m) + sd.nz * d],
          [sd.mx + sd.ux * (hw * m) + sd.nx * d, yb, sd.mz + sd.uz * (hw * m) + sd.nz * d]
        ];
        glowQuad(glow, q, col[0] * gain, col[1] * gain, col[2] * gain, sd.nx, 0, sd.nz);
      }
    }
  }

  /* trench portal struts: opposite tall riser faces a few cells apart frame
     the canyon; every other cell gets posts + a lintel beam overhead */
  function buildStruts() {
    var done = {}, i, f;
    for (i = 0; i < W.faces.length; i++) {
      f = W.faces[i];
      if (f.f1 - f.f0 < 6) continue;
      /* march along the face normal over floor-level cells looking for the
         opposite canyon wall */
      var span = 0, ox = f.ax, oy = f.ay, hit = null;
      while (span < 4) {
        ox += f.nx; oy += f.nz;
        span++;
        if (!walkable(ox, oy)) break;
        var R = regionAt(ox, oy);
        if (!R || Math.abs(R.f - f.f0) > 1.5) break;
        /* does this cell have a riser face on the far side (opposite normal)? */
        var fx = ox + f.nx, fy = oy + f.nz;
        if (walkable(fx, fy)) {
          var RF = regionAt(fx, fy);
          if (RF && !RF.sky && RF.f - R.f >= 6) { hit = { x: ox, y: oy, span: span }; break; }
        }
      }
      if (!hit) continue;
      /* dedupe: one strut per along-axis cell, every other cell */
      var alongCell = (f.ux !== 0) ? f.ax : f.ay;
      if (alongCell % 2) continue;
      var key = (f.ux !== 0 ? 'x' : 'z') + alongCell + ':' + Math.min(f.ay, hit.y) + ':' + Math.min(f.ax, hit.x);
      if (done[key]) continue;
      done[key] = 1;

      var C = W.C;
      var marble = PILES.marble.context(f.amb, 8);
      var brass = PILES.brass.context(f.amb, 3);
      var w0 = [f.mx, f.mz];
      var w1 = [f.mx + f.nx * (hit.span + 1) * C, f.mz + f.nz * (hit.span + 1) * C];
      var yB = f.f0 + 11.2;
      /* telescoping marble portal posts hug each wall plane, brass blade on
         the canyon face */
      for (var pI = 0; pI < 2; pI++) {
        var sgn = pI === 0 ? 1 : -1;
        var wx2 = pI === 0 ? w0[0] : w1[0], wz2 = pI === 0 ? w0[1] : w1[1];
        boxC(marble, wx2 + f.nx * sgn * 0.34, (f.f0 + yB) / 2, wz2 + f.nz * sgn * 0.34,
             0.30, (yB - f.f0) / 2 + 0.3, 0.30, 0.06, 1);
        box6(marble, wx2 + f.nx * sgn * 0.55, (f.f0 + yB - 1.4) / 2, wz2 + f.nz * sgn * 0.55,
             0.19, (yB - f.f0 - 1.4) / 2, 0.19, 1);
        box6(brass, wx2 + f.nx * sgn * 0.72, (f.f0 + yB - 2.4) / 2, wz2 + f.nz * sgn * 0.72,
             0.06, (yB - f.f0 - 2.4) / 2, 0.06, 1);
      }
      /* stepped lintel spanning the canyon: marble beam, narrower marble
         upper step, brass cap line, malachite glow line beneath */
      var mx3 = (w0[0] + w1[0]) / 2, mz3 = (w0[1] + w1[1]) / 2;
      var hx3 = Math.abs(w1[0] - w0[0]) / 2, hz3 = Math.abs(w1[1] - w0[1]) / 2;
      boxC(marble, mx3, yB + 0.3, mz3, hx3 + 0.3, 0.3, hz3 + 0.3, 0.07, 1);
      box6(marble, mx3, yB + 0.78, mz3,
           (hx3 > hz3 ? hx3 - 0.6 : 0.22), 0.18, (hz3 > hx3 ? hz3 - 0.6 : 0.22), 1);
      box6(brass, mx3, yB + 1.0, mz3,
           (hx3 > hz3 ? hx3 - 0.5 : 0.26), 0.045, (hz3 > hx3 ? hz3 - 0.5 : 0.26), 1);
      STATS.struts++;
    }
  }

  /* the ref-3 door treatment: black stepped marble surround, chevron-leaf
     side pilasters, brass fan-wing crown over the lintel, brass threshold,
     champagne glow reveal lines. Shared by the exit-switch face and the
     red-key door faces. */
  function decoPortal(fc, f, hot, ceilY) {
    var marble = PILES.marble.context(fc.amb, 8);
    var brass = PILES.brass.context(fc.amb, 3);
    var panel = PILES.panel.context(fc.amb, 4);
    var glow = PILES.glow;
    var w = 1.55, hTop = f + 3.9;
    /* attic slab buries the bare wall above the portal, so the whole face
       reads as one black-marble frontispiece */
    var wingOut = W.C / 2 - 0.02, atticTop = Math.min((ceilY || f + 16) - 0.25, hTop + 4.4);
    poly(marble, [
      pt2(fc, -(w + 0.78), hTop + 1.02, 0.045), pt2(fc, (w + 0.78), hTop + 1.02, 0.045),
      pt2(fc, (w + 0.78), atticTop, 0.045), pt2(fc, -(w + 0.78), atticTop, 0.045)
    ], fc.mx - fc.nx * 2, (hTop + atticTop) / 2, fc.mz - fc.nz * 2, 1);
    /* brass string course capping the attic */
    box6(brass, fc.mx + fc.nx * 0.07, atticTop - 0.10, fc.mz + fc.nz * 0.07,
         Math.abs(fc.ux) * wingOut + Math.abs(fc.nx) * 0.07, 0.045,
         Math.abs(fc.uz) * wingOut + Math.abs(fc.nz) * 0.07, 1);
    /* stepped jambs: outer wide + inner proud step, both smoke marble */
    for (var e2 = -1; e2 <= 1; e2 += 2) {
      boxC(marble, fc.mx + fc.ux * (w + 0.22) * e2 + fc.nx * 0.13, (f + hTop + 0.55) / 2,
           fc.mz + fc.uz * (w + 0.22) * e2 + fc.nz * 0.13,
           Math.abs(fc.ux) * 0.26 + Math.abs(fc.nx) * 0.13, (hTop + 0.55 - f) / 2,
           Math.abs(fc.uz) * 0.26 + Math.abs(fc.nz) * 0.13, 0.04, 1);
      boxC(marble, fc.mx + fc.ux * (w - 0.06) * e2 + fc.nx * 0.20, (f + hTop) / 2,
           fc.mz + fc.uz * (w - 0.06) * e2 + fc.nz * 0.20,
           Math.abs(fc.ux) * 0.14 + Math.abs(fc.nx) * 0.20, (hTop - f) / 2,
           Math.abs(fc.uz) * 0.14 + Math.abs(fc.nz) * 0.20, 0.03, 1);
      /* chevron-leaf pilaster strip (ref 3 side panels) */
      texQuad(panel,
        [pt2(fc, (w + 0.52) * e2 - 0.26, f + 0.3, 0.07), pt2(fc, (w + 0.52) * e2 + 0.26, f + 0.3, 0.07),
         pt2(fc, (w + 0.52) * e2 + 0.26, hTop + 0.4, 0.07), pt2(fc, (w + 0.52) * e2 - 0.26, hTop + 0.4, 0.07)],
        [[0.30, 0.02], [0.70, 0.02], [0.70, 0.98], [0.30, 0.98]],
        fc.nx, 0, fc.nz, fc.amb, 1);
      /* thin brass reveal blade on each jamb */
      box6(brass, fc.mx + fc.ux * (w + 0.40) * e2 + fc.nx * 0.16, (f + hTop) / 2,
           fc.mz + fc.uz * (w + 0.40) * e2 + fc.nz * 0.16,
           Math.abs(fc.ux) * 0.045 + Math.abs(fc.nx) * 0.16, (hTop - f) / 2,
           Math.abs(fc.uz) * 0.045 + Math.abs(fc.nz) * 0.16, 1);
    }
    /* stepped lintel: wide marble beam + narrower upper step + brass cap */
    boxC(marble, fc.mx + fc.nx * 0.13, hTop + 0.28, fc.mz + fc.nz * 0.13,
         Math.abs(fc.ux) * (w + 0.48) + Math.abs(fc.nx) * 0.13, 0.30,
         Math.abs(fc.uz) * (w + 0.48) + Math.abs(fc.nz) * 0.13, 0.05, 1);
    box6(marble, fc.mx + fc.nx * 0.16, hTop + 0.72, fc.mz + fc.nz * 0.16,
         Math.abs(fc.ux) * (w + 0.05) + Math.abs(fc.nx) * 0.16, 0.16,
         Math.abs(fc.uz) * (w + 0.05) + Math.abs(fc.nz) * 0.16, 1);
    box6(brass, fc.mx + fc.nx * 0.18, hTop + 0.92, fc.mz + fc.nz * 0.18,
         Math.abs(fc.ux) * (w + 0.12) + Math.abs(fc.nx) * 0.18, 0.045,
         Math.abs(fc.uz) * (w + 0.12) + Math.abs(fc.nz) * 0.18, 1);
    /* brass fan wings sweeping up-and-out from the lintel centre (ref 3) */
    fanBlades(brass, { mx: fc.mx, mz: fc.mz, ux: fc.ux, uz: fc.uz, nx: fc.nx, nz: fc.nz },
              0, hTop + 0.55, 0.20, 0.28, 1.15, 7,
              Math.PI * 0.16, Math.PI * 0.84, 0.04, 0.10);
    /* champagne glow line under the lintel -- the lit reveal of ref 3 */
    glowQuad(glow, [
      pt2(fc, -w + 0.1, hTop - 0.06, 0.11), pt2(fc, w - 0.1, hTop - 0.06, 0.11),
      pt2(fc, w - 0.1, hTop + 0.04, 0.11), pt2(fc, -w + 0.1, hTop + 0.04, 0.11)
    ], CHAMP[0] * (hot ? 1.5 : 1.1), CHAMP[1] * (hot ? 1.5 : 1.1), CHAMP[2] * (hot ? 1.5 : 1.1),
      fc.nx, 0, fc.nz);
    /* brass threshold plate */
    boxC(brass, fc.mx + fc.nx * 0.5, f + 0.035, fc.mz + fc.nz * 0.5,
         Math.abs(fc.ux) * (w + 0.2) + Math.abs(fc.nx) * 0.5, 0.035,
         Math.abs(fc.uz) * (w + 0.2) + Math.abs(fc.nz) * 0.5, 0.02, 1);
  }
  /* point on a portal face frame (same contract as pt(), unbound struct) */
  function pt2(fc, t, y, d) {
    return [fc.mx + fc.ux * t + fc.nx * d, y, fc.mz + fc.uz * t + fc.nz * d];
  }

  /* vestibule exit-switch face + the red-key door: full Deco portals */
  function buildExit() {
    if (!G.grid) return;
    var C = W.C;
    var D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var y = 0; y < G.MH; y++) for (var x = 0; x < G.MW; x++) {
      var t = G.cellAt(x, y);
      var isExit = t === G.S_EXIT, isKey = t === G.S_KEY;
      if (!isExit && !isKey) continue;           /* S_SECRET must stay bare */
      for (var d = 0; d < 4; d++) {
        var nx2 = x + D4[d][0], ny2 = y + D4[d][1];
        if (!walkable(nx2, ny2)) continue;
        var R = regionAt(nx2, ny2); if (!R) continue;
        /* face plane between the special cell and the open cell, dressed on
           the open side */
        var fc = {
          mx: (D4[d][0] !== 0 ? Math.max(x, nx2) * C : x * C + C / 2),
          mz: (D4[d][1] !== 0 ? Math.max(y, ny2) * C : y * C + C / 2),
          ux: D4[d][0] !== 0 ? 0 : 1, uz: D4[d][0] !== 0 ? 1 : 0,
          nx: D4[d][0] * 1, nz: D4[d][1] * 1,   /* into the open cell */
          amb: R.amb
        };
        decoPortal(fc, R.f, isExit, R.c);
      }
    }
  }

  /* Deco torchiere wall sconces: a brass fan of blades over a champagne
     glow shell at every warm sconce light. Positions derive from the bound
     LIGHTS array (radius >= 28 warm lamps hung 4-6.5 units over the floor);
     nz-env leaves these alone because their radius is >= 30. */
  function buildTorchieres() {
    if (!G.LIGHTS) return;
    var C = W.C, i;
    var noir = PILES.noir, brass = PILES.brass, glow = PILES.glow;
    var D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (i = 0; i < G.LIGHTS.length; i++) {
      var L = G.LIGHTS[i];
      if (!L || fin(L.r, 0) < 28 || fin(L.r, 0) > 32) continue;
      var lc = L.c || [1, 1, 1];
      if (lc[0] < 0.9 || lc[1] > 0.82 || lc[2] > 0.6) continue;   /* warm lamps only */
      var cx = Math.floor(L.x / C), cy = Math.floor(L.z / C);
      if (!walkable(cx, cy)) continue;
      var R = regionAt(cx, cy); if (!R) continue;
      var dy = L.y - R.f;
      if (dy < 3.5 || dy > 6.5) continue;                          /* the sconce band */
      /* find the mounting wall: prefer the direction away from the rotunda
         centre; accept a solid cell or a riser (>= 4 up) within 2 cells */
      var ox = cx * C + C / 2 - W.cx, oz = cy * C + C / 2 - W.cz;
      var best = null, bestScore = -1e9, d, stp;
      for (d = 0; d < 4; d++) {
        for (stp = 1; stp <= 2; stp++) {
          var tx = cx + D4[d][0] * stp, ty = cy + D4[d][1] * stp;
          var wallish = false;
          if (!G.inb(tx, ty) || G.isWallCell(tx, ty)) wallish = true;
          else {
            var RT = regionAt(tx, ty);
            if (RT && !RT.sky && RT.f >= R.f + 4) wallish = true;
            if (RT && !wallish) break;      /* open same-level cell: no wall this way */
          }
          if (!wallish) continue;
          var score = (D4[d][0] * ox + D4[d][1] * oz) / (Math.hypot(ox, oz) || 1) - stp * 0.6;
          if (score > bestScore) {
            bestScore = score;
            best = { d: d, step: stp,
                     mx: (D4[d][0] > 0 ? (cx + stp) * C : D4[d][0] < 0 ? (cx - stp + 1) * C : cx * C + C / 2),
                     mz: (D4[d][1] > 0 ? (cy + stp) * C : D4[d][1] < 0 ? (cy - stp + 1) * C : cy * C + C / 2),
                     nx: -D4[d][0], nz: -D4[d][1] };
          }
          break;
        }
      }
      if (!best) continue;
      var fT = { mx: best.mx, mz: best.mz,
                 ux: best.nx !== 0 ? 0 : 1, uz: best.nx !== 0 ? 1 : 0,
                 nx: best.nx, nz: best.nz, amb: R.amb };
      var yL = L.y;
      noir.context(R.amb, 5); brass.context(R.amb, 3);
      /* stepped noir back plate */
      box6(noir, fT.mx + fT.nx * 0.055, yL - 0.15, fT.mz + fT.nz * 0.055,
           Math.abs(fT.ux) * 0.34 + Math.abs(fT.nx) * 0.055, 1.35,
           Math.abs(fT.uz) * 0.34 + Math.abs(fT.nz) * 0.055, 1);
      /* brass stem + collar */
      box6(brass, fT.mx + fT.nx * 0.16, yL - 0.72, fT.mz + fT.nz * 0.16,
           Math.abs(fT.ux) * 0.075 + Math.abs(fT.nx) * 0.10, 0.62,
           Math.abs(fT.uz) * 0.075 + Math.abs(fT.nz) * 0.10, 1);
      boxC(brass, fT.mx + fT.nx * 0.20, yL - 0.16, fT.mz + fT.nz * 0.20,
           Math.abs(fT.ux) * 0.22 + Math.abs(fT.nx) * 0.14, 0.10,
           Math.abs(fT.uz) * 0.22 + Math.abs(fT.nz) * 0.14, 0.03, 1);
      /* champagne glow shell behind the fan (the lamp) */
      var rimG = [], k2;
      for (k2 = 0; k2 <= 6; k2++) {
        var ga = Math.PI * k2 / 6;
        rimG.push(pt2(fT, Math.cos(ga) * 0.80, yL + Math.sin(ga) * 1.05, 0.16));
      }
      var cG = pt2(fT, 0, yL + 0.06, 0.16);
      glowFan(glow, cG[0], cG[1], cG[2], rimG,
              [CHAMP[0] * 1.55, CHAMP[1] * 1.35, CHAMP[2] * 1.1],
              [CHAMP[0] * 0.5, CHAMP[1] * 0.36, CHAMP[2] * 0.2],
              fT.nx, 0, fT.nz);
      /* the brass fan: 7 blades sweeping up from the collar */
      fanBlades(brass, fT, 0, yL - 0.06, 0.24, 0.16, 1.08, 7,
                Math.PI * 0.14, Math.PI * 0.86, 0.04, 0.10);
      STATS.torchieres++;
    }
  }

  /* floor dressing: ivory marble field over the pit with a giant brass
     sunburst medallion + concentric inlay rings under the chandelier, and
     a double brass border band along every gallery void edge. Overlays sit
     0.045/0.075 above the world quads with polygonOffset (street-ground
     idiom); stair cells never qualify because their region floor is off the
     storey lattice. */
  function buildFloors() {
    var C = W.C, x, y;
    var ivory = PILES.ivory, inlay = PILES.inlay;
    /* pit radius: nearest ground-storey riser face */
    var rPit = 1e9, i;
    for (i = 0; i < W.faces.length; i++) {
      var fF = W.faces[i];
      if (Math.abs(fF.f0 - W.groundF) > 0.5) continue;
      var dd = Math.hypot(fF.mx - W.cx, fF.mz - W.cz);
      if (dd < rPit) rPit = dd;
    }
    if (rPit > 500) return;
    rPit -= 0.15;
    var sp = findSpawn('player');
    var spx = sp ? sp.x * C + C / 2 : -1e5, spz = sp ? sp.y * C + C / 2 : -1e5;

    /* ivory field: full-cell quads on every ground-storey pit cell */
    for (y = 0; y < G.MH; y++) for (x = 0; x < G.MW; x++) {
      if (!walkable(x, y)) continue;
      var R = regionAt(x, y); if (!R) continue;
      if (Math.abs(R.f - W.groundF) > 0.3) continue;
      var wx0 = x * C, wz0 = y * C;
      var ccx = wx0 + C / 2, ccz = wz0 + C / 2;
      if (Math.hypot(ccx - W.cx, ccz - W.cz) > rPit - C * 0.5) continue;
      ivory.context(R.amb, 6);
      poly(ivory, [[wx0, W.groundF + 0.045, wz0 + C], [wx0 + C, W.groundF + 0.045, wz0 + C],
                   [wx0 + C, W.groundF + 0.045, wz0], [wx0, W.groundF + 0.045, wz0]],
           ccx, W.groundF - 1, ccz, 1);
      STATS.floorCells++;
    }

    /* concentric brass rings + rim double band (skip near the spawn pad) */
    inlay.context(AMB_FALLBACK, 3);
    var SEG = 48, s2, rr2;
    var rings = [[7.5, 0.20], [14.5, 0.16], [rPit - 3.4, 0.14], [rPit - 2.9, 0.10]];
    for (var rI = 0; rI < rings.length; rI++) {
      rr2 = rings[rI][0];
      var hw2 = rings[rI][1];
      if (rr2 < 2 || rr2 > rPit - 1) continue;
      for (s2 = 0; s2 < SEG; s2++) {
        var a0 = s2 / SEG * TAU, a1 = (s2 + 1) / SEG * TAU;
        var am2 = (a0 + a1) / 2;
        var gx2 = W.cx + Math.cos(am2) * rr2, gz2 = W.cz + Math.sin(am2) * rr2;
        if (Math.hypot(gx2 - spx, gz2 - spz) < 2.9) continue;     /* pad keeps its own medallion */
        /* ring segments only over real pit floor */
        var cI = Math.floor(gx2 / C), cJ = Math.floor(gz2 / C);
        if (!walkable(cI, cJ)) continue;
        var RS = regionAt(cI, cJ);
        if (!RS || Math.abs(RS.f - W.groundF) > 0.3) continue;
        poly(inlay, [
          [W.cx + Math.cos(a0) * (rr2 - hw2), W.groundF + 0.075, W.cz + Math.sin(a0) * (rr2 - hw2)],
          [W.cx + Math.cos(a0) * (rr2 + hw2), W.groundF + 0.075, W.cz + Math.sin(a0) * (rr2 + hw2)],
          [W.cx + Math.cos(a1) * (rr2 + hw2), W.groundF + 0.075, W.cz + Math.sin(a1) * (rr2 + hw2)],
          [W.cx + Math.cos(a1) * (rr2 - hw2), W.groundF + 0.075, W.cz + Math.sin(a1) * (rr2 - hw2)]
        ], W.cx + Math.cos(am2) * rr2, W.groundF - 1, W.cz + Math.sin(am2) * rr2, 1);
      }
    }
    /* the giant sunburst medallion: 24 rays, long/short, + centre boss ring */
    var RAYS = 24;
    for (i = 0; i < RAYS; i++) {
      var ra = i / RAYS * TAU + TAU / (RAYS * 2);
      var ca3 = Math.cos(ra), sa3 = Math.sin(ra);
      var tip = (i % 2) ? 4.6 : 6.9;
      var px3 = -sa3, pz3 = ca3;
      poly(inlay, [
        [W.cx + ca3 * 1.7 - px3 * 0.30, W.groundF + 0.075, W.cz + sa3 * 1.7 - pz3 * 0.30],
        [W.cx + ca3 * 1.7 + px3 * 0.30, W.groundF + 0.075, W.cz + sa3 * 1.7 + pz3 * 0.30],
        [W.cx + ca3 * tip + px3 * 0.055, W.groundF + 0.075, W.cz + sa3 * tip + pz3 * 0.055],
        [W.cx + ca3 * tip - px3 * 0.055, W.groundF + 0.075, W.cz + sa3 * tip - pz3 * 0.055]
      ], W.cx + ca3 * 3, W.groundF - 1, W.cz + sa3 * 3, 1);
    }
    for (s2 = 0; s2 < 24; s2++) {
      var b0 = s2 / 24 * TAU, b1 = (s2 + 1) / 24 * TAU;
      poly(inlay, [
        [W.cx + Math.cos(b0) * 1.05, W.groundF + 0.075, W.cz + Math.sin(b0) * 1.05],
        [W.cx + Math.cos(b0) * 1.42, W.groundF + 0.075, W.cz + Math.sin(b0) * 1.42],
        [W.cx + Math.cos(b1) * 1.42, W.groundF + 0.075, W.cz + Math.sin(b1) * 1.42],
        [W.cx + Math.cos(b1) * 1.05, W.groundF + 0.075, W.cz + Math.sin(b1) * 1.05]
      ], W.cx, W.groundF - 1, W.cz, 1);
    }

    /* gallery lip: double brass band along every void edge, gapped at stair
       mouths for free because those edges never exist */
    for (i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      inlay.context(e.ambHi, 3);
      var bx0 = e.mx + e.nx * 0.62, bz0 = e.mz + e.nz * 0.62;
      var bx1 = e.mx + e.nx * 0.95, bz1 = e.mz + e.nz * 0.95;
      var hwB = C / 2 - 0.06;
      poly(inlay, [
        [bx0 - e.ux * hwB - e.nx * 0.055, e.f1 + 0.045, bz0 - e.uz * hwB - e.nz * 0.055],
        [bx0 - e.ux * hwB + e.nx * 0.055, e.f1 + 0.045, bz0 - e.uz * hwB + e.nz * 0.055],
        [bx0 + e.ux * hwB + e.nx * 0.055, e.f1 + 0.045, bz0 + e.uz * hwB + e.nz * 0.055],
        [bx0 + e.ux * hwB - e.nx * 0.055, e.f1 + 0.045, bz0 + e.uz * hwB - e.nz * 0.055]
      ], bx0, e.f1 - 1, bz0, 1);
      poly(inlay, [
        [bx1 - e.ux * hwB - e.nx * 0.035, e.f1 + 0.045, bz1 - e.uz * hwB - e.nz * 0.035],
        [bx1 - e.ux * hwB + e.nx * 0.035, e.f1 + 0.045, bz1 - e.uz * hwB + e.nz * 0.035],
        [bx1 + e.ux * hwB + e.nx * 0.035, e.f1 + 0.045, bz1 + e.uz * hwB + e.nz * 0.035],
        [bx1 + e.ux * hwB - e.nx * 0.035, e.f1 + 0.045, bz1 + e.uz * hwB - e.nz * 0.035]
      ], bx1, e.f1 - 1, bz1, 1);
    }
  }

  /* the chandelier (ref 4): three stacked brass tiers, wide to narrow going
     down, champagne glass panels around each tier, suspension rods to the
     collar, brass stem + finial, and an additive sparkle band. Built in
     world coordinates, recentred on the pivot, rotated slowly by tick(). */
  var CHAND = { lit: null, glow: null, spark: null, t: 0 };
  function buildChandelier() {
    var yTop = (W.collarY || W.ceilC - 1.1) - 0.15;
    var yCrown = yTop - 2.3;
    var tiers = [
      { r: 4.5, y: yCrown - 0.7, h: 0.78 },
      { r: 3.4, y: yCrown - 2.15, h: 0.68 },
      { r: 2.3, y: yCrown - 3.45, h: 0.60 }
    ];
    var lit = new Pile().context(AMB_FALLBACK, 3);
    var glo = new Pile();
    var i, s, SEG = 20;

    /* suspension: eight slim cables from the top-tier rim up and out to the
       collar's inner lip -- the cable-hung halo of a rotunda fixture. The
       cables live in the LIT pile but stay still visually because the whole
       mesh spins about its own axis. */
    var colR = (W.collarR || 24) - 0.45, colY = (W.collarY || W.ceilC - 1.1) - 0.02;
    for (i = 0; i < 8; i++) {
      var ra = i / 8 * TAU + TAU / 16;
      tube(lit, W.cx + Math.cos(ra) * 4.4, yCrown - 0.6, W.cz + Math.sin(ra) * 4.4,
           W.cx + Math.cos(ra) * colR, colY, W.cz + Math.sin(ra) * colR,
           0.035, 4, 1, false);
    }
    /* central stem from the crown down to the finial */
    tube(lit, W.cx, yCrown + 0.15, W.cz, W.cx, tiers[2].y - 1.3, W.cz, 0.11, 6, 1, false);
    /* crown ring */
    ringBand(lit, W.cx, W.cz, yCrown, 1.5, 0.18, 0.11, SEG);

    for (var tI = 0; tI < tiers.length; tI++) {
      var T = tiers[tI];
      /* brass tier ring: outer/inner skirt + underside */
      ringBand(lit, W.cx, W.cz, T.y, T.r, 0.24, 0.13, SEG);
      /* champagne glass panels standing on the ring, tilted slightly out */
      for (s = 0; s < SEG; s++) {
        var a0 = s / SEG * TAU, a1 = (s + 1) / SEG * TAU;
        var g = 0.055;                       /* angular gap between panes */
        var p0 = a0 + g, p1 = a1 - g;
        var rB = T.r - 0.06, rT = T.r + 0.10;
        var q = [
          [W.cx + Math.cos(p0) * rB, T.y + 0.13, W.cz + Math.sin(p0) * rB],
          [W.cx + Math.cos(p1) * rB, T.y + 0.13, W.cz + Math.sin(p1) * rB],
          [W.cx + Math.cos(p1) * rT, T.y + 0.13 + T.h, W.cz + Math.sin(p1) * rT],
          [W.cx + Math.cos(p0) * rT, T.y + 0.13 + T.h, W.cz + Math.sin(p0) * rT]
        ];
        var warm = 1.12 + 0.22 * ((s % 3 === 0) ? 1 : 0);
        glowQuad(glo, q, CHAMP[0] * warm, CHAMP[1] * warm * 0.92, CHAMP[2] * warm * 0.8,
                 Math.cos((p0 + p1) / 2), 0, Math.sin((p0 + p1) / 2));
        /* inner amber drum behind the panes: the dense lit core ref 4 has */
        var qi = [
          [W.cx + Math.cos(p0) * (rB - 0.5), T.y + 0.10, W.cz + Math.sin(p0) * (rB - 0.5)],
          [W.cx + Math.cos(p1) * (rB - 0.5), T.y + 0.10, W.cz + Math.sin(p1) * (rB - 0.5)],
          [W.cx + Math.cos(p1) * (rB - 0.42), T.y + 0.16 + T.h, W.cz + Math.sin(p1) * (rB - 0.42)],
          [W.cx + Math.cos(p0) * (rB - 0.42), T.y + 0.16 + T.h, W.cz + Math.sin(p0) * (rB - 0.42)]
        ];
        glowQuad(glo, qi, CHAMP[0] * 0.85, CHAMP[1] * 0.72, CHAMP[2] * 0.5,
                 Math.cos((p0 + p1) / 2), 0, Math.sin((p0 + p1) / 2));
      }
      /* soft under-glow disc so the tier throws light downward */
      var baseG = glo.n;
      glo.vert(W.cx, T.y - 0.14, W.cz, 0, -1, 0, 0, 0, CHAMP[0] * 1.1, CHAMP[1] * 1.05, CHAMP[2] * 0.9);
      for (s = 0; s <= SEG; s++) {
        var ad = s / SEG * TAU;
        glo.vert(W.cx + Math.cos(ad) * (T.r - 0.12), T.y - 0.14, W.cz + Math.sin(ad) * (T.r - 0.12),
                 0, -1, 0, 0, 0, CHAMP[0] * 0.28, CHAMP[1] * 0.24, CHAMP[2] * 0.18);
      }
      for (s = 0; s < SEG; s++) glo.tri(baseG, baseG + 1 + s, baseG + 2 + s);
    }
    /* finial: small brass cone-ish drop */
    tube(lit, W.cx, tiers[2].y - 0.6, W.cz, W.cx, tiers[2].y - 1.4, W.cz, 0.2, 6, 1, true);

    CHAND.lit = pivotMesh(lit.geometry(), MATS.brass, 'nzarena-chandelier', W.cx, 0, W.cz);
    CHAND.glow = pivotMesh(glo.geometry(), MATS.glow, 'nzarena-chandelier-glass', W.cx, 0, W.cz);

    /* sparkle: one additive shimmer band nested between the top tiers */
    var p = [], c = [], idx = [];
    var segS = 24, rS = 3.95, yS = tiers[0].y - 0.6;
    for (i = 0; i < segS; i++) {
      var aS = i / segS * TAU, hot = (i % 3 === 0) ? 1.9 : 0.85;
      p.push(Math.cos(aS) * rS, yS - 0.3, Math.sin(aS) * rS,
             Math.cos(aS) * rS, yS + 0.3, Math.sin(aS) * rS);
      c.push(CHAMP[0] * hot, CHAMP[1] * hot, CHAMP[2] * hot * 0.9,
             CHAMP[0] * hot * 0.4, CHAMP[1] * hot * 0.4, CHAMP[2] * hot * 0.35);
    }
    for (i = 0; i < segS; i++) {
      var j = (i + 1) % segS;
      idx.push(i * 2, j * 2, j * 2 + 1, i * 2, j * 2 + 1, i * 2 + 1);
    }
    var gS = new THREE.BufferGeometry();
    gS.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    gS.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    gS.setIndex(idx);
    gS.computeBoundingSphere();
    OWN.geo.push(gS);
    var mS = new THREE.Mesh(gS, MATS.holo);
    mS.name = 'nzarena-chandelier-spark';
    mS.position.set(W.cx, 0, W.cz);
    mS.castShadow = false; mS.receiveShadow = false;
    mS.matrixAutoUpdate = false; mS.updateMatrix();
    scene.add(mS); OWN.obj.push(mS);
    STATS.calls++; STATS.tris += idx.length / 3; STATS.verts += p.length / 3;
    CHAND.spark = mS;
  }
  /* annular brass band: underside + outer/inner skirts + top rim */
  function ringBand(pile, cx, cz, y, r, hw, hh, seg) {
    for (var s = 0; s < seg; s++) {
      var a0 = s / seg * TAU, a1 = (s + 1) / seg * TAU;
      var i0 = [cx + Math.cos(a0) * (r - hw), cz + Math.sin(a0) * (r - hw)];
      var i1 = [cx + Math.cos(a1) * (r - hw), cz + Math.sin(a1) * (r - hw)];
      var o0 = [cx + Math.cos(a0) * (r + hw), cz + Math.sin(a0) * (r + hw)];
      var o1 = [cx + Math.cos(a1) * (r + hw), cz + Math.sin(a1) * (r + hw)];
      var rx = cx + Math.cos((a0 + a1) / 2) * r, rz = cz + Math.sin((a0 + a1) / 2) * r;
      poly(pile, [[i0[0], y - hh, i0[1]], [i1[0], y - hh, i1[1]], [o1[0], y - hh, o1[1]], [o0[0], y - hh, o0[1]]],
           rx, y + 3, rz, 0.9);
      poly(pile, [[i0[0], y + hh, i0[1]], [i1[0], y + hh, i1[1]], [o1[0], y + hh, o1[1]], [o0[0], y + hh, o0[1]]],
           rx, y - 3, rz, 1);
      poly(pile, [[o0[0], y - hh, o0[1]], [o1[0], y - hh, o1[1]], [o1[0], y + hh, o1[1]], [o0[0], y + hh, o0[1]]],
           rx, y, rz, 1);
      poly(pile, [[i0[0], y - hh, i0[1]], [i1[0], y - hh, i1[1]], [i1[0], y + hh, i1[1]], [i0[0], y + hh, i0[1]]],
           rx, y, rz, 1);
    }
  }
  /* mesh recentred on a pivot so tick() can spin it in place */
  function pivotMesh(geo, mat, name, px, py, pz) {
    geo.translate(-px, -py, -pz);
    geo.computeBoundingSphere();
    var m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.position.set(px, py, pz);
    m.castShadow = false; m.receiveShadow = false;
    m.frustumCulled = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    scene.add(m); OWN.obj.push(m);
    STATS.calls++; STATS.tris += (geo.index ? geo.index.count / 3 : 0) | 0;
    STATS.verts += geo.attributes.position.count;
    return m;
  }

  /* ======================================================================
     level-2 look -- retune the SHARED live rig through nz-render's PUBLIC
     API (NZ.render.params is the live P object; rebuildEnvironment()
     re-derives sky dome, oculus disc, fog tint and IBL probe from it, and
     nz-render's own -1000 'ready' sweep re-applies the light rig after us,
     so no private call is needed). The stock numbers are solved for the
     overcast daylight street of level 1; The Crucible remains an interior,
     but now uses a broad museum-like fill behind its warmer sconce pools and
     colored practicals instead of asking near-black materials to carry it.
     Level 1 never reaches this (install() gates on NZ.level === 2 and on
     the rotunda carve). Absolute values, not deltas, so re-entry cannot
     compound. The shared sky module itself is untouched -- skyLum is its
     own documented exposure knob (same one ?nzlight=sky: drives).
     =================================================================== */
  function applyLuminousLook() {
    var R = NZ.render;
    if (!R || !R.params || !R.rebuildEnvironment) {
      warn('luminous look skipped: NZ.render params unavailable');
      return;
    }
    var LP = R.params;
    LP.exposure = 1.08;       /* brighter middle values, still fixed/no adaptation */
    LP.contrast = 0.12;       /* retain depth without crushing pale stone       */
    LP.vignette = 0.12;       /* do not darken the newly readable frame edges    */
    LP.keyIntensity = 0.72;   /* soft top-down architectural key                 */
    LP.sunElevation = 62;     /* steep: the key reads down through the oculus    */
    LP.envIrradiance = 0.26;  /* broad fill for marble, lacquer and enemy forms  */
    LP.bounceIntensity = 0.48;
    LP.ambientFloor = 0.095;  /* stable visibility between practical pools       */
    LP.skyLum = 0.58;         /* a luminous oculus, not an exterior daylight sky */
    LP.bloom = 0.14;          /* restrained separation for blue/green emitters   */
    try { R.rebuildEnvironment(); }
    catch (e) { warn('luminous look env rebuild failed: ' + (e && e.message)); }
    NZ.log('arena: luminous look applied (key .72 el 62, env .26, sky .58)');
  }

  /* per-frame: NZ.first('render') chain, priority 30 -- before nz-render's
     p0 claim; returns undefined so the chain carries on. No allocations.
     The chandelier turns with the stately tick the holo ring used to have;
     the sparkle band counter-rotates and breathes. */
  function tick(dt) {
    if (dead || !installed) return undefined;
    var d = fin(dt, 0.016);
    CHAND.t += d;
    if (CHAND.lit) { CHAND.lit.rotation.y += d * 0.05; CHAND.lit.updateMatrix(); }
    if (CHAND.glow) { CHAND.glow.rotation.y += d * 0.05; CHAND.glow.updateMatrix(); }
    if (CHAND.spark) { CHAND.spark.rotation.y -= d * 0.16; CHAND.spark.updateMatrix(); }
    if (MATS.holo) MATS.holo.opacity = 0.5 + 0.13 * Math.sin(CHAND.t * 1.3);
    return undefined;
  }

  /* ======================================================================
     install / teardown
     =================================================================== */
  function makeMesh(pile, mat, name) {
    if (!pile || pile.empty() || !mat) return null;
    var mesh = new THREE.Mesh(pile.geometry(), mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    OWN.obj.push(mesh);
    STATS.calls++;
    STATS.tris += (pile.idx.length / 3) | 0;
    STATS.verts += pile.n;
    return mesh;
  }

  function panic(err) {
    dead = true;
    if (err) { try { console.error('[nz-arena] install failed:', err); } catch (e) {} }
    try {
      for (var i = 0; i < OWN.obj.length; i++)
        if (OWN.obj[i].parent) OWN.obj[i].parent.remove(OWN.obj[i]);
      for (i = 0; i < OWN.geo.length; i++) OWN.geo[i].dispose();
      for (i = 0; i < OWN.mat.length; i++) OWN.mat[i].dispose();
    } catch (e2) {}
    OWN.obj.length = 0; OWN.geo.length = 0; OWN.mat.length = 0;
    if (NZ.flags) NZ.flags.arena = false;
  }

  function install(ctx) {
    if (dead || installed) return;

    /* LEVEL GATE: this module dresses The Crucible only. On level 1 (or when
       the boot has not promoted the level) it must be a total no-op: no scene
       adds, no material bakes. */
    var lvl = (NZ.level === undefined || NZ.level === null) ? 1 : NZ.level;
    if (lvl !== 2) { NZ.log('arena: level ' + lvl + ', module inert'); return; }

    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
    renderer = (ctx && ctx.renderer) || (NZ.ctx && NZ.ctx.renderer) || null;
    if (!THREE || !scene) throw new Error('nz-arena: renderer context missing');

    G = bindGame();
    if (!G) { NZ.log('arena: level globals unavailable, module inert'); return; }

    W = scanWorld();
    if (!W) { NZ.log('arena: rotunda carve not present, module inert'); return; }

    applyLuminousLook();

    buildMaterials();

    PILES = { marble: new Pile(), brass: new Pile(), noir: new Pile(),
              panel: new Pile(), mural: new Pile(), ivory: new Pile(),
              inlay: new Pile(), glow: new Pile() };

    buildMurals();                  /* first: murals claim their riser faces */
    buildRisers();
    buildPerimeter();
    buildParapets();
    buildClerestory();
    buildRibs();
    buildSpawnPad();
    buildKeyPedestal();
    buildNullstarDais();
    buildLift();
    buildStruts();
    buildExit();
    buildTorchieres();
    buildFloors();

    makeMesh(PILES.marble, MATS.marble, 'nzarena-marble');
    makeMesh(PILES.brass, MATS.brass, 'nzarena-brass');
    makeMesh(PILES.noir, MATS.noir, 'nzarena-noir');
    makeMesh(PILES.panel, MATS.panel, 'nzarena-panels');
    makeMesh(PILES.mural, MATS.mural, 'nzarena-murals');
    makeMesh(PILES.ivory, MATS.ivory, 'nzarena-ivory-floor');
    makeMesh(PILES.inlay, MATS.inlay, 'nzarena-brass-inlay');
    makeMesh(PILES.glow, MATS.glow, 'nzarena-glow');
    buildChandelier();

    /* animation only once geometry exists; priority 30 keeps us above
       nz-render's frame claim and under nz-shots' camera (1000) */
    NZ.on('render', tick, 30);

    installed = true;
    NZ.flags.arena = true;
    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    STATS.geoMs = Math.round(t1 - t0) - STATS.bakeMs;
    NZ.arena = { stats: STATS, dispose: function () { panic(null); } };
    NZ.log('arena: ' + STATS.calls + ' draw calls, ' + STATS.tris + ' tris, ' +
           STATS.faces + ' riser faces, ' + STATS.parapets + ' parapet edges, ' +
           STATS.banners + ' murals, ' + STATS.torchieres + ' torchieres, ' +
           STATS.floorCells + ' floor cells, bake ' + STATS.bakeMs + 'ms, geo ' + STATS.geoMs + 'ms');
  }

  /* priority -60: after nz-render's 0 (materials live) and nz-env's -20
     (fixtures hung on the arena sconces), before nz-render's -1000 sweep
     (neutralizeBakedLighting must see our finished vertex bake) */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); }
    catch (err) { panic(err); }
  }, -60);

  NZ.log('arena module loaded');
})(typeof window !== 'undefined' ? window : this);
