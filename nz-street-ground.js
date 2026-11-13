/* ===========================================================================
   NZ-STREET-GROUND -- the ground plane of 233. Sokak.

   Owns everything at and below y = 1.0 inside the canyon: the cambered worn
   asphalt of the roadway, its three generations of patching and its tar seams,
   the precast kerbs, the interlocking-paver and cast-concrete pavements, the
   drainage ironwork, and every decal that tells the story of the surface.
   It does NOT paint the wall planes (FACADE owns those from y = 0 up) and it
   does not place objects (PROPS stands them on what this module makes).

   THE Z-FIGHT PROBLEM, and how it is solved.
   The game already drew this ground: NUKEM.html paints rResRoad (f = 0) and
   rResWalk (f = 0.5) and buildWorld() emitted a flat quad per cell. Everything
   here sits strictly ABOVE those quads -- the road never comes below y = 0.07,
   the paving never below y = 0.56 -- and every surface material carries
   polygonOffset toward the camera on top of that. Decals go a further 0.03 up
   with depthWrite off, so two overlapping decals blend instead of fighting.
   Verified at grazing angles from 1.7 m in _shots/street/street.kerb.png.

   THE TILING PROBLEM, and how it is solved. A 24 m street looked at end-on
   from 1.7 m is the worst case a tiling texture ever gets. Four defences, in
   order of how much they contribute:
     1. the roadway is a PATCHWORK -- ~30 irregular rectangles, each with its
        own UV origin, some rotated 90 deg, each with its own tone. Adjacent
        base-course patches share origin 0 so they are seamless; a patch that
        is a reinstatement deliberately does not line up, which is exactly what
        a trench reinstatement looks like;
     2. a world-space macro tone field (two octaves, 19 u and 6.7 u) multiplied
        into the vertex colours after NZ.street.bake();
     3. ~300 decals -- tar seams, patch edges, oil, splash, litter -- which are
        the largest-scale features on the surface and have no periodicity;
     4. honest texel density: every tile is authored as metres * 3.5.
        nz-env.js:607's METRES_PER_UNIT = 0.6 is stale; the live scale is
        1 u = 0.2857 m (NUKEM.html:360), so the copy of emitSet in here uses
        1/3.5 and its millimetre figures are real millimetres.

   Zero external assets. Classic script. three.js r149 core UMD only -- the
   geometry merge is the hand-written Pile from ENV-PLAYBOOK section 6, there is
   no BufferGeometryUtils anywhere.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.streetGround === undefined) NZ.flags.streetGround = false;

  /* opt-out / force a tier: ?nzground=0 | low | med | high */
  var QS = /[?&]nzground=(0|off|low|med|high)/i.exec(
    global.location ? global.location.search : '') || null;
  var DISABLED = !!(QS && /^(0|off)$/i.test(QS[1]));

  var THREE = null, scene = null, renderer = null;
  var dead = false, installed = false, lateDone = false;

  var OWN = { tex: [], mat: [], geo: [], obj: [], timer: 0 };
  var STATS = {
    sets: 0, texBytes: 0, decals: 0, patches: 0, kerbUnits: 0, weeds: 0,
    bays: 0, pits: 0, paint: 0, addedCalls: 0, tris: 0, verts: 0, ms: 0
  };
  var DIAG = { sets: [], piles: [], warnings: [] };
  function warn(msg) {
    DIAG.warnings.push(msg);
    try { console.warn('[nz-street-ground] ' + msg); } catch (e) {}
  }

  /* ---- small math ------------------------------------------------------- */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function sstep(a, b, x) { return smooth((x - a) / ((b - a) || 1e-6)); }

  /* Deterministic placement RNG. Every random choice in this file is seeded
     from a fixed integer constant plus a co-prime multiple of the emitter's
     own index, so two runs of the level are bit-identical and a critic's
     screenshot is reproducible. (ENV-PLAYBOOK 6.9) */
  var SEED = 20233;                       /* "233. Sokak", and nothing else */
  function h1(n) { var s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  function rnd(a, b) { return h1(SEED + a * 7919 + b * 104729); }

  /* world-space value noise, for the macro tone break-up */
  function vh(i, j) { var s = Math.sin(i * 12.9898 + j * 78.233 + SEED * 0.017) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, z) {
    var xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    var sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    var a = vh(xi, zi), b = vh(xi + 1, zi), c = vh(xi, zi + 1), d = vh(xi + 1, zi + 1);
    var t = a + (b - a) * sx, u = c + (d - c) * sx;
    return t + (u - t) * sz;
  }

  /* ---- scale (ENV-PLAYBOOK section 0) ------------------------------------ */
  var U = 3.5;                            /* world units per metre  */
  var M_PER_U = 1 / U;                    /* 0.2857 m, the LIVE scale */
  function m(x) { return x * U; }

  /* =======================================================================
     SECTION 1 -- the section of the street, in world units.
     AMENDMENT 2 (STREET-MODULE-CONTRACT section 6) widened the canyon from 32
     to 40 units and gave it an origin: a junction with a kerbed island at its
     west end, per _ref/ref8-park-intersection.png. Every row below moved.

       street body        x [168,252]  z [152,192]
       north pavement                  z [152,160]      2.29 m
       roadway                         z [160,184]      6.86 m, crown at 172
       south pavement                  z [184,192]      2.29 m
       junction throat    x [176,192]  z [152,160]      painted ROAD, f = 0
       junction island    x [184,192]  z [168,176]      S_BLOCK, kerbed
       junction apron     x <= 200                      no bays, open asphalt

     THE NUMBERS ARE READ BACK FROM NZ.street WHERE IT HAS THEM. The sky
     module's script tag is immediately before this one and it builds its
     namespace at PARSE time, so BOX / THROAT / ISLAND / KERB / PLANE are
     already published when this file is evaluated. Reading them means the
     orchestrator moves the street once and every module follows; the literals
     are the fallback for a build with ?nzsky=0.

     Published on NZ.streetGround at script-parse time (the same trick the sky
     module uses) so PROPS and ENTRANCE can read the heights of the surfaces
     they stand things on without caring when this module's hook fires.
     ==================================================================== */
  var BOXD = { x0: 548, x1: 836, z0: 152, z1: 196, y0: 0, y1: 52 };
  /* the street side of the junction: two cell rows repainted ROAD at f = 0, so
     asphalt and a dropped kerb go here and not pavement */
  var THRD = { x0: 548, x1: 548, z0: 152, z1: 160 };
  /* the opening in the north facade plane, north of it -- the alley beyond,
     which dies under the bridge band. GROUND stops at the plane. */
  var MOUTHD = { x0: 548, x1: 548, z0: 152, z1: 152 };
  /* the kerbed teardrop. GROUND owns the ring and the soil, PROPS the conifer. */
  var ISLD = { x0: 552, x1: 568, z0: 166, z1: 182 };

  var RX0 = 548, RX1 = 836;               /* roadway, along the street       */
  var RZ0 = 160, RZ1 = 188;               /* roadway, kerb face to kerb face */
  var RZC = (RZ0 + RZ1) * 0.5;            /* 174, the crown                  */
  var RHW = (RZ1 - RZ0) * 0.5;            /* 14                              */
  /* the junction apron: everything west of the first parking bay. NUKEM.html
     leaves cells x <= 49 unblocked on both kerb rows precisely so this reads
     as an open apron rather than as more street. */
  var APR_X1 = 580, APR_SOFT = 9;

  var GUT_Y = 0.07;                       /* gutter line: 20 mm over the world quad */
  var CAMBER = 0.28;                      /* 80 mm of crown -- unchanged, so the    */
  var CROWN_Y = GUT_Y + CAMBER;           /* crown and the gutter keep the heights  */
  var PAVE_Y = 0.56;                      /* PROPS' wheels were calibrated to.      */
  var KERB_Y = 0.585;                     /* kerb sits 7 mm proud of the paving      */
  var KERB_W = 1.0;                       /* 286 mm top; the brief asks for 300      */
  var KERB_FACE = KERB_Y - GUT_Y;         /* 0.515 u = 147 mm exposed face           */
  var KERB_UNIT = m(1.0);                 /* 3.5 u -- kerbs are laid in 1 m lengths  */
  /* THE WORLD QUAD IS A FLOOR THIS MODULE CANNOT GO UNDER. NUKEM.html paints
     rResWalk at f = 0.5 and buildWorld() emits an opaque quad per cell there,
     so anything of mine that dips below 0.5 on a pavement row is simply
     BURIED: the crossovers in the previous build dropped the kerb to 0.22 and
     ramped the paving to 0.30, and what a nadir measurement finds at each of
     them is a flat, untextured patch of the game's own concrete at lum 200
     against paving at 90. A crossover therefore drops as far as it can and no
     further -- 50 mm of kerb, 15 mm of paving, both still clear of the quad --
     and the rest of the read is carried by the worn wheel tracks, the spalled
     nose and the scuffing the decal pass lays on it. The junction throat is a
     different case and keeps its 19 mm flush channel: those cells were
     repainted ROAD at f = 0, so there is no quad in the way. */
  var KERB_DROP = 0.535;                  /* dropped kerb at a crossover: 50 mm      */
  var WALK_DROP = 0.545;                  /* and the paving that ramps down to it    */
  var KERB_FLUSH = 0.135;                 /* the throat channel: 19 mm, i.e. flush   */
  /* the throat's own crossfall, and it has to be ZERO at z = 160 or the side
     street steps out of the main road's gutter line */
  var THR_CAMBER = 0.20;
  /* FACADE owns the plinth from y = 0 up on the wall planes. Nothing this
     module builds stands above the paving inside this reserve, and no weed,
     tuft or tree pit is placed in it. */
  var PLINTH = 0.6;
  /* the island's mountable kerb: 0.60 u over the crown of the road, i.e. a
     171 mm upstand, and with the +-9 mm lay settle on top of it everything
     this module makes still lives under y = 1.0. The soil comes up to within
     65 mm of the top, which is what a forty-year-old island looks like --
     nobody has ever taken soil OUT of one. */
  var ISL_KERB_Y = 0.95, ISL_SOIL_Y = 0.885;

  /* the camber. y is a function of z ALONE, so two patches that share an edge
     share it exactly whatever their x subdivision -- no cracks, ever. */
  function roadY(z) {
    var t = clamp((z - RZC) / RHW, -1, 1);
    return GUT_Y + CAMBER * (1 - t * t);
  }
  /* the analytic surface normal that goes with it */
  function roadN(z, out) {
    var t = clamp((z - RZC) / RHW, -1, 1);
    var dydz = -2 * CAMBER * t / RHW;
    var l = Math.sqrt(1 + dydz * dydz) || 1;
    out[0] = 0; out[1] = 1 / l; out[2] = -dydz / l;
    return out;
  }

  /* --- the junction throat -------------------------------------------------
     The side street pours in over a dropped kerb, so its surface must LEAVE
     the main road's gutter line at exactly the gutter height and rise into its
     own crossfall as it runs north. s = 0 at z = 160 (flush with roadY(160) =
     GUT_Y, whatever the camber does) and 1 at the facade plane z = 152, where
     the asphalt dies under the bridge band. */
  function inThroat(x, z) {
    return x >= THRD.x0 && x <= THRD.x1 && z >= THRD.z0 && z <= THRD.z1;
  }
  function throatY(x, z) {
    var s = smooth(clamp((THRD.z1 - z) / (THRD.z1 - THRD.z0), 0, 1));
    var t = clamp((x - (THRD.x0 + THRD.x1) * 0.5) / ((THRD.x1 - THRD.x0) * 0.5), -1, 1);
    return GUT_Y + THR_CAMBER * (1 - t * t) * s;
  }
  function throatN(x, z, out) {
    var hw = (THRD.x1 - THRD.x0) * 0.5, span = THRD.z1 - THRD.z0;
    var u = clamp((THRD.z1 - z) / span, 0, 1);
    var s = smooth(u), ds = 6 * u * (1 - u) * (-1 / span);
    var t = clamp((x - (THRD.x0 + THRD.x1) * 0.5) / hw, -1, 1);
    var dydx = THR_CAMBER * (-2 * t / hw) * s;
    var dydz = THR_CAMBER * (1 - t * t) * ds;
    var l = Math.sqrt(dydx * dydx + 1 + dydz * dydz) || 1;
    out[0] = -dydx / l; out[1] = 1 / l; out[2] = -dydz / l;
    return out;
  }
  /* how much of the apron a point is in: 1 over the junction, 0 down the
     street. Everything that makes the apron read flatter, wider and more worn
     than the canyon is scaled by this. */
  function apron(x) { return 1 - smooth(clamp((x - APR_X1) / APR_SOFT, 0, 1)); }

  var GROUND = {
    ok: false,
    disabled: DISABLED,
    tier: null,
    BOX: BOXD,
    ROAD: { x0: RX0, x1: RX1, z0: RZ0, z1: RZ1, crownZ: RZC },
    THROAT: { x0: THRD.x0, x1: THRD.x1, z0: THRD.z0, z1: THRD.z1 },
    /* filled by buildIsland(): the precast ring PROPS plants inside */
    ISLAND: null,
    APRON: { x0: RX0, x1: APR_X1, soft: APR_SOFT },
    Y: {
      gutter: GUT_Y, crown: CROWN_Y, camber: CAMBER,
      pavement: PAVE_Y, kerbTop: KERB_Y, kerbFace: KERB_FACE,
      kerbDrop: KERB_DROP, kerbFlush: KERB_FLUSH,
      islandKerb: ISL_KERB_Y, islandSoil: ISL_SOIL_Y,
      plinth: PLINTH,
      /* kept under its old name: ENTRANCE and PROPS both read Y.mouth */
      mouth: GUT_Y
    },
    KERB: { northFace: RZ0, southFace: RZ1, width: KERB_W, unit: KERB_UNIT },
    /* the live cambered road height at a world z -- PROPS should sit a wheel
       on roadYAt(z), not on 0, or the car floats at the crown and sinks at
       the kerb. The grid still plants the PLAYER at 0; that is deliberate.
       `x` is OPTIONAL and only matters inside the junction throat, so every
       existing one-argument caller keeps its old answer. */
    roadYAt: function (z, x) {
      if (z >= RZ0 && z <= RZ1) return roadY(z);
      if (x !== undefined && inThroat(x, z)) return throatY(x, z);
      return GUT_Y;
    },
    /* true where the paving has been dropped for a vehicle crossover */
    crossovers: [],
    bays: [],
    pits: [],
    stats: STATS, diag: DIAG,
    report: function () { return report(); },
    dispose: function () { panic('manual dispose'); }
  };
  NZ.streetGround = GROUND;

  /* ---- follow the sky module's published surface -------------------------
     Validated field by field: a number is only taken if it is finite and the
     box it belongs to is non-degenerate, so a half-written NZ.street can never
     collapse the road to zero width. */
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function syncGeometry() {
    var s = NZ.street;
    if (!s) return;
    var B = s.BOX, K = s.KERB, T = s.THROAT, I = s.ISLAND, P = s.PLANE;
    if (B && num(B.x1, 0) - num(B.x0, 1) > 8 && num(B.z1, 0) - num(B.z0, 1) > 8) {
      BOXD.x0 = B.x0; BOXD.x1 = B.x1;
      RX0 = B.x0; RX1 = B.x1;
    }
    if (K && num(K.southTop, 0) - num(K.northTop, 1) > 4) { RZ0 = K.northTop; RZ1 = K.southTop; }
    RZC = (RZ0 + RZ1) * 0.5; RHW = (RZ1 - RZ0) * 0.5;
    /* Ground owns the two 2.29 m pavements, not the private gardens all the
       way back to the facade planes. */
    BOXD.z0 = RZ0 - 8; BOXD.z1 = RZ1 + 8;
    if (T && num(T.x1, 0) - num(T.x0, 1) > 2) {
      THRD.x0 = T.x0; THRD.x1 = T.x1; THRD.z0 = num(T.z0, BOXD.z0); THRD.z1 = num(T.z1, RZ0);
    }
    if (I && num(I.x1, 0) - num(I.x0, 1) > 2) {
      ISLD.x0 = I.x0; ISLD.x1 = I.x1; ISLD.z0 = I.z0; ISLD.z1 = I.z1;
    }
    if (s.MOUTH) {
      MOUTHD.x0 = num(s.MOUTH.x0, MOUTHD.x0); MOUTHD.x1 = num(s.MOUTH.x1, MOUTHD.x1);
      MOUTHD.z0 = num(s.MOUTH.z0, MOUTHD.z0); MOUTHD.z1 = num(s.MOUTH.z1, MOUTHD.z1);
    }
    GROUND.ROAD.x0 = RX0; GROUND.ROAD.x1 = RX1;
    GROUND.ROAD.z0 = RZ0; GROUND.ROAD.z1 = RZ1; GROUND.ROAD.crownZ = RZC;
    GROUND.THROAT.x0 = THRD.x0; GROUND.THROAT.x1 = THRD.x1;
    GROUND.THROAT.z0 = THRD.z0; GROUND.THROAT.z1 = THRD.z1;
    GROUND.KERB.northFace = RZ0; GROUND.KERB.southFace = RZ1;
    GROUND.APRON.x0 = RX0;
  }
  syncGeometry();

  if (DISABLED) { NZ.log && NZ.log('street-ground disabled by query string'); return; }

  /* ---- the shared street namespace, with graceful degradation ------------ */
  function ST() { return NZ.street || null; }
  function stDay(mat, opts) {
    var s = ST();
    if (s && typeof s.day === 'function') { try { return s.day(mat, opts); } catch (e) { warn('day() threw: ' + e.message); } }
    if (mat && String(mat.name || '').indexOf('nzday:') !== 0) mat.name = 'nzday:' + ((opts && opts.name) || mat.name || 'ground');
    return mat;
  }
  function stBake(geo, opts) {
    var s = ST();
    if (s && typeof s.bake === 'function') { try { return s.bake(geo, opts); } catch (e) { warn('bake() threw: ' + e.message); } }
    /* no sky module: write a flat mid bake so nothing renders black */
    try {
      if (geo && geo.attributes && geo.attributes.position && THREE) {
        var n = geo.attributes.position.count, c = new Float32Array(n * 3), i;
        for (i = 0; i < n * 3; i++) c[i] = 0.86;
        geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
        if (geo.attributes.uv && !geo.attributes.uv2) geo.setAttribute('uv2', geo.attributes.uv);
      }
    } catch (e2) {}
    return geo;
  }

  /* ---- the game's lexical globals (nz-env.js:130-163 idiom) -------------- */
  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }
  var G = null;
  function bindGame() {
    var g = {
      MW: fin(tryGet(function () { return MW; }), 0),
      MH: fin(tryGet(function () { return MH; }), 0),
      CELL: fin(tryGet(function () { return CELL; }), 4),
      S_SOLID: fin(tryGet(function () { return S_SOLID; }), 0),
      S_EXIT: fin(tryGet(function () { return S_EXIT; }), 5),
      S_BLOCK: fin(tryGet(function () { return S_BLOCK; }), 6),
      cellAt: tryGet(function () { return cellAt; }) || null,
      isWallCell: tryGet(function () { return isWallCell; }) || null,
      regAt: tryGet(function () { return regAt; }) || null,
      inb: tryGet(function () { return inb; }) || null
    };
    if (!g.MW || !g.MH || !g.cellAt || !g.regAt || !g.inb || !g.isWallCell) return null;
    return g;
  }
  function regionAt(cx, cy) { if (!G.inb(cx, cy)) return null; return G.regAt(cx, cy) || null; }
  function openCell(t) { return t !== G.S_SOLID && t !== G.S_EXIT; }
  function solidCell(cx, cy) { return !G.inb(cx, cy) || G.isWallCell(cx, cy); }

  /* ---- quality tier ------------------------------------------------------ */
  var TIER = 'high';
  /* RES.road is deliberately NOT tied to the tier. The carriageway is the one
     surface the player looks at from 0.3 m for the whole 24 m of this street,
     and at low tier a 256 map over the old 3 m repeat put one texel every
     11.7 mm -- so the 20 mm aggregate the material thinks it has landed on
     1.7 texels and magnified out to the soft 0.6 m blob field the critic
     measured at sd 6.84. 512 over a 2 m repeat is 3.9 mm a texel at every
     tier; that is 4.6 MB of asphalt and it buys back the near field. */
  var RES = { hi: 512, md: 256, road: 512 };
  var DENSITY = 1.0;
  var RAYS = 48;
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
  function applyTier() {
    TIER = pickTier();
    if (TIER === 'low') { RES = { hi: 256, md: 128, road: 512 }; DENSITY = 0.58; RAYS = 24; }
    else if (TIER === 'med') { RES = { hi: 512, md: 256, road: 512 }; DENSITY = 0.84; RAYS = 36; }
    else { RES = { hi: 512, md: 256, road: 512 }; DENSITY = 1.00; RAYS = 48; }
    GROUND.tier = TIER;
  }

  /* =======================================================================
     SECTION 2 -- the noise / field / albedo toolkit.
     The same algorithms as NZ.tex (same tiling lattice, same F1 worley, same
     Sobel) with the per-pixel modulo hoisted into index tables and every
     result memoised, exactly as nz-env.js:253-515 does it -- a 512 fbm through
     NZ.tex costs ~700 ms of closure calls and four sets would freeze the tab.
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

  /* separable box blur with wrap. r MUST be an integer -- a fractional radius
     walks src[11.63], gets undefined, and bakes the whole set pure black.
     (nz-env.js:401-410, which is the bug that turned 22 crates into boxes.) */
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

  /* --- pattern fields ---------------------------------------------------- */
  function fieldBond(res, rows, cols, joint, seed, stagger) {
    var msk = fnew(res), id = fnew(res), r = NZ.tex.mulberry32(seed);
    var rid = new Float32Array(rows * cols), i;
    for (i = 0; i < rid.length; i++) rid[i] = r();
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
        msk[k] = d < joint ? clamp(d / joint, 0, 1) : 1;
        id[k] = rid[rr * cols + cc];
      }
    }
    return { m: msk, id: id };
  }
  function fieldStreak(res, seed, freq, smear, vertical) {
    var n = fbmC(res, { octaves: 4, frequency: freq, seed: seed });
    return blurAxis(n, res, Math.max(1, Math.round(res / smear)), !!vertical);
  }

  /* --- albedo buffer ----------------------------------------------------- */
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
  /* per-unit colour: every paver, every kerb takes its own swatch */
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
  function texCanvas(c, srgb) {
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
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

  /* nz-env.js:607 hardcodes 0.6 and is WRONG (ENV-PLAYBOOK section 0). At the
     live scale a millimetre figure written here is a real millimetre. */
  var METRES_PER_UNIT = M_PER_U;          /* 0.2857 */

  function emitSet(res, alb, height, rough, metal, aoStrength, relief, name) {
    var q, bad = 0, sumR = 0, sumG = 0, sumB = 0, np = 0;
    /* mission 4 only: see SUN_ALB above.  A pure exposure scale on the
       finished albedo, so the set's calibrated internal ratios are kept. */
    if (SUNNY && SUN_ALB[name] !== undefined) {
      var ks = SUN_ALB[name];
      for (q = 0; q < alb.length; q++) alb[q] *= ks;
    }
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
     SECTION 4 -- the four material sets.
     Every tile is authored as metres * 3.5 (ENV-PLAYBOOK 3.6). nz-env's
     `street` row says tile 10.0 and its comment is not to be trusted; the
     road here is authored at a 3.0 m repeat and says so.
     ==================================================================== */
  var SETS = Object.create(null), BUILD = Object.create(null);
  function getSet(n) { return SETS[n] || (SETS[n] = BUILD[n]()); }

  /* =====================================================================
     MISSION 4 ONLY -- THE SUNNY-DAY EXPOSURE.
     Every albedo in section 8 was solved against the overcast dome the
     comments quote: "an up-facing white surface at 2.00".  nz-street-sky.js
     now gives level 4 a 2.45 directional at 44 degrees on top of a blue
     daylight dome, so an open carriageway receives better than twice the
     irradiance those numbers were fitted to.  Measured off _shots/pk0 with
     the sunny sky in place, the roadway came back at sRGB 152 against the
     brief's 95-120 window and the footway at 210, i.e. the whole ground
     plane was a stop and a half hot and the road/pavers SIGN had inverted
     back to what section 8 exists to correct.
     The fix is one scalar per SET, applied to the albedo buffer inside
     emitSet(), so every internal ratio the section calibrated -- chamfer to
     joint, chip to matrix, warm unit to cool unit -- survives untouched and
     only the exposure moves.  Nothing here runs unless NZ.level === 4.
     ================================================================== */
  var SUNNY = false;
  var SUN_ALB = { asphalt: 0.76, paver: 0.60, gconc: 0.56, iron: 0.86 };

  /* TILE_ROAD was 3.0 m. At 512 that is 5.9 mm a texel and at the tier every
     headless shot uses (256) it was 11.7 mm, which is what put the near field
     on the top mip. 2.0 m at a fixed 512 is 3.9 mm a texel -- 16 mm aggregate
     lands on 4.1 texels at every tier. The repeat count goes 8 -> 12 down the
     street and 1.5 -> 2.3 across it; the per-patch UV origin, the per-patch
     90 deg rotation, the world-space vertex macro and ~130 decals are what
     stop that reading as a repeat, and they were already there. */
  var TILE_ROAD = m(2.0);     /* 7.0  -- 12 repeats down the 24 m street      */
  var AGG_MM = 16;            /* exposed chip size, in real millimetres       */
  var TILE_PAVER = m(0.8);    /* 2.8  -- 4 x 200 mm blocks per repeat         */
  var TILE_CONC = m(0.6);     /* 2.1  -- kerbs at 1:1, cast slabs at 3:1      */
  var TILE_IRON = m(0.6);     /* 2.1  -- a 100 mm waffle on a manhole cover   */

  /* ---- worn patched asphalt --------------------------------------------- */
  /* AGGREGATE SIZE, and it is now stated in millimetres rather than in texels
     so it cannot drift when the tile or the resolution moves. 2.0 m / 512 =
     3.9 mm a texel; a worley at TILE_MM/AGG_MM cells puts one 16 mm chip
     across 4.1 texels, which is where the normal map is real relief rather
     than grey mush. Everything else in here is authored in cycles per tile,
     so the frequencies are all rescaled by 2/3 against the 3 m tile they were
     written for -- a number that reads as 90 mm has to stay 90 mm.
     WHY THE BIG SOFT FIELDS CAME DOWN. `broad` and `patch` were tinting +-26 %
     and +-30 % at 1.0 m and 0.6 m, and at 0.5 m from the eye those two are the
     ONLY thing left in frame: the near road measured as a field of soft grey
     blobs because that is literally what it was. They are halved and the
     aggregate, the fines and a new quartz-speck layer take the contrast back
     at a scale that survives being magnified. */
  BUILD.asphalt = function () {
    var res = RES.road, i;
    var tileMM = TILE_ROAD * METRES_PER_UNIT * 1000;          /* 2000 */
    var aggCells = clamp(Math.round(tileMM / AGG_MM), 24, Math.round(res / 3.6));
    var agg = worC(res, { cells: aggCells, seed: 4101, invert: true });
    var chipHi = worC(res, { cells: Math.round(aggCells * 1.9), seed: 4107, invert: true });
    var fine = fbmC(res, { octaves: 6, frequency: 23, seed: 4102 });
    var micro = fbmC(res, { octaves: 3, frequency: 74, seed: 4108 });
    var crack = fbmC(res, { octaves: 5, frequency: 5, seed: 4103, ridged: true });
    var patch = worC(res, { cells: 4, seed: 4104 });
    var lane = fieldStreak(res, 4105, 2, 6, false);
    var broad = fbmC(res, { octaves: 3, frequency: 2, seed: 4106 });

    /* CRACK WIDTH is the loudest tell a road material has. A ridged-fbm crest
       is only a hairline if it is thresholded HARD: at (crack-0.93)/0.07 the
       network came out ~40 mm wide and 90% opaque and the carriageway read as
       dried mud, which is exactly the failure nz-env.js:936-949 documents.
       Real shrinkage cracking in a worn wearing course is 2-6 mm, sparse, and
       grey-black rather than black because the crack is full of the same dust
       as everything else. Band 0.955->1, and the height gouge halved so it
       stops driving cavityAO() to its floor over the whole network. */
    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      var cr = clamp((crack[i] - 0.955) * 22, 0, 1);
      h[i] = clamp(0.5 + (agg[i] - 0.5) * 0.26 + (fine[i] - 0.5) * 0.20
        + (micro[i] - 0.5) * 0.13 - cr * 0.10, 0, 1);
    }
    /* Base [80,80,83]. Calibration: the sky module publishes an up-facing
       white surface at 2.00, and a 0.65-albedo render with a 0.41 bake lands
       at 204/255, i.e. out_linear ~ 2.26 * albedo_linear * bake. An open
       roadway bakes ~0.95, so 80/255 -> 113/255 in frame, inside the brief's
       95-120 window with room for the patch tones either side. */
    /* THE MATRIX HAS TO WIN. First cut of this rebuild put the chip tint at
       0.34 and a quartz highlight at 0.30 over the top decile, and the near
       road came back off the framebuffer at mean 132 reading as pale chip
       seal -- exposed aggregate with no bitumen between it. Worn asphalt is
       mostly matrix: the chips are visible but they are the same grey as
       everything else, only a little paler, and the pockets between them are
       nearly black. Chip tint down to 0.30, the sparkle to 0.20 over the top
       10 %, and the pocket darkening up to 0.44 over the bottom 30 %. */
    var a = albNew(res, [62, 62, 65]);
    albMul(a, fine, 0, 1, 0.80, 1.20);
    albMul(a, micro, 0, 1, 0.90, 1.10);                    /* fines and grit   */
    albTint(a, agg, [98, 97, 93], 0.30, 0.55, 1);          /* exposed chip     */
    albTint(a, chipHi, [118, 116, 110], 0.20, 0.90, 1);    /* quartz sparkle   */
    albTint(a, agg, [32, 32, 35], 0.44, 0.30, 0);          /* bitumen pocket   */
    albTint(a, patch, [52, 52, 56], 0.20, 0.70, 1);        /* old tar bleed    */
    albTint(a, crack, [44, 43, 46], 0.20, 0.955, 1);       /* hairline, 4 mm   */
    albTint(a, lane, [90, 89, 88], 0.16, 0.58, 1);         /* polished wheel   */
    albTint(a, broad, [56, 55, 56], 0.13, 0.55, 1);

    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) {
      rough[i] = clamp(0.92 + (fine[i] - 0.5) * 0.12 + (micro[i] - 0.5) * 0.10 - lane[i] * 0.20
        - clamp((patch[i] - 0.72) * 3, 0, 1) * 0.12, 0.54, 1);
    }
    /* aoStrength 0.70, not 1.0: the dark ring cavityAO() puts round every
       chip is what turned 40 mm aggregate into a web at 3 texels a cell. */
    return emitSet(res, a, h, rough, null, 0.70, { mm: 1.3, tile: TILE_ROAD, hp: 90, rough: 0.18 }, 'asphalt');
  };

  /* ---- interlocking concrete pavers ("kilit tasi") ----------------------- */
  /* THE ARRIS IS BRIGHT, NOT DARK, and that is the whole tell (ENV-PLAYBOOK
     2.4.8). A paver has a 3 mm chamfer that catches the sky; only the joint
     CENTRE is dark. Two thresholds off the same distance field.

     THE SIGN WAS INVERTED, which is the defect this rebuild exists for.
     Measured out of the framebuffer, pavers / road was 1.12; ref1 measures
     0.69 (pavers lum 95.2 against road 138.0) and ref3 0.64 (93.2 / 146.0).
     Worn grey concrete really is DARKER than the asphalt beside it, because
     the asphalt is damp, has a specular sheen and a tyre-polished centre and
     the concrete has none of the three. The whole palette below is the old
     one scaled by 0.58 -- rendered output is very close to linear in the
     sRGB texture value here, so 0.58 of the swatch is 0.58 of the frame.

     AND IT WAS ACHROMATIC: saturation 0.014 measured, which is a grey plane
     with lines on it, not paving. The palette now runs warm grey (r > b by
     20-25 %) to cool grey (b > r by 12 %) block to block with two red-brown
     units, two pale replacements and two dark sunken ones, and every unit
     takes its own settle in the height field so the sunken ones read as
     sunken and not merely as darker. */
  BUILD.paver = function () {
    var res = RES.hi, i;
    var bond = fieldBond(res, 5, 4, Math.max(2, res / 90), 4201, true);  /* 160 x 200 mm */
    var grain = fbmC(res, { octaves: 5, frequency: 22, seed: 4202 });
    var traffic = worC(res, { cells: 4, seed: 4203 });
    var chip = worC(res, { cells: 26, seed: 4204, invert: true });
    var moss = fbmC(res, { octaves: 4, frequency: 7, seed: 4205 });
    var pore = fbmC(res, { octaves: 3, frequency: 60, seed: 4206 });

    var h = fnew(res), arr = fnew(res), jnt = fnew(res);
    for (i = 0; i < h.length; i++) {
      var e = clamp(1 - bond.m[i], 0, 1);
      var ar = clamp((e - 0.15) / 0.45, 0, 1) * (1 - clamp((e - 0.60) / 0.40, 0, 1));
      var jj = clamp((e - 0.70) / 0.30, 0, 1);
      arr[i] = ar; jnt[i] = jj;
      /* per-unit settle: +-3 mm of lay tolerance, so some blocks stand a
         hair proud and some have sunk under a wheel */
      var st = (bond.id[i] - 0.5) * 0.16 * clamp(bond.m[i], 0, 1);
      h[i] = clamp(0.68 - e * 0.56 + st + (grain[i] - 0.5) * 0.10 + (pore[i] - 0.5) * 0.07
        - clamp((chip[i] - 0.80) * 4, 0, 1) * 0.10, 0, 1);
    }
    /* THE PALETTE IS WARM-DOMINANT, not warm-and-cool-in-equal-parts. `ref1`
       measures its paver run at rgb 101, 96, 75 -- blue is 0.74 of red -- and
       `ref3` at 99, 93, 78. A grey concrete block that has spent 25 years in
       Konya dust is a buff, and only a minority of them (the newer, wetter,
       shaded ones) read cool. Eleven warm/neutral, two cool, two red-brown,
       two pale replacements, two dark sunken. Mean lands at [66,60,53], which
       is the same luminance as the neutral set it replaces and 0.20 of
       saturation instead of 0.09. */
    /* AND IT HAS TO BE OVER-WARM IN THE TEXTURE TO READ WARM IN THE FRAME.
       The dome this street is lit by is blue: NZ.street.SKY publishes zenith
       [0.94,1.25,1.71] against horizon [2.52,2.55,2.60], so the light landing
       on an up-facing surface has blue about 1.22x red. Measured, a paver
       swatch authored at blue/red 0.80 came back off the framebuffer at 0.98
       -- dead neutral. Authored at 0.70 it lands near 0.85, which is where
       `ref1` (0.74) and `ref3` (0.79) sit. This is the same reason the
       neutral asphalt renders visibly cool. */
    /* ONE red block in sixteen, and it is a faded oxide, not a terracotta.
       The first cut ran two saturated reds and two strong blues out of
       sixteen, and because the bond is 5 x 4 units on a 0.8 m tile that motif
       repeats every 0.8 m -- at 2 m the footway read as a decorative
       multicoloured brick pattern with a visible rhythm, which is a different
       failure from the one being fixed. The spread that survives is the one
       the eye reads as "these blocks came from four different batches", and
       the world-space warm/cool drift in buildWalk() carries the variation
       that has to be bigger than the tile. */
    /* AMENDMENT 2 RE-CALIBRATION, and it is an albedo move, not a light one.
       The whole palette below is the calibrated one multiplied by 1.20, which
       leaves every internal ratio -- chamfer to joint, warm unit to cool unit,
       replacement to sunken -- exactly where it was measured. The reason is
       the re-carve: the canyon went from 32 to 40 units wide, the roadway from
       4.57 m to 6.86 m, and the crown of the road now sees appreciably more of
       the sky dome while the footway is still hard against a facade. Measured
       off the framebuffer on a nadir grab at (224, 24, 172), pavers/road came
       back 0.582 against the 0.64-0.70 reference band (ref1 0.69, ref3 0.64):
       the ratio did not drift because anything here changed, it drifted
       because the denominator did. Raising the numerator's albedo is the fix
       the sky module's calibration note prescribes. */
    var a = albNew(res, [79, 70, 55]);
    albUnits(a, bond.id, bond.m, [
      [96, 83, 62], [70, 72, 76], [86, 74, 55], [73, 74, 78],
      [103, 89, 65], [79, 74, 66], [80, 70, 52], [70, 74, 58],
      [110, 101, 84], [60, 54, 44], [90, 77, 58], [72, 70, 66],
      [94, 62, 50], [55, 50, 43], [84, 74, 60], [100, 94, 82]
    ], 0.94);
    albMul(a, grain, 0, 1, 0.88, 1.10);
    albMul(a, pore, 0, 1, 0.94, 1.06);
    albTint(a, arr, [115, 103, 82], 0.40, 0, 1);           /* sky on the chamfer */
    albTint(a, jnt, [50, 44, 34], 0.85, 0, 1);             /* jointing sand      */
    albTint(a, moss, [49, 58, 37], 0.30, 0.70, 1);         /* algae in the joint */
    albTint(a, traffic, [67, 61, 52], 0.20, 0.62, 1);      /* the walking line   */

    var rough = fnew(res);
    for (i = 0; i < rough.length; i++)
      rough[i] = clamp(0.88 + (grain[i] - 0.5) * 0.16 - traffic[i] * 0.10 + jnt[i] * 0.10, 0.40, 1);
    return emitSet(res, a, h, rough, null, 1.10, { mm: 2.4, tile: TILE_PAVER, hp: 0, rough: 0.16 }, 'paver');
  };

  /* ---- precast / cast concrete: kerbs and plain footway ------------------ */
  /* No bond field. The kerb's 1 m joints and the footway's expansion joints
     are both GEOMETRY here, so a joint baked into the map would double them
     and land at the wrong pitch on whichever of the two it was not authored
     for. This is a float-finished pour: grain, aggregate pop, patch repairs,
     hairline shrinkage, weather stain. */
  BUILD.gconc = function () {
    var res = RES.hi, i;
    var grain = fbmC(res, { octaves: 6, frequency: 30, seed: 4301 });
    var agg = worC(res, { cells: 40, seed: 4302, invert: true });
    var pat = worC(res, { cells: 5, seed: 4303 });
    var hair = fbmC(res, { octaves: 5, frequency: 18, seed: 4304, ridged: true });
    var stain = fieldStreak(res, 4305, 5, 10, false);

    var h = fnew(res);
    for (i = 0; i < h.length; i++) {
      var cr = clamp((hair[i] - 0.94) * 16, 0, 1);
      h[i] = clamp(0.52 + (grain[i] - 0.5) * 0.30 + clamp((agg[i] - 0.74) * 3, 0, 1) * 0.16 - cr * 0.18, 0, 1);
    }
    /* Scaled to 0.70 of the swatch it was, for the same reason the pavers
       were: this is the other half of the footway, and a cast-concrete run
       that stayed at lum 126 while the interlocking run went to 66 would put
       the inverted tonal relationship straight back on every third stretch.
       0.70 rather than the pavers' 0.58 because a float-finished pour really
       is cleaner and paler than 25-year-old kilit tasi -- and the kerb, which
       shares this set, carries its own +10 % on top (section 9). */
    /* x 1.14 for AMENDMENT 2, same argument as the pavers and the same
       preservation of every internal ratio. Less than the pavers' 1.20 because
       the kerb run measured 0.72 of the road against ref1's ~0.90 while the
       paver run measured 0.58 against 0.64-0.70 -- the concrete family had
       drifted, but not by as much. */
    var a = albNew(res, [80, 79, 74]);
    albMul(a, grain, 0, 1, 0.84, 1.14);
    albTint(a, agg, [93, 91, 87], 0.24, 0.70, 1);
    albTint(a, pat, [75, 74, 71], 0.30, 0.66, 1);
    albTint(a, hair, [59, 58, 56], 0.36, 0.935, 1);
    albTint(a, stain, [67, 65, 59], 0.28, 0.58, 1);

    var rough = fnew(res);
    for (i = 0; i < rough.length; i++) rough[i] = clamp(0.84 + (grain[i] - 0.5) * 0.18, 0.34, 1);
    return emitSet(res, a, h, rough, null, 0.95, { mm: 0.9, tile: TILE_CONC, hp: 170, rough: 0.18 }, 'gconc');
  };

  /* ---- cast iron: manhole covers, gully gratings, valve boxes ------------ */
  /* The waffle is a 6 x 6 square grid on a 0.6 m tile -- 100 mm cast squares,
     which is the pattern on every municipal cover in Anatolia. It tiles, so a
     disc cut out of it reads correctly without a fitted UV. */
  BUILD.iron = function () {
    var res = RES.md, i;
    var waf = fieldBond(res, 6, 6, Math.max(2, res / 26), 4402, false);
    var grain = fbmC(res, { octaves: 5, frequency: 26, seed: 4401 });
    var rust = fbmC(res, { octaves: 5, frequency: 9, seed: 4403 });
    var pit = worC(res, { cells: 30, seed: 4404, invert: true });

    var h = fnew(res), mt = fnew(res), rough = fnew(res);
    var a = albNew(res, [74, 72, 69]);
    for (i = 0; i < h.length; i++) {
      h[i] = clamp(0.32 + waf.m[i] * 0.46 + (grain[i] - 0.5) * 0.12 - clamp((pit[i] - 0.8) * 4, 0, 1) * 0.10, 0, 1);
      var rz = clamp((rust[i] - 0.52) * 2.4, 0, 1);
      mt[i] = clamp(0.62 - rz * 0.52, 0, 1);
      rough[i] = clamp(0.62 + rz * 0.28 + (grain[i] - 0.5) * 0.14, 0.24, 1);
    }
    albMul(a, grain, 0, 1, 0.82, 1.16);
    albTint(a, waf.m, [46, 45, 43], 0.55, 0.35, 0);        /* the recessed grid */
    albTint(a, rust, [112, 70, 44], 0.42, 0.56, 1);
    albTint(a, pit, [58, 56, 54], 0.30, 0.72, 1);
    return emitSet(res, a, h, rough, mt, 1.00, { mm: 3.0, tile: TILE_IRON, hp: 0, rough: 0.10 }, 'iron');
  };

  /* ---- material factory -------------------------------------------------- */
  /* Every material goes through NZ.street.day(). Do NOT set .name afterwards:
     the 'nzday:' prefix is what keeps this geometry out of nz-render's
     neutralizeBakedLighting(), which is tuned for the night bake and would
     compress the only shading cue the street has. */
  function groundMaterial(setName, usedTile, opts) {
    opts = opts || {};
    var set = getSet(setName);
    var nsc = fin(opts.nrm, 1.0) * (set.refTile > 0 && usedTile > 0 ? set.refTile / usedTile : 1);
    var mat = new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap,
      roughnessMap: set.ormMap, metalnessMap: set.ormMap, aoMap: set.ormMap,
      color: new THREE.Color(fin(opts.tint, 0xffffff)),
      roughness: 1.0, metalness: opts.metal === undefined ? 1.0 : opts.metal,
      vertexColors: true, dithering: true, fog: true,
      side: THREE.FrontSide
    });
    mat.normalScale = new THREE.Vector2(nsc, nsc);
    mat.aoMapIntensity = fin(opts.ao, 1.0);
    /* every surface in here sits 0.05-0.10 u above a world quad the game
       already drew; the offset is belt to that brace */
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;
    stDay(mat, { name: 'ground-' + setName, intensity: fin(opts.env, 1.0), spec: opts.spec });
    OWN.mat.push(mat);
    return mat;
  }

  /* =======================================================================
     SECTION 5 -- Pile: the hand-written merge (ENV-PLAYBOOK 6.1).
     r149 has no BufferGeometryUtils and this module is not allowed to import
     one. Every surface this file makes lands in one of six piles and each
     pile becomes exactly one draw call.

     The difference from nz-env's Pile: there is no baked vertex colour and no
     nzFC attribute, because this module does not use nz-env's night-light
     bake or its onBeforeCompile. Instead each vertex carries a TONE triple,
     and after NZ.street.bake() has written the achromatic overcast solution
     into `color`, applyTone() multiplies the two together. That is where the
     patch generations, the polished centre strip, the gutter grime, the
     under-car darkening and the world-space macro break-up all live.
     ==================================================================== */
  function Pile(tile) {
    this.p = []; this.nm = []; this.uv = []; this.t = []; this.idx = [];
    this.n = 0;
    this.tile = tile || 4;
    this.inv = 1 / (tile || 4);
  }
  Pile.prototype.context = function (tile) { this.tile = tile; this.inv = 1 / (tile || 4); return this; };
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

  /* the overcast bake writes `color`; this folds the authored tone into it */
  function applyTone(geo, pile) {
    var c = geo.attributes && geo.attributes.color;
    if (!c || !pile) return geo;
    var a = c.array, t = pile.t, n = Math.min(a.length, t.length), i;
    for (i = 0; i < n; i++) { var v = a[i] * t[i]; a[i] = isFinite(v) ? v : 0.4; }
    c.needsUpdate = true;
    return geo;
  }

  /* world-space macro break-up. Two octaves at 19 u and 6.7 u, the same
     architectural scale nz-env's shader macro uses, but paid for in vertex
     colours instead of a program permutation. This is the single cheapest
     thing that stops 8 repeats of a 3 m asphalt tile reading as 8 repeats. */
  var MACRO_AMT = 0.15;
  function macro(x, z) {
    var n = vnoise(x / 19.0, z / 19.0) * 0.64 + vnoise(x / 6.7 + 31.4, z / 6.7 - 12.1) * 0.36;
    return 1 + (n - 0.5) * MACRO_AMT;
  }

  /* --- the only vertex emitter for solid surfaces (ENV-PLAYBOOK 6.2) ------
     `pts` in world order, `ref` a point demonstrably inside the solid so the
     winding cannot come out backwards, `tone` an [r,g,b] multiplier. */
  function poly(pile, pts, rx, ry, rz, tone, uvFn) {
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
    var t = pile.inv;
    var tr = tone ? tone[0] : 1, tg = tone ? tone[1] : 1, tb = tone ? tone[2] : 1;
    var base = pile.n, k;
    for (i = 0; i < n; i++) {
      var p = pts[i], u, v;
      if (uvFn) { var uvp = uvFn(p); u = uvp[0]; v = uvp[1]; }
      else if (mode === 1) { u = p[0] * t; v = p[2] * t; }
      else if (mode === 0) { u = p[2] * t; v = p[1] * t; }
      else { u = p[0] * t; v = p[1] * t; }
      var mk = macro(p[0], p[2]);
      pile.vert(p[0], p[1], p[2], nx, ny, nz, u, v, tr * mk, tg * mk, tb * mk);
    }
    for (k = 1; k < n - 1; k++) {
      if (flip) pile.tri(base, base + k + 1, base + k);
      else pile.tri(base, base + k, base + k + 1);
    }
  }

  /* --- a tessellated horizontal patch -------------------------------------
     xs/zs are explicit sample positions, so the tessellation can be dense
     where the bake gradient matters (against the kerb, against the wall) and
     sparse in the middle of the road. yFn(x,z) is the surface, toneFn(x,z)
     the authored tone, and `uv` maps world -> texture with the patch's own
     origin and optional 90 deg rotation. */
  function surface(pile, xs, zs, yFn, nFn, toneFn, uo, vo, rot) {
    var inv = pile.inv, ix, iz;
    var W = xs.length, H = zs.length;
    if (W < 2 || H < 2) return;
    var base = pile.n, nn = [0, 1, 0];
    for (iz = 0; iz < H; iz++) {
      for (ix = 0; ix < W; ix++) {
        var x = xs[ix], z = zs[iz], y = yFn(x, z);
        nFn(x, z, nn);
        var u, v;
        if (rot) { u = (z + vo) * inv; v = -(x + uo) * inv; }
        else { u = (x + uo) * inv; v = (z + vo) * inv; }
        var tn = toneFn(x, z), mk = macro(x, z);
        pile.vert(x, y, z, nn[0], nn[1], nn[2], u, v, tn[0] * mk, tn[1] * mk, tn[2] * mk);
      }
    }
    for (iz = 0; iz < H - 1; iz++) {
      for (ix = 0; ix < W - 1; ix++) {
        var a = base + iz * W + ix, b = a + 1, c = a + W, d = c + 1;
        pile.tri(a, c, b); pile.tri(b, c, d);
      }
    }
  }

  /* sample positions across a span, denser at the ends where the sky-dome
     bake changes fastest (a wall or a kerb is right there) */
  function spanX(a, b, step) {
    var out = [a], x = a, n = Math.max(1, Math.ceil((b - a) / step));
    for (var i = 1; i <= n; i++) out.push(a + (b - a) * i / n);
    out[out.length - 1] = b;
    return out;
  }
  function spanEdged(a, b, step, edge) {
    var mid = spanX(a + edge, b - edge, step), out = [a], i;
    if (b - a <= edge * 2.5) return spanX(a, b, step);
    out.push(a + edge * 0.42);
    for (i = 0; i < mid.length; i++) out.push(mid[i]);
    out.push(b - edge * 0.42);
    out.push(b);
    return out;
  }

  /* --- a plain axis-aligned box, five faces (no bottom) ------------------- */
  function boxTop(pile, x0, x1, y0, y1, z0, z1, tone) {
    var cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
    poly(pile, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, tone);
    poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], cx, cy, cz, tone);
    poly(pile, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], cx, cy, cz, tone);
    poly(pile, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], cx, cy, cz, tone);
    poly(pile, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], cx, cy, cz, tone);
  }

  /* --- a flat n-gon disc, for manhole and valve covers -------------------- */
  function disc(pile, cx, cy, cz, r, seg, tone, rimH) {
    var i, ring = [], inner = [];
    for (i = 0; i < seg; i++) {
      var a = i / seg * TAU;
      ring.push([cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r]);
      inner.push([cx + Math.cos(a) * (r - 0.10), cy + (rimH || 0), cz + Math.sin(a) * (r - 0.10)]);
    }
    poly(pile, inner, cx, cy - 1, cz, tone);
    for (i = 0; i < seg; i++) {
      var j = (i + 1) % seg;
      poly(pile, [ring[i], ring[j], inner[j], inner[i]], cx, cy - 1, cz, tone);
    }
    /* the skirt down to the road, so the cover is not a sticker at eye level */
    for (i = 0; i < seg; i++) {
      var k = (i + 1) % seg;
      poly(pile, [
        [ring[i][0], cy - 0.16, ring[i][2]], [ring[k][0], cy - 0.16, ring[k][2]],
        ring[k], ring[i]
      ], cx, cy - 1, cz, tone);
    }
  }

  /* =======================================================================
     SECTION 6 -- the decal atlas.
     4 x 4 tiles at 512 (128 px per tile). The atlas is one texture and one
     megabyte at every tier including low, deliberately: these tiles carry the
     largest-scale story on the ground -- the tar seams and the patch edges --
     and they are what a player standing on the kerb is actually looking at.
     The material sets underneath drop to 256 at low instead.
     ==================================================================== */
  var ATLAS = { tex: null, rect: [], res: 512, n: 4 };
  var D_TARSEAM = 0, D_PATCHEDGE = 1, D_PATCH = 2, D_OIL = 3,
      D_CARAO = 4, D_SCUFF = 5, D_CRACK = 6, D_MANCRACK = 7,
      D_GRIT = 8, D_LEAF = 9, D_SPLASH = 10, D_STREAK = 11,
      D_DAMP = 12, D_MOSS = 13, D_SPALL = 14, D_SMEAR = 15;

  function buildAtlas() {
    var res = ATLAS.res, N = ATLAS.n, ts = res / N;
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    var R = NZ.tex.mulberry32(SEED + 991);
    g.clearRect(0, 0, res, res);

    function cell(i) { return [(i % N) * ts, Math.floor(i / N) * ts]; }
    function push(i) {
      var o = cell(i), pad = ts * 0.014;
      ATLAS.rect[i] = [(o[0] + pad) / res, 1 - (o[1] + ts - pad) / res,
                       (o[0] + ts - pad) / res, 1 - (o[1] + pad) / res];
    }
    function vgrad(x, y, w, hh, col, a0, a1) {
      var gr = g.createLinearGradient(x, y, x, y + hh);
      gr.addColorStop(0, 'rgba(' + col + ',' + a0 + ')');
      gr.addColorStop(1, 'rgba(' + col + ',' + a1 + ')');
      g.fillStyle = gr; g.fillRect(x, y, w, hh);
    }
    function blob(x, y, r, col, a) {
      var gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(' + col + ',' + a + ')');
      gr.addColorStop(0.55, 'rgba(' + col + ',' + (a * 0.55) + ')');
      gr.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    function ragged(x0, y0, x1, y1, amp, steps) {
      g.beginPath();
      var i, t, px, py;
      for (i = 0; i <= steps; i++) {
        t = i / steps; px = x0 + (x1 - x0) * t; py = y0 + (y1 - y0) * t;
        px += (R() - 0.5) * amp; py += (R() - 0.5) * amp;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    function branch(x, y, ang, len, w, depth) {
      if (depth <= 0 || len < 2) return;
      var x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
      g.lineWidth = w; g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo((x + x2) * 0.5 + (R() - 0.5) * len * 0.3,
                         (y + y2) * 0.5 + (R() - 0.5) * len * 0.3, x2, y2);
      g.stroke();
      branch(x2, y2, ang + (R() - 0.5) * 1.1, len * (0.52 + R() * 0.3), w * 0.7, depth - 1);
      if (R() < 0.62) branch(x2, y2, ang + (R() - 0.5) * 1.9, len * (0.4 + R() * 0.3), w * 0.6, depth - 1);
    }
    var o, i, j, k, x, y;

    /* 0 -- tar seam. A crack that has been over-banded with hot bitumen: a
       wobbly 60-100 mm black band with a wider, duller bleed either side. */
    /* The BAND MUST FILL THE TILE. First cut drew it at 8.5% of the tile
       width; placed as a 0.25 u quad that is a 20 mm line, and the seams were
       invisible in street.westend at 40 m. The quad is sized to the seam, so
       the tile has to be sized to the quad. */
    o = cell(D_TARSEAM);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.strokeStyle = 'rgba(58,56,58,0.20)'; g.lineCap = 'butt';
    g.lineWidth = ts * 0.98;
    ragged(o[0] + ts * 0.5, o[1] - 2, o[0] + ts * 0.5, o[1] + ts + 2, ts * 0.10, 9);
    g.strokeStyle = 'rgba(34,33,35,0.66)'; g.lineWidth = ts * 0.58;
    ragged(o[0] + ts * 0.5, o[1] - 2, o[0] + ts * 0.5, o[1] + ts + 2, ts * 0.16, 11);
    g.strokeStyle = 'rgba(24,23,25,0.52)'; g.lineWidth = ts * 0.26;
    ragged(o[0] + ts * 0.48, o[1] - 2, o[0] + ts * 0.54, o[1] + ts + 2, ts * 0.22, 8);
    /* the aggregate that was broadcast onto the hot bitumen so it is not slick */
    for (i = 0; i < 120; i++)
      blob(o[0] + ts * (0.12 + R() * 0.76), o[1] + R() * ts, ts * 0.022, '132,130,126', 0.30);
    g.restore(); push(D_TARSEAM);

    /* 1 -- patch edge: the ragged sealed lip round a trench reinstatement */
    /* seam() rotates the quad 90 deg so the tile's V runs ALONG the seam and
       its U runs across it. The lip therefore has to be a HORIZONTAL gradient
       with a vertical ragged edge -- the first cut had both the other way up
       and drew a fade down the length of the seam instead of across it. */
    o = cell(D_PATCHEDGE);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    var gh = g.createLinearGradient(o[0], 0, o[0] + ts, 0);
    gh.addColorStop(0.00, 'rgba(34,33,35,0.04)');
    gh.addColorStop(0.34, 'rgba(34,33,35,0.42)');
    gh.addColorStop(0.56, 'rgba(34,33,35,0.34)');
    gh.addColorStop(1.00, 'rgba(34,33,35,0.02)');
    g.fillStyle = gh; g.fillRect(o[0], o[1], ts, ts);
    g.strokeStyle = 'rgba(22,21,23,0.50)'; g.lineWidth = ts * 0.08;
    ragged(o[0] + ts * 0.44, o[1] - 2, o[0] + ts * 0.44, o[1] + ts + 2, ts * 0.16, 14);
    for (i = 0; i < 40; i++) blob(o[0] + ts * (0.2 + R() * 0.6), o[1] + R() * ts, ts * 0.05, '18,18,20', 0.16);
    g.restore(); push(D_PATCHEDGE);

    /* 2 -- a fresh trench reinstatement: darker, smoother, ragged outline */
    o = cell(D_PATCH);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.fillStyle = 'rgba(52,51,54,0.42)';
    g.beginPath();
    for (i = 0; i <= 40; i++) {
      var a2 = i / 40 * TAU;
      var rr = ts * 0.44 * (1 + (R() - 0.5) * 0.10);
      var ex = Math.abs(Math.cos(a2)), ez = Math.abs(Math.sin(a2));
      var sq = 1 / Math.max(ex, ez, 0.0001);
      rr *= Math.min(sq, 1.42);
      var px2 = o[0] + ts * 0.5 + Math.cos(a2) * rr, py2 = o[1] + ts * 0.5 + Math.sin(a2) * rr;
      if (i === 0) g.moveTo(px2, py2); else g.lineTo(px2, py2);
    }
    g.closePath(); g.fill();
    for (i = 0; i < 90; i++) blob(o[0] + ts * 0.1 + R() * ts * 0.8, o[1] + ts * 0.1 + R() * ts * 0.8, ts * 0.05, '70,69,72', 0.22);
    g.strokeStyle = 'rgba(26,25,27,0.42)'; g.lineWidth = ts * 0.035;
    g.stroke();
    g.restore(); push(D_PATCH);

    /* 3 -- oil stain: the drip patch under a 25-year-old Sahin */
    o = cell(D_OIL);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    blob(o[0] + ts * 0.5, o[1] + ts * 0.52, ts * 0.44, '26,24,22', 0.36);
    for (i = 0; i < 14; i++)
      blob(o[0] + ts * (0.28 + R() * 0.44), o[1] + ts * (0.28 + R() * 0.46), ts * (0.05 + R() * 0.10), '18,17,16', 0.30);
    for (i = 0; i < 22; i++)
      blob(o[0] + ts * (0.1 + R() * 0.8), o[1] + ts * (0.1 + R() * 0.8), ts * 0.022, '18,17,16', 0.26);
    g.restore(); push(D_OIL);

    /* 4 -- the ROAD FILM under a car, no longer a contact shadow. The sky
       module's bake now replays occluders registered after a geometry was
       baked, so PROPS' car bodies put a real, correctly shaped ambient
       shadow on this road without anybody drawing one. What is left here is
       the thing a bake cannot know: the tarmac under a car is dry, greasy and
       never rained on, so it is a shade darker and much duller than the road
       around it. Alpha down from 0.42/0.26/0.07 to 0.15/0.09/0.03 -- about a
       third of the old decal, which is film rather than shadow. */
    o = cell(D_CARAO);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    var gr2 = g.createRadialGradient(o[0] + ts * 0.5, o[1] + ts * 0.5, ts * 0.06,
                                     o[0] + ts * 0.5, o[1] + ts * 0.5, ts * 0.52);
    gr2.addColorStop(0, 'rgba(18,17,16,0.15)');
    gr2.addColorStop(0.52, 'rgba(18,17,16,0.09)');
    gr2.addColorStop(0.82, 'rgba(18,17,16,0.03)');
    gr2.addColorStop(1, 'rgba(16,15,14,0)');
    g.fillStyle = gr2; g.fillRect(o[0], o[1], ts, ts);
    g.restore(); push(D_CARAO);

    /* 5 -- tyre scuff: rubber laid on the kerb face and the road beside it */
    o = cell(D_SCUFF);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.strokeStyle = 'rgba(34,33,34,0.34)'; g.lineCap = 'round';
    for (i = 0; i < 5; i++) {
      g.lineWidth = ts * (0.04 + R() * 0.05);
      g.beginPath();
      var sy = o[1] + ts * (0.2 + i * 0.15 + R() * 0.05);
      g.moveTo(o[0] - 2, sy);
      g.quadraticCurveTo(o[0] + ts * 0.5, sy + ts * (R() - 0.5) * 0.5, o[0] + ts + 2, sy + ts * (R() - 0.5) * 0.2);
      g.stroke();
    }
    g.restore(); push(D_SCUFF);

    /* 6 -- shrinkage crack network */
    o = cell(D_CRACK);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.strokeStyle = 'rgba(44,43,45,0.46)'; g.lineCap = 'round';
    for (i = 0; i < 3; i++)
      branch(o[0] + ts * (0.2 + R() * 0.6), o[1] + ts * (0.2 + R() * 0.6), R() * TAU, ts * 0.30, ts * 0.022, 4);
    g.restore(); push(D_CRACK);

    /* 7 -- the cracking that radiates from a manhole frame */
    o = cell(D_MANCRACK);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.strokeStyle = 'rgba(44,43,45,0.40)'; g.lineCap = 'round';
    for (i = 0; i < 9; i++) {
      var ang = i / 9 * TAU + R() * 0.3;
      branch(o[0] + ts * 0.5 + Math.cos(ang) * ts * 0.17,
             o[1] + ts * 0.5 + Math.sin(ang) * ts * 0.17, ang, ts * 0.24, ts * 0.020, 3);
    }
    blob(o[0] + ts * 0.5, o[1] + ts * 0.5, ts * 0.26, '52,50,50', 0.14);
    g.restore(); push(D_MANCRACK);

    /* 8 -- gutter silt: fine grit and road film washed to the kerb line */
    o = cell(D_GRIT);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    vgrad(o[0], o[1], ts, ts, '98,92,78', 0.22, 0.0);
    for (i = 0; i < 420; i++) {
      x = o[0] + R() * ts; y = o[1] + R() * ts * (0.15 + R() * 0.75);
      g.fillStyle = 'rgba(' + (78 + R() * 46 | 0) + ',' + (72 + R() * 42 | 0) + ',' + (60 + R() * 34 | 0) + ',' + (0.16 + R() * 0.26).toFixed(2) + ')';
      g.fillRect(x, y, 1 + R() * 1.6, 1 + R() * 1.4);
    }
    g.restore(); push(D_GRIT);

    /* 9 -- leaf litter, early spring: last year's leaves, no green */
    o = cell(D_LEAF);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    var LEAF = ['104,84,58', '86,68,46', '118,98,70', '72,60,44'];
    for (i = 0; i < 34; i++) {
      x = o[0] + R() * ts; y = o[1] + R() * ts;
      g.save(); g.translate(x, y); g.rotate(R() * TAU);
      g.fillStyle = 'rgba(' + LEAF[(R() * 4) | 0] + ',' + (0.5 + R() * 0.4).toFixed(2) + ')';
      g.beginPath(); g.ellipse(0, 0, ts * (0.020 + R() * 0.030), ts * (0.010 + R() * 0.014), 0, 0, TAU);
      g.fill(); g.restore();
    }
    g.restore(); push(D_LEAF);

    /* 10 -- ground-line splash soiling. FLAT ON THE PAVING, never on the wall
       (STREET-MODULE-CONTRACT section 5: FACADE owns the wall from y = 0 up). */
    o = cell(D_SPLASH);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    vgrad(o[0], o[1], ts, ts, '62,60,52', 0.30, 0.0);
    for (i = 0; i < 130; i++) {
      x = o[0] + R() * ts; y = o[1] + Math.pow(R(), 1.8) * ts * 0.8;
      blob(x, y, ts * (0.012 + R() * 0.035), '50,48,42', 0.17);
    }
    for (i = 0; i < 40; i++) blob(o[0] + R() * ts, o[1] + Math.pow(R(), 2.4) * ts * 0.6, ts * 0.02, '62,68,50', 0.14);
    g.restore(); push(D_SPLASH);

    /* 11 -- the stain a downpipe makes where it discharges onto the paving */
    o = cell(D_STREAK);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    vgrad(o[0] + ts * 0.36, o[1], ts * 0.28, ts * 0.72, '58,56,48', 0.36, 0.06);
    blob(o[0] + ts * 0.5, o[1] + ts * 0.70, ts * 0.28, '54,54,48', 0.26);
    for (i = 0; i < 30; i++) blob(o[0] + ts * (0.25 + R() * 0.5), o[1] + ts * (0.45 + R() * 0.45), ts * 0.03, '58,64,46', 0.16);
    g.restore(); push(D_STREAK);

    /* 12 -- damp. Damp, NOT wet: a low-alpha darkening, no mirror. */
    o = cell(D_DAMP);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    for (i = 0; i < 9; i++)
      blob(o[0] + ts * (0.2 + R() * 0.6), o[1] + ts * (0.2 + R() * 0.6), ts * (0.16 + R() * 0.24), '32,34,36', 0.17);
    g.restore(); push(D_DAMP);

    /* 13 -- moss / algae in the joints */
    o = cell(D_MOSS);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    for (i = 0; i < 16; i++)
      blob(o[0] + ts * (0.15 + R() * 0.7), o[1] + ts * (0.15 + R() * 0.7), ts * (0.06 + R() * 0.16), '56,68,44', 0.28);
    for (i = 0; i < 60; i++) {
      x = o[0] + R() * ts; y = o[1] + R() * ts;
      g.fillStyle = 'rgba(' + (46 + R() * 30 | 0) + ',' + (58 + R() * 30 | 0) + ',' + (36 + R() * 22 | 0) + ',0.5)';
      g.fillRect(x, y, 1.4, 1.4);
    }
    g.restore(); push(D_MOSS);

    /* 14 -- a spalled kerb corner: grey mortar showing through */
    o = cell(D_SPALL);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.fillStyle = 'rgba(104,101,95,0.62)';
    g.beginPath();
    for (i = 0; i <= 14; i++) {
      var aa = i / 14 * TAU, rr2 = ts * (0.20 + R() * 0.16);
      var xx = o[0] + ts * 0.5 + Math.cos(aa) * rr2, yy = o[1] + ts * 0.5 + Math.sin(aa) * rr2 * 0.8;
      if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
    }
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(68,66,63,0.55)'; g.lineWidth = ts * 0.02; g.stroke();
    for (i = 0; i < 40; i++) blob(o[0] + ts * (0.3 + R() * 0.4), o[1] + ts * (0.3 + R() * 0.4), ts * 0.03, '124,121,114', 0.30);
    g.restore(); push(D_SPALL);

    /* 15 -- generic road-film smear, the connective tissue */
    o = cell(D_SMEAR);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    for (i = 0; i < 12; i++)
      blob(o[0] + ts * (0.15 + R() * 0.7), o[1] + ts * (0.15 + R() * 0.7), ts * (0.12 + R() * 0.26), '66,64,60', 0.13);
    g.restore(); push(D_SMEAR);

    /* the aging pass (nz-env.js:2584-2592): +-13 luma of hash noise over the
       whole atlas so nothing reads as a crisp sticker. Do not skip it. */
    var id = g.getImageData(0, 0, res, res), d = id.data;
    for (i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 4) continue;
      var nq = (h1(i * 0.37) - 0.5) * 26;
      d[i] = clamp(d[i] + nq, 0, 255);
      d[i + 1] = clamp(d[i + 1] + nq, 0, 255);
      d[i + 2] = clamp(d[i + 2] + nq, 0, 255);
    }
    g.putImageData(id, 0, 0);

    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;    /* mandatory for an atlas */
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = ANISO;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    OWN.tex.push(t);
    STATS.texBytes += res * res * 4 * 1.34;
    ATLAS.tex = t;
    return t;
  }

  function decalMaterial(rough, name) {
    var mat = new THREE.MeshStandardMaterial({
      map: ATLAS.tex, transparent: true, opacity: 1, alphaTest: 0.02,
      roughness: rough, metalness: 0.0, vertexColors: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      fog: true, dithering: true, side: THREE.FrontSide
    });
    stDay(mat, { name: name, intensity: 0.55 });
    OWN.mat.push(mat);
    return mat;
  }

  /* flat quad with explicit atlas UVs. v = u x n (NOT n x u) -- on a face
     whose normal is +Y with u = +X that gives -Z, which is what puts a
     gradient tile's "top" toward the wall where it belongs. */
  function decal(pile, cx, cy, cz, nx, ny, nz, ux, uy, uz, hw, hh, rect, tone, flipV) {
    var vx = uy * nz - uz * ny, vy = uz * nx - ux * nz, vz = ux * ny - uy * nx;
    var pts = [
      [cx - ux * hw - vx * hh, cy - uy * hw - vy * hh, cz - uz * hw - vz * hh],
      [cx + ux * hw - vx * hh, cy + uy * hw - vy * hh, cz + uz * hw - vz * hh],
      [cx + ux * hw + vx * hh, cy + uy * hw + vy * hh, cz + uz * hw + vz * hh],
      [cx - ux * hw + vx * hh, cy - uy * hw + vy * hh, cz - uz * hw + vz * hh]
    ];
    var v0 = flipV ? rect[3] : rect[1], v1 = flipV ? rect[1] : rect[3];
    var uvs = [[rect[0], v0], [rect[2], v0], [rect[2], v1], [rect[0], v1]];
    var tr = tone ? tone[0] : 1, tg = tone ? tone[1] : 1, tb = tone ? tone[2] : 1;
    var base = pile.n, i;
    for (i = 0; i < 4; i++) {
      pile.vert(pts[i][0], pts[i][1], pts[i][2], nx, ny, nz, uvs[i][0], uvs[i][1], tr, tg, tb);
    }
    /* WINDING. v = u x n, so the GEOMETRIC normal of p0-p1-p2 is u x v = -n:
       wound the obvious way round these quads face AWAY from the surface they
       decorate and a FrontSide material culls every one of them. (nz-env's
       decalQuad has the same handedness; its wall decals survive because the
       supplied normal there points into the room.) Reverse the two triangles
       so the front face agrees with the shading normal. */
    pile.tri(base, base + 2, base + 1);
    pile.tri(base, base + 3, base + 2);
    STATS.decals++;
  }

  /* A ground decal, axis-aligned in XZ and rotated by `rot` radians.
     `yWorld` overrides the surface height; leave it undefined and the decal
     follows the camber on the roadway and the paving everywhere else. The
     0.035 lift plus polygonOffset -4/-8 plus depthWrite:false is what keeps
     300 of these off each other and off the surface underneath. */
  var DECAL_LIFT = 0.035;
  function surfaceY(x, z) {
    if (z >= RZ0 && z <= RZ1) return roadY(z);
    if (inThroat(x, z)) return throatY(x, z);
    return PAVE_Y;
  }
  /* Each CORNER takes its own surface height, not the centre's. The camber
     falls 0.07 u per unit of z at the kerb, so a 3-unit decal placed at one
     height would float 0.13 u at its far edge -- four times the lift -- and
     that is exactly the artefact a grazing-angle shot finds first. */
  function gdecal(pile, cx, cz, hw, hh, rot, tile, tone, yWorld, flipV) {
    var rect = ATLAS.rect[tile];
    if (!rect) return;
    var ux = Math.cos(rot), uz = Math.sin(rot), vx = -uz, vz = ux;
    var v0 = flipV ? rect[3] : rect[1], v1 = flipV ? rect[1] : rect[3];
    var uu = [rect[0], rect[2], rect[2], rect[0]], vv = [v0, v0, v1, v1];
    var sx = [-1, 1, 1, -1], sy = [-1, -1, 1, 1];
    var tr = tone ? tone[0] : 1, tg = tone ? tone[1] : 1, tb = tone ? tone[2] : 1;
    var base = pile.n, i;
    for (i = 0; i < 4; i++) {
      var px = cx + ux * hw * sx[i] + vx * hh * sy[i];
      var pz = cz + uz * hw * sx[i] + vz * hh * sy[i];
      var py = (yWorld === undefined ? surfaceY(px, pz) : yWorld) + DECAL_LIFT;
      pile.vert(px, py, pz, 0, 1, 0, uu[i], vv[i], tr, tg, tb);
    }
    pile.tri(base, base + 2, base + 1);          /* see the note in decal() */
    pile.tri(base, base + 3, base + 2);
    STATS.decals++;
  }

  /* =======================================================================
     SECTION 6b -- road paint.
     ref8 has exactly three painted things on it and all three are nearly gone:
     a direction arrow on the westbound approach, a surveyor's cross, and the
     ghost of a give-way line at the mouth of the side street. They cannot go
     in the grime atlas -- every tile there is a dark multiply and paint is the
     one thing on this ground that is PALER than the asphalt, and smoother, so
     it takes a different roughness and its own alpha.

     WORN IS THE WHOLE POINT. Fresh thermoplastic would be the most CG object
     on the street. Each mark is drawn at a filthy 196-grey, then eroded twice:
     once at the aggregate scale (the paint has been ground off the tops of the
     chips and survives only in the hollows) and once at the tyre-path scale
     (the middle of the lane is bare, the edges of the mark survive). What is
     left is a broken outline, which is what a fifteen-year-old arrow is.
     ==================================================================== */
  var PAINT = { tex: null, rect: [], mat: null, res: 512 };
  var P_ARROW = 0, P_CROSS = 1, P_BAR = 2, P_WEAR = 3;

  function buildPaintAtlas() {
    var res = TIER === 'low' ? 256 : 512, N = 2, ts = res / N;
    PAINT.res = res;
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    var R = NZ.tex.mulberry32(SEED + 4441);
    g.clearRect(0, 0, res, res);
    function cell(i) { return [(i % N) * ts, Math.floor(i / N) * ts]; }
    function push(i) {
      var o = cell(i), pad = ts * 0.006;
      PAINT.rect[i] = [(o[0] + pad) / res, 1 - (o[1] + ts - pad) / res,
                       (o[0] + ts - pad) / res, 1 - (o[1] + pad) / res];
    }
    /* the erosion pass. `chip` is the aggregate scale, `path` the wheel-track
       scale; both run in destination-out so they take alpha, not colour. */
    function erode(o, chipAmt, pathAmt) {
      var i, x, y, a, r;
      g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
      g.globalCompositeOperation = 'destination-out';
      /* CALIBRATE THE ERASER, not just the paint. First cut ran 26 wheel-path
         blobs of radius up to 0.22 of the tile at up to 0.95 alpha -- 1.4 tile
         areas of destination-out -- and the arrow came out of the framebuffer
         completely gone, which is not "worn", it is "absent". The chip pass
         does the work (it is what breaks the outline against the aggregate)
         and the path pass only thins the middle. */
      var nC = Math.round(900 * chipAmt);
      for (i = 0; i < nC; i++) {
        x = o[0] + R() * ts; y = o[1] + R() * ts;
        a = (0.10 + R() * 0.34);
        r = ts * (0.004 + R() * 0.012);
        g.fillStyle = 'rgba(0,0,0,' + a.toFixed(3) + ')';
        g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      var nP = Math.round(14 * pathAmt);
      for (i = 0; i < nP; i++) {
        x = o[0] + ts * (0.24 + R() * 0.52); y = o[1] + R() * ts;
        r = ts * (0.04 + R() * 0.11);
        var gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(0,0,0,' + (0.30 + R() * 0.45).toFixed(2) + ')');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      g.restore();
    }
    /* MEASURED OFF ref8, not off a paint chart. The marking there reads 169
       against asphalt at 154 -- 1.10x, and its window's sd is 19 where a crisp
       white shape gives 30. Road paint that has been on a Konya junction for
       fifteen years is a filthy pale grey with the aggregate showing through
       it, so the peak comes down and the erosion comes up until the arrow is a
       shape you notice rather than a shape you read. */
    var PW = '176,173,166';
    var o, i;

    /* 0 -- the direction arrow, drawn pointing at the TOP of its tile. The
       quad is 3.2 x 1.1 m, so the tile is stretched 2.9:1 along its length and
       the head is authored 0.30 of the tile deep to come out 1.2 m long. */
    o = cell(P_ARROW);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.fillStyle = 'rgba(' + PW + ',0.86)';
    g.beginPath();
    g.moveTo(o[0] + ts * 0.50, o[1] + ts * 0.030);
    g.lineTo(o[0] + ts * 0.955, o[1] + ts * 0.335);
    g.lineTo(o[0] + ts * 0.665, o[1] + ts * 0.335);
    g.lineTo(o[0] + ts * 0.665, o[1] + ts * 0.985);
    g.lineTo(o[0] + ts * 0.335, o[1] + ts * 0.985);
    g.lineTo(o[0] + ts * 0.335, o[1] + ts * 0.335);
    g.lineTo(o[0] + ts * 0.045, o[1] + ts * 0.335);
    g.closePath(); g.fill();
    /* the ragged halo of paint that squeezed under the template */
    g.strokeStyle = 'rgba(' + PW + ',0.30)'; g.lineWidth = ts * 0.016; g.stroke();
    g.restore();
    erode(o, 1.00, 1.00);
    push(P_ARROW);

    /* 1 -- the surveyor's cross, bottom left of ref8. 0.9 m arms, 100 mm wide */
    o = cell(P_CROSS);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.fillStyle = 'rgba(' + PW + ',0.84)';
    g.fillRect(o[0] + ts * 0.06, o[1] + ts * 0.44, ts * 0.88, ts * 0.12);
    g.fillRect(o[0] + ts * 0.44, o[1] + ts * 0.06, ts * 0.12, ts * 0.88);
    g.restore();
    erode(o, 0.55, 0.55);
    push(P_CROSS);

    /* 2 -- a give-way dash: 0.5 m of a broken line across the side street */
    o = cell(P_BAR);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    g.fillStyle = 'rgba(' + PW + ',0.82)';
    g.beginPath();
    g.moveTo(o[0] + ts * 0.10, o[1] + ts * 0.24);
    g.lineTo(o[0] + ts * 0.90, o[1] + ts * 0.20);
    g.lineTo(o[0] + ts * 0.91, o[1] + ts * 0.79);
    g.lineTo(o[0] + ts * 0.09, o[1] + ts * 0.76);
    g.closePath(); g.fill();
    g.restore();
    erode(o, 0.70, 0.60);
    push(P_BAR);

    /* 3 -- residue: what is left of a mark that has gone entirely */
    o = cell(P_WEAR);
    g.save(); g.beginPath(); g.rect(o[0], o[1], ts, ts); g.clip();
    for (i = 0; i < 26; i++) {
      var bx = o[0] + ts * (0.12 + R() * 0.76), by = o[1] + ts * (0.12 + R() * 0.76);
      var br = ts * (0.05 + R() * 0.16);
      var gr2 = g.createRadialGradient(bx, by, 0, bx, by, br);
      gr2.addColorStop(0, 'rgba(' + PW + ',' + (0.16 + R() * 0.22).toFixed(2) + ')');
      gr2.addColorStop(1, 'rgba(' + PW + ',0)');
      g.fillStyle = gr2; g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fill();
    }
    g.restore();
    erode(o, 0.40, 0.30);
    push(P_WEAR);

    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = ANISO;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    OWN.tex.push(t);
    STATS.texBytes += res * res * 4 * 1.34;
    PAINT.tex = t;

    /* roughness 0.62: road paint is smoother than the wearing course beside it
       and picks up a whisper of the sky, which is what makes it read as paint
       and not as chalk. env 0.5 -- less than the damp asphalt, more than the
       dry footway. */
    var mat = new THREE.MeshStandardMaterial({
      map: t, transparent: true, opacity: 1, alphaTest: 0.035,
      roughness: 0.62, metalness: 0.0, vertexColors: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
      fog: true, dithering: true, side: THREE.FrontSide
    });
    stDay(mat, { name: 'ground-paint', intensity: 0.50 });
    OWN.mat.push(mat);
    PAINT.mat = mat;
    return mat;
  }

  /* a painted mark, laid on the live road surface exactly as gdecal does */
  function pdecal(pile, cx, cz, hw, hh, rot, tile, tone) {
    var rect = PAINT.rect[tile];
    if (!rect) return;
    var ux = Math.cos(rot), uz = Math.sin(rot), vx = -uz, vz = ux;
    var uu = [rect[0], rect[2], rect[2], rect[0]], vv = [rect[1], rect[1], rect[3], rect[3]];
    var sx = [-1, 1, 1, -1], sy = [-1, -1, 1, 1];
    var tr = tone ? tone[0] : 1, tg = tone ? tone[1] : 1, tb = tone ? tone[2] : 1;
    var base = pile.n, i;
    for (i = 0; i < 4; i++) {
      var px = cx + ux * hw * sx[i] + vx * hh * sy[i];
      var pz = cz + uz * hw * sx[i] + vz * hh * sy[i];
      var py = surfaceY(px, pz) + DECAL_LIFT * 0.62;
      pile.vert(px, py, pz, 0, 1, 0, uu[i], vv[i], tr, tg, tb);
    }
    pile.tri(base, base + 2, base + 1);
    pile.tri(base, base + 3, base + 2);
    STATS.paint++;
  }

  /* =======================================================================
     SECTION 7 -- reading the level.
     The parking bays are S_BLOCK cells that NUKEM.html deliberately keeps out
     of CRATES[], so the cell is solid and nothing is drawn on it. The contract
     says do NOT hardcode the list; scan the grid inside the AABB and group
     contiguous runs, so the oil, the drip patches and the under-car AO stay
     correct if the orchestrator moves a bay.
     ==================================================================== */
  function scanBays() {
    var bays = [], cy, cx;
    var cy0 = Math.floor((RZ0 - 8) / 4), cy1 = Math.ceil((RZ1 + 8) / 4) - 1;
    var cx0 = Math.floor(BOXD.x0 / 4), cx1 = Math.ceil(BOXD.x1 / 4) - 1;
    for (cy = cy0; cy <= cy1; cy++) {
      var run = null;
      for (cx = cx0; cx <= cx1 + 1; cx++) {
        var isBay = false;
        if (cx <= cx1 && G.inb(cx, cy)) isBay = (G.cellAt(cx, cy) === G.S_BLOCK);
        if (isBay) {
          if (!run) run = { cy: cy, cx0: cx, cx1: cx };
          else run.cx1 = cx;
        } else if (run) {
          run.x0 = run.cx0 * 4; run.x1 = (run.cx1 + 1) * 4;
          run.z0 = cy * 4; run.z1 = (cy + 1) * 4;
          run.road = (run.z0 >= RZ0 && run.z1 <= RZ1);
          run.len = run.x1 - run.x0;
          /* THREE KINDS OF S_BLOCK NOW, and telling them apart is the whole
             reason the contract says scan instead of hardcode. A run on a
             kerb road row is a parking bay; a run inside the island AABB is
             the kerbed teardrop and must never take a car shadow; a run on an
             outer pavement row is a tree pit. */
          run.island = (run.x1 > ISLD.x0 && run.x0 < ISLD.x1 &&
                        run.z1 > ISLD.z0 && run.z0 < ISLD.z1);
          /* The one-cell-deep closure at x=832 is collision, not parking.
             Publish it explicitly so PROPS cannot turn ten barrier cells into
             ten toy cars and GROUND cannot paint under-car oil on them. */
          run.barrier = run.x0 >= 832 - 1e-6 && run.x1 <= 836 + 1e-6;
          run.kind = run.barrier ? 'barrier' : (run.island ? 'island' : (run.road ? 'bay' : 'pit'));
          if (run.barrier || run.island) run.road = false;
          bays.push(run);
          run = null;
        }
      }
    }
    return bays;
  }

  /* the car that will stand in a road-side bay, in world z. A Tofas Sahin is
     1.65 m wide = 5.8 u; the bay cell is only 4 u deep, so the body overhangs
     into the next row and the AO patch must follow the body, not the cell. */
  function bayFootprint(b) {
    var W = m(1.72);                                   /* body + mirrors */
    var north = (b.z0 - RZ0) < (RZ1 - b.z1);
    var z0, z1;
    if (north) { z0 = RZ0 + 0.35; z1 = z0 + W; }
    else { z1 = RZ1 - 0.35; z0 = z1 - W; }
    return { x0: b.x0 + 0.6, x1: b.x1 - 0.6, z0: z0, z1: z1, north: north };
  }

  /* =======================================================================
     SECTION 8 -- the roadway.
     Cambered, patched worn asphalt with no markings of any kind.

     THE PATCHWORK. A single 84 x 16 sheet of a 3 m tile is 8 visible repeats
     down the canyon and it reads as wallpaper at 60 m. So the roadway is cut
     into irregular rectangles -- 5 to 12 units along the street, 1 to 3 bands
     across it -- and each one is a GENERATION:

       base    55%   tone 1.00, UV origin 0, never rotated. Adjacent base
                     patches therefore line up EXACTLY: they are the same
                     original wearing course and must be seamless.
       old     20%   tone 1.09, own UV origin. A reinstatement that has
                     weathered pale and coarse.
       recent  17%   tone 0.86, own UV origin, sometimes rotated 90 deg.
       fresh    8%   tone 0.74, own origin, rotated. Dark and smooth.

     The tone is a multiplier on the overcast bake, so a patch is darker or
     paler but never a different hue -- which is what asphalt of different ages
     actually looks like under a white sky.
     ==================================================================== */
  var PATCH_BASE = 0, PATCH_OLD = 1, PATCH_RECENT = 2, PATCH_FRESH = 3;
  /* Compressed for AMENDMENT 2. The generations were spread 1.13/0.70 against
     a bake that has come up with the wider canyon, and on the junction apron
     -- where the sky module's throat exception opens the dome and the road is
     the brightest thing in the level -- a 1.13 patch blew to a flat pale
     rectangle. The seams, the patch-edge decals and the per-patch UV origin
     carry the read; the tone only has to nudge it. */
  var PATCH_TONE = [1.00, 1.085, 0.865, 0.775];

  function buildPatchwork() {
    var out = [], x = RX0, i = 0;
    while (x < RX1 - 0.25) {
      /* THE APRON IS CUT FINER. Four cell-widths of open asphalt in front of
         a side street is where every service trench, every gully connection
         and every winter pothole in the neighbourhood ends up: ref8 shows
         four or five distinguishable generations inside one frame where the
         canyon further east shows two. Shorter runs, more bands across, and a
         generation mix shifted off the base course. */
      var ap = apron(x);
      var w = (5 + rnd(i, 11) * 7) * (1 - 0.34 * ap);
      var x2 = Math.min(RX1, x + w);
      if (RX1 - x2 < 3.5) x2 = RX1;
      var nb = 1;
      if (rnd(i, 23) < 0.46 + 0.26 * ap) nb = 2;
      if (rnd(i, 29) < 0.16 + 0.34 * ap) nb = 3;
      var cuts = [RZ0];
      if (nb >= 2) cuts.push(RZ0 + 4.5 + rnd(i, 31) * 14);
      if (nb >= 3) cuts.push(RZ0 + 2.5 + rnd(i, 37) * 18);
      cuts.push(RZ1);
      cuts.sort(function (a, b) { return a - b; });
      for (var b = 0; b < cuts.length - 1; b++) {
        if (cuts[b + 1] - cuts[b] < 1.6) continue;
        var r = rnd(i * 13 + b, 41) * (1 - 0.30 * ap), gen;
        if (r < 0.55) gen = PATCH_BASE;
        else if (r < 0.75) gen = PATCH_OLD;
        else if (r < 0.92) gen = PATCH_RECENT;
        else gen = PATCH_FRESH;
        /* the full-width bands are the original course far more often: a
           trench reinstatement is a strip, not the whole carriageway */
        if (nb === 1 && gen !== PATCH_BASE && rnd(i * 7 + b, 43) < 0.55 - 0.35 * ap) gen = PATCH_BASE;
        out.push({
          x0: x, x1: x2, z0: cuts[b], z1: cuts[b + 1], gen: gen,
          uo: gen === PATCH_BASE ? 0 : (rnd(i * 5 + b, 47) - 0.5) * 37,
          vo: gen === PATCH_BASE ? 0 : (rnd(i * 5 + b, 53) - 0.5) * 37,
          rot: gen >= PATCH_RECENT && rnd(i * 3 + b, 59) < 0.55
        });
      }
      x = x2; i++;
    }
    STATS.patches = out.length;
    return out;
  }

  /* the throat gets its own patchwork on its own surface function. It is the
     mouth of a side street: one full-width apron slab, then the bellmouth
     reinstatement where the main runs were laid across it. */
  function buildThroatPatchwork() {
    var out = [], z = THRD.z0, i = 0;
    while (z < THRD.z1 - 0.25) {
      var d = 3.0 + rnd(i + 71, 11) * 3.4;
      var z2 = Math.min(THRD.z1, z + d);
      if (THRD.z1 - z2 < 2.2) z2 = THRD.z1;
      var nb = rnd(i + 71, 23) < 0.55 ? 2 : 1;
      var cuts = [THRD.x0];
      if (nb >= 2) cuts.push(THRD.x0 + 3.5 + rnd(i + 71, 31) * 9);
      cuts.push(THRD.x1);
      for (var b = 0; b < cuts.length - 1; b++) {
        if (cuts[b + 1] - cuts[b] < 1.6) continue;
        var r = rnd(i * 13 + b + 71, 41), gen;
        if (r < 0.40) gen = PATCH_BASE;
        else if (r < 0.66) gen = PATCH_OLD;
        else if (r < 0.90) gen = PATCH_RECENT;
        else gen = PATCH_FRESH;
        out.push({
          x0: cuts[b], x1: cuts[b + 1], z0: z, z1: z2, gen: gen, thr: true,
          uo: gen === PATCH_BASE ? 5.1 : (rnd(i * 5 + b + 71, 47) - 0.5) * 37,
          vo: gen === PATCH_BASE ? -2.3 : (rnd(i * 5 + b + 71, 53) - 0.5) * 37,
          rot: rnd(i * 3 + b + 71, 59) < 0.5
        });
      }
      z = z2; i++;
    }
    STATS.patches += out.length;
    return out;
  }

  /* the authored tone of the road surface at a point, before the macro layer:
     the polished centre strip, the gutter grime and the damp at the kerb.

     THE UNDER-CAR DARKENING IS GONE, for two independent reasons and both of
     them are measurable. (1) It was a hand-placed AO patch, and the sky
     module's bake now replays late-arriving occluders, so PROPS' car bodies
     cast a real contact shadow onto this geometry by themselves -- keeping
     this would darken the same tarmac twice. (2) It was a step of 0.70 over
     0.9 units evaluated PER VERTEX on a mesh whose vertices were 3.2 units
     apart at low tier, so it could not be interpolated: it resolved as a hard
     straight-edged facet, which is the 14.7-code diagonal step the critic
     sampled across the near road. The gentle CLEANER ring around a bay is
     kept -- it is a real thing (the rain never washes the tarmac a car stands
     on) and at 1.035 over 3.1 units it cannot facet. */
  var BAYFP = [];
  /* the two wheel tracks of the westbound and eastbound lanes, as world z.
     A 6.86 m carriageway carries two lanes; a track sits about 0.9 m either
     side of each lane centre. These are where the water stands. */
  function rutDepth(z) {
    var q = (RZ1 - RZ0) * 0.25;                       /* 6 u = quarter width */
    var r = 0, i, cz;
    for (i = 0; i < 4; i++) {
      cz = RZ0 + q * (i < 2 ? 0.55 + i * 0.90 : 2.55 + (i - 2) * 0.90);
      r = Math.max(r, 1 - smooth(clamp(Math.abs(z - cz) / 2.1, 0, 1)));
    }
    return r;
  }
  function roadTone(x, z, base) {
    var t = clamp(Math.abs(z - RZC) / RHW, 0, 1);
    /* the pale worn strip where tyres have polished it (ref1, mid-road) */
    var pol = 1 + 0.13 * (1 - smooth(clamp((Math.abs(z - RZC) - 0.6) / 3.4, 0, 1)));
    /* Grime and standing damp collect in the gutter line -- but a clean
       straight-edged band 2 m in from each kerb reads as a painted edge line,
       which this street explicitly does not have. Wobble the threshold along
       the street and soften the ramp so it is a wash, not a stripe. */
    var wob = (vnoise(x * 0.09 + 5.3, z * 0.02) - 0.5) * 0.26;
    var gut = 1 - (0.17 + wob * 0.30) * smooth(clamp((t - (0.55 + wob)) / 0.45, 0, 1));
    var k = base * pol * gut;
    /* THE APRON. ref8's junction is visibly flatter, wider and wetter than
       the canyon: no kerb parking to keep it dry, four ways for water to run
       in and nothing to run off to, so the wheel tracks hold standing water
       for days and dry pale between them. Two terms, both weighted by
       apron(): a broad darkening in the ruts, and a low-frequency puddle
       field that only bites where the ruts already are. */
    var ap = apron(x);
    if (ap > 0.001) {
      /* and the apron is OLDER than the street it opens off -- more binder
         bleed, more fines, a junction's worth of standing traffic. ref8 has
         its apron 10 % over the canyon road; the sky module's throat exception
         alone was putting it 28 % over, so 6 % of that comes back here as
         albedo and the rest stays as the open-sky read the reference wants. */
      var rut = rutDepth(z);
      k *= 1 - ap * 0.06;
      var pud = smooth(clamp((vnoise(x * 0.155 + 41.7, z * 0.155 - 19.3) - 0.44) * 2.7, 0, 1));
      k *= 1 - ap * (0.085 * rut + 0.20 * pud * (0.35 + 0.65 * rut));
      /* and the aggregate that is left standing proud between them */
      k *= 1 + ap * 0.055 * (1 - rut) * smooth(clamp((vnoise(x * 0.36 - 7.1, z * 0.36 + 3.3) - 0.5) * 2.4, 0, 1));
    }
    /* mud tracked off the island by every wheel that clips its nose */
    if (ISLFP) {
      var mdx = Math.max(ISLFP.x0 - x, x - ISLFP.x1, 0), mdz = Math.max(ISLFP.z0 - z, z - ISLFP.z1, 0);
      var md = Math.sqrt(mdx * mdx + mdz * mdz);
      if (md < 7.0) {
        var mw = (1 - smooth(clamp(md / 7.0, 0, 1))) * (0.55 + 0.45 * vnoise(x * 0.42 + 61.1, z * 0.42));
        k *= 1 - 0.115 * mw;
      }
    }
    for (var i = 0; i < BAYFP.length; i++) {
      var f = BAYFP[i];
      if (!f.road) continue;
      var dx = Math.max(f.x0 - x, x - f.x1, 0), dz = Math.max(f.z0 - z, z - f.z1, 0);
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d < 4.0) k *= lerp(1.035, 1.0, 1 - smooth(clamp(d / 4.0, 0, 1)));
    }
    return k;
  }

  function buildRoad(pile) {
    var patches = buildPatchwork(), i;
    /* THE TESSELLATION IS THE BAKE'S RESOLUTION. A per-vertex sky solution can
       only interpolate a curve if it has vertices to interpolate between, and
       3.2 x 2.4 units (0.91 x 0.69 m) was coarse enough that every smoothstep
       in roadTone() and every gradient in the bake resolved as a facet. 1.8 x
       1.4 is 0.51 x 0.40 m, roughly three times the vertex count on a mesh
       that costs a few thousand triangles either way, and it is the same
       number at every tier because the near road is the near road. */
    var stepX = TIER === 'low' ? 1.9 : 1.5;
    var stepZ = TIER === 'low' ? 1.5 : 1.2;
    var tone = [1, 1, 1];
    function toneFn(x, z) {
      var v = roadTone(x, z, toneFn.base);
      /* FEATHER THE PATCH BOUNDARY. Two abutting reinstatements are two
         separate surface() calls with their own vertices, so a tone step of
         1.13 against 0.70 met as a dead-straight rectangle. Both sides fade
         toward the base course over a noise-wobbled 1.2-2.4 units, so the
         join is a ragged wash under the tar seam the decal pass lays on it
         instead of a drawn rectangle. */
      var p = toneFn.p;
      if (p && toneFn.base !== 1) {
        /* the feather doubled: 1.2-2.4 units was narrow against a 12-unit
           patch, so the middle of every reinstatement was a flat plateau with
           a thin ramp round it -- which a grazing shot reads as a drawn
           rectangle. 2.2-4.8 leaves almost no plateau on a strip patch. */
        var w = 2.2 + (vnoise(x * 0.21 + 11.7, z * 0.21 - 4.3)) * 2.6;
        var d = Math.min(x - p.x0, p.x1 - x, z - p.z0, p.z1 - z);
        v = lerp(1, v, smooth(clamp(d / w, 0, 1)));
      }
      tone[0] = v; tone[1] = v * 0.998; tone[2] = v * 1.004;   /* a whisper cool */
      return tone;
    }
    for (i = 0; i < patches.length; i++) {
      var p = patches[i];
      toneFn.base = PATCH_TONE[p.gen];
      toneFn.p = p;
      var xs = spanEdged(p.x0, p.x1, stepX, 1.1);
      var zs = spanEdged(p.z0, p.z1, stepZ, 1.0);
      surface(pile, xs, zs, function (x, z) { return roadY(z); },
        function (x, z, o) { return roadN(z, o); }, toneFn, p.uo, p.vo, p.rot);
    }
    /* --- the junction throat -------------------------------------------
       Same material, same patchwork logic, its own surface. It is one shade
       darker and cooler than the apron it opens off: the bridge band stands
       over it from y = 28 up, so it never gets the full dome, and the sky
       module's own bake already knows that -- this is only the road film that
       collects in a slot nothing dries out. */
    if (GROUND.hasThroat) {
      var tp = buildThroatPatchwork();
      for (i = 0; i < tp.length; i++) {
        var q = tp[i];
        toneFn.base = PATCH_TONE[q.gen] * 0.955;
        toneFn.p = q;
        surface(pile, spanEdged(q.x0, q.x1, stepX * 0.85, 0.9),
          spanEdged(q.z0, q.z1, stepZ * 0.85, 0.8),
          throatY, throatN, toneFn, q.uo, q.vo, q.rot);
        patches.push(q);
      }
    }
    return patches;
  }

  /* Is the junction throat carved and painted ROAD? The two north rows at
     x 44..47 were repainted rResRoad (f = 0) by the re-carve; if this build
     predates that they are still walk cells at f = 0.5 and the whole throat
     has to be skipped rather than laid 0.5 u under the pavement. */
  function throatOpen() {
    var cx = Math.floor((THRD.x0 + THRD.x1) * 0.5 / 4), cy = Math.floor((THRD.z0 + 2) / 4);
    if (!G.inb(cx, cy) || !openCell(G.cellAt(cx, cy))) return false;
    var R = regionAt(cx, cy);
    return !!(R && fin(R.f, 0) < 0.25);
  }

  /* =======================================================================
     SECTION 9 -- the kerbs.
     Precast, 147 mm exposed face, 286 mm top, laid in 1 m lengths with real
     joints. Each unit takes its own settle (+-4 mm), its own lateral set
     (+-3 mm) and, one in five, a chipped corner -- so the joint reads as a
     step in the light rather than as a painted line, which is what makes a
     kerb look laid rather than extruded.
     ==================================================================== */
  var CROSS = [];        /* vehicle crossovers: {x0,x1,side} -> dropped kerb */

  /* how far into a crossover a point is. `walkOnly` filters out the throat,
     whose dropped kerb has NO pavement behind it to ramp down. */
  function crossoverAt(x, side, walkOnly) {
    var best = 0;
    for (var i = 0; i < CROSS.length; i++) {
      var c = CROSS[i];
      if (c.side !== side) continue;
      if (walkOnly && c.nowalk) continue;
      var rmp = fin(c.ramp, 2.2);
      if (x >= c.x0 - rmp && x <= c.x1 + rmp) {
        var t = 1;
        if (x < c.x0) t = smooth((x - (c.x0 - rmp)) / rmp);
        else if (x > c.x1) t = smooth(((c.x1 + rmp) - x) / rmp);
        if (t > best) best = t;
      }
    }
    return best;
  }
  /* the lowest top any crossover asks for at this x -- a driveway drops the
     kerb to a 43 mm upstand, the junction throat takes it to flush */
  function kerbTopAt(x, side) {
    var y = KERB_Y;
    for (var i = 0; i < CROSS.length; i++) {
      var c = CROSS[i];
      if (c.side !== side || c.kerbSelf) continue;
      var rmp = fin(c.ramp, 2.2);
      if (x < c.x0 - rmp || x > c.x1 + rmp) continue;
      var t = 1;
      if (x < c.x0) t = smooth((x - (c.x0 - rmp)) / rmp);
      else if (x > c.x1) t = smooth(((c.x1 + rmp) - x) / rmp);
      var v = lerp(KERB_Y, fin(c.top, KERB_DROP), t);
      if (v < y) y = v;
    }
    return y;
  }

  /* --- lay precast kerb units along an arbitrary XZ polyline ---------------
     One emitter for all four jobs this street now has: the two long street
     runs, the two returns up the sides of the junction throat, the flush
     channel across its mouth, and the island's closed ring. `pts` is the FACE
     line (the road side); the back of the unit is offset toward `ref`, which
     is a point demonstrably on the pavement/soil side, so the handedness can
     never come out inside-out on a curve. Units are cut to `unit` along the
     arc, each with its own settle, lateral set and swatch -- the joint
     rhythm is the only thing that gives a kerb run its scale at 20 m. */
  function layKerb(pile, pts, opt) {
    opt = opt || {};
    var closed = !!opt.closed;
    var W0 = fin(opt.width, KERB_W), unit = fin(opt.unit, KERB_UNIT);
    var cham = fin(opt.cham, 0.055), jw = fin(opt.joint, 0.035);
    var seed0 = fin(opt.seed, 137);
    var refx = fin(opt.refx, 0), refz = fin(opt.refz, 0);
    var topAt = opt.topAt, faceAt = opt.faceAt, backAt = opt.backAt;
    var widthAt = opt.widthAt || null, toneAt = opt.toneAt || null;
    var drawBack = opt.back !== false;
    var n = pts.length, i;
    if (n < 2 || !topAt || !faceAt) return 0;
    var segs = closed ? n : n - 1;
    var cum = [0], total = 0;
    for (i = 0; i < segs; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      total += Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
      cum.push(total);
    }
    if (!(total > 0.3)) return 0;
    var nU = Math.max(1, Math.round(total / unit)), step = total / nU;
    function at(s) {
      if (s <= 0) return [pts[0][0], pts[0][1]];
      if (s >= total) { var e = pts[closed ? 0 : n - 1]; return [e[0], e[1]]; }
      var k = 0;
      while (k < segs - 1 && cum[k + 1] < s) k++;
      var p = pts[k], q = pts[(k + 1) % n];
      var t = (s - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k]);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
    var made = 0;
    for (i = 0; i < nU; i++) {
      var s0 = i * step + ((i === 0 && !closed) ? 0 : jw * 0.5);
      var s1 = (i + 1) * step - jw * 0.5;
      if (s1 - s0 < 0.22) continue;
      var A = at(s0), B = at(s1);
      var dx = B[0] - A[0], dz = B[1] - A[1];
      var L = Math.sqrt(dx * dx + dz * dz);
      if (!(L > 1e-4)) continue;
      dx /= L; dz /= L;
      var nx = -dz, nz = dx;
      var mx = (A[0] + B[0]) * 0.5, mz = (A[1] + B[1]) * 0.5;
      if (nx * (refx - mx) + nz * (refz - mz) < 0) { nx = -nx; nz = -nz; }
      var sd = seed0 + i * 3;
      var settle = (rnd(sd, 61) - 0.5) * 0.062;
      var set = (rnd(sd, 67) - 0.5) * 0.044;
      var W = widthAt ? widthAt(mx, mz) : W0;
      var ax = A[0] + nx * set, az = A[1] + nz * set;
      var bx = B[0] + nx * set, bz = B[1] + nz * set;
      var ty0 = topAt(ax, az) + settle, ty1 = topAt(bx, bz) + settle;
      var fy0 = faceAt(ax, az), fy1 = faceAt(bx, bz);
      var by0 = backAt ? backAt(ax, az) : Math.min(ty0, ty1) - 0.02;
      var by1 = backAt ? backAt(bx, bz) : by0;
      var a2x = ax + nx * W, a2z = az + nz * W, b2x = bx + nx * W, b2z = bz + nz * W;
      var c0x = ax + nx * cham, c0z = az + nz * cham;
      var c1x = bx + nx * cham, c1z = bz + nz * cham;
      /* +10 % on the gconc swatch, which came down by 30 %: a precast kerb is
         the cleanest, palest thing at ground level -- it is the top of a unit
         that catches the whole sky and gets swept by every passing wheel.
         Unit-to-unit spread +-11 %, so a replaced kerb reads as replaced. */
      var kk = toneAt ? toneAt(mx, mz, sd) : 1.00 * (0.92 + rnd(sd, 71) * 0.20);
      var tone = [kk, kk * 0.997, kk * 1.008];
      var dark = [kk * 0.9, kk * 0.9, kk * 0.92];
      var chk = [kk * 0.72, kk * 0.72, kk * 0.74];
      var rx = mx + nx * W * 0.5, ry = Math.min(ty0, ty1) - 0.4, rz = mz + nz * W * 0.5;
      /* top */
      poly(pile, [[c0x, ty0, c0z], [c1x, ty1, c1z], [b2x, ty1, b2z], [a2x, ty0, a2z]], rx, ry, rz, tone);
      /* chamfered arris */
      poly(pile, [[ax, ty0 - cham, az], [bx, ty1 - cham, bz], [c1x, ty1, c1z], [c0x, ty0, c0z]], rx, ry, rz, tone);
      /* exposed face, carried below the gutter so no sliver of world quad can
         show through where the camber meets it */
      poly(pile, [[ax, fy0 - 0.14, az], [bx, fy1 - 0.14, bz], [bx, ty1 - cham, bz], [ax, ty0 - cham, az]],
        rx, ry, rz, dark);
      /* the back, where anything behind sits lower than the top (the throat
         channel, the island ring, a dropped kerb) */
      if (drawBack && (by0 < ty0 - 0.008 || by1 < ty1 - 0.008)) {
        poly(pile, [[a2x, by0 - 0.10, a2z], [b2x, by1 - 0.10, b2z], [b2x, ty1, b2z], [a2x, ty0, a2z]],
          mx, ry, mz, dark);
      }
      /* the two joint cheeks, which is what actually reads as a 1 m length */
      poly(pile, [[ax, fy0 - 0.14, az], [ax, ty0 - cham, az], [c0x, ty0, c0z], [a2x, ty0, a2z], [a2x, by0 - 0.10, a2z]],
        mx, ry, mz, chk);
      poly(pile, [[bx, fy1 - 0.14, bz], [bx, ty1 - cham, bz], [c1x, ty1, c1z], [b2x, ty1, b2z], [b2x, by1 - 0.10, b2z]],
        mx, ry, mz, chk);
      STATS.kerbUnits++; made++;
    }
    return made;
  }

  /* a straight line of samples, so a run can be built as a polyline and take
     a per-point height without the emitter needing to know its shape */
  function lineP(x0, z0, x1, z1, step) {
    var dx = x1 - x0, dz = z1 - z0, L = Math.sqrt(dx * dx + dz * dz);
    var n = Math.max(1, Math.round(L / (step || 3.5))), out = [], i;
    for (i = 0; i <= n; i++) out.push([x0 + dx * i / n, z0 + dz * i / n]);
    return out;
  }
  /* --- the street kerbs, both sides, plus the whole junction --------------
     NORTH is no longer one run. The re-carve repainted the two north rows at
     x [176,192] as ROAD, so the footway stops at x = 176, RETURNS north up the
     side of the throat to the facade plane, and picks up again at x = 192.
     Three pieces a corner, and the corner is square on purpose: a radius would
     cut the 2 m footway in half and leave a wedge of paving standing 0.5 u
     over the road with nothing holding it up. The return kerb's own 1-unit
     width covers the corner square, and the paving band is clipped to match
     (see walkGaps).

     Across the mouth the kerb line survives as a FLUSH channel -- 19 mm, the
     dropped kerb the side street pours over -- so the gutter line and
     everything that washes along it run straight through the junction, which
     is what ref8 shows. The splay is authored in the channel's own top and
     width functions rather than through crossoverAt(), because the full-height
     legs either side are holding real pavement up and must not follow it. */
  function kerbFaceRoad(x, z) { return roadY(clamp(z, RZ0, RZ1)); }
  function kerbFaceThroat(x, z) { return throatY(clamp(x, THRD.x0, THRD.x1), clamp(z, THRD.z0, THRD.z1)); }

  function buildKerbs(pile) {
    var thr = GROUND.hasThroat;
    var tx0 = THRD.x0, tx1 = THRD.x1;
    var topN = function (x, z) { return kerbTopAt(x, 'N'); };
    var topS = function (x, z) { return kerbTopAt(x, 'S'); };
    var topFull = function () { return KERB_Y; };
    var backWalk = function () { return PAVE_Y; };

    if (!thr) {
      layKerb(pile, lineP(RX0, RZ0, RX1, RZ0, 3.5), {
        refx: RX0 + 1, refz: RZ0 - 6, topAt: topN, faceAt: kerbFaceRoad, backAt: backWalk, seed: 137
      });
    } else {
      /* the two legs along the road, stopping dead at the throat */
      layKerb(pile, lineP(RX0, RZ0, tx0, RZ0, 3.5), {
        refx: RX0 + 4, refz: RZ0 - 6, topAt: topN, faceAt: kerbFaceRoad, backAt: backWalk, seed: 137
      });
      layKerb(pile, lineP(tx1, RZ0, RX1, RZ0, 3.5), {
        refx: RX1 - 4, refz: RZ0 - 6, topAt: topN, faceAt: kerbFaceRoad, backAt: backWalk, seed: 401
      });
      /* the two returns up the sides of the side street, face into the throat */
      layKerb(pile, lineP(tx0, BOXD.z0, tx0, RZ0 - KERB_W, 3.5), {
        refx: tx0 - 5, refz: (BOXD.z0 + RZ0) * 0.5,
        topAt: topFull, faceAt: kerbFaceThroat, backAt: backWalk, seed: 613
      });
      layKerb(pile, lineP(tx1, BOXD.z0, tx1, RZ0 - KERB_W, 3.5), {
        refx: tx1 + 5, refz: (BOXD.z0 + RZ0) * 0.5,
        topAt: topFull, faceAt: kerbFaceThroat, backAt: backWalk, seed: 677
      });
      /* THE DROPPED KERB. Flush across the mouth with a 3-unit splayed
         transition at each end -- the units widen as they fall, which is what
         a splayed transition unit is, and it is the only thing that stops the
         drop reading as a step in a straight line. */
      var splay = 3.0;
      function splayT(x) { return smooth(clamp(Math.min(x - tx0, tx1 - x) / splay, 0, 1)); }
      layKerb(pile, lineP(tx0, RZ0, tx1, RZ0, 2.6), {
        refx: (tx0 + tx1) * 0.5, refz: RZ0 - 5,
        unit: KERB_UNIT * 0.92, cham: 0.045,
        topAt: function (x) { return lerp(KERB_Y, KERB_FLUSH, splayT(x)); },
        widthAt: function (x) { return lerp(KERB_W * 1.90, KERB_W * 1.10, splayT(x)); },
        faceAt: kerbFaceRoad,
        backAt: function (x) { return throatY(x, RZ0 - 1.5); },
        toneAt: function (x, z, sd) {
          /* everything drives over it: scrubbed pale on top, and it has been
             replaced twice, so the unit-to-unit spread is wider than the run */
          return (0.90 + rnd(sd, 71) * 0.22) * 0.965;
        },
        seed: 733
      });
    }

    /* the south side is unbroken for the whole 84 units */
    layKerb(pile, lineP(RX0, RZ1, RX1, RZ1, 3.5), {
      refx: RX0 + 1, refz: RZ1 + 6, topAt: topS, faceAt: kerbFaceRoad, backAt: backWalk, seed: 251
    });
  }

  /* a kerb return across a closed end of the street */
  function buildKerbEnd(pile, atX, inward) {
    var w = KERB_W, x0 = inward > 0 ? atX : atX - w, x1 = x0 + w;
    var tone = [0.97, 0.97, 0.98];
    var zs = RZ0, ze = RZ1;
    boxTop(pile, x0, x1, 0.0, KERB_Y, zs - KERB_W, ze + KERB_W, tone);
  }

  /* =======================================================================
     SECTION 9b -- the junction island (_ref/ref8).
     A precast kerb ring in 1 m chamfered units, mountable profile: 180 mm over
     the crown of the road, a 90 mm chamfer, and a plan that is a teardrop --
     wide rounded lobe to the east, blunt nose to the west where it splits the
     traffic. Inside it, scruffy grass over bare soil, mounded a little proud
     the way every one of these is because nobody has ever taken soil OUT.
     PROPS stands the conifer and the sign poles on it; GROUND leaves the
     centre clear and publishes the footprint.
     ==================================================================== */
  var ISLFP = null;

  function islandOutline() {
    var cx = (ISLD.x0 + ISLD.x1) * 0.5, cz = (ISLD.z0 + ISLD.z1) * 0.5;
    var half = Math.min(ISLD.x1 - ISLD.x0, ISLD.z1 - ISLD.z0) * 0.5;
    var R = half * 0.92, ecx = cx + half * 0.0375;
    var n = 40, out = [], i;
    for (i = 0; i < n; i++) {
      var a = i / n * TAU;
      var q = (1 - Math.cos(a)) * 0.5;                 /* 0 east, 1 west */
      var wf = 1 - 0.88 * Math.pow(q, 3.0);            /* the taper to the nose */
      out.push([ecx + Math.cos(a) * R * (1 + 0.10 * q), cz + Math.sin(a) * R * wf]);
    }
    return { pts: out, cx: cx, cz: cz, ecx: ecx, R: R };
  }

  function buildIsland(kpile, spile) {
    if (!ISLD || ISLD.x1 - ISLD.x0 < 2) return null;
    var O = islandOutline(), pts = O.pts, i;
    var W = m(0.21);                                    /* 0.735 u = 210 mm    */
    var top = ISL_KERB_Y, soil = ISL_SOIL_Y;
    /* RADIUS KERBS, 0.48 m. A 1 m straight unit round a 2.3 m island is a
       hexagon -- six chords across a 6.6 m perimeter, which is exactly what
       the first cut rendered. Small islands are laid in short radius units for
       precisely this reason, and at 0.48 m the fourteen chords sag 8 mm off
       the curve, which is under the joint width. */
    layKerb(kpile, pts, {
      closed: true, width: W, unit: m(0.48), cham: 0.075, joint: 0.026,
      refx: O.cx, refz: O.cz,
      topAt: function () { return top; },
      faceAt: function (x, z) { return roadY(clamp(z, RZ0, RZ1)); },
      backAt: function (x, z) { return soil - 0.05; },
      toneAt: function (x, z, sd) {
        /* NOT a swept footway kerb. This one is mud-splashed on every side and
           chipped at the nose, which is the end everything clips, so it sits a
           tenth below the street runs rather than a tenth above. */
        var w = 1 - smooth(clamp((x - (O.ecx - O.R * 0.7)) / (O.R * 1.4), 0, 1));
        return (0.86 + rnd(sd, 71) * 0.16) * (1 - 0.12 * w);
      },
      seed: 971
    });

    /* --- the soil, as a fan of concentric rings inside the kerb back line.
       Built from the ring itself, so there is no seam to see through however
       the outline is tuned, and dense enough (4 rings x 40) that the sky
       bake's falloff into the kerb shadow is a gradient and not a facet. */
    var inner = [], nx, nz, l;
    for (i = 0; i < pts.length; i++) {
      nx = O.cx - pts[i][0]; nz = O.cz - pts[i][1];
      l = Math.sqrt(nx * nx + nz * nz) || 1;
      inner.push([pts[i][0] + nx / l * (W + 0.10), pts[i][1] + nz / l * (W + 0.10)]);
    }
    spile.context(TILE_CONC * 2.2);
    var RINGS = 4, tone = [1, 1, 1];
    function soilY(x, z) {
      var dx = (x - O.cx) / 3.2, dz = (z - O.cz) / 3.2;
      var d = clamp(Math.sqrt(dx * dx + dz * dz), 0, 1);
      /* mounded, and lumpy at 0.4 m */
      return soil - 0.050 * d * d + (vnoise(x * 0.9 + 13.1, z * 0.9 - 5.7) - 0.5) * 0.060;
    }
    function soilTone(x, z) {
      /* Scruffy grass over bare soil, and the operative word is SCRUFFY. The
         first cut ran a saturated [0.38,0.49,0.26] grass against a near-black
         soil and the island came out reading as camouflage netting: on a
         2.3 m circle that contrast is a pattern, not a surface. Early spring
         in Konya is straw with a green cast, the bare soil beside it is a warm
         pale grey-brown, and the two are a third of a stop apart, not two. */
      var g = 0.15 + 0.75 * smooth(clamp((vnoise(x * 0.46 + 3.9, z * 0.46 + 21.3) - 0.42) * 2.0, 0, 1));
      var bare = smooth(clamp((vnoise(x * 1.05 - 11.7, z * 1.05 + 6.2) - 0.50) * 2.2, 0, 1));
      var dx2 = (x - O.cx) / 3.4, dz2 = (z - O.cz) / 3.4;
      var edge = smooth(clamp((Math.sqrt(dx2 * dx2 + dz2 * dz2) - 0.55) / 0.45, 0, 1));
      g *= 1 - 0.50 * edge * (0.4 + 0.6 * bare);
      /* CALIBRATED AGAINST ref8, not against a paint chip. The island grass
         there measures about 0.60 of the asphalt beside it and the bare soil
         about 0.65 -- they are a third of a stop apart, not two, and both are
         far closer to the road than a lawn would be. Against the gconc set
         (lum 68) a tone of 0.56 lands at an effective 38 against the road's
         64, which is 0.59. Damp soil -> dry pale soil -> straw-green grass. */
      /* against the gconc set AFTER its 1.14 re-calibration, so the tones are
         the ref8 numbers divided by 1.14 and the island did not move */
      var s0 = lerp(0.44, 0.57, bare);
      tone[0] = lerp(s0, 0.48, g);
      tone[1] = lerp(s0 * 0.90, 0.53, g);
      tone[2] = lerp(s0 * 0.74, 0.35, g);
      return tone;
    }
    /* A RING GRID, indexed like surface() but with its two axes swapped --
       the angular axis runs +z where the radial axis runs +x, and a swap
       reverses the winding, so the triangles are (a,b,c)/(b,d,c) and not
       surface()'s (a,c,b)/(b,c,d). Emitted by hand rather than through poly()
       because the soil tone varies at 1 u and a per-polygon tone would facet. */
    var N = inner.length, inv = spile.inv, ri, k, j;
    var T0 = 0.14;                         /* the innermost ring, so the cap
                                              fan is not a ring of slivers   */
    var base = spile.n;
    for (ri = 0; ri <= RINGS; ri++) {
      var t = T0 + (1 - T0) * ri / RINGS;
      for (i = 0; i < N; i++) {
        var px = lerp(O.cx, inner[i][0], t), pz = lerp(O.cz, inner[i][1], t);
        var py = soilY(px, pz), tn = soilTone(px, pz), mk = macro(px, pz);
        spile.vert(px, py, pz, 0, 1, 0, px * inv, pz * inv,
          tn[0] * mk, tn[1] * mk, tn[2] * mk);
      }
    }
    for (ri = 0; ri < RINGS; ri++) {
      for (i = 0; i < N; i++) {
        j = (i + 1) % N;
        var a = base + ri * N + i, b = base + ri * N + j;
        var c = base + (ri + 1) * N + i, d = base + (ri + 1) * N + j;
        spile.tri(a, b, c); spile.tri(b, d, c);
      }
    }
    /* the cap over the middle */
    var ct = soilTone(O.cx, O.cz), cmk = macro(O.cx, O.cz);
    var cIdx = spile.vert(O.cx, soilY(O.cx, O.cz), O.cz, 0, 1, 0,
      O.cx * inv, O.cz * inv, ct[0] * cmk, ct[1] * cmk, ct[2] * cmk);
    for (i = 0; i < N; i++) {
      j = (i + 1) % N;
      spile.tri(cIdx, base + j, base + i);
    }

    ISLFP = {
      x0: ISLD.x0, x1: ISLD.x1, z0: ISLD.z0, z1: ISLD.z1,
      cx: O.cx, cz: O.cz, ring: pts, inner: inner, width: W,
      kerbTop: top, soilY: soil, noseX: O.ecx - O.R * 1.10,
      /* PROPS: the conifer goes here and the sign poles at the nose */
      plant: { x: O.cx + 0.55, z: O.cz, r: 2.05, y: soil },
      soilAt: soilY
    };
    GROUND.ISLAND = ISLFP;
    return ISLFP;
  }

  /* =======================================================================
     SECTION 10 -- the pavements.
     THE PAVEMENT IS INTERRUPTED, and that is the point. In ref1 the left-hand
     footway is swallowed by a garden and the pedestrian route runs in the
     gutter. Two clean continuous ribbons of paver would be the single most
     CG thing on this street, so each side is built as a sequence of RUNS:

       paver   interlocking blocks, bond either along or across the street
       conc    plain cast concrete with real expansion-joint grooves
       earth   the footway has been taken by a garden: a narrow 2.4 u strip
               of paving survives against the kerb and the rest is bare,
               dark and weedy

     A run is 7-17 units long, each with its own UV origin, so even two
     adjacent paver runs do not continue each other's bond.
     ==================================================================== */
  var WALK_PAVER = 0, WALK_CONC = 1, WALK_EARTH = 2;

  function walkBand(side) {
    /* z range of the paving on this side, kerb excluded */
    if (side === 'N') return [BOXD.z0, RZ0 - KERB_W];        /* 152 .. 159 */
    return [RZ1 + KERB_W, BOXD.z1];                          /* 185 .. 192 */
  }
  /* the spans of x where this side has NO pavement. The north footway is cut
     in two by the junction throat: cells x 44..47 of both north rows are
     painted ROAD, so laying paving across them would put a 0.5 u shelf in the
     mouth of the side street. */
  function walkGaps(side) {
    if (side !== 'N' || !GROUND.hasThroat) return [];
    /* widened by KERB_W each side: the return kerbs at x = 176 and x = 192 own
       that unit, and their backs are what the paving butts against */
    return [[THRD.x0 - KERB_W, THRD.x1 + KERB_W]];
  }
  function inGap(side, x) {
    var g = walkGaps(side), i;
    for (i = 0; i < g.length; i++) if (x > g[i][0] - 0.001 && x < g[i][1] + 0.001) return true;
    return false;
  }
  function walkY(x, z, side) {
    var d = crossoverAt(x, side, true);
    if (d <= 0) return PAVE_Y;
    var inner = side === 'N' ? RZ0 - KERB_W : RZ1 + KERB_W;
    var ramp = 1 - smooth(clamp(Math.abs(z - inner) / 2.6, 0, 1));
    return lerp(PAVE_Y, lerp(PAVE_Y, WALK_DROP, ramp), d);
  }

  function buildWalkRuns(side) {
    var runs = [], x = RX0, i = 0;
    while (x < RX1 - 0.5) {
      var w = 7 + rnd((side === 'N' ? 311 : 409) + i, 73) * 10;
      var x1 = Math.min(RX1, x + w);
      if (RX1 - x1 < 4) x1 = RX1;
      /* THE EARTH BRANCH WAS UNREACHABLE. rnd() is a sin-hash and the old
         stream -- consecutive `a` with a fixed `b` -- correlates badly: over
         the fourteen runs this street actually has, `r` never once exceeded
         0.686, so with the WALK_EARTH threshold at 0.86 not one garden ever
         swallowed the footway. The street was built as two clean continuous
         pavements, which STREET-BRIEF section 2 names as the single most CG
         thing that could be done to it ("Do not build two clean continuous
         pavements; the charm is in the interruptions"), and it is the reason
         the earth material was never seen to be wrong. Decorrelated stream
         (i * 37, prime 113) and thresholds re-cut against the fourteen values
         it actually produces: 8 paver, 4 cast concrete, 2 earth -- one garden
         a side, 4.0 m and 4.9 m long, which is `ref1`'s left-hand footway. */
      var r = rnd((side === 'N' ? 7 : 23) + i * 37, 113), ty;
      if (r < 0.48) ty = WALK_PAVER;
      else if (r < 0.82) ty = WALK_CONC;
      else ty = WALK_EARTH;
      runs.push({
        x0: x, x1: x1, type: ty,
        rot: ty === WALK_PAVER && rnd(i + (side === 'N' ? 5 : 9), 83) < 0.42,
        uo: (rnd(i * 3 + 1, 89) - 0.5) * 13,
        vo: (rnd(i * 3 + 2, 97) - 0.5) * 13
      });
      x = x1; i++;
    }
    /* cut the runs against the throat, so a run never straddles it and the
       two halves of the footway keep their own bond origins */
    var gaps = walkGaps(side);
    if (gaps.length) {
      var out = [], j, g;
      for (i = 0; i < runs.length; i++) {
        var seg = [[runs[i].x0, runs[i].x1]];
        for (j = 0; j < gaps.length; j++) {
          g = gaps[j];
          var nxt = [], k;
          for (k = 0; k < seg.length; k++) {
            var a = seg[k][0], b = seg[k][1];
            if (b <= g[0] || a >= g[1]) { nxt.push([a, b]); continue; }
            if (a < g[0]) nxt.push([a, g[0]]);
            if (b > g[1]) nxt.push([g[1], b]);
          }
          seg = nxt;
        }
        for (j = 0; j < seg.length; j++) {
          if (seg[j][1] - seg[j][0] < 1.2) continue;
          var r2 = {};
          for (var kk in runs[i]) if (Object.prototype.hasOwnProperty.call(runs[i], kk)) r2[kk] = runs[i][kk];
          r2.x0 = seg[j][0]; r2.x1 = seg[j][1];
          out.push(r2);
        }
      }
      runs = out;
    }
    return runs;
  }

  /* =======================================================================
     SECTION 10b -- tree pits.
     Every non-road S_BLOCK run inside the canyon is a pit on an OUTER
     pavement row, hard against a facade plane. A pit is a square of bare
     compacted soil inside a flush precast surround, and PROPS puts the tree
     in it. The surround is inset by PLINTH from the plane so FACADE's plinth
     lands on the world quad, not on this.
     ==================================================================== */
  function buildPits(cpile, spile, pits) {
    var i, out = [];
    for (i = 0; i < pits.length; i++) {
      var p = pits[i];
      var north = p.z0 < RZC;
      var wall = north ? BOXD.z0 : BOXD.z1;
      var z0 = north ? Math.max(p.z0, wall + PLINTH) : p.z0 + 0.45;
      var z1 = north ? p.z1 - 0.45 : Math.min(p.z1, wall - PLINTH);
      var x0 = p.x0 + 0.45, x1 = p.x1 - 0.45;
      if (x1 - x0 < 1.2 || z1 - z0 < 1.2) continue;
      var eg = 0.42;                                   /* 120 mm edging       */
      var ey = PAVE_Y + 0.045;                         /* 13 mm proud         */
      var sy = PAVE_Y - 0.16;                          /* the soil, sunk      */
      var kk = 0.98 + rnd(3301 + i * 7, 71) * 0.10;
      var tn = [kk, kk * 0.996, kk * 1.006];
      cpile.context(TILE_CONC);
      /* four edging kerbs, mitred as plain boxes -- they are flush, so there
         is no chamfer to give a mitre away */
      boxTop(cpile, x0, x1, sy, ey, z0, z0 + eg, tn);
      boxTop(cpile, x0, x1, sy, ey, z1 - eg, z1, tn);
      boxTop(cpile, x0, x0 + eg, sy, ey, z0 + eg, z1 - eg, tn);
      boxTop(cpile, x1 - eg, x1, sy, ey, z0 + eg, z1 - eg, tn);
      /* the soil inside */
      var ix0 = x0 + eg, ix1 = x1 - eg, iz0 = z0 + eg, iz1 = z1 - eg;
      spile.context(TILE_CONC * 2.2);
      var tone = [1, 1, 1];
      surface(spile, spanEdged(ix0, ix1, 1.2, 0.4), spanEdged(iz0, iz1, 1.2, 0.4),
        function (x, z) {
          return sy + 0.055 + (vnoise(x * 1.1 + 27.3, z * 1.1 - 9.4) - 0.5) * 0.07;
        },
        function (x, z, o) { o[0] = 0; o[1] = 1; o[2] = 0; return o; },
        function (x, z) {
          var damp = vnoise(x * 0.8 + 5.1, z * 0.8 + 2.2);
          var grav = smooth(clamp((vnoise(x * 1.7 - 3.3, z * 1.7 + 11.9) - 0.54) * 3.2, 0, 1));
          var kk2 = lerp(0.26, 0.38, damp);
          tone[0] = lerp(kk2, 0.58, grav);
          tone[1] = lerp(kk2 * 0.79, 0.53, grav);
          tone[2] = lerp(kk2 * 0.56, 0.44, grav);
          return tone;
        }, 4.7, -3.1, false);
      out.push({ x0: ix0, x1: ix1, z0: iz0, z1: iz1, soilY: sy + 0.055, north: north });
    }
    GROUND.pits = out;
    return out;
  }

  function buildWalk(pvPile, ccPile, side) {
    var band = walkBand(side), z0 = band[0], z1 = band[1];
    var runs = buildWalkRuns(side), i;
    var wall = side === 'N' ? z0 : z1;            /* the facade line */
    /* same argument as the road: the crossover ramps and the wall-line tone
       gradient are smoothsteps 2.2-2.6 units wide, and a 3.0-unit vertex
       pitch turned them into facets */
    var stepX = TIER === 'low' ? 2.0 : 1.7, stepZ = TIER === 'low' ? 1.5 : 1.2;
    var tone = [1, 1, 1];
    var flatN = function (x, z, o) { o[0] = 0; o[1] = 1; o[2] = 0; return o; };

    for (i = 0; i < runs.length; i++) {
      var r = runs[i];
      var yFn = function (x, z) { return walkY(x, z, side); };
      if (r.type === WALK_EARTH) {
        /* the surviving strip of paving against the kerb */
        var sz0 = side === 'N' ? z1 - 2.4 : z0, sz1 = side === 'N' ? z1 : z0 + 2.4;
        tone[0] = tone[1] = tone[2] = 1;
        pvPile.context(TILE_PAVER);
        surface(pvPile, spanEdged(r.x0, r.x1, stepX, 0.9), spanEdged(sz0, sz1, stepZ, 0.6),
          yFn, flatN, function (x, z) {
            var k = 0.94 - 0.10 * smooth(clamp((Math.abs(z - (side === 'N' ? z1 : z0)) - 0.6) / 1.8, 0, 1));
            tone[0] = k; tone[1] = k; tone[2] = k; return tone;
          }, r.uo, r.vo, r.rot);
        /* and the garden ground that has taken the rest.
           THIS WAS A TINTED CONCRETE SET and it read as dark grey paving, not
           as soil: the old tone was 0.62-0.78 of a lum-126 concrete, i.e. an
           82-lum neutral with a 6 % warm bias, which is a wet slab. Bare earth
           in early spring is a dark, strongly warm brown that goes almost
           black where it has been trodden and pale grey-buff where the
           gravel and the clinker have come up. The tone is now a two-field
           mix -- a broad damp/dry noise crossed with a coarse gravel field --
           running roughly [0.30,0.23,0.16] soil to [0.62,0.57,0.47] gravel
           against the concrete swatch, with the trodden line against the
           surviving paving kept darkest. The grit, moss and leaf decals and
           the weed tufts (sections 12 and 13) are laid on top of it. */
        var ez0 = side === 'N' ? z0 : z0 + 2.4, ez1 = side === 'N' ? z1 - 2.4 : z1;
        var eIn = side === 'N' ? ez1 : ez0;        /* the edge facing the kerb */
        ccPile.context(TILE_CONC * 2.4);
        surface(ccPile, spanEdged(r.x0, r.x1, stepX, 0.9), spanEdged(ez0, ez1, stepZ, 0.7),
          yFn, flatN, function (x, z) {
            var damp = vnoise(x * 0.27, z * 0.27);                 /* wet vs dry  */
            var grav = smooth(clamp((vnoise(x * 0.62 + 17.3, z * 0.62 - 8.1) - 0.52) * 3.4, 0, 1));
            var trod = 1 - 0.14 * (1 - smooth(clamp(Math.abs(z - eIn) / 2.2, 0, 1)));
            var kk = lerp(0.30, 0.44, damp) * trod;
            tone[0] = lerp(kk, 0.62, grav) * 1.00;
            tone[1] = lerp(kk * 0.78, 0.57, grav) * 1.00;
            tone[2] = lerp(kk * 0.55, 0.47, grav) * 1.00;
            return tone;
          }, r.uo * 2, r.vo * 2, false);
        r.earth = { z0: ez0, z1: ez1 };
        continue;
      }
      if (r.type === WALK_PAVER) {
        pvPile.context(TILE_PAVER);
        surface(pvPile, spanEdged(r.x0, r.x1, stepX, 0.9), spanEdged(z0, z1, stepZ, 0.8),
          yFn, flatN, function (x, z) {
            /* dirtier and greener against the wall, worn pale on the walking line */
            var dw = Math.abs(z - wall);
            var k = 0.90 + 0.10 * smooth(clamp((dw - 0.5) / 2.2, 0, 1));
            k *= 1 + 0.045 * (1 - smooth(clamp(Math.abs(dw - 3.4) / 2.0, 0, 1)));
            /* THE COLOUR DRIFT THAT IS BIGGER THAN THE TILE. The bond field
               repeats its 20-unit colour motif every 0.8 m, and no palette can
               hide that on its own. This is a world-space warm/cool wander at
               2.6 m and 0.9 m, paid for in vertex colour, so a run of paving
               drifts from buff to grey along its length the way a real one
               does where two batches met -- and the repeat stops being a
               readable rhythm. */
            var wc = (vnoise(x * 0.11 + 3.7, z * 0.11 - 6.1) - 0.5) * 0.17
                   + (vnoise(x * 0.31 - 8.3, z * 0.31 + 2.9) - 0.5) * 0.08;
            tone[0] = k * (1 + wc); tone[1] = k * 0.995; tone[2] = k * 0.99 * (1 - wc);
            return tone;
          }, r.uo, r.vo, r.rot);
        continue;
      }
      /* cast concrete: real expansion-joint grooves every 1.8 m, emitted as
         extra rows in the tessellation so there is no gap to see through and
         nothing to z-fight */
      ccPile.context(TILE_CONC * 3);
      var joints = [], jx = r.x0 + 1.2 + rnd(i, 101) * 2.0;
      while (jx < r.x1 - 0.8) { joints.push(jx); jx += m(1.8); }
      var xs = spanEdged(r.x0, r.x1, stepX, 0.8), j;
      for (j = 0; j < joints.length; j++) { xs.push(joints[j] - 0.10, joints[j], joints[j] + 0.10); }
      xs.sort(function (a, b) { return a - b; });
      var jset = {};
      for (j = 0; j < joints.length; j++) jset[joints[j].toFixed(4)] = 1;
      surface(ccPile, xs, spanEdged(z0, z1, stepZ, 0.8),
        function (x, z) { return walkY(x, z, side) - (jset[x.toFixed(4)] ? 0.035 : 0); },
        flatN, function (x, z) {
          var dw = Math.abs(z - wall);
          var k = 0.93 + 0.09 * smooth(clamp((dw - 0.5) / 2.4, 0, 1));
          if (jset[x.toFixed(4)]) k *= 0.72;
          tone[0] = k; tone[1] = k; tone[2] = k * 1.005; return tone;
        }, r.uo, r.vo, false);
    }
    return runs;
  }

  /* =======================================================================
     SECTION 11 -- drainage and services ironwork.
     Two manhole covers on the crown, a gully grating in each gutter, a water
     valve box in the paving. Everything here is real geometry with a skirt
     down into the surface, because a flat disc lying on a road is the exact
     failure the decal pass is there to avoid.
     ==================================================================== */
  function gully(pile, cx, side) {
    var faceZ = side === 'N' ? RZ0 : RZ1;
    var dir = side === 'N' ? 1 : -1;                 /* into the roadway */
    var w = m(0.30), d = m(0.22);                    /* 600 x 440 mm opening */
    var z0 = faceZ + dir * 0.10, z1 = z0 + dir * d;
    var za = Math.min(z0, z1), zb = Math.max(z0, z1);
    var y = roadY((za + zb) * 0.5) + 0.012;
    var fr = 0.16, tone = [0.86, 0.86, 0.88];
    /* frame */
    boxTop(pile, cx - w - fr, cx - w, y - 0.30, y, za - fr, zb + fr, tone);
    boxTop(pile, cx + w, cx + w + fr, y - 0.30, y, za - fr, zb + fr, tone);
    boxTop(pile, cx - w, cx + w, y - 0.30, y, za - fr, za, tone);
    boxTop(pile, cx - w, cx + w, y - 0.30, y, zb, zb + fr, tone);
    /* the throat, dark */
    poly(pile, [[cx - w, y - 0.55, za], [cx + w, y - 0.55, za], [cx + w, y - 0.55, zb], [cx - w, y - 0.55, zb]],
      cx, y - 2, (za + zb) * 0.5, [0.16, 0.16, 0.17]);
    /* bars */
    var n = 5, i;
    for (i = 0; i < n; i++) {
      var t0 = za + (zb - za) * (i + 0.18) / n, t1 = za + (zb - za) * (i + 0.72) / n;
      boxTop(pile, cx - w, cx + w, y - 0.14, y - 0.02, t0, t1, [0.74, 0.74, 0.76]);
    }
  }

  function buildIron(pile) {
    var seg = TIER === 'low' ? 12 : 16, i;
    /* manholes: on the crown, where a real one is, off-centre and unlevel.
       The third one is the junction chamber -- every side street brings a
       connection in and it lands in the apron, which is why ref8 has two
       covers and a patch inside twenty metres. */
    var mh = [
      { x: RX0 + 12.0, z: RZC + 2.4 },
      { x: RX0 + 34.5, z: RZC - 1.2 },
      { x: RX0 + 66.0, z: RZC + 1.6 }
    ];
    for (i = 0; i < mh.length; i++) {
      var r = m(0.32);                                    /* 640 mm cover */
      disc(pile, mh[i].x, roadY(mh[i].z) + 0.02, mh[i].z, r, seg, [0.80, 0.79, 0.80], -0.012);
      mh[i].r = r;
    }
    /* a water valve box in the north paving, clear of the throat */
    var vx = RX0 + 51.0, vz = BOXD.z0 + 4.4;
    disc(pile, vx, PAVE_Y + 0.015, vz, m(0.13), 10, [0.84, 0.83, 0.84], -0.006);
    /* gully gratings at the kerb line. The junction takes two extra: the
       apron drains to the corners and nowhere else, which is why the ruts
       hold water for a week (see roadTone's puddle field). */
    gully(pile, RX0 + 5.0, 'N');
    gully(pile, RX0 + 40.0, 'N');
    gully(pile, THRD.x1 + 5.5, 'S');
    gully(pile, RX0 + 70.0, 'S');
    return mh;
  }

  /* --- the painted marks (_ref/ref8) --------------------------------------
     Placed, not scattered: an arrow on the westbound approach where the lane
     centre is, a surveyor's cross out on the apron, the ghost of a give-way
     line across the mouth of the side street, and enough residue around them
     that the three do not look like three stickers. */
  function buildPaintMarks(pile) {
    if (!PAINT.mat) return;
    var i, sd;
    /* the westbound lane centre. Driving on the right, west is the NORTH half
       of a 6.86 m carriageway, so the arrow sits between the crown and the
       north kerb. rot = PI/2 puts the tile's own "up" at -X, i.e. west. */
    var lane = (RZ0 + RZC) * 0.5;
    var ax = clamp(THRD.x0 + 4.0, RX0 + 5, RX1 - 8);
    pdecal(pile, ax, lane + 0.4, m(0.55), m(1.60), PI * 0.5, P_ARROW, [1.0, 1.0, 1.0]);
    /* residue where the tail of the arrow used to be */
    for (i = 0; i < 4; i++) {
      sd = 3701 + i * 13;
      pdecal(pile, ax + m(1.6) + 1.2 + i * 2.1, lane + 0.4 + (rnd(sd, 401) - 0.5) * 1.6,
        m(0.42), m(0.42), rnd(sd, 409) * PI, P_WEAR, [1, 1, 1]);
    }
    /* the surveyor's cross, out on the open apron */
    pdecal(pile, RX0 + 7.5, RZC + 4.6, m(0.48), m(0.48), 0.09, P_CROSS, [1, 1, 1]);
    /* the give-way line at the mouth of the side street, 0.4 m back from the
       channel, in dashes with two of them gone entirely */
    if (GROUND.hasThroat) {
      var gz = RZ0 - 1.7, n = 7;
      for (i = 0; i < n; i++) {
        sd = 3801 + i * 17;
        if (rnd(sd, 419) < 0.26) continue;
        var gx = lerp(THRD.x0 + 1.4, THRD.x1 - 1.4, (i + 0.5) / n);
        pdecal(pile, gx, gz + (rnd(sd, 421) - 0.5) * 0.35, m(0.24), m(0.22), 0,
          P_BAR, [1, 1, 1]);
      }
    }
  }

  /* =======================================================================
     SECTION 12 -- decals: the story pass.
     Ranked by contribution, exactly as the brief ranks them: tar seams and
     patch edges first, then ground-line splash, oil under the parked cars,
     tyre scuff at the kerb, cracks off the manholes, the hard AO footprint
     under each car, drain streaks, and grit and leaf litter in the gutter.
     ==================================================================== */

  /* a wobbling chain of quads down a path -- the shape every tar seam has */
  function seam(pile, x0, z0, x1, z1, width, tile, tone, sd, wob) {
    var dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.2) return;
    dx /= len; dz /= len;
    var n = Math.max(1, Math.round(len / 2.6)), i;
    var px = x0, pz = z0;
    for (i = 1; i <= n; i++) {
      var t = i / n;
      var nx = x0 + (x1 - x0) * t, nz = z0 + (z1 - z0) * t;
      if (i < n) {
        var w = (rnd(sd + i * 3, 103) - 0.5) * (wob === undefined ? 1.5 : wob);
        nx += -dz * w; nz += dx * w;
      }
      var mx = (px + nx) * 0.5, mz = (pz + nz) * 0.5;
      var sl = Math.sqrt((nx - px) * (nx - px) + (nz - pz) * (nz - pz));
      var ang = Math.atan2(nz - pz, nx - px);
      /* the tile draws its band along v, so the quad is rotated 90 deg and
         hw/hh swap: hw is the seam WIDTH, hh half the segment length */
      gdecal(pile, mx, mz, width * 0.5, sl * 0.5 + 0.06, ang + PI * 0.5, tile, tone,
        undefined, (i & 1) === 1);
      px = nx; pz = nz;
    }
  }

  function buildDecals(wet, dry, patches, mh, runsN, runsS) {
    var i, j, k, sd, x, z;
    var D = DENSITY;
    var TAR = [0.98, 0.98, 1.0], PALE = [1.05, 1.04, 1.02];

    /* --- 1. patch edges and their tar seams ----------------------------- */
    for (i = 0; i < patches.length; i++) {
      var p = patches[i];
      if (p.gen === PATCH_BASE) continue;
      sd = 601 + i * 17;
      /* the sealed lip on all four sides */
      var eW = 0.55;
      seam(dry, p.x0, p.z0 + 0.1, p.x0, p.z1 - 0.1, eW, D_PATCHEDGE, TAR, sd, 0.35);
      seam(dry, p.x1, p.z0 + 0.1, p.x1, p.z1 - 0.1, eW, D_PATCHEDGE, TAR, sd + 1, 0.35);
      if (p.z0 > RZ0 + 0.4) seam(dry, p.x0, p.z0, p.x1, p.z0, eW, D_PATCHEDGE, TAR, sd + 2, 0.35);
      if (p.z1 < RZ1 - 0.4) seam(dry, p.x0, p.z1, p.x1, p.z1, eW, D_PATCHEDGE, TAR, sd + 3, 0.35);
      /* over-banded in hot bitumen, 60-100 mm wide */
      var tw = m(0.06) + rnd(sd, 107) * m(0.04);
      seam(wet, p.x0, p.z0 + 0.15, p.x0, p.z1 - 0.15, tw, D_TARSEAM, TAR, sd + 5, 0.5);
      seam(wet, p.x1, p.z0 + 0.15, p.x1, p.z1 - 0.15, tw, D_TARSEAM, TAR, sd + 6, 0.5);
      if (p.z0 > RZ0 + 0.4) seam(wet, p.x0 + 0.1, p.z0, p.x1 - 0.1, p.z0, tw, D_TARSEAM, TAR, sd + 7, 0.5);
      if (p.z1 < RZ1 - 0.4) seam(wet, p.x0 + 0.1, p.z1, p.x1 - 0.1, p.z1, tw, D_TARSEAM, TAR, sd + 8, 0.5);
      /* the newest ones still read as a dark smooth panel */
      if (p.gen >= PATCH_RECENT) {
        var nx2 = Math.max(1, Math.round((p.x1 - p.x0) / 7)), nz2 = Math.max(1, Math.round((p.z1 - p.z0) / 7));
        for (j = 0; j < nx2; j++) for (k = 0; k < nz2; k++) {
          gdecal(wet, lerp(p.x0, p.x1, (j + 0.5) / nx2), lerp(p.z0, p.z1, (k + 0.5) / nz2),
            (p.x1 - p.x0) / nx2 * 0.62, (p.z1 - p.z0) / nz2 * 0.62,
            rnd(sd + j * 3 + k, 109) < 0.5 ? 0 : PI * 0.5, D_PATCH,
            p.gen === PATCH_FRESH ? [0.94, 0.94, 0.96] : [1.02, 1.02, 1.03]);
        }
      }
    }

    /* --- 2. the long snaking seams that belong to no patch --------------- */
    var nSeam = Math.round(9 * D);
    for (i = 0; i < nSeam; i++) {
      sd = 811 + i * 23;
      var sx0 = RX0 + rnd(sd, 113) * 74, slen = 8 + rnd(sd, 127) * 34;
      var sz = RZ0 + 1.2 + rnd(sd, 131) * (RZ1 - RZ0 - 2.4);
      var ang = (rnd(sd, 137) - 0.5) * 0.5;
      var ex = Math.min(RX1 - 0.5, sx0 + slen), ez = clamp(sz + Math.sin(ang) * slen, RZ0 + 0.8, RZ1 - 0.8);
      seam(wet, sx0, sz, ex, ez, m(0.07) + rnd(sd, 139) * m(0.03), D_TARSEAM, TAR, sd, 2.1);
    }
    /* two transverse ones -- a service crossing is always at right angles */
    for (i = 0; i < 2; i++) {
      sd = 907 + i * 29;
      x = RX0 + 18 + i * 33 + rnd(sd, 149) * 9;
      seam(wet, x, RZ0 + 0.4, x + (rnd(sd, 151) - 0.5) * 2.2, RZ1 - 0.4, m(0.08), D_TARSEAM, TAR, sd, 0.9);
    }

    /* --- 3. under the parked cars --------------------------------------- */
    for (i = 0; i < BAYFP.length; i++) {
      var f = BAYFP[i];
      sd = 1009 + i * 31;
      var cxm = (f.x0 + f.x1) * 0.5, czm = (f.z0 + f.z1) * 0.5;
      STATS.bays++;
      if (!f.road) continue;   /* pits and the island are not parking bays */
      /* one contact patch per car, sized to the body it belongs under */
      gdecal(wet, cxm, czm, (f.x1 - f.x0) * 0.50, (f.z1 - f.z0) * 0.52, 0, D_CARAO, [1, 1, 1]);
      /* the drip patch: sump, gearbox, and the puddle the differential makes */
      var nOil = 1 + Math.round(rnd(sd, 157) * 1.4 * D);
      for (j = 0; j < nOil; j++) {
        gdecal(wet, lerp(f.x0 + 2.5, f.x1 - 2.5, rnd(sd + j, 163)),
          lerp(f.z0 + 1.2, f.z1 - 1.2, rnd(sd + j, 167)),
          0.8 + rnd(sd + j, 173) * 1.1, 0.7 + rnd(sd + j, 179) * 0.9,
          rnd(sd + j, 181) * PI, D_OIL, [1, 1, 1]);
      }
      /* tyre scuff where the wheel has been kerbed */
      if (rnd(sd, 191) < 0.62) {
        var kz = f.north ? RZ0 + 0.5 : RZ1 - 0.5;
        gdecal(wet, cxm + (rnd(sd, 193) - 0.5) * 6, kz, 2.4, 0.55, 0, D_SCUFF, [1, 1, 1]);
      }
    }

    /* --- 4. the manholes: cracks radiating from the frame ---------------- */
    for (i = 0; i < mh.length; i++) {
      gdecal(dry, mh[i].x, mh[i].z, mh[i].r * 2.6, mh[i].r * 2.6,
        rnd(200 + i, 197) * PI, D_MANCRACK, [1, 1, 1]);
    }

    /* --- 5. the gutter line: grit, silt, leaf litter, standing damp ------ */
    var GUTW = 1.15;
    for (var side = 0; side < 2; side++) {
      var gz = side === 0 ? RZ0 + GUTW * 0.55 : RZ1 - GUTW * 0.55;
      var n2 = Math.round(22 * D);
      for (i = 0; i < n2; i++) {
        sd = 1201 + side * 97 + i * 37;
        if (rnd(sd, 191) < 0.26) continue;               /* leave real gaps */
        x = RX0 + (i + (rnd(sd, 199) - 0.5) * 2.2) * (RX1 - RX0) / n2;
        var w2 = 1.4 + rnd(sd, 211) * 3.4;
        gdecal(dry, x, gz + (rnd(sd, 223) - 0.5) * 1.1, w2, GUTW * (0.35 + rnd(sd, 227) * 0.5),
          0, D_GRIT, [1, 1, 1], undefined, side === 1);
        if (rnd(sd, 229) < 0.45 * D)
          gdecal(dry, x + (rnd(sd, 233) - 0.5) * 3, gz + (rnd(sd, 239) - 0.5) * 0.9,
            1.0 + rnd(sd, 241) * 1.6, 0.7 + rnd(sd, 251) * 0.8, rnd(sd, 257) * PI, D_LEAF, [1, 1, 1]);
        if (rnd(sd, 263) < 0.40 * D)
          gdecal(wet, x + (rnd(sd, 269) - 0.5) * 4, gz + (rnd(sd, 271) - 0.5) * 0.7,
            1.8 + rnd(sd, 277) * 2.4, 0.9 + rnd(sd, 281) * 0.7, 0, D_DAMP, [1, 1, 1]);
      }
      /* tyre rubber laid on the kerb face itself */
      var nS = Math.round(9 * D);
      for (i = 0; i < nS; i++) {
        sd = 1301 + side * 89 + i * 41;
        x = RX0 + rnd(sd, 283) * (RX1 - RX0);
        var sN = side === 0;
        if (sN && GROUND.hasThroat && x > THRD.x0 - 1 && x < THRD.x1 + 1) continue;
        var fz2 = sN ? RZ0 : RZ1, nrmz = sN ? 1 : -1;
        var ky = kerbTopAt(x, sN ? 'N' : 'S');
        var fh = ky - roadY(fz2);
        if (fh < 0.10) continue;                 /* nothing to scuff on flush */
        decal(wet, x, ky - fh * 0.45, fz2 + nrmz * 0.045, 0, 0, nrmz, 1, 0, 0,
          1.1 + rnd(sd, 293) * 1.6, fh * 0.30, ATLAS.rect[D_SCUFF], [1, 1, 1]);
        if (rnd(sd, 307) < 0.34)
          decal(dry, x, ky - fh * 0.3, fz2 + nrmz * 0.05, 0, 0, nrmz, 1, 0, 0,
            0.5, fh * 0.34, ATLAS.rect[D_SPALL], [1, 1, 1]);
      }
    }

    /* --- 5b. the junction: the throat, the dropped kerb, the island ------ */
    if (GROUND.hasThroat) {
      /* the channel behind the flush kerb is the lowest thing at the junction
         and everything the side street washes down ends in it */
      var nT = Math.round(14 * D);
      for (i = 0; i < nT; i++) {
        sd = 2401 + i * 43;
        x = lerp(THRD.x0 + 0.6, THRD.x1 - 0.6, rnd(sd, 431));
        z = RZ0 - 1.0 - rnd(sd, 433) * 1.5;
        gdecal(dry, x, z, 1.2 + rnd(sd, 439) * 2.6, 0.6 + rnd(sd, 443) * 0.6, 0,
          D_GRIT, [1, 1, 1]);
        if (rnd(sd, 449) < 0.55 * D)
          gdecal(wet, x + (rnd(sd, 457) - 0.5) * 3, z - 0.6,
            1.6 + rnd(sd, 461) * 2.2, 0.8 + rnd(sd, 463) * 0.6, 0, D_DAMP, [1, 1, 1]);
      }
      /* the throat itself: leaf litter, road film and the tyre scrub of every
         vehicle that has turned out of it */
      var nT2 = Math.round(16 * D);
      for (i = 0; i < nT2; i++) {
        sd = 2503 + i * 47;
        x = lerp(THRD.x0 + 0.8, THRD.x1 - 0.8, rnd(sd, 467));
        z = lerp(THRD.z0 + 0.6, THRD.z1 - 0.8, rnd(sd, 479));
        gdecal(dry, x, z, 1.6 + rnd(sd, 487) * 2.4, 1.2 + rnd(sd, 491) * 1.8,
          rnd(sd, 499) * PI, (i % 3 === 0) ? D_LEAF : D_SMEAR, [1, 1, 1]);
      }
      for (i = 0; i < 5; i++) {
        sd = 2591 + i * 53;
        x = lerp(THRD.x0 + 2.0, THRD.x1 - 2.0, rnd(sd, 503));
        gdecal(wet, x, RZ0 - 0.2 + (rnd(sd, 509) - 0.5) * 1.6, 2.4 + rnd(sd, 521) * 2.0,
          0.8, rnd(sd, 523) * 0.5 - 0.25, D_SCUFF, [1, 1, 1]);
      }
    }
    /* the mud every wheel that clips the island tracks out of it. A ring of
       warm grit round the kerb and two long smears off the nose, which is the
       end the traffic actually hits. */
    if (ISLFP) {
      var MUD = [1.24, 1.10, 0.90];
      var nI = Math.round(18 * D);
      for (i = 0; i < nI; i++) {
        sd = 2701 + i * 59;
        var a = rnd(sd, 541) * TAU;
        var rr = 1.05 + rnd(sd, 547) * 0.55;
        x = ISLFP.cx + Math.cos(a) * (ISLFP.x1 - ISLFP.x0) * 0.5 * rr;
        z = ISLFP.cz + Math.sin(a) * (ISLFP.z1 - ISLFP.z0) * 0.5 * rr * 0.92;
        gdecal(dry, x, z, 1.0 + rnd(sd, 557) * 2.0, 0.7 + rnd(sd, 563) * 1.2,
          rnd(sd, 569) * PI, rnd(sd, 571) < 0.5 ? D_GRIT : D_SMEAR, MUD);
      }
      for (i = -1; i <= 1; i += 2) {
        sd = 2801 + (i + 1) * 31;
        gdecal(dry, ISLFP.noseX - 3.4, ISLFP.cz + i * 2.1, 3.6, 1.0,
          i * 0.10, D_SMEAR, MUD);
        gdecal(wet, ISLFP.noseX - 1.6, ISLFP.cz + i * 1.7, 2.2, 0.7, i * 0.14,
          D_SCUFF, [1, 1, 1]);
      }
      /* and the tufts and litter that collect against the kerb inside it */
      var nIS = Math.round(14 * D);
      for (i = 0; i < nIS; i++) {
        sd = 2903 + i * 61;
        var a2 = rnd(sd, 577) * TAU, r2 = 0.42 + rnd(sd, 587) * 0.42;
        x = ISLFP.cx + Math.cos(a2) * (ISLFP.x1 - ISLFP.x0) * 0.5 * r2;
        z = ISLFP.cz + Math.sin(a2) * (ISLFP.z1 - ISLFP.z0) * 0.5 * r2;
        gdecal(dry, x, z, 0.7 + rnd(sd, 593) * 1.1, 0.5 + rnd(sd, 599) * 0.8,
          rnd(sd, 601) * PI, rnd(sd, 607) < 0.5 ? D_LEAF : D_MOSS, [1, 1, 1],
          ISLFP.soilAt(x, z));
      }
    }
    /* the tree pits: bare compacted soil, moss in the shade of the wall */
    for (i = 0; i < GROUND.pits.length; i++) {
      var P = GROUND.pits[i];
      sd = 3001 + i * 67;
      gdecal(dry, (P.x0 + P.x1) * 0.5, (P.z0 + P.z1) * 0.5,
        (P.x1 - P.x0) * 0.46, (P.z1 - P.z0) * 0.46, 0, D_GRIT,
        [1.14, 1.08, 0.96], P.soilY);
      gdecal(dry, lerp(P.x0, P.x1, rnd(sd, 613)), lerp(P.z0, P.z1, rnd(sd, 617)),
        (P.x1 - P.x0) * 0.34, (P.z1 - P.z0) * 0.30, rnd(sd, 619) * PI, D_LEAF,
        [1, 1, 1], P.soilY);
      gdecal(dry, lerp(P.x0, P.x1, rnd(sd, 631)), lerp(P.z0, P.z1, rnd(sd, 641)),
        (P.x1 - P.x0) * 0.30, (P.z1 - P.z0) * 0.26, rnd(sd, 643) * PI, D_MOSS,
        [1, 1, 1], P.soilY);
    }

    /* --- 6. the wall line: splash soiling, moss, downpipe discharge ------ */
    var walls = [
      { z: BOXD.z0, dir: 1, runs: runsN, side: 'N' },
      { z: BOXD.z1, dir: -1, runs: runsS, side: 'S' }
    ];
    for (var w2i = 0; w2i < walls.length; w2i++) {
      var W = walls[w2i];
      var nW = Math.round(26 * D);
      for (i = 0; i < nW; i++) {
        sd = 1409 + w2i * 71 + i * 43;
        x = RX0 + (i + rnd(sd, 311) * 0.85) * (RX1 - RX0) / nW;
        /* the bridge band's face is a wall too, but the ground under it is
           asphalt at road level, not paving -- the splash there belongs to
           the throat pass */
        if (W.side === 'N' && inGap('N', x)) continue;
        var band = 1.0 + rnd(sd, 313) * 1.3;
        /* FLAT ON THE PAVING. The wall itself belongs to FACADE. */
        gdecal(dry, x, W.z + W.dir * band * 0.55, 1.8 + rnd(sd, 317) * 2.6, band * 0.55,
          W.dir > 0 ? 0 : PI, D_SPLASH, [1, 1, 1], PAVE_Y);
        if (rnd(sd, 331) < 0.55 * D)
          gdecal(dry, x + (rnd(sd, 337) - 0.5) * 2.5, W.z + W.dir * (0.35 + rnd(sd, 347) * 1.4),
            0.7 + rnd(sd, 349) * 1.1, 0.5 + rnd(sd, 353) * 0.8, rnd(sd, 359) * PI, D_MOSS,
            [1, 1, 1], PAVE_Y);
      }
      /* moss and jointing weed against the back of the kerb too */
      var kIn = W.side === 'N' ? RZ0 - KERB_W - 0.35 : RZ1 + KERB_W + 0.35;
      var nK = Math.round(14 * D);
      for (i = 0; i < nK; i++) {
        sd = 1511 + w2i * 67 + i * 47;
        x = RX0 + rnd(sd, 367) * (RX1 - RX0);
        if (W.side === 'N' && inGap('N', x)) continue;
        gdecal(dry, x, kIn + (rnd(sd, 373) - 0.5) * 0.5, 0.8 + rnd(sd, 379) * 1.4, 0.35 + rnd(sd, 383) * 0.4,
          0, D_MOSS, [1, 1, 1], PAVE_Y);
      }
      /* where a downpipe discharges. FACADE has not published its pipes when
         this runs, so the fallback is a plausible rhythm; the late pass
         re-places them on real facade ends if NZ.street.facades arrives. */
      var nD = 6;
      for (i = 0; i < nD; i++) {
        sd = 1601 + w2i * 53 + i * 59;
        x = RX0 + 6 + i * 14 + rnd(sd, 389) * 4;
        if (W.side === 'N' && inGap('N', x)) continue;
        gdecal(dry, x, W.z + W.dir * 1.5, 1.0, 1.5, W.dir > 0 ? 0 : PI, D_STREAK, [1, 1, 1], PAVE_Y);
      }
    }

    /* --- 6a. the gardens that swallowed the footway --------------------- */
    /* Bare earth is not a tone, it is a texture: gravel, clinker, dead leaf
       litter and moss in the shade of the wall. Without this the earth runs
       are a smooth brown field, which is the same failure the old grey one
       had in a different colour. */
    var eruns = [{ runs: runsN, side: 'N' }, { runs: runsS, side: 'S' }];
    for (var eri = 0; eri < eruns.length; eri++) {
      var ER = eruns[eri].runs;
      for (i = 0; i < ER.length; i++) {
        var er = ER[i];
        if (!er.earth) continue;
        var nE = Math.max(4, Math.round((er.x1 - er.x0) * 0.85 * D));
        for (j = 0; j < nE; j++) {
          sd = 1621 + eri * 61 + i * 97 + j * 37;
          x = lerp(er.x0 + 0.5, er.x1 - 0.5, rnd(sd, 401));
          z = lerp(er.earth.z0 + 0.4, er.earth.z1 - 0.4, rnd(sd, 409));
          var kind = rnd(sd, 419);
          gdecal(dry, x, z, 1.1 + rnd(sd, 421) * 2.4, 0.8 + rnd(sd, 431) * 1.8,
            rnd(sd, 433) * PI,
            kind < 0.44 ? D_GRIT : (kind < 0.74 ? D_LEAF : D_MOSS),
            kind < 0.44 ? [1.18, 1.12, 0.98] : [1, 1, 1], PAVE_Y);
        }
      }
    }

    /* --- 6b. the vehicle crossovers ------------------------------------ */
    for (i = 0; i < CROSS.length; i++) {
      var C = CROSS[i];
      sd = 1651 + i * 83;
      var north = C.side === 'N';
      var wz0 = north ? BOXD.z0 + 0.6 : RZ1 + KERB_W;
      var wz1 = north ? RZ0 - KERB_W : BOXD.z1 - 0.6;
      var cxc = (C.x0 + C.x1) * 0.5;
      /* two tracks a Sahin's width apart, worn across the paving */
      for (j = -1; j <= 1; j += 2) {
        var tx = cxc + j * m(0.66);
        gdecal(dry, tx, (wz0 + wz1) * 0.5, 0.55, (wz1 - wz0) * 0.5, PI * 0.5,
          D_SMEAR, [0.90, 0.90, 0.92], PAVE_Y);
      }
      gdecal(dry, cxc, (wz0 + wz1) * 0.5, (C.x1 - C.x0) * 0.5, (wz1 - wz0) * 0.42, 0,
        D_GRIT, [1, 1, 1], PAVE_Y);
      /* the kerb takes a beating where the wheels ride over it */
      var kfz = north ? RZ0 : RZ1, kn = north ? 1 : -1;
      decal(dry, cxc + (rnd(sd, 191) - 0.5) * 2.5, KERB_DROP - 0.10, kfz + kn * 0.05,
        0, 0, kn, 1, 0, 0, 0.7, 0.12, ATLAS.rect[D_SPALL], [1, 1, 1]);
      gdecal(wet, cxc, kfz + kn * 1.1, (C.x1 - C.x0) * 0.42, 0.7, 0, D_SCUFF, [1, 1, 1]);
    }

    /* --- 7. connective tissue: cracks and road film on the carriageway --- */
    var nC = Math.round(8 * D);
    for (i = 0; i < nC; i++) {
      sd = 1709 + i * 61;
      x = RX0 + rnd(sd, 397) * (RX1 - RX0);
      z = RZ0 + 0.8 + rnd(sd, 401) * (RZ1 - RZ0 - 1.6);
      gdecal(dry, x, z, 1.4 + rnd(sd, 409) * 2.0, 1.4 + rnd(sd, 419) * 1.8,
        rnd(sd, 421) * PI, D_CRACK, [1, 1, 1]);
    }
    var nM = Math.round(18 * D);
    for (i = 0; i < nM; i++) {
      sd = 1811 + i * 67;
      x = RX0 + rnd(sd, 431) * (RX1 - RX0);
      z = RZ0 + 0.6 + rnd(sd, 433) * (RZ1 - RZ0 - 1.2);
      gdecal(dry, x, z, 2.6 + rnd(sd, 439) * 4.2, 2.2 + rnd(sd, 443) * 3.6,
        rnd(sd, 449) * PI, D_SMEAR, [1, 1, 1]);
    }
    /* and the far end of the throat, under the bridge band, which is where
       everything the side street brings down finally stops */
    if (GROUND.hasThroat) {
      for (i = 0; i < Math.round(9 * D); i++) {
        sd = 1901 + i * 71;
        x = THRD.x0 + 1 + rnd(sd, 457) * (THRD.x1 - THRD.x0 - 2);
        z = THRD.z0 + 0.5 + rnd(sd, 461) * 2.6;
        gdecal(dry, x, z, 1.4 + rnd(sd, 463) * 1.8, 1.0 + rnd(sd, 467) * 1.2,
          rnd(sd, 479) * PI, i & 1 ? D_LEAF : D_GRIT, [1, 1, 1]);
      }
    }
  }

  /* =======================================================================
     SECTION 13 -- weeds in the joints.
     An alpha-cutout atlas of four sprigs, two crossed cards per tuft. Early
     spring: dull, half-dead, more straw than green -- summer foliage would
     read as a different place (STREET-BRIEF section 1). They stand at most
     0.9 u (260 mm) and never leave the wall line or the kerb line, so nothing
     the player walks through is taller than the grass it pretends to be.
     ==================================================================== */
  var WEED = { tex: null, rect: [], mat: null };
  function buildWeedAtlas() {
    var res = TIER === 'low' ? 128 : 256, N = 2, ts = res / N;
    var c = NZ.tex.canvasOf(res), g = c.getContext('2d', { willReadFrequently: true });
    var R = NZ.tex.mulberry32(SEED + 1777);
    g.clearRect(0, 0, res, res);
    var HUE = ['rgba(96,104,64,1)', 'rgba(118,118,78,1)', 'rgba(78,88,56,1)', 'rgba(126,116,84,1)'];
    var i, t;
    for (t = 0; t < 4; t++) {
      var ox = (t % N) * ts, oy = Math.floor(t / N) * ts;
      g.save();
      g.beginPath(); g.rect(ox, oy, ts, ts); g.clip();
      g.translate(ox + ts * 0.5, oy + ts * 0.98);
      g.lineCap = 'round';
      var n = 15 + Math.round(R() * 9);
      for (i = 0; i < n; i++) {
        var a = -PI * 0.5 + (R() - 0.5) * 1.7;
        var L = ts * (0.42 + R() * 0.48);
        g.strokeStyle = HUE[(R() * 4) | 0];
        g.lineWidth = ts * (0.014 + R() * 0.016);
        g.beginPath(); g.moveTo((R() - 0.5) * ts * 0.24, 0);
        g.quadraticCurveTo(Math.cos(a) * L * 0.5, -L * 0.55,
                           Math.cos(a) * L * (0.8 + R() * 0.5), -L * (0.85 + R() * 0.2));
        g.stroke();
      }
      g.restore();
      var pad = ts * 0.01;
      WEED.rect[t] = [(ox + pad) / res, 1 - (oy + ts - pad) / res,
                      (ox + ts - pad) / res, 1 - (oy + pad) / res];
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = ANISO;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    OWN.tex.push(tex);
    STATS.texBytes += res * res * 4 * 1.34;
    WEED.tex = tex;
    var mat = new THREE.MeshStandardMaterial({
      map: tex, alphaTest: 0.42, side: THREE.DoubleSide,
      roughness: 0.92, metalness: 0.0, vertexColors: true, dithering: true, fog: true
    });
    stDay(mat, { name: 'ground-weed', intensity: 0.9 });
    OWN.mat.push(mat);
    WEED.mat = mat;
    return mat;
  }

  function weedCard(pile, cx, cy, cz, w, h, rot, rect, tone) {
    var ux = Math.cos(rot), uz = Math.sin(rot);
    var pts = [
      [cx - ux * w, cy, cz - uz * w], [cx + ux * w, cy, cz + uz * w],
      [cx + ux * w, cy + h, cz + uz * w], [cx - ux * w, cy + h, cz - uz * w]
    ];
    var uv = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
    var base = pile.n, i;
    var nx = -uz, nz = ux;
    for (i = 0; i < 4; i++) {
      /* the base of a tuft is in shade, the tip is in the sky: that fake
         wrap gradient is most of what makes a card read as volume */
      var k = (i < 2 ? 0.58 : 1.0);
      pile.vert(pts[i][0], pts[i][1], pts[i][2], nx, 0, nz, uv[i][0], uv[i][1],
        tone[0] * k, tone[1] * k, tone[2] * k);
    }
    pile.tri(base, base + 1, base + 2);
    pile.tri(base, base + 2, base + 3);
    STATS.weeds++;
  }

  function tuft(pile, x, z, y, scale, sd) {
    var t = (rnd(sd, 487) * 4) | 0;
    var w = (0.35 + rnd(sd, 491) * 0.30) * scale;
    var h = (0.50 + rnd(sd, 499) * 0.42) * scale;
    var rot = rnd(sd, 503) * PI;
    var g = 0.86 + rnd(sd, 509) * 0.26;
    var tone = [g * 1.0, g * 1.02, g * 0.9];
    weedCard(pile, x, y, z, w, h, rot, WEED.rect[t], tone);
    weedCard(pile, x, y, z, w * 0.86, h * 0.9, rot + PI * 0.5, WEED.rect[(t + 1) & 3], tone);
  }

  function buildWeeds(pile, runsN, runsS) {
    var i, j, side, sd, x, z;
    var D = DENSITY;
    var W = [{ z: BOXD.z0, dir: 1, kerb: RZ0 - KERB_W, runs: runsN, side: 'N' },
             { z: BOXD.z1, dir: -1, kerb: RZ1 + KERB_W, runs: runsS, side: 'S' }];
    for (side = 0; side < 2; side++) {
      var S = W[side];
      var n = Math.round(38 * D);
      for (i = 0; i < n; i++) {
        sd = 2101 + side * 83 + i * 73;
        x = RX0 + rnd(sd, 521) * (RX1 - RX0);
        if (S.side === 'N' && inGap('N', x)) continue;
        /* THE PLINTH RESERVE. FACADE owns the wall plane from y = 0 up and its
           plinth projects off it; a 0.26 m tuft standing 0.04 u off the plane
           would grow straight through the render. The wall-line band starts
           outside PLINTH and runs to 1.15. */
        if (rnd(sd, 523) < 0.62) z = S.z + S.dir * (PLINTH + 0.04 + rnd(sd, 541) * 0.52);
        else z = S.kerb - S.dir * (0.10 + rnd(sd, 547) * 0.45);                    /* kerb back  */
        tuft(pile, x, z, PAVE_Y - 0.02, 0.75 + rnd(sd, 557) * 0.5, sd);
      }
      /* and the garden ground that swallowed the footway */
      for (i = 0; i < S.runs.length; i++) {
        var r = S.runs[i];
        if (!r.earth) continue;
        var ne = Math.round((r.x1 - r.x0) * 1.9 * D);
        for (j = 0; j < ne; j++) {
          sd = 2203 + side * 79 + i * 89 + j * 97;
          x = lerp(r.x0 + 0.4, r.x1 - 0.4, rnd(sd, 563));
          z = lerp(r.earth.z0 + 0.3, r.earth.z1 - 0.3, rnd(sd, 569));
          tuft(pile, x, z, PAVE_Y - 0.03, 0.85 + rnd(sd, 571) * 0.7, sd);
        }
      }
    }
    /* --- the island: scruffy grass, thinner over the bare patches and
       thinnest in the middle, where the conifer PROPS plants has taken the
       light and the root plate has taken the soil. */
    if (ISLFP) {
      var nG = Math.round(150 * D), cx = ISLFP.cx, cz = ISLFP.cz;
      var hx = (ISLFP.x1 - ISLFP.x0) * 0.5 - ISLFP.width - 0.35;
      var hz = (ISLFP.z1 - ISLFP.z0) * 0.5 - ISLFP.width - 0.35;
      for (i = 0; i < nG; i++) {
        sd = 2311 + i * 101;
        var a = rnd(sd, 577) * TAU, rr = Math.sqrt(rnd(sd, 587));
        x = cx + Math.cos(a) * hx * rr;
        z = cz + Math.sin(a) * hz * rr;
        /* stay inside the taper at the nose, and clear of the planting circle */
        var q = clamp((x - ISLFP.noseX) / ((ISLFP.x1 - ISLFP.noseX) || 1), 0, 1);
        if (Math.abs(z - cz) > hz * (0.16 + 0.84 * smooth(q))) continue;
        var pd = Math.sqrt((x - ISLFP.plant.x) * (x - ISLFP.plant.x) + (z - ISLFP.plant.z) * (z - ISLFP.plant.z));
        if (pd < 0.85) continue;
        if (rnd(sd, 593) > 0.30 + 0.70 * smooth(clamp((vnoise(x * 0.46 + 3.9, z * 0.46 + 21.3) - 0.34) * 2.4, 0, 1))) continue;
        tuft(pile, x, z, ISLFP.soilAt(x, z) - 0.02, 0.70 + rnd(sd, 599) * 0.62, sd);
      }
    }
    /* --- and the tree pits */
    for (i = 0; i < GROUND.pits.length; i++) {
      var P = GROUND.pits[i];
      var np = Math.round(7 * D);
      for (j = 0; j < np; j++) {
        sd = 2417 + i * 103 + j * 107;
        x = lerp(P.x0 + 0.25, P.x1 - 0.25, rnd(sd, 601));
        z = lerp(P.z0 + 0.25, P.z1 - 0.25, rnd(sd, 607));
        tuft(pile, x, z, P.soilY - 0.02, 0.70 + rnd(sd, 613) * 0.55, sd);
      }
    }
  }

  /* =======================================================================
     SECTION 14 -- build, merge, install.
     Six or seven draw calls for the whole ground plane. One material per
     pile: a pile has one index buffer and one material, and that constraint
     is the whole reason for this grouping.
     ==================================================================== */
  var PILES = null, MESHES = null, MATS = null;

  function deriveCrossovers() {
    var out = [], i;
    /* THE JUNCTION THROAT. Not a driveway: the kerb line goes to FLUSH across
       the whole mouth, and `nowalk` keeps it out of walkY() because there is
       no pavement behind it to ramp down -- those cells are painted road. */
    if (GROUND.hasThroat)
      out.push({ x0: THRD.x0, x1: THRD.x1, side: 'N', src: 'throat',
                 top: KERB_FLUSH, ramp: 3.0, nowalk: true, kerbSelf: true });
    /* the building entrance the street terminates at */
    var s = ST();
    var door = (s && s.DOOR) || { x0: 240, x1: 244 };
    out.push({ x0: door.x0 - 0.5, x1: door.x1 + 0.5, side: 'N', src: 'door' });
    /* whatever FACADE has published, if it has run yet */
    var F = (s && s.facades) || [];
    for (i = 0; i < F.length; i++) {
      var f = F[i];
      if (!f || !f.entrance) continue;
      var sd2 = (f.side === 'S') ? 'S' : (f.side === 'N' ? 'N' : null);
      if (!sd2) continue;
      var w = fin(f.entrance.width, 3.5) * 0.5 + 0.8;
      out.push({ x0: f.entrance.x - w, x1: f.entrance.x + w, side: sd2, src: 'facade' });
    }
    /* deterministic garden gates, so the street still reads correctly when
       NZ.street.facades is empty (it is, at default priority: FACADE's script
       tag comes after this one). None of them lands on the junction apron --
       nobody has a gate onto a junction. */
    var gates = [[RX0 + 40.0, 'N'], [RX0 + 62.0, 'N'], [RX0 + 34.0, 'S'], [RX0 + 71.0, 'S']];
    for (i = 0; i < gates.length; i++) {
      if (inGap(gates[i][1], gates[i][0])) continue;
      out.push({ x0: gates[i][0] - 2.0, x1: gates[i][0] + 2.0, side: gates[i][1], src: 'gate' });
    }
    return out;
  }

  function buildAll() {
    PILES = {
      road: new Pile(TILE_ROAD),
      paver: new Pile(TILE_PAVER),
      conc: new Pile(TILE_CONC),
      iron: new Pile(TILE_IRON),
      paint: new Pile(1),
      wet: new Pile(1), dry: new Pile(1), weed: new Pile(1)
    };
    STATS.decals = 0; STATS.patches = 0; STATS.kerbUnits = 0; STATS.weeds = 0;
    STATS.bays = 0; STATS.pits = 0; STATS.paint = 0;
    ISLFP = null; GROUND.ISLAND = null; GROUND.pits = [];

    syncGeometry();
    GROUND.hasThroat = throatOpen();

    /* THE SCAN, not the list. Three kinds of S_BLOCK now share one rule, and
       only the classifier in scanBays() tells them apart -- so if the
       orchestrator moves a bay, drops a pit or slides the island, everything
       below follows without an edit here. */
    var bays = scanBays(), i, pits = [];
    GROUND.bays = bays;
    BAYFP.length = 0;
    for (i = 0; i < bays.length; i++) {
      if (bays[i].kind === 'island' || bays[i].kind === 'barrier') continue;
      if (bays[i].kind === 'pit') { pits.push(bays[i]); continue; }
      var f = bayFootprint(bays[i]);
      f.road = true;
      BAYFP.push(f);
    }
    STATS.pits = pits.length;

    CROSS = deriveCrossovers();
    GROUND.crossovers = CROSS;

    /* the island first: roadTone() reads its footprint for the mud halo */
    PILES.conc.context(TILE_CONC);
    buildIsland(PILES.conc, PILES.conc);

    var patches = buildRoad(PILES.road);

    PILES.conc.context(TILE_CONC);
    buildKerbs(PILES.conc);
    if (solidCell(Math.floor(RX0 / 4) - 1, Math.floor(RZC / 4))) buildKerbEnd(PILES.conc, RX0, 1);
    if (solidCell(Math.floor(RX1 / 4), Math.floor(RZC / 4))) buildKerbEnd(PILES.conc, RX1, -1);

    var runsN = buildWalk(PILES.paver, PILES.conc, 'N');
    var runsS = buildWalk(PILES.paver, PILES.conc, 'S');
    buildPits(PILES.conc, PILES.conc, pits);

    PILES.iron.context(TILE_IRON);
    var mh = buildIron(PILES.iron);

    buildPaintMarks(PILES.paint);
    buildDecals(PILES.wet, PILES.dry, patches, mh, runsN, runsS);
    if (WEED.mat) buildWeeds(PILES.weed, runsN, runsS);
  }

  function makeMesh(pile, mat, name, bakeOpts, order) {
    if (!pile || pile.empty() || !mat) {
      DIAG.piles.push({ name: name, tris: 0, verts: 0, added: false });
      return null;
    }
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

  /* --- what stands over this ground, for the sky module's bake -------------
     escapes() models the canyon analytically and knows nothing about the two
     block masses either side of the junction throat, nor about the bridge
     band that spans it -- and the band is the reason the throat reads as a
     slot rather than as more sky. THE BAND STARTS AT y = 28: below that the
     side street is open air for its whole length, which is exactly what the
     sky module's own throat exception models, so an occluder that closed the
     throat from the ground up would fight it and put the junction apron back
     in shadow.
     The kerb noses and the island go in as low boxes: they are the contact
     term along the gutter line and around the teardrop, and at low tier this
     bake is the only ambient occlusion in the frame. */
  function groundOccluders() {
    var occ = [
      /* the blocks either side of the throat, full height */
      { x0: BOXD.x0 - 40, x1: THRD.x0, y0: 0, y1: 52, z0: 112, z1: BOXD.z0 },
      { x0: THRD.x1, x1: BOXD.x1 + 40, y0: 0, y1: 52, z0: 112, z1: BOXD.z0 },
      /* the bridge band spanning the side street, from its soffit up */
      { x0: THRD.x0, x1: THRD.x1, y0: 28, y1: 52, z0: BOXD.z0 - 14, z1: BOXD.z0 },
      /* the kerb noses: N in two pieces, because the throat breaks it */
      { x0: BOXD.x0, x1: THRD.x0, y0: -2, y1: KERB_Y, z0: BOXD.z0, z1: RZ0 },
      { x0: THRD.x1, x1: BOXD.x1, y0: -2, y1: KERB_Y, z0: BOXD.z0, z1: RZ0 },
      { x0: BOXD.x0, x1: BOXD.x1, y0: -2, y1: KERB_Y, z0: RZ1, z1: BOXD.z1 }
    ];
    if (!GROUND.hasThroat) {
      occ[3] = { x0: BOXD.x0, x1: BOXD.x1, y0: -2, y1: KERB_Y, z0: BOXD.z0, z1: RZ0 };
      occ.splice(4, 1);
    }
    if (ISLFP)
      occ.push({ x0: ISLFP.x0 + 0.2, x1: ISLFP.x1 - 0.15, y0: -2, y1: ISL_KERB_Y,
                 z0: ISLFP.z0 + 0.5, z1: ISLFP.z1 - 0.5 });
    return occ;
  }

  function meshAll() {
    var occ = groundOccluders();
    var bk = { rays: RAYS, occluders: occ };
    MESHES = {};
    MESHES.road = makeMesh(PILES.road, MATS.road, 'nzground-road', bk);
    MESHES.paver = makeMesh(PILES.paver, MATS.paver, 'nzground-paving', bk);
    MESHES.conc = makeMesh(PILES.conc, MATS.conc, 'nzground-kerb', bk);
    MESHES.iron = makeMesh(PILES.iron, MATS.iron, 'nzground-ironwork', bk);
    /* paint under the grime, grime over everything: renderOrder 1/2/3 */
    MESHES.paint = makeMesh(PILES.paint, PAINT.mat, 'nzground-roadpaint', { rays: Math.min(RAYS, 16), occluders: occ }, 1);
    MESHES.wet = makeMesh(PILES.wet, MATS.wet, 'nzground-decal-bitumen', { rays: Math.min(RAYS, 24), occluders: occ }, 2);
    MESHES.dry = makeMesh(PILES.dry, MATS.dry, 'nzground-decal-grime', { rays: Math.min(RAYS, 24), occluders: occ }, 3);
    MESHES.weed = makeMesh(PILES.weed, WEED.mat, 'nzground-weeds', { rays: Math.min(RAYS, 18), occluders: occ });
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
    var cy0 = Math.floor(BOXD.z0 / 4), cy1 = Math.ceil(BOXD.z1 / 4) - 1;
    var cx0 = Math.floor(BOXD.x0 / 4), cx1 = Math.ceil(BOXD.x1 / 4) - 1;
    for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
      var R = regionAt(cx, cy);
      if (R && R.sky && openCell(G.cellAt(cx, cy))) return true;
    }
    return false;
  }

  function buildMaterials() {
    MATS = {
      /* ENV IS THE OTHER HALF OF THE PAVER FIX and it is not a fudge.
         Dropping the paver albedo alone could not reach the reference ratio,
         because roughly half of what the footway was putting on screen did
         not come from its albedo at all: with the probe attached, every
         surface gets a dielectric specular lobe off a 2.0-radiance sky, and
         measured, a paver at albedo ZERO would still have rendered at lum
         ~110 against a road at 131. That sheen is real on the damp asphalt --
         the brief asks for it there, "a very weak sky reflection along the
         wheel tracks" -- and it is wrong on dry, dusty, 25-year-old kilit
         tasi, which is matte. So the road keeps its 0.92 and the footway
         drops to 0.55: the reflection goes where the water is. */
      road: groundMaterial('asphalt', TILE_ROAD, { tint: 0xffffff, nrm: 1.00, env: 0.92, ao: 1.0 }),
      paver: groundMaterial('paver', TILE_PAVER, { tint: 0xffffff, nrm: 1.00, env: 0.55, ao: 1.15 }),
      conc: groundMaterial('gconc', TILE_CONC, { tint: 0xffffff, nrm: 1.00, env: 0.62, ao: 1.10 }),
      iron: groundMaterial('iron', TILE_IRON, { tint: 0xffffff, nrm: 1.00, env: 1.1, ao: 1.0 }),
      /* the roughness split is the only material read a decal can carry:
         bitumen, fresh patching, oil and damp are SMOOTHER than the road and
         grit, splash and moss are rougher. One atlas, two materials, and the
         wheel tracks and tar seams pick up the weak sky reflection the brief
         asks for without a mirror anywhere. */
      wet: decalMaterial(0.44, 'ground-decal-bitumen'),
      dry: decalMaterial(0.95, 'ground-decal-grime')
    };
  }

  function install(ctx) {
    if (dead || installed) return;
    if (NZ.level !== undefined && NZ.level !== 1 && NZ.level !== 4) {
      NZ.log && NZ.log('street-ground: level ' + NZ.level + ', module inert');
      return;
    }
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
    renderer = (ctx && ctx.renderer) || (NZ.ctx && NZ.ctx.renderer);
    if (!THREE || !scene || !renderer) throw new Error('nz-street-ground: renderer context missing');
    if (!NZ.tex || !NZ.tex.canvasOf) throw new Error('nz-street-ground: NZ.tex unavailable');

    G = bindGame();
    if (!G) { NZ.log && NZ.log('street-ground: level globals unavailable, module inert'); return; }
    if (!hasStreet()) { NZ.log && NZ.log('street-ground: carve not present, module inert'); return; }
    if (!ST()) warn('NZ.street missing -- running without the daylight probe or the overcast bake');

    applyTier();
    SUNNY = (NZ.level === 4);        /* mission 4 daylight exposure profile */
    try { ANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy()); } catch (e) { ANISO = 8; }

    syncGeometry();
    buildAtlas();
    buildPaintAtlas();
    buildWeedAtlas();
    buildMaterials();
    buildAll();
    meshAll();

    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
    STATS.ms = Math.round(t1 - t0);
    installed = true;
    GROUND.ok = true;
    NZ.flags.streetGround = true;
    NZ.log && NZ.log('street-ground installed: tier=' + TIER + ' draws +' + STATS.addedCalls +
      ' tris ' + STATS.tris + ' patches ' + STATS.patches + ' decals ' + STATS.decals +
      ' in ' + STATS.ms + 'ms');
    /* A module that cannot see the screen has to prove itself in the log. NZ.log
       is a no-op without ?nzdebug=1 (nz-core.js:29-30) and the headless harness
       only surfaces warn/error, so the full ledger goes out on the one channel
       that reaches a critic -- and only when debugging was asked for. */
    /* scripts/render-level.mjs only surfaces a console line whose TEXT matches
       /error|fail|panic|threw|missing/, so the `threw:0` marker is what makes a
       self-report visible in a shot log at all. Same convention as FACADE. */
    if (NZ.debug || DIAGON) {
      try {
        var RL = report().split('\n');
        for (var ri = 0; ri < RL.length; ri++) console.warn('[nz-ground] threw:0 ' + RL[ri]);
      } catch (e) { console.warn('[nz-street-ground] report threw: ' + (e && e.message)); }
    }
    if (DIAGON) installOverlay();
  }

  /* -----------------------------------------------------------------------
     The late pass. FACADE's script tag comes AFTER this one, so at the
     default hook priority NZ.street.facades is necessarily still empty --
     nz-core sorts hooks descending and every module registers at 0, which
     makes the firing order the script-tag order (STREET-MODULE-CONTRACT
     section 5). This second listener at -900 runs after every street module
     and before nz-render's -1000 sweep, reads the gate and entrance positions
     FACADE has by then published, and if any of them is not already served by
     a dropped kerb it rebuilds the paving and kerb piles around it.

     Rebuilding, rather than appending, because a Pile is one index buffer and
     one material: there is no way to add to a BufferGeometry that has already
     been uploaded, and a second mesh would be a seventh draw call for four
     crossovers. The material sets are cached, so a rebuild is geometry and
     one vertex bake -- tens of milliseconds, once, and only when it is
     actually needed.
     -------------------------------------------------------------------- */
  var rebuilt = false;
  function lateAdjust() {
    if (dead || !installed || lateDone) return;
    lateDone = true;
    var s = ST();
    var F = (s && s.facades) || [];
    if (!F.length || rebuilt) return;
    var want = deriveCrossovers(), i, j, added = 0;
    for (i = 0; i < want.length; i++) {
      if (want[i].src !== 'facade') continue;
      var hit = false;
      for (j = 0; j < CROSS.length; j++) {
        if (CROSS[j].side !== want[i].side) continue;
        if (want[i].x0 < CROSS[j].x1 + 1.5 && want[i].x1 > CROSS[j].x0 - 1.5) { hit = true; break; }
      }
      if (!hit) added++;
    }
    if (!added) { NZ.log && NZ.log('street-ground: facades published, all ' + F.length +
      ' entrances already served by a crossover'); return; }
    rebuilt = true;
    clearMeshes();
    buildAll();
    meshAll();
    NZ.log && NZ.log('street-ground: rebuilt for ' + added + ' facade crossover(s); draws +' + STATS.addedCalls);
  }

  /* ---- teardown ---------------------------------------------------------- */
  function panic(err) {
    if (dead) return;
    dead = true;
    NZ.flags.streetGround = false;
    GROUND.ok = false;
    if (err) { try { console.error('[nz-street-ground] disabled after error:', err); } catch (e) {} }
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
      ATLAS.tex = null; WEED.tex = null; WEED.mat = null;
      PAINT.tex = null; PAINT.mat = null; PAINT.rect.length = 0;
      ISLFP = null; GROUND.ISLAND = null; GROUND.pits = [];
      installed = false;
    } catch (e4) { try { console.error('[nz-street-ground] teardown failed:', e4); } catch (e5) {} }
  }

  /* ---- self-report ------------------------------------------------------- */
  function pad(s2, n) { s2 = String(s2); while (s2.length < n) s2 += ' '; return s2; }
  function report() {
    var L = [], i;
    L.push('NZ-STREET-GROUND tier=' + TIER + ' install=' + STATS.ms + 'ms vram~' +
      (STATS.texBytes / 1048576).toFixed(1) + 'MB');
    for (i = 0; i < DIAG.sets.length; i++) {
      var b = DIAG.sets[i];
      L.push('  set ' + pad(b.name, 10) + b.res + 'px rgb ' + b.rgb.join(',') +
        ' lum ' + pad(b.lum.toFixed(0), 4) + ' tile ' + pad(b.refTile, 5) +
        ' relief ' + b.reliefMM + 'mm (swing ' + b.swingMM + 'mm)' + (b.black ? '  <<< BLACK' : ''));
    }
    for (i = 0; i < DIAG.piles.length; i++) {
      var p = DIAG.piles[i];
      L.push('  pile ' + pad(p.name, 26) + ' tris ' + pad(String(p.tris), 7) +
        ' verts ' + pad(String(p.verts), 7) + (p.added ? '' : ' (EMPTY - not added)'));
    }
    L.push('  road patches ' + STATS.patches + '  kerb units ' + STATS.kerbUnits +
      '  bays ' + STATS.bays + '  pits ' + STATS.pits + '  decals ' + STATS.decals +
      '  paint ' + STATS.paint + '  weeds ' + STATS.weeds);
    L.push('  road z [' + RZ0 + ',' + RZ1 + '] crown ' + RZC + '  walk N [' + BOXD.z0 + ',' +
      (RZ0 - KERB_W) + '] S [' + (RZ1 + KERB_W) + ',' + BOXD.z1 + ']' +
      '  throat ' + (GROUND.hasThroat ? ('x[' + THRD.x0 + ',' + THRD.x1 + '] z[' + THRD.z0 + ',' + THRD.z1 + ']') : 'none'));
    if (ISLFP) L.push('  island ring x[' + ISLFP.noseX.toFixed(2) + ',' +
      (ISLFP.x1 - 0.17).toFixed(2) + '] centre ' + ISLFP.cx.toFixed(1) + ',' + ISLFP.cz.toFixed(1) +
      ' kerbTop ' + ISLFP.kerbTop + ' soil ' + ISLFP.soilY +
      ' plant ' + ISLFP.plant.x.toFixed(2) + ',' + ISLFP.plant.z.toFixed(2) + ' r ' + ISLFP.plant.r);
    L.push('  crossovers ' + GROUND.crossovers.length + '  draws +' + STATS.addedCalls +
      '  tris ' + STATS.tris + '  verts ' + STATS.verts);
    if (DIAG.warnings.length) {
      L.push('WARNINGS (' + DIAG.warnings.length + '):');
      for (i = 0; i < DIAG.warnings.length; i++) L.push('  ! ' + DIAG.warnings[i]);
    }
    return L.join('\n');
  }
  GROUND.report = report;

  var DIAGON = /[?&]nzdiag=1/.test(global.location ? global.location.search : '');
  var overlay = null;
  function installOverlay() {
    try {
      if (overlay || !global.document || !document.body) return;
      overlay = document.createElement('div');
      overlay.id = 'nzground-diag';
      overlay.style.cssText = 'position:fixed;right:0;top:0;max-height:52vh;max-width:min(760px,46vw);' +
        'overflow:auto;z-index:99996;background:rgba(6,8,10,.92);color:#c8b48f;' +
        'font:11px/1.35 Consolas,monospace;padding:6px 8px;white-space:pre;' +
        'border-bottom:2px solid #8d7a4f;border-left:2px solid #8d7a4f;pointer-events:none';
      overlay.textContent = report();
      document.body.appendChild(overlay);
    } catch (e) { /* diagnostics must never break the game */ }
  }

  /* ---- hooks -------------------------------------------------------------
     NO PRIORITY ARGUMENT. nz-core.js:43 sorts (a,b) => b.p - a.p, i.e.
     DESCENDING, so the negative priorities in STREET-MODULE-CONTRACT section 2
     would have run the five street modules backwards. Every module registers
     at the default p = 0 and relies on Array.prototype.sort being stable,
     which makes the firing order identical to the script-tag order:
     nz-render, nz-env, sky, GROUND, facade, entrance, props.
     The second listener at -900 is the facade-crossover pass (section 14);
     it lands after all of them and still ahead of nz-render's -1000 sweep. */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); }
    catch (err) { panic(err); }
  });

  NZ.on('ready', function () {
    if (dead) return;
    try { lateAdjust(); }
    catch (err) { warn('late crossover pass failed: ' + (err && err.message)); }
  }, -900);

  NZ.log && NZ.log('street-ground module loaded');
})(typeof window !== 'undefined' ? window : this);
