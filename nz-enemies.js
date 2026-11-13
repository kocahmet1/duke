/* ===========================================================================
   NZ-ENEMIES  --  procedural skinned characters, CS2-grade.

   ROSTER (CS2-ENEMY-BRIEF section 1). The alien/mutant cast is retired: all
   four `kind` IDs are now human operators sharing ONE skeleton, one biped
   locomotion solver and one ragdoll spec. The IDs are frozen because three
   other files switch on them; only the fiction and the art changed.

       trooper  -> RIFLEMAN    light rig, boonie          AK-pattern,  880 mm
       pig      -> BREACHER    full plate, visored helmet shotgun,    1005 mm
       enforcer -> ASSAULTER   plate, balaclava, headset  M4-pattern,  840 mm
       octa     -> MARKSMAN    hood + scrim, low-vis      bolt DMR,   1160 mm

   Every dimension in the weapon and kit code is a real millimetre figure
   multiplied by SPEC[kind].mpm (model units per metre), calibrated per kind
   from ECFG at install time -- so an AK is 880 mm in every operator's hands
   regardless of how tall the config makes him.

   Replaces the stock primitive rig (scaled boxes/spheres parented in a Group)
   AND the 2D sprite-sheet far LOD with:

     * real anatomy    a landmark-driven proportion system (7.7-head canon,
                       anthropometric limb ratios, correct hand / foot / head
                       scale) lofted into one merged buffer
     * real gear       plate carrier, cummerbund, mag pouches, admin pouch,
                       radio, belt, dump pouches, thigh holster, knee pads,
                       laced boots with a separate sole, gloves with fingers,
                       helmet + NVG mount + rails + chin strap, headset --
                       all chamfered, all in the same draw call
     * real skinning   THREE.Skeleton + SkinnedMesh, weights from bone-segment
                       distance with a masked bone set, exactly 4 influences,
                       normalised so the four weights sum to 1
     * procedural PBR  a 1024x1024 16-region atlas baked through NZ.tex.bake:
                       albedo / normal / ORM(ao,rough,metal) / emissive plus
                       per-region SHEEN (cloth, nylon, knit) and CLEARCOAT
                       (helmet polymer, lens, scale) so fabric, leather, hard
                       plastic, steel and skin read as different materials
                       from one MeshPhysicalMaterial
     * animation       plant-locked foot IK with heel-to-toe roll, world-locked
                       foot yaw (real turn-in-place, zero skating), pelvis
                       translate + rotate, counter-rotating spine, sprung
                       weapon carry with lag and follow-through, gaze-stabilised
                       head, directional per-limb hit flinch
     * ragdoll         verlet particles seeded from the exact animated pose with
                       inherited per-particle velocity, hinge constraints that
                       stop elbows and knees inverting, approximate
                       self-collision, energy-adaptive damping and a sleep latch
     * LOD             LOD0 full skinned, LOD1 same silhouette / lower tessell-
                       ation (both cast shadows), LOD2 an InstancedMesh pose
                       bank; hysteresis on every switch so nothing pops

   ZERO external assets: every vertex, texture and animation curve here is
   generated at runtime. Classic script, no modules, three.js r149 UMD surface
   only. BufferGeometryUtils / SkeletonUtils live in examples/js so they are
   NOT in the UMD build -- the merge helper below is our own.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;

  var THREE = null;

  /* ------------------------------------------------------------- helpers -- */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function fract(v) { return v - Math.floor(v); }
  function angWrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  /* frame-rate independent damping: rate = fraction remaining after 1 second */
  function damp(a, b, rate, dt) { return b + (a - b) * Math.pow(rate, dt); }

  /* ---- locomotion helpers ------------------------------------------------
     A gait that repeats EXACTLY is the loudest procedural tell there is, so
     every amplitude in the walk is modulated by a smooth 1-D value noise
     sampled on the gait counter (i.e. one new value per cycle, interpolated)
     and by a per-character constant drawn from the enemy's own seed. */
  function noise1(x) {
    var i = Math.floor(x), f = x - i;
    f = f * f * (3 - 2 * f);
    return (lerp(hash1(i * 1.7 + 3.3), hash1(i * 1.7 + 5.0), f)) * 2 - 1;   /* -1..1 */
  }
  /* signed per-character constant, -1..1, one per (seed, channel) */
  function srand(seed, k) { return hash1(seed * 13.17 + k * 7.31 + 0.5) * 2 - 1; }
  /* forward distance from b to a on the unit cycle, always 0..1 */
  function cycFwd(a, b) { var d = a - b; return d - Math.floor(d); }

  /* Second-order angle tracker with wrap-around and a hard error clamp.
     The body yaw rides this rather than snapping to the AI's facing, which is
     what turns "the whole doll pivots at once" into head -> chest -> hips. */
  function AngTrack(k, d, maxErr) {
    this.a = 0; this.v = 0; this.k = k; this.d = d; this.max = maxErr; this.init = false;
  }
  AngTrack.prototype.step = function (target, dt) {
    if (!this.init) { this.init = true; this.a = target; this.v = 0; return this.a; }
    var rem = Math.min(dt, 0.1), h = 1 / 180;
    while (rem > 0) {
      var s = h < rem ? h : rem; rem -= s;
      this.v += (angWrap(target - this.a) * this.k - this.v * this.d) * s;
      this.a += this.v * s;
    }
    this.a = angWrap(this.a);
    var e2 = angWrap(target - this.a);
    if (e2 > this.max) { this.a = angWrap(target - this.max); this.v *= 0.4; }
    else if (e2 < -this.max) { this.a = angWrap(target + this.max); this.v *= 0.4; }
    return this.a;
  };

  /* Smooth 3D value noise, evaluated at BUILD time on bind-pose vertex
     positions. This is how the cloth gets sun-fade on the shoulders and grime
     in the creases without any per-part texture authoring -- and unlike a UV
     pattern it is scale-consistent across a boot and a torso. */
  function vhash3(i, j, k) {
    var h = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
    return h - Math.floor(h);
  }
  function vnoise3(x, y, z) {
    var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    var fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    var c000 = vhash3(xi, yi, zi), c100 = vhash3(xi + 1, yi, zi);
    var c010 = vhash3(xi, yi + 1, zi), c110 = vhash3(xi + 1, yi + 1, zi);
    var c001 = vhash3(xi, yi, zi + 1), c101 = vhash3(xi + 1, yi, zi + 1);
    var c011 = vhash3(xi, yi + 1, zi + 1), c111 = vhash3(xi + 1, yi + 1, zi + 1);
    var x00 = lerp(c000, c100, fx), x10 = lerp(c010, c110, fx);
    var x01 = lerp(c001, c101, fx), x11 = lerp(c011, c111, fx);
    return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
  }

  var KINDS = ['trooper', 'pig', 'enforcer', 'octa'];

  /* Panic latch. Any throw inside a per-frame hook flips this; from then on we
     run a minimal transform-only path instead of letting the exception escape
     into the game loop (a thrown hook would be disabled by the bus and the
     stock animator would then be handed OUR rig object and die every frame). */
  var PANIC = 0, PANIC_LOG = 0;
  function panic(err) {
    PANIC++;
    if (PANIC_LOG < 3) { PANIC_LOG++; console.error('[nz-enemies] runtime error, degrading:', err); }
  }

  /* =========================================================================
     1. GEOMETRY TOOLKIT
     ====================================================================== */

  /* Vertex accumulator. Keeps a per-vertex "mask" (the list of bone indices a
     vertex is allowed to be weighted to) so skinning stays clean -- a purely
     distance based bind would let the left forearm grab right-side ribs. */
  function Pile() {
    this.p = []; this.uv = []; this.col = []; this.mask = []; this.idx = []; this.n = 0;
    this.wc = [];
  }
  Pile.prototype.vert = function (x, y, z, u, v, r, g, b, mask) {
    this.p.push(x, y, z); this.uv.push(u, v); this.col.push(r, g, b); this.mask.push(mask);
    this.wc.push(WCLS);
    return this.n++;
  };

  /* ---- weathering class ---------------------------------------------------
     How much of the environment a surface is allowed to carry. Skin and glass
     get none; a rifle gets dust and a dye shift but never sun-bleaches; cloth
     and nylon get the lot. Set once per part by the add* entry points and read
     per vertex, which is the cheapest way to key a global pass on a local
     property without threading an argument through nine call sites. */
  var WCLS = 1, WSCALE = 1;
  function wclsOf(opt) {
    if (opt.sss) return 0;
    var n = opt.name || '';
    if (n === 'lens' || n === 'lensframe' || n === 'lensrim' || n === 'visor' ||
      n === 'eye' || n === 'pupil' || n === 'sclera') return 0;
    return WSCALE;
  }
  Pile.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Pile.prototype.quad = function (a, b, c, d) { this.idx.push(a, b, c, a, c, d); };

  /* ---- build-time PART INDEX (off in the game) --------------------------
     Null in every shipping path, so this costs one branch per part. The
     anthropometry probe turns it on through `_probe` below, builds one
     figure, and gets back [{n:'thigh', a:v0, b:v1}, ...] -- which is what
     lets a station like "thigh, 90% of the way to the knee" be MEASURED off
     the real vertices of the real part instead of read back out of the
     constant that produced it. Every limb girth in section 5 was set against
     this rather than by eye; see the table in buildBiped. */
  var PARTS = null;
  function partMark(pile, name, v0) {
    if (PARTS && name && pile.n > v0) PARTS.push({ n: name, a: v0, b: pile.n });
  }

  /* Our own merge. Everything is accumulated into one Pile so the "merge" is
     really just the final buffer emit -- which is the cheapest possible
     mergeBufferGeometries and gives us exactly one draw call per character. */
  function pileToGeometry(pile, segs, W) {
    var g = new THREE.BufferGeometry();
    /* Last line of defence. One non-finite position makes computeBoundingSphere
       return NaN, which fails the frustum test and silently drops the entire
       mesh -- so report precisely what happened, then repair rather than lose
       the character. */
    var _bad = 0, _first = -1, _pi;
    for (_pi = 0; _pi < pile.p.length; _pi++) {
      if (!isFinite(pile.p[_pi])) { if (_first < 0) _first = _pi; pile.p[_pi] = 0; _bad++; }
    }
    if (_bad) {
      console.error('[nz-enemies] scrubbed ' + _bad + ' non-finite position value(s), first at vertex ' +
        Math.floor(_first / 3) + ' of ' + pile.n + ' (component ' + (_first % 3) + '). Geometry repaired to 0.');
    }
    for (_pi = 0; _pi < pile.uv.length; _pi++) if (!isFinite(pile.uv[_pi])) pile.uv[_pi] = 0;
    for (_pi = 0; _pi < pile.col.length; _pi++) if (!isFinite(pile.col[_pi])) pile.col[_pi] = 0;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pile.p, 3));
    /* uv2 shares the very same BufferAttribute (one GL buffer, two bind
       points) -- r149 samples aoMap through vUv2 and would otherwise read a
       single texel forever. */
    var uvAttr = new THREE.Float32BufferAttribute(pile.uv, 2);
    g.setAttribute('uv', uvAttr);
    g.setAttribute('uv2', uvAttr);
    g.setAttribute('color', new THREE.Float32BufferAttribute(pile.col, 3));
    g.setIndex(pile.idx);
    if (segs) bindSkin(g, pile, segs, W);
    /* Per-part vertices are never shared between parts, so averaging normals
       smooths inside a part and keeps a hard edge at part boundaries. */
    g.computeVertexNormals();
    return g;
  }

  /* =========================================================================
     ALBEDO VARIATION INSIDE A PART.

     Round 5 calmed the relief and never touched the hue, so a whole sleeve
     was one flat colour under a good normal map -- which is exactly the line
     between a game asset and a CS2 asset. Real fabric on a real person is
     never one colour: the up-facing planes bleach in the sun, the hems and
     the knees carry the ground, and a panel that has been replaced came off a
     different dye lot.

     Three terms, all sampled in BIND SPACE so the feature size is a real
     length and stays constant between a cuff and a torso, and all multiplied
     into the vertex colour rather than added, so nothing can drift off the
     calibrated palette:

       DYE LOT   +-5%, per channel out of phase, ~0.34 m features. This is
                 what produces HUE variation rather than value variation --
                 the thing that was actually missing.
       SUN       up-facing planes only (n.y), +14% value and a pull toward
                 grey. A shoulder is always lighter than a flank.
       GROUND    below 1.0 m, blotchy, mixing toward a warm dust that is
                 derived from the surface's own luminance -- so a black boot
                 gets dusty rather than beige.

     Everything is restrained on purpose: the brief's word is "grounded".
     ====================================================================== */
  function weatherPile(g, pile, H, mpm, seed) {
    var pa = g.attributes.position, na = g.attributes.normal, ca = g.attributes.color;
    if (!pa || !na || !ca || !pile.wc) return;
    var P = pa.array, N = na.array, C = ca.array, wc = pile.wc, n = pa.count;
    if (wc.length < n) return;
    var fD = 1 / (0.34 * mpm);                 /* dye-lot feature size, 340 mm */
    var fG = 1 / (0.15 * mpm);                 /* dust blotch, 150 mm          */
    var yTop = 1.00 * mpm, yBot = 0.08 * mpm;  /* dust rides from 1.0 m down   */
    var ySun0 = 0.30 * mpm, ySunD = 0.55 * mpm; /* sun bleach starts at 300 mm */
    var ph = (seed || 0) * 13.7;
    for (var i = 0; i < n; i++) {
      var w = wc[i]; if (!(w > 0)) continue;
      var o = i * 3;
      var x = P[o], y = P[o + 1], z = P[o + 2];
      var r = C[o], gg = C[o + 1], b = C[o + 2];
      var lum = r * 0.30 + gg * 0.59 + b * 0.11;
      /* --- dye lot: three decorrelated samples, one per channel --- */
      /* two samples, not three: red takes one, blue the other and green their
         mean, which IS the warm/cool dye axis and costs a third less */
      var d0 = vnoise3(x * fD + ph, y * fD, z * fD) - 0.5;
      var d1 = vnoise3(x * fD + 11.3 + ph, y * fD + 4.1, z * fD - 7.7) - 0.5;
      var k = 0.100 * w;
      r *= 1 + d0 * k; gg *= 1 + (d0 + d1) * 0.5 * k * 0.92; b *= 1 + d1 * k * 0.84;
      /* --- sun on the up-facing planes ---
         Gated by height: cloth on a shoulder bleaches, a boot toe on the
         floor does not -- it scuffs and it polishes, and lifting it instead
         is what turned the toe box into a pale rock stuck on a dark boot. */
      var up = N[o + 1]; if (up < 0) up = 0;
      var sg = (y - ySun0) / ySunD; if (sg < 0) sg = 0; else if (sg > 1) sg = 1;
      var sun = up * up * 0.145 * w * sg;
      if (sun > 0.001) {
        r = r * (1 + sun) * (1 - sun * 0.30) + lum * sun * 0.34;
        gg = gg * (1 + sun) * (1 - sun * 0.30) + lum * sun * 0.33;
        b = b * (1 + sun) * (1 - sun * 0.30) + lum * sun * 0.30;
      }
      /* --- ground dust --- */
      var t = (yTop - y) / (yTop - yBot);
      if (t > 0) {
        if (t > 1) t = 1;
        t = t * t * (3 - 2 * t);
        var bl = (vnoise3(x * fG + 31.7, y * fG, z * fG) - 0.30) * 2.1;
        if (bl > 1) bl = 1;
        if (bl > 0) {
          /* Dust shows on a dark surface and hides on a pale one, which is
             also what keeps the operators SEPARATING from a pale concrete
             floor: lifting an already-light trouser leg toward the ground
             colour is the one thing this pass must not do. */
          var lz = lum * 4; if (lz > 1) lz = 1;
          var m = t * bl * 0.22 * w * (0.52 + 0.48 * (1 - lz));
          /* the dust is the SURFACE'S OWN value, warmed and lifted -- so it
             greys a black boot instead of painting it sand */
          var dr = lum * 1.55 + 0.012, dg = lum * 1.42 + 0.010, db = lum * 1.16 + 0.008;
          r += (dr - r) * m; gg += (dg - gg) * m; b += (db - b) * m;
        }
      }
      C[o] = r; C[o + 1] = gg; C[o + 2] = b;
    }
    ca.needsUpdate = true;
  }

  /* =========================================================================
     BAKED AMBIENT OCCLUSION

     The ORM red channel is a per-TILE cavity map: it knows a boot lace sits in
     a groove, it does not know an armpit exists. Nothing in the pipeline was
     computing occlusion at MODEL scale, which is why the figure had no darkening
     under the arms, at the neck, in the gear gaps or in the crotch, and read as
     one moulded shell. aoMap could not have fixed that at any intensity.

     Solved here, once, at build time, as a density field:
       1. splat every triangle's AREA into a coarse 3D grid (area, not vertex
          count -- otherwise a densely tessellated finger reads as a solid)
       2. two separable box blurs give a near field (creases) and a far field
          (broad body shadowing)
       3. each vertex samples both fields a short way along its own normal
       4. the two are normalised against their own 12th/92nd percentiles, so
          the calibration cannot drift between a trooper, an octa and a LOD

     The result multiplies the vertex tint, so it darkens direct light as well
     as indirect. That is not strictly correct AO, but the scene has no working
     SSAO to lean on and a character with NO occlusion term at all is the more
     serious error by a wide margin.
     ====================================================================== */
  function box3(D, T, gx, gy, gz, R) {
    var inv = 1 / (2 * R + 1), x, y, z, o, sum, i;
    /* X */
    for (z = 0; z < gz; z++) for (y = 0; y < gy; y++) {
      var row = (z * gy + y) * gx;
      sum = 0;
      for (o = -R; o <= R; o++) sum += D[row + clamp(o, 0, gx - 1)];
      for (x = 0; x < gx; x++) {
        T[row + x] = sum * inv;
        sum -= D[row + clamp(x - R, 0, gx - 1)];
        sum += D[row + clamp(x + R + 1, 0, gx - 1)];
      }
    }
    /* Y */
    for (z = 0; z < gz; z++) for (x = 0; x < gx; x++) {
      var base = z * gy * gx + x;
      sum = 0;
      for (o = -R; o <= R; o++) sum += T[base + clamp(o, 0, gy - 1) * gx];
      for (y = 0; y < gy; y++) {
        D[base + y * gx] = sum * inv;
        sum -= T[base + clamp(y - R, 0, gy - 1) * gx];
        sum += T[base + clamp(y + R + 1, 0, gy - 1) * gx];
      }
    }
    /* Z */
    var plane = gx * gy;
    for (y = 0; y < gy; y++) for (x = 0; x < gx; x++) {
      var b2 = y * gx + x;
      sum = 0;
      for (o = -R; o <= R; o++) sum += D[b2 + clamp(o, 0, gz - 1) * plane];
      for (z = 0; z < gz; z++) {
        T[b2 + z * plane] = sum * inv;
        sum -= D[b2 + clamp(z - R, 0, gz - 1) * plane];
        sum += D[b2 + clamp(z + R + 1, 0, gz - 1) * plane];
      }
    }
    for (i = 0; i < D.length; i++) D[i] = T[i];
  }

  function bakeAO(pile, H, strength) {
    var n = pile.n, I = pile.idx, P = pile.p;
    if (!n || !I || I.length < 3) return null;
    var i, j, k, ia, ib, ic;

    /* --- area-weighted vertex normals + per-triangle area --------------- */
    var N = new Float32Array(n * 3);
    var tris = (I.length / 3) | 0;
    var tcx = new Float32Array(tris), tcy = new Float32Array(tris), tcz = new Float32Array(tris);
    var tar = new Float32Array(tris);
    for (i = 0, k = 0; k < tris; i += 3, k++) {
      ia = I[i] * 3; ib = I[i + 1] * 3; ic = I[i + 2] * 3;
      var ux = P[ib] - P[ia], uy = P[ib + 1] - P[ia + 1], uz = P[ib + 2] - P[ia + 2];
      var vx = P[ic] - P[ia], vy = P[ic + 1] - P[ia + 1], vz = P[ic + 2] - P[ia + 2];
      var fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      N[ia] += fx; N[ia + 1] += fy; N[ia + 2] += fz;
      N[ib] += fx; N[ib + 1] += fy; N[ib + 2] += fz;
      N[ic] += fx; N[ic + 1] += fy; N[ic + 2] += fz;
      tar[k] = Math.sqrt(fx * fx + fy * fy + fz * fz) * 0.5;
      tcx[k] = (P[ia] + P[ib] + P[ic]) / 3;
      tcy[k] = (P[ia + 1] + P[ib + 1] + P[ic + 1]) / 3;
      tcz[k] = (P[ia + 2] + P[ib + 2] + P[ic + 2]) / 3;
    }
    for (i = 0; i < n; i++) {
      j = i * 3;
      var L = Math.sqrt(N[j] * N[j] + N[j + 1] * N[j + 1] + N[j + 2] * N[j + 2]);
      if (L > 1e-9) { N[j] /= L; N[j + 1] /= L; N[j + 2] /= L; } else { N[j + 1] = 1; }
    }

    /* --- grid ----------------------------------------------------------- */
    var cw = 0.021 * H;
    var lx = 1e9, ly = 1e9, lz = 1e9, hx = -1e9, hy = -1e9, hz = -1e9;
    for (i = 0; i < n; i++) {
      j = i * 3;
      if (P[j] < lx) lx = P[j]; if (P[j] > hx) hx = P[j];
      if (P[j + 1] < ly) ly = P[j + 1]; if (P[j + 1] > hy) hy = P[j + 1];
      if (P[j + 2] < lz) lz = P[j + 2]; if (P[j + 2] > hz) hz = P[j + 2];
    }
    if (!isFinite(lx) || !isFinite(hx)) return null;
    var Rn = Math.max(1, Math.round(0.052 * H / cw));
    var Rf = Math.max(2, Math.round(0.190 * H / cw));
    var pad = Rf + 2;
    var ox = lx - pad * cw, oy = ly - pad * cw, oz = lz - pad * cw;
    var gx = Math.ceil((hx - lx) / cw) + pad * 2 + 2;
    var gy = Math.ceil((hy - ly) / cw) + pad * 2 + 2;
    var gz = Math.ceil((hz - lz) / cw) + pad * 2 + 2;
    if (gx * gy * gz > 4.2e6) return null;          /* refuse to be silly */
    var cells = gx * gy * gz;
    var Dn = new Float32Array(cells), Tmp = new Float32Array(cells);

    var plane = gx * gy;
    function splat(D, x, y, z, w) {
      var sx = (x - ox) / cw, sy = (y - oy) / cw, sz = (z - oz) / cw;
      var i0 = Math.floor(sx), j0 = Math.floor(sy), k0 = Math.floor(sz);
      if (i0 < 0 || j0 < 0 || k0 < 0 || i0 >= gx - 1 || j0 >= gy - 1 || k0 >= gz - 1) return;
      var tx = sx - i0, ty = sy - j0, tz = sz - k0;
      var b0 = k0 * plane + j0 * gx + i0;
      var w0 = 1 - tx, w1 = tx;
      D[b0] += w * w0 * (1 - ty) * (1 - tz);
      D[b0 + 1] += w * w1 * (1 - ty) * (1 - tz);
      D[b0 + gx] += w * w0 * ty * (1 - tz);
      D[b0 + gx + 1] += w * w1 * ty * (1 - tz);
      D[b0 + plane] += w * w0 * (1 - ty) * tz;
      D[b0 + plane + 1] += w * w1 * (1 - ty) * tz;
      D[b0 + plane + gx] += w * w0 * ty * tz;
      D[b0 + plane + gx + 1] += w * w1 * ty * tz;
    }
    function sample(D, x, y, z) {
      var sx = (x - ox) / cw, sy = (y - oy) / cw, sz = (z - oz) / cw;
      var i0 = Math.floor(sx), j0 = Math.floor(sy), k0 = Math.floor(sz);
      if (i0 < 0 || j0 < 0 || k0 < 0 || i0 >= gx - 1 || j0 >= gy - 1 || k0 >= gz - 1) return 0;
      var tx = sx - i0, ty = sy - j0, tz = sz - k0;
      var b0 = k0 * plane + j0 * gx + i0;
      var a00 = D[b0] + (D[b0 + 1] - D[b0]) * tx;
      var a10 = D[b0 + gx] + (D[b0 + gx + 1] - D[b0 + gx]) * tx;
      var a01 = D[b0 + plane] + (D[b0 + plane + 1] - D[b0 + plane]) * tx;
      var a11 = D[b0 + plane + gx] + (D[b0 + plane + gx + 1] - D[b0 + plane + gx]) * tx;
      var b00 = a00 + (a10 - a00) * ty, b01 = a01 + (a11 - a01) * ty;
      return b00 + (b01 - b00) * tz;
    }

    /* surface area, distributed over each triangle so a long thin poly does
       not collapse onto one cell */
    for (k = 0; k < tris; k++) {
      var A = tar[k]; if (!(A > 0)) continue;
      splat(Dn, tcx[k], tcy[k], tcz[k], A * 0.4);
      for (var q = 0; q < 3; q++) {
        var vi = I[k * 3 + q] * 3;
        splat(Dn, P[vi], P[vi + 1], P[vi + 2], A * 0.2);
      }
    }
    var Df = new Float32Array(Dn);          /* far field starts as a copy */
    box3(Dn, Tmp, gx, gy, gz, Rn);
    box3(Df, Tmp, gx, gy, gz, Rf);

    /* --- sample ---------------------------------------------------------- */
    var offN = 0.55 * Rn * cw, offF = 0.40 * Rf * cw;
    var on = new Float32Array(n), of = new Float32Array(n);
    for (i = 0; i < n; i++) {
      j = i * 3;
      on[i] = sample(Dn, P[j] + N[j] * offN, P[j + 1] + N[j + 1] * offN, P[j + 2] + N[j + 2] * offN);
      of[i] = sample(Df, P[j] + N[j] * offF, P[j + 1] + N[j + 1] * offF, P[j + 2] + N[j + 2] * offF);
    }
    function pct(src, p) {
      var s = new Float32Array(src); s.sort();   /* TypedArray sort is numeric */
      return s[clamp(Math.floor(p * (s.length - 1)), 0, s.length - 1)];
    }
    var nLo = pct(on, 0.12), nHi = pct(on, 0.92);
    var fLo = pct(of, 0.12), fHi = pct(of, 0.92);
    var nSpan = Math.max(1e-9, nHi - nLo), fSpan = Math.max(1e-9, fHi - fLo);

    var S = strength === undefined ? 0.70 : strength;
    var ao = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var t = clamp((on[i] - nLo) / nSpan, 0, 1) * 0.70 +
        clamp((of[i] - fLo) / fSpan, 0, 1) * 0.30;
      /* squared falls off slowly near the open end and bites in the creases */
      ao[i] = clamp(1 - S * (t * t * (3 - 2 * t)), 1 - S, 1);
      var o3 = i * 3;
      pile.col[o3] *= ao[i]; pile.col[o3 + 1] *= ao[i]; pile.col[o3 + 2] *= ao[i];
    }
    return ao;
  }

  /* squared distance from a point to a bone segment */
  function distSeg(x, y, z, s) {
    var ax = s[0], ay = s[1], az = s[2], bx = s[3], by = s[4], bz = s[5];
    var ex = bx - ax, ey = by - ay, ez = bz - az;
    var l2 = ex * ex + ey * ey + ez * ez;
    var t = l2 > 1e-9 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var dx = x - (ax + ex * t), dy = y - (ay + ey * t), dz = z - (az + ez * t);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* Procedural skin weights. w = 1/(d+eps)^4 over the allowed bone set, top 4,
     normalised so the four weights sum to exactly 1 (float drift here shows up
     as shrinking limbs, so the last component is solved rather than divided).
     Never more than four influences by construction. */
  function bindSkin(geo, pile, segs, W) {
    W = W || skinWeights(pile, segs);
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(W.si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(W.sw, 4));
  }
  function skinWeights(pile, segs) {
    var n = pile.n, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    var bi = [0, 0, 0, 0], bw = [0, 0, 0, 0];
    for (var v = 0; v < n; v++) {
      var x = pile.p[v * 3], y = pile.p[v * 3 + 1], z = pile.p[v * 3 + 2];
      var mask = pile.mask[v], j, m;
      bi[0] = bi[1] = bi[2] = bi[3] = 0; bw[0] = bw[1] = bw[2] = bw[3] = 0;
      for (m = 0; m < mask.length; m++) {
        var b = mask[m], s = segs[b];
        if (!s) continue;
        var d = distSeg(x, y, z, s) + 0.035;
        var w = 1 / (d * d * d * d);
        /* insertion sort into the top-4 */
        for (j = 0; j < 4; j++) {
          if (w > bw[j]) {
            for (var q = 3; q > j; q--) { bw[q] = bw[q - 1]; bi[q] = bi[q - 1]; }
            bw[j] = w; bi[j] = b; break;
          }
        }
      }
      var sum = bw[0] + bw[1] + bw[2] + bw[3];
      if (sum <= 0) { bw[0] = 1; sum = 1; }
      var o = v * 4;
      sw[o + 1] = bw[1] / sum; sw[o + 2] = bw[2] / sum; sw[o + 3] = bw[3] / sum;
      sw[o] = 1 - sw[o + 1] - sw[o + 2] - sw[o + 3];
      si[o] = bi[0]; si[o + 1] = bi[1]; si[o + 2] = bi[2]; si[o + 3] = bi[3];
    }
    return { si: si, sw: sw };
  }

  /* ------------------------------------------------------------- lofting -- */
  var _lv = null;   /* lazily built once THREE exists */
  function lazyTemps() {
    if (_lv) return;
    _lv = {
      v: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
      v4: new THREE.Vector3(), v5: new THREE.Vector3(),
      m: new THREE.Matrix4(), m2: new THREE.Matrix4(), m3: new THREE.Matrix4(),
      q: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(),
      q4: new THREE.Quaternion(),
      e: new THREE.Euler(), c: new THREE.Color()
    };
  }

  /* base * translate(p) * euler(r) * scale(s) -- the gear placement workhorse */
  function xf(base, p, r, s) {
    var m = new THREE.Matrix4();
    _lv.e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, 'XYZ');
    _lv.q.setFromEuler(_lv.e);
    _lv.v.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
    _lv.v2.set(s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1);
    m.compose(_lv.v, _lv.q, _lv.v2);
    return new THREE.Matrix4().multiplyMatrices(base, m);
  }

  /* superellipse cross-section: n=2 ellipse, n=4 rounded rect, n=1.4 pointy */
  function profX(a, rx, n) {
    var c = Math.cos(a);
    if (n === 2) return rx * c;
    return rx * (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), 2 / n);
  }
  function profZ(a, rz, n) {
    var s = Math.sin(a);
    if (n === 2) return rz * s;
    return rz * (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), 2 / n);
  }

  /* Angle set that clusters samples at the four superellipse corners so a
     hard-surface part gets a real chamfer instead of a facet. A pure 90 degree
     edge is the #1 tell of a prototype; this is how we avoid it cheaply. */
  var _chamCache = {};
  function chamferAngles(perQuad, bias, rot) {
    perQuad = Math.max(2, perQuad | 0);
    bias = bias === undefined ? 1.75 : bias;
    rot = rot || 0;
    var key = perQuad + ':' + bias + ':' + rot.toFixed(3);
    if (_chamCache[key]) return _chamCache[key];
    var out = [], q, i;
    for (q = 0; q < 4; q++) {
      var c = q * (PI / 2) + PI / 4;
      for (i = 0; i < perQuad; i++) {
        var s = -1 + (2 * i + 1) / perQuad;
        var sg = s < 0 ? -1 : 1;
        out.push(c + (PI / 4) * sg * Math.pow(Math.abs(s), bias) + rot);
      }
    }
    _chamCache[key] = out;
    return out;
  }

  /* addLoft
       sections: [{ y, cx, cz, rx, rz, n, ao, uv, flat }]
       M:        Matrix4 placing the loft (usually a bone's bind world matrix)
       reg:      atlas region {u0,v0,du,dv}
       col:      [r,g,b] linear tint
       mask:     bone index list this part may bind to
       opt:      { rot, angles, capStart, capEnd, aoDir, sss, wear, wearFreq,
                   tone, name }
     Sections are lofted in order; radius 0 at an end makes a pole (so heads
     and hands close without a fan cap).                                     */
  function addLoft(pile, M, sections, sides, reg, col, mask, opt) {
    opt = opt || {};
    WCLS = wclsOf(opt);
    var S = sections.length, rows = [], s, i, _v0 = pile.n;
    var up = sections[S - 1].y >= sections[0].y;
    if (!M || !M.elements) { console.error('[nz-enemies] addLoft: no matrix for part', opt.name || '(unnamed)'); return []; }
    var el = M.elements;
    /* A single NaN in a bind matrix poisons every vertex lofted through it and
       then the whole merged geometry, so catch it at the source and name it. */
    for (i = 0; i < 16; i++) if (!isFinite(el[i])) {
      console.error('[nz-enemies] addLoft: non-finite bind matrix for part',
        opt.name || '(unnamed)', 'element', i, el[i], '- part skipped');
      return [];
    }
    for (s = 0; s < S; s++) {
      var _c = sections[s];
      if (!isFinite(_c.y) || !isFinite(_c.rx) || !isFinite(_c.rz)) {
        console.error('[nz-enemies] addLoft: non-finite section', s, 'of part',
          opt.name || '(unnamed)', JSON.stringify({ y: _c.y, rx: _c.rx, rz: _c.rz, n: _c.n }), '- part skipped');
        return [];
      }
    }
    var angles = opt.angles || null;
    var NA = angles ? angles.length : sides;
    var wf = opt.wear ? (opt.wearFreq || 1.6) : 0;
    var tone = opt.tone === undefined ? 1 : opt.tone;
    for (s = 0; s < S; s++) {
      var sec = sections[s], row = [];
      /* S===1 would make s/(S-1) a 0/0 NaN, and clamp() passes NaN straight
         through because every NaN comparison is false. */
      var _uv = sec.uv === undefined ? (S > 1 ? s / (S - 1) : 0) : sec.uv;
      if (!isFinite(_uv)) _uv = 0;
      var vv = reg.v0 + clamp(_uv, 0, 1) * reg.dv;
      var ex = sec.n || 2, ao = sec.ao === undefined ? 1 : sec.ao;
      var pole = (sec.rx < 1e-4 && sec.rz < 1e-4);
      var lim = pole ? 0 : NA;
      for (i = 0; i <= lim; i++) {
        var a = angles ? angles[i % NA] : (i / NA) * TAU + (opt.rot || 0);
        var px = profX(a, sec.rx, ex), pz = profZ(a, sec.rz, ex);
        if (sec.flat) pz *= (pz > 0 ? 1 : sec.flat);
        /* cx must default like cz does: only limbSections sets it, so every
           other section builder was producing `undefined + px` === NaN here. */
        var lx = (sec.cx || 0) + px, ly = sec.y, lz = (sec.cz || 0) + pz;
        /* Matrix4 apply, inlined to avoid a Vector3 per vertex at build time */
        var wx = el[0] * lx + el[4] * ly + el[8] * lz + el[12];
        var wy = el[1] * lx + el[5] * ly + el[9] * lz + el[13];
        var wz = el[2] * lx + el[6] * ly + el[10] * lz + el[14];
        /* cheap cavity AO: creased/inner facing vertices darken */
        var f = ao;
        if (opt.aoDir) f *= 1 - opt.aoDir * clamp(-Math.cos(a) * 0.5 + 0.5, 0, 1) * 0.45;
        var cr = col[0] * f * tone, cg = col[1] * f * tone, cb = col[2] * f * tone;
        /* subsurface: occluded skin goes warm rather than just dark. This is
           what stops flesh reading as painted plastic under a single key. */
        if (opt.sss) {
          var k = (1 - f) * opt.sss;
          cr += col[0] * k * 1.9; cg += col[1] * k * 0.28; cb += col[2] * k * 0.12;
        }
        /* Thin-edge translucency. Where a membrane is thin enough to transmit
           -- a mantle hem, a tentacle tip, an ear -- long wavelengths get
           through and short ones do not, so the edge goes warm and slightly
           brighter than the body it belongs to. This is the single cue that
           separates living tissue from painted rubber, and it is per-section
           (sec.rim) because thinness is a property of the FORM, not the UV. */
        if (opt.rim && sec.rim) {
          var rk = sec.rim * opt.rim;
          cr += col[0] * rk * 2.60; cg += col[1] * rk * 0.85; cb += col[2] * rk * 0.62;
        }
        /* grime in the low noise, sun-fade in the high noise -- scale
           consistent because it is sampled in bind space, not UV space */
        if (wf) {
          var nn = vnoise3(wx * wf, wy * wf, wz * wf);
          var dirt = clamp((nn - 0.55) * 3.0, 0, 1) * opt.wear;
          var fade = clamp((0.45 - nn) * 3.0, 0, 1) * opt.wear * 0.7;
          var mul = (1 - dirt * 0.5) * (1 + fade * 0.26);
          cr *= mul; cg *= mul * (1 - dirt * 0.06); cb *= mul * (1 - dirt * 0.10);
        }
        var u = reg.u0 + (pole ? 0.5 : (i / NA)) * reg.du;
        row.push(pile.vert(wx, wy, wz, u, vv, cr, cg, cb, mask));
      }
      rows.push(row);
    }
    for (s = 0; s < S - 1; s++) {
      var A = rows[s], B = rows[s + 1];
      var pa = A.length === 1, pb = B.length === 1;
      for (i = 0; i < NA; i++) {
        var a0 = A[pa ? 0 : i], a1 = A[pa ? 0 : i + 1];
        var b0 = B[pb ? 0 : i], b1 = B[pb ? 0 : i + 1];
        if (pa) { if (up) pile.tri(a0, b0, b1); else pile.tri(a0, b1, b0); }
        else if (pb) { if (up) pile.tri(a0, b0, a1); else pile.tri(a0, a1, b0); }
        else { if (up) pile.quad(a0, b0, b1, a1); else pile.quad(a0, a1, b1, b0); }
      }
    }
    if (opt.capStart) capRing(pile, rows[0], NA, up ? -1 : 1);
    if (opt.capEnd) capRing(pile, rows[S - 1], NA, up ? 1 : -1);
    partMark(pile, opt.name, _v0);
    return rows;
  }
  /* The cap duplicates the ring so computeVertexNormals cannot average the
     flat cap into the side wall -- that averaging is what rounds off a hard
     surface and makes gear look inflated. */
  function capRing(pile, row, sides, dir) {
    if (row.length < 3) return;
    var dup = [], i, v;
    for (i = 0; i < sides; i++) {
      v = row[i];
      dup.push(pile.vert(pile.p[v * 3], pile.p[v * 3 + 1], pile.p[v * 3 + 2],
        pile.uv[v * 2], pile.uv[v * 2 + 1],
        pile.col[v * 3], pile.col[v * 3 + 1], pile.col[v * 3 + 2], pile.mask[v]));
    }
    for (i = 1; i < sides - 1; i++) {
      if (dir > 0) pile.tri(dup[0], dup[i], dup[i + 1]);
      else pile.tri(dup[0], dup[i + 1], dup[i]);
    }
  }

  /* ------------------------------------------------------------------------
     A swept tube along an EXPLICIT polyline. Each point carries its own ring
     frame (`b` and `n`, both unit and both perpendicular to the path), so the
     path may turn through any angle at all.

     addLoft cannot do this: its rings are always perpendicular to Y, so the
     moment a path bends past about 60 deg the ring goes oblique and past 90
     it inverts. A finger gripping a bar turns through 180-210 deg, which is
     precisely why round 2's fingers were four straight slabs -- the tool
     could not express a curl, so nobody wrote one.
     --------------------------------------------------------------------- */
  function addSweep(pile, M, pts, sides, reg, col, mask, opt) {
    opt = opt || {};
    WCLS = wclsOf(opt);
    if (!M || !M.elements || pts.length < 2) return [];
    var el = M.elements, rows = [], s, i, _v0 = pile.n;
    for (i = 0; i < 16; i++) if (!isFinite(el[i])) return [];
    for (s = 0; s < pts.length; s++) {
      var P = pts[s], row = [];
      var vv = reg.v0 + clamp(P.uv, 0, 1) * reg.dv;
      var ao = P.ao === undefined ? 1 : P.ao;
      var rr = P.r, rw = P.rw === undefined ? P.r : P.rw;
      if (!isFinite(rr) || !isFinite(P.p[0]) || !isFinite(P.p[1]) || !isFinite(P.p[2])) return [];
      var ex = P.e || 2;                 /* superellipse: 2 round, 4 boxy */
      for (i = 0; i <= sides; i++) {
        var a = opt.angles ? opt.angles[i % sides] : (i % sides) / sides * TAU;
        var ca = profX(a, rw, ex), sa = profZ(a, rr, ex);
        var lx = P.p[0] + P.b[0] * ca + P.n[0] * sa;
        var ly = P.p[1] + P.b[1] * ca + P.n[1] * sa;
        var lz = P.p[2] + P.b[2] * ca + P.n[2] * sa;
        var wx = el[0] * lx + el[4] * ly + el[8] * lz + el[12];
        var wy = el[1] * lx + el[5] * ly + el[9] * lz + el[13];
        var wz = el[2] * lx + el[6] * ly + el[10] * lz + el[14];
        /* Cavity AO. `aoIn` darkens the inside of a curl, which is occluded
           by whatever it grips. `aoSide` darkens the two lateral flanks --
           the b axis -- which is what writes the creases BETWEEN adjacent
           fingers: without it four touching cylinders of one tone read as a
           mitten no matter how correctly they are curled. */
        var f = ao * (1 - (opt.aoIn || 0) * clamp(Math.sin(a) * .5 + .5, 0, 1))
          * (1 - (opt.aoSide || 0) * Math.pow(Math.abs(Math.cos(a)), 1.6));
        row.push(pile.vert(wx, wy, wz, reg.u0 + (i / sides) * reg.du, vv,
          col[0] * f, col[1] * f, col[2] * f, mask));
      }
      rows.push(row);
    }
    /* (b, n, tangent) is RIGHT handed here where addLoft's (x, z, +y) is
       left handed, so the winding is the mirror of addLoft's */
    for (s = 0; s < rows.length - 1; s++)
      for (i = 0; i < sides; i++)
        pile.quad(rows[s][i], rows[s][i + 1], rows[s + 1][i + 1], rows[s + 1][i]);
    if (opt.capStart) capRing(pile, rows[0], sides, 1);
    if (opt.capEnd) capRing(pile, rows[rows.length - 1], sides, -1);
    partMark(pile, opt.name, _v0);
    return rows;
  }

  /* ------------------------------------------------------------------------
     A DIGIT WRAPPED ROUND A CYLINDER.

     Round 2 built each finger as one straight tapered tube leaning slightly
     forward, four of them splayed 40 mm apart on an 86 mm hand. That is a
     rake, and at the range the player actually fights (5-10 m) the hands are
     the most-looked-at part of the model.

     A finger is three phalanges -- middle finger 45 / 27 / 21 mm -- hinged at
     MCP, PIP and DIP. Here they are laid as CHORDS of the wrap circle: a
     chord of length L on radius R subtends 2*asin(L/2R) and points along the
     tangent at its own midpoint, so the chain hugs the cylinder BY
     CONSTRUCTION and the fingertip lands on the surface instead of pointing
     off into space. The check that says the anatomy is right: 93 mm of
     finger on a 32 mm wrap radius is 167 deg of wrap, which is exactly the
     grip a human makes on a 44 mm handguard.

     Local frame: the parent bone sits at the grip CONTACT (that is the anchor
     the arm IK solves onto), -Y is down the hand, +Z is the palm side. theta
     runs from -Y toward +Z, so P(t) = C - R*(0,sin t,cos t) and the ring
     frame is b=(1,0,0), n=(0,sin t,cos t).
     --------------------------------------------------------------------- */
  function wrapDigit(o) {
    var R = o.R, seg = o.seg, sub = o.sub || 2, k, j;
    var half = [], dirs = [], acc = o.start || 0;
    for (k = 0; k < seg.length; k++) half[k] = Math.asin(clamp(seg[k] / (2 * R), -0.985, 0.985));
    for (k = 0; k < seg.length; k++) { dirs[k] = acc + half[k]; acc += 2 * half[k]; }
    var th = o.start || 0, cy = o.cy || 0, cz = o.cz || 0;
    var p = [o.x || 0, cy - R * Math.sin(th), cz - R * Math.cos(th)];
    var total = 0; for (k = 0; k < seg.length; k++) total += seg[k];
    var pts = [], done = 0;
    var wide = o.wide === undefined ? 1.14 : o.wide;
    function put(t, ang, rr) {
      pts.push({
        p: [p[0], p[1], p[2]], b: [1, 0, 0],
        n: [0, Math.sin(ang), Math.cos(ang)],
        r: rr, rw: rr * wide, uv: t, ao: .86 - t * .06
      });
    }
    put(0, dirs[0], o.r * (o.root === undefined ? 1.0 : o.root));
    for (k = 0; k < seg.length; k++) {
      var d = seg[k] / sub, cs = Math.cos(dirs[k]), sn = Math.sin(dirs[k]);
      for (j = 1; j <= sub; j++) {
        p = [p[0] + (o.dx || 0) * d, p[1] - cs * d, p[2] + sn * d];
        done += d;
        var t = done / total;
        /* KNUCKLE ROLL. A joint is not a bump on a tube: the head of each
           phalanx is wide and the neck behind it is pinched, so a finger in
           profile is a chain of beads, not a sausage. `bul` puts the bead on
           the joint and `nck` takes the shaft in behind it -- the two
           together are what makes a curled finger read as articulated at the
           distance a player actually sees a hand. */
        var atJoint = (j === sub && k < seg.length - 1);
        var beforeJoint = (sub > 1 && j === sub - 1 && k < seg.length - 1);
        var bul = atJoint ? 1.21 : beforeJoint ? 0.92 : 1.0;
        /* distal taper: a fingertip is 62% of the width of the proximal
           shaft, and the fall is quadratic, not linear */
        put(t, dirs[k], o.r * (1.03 - 0.24 * t - 0.22 * t * t) * bul);
      }
    }
    /* A ROUNDED FINGERTIP. One extra ring so the pad rolls over instead of
       stopping at a cone: the previous single cap read as a sharpened pencil
       against a handguard at close range. */
    var e = pts[pts.length - 1], ed = dirs[seg.length - 1];
    var ce = Math.cos(ed), se = Math.sin(ed);
    var er = e.r;
    pts.push({
      p: [e.p[0], e.p[1] - ce * er * 0.42, e.p[2] + se * er * 0.42],
      b: [1, 0, 0], n: [0, se, ce],
      r: er * 0.80, rw: er * 0.80 * wide, uv: 1, ao: .80
    });
    pts.push({
      p: [e.p[0], e.p[1] - ce * er * 0.78, e.p[2] + se * er * 0.78],
      b: [1, 0, 0], n: [0, se, ce],
      r: er * 0.30, rw: er * 0.30 * wide, uv: 1, ao: .76
    });
    return pts;
  }

  /* A tapered limb profile: length L along -Y with a muscle bulge. */
  function limbSections(L, r0, r1, bulge, bulgeAt, rings, flat) {
    var out = [], i;
    for (i = 0; i <= rings; i++) {
      var t = i / rings;
      var r = lerp(r0, r1, t);
      var b = 1 + bulge * Math.exp(-Math.pow((t - bulgeAt) * 3.1, 2));
      out.push({
        y: -L * t, cx: 0, cz: 0, rx: r * b, rz: r * b * (flat || 1), n: 2, uv: t,
        ao: 1 - 0.10 * Math.exp(-Math.pow(t * 5, 2))
      });
    }
    return out;
  }

  /* A chamfered box: flat faces, a real (small) radius on every edge, and the
     corner-clustered angle set so the radius survives at low tessellation. */
  function boxSections(w, h, d, cham) {
    var c = cham === undefined ? 0.16 : cham;   /* fraction of the half-extent */
    var kx = 1 - c, kz = 1 - c;
    var ey = h * 0.5 * c;
    return [
      { y: -h * 0.5, rx: w * kx, rz: d * kz, n: 4.2, uv: 0.02 },
      { y: -h * 0.5 + ey, rx: w, rz: d, n: 4.2, uv: 0.10 },
      { y: h * 0.5 - ey, rx: w, rz: d, n: 4.2, uv: 0.90 },
      { y: h * 0.5, rx: w * kx, rz: d * kz, n: 4.2, uv: 0.98 }
    ];
  }
  /* Convenience: chamfered box placed by xf(), one call per gear item. */
  function addBox(pile, M, w, h, d, sidesQ, reg, col, mask, opt) {
    opt = opt || {};
    var o = {
      angles: chamferAngles(sidesQ, opt.bias || 1.75, opt.rot || 0),
      capStart: true, capEnd: true,
      aoDir: opt.aoDir, wear: opt.wear, wearFreq: opt.wearFreq, tone: opt.tone,
      name: opt.name
    };
    return addLoft(pile, M, boxSections(w, h, d, opt.cham), 4, reg, col, mask, o);
  }

  /* =========================================================================
     2. PROCEDURAL PBR ATLAS
     1024x1024, sixteen 256px tiles. Hue comes from vertex colour, so a single
     atlas serves skin, boar hide, reptile scale, brain tissue, ripstop cloth,
     cordura webbing, leather, rib knit, hard polymer, rubber, gunmetal,
     painted plate, trim and an emissive lens.

     Beyond albedo/normal/ORM we bake a SHEEN colour map and a CLEARCOAT
     (R=amount, G=roughness) map. r149 multiplies material.sheenColor by
     sheenColorMap and material.clearcoat by clearcoatMap.r, so those two
     small textures give every region its own specular character -- fabric
     with a retroreflective rim, hard plastic with a second lacquer lobe,
     skin with neither -- out of ONE MeshPhysicalMaterial and one draw call.
     ====================================================================== */
  var ATLAS = null;
  var REG = {};
  var AW = 1024, AH = 1024, TW = 256, TCOLS = 4;
  /* [min, max, sum, count] of the baked ORM red channel. An AO map whose whole
     range is 0.97..1.0 is bound, sampled, mip-mapped -- and does nothing. This
     is measured rather than assumed so the install log can say so out loud. */
  var ORM_AO = [1, 0, 0, 0];

  function region(px, py, pw, ph) {
    /* 4px inset: enough that neither anisotropic taps nor the first three mip
       levels can pull a neighbouring material's texels across a tile border */
    var ix = 4.0;
    return {
      u0: (px + ix) / AW, du: (pw - ix * 2) / AW,
      v0: 1 - (py + ph - ix) / AH, dv: (ph - ix * 2) / AH
    };
  }
  /* a sub-rectangle of a region, used to keep micro-detail texel density
     roughly constant between a boot and a torso */
  function subReg(r, ox, oy, sx, sy) {
    return { u0: r.u0 + r.du * ox, du: r.du * sx, v0: r.v0 + r.dv * oy, dv: r.dv * sy };
  }

  /* separable wrapped box blur, used for the cavity AO channel */
  function blurWrap(src, res, R) {
    var tmp = new Float32Array(res * res), out = new Float32Array(res * res);
    var inv = 1 / (2 * R + 1), x, y, o, sum;
    for (y = 0; y < res; y++) {
      sum = 0;
      for (o = -R; o <= R; o++) sum += src[y * res + ((o % res) + res) % res];
      for (x = 0; x < res; x++) {
        tmp[y * res + x] = sum * inv;
        sum -= src[y * res + ((x - R) % res + res) % res];
        sum += src[y * res + ((x + R + 1) % res + res) % res];
      }
    }
    for (x = 0; x < res; x++) {
      sum = 0;
      for (o = -R; o <= R; o++) sum += tmp[(((o % res) + res) % res) * res + x];
      for (y = 0; y < res; y++) {
        out[y * res + x] = sum * inv;
        sum -= tmp[(((y - R) % res + res) % res) * res + x];
        sum += tmp[(((y + R + 1) % res + res) % res) * res + x];
      }
    }
    return out;
  }

  /* per-tile surface response. sheen is an RGB (black = no sheen); cc is
     [amount, roughness]; rough is [base, variance]. */
  /* ---------------------------------------------------------------------
     TEXEL DENSITY -- the number every feature below is derived from.

     addLoft maps exactly ONE atlas region across a whole part: u wraps the
     circumference, v runs the length. So a 256 px tile covers a patch of
     surface roughly 500 mm on a side (thigh 430 mm long / 550 mm round,
     torso panel 520 mm, boot upper 260 mm). Density is therefore about
     **1.95 mm per texel**, and every feature is written as a real
     millimetre figure through px().

     The consequence that had to be faced: a fabric weave is 0.8-1.5 mm --
     HALF A TEXEL. It cannot be drawn in this normal map at all. Trying to
     draw it is what produced the corduroy: a "12 px weave" is a 23 mm rib,
     which is rope, not cloth. All sub-4 mm structure now lives ONLY in the
     roughness micro-field, where it costs nothing and reads correctly.
     The normal map carries the 15-200 mm structure a human eye actually
     resolves on a person at 5-10 m: folds, felled seams, webbing rows,
     tread lugs, panel breaks.

     `tilt` is the target MEAN normal deviation in degrees. bakeAtlas
     solves the per-tile height gain that achieves it (see normalGain),
     so amplitude is measured, never guessed, and the ridging cannot come
     back by someone tweaking a magic number.
     ------------------------------------------------------------------ */
  var TILE_MM = 500;                                /* surface span of a tile */
  function pxOf(mm) { return mm * TW / TILE_MM; }   /* millimetres -> texels  */

  function tileSpecs() {
    var T = NZ.tex, px = pxOf;
    return [
      /* 0 skin ------------------------------------------------------------ */
      {
        name: 'skin', base: '#b9b2ac', grain: .10, tilt: 4.5,
        rough: [.49, .17], metal: 0, sheen: [0, 0, 0], cc: [.10, .30], ao: .70,
        /* normal: only what an eye resolves -- the 100 mm swell of muscle
           and the 15-40 mm creases at a knuckle, an eye corner, a wrist */
        height: function (r) {
          var form = T.fbm(r, { octaves: 3, frequency: 4, seed: 9 });                    /* 125 mm */
          var crease = T.fbm(r, { octaves: 3, frequency: 13, seed: 5, ridged: true });   /*  38 mm */
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++)
            o[i] = clamp(0.5 + (form[i] - .5) * .70 - crease[i] * .20, 0, 1);
          return o;
        },
        /* pores are 0.4 mm -- a fifth of a texel. Roughness breakup only. */
        micro: function (r) {
          var pore = T.worley(r, { cells: 52, seed: 3, invert: true });
          var fine = T.fbm(r, { octaves: 3, frequency: 30, seed: 5 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++)
            o[i] = clamp(.5 + (pore[i] - .5) * .60 + (fine[i] - .5) * .45, 0, 1);
          return o;
        },
        paint: function (g, r, h) {
          /* capillary blotch: red in, yellow-green out -- the single cheapest
             thing that stops skin reading as painted rubber */
          var b = h.fbm(r, { octaves: 3, frequency: 5, seed: 21 });
          var b2 = h.fbm(r, { octaves: 4, frequency: 11, seed: 27 });
          var id = g.getImageData(0, 0, r, r), d = id.data, i, j, m, m2;
          for (i = 0; i < b.length; i++) {
            m = (b[i] - .5) * 44; m2 = (b2[i] - .5) * 16; j = i * 4;
            d[j] = clamp(d[j] + m * 1.20 + m2 * .9, 0, 255);
            d[j + 1] = clamp(d[j + 1] + m * .74 + m2 * 1.0, 0, 255);
            d[j + 2] = clamp(d[j + 2] + m * .58 + m2 * .55, 0, 255);
          }
          g.putImageData(id, 0, 0);
        }
      },
      /* 1 ripstop uniform cloth ------------------------------------------- */
      {
        /* A 2px weave period is ~0.1 screen pixels on a thigh at 8m: it does
           not read as fabric, it beats against the pixel grid and produces the
           moiré cross-hatch that was crawling over the legs. Everything here
           is now built at a period the mip chain can actually resolve --
           12px weave, 40px ripstop, 64px panel seams -- and the readable
           information is moved into LOW frequency: seam lines, panel value
           steps and sun-bleach blotches, which is what tells you "worn cotton"
           at distance. */
        name: 'cloth', base: '#aeaba6', grain: .07, tilt: 5.0,
        rough: [.94, .07], metal: 0, sheen: [.24, .23, .21], cc: [0, .5], ao: .78,
        /* What you actually see on fatigues at 5 m is FOLDS, not thread:
           soft 60-160 mm wrinkle fields, plus the two felled seams that
           run the length of a trouser leg (6 mm proud, 250 mm apart). */
        height: function (r) {
          var fold = T.fbm(r, { octaves: 3, frequency: 3.2, seed: 73 });                  /* 156 mm */
          var wrin = T.fbm(r, { octaves: 3, frequency: 7.5, seed: 77, ridged: true });    /*  67 mm */
          var seamW = px(6), seamP = px(250), stW = px(2.5);
          var o = new Float32Array(r * r), x, y, i;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            /* felled seam: a low ridge with a stitch groove down each side */
            var sx = Math.abs(((x % seamP) - seamP * .5)), sy = Math.abs(((y % seamP) - seamP * .5));
            var sd = Math.min(sx, sy);
            var seam = sd < seamW ? (1 - sd / seamW) : 0;
            var stitch = (Math.abs(sd - seamW * .75) < stW) ? 1 : 0;
            o[i] = clamp(0.50 + (fold[i] - .5) * .62 - wrin[i] * .30
              + seam * .16 - stitch * .10, 0, 1);
          }
          return o;
        },
        /* 1.1 mm ripstop grid + twill: half a texel, so roughness only --
           it survives as a faint anisotropic breakup and never as a ridge */
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 26, seed: 79 });
          var o = new Float32Array(r * r), x, y, i;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var weave = Math.sin((x + y) * PI / 1.5) * .5 + .5;         /* ~3 mm twill */
            var rip = ((x % px(12) | 0) < 1 || (y % px(12) | 0) < 1) ? 1 : 0;
            o[i] = clamp(.5 + (f[i] - .5) * .55 + (weave - .5) * .22 - rip * .16, 0, 1);
          }
          return o;
        },
        paint: function (g, r, h) {
          /* Low-frequency value structure. This is the part that survives to
             mip 4 and is therefore the only part a critic at 8m can see. */
          var dirt = h.fbm(r, { octaves: 4, frequency: 6, seed: 79 });
          var broad = h.fbm(r, { octaves: 2, frequency: 2.4, seed: 83 });
          var id = g.getImageData(0, 0, r, r), d = id.data, x, y, i, j, m, b, sx, sy;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x; j = i * 4;
            /* sun bleach on one side of the blotch, grime in the other */
            b = (broad[i] - .5) * 2;
            m = clamp((dirt[i] - .46) * 2.6, 0, 1) * .55;
            d[j] = clamp(lerp(d[j], 62, m) + b * 22, 0, 255);
            d[j + 1] = clamp(lerp(d[j + 1], 55, m) + b * 21, 0, 255);
            d[j + 2] = clamp(lerp(d[j + 2], 46, m) + b * 17, 0, 255);
            /* darken the seam trough so the panel break reads as a line even
               when the normal map has been mipped away */
            /* the felled seam, in value, on the SAME 250 mm period as the
               height field -- a trouser leg has an inseam and an outseam */
            var sp = pxOf(250), sw = pxOf(5);
            sx = Math.abs(((x % sp) - sp * .5)); sy = Math.abs(((y % sp) - sp * .5));
            if (sx < sw || sy < sw) {
              var k = 1 - Math.min(sx, sy) / sw;
              d[j] *= 1 - k * .26; d[j + 1] *= 1 - k * .26; d[j + 2] *= 1 - k * .24;
            }
          }
          g.putImageData(id, 0, 0);
          /* stitch row beside each seam: 2 tone-steps brighter, never white */
          g.strokeStyle = 'rgba(196,190,178,.30)'; g.lineWidth = 1.3;
          g.setLineDash([pxOf(4), pxOf(5)]);
          var sp2 = pxOf(250), off = sp2 * .5 - pxOf(9);
          for (var k2 = 0; k2 < 3; k2++) {
            var q = off + k2 * sp2;
            g.beginPath(); g.moveTo(0, q); g.lineTo(r, q); g.stroke();
            g.beginPath(); g.moveTo(q, 0); g.lineTo(q, r); g.stroke();
          }
          g.setLineDash([]);
        }
      },
      /* 2 cordura nylon (vest, pouches, straps) --------------------------- */
      {
        /* Sheen was .50 white over what is now a 0.020-albedo black vest: a
           half-strength white retroreflective lobe on a near-black base is a
           grey wash that erases exactly the darkness we just bought. Cordura
           does have a sheen, but it is dim and it takes the colour of the
           cloth, not of the light. */
        /* tilt was 7.0 deg -- the steepest fabric on the operator, and a mean
           of 7 with 60% of the tile flat means the strap EDGES were carrying
           twenty-plus degrees each. That is what "PALS reads as corrugation
           at close range" is: the pitch was always right, the edge was a
           cliff. 4.6 deg mean, with the chamfer twice as wide (below), keeps
           the four rows of shadow and loses the ribbing. */
        name: 'nylon', base: '#a8a5a1', grain: .10, tilt: 4.6,
        rough: [.80, .13], metal: 0, sheen: [.22, .21, .19], cc: [.06, .55], ao: .92,
        /* MIL-STD PALS, to the actual spec: 25 mm webbing rows on a 38 mm
           pitch, bar-tacked to the base cloth every 38 mm. The strap stands
           ~1.5 mm proud with a real shadow gap under its lower edge. This
           is the most recognisable shape on a plate carrier and it is the
           only thing here big enough to survive the mip chain. */
        height: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 5, seed: 131 });      /* cordura sag */
          var pitch = px(38), band = px(25), tackP = px(38), tackW = px(4);
          var o = new Float32Array(r * r), x, y, i;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var row = y % pitch;
            var strap = row < band ? 1 : 0;
            /* soften the two texels at each strap edge so it is a chamfer,
               not a cliff -- a cliff in a height field is a gouge in a normal */
            var e = Math.min(row, band - row);
            var lift = strap ? sstep(e / px(6.5)) : 0;
            var tack = (strap && (x % tackP) < tackW) ? 1 : 0;
            o[i] = clamp(0.42 + lift * .24 - tack * .12 + (f[i] - .5) * .26, 0, 1);
          }
          return o;
        },
        /* 1000D basket weave is a 1.2 mm bundle: roughness only */
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 24, seed: 133 });
          var o = new Float32Array(r * r), x, y, i;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var bx = Math.sin(x * PI / px(2.4)), by = Math.sin(y * PI / px(2.4));
            var basket = (((y / px(2.4) | 0) % 2) ? bx : by) * .5 + .5;
            o[i] = clamp(.5 + (basket - .5) * .34 + (f[i] - .5) * .55, 0, 1);
          }
          return o;
        },
        paint: function (g, r, h) {
          var broad = h.fbm(r, { octaves: 2, frequency: 3, seed: 137 });
          var id = g.getImageData(0, 0, r, r), d = id.data, x, y, i, j, b;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x; j = i * 4;
            b = (broad[i] - .5) * 2;
            /* the shadow under each PALS strap -- 38 mm pitch, matching the
               height field. This is what makes a flat vest read as layered. */
            var pitch = pxOf(38), band = pxOf(25);
            var row = y % pitch;
            var edge = (row >= band && row < band + pxOf(3)) ? 1 : 0;
            var mul = (1 + b * .13) * (1 - edge * .40);
            d[j] *= mul; d[j + 1] *= mul; d[j + 2] *= mul;
          }
          g.putImageData(id, 0, 0);
          /* bar-tack stitch rows: the read that says "sewn gear" */
          g.strokeStyle = 'rgba(186,180,168,.28)'; g.lineWidth = 1.2;
          g.setLineDash([pxOf(3), pxOf(5)]);
          var pp = pxOf(38);
          for (var k = 0; k * pp < r; k++) {
            g.beginPath(); g.moveTo(0, pxOf(2) + k * pp); g.lineTo(r, pxOf(2) + k * pp); g.stroke();
          }
          g.setLineDash([]);
        }
      },
      /* 3 leather (boot upper, glove palm, sling) ------------------------- */
      {
        /* Roughness is the whole identity here. Leather is the only soft
           material on the operator with a real specular lobe, and worn
           leather is POLISHED ON THE HIGH POINTS -- a fingertip, a knuckle,
           the toe of a boot -- so the variance is wide and signed off the
           height. That gloss gradient is what stops a glove reading as
           painted cloth. */
        name: 'leather', base: '#a49c94', grain: .11, tilt: 6.0,
        rough: [.54, .28], rSign: -1, metal: 0, sheen: [.14, .13, .12], cc: [.20, .48], ao: .70,
        height: function (r) {
          /* 25-60 mm break lines where the hide creases over a knuckle */
          var crease = T.worley(r, { cells: 8, seed: 217, invert: true });
          var soft = T.fbm(r, { octaves: 3, frequency: 5.5, seed: 223 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++)
            o[i] = clamp(0.5 + Math.pow(crease[i], 1.6) * .40 + (soft[i] - .5) * .44, 0, 1);
          return o;
        },
        /* pebble grain is 1.5-3 mm: roughness only */
        micro: function (r) {
          var cell = T.worley(r, { cells: 84, seed: 211, invert: true });
          var f = T.fbm(r, { octaves: 3, frequency: 28, seed: 227 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++)
            o[i] = clamp(.5 + (cell[i] - .5) * .70 + (f[i] - .5) * .38, 0, 1);
          return o;
        }
      },
      /* 4 hard polymer (helmet, kneepad, mag body) ------------------------ */
      {
        /* THE WHITE BLOB HEAD. clearcoat .62 at clearcoatRoughness .16 is a
           lacquered showroom finish: a 0.62-weight mirror lobe sat on top of a
           dome and blew the whole helmet to white under the key, which is why
           the head read as a featureless pale ball at 8m while the body stayed
           dark. A combat helmet is a textured, dead-matte shell -- a little
           coat, very rough, and the flake/scuff has to be DARKER than the
           shell (exposed composite), never brighter. */
        /* A moulded shell is SMOOTH. Its normal map should be almost flat --
           3 deg mean -- and its identity comes from a tighter roughness
           than any fabric on the model plus a single crisp parting line. */
        name: 'plastic', base: '#b0b3b6', grain: .05, tilt: 3.0,
        rough: [.44, .19], metal: 0, sheen: [.05, .05, .05], cc: [.16, .60], ao: .70,
        height: function (r) {
          var peel = T.fbm(r, { octaves: 3, frequency: 9, seed: 257 });   /* 55 mm swell */
          var o = new Float32Array(r * r), x, y, i;
          var partP = px(210), partW = px(2.0);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            /* injection parting line: 1 mm proud, one per shell half */
            var pd = Math.abs((y % partP) - partP * .5);
            var part = pd < partW ? (1 - pd / partW) : 0;
            o[i] = clamp(0.5 + (peel[i] - .5) * .50 + part * .30, 0, 1);
          }
          return o;
        },
        /* composite weave print + orange peel, both under 2 mm */
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 34, seed: 251 });
          var w = T.worley(r, { cells: 40, seed: 259, invert: true });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++)
            o[i] = clamp(.5 + (f[i] - .5) * .45 + (w[i] - .5) * .40, 0, 1);
          return o;
        },
        paint: function (g, r, h) {
          /* chips where a helmet actually gets hit: the paint comes OFF and
             the dark shell shows through */
          var w = h.worley(r, { cells: 7, seed: 263, invert: true });
          var broad = h.fbm(r, { octaves: 2, frequency: 3, seed: 269 });
          var id = g.getImageData(0, 0, r, r), d = id.data, i, j, m;
          for (i = 0; i < w.length; i++) {
            j = i * 4;
            var b = 1 + (broad[i] - .5) * .22;
            d[j] *= b; d[j + 1] *= b; d[j + 2] *= b;
            m = clamp((w[i] - .76) * 5.4, 0, 1) * .70; if (m <= 0) continue;
            d[j] = lerp(d[j], 44, m); d[j + 1] = lerp(d[j + 1], 43, m); d[j + 2] = lerp(d[j + 2], 40, m);
          }
          g.putImageData(id, 0, 0);
        }
      },
      /* 5 rubber (boot sole, grips) --------------------------------------- */
      {
        /* The one material on the operator that is genuinely deep: a Vibram
           lug is 5 mm proud with a 5 mm gap, and at 2 mm/texel that is
           legible relief, so this tile gets four times the tilt of cloth.
           Very rough, no clearcoat, near-black in albedo. */
        name: 'rubber', base: '#8e9093', grain: .05, tilt: 13.0,
        rough: [.96, .04], metal: 0, sheen: [.06, .06, .06], cc: [0, .5], ao: .85,
        height: function (r) {
          var f = T.fbm(r, { octaves: 2, frequency: 14, seed: 307 });
          var o = new Float32Array(r * r), x, y, i;
          var lugP = px(24), gap = px(5), sipe = px(2.2);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            /* staggered lug blocks, 19 mm square on a 24 mm pitch */
            var ox = (((y / lugP) | 0) % 2) * lugP * .5;
            var dx = Math.abs(((x + ox) % lugP) - lugP * .5);
            var dy = Math.abs((y % lugP) - lugP * .5);
            var edge = Math.min(lugP * .5 - dx, lugP * .5 - dy);
            var lug = clamp((edge - gap * .5) / px(2), 0, 1);
            /* siping: a 2 mm slit across each block */
            var sp = Math.abs(((y + ox) % (lugP * .5)) - lugP * .25) < sipe ? 1 : 0;
            o[i] = clamp(0.22 + lug * .62 - lug * sp * .16 + (f[i] - .5) * .10, 0, 1);
          }
          return o;
        },
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 30, seed: 311 });
          return f;
        }
      },
      /* 6 gunmetal -------------------------------------------------------- */
      {
        name: 'steel', base: '#9aa0a6', grain: .07, tilt: 3.0,
        rough: [.26, .26], rSign: -1, metal: .88, sheen: [0, 0, 0], cc: [0, .5], ao: .45,
        height: function (r) {
          /* machined stock: broad form only, plus 6 mm cooling/grip grooves */
          var f = T.fbm(r, { octaves: 2, frequency: 6, seed: 103 });
          var o = new Float32Array(r * r), x, y, i, gp = px(9);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var groove = Math.sin(y * TAU / gp) * .5 + .5;
            o[i] = clamp(0.5 + groove * .22 + (f[i] - .5) * .50, 0, 1);
          }
          return o;
        },
        /* knurling is 0.8 mm pitch: roughness anisotropy, nothing else */
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 30, seed: 107 });
          var o = new Float32Array(r * r), x, y, i, kp = px(1.6);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var knurl = (Math.sin((x + y) * PI / kp) * Math.sin((x - y) * PI / kp)) * .5 + .5;
            o[i] = clamp(.5 + (knurl - .5) * .30 + (f[i] - .5) * .70, 0, 1);
          }
          return o;
        }
      },
      /* 7 painted plate (creature armour) --------------------------------- */
      {
        name: 'painted', base: '#b6bcc2', grain: .09, tilt: 3.5,
        rough: [.48, .30], rSign: -1, metal: .40, sheen: [0, 0, 0], cc: [.22, .34], ao: .60,
        wear: { amount: .55, cells: 13, colour: '#8e949c' },
        height: function (r) {
          /* dents and chipped paint edges at 30-80 mm; the scratches are
             0.5 mm wide and belong to roughness, not to relief */
          var w = T.worley(r, { cells: 9, seed: 89, invert: true });
          var f = T.fbm(r, { octaves: 3, frequency: 6, seed: 91 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++)
            o[i] = clamp(0.5 + (w[i] - .5) * .34 + (f[i] - .5) * .46, 0, 1);
          return o;
        },
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 24, seed: 93 });
          var o = new Float32Array(r * r), x, y, i;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var scratch = Math.abs(Math.sin((x * .55 + y * .21) + f[i] * 5.0));
            o[i] = clamp(.5 + (f[i] - .5) * .6 - Math.pow(scratch, 18) * .55, 0, 1);
          }
          return o;
        }
      },
      /* 8 gunmetal --------------------------------------------------------
         Parkerised steel. The brief is explicit that gunmetal is not a flat
         grey, and the three things that make it read are all here:

           - BEAD BLAST. Phosphate finish sits on a blasted surface, so the
             base is a dense fine worley speckle, not smooth. That speckle is
             what scatters the key into a soft sheen instead of a mirror.
           - MACHINING LINES. A receiver is milled or stamped: faint parallel
             tool marks run along it at a shallow angle, and they catch the
             light anisotropically. One directional term in the height field
             does the whole job.
           - CARBON AND WEAR. Fouling collects as dark blotches (the albedo
             pass), and the high points polish through to bright bare steel --
             which is why roughness has a WIDE variance here (.34): a uniform
             roughness is the single loudest "untextured metal" tell.        */
      {
        name: 'gunmetal', base: '#8f9296', grain: .07, tilt: 2.2,
        /* THE WIDEST ROUGHNESS SPREAD ON THE MODEL. Base 0.38 with a 0.34
           swing puts the polished high points at 0.16 (bare steel through
           the phosphate, where a hand or a sling has rubbed) and the sooted
           hollows at 0.60. A gun that is one roughness is the loudest
           "untextured metal" tell there is. */
        rough: [.38, .34], rSign: -1, metal: .88, sheen: [0, 0, 0], cc: [.10, .55], ao: .55,
        height: function (r) {
          /* a receiver is FLAT. 2.2 deg mean: the identity is in roughness
             and in the fouling in the albedo, not in bumps. */
          var slow = T.fbm(r, { octaves: 2, frequency: 5, seed: 37 });
          var o = new Float32Array(r * r), x, y, i, tp = px(7);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            /* shallow-angle stamping/tool marks, spacing jittered so they
               never read as a printed screen */
            var tool = Math.sin((x * 0.94 + y * 0.16) * TAU / tp + slow[i] * 5.0) * .5 + .5;
            o[i] = clamp(0.50 + (slow[i] - .5) * .84 + (tool - .5) * .11, 0, 1);
          }
          return o;
        },
        /* bead blast is a 0.3 mm crater field -- pure roughness scatter */
        micro: function (r) {
          var blast = T.worley(r, { cells: 96, seed: 31, invert: true });
          var fine = T.fbm(r, { octaves: 3, frequency: 40, seed: 33 });
          var wide = T.fbm(r, { octaves: 3, frequency: 7, seed: 41 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++)
            o[i] = clamp(.5 + (blast[i] - .5) * .42 + (fine[i] - .5) * .30
              + (wide[i] - .5) * .80, 0, 1);
          return o;
        },
        paint: function (g, r, h) {
          /* carbon fouling: soft dark blotches, plus a few bright polished
             streaks where a hand or a sling has rubbed the finish back */
          var soot = h.fbm(r, { octaves: 4, frequency: 7, seed: 41 });
          var rub = h.fbm(r, { octaves: 2, frequency: 3, seed: 45 });
          var id = g.getImageData(0, 0, r, r), d = id.data, i, j, m, b;
          for (i = 0; i < r * r; i++) {
            j = i * 4;
            m = clamp((soot[i] - 0.56) * 3.4, 0, 1) * 0.62;      /* fouling  */
            b = clamp((rub[i] - 0.66) * 4.0, 0, 1) * 0.55;       /* polished */
            var mul = (1 - m * 0.72) * (1 + b * 0.42);
            d[j] = clamp(d[j] * mul, 0, 255);
            d[j + 1] = clamp(d[j + 1] * mul * (1 - m * 0.04), 0, 255);
            d[j + 2] = clamp(d[j + 2] * mul * (1 - m * 0.06), 0, 255);
          }
          g.putImageData(id, 0, 0);
        }
      },
      /* 9 CAMOUFLAGE ------------------------------------------------------
         The reptile-scale tile is retired with the reptile. In its place:
         a four-tone disruptive pattern on the same ripstop substrate as the
         uniform cloth, at a COARSER blob scale so the big panels (boonie,
         hood, overshirt) do not print the same shapes as the trousers.

         Two things keep this CS2 and not paintball. First the palette is
         desaturated and the total range is only 1.75:1 -- real camo is a
         value pattern, and it is the vertex tint underneath that sets how
         dark the garment is, so a high-contrast tile would fight it. Second
         the blob EDGES are hard (the transitions are steepened, not
         smoothstepped): soft-edged camo reads as a stain, hard-edged camo
         reads as printed cloth, and the difference survives to mip 4. */
      {
        name: 'camo', base: '#aeaba6', grain: .07, tilt: 5.0,
        rough: [.93, .07], metal: 0, sheen: [.22, .21, .19], cc: [0, .5], ao: .78,
        /* same substrate as tile 1, different seed: folds and felled seams */
        height: function (r) {
          var fold = T.fbm(r, { octaves: 3, frequency: 3.0, seed: 421 });
          var wrin = T.fbm(r, { octaves: 3, frequency: 8.0, seed: 425, ridged: true });
          var seamW = px(6), seamP = px(305), stW = px(2.5);
          var o = new Float32Array(r * r), x, y, i;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var sx = Math.abs(((x % seamP) - seamP * .5)), sy = Math.abs(((y % seamP) - seamP * .5));
            var sd = Math.min(sx, sy);
            var seam = sd < seamW ? (1 - sd / seamW) : 0;
            var stitch = (Math.abs(sd - seamW * .75) < stW) ? 1 : 0;
            o[i] = clamp(0.50 + (fold[i] - .5) * .60 - wrin[i] * .30
              + seam * .16 - stitch * .10, 0, 1);
          }
          return o;
        },
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 26, seed: 427 });
          var o = new Float32Array(r * r), x, y, i;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var weave = Math.sin((x - y) * PI / 1.5) * .5 + .5;
            o[i] = clamp(.5 + (f[i] - .5) * .55 + (weave - .5) * .22, 0, 1);
          }
          return o;
        },
        paint: function (g, r, h) {
          var a = h.fbm(r, { octaves: 4, frequency: 2.6, seed: 401 });
          var b = h.fbm(r, { octaves: 4, frequency: 4.4, seed: 409 });
          var c = h.fbm(r, { octaves: 3, frequency: 7.2, seed: 419 });
          var dirt = h.fbm(r, { octaves: 4, frequency: 6, seed: 431 });
          /* sand ground, then olive, brown and near-black patches over it */
          var TN = [[221, 213, 191], [186, 190, 162], [162, 147, 127], [127, 125, 116]];
          var id = g.getImageData(0, 0, r, r), d = id.data, i, j, k, m, cr, cg, cb;
          for (i = 0; i < a.length; i++) {
            j = i * 4;
            cr = TN[0][0]; cg = TN[0][1]; cb = TN[0][2];
            /* hard-edged overlays. 16x the difference is a two-texel edge at
               256 -- printed, not airbrushed. */
            for (k = 1; k < 4; k++) {
              var src = k === 1 ? a[i] : k === 2 ? b[i] : c[i];
              var thr = k === 1 ? 0.500 : k === 2 ? 0.555 : 0.585;
              m = clamp((src - thr) * 16, 0, 1);
              cr = lerp(cr, TN[k][0], m); cg = lerp(cg, TN[k][1], m); cb = lerp(cb, TN[k][2], m);
            }
            /* field grime on top of the print, never under it */
            m = clamp((dirt[i] - .50) * 2.4, 0, 1) * .42;
            d[j] = clamp(lerp(cr, 74, m), 0, 255);
            d[j + 1] = clamp(lerp(cg, 68, m), 0, 255);
            d[j + 2] = clamp(lerp(cb, 58, m), 0, 255);
          }
          /* the felled seam trough, dark enough to survive to mip 4 -- this
             is the only part of the panel break a critic can see at 8 m */
          var x2, y2, i2, j2, sx, sy, sp = pxOf(305), sw = pxOf(5);
          for (y2 = 0; y2 < r; y2++) for (x2 = 0; x2 < r; x2++) {
            i2 = y2 * r + x2; j2 = i2 * 4;
            sx = Math.abs(((x2 % sp) - sp * .5)); sy = Math.abs(((y2 % sp) - sp * .5));
            if (sx < sw || sy < sw) {
              var kk = 1 - Math.min(sx, sy) / sw;
              d[j2] *= 1 - kk * .26; d[j2 + 1] *= 1 - kk * .26; d[j2 + 2] *= 1 - kk * .24;
            }
          }
          g.putImageData(id, 0, 0);
          /* stitch rows beside the seams, two tone-steps up and never white */
          g.strokeStyle = 'rgba(202,196,180,.28)'; g.lineWidth = 1.3;
          g.setLineDash([pxOf(4), pxOf(6)]);
          for (var q = 0; q < 3; q++) {
            var qq = sp * .5 - pxOf(9) + q * sp;
            g.beginPath(); g.moveTo(0, qq); g.lineTo(r, qq); g.stroke();
            g.beginPath(); g.moveTo(qq, 0); g.lineTo(qq, r); g.stroke();
          }
          g.setLineDash([]);
        }
      },
      /* 10 SCRIM / SHEMAGH -------------------------------------------------
         The brain-tissue tile goes with the alien it belonged to. In its
         place: the open, chequered cotton of a shemagh, which the RIFLEMAN
         wears over his face and the MARKSMAN shreds into scrim tags.

         The whole point of this cloth is that it is COARSE. The thread
         pitch is deliberately big enough to survive a mip or two (a 5 px
         weave is invisible from three metres and only makes moire), the
         classic check is two superimposed grids at 16 px and 64 px, and
         the fringe is a value break at the tile edge rather than geometry.  */
      {
        name: 'scrim', base: '#b2ada4', grain: .10, tilt: 4.6,
        rough: [.96, .05], metal: 0, sheen: [.26, .25, .22], cc: [0, .5], ao: .80,
        /* the recognisable thing about a shemagh is the CHECK, whose bands
           are 30 mm and 120 mm -- both legible. The 1 mm plain weave is not,
           and drawing it is what made this tile a cheese grater. */
        height: function (r) {
          var drape = T.fbm(r, { octaves: 3, frequency: 4.5, seed: 611 });
          var o = new Float32Array(r * r), x, y, i;
          var b1 = px(30), b2 = px(120), w1 = px(6), w2 = px(12);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var s1 = ((x % b1) < w1 ? 1 : 0) + ((y % b1) < w1 ? 1 : 0);
            var s2 = ((x % b2) < w2 ? 1 : 0) + ((y % b2) < w2 ? 1 : 0);
            o[i] = clamp(0.46 + (drape[i] - .5) * .52 + s1 * .07 + s2 * .11, 0, 1);
          }
          return o;
        },
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 28, seed: 613 });
          var o = new Float32Array(r * r), x, y, i, tp = px(2.2);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var over = (((x / tp) | 0) + ((y / tp) | 0)) % 2;
            o[i] = clamp(.5 + (over - .5) * .26 + (f[i] - .5) * .62, 0, 1);
          }
          return o;
        },
        paint: function (g, r, h) {
          var blot = h.fbm(r, { octaves: 4, frequency: 4.0, seed: 617 });
          var dust = h.fbm(r, { octaves: 3, frequency: 9.0, seed: 619 });
          var id = g.getImageData(0, 0, r, r), d = id.data, x, y, i, j, m;
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x; j = i * 4;
            /* the check, in VALUE: a light bone ground with darker grid lines
               at two scales. Desaturated -- a shemagh in the field is dust
               colour, not a souvenir. */
            var b16 = ((x % pxOf(30)) < pxOf(6) || (y % pxOf(30)) < pxOf(6)) ? 1 : 0;
            var b64 = ((x % pxOf(120)) < pxOf(12) || (y % pxOf(120)) < pxOf(12)) ? 1 : 0;
            var v = 214 - b16 * 34 - b64 * 52;
            /* sweat and dust: a broad stain field, warmer where it is dirty */
            m = clamp((blot[i] - .46) * 2.2, 0, 1) * .50;
            var n = (dust[i] - .5) * 16;
            d[j] = clamp(v + n - m * 66, 0, 255);
            d[j + 1] = clamp(v * .985 + n - m * 74, 0, 255);
            d[j + 2] = clamp(v * .935 + n - m * 82, 0, 255);
          }
          g.putImageData(id, 0, 0);
        }
      },
      /* 11 rib knit (balaclava, gaiter, glove back) ----------------------- */
      {
        /* .62 white sheen on a 0.012-albedo balaclava is a grey halo, not a
           fibre rim. Halved, and tinted so it takes the colour of the yarn.
           Loop pitch doubled for the same anti-moiré reason as the cloth. */
        name: 'knit', base: '#a6a3a0', grain: .08, tilt: 4.8,
        rough: [.97, .03], metal: 0, sheen: [.30, .29, .27], cc: [0, .5], ao: .95,
        /* a 2x2 rib on a balaclava is a 7 mm column -- just legible at
           3.5 texels, so it stays, softened. The 3 mm purl loop does not. */
        height: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 6, seed: 401 });
          var o = new Float32Array(r * r), x, y, i, rp = px(7);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var rib = Math.cos(x * TAU / rp) * .5 + .5;
            /* the rib was .26 of the whole height range on a 7 mm column --
               a knit balaclava at 600 mm read as corduroy. It is a 0.6 mm
               relief in reality; .17 is still generous. */
            o[i] = clamp(0.44 + rib * .17 + (f[i] - .5) * .46, 0, 1);
          }
          return o;
        },
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 30, seed: 403 });
          var o = new Float32Array(r * r), x, y, i, lp = px(3.2), rp = px(7);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            var loop = Math.sin(y * TAU / lp + Math.cos(x * TAU / rp) * 1.1) * .5 + .5;
            o[i] = clamp(.5 + (loop - .5) * .30 + (f[i] - .5) * .66, 0, 1);
          }
          return o;
        }
      },
      /* 12 trim / stencil ------------------------------------------------- */
      {
        name: 'trim', base: '#c2c2c2', grain: .05, tilt: 1.8,
        rough: [.30, .18], metal: .18, sheen: [0, 0, 0], cc: [.38, .22], ao: .40,
        height: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 12, seed: 117 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++) o[i] = clamp(.5 + (f[i] - .5) * .5, 0, 1);
          return o;
        },
        paint: function (g, r) {
          for (var i = 0; i < 14; i++) {
            g.fillStyle = i % 2 ? '#d6d6d6' : '#4a4a4a';
            g.fillRect(184, 8 + i * 17, 60, 17);
          }
          g.fillStyle = 'rgba(40,40,40,.85)';
          g.font = 'bold 44px monospace'; g.fillText('7-2', 16, 78);
          g.fillRect(14, 96, 108, 5);
        }
      },
      /* 13 lens / emissive host ------------------------------------------- */
      {
        name: 'lens', base: '#d0d0d0', grain: .03, tilt: 0.7,
        rough: [.07, .05], metal: .05, sheen: [0, 0, 0], cc: [.85, .06], ao: .25,
        height: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 9, seed: 511 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++) o[i] = clamp(.5 + (f[i] - .5) * .18, 0, 1);
          return o;
        },
        paint: function (g, r) {
          var cx = 96, cy = 96, rad = 74;
          var grad = g.createRadialGradient(cx, cy, 2, cx, cy, rad);
          grad.addColorStop(0, '#ffffff'); grad.addColorStop(.42, '#e8e8e8');
          grad.addColorStop(.72, '#9d9d9d'); grad.addColorStop(1, '#3a3a3a');
          g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.fill();
          g.strokeStyle = 'rgba(30,30,30,.75)'; g.lineWidth = 5;
          g.beginPath(); g.arc(cx, cy, rad * .82, 0, TAU); g.stroke();
          g.fillStyle = '#cfcfcf'; g.fillRect(198, 16, 46, 214);
        }
      },
      /* 14 webbing strap -------------------------------------------------- */
      {
        name: 'web', base: '#a3a09b', grain: .08, tilt: 4.2,
        /* flat woven nylon tape is the shiniest fabric on the operator */
        rough: [.74, .12], metal: 0, sheen: [.22, .21, .20], cc: [0, .5], ao: .92,
        height: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 5, seed: 601 });
          var o = new Float32Array(r * r), x, y, i;
          var tapeW = px(25), selvW = px(2);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            /* 25 mm tape: flat crown, a raised selvedge at each edge, and
               the strap standing off whatever it is sewn to */
            var d = x % tapeW, e = Math.min(d, tapeW - d);
            /* smoothstep over 4 mm, not a linear clamp over 1.5: the tape
               edge was the hardest gradient in the whole atlas */
            var body = sstep(e / px(4.0));
            var selv = e < selvW ? (1 - e / selvW) : 0;
            o[i] = clamp(0.40 + body * .24 + selv * .06 + (f[i] - .5) * .30, 0, 1);
          }
          return o;
        },
        micro: function (r) {
          var f = T.fbm(r, { octaves: 3, frequency: 26, seed: 603 });
          var o = new Float32Array(r * r), x, y, i, wp = px(1.6);
          for (y = 0; y < r; y++) for (x = 0; x < r; x++) {
            i = y * r + x;
            o[i] = clamp(.5 + Math.abs(Math.sin(x * PI / wp)) * .13 - .065 + (f[i] - .5) * .62, 0, 1);
          }
          return o;
        }
      },
      /* 15 wound / scorch decal ------------------------------------------- */
      {
        name: 'wound', base: '#6a4a44', grain: .16, tilt: 9.0,
        rough: [.44, .30], metal: 0, sheen: [0, 0, 0], cc: [.30, .30], ao: .85,
        height: function (r) {
          var f = T.fbm(r, { octaves: 2, frequency: 8, seed: 701 });
          var o = new Float32Array(r * r), i;
          for (i = 0; i < o.length; i++) o[i] = clamp(.5 + (f[i] - .5) * .6, 0, 1);
          return o;
        }
      }
    ];
  }

  /* -------------------------------------------------------------------------
     NORMAL AMPLITUDE, SOLVED RATHER THAN GUESSED.

     Round 2 ran ONE Sobel over the stitched atlas at a fixed strength of 2.0
     over height fields whose contrast nobody had measured. The result --
     measured after the fact -- was a mean normal deviation of 28-47 deg per
     tile with peaks at 79 deg. A real fabric normal is 4-6 deg and a milled
     receiver is 2. That factor of six IS the "shredded / carved from
     splintered wood" surface: every loft ring and every UV-aligned pattern
     turned into a lit gouge.

     So each tile now declares the mean tilt it wants, and its height field is
     pre-scaled by a gain found by bisection against the actual Sobel response
     of that actual field. Change a height function however you like; the
     amplitude stays correct, and the achieved figure is printed at install.
     --------------------------------------------------------------------- */
  var NRM_K = 2.0;                         /* the one global Sobel strength */
  var NRM_ACHIEVED = [];                   /* per-tile measured mean tilt   */
  function gradMags(h, res, step) {
    var out = [], x, y, y0, y1, y2, dx, dy;
    for (y = 1; y < res - 1; y += step) for (x = 1; x < res - 1; x += step) {
      y0 = (y - 1) * res; y1 = y * res; y2 = (y + 1) * res;
      dx = (h[y0 + x + 1] + 2 * h[y1 + x + 1] + h[y2 + x + 1]) -
           (h[y0 + x - 1] + 2 * h[y1 + x - 1] + h[y2 + x - 1]);
      dy = (h[y2 + x - 1] + 2 * h[y2 + x] + h[y2 + x + 1]) -
           (h[y0 + x - 1] + 2 * h[y0 + x] + h[y0 + x + 1]);
      out.push(Math.sqrt(dx * dx + dy * dy));
    }
    return out;
  }
  function meanTilt(g, k) {
    var m = 0, q;
    for (q = 0; q < g.length; q++) m += Math.atan(NRM_K * k * g[q]);
    return g.length ? m / g.length : 0;
  }
  function normalGain(h, res, targetDeg) {
    var g = gradMags(h, res, 3);
    if (!g.length) return 1;
    var want = targetDeg * PI / 180, lo = 0, hi = 12, k, i;
    for (i = 0; i < 22; i++) {
      k = (lo + hi) * 0.5;
      if (meanTilt(g, k) < want) lo = k; else hi = k;
    }
    k = (lo + hi) * 0.5;
    return { k: k, deg: meanTilt(g, k) * 180 / PI };
  }

  function bakeAtlas() {
    var T = NZ.tex, res = TW, i, t, x, y;
    var specs = tileSpecs();
    var tiles = [], micros = [];
    NRM_ACHIEVED.length = 0;
    for (t = 0; t < specs.length; t++) {
      var S = specs[t];
      /* the sub-4 mm structure that used to be (wrongly) in the height field */
      micros.push(S.micro ? S.micro(res) : null);
      /* build the height ONCE and hand the same array to bake for both the
         height and the roughness source: nz-core would otherwise run a second
         fbm + worley per tile to synthesise a roughness map that we replace
         wholesale in the ORM pass below. */
      var hgt = S.height(res);
      tiles.push(T.bake({
        res: res, seed: 11 + t * 17, base: S.base, grain: S.grain,
        ao: { strength: 0 }, wear: S.wear,
        height: (function (a) { return function () { return a; }; })(hgt),
        paint: S.paint,
        normalScale: 1, rough: { base: S.rough[0], variance: 0, map: hgt }
      }));
    }

    /* --------- composite ------------------------------------------------ */
    var alb = document.createElement('canvas'); alb.width = AW; alb.height = AH;
    var ga = alb.getContext('2d');
    var pos = [];
    for (t = 0; t < 16; t++) {
      var px = (t % TCOLS) * TW, py = (t / TCOLS | 0) * TW;
      pos.push([px, py]);
      if (tiles[t]) ga.drawImage(tiles[t].canvas, px, py);
    }

    /* stitched height -> one normal map for the whole atlas, each tile
       pre-scaled to the mean tilt it asked for (see normalGain above) */
    var H = new Float32Array(AW * AH);
    for (t = 0; t < 16; t++) {
      if (!tiles[t]) continue;
      var hp = tiles[t].height, ox = pos[t][0], oy = pos[t][1];
      var gn = normalGain(hp, TW, specs[t].tilt === undefined ? 5 : specs[t].tilt);
      NRM_ACHIEVED.push(specs[t].name + ':' + gn.deg.toFixed(1));
      for (y = 0; y < TW; y++) for (x = 0; x < TW; x++)
        H[(oy + y) * AW + ox + x] = 0.5 + (hp[y * TW + x] - 0.5) * gn.k;
    }
    var nrm = canvasFromRGBA(normalFromHeightRect(H, AW, AH, NRM_K), AW, AH);

    /* ORM: R = cavity AO, G = roughness, B = metalness. r149 samples aoMap.r
       (through uv2), roughnessMap.g and metalnessMap.b, so one texture and
       one sampler serve all three. */
    var orm = document.createElement('canvas'); orm.width = AW; orm.height = AH;
    var go = orm.getContext('2d', { willReadFrequently: true });
    var oid = go.createImageData(AW, AH), od = oid.data;
    for (t = 0; t < 16; t++) {
      if (!tiles[t]) continue;
      var sp = specs[t], hh = tiles[t].height;
      /* Two cavity scales. The old single 4-texel blur only saw the weave and
         produced an AO channel whose whole range was 0.93..1.0 -- bound
         correctly, sampled correctly and completely invisible. The wide pass
         is what darkens a pouch gap or a sulcus. */
      var blur = blurWrap(hh, TW, Math.max(2, TW >> 6));
      var blurW = blurWrap(hh, TW, Math.max(6, TW >> 4));
      var oxx = pos[t][0], oyy = pos[t][1];
      /* ROUGHNESS IS WHERE MATERIAL IDENTITY LIVES. Two independent terms:
         the micro-field (the sub-4 mm weave / pebble / bead-blast that is
         too fine to be relief) drives most of it, and the height drives a
         smaller wear term. rSign flips that wear term for anything that
         gets POLISHED on its high points -- steel, leather, paint -- as
         opposed to abraded rough like cloth and polymer. Without the sign
         flip a worn glove and a worn receiver behave identically, which is
         precisely the "one apparent roughness across the whole cast". */
      var mm = micros[t], rs = sp.rSign === undefined ? 1 : sp.rSign;
      for (y = 0; y < TW; y++) for (x = 0; x < TW; x++) {
        var k = y * TW + x, hi = hh[k], mv = mm ? mm[k] : hi;
        var ao = clamp(1 - (Math.max(0, blur[k] - hi) * 5.5 +
          Math.max(0, blurW[k] - hi) * 3.4) * sp.ao, 0, 1);
        var jj = ((oyy + y) * AW + oxx + x) * 4;
        od[jj] = ao * 255;
        if (ao < ORM_AO[0]) ORM_AO[0] = ao;
        if (ao > ORM_AO[1]) ORM_AO[1] = ao;
        ORM_AO[2] += ao; ORM_AO[3]++;
        od[jj + 1] = clamp(sp.rough[0] + (mv - .5) * sp.rough[1] * 1.7
          + (hi - .5) * sp.rough[1] * 0.8 * rs, .03, 1) * 255;
        od[jj + 2] = clamp(sp.metal + (mv - .5) * .14, 0, 1) * 255;
        od[jj + 3] = 255;
      }
    }
    go.putImageData(oid, 0, 0);

    /* sheen + clearcoat live at half res: both are low-frequency per region */
    var SR = AW >> 1, ST = TW >> 1;
    var shc = document.createElement('canvas'); shc.width = shc.height = SR;
    var gs = shc.getContext('2d', { willReadFrequently: true });
    var ccc = document.createElement('canvas'); ccc.width = ccc.height = SR;
    var gc = ccc.getContext('2d', { willReadFrequently: true });
    var sid = gs.createImageData(SR, SR), sd = sid.data;
    var cid = gc.createImageData(SR, SR), cd = cid.data;
    for (t = 0; t < 16; t++) {
      var s2 = specs[t]; if (!s2) continue;
      var sh = s2.sheen || [0, 0, 0], cc = s2.cc || [0, .5];
      var bx = (t % TCOLS) * ST, by = (t / TCOLS | 0) * ST;
      var hb = tiles[t] ? tiles[t].height : null;
      for (y = 0; y < ST; y++) for (x = 0; x < ST; x++) {
        var hv = hb ? hb[(y * 2) * TW + (x * 2)] : .5;
        var v = 0.82 + hv * 0.36;
        var j2 = ((by + y) * SR + bx + x) * 4;
        sd[j2] = clamp(sh[0] * v, 0, 1) * 255;
        sd[j2 + 1] = clamp(sh[1] * v, 0, 1) * 255;
        sd[j2 + 2] = clamp(sh[2] * v, 0, 1) * 255;
        sd[j2 + 3] = 255;
        /* ccInv: wet biology pools fluid in the CREASES, so the coat gets
           stronger and sharper as the height drops. Manufactured surfaces do
           the opposite -- the high spots are polished by handling. */
        if (s2.ccInv) {
          cd[j2] = clamp(cc[0] * (0.62 + (1 - hv) * 0.62), 0, 1) * 255;
          cd[j2 + 1] = clamp(cc[1] * (0.70 + hv * 0.90), 0, 1) * 255;
        } else {
          cd[j2] = clamp(cc[0] * (0.86 + hv * 0.28), 0, 1) * 255;
          cd[j2 + 1] = clamp(cc[1] * (0.88 + (1 - hv) * 0.30), 0, 1) * 255;
        }
        cd[j2 + 2] = 0; cd[j2 + 3] = 255;
      }
    }
    gs.putImageData(sid, 0, 0); gc.putImageData(cid, 0, 0);

    /* emissive: black except the lens patch (tile 13) */
    var ER = AW >> 1, ET = TW >> 1;
    var emi = document.createElement('canvas'); emi.width = emi.height = ER;
    var ge = emi.getContext('2d');
    ge.fillStyle = '#000'; ge.fillRect(0, 0, ER, ER);
    var ex0 = (13 % TCOLS) * ET, ey0 = (13 / TCOLS | 0) * ET;
    /* THE EYE GLOW IS GONE. The lens patch used to carry a bright radial
       emissive, which is what put a glowing band across every visor and read
       as "alien" from fifty metres. Ballistic glass emits nothing: it reads
       from its clearcoat and from the shape it is set into. The ONLY emissive
       left on the whole cast is the 23 px IR strobe strip below -- one dim
       marker on the back of a helmet, which is a real piece of kit and gives
       the silhouette a single read point in an unlit corridor. */
    ge.fillStyle = 'rgba(70,70,70,1)'; ge.fillRect(ex0 + 99, ey0 + 8, 23, 107);

    function mk(canvas, srgb) {
      var tx = new THREE.CanvasTexture(canvas);
      tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
      if (srgb) { if (THREE.SRGBColorSpace) tx.colorSpace = THREE.SRGBColorSpace; else tx.encoding = THREE.sRGBEncoding; }
      tx.anisotropy = 8;
      return tx;
    }

    ATLAS = {
      map: mk(alb, true),
      normalMap: mk(nrm, false),
      orm: mk(orm, false),
      emissiveMap: mk(emi, true),
      sheenMap: mk(shc, true),
      ccMap: mk(ccc, false)
    };

    for (t = 0; t < 16; t++) {
      var nm = specs[t] ? specs[t].name : ('t' + t);
      REG[nm] = region((t % TCOLS) * TW, (t / TCOLS | 0) * TW, TW, TW);
    }
    /* named sub-patches inside the lens tile */
    var lx = (13 % TCOLS) * TW, ly = (13 / TCOLS | 0) * TW;
    REG.eye = region(lx + 24, ly + 24, 144, 144);
    REG.eyeCore = region(lx + 74, ly + 74, 44, 44);
    REG.glowTrim = region(lx + 198, ly + 16, 46, 214);

    for (t = 0; t < 16; t++) { try { if (tiles[t]) tiles[t].dispose(); } catch (e) { } }
  }

  /* rectangular (non-square) sobel; nz-core's is square-only */
  function normalFromHeightRect(h, w, hgt, strength) {
    var out = new Uint8ClampedArray(w * hgt * 4);
    /* row offsets hoisted: a clamped at(x,y) closure here costs nine calls per
       pixel over a megapixel atlas and was the single slowest thing at boot */
    for (var y = 0; y < hgt; y++) {
      var y0 = (y > 0 ? y - 1 : 0) * w, y1 = y * w, y2 = (y < hgt - 1 ? y + 1 : hgt - 1) * w;
      for (var x = 0; x < w; x++) {
      var xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
      var tl = h[y0 + xm], t = h[y0 + x], tr = h[y0 + xp];
      var l = h[y1 + xm], r = h[y1 + xp];
      var bl = h[y2 + xm], b = h[y2 + x], br = h[y2 + xp];
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
    }
    return out;
  }
  function canvasFromRGBA(data, w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'), id = g.createImageData(w, h);
    id.data.set(data); g.putImageData(id, 0, 0);
    return c;
  }

  /* =========================================================================
     3. SPECIES SPECIFICATION

     Every length is derived from ONE number: the model height H. The
     fractions are the standing anthropometric landmark heights of an adult
     male (ankle .043H, knee .286H, hip joint .530H, wrist .486H, elbow .630H,
     shoulder .806H, chin .870H, crown 1.0H) which puts the head at .130H --
     a 7.7-head figure. That single ratio is what separates a character from
     a toy: a 5.4-head figure (what this file used to build) reads as a bobble
     head no matter how good the texture is.

     Palettes deliberately live in dark linear space: the scene runs ACES with
     exposure 1.18, and the atlas albedo is already ~0.43 linear, so the tint
     below is multiplied by that before it ever reaches the light.
     ====================================================================== */

  var BASE_FRAC = {
    ankle: 0.043, knee: 0.286, hip: 0.530, lumbar: 0.590, thorax: 0.655,
    chest: 0.728, neck: 0.806, head: 0.925, crown: 1.000,
    elbow: 0.630, wrist: 0.486
  };

  function makeBiped(o) {
    var H = o.H || 6.2, k;
    var F = {};
    for (k in BASE_FRAC) F[k] = BASE_FRAC[k];
    if (o.F) for (k in o.F) F[k] = o.F[k];
    var w = o.wide === undefined ? 1 : o.wide;     /* girth multiplier */
    var lr = o.limbR === undefined ? 1 : o.limbR;  /* limb girth multiplier */
    var hk = o.headK === undefined ? 1 : o.headK;  /* head size correction   */
    var sp = {
      H: H, modelH: H, bulk: w, kind: o.kind, skinReg: o.skinReg || 'skin',
      digitigrade: o.digitigrade || 0, tail: o.tail || 0, gun: o.gun || 'rifle',
      gear: o.gear || 'operator', col: o.col,
      /* HEADGEAR AND ROLE. These two were declared in the roster table and
         then silently dropped on the floor here, so `sp.head` was undefined
         for all four operators and buildHead's `sp.head || 'balaclava'`
         fell through to the ASSAULTER branch every time -- which is why the
         RIFLEMAN, the BREACHER and the MARKSMAN were all wearing the
         ASSAULTER's high-cut helmet and comms headset. Four boonie/visor/
         balaclava/wrap variants existed in full and none of them could be
         reached. One missing line was most of "the four are one model". */
      head: o.head || 'balaclava', role: o.role || 'operator',

      /* --- spine chain (local offsets) --- */
      hipY: F.hip * H,
      spine: (F.lumbar - F.hip) * H,
      spine2: (F.thorax - F.lumbar) * H,
      chest: (F.chest - F.thorax) * H,
      neck: (F.neck - F.chest) * H,
      headUp: (F.head - F.neck) * H,

      /* --- arms --- */
      shoulderY: (F.neck - F.chest) * H,    /* clavicle sits at shoulder height */
      shoulderX: 0.030 * H,
      armOut: 0.070 * H,
      upperArm: (F.neck - F.elbow) * H - 0.005 * H,
      foreArm: (F.elbow - F.wrist) * H,
      handLen: 0.108 * H, handW: 0.047 * H, handD: 0.024 * H,

      /* --- legs --- */
      thigh: (F.hip - F.knee) * H,
      shin: (F.knee - F.ankle) * H,
      ankle: (o.ankleH === undefined ? F.ankle : o.ankleH) * H,
      footL: 0.152 * H, footW: 0.055 * H,
      hipW: 0.050 * H,

      /* --- girths ---------------------------------------------------------
         MEASURED, NOT EYEBALLED. Every one of these is a 50th-percentile
         male dimension in millimetres divided by 1830 (the reference
         stature), so it is a FRACTION OF HEIGHT: a 1.92 m BREACHER comes
         out proportionally larger with no per-kind fudge, and the `w` /
         `lr` multipliers then say only how much heavier or leaner than
         average that particular operator is.

         Circumference C -> diameter C/pi -> half is the radius here.
         Clothing adds ~8 mm on the radius (two thicknesses of fatigue),
         which is included in the limb numbers because the limb IS the
         sleeve; the torso numbers are the body and the carrier adds its
         own 30 mm in addGear.

           part                circ    dia    +cloth   half   /1830
           chest                1000    318      -      160   0.0874
           waist                 840    267      -      150*  0.0820
           hip                   960    306      -      174*  0.0951
           neck                  380    121      -       61   0.0333
           thigh proximal        555    177     193     96.5  0.0527
           thigh above knee      400    127     143     71.5  0.0391
           knee                  375    119     135     67.5  0.0369
           calf max              370    118     134     67    0.0366
           ankle                 220     70      86     43    0.0235
           upper arm mid         320    102     118     59    0.0322
           forearm max           275     88     104     52    0.0284
           wrist                 175     56      66     33    0.0180
         (*breadth, not the circular-equivalent: a torso is a flattened
          section, so width and depth are given separately.)              */
      chestW: 0.0874 * H * w, chestD: 0.0645 * H * w,   /* 320 x 236 mm    */
      waistW: 0.0820 * H * w, waistD: 0.0601 * H * w,   /* 300 x 220 mm    */
      hipWd: 0.0951 * H * w,                            /* 348 mm breadth  */
      hipD: 0.0683 * H * w,                             /* 250 mm depth    */
      /* a heavy man's neck thickens, but only about half as fast as his
         waist does -- scaling it by the full bulk gave the BREACHER a
         171 mm neck against a 127 mm target */
      neckR: 0.0333 * H * (1 + (w - 1) * 0.55),
      limbK: lr,
      thighR: 0.0527 * H * lr,  /* 193 mm proximal thigh, clothed  */
      kneeR: 0.0369 * H * lr,   /* 135 mm knee                     */
      calfR: 0.0366 * H * lr,   /* 134 mm calf max                 */
      ankleR: 0.0235 * H * lr,  /* 86 mm ankle                     */
      limbR: 0.0475 * H * lr,   /* legacy alias: mid-thigh radius  */
      armR: 0.0322 * H * lr,    /* 118 mm mid upper arm, clothed   */
      foreR: 0.0284 * H * lr,   /* 104 mm forearm max, clothed     */
      wristR: 0.0180 * H * lr,  /* 66 mm wrist in a glove cuff     */
      /* HEAD SIZE, MEASURED AGAINST THE TABLE RATHER THAN AGREED BY EYE.
         Section 2 of the enemy brief gives 230 mm of head height on a 1.83 m
         male. Probing the real vertex cloud of the four bare heads gave 245 /
         257 / 249 / 239 mm -- every one of them OVER, by 4% on the MARKSMAN
         and 12% on the BREACHER, and inconsistent with each other, which is
         its own tell. `headK` is the per-kind correction that lands all four
         on 230 mm; the value came from the probe, not from taste. */
      headW: 0.0445 * H * hk, headD: 0.057 * H * hk,
      headLow: -0.055 * H * hk, headHigh: 0.075 * H * hk, headK: hk,
      /* the head hitbox must NOT shrink with the mesh correction: it is a
         gameplay volume and the AI aims at it */
      headHit: 0.0445 * H * 1.30,
      gunLen: 0.478 * H
    };
    /* real-world calibration, filled by calibrateScale() once ECFG is
       reachable. mpm = MODEL units per metre for this kind, so every
       millimetre figure in the weapon and kit code turns into geometry with
       one multiply and no eyeballing. */
    sp.mpm = 3.388;                 /* 6.2 model units / 1.83 m, the default */
    sp.mm = function (v) { return v * 0.001 * sp.mpm; };
    /* Does this operator wear a printed pattern or plain fatigues? Two of the
       four do, which is deliberate: four men in the same camo is a uniform
       issue, four men in four different camos is a costume party, and two in
       print with two in plain is a fire team. */
    sp.camo = o.camo ? 1 : 0;
    sp.metaPitch = 0;
    if (o.digitigrade) {
      /* A digitigrade leg stands on its toes: the metatarsal is a long bone
         held at an angle, so the vertical drop from hock to ground is
         ankle*cos(pitch) + toeOffset*sin(pitch), NOT just `ankle`. Getting
         that wrong sinks the claws through the floor by ~5% of body height. */
      sp.ankle = 0.135 * H;
      sp.footL = 0.170 * H;
      sp.metaPitch = 0.45;
      sp.thigh = (F.hip - 0.310) * H;
      sp.shin = (0.310 - 0.115) * H;
    }
    /* vertical distance from the ground contact up to the ankle/hock bone */
    sp.groundUp = sp.digitigrade
      ? sp.ankle * Math.cos(sp.metaPitch) + sp.footL * 0.46 * Math.sin(sp.metaPitch)
      : sp.ankle;

    /* ---- THE SOLE PROFILE ------------------------------------------------
       These four numbers ARE the boot's underside, and the same four numbers
       build the geometry (see the boot loft) and drive the contact solver.
       Deriving the pivot from a hand-picked fraction of footL while the mesh
       was lofted from a different one is what put the rolling pivot 4% ahead
       of the real toe and left a 2 mm/frame residue on every push-off; there
       is now exactly one source of truth.

         soleY     underside plane, foot-bone local (negative = below ankle)
         soleBack  heel-most contact, foot-bone local z
         soleMTP   the metatarsal break -- the toe bone's hinge. Forward of
                   this the sole is a SEPARATE, ARTICULATED segment, which is
                   why a rigid-sole pivot cannot be right at push-off: the
                   toes stay flat on the floor while the boot rotates over
                   them, so the contact stops at the break and does not run
                   on to the tip.
         soleFwd   the tip of the toe box.
       ------------------------------------------------------------------- */
    sp.soleY = -sp.ankle;
    sp.soleBack = 0.329 * sp.footL;
    sp.soleMTP = 0.460 * sp.footL;        /* == the toe bone's z offset */
    sp.soleFwd = 0.658 * sp.footL;
    if (sp.digitigrade) {                 /* a claw walks on the toe segment */
      sp.soleBack = 0.10 * sp.footL;
      sp.soleMTP = 0.46 * sp.footL;
      sp.soleFwd = 0.62 * sp.footL;
    }
    return sp;
  }

  /* ---- the value ladder ---------------------------------------------------
     Every atlas tile is a near-neutral grey (base #aeaba6 etc, ~0.43 linear
     once the sRGB map is decoded), so the ENTIRE albedo of a region is
     tint x 0.43. Write the tint, read the reflectance.

     Round 3's numbers were chosen against a stage that was 1.70 stops hot,
     and the natural correction on a washed-out render -- "darken it" -- drove
     the whole cast into the floor. Measured off the calibrated stage, a
     RIFLEMAN's fatigues rendered at an albedo of 0.037: darker than fresh
     asphalt, and only 1.6:1 against his boots. Four men in six shades of the
     same dark olive is what "value monotony" means.

     These are real measured reflectances of real kit:

       surface                      albedo   tint (albedo / 0.43)
       faded olive/khaki cotton     0.13     0.30
       dust-coloured scrim/shemagh  0.18     0.42
       coyote-tan cordura           0.14     0.33
       wolf-grey combat cloth       0.09     0.21
       ranger-green nylon tape      0.05     0.12
       dark navy nomex              0.048    0.11
       black cordura carrier        0.027    0.062
       black polymer helmet         0.038    0.088
       black leather boot / glove   0.022    0.052
       sole rubber                  0.012    0.028
       parkerised receiver          0.022    0.052

     That is 6:1 from a RIFLEMAN's shemagh to his boots and 2.7:1 between the
     RIFLEMAN's uniform and the BREACHER's -- both survive any tone curve.
     Saturation stays LOW throughout: this is a value ladder, not a paint job,
     which is the CS2 restraint rule.                                          */
  function pal(o) {
    var d = {
      /* Skin, desaturated a step: the .545 red channel read as sunburn-pink
         under the warm level key -- weathered field skin sits closer to
         neutral and a touch darker. */
      skin: [.488, .352, .284], hide: [.475, .338, .276],
      /* The camo tile carries its own hue, so its tint is nearly neutral --
         tinting a printed pattern green a second time is how camo turns into
         a golf course. `scrim` is the shemagh: dust, a shade lighter than
         the uniform so the face band separates from the collar. */
      camo: [.148, .146, .120], scrim: [.118, .114, .094],
      cloth: [.150, .152, .104], knit: [.032, .033, .036],
      nylon: [.056, .049, .041], web: [.044, .041, .038],
      leather: [.031, .030, .030], plastic: [.069, .071, .058],
      /* `steel` is a METAL tint: the atlas gives it metalness ~1, so this
         number is F0, the specular reflectance, not a diffuse albedo. It was
         1.60 -- a mirror that returns 160% of the light that hits it, which
         is where the blown-white buckle at every operator's navel came from.
         Real bare steel F0 is 0.55-0.62. */
      rubber: [.026, .025, .026], steel: [.58, .565, .545],
      painted: [.052, .050, .045], trim: [.141, .141, .137],
      /* Gunmetal. Deliberately NOT a flat grey: `gun` is the parkerised
         receiver, `gunwear` the polished high points the atlas wear pass
         lifts toward, `furniture` the polymer/wood on the handguard and
         stock. A rifle painted one colour is the single loudest "prop"
         tell after the wrong length. */
      gun: [.052, .053, .056], gunwear: [.30, .31, .32], furniture: [.075, .066, .052],
      /* a magazine is pressed steel or bakelite -- never the same material as
         the furniture. Sharing the wood colour is what made the AK banana
         read as a wooden blade hanging off the receiver. */
      magazine: [.034, .032, .030],
      accent: [.30, .28, .24], wound: [.30, .07, .05]
    };
    if (o) for (var k in o) d[k] = o[k];
    /* legacy aliases used by shared code paths */
    d.hard = d.plastic; d.armor = d.painted;
    d.scale = d.camo; d.brain = d.scrim;   /* retired creature regions */
    return d;
  }

  /* -------------------------------------------------------------------------
     THE ROSTER  (CS2-ENEMY-BRIEF section 1)

     The alien/mutant cast is retired. All four `kind` IDs are FROZEN because
     NUKEM.html, nz-audio.js and nz-shots.js all switch on them; only the
     fiction and the art change. Every one is now a human operator sharing one
     skeleton, one locomotion solver and one ragdoll spec -- the differences
     are kit, build, palette and weapon, exactly as they would be in CS2.

       trooper  RIFLEMAN   light   chest rig, boonie, no plate     AK-pattern
       pig      BREACHER   heavy   full plate, visored helmet      shotgun
       enforcer ASSAULTER  medium  plate, headset, balaclava       M4-pattern
       octa     MARKSMAN   light   wrap/veil, low-vis              bolt DMR

     Palettes are CS2-grounded: desaturated, dark, and separated by VALUE
     rather than by hue. The whole set lives between 0.007 and 0.16 linear.
     ---------------------------------------------------------------------- */
  var SPEC = {
    /* RIFLEMAN -- olive-drab fatigues, tan chest rig, boonie hat. The lightest
       loadout, so the silhouette is the closest to a bare human figure. */
    trooper: makeBiped({
      kind: 'trooper', H: 6.2, skinReg: 'skin', gun: 'ak', gear: 'light',
      role: 'rifleman', head: 'boonie', camo: 1, headK: 0.939,
      col: pal({
        /* THE LIGHT ONE, AND THE LIGHTEST. Sun-faded olive over coyote tan:
           the warmest and highest-value operator in the set, so at 20 m he
           is the pale figure. */
        cloth: [.212, .226, .142],          /* faded olive drab, A=0.093   */
        camo: [.242, .240, .192],           /* printed: the tile has hue   */
        scrim: [.340, .318, .238],          /* dust shemagh -- his lightest */
        knit: [.052, .052, .050],           /* black gaiter                */
        nylon: [.360, .268, .152],          /* coyote-tan chest rig, A=.154 */
        web: [.128, .118, .082],            /* ranger-green tape           */
        leather: [.056, .050, .042],        /* brown-black boot / glove    */
        plastic: [.115, .112, .086],
        painted: [.098, .096, .078],
        rubber: [.030, .029, .029],
        furniture: [.158, .105, .062],      /* AK laminate: brown, not orange */
        magazine: [.052, .050, .050],       /* pressed steel -- dark against wood */
        trim: [.290, .274, .216]
      })
    }),
    /* BREACHER -- the heavy. Full plate carrier over a dark navy uniform, a
       visored ballistic helmet, knee pads, and the widest build in the set:
       he has to read as MASS in the silhouette from across a room. */
    pig: makeBiped({
      kind: 'pig', H: 6.2, skinReg: 'skin', gun: 'shotgun', gear: 'breacher',
      role: 'breacher', head: 'visor', headK: 0.895,
      /* He is 1.92 m, so the stature-fraction girths already make him 5%
         bigger than the RIFLEMAN everywhere. 1.20/1.16 ON TOP of that put
         his upper arm at 179 mm against a 124 mm target and his neck at
         171 against 127 -- which is not "heavy", it is an action figure.
         A heavy operator's MASS comes from 12 kg of plate, not from his
         forearms, so the bulk moves into the carrier (see pcW/pcT). */
      wide: 1.11, limbR: 1.06,
      F: { neck: 0.796, head: 0.912, hip: 0.524, thorax: 0.650 },
      col: pal({
        /* THE DARK ONE. Navy nomex under black cordura -- he is a hole in
           the frame next to the RIFLEMAN, which is the whole point: the
           heavy is the one you read as mass and shadow. */
        cloth: [.086, .092, .112],          /* dark navy nomex, A=0.038    */
        knit: [.038, .039, .044],
        nylon: [.062, .064, .074],          /* black carrier, A=0.027      */
        web: [.042, .043, .050],
        leather: [.044, .044, .050],
        plastic: [.062, .065, .074],        /* black helmet shell          */
        painted: [.056, .058, .066],
        rubber: [.026, .026, .028],
        furniture: [.058, .058, .062],      /* shotgun polymer furniture   */
        magazine: [.050, .051, .055],
        trim: [.150, .156, .170]
      })
    }),
    /* ASSAULTER -- the middle weight. Slick plate carrier in coyote over grey
       combat trousers, balaclava, comms headset with a boom mic and a radio on
       the shoulder. */
    enforcer: makeBiped({
      kind: 'enforcer', H: 6.2, skinReg: 'skin', gun: 'm4', gear: 'assault',
      role: 'assaulter', head: 'balaclava', headK: 0.924,
      wide: 1.03, limbR: 1.00,
      F: { neck: 0.804, head: 0.920 },
      col: pal({
        /* THE NEUTRAL ONE. Cool wolf-grey trousers, warm coyote carrier:
           the only operator whose vest is LIGHTER than his uniform, and the
           only one carrying a real warm/cool split inside one figure. */
        cloth: [.112, .116, .122],          /* wolf grey, A=0.049          */
        knit: [.042, .042, .044],           /* black balaclava             */
        nylon: [.298, .224, .132],          /* coyote carrier, A=0.128     */
        web: [.112, .092, .058],
        leather: [.050, .046, .040],
        plastic: [.092, .086, .066],        /* tan helmet shell            */
        painted: [.104, .096, .074],
        rubber: [.028, .028, .029],
        furniture: [.056, .056, .058],      /* M4 black polymer            */
        magazine: [.062, .064, .058],       /* PMAG, olive-black           */
        trim: [.215, .198, .152]
      })
    }),
    /* MARKSMAN -- low-vis. A hooded wrap and a scrim veil instead of a helmet,
       a slim rig with only spotter kit on it, and the leanest build. He is the
       one you should have most trouble picking out of a wall. */
    octa: makeBiped({
      kind: 'octa', H: 6.2, skinReg: 'skin', gun: 'dmr', gear: 'marksman',
      role: 'marksman', head: 'wrap', camo: 1, headK: 0.962,
      /* THE LEAN ONE. Roster differentiation was riding entirely on
         headgear and colour because all four carriers were the same volume;
         he is now 8% narrower through the chest than the ASSAULTER and 20%
         narrower than the BREACHER, which is a silhouette difference before
         any texture resolves. */
      wide: 0.93, limbR: 0.94,
      F: { neck: 0.810, head: 0.928 },
      col: pal({
        /* THE GREEN ONE. Mid value, strongly green, with dead-grass scrim
           tags a full stop lighter than everything under them -- so his
           outline is mottled rather than solid, which is what a veil does. */
        cloth: [.172, .196, .128],          /* faded olive-green, A=0.079  */
        camo: [.160, .180, .124],
        scrim: [.288, .276, .166],          /* dead grass -- breaks the edge */
        knit: [.048, .052, .042],
        nylon: [.128, .142, .096],          /* ranger green rig            */
        web: [.078, .086, .058],
        leather: [.046, .045, .038],
        plastic: [.078, .084, .062],
        painted: [.086, .092, .068],
        rubber: [.027, .027, .028],
        furniture: [.092, .100, .072],      /* green chassis               */
        magazine: [.058, .060, .052],
        trim: [.240, .248, .186]
      })
    })
  };

  /* -------------------------------------------------------------------------
     SCALE CALIBRATION.

     The world is not in metres. One number ties everything together: a trooper
     is the baseline adult operator at 1.83 m and ECFG gives him h = 6.4 world
     units, so the world runs at 3.497 units per metre. Every kind's MODEL is
     6.2 units tall and its root is scaled by cfg.h / 6.2, so the model-space
     millimetre scale differs per kind -- and that is exactly the point: an AK
     is 880 mm in the hand of every operator regardless of how big he is. Get
     this wrong and the heavy character's rifle silently grows 16%.
     ---------------------------------------------------------------------- */
  var WU_PER_M = 6.4 / 1.83;                 /* 3.4972 world units per metre */
  function calibrateScale() {
    var E = getECFG();
    for (var i = 0; i < KINDS.length; i++) {
      var k = KINDS[i], sp = SPEC[k];
      if (!sp) continue;
      var worldH = (E && E[k] && E[k].h) || 6.4;
      var unit = worldH / sp.modelH;         /* root scale applied at runtime */
      sp.worldH = worldH;
      sp.unit = unit;
      sp.mpm = WU_PER_M / unit;              /* MODEL units per real metre    */
      sp.realH = sp.modelH / sp.mpm;         /* what this operator "is", in m */
      sp._gun = null;                        /* mm scale moved: rebuild it    */
      var gd = gunSpec(sp);
      /* published anchors (contract C3 / gripLocal), all weapon-bone local */
      sp.grip = {
        r: gd.gripR, l: gd.gripL, rPt: gd.gripRPt, lPt: gd.gripLPt,
        butt: gd.butt, muzzle: gd.muzzle, sight: gd.sight, low: gd.low,
        oal: gd.oal, oalMM: gd.oalReal, oalWorld: gd.oal * unit
      };
    }
  }

  /* =========================================================================
     3b. GAIT CHARACTER
     -------------------------------------------------------------------------
     Three bipeds sharing one solver is fine; three bipeds sharing one set of
     NUMBERS is why they read as the same puppet in different jackets. Every
     line below is a physical statement about the animal, not a taste knob:

       duty     fraction of the cycle a foot spends on the ground. > 0.5 means
                there is always a foot down (a walk); < 0.5 opens a flight
                phase (a run). Heavy animals keep duty high at every speed --
                an elephant never has both feet off the ground.
       strideK  stride LENGTH scale. Cadence is speed / stride, so a short
                stride at the same speed IS a higher step rate. Small fast
                animals scurry (short + quick), heavy ones plod.
       bob      vertical pelvis excursion. Mass that has to be lifted and
                dropped every step; a heavy body does more of it, not less.
       sway     lateral pelvis travel over the planted foot -- the waddle.
       lift     ground clearance of the swing foot.
       sideBend how far the trunk rolls over the loaded leg.
       land     heel-strike shock gain. This is the single loudest weight cue.

     The one hard constraint the solver imposes: the body travels
     stride*duty during a stance, and the foot has to cover that on the
     ground, so stride*duty must stay under 2*stepMax*legLen + rollShift or
     the placement clamps and the character scrabbles. Every pair below is
     checked against that at both walk and top speed.
     ====================================================================== */
  var GAIT = {
    trooper: {
      dutyW: 0.620, dutyR: 0.395, strideK: 1.00, stepMax: 0.42,
      bob: 1.00, sway: 1.00, surge: 1.00, land: 0.90,
      pelvYaw: 1.00, twist: 1.05, sideBend: 0.88, lift: 0.95,
      stanceW: 1.00, crouch: 0.022, crouchV: 0.028, leanRun: 0.110,
      armK: 1.00, armOut: 0.00, armLag: 1.00,
      headK: 1.00, scanRate: 1.15, scanAmp: 1.00, headLead: 1.00,
      breath: 1.00, fidget: 1.00, combatStride: 0.70, wind: 1.00
    },
    /* BREACHER. 30 kg of plate and a breaching shotgun: high duty (a foot is
       always down), a short stride, a heavy heel strike and a wide track. He
       plods, and the plod is the whole read on his weight. */
    pig: {
      /* strideM*dutyW = 4.03*0.660 = 2.66   (limit 2.76)  OK
         strideM*dutyR = 5.72*0.470 = 2.69   (limit 2.76)  OK           */
      dutyW: 0.660, dutyR: 0.470, strideK: 0.90, stepMax: 0.42,
      bob: 1.10, sway: 1.22, surge: 1.28, land: 1.85,
      pelvYaw: 0.78, twist: 0.84, sideBend: 1.35, lift: 0.70,
      stanceW: 1.26, crouch: 0.030, crouchV: 0.024, leanRun: 0.075,
      armK: 1.20, armOut: 0.26, armLag: 1.40,
      headK: 0.78, scanRate: 0.74, scanAmp: 0.80, headLead: 0.62,
      breath: 1.42, fidget: 0.80, combatStride: 0.82, wind: 1.30
    },
    /* ASSAULTER. A trained shooter moving fast and light: the shortest,
       highest-cadence step of the three, the most trunk counter-rotation, and
       he keeps the weapon in the shoulder while he moves, which is what the
       low combatStride encodes. */
    enforcer: {
      /* legLen 3.02, limit 2*0.42*3.02 + rollShift ~ 2.66
         strideM*dutyW = 3.90*0.600 = 2.34                 OK
         strideM*dutyR = 5.30*0.415 = 2.20                 OK           */
      dutyW: 0.600, dutyR: 0.415, strideK: 0.92, stepMax: 0.42,
      bob: 0.96, sway: 0.94, surge: 1.10, land: 0.95,
      pelvYaw: 1.10, twist: 1.18, sideBend: 0.80, lift: 1.05,
      /* crouch 0.046 -> 0.034: rendered side-on, the old figure advanced with
         his hips sunk a tenth of a leg and his thigh never passing behind the
         pelvis -- a creep, not an advance. A third less sink buys the hip
         extension back and he still reads as coiled. */
      stanceW: 0.96, crouch: 0.034, crouchV: 0.030, leanRun: 0.128,
      armK: 1.05, armOut: 0.10, armLag: 0.86,
      headK: 1.22, scanRate: 1.55, scanAmp: 1.12, headLead: 1.15,
      breath: 1.15, fidget: 1.25, combatStride: 0.66, wind: 0.90
    },
    /* MARKSMAN. Deliberate and quiet: the longest duty of the three shooters,
       a low deliberate step, almost no bounce (he is trying not to disturb a
       sight picture) and the slowest, longest head scans in the set. */
    octa: {
      dutyW: 0.645, dutyR: 0.440, strideK: 0.96, stepMax: 0.42,
      bob: 0.82, sway: 0.90, surge: 0.90, land: 0.72,
      pelvYaw: 0.92, twist: 0.96, sideBend: 0.78, lift: 0.86,
      stanceW: 0.94, crouch: 0.052, crouchV: 0.030, leanRun: 0.095,
      armK: 0.86, armOut: 0.05, armLag: 1.05,
      headK: 1.05, scanRate: 0.62, scanAmp: 1.25, headLead: 0.90,
      breath: 0.86, fidget: 0.65, combatStride: 0.62, wind: 0.75
    }
  };
  for (var _gk in GAIT) if (SPEC[_gk]) SPEC[_gk].g = GAIT[_gk];

  /* =========================================================================
     4. SKELETON
     ====================================================================== */
  function bipedBones(sp) {
    /* name, parent, [x,y,z], [rx,ry,rz] */
    var B = [], idx = {}, H = sp.H;
    function add(name, parent, x, y, z, rx, ry, rz) {
      idx[name] = B.length;
      B.push({ name: name, parent: parent === null ? -1 : idx[parent], p: [x, y, z], r: [rx || 0, ry || 0, rz || 0] });
    }
    add('hips', null, 0, sp.hipY, 0);
    add('spine', 'hips', 0, sp.spine, 0.004 * H);
    add('spine2', 'spine', 0, sp.spine2, 0.002 * H);
    add('chest', 'spine2', 0, sp.chest, -0.004 * H);
    add('neck', 'chest', 0, sp.neck, -0.010 * H);
    add('head', 'neck', 0, sp.headUp, 0.012 * H);
    for (var s = 0; s < 2; s++) {
      var sg = s ? 1 : -1, S = s ? 'R' : 'L';
      add('clav' + S, 'chest', sg * sp.shoulderX, sp.shoulderY, 0.008 * H, 0, 0, sg * 0.05);
      /* arms hang down and angle OUT (A-pose): rotating -Y about +Z by t
         sends it toward +X, so the sign must follow the side.              */
      add('arm' + S, 'clav' + S, sg * sp.armOut, -0.005 * H, -0.004 * H, 0.05, 0, sg * 0.22);
      add('fore' + S, 'arm' + S, 0, -sp.upperArm, 0, 0.05, 0, 0);
      add('hand' + S, 'fore' + S, 0, -sp.foreArm, 0, 0, 0, 0);
      /* one finger-root bone: enough to open the hand on death and to curl it
         on the grip without paying for five chains */
      add('fing' + S, 'hand' + S, 0, -sp.handLen * 0.42, sp.handD * 0.30, 0, 0, 0);
    }
    for (s = 0; s < 2; s++) {
      var sg2 = s ? 1 : -1, S2 = s ? 'R' : 'L';
      add('thigh' + S2, 'hips', sg2 * sp.hipW, 0, 0.002 * H, 0, 0, sg2 * 0.03);
      add('shin' + S2, 'thigh' + S2, 0, -sp.thigh, 0, sp.digitigrade ? -0.30 : 0, 0, 0);
      /* The thigh is canted 0.03 rad inward (real shins converge) and the foot
         inherits it -- which in BIND pose rolls both soles 1.7 degrees and
         leaves the OUTER EDGE of each boot as its lowest geometry. A standing
         person's feet are flat; the convergence stops at the ankle. Cancelling
         it here is what puts the sole's contact row back on the centreline,
         where the skin binder and the contact solver both expect it. */
      add('foot' + S2, 'shin' + S2, 0, -sp.shin, 0,
        sp.digitigrade ? 0.30 + sp.metaPitch : 0, 0, -sg2 * 0.03);
      add('toe' + S2, 'foot' + S2, 0, -sp.ankle, sp.footL * 0.46, sp.digitigrade ? -(0.30 + sp.metaPitch) : 0, 0, 0);
    }
    /* The trigger finger gets its own bone. CS2 indexes the index finger
       along the receiver until the shot breaks and curls it onto the trigger
       to fire, and it reads -- it is the one piece of hand detail a player
       actually notices. One extra bone on one hand is the whole cost. */
    add('trigR', 'handR', -sp.handW * 0.44, -sp.handLen * 0.30, sp.handD * 0.42, -0.30, 0, 0);
    add('weapon', 'chest', 0.030 * sp.H, -0.030 * sp.H, 0.075 * sp.H);
    for (var t = 0; t < (sp.tail || 0); t++)
      add('tail' + t, t ? 'tail' + (t - 1) : 'hips', 0, t ? -0.098 * H : -0.020 * H, t ? 0 : -0.050 * H, t ? 0.10 : -1.30);
    /* toeLen: the skin binder synthesises a stub for any bone without a child,
       and its default is straight DOWN the bone's -Y. For the toe that points
       into the floor, so the whole toe box binds to the FOOT instead and the
       boot in front of the metatarsal break stops bending -- which drives the
       toe box 20 mm through the floor at every push-off. The toe's segment
       has to run FORWARD, from the break to the tip. */
    /* soleSeg: the FOOT bone's own skin segment, hand-placed. The default
       (bone origin -> child origin) runs from the ankle to the toe and shares
       its start point with the shin, so every vertex behind the ankle -- the
       whole heel of the boot -- is exactly equidistant from the two and binds
       to whichever the sort happens to pick. Half a heel driven by the shin
       is a heel that does not roll at heel strike. Give the foot a segment
       that actually spans its own volume and the ambiguity disappears. */
    return { list: B, idx: idx, H: sp.H,
      toeLen: sp.digitigrade ? 0 : Math.max(1e-4, sp.soleFwd - sp.soleMTP),
      soleSeg: sp.digitigrade ? null
        : [0.35 * sp.soleY, -0.95 * sp.soleBack, 0.90 * sp.soleY, sp.soleMTP] };
  }


  /* Build the bind-pose template and pull out bind world matrices + inverses */
  function buildSkeletonTemplate(spec) {
    var objs = [], i, root = new THREE.Object3D();
    var H = spec.H || 6.2;
    for (i = 0; i < spec.list.length; i++) {
      var d = spec.list[i], o = new THREE.Object3D();
      o.position.set(d.p[0], d.p[1], d.p[2]);
      o.rotation.set(d.r[0], d.r[1], d.r[2]);
      objs.push(o);
      if (d.parent < 0) root.add(o); else objs[d.parent].add(o);
    }
    root.updateMatrixWorld(true);
    var bindWorld = [], inverses = [], segs = [], bindPos = [];
    for (i = 0; i < objs.length; i++) {
      bindWorld.push(objs[i].matrixWorld.clone());
      inverses.push(new THREE.Matrix4().copy(objs[i].matrixWorld).invert());
      var e = objs[i].matrixWorld.elements;
      bindPos.push([e[12], e[13], e[14]]);
    }
    /* bone segments used by the skin binder */
    for (i = 0; i < objs.length; i++) {
      var child = -1;
      for (var k = 0; k < spec.list.length; k++) if (spec.list[k].parent === i) { child = k; break; }
      var a = bindPos[i], b;
      if (spec.soleSeg && spec.list[i].name.indexOf('foot') === 0) {
        var eF = bindWorld[i].elements, S4 = spec.soleSeg;
        a = [a[0] + eF[4] * S4[0] + eF[8] * S4[1], a[1] + eF[5] * S4[0] + eF[9] * S4[1],
          a[2] + eF[6] * S4[0] + eF[10] * S4[1]];
        b = [bindPos[i][0] + eF[4] * S4[2] + eF[8] * S4[3],
          bindPos[i][1] + eF[5] * S4[2] + eF[9] * S4[3],
          bindPos[i][2] + eF[6] * S4[2] + eF[10] * S4[3]];
        segs.push([a[0], a[1], a[2], b[0], b[1], b[2]]);
        continue;
      }
      if (child >= 0) b = bindPos[child];
      else {
        /* synthesize a tail along the bone's own -Y (limbs) or +Y (head) */
        var e2 = bindWorld[i].elements;
        var n = spec.list[i].name;
        if (spec.toeLen && n.indexOf('toe') === 0) {
          /* the toe runs FORWARD along its own +Z, not down */
          b = [a[0] + e2[8] * spec.toeLen, a[1] + e2[9] * spec.toeLen,
            a[2] + e2[10] * spec.toeLen];
        } else {
          var up = (n === 'head') ? 1 : -1;
          var len = (n === 'head') ? 0.100 * H : 0.050 * H;
          b = [a[0] + e2[4] * up * len, a[1] + e2[5] * up * len, a[2] + e2[6] * up * len];
        }
      }
      segs.push([a[0], a[1], a[2], b[0], b[1], b[2]]);
    }
    return { objs: objs, bindWorld: bindWorld, inverses: inverses, segs: segs, bindPos: bindPos, spec: spec };
  }

  /* =========================================================================
     5. CHARACTER GEOMETRY
     ====================================================================== */
  function M(tpl, name) { return tpl.bindWorld[tpl.spec.idx[name]]; }

  /* quality: 0 = LOD0, 1 = LOD1, 2 = far bake source.
     LOD1 keeps every silhouette-defining part -- only the tessellation drops.
     A LOD that deletes gear is a LOD that pops. */
  function LQ(q) {
    return {
      big: q === 0 ? 14 : q === 1 ? 10 : 6,   /* torso / head */
      lim: q === 0 ? 10 : q === 1 ? 8 : 6,    /* limbs */
      tiny: q === 0 ? 6 : q === 1 ? 5 : 4,    /* pouches, straps */
      /* HANDS GET THEIR OWN BUDGET. A finger is 18 mm across and it is
         600 mm from the camera in every third-person frame the player will
         ever see -- so the six-sided prism `tiny` gives it is a visible
         hexagon, and it was the last faceted thing left on the model. Ten
         sides on five digits is ~700 triangles a hand, which against a
         3500-triangle rifle is nothing, and it is the difference between a
         hand and a bundle of pencils. */
      hand: q === 0 ? 10 : q === 1 ? 7 : 4,
      cham: q === 0 ? 4 : q === 1 ? 3 : 2,    /* samples per chamfer quadrant */
      rings: q === 0 ? 8 : q === 1 ? 6 : 4,
      detail: q < 2
    };
  }

  function buildBiped(kind, tpl, q) {
    var sp = SPEC[kind], ix = tpl.spec.idx, C = sp.col;
    var pile = new Pile();
    var Q = LQ(q), h = sp.H, s, sg, N;
    var skinR = REG[sp.skinReg];
    var bulk = sp.bulk;
    var MM = 0.001 * sp.mpm;                   /* one real millimetre       */
    var LK = sp.limbK === undefined ? 1 : sp.limbK;
    /* A limb station written the way it is measured: t along the bone, then
       WIDTH and DEPTH in millimetres (not radii -- a diameter is the number
       you can look up), a superellipse exponent, and an offset of the section
       centre in mm so a calf can sit behind its bone and a patella in front
       of it. Everything below is a real circumference / pi. */
    function seg(L, t, wmm, dmm, n, czmm, ao, flat) {
      return { y: -L * t, cx: 0, cz: (czmm || 0) * MM * LK,
        rx: wmm * 0.5 * MM * LK, rz: dmm * 0.5 * MM * LK,
        n: n, uv: t, ao: ao === undefined ? 1 : ao, flat: flat };
    }
    /* the same thing placed by an absolute millimetre offset instead of a
       fraction of a bone -- pads, panels and collars are sized in mm */
    function sec(ymm, wmm, dmm, n, czmm, uv, ao) {
      return { y: ymm * MM * LK, cx: 0, cz: (czmm || 0) * MM * LK,
        rx: wmm * 0.5 * MM * LK, rz: dmm * 0.5 * MM * LK,
        n: n, uv: uv, ao: ao === undefined ? 1 : ao };
    }

    /* ---- masks (which bones each part may bind to) ------------------- */
    var mTorso = [ix.hips, ix.spine, ix.spine2, ix.chest, ix.thighL, ix.thighR];
    var mChest = [ix.spine2, ix.chest, ix.neck, ix.clavL, ix.clavR];
    var mBelt = [ix.hips, ix.spine];
    var mHead = [ix.head, ix.neck];
    var mNeck = [ix.neck, ix.head, ix.chest];
    var mArmL = [ix.clavL, ix.armL, ix.foreL, ix.handL];
    var mArmR = [ix.clavR, ix.armR, ix.foreR, ix.handR];
    var mHandL = [ix.foreL, ix.handL, ix.fingL];
    var mHandR = [ix.foreR, ix.handR, ix.fingR, ix.trigR];
    var mFingL = [ix.handL, ix.fingL];
    var mFingR = [ix.handR, ix.fingR];
    /* the uniform region: printed pattern or plain fatigue, per operator */
    var uniR = sp.camo ? REG.camo : REG.cloth, uniC = sp.camo ? C.camo : C.cloth;
    var mLegL = [ix.hips, ix.thighL, ix.shinL, ix.footL, ix.toeL];
    var mLegR = [ix.hips, ix.thighR, ix.shinR, ix.footR, ix.toeR];
    var mFootL = [ix.shinL, ix.footL, ix.toeL];
    var mFootR = [ix.shinR, ix.footR, ix.toeR];
    var mGun = [ix.weapon];
    var mClavL = [ix.chest, ix.clavL, ix.armL, ix.neck];
    var mClavR = [ix.chest, ix.clavR, ix.armR, ix.neck];

    /* ---- torso: lofted cross-sections in hips space ------------------ */
    var hipsM = M(tpl, 'hips');
    var chestM = M(tpl, 'chest'), spine2M = M(tpl, 'spine2');
    var tt = [];
    function tsec(y, rx, rz, n, cz, ao) {
      tt.push({ y: y * h, rx: rx, rz: rz, n: n, cz: (cz || 0) * h, ao: ao === undefined ? 1 : ao, uv: 0 });
    }
    /* THE MASS DISTRIBUTION IS THE READ. A man is widest across the
       deltoids, narrows hard at the natural waist, and comes back out at
       the trochanters -- and the pelvis is the piece that was wrong: at
       waistW*1.00 the hip measured 264 mm across against a real 348, so
       two 193 mm thighs hanging off it were genuinely WIDER than the body
       they hang from. That inversion, not the thigh diameter, is what made
       the figure read as an action figure. hipWd is now its own dimension.  */
    tsec(-0.078, sp.hipWd * 0.66, sp.hipD * 0.62, 3.0, 0.000, 0.70);
    tsec(-0.048, sp.hipWd * 0.90, sp.hipD * 0.88, 3.3, 0.000, 0.84);
    tsec(-0.014, sp.hipWd * 1.00, sp.hipD * 0.98, 3.4, 0.000, 0.94);
    tsec(0.020, sp.hipWd * 0.94, sp.hipD * 0.92, 3.2, -0.002, 1.00);
    tsec(0.074, sp.waistW * 1.00, sp.waistD * 1.00, 2.9, -0.004, 1.00);
    tsec(0.122, sp.waistW * 1.06, sp.waistD * 1.10, 2.9, -0.002, 1.00);
    tsec(0.170, sp.chestW * 0.94, sp.chestD * 1.00, 3.1, 0.000, 1.00);
    tsec(0.214, sp.chestW * 1.00, sp.chestD * 1.03, 3.2, 0.000, 1.00);
    tsec(0.258, sp.chestW * 0.96, sp.chestD * 0.90, 3.0, -0.006, 0.96);
    tsec(0.288, sp.chestW * 0.56, sp.chestD * 0.62, 2.7, -0.012, 0.82);
    for (var i = 0; i < tt.length; i++) tt[i].uv = i / (tt.length - 1);
    addLoft(pile, hipsM, tt, Q.big, subReg(uniR, 0, 0, 1, 1), uniC, mTorso,
      { capStart: true, capEnd: true, wear: 0.55, wearFreq: 1.1, name: 'torso' });

    /* TRAPEZIUS RAMP: fills the gap between the neck and the deltoid, so the
       shoulders are not a barrel with arms stuck on.

       It was a 146 x 175 mm TUBE laid from the midline to the shoulder joint
       -- bigger in section than the head, sitting on TOP of the shoulder and
       presenting a broad near-planar face straight at the key. That, not the
       carrier, is most of "the shoulder yoke renders as two flat pale slabs":
       a big smooth surface square-on to the light will always be the
       brightest thing in the frame. A real trapezius is a RAMP, ~100 mm thick
       where it leaves the neck and thinning as it goes, and it is DARKER than
       the deltoid because it faces up-and-inboard into its own occlusion. */
    for (s = 0; s < 2; s++) {
      sg = s ? 1 : -1; N = s ? 'R' : 'L';
      addLoft(pile, xf(M(tpl, 'clav' + N), null, [0, 0, sg * PI / 2]), [
        { y: 0.028 * h, rx: 43 * MM * bulk, rz: 52 * MM * bulk, n: 2.6, uv: 0, ao: .66 },
        { y: -0.010 * h, rx: 50 * MM * bulk, rz: 58 * MM * bulk, n: 2.6, uv: .4, ao: .80 },
        { y: -0.048 * h, rx: 48 * MM * bulk, rz: 52 * MM * bulk, n: 2.6, uv: .8, ao: .82 },
        { y: -0.070 * h, rx: 44 * MM * bulk, rz: 47 * MM * bulk, n: 2.6, uv: 1, ao: .76 }
      ], Q.lim, subReg(uniR, .1, .1, .7, .7), uniC, s ? mClavR : mClavL,
        { wear: 0.5, wearFreq: 1.4, name: 'trap' });
    }

    /* ---- limbs -------------------------------------------------------- */
    for (s = 0; s < 2; s++) {
      sg = s ? 1 : -1; N = s ? 'R' : 'L';
      var armMask = s ? mArmR : mArmL, handMask = s ? mHandR : mHandL;
      var fingMask = s ? mFingR : mFingL;
      var legMask = s ? mLegR : mLegL, footMask = s ? mFootR : mFootL;
      var armM = M(tpl, 'arm' + N), foreM = M(tpl, 'fore' + N), handM = M(tpl, 'hand' + N);
      var thighM = M(tpl, 'thigh' + N), shinM = M(tpl, 'shin' + N), footM = M(tpl, 'foot' + N);

      /* UPPER ARM. 320 mm mid-arm circumference is a 102 mm limb, 118 in a
         sleeve -- and the tube that was here ran 172 mm at the deltoid and
         147 at mid-arm, i.e. very nearly as thick as the 155 mm head. The
         profile is the deltoid mass at the top, the biceps/triceps belly at
         a third of the way down, then a continuous taper into the elbow;
         it is slightly deeper than wide all the way, because it is. */
      var UA = sp.upperArm;
      addLoft(pile, armM, [
        seg(UA, 0.00, 122, 128, 2.4, 0, .80),   /* deltoid insertion       */
        seg(UA, 0.14, 121, 126, 2.3, 0, .96),
        seg(UA, 0.32, 119, 124, 2.2, 0),        /* biceps belly            */
        seg(UA, 0.50, 116, 120, 2.2, 0),        /* the table's 118 mm      */
        seg(UA, 0.70, 108, 112, 2.3, 0),
        seg(UA, 0.86, 100, 104, 2.5, 0),
        seg(UA, 1.00, 94, 98, 2.7, 0, .94)      /* into the elbow          */
      ], Q.lim, subReg(uniR, .2, 0, .6, 1), uniC, armMask,
        { capStart: true, wear: .5, wearFreq: 1.5, name: 'uparm' });
      /* FOREARM SLEEVE, cuffed short so the glove/forearm join reads. Max
         girth (275 mm -> 88, 104 clothed) is right under the elbow and the
         taper from there to the wrist is the steepest on the whole arm. */
      var FA = sp.foreArm;
      addLoft(pile, foreM, [
        seg(FA, 0.00, 102, 106, 2.6, 0, .84),
        seg(FA, 0.15, 104, 106, 2.4, 0),        /* the table's 104 mm      */
        seg(FA, 0.34, 96, 98, 2.3, 0),
        seg(FA, 0.50, 87, 89, 2.3, 0),
        seg(FA, 0.62, 80, 82, 2.4, 0, .92)      /* the cuff                */
      ], Q.lim, subReg(uniR, .4, .1, .5, .8), uniC, armMask,
        { wear: .55, wearFreq: 1.7, name: 'sleeve' });
      /* ELBOW PANEL. Real combat shirts are reinforced at the elbow and the
         panel is the thing you SEE: a raised, double-thickness patch with a
         stitch line round it, sitting slightly proud of the sleeve and worn
         a shade lighter than the cloth around it because that is the part
         that gets dragged across gravel. It is also a hard silhouette break
         on an otherwise smooth tube. */
      /* The panel wraps the BACK of the joint (the olecranon), so it is a
         shallow cap 6 mm proud of a 98 mm sleeve, not a second tube round
         it: 112 mm across the elbow against the sleeve's 98 is the step
         that makes the joint read as a joint at 10 m. */
      if (q < 2) addLoft(pile, xf(armM, [0, -sp.upperArm * 0.94, -sp.armR * 0.42], [0.06, 0, 0]), [
        sec(52, 84, 46, 3.4, 0, 0, .80),
        sec(22, 112, 62, 3.6, 0, .35),
        sec(-34, 108, 59, 3.6, 0, .78),
        sec(-66, 74, 42, 3.4, 0, 1, .74)
      ], Q.lim, subReg(uniR, .55, .05, .4, .5), uniC, armMask,
        { capStart: true, capEnd: true, tone: 1.13, wear: .85, wearFreq: 4.2,
          name: 'elbowpanel' });
      /* bare/gloved forearm below the cuff */
      /* A WRIST IS 55 mm ACROSS. This tube was armR*0.80 -> armR*0.60, i.e.
         98 mm down to 74 mm, so the forearm never narrowed and it merged
         with the palm into one continuous pale mass -- which is most of why
         the hand read as "an undifferentiated mitten" even after the fingers
         underneath it were correct. */
      addLoft(pile, xf(foreM, [0, -sp.foreArm * 0.58, 0]), [
        { y: 0, rx: 41 * MM * LK, rz: 42 * MM * LK, n: 2.2, uv: 0, ao: .78 },
        { y: -FA * 0.24, rx: 36 * MM * LK, rz: 36 * MM * LK, n: 2.3, uv: .55 },
        /* 175 mm wrist circumference is 56 mm across; 66 in a glove cuff */
        { y: -FA * 0.42, rx: 33 * MM * LK, rz: 31 * MM * LK, n: 2.4, uv: 1, ao: .84 }
      ], Q.lim, subReg(REG.leather, 0, .3, .5, .5), C.leather, armMask,
        { wear: .35, wearFreq: 2.2, name: 'cuff' });

      /* ---- hand: palm, four WRAPPED fingers, thumb, knuckle pad --------
         Every radius here used to be a full dimension dropped into a radius
         slot, so the hand was built at exactly twice its anthropometric size
         -- a 172 mm palm 88 mm thick, which is what "an undifferentiated
         mitten" actually was. handW is the 86 mm hand WIDTH and handD the
         44 mm hand DEPTH, so the half-extents are half of those. */
      /* (MM, one real millimetre, is hoisted to the top of buildBiped) */
      /* THE PALM. Round 3's was a four-ring brick that ran the same width
         from wrist to knuckles, so from behind the hand was one mass with
         four tubes leaving it. A real metacarpus is a WEDGE: narrow and
         thick at the wrist, wide and thin at the knuckle row, with the
         dorsum flattening as it goes. Eight rings, and rz falls while rx
         rises -- which is the whole shape. */
      addLoft(pile, handM, [
        { y: 0.014 * h, rx: sp.handW * 0.36, rz: sp.handD * 0.40, n: 2.4, uv: 0, ao: .76 },
        { y: 0.000, rx: sp.handW * 0.42, rz: sp.handD * 0.42, n: 2.7, uv: .18, ao: .88 },
        { y: -0.016 * h, rx: sp.handW * 0.48, rz: sp.handD * 0.41, n: 3.0, uv: .36 },
        { y: -0.030 * h, rx: sp.handW * 0.52, rz: sp.handD * 0.38, n: 3.2, uv: .55 },
        { y: -0.042 * h, rx: sp.handW * 0.53, rz: sp.handD * 0.35, n: 3.4, uv: .74 },
        { y: -0.052 * h, rx: sp.handW * 0.50, rz: sp.handD * 0.31, n: 3.4, uv: .90, ao: .92 },
        { y: -0.059 * h, rx: sp.handW * 0.42, rz: sp.handD * 0.25, n: 3.2, uv: 1, ao: .84 }
      ], Q.hand, subReg(REG.leather, .3, 0, .45, .6), C.leather, handMask,
        { capStart: true, capEnd: true, name: 'palm' });
      /* THE KNUCKLE ROLL, not a knuckle slab. The MCP row is four domes on an
         arc that is highest at the index and falls away to the little finger
         -- a single chamfered box across it is what "the palm/knuckle mass
         dominates from behind" was describing. Each dome is its own small
         loft on the glove's reinforced panel. */
      for (var kn = 0; kn < 4; kn++) {
        var kx = (kn - 1.5) * sp.handW * 0.245;
        var kfall = 1 - Math.abs(kn - 0.7) * 0.075;
        addLoft(pile, xf(handM, [kx, -sp.handLen * (0.415 + kn * 0.012),
          -sp.handD * 0.30 * kfall], [PI / 2, 0, 0]), [
          { y: 0, rx: 9.6 * MM, rz: 8.4 * MM, n: 2.6, uv: 0, ao: .74 },
          { y: -5.0 * MM, rx: 10.4 * MM * kfall, rz: 9.6 * MM * kfall, n: 2.8, uv: .5, ao: .95 },
          { y: -10.5 * MM, rx: 7.4 * MM, rz: 6.6 * MM, n: 2.6, uv: 1, ao: .70 }
        ], Q.hand, subReg(REG.knit, .2, .2, .5, .5), C.knit, handMask,
          { capStart: true, capEnd: true, tone: 0.94, name: 'knuckle' });
      }
      /* THE WEB OF THE THUMB. The thenar eminence is the single largest soft
         mass on a hand and the model had nothing there at all, which left a
         hard crease where the thumb met the palm. */
      addLoft(pile, xf(handM, [sg * -sp.handW * 0.30, -sp.handLen * 0.22, sp.handD * 0.10],
        [0.25, 0, sg * 0.45]), [
        { y: 0.020 * h, rx: sp.handW * 0.17, rz: sp.handD * 0.28, n: 2.6, uv: 0, ao: .72 },
        { y: 0.004 * h, rx: sp.handW * 0.24, rz: sp.handD * 0.38, n: 2.8, uv: .45, ao: .90 },
        { y: -0.014 * h, rx: sp.handW * 0.22, rz: sp.handD * 0.34, n: 2.8, uv: .8, ao: .84 },
        { y: -0.026 * h, rx: sp.handW * 0.13, rz: sp.handD * 0.22, n: 2.6, uv: 1, ao: .70 }
      ], Q.hand, subReg(REG.leather, .3, .5, .35, .4), C.leather, handMask,
        { capStart: true, capEnd: true, name: 'thenar' });

      /* --- the grip itself ------------------------------------------------
         The trigger hand closes on a 32 mm pistol grip, the support hand on
         a 42 mm handguard, so they do not wrap by the same amount -- and the
         chord construction in wrapDigit turns that difference into a real
         difference in how open the hand looks. */
      var fR = 9.4 * MM;                             /* gloved finger radius */
      /* effective wrap radius of what is being held: an AK pistol grip is
         33x44 mm so the fingers see about 17 mm, an AK handguard is 54x40 so
         they see about 26. Getting this wrong by 5 mm is 30 deg of wrap, and
         30 deg too much is fingertips bursting out through the top of the
         handguard -- which is exactly what a 21 mm assumption produced. */
      var barR = (s === 1 ? 17 : 26) * MM;
      var wrapR = barR + fR;
      var fSk = subReg(REG.leather, .55, .5, .3, .4);
      /* proximal / middle / distal phalanges, index -> little, millimetres */
      var PH = [[42, 25, 20], [45, 27, 21], [43, 26, 20], [34, 20, 17]];
      var fPitch = sp.handW * 0.245;                 /* 21 mm centre to centre */
      var fSub = q === 0 ? 3 : q === 1 ? 2 : 1;

      /* the trigger finger is INDEXED along the receiver, not curled: it
         gets its own bone so section 12 can roll it onto the trigger as the
         shot breaks, and it is the one piece of hand detail a player sees */
      if (s === 1) {
        addSweep(pile, M(tpl, 'trigR'), wrapDigit({
          x: 0, cy: -6 * MM, cz: 96 * MM, R: 96 * MM, start: -0.34,
          seg: [42 * MM, 25 * MM, 20 * MM], r: fR, sub: fSub, root: 1.05
        }), Q.hand, fSk, C.leather, [ix.trigR, ix.handR],
          { capStart: true, capEnd: true, aoIn: .18, aoSide: .26, name: 'trigfinger' });
      }
      /* The knuckle row is a DIAGONAL, not a line: the index sits highest and
         furthest round the grip, the little finger lowest and least wrapped.
         Staggering the four wrap starts is what turns four arcs into a hand. */
      /* THE SUPPORT HAND WAS ONE MASS AND THE ARITHMETIC SAYS WHY.
         Finger pitch is 21.0 mm centre to centre; the digits were drawn at
         r 9.4 mm with `wide` 1.14, i.e. 10.7 mm of half-width -- 21.4 mm
         across on a 21.0 mm pitch, so adjacent fingers INTERSECTED and the
         four of them fused into a single lump with no valley to catch a
         shadow. The trigger hand escaped it only because its index finger is
         a separate part and it wraps a 17 mm grip instead of a 26 mm
         handguard, which fans the remaining three apart in depth.
         The support hand now gets: sections narrow enough to leave a 1.4 mm
         gap at the knuckle, a wider wrap stagger, a real lateral fan, and
         deeper side occlusion so the gap reads as a crease and not a seam. */
      var supp = (s === 0);
      var fStart = supp ? [-0.54, -0.34, -0.16, 0.02] : [-0.44, -0.30, -0.19, -0.06];
      for (i = (s === 1 ? 1 : 0); i < 4; i++) {
        var ph = PH[i];
        addSweep(pile, M(tpl, 'fing' + N), wrapDigit({
          x: (i - 1.5) * fPitch * (supp ? 1.06 : 1),
          cy: -14 * MM, cz: barR, R: wrapR,
          start: fStart[i],
          seg: [ph[0] * MM, ph[1] * MM, ph[2] * MM],
          r: fR * (i === 3 ? 0.84 : i === 0 ? 0.95 : 1) * (supp ? 0.94 : 1),
          wide: supp ? 0.98 : 1.14,
          dx: -(i - 1.5) * (supp ? 0.105 : 0.055), sub: fSub
        }), Q.hand, fSk, C.leather, fingMask,
          { capStart: true, capEnd: true, aoIn: .22,
            aoSide: supp ? .46 : .30, name: 'finger' });
      }
      /* THUMB. Two phalanges, and the two hands do completely different
         things with it: the support thumb lies FORWARD along the top of the
         handguard (that is what makes a C-clamp a C-clamp), the trigger
         thumb wraps over the back of the grip and points up the receiver. */
      var thP = s === 1
        ? [sg * -sp.handW * 0.40, -sp.handLen * 0.20, sp.handD * 0.22]
        : [sg * -sp.handW * 0.40, -sp.handLen * 0.26, sp.handD * 0.30];
      var thR = s === 1 ? [0.42, 0.30, sg * -0.72] : [-0.34, 0.10, sg * -1.32];
      addSweep(pile, xf(handM, thP, thR), wrapDigit({
        x: 0, cy: 0, cz: (s === 1 ? 20 : 150) * MM,
        R: (s === 1 ? 30 : 150) * MM, start: -0.42,
        seg: [40 * MM, 32 * MM], r: fR * 1.16, sub: fSub, root: 1.20
      }), Q.hand, subReg(REG.leather, .1, .55, .3, .4), C.leather, handMask,
        { capStart: true, capEnd: true, aoIn: .18, name: 'thumb' });

      /* ---- leg ---------------------------------------------------------
         EVERY DIAMETER BELOW IS A MEASURED CIRCUMFERENCE / PI, PLUS 16 mm
         FOR TWO THICKNESSES OF FATIGUE CLOTH:

           thigh proximal   555 mm -> 177 + 16 = 193
           mid thigh        500    -> 159 + 16 = 175
           thigh at knee    400    -> 127 + 16 = 143   (26% down from prox)
           knee             375    -> 119 + 16 = 135
           calf max         370    -> 118 + 16 = 134
           ankle            220    ->  70 + 16 =  86   (36% down from calf)

         The taper carries as much of the read as the absolute size: a tube
         that holds its diameter is a wader whatever it measures. Nor is a
         leg circular. A thigh is wider than deep and its bulk sits slightly
         forward (vastus/rectus); a calf is DEEPER than wide and its bulk
         sits behind the bone, which `cz` finally expresses. */
      var TH = sp.thigh, SH = sp.shin;
      addLoft(pile, thighM, [
        seg(TH, 0.00, 196, 190, 2.5, 2, .82),
        seg(TH, 0.10, 193, 187, 2.4, 3, .96),   /* proximal max            */
        seg(TH, 0.30, 175, 172, 2.3, 4),
        seg(TH, 0.50, 163, 161, 2.3, 4),
        seg(TH, 0.70, 152, 152, 2.3, 3),
        seg(TH, 0.86, 145, 146, 2.4, 2),
        seg(TH, 1.00, 141, 143, 2.6, 0, .92)    /* just above the knee     */
      ], Q.lim, subReg(uniR, 0, .2, .8, .8), uniC, legMask,
        { capStart: true, wear: .5, wearFreq: 1.2, name: 'thigh' });
      /* THE KNEE HAS TO READ AS A JOINT. Three things do that and none of
         them were here: the section NARROWS at the joint line (135 against
         143 above it), the patella stands 8 mm proud of it on the front,
         and the popliteal fossa is a HOLLOW behind -- `flat` scales the
         back half of the section, so 0.86 at the joint line is a real dish
         where the hamstring tendons run. */
      addLoft(pile, shinM, [
        seg(SH, 0.000, 134, 138, 2.7, 4, .88, 0.88),  /* joint line        */
        seg(SH, 0.045, 136, 141, 2.6, 3, .96, 0.90),  /* tibial tuberosity */
        seg(SH, 0.140, 135, 139, 2.4, -3),
        seg(SH, 0.270, 130, 138, 2.3, -6),            /* calf max          */
        seg(SH, 0.420, 118, 124, 2.3, -5),
        seg(SH, 0.580, 104, 107, 2.3, -3),
        seg(SH, 0.740, 93, 94, 2.4, -1),
        seg(SH, 0.870, 86, 85, 2.5, 0),               /* ankle             */
        seg(SH, 1.000, 82, 80, 2.6, 0, .90)
      ], Q.lim, subReg(uniR, .15, 0, .8, .8), uniC, legMask,
        { wear: .6, wearFreq: 1.3, name: 'shin' });
      /* TROUSER BLOUSING. It has to end INSIDE the boot: round 2 stopped it
         level with the ankle cuff, so two low-poly rings of different radius
         and different segment phase intersected each other and the corners
         of one poked through the other -- a ring of dark triangles round
         every ankle that read as torn geometry. Now the hem gathers to
         narrower than the cuff and finishes 64 mm down inside it, so the
         two surfaces cannot cross. */
      /* THE HEM GATHERS AT THE TOP OF THE BOOT, NOT AT THE ANKLE. It used to
         finish 64 mm off the ground, which buried the whole boot shaft and
         left 51 mm of leather to carry every feature a boot has. Real
         blousing bunches over the cuff at ~200 mm and tucks inside it. */
      addLoft(pile, xf(shinM, [0, -sp.shin * 0.63, 0]), [
        { y: 0, rx: 50 * MM * LK, rz: 50 * MM * LK, n: 2.6, uv: 0, ao: .9 },
        { y: -SH * 0.055, rx: 72 * MM * LK, rz: 72 * MM * LK, n: 2.8, uv: .34 },
        { y: -SH * 0.100, rx: 68 * MM * LK, rz: 68 * MM * LK, n: 2.8, uv: .62, ao: .80 },
        { y: -SH * 0.135, rx: 50 * MM * LK, rz: 50 * MM * LK, n: 2.6, uv: .84, ao: .66 },
        { y: -SH * 0.172, rx: 35 * MM * LK, rz: 35 * MM * LK, n: 2.4, uv: 1, ao: .56 }
      ], Q.lim, subReg(uniR, .3, .3, .5, .5), uniC, legMask,
        { wear: .6, wearFreq: 2.0, name: 'blouse' });
      /* the blousing strap that holds the gather -- a real piece of kit and
         the thing that explains the shape */
      addLoft(pile, xf(shinM, [0, -sp.shin * 0.725, 0]), [
        { y: 0.008 * h, rx: 66 * MM * LK, rz: 66 * MM * LK, n: 2.8, uv: 0, ao: .74 },
        { y: -0.008 * h, rx: 66 * MM * LK, rz: 66 * MM * LK, n: 2.8, uv: 1, ao: .82 }
      ], Q.lim, subReg(REG.web, .1, .3, .35, .5), C.web, legMask,
        { tone: .92, name: 'blousestrap' });

      /* Knee pads: BREACHER and ASSAULTER only. The rifleman and the
         marksman do not wear them, and their absence is a real silhouette
         difference in profile -- a bare knee is a smooth taper, a pad is a
         step. Gating kit by role is most of what makes four characters read
         as four people rather than one model in four palettes. */
      /* KNEE PANEL. Same story as the elbow and even more visible, because a
         soldier kneels: reinforced double cloth, proud of the leg, abraded
         lighter, with the stitch line reading as a value step at any range.
         The two operators who wear hard knee pads get theirs OVER this, so
         the panel is built for everyone -- which is also what a real pad
         sits on. */
      /* The panel is also the PATELLA: 62 mm wide at the top, 132 at the
         cap, 96 at the bottom, domed 10 mm proud of a 135 mm knee. One part
         doing two jobs beats a separate kneecap that has to be kept from
         intersecting it. */
      if (q < 2) addLoft(pile, xf(shinM, [0, sp.shin * 0.030, 30 * MM * LK], [-0.10, 0, 0]), [
        sec(112, 92, 54, 3.2, 0, 0, .78),
        sec(38, 130, 74, 3.5, 2, .30),
        sec(-50, 126, 70, 3.5, 1, .74),
        sec(-100, 84, 50, 3.2, 0, 1, .72)
      ], Q.lim, subReg(uniR, .05, .5, .45, .45), uniC, legMask,
        { capStart: true, capEnd: true, tone: 1.15, wear: .9, wearFreq: 3.8,
          name: 'kneepanel' });
      /* A hard knee pad is 25 mm proud of the knee at the cap, and only at
         the cap -- it wraps about 140 deg and stops. 185 mm across a 135 mm
         knee is a pad; the 170 mm cylinder that was here was an exoskeleton. */
      var kneePad = sp.gear === 'breacher' || sp.gear === 'assault';
      /* A KNEE PAD IS A DOMED CAP, NOT A SHIN PLATE.
         224 mm tall and 168 mm across with n=3.6 is a flat-topped slab that
         runs 100 mm down the tibia -- from the front it dominated the lower
         leg and read as armour bolted to the shin. A real hard-shell pad is
         a 150 mm cup 165 mm tall that WRAPS the joint: it is widest at the
         patella and rolls back into the leg at both ends, so its silhouette
         is a dome with two soft tails. The three things that make that read:
         a low superellipse exponent (2.6, round, not 3.6 boxy), a `cz` that
         swings the section back into the leg at the ends so the cap is proud
         only at the cap, and a top station small enough that it does not
         terminate in a flat lip. */
      if (kneePad) addLoft(pile, xf(shinM, [0, 4 * MM * LK, 26 * MM * LK], [-0.06, 0, 0]), [
        sec(64, 70, 44, 2.8, -16, 0, .70),
        sec(32, 122, 74, 2.7, 2, .22, .90),
        sec(-4, 144, 88, 2.6, 12, .48, 1),
        sec(-44, 134, 82, 2.6, 8, .72, .96),
        sec(-80, 100, 60, 2.7, -6, .90, .82),
        sec(-104, 58, 36, 2.9, -20, 1, .66)
      ], Q.lim, subReg(REG.plastic, 0, 0, .6, .6), C.plastic, legMask,
        { capStart: true, capEnd: true, wear: .55, wearFreq: 3.4, name: 'kneepad' });
      if (Q.detail && kneePad) {
        /* two elastic retention straps BEHIND the knee -- the thing that
           explains why the cap stays on, and a dark band across the calf that
           breaks the leg up in profile */
        for (var ks = 0; ks < 2; ks++) {
          addLoft(pile, xf(shinM, [0, (ks ? -76 : 30) * MM * LK, -8 * MM * LK]), [
            sec(-11, 138, 132, 2.6, 0, 0, .74),
            sec(11, 138, 132, 2.6, 0, 1, .86)
          ], Q.lim, subReg(REG.web, .2, .2, .5, .5), C.web, legMask,
            { tone: .88, name: 'kneestrap' });
        }
      }

      /* ---- boot: leather upper, ankle collar, rubber sole, lace panel -- */
      if (sp.digitigrade) {
        /* three-toed clawed foot for the reptile */
        var fw = sp.limbR * 0.82;
        addLoft(pile, footM, [
          { y: 0.02, rx: sp.limbR * 0.62, rz: sp.limbR * 0.62, n: 2.6, uv: 0, ao: .85 },
          { y: -sp.ankle * 0.55, rx: fw * 1.02, rz: fw * 1.14, n: 3.2, uv: .35 },
          { y: -sp.ankle, rx: fw * 0.96, rz: fw * 1.18, cz: 0.02, n: 3.6, uv: .7, ao: .8 }
        ], Q.lim, subReg(REG.scale, 0, 0, .7, .7), C.scale, footMask, { capStart: true, name: 'hock' });
        var tm = M(tpl, 'toe' + N);
        for (var cI = -1; cI <= 1; cI++) {
          addLoft(pile, xf(tm, [cI * fw * 0.78, 0, 0], [-1.50, cI * 0.18, 0]), [
            { y: 0.02, rx: fw * 0.40, rz: fw * 0.40, n: 2.4, uv: 0, ao: .8 },
            { y: -sp.footL * 0.34, rx: fw * 0.28, rz: fw * 0.28, n: 2.4, uv: .6 },
            { y: -sp.footL * 0.52, rx: 0.004, rz: 0.004, n: 2, uv: 1 }
          ], Q.tiny, subReg(REG.plastic, .4, .4, .5, .5), C.plastic, footMask,
            { capStart: true, name: 'claw' });
        }
      } else {
        /* The boot is lofted along its OWN length: the -PI/2 about X sends the
           loft's +y down the foot's -z, so a section's `y` is a station along
           the boot and its `cz` is a vertical offset. Every station below is
           expressed in sp.soleBack / sp.soleMTP / sp.soleFwd so the mesh and
           the contact solver cannot drift apart. */
        var bm = xf(footM, [0, -sp.ankle * 0.50, 0], [-PI / 2, 0, 0]);
        var bH = sp.ankle * 0.50;
        /* footW is the 100 mm foot WIDTH, and every rx below was feeding it
           straight into a RADIUS slot -- so the boot was built 200 mm across
           when a size 10 combat boot is 110. That is the whole reason the
           boots read as "amorphous lumpy sacks": they were twice as wide as
           they were meant to be, on a correctly-sized leg. */
        var bW = sp.footW * 0.55;                 /* 55 mm half-width */
        /* welt line: the boot upper stops here and the sole takes over, so
           every section's cz is solved to keep the underside dead flat --
           a boot whose toe dips below the contact plane sinks into the floor */
        var welt = -0.68 * bH;
        var bsec = function (zz, rxf, rzf, uv, ao, nn) {
          return { y: zz, rx: bW * rxf, rz: bH * rzf, cz: bH * rzf + welt,
                   n: nn || 3.6, uv: uv, ao: ao };
        };
        /* A boot has FOUR readable features and round 2 had none of them: a
           square heel counter at the back, a waist that narrows at the
           instep, a broad toe box, and a toe cap that rolls up off the
           ground. The n exponent rises toward the heel because a heel
           counter is a stiffened box and falls at the toe because a toe cap
           is a dome. */
        /* THE TOE BOX IS NARROWER THAN THE BALL. It was widest at 66% forward
           and still 0.88 at 90%, so the front half was one continuous dome --
           a clog. A boot's widest point is the ball of the foot (the MTP
           break) and the toe box falls away from there in BOTH plan and
           section: 110 mm at the ball, 92 at the toe cap, 62 at the tip. */
        addLoft(pile, bm, [
          bsec(sp.soleBack * 1.02, 0.72, 0.86, 0, .72, 4.2),
          bsec(sp.soleBack * 0.62, 0.92, 1.02, .12, .92, 4.0),
          bsec(sp.soleBack * 0.10, 0.84, 1.00, .30, 1, 3.6),
          bsec(-sp.soleMTP * 0.72, 0.94, 0.90, .50, 1, 3.4),
          bsec(-sp.soleMTP * 1.06, 1.00, 0.74, .70, 1, 3.4),
          bsec(-sp.soleFwd * 0.88, 0.82, 0.52, .90, .86, 3.4),
          bsec(-sp.soleFwd * 1.02, 0.54, 0.31, 1, .70, 2.8)
        ], Q.lim, subReg(REG.leather, 0, 0, .8, .8), C.leather, footMask,
          { capStart: true, capEnd: true, tone: 0.93, wear: .5, wearFreq: 3.0,
            name: 'boot' });
        /* toe cap: a second skin over the front third, the scuffed panel */
        /* A TOE CAP IS THE DARKEST PART OF A BOOT, NOT THE LIGHTEST.
           It was drawn 10% ABOVE the leather tone with heavy fade wear, and
           since it is also the one panel whose normals face the key it came
           back three stops brighter than the shaft -- a pale rock stuck on
           the front of a dark boot, which is most of what "smooth blob"
           meant. A real toe cap is the panel that gets polished: lower
           albedo, and 3% proud so the seam round it is a geometric step
           rather than a tone change. */
        if (Q.detail) addLoft(pile, bm, [
          bsec(-sp.soleFwd * 0.26, 0.99, 0.86, 0, .74, 3.2),
          bsec(-sp.soleFwd * 0.52, 1.05, 0.80, .35, 1, 3.0),
          bsec(-sp.soleFwd * 0.84, 1.00, 0.62, .72, .94, 2.8),
          bsec(-sp.soleFwd * 1.03, 0.56, 0.33, 1, .74, 2.4)
        ], Q.lim, subReg(REG.leather, .5, .1, .4, .5), C.leather, footMask,
          { capEnd: true, tone: 0.84, wear: .35, wearFreq: 5.0, name: 'toecap' });
        /* Sole: a separate slab so the boot has a real edge, not a rounded
           blob. Its underside is sp.soleY DEAD FLAT from -soleBack to
           +soleFwd -- `cz` compensates every change of rz so the tapering
           toe box does not lift the contact plane with it. */
        var solT = 0.16 * bH;                    /* slab half-thickness      */
        var sm = xf(footM, [0, sp.soleY + solT, 0], [-PI / 2, 0, 0]);
        var ssec = function (zz, rxf, rzf, uv, ao) {
          return { y: zz, rx: bW * rxf, rz: solT * rzf, cz: solT * (rzf - 1), n: 4.3, uv: uv, ao: ao };
        };
        /* `rot: -PI/2` puts sample 0 of every ring exactly on the underside
           centreline. That row IS the contact line -- the tread runs down it,
           the normals break over it, and, less obviously, it is the only
           place on a swivelling boot that does not scuff: without it the
           lowest geometry is the two rows either side of centre, 50 mm out,
           and every pivot sweeps them. */
        /* the sole is PROUD of the upper all the way round: that ledge is the
           welt, and it is the single line that separates a boot from a
           slipper in silhouette. 6 mm was too much -- at 12% wider than the
           upper the sole read as a platform sticking out under a bag, which
           is the other half of the clog. A real stitchdown welt is 2-3 mm. */
        var wlt = 1.045;
        addLoft(pile, sm, [
          ssec(sp.soleBack * 1.04, 0.74 * wlt, 1.00, 0, .66),
          ssec(sp.soleBack * 0.50, 0.94 * wlt, 1.06, .18, .96),
          ssec(sp.soleBack * 0.02, 0.84 * wlt, 0.86, .38, 1),
          ssec(-sp.soleMTP, 1.02 * wlt, 1.00, .62, 1),
          ssec(-sp.soleFwd * 0.90, 0.86 * wlt, 0.94, .86, .9),
          ssec(-sp.soleFwd * 1.02, 0.56 * wlt, 0.76, 1, .6)
        ], Q.lim, subReg(REG.rubber, 0, 0, .7, .7), C.rubber, footMask,
          { capStart: true, capEnd: true, rot: -PI / 2, name: 'sole' });
        /* -----------------------------------------------------------------
           THE SHAFT. This is the whole of defect 3.

           Round 5's boot was 92 mm tall -- an ankle bootee -- and the trouser
           blousing gathered at 63 mm, so exactly 51 mm of boot was visible
           between the hem and the sole. Fifty-one millimetres cannot carry a
           lace row, a heel counter or a collar, which is precisely why the
           upper read as "a smooth blob": there was no upper. A combat boot is
           200 mm tall and bloused trousers gather at ITS TOP, not at the
           ankle, so the lace panel and the counter are the most-looked-at
           50 mm of the whole silhouette.

           `gy(mm)` = a height above the ground plane, in foot-bone local Y.
           Every station below is a real boot measurement. */
        var gy = function (mmv) { return mmv * MM - sp.ankle; };
        var TOP = 200, THR = 96;                  /* cuff top / lace throat  */
        addLoft(pile, footM, [
          { y: gy(58), rx: bW * 1.00, rz: bW * 1.14, n: 3.2, uv: 0, ao: .70 },
          { y: gy(THR), rx: bW * 0.96, rz: bW * 1.04, n: 3.0, uv: .28, ao: .80 },
          { y: gy(146), rx: bW * 0.92, rz: bW * 0.97, n: 2.9, uv: .60, ao: .90 },
          { y: gy(TOP - 16), rx: bW * 0.97, rz: bW * 1.00, n: 2.9, uv: .88, ao: .97 },
          { y: gy(TOP), rx: bW * 0.99, rz: bW * 1.02, n: 2.9, uv: 1, ao: .92 }
        ], Q.lim, subReg(REG.leather, .1, .05, .8, .8), C.leather, footMask,
          { wear: .45, wearFreq: 2.6, name: 'shaft' });
        /* padded cuff roll at the top -- the one soft edge on a stiff boot */
        addLoft(pile, footM, [
          { y: gy(TOP - 14), rx: bW * 1.02, rz: bW * 1.05, n: 2.7, uv: 0, ao: .84 },
          { y: gy(TOP - 2), rx: bW * 1.07, rz: bW * 1.10, n: 2.6, uv: .5, ao: 1 },
          { y: gy(TOP + 8), rx: bW * 0.98, rz: bW * 1.01, n: 2.7, uv: 1, ao: .72 }
        ], Q.lim, subReg(REG.leather, .5, .4, .45, .5), C.leather, footMask,
          { tone: 1.10, name: 'collar' });
        /* HEEL COUNTER. A stiffened box round the back of the heel with a
           hard edge where it stops -- the feature that tells you which way a
           boot is facing at 20 m. Built as its own shell so the seam is a
           real geometric step, not a texture. */
        addLoft(pile, xf(footM, [0, 0, -bW * 0.34]), [
          { y: gy(24), rx: bW * 0.90, rz: bW * 0.86, n: 3.6, uv: 0, ao: .70 },
          { y: gy(66), rx: bW * 0.99, rz: bW * 0.92, n: 3.6, uv: .5, ao: .88 },
          { y: gy(112), rx: bW * 0.90, rz: bW * 0.82, n: 3.4, uv: 1, ao: .78 }
        ], Q.lim, subReg(REG.leather, .6, .05, .34, .5), C.leather, footMask,
          { tone: .92, capEnd: true, wear: .5, wearFreq: 4.0, name: 'counter' });
        if (Q.detail) {
          /* EYELET STAYS. The two reinforced strips the lace holes are
             punched through. They are 8 mm proud of the shaft, so at any
             range they read as a pair of vertical highlights either side of a
             dark trough -- which IS the read "laced boot", before a single
             lace resolves. */
          for (var es = -1; es <= 1; es += 2) {
            addLoft(pile, xf(footM, [es * bW * 0.44, 0, bW * 0.60]), [
              { y: gy(THR - 4), rx: bW * 0.24, rz: bW * 0.30, n: 3.4, uv: 0, ao: .78 },
              { y: gy(150), rx: bW * 0.22, rz: bW * 0.27, n: 3.4, uv: .6, ao: .94 },
              { y: gy(TOP - 6), rx: bW * 0.19, rz: bW * 0.23, n: 3.2, uv: 1, ao: .86 }
            ], Q.tiny, subReg(REG.leather, .62, .48, .3, .4), C.leather, footMask,
              { capStart: true, capEnd: true, tone: 1.16, name: 'stay' });
          }
          /* tongue, down in the trough between the stays and darker than
             both, so the throat reads as a shadow line */
          addLoft(pile, xf(footM, [0, 0, bW * 0.52]), [
            { y: gy(THR - 10), rx: bW * 0.36, rz: bW * 0.26, n: 3.6, uv: 0, ao: .62 },
            { y: gy(160), rx: bW * 0.33, rz: bW * 0.23, n: 3.6, uv: .7, ao: .74 },
            { y: gy(TOP - 4), rx: bW * 0.29, rz: bW * 0.20, n: 3.4, uv: 1, ao: .66 }
          ], Q.tiny, subReg(REG.leather, .1, .1, .3, .5), C.leather, footMask,
            { capStart: true, capEnd: true, tone: .80, name: 'tongue' });
          /* SPEED LACES, and they CROSS. Five rods alternating +/- 22 deg
             between the two stays: four parallel bars read as a grille, a
             crossed pair reads as lacing. */
          var lacR = 3.1 * MM;
          for (var lc = 0; lc < 5; lc++) {
            var lyy = gy(THR + 6 + lc * 22);
            var tilt = (lc & 1 ? 1 : -1) * 0.38;
            addLoft(pile, xf(footM, [0, lyy, bW * 0.60], [0, 0, PI / 2 + tilt]), [
              { y: -bW * 0.46, rx: lacR, rz: lacR, n: 2.2, uv: 0, ao: .82 },
              { y: 0, rx: lacR * 1.05, rz: lacR * 1.05, n: 2.2, uv: .5, ao: 1 },
              { y: bW * 0.46, rx: lacR, rz: lacR, n: 2.2, uv: 1, ao: .82 }
            ], Q.tiny, subReg(REG.web, .6, .1, .3, .8), C.web, footMask,
              { capStart: true, capEnd: true, tone: 1.35, name: 'lace' });
          }
        }
      }
    }

    /* ---- neck + gaiter -------------------------------------------------- */
    addLoft(pile, M(tpl, 'neck'), [
      { y: -0.018 * h, rx: sp.neckR * 1.02, rz: sp.neckR * 1.14, n: 2.5, uv: 0, ao: .55 },
      { y: 0.020 * h, rx: sp.neckR * 0.94, rz: sp.neckR * 1.04, n: 2.5, uv: .4, ao: .68 },
      { y: 0.062 * h, rx: sp.neckR * 0.92, rz: sp.neckR * 1.00, n: 2.5, uv: 1, ao: .84 }
    ], Q.lim, subReg(skinR, .2, .2, .6, .6), C[sp.skinReg], mNeck, { sss: .35, name: 'neck' });
    /* EVERY kind wears fabric over the neck. A bare skin cylinder between a
       covered face and a buttoned collar was the loudest doll-joint on the
       whole figure -- in level light it renders as a glowing pink band at any
       distance. The ASSAULTER's balaclava rolls down into the collar (same
       knit, same colour, so mask and neck read as ONE garment); the BREACHER
       and the MARKSMAN wear an issued gaiter in their own uniform colour; the
       RIFLEMAN keeps his knit gaiter, pulled up to the jaw so no band of skin
       is left between it and the shemagh. */
    var gaiR = subReg(REG.knit, 0, 0, .7, .7), gaiC = C.knit;
    if (kind === 'pig') { gaiR = subReg(REG.knit, .15, .15, .7, .7); gaiC = C.cloth; }
    else if (kind === 'octa') { gaiR = subReg(REG.knit, .1, .2, .7, .7); gaiC = C.scrim || C.cloth; }
    addLoft(pile, M(tpl, 'neck'), [
      { y: -0.020 * h, rx: sp.neckR * 1.20, rz: sp.neckR * 1.30, n: 2.6, uv: 0, ao: .58 },
      { y: 0.014 * h, rx: sp.neckR * 1.13, rz: sp.neckR * 1.22, n: 2.6, uv: .5, ao: .70 },
      /* top station OVER the top of the skin loft (0.062h) -- one station
         short of it left a 5 mm ring of bare skin sticking out of the collar */
      { y: 0.068 * h, rx: sp.neckR * 1.04, rz: sp.neckR * 1.10, n: 2.6, uv: 1, ao: .84 }
    ], Q.lim, gaiR, gaiC, mNeck, { name: 'gaiter' });

    /* ---- head ---------------------------------------------------------- */
    buildHead(kind, pile, tpl, q, Q, mHead);

    /* ---- tail (enforcer) ----------------------------------------------- */
    if (sp.tail) {
      for (var t = 0; t < sp.tail; t++) {
        var tn = 'tail' + t, len = (t === 0 ? 0.100 : 0.096) * h;
        var r0 = (0.032 - t * 0.0072) * h, r1 = (0.032 - (t + 1) * 0.0072) * h;
        addLoft(pile, M(tpl, tn),
          limbSections(len, r0, Math.max(0.002 * h, r1), 0.05, 0.4, q === 0 ? 4 : 3),
          Q.lim, subReg(skinR, .3, .3, .6, .6), C[sp.skinReg],
          [ix[tn], t > 0 ? ix['tail' + (t - 1)] : ix.hips, t < sp.tail - 1 ? ix['tail' + (t + 1)] : ix[tn]],
          { capStart: t === 0, capEnd: t === sp.tail - 1, name: 'tail' });
      }
    }

    /* ---- load-bearing gear --------------------------------------------- */
    addGear(kind, pile, tpl, q, Q, {
      chest: mChest, belt: mBelt, clavL: mClavL, clavR: mClavR,
      legL: mLegL, legR: mLegR, torso: mTorso
    });

    /* ---- weapon (bound 100% to the weapon bone) ------------------------ */
    buildWeapon(kind, pile, M(tpl, 'weapon'), q, Q, mGun, C, sp);

    return pile;
  }

  /* -------------------------------------------------------------- gear --- */
  function addGear(kind, pile, tpl, q, Q, mk) {
    var sp = SPEC[kind], C = sp.col, h = sp.H, ix = tpl.spec.idx;
    var chestM = M(tpl, 'chest'), hipsM = M(tpl, 'hips'), spine2M = M(tpl, 'spine2');
    var front = sp.chestD * 0.94, back = -sp.chestD * 0.94;
    /* ROLE LOADOUTS. The four operators have to be tellable apart from their
       OUTLINE alone at 25 m, before any texture resolves -- that is what CS2
       gets right and what a single shared kit set cannot do. So the carrier,
       the pouches, the back and the leg kit are all role-gated. */
    var role = sp.gear;                          /* light|breacher|assault|marksman */
    var breach = role === 'breacher';
    var light = role === 'light';
    var marks = role === 'marksman';
    var plated = !light;                         /* hard armour front and back */

    /* --- plate carrier ---------------------------------------------------
       The old carrier was NARROWER than the torso (chestW*0.82) and stood off
       it by 0.014h -- about 2cm at world scale. From the front that is a flat
       panel the same colour as the shirt behind it and it contributes nothing
       to the outline; a plate carrier is the single most recognisable thing on
       a modern soldier and it has to be the widest part of the chest. Now it
       is wider than the ribs, twice as thick, and stands proud enough that the
       baked AO writes a real shadow line where it meets the uniform. */
    /* The RIFLEMAN wears a chest rig -- webbing only, no hard plate -- so his
       torso is visibly slimmer and softer than the other three. Everyone else
       gets a real carrier: a plate is a slab, and its hard flat face catching
       the key is most of what makes an operator read as armoured. */
    /* CARRIER VOLUME IS THE ROSTER DIFFERENCE. Round 4's four carriers were
       within 6% of each other in every dimension, so an ASSAULTER and a
       MARKSMAN differed only in headgear, colour and garnish. The MARKSMAN
       runs a slick low-profile plate (thin, short, narrow) over a 7% leaner
       chest; the BREACHER runs a full ESAPI cut with side armour. Measured
       across the chest at 3.5 u/m that is 478 mm on the BREACHER against
       352 on the MARKSMAN -- a difference you can name in a blacked-out
       silhouette, which is the CS2 test. */
    var marks = role === 'marksman';
    var pcT = plated ? (marks ? 0.019 : 0.028) * h : 0.012 * h;
    var pcH = breach ? 0.222 * h : marks ? 0.168 * h : plated ? 0.196 * h : 0.150 * h;
    var pcW = sp.chestW * (breach ? 1.16 : light ? 0.94 : marks ? 0.90 : 1.12);
    /* THE PLATE IS NOT A BOARD. A box gives a rectangle with four square
       corners standing off the ribs -- which is exactly what "front and back
       read as boards strapped on" means. A real SAPI/ESAPI plate has a
       shooter's cut: the upper corners are clipped away for the arms, the
       waist narrows below the ribs, and the whole panel is CURVED to the
       chest so the centreline stands proud and the edges lie down on the
       body. The loft ring does that for free: rx is the outline, rz is the
       curvature, and rz -> 0 at the outline extremes, so the plate's edge
       is a chamfered feather rather than a 90 degree cut. */
    function plateShell(zc, sgnZ, nm) {
      addLoft(pile, xf(chestM, [0, -0.030 * h, zc]), [
        /* bottom edge, waist-narrowed */
        { y: -pcH * 0.50, rx: pcW * 0.80, rz: pcT * 0.34, n: 3.2, uv: 0.02, ao: .72 },
        { y: -pcH * 0.42, rx: pcW * 0.90, rz: pcT * 0.86, n: 3.6, uv: 0.10, ao: .84 },
        { y: -pcH * 0.16, rx: pcW * 1.00, rz: pcT * 1.00, n: 3.8, uv: 0.34 },
        { y: pcH * 0.14, rx: pcW * 1.00, rz: pcT * 1.00, n: 3.8, uv: 0.62 },
        /* the shooter's cut: the shoulders come in hard above the sternum */
        { y: pcH * 0.34, rx: pcW * 0.88, rz: pcT * 0.92, n: 3.6, uv: 0.80, ao: .96 },
        { y: pcH * 0.46, rx: pcW * 0.66, rz: pcT * 0.70, n: 3.2, uv: 0.93, ao: .90 },
        { y: pcH * 0.50, rx: pcW * 0.56, rz: pcT * 0.30, n: 2.9, uv: 1, ao: .74 }
      ], Q.big, subReg(REG.nylon, 0, 0, 1, 1), C.nylon, mk.chest,
        { capStart: true, capEnd: true, wear: .5, wearFreq: 1.3, name: nm });
      /* MOLLE. Four rows of 25 mm tape across the face, each row proud of the
         panel by its own thickness -- so the carrier throws four horizontal
         shadows instead of being one lit plane. This is the single biggest
         thing separating a plate carrier from a painted rectangle at 8 m. */
      if (Q.detail) for (var mr = 0; mr < 4; mr++) {
        addBox(pile, xf(chestM,
          [0, -0.030 * h + (mr - 1.5) * 0.030 * h, zc + sgnZ * (pcT * 0.92)]),
          pcW * (0.90 - mr * 0.040), 19 * 0.001 * sp.mpm, 3.0 * 0.001 * sp.mpm, 3,
          subReg(REG.nylon, .1, .1, .8, .25), C.nylon, mk.chest,
          { cham: 0.42, tone: 0.94, name: 'molle' });
      }
    }
    plateShell(front + pcT, 1, 'plate-f');
    if (plated) plateShell(back - pcT, -1, 'plate-b');
    if (plated && Q.detail) {
      /* drag handle, the loop of webbing across the top of the back plate */
      addBox(pile, xf(chestM, [0, -0.030 * h + pcH * 0.40, back - pcT * 2.0], [0.30, 0, 0]),
        pcW * 0.40, 0.020 * h, 0.012 * h, 3,
        subReg(REG.web, .4, .1, .5, .5), C.web, mk.chest,
        { cham: 0.40, tone: 0.84, name: 'draghandle' });
    }
    /* BREACHER only: a shoulder yoke and a groin flap. Both stand off the
       body, both break the outline, and together they are what turns a man in
       a vest into a man in armour. */
    if (breach) {
      /* THE PAULDRON, WRAPPED. Same story as the shoulder pad: a 124 x 157 x
         265 mm chamfered BOX standing on the clavicle reads as a card taped
         to the shoulder, because a box facing the key has one flat face
         facing the key. A hard shoulder shell is a segment of a cylinder
         about the arm -- so it is lofted about the arm, over the soft pad,
         14 mm proud of it, and it shades continuously from the crown down
         to the terminator like the armour it is. */
      var plM = 0.001 * sp.mpm;
      var plc = function (ymm, wmm, dmm, nn, uv, ao) {
        return { y: ymm * plM, rx: wmm * 0.5 * plM, rz: dmm * 0.5 * plM,
          n: nn, uv: uv, ao: ao === undefined ? 1 : ao };
      };
      for (var yk = -1; yk <= 1; yk += 2) {
        addLoft(pile, xf(M(tpl, yk > 0 ? 'armR' : 'armL'),
          [0, 0.006 * h, -6 * plM], [0.12, 0, 0]), [
          plc(54, 118, 126, 3.2, 0, .66),
          plc(28, 166, 174, 3.0, .20, .88),
          plc(-34, 176, 182, 2.9, .58, 1),
          plc(-92, 166, 170, 3.0, .86, .88),
          plc(-124, 132, 138, 3.2, 1, .72)
        ], Q.lim, subReg(REG.plastic, .3, .2, .5, .6), C.plastic,
          yk > 0 ? mk.clavR : mk.clavL,
          { capStart: true, capEnd: true, tone: 0.92, wear: .5, wearFreq: 2.2,
            name: 'pauldron' });
      }
      addBox(pile, xf(hipsM, [0, -0.052 * h, sp.hipD * 1.02], [0.16, 0, 0]),
        sp.waistW * 0.52, 0.070 * h, 0.014 * h, Q.cham,
        subReg(REG.nylon, .2, .4, .5, .5), C.nylon, mk.belt,
        { cham: 0.26, tone: 0.94, name: 'groinflap' });
    }
    /* the carrier's side wall, joining front to back over the ribs: without it
       the two plates read as two floating boards from any three-quarter angle */
    /* THIS was the "large cream board on the shoulder". Measured off the
       build: a chamfered BOX 66 mm thick, 274 mm tall and 250 mm deep, hung
       at x = chestW*1.00 = 169 mm -- i.e. standing 202 mm off the midline
       when the deltoid is at 183, so it projected PAST the arm and presented
       a flat 274 x 250 mm face to the key, in C.nylon, which is the highest-
       reflectance material on three of the four operators. A brightest-pixel
       readback put it at sRGB 182/255 against a 119 grey card.
       It is now a lofted side wall: 40 mm thick, tucked inboard of the
       deltoid, tapered top and bottom so it dies into the cummerbund, and
       toned to 0.72 so the plate bag reads as one object rather than as a
       pale board bolted to a dark one. */
    if (plated) for (var ps = -1; ps <= 1; ps += 2) {
      var psW = (breach ? 0.0135 : 0.011) * h;
      addLoft(pile, xf(chestM, [ps * sp.chestW * (breach ? 0.94 : 0.90), -0.034 * h, 0]), [
        { y: -0.076 * h, rx: psW * 0.66, rz: sp.chestD * 0.58, n: 3.2, uv: 0, ao: .58 },
        { y: -0.048 * h, rx: psW * 0.94, rz: sp.chestD * 0.86, n: 3.4, uv: .24, ao: .76 },
        { y: 0.008 * h, rx: psW, rz: sp.chestD * 0.95, n: 3.4, uv: .62, ao: .82 },
        { y: 0.050 * h, rx: psW * 0.86, rz: sp.chestD * 0.80, n: 3.4, uv: .88, ao: .70 },
        { y: 0.070 * h, rx: psW * 0.50, rz: sp.chestD * 0.52, n: 3.2, uv: 1, ao: .56 }
      ], Q.big, subReg(REG.web, .1, .35, .5, .5), C.web, mk.chest,
        { capStart: true, capEnd: true, tone: 0.92, wear: .45, wearFreq: 1.8,
          name: 'plate-side' });
    }
    /* THE CUMMERBUND. It is what makes a vest read as WORN rather than hung:
       a 110 mm belt of laminate that wraps the floating ribs, tucks UNDER the
       skirt of the front plate, and closes with a flap on the wearer's left.
       It sits higher and tighter than round 3's, and it is a distinct value
       from the plate so the two do not merge into one slab. */
    addLoft(pile, xf(chestM, [0, -0.104 * h, 0]), [
      { y: -0.030 * h, rx: sp.chestW * 0.94, rz: sp.chestD * 1.02, n: 3.5, uv: 0, ao: .70 },
      { y: -0.012 * h, rx: sp.chestW * 0.99, rz: sp.chestD * 1.10, n: 3.6, uv: .30, ao: .90 },
      { y: 0.014 * h, rx: sp.chestW * 1.00, rz: sp.chestD * 1.11, n: 3.6, uv: .70 },
      { y: 0.034 * h, rx: sp.chestW * 0.95, rz: sp.chestD * 1.04, n: 3.5, uv: 1, ao: .74 }
    ], Q.big, subReg(REG.nylon, .2, .2, .6, .6), C.nylon, mk.chest,
      { wear: .5, wearFreq: 1.6, tone: 0.90, name: 'cummerbund' });
    if (Q.detail) {
      /* the closure flap, proud on the wearer's left rib */
      addBox(pile, xf(chestM, [-sp.chestW * 0.86, -0.104 * h, sp.chestD * 0.42], [0, -0.55, 0]),
        0.030 * h, 0.052 * h, 0.008 * h, 3,
        subReg(REG.nylon, .55, .45, .4, .4), C.nylon, mk.chest,
        { cham: 0.34, tone: 1.06, name: 'cummerflap' });
    }

    /* THE SHOULDER YOKE, CONTINUOUS.
       Round 3 put a straight chamfered box across each clavicle: two bars
       lying on the traps with no connection to either plate, which is why the
       carrier read as "boards strapped on" -- there was nothing doing the
       strapping. A carrier's yoke is ONE piece of laminate per side: it
       starts on the face of the front plate, climbs the pectoral, lies over
       the trapezius, and comes down the scapula onto the back plate. Swept,
       so it follows the body instead of bridging it, and the width vector is
       re-orthogonalised at every station exactly as the sling is. */
    for (var s = 0; s < 2; s++) {
      var sg = s ? 1 : -1, N = s ? 'R' : 'L';
      var yw = 46 * 0.001 * sp.mpm, yt = 7.0 * 0.001 * sp.mpm;
      var yRaw = [
        [sg * pcW * 0.50, -0.030 * h + pcH * 0.30, front + pcT * 1.7],
        [sg * pcW * 0.52, -0.030 * h + pcH * 0.52, front + pcT * 1.2],
        /* SIT DOWN ONTO THE TRAPEZIUS. The top station was 128 mm above the
           chest bone -- 20 mm clear of the muscle it is supposed to be lying
           on, so the yoke floated and its shadow never touched the body. */
        [sg * sp.chestW * 0.62, 0.048 * h, sp.chestD * 0.40],
        [sg * sp.chestW * 0.60, 0.062 * h, -sp.chestD * 0.10],
        [sg * sp.chestW * 0.56, 0.026 * h, -sp.chestD * 0.72],
        [sg * pcW * 0.52, -0.030 * h + pcH * 0.46, back - pcT * 1.2],
        [sg * pcW * 0.50, -0.030 * h + pcH * 0.22, back - pcT * 1.7]
      ];
      if (!plated) yRaw = yRaw.slice(0, 5).concat([[sg * sp.chestW * 0.50, -0.020 * h, -sp.chestD * 1.00]]);
      var yP = [], yi;
      for (yi = 0; yi < yRaw.length; yi++) {
        var qa = yRaw[Math.max(0, yi - 1)], qb = yRaw[Math.min(yRaw.length - 1, yi + 1)];
        var ux = qb[0] - qa[0], uy = qb[1] - qa[1], uz = qb[2] - qa[2];
        var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        /* outward from the trunk axis, then made perpendicular to the path */
        var vx = yRaw[yi][0], vy = 0, vz = yRaw[yi][2];
        var vl = Math.sqrt(vx * vx + vz * vz) || 1; vx /= vl; vz /= vl;
        /* over the top of the shoulder the outward direction IS up */
        var lift = clamp((yRaw[yi][1] - 0.010 * h) / (0.050 * h), 0, 1);
        vx *= (1 - lift); vz *= (1 - lift); vy = lift;
        var dq = vx * ux + vy * uy + vz * uz;
        vx -= ux * dq; vy -= uy * dq; vz -= uz * dq;
        vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1; vx /= vl; vy /= vl; vz /= vl;
        yP.push({
          p: yRaw[yi],
          b: [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx],
          n: [vx, vy, vz],
          rw: yw * (yi === 0 || yi === yRaw.length - 1 ? 0.86 : yi >= 2 && yi <= 4 ? 1.18 : 1),
          r: yt * (yi >= 2 && yi <= 4 ? 1.6 : 1),   /* padded over the trap */
          /* e drops over the trapezius: a 3.6 superellipse is a flat plank
             with a corner radius, a 2.6 is a rounded lens -- and the yoke
             is a padded lens exactly where it crosses the shoulder */
          e: yi >= 2 && yi <= 4 ? 2.6 : 3.6,
          uv: yi / (yRaw.length - 1), ao: yi >= 2 && yi <= 4 ? .96 : .82
        });
      }
      addSweep(pile, chestM, yP, Q.cham, subReg(REG.web, 0, 0, .8, .8),
        C.web, s ? mk.clavR : mk.clavL,
        { capStart: true, capEnd: true, wear: .4, wearFreq: 2.0, name: 'yoke' });
      if (Q.detail) {
        /* THE SHOULDER PAD, WRAPPED.
           What was here was a 162 x 102 mm chamfered BOX standing on the
           clavicle -- and on the calibrated stage it read as exactly that:
           a pale rectangular board on each shoulder, flat-shaded because a
           box facing the key has one flat face facing the key. A carrier's
           shoulder pad is a padded SLEEVE over the deltoid: it follows the
           arm's own axis, stands about 11 mm proud of a 122 mm upper arm,
           tucks under the yoke at the top and stops above the biceps. Being
           a surface of revolution about the arm it shades continuously from
           the top light down to the terminator, which is the entire
           difference between "cardboard" and "webbing over a shoulder".
           Only the two PLATED operators wear them; the RIFLEMAN's chest rig
           and the MARKSMAN's low-vis harness have bare shoulders, which is
           one more line in the silhouette between the four. */
        if (plated && !marks) {
          var pdM = 0.001 * sp.mpm;
          var pdc = function (ymm, wmm, dmm, nn, uv, ao) {
            return { y: ymm * pdM, rx: wmm * 0.5 * pdM, rz: dmm * 0.5 * pdM,
              n: nn, uv: uv, ao: ao === undefined ? 1 : ao };
          };
          /* IN WEBBING, NOT IN PLATE-BAG LAMINATE. Measured off the build,
             the pad in C.nylon came out at a 0.182 vertex tint against 0.091
             for the sleeve under it and 0.082 for the trapezius beside it --
             twice the reflectance of everything it touches, on the surface
             most square-on to the key. That is how a correctly-shaped pad
             still reads as a pale board. Real carriers pair a coyote plate
             bag with ranger-green shoulder webbing; C.web is 0.098, which
             puts the pad in the same value band as the shoulder it sits on
             and lets its SHAPE do the work instead of its brightness. */
          addLoft(pile, xf(M(tpl, 'arm' + N), [0, 0.004 * h, -2 * pdM], [0.10, 0, 0]), [
            pdc(46, 100, 108, 3.0, 0, .70),
            pdc(22, 132, 140, 2.8, .22, .90),
            pdc(-28, 138, 146, 2.7, .58, 1),
            pdc(-76, 130, 137, 2.8, .86, .90),
            pdc(-102, 112, 118, 3.0, 1, .76)
          ], Q.lim, subReg(REG.web, .05, .35, .5, .5), C.web,
            s ? mk.clavR : mk.clavL,
            { capStart: true, capEnd: true, tone: 0.98, wear: .45, wearFreq: 2.4,
              name: 'shoulderpad' });
        }
        addBox(pile, xf(chestM, [sg * pcW * 0.50, -0.030 * h + pcH * 0.38, front + pcT * 2.3]),
          0.011 * h, 0.016 * h, 0.006 * h, 3,
          subReg(REG.trim, .1, .1, .5, .5), C.painted, mk.chest,
          { cham: 0.40, tone: 0.86, name: 'yokebuckle' });
      }
    }
    /* rifle sling: one hard diagonal from the right shoulder across to the left
       hip. A single strong line across the chest is worth more to the read at
       8m than any amount of pouch detail, and it is what stops the torso from
       being a plain rectangle. */
    {
      /* Round 2 made this a chamfered BOX rotated 41 deg: a rigid rod longer
         than the rifle, standing 4 cm off the chest, with a square paddle at
         each end. A sling is a 38 mm flat tape that LIES ON THE BODY -- it
         goes over the trapezius, follows the curve of the plate, and
         disappears at the hip. So it is swept: the width vector is
         re-orthogonalised against the torso surface normal at every station,
         which is what makes a strap read as a strap and not as a stick. */
      var slW = 19 * 0.001 * sp.mpm, slT = 2.4 * 0.001 * sp.mpm;
      var raw = [
        [sp.chestW * 0.50, 0.046 * h, -sp.chestD * 0.30],
        [sp.chestW * 0.56, 0.030 * h, sp.chestD * 0.34],
        [sp.chestW * 0.44, -0.014 * h, front + 0.030 * h],
        [sp.chestW * 0.18, -0.058 * h, front + 0.040 * h],
        [-sp.chestW * 0.10, -0.098 * h, front + 0.036 * h],
        [-sp.chestW * 0.36, -0.134 * h, front * 0.72],
        [-sp.chestW * 0.50, -0.156 * h, front * 0.16]
      ];
      var slP = [], sli;
      for (sli = 0; sli < raw.length; sli++) {
        var pa = raw[Math.max(0, sli - 1)], pb = raw[Math.min(raw.length - 1, sli + 1)];
        var tx = pb[0] - pa[0], ty = pb[1] - pa[1], tz = pb[2] - pa[2];
        var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        /* outward from the torso axis, then made perpendicular to the path */
        var nx = raw[sli][0], ny = 0, nz = raw[sli][2] + 0.02 * h;
        var nl = Math.sqrt(nx * nx + nz * nz) || 1; nx /= nl; nz /= nl;
        var dp = nx * tx + ny * ty + nz * tz;
        nx -= tx * dp; ny -= ty * dp; nz -= tz * dp;
        nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        slP.push({
          p: raw[sli],
          b: [ty * nz - tz * ny, tz * nx - tx * nz, tx * ny - ty * nx],
          n: [nx, ny, nz], rw: slW, r: slT, e: 3.4,
          uv: sli / (raw.length - 1), ao: .80
        });
      }
      addSweep(pile, chestM, slP, Q.cham, subReg(REG.web, .3, 0, .35, 1),
        C.web, mk.chest, { capStart: true, capEnd: true, name: 'sling' });
      /* the tri-glide slider, the one hard object on a soft strap */
      addBox(pile, xf(chestM, [sp.chestW * 0.30, -0.036 * h, front + 0.040 * h], [0, 0, 0.86]),
        slW * 1.35, 11 * 0.001 * sp.mpm, slT * 2.2, Q.cham,
        subReg(REG.trim, .1, .1, .5, .5), C.trim, mk.chest,
        { cham: 0.40, name: 'slingslide' });
    }

    /* --- front pouches ---------------------------------------------------
       Depth was 0.014h of half-extent -- a 4cm-thick mag pouch. A 5.56 double
       mag pouch is ~9cm deep and it is the DEPTH, not the face, that catches
       the key and throws the shadow that makes it readable in profile. */
    var pz = front + (plated ? 0.052 : 0.038) * h;
    if (breach) {
      /* shell bandolier: a row of loops across the chest */
      for (var b = 0; b < 6; b++) {
        addLoft(pile, xf(chestM, [(b - 2.5) * 0.028 * h, -0.052 * h, pz - 0.008 * h]), [
          { y: -0.024 * h, rx: 0.011 * h, rz: 0.011 * h, n: 2.4, uv: 0, ao: .8 },
          { y: 0.024 * h, rx: 0.011 * h, rz: 0.011 * h, n: 2.4, uv: 1, ao: .9 }
        ], Q.tiny, subReg(REG.steel, .2, .2, .5, .5), C.steel, mk.chest,
          { capStart: true, capEnd: true, name: 'shell' });
      }
      addBox(pile, xf(chestM, [0, -0.052 * h, pz - 0.016 * h]),
        sp.chestW * 0.70, 0.062 * h, 0.008 * h, Q.cham,
        subReg(REG.web, .1, .1, .7, .7), C.web, mk.chest, { cham: 0.3, name: 'bandolier' });
    } else {
      for (var p = -1; p <= 1; p++) {
        addBox(pile, xf(chestM, [p * 0.056 * h, -0.066 * h, pz], [0, p * 0.10, 0]),
          0.026 * h, 0.092 * h, 0.026 * h, Q.cham,
          subReg(REG.nylon, .3, .1, .4, .5), C.nylon, mk.chest,
          { cham: 0.22, tone: 1.05, wear: .5, wearFreq: 2.4, name: 'magpouch' });
        /* flap, tilted so it catches the key differently from the body */
        addBox(pile, xf(chestM, [p * 0.056 * h, -0.018 * h, pz + 0.006 * h], [0.26, p * 0.10, 0]),
          0.028 * h, 0.036 * h, 0.028 * h, Q.cham,
          subReg(REG.nylon, .5, .4, .4, .4), C.nylon, mk.chest,
          { cham: 0.26, tone: 0.80, name: 'magflap' });
        /* the mag itself, showing above the pouch lip: a hard dark accent that
           reads even when everything else has mipped to mush */
        if (Q.detail) {
          addBox(pile, xf(chestM, [p * 0.056 * h, -0.010 * h, pz - 0.004 * h], [0.05, p * 0.10, 0]),
            0.020 * h, 0.030 * h, 0.014 * h, 3,
            subReg(REG.plastic, .6, .1, .3, .5), C.plastic, mk.chest,
            { cham: 0.24, tone: 0.72, name: 'mag' });
        }
      }
    }
    /* admin pouch (left) + radio (right) + antenna */
    addBox(pile, xf(chestM, [-0.062 * h, 0.010 * h, pz - 0.014 * h], [0, -0.16, 0]),
      0.034 * h, 0.056 * h, 0.020 * h, Q.cham,
      subReg(REG.nylon, .1, .5, .4, .4), C.nylon, mk.chest,
      { cham: 0.24, tone: 1.12, name: 'admin' });
    addBox(pile, xf(chestM, [0.062 * h, 0.004 * h, pz - 0.010 * h], [0, 0.16, 0]),
      0.022 * h, 0.066 * h, 0.022 * h, Q.cham,
      subReg(REG.plastic, .2, .2, .5, .5), C.plastic, mk.chest,
      { cham: 0.20, tone: 0.78, name: 'radio' });
    if (Q.detail) {
      addLoft(pile, xf(chestM, [0.058 * h, 0.030 * h, pz - 0.004 * h], [-0.18, 0, -0.10]), [
        { y: 0, rx: 0.0032 * h, rz: 0.0032 * h, n: 2, uv: 0 },
        { y: 0.070 * h, rx: 0.0022 * h, rz: 0.0022 * h, n: 2, uv: 1 }
      ], 4, subReg(REG.rubber, .3, .3, .3, .3), C.rubber, mk.chest,
        { capStart: true, capEnd: true, name: 'antenna' });
    }

    /* --- back: pack or ammo drum ---------------------------------------- */
    addBox(pile, xf(spine2M, [0, 0.030 * h, back - (breach ? 0.074 : 0.062) * h]),
      sp.chestW * (breach ? 0.80 : marks ? 0.58 : 0.66),
      (breach ? 0.210 : marks ? 0.150 : 0.170) * h, (breach ? 0.054 : 0.042) * h, Q.cham,
      subReg(REG.nylon, .4, .4, .55, .55), C.nylon, mk.chest,
      { cham: 0.20, tone: 1.04, wear: .5, wearFreq: 1.6, name: 'pack' });
    if (Q.detail) {
      /* compression straps across the pack: two dark horizontals */
      for (var cs = 0; cs < 2; cs++) {
        addBox(pile, xf(spine2M, [0, (0.070 - cs * 0.070) * h, back - (breach ? 0.132 : 0.106) * h]),
          sp.chestW * (breach ? 0.82 : marks ? 0.60 : 0.68), 0.012 * h, 0.008 * h, 3,
          subReg(REG.web, .2, .2, .6, .3), C.web, mk.chest,
          { cham: 0.35, tone: 0.92, name: 'packstrap' });
      }
    }
    if (breach && Q.detail) {
      /* breaching bar slung diagonally across the pack: the one silhouette
         element that says "this is the man who opens the door" */
      addBox(pile, xf(spine2M, [0.010 * h, 0.020 * h, back - 0.136 * h], [0, 0, 0.62]),
        0.013 * h, 0.290 * h, 0.013 * h, Q.cham,
        subReg(REG.steel, .1, .1, .7, .7), C.gunwear, mk.chest,
        { cham: 0.30, tone: 0.90, wear: .6, wearFreq: 3.0, name: 'prybar' });
      addBox(pile, xf(spine2M, [-0.072 * h, -0.062 * h, back - 0.140 * h], [0, 0, 0.62]),
        0.020 * h, 0.044 * h, 0.010 * h, 3,
        subReg(REG.steel, .5, .5, .4, .4), C.gunwear, mk.chest,
        { cham: 0.40, tone: 1.10, name: 'prytip' });
    }
    if (marks && Q.detail) {
      /* MARKSMAN: a rolled shooting mat lashed under the pack, and a spotting
         scope in a pouch on the left. Soft, irregular, low-vis. */
      addLoft(pile, xf(spine2M, [0, -0.060 * h, back - 0.086 * h], [0, 0, PI / 2]), [
        { y: -sp.chestW * 0.62, rx: 0.028 * h, rz: 0.026 * h, n: 2.6, uv: 0, ao: .74 },
        { y: 0, rx: 0.032 * h, rz: 0.030 * h, n: 2.6, uv: .5, ao: .86 },
        { y: sp.chestW * 0.62, rx: 0.028 * h, rz: 0.026 * h, n: 2.6, uv: 1, ao: .74 }
      ], Q.lim, subReg(REG.cloth, .3, .3, .6, .6), C.cloth, mk.chest,
        { capStart: true, capEnd: true, wear: .7, wearFreq: 2.2, name: 'matroll' });
      addBox(pile, xf(chestM, [-0.070 * h, -0.078 * h, pz - 0.016 * h], [0, -0.22, 0]),
        0.024 * h, 0.070 * h, 0.024 * h, Q.cham,
        subReg(REG.nylon, .6, .5, .35, .4), C.nylon, mk.chest,
        { cham: 0.24, tone: 1.06, wear: .55, wearFreq: 2.4, name: 'scopepouch' });
      /* GARNISH. The head wrap alone left the MARKSMAN reading as a green
         ASSAULTER from the neck down. A veil is a whole-body treatment: a
         yoke of hessian tags over both shoulders and down the pack, cut long
         and hung at irregular angles so the OUTLINE is broken -- which is the
         entire function of the thing and the one silhouette difference that
         cannot be confused with anybody else in the roster. */
      for (var gt = 0; gt < 11; gt++) {
        var ga = -2.55 + gt * 0.51;                  /* round the shoulders   */
        var gr = 1 - Math.abs(gt - 5) * 0.045;
        addBox(pile, xf(chestM, [
          Math.sin(ga) * sp.chestW * 1.02,
          0.036 * h - (gt % 3) * 0.010 * h,
          Math.cos(ga) * sp.chestD * 1.14
        ], [0.28 + (gt % 4) * 0.09, ga, (gt % 2 ? 0.26 : -0.30)]),
          0.013 * h, (0.062 + (gt % 3) * 0.022) * h, 0.0026 * h, 3,
          subReg(REG.scrim, (gt % 3) * .3, (gt % 2) * .4, .35, .5), C.scrim, mk.chest,
          { cham: 0.42, tone: 0.84 + (gt % 4) * 0.09, wear: .7, wearFreq: 3.4,
            name: 'garnish' });
      }
    }

    /* --- belt + dump pouches + holster -----------------------------------
       The belt is now a real band standing clear of the trousers: it is the
       one horizontal that separates the top block from the leg block, and at
       0.015 albedo against 0.058 cloth it is the darkest line on the figure. */
    addLoft(pile, xf(hipsM, [0, 0.012 * h, 0]), [
      { y: -0.026 * h, rx: sp.waistW * 1.06, rz: sp.hipD * 1.05, n: 3.6, uv: 0, ao: .70 },
      { y: -0.008 * h, rx: sp.waistW * 1.13, rz: sp.hipD * 1.12, n: 3.6, uv: .35 },
      { y: 0.012 * h, rx: sp.waistW * 1.13, rz: sp.hipD * 1.12, n: 3.6, uv: .70 },
      { y: 0.028 * h, rx: sp.waistW * 1.06, rz: sp.hipD * 1.05, n: 3.6, uv: 1, ao: .86 }
    ], Q.big, subReg(REG.web, .1, .1, .8, .8), C.web, mk.belt,
      { wear: .45, wearFreq: 2.0, name: 'belt' });
    /* belt buckle: a chamfered metal slab dead centre */
    addBox(pile, xf(hipsM, [0, 0.012 * h, sp.hipD * 1.10]),
      0.024 * h, 0.030 * h, 0.010 * h, 3,
      subReg(REG.steel, .1, .6, .35, .35), C.steel, mk.belt,
      { cham: 0.35, name: 'buckle' });
    for (s = 0; s < 2; s++) {
      sg = s ? 1 : -1;
      addBox(pile, xf(hipsM, [sg * sp.waistW * 0.96, -0.032 * h, -sp.hipD * 0.55], [0, sg * 0.35, 0]),
        0.030 * h, 0.072 * h, 0.030 * h, Q.cham,
        subReg(REG.nylon, .6, .2, .35, .5), C.nylon, mk.belt,
        { cham: 0.24, tone: 1.06, wear: .5, wearFreq: 2.6, name: 'dump' });
    }
    /* Thigh holster on the strong side. The BREACHER and the ASSAULTER carry
       a sidearm; the rifleman and the marksman do not, and their thighs stay
       clean -- another outline difference that costs nothing. */
    var thighR = M(tpl, 'thighR');
    if (breach || role === 'assault') {
    addBox(pile, xf(thighR, [sp.limbR * 0.96, -sp.thigh * 0.34, 0.010 * h], [0.10, 0, 0.10]),
      0.030 * h, 0.100 * h, 0.030 * h, Q.cham,
      subReg(REG.nylon, .2, .6, .4, .35), C.nylon, mk.legR,
      { cham: 0.22, tone: 1.04, name: 'holster' });
    if (Q.detail) {
      /* pistol grip poking out of the holster mouth */
      addBox(pile, xf(thighR, [sp.limbR * 0.96, -sp.thigh * 0.20, 0.014 * h], [0.28, 0, 0.10]),
        0.016 * h, 0.040 * h, 0.020 * h, 3,
        subReg(REG.plastic, .1, .7, .3, .3), C.plastic, mk.legR,
        { cham: 0.30, tone: 0.72, name: 'pistolgrip' });
    }
    if (Q.detail) {
      addLoft(pile, xf(thighR, [0, -sp.thigh * 0.52, 0]), [
        { y: -0.006 * h, rx: sp.limbR * 1.03, rz: sp.limbR * 1.03, n: 2.4, uv: 0, ao: .8 },
        { y: 0.006 * h, rx: sp.limbR * 1.03, rz: sp.limbR * 1.03, n: 2.4, uv: 1, ao: .9 }
      ], Q.lim, subReg(REG.web, .4, .4, .4, .4), C.web, mk.legR, { name: 'legstrap' });
    }
    }
    /* No lights on the chest. A glowing bar on a plate carrier is a game
       prop; what a real carrier has there is a strip of loop field with a
       blood-type patch on it, which is a VALUE change, not a light. */
    addBox(pile, xf(chestM, [-0.058 * h, -0.086 * h, pz - 0.002 * h]),
      0.020 * h, 0.012 * h, 0.004 * h, 3,
      subReg(REG.web, .7, .1, .25, .8), C.trim, mk.chest,
      { cham: 0.4, tone: 1.25, name: 'patch' });
  }

  /* --------------------------------------------------------------- head -- */
  /* --------------------------------------------------------------- head --
     One human skull for all four operators; the ROLE supplies the headgear.
     Landmarks are anthropometric: head height 0.23 m (0.130 H), head width
     0.155 m, the brow at 0.62 of head height, the ear canal level with the
     brow and slightly behind the mid-line. A head that is even 10% too big
     is the single fastest way to make a figure read as a toy, so nothing
     here is a taste knob -- the skull loft is a measurement.
     -------------------------------------------------------------------- */
  function buildHead(kind, pile, tpl, q, Q, mHead) {
    /* EVERY head landmark is written as a fraction of `h`, so scaling `h`
       here -- and only here -- resizes the skull, the face, the ears and the
       headgear together about the head bone, which is the top of the neck and
       must not move. See makeBiped/headK: probed against the section-2 table
       the four heads were 5-9% oversize, and an oversize head is the fastest
       way to make a figure read as a toy. */
    var sp = SPEC[kind], C = sp.col, h = sp.H * (sp.headK || 1);
    var skinR = REG[sp.skinReg];
    var hm = M(tpl, 'head');
    var hw = sp.headW, hd = sp.headD;
    var S = Q.big, T = Q.tiny;
    var style = sp.head || 'balaclava';
    var uniR = sp.camo ? REG.camo : REG.cloth, uniC = sp.camo ? C.camo : C.cloth;
    var es, i;

    /* ---- 1. the skull ------------------------------------------------- */
    addLoft(pile, hm, [
      { y: -0.058 * h, rx: 0.001, rz: 0.001, cz: 0.026 * h, n: 2, uv: 0 },
      { y: -0.052 * h, rx: hw * 0.30, rz: hd * 0.34, cz: 0.026 * h, n: 2.4, uv: .05, ao: .66 },
      { y: -0.042 * h, rx: hw * 0.62, rz: hd * 0.66, cz: 0.021 * h, n: 2.6, uv: .14, ao: .76 },
      { y: -0.028 * h, rx: hw * 0.82, rz: hd * 0.86, cz: 0.014 * h, n: 2.7, uv: .26, ao: .86 },
      { y: -0.012 * h, rx: hw * 0.95, rz: hd * 0.97, cz: 0.006 * h, n: 2.7, uv: .38, ao: .95 },
      { y: 0.004 * h, rx: hw * 1.00, rz: hd * 1.00, cz: 0.002 * h, n: 2.6, uv: .50 },
      { y: 0.022 * h, rx: hw * 1.00, rz: hd * 0.99, cz: 0.000, n: 2.5, uv: .64 },
      { y: 0.040 * h, rx: hw * 0.96, rz: hd * 0.94, cz: -0.004 * h, n: 2.5, uv: .78 },
      { y: 0.057 * h, rx: hw * 0.83, rz: hd * 0.80, cz: -0.010 * h, n: 2.4, uv: .90 },
      { y: 0.069 * h, rx: hw * 0.52, rz: hd * 0.50, cz: -0.012 * h, n: 2.3, uv: .97 },
      { y: 0.076 * h, rx: 0.001, rz: 0.001, cz: -0.012 * h, n: 2, uv: 1 }
    ], S, subReg(skinR, 0, 0, 1, 1), C.skin, mHead, { sss: .20, name: 'skull' });

    /* BROW RIDGE + NOSE. The nose was BURIED: its base sat at hd*0.62 and its
       tip solved to z = 0.056h against a maxilla whose own front surface is
       at cz + rz = 0.062h, so eleven millimetres of it were inside the skull
       and the face had, measurably, no nose at all. It now starts at the
       nasion on the skull surface and projects 21 mm past it -- which is what
       lets the scarf TENT over a nose instead of shrink-wrapping a plane. */
    addLoft(pile, xf(hm, [0, 0.000, hd * 0.76], [-1.02, 0, 0]), [
      { y: 0.014 * h, rx: 0.014 * h, rz: 0.013 * h, n: 2.6, uv: 0, ao: .95 },
      { y: -0.012 * h, rx: 0.012 * h, rz: 0.011 * h, n: 2.5, uv: .55, ao: .90 },
      { y: -0.024 * h, rx: 0.010 * h, rz: 0.009 * h, n: 2.4, uv: .84, ao: .84 },
      { y: -0.030 * h, rx: 0.006 * h, rz: 0.005 * h, n: 2.3, uv: 1, ao: .76 }
    ], Q.hand, subReg(skinR, .4, .4, .3, .3), C.skin, mHead,
      { capStart: true, sss: .22, tone: 1.06, name: 'nose' });
    if (Q.detail) {
      /* BROW RIDGE. Proud enough to occlude the socket under it -- the
         supraorbital shelf is the single strongest piece of form on a male
         face and at 0.005h of relief it was doing nothing. Now it steps out
         over the orbit and the baked cavity AO writes the shadow itself. */
      addLoft(pile, xf(hm, [0, 0.011 * h, hd * 0.62], [-0.22, 0, 0]), [
        { y: -0.008 * h, rx: hw * 0.84, rz: hd * 0.44, n: 3.0, uv: 0, ao: .56 },
        { y: 0.000, rx: hw * 0.90, rz: hd * 0.52, n: 3.0, uv: .55, ao: .98 },
        { y: 0.009 * h, rx: hw * 0.86, rz: hd * 0.46, n: 3.0, uv: 1, ao: .86 }
      ], S, subReg(skinR, .1, .55, .5, .4), C.skin, mHead,
        { capStart: true, capEnd: true, sss: .16, tone: 1.04, name: 'brow' });
      /* glabella: the flat between the brows, which is what stops the ridge
         reading as one continuous bar across the face */
      addLoft(pile, xf(hm, [0, 0.010 * h, hd * 0.66]), [
        { y: -0.005 * h, rx: hw * 0.16, rz: hd * 0.30, n: 2.6, uv: 0, ao: .74 },
        { y: 0.008 * h, rx: hw * 0.19, rz: hd * 0.34, n: 2.6, uv: 1, ao: .92 }
      ], Q.hand, subReg(skinR, .3, .55, .3, .3), C.skin, mHead,
        { capStart: true, capEnd: true, sss: .12, tone: 0.94, name: 'glabella' });
    }

    /* ears: only modelled where they are actually visible */
    if (style === 'boonie' || style === 'wrap') {
      for (es = -1; es <= 1; es += 2) {
        addLoft(pile, xf(hm, [es * hw * 0.98, 0.004 * h, -hd * 0.10], [0, es * 0.35, es * -0.10]), [
          { y: -0.020 * h, rx: 0.005 * h, rz: 0.013 * h, n: 2.2, uv: 0, ao: .7 },
          { y: 0.000, rx: 0.006 * h, rz: 0.017 * h, n: 2.2, uv: .5, ao: .82 },
          { y: 0.018 * h, rx: 0.004 * h, rz: 0.012 * h, n: 2.2, uv: 1, ao: .74 }
        ], T, subReg(skinR, .6, .6, .3, .3), C.skin, mHead,
          { capStart: true, capEnd: true, sss: .8, name: 'ear' });
      }
    }

    /* FACE STRUCTURE. Only built where skin is actually going to be seen --
       under a balaclava it is invisible geometry. A brow and a nose on an egg
       is not a face: what the eye reads at five metres is the VALUE pattern
       the structure casts -- a dark band under the brow, a lit ridge on each
       cheekbone, a shadow under it, and a jaw line with a stubble value that
       is a shade darker than the cheek. Get those four and the head reads as
       a man at the range the player fights at; model an eyeball instead and
       you have spent the polygons where nothing can see them. */
    function faceStructure() {
      /* zygomatic pads: the lit ridge, and the hollow under it. Skipped on
         the far-bake source: at 72 units a cheekbone is a sub-pixel. */
      /* THE FACE HAS TO CARRY ITSELF IN VALUE, not in outline. Rendered and
         measured on the calibrated stage, the exposed strip between the brim
         shadow and the shemagh varied by 4 code values across its whole
         width: a beige sticker. Two things were doing it.

         First, `sss` was cancelling the form. The subsurface term adds light
         in PROPORTION TO (1 - ao), so a 0.55 gain on a cheek put most of the
         brightness back exactly where the occlusion had just taken it out.
         Subsurface is real, but at 0.55 it is a form eraser; skin needs it at
         about a quarter of that.

         Second, the malar was a single lump. A cheekbone reads because of the
         HOLLOW under it, not because of the bone -- so it is now a proud
         ridge with a distinct submalar depression below it. */
      for (var fs = -1; q < 2 && fs <= 1; fs += 2) {
        addLoft(pile, xf(hm, [fs * hw * 0.60, -0.002 * h, hd * 0.48], [0.16, fs * 0.50, 0]), [
          { y: -0.014 * h, rx: 0.012 * h, rz: 0.008 * h, n: 2.6, uv: 0, ao: .70 },
          { y: 0.004 * h, rx: 0.017 * h, rz: 0.013 * h, n: 2.7, uv: .55, ao: 1.00 },
          { y: 0.017 * h, rx: 0.009 * h, rz: 0.007 * h, n: 2.5, uv: 1, ao: .78 }
        ], Q.hand, subReg(skinR, .2, .2, .35, .35), C.skin, mHead,
          { capStart: true, capEnd: true, sss: .14, tone: 1.05, name: 'cheek' });
        /* submalar hollow -- the shadow that MAKES the cheekbone */
        addLoft(pile, xf(hm, [fs * hw * 0.66, -0.019 * h, hd * 0.40], [0.22, fs * 0.56, 0]), [
          { y: -0.011 * h, rx: 0.009 * h, rz: 0.004 * h, n: 2.5, uv: 0, ao: .68 },
          { y: 0.000, rx: 0.013 * h, rz: 0.005 * h, n: 2.5, uv: .5, ao: .50 },
          { y: 0.010 * h, rx: 0.008 * h, rz: 0.004 * h, n: 2.5, uv: 1, ao: .66 }
        ], Q.hand, subReg(skinR, .5, .5, .3, .3), C.skin, mHead,
          { capStart: true, capEnd: true, tone: 0.82, sss: .10, name: 'submalar' });
      }
      /* eye sockets: a recessed almond either side of the nose bridge. It is
         DARK because it is deep, not because it is painted -- the ao term is
         the whole feature and it survives every mip. */
      for (fs = -1; q < 2 && fs <= 1; fs += 2) {
        addLoft(pile, xf(hm, [fs * hw * 0.40, 0.009 * h, hd * 0.60], [0.05, fs * -0.34, 0]), [
          { y: -0.010 * h, rx: 0.014 * h, rz: 0.003 * h, n: 2.5, uv: 0, ao: .36 },
          { y: 0.000, rx: 0.016 * h, rz: 0.004 * h, n: 2.5, uv: .5, ao: .20 },
          { y: 0.009 * h, rx: 0.012 * h, rz: 0.003 * h, n: 2.5, uv: 1, ao: .40 }
        ], Q.hand, subReg(skinR, .7, .2, .25, .25), C.skin, mHead,
          { capStart: true, capEnd: true, tone: 0.62, sss: .10, name: 'socket' });
        /* infraorbital shadow: the tear-trough under the lower lid. On an
           operator in eye-pro this is the ONLY dark form still visible below
           the lens, and it is what stops the strip of face reading as a band
           of tape stuck across the head. */
        addLoft(pile, xf(hm, [fs * hw * 0.42, -0.004 * h, hd * 0.62], [0.30, fs * -0.30, 0]), [
          { y: -0.004 * h, rx: 0.011 * h, rz: 0.002 * h, n: 2.5, uv: 0, ao: .58 },
          { y: 0.003 * h, rx: 0.014 * h, rz: 0.003 * h, n: 2.5, uv: 1, ao: .42 }
        ], Q.hand, subReg(skinR, .6, .6, .25, .25), C.skin, mHead,
          { capStart: true, capEnd: true, tone: 0.74, sss: .08, name: 'tearline' });
      }
      /* nasolabial fold: the crease from the nose wing to the mouth corner.
         One dark diagonal each side, and the strongest ageing/character cue
         a face has after the eye socket. */
      if (Q.detail) for (fs = -1; fs <= 1; fs += 2) {
        addLoft(pile, xf(hm, [fs * hw * 0.30, -0.020 * h, hd * 0.80], [0.10, fs * -0.22, fs * 0.30]), [
          { y: 0.008 * h, rx: 0.0035 * h, rz: 0.0022 * h, n: 2.4, uv: 0, ao: .62 },
          { y: -0.010 * h, rx: 0.0040 * h, rz: 0.0024 * h, n: 2.4, uv: 1, ao: .48 }
        ], Q.hand, subReg(skinR, .8, .4, .18, .18), C.skin, mHead,
          { capStart: true, capEnd: true, tone: 0.76, name: 'nasolabial' });
      }
      /* mandible: the jaw mass and the chin. `tone` a shade under the cheek
         is the beard shadow -- a real one on a man who shaved two days ago,
         not a painted goatee. */
      addLoft(pile, xf(hm, [0, -0.028 * h, hd * 0.14], [0.30, 0, 0]), [
        { y: 0.018 * h, rx: hw * 0.88, rz: hd * 0.76, n: 3.0, uv: 0, ao: .70 },
        { y: 0.002 * h, rx: hw * 0.80, rz: hd * 0.72, n: 3.0, uv: .45, ao: .84 },
        { y: -0.013 * h, rx: hw * 0.58, rz: hd * 0.54, n: 2.9, uv: .78, ao: .80 },
        { y: -0.024 * h, rx: hw * 0.34, rz: hd * 0.36, n: 2.8, uv: 1, ao: .64 }
      ], S, subReg(skinR, .45, .1, .45, .45), C.skin, mHead,
        { capEnd: true, sss: .18, tone: 0.88, name: 'jaw' });
      /* the mouth is one crease, set into the jaw. Anything more is a
         puppet: a closed mouth at five metres IS a horizontal shadow. */
      if (Q.detail) {
        addLoft(pile, xf(hm, [0, -0.026 * h, hd * 0.86], [0.16, 0, 0]), [
          { y: -0.003 * h, rx: hw * 0.44, rz: 0.0022 * h, n: 2.6, uv: 0, ao: .62 },
          { y: 0.002 * h, rx: hw * 0.46, rz: 0.0024 * h, n: 2.6, uv: 1, ao: .50 }
        ], T, subReg(skinR, .8, .7, .2, .2), C.skin, mHead,
          { capStart: true, capEnd: true, tone: 0.78, name: 'mouth' });
      }
    }

    /* ---- 2. face covering --------------------------------------------- */
    /* balaclava / shemagh: a knit shell over the lower face and cranium with
       a bare strip across the eyes. Two pieces, because one continuous hood
       reads as a moulded mask. */
    /* COVERAGE IS COMMITTED TO. A half-covered mask -- a bare nose and
       cheekbones between a lens and a scarf -- is the worst of both: it is
       the one place on the model where the eye goes looking for a face and
       finds a shaded blank. So the lower mask now runs UP TO THE EYE LINE
       and tents over the bridge of the nose (rz > the skull at the top two
       stations, and cz carried forward with it), the cranium cap comes down
       to meet the lens frame, and the eye slot between them is filled with
       dark glass. What is left of skin is a 6 mm strip at the temples, which
       is exactly what a real one looks like. */
    function lowerMask(reg, col, tone) {
      addLoft(pile, hm, [
        { y: -0.060 * h, rx: 0.001, rz: 0.001, cz: 0.026 * h, n: 2, uv: 0 },
        { y: -0.053 * h, rx: hw * 0.34, rz: hd * 0.38, cz: 0.026 * h, n: 2.4, uv: .08, ao: .62 },
        { y: -0.042 * h, rx: hw * 0.67, rz: hd * 0.71, cz: 0.021 * h, n: 2.6, uv: .24, ao: .74 },
        { y: -0.030 * h, rx: hw * 0.86, rz: hd * 0.92, cz: 0.012 * h, n: 2.7, uv: .48, ao: .86 },
        { y: -0.019 * h, rx: hw * 0.99, rz: hd * 1.03, cz: 0.008 * h, n: 2.7, uv: .68, ao: .95 },
        /* over the nose: the cloth bridges from cheekbone to cheekbone and
           the nose pushes it forward, so rz peaks here and not on the skull */
        { y: -0.008 * h, rx: hw * 1.05, rz: hd * 1.30, cz: 0.006 * h, n: 2.6, uv: .88, ao: .90 },
        { y: 0.001 * h, rx: hw * 1.04, rz: hd * 1.20, cz: 0.004 * h, n: 2.7, uv: 1, ao: .80 }
      ], S, reg, col, mHead, { tone: tone, wear: .35, wearFreq: 3.6, name: 'mask' });
    }
    function craniumCap(reg, col, tone) {
      addLoft(pile, hm, [
        { y: 0.014 * h, rx: hw * 1.03, rz: hd * 1.03, cz: 0.001 * h, n: 2.5, uv: 0, ao: .74 },
        { y: 0.020 * h, rx: hw * 1.03, rz: hd * 1.02, cz: 0.000, n: 2.5, uv: .06, ao: .78 },
        { y: 0.040 * h, rx: hw * 0.99, rz: hd * 0.97, cz: -0.004 * h, n: 2.5, uv: .4 },
        { y: 0.058 * h, rx: hw * 0.86, rz: hd * 0.83, cz: -0.010 * h, n: 2.4, uv: .75 },
        { y: 0.070 * h, rx: hw * 0.55, rz: hd * 0.53, cz: -0.012 * h, n: 2.3, uv: .94 },
        { y: 0.078 * h, rx: 0.001, rz: 0.001, cz: -0.012 * h, n: 2, uv: 1 }
      ], S, reg, col, mHead, { tone: tone, name: 'cap' });
    }
    /* Protective eyewear: two ballistic lenses with a real nose bridge.
       A single opaque strip across the whole face survived every material
       pass as a cyclops/robot cue. Splitting the lens restores the brow and
       nose silhouette while keeping the eyes protected and dark. */
    function eyePro(wrap, yOff) {
      var yo = (yOff === undefined ? 0.011 : yOff) * h;
      /* 46 mm of lens, not 37, and it now sits ON the eye line (the eyes are
         9 mm above the head bone) rather than above it -- so the orbit is
         behind glass at every camera angle instead of only from dead ahead. */
      /* AND IT STANDS OFF THE FACE. With the masks pulled up to the eye line
         a lens sitting flush on the brow is simply swallowed by cloth -- the
         glasses disappeared entirely the first time the scarf went up. Real
         wraparound eye-pro bridges the nose and clears the cheek by 12-15 mm,
         so the base moves forward from hd*0.30 to hd*0.44 and the lens is
         reliably the frontmost thing on the head below the brow. */
      for (var ls = -1; ls <= 1; ls += 2) {
        var lensX = ls * hw * 0.52;
        addLoft(pile, xf(hm, [lensX, yo, hd * 0.44]), [
          { y: -0.014 * h, rx: hw * (0.43 + wrap * .35), rz: hd * 0.82, n: 2.9, uv: 0, ao: .80 },
          { y: -0.006 * h, rx: hw * (0.47 + wrap * .35), rz: hd * 0.89, n: 2.9, uv: .35 },
          { y: 0.004 * h, rx: hw * (0.48 + wrap * .35), rz: hd * 0.90, n: 2.9, uv: .7 },
          { y: 0.011 * h, rx: hw * (0.44 + wrap * .35), rz: hd * 0.81, n: 2.9, uv: 1, ao: .9 }
        ], S, REG.eye, [.118, .128, .142], mHead, { rot: -PI / 2, name: 'lens' });
        /* Independent upper and lower rims keep the centre gap open instead
           of quietly rebuilding the old visor with one continuous frame. */
        addLoft(pile, xf(hm, [lensX, yo + 0.013 * h, hd * 0.42]), [
          { y: -0.004 * h, rx: hw * (0.49 + wrap * .35), rz: hd * 0.88, n: 3.0, uv: 0, ao: .7 },
          { y: 0.004 * h, rx: hw * (0.49 + wrap * .35), rz: hd * 0.88, n: 3.0, uv: 1, ao: .85 }
        ], S, subReg(REG.rubber, .2, .2, .5, .5), C.rubber, mHead,
          { rot: -PI / 2, name: 'lensframe' });
        addLoft(pile, xf(hm, [lensX, yo - 0.016 * h, hd * 0.43]), [
          { y: -0.003 * h, rx: hw * (0.46 + wrap * .35), rz: hd * 0.84, n: 3.0, uv: 0, ao: .62 },
          { y: 0.003 * h, rx: hw * (0.47 + wrap * .35), rz: hd * 0.85, n: 3.0, uv: 1, ao: .78 }
        ], S, subReg(REG.rubber, .2, .2, .5, .5), C.rubber, mHead,
          { rot: -PI / 2, name: 'lensrim' });
      }
      /* A narrow bridge joins the two lenses without hiding the nose. */
      addBox(pile, xf(hm, [0, yo + 0.004 * h, hd * 0.92]),
        hw * 0.22, 0.006 * h, 0.008 * h, 3,
        subReg(REG.rubber, .2, .2, .5, .5), C.rubber, mHead,
        { cham: 0.45, tone: .92, name: 'lensbridge' });
    }
    /* headset: two earcups on a band, plus a boom mic. Every operator that
       has comms gets it -- it is a strong, instantly readable silhouette. */
    function headset(radius) {
      for (es = -1; es <= 1; es += 2) {
        addLoft(pile, xf(hm, [es * hw * radius, 0.002 * h, -hd * 0.08], [0, 0, es * PI / 2]), [
          { y: 0, rx: 0.019 * h, rz: 0.022 * h, n: 3.0, uv: 0, ao: .8 },
          { y: -0.011 * h, rx: 0.022 * h, rz: 0.025 * h, n: 3.0, uv: .5 },
          { y: -0.019 * h, rx: 0.017 * h, rz: 0.020 * h, n: 3.0, uv: 1, ao: .9 }
        ], Q.lim, subReg(REG.plastic, .1, .1, .45, .45), C.plastic, mHead,
          { capStart: true, capEnd: true, name: 'earcup' });
      }
      addLoft(pile, xf(hm, [-hw * (radius + 0.12), -0.006 * h, -hd * 0.04], [-1.22, 0.46, 0.30]), [
        { y: 0, rx: 0.0035 * h, rz: 0.0035 * h, n: 2, uv: 0 },
        { y: -0.062 * h, rx: 0.0030 * h, rz: 0.0030 * h, n: 2, uv: .8 },
        { y: -0.074 * h, rx: 0.0080 * h, rz: 0.0060 * h, n: 2.6, uv: 1 }
      ], 4, subReg(REG.rubber, .2, .2, .4, .4), C.rubber, mHead,
        { capStart: true, capEnd: true, name: 'boom' });
    }
    /* chin strap: two risers and a cup. Without it a helmet floats. */
    function chinStrap(spread) {
      for (es = -1; es <= 1; es += 2) {
        addBox(pile, xf(hm, [es * hw * spread, -0.020 * h, hd * 0.16], [0.10, 0, es * 0.55]),
          0.004 * h, 0.062 * h, 0.010 * h, 3,
          subReg(REG.web, .2, .2, .4, .4), C.web, mHead, { cham: 0.4, name: 'chinstrap' });
      }
      addBox(pile, xf(hm, [0, -0.049 * h, hd * 0.36], [0.30, 0, 0]),
        hw * 0.42, 0.016 * h, 0.016 * h, 3,
        subReg(REG.web, .5, .5, .4, .4), C.web, mHead, { cham: 0.4, name: 'chincup' });
    }
    /* ballistic helmet shell, high-cut or full-cut */
    function helmet(scale, drop, reg, col) {
      addLoft(pile, hm, [
        { y: (drop - 0.004) * h, rx: hw * 1.14 * scale, rz: hd * 1.09 * scale, cz: -0.002 * h, n: 2.8, uv: 0, ao: .70 },
        { y: (drop + 0.010) * h, rx: hw * 1.20 * scale, rz: hd * 1.15 * scale, cz: -0.004 * h, n: 2.8, uv: .18, ao: .84 },
        { y: 0.032 * h, rx: hw * 1.19 * scale, rz: hd * 1.14 * scale, cz: -0.006 * h, n: 2.7, uv: .44 },
        { y: 0.056 * h, rx: hw * 1.08 * scale, rz: hd * 1.02 * scale, cz: -0.010 * h, n: 2.6, uv: .70 },
        { y: 0.076 * h, rx: hw * 0.74 * scale, rz: hd * 0.70 * scale, cz: -0.012 * h, n: 2.5, uv: .92 },
        { y: 0.087 * h, rx: 0.001, rz: 0.001, cz: -0.012 * h, n: 2, uv: 1 }
      ], S, reg, col, mHead,
        { capStart: true, wear: .45, wearFreq: 3.4, name: 'helmet' });
      /* the rubber trim round the brim -- one dark line that makes a helmet
         read as a shell with a thickness rather than a painted dome */
      addLoft(pile, xf(hm, [0, (drop + 0.002) * h, 0]), [
        { y: -0.006 * h, rx: hw * 1.21 * scale, rz: hd * 1.16 * scale, cz: -0.004 * h, n: 2.8, uv: 0, ao: .66 },
        { y: 0.005 * h, rx: hw * 1.21 * scale, rz: hd * 1.16 * scale, cz: -0.004 * h, n: 2.8, uv: 1, ao: .78 }
      ], S, subReg(REG.rubber, .3, .3, .4, .4), C.rubber, mHead, { tone: 0.9, name: 'brimtrim' });
      /* accessory rails + NVG shroud: the modern-operator read */
      addBox(pile, xf(hm, [0, 0.030 * h, hd * 1.07 * scale]), 0.018 * h, 0.026 * h, 0.009 * h, Q.cham,
        subReg(REG.plastic, .5, 0, .4, .5), C.plastic, mHead, { cham: 0.3, name: 'shroud' });
      if (Q.detail) {
        addBox(pile, xf(hm, [0, 0.048 * h, hd * 1.02 * scale], [0.35, 0, 0]), 0.008 * h, 0.028 * h, 0.007 * h, 3,
          subReg(REG.steel, .3, .3, .4, .4), C.steel, mHead, { cham: 0.35, name: 'nvgmount' });
        for (es = -1; es <= 1; es += 2) {
          addBox(pile, xf(hm, [es * hw * 1.17 * scale, 0.030 * h, hd * 0.10], [0, 0, es * -0.06]),
            0.005 * h, 0.013 * h, 0.050 * h, 3,
            subReg(REG.plastic, .1, .6, .35, .35), C.plastic, mHead, { cham: 0.35, name: 'rail' });
        }
        /* counterweight pouch on the back: breaks the dome in profile */
        addBox(pile, xf(hm, [0, 0.030 * h, -hd * 1.06 * scale], [-0.18, 0, 0]),
          hw * 0.52, 0.040 * h, 0.014 * h, Q.cham,
          subReg(REG.nylon, .4, .5, .4, .4), C.nylon, mHead, { cham: 0.28, name: 'counterweight' });
      }
    }

    /* ---- 3. per-role headgear ----------------------------------------- */
    if (style === 'boonie') {
      /* RIFLEMAN: no helmet. A neck gaiter pulled down, cropped hair, and a
         boonie hat -- the brim is the whole silhouette, so it is a real
         cone-shell with a downturned edge, not a disc. */
      addLoft(pile, hm, [
        { y: 0.016 * h, rx: hw * 1.02, rz: hd * 1.01, cz: 0.000, n: 2.5, uv: 0, ao: .74 },
        { y: 0.040 * h, rx: hw * 0.98, rz: hd * 0.96, cz: -0.004 * h, n: 2.5, uv: .45 },
        { y: 0.062 * h, rx: hw * 0.80, rz: hd * 0.78, cz: -0.010 * h, n: 2.4, uv: .85 },
        { y: 0.072 * h, rx: 0.001, rz: 0.001, cz: -0.012 * h, n: 2, uv: 1 }
      ], S, subReg(REG.knit, .3, .3, .6, .6), [.026, .022, .018], mHead, { name: 'hair' });
      /* THE NAPE. The crop above starts at the brim, and the gaiter stops at
         the collar, so 110 mm of bare occiput sat between them -- a flat skin
         panel across the back of the head, which is the same "beige sticker"
         defect as the face was, just hidden from the front by the hat. It is
         placed BEHIND the head rather than extended down as a full ring,
         because a ring at this height would put hair across the cheeks. */
      addLoft(pile, xf(hm, [0, -0.004 * h, -hd * 0.55]), [
        { y: -0.030 * h, rx: hw * 0.80, rz: hd * 0.66, n: 2.8, uv: 0, ao: .44 },
        { y: -0.010 * h, rx: hw * 1.00, rz: hd * 0.80, n: 2.8, uv: .45, ao: .58 },
        { y: 0.012 * h, rx: hw * 1.03, rz: hd * 0.82, n: 2.8, uv: .8, ao: .70 },
        { y: 0.028 * h, rx: hw * 0.94, rz: hd * 0.76, n: 2.8, uv: 1, ao: .76 }
      ], S, subReg(REG.knit, .3, .3, .6, .6), [.026, .022, .018], mHead,
        { capStart: true, capEnd: true, name: 'nape' });
      /* hat crown */
      addLoft(pile, hm, [
        { y: 0.026 * h, rx: hw * 1.10, rz: hd * 1.08, cz: -0.002 * h, n: 2.6, uv: 0, ao: .74 },
        { y: 0.050 * h, rx: hw * 1.06, rz: hd * 1.03, cz: -0.006 * h, n: 2.5, uv: .5 },
        { y: 0.070 * h, rx: hw * 0.80, rz: hd * 0.78, cz: -0.010 * h, n: 2.4, uv: .86 },
        { y: 0.079 * h, rx: 0.001, rz: 0.001, cz: -0.012 * h, n: 2, uv: 1 }
      ], S, subReg(uniR, 0, 0, 1, 1), uniC, mHead,
        { capStart: true, wear: .55, wearFreq: 3.0, name: 'boonie-crown' });
      /* brim: a shallow bowl, wider at the back, edge turned DOWN */
      addLoft(pile, xf(hm, [0, 0.026 * h, -0.004 * h]), [
        { y: 0.004 * h, rx: hw * 1.12, rz: hd * 1.10, n: 2.7, uv: 0, ao: .70 },
        { y: 0.000, rx: hw * 1.62, rz: hd * 1.56, n: 2.8, uv: .55, ao: .80 },
        { y: -0.014 * h, rx: hw * 1.74, rz: hd * 1.68, n: 2.9, uv: .9, ao: .62 },
        { y: -0.019 * h, rx: hw * 1.70, rz: hd * 1.64, n: 3.0, uv: 1, ao: .55 }
      ], S, subReg(uniR, .2, .2, .7, .7), uniC, mHead,
        { capEnd: true, wear: .6, wearFreq: 3.4, name: 'boonie-brim' });
      /* THE FACE. He is the only operator with skin showing, so it has to
         carry the read on its own -- see faceStructure. */
      faceStructure();
      /* SHEMAGH, worn the way people who actually wear one wear it: wrapped
         over the mouth and jaw and pulled up to the cheekbones, so the strip
         of face left showing is the eyes and the bridge of the nose -- and
         the eyes are behind dark ballistic glass. Three hard horizontal
         bands (brim shadow / dark lens / scarf) is a face that reads instantly
         at five metres and is DELIBERATE, rather than a bare skull loft that
         reads as a missing asset. The knot at the temple and the tail down
         the back are what stop it looking like a moulded chin guard. */
      /* THE TOP EDGE NOW RUNS ACROSS THE BRIDGE OF THE NOSE, under the lens.
         Round 4 stopped it under the nose on the argument that a bare nose
         and cheekbones "is a face" -- but at 8% of the frame that band was a
         shaded blank with no eyes, no lids and no nostrils, and a half-
         covered mask is the worst of both. It is a scarf pulled up, which is
         how people who own one wear one when it matters, and it leaves the
         same three hard horizontal bands (brim shadow / dark lens / scrim)
         that made the read work, with nothing left to fail. */
      addLoft(pile, hm, [
        { y: -0.063 * h, rx: 0.001, rz: 0.001, cz: 0.024 * h, n: 2, uv: 0 },
        { y: -0.056 * h, rx: hw * 0.44, rz: hd * 0.50, cz: 0.024 * h, n: 2.5, uv: .08, ao: .58 },
        { y: -0.050 * h, rx: hw * 0.80, rz: hd * 0.88, cz: 0.019 * h, n: 2.7, uv: .26, ao: .70 },
        { y: -0.041 * h, rx: hw * 1.01, rz: hd * 1.10, cz: 0.010 * h, n: 2.8, uv: .50, ao: .84 },
        { y: -0.030 * h, rx: hw * 1.07, rz: hd * 1.20, cz: 0.006 * h, n: 2.8, uv: .74, ao: .93 },
        /* over the nose -- the cloth bridges cheekbone to cheekbone and the
           nose pushes it out, which is why rz peaks here and not lower */
        { y: -0.014 * h, rx: hw * 1.09, rz: hd * 1.36, cz: 0.004 * h, n: 2.6, uv: .92, ao: .88 },
        { y: -0.005 * h, rx: hw * 1.06, rz: hd * 1.18, cz: 0.004 * h, n: 2.7, uv: 1, ao: .76 }
      ], S, subReg(REG.scrim, 0, 0, 1, 1), C.scrim, mHead,
        { wear: .55, wearFreq: 3.0, name: 'shemagh' });
      if (Q.detail) {
        /* the knot, bunched at the left temple */
        addLoft(pile, xf(hm, [-hw * 0.86, -0.016 * h, hd * 0.26], [0.24, -0.62, 0.42]), [
          { y: -0.014 * h, rx: 0.008 * h, rz: 0.007 * h, n: 2.5, uv: 0, ao: .66 },
          { y: 0.000, rx: 0.015 * h, rz: 0.012 * h, n: 2.6, uv: .5, ao: .82 },
          { y: 0.013 * h, rx: 0.009 * h, rz: 0.008 * h, n: 2.5, uv: 1, ao: .70 }
        ], Q.lim, subReg(REG.scrim, .5, .2, .4, .4), C.scrim, mHead,
          { capStart: true, capEnd: true, wear: .6, wearFreq: 3.6, name: 'shemagh-knot' });
        /* and the tail, over the shoulder */
        addBox(pile, xf(hm, [-hw * 0.66, -0.052 * h, -hd * 0.46], [0.34, -0.26, 0.20]),
          0.021 * h, 0.056 * h, 0.004 * h, 3,
          subReg(REG.scrim, .2, .6, .5, .4), C.scrim, mHead,
          { cham: 0.4, tone: 0.94, wear: .7, wearFreq: 3.8, name: 'shemagh-tail' });
      }
      eyePro(0.02, 0.013);
      if (Q.detail) {
        /* single in-ear comms bud + wire, instead of a full headset */
        addLoft(pile, xf(hm, [-hw * 1.00, 0.000, -hd * 0.06], [0, 0, PI / 2]), [
          { y: 0, rx: 0.008 * h, rz: 0.009 * h, n: 2.6, uv: 0, ao: .8 },
          { y: -0.010 * h, rx: 0.006 * h, rz: 0.007 * h, n: 2.6, uv: 1, ao: .9 }
        ], T, subReg(REG.plastic, .1, .1, .4, .4), C.plastic, mHead,
          { capStart: true, capEnd: true, name: 'earbud' });
      }

    } else if (style === 'visor') {
      /* BREACHER: full-cut ballistic helmet, mandible guard and a flip-down
         visor. Almost no skin shows -- he is the anonymous one. */
      lowerMask(subReg(REG.knit, 0, 0, .8, .8), C.knit, 1);
      craniumCap(subReg(REG.knit, .1, .1, .8, .8), C.knit, 1);
      helmet(1.06, -0.010, subReg(REG.plastic, 0, 0, 1, 1), C.plastic);
      /* mandible / jaw guard, hinged off the helmet at the ears */
      addLoft(pile, xf(hm, [0, -0.030 * h, hd * 0.30]), [
        { y: -0.020 * h, rx: hw * 0.96, rz: hd * 1.00, n: 3.0, uv: 0, ao: .62 },
        { y: -0.004 * h, rx: hw * 1.10, rz: hd * 1.06, n: 3.0, uv: .5, ao: .74 },
        { y: 0.012 * h, rx: hw * 1.16, rz: hd * 1.08, n: 3.0, uv: 1, ao: .86 }
      ], S, subReg(REG.plastic, .2, .5, .6, .5), C.plastic, mHead,
        { wear: .4, wearFreq: 3.8, name: 'mandible' });
      /* breather vents: three slots across the mandible */
      if (Q.detail) for (i = -1; i <= 1; i++) {
        addBox(pile, xf(hm, [i * 0.016 * h, -0.026 * h, hd * 1.02], [0.12, 0, 0]),
          0.005 * h, 0.020 * h, 0.005 * h, 3,
          subReg(REG.rubber, .4, .4, .3, .3), C.rubber, mHead, { cham: 0.45, name: 'vent' });
      }
      /* visor: a wrapped dark shell standing proud of the brow */
      addLoft(pile, xf(hm, [0, 0.008 * h, hd * 0.34]), [
        { y: -0.020 * h, rx: hw * 1.16, rz: hd * 1.02, n: 3.0, uv: 0, ao: .70 },
        { y: -0.002 * h, rx: hw * 1.22, rz: hd * 1.06, n: 3.0, uv: .5 },
        { y: 0.016 * h, rx: hw * 1.18, rz: hd * 1.02, n: 3.0, uv: 1, ao: .86 }
      ], S, REG.eye, [.080, .088, .098], mHead, { rot: -PI / 2, name: 'visor' });
      /* visor pivot bosses */
      if (Q.detail) for (es = -1; es <= 1; es += 2) {
        addLoft(pile, xf(hm, [es * hw * 1.20, 0.014 * h, hd * 0.18], [0, 0, es * PI / 2]), [
          { y: 0, rx: 0.009 * h, rz: 0.009 * h, n: 2.6, uv: 0, ao: .8 },
          { y: -0.008 * h, rx: 0.008 * h, rz: 0.008 * h, n: 2.6, uv: 1, ao: .9 }
        ], T, subReg(REG.steel, .3, .3, .4, .4), C.steel, mHead,
          { capStart: true, capEnd: true, name: 'visorpivot' });
      }
      chinStrap(0.90);

    } else if (style === 'wrap') {
      /* MARKSMAN: no hard helmet. A soft hood over a ballistic cap, a scrim
         veil across the lower face, and a spotting monocular pushed up onto
         the brow. Low-vis: the silhouette must be soft and broken. */
      craniumCap(subReg(uniR, .1, .1, .8, .8), uniC, 1);
      lowerMask(subReg(REG.knit, 0, 0, .8, .8), C.knit, 1);
      /* hood, standing off the skull and open at the front */
      addLoft(pile, xf(hm, [0, 0.006 * h, -0.008 * h]), [
        { y: -0.026 * h, rx: hw * 1.16, rz: hd * 1.16, cz: -0.006 * h, n: 2.7, uv: 0, ao: .58 },
        { y: 0.004 * h, rx: hw * 1.22, rz: hd * 1.22, cz: -0.008 * h, n: 2.7, uv: .3, ao: .70 },
        { y: 0.038 * h, rx: hw * 1.16, rz: hd * 1.14, cz: -0.012 * h, n: 2.6, uv: .62 },
        { y: 0.064 * h, rx: hw * 0.86, rz: hd * 0.84, cz: -0.016 * h, n: 2.5, uv: .88 },
        { y: 0.076 * h, rx: 0.001, rz: 0.001, cz: -0.018 * h, n: 2, uv: 1 }
      ], S, subReg(uniR, 0, 0, 1, 1), uniC, mHead,
        { capStart: true, wear: .65, wearFreq: 2.6, name: 'hood' });
      /* scrim strips hanging off the hood edge: five short tags, the thing
         that actually breaks a sniper's outline */
      if (Q.detail) for (i = 0; i < 5; i++) {
        var sa = -1.5 + i * 0.75;
        addBox(pile, xf(hm, [Math.sin(sa) * hw * 1.14, -0.014 * h, Math.cos(sa) * hd * 1.12],
          [0.20, sa, 0.12 * (i % 2 ? 1 : -1)]),
          0.010 * h, 0.048 * h, 0.003 * h, 3,
          subReg(REG.scrim, .4, .4, .5, .5), C.scrim, mHead,
          { cham: 0.4, tone: 0.86 + (i % 3) * 0.08, wear: .7, wearFreq: 4.0, name: 'scrim' });
      }
      eyePro(0.00, 0.011);
      if (Q.detail) {
        /* monocular flipped up above the brow */
        addLoft(pile, xf(hm, [hw * 0.30, 0.052 * h, hd * 0.72], [-0.55, 0, 0]), [
          { y: 0, rx: 0.011 * h, rz: 0.011 * h, n: 2.6, uv: 0, ao: .8 },
          { y: 0.030 * h, rx: 0.010 * h, rz: 0.010 * h, n: 2.6, uv: .7 },
          { y: 0.038 * h, rx: 0.013 * h, rz: 0.013 * h, n: 2.6, uv: 1, ao: .72 }
        ], Q.lim, subReg(REG.plastic, .2, .2, .5, .5), C.plastic, mHead,
          { capStart: true, capEnd: true, name: 'monocular' });
        addLoft(pile, xf(hm, [-hw * 1.00, 0.000, -hd * 0.06], [0, 0, PI / 2]), [
          { y: 0, rx: 0.008 * h, rz: 0.009 * h, n: 2.6, uv: 0, ao: .8 },
          { y: -0.010 * h, rx: 0.006 * h, rz: 0.007 * h, n: 2.6, uv: 1, ao: .9 }
        ], T, subReg(REG.plastic, .1, .1, .4, .4), C.plastic, mHead,
          { capStart: true, capEnd: true, name: 'earbud' });
      }

    } else {
      /* ASSAULTER: balaclava, high-cut helmet, full comms headset. The
         cut-away shell is what makes room for the earcups, so the two read
         as one system rather than as two hats. */
      lowerMask(subReg(REG.knit, 0, 0, .8, .8), C.knit, 1);
      craniumCap(subReg(REG.knit, .1, .1, .8, .8), C.knit, 1);
      eyePro(0.02, 0.012);
      helmet(1.00, 0.006, subReg(REG.plastic, 0, 0, 1, 1), C.plastic);
      if (Q.detail) headset(1.06);
      chinStrap(0.86);
      if (Q.detail) {
        /* IR strobe on the rear of the shell. One small, dim marker is the
           only light on the whole figure -- CS2-plausible, and it gives the
           silhouette a single read point in an unlit corridor. */
        addBox(pile, xf(hm, [hw * 0.44, 0.048 * h, -hd * 1.04]),
          0.008 * h, 0.010 * h, 0.005 * h, 3,
          REG.glowTrim, C.accent, mHead, { cham: 0.4, name: 'irstrobe' });
      }
    }
  }

  /* =========================================================================
     WEAPONS  --  real firearms, at real millimetre dimensions.

     Everything below is a measurement of the pattern it models, in MILLIMETRES,
     converted through sp.mpm (model units per real metre, calibrated per kind
     from ECFG in calibrateScale). Nothing here is eyeballed. The frame is:

         +Z  forward, along the bore
         +Y  up
         +X  the shooter's right
          0  bore axis, at the TRIGGER

     Sanity check from the brief: a rifle held at the shoulder must span from
     the shoulder to roughly one hand-length past the leading fist. An AK is
     880 mm, an operator's arm span is ~1830 mm, his forearm ~260 mm -- so the
     length lands squarely between the two bounds it has to sit between.
     ====================================================================== */
  var GUNDIM = {
    /* AK-pattern rifle, 7.62x39. OAL 880, barrel 415. Stamped receiver, wood
       furniture, heavily curved 30-round magazine, slant muzzle brake. */
    ak: {
      oal: 880, barrel: 415, zButt: -352, zMuzzle: 528,
      recZ0: -66, recZ1: 116, recHW: 17.5, recTop: 40, recBot: -44,
      dustTop: 52,                       /* domed dust cover over the receiver */
      hgZ0: 122, hgZ1: 300, hgHW: 27, hgTop: 4, hgBot: -36,
      gasZ0: 128, gasZ1: 306, gasR: 11, gasY: 34,
      gbZ0: 306, gbZ1: 344, gbHW: 15, gbTop: 30, gbBot: -18,
      fsZ0: 356, fsZ1: 392, fsPost: 62,  /* front sight tower + hooded post   */
      barR0: 9.0, barR1: 7.4, barZ0: 116,
      brakeZ0: 496, brakeZ1: 528, brakeR: 12.0,
      /* 30 rounds of 7.62x39 stack on a 260 mm radius: 200 mm of magazine
         leaves the well at 5 deg and reaches the floorplate at 49 deg. */
      magZ: 58, magLen: 200, magHW: 12.0, magD: 46, magCurve: 260, magRake: 0.09,
      gripZ: -56, gripRake: 0.34, gripLen: 122, gripHW: 16.5, gripHD: 22,
      tgZ0: -30, tgZ1: 34, tgY: -46, tgR: 7,
      stock: 'fixed', combY: 16, buttHH: 108, buttHW: 18, stockDrop: -26,
      sightZ: 66, sightY: 40,
      furniture: 'wood', charge: 1, safety: 1, optic: 0, bipod: 0,
      gripLz: 172,                       /* C-clamp, mid wooden handguard    */
      slingF: 330, slingR: -180
    },
    /* M4-pattern carbine, 5.56x45. OAL 840 with the stock extended, barrel
       368. Flat-top upper with a full-length rail, free-float handguard,
       collapsible stock on a buffer tube, red-dot optic, A2 flash hider. */
    m4: {
      oal: 840, barrel: 368, zButt: -330, zMuzzle: 510,
      recZ0: -58, recZ1: 128, recHW: 16.0, recTop: 34, recBot: -42,
      dustTop: 34,
      hgZ0: 130, hgZ1: 362, hgHW: 22, hgTop: 26, hgBot: -28,
      gasZ0: 0, gasZ1: 0, gasR: 0, gasY: 0,
      gbZ0: 0, gbZ1: 0, gbHW: 0, gbTop: 0, gbBot: 0,
      fsZ0: 0, fsZ1: 0, fsPost: 0,
      barR0: 8.4, barR1: 7.0, barZ0: 128,
      brakeZ0: 466, brakeZ1: 510, brakeR: 11.0,
      magZ: 66, magLen: 190, magHW: 11.0, magD: 34, magCurve: 700, magRake: 0.05,
      gripZ: -52, gripRake: 0.38, gripLen: 118, gripHW: 16.0, gripHD: 21,
      tgZ0: -26, tgZ1: 32, tgY: -44, tgR: 7,
      stock: 'collapsible', combY: 12, buttHH: 92, buttHW: 16, stockDrop: -6,
      sightZ: 74, sightY: 34,
      furniture: 'polymer', charge: 0, safety: 1, optic: 'reddot', bipod: 0,
      gripLz: 240,                       /* thumb-forward on the rail        */
      slingF: 348, slingR: -150
    },
    /* Combat shotgun, 12 gauge. OAL 1005, barrel 470. Tube magazine under the
       barrel, ribbed pump forend, ghost-ring rear sight, pistol-grip stock. */
    shotgun: {
      oal: 1005, barrel: 470, zButt: -368, zMuzzle: 637,
      recZ0: -50, recZ1: 152, recHW: 20.0, recTop: 40, recBot: -46,
      dustTop: 40,
      hgZ0: 210, hgZ1: 400, hgHW: 26, hgTop: -6, hgBot: -50,   /* pump forend */
      gasZ0: 0, gasZ1: 0, gasR: 0, gasY: 0,
      gbZ0: 0, gbZ1: 0, gbHW: 0, gbTop: 0, gbBot: 0,
      fsZ0: 596, fsZ1: 620, fsPost: 34,
      barR0: 11.5, barR1: 10.6, barZ0: 152,
      brakeZ0: 0, brakeZ1: 0, brakeR: 0,
      magZ: 0, magLen: 0, magHW: 0, magD: 0, magCurve: 0, magRake: 0,
      tubeZ0: 160, tubeZ1: 560, tubeR: 11.0, tubeY: -26,
      gripZ: -46, gripRake: 0.36, gripLen: 120, gripHW: 17.0, gripHD: 22,
      tgZ0: -22, tgZ1: 34, tgY: -48, tgR: 7.5,
      stock: 'fixed', combY: 8, buttHH: 118, buttHW: 20, stockDrop: -34,
      sightZ: 130, sightY: 44,
      furniture: 'polymer', charge: 0, safety: 1, optic: 'ghost', bipod: 0,
      gripLz: 200,                       /* on the pump, ready to cycle it   */
      slingF: 470, slingR: -200
    },
    /* Bolt-action DMR, 7.62x51. OAL 1160, barrel 610. Heavy fluted barrel,
       chassis stock with an adjustable comb, 10-round box magazine, 10x scope
       on a 20 MOA rail, folding bipod, muzzle brake. */
    dmr: {
      oal: 1160, barrel: 610, zButt: -430, zMuzzle: 730,
      recZ0: -70, recZ1: 120, recHW: 19.0, recTop: 34, recBot: -44,
      dustTop: 34,
      hgZ0: 124, hgZ1: 420, hgHW: 24, hgTop: 22, hgBot: -36,
      gasZ0: 0, gasZ1: 0, gasR: 0, gasY: 0,
      gbZ0: 0, gbZ1: 0, gbHW: 0, gbTop: 0, gbBot: 0,
      fsZ0: 0, fsZ1: 0, fsPost: 0,
      barR0: 12.5, barR1: 10.0, barZ0: 120,
      brakeZ0: 674, brakeZ1: 730, brakeR: 14.0,
      magZ: 54, magLen: 118, magHW: 12.0, magD: 42, magCurve: 900, magRake: 0.05,
      gripZ: -58, gripRake: 0.30, gripLen: 124, gripHW: 16.5, gripHD: 22,
      tgZ0: -32, tgZ1: 32, tgY: -46, tgR: 7,
      stock: 'chassis', combY: 30, buttHH: 104, buttHW: 19, stockDrop: -4,
      sightZ: 40, sightY: 62,
      furniture: 'polymer', charge: 0, safety: 1, optic: 'scope', bipod: 1,
      gripLz: 126,                       /* well back: it is a 1160 mm rifle */
      slingF: 400, slingR: -260
    }
  };

  /* Dimensions in MODEL units + the hand/shoulder anchors, cached per kind.
     Cleared by calibrateScale() because mpm changes when ECFG arrives. */
  function gunSpec(sp) {
    if (sp._gun) return sp._gun;
    var src = GUNDIM[sp.gun] || GUNDIM.ak;
    var k = 0.001 * sp.mpm;                     /* mm -> model units */
    var d = {}, key;
    for (key in src) d[key] = (typeof src[key] === 'number') ? src[key] * k : src[key];
    d.type = sp.gun;
    d.mm = k;
    /* de-scale the pure numbers that are NOT lengths */
    d.gripRake = src.gripRake; d.magRake = src.magRake;
    d.charge = src.charge; d.safety = src.safety;
    d.optic = src.optic; d.bipod = src.bipod; d.furniture = src.furniture;
    d.stock = src.stock;
    d.oalReal = src.oal;

    /* ---- anchors ------------------------------------------------------
       These are what the ANIMATION solves the hands onto, so they have to be
       wrist positions, not contact patches: the hand bone's origin is the
       wrist and its palm centre sits ~55 mm further along the hand. */
    var PALM = 55 * k;                           /* wrist -> palm centre */
    /* trigger hand: palm wrapped round the pistol grip, 45 mm below the bore
       line at the web of the thumb. The grip rakes up-and-forward, so the
       wrist is up the grip axis from the palm. */
    var gu = [0, Math.cos(src.gripRake), Math.sin(src.gripRake)];
    var gpx = 0, gpy = d.tgY - 44 * k, gpz = d.gripZ - 18 * k;
    d.gripR = [gpx + gu[0] * PALM, gpy + gu[1] * PALM, gpz + gu[2] * PALM];
    /* support hand: C-clamp on the handguard for the ARs, on the ribbed pump
       for the shotgun, further back on the chassis for the DMR (which is fired
       off a bipod or a bag, so the support hand does not reach out). */
    var hgMid = src.gripLz || (src.hgZ0 * 0.56 + src.hgZ1 * 0.44);
    d.gripL = [-16 * k, (src.hgBot - 34) * k, hgMid * k];
    /* the physical contact points, for the harness and for the finger poses */
    d.gripRPt = [gpx, gpy, gpz];
    d.gripLPt = [0, (src.hgBot + 6) * k, hgMid * k];
    /* shoulder pocket contact: the centre of the buttplate */
    d.butt = [0, (src.stockDrop + 0) * k, d.zButt];
    d.muzzle = [0, 0, d.zMuzzle];
    /* the sight the shooter's eye lines up on */
    d.sight = [0, (src.optic === 'scope' ? (src.recTop + 34) : src.optic === 'reddot'
      ? (src.recTop + 49) : src.sightY) * k,
    (src.optic === 'scope' ? -30 : src.sightZ) * k];
    d.oal = d.zMuzzle - d.zButt;
    /* Lowest surface of the gun in its own frame -- magazine floorplate on the
       box-mag guns, pistol grip on the tube-fed shotgun. A dropped rifle has
       to be laid ON the floor, not through it, and this is the number that
       says how high the weapon bone must sit to do that. */
    d.low = Math.min(
      (src.recBot - (src.magLen || 0) * Math.cos(src.magRake || 0)),
      (src.tgY - (src.gripLen || 0) * Math.cos(src.gripRake || 0)),
      (src.stockDrop - (src.buttHH || 0) * 0.5)) * k;
    sp._gun = d;
    return d;
  }

  /* ------------------------------------------------------------------------
     Build. Everything is chamfered -- addBox clusters its samples at the four
     corners of the superellipse so a 90 degree edge never survives, and the
     lofts use n >= 3.2 for the same reason. Carbon fouling and edge wear come
     from the atlas wear pass, keyed on bind-space noise, so the muzzle end and
     the ejection port darken without any per-part texture authoring.
     --------------------------------------------------------------------- */
  function buildWeapon(kind, pile, wm, q, Q, mGun, C, sp) {
    /* gunmetal takes dust and a dye shift but never sun-bleaches, and the
       shift has to be a third of what cloth gets or the receiver mottles */
    WSCALE = 0.34;
    try { buildWeaponInner(kind, pile, wm, q, Q, mGun, C, sp); }
    finally { WSCALE = 1; }
  }
  function buildWeaponInner(kind, pile, wm, q, Q, mGun, C, sp) {
    var d = gunSpec(sp);
    var side = Q.lim, cq = Q.cham, tiny = Q.tiny;
    var gun = subReg(REG.gunmetal, 0, 0, 1, 1);
    var gunSide = subReg(REG.gunmetal, .12, .08, .76, .84);
    var furn = d.furniture === 'wood'
      ? subReg(REG.leather, .05, .05, .9, .9)
      : subReg(REG.plastic, .2, .2, .7, .7);
    var Cfurn = d.furniture === 'wood' ? C.furniture : C.plastic;
    var Cgun = C.gun, Cwear = C.gunwear;
    var poly = subReg(REG.plastic, .2, .2, .7, .7);
    var rub = subReg(REG.rubber, .1, .1, .7, .7);

    /* --- primitives, all in the weapon frame ------------------------------ */
    /* a chamfered box spanning z0..z1, centred on (xc, yc), half w/h */
    function zbox(z0, z1, xc, yc, hw, hh, reg, col, opt) {
      opt = opt || {};
      addBox(pile, xf(wm, [xc, yc, (z0 + z1) * 0.5], [PI / 2, 0, opt.roll || 0]),
        hw, Math.abs(z1 - z0), hh, opt.q || cq, reg, col, mGun,
        { cham: opt.cham === undefined ? 0.22 : opt.cham, tone: opt.tone,
          wear: opt.wear, wearFreq: opt.wearFreq, name: opt.name || 'gunbox' });
    }
    /* a tube along +Z from z0 to z1 */
    function ztube(z0, z1, xc, yc, r0, r1, reg, col, opt) {
      opt = opt || {};
      addLoft(pile, xf(wm, [xc, yc, z0], [-PI / 2, 0, 0]), [
        { y: 0, rx: r0, rz: r0 * (opt.flatten || 1), n: opt.n || 2.2, uv: 0, ao: .90 },
        { y: -(z1 - z0) * 0.5, rx: (r0 + r1) * 0.5, rz: (r0 + r1) * 0.5 * (opt.flatten || 1), n: opt.n || 2.2, uv: .5 },
        { y: -(z1 - z0), rx: r1, rz: r1 * (opt.flatten || 1), n: opt.n || 2.2, uv: 1 }
      ], opt.sides || side, reg, col, mGun,
        { capStart: opt.capStart !== false, capEnd: opt.capEnd !== false,
          tone: opt.tone, wear: opt.wear, wearFreq: opt.wearFreq,
          name: opt.name || 'guntube' });
    }
    /* a bar across the weapon (pins, sling loops, bipod legs) */
    function xbar(x0, x1, yc, zc, r, reg, col, nm) {
      addLoft(pile, xf(wm, [x0, yc, zc], [0, 0, -PI / 2]), [
        { y: 0, rx: r, rz: r, n: 2.4, uv: 0 },
        { y: -(x1 - x0), rx: r, rz: r, n: 2.4, uv: 1 }
      ], tiny, reg, col, mGun, { capStart: true, capEnd: true, name: nm || 'gunbar' });
    }

    /* ================= receiver ========================================= */
    zbox(d.recZ0, d.recZ1, 0, (d.recTop + d.recBot) * 0.5, d.recHW,
      (d.recTop - d.recBot) * 0.5, gun, Cgun,
      { cham: 0.18, wear: .55, wearFreq: 5.2, name: 'receiver' });
    /* dust cover / upper: a second, narrower block sitting proud of the
       receiver so the top of the gun is not one extruded rectangle */
    zbox(d.recZ0 + 6 * d.mm, d.recZ1 - 4 * d.mm, 0,
      (d.recTop + d.dustTop) * 0.5, d.recHW * 0.90,
      Math.max(2 * d.mm, (d.dustTop - d.recTop) * 0.5), gun, Cgun,
      { cham: 0.34, tone: 1.08, wear: .6, wearFreq: 6.0, name: 'dustcover' });
    /* magazine well collar -- the step the magazine seats into */
    if (d.magLen > 0) {
      zbox(d.magZ - d.magHW * 1.5, d.magZ + d.magHW * 1.5, 0, d.recBot + 6 * d.mm,
        d.magHW * 1.45, 10 * d.mm, gun, Cgun, { cham: 0.30, tone: 0.92, name: 'magwell' });
    }
    /* ejection port: a shallow recess on the right, drawn as a darker inset
       slab. At 8 m this is what tells you which way round the gun is. */
    if (Q.detail) {
      zbox(d.recZ1 - 96 * d.mm, d.recZ1 - 20 * d.mm, d.recHW * 0.94, d.recTop - 14 * d.mm,
        3 * d.mm, 13 * d.mm, gunSide, Cgun,
        { cham: 0.40, tone: 0.52, name: 'ejport' });
    }
    /* charging handle (AK: right side, reciprocating) */
    if (d.charge && Q.detail) {
      zbox(d.recZ1 - 66 * d.mm, d.recZ1 - 30 * d.mm, d.recHW + 8 * d.mm, d.recTop - 6 * d.mm,
        9 * d.mm, 6 * d.mm, gun, Cwear, { cham: 0.40, name: 'charge' });
    }
    /* safety / selector lever */
    if (d.safety && Q.detail) {
      zbox(d.recZ0 + 30 * d.mm, d.recZ0 + 76 * d.mm, d.recHW + 3 * d.mm, d.recTop - 22 * d.mm,
        2.5 * d.mm, 8 * d.mm, gun, Cwear, { cham: 0.45, name: 'selector' });
    }

    /* ================= barrel + muzzle ================================== */
    if (d.type === 'dmr') {
      /* heavy fluted profile: a stepped taper, then six shallow flutes */
      ztube(d.barZ0, d.barZ0 + 150 * d.mm, 0, 0, d.barR0, d.barR0 * 0.94, gun, Cgun,
        { sides: side + 2, wear: .5, wearFreq: 7 });
      ztube(d.barZ0 + 150 * d.mm, d.brakeZ0, 0, 0, d.barR0 * 0.94, d.barR1, gun, Cgun,
        { sides: side + 2, wear: .5, wearFreq: 7 });
      if (Q.detail) for (var fl = 0; fl < 6; fl++) {
        var fa = fl / 6 * TAU;
        ztube(d.hgZ1 + 10 * d.mm, d.brakeZ0 - 20 * d.mm,
          Math.cos(fa) * d.barR0 * 0.92, Math.sin(fa) * d.barR0 * 0.92,
          2.4 * d.mm, 2.2 * d.mm, gun, Cgun, { sides: 4, tone: 0.62, name: 'flute' });
      }
    } else {
      ztube(d.barZ0, d.brakeZ0 > 0 ? d.brakeZ0 : d.zMuzzle, 0, 0, d.barR0, d.barR1,
        gun, Cgun, { sides: side, wear: .55, wearFreq: 6.5, name: 'barrel' });
    }
    if (d.brakeR > 0) {
      /* muzzle device: a stepped, ported cylinder with a real crown, cut off
         square at the exact OAL. */
      ztube(d.brakeZ0, d.brakeZ1 - 5 * d.mm, 0, 0, d.brakeR, d.brakeR * 0.96,
        gun, Cgun, { sides: side, n: 2.6, tone: 0.80, name: 'brake' });
      ztube(d.brakeZ1 - 5 * d.mm, d.brakeZ1, 0, 0, d.brakeR * 0.96, d.brakeR * 0.72,
        gun, Cgun, { sides: side, n: 2.6, tone: 0.66, name: 'crown' });
      if (Q.detail) for (var pz2 = 0; pz2 < 3; pz2++) {
        var pzz = d.brakeZ0 + (8 + pz2 * 9) * d.mm;
        xbar(-d.brakeR * 1.02, d.brakeR * 1.02, d.brakeR * 0.55, pzz, 1.8 * d.mm,
          gun, [0.01, 0.01, 0.01], 'port');
      }
    }

    /* ================= handguard / forend =============================== */
    if (d.type === 'ak') {
      /* wooden lower handguard: a palm-swelled trough, and the upper gas tube
         cover above the barrel. Two separate pieces, as on the real rifle. */
      addLoft(pile, xf(wm, [0, (d.hgTop + d.hgBot) * 0.5, d.hgZ0], [-PI / 2, 0, 0]), [
        { y: 0, rx: d.hgHW * 0.80, rz: (d.hgTop - d.hgBot) * 0.44, n: 3.4, uv: 0, ao: .84 },
        { y: -(d.hgZ1 - d.hgZ0) * 0.35, rx: d.hgHW, rz: (d.hgTop - d.hgBot) * 0.52, n: 3.6, uv: .35 },
        { y: -(d.hgZ1 - d.hgZ0) * 0.72, rx: d.hgHW * 0.96, rz: (d.hgTop - d.hgBot) * 0.50, n: 3.6, uv: .72 },
        { y: -(d.hgZ1 - d.hgZ0), rx: d.hgHW * 0.74, rz: (d.hgTop - d.hgBot) * 0.40, n: 3.4, uv: 1, ao: .88 }
      ], side, furn, Cfurn, mGun,
        { capStart: true, capEnd: true, wear: .6, wearFreq: 4.4, name: 'handguard' });
      ztube(d.gasZ0, d.gasZ1, 0, d.gasY, d.gasR, d.gasR * 0.94, gun, Cgun,
        { sides: side, tone: 0.92, name: 'gastube' });
      addLoft(pile, xf(wm, [0, d.gasY + 2 * d.mm, d.gasZ0 + 6 * d.mm], [-PI / 2, 0, 0]), [
        { y: 0, rx: d.hgHW * 0.62, rz: 11 * d.mm, n: 3.4, uv: 0, ao: .86 },
        { y: -(d.gasZ1 - d.gasZ0) * 0.55, rx: d.hgHW * 0.68, rz: 13 * d.mm, n: 3.6, uv: .6 },
        { y: -(d.gasZ1 - d.gasZ0) * 0.92, rx: d.hgHW * 0.56, rz: 10 * d.mm, n: 3.4, uv: 1, ao: .9 }
      ], side, furn, Cfurn, mGun, { capStart: true, capEnd: true, wear: .55, wearFreq: 4.8, name: 'uphandguard' });
      /* gas block + front sight tower + hooded post */
      zbox(d.gbZ0, d.gbZ1, 0, (d.gbTop + d.gbBot) * 0.5, d.gbHW, (d.gbTop - d.gbBot) * 0.5,
        gun, Cgun, { cham: 0.30, name: 'gasblock' });
      zbox(d.fsZ0, d.fsZ1, 0, d.fsPost * 0.55, 8 * d.mm, d.fsPost * 0.45,
        gun, Cgun, { cham: 0.30, name: 'fsb' });
      /* THE HOODED FRONT SIGHT. Two ears and a bridge over a thin post: the
         one shape at the muzzle end that says AK rather than "tube". Round 2
         built the base and stopped, so the muzzle end had no silhouette. */
      if (Q.detail) {
        for (var fe = -1; fe <= 1; fe += 2) {
          zbox(d.fsZ0 + 4 * d.mm, d.fsZ1 - 4 * d.mm, fe * 11 * d.mm,
            d.fsPost * 1.10, 3.0 * d.mm, d.fsPost * 0.28,
            gun, Cgun, { cham: 0.40, name: 'fsear' });
        }
        zbox(d.fsZ0 + 6 * d.mm, d.fsZ1 - 6 * d.mm, 0, d.fsPost * 1.34,
          12 * d.mm, 3.0 * d.mm, gun, Cgun, { cham: 0.42, name: 'fshood' });
        /* the post itself, standing inside the hood */
        addLoft(pile, xf(wm, [0, d.fsPost * 0.86, (d.fsZ0 + d.fsZ1) * 0.5]), [
          { y: 0, rx: 1.8 * d.mm, rz: 1.8 * d.mm, n: 2.4, uv: 0 },
          { y: d.fsPost * 0.40, rx: 1.4 * d.mm, rz: 1.4 * d.mm, n: 2.4, uv: 1 }
        ], tiny, gun, Cwear, mGun, { capStart: true, capEnd: true, name: 'fspost' });
      }
      ztube(d.fsZ0 + 12 * d.mm, d.fsZ1 - 10 * d.mm, 0, d.fsPost, 1.6 * d.mm, 1.4 * d.mm,
        gun, Cwear, { sides: 4, name: 'fpost' });
    } else if (d.type === 'shotgun') {
      /* pump forend: ribbed, so it reads as a grip surface and not a pipe */
      addLoft(pile, xf(wm, [0, (d.hgTop + d.hgBot) * 0.5, d.hgZ0], [-PI / 2, 0, 0]), [
        { y: 0, rx: d.hgHW * 0.82, rz: (d.hgTop - d.hgBot) * 0.46, n: 3.6, uv: 0, ao: .84 },
        { y: -(d.hgZ1 - d.hgZ0) * 0.5, rx: d.hgHW, rz: (d.hgTop - d.hgBot) * 0.54, n: 3.8, uv: .5 },
        { y: -(d.hgZ1 - d.hgZ0), rx: d.hgHW * 0.84, rz: (d.hgTop - d.hgBot) * 0.46, n: 3.6, uv: 1, ao: .88 }
      ], side, poly, Cfurn, mGun,
        { capStart: true, capEnd: true, wear: .6, wearFreq: 5.0, name: 'pump' });
      if (Q.detail) for (var rb = 0; rb < 5; rb++) {
        var rz2 = d.hgZ0 + (26 + rb * 34) * d.mm;
        addLoft(pile, xf(wm, [0, (d.hgTop + d.hgBot) * 0.5, rz2], [-PI / 2, 0, 0]), [
          { y: 0, rx: d.hgHW * 1.06, rz: (d.hgTop - d.hgBot) * 0.56, n: 3.8, uv: 0, ao: .7 },
          { y: -9 * d.mm, rx: d.hgHW * 1.06, rz: (d.hgTop - d.hgBot) * 0.56, n: 3.8, uv: 1, ao: .82 }
        ], side, rub, C.rubber, mGun, { tone: 0.86, name: 'rib' });
      }
      /* tube magazine under the barrel + its front cap */
      ztube(d.tubeZ0, d.tubeZ1, 0, d.tubeY, d.tubeR, d.tubeR, gun, Cgun,
        { sides: side, name: 'magtube' });
      ztube(d.tubeZ1, d.tubeZ1 + 16 * d.mm, 0, d.tubeY, d.tubeR * 1.10, d.tubeR * 0.90,
        gun, Cwear, { sides: side, name: 'tubecap' });
      /* barrel/tube clamp and the bead front sight on its ramp */
      xbar(-d.tubeR * 1.3, d.tubeR * 1.3, d.tubeY * 0.5, d.tubeZ1 - 30 * d.mm, 3 * d.mm, gun, Cgun, 'clamp');
      zbox(d.fsZ0, d.fsZ1, 0, d.fsPost * 0.6, 5 * d.mm, d.fsPost * 0.5, gun, Cgun,
        { cham: 0.36, name: 'beadramp' });
    } else {
      /* free-float rail handguard: a slotted tube. The slots are what stop it
         reading as a length of pipe, so they survive to LOD1. */
      addLoft(pile, xf(wm, [0, (d.hgTop + d.hgBot) * 0.5, d.hgZ0], [-PI / 2, 0, 0]), [
        { y: 0, rx: d.hgHW, rz: (d.hgTop - d.hgBot) * 0.5, n: 3.8, uv: 0, ao: .84 },
        { y: -(d.hgZ1 - d.hgZ0) * 0.5, rx: d.hgHW * 0.97, rz: (d.hgTop - d.hgBot) * 0.49, n: 3.8, uv: .5 },
        { y: -(d.hgZ1 - d.hgZ0), rx: d.hgHW * 0.90, rz: (d.hgTop - d.hgBot) * 0.46, n: 3.8, uv: 1, ao: .9 }
      ], side, poly, Cfurn, mGun,
        { capStart: true, capEnd: true, wear: .5, wearFreq: 5.4, name: 'handguard' });
      for (var sl = 0; sl < (Q.detail ? 5 : 3); sl++) {
        var slz = d.hgZ0 + (34 + sl * 46) * d.mm;
        if (slz > d.hgZ1 - 20 * d.mm) break;
        for (var ss = -1; ss <= 1; ss += 2) {
          zbox(slz, slz + 26 * d.mm, ss * d.hgHW * 0.92, d.hgBot * 0.35,
            2.5 * d.mm, 5 * d.mm, poly, Cfurn, { cham: 0.45, tone: 0.42, name: 'mlok' });
        }
      }
    }

    /* ================= top rail ========================================= */
    if (d.type !== 'ak') {
      var railZ0 = d.recZ0 + 24 * d.mm, railZ1 = d.type === 'dmr' ? d.recZ1 : d.hgZ1 - 10 * d.mm;
      zbox(railZ0, railZ1, 0, d.recTop + 5 * d.mm, 10.5 * d.mm, 5 * d.mm,
        gun, Cgun, { cham: 0.34, name: 'rail' });
      if (Q.detail) {
        var nSlot = Math.min(9, Math.max(3, Math.round((railZ1 - railZ0) / (11 * d.mm))));
        for (var rs = 0; rs < nSlot; rs++) {
          var rzz = railZ0 + (rs + 0.5) * (railZ1 - railZ0) / nSlot;
          zbox(rzz - 2.2 * d.mm, rzz + 2.2 * d.mm, 0, d.recTop + 8 * d.mm, 10.8 * d.mm, 3 * d.mm,
            gun, Cgun, { cham: 0.5, tone: 0.44, q: 2, name: 'railslot' });
        }
      }
    } else {
      /* AK rear leaf sight in its block */
      zbox(d.sightZ - 24 * d.mm, d.sightZ + 18 * d.mm, 0, d.recTop + 6 * d.mm,
        9 * d.mm, 7 * d.mm, gun, Cgun, { cham: 0.34, name: 'rearsight' });
      zbox(d.sightZ - 4 * d.mm, d.sightZ + 4 * d.mm, 0, d.sightY, 7 * d.mm, 4 * d.mm,
        gun, Cwear, { cham: 0.42, name: 'rearleaf' });
    }

    /* ================= optic ============================================ */
    if (d.optic === 'reddot' && Q.detail) {
      /* 1.93" high mount: a current, real answer to exactly the head-position
         problem above, and it lifts the sight line 20 mm closer to the eye. */
      var oz = d.recZ1 - 24 * d.mm, oy = d.recTop + 49 * d.mm;
      zbox(oz - 34 * d.mm, oz + 12 * d.mm, 0, oy, 15 * d.mm, 16 * d.mm,
        gun, Cgun, { cham: 0.26, name: 'optic' });
      /* mount legs, so the sight is not floating above the rail */
      zbox(oz - 30 * d.mm, oz - 18 * d.mm, 0, d.recTop + 16 * d.mm, 11 * d.mm, 9 * d.mm,
        gun, Cgun, { cham: 0.3, tone: 0.9, name: 'opticfoot' });
      /* window: dark glass, not an emissive lozenge */
      zbox(oz - 12 * d.mm, oz - 10 * d.mm, 0, oy + 1 * d.mm, 11.5 * d.mm, 12 * d.mm,
        REG.eye, [.055, .060, .058], { cham: 0.4, name: 'opticglass' });
    } else if (d.optic === 'scope') {
      var sz = -10 * d.mm, sy = d.recTop + 34 * d.mm;
      /* two rings + main tube + a fatter objective bell + ocular */
      ztube(sz - 130 * d.mm, sz + 128 * d.mm, 0, sy, 15 * d.mm, 15 * d.mm, gun, Cgun,
        { sides: side, name: 'scopetube' });
      ztube(sz + 128 * d.mm, sz + 190 * d.mm, 0, sy, 15 * d.mm, 24 * d.mm, gun, Cgun,
        { sides: side, name: 'objbell' });
      ztube(sz - 168 * d.mm, sz - 130 * d.mm, 0, sy, 21 * d.mm, 19 * d.mm, gun, Cgun,
        { sides: side, name: 'ocular' });
      if (Q.detail) {
        ztube(sz + 188 * d.mm, sz + 191 * d.mm, 0, sy, 22 * d.mm, 22 * d.mm,
          REG.eye, [.045, .050, .052], { sides: side, name: 'objglass' });
        /* elevation turret */
        addLoft(pile, xf(wm, [0, sy + 14 * d.mm, sz + 34 * d.mm]), [
          { y: 0, rx: 12 * d.mm, rz: 12 * d.mm, n: 2.4, uv: 0, ao: .8 },
          { y: 16 * d.mm, rx: 11 * d.mm, rz: 11 * d.mm, n: 2.4, uv: 1 }
        ], side, gun, Cgun, mGun, { capStart: true, capEnd: true, name: 'turret' });
        addLoft(pile, xf(wm, [14 * d.mm, sy, sz + 34 * d.mm], [0, 0, -PI / 2]), [
          { y: 0, rx: 11 * d.mm, rz: 11 * d.mm, n: 2.4, uv: 0, ao: .8 },
          { y: -14 * d.mm, rx: 10 * d.mm, rz: 10 * d.mm, n: 2.4, uv: 1 }
        ], side, gun, Cgun, mGun, { capStart: true, capEnd: true, name: 'turret2' });
      }
      for (var rg = -1; rg <= 1; rg += 2) {
        zbox(sz + rg * 62 * d.mm - 9 * d.mm, sz + rg * 62 * d.mm + 9 * d.mm, 0,
          (sy + d.recTop) * 0.5, 17 * d.mm, (sy - d.recTop) * 0.5 + 8 * d.mm,
          gun, Cgun, { cham: 0.30, tone: 0.94, name: 'scopering' });
      }
    } else if (d.optic === 'ghost' && Q.detail) {
      addLoft(pile, xf(wm, [0, d.sightY, d.sightZ], [-PI / 2, 0, 0]), [
        { y: 0, rx: 9 * d.mm, rz: 9 * d.mm, n: 2.2, uv: 0 },
        { y: -6 * d.mm, rx: 9 * d.mm, rz: 9 * d.mm, n: 2.2, uv: 1 }
      ], side, gun, Cgun, mGun, { name: 'ghostring' });
      zbox(d.sightZ - 6 * d.mm, d.sightZ + 6 * d.mm, 0, (d.recTop + d.sightY) * 0.5,
        10 * d.mm, (d.sightY - d.recTop) * 0.5, gun, Cgun, { cham: 0.36, name: 'ghostbase' });
    }

    /* ================= magazine =========================================
       THE MAGAZINE IS THE AK. Take the banana out of the outline and the
       silhouette is a generic carbine; round 2 built one, but built it as an
       oblique loft -- rings always perpendicular to Y, so as the arc rolled
       forward the cross-section sheared and the thing read as a flat blade
       hanging off the receiver, "a machete".

       Now it is swept with a real transported frame, on the real arc: 30
       rounds of 7.62x39 stack on a 260 mm radius, so 200 mm of magazine
       leaves the well at 5 deg and arrives at the floorplate at 49 deg,
       174 mm down and 89 mm forward. Those four numbers ARE the banana.  */
    if (d.magLen > 0) {
      var nSec = q === 0 ? 7 : 5, mp = [];
      var mR = d.magCurve, mPhi0 = d.magRake, ms, mt;
      var magSk = subReg(REG.plastic, .1, .55, .35, .4);
      for (ms = 0; ms <= nSec; ms++) {
        mt = ms / nSec;
        var arcS = d.magLen * mt;
        var phi = mPhi0 + arcS / Math.max(1e-4, mR);
        mp.push({
          p: [0,
            d.recBot + 4 * d.mm - mR * (Math.sin(phi) - Math.sin(mPhi0)),
            d.magZ + mR * (Math.cos(mPhi0) - Math.cos(phi))],
          b: [1, 0, 0], n: [0, Math.sin(phi), Math.cos(phi)],
          rw: d.magHW * (1 - mt * 0.06), r: d.magD * 0.5 * (1 - mt * 0.10),
          e: 4.0, uv: mt, ao: 1 - mt * 0.10
        });
      }
      addSweep(pile, wm, mp, side, magSk, C.magazine, mGun,
        { capStart: true, capEnd: true, name: 'magazine' });
      /* floorplate: the hard lip at the bottom, one step wider than the body */
      var mEnd = mp[nSec], mPhi = mPhi0 + d.magLen / Math.max(1e-4, mR);
      var mdz = [-Math.cos(mPhi), Math.sin(mPhi)];
      addSweep(pile, wm, [
        { p: [0, mEnd.p[1] + mdz[0] * 2 * d.mm, mEnd.p[2] + mdz[1] * 2 * d.mm],
          b: [1, 0, 0], n: mEnd.n, rw: d.magHW * 1.16, r: d.magD * 0.54, e: 4.2, uv: 0, ao: .82 },
        { p: [0, mEnd.p[1] + mdz[0] * 12 * d.mm, mEnd.p[2] + mdz[1] * 12 * d.mm],
          b: [1, 0, 0], n: mEnd.n, rw: d.magHW * 1.16, r: d.magD * 0.54, e: 4.2, uv: 1, ao: .70 }
      ], side, magSk, C.magazine, mGun,
        { capStart: true, capEnd: true, name: 'floorplate' });
      /* stiffening ribs down the flank -- three shallow swells, the detail
         that says pressed steel rather than a solid block */
      if (Q.detail) for (var rbi = 1; rbi <= 3; rbi++) {
        var rt = rbi / 4, rphi = mPhi0 + d.magLen * rt / Math.max(1e-4, mR);
        var ry = d.recBot + 4 * d.mm - mR * (Math.sin(rphi) - Math.sin(mPhi0));
        var rz2 = d.magZ + mR * (Math.cos(mPhi0) - Math.cos(rphi));
        for (var rs = -1; rs <= 1; rs += 2) {
          addSweep(pile, wm, [
            { p: [rs * d.magHW * 0.99, ry + Math.cos(rphi) * 9 * d.mm, rz2 - Math.sin(rphi) * 9 * d.mm],
              b: [0, Math.sin(rphi), Math.cos(rphi)], n: [1, 0, 0],
              rw: d.magD * 0.30, r: 1.6 * d.mm, e: 3.0, uv: 0, ao: .78 },
            { p: [rs * d.magHW * 0.99, ry - Math.cos(rphi) * 9 * d.mm, rz2 + Math.sin(rphi) * 9 * d.mm],
              b: [0, Math.sin(rphi), Math.cos(rphi)], n: [1, 0, 0],
              rw: d.magD * 0.30, r: 1.6 * d.mm, e: 3.0, uv: 1, ao: .78 }
          ], tiny, magSk, C.magazine, mGun, { capStart: true, capEnd: true, name: 'magrib' });
        }
      }
    }

    /* ================= pistol grip + trigger group ======================
       Rendered and looked at: the grip was hanging in space 10 mm under the
       receiver with nothing joining the two, and the guard was a shallow
       notch clipped into the receiver's underside rather than a loop with a
       hole in it. Both are silhouette-level errors -- the gap between grip
       and receiver is the first thing that says "assembled from primitives".

       So: a TRIGGER HOUSING that bridges the magazine well to the grip tang
       (which is the part of a real AK the grip screws into), the grip itself
       started INSIDE that housing, and a guard that hangs a full 34 mm below
       the receiver with daylight through it. */
    var thY = d.recBot + 2 * d.mm;                    /* housing roof        */
    zbox(d.tgZ0 - 6 * d.mm, d.tgZ1 + 4 * d.mm, 0, thY - 6 * d.mm,
      d.gripHW * 0.78, 8 * d.mm, gun, Cgun,
      { cham: 0.28, tone: 0.94, name: 'trighousing' });
    /* the grip tang: a short wedge running back and down off the housing,
       which is what the grip actually bolts to */
    zbox(d.gripZ - 22 * d.mm, d.tgZ0 + 2 * d.mm, 0, thY - 16 * d.mm,
      d.gripHW * 0.70, 20 * d.mm, gun, Cgun,
      { cham: 0.34, tone: 0.88, name: 'griptang' });
    addLoft(pile, xf(wm, [0, thY - 8 * d.mm, d.gripZ], [-d.gripRake, 0, 0]), [
      { y: 0, rx: d.gripHW * 0.80, rz: d.gripHD * 0.74, n: 3.4, uv: 0, ao: .70 },
      { y: -d.gripLen * 0.16, rx: d.gripHW * 0.96, rz: d.gripHD * 0.94, n: 3.4, uv: .16, ao: .88 },
      { y: -d.gripLen * 0.38, rx: d.gripHW, rz: d.gripHD, n: 3.4, uv: .38 },
      { y: -d.gripLen * 0.68, rx: d.gripHW * 0.95, rz: d.gripHD * 0.90, n: 3.4, uv: .68 },
      { y: -d.gripLen * 0.94, rx: d.gripHW * 0.98, rz: d.gripHD * 0.84, n: 3.4, uv: .94 },
      { y: -d.gripLen * 1.04, rx: d.gripHW * 0.70, rz: d.gripHD * 0.58, n: 3.2, uv: 1, ao: .76 }
    ], side, rub, C.rubber, mGun,
      { capStart: true, capEnd: true, wear: .5, wearFreq: 6.2, name: 'pistolgrip' });
    /* trigger guard: a real loop -- rear post, bottom bar, front strap, and
       an actual hole between them */
    var tgT = thY - 13 * d.mm;                        /* roof of the bow      */
    var tgB = thY - 42 * d.mm;                        /* bottom of the bow    */
    zbox(d.tgZ0, d.tgZ0 + 9 * d.mm, 0, (tgT + tgB) * 0.5,
      5.5 * d.mm, Math.abs(tgT - tgB) * 0.5, gun, Cgun,
      { cham: 0.40, name: 'tgrear' });
    zbox(d.tgZ0, d.tgZ1, 0, tgB, 5.5 * d.mm, 5 * d.mm,
      gun, Cgun, { cham: 0.45, name: 'tgbottom' });
    zbox(d.tgZ1 - 9 * d.mm, d.tgZ1, 0, (tgT + tgB) * 0.5,
      5.5 * d.mm, Math.abs(tgT - tgB) * 0.5, gun, Cgun,
      { cham: 0.40, name: 'tgfront' });
    /* the trigger itself, hanging into the bow with air around it */
    zbox(d.tgZ0 + 15 * d.mm, d.tgZ0 + 24 * d.mm, 0, thY - 24 * d.mm, 3 * d.mm, 13 * d.mm,
      gun, Cwear, { cham: 0.45, tone: 1.06, name: 'trigger' });
    /* sling loops: front on the gas block / barrel band, rear on the stock or
       the buffer end. Two small hard rings that break the outline at the two
       points a rifle's outline is otherwise a straight line. */
    if (Q.detail && d.slingF) {
      xbar(-d.recHW * 0.30, d.recHW * 0.30, d.recBot - 14 * d.mm, d.slingF, 2.4 * d.mm,
        gun, Cwear, 'slingloopF');
      xbar(-d.recHW * 0.30, d.recHW * 0.30, d.stockDrop - 22 * d.mm, d.slingR, 2.4 * d.mm,
        gun, Cwear, 'slingloopR');
    }

    /* ================= stock ============================================ */
    if (d.stock === 'collapsible') {
      /* buffer tube + a slider that actually surrounds it */
      ztube(d.recZ0, d.zButt + 26 * d.mm, 0, d.combY * 0.5, 15 * d.mm, 15 * d.mm,
        gun, Cgun, { sides: side, name: 'buffertube' });
      addLoft(pile, xf(wm, [0, d.combY * 0.5, d.zButt + 120 * d.mm], [-PI / 2, 0, 0]), [
        { y: 0, rx: 21 * d.mm, rz: 20 * d.mm, n: 3.6, uv: 0, ao: .86 },
        { y: -46 * d.mm, rx: 23 * d.mm, rz: 26 * d.mm, n: 3.6, uv: .45 },
        { y: -104 * d.mm, rx: d.buttHW, rz: d.buttHH * 0.52, n: 3.8, uv: 1, ao: .82 }
      ], side, poly, Cfurn, mGun, { capStart: true, wear: .5, wearFreq: 5.0, name: 'stockslide' });
      /* cheek shelf: what the cheek weld actually rests on */
      zbox(d.zButt + 44 * d.mm, d.zButt + 150 * d.mm, 0, d.combY + 16 * d.mm,
        11 * d.mm, 8 * d.mm, poly, Cfurn, { cham: 0.34, tone: 0.94, name: 'comb' });
    } else if (d.stock === 'chassis') {
      /* precision chassis: straight comb, adjustable riser, thumbhole gap */
      zbox(d.zButt + 30 * d.mm, d.recZ0 + 10 * d.mm, 0, d.stockDrop + 6 * d.mm,
        d.buttHW * 0.86, 30 * d.mm, poly, Cfurn,
        { cham: 0.24, wear: .45, wearFreq: 4.6, name: 'chassis' });
      zbox(d.zButt + 60 * d.mm, d.zButt + 210 * d.mm, 0, d.combY + 14 * d.mm,
        13 * d.mm, 16 * d.mm, poly, Cfurn, { cham: 0.30, tone: 1.06, name: 'cheekriser' });
      /* two riser posts, so the comb is adjustable rather than moulded on */
      if (Q.detail) for (var cp = 0; cp < 2; cp++) {
        addLoft(pile, xf(wm, [0, d.combY - 6 * d.mm, d.zButt + (78 + cp * 112) * d.mm]), [
          { y: 0, rx: 4 * d.mm, rz: 4 * d.mm, n: 2.4, uv: 0 },
          { y: 22 * d.mm, rx: 4 * d.mm, rz: 4 * d.mm, n: 2.4, uv: 1 }
        ], tiny, gun, Cgun, mGun, { capStart: true, capEnd: true, name: 'riserpost' });
      }
    } else {
      /* FIXED STOCK -- swept butt-to-wrist with a real frame, so the profile
         is a stock and not a broom handle. A stock is not a constant tube:
         it is 108 mm tall at the buttplate, necks to a 48 mm wrist behind
         the trigger, and its centreline DROPS 26 mm below the bore so the
         butt sits in the shoulder pocket while the sight line stays on the
         eye. Those three facts are the whole silhouette. */
      var stZ = [d.zButt, d.zButt + 30 * d.mm, d.zButt + 100 * d.mm,
                 d.zButt + 168 * d.mm, d.zButt + 228 * d.mm, d.recZ0 + 10 * d.mm];
      var stHH = [d.buttHH * 0.50, d.buttHH * 0.48, d.buttHH * 0.37,
                  d.buttHH * 0.26, d.buttHH * 0.23, d.buttHH * 0.25];
      var stHW = [d.buttHW, d.buttHW * 1.02, d.buttHW * 0.98,
                  d.buttHW * 0.86, d.buttHW * 0.88, d.buttHW * 0.94];
      var stY = [d.stockDrop, d.stockDrop * 0.94, d.stockDrop * 0.72,
                 d.stockDrop * 0.42, d.stockDrop * 0.18, 0];
      var stP = [], sti;
      for (sti = 0; sti < stZ.length; sti++)
        stP.push({
          p: [0, stY[sti], stZ[sti]], b: [1, 0, 0], n: [0, 1, 0],
          rw: stHW[sti], r: stHH[sti], e: 3.6,
          uv: sti / (stZ.length - 1), ao: .84 + sti * .02
        });
      addSweep(pile, wm, stP, side, furn, Cfurn, mGun,
        { capStart: true, capEnd: true, name: 'stock' });
      /* comb: the raised edge the cheek actually welds to */
      zbox(d.zButt + 46 * d.mm, d.recZ0 - 24 * d.mm, 0, d.combY, d.buttHW * 0.58, 9 * d.mm,
        furn, Cfurn, { cham: 0.36, tone: 1.05, name: 'comb' });
      /* sling slot through the wrist -- the hole is what says "AK butt" */
      if (Q.detail) {
        zbox(d.zButt + 106 * d.mm, d.zButt + 154 * d.mm, 0, d.stockDrop * 0.60,
          d.buttHW * 1.02, 7 * d.mm, gun, [.012, .012, .012],
          { cham: 0.40, tone: 0.5, name: 'slingslot' });
      }
    }
    /* recoil pad -- a soft, slightly proud slab, dead square to the shoulder */
    zbox(d.zButt, d.zButt + 22 * d.mm, 0, d.stockDrop, d.buttHW * 1.04, d.buttHH * 0.54,
      rub, C.rubber, { cham: 0.28, tone: 0.74, name: 'recoilpad' });

    /* ================= bipod ============================================ */
    if (d.bipod && Q.detail) {
      zbox(d.hgZ1 - 40 * d.mm, d.hgZ1 - 6 * d.mm, 0, d.hgBot - 6 * d.mm, 12 * d.mm, 9 * d.mm,
        gun, Cgun, { cham: 0.3, name: 'bipodhead' });
      for (var bl = -1; bl <= 1; bl += 2) {
        addLoft(pile, xf(wm, [bl * 10 * d.mm, d.hgBot - 12 * d.mm, d.hgZ1 - 22 * d.mm],
          [0.30, 0, bl * 0.42]), [
          { y: 0, rx: 4.5 * d.mm, rz: 4.5 * d.mm, n: 2.6, uv: 0, ao: .8 },
          { y: -96 * d.mm, rx: 3.6 * d.mm, rz: 3.6 * d.mm, n: 2.6, uv: .8 },
          { y: -110 * d.mm, rx: 6.0 * d.mm, rz: 6.0 * d.mm, n: 2.6, uv: 1, ao: .7 }
        ], tiny, gun, Cgun, mGun, { capStart: true, capEnd: true, name: 'bipodleg' });
      }
    }

    /* ================= sling mounts ===================================== */
    if (Q.detail) {
      addLoft(pile, xf(wm, [0, d.hgBot - 4 * d.mm, d.slingF], [0, PI / 2, 0]), [
        { y: -7 * d.mm, rx: 2.4 * d.mm, rz: 2.4 * d.mm, n: 2.4, uv: 0 },
        { y: 7 * d.mm, rx: 2.4 * d.mm, rz: 2.4 * d.mm, n: 2.4, uv: 1 }
      ], tiny, gun, Cwear, mGun, { capStart: true, capEnd: true, name: 'slingF' });
      addLoft(pile, xf(wm, [0, d.stockDrop + 26 * d.mm, d.slingR], [0, PI / 2, 0]), [
        { y: -7 * d.mm, rx: 2.4 * d.mm, rz: 2.4 * d.mm, n: 2.4, uv: 0 },
        { y: 7 * d.mm, rx: 2.4 * d.mm, rz: 2.4 * d.mm, n: 2.4, uv: 1 }
      ], tiny, gun, Cwear, mGun, { capStart: true, capEnd: true, name: 'slingR' });
    }
  }


  /* =========================================================================
     6. CHARACTER ASSETS + MATERIAL SET
     ====================================================================== */
  var ASSET = {};       /* per kind */
  var MATS = {};        /* kind -> [variant] */
  var USE_PHYSICAL = true;

  function detectPhysical() {
    try {
      if (!THREE.MeshPhysicalMaterial) return false;
      var p = new THREE.MeshPhysicalMaterial();
      var ok = ('sheenColor' in p) && ('sheenColorMap' in p) &&
        ('clearcoatMap' in p) && ('clearcoatRoughnessMap' in p);
      p.dispose();
      var qual = (NZ.render && NZ.render.quality) || 'high';
      return ok && qual !== 'low';
    } catch (e) { return false; }
  }

  function makeMaterials(kind) {
    var glow = getECFG()[kind].glow;
    var out = [];
    for (var v = 0; v < 3; v++) {
      var hshift = (v - 1) * 0.026, l = (v - 1) * 0.038;
      var c = new THREE.Color(1, 1, 1);
      c.offsetHSL(hshift, v === 2 ? -0.09 : 0.02, l);
      var params = {
        color: c,
        map: ATLAS.map,
        normalMap: ATLAS.normalMap,
        roughnessMap: ATLAS.orm,
        metalnessMap: ATLAS.orm,
        aoMap: ATLAS.orm,
        aoMapIntensity: 1.0,
        emissiveMap: ATLAS.emissiveMap,
        /* Desaturated hard, and dim: CS2 is not lit by its characters. The
           config hue survives only as a faint tint on the strobe so the four
           roles stay tellable apart at night without any of them being a
           light source. */
        emissive: new THREE.Color(
          0.72 + glow[0] * 0.28, 0.72 + glow[1] * 0.28, 0.72 + glow[2] * 0.28
        ).multiplyScalar(0.16),
        emissiveIntensity: 0.55,
        roughness: 1.0, metalness: 1.0,
        envMapIntensity: 1.0,
        vertexColors: true, dithering: true, fog: true,
        side: THREE.FrontSide
      };
      var m;
      if (USE_PHYSICAL) {
        /* r149: sheenColor is multiplied by sheenColorMap and clearcoat by
           clearcoatMap.r / clearcoatRoughnessMap.g, so the two small atlases
           give every region its own specular behaviour from one material. */
        params.sheen = 1.0;
        params.sheenColor = new THREE.Color(1, 1, 1);
        params.sheenColorMap = ATLAS.sheenMap;
        params.sheenRoughness = 0.58;
        params.clearcoat = 1.0;
        params.clearcoatMap = ATLAS.ccMap;
        params.clearcoatRoughness = 1.0;
        params.clearcoatRoughnessMap = ATLAS.ccMap;
        m = new THREE.MeshPhysicalMaterial(params);
      } else {
        m = new THREE.MeshStandardMaterial(params);
      }
      m.normalScale.set(1.0, 1.0);
      m.name = 'nz-' + kind + '-' + v;
      out.push(m);
    }
    return out;
  }

  /* Skin-matrix set for an arbitrary pose (bone world * bind inverse). */
  function poseMatrices(spec, tpl, poseFn) {
    var objs = [], i, root = new THREE.Object3D();
    for (i = 0; i < spec.list.length; i++) {
      var d = spec.list[i], o = new THREE.Object3D();
      o.position.set(d.p[0], d.p[1], d.p[2]);
      o.rotation.set(d.r[0], d.r[1], d.r[2]);
      objs.push(o);
      if (d.parent < 0) root.add(o); else objs[d.parent].add(o);
    }
    if (poseFn) poseFn(objs, spec.idx);
    root.updateMatrixWorld(true);
    var mats = [];
    for (i = 0; i < spec.list.length; i++)
      mats.push(new THREE.Matrix4().multiplyMatrices(objs[i].matrixWorld, tpl.inverses[i]));
    return mats;
  }
  function posePositions(pile, W, mats) {
    lazyTemps();
    var n = pile.n, out = new Float32Array(n * 3), i, k;
    var v = _lv.v, acc = _lv.v2;
    for (i = 0; i < n; i++) {
      acc.set(0, 0, 0);
      for (k = 0; k < 4; k++) {
        var w = W.sw[i * 4 + k]; if (w <= 0) continue;
        v.set(pile.p[i * 3], pile.p[i * 3 + 1], pile.p[i * 3 + 2]).applyMatrix4(mats[W.si[i * 4 + k]]);
        acc.addScaledVector(v, w);
      }
      out[i * 3] = acc.x; out[i * 3 + 1] = acc.y; out[i * 3 + 2] = acc.z;
    }
    return out;
  }
  /* The AO bake pose. In BIND pose the upper arm is buried inside the rib
     silhouette and the slung rifle lies flat against the chest, so a bind-pose
     bake would burn a permanent black band down both flanks and across the
     belly -- and those shadows would then travel with the arms when the
     character raises the weapon. Arms out ~40 degrees, forearms opened, gun
     pushed clear: enough to expose the flank, not so much that the armpit
     stops being an armpit. */
  function aoPoseBiped(o, ix) {
    o[ix.armL].rotation.set(-0.06, 0, -0.74);
    o[ix.armR].rotation.set(-0.06, 0, 0.74);
    o[ix.foreL].rotation.set(0.30, 0, -0.10);
    o[ix.foreR].rotation.set(0.30, 0, 0.10);
    if (ix.weapon !== undefined) {
      o[ix.weapon].position.z += 1.5;
      o[ix.weapon].position.y += 0.5;
    }
  }

  function buildAsset(kind) {
    /* Contract C1: `octa` is a ground biped now. There is exactly one skeleton,
       one geometry builder, one locomotion solver and one ragdoll spec for the
       whole cast -- which is also why the four of them cannot drift apart. */
    var bones = bipedBones(SPEC[kind]);
    var tpl = buildSkeletonTemplate(bones);
    var a = { kind: kind, spec: bones, tpl: tpl, geo: [], nBones: bones.list.length, tris: [] };
    var aoMats = poseMatrices(bones, tpl, aoPoseBiped);

    for (var q = 0; q < 3; q++) {
      var pile = buildBiped(kind, tpl, q);
      var W = skinWeights(pile, tpl.segs);
      /* model-scale occlusion, solved on the assembled figure */
      try {
        var aoSrc = pile;
        if (aoMats) aoSrc = { n: pile.n, idx: pile.idx, col: pile.col, p: posePositions(pile, W, aoMats) };
        /* Cavity AO strength. Raised from 0.66 after looking at the face on
           the calibrated stage: skin under a hat brim, the gap behind a mag
           pouch and the seat of the plate against the ribs were all reading
           as lit as the surfaces around them, and cavity darkening is the
           only thing in the whole shading stack that can separate them. */
        bakeAO(aoSrc, SPEC[kind].H || 6.2, 0.80);
      } catch (aoErr) { console.warn('[nz-enemies] AO bake skipped for ' + kind + ' lod' + q + ':', aoErr); }
      var g = pileToGeometry(pile, tpl.segs, W);
      /* hue variation inside every part -- see weatherPile */
      try { weatherPile(g, pile, SPEC[kind].H, SPEC[kind].mpm, KINDS.indexOf(kind) + 1); }
      catch (wErr) { console.warn('[nz-enemies] weathering skipped for ' + kind + ':', wErr); }
      /* Hard requirement, verified rather than assumed: r149 samples aoMap
         through vUv2, so a geometry without uv2 reads one texel of the atlas
         forever and the AO map silently does nothing. */
      if (!g.attributes.uv2) {
        console.error('[nz-enemies] geometry ' + kind + ' lod' + q + ' had no uv2 - repaired from uv');
        g.setAttribute('uv2', g.attributes.uv);
      }
      /* inflate the bind-pose sphere so animation never pops it out of view */
      g.computeBoundingSphere();
      if (g.boundingSphere) g.boundingSphere.radius *= 1.55;
      g.computeBoundingBox();
      a.geo.push(g);
      a.tris.push(g.index ? g.index.count / 3 : 0);
    }
    a.verts = a.geo[0].attributes.position.count;
    a.mats = MATS[kind] = makeMaterials(kind);

    /* far LOD static poses baked out of the LOD2 skinned geometry. Four walk
       phases (not two) so the instanced pose is never more than a quarter
       cycle away from the skinned pose it replaces. */
    a.far = [];
    for (var p = 0; p < 4; p++)
      a.far.push(bakePose(a, bipedWalk(p * PI / 2), true));
    /* The dead bake also hands back its own ragdoll-anchor centroid and lie
       direction. farUpdate() needs both to drop the instanced corpse onto the
       exact spot, heading and ground plane the skinned ragdoll settled on --
       without them the two LODs disagree by the distance the body travelled
       as it fell, which is the 0.66 m pop VERIFY measured. */
    a.deadRef = {};
    a.far.push(bakePose(a, deadPose, true, a.deadRef));
    /* ...and a CROUCHED one. The AI crouches for accuracy from about 46 units
       and the far LOD starts at 72, so without this the operator who is
       fighting from cover at 25 m renders his full standing height while his
       hit capsule is 33% shorter -- the player aims at a head that is not
       where the capsule says it is, and calls it desync. */
    a.far.push(bakePose(a, crouchPose, true));
    a.farMesh = [null, null, null, null, null, null];
    return a;
  }

  /* ---- CPU skin a fixed pose into a static geometry ------------------- */
  function bakePose(asset, poseFn, ground, refOut) {
    lazyTemps();
    var spec = asset.spec, list = spec.list, n = list.length;
    var objs = [], i;
    var root = new THREE.Object3D();
    for (i = 0; i < n; i++) {
      var d = list[i], o = new THREE.Object3D();
      o.position.set(d.p[0], d.p[1], d.p[2]);
      o.rotation.set(d.r[0], d.r[1], d.r[2]);
      objs.push(o);
      if (d.parent < 0) root.add(o); else objs[d.parent].add(o);
    }
    poseFn(objs, spec.idx, asset);
    root.updateMatrixWorld(true);
    var mats = [];
    for (i = 0; i < n; i++) mats.push(new THREE.Matrix4().multiplyMatrices(objs[i].matrixWorld, asset.tpl.inverses[i]));

    var src = asset.geo[2];
    var pos = src.attributes.position.array;
    var si = src.attributes.skinIndex.array, sw = src.attributes.skinWeight.array;
    var cnt = src.attributes.position.count;
    var outP = new Float32Array(cnt * 3);
    var v = _lv.v, acc = _lv.v2;
    for (i = 0; i < cnt; i++) {
      acc.set(0, 0, 0);
      for (var k = 0; k < 4; k++) {
        var w = sw[i * 4 + k]; if (w <= 0) continue;
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(mats[si[i * 4 + k]]);
        acc.addScaledVector(v, w);
      }
      outP[i * 3] = acc.x; outP[i * 3 + 1] = acc.y; outP[i * 3 + 2] = acc.z;
    }
    /* Land the baked pose on y=0. The far LOD is placed at the actor's feet,
       so any residual bind-pose droop (a digitigrade claw, a settled corpse)
       would otherwise push the instanced copy through the floor. */
    var lo = 0;
    if (ground) {
      lo = Infinity;
      for (i = 1; i < outP.length; i += 3) if (outP[i] < lo) lo = outP[i];
      if (isFinite(lo)) { for (i = 1; i < outP.length; i += 3) outP[i] -= lo; }
      else lo = 0;
    }
    /* Reference frame of this bake, measured on the SAME sixteen anchors the
       ragdoll solver uses, so the two are directly comparable. Model space,
       after grounding. */
    if (refOut) {
      var rs = ragdollSpecBiped(), HH = (SPEC[asset.kind] && SPEC[asset.kind].H) || 6.2;
      var sx = 0, sy = 0, sz = 0, rp = null, rh = null;
      for (i = 0; i < rs.length; i++) {
        var sc2 = rs[i], ob = objs[spec.idx[sc2[1]]];
        var ev = _lv.v.set(0, 0, 0);
        if (sc2[2]) {
          var ext = (sc2[1] === 'head' ? 0.070 : 0.045) * HH;
          ev.set(0, sc2[1] === 'head' ? ext : -ext, 0);
        }
        ob.localToWorld(ev);
        sx += ev.x; sy += ev.y - lo; sz += ev.z;
        if (sc2[0] === 'pelvis') rp = [ev.x, ev.y - lo, ev.z];
        if (sc2[0] === 'head') rh = [ev.x, ev.y - lo, ev.z];
      }
      refOut.cx = sx / rs.length; refOut.cy = sy / rs.length; refOut.cz = sz / rs.length;
      /* which way the body lies: pelvis -> head, projected on the floor */
      refOut.yaw = (rp && rh) ? Math.atan2(rh[0] - rp[0], rh[2] - rp[2]) : 0;
      refOut.ok = true;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(outP, 3));
    var uvA = new THREE.BufferAttribute(new Float32Array(src.attributes.uv.array), 2);
    g.setAttribute('uv', uvA);
    g.setAttribute('uv2', uvA);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(src.attributes.color.array), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(src.index.array), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  /* poses used only for the far LOD bake ------------------------------- */
  /* Static carry pose for the instanced far LOD. The weapon has to be
     MOUNTED here too: its bind position puts the trigger in front of the
     chest, which with a real 880 mm rifle leaves 350 mm of buttstock sticking
     out of the operator's back. At LOD2 the hands are two pixels but the
     rifle is a hard black line across the silhouette, so it is the one thing
     that must be right. Solved exactly the way the live mount is: butt into
     the shoulder pocket, muzzle depressed to a low ready. */
  function carryWeapon(o, ix, kind) {
    var sp = SPEC[kind], gd = sp && sp.grip;
    if (!gd || ix.weapon === undefined) return;
    var H = sp.H, pitch = 0.34;                    /* muzzle down, low ready */
    var cp = Math.cos(pitch), sp2 = Math.sin(pitch);
    var by = gd.butt[1], bz = gd.butt[2];
    var ry = by * cp - bz * sp2, rz = by * sp2 + bz * cp;
    o[ix.weapon].position.set(
      sp.shoulderX + sp.armOut * 0.48,
      sp.shoulderY + 0.010 * H - ry,
      sp.chestD * 0.46 - rz
    );
    o[ix.weapon].rotation.set(pitch, -0.12, -0.20);
  }
  function armsReady(o, ix, kind) {
    o[ix.clavL].rotation.set(-0.08, 0.46, -0.08);
    o[ix.clavR].rotation.set(-0.08, -0.14, 0.04);
    /* starting guess only -- the solve below replaces both of these */
    o[ix.armL].rotation.set(-1.16, 0.42, 0.46);
    o[ix.foreL].rotation.set(1.30, 0.10, 0.0);
    o[ix.armR].rotation.set(-0.86, -0.22, -0.50);
    o[ix.foreR].rotation.set(1.34, -0.10, 0.0);
    o[ix.spine].rotation.set(0.04, 0.06, 0);
    o[ix.spine2].rotation.set(0.02, 0.05, 0);
    o[ix.chest].rotation.set(-0.03, 0.10, 0);
    if (ix.trigR !== undefined) o[ix.trigR].rotation.set(-0.30, 0, 0);
    carryWeapon(o, ix, kind);

    /* THE HANDS ARE IK'd IN THE STATIC BAKE TOO.
       The far LOD is where a silhouette error is LEAST forgivable, because
       it is the only thing left: at 72 units the operator is a dark shape
       with a rifle across it, and a hand hanging 60 mm off the handguard
       reads as a break in that shape even when the fingers are one pixel.
       The eyeballed Euler triples above were within about a hand-width of
       the grips, which was visible as a gap under the forend. Same solver,
       same grip points from the same GUNDIM table as the live pose -- so
       the bake and the skinned pose cannot drift apart. */
    var spk = SPEC[kind], gd = spk && spk.grip;
    if (!gd || ix.weapon === undefined) return;
    lazyTemps();
    if (!DOWN) initAxes();
    var rt = o[ix.hips];
    while (rt.parent) rt = rt.parent;
    rt.updateMatrixWorld(true);
    var W = o[ix.weapon], tv = _lv.v, iv = _lv.m, sIdx, Nn, gp;
    for (sIdx = 0; sIdx < 2; sIdx++) {
      Nn = sIdx ? 'R' : 'L';
      gp = sIdx ? gd.r : gd.l;                 /* trigger hand / support hand */
      tv.set(gp[0], gp[1], gp[2]).applyMatrix4(W.matrixWorld);
      iv.copy(o[ix['clav' + Nn]].matrixWorld).invert();
      tv.applyMatrix4(iv);                     /* into the arm's PARENT space */
      solveTwoBone(o[ix['arm' + Nn]], o[ix['fore' + Nn]], tv.x, tv.y, tv.z,
        sIdx ? -0.35 : 0.45, spk.upperArm, spk.foreArm);
      /* wrist: roll the palm onto the grip. One constant per side is enough
         at this range and it stops the hand reading as a flat paddle. */
      o[ix['hand' + Nn]].rotation.set(sIdx ? 0.22 : 0.34, sIdx ? -0.18 : 0.26,
        sIdx ? -0.30 : 0.34);
      o[ix['fing' + Nn]].rotation.set(0.62, 0, 0);
    }
    rt.updateMatrixWorld(true);
  }
  function bipedWalk(ph) {
    return function (o, ix, asset) {
      armsReady(o, ix, asset && asset.kind);
      var sL = Math.sin(ph), sR = Math.sin(ph + PI);
      var kL = Math.max(0, -Math.sin(ph - 0.7)) * 1.05;
      var kR = Math.max(0, -Math.sin(ph + PI - 0.7)) * 1.05;
      o[ix.thighL].rotation.x = sL * 0.50; o[ix.shinL].rotation.x = kL;
      o[ix.footL].rotation.x = -sL * 0.28 - kL * 0.45;
      o[ix.thighR].rotation.x = sR * 0.50; o[ix.shinR].rotation.x = kR;
      o[ix.footR].rotation.x = -sR * 0.28 - kR * 0.45;
      o[ix.toeL].rotation.x = 0; o[ix.toeR].rotation.x = 0;
      o[ix.hips].position.y -= 0.055 + Math.cos(ph * 2) * 0.030;
      o[ix.hips].rotation.set(-0.04, -Math.sin(ph) * 0.10, Math.sin(ph) * 0.05);
      void asset;
    };
  }
  /* Far-LOD crouch. Same shape the live solver makes: hips half a leg down
     and back, trunk pitched forward over the knees, track widened, weapon
     still up and welded -- armsReady runs FIRST so the mount and the two
     hand solves happen before the trunk and hips move, and since the arms and
     the weapon all hang off the chest they then travel together. */
  function crouchPose(o, ix, asset) {
    armsReady(o, ix, asset && asset.kind);
    var spc = asset && SPEC[asset.kind];
    var leg = spc ? (spc.thigh + spc.shin) : 3.0, Hh = spc ? spc.H : 6.2;
    /* A TACTICAL CROUCH IS A HALF SQUAT. Round 2 dropped the hips half a leg
       length -- 530 mm -- which puts the buttocks on the heels: that is a
       resting squat, and a man in it cannot move, cannot absorb recoil and
       cannot stand up quickly. A shooter's crouch takes the hips from 940 mm
       to about 640 mm (0.375 of leg length), leaves 80 deg in the knee, keeps
       the shins near vertical and pitches the TRUNK forward over the feet so
       the centre of mass stays inside the base. */
    o[ix.hips].position.y -= leg * 0.375;
    o[ix.hips].position.z -= Hh * 0.028;
    o[ix.hips].rotation.set(-0.18, 0, 0);
    o[ix.spine].rotation.set(0.16, 0.02, 0);
    o[ix.spine2].rotation.set(0.17, 0.04, 0);
    o[ix.chest].rotation.set(0.15, 0.10, 0);
    o[ix.neck].rotation.set(-0.24, 0, 0);
    o[ix.head].rotation.set(-0.22, 0, 0);
    o[ix.thighL].rotation.set(0.80, 0.10, -0.20);
    o[ix.thighR].rotation.set(0.72, -0.10, 0.20);
    o[ix.shinL].rotation.set(1.10, 0, 0);
    o[ix.shinR].rotation.set(1.02, 0, 0);
    o[ix.footL].rotation.set(-0.32, 0, 0);
    o[ix.footR].rotation.set(-0.30, 0, 0);
    o[ix.toeL].rotation.x = 0; o[ix.toeR].rotation.x = 0;
  }
  function deadPose(o, ix, asset) {
    /* the dropped rifle lies flat beside the body, not floating in the pose
       it was carried in */
    /* A SETTLED CORPSE, not a folded heap. Round 2 pitched the hips 83 deg
       and then bent every limb again ON TOP of that, and the rotations
       stacked: the body ended up on its side with one leg vertical, the neck
       twisted under the chest and visible daylight between torso segments.

       This is a man who has fallen backwards and stopped moving. Supine,
       rolled 10 deg onto the right hip, head lolled to one side ON the
       floor, the right arm thrown out flat and the left folded across the
       abdomen, knees fallen apart with a few degrees of residual flexion,
       feet everted. No joint here is outside a human range, and the six
       points that carry a body on a hard floor -- both shoulder blades, the
       sacrum, both heels and one elbow -- are all on the ground plane. */
    var spd = asset && SPEC[asset.kind];
    if (spd && ix.weapon !== undefined) {
      o[ix.weapon].position.set(spd.chestW * 1.55, -spd.shoulderY + 0.020 * spd.H, 0.11 * spd.H);
      o[ix.weapon].rotation.set(1.50, 0.62, 0.08);
    }
    o[ix.hips].position.y = spd ? spd.H * 0.031 : 0.19;
    o[ix.hips].rotation.set(-1.53, 0.14, 0.17);
    /* the lumbar stays hollow -- a body on concrete is not a flat plank */
    o[ix.spine].rotation.set(-0.09, 0.03, 0.05);
    o[ix.spine2].rotation.set(-0.06, 0.05, 0.03);
    o[ix.chest].rotation.set(0.05, 0.06, -0.05);
    o[ix.neck].rotation.set(0.14, 0.44, 0.06);
    if (ix.head !== undefined) o[ix.head].rotation.set(0.10, 0.40, 0.12);
    /* right arm thrown out flat, left folded onto the belly */
    o[ix.armR].rotation.set(0.12, -0.26, -1.30);
    o[ix.foreR].rotation.set(0.48, 0, 0);
    o[ix.armL].rotation.set(-0.46, 0.50, 0.90);
    o[ix.foreL].rotation.set(1.28, 0, 0);
    /* legs flat, knees fallen outward, a little residual flexion */
    o[ix.thighL].rotation.set(-0.06, 0.10, 0.30);
    o[ix.shinL].rotation.set(0.30, 0, 0);
    o[ix.footL].rotation.set(0.22, 0.26, 0);
    o[ix.thighR].rotation.set(0.02, -0.12, -0.24);
    o[ix.shinR].rotation.set(0.18, 0, 0);
    o[ix.footR].rotation.set(0.28, -0.30, 0);
  }

  /* =========================================================================
     7. SKINNED CHARACTER POOL
     ====================================================================== */
  var POOL = {};        /* kind -> { free: [], all: [] } */
  var IDENTITY = null;

  function makeCharacter(kind, tier) {
    var a = ASSET[kind];
    var grp = new THREE.Group();
    grp.name = 'nz-char-' + kind;
    var bones = [], i;
    for (i = 0; i < a.spec.list.length; i++) {
      var d = a.spec.list[i], b = new THREE.Bone();
      b.name = d.name;
      b.position.set(d.p[0], d.p[1], d.p[2]);
      b.rotation.set(d.r[0], d.r[1], d.r[2]);
      bones.push(b);
      if (d.parent < 0) grp.add(b); else bones[d.parent].add(b);
    }
    var sk = new THREE.Skeleton(bones, a.tpl.inverses);
    var mesh = new THREE.SkinnedMesh(a.geo[tier], a.mats[0]);
    grp.add(mesh);
    /* explicit identity bind matrix: the inverses were baked in model space,
       and bindMode 'attached' recomputes bindMatrixInverse from matrixWorld
       every frame, so any root transform cancels exactly. */
    mesh.bind(sk, IDENTITY);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;   /* it never moves inside its group */
    mesh.updateMatrix();
    /* both skinned tiers cast: a shadow that vanishes at the LOD boundary is
       just as visible a pop as a silhouette change */
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    /* The muzzle anchor sits at the ACTUAL modelled muzzle, so tracers and
       flash originate from the crown of the barrel rather than from a guessed
       point in front of the chest. Its local +Z is the bore axis. */
    var muzzleAnchor = new THREE.Object3D();
    var gd = SPEC[kind] && SPEC[kind].grip;
    var wBone = bones[a.spec.idx.weapon];
    if (gd) muzzleAnchor.position.set(gd.muzzle[0], gd.muzzle[1], gd.muzzle[2]);
    else muzzleAnchor.position.set(0, 0.006 * 6.2, 0.352 * 6.2);
    muzzleAnchor.name = 'muzzle';
    wBone.add(muzzleAnchor);
    /* Named contact anchors. These are the two points a hand physically
       touches -- the web of the trigger hand on the pistol grip and the
       palm of the support hand on the handguard -- as opposed to the WRIST
       targets the IK solves onto. Publishing them means the validation
       harness measures the real contact rather than inferring a centroid
       from the weapon's vertex cloud, and it gives the AI agent a stable
       place to hang an effect. */
    var anchors = [];
    if (gd) {
      var mk = function (nm, p) {
        var o = new THREE.Object3D(); o.name = nm;
        o.position.set(p[0], p[1], p[2]); wBone.add(o); anchors.push(o); return o;
      };
      mk('grip_trigger', gd.rPt);
      mk('grip_support', gd.lPt);
      mk('stock_butt', gd.butt);
      mk('sight_line', gd.sight);
    }
    return {
      kind: kind, tier: tier, group: grp, mesh: mesh, bones: bones, skeleton: sk,
      idx: a.spec.idx, anchor: muzzleAnchor, anchors: anchors, busy: false
    };
  }

  var MAX_SKIN = [6, 10];   /* tier0, tier1 concurrent skinned characters */
  function acquireChar(kind, tier) {
    var key = kind + tier;
    var p = POOL[key] || (POOL[key] = { free: [], all: [] });
    if (p.free.length) return p.free.pop();
    if (p.all.length >= MAX_SKIN[tier] + 1) return null;
    var c = makeCharacter(kind, tier);
    p.all.push(c);
    return c;
  }
  function releaseChar(c) {
    if (!c) return;
    if (c.group.parent) c.group.parent.remove(c.group);
    POOL[c.kind + c.tier].free.push(c);
  }

  /* =========================================================================
     8. GAME GLOBAL ACCESS
     Top-level const/let in a classic script live in the global lexical scope,
     so they resolve by bare name from this file. Everything is probed once.
     ====================================================================== */
  var G = {};
  function getECFG() { return G.ECFG; }
  function probeGlobals() {
    /* eslint-disable no-undef */
    G.ECFG = (typeof ECFG !== 'undefined') ? ECFG : null;
    G.ERIG = (typeof ERIG !== 'undefined') ? ERIG : null;
    G.enemies = (typeof enemies !== 'undefined') ? enemies : null;
    G.player = (typeof player !== 'undefined') ? player : null;
    G.EYE = (typeof EYE !== 'undefined') ? EYE : 2.85;
    G.state = (typeof state !== 'undefined') ? state : null;
    G.moveSlide = (typeof moveSlide === 'function') ? moveSlide : null;
    G.particle = (typeof particle === 'function') ? particle : null;
    G.highestFloor = (typeof highestFloor === 'function') ? highestFloor : null;
    /* eslint-enable no-undef */
    return !!(G.ECFG && G.enemies && G.player && G.ERIG);
  }

  /* =========================================================================
     9. PER-ENEMY RIG + ANIMATION STATE
     ====================================================================== */
  function Foot(side) {
    this.side = side;
    this.mode = 0;                       /* 0 stance, 1 swing */
    this.plant = new THREE.Vector3();
    this.last = new THREE.Vector3();
    this.next = new THREE.Vector3();
    this.t = 0; this.dur = 0.28; this.init = false;
    this.plantYaw = 0; this.lastYaw = 0; this.nextYaw = 0;
    this.stanceT = 0; this.stanceDur = 0.5;
    /* phase (in CYCLES) at which this foot last touched down. Stance progress
       is measured forward from here, so the ankle roll runs on exactly the
       same clock as the pelvis instead of on its own timer. */
    this.phPlant = 0;
    /* continuity carry for the ankle roll: whenever the state machine forces
       an off-schedule transition we bank the pose error here and bleed it out,
       which keeps the ankle C0 (and very nearly C1) across every switch. */
    this.rpO = 0; this.rtO = 0;
    this.load = 0;                       /* 0..1 share of body weight */
    this.lastRP = 0; this.lastRT = 0;
  }

  function makeState(e) {
    var S = NZ.math.Spring;
    return {
      feet: [new Foot(-1), new Foot(1)],
      aimW: new S(0.25, 90, 17),
      yaw: new S(0, 130, 21), pitch: new S(0, 130, 21),
      hitP: new S(0, 210, 20), hitR: new S(0, 200, 19), hitY: new S(0, 240, 21),
      hitArm: [new S(0, 190, 18), new S(0, 190, 18)],
      hitLeg: [new S(0, 170, 17), new S(0, 170, 17)],
      recoil: new S(0, 320, 26),
      lean: new S(0, 110, 19),
      /* the carried weapon lags the torso: this is the follow-through that
         makes a rifle read as an object with mass rather than a decal */
      wx: new S(0, 150, 20), wy: new S(0, 130, 18), wz: new S(0, 160, 21),
      wpitch: new S(0, 140, 19),
      accel: 0, lastSpeed: 0,
      hipY: 0, hipYSm: 0, lastNow: 0, phase: 0,
      seed: 0, tier: 2, char: null, farPose: 0,
      rag: null, ragPose: null, poseOn: null, region: 1, headshot: 0,
      lastRecoil: 0, breath: 0, stagger: 0,
      prevPts: null, prevT: 0, prevValid: false,

      /* ---- locomotion clock (owned here, driven by real ground travel) --- */
      px: 0, pz: 0, pvalid: false,
      vSm: 0, vPrev: 0, acc: 0, gait: 0, omega: 0, strideW: 1, cyc: 0.9,
      duty: 0.62, stepA: 0, moveSm: 0,

      /* ---- centre of mass: rides the support, and arrives LATE ---------- */
      comX: new S(0, 520, 42),        /* lateral, ~30 deg behind the feet     */
      comY: new S(0, 620, 46),        /* vertical bob                          */
      comZ: new S(0, 480, 41),        /* fore/aft surge                        */
      /* anticipation / settle. Deliberately under-damped (zeta ~ 0.58): a
         start dips back before it goes, a stop overshoots and rocks out. */
      antS: new S(0, 62, 9),
      /* torso follow-through. Under-damped so the chest overshoots the aim
         and the slung gear on it overshoots with it. */
      chY: new S(0, 165, 16), chP: new S(0, 150, 15),
      /* head: the last link in the chain, so the slowest and the loosest */
      hdY: new S(0, 120, 13), hdP: new S(0, 135, 15), hdR: new S(0, 130, 16),
      /* gaze stabilisation against the pelvis bob (vestibulo-ocular) */
      bobV: 0, lastBob: 0,

      /* ---- turning ------------------------------------------------------ */
      yawT: new AngTrack(150, 17, 0.38),
      pivotBias: 0, stepSide: 0, settleT: 0, wasIdle: true,

      /* ---- idle life ---------------------------------------------------- */
      shiftT: 0, shift: 0, shiftTo: 0,
      scanT: 1.4, scanY: 0, scanP: 0, scanTo: 0, scanToP: 0,
      asym: null,

      /* ---- heel-strike shock -------------------------------------------
         A foot hitting the floor is an impulse, not a pose. `land` is
         deliberately under-damped (zeta ~ 0.55) so the body drops, rebounds
         and rings out over ~2 cycles at ~3.5 Hz -- that ring IS the weight.
         `landU` is the same event arriving at the upper body a beat later,
         which is what makes the shock travel UP the character instead of
         happening to all of it at once. */
      land: new S(0, 560, 25), landU: new S(0, 200, 17),

      /* ---- flinch propagation ------------------------------------------
         hitP/hitR/hitY are the SOURCE (the round landing). f1 is the
         shoulder girdle chasing the spine, f2 is the head chasing the
         shoulders. Three progressively softer links = a real whip, where
         one shared rotation applied at three gains is a rigid board. */
      f1P: new S(0, 240, 25), f1R: new S(0, 230, 24), f1Y: new S(0, 260, 26),
      f2P: new S(0, 130, 16), f2R: new S(0, 125, 16), f2Y: new S(0, 145, 17),

      /* ---- anticipation ------------------------------------------------- */
      wind: new S(0, 95, 14),          /* attack wind-up / coil               */
      crouchS: new S(0, 105, 19),      /* posture height, never snaps         */
      carry: new S(0.22, 80, 15),      /* shouldered <-> low carry blend      */

      /* ---- overlap on the arms -----------------------------------------
         The grip target is where the hands WANT to be; these lag it, so the
         elbows trail the weapon and lead it back on the reversal. */
      aLagX: [new S(0, 210, 21), new S(0, 190, 20)],
      aLagY: [new S(0, 230, 22), new S(0, 205, 21)],
      aLagZ: [new S(0, 200, 21), new S(0, 180, 20)],
      poleS: [new S(-0.35, 120, 17), new S(0.45, 120, 17)],

      /* ---- turn-in-place ------------------------------------------------ */
      turnAcc: 0, pivotCd: 0, turnSm: 0,

      /* ---- idle fidget --------------------------------------------------- */
      fidT: 2.0, fidK: 0, fidTo: 0, fidArm: 0, fidArmTo: 0,
      shuf: 0, shufSide: 0, shufX: 0, shufZ: 0, aInit: 0,

      /* ---- aim request from the AI (contract C3, poseAim) ---------------- */
      aimReq: 0, aimReqYaw: 0, aimReqPitch: 0, aimReqT: 0
    };
  }

  /* =========================================================================
     SCALE -- measured, not assumed.

     The brief asks whether the enemies are ~2x the player. Against the PLAYER
     they are: EYE = 2.85 and an adult's eye sits at 0.935 of standing height,
     so the player's implied standing height is 2.85 / 0.935 = 3.05 units, and
     a trooper at cfg.h = 6.4 is 6.4 / 3.05 = 2.10x that.

     But the player is not the only ruler in the scene, and it turns out to be
     the wrong one. Every other length in NUKEM.html agrees with each other and
     disagrees with EYE:

       door opening   min(ceiling, 8.2) units   a 2.05 m door  ->  4.00 u/m
       room ceiling   9 units                   a 2.30 m room  ->  3.91 u/m
       crate          3.4 units tall            a 0.87 m crate ->  3.91 u/m
       grid cell      CELL = 4 units            a 1.02 m bay   ->  3.92 u/m
       player radius  PRAD = 1.15 units         a 0.29 m body  ->  3.97 u/m
       trooper        cfg.h = 6.4 units         = 1.60 m       ->  4.00 u/m
       pig / enforcer 7.2 / 7.8 units           = 1.84 / 2.00 m ->  ~3.9 u/m
       player EYE     2.85 units                = 0.72 m       <-- the outlier

     The world is authored at ~3.95 units per metre and the enemies sit on that
     scale correctly. It is EYE that is roughly 2.3x too LOW -- the camera is at
     the chest height of a crouching man, which is exactly why the trooper in
     the reference frame towers over the crosshair while standing beside a door
     that is comfortably taller than he is.

     So the compensation the brief anticipated would be a mistake: dividing the
     enemies by 2.1 would produce 0.8 m troopers who cannot reach the handle of
     a 2.05 m door and are shorter than the 0.87 m crates they walk past, and
     would also empty the hit capsule (NUKEM.html builds it from cfg.h) over the
     top half of its height. The fix belongs on EYE in NUKEM.html, which this
     module does not own.

     RIG_SCALE is therefore 1.0 and the rig continues to fill cfg.h exactly, so
     the silhouette and the hit volume still agree. It is a single named knob:
     if the orchestrator decides the player is right and the world is wrong,
     NZ.enemies.setScale(0.48) re-scales every enemy from one place.
     ====================================================================== */
  var RIG_SCALE = 1.0;

  function createRig(e) {
    var scene = NZ.ctx.scene;
    var root = new THREE.Group();
    root.name = 'nz-enemy-' + e.kind;
    root.rotation.order = 'YXZ';
    root.visible = false;
    scene.add(root);
    var unit = (e.cfg.h / SPEC[e.kind].modelH) * RIG_SCALE;
    var muzzle = new THREE.Object3D();
    /* root is scaled by `unit`, so a height expressed in world units has to be
       divided by it here or the fallback muzzle drifts up with the scale */
    muzzle.position.set(0, e.cfg.h * 0.62 / unit, 1.7 / unit);
    root.add(muzzle);
    var rig = {
      root: root, muzzle: muzzle, muzzleFallback: muzzle,
      muzzleWorld: new THREE.Vector3(), muzzleReady: false,
      unit: unit,
      kind: e.kind, nz: true
    };
    var st = makeState(e);
    st.seed = hash1(e.x * 3.1 + e.z * 7.7 + KINDS.indexOf(e.kind) * 11) * TAU;
    st.variant = e.rigVariant | 0;
    st.scale = 1 + ((st.variant - 1) * 0.026);
    st.asym = makeAsym(st.seed);
    st.px = e.x; st.pz = e.z; st.pvalid = false;
    st.gait = hash1(st.seed * 5.3);               /* nobody starts on the same foot */
    /* Personal phase on EVERY free-running clock. Six troopers spawned in the
       same room that inhale together, scan together and shift their weight
       together read as one animation played six times -- which is exactly
       the "puppet" impression, arrived at from the other direction. */
    st.breath = hash1(st.seed * 2.9) * TAU;
    st.shiftT = 0.6 + hash1(st.seed * 4.1) * 4.4;
    st.scanT = 0.4 + hash1(st.seed * 6.7) * 3.2;
    st.fidT = 1.1 + hash1(st.seed * 8.3) * 5.5;
    st.shiftTo = srand(st.seed, 30);
    /* the pelvis springs have to start ON the bind height or the character
       visibly settles into itself on its first frame */
    var hipY0 = (SPEC[e.kind] && SPEC[e.kind].hipY) || 0;
    st.comY.set(hipY0); st.comY.target = hipY0;
    st.hipYSm = hipY0; st.lastBob = hipY0;
    e._nz = st;
    rig.st = st;
    return rig;
  }

  /* Per-character gait signature. Two soldiers from the same mould walking in
     exactly the same way is the thing that reads as "spawned copies"; every
     one of these is small enough to be sub-conscious and large enough to
     break the clone effect. Drawn once, from the enemy's own seed. */
  function makeAsym(seed) {
    var r = function (k) { return srand(seed, k); };
    var a = {
      stride: 1 + r(1) * 0.055,        /* longer / shorter legs, effectively   */
      stanceW: 1 + r(2) * 0.18,        /* wide or narrow track                 */
      pelvYaw: 1 + r(3) * 0.16,        /* how much the hips rotate             */
      lagK: 1 + r(4) * 0.22,           /* how loose the spine chain is         */
      bounce: 1 + r(5) * 0.16,         /* vertical bob                         */
      armK: 1 + r(6) * 0.14,           /* arm swing gain                       */
      /* a wide spread here is deliberate: two characters that breathe at the
         same RATE stay in phase forever, however differently they started */
      breath: 1 + r(7) * 0.26,
      headTilt: r(8) * 0.045,          /* a permanent, tiny head cant          */
      dom: r(9) > 0 ? 1 : -1,          /* dominant side                        */
      toeOut: 0.075 + r(10) * 0.05,
      /* HOW HE CARRIES THE GUN when he is not shooting it. Two guards at low
         ready holding the rifle at the identical pitch and cant is the
         spawned-copies tell all over again, and unlike the gait it shows in
         a STILL. A few degrees of personal muzzle depression and inboard
         cant, constant for life, is what a fire team actually looks like. */
      carryP: r(16) * 0.085,           /* personal low-ready muzzle pitch      */
      carryC: r(17) * 0.070            /* personal low-ready cant              */
    };
    /* per-FOOT asymmetry: a real person is never symmetric. A few percent of
       step length and a few milliseconds of timing is all it takes. */
    var lim = 0.016;
    a.phOff = [r(11) * lim, -r(11) * lim];
    a.stepL = [1 + r(12) * 0.06, 1 - r(12) * 0.06];
    a.liftL = [1 + r(13) * 0.11, 1 - r(13) * 0.11];
    a.dutyL = [1 + r(14) * 0.045, 1 - r(14) * 0.045];
    a.toeL = [a.toeOut * (1 + r(15) * 0.30), a.toeOut * (1 - r(15) * 0.30)];
    return a;
  }

  /* ---- attach / detach a pooled skinned character --------------------- */
  function setTier(e, rig, tier) {
    var st = e._nz;
    if (st.tier === tier) return;
    if (tier < 2) {
      var c = acquireChar(e.kind, tier);
      if (!c) { tier = 2; }
      else {
        if (st.char) releaseChar(st.char);
        st.char = c;
        c.mesh.material = ASSET[e.kind].mats[st.variant];
        rig.root.add(c.group);
        rig.muzzle = c.anchor;
        st.tier = tier;
        st.prevValid = false; st.aInit = 0;
        /* Tier 2 advances the public gait clock but has no live plant state.
           Re-entering skinning with the old world-space contacts restored a
           pose from metres behind the actor, then corrected it in one frame.
           Synchronise the phase and establish fresh contacts under the body. */
        if (isFinite(e.gait)) st.gait = e.gait;
        st.px = e.x; st.pz = e.z; st.pvalid = false;
        for (var fi = 0; fi < st.feet.length; fi++) {
          st.feet[fi].init = false;
          st.feet[fi].mode = 0;
          st.feet[fi].t = 0;
          st.feet[fi].stanceT = 0;
        }
        /* a fresh character out of the pool holds someone else's pose and the
           root still holds the far path's transform: both are re-established
           on the next death frame (see onAnimateDeath) */
        st.poseOn = null;
        if (st.ragPose) applyStoredPose(c, st.ragPose);
        return;
      }
    }
    if (st.char) { releaseChar(st.char); st.char = null; }
    rig.muzzle = rig.muzzleFallback;
    st.tier = 2;
    st.prevValid = false;
    st.poseOn = null;
  }

  function applyStoredPose(c, pose) {
    for (var i = 0; i < c.bones.length; i++) {
      var b = c.bones[i], o = i * 7;
      b.position.set(pose[o], pose[o + 1], pose[o + 2]);
      b.quaternion.set(pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]);
    }
  }
  function storePose(c) {
    var out = new Float32Array(c.bones.length * 7);
    for (var i = 0; i < c.bones.length; i++) {
      var b = c.bones[i], o = i * 7;
      out[o] = b.position.x; out[o + 1] = b.position.y; out[o + 2] = b.position.z;
      out[o + 3] = b.quaternion.x; out[o + 4] = b.quaternion.y;
      out[o + 5] = b.quaternion.z; out[o + 6] = b.quaternion.w;
    }
    return out;
  }

  /* =========================================================================
     10. IK
     ====================================================================== */
  var DOWN = null, AXIS_X = null, AXIS_Y = null, AXIS_Z = null;
  function initAxes() {
    DOWN = new THREE.Vector3(0, -1, 0);
    AXIS_X = new THREE.Vector3(1, 0, 0);
    AXIS_Y = new THREE.Vector3(0, 1, 0);
    AXIS_Z = new THREE.Vector3(0, 0, 1);
    IDENTITY = new THREE.Matrix4();
  }

  /* two-bone analytic IK. target is in boneA's PARENT space.
     pole rolls the bend plane about the aim axis (0 = bend toward +Z). */
  function solveTwoBone(A, B, tx, ty, tz, pole, L1, L2) {
    var vx = tx - A.position.x, vy = ty - A.position.y, vz = tz - A.position.z;
    var d = Math.sqrt(vx * vx + vy * vy + vz * vz);
    var maxD = (L1 + L2) * 0.998, minD = Math.abs(L1 - L2) + 1e-3;
    var dc = d < minD ? minD : d > maxD ? maxD : d;
    var ca = clamp((L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc), -1, 1);
    var alpha = Math.acos(ca);
    var ck = clamp((L1 * L1 + L2 * L2 - dc * dc) / (2 * L1 * L2), -1, 1);
    var kappa = PI - Math.acos(ck);
    if (d > 1e-6) { vx /= d; vy /= d; vz /= d; } else { vx = 0; vy = -1; vz = 0; }
    _lv.v.set(vx, vy, vz);
    _lv.q.setFromUnitVectors(DOWN, _lv.v);
    _lv.q2.setFromAxisAngle(AXIS_Y, pole);
    _lv.q3.setFromAxisAngle(AXIS_X, -alpha);
    A.quaternion.copy(_lv.q).multiply(_lv.q2).multiply(_lv.q3);
    B.rotation.set(kappa, 0, 0);
    return d > maxD;   /* true == over-extended */
  }

  /* =========================================================================
     11. ANIMATION  (biped)
     ====================================================================== */
  var _wp = null;
  function animTemps() {
    if (_wp) return;
    _wp = {
      a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
      d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(),
      inv: new THREE.Matrix4(), inv2: new THREE.Matrix4(),
      m: new THREE.Matrix4(), m2: new THREE.Matrix4(), m3: new THREE.Matrix4(),
      q: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(),
      eul: new THREE.Euler(),
      /* the mount solver's own scratch -- named, because sharing a/b/c with
         the leg solver is how a "why is the gun in his knee" bug happens */
      eye: new THREE.Vector3(), fwd: new THREE.Vector3(), rgt: new THREE.Vector3(),
      upv: new THREE.Vector3(), bt: new THREE.Vector3(), sg: new THREE.Vector3(),
      pk: new THREE.Vector3(), oP: new THREE.Vector3(), oS: new THREE.Vector3(),
      elb: new THREE.Vector3(), gt: new THREE.Vector3(),
      mw: new THREE.Matrix4(), qw: new THREE.Quaternion(), qc: new THREE.Quaternion()
    };
  }

  /* per-frame scratch for the two feet -- preallocated, this runs for every
     visible enemy every frame and must not touch the allocator */
  var _tg = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  var _fi = [
    { rp: 0, rt: 0, dz: 0, dx: 0, ay: 0, yaw: 0, load: 0, cz: 0, sp: 0, sr: 0, grind: 0 },
    { rp: 0, rt: 0, dz: 0, dx: 0, ay: 0, yaw: 0, load: 0, cz: 0, sp: 0, sr: 0, grind: 0 }
  ];

  /* Smooth minimum. The pelvis height is the lesser of "where the gait wants
     it" and "how far the planted leg can actually reach"; a hard min() there
     puts a corner in the height curve exactly at the moment of peak load,
     which reads as a hitch. This is C1 everywhere. */
  function smin(a, b, k) {
    var h = clamp(0.5 + (b - a) / (2 * k), 0, 1);
    return lerp(b, a, h) - k * h * (1 - h);
  }

  /* Heel-to-toe roll. u is a normalised progress; the curve is built so that
     stance(1) == swing(0) and swing(1) == stance(0), i.e. it is continuous
     across every plant and lift-off. A discontinuity here reads as the foot
     snapping and is one of the loudest amateur tells. */
  /* Sign convention: rotating the foot about +X by a POSITIVE angle tips the
     toes DOWN (R_x maps +Z to (0,-sin,cos)). Heel strike is therefore
     negative pitch and toe-off positive. */
  /* ROLL_TOE is NOT a free number: during push-off the toe pad stays flat on
     the floor while the boot rotates up over it, so the toe joint has to
     extend by exactly as much as the ankle plantarflexes. Any other value
     either digs the toe box in or lifts the pad off, and the pad is the last
     thing touching the ground -- which makes it the contact. */
  var ROLL_STRIKE = -0.15, ROLL_LIFT = 0.46, ROLL_TOE = -0.46;
  /* smootherstep: C2, and -- the part that matters here -- ZERO derivative at
     both ends. Every segment of the roll curve is eased with it, so the ankle
     arrives at flat-foot with zero angular velocity. The old curve used a
     LINEAR ramp into flat, which put a step in the ankle's vertical velocity
     at the exact instant the rolling pivot swaps from the heel to the toe. */
  function smst(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
  function footRoll(mode, t, out) {
    var pitch, toe;
    if (mode === 0) {                      /* stance: strike -> flat -> heel lift */
      if (t < 0.16) { pitch = lerp(ROLL_STRIKE, 0, smst(t / 0.16)); toe = 0; }
      else if (t < 0.86) { pitch = 0; toe = 0; }
      else {
        var k = smst((t - 0.86) / 0.14);
        pitch = lerp(0, ROLL_LIFT, k); toe = -pitch;   /* pad stays flat */
      }
    } else {                               /* swing: toe-off -> dorsiflex -> strike */
      if (t < 0.42) {
        var k2 = smst(t / 0.42);
        pitch = lerp(ROLL_LIFT, 0.10, k2); toe = lerp(ROLL_TOE, 0, k2);
      } else { var k3 = smst((t - 0.42) / 0.58); pitch = lerp(0.10, ROLL_STRIKE, k3); toe = 0; }
    }
    out[0] = pitch; out[1] = toe;
    return out;
  }
  var _roll = [0, 0];

  /* -------------------------------------------------------------------------
     THE ROLLING PIVOT.

     Given a foot pitched by theta, which material point of the sole is on the
     ground? It is the LOWEST one, and for a rigid sole that is the toe when
     the toes are down and the heel when the heel is down -- never a point
     part-way along. The previous build interpolated the pivot linearly with
     the angle, which pitched the foot about mid-sole and drove the toe
     19 mm THROUGH the floor at every push-off (measured, not guessed).

     The switch at theta = 0 is harmless: with a flat foot the horizontal
     position of every sole point is independent of the pivot, so the composed
     result is continuous. It is smoothed over a 0.03 rad band anyway so the
     ANKLE height derivative is continuous too.
     ---------------------------------------------------------------------- */
  var PIVOT_BAND = 0.030;                   /* rad */
  function rollPivot(rp, heelBack, toeFwd) {
    if (rp >= 0) return toeFwd * sstep(rp / PIVOT_BAND);
    return -heelBack * sstep(-rp / PIVOT_BAND);
  }

  /* -------------------------------------------------------------------------
     THE SOLE CONTACT SOLVER.

     rollPivot above answers "which end of a RIGID sole is down". A boot is not
     rigid: it breaks at the metatarsal, and during push-off the toe segment
     stays FLAT ON THE FLOOR while the rest of the boot rotates up over it. So
     the contact stops at the break and never runs on to the tip -- and a rig
     that pivots on the tip anyway lifts the whole boot by
     (soleFwd - soleMTP) * sin(pitch), which is 86 mm at a normal push-off and
     is exactly the "foot floats during stance" reading.

     This solves it properly: three candidate material points (heel, the
     metatarsal break, the toe tip on its own bone), each posed by the actual
     camber -> pitch -> toe composition this frame, and the LOWEST one wins.

     It is C0 by construction. Heel and break tie only at pitch 0, where the
     sole is flat and both give the same ankle offset; break and tip tie only
     at pitch + toe == 0, where the tip lies in the plane of the break -- and
     the algebra of (cz - oz) is identical at both ties, so the ankle does not
     move by so much as a micron when the pivot hands over.

     Returns, in `out`:
       cz   material z of the contact in the REST foot frame. The stored plant
            is defined as contact - cz * heading, so this is what ties the
            world lock to the geometry.
       ox/oy/oz  the posed offset of that material point from the ankle.
     `phi` is the root's roll: the argmin has to be taken on the WORLD height,
     not the root-space one, or a banked turn picks the wrong end of the boot.
     ---------------------------------------------------------------------- */
  var _mzC = [0, 0, 0], _myC = [0, 0, 0], _czC = [0, 0, 0];
  function soleContact(sp, pitch, camber, toe, sy, cy, sphi, cphi, out) {
    var cc = Math.cos(camber), scm = Math.sin(camber);
    var cp = Math.cos(pitch), spi = Math.sin(pitch);
    var yS = sp.soleY;                       /* underside, foot-local (< 0)   */
    var mtp = sp.soleMTP, L = sp.soleFwd - mtp;
    var ct = Math.cos(toe), st = Math.sin(toe);
    /* Three candidates as (my, mz) in the foot frame, plus the REST z of the
       same material point -- which is what ties the world plant lock to the
       geometry. The BREAK is first so that a tie (a flat sole, or a toe pad
       lying flat under a lifted heel) resolves onto it: every point of a flat
       segment is a legal pivot and the break is the one in the middle of the
       contact patch. */
    _myC[0] = yS; _mzC[0] = mtp; _czC[0] = mtp;                        /* break */
    _myC[1] = yS; _mzC[1] = -sp.soleBack; _czC[1] = -sp.soleBack;      /* heel  */
    _myC[2] = yS - L * st; _mzC[2] = mtp + L * ct; _czC[2] = sp.soleFwd; /* tip */
    var best = 1e9, box = 0, boy = 0, boz = 0, bcz = 0;
    var i, my, mz, yc, ox, oy, oz, w;
    for (i = 0; i < 3; i++) {
      my = _myC[i]; mz = _mzC[i];
      yc = my * cc;                          /* camber first (Euler YXZ)      */
      ox = -my * scm;
      oy = yc * cp - mz * spi;
      oz = yc * spi + mz * cp;
      /* WORLD height, not root-space height. (ox,oy,oz) live in the foot's
         YAWED frame, so the root-space x is (ox*cos(yaw) + oz*sin(yaw)) and
         the rig's bank turns that into height. Comparing raw `oy` instead
         throws the pivot to the tip of the boot on every banked turn -- and
         the tip is 190 mm from the ball, which is a 6 mm/frame sweep. */
      w = oy * cphi + (ox * cy + oz * sy) * sphi;
      if (w < best) { best = w; box = ox; boy = oy; boz = oz; bcz = _czC[i]; }
    }
    out.cz = bcz; out.ox = box; out.oy = boy; out.oz = boz;
    return out;
  }
  var _sole = { cz: 0, ox: 0, oy: 0, oz: 0 };

  /* Floor height under a world point. NUKEM.html's highestFloor() is a grid
     lookup, not a raycast, so this is cheap enough to call per foot per frame
     -- which is what lets the feet conform to stairs and ledges instead of
     all sitting on the actor's single `e.y`. */
  function groundY(x, z, fallback) {
    if (!G.highestFloor) return fallback;
    var v = G.highestFloor(x, z, 0.35);
    return (v === v && v > -90) ? v : fallback;
  }

  /* -------------------------------------------------------------------------
     THE LOCOMOTION CLOCK

     Everything below runs off ONE clock: `st.gait`, a cycle counter integrated
     from the distance the body actually covered on the ground. That is what
     makes the feet un-skateable -- a foot is planted in world space and the
     phase that decides when to lift it is a function of how far the body has
     moved, so the two can never disagree. It also means stride length is a
     free variable: real animals lengthen the stride AND raise the cadence with
     speed (stride ~ v^0.5, cadence ~ v^0.5), and a rig with a fixed stride
     either mince-steps at speed or moon-walks at a crawl.

     `e.gait` is written back so the game's footstep trigger and the far-LOD
     pose bank stay locked to the same contacts we are drawing.
     ---------------------------------------------------------------------- */
  var TWIST_LIM = 0.80;      /* ~45 deg: past this the feet step to re-square */

  function animateBiped(e, rig, speed, now, dt) {
    var st = e._nz, c = st.char, cfg = e.cfg, sp = SPEC[e.kind];
    var ix = c.idx, B = c.bones;
    var unit = rig.unit, H = sp.H;
    var player = G.player;
    var AS = st.asym || (st.asym = makeAsym(st.seed));
    var i, s, N, f, fi;
    var hi = st.tier === 0;                 /* full fidelity only on LOD0 */
    var GT = sp.g || GAIT.trooper;          /* this animal's gait signature */

    /* ================= 1. ground truth ================================== */
    /* Distance really covered this frame -- after collision slide, after the
       separation pass. Nothing else is allowed to drive the cycle. */
    var mvx = e.x - st.px, mvz = e.z - st.pz;
    var moved = Math.hypot(mvx, mvz);
    var capMv = cfg.spd * dt * 2.6 + 0.02;
    if (!st.pvalid || moved > capMv) moved = st.pvalid ? Math.min(speed * dt, capMv) : 0;
    st.px = e.x; st.pz = e.z; st.pvalid = true;

    st.vSm = damp(st.vSm, moved / dt, 0.0001, dt);              /* tau ~ 0.11s */
    var accW = (st.vSm - st.vPrev) / Math.max(dt, 1e-3);
    st.vPrev = st.vSm;
    st.acc = damp(st.acc, clamp(accW, -120, 120), 0.0002, dt);  /* tau ~ 0.12s */

    var vMax = Math.max(1, cfg.spd);
    var move = clamp(st.vSm / vMax, 0, 1.15);
    st.moveSm = move;
    var run = sstep((move - 0.42) / 0.40);
    var moveK = sstep(move * 6.5);
    var legLen = sp.thigh + sp.shin;
    var heelBack = sp.soleBack, toeFwd = sp.soleFwd;

    /* Weapon carriage is a locomotion state, not a synonym for awareness.
       The old chase target (.78) kept a nearly perfect shoulder mount at a
       sprint, which forced the knees, stance and trunk into the same tactical
       shuffle at every speed. A moving operator now drops to a compressed
       low-ready; attack/wind-up is the event that brings the rifle fully home. */
    var carryWant = e.painT > 0 ? 0.16 : e.state === 'attack' ? 1.0 :
      e.state === 'chase' ? lerp(0.68, 0.30, run) : 0.22;
    st.carry.target = carryWant;
    st.carry.step(dt);

    /* ================= 2. the clock ===================================== */
    var vRef = vMax * 0.45;                          /* comfortable travel   */
    /* Weapon-up posture shortens the step. A soldier advancing with a rifle
       in the shoulder does not lope -- he takes short, high-cadence steps so
       the sight picture stays still, and that alone reads as "trained". The
       aim weight is last frame's spring value; a frame of lag on a smooth
       signal is invisible and saves reordering the whole function. */
    var aimPrev = clamp(st.carry.x, 0, 1);
    var combatK = lerp(1, GT.combatStride, aimPrev * (1 - run) * (e.state === 'idle' ? 0.45 : 1));
    var strideRef = (cfg.stride || legLen * unit * 1.56) * AS.stride * GT.strideK * combatK;
    var strideW = strideRef * clamp(Math.sqrt(Math.max(st.vSm, 0.12) / vRef), 0.62, 1.42);
    st.strideW = strideW;
    var dGait = moved / strideW;
    st.gait += dGait;
    if (st.gait > 65536) st.gait -= 65536;
    e.gait = st.gait;                                /* keep the game in step */
    var gait = st.gait, phase = gait * TAU;
    st.omega = damp(st.omega, dGait * TAU / dt, 0.0006, dt);
    /* Cadence follows the speed the body actually HAS this frame, not the
       smoothed one. Coming out of a standing turn into a sprint, vSm lags by
       ~110 ms; scheduling the swing off it books a 0.7 s step while the body
       is already moving at 10 u/s, the contact is left most of a metre behind
       the hips, the leg hits full extension and the boot hovers. Measured at
       52 mm of float before this line. */
    var vCyc = Math.max(st.vSm, moved / Math.max(dt, 1e-3) * 0.85);
    var cyc = clamp(strideW / Math.max(vCyc, 0.30), 0.30, 1.55);
    st.cyc = cyc;

    /* Cycle-to-cycle variation. Held roughly constant inside one cycle and
       interpolated across the boundary, so it never buzzes. */
    var cyN = hi ? noise1(gait * 0.83 + st.seed) : 0;
    var duty = clamp(lerp(GT.dutyW, GT.dutyR, run) * (1 + cyN * 0.022), 0.30, 0.74);
    st.duty = duty;

    /* ================= 3. facing: hips lag, head leads ================== */
    /* The AI's `e.face` snaps around at up to cfg.turn rad/s. Riding it
       directly is what makes a turn look like a doll on a turntable. The
       ROOT rides a second-order tracker instead, so the hips arrive last;
       the aim layer is measured against the lagged root, so the head and
       chest are automatically ahead of it. */
    var bodyYaw = st.yawT.step(e.face, dt);
    var turnErr = angWrap(e.face - bodyYaw);         /* + == body catching up */
    /* Smoothed turn RATE. This is the anticipation signal: the head uses it
       to lead the turn, the trunk to bank into it, the feet to decide when
       to pivot. Taken from the AI's own integrator when it exposes one,
       differenced from the heading otherwise. */
    var turnRaw = (e.turnV !== undefined && e.turnV === e.turnV)
      ? e.turnV : turnErr / Math.max(dt, 1e-3);
    st.turnSm = damp(st.turnSm, clamp(turnRaw, -14, 14), 0.0008, dt);

    /* NUKEM publishes the tactical peek as a real world-space shoulder
       offset (`lx/lz`) and uses it for sight, fire and hit exposure. The old
       near rig ignored that contract, so a soldier could see and shoot round
       a corner while his detailed body stayed upright behind it. Resolve the
       offset into body space and realise most of it as a whole-body bank over
       planted feet; the small hip translation keeps the spine from hinging at
       one point. Harness actors do not publish a peek, so this is a zero-cost
       no-op in the headless locomotion tests. */
    var sc = unit * st.scale;
    var leanWX = isFinite(e.lx) ? e.lx : 0, leanWZ = isFinite(e.lz) ? e.lz : 0;
    var cBody = Math.cos(bodyYaw), sBody = Math.sin(bodyYaw);
    var leanBodyX = (leanWX * cBody - leanWZ * sBody) / Math.max(sc, 1e-4);
    var leanBodyZ = (leanWX * sBody + leanWZ * cBody) / Math.max(sc, 1e-4);
    var tacticalLean = isFinite(e.leanAmt) ? clamp(e.leanAmt, -1, 1) : 0;
    var tacticalRoll = clamp(-leanBodyX / Math.max(H * 0.82, 0.1), -0.26, 0.26);

    /* Bank into the turn. A body that changes heading without rolling is a
       turntable, and a turntable is the exact thing the brief calls out. */
    /* `e.lean` also contains a small billboard-era peel term. Remove its
       average contribution before adding the geometrically solved bank above
       or a near rig double-leans compared with its hit volume. */
    var leanWant = clamp((e.lean - tacticalLean * 0.24) * 1.05 - st.turnSm * 0.017,
      -0.32, 0.32);
    st.lean.target = leanWant; st.lean.step(dt);
    rig.root.position.set(e.x, e.y, e.z);
    /* The bank the whole rig rides. The feet have to UNDO it (see the sole
       solver) or a banked body puts one edge of each boot through the floor. */
    var rootRoll = st.lean.x * 0.55 + tacticalRoll;
    var sinRoll = Math.sin(rootRoll), cosRoll = Math.cos(rootRoll);
    rig.root.rotation.set(0, bodyYaw, rootRoll);
    rig.root.scale.set(sc, sc, sc);
    rig.root.updateMatrix();
    rig.root.matrixWorld.copy(rig.root.matrix);   /* parent is the scene (identity) */
    _wp.inv.copy(rig.root.matrixWorld).invert();

    /* ================= 4. aim, hits, breath ============================= */
    var dxp = player.x - e.x, dzp = player.z - e.z;
    var distP = Math.hypot(dxp, dzp) || 0.001;
    var aimWorld = Math.atan2(dxp, dzp);
    var aimPitchW = Math.atan2((player.y + G.EYE - 0.6) - (e.y + cfg.h * 0.86), distP);
    /* CONTRACT C3: the AI owns WHERE the shot goes. If it has posted an aim
       request in the last 350 ms we use that instead of aiming at the player
       -- which is what lets it lead a moving target, suppress a doorway, or
       track a last-known position without the body contradicting the shot.
       The request goes stale on its own so a silent AI never leaves an
       operator aiming at nothing. */
    if (st.aimReq && st.aimReqT > 0) {
      st.aimReqT -= dt;
      if (st.aimReqT <= 0) { st.aimReq = 0; }
      else { aimWorld = st.aimReqYaw; aimPitchW = st.aimReqPitch; }
    }
    var relYaw = clamp(angWrap(aimWorld - bodyYaw), -0.92, 0.92);
    var relPitch = clamp(aimPitchW, -0.42, 0.46);
    st.yaw.target = relYaw; st.yaw.step(dt);
    st.pitch.target = relPitch; st.pitch.step(dt);
    st.aimW.target = e.painT > 0 ? 0.15 : e.state === 'attack' ? 1 : e.state === 'chase' ? 0.78 : 0.22;
    st.aimW.step(dt);

    /* ---- ANTICIPATION: the wind-up ------------------------------------
       The game telegraphs a shot by counting `atkT` down from `atkTotal`
       before it fires. That window is exactly where a real shooter squares
       up, settles the weapon into the shoulder and stops moving his head.
       Riding it through an under-damped spring means the pose ARRIVES and
       overshoots slightly instead of ramping linearly into the trigger. */
    var windK = 0;
    if (e.state === 'attack' && !e.fired && e.atkTotal > 0 && e.atkT !== undefined)
      windK = clamp(1 - Math.max(0, e.atkT - 0.22) / Math.max(0.08, e.atkTotal - 0.22), 0, 1);
    st.wind.target = windK; st.wind.step(dt);
    var wind = clamp(st.wind.x, -0.3, 1.35) * GT.wind;

    /* `lookAim` keeps the gaze and torso on the threat while `aim` owns the
       physical weapon mount. That separation lets a soldier watch a doorway
       over low-ready instead of either staring away or sprinting through a
       perfect sight picture. */
    var lookAim = clamp(st.aimW.x + wind * 0.12, 0, 1);
    var aim = clamp(st.carry.x + wind * 0.22, 0, 1);
    var alert = (e.state === 'idle' ? 0.25 : 1) + wind * 0.25;

    /* ---- CROUCH ---------------------------------------------------------
       `e.crouch` (0..1) is owned by the AI, which uses it for accuracy at
       range and for fighting from cover, and NUKEM.html already sizes the hit
       capsule from it: the head top drops to h*(1 - 0.33*crouch) and the eye
       to h*(0.934 - 0.306*crouch). The rig has to MEET those numbers or the
       hitbox and the silhouette disagree, and a player who aims at a head
       that is not where the capsule is will call it desync.

       The compression is shared out the way a body actually does it -- the
       hips drop about half a leg length, the trunk pitches forward over the
       knees to keep the mass over the feet, the stance widens for a base,
       and the step shortens to a shuffle. The weapon and the gaze are NOT
       touched: both are solved against the world (see the mount and the gaze
       solver), so they stay exactly on target while the body sinks under
       them, which is the whole point of crouching to shoot. */
    var crouchReq = e.crouch;
    crouchReq = (crouchReq === crouchReq && crouchReq > 0) ? (crouchReq > 1 ? 1 : crouchReq) : 0;
    var crSt = sstep(crouchReq);                      /* posture blend 0..1   */

    st.hitP.step(dt); st.hitR.step(dt); st.hitY.step(dt);
    st.hitArm[0].step(dt); st.hitArm[1].step(dt);
    st.hitLeg[0].step(dt); st.hitLeg[1].step(dt);
    /* ---- FLINCH PROPAGATION -------------------------------------------
       hitP/R/Y are the round landing in the trunk. f1 is the shoulder
       girdle chasing the trunk, f2 is the head chasing the shoulders. Each
       link is softer than the one below it, so a hit runs UP the body over
       ~120 ms and dies out at the top -- which is what a whip does. The old
       code applied one rotation at three gains on the same frame, and one
       rotation on the same frame is a plank. */
    st.f1P.target = st.hitP.x; st.f1R.target = st.hitR.x; st.f1Y.target = st.hitY.x;
    st.f1P.step(dt); st.f1R.step(dt); st.f1Y.step(dt);
    st.f2P.target = st.f1P.x; st.f2R.target = st.f1R.x; st.f2Y.target = st.f1Y.x;
    st.f2P.step(dt); st.f2R.step(dt); st.f2Y.step(dt);

    /* ---- heel-strike shock (impulses are fired from the foot loop) ----- */
    st.land.target = 0; st.land.step(dt);
    st.landU.target = 0; st.landU.step(dt);
    var landK = clamp(st.land.x, -1.8, 1.8);
    var landU = clamp(st.landU.x, -1.8, 1.8);

    var recoilK = e.recoilT > 0 ? e.recoilT / 0.15 : 0;
    if (recoilK > st.lastRecoil + 0.4) {
      st.recoil.impulse(9.0);
      st.wz.impulse(-2.6); st.wpitch.impulse(2.2);
      st.chP.impulse(1.4); st.hdP.impulse(-0.9);
      st.wind.impulse(-5.5);                 /* the coil releases on the shot */
      st.aLagZ[0].impulse(-1.1); st.aLagZ[1].impulse(-0.9);
    }
    st.lastRecoil = recoilK;
    st.recoil.target = 0; st.recoil.step(dt);
    var rec = clamp(st.recoil.x, -0.4, 1.2);

    /* Breathing: 14/min at rest, 34/min working. Never zero -- a character
       that holds a pose perfectly still is a prop. */
    st.breath += dt * TAU * (0.235 + 0.33 * move + (e.state === 'idle' ? 0 : 0.09)) * AS.breath;
    var breath = Math.sin(st.breath);
    var breathIn = Math.max(0, breath);              /* inhale is the fast half */

    /* Anticipation / settle. A start dips back before it goes and a stop
       rocks forward and rolls out; both are impulses into an under-damped
       spring, which is what an ease-in/ease-out cannot fake. */
    if (move > 0.11 && st.wasIdle) {
      st.antS.impulse(-3.4); st.wasIdle = false;
      st.hdP.impulse(0.9); st.chP.impulse(-0.7);     /* the head goes first   */
    } else if (move < 0.045 && !st.wasIdle) {
      st.antS.impulse(2.6); st.wasIdle = true; st.settleT = 0;
      /* follow-through on the stop: the head and the weapon carry a few
         frames past the body and rock back. */
      st.hdP.impulse(-1.5); st.hdY.impulse(st.turnSm * 0.06);
      st.chP.impulse(1.2); st.wz.impulse(1.8); st.wpitch.impulse(-1.4);
    }
    st.antS.target = 0; st.antS.step(dt);
    var antic = clamp(st.acc / vMax * 0.30, -0.17, 0.17) + st.antS.x * 0.085;

    st.stagger = damp(st.stagger, e.painT > 0 ? 1 : 0, 0.0005, dt);
    st.settleT = Math.max(0, st.settleT - dt);

    /* ---- idle life: weight shifts, head scans, fidget ------------------
       Standing still is an ACTIVITY. A soldier on overwatch shifts his
       weight off one hip every few seconds, re-sets a foot, re-grips, scans.
       Every timer here is seeded from the individual, so a squad of six
       never breathes, shifts or scans on the same beat. */
    var idleK = 1 - moveK;
    var alertK = clamp(alert, 0, 1.4);
    if (idleK > 0.02) {
      st.shiftT -= dt;
      if (st.shiftT <= 0) {
        st.shiftT = (2.6 + hash1(now * 3.1 + st.seed) * 4.2) / (0.7 + 0.5 * GT.fidget);
        st.shiftTo = (hash1(now * 7.7 + st.seed * 2.3) * 2 - 1) * 0.92;
      }
      st.shift = damp(st.shift, st.shiftTo, 0.06, dt);   /* tau ~ 0.36 s */
      st.scanT -= dt * GT.scanRate;
      if (st.scanT <= 0) {
        st.scanT = 1.7 + hash1(now * 2.7 + st.seed * 5.1) * 3.6;
        st.scanTo = (hash1(now * 11.3 + st.seed) * 2 - 1) * (0.44 * alertK + 0.11) * GT.scanAmp;
        st.scanToP = (hash1(now * 4.9 + st.seed * 3.7) * 2 - 1) * 0.12 * GT.scanAmp;
      }
      /* fidget: a deliberate foot repositioning and a re-grip. This is the
         one that stops a stationary group reading as statues -- the weight
         shift alone is too small to see across a room, a foot moving is not. */
      st.fidT -= dt * GT.fidget;
      if (st.fidT <= 0) {
        st.fidT = 2.6 + hash1(now * 5.7 + st.seed * 3.3) * 4.6;
        st.fidArmTo = (hash1(now * 9.1 + st.seed) * 2 - 1) * 0.42;
        if (hash1(now * 13.7 + st.seed * 7.1) > 0.35) {
          st.shufSide = hash1(now * 17.3 + st.seed * 2.7) > 0.5 ? 1 : 0;
          st.shufX = (hash1(now * 19.1 + st.seed) * 2 - 1) * 0.20 * legLen * 0.30;
          st.shufZ = (hash1(now * 23.7 + st.seed * 1.9) * 2 - 1) * 0.26 * legLen * 0.30;
          st.shuf = 1;
        }
      }
    } else {
      st.shift = damp(st.shift, 0, 0.02, dt); st.scanTo *= 0.9; st.scanToP *= 0.9;
      st.fidArmTo *= 0.9; st.shuf = 0;
    }
    st.fidArm = damp(st.fidArm, st.fidArmTo * idleK, 0.03, dt);
    /* saccade: fast out, then hold. tau 0.09 s is roughly a real head turn. */
    st.scanY = damp(st.scanY, st.scanTo * idleK, 0.00002, dt);
    st.scanP = damp(st.scanP, st.scanToP * idleK, 0.00004, dt);

    /* ================= 5. feet ========================================= */
    var cf = Math.cos(bodyYaw), sf = Math.sin(bodyYaw);
    var lvz = e.vx * sf + e.vz * cf;                 /* velocity in body space */
    var lvx = e.vx * cf - e.vz * sf;
    var lvl = Math.hypot(lvx, lvz);
    var mdx = lvl > 1e-3 ? lvx / lvl : 0, mdz = lvl > 1e-3 ? lvz / lvl : 1;
    var dirK = sstep((lvl - 0.25) / 0.65);           /* no hard gate: it pops  */

    /* ---- THE FIGHTING STANCE -------------------------------------------
       Round 3 stood every operator with his feet 204 mm apart (measured,
       ankle to ankle) and dead level -- a bus-queue stance with a rifle
       bolted to it. A man behind a gun does the opposite: the track opens
       to about shoulder width and the SUPPORT-side foot goes forward, so the
       base is a rectangle he can drive into rather than a line he can be
       pushed off. Both numbers are real and both are stance-dependent, so
       they ride one blend:

         stanceK  0 = ambling, 1 = squared up behind the gun

       and it collapses as he picks up speed, because a walking human's feet
       track NARROW (~120 mm at the ankles) and a running human's cross the
       midline. A wide track baked in at every speed is a waddle. */
    /* ...and it collapses TWICE: once for walking (a walking track is narrow)
       and again for running, because a sprinter's feet land on the midline
       and a wide track at speed also costs the stance leg the reach it needs
       to keep the other boot on the floor -- measured, it put 5 mm of float
       under the ASSAULTER's planted foot at a sprint. */
    var stanceK = clamp(0.34 + 0.66 * aim, 0, 1) * (1 - 0.62 * moveK) * (1 - 0.62 * run);
    /* base of support: 204 mm -> 395 mm at a full mount, ~265 mm ambling */
    var stanceW = sp.hipW * 1.06 * AS.stanceW * GT.stanceW * (1 + 0.26 * crSt)
      * (1 + 0.95 * stanceK);
    /* STAGGER. 230 mm of it at a full mount, support foot leading, on the
       operator's own asymmetry so a fire team does not stand in formation.
       `AS.dom` is his handedness bias, already seeded per individual. */
    var stagger = 0.062 * H * stanceK * (1 + AS.dom * 0.26);
    var strideM = strideW / unit;
    /* The ankle rides FORWARD over the foot during stance (heel contact is
       behind the ankle, toe contact is in front of it), so the contact point
       has to be placed shorter than half the stance travel or the leg ends up
       reaching much further back than forward. */
    /* The pivot at push-off is the metatarsal BREAK, not the tip of the boot:
       the toes stay flat and the boot rotates over them. */
    var rollShift = sp.digitigrade ? 0 :
      (sp.soleMTP * (1 - Math.cos(ROLL_LIFT)) + sp.ankle * Math.sin(ROLL_LIFT)) -
      (-heelBack * (1 - Math.cos(ROLL_STRIKE)) + sp.ankle * Math.sin(ROLL_STRIKE));
    var A = clamp((strideM * duty - rollShift) * 0.5, legLen * 0.03,
      legLen * GT.stepMax * (1 - 0.42 * crSt));
    st.stepA = A;
    /* Swing clearance. This is the clearance of the LOWEST point of the boot,
       not of the heel -- and that distinction is why it barely rises with
       speed. A sprinting foot swings through a much bigger arc, but it does
       it PITCHED, so the toe stays close to the ground the whole way; real
       minimum toe clearance at a run is a couple of centimetres and people
       trip on kerbs precisely because of it. The old curve tripled the
       clearance between a walk and a sprint and put the boot 158 mm up. */
    /* Measured off the strip: the ankle was peaking at 128-130 mm at mid
       swing against 150-180 mm for a 1.83 m male at a tactical walk, which
       is the difference between striding and shuffling. The comment below
       about toe clearance is still right -- the TOE stays low because the
       foot is pitched -- but the ANKLE rides with the knee and it was short. */
    var lift = (0.128 + 0.055 * move + 0.030 * run) * legLen * 0.36 * GT.lift * (1 - 0.16 * run)
      * (1 - 0.34 * crSt);

    /* ---- turn-in-place: STEP, do not spin ----------------------------
       Integrate the heading change while the body is essentially stationary.
       Past about 20 degrees of accumulated turn a standing person cannot
       keep both soles where they are, so he picks one up and puts it down
       further round -- alternating, because he pivots on the other. Without
       this the character yaws on a turntable with welded feet until the
       twist failsafe finally snaps a foot across, which is the single most
       artificial thing a rig can do. */
    st.pivotCd = Math.max(0, st.pivotCd - dt);
    if (move < 0.22) st.turnAcc = Math.min(st.turnAcc + Math.abs(st.turnSm) * dt, 3);
    else st.turnAcc *= Math.pow(0.015, dt);
    var overTwist = Math.abs(relYaw) - TWIST_LIM;
    var needPivot = (overTwist > 0 && move < 0.34) ||
      (st.turnAcc > 0.22 && st.pivotCd <= 0 && move < 0.30);

    /* settle step: stopping mid-stride leaves the feet split. A real body
       brings the trailing foot up; a puppet freezes in the split. */
    var wantSettle = -1;
    if (move < 0.10 && st.settleT <= 0 && st.feet[0].mode === 0 && st.feet[1].mode === 0) {
      _wp.a.copy(st.feet[0].plant).applyMatrix4(_wp.inv);
      _wp.b.copy(st.feet[1].plant).applyMatrix4(_wp.inv);
      /* measured against the stance the operator is TRYING to hold, not
         against a square one -- a deliberate 210 mm fighting stagger is not
         a split that needs settling, and testing it as one is how the
         character ends up shuffling its feet together for ever */
      var splitZ = (_wp.a.z - stagger) - (_wp.b.z + stagger);
      var offC = Math.abs(_wp.a.z + _wp.b.z) * 0.5;  /* both feet off to one side */
      if (Math.abs(splitZ) > legLen * 0.13 || offC > legLen * 0.16)
        wantSettle = (Math.abs(splitZ) > legLen * 0.13)
          ? (splitZ < 0 ? 0 : 1)                     /* the trailing one moves */
          : (_wp.a.z * _wp.a.z > _wp.b.z * _wp.b.z ? 0 : 1);
      /* nothing to correct, but the fidget timer wants a shuffle */
      else if (st.shuf && !needPivot) { wantSettle = st.shufSide | 0; st.shuf = 0; }
    }

    var overreach = false, wSum = 0, supX = 0, supZ = 0;
    for (i = 0; i < 2; i++) {
      f = st.feet[i]; fi = _fi[i];
      var sgn = f.side;
      var stanceX = sgn * stanceW;
      /* side -1 is the LEFT foot and the left is the support side of a
         right-handed shooter, so it is the one that leads */
      var stanceZ = -sgn * stagger;
      if (!f.init) {
        f.init = true;
        _wp.a.set(stanceX, 0, stanceZ).applyMatrix4(rig.root.matrixWorld);
        f.plant.copy(_wp.a); f.last.copy(_wp.a); f.next.copy(_wp.a);
        f.plantYaw = f.lastYaw = f.nextYaw = bodyYaw;
        f.phPlant = fract(gait + i * 0.5);
      }
      var phi = fract(gait + i * 0.5 + AS.phOff[i]);
      var dutyI = clamp(duty * AS.dutyL[i], 0.24, 0.74);
      var since = cycFwd(phi, f.phPlant);
      var wantSwing = phi >= dutyI && since > 0.10;

      /* current contact in body space */
      _wp.a.copy(f.plant).applyMatrix4(_wp.inv);
      var reach = Math.hypot(_wp.a.x - sgn * sp.hipW, _wp.a.z);
      /* Failsafes only. With the placement above, a healthy cycle never comes
         near these -- if they fire every step the gait is fighting itself. */
      var drift = Math.abs(_wp.a.x - stanceX) > stanceW * 1.7 + 0.42 ||
        Math.abs(_wp.a.z - stanceZ) > strideM * duty * 0.66 + 0.40;
      var stretched = reach > legLen * 0.915;
      /* The faster the body is coming round, the sooner the sole has to be
         replaced -- a threshold that does not scale with the turn rate is
         always too late at the top of the range. */
      var twistLim = 0.38 - Math.min(0.14, Math.abs(st.turnSm) * 0.032);
      var twist = Math.abs(angWrap(f.plantYaw - bodyYaw)) > twistLim;
      /* Below a walk only one foot may leave the ground at a time -- EXCEPT
         when a sole has been left so far behind the body that keeping it down
         would mean dragging it. At that point a real person skips off both
         feet rather than grinding, and blocking the step (which the old
         single-support rule did) is what produced a 4 mm-per-frame drag right
         after a spawn or a snap turn. */
      var solo = move > 0.16 || st.feet[1 - i].mode === 0 ||
        Math.abs(angWrap(f.plantYaw - bodyYaw)) > 0.80;
      var forced = (needPivot && st.stepSide === i) || wantSettle === i;
      var switched = false;

      if (f.mode === 0) {
        f.stanceT += dt;
        /* The failsafes are allowed to cut a stance short, but never in the
           first few frames of it -- during a hard turn the body can rotate
           past the foot it has only just put down, and without this the
           character machine-guns corrective steps. During a genuinely fast
           pivot that guard has to relax, because the AI can yaw at 390 deg/s
           and no number of 0.3 s steps will otherwise keep up. */
        var mayCut = f.stanceT > (Math.abs(st.turnSm) > 2.2 ? 0.045 : 0.085);
        if (((wantSwing && move > 0.030) || ((drift || stretched || twist) && mayCut) || forced) && solo) {
          f.mode = 1; f.t = 0; switched = true;
          /* Land ON the schedule: however off-phase the lift-off was, the
             swing is timed so touch-down happens when the clock next says so.
             Bounded to a sane multiple of the nominal swing, because an
             off-schedule lift would otherwise ask for a swing nearly a whole
             cycle long -- and the step placement below scales with it, so an
             over-long swing throws the foot far enough ahead to trip the
             failsafes and the gait never recovers. */
          var swNom = Math.max(0.08, (1 - dutyI) * cyc);
          f.dur = clamp((1 - phi) * cyc, swNom * 0.55, swNom * 1.30);
          f.dur = clamp(f.dur, 0.10, 0.55);
          /* A pivot step is quick and short: the faster the body is coming
             round, the less time the foot has in the air before it has to be
             under the mass again. */
          if (forced && move < 0.10)
            f.dur = clamp(0.26 - Math.abs(st.turnSm) * 0.030 - move * 0.5, 0.11, 0.32);
          f.last.copy(f.plant); f.lastYaw = f.plantYaw;

          /* How much speed will actually be left at touch-down? Placing the
             foot for the CURRENT speed while the body is braking hard is what
             leaves a stopped character standing in an impossible split with
             its hips on the floor. */
          var decK = clamp(1 + 0.5 * st.acc * f.dur / Math.max(st.vSm, 0.8), 0.22, 1.15);
          var stepN = hi ? 1 + noise1(gait * 0.997 + st.seed + i * 3.7) * 0.055 : 1;
          var lead = A * AS.stepL[i] * stepN * dirK * clamp(decK, 0.35, 1.10);
          var px = stanceX + mdx * lead;
          var pz = stanceZ * (1 - dirK * 0.55) + mdz * lead;
          if (wantSettle === i) {
            px = stanceX + (st.shufX || 0); pz = stanceZ + (st.shufZ || 0);
            st.shufX = 0; st.shufZ = 0; st.settleT = 0.55;
          } else if (forced) {
            /* Pivot step: swing this foot AROUND the other one, which is the
               one bearing the weight. The offset from the pivot foot to this
               foot's nominal stance spot is rotated the SAME way the body is
               turning (and the whole target is then rotated again by tAhead
               for the turn that happens while the foot is in the air), so
               each step actually walks the body round instead of putting the
               foot back where it started. */
            var arc = clamp(turnErr * 0.72 + st.turnSm * 0.14, -0.95, 0.95);
            var oth = st.feet[1 - i];
            if (oth.init) {
              _wp.c.copy(oth.plant).applyMatrix4(_wp.inv); /* pivot foot, body space */
              var rx = stanceX - _wp.c.x, rz = -_wp.c.z;
              var ca = Math.cos(arc), sa = Math.sin(arc);
              px = _wp.c.x + rx * ca + rz * sa;
              pz = _wp.c.z - rx * sa + rz * ca;
            } else { px = stanceX + sgn * 0.18 * stanceW; pz = stanceZ; }
            st.settleT = 0.34; st.turnAcc = 0; st.pivotCd = 0.05;
          }
          /* Rotate the target into the heading the body will HOLD at
             touch-down. Placing a foot for the current heading in the middle
             of a turn lands it already twisted, the twist failsafe fires and
             the character machine-guns corrective steps. */
          var tAhead = clamp(turnErr * 0.60 + st.turnSm * f.dur * 0.55, -1.25, 1.25);
          var cA = Math.cos(tAhead), sA = Math.sin(tAhead);
          _wp.b.set(px * cA + pz * sA, 0, -px * sA + pz * cA).applyMatrix4(rig.root.matrixWorld);
          /* Predict where the body will BE at touch-down, so the contact lands
             `lead` ahead of THAT rather than ahead of where the body was when
             the foot left the ground. This is the whole no-skate condition:
             get it wrong and the contact arrives out of position, the reach
             failsafe fires, and the character scrabbles. */
          var pdx = e.vx * f.dur * decK, pdz = e.vz * f.dur * decK;
          /* The prediction cap exists to survive a garbage velocity, not to
             shorten an honest one: at a sprint the body really does cover more
             than a stride during a swing, and clamping that is what leaves the
             foot behind. */
          var pdl = Math.hypot(pdx, pdz);
          var pdMax = Math.max(strideW * 1.25, cfg.spd * f.dur * 1.30);
          if (pdl > pdMax) { pdx *= pdMax / pdl; pdz *= pdMax / pdl; }
          _wp.b.x += pdx; _wp.b.z += pdz;
          /* PER-FOOT GROUND QUERY. The actor has one `e.y`; a foot has its
             own. Sampling the floor at the place the foot is actually going
             to land is what lets a character walk up a step, stand across a
             ledge, or put one boot on a crate without either foot floating.
             Clamped to +/- half a leg so a query that lands in a pit or on a
             wall top cannot throw the leg out of range. */
          _wp.b.y = clamp(groundY(_wp.b.x, _wp.b.z, e.y), e.y - legLen * unit * 0.5,
            e.y + legLen * unit * 0.5);
          f.next.copy(_wp.b);
          /* surface slope at the landing spot, sampled fore/aft and lateral
             one foot-length apart, so the ankle can pitch and roll onto it */
          var fl2 = sp.footL * unit * 0.5, sw2 = sp.footW * unit * 1.1;
          var syA = Math.sin(f.nextYaw !== undefined ? f.nextYaw : bodyYaw);
          var cyA = Math.cos(f.nextYaw !== undefined ? f.nextYaw : bodyYaw);
          var gF = groundY(_wp.b.x + syA * fl2, _wp.b.z + cyA * fl2, _wp.b.y);
          var gB = groundY(_wp.b.x - syA * fl2, _wp.b.z - cyA * fl2, _wp.b.y);
          var gRr = groundY(_wp.b.x + cyA * sw2, _wp.b.z - syA * sw2, _wp.b.y);
          var gL = groundY(_wp.b.x - cyA * sw2, _wp.b.z + syA * sw2, _wp.b.y);
          f.slopeP = clamp(-(gF - gB) / (2 * fl2 * unit), -0.55, 0.55);
          f.slopeR = clamp((gRr - gL) / (2 * sw2 * unit), -0.45, 0.45);
          /* Toe-out, aimed at where the body will be FACING on contact -- not
             where it faces now. Land a foot pointing at the old heading in the
             middle of a turn and it is already twisted the moment it touches. */
          f.nextYaw = bodyYaw + clamp(tAhead, forced ? -1.15 : -0.62, forced ? 1.15 : 0.62)
            + sgn * AS.toeL[i];
          st.stepSide = 1 - i;
        }
      } else {
        /* ---- CONTINUOUS RE-TARGETING DURING THE SWING -----------------
           A landing point chosen once, at lift-off, is a prediction about a
           future the body has not lived through yet. Take a step while
           standing still and then accelerate to a sprint inside the same
           swing -- which is exactly what happens coming out of a turn -- and
           the body arrives 0.65 m past a contact that was placed for a
           stationary man. The leg then hits full extension, the pelvis is
           dragged down by the reach limit, and the boot hovers 50 mm off the
           floor for the whole of the next stance. Measured.

           So the target is re-solved every frame against the CURRENT
           velocity and the REMAINING swing time, and blended in with a
           weight that decays to zero before touch-down -- so the correction
           is finished by the time the foot lands and the contact still
           arrives with zero velocity. */
        var remain = (1 - f.t) * f.dur;
        if (f.t < 0.78 && remain > 1e-3) {
          var decK2 = clamp(1 + 0.5 * st.acc * remain / Math.max(st.vSm, 0.8), 0.22, 1.15);
          var lead2 = A * AS.stepL[i] * dirK * clamp(decK2, 0.35, 1.10);
          var px2 = stanceX + mdx * lead2, pz2 = stanceZ * (1 - dirK * 0.55) + mdz * lead2;
          var ta2 = clamp(turnErr * 0.60 + st.turnSm * remain * 0.55, -1.25, 1.25);
          var c2 = Math.cos(ta2), s2 = Math.sin(ta2);
          _wp.b.set(px2 * c2 + pz2 * s2, 0, -px2 * s2 + pz2 * c2)
            .applyMatrix4(rig.root.matrixWorld);
          var qx = e.vx * remain * decK2, qz = e.vz * remain * decK2;
          var ql = Math.hypot(qx, qz);
          var qMax = Math.max(strideW * 1.25, cfg.spd * remain * 1.30);
          if (ql > qMax) { qx *= qMax / ql; qz *= qMax / ql; }
          _wp.b.x += qx; _wp.b.z += qz;
          _wp.b.y = clamp(groundY(_wp.b.x, _wp.b.z, e.y),
            e.y - legLen * unit * 0.5, e.y + legLen * unit * 0.5);
          var kRe = (1 - f.t / 0.78) * 0.55;
          f.next.lerp(_wp.b, kRe);
          f.nextYaw = angWrap(f.nextYaw + angWrap(bodyYaw
            + clamp(ta2, -0.62, 0.62) + sgn * AS.toeL[i] - f.nextYaw) * kRe);
        }
        f.t += dt / Math.max(0.05, f.dur);
        if (f.t >= 1) {
          f.t = 1; f.mode = 0; f.plant.copy(f.next); f.plantYaw = f.nextYaw;
          f.stanceT = 0; f.phPlant = phi; switched = true;
          /* ---- HEEL STRIKE ------------------------------------------
             Contact is an IMPULSE, not a pose. The body drops onto the leg,
             the leg gives, the mass rebounds and rings out over about two
             cycles at ~3.5 Hz. That ring is the whole sensation of weight;
             a rig whose only vertical motion is a smooth sinusoid can hit
             every contact on time and still weigh nothing. `landU` is the
             same event arriving at the shoulders and head a beat later, so
             the shock travels UP the body instead of happening to all of
             it at once. */
          var lmag = (0.30 + 1.00 * move) * GT.land * AS.bounce;
          st.land.impulse(-lmag * 10.5);
          st.landU.impulse(-lmag * 4.5);
          st.aLagY[0].impulse(-lmag * 0.55); st.aLagY[1].impulse(-lmag * 0.50);
          st.poleS[0].impulse(-lmag * 0.30); st.poleS[1].impulse(lmag * 0.30);
        }
      }

      /* ---- ankle roll, on the SAME clock as everything else ------------ */
      var prog = f.mode === 0
        ? clamp(cycFwd(phi, f.phPlant) / Math.max(0.08, dutyI), 0, 1)
        : clamp(f.t, 0, 1);
      footRoll(f.mode, prog, _roll);
      /* Bank whatever pose error an off-schedule switch just introduced and
         bleed it out over ~90 ms. C0 is exact, C1 to within the decay.
         The offset is taken on the FINAL applied angle, not on the raw curve:
         `rollScale` moves with speed and the ball-grind adds pitch of its own,
         so measuring the error before those are applied leaves a step in the
         pose exactly at the transition it exists to smooth. */
      var rollScale = moveK * (hi ? 1 : 0.85);
      var wantRP = _roll[0] * rollScale;
      var wantRT = _roll[1] * rollScale;
      if (switched) { f.rpO = f.lastRP - wantRP; f.rtO = f.lastRT - wantRT; }
      f.rpO = damp(f.rpO, 0, 1e-5, dt); f.rtO = damp(f.rtO, 0, 1e-5, dt);
      fi.rp = wantRP + f.rpO;
      fi.rt = wantRT + f.rtO;

      /* ---- target contact position ------------------------------------ */
      if (f.mode === 0) {
        _wp.a.copy(f.plant).applyMatrix4(_wp.inv);
        _tg[i].x = _wp.a.x; _tg[i].y = _wp.a.y; _tg[i].z = _wp.a.z;
      } else {
        /* Swing trajectory. The foot is at REST in world space at both ends of
           this arc -- it has just come off the ground and it is about to touch
           down -- so the profile must have zero derivative at t=0 and t=1.
           The old linear-in ease started the foot at ~7 u/s on the first frame
           of every step, which is a velocity discontinuity at every lift-off
           and is exactly what "puppet" looks like. smootherstep is C2 at both
           ends; the sine term front-loads it (quick off the ground, long
           float, soft landing) without touching the end derivatives. */
        var tt = f.t;
        var u = tt * tt * tt * (tt * (tt * 6 - 15) + 10);
        /* HORIZONTAL FINISHES FIRST. The foot is over its landing spot by 82%
           of the swing and the last 18% is a pure vertical placement.
           Without this the boot is still travelling ~50 mm a frame at the
           moment it enters the last 20 mm of its descent -- which is a foot
           arriving at a run and stopping dead, i.e. exactly the skate the
           plant lock exists to prevent, just moved one frame earlier. It is
           also what a person does: the swing foot is carried to the spot and
           then set down. Both ends are eased with smootherstep so the
           velocity is still zero at lift-off and at contact. */
        var xz = clamp((tt - 0.06) / 0.76, 0, 1);
        var ease = smst(xz);
        ease = ease + 0.16 * Math.sin(PI * ease) * (1 - ease);
        _wp.b.copy(f.last).lerp(f.next, ease).applyMatrix4(_wp.inv);
        /* height bell, peak at ~38% of the swing, zero slope at both ends */
        _wp.b.y += Math.pow(u, 0.62) * (1 - u) * 2.98 * lift * AS.liftL[i];
        _tg[i].x = _wp.b.x; _tg[i].y = _wp.b.y; _tg[i].z = _wp.b.z;
      }

      /* ---- load share: this is what the pelvis rides on --------------- */
      var load = 0;
      if (f.mode === 0) load = sstep(prog / 0.16) * sstep((1 - prog) / 0.13);
      f.load = load; fi.load = load;
      wSum += load; supX += load * _tg[i].x; supZ += load * _tg[i].z;

      /* ---- world-locked heading + contact-point pivot offsets ---------- */
      var yawRel = f.mode === 0
        ? angWrap(f.plantYaw - bodyYaw)
        : angWrap(lerp(0, angWrap(f.nextYaw - f.lastYaw), sstep(f.t)) + f.lastYaw - bodyYaw);
      /* Last line of defence: however far behind the body a planted foot has
         fallen, the RENDERED foot never points more than ~41 degrees off the
         hips. Past that it grinds round on the ball, which is exactly what a
         real foot does when the body out-turns it. */
      fi.yaw = clamp(yawRel, -0.72, 0.72);
      /* PIVOT ON THE BALL, NOT ON THE ANKLE.
         Past ~24 degrees of twist a flat sole cannot stay put while the body
         keeps turning. A real person comes up on the ball and grinds round on
         it -- and the heel LIFTING is what makes the rotation legitimate,
         because the part that sweeps is no longer touching anything. Feeding
         the lift into the roll before the pivot is computed makes rollPivot
         hand back the toe automatically, so the toe is the fixed point and
         the sweep costs nothing in slip. */
      /* The grind is a LAST RESORT, not the first response to a turn. Its
         onset sits ABOVE the twist failsafe's re-plant threshold on purpose:
         given a choice a person picks the foot up and puts it down further
         round, and only grinds when he cannot (both feet already cycling in
         a hard pivot). With the onset below the failsafe the grind simply
         tracked the body forever, the step never fired, and the operator
         tracked a target across 40 degrees on a pair of lazy Susans. */
      var grind = f.mode === 0
        ? clamp((Math.abs(yawRel) - 0.40) / 0.22, 0, 1) : 0;
      fi.grind = grind * 0.34;

      /* ---- ankle solved BACKWARDS from the rolling pivot ---------------- */
      /* Surface conforming: the ankle pitches onto the local slope and rolls
         onto the local camber, blended in over the first 25% of the stance so
         a foot never snaps onto a new gradient at touch-down. */
      /* A swing foot adopts the slope of the surface it is about to land on,
          and only in the last part of the swing -- at lift-off it is still
          leaving the OLD surface, so conforming to the new one from t=0 would
          tilt the boot to a gradient that is still half a stride away. */
      var conform = f.mode === 0 ? sstep(prog / 0.25) : sstep((f.t - 0.55) / 0.45);
      fi.sp = (f.slopeP || 0) * conform;
      fi.sr = (f.slopeR || 0) * conform;
      /* ROOT-ROLL LEVELLING. The root banks into a turn (rotation.z), and
         everything the foot solver computes is expressed in ROOT space -- so
         a sole that is level in root space is tilted by the bank in WORLD
         space, and at 6.5 degrees of bank across a 0.9-unit boot that is
         44 mm of one end driven through the floor. It measured as the whole
         of the turn180 penetration. A leaning body still has flat feet: undo
         the bank in the foot's own frame. */
      fi.sp += rootRoll * Math.sin(fi.yaw);
      fi.sr -= rootRoll * Math.cos(fi.yaw);
      /* The heel comes up so the foot can swivel -- and the TOES EXTEND by
         exactly as much, because a person pivoting on his foot keeps the ball
         and the toe pad flat on the floor and lifts only the heel. That is
         what makes the contact the metatarsal break rather than the tip of
         the boot: pivoting on a rigid sole either drives the toe box through
         the floor (tip down) or sweeps the real contact in a 60 mm arc
         (pivot ahead of it). Both were measured. */
      fi.rp += fi.grind;
      fi.rt -= fi.grind;
      f.lastRP = fi.rp; f.lastRT = fi.rt;   /* TOTAL applied, for the next switch */
      var fPitch = fi.rp + sp.metaPitch + fi.sp;
      var oy = -sp.groundUp, oz = 0, cz = 0, ox = 0;
      if (!sp.digitigrade) {
        /* Not a rigid sole: the boot breaks at the metatarsal and the toes
           stay flat while the heel comes up, so the contact is solved from
           the real two-segment profile (see soleContact). */
        soleContact(sp, fPitch, fi.sr, clamp(fi.rt - sp.metaPitch, -0.9, 0.95),
          Math.sin(fi.yaw), Math.cos(fi.yaw), sinRoll, cosRoll, _sole);
        cz = _sole.cz; ox = _sole.ox; oy = _sole.oy; oz = _sole.oz;
      }
      fi.cz = cz; fi.dz = cz - oz; fi.dx = -ox; fi.ay = -oy;

      /* ---- THE BALL PIVOT ITSELF -------------------------------------
         Lifting the heel is only half of it. Once the foot is up on the
         ball, the sole is FREE TO ROTATE about that contact -- so let it,
         and rotate the stored plant about the same point so the contact
         does not move by so much as a millimetre while it happens. Without
         this the stored plant yaw falls a full radian behind, the render
         clamp forces the foot to track the body anyway, and the toe is
         dragged across the floor at 6 mm a frame during every hard turn.
         With it, the toe is a pin and the foot swivels on it, which is what
         a person actually does. */
      if (f.mode === 0 && fi.grind > 1e-4) {
        var needY = angWrap(bodyYaw - f.plantYaw);
        /* The heel has to be OFF the floor before the foot is allowed to
             swivel, or a still-flat sole gets dragged round instead of
             pivoting. Squaring the ramp makes the lift lead the rotation. */
        var gk = fi.grind / 0.34;
        var mxY = 3.4 * dt * gk;
        var stpY = clamp(needY, -mxY, mxY);
        if (stpY !== 0) {
          var rW = fi.cz * sc;                       /* contact radius, world */
          var sy0 = Math.sin(f.plantYaw), cy0 = Math.cos(f.plantYaw);
          var sy1 = Math.sin(f.plantYaw + stpY), cy1 = Math.cos(f.plantYaw + stpY);
          f.plant.x += rW * (sy0 - sy1);
          f.plant.z += rW * (cy0 - cy1);
          f.plantYaw = angWrap(f.plantYaw + stpY);
          fi.yaw = clamp(angWrap(f.plantYaw - bodyYaw), -0.72, 0.72);
          _wp.a.copy(f.plant).applyMatrix4(_wp.inv);
          _tg[i].x = _wp.a.x; _tg[i].y = _wp.a.y; _tg[i].z = _wp.a.z;
        }
      }
    }

    /* ================= 6. pelvis: the centre of mass ==================== */
    /* Walking is controlled falling. The body is only ever balanced during
       double support; for most of the cycle it is genuinely off to one side,
       riding over one foot. Deriving the pelvis from the actual support
       instead of from sin(phase) is the difference between weight TRANSFER
       and a doll being waggled. */
    var supN = 0, supNZ = 0;
    if (wSum > 1e-3) {
      supN = clamp((supX / wSum) / Math.max(stanceW, 1e-3), -1.35, 1.35);
      supNZ = clamp((supZ / wSum) / Math.max(A, 1e-3), -1.4, 1.4);
    }
    var single = clamp(1 - Math.abs(st.feet[0].load - st.feet[1].load), 0, 1);   /* 0 = single support */
    /* LATERAL. The pelvis translates out over the loaded foot and, because it
       goes through a spring, it gets there LATE -- roughly a quarter of a
       cycle behind the foot that is carrying it. Weight transfer, not waggle. */
    var comWantX = supN * stanceW * 0.34 * moveK * GT.sway
      + st.shift * stanceW * 0.48 * idleK
      + st.antS.x * stanceW * 0.55 * AS.dom
      + leanBodyX * 0.16;                            /* hips follow the peek */
    /* VERTICAL. Lowest at contact, highest at mid-stance, second harmonic so
       the rise is quicker than the fall, and the heel-strike ring on top. */
    /* Amplitude, measured: this lands the pelvis at ~2% of body height
       peak-to-peak at a tactical walk and ~5% at a sprint, which is where a
       real one sits. The geometric drop from the leg-reach limit supplies
       maybe a third of that; the rest has to be commanded, because a short
       tactical stride barely bends the leg and would otherwise glide. */
    var bobA = (0.0300 + 0.0220 * run) * H * AS.bounce * move * GT.bob;
    /* Posture rides a spring: crouch level is a STATE, and a state that
       changes instantly is the definition of a pose snap. */
    st.crouchS.target = GT.crouch + GT.crouchV * (move + 0.72 * run)
      + st.stagger * 0.030 + wind * 0.016 + idleK * st.shift * st.shift * 0.006
      /* Settling onto the gun softens the knees -- it does not SIT the man
         down. Round 3 spent 0.078 of a leg (70 mm) here and the operator
         stood at an 842 mm hip against a 970 mm standing hip: a permanent
         quarter-squat, which is most of what read as "sitting on a bar
         stool". A real shooting stance is a soft knee, 30-50 mm. */
      + aimPrev * 0.027 * (1 - run)   /* soft knee only while mounted         */
      /* The head-top contract with NUKEM.html is fixed (-33% of h), but WHERE
         that height goes is not, and round 2 took all of it out of the hips:
         a 530 mm hip with a vertical trunk is a resting squat with the
         buttocks on the heels, which is a posture you cannot shoot or move
         from. A third of the drop now comes from the trunk folding forward
         over the knees (see `flexion` below), so the same silhouette height
         is reached as a coiled half-squat instead of a sit. */
      + crSt * 0.425;                 /* the commanded combat crouch          */
    st.crouchS.step(dt);
    var crouchK = clamp(st.crouchS.x, -0.02, 0.62);
    var comWantY = -(Math.cos(2 * phase) + 0.17 * Math.cos(4 * phase + 1.15)) * bobA
      - st.stagger * 0.026 * H
      - (st.hitLeg[0].x + st.hitLeg[1].x) * 0.20
      - legLen * crouchK                             /* stance-knee flexion    */
      + landK * 0.021 * H                            /* heel-strike shock      */
      + breathIn * 0.0060 * H * idleK;
    /* FORE / AFT. Mostly acceleration: a body that starts, stops or brakes
       without its mass arriving late has no inertia. */
    /* WEIGHT FORWARD. Round 3 put the pelvis 10 mm BEHIND the mean ankle,
       i.e. the mass sat on the heels, which is the posture of a man being
       pushed backwards by his own rifle. A shooter drives the other way:
       centre of mass over the balls of the feet, 40-60 mm ahead of the
       ankle, so the recoil is absorbed forward. */
    var comWantZ = -Math.cos(2 * phase) * 0.0060 * H * move * GT.surge
      + supNZ * 0.014 * H * moveK * GT.surge
      - move * 0.010 * H - rec * 0.004 * H
      + antic * 0.150 * H * GT.surge - wind * 0.006 * H
      + stanceK * 0.026 * H            /* onto the balls of the feet          */
      - crSt * 0.062 * H
      + leanBodyZ * 0.10;              /* oblique peeks do not hinge at waist */

    st.comX.target = comWantX; st.comX.step(dt);
    st.comZ.target = comWantZ; st.comZ.step(dt);
    st.comY.target = sp.hipY + comWantY; st.comY.step(dt);

    var hips = B[ix.hips];
    /* pelvic list: the pelvis DROPS on the swing side (Trendelenburg). A
       pelvis that stays level through a step is the marionette tell. */
    var listAmt = (0.058 + 0.060 * run) * moveK * (0.5 + 0.5 * GT.sway);
    var pelvisRoll = supN * listAmt + st.hitR.x * 0.18 + st.shift * 0.048 * idleK
      + st.lean.x * 0.10;
    var pelvYawAmp = (0.055 + 0.105 * run) * moveK * AS.pelvYaw * GT.pelvYaw;
    var pelvisYaw = -Math.sin(phase) * pelvYawAmp + st.yaw.x * 0.07 * aim - turnErr * 0.30;
    var pelvisPitch = -0.02 - move * 0.040 - antic * 0.50 - st.pitch.x * 0.06 * aim
      + st.hitP.x * 0.22 - landK * 0.050;

    /* ---- LEG REACH, solved against the REAL hip joints -------------------
       The reach ceiling used to be measured from the pelvis ORIGIN, which is
       not where either leg is attached: the pelvis also translates (comX,
       comZ) and rotates (list, yaw, pitch), and a braking stop pushes it up
       to 0.16 units back while the leading foot is 1.4 units forward. Solving
       the triangle from the pelvis origin therefore under-reports the span by
       ~10% exactly when the span matters, the leg cannot reach, and the boot
       hovers 17 mm off the floor for the rest of the stance -- measured.

       Here the hip joint offset is transformed by the pelvis rotation first,
       so the constraint is exact. None of the rotation terms depend on the
       hip HEIGHT, so this stays a closed form: no iteration. */
    _wp.eul.set(pelvisPitch, pelvisYaw, pelvisRoll, 'XYZ');
    _wp.q.setFromEuler(_wp.eul);
    var hipWant = st.comY.x;
    var maxSpan = legLen * 0.988;
    for (i = 0; i < 2; i++) {
      if (st.feet[i].mode !== 0) continue;
      /* hip joint offset from the pelvis origin, in root space */
      _wp.f.set(st.feet[i].side * sp.hipW, 0, 0.002 * H).applyQuaternion(_wp.q);
      var syR = Math.sin(_fi[i].yaw), cyR = Math.cos(_fi[i].yaw);
      var ankX = _tg[i].x + _fi[i].dz * syR + _fi[i].dx * cyR;
      var ankZ = _tg[i].z + _fi[i].dz * cyR - _fi[i].dx * syR;
      var horiz = Math.hypot(ankX - (st.comX.x + _wp.f.x), ankZ - (st.comZ.x + _wp.f.z));
      if (horiz >= maxSpan) { overreach = true; horiz = maxSpan * 0.999; }
      var maxUp = Math.sqrt(maxSpan * maxSpan - horiz * horiz)
        + _tg[i].y + _fi[i].ay - _wp.f.y;
      hipWant = smin(hipWant, maxUp, legLen * 0.014);
    }
    /* Floor. A squat is a worse artefact than a hovering boot only up to a
       point: past ~30% of the leg the character is crouching, so that is
       where the floor sits, and it is a SOFT floor -- a hard clamp here is
       what let the reach limit be overridden and the foot float. */
    var hipFloor = sp.hipY - legLen * (0.300 + crouchK);
    hipWant = -smin(-hipWant, -hipFloor, legLen * 0.012);
    /* A body can drop as fast as gravity but can only push itself up as fast
       as the legs extend. Without this, the frame a braking foot leaves the
       ground releases the reach limit and the pelvis snaps up. */
    var maxRise = legLen * 1.45 * dt;
    if (hipWant > st.hipYSm + maxRise) hipWant = st.hipYSm + maxRise;
    st.hipYSm = hipWant;
    var bobVel = (hipWant - st.lastBob) / Math.max(dt, 1e-3);
    st.lastBob = hipWant;
    st.bobV = damp(st.bobV, clamp(bobVel, -30, 30), 0.0002, dt);

    hips.position.set(st.comX.x, st.hipYSm, st.comZ.x);
    hips.rotation.set(pelvisPitch, pelvisYaw, pelvisRoll);
    hips.updateMatrix();

    /* ================= 7. spine: lagged, counter-rotating =============== */
    /* Each link up the chain reads the SAME wave a little later. That
       progressive delay -- hips, then lumbar, then thorax, then shoulders,
       then head -- is what a chain of bones driven by one sin() can never
       produce, and it is the loudest single tell in the list. */
    /* The delay is a fraction of the CYCLE, not a fixed number of seconds.
       A fixed time lag is nearly a whole quarter-cycle at running cadence and
       almost nothing at a crawl, which makes the counter-rotation invert as
       the character speeds up. Real thorax-vs-pelvis phase stays put. */
    var lk = AS.lagK;
    var l1 = 0.026 * TAU * lk, l2 = 0.048 * TAU * lk, l3 = 0.075 * TAU * lk;
    var ctr = 2.05 * pelvYawAmp * GT.twist;          /* total relative twist  */
    var sY = ctr * 0.26 * Math.sin(phase - l1);
    var s2Y = ctr * 0.34 * Math.sin(phase - l2);
    var cY = ctr * 0.40 * Math.sin(phase - l3);

    /* aim twist, sprung so the torso overshoots and settles into the aim */
    st.chY.target = st.yaw.x * lookAim; st.chY.step(dt);
    st.chP.target = st.pitch.x * lookAim; st.chP.step(dt);
    var twistAim = st.chY.x, pitchAim = st.chP.x;

    /* Trunk flexion. A body moving at speed is FALLING forward and catching
       itself; standing upright at a sprint is the surest sign nothing is
       driving the motion. leanRun is the animal's own answer to that. */
    /* Trunk flexion. `crSt * 0.52` is the crouch: with the hips half a leg
       lower the mass has to come forward over the feet or the operator sits
       down. It is also what gets the head to h*0.628 without folding the
       neck -- the gaze solver then takes the head back UP to the sight line,
       so the eye ends up over the stock with the chest over the knees, which
       is the pose. */
    /* LEAN INTO THE GUN. Measured at round 3: the shoulders sat 78 mm ahead
       of the hips, a 9 degree trunk angle, and the head only 102 mm ahead of
       the mean ankle -- so the operator's nose was BEHIND his toes and the
       whole figure read as recoiling away from the weapon rather than
       driving it. A shooter carries 14-16 degrees of trunk flexion with the
       shoulders rolled forward and the chin out over the leading foot. */
    /* A forward run is controlled falling; a lateral slice or back-pedal is
       not. The old unconditional run lean folded a strafing soldier toward
       his muzzle as if an invisible rope were pulling his chest. */
    var travelLeanK = 0.42 + 0.58 * Math.max(0, mdz);
    var flexion = 0.02 + move * GT.leanRun * travelLeanK + antic * 1.35 + st.stagger * 0.20
      + wind * 0.045 - landU * 0.045 + aim * 0.158 + stanceK * 0.045
      + crSt * 0.62;                  /* trunk folds over the knees, 33 deg  */
    var sideBend = -supN * 0.060 * moveK * GT.sideBend;   /* over the loaded leg */
    /* bank the trunk into the turn, on top of the root roll */
    var turnBend = -clamp(st.turnSm, -9, 9) * 0.0075;
    var lat1 = Math.sin(phase - l1) * 0.024 * moveK * GT.sideBend;
    var bK = GT.breath;

    /* AIM IS A LAYERED ADDITIVE (brief 3.2): the pitch and yaw of the shot
       are spread 15/15/30 down the trunk and the remaining 40% is taken by
       the neck and head through the gaze solver below -- which lands almost
       exactly on the 30 / 30 / 20 / 20 the brief asks for. Rotating the whole
       body instead is what makes a character read as a turret. */
    B[ix.spine].rotation.set(
      flexion * 0.30 + pitchAim * 0.15 + breath * 0.010 * bK + st.hitP.x * 0.45,
      sY + twistAim * 0.15 - turnErr * 0.10,
      st.hitR.x * 0.38 + sideBend * 0.34 - lat1 + st.lean.x * 0.22 + turnBend * 0.34
    );
    B[ix.spine2].rotation.set(
      flexion * 0.32 + pitchAim * 0.15 + breath * 0.013 * bK
      + lerp(st.hitP.x, st.f1P.x, 0.5) * 0.35,
      s2Y + twistAim * 0.15 - turnErr * 0.09 + 0.05 + aim * 0.07,
      lerp(st.hitR.x, st.f1R.x, 0.5) * 0.28 + sideBend * 0.33 + st.lean.x * 0.16
      + turnBend * 0.33
    );
    B[ix.chest].rotation.set(
      flexion * 0.30 + pitchAim * 0.30 - rec * 0.07 + breath * 0.022 * bK
      + st.f1P.x * 0.32 - landU * 0.030,
      cY + twistAim * 0.30 + st.f1Y.x * 0.20 - turnErr * 0.08 + 0.10 + aim * 0.16,
      st.f1R.x * 0.28 + sideBend * 0.33 + st.lean.x * 0.14 + turnBend * 0.33
    );
    /* Shoulder girdle. This is where the arm swing actually comes from: the
       clavicle protracts and retracts a quarter-cycle behind the chest twist
       and the whole arm chain rides it. It also rises on the inhale, drops
       under the heel-strike shock, and reacts to a hit on its own side. */
    var clavPh = Math.sin(phase - l3 - 0.35) * 0.058 * moveK * AS.armK * GT.armK;
    var clavUp = breathIn * 0.052 * bK - landU * 0.045;
    var clavOut = GT.armOut * 0.22;
    /* PROTRACTION. The support-side scapula slides a long way forward when a
       shooter drives a C-clamp onto the handguard -- 60 to 90 mm of real
       travel -- and without it the support arm is simply too short to reach
       the front of an 880 mm rifle, which is why the old pose left the left
       hand hanging in the air near the magazine. The firing shoulder rolls
       the other way, rearward and up into the stock. */
    /* PROTRACTION, BUT NOT A SHRUG ROUND THE FRONT. 0.34 + 0.32*aim is 38
       degrees of scapular protraction on the support side -- roughly double
       what a shoulder girdle can actually do -- and it was costing the
       silhouette its width: measured biacromial fell to 289 mm against a
       410 mm reference, which is what made the operator read narrow-chested
       from the front. 26 degrees at a full mount still buys the reach (the
       harness measures the support hand at 42 mm of a 70 mm budget) and the
       shoulders stay square to the target, which is the CS2 read. */
    B[ix.clavL].rotation.set(
      -0.08 + st.f1P.x * 0.20 + st.hitArm[0].x * 0.55 - clavPh - wind * 0.10,
      0.24 + 0.21 * aim + st.fidArm * 0.09,
      -0.05 - clavOut - st.hitArm[0].x * 0.35 - clavUp - clavPh * 0.5);
    B[ix.clavR].rotation.set(
      -0.08 + st.f1P.x * 0.20 + st.hitArm[1].x * 0.55 + clavPh - wind * 0.10,
      -0.10 * aim - st.fidArm * 0.09,
      0.05 + clavOut + st.hitArm[1].x * 0.35 + clavUp - clavPh * 0.5 - aim * 0.12);
    B[ix.spine].updateMatrix();
    B[ix.spine2].updateMatrix();
    B[ix.chest].updateMatrix();

    /* ================= 8. head: last in the chain ====================== */
    var accPitch = pelvisPitch + B[ix.spine].rotation.x + B[ix.spine2].rotation.x + B[ix.chest].rotation.x;
    var accYaw = pelvisYaw + B[ix.spine].rotation.y + B[ix.spine2].rotation.y + B[ix.chest].rotation.y;
    var accRoll = pelvisRoll + B[ix.spine].rotation.z + B[ix.spine2].rotation.z + B[ix.chest].rotation.z;
    /* Targets are in WORLD terms (relative to the root), so the neck and head
       have to undo whatever the trunk did -- that is gaze stabilisation, and
       it is why the head stays level while the body bobs under it. */
    /* The flinch reaches the head through f2 -- two soft links behind the
       trunk -- so a round in the chest snaps the shoulders first and the head
       whips after it. The head also LEADS a turn (turnSm), stays level
       against the banked root (the -lean term is the vestibular reflex), and
       nods once under each heel strike. */
    /* When he is on the gun the head goes ALL the way to the aim -- the
       sight line runs through this eye and nothing else will do. When he is
       not, it is a look, not an aim, and it only goes part of the way. The
       extra downward bias and the roll toward the stock are the cheek weld:
       a head that stays vertical over a shouldered rifle is the single most
       obvious "never held one" tell after the grip itself. */
    var aimLook = clamp(lookAim + (1 - lookAim) * 0.55 * alertK, 0, 1.05);
    st.hdP.target = st.pitch.x * aimLook - 0.02 - st.f2P.x * 0.55 + st.scanP
      - clamp(st.bobV, -6, 6) * 0.010 - landU * 0.040 + wind * 0.030
      - aim * 0.130;                                  /* head down onto the comb */
    st.hdY.target = angWrap(st.yaw.x * aimLook * (0.55 + 0.45 * GT.headK))
      + st.f2Y.x * 0.55 + st.scanY * (1 - aim * 0.7)
      + clamp(st.turnSm * 0.075, -0.40, 0.40) * GT.headLead;
    st.hdR.target = -st.f2R.x * 0.30 - supN * 0.020 * moveK + AS.headTilt
      - st.lean.x * 0.25 + aim * 0.085;               /* cheek rolls to the comb */
    st.hdP.step(dt); st.hdY.step(dt); st.hdR.step(dt);

    /* CHEEK WELD. The neck flexes forward and the head pitches back up on
       top of it -- which is how a shooter gets his eye DOWN to the stock
       without looking at the floor. The eye drops by the neck length times
       (1-cos), which is the only term in the whole chain that can actually
       close the gap between a standing eye height and a 40 mm sight height. */
    var neckP = clamp((st.hdP.x - accPitch) * 0.45 + aim * 0.26, -0.42, 0.62);
    var neckY = clamp((st.hdY.x - accYaw) * 0.45, -0.55, 0.55);
    var neckR = clamp((st.hdR.x - accRoll) * 0.45, -0.35, 0.35);
    B[ix.neck].rotation.set(neckP + 0.03, neckY, neckR);
    /* ...and the cervical spine does not only ROTATE. Getting a cheek onto a
       comb moves the head bodily down and forward: a standing eye sits ~210
       mm above the acromion, a shouldered rifle's sight line sits ~70 mm
       above it, and no amount of neck ROTATION closes 140 mm without putting
       the operator's chin on his chest. Real shooters translate -- they
       hunch onto the gun. Split 40/60 between the two joints so the neck
       geometry compresses rather than one bone tearing away from the other. */
    /* ...and it is not only a DROP. The stock sits in the right shoulder
       pocket, which is ~65 mm outboard of the neck, so an eye that stays on
       the body centreline is that far off the sight plane no matter how far
       down it comes -- and lateral miss is exactly what the residual was
       made of (measured: 72-96 mm mean, and most of it sideways). A shooter
       closes it by laying his head OVER onto the comb: the neck side-bends,
       the head translates toward the firing side and rolls onto the stock.
       All three, in the proportions a cheek weld actually uses. */
    var weld = aim * 0.042 * H, weldZ = aim * 0.022 * H, weldX = aim * 0.026 * H;
    B[ix.neck].position.set(weldX * 0.38, sp.neck - weld * 0.40, -0.010 * H + weldZ * 0.40);
    B[ix.head].position.set(weldX * 0.62, sp.headUp - weld * 0.60, 0.012 * H + weldZ * 0.60);
    B[ix.head].rotation.set(
      clamp(st.hdP.x - accPitch - neckP, -0.62, 0.50),
      clamp(st.hdY.x - accYaw - neckY, -0.60, 0.60),
      clamp(st.hdR.x - accRoll - neckR, -0.40, 0.40)
    );

    /* ================= 9. THE MOUNT ====================================
       "How they hold their weapon is very weird" -- brief section 3.2. The
       old build put the rifle at a hand-tuned offset in front of the chest
       and pointed it with a Euler triple, then asked the hands to chase it.
       That gets the gun into the frame but it is not a MOUNT: nothing in it
       knows where the shoulder pocket is, nothing knows where the eye is,
       and nothing guarantees the sight line closes.

       This solves the mount from the two things that physically define it:

         1. the buttplate sits in the shoulder pocket
         2. the shooter's dominant eye sits behind the rear sight, on the
            bore axis offset by the sight height

       Both are computed in CHEST space (the weapon bone's parent), the eye
       from the ACTUAL neck and head matrices this frame -- so when the head
       turns to track a target the weapon follows the head rather than the
       other way round, which is the difference between aiming and waving.

       The two constraints cannot both be satisfied exactly by a human with
       a 40 mm sight height, which is why cheek risers exist. They are
       blended: as the operator settles into the shot the sight line wins, at
       low ready the pocket wins. The residual on each is measured by the
       harness (mountResidual below), not assumed.
       ================================================================== */
    var W = B[ix.weapon];
    var GD = gunSpec(sp);
    var lowReady = 1 - aim;

    /* the dominant (right) eye, in chest space, this frame */
    B[ix.neck].updateMatrix(); B[ix.head].updateMatrix();
    _wp.m3.copy(B[ix.neck].matrix).multiply(B[ix.head].matrix);
    _wp.eye.set(0.018 * H, 0.011 * H, sp.headD * 0.62).applyMatrix4(_wp.m3);

    /* THE ARM SWING LIVES HERE. Both hands are on the weapon, so the
       weapon's excursion relative to the chest IS the arm motion. The
       locomotion swing is applied DIRECTLY, not through a spring: a
       second-order filter driven near its own natural frequency lags by up
       to 90 degrees, which at a sprint cadence puts the weapon a quarter
       cycle behind the shoulders that are carrying it. */
    var swK = moveK * AS.armK * GT.armK;
    var wSwing = (0.011 + 0.026 * run) * H * swK * (0.72 + 0.55 * lowReady);
    var wxLoco = wSwing * Math.sin(phase - l3 - 0.30);
    var wyLoco = -(0.0060 + 0.0140 * run) * H * Math.cos(2 * (phase - l3)) * swK;
    var wzLoco = (0.0035 + 0.0090 * run) * H * Math.sin(2 * (phase - l3) + 0.9) * swK;
    var wpLoco = (0.05 + 0.14 * run) * Math.cos(2 * (phase - l3) + 0.4) * swK;
    st.wx.target = st.fidArm * 0.008 * H;
    st.wy.target = breath * 0.0026 * H * bK + landU * 0.016 * H;
    st.wz.target = -rec * 0.028 * H - wind * 0.013 * H;
    st.wpitch.target = 0;
    st.wx.step(dt); st.wy.step(dt); st.wz.step(dt); st.wpitch.step(dt);

    /* ---- bore direction, in chest space ------------------------------- */
    /* The trunk already carries 60% of the aim (section 7), so the weapon
       only has to supply the REMAINDER. Subtracting the accumulated trunk
       rotation is what makes this an additive aim layer rather than a
       second, competing one. */
    var aimPT = st.pitch.x * aim, aimYT = st.yaw.x * aim;
    var borePitch = aimPT - accPitch - lowReady * (0.66 + AS.carryP)
      - rec * 0.17 - st.wpitch.x * 0.45 - wpLoco + landU * 0.020;
    var boreYaw = angWrap(aimYT - accYaw) - lowReady * 0.12 - st.fidArm * 0.05;
    borePitch = clamp(borePitch, -1.25, 0.95);
    boreYaw = clamp(boreYaw, -0.85, 0.85);
    var cbp = Math.cos(borePitch), sbp = Math.sin(borePitch);
    _wp.fwd.set(Math.sin(boreYaw) * cbp, sbp, Math.cos(boreYaw) * cbp).normalize();
    /* orthonormal basis with +Z on the bore, then the cant rolled about it.
       A weapon held with zero cant reads as a prop bolted to a turret; a
       real shooter cants inboard a few degrees and the cant breathes with
       the stride. */
    _wp.rgt.set(0, 1, 0).cross(_wp.fwd);
    if (_wp.rgt.lengthSq() < 1e-6) _wp.rgt.set(1, 0, 0);
    _wp.rgt.normalize();
    _wp.upv.copy(_wp.fwd).cross(_wp.rgt).normalize();
    _wp.mw.makeBasis(_wp.rgt, _wp.upv, _wp.fwd);
    _wp.qw.setFromRotationMatrix(_wp.mw);
    var cant = -0.09 * aim - lowReady * (0.26 + AS.carryC) + rec * 0.10 * e.strafe
      + Math.sin(phase - l3) * 0.050 * swK - st.lean.x * 0.10;
    _wp.qc.setFromAxisAngle(AXIS_Z, cant);
    _wp.qw.multiply(_wp.qc);

    /* ---- constraint 1: the buttplate in the shoulder pocket ----------- */
    /* Where the stock actually goes. A modern shooter mounts HIGH: the
       buttplate rides on the shelf where the deltoid meets the trapezius,
       at or just above the acromion, not down in the armpit. That is what
       lets a 40 mm sight height work at all -- see below. `aim` shrugs the
       firing shoulder up into it, which is a real thing shooters do. */
    /* The pocket itself comes INBOARD as he squares up: a modern isoceles
       stance rolls the firing shoulder forward and brings the buttplate
       toward the sternum, which is the other half of closing the sight
       line. At low ready it stays out on the deltoid where it belongs. */
    _wp.pk.set(sp.shoulderX + sp.armOut * (0.48 - 0.13 * aim),
      sp.shoulderY + 0.010 * H + aim * 0.014 * H,
      sp.chestD * 0.46 - lowReady * 0.030 * H + aim * 0.006 * H);
    _wp.bt.set(GD.butt[0], GD.butt[1], GD.butt[2]).applyQuaternion(_wp.qw);
    W.position.copy(_wp.pk).sub(_wp.bt);

    /* ---- constraint 2: the eye ON the sight line ---------------------- */
    /* The eye does not sit at a POINT behind the sight -- it sits on the
       LINE through it. Longitudinal position along that line is free (it is
       just eye relief, and for irons or a red dot that is anywhere from 250
       to 450 mm), so the only real error is the PERPENDICULAR miss. Forcing
       a point instead of a line is what left the old solve a third of a
       metre out and pulled the stock off the shoulder to compensate.

       Correcting perpendicular to the bore is also the only correction that
       is free: it slides the weapon up the shoulder without touching the
       direction it is pointing, so the aim stays exactly where the AI asked
       for it. The remainder is taken out by the head coming down onto the
       comb (section 8) -- which is what a shooter actually does. */
    _wp.sg.set(GD.sight[0], GD.sight[1], GD.sight[2]).applyQuaternion(_wp.qw).add(W.position);
    _wp.oS.copy(_wp.eye).sub(_wp.sg);
    var along = _wp.oS.dot(_wp.fwd);
    _wp.oS.addScaledVector(_wp.fwd, -along);        /* perpendicular component */
    /* ...but only so far. The stock may ride UP the shoulder shelf; it may
       not levitate next to the operator's ear. Past ~35 mm the remaining
       error stays in the sight line, where it is invisible from third
       person, instead of in the stock position, where it is not. */
    var perpLen = _wp.oS.length();
    var maxShift = (0.008 + 0.024 * aim) * H;
    var shift = Math.min(perpLen * (0.28 + 0.42 * aim), maxShift);
    if (perpLen > 1e-6) W.position.addScaledVector(_wp.oS, shift / perpLen);
    st.mountSight = perpLen - shift;
    st.mountButt = shift;
    /* locomotion sway and the transient springs ride on top of the solved
       mount, never underneath it */
    W.position.x += st.wx.x + wxLoco;
    W.position.y += st.wy.x + wyLoco;
    W.position.z += st.wz.x + wzLoco;
    W.quaternion.copy(_wp.qw);
    W.updateMatrix();

    /* ================= 10. hands onto the grips ========================
       The right hand takes the pistol grip, the left is solved onto the
       HANDGUARD -- not mirrored from the right, which is what made the old
       pose read as a man holding a plank with two identical claws. Both
       targets come out of the weapon's own dimension table, so they move
       when the weapon does and they are correct for each pattern: forend on
       the shotgun, C-clamp on the ARs, well back on the DMR's chassis.
       ================================================================== */
    var gripR = _wp.a, gripL = _wp.b;
    gripR.set(GD.gripR[0], GD.gripR[1], GD.gripR[2]).applyMatrix4(W.matrix);
    gripL.set(GD.gripL[0], GD.gripL[1], GD.gripL[2]).applyMatrix4(W.matrix);
    /* REACH CLAMP on the support hand. A 1160 mm DMR has more handguard than
       a 1.83 m operator has arm, and an IK target beyond the chain's length
       does not fail loudly -- it silently straightens the elbow and leaves
       the hand short of the wood, which is exactly the "floating claw" the
       brief calls out. So the grip slides BACK along the handguard until it
       is inside the reach envelope, which is also what a real shooter does
       with a long rifle. */
    /* measured from the ACTUAL left shoulder this frame -- it has protracted
       and the trunk has bladed, and both buy real reach */
    B[ix.clavL].updateMatrix();
    _wp.gt.copy(B[ix.armL].position).applyMatrix4(B[ix.clavL].matrix);
    var armReach = (sp.upperArm + sp.foreArm) * 0.975;
    _wp.elb.copy(gripL).sub(_wp.gt);
    var gl = _wp.elb.length(), glClamp = 0;
    if (gl > armReach) {
      glClamp = gl - armReach;
      _wp.elb.multiplyScalar(1 / gl);                     /* unit, shoulder->grip */
      gripL.copy(_wp.gt).addScaledVector(_wp.elb, armReach);
    }
    /* ---- OVERLAP / FOLLOW-THROUGH on the arms ------------------------
       A hand does not teleport with the object it holds. These springs
       chase the grip; blending part-way toward them leaves the wrists and
       elbows a few centimetres behind on the way out and slightly ahead on
       the reversal. The TRIGGER hand is nearly rigid (it is what holds the
       gun); only the support hand is allowed real lag, and even that is
       small -- a support hand that lags visibly is a support hand that is
       not gripping anything. */
    if (!st.aInit) {
      st.aInit = 1;
      st.aLagX[0].set(gripR.x); st.aLagY[0].set(gripR.y); st.aLagZ[0].set(gripR.z);
      st.aLagX[1].set(gripL.x); st.aLagY[1].set(gripL.y); st.aLagZ[1].set(gripL.z);
    }
    st.aLagX[0].target = gripR.x; st.aLagY[0].target = gripR.y; st.aLagZ[0].target = gripR.z;
    st.aLagX[1].target = gripL.x; st.aLagY[1].target = gripL.y; st.aLagZ[1].target = gripL.z;
    st.aLagX[0].step(dt); st.aLagY[0].step(dt); st.aLagZ[0].step(dt);
    st.aLagX[1].step(dt); st.aLagY[1].step(dt); st.aLagZ[1].step(dt);
    /* The lag is deliberately SMALL. A hand that visibly trails the handguard
       it is gripping is a hand that is not gripping anything; the overlap and
       follow-through belong on the weapon itself (st.wx/wy/wz/wpitch above)
       and on the elbows, which is where a real linkage stores it. */
    var lagK = clamp(0.020 * GT.armLag * (0.55 + 0.75 * moveK), 0, 0.040);
    gripR.set(lerp(gripR.x, st.aLagX[0].x, lagK),
      lerp(gripR.y, st.aLagY[0].x, lagK),
      lerp(gripR.z, st.aLagZ[0].x, lagK));
    gripL.set(lerp(gripL.x, st.aLagX[1].x, lagK * 1.4),
      lerp(gripL.y, st.aLagY[1].x, lagK * 1.4),
      lerp(gripL.z, st.aLagZ[1].x, lagK * 1.4));
    /* Elbow flare. The pole is only a STARTING GUESS now -- poseArm gradient-
       descends it against a torso-clip and shoulder-height penalty, so this
       just supplies the character (a heavy operator braces wider) and the
       transient jog under every heel strike. */
    /* A crouched shooter's elbows go OUT, not in: the trunk is closer to the
       weapon so the same grip needs a wider bend plane, and driving the
       elbows through the ribs is what the descent below would otherwise have
       to dig its way out of every frame. */
    st.poleS[0].target = -0.30 - GT.armOut * 0.55 - run * 0.10 - wind * 0.12 - crSt * 0.22;
    /* The support elbow needs MORE clearance at a sprint, not the same: the
       trunk is folded further forward, the yoke and cummerbund stand proud of
       the ribs, and the arm has to bend round both. Measured: one grazing
       frame at spine2 on the left at top speed before this. */
    st.poleS[1].target = 0.38 + GT.armOut * 0.55 + run * 0.26 + wind * 0.14 + crSt * 0.24;
    st.poleS[0].step(dt); st.poleS[1].step(dt);
    /* the physical contact patches, in chest space */
    _wp.oP.set(GD.gripRPt[0], GD.gripRPt[1], GD.gripRPt[2]).applyMatrix4(W.matrix);
    _wp.oS.set(GD.gripLPt[0], GD.gripLPt[1], GD.gripLPt[2]).applyMatrix4(W.matrix);
    if (glClamp > 0) {
      /* PULL THE RIFLE IN, don't peel the hand off. When the support arm
         comes up short -- which only happens transiently, mid-hard-turn,
         with a 1005 mm shotgun or a 1160 mm DMR -- a real shooter drags the
         weapon back into his body rather than letting go of the handguard.
         Most of the shortfall is taken out of the weapon here and only the
         remainder out of the grip station, so the hand stays on the wood. */
      var pull = Math.min(glClamp * 0.80, 0.055 * H);
      W.position.addScaledVector(_wp.fwd, -pull);
      W.updateMatrix();
      gripR.set(GD.gripR[0], GD.gripR[1], GD.gripR[2]).applyMatrix4(W.matrix);
      gripL.set(GD.gripL[0], GD.gripL[1], GD.gripL[2]).applyMatrix4(W.matrix);
      _wp.oP.set(GD.gripRPt[0], GD.gripRPt[1], GD.gripRPt[2]).applyMatrix4(W.matrix);
      _wp.oS.set(GD.gripLPt[0], GD.gripLPt[1], GD.gripLPt[2]).applyMatrix4(W.matrix);
      var rest = glClamp - pull;
      if (rest > 0) _wp.oS.addScaledVector(_wp.elb, -rest);
      st.mountButt += pull;
    }
    poseArm(c, ix, sp, 'R', gripR, clamp(st.poleS[0].x, -1.3, 0.6), aim, hi, _wp.oP);
    poseArm(c, ix, sp, 'L', gripL, clamp(st.poleS[1].x, -0.6, 1.3), aim, hi, _wp.oS);

    /* ================= 11. legs ======================================== */
    _wp.inv2.copy(hips.matrix).invert();
    for (i = 0; i < 2; i++) {
      N = i ? 'R' : 'L';
      fi = _fi[i];
      /* Pivot about the CONTACT point, not the ankle. Rolling the foot about
         the ankle drags whatever is touching the ground across it; the ankle
         has to be solved backwards from a stationary heel (at strike) or toe
         (at push-off). This is the difference between a foot that plants and
         a foot that scuffs. */
      var syw = Math.sin(fi.yaw), cyw = Math.cos(fi.yaw);
      _wp.c.set(_tg[i].x + fi.dz * syw + fi.dx * cyw, _tg[i].y + fi.ay,
        _tg[i].z + fi.dz * cyw - fi.dx * syw).applyMatrix4(_wp.inv2);
      var over = solveTwoBone(B[ix['thigh' + N]], B[ix['shin' + N]],
        _wp.c.x, _wp.c.y, _wp.c.z, sp.digitigrade ? 0.06 : 0.0, sp.thigh, sp.shin);
      if (over) overreach = true;
      B[ix['thigh' + N]].updateMatrix();
      B[ix['shin' + N]].updateMatrix();

      _wp.m.copy(hips.matrix).multiply(B[ix['thigh' + N]].matrix).multiply(B[ix['shin' + N]].matrix);
      _wp.q.setFromRotationMatrix(_wp.m);
      /* YXZ: roll (camber) first, then pitch (slope + heel-to-toe), then the
         world-locked yaw. The ankle offsets above were solved against exactly
         this composition, so the sole lands ON the surface, not near it. */
      _wp.eul.set(fi.rp + sp.metaPitch + fi.sp, fi.yaw, fi.sr, 'YXZ');
      _wp.q2.setFromEuler(_wp.eul);
      _wp.q3.copy(_wp.q).invert().multiply(_wp.q2);
      B[ix['foot' + N]].quaternion.copy(_wp.q3);
      B[ix['toe' + N]].rotation.set(clamp(fi.rt - sp.metaPitch, -0.9, 0.95), 0, 0);
    }
    void overreach; void single;

    /* ================= 12. fingers / tail ============================== */
    var curl = 0.35 + aim * 0.28 + wind * 0.10;
    B[ix.fingL].rotation.set(clamp(curl + st.fidArm * 0.10, 0, 1.1), 0, 0);
    B[ix.fingR].rotation.set(clamp(curl * 1.05 - rec * 0.06, 0, 1.15), 0, 0);
    /* TRIGGER DISCIPLINE. Straight along the receiver at rest and through the
       whole approach; it only comes onto the trigger in the last fraction of
       the wind-up and snaps back after the shot. The finger leads the round
       by about 60 ms, which is why `wind` (the pre-fire coil) drives it and
       not the recoil. */
    if (ix.trigR !== undefined) {
      var onTrigger = clamp(wind * 1.25 - 0.30, 0, 1) + clamp(rec * 1.8, 0, 0.85);
      B[ix.trigR].rotation.set(-0.30 + onTrigger * 1.05, 0, 0);
    }

    if (sp.tail) {
      /* the tail is pure follow-through: it reads the pelvis one beat late */
      for (i = 0; i < sp.tail; i++) {
        var tb = B[ix['tail' + i]];
        var tl = 0.055 * TAU * (i + 1);
        tb.rotation.set(
          (i ? 0.10 : -1.30) + Math.sin(now * 1.9 + st.seed + i * 0.7) * 0.10
          - Math.cos(2 * (phase - tl)) * 0.055 * moveK,
          Math.sin(now * 2.4 + st.seed + i * 0.9) * (0.20 - i * 0.045)
          - st.yaw.x * 0.10 - Math.sin(phase - tl) * (0.14 - i * 0.03) * moveK,
          Math.cos(now * 1.7 + st.seed + i) * 0.08 - pelvisRoll * (0.5 - i * 0.1)
        );
      }
    }

    /* ---------- ragdoll velocity sampling ------------------------------ */
    /* Only once an enemy is hurt enough to be a plausible corpse -- then the
       ragdoll can inherit the real per-limb velocity of the animation
       instead of one rigid body-wide shove. */
    if (e.hp <= cfg.hp * 0.72) sampleRagPoints(e, rig, c, now);
    else st.prevValid = false;
  }

  /* -------------------------------------------------------------------------
     ELBOWS ARE SOLVED AFTER THE HANDS.

     A two-bone IK with a fixed pole vector puts the hand exactly where it was
     asked and the elbow wherever the algebra lands -- which, for a shouldered
     rifle, is regularly inside the ribs or up above the shoulder. Both read
     instantly as broken.

     So the pole is not a constant: it is the free parameter of the solve, and
     it is descended against a penalty with two terms -- how far the elbow is
     INSIDE the torso capsule, and how far it is ABOVE the shoulder. Two
     probe evaluations give the descent direction (which removes any need to
     reason about the sign convention of the pole axis), then one step. Three
     extra calls to a trig-only solver, on LOD0 only.
     ---------------------------------------------------------------------- */
  function elbowPenalty(c, ix, sp, N, clav, up) {
    up.updateMatrix();
    _wp.elb.set(0, -sp.upperArm, 0).applyMatrix4(up.matrix).applyMatrix4(clav.matrix);
    /* torso capsule, generous enough to include the plate carrier */
    /* the hull the elbow must clear is the TORSO PLUS THE KIT: the plate
       carrier stands proud of the ribs by ~30 mm front and back and the
       cummerbund wraps wider than the chest */
    /* The pelvis is 348 mm across now rather than 264, so the hull the elbow
       has to clear grew with it. It also needed a MARGIN: a purely quadratic
       t*t penalty has zero gradient at the surface, so the descent parks the
       elbow exactly on the boundary and any noise puts it a few millimetres
       inside -- which is precisely the one grazing frame in a thousand the
       harness kept reporting. The linear term gives the descent something to
       push against out to 8% clear of the hull. */
    var rx = sp.chestW * 1.56, rz = sp.chestD * 1.92;
    var q = (_wp.elb.x * _wp.elb.x) / (rx * rx) + (_wp.elb.z * _wp.elb.z) / (rz * rz);
    var pen = 0;
    if (q < 1.17) { var t = 1.08 - Math.sqrt(q); pen += t * t * 26 + t * 3.2; }
    /* the elbow of a shouldered rifle sits BELOW the shoulder line. Chicken-
       winging above it is the other loud tell, and it is what a naive pole
       does on the support side. */
    var over = _wp.elb.y - (sp.shoulderY - 0.012 * sp.H);
    if (over > 0) pen += over * over * 42;
    /* and it should hang, not splay: a mild preference for down-and-in */
    pen += Math.max(0, _wp.elb.y - sp.shoulderY + sp.upperArm * 0.30) * 0.6;
    return pen;
  }
  /* Closed-form pole. `pole` in solveTwoBone rolls the bend plane about the
     shoulder->hand axis: at pole = p the elbow is displaced along
     cos(p)*u0 + sin(p)*u1, where u0 and u1 are the images of +Z and +X under
     the same DOWN->axis rotation the solver builds. So given a DESIRED elbow
     direction, the pole that gets closest to it is just an atan2 -- no search,
     no local minima, and no dependence on which way round the sign convention
     happens to run. This is what an animator means by a pole vector. */
  function poleFor(A, tx, ty, tz, hint) {
    var ax = tx - A.position.x, ay = ty - A.position.y, az = tz - A.position.z;
    var L = Math.sqrt(ax * ax + ay * ay + az * az);
    if (L < 1e-6) return 0;
    ax /= L; ay /= L; az /= L;
    _wp.q2.setFromUnitVectors(DOWN, _wp.upv.set(ax, ay, az));
    /* desired elbow offset, with the component along the axis removed */
    var dot = hint.x * ax + hint.y * ay + hint.z * az;
    _wp.rgt.set(hint.x - ax * dot, hint.y - ay * dot, hint.z - az * dot);
    if (_wp.rgt.lengthSq() < 1e-8) return 0;
    _wp.rgt.normalize();
    _wp.fwd.set(0, 0, 1).applyQuaternion(_wp.q2);       /* u0 */
    _wp.elb.set(1, 0, 0).applyQuaternion(_wp.q2);       /* u1 */
    return Math.atan2(_wp.rgt.dot(_wp.elb), _wp.rgt.dot(_wp.fwd));
  }
  var _hintR = null, _hintL = null, _cTmp = null;
  function poseArm(c, ix, sp, N, gripChest, pole, aim, hi, contactChest) {
    var clav = c.bones[ix['clav' + N]], up = c.bones[ix['arm' + N]];
    var fore = c.bones[ix['fore' + N]], hand = c.bones[ix['hand' + N]];
    var fing = c.bones[ix['fing' + N]];
    clav.updateMatrix();
    /* The wrist rotation has to be known BEFORE the chain is solved, because
       the correction below measures where the GRIPPING PART of the hand
       actually ended up, and that depends on it. */
    if (N === 'R') hand.rotation.set(-0.30 - aim * 0.16, -0.10, -0.24 - aim * 0.10);
    else hand.rotation.set(-0.62 - aim * 0.20, 0.30 + aim * 0.10, 0.26);
    hand.updateMatrix();
    _wp.m2.copy(clav.matrix).invert();
    _wp.gt.copy(gripChest).applyMatrix4(_wp.m2);
    var tx = _wp.gt.x, ty = _wp.gt.y, tz = _wp.gt.z;
    /* WHERE THE ELBOW WANTS TO BE, in chest space. Both hang DOWN -- that is
       the whole difference between a shooter and a man holding a tray. The
       trigger elbow swings out and back (it has to clear the stock), the
       support elbow tucks under the handguard, which is what a C-clamp looks
       like from the front. `pole` from the caller then only supplies the
       transient jog: heel strike, recoil, wind-up. */
    if (!_hintR) { _hintR = new THREE.Vector3(); _hintL = new THREE.Vector3(); }
    var hint = N === 'R' ? _hintR : _hintL;
    if (N === 'R') hint.set(0.72 + pole * 0.55, -1, -0.30);
    else hint.set(-0.62 + pole * 0.42, -1, -0.02);
    hint.normalize().transformDirection(_wp.m2);
    var pk = poleFor(up, tx, ty, tz, hint);
    solveTwoBone(up, fore, tx, ty, tz, pk, sp.upperArm, sp.foreArm);
    function fixElbow() {
      var p0 = elbowPenalty(c, ix, sp, N, clav, up);
      if (p0 <= 1e-4) return;
      var sgp = N === 'R' ? 1 : -1;
      for (var it = 0; it < 4 && p0 > 1e-4; it++) {
        solveTwoBone(up, fore, tx, ty, tz, pk + sgp * 0.22, sp.upperArm, sp.foreArm);
        var p1 = elbowPenalty(c, ix, sp, N, clav, up);
        if (p1 >= p0) {
          if (it === 0) { sgp = -sgp; continue; }
          solveTwoBone(up, fore, tx, ty, tz, pk, sp.upperArm, sp.foreArm);
          return;
        }
        pk += sgp * 0.22; p0 = p1;
      }
    }
    if (hi) fixElbow();
    /* ---- SOLVE FOR THE CONTACT, NOT FOR THE WRIST -------------------
       An IK chain that ends at the wrist puts the WRIST where it was asked
       and lets the palm land wherever the hand's own rotation happens to
       take it -- which for a pistol grip is 100 mm away, and that is exactly
       what "his hand is near the gun but not on it" looks like. So: solve,
       measure where the gripping part of the hand actually is, shift the
       wrist target by the miss, solve again. Two iterations converge to well
       under a millimetre because the chain is nearly rigid over that
       displacement. */
    if (contactChest) {
      if (!_cTmp) _cTmp = new THREE.Vector3();
      _cTmp.copy(contactChest).applyMatrix4(_wp.m2);      /* clavicle space */
      for (var ci = 0; ci < (hi ? 3 : 1); ci++) {
        up.updateMatrix(); fore.updateMatrix();
        _wp.elb.copy(fing.position)
          .applyMatrix4(hand.matrix).applyMatrix4(fore.matrix).applyMatrix4(up.matrix);
        tx += _cTmp.x - _wp.elb.x;
        ty += _cTmp.y - _wp.elb.y;
        tz += _cTmp.z - _wp.elb.z;
        solveTwoBone(up, fore, tx, ty, tz, pk, sp.upperArm, sp.foreArm);
        /* re-clear the ribs after every target shift: moving the wrist moves
           the elbow, and a hand that is perfectly on the grip with an elbow
           inside the plate carrier is not an improvement */
        if (hi) fixElbow();
      }
    }
  }

  /* =========================================================================
     12. RAGDOLL
     A verlet particle solver with distance ranges, real hinge limits (so an
     elbow or a knee can never invert), approximate self-collision, and
     energy-adaptive damping. Instability here is the single most damaging
     defect a character can have -- a corpse that vibrates destroys the
     realism of everything around it -- so the solver is deliberately
     over-damped and the settle test is aggressive.
     ====================================================================== */
  var RAGSPEC = {};
  function ragdollSpecBiped() {
    /* particle name -> bone it is anchored to (head end of the segment) */
    return [
      ['pelvis', 'hips', 0], ['chest', 'chest', 0], ['neck', 'neck', 0], ['head', 'head', 1],
      ['shL', 'armL', 0], ['elL', 'foreL', 0], ['haL', 'handL', 1],
      ['shR', 'armR', 0], ['elR', 'foreR', 0], ['haR', 'handR', 1],
      ['hiL', 'thighL', 0], ['knL', 'shinL', 0], ['ftL', 'footL', 1],
      ['hiR', 'thighR', 0], ['knR', 'shinR', 0], ['ftR', 'footR', 1]
    ];
  }
  function ragSpec(kind) {
    if (RAGSPEC[kind]) return RAGSPEC[kind];
    return RAGSPEC[kind] = ragdollSpecBiped();
  }

  /* world position of a ragdoll anchor for the CURRENT bone pose */
  function anchorWorld(c, s, unit, out) {
    var bone = c.bones[c.idx[s[1]]];
    var HH = (SPEC[c.kind] && SPEC[c.kind].H) || 6.2;
    out.set(0, 0, 0);
    if (s[2]) {
      var ext = (s[1] === 'head' ? 0.070 : 0.045) * HH;
      out.set(0, s[1] === 'head' ? ext : -ext, 0);
    }
    bone.localToWorld(out);
    return out;
  }

  /* Sample the animated anchor positions every frame once an enemy is hurt,
     so the ragdoll can start with the velocity the animation actually had. */
  function sampleRagPoints(e, rig, c, now) {
    var st = e._nz, spec = ragSpec(e.kind), n = spec.length, i;
    if (!st.prevPts || st.prevPts.length !== n * 3) { st.prevPts = new Float32Array(n * 3); st.prevValid = false; }
    rig.root.updateMatrixWorld(true);
    for (i = 0; i < n; i++) {
      anchorWorld(c, spec[i], rig.unit, _wp.a);
      st.prevPts[i * 3] = _wp.a.x; st.prevPts[i * 3 + 1] = _wp.a.y; st.prevPts[i * 3 + 2] = _wp.a.z;
    }
    st.prevT = now;
    st.prevValid = true;
  }

  function buildRagdoll(e, rig, now) {
    var st = e._nz, c = st.char;
    var spec = ragSpec(e.kind);
    var n = spec.length, i, j;
    var R = {
      n: n, x: new Float32Array(n * 3), px: new Float32Array(n * 3),
      inv: new Float32Array(n), rad: new Float32Array(n), gr: new Float32Array(n),
      names: [], nameIdx: {}, cons: [], hinges: [], pairs: [],
      sleep: 0, dead: false, calm: 0, drag: 1.15,
      boneOf: [], unit: rig.unit, floor: e.y, ox: e.x, oy: e.y, oz: e.z, t: 0,
      fr: new Float32Array(9),
      /* settle window + the published corpse frame (see corpseFrame) */
      sx: new Float32Array(n * 3), chk: 0, still: 0,
      cx: e.x, cy: e.y, cz: e.z, gy: e.y, yaw: e.face || 0
    };
    rig.root.updateMatrixWorld(true);
    /* velocity inherited from the animation, per particle */
    var vdt = (st.prevValid && now > st.prevT) ? (now - st.prevT) : 0;
    if (vdt < 1 / 240 || vdt > 0.2) vdt = 0;
    for (i = 0; i < n; i++) {
      var s = spec[i];
      anchorWorld(c, s, rig.unit, _wp.a);
      var o = i * 3;
      R.x[o] = _wp.a.x; R.x[o + 1] = _wp.a.y; R.x[o + 2] = _wp.a.z;
      if (vdt > 0) {
        /* px = x - v*dt0 with dt0 == the solver's own first step */
        var vx = clamp((_wp.a.x - st.prevPts[o]) / vdt, -26, 26);
        var vy = clamp((_wp.a.y - st.prevPts[o + 1]) / vdt, -26, 26);
        var vz = clamp((_wp.a.z - st.prevPts[o + 2]) / vdt, -26, 26);
        R.px[o] = R.x[o] - vx / 120; R.px[o + 1] = R.x[o + 1] - vy / 120; R.px[o + 2] = R.x[o + 2] - vz / 120;
      } else {
        R.px[o] = R.x[o]; R.px[o + 1] = R.x[o + 1]; R.px[o + 2] = R.x[o + 2];
      }
      R.inv[i] = 1;
      R.rad[i] = (s[0] === 'head' ? 0.29 : s[0] === 'pelvis' || s[0] === 'chest' ? 0.34 :
        s[0] === 'neck' ? 0.20 : 0.155) * rig.unit;
      /* GROUND CLEARANCE IS NOT THE COLLISION RADIUS. The collision radius
         keeps two limbs apart. The ground clearance has to hold the SKIN off
         the floor, and the skin around a trunk anchor reaches a quarter of a
         metre behind the spine once a pack and a plate carrier are on it.
         Measured on a settled trooper before this existed: 48% of the body's
         vertices below the ground plane, lowest at -0.59 m. */
      R.gr[i] = (s[0] === 'pelvis' || s[0] === 'chest' ? 0.46 :
        s[0] === 'head' ? 0.36 : s[0] === 'neck' ? 0.26 :
          (s[0] === 'haL' || s[0] === 'haR') ? 0.17 :
            (s[0] === 'ftL' || s[0] === 'ftR') ? 0.20 : 0.22) * rig.unit;
      R.names.push(s[0]); R.nameIdx[s[0]] = i;
      R.boneOf.push(c.idx[s[1]]);
    }
    /* mass: heavier torso resists limb flail */
    function setInv(name, v) { var k = R.nameIdx[name]; if (k !== undefined) R.inv[k] = v; }
    setInv('pelvis', 0.50); setInv('chest', 0.55); setInv('neck', 0.8); setInv('head', 0.82);

    var adj = {};
    function link(a, b, stiff, minS, maxS) {
      var ia = R.nameIdx[a], ib = R.nameIdx[b];
      if (ia === undefined || ib === undefined) return;
      var dx = R.x[ia * 3] - R.x[ib * 3], dy = R.x[ia * 3 + 1] - R.x[ib * 3 + 1], dz = R.x[ia * 3 + 2] - R.x[ib * 3 + 2];
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-5) d = 1e-5;
      R.cons.push([ia, ib, d * (minS === undefined ? 1 : minS), d * (maxS === undefined ? 1 : maxS), stiff === undefined ? 1 : stiff]);
      adj[ia + ':' + ib] = 1; adj[ib + ':' + ia] = 1;
    }
    {
      link('pelvis', 'chest'); link('chest', 'neck'); link('neck', 'head');
      link('chest', 'shL'); link('chest', 'shR');
      link('shL', 'elL'); link('elL', 'haL'); link('shR', 'elR'); link('elR', 'haR');
      link('pelvis', 'hiL'); link('pelvis', 'hiR');
      link('hiL', 'knL'); link('knL', 'ftL'); link('hiR', 'knR'); link('knR', 'ftR');
      /* shape braces keep the torso rigid */
      link('shL', 'shR', .95); link('hiL', 'hiR', .95);
      link('shL', 'hiR', .65); link('shR', 'hiL', .65);
      link('neck', 'shL', .85); link('neck', 'shR', .85);
      link('pelvis', 'shL', .75); link('pelvis', 'shR', .75);
      link('chest', 'hiL', .75); link('chest', 'hiR', .75);
      link('head', 'chest', .60, .86, 1.06);
      /* JOINT RANGES. The upper bounds were 1.22 and 1.25 -- a quarter of the
         bone's length of stretch, which is how a settled corpse ended up with
         daylight between its torso segments and a thigh pointing at the sky.
         A human limb does not get longer; the only slack a real joint has is
         a few millimetres of cartilage, so the ceilings come down to 1.05 and
         the floors (full fold) stay where they are. */
      link('shL', 'haL', .5, .36, .980); link('shR', 'haR', .5, .36, .980);
      link('hiL', 'ftL', .6, .42, .980); link('hiR', 'ftR', .6, .42, .980);
      link('pelvis', 'knL', .50, .58, 1.05); link('pelvis', 'knR', .50, .58, 1.05);
      link('chest', 'elL', .42, .55, 1.06); link('chest', 'elR', .42, .55, 1.06);
      /* and the trunk itself is a rib cage, not a spring: hold the pelvis to
         the chest and the chest to the neck within 3% */
      link('pelvis', 'neck', .80, .95, 1.03);
    }

    for (i = 0; i < n * 3; i++) R.sx[i] = R.x[i];
    corpseFrame(R);

    /* --- hinge limits ---------------------------------------------------- */
    ragFrame(R);
    addHinge(R, 'hiL', 'knL', 'ftL', 1);   /* knee bends forward */
    addHinge(R, 'hiR', 'knR', 'ftR', 1);
    addHinge(R, 'shL', 'elL', 'haL', -1);  /* elbow bends backward */
    addHinge(R, 'shR', 'elR', 'haR', -1);

    /* --- self-collision pairs (non-adjacent only) ------------------------ */
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      if (adj[i + ':' + j]) continue;
      var mind = (R.rad[i] + R.rad[j]) * 0.86;
      if (mind <= 0) continue;
      R.pairs.push(i, j, mind);
    }
    return R;
  }

  /* orthonormal pelvis frame: right = hipR-hipL, up = chest-pelvis */
  function ragFrame(R) {
    var f = R.fr;
    var ip = R.nameIdx['pelvis'], ic = R.nameIdx['chest'];
    var il = R.nameIdx['hiL'], ir = R.nameIdx['hiR'];
    var rx, ry, rz, ux, uy, uz;
    if (il !== undefined && ir !== undefined) {
      rx = R.x[ir * 3] - R.x[il * 3]; ry = R.x[ir * 3 + 1] - R.x[il * 3 + 1]; rz = R.x[ir * 3 + 2] - R.x[il * 3 + 2];
    } else { rx = 1; ry = 0; rz = 0; }
    ux = R.x[ic * 3] - R.x[ip * 3]; uy = R.x[ic * 3 + 1] - R.x[ip * 3 + 1]; uz = R.x[ic * 3 + 2] - R.x[ip * 3 + 2];
    var rl = Math.sqrt(rx * rx + ry * ry + rz * rz); if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    var ul = Math.sqrt(ux * ux + uy * uy + uz * uz); if (ul < 1e-6) { ux = 0; uy = 1; uz = 0; ul = 1; }
    ux /= ul; uy /= ul; uz /= ul;
    var fx = ry * uz - rz * uy, fy = rz * ux - rx * uz, fz = rx * uy - ry * ux;
    var fl = Math.sqrt(fx * fx + fy * fy + fz * fz); if (fl < 1e-6) { fx = 0; fy = 0; fz = 1; fl = 1; }
    fx /= fl; fy /= fl; fz /= fl;
    /* re-orthogonalise right */
    rx = uy * fz - uz * fy; ry = uz * fx - ux * fz; rz = ux * fy - uy * fx;
    f[0] = rx; f[1] = ry; f[2] = rz;
    f[3] = ux; f[4] = uy; f[5] = uz;
    f[6] = fx; f[7] = fy; f[8] = fz;
  }

  /* Store the allowed bend direction of a 3-particle chain in pelvis-local
     coordinates, measured from the pose the character actually died in. */
  function addHinge(R, a, b, cN, fallbackSign) {
    var ia = R.nameIdx[a], ib = R.nameIdx[b], ic = R.nameIdx[cN];
    if (ia === undefined || ib === undefined || ic === undefined) return;
    var oa = ia * 3, ob = ib * 3, oc = ic * 3;
    var mx = (R.x[oa] + R.x[oc]) * .5, my = (R.x[oa + 1] + R.x[oc + 1]) * .5, mz = (R.x[oa + 2] + R.x[oc + 2]) * .5;
    var ux = R.x[oc] - R.x[oa], uy = R.x[oc + 1] - R.x[oa + 1], uz = R.x[oc + 2] - R.x[oa + 2];
    var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    var rx = R.x[ob] - mx, ry = R.x[ob + 1] - my, rz = R.x[ob + 2] - mz;
    var dp = rx * ux + ry * uy + rz * uz;
    rx -= ux * dp; ry -= uy * dp; rz -= uz * dp;
    var rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
    var f = R.fr;
    if (rl < 1e-4) { rx = f[6] * fallbackSign; ry = f[7] * fallbackSign; rz = f[8] * fallbackSign; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    R.hinges.push([ia, ib, ic,
      rx * f[0] + ry * f[1] + rz * f[2],
      rx * f[3] + ry * f[4] + rz * f[5],
      rx * f[6] + ry * f[7] + rz * f[8]]);
  }

  var GRAVITY = 62;
  var RAG_ITERS = 8;
  /* ---------------------------------------------------------------------
     WHERE THE CORPSE ACTUALLY IS.

     The body travels while it falls -- typically 0.4-0.7 m from the point
     the AI last had it -- so `e.x/e.z` at death, `R.ox/R.oz` and the settled
     body are three different places. Everything that has to agree across an
     LOD boundary (the instanced far pose, the rig root, the blob shadow)
     reads THIS, measured on the sixteen solver anchors, and never the
     logical entity position.
     ------------------------------------------------------------------ */
  function corpseFrame(R) {
    var i, sx = 0, sy = 0, sz = 0;
    for (i = 0; i < R.n; i++) { sx += R.x[i * 3]; sy += R.x[i * 3 + 1]; sz += R.x[i * 3 + 2]; }
    R.cx = sx / R.n; R.cy = sy / R.n; R.cz = sz / R.n;
    var ip = R.nameIdx['pelvis'] * 3, ih = R.nameIdx['head'] * 3;
    var dx = R.x[ih] - R.x[ip], dz = R.x[ih + 2] - R.x[ip + 2];
    if (dx * dx + dz * dz > 1e-6) R.yaw = Math.atan2(dx, dz);
    /* lowest anchor tells us the plane the body is really resting on, which
       is what the far LOD has to be dropped onto */
    if (!R.lifted) {
      var lo = Infinity;
      for (i = 0; i < R.n; i++) { var y = R.x[i * 3 + 1] - R.gr[i]; if (y < lo) lo = y; }
      R.gy = isFinite(lo) ? lo : R.floor;
    }
  }

  function stepRagdoll(R, dt, e) {
    if (R.dead) return;
    R.t += dt;
    /* ADAPTIVE SOLVER BUDGET. A corpse that has stopped moving still owes the
       scene a correct pose, not a correct simulation: once `calm` saturates
       the constraint set is already satisfied and the extra passes only
       re-derive an answer that has not changed. Measured cost of a falling
       body was 2.1x a live enemy; this is where that goes back. */
    var calmB = R.calm;
    var iters = calmB > 0.86 ? 3 : calmB > 0.55 ? 5 : RAG_ITERS;
    var collIt = calmB > 0.86 ? 1 : 4;
    var sub = calmB > 0.86 ? 1 : Math.min(5, Math.max(1, Math.ceil(dt / (1 / 120))));
    var h = dt / sub;
    var i, k, it, o;
    var f = R.fr;
    for (var s = 0; s < sub; s++) {
      /* verlet, with damping that rises as the body loses energy */
      var lin = Math.exp(-R.drag * h);
      for (i = 0; i < R.n; i++) {
        o = i * 3;
        var vx = (R.x[o] - R.px[o]) * lin;
        var vy = (R.x[o + 1] - R.px[o + 1]) * lin;
        var vz = (R.x[o + 2] - R.px[o + 2]) * lin;
        R.px[o] = R.x[o]; R.px[o + 1] = R.x[o + 1]; R.px[o + 2] = R.x[o + 2];
        R.x[o] += vx; R.x[o + 1] += vy - GRAVITY * h * h; R.x[o + 2] += vz;
      }
      ragFrame(R);
      for (it = 0; it < iters; it++) {
        /* ---- distance ranges ---- */
        for (k = 0; k < R.cons.length; k++) {
          var cn = R.cons[k];
          var ia = cn[0] * 3, ib = cn[1] * 3;
          var dx = R.x[ib] - R.x[ia], dy = R.x[ib + 1] - R.x[ia + 1], dz = R.x[ib + 2] - R.x[ia + 2];
          var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-6) continue;
          var target = d < cn[2] ? cn[2] : d > cn[3] ? cn[3] : d;
          if (target === d) continue;
          var diff = (d - target) / d * cn[4] * 0.5;
          var wa = R.inv[cn[0]], wb = R.inv[cn[1]], ws = wa + wb;
          if (ws <= 0) continue;
          var fa = (wa / ws) * 2 * diff, fb = (wb / ws) * 2 * diff;
          R.x[ia] += dx * fa; R.x[ia + 1] += dy * fa; R.x[ia + 2] += dz * fa;
          R.x[ib] -= dx * fb; R.x[ib + 1] -= dy * fb; R.x[ib + 2] -= dz * fb;
        }
        /* ---- hinge limits: keep the joint on the allowed side ---- */
        for (k = 0; k < R.hinges.length; k++) {
          var hg = R.hinges[k];
          var pa = hg[0] * 3, pb = hg[1] * 3, pc = hg[2] * 3;
          var ax = hg[3] * f[0] + hg[4] * f[3] + hg[5] * f[6];
          var ay = hg[3] * f[1] + hg[4] * f[4] + hg[5] * f[7];
          var az = hg[3] * f[2] + hg[4] * f[5] + hg[5] * f[8];
          var lx = R.x[pc] - R.x[pa], ly = R.x[pc + 1] - R.x[pa + 1], lz = R.x[pc + 2] - R.x[pa + 2];
          var ll = Math.sqrt(lx * lx + ly * ly + lz * lz); if (ll < 1e-6) continue;
          lx /= ll; ly /= ll; lz /= ll;
          var adot = ax * lx + ay * ly + az * lz;
          ax -= lx * adot; ay -= ly * adot; az -= lz * adot;
          var al = Math.sqrt(ax * ax + ay * ay + az * az); if (al < 1e-5) continue;
          ax /= al; ay /= al; az /= al;
          var mx2 = (R.x[pa] + R.x[pc]) * .5, my2 = (R.x[pa + 1] + R.x[pc + 1]) * .5, mz2 = (R.x[pa + 2] + R.x[pc + 2]) * .5;
          var bx = R.x[pb] - mx2, by = R.x[pb + 1] - my2, bz = R.x[pb + 2] - mz2;
          var proj = bx * ax + by * ay + bz * az;
          if (proj >= 0) continue;
          var corr = -proj * 0.65;
          R.x[pb] += ax * corr; R.x[pb + 1] += ay * corr; R.x[pb + 2] += az * corr;
          R.x[pa] -= ax * corr * 0.12; R.x[pa + 1] -= ay * corr * 0.12; R.x[pa + 2] -= az * corr * 0.12;
          R.x[pc] -= ax * corr * 0.12; R.x[pc + 1] -= ay * corr * 0.12; R.x[pc + 2] -= az * corr * 0.12;
        }
        /* ---- self collision (approximate, sphere/sphere) ---- */
        if (it < collIt) {
          for (k = 0; k < R.pairs.length; k += 3) {
            var qa = R.pairs[k] * 3, qb = R.pairs[k + 1] * 3, mind = R.pairs[k + 2];
            var sx = R.x[qb] - R.x[qa], sy = R.x[qb + 1] - R.x[qa + 1], sz = R.x[qb + 2] - R.x[qa + 2];
            var sd2 = sx * sx + sy * sy + sz * sz;
            if (sd2 >= mind * mind || sd2 < 1e-9) continue;
            var sd = Math.sqrt(sd2);
            var push = (mind - sd) / sd * 0.5 * 0.6;
            R.x[qa] -= sx * push; R.x[qa + 1] -= sy * push; R.x[qa + 2] -= sz * push;
            R.x[qb] += sx * push; R.x[qb + 1] += sy * push; R.x[qb + 2] += sz * push;
          }
        }
        /* ---- ground: position clamp only inside the loop ---- */
        for (i = 0; i < R.n; i++) {
          o = i * 3;
          var minY = R.floor + R.gr[i];
          if (R.x[o + 1] < minY) R.x[o + 1] = minY;
        }
      }
      /* friction applied ONCE per substep, not once per iteration: applying
         it inside the solve loop is what makes a verlet corpse buzz */
      for (i = 0; i < R.n; i++) {
        o = i * 3;
        var gY = R.floor + R.gr[i];
        if (R.x[o + 1] <= gY + 1e-4) {
          /* Coulomb-ish: a body sliding across concrete keeps some momentum,
             a body that has finished falling does not slide at all. Ramping
             the friction with `calm` is what stops a settled corpse creeping
             for the rest of its life. */
          var fk = 0.55 + R.calm * 0.42;
          R.px[o] += (R.x[o] - R.px[o]) * fk;
          R.px[o + 2] += (R.x[o + 2] - R.px[o + 2]) * fk;
          if (R.px[o + 1] < gY) R.px[o + 1] = gY;
        }
      }
    }

    /* keep the corpse inside the room using the game's own collider */
    if (G.moveSlide) {
      var pi = R.nameIdx['pelvis'] * 3;
      var np = G.moveSlide(R.ox, R.oz, R.x[pi] - R.ox, R.x[pi + 2] - R.oz, e.cfg.rad * 0.55, R.floor);
      var cx = np[0] - R.x[pi], cz = np[1] - R.x[pi + 2];
      if (cx * cx + cz * cz > 1e-6) {
        for (i = 0; i < R.n; i++) { R.x[i * 3] += cx; R.x[i * 3 + 2] += cz; }
      }
    }

    corpseFrame(R);

    /* --- settle: measure real velocity, raise damping, then latch ------- */
    var vsum = 0, vmax2 = 0, hh = Math.max(h, 1e-5);
    for (i = 0; i < R.n; i++) {
      o = i * 3;
      var ex = (R.x[o] - R.px[o]) / hh, ey = (R.x[o + 1] - R.px[o + 1]) / hh, ez = (R.x[o + 2] - R.px[o + 2]) / hh;
      var e2 = ex * ex + ey * ey + ez * ez;
      vsum += e2; if (e2 > vmax2) vmax2 = e2;
    }
    /* thresholds scale with the actor: a pig is 16% larger so its residual
       velocities are proportionally larger and a fixed cut-off leaves it
       twitching for seconds */
    var vrms = Math.sqrt(vsum / R.n), u = R.unit;
    R.calm = damp(R.calm, vrms < 1.8 * u ? 1 : 0, 0.0012, dt);
    /* The latch has to fire on a body that has ACTUALLY stopped, not on one
       that is still drifting at 0.13 m/s -- freezing at that speed is a
       visible snap. Measured residual at the latch instant was 0.26-0.45 u/s
       before these numbers; the harder drag ramp and the tighter threshold
       take it to a stop first and latch afterwards. */
    R.drag = 1.15 + R.calm * 17.0;
    /* RMS alone lets a single limb still be swinging while the body average
       looks calm -- and the one thing a viewer notices about a corpse is the
       one part still moving. The latch needs BOTH. */
    var vmax = Math.sqrt(vmax2);
    if (vrms < 0.20 * u && vmax < 0.34 * u && R.t > 0.5) {
      R.sleep += dt; if (R.sleep > 0.30) R.dead = true;
    }
    else R.sleep = 0;

    /* THE VERLET VELOCITY IS NOT THE BODY'S VELOCITY.
       (x - px)/h also contains the position correction the constraint solver
       applied this substep, and against a hard ground clamp that correction
       never reaches zero: a settled trooper sat at vmax 0.37-0.42 u/s for
       ever, so the latch above NEVER fired and every corpse ran the full
       solver until the 9-second guillotine. Measured: trooper and enforcer
       latched at 8.97 s, pig at 4.52 s.

       Net displacement over a window has no such term. If nothing has
       actually MOVED more than a couple of millimetres in a third of a
       second, the body is at rest whatever the integrator says. */
    R.chk += dt;
    if (R.chk >= 0.12) {
      var mv = 0;
      for (i = 0; i < R.n; i++) {
        o = i * 3;
        var qx = R.x[o] - R.sx[o], qy = R.x[o + 1] - R.sx[o + 1], qz = R.x[o + 2] - R.sx[o + 2];
        var q2 = qx * qx + qy * qy + qz * qz;
        if (q2 > mv) mv = q2;
        R.sx[o] = R.x[o]; R.sx[o + 1] = R.x[o + 1]; R.sx[o + 2] = R.x[o + 2];
      }
      /* 12 mm/s: below a human's ability to see motion on a prone body at
         any range this LOD system ever shows one at */
      R.still = (Math.sqrt(mv) / R.chk < 0.042 * u) ? R.still + R.chk : 0;
      R.chk = 0;
      if (R.still > 0.30 && R.t > 0.6) R.dead = true;
    }
    if (R.t > 9) R.dead = true;
    /* a NaN anywhere would poison every bone: bail to the settled pose */
    if (!isFinite(R.x[0]) || !isFinite(R.x[1]) || !isFinite(R.x[2])) R.dead = true;
  }

  function ragdollImpulse(R, name, ix, iy, iz) {
    var i = R.nameIdx[name]; if (i === undefined) return;
    var o = i * 3;
    R.px[o] -= ix; R.px[o + 1] -= iy; R.px[o + 2] -= iz;
  }

  /* map particles back onto the bone hierarchy */
  var _qw = null;
  function applyRagdollToBones(R, c, rig, kind) {
    if (!_qw) { _qw = []; for (var z = 0; z < 44; z++) _qw.push(new THREE.Quaternion()); }
    var idx = c.idx, B = c.bones;
    var unit = rig.unit;
    var invU = 1 / unit;
    function P(name, out) {
      var i = R.nameIdx[name] * 3;
      out.set((R.x[i] - R.ox) * invU, (R.x[i + 1] - R.oy) * invU, (R.x[i + 2] - R.oz) * invU);
      return out;
    }
    rig.root.position.set(R.ox, R.oy, R.oz);
    rig.root.rotation.set(0, 0, 0);
    rig.root.scale.set(unit, unit, unit);

    var a = _wp.a, b = _wp.b, cV = _wp.c, d = _wp.d;
    var tmpQ = _lv.q2, m = _lv.m;
    var qc = 0;
    function chainAim(bone, parentQ, fromV, toV, axisDown) {
      d.copy(toV).sub(fromV);
      var out = _qw[qc++];
      if (d.lengthSq() < 1e-8) { bone.quaternion.identity(); out.copy(parentQ); return out; }
      d.normalize();
      tmpQ.copy(parentQ).invert();
      d.applyQuaternion(tmpQ);
      bone.quaternion.setFromUnitVectors(axisDown ? DOWN : AXIS_Y, d);
      out.copy(parentQ).multiply(bone.quaternion);
      return out;
    }

    /* A corpse does not hold a cheek weld. The neck and head translations
       the mount solver applies every live frame have to be released, or the
       body settles with its head still craned onto a rifle it dropped. */
    var spq = SPEC[kind];
    if (spq) {
      B[idx.neck].position.set(0, spq.neck, -0.010 * spq.H);
      B[idx.head].position.set(0, spq.headUp, 0.012 * spq.H);
    }

    /* --- biped --- */
    P('pelvis', a); P('chest', b); P('hiL', cV); P('hiR', d);
    var right = _lv.v.copy(d).sub(cV);
    var up = _lv.v2.copy(b).sub(a);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    if (up.lengthSq() < 1e-8) up.set(0, 1, 0);
    right.normalize(); up.normalize();
    var fwd = _lv.v3.crossVectors(right, up);
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, 1);
    fwd.normalize();
    right.crossVectors(up, fwd).normalize();
    m.makeBasis(right, up, fwd);
    var hipsB = B[idx.hips];
    hipsB.position.copy(a);
    hipsB.quaternion.setFromRotationMatrix(m);
    var qHips = _qw[qc++].copy(hipsB.quaternion);

    /* spine chain: pelvis -> chest carried by `spine`, spine2 stays neutral so
       the extra joint does not double the bend */
    P('pelvis', a); P('chest', b); P('neck', cV); P('head', d);
    var qSpine = chainAim(B[idx.spine], qHips, a, b, false);
    B[idx.spine2].quaternion.identity();
    var qChest2 = chainAim(B[idx.chest], qSpine, b, cV, false);
    chainAim(B[idx.neck], qChest2, cV, d, false);
    B[idx.head].quaternion.identity();

    for (var sI = 0; sI < 2; sI++) {
      var N = sI ? 'R' : 'L';
      var sh = sI ? 'shR' : 'shL', el = sI ? 'elR' : 'elL', ha = sI ? 'haR' : 'haL';
      P('chest', a); P(sh, b);
      var qClav = chainAim(B[idx['clav' + N]], qChest2, a, b, false);
      P(sh, a); P(el, b); P(ha, cV);
      var qUp = chainAim(B[idx['arm' + N]], qClav, a, b, true);
      chainAim(B[idx['fore' + N]], qUp, b, cV, true);
      B[idx['hand' + N]].quaternion.identity();
      B[idx['fing' + N]].rotation.set(0.42, 0, 0);
    }
    for (sI = 0; sI < 2; sI++) {
      var N2 = sI ? 'R' : 'L';
      var hi = sI ? 'hiR' : 'hiL', kn = sI ? 'knR' : 'knL', ft = sI ? 'ftR' : 'ftL';
      P(hi, a); P(kn, b); P(ft, cV);
      var qTh = chainAim(B[idx['thigh' + N2]], qHips, a, b, true);
      chainAim(B[idx['shin' + N2]], qTh, b, cV, true);
      B[idx['foot' + N2]].rotation.set(0.22, 0, 0);
      B[idx['toe' + N2]].rotation.set(0, 0, 0);
    }

    /* ---------------------------------------------------------------------
       PUT THE RIFLE DOWN.

       The weapon bone hangs off `chest` and nothing here ever touched it, so
       a corpse kept the live shoulder mount: as the chest rolled supine the
       880 mm rifle rotated with it and drove straight into the floor.
       Measured on a settled trooper: 3169 of the weapon's 3238 vertices below
       the ground plane, lowest at -2.07 units (-0.59 m). It is the single
       largest thing wrong with a corpse and it is invisible in a wide shot,
       which is why five rounds of review never caught it.

       A dropped weapon lies FLAT: bore horizontal, sights up, resting on its
       magazine beside the body. Solve that in world space and convert into
       the chest's frame, which we already have exactly as `qChest2` plus the
       three bind offsets that carry hips -> spine -> spine2 -> chest.
       ------------------------------------------------------------------ */
    if (idx.weapon !== undefined && spq && spq.grip && R) {
      var chP = a, tmpV = b, lat = cV, fwd = d;
      /* chest bone position, root-local: hips -> spine -> spine2 -> chest,
         each bind offset carried by the world quaternion of its parent
         (spine2 is left neutral above, so it re-uses qSpine) */
      P('pelvis', chP);
      tmpV.set(0, spq.spine, 0.004 * spq.H).applyQuaternion(qHips); chP.add(tmpV);
      tmpV.set(0, spq.spine2, 0.002 * spq.H).applyQuaternion(qSpine); chP.add(tmpV);
      tmpV.set(0, spq.chest, -0.004 * spq.H).applyQuaternion(qSpine); chP.add(tmpV);
      /* bore along the body's own axis, sights up, laid out to one side */
      var by = R.yaw || 0, cby = Math.cos(by), sby = Math.sin(by);
      fwd.set(sby, 0, cby);
      lat.set(cby, 0, -sby);                 /* = up x fwd, so makeBasis is valid */
      _lv.m.makeBasis(lat, AXIS_Y, fwd);
      var qW = _qw[qc++].setFromRotationMatrix(_lv.m);
      var wBone = B[idx.weapon], qInv = _lv.q.copy(qChest2).invert();
      wBone.quaternion.copy(qInv).multiply(qW);
      /* target: one chest-width to the side, floorplate on the deck */
      tmpV.copy(chP).addScaledVector(lat, spq.chestW * 1.75 * openSide(R));
      tmpV.y = (R.floor - R.oy) / unit - spq.grip.low;
      wBone.position.copy(tmpV).sub(chP).applyQuaternion(qInv);
    }
  }
  /* Which side the rifle is laid out on: the side of the body that finished
     UPPERMOST, so a body that rolled onto its right does not end up lying on
     its own weapon. +X is the character's right (see bipedBones). */
  function openSide(R) {
    var il = R.nameIdx['hiL'] * 3, ir = R.nameIdx['hiR'] * 3;
    return (R.x[ir + 1] >= R.x[il + 1]) ? 1 : -1;
  }

  /* -------------------------------------------------------------------------
     EXACT GROUND CONTACT, ONCE, AT THE MOMENT THE BODY STOPS.

     Sphere clearances get a falling body approximately right; they cannot get
     a settled one exactly right, because the distance from a bone anchor to
     the skin around it depends on which way that bone finished pointing. The
     far LOD is grounded on its real vertices (bakePose), so the only way the
     two tiers can agree on where the floor is, is for the near one to be
     grounded on its real vertices too.

     So: skin a decimated sample of the body once, find its lowest point, and
     translate the whole particle cloud so that point lands on the floor. One
     pass, ~700 vertices, at the instant the ragdoll latches -- cheaper than a
     single frame of the solver it replaces, and after it the corpse rests on
     the ground plane to the millimetre in both LODs.
     ---------------------------------------------------------------------- */
  var _skinM = null;
  function settleOnFloor(e, rig, st) {
    var R = st.rag, c = st.char;
    if (!R || !c || R.lifted) return;
    R.lifted = 1;
    var a = ASSET[e.kind]; if (!a || !a.tpl) return;
    var geo = c.mesh.geometry;
    var pa = geo.attributes.position, sk = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (!pa || !sk || !sw) return;
    var inv = a.tpl.inverses, i, k;
    rig.root.updateMatrixWorld(true);
    if (!_skinM) _skinM = [];
    for (i = 0; i < c.bones.length; i++) {
      if (!_skinM[i]) _skinM[i] = new THREE.Matrix4();
      _skinM[i].multiplyMatrices(c.bones[i].matrixWorld, inv[i]);
    }
    var P = pa.array, si = sk.array, W = sw.array, n = pa.count;
    var stride = Math.max(1, Math.floor(n / 1400));
    var v = _lv.v, acc = _lv.v2, lo = Infinity;
    for (i = 0; i < n; i += stride) {
      acc.set(0, 0, 0);
      for (k = 0; k < 4; k++) {
        var w = W[i * 4 + k]; if (w <= 0) continue;
        v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(_skinM[si[i * 4 + k]]);
        acc.addScaledVector(v, w);
      }
      if (acc.y < lo) lo = acc.y;
    }
    if (!isFinite(lo)) return;
    var dy = clamp(R.floor - lo, -0.40 * R.unit, 1.8 * R.unit);
    if (Math.abs(dy) > 1e-4) {
      for (i = 0; i < R.n; i++) {
        R.x[i * 3 + 1] += dy; R.px[i * 3 + 1] += dy; R.sx[i * 3 + 1] += dy;
      }
      applyRagdollToBones(R, c, rig, e.kind);
    }
    corpseFrame(R);
    R.gy = R.floor;
  }

  /* =========================================================================
     13. FAR LOD  (InstancedMesh pose bank -- replaces the sprite sheet)
     ====================================================================== */
  var FAR_CAP = 64;
  var _fm = null, _fc = null;
  function farMesh(kind, pose) {
    var a = ASSET[kind];
    if (a.farMesh[pose]) return a.farMesh[pose];
    var m = new THREE.InstancedMesh(a.far[pose], a.mats[1], FAR_CAP);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    m.castShadow = false; m.receiveShadow = true;
    m.name = 'nz-far-' + kind + '-' + pose;
    NZ.ctx.scene.add(m);
    a.farMesh[pose] = m;
    return m;
  }

  function resetFar() {
    for (var k = 0; k < KINDS.length; k++) {
      var a = ASSET[KINDS[k]]; if (!a) continue;
      for (var p = 0; p < a.farMesh.length; p++) if (a.farMesh[p]) a.farMesh[p].count = 0;
    }
  }
  function pushFar(kind, pose, x, y, z, yaw, scale, variant, roll) {
    var m = farMesh(kind, pose);
    if (m.count >= FAR_CAP) return;
    if (!_fm) { _fm = new THREE.Matrix4(); _fc = new THREE.Color(); }
    _lv.e.set(0, yaw, roll || 0, 'YXZ');
    _lv.q.setFromEuler(_lv.e);
    _lv.v.set(x, y, z); _lv.v2.set(scale, scale, scale);
    _fm.compose(_lv.v, _lv.q, _lv.v2);
    m.setMatrixAt(m.count, _fm);
    var t = 1 + (variant - 1) * 0.08;
    _fc.setRGB(t, t * (variant === 2 ? 0.95 : 1), t * (variant === 0 ? 0.95 : 1));
    m.setColorAt(m.count, _fc);
    m.count++;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  /* =========================================================================
     14. LOD SELECTION (own rAF, runs once per browser frame)
     Every threshold is hysteretic: promote at IN, demote only past OUT. A
     tier that flips on the boundary is the classic LOD shimmer.
     ====================================================================== */
  var LOD0_IN = 26, LOD0_OUT = 31, LOD1_IN = 72, LOD1_OUT = 80;
  var LODBUF = [], ORDBUF = [];
  function lodPass() {
    var es = G.enemies, cam = NZ.ctx.camera;
    if (!es || !cam) return;
    var px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    var fx = -Math.sin(cam.rotation.y), fz = -Math.cos(cam.rotation.y);
    var cand = LODBUF; cand.length = 0;
    var i;
    for (i = 0; i < es.length; i++) {
      var e = es[i];
      if (!e._nz || !e.rig || !e.rig.nz) continue;
      var dx = e.x - px, dz = e.z - pz, dy = e.y - py;
      var d = Math.sqrt(dx * dx + dz * dz + dy * dy * 0.35);
      var dot = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      /* already-skinned actors get a small priority bonus so a tie cannot
         make two characters swap slots (and therefore both pop) */
      var hold = e._nz.tier === 0 ? 0.86 : e._nz.tier === 1 ? 0.93 : 1;
      var score = d * (dot > -0.25 ? 1 : 3.2) * (e.dead ? 1.9 : 1) * hold;
      e._nz.dist = d;
      cand.push(score, i);
    }
    var n = cand.length / 2, order = ORDBUF; order.length = 0;
    for (i = 0; i < n; i++) order.push(i);
    order.sort(function (a, b) { return cand[a * 2] - cand[b * 2]; });
    var t0 = 0, t1 = 0;
    for (i = 0; i < order.length; i++) {
      var e2 = es[cand[order[i] * 2 + 1]];
      var st = e2._nz, want = 2;
      var lim0 = st.tier === 0 ? LOD0_OUT : LOD0_IN;
      var lim1 = st.tier === 1 ? LOD1_OUT : LOD1_IN;
      if (st.dist < lim0 && t0 < MAX_SKIN[0]) { want = 0; t0++; }
      else if (st.dist < lim1 && t1 < MAX_SKIN[1]) { want = 1; t1++; }
      st.wantTier = want;
    }
  }

  /* =========================================================================
     15. HOOK IMPLEMENTATIONS
     ====================================================================== */
  function onCreateRig(e) {
    if (PANIC > 24) return undefined;
    try {
      if (!ASSET[e.kind]) return undefined;
      return createRig(e);
    } catch (err) { panic(err); return undefined; }
  }

  function onAnimate(e, speed, now) {
    var rig = e.rig;
    if (!rig || !rig.nz) return undefined;
    try {
      var st = e._nz;
      /* Match the game's own 50 ms simulation cap. Letting animation consume
         twice as much time as body motion below 20 fps made swings and spring
         settles visibly outrun the actor they were attached to. */
      var dt = st.lastNow ? clamp(now - st.lastNow, 0.0005, 0.05) : 1 / 60;
      st.lastNow = now;
      if (st.wantTier !== undefined && st.wantTier !== st.tier) setTier(e, rig, st.wantTier);

      if (PANIC > 12 || st.tier === 2 || !st.char) {
        farUpdate(e, rig, now);
        return true;
      }
      animateBiped(e, rig, speed, now, dt);

      if (e.state === 'attack' || e.muzzlePulse > 0) {
        rig.root.updateMatrixWorld(true);
        rig.muzzle.getWorldPosition(rig.muzzleWorld);
        rig.muzzleReady = true;
      }
      return true;
    } catch (err) {
      panic(err);
      try { farUpdate(e, e.rig, now); } catch (e2) { }
      return true;
    }
  }

  function farUpdate(e, rig, now) {
    var st = e._nz;
    var y = e.y + (e.cfg.float || 0);
    var sc = rig.unit * st.scale;
    var R = e.dead ? st.rag : null;

    if (R) {
      /* CORPSE: BOTH TIERS AGREE, BY CONSTRUCTION.
         The skinned path draws the body relative to a root pinned at the
         ragdoll origin, so the far path pins the root to exactly the same
         point (rotation 0, scale `unit`) instead of to the entity's logical
         position -- which the ragdoll left behind as it fell. That alone is
         the 2.03-unit dRoot snap VERIFY caught.

         The INSTANCE then goes where the body really is: its anchor centroid
         over the plane its lowest anchor is resting on, turned so the canned
         pose lies along the same axis the ragdoll settled along. Both LODs
         therefore share a footprint, a heading and a ground contact. */
      rig.root.position.set(R.ox, R.oy, R.oz);
      rig.root.rotation.set(0, 0, 0);
      rig.root.scale.set(rig.unit, rig.unit, rig.unit);
      var ref = ASSET[e.kind] && ASSET[e.kind].deadRef;
      var fx = R.cx, fz = R.cz, fyaw = R.yaw, fy = R.gy;
      if (ref && ref.ok) {
        fyaw = R.yaw - ref.yaw;
        var cw = Math.cos(fyaw), sw = Math.sin(fyaw);
        fx = R.cx - sc * (cw * ref.cx + sw * ref.cz);
        fz = R.cz - sc * (cw * ref.cz - sw * ref.cx);
      }
      pushFar(e.kind, 4, fx, fy, fz, fyaw, sc, st.variant);
      return;
    }

    rig.root.position.set(e.x, y, e.z);
    rig.root.rotation.set(0, e.face, 0);
    rig.root.scale.set(sc, sc, sc);
    if (e.state === 'attack' || e.muzzlePulse > 0) {
      rig.root.updateMatrixWorld(true);
      rig.muzzle.getWorldPosition(rig.muzzleWorld);
      rig.muzzleReady = true;
    }
    /* Four baked phases carry the large limb shapes; continuous root motion
       carries the weight between them. Without this layer the quarter-cycle
       bank snapped while the actor glided at a perfectly constant height --
       the dominant low-quality view when the skinning pool is full. */
    var pose = e.dead ? 4 : (e.crouch > 0.5 ? 5 : (Math.floor(fract(e.gait) * 4) & 3));
    var hov = e.cfg.float ? Math.sin(now * 2.1 + st.seed) * 0.2 * rig.unit : 0;
    var farMove = sstep(clamp((e.speedSm || 0) * 4, 0, 1));
    var farPhase = (e.gait || 0) * TAU;
    var farBob = Math.max(0, Math.sin(farPhase * 2)) * e.cfg.h * 0.010 * farMove;
    var farRoll = Math.sin(farPhase) * 0.026 * farMove -
      clamp(e.leanAmt || 0, -1, 1) * 0.18;
    pushFar(e.kind, pose, e.x, y + hov + farBob, e.z, e.face, sc, st.variant, farRoll);
  }

  function onAnimateDeath(e, t, fall) {
    var rig = e.rig;
    if (!rig || !rig.nz) return undefined;
    try {
      var st = e._nz;
      var now = performance.now() * 0.001;
      var dt = st.lastNow ? clamp(now - st.lastNow, 0.0005, 0.1) : 1 / 60;
      st.lastNow = now;
      if (st.wantTier !== undefined && st.wantTier !== st.tier) setTier(e, rig, st.wantTier);

      if (st.rag && !st.rag.dead) {
        stepRagdoll(st.rag, dt, e);
        /* keep the blob shadow / tell anchored to the body, not the last
           known AI position (the game already wrote them this frame) */
        var pi = st.rag.nameIdx['pelvis'] * 3;
        e.x = st.rag.x[pi]; e.z = st.rag.x[pi + 2];
        if (e.shadow) e.shadow.position.set(e.x, e.y + 0.055, e.z);
      }
      if (PANIC > 12 || st.tier === 2 || !st.char) { farUpdate(e, rig, now); return true; }
      if (st.rag) {
        if (!st.rag.dead || !st.ragPose) {
          applyRagdollToBones(st.rag, st.char, rig, e.kind);
          st.poseOn = null;
        } else if (st.poseOn !== st.char) {
          /* THE ROOT HAS TO BE RE-PINNED HERE, NOT ONLY IN applyRagdollToBones.
             A settled corpse that went out to LOD2 and came back had its root
             left with the far path's transform -- entity position, e.face yaw,
             variant scale -- because the stored-pose branch only wrote bones.
             The body then rendered rotated about a point 0.6 m from where it
             was lying. Pinning it here closes that hole for good.

             Doing it ONCE per attachment rather than once per frame is also
             the whole of the settled-corpse cost: from here a corpse that is
             not moving does no per-frame work at all. */
          rig.root.position.set(st.rag.ox, st.rag.oy, st.rag.oz);
          rig.root.rotation.set(0, 0, 0);
          rig.root.scale.set(rig.unit, rig.unit, rig.unit);
          applyStoredPose(st.char, st.ragPose);
          st.poseOn = st.char;
        }
        if (st.rag.dead && !st.ragPose) {
          /* the body has stopped and a skinned character is attached: this is
             the one and only moment we can ground it on its real geometry */
          settleOnFloor(e, rig, st);
          st.ragPose = storePose(st.char); st.poseOn = st.char;
        }
      } else {
        cannedDeath(e, rig, t, fall);
      }
      return true;
    } catch (err) {
      panic(err);
      try {
        var s2 = e._nz;
        if (s2) { s2.rag = null; }
        farUpdate(e, e.rig, performance.now() * 0.001);
      } catch (e3) { }
      return true;
    }
  }

  /* fallback if the ragdoll could not be built (pool starved at death time) */
  function cannedDeath(e, rig, t, fall) {
    var st = e._nz, c = st.char;
    if (!c) return;
    var ix = c.idx, B = c.bones, sp = SPEC[e.kind];
    var side = e.deathSide || 1;
    rig.root.position.set(e.x, e.y, e.z);
    rig.root.rotation.set(0, e.face, 0);
    var sc = rig.unit * st.scale;
    rig.root.scale.set(sc, sc, sc);
    B[ix.neck].position.set(0, sp.neck, -0.010 * sp.H);
    B[ix.head].position.set(0, sp.headUp, 0.012 * sp.H);
    B[ix.hips].position.set(0, lerp(sp.hipY, 0.40, fall), -fall * 0.2);
    B[ix.hips].rotation.set(-fall * 1.35, side * fall * 0.3, side * fall * 0.9);
    B[ix.spine].rotation.set(fall * 0.22, 0, side * fall * 0.14);
    B[ix.spine2].rotation.set(fall * 0.14, side * fall * 0.10, -side * fall * 0.08);
    B[ix.chest].rotation.set(fall * 0.24, side * fall * 0.16, -side * fall * 0.16);
    B[ix.neck].rotation.set(fall * 0.3, 0, 0);
    B[ix.armL].rotation.set(-0.9 * fall, 0.4 * fall, 0.9 * fall);
    B[ix.armR].rotation.set(-0.6 * fall, -0.5 * fall, -1.1 * fall);
    B[ix.foreL].rotation.set(0.7 * fall, 0, 0);
    B[ix.foreR].rotation.set(0.5 * fall, 0, 0);
    B[ix.thighL].rotation.set(0.5 * fall, 0, 0.3 * fall);
    B[ix.thighR].rotation.set(0.2 * fall, 0, -0.4 * fall);
    B[ix.shinL].rotation.set(0.6 * fall, 0, 0);
    B[ix.shinR].rotation.set(0.9 * fall, 0, 0);
  }

  /* --------------------------------------------------- locational damage -- */
  /* The game calls damageEnemy(e, dmg, dir) without a hitPoint for hitscan and
     explosions, so we reconstruct the impact using the exact ray the shooter
     used: org = (player.x, player.y + EYE - .25, player.z), closest approach
     to the enemy's vertical axis. Same maths as hitscan(), so the region we
     report always agrees with the shot the game actually resolved.          */
  function hitRegion(e, dir, hitPoint) {
    var cfg = e.cfg, p = G.player;
    var hy, hx, hz;
    if (hitPoint) { hy = hitPoint.y; hx = hitPoint.x; hz = hitPoint.z; }
    else if (dir && p) {
      var ox = p.x, oy = p.y + G.EYE - 0.25, oz = p.z;
      var cyv = e.y + cfg.h * 0.52 + (cfg.float || 0);
      var t = (e.x - ox) * dir.x + (cyv - oy) * dir.y + (e.z - oz) * dir.z;
      if (t < 0.5) t = 0.5;
      hx = ox + dir.x * t; hy = oy + dir.y * t; hz = oz + dir.z * t;
    } else { return { region: 1, y: e.y + cfg.h * 0.55, x: e.x, z: e.z, frac: 0.55, side: 0 }; }
    var frac = clamp((hy - e.y) / Math.max(0.1, cfg.h), 0, 1.2);
    var region;
    if (cfg.float) region = frac > 0.72 ? 0 : frac > 0.45 ? 1 : 4;
    else region = frac > 0.855 ? 0 : frac > 0.60 ? 1 : frac > 0.44 ? 2 : 3;
    /* which side of the body did it land on, in character space */
    var cf = Math.cos(e.face), sf = Math.sin(e.face);
    var ddx = hx - e.x, ddz = hz - e.z;
    var side = ddx * cf - ddz * sf;
    return { region: region, y: hy, x: hx, z: hz, frac: frac, side: side };
  }

  function onDamaged(e, dmg, dir, hitPoint) {
    var rig = e.rig;
    if (!rig || !rig.nz) return;
    try {
      var st = e._nz;
      var h = hitRegion(e, dir, hitPoint);
      st.region = h.region;
      st.lastHitY = h.y;
      /* incoming direction in character space */
      var cf = Math.cos(e.face), sf = Math.sin(e.face);
      var lz = dir ? (dir.x * sf + dir.z * cf) : 1;
      var lx = dir ? (dir.x * cf - dir.z * sf) : 0;
      var k = clamp(0.10 + dmg * 0.0055, 0.10, 0.55);
      var pitch = lz * k * (h.region === 0 ? 1.5 : h.region === 3 ? 0.4 : 1.0);
      var roll = -lx * k * (h.region === 0 ? 1.2 : 1.0);
      st.hitP.impulse(pitch * 11);
      st.hitR.impulse(roll * 11);
      st.hitY.impulse(-lx * k * (h.region === 0 ? 16 : 5));
      /* per-limb reaction: an arm hit lifts that shoulder, a leg hit buckles
         that knee. Region + side together mean the flinch always points at
         the round that caused it. */
      if (st.hitArm && (h.region === 1 || h.region === 0)) {
        var ai = h.side > 0 ? 1 : 0;
        st.hitArm[ai].impulse(k * 7 * (Math.abs(h.side) > e.cfg.rad * 0.35 ? 1 : 0.35));
      }
      if (st.hitLeg && h.region >= 2) {
        var li = h.side > 0 ? 1 : 0;
        st.hitLeg[li].impulse(k * 6);
      }
      /* headshot: extra snap + a directional spray at the real impact height */
      if (h.region === 0 && G.particle) {
        st.headshot = 1;
        for (var i = 0; i < 5; i++)
          G.particle('blood', h.x + (Math.random() - .5) * .5, h.y + (Math.random() - .5) * .4, h.z + (Math.random() - .5) * .5,
            (dir ? dir.x : 0) * 7 + (Math.random() - .5) * 5, 3 + Math.random() * 6, (dir ? dir.z : 0) * 7 + (Math.random() - .5) * 5,
            .5 + Math.random() * .7, .3 + Math.random() * .4, -26, false);
      }
      /* nudge the ragdoll if we somehow get damaged post-mortem */
      if (st.rag && !st.rag.dead && dir) {
        var nm = h.region === 0 ? 'head' : h.region === 1 ? 'chest' : h.region === 2 ? 'pelvis' : 'hiL';
        var f = clamp(dmg * 0.0012, 0.01, 0.07);
        ragdollImpulse(st.rag, nm, dir.x * f, 0.2 * f, dir.z * f);
      }
    } catch (err) { panic(err); }
  }

  function onKilled(e, dmg, dir, hitPoint) {
    var rig = e.rig;
    if (!rig || !rig.nz) return;
    try {
      var st = e._nz;
      var h = hitRegion(e, dir, hitPoint);
      st.region = h.region;
      /* the game already added the death kick to e.vx/e.vz; take it as our
         impulse and zero it so the corpse is not driven from two places */
      var kvx = e.vx, kvz = e.vz;
      e.vx = 0; e.vz = 0;
      if (!st.char) {
        /* not skinned right now -- try to grab a character so we can ragdoll */
        setTier(e, rig, 1);
      }
      if (!st.char) { st.rag = null; return; }
      /* make sure the bones hold the last live pose before we snapshot */
      rig.root.updateMatrixWorld(true);
      var R = buildRagdoll(e, rig, performance.now() * 0.001);
      R.floor = G.highestFloor ? G.highestFloor(e.x, e.z, e.cfg.rad * 0.8) : e.y;
      st.rag = R;
      var dt0 = 1 / 60;
      /* body-wide momentum from the death kick, on top of the per-particle
         velocity already inherited from the animation */
      for (var i = 0; i < R.n; i++) {
        R.px[i * 3] -= kvx * dt0 * 0.9;
        R.px[i * 3 + 2] -= kvz * dt0 * 0.9;
      }
      /* concentrated impulse where the shot landed */
      if (dir) {
        var nm = h.region === 0 ? 'head' : h.region === 1 ? 'chest' : h.region === 2 ? 'pelvis' :
          (h.side > 0 ? 'hiR' : 'hiL');
        var f = clamp(0.010 + dmg * 0.00045, 0.010, 0.075) * (h.region === 0 ? 1.7 : 1);
        ragdollImpulse(R, nm, dir.x * f, (h.region === 0 ? 0.55 : 0.28) * f, dir.z * f);
        ragdollImpulse(R, 'chest', dir.x * f * 0.4, 0.1 * f, dir.z * f * 0.4);
      }
      st.ragPose = null;
    } catch (err) { panic(err); if (e._nz) e._nz.rag = null; }
  }

  /* =========================================================================
     15b. PUBLIC SURFACE  (cross-file contract C3)

     The AI agent in NUKEM.html reads these for tracer origins, hitboxes and
     aim requests. Every one of them is null-safe: the module may have panicked,
     the actor may be at LOD2 with no skinned character attached, or the rig may
     belong to the stock path entirely. Nothing here ever throws.
     ====================================================================== */
  var DISPLAY_NAME = {
    trooper: 'TÜFEKÇİ', pig: 'KIRICI', enforcer: 'HÜCUMCU', octa: 'NİŞANCI'
  };

  var _pubV = null, _pubV2 = null, _pubQ = null;
  function pubTemps() {
    if (_pubV) return true;
    if (!THREE) return false;
    _pubV = new THREE.Vector3(); _pubV2 = new THREE.Vector3(); _pubQ = new THREE.Quaternion();
    return true;
  }
  /* the skinned character for an enemy, or null */
  function charOf(e) {
    return (e && e._nz && e._nz.char && e.rig && e.rig.nz) ? e._nz.char : null;
  }
  /* Bone world position. Returns a NEW Vector3 (callers keep them), or null. */
  function boneWorld(e, name, out) {
    try {
      var c = charOf(e); if (!c || !pubTemps()) return null;
      var i = c.idx[name]; if (i === undefined) return null;
      var b = c.bones[i]; if (!b) return null;
      e.rig.root.updateMatrixWorld(true);
      var v = out || new THREE.Vector3();
      v.setFromMatrixPosition(b.matrixWorld);
      return isFinite(v.x + v.y + v.z) ? v : null;
    } catch (err) { return null; }
  }
  /* Drop the gun out of a dead man's hands. Every vertex of the weapon is
     100%-weighted to the single `weapon` bone (see mGun in addGear), so
     zero-scaling that bone collapses the whole gun to a point inside the
     wrist -- gone, at zero geometry cost, and reversible by construction.
     Scale is the one channel nothing else writes: deadPose and the ragdoll
     both drive the bone's position and rotation only, so the zero survives
     the fall, the settle and the frozen corpse pose. Called by the game
     when it spawns the fallen-weapon pickup; the pickup on the floor IS
     this gun from that frame on. Null-safe like everything here: an actor
     at sprite LOD has no bones to hide and returns false, which the caller
     treats as "the sprite art keeps the gun" and lives with. */
  function hideWeapon(e) {
    try {
      var c = charOf(e); if (!c) return false;
      var i = c.idx.weapon; if (i === undefined) return false;
      var b = c.bones[i]; if (!b || !b.scale) return false;
      b.scale.set(0, 0, 0);
      if (e._nz) e._nz.weaponHidden = true;
      return true;
    } catch (err) { return false; }
  }
  /* Muzzle point + unit forward direction, for tracers and muzzle flash.
     Falls back to the rig's coarse anchor when nothing is skinned so the AI
     never has to special-case distance. */
  function muzzleWorld(e) {
    try {
      if (!e || !e.rig || !e.rig.nz || !pubTemps()) return null;
      e.rig.root.updateMatrixWorld(true);
      var m = e.rig.muzzle; if (!m) return null;
      var p = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
      /* the anchor's local +Z is the bore axis */
      var d = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(_pubQ.setFromRotationMatrix(m.matrixWorld)).normalize();
      if (!isFinite(p.x + p.y + p.z + d.x + d.y + d.z)) return null;
      return { p: p, d: d };
    } catch (err) { return null; }
  }
  /* Head centre + radius, in world units, for the headshot volume. */
  function headWorld(e) {
    try {
      if (!e || !e.cfg) return null;
      var sp = SPEC[e.kind];
      var unit = (e.rig && e.rig.nz && e.rig.unit) ? e.rig.unit : (sp ? e.cfg.h / sp.modelH : 1);
      var p = boneWorld(e, 'head');
      if (!p) {
        if (!pubTemps()) return null;
        /* coarse fallback: the anthropometric head centre of the capsule */
        p = new THREE.Vector3(e.x, e.y + e.cfg.h * 0.925 + (e.cfg.float || 0), e.z);
      } else {
        /* the head BONE is at the base of the skull; the centre is above it */
        p.y += (sp ? sp.headD * 0.10 : 0) * unit;
      }
      var r = (sp ? (sp.headHit || sp.headW * 1.30) : e.cfg.h * 0.058) * unit;
      return { p: p, c: p, r: r, radius: r };
    } catch (err) { return null; }
  }
  /* Oriented hit volumes, ordered head-first so a caller can early-out on the
     highest multiplier. `centre` is world, `halfExtents` is in the box's own
     frame, `yaw` is the box's rotation about +Y. */
  var HITBOX_DEF = [
    /* name      bone      ax     ay     az     dy      mult */
    ['head', 'head', 0.062, 0.070, 0.075, 0.012, 4.0],
    ['neck', 'neck', 0.040, 0.035, 0.040, 0.020, 2.0],
    ['chest', 'chest', 0.115, 0.085, 0.082, -0.030, 1.25],
    ['stomach', 'spine', 0.100, 0.070, 0.070, 0.010, 1.0],
    ['pelvis', 'hips', 0.098, 0.058, 0.070, 0.010, 1.0],
    ['armL', 'foreL', 0.038, 0.090, 0.038, -0.040, 0.75],
    ['armR', 'foreR', 0.038, 0.090, 0.038, -0.040, 0.75],
    ['thighL', 'thighL', 0.052, 0.105, 0.052, -0.100, 0.75],
    ['thighR', 'thighR', 0.052, 0.105, 0.052, -0.100, 0.75],
    ['shinL', 'shinL', 0.044, 0.100, 0.044, -0.095, 0.60],
    ['shinR', 'shinR', 0.044, 0.100, 0.044, -0.095, 0.60]
  ];
  var _hbOut = [];
  function hitboxes(e) {
    try {
      var c = charOf(e);
      var sp = SPEC[e.kind];
      var unit = (e.rig && e.rig.nz && e.rig.unit) ? e.rig.unit : (sp ? e.cfg.h / sp.modelH : 1);
      var H = (sp ? sp.H : 6.2) * unit;
      var out = [];
      if (!c || !pubTemps()) {
        /* Not skinned: one capsule that matches what the game already uses, so
           a caller can always rely on getting SOMETHING back. */
        out.push({
          name: 'body', bone: null, mult: 1.0, yaw: e.face || 0,
          centre: new THREE.Vector3(e.x, e.y + e.cfg.h * 0.52 + (e.cfg.float || 0), e.z),
          halfExtents: new THREE.Vector3(e.cfg.rad, e.cfg.h * 0.5, e.cfg.rad)
        });
        return out;
      }
      e.rig.root.updateMatrixWorld(true);
      for (var i = 0; i < HITBOX_DEF.length; i++) {
        var d = HITBOX_DEF[i], bi = c.idx[d[1]];
        if (bi === undefined) continue;
        var b = c.bones[bi];
        _pubV.set(0, d[5] * H / unit, 0).applyMatrix4(b.matrixWorld);
        if (!isFinite(_pubV.x + _pubV.y + _pubV.z)) continue;
        _pubQ.setFromRotationMatrix(b.matrixWorld);
        _pubV2.set(1, 0, 0).applyQuaternion(_pubQ);
        out.push({
          name: d[0], bone: d[1], mult: d[6],
          yaw: Math.atan2(_pubV2.x, _pubV2.z) - PI * 0.5,
          centre: _pubV.clone(),
          halfExtents: new THREE.Vector3(d[2] * H, d[3] * H, d[4] * H)
        });
      }
      return out;
    } catch (err) { return _hbOut; }
  }
  /* Aim request. The AI owns WHERE the shot goes; the rig owns how the body
     gets there. Feeding it here (rather than letting the rig always aim at the
     player) is what lets the AI lead a target, suppress a doorway or track a
     last-known position without the animation contradicting it. */
  function poseAim(e, yaw, pitch) {
    try {
      var st = e && e._nz; if (!st) return false;
      if (!isFinite(yaw) || !isFinite(pitch)) return false;
      st.aimReq = 1;
      st.aimReqYaw = yaw;                     /* WORLD yaw, radians */
      st.aimReqPitch = clamp(pitch, -1.2, 1.2);
      st.aimReqT = 0.35;                      /* stale after 350 ms */
      return true;
    } catch (err) { return false; }
  }

  /* =========================================================================
     16. INSTALL
     ====================================================================== */
  var installed = false;
  function install(ctx) {
    if (installed) return;
    THREE = ctx.THREE || global.THREE;
    if (!THREE || !THREE.SkinnedMesh || !THREE.Skeleton || !THREE.Bone) throw new Error('three.js skinning API missing');
    if (!probeGlobals()) throw new Error('game globals not reachable');
    lazyTemps(); initAxes(); animTemps();

    /* adaptive quality: the render module owns the tier, we follow it */
    var qual = (NZ.render && NZ.render.quality) || 'high';
    USE_PHYSICAL = detectPhysical();
    MAX_SKIN = qual === 'low' ? [3, 4] : qual === 'med' ? [5, 7] : [6, 10];
    if (qual === 'low') { LOD0_IN = 18; LOD0_OUT = 23; LOD1_IN = 48; LOD1_OUT = 56; }
    else if (qual === 'med') { LOD0_IN = 22; LOD0_OUT = 27; LOD1_IN = 60; LOD1_OUT = 68; }

    /* Real-world scale FIRST: every weapon and kit dimension downstream is a
       millimetre figure multiplied by sp.mpm, which is only knowable once
       ECFG is reachable. */
    calibrateScale();

    var t0 = performance.now();
    bakeAtlas();
    var tAtlas = performance.now();
    for (var i = 0; i < KINDS.length; i++) ASSET[KINDS[i]] = buildAsset(KINDS[i]);
    NZ.log('atlas ' + Math.round(tAtlas - t0) + 'ms, meshes ' +
      Math.round(performance.now() - tAtlas) + 'ms');
    NZ.log('assets built in ' + Math.round(performance.now() - t0) + 'ms',
      'physical=' + USE_PHYSICAL, 'q=' + qual);
    /* --- AO wiring self-check, printed once ----------------------------- */
    try {
      var m0 = ASSET.trooper.mats[0];
      var uvOK = true, uvBad = '';
      for (var kk = 0; kk < KINDS.length; kk++) {
        var aa = ASSET[KINDS[kk]];
        for (var gq = 0; gq < aa.geo.length; gq++)
          if (!aa.geo[gq].attributes.uv2) { uvOK = false; uvBad += ' ' + KINDS[kk] + '/lod' + gq; }
        for (var fq = 0; fq < aa.far.length; fq++)
          if (!aa.far[fq].attributes.uv2) { uvOK = false; uvBad += ' ' + KINDS[kk] + '/far' + fq; }
      }
      NZ.log('AO check: uv2 on every geometry=' + (uvOK ? 'yes' : 'NO ->' + uvBad) +
        ' aoMap=' + (m0.aoMap === ATLAS.orm ? 'bound' : 'MISSING') +
        ' aoMapIntensity=' + m0.aoMapIntensity +
        ' ormAO range=[' + ORM_AO[0].toFixed(3) + ',' + ORM_AO[1].toFixed(3) +
        '] mean=' + (ORM_AO[3] ? (ORM_AO[2] / ORM_AO[3]).toFixed(3) : 'n/a') +
        ' vertexAO=baked');
      /* The number that had to be measured: mean normal deviation per tile.
         Fabric should be 4-6 deg, polymer 3, a receiver 2, boot tread 13.
         If any of these creeps back into the twenties the surface is
         shredded again and every other fix is invisible underneath it. */
      NZ.log('normal tilt (mean deg): ' + NRM_ACHIEVED.join(' '));
      if (ORM_AO[1] - ORM_AO[0] < 0.05)
        console.warn('[nz-enemies] ORM AO channel is nearly uniform (' +
          ORM_AO[0].toFixed(3) + '..' + ORM_AO[1].toFixed(3) + ') - texture AO will not read');
    } catch (chkErr) { console.warn('[nz-enemies] AO self-check failed:', chkErr); }

    /* Take ownership of every enemy: the stock selector only promotes the
       eight nearest to 3D, everything else stays a sprite. We want the whole
       set, and do our own LOD tiering underneath. */
    G.ERIG.near = 4000; G.ERIG.far = 4200; G.ERIG.max = 4096;

    NZ.on('createEnemyRig', onCreateRig);
    NZ.on('animateEnemyRig', onAnimate);
    NZ.on('animateEnemyRigDeath', onAnimateDeath);
    NZ.on('enemyDamaged', onDamaged);
    NZ.on('enemyKilled', onKilled);

    /* Our own frame beat: runs after the game's frame() every browser frame.
       Owns tier selection and clears the far-LOD instance counters (which the
       per-enemy animate hooks refill during the next update). */
    var loop = function () {
      global.requestAnimationFrame(loop);
      if (PANIC > 40) return;
      try {
        if (G.state && G.state.playing) { resetFar(); lodPass(); }
      } catch (err) { panic(err); }
    };
    global.requestAnimationFrame(loop);

    installed = true;
    NZ.flags.enemies = true;
    NZ.log('enemies installed');
  }

  NZ.on('ready', function (ctx) {
    try { install(ctx); }
    catch (err) {
      NZ.flags.enemies = false;
      console.error('[nz-enemies] install failed, stock rig retained:', err);
      /* make absolutely sure we did not half-take-over */
      try {
        if (G.ERIG) { G.ERIG.near = 25; G.ERIG.far = 29; G.ERIG.max = 8; }
      } catch (e) { }
    }
  });

  /* expose a little surface for debugging / the capture rig */
  NZ.enemies = {
    /* ---- cross-file contract C3 ------------------------------------------
       Stable signatures. The AI agent null-guards every one of these because
       this module may have panicked and torn itself down. */
    displayName: DISPLAY_NAME,
    boneWorld: boneWorld,
    hideWeapon: hideWeapon,
    muzzleWorld: muzzleWorld,
    headWorld: headWorld,
    hitboxes: hitboxes,
    poseAim: poseAim,
    /* weapon anchor points in weapon-bone local space, in model units:
       {r:[x,y,z] trigger hand, l:[...] support hand, butt, muzzle, sight, oal} */
    gripLocal: function (kind) { return SPEC[kind] && SPEC[kind].grip; },
    stats: function () {
      var out = {};
      for (var k in ASSET) {
        var a = ASSET[k];
        out[k] = {
          bones: a.nBones, verts: a.verts,
          tris: { lod0: a.tris[0], lod1: a.tris[1], far: a.far[0].index.count / 3 },
          materials: a.mats.length
        };
      }
      out.panic = PANIC;
      out.physical = USE_PHYSICAL;
      out.lod = { in0: LOD0_IN, out0: LOD0_OUT, in1: LOD1_IN, out1: LOD1_OUT, max: MAX_SKIN };
      return out;
    },
    /* pure-maths internals, exported so they can be exercised head-less */
    _solver: {
      step: function (R, dt, e) { return stepRagdoll(R, dt, e); },
      frame: ragFrame, hinge: addHinge, gravity: function () { return GRAVITY; },
      /* head-less entry points so the death physics can be measured rather
         than eyeballed: build a corpse from a live pose, then step it. */
      kill: function (e, dmg, dir, hp) { return onKilled(e, dmg, dir, hp); },
      apply: function (R, c, rig, kind) { return applyRagdollToBones(R, c, rig, kind); }
    },
    /* Locomotion, likewise. `attach` hands the module a THREE-compatible math
       surface so a head-less harness can drive animateBiped over a simulated
       walk / run / turn / stop and measure foot slip, phase lock, joint range
       and transition continuity. The game never touches any of this. */
    _loco: {
      attach: function (T) { THREE = T; lazyTemps(); initAxes(); animTemps(); },
      probe: function (g) { for (var k in g) G[k] = g[k]; },
      spec: function (k) { return SPEC[k]; },
      bones: function (k) { return bipedBones(SPEC[k]); },
      gait: function (k) { return GAIT[k]; },
      state: makeState, asym: makeAsym, footRoll: footRoll,
      create: function (e) { return createRig(e); },
      animate: function (e, rig, speed, now, dt) { animateBiped(e, rig, speed, now, dt); },
      gunSpec: function (k) { return gunSpec(SPEC[k]); },
      calibrate: calibrateScale
    },
    /* ANTHROPOMETRY PROBE. Builds one figure with the part index switched on
       and hands back the raw bind-pose vertex cloud plus [{n,a,b}] ranges, so
       an external tool can measure the real radius of the real mesh at a real
       station and print it against the 50th-percentile table. Never called by
       the game; `PARTS` is null in every shipping path. */
    _probe: function (kind, q) {
      var bones = bipedBones(SPEC[kind]);
      var tpl = buildSkeletonTemplate(bones);
      PARTS = [];
      var pile, err = null;
      try { pile = buildBiped(kind, tpl, q === undefined ? 0 : q); }
      catch (e) { err = e; }
      var parts = PARTS; PARTS = null;
      if (err) throw err;
      return { parts: parts, p: pile.p, idx: pile.idx, col: pile.col, n: pile.n,
        wc: pile.wc, spec: SPEC[kind], tpl: tpl, bones: bones,
        /* run the shipping weathering pass on a throw-away geometry so the
           hue spread it produces can be MEASURED, not assumed */
        weather: function () {
          var g = pileToGeometry(pile, null, null);
          weatherPile(g, pile, SPEC[kind].H, SPEC[kind].mpm, KINDS.indexOf(kind) + 1);
          return g.attributes.color.array;
        } };
    },
    ASSET: ASSET, SPEC: SPEC, REG: REG,
    /* dev aid: the baked atlas canvases, so the texture set can be LOOKED at
       instead of reasoned about. Returns null before install. */
    _atlas: function () {
      if (!ATLAS) return null;
      var o = {}, k;
      for (k in ATLAS) if (ATLAS[k] && ATLAS[k].image) o[k] = ATLAS[k].image;
      return o;
    },
    /* One knob for the whole cast. See the SCALE block: measured against the
       level's own metric (doors, ceilings, crates, grid, player radius) the
       enemies are correct and EYE is the outlier, so this is 1. Live enemies
       pick it up on their next animate; new spawns get it immediately. */
    scale: function () { return RIG_SCALE; },
    setScale: function (k) {
      RIG_SCALE = clamp(+k || 1, 0.2, 3);
      try {
        var es = G.enemies;
        for (var i = 0; es && i < es.length; i++) {
          var e = es[i];
          if (e && e.rig && e.rig.nz && SPEC[e.kind])
            e.rig.unit = (e.cfg.h / SPEC[e.kind].modelH) * RIG_SCALE;
        }
      } catch (err) { panic(err); }
      return RIG_SCALE;
    }
  };

})(typeof window !== 'undefined' ? window : this);
