/* ===========================================================================
   NZ-DESTRUCT  --  what a bullet leaves behind.

   Owns the surface response to gunfire and blast, and nothing else:

     1. PERSISTENT BULLET HOLES.  A pooled decal mesh (one draw call, ring
        buffer) stamps a deep, bevelled hole plus the damaged material around
        it -- chipped render and hairline cracks on concrete, a torn-paint
        ring of bare-metal glint on a car body, splintered fibre on wood, a
        crack web on car glass.  Holes do not fade on a timer the way the
        stock impactDecal does; the pool recycles the oldest slot only when
        all POOL_N are spent.  Repeat hits within 0.35 u of an old hole make
        it a bigger, darker crater instead of stacking a twin on top.

     2. CAR HITS.  Collision is grid truth and stays grid truth (ENV-PLAYBOOK
        7): a parking bay stops the round exactly where castWall says.  But
        the DECAL goes on the car, not on the invisible cell plane: the ray
        is tested against each parked car's oriented box (published by
        nz-street-props as NZ.streetProps.cars) and refined against the real
        body/glass piles, so the hole hugs the panel and glass takes a crack
        web rather than a paint chip.  Hit legality for enemies is untouched.

     3. BREAKABLE CRATES.  Every CRATES[] cell carries hit points.  Player
        fire (not enemy fire -- cover the AI shoots at must stay cover)
        wears it down; a blast inside the radius ends it at once.  A dead
        crate leaves the scene, opens its grid cell to S_FLOOR, takes its
        own decals with it, and throws a shower of tumbling plank debris
        that bounces on highestFloor() and settles.

     4. EXPLOSION SCARS.  explode() is wrapped, not edited: every detonation
        also breaks crates in radius, stamps a scorch on the floor under the
        burst and soots the flank of any car close enough.

   It does NOT own hit legality (castWall / hitscan decide what was struck),
   the impact sfx synthesis (nz-audio), the puff particles (NUKEM.html's
   impactPuff is reused), or any prop it cannot break.  The stock fading
   impactDecal path is deliberately left in charge of DOORS and LIFTS,
   because a persistent hole on a panel that slides away is a hole hanging
   in the air.

   Installed from two hook sites in NUKEM.html: NZ.first('surfaceHit', ...)
   in hitscan's wall branch and in the enemy-fire miss branch.  Returning
   true from the hook means this module owned the response and the stock
   puff/decal/sfx are skipped.  Kill switch: ?nzdestruct=0.

   Zero external assets.  Classic script.  three.js r149 core UMD only.
   No new lights, no new draw calls beyond: 1 decal pool + live debris.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.destruct === undefined) NZ.flags.destruct = false;

  var QS = /[?&]nzdestruct=(0|off)/i.test(global.location ? global.location.search : '');
  if (QS) { NZ.log && NZ.log('destruct disabled by query string'); return; }

  var THREE = null, scene = null;
  var dead = false, installed = false;

  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rr(a, b) { return a + Math.random() * (b - a); }

  var STATS = {
    holes: 0, deepened: 0, carHits: 0, glassHits: 0, crateHits: 0,
    cratesBroken: 0, scorches: 0, poolWraps: 0, meshRayBudgetSkips: 0,
    debrisPeak: 0, buildingGlassHits: 0, glassPanes: 0,
    panesCracked: 0, panesCollapsed: 0, roomsRevealed: 0,
    glassDebrisPeak: 0, carGlassPanes: 0, carPanesBroken: 0,
    carGlassDebrisPeak: 0, ms: 0
  };
  var DIAG = { warnings: [] };
  function warn(msg) {
    DIAG.warnings.push(msg);
    try { console.warn('[nz-destruct] ' + msg); } catch (e) {}
  }

  /* ---- the game's lexical globals ---------------------------------------
     Bound once at 'ready'.  Every one is optional: a missing global demotes
     the feature that needed it rather than killing the module. */
  var G = null;
  function bindGame() {
    var g = {
      CELL: tryGet(function () { return CELL; }),
      grid: tryGet(function () { return grid; }),
      idx: tryGet(function () { return idx; }),
      inb: tryGet(function () { return inb; }),
      regAt: tryGet(function () { return regAt; }),
      doorAt: tryGet(function () { return doorAt; }),
      liftAt: tryGet(function () { return liftAt; }),
      S_BLOCK: tryGet(function () { return S_BLOCK; }),
      S_FLOOR: tryGet(function () { return S_FLOOR; }),
      S_DOOR: tryGet(function () { return S_DOOR; }),
      S_KEY: tryGet(function () { return S_KEY; }),
      S_SECRET: tryGet(function () { return S_SECRET; }),
      CRATE_H: tryGet(function () { return CRATE_H; }),
      CRATE_MESHES: tryGet(function () { return CRATE_MESHES; }),
      highestFloor: tryGet(function () { return highestFloor; }),
      castWall: tryGet(function () { return castWall; }),
      shotLineClear: tryGet(function () { return shotLineClear; }),
      impactSurface: tryGet(function () { return impactSurface; }),
      lightAt: tryGet(function () { return lightAt; }),
      state: tryGet(function () { return state; }),
      particle: tryGet(function () { return particle; }),
      impactPuff: tryGet(function () { return impactPuff; }),
      sfx: tryGet(function () { return sfx; })
    };
    if (typeof g.CELL !== 'number') { warn('CELL not visible -- grid features off'); }
    return g;
  }
  function safeSfx(name, x, z) { try { if (G && G.sfx) G.sfx(name, x, z); } catch (e) {} }
  function safePuff(v, dir, kind) { try { if (G && G.impactPuff) G.impactPuff(v, dir, kind); } catch (e) {} }

  /* =======================================================================
     SECTION 1 -- the hole atlas.

     One 512x512 canvas, 4x4 cells of 128 px, mipmapped, 8 px of quiet
     padding per cell edge so the mip chain never bleeds a neighbour in.
     Row 0 concrete/render, row 1 metal/car paint, row 2 wood, row 3 glass
     (2 variants) + scorch (2 variants).  Every mark is painted radially
     symmetric on purpose: the quad is stamped at a random roll, so any
     baked-in light direction would point a different way on every hole.
     Depth is sold instead by a bevel -- near-black core, a bright chipped
     rim all the way round, then the damaged-material ring. */
  var ATLAS = null, CELLPX = 128, GRIDN = 4, PAD = 8;

  function bakeAtlas() {
    var cv = global.document.createElement('canvas');
    cv.width = cv.height = CELLPX * GRIDN;
    var cx = cv.getContext('2d');

    function cell(col, row, painter) {
      cx.save();
      cx.translate(col * CELLPX + CELLPX / 2, row * CELLPX + CELLPX / 2);
      cx.beginPath(); cx.rect(-CELLPX / 2 + PAD, -CELLPX / 2 + PAD, CELLPX - PAD * 2, CELLPX - PAD * 2);
      cx.clip();
      painter();
      cx.restore();
    }
    function speck(n, r0, r1, size0, size1, style) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, r = rr(r0, r1);
        cx.fillStyle = style;
        cx.beginPath();
        cx.arc(Math.cos(a) * r, Math.sin(a) * r, rr(size0, size1), 0, Math.PI * 2);
        cx.fill();
      }
    }
    function radial(r, stops) {
      var g = cx.createRadialGradient(0, 0, 0, 0, 0, r);
      for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
      cx.fillStyle = g;
      cx.beginPath(); cx.arc(0, 0, r, 0, Math.PI * 2); cx.fill();
    }
    function cracks(n, r0, r1, w, style) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, r = r0, x = Math.cos(a) * r, y = Math.sin(a) * r;
        cx.strokeStyle = style; cx.lineWidth = w * rr(.7, 1.3);
        cx.beginPath(); cx.moveTo(x, y);
        var len = rr(r0, r1), steps = 3 + (Math.random() * 3 | 0);
        for (var s = 1; s <= steps; s++) {
          var rj = r0 + (len - r0) * s / steps, aj = a + rr(-.3, .3);
          cx.lineTo(Math.cos(aj) * rj, Math.sin(aj) * rj);
        }
        cx.stroke();
      }
    }

    /* row 0 -- concrete / render.  The chip is the story: pale mortar
       exposed in a ragged blob, hairline cracks walking away, the dark
       bevelled core in the middle. */
    for (var v0 = 0; v0 < 4; v0++) cell(v0, 0, function () {
      radial(56, [[0, 'rgba(62,58,52,.20)'], [.6, 'rgba(62,58,52,.10)'], [1, 'rgba(62,58,52,0)']]);
      speck(170, 0, 40, 1.2, 4.6, 'rgba(176,169,155,.30)');
      speck(90, 0, 26, 1.2, 4.2, 'rgba(189,182,168,.42)');
      speck(40, 2, 15, 1.4, 3.6, 'rgba(200,194,180,.5)');
      cracks(4 + (Math.random() * 2 | 0), 12, 52, 1.4, 'rgba(24,22,20,.5)');
      radial(19, [[0, 'rgba(206,199,186,.55)'], [.75, 'rgba(206,199,186,.30)'], [1, 'rgba(206,199,186,0)']]);
      radial(13, [[0, '#070605'], [.62, 'rgba(12,11,10,.96)'], [.85, 'rgba(50,46,42,.7)'], [1, 'rgba(120,113,102,0)']]);
      cx.strokeStyle = 'rgba(214,208,196,.5)'; cx.lineWidth = 1.6;
      cx.beginPath(); cx.arc(0, 0, 12.6, 0, Math.PI * 2); cx.stroke();
    });

    /* row 1 -- metal / car paint.  Smaller wound: soot halo, a ring of
       torn paint glinting bare metal, short radial scratches, a punched
       black core with a burr rim. */
    for (var v1 = 0; v1 < 4; v1++) cell(v1, 1, function () {
      radial(30, [[0, 'rgba(18,16,14,.42)'], [.65, 'rgba(18,16,14,.20)'], [1, 'rgba(18,16,14,0)']]);
      speck(46, 8, 19, .8, 2.3, 'rgba(226,229,234,.85)');
      speck(24, 8, 16, .7, 1.8, 'rgba(180,186,194,.7)');
      cracks(5, 9, 26, 1.1, 'rgba(232,236,242,.55)');
      for (var p = 0; p < 6; p++) {
        var pa = Math.random() * Math.PI * 2;
        cx.fillStyle = 'rgba(10,9,8,.6)';
        cx.beginPath();
        cx.moveTo(Math.cos(pa) * 7, Math.sin(pa) * 7);
        cx.lineTo(Math.cos(pa + .35) * rr(12, 17), Math.sin(pa + .35) * rr(12, 17));
        cx.lineTo(Math.cos(pa - .35) * rr(12, 17), Math.sin(pa - .35) * rr(12, 17));
        cx.closePath(); cx.fill();
      }
      radial(9, [[0, '#040404'], [.7, 'rgba(8,8,9,.95)'], [1, 'rgba(30,30,32,0)']]);
      cx.strokeStyle = 'rgba(238,242,248,.5)'; cx.lineWidth = 1.4;
      cx.beginPath(); cx.arc(0, 0, 8.8, 0, Math.PI * 2); cx.stroke();
    });

    /* row 2 -- wood.  Elongated along local x: torn fibre halo, long grain
       cracks, dark splinter core.  The stamp roll randomises the grain
       direction per hit, which on a crate reads as planks torn whichever
       way the round left. */
    for (var v2 = 0; v2 < 4; v2++) cell(v2, 2, function () {
      cx.save(); cx.scale(1.45, .8);
      radial(40, [[0, 'rgba(46,28,14,.30)'], [.7, 'rgba(46,28,14,.12)'], [1, 'rgba(46,28,14,0)']]);
      cx.restore();
      for (var f = 0; f < 46; f++) {
        var fa = rr(-0.45, 0.45) + (Math.random() < .5 ? 0 : Math.PI);
        var fr = rr(6, 34), fl = rr(4, 15);
        cx.strokeStyle = 'rgba(' + (150 + (Math.random() * 60 | 0)) + ',' + (104 + (Math.random() * 40 | 0)) + ',58,.6)';
        cx.lineWidth = rr(.8, 2.1);
        cx.beginPath();
        cx.moveTo(Math.cos(fa) * fr, Math.sin(fa) * fr * .55);
        cx.lineTo(Math.cos(fa) * (fr + fl), Math.sin(fa) * (fr + fl) * .55);
        cx.stroke();
      }
      cracks(2, 14, 50, 1.3, 'rgba(20,12,6,.55)');
      cx.save(); cx.scale(1.5, .85);
      radial(12, [[0, '#0a0704'], [.6, 'rgba(16,10,6,.95)'], [.85, 'rgba(60,38,20,.6)'], [1, 'rgba(120,80,44,0)']]);
      cx.restore();
    });

    /* row 3, cells 0-1 -- glass crack web.  Bright radial spokes, two
       sagging concentric webs, a small dark punch in the middle, a milky
       bruise behind it all. */
    for (var v3 = 0; v3 < 2; v3++) cell(v3, 3, function () {
      radial(44, [[0, 'rgba(214,228,240,.22)'], [.6, 'rgba(214,228,240,.09)'], [1, 'rgba(214,228,240,0)']]);
      var spokes = 9 + (Math.random() * 3 | 0), ang = [], si;
      for (si = 0; si < spokes; si++) ang.push(si / spokes * Math.PI * 2 + rr(-.14, .14));
      for (si = 0; si < spokes; si++) {
        var sr = rr(30, 55);
        cx.strokeStyle = 'rgba(235,244,252,.8)'; cx.lineWidth = rr(.9, 1.5);
        cx.beginPath(); cx.moveTo(Math.cos(ang[si]) * 4, Math.sin(ang[si]) * 4);
        cx.lineTo(Math.cos(ang[si] + rr(-.05, .05)) * sr, Math.sin(ang[si] + rr(-.05, .05)) * sr);
        cx.stroke();
      }
      for (var ring = 0; ring < 2; ring++) {
        var rw = 12 + ring * rr(11, 15);
        cx.strokeStyle = 'rgba(228,238,248,.55)'; cx.lineWidth = 1;
        cx.beginPath();
        for (si = 0; si <= spokes; si++) {
          var aw = ang[si % spokes], rj = rw * rr(.86, 1.1);
          if (si === 0) cx.moveTo(Math.cos(aw) * rj, Math.sin(aw) * rj);
          else cx.lineTo(Math.cos(aw) * rj, Math.sin(aw) * rj);
        }
        cx.stroke();
      }
      radial(6, [[0, 'rgba(6,8,10,.9)'], [1, 'rgba(6,8,10,0)']]);
    });

    /* row 3, cells 2-3 -- blast scorch.  A big soft soot blot with streaky
       rays; stamped floor-flat under every detonation. */
    for (var v4 = 2; v4 < 4; v4++) cell(v4, 3, function () {
      radial(58, [[0, 'rgba(14,12,10,.78)'], [.42, 'rgba(20,17,14,.55)'], [.75, 'rgba(26,22,18,.26)'], [1, 'rgba(26,22,18,0)']]);
      for (var s = 0; s < 26; s++) {
        var sa = Math.random() * Math.PI * 2, r0 = rr(16, 30), r1 = r0 + rr(10, 28);
        cx.strokeStyle = 'rgba(16,14,12,' + rr(.15, .34).toFixed(2) + ')';
        cx.lineWidth = rr(2, 6);
        cx.beginPath(); cx.moveTo(Math.cos(sa) * r0, Math.sin(sa) * r0);
        cx.lineTo(Math.cos(sa) * r1, Math.sin(sa) * r1); cx.stroke();
      }
      speck(20, 4, 22, 1, 3, 'rgba(60,52,44,.4)');
    });

    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    return tex;
  }

  /* atlas cell -> uv rect, inset past the padding so mips stay clean */
  function uvRect(col, row) {
    var inset = (PAD - 2) / (CELLPX * GRIDN), q = 1 / GRIDN;
    return {
      u0: col * q + inset, u1: (col + 1) * q - inset,
      v0: 1 - (row + 1) * q + inset, v1: 1 - row * q - inset
    };
  }
  var ROW = { concrete: 0, metal: 1, wood: 2, glassrow: 3 };

  /* =======================================================================
     SECTION 2 -- the decal pool.  POOL_N quads in one BufferGeometry, one
     material, one draw call.  A slot is written in place and never moves;
     recycling wraps to the oldest.  owner[] ties a slot to the thing it is
     stamped on (a crate id), so a broken crate can take its holes with it. */
  var POOL_N = 224;
  var pool = null;

  function makePool(atlas) {
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(POOL_N * 4 * 3);
    var uv = new Float32Array(POOL_N * 4 * 2);
    var col = new Float32Array(POOL_N * 4 * 3);
    var index = new Uint16Array(POOL_N * 6);
    for (var i = 0; i < POOL_N; i++) {
      var b = i * 4, t = i * 6;
      index[t] = b; index[t + 1] = b + 1; index[t + 2] = b + 2;
      index[t + 3] = b + 2; index[t + 4] = b + 1; index[t + 5] = b + 3;
    }
    var aPos = new THREE.BufferAttribute(pos, 3); aPos.setUsage(THREE.DynamicDrawUsage);
    var aUv = new THREE.BufferAttribute(uv, 2); aUv.setUsage(THREE.DynamicDrawUsage);
    var aCol = new THREE.BufferAttribute(col, 3); aCol.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos);
    geo.setAttribute('uv', aUv);
    geo.setAttribute('color', aCol);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    var mat = new THREE.MeshBasicMaterial({
      map: atlas, transparent: true, depthWrite: false, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'nzdestruct-decals';
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = mesh.receiveShadow = false;
    scene.add(mesh);
    return {
      mesh: mesh, mat: mat, geo: geo, pos: aPos, uv: aUv, col: aCol,
      head: 0, owner: new Array(POOL_N).fill(null),
      /* the recent-hole memory that turns repeat hits into one deepening
         crater rather than a stack of siblings */
      hist: []
    };
  }

  var _t = null, _b = null, _n = null;
  function stamp(px, py, pz, nx, ny, nz, half, col, row, tint, owner) {
    if (!pool) return -1;
    if (!_t) { _t = new THREE.Vector3(); _b = new THREE.Vector3(); _n = new THREE.Vector3(); }
    _n.set(nx, ny, nz).normalize();
    /* any stable perpendicular */
    if (Math.abs(_n.y) > .92) _t.set(1, 0, 0); else _t.set(0, 1, 0);
    _b.crossVectors(_n, _t).normalize();
    _t.crossVectors(_b, _n).normalize();
    var roll = Math.random() * Math.PI * 2, c = Math.cos(roll), s = Math.sin(roll);
    var tx = _t.x * c + _b.x * s, ty = _t.y * c + _b.y * s, tz = _t.z * c + _b.z * s;
    var bx = _b.x * c - _t.x * s, by = _b.y * c - _t.y * s, bz = _b.z * c - _t.z * s;

    var slot = pool.head;
    pool.head = (pool.head + 1) % POOL_N;
    if (pool.head === 0) STATS.poolWraps++;
    pool.owner[slot] = owner || null;

    var P = pool.pos.array, U = pool.uv.array, C = pool.col.array;
    var vb = slot * 4 * 3, ub = slot * 4 * 2;
    /* corners: (-t-b) (t-b) (-t+b) (t+b) */
    var k;
    for (k = 0; k < 4; k++) {
      var sx = (k & 1) ? 1 : -1, sy = (k & 2) ? 1 : -1;
      P[vb + k * 3] = px + (tx * sx + bx * sy) * half;
      P[vb + k * 3 + 1] = py + (ty * sx + by * sy) * half;
      P[vb + k * 3 + 2] = pz + (tz * sx + bz * sy) * half;
    }
    var r = uvRect(col, row);
    U[ub] = r.u0; U[ub + 1] = r.v0;
    U[ub + 2] = r.u1; U[ub + 3] = r.v0;
    U[ub + 4] = r.u0; U[ub + 5] = r.v1;
    U[ub + 6] = r.u1; U[ub + 7] = r.v1;
    for (k = 0; k < 4; k++) {
      C[vb + k * 3] = tint[0]; C[vb + k * 3 + 1] = tint[1]; C[vb + k * 3 + 2] = tint[2];
    }
    pool.pos.needsUpdate = true; pool.uv.needsUpdate = true; pool.col.needsUpdate = true;
    return slot;
  }

  function collapseOwner(owner) {
    if (!pool) return;
    var P = pool.pos.array, any = false;
    for (var i = 0; i < POOL_N; i++) {
      if (pool.owner[i] !== owner) continue;
      for (var k = 0; k < 12; k++) P[i * 12 + k] = 0;
      pool.owner[i] = null; any = true;
    }
    if (any) pool.pos.needsUpdate = true;
  }

  /* deepening: a new static hole within DEEP_R of an old one re-stamps the
     old spot larger and darker instead of littering a twin beside it */
  var DEEP_R = 0.35;
  function deepen(px, py, pz) {
    var h = pool.hist;
    for (var i = h.length - 1; i >= 0; i--) {
      var e = h[i], dx = e.x - px, dy = e.y - py, dz = e.z - pz;
      if (dx * dx + dy * dy + dz * dz < DEEP_R * DEEP_R) { e.n = Math.min(e.n + 1, 4); return e; }
    }
    var rec = { x: px, y: py, z: pz, n: 0 };
    h.push(rec); if (h.length > 28) h.shift();
    return rec;
  }

  /* light-grounded tint: sample the baked light so a hole in a dark corridor
     is not a bright sticker.  Clamped hard -- a decal that goes fully black
     erases its own texture. */
  function tintAt(px, py, pz, nx, ny, nz) {
    var t = [1, 1, 1];
    try {
      if (G.lightAt && G.regAt && G.inb && G.CELL) {
        var cx = Math.floor(px / G.CELL), cz = Math.floor(pz / G.CELL);
        if (G.inb(cx, cz)) {
          var R = G.regAt(cx, cz);
          var c = G.lightAt(px + nx * .4, py + ny * .4, pz + nz * .4, nx, ny, nz, R.amb, true, true);
          if (c && isFinite(c[0])) {
            t[0] = clamp(c[0], .35, 1.3); t[1] = clamp(c[1], .35, 1.3); t[2] = clamp(c[2], .35, 1.3);
          }
        }
      }
    } catch (e) {}
    return t;
  }

  /* =======================================================================
     SECTION 3 -- crates.  HP ledger keyed 'cx,cy', mesh looked up from the
     CRATE_MESHES registry NUKEM.html fills in makeCrates(). */
  var crates = null;   /* key -> {cx, cy, mesh, hp, bruised} */
  var CRATE_HP = 90;   /* 6 pistol, 4 rifle, 2 point-blank shotgun loads */
  var brokenCells = [];   /* [cx, cy] of every crate that has gone */

  function crateMap() {
    if (crates) return crates;
    crates = {};
    var list = G.CRATE_MESHES;
    if (list && list.length) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        crates[c.cx + ',' + c.cy] = { cx: c.cx, cy: c.cy, mesh: c.mesh, hp: CRATE_HP, bruised: false };
      }
    } else warn('CRATE_MESHES registry empty -- crates are not breakable this boot');
    return crates;
  }
  function crateAt(cx, cy) { return crateMap()[cx + ',' + cy] || null; }

  /* nz-env.js merges all 22 stock crates into one pile and pulls the stock
     meshes from the scene, so the thing a hit must decal against -- and the
     thing a break must knock down -- depends on whether env installed.
     NZ.envCrates carries the merged mesh + per-crate index/vertex ranges. */
  function envCrates() { return (NZ.envCrates && NZ.envCrates.mesh) ? NZ.envCrates : null; }
  function envRange(cx, cy) {
    var ec = envCrates();
    if (!ec) return null;
    for (var i = 0; i < ec.ranges.length; i++)
      if (ec.ranges[i].cx === cx && ec.ranges[i].cy === cy) return ec.ranges[i];
    return null;
  }

  var _ray = null, _v1 = null, _v2 = null;
  function crateSurface(rec, hit, normal) {
    /* exact point on the crate: probe along -normal from just off the cell
       plane, against env's merged chamfered pile when it exists, else the
       stock box.  Falls back to the cell plane itself. */
    if (!_ray) { _ray = new THREE.Raycaster(); _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }
    try {
      _v1.set(hit.x + normal.x * 1.5, hit.y + normal.y * 1.5, hit.z + normal.z * 1.5);
      _v2.set(-normal.x, -normal.y, -normal.z);
      _ray.set(_v1, _v2); _ray.far = 4.5;
      var ec = envCrates(), xs;
      if (ec) {
        xs = _ray.intersectObject(ec.mesh, false);
        if (xs.length) return { p: xs[0].point, n: xs[0].face.normal.clone() };
      }
      if (rec.mesh && rec.mesh.parent) {
        xs = _ray.intersectObject(rec.mesh, false);
        if (xs.length) {
          var n = xs[0].face.normal.clone().applyQuaternion(rec.mesh.quaternion);
          return { p: xs[0].point, n: n };
        }
      }
    } catch (e) {}
    return { p: hit, n: normal };
  }

  function bruiseCrate(rec) {
    if (!rec || rec.bruised) return;
    rec.bruised = true;
    /* battered: darken whichever crate is actually being drawn */
    try {
      var rng = envRange(rec.cx, rec.cy), ec = envCrates();
      if (rng && ec) {
        var ca = ec.mesh.geometry.getAttribute('color');
        for (var vi = rng.v0 * 3; vi < rng.v1 * 3; vi++) ca.array[vi] *= .84;
        ca.needsUpdate = true;
      } else rec.mesh.material.color.multiplyScalar(.86);
    } catch (e) {}
  }

  function hitCrate(rec, hit, dir, surface, meta) {
    var s = crateSurface(rec, hit, surface.normal);
    var tint = tintAt(s.p.x, s.p.y, s.p.z, s.n.x, s.n.y, s.n.z);
    stamp(s.p.x + s.n.x * .03, s.p.y + s.n.y * .03, s.p.z + s.n.z * .03,
      s.n.x, s.n.y, s.n.z, rr(.30, .42), (Math.random() * 4) | 0, ROW.wood, tint, 'crate:' + rec.cx + ',' + rec.cy);
    safePuff(s.p, dir, 'wood');
    STATS.crateHits++;
    if (meta && meta.enemy) { if (meta.first) safeSfx('impact_wood', s.p.x, s.p.z); return true; }
    safeSfx('impact_wood', s.p.x, s.p.z);

    rec.hp -= (meta && meta.dmg) || 0;
    if (rec.hp <= CRATE_HP * .5) bruiseCrate(rec);
    if (rec.hp <= 0) breakCrate(rec, dir);
    return true;
  }

  function breakCrate(rec, dir, quiet) {
    var key = rec.cx + ',' + rec.cy;
    if (!crates[key]) return;
    delete crates[key];
    var mesh = rec.mesh;
    var wx = mesh.position.x, wy = mesh.position.y, wz = mesh.position.z;
    var baseCol = null;
    try { baseCol = mesh.material.color.clone(); } catch (e) { baseCol = new THREE.Color(0x6b4a2c); }
    /* knock the drawn crate down.  Under nz-env that means degenerating its
       index range in the merged pile; the stock mesh (orphaned by env, live
       otherwise) is removed either way.  The stock material is only disposed
       when env is NOT holding it in its restore ledger. */
    try {
      var rng = envRange(rec.cx, rec.cy), ec = envCrates();
      if (rng && ec) {
        var ix = ec.mesh.geometry.getIndex();
        var v = ix.array[rng.start];
        for (var k2 = rng.start; k2 < rng.end; k2++) ix.array[k2] = v;
        ix.needsUpdate = true;
      }
      if (mesh.parent) mesh.parent.remove(mesh);
      if (!ec && mesh.material && mesh.material.dispose) mesh.material.dispose();
      /* stock geometry is shared across every crate -- never disposed here */
    } catch (e) {}
    try { if (G.grid && G.idx) G.grid[G.idx(rec.cx, rec.cy)] = G.S_FLOOR; } catch (e) {}
    brokenCells.push([rec.cx, rec.cy]);
    collapseOwner('crate:' + key);
    if (!quiet) {
      spawnDebris(wx, wy, wz, dir, baseCol);
      safeSfx('impact_wood', wx, wz);
      safeSfx('enemy_bodyfall', wx, wz);
      pendingSfx.push({ t: .09, name: 'impact_wood', x: wx, z: wz });
      /* the dust of a collapsing box */
      try {
        if (G.particle) for (var i = 0; i < 7; i++) {
          var p = G.particle('smoke', wx + rr(-1.4, 1.4), wy + rr(-1.4, 1.4), wz + rr(-1.4, 1.4),
            rr(-2.5, 2.5), rr(.5, 3.5), rr(-2.5, 2.5), rr(1.2, 2.4), rr(.5, .9), -2, false);
          p.mat.color.setHex(0x8a6a44);
        }
      } catch (e) {}
      STATS.cratesBroken++;
    }
  }

  function snapshotState() {
    var map = crateMap(), live = [], glass = [], key;
    for (key in map) if (Object.prototype.hasOwnProperty.call(map, key)) {
      var rec = map[key];
      live.push({ cx: rec.cx, cy: rec.cy, hp: rec.hp, bruised: !!rec.bruised });
    }
    if (HGLASS.ready) for (var gi = 0; gi < HGLASS.states.length; gi++) {
      var st = HGLASS.states[gi], pieces = st.stage > 0 ? buildPanePieces(st) : [];
      glass.push({
        id: st.desc.id, stage: st.stage, energy: st.energy,
        impacts: st.impacts.map(function (im) { return { u: im.u, v: im.v }; }),
        removed: pieces.filter(function (piece) { return piece.removed; }).map(function (piece) { return piece.id; })
      });
    }
    return {
      v: 1,
      crates: live,
      broken: brokenCells.map(function (cell) { return [cell[0], cell[1]]; }),
      glass: glass
    };
  }

  function restoreGlass(saved) {
    if (!HGLASS.ready || !Array.isArray(saved)) return;
    for (var i = 0; i < Math.min(saved.length, HGLASS.states.length); i++) {
      var src = saved[i], st = HGLASS.states[i];
      if (!src || src.id !== st.desc.id || !Number.isInteger(src.stage) || src.stage < 1 || src.stage > 4) continue;
      var pieces = buildPanePieces(st), gone = Object.create(null);
      if (Array.isArray(src.removed)) for (var r = 0; r < src.removed.length; r++)
        if (Number.isInteger(src.removed[r])) gone[src.removed[r]] = true;
      for (var p = 0; p < pieces.length; p++) pieces[p].removed = gone[pieces[p].id] === true;
      st.stage = src.stage;
      st.energy = isFinite(src.energy) ? Math.max(0, src.energy) : 0;
      st.impacts = [];
      if (Array.isArray(src.impacts)) for (var q = 0; q < Math.min(8, src.impacts.length); q++) {
        var im = src.impacts[q];
        if (!im || !isFinite(im.u) || !isFinite(im.v)) continue;
        st.impacts.push({ u: clamp(im.u, -st.desc.width * .5, st.desc.width * .5),
          v: clamp(im.v, -st.desc.height * .5, st.desc.height * .5) });
      }
      if (HGLASS.instanced) {
        HGLASS.instanced.setMatrixAt(st.index, paneMatrix(st.desc, 0, 0));
        HGLASS.instanced.instanceMatrix.needsUpdate = true;
      }
      ensureRoom(st); rebuildPane(st);
      STATS.panesCracked++;
      if (st.stage === 4) STATS.panesCollapsed++;
    }
  }

  function validateState(saved) {
    if (!saved || saved.v !== 1 || !Array.isArray(saved.crates) || !Array.isArray(saved.broken) ||
        !Array.isArray(saved.glass)) return false;
    var map = crateMap(), all = Object.create(null), seenKeys = Object.create(null), i, cell, key;
    for (key in map) if (Object.prototype.hasOwnProperty.call(map, key)) all[key] = true;
    for (i = 0; i < brokenCells.length; i++) {
      cell = brokenCells[i];
      if (!Array.isArray(cell) || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) return false;
      all[cell[0] + ',' + cell[1]] = true;
    }
    for (i = 0; i < saved.broken.length; i++) {
      cell = saved.broken[i];
      if (!Array.isArray(cell) || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) return false;
      key = cell[0] + ',' + cell[1];
      if (!all[key] || seenKeys[key]) return false;
      seenKeys[key] = true;
    }
    for (i = 0; i < saved.crates.length; i++) {
      var src = saved.crates[i];
      if (!src || !Number.isInteger(src.cx) || !Number.isInteger(src.cy) ||
          !Number.isFinite(src.hp) || src.hp < 1 || src.hp > CRATE_HP || typeof src.bruised !== 'boolean') return false;
      key = src.cx + ',' + src.cy;
      if (!all[key] || seenKeys[key]) return false;
      seenKeys[key] = true;
    }
    for (key in all) if (Object.prototype.hasOwnProperty.call(all, key) && !seenKeys[key]) return false;
    if (!HGLASS.ready) return saved.glass.length === 0;
    if (saved.glass.length !== HGLASS.states.length) return false;
    for (i = 0; i < HGLASS.states.length; i++) {
      var gs = saved.glass[i], st = HGLASS.states[i];
      if (!gs || gs.id !== st.desc.id || !Number.isInteger(gs.stage) || gs.stage < 0 || gs.stage > 4 ||
          !Number.isFinite(gs.energy) || gs.energy < 0 || !Array.isArray(gs.impacts) ||
          gs.impacts.length > 8 || !Array.isArray(gs.removed)) return false;
      var pieces = gs.stage > 0 ? buildPanePieces(st) : [], ids = Object.create(null);
      for (var pi = 0; pi < pieces.length; pi++) ids[pieces[pi].id] = true;
      for (var qi = 0; qi < gs.impacts.length; qi++) {
        var im = gs.impacts[qi];
        if (!im || !Number.isFinite(im.u) || !Number.isFinite(im.v)) return false;
      }
      for (var ri = 0; ri < gs.removed.length; ri++)
        if (!Number.isInteger(gs.removed[ri]) || !ids[gs.removed[ri]]) return false;
    }
    return true;
  }

  function restoreState(saved) {
    if (!validateState(saved)) return false;
    var map = crateMap(), i, cell, rec;
    for (i = 0; i < saved.broken.length; i++) {
      cell = saved.broken[i];
      if (!Array.isArray(cell) || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) continue;
      rec = map[cell[0] + ',' + cell[1]];
      if (rec) breakCrate(rec, null, true);
    }
    for (i = 0; i < saved.crates.length; i++) {
      var src = saved.crates[i];
      if (!src || !Number.isInteger(src.cx) || !Number.isInteger(src.cy)) continue;
      rec = map[src.cx + ',' + src.cy];
      if (!rec || !isFinite(src.hp)) continue;
      rec.hp = clamp(src.hp, 1, CRATE_HP);
      if (src.bruised || rec.hp <= CRATE_HP * .5) bruiseCrate(rec);
    }
    restoreGlass(saved.glass);
    return true;
  }

  /* =======================================================================
     SECTION 4 -- debris.  Tumbling plank chunks, one shared unit cube,
     per-chunk tinted material, gravity + a couple of floor bounces, then a
     shrink-out.  Capped; the oldest chunk pays for the newest. */
  var debris = [], DEBRIS_MAX = 84, debrisGeo = null;
  var pendingSfx = [];

  function spawnDebris(wx, wy, wz, dir, baseCol) {
    if (!debrisGeo) debrisGeo = new THREE.BoxGeometry(1, 1, 1);
    var dx = dir ? dir.x : 0, dz = dir ? dir.z : 0;
    var n = 12;
    for (var i = 0; i < n; i++) {
      /* planks and stubs: long thin, and squat corner blocks */
      var plank = Math.random() < .62;
      var sx = plank ? rr(.9, 1.7) : rr(.4, .8);
      var sy = plank ? rr(.14, .26) : rr(.3, .6);
      var sz = plank ? rr(.3, .55) : rr(.4, .8);
      /* baseCol is the crate's LIGHT tint (its map carried the wood look),
         so the plank albedo is multiplied in here: weathered face outside,
         paler torn fibre inside */
      var albedo = Math.random() < .5 ? 0x8a6a40 : 0xa8845a;
      var col = baseCol.clone().multiply(new THREE.Color(albedo));
      col.multiplyScalar(rr(.78, 1.12));
      var mat = new THREE.MeshBasicMaterial({ color: col });
      var msh = new THREE.Mesh(debrisGeo, mat);
      msh.scale.set(sx, sy, sz);
      msh.position.set(wx + rr(-1.4, 1.4), wy + rr(-1.6, 1.8), wz + rr(-1.4, 1.4));
      msh.rotation.set(rr(0, 6.3), rr(0, 6.3), rr(0, 6.3));
      msh.castShadow = msh.receiveShadow = false;
      scene.add(msh);
      debris.push({
        mesh: msh, mat: mat,
        vx: dx * rr(1.5, 5) + rr(-4.5, 4.5), vy: rr(2.5, 9.5), vz: dz * rr(1.5, 5) + rr(-4.5, 4.5),
        rx: rr(-7, 7), ry: rr(-7, 7), rz: rr(-7, 7),
        life: rr(2.3, 3.6), bounces: 0, half: sy * .5
      });
    }
    while (debris.length > DEBRIS_MAX) killDebris(0);
    if (debris.length > STATS.debrisPeak) STATS.debrisPeak = debris.length;
  }

  function killDebris(i) {
    var d = debris[i];
    try { scene.remove(d.mesh); d.mat.dispose(); } catch (e) {}
    debris.splice(i, 1);
  }

  function updateDebris(dt) {
    for (var i = pendingSfx.length - 1; i >= 0; i--) {
      var q = pendingSfx[i];
      if ((q.t -= dt) <= 0) { safeSfx(q.name, q.x, q.z); pendingSfx.splice(i, 1); }
    }
    if (!debris.length) return;
    for (var j = debris.length - 1; j >= 0; j--) {
      var d = debris[j];
      d.life -= dt;
      if (d.life <= 0) { killDebris(j); continue; }
      d.vy -= 30 * dt;
      var m = d.mesh;
      m.position.x += d.vx * dt; m.position.y += d.vy * dt; m.position.z += d.vz * dt;
      m.rotation.x += d.rx * dt; m.rotation.y += d.ry * dt; m.rotation.z += d.rz * dt;
      var fl = 0;
      try { fl = G.highestFloor ? G.highestFloor(m.position.x, m.position.z, .05) : 0; } catch (e) {}
      if (m.position.y < fl + d.half && d.vy < 0) {
        m.position.y = fl + d.half;
        d.bounces++;
        if (d.bounces > 2) { d.vx = d.vy = d.vz = 0; d.rx = d.ry = d.rz = 0; }
        else {
          d.vy *= -.32; d.vx *= .6; d.vz *= .6;
          d.rx *= .5; d.ry *= .5; d.rz *= .5;
        }
      }
      if (d.life < .45) { var k = d.life / .45; m.scale.multiplyScalar(Math.pow(k, dt * 6)); }
    }
  }

  /* =======================================================================
     SECTION 5 -- the two photographed apartment facades.

     nz-street publishes every A-BLOK/B-BLOK pane as an analytic rectangle
     plus one merged fallback mesh.  At install the fallback is replaced by a
     single InstancedMesh, preserving the intact one-draw-call facade.  Only a
     pane that has actually been hit becomes its own procedural triangle mesh.

     The grid remains collision truth.  We re-intersect the player's original
     ray with the decorative pane planes because castWall reports the solid
     cell boundary, not the recessed sash or loggia screen.  Missing triangles
     no longer block that analytic ray, so later rounds can reach the back sash
     through a collapsed balcony screen. */
  var HGLASS = {
    source: null, panes: [], states: [], instanced: null, planeGeo: null,
    roomDefs: Object.create(null), rooms: Object.create(null),
    boxGeo: null, mats: Object.create(null), roomPools: Object.create(null),
    shardGeo: null, shardPool: null, shardMat: null, crackMat: null,
    debris: [], debrisSeq: 0, ready: false
  };
  var GLASS_DEBRIS_MAX = 96;
  var ROOM_BOX_CAP = 8192;

  function hhash(n) {
    var h = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return h - Math.floor(h);
  }
  function paneTint(d) {
    var c = d.bakedTint || d.tint || [0.45, 0.52, 0.56];
    return [clamp(c[0], 0.035, 1.4), clamp(c[1], 0.035, 1.4), clamp(c[2], 0.035, 1.4)];
  }
  function panePoint(d, u, v, push) {
    push = push || 0;
    return [
      d.center[0] + d.tangent[0] * u + d.normal[0] * push,
      d.center[1] + v,
      d.center[2] + d.tangent[2] * u + d.normal[2] * push
    ];
  }
  function paneMatrix(d, sx, sy) {
    var x = new THREE.Vector3(d.tangent[0], 0, d.tangent[2]);
    var y = new THREE.Vector3(0, 1, 0);
    var z = new THREE.Vector3(d.normal[0], 0, d.normal[2]);
    var basis = new THREE.Matrix4().makeBasis(x, y, z);
    var q = new THREE.Quaternion().setFromRotationMatrix(basis);
    var p = new THREE.Vector3(d.center[0], d.center[1], d.center[2]);
    return new THREE.Matrix4().compose(p, q, new THREE.Vector3(sx, sy, 1));
  }

  function buildRoomDefs() {
    HGLASS.roomDefs = Object.create(null);
    for (var i = 0; i < HGLASS.panes.length; i++) {
      var d = HGLASS.panes[i], key = String(d.room || d.id), R = HGLASS.roomDefs[key];
      if (!R) {
        R = HGLASS.roomDefs[key] = {
          key: key, anchor: d.center.slice(), tangent: d.tangent.slice(), normal: d.normal.slice(),
          minU: -d.width * .5, maxU: d.width * .5,
          minY: d.center[1] - d.height * .5, maxY: d.center[1] + d.height * .5,
          floorY: d.floorY, depth: d.roomDepth, kind: d.roomKind || 'flat',
          seed: d.seed, panes: [i]
        };
      } else {
        var dx = d.center[0] - R.anchor[0], dz = d.center[2] - R.anchor[2];
        var u = dx * R.tangent[0] + dz * R.tangent[2];
        R.minU = Math.min(R.minU, u - d.width * .5);
        R.maxU = Math.max(R.maxU, u + d.width * .5);
        R.minY = Math.min(R.minY, d.center[1] - d.height * .5);
        R.maxY = Math.max(R.maxY, d.center[1] + d.height * .5);
        R.floorY = Math.min(R.floorY, d.floorY);
        R.depth = Math.max(R.depth, d.roomDepth);
        R.panes.push(i);
      }
    }
  }

  /* MISSION 4 IS DAYLIGHT, AND THESE MATERIALS ARE MADE AT RUNTIME.
     Everything nz-street*.js builds goes through NZ.street.day() at load, which
     renames it 'nzday:*', hands it the daylight probe on material.envMap and
     attaches the shared shader patch (the analytic hemisphere, the aerial
     perspective and the tonal grade). Nothing here does, because none of it
     exists until a window breaks -- so on THE CORDON the revealed rooms behind
     a shot-out hero window, and the tempered-glass shards off a car, were lit
     by the NIGHT rig, unhazed and ungraded, inside a sunny graded frame. They
     came out cold, flat and about a stop dark against the wall they had just
     fallen out of.
     One call fixes it, and it is a no-op on every other mission. */
  function dayLit(mat, name, opts) {
    try {
      if (!mat || NZ.level !== 4) return mat;
      var ST = NZ.street;
      if (!ST || typeof ST.day !== 'function') return mat;
      var o = opts || {};
      o.name = name;
      ST.day(mat, o);
    } catch (e) { /* the module is optional; never let it break destruction */ }
    return mat;
  }

  function roomMaterial(name, hex, rough, metal) {
    if (HGLASS.mats[name]) return HGLASS.mats[name];
    var mat = new THREE.MeshStandardMaterial({
      color: hex, roughness: rough === undefined ? .88 : rough,
      metalness: metal || 0, side: THREE.FrontSide
    });
    mat.name = 'nzdestruct-room-' + name;
    dayLit(mat, 'destruct-room-' + name, { intensity: 0.55 });
    HGLASS.mats[name] = mat;
    return mat;
  }
  function roomPool(mat) {
    var key = mat.uuid || mat.name, p = HGLASS.roomPools[key];
    if (p) return p;
    var mesh = new THREE.InstancedMesh(HGLASS.boxGeo, mat, ROOM_BOX_CAP);
    mesh.name = 'nzdestruct-room-pool-' + (mat.name || key);
    mesh.count = 0; mesh.frustumCulled = false;
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
    return (HGLASS.roomPools[key] = { mesh: mesh, count: 0 });
  }
  function roomBox(root, mat, x, y, z, sx, sy, sz, name) {
    var p = roomPool(mat), label = name || 'room-prop';
    root.userData.contents = root.userData.contents || [];
    root.userData.contents.push(label);
    if (p.count >= ROOM_BOX_CAP) { warn('room instance pool full: ' + mat.name); return null; }
    root.updateMatrixWorld(true);
    var local = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), new THREE.Quaternion(),
      new THREE.Vector3(Math.max(.02, sx), Math.max(.02, sy), Math.max(.02, sz)));
    var world = new THREE.Matrix4().multiplyMatrices(root.matrixWorld, local);
    p.mesh.setMatrixAt(p.count++, world); p.mesh.count = p.count;
    p.mesh.instanceMatrix.needsUpdate = true;
    return p.mesh;
  }
  function ensureRoom(st) {
    var d = st.desc, key = String(d.room || d.id);
    if (HGLASS.rooms[key]) { st.room = HGLASS.rooms[key]; return HGLASS.rooms[key]; }
    var R = HGLASS.roomDefs[key];
    if (!R || !HGLASS.boxGeo) return null;
    var root = new THREE.Group();
    root.name = 'nzdestruct-room-' + key;
    root.position.set(R.anchor[0], R.anchor[1], R.anchor[2]);
    var basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(R.tangent[0], 0, R.tangent[2]),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(R.normal[0], 0, R.normal[2]));
    root.quaternion.setFromRotationMatrix(basis);

    var seed = R.seed || 1, width = Math.max(1.2, R.maxU - R.minU + .42);
    var cx = (R.minU + R.maxU) * .5;
    var floor = Math.min(R.floorY, R.minY - .15), ceil = Math.max(R.maxY + .55, floor + 7.6);
    var ly0 = floor - R.anchor[1], ly1 = ceil - R.anchor[1], depth = Math.max(2.4, R.depth);
    var wall = roomMaterial('wall' + ((seed * 9) | 0) % 3,
      [0x68554a, 0x586458, 0x5d4e58][((seed * 9) | 0) % 3], .96, 0);
    var side = roomMaterial('plaster', 0x55514b, .98, 0);
    var floorMat = roomMaterial('floor', 0x30251e, .82, 0);
    var dark = roomMaterial('dark', 0x161719, .74, .03);
    var wood = roomMaterial('wood', 0x6e4c30, .76, 0);
    var fabric = roomMaterial('fabric' + (((seed * 13) | 0) & 1),
      (((seed * 13) | 0) & 1) ? 0x704437 : 0x284f5c, 1, 0);
    var light = roomMaterial('light', 0xd7b36a, .92, 0);
    var plant = roomMaterial('plant', 0x2f6b3a, 1, 0);
    var metal = roomMaterial('metal', 0x777b78, .40, .55);
    var art = roomMaterial('art', 0xb77743, .88, 0);
    var cushion = roomMaterial('cushion', 0xd0a349, .96, 0);

    /* Flats/lobbies need a shallow visual shell because the collision grid is
       still solid behind them.  A balcony already has an authored recess,
       slab, cheeks and rear sash in nz-street; placing another opaque wall in
       front of that sash would defeat the layered front-to-back reveal. */
    if (R.kind !== 'balcony') {
      roomBox(root, wall, cx, (ly0 + ly1) * .5, -depth, width, ly1 - ly0, .16, 'back-wall');
      roomBox(root, floorMat, cx, ly0, -depth * .52, width, .12, depth, 'floor');
      roomBox(root, side, R.minU - .16, (ly0 + ly1) * .5, -depth * .52, .18, ly1 - ly0, depth, 'left-wall');
      roomBox(root, side, R.maxU + .16, (ly0 + ly1) * .5, -depth * .52, .18, ly1 - ly0, depth, 'right-wall');
      roomBox(root, side, cx, ly1, -depth * .52, width, .12, depth, 'ceiling');
      roomBox(root, light, cx, ly1 - .10, -depth * .50, Math.min(1.15, width * .28), .08, .52,
        'ceiling-light');
    }

    var usable = Math.max(.9, width - .55), flip = hhash(seed * 5.7) < .5 ? -1 : 1;
    if (R.kind === 'balcony') {
      /* A loggia reads from a few large, exterior objects: planter, chair,
         storage bench and a compact café table. */
      roomBox(root, wood, cx - flip * usable * .30, ly0 + .34, -depth * .55,
        Math.min(2.2, usable * .34), .55, .55, 'planter-box');
      roomBox(root, plant, cx - flip * usable * .30, ly0 + 2.05, -depth * .55,
        Math.min(1.8, usable * .28), 2.45, .48, 'planter');
      roomBox(root, metal, cx + flip * usable * .18, ly0 + 1.05, -depth * .50,
        .16, 2.05, .16, 'table-stem');
      roomBox(root, wood, cx + flip * usable * .18, ly0 + 2.08, -depth * .50,
        1.35, .14, .86, 'table-top');
      roomBox(root, fabric, cx + flip * usable * .36, ly0 + 1.12, -depth * .30,
        .96, .22, .82, 'chair-seat');
      roomBox(root, fabric, cx + flip * usable * .36, ly0 + 2.12, -depth * .64,
        .96, 1.90, .18, 'chair-back');
    } else if (R.kind === 'lobby') {
      roomBox(root, dark, cx, (ly0 + ly1) * .5, -depth + .10,
        Math.min(width * .46, 3.0), Math.min(ly1 - ly0 - .5, 5.8), .18, 'inner-door');
      roomBox(root, metal, cx - usable * .33, ly0 + 1.75, -depth + .24,
        Math.min(1.45, usable * .22), 2.25, .28, 'mailboxes');
      roomBox(root, fabric, cx, ly0 + .08, -depth * .42,
        Math.min(2.6, usable * .55), .06, 1.05, 'entry-mat');
      roomBox(root, light, cx + usable * .34, ly0 + 2.7, -depth + .25,
        .58, .80, .16, 'wall-light');
    } else {
      /* A sofa silhouette, rug, cabinet, television and lamp are all visible
         through a one-pane hole, so the opening reads as a real occupied flat
         before the player is close enough to inspect small props. */
      var sofaW = Math.min(4.8, Math.max(1.35, usable * .78));
      var sofaX = cx - flip * usable * .04;
      roomBox(root, fabric, sofaX, ly0 + 1.02, -depth * .42,
        sofaW, 1.12, 1.08, 'sofa-base');
      roomBox(root, fabric, sofaX, ly0 + 2.62, -depth * .57,
        sofaW, 2.35, .38, 'sofa-back');
      roomBox(root, fabric, sofaX - sofaW * .48, ly0 + 1.90, -depth * .42,
        .34, 2.55, 1.08, 'sofa-arm');
      roomBox(root, fabric, sofaX + sofaW * .48, ly0 + 1.90, -depth * .42,
        .34, 2.55, 1.08, 'sofa-arm');
      roomBox(root, cushion, sofaX - sofaW * .23, ly0 + 3.08, -depth * .37,
        Math.min(.82, sofaW * .24), 1.00, .20, 'sofa-cushion');
      roomBox(root, art, sofaX + sofaW * .20, ly0 + 3.08, -depth * .37,
        Math.min(.82, sofaW * .24), 1.00, .20, 'sofa-cushion');
      roomBox(root, wood, cx + flip * usable * .33, ly0 + 1.10, -depth + .34,
        Math.min(1.8, usable * .25), 2.10, .48, 'tv-cabinet');
      roomBox(root, dark, cx + flip * usable * .33, ly0 + 3.55, -depth + .18,
        Math.min(2.0, usable * .29), 2.15, .14, 'television');
      roomBox(root, wood, cx + flip * usable * .06, ly0 + .43, -depth * .18,
        Math.min(1.85, usable * .45), .18, .82, 'coffee-table');
      roomBox(root, fabric, cx, ly0 + .055, -depth * .48,
        Math.min(3.8, usable * .62), .05, Math.min(2.4, depth * .55), 'rug');
      roomBox(root, metal, cx - flip * usable * .40, ly0 + 2.10, -depth * .42,
        .10, 4.05, .10, 'lamp-stand');
      roomBox(root, light, cx - flip * usable * .40, ly0 + 4.18, -depth * .42,
        .82, 1.10, .82, 'lamp-shade');
      roomBox(root, dark, cx - flip * usable * .24, ly0 + 3.75, -depth + .12,
        Math.min(1.65, usable * .30), 1.35, .10, 'picture-frame');
      roomBox(root, art, cx - flip * usable * .24, ly0 + 3.75, -depth + .18,
        Math.min(1.38, usable * .25), 1.08, .08, 'picture');
    }
    scene.add(root);
    HGLASS.rooms[key] = root; st.room = root;
    STATS.roomsRevealed++;
    return root;
  }

  function buildPanePieces(st) {
    if (st.pieces) return st.pieces;
    var d = st.desc, cols = clamp(Math.round(d.width / .72), 4, 9);
    var rows = clamp(Math.round(d.height / .72), 4, 10);
    var du = d.width / cols, dv = d.height / rows, pts = [], r, c;
    for (r = 0; r <= rows; r++) {
      var row = [];
      for (c = 0; c <= cols; c++) {
        var u = -d.width * .5 + c * du, v = -d.height * .5 + r * dv;
        if (c > 0 && c < cols) u += (hhash(d.seed * 3.1 + r * 71 + c * 17) - .5) * du * .34;
        if (r > 0 && r < rows) v += (hhash(d.seed * 5.3 + r * 29 + c * 53) - .5) * dv * .34;
        row.push([u, v]);
      }
      pts.push(row);
    }
    var out = [], id = 0;
    function add(a, b, q, edge) {
      out.push({
        id: id, v: [a, b, q],
        u: (a[0] + b[0] + q[0]) / 3, y: (a[1] + b[1] + q[1]) / 3,
        edge: edge, tough: hhash(d.seed * 11.7 + id * 19.31), removed: false
      }); id++;
    }
    for (r = 0; r < rows; r++) for (c = 0; c < cols; c++) {
      var p00 = pts[r][c], p10 = pts[r][c + 1], p01 = pts[r + 1][c], p11 = pts[r + 1][c + 1];
      var edge = (r === 0 || c === 0 || r === rows - 1 || c === cols - 1);
      if (hhash(d.seed * 7.9 + r * 37 + c * 61) < .5) {
        add(p00, p10, p11, edge); add(p00, p11, p01, edge);
      } else {
        add(p00, p10, p01, edge); add(p10, p11, p01, edge);
      }
    }
    st.pieces = out;
    return out;
  }

  function pointInTri(px, py, a, b, c) {
    var v0x = c[0] - a[0], v0y = c[1] - a[1];
    var v1x = b[0] - a[0], v1y = b[1] - a[1];
    var v2x = px - a[0], v2y = py - a[1];
    var dot00 = v0x * v0x + v0y * v0y, dot01 = v0x * v1x + v0y * v1y;
    var dot02 = v0x * v2x + v0y * v2y, dot11 = v1x * v1x + v1y * v1y;
    var dot12 = v1x * v2x + v1y * v2y;
    var inv = 1 / Math.max(1e-8, dot00 * dot11 - dot01 * dot01);
    var u = (dot11 * dot02 - dot01 * dot12) * inv;
    var v = (dot00 * dot12 - dot01 * dot02) * inv;
    return u >= -.015 && v >= -.015 && u + v <= 1.015;
  }
  function paneBlocksAt(st, u, v) {
    if (!st || st.stage === 0) return true;
    var pieces = buildPanePieces(st);
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      if (pointInTri(u, v, p.v[0], p.v[1], p.v[2])) return !p.removed;
    }
    return false;
  }

  /* Normal-space distance from a pane to the collision face that caused
     hitscan's coarse wall stop.  Rear loggia sashes are deliberately several
     units behind that face; ordinary windows/doors are only a shallow reveal. */
  function paneHostDepth(d) {
    return String(d.room || '').indexOf(':loggia-back:') >= 0 ? 4.75 : 1.20;
  }

  function setGeoAttributes(geo, pos, nor, uv, col) {
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    var ua = new THREE.Float32BufferAttribute(uv, 2);
    geo.setAttribute('uv', ua); geo.setAttribute('uv2', ua.clone());
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
  }

  function killGlassDebris(i) {
    HGLASS.debris.splice(i, 1);
  }
  var _gMotion = null, _gFinal = null, _gPos = null, _gQuat = null,
      _gScale = null, _gEuler = null, _gColor = null;
  function syncGlassDebris() {
    var pool = HGLASS.shardPool;
    if (!pool) return;
    if (!_gMotion) {
      _gMotion = new THREE.Matrix4(); _gFinal = new THREE.Matrix4();
      _gPos = new THREE.Vector3(); _gQuat = new THREE.Quaternion();
      _gScale = new THREE.Vector3(); _gEuler = new THREE.Euler();
      _gColor = new THREE.Color();
    }
    for (var i = 0; i < HGLASS.debris.length; i++) {
      var d = HGLASS.debris[i];
      _gPos.set(d.x, d.y, d.z); _gEuler.set(d.ax, d.ay, d.az);
      _gQuat.setFromEuler(_gEuler); _gScale.setScalar(d.scale);
      _gMotion.compose(_gPos, _gQuat, _gScale);
      _gFinal.multiplyMatrices(_gMotion, d.shape);
      pool.setMatrixAt(i, _gFinal);
      _gColor.setRGB(d.color[0], d.color[1], d.color[2]); pool.setColorAt(i, _gColor);
    }
    pool.count = HGLASS.debris.length;
    pool.instanceMatrix.needsUpdate = true;
    if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
  }
  function spawnGlassShard(st, piece, dir, power) {
    if (!HGLASS.shardMat || !HGLASS.shardPool) return;
    var d = st.desc, cv = paneTint(d), cu = piece.u, cy = piece.y;
    var centre = panePoint(d, cu, cy, .045), pts = [];
    for (var k = 0; k < 3; k++) {
      var w = panePoint(d, piece.v[k][0], piece.v[k][1], .045);
      pts.push([w[0] - centre[0], w[1] - centre[1], w[2] - centre[2]]);
    }
    var a = pts[0], b = pts[1], c = pts[2];
    var e1 = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    var e2 = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    var nn = new THREE.Vector3().crossVectors(e1, e2).normalize().multiplyScalar(.035);
    var shape = new THREE.Matrix4().set(
      e1.x, e2.x, nn.x, a[0],
      e1.y, e2.y, nn.y, a[1],
      e1.z, e2.z, nn.z, a[2],
      0, 0, 0, 1);
    var kick = clamp((power || 24) / 18, .65, 3.2), tx = d.tangent[0], tz = d.tangent[2];
    HGLASS.debris.push({
      id: ++HGLASS.debrisSeq, shape: shape, color: cv,
      x: centre[0], y: centre[1], z: centre[2],
      vx: d.normal[0] * rr(1.4, 3.8) * kick + tx * rr(-2.3, 2.3),
      vy: rr(.5, 4.8) - Math.abs(piece.y / d.height) * 1.2,
      vz: d.normal[2] * rr(1.4, 3.8) * kick + tz * rr(-2.3, 2.3),
      rx: rr(-8, 8), ry: rr(-8, 8), rz: rr(-8, 8),
      ax: 0, ay: 0, az: 0, scale: 1,
      life: rr(5.0, 8.0), bounces: 0, settled: false, half: .035
    });
    while (HGLASS.debris.length > GLASS_DEBRIS_MAX) killGlassDebris(0);
    STATS.glassDebrisPeak = Math.max(STATS.glassDebrisPeak, HGLASS.debris.length);
  }

  function updateGlassDebris(dt) {
    for (var i = HGLASS.debris.length - 1; i >= 0; i--) {
      var d = HGLASS.debris[i]; d.life -= dt;
      if (d.life <= 0) { killGlassDebris(i); continue; }
      if (!d.settled) {
        d.vy -= 28 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.ax += d.rx * dt; d.ay += d.ry * dt; d.az += d.rz * dt;
        var fl = 0;
        try { fl = G.highestFloor ? G.highestFloor(d.x, d.z, .05) : 0; } catch (e) {}
        if (d.y < fl + d.half && d.vy < 0) {
          d.y = fl + d.half; d.bounces++;
          if (d.bounces > 2) {
            d.vx = d.vy = d.vz = 0; d.rx = d.ry = d.rz = 0; d.settled = true;
          } else { d.vy *= -.25; d.vx *= .62; d.vz *= .62; }
        }
      }
      d.scale = d.life < .55 ? clamp(d.life / .55, 0, 1) : 1;
    }
    syncGlassDebris();
  }

  function rebuildPane(st) {
    var d = st.desc, pieces = buildPanePieces(st), cv = paneTint(d);
    var pos = [], nor = [], uv = [], col = [], cracks = [], kept = 0;
    var edges = Object.create(null);
    function pointKey(p) { return p[0].toFixed(4) + ',' + p[1].toFixed(4); }
    for (var i = 0; i < pieces.length; i++) {
      var pc = pieces[i];
      for (var ee = 0; ee < 3; ee++) {
        var ea = pc.v[ee], eb = pc.v[(ee + 1) % 3];
        var ka = pointKey(ea), kb = pointKey(eb), ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        var er = edges[ek] || (edges[ek] = { a: ea, b: eb, kept: 0, removed: 0 });
        if (pc.removed) er.removed++; else er.kept++;
      }
      if (pc.removed) continue; kept++;
      for (var k = 0; k < 3; k++) {
        var w = panePoint(d, pc.v[k][0], pc.v[k][1], .018);
        pos.push(w[0], w[1], w[2]); nor.push(d.normal[0], 0, d.normal[2]);
        uv.push(pc.v[k][0] / d.width + .5, pc.v[k][1] / d.height + .5);
        col.push(cv[0], cv[1], cv[2]);
      }
    }
    /* Only the jagged boundary between a missing and a retained fragment is
       outlined.  The former all-triangle pass doubled shared edges and read
       as a regular wireframe rather than a fracture. */
    for (var edgeKey in edges) if (Object.prototype.hasOwnProperty.call(edges, edgeKey)) {
      var edge = edges[edgeKey];
      if (!edge.kept || !edge.removed) continue;
      var wa = panePoint(d, edge.a[0], edge.a[1], .036);
      var wb = panePoint(d, edge.b[0], edge.b[1], .036);
      cracks.push(wa[0], wa[1], wa[2], wb[0], wb[1], wb[2]);
    }
    /* Early impacts also get a small, deterministic crooked radial star. */
    if (st.stage <= 2) for (var q = 0; q < st.impacts.length; q++) {
      var im = st.impacts[q], rays = 5 + st.stage;
      for (var r = 0; r < rays; r++) {
        var ang = (r / rays) * Math.PI * 2 + hhash(d.seed * 1.91 + q * 17) * .7;
        var len = Math.min(d.width, d.height) * (.16 + .07 * hhash(d.seed * 3.7 + q * 31 + r));
        var eu = clamp(im.u + Math.cos(ang) * len, -d.width * .5, d.width * .5);
        var ev = clamp(im.v + Math.sin(ang) * len, -d.height * .5, d.height * .5);
        var rs = panePoint(d, im.u, im.v, .038), re = panePoint(d, eu, ev, .038);
        cracks.push(rs[0], rs[1], rs[2], re[0], re[1], re[2]);
      }
    }
    if (st.mesh) { scene.remove(st.mesh); st.mesh.geometry.dispose(); st.mesh = null; }
    if (st.cracks) { scene.remove(st.cracks); st.cracks.geometry.dispose(); st.cracks = null; }
    if (pos.length) {
      var geo = new THREE.BufferGeometry(); setGeoAttributes(geo, pos, nor, uv, col);
      st.mesh = new THREE.Mesh(geo, HGLASS.source.material);
      st.mesh.name = 'nzdestruct-pane-' + d.id; st.mesh.frustumCulled = true;
      st.mesh.castShadow = false; st.mesh.receiveShadow = true; scene.add(st.mesh);
    }
    if (cracks.length && HGLASS.crackMat) {
      var cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cracks, 3));
      cg.computeBoundingSphere(); st.cracks = new THREE.LineSegments(cg, HGLASS.crackMat);
      st.cracks.name = 'nzdestruct-cracks-' + d.id; st.cracks.frustumCulled = true; scene.add(st.cracks);
    }
    st.remaining = pieces.length ? kept / pieces.length : 0;
  }

  function damagePane(st, u, v, damage, dir, blast) {
    var pieces = buildPanePieces(st), wasStage = st.stage;
    if (wasStage === 0 && HGLASS.instanced) {
      HGLASS.instanced.setMatrixAt(st.index, paneMatrix(st.desc, 0, 0));
      HGLASS.instanced.instanceMatrix.needsUpdate = true;
    }
    st.impacts.push({ u: clamp(u, -st.desc.width * .5, st.desc.width * .5),
                      v: clamp(v, -st.desc.height * .5, st.desc.height * .5) });
    if (st.impacts.length > 8) st.impacts.shift();
    st.energy += clamp((damage || 24) / 24, blast ? .8 : .55, blast ? 3.6 : 2.2);
    st.stage = st.energy < 1.7 ? 1 : st.energy < 3.1 ? 2 : st.energy < 4.7 ? 3 : 4;
    st.stage = Math.max(wasStage, st.stage);
    var ratio = [0, .18, .42, .68, .88][st.stage];
    if (st.stage === 4) ratio = Math.min(.93, ratio + Math.max(0, st.energy - 5) * .012);
    var keepMin = Math.max(3, Math.round(pieces.length * .065));
    var target = Math.min(pieces.length - keepMin, Math.round(pieces.length * ratio));
    var removed = 0, candidates = [];
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      if (p.removed) { removed++; continue; }
      var dist = 9;
      for (var q = 0; q < st.impacts.length; q++) {
        var im = st.impacts[q];
        dist = Math.min(dist, Math.hypot((p.u - im.u) / st.desc.width, (p.y - im.v) / st.desc.height));
      }
      candidates.push({ p: p, score: dist * .76 + p.tough * .22 + (p.edge ? (st.stage < 4 ? .34 : .16) : 0) });
    }
    candidates.sort(function (a, b) { return a.score - b.score || a.p.id - b.p.id; });
    var newly = [], need = Math.max(0, target - removed);
    for (i = 0; i < candidates.length && i < need; i++) {
      candidates[i].p.removed = true; newly.push(candidates[i].p);
    }
    /* A high-energy hit throws more chips, but geometry stays bounded even if
       a shotgun sends nine pellets into the same pane in one frame. */
    var debrisN = Math.min(newly.length, blast ? 18 : 12);
    for (i = 0; i < debrisN; i++) spawnGlassShard(st, newly[i], dir, damage);
    ensureRoom(st); rebuildPane(st);
    if (wasStage === 0) STATS.panesCracked++;
    if (wasStage < 4 && st.stage === 4) STATS.panesCollapsed++;
    return st;
  }

  function rayHeroGlass(hit, dir, meta) {
    if (!HGLASS.ready || !HGLASS.panes.length) return null;
    var ox, oy, oz;
    if (meta && meta.org) { ox = meta.org.x; oy = meta.org.y; oz = meta.org.z; }
    else { ox = hit.x - dir.x * 8; oy = hit.y - dir.y * 8; oz = hit.z - dir.z * 8; }
    var wallT = meta && isFinite(meta.bestT) ? meta.bestT : null;
    var best = null, crossed = false;
    for (var i = 0; i < HGLASS.panes.length; i++) {
      var d = HGLASS.panes[i], den = dir.x * d.normal[0] + dir.z * d.normal[2];
      if (Math.abs(den) < 1e-5) continue;
      var t = ((d.center[0] - ox) * d.normal[0] + (d.center[2] - oz) * d.normal[2]) / den;
      if (!(t > .02)) continue;
      var hostDepth = paneHostDepth(d);
      if (wallT !== null) {
        /* Recess is measured perpendicular to the facade.  Converting it to
           ray distance fixes oblique shots through an opened front screen. */
        var whx = ox + dir.x * wallT, whz = oz + dir.z * wallT;
        var normalGap = Math.abs((d.center[0] - whx) * d.normal[0] +
                                 (d.center[2] - whz) * d.normal[2]);
        if (normalGap > hostDepth + .30) continue; /* unrelated earlier wall */
        if (t > wallT + Math.min(42, hostDepth / Math.max(.035, Math.abs(den)) + .45)) continue;
      } else if (t > 28) continue;
      var px = ox + dir.x * t, py = oy + dir.y * t, pz = oz + dir.z * t;
      var u = (px - d.center[0]) * d.tangent[0] + (pz - d.center[2]) * d.tangent[2];
      var v = py - d.center[1];
      if (Math.abs(u) > d.width * .5 + .025 || Math.abs(v) > d.height * .5 + .025) continue;
      crossed = true;
      var st = HGLASS.states[i];
      if (!paneBlocksAt(st, u, v)) continue;
      if (!best || t < best.t) best = { state: st, t: t, u: u, v: v, x: px, y: py, z: pz };
    }
    return best || (crossed ? { through: true } : null);
  }

  function heroGlassImpact(hit, dir, meta) {
    var r = rayHeroGlass(hit, dir, meta);
    if (!r) return false;
    /* Once a local triangle is gone, claim the opening so staticImpact cannot
       paste a concrete crater over the newly visible room. */
    if (r.through) return true;
    var hp = { x: r.x, y: r.y, z: r.z };
    if (meta && meta.enemy) {
      safePuff(hp, dir, 'metal');
      if (meta.first) safeSfx('ric', r.x, r.z);
      return true;                       /* enemy misses are cosmetic only */
    }
    damagePane(r.state, r.u, r.v, meta && meta.dmg, dir, false);
    safePuff(hp, dir, 'metal'); safeSfx('ric', r.x, r.z);
    try {
      if (G.particle) for (var g = 0; g < 5; g++)
        G.particle('spark', r.x, r.y, r.z, rr(-3.8, 3.8), rr(-1, 4.5), rr(-3.8, 3.8),
          rr(.09, .18), rr(.08, .18), -12, true);
    } catch (e) {}
    STATS.glassHits++; STATS.buildingGlassHits++;
    return true;
  }

  function paneExhausted(st) {
    if (!st || st.stage !== 4 || !st.pieces || !st.pieces.length) return false;
    var keepMin = Math.max(3, Math.round(st.pieces.length * .065)), alive = 0;
    for (var i = 0; i < st.pieces.length; i++) if (!st.pieces[i].removed) alive++;
    return alive <= keepMin;
  }

  function blastHeroGlass(p, radius, opt) {
    if (!HGLASS.ready) return;
    var hits = [];
    for (var i = 0; i < HGLASS.panes.length; i++) {
      var d = HGLASS.panes[i], dx = p.x - d.center[0], dz = p.z - d.center[2];
      var paneState = HGLASS.states[i];
      /* Keep the fixed blast budget moving through the facade after nearby
         panes reach their deliberately retained edge-shard floor.  Pane grids
         have different triangle counts, so no one percentage marks exhaustion. */
      if (paneExhausted(paneState)) continue;
      var u = dx * d.tangent[0] + dz * d.tangent[2], v = p.y - d.center[1];
      var n = dx * d.normal[0] + dz * d.normal[2];
      var eu = Math.max(0, Math.abs(u) - d.width * .5), ev = Math.max(0, Math.abs(v) - d.height * .5);
      var dist = Math.hypot(eu, ev, n);
      var hu = clamp(u, -d.width * .5, d.width * .5);
      var hv = clamp(v, -d.height * .5, d.height * .5);
      var hx = d.center[0] + d.tangent[0] * hu;
      var hy = d.center[1] + hv;
      var hz = d.center[2] + d.tangent[2] * hu;
      /* Occlusion stops at the host facade face, not at a recessed pane that
         deliberately lives inside the solid collision cell. */
      var host = paneHostDepth(d);
      var qx = hx + d.normal[0] * host, qz = hz + d.normal[2] * host;
      var clear = !opt || !opt.occluded || !G.shotLineClear ||
        G.shotLineClear(p.x, p.y, p.z, qx, hy, qz);
      if (dist < radius * .85 && clear) hits.push({ i: i, dist: dist, u: hu, v: hv });
    }
    hits.sort(function (a, b) { return a.dist - b.dist; });
    for (var k = 0; k < Math.min(18, hits.length); k++) {
      var h = hits[k], force = clamp((1 - h.dist / Math.max(1, radius)) * 76, 18, 76);
      damagePane(HGLASS.states[h.i], h.u, h.v, force, { x: 0, y: 0, z: 0 }, true);
      STATS.buildingGlassHits++;
    }
  }

  function glassState(i) {
    var st = HGLASS.states[i];
    if (!st) return null;
    return { id: st.desc.id, building: st.desc.building, room: st.desc.room,
      stage: st.stage, energy: +st.energy.toFixed(2), remaining: +st.remaining.toFixed(3),
      impacts: st.impacts.length, roomVisible: !!st.room };
  }

  function bindHeroGlass() {
    var pub = null;
    try { pub = NZ.streetFacade && NZ.streetFacade.heroGlass; } catch (e) {}
    if (!pub || !pub.mesh || !pub.panes || !pub.panes.length) {
      NZ.log && NZ.log('[nz-destruct] no hero facade panes published'); return;
    }
    try {
      HGLASS.source = pub.mesh; HGLASS.panes = pub.panes; HGLASS.states = [];
      HGLASS.boxGeo = new THREE.BoxGeometry(1, 1, 1);
      HGLASS.planeGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
      if (HGLASS.planeGeo.attributes.uv)
        HGLASS.planeGeo.setAttribute('uv2', HGLASS.planeGeo.attributes.uv.clone());
      var white = new Float32Array(HGLASS.planeGeo.attributes.position.count * 3);
      for (var w = 0; w < white.length; w++) white[w] = 1;
      HGLASS.planeGeo.setAttribute('color', new THREE.BufferAttribute(white, 3));
      HGLASS.instanced = new THREE.InstancedMesh(HGLASS.planeGeo, pub.mesh.material, pub.panes.length);
      HGLASS.instanced.name = 'nzdestruct-hero-glass-intact';
      HGLASS.instanced.frustumCulled = false; HGLASS.instanced.castShadow = false;
      HGLASS.instanced.receiveShadow = true;
      var cc = new THREE.Color();
      for (var i = 0; i < pub.panes.length; i++) {
        var d = pub.panes[i], cv = paneTint(d);
        HGLASS.instanced.setMatrixAt(i, paneMatrix(d, d.width, d.height));
        cc.setRGB(cv[0], cv[1], cv[2]); HGLASS.instanced.setColorAt(i, cc);
        HGLASS.states.push({ index: i, desc: d, stage: 0, energy: 0,
          impacts: [], pieces: null, mesh: null, cracks: null, room: null, remaining: 1 });
      }
      HGLASS.instanced.instanceMatrix.needsUpdate = true;
      if (HGLASS.instanced.instanceColor) HGLASS.instanced.instanceColor.needsUpdate = true;
      HGLASS.shardMat = pub.mesh.material.clone();
      HGLASS.shardMat.name = 'nzdestruct-falling-glass'; HGLASS.shardMat.side = THREE.DoubleSide;
      HGLASS.shardMat.transparent = true; HGLASS.shardMat.opacity = .76;
      HGLASS.shardMat.depthWrite = false; HGLASS.shardMat.roughness = .18;
      HGLASS.shardMat.metalness = .04; HGLASS.shardMat.envMapIntensity = 1.15;
      HGLASS.shardGeo = new THREE.BufferGeometry();
      setGeoAttributes(HGLASS.shardGeo,
        [0, 0, 0, 1, 0, 0, 0, 1, 0],
        [0, 0, 1, 0, 0, 1, 0, 0, 1],
        [0, 0, 1, 0, 0, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1]);
      HGLASS.shardPool = new THREE.InstancedMesh(HGLASS.shardGeo, HGLASS.shardMat, GLASS_DEBRIS_MAX);
      HGLASS.shardPool.name = 'nzdestruct-falling-glass-pool';
      HGLASS.shardPool.count = 0; HGLASS.shardPool.frustumCulled = false;
      HGLASS.shardPool.castShadow = HGLASS.shardPool.receiveShadow = false;
      HGLASS.shardPool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(HGLASS.shardPool);
      HGLASS.crackMat = new THREE.LineBasicMaterial({
        color: 0xd8edf0, transparent: true, opacity: .62, depthWrite: false,
        blending: THREE.NormalBlending
      });
      buildRoomDefs(); scene.add(HGLASS.instanced);
      pub.mesh.visible = false; HGLASS.ready = true;
      STATS.glassPanes = pub.panes.length;
    } catch (e2) {
      if (pub && pub.mesh) pub.mesh.visible = true;
      HGLASS.ready = false; warn('hero glass install failed: ' + (e2 && e2.message));
    }
  }

  /* =======================================================================
     SECTION 5B -- parked-car glazing.

     PROPS publishes each physical pane as its own mesh.  That distinction is
     important: the gloss-black B/C pillars and mirror sail live on the same
     glass material, but they are structure and must not disappear when a
     bullet breaks the window beside them.  A normal round makes a radial web;
     the third ordinary hit releases the pane into falling tempered shards and
     exposes the fully modelled cabin behind it. */
  var CGLASS = {
    ready: false, panes: [], states: [], debris: [], debrisSeq: 0,
    shardGeo: null, shardMat: null, shardPool: null, crackMat: null
  };
  var CAR_GLASS_DEBRIS_MAX = 144;
  var _cgMotion = null, _cgFinal = null, _cgPos = null, _cgQuat = null,
      _cgScale = null, _cgEuler = null, _cgColor = null;

  function bindCarGlass() {
    var pub = null;
    try { pub = NZ.streetProps && NZ.streetProps.carWindows; } catch (e) {}
    if (!pub || !pub.length) return;
    try {
      CGLASS.panes = pub; CGLASS.states = [];
      for (var i = 0; i < pub.length; i++) {
        var d = pub[i];
        if (!d || !d.mesh || !d.mesh.geometry) continue;
        var st = { index: CGLASS.states.length, desc: d, mesh: d.mesh,
          stage: 0, energy: 0, hits: [], cracks: null, broken: false };
        d.mesh.userData.nzCarGlassState = st;
        CGLASS.states.push(st);
      }
      if (!CGLASS.states.length) return;
      /* A microscopic triangular prism, not a zero-thickness triangle.  The
         two broad faces stay transparent while the three tempered edges catch
         daylight as the piece tumbles, which is what makes falling safety
         glass readable against both the dark cabin and a bright facade. */
      CGLASS.shardGeo = new THREE.BufferGeometry();
      CGLASS.shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0,0,-1, 1,0,-1, .16,1,-1,
        0,0, 1, 1,0, 1, .16,1, 1
      ],3));
      CGLASS.shardGeo.setIndex([
        0,2,1, 3,4,5,
        0,1,4, 0,4,3,
        1,2,5, 1,5,4,
        2,0,3, 2,3,5
      ]);
      CGLASS.shardGeo.computeVertexNormals();
      CGLASS.shardMat = new THREE.MeshStandardMaterial({
        /* Fresh tempered glass is mostly edge response.  A faint cool
           emissive floor keeps thin, tumbling faces legible for the handful
           of frames before they drop below the door without making them glow. */
        color: 0xd7eef2, roughness: .10, metalness: .0,
        emissive: 0x102326, emissiveIntensity: .28,
        transparent: true, opacity: .84, depthWrite: false,
        side: THREE.DoubleSide, vertexColors: true, fog: true
      });
      CGLASS.shardMat.name = 'nzdestruct-car-glass-shards';
      /* a lower sky specular than the street default: a tumbling 3 cm shard
         that takes the full open-sky lobe reads as a spark, not as glass. */
      dayLit(CGLASS.shardMat, 'destruct-car-glass', { intensity: 0.8, spec: 0.34 });
      CGLASS.shardPool = new THREE.InstancedMesh(
        CGLASS.shardGeo, CGLASS.shardMat, CAR_GLASS_DEBRIS_MAX);
      CGLASS.shardPool.name = 'nzdestruct-car-glass-shard-pool';
      CGLASS.shardPool.count = 0; CGLASS.shardPool.frustumCulled = false;
      CGLASS.shardPool.castShadow = CGLASS.shardPool.receiveShadow = false;
      CGLASS.shardPool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(CGLASS.shardPool);
      CGLASS.crackMat = new THREE.LineBasicMaterial({
        color: 0xe2f4f7, transparent: true, opacity: .82,
        depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending
      });
      CGLASS.crackMat.name = 'nzdestruct-car-glass-cracks';
      CGLASS.ready = true;
      STATS.carGlassPanes = CGLASS.states.length;
    } catch (e2) {
      CGLASS.ready = false; warn('car glass install failed: ' + (e2 && e2.message));
    }
  }

  function carGlassState(i) {
    var st = CGLASS.states[i];
    return st ? { id: st.desc.id, kind: st.desc.kind, side: st.desc.side,
      stage: st.stage, energy: st.energy, hits: st.hits.length,
      broken: st.broken } : null;
  }

  function carPaneBasis(normal, dir) {
    var n = normal.clone().normalize();
    if (dir && n.dot(dir) > 0) n.negate();
    var t = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);
    if (t.lengthSq() < 1e-5) t.crossVectors(new THREE.Vector3(1, 0, 0), n);
    t.normalize();
    var b = new THREE.Vector3().crossVectors(n, t).normalize();
    return { n: n, t: t, b: b };
  }

  function crackPoint(im, a, r, lift) {
    return [
      im.p[0] + im.t[0] * Math.cos(a) * r + im.b[0] * Math.sin(a) * r + im.n[0] * lift,
      im.p[1] + im.t[1] * Math.cos(a) * r + im.b[1] * Math.sin(a) * r + im.n[1] * lift,
      im.p[2] + im.t[2] * Math.cos(a) * r + im.b[2] * Math.sin(a) * r + im.n[2] * lift
    ];
  }

  function rebuildCarCracks(st) {
    if (st.cracks) {
      scene.remove(st.cracks); st.cracks.geometry.dispose(); st.cracks = null;
    }
    if (st.broken || !st.hits.length || !CGLASS.crackMat) return;
    var pos = [], seed = st.desc.seed || (st.index + 1) * 97;
    function line(a, b) { pos.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
    for (var q = 0; q < st.hits.length; q++) {
      var im = st.hits[q], rays = 7 + st.stage * 3;
      var base = hhash(seed * 1.73 + q * 17.1) * Math.PI;
      var ring = [];
      for (var r = 0; r < rays; r++) {
        var a = base + r / rays * Math.PI * 2 + (hhash(seed + q * 31 + r) - .5) * .20;
        var len = (.24 + .34 * hhash(seed * 3.1 + q * 13 + r * 7)) * (1 + st.stage * .18);
        var p0 = crackPoint(im, a, 0, .032);
        var pm = crackPoint(im, a + (hhash(seed + r * 11) - .5) * .12, len * .48, .034);
        var pe = crackPoint(im, a + (hhash(seed + r * 19) - .5) * .18, len, .034);
        line(p0, pm); line(pm, pe); ring.push(pm);
        if ((r + q) % 3 === 0) {
          var twig = crackPoint(im, a + .55, len * .73, .035);
          line(pm, twig);
        }
      }
      for (r = 0; r < ring.length; r += 2)
        line(ring[r], ring[(r + 1) % ring.length]);
    }
    if (!pos.length) return;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeBoundingSphere();
    st.cracks = new THREE.LineSegments(geo, CGLASS.crackMat);
    st.cracks.name = 'nzdestruct-car-cracks-' + st.desc.id;
    st.cracks.frustumCulled = true; st.cracks.renderOrder = 7;
    scene.add(st.cracks);
  }

  function sampleCarPane(st) {
    var geo = st.mesh.geometry, pa = geo.attributes.position, ix = geo.getIndex();
    if (!pa || pa.count < 3) return new THREE.Vector3();
    var triN = ix ? Math.floor(ix.count / 3) : Math.floor(pa.count / 3);
    var ti = Math.max(0, Math.min(triN - 1, (Math.random() * triN) | 0));
    var ia = ix ? ix.getX(ti * 3) : ti * 3;
    var ib = ix ? ix.getX(ti * 3 + 1) : ti * 3 + 1;
    var ic = ix ? ix.getX(ti * 3 + 2) : ti * 3 + 2;
    var u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    return new THREE.Vector3(
      pa.getX(ia) + (pa.getX(ib) - pa.getX(ia)) * u + (pa.getX(ic) - pa.getX(ia)) * v,
      pa.getY(ia) + (pa.getY(ib) - pa.getY(ia)) * u + (pa.getY(ic) - pa.getY(ia)) * v,
      pa.getZ(ia) + (pa.getZ(ib) - pa.getZ(ia)) * u + (pa.getZ(ic) - pa.getZ(ia)) * v);
  }

  function spawnCarGlassShards(st, im, dir) {
    if (!CGLASS.shardPool) return;
    var basis = carPaneBasis(new THREE.Vector3(im.n[0], im.n[1], im.n[2]), dir);
    var n = st.desc.kind === 'windscreen' ? 30 : (st.desc.kind === 'backlight' ? 25 : 20);
    for (var i = 0; i < n; i++) {
      var p = sampleCarPane(st), sx = rr(.13, .36), sy = rr(.15, .42);
      var shape = new THREE.Matrix4().set(
        basis.t.x * sx, basis.b.x * sy, basis.n.x * .018, 0,
        basis.t.y * sx, basis.b.y * sy, basis.n.y * .018, 0,
        basis.t.z * sx, basis.b.z * sy, basis.n.z * .018, 0,
        0, 0, 0, 1);
      CGLASS.debris.push({
        id: ++CGLASS.debrisSeq, shape: shape,
        color: [rr(.82, 1.00), rr(.94, 1.08), rr(.97, 1.12)],
        x: p.x, y: p.y, z: p.z,
        vx: dir.x * rr(.5, 2.2) + basis.n.x * rr(-1.2, 2.2) + basis.t.x * rr(-1.8, 1.8),
        /* The pane releases, then drops; only a few crumbs kick upward. */
        vy: rr(-1.6, .75),
        vz: dir.z * rr(.5, 2.2) + basis.n.z * rr(-1.2, 2.2) + basis.t.z * rr(-1.8, 1.8),
        rx: rr(-10, 10), ry: rr(-10, 10), rz: rr(-10, 10),
        ax: rr(-.2,.2), ay: rr(-.2,.2), az: rr(-.2,.2),
        scale: 1, life: rr(4.0, 6.8), bounces: 0, settled: false, half: .025
      });
    }
    while (CGLASS.debris.length > CAR_GLASS_DEBRIS_MAX) CGLASS.debris.shift();
    STATS.carGlassDebrisPeak = Math.max(STATS.carGlassDebrisPeak, CGLASS.debris.length);
  }

  function syncCarGlassDebris() {
    var pool = CGLASS.shardPool;
    if (!pool) return;
    if (!_cgMotion) {
      _cgMotion = new THREE.Matrix4(); _cgFinal = new THREE.Matrix4();
      _cgPos = new THREE.Vector3(); _cgQuat = new THREE.Quaternion();
      _cgScale = new THREE.Vector3(); _cgEuler = new THREE.Euler(); _cgColor = new THREE.Color();
    }
    for (var i = 0; i < CGLASS.debris.length; i++) {
      var d = CGLASS.debris[i];
      _cgPos.set(d.x,d.y,d.z); _cgEuler.set(d.ax,d.ay,d.az); _cgQuat.setFromEuler(_cgEuler);
      _cgScale.setScalar(d.scale); _cgMotion.compose(_cgPos,_cgQuat,_cgScale);
      _cgFinal.multiplyMatrices(_cgMotion,d.shape); pool.setMatrixAt(i,_cgFinal);
      _cgColor.setRGB(d.color[0],d.color[1],d.color[2]); pool.setColorAt(i,_cgColor);
    }
    pool.count = CGLASS.debris.length; pool.instanceMatrix.needsUpdate = true;
    if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
  }

  function updateCarGlassDebris(dt) {
    for (var i = CGLASS.debris.length - 1; i >= 0; i--) {
      var d = CGLASS.debris[i]; d.life -= dt;
      if (d.life <= 0) { CGLASS.debris.splice(i,1); continue; }
      if (!d.settled) {
        d.vy -= 30 * dt; d.x += d.vx*dt; d.y += d.vy*dt; d.z += d.vz*dt;
        d.ax += d.rx*dt; d.ay += d.ry*dt; d.az += d.rz*dt;
        var fl = 0; try { fl = G.highestFloor ? G.highestFloor(d.x,d.z,.04) : 0; } catch (e) {}
        if (d.y < fl + d.half && d.vy < 0) {
          d.y = fl + d.half; d.bounces++;
          if (d.bounces > 2) {
            d.vx=d.vy=d.vz=d.rx=d.ry=d.rz=0; d.settled=true;
          } else { d.vy *= -.22; d.vx *= .58; d.vz *= .58; }
        }
      }
      d.scale = d.life < .45 ? clamp(d.life/.45,0,1) : 1;
    }
    syncCarGlassDebris();
  }

  function breakCarPane(st, im, dir) {
    if (st.broken) return st;
    st.broken = true; st.stage = 3;
    if (st.cracks) { scene.remove(st.cracks); st.cracks.geometry.dispose(); st.cracks = null; }
    var mat = st.mesh && st.mesh.material;
    if (mat) { mat.transparent = true; mat.opacity = 0; mat.depthWrite = false; mat.needsUpdate = true; }
    spawnCarGlassShards(st, im, dir);
    safeSfx('ric', im.p[0], im.p[2]);
    try {
      if (G.particle) for (var i = 0; i < 10; i++)
        G.particle('spark',im.p[0],im.p[1],im.p[2],rr(-3,3),rr(-1,3),rr(-3,3),rr(.10,.18),rr(.08,.16),-17,true);
    } catch (e) {}
    STATS.carPanesBroken++;
    return st;
  }

  function damageCarPane(st, point, normal, dir, damage) {
    if (!st) return null;
    if (st.broken) return st;
    var basis = carPaneBasis(normal, dir);
    var im = { p:[point.x,point.y,point.z], n:[basis.n.x,basis.n.y,basis.n.z],
      t:[basis.t.x,basis.t.y,basis.t.z], b:[basis.b.x,basis.b.y,basis.b.z] };
    st.hits.push(im); if (st.hits.length > 6) st.hits.shift();
    st.energy += clamp((damage || 16) / 16, .72, 1.65);
    st.stage = st.energy < 1.65 ? 1 : (st.energy < 2.75 ? 2 : 3);
    if (st.stage >= 3) breakCarPane(st, im, dir);
    else {
      rebuildCarCracks(st); safeSfx('ric', point.x, point.z);
      try {
        if (G.particle) for (var i = 0; i < 4; i++)
          G.particle('spark',point.x,point.y,point.z,rr(-2,2),rr(0,2.5),rr(-2,2),rr(.09,.15),rr(.06,.13),-15,true);
      } catch (e) {}
    }
    return st;
  }

  function rayCarGlass(ox, oy, oz, dir, far) {
    if (!CGLASS.ready || !CGLASS.states.length) return null;
    try {
      if (!_ray) { _ray = new THREE.Raycaster(); _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }
      _v1.set(ox,oy,oz); _v2.set(dir.x,dir.y,dir.z); _ray.set(_v1,_v2); _ray.far = far;
      var list = [];
      for (var i = 0; i < CGLASS.states.length; i++)
        if (!CGLASS.states[i].broken) list.push(CGLASS.states[i].mesh);
      var xs = _ray.intersectObjects(list,false);
      if (!xs.length) return null;
      var x = xs[0], st = x.object.userData.nzCarGlassState;
      if (!st) return null;
      var n = x.face && x.face.normal ? x.face.normal.clone().transformDirection(x.object.matrixWorld)
                                      : new THREE.Vector3(-dir.x,-dir.y,-dir.z);
      return { state:st, point:x.point, normal:n, distance:x.distance };
    } catch (e) { return null; }
  }

  /* =======================================================================
     SECTION 6 -- cars.  NZ.streetProps.cars gives centre, spec {L,W,H} and
     yaw for every parked body; the ray is walked into each car's frame for
     a slab test, then refined against the true body/glass piles under a
     small per-frame budget.  Only the DECAL comes from this: whether the
     round stopped is still castWall's verdict, so combat is unchanged. */
  var cars = null, carMeshes = null;
  var meshRayFrame = -1, meshRayUsed = 0, MESHRAY_BUDGET = 3;
  var frameNo = 0;

  function bindCars() {
    if (cars !== null) return;
    cars = [];
    try {
      var sp = NZ.streetProps;
      if (sp && sp.cars && sp.cars.length) {
        for (var i = 0; i < sp.cars.length; i++) {
          var c = sp.cars[i];
          if (!c || !c.spec) continue;
          cars.push({
            x: c.x, z: c.z, y: c.y,
            hx: c.spec.L * .5 + .12, hy: c.spec.H * .5 + .06, hz: c.spec.W * .5 + .08,
            cy: c.y + c.spec.H * .5, yaw: c.yaw || 0,
            cos: Math.cos(c.yaw || 0), sin: Math.sin(c.yaw || 0)
          });
        }
        carMeshes = (typeof sp.carMeshes === 'function') ? sp.carMeshes() : null;
      }
    } catch (e) { warn('car registry unreadable: ' + (e && e.message)); }
    if (!cars.length) NZ.log && NZ.log('[nz-destruct] no parked cars published -- car hits off');
  }

  /* ray vs oriented box, in the car's own frame.  Returns {t, nx, ny, nz}
     in world space or null. */
  function rayCar(car, ox, oy, oz, dx, dy, dz, far) {
    var lx = ox - car.x, ly = oy - car.cy, lz = oz - car.z;
    var c = car.cos, s = car.sin;
    /* world -> car frame is rotation by -yaw about y.  buildCar yaws the
       body from +x, so the frame's x runs down the car's length. */
    var px = lx * c + lz * s, pz = -lx * s + lz * c;
    var vx = dx * c + dz * s, vz = -dx * s + dz * c;
    var tmin = 0, tmax = far, axis = -1, sign = 0;
    var P = [px, ly, pz], V = [vx, dy, vz], H = [car.hx, car.hy, car.hz];
    for (var a = 0; a < 3; a++) {
      if (Math.abs(V[a]) < 1e-8) { if (Math.abs(P[a]) > H[a]) return null; continue; }
      var inv = 1 / V[a], t0 = (-H[a] - P[a]) * inv, t1 = (H[a] - P[a]) * inv;
      var swap = t0 > t1; if (swap) { var tt = t0; t0 = t1; t1 = tt; }
      if (t0 > tmin) { tmin = t0; axis = a; sign = swap ? 1 : -1; }
      if (t1 < tmax) tmax = t1;
      if (tmin > tmax) return null;
    }
    if (axis < 0 || tmin <= .01) return null;
    var n = [0, 0, 0]; n[axis] = sign;
    /* car frame -> world for the normal */
    var wnx = n[0] * c - n[2] * s, wnz = n[0] * s + n[2] * c;
    return { t: tmin, nx: wnx, ny: n[1], nz: wnz };
  }

  function carImpact(hit, dir, meta) {
    bindCars();
    if (!cars.length) return false;
    var ox, oy, oz;
    if (meta && meta.org) { ox = meta.org.x; oy = meta.org.y; oz = meta.org.z; }
    else { ox = hit.x - dir.x * 70; oy = hit.y - dir.y * 70; oz = hit.z - dir.z * 70; }
    var far = (meta && isFinite(meta.bestT)) ? meta.bestT + 6.5 : 90;
    var best = null, bi = -1;
    for (var i = 0; i < cars.length; i++) {
      var r = rayCar(cars[i], ox, oy, oz, dir.x, dir.y, dir.z, far);
      if (r && (!best || r.t < best.t)) { best = r; bi = i; }
    }
    if (!best) return false;

    var px = ox + dir.x * best.t, py = oy + dir.y * best.t, pz = oz + dir.z * best.t;
    var nx = best.nx, ny = best.ny, nz = best.nz, glass = false;

    /* refine against the true panels while the frame budget lasts */
    if (frameNo !== meshRayFrame) { meshRayFrame = frameNo; meshRayUsed = 0; }
    if (carMeshes && (carMeshes.body || carMeshes.glass ||
        (carMeshes.windows && carMeshes.windows.length)) && meshRayUsed < MESHRAY_BUDGET) {
      meshRayUsed++;
      try {
        if (!_ray) { _ray = new THREE.Raycaster(); _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }
        _v1.set(ox, oy, oz); _v2.set(dir.x, dir.y, dir.z);
        _ray.set(_v1, _v2); _ray.far = best.t + cars[bi].hx * 2 + 2;
        var list = [];
        if (carMeshes.body) list.push(carMeshes.body);
        if (carMeshes.glass) list.push(carMeshes.glass);
        if (carMeshes.windows) for (var wi = 0; wi < carMeshes.windows.length; wi++) {
          var windowMesh = carMeshes.windows[wi];
          var windowState = windowMesh && windowMesh.userData && windowMesh.userData.nzCarGlassState;
          /* A fallen pane is a real opening.  Leaving its invisible mesh in
             the ray list swallowed every later round at the near side, so an
             intact opposite pane could neither be seen nor shot through the
             opening. */
          if (windowMesh && !(windowState && windowState.broken)) list.push(windowMesh);
        }
        var xs = _ray.intersectObjects(list, false);
        if (xs.length) {
          px = xs[0].point.x; py = xs[0].point.y; pz = xs[0].point.z;
          var obj = xs[0].object, cgState = obj.userData && obj.userData.nzCarGlassState;
          var hitNormal = xs[0].face && xs[0].face.normal
            ? xs[0].face.normal.clone().transformDirection(obj.matrixWorld)
            : new THREE.Vector3(nx,ny,nz);
          nx = hitNormal.x; ny = hitNormal.y; nz = hitNormal.z;
          if (cgState) {
            damageCarPane(cgState, xs[0].point, hitNormal,
              new THREE.Vector3(dir.x,dir.y,dir.z), (meta && meta.dmg) || 16);
            STATS.glassHits++; STATS.holes++;
            return true;
          }
          glass = carMeshes.glass && xs[0].object === carMeshes.glass;
        }
      } catch (e) {}
    } else if (carMeshes) STATS.meshRayBudgetSkips++;

    var tint = tintAt(px, py, pz, nx, ny, nz);
    if (glass) {
      stamp(px + nx * .04, py + ny * .04, pz + nz * .04, nx, ny, nz,
        rr(.5, .72), (Math.random() * 2) | 0, ROW.glassrow, tint, null);
      if (!(meta && meta.enemy && !meta.first)) safeSfx('ric', px, pz);
      try {
        if (G.particle) for (var g = 0; g < 4; g++)
          G.particle('spark', px, py, pz, rr(-3, 3), rr(0, 3), rr(-3, 3), rr(.12, .2), rr(.1, .2), -14, true);
      } catch (e) {}
      STATS.glassHits++;
    } else {
      stamp(px + nx * .035, py + ny * .035, pz + nz * .035, nx, ny, nz,
        rr(.24, .34), (Math.random() * 4) | 0, ROW.metal, tint, null);
      var hv = { x: px, y: py, z: pz };
      safePuff(hv, dir, 'metal');
      if (!(meta && meta.enemy && !meta.first)) safeSfx('impact_metal', px, pz);
      STATS.carHits++;
    }
    STATS.holes++;
    return true;
  }

  /* =======================================================================
     SECTION 6 -- static surfaces.  The stock kinds map onto atlas rows; the
     hole is snapped onto the cell plane castWall marched past (its .34 u
     step leaves the reported point up to .17 u off the wall, and a hole
     floating a hand's width proud of the render reads as a sticker). */
  function snapToPlane(p, n, cell) {
    var out = { x: p.x, y: p.y, z: p.z };
    if (!G.CELL) return out;
    if (Math.abs(n.x) > .9) out.x = Math.round(p.x / G.CELL) * G.CELL;
    else if (Math.abs(n.z) > .9) out.z = Math.round(p.z / G.CELL) * G.CELL;
    else if (Math.abs(n.y) > .9 && cell) {
      try { out.y = n.y > 0 ? cell.f : cell.c; } catch (e) {}
    }
    return out;
  }

  /* Street facades are NOT at the grid plane: the render stands 0.34 u proud
     of it, the plinth 0.52, and the upper-storey cikma a whole 4.2.  A hole
     stamped on the collision plane is buried inside the cladding, so when a
     wall hit lands on a published facade run the decal is carried out to the
     face the eye actually sees.  Ground-storey openings (gaps) and the roofs
     keep the grid plane -- glass and pantiles are near enough. */
  function facadeFace(p, n) {
    var runs = null;
    try {
      runs = (NZ.streetFacade && NZ.streetFacade.facades) ||
             (NZ.street && NZ.street.facades) || null;
    } catch (e) { runs = null; }
    if (!runs || !runs.length) return null;
    for (var i = 0; i < runs.length; i++) {
      var F = runs[i];
      if (!F || !F.axis) continue;
      var alongZ = F.axis === 'z';
      if (alongZ && Math.abs(n.z) < .8) continue;
      if (!alongZ && Math.abs(n.x) < .8) continue;
      var planeCoord = alongZ ? p.z : p.x, t = alongZ ? p.x : p.z;
      if (Math.abs(planeCoord - F.plane) > 2.6) continue;
      if (t < F.a - .5 || t > F.b + .5) continue;
      var y = p.y, face;
      if (F.entryBay && t >= F.entryBay.a && t <= F.entryBay.b &&
          y >= F.entryBay.baseY && y <= F.entryBay.topY) face = F.entryBay.face;
      else if (isFinite(F.eavesY) && y > F.eavesY) face = null;
      else if (isFinite(F.plinthTop) && y <= F.plinthTop) face = F.plinthFace;
      else if (isFinite(F.soffitY) && y <= F.soffitY) {
        face = F.wallFace;
        var gaps = F.gaps;
        if (gaps) for (var g2 = 0; g2 < gaps.length; g2++) {
          var gp = gaps[g2];
          if (gp && t >= gp.a && t <= gp.b && (!isFinite(gp.y1) || y <= gp.y1 + .4)) { face = null; break; }
        }
      } else face = (F.kind && F.kind !== 'generic' && isFinite(F.face)) ? F.face : F.bayFace;
      if (face === null || !isFinite(face)) return null;
      return { alongZ: alongZ, coord: face };
    }
    return null;
  }

  function staticImpact(hit, dir, surface, meta) {
    var n = surface.normal, kind = surface.kind;
    var row = kind === 'metal' ? ROW.metal : kind === 'wood' ? ROW.wood : ROW.concrete;
    var R = null;
    try {
      if (G.regAt && G.inb && G.CELL) {
        var cx = Math.floor(hit.x / G.CELL), cz = Math.floor(hit.z / G.CELL);
        if (G.inb(cx, cz)) R = G.regAt(cx, cz);
      }
    } catch (e) {}
    var p = snapToPlane(hit, n, R);
    var ff = facadeFace(p, n);
    if (ff) { if (ff.alongZ) p.z = ff.coord; else p.x = ff.coord; }

    var size = kind === 'metal' ? rr(.26, .36) : kind === 'wood' ? rr(.34, .48) : rr(.34, .5);
    var rec = deepen(p.x, p.y, p.z);
    if (rec.n > 0) { size *= 1 + .30 * rec.n; STATS.deepened++; }
    var tint = tintAt(p.x, p.y, p.z, n.x, n.y, n.z);
    if (rec.n > 0) { tint[0] *= .82; tint[1] *= .82; tint[2] *= .82; }
    stamp(rec.x + n.x * .045, rec.y + n.y * .045, rec.z + n.z * .045,
      n.x, n.y, n.z, size, (Math.random() * 4) | 0, row, tint, null);
    STATS.holes++;

    if (meta && meta.enemy) {
      safePuff(hit, dir, kind);
      if (meta.first) safeSfx('impact_' + kind, hit.x, hit.z);
    } else {
      safePuff(hit, dir, kind);
      safeSfx('impact_' + kind, hit.x, hit.z);
    }
    return true;
  }

  /* =======================================================================
     SECTION 7 -- the router.  One hook, three verdicts:
       undefined -> stock path (doors, lifts: things that move)
       true      -> owned here (car, crate, static wall/floor/ceiling)   */
  function onSurfaceHit(hit, dir, surface, meta) {
    if (!installed || dead) return undefined;
    try {
      /* cars first: the reported point may be on a bay plane a stride short
         of the body, or on the facade behind a roofline the grid does not
         know about.  Either way the car owns the mark. */
      if (carImpact(hit, dir, meta)) return true;

      if (G.CELL && G.inb && G.grid && G.idx) {
        var n = surface.normal;
        var bx = Math.floor((hit.x - n.x * .32) / G.CELL);
        var bz = Math.floor((hit.z - n.z * .32) / G.CELL);
        if (G.inb(bx, bz)) {
          var t = G.grid[G.idx(bx, bz)];
          if (t === G.S_DOOR || t === G.S_KEY || t === G.S_SECRET) return undefined;
          if (G.liftAt && G.liftAt(bx, bz)) return undefined;
          if (t === G.S_BLOCK) {
            var rec = crateAt(bx, bz);
            if (rec) return hitCrate(rec, hit, dir, surface, meta);
            /* an S_BLOCK that is not a crate is a street bay/pit/island:
               kerbs and soil, not woodwork */
            surface = { normal: n, kind: 'concrete' };
          }
        }
        var hx = Math.floor(hit.x / G.CELL), hz = Math.floor(hit.z / G.CELL);
        if (G.inb(hx, hz) && G.liftAt && G.liftAt(hx, hz)) return undefined;
      }
      /* Real movable/grid cover has already had first refusal.  The facade
         panes are visual geometry over the remaining solid boundary. */
      if (heroGlassImpact(hit, dir, meta)) return true;
      return staticImpact(hit, dir, surface, meta);
    } catch (err) {
      warn('surfaceHit handler threw, disabling: ' + (err && err.message));
      dead = true;
      return undefined;
    }
  }

  /* =======================================================================
     SECTION 8 -- explosions.  explode() is wrapped at install: the stock
     fireball runs first, then the scars.  Crates go at once -- 1200 mm of
     pine is not cover against a rocket -- the floor under the burst takes a
     scorch, every wall and ceiling inside the fireball takes a crater, soot
     and a shrapnel ring, and any car flank inside the radius takes soot. */

  /* a blast mark's placement: snapped to the cell plane, carried out to the
     visible facade face, classified by what the wall is made of */
  var _sv1 = null, _sv2 = null;
  function blastScar(px, py, pz, nx, ny, nz) {
    var R = null;
    try {
      if (G.regAt && G.inb && G.CELL) {
        var cx = Math.floor(px / G.CELL), cz = Math.floor(pz / G.CELL);
        if (G.inb(cx, cz)) R = G.regAt(cx, cz);
      }
    } catch (e) {}
    var n = { x: nx, y: ny, z: nz };
    var p = snapToPlane({ x: px, y: py, z: pz }, n, R);
    var ff = facadeFace(p, n);
    if (ff) { if (ff.alongZ) p.z = ff.coord; else p.x = ff.coord; }
    var row = ROW.concrete;
    try {
      if (G.impactSurface) {
        if (!_sv1) { _sv1 = new THREE.Vector3(); _sv2 = new THREE.Vector3(); }
        _sv1.set(p.x, p.y, p.z); _sv2.set(-nx, -ny, -nz);
        var s = G.impactSurface(_sv1, _sv2);
        if (s && s.kind === 'metal') row = ROW.metal;
        else if (s && s.kind === 'wood') row = ROW.wood;
      }
    } catch (e) {}
    var tint = tintAt(p.x, p.y, p.z, nx, ny, nz);
    var dark = [tint[0] * .62, tint[1] * .62, tint[2] * .62];
    return { x: p.x, y: p.y, z: p.z, row: row, tint: tint, dark: dark };
  }

  /* small holes scattered on the plane around a burst point.  The tangent
     basis is captured into locals up front because stamp() reuses the same
     scratch vectors. */
  function blastShrapnel(px, py, pz, nx, ny, nz, radius, n, row) {
    if (!pool) return;
    radius = Math.min(radius, 2.6);
    if (!_t) { _t = new THREE.Vector3(); _b = new THREE.Vector3(); _n = new THREE.Vector3(); }
    _n.set(nx, ny, nz).normalize();
    if (Math.abs(_n.y) > .92) _t.set(1, 0, 0); else _t.set(0, 1, 0);
    _b.crossVectors(_n, _t).normalize();
    _t.crossVectors(_b, _n).normalize();
    var tx = _t.x, ty = _t.y, tz = _t.z, bx = _b.x, by = _b.y, bz = _b.z;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, d = radius * (0.35 + Math.random() * 0.65);
      var ox = (tx * Math.cos(a) + bx * Math.sin(a)) * d;
      var oy = (ty * Math.cos(a) + by * Math.sin(a)) * d;
      var oz = (tz * Math.cos(a) + bz * Math.sin(a)) * d;
      var tint = tintAt(px + ox, py + oy, pz + oz, nx, ny, nz);
      tint[0] *= .8; tint[1] *= .8; tint[2] *= .8;
      stamp(px + ox + nx * .05, py + oy + ny * .05, pz + oz + nz * .05,
        nx, ny, nz, rr(.2, .42), (Math.random() * 4) | 0,
        row === undefined ? ROW.concrete : row, tint, null);
      STATS.holes++;
    }
  }
  function onExplosion(p, radius, opt) {
    try {
      var r = Math.max(6, radius || 20);
      blastHeroGlass(p, r, opt);
      var map = crateMap(), key, blasted = [];
      for (key in map) {
        if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
        var c = map[key], wx = c.mesh.position.x, wy = c.mesh.position.y, wz = c.mesh.position.z;
        /* Level 2 stacks four combat floors over the same x/z footprint. A
           horizontal-only test let a blast in the court vaporise a crate on
           a bridge sixteen units above it. NULLSTAR also shares the actor
           damage policy: a wall that shields a body shields scenery behind it. */
        var d = Math.hypot(wx - p.x, wy - p.y, wz - p.z);
        var clear = true;
        if (opt && opt.occluded && G.shotLineClear) {
          /* Aim at the near face, just outside the crate's own blocking cell;
             otherwise shotLineClear correctly sees the target crate and
             rejects every blast as self-occluded. */
          var vx = p.x - wx, vz = p.z - wz, major = Math.max(Math.abs(vx), Math.abs(vz));
          var tx = wx, ty = wy, tz = wz;
          if (major > .01) {
            var face = (G.CELL || 4) * .52 / major;
            tx += vx * face; tz += vz * face;
          } else ty += (G.CRATE_H || 3.2) * .72;
          clear = G.shotLineClear(p.x, p.y, p.z, tx, ty, tz);
        }
        if (d < r * .95 && clear) blasted.push(c);
      }
      for (var i = 0; i < blasted.length; i++) {
        var away = {
          x: blasted[i].mesh.position.x - p.x, y: .3,
          z: blasted[i].mesh.position.z - p.z
        };
        var L = Math.hypot(away.x, away.z) || 1; away.x /= L; away.z /= L;
        breakCrate(blasted[i], away);
      }
      /* floor scorch */
      var fy = 0;
      try { fy = G.highestFloor ? G.highestFloor(p.x, p.z, .05) : 0; } catch (e) {}
      if (p.y - fy < r) {
        var tint = tintAt(p.x, fy, p.z, 0, 1, 0);
        stamp(p.x, fy + .05, p.z, 0, 1, 0, clamp(r * .22, 2.6, 5.2),
          2 + ((Math.random() * 2) | 0), ROW.glassrow, tint, null);
        STATS.scorches++;
        blastShrapnel(p.x, fy + .05, p.z, 0, 1, 0, clamp(r * .16, 1.6, 3.2), 3);
      }
      /* WALL AND CEILING SCARS.  Rockets and grenades never pass through
         hitscan(), so without this pass a detonation left the wall it burst
         against untouched while a single pistol round chipped it -- exactly
         backwards.  Probe the five remaining axis directions; every surface
         inside the fireball takes a crater, a soot blot and a shrapnel ring,
         scaled by how close it stood.  Doors and lifts stay clean (they
         move; the stock fading decal is hitscan-only and explosions against
         a door already read as fire + smoke). */
      if (G.castWall) {
        var DIRS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
        for (var di = 0; di < DIRS.length; di++) {
          var D = DIRS[di];
          var reach = Math.min(r * .92, 24);
          var hd = 0;
          try { hd = G.castWall(p, { x: D[0], y: D[1], z: D[2] }, reach); } catch (e) { continue; }
          if (hd >= reach - .01) continue;
          var wx2 = p.x + D[0] * hd, wy2 = p.y + D[1] * hd, wz2 = p.z + D[2] * hd;
          var nx2 = -D[0], ny2 = -D[1], nz2 = -D[2];
          if (G.CELL && G.inb) {
            var wcx = Math.floor((wx2 - nx2 * .32) / G.CELL), wcz = Math.floor((wz2 - nz2 * .32) / G.CELL);
            if (G.inb(wcx, wcz)) {
              var wt = G.grid ? G.grid[G.idx(wcx, wcz)] : -1;
              if (wt === G.S_DOOR || wt === G.S_KEY || wt === G.S_SECRET) continue;
              if (G.liftAt && G.liftAt(wcx, wcz)) continue;
            }
          }
          var k = 1 - hd / reach;                      /* closer wall, bigger scar */
          var scar = blastScar(wx2, wy2, wz2, nx2, ny2, nz2);
          /* the crater: a deep dark hole at the burst centre... */
          stamp(scar.x + nx2 * .06, scar.y + ny2 * .06, scar.z + nz2 * .06,
            nx2, ny2, nz2, clamp(r * .09 + k * .9, .8, 1.9),
            (Math.random() * 4) | 0, scar.row, scar.dark, null);
          /* ...under a wide soot blot... */
          stamp(scar.x + nx2 * .045, scar.y + ny2 * .045, scar.z + nz2 * .045,
            nx2, ny2, nz2, clamp(r * (.20 + k * .16), 2.2, 5.6),
            2 + ((Math.random() * 2) | 0), ROW.glassrow, scar.tint, null);
          /* ...and the shrapnel ring around it */
          blastShrapnel(scar.x, scar.y, scar.z, nx2, ny2, nz2,
            clamp(r * .17 + k, 1.8, 3.4), 4 + ((Math.random() * 4) | 0), scar.row);
          STATS.scorches++;
          STATS.holes++;
        }
      }
      /* car soot */
      bindCars();
      for (var ci = 0; ci < cars.length; ci++) {
        var car = cars[ci];
        var ddx = p.x - car.x, ddz = p.z - car.z;
        if (Math.hypot(ddx, ddz) > r + car.hx) continue;
        /* nearest flank in the car frame */
        var lc = car.cos, ls = car.sin;
        var qx = ddx * lc + ddz * ls, qz = -ddx * ls + ddz * lc;
        var onEnd = Math.abs(qx) / car.hx > Math.abs(qz) / car.hz;
        var sgn = onEnd ? (qx > 0 ? 1 : -1) : (qz > 0 ? 1 : -1);
        var fx2 = onEnd ? car.hx * sgn : clamp(qx, -car.hx * .8, car.hx * .8);
        var fz2 = onEnd ? clamp(qz, -car.hz * .8, car.hz * .8) : car.hz * sgn;
        var wpx = car.x + fx2 * lc - fz2 * ls, wpz = car.z + fx2 * ls + fz2 * lc;
        var wnx = onEnd ? lc * sgn : -ls * sgn, wnz = onEnd ? ls * sgn : lc * sgn;
        var st = tintAt(wpx, car.cy, wpz, wnx, 0, wnz);
        st[0] *= .75; st[1] *= .75; st[2] *= .75;
        stamp(wpx + wnx * .06, car.cy, wpz + wnz * .06, wnx, 0, wnz,
          clamp(r * .16, 1.4, 2.6), 2 + ((Math.random() * 2) | 0), ROW.glassrow, st, null);
        STATS.scorches++;
      }
    } catch (e) { warn('explosion scar pass threw: ' + (e && e.message)); }
  }

  /* =======================================================================
     SECTION 9 -- install.  */
  function install(ctx) {
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    THREE = ctx.THREE; scene = ctx.scene;
    if (!THREE || !scene) { warn('no THREE/scene in ctx'); return; }
    G = bindGame();
    pool = makePool(bakeAtlas());
    crateMap();
    bindCars();
    bindCarGlass();
    bindHeroGlass();

    /* wrap explode() -- a global function declaration, so assignment through
       the shared classic-script scope rebinds every caller at once */
    try {
      var stock = tryGet(function () { return explode; });
      if (typeof stock === 'function') {
        /* eslint-disable no-global-assign */
        explode = function (p, radius, dmg, wep, opt) {
          /* Forward optional policy arguments (NULLSTAR uses occluded 3D
             damage) instead of silently erasing them at the decoration layer. */
          stock.apply(null, arguments);
          onExplosion(p, radius, opt);
        };
      } else warn('explode() not visible -- blast scars off');
    } catch (e) { warn('could not wrap explode(): ' + (e && e.message)); }

    STATS.ms = Math.round(((global.performance && performance.now) ? performance.now() : Date.now()) - t0);
    installed = true;
    NZ.flags.destruct = true;
    NZ.destruct = {
      ok: true, stats: STATS, diag: DIAG, report: report,
      brokenCells: brokenCells,
      snapshot: snapshotState,
      validate: validateState,
      restore: restoreState,
      debrisCount: function () { return debris.length + HGLASS.debris.length + CGLASS.debris.length; },
      carGlass: {
        count: function () { return CGLASS.states.length; },
        ready: function () { return CGLASS.ready; },
        panes: CGLASS.panes,
        state: carGlassState,
        states: function () {
          var out = []; for (var i = 0; i < CGLASS.states.length; i++) out.push(carGlassState(i));
          return out;
        },
        damage: function (index, hits, damage) {
          var st = CGLASS.states[index | 0]; if (!st) return null;
          hits = clamp(hits | 0,1,12);
          for (var i = 0; i < hits && !st.broken; i++) {
            var geo = st.mesh.geometry, c = geo.boundingSphere && geo.boundingSphere.center
              ? geo.boundingSphere.center.clone() : sampleCarPane(st);
            var na = geo.attributes.normal, n = na && na.count
              ? new THREE.Vector3(na.getX(0),na.getY(0),na.getZ(0)).normalize()
              : new THREE.Vector3(0,0,1);
            damageCarPane(st,c,n,n.clone().negate(),damage || 16);
          }
          return carGlassState(index | 0);
        },
        debrisCount: function () { return CGLASS.debris.length; },
        advance: function (dt) {
          updateCarGlassDebris(clamp(+dt || 0,0,.25));
          return CGLASS.debris.length;
        }
      },
      glass: {
        count: function () { return HGLASS.panes.length; },
        ready: function () { return HGLASS.ready; },
        panes: HGLASS.panes,
        state: glassState,
        states: function () {
          var out = []; for (var i = 0; i < HGLASS.states.length; i++) out.push(glassState(i));
          return out;
        },
        damage: function (index, hits, damage) {
          var st = HGLASS.states[index | 0]; if (!st) return null;
          hits = clamp(hits | 0, 1, 24);
          for (var i = 0; i < hits; i++) {
            var u = (hhash(st.desc.seed * 31 + i * 7.3) - .5) * st.desc.width * .38;
            var v = (hhash(st.desc.seed * 47 + i * 11.1) - .5) * st.desc.height * .38;
            damagePane(st, u, v, damage || 24,
              { x: -st.desc.normal[0], y: 0, z: -st.desc.normal[2] }, false);
          }
          return glassState(index | 0);
        },
        debrisCount: function () { return HGLASS.debris.length; },
        debrisState: function () {
          return HGLASS.debris.map(function (d) {
            return { id: d.id, x: d.x, y: d.y, z: d.z, vy: d.vy,
              bounces: d.bounces, settled: d.settled, life: d.life };
          });
        },
        roomContents: function (index) {
          var st = HGLASS.states[index | 0];
          return st && st.room && st.room.userData.contents ? st.room.userData.contents.slice() : [];
        },
        roomsVisible: function () { return STATS.roomsRevealed; },
        fallbackVisible: function () { return !!(HGLASS.source && HGLASS.source.visible); }
      },
      breakAll: function () {   /* debug lever */
        var map = crateMap(), k, n = 0;
        for (k in map) if (Object.prototype.hasOwnProperty.call(map, k)) { breakCrate(map[k], null); n++; }
        return n;
      }
    };
    var nCrates = 0, k2, m2 = crateMap();
    for (k2 in m2) if (Object.prototype.hasOwnProperty.call(m2, k2)) nCrates++;
    try {
      console.warn('[nz-destruct] threw:0 pool ' + POOL_N + ' quads, ' + nCrates +
        ' breakable crates, ' + cars.length + ' car boxes, ' +
        STATS.glassPanes + ' hero glass panes, ' + STATS.carGlassPanes + ' car panes, ' +
        (DIAG.warnings.length) + ' warnings, ' + STATS.ms + 'ms');
    } catch (e) {}
  }

  function report() {
    var L = ['NZ-DESTRUCT'];
    L.push('  holes ' + STATS.holes + ' (deepened ' + STATS.deepened + ')  pool wraps ' + STATS.poolWraps);
    L.push('  car hits ' + STATS.carHits + '  glass ' + STATS.glassHits +
      '  crate hits ' + STATS.crateHits + '  crates broken ' + STATS.cratesBroken);
    L.push('  facade panes ' + STATS.glassPanes + '  hits ' + STATS.buildingGlassHits +
      '  cracked ' + STATS.panesCracked + '  collapsed ' + STATS.panesCollapsed +
      '  rooms ' + STATS.roomsRevealed);
    L.push('  car panes ' + STATS.carGlassPanes + '  broken ' + STATS.carPanesBroken +
      '  shard peak ' + STATS.carGlassDebrisPeak);
    L.push('  scorches ' + STATS.scorches + '  debris peak ' + STATS.debrisPeak +
      '  glass debris peak ' + STATS.glassDebrisPeak +
      '  mesh-ray budget skips ' + STATS.meshRayBudgetSkips);
    for (var i = 0; i < DIAG.warnings.length; i++) L.push('  ! ' + DIAG.warnings[i]);
    return L.join('\n');
  }

  /* hooks.  'render' at priority 40: debris integrates before nz-render's
     priority-0 listener claims the frame, and NZ.first carries on down the
     chain because this listener returns undefined. */
  NZ.on('surfaceHit', onSurfaceHit);
  NZ.on('render', function (dt) {
    frameNo++;                       /* clocks the per-frame mesh-ray budget */
    var playing = !G || !G.state || !!G.state.playing;
    if (installed && !dead && playing) {
      updateDebris(dt || 0); updateGlassDebris(dt || 0); updateCarGlassDebris(dt || 0);
    }
  }, 40);
  NZ.on('ready', function (ctx) {
    if (dead || installed) return;
    try { install(ctx); }
    catch (err) {
      dead = true;
      try { console.error('[nz-destruct] install failed: ', err); } catch (e) {}
    }
  });

  NZ.log && NZ.log('destruct module loaded');
})(typeof window !== 'undefined' ? window : this);
