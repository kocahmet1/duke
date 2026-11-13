/* ===========================================================================
   NZ-SHOTS  --  visual verification harness for NUKE ZONE 3D.

   The problem: screenshots have to be taken by a human-operated screenshot
   tool pointed at Chrome, and the only way to open a page is to paste a file
   path into File Explorer. That means NO query strings the operator can type
   and NO clicks on the resulting page. Every shot page therefore has to boot
   itself into a reproducible, camera-posed, motionless frame with zero user
   interaction.

   This module is inert unless it is explicitly armed. It arms when either
     window.NZ_SHOT = { ... }     is set BEFORE the game scripts run, or
     the URL carries ?shot=<scene>
   so adding <script src="nz-shots.js"> to NUKEM.html changes nothing for a
   normal play session.

   ---------------------------------------------------------------- modes ---
   grid    cycle N camera presets, render each one into an offscreen canvas,
           composite them into one labelled contact sheet drawn over the page.
           ONE screenshot then captures many angles. This is the whole point.
   single  pose one preset full-screen and hold it.
   live    boot the real game and let demo.js drive it (in-context frames).
   studio  standalone look-dev scene, no game: spheres + chamfered cubes under
           a neutral IBL with a chrome/grey reference ball and a colour chart.

   ------------------------------------------------------------ how it runs --
   The camera is driven from a priority-1000 'render' hook, which fires after
   the game has finished its simulation for the frame and immediately before
   anything is drawn, so whatever this module writes to the camera wins.

   In grid mode the hook renders the frame itself by re-entering NZ.first(
   'render') behind a guard -- the second pass skips this listener and lands
   on nz-render's post stack. Control comes back here with the drawing buffer
   still valid (we are inside the same task, before compositing), so the
   visible canvas can be copied into the sheet without preserveDrawingBuffer.

   Determinism: Math.random is reseeded before the game boots, the game clock
   is frozen for the settle window, TAA is given a fixed number of static
   frames to converge, and document.title becomes 'SHOT READY' when the sheet
   is finished so a critic can confirm the frame has settled.

   Owns:  nz-shots.js, _shot_*.html.   Edits nothing else.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ) { console.warn('[nz-shots] nz-core.js missing, harness inert'); return; }

  var doc = global.document;

  /* ====================================================================== */
  /*  config                                                                */
  /* ====================================================================== */

  function query() {
    var out = {};
    try {
      var s = (global.location && global.location.search) || '';
      s.replace(/^\?/, '').split('&').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf('=');
        var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
        var v = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        out[k] = v;
      });
    } catch (e) { /* file:// with no search is fine */ }
    return out;
  }

  var Q = query();
  var PAGE = (global.NZ_SHOT && typeof global.NZ_SHOT === 'object') ? global.NZ_SHOT : null;

  function pick(key, dflt) {
    if (PAGE && PAGE[key] !== undefined) return PAGE[key];
    if (Q[key] !== undefined) return Q[key];
    return dflt;
  }
  function num(key, dflt) { var v = parseFloat(pick(key, dflt)); return isFinite(v) ? v : dflt; }
  function flag(key, dflt) {
    var v = pick(key, undefined);
    if (v === undefined) return dflt;
    return !(v === false || v === 0 || v === '0' || v === 'false' || v === '');
  }

  var SCENE = String(pick('scene', pick('shot', '')) || '').toLowerCase();
  var ARMED = !!(PAGE || Q.shot);
  if (!ARMED || !SCENE) { NZ.log('shots harness inert'); return; }

  var CFG = {
    scene: SCENE,
    mode: String(pick('mode', SCENE === 'materials' ? 'studio' : SCENE === 'game' ? 'live' : 'grid')).toLowerCase(),
    width: Math.max(320, Math.round(num('width', num('w', 1600)))),
    height: Math.max(180, Math.round(num('height', num('h', 900)))),
    cols: Math.round(num('cols', 0)),
    rows: Math.round(num('rows', 0)),
    ss: Math.max(1, Math.min(3, num('ss', 2))),
    warm: Math.max(1, Math.round(num('warm', 10))),
    settle: Math.max(1, Math.round(num('settle', 16))),
    prewarm: Math.max(0, Math.round(num('prewarm', 45))),
    hud: flag('hud', SCENE === 'game'),
    seed: Math.round(num('seed', 20260802)),
    index: Math.round(num('i', 0)),
    fov: num('fov', 60),
    lights: flag('lights', SCENE === 'enemies'),
    debug: flag('shotdebug', false)
  };

  /* ====================================================================== */
  /*  determinism                                                           */
  /* ====================================================================== */
  /* Reseeding here -- at parse time, before window.onload fires boot() --
     makes every procedural texture, sprite sheet, crate scatter and entity
     placement identical from run to run, which is the whole basis of a
     before/after comparison. */
  (function seed() {
    try {
      var rnd = NZ.tex && NZ.tex.mulberry32 ? NZ.tex.mulberry32(CFG.seed >>> 0) : null;
      if (!rnd) return;
      global.Math.random = rnd;
      NZ.log('shots: Math.random seeded with ' + CFG.seed);
    } catch (e) { console.warn('[nz-shots] could not seed RNG', e); }
  })();

  /* ====================================================================== */
  /*  guarded access to the game's global-lexical bindings                  */
  /* ====================================================================== */
  /* NUKEM.html declares its state with top-level const/let, which live in the
     global lexical environment: reachable by name from another classic script
     but NOT as properties of window. Each read is wrapped so this file also
     loads cleanly on the standalone studio page where none of them exist. */

  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }

  var W = {};   /* world: a snapshot of the game bindings, built once */
  var worldSnapped = false, haveWorld = false;
  function world() {
    if (worldSnapped) return W;
    worldSnapped = true;
    W.player = tryGet(function () { return player; });
    W.state = tryGet(function () { return state; });
    W.enemies = tryGet(function () { return enemies; });
    W.pickups = tryGet(function () { return pickups; });
    W.parts = tryGet(function () { return parts; });
    W.WPN = tryGet(function () { return WPN; });
    W.ECFG = tryGet(function () { return ECFG; });
    W.ERIG = tryGet(function () { return ERIG; });
    W.LEVEL = tryGet(function () { return LEVEL; });
    W.CELL = tryGet(function () { return CELL; });
    W.EYE = tryGet(function () { return EYE; });
    W.MW = tryGet(function () { return MW; });
    W.MH = tryGet(function () { return MH; });
    W.keysDown = tryGet(function () { return keysDown; });
    W.floorAt = tryGet(function () { return floorAt; });
    W.cellAt = tryGet(function () { return cellAt; });
    W.spawnEnemy = tryGet(function () { return spawnEnemy; });
    W.hideScreens = tryGet(function () { return hideScreens; });
    W.resizeFn = tryGet(function () { return resize; });
    W.skyMesh = tryGet(function () { return skyMesh; });
    W.ov = tryGet(function () { return ov; });
    haveWorld = !!(W.player && W.state);
    return W;
  }

  /* writes have to be bare assignments; strict mode turns a missing binding
     into a ReferenceError, which is exactly the signal we want to swallow */
  function setFireQueued(v) { try { fireQueued = !!v; } catch (e) { } }
  function setMouseDown(v) { try { mouseDown = !!v; } catch (e) { } }
  function setAdsDown(v) { try { adsDown = !!v; } catch (e) { } }
  function setShowMap(v) { try { showMap = !!v; } catch (e) { } }
  function setLockMouseNoop() { try { global.lockMouse = function () { }; } catch (e) { } }

  /* ====================================================================== */
  /*  small helpers                                                         */
  /* ====================================================================== */
  var MONO = '"Consolas","DejaVu Sans Mono","Lucida Console","Courier New",monospace';
  var THREE = null;
  var renderer = null, scene = null, camera = null;

  function el(id) { return doc.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function padn(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  function fail(where, err) {
    console.error('[nz-shots] ' + where + ':', err);
    try { doc.title = 'SHOT ERROR'; } catch (e) { }
    try { banner('SHOT ERROR  ' + where + '  ' + (err && err.message ? err.message : err)); } catch (e) { }
  }

  var bannerEl = null;
  function banner(txt) {
    if (!doc || !doc.body) return;
    if (!bannerEl) {
      bannerEl = doc.createElement('div');
      bannerEl.id = 'nzShotBanner';
      bannerEl.style.cssText =
        'position:fixed;left:0;right:0;top:0;z-index:120;padding:6px 12px;' +
        'font:700 13px ' + MONO + ';letter-spacing:.12em;color:#ffd08a;' +
        'background:rgba(10,8,6,.86);border-bottom:1px solid #d8a018;pointer-events:none;' +
        'white-space:pre;overflow:hidden;text-overflow:ellipsis';
      doc.body.appendChild(bannerEl);
    }
    bannerEl.textContent = txt;
  }

  /* ====================================================================== */
  /*  camera presets                                                        */
  /* ====================================================================== */
  /* `at` is in level grid coordinates (world = g * CELL + CELL/2) and the
     eye height is resolved from floorAt() so a preset survives a level edit.
     yaw 0 looks toward -Z (up the street from the player spawn), +PI/2 looks
     toward -X, -PI/2 toward +X, PI toward +Z. */

  var PRESETS = {

    /* ---------------------------------------------------------------- env */
    env: [
      { name: 'street-establish', at: [28, 35.4], yaw: 0.00, pitch: -0.02,
        note: 'exterior / hero angle up the main street' },
      { name: 'street-crossing', at: [26.5, 29.0], yaw: -1.05, pitch: 0.04,
        note: 'exterior / brick facades + sky, wide bounce' },
      { name: 'alley-west', at: [17.5, 32.0], yaw: 1.5708, pitch: 0.0,
        note: 'covered alley, ceiling 9 -- strong perspective, tight AO' },
      { name: 'theatre-lobby', at: [7.0, 32.0], yaw: 1.5708, pitch: 0.02,
        note: 'interior / wood floor, stone walls, no sky' },
      { name: 'hotel-lobby', at: [30.0, 19.2], yaw: 0.0, pitch: 0.0,
        note: 'interior / carpet + hotel wall, mid ceiling' },
      { name: 'main-corridor', at: [22.0, 10.0], yaw: 1.5708, pitch: 0.0,
        note: 'long low interior, worst case for banding + AO' },
      { name: 'warehouse', at: [12.0, 5.0], yaw: 1.5708, pitch: 0.03,
        note: 'industrial / grate floor, metal walls, tall volume' },
      { name: 'rooftop', at: [53.0, 30.0], yaw: 1.5708, pitch: -0.05,
        note: 'high exterior, full sky + skyline silhouette' },
      { name: 'reactor-exit', at: [40.0, 4.0], yaw: -1.5708, pitch: 0.0,
        note: 'red-ambient interior, emissive-heavy' }
    ],

    /* Mission 4 geographic acceptance views.  These live here (as well as in
       render-level.mjs) so a normal browser can verify the junction without
       Puppeteer's free-camera bridge.  Coordinates are grid-space; yaw 0 is
       north/-Z. */
    cordon: [
      { name: 'park-spawn-baseline', pos: [278, 25.7, 186], yaw: -1.5708, pitch: 0.0,
        note: 'mission spawn baseline, east along 233 Sk toward the roundabout' },
      { name: 'roundabout-all-arms', pos: [592, 6.4, 178], yaw: 0.5404, pitch: -0.08,
        note: 'east side of the island, looking north-west across 233/232 Sk' },
      { name: '232-north-cemetery', pos: [532, 6.4, 150], yaw: 0.04, pitch: -0.02,
        note: 'down 232 Sk: realistic apartment sequence, clear roadway and cemetery trees at the far left' },
      { name: 'guven-pharmacy-corner', pos: [502, 6.4, 158], yaw: 0.92, pitch: -0.02,
        note: 'wide north-west corner shop frontage: raised, enterable GUVEN ECZANESI and the wrapped garden wall' },
      { name: 'guven-pharmacy-entry', pos: [492, 2.35, 138], yaw: 1.5708, pitch: -0.08,
        note: 'close side-street inspection of the open pharmacy doorway, four risers and handrails' },
      { name: '232-south-matching-width', pos: [532, 11.0, 214], yaw: 3.1416, pitch: -0.10,
        note: 'opposite arm from the island: same 18 m width, extended south along the open park edge' },
      { name: 'junction-oblique', pos: [600, 34, 210], yaw: 0.47, pitch: -0.31,
        note: 'raised oblique read of the island, both 232 Sk arms and solid corners' },
      { name: 'cemetery-edge-survey', pos: [494, 7, -12], yaw: 0.22, pitch: -0.02,
        note: 'inside the extension: low cemetery wall, dark fence, shelter and mature tree line running along the left' },
      { name: '232-south-mosque-side-sightline', pos: [532, 7.0, 400], yaw: 2.25, pitch: -0.03,
        note: 'past the apartment buffer, looking south-west to Adil Cami on the west side of the road' },
      { name: '232-splitter-comparison', pos: [600, 7.2, 206], yaw: 0.65, pitch: -0.04,
        note: 'reference-like approach: broad north carriageway and the small triangular tree island separate from the main island' },
      { name: '232-splitter-plan', pos: [590, 27, 193], yaw: 0.52, pitch: -0.38,
        note: 'raised QA view confirming the two island footprints and open route around the splitter' },
      { name: '232-splitter-overhead', pos: [520.5, 62, 150], yaw: 0.0, pitch: -1.56,
        note: 'near-overhead geometry audit of the new triangular splitter' },
      /* Parked Courier acceptance views.  These are query-only QA cameras for
         the procedural car at the north kerb; the normal game never arms the
         shots harness.  Long lenses keep the roof/header and DLO slopes honest
         instead of exaggerating them with a close gameplay FOV. */
      { name: 'courier-side', pos: [661.4, 3.57, 187.1], yaw: 0.0, pitch: 0.0, fov: 24,
        note: 'true side profile: 160 mm painted header, pane slopes and pillars' },
      { name: 'courier-dlo', pos: [661.4, 6.35, 178.5], yaw: 0.0, pitch: -0.075, fov: 26,
        note: 'close DLO: metallic cant rail, dark bonded seal and glazing' },
      { name: 'courier-roofline', pos: [661.4, 9.0, 182.0], yaw: 0.0, pitch: -0.205, fov: 28,
        note: 'elevated roofline: curved pressing, header continuity and rails' },
      { name: 'seydikent-yellow-materials', pos: [570, 6.4, 184], yaw: -0.94, pitch: 0.22, fov: 70,
        note: 'street-eye yellow siding, recessed balconies and photographic clouds' },
      { name: 'seydikent-red-materials', pos: [568, 6.4, 162], yaw: -2.12, pitch: 0.22, fov: 70,
        note: 'street-eye rose plaster, bay glazing and photographic clouds' }
    ],

    /* ------------------------------------------------------------ enemies */
    /* Every cell shares one staging camera in the open street. Distance is
       shown inside a single frame (close / mid / far in the same shot) so a
       whole creature reads at three LODs in one cell instead of three. */
    enemies: [
      { name: 'trooper LOD', kind: 'trooper', shotKind: 'lineup' },
      { name: 'trooper action', kind: 'trooper', shotKind: 'action' },
      { name: 'pig LOD', kind: 'pig', shotKind: 'lineup' },
      { name: 'pig action', kind: 'pig', shotKind: 'action' },
      { name: 'enforcer LOD', kind: 'enforcer', shotKind: 'lineup' },
      { name: 'enforcer action', kind: 'enforcer', shotKind: 'action' },
      { name: 'octa LOD', kind: 'octa', shotKind: 'lineup' },
      { name: 'octa action', kind: 'octa', shotKind: 'action' },
      { name: 'spider LOD', kind: 'spider', shotKind: 'lineup' },
      { name: 'spider action', kind: 'spider', shotKind: 'action' },
      { name: 'spider gait', kind: 'spider', shotKind: 'gait' },
      { name: 'scale reference', kind: null, shotKind: 'scale' }
    ],

    /* ------------------------------------------------------------ weapons */
    weapons: null,   /* built below: one row of states for every weapon */

    /* ---------------------------------------------------------- materials */
    materials: [
      { name: 'lineup wide', studioView: 'wide' },
      { name: 'sphere row', studioView: 'spheres' },
      { name: 'chamfered cubes', studioView: 'cubes' },
      { name: 'reference + chart', studioView: 'reference' }
    ]
  };

  (function buildWeaponPresets() {
    /* GRENADE's 'fire' cell catches the empty follow-through (the body hides
       for .44s after the throw) and its 'reload' cell shows idle -- there is
       nothing to reload and nz-weapons guards it. */
    var names = [
      'PISTOL', 'SHOTGUN', 'CHAINGUN', 'RPG', 'RIFLE', 'GRENADE',
      'AK-PATTERN', 'M4-PATTERN', 'BOLT DMR', 'NULLSTAR'
    ];
    var states = [
      { s: 'idle', label: 'idle' },
      { s: 'ads', label: 'ADS' },
      { s: 'reload', label: 'reload (mid)' },
      { s: 'fire', label: 'muzzle flash' }
    ];
    var out = [];
    for (var w = 0; w < names.length; w++) {
      for (var i = 0; i < states.length; i++) {
        out.push({
          name: names[w].toLowerCase() + ' ' + states[i].label,
          weapon: w, wstate: states[i].s
        });
      }
    }
    PRESETS.weapons = out;
  })();

  /* Staging camera used by the enemy and weapon sheets: middle of the open
     street, level floor, clear line of sight for ~40 units. */
  var STAGE = { gx: 28, gy: 36, yaw: 0 };

  function stageWorld() {
    var w = world();
    var cell = w.CELL || 4;
    var fy = 0;
    try { if (w.floorAt) fy = w.floorAt(Math.round(STAGE.gx), Math.round(STAGE.gy)); } catch (e) { }
    if (!isFinite(fy)) fy = 0;
    return {
      x: STAGE.gx * cell + cell * 0.5,
      z: STAGE.gy * cell + cell * 0.5,
      floor: fy,
      eye: fy + (w.EYE || 2.85)
    };
  }

  /* ====================================================================== */
  /*  contact sheet                                                         */
  /* ====================================================================== */

  var Sheet = {
    canvas: null, ctx: null, backdrop: null,
    cols: 1, rows: 1, cellW: 0, cellH: 0, pad: 0
  };

  function layoutFor(n) {
    if (CFG.cols > 0 && CFG.rows > 0) return [CFG.cols, CFG.rows];
    /* square-ish grids keep every cell at the sheet's own aspect ratio, which
       is what makes the framing inside a cell trustworthy */
    if (n <= 1) return [1, 1];
    if (n <= 4) return [2, 2];
    if (n <= 9) return [3, 3];
    if (n <= 16) return [4, 4];
    return [5, 5];
  }

  function buildSheet(n) {
    var lay = layoutFor(n);
    Sheet.cols = lay[0]; Sheet.rows = lay[1];
    Sheet.cellW = Math.floor(CFG.width / Sheet.cols);
    Sheet.cellH = Math.floor(CFG.height / Sheet.rows);

    var c = doc.createElement('canvas');
    c.id = 'nzShotSheet';
    c.width = CFG.width; c.height = CFG.height;
    /* NUKEM.html styles every <canvas> with position:absolute;inset:0, so the
       inset has to be explicitly unwound before the centring can take. */
    c.style.cssText = 'position:fixed;inset:auto;left:50%;top:50%;' +
      'transform:translate(-50%,-50%);z-index:100;background:#000;display:block';
    var bd = doc.createElement('div');
    bd.id = 'nzShotBackdrop';
    bd.style.cssText = 'position:fixed;inset:0;z-index:99;background:#000';
    doc.body.appendChild(bd);
    doc.body.appendChild(c);

    Sheet.canvas = c;
    Sheet.backdrop = bd;
    Sheet.ctx = c.getContext('2d', { alpha: false });
    Sheet.ctx.imageSmoothingEnabled = true;
    Sheet.ctx.imageSmoothingQuality = 'high';
    Sheet.ctx.fillStyle = '#07080a';
    Sheet.ctx.fillRect(0, 0, CFG.width, CFG.height);

    fitSheet();
    global.addEventListener('resize', fitSheet);
    drawSheetChrome(0, n);
  }

  function fitSheet() {
    if (!Sheet.canvas) return;
    var s = Math.min(global.innerWidth / CFG.width, global.innerHeight / CFG.height);
    Sheet.canvas.style.width = Math.floor(CFG.width * s) + 'px';
    Sheet.canvas.style.height = Math.floor(CFG.height * s) + 'px';
  }

  function cellRect(i) {
    var cx = (i % Sheet.cols) * Sheet.cellW;
    var cy = Math.floor(i / Sheet.cols) * Sheet.cellH;
    return { x: cx, y: cy, w: Sheet.cellW, h: Sheet.cellH };
  }

  /* progress / status strip painted into cells that have not been shot yet */
  function drawSheetChrome(done, total) {
    var g = Sheet.ctx;
    if (!g) return;
    for (var i = done; i < total; i++) {
      var r = cellRect(i);
      g.fillStyle = (i === done) ? '#16181c' : '#0b0c0e';
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = '#1d2026'; g.lineWidth = 1;
      g.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
      g.fillStyle = i === done ? '#d8a018' : '#33383f';
      g.font = '700 ' + Math.round(Sheet.cellH * 0.10) + 'px ' + MONO;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(i === done ? 'RENDERING' : padn(i + 1, 2), r.x + r.w / 2, r.y + r.h / 2);
    }
    g.textAlign = 'left';
  }

  function drawCaption(i, preset, extra) {
    var g = Sheet.ctx, r = cellRect(i);
    var bh = Math.max(20, Math.round(r.h * 0.085));
    g.save();
    g.fillStyle = 'rgba(6,7,9,.80)';
    g.fillRect(r.x, r.y + r.h - bh, r.w, bh);
    g.strokeStyle = 'rgba(216,160,24,.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(r.x, r.y + r.h - bh + .5); g.lineTo(r.x + r.w, r.y + r.h - bh + .5); g.stroke();
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    var fs = Math.round(bh * 0.46);
    g.font = '700 ' + fs + 'px ' + MONO;
    g.fillStyle = '#d8a018';
    g.fillText(padn(i + 1, 2), r.x + Math.round(bh * .35), r.y + r.h - bh * 0.5);
    g.fillStyle = '#e8ecf1';
    g.fillText(String(preset.name || '').toUpperCase(), r.x + Math.round(bh * 1.5), r.y + r.h - bh * 0.5);
    if (extra) {
      g.textAlign = 'right';
      g.fillStyle = '#8e969f';
      g.font = Math.round(bh * 0.40) + 'px ' + MONO;
      g.fillText(extra, r.x + r.w - Math.round(bh * .35), r.y + r.h - bh * 0.5);
    }
    /* cell border last so it sits on top of the image */
    g.strokeStyle = 'rgba(0,0,0,.9)'; g.lineWidth = 2;
    g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    g.restore();
    g.textAlign = 'left';
  }

  function drawFooter(text) {
    var g = Sheet.ctx;
    if (!g) return;
    var bh = Math.max(18, Math.round(CFG.height * 0.026));
    g.save();
    g.fillStyle = 'rgba(6,7,9,.92)';
    g.fillRect(0, CFG.height - bh, CFG.width, bh);
    g.fillStyle = '#7d858e';
    g.font = Math.round(bh * 0.60) + 'px ' + MONO;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(text, 10, CFG.height - bh * 0.5);
    g.restore();
  }

  /* ====================================================================== */
  /*  renderer sizing                                                       */
  /* ====================================================================== */

  var RW = 0, RH = 0;

  function lockView(w, h, aspect) {
    RW = Math.max(2, Math.round(w));
    RH = Math.max(2, Math.round(h));
    var g = world();
    try { if (g.resizeFn) global.removeEventListener('resize', g.resizeFn); } catch (e) { }
    renderer.setPixelRatio(1);
    renderer.setSize(RW, RH, false);
    camera.aspect = aspect || (RW / RH);
    camera.updateProjectionMatrix();
    try {
      if (g.ov) {
        g.ov.width = RW; g.ov.height = RH;
      }
    } catch (e) { }
    NZ.call('resize', RW, RH, 1);
  }

  /* full-screen letterboxed presentation for single / live pages */
  function fitCanvases() {
    var view = el('view'), o = el('overlay');
    var s = Math.min(global.innerWidth / RW, global.innerHeight / RH);
    [view, o].forEach(function (c) {
      if (!c) return;
      c.style.position = 'fixed';
      c.style.inset = 'auto';
      c.style.left = '50%'; c.style.top = '50%';
      c.style.width = Math.floor(RW * s) + 'px';
      c.style.height = Math.floor(RH * s) + 'px';
      c.style.transform = 'translate(-50%,-50%)';
    });
  }

  /* ====================================================================== */
  /*  scene setup helpers (game pages)                                      */
  /* ====================================================================== */

  var neutralRig = null;

  function makeNeutralRig(center) {
    if (!THREE || neutralRig) return neutralRig;
    var lights = (NZ.ctx && NZ.ctx.lights) || {};
    var base = (lights.sunKey && isFinite(lights.sunKey.intensity)) ? lights.sunKey.intensity : 0.62;
    var kInt = clamp(base * 1.9, 0.7, 3.4);

    var grp = new THREE.Group();
    grp.name = 'nz-shot-neutral-rig';

    var key = new THREE.DirectionalLight(0xfff6ea, kInt);
    key.position.set(center.x - 16, center.y + 24, center.z + 18);
    key.target.position.set(center.x, center.y + 2.5, center.z);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -22; key.shadow.camera.right = 22;
    key.shadow.camera.top = 22; key.shadow.camera.bottom = -22;
    key.shadow.camera.near = 2; key.shadow.camera.far = 110;
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
    key.shadow.camera.updateProjectionMatrix();

    var rim = new THREE.DirectionalLight(0xc4d6ff, kInt * 0.42);
    rim.position.set(center.x + 22, center.y + 13, center.z - 24);
    rim.target.position.set(center.x, center.y + 2.5, center.z);

    var fill = new THREE.HemisphereLight(0xb9c8dc, 0x2c2620, 0.34);
    fill.position.set(center.x, center.y + 30, center.z);

    grp.add(key, key.target, rim, rim.target, fill);
    scene.add(grp);
    neutralRig = grp;
    NZ.log('shots: neutral rig installed, key=' + kInt.toFixed(2));
    return grp;
  }

  /* Remove every entity the level placed so a staged shot is not photobombed
     by a wandering trooper. Meshes are detached, the array is emptied in
     place (it is a const binding, so the identity has to survive). */
  function clearEntities(clearPickups) {
    var g = world();
    var i, e;
    if (g.enemies) {
      for (i = 0; i < g.enemies.length; i++) {
        e = g.enemies[i];
        ['mesh', 'glow', 'shadow', 'tell'].forEach(function (k) {
          try { if (e[k] && e[k].parent) e[k].parent.remove(e[k]); } catch (err) { }
        });
        try { if (e.rig && e.rig.root && e.rig.root.parent) e.rig.root.parent.remove(e.rig.root); } catch (err) { }
      }
      g.enemies.length = 0;
    }
    if (clearPickups && g.pickups) {
      for (i = 0; i < g.pickups.length; i++) {
        var p = g.pickups[i];
        try { if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh); } catch (err) { }
        try { if (p.glow && p.glow.parent) p.glow.parent.remove(p.glow); } catch (err) { }
      }
      g.pickups.length = 0;
    }
    if (g.parts) g.parts.length = 0;
  }

  /* Zero every enemy's sight radius: an enemy that cannot see the player never
     leaves 'idle', which means it never walks, never turns and never shoots.
     That is the cheapest possible way to make an AI scene reproducible. */
  function blindAI() {
    var g = world();
    if (!g.ECFG) return;
    for (var k in g.ECFG) {
      if (!Object.prototype.hasOwnProperty.call(g.ECFG, k)) continue;
      g.ECFG[k].sight = 0;
      g.ECFG[k].range = 0;
    }
  }

  /* force the articulated rig on for everything, whatever the LOD budget says */
  function forceRigs() {
    var g = world();
    if (!g.ERIG) return;
    g.ERIG.near = Math.max(g.ERIG.near, 4000);
    g.ERIG.far = Math.max(g.ERIG.far, 4200);
    g.ERIG.max = Math.max(g.ERIG.max, 64);
  }

  function stageEnemy(kind, x, z, faceTo, opts) {
    var g = world();
    if (!g.spawnEnemy || !g.CELL) return null;
    opts = opts || {};
    var gx = clamp(Math.round((x - g.CELL * 0.5) / g.CELL), 1, (g.MW || 64) - 2);
    var gy = clamp(Math.round((z - g.CELL * 0.5) / g.CELL), 1, (g.MH || 48) - 2);
    var e = null;
    try { e = g.spawnEnemy(kind, gx, gy); } catch (err) { fail('spawnEnemy(' + kind + ')', err); return null; }
    if (!e) return null;
    e.x = x; e.z = z;
    try { if (g.floorAt) e.y = g.floorAt(gx, gy); } catch (err) { }
    e.face = Math.atan2(faceTo.x - x, faceTo.z - z) + (opts.faceOffset || 0);
    e.gait = opts.gait === undefined ? 0.22 : opts.gait;
    e.state = opts.state || 'idle';
    e.coolT = 99; e.strafeT = 99; e.foleyT = 1e6;
    e.hp = e.cfg.hp;
    e.__staged = opts.state || 'idle';
    if (opts.state === 'attack') {
      e.atkT = 0.30; e.atkTotal = 0.42; e.fired = true;   /* fired: pose only, no damage */
      e.muzzlePulse = 0.85; e.recoilT = 0.10;
    }
    return e;
  }

  /* ====================================================================== */
  /*  camera posing                                                         */
  /* ====================================================================== */

  var pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 60 };

  function presetPose(p) {
    var g = world();
    var cell = g.CELL || 4;
    var out = { x: 0, y: 2.85, z: 0, yaw: p.yaw || 0, pitch: p.pitch || 0, roll: 0, fov: p.fov || CFG.fov };
    if (p.pos) {
      out.x = p.pos[0]; out.y = p.pos[1]; out.z = p.pos[2];
      return out;
    }
    var at = p.at || [STAGE.gx, STAGE.gy];
    var gx = at[0], gy = at[1];
    /* nudge onto the nearest open cell so a level edit cannot bury a preset
       inside a wall without it being obvious */
    if (g.cellAt) {
      var ix = Math.round(gx), iy = Math.round(gy);
      if (g.cellAt(ix, iy) === 0) {
        var best = null, bd = 1e9;
        for (var oy = -3; oy <= 3; oy++) for (var ox = -3; ox <= 3; ox++) {
          if (g.cellAt(ix + ox, iy + oy) !== 1) continue;
          var d = ox * ox + oy * oy;
          if (d < bd) { bd = d; best = [ix + ox, iy + oy]; }
        }
        if (best) { gx = best[0]; gy = best[1]; p.__moved = true; }
      }
    }
    var fy = 0;
    try { if (g.floorAt) fy = g.floorAt(Math.round(gx), Math.round(gy)); } catch (e) { }
    if (!isFinite(fy)) fy = 0;
    out.x = gx * cell + cell * 0.5;
    out.z = gy * cell + cell * 0.5;
    out.y = fy + (g.EYE || 2.85) + (p.dy || 0);
    return out;
  }

  function applyPose() {
    if (!camera) return;
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
    if (Math.abs(camera.fov - pose.fov) > 1e-4) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
    /* the sky dome is parented to the player in updatePlayer(); with the sim
       frozen we have to carry it ourselves or a distant preset falls outside */
    var g = world();
    try { if (g.skyMesh) g.skyMesh.position.copy(camera.position); } catch (e) { }
    /* keep the game's own player record under the camera so anything that
       measures distance from the player (rig LOD, sprite lighting) agrees */
    if (g.player) {
      g.player.x = pose.x; g.player.z = pose.z;
      g.player.y = pose.y - (g.EYE || 2.85);
      g.player.yaw = pose.yaw; g.player.pitch = pose.pitch;
      g.player.bob = 0; g.player.roll = 0; g.player.stepSm = 0;
      g.player.kick = 0; g.player.kickV = 0;
      g.player.recoilPitch = 0; g.player.recoilYaw = 0;
      g.player.recoilPitchV = 0; g.player.recoilYawV = 0;
      g.player.swayX = 0; g.player.swayY = 0; g.player.swayVX = 0; g.player.swayVY = 0;
      g.player.vy = 0; g.player.onGround = true;
      g.player.hurtT = 0; g.player.invT = 0;
    }
  }

  function setPlaying(on) {
    var g = world();
    if (g.state) { g.state.playing = !!on; g.state.paused = !on; }
  }

  function clearKeys() {
    var g = world();
    if (g.keysDown) for (var k in g.keysDown) g.keysDown[k] = false;
    setMouseDown(false); setFireQueued(false); setAdsDown(false); setShowMap(false);
  }

  /* ====================================================================== */
  /*  per-scene cell setup                                                  */
  /* ====================================================================== */

  function setupCell(p) {
    var g = world();
    clearKeys();

    if (CFG.scene === 'env' || CFG.scene === 'cordon') {
      /* Vehicle acceptance shots need an unobstructed body profile.  This runs
         only when the explicitly armed shot preset is one of the Courier
         cameras; ordinary cordon geography shots and gameplay keep actors. */
      if (CFG.scene === 'cordon' && /^courier-/.test(String(p.name || '')))
        clearEntities(true);
      var q = presetPose(p);
      pose.x = q.x; pose.y = q.y; pose.z = q.z;
      pose.yaw = q.yaw; pose.pitch = q.pitch; pose.fov = q.fov;
      return;
    }

    if (CFG.scene === 'enemies') {
      var st = stageWorld();
      var spiderGallery = p.kind === 'spider' && g.LEVEL === 2;
      if (spiderGallery) {
        /* Level 2 is pocketed rather than street-open. Its upper north gallery
           is the one long, high-clearance lane with an unobstructed backdrop. */
        var galleryFloor = 0;
        try { if (g.floorAt) galleryFloor = g.floorAt(10, 6); } catch (err) { }
        st = {
          x: 10 * g.CELL + g.CELL * 0.5,
          z: 6 * g.CELL + g.CELL * 0.5,
          floor: galleryFloor,
          eye: galleryFloor + (g.EYE || 2.85)
        };
      }
      pose.x = st.x; pose.y = st.eye; pose.z = st.z;
      pose.yaw = spiderGallery ? -Math.PI / 2 : STAGE.yaw;
      pose.pitch = -0.03; pose.fov = CFG.fov;
      clearEntities(true);
      var look = { x: st.x, z: st.z };
      if (p.shotKind === 'lineup') {
        if (spiderGallery) {
          /* The Sentinel is twice a soldier's height and substantially wider;
             move the three LOD samples back so its planted feet stay in frame. */
          stageEnemy(p.kind, st.x + 14.0, st.z - 4.0, look, { faceOffset: 0.24, gait: 0.10 });
          stageEnemy(p.kind, st.x + 25.0, st.z + 2.5, look, { faceOffset: -0.28, gait: 0.55 });
          stageEnemy(p.kind, st.x + 36.0, st.z + 8.0, look, { faceOffset: 0.22, gait: 0.80 });
        } else if (p.kind === 'spider') {
          stageEnemy(p.kind, st.x, st.z - 14.0, look, { faceOffset: 0.24, gait: 0.10 });
          stageEnemy(p.kind, st.x + 4.0, st.z - 25.0, look, { faceOffset: -0.28, gait: 0.55 });
          stageEnemy(p.kind, st.x + 8.0, st.z - 34.0, look, { faceOffset: 0.22, gait: 0.80 });
        } else {
          stageEnemy(p.kind, st.x - 4.0, st.z - 9.0, look, { faceOffset: 0.55, gait: 0.10 });
          stageEnemy(p.kind, st.x + 2.5, st.z - 19.0, look, { faceOffset: -0.42, gait: 0.55 });
          stageEnemy(p.kind, st.x + 8.0, st.z - 36.0, look, { faceOffset: 0.30, gait: 0.80 });
        }
      } else if (p.shotKind === 'gait') {
        var walker;
        if (spiderGallery)
          walker = stageEnemy(p.kind, st.x + 17.0, st.z, look, { faceOffset: 0.12, gait: 0.68 });
        else
          walker = stageEnemy(p.kind, st.x, st.z - 15.0, look, { faceOffset: 0.12, gait: 0.68 });
        if (walker) {
          walker.__staged = 'gait';
          walker.speedSm = 0.82;
          walker.vx = spiderGallery ? -6.0 : 0;
          walker.vz = spiderGallery ? 0 : 6.0;
        }
      } else if (p.shotKind === 'action') {
        if (spiderGallery)
          stageEnemy(p.kind, st.x + 16.0, st.z, look, { faceOffset: 0.22, state: 'attack', gait: 0.35 });
        else
          stageEnemy(p.kind, st.x - 1.5, st.z - 11.0, look, { faceOffset: 0.22, state: 'attack', gait: 0.35 });
      } else if (p.shotKind === 'scale') {
        /* every kind side by side at one distance: the fastest way to spot a
           creature whose proportions do not agree with the others */
        var kinds = ['trooper', 'pig', 'enforcer', 'octa', 'spider'];
        for (var i = 0; i < kinds.length; i++)
          stageEnemy(kinds[i], st.x - 10.4 + i * 5.2, st.z - 17.0, look, { faceOffset: 0.28, gait: 0.15 + i * 0.2 });
      }
      if (neutralRig) {
        if (spiderGallery) {
          var baseStage = stageWorld();
          neutralRig.position.set(st.x - baseStage.x, st.floor - baseStage.floor, st.z - baseStage.z);
        } else neutralRig.position.set(0, 0, 0);
      }
      return;
    }

    if (CFG.scene === 'weapons') {
      var sw = stageWorld();
      pose.x = sw.x; pose.y = sw.eye; pose.z = sw.z;
      pose.yaw = STAGE.yaw; pose.pitch = -0.02; pose.fov = CFG.fov;
      if (g.player && g.WPN) {
        /* roster-generic: grant every slot and every ammo key the table
           declares, so a sheet cell cannot go dry when the rack grows
           (grenade at 5, then the fallen AK / M4 / DMR behind it) */
        g.player.has = [];
        g.player.ammo = {};
        for (var wi2 = 0; wi2 < g.WPN.length; wi2++) {
          g.player.has[wi2] = true;
          if (g.WPN[wi2] && g.WPN[wi2].ammo) g.player.ammo[g.WPN[wi2].ammo] = 150;
        }
        g.player.weapon = p.weapon | 0;
        g.player.pending = -1; g.player.swapT = 0; g.player.raiseT = 0;
        g.player.cool = 0; g.player.ads = 0;
        g.player.medpack = 50;
      }
      setAdsDown(p.wstate === 'ads');
      if (p.wstate === 'ads' && g.player) g.player.ads = 1;
      if (p.wstate === 'reload') {
        /* Hold for a fraction of the weapon's own reload duration rather than
           a fixed frame count: the four reloads run 0.9s to 2.6s, so a fixed
           count would land on the wind-up for one gun and past the end of
           another. Time-based, so it is frame-rate independent too. */
        var dur = 1.8;
        try {
          var vm = g.WPN && g.WPN[p.weapon] ? g.WPN[p.weapon].vm : null;
          var t = vm && NZ.weapons && NZ.weapons.tune ? NZ.weapons.tune[vm] : null;
          if (t && isFinite(t.reload) && t.reload > 0.1) dur = t.reload;
        } catch (e) { }
        p.holdT = dur * 0.45;
        try {
          if (NZ.weapons && typeof NZ.weapons.reload === 'function') NZ.weapons.reload();
          else NZ.log('shots: NZ.weapons.reload() unavailable, cell shows idle');
        } catch (e) { NZ.log('shots: reload() threw', e); }
      }
      return;
    }
  }

  /* Frame-by-frame nudging during the warm window, i.e. everything that has
     to be re-applied because the game simulation would otherwise undo it. */
  function holdCell(p, frame, total) {
    var g = world();
    if (CFG.scene === 'weapons') {
      if (p.wstate === 'ads') { setAdsDown(true); if (g.player) g.player.ads = 1; }
      if (p.wstate === 'fire') {
        /* fire on the second-to-last warm frame so the freeze lands one frame
           after the shot -- close enough to peak flash to read, late enough
           that the shell and smoke have spawned */
        if (frame === total - 2) { setFireQueued(true); if (g.player) g.player.cool = 0; }
        else setFireQueued(false);
      }
    }
    if (CFG.scene === 'enemies' && g.enemies) {
      for (var i = 0; i < g.enemies.length; i++) {
        var e = g.enemies[i];
        if (e.dead) continue;
        e.coolT = 99; e.strafeT = 99; e.foleyT = 1e6;
        if (e.__staged === 'attack') { e.atkT = 0.30; e.fired = true; e.muzzlePulse = 0.85; }
        if (e.__staged === 'gait') {
          /* Keep the initial phase deterministic, then let distance travelled
             advance it normally. Rewinding gait while the body translates
             freezes every foot anchor and produces a false stretched-IK pose. */
          e.speedSm = 0.82;
          e.vx = p.kind === 'spider' && g.LEVEL === 2 ? -6.0 : 0;
          e.vz = p.kind === 'spider' && g.LEVEL === 2 ? 0 : 6.0;
        }
      }
    }
  }

  /* ====================================================================== */
  /*  the runner                                                            */
  /* ====================================================================== */

  var RUN = {
    cells: [], i: 0, f: 0, warmT: 0, phase: 'idle', armed: false, done: false,
    busy: false, extraWarm: 0
  };

  function renderOnce(dt) {
    RUN.busy = true;
    var handled;
    try { handled = NZ.first('render', dt); }
    finally { RUN.busy = false; }
    if (handled !== true && renderer && scene && camera) renderer.render(scene, camera);
  }

  function captureCell(i, p) {
    var view = el('view');
    if (!view || !Sheet.ctx) return;
    var r = cellRect(i);
    var g = Sheet.ctx;
    try {
      g.drawImage(view, 0, 0, view.width, view.height, r.x, r.y, r.w, r.h);
      if (CFG.hud) {
        var o = el('overlay');
        if (o && o.width) g.drawImage(o, 0, 0, o.width, o.height, r.x, r.y, r.w, r.h);
      }
    } catch (e) { fail('captureCell', e); }
    if (i === 0) checkCellNotBlank(r);
    drawCaption(i, p, cellExtra(p));
  }

  /* The capture works because drawImage() runs inside the same task as the
     render, while the WebGL drawing buffer is still valid -- no
     preserveDrawingBuffer needed. If a browser ever breaks that assumption the
     whole sheet comes out black, which is a silent and very confusing failure,
     so the first cell is probed and the operator is told what to change. */
  var blankWarned = false;
  function checkCellNotBlank(r) {
    if (blankWarned) return;
    try {
      var px = Sheet.ctx.getImageData(r.x + 4, r.y + 4, Math.max(1, r.w - 8), Math.max(1, r.h - 8)).data;
      var step = 4 * 97;   /* prime stride: ~1 sample per 97 pixels */
      var peak = 0;
      for (var k = 0; k < px.length; k += step) {
        if (px[k] > peak) peak = px[k];
        if (px[k + 1] > peak) peak = px[k + 1];
        if (px[k + 2] > peak) peak = px[k + 2];
        if (peak > 6) return;
      }
      blankWarned = true;
      banner('WARNING: cell 1 came back black. The framebuffer readback failed. ' +
             'Fix: add preserveDrawingBuffer:true to the WebGLRenderer options in NUKEM.html.');
      console.warn('[nz-shots] blank capture: peak channel value ' + peak);
    } catch (e) { NZ.log('shots: blank probe failed (canvas tainted?)', e); }
  }

  function cellExtra(p) {
    if (CFG.scene === 'env') {
      var f = Math.round(pose.fov);
      return 'fov ' + f + (p.__moved ? '  [MOVED]' : '');
    }
    if (CFG.scene === 'enemies') return p.shotKind === 'lineup' ? '8 / 19 / 36 m' : '';
    if (CFG.scene === 'weapons') return '';
    return '';
  }

  function advance() {
    RUN.i++;
    RUN.f = 0;
    RUN.warmT = 0;
    if (RUN.i >= RUN.cells.length) {
      RUN.phase = 'done';
      RUN.done = true;
      finishSheet();
      return;
    }
    RUN.phase = 'warm';
    drawSheetChrome(RUN.i, RUN.cells.length);
    try { setupCell(RUN.cells[RUN.i]); } catch (e) { fail('setupCell', e); }
    doc.title = 'SHOT ' + (RUN.i + 1) + '/' + RUN.cells.length;
  }

  function finishSheet() {
    var tier = 'n/a';
    try { if (NZ.render && NZ.render.stats) tier = NZ.render.stats().quality; } catch (e) { }
    var modules = [];
    try {
      if (NZ.flags.render) modules.push('render');
      if (NZ.flags.enemies) modules.push('enemies');
      if (NZ.flags.weapons) modules.push('weapons');
      if (NZ.flags.audio) modules.push('audio');
    } catch (e) { }
    drawFooter(
      'NUKE ZONE 3D  /  ' + CFG.scene.toUpperCase() + ' CONTACT SHEET  /  ' +
      CFG.width + 'x' + CFG.height + '  cell ' + Sheet.cellW + 'x' + Sheet.cellH +
      '  render ' + RW + 'x' + RH + '  /  tier ' + tier +
      '  /  modules [' + (modules.join(' ') || 'stock') + ']' +
      '  /  seed ' + CFG.seed
    );
    doc.title = 'SHOT READY';
    if (bannerEl) bannerEl.remove();
    NZ.log('shots: sheet complete');
  }

  function step(dt) {
    var p = RUN.cells[RUN.i];
    if (!p) return true;

    if (RUN.phase === 'warm') {
      setPlaying(true);
      var need = (p.warm || CFG.warm) + RUN.extraWarm;
      try { holdCell(p, RUN.f, need); } catch (e) { fail('holdCell', e); }
      applyPose();
      renderOnce(dt);
      RUN.f++;
      RUN.warmT += dt;
      /* a cell may ask for a wall-clock hold (mid-animation poses) on top of
         the frame count that covers shader compiles and rig construction */
      if (RUN.f >= need && (!p.holdT || RUN.warmT >= p.holdT)) {
        RUN.extraWarm = 0;
        RUN.phase = 'settle';
        RUN.f = 0;
        setPlaying(false);       /* hard freeze: nothing in the world moves now */
        clearKeys();
      }
      return true;
    }

    if (RUN.phase === 'settle') {
      applyPose();
      renderOnce(dt);
      RUN.f++;
      if (RUN.f >= (p.settle || CFG.settle)) {
        captureCell(RUN.i, p);
        advance();
      }
      return true;
    }

    return true;   /* done: hold the last framebuffer, the sheet is on top */
  }

  /* ---------------------------------------------------------------- hook -- */
  NZ.on('render', function (dt) {
    if (RUN.busy || !RUN.armed) return undefined;
    try {
      if (CFG.mode === 'grid') return step(dt || 0.016) ? true : undefined;

      if (CFG.mode === 'single') {
        if (RUN.f < CFG.warm) { try { holdCell(RUN.cells[0], RUN.f, CFG.warm); } catch (e) { } }
        applyPose();
        if (RUN.f < (CFG.warm + CFG.settle)) {
          RUN.f++;
          if (RUN.f === CFG.warm) { setPlaying(false); clearKeys(); }
          if (RUN.f >= CFG.warm + CFG.settle) {
            doc.title = 'SHOT READY';
            if (bannerEl) bannerEl.remove();
          }
        }
        return undefined;
      }

      if (CFG.mode === 'live') {
        tickDirector(dt || 0.016);
        return undefined;
      }
    } catch (err) {
      RUN.armed = false;
      fail('render hook', err);
    }
    return undefined;
  }, 1000);

  /* ====================================================================== */
  /*  live (demo director) mode                                             */
  /* ====================================================================== */

  var director = null;
  function tickDirector(dt) {
    if (!director) return;
    try { director.tick(dt); } catch (e) { NZ.log('shots: director tick failed', e); }
  }

  function startLive() {
    var g = world();
    setLockMouseNoop();
    /* A screenshot run must not end on the YOU'RE DEAD screen, and a critic
       looking at gameplay frames is not judging the difficulty curve. */
    try {
      var hurt = global.hurtPlayer;
      if (typeof hurt === 'function') {
        global.hurtPlayer = function (d, x, z) { return hurt(d * 0.15, x, z); };
      }
    } catch (e) { }
    if (g.hideScreens) g.hideScreens();
    var ui = el('ui'), o = el('overlay');
    if (ui) ui.style.opacity = CFG.hud ? '1' : '0';
    if (o) o.style.opacity = '1';
    setPlaying(true);
    if (g.state) g.state.ended = false;

    if (global.NUKEDEMO && global.NUKEDEMO.D && typeof global.NUKEDEMO.tick === 'function') {
      var D = global.NUKEDEMO.D;
      try {
        D.route = global.NUKEDEMO.route();
        D.i = 0; D.t = 0; D.gt = 0; D.tgt = null; D.done = false; D.live = true;
        if (g.player) { D.px = g.player.x; D.pz = g.player.z; }
        director = { tick: global.NUKEDEMO.tick };
        NZ.log('shots: demo director armed, ' + D.route.length + ' beats');
      } catch (e) { fail('demo director', e); }
    } else {
      NZ.log('shots: demo.js not present, live mode is a static spawn view');
    }
    doc.title = 'SHOT LIVE';
    /* the banner would otherwise sit in every gameplay screenshot */
    banner('SHOT LIVE  /  demo route  /  ' + RW + 'x' + RH + '  /  seed ' + CFG.seed +
           '  /  this strip disappears in 6s');
    setTimeout(function () { if (bannerEl) { bannerEl.remove(); bannerEl = null; } }, 6000);
  }

  /* ====================================================================== */
  /*  studio (standalone material look-dev page)                            */
  /* ====================================================================== */

  var Studio = { scene: null, camera: null, views: {}, env: null };

  /* A rounded box with analytic normals. r149's UMD build has no
     RoundedBoxGeometry and no BufferGeometryUtils, so: subdivide a box, push
     every vertex out of the inner box onto a sphere of `radius`, and derive
     the normal from the same displacement. Exact, and it needs no welding, so
     the chamfer stays smooth across the six face patches. */
  function chamferedBox(size, radius, seg) {
    var g = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
    var pos = g.attributes.position, nrm = g.attributes.normal;
    var inner = size * 0.5 - radius;
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      var cx = clamp(x, -inner, inner), cy = clamp(y, -inner, inner), cz = clamp(z, -inner, inner);
      var dx = x - cx, dy = y - cy, dz = z - cz;
      var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l > 1e-6) {
        var s = radius / l;
        pos.setXYZ(i, cx + dx * s, cy + dy * s, cz + dz * s);
        nrm.setXYZ(i, dx / l, dy / l, dz / l);
      }
    }
    pos.needsUpdate = true; nrm.needsUpdate = true;
    g.computeBoundingSphere();
    return g;
  }

  /* The reference material set. These are baked with the same NZ.tex.bake()
     the game's own subsystems use, so what the critic judges here is the
     actual bakery output, not a hand-tuned mock-up. Any module may add to the
     list through NZ.shots.registerMaterial(). */
  var MATLIB = [];
  function defineMaterials() {
    function bake(spec) { return NZ.tex.bake(spec); }
    function std(name, params, set, repeat) {
      if (set) NZ.tex.applySet(params, set, repeat);
      var m = new THREE.MeshStandardMaterial(params);
      m.name = 'shot:' + name;
      if (params.aoMap) m.aoMapIntensity = 1;
      return { name: name, mat: m };
    }

    var out = [];

    out.push(std('concrete', { roughness: .92, metalness: 0 },
      bake({ res: 256, seed: 11, base: '#6a6862', grain: .20, normalScale: 2.4,
             rough: { base: .90, variance: .16 }, ao: { strength: .7 },
             wear: { amount: .22, cells: 7, colour: '#8a8880' } }), [2, 2]));

    out.push(std('brick', { roughness: .88, metalness: 0 },
      bake({ res: 256, seed: 23, base: '#7a4034', grain: .22, normalScale: 3.2,
             rough: { base: .84, variance: .22 }, ao: { strength: .85 },
             wear: { amount: .30, cells: 9, colour: '#9c7a64' } }), [2, 2]));

    out.push(std('painted-steel', { roughness: .45, metalness: .15 },
      bake({ res: 256, seed: 31, base: '#39434d', grain: .10, normalScale: 1.5,
             rough: { base: .42, variance: .26 }, metal: { base: .12, variance: .28 },
             ao: { strength: .5 }, wear: { amount: .48, cells: 12, colour: '#9aa1ab' } })));

    out.push(std('bare-steel', { roughness: .30, metalness: 1 },
      bake({ res: 256, seed: 43, base: '#8e949c', grain: .12, normalScale: 1.2,
             rough: { base: .30, variance: .30 }, metal: { base: .96, variance: .06 },
             ao: { strength: .35 }, wear: { amount: .40, cells: 14, colour: '#cfd5dd' } })));

    out.push(std('gun-metal', { roughness: .28, metalness: 1 },
      bake({ res: 256, seed: 57, base: '#2b2e33', grain: .08, normalScale: 1.0,
             rough: { base: .26, variance: .22 }, metal: { base: .94, variance: .08 },
             ao: { strength: .40 }, wear: { amount: .34, cells: 16, colour: '#b7bcc4' } })));

    out.push(std('rubber', { roughness: .78, metalness: 0 },
      bake({ res: 256, seed: 67, base: '#1c1d20', grain: .07, normalScale: 2.0,
             rough: { base: .78, variance: .10 }, ao: { strength: .5 } })));

    out.push(std('plastic', { roughness: .35, metalness: 0 },
      bake({ res: 256, seed: 71, base: '#2f3f52', grain: .05, normalScale: .8,
             rough: { base: .33, variance: .12 }, ao: { strength: .3 } })));

    out.push(std('wood', { roughness: .62, metalness: 0 },
      bake({ res: 256, seed: 83, base: '#6b4a2c', grain: .24, normalScale: 2.6,
             rough: { base: .60, variance: .24 }, ao: { strength: .65 },
             wear: { amount: .26, cells: 6, colour: '#a48258' } }), [2, 2]));

    out.push(std('grimy-tile', { roughness: .48, metalness: 0 },
      bake({ res: 256, seed: 97, base: '#8d8a80', grain: .16, normalScale: 2.2,
             rough: { base: .46, variance: .32 }, ao: { strength: .8 },
             wear: { amount: .40, cells: 5, colour: '#4a463d' } }), [3, 3]));

    out.push(std('alien-chitin', { roughness: .40, metalness: .10 },
      bake({ res: 256, seed: 109, base: '#2d4232', grain: .18, normalScale: 3.0,
             height: function (res) { return NZ.tex.worley(res, { cells: 9, seed: 5, invert: true }); },
             rough: { base: .38, variance: .30 }, metal: { base: .08, variance: .18 },
             ao: { strength: .9 } })));

    out.push(std('flesh', { roughness: .55, metalness: 0 },
      bake({ res: 256, seed: 113, base: '#8a4a44', grain: .14, normalScale: 1.8,
             rough: { base: .52, variance: .20 }, ao: { strength: .6 } })));

    /* glass and a clean dielectric are the two things a browser renderer
       usually gets wrong, so they get a slot each */
    var glass = new THREE.MeshPhysicalMaterial({
      color: 0xbfd6de, roughness: .06, metalness: 0, transparent: true,
      opacity: .30, transmission: 0, clearcoat: 1, clearcoatRoughness: .04,
      side: THREE.DoubleSide
    });
    glass.name = 'shot:glass';
    out.push({ name: 'glass', mat: glass });

    var clear = new THREE.MeshPhysicalMaterial({
      color: 0x9a1e14, roughness: .34, metalness: 0, clearcoat: 1, clearcoatRoughness: .08
    });
    clear.name = 'shot:clearcoat-paint';
    out.push({ name: 'clearcoat-paint', mat: clear });

    return out;
  }

  function refMaterial(kind) {
    if (kind === 'chrome') return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.03, metalness: 1 });
    if (kind === 'grey50') return new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.55, metalness: 0 });
    if (kind === 'white') return new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85, metalness: 0 });
    if (kind === 'black') return new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.85, metalness: 0 });
    return new THREE.MeshStandardMaterial({ color: 0x888888 });
  }

  /* A small neutral studio probe: three soft emissive panels around a grey
     dome, PMREM'd. Neutral is the point -- judging albedo under the game's
     orange night sky is how a material set ends up secretly tinted. */
  function buildStudioEnv() {
    var s = new THREE.Scene();
    var dome = new THREE.Mesh(
      new THREE.SphereGeometry(60, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0x9aa3ad, side: THREE.BackSide })
    );
    s.add(dome);
    var floor = new THREE.Mesh(
      new THREE.CircleGeometry(58, 48),
      new THREE.MeshBasicMaterial({ color: 0x2a2c30, side: THREE.DoubleSide })
    );
    floor.rotation.x = -Math.PI / 2; floor.position.y = -12;
    s.add(floor);
    function panel(x, y, z, w, h, col, rx, ry) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, 0);
      s.add(m);
    }
    panel(-22, 20, 26, 34, 26, 0xffffff, 0, 0.7);
    panel(26, 14, 20, 26, 20, 0xdfe7f2, 0, -0.8);
    panel(0, 34, -18, 40, 24, 0xf6f2ea, -1.0, 0);
    var pm = new THREE.PMREMGenerator(renderer);
    pm.compileEquirectangularShader();
    var rt = pm.fromScene(s, 0.04, 0.1, 120);
    pm.dispose();
    return rt.texture;
  }

  function buildStudio() {
    Studio.scene = scene;
    var mats = defineMaterials().concat(MATLIB);

    var sphereGeo = new THREE.SphereGeometry(1, 64, 48);
    var cubeGeo = chamferedBox(1.75, 0.16, 12);
    var plinthGeo = chamferedBox(2.4, 0.05, 4);
    /* r149 samples aoMap through uv2; without this every AO map would read a
       single texel and quietly flatten the whole lineup */
    [sphereGeo, cubeGeo, plinthGeo].forEach(function (g) {
      if (g.attributes.uv && !g.attributes.uv2) g.setAttribute('uv2', g.attributes.uv);
    });

    var plinthMat = new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: .72, metalness: 0 });

    /* Ground at y=0, plinth slab 0.14 tall on top of it, and every primitive
       resting exactly on the plinth. A floating sphere is the single fastest
       way to make a look-dev sheet untrustworthy, so the contact is computed,
       not eyeballed: sphere radius 1 -> centre at PLINTH_TOP + 1. */
    var GROUND_Y = 0, PLINTH_H = 0.14, TOP = GROUND_Y + PLINTH_H;

    var ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({
      color: 0x33363b, roughness: .82, metalness: 0
    }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;
    scene.add(ground);

    var n = mats.length;
    var spacing = 3.1;
    var x0 = -(n - 1) * spacing * 0.5;

    for (var i = 0; i < n; i++) {
      var m = mats[i].mat;
      m.envMapIntensity = 1.0;
      var x = x0 + i * spacing;

      var sp = new THREE.Mesh(sphereGeo, m);
      sp.position.set(x, TOP + 1.0, 0);
      sp.castShadow = true; sp.receiveShadow = true;
      scene.add(sp);

      var cb = new THREE.Mesh(cubeGeo, m);
      cb.position.set(x, TOP + 0.875, -4.2);
      cb.rotation.set(0, 0.62, 0);
      cb.castShadow = true; cb.receiveShadow = true;
      scene.add(cb);

      var pl = new THREE.Mesh(plinthGeo, plinthMat);
      pl.position.set(x, GROUND_Y + PLINTH_H * 0.5, -2.1);
      pl.scale.set(1, PLINTH_H / 2.4, 3.2);
      pl.receiveShadow = true; pl.castShadow = true;
      scene.add(pl);
    }

    /* reference row: chrome, 50% grey, white, black, plus a colour chart */
    var refs = ['chrome', 'grey50', 'white', 'black'];
    for (var r = 0; r < refs.length; r++) {
      var rm = new THREE.Mesh(sphereGeo, refMaterial(refs[r]));
      rm.position.set(-5.4 + r * 3.6, GROUND_Y + 1.0, 6.4);
      rm.castShadow = true; rm.receiveShadow = true;
      scene.add(rm);
    }

    /* colour chart: a 6x4 board of known sRGB patches. Anything that shifts
       hue or crushes a patch to black is a tone-mapping or colour-space bug,
       and this is the only way to see that objectively in a screenshot. */
    var chartCols = [
      0x735244, 0xc29682, 0x627a9d, 0x576c43, 0x8580b1, 0x67bdaa,
      0xd67e2c, 0x505ba6, 0xc15a63, 0x5e3c6c, 0x9dbc40, 0xe0a32e,
      0x383d96, 0x469449, 0xaf363c, 0xe7c71f, 0xbb5695, 0x0885a1,
      0xf3f3f2, 0xc8c8c8, 0xa0a0a0, 0x7a7a7a, 0x555555, 0x343434
    ];
    var board = new THREE.Group();
    var pw = 0.9, gap = 0.06;
    for (var ci = 0; ci < chartCols.length; ci++) {
      var col = ci % 6, row = Math.floor(ci / 6);
      var patch = new THREE.Mesh(
        new THREE.PlaneGeometry(pw, pw),
        new THREE.MeshStandardMaterial({ color: chartCols[ci], roughness: .95, metalness: 0 })
      );
      patch.position.set((col - 2.5) * (pw + gap), (1.5 - row) * (pw + gap), 0);
      board.add(patch);
    }
    var backing = new THREE.Mesh(
      new THREE.PlaneGeometry(6 * (pw + gap) + .4, 4 * (pw + gap) + .4),
      new THREE.MeshStandardMaterial({ color: 0x101114, roughness: .9, metalness: 0 })
    );
    backing.position.z = -0.02;
    board.add(backing);
    /* bottom edge of the board just clears the floor so it does not float */
    board.position.set(7.9, GROUND_Y + (4 * (pw + gap) + .4) * 0.5 + 0.12, 6.4);
    board.rotation.y = -0.55;
    scene.add(board);

    /* --- named views the grid runner cycles through --------------------
       Framing is solved, not guessed: half-width = d * tan(fov/2) * 16/9,
       so each view is placed far enough back to hold everything it names. */
    var span = (n - 1) * spacing;
    Studio.views = {
      wide: { pos: [0, 4.4, span * 0.72 + 13], look: [0, TOP + 0.7, -1.8], fov: 34 },
      spheres: { pos: [-span * 0.20, TOP + 1.4, 9.5], look: [-span * 0.20, TOP + 1.0, 0], fov: 26 },
      cubes: { pos: [span * 0.20, TOP + 2.1, 5.2], look: [span * 0.20, TOP + 0.85, -4.2], fov: 26 },
      reference: { pos: [2.0, 2.7, 21.0], look: [2.0, 1.6, 6.4], fov: 40 }
    };
    NZ.log('shots: studio built with ' + n + ' materials');
  }

  function poseStudio(p) {
    var v = Studio.views[p.studioView] || Studio.views.wide;
    camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    camera.fov = v.fov;
    camera.updateProjectionMatrix();
    camera.rotation.order = 'YXZ';
    camera.lookAt(new THREE.Vector3(v.look[0], v.look[1], v.look[2]));
  }

  function studioStep(dt) {
    var p = RUN.cells[RUN.i];
    if (!p) return;
    /* nz-render's panic() nulls scene.environment on its way out; the studio
       is worthless without a probe, so put ours back if that happens */
    if (Studio.env && scene && !scene.environment) scene.environment = Studio.env;
    poseStudio(p);
    renderOnce(dt);
    RUN.f++;
    var need = (RUN.i === 0 ? CFG.prewarm : 0) + CFG.settle;
    if (RUN.f >= need) {
      captureCell(RUN.i, p);
      RUN.i++; RUN.f = 0;
      if (RUN.i >= RUN.cells.length) { RUN.done = true; finishSheet(); }
      else { drawSheetChrome(RUN.i, RUN.cells.length); doc.title = 'SHOT ' + (RUN.i + 1) + '/' + RUN.cells.length; }
    }
  }

  function bootStudio() {
    try {
      THREE = global.THREE;
      if (!THREE) throw new Error('three.js missing');

      var canvas = el('view');
      if (!canvas) {
        canvas = doc.createElement('canvas');
        canvas.id = 'view';
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block';
        doc.body.appendChild(canvas);
      }
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, antialias: true, alpha: false,
        powerPreference: 'high-performance', precision: 'highp'
      });
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x0a0b0d, 1);

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x14161a);

      camera = new THREE.PerspectiveCamera(34, CFG.width / CFG.height, 0.05, 600);
      camera.rotation.order = 'YXZ';

      /* the same light names/shape nz-render expects from the game, so the
         module installs and rebalances exactly as it does in NUKEM.html */
      var ambient = new THREE.AmbientLight(0xffffff, 0.35);
      var skyFill = new THREE.HemisphereLight(0xc9d6e6, 0x2b2b30, 0.30);
      var sunKey = new THREE.DirectionalLight(0xfff4e6, 1.35);
      var coolRim = new THREE.DirectionalLight(0xbfd2ff, 0.35);
      sunKey.position.set(-16, 26, 20);
      sunKey.target.position.set(0, 0.8, -1);
      sunKey.castShadow = true;
      sunKey.shadow.mapSize.set(2048, 2048);
      sunKey.shadow.camera.left = -34; sunKey.shadow.camera.right = 34;
      sunKey.shadow.camera.top = 20; sunKey.shadow.camera.bottom = -20;
      sunKey.shadow.camera.near = 2; sunKey.shadow.camera.far = 120;
      sunKey.shadow.bias = -0.0004; sunKey.shadow.normalBias = 0.02;
      sunKey.shadow.camera.updateProjectionMatrix();
      coolRim.position.set(22, 12, -24);
      coolRim.target.position.set(0, 0.8, -1);
      ambient.name = 'ambient-fill'; skyFill.name = 'sky-fill';
      sunKey.name = 'warm-key'; coolRim.name = 'cool-rim';
      scene.add(ambient, skyFill, sunKey, sunKey.target, coolRim, coolRim.target);

      NZ.ctx.THREE = THREE; NZ.ctx.renderer = renderer;
      NZ.ctx.scene = scene; NZ.ctx.camera = camera;
      NZ.ctx.lights = { ambient: ambient, skyFill: skyFill, sunKey: sunKey, coolRim: coolRim };
      NZ.call('rendererInit', NZ.ctx);

      buildStudio();

      NZ.call('ready', NZ.ctx);

      /* nz-render's 'ready' installs the game's night-sky probe. Replace it
         with the neutral studio probe and put the light rig back where a
         look-dev page needs it -- the post stack, tone map and exposure stay
         exactly as the game renders them. */
      try {
        Studio.env = buildStudioEnv();
        scene.environment = Studio.env;
      } catch (e) { NZ.log('shots: studio env failed, keeping module probe', e); }
      ambient.color.setHex(0xffffff); ambient.intensity = 0.16;
      skyFill.color.setHex(0xc9d6e6); skyFill.groundColor.setHex(0x2b2b30); skyFill.intensity = 0.22;
      sunKey.color.setHex(0xfff4e6); sunKey.intensity = 1.55;
      coolRim.color.setHex(0xbfd2ff); coolRim.intensity = 0.42;
      scene.traverse(function (o) {
        if (o.isMesh && o.material) {
          var list = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < list.length; i++) if (list[i]) { list[i].envMapIntensity = 1.0; list[i].needsUpdate = true; }
        }
      });

      RUN.cells = PRESETS.materials.slice();
      buildSheet(RUN.cells.length);
      lockView(Sheet.cellW * CFG.ss, Sheet.cellH * CFG.ss, Sheet.cellW / Sheet.cellH);
      doc.title = 'SHOT 1/' + RUN.cells.length;
      banner('LOOK-DEV STUDIO  /  warming shaders...');
      RUN.armed = true;

      var last = 0;
      var loop = function (t) {
        global.requestAnimationFrame(loop);
        var dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
        last = t;
        if (RUN.done) return;
        try { studioStep(dt); } catch (err) { RUN.done = true; fail('studio step', err); }
        if (RUN.done && bannerEl) bannerEl.remove();
      };
      global.requestAnimationFrame(loop);
    } catch (err) {
      fail('bootStudio', err);
    }
  }

  /* ====================================================================== */
  /*  boot (game pages)                                                     */
  /* ====================================================================== */

  function bootGame() {
    try {
      THREE = NZ.ctx.THREE || global.THREE;
      renderer = NZ.ctx.renderer;
      scene = NZ.ctx.scene;
      camera = NZ.ctx.camera;
      if (!renderer || !scene || !camera) throw new Error('NZ.ctx not populated');

      var g = world();
      setLockMouseNoop();
      if (g.hideScreens) g.hideScreens();
      clearKeys();

      var ui = el('ui'), o = el('overlay');
      if (ui) ui.style.opacity = CFG.hud ? '1' : '0';
      if (o) o.style.opacity = CFG.hud ? '1' : '0';

      if (CFG.mode === 'live') {
        lockView(CFG.width, CFG.height, CFG.width / CFG.height);
        fitCanvases();
        global.addEventListener('resize', fitCanvases);
        startLive();
        RUN.armed = true;
        return;
      }

      /* --- deterministic world state for every posed shot --- */
      blindAI();
      /* nz-weapons draws the viewmodel into the world's HDR buffer through the
         scenePass hook, so it lands in the captured pixels whether the HUD is
         on or not. An architecture or creature sheet with a shotgun barrel
         across the bottom third is worthless, so use the documented kill
         switch for those scenes. The stock 2D fallback then draws onto the
         overlay canvas, which these sheets do not capture. */
      if (CFG.scene === 'env' || CFG.scene === 'cordon' || CFG.scene === 'enemies') {
        try { NZ.flags.weapons = false; } catch (e) { }
      }
      if (g.player) {
        g.player.alive = true; g.player.hp = 100; g.player.armor = 0;
        g.player.has = [true, true, true, true, true];
        g.player.ammo = { clip: 180, shell: 48, chain: 220, rocket: 40, rifle: 150 };
        g.player.keys.red = true;
        g.player.ads = 0; g.player.sprint = 0; g.player.moveBlend = 0;
      }

      var list = PRESETS[CFG.scene];
      if (!list || !list.length) throw new Error('no presets for scene "' + CFG.scene + '"');

      if (CFG.scene === 'enemies' || CFG.scene === 'weapons') {
        clearEntities(true);
        var st = stageWorld();
        /* only the creature sheet needs every actor articulated; forcing it on
           the env sheet would build ~120 rigs for entities that are props */
        if (CFG.scene === 'enemies') forceRigs();
        if (CFG.lights) makeNeutralRig(new THREE.Vector3(st.x, st.floor, st.z - 18));
      }

      if (CFG.mode === 'single') {
        var p = list[clamp(CFG.index, 0, list.length - 1)];
        RUN.cells = [p];
        lockView(CFG.width, CFG.height, CFG.width / CFG.height);
        fitCanvases();
        global.addEventListener('resize', fitCanvases);
        setupCell(p);
        setPlaying(true);
        RUN.f = 0;
        doc.title = 'SHOT SINGLE';
        banner('SINGLE  /  ' + CFG.scene + '  /  ' + p.name + '  /  ' + CFG.width + 'x' + CFG.height);
        RUN.armed = true;
        return;
      }

      /* --- grid --- */
      RUN.cells = list.slice();
      buildSheet(RUN.cells.length);
      lockView(Sheet.cellW * CFG.ss, Sheet.cellH * CFG.ss, Sheet.cellW / Sheet.cellH);
      RUN.i = 0; RUN.f = 0; RUN.warmT = 0; RUN.phase = 'warm';
      RUN.extraWarm = CFG.prewarm;            /* first cell eats the shader compiles */
      setupCell(RUN.cells[0]);
      doc.title = 'SHOT 1/' + RUN.cells.length;
      banner('CONTACT SHEET  /  ' + CFG.scene.toUpperCase() + '  /  ' +
             RUN.cells.length + ' cells  /  ' + CFG.width + 'x' + CFG.height +
             '  /  cell render ' + (Sheet.cellW * CFG.ss) + 'x' + (Sheet.cellH * CFG.ss));
      RUN.armed = true;
    } catch (err) {
      fail('bootGame', err);
    }
  }

  /* The game fires 'ready' from finishBoot(), after every other module has
     installed. Priority -1000 puts this last in that queue. */
  if (CFG.mode === 'studio') {
    if (doc.readyState === 'complete') setTimeout(bootStudio, 0);
    else global.addEventListener('load', function () { setTimeout(bootStudio, 0); });
  } else {
    NZ.on('ready', function () { bootGame(); }, -1000);
    /* belt and braces: if 'ready' never arrives (a module threw during boot),
       say so rather than sitting on the title screen forever */
    setTimeout(function () {
      if (!RUN.armed) {
        try { doc.title = 'SHOT STALLED'; } catch (e) { }
        banner('SHOT STALLED  -  the game never reached its ready hook. ' +
               'Check the console (three.js CDN? module threw?).');
      }
    }, 25000);
  }

  /* ====================================================================== */
  /*  public surface                                                        */
  /* ====================================================================== */
  NZ.shots = {
    cfg: CFG,
    presets: PRESETS,
    run: RUN,
    sheet: Sheet,
    /* let another module put its real materials on the look-dev page */
    registerMaterial: function (name, mat) {
      if (mat && name) MATLIB.push({ name: String(name), mat: mat });
    },
    /* manual escape hatches for the orchestrator's console */
    pose: pose,
    applyPose: applyPose,
    next: function () { if (CFG.mode === 'grid') advance(); }
  };

  NZ.log('shots armed: scene=' + CFG.scene + ' mode=' + CFG.mode +
         ' sheet=' + CFG.width + 'x' + CFG.height + ' seed=' + CFG.seed);

})(typeof window !== 'undefined' ? window : this);
