/* ===========================================================================
   NZ-APC -- ZIRHLI DEVRIYE ARACI, the cordon's armoured patrol car.

   A self-contained classic-script vehicle module. It owns exactly one enemy
   kind, `apc`, and touches nothing else. Everything a wheeled machine needs
   and a biped does not lives here: the chassis, the road network, the driver,
   the suspension, the remote weapon station and the wreck.

   WHAT IT IS
   ----------
   A 4x4 mine-protected patrol vehicle in the Otokar Cobra II mould, which is
   the vehicle that would actually be sitting on a cordon in Seydisehir:

       length        5.60 m      19.60 u        wheelbase   3.30 m   11.55 u
       width         2.50 m       8.75 u        track       2.05 m    7.18 u
       roof          2.20 m       7.70 u        tyre OD     1.10 m    3.85 u
       over RCWS     2.75 m       9.62 u        clearance   0.42 m    1.47 u
       kerb weight  ~12 t                       top speed  110 km/h

   Every dimension below is written `metres * M` with the millimetre value in
   the comment, the same discipline NUKEM.html uses, so a wrong figure is
   legible on the page instead of only in a render.

   WHY IT IS NOT A BIPED WITH WHEELS DRAWN ON
   ------------------------------------------
   The stock locomotion is a velocity slew: `accel` caps how fast the velocity
   VECTOR may change, in any direction, and `e.face` is slewed independently.
   That is exactly right for a man, who can step sideways, and exactly wrong
   for a car, which cannot. So this module takes `enemyDrive` and integrates a
   kinematic bicycle model instead -- speed along the heading, heading changed
   only by steering while rolling, a real turning circle, and a real reverse
   gear. The brain above it is untouched: it still writes `a.mvx/a.mvz` and
   `a.faceWant` and this module reads them as "where the commander wants to
   be" and "where the gunner is looking", which is the correct division of
   labour between a crew and a vehicle.

   THE FOUR SEAMS INTO NUKEM.html
   ------------------------------
     enemyDrive     (enemyLocomote)  -- we move and turn the actor ourselves
     enemyRayTest   (hitscan)        -- oriented-box narrow phase, so the
                                        corners of a 5.6 m cylinder are not
                                        shootable air
     enemyHitZone   (enemyHitZone)   -- armour is not a headshot table
     render                          -- chassis animation, audio, wreck
   plus the three rig hooks every character module takes. Remove this file and
   `apc` simply never spawns; nothing else changes.

   KILL SWITCH: ?nzapc=0
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;
  if (NZ.flags && NZ.flags.apc === undefined) NZ.flags.apc = false;

  var QS = '';
  try { QS = (global.location && global.location.search) || ''; } catch (e) { QS = ''; }
  if (/[?&]nzapc=(0|off|no)/i.test(QS)) {
    if (NZ.log) NZ.log('apc disabled by query string');
    return;
  }
  var DEBUG = /[?&]nzapc=(debug|2)/i.test(QS);

  var THREE = null;
  var INSTALLED = false;
  var DEAD = false;
  var RIGS = [];
  var PI = Math.PI, TAU = PI * 2;

  /* ------------------------------------------------------------ maths ---- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function fin(v, f) { return (typeof v === 'number' && isFinite(v)) ? v : f; }
  function damp(a, b, rate, dt) { return b + (a - b) * Math.pow(rate, dt); }
  function rr(a, b) { return a + Math.random() * (b - a); }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  /* approach `b` from `a` by at most `d` -- the honest way to rate-limit a
     control input, as opposed to an exponential that never actually arrives */
  function toward(a, b, d) { var k = b - a; return Math.abs(k) <= d ? b : a + (k < 0 ? -d : d); }
  function towardAng(a, b, d) { var k = wrap(b - a); return Math.abs(k) <= d ? wrap(b) : wrap(a + (k < 0 ? -d : d)); }

  /* ------------------------------------------------------------ scale ---- */
  var M = 3.5;                      /* world units per metre, NUKEM.html:378  */
  var CELL = 4;                     /* world units per grid cell (1143 mm)    */

  /* ---------------------------------------------------------- the car ---- */
  var V = {
    LEN:    5.60 * 3.5,             /* 5600 mm nose to tail        = 19.600 u */
    WID:    2.50 * 3.5,             /* 2500 mm over the flares     =  8.750 u */
    ROOF:   2.20 * 3.5,             /* 2200 mm ground to roof      =  7.700 u */
    WB:     3.30 * 3.5,             /* 3300 mm wheelbase           = 11.550 u */
    TRACK:  2.05 * 3.5,             /* 2050 mm wheel centres       =  7.175 u */
    TYRE_R: 0.55 * 3.5,             /*  550 mm tyre radius         =  1.925 u */
    TYRE_W: 0.37 * 3.5,             /*  370 mm section width       =  1.295 u */
    CLR:    0.42 * 3.5,             /*  420 mm belly clearance     =  1.470 u */
    HULL_H: 1.24 * 3.5,             /* 1240 mm lower hull height   =  4.340 u */
    OVER:   2.75 * 3.5,             /* 2750 mm over the RCWS       =  9.625 u */
    /* the front axle sits 1150 mm behind the nose, so the overhangs are
       1150 front / 1150 rear on a 3300 wheelbase: 5600 total. */
    AX_F:   1.65 * 3.5,             /* front axle, +z from centre  =  5.775 u */
    AX_R:  -1.65 * 3.5,             /* rear axle                   = -5.775 u */
    /* Ackermann: 8.0 m kerb-to-kerb turning circle on a 3.30 m wheelbase is
       a 4.0 m turn radius at the centreline, i.e. atan(3.30/4.00) = 39.5 deg
       of inside lock. 34 degrees is the honest average of inside and outside
       and the number the bicycle model wants. */
    LOCK:   34 * PI / 180,
    /* WB / tan(LOCK) = 17.1 units = 4.9 m at the centreline, which for a 3.3 m
       wheelbase is right and is also the number the path tracker has to
       respect: ask for a tighter curve than this and the vehicle cannot
       produce it, however hard the wheel is turned. */
    TURN_R: (3.30 * 3.5) / Math.tan(34 * PI / 180),
    LOCK_RATE: 1.55,                /* rad/s at the roadwheel, ~2.2 turns L-L */
    /* 110 km/h flat out; a cordon patrol never uses it. 30.6 m/s = 107 u/s,
       but the drive model clamps to PATROL/PURSUE below. */
    VMAX:  30.6 * 3.5 / 1,
    ACC:    2.30 * 3.5,             /* 2.3 m/s^2 -- 12 tonnes, 360 hp         */
    BRK:    5.60 * 3.5,             /* 5.6 m/s^2 -- ABS-less, laden           */
    REV:    4.20 * 3.5,             /* reverse top speed, 15 km/h             */
    PATROL: 7.20 * 3.5,             /* 26 km/h -- what a patrol actually does */
    PURSUE:12.50 * 3.5,             /* 45 km/h -- closing on a contact        */
    /* the gun. 12.7x99, 545 rounds/min, 1.65 m over the roof line. */
    RCWS_Y: 2.24 * 3.5,             /* ring plane, 2240 mm                    */
    BARREL: 1.14 * 3.5              /* 1143 mm barrel + brake                 */
  };
  V.HALF_L = V.LEN * .5;
  V.HALF_W = V.WID * .5;

  /* Lane discipline. The carriageway on 233. Sokak is 24 units kerb to kerb
     (6860 mm) with its crown at z = 172, and Turkey drives on the right.

     4.2 units is 1.2 m right of the crown: it reads as keeping right and
     still leaves the hull about 7 units off each kerb. 5.6 -- where a real
     lane centre is -- was tried first, and it left a 19.6-unit hull roughly
     35 degrees of yaw budget before a corner reached the wall, which on
     232 Sk it repeatedly used up. A patrol vehicle on a closed street holding
     the middle third is both what one does and what survives its own
     steering. */
  var LANE = 4.2;

  /* The patrol's beat on 233. Sokak ends at the roundabout apron's east edge
     (grid column 144 ends at x = 580).  pickPatrolGoal never chooses a
     destination east of it while the crew does not know where the player
     is -- see THE BEAT there. */
  var PATROL_EAST_X = 580;

  /* ------------------------------------------------------- diagnostics --- */
  var STATS = {
    spawned: 0, routeNodes: 0, routeEdges: 0, routeDropped: 0,
    reversals: 0, kturns: 0, shots: 0, blocked: 0, pinned: 0, unwedged: 0, ms: 0
  };
  function warn(m) { if (NZ.log) NZ.log('[nz-apc] ' + m); }
  function panic(err) {
    if (DEAD) return;
    DEAD = true;
    try { console.error('[nz-apc] disabled:', err); } catch (e) {}
    if (NZ.flags) NZ.flags.apc = false;
  }

  /* =====================================================================
     SECTION 1 -- the game's lexical globals.

     Bound once at 'ready'. NUKEM.html's inline script is a classic script,
     so its top-level `const`/`function` declarations share a lexical scope
     with this file even though they are not properties of `window`; reading
     them through a thunk is the same trick nz-destruct.js uses. Every one is
     optional and a missing global demotes the feature that needed it rather
     than killing the module.
     ================================================================== */
  var G = null;
  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }

  function bindGlobals() {
    G = {
      grid:        tryGet(function () { return grid; }),
      MW:          tryGet(function () { return MW; }),
      MH:          tryGet(function () { return MH; }),
      CELL:        tryGet(function () { return CELL; }),
      CLIMB:       tryGet(function () { return CLIMB; }),
      blockedCell: tryGet(function () { return blockedCell; }),
      cellAt:      tryGet(function () { return cellAt; }),
      floorAt:     tryGet(function () { return floorAt; }),
      ceilAt:      tryGet(function () { return ceilAt; }),
      inb:         tryGet(function () { return inb; }),
      idx:         tryGet(function () { return idx; }),
      canStand:    tryGet(function () { return canStand; }),
      highestFloor:tryGet(function () { return highestFloor; }),
      enemies:     tryGet(function () { return enemies; }),
      player:      tryGet(function () { return player; }),
      moveSlide:   tryGet(function () { return moveSlide; }),
      shotLineClear: tryGet(function () { return shotLineClear; }),
      losGrid:     tryGet(function () { return losGrid; }),
      particle:    tryGet(function () { return particle; }),
      sparkBurst:  tryGet(function () { return sparkBurst; }),
      sparkAt:     tryGet(function () { return sparkAt; }),
      tracer:      tryGet(function () { return tracer; }),
      flashLight:  tryGet(function () { return flashLight; }),
      explode:     tryGet(function () { return explode; }),
      impactSurface: tryGet(function () { return impactSurface; }),
      sfx:         tryGet(function () { return sfx; }),
      aiNoise:     tryGet(function () { return aiNoise; }),
      damageEnemy: tryGet(function () { return damageEnemy; }),
      hurtPlayer:  tryGet(function () { return hurtPlayer; }),
      AU:          tryGet(function () { return AU; }),
      S_SOLID:     tryGet(function () { return S_SOLID; }),
      S_BLOCK:     tryGet(function () { return S_BLOCK; }),
      S_EXIT:      tryGet(function () { return S_EXIT; }),
      S_DOOR:      tryGet(function () { return S_DOOR; })
    };
    if (typeof G.CELL === 'number') CELL = G.CELL;
    var missing = [];
    var need = ['grid', 'MW', 'MH', 'blockedCell', 'floorAt', 'canStand', 'highestFloor', 'enemies', 'player'];
    for (var i = 0; i < need.length; i++) if (G[need[i]] === undefined) missing.push(need[i]);
    if (missing.length) { warn('missing game globals: ' + missing.join(', ')); return false; }
    return true;
  }

  /* ------------------------------------------------------ world probes --- */
  /* A vehicle is not a circle. `canStand` tests an axis-aligned square of
     cells around a radius, which for a 5.6 x 2.5 m hull is either a box that
     swallows the pavement or one that fits through a gap it cannot fit
     through. So the footprint is sampled as an oriented rectangle: five
     stations down the length, three across the width, every one of them a
     real cell query. 15 lookups is nothing next to being wrong. */
  var _fpX = new Float64Array(15), _fpZ = new Float64Array(15);
  var _fpLX = new Float64Array(15), _fpLZ = new Float64Array(15), _fpF = new Float64Array(15);
  var FP_L = [-1, -0.5, 0, 0.5, 1], FP_W = [-1, 0, 1];
  /* the two second moments of the sample grid, which is symmetric, so the
     least-squares plane below needs no matrix at all */
  var SXX = 0, SZZ = 0;

  /* THE COLLISION HULL IS NOT THE DRAWN HULL.

     The world is a 4-unit grid -- 1143 mm cells -- and a blocked cell is
     blocked in its entirety. The carriageway on 232. Sokak is six cells,
     6.86 m, and the vehicle is 2.50 m across; sampling the exact corners of
     the drawn box against that grid means a corner 10 mm inside a kerb cell
     refuses the whole cell, and since the pose it stopped in was legal while
     every pose 1 mm away is not, the vehicle wedges itself on a knife edge it
     cannot step off. Measured: both vehicles pinned, 11,952 refused steps,
     with hullFits reporting the pose they were standing in as fine.

     So the collision box is the drawn box less the corners it does not
     really have: 92% of the length and 80% of the width, i.e. 5.15 x 2.00 m.
     What that buys is 250 mm of overhang per flank -- the mirrors, the flare
     and the arch lip passing over a kerb, which is exactly what the drawn
     hull would do anyway and exactly the tolerance a 1143 mm grid demands.
     Every obstacle it is measured against is kerb furniture: a bin run, a
     builder's skip, market trestles, a dug-up carriageway. */
  var COL_L = 0.92, COL_W = 0.80;
  function footprint(x, z, ang, padL, padW) {
    var s = Math.sin(ang), c = Math.cos(ang);
    var hl = V.HALF_L * COL_L + (padL || 0), hw = V.HALF_W * COL_W + (padW || 0);
    var n = 0;
    SXX = 0; SZZ = 0;
    for (var i = 0; i < 5; i++) {
      var fz = FP_L[i] * hl;
      for (var j = 0; j < 3; j++) {
        var fx = FP_W[j] * hw;
        /* local (fx, fz) -> world, using the engine's own yaw convention:
           local +Z maps to (sin, cos) and local +X to (cos, -sin). */
        _fpX[n] = x + fx * c + fz * s;
        _fpZ[n] = z - fx * s + fz * c;
        _fpLX[n] = fx; _fpLZ[n] = fz;
        SXX += fx * fx; SZZ += fz * fz;
        n++;
      }
    }
    return n;
  }

  /* Can the hull stand here, and does it lie flat enough to drive on?

     THE MIN/MAX TRAP. The obvious test -- reject when the highest and lowest
     cell under the hull differ by more than a kerb -- fails on 233. Sokak,
     because the west half of the axis is a steady 7% grade down off Yildiz
     Tepesi and a 5.6 m hull standing on it legitimately spans 1.4 units of
     floor. Raising the threshold until the slope passes then lets the vehicle
     climb a 0.8 m step, which is worse.

     So fit a PLANE through the fifteen samples and judge the residual. The
     sample grid is symmetric about both axes, so the normal equations
     collapse to three sums and no matrix:

         a = SUM(lx*f)/SUM(lx^2)   b = SUM(lz*f)/SUM(lz^2)   c = mean(f)

     A uniform grade has a residual of nothing and is driven. A kerb, a stair
     nose or the foot of a wall is all residual and is refused. The gradient
     itself is then checked separately, against what the vehicle can actually
     climb -- 45%, which for a 360 hp mine-protected 4x4 is honest.

     Returns the plane height at the hull centre, which is where the vehicle
     would rest, or null. */
  var MAX_GRADE = 0.45;
  var FIT_WHY = null;                /* set only while a diagnostic is asking */
  var DIAG_BLOCK = /[?&]nzapc=(debug|2)/i.test(QS);
  var BLOCK_CELLS = {};
  function hullFits(x, z, ang, padL, padW, refY) {
    if (!G) return null;
    var n = footprint(x, z, ang, padL, padW), i;
    var sf = 0, sx = 0, sz = 0;
    for (i = 0; i < n; i++) {
      var cx = Math.floor(_fpX[i] / CELL), cy = Math.floor(_fpZ[i] / CELL);
      if (!G.inb(cx, cy)) { if (FIT_WHY) FIT_WHY.push('offmap ' + cx + ',' + cy); return null; }
      if (G.blockedCell(cx, cy)) { if (FIT_WHY) FIT_WHY.push('blocked ' + cx + ',' + cy + ' t=' + (G.cellAt ? G.cellAt(cx, cy) : '?')); return null; }
      var f = G.floorAt(cx, cy);
      if (!(f > -1e5 && f < 1e5)) { if (FIT_WHY) FIT_WHY.push('badfloor ' + cx + ',' + cy); return null; }
      _fpF[i] = f;
      sf += f; sx += _fpLX[i] * f; sz += _fpLZ[i] * f;
      /* headroom: a 2.75 m machine does not fit under a 2.2 m lintel, and
         this is the test that keeps it out of every doorway on the map. */
      if (G.ceilAt) {
        var ce = G.ceilAt(cx, cy);
        if (ce - f < V.OVER + .4) { if (FIT_WHY) FIT_WHY.push('lowceil ' + cx + ',' + cy + ' gap=' + (ce - f).toFixed(2)); return null; }
      }
    }
    var a = SXX > 1e-6 ? sx / SXX : 0;
    var b = SZZ > 1e-6 ? sz / SZZ : 0;
    var c = sf / n;
    if (a * a + b * b > MAX_GRADE * MAX_GRADE) {
      if (FIT_WHY) FIT_WHY.push('grade ' + Math.sqrt(a * a + b * b).toFixed(3));
      return null;
    }
    var climb = fin(G.CLIMB, 1.15), worst = 0;
    for (i = 0; i < n; i++) {
      var r = _fpF[i] - (a * _fpLX[i] + b * _fpLZ[i] + c);
      if (r < 0) r = -r;
      if (r > worst) worst = r;
    }
    if (worst > climb * 0.92) { if (FIT_WHY) FIT_WHY.push('step ' + worst.toFixed(2)); return null; }
    /* the plane at the hull centre is where it rests */
    if (refY !== undefined && refY !== null && Math.abs(c - refY) > climb * 1.9) {
      if (FIT_WHY) FIT_WHY.push('refY ' + c.toFixed(2) + ' vs ' + refY.toFixed(2));
      return null;
    }
    return c;
  }

  /* the single-point version, for wheels and probes */
  function groundAt(x, z, fallback) {
    if (!G) return fallback || 0;
    var cx = Math.floor(x / CELL), cy = Math.floor(z / CELL);
    if (!G.inb(cx, cy)) return fallback || 0;
    return G.floorAt(cx, cy);
  }
  function cellOpen(x, z) {
    if (!G) return false;
    var cx = Math.floor(x / CELL), cy = Math.floor(z / CELL);
    return G.inb(cx, cy) && !G.blockedCell(cx, cy);
  }

  /* =====================================================================
     SECTION 2 -- the road network.

     A vehicle does not path-find over the walk grid. It drives on roads, and
     on 233. Sokak the roads are already there: `buildStreetMap` carves a
     24-unit carriageway on the crown z = 172, a 24-unit crossing at x = 564
     with a planted island in the middle of it, and a second crossing at
     x = 776. That is a real network with two junctions and five dead ends,
     so this module authors it as a graph and drives it.

     WHY A GRAPH AND NOT THE NAV FIELD
     ---------------------------------
     NAV.walk is baked for a 0.6 m man. Nothing in it knows that a lane has a
     direction, that an island has a correct side, or that a 5.6 m hull cannot
     take a 90-degree corner it can stand in. Every one of those is a road
     fact, and road facts live on roads.

     THE ISLAND
     ----------
     The tree island at x 560..568, z 168..176 sits in a 32-unit apron. Twelve
     units of channel each side, for an 8.75-unit hull: it fits, with 0.93 m
     to spare. What does NOT fit is a circulating ring -- tangent to a
     10.8-unit ring the hull's outer corner lands 18.1 units out and the apron
     is only 16 -- so the junction is authored as four corner nodes threading
     the four channels instead, which is what a long vehicle actually does at
     a mini-roundabout. Right-hand traffic then falls out of the lane offset:
     eastbound passes south of the island, northbound passes west of it.
     ================================================================== */

  var ROAD = { nodes: [], byName: {}, ends: [], ready: false, level: 0 };

  /* name, x, z, laneK -- laneK scales the keep-right offset, and is 0 where
     the authored position IS the driving line (the junction channels). */
  var ROAD4 = [
    /* ---- 233. Sokak, the axis. Crown z = 172, kerbs at 160 and 184. The
       west half climbs the Yildiz Tepesi slope: floor 17.8 at x = 296 falling
       to 0.0 at the roundabout, a steady 7% grade the suspension can feel. */
    ['w0', 296, 172, 1], ['w1', 348, 172, 1], ['w2', 400, 172, 1],
    ['w3', 452, 172, 1], ['w4', 500, 172, 1], ['w5', 530, 172, 1],
    /* ---- the roundabout apron: four channel nodes around the tree island */
    ['jnw', 554, 162, 0], ['jne', 574, 162, 0],
    ['jse', 574, 183, 0], ['jsw', 554, 183, 0],
    /* ---- 233. Sokak east of the roundabout, past both Seydikent blocks */
    ['e0', 596, 172, 1], ['e1', 632, 172, 1], ['e2', 668, 172, 1],
    ['e3', 704, 172, 1], ['e4', 740, 172, 1],
    /* ---- the 230. Sokak crossing: a plain crossroads, no island */
    ['xj', 776, 172, .4],
    ['e5', 806, 172, 1], ['e6', 822, 172, 1],
    /* ---- 232. Sokak north arm, up past KIZILCALAR to the cemetery line.
       A bin run occupies the west kerb at z 72..88 and a builder's skip the
       east kerb at z 104..120: the clearance solver threads both. */
    ['n0', 564, 142, 1], ['n1', 564, 116, 1], ['n2', 564,  88, 1],
    ['n3', 564,  58, 1], ['n4', 564,  26, 1],
    /* ---- 232. Sokak south arm, down past DEGERLI to the police line */
    ['s0', 564, 200, 1], ['s1', 564, 228, 1], ['s2', 564, 256, 1],
    ['s3', 564, 282, 1],
    /* ---- 230. Sokak, both stubs, each ending at its own barricade */
    ['ne0', 776, 148, 1], ['ne1', 776, 128, 1],
    ['se0', 776, 198, 1], ['se1', 776, 228, 1]
  ];

  var LINK4 = [
    ['w0', 'w1'], ['w1', 'w2'], ['w2', 'w3'], ['w3', 'w4'], ['w4', 'w5'],
    ['w5', 'jnw'], ['w5', 'jsw'],
    ['jnw', 'jne'], ['jne', 'jse'], ['jse', 'jsw'], ['jsw', 'jnw'],
    ['jne', 'e0'], ['jse', 'e0'],
    ['e0', 'e1'], ['e1', 'e2'], ['e2', 'e3'], ['e3', 'e4'], ['e4', 'xj'],
    ['xj', 'e5'], ['e5', 'e6'],
    ['xj', 'ne0'], ['ne0', 'ne1'],
    ['xj', 'se0'], ['se0', 'se1'],
    ['jnw', 'n0'], ['jne', 'n0'],
    ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'],
    ['jsw', 's0'], ['jse', 's0'],
    ['s0', 's1'], ['s1', 's2'], ['s2', 's3']
  ];

  function buildRoad(level) {
    ROAD.nodes = []; ROAD.byName = {}; ROAD.ends = []; ROAD.ready = false;
    ROAD.level = level;
    if (level !== 4) return false;
    var i, j;
    for (i = 0; i < ROAD4.length; i++) {
      var d = ROAD4[i];
      var nd = { id: ROAD.nodes.length, name: d[0], x: d[1], z: d[2],
        laneK: d[3], y: 0, links: [], ok: true };
      ROAD.nodes.push(nd);
      ROAD.byName[d[0]] = nd;
    }
    for (i = 0; i < LINK4.length; i++) {
      var a = ROAD.byName[LINK4[i][0]], b = ROAD.byName[LINK4[i][1]];
      if (!a || !b) { warn('link to unknown node ' + LINK4[i].join('-')); continue; }
      if (a.links.indexOf(b.id) < 0) a.links.push(b.id);
      if (b.links.indexOf(a.id) < 0) b.links.push(a.id);
    }

    /* ---- validation. Every node is probed with the hull at the heading of
       each of its links; a node that fits at none of them is dropped and its
       links with it, because a route through a place the hull cannot occupy
       is a route into a wall. This is also the check that catches an authored
       coordinate that drifted when the map moved. */
    var dropped = 0;
    for (i = 0; i < ROAD.nodes.length; i++) {
      var n = ROAD.nodes[i];
      n.y = groundAt(n.x, n.z, 0);
      var fits = false;
      for (j = 0; j < n.links.length; j++) {
        var m = ROAD.nodes[n.links[j]];
        var ang = Math.atan2(m.x - n.x, m.z - n.z);
        if (hullFits(n.x, n.z, ang, 0, 0, null) !== null) { fits = true; break; }
      }
      /* a lone node with no link still deserves the axis-aligned probe */
      if (!fits && !n.links.length)
        fits = hullFits(n.x, n.z, 0, 0, 0, null) !== null || hullFits(n.x, n.z, PI / 2, 0, 0, null) !== null;
      if (!fits) {
        n.ok = false; dropped++;
        warn('road node "' + n.name + '" (' + n.x + ',' + n.z + ') does not admit the hull; dropped');
      }
    }
    if (dropped) {
      for (i = 0; i < ROAD.nodes.length; i++) {
        var nn = ROAD.nodes[i], keep = [];
        for (j = 0; j < nn.links.length; j++) if (ROAD.nodes[nn.links[j]].ok) keep.push(nn.links[j]);
        nn.links = keep;
      }
    }
    for (i = 0; i < ROAD.nodes.length; i++) {
      var e = ROAD.nodes[i];
      if (e.ok && e.links.length <= 1) ROAD.ends.push(e.id);
    }
    STATS.routeNodes = ROAD.nodes.length - dropped;
    STATS.routeEdges = LINK4.length;
    STATS.routeDropped = dropped;
    ROAD.ready = STATS.routeNodes > 3;
    if (DEBUG) warn('road: ' + STATS.routeNodes + ' nodes, ' + ROAD.ends.length + ' dead ends, ' + dropped + ' dropped');
    return ROAD.ready;
  }

  /* nearest usable node to a world point, optionally requiring line of sight */
  function nearestNode(x, z, exclude) {
    var best = -1, bd = 1e18;
    for (var i = 0; i < ROAD.nodes.length; i++) {
      var n = ROAD.nodes[i];
      if (!n.ok || n.id === exclude) continue;
      var dx = n.x - x, dz = n.z - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  }

  /* Breadth-first over the road graph. The network is 30 nodes; anything
     cleverer than a BFS would be showing off. `banFirst` forbids the first
     step so a vehicle asked to re-plan does not simply turn around on the
     spot, which is the one manoeuvre a 5.6 m hull cannot do. */
  var _bfsPrev = [], _bfsSeen = [], _bfsQ = [];
  function routeBetween(from, to, banFirst) {
    if (from < 0 || to < 0) return null;
    if (from === to) return [from];
    var n = ROAD.nodes.length, i;
    for (i = 0; i < n; i++) { _bfsPrev[i] = -1; _bfsSeen[i] = 0; }
    _bfsQ.length = 0; _bfsQ.push(from); _bfsSeen[from] = 1;
    var head = 0;
    while (head < _bfsQ.length) {
      var cur = _bfsQ[head++];
      var links = ROAD.nodes[cur].links;
      for (i = 0; i < links.length; i++) {
        var nx = links[i];
        if (_bfsSeen[nx]) continue;
        if (cur === from && banFirst !== undefined && nx === banFirst && links.length > 1) continue;
        _bfsSeen[nx] = 1; _bfsPrev[nx] = cur;
        if (nx === to) {
          var path = [to], p = cur;
          while (p !== from) { path.push(p); p = _bfsPrev[p]; }
          path.push(from); path.reverse();
          return path;
        }
        _bfsQ.push(nx);
      }
    }
    return null;
  }

  /* =====================================================================
     Turning a node path into a driving line.

     Three passes, in this order and for this reason:
       1. RESAMPLE at 6 units, so the pure-pursuit lookahead always has
          points to chew on and a 52-unit straight is not two points.
       2. KEEP RIGHT by `LANE` scaled by the segment's laneK, which is what
          puts the vehicle in its own lane on the straights and on the
          authored channel line through the junctions.
       3. SOLVE CLEARANCE laterally. The bin run, the builder's skip, the
          market trestles, the roadworks and the parked silver Courier all
          stand IN the carriageway. A driver goes round them; so does this.
          The solver walks outward from the wanted offset and keeps the first
          lateral position the hull actually fits in, which reproduces the
          swing-out-and-back that makes the manoeuvre read as driving rather
          than as clipping.
     ================================================================== */
  var RESAMPLE = 6.0;

  function pathToLine(path) {
    if (!path || path.length < 2) return null;
    var pts = [], i;
    /* --- 1. resample --- */
    for (i = 0; i < path.length - 1; i++) {
      var a = ROAD.nodes[path[i]], b = ROAD.nodes[path[i + 1]];
      var dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      var steps = Math.max(1, Math.round(L / RESAMPLE));
      for (var s = 0; s < steps; s++) {
        var t = s / steps;
        pts.push({
          x: a.x + dx * t, z: a.z + dz * t,
          lane: lerp(a.laneK, b.laneK, t),
          dx: dx / (L || 1), dz: dz / (L || 1)
        });
      }
    }
    var last = ROAD.nodes[path[path.length - 1]];
    var prev = ROAD.nodes[path[path.length - 2]];
    var lx = last.x - prev.x, lz = last.z - prev.z, lL = Math.hypot(lx, lz) || 1;
    pts.push({ x: last.x, z: last.z, lane: last.laneK, dx: lx / lL, dz: lz / lL });

    /* --- 2. keep right. In a Y-up world with x east and z south, the vector
       to the right of a heading (dx,dz) is (-dz, dx): head east and your
       right hand points south, which is the lane the eastbound carriageway
       actually is. --- */
    for (i = 0; i < pts.length; i++) {
      var p = pts[i];
      var off = LANE * p.lane;
      p.wx = p.x + (-p.dz) * off;
      p.wz = p.z + (p.dx) * off;
    }

    /* --- 3. smooth the lane line, BEFORE the clearance solve. Doing it
       afterwards averages every swing-out back into the obstacle it was
       there to avoid: measured, it put the northbound line 1.5 units inside
       the builder's skip on 232 Sk and stopped twelve tonnes dead against it.
       Endpoints are pinned -- a route that drifts off its own dead-end node
       is a route that parks in a barricade. --- */
    for (var sp0 = 0; sp0 < 2; sp0++) {
      for (i = 1; i < pts.length - 1; i++) {
        pts[i].wx = pts[i].wx * .5 + (pts[i - 1].wx + pts[i + 1].wx) * .25;
        pts[i].wz = pts[i].wz * .5 + (pts[i - 1].wz + pts[i + 1].wz) * .25;
      }
    }

    /* --- 4. lateral clearance solve --- */
    for (i = 0; i < pts.length; i++) {
      var q = pts[i];
      var ang = Math.atan2(q.dx, q.dz);
      var rx = -q.dz, rz = q.dx;
      var wantOff = LANE * q.lane;
      var found = null;

      /* SOLVE FOR CLEARANCE, NOT FOR A FIT.

         The obvious search takes the first lateral offset that admits the
         hull. What that produces is a line which is legal by a millimetre,
         and a vehicle cannot hold a line to a millimetre: measured, 16% of
         every integration step on a five-minute patrol was refused, and the
         worst offender was 232 Sk, where the search walked out to its own
         clamp and put the driving line 0.55 units off a solid wall.

         So MEASURE the clearance instead of testing for one. Each candidate
         offset is probed with a shrinking half-width allowance and scored by
         the largest one that still fits; the winner is the best score, with a
         small penalty for leaving the correct lane so that on an open street
         the answer is still keep-right. A tight gap is then taken in the
         middle of the gap, which is what a driver does. */
      /* The top of this ladder is deliberately wider than any street here
         needs: where a corridor CAN give the hull 2.6 units of air on both
         flanks it should, and the lane penalty (0.085 a unit, so 0.36 across
         the whole offset range) is far smaller than the 0.7 step between
         rungs. So an open street is driven keeping right and a pinched one is
         driven up the middle, and neither is a special case. */
      var PADS = [2.60, 1.90, 1.30, 0.80, 0.45];
      var bestScore = -1e9, bestPt = null;
      for (var k = -7; k <= 7; k++) {
        var o = wantOff + k * 1.6;
        if (o > 11.2 || o < -11.2) continue;
        var tx = q.x + rx * o, tz = q.z + rz * o;
        var margin = -1, gy2 = null;
        for (var pi = 0; pi < PADS.length; pi++) {
          var g3 = hullFits(tx, tz, ang, .7, PADS[pi], null);
          if (g3 !== null) { margin = PADS[pi]; gy2 = g3; break; }
        }
        if (margin < 0) continue;
        var sc = margin - Math.abs(o - wantOff) * .085;
        if (sc > bestScore) { bestScore = sc; bestPt = { x: tx, z: tz, y: gy2 }; }
      }
      found = bestPt;
      if (found) { q.wx = found.x; q.wz = found.z; q.y = found.y; }
      else { q.y = groundAt(q.wx, q.wz, 0); q.tight = true; }
    }

    /* --- 5. one light pass to take the staircase off the swing-outs, then
       every moved point re-checked: anything the smoothing pushed back into
       something is put straight back where the solver had it. --- */
    for (i = 1; i < pts.length - 1; i++) {
      var ox2 = pts[i].wx, oz2 = pts[i].wz;
      var nx2 = ox2 * .62 + (pts[i - 1].wx + pts[i + 1].wx) * .19;
      var nz2 = oz2 * .62 + (pts[i - 1].wz + pts[i + 1].wz) * .19;
      var ang2 = Math.atan2(pts[i].dx, pts[i].dz);
      if (hullFits(nx2, nz2, ang2, .7, .95, null) !== null) { pts[i].wx = nx2; pts[i].wz = nz2; }
    }
    /* cumulative arc length + per-point curvature, both wanted by the driver */
    var total = 0;
    for (i = 0; i < pts.length; i++) {
      if (i > 0) total += Math.hypot(pts[i].wx - pts[i - 1].wx, pts[i].wz - pts[i - 1].wz);
      pts[i].s = total;
    }
    for (i = 0; i < pts.length; i++) {
      var pa = pts[Math.max(0, i - 2)], pb = pts[i], pc = pts[Math.min(pts.length - 1, i + 2)];
      var a1 = Math.atan2(pb.wx - pa.wx, pb.wz - pa.wz);
      var a2 = Math.atan2(pc.wx - pb.wx, pc.wz - pb.wz);
      var seg = Math.hypot(pc.wx - pa.wx, pc.wz - pa.wz) || 1;
      pts[i].curv = Math.abs(wrap(a2 - a1)) / seg;
    }
    return { pts: pts, length: total, path: path };
  }

  /* =====================================================================
     SECTION 3 -- materials.

     Two rules, both learned off the street modules:

     * PANEL LINES ARE GEOMETRY, NOT TEXTURE. BoxGeometry gives every face a
       0..1 UV, so a drawn seam is a different width on the roof than on the
       flank. Every seam, weld, rivet, hinge and bolt below is a real box
       standing 0.02 proud of the plate it sits on -- which is also the rule
       that keeps it out of a depth fight with its own wall.
     * The maps are near-neutral RELIEF. Colour arrives as the material tone,
       so tinting the map as well would square the hue.

     Geometry and materials are shared across every spawn; an actor receives
     only its transform hierarchy and its own animation state.
     ================================================================== */
  var ASSETS = null;

  function bakeSet(key, specFn) {
    if (!NZ.tex || !NZ.tex.shared) return null;
    try { return NZ.tex.shared(key, specFn); }
    catch (e) { warn('bake "' + key + '" failed: ' + (e && e.message)); return null; }
  }

  function mat(name, o) {
    o = o || {};
    var p = {
      name: 'nzapc:' + name,
      color: o.color === undefined ? 0x6a6a52 : o.color,
      roughness: o.rough === undefined ? .78 : o.rough,
      metalness: o.metal === undefined ? .22 : o.metal,
      emissive: o.emissive || 0x000000,
      emissiveIntensity: o.ei || 0,
      dithering: true,
      fog: true
    };
    if (o.transparent) { p.transparent = true; p.opacity = o.opacity === undefined ? .5 : o.opacity; }
    if (o.set && NZ.tex && NZ.tex.applySet) {
      NZ.tex.applySet(p, o.set);
      if (o.set.roughnessMap) p.roughness = 1.0;
      if (o.set.metalnessMap) p.metalness = 1.0;
      /* the density scaling above takes uvs well past 1, so every map in the
         set has to wrap. These sets are keyed 'apc:*' and nothing else uses
         them, so setting it here is not reaching into somebody's texture. */
      var MK = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'];
      for (var mi = 0; mi < MK.length; mi++) {
        var tx = p[MK[mi]];
        if (tx && THREE.RepeatWrapping !== undefined) {
          tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
          tx.needsUpdate = true;
        }
      }
    }
    if (o.side && THREE) p.side = o.side;
    var m = new THREE.MeshStandardMaterial(p);
    /* On the cordon the whole street is lit by nz-street-sky's overcast probe
       and its daylight shader patch, and a dynamic vehicle standing in that
       street has to be handed the same probe or it reads as a prop lit for a
       different scene.

       BUT `direct` MUST BE 1 HERE. The patch's default is DAY_DIRECT_KILL =
       0.05, i.e. it throws away 95% of the direct light -- which is right for
       street geometry, because that geometry carries an overcast term baked
       into its vertex colours and the two would otherwise be counted twice.
       This vehicle has no bake. Take the default and it is lit by the
       environment probe alone: flat, dark, and several stops under everything
       it is parked next to. So it takes the probe and keeps the sun. */
    if (NZ.street && NZ.street.day && NZ.level === 4) {
      try {
        NZ.street.day(m, {
          name: 'apc-' + name,
          intensity: o.env === undefined ? .92 : o.env,
          direct: 1
        });
      } catch (e) {}
    }
    return m;
  }

  /* ---- the paint. Sand-khaki over a dust gradient, mottled so a 19-unit
     flank never reads as one flat swatch, with rain streaks down the sides
     and a hard dirt band up from the sills. --------------------------------*/
  function paintHull(g, res) {
    var i, x, y;
    /* mottle: broad, low-contrast blotches, the way a repainted panel sits
       slightly off the panel beside it */
    for (i = 0; i < 46; i++) {
      var r = res * (0.10 + Math.random() * 0.26);
      x = Math.random() * res; y = Math.random() * res;
      var gr = g.createRadialGradient(x, y, 0, x, y, r);
      var v = Math.random() < .5 ? 255 : 0;
      gr.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',0.026)');
      gr.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    /* dust settles up from the bottom of every panel */
    var dust = g.createLinearGradient(0, res, 0, res * 0.42);
    dust.addColorStop(0, 'rgba(196,178,142,0.40)');
    dust.addColorStop(0.45, 'rgba(190,174,142,0.14)');
    dust.addColorStop(1, 'rgba(190,174,142,0)');
    g.fillStyle = dust; g.fillRect(0, 0, res, res);
    /* Rain streaks, washed down off the sills. Kept few, short and faint:
       at 256 px across a 19.6-unit flank one strong streak is 40 mm wide and
       two metres long, and a hundred of them read as wood grain, not dirt. */
    for (i = 0; i < 46; i++) {
      x = Math.random() * res;
      var h = res * (0.06 + Math.random() * 0.26);
      var y0 = Math.random() * (res - h);
      var w = 0.7 + Math.random() * 1.5;
      var st = g.createLinearGradient(0, y0, 0, y0 + h);
      st.addColorStop(0, 'rgba(74,68,52,0.00)');
      st.addColorStop(0.30, 'rgba(74,68,52,' + (0.022 + Math.random() * 0.032).toFixed(3) + ')');
      st.addColorStop(1, 'rgba(74,68,52,0.00)');
      g.fillStyle = st; g.fillRect(x, y0, w, h);
    }
    /* scuffs and chips: bare metal showing where a shoulder or a kerb got it */
    for (i = 0; i < 30; i++) {
      x = Math.random() * res; y = Math.random() * res;
      g.fillStyle = 'rgba(158,152,138,' + (0.06 + Math.random() * 0.13).toFixed(3) + ')';
      g.beginPath();
      g.ellipse(x, y, 0.8 + Math.random() * 3.4, 0.6 + Math.random() * 1.6, Math.random() * PI, 0, TAU);
      g.fill();
    }
  }

  function assets() {
    if (ASSETS) return ASSETS;

    var hullSet = bakeSet('apc:hull', function () {
      return {
        res: 256, seed: 41, base: '#6d6c54', grain: .055,
        paint: paintHull,
        normalScale: .70,
        rough: { base: .74, variance: .16 },
        metal: { base: .18, variance: .07 },
        wear: { amount: .10, colour: '#9a9484' }
      };
    });
    var rubberSet = bakeSet('apc:rubber', function () {
      return {
        res: 128, seed: 7, base: '#151618', grain: .30,
        normalScale: 1.9,
        rough: { base: .94, variance: .10 },
        metal: { base: .0, variance: .02 }
      };
    });
    var steelSet = bakeSet('apc:steel', function () {
      return {
        res: 128, seed: 19, base: '#3c3f42', grain: .20,
        normalScale: 1.1,
        rough: { base: .48, variance: .26 },
        metal: { base: .82, variance: .12 }
      };
    });

    var geo = {
      box:   new THREE.BoxGeometry(1, 1, 1),
      cyl6:  new THREE.CylinderGeometry(1, 1, 1, 6, 1, false),
      cyl8:  new THREE.CylinderGeometry(1, 1, 1, 8, 1, false),
      cyl12: new THREE.CylinderGeometry(1, 1, 1, 12, 1, false),
      cyl16: new THREE.CylinderGeometry(1, 1, 1, 16, 1, false),
      cyl20: new THREE.CylinderGeometry(1, 1, 1, 20, 1, false),
      tube12: new THREE.CylinderGeometry(1, 1, 1, 12, 1, true),
      cone:  new THREE.ConeGeometry(1, 1, 10, 1, false),
      sph:   new THREE.SphereGeometry(1, 10, 7),
      sphHi: new THREE.SphereGeometry(1, 16, 11),
      torus: new THREE.TorusGeometry(1, .12, 6, 18),
      plane: new THREE.PlaneGeometry(1, 1)
    };

    var m = {
      /* the paint, and the same paint one value down for the panels that sit
         in permanent shadow under the flare and behind the wheel */
      hull:     mat('hull',    { color: 0x8e8c6e, rough: .80, metal: .20, set: hullSet }),
      hullLo:   mat('hull-lo', { color: 0x6c6b53, rough: .84, metal: .18, set: hullSet }),
      hullHi:   mat('hull-hi', { color: 0xa3a07f, rough: .76, metal: .22, set: hullSet }),
      /* belly, wheel wells and everything the road throws grit at */
      under:    mat('under',   { color: 0x30322f, rough: .93, metal: .30 }),
      /* structural steel: seams, hinges, brackets, the bull bar */
      steel:    mat('steel',   { color: 0x585c5e, rough: .52, metal: .80, set: steelSet }),
      steelDk:  mat('steel-dk',{ color: 0x33383b, rough: .58, metal: .76, set: steelSet }),
      /* the gun and its furniture: parkerised, nearly black, low spec */
      gun:      mat('gun',     { color: 0x16191b, rough: .55, metal: .82, set: steelSet }),
      gunWorn:  mat('gun-worn',{ color: 0x4a4e50, rough: .38, metal: .92, set: steelSet }),
      /* rubber: tyres, mudflaps, door seals, the aerial bases */
      rubber:   mat('rubber',  { color: 0x18191b, rough: .95, metal: .02, set: rubberSet }),
      /* armoured glass. B7 laminate is 40 mm of green-edged sandwich and it
         is never clear -- it is a dark, slightly reflective slab. */
      glass:    mat('glass',   { color: 0x1d2a28, rough: .16, metal: .28, env: 1.5 }),
      glassLip: mat('glass-lip',{color: 0x39584c, rough: .34, metal: .30 }),
      /* lamps */
      lamp:     mat('lamp',    { color: 0xd8d4c4, rough: .18, metal: .12, emissive: 0xffe6b4, ei: .30 }),
      lampOff:  mat('lamp-off',{ color: 0x9a9a92, rough: .22, metal: .18 }),
      amber:    mat('amber',   { color: 0x50290a, rough: .28, metal: .10, emissive: 0xff9018, ei: .8 }),
      blue:     mat('blue',    { color: 0x0d1c3e, rough: .28, metal: .10, emissive: 0x2a6cff, ei: .8 }),
      /* optics: the RCWS day/thermal window and the laser rangefinder */
      optic:    mat('optic',   { color: 0x0b1416, rough: .10, metal: .55, emissive: 0x123038, ei: .9 }),
      /* markings and plates */
      plate:    mat('plate',   { color: 0xd9d6cb, rough: .62, metal: .06 }),
      flagRed:  mat('flag-red',{ color: 0xa8202a, rough: .82, metal: .04 }),
      flagWht:  mat('flag-wht',{ color: 0xcfcac0, rough: .82, metal: .04 }),
      /* hot metal: the barrel after a long burst, driven per-frame */
      hot:      mat('hot',     { color: 0x24262a, rough: .46, metal: .88, emissive: 0xff3c08, ei: 0 }),
      /* the wreck */
      burnt:    mat('burnt',   { color: 0x24211d, rough: .96, metal: .34 })
    };

    ASSETS = { geo: geo, m: m };
    return ASSETS;
  }

  /* =====================================================================
     SECTION 4 -- geometry plumbing.

     THE DRAW-CALL PROBLEM. An armoured car that reads as one has roughly
     three hundred pieces on it: seams, bolts, hinges, grab handles, lamp
     guards, tread lugs. Three hundred Meshes is three hundred draw calls per
     vehicle and the frame budget does not have them, and r149's merge helper
     lives in examples/jsm which this page does not load.

     So this module carries its own merge. Everything rigid with respect to a
     given transform goes into a Pile keyed by material; the Pile concatenates
     position, normal and uv with the part's matrix baked in and its indices
     offset, and emits ONE mesh per material. The hull is six draw calls. Only
     the things that actually articulate -- four wheels, the turret ring, the
     gun cradle, two aerials, the searchlight -- stay separate, because those
     are the only transforms that change.
     ================================================================== */
  var _mtmp = null, _ntmp = null, _v3 = null;
  function lazyTemps() {
    if (_mtmp) return;
    _mtmp = new THREE.Matrix4();
    _ntmp = new THREE.Matrix3();
    _v3 = new THREE.Vector3();
  }

  function Pile() { this.b = {}; }
  /* TEXEL DENSITY. Every primitive here is a unit box or cylinder scaled to
     size, so its 0..1 face UVs stretch with it: the same 256 px map covers
     both a 19.6 x 2.45 flank and a 0.13 bolt head, which is 150:1 and reads
     as wood grain on the one and as flat paint on the other. Scaling the UVs
     by the part's own size at roughly one tile per 5.5 units puts every
     surface on the same grain, which is the whole difference between a
     painted panel and a plank. */
  Pile.prototype.add = function (geo, key, m, uvk) {
    uvk = uvk === undefined ? 1 : uvk;
    if (!geo) return;
    var pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv;
    if (!pos) return;
    var bin = this.b[key];
    if (!bin) bin = this.b[key] = { p: [], n: [], u: [], i: [], base: 0 };
    var n = pos.count, k;
    _ntmp.getNormalMatrix(m);
    for (k = 0; k < n; k++) {
      _v3.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(m);
      bin.p.push(_v3.x, _v3.y, _v3.z);
      if (nrm) {
        _v3.set(nrm.getX(k), nrm.getY(k), nrm.getZ(k)).applyMatrix3(_ntmp).normalize();
        bin.n.push(_v3.x, _v3.y, _v3.z);
      } else bin.n.push(0, 1, 0);
      if (uv) bin.u.push(uv.getX(k) * uvk, uv.getY(k) * uvk); else bin.u.push(0, 0);
    }
    var idx = geo.index;
    if (idx) for (k = 0; k < idx.count; k++) bin.i.push(idx.getX(k) + bin.base);
    else for (k = 0; k < n; k++) bin.i.push(k + bin.base);
    bin.base += n;
  };
  Pile.prototype.emit = function (parent, mats, prefix, shadow) {
    var out = [];
    for (var key in this.b) {
      var bin = this.b[key];
      if (!bin.p.length) continue;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(bin.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(bin.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(bin.u, 2));
      /* r149 samples aoMap from uv2, not uv */
      g.setAttribute('uv2', new THREE.Float32BufferAttribute(bin.u, 2));
      g.setIndex(bin.i);
      g.computeBoundingSphere();
      var mesh = new THREE.Mesh(g, mats[key] || mats.hull);
      mesh.name = prefix + ':' + key;
      mesh.castShadow = shadow !== false;
      mesh.receiveShadow = true;
      parent.add(mesh);
      out.push(mesh);
    }
    return out;
  };

  /* ---- primitive emitters. Each takes the pile, a material key, a size and
     a placement, and bakes the transform. `rx/ry/rz` are applied in XYZ. ---- */
  var TEX_UNITS = 5.5;
  function P(pile, key, geo, sx, sy, sz, px, py, pz, rx, ry, rz) {
    lazyTemps();
    _mtmp.makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, 'XYZ'));
    _mtmp.scale(new THREE.Vector3(sx, sy, sz));
    _mtmp.setPosition(px || 0, py || 0, pz || 0);
    /* the geometric mean of the two larger extents is the size the eye reads
       the face at; one tile per 5.5 units from there */
    var mx = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
    var mn = sx < sy ? (sx < sz ? sx : sz) : (sy < sz ? sy : sz);
    var mid = sx + sy + sz - mx - mn;
    pile.add(geo, key, _mtmp, Math.max(.22, Math.sqrt(mx * mid) / TEX_UNITS));
  }
  function bx(pile, key, w, h, d, x, y, z, rx, ry, rz) {
    P(pile, key, assets().geo.box, w, h, d, x, y, z, rx, ry, rz);
  }
  /* a cylinder whose axis is Y by default; axis 'x' or 'z' rotates it */
  function cy(pile, key, r, len, x, y, z, axis, segs, r2) {
    var A = assets();
    var g = segs === 20 ? A.geo.cyl20 : segs === 16 ? A.geo.cyl16 : segs === 12 ? A.geo.cyl12
      : segs === 6 ? A.geo.cyl6 : A.geo.cyl8;
    var rx = 0, rz = 0;
    if (axis === 'x') rz = PI / 2; else if (axis === 'z') rx = PI / 2;
    if (r2 !== undefined && r2 !== r) {
      /* tapered: build it from the cone geometry scaled, close enough at this
         size and one geometry cheaper than a bespoke lathe */
      P(pile, key, A.geo.cone, Math.max(r, r2), len, Math.max(r, r2), x, y, z, rx, 0, rz);
      return;
    }
    P(pile, key, g, r, len, r, x, y, z, rx, 0, rz);
  }
  function sph(pile, key, r, x, y, z, hi) {
    P(pile, key, hi ? assets().geo.sphHi : assets().geo.sph, r, r, r, x, y, z, 0, 0, 0);
  }
  /* A weld seam or a panel line: a thin box standing 0.02 proud of its plate.
     Coplanar is how you lose a depth test to your own bodywork. */
  function seam(pile, key, w, h, d, x, y, z, rx, ry, rz) {
    bx(pile, key, w, h, d, x, y, z, rx, ry, rz);
  }
  /* a row of bolt heads: n domes at dx spacing, centred on x */
  function bolts(pile, key, n, x, y, z, dx, dz, r) {
    for (var i = 0; i < n; i++) {
      var t = n === 1 ? 0 : (i / (n - 1) - .5);
      cy(pile, key, r, r * .8, x + dx * t, y, z + dz * t, 'y', 6);
    }
  }
  /* -------------------------------------------------------- lamp guards ---
     A vertical-bar cage over each headlamp. Four bars and a rim reads as a
     guard at every distance the player will ever see it from. */
  function lampGuard(pile, key, r, x, y, z) {
    var i;
    P(pile, key, assets().geo.torus, r, r, r, x, y, z, PI / 2, 0, 0);
    for (i = 0; i < 4; i++) {
      var t = (i / 3 - .5) * 2 * r * .78;
      bx(pile, key, .13, r * 1.9, .13, x + t, y, z + .05);
    }
    bx(pile, key, r * 2.0, .13, .13, x, y, z + .05);
  }

  /* =====================================================================
     SECTION 5 -- the hull.

     Local frame: origin on the ground at the centre of the footprint, +Z out
     of the nose, +X to starboard, +Y up. That matches the engine's own yaw
     convention, where a local +Z point rotated by root.rotation.y lands at
     world (sin, cos) -- the same place enemyFire looks for a muzzle.

     Stations, all of them measured rather than eyeballed:

        z = +9.80   nose / bumper plane        y = 0      ground
        z = +9.10   lower front plate foot     y = 1.05   V keel
        z = +7.00   scuttle, base of screen    y = 1.93   axle centreline
        z = +5.78   FRONT AXLE                 y = 2.60   sill
        z = +5.60   screen head                y = 5.05   waist / belt line
        z = -5.78   REAR AXLE                  y = 7.70   roof
        z = -9.80   tail / rear door           y = 9.62   over the RCWS
     ================================================================== */

  var HL = 9.80, HW = 4.375;        /* half length, half width               */
  var SILL = 2.60, WAIST = 5.05, ROOF = 7.70;
  var AXF = 5.775, AXR = -5.775, HTR = 3.5875;
  var TR = 1.925, TW = 1.295;       /* tyre radius, tyre width               */

  function buildHull(pile, seed) {
    var i, t, s;

    /* ---- A. the V-hull. Two plates meeting on a keel 1.05 up, flaring out
       to the sills. This is the shape that makes a mine-protected car look
       like one from every low angle, and the player spends a lot of this
       level looking at vehicles from a kerb. ---------------------------- */
    for (s = -1; s <= 1; s += 2) {
      bx(pile, 'under', 3.30, .40, HL * 2 - .6, s * 1.85, 1.36, 0, 0, 0, s * .52);
      bx(pile, 'under', 2.20, .34, HL * 2 - .9, s * 3.05, 2.06, 0, 0, 0, s * .30);
    }
    bx(pile, 'under', .70, .52, HL * 2 - .4, 0, 1.14, 0);           /* keel   */
    seam(pile, 'steelDk', .34, .22, HL * 2 - .4, 0, 1.40, 0);       /* keel weld */
    /* cross members and the two diffs, seen from below and from a kerb */
    for (i = -2; i <= 2; i++) bx(pile, 'under', 6.4, .34, .46, 0, 1.62, i * 3.5);
    sph(pile, 'steelDk', 1.02, 0, TR * .96, AXF);
    sph(pile, 'steelDk', 1.02, 0, TR * .96, AXR);
    cy(pile, 'steelDk', .34, 5.4, 0, TR * .96, AXF, 'x', 8);        /* half shafts */
    cy(pile, 'steelDk', .34, 5.4, 0, TR * .96, AXR, 'x', 8);
    cy(pile, 'steelDk', .30, 11.2, 0, TR * .82, 0, 'z', 8);         /* prop shaft */
    /* the transfer case and the exhaust run under the floor */
    bx(pile, 'steelDk', 1.7, 1.2, 2.2, -.9, 2.05, 1.2);
    cy(pile, 'steelDk', .30, 7.0, 2.30, 1.72, -2.2, 'z', 8);

    /* ---- B. lower flanks: the sloped mine plate, cut round the arches ----

       ONE SLAB IS WRONG. A single 19.6-unit plate from the sill to the waist
       runs straight across both wheels, so the arch has to be drawn ON TOP of
       it -- which is what a flare looks like from the front and what a pair of
       detached grey eyebrows looks like from the side. An arch is an OPENING.

       Boolean subtraction is not available here, so the plate is emitted as
       twenty-six slices along its length and each slice starts at its own
       height: the sill, except over a wheel, where it starts on the tyre's own
       arc. Slices whose arc reaches the waist are simply not emitted, and that
       gap is the arch. The plate leans out 0.75 over 2.45 (17 degrees), so
       each slice's x follows its own centre height up the lean. */
    var ARCH_R = TR + .52, NSL = 26, SLD = (HL * 2 - .35) / NSL;
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < NSL; i++) {
        var zc = -HL + .175 + (i + .5) * SLD;
        var yb = SILL;
        var dF = Math.abs(zc - AXF), dR = Math.abs(zc - AXR);
        if (dF < ARCH_R) yb = Math.max(yb, TR + Math.sqrt(ARCH_R * ARCH_R - dF * dF));
        if (dR < ARCH_R) yb = Math.max(yb, TR + Math.sqrt(ARCH_R * ARCH_R - dR * dR));
        if (yb >= WAIST - .18) continue;                  /* this is the arch */
        var hh2 = WAIST - yb, ym = (yb + WAIST) * .5;
        bx(pile, 'hull', .40, hh2, SLD * 1.02,
          s * (3.98 + (ym - 3.83) * .306), ym, zc, 0, 0, s * .296);
      }
      seam(pile, 'hullLo', .30, .20, HL * 2 - .5, s * 4.16, 4.92, 0);  /* waist line */
      seam(pile, 'hullLo', .30, .18, HL * 2 - .8, s * 3.74, 2.72, 0);  /* sill line  */
      /* the sill between the axles, and the step bolted to it */
      bx(pile, 'under', .34, .92, 7.6, s * 3.62, 2.16, 0);
      bx(pile, 'steelDk', 1.35, .22, 7.0, s * 4.30, 2.30, 0);
      for (i = 0; i < 5; i++) bx(pile, 'steelDk', 1.25, .10, .34, s * 4.30, 2.42, -2.8 + i * 1.4);
      bx(pile, 'steelDk', .22, .78, .30, s * 3.96, 1.95, -2.9);
      bx(pile, 'steelDk', .22, .78, .30, s * 3.96, 1.95, 2.9);
      /* three vertical panel joints down each flank */
      for (i = 0; i < 3; i++)
        seam(pile, 'hullLo', .26, 2.5, .22, s * 4.06, 3.85, -5.2 + i * 4.6, 0, 0, s * .296);
    }

    /* ---- C. the flares. A lip round each opening, standing proud of the
       plate and wrapping the tyre, plus a liner so no daylight shows through
       the arch, plus a mudflap on the trailing edge. ---------------------- */
    for (s = -1; s <= 1; s += 2) {
      for (var w = 0; w < 2; w++) {
        var az = w ? AXR : AXF;
        /* eleven tangent segments from just above the ground on one side of
           the tyre, over the top, to just above it on the other */
        for (i = 0; i < 11; i++) {
          var a = PI * (.055 + i * .089);
          var ry = TR + Math.sin(a) * ARCH_R, rz = az + Math.cos(a) * ARCH_R;
          /* the lip sits at the plate's own lean for its height, then 0.22
             proud of it, so it reads as a pressing and not as a plate */
          var lx = 3.98 + (Math.min(ry, WAIST) - 3.83) * .306 + .30;
          bx(pile, 'hull', 1.25, .34, .96, s * lx, ry, rz, -a + PI / 2, 0, s * .10);
          /* the return, folded in under the lip */
          bx(pile, 'hullLo', .30, .28, .92, s * (lx - .62), ry - .22, rz, -a + PI / 2, 0, 0);
        }
        /* the liner: a barrel over the tyre and a back wall, so the arch is
           a hole in a body rather than a hole through it */
        for (i = 0; i < 7; i++) {
          var b2 = PI * (.10 + i * .133);
          bx(pile, 'under', 2.55, .26, 1.15, s * (HTR - .05),
            TR + Math.sin(b2) * (ARCH_R - .30), az + Math.cos(b2) * (ARCH_R - .30),
            -b2 + PI / 2, 0, 0);
        }
        bx(pile, 'under', .34, 2.7, 4.9, s * (HTR - 1.20), TR + 1.15, az);
        /* mudflap: 480 x 430 mm, hung off the trailing lip, splayed out */
        bx(pile, 'rubber', 1.68, 1.50, .13, s * (HTR + .30), 1.02, az - ARCH_R - .30, .14, 0, s * .06);
        bx(pile, 'steelDk', 1.72, .18, .22, s * (HTR + .30), 1.72, az - ARCH_R - .28);
      }
    }

    /* ---- D. the front: lower plate, bumper, bull bar, lamps, dischargers */
    bx(pile, 'hull', 8.05, 3.28, .42, 0, 3.48, 9.42, .218);         /* lower plate */
    seam(pile, 'hullLo', 7.9, .20, .24, 0, 2.30, 9.28, .218);
    /* the tow/recovery bumper and its two shackles */
    bx(pile, 'steelDk', 8.6, .82, .74, 0, 2.55, 9.86);
    for (s = -1; s <= 1; s += 2) {
      P(pile, 'steel', assets().geo.torus, .40, .40, .40, s * 2.5, 2.55, 10.24, 0, PI / 2, 0);
      bx(pile, 'steel', .30, .74, .52, s * 2.5, 2.55, 10.02);
    }
    /* bull bar: two uprights, a top rail and a wire cutter */
    for (s = -1; s <= 1; s += 2) {
      cy(pile, 'steel', .22, 3.6, s * 3.15, 4.20, 10.28, 'y', 8);
      cy(pile, 'steel', .20, 1.1, s * 3.15, 5.90, 9.80, 'z', 8);
    }
    cy(pile, 'steel', .22, 6.5, 0, 5.95, 10.24, 'x', 8);
    cy(pile, 'steel', .20, 2.4, 0, 4.30, 10.28, 'x', 8);
    bx(pile, 'steel', .16, 1.9, .34, 0, 6.85, 9.55);                /* wire cutter */
    /* four lamps in guards: two main, two auxiliary, plus blackout markers */
    for (s = -1; s <= 1; s += 2) {
      cy(pile, 'lamp', .62, .32, s * 2.30, 4.62, 9.68, 'z', 12);
      lampGuard(pile, 'steel', .80, s * 2.30, 4.62, 9.80);
      cy(pile, 'lamp', .40, .28, s * 3.36, 4.30, 9.66, 'z', 8);
      lampGuard(pile, 'steel', .56, s * 3.36, 4.30, 9.76);
      cy(pile, 'amber', .26, .22, s * 3.55, 5.42, 9.62, 'z', 8);
      /* indicator repeater on the flare */
      cy(pile, 'amber', .20, .26, s * 4.18, 4.55, 6.3, 'x', 6);
    }
    /* smoke grenade dischargers: two clusters of three, angled up and out */
    for (s = -1; s <= 1; s += 2) {
      bx(pile, 'steelDk', 1.5, .5, 1.2, s * 3.05, 5.34, 7.55, 0, 0, s * .30);
      for (i = 0; i < 3; i++)
        cy(pile, 'gun', .32, 1.35, s * (2.55 + i * .48), 5.95, 7.55 + (i - 1) * .0,
          'y', 8), P(pile, 'gun', assets().geo.cyl8, .32, 1.35, .32,
          s * (2.55 + i * .48), 6.02, 7.55, -.30, 0, s * .34);
    }

    /* ---- E. bonnet and the engine louvres ----------------------------- */
    bx(pile, 'hull', 8.05, .42, 3.05, 0, 5.62, 8.40, .389);
    seam(pile, 'hullLo', 7.6, .18, .22, 0, 5.86, 8.42, .389);
    /* intake louvres, six blades, set into the deck */
    for (i = 0; i < 6; i++)
      bx(pile, 'steelDk', 4.4, .16, .34, 0, 5.68 + i * .085, 9.28 - i * .21, .389);
    /* bonnet catches and a grab handle */
    for (s = -1; s <= 1; s += 2) bx(pile, 'steel', .34, .20, .55, s * 3.35, 5.72, 9.22, .389);
    bolts(pile, 'steel', 7, 0, 5.80, 7.30, 6.6, 0, .13);

    /* ---- F. screen, pillars, wipers, mirrors -------------------------- */
    bx(pile, 'glass', 6.55, .30, 2.02, 0, 6.90, 6.30, .785);
    bx(pile, 'glassLip', 6.75, .22, .26, 0, 6.17, 7.02, .785);      /* lower rail */
    bx(pile, 'glassLip', 6.75, .22, .26, 0, 7.62, 5.62, .785);      /* header    */
    bx(pile, 'hull', .46, .34, 2.15, 0, 6.90, 6.30, .785);          /* centre pillar */
    for (s = -1; s <= 1; s += 2) {
      bx(pile, 'hull', .52, .40, 2.30, s * 3.30, 6.88, 6.30, .785); /* A-pillar */
      /* wiper: arm and blade, parked low */
      cy(pile, 'gun', .09, 2.1, s * 1.55, 6.40, 6.78, 'x', 6);
      bx(pile, 'rubber', 2.0, .12, .12, s * 1.55, 6.30, 6.70);
      /* mirror on a folded stalk */
      cy(pile, 'steel', .11, 1.5, s * 3.95, 7.05, 6.55, 'x', 6);
      bx(pile, 'steelDk', .34, 1.05, .78, s * 4.70, 7.05, 6.55, 0, .22 * s, 0);
      bx(pile, 'glass', .10, .88, .62, s * 4.86, 7.05, 6.58, 0, .22 * s, 0);
    }
    /* armoured screen shutters, folded up over the header -- the crew drops
       these when it gets serious, and they read as intent at fifty metres */
    bx(pile, 'steelDk', 6.6, .26, 1.1, 0, 7.95, 5.22, .30);
    for (s = -1; s <= 1; s += 2) bx(pile, 'steel', .30, .30, .95, s * 3.2, 7.86, 5.30, .30);

    /* ---- G. upper flanks: doors, vision blocks, handles, stowage ------- */
    for (s = -1; s <= 1; s += 2) {
      /* the side, waist to roof, tumbled in 0.22 over 2.65 */
      bx(pile, 'hull', .40, 2.72, 16.7, s * 4.22, 6.38, -1.35, 0, 0, s * .083);
      seam(pile, 'hullLo', .26, .20, 16.5, s * 4.30, 7.55, -1.35);   /* rain rail */
      /* crew door, front: frame proud of the skin, hinges, handle, block */
      bx(pile, 'hullHi', .18, 2.35, 3.35, s * 4.40, 6.42, 4.05, 0, 0, s * .083);
      seam(pile, 'hullLo', .24, 2.45, .22, s * 4.44, 6.42, 5.76, 0, 0, s * .083);
      seam(pile, 'hullLo', .24, 2.45, .22, s * 4.44, 6.42, 2.34, 0, 0, s * .083);
      seam(pile, 'hullLo', .24, .22, 3.45, s * 4.44, 7.63, 4.05, 0, 0, s * .083);
      seam(pile, 'hullLo', .24, .22, 3.45, s * 4.44, 5.24, 4.05, 0, 0, s * .083);
      for (i = 0; i < 3; i++) bx(pile, 'steelDk', .30, .46, .40, s * 4.46, 5.60 + i * .95, 5.72);
      bx(pile, 'steel', .34, .26, .95, s * 4.52, 6.30, 2.80);        /* handle    */
      bx(pile, 'glass', .16, .86, 1.42, s * 4.50, 7.02, 4.20, 0, 0, s * .083);
      bx(pile, 'steelDk', .20, 1.06, 1.62, s * 4.46, 7.02, 4.20, 0, 0, s * .083);
      bx(pile, 'glass', .16, .86, 1.42, s * 4.52, 7.02, 4.20, 0, 0, s * .083);
      /* three vision blocks down the troop compartment, with firing-port
         plugs under two of them */
      for (i = 0; i < 3; i++) {
        var vz = -.4 - i * 3.5;
        bx(pile, 'steelDk', .20, 1.02, 1.55, s * 4.46, 6.95, vz, 0, 0, s * .083);
        bx(pile, 'glass', .16, .80, 1.30, s * 4.53, 6.95, vz, 0, 0, s * .083);
        if (i < 2) cy(pile, 'steelDk', .34, .26, s * 4.48, 5.95, vz, 'x', 8);
      }
      /* stowage bin on the flank, with two latches */
      bx(pile, 'hullLo', .60, 1.25, 4.2, s * 4.55, 5.62, -6.0, 0, 0, s * .05);
      for (i = 0; i < 2; i++) bx(pile, 'steel', .22, .30, .26, s * 4.86, 5.62, -7.4 + i * 2.8);
      /* grab handles, fore and aft */
      for (i = 0; i < 2; i++) {
        bx(pile, 'steel', .30, .16, 1.15, s * 4.50, 5.35, 1.1 - i * 6.4);
        bx(pile, 'steel', .30, .34, .16, s * 4.44, 5.22, .60 - i * 6.4);
        bx(pile, 'steel', .30, .34, .16, s * 4.44, 5.22, 1.60 - i * 6.4);
      }
    }

    /* ---- H. the tail: door, spare, lamps, jerrycans, tow eyes ---------- */
    bx(pile, 'hull', 8.35, 5.30, .44, 0, 4.95, -9.62);
    bx(pile, 'hullHi', 5.60, 4.30, .20, 0, 4.85, -9.88);            /* door leaf */
    seam(pile, 'hullLo', .24, 4.40, .26, -2.86, 4.85, -9.92);
    seam(pile, 'hullLo', .24, 4.40, .26, 2.86, 4.85, -9.92);
    seam(pile, 'hullLo', 5.70, .24, .26, 0, 7.02, -9.92);
    for (i = 0; i < 3; i++) bx(pile, 'steelDk', .44, .52, .34, -2.90, 3.30 + i * 1.6, -9.96);
    bx(pile, 'steel', .95, .28, .34, 2.55, 4.85, -10.02);           /* door handle */
    bx(pile, 'steelDk', 1.70, 1.10, .22, 0, 6.55, -9.99);           /* rear block */
    bx(pile, 'glass', 1.42, .84, .16, 0, 6.55, -10.06);
    /* the spare, bolted to the door on its own carrier */
    bx(pile, 'steelDk', .40, 3.6, .34, -1.35, 4.60, -10.10);
    cy(pile, 'rubber', TR * .96, .95, -1.35, 4.60, -10.55, 'z', 16);
    cy(pile, 'steelDk', 1.10, 1.00, -1.35, 4.60, -10.56, 'z', 12);
    cy(pile, 'steel', .40, 1.10, -1.35, 4.60, -10.58, 'z', 8);
    /* jerrycan rack, two cans */
    for (i = 0; i < 2; i++) {
      bx(pile, 'hullLo', 1.05, 2.05, 1.30, 2.55 + i * 1.25, 3.55, -10.35);
      bx(pile, 'steel', 1.15, .18, 1.40, 2.55 + i * 1.25, 4.62, -10.35);
    }
    /* tail lamps, convoy lamp, plate */
    for (s = -1; s <= 1; s += 2) {
      bx(pile, 'steelDk', .90, 1.30, .30, s * 3.55, 3.55, -9.90);
      bx(pile, 'flagRed', .70, .52, .18, s * 3.55, 3.85, -10.03);
      bx(pile, 'amber', .70, .40, .18, s * 3.55, 3.32, -10.03);
      P(pile, 'steel', assets().geo.torus, .36, .36, .36, s * 2.9, 2.55, -10.10, 0, PI / 2, 0);
    }
    bx(pile, 'plate', 2.30, .70, .12, 1.35, 2.72, -10.02);          /* number plate */
    bx(pile, 'lampOff', .34, .30, .16, 0, 2.60, -10.02);            /* convoy lamp */

    /* ---- I. the roof ------------------------------------------------- */
    bx(pile, 'hull', 8.30, .42, 15.6, 0, 7.60, -1.95);
    seam(pile, 'hullLo', 8.4, .20, .24, 0, 7.83, 5.42);
    for (s = -1; s <= 1; s += 2) seam(pile, 'hullLo', .24, .22, 15.4, s * 4.10, 7.83, -1.95);
    /* two crew hatches, rims proud, one with its lid cracked open */
    for (s = -1; s <= 1; s += 2) {
      bx(pile, 'hullLo', 2.9, .34, 2.9, s * 2.35, 7.92, 4.35);
      bx(pile, 'hullHi', 2.5, .26, 2.5, s * 2.35, 8.10, 4.35, s > 0 ? -.34 : 0, 0, 0);
      bx(pile, 'steel', .70, .22, .26, s * 2.35, 8.26, 3.30, s > 0 ? -.34 : 0, 0, 0);
    }
    /* rear crew hatch and a stowage frame over the engine of the roof line */
    bx(pile, 'hullLo', 3.1, .30, 3.1, 0, 7.90, -6.55);
    bx(pile, 'hullHi', 2.7, .24, 2.7, 0, 8.06, -6.55);
    for (i = 0; i < 4; i++) bx(pile, 'steel', 7.4, .16, .16, 0, 8.02, -3.2 - i * 1.15);
    /* two amber beacons, front corners */
    for (s = -1; s <= 1; s += 2) {
      cy(pile, 'steelDk', .34, .30, s * 3.55, 7.90, 5.05, 'y', 8);
      cy(pile, 'amber', .40, .60, s * 3.55, 8.30, 5.05, 'y', 10);
      cy(pile, 'steelDk', .42, .16, s * 3.55, 8.66, 5.05, 'y', 8);
    }
    /* aerial bases; the whips themselves articulate and live outside the pile */
    for (s = -1; s <= 1; s += 2) {
      cy(pile, 'rubber', .30, .55, s * 3.70, 7.95, -8.55, 'y', 8);
      cy(pile, 'steelDk', .22, .30, s * 3.70, 8.28, -8.55, 'y', 8);
    }
    /* exhaust up the starboard flank, and the snorkel to port */
    cy(pile, 'steelDk', .42, 4.6, 4.05, 5.20, -7.40, 'y', 10);
    cy(pile, 'steelDk', .48, .70, 4.05, 7.65, -7.40, 'y', 10);
    for (i = 0; i < 3; i++) bx(pile, 'steel', .90, .18, .70, 4.35, 4.10 + i * 1.7, -7.40);
    cy(pile, 'hullLo', .55, 6.4, -4.05, 5.40, -6.10, 'y', 10);
    cy(pile, 'hullLo', .62, 1.0, -4.05, 8.75, -6.10, 'y', 10);
    bx(pile, 'steelDk', .80, .30, 1.40, -4.05, 8.95, -6.10);
    for (i = 0; i < 3; i++) bx(pile, 'steel', 1.10, .18, .80, -4.40, 4.60 + i * 1.9, -6.10);

    /* ---- J. markings. A unit number on both flanks and a small flag panel
       on the tail: enough to read as a service vehicle, not a livery. ---- */
    for (s = -1; s <= 1; s += 2) {
      bx(pile, 'plate', .12, .70, 2.60, s * 4.60, 5.95, -7.9, 0, 0, s * .05);
      for (i = 0; i < 4; i++)
        bx(pile, 'hullLo', .16, .46, .14, s * 4.66, 5.95, -7.0 - i * .55, 0, 0, s * .05);
    }
    bx(pile, 'flagRed', 1.55, 1.05, .12, -3.05, 6.55, -10.00);
    cy(pile, 'flagWht', .30, .10, -3.15, 6.55, -10.08, 'z', 10);
    cy(pile, 'flagRed', .24, .12, -3.02, 6.55, -10.10, 'z', 10);
    void seed;
  }

  /* =====================================================================
     SECTION 6 -- running gear and the remote weapon station.
     ================================================================== */

  /* ------------------------------------------------------------- RCWS ----
     A stabilised remote station: ring, traverse body, ammunition box, sensor
     pod with a day/thermal window and a rangefinder, and a 12.7 mm gun on a
     trunnion. The optic is the weak point and it is meant to look like one --
     it is the only thing on the vehicle that is glass and not armour. */
  function buildTurret(hullGrp, mats) {
    var yaw = new THREE.Group();
    yaw.name = 'rcws-ring';
    yaw.position.set(0, 8.23, .60);
    hullGrp.add(yaw);

    var py = new Pile(), i, s;
    /* traverse body, cheeks and the mounting collar */
    bx(py, 'gun', 3.00, 1.35, 3.40, 0, .72, 0);
    bx(py, 'gunWorn', 3.16, .26, 3.10, 0, .06, 0);
    cy(py, 'steelDk', 1.55, .34, 0, -.10, 0, 'y', 16);
    for (i = 0; i < 12; i++) {
      var a = i / 12 * TAU;
      cy(py, 'steel', .11, .22, Math.sin(a) * 1.35, .10, Math.cos(a) * 1.35, 'y', 6);
    }
    /* ammunition box to starboard with its lid catch, and the feed cover */
    bx(py, 'gun', 1.85, 1.40, 2.45, 2.05, .78, -.20);
    bx(py, 'gunWorn', 1.95, .20, 2.55, 2.05, 1.52, -.20);
    bx(py, 'steel', .40, .24, .34, 2.05, 1.64, .95);
    bx(py, 'plate', .12, .55, 1.30, 2.99, .78, -.20);
    /* sensor pod: housing, day window, thermal window, rangefinder aperture */
    bx(py, 'gun', 1.45, 1.30, 1.55, -1.95, 1.05, .70);
    bx(py, 'gunWorn', 1.55, .22, 1.65, -1.95, 1.74, .70);
    bx(py, 'optic', .95, .70, .16, -1.95, 1.22, 1.51);
    bx(py, 'optic', .55, .42, .16, -1.95, .62, 1.51);
    cy(py, 'optic', .22, .16, -1.35, .62, 1.51, 'z', 10);
    bx(py, 'steelDk', 1.62, .26, .30, -1.95, 1.78, 1.35);            /* sun shade */
    /* armour shield across the front of the station */
    bx(py, 'gun', 3.30, 1.55, .34, 0, .95, 1.62, .18);
    bx(py, 'gunWorn', 3.42, .22, .26, 0, 1.70, 1.52, .18);
    for (s = -1; s <= 1; s += 2) bx(py, 'gun', .34, 1.45, 1.20, s * 1.62, .95, 1.05, 0, s * .16, 0);
    /* elevation drive and the trunnion caps */
    for (s = -1; s <= 1; s += 2) cy(py, 'steel', .40, .34, s * .82, .72, .50, 'x', 10);
    py.emit(yaw, mats, 'apc-rcws', true);

    /* --- the gun, on its own pitch group --- */
    var pitch = new THREE.Group();
    pitch.name = 'rcws-cradle';
    pitch.position.set(0, .72, .50);
    yaw.add(pitch);

    var pg = new Pile();
    /* cradle and receiver */
    bx(pg, 'gun', 1.30, 1.20, 3.90, 0, 0, -.30);
    bx(pg, 'gunWorn', 1.42, .22, 2.60, 0, .64, -.55);
    bx(pg, 'gun', .95, .80, 1.10, 0, -.62, -1.40);                   /* buffer    */
    bx(pg, 'steel', .34, .34, .90, .72, .22, .10);                   /* charger   */
    bx(pg, 'steel', .30, .55, .30, .72, .22, .60);
    bx(pg, 'gun', .90, .95, 1.35, -.62, -.30, -.10);                 /* feed way  */
    bx(pg, 'steelDk', .55, .30, 1.90, -.98, -.55, .35, .22);         /* chute     */
    bx(pg, 'gun', .80, .70, .60, .58, -.70, -.55);                   /* case chute*/
    /* the barrel: perforated jacket, then bare barrel, then the brake */
    cy(pg, 'gun', .40, 3.30, 0, 0, 1.60, 'z', 12);
    for (i = 0; i < 7; i++) {
      var t = -1.2 + i * .44;
      for (s = -1; s <= 1; s += 2) {
        cy(pg, 'gunWorn', .13, .30, s * .38, 0, 1.60 + t, 'x', 6);
        cy(pg, 'gunWorn', .13, .30, 0, s * .38, 1.60 + t, 'y', 6);
      }
    }
    cy(pg, 'gunWorn', .21, 1.55, 0, 0, 3.95, 'z', 10);
    cy(pg, 'hot', .225, 1.30, 0, 0, 3.95, 'z', 10);                  /* heat band */
    cy(pg, 'gun', .42, .78, 0, 0, 4.98, 'z', 12);                    /* brake     */
    for (i = 0; i < 3; i++) bx(pg, 'gun', 1.05, .16, .20, 0, 0, 4.75 + i * .24);
    cy(pg, 'gun', .46, .16, 0, 0, 5.34, 'z', 12);
    /* a coaxial illuminator, because a remote station in 2020 has one */
    cy(pg, 'gun', .24, 1.10, -.70, .48, 1.10, 'z', 8);
    cy(pg, 'lampOff', .17, .12, -.70, .48, 1.68, 'z', 8);
    var gunMeshes = pg.emit(pitch, mats, 'apc-gun', true);

    var muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0, 5.45);
    pitch.add(muzzle);

    return { yaw: yaw, pitch: pitch, muzzle: muzzle, gunMeshes: gunMeshes };
  }

  /* ------------------------------------------------- commander's light ---
     A steerable searchlight on the port hatch ring. On patrol it sweeps; the
     moment the crew has a contact it pins it, and being pinned is the tell
     that the gun is about to follow. */
  function buildLight(hullGrp, mats) {
    var yaw = new THREE.Group();
    yaw.name = 'light-yaw';
    yaw.position.set(-2.35, 8.20, 4.35);
    hullGrp.add(yaw);
    var pitch = new THREE.Group();
    pitch.name = 'light-pitch';
    pitch.position.set(0, .55, 0);
    yaw.add(pitch);

    var p = new Pile();
    cy(p, 'steelDk', .28, .90, 0, -.35, 0, 'y', 8);
    bx(p, 'steelDk', .34, .70, .34, 0, 0, -.55);
    cy(p, 'steelDk', .78, 1.05, 0, 0, .10, 'z', 12);
    P(p, 'steel', assets().geo.torus, .80, .80, .80, 0, 0, .64, 0, 0, 0);
    bx(p, 'steel', .26, 1.05, .26, 0, .0, -.35);
    p.emit(pitch, mats, 'apc-light', false);

    /* the lens is its own mesh so its emissive can be driven per actor */
    var lensMat = mats.lamp.clone();
    lensMat.name = 'nzapc:searchlight';
    lensMat.emissive = new THREE.Color(0xfff0c8);
    lensMat.emissiveIntensity = 1.2;
    var lens = new THREE.Mesh(assets().geo.cyl16, lensMat);
    lens.name = 'searchlight-lens';
    lens.scale.set(.70, .10, .70);
    lens.rotation.x = PI / 2;
    lens.position.set(0, 0, .62);
    pitch.add(lens);

    /* the visible shaft. A cone, additive, depth-write off, so it reads as
       light in dust rather than as a solid grey traffic cone. */
    var beamMat = new THREE.MeshBasicMaterial({
      color: 0xffeec4, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: true
    });
    beamMat.name = 'nzapc:beam';
    var beam = new THREE.Mesh(assets().geo.cone, beamMat);
    beam.name = 'searchlight-beam';
    beam.renderOrder = 3;
    beam.castShadow = false; beam.receiveShadow = false;
    pitch.add(beam);

    /* The real spotlight is an ultra-only luxury and only ever the first
       vehicle's, for the same reason: every light added to the scene
       recompiles every material in it. On the cordon it is broad daylight
       and the additive shaft plus a hot lens is the whole read anyway. */
    var spot = null;
    try {
      var q = (NZ.render && NZ.render.quality) || 'high';
      if (q === 'ultra' && RIGS.length === 0) {
        spot = new THREE.SpotLight(0xffe9bd, 0, 150, .42, .45, 1.25);
        spot.castShadow = false;
        spot.position.set(0, 0, .7);
        spot.target.position.set(0, 0, 40);
        pitch.add(spot); pitch.add(spot.target);
      }
    } catch (e) { spot = null; }

    return { yaw: yaw, pitch: pitch, lens: lens, lensMat: lensMat,
      beam: beam, beamMat: beamMat, spot: spot, sweep: 0, lock: 0 };
  }

  /* ----------------------------------------------------------- aerials ---
     Two whips. They are the only thing on the vehicle that is soft, and a
     4.6-unit antenna trailing a lurch is worth more than any amount of paint
     detail for reading how hard the thing is being driven. */
  function buildAerial(hullGrp, mats, side) {
    var g = new THREE.Group();
    g.name = 'aerial';
    g.position.set(side * 3.70, 8.42, -8.55);
    hullGrp.add(g);
    var p = new Pile();
    cy(p, 'steelDk', .105, 3.0, 0, 1.50, 0, 'y', 6);
    cy(p, 'steelDk', .065, 2.6, 0, 4.20, 0, 'y', 6);
    cy(p, 'flagRed', .085, .55, 0, 5.62, 0, 'y', 6);
    p.emit(g, mats, 'apc-aerial', false);
    return { grp: g, vx: 0, vz: 0, x: 0, z: 0 };
  }

  /* =====================================================================
     SECTION 7 -- assembly.

     Geometry is built once and cached by material key; every spawn gets its
     own Meshes over the SAME BufferGeometry and its own transform hierarchy,
     which is the module contract nz-spider.js states and the reason two
     vehicles cost one vehicle's memory. The handful of materials that have to
     be driven per actor -- barrel heat, beacons, headlamps, the searchlight
     lens -- are cloned per rig; everything else is shared.

     The hierarchy, and why it is shaped this way:

        root ................ world position, chassis yaw
         +- wheel[0..3] ..... steer group -> roll group. Children of ROOT,
         |                    not of the body, because a wheel stays on the
         |                    road while the body pitches over it. That one
         |                    decision is the whole difference between a car
         |                    and a box sliding along the floor.
         +- body ............ heave, pitch and roll about the roll centre
             +- hullGrp ..... every static panel
                 +- rcws .... traverse -> elevation -> muzzle
                 +- light ... searchlight yaw -> pitch
                 +- aerial .. two whips with their own inertia
     ================================================================== */
  var PILECACHE = {};
  function pileGeo(key, buildFn) {
    if (PILECACHE[key]) return PILECACHE[key];
    var p = new Pile();
    buildFn(p);
    var out = {};
    for (var k in p.b) {
      var bin = p.b[k];
      if (!bin.p.length) continue;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(bin.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(bin.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(bin.u, 2));
      g.setAttribute('uv2', new THREE.Float32BufferAttribute(bin.u, 2));
      g.setIndex(bin.i);
      g.computeBoundingSphere();
      out[k] = g;
    }
    PILECACHE[key] = out;
    return out;
  }
  /* Only silhouette-bearing plate enters the directional shadow pass. Bolts,
     lamp guards and aerials still receive light without each costing a draw. */
  var SHADOW_KEYS = { hull: 1, hullLo: 1, hullHi: 1, under: 1, rubber: 1, gun: 1, steelDk: 1 };
  function attach(parent, geos, mats, prefix) {
    var out = [];
    for (var k in geos) {
      var m = new THREE.Mesh(geos[k], mats[k] || mats.hull);
      m.name = prefix + ':' + k;
      m.castShadow = !!SHADOW_KEYS[k];
      m.receiveShadow = true;
      parent.add(m);
      out.push(m);
    }
    return out;
  }

  /* re-implemented on the cache: same shapes, one geometry set for all spawns */
  function wheelGeo(side, front) {
    return pileGeo('wheel:' + side + ':' + (front ? 1 : 0), function (p) {
      var i;
      cy(p, 'rubber', TR * .94, TW, 0, 0, 0, 'x', 20);
      cy(p, 'rubber', TR, TW * .70, 0, 0, 0, 'x', 20);
      for (i = 0; i < 18; i++) {
        var a = i / 18 * TAU, lean = (i & 1) ? .30 : -.30;
        P(p, 'rubber', assets().geo.box, TW * .82, .30, .62,
          0, Math.cos(a) * (TR - .10), Math.sin(a) * (TR - .10), -a, 0, lean);
        P(p, 'rubber', assets().geo.box, .34, .26, .54,
          (i & 1 ? 1 : -1) * TW * .46, Math.cos(a) * (TR - .06), Math.sin(a) * (TR - .06), -a, 0, 0);
      }
      P(p, 'rubber', assets().geo.torus, TR * .86, TR * .86, TR * .86, TW * .40, 0, 0, 0, PI / 2, 0);
      P(p, 'rubber', assets().geo.torus, TR * .86, TR * .86, TR * .86, -TW * .40, 0, 0, 0, PI / 2, 0);
      cy(p, 'steelDk', TR * .60, TW * .92, 0, 0, 0, 'x', 16);
      cy(p, 'steel', TR * .58, TW * .30, side * TW * .34, 0, 0, 'x', 16);
      for (i = 0; i < 6; i++) {
        var b = i / 6 * TAU + .26;
        P(p, 'steelDk', assets().geo.box, TW * .34, TR * .70, .55,
          side * TW * .30, Math.cos(b) * TR * .30, Math.sin(b) * TR * .30, -b, 0, 0);
      }
      cy(p, 'steel', .46, TW * .58, side * TW * .52, 0, 0, 'x', 10);
      for (i = 0; i < 10; i++) {
        var c = i / 10 * TAU;
        cy(p, 'steelDk', .13, TW * .22, side * TW * .60, Math.cos(c) * .82, Math.sin(c) * .82, 'x', 6);
      }
      cy(p, 'steelDk', .16, .50, side * TW * .72, .42, .42, 'x', 6);
      cy(p, 'steel', TR * .44, .18, -side * TW * .10, 0, 0, 'x', 16);
    });
  }

  function makeWheel(root, mats, side, front) {
    var steer = new THREE.Group();
    steer.name = front ? 'wheel-steer' : 'wheel-mount';
    steer.position.set(side * HTR, TR, front ? AXF : AXR);
    root.add(steer);
    var roll = new THREE.Group();
    roll.name = 'wheel-roll';
    steer.add(roll);
    attach(roll, wheelGeo(side, front), mats, 'apc-wheel');
    return { steer: steer, roll: roll, side: side, front: !!front,
      comp: 0, compV: 0, spin: 0, flat: 0, hp: 140, blown: false, y: TR };
  }

  function buildApc(e) {
    if (!THREE || !NZ.ctx || !NZ.ctx.scene) return undefined;
    var A = assets(), i;
    var seed = fin(e && e.uid, 0) * 7 + 3;

    /* per-actor materials: only what actually animates */
    var mats = {};
    for (var k in A.m) mats[k] = A.m[k];
    mats.hot = A.m.hot.clone();   mats.hot.name = 'nzapc:hot#' + seed;
    mats.amber = A.m.amber.clone(); mats.amber.name = 'nzapc:amber#' + seed;
    mats.lamp = A.m.lamp.clone();  mats.lamp.name = 'nzapc:lamp#' + seed;

    var root = new THREE.Group();
    root.name = 'nz-enemy-apc';
    root.rotation.order = 'YXZ';
    root.visible = true;
    NZ.ctx.scene.add(root);

    /* body carries the suspension. Pitch and roll happen about the roll
       centre at y = 2.5, not about the ground, or a 0.05 rad pitch would
       swing the roof line a third of a metre sideways. */
    var body = new THREE.Group();
    body.name = 'apc-body';
    body.rotation.order = 'ZXY';
    body.position.set(0, 2.5, 0);
    root.add(body);
    var hullGrp = new THREE.Group();
    hullGrp.name = 'apc-hull';
    hullGrp.position.set(0, -2.5, 0);
    body.add(hullGrp);

    var hullMeshes = attach(hullGrp, pileGeo('hull', function (p) { buildHull(p, seed); }), mats, 'apc');

    var wheels = [
      makeWheel(root, mats, -1, true), makeWheel(root, mats, 1, true),
      makeWheel(root, mats, -1, false), makeWheel(root, mats, 1, false)
    ];
    var rcws = buildTurret(hullGrp, mats);
    var light = buildLight(hullGrp, mats);
    var aerials = [buildAerial(hullGrp, mats, -1), buildAerial(hullGrp, mats, 1)];

    /* muzzle flash: two crossed additive cards at the brake, scaled per shot */
    var flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd79a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false
    });
    flashMat.name = 'nzapc:flash';
    var flash = new THREE.Group();
    flash.name = 'muzzle-flash';
    flash.position.copy(rcws.muzzle.position);
    for (i = 0; i < 2; i++) {
      var card = new THREE.Mesh(A.geo.plane, flashMat);
      card.rotation.z = i * PI / 2;
      card.renderOrder = 4;
      card.castShadow = false; card.receiveShadow = false;
      flash.add(card);
    }
    rcws.pitch.add(flash);

    var rig = {
      root: root, body: body, hullGrp: hullGrp, hullMeshes: hullMeshes,
      wheels: wheels, rcws: rcws, light: light, aerials: aerials,
      muzzle: rcws.muzzle, muzzleWorld: new THREE.Vector3(), muzzleReady: false,
      flash: flash, flashMat: flashMat, mats: mats,
      apc: true, apcModule: true, owner: e,
      state: {
        order: RIGS.length, seed: seed, failed: false, dead: false,
        lastNow: 0, heave: 0, heaveV: 0, pitch: 0, roll: 0,
        pitchV: 0, rollV: 0, steer: 0, spin: 0,
        turretYaw: 0, turretPitch: 0, turretVel: 0,
        heat: 0, flashT: 0, beacon: rr(0, TAU), lampOn: 0,
        lastVx: 0, lastVz: 0, lastSpeed: 0, jolt: 0,
        smokeT: 0, dustT: 0, brassT: 0
      }
    };
    RIGS.push(rig);
    STATS.spawned++;
    return rig;
  }

  /* ---------------------------------------------------------- teardown --- */
  function disposeRig(rig) {
    if (!rig || !rig.root) return;
    try {
      rig.root.traverse(function (o) {
        if (o.geometry && !o.geometry.__apcShared) { /* cached geometry is kept */ }
      });
      if (rig.root.parent) rig.root.parent.remove(rig.root);
    } catch (e) {}
    var i = RIGS.indexOf(rig);
    if (i >= 0) RIGS.splice(i, 1);
  }

  /* =====================================================================
     SECTION 8 -- the driver.

     A kinematic bicycle model. State is (x, z, face, v, steer); the only way
     to change `face` is to be moving AND to have lock on, which is the whole
     point and the thing the stock velocity slew cannot express:

         dface = (v / WB) * tan(steer) * dt
         dx    = sin(face) * v * dt
         dz    = cos(face) * v * dt

     Steering comes from pure pursuit against the driving line. For a target
     at signed bearing offset `alpha` and lookahead `Ld` the path curvature is
     2 sin(alpha) / Ld, and reversing simply negates it -- the rear axle is
     doing the pursuing, so the wheel goes the other way, which is exactly why
     reversing round a corner feels like it does.

     Speed comes from four limits, and the driver takes the smallest:
       * what the corner will take       v = sqrt(a_lat / curvature)
       * what will stop by the route end v = sqrt(2 a_brake s)
       * what the probe ahead allows
       * what the situation asks for     patrol / pursue / engage / creep
     ================================================================== */

  var A_LAT = 3.4 * 3.5;            /* 0.35 g of lateral grip on tarmac      */
  var CRAWL = 0.92 * 3.5;           /* 0.92 m/s -- walking pace, the floor   */
  var DRIVE_MODES = { patrol: 1, hunt: 1, engage: 1, reverse: 1, recover: 1, kturn: 1, halt: 1 };

  function driveInit(e) {
    e.drv = {
      v: 0, steer: 0, gear: 1,
      route: null, seg: 0, goal: -1, from: -1, node: -1,
      mode: 'patrol', modeT: 0, holdT: 0, replanT: 0,
      revT: 0, revFrom: 0, stuck: 0, blocked: 0,
      rpm: .16, load: 0, gearN: 2, shiftT: 0,
      lastX: e.x, lastZ: e.z, dist: 0,
      lamp: 0, horn: 0, runOver: 0,
      wantSpd: 0, curv: 0, offRoute: 0, born: 0
    };
    return e.drv;
  }

  /* ------------------------------------------------------ route picking -- */
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0, t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* WHERE TO GO NEXT, and how badly it wants to get there.

     The order matters more than the choice. Taking the first road that
     happens to run forward means a vehicle that has just backed out of a
     barricade takes the 26-unit hop to the next node up the same street, and
     then the next, and never leaves it: measured, both vehicles spent five
     minutes on 232 Sk and the other three streets were never visited once.

     So the destination is chosen FIRST -- a barricade to hold, or anywhere
     far enough to be a drive -- and only then does it work out how to get
     pointed at it: straight off if the road runs that way, backing out if it
     is nose-in to a barricade, and a three-point turn otherwise. Turning
     round is a normal part of a patrol, not a failure of one. */
  function pickPatrolGoal(e, d) {
    if (!ROAD.ready) return false;
    var here = d.node >= 0 ? d.node : nearestNode(e.x, e.z, -1);
    if (here < 0) return false;
    var avoid = d.prevGoal, i, k;

    /* THE BEAT.  Until the crew has the player, the patrol keeps to the half
       of the cordon the fight is in: the park, the roundabout and both 232 Sk
       arms.  East of the roundabout -- the canyon, 230 Sk and the east tail --
       is the player's walk-in from the spawn, and a car that cruises down to
       that barricade on its own turns the walk-in into an ambush.  Only the
       DESTINATION is limited, and only here: a hunt replans with
       routeToward(), which this never sees, so once they have him the car
       follows him down the street; the last-resort fallbacks (4.) below are
       left alone. */
    var aware = !!(e.ai && e.ai.known && e.ai.kAge < 14);
    var onBeat = function (n) { return aware || n.x <= PATROL_EAST_X; };

    /* the barricades this patrol exists to hold */
    var ends = [];
    for (i = 0; i < ROAD.ends.length; i++) {
      var id = ROAD.ends[i];
      if (id !== here && id !== avoid && ROAD.nodes[id].ok && onBeat(ROAD.nodes[id])) ends.push(id);
    }
    shuffle(ends);
    /* and anywhere else far enough away to be worth the diesel */
    var far = [];
    for (i = 0; i < ROAD.nodes.length; i++) {
      if (i === here || i === avoid || !ROAD.nodes[i].ok || !onBeat(ROAD.nodes[i])) continue;
      var dx = ROAD.nodes[i].x - e.x, dz = ROAD.nodes[i].z - e.z;
      if (dx * dx + dz * dz >= 90 * 90) far.push(i);
    }
    shuffle(far);
    var order = (Math.random() < .74) ? ends.concat(far) : far.concat(ends);

    /* 1. somewhere worth going that we are already pointed at */
    for (i = 0; i < order.length; i++) if (setRoute(e, d, here, order[i])) return true;
    /* 2. nose-in to a barricade: back out to the junction, there is no room
          to turn in front of one and reversing is what a driver does */
    var hn = ROAD.nodes[here];
    if (d.gear > 0 && hn && hn.links.length <= 1 && reverseOut(e, d)) return true;
    /* 3. somewhere worth going, turning round to get on to it */
    for (i = 0; i < order.length; i++)
      if (setRoute(e, d, here, order[i], true)) { armKturn(e, d); return true; }
    /* 4. anything at all, forwards for preference */
    for (k = 0; k < ROAD.nodes.length; k++)
      if (k !== here && ROAD.nodes[k].ok && setRoute(e, d, here, k)) return true;
    for (k = 0; k < ROAD.nodes.length; k++)
      if (k !== here && ROAD.nodes[k].ok && setRoute(e, d, here, k, true)) { armKturn(e, d); return true; }
    return false;
  }

  function setRoute(e, d, from, to, allowBack) {
    var path = routeBetween(from, to);
    if (!path || path.length < 2) return false;
    var line = pathToLine(path);
    if (!line || line.pts.length < 2) return false;
    /* Start the pursuit at the point nearest the vehicle, not at index 0, or
       a re-plan from the middle of a leg drives back to the leg's start. */
    var bi = 0, bd = 1e18;
    for (var i = 0; i < line.pts.length; i++) {
      var q = line.pts[i], dx = q.wx - e.x, dz = q.wz - e.z, dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; bi = i; }
    }
    /* REFUSE A ROUTE THAT IS ALREADY OVER. If the nearest point is within a
       hull length of the end, the driver will declare arrival on the very
       next tick, pick another goal, and do it again -- twenty times a second.
       Saying no here is what makes pickPatrolGoal try somewhere else. */
    if (line.length - line.pts[bi].s < 24) return false;
    if (!allowBack && Math.abs(d.v) < V.PATROL * .9 && !d.canTurn) {
      var jd = line.pts[bi];
      var dot = Math.sin(e.face) * jd.dx + Math.cos(e.face) * jd.dz;
      if (dot < -.25) return false;
    }
    d.route = line; d.goal = to; d.from = from; d.node = from; d.seg = bi;
    return true;
  }

  /* Route to whichever road node best covers a world point -- used for the
     hunt: the vehicle cannot follow you into KIZILCALAR's stairwell, so it
     parks on the road outside it and waits, which is what one does. */
  function routeToward(e, d, x, z) {
    if (!ROAD.ready) return false;
    var here = d.node >= 0 ? d.node : nearestNode(e.x, e.z, -1);
    var tgt = nearestNode(x, z, -1);
    if (here < 0 || tgt < 0) return false;
    if (tgt === here) return false;
    return setRoute(e, d, here, tgt);
  }

  /* CAN IT TURN ROUND HERE?

     "Does the hull fit sideways" is the wrong question and gives the wrong
     answer: a 5.6 m box laid across a 6.86 m street fits, and a vehicle with
     a 4.9 m turning radius still cannot get there, because turning through
     180 degrees sweeps a corridor two radii wide -- 34 units, where the
     street is 24. Asking the cheap question is how a vehicle ends up creeping
     into a barricade at full lock for the rest of the level.

     So ask the real one: drive the bicycle model at full lock through half a
     turn, ten poses, and require every one of them to fit. It is the
     manoeuvre itself, simulated, which is the only test that cannot be wrong.
     Both hands are tried, because a street has two kerbs. */
  function canTurnAround(e) {
    var side, k;
    var arc = PI * V.TURN_R;                       /* half a circle, in units */
    for (side = -1; side <= 1; side += 2) {
      var ok = true, kap = side * Math.tan(V.LOCK) / V.WB;
      for (k = 1; k <= 10 && ok; k++) {
        var t = arc * k / 10;
        var mid = e.face + kap * t * .5, th = e.face + kap * t;
        if (hullFits(e.x + Math.sin(mid) * t, e.z + Math.cos(mid) * t, th, 0, .3, e.y) === null) ok = false;
      }
      if (ok) return true;
    }
    return false;
  }

  /* ------------------------------------------------------- backing out ---
     At a barricade the vehicle has nowhere to turn: 233. Sokak is 24 units
     kerb to kerb and the hull is 19.6 long, so a three-point turn on the
     carriageway is not a manoeuvre, it is a collision. What a driver does
     instead is reverse to the last junction with room in it.

     The reverse leg is therefore its own SHORT route, from the dead end to
     the nearest node with three or more arms -- not the old route walked
     backwards, which would send a vehicle that had crossed half the map
     reversing all the way home. The route direction is the direction of
     TRAVEL, so keep-right still puts it in the correct lane while it is going
     backwards, which is also correct. */
  function reverseOut(e, d) {
    var here = (d.goal >= 0 && ROAD.nodes[d.goal] && ROAD.nodes[d.goal].ok)
      ? d.goal : nearestNode(e.x, e.z, -1);
    if (here < 0) return false;
    var best = -1, bd = 1e18, i, k;
    for (i = 0; i < ROAD.nodes.length; i++) {
      var n = ROAD.nodes[i];
      if (!n.ok || n.id === here || n.links.length < 3) continue;
      var p = routeBetween(here, n.id);
      if (!p) continue;
      var L = 0;
      for (k = 0; k < p.length - 1; k++)
        L += Math.hypot(ROAD.nodes[p[k + 1]].x - ROAD.nodes[p[k]].x,
                        ROAD.nodes[p[k + 1]].z - ROAD.nodes[p[k]].z);
      if (L < bd) { bd = L; best = n.id; }
    }
    /* allowBack: the whole point of this route is that it runs back the way
       the vehicle is facing. It is the one case the U-turn guard must not
       refuse, because reversing is precisely how the vehicle avoids the
       U-turn it cannot make. */
    if (best < 0 || !setRoute(e, d, here, best, true)) return false;
    d.gear = -1; d.mode = 'reverse'; d.modeT = 0;
    d.revT = clamp(bd / Math.max(1, V.REV) * 2.2 + 5, 8, 34);
    STATS.reversals++;
    return true;
  }

  /* ------------------------------------------------------- pure pursuit -- */
  function pursue(e, d, Ld) {
    var line = d.route;
    if (!line) return null;
    var pts = line.pts, n = pts.length, i;

    /* THE ANCHOR IS THE NEAREST POINT, NOT "EVERYTHING BEHIND ME".
       The obvious tracker walks the anchor forward past every point whose
       bearing is behind the direction of travel. It is also how a stationary
       vehicle pointing the wrong way consumes its entire route in a handful
       of frames: every point is behind it, so every point is eaten, `remain`
       reads zero, the driver believes it has arrived, re-plans, and does it
       again. Measured: 85 re-plans and two hulls sitting at 34 degrees across
       a 6.86 m carriageway with their corners inside the kerb strip.

       So the anchor is the nearest point in a WINDOW around where it already
       was. The window is what keeps it monotone on a route that doubles back
       past itself; the nearest-point test is what stops it running away. */
    var lo = Math.max(0, d.seg - 3), hi = Math.min(n - 1, d.seg + 14);
    var ci = d.seg, bd = 1e18;
    for (i = lo; i <= hi; i++) {
      var p = pts[i], dx = p.wx - e.x, dz = p.wz - e.z, dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; ci = i; }
    }
    d.seg = ci;
    var anchor = pts[ci];
    d.offRoute = Math.sqrt(bd);

    /* Pull the lookahead in when we are off the line. A 30-unit lookahead
       held while 15 units wide of the lane aims the vehicle at a point it can
       reach without ever rejoining its own line; shortening it makes the
       error the thing being corrected. */
    var L2 = Math.max(V.TURN_R, Ld * (1 - clamp(d.offRoute / 26, 0, .40)));
    var want = anchor.s + L2;
    var tI = ci;
    while (tI < n - 1 && pts[tI].s < want) tI++;
    var t = pts[tI];
    d.curv = t.curv;
    /* REMAIN MUST COUNT THE OVERSHOOT. Measuring what is left purely from the
       anchor's arc length saturates the moment the anchor reaches the last
       point: the vehicle carries on past a dead end, twenty units into the
       barricade, still reporting five units to go. Subtracting how far it is
       ALREADY past the anchor makes the number signed, so arriving is
       detected on the way in rather than on the way through. */
    var along = (e.x - anchor.wx) * anchor.dx + (e.z - anchor.wz) * anchor.dz;
    var remain = line.length - anchor.s - Math.max(0, along);
    return { x: t.wx, z: t.wz, y: t.y, idx: tI, end: (n - 1 - ci),
      remain: remain, curv: t.curv };
  }

  /* --------------------------------------------------- forward clearance --
     Three probes down the intended path. Being able to see a wall coming at
     20 units is the difference between braking and hitting it, and a 12-tonne
     hull needs 24 units to stop from patrol speed. */
  /* Three probes down the intended path -- which is an ARC, not a line: a
     hull swept 20 units forward on the current heading while the wheel is on
     half a turn of lock is nowhere near where the vehicle is actually going,
     and probing the straight line is how a car brakes to a standstill for a
     corner it was already turning into. Being able to see a wall coming at 20
     units is the difference between braking and hitting it; twelve tonnes
     needs 24 units to stop from patrol speed. */
  function probeAhead(e, d) {
    var sp = Math.abs(d.v);
    var reach = clamp(V.HALF_L + 4 + sp * sp / (2 * V.BRK) * 1.15, 12, 46);
    var sgn = d.gear < 0 ? -1 : 1;
    var k = Math.tan(d.steer) / V.WB;              /* path curvature, 1/units */
    var free = reach;
    for (var i = 1; i <= 3; i++) {
      var t = reach * i / 3;
      var th = e.face + k * t * sgn;               /* heading after arc length t */
      /* the arc's own chord, so the probe tracks the turn instead of the tangent */
      var mid = e.face + k * t * sgn * .5;
      var px = e.x + Math.sin(mid) * t * sgn;
      var pz = e.z + Math.cos(mid) * t * sgn;
      if (hullFits(px, pz, th, 0, .25, e.y) === null) { free = reach * (i - 1) / 3; break; }
    }
    return free;
  }

  /* ---------------------------------------------- friends and the player --
     A vehicle does not drive through its own dismounts. They are pushed out
     of the way by separateEnemies (the APC is `immovable`), but the driver
     also lifts off, which is what stops the whole thing looking like a plough.
     The player is different: the player gets run over. */
  /* PATIENCE. A dismount who has stopped to shoot never steps aside -- his
     own locomotion zeroes his intent while `stop` is set -- so a rifleman
     standing on the crown of the road would hold twelve tonnes at a
     standstill for the rest of the level. After a second and a half the
     driver leans on it and creeps through; separateEnemies then shoves the
     man clear, because the vehicle is `immovable` and he is not. Which is
     also what happens on a real cordon. */
  function trafficBrake(e, d) {
    if (!G || !G.enemies) return 1;
    var sgn = d.gear < 0 ? -1 : 1;
    var fx = Math.sin(e.face) * sgn, fz = Math.cos(e.face) * sgn;
    var k = 1, i;
    for (i = 0; i < G.enemies.length; i++) {
      var o = G.enemies[i];
      if (o === e || o.dead || (o.cfg && o.cfg.vehicle)) continue;
      var dx = o.x - e.x, dz = o.z - e.z;
      var ahead = dx * fx + dz * fz;
      if (ahead < 0 || ahead > 26) continue;
      var side = Math.abs(dx * (-fz) + dz * fx);
      if (side > V.HALF_W + 1.1) continue;
      k = Math.min(k, clamp((ahead - V.HALF_L - 1.5) / 12, 0, 1));
    }
    /* PATIENCE, RAMPED. 232 Sk north has five dismounts standing on it, and a
       man who has stopped to shoot never steps aside -- his own locomotion
       zeroes his intent while `stop` is set. A flat floor under the brake is
       not enough: measured, a 0.30 floor still left the vehicle at 0.5 u/s
       for the whole level. So the driver's patience runs out on a ramp -- lean
       on the horn at a second and a half, and by five seconds simply drive,
       because shoveInfantry() below is what actually clears the road. */
    if (k < .5) d.trafficT = (d.trafficT || 0) + .016; else d.trafficT = Math.max(0, (d.trafficT || 0) - .05);
    if (d.trafficT > 1.5) {
      if (!d.honked && G.sfx) { G.sfx('apc_horn', e.x, e.z); d.honked = 1; }
      k = Math.max(k, clamp((d.trafficT - 1.5) / 3.5, 0, 1) * .78 + .30);
    } else if (d.trafficT < .4) d.honked = 0;
    return k;
  }

  /* THE HULL PUSHES. separateEnemies already gives the whole correction to
     the man rather than to the `immovable` vehicle, but it only fires on a
     circle-circle overlap of `cfg.rad`, and `rad` is 4.9 on a hull that is
     9.8 long -- so a rifleman standing two metres off the nose is not
     overlapping anything and never moves. This is the oriented version: a man
     inside the real footprint plus a margin is pushed out along whichever
     axis is shortest, at his own top speed, and one who is in the swept
     corridor ahead of a moving vehicle is pushed sideways out of it. It is
     what a crowd does when a vehicle comes through, and it is the thing that
     stops a cordon's own infantry parking it. */
  function shoveInfantry(e, d, dt) {
    if (!G || !G.enemies) return;
    var sp = Math.abs(d.v);
    var c = Math.cos(e.face), s = Math.sin(e.face);
    var padZ = V.HALF_L + 2.0 + sp * .55;          /* look further when moving */
    var padX = V.HALF_W + 1.6;
    var reach = padZ + 4;
    for (var i = 0; i < G.enemies.length; i++) {
      var o = G.enemies[i];
      if (o === e || o.dead || (o.cfg && o.cfg.vehicle)) continue;
      var dx = o.x - e.x, dz = o.z - e.z;
      if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
      var lz = dx * s + dz * c, lx = dx * c - dz * s;
      /* only the half in front matters once we are rolling; a man behind the
         tailgate of a vehicle driving away is not in anybody's way */
      if (sp > 2 && lz < -V.HALF_L - 1) continue;
      if (Math.abs(lz) > padZ || Math.abs(lx) > padX) continue;
      /* out along the shortest axis, but never backwards through the hull */
      var outX = (lx >= 0 ? padX - lx : -padX - lx);
      var outZ = (lz >= 0 ? padZ - lz : -padZ - lz);
      var ux, uz;
      if (Math.abs(outX) <= Math.abs(outZ) || sp > 2) { ux = outX; uz = 0; }
      else { ux = 0; uz = outZ; }
      var step = Math.min(Math.hypot(ux, uz), (o.cfg.spd || 12) * dt * 1.15);
      var m = Math.hypot(ux, uz) || 1;
      ux = ux / m * step; uz = uz / m * step;
      var wx = ux * c + uz * s, wz = -ux * s + uz * c;
      if (G.moveSlide) {
        var p = G.moveSlide(o.x, o.z, wx, wz, o.cfg.rad, o.y, o.cfg.clearance);
        o.x = p[0]; o.z = p[1];
      } else { o.x += wx; o.z += wz; }
      /* and make him break off whatever he was doing, so he does not simply
         plant again in the same square metre next frame */
      if (o.ai) { o.ai.stopMv = false; o.stuckT = 0; o.ai.goalT = 0; }
    }
  }

  function runOverCheck(e, d, dt) {
    var P = G && G.player;
    if (!P || !P.alive || Math.abs(d.v) < 5) return;
    var dx = P.x - e.x, dz = P.z - e.z;
    if (dx * dx + dz * dz > (V.HALF_L + 4) * (V.HALF_L + 4)) return;
    var c = Math.cos(e.face), s = Math.sin(e.face);
    /* world -> hull local, inverting the engine's own yaw mapping */
    var lz = dx * s + dz * c, lx = dx * c - dz * s;
    if (Math.abs(lz) > V.HALF_L - .4 || Math.abs(lx) > V.HALF_W + .6) return;
    d.runOver -= dt;
    if (d.runOver > 0) return;
    d.runOver = .34;
    var sp = Math.abs(d.v);
    if (G.hurtPlayer) G.hurtPlayer(clamp(sp * .62, 6, 46), e.x, e.z);
    /* and shove them clear, so being hit is a knock rather than a grinder */
    var push = (lx >= 0 ? 1 : -1);
    P.x += (c * push) * 2.2; P.z += (-s * push) * 2.2;
    if (G.sfx) G.sfx('impact_metal', e.x, e.z);
  }

  /* =====================================================================
     the drive tick. Called from `enemyDrive`, once per frame, real dt.
     ================================================================== */

  /* Integrate the bicycle model and then ask the world whether that was
     allowed. Three attempts at falling speed, because a hull that is only
     just clipping a kerb should scrub along it, not stop dead. */
  function integrateStep(e, d, dt) {
    for (var k = 0; k < 3; k++) {
      var vv = d.v * (k === 0 ? 1 : k === 1 ? .5 : .22);
      var nf = wrap(e.face + (vv / V.WB) * Math.tan(d.steer) * dt);
      var nx = e.x + Math.sin(nf) * vv * dt;
      var nz = e.z + Math.cos(nf) * vv * dt;
      var gy = hullFits(nx, nz, nf, 0, 0, e.y);
      if (gy !== null) {
        e.x = nx; e.z = nz; e.face = nf; d.v = vv;
        e.y += (gy - e.y) * Math.min(1, dt * 8);
        if (Math.abs(d.v) > 2) d.stuck = Math.max(0, d.stuck - dt * 1.6);
        return true;
      }
    }
    d.stuck += dt;
    STATS.blocked++;
    if (DIAG_BLOCK) {
      var _bk = (e.x / 8 | 0) + ',' + (e.z / 8 | 0);
      BLOCK_CELLS[_bk] = (BLOCK_CELLS[_bk] || 0) + 1;
    }
    /* KNIFE EDGE, and only once scraping has clearly become stuck. A hull
       kissing a kerb refuses a step and then finds one again on the next
       frame, which is what scraping IS -- nudging it every time that happens
       is 200 small teleports a minute. Half a second of no progress is a
       wedge, and then the nudge is worth its cost: eight bearings by three
       radii, nearest first, never more than 2.2 units. */
    if (d.stuck > .55 && unwedge(e, d)) { d.stuck = Math.max(0, d.stuck - .45); return false; }
    if (DIAG_BLOCK) {
      FIT_WHY = [];
      var _vv = d.v, _nf = wrap(e.face + (_vv / V.WB) * Math.tan(d.steer) * dt);
      hullFits(e.x + Math.sin(_nf) * _vv * dt, e.z + Math.cos(_nf) * _vv * dt, _nf, 0, 0, e.y);
      d.blockWhy = { v: _vv, steer: d.steer, gear: d.gear, dt: dt,
        dx: Math.sin(_nf) * _vv * dt, dz: Math.cos(_nf) * _vv * dt,
        dface: _nf - e.face, why: FIT_WHY.slice(), mode: d.mode, want: d.wantSpd };
      FIT_WHY = null;
    }
    d.v *= .12;
    if (d.stuck > 1.1 && d.mode !== 'recover') {
      d.mode = 'recover';
      d.route = null;
      d.modeT = 0;
      if (!escape(e, d)) { d.gear = -d.gear; d.recSteer = (Math.random() < .5 ? -1 : 1) * V.LOCK * .88; }
      d.revT = rr(1.8, 3.0);
      STATS.kturns++;
    }
    return false;
  }

  /* WHICH WAY OUT. Picking a random lock and a random gear is how a wedged
     vehicle wedges itself harder. This sweeps the ten manoeuvres actually
     available -- two gears by five lock positions -- sweeps each one along
     its own arc until the hull stops fitting, and takes the one that buys the
     most room. Ten sweeps of at most eight probes, and only while stuck. */
  var ESC_STEER = null;
  function escape(e, d) {
    if (!ESC_STEER) ESC_STEER = [-V.LOCK, -V.LOCK * .55, 0, V.LOCK * .55, V.LOCK];
    var bestG = 0, bestS = 0, best = 0, g, si, t;
    for (g = -1; g <= 1; g += 2) {
      for (si = 0; si < ESC_STEER.length; si++) {
        var st = ESC_STEER[si], k = Math.tan(st) / V.WB * g, got = 0;
        for (t = 2.5; t <= 20; t += 2.5) {
          var mid = e.face + k * t * .5, th = e.face + k * t;
          if (hullFits(e.x + Math.sin(mid) * t * g, e.z + Math.cos(mid) * t * g, th, 0, 0, e.y) === null) break;
          got = t;
        }
        /* prefer carrying on the way we were pointed, all else equal */
        var score = got + (g === d.gear ? 1.2 : 0);
        if (score > best) { best = score; bestG = g; bestS = st; }
      }
    }
    if (best < 2) return false;
    d.gear = bestG; d.recSteer = bestS;
    return true;
  }

  /* Nudge the hull to the nearest pose that fits, at the heading it already
     has. Nearest first, so it never teleports; refuses anything that would
     move it more than 3.4 units, which is under a metre. */
  var UNW_R = [0.9, 1.5, 2.2];
  function unwedge(e, d) {
    var i, k;
    for (k = 0; k < UNW_R.length; k++) {
      var best = null, bd = 1e18;
      for (i = 0; i < 8; i++) {
        var a = i * PI / 4;
        var nx = e.x + Math.sin(a) * UNW_R[k], nz = e.z + Math.cos(a) * UNW_R[k];
        var gy = hullFits(nx, nz, e.face, 0, 0, e.y);
        if (gy === null) continue;
        /* prefer the direction we were trying to go */
        var fwd = Math.sin(e.face) * Math.sin(a) + Math.cos(e.face) * Math.cos(a);
        var score = UNW_R[k] - fwd * (d.gear < 0 ? -1.2 : 1.2);
        if (score < bd) { bd = score; best = { x: nx, z: nz, y: gy }; }
      }
      if (best) {
        e.x = best.x; e.z = best.z; e.y = best.y;
        d.v *= .35;
        STATS.unwedged++;
        return true;
      }
    }
    return false;
  }

  /* =====================================================================
     THE THREE-POINT TURN.

     Reversing does not change which way a vehicle faces. Back out of a
     barricade and you are at the junction still pointing at the barricade,
     and the only road that does not begin with a U-turn is the one you just
     came down -- so the vehicle shuttles up and down a single street for the
     rest of the level, which is exactly what it did: 32 reversals in five
     minutes, both vehicles on 232 Sk, the other three streets never visited.

     A U-turn in one sweep needs two turning radii plus the width: 41 units,
     against a 24-unit carriageway. What fits is what a driver does instead --
     full lock one way, full lock the other, as many bites as it takes. Each
     bite of arc length L buys L/R radians, and 20 units against a 17.1-unit
     radius is 67 degrees, so 180 degrees is three bites. Hence the name.

     A bite ends when the probe says the room has gone, when the hull refuses
     a step, or on a timer; then the gear swaps and the lock goes over. Nine
     bites and it gives up and drives the route as best it can, because a
     vehicle that will not stop shuffling is worse than one pointing the
     wrong way.
     ================================================================== */
  function armKturn(e, d) {
    var pts = d.route && d.route.pts;
    if (!pts) return false;
    var j = pts[Math.min(d.seg, pts.length - 1)];
    d.kturnFace = Math.atan2(j.dx, j.dz);
    d.mode = 'kturn'; d.gear = 1; d.kturnT = 2.4; d.kturnN = 0;
    STATS.kturns++;
    return true;
  }

  function kturnTick(e, d, dt) {
    var err = wrap(d.kturnFace - e.face);
    if (Math.abs(err) < .30) {
      d.mode = 'patrol'; d.gear = 1; d.kturnN = 0;
      d.steer = toward(d.steer, 0, V.LOCK_RATE * dt);
      publish(e, d, dt);
      return;
    }
    /* the lock that shortens the error. Reversing traces the same circle from
       the other end, so the wheel goes the other way. */
    var lock = (err > 0 ? 1 : -1) * V.LOCK * (d.gear < 0 ? -1 : 1);
    d.steer = toward(d.steer, lock, V.LOCK_RATE * dt);
    var free = probeAhead(e, d);
    var want = Math.min(V.REV * 1.2, Math.max(CRAWL,
      Math.sqrt(Math.max(0, 2 * V.BRK * Math.max(0, free - V.HALF_L - 1.8)))));
    d.wantSpd = want;
    d.v = toward(d.v, (d.gear < 0 ? -1 : 1) * want, V.ACC * dt);
    var moved = integrateStep(e, d, dt);
    d.kturnT -= dt;
    if (!moved || free < V.HALF_L + 2.4 || d.kturnT <= 0) {
      d.gear = -d.gear;
      d.kturnT = 2.4;
      d.v *= .18;
      d.stuck = 0;
      d.kturnN = (d.kturnN || 0) + 1;
      if (d.kturnN > 9) { d.mode = 'patrol'; d.gear = 1; }
    }
    publish(e, d, dt);
  }

  /* everything the rest of the game reads off a moving actor */
  function publish(e, d, dt) {
    var sp = Math.abs(d.v);
    e.vx = Math.sin(e.face) * d.v;
    e.vz = Math.cos(e.face) * d.v;
    e.turnV = (d.v / V.WB) * Math.tan(d.steer);
    e.gait += sp * dt / Math.max(1, e.cfg.stride || 12);
    if (e.ai) e.ai.speed = sp;
    e.speedSm = damp(e.speedSm, clamp(sp / Math.max(1, V.PURSUE), 0, 1), .02, dt);
    var target = clamp(sp / V.PURSUE, 0, 1);
    var demand = clamp((d.wantSpd - sp) / Math.max(1, V.PURSUE) + target * .5, 0, 1);
    d.load = damp(d.load, demand, .04, dt);
    d.rpm = damp(d.rpm, .16 + target * .74 + d.load * .22, .06, dt);
    e.lx = 0; e.lz = 0; e.leanAmt = 0; e.crouch = 0;
    shoveInfantry(e, d, dt);
    runOverCheck(e, d, dt);
  }

  /* spawnEnemy hands every actor `face: rr(0, TAU)`, which for a man is a
     shrug and for a 5.6 m hull parked across a 6.86 m carriageway is a
     vehicle that is stuck before it has moved. So on its first tick the
     vehicle squares itself up with the road it is standing on, keeping
     whichever of that road's two directions is closer to the bearing it was
     given, and steps onto the node itself if the cell it woke up in will not
     take the hull. */
  function settle(e, d) {
    d.settled = true;
    var n = nearestNode(e.x, e.z, -1);
    if (n < 0) return;
    var node = ROAD.nodes[n], i;
    var bestAng = e.face, bestScore = -2;
    for (i = 0; i < node.links.length; i++) {
      var m = ROAD.nodes[node.links[i]];
      var ang = Math.atan2(m.x - node.x, m.z - node.z);
      if (hullFits(e.x, e.z, ang, 0, 0, null) === null) continue;
      var sc = Math.cos(wrap(ang - e.face));
      if (sc > bestScore) { bestScore = sc; bestAng = ang; }
    }
    if (bestScore < -1) {
      for (i = 0; i < node.links.length; i++) {
        var mm = ROAD.nodes[node.links[i]];
        var a2 = Math.atan2(mm.x - node.x, mm.z - node.z);
        if (hullFits(node.x, node.z, a2, 0, 0, null) !== null) {
          e.x = node.x; e.z = node.z; bestAng = a2; break;
        }
      }
    }
    e.face = bestAng;
    var gy = hullFits(e.x, e.z, e.face, 0, 0, null);
    if (gy !== null) e.y = gy;
    d.node = n;
    pickPatrolGoal(e, d);
  }

  function driveTick(e, dt) {
    var d = e.drv || driveInit(e);
    var a = e.ai;
    dt = clamp(dt, .0005, .06);
    d.born += dt;
    if (!ROAD.ready || !a) { d.v = damp(d.v, 0, .02, dt); publish(e, d, dt); return; }
    if (!d.settled) settle(e, d);

    if (d.mode === 'kturn') { kturnTick(e, d, dt); return; }

    /* ---- recovery. No route: a driver who has put it into something winds
       on opposite lock and backs out until the mirrors are clear. --------- */
    if (d.mode === 'recover') {
      d.escT = (d.escT || 0) - dt;
      if (d.escT <= 0) { d.escT = .45; escape(e, d); }
      d.steer = toward(d.steer, d.recSteer || 0, V.LOCK_RATE * dt);
      var freeR = probeAhead(e, d);
      var wantR = Math.min(V.REV, Math.max(CRAWL * 1.7,
        Math.sqrt(Math.max(0, 2 * V.BRK * Math.max(0, freeR - V.HALF_L - 2)))));
      d.wantSpd = wantR;
      d.v = toward(d.v, (d.gear < 0 ? -1 : 1) * wantR, V.ACC * dt);
      integrateStep(e, d, dt);
      publish(e, d, dt);
      d.revT -= dt;
      if (d.revT <= 0) {
        d.mode = 'patrol'; d.gear = 1; d.stuck = 0; d.recSteer = 0;
        d.node = nearestNode(e.x, e.z, -1);
        if (!pickPatrolGoal(e, d)) d.route = null;
      }
      return;
    }

    /* ---- 1. what is the vehicle trying to do? ------------------------- */
    var mode = 'patrol', base = V.PATROL;
    var known = a.known, see = a.see;
    var dK = known ? Math.hypot(a.kx - e.x, a.kz - e.z) : 1e9;
    if (e.subsys && e.subsys.mobility <= 0) { mode = 'halt'; base = 0; }
    else if (d.mode === 'reverse') { mode = 'reverse'; }
    else if (d.mode === 'kturn') { mode = 'kturn'; }
    else if (see) {
      /* Eyes on. A stabilised remote station shoots on the move, but the crew
         still wants a firing position, and creeping is what gives the player
         the beat they need to get off the street. */
      mode = 'engage';
      base = dK > (e.cfg.ai.far || 160) ? V.PURSUE
        : dK > (e.cfg.ai.close || 30) ? V.PATROL * .70 : 0;
    } else if (known && a.kAge < 14) { mode = 'hunt'; base = V.PURSUE; }
    else if (a.alert > .3) { mode = 'hunt'; base = V.PATROL * 1.25; }
    if (mode !== d.mode && DRIVE_MODES[mode]) { d.mode = mode; d.modeT = 0; }
    d.modeT += dt;

    /* ---- 2. routing ---------------------------------------------------- */
    d.replanT -= dt;
    if (!d.route) { pickPatrolGoal(e, d); d.replanT = 1.2; }
    if ((mode === 'hunt' || mode === 'engage') && d.replanT <= 0 && known) {
      d.replanT = rr(1.5, 2.6);
      var gn = nearestNode(a.kx, a.kz, -1);
      if (gn >= 0 && gn !== d.goal) routeToward(e, d, a.kx, a.kz);
    }

    /* THE LOOKAHEAD FLOOR. Pure pursuit is only stable while the lookahead
       is comfortably longer than the vehicle's own minimum turning radius,
       which here is WB/tan(LOCK) = 11.55/0.674 = 17.1 units. An 11-unit
       lookahead is two thirds of that: the driver asks for a curve tighter
       than the steering can produce, arrives wide, asks harder, and the
       vehicle drives in circles at full lock -- measured, on the apron, for
       two minutes. So the floor is 21, a comfortable margin over 17.1 and
       about one vehicle length. */
    /* the turning-circle answer, refreshed twice a second: setRoute asks it
       for every candidate goal and it costs twenty footprint probes */
    d.turnOkT = (d.turnOkT || 0) - dt;
    if (d.turnOkT <= 0) { d.turnOkT = .5; d.canTurn = canTurnAround(e); }

    var Ld = clamp(V.TURN_R * 1.22 + Math.abs(d.v) * .60, 21, 38);
    var tgt = pursue(e, d, Ld);

    /* ---- 3. end of the line -------------------------------------------- */
    if (!tgt || tgt.remain < 7) {
      if (d.gear < 0) {
        /* the reverse leg is done; we are back at a junction with room in it */
        d.gear = 1; d.mode = 'patrol'; d.stuck = 0; d.revT = 0;
        d.prevGoal = d.from;            /* the dead end we just backed out of */
        d.node = nearestNode(e.x, e.z, -1);
        if (!pickPatrolGoal(e, d)) d.route = null;
      } else {
        d.node = (d.goal >= 0) ? d.goal : nearestNode(e.x, e.z, -1);
        d.prevGoal = d.from;
        var hn = ROAD.nodes[d.node];
        /* is there room to swing it round here? On the carriageway there
           never is; on the roundabout apron and out in the park there is. */
        var wide = canTurnAround(e);
        if (hn && hn.links.length <= 1 && !wide) {
          if (!reverseOut(e, d)) { d.gear = 1; if (!pickPatrolGoal(e, d)) d.route = null; }
        } else {
          d.gear = 1; d.mode = 'patrol';
          if (!pickPatrolGoal(e, d)) d.route = null;
        }
      }
      tgt = pursue(e, d, Ld);
      if (!tgt) { d.v = damp(d.v, 0, .05, dt); publish(e, d, dt); return; }
    }

    /* ---- 4. steering ---------------------------------------------------- */
    var bearing = Math.atan2(tgt.x - e.x, tgt.z - e.z);
    var motion = d.gear < 0 ? wrap(e.face + PI) : e.face;
    var alpha = wrap(bearing - motion);
    var reach = Math.max(6, Math.hypot(tgt.x - e.x, tgt.z - e.z));
    var kappa = 2 * Math.sin(alpha) / reach * (d.gear < 0 ? -1 : 1);
    var wantSteer = clamp(Math.atan(kappa * V.WB), -V.LOCK, V.LOCK);
    /* at a standstill the wheel still turns, but slower: there is no power
       assist on a locked hull, and rate-limiting here is what stops the
       vehicle snapping to full lock while stopped and then leaping sideways
       the instant it rolls */
    var rate = V.LOCK_RATE * (Math.abs(d.v) < 1.2 ? .45 : 1);
    d.steer = toward(d.steer, wantSteer, rate * dt);

    /* ---- 5. speed ------------------------------------------------------- */
    var vCorner = tgt.curv > 1e-4 ? Math.sqrt(A_LAT / tgt.curv) : 1e9;
    var vEnd = Math.sqrt(Math.max(0, 2 * V.BRK * Math.max(0, tgt.remain - 5)));
    var free = probeAhead(e, d);
    /* CRAWL. The probe is a limiter, never a veto: a want of exactly zero is
       a standstill that integrateStep never sees, so `stuck` never rises and
       nothing ever escalates. Leaving a 0.9 m/s crawl in makes integrateStep
       the authority on whether a move is legal -- it refuses, the stuck timer
       climbs, and recovery happens for the reason it exists. */
    var vProbe = Math.max(CRAWL, Math.sqrt(Math.max(0, 2 * V.BRK * Math.max(0, free - V.HALF_L - 2.5))));
    var vTraffic = trafficBrake(e, d);
    var want = Math.min(base, vCorner, vEnd, vProbe);
    want *= vTraffic;
    d.dbg = { base: base, corner: vCorner, end: vEnd, probe: vProbe, traffic: vTraffic,
      free: free, curv: tgt.curv, remain: tgt.remain, seg: d.seg,
      n: d.route ? d.route.pts.length : 0, alpha: alpha, off: d.offRoute };
    /* lift off through big steering inputs: nobody takes a junction flat */
    want *= (1 - clamp(Math.abs(d.steer) / V.LOCK, 0, 1) * .42);
    if (e.subsys) want *= e.subsys.mobility;
    if (d.mode === 'reverse') want = Math.min(want, V.REV);
    if (d.mode === 'halt') want = 0;
    d.wantSpd = want;

    var signed = d.gear < 0 ? -want : want;
    var lim = (Math.abs(signed) > Math.abs(d.v) ? V.ACC : V.BRK) * dt;
    d.v = toward(d.v, signed, lim);

    /* ---- 6. integrate --------------------------------------------------- */
    integrateStep(e, d, dt);

    /* PINNED. A vehicle commanded to zero stays at zero for ever: nothing
       moves, so integrateStep never fails and `stuck` never rises. A driver
       who has been sitting at a standstill he did not choose backs off and
       tries again, so count the standstill on its own clock. */
    /* Not "wanted nothing and got nothing" -- `want` is 2.8 while the
       integrator is throttling every step to a fifth of it, which is a
       standstill the old test could not see. What matters is that the
       vehicle is not moving and did not choose to stop. */
    if (Math.abs(d.v) < 1.1 && d.mode !== 'engage' && d.mode !== 'halt')
      d.pinT = (d.pinT || 0) + dt;
    else d.pinT = 0;
    if (d.pinT > 2.2) {
      d.pinT = 0;
      d.mode = 'recover';
      d.gear = -d.gear;
      d.recSteer = (Math.random() < .5 ? -1 : 1) * V.LOCK * .88;
      d.revT = rr(1.4, 2.6);
      d.route = null;
      STATS.pinned++;
    }

    /* safety timeout on the reverse leg, so a blocked barricade cannot pin
       a vehicle in permanent reverse */
    if (d.mode === 'reverse') {
      d.revT -= dt;
      if (d.revT <= 0) {
        d.gear = 1; d.mode = 'patrol'; d.stuck = 0;
        d.node = nearestNode(e.x, e.z, -1);
        if (!pickPatrolGoal(e, d)) d.route = null;
      }
    }
    /* the line ran out from under us: a door shut, a prop moved, a shove */
    if (d.offRoute > 26 && d.replanT <= 0) {
      d.replanT = 1.4;
      d.node = nearestNode(e.x, e.z, -1);
      if (!pickPatrolGoal(e, d)) d.route = null;
    }

    publish(e, d, dt);
  }

  /* =====================================================================
     SECTION 9 -- presentation.

     Suspension first, because everything else hangs off it. Each wheel gets a
     spring-damper against the ground it is actually standing on; the body's
     heave, pitch and roll are then SOLVED from the four wheel positions
     rather than authored, which is why the vehicle leans into the camber on
     233. Sokak and squats on its rear axle pulling out of the roundabout
     without anybody writing an animation for either.

     On top of the geometric solution sits load transfer -- dive under
     braking, squat under power, roll into a corner -- because a suspension
     that only answers the road reads as a trolley.
     ================================================================== */

  var SPRING = 62, DAMPER = 11.5, TRAVEL = 1.30;

  function suspend(e, rig, dt) {
    var st = rig.state, i;
    var s = Math.sin(e.face), c = Math.cos(e.face);
    var yF = 0, yR = 0, yL = 0, yRt = 0, grounded = 0;
    for (i = 0; i < 4; i++) {
      var w = rig.wheels[i];
      var lx = w.side * HTR, lz = w.front ? AXF : AXR;
      var wx = e.x + lx * c + lz * s;
      var wz = e.z - lx * s + lz * c;
      var gy = groundAt(wx, wz, e.y);
      /* the wheel centre wants to sit one radius over its own contact patch;
         a deflated tyre sits lower, which is the whole visual of a shot-out
         run-flat still limping the vehicle home */
      var restR = TR - w.flat * (TR * .34);
      var want = (gy - e.y) + restR;
      want = clamp(want, TR - TRAVEL, TR + TRAVEL);
      var f = (want - w.y) * SPRING - w.compV * DAMPER;
      w.compV += f * dt;
      w.compV = clamp(w.compV, -70, 70);
      w.y += w.compV * dt;
      w.y = clamp(w.y, TR - TRAVEL * 1.15, TR + TRAVEL * 1.15);
      w.steer.position.y = w.y;
      if (Math.abs(w.y - want) < TRAVEL) grounded++;
      if (w.front) yF += w.y * .5; else yR += w.y * .5;
      if (w.side < 0) yL += w.y * .5; else yRt += w.y * .5;
      /* roll and steer */
      var d = e.drv;
      var spin = d ? d.v : 0;
      /* a flat tyre has a smaller rolling radius, so it spins faster */
      w.spin += (spin / Math.max(.6, restR)) * dt * (w.blown ? 1.35 : 1);
      w.roll.rotation.x = w.spin;
      if (w.front && d) {
        /* Ackermann: the inside wheel takes more lock than the outside one.
           1.15 / 0.87 is the split a 3.3 m wheelbase on a 2.05 m track wants,
           and at full lock it is 4 degrees of visible difference. */
        var inner = (d.steer > 0) === (w.side > 0);
        w.steer.rotation.y = d.steer * (inner ? 1.15 : .87) * (w.blown ? .8 : 1);
      }
    }
    /* geometric attitude, then the dynamic term on top */
    var geoPitch = -Math.atan2(yF - yR, V.WB);
    var geoRoll = Math.atan2(yRt - yL, V.TRACK);
    var heave = (yF + yR) * .5 - TR;

    var d2 = e.drv;
    var aLong = 0, aLat = 0;
    if (d2) {
      aLong = (Math.abs(d2.v) - st.lastSpeed) / Math.max(dt, 1e-4);
      aLong = clamp(aLong * (d2.v < 0 ? -1 : 1), -V.BRK * 1.4, V.ACC * 1.6);
      st.lastSpeed = Math.abs(d2.v);
      aLat = clamp(d2.v * e.turnV, -A_LAT * 1.5, A_LAT * 1.5);
    }
    /* 12 tonnes on soft military springs: 1.1 degrees of dive per m/s^2 */
    var dynPitch = -aLong * .0052;
    var dynRoll = -aLat * .0068;

    st.pitch = damp(st.pitch, geoPitch + dynPitch, .0008, dt);
    st.roll = damp(st.roll, geoRoll + dynRoll, .0008, dt);
    st.heave = damp(st.heave, heave, .0006, dt);
    rig.body.position.y = 2.5 + st.heave + st.jolt;
    rig.body.rotation.x = st.pitch;
    rig.body.rotation.z = st.roll;
    st.jolt = damp(st.jolt, 0, .0002, dt);
    return grounded;
  }

  /* --------------------------------------------------------- the turret --
     A stabilised station. It traverses at 80 deg/s, elevates from -10 to +40,
     and it takes OUT most of the hull's pitch and roll -- which is what makes
     a vehicle firing on the move read as a modern one, and is also the reason
     the barrel stays on you while the hull is bucking over a kerb. */
  var TRAV_RATE = 1.40, ELEV_RATE = 0.95;
  var ELEV_MIN = -0.175, ELEV_MAX = 0.70;

  function aimTurret(e, rig, dt) {
    var st = rig.state;
    var wantWorld = fin(e.aimYaw, e.face);
    var wantRel = wrap(wantWorld - e.face);
    var wantP = clamp(fin(e.aimPitch, 0), ELEV_MIN, ELEV_MAX);
    /* a damaged drive traverses slowly and hunts around the mark */
    var health = e.subsys ? e.subsys.rcws : 1;
    var rate = TRAV_RATE * (.35 + .65 * health);
    var prev = st.turretYaw;
    st.turretYaw = towardAng(st.turretYaw, wantRel, rate * dt);
    if (health < .55) st.turretYaw += Math.sin(st.seed + performance.now() * .004) * .012 * (1 - health);
    st.turretVel = wrap(st.turretYaw - prev) / Math.max(dt, 1e-4);
    st.turretPitch = toward(st.turretPitch, wantP, ELEV_RATE * (.4 + .6 * health) * dt);

    rig.rcws.yaw.rotation.y = st.turretYaw;
    /* stabilisation: 88% of hull attitude removed, never 100% -- a perfect
       platform looks like the turret is not attached to the vehicle */
    var recoil = clamp(fin(e.recoilT, 0) / .12, 0, 1);
    rig.rcws.pitch.rotation.x = -st.turretPitch - st.pitch * .88 + recoil * .045;
    rig.rcws.pitch.rotation.z = -st.roll * .85;
    rig.rcws.pitch.position.z = .50 - recoil * .30;
  }

  /* ----------------------------------------------------- the searchlight --
     On patrol it sweeps. The moment the crew has a contact it pins it, and
     being pinned is the tell that the gun is coming round. */
  function aimLight(e, rig, dt, now) {
    var st = rig.state, L = rig.light;
    var a = e.ai;
    var want, wantP = -.12, lock = 0;
    if (a && (a.see || (a.known && a.kAge < 6))) {
      var tx = a.kx - e.x, tz = a.kz - e.z;
      want = wrap(Math.atan2(tx, tz) - e.face);
      var dist = Math.hypot(tx, tz) || 1;
      wantP = clamp(Math.atan2((a.ky || e.y) - (e.y + 8.6), dist), -.55, .28);
      lock = a.see ? 1 : .55;
    } else {
      L.sweep += dt * .62;
      want = Math.sin(L.sweep) * 1.15 + Math.sin(L.sweep * .37 + st.seed) * .35;
      wantP = -.10 + Math.sin(L.sweep * .8) * .05;
    }
    L.yaw.rotation.y = towardAng(L.yaw.rotation.y, want, 1.9 * dt);
    L.pitch.rotation.x = -toward(-L.pitch.rotation.x, wantP, 1.3 * dt);
    L.lock = damp(L.lock, lock, .02, dt);

    /* Daylight on the cordon: the shaft is a hint, not a beam. On the night
       missions it earns real opacity. */
    var day = NZ.level === 4;
    var reach = 132;
    var on = clamp(.28 + L.lock * .72, 0, 1);
    L.beam.scale.set(reach * .30, reach, reach * .30);
    L.beam.rotation.x = PI / 2;
    L.beam.position.set(0, 0, reach * .5 + .7);
    L.beamMat.opacity = on * (day ? .085 : .30) * (1 + Math.sin(now * 7 + st.seed) * .05);
    L.lensMat.emissiveIntensity = .55 + on * 2.1;
    if (L.spot) {
      L.spot.intensity = on * (day ? 1.1 : 3.4);
      L.spot.distance = reach;
    }
  }

  /* ------------------------------------------------------------- effects - */
  function fxTick(e, rig, dt, now) {
    var st = rig.state, d = e.drv, i;
    var sp = d ? Math.abs(d.v) : 0;

    /* --- muzzle: flash cards, brass, heat, light --- */
    if (e.muzzlePulse > .5 && st.flashT <= 0) {
      st.flashT = .058;
      st.heat = clamp(st.heat + .075, 0, 1);
      st.brassT = 1;
      STATS.shots++;
    }
    if (st.flashT > 0) {
      st.flashT -= dt;
      var k = clamp(st.flashT / .058, 0, 1);
      var sc = (2.6 + hash1(now * 91) * 1.9) * (0.45 + k * .55);
      rig.flash.scale.set(sc, sc, sc);
      rig.flash.rotation.z = hash1(now * 53) * TAU;
      rig.flashMat.opacity = k * .92;
      rig.flash.visible = true;
      if (rig.mLight) rig.mLight.intensity = k * 5.2;
    } else {
      rig.flash.visible = false;
      rig.flashMat.opacity = 0;
      if (rig.mLight && rig.mLight.intensity > 0)
        rig.mLight.intensity = Math.max(0, rig.mLight.intensity - dt * 22);
    }
    /* the heat band on the barrel. Twelve rounds of a burst will show. */
    st.heat = Math.max(0, st.heat - dt * .085);
    rig.mats.hot.emissiveIntensity = st.heat * st.heat * 2.4;
    rig.mats.hot.color.setRGB(.14 + st.heat * .12, .15, .17);

    /* brass off the case chute, in the vehicle's own frame so it is thrown
       sideways and back the way a belt-fed gun actually throws it */
    if (st.brassT > 0 && G && G.particle) {
      st.brassT = 0;
      var mw = rig.muzzle;
      mw.updateWorldMatrix(true, false);
      _v3.set(.9, -1.1, -2.6).applyMatrix4(rig.rcws.pitch.matrixWorld);
      var s = Math.sin(e.face), c = Math.cos(e.face);
      var ex = (c * 5.5 - s * 0) * .55, ez = (-s * 5.5) * .55;
      var q = G.particle('casebrass', _v3.x, _v3.y, _v3.z,
        ex + rr(-2, 2) + e.vx * .6, rr(4, 8), ez + rr(-2, 2) + e.vz * .6,
        .55, rr(.7, 1.2), -34, false);
      void q;
    }

    /* --- exhaust. Diesel smokes on load and puffs on a shift. --- */
    st.smokeT -= dt;
    if (d && st.smokeT <= 0 && G && G.particle) {
      var loadK = clamp(d.load * 1.35 + (d.rpm - .16) * .5, 0, 1);
      st.smokeT = lerp(.34, .085, loadK);
      var sx = Math.sin(e.face), cz = Math.cos(e.face);
      /* stack is at local (4.05, 8.0, -7.40) */
      var px = e.x + 4.05 * cz + (-7.40) * sx;
      var pz = e.z - 4.05 * sx + (-7.40) * cz;
      var pm = G.particle('smoke', px, e.y + 8.3, pz,
        rr(-.7, .7) + e.vx * .30, rr(1.4, 3.2), rr(-.7, .7) + e.vz * .30,
        rr(1.4, 2.6) + loadK * 2.2, rr(.55, 1.05), -1.1, false);
      if (pm && pm.mat) {
        var g0 = .30 - loadK * .18;
        pm.mat.color.setRGB(g0, g0 * .98, g0 * .92);
        pm.mat.opacity = .32 + loadK * .26;
      }
    }
    /* --- dust off the driven wheels on the slope and the gravel apron --- */
    st.dustT -= dt;
    if (sp > 11 && st.dustT <= 0 && G && G.particle) {
      st.dustT = .085;
      for (i = 2; i < 4; i++) {
        var w = rig.wheels[i];
        var lx2 = w.side * HTR, lz2 = AXR - 1.2;
        var s2 = Math.sin(e.face), c2 = Math.cos(e.face);
        var dx = e.x + lx2 * c2 + lz2 * s2, dz = e.z - lx2 * s2 + lz2 * c2;
        var pd = G.particle('smoke', dx, e.y + .5, dz,
          rr(-1.4, 1.4) - e.vx * .10, rr(.6, 1.8), rr(-1.4, 1.4) - e.vz * .10,
          rr(1.6, 3.0), rr(.35, .7), -1.6, false);
        if (pd && pd.mat) { pd.mat.color.setRGB(.62, .58, .48); pd.mat.opacity = .17; }
      }
    }

    /* --- beacons: two amber rotators, out of phase --- */
    st.beacon += dt * 5.6;
    var b = Math.max(0, Math.sin(st.beacon));
    rig.mats.amber.emissiveIntensity = .35 + b * b * 2.6;
    /* dipped headlamps stay on: a cordon vehicle runs lit in daylight */
    rig.mats.lamp.emissiveIntensity = .34 + Math.max(0, Math.sin(st.beacon * .5)) * .05;

    /* --- aerials. Two whips with their own inertia, driven by chassis
       acceleration in the hull frame. This is the readout for how hard the
       thing is being driven, and it costs two springs. --- */
    var axw = (e.vx - st.lastVx) / Math.max(dt, 1e-4);
    var azw = (e.vz - st.lastVz) / Math.max(dt, 1e-4);
    st.lastVx = e.vx; st.lastVz = e.vz;
    var sf = Math.sin(e.face), cf = Math.cos(e.face);
    var aFwd = clamp((axw * sf + azw * cf) * .0016, -.6, .6);
    var aSide = clamp((axw * cf - azw * sf) * .0016, -.6, .6);
    for (i = 0; i < rig.aerials.length; i++) {
      var ae = rig.aerials[i];
      var ph = i * 1.7 + st.seed;
      ae.vx += (-ae.x * 30 - ae.vx * 3.1 - aFwd * 26 + Math.sin(now * 2.2 + ph) * .5 * sp * .02) * dt;
      ae.vz += (-ae.z * 30 - ae.vz * 3.1 - aSide * 26 + Math.cos(now * 1.9 + ph) * .5 * sp * .02) * dt;
      ae.x = clamp(ae.x + ae.vx * dt, -.55, .55);
      ae.z = clamp(ae.z + ae.vz * dt, -.55, .55);
      ae.grp.rotation.x = ae.x;
      ae.grp.rotation.z = ae.z;
    }
  }

  /* =====================================================================
     SECTION 10 -- armour, subsystems and the wreck.

     THE PROBLEM WITH THE STOCK HIT MODEL. `hitscan` broad-phases every actor
     as a vertical cylinder of `cfg.hitRad` and `enemyHitZone` splits it into
     head / body / legs by height band and lateral distance. For a 5.6 x 2.5 m
     box that cylinder has to be 10.3 units to reach the bumper, which makes
     1.1 m of empty air beside each flank shootable, and "head at 76% of
     stature" is not a sentence about an armoured car.

     So this module supplies both halves itself:

       enemyRayTest  -- a real ray/oriented-box narrow phase against the hull
                        and the traversed turret. Miss the vehicle and the
                        round goes past it and hits the wall behind, which is
                        what a round does.
       enemyHitZone  -- armour, not anatomy:

            ARMOUR PLATE   x0.11  sparks, and nothing else
            BELLY / GEAR   x0.55
            WHEEL          x0.90  and it deflates the tyre it hit
            VISION BLOCK   x1.25
            ENGINE DECK    x1.90  the louvres over the bonnet
            RCWS OPTIC     x2.60  the only glass on the station

     That is the whole design of the fight. Rifle fire into the flank is a
     light show; the answers are the RPG (three rockets), the engine louvres
     from in front, and the sensor pod, which does not kill it but does blind
     it. Every one of those requires the player to be somewhere specific, and
     the somewhere is always exposed.
     ================================================================== */

  var Z_HULL = { mult: .11, name: 'armour' };
  var Z_LOW  = { mult: .55, name: 'legs' };
  var Z_WHEEL= { mult: .90, name: 'wheel' };
  var Z_GLASS= { mult: 1.25, name: 'block' };
  var Z_DECK = { mult: 1.90, name: 'deck' };
  var Z_OPTIC= { mult: 2.60, name: 'head' };
  var Z_GUN  = { mult: 1.45, name: 'mantlet' };

  function toLocal(e, hx, hy, hz, out) {
    var c = Math.cos(e.face), s = Math.sin(e.face);
    var dx = hx - e.x, dz = hz - e.z;
    out[0] = dx * c - dz * s;      /* +X starboard */
    out[1] = hy - e.y;             /* +Y up        */
    out[2] = dx * s + dz * c;      /* +Z forward   */
    return out;
  }
  var _loc = [0, 0, 0];

  function apcZone(e, hx, hy, hz) {
    var L = toLocal(e, hx, hy, hz, _loc);
    var lx = L[0], ly = L[1], lz = L[2], i;
    var rig = e.rig && e.rig.apcModule ? e.rig : null;

    /* --- the station, in its own traversed frame --- */
    if (rig && ly > 7.7) {
      var ty = rig.state.turretYaw;
      var tc = Math.cos(ty), ts = Math.sin(ty);
      /* the ring sits at hull (0, 8.23, .60) */
      var ux = lx, uz = lz - .60, uy = ly - 8.23;
      var qx = ux * tc - uz * ts, qz = ux * ts + uz * tc;
      /* sensor pod: the one piece of glass on the whole station */
      if (qx > -2.85 && qx < -1.05 && uy > .30 && uy < 1.85 && qz > -.20 && qz < 1.65)
        return Z_OPTIC;
      /* barrel and cradle */
      if (Math.abs(qx) < .95 && uy > .05 && uy < 1.35 && qz > 1.2) return Z_GUN;
      return Z_HULL;                      /* the rest of the station is plate */
    }

    /* --- engine louvres over the bonnet: the deck really is the weak spot --*/
    if (lz > 6.6 && lz < 9.9 && ly > 5.0 && ly < 6.6 && Math.abs(lx) < 3.6) return Z_DECK;
    /* --- the fuel and battery bay behind the rear axle --- */
    if (lz < -6.2 && ly > 2.2 && ly < 4.6 && Math.abs(lx) > 2.4) return Z_DECK;

    /* --- glass: screen, door lights, vision blocks, rear block --- */
    if (ly > 5.9 && ly < 7.6) {
      if (lz > 4.4 && lz < 7.6) return Z_GLASS;                    /* screen  */
      if (Math.abs(lx) > 4.0 && lz > -9.0 && lz < 6.0) return Z_GLASS;
      if (lz < -9.0) return Z_GLASS;
    }
    /* --- wheels --- */
    for (i = 0; i < 4; i++) {
      var wz = (i < 2) ? AXF : AXR, ws = (i & 1) ? 1 : -1;
      if (Math.abs(lx - ws * HTR) < TW * 1.5 + .7 &&
          Math.abs(lz - wz) < TR + .8 && ly < TR * 2.15) {
        e._apcWheel = i;
        return Z_WHEEL;
      }
    }
    if (ly < 2.35) return Z_LOW;
    return Z_HULL;
  }

  /* ------------------------------------------------- ray / oriented box ---
     Two slabs: the hull and the turret. The hull box runs 0.15..7.85 up so a
     round into the running gear still connects, and 10.3 forward so the bull
     bar is not a hole. `bestT` is the current nearest hit, so a wall in front
     of the vehicle still wins. */
  function slab(ox, oy, oz, dx, dy, dz, cx, cy2, cz, hx, hy, hz, maxT) {
    var t0 = .01, t1 = maxT, inv, a, b, t;
    /* X */
    if (Math.abs(dx) < 1e-8) { if (Math.abs(ox - cx) > hx) return -1; }
    else { inv = 1 / dx; a = (cx - hx - ox) * inv; b = (cx + hx - ox) * inv;
      if (a > b) { t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1; }
    /* Y */
    if (Math.abs(dy) < 1e-8) { if (Math.abs(oy - cy2) > hy) return -1; }
    else { inv = 1 / dy; a = (cy2 - hy - oy) * inv; b = (cy2 + hy - oy) * inv;
      if (a > b) { t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1; }
    /* Z */
    if (Math.abs(dz) < 1e-8) { if (Math.abs(oz - cz) > hz) return -1; }
    else { inv = 1 / dz; a = (cz - hz - oz) * inv; b = (cz + hz - oz) * inv;
      if (a > b) { t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1; }
    return t0;
  }

  function apcRayTest(e, org, dir, maxT) {
    var c = Math.cos(e.face), s = Math.sin(e.face);
    var dx0 = org.x - e.x, dz0 = org.z - e.z;
    var ox = dx0 * c - dz0 * s, oy = org.y - e.y, oz = dx0 * s + dz0 * c;
    var vx = dir.x * c - dir.z * s, vy = dir.y, vz = dir.x * s + dir.z * c;

    var best = slab(ox, oy, oz, vx, vy, vz, 0, 4.00, 0, HW + .18, 3.85, 10.30, maxT);
    /* the station, in the hull frame but rotated by its own traverse */
    var rig = e.rig && e.rig.apcModule ? e.rig : null;
    var ty = rig ? rig.state.turretYaw : 0;
    var tc = Math.cos(ty), ts = Math.sin(ty);
    var qx = ox * tc - (oz - .60) * ts, qz = ox * ts + (oz - .60) * tc;
    var wx = vx * tc - vz * ts, wz = vx * ts + vz * tc;
    var t2 = slab(qx, oy - 8.23, qz, wx, vy, wz, 0, .82, .10, 2.05, 1.10, 2.35, maxT);
    if (t2 > 0 && (best < 0 || t2 < best)) best = t2;
    /* the barrel, so a round can clip the gun itself */
    var t3 = slab(qx, oy - 8.23, qz, wx, vy, wz, 0, .72, 3.0, .55, .55, 2.6, maxT);
    if (t3 > 0 && (best < 0 || t3 < best)) best = t3;
    return best;
  }

  /* ------------------------------------------------------- subsystems ---- */
  function subsysInit(e) {
    e.subsys = {
      mobility: 1, rcws: 1, engine: 1,
      tyre: [220, 220, 220, 220], blown: 0,
      engineHp: 260, rcwsHp: 190, opticHp: 90,
      fire: 0, smoke: 0
    };
    return e.subsys;
  }

  function subsysHit(e, dmg, zone) {
    var S = e.subsys || subsysInit(e);
    var rig = e.rig && e.rig.apcModule ? e.rig : null;
    if (zone === 'wheel' && e._apcWheel !== undefined && e._apcWheel >= 0) {
      var i = e._apcWheel;
      S.tyre[i] -= dmg;
      if (S.tyre[i] <= 0 && rig && !rig.wheels[i].blown) {
        rig.wheels[i].blown = true;
        S.blown++;
        if (G && G.sfx) G.sfx('impact_metal', e.x, e.z);
        if (G && G.sparkBurst && THREE) {
          var w = rig.wheels[i];
          var lx = w.side * HTR, lz = w.front ? AXF : AXR;
          var c = Math.cos(e.face), s = Math.sin(e.face);
          G.sparkBurst(new THREE.Vector3(e.x + lx * c + lz * s, e.y + TR, e.z - lx * s + lz * c), 9, 0x4a4a44);
        }
      }
      e._apcWheel = -1;
    } else if (zone === 'deck') {
      S.engineHp -= dmg;
      if (S.engineHp <= 0) { S.engine = 0; S.smoke = 1; }
      else S.smoke = Math.max(S.smoke, clamp(1 - S.engineHp / 260, 0, 1));
    } else if (zone === 'head') {
      S.opticHp -= dmg;
      if (S.opticHp <= 0) S.rcws = Math.min(S.rcws, .28);
    } else if (zone === 'mantlet') {
      S.rcwsHp -= dmg;
      if (S.rcwsHp <= 0) S.rcws = 0;
    }
    /* mobility: each dead tyre is worth about 14%, a dead engine most of it */
    S.mobility = clamp((1 - S.blown * .155) * (S.engine ? 1 : .22), .18, 1);
    /* a badly hurt vehicle smokes whatever hit it */
    var frac = clamp(e.hp / Math.max(1, e.cfg.hp), 0, 1);
    if (frac < .45) S.smoke = Math.max(S.smoke, (0.45 - frac) / .45);
  }

  /* Blind gun = no trigger. The brain's own gate is `a.react <= 0 && a.mag > 0`,
     so holding those open is how a dead station stops firing without this
     module having to reach into enemyFire. */
  function enforceSubsys(e) {
    var S = e.subsys;
    if (!S || !e.ai) return;
    if (S.rcws <= 0) { e.ai.react = 9; e.ai.mag = 0; }
    else if (S.rcws < .4) {
      /* a degraded station still shoots, just badly and late */
      e.ai.errY += (Math.random() - .5) * .016;
      e.ai.errP += (Math.random() - .5) * .012;
    }
  }

  /* ---------------------------------------------------------- the wreck -- */
  function killApc(e) {
    var rig = e.rig && e.rig.apcModule ? e.rig : null;
    var S = e.subsys || subsysInit(e);
    e.vx = 0; e.vz = 0;
    if (e.drv) { e.drv.v = 0; e.drv.mode = 'halt'; e.drv.route = null; }
    S.mobility = 0; S.rcws = 0; S.fire = 1; S.smoke = 1;
    if (!rig) return;
    var st = rig.state;
    st.dead = true; st.deathT = 0;
    /* every tyre goes, and the hull settles on its rims */
    for (var i = 0; i < 4; i++) { rig.wheels[i].blown = true; rig.wheels[i].flat = 1; }
    /* the station goes over the side. Local frame, because the hull is not
       going anywhere and reparenting mid-frame is how you lose a transform. */
    st.tossX = (Math.random() < .5 ? -1 : 1) * rr(6.5, 9.5);
    st.tossZ = rr(-13, -7);
    st.tossSpin = rr(-3.4, 3.4);
    st.tossTumble = rr(-2.6, 2.6);
    /* the blast itself. explode() already carries sfx, particles, the flash,
       the AI noise and nz-destruct's scars; a second, smaller one a beat
       later is the ammunition going up. */
    if (G && G.explode) {
      G.explode({ x: e.x, y: e.y + 5.2, z: e.z }, 34, 96, 'ARAÇ',
        { occluded: true, edgeDamage: 8, selfScale: .55 });
      st.cookOff = .55;
    }
    if (G && G.aiNoise) G.aiNoise(e.x, e.z, 300, 'shot');
  }

  function wreckTick(e, rig, dt, now, t) {
    var st = rig.state, i;
    st.deathT = (st.deathT || 0) + dt;
    var k = smooth(clamp(st.deathT / .85, 0, 1));

    /* the secondary, once */
    if (st.cookOff > 0) {
      st.cookOff -= dt;
      if (st.cookOff <= 0 && G && G.explode) {
        G.explode({ x: e.x + rr(-3, 3), y: e.y + 8.0, z: e.z + rr(-3, 3) }, 22, 46, 'ARAÇ',
          { occluded: true, edgeDamage: 4, selfScale: .40 });
        st.cookOff = -1;
      }
    }

    /* the hull settles onto its rims */
    for (i = 0; i < 4; i++) {
      var w = rig.wheels[i];
      w.flat = Math.min(1, w.flat + dt * .9);
      w.steer.rotation.y *= (1 - dt);
    }
    suspend(e, rig, dt);

    /* the station arcs off and lands. Ballistic while it is in the air, then
       it just lies there for the rest of the level. */
    var Y = rig.rcws.yaw;
    var tt = Math.min(st.deathT, 4);
    var vy0 = 21;
    var y = vy0 * tt - 34 * tt * tt * .5;
    var floorLocal = -8.23 + 1.15;
    if (y < floorLocal) { y = floorLocal; }
    Y.position.set(st.tossX * clamp(tt / .9, 0, 1), Math.max(floorLocal, y),
      .60 + st.tossZ * clamp(tt / .9, 0, 1));
    if (y > floorLocal) {
      Y.rotation.y += st.tossSpin * dt;
      Y.rotation.x += st.tossTumble * dt;
      Y.rotation.z += st.tossTumble * .6 * dt;
    } else {
      Y.rotation.x = towardAng(Y.rotation.x, PI * .48, 3 * dt);
      Y.rotation.z = towardAng(Y.rotation.z, .12, 2 * dt);
    }
    rig.rcws.pitch.rotation.x = towardAng(rig.rcws.pitch.rotation.x, -.34, 1.6 * dt);

    /* the paint burns off */
    var burn = clamp(st.deathT / 3.2, 0, 1);
    for (i = 0; i < rig.hullMeshes.length; i++) {
      var m = rig.hullMeshes[i].material;
      if (!m || !m.color || m.__apcBurned) continue;
      if (!m.__apcBase) m.__apcBase = m.color.clone();
      /* the shared materials must not be scorched for everybody, so anything
         that is still shared gets swapped for a per-wreck clone first */
      if (!m.__apcOwned) {
        var c2 = m.clone(); c2.__apcOwned = true; c2.__apcBase = m.color.clone();
        rig.hullMeshes[i].material = c2;
        continue;
      }
      m.color.copy(m.__apcBase).lerp(BURNT, burn);
      m.roughness = lerp(m.roughness, .97, dt * .5);
      if (burn >= 1) m.__apcBurned = true;
    }
    /* the fire, and then just the smoke */
    var S = e.subsys;
    st.smokeT -= dt;
    if (st.smokeT <= 0 && G && G.particle) {
      var burning = st.deathT < 22;
      st.smokeT = burning ? .045 : .16;
      var fx = e.x + rr(-4, 4), fz = e.z + rr(-6, 6);
      if (burning && st.deathT < 9) {
        var pf = G.particle('fire', fx, e.y + rr(3, 7), fz,
          rr(-1.6, 1.6), rr(3, 8), rr(-1.6, 1.6), rr(3, 7), rr(.35, .7), -6, true);
        void pf;
      }
      var ps = G.particle('smoke', fx, e.y + rr(5, 9), fz,
        rr(-1.2, 1.2), rr(3.4, 7.5), rr(-1.2, 1.2),
        rr(4, 9), rr(1.4, 2.6), -.55, false);
      if (ps && ps.mat) {
        var g0 = burning ? .10 : .22;
        ps.mat.color.setRGB(g0, g0 * .96, g0 * .94);
        ps.mat.opacity = burning ? .68 : .42;
      }
    }
    /* the beacons and the lamps are out */
    rig.mats.amber.emissiveIntensity = 0;
    rig.mats.lamp.emissiveIntensity = 0;
    rig.mats.hot.emissiveIntensity = Math.max(0, rig.mats.hot.emissiveIntensity - dt * .4);
    rig.light.beamMat.opacity = 0;
    rig.light.lensMat.emissiveIntensity = 0;
    if (rig.light.spot) rig.light.spot.intensity = 0;
    rig.flash.visible = false;
    if (rig.mLight) rig.mLight.intensity = Math.max(0, rig.mLight.intensity - dt * 20);
    /* the aerials go slack */
    for (i = 0; i < rig.aerials.length; i++) {
      rig.aerials[i].grp.rotation.x = damp(rig.aerials[i].grp.rotation.x, .55, .3, dt);
      rig.aerials[i].grp.rotation.z = damp(rig.aerials[i].grp.rotation.z, -.30, .3, dt);
    }
    void k; void now; void t; void S;
  }
  var BURNT = null;

  /* =====================================================================
     SECTION 11 -- the engine.

     nz-audio.js has no vehicle in it, and no looping-positional API to build
     one out of: every cue there is one-shot and its bus is recycled on a
     timeout, by design. What it does hand over is `AU`, and `AU.ctx` is the
     real AudioContext with `AU.master` on the end of it. So the engine is
     built here, once per vehicle, and driven from the frame loop.

     A 6.7-litre six firing 3 times per revolution is N/20 Hz: 40 Hz at an
     800 rpm idle, 132 Hz at the 2650 rpm power peak. Everything below hangs
     off that one number.

        sawtooth  f          the firing order, the thing you feel
        sawtooth  2f         the exhaust note
        square    f/2        the lumpy off-beat that makes it a diesel
        brown     lp 300..1k induction and tyre roar, opens with load
        bandpass  1.8 kHz    injector clatter, gated above idle
        sine      11f        turbo, comes in with load and lags coming off

     Everything is ramped, never set: one writer per AudioParam, `cancel` then
     `linearRamp`, which is the discipline nz-audio.js uses and the reason its
     mix never clicks.
     ================================================================== */
  var ENG = { brown: null, tried: false };

  function brownBuffer(ctx) {
    if (ENG.brown) return ENG.brown;
    var n = Math.floor(ctx.sampleRate * 2.0);
    var b = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = b.getChannelData(0), last = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.random() * 2 - 1;
      last = (last + .022 * w) / 1.022;
      d[i] = last * 3.2;
    }
    ENG.brown = b;
    return b;
  }

  function pRamp(p, v, t, dur) {
    if (!p) return;
    try {
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(v, t + (dur || .06));
    } catch (e) { try { p.value = v; } catch (e2) {} }
  }

  function engineStart(rig) {
    if (rig.eng || DEAD) return null;
    var AU = G && G.AU;
    if (!AU || !AU.ctx || !AU.master) return null;
    var ctx = AU.ctx;
    if (ctx.state !== 'running') return null;
    try {
      var t = ctx.currentTime;
      var sum = ctx.createGain(); sum.gain.value = 0;
      var out = ctx.createGain(); out.gain.value = 0;
      var pan = null;
      try {
        pan = ctx.createPanner();
        pan.panningModel = 'equalpower';
        pan.distanceModel = 'linear';
        pan.refDistance = 8; pan.maxDistance = 165; pan.rolloffFactor = 1;
      } catch (e) { pan = null; }
      sum.connect(out);
      if (pan) { out.connect(pan); pan.connect(AU.master); } else out.connect(AU.master);
      /* a whisper of the room, so it is in the same street as everything else */
      if (AU.reverb) { var send = ctx.createGain(); send.gain.value = .05; out.connect(send); send.connect(AU.reverb); }

      var mk = function (type, f, gain, lpF, q) {
        var o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
        var g = ctx.createGain(); g.gain.value = gain;
        var flt = ctx.createBiquadFilter();
        flt.type = 'lowpass'; flt.frequency.value = lpF; flt.Q.value = q || .7;
        o.connect(flt); flt.connect(g); g.connect(sum);
        try { o.start(t + Math.random() * .01); } catch (e) {}
        return { o: o, g: g, f: flt };
      };
      var fire = mk('sawtooth', 40, .085, 170, 1.5);
      var exh  = mk('sawtooth', 80, .042, 430, .9);
      var lump = mk('square', 20, .030, 120, .8);
      var turbo = ctx.createOscillator(); turbo.type = 'sine'; turbo.frequency.value = 440;
      var turboG = ctx.createGain(); turboG.gain.value = 0;
      var turboF = ctx.createBiquadFilter(); turboF.type = 'bandpass';
      turboF.frequency.value = 2600; turboF.Q.value = 5;
      turbo.connect(turboF); turboF.connect(turboG); turboG.connect(sum);
      try { turbo.start(t); } catch (e) {}

      var bed = ctx.createBufferSource();
      bed.buffer = brownBuffer(ctx); bed.loop = true;
      var bedF = ctx.createBiquadFilter(); bedF.type = 'lowpass';
      bedF.frequency.value = 300; bedF.Q.value = .8;
      var bedG = ctx.createGain(); bedG.gain.value = .05;
      bed.connect(bedF); bedF.connect(bedG); bedG.connect(sum);
      try { bed.start(t, Math.random() * 1.5); } catch (e) {}

      var clat = ctx.createBufferSource();
      clat.buffer = brownBuffer(ctx); clat.loop = true;
      var clatF = ctx.createBiquadFilter(); clatF.type = 'bandpass';
      clatF.frequency.value = 1850; clatF.Q.value = 6.5;
      var clatG = ctx.createGain(); clatG.gain.value = 0;
      clat.connect(clatF); clatF.connect(clatG); clatG.connect(sum);
      try { clat.start(t, Math.random() * 1.5); } catch (e) {}

      pRamp(sum.gain, 1, t, .8);
      rig.eng = { ctx: ctx, AU: AU, sum: sum, out: out, pan: pan,
        fire: fire, exh: exh, lump: lump, turbo: turbo, turboG: turboG,
        bed: bed, bedF: bedF, bedG: bedG, clat: clat, clatG: clatG,
        turboLag: 0, dead: false, nextT: 0 };
      return rig.eng;
    } catch (err) {
      warn('engine audio unavailable: ' + (err && err.message));
      rig.eng = null; ENG.tried = true;
      return null;
    }
  }

  function engineTick(e, rig, dt) {
    var E = rig.eng;
    if (!E) {
      if (!ENG.tried && !rig.state.dead) engineStart(rig);
      return;
    }
    if (E.dead) return;
    var AU = E.AU, ctx = E.ctx;
    if (!AU.ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    /* the mixer is only touched at 25 Hz; every AudioParam here is ramped
       over a longer window than that, so nothing steps */
    E.nextT -= dt;
    if (E.nextT > 0) return;
    E.nextT = .04;

    var P = G.player;
    var dist = P ? Math.hypot(P.x - e.x, P.z - e.z) : 999;
    var d = e.drv;
    var rpm = d ? clamp(d.rpm, .12, 1.15) : .14;
    var load = d ? clamp(d.load, 0, 1) : 0;
    var muted = AU.muted;
    var alive = !rig.state.dead;

    /* 800 rpm idle -> 40 Hz; 2650 rpm -> 132 Hz */
    var f = 38 + rpm * 88;
    var R = .12;
    pRamp(E.fire.o.frequency, f, t, R);
    pRamp(E.exh.o.frequency, f * 2, t, R);
    pRamp(E.lump.o.frequency, f * .5, t, R);
    pRamp(E.fire.f.frequency, 150 + rpm * 210, t, R);
    pRamp(E.exh.f.frequency, 380 + rpm * 640 + load * 260, t, R);
    pRamp(E.bedF.frequency, 280 + rpm * 520 + load * 420, t, R);
    pRamp(E.bedG.gain, (.035 + load * .075 + rpm * .04), t, R);
    /* the turbo lags coming on and sighs coming off, which is the whole
       character of a big diesel being asked for something */
    E.turboLag = damp(E.turboLag, load, .015, Math.max(dt, .04));
    pRamp(E.turbo.frequency, 1200 + rpm * 3400, t, R);
    pRamp(E.turboG.gain, E.turboLag * .020 * clamp(rpm - .25, 0, 1), t, R);
    pRamp(E.clatG.gain, clamp(rpm - .22, 0, 1) * .016, t, R);
    pRamp(E.fire.g.gain, .075 + load * .045, t, R);
    pRamp(E.exh.g.gain, .028 + load * .055, t, R);
    pRamp(E.lump.g.gain, .034 * (1.25 - rpm * .5), t, R);

    /* distance and mute. AU.muted short-circuits sfx() before our hook ever
       runs, so a loop we own has to watch it or the M key does nothing. */
    var far = clamp(1 - (dist - 22) / 150, 0, 1);
    var vol = muted || !alive ? 0 : (.30 + far * .70) * far * .92;
    pRamp(E.out.gain, vol, t, .10);
    if (E.pan) {
      var py = e.y + 3.4;
      try {
        if (E.pan.positionX) {
          pRamp(E.pan.positionX, e.x, t, .06);
          pRamp(E.pan.positionY, py, t, .06);
          pRamp(E.pan.positionZ, e.z, t, .06);
        } else E.pan.setPosition(e.x, py, e.z);
      } catch (err) {}
    }
  }

  function engineStop(rig) {
    var E = rig && rig.eng;
    if (!E || E.dead) return;
    E.dead = true;
    try {
      var t = E.ctx.currentTime;
      pRamp(E.out.gain, 0, t, .55);
      /* a diesel dying is a run-down, not a switch */
      pRamp(E.fire.o.frequency, 14, t, .9);
      pRamp(E.exh.o.frequency, 26, t, .9);
      pRamp(E.lump.o.frequency, 7, t, .9);
      setTimeout(function () {
        try {
          E.fire.o.stop(); E.exh.o.stop(); E.lump.o.stop();
          E.turbo.stop(); E.bed.stop(); E.clat.stop();
          E.out.disconnect(); E.sum.disconnect();
          if (E.pan) E.pan.disconnect();
        } catch (e) {}
      }, 1400);
    } catch (e) {}
  }

  /* The horn. `ECFG.apc.alert` fires this the moment the crew has you, and
     it is the best tell on the vehicle: two tones a minor third apart, a bit
     raspy, and audible from the far end of 233. Sokak. A vehicle crew leans
     on the horn; it does not shout. */
  function cueHorn(x, z, AU) {
    if (!AU || !AU.ctx) return undefined;
    var ctx = AU.ctx, t = ctx.currentTime;
    var P = G && G.player;
    var dist = (P && isFinite(x)) ? Math.hypot(P.x - x, P.z - z) : 40;
    var near = clamp(1 - dist / 190, 0, 1);
    var g = ctx.createGain();
    g.gain.value = .16 * near * near;
    var pan = null;
    try {
      pan = ctx.createPanner();
      pan.panningModel = 'equalpower'; pan.distanceModel = 'linear';
      pan.refDistance = 10; pan.maxDistance = 220; pan.rolloffFactor = 1;
      if (isFinite(x)) { if (pan.positionX) { pan.positionX.value = x; pan.positionY.value = 5; pan.positionZ.value = z; } else pan.setPosition(x, 5, z); }
    } catch (e) { pan = null; }
    g.connect(pan || AU.master);
    if (pan) pan.connect(AU.master);
    if (AU.reverb) { var sd = ctx.createGain(); sd.gain.value = .30; g.connect(sd); sd.connect(AU.reverb); }
    var flt = ctx.createBiquadFilter();
    flt.type = 'lowpass'; flt.frequency.value = 2400; flt.Q.value = .8;
    flt.connect(g);
    var env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + .028);
    env.gain.setValueAtTime(1, t + .40);
    env.gain.linearRampToValueAtTime(0, t + .52);
    env.connect(flt);
    /* 311 and 370 Hz -- an air horn is a minor third and it beats */
    var fs = [311, 370, 622, 740];
    var vs = [.50, .42, .16, .12];
    for (var i = 0; i < 4; i++) {
      var o = ctx.createOscillator();
      o.type = i < 2 ? 'sawtooth' : 'square';
      o.frequency.setValueAtTime(fs[i] * .965, t);
      o.frequency.linearRampToValueAtTime(fs[i], t + .07);
      var og = ctx.createGain(); og.gain.value = vs[i];
      o.connect(og); og.connect(env);
      try { o.start(t); o.stop(t + .56); } catch (e) {}
    }
    setTimeout(function () { try { g.disconnect(); if (pan) pan.disconnect(); } catch (e) {} }, 1100);
    return true;
  }

  /* the heavy machine gun. A 12.7 is not a chaingun: it is slower, it is
     lower, and every round has a slap on the front of it. Owned here so the
     name does not exist when this module does not. */
  function cueHmg(x, z, AU) {
    if (!AU || !AU.ctx) return undefined;
    var ctx = AU.ctx, t = ctx.currentTime;
    var P = G && G.player;
    var dist = (P && isFinite(x)) ? Math.hypot(P.x - x, P.z - z) : 40;
    var near = clamp(1 - dist / 130, 0, 1);
    var g = ctx.createGain();
    g.gain.value = (.24 + near * .52) * near;
    var pan = null;
    try {
      pan = ctx.createPanner();
      pan.panningModel = 'equalpower'; pan.distanceModel = 'linear';
      pan.refDistance = 6; pan.maxDistance = 210; pan.rolloffFactor = 1;
      if (isFinite(x)) { if (pan.positionX) { pan.positionX.value = x; pan.positionY.value = 4; pan.positionZ.value = z; } else pan.setPosition(x, 4, z); }
    } catch (e) { pan = null; }
    g.connect(pan || AU.master);
    if (pan) pan.connect(AU.master);
    if (AU.reverb) { var s = ctx.createGain(); s.gain.value = .22; g.connect(s); s.connect(AU.reverb); }

    /* the slap: a short noise burst through a falling bandpass */
    var nb = ctx.createBufferSource(); nb.buffer = AU.noiseBuf || brownBuffer(ctx);
    var nf = ctx.createBiquadFilter(); nf.type = 'bandpass';
    nf.frequency.setValueAtTime(2600, t); nf.frequency.exponentialRampToValueAtTime(420, t + .10);
    nf.Q.value = .8;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(.9, t + .0016);
    ng.gain.exponentialRampToValueAtTime(.0008, t + .17);
    nb.connect(nf); nf.connect(ng); ng.connect(g);
    /* the body: a fast downward sweep, the bit that carries across a street */
    var o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(198, t); o.frequency.exponentialRampToValueAtTime(46, t + .13);
    var og = ctx.createGain();
    og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(.55, t + .003);
    og.gain.exponentialRampToValueAtTime(.0008, t + .19);
    o.connect(og); og.connect(g);
    /* the mechanism: bolt and belt, only worth hearing up close */
    if (near > .45) {
      var mb = ctx.createBufferSource(); mb.buffer = AU.noiseBuf || brownBuffer(ctx);
      var mf = ctx.createBiquadFilter(); mf.type = 'bandpass'; mf.frequency.value = 3400; mf.Q.value = 7;
      var mg = ctx.createGain();
      mg.gain.setValueAtTime(0, t + .026); mg.gain.linearRampToValueAtTime(.10 * near, t + .030);
      mg.gain.exponentialRampToValueAtTime(.0006, t + .085);
      mb.connect(mf); mf.connect(mg); mg.connect(g);
      try { mb.start(t + .026, Math.random()); mb.stop(t + .10); } catch (e) {}
    }
    try { nb.start(t, Math.random()); nb.stop(t + .20); o.start(t); o.stop(t + .22); } catch (e) {}
    setTimeout(function () { try { g.disconnect(); if (pan) pan.disconnect(); } catch (e) {} }, 700);
    return true;
  }

  /* =====================================================================
     SECTION 12 -- hooks.

     Every body is wrapped. NZ.call/NZ.first permanently disable a listener
     that throws, so an unguarded exception here is not a bad frame, it is a
     vehicle that stops existing for the rest of the level.
     ================================================================== */

  function failRig(e, rig, why) {
    if (rig && rig.state && !rig.state.failed) {
      rig.state.failed = true;
      warn('rig fell back: ' + (why && why.message ? why.message : why));
    }
    if (rig && rig.root) rig.root.visible = false;
    if (e && e.mesh) e.mesh.visible = true;
    return true;
  }

  function onCreateRig(e) {
    if (!e || e.kind !== 'apc') return undefined;
    try {
      var rig = buildApc(e);
      if (!rig) return undefined;
      if (!e.drv) driveInit(e);
      if (!e.subsys) subsysInit(e);
      /* NO PER-VEHICLE MUZZLE LIGHT. Adding a light to the scene changes the
         light count every material in it was compiled against, so three.js
         rebuilds all of them -- the whole street, mid-level. And it buys
         nothing: enemyFire already calls the game's own flashLight() with
         wep.flash for every actor that pulls a trigger, this one included.
         The additive cards on the brake are the rest of it. */
      rig.mLight = null;
      /* the contact shadow the engine made is a square for a man. Make it the
         footprint of a vehicle instead: 19.6 by 8.75, and turned with it. */
      if (e.shadow) {
        var side = e.cfg.rad * 2.55 || 12.75;
        e.shadow.scale.set(V.WID * 1.14 / side, V.LEN * 1.05 / side, 1);
        if (e.shadow.material) e.shadow.material.opacity = .40;
      }
      if (e.glow) e.glow.visible = false;
      if (e.tell) e.tell.visible = false;
      return rig;
    } catch (err) {
      console.error('[nz-apc] rig creation failed; the vehicle will not spawn:', err);
      return undefined;
    }
  }

  function onAnimate(e, speed, now) {
    if (!e || e.kind !== 'apc') return undefined;
    var rig = e.rig;
    if (!rig || !rig.apcModule) return undefined;
    if (rig.state.failed) return failRig(e, rig, 'disabled earlier');
    try {
      var st = rig.state;
      var dt = st.lastNow ? clamp(now - st.lastNow, .0005, .08) : 1 / 60;
      st.lastNow = now;

      rig.root.position.set(fin(e.x, 0), fin(e.y, 0), fin(e.z, 0));
      rig.root.rotation.set(0, fin(e.face, 0), 0);
      rig.root.visible = true;

      suspend(e, rig, dt);
      aimTurret(e, rig, dt);
      aimLight(e, rig, dt, now);
      fxTick(e, rig, dt, now);
      enforceSubsys(e);

      /* the billboard, the eye glint and the pre-fire tell are all for men */
      if (e.mesh) e.mesh.visible = false;
      if (e.glow) e.glow.visible = false;
      if (e.tell) { e.tell.visible = false; e.tell.scale.set(.001, .001, 1); }
      if (e.shadow) e.shadow.rotation.set(-PI / 2, 0, fin(e.face, 0) + PI);

      /* the muzzle, in world, for enemyFire's first-choice origin */
      rig.muzzle.updateWorldMatrix(true, false);
      rig.muzzleWorld.setFromMatrixPosition(rig.muzzle.matrixWorld);
      rig.muzzleReady = true;
      void speed;
      return true;
    } catch (err) {
      return failRig(e, rig, err);
    }
  }

  function onAnimateDeath(e, t, fall) {
    if (!e || e.kind !== 'apc') return undefined;
    var rig = e.rig;
    if (!rig || !rig.apcModule) return undefined;
    if (rig.state.failed) return true;
    try {
      var st = rig.state;
      /* presentEnemyDeath advances e.deathT with the frame's real dt, so the
         wreck is timed off that rather than off performance.now(): the same
         animation then runs correctly whether it is being drawn at 60 Hz or
         stepped by a head-less harness that never lets the wall clock move. */
      var eT = fin(e.deathT, 0);
      var dt = (st.lastDeathT === undefined) ? 1 / 60 : clamp(eT - st.lastDeathT, .0005, .08);
      st.lastDeathT = eT;
      var now = eT;
      if (!st.dead) killApc(e);
      /* the hull does not slide: twelve tonnes stops where it stopped */
      e.vx = 0; e.vz = 0;
      rig.root.position.set(fin(e.x, 0), fin(e.y, 0), fin(e.z, 0));
      rig.root.rotation.set(0, fin(e.face, 0), 0);
      rig.root.visible = true;
      wreckTick(e, rig, dt, now, t);
      if (e.mesh) e.mesh.visible = false;
      if (e.glow) e.glow.visible = false;
      if (e.tell) e.tell.visible = false;
      if (e.shadow) e.shadow.rotation.set(-PI / 2, 0, fin(e.face, 0) + PI);
      void fall;
      return true;
    } catch (err) {
      return failRig(e, rig, err);
    }
  }

  /* --------------------------------------------------------- the seams --- */
  function onDrive(e, dt) {
    if (!e || e.kind !== 'apc' || DEAD) return undefined;
    try {
      if (e.dead) { e.vx = 0; e.vz = 0; return true; }
      if (!e.drv) driveInit(e);
      if (!e.subsys) subsysInit(e);
      enforceSubsys(e);
      driveTick(e, dt);
      return true;
    } catch (err) {
      panic(err);
      return undefined;
    }
  }

  function onRayTest(e, org, dir, maxT) {
    if (!e || e.kind !== 'apc') return undefined;
    try {
      var t = apcRayTest(e, org, dir, maxT);
      return t > 0 ? t : false;
    } catch (err) { return undefined; }
  }

  function onHitZone(e, hx, hy, hz) {
    if (!e || e.kind !== 'apc') return undefined;
    try {
      var z = apcZone(e, hx, hy, hz);
      e._apcZone = z.name;
      return z;
    } catch (err) { return undefined; }
  }

  function onDamaged(e, dmg, dir, hitPoint) {
    if (!e || e.kind !== 'apc' || e.dead) return;
    try {
      if (!e.subsys) subsysInit(e);
      var zone = e._apcZone;
      e._apcZone = null;
      if (!zone) {
        /* no zone means a blast, and a blast hurts everything a little */
        var S = e.subsys;
        S.engineHp -= dmg * .30; S.rcwsHp -= dmg * .22;
        for (var i = 0; i < 4; i++) S.tyre[i] -= dmg * .18;
        subsysHit(e, 0, 'blast');
        /* and it rocks the vehicle on its springs */
        if (e.rig && e.rig.apcModule) e.rig.state.jolt = clamp(dmg * .012, 0, 1.1);
      } else subsysHit(e, dmg, zone);
      /* a hit on the plate rings through the hull */
      if (e.rig && e.rig.apcModule && dmg > 0)
        e.rig.state.jolt = Math.max(e.rig.state.jolt, clamp(dmg * .004, 0, .55));
      void dir; void hitPoint;
    } catch (err) { warn('damage: ' + (err && err.message)); }
  }

  function onKilled(e) {
    if (!e || e.kind !== 'apc') return;
    try {
      killApc(e);
      var rig = e.rig && e.rig.apcModule ? e.rig : null;
      if (rig) engineStop(rig);
    } catch (err) { warn('kill: ' + (err && err.message)); }
  }

  /* the heavy gun's report, owned only while this module is loaded */
  function onSfx(name, x, z, AU) {
    if (DEAD) return undefined;
    var au = AU || (G && G.AU);
    try {
      if (name === 'apc_hmg') return cueHmg(x, z, au);
      if (name === 'apc_horn') return cueHorn(x, z, au);
    } catch (err) { return undefined; }
    return undefined;
  }

  /* per-frame housekeeping that has to happen whether or not the vehicle is
     being presented: audio, and the road bake on the first frame of a level */
  function onRender(dt) {
    if (DEAD || !INSTALLED) return undefined;
    try {
      if (!ROAD.ready && ROAD.level !== NZ.level) buildRoad(NZ.level);
      for (var i = 0; i < RIGS.length; i++) {
        var rig = RIGS[i], e = rig.owner;
        if (!e || e.rig !== rig) continue;
        engineTick(e, rig, clamp(dt || 0, .0005, .08));
        if (!e.dead) enforceSubsys(e);
      }
    } catch (err) { warn('tick: ' + (err && err.message)); }
    return undefined;                    /* never claim the frame */
  }

  /* =====================================================================
     install
     ================================================================== */
  NZ.apc = {
    available: true,
    stats: function () {
      var out = { spawned: STATS.spawned, road: STATS.routeNodes,
        dropped: STATS.routeDropped, ends: ROAD.ends.length,
        reversals: STATS.reversals, kturns: STATS.kturns, pinned: STATS.pinned,
        unwedged: STATS.unwedged,
        shots: STATS.shots, blocked: STATS.blocked, rigs: RIGS.length, vehicles: [] };
      for (var i = 0; i < RIGS.length; i++) {
        var e = RIGS[i].owner;
        if (!e) continue;
        out.vehicles.push({
          hp: e.hp, mode: e.drv && e.drv.mode, v: e.drv && +e.drv.v.toFixed(1),
          gear: e.drv && e.drv.gear, goal: e.drv && e.drv.goal,
          x: +e.x.toFixed(1), z: +e.z.toFixed(1), face: e.face && +e.face.toFixed(2),
          subsys: e.subsys && { mob: +e.subsys.mobility.toFixed(2),
            rcws: +e.subsys.rcws.toFixed(2), blown: e.subsys.blown }
        });
      }
      return out;
    },
    road: function () { return ROAD; },
    blockCells: function () { return BLOCK_CELLS; },
    /* the solved driving line for a fresh route between two named nodes */
    line: function (a, b) {
      var A = ROAD.byName[a], B = ROAD.byName[b];
      if (!A || !B) return null;
      var path = routeBetween(A.id, B.id);
      var L = pathToLine(path);
      if (!L) return null;
      return { n: L.pts.length, len: +L.length.toFixed(1),
        pts: L.pts.map(function (q) { return [+q.wx.toFixed(1), +q.wz.toFixed(1), q.tight ? 'T' : '']; }) };
    },
    /* the raw actors, for a head-less harness. `enemies` is a const in the
       inline script and never lands on window, so this is the only way in. */
    actors: function () {
      var out = [];
      for (var i = 0; i < RIGS.length; i++) if (RIGS[i].owner) out.push(RIGS[i].owner);
      return out;
    },
    /* why will the hull not stand where it is standing? */
    fitWhy: function (i) {
      var e = (RIGS[i || 0] || {}).owner;
      if (!e) return null;
      var out = { x: +e.x.toFixed(2), z: +e.z.toFixed(2), y: +e.y.toFixed(3),
        face: +e.face.toFixed(3), here: null, sweep: [] };
      FIT_WHY = [];
      var r = hullFits(e.x, e.z, e.face, 0, 0, e.y);
      out.here = (r === null) ? FIT_WHY.slice() : ('OK y=' + r.toFixed(2));
      var k;
      for (k = 0; k < 8; k++) {
        var ang = e.face + (k - 4) * .22;
        FIT_WHY = [];
        var rr2 = hullFits(e.x, e.z, ang, 0, 0, null);
        out.sweep.push([+(ang - e.face).toFixed(2), rr2 === null ? FIT_WHY[0] : 'OK']);
      }
      FIT_WHY = null;
      return out;
    },
    blockWhy: function (i) { var e = (RIGS[i || 0] || {}).owner; return e && e.drv ? e.drv.blockWhy : null; },
    why: function (i) {
      var e = (RIGS[i || 0] || {}).owner;
      if (!e || !e.drv) return null;
      var d = e.drv;
      return { mode: d.mode, gear: d.gear, v: +d.v.toFixed(2), steer: +d.steer.toFixed(3),
        want: +d.wantSpd.toFixed(2), pinT: +(d.pinT || 0).toFixed(2), stuck: +d.stuck.toFixed(2),
        goal: d.goal, node: d.node, x: +e.x.toFixed(1), z: +e.z.toFixed(1),
        y: +e.y.toFixed(2), face: +e.face.toFixed(2), dbg: d.dbg };
    },
    _V: V
  };

  NZ.on('ready', function (ctx) {
    if (INSTALLED || DEAD) return;
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    if (!THREE || !THREE.Group || !THREE.Mesh || !THREE.MeshStandardMaterial ||
        !THREE.BufferGeometry || !THREE.Float32BufferAttribute) {
      warn('three.js r149-compatible surface unavailable');
      return;
    }
    lazyTemps();
    BURNT = new THREE.Color(0x1d1a17);
    if (!bindGlobals()) { warn('game globals unavailable; module inert'); return; }

    buildRoad(NZ.level);

    /* Above the generic character module (0) and above nz-spider (120), so
       the `apc` kind is claimed before either sees it. Unknown kinds return
       undefined, so nothing else is affected by the ordering. */
    NZ.on('createEnemyRig', onCreateRig, 130);
    NZ.on('animateEnemyRig', onAnimate, 130);
    NZ.on('animateEnemyRigDeath', onAnimateDeath, 130);
    NZ.on('enemyDrive', onDrive, 130);
    NZ.on('enemyRayTest', onRayTest, 130);
    NZ.on('enemyHitZone', onHitZone, 130);
    NZ.on('enemyDamaged', onDamaged, 130);
    NZ.on('enemyKilled', onKilled, 130);
    NZ.on('sfx', onSfx, 40);
    /* 36: after nz-destruct's debris (40), before nz-finale (35) and well
       above nz-render's frame claim at 0. Returns undefined, so the chain
       carries on down to it. */
    NZ.on('render', onRender, 36);

    if (NZ.flags) NZ.flags.apc = true;
    INSTALLED = true;
    if (NZ.log) NZ.log('armoured patrol vehicle installed; road ' +
      STATS.routeNodes + ' nodes / ' + ROAD.ends.length + ' ends');
  });

})(typeof window !== 'undefined' ? window : this);
