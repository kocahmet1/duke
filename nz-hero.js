/* ===========================================================================
   NZ-HERO  --  the player, seen from outside.

   A third-person view for a game that was written first-person. Nothing here
   replaces the first-person path: this module ADDS a chase camera, a body to
   put in front of it, and the two small corrections a chase camera forces on a
   shooter. With the view set to FIRST PERSON every hook in this file returns
   before it touches anything, so the classic game is the classic game.

   WHAT IT OWNS

     1. THE VIEW     NZ.view.third is the option. V flips it in play, the title
                     screen and the pause screen each carry a control for it,
                     and it is remembered between sessions. NZ.view.blend is
                     the live 0..1 mix the camera is actually at -- the two
                     differ while the camera is flying between the eye and the
                     shoulder, and while a scoped weapon is pulling it back to
                     the eye so the glass still works.

     2. THE CAMERA   An over-the-shoulder boom: pivot at the eye, out to the
                     right, up a little, back along the aim. It keeps the
                     game's own aim angles exactly, so the crosshair means what
                     it always meant. Two swept legs (eye -> shoulder, shoulder
                     -> lens) against the same occupancy test bullets use keep
                     it out of walls, floors, ceilings, crates and shut doors;
                     a triangle index of the level's free-standing dressing
                     (signs, lamp posts, awnings -- things the grid has never
                     heard of) keeps it from parking behind those. Snaps in,
                     eases out. With no room for a boom at all -- his back on
                     a wall -- the view drops to first person until there is.

     3. THE AIM      The lens is not the eye, so a round fired dead ahead from
                     the eye lands beside the crosshair by exactly the boom
                     offset. Every shot is therefore re-aimed at whatever the
                     crosshair is covering (NUKEM.html asks through the
                     'aimDir' hook). Origin, damage, spread and range are the
                     game's and are not touched.

     4. THE BODY     One skinned figure, built at boot from nothing: lofted
                     torso / limbs / shoes / hands / head on a 21-bone
                     skeleton, a painted 1024 atlas, and a procedural animator
                     -- gait from distance really travelled, two-bone IK on all
                     four limbs, the weapon aimed at the crosshair's world
                     point with both hands solved onto its grips. Crouch,
                     crawl, jump, sprint carry, swap, reload, throw, flinch,
                     death.

     5. THE GUN      The figure holds the real weapon models: the first-person
                     assets nz-weapons already built, instanced into the world
                     with a scene material. No second set of geometry.

   THE LOOK IS DATA.  Everything about who the figure IS -- skin, hair, build,
   what he is wearing -- lives in one plain object, LOOK, and a page may supply
   its own before this file loads:

       window.NZ_HERO_LOOK = { skin: '#b9805c', hair: { color: '#1b1410' }, ... }

   which is how a figure modelled on photographs is delivered: a small
   nz-hero-look.js next to this file, no changes in here. See LOOK below for
   every field.

   CONTRACT WITH THE REST OF THE GAME (all null-guarded on both sides)

     NUKEM.html   viewDir(org)  -> NZ.first('aimDir', org, dir)
                  drawOverlay   -> skips the 2D sprite weapon when NZ.view.hideVM
     nz-weapons   renderVM      -> returns early when NZ.view.hideVM
                  spawnTracer   -> NZ.first('tracerFrom') for the muzzle
     this file    'render' at priority 20: after the world animators (30-36),
                  before nz-render (0) draws. Returns undefined always -- it
                  never owns the frame.

   Zero external assets. Classic script, three.js r149 UMD surface only.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;
  NZ.flags.hero = false;

  var THREE = null;

  /* ------------------------------------------------------------- helpers -- */
  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  /* smooth 0 -> 1 as x goes a -> b; a may be above b (a falling edge) */
  function band(x, a, b) { var d = b - a; return sstep(Math.abs(d) < 1e-9 ? (x >= a ? 1 : 0) : (x - a) / d); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function angWrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function fract(v) { return v - Math.floor(v); }
  function hash1(n) { var h = Math.sin(n * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  /* frame-rate independent smoothing: `rate` is the fraction left after 1 s */
  function damp(a, b, rate, dt) { return b + (a - b) * Math.pow(rate, dt); }
  function toward(a, b, step) { return a < b ? Math.min(b, a + step) : Math.max(b, a - step); }

  /* Critically damped spring, substepped. Same shape as NZ.math.Spring; kept
     local so the module does not depend on which version of nz-core loaded. */
  function Spring(x, k, zeta) {
    this.x = x || 0; this.v = 0; this.target = this.x;
    this.k = k === undefined ? 170 : k;
    this.d = 2 * Math.sqrt(this.k) * (zeta === undefined ? 1 : zeta);
  }
  Spring.prototype.step = function (dt) {
    var rem = Math.min(dt, 0.1), h = 1 / 240;
    while (rem > 0) {
      var s = h < rem ? h : rem; rem -= s;
      this.v += ((this.target - this.x) * this.k - this.v * this.d) * s;
      this.x += this.v * s;
    }
    return this.x;
  };
  Spring.prototype.set = function (v) { this.x = v; this.v = 0; this.target = v; return this; };
  Spring.prototype.impulse = function (v) { this.v += v; return this; };

  /* Panic latch. A throw inside a per-frame hook would get that hook disabled
     by the bus and leave the camera wherever the last good frame put it --
     i.e. stuck outside the player's head with no way back. So every entry
     point catches, counts, and past a small budget the module hands the game
     back to first person and goes quiet. */
  var PANIC = 0, PANIC_MAX = 8, DEAD = false;
  function warn(msg) { try { console.warn('[nz-hero] ' + msg); } catch (e) { } }
  function panic(err, where) {
    PANIC++;
    if (PANIC <= 3) console.error('[nz-hero] ' + (where || 'frame') + ' failed:', err);
    if (PANIC >= PANIC_MAX && !DEAD) {
      DEAD = true;
      NZ.flags.hero = false;
      try { VIEW.third = false; VIEW.blend = 0; VIEW.hideVM = false; } catch (e) { }
      try { if (HERO && HERO.root) HERO.root.visible = false; } catch (e2) { }
      try { refreshUI(); } catch (e3) { }
      console.error('[nz-hero] disabled after repeated errors; first person retained');
    }
  }

  /* =========================================================================
     1. THE LOOK
     Every field is optional in an override; anything missing falls back to
     the value here. Colours are sRGB hex. Lengths are metres on a 1.83 m man
     (the game's eye sits at 1.71 m, so stature is not a free parameter --
     build and proportions are).
     ====================================================================== */
  var LOOK = {
    name: 'default',
    skin: '#c08c68',
    hair: {
      color: '#241a13',
      /* 'short' | 'buzz' | 'crop' | 'medium' | 'long' | 'bald' */
      style: 'short',
      /* how far down the forehead the hairline starts, 0 (high) .. 1 (low) */
      line: 0.5
      /* 'crop' -- short back and sides, a thick tousled top, a ragged fringe --
         also reads (all optional, metres):
           top 0.026     depth of hair on the crown
           sides 0.007   over the ears          back 0.011   down the back
           fringe 0.014  how far the locks hang below the roots at the front
           jag 0.5       0 a straight fringe .. 1 very ragged
           messy 0.5     0 smooth .. 1 tousled
           burn -0.006   where the sideburn ends, above (+) / below (-) the eye line
           nape -0.094   the neckline at the back, in the head's own heights */
    },
    /* 0 clean shaven .. 1 full beard. Up to ~0.4 reads as stubble. */
    beard: 0.22,
    brow: '#1c140e',
    eye: '#3b2a1c',
    build: {
      bulk: 1.0,        /* girth of trunk and limbs                          */
      shoulders: 1.0,   /* shoulder breadth                                  */
      head: 1.0,        /* head size                                         */
      neck: 1.0,        /* neck girth                                        */
      /* Stature, as a fraction of the 1.83 m the game's eye height implies.
         The whole figure (and the gun in his hands) scales about his feet and
         the chase camera drops with him; the game's own eye, hit box and
         first-person view do not change. */
      height: 1.0
    },
    /* The head fitted to a person: see "fitting the head" beside faceBump.
         head: { y: [[canonical, actual], ...], w: [[canonical, k], ...],
                 f: [[canonical, k], ...],
                 nose: 1, brow: 1, socket: 1, cheek: 1, lips: 1, chin: 1,   bump gains
                 earY: -0.008, earSize: 1, earOut: 0.35 }                   ears
       null is the stock head. */
    head: null,
    top: {
      /* 'jacket' | 'hoodie' | 'sweater' | 'tshirt' | 'shirt'
         'sweater' is a crew-neck sweatshirt: rib neck, cuffs and hem, dropped
         shoulders, cut loose (loose: 0 fitted .. 1 square; neckline: height
         of the front of the neck opening, 1.512) */
      type: 'jacket',
      color: '#39443a',
      trim: '#20261f',  /* collar, cuffs, hem band                           */
      under: '#d8d4cb', /* what shows at the neck                            */
      sleeves: 'long',  /* 'long' | 'short'                                  */
      hood: false,
      zip: true
    },
    bottom: {
      /* 'jeans' | 'trousers' | 'track' | 'shorts'
         'track' is tracksuit bottoms: elastic waist, rib cuffs; stripe: a
         colour puts a double stripe down the outside of the leg */
      type: 'jeans',
      color: '#2b3a55',
      stitch: '#b48a4c',
      length: 'long'
    },
    belt: '#1b1612',
    shoes: {
      /* 'sneakers' | 'boots' */
      type: 'sneakers',
      color: '#e4e1da',
      sole: '#f3f1ea',
      accent: '#b4402f'
    },
    gloves: null,       /* a colour puts gloves on; null is bare hands       */
    /* A photograph for the face (nz-hero-look.js writes this from the
       photographs). null: the face is painted from the fields above.

         face: {
           image:   'data:image/jpeg;base64,...'   a FRONTAL portrait, already
                    straightened and scaled to this head (see below). A data:
                    URL, so it also works when the page is opened from disk.
           half:    0.090    the picture's half-width: metres either side of
                             the midline of the face
           top:     0.125    its top edge, metres above the eye line
           bottom: -0.135    its bottom edge (negative: below the eyes)
           wrap:    1.15     how far round the head it is used, radians off
                             dead ahead; feathered over the last `feather`
           feather: 0.40
           opacity: 1
           features: false   true keeps the painted eyes, brows and mouth
                             under it (for lining a picture up)
         }

       Where this head keeps its features, in the picture's own frame (x in
       metres toward the FIGURE'S right -- the left of the picture -- and y in
       metres above the eye line). The picture must be warped to these:
           pupils          x = +-0.0315   y =  0.001
           brows                          y =  0.019 .. 0.026
           nostrils        x = +-0.0125   y = -0.050
           mouth line      x = +-0.0245   y = -0.0705
           chin                           y = -0.112
           cheek at the eye line          x = +-0.076   (the head's half-width)
       An alpha channel in the picture is honoured, so it can arrive already
       cut out along the jaw and hairline. */
    face: null
  };
  /* the stock figure, kept apart from whatever a look file makes of LOOK:
     other players' puppets wear this one (section 11) */
  var LOOK_STOCK = JSON.parse(JSON.stringify(LOOK));
  (function mergeLook() {
    var o = global.NZ_HERO_LOOK;
    if (!o || typeof o !== 'object') return;
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && LOOK[k] && typeof LOOK[k] === 'object') {
        for (var j in o[k]) if (Object.prototype.hasOwnProperty.call(o[k], j)) LOOK[k][j] = o[k][j];
      } else LOOK[k] = o[k];
    }
  })();

  /* =========================================================================
     2. GAME GLOBALS
     Top-level const/let in a classic script live in the global lexical scope,
     so they resolve by bare name from this file. Probed once at install.
     ====================================================================== */
  var G = {};
  function probeGlobals() {
    /* eslint-disable no-undef */
    G.player = (typeof player !== 'undefined') ? player : null;
    G.WPN = (typeof WPN !== 'undefined') ? WPN : null;
    G.state = (typeof state !== 'undefined') ? state : null;
    G.enemies = (typeof enemies !== 'undefined') ? enemies : null;
    G.EYE = (typeof EYE === 'number') ? EYE : 5.985;
    G.M = (typeof M === 'number') ? M : 3.5;
    G.castWall = (typeof castWall === 'function') ? castWall : null;
    G.shotBlocked = (typeof shotBlocked === 'function') ? shotBlocked : null;
    G.message = (typeof message === 'function') ? message : null;
    G.scopeMask = (typeof scopeMask === 'function') ? scopeMask : null;
    G.PICKTEX = (typeof PICKTEX !== 'undefined') ? PICKTEX : null;
    G.shadowStrength = (typeof shadowStrength === 'function') ? shadowStrength : null;
    G.keysDown = (typeof keysDown !== 'undefined') ? keysDown : null;
    G.cellAt = (typeof cellAt === 'function') ? cellAt : null;
    G.floorAt = (typeof floorAt === 'function') ? floorAt : null;
    G.CELL = (typeof CELL === 'number') ? CELL : 4;
    G.S_BLOCK = (typeof S_BLOCK === 'number') ? S_BLOCK : 6;
    G.CRATES = (typeof CRATES !== 'undefined') ? CRATES : null;
    G.MW = (typeof MW === 'number') ? MW : 0;
    G.MH = (typeof MH === 'number') ? MH : 0;
    G.grid = (typeof grid !== 'undefined') ? grid : null;
    G.regionOf = (typeof regionOf !== 'undefined') ? regionOf : null;
    G.REG = (typeof REG !== 'undefined') ? REG : null;
    G.liftOf = (typeof liftOf !== 'undefined') ? liftOf : null;
    G.S_FLOOR = (typeof S_FLOOR === 'number') ? S_FLOOR : 1;
    G.parts = (typeof parts !== 'undefined' && Array.isArray(parts)) ? parts : null;
    /* eslint-enable no-undef */
    return !!(G.player && G.WPN && G.state && G.shotBlocked && G.castWall);
  }
  /* world units per metre of the FIGURE: the game's scale times his stature */
  function heroScale() { return G.M * clamp(fin(LOOK.build && LOOK.build.height, 1), 0.5, 1.3); }
  function heroTall() { return clamp(fin(LOOK.build && LOOK.build.height, 1), 0.5, 1.3); }
  /* `skyMesh` is a `let` the game assigns late (makeSky, and the street sky
     module may swap it), so it is read fresh rather than cached. */
  function skyOf() {
    /* eslint-disable no-undef */
    try { return (typeof skyMesh !== 'undefined') ? skyMesh : null; } catch (e) { return null; }
    /* eslint-enable no-undef */
  }

  /* =========================================================================
     3. THE VIEW
     ====================================================================== */
  var VIEW_KEY = 'nuke-zone-3d:view:v1';
  /* Published at parse time, not at install: NUKEM.html and nz-weapons read
     NZ.view.hideVM / .blend every frame and must find plain falsy values
     there from the first one, whatever happens to this module later. */
  var VIEW = { third: false, blend: 0, hideVM: false };
  NZ.view = VIEW;

  function loadView() {
    var v = null;
    try {
      var m = /(?:[#&?])view=(1|3|first|third)\b/.exec(global.location.hash + '&' + global.location.search);
      if (m) v = (m[1] === '3' || m[1] === 'third');
    } catch (e) { }
    if (v === null) {
      try {
        var s = global.localStorage.getItem(VIEW_KEY);
        if (s === 'third') v = true; else if (s === 'first') v = false;
      } catch (e2) { }
    }
    VIEW.third = !!v;
  }
  function setThird(on, announce) {
    on = !!on && NZ.flags.hero && !DEAD;
    if (VIEW.third !== on) {
      VIEW.third = on;
      try { global.localStorage.setItem(VIEW_KEY, on ? 'third' : 'first'); } catch (e) { }
      if (announce && G.message && G.state && G.state.playing) G.message(on ? 'THIRD PERSON' : 'FIRST PERSON');
    }
    refreshUI();
  }

  /* ----------------------------------------------------------------- UI -- */
  /* Built here rather than written into NUKEM.html so the controls exist
     exactly when the feature does: no module, no orphaned button. They reuse
     the page's own .skill / .btn classes, so they inherit its look. */
  var ui = { group: null, first: null, third: null, pause: null, hint: null };
  function buildUI() {
    var doc = global.document;
    if (!doc || ui.group) return;
    var title = doc.getElementById('scTitle');
    if (title) {
      var g = doc.createElement('div');
      g.id = 'views';
      g.setAttribute('role', 'radiogroup');
      g.setAttribute('aria-label', 'Camera view');
      /* one short row, not a third deck of cards: the title screen is already
         as tall as a 540-pixel window allows */
      g.style.cssText = 'display:flex;align-items:center;gap:clamp(6px,.7vw,14px);margin-top:1.1vh;flex-wrap:wrap;justify-content:center';
      var lab = doc.createElement('span');
      lab.textContent = 'VIEW';
      lab.style.cssText = 'font-size:clamp(9px,1.25vh,13px);letter-spacing:.22em;opacity:.62';
      g.appendChild(lab);
      var mk = function (name, tip, on) {
        var b = doc.createElement('button');
        b.type = 'button'; b.className = 'skill';
        b.setAttribute('role', 'radio');
        b.title = tip;
        b.style.cssText = 'min-width:0;padding:.62vh 1.25vw .68vh';
        b.innerHTML = '<span class="sn"></span>';
        var sn = b.querySelector('.sn');
        sn.textContent = name;
        sn.style.fontSize = 'clamp(9px,1.32vh,14px)';
        b.onclick = function () { setThird(on, false); };
        g.appendChild(b);
        return b;
      };
      ui.first = mk('FIRST PERSON', 'Through the sights, as the game has always played', false);
      ui.third = mk('THIRD PERSON', 'Over the shoulder, with your figure in frame. V switches at any time', true);
      var anchor = doc.getElementById('skilltag');
      if (anchor && anchor.parentNode === title) title.insertBefore(g, anchor.nextSibling);
      else title.appendChild(g);
      ui.group = g;
      /* one more entry on the controls line */
      var brief = doc.getElementById('missionBrief');
      var p = brief && brief.parentNode;
      if (p) {
        var hint = doc.createElement('span');
        hint.innerHTML = ' &nbsp;&bull;&nbsp; <span class="keyhint">V</span> first / third person';
        /* after the "ESC pause" entry: the last text before the blank line */
        var brs = p.getElementsByTagName('br');
        var at = brs.length >= 3 ? brs[brs.length - 3] : null;
        if (at && at.parentNode === p) p.insertBefore(hint, at); else p.insertBefore(hint, brief);
        ui.hint = hint;
      }
    }
    var resume = doc.getElementById('btnResume');
    if (resume && resume.parentNode) {
      var pb = doc.createElement('button');
      pb.className = 'btn'; pb.id = 'btnView'; pb.type = 'button';
      pb.onclick = function () { setThird(!VIEW.third, false); };
      resume.parentNode.insertBefore(pb, resume);
      ui.pause = pb;
    }
    refreshUI();
  }
  function refreshUI() {
    if (ui.first) {
      ui.first.setAttribute('aria-checked', VIEW.third ? 'false' : 'true');
      ui.third.setAttribute('aria-checked', VIEW.third ? 'true' : 'false');
      ui.first.tabIndex = VIEW.third ? -1 : 0;
      ui.third.tabIndex = VIEW.third ? 0 : -1;
      ui.third.disabled = !NZ.flags.hero || DEAD;
    }
    if (ui.pause) {
      ui.pause.textContent = VIEW.third ? 'VIEW: THIRD PERSON' : 'VIEW: FIRST PERSON';
      ui.pause.disabled = !NZ.flags.hero || DEAD;
    }
  }
  var keyBound = false;
  function bindKey() {
    if (keyBound || !global.document) return;
    keyBound = true;
    global.document.addEventListener('keydown', function (e) {
      try {
        if (e.repeat) return;
        if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (!NZ.flags.hero || DEAD) return;
          var ST = G.state;
          if (ST && ST.ended) return;
          setThird(!VIEW.third, true);
        } else if (e.code === 'KeyR') {
          /* the same cosmetic reload nz-weapons plays on the viewmodel */
          var S2 = G.state;
          if (HERO && S2 && S2.playing && !S2.paused && !S2.ended) heroReload();
        } else if (e.code === 'KeyU' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (SHOW.on) showcaseOff(); else showcaseOn();
        }
      } catch (err) { panic(err, 'key'); }
    });
  }

  /* =========================================================================
     4. THE CAMERA
     ====================================================================== */
  /* Offsets are in WORLD units (3.5 to the metre) from the eye:
       side  to the shooter's right     up  straight up     back  along the aim
     The hip numbers put a 1.83 m figure at about 40% of frame height with his
     head left of and below the crosshair -- the GTA framing -- and the ADS
     numbers close to a tight over-the-shoulder. */
  var CAMT = {
    hip: { side: 1.90, up: 1.05, back: 9.6, fov: 76 },
    ads: { side: 2.00, up: 0.50, back: 5.4 },
    low: { side: 1.70, up: 1.90, back: 9.0 },   /* crawling: the eye is at 550 mm */
    pad: 0.42,        /* half-size of the box the lens is swept as              */
    margin: 0.55,     /* how far the lens stops short of what it hit            */
    minBoom: 0.85,
    fade: 2.1         /* closer to the head than this and the figure is hidden  */
  };
  var cam = {
    t: 0, init: false, pivotY: 0, tight: 0, tightOn: false, free: CAMT.hip.back,
    side: CAMT.hip.side, up: CAMT.hip.up, boom: CAMT.hip.back, k1: 1,
    fovGame: 84, fovTP: CAMT.hip.fov, deadT: 0,
    /* lens, aim basis and solved aim point, all world */
    x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, rx: 1, rz: 0, yaw: 0, pitch: 0,
    ax: 0, ay: 0, az: 0, aimT: 0, aimOK: false
  };

  /* What stops the lens. Bullets and the lens agree about walls, floors,
     ceilings, shut doors and crates, so the game's own shot test is the base.
     They disagree about one thing: an occupied cell that is NOT a crate. To a
     bullet that is waist-high cover; what actually stands on it is whatever a
     level module drew there -- a parked car, a tree, a road closure, a garden
     wall -- and a lens that flies over "waist-high cover" ends up inside a
     tree with a sign board between it and the player. So those cells stop the
     lens to well above head height. */
  var crateCells = null;
  function lensBlocked(x, y, z) {
    if (G.shotBlocked(x, y, z)) return true;
    if (!G.cellAt) return false;
    var cx = Math.floor(x / G.CELL), cz = Math.floor(z / G.CELL);
    if (G.cellAt(cx, cz) !== G.S_BLOCK) return false;
    if (!crateCells) {
      crateCells = Object.create(null);
      if (G.CRATES) for (var i = 0; i < G.CRATES.length; i++) crateCells[G.CRATES[i][0] + '_' + G.CRATES[i][1]] = 1;
    }
    if (crateCells[cx + '_' + cz]) return false;
    return y < (G.floorAt ? G.floorAt(cx, cz) : 0) + 13;
  }

  /* -------------------------------------------------------------------------
     THE DRESSING.  The grid is the level's collision, and it is deliberately
     coarse: a road-closure board, a lamp post, an awning or a hanging light
     fitting is drawn by a level module in the middle of a cell the grid calls
     open air. Nothing collides with those -- but a lens parked behind one has
     a sign board filling the frame. So the free-standing part of the level's
     static geometry is indexed once, by triangle, into the same 4-unit cells,
     and the boom is ray-cast against it.

       WHICH TRIANGLES   only those with a corner or their centre in open air
                         of an ordinary floor cell, more than 0.7 u from
                         anything the grid already blocks and clear of the
                         floor and ceiling. Walls, facades, floors, crates,
                         doors, lifts and prop cells are the grid's business
                         and are skipped -- which is the difference between
                         indexing a million triangles and a few tens of
                         thousands.
       WHICH MESHES      opaque, static, lit. Skinned and instanced meshes,
                         sprites, unlit cards (sky, decals, pickups, tracers)
                         and anything transparent never qualify. A mesh that
                         has MOVED since it was indexed is dropped the first
                         time a ray touches it.
       WHEN              in slices, a budget of triangles per frame, starting
                         at boot -- the title screen pays for it.
     Purely a camera aid: bullets, movement and the AI never see any of this.
     ---------------------------------------------------------------------- */
  var TI = {
    ok: false, n: 0, cap: 0, v: null, owner: null, stamp: null, q: 1,
    cells: null, meshes: [], sig: [], dyn: [], seen: Object.create(null),
    queue: [], cur: null, scanT: 0, done: 0
  };
  var TI_SKIP = /^(nz-hero|nz-vm|nz-tracers|nz-char|nz-enemy|nz-far|heroContactShadow|enemyContactShadow)/;

  function tiInit() {
    TI.ok = !!(G.grid && G.regionOf && G.REG && G.MW > 0 && G.MH > 0);
    if (!TI.ok) return;
    TI.cells = Object.create(null);
    TI.cap = 8192;
    TI.v = new Float32Array(TI.cap * 9); TI.owner = new Int32Array(TI.cap); TI.stamp = new Uint32Array(TI.cap);
  }
  function tiOpen(x, y, z) {
    var cx = Math.floor(x / G.CELL), cz = Math.floor(z / G.CELL);
    if (cx < 0 || cz < 0 || cx >= G.MW || cz >= G.MH) return false;
    var i = cz * G.MW + cx;
    if (G.grid[i] !== G.S_FLOOR || (G.liftOf && G.liftOf[i] >= 0)) return false;
    var R = G.REG[G.regionOf[i]];
    return !!R && y > R.f + 0.9 && y < R.c - 0.2;
  }
  function tiFree(x, y, z) {
    return tiOpen(x, y, z) && tiOpen(x + 0.7, y, z) && tiOpen(x - 0.7, y, z) && tiOpen(x, y, z + 0.7) && tiOpen(x, y, z - 0.7);
  }
  function tiEligible(o) {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return false;
    var m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.isMeshBasicMaterial || m.transparent || m.isShaderMaterial || m.isSpriteMaterial) return false;
    if (m.name && /^nzapc:/.test(m.name)) return false;
    for (var p = o; p; p = p.parent) { if (!p.visible) return false; if (p.name && TI_SKIP.test(p.name)) return false; }
    return true;
  }
  /* find meshes that have appeared since the last look */
  function tiScan() {
    var scene = NZ.ctx.scene;
    if (!scene) return;
    scene.traverse(function (o) {
      if (!o.isMesh || TI.seen[o.uuid]) return;
      TI.seen[o.uuid] = 1;
      if (tiEligible(o)) TI.queue.push(o);
    });
  }
  function tiAdd(ax, ay, az, bx, by, bz, cx, cy, cz, id) {
    var x0 = Math.floor(Math.min(ax, bx, cx) / G.CELL), x1 = Math.floor(Math.max(ax, bx, cx) / G.CELL);
    var z0 = Math.floor(Math.min(az, bz, cz) / G.CELL), z1 = Math.floor(Math.max(az, bz, cz) / G.CELL);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 48) return;           /* a backdrop, not a prop */
    if (TI.n >= TI.cap) {
      if (TI.cap >= 600000) return;
      TI.cap *= 2;
      var v2 = new Float32Array(TI.cap * 9); v2.set(TI.v); TI.v = v2;
      var o2 = new Int32Array(TI.cap); o2.set(TI.owner); TI.owner = o2;
      TI.stamp = new Uint32Array(TI.cap);
    }
    var k = TI.n++, o = k * 9, V9 = TI.v;
    V9[o] = ax; V9[o + 1] = ay; V9[o + 2] = az; V9[o + 3] = bx; V9[o + 4] = by; V9[o + 5] = bz; V9[o + 6] = cx; V9[o + 7] = cy; V9[o + 8] = cz;
    TI.owner[k] = id;
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
      var key = z * 4096 + x;
      (TI.cells[key] || (TI.cells[key] = [])).push(k);
    }
  }
  /* index up to `budget` triangles; returns true while there is more to do */
  function tiStep(budget) {
    if (!TI.ok) return false;
    while (budget > 0) {
      var c = TI.cur;
      if (!c) {
        var o = TI.queue.shift();
        if (!o) return false;
        if (!tiEligible(o)) continue;
        o.updateWorldMatrix(true, false);
        var g = o.geometry, pos = g.attributes.position;
        if (pos.isInterleavedBufferAttribute || pos.itemSize < 3) continue;
        var id = TI.meshes.length, e = o.matrixWorld.elements;
        TI.meshes.push(o); TI.dyn.push(0);
        TI.sig.push([e[12], e[13], e[14], e[0], e[5], e[10]]);
        c = TI.cur = { o: o, id: id, pos: pos.array, ix: g.index ? g.index.array : null, i: 0,
          n: g.index ? g.index.count : pos.count, e: Array.prototype.slice.call(e), st: pos.itemSize };
      }
      var P = c.pos, IX = c.ix, E = c.e, st = c.st, end = Math.min(c.n, c.i + budget * 3), i = c.i;
      for (; i + 2 < end; i += 3) {
        var a = (IX ? IX[i] : i) * st, b = (IX ? IX[i + 1] : i + 1) * st, d = (IX ? IX[i + 2] : i + 2) * st;
        var ax = E[0] * P[a] + E[4] * P[a + 1] + E[8] * P[a + 2] + E[12], ay = E[1] * P[a] + E[5] * P[a + 1] + E[9] * P[a + 2] + E[13], az = E[2] * P[a] + E[6] * P[a + 1] + E[10] * P[a + 2] + E[14];
        var bx = E[0] * P[b] + E[4] * P[b + 1] + E[8] * P[b + 2] + E[12], by = E[1] * P[b] + E[5] * P[b + 1] + E[9] * P[b + 2] + E[13], bz = E[2] * P[b] + E[6] * P[b + 1] + E[10] * P[b + 2] + E[14];
        var cx = E[0] * P[d] + E[4] * P[d + 1] + E[8] * P[d + 2] + E[12], cy = E[1] * P[d] + E[5] * P[d + 1] + E[9] * P[d + 2] + E[13], cz = E[2] * P[d] + E[6] * P[d + 1] + E[10] * P[d + 2] + E[14];
        if (tiFree(ax, ay, az) || tiFree(bx, by, bz) || tiFree(cx, cy, cz) ||
            tiFree((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3)) tiAdd(ax, ay, az, bx, by, bz, cx, cy, cz, c.id);
      }
      budget -= (i - c.i) / 3 + 1;
      c.i = i;
      if (c.i + 2 >= c.n) { TI.cur = null; TI.done++; }
    }
    return true;
  }
  /* is the owner of triangle k still where it was indexed, and still drawn? */
  function tiLive(k) {
    var id = TI.owner[k];
    if (TI.dyn[id]) return false;
    var o = TI.meshes[id], s = TI.sig[id], e = o.matrixWorld.elements;
    if (Math.abs(e[12] - s[0]) + Math.abs(e[13] - s[1]) + Math.abs(e[14] - s[2]) + Math.abs(e[0] - s[3]) + Math.abs(e[5] - s[4]) + Math.abs(e[10] - s[5]) > 1e-3) {
      TI.dyn[id] = 1; return false;
    }
    for (var p = o; p; p = p.parent) { if (!p.visible) return false; if (!p.parent && !p.isScene) return false; }
    return true;
  }
  /* first hit of segment a->b on the index, as a fraction 0..1 (1 = clear) */
  function tiSegment(ax, ay, az, bx, by, bz) {
    if (!TI.n) return 1;
    var dx = bx - ax, dy = by - ay, dz = bz - az, best = 1, C = G.CELL, V9 = TI.v;
    var q = ++TI.q;
    if (q > 4e9) { TI.stamp.fill(0); TI.q = q = 1; }
    /* walk the cells the segment crosses (2D DDA in XZ) */
    var cx = Math.floor(ax / C), cz = Math.floor(az / C), ex = Math.floor(bx / C), ez = Math.floor(bz / C);
    var sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    var tdx = Math.abs(dx) > 1e-9 ? C / Math.abs(dx) : 1e9, tdz = Math.abs(dz) > 1e-9 ? C / Math.abs(dz) : 1e9;
    var tmx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? (cx + 1) * C - ax : ax - cx * C) / Math.abs(dx)) : 1e9;
    var tmz = Math.abs(dz) > 1e-9 ? ((dz > 0 ? (cz + 1) * C - az : az - cz * C) / Math.abs(dz)) : 1e9;
    for (var guard = 0; guard < 64; guard++) {
      var list = TI.cells[cz * 4096 + cx];
      if (list) for (var i = 0; i < list.length; i++) {
        var k = list[i];
        if (TI.stamp[k] === q) continue;
        TI.stamp[k] = q;
        var o = k * 9;
        var e1x = V9[o + 3] - V9[o], e1y = V9[o + 4] - V9[o + 1], e1z = V9[o + 5] - V9[o + 2];
        var e2x = V9[o + 6] - V9[o], e2y = V9[o + 7] - V9[o + 1], e2z = V9[o + 8] - V9[o + 2];
        var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        var det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-9 && det < 1e-9) continue;
        var inv = 1 / det, tx = ax - V9[o], ty = ay - V9[o + 1], tz = az - V9[o + 2];
        var u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        var v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 0 && t < best && tiLive(k)) best = t;
      }
      if (cx === ex && cz === ez) break;
      if (tmx < tmz) { if (tmx > best) break; tmx += tdx; cx += sx; } else { if (tmz > best) break; tmz += tdz; cz += sz; }
    }
    return best;
  }

  /* Occupancy sweep: the lens is a small box, not a point, or its near plane
     cuts through every wall it brushes. Returns the free fraction of a->b. */
  function sweep(ax, ay, az, bx, by, bz, rx, rz) {
    var SB = lensBlocked, pad = CAMT.pad;
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return 1;
    var n = Math.max(2, Math.ceil(len / 0.30)), free = 1;
    for (var i = 1; i <= n; i++) {
      var t = i / n, x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
      if (SB(x, y, z) || SB(x, y + pad, z) || SB(x, y - pad, z) ||
          SB(x + rx * pad, y, z + rz * pad) || SB(x - rx * pad, y, z - rz * pad)) { free = (i - 1) / n; break; }
    }
    if (TI.n) {
      /* the dressing: the axis of the box and its four edges */
      var px = rx * pad, pz = rz * pad;
      var tt = Math.min(
        tiSegment(ax, ay, az, bx, by, bz),
        tiSegment(ax, ay, az, bx, by + pad, bz), tiSegment(ax, ay, az, bx, by - pad, bz),
        tiSegment(ax, ay, az, bx + px, by, bz + pz), tiSegment(ax, ay, az, bx - px, by, bz - pz));
      if (tt < 1) free = Math.min(free, Math.max(0, tt - 0.30 / len));
    }
    return free;
  }

  /* What is the crosshair covering? The game's own shot test, cast along the
     lens axis but STARTED level with the shooter, so nothing standing between
     the lens and his shoulder can catch it. Writes cam.ax/ay/az. */
  function solveAim(lx, ly, lz, fx, fy, fz, ox, oy, oz, range) {
    var t0 = (ox - lx) * fx + (oy - ly) * fy + (oz - lz) * fz;
    if (!(t0 > 0)) t0 = 0;
    var sx = lx + fx * t0, sy = ly + fy * t0, sz = lz + fz * t0;
    _org.x = sx; _org.y = sy; _org.z = sz;
    _dir.x = fx; _dir.y = fy; _dir.z = fz;
    var best = G.castWall(_org, _dir, range);
    var es = G.enemies;
    if (es) for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (!e || e.dead || !e.cfg) continue;
      /* the same broad phase hitscan() runs, so the point converged on is a
         point a round can actually reach */
      var lx2 = e.lx || 0, lz2 = e.lz || 0;
      var ex = e.x + lx2 * .5 - sx, ey = (e.cy ? e.cy() : e.y + e.cfg.h * .5) - sy, ez = e.z + lz2 * .5 - sz;
      var t = ex * fx + ey * fy + ez * fz;
      if (t <= .5 || t > best) continue;
      var px = ex - fx * t, py = ey - fy * t, pz = ez - fz * t;
      var rad = e.cfg.hitRad || Math.max(e.cfg.rad * 1.18 + Math.sqrt(lx2 * lx2 + lz2 * lz2) * .5,
        e.cfg.mechanical ? (e.cfg.headRad || 0) : 0);
      var hh = e.hh ? e.hh() : e.cfg.h * .5;
      if (px * px + pz * pz > rad * rad || Math.abs(py) > hh) continue;
      if (e.cfg.narrowPhase) {
        var nt = NZ.first('enemyRayTest', e, _org, _dir, best);
        if (nt !== undefined) { if (nt > 0) best = nt; continue; }
      }
      best = t;
    }
    cam.ax = sx + fx * best; cam.ay = sy + fy * best; cam.az = sz + fz * best;
    cam.aimT = best; cam.aimOK = true;
    return best;
  }
  var _org = { x: 0, y: 0, z: 0 }, _dir = { x: 0, y: 0, z: -1 }, _aimOut = null;

  function updateBlend(dt) {
    var P = G.player, W = G.WPN[P.weapon];
    cam.t = toward(cam.t, ((VIEW.third || SHOW.active) && !DEAD) ? 1 : 0, dt / 0.26);
    /* Behind glass the sight picture is drawn at the eye, so a scoped weapon
       pulls the lens home over the first half of the mount. By the time the
       game's eyepiece starts to close (ads 0.62) this is already first person
       and the ordinary scope path runs untouched. */
    var scopeK = (!SHOW.active && W && W.scope && P.pending < 0 && P.alive) ? band(fin(P.ads), 0.20, 0.50) : 0;
    /* Backed into a corner there is no room for a boom: under about half a
       metre of it the lens would sit inside the figure's head. Rather than
       hide him and leave the player looking at nothing, the view goes home to
       the eye -- weapon and all -- and comes back out when there is room. */
    /* Latched, with a wide gap between in and out: a boom that hovers on the
       threshold must not flip the view every other frame. */
    if (!cam.init || cam.t <= 0 || !P.alive || SHOW.active) cam.tightOn = false;
    else if (cam.free < 2.3) cam.tightOn = true;
    else if (cam.free > 3.6) cam.tightOn = false;
    cam.tight = damp(cam.tight, cam.tightOn ? 1 : 0, 2e-4, dt);
    VIEW.blend = sstep(cam.t) * (1 - scopeK) * (1 - sstep(cam.tight));
    VIEW.hideVM = VIEW.blend > 0.5 || SHOW.active;
  }

  function updateCamera(dt) {
    var P = G.player, c = NZ.ctx.camera, W = G.WPN[P.weapon] || {};
    var b = VIEW.blend;

    /* ---- the game's aim angles, exactly ---------------------------------- */
    var yaw = P.yaw + fin(P.recoilYaw);
    var pitchFP = clamp(P.pitch + fin(P.kick) * .012 + fin(P.recoilPitch), -1.5, 1.5);
    var eyeY = P.y - fin(P.stepSm) + fin(P.eyeH, G.EYE);
    /* the boom hangs off the FIGURE'S eye, which is the game's eye unless he
       is shorter or taller than the game's 1.71 m */
    var pivY = P.y - fin(P.stepSm) + fin(P.eyeH, G.EYE) * heroTall();
    if (!cam.init || Math.abs(pivY - cam.pivotY) > 9) {
      cam.pivotY = pivY; cam.init = true; cam.boom = CAMT.hip.back; cam.free = CAMT.hip.back; cam.k1 = 1;
    }
    /* stance changes move the eye in one frame; the boom follows in ~90 ms */
    cam.pivotY = damp(cam.pivotY, pivY, 2e-6, dt);

    cam.deadT = P.alive ? 0 : Math.min(1, cam.deadT + dt / 1.5);
    var dk = sstep(cam.deadT);
    var pitch = pitchFP - 0.34 * dk;          /* the lens tips down onto the body */

    var sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    var fx = -sy * cp, fy = sp, fz = -cy * cp;
    var rx = cy, rz = -sy;

    /* ---- where the boom wants to be -------------------------------------- */
    var ads = W.altDetonate ? 0 : clamp(fin(P.ads), 0, 1);
    var low = HERO ? HERO.st.proneK : (P.crawling ? 1 : 0);
    var side = lerp(CAMT.hip.side, CAMT.ads.side, ads);
    var up = lerp(CAMT.hip.up, CAMT.ads.up, ads);
    var back = lerp(CAMT.hip.back, CAMT.ads.back, ads);
    var lk = low * (1 - ads * .6);
    side = lerp(side, CAMT.low.side, lk); up = lerp(up, CAMT.low.up, lk); back = lerp(back, CAMT.low.back, lk);
    /* a smaller figure is framed from proportionally closer */
    var fk = lerp(1, heroTall(), 0.6);
    side *= fk; up *= fk; back *= fk;
    back *= 1 + 0.07 * fin(P.dash) + 0.40 * dk;
    up += 2.6 * dk;
    /* Looking up swings the boom down into the floor. Shorten it and take the
       lift off first, so the sweep below is a correction and not the plan. */
    var upK = clamp(pitch / 1.15, 0, 1);
    back *= 1 - 0.30 * upK; up *= 1 - 0.55 * upK;

    /* ---- leg 1: eye -> shoulder ------------------------------------------ */
    var ax = P.x, ay = cam.pivotY, az = P.z;
    var t1 = sweep(ax, ay, az, ax + rx * side, ay + up, az + rz * side, rx, rz);
    if (t1 < 1) t1 = Math.max(0, t1 - 0.10);
    /* in at once (a lens inside a wall shows the void), out slowly */
    cam.k1 = t1 < cam.k1 ? t1 : Math.min(t1, damp(cam.k1, t1, 0.004, dt) + dt * 0.2);
    cam.side = side * cam.k1; cam.up = up * cam.k1;
    var bx = ax + rx * cam.side, by = ay + cam.up, bz = az + rz * cam.side;

    /* ---- leg 2: shoulder -> lens ------------------------------------------ */
    var t2 = sweep(bx, by, bz, bx - fx * back, by - fy * back, bz - fz * back, rx, rz);
    var free = back * t2;
    if (t2 < 1) free = Math.max(CAMT.minBoom, free - CAMT.margin);
    cam.free = free;
    cam.boom = free < cam.boom ? free : Math.min(free, damp(cam.boom, free, 0.003, dt) + dt * 0.6);

    cam.x = bx - fx * cam.boom; cam.y = by - fy * cam.boom; cam.z = bz - fz * cam.boom;
    cam.fx = fx; cam.fy = fy; cam.fz = fz; cam.rx = rx; cam.rz = rz; cam.yaw = yaw; cam.pitch = pitch;

    /* ---- what the crosshair is on ----------------------------------------- */
    solveAim(cam.x, cam.y, cam.z, fx, fy, fz, P.x, eyeY, P.z, 400);

    if (SHOW.active) cam.aimOK = false;      /* the crosshair means nothing from in front of him */
    if (b <= 0.0005 && !SHOW.active && SHOW.k <= 0) return;

    /* ---- hand it to the renderer ------------------------------------------- */
    var fpY = eyeY + fin(P.bob);
    c.position.set(lerp(P.x, cam.x, b), lerp(fpY, cam.y, b), lerp(P.z, cam.z, b));
    c.rotation.order = 'YXZ';
    c.rotation.set(lerp(pitchFP, pitch, b), yaw, fin(P.roll) * (1 - b));

    /* FOV. The game eases camera.fov toward its own target every tick starting
       from whatever is in the property, so the game's curve is re-derived here
       and the property is simply overwritten -- when the blend reaches zero
       the value left behind is the one the game would have had. */
    var rsp = 1 - Math.exp(-dt * 10);
    var gameT = lerp(84 + 7 * fin(P.dash), W.adsFov || 70, clamp(fin(P.ads), 0, 1));
    cam.fovGame += (gameT - cam.fovGame) * rsp;
    var tpT = lerp(CAMT.hip.fov + 5 * fin(P.dash), clamp(fin(W.adsFov, 70), 50, 68), ads);
    cam.fovTP += (tpT - cam.fovTP) * rsp;
    var fov = lerp(cam.fovGame, cam.fovTP, b);
    if (Math.abs(c.fov - fov) > 0.01) { c.fov = fov; c.updateProjectionMatrix(); }

    var sky = skyOf();
    if (sky) sky.position.copy(c.position);
    if (SHOW.active || SHOW.k > 0) showcaseCamera(c, dt);
  }

  /* =========================================================================
     THE SHOWCASE (U)
     U swings the camera round from behind him to his front and frames the
     whole figure; the wheel zooms in to his face; the mouse turns the camera
     round him. U again swings it back and gives everything back.

     While it is up the game is in its own inspect mode (Y): the enemies are
     statues and nothing hurts -- unless inspect was already on, in which case
     it is left on afterwards too. And his own controls are held, because a
     camera in front of him turns every key backwards: updatePlayer runs with
     the keys, the stick and the trigger released (he idles, the gun lowered),
     and lookBy -- the one door both the mouse and the touch look pad use --
     turns the camera instead of the man. A click made meanwhile is spent, not
     saved for later.
     ====================================================================== */
  var SHOW = {
    on: false,          /* what U last asked for                                  */
    active: false,      /* on, or still swinging back                             */
    k: 0,               /* the swing: 0 the game's own camera .. 1 in front of him */
    zoom: 0, zoomT: 0,  /* 0 the whole figure .. 1 his face                       */
    az: 0, el: 0,       /* the mouse: round him, and up or down, radians          */
    rad: -1,            /* the distance actually used, after the walls had a say  */
    inspectSet: false   /* inspect mode was switched on by U, so U switches it off */
  };
  VIEW.showcase = false;
  var SHOW_IN = 1.05, SHOW_OUT = 0.60;                   /* seconds per swing */

  function inspectGet() {
    /* eslint-disable no-undef */
    try { return (typeof inspectMode !== 'undefined') ? !!inspectMode : false; } catch (e) { return false; }
  }
  function inspectSet(v) {
    try { if (typeof inspectMode !== 'undefined') inspectMode = !!v; } catch (e) { }
    /* eslint-enable no-undef */
  }
  var showCss = false;
  function showcaseClass(on) {
    var doc = global.document;
    if (!doc || !doc.body) return;
    if (!showCss && doc.head) {
      showCss = true;
      var st = doc.createElement('style');
      st.textContent = 'body.nz-showcase #cross{visibility:hidden!important}';
      doc.head.appendChild(st);
    }
    if (doc.body.classList) doc.body.classList.toggle('nz-showcase', !!on);
  }
  /* the way to stand: the clearest of a few headings round his front, so a
     wall in front of his face does not leave the lens pressed against it */
  function showcaseHeading() {
    var P = G.player, MU = G.M, tall = heroTall(), yaw = P.yaw;
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    var y = P.y - fin(P.stepSm) + fin(P.eyeH, G.EYE) * tall * 0.75, L = 2.6 * MU * tall;
    var best = 0, bestF = -1, tries = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35];
    for (var i = 0; i < tries.length; i++) {
      var a = tries[i], hx = fx * Math.cos(a) + rx * Math.sin(a), hz = fz * Math.cos(a) + rz * Math.sin(a);
      var f = sweep(P.x, y, P.z, P.x + hx * L, y, P.z + hz * L, hz, -hx);
      if (f > bestF + 0.12) { bestF = f; best = a; }
      if (f >= 0.999) break;
    }
    return best;
  }
  function showcaseOn() {
    var ST = G.state, P = G.player;
    if (SHOW.on || DEAD || !NZ.flags.hero || !HERO || !ST || !ST.playing || ST.ended || !P || !P.alive) return false;
    SHOW.on = true; SHOW.active = true; VIEW.showcase = true;
    SHOW.zoomT = 0; SHOW.el = 0; SHOW.rad = -1;
    try { SHOW.az = showcaseHeading(); } catch (e) { SHOW.az = 0; }
    if (!inspectGet()) { inspectSet(true); SHOW.inspectSet = true; }
    showcaseClass(true);
    if (G.message) G.message('SHOWCASE \u2022 WHEEL ZOOMS \u2022 MOUSE TURNS \u2022 U RETURNS');
    return true;
  }
  function showcaseOff() {
    if (!SHOW.on) return false;
    SHOW.on = false;                    /* the swing back; showcaseDone() lands it */
    return true;
  }
  function showcaseDone() {
    SHOW.on = false; SHOW.active = false; SHOW.k = 0; SHOW.rad = -1; VIEW.showcase = false;
    if (SHOW.inspectSet) { if (inspectGet()) inspectSet(false); SHOW.inspectSet = false; }
    showcaseClass(false);
  }
  function showcaseStep(dt) {
    if (!SHOW.active) return;
    var ST = G.state, P = G.player;
    /* death, the end of the level, a restart, the module failing: out at once */
    if (DEAD || !HERO || !ST || ST.ended || !ST.booted || !P || !P.alive) { showcaseDone(); return; }
    SHOW.k = toward(SHOW.k, SHOW.on ? 1 : 0, dt / (SHOW.on ? SHOW_IN : SHOW_OUT));
    if (SHOW.on) SHOW.zoom = damp(SHOW.zoom, SHOW.zoomT, 2e-3, dt);
    if (!SHOW.on && SHOW.k <= 0) showcaseDone();
  }
  /* lookBy, while the showcase is up: the mouse (or the look pad) turns the
     camera round him. Right moves the lens to the right, up tips the view up. */
  function showcaseOrbit(mx, my) {
    if (!SHOW.on) return;
    SHOW.az = angWrap(SHOW.az - fin(mx) * 0.0045);
    SHOW.el = clamp(SHOW.el + fin(my) * 0.0030, -0.32, 0.95);
  }
  function showcaseWheel(e) {
    if (!SHOW.active) return;
    /* the wheel is the weapon switch the rest of the time: not now */
    e.preventDefault(); e.stopImmediatePropagation();
    if (!SHOW.on) return;
    var d = fin(e.deltaY);
    if (e.deltaMode === 1) d *= 40; else if (e.deltaMode === 2) d *= 800;
    /* one notch of an ordinary wheel is an eighth of the way to his face */
    SHOW.zoomT = clamp(SHOW.zoomT - clamp(d, -240, 240) * 0.00125, 0, 1);
  }

  /* Hold his controls for the length of one updatePlayer, then put them back
     exactly as they were -- no input event can arrive in the middle of a
     synchronous call, so nothing is lost but the presses spent meanwhile. */
  function holdInputs(fn, self, args) {
    /* eslint-disable no-undef */
    var K = null, md = false, ad = false, pad = null;
    try {
      if (typeof keysDown === 'object' && keysDown) { K = {}; for (var k in keysDown) { K[k] = keysDown[k]; keysDown[k] = false; } }
      if (typeof mouseDown !== 'undefined') { md = mouseDown; mouseDown = false; }
      if (typeof adsDown !== 'undefined') { ad = adsDown; adsDown = false; }
      if (typeof fireQueued !== 'undefined') fireQueued = false;
      if (typeof altQueued !== 'undefined') altQueued = false;
      if (typeof padAxis === 'object' && padAxis) { pad = !!padAxis.on; padAxis.on = false; }
    } catch (e) { }
    try { return fn.apply(self, args); }
    finally {
      try {
        if (K) for (var k2 in K) keysDown[k2] = K[k2];
        if (typeof mouseDown !== 'undefined') mouseDown = md;
        if (typeof adsDown !== 'undefined') adsDown = ad;
        if (typeof fireQueued !== 'undefined') fireQueued = false;
        if (typeof altQueued !== 'undefined') altQueued = false;
        if (pad !== null) padAxis.on = pad;
      } catch (e2) { }
    }
    /* eslint-enable no-undef */
  }
  /* Function declarations in a classic script are properties of the global
     object and every call resolves them there, so a wrapper put on window is
     the one the game's own frame() and nz-touch.js call. With the showcase
     down both wrappers are a single test and a pass-through. */
  function wrapShowcase() {
    var g = global;
    if (typeof g.updatePlayer === 'function' && !g.updatePlayer.nzShowcase) {
      var up = g.updatePlayer;
      var wu = function () { return SHOW.active ? holdInputs(up, this, arguments) : up.apply(this, arguments); };
      wu.nzShowcase = true;
      g.updatePlayer = wu;
    }
    if (typeof g.lookBy === 'function' && !g.lookBy.nzShowcase) {
      var lb = g.lookBy;
      var wl = function (mx, my) { if (SHOW.active) { showcaseOrbit(mx, my); return undefined; } return lb.apply(this, arguments); };
      wl.nzShowcase = true;
      g.lookBy = wl;
    } else if (typeof g.lookBy !== 'function' && g.addEventListener) {
      /* An older page with no lookBy: its mousemove handler turns the player
         itself. Take the movement on the window, before it reaches that
         handler on the document, while the showcase is up. */
      g.addEventListener('mousemove', function (e) {
        if (!SHOW.active) return;
        e.stopImmediatePropagation();
        try { showcaseOrbit(e.movementX, e.movementY); } catch (err) { panic(err, 'orbit'); }
      }, true);
    }
    if (g.addEventListener) g.addEventListener('wheel', function (e) { try { showcaseWheel(e); } catch (err) { panic(err, 'wheel'); } }, { capture: true, passive: false });
  }

  var _sqA = null, _sqB = null, _smm = null, _sup = null, _stg = null;
  function showcaseCamera(c, dt) {
    var P = G.player, MU = G.M, tall = heroTall(), H = HERO;
    if (!_sqA) { _sqA = new THREE.Quaternion(); _sqB = new THREE.Quaternion(); _smm = new THREE.Matrix4(); _sup = new THREE.Vector3(0, 1, 0); _stg = new THREE.Vector3(); }
    var e = sstep(SHOW.k), z = sstep(clamp(SHOW.zoom, 0, 1));
    var footY = P.y - fin(P.stepSm), eyeW = footY + fin(P.eyeH, G.EYE) * tall;
    var proneK = H ? fin(H.st.proneK) : 0;
    /* what the lens looks at: the middle of him, rising to his eyes */
    var tx = P.x, tz = P.z, ty = lerp(footY + 0.55 * (eyeW - footY), eyeW + 0.012 * MU * tall, z);
    /* how far: the whole of him in a 40 degree frame with a margin, closing to
       a head-and-shoulders at 30 degrees -- on a log scale, so every notch of
       the wheel is the same step to the eye */
    var extent = Math.max((eyeW - footY) * 1.09, proneK * 1.75 * tall * MU);
    var fovFull = 40, fovFace = 30;
    var dFull = extent * 1.24 / (2 * Math.tan(fovFull * PI / 360)), dFace = 0.72 * MU * tall;
    var d = dFull * Math.pow(dFace / dFull, z), fov = lerp(fovFull, fovFace, z);
    var el = clamp(lerp(0.10, 0.02, z) + SHOW.el, -0.40, 1.10);

    /* the figure's own frame: he faces his yaw */
    var yaw = P.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    /* where the game's camera is now, as an angle round him (0 dead ahead, +
       toward his right), a distance out and a height; the swing runs from
       there, round his right side, to the showcase */
    var ax = c.position.x - tx, az = c.position.z - tz, rA = Math.sqrt(ax * ax + az * az);
    var phA = rA > 0.30 * MU ? Math.atan2(ax * rx + az * rz, ax * fx + az * fz) : PI;
    var phB = SHOW.az, dph = angWrap(phB - phA);
    var ph = phA + dph * e;
    var rB = d * Math.cos(el), yB = ty + d * Math.sin(el);
    var r = lerp(rA, rB, e), y = lerp(c.position.y, yB, e);
    var hx = fx * Math.cos(ph) + rx * Math.sin(ph), hz = fz * Math.cos(ph) + rz * Math.sin(ph);
    var px = tx + hx * r, pz = tz + hz * r;

    /* the walls: the same swept box the boom uses, out from the middle of him */
    var dx = px - tx, dy = y - ty, dz = pz - tz, L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L > 1e-4) {
      var fr = sweep(tx, ty, tz, px, y, pz, hz, -hx), allowed = L;
      if (fr < 1) allowed = Math.max(0.30 * MU * tall, L * fr - CAMT.margin);
      /* in at once, out gently, like the boom */
      SHOW.rad = (SHOW.rad < 0 || allowed < SHOW.rad) ? allowed : Math.min(allowed, damp(SHOW.rad, allowed, 0.01, dt) + dt * 0.8 * MU);
      var kk = Math.min(1, SHOW.rad / L);
      px = tx + dx * kk; y = ty + dy * kk; pz = tz + dz * kk;
    }

    _sqA.copy(c.quaternion);
    c.position.set(px, y, pz);
    _stg.set(tx, ty, tz);
    _smm.lookAt(c.position, _stg, _sup);
    _sqB.setFromRotationMatrix(_smm);
    c.quaternion.copy(_sqA).slerp(_sqB, e);
    var f = lerp(c.fov, fov, e);
    if (Math.abs(c.fov - f) > 0.01) { c.fov = f; c.updateProjectionMatrix(); }
    var sky = skyOf();
    if (sky) sky.position.copy(c.position);
  }

  /* ---- the two corrections a chase camera owes a shooter ------------------ */
  NZ.on('aimDir', function (org, dir) {
    if (DEAD || !NZ.flags.hero || VIEW.blend < 0.5 || !cam.init || SHOW.active) return undefined;
    try {
      /* The game has just put the camera back at the eye for this tick, so the
         aim angles are this frame's. The boom is last frame's -- which is the
         picture the player was looking at when he pulled the trigger. */
      var c = NZ.ctx.camera, P = G.player;
      var yaw = c.rotation.y;
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      var fx = dir.x, fy = dir.y, fz = dir.z;
      var lx = P.x + rx * cam.side - fx * cam.boom;
      var ly = cam.pivotY + cam.up - fy * cam.boom;
      var lz = P.z + rz * cam.side - fz * cam.boom;
      var W = G.WPN[P.weapon] || {};
      solveAim(lx, ly, lz, fx, fy, fz, org.x, org.y, org.z, Math.max(60, fin(W.range, 300)));
      var dx = cam.ax - org.x, dy = cam.ay - org.y, dz = cam.az - org.z;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(len > 0.6)) return undefined;
      dx /= len; dy /= len; dz /= len;
      /* Pressed against cover the covered point can be beside the muzzle or
         behind it. A round does not leave sideways: past ~60 degrees off the
         aim the correction is dropped and the shot goes where the gun points. */
      if (dx * fx + dy * fy + dz * fz < 0.5) return undefined;
      if (!_aimOut) _aimOut = new THREE.Vector3();
      return _aimOut.set(dx, dy, dz);
    } catch (err) { panic(err, 'aimDir'); return undefined; }
  });

  NZ.on('tracerFrom', function () {
    if (DEAD || !NZ.flags.hero || VIEW.blend < 0.5 || !HERO || !HERO.muzzleOK || !cam.aimOK || SHOW.active) return undefined;
    try {
      var m = HERO.muzzleW;
      var dx = cam.ax - m.x, dy = cam.ay - m.y, dz = cam.az - m.z;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(len > 1)) return undefined;
      return { x: m.x, y: m.y, z: m.z, dx: dx / len, dy: dy / len, dz: dz / len };
    } catch (err) { panic(err, 'tracerFrom'); return undefined; }
  });

  /* =========================================================================
     5. SKELETON
     Model space is the camera's own convention: metres, +Y up, -Z forward,
     +X to the figure's right. That is deliberate -- nz-weapons authors every
     gun with the muzzle down -Z and the origin on the firing hand, so a
     weapon drops into this space with no axis juggling at all.

     Every bone is bound with an IDENTITY rotation: in the bind pose each
     bone's axes are the model's axes, the inverse bind matrix is a pure
     translation, and a pose is "the world rotation this bone should have"
     with no bind term to remember. The arms are bound in an A-pose only
     because that is where the sleeve geometry is easiest to loft.
     ====================================================================== */
  var SK = { name: [], parent: [], pos: [], idx: {} };
  var LEN = { upper: 0.300, fore: 0.262, thigh: 0.440, shin: 0.420 };
  var A_POSE = 0.55;                       /* arm abduction in the bind, rad */

  function defineSkeleton() {
    var sh = 0.186 * LOOK.build.shoulders;
    function add(name, parent, x, y, z) {
      SK.idx[name] = SK.name.length;
      SK.name.push(name);
      SK.parent.push(parent === null ? -1 : SK.idx[parent]);
      SK.pos.push([x, y, z]);
    }
    add('hips', null, 0, 0.965, 0.008);
    add('spine', 'hips', 0, 1.085, 0.012);
    add('chest', 'spine', 0, 1.245, 0.016);
    add('neck', 'chest', 0, 1.525, 0.022);
    add('head', 'neck', 0, 1.625, 0.006);
    for (var s = 0; s < 2; s++) {
      var sg = s ? -1 : 1, S = s ? 'L' : 'R';
      var dx = sg * Math.sin(A_POSE), dy = -Math.cos(A_POSE);
      var sx = sg * sh, sy = 1.475, sz = 0.012;
      add('clav' + S, 'chest', sg * 0.030, 1.470, 0.010);
      add('arm' + S, 'clav' + S, sx, sy, sz);
      add('fore' + S, 'arm' + S, sx + dx * LEN.upper, sy + dy * LEN.upper, sz);
      add('hand' + S, 'fore' + S, sx + dx * (LEN.upper + LEN.fore), sy + dy * (LEN.upper + LEN.fore), sz);
      add('thigh' + S, 'hips', sg * 0.092, 0.945, 0.004);
      add('shin' + S, 'thigh' + S, sg * 0.092, 0.945 - LEN.thigh, 0.004);
      add('foot' + S, 'shin' + S, sg * 0.092, 0.945 - LEN.thigh - LEN.shin, 0.004);
      add('toe' + S, 'foot' + S, sg * 0.092, 0.022, -0.122);
    }
  }
  function bi(name) { return SK.idx[name]; }
  function bp(name) { return SK.pos[SK.idx[name]]; }

  /* =========================================================================
     6. GEOMETRY
     One merged, skinned buffer. Everything is a lofted tube: a list of rings,
     each an ellipse (or superellipse) in its own plane, stitched in order.
     Skin weights are AUTHORED per ring rather than solved from distance --
     the builder knows which joint a ring belongs to, so an elbow blends
     exactly two bones over exactly the span it was told to.
     ====================================================================== */
  function Pile() {
    this.p = []; this.uv = []; this.c = []; this.bi = []; this.bw = []; this.ix = []; this.n = 0;
  }
  /* w = [boneIndex, weight, boneIndex, weight, ...], at most four pairs */
  Pile.prototype.vert = function (x, y, z, u, v, shade, w) {
    this.p.push(x, y, z); this.uv.push(u, v); this.c.push(shade, shade, shade);
    var n = Math.min(4, w.length >> 1), tot = 0, k;
    for (k = 0; k < n; k++) tot += w[k * 2 + 1];
    if (!(tot > 0)) tot = 1;
    for (k = 0; k < 4; k++) {
      this.bi.push(k < n ? w[k * 2] : 0);
      this.bw.push(k < n ? w[k * 2 + 1] / tot : 0);
    }
    return this.n++;
  };
  Pile.prototype.tri = function (a, b, c) { this.ix.push(a, b, c); };

  function W1(a) { return [bi(a), 1]; }
  function W2(a, b, t) { t = clamp(t, 0, 1); return t <= 0 ? [bi(a), 1] : t >= 1 ? [bi(b), 1] : [bi(a), 1 - t, bi(b), t]; }

  /* Atlas tiles. Pixel rects on a 1024 sheet (canvas y runs down); the UV rect
     is derived, with v = 0 at the BOTTOM of the tile. */
  var ATLAS = 1024;
  var TILE_PAD = 3;   /* texels the UV rect is inset by, so mips never reach the neighbour */
  function tile(x, y, w, h) {
    var q = TILE_PAD;
    return {
      px: x, py: y, pw: w, ph: h,
      x: (x + q) / ATLAS, y: 1 - (y + h - q) / ATLAS, w: (w - 2 * q) / ATLAS, h: (h - 2 * q) / ATLAS,
      /* tile-local (u, v) -> canvas pixels, the inverse of the UV mapping */
      X: function (u) { return x + q + u * (w - 2 * q); },
      Y: function (v) { return y + h - q - v * (h - 2 * q); },
      W: function (du) { return du * (w - 2 * q); },
      H: function (dv) { return dv * (h - 2 * q); }
    };
  }
  var TILES = {
    torso: tile(0, 0, 512, 448),      /* u: right 0 / back .25 / left .5 / front .75   v: crotch -> neck */
    sleeve: tile(512, 0, 224, 448),   /* u: inner 0 / back .25 / outer .5 / front .75  v: wrist -> shoulder */
    leg: tile(736, 0, 288, 576),      /* u: inner 0 / back .25 / outer .5 / front .75  v: ankle -> hip */
    head: tile(0, 448, 448, 384),     /* u: back 0 / right .25 / face .5 / left .75    v: chin -> crown */
    hair: tile(448, 448, 288, 256),
    shoe: tile(448, 704, 288, 192),   /* u: top 0 / side .25 / sole .5 / side .75      v: heel -> toe */
    skin: tile(736, 576, 144, 128),
    trim: tile(880, 576, 144, 64),
    under: tile(880, 640, 144, 64)
  };

  /* rings: [{ c:[x,y,z], a:[..], b:[..], ra, rb, n, v, w, s, f }]
       c      centre                a, b   unit axes spanning the ring
       ra,rb  radii along a and b   n      superellipse exponent (2 = ellipse)
       v      texture v, 0..1       w      skin weights      s  shade (baked AO)
       f      optional fn(theta, u) -> radius multiplier
     Angle 0 is +a, PI/2 is +b; u runs 0..1 with it. */
  function tube(pile, rings, seg, reg, opt) {
    opt = opt || {};
    var th0 = opt.th0 || 0, u0 = opt.u0 === undefined ? 0 : opt.u0, u1 = opt.u1 === undefined ? 1 : opt.u1;
    var start = pile.n, k, j, R;
    for (k = 0; k < rings.length; k++) {
      R = rings[k];
      var n = R.n || 2, e = 2 / n;
      for (j = 0; j <= seg; j++) {
        var t = j / seg, th = th0 + t * TAU, ct = Math.cos(th), st = Math.sin(th);
        if (n !== 2) {
          ct = (ct < 0 ? -1 : 1) * Math.pow(Math.abs(ct), e);
          st = (st < 0 ? -1 : 1) * Math.pow(Math.abs(st), e);
        }
        var m = R.f ? R.f(th, t) : 1;
        var ka = R.ra * m * ct, kb = R.rb * m * st;
        pile.vert(
          R.c[0] + R.a[0] * ka + R.b[0] * kb,
          R.c[1] + R.a[1] * ka + R.b[1] * kb,
          R.c[2] + R.a[2] * ka + R.b[2] * kb,
          reg.x + (u0 + (u1 - u0) * t) * reg.w, reg.y + clamp(R.v, 0, 1) * reg.h,
          R.s === undefined ? 1 : R.s, R.w);
      }
    }
    /* winding: outward when the rings advance along a x b, flipped otherwise */
    var A = rings[0], B = rings[rings.length - 1];
    var nx = A.a[1] * A.b[2] - A.a[2] * A.b[1], ny = A.a[2] * A.b[0] - A.a[0] * A.b[2], nz = A.a[0] * A.b[1] - A.a[1] * A.b[0];
    var fwd = (nx * (B.c[0] - A.c[0]) + ny * (B.c[1] - A.c[1]) + nz * (B.c[2] - A.c[2])) >= 0;
    if (opt.flip) fwd = !fwd;
    var row = seg + 1;
    for (k = 0; k < rings.length - 1; k++) for (j = 0; j < seg; j++) {
      var a = start + k * row + j, b = a + 1, c = a + row, d = c + 1;
      if (fwd) { pile.tri(a, b, c); pile.tri(b, d, c); }
      else { pile.tri(a, c, b); pile.tri(b, c, d); }
    }
    function cap(ringIx, outward) {
      var Rc = rings[ringIx];
      var ci = pile.vert(Rc.c[0], Rc.c[1], Rc.c[2], reg.x + (u0 + u1) * 0.5 * reg.w, reg.y + clamp(Rc.v, 0, 1) * reg.h,
        Rc.s === undefined ? 1 : Rc.s, Rc.w);
      var base = start + ringIx * row;
      for (var q = 0; q < seg; q++) {
        if (outward) pile.tri(ci, base + q + 1, base + q); else pile.tri(ci, base + q, base + q + 1);
      }
    }
    if (opt.capStart) cap(0, fwd);
    if (opt.capEnd) cap(rings.length - 1, !fwd);
    return start;
  }

  /* A tube along a polyline, ring planes carried by parallel transport. */
  function pathTube(pile, pts, radii, seg, reg, w, opt) {
    opt = opt || {};
    var rings = [], i, n = pts.length;
    var ax = opt.up || [1, 0, 0], prevA = null;
    for (i = 0; i < n; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(n - 1, i + 1)];
      var tx = p1[0] - p0[0], ty = p1[1] - p0[1], tz = p1[2] - p0[2];
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      var a = prevA || ax;
      /* a := a minus its component along the tangent */
      var d = a[0] * tx + a[1] * ty + a[2] * tz;
      var a0 = a[0] - tx * d, a1 = a[1] - ty * d, a2 = a[2] - tz * d;
      var al = Math.sqrt(a0 * a0 + a1 * a1 + a2 * a2) || 1; a0 /= al; a1 /= al; a2 /= al;
      /* b = t x a, so a x b = t and the tube advances along its own normal */
      var b0 = ty * a2 - tz * a1, b1 = tz * a0 - tx * a2, b2 = tx * a1 - ty * a0;
      prevA = [a0, a1, a2];
      var r = radii[i];
      rings.push({
        c: pts[i], a: prevA, b: [b0, b1, b2], ra: Array.isArray(r) ? r[0] : r, rb: Array.isArray(r) ? r[1] : r,
        v: opt.v ? opt.v[i] : i / (n - 1), w: w, s: opt.s ? opt.s[i] : 1
      });
    }
    return tube(pile, rings, seg, reg, { capStart: opt.capStart, capEnd: opt.capEnd, u0: opt.u0, u1: opt.u1 });
  }

  /* An ellipsoid, as a stack of rings about the +Y of its own frame. */
  function blob(pile, c, rx, ry, rz, seg, rows, reg, w, opt) {
    opt = opt || {};
    var rings = [], i;
    var ax = opt.a || [1, 0, 0], bx = opt.b || [0, 0, 1], up = opt.up || [0, 1, 0];
    for (i = 0; i <= rows; i++) {
      var t = i / rows, ph = -PI / 2 + t * PI, cr = Math.max(0.02, Math.cos(ph)), sr = Math.sin(ph);
      rings.push({
        c: [c[0] + up[0] * ry * sr, c[1] + up[1] * ry * sr, c[2] + up[2] * ry * sr],
        a: ax, b: bx, ra: rx * cr, rb: rz * cr, v: opt.v0 === undefined ? t : lerp(opt.v0, opt.v1, t),
        w: w, s: opt.s === undefined ? 1 : opt.s
      });
    }
    return tube(pile, rings, seg, reg, { capStart: true, capEnd: true, u0: opt.u0, u1: opt.u1 });
  }

  /* Smooth normals, then welded across coincident vertices so the UV seam
     down the inside of every tube does not show as a lighting crease. */
  function pileToGeometry(pile) {
    var n = pile.n, p = pile.p, ix = pile.ix, i;
    var nor = new Float32Array(n * 3);
    for (i = 0; i < ix.length; i += 3) {
      var a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      var e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      var e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
      nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
      nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
    }
    var map = Object.create(null), key, grp;
    for (i = 0; i < n; i++) {
      key = Math.round(p[i * 3] * 4000) + '_' + Math.round(p[i * 3 + 1] * 4000) + '_' + Math.round(p[i * 3 + 2] * 4000);
      (map[key] || (map[key] = [])).push(i);
    }
    for (key in map) {
      grp = map[key];
      if (grp.length < 2) continue;
      var sx = 0, sy = 0, sz = 0, q;
      for (q = 0; q < grp.length; q++) { sx += nor[grp[q] * 3]; sy += nor[grp[q] * 3 + 1]; sz += nor[grp[q] * 3 + 2]; }
      for (q = 0; q < grp.length; q++) { nor[grp[q] * 3] = sx; nor[grp[q] * 3 + 1] = sy; nor[grp[q] * 3 + 2] = sz; }
    }
    for (i = 0; i < n; i++) {
      var l = Math.sqrt(nor[i * 3] * nor[i * 3] + nor[i * 3 + 1] * nor[i * 3 + 1] + nor[i * 3 + 2] * nor[i * 3 + 2]) || 1;
      nor[i * 3] /= l; nor[i * 3 + 1] /= l; nor[i * 3 + 2] /= l;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pile.p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(pile.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(pile.c, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(pile.bi, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(pile.bw, 4));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(ix, 1) : new THREE.Uint16BufferAttribute(ix, 1));
    g.computeBoundingSphere();
    return g;
  }

  /* Catmull-Rom through a table of rows [x, v1, v2, ...]; returns the row at x. */
  function sampleRows(rows, x) {
    var n = rows.length, i = 0;
    if (x <= rows[0][0]) return rows[0].slice();
    if (x >= rows[n - 1][0]) return rows[n - 1].slice();
    while (i < n - 2 && rows[i + 1][0] < x) i++;
    var r0 = rows[Math.max(0, i - 1)], r1 = rows[i], r2 = rows[i + 1], r3 = rows[Math.min(n - 1, i + 2)];
    var t = (x - r1[0]) / (r2[0] - r1[0]), t2 = t * t, t3 = t2 * t, out = [x];
    for (var k = 1; k < r1.length; k++) {
      /* tangents scaled by the real knot spacing, so uneven rows do not kink */
      var m1 = (r2[k] - r0[k]) / Math.max(1e-6, r2[0] - r0[0]) * (r2[0] - r1[0]);
      var m2 = (r3[k] - r1[k]) / Math.max(1e-6, r3[0] - r1[0]) * (r2[0] - r1[0]);
      out.push((2 * t3 - 3 * t2 + 1) * r1[k] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * r2[k] + (t3 - t2) * m2);
    }
    return out;
  }

  var X = [1, 0, 0], NX = [-1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

  /* ---- top garment parameters, from LOOK ---------------------------------- */
  function topSpec() {
    var t = LOOK.top || {}, ty = t.type || 'jacket';
    var sw = ty === 'sweater';
    var s = {
      type: ty,
      thick: ty === 'jacket' ? 0.013 : ty === 'hoodie' ? 0.015 : sw ? 0.015 : ty === 'shirt' ? 0.006 : 0.004,
      hem: ty === 'jacket' ? 0.990 : ty === 'hoodie' ? 0.972 : sw ? 0.948 : ty === 'shirt' ? 0.965 : 0.985,
      flare: ty === 'jacket' ? 0.010 : ty === 'hoodie' ? 0.012 : sw ? 0.003 : 0.006,
      long: (t.sleeves || (ty === 'tshirt' ? 'short' : 'long')) === 'long',
      hood: !!t.hood || ty === 'hoodie',
      collar: ty === 'jacket' || ty === 'shirt',
      band: ty === 'jacket' || ty === 'hoodie' || sw,
      /* a sweatshirt: cut loose and square, gathered by a rib band at the hem
         and at each wrist, with a rib crew neck lying on the collarbones */
      boxy: sw ? clamp(fin(t.loose, 0.8), 0, 1) : 0,
      gather: sw,
      crew: sw
    };
    return s;
  }
  var TV = { y0: 0.800, y1: 1.552 };                         /* torso tile v span */
  function tv(y) { return (y - TV.y0) / (TV.y1 - TV.y0); }

  function buildTorso(pile) {
    var bk = LOOK.build.bulk, shW = LOOK.build.shoulders, T = topSpec();
    /*        y      rx     rz     cz     n */
    var rows = [
      [0.800, 0.060, 0.070, 0.012, 2.0],
      [0.835, 0.135, 0.105, 0.016, 2.3],
      [0.875, 0.176, 0.131, 0.026, 2.4],
      [0.930, 0.186, 0.138, 0.028, 2.4],
      [0.990, 0.178, 0.124, 0.018, 2.4],
      [1.045, 0.160, 0.110, 0.011, 2.4],
      [1.100, 0.152, 0.104, 0.009, 2.3],
      [1.160, 0.156, 0.108, 0.009, 2.3],
      [1.230, 0.166, 0.116, 0.011, 2.4],
      [1.310, 0.180, 0.128, 0.012, 2.5],
      [1.380, 0.190, 0.133, 0.012, 2.5],
      [1.435, 0.200, 0.127, 0.014, 2.4],
      [1.475, 0.198, 0.110, 0.018, 2.3],
      [1.505, 0.150, 0.088, 0.022, 2.0],
      [1.530, 0.078, 0.066, 0.024, 2.0],
      [1.550, 0.062, 0.060, 0.024, 2.0]
    ];
    function wAt(y) {
      if (y <= 1.00) return W1('hips');
      if (y <= 1.10) return W2('hips', 'spine', (y - 1.00) / 0.10);
      if (y <= 1.16) return W1('spine');
      if (y <= 1.29) return W2('spine', 'chest', (y - 1.16) / 0.13);
      if (y <= 1.500) return W1('chest');
      return W2('chest', 'neck', (y - 1.500) / 0.06);
    }
    /* a loose garment hangs from the chest instead of following the waist in */
    var rc = sampleRows(rows, 1.36), boxA = rc[1] * bk + T.thick, boxB = rc[2] * bk + T.thick;
    function ring(y, extra, shade, vy) {
      var r = sampleRows(rows, y);
      var girth = y > 1.40 ? lerp(bk, 1, 0.5) * lerp(1, shW, band(y, 1.38, 1.47)) : bk;
      var ra = r[1] * girth + extra, rb = r[2] * bk + extra;
      if (T.boxy > 0 && extra > 0.002 && y < 1.36) {
        /* free above the hem band, which pulls it back in to the hips */
        var kb = T.boxy * band(y, T.hem + 0.012, T.hem + 0.085);
        ra = lerp(ra, Math.max(ra, boxA * 0.955), kb); rb = lerp(rb, Math.max(rb, boxB * 0.93), kb);
      }
      return {
        c: [0, y, r[3]], a: X, b: Z, ra: ra, rb: rb, n: r[4],
        v: tv(vy === undefined ? y : vy), w: wAt(y), s: shade === undefined ? 1 : shade
      };
    }
    var ys = [0.800, 0.818, 0.835, 0.855, 0.875, 0.902, 0.930, 0.958];
    var rings = [], i;
    for (i = 0; i < ys.length; i++) {
      if (ys[i] > T.hem - 0.024) continue;
      rings.push(ring(ys[i], 0, ys[i] < 0.83 ? 0.62 : ys[i] < 0.86 ? 0.82 : 1));
    }
    /* the garment's hem: the trousers carry on up underneath it, then a dark
       ledge, then the lip of the cloth hanging a few millimetres proud */
    var hem = T.hem;
    rings.push(ring(hem - 0.014, 0, 0.92));
    rings.push(ring(hem + 0.004, 0.001, 0.42, hem - 0.004));
    rings.push(ring(hem - 0.004, T.thick + T.flare, 0.86));
    rings.push(ring(hem + 0.018, T.thick + T.flare * 0.7, 0.97));
    var up = [1.030, 1.065, 1.100, 1.130, 1.160, 1.195, 1.230, 1.270, 1.310, 1.345, 1.380, 1.410, 1.435, 1.458, 1.475, 1.492, 1.505, 1.519, 1.530, 1.541, 1.550];
    for (i = 0; i < up.length; i++) {
      if (up[i] <= hem + 0.02) continue;
      rings.push(ring(up[i], T.thick * (up[i] > 1.50 ? lerp(1, 0.35, band(up[i], 1.50, 1.55)) : 1),
        up[i] > 1.535 ? 0.80 : 1));
    }
    if (T.crew) {
      /* a crew neck shows the base of the neck inside it, so the top of the
         trunk has to BE there: carry it in onto the neck and close it. What
         is cloth and what is skin up here is the atlas's business. */
      var nr = 0.055 * lerp(1, bk, 0.5) * fin(LOOK.build.neck, 1);
      rings.push({ c: [0, 1.558, 0.024], a: X, b: Z, ra: nr + 0.006, rb: nr * 1.04 + 0.006, n: 2.0, v: 1, w: W2('chest', 'neck', 0.9), s: 0.86 });
      rings.push({ c: [0, 1.566, 0.022], a: X, b: Z, ra: nr - 0.003, rb: nr * 1.04 - 0.003, n: 2.0, v: 1, w: W1('neck'), s: 0.80 });
    }
    tube(pile, rings, 28, TILES.torso, { capStart: true });
    return T;
  }

  function buildNeck(pile) {
    var rows = [[1.520, 0.058, 0.026], [1.548, 0.055, 0.023], [1.580, 0.054, 0.018], [1.612, 0.055, 0.012], [1.640, 0.058, 0.008]];
    var rings = [], nk = fin(LOOK.build.neck, 1), fit = !!LOOK.head;
    /* a fitted head has a real jaw, narrower than the neck it sits on: the
       neck then has to run on up inside the skull, and it stands in the
       jaw's shadow */
    if (fit) rows.push([1.668, 0.057, 0.008]);
    for (var i = 0; i < rows.length; i++) {
      var y = rows[i][0];
      rings.push({
        c: [0, y, rows[i][2]], a: X, b: Z, ra: rows[i][1] * lerp(1, LOOK.build.bulk, 0.5) * nk,
        rb: rows[i][1] * 1.04 * nk,
        v: i / (rows.length - 1), s: i === 0 ? 0.78 : fit ? lerp(0.90, 0.56, band(y, 1.560, 1.615)) : y > 1.60 ? 0.82 : 0.94,
        w: y < 1.535 ? W2('chest', 'neck', 0.6) : y < 1.60 ? W1('neck') : W2('neck', 'head', clamp((y - 1.60) / 0.04, 0, 1))
      });
    }
    tube(pile, rings, 16, TILES.skin);
  }

  function buildCollar(pile, T) {
    if (!T.collar) return;
    /* a stand collar: a short flared band round the base of the neck */
    var rows = [[1.512, 0.074, 0.070, 0.9], [1.540, 0.073, 0.069, 1], [1.572, 0.077, 0.072, 1], [1.578, 0.070, 0.066, 0.55], [1.545, 0.064, 0.061, 0.4]];
    var rings = [];
    for (var i = 0; i < rows.length; i++) rings.push({
      c: [0, rows[i][0], 0.024], a: X, b: Z, ra: rows[i][1], rb: rows[i][2], v: clamp(i / 3, 0, 1) * 0.9 + 0.05,
      s: rows[i][3], w: W2('chest', 'neck', 0.5)
    });
    tube(pile, rings, 20, TILES.trim, { flip: false });
  }

  function buildHood(pile, T) {
    if (!T.hood) return;
    /* a hood lying on the upper back: a flattened pouch behind the neck */
    blob(pile, [0, 1.492, 0.094], 0.118, 0.074, 0.050, 16, 8, TILES.torso, W2('chest', 'neck', 0.25),
      { a: X, b: [0, 0.34, 0.94], up: [0, 0.94, -0.34], u0: 0.10, u1: 0.40, v0: tv(1.30), v1: tv(1.44), s: 0.93 });
  }

  /* One arm. sg = +1 right, -1 left. u: inner 0 / back .25 / outer .5 / front .75 */
  function buildArm(pile, sg, T) {
    var S = sg > 0 ? 'R' : 'L', lr = lerp(1, LOOK.build.bulk, 0.7);
    var sh = bp('arm' + S);
    var d = [sg * Math.sin(A_POSE), -Math.cos(A_POSE), 0];
    var inner = [-sg * Math.cos(A_POSE), -Math.sin(A_POSE), 0];   /* toward the body */
    var tot = LEN.upper + LEN.fore;
    var cut = T.long ? 9 : 0.165;                                  /* sleeve ends here (m from shoulder) */
    /*        s       r      weights */
    var rows = [
      [-0.060, 0.012], [-0.054, 0.030], [-0.041, 0.045], [-0.021, 0.055], [0.006, 0.060], [0.040, 0.061],
      [0.080, 0.060], [0.130, 0.057], [0.190, 0.053],
      [0.240, 0.049], [0.272, 0.047], [0.300, 0.0465], [0.328, 0.049], [0.365, 0.051], [0.420, 0.048],
      [0.475, 0.041], [0.520, 0.036], [0.548, 0.033], [0.562, 0.032]
    ];
    /* The top of the sleeve is a closed ball on the shoulder joint, bound to
       the arm alone. A raised arm then turns INSIDE the shoulder of the
       jacket instead of dragging a ring of chest-weighted cloth up with it. */
    function wAt(s) {
      if (s < 0.255) return W1('arm' + S);
      if (s < 0.345) return W2('arm' + S, 'fore' + S, (s - 0.255) / 0.09);
      return W1('fore' + S);
    }
    function ringAt(s, r, shade, vs, reg) {
      return {
        c: [sh[0] + d[0] * s, sh[1] + d[1] * s, sh[2] + d[2] * s], a: inner, b: Z,
        ra: r * 0.96, rb: r * (s < 0.30 ? 1.07 : lerp(1.07, 0.98, band(s, 0.30, 0.50))),
        v: 1 - clamp(((vs === undefined ? s : vs) + 0.05) / (tot + 0.05), 0, 0.985), w: wAt(s), s: shade
      };
    }
    var cloth = [], skin = [], i, s, r;
    for (i = 0; i < rows.length; i++) {
      s = rows[i][0]; r = rows[i][1] * lr;
      if (s <= cut) {
        /* a gathered sleeve is full down the forearm and pulled in by its cuff */
        var gk = T.gather ? lerp(1.12, 0.42, band(s, tot - 0.075, tot - 0.022)) * lerp(1, 1.15, band(s, 0.10, 0.36)) : 1;
        cloth.push(ringAt(s, r + T.thick * 0.85 * gk * band(s, -0.07, -0.03), s < -0.03 ? 0.8 : 1));
      } else skin.push(ringAt(s, r, 1));
    }
    if (T.long) {
      /* cuff: a band standing proud of the wrist, then the dark mouth of the sleeve */
      cloth.push(ringAt(tot + 0.004, 0.038 * lr + T.thick * (T.gather ? 0.30 : 0.5), 0.9));
      cloth.push(ringAt(tot + 0.002, 0.028 * lr, 0.38, tot));
    } else {
      cloth.push(ringAt(cut + 0.012, sampleRows(rows, cut + 0.012)[1] * lr + T.thick + 0.004, 0.9));
      cloth.push(ringAt(cut + 0.008, sampleRows(rows, cut)[1] * lr, 0.4, cut));
      skin.unshift(ringAt(cut - 0.02, sampleRows(rows, cut - 0.02)[1] * lr, 0.6));
    }
    tube(pile, cloth, 14, TILES.sleeve, { th0: 0, capStart: true });
    if (skin.length > 1) {
      for (i = 0; i < skin.length; i++) skin[i].v = i / (skin.length - 1);
      tube(pile, skin, 12, TILES.skin, { th0: 0 });
    }
  }

  /* One leg. u: inner 0 / back .25 / outer .5 / front .75 */
  function buildLeg(pile, sg) {
    var S = sg > 0 ? 'R' : 'L', lr = LOOK.build.bulk;
    var hx = sg * 0.092, inner = sg > 0 ? NX : X;
    var shorts = (LOOK.bottom.length || 'long') !== 'long' || LOOK.bottom.type === 'shorts';
    var cutY = shorts ? 0.545 : -1;
    /* tracksuit bottoms: soft and full in the leg, gathered at the ankle */
    var track = LOOK.bottom.type === 'track', ease = track ? 0.013 : 0.004;
    /*        y      ra     rb     cz      shade */
    var rows = [
      [0.950, 0.092, 0.110, 0.016], [0.900, 0.096, 0.113, 0.016], [0.840, 0.096, 0.110, 0.013],
      [0.780, 0.093, 0.105, 0.009], [0.710, 0.088, 0.097, 0.005], [0.640, 0.081, 0.088, 0.003],
      [0.575, 0.073, 0.079, 0.002], [0.535, 0.068, 0.073, 0.000], [0.505, 0.066, 0.071, -0.003],
      [0.475, 0.064, 0.069, 0.001], [0.440, 0.063, 0.070, 0.007], [0.385, 0.064, 0.075, 0.016],
      [0.320, 0.060, 0.068, 0.014], [0.250, 0.055, 0.059, 0.009], [0.180, 0.051, 0.054, 0.005],
      [0.120, 0.050, 0.053, 0.004]
    ];
    function wAt(y) {
      if (y > 0.93) return [bi('hips'), 0.55, bi('thigh' + S), 0.45];
      if (y > 0.86) return W2('hips', 'thigh' + S, 1 - (y - 0.86) / 0.07 * 0.45);
      if (y > 0.565) return W1('thigh' + S);
      if (y > 0.445) return W2('thigh' + S, 'shin' + S, (0.565 - y) / 0.12);
      return W1('shin' + S);
    }
    function ringAt(y, ra, rb, cz, shade, vy) {
      return {
        c: [hx, y, 0.004 + cz], a: inner, b: Z, ra: ra, rb: rb, n: 2.15,
        v: clamp(((vy === undefined ? y : vy) - 0.085) / (0.950 - 0.085), 0, 1), w: wAt(y), s: shade
      };
    }
    var cloth = [], skin = [], i, y;
    for (i = 0; i < rows.length; i++) {
      y = rows[i][0];
      if (y >= cutY) {
        var ez = track ? ease * lerp(1, 1.25, band(y, 0.16, 0.34)) * lerp(0.75, 1, band(y, 0.95, 0.80)) : ease;
        cloth.push(ringAt(y, rows[i][1] * lr + ez, rows[i][2] * lr + ez, rows[i][3], y > 0.90 ? 0.8 : 1));
      } else skin.push(ringAt(y, rows[i][1] * lr - 0.004, rows[i][2] * lr - 0.004, rows[i][3], 1));
    }
    if (!shorts && track) {
      /* the cuff: a rib band tight on the ankle, the leg blousing over it */
      cloth.push(ringAt(0.118, 0.046 * lerp(1, lr, 0.5), 0.049 * lerp(1, lr, 0.5), 0.004, 0.96));
      cloth.push(ringAt(0.092, 0.044 * lerp(1, lr, 0.5), 0.047 * lerp(1, lr, 0.5), 0.004, 0.92));
      cloth.push(ringAt(0.097, 0.034, 0.036, 0.004, 0.36, 0.088));
    } else if (!shorts) {
      cloth.push(ringAt(0.090, 0.053, 0.056, 0.004, 0.92));
      cloth.push(ringAt(0.097, 0.037, 0.039, 0.004, 0.36, 0.088));
    } else {
      var rc = sampleRows(rows, cutY - 0.012);
      cloth.push(ringAt(cutY - 0.012, rc[1] * lr + 0.010, rc[2] * lr + 0.010, rc[3], 0.9));
      cloth.push(ringAt(cutY - 0.006, rc[1] * lr - 0.004, rc[2] * lr - 0.004, rc[3], 0.4, cutY - 0.012));
      skin.unshift(ringAt(cutY + 0.02, rc[1] * lr - 0.004, rc[2] * lr - 0.004, rc[3], 0.6));
      skin.push(ringAt(0.100, 0.036, 0.038, 0.004, 0.9));
    }
    tube(pile, cloth, 16, TILES.leg);
    if (skin.length > 1) {
      for (i = 0; i < skin.length; i++) skin[i].v = i / (skin.length - 1);
      tube(pile, skin, 14, TILES.skin);
    }
  }

  /* One shoe. u: top 0 / side .25 / sole .5 / side .75   v: heel -> toe */
  function buildShoe(pile, sg) {
    var S = sg > 0 ? 'R' : 'L';
    var fx = sg * 0.092, boots = (LOOK.shoes.type || 'sneakers') === 'boots';
    /*        z       rx     ry     cy */
    var rows = [
      [0.092, 0.020, 0.024, 0.030], [0.084, 0.031, 0.036, 0.040], [0.066, 0.038, 0.047, 0.049],
      [0.038, 0.042, 0.055, 0.057], [0.006, 0.044, 0.059, 0.061], [-0.030, 0.045, 0.050, 0.052],
      [-0.070, 0.047, 0.040, 0.042], [-0.108, 0.050, 0.033, 0.035], [-0.140, 0.050, 0.029, 0.031],
      [-0.170, 0.046, 0.025, 0.027], [-0.192, 0.037, 0.020, 0.023], [-0.206, 0.022, 0.013, 0.018]
    ];
    var start = pile.n, rings = [], i;
    for (i = 0; i < rows.length; i++) {
      var z = rows[i][0], tall = boots && z > -0.02 ? 0.030 : 0;
      rings.push({
        c: [fx, rows[i][3] + tall * 0.5, z], a: Y, b: X, ra: rows[i][2] + tall * 0.5, rb: rows[i][1], n: 2.3,
        v: i / (rows.length - 1), s: 1,
        w: z > -0.085 ? W1('foot' + S) : z > -0.150 ? W2('foot' + S, 'toe' + S, (-0.085 - z) / 0.065) : W1('toe' + S)
      });
    }
    tube(pile, rings, 16, TILES.shoe, { capStart: true, capEnd: true });
    /* press the underside flat: a shoe stands on a plane, not on a keel */
    for (i = start; i < pile.n; i++) if (pile.p[i * 3 + 1] < 0.0135) pile.p[i * 3 + 1] = 0;
  }

  /* One hand, modelled in its own grip frame and bound rigidly to the hand
     bone: origin at the wrist, +Y toward the knuckles, +Z out of the palm,
     and the thumb on +X (right hand; the left is the mirror). The fingers
     are closed round a 40 mm cylinder lying across the palm, because the one
     thing this hand ever does on screen is hold a weapon. */
  function buildHand(pile, sg) {
    var S = sg > 0 ? 'R' : 'L', w = W1('hand' + S), o = bp('hand' + S);
    var reg = LOOK.gloves ? TILES.trim : TILES.skin;
    function P(x, y, z) { return [o[0] + sg * x, o[1] + y, o[2] + z]; }
    var ax = sg > 0 ? X : NX;
    var palm = [[-0.012, 0.026, 0.017], [0.012, 0.031, 0.0175], [0.045, 0.039, 0.0165], [0.078, 0.042, 0.0150], [0.096, 0.040, 0.0115]];
    var rings = [], i;
    for (i = 0; i < palm.length; i++) rings.push({
      c: P(0, palm[i][0], 0), a: ax, b: Z, ra: palm[i][1], rb: palm[i][2], n: 2.6, v: i / (palm.length - 1), w: w,
      s: 0.95
    });
    tube(pile, rings, 12, reg, { capStart: true, capEnd: true });
    var fx = [0.030, 0.0105, -0.0095, -0.0285], fl = [0.96, 1.0, 0.94, 0.78], fr = [0.0096, 0.0100, 0.0095, 0.0086];
    for (i = 0; i < 4; i++) {
      var L = fl[i], r = fr[i], x = fx[i];
      pathTube(pile, [
        P(x, 0.090, 0.002), P(x, 0.090 + 0.030 * L, 0.020 * L + 0.002), P(x, 0.090 + 0.038 * L, 0.046 * L),
        P(x, 0.090 + 0.022 * L, 0.062 * L), P(x, 0.090 + 0.006 * L, 0.060 * L)
      ], [r * 1.05, r, r * 0.95, r * 0.88, r * 0.70], 7, reg, w, { up: ax, capStart: true, capEnd: true, s: [0.9, 1, 1, 0.95, 0.9] });
    }
    pathTube(pile, [P(0.030, 0.022, 0.006), P(0.050, 0.050, 0.022), P(0.047, 0.076, 0.042), P(0.038, 0.092, 0.052)],
      [0.0135, 0.0120, 0.0105, 0.0080], 7, reg, w, { up: Z, capStart: true, capEnd: true });
  }

  /* ---- the head ------------------------------------------------------------
     A stack of superellipse rings read off a profile table (half-width, depth
     to the front, depth to the back, per height), with the features pushed out
     of the front as smooth bumps. Heights are relative to the eye line, which
     is at 1.71 m -- the game's own eye height, so the figure's eyes are where
     the first-person camera is.
       u: back 0 / right ear .25 / face .5 / left ear .75     v: chin -> crown */
  var HEAD = {
    eyeY: 1.710, cz: 0.004,
    n: 2.35,                    /* superellipse exponent of every ring */
    y0: -0.130, y1: 0.123,
    /*        hy      W      F      B */
    rows: [
      [-0.130, 0.034, 0.034, 0.040],
      [-0.120, 0.042, 0.070, 0.046],
      [-0.108, 0.049, 0.088, 0.052],
      [-0.092, 0.057, 0.095, 0.059],
      [-0.072, 0.064, 0.098, 0.069],
      [-0.050, 0.070, 0.099, 0.080],
      [-0.026, 0.074, 0.098, 0.090],
      [0.000, 0.076, 0.096, 0.097],
      [0.022, 0.077, 0.100, 0.101],
      [0.046, 0.077, 0.099, 0.104],
      [0.070, 0.074, 0.091, 0.103],
      [0.092, 0.066, 0.077, 0.094],
      [0.108, 0.052, 0.057, 0.076],
      [0.118, 0.033, 0.034, 0.049],
      [0.123, 0.012, 0.012, 0.018]
    ]
  };
  function gauss(x, c, s) { var d = (x - c) / s; return Math.exp(-d * d); }

  /* ---- fitting the head to a particular person ------------------------------
     Everything about this head -- the profile table above, the bumps of the
     face, the unwrap of its texture -- is written in ONE set of heights, the
     table's own ("canonical": eyes at 0, nose tip at -0.040, the mouth at
     -0.0705, the chin at -0.112). A real face keeps those landmarks in the same
     order but not at the same distances: a child's nose and jaw are shorter,
     the chin narrower. LOOK.head moves the canonical head onto the person:

       y   [[canonical, actual], ...]  where each height of the table really
           is on this face, metres above the eye line. Geometry is built at
           the actual height; the texture stays laid out in canonical height,
           so a feature and its bump can never drift apart.
       w   [[canonical, k], ...]       half-width multiplier by height (the
           jaw and chin are where faces differ most)
       f   [[canonical, k], ...]       depth-to-the-front multiplier (profile)

     Both are piecewise linear and clamped at the ends. Without LOOK.head every
     function here returns exactly what it always did. */
  function lut(tbl, x) {
    /* monotone cubic (Fritsch-Carlson) through the table: a fitted head must
       not carry a crease round it at every knot */
    var n = tbl.length, i;
    if (!n) return x;
    if (n === 1 || x <= tbl[0][0]) return tbl[0][1];
    if (x >= tbl[n - 1][0]) return tbl[n - 1][1];
    for (i = 0; i < n - 2; i++) if (x <= tbl[i + 1][0]) break;
    function sec(k) { var d = tbl[k + 1][0] - tbl[k][0]; return d > 1e-9 ? (tbl[k + 1][1] - tbl[k][1]) / d : 0; }
    function tan(k) {
      if (k <= 0) return sec(0);
      if (k >= n - 1) return sec(n - 2);
      var a = sec(k - 1), c = sec(k);
      if (a * c <= 0) return 0;
      var h0 = tbl[k][0] - tbl[k - 1][0], h1 = tbl[k + 1][0] - tbl[k][0];
      return (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / c);       /* weighted harmonic mean */
    }
    var h = tbl[i + 1][0] - tbl[i][0];
    if (h <= 1e-9) return tbl[i + 1][1];
    var t = (x - tbl[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * tbl[i][1] + (t3 - 2 * t2 + t) * h * tan(i) + (-2 * t3 + 3 * t2) * tbl[i + 1][1] + (t3 - t2) * h * tan(i + 1);
  }
  /* actual height of a canonical one, and back */
  function headY(hy) { var S = LOOK.head; return (S && S.y && S.y.length > 1) ? lut(S.y, hy) : hy; }
  function headYinv(y) {
    var S = LOOK.head;
    if (!(S && S.y && S.y.length > 1)) return y;
    var lo = HEAD.y0 - 0.02, hi = HEAD.y1 + 0.02;
    for (var i = 0; i < 28; i++) { var m = (lo + hi) / 2; if (lut(S.y, m) < y) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  /* the profile table's row at a canonical height, fitted: [hy, W, F, B] */
  function headRow(hy) {
    var r = sampleRows(HEAD.rows, hy), S = LOOK.head;
    if (S) {
      if (S.w && S.w.length) r[1] *= lut(S.w, hy);
      if (S.f && S.f.length) r[2] *= lut(S.f, hy);
      if (S.b && S.b.length) r[3] *= lut(S.b, hy);
    }
    return r;
  }
  /* Outward push of the face at (phi = angle off dead ahead, hy). The heights
     the features sit at are the table's; a fitted head may move them (all in
     canonical height): noseTip -0.040, noseBase -0.056, lipY -0.068,
     underLip -0.084, chinY -0.104, browY 0.020. */
  function faceBump(phi, hy) {
    var a = Math.abs(phi), d = 0, S = LOOK.head || {};
    var tip = fin(S.noseTip, -0.040), base = fin(S.noseBase, -0.056), lipY = fin(S.lipY, -0.068);
    /* nose: a ridge from the bridge down to the tip, then cut back under it */
    var np = hy > tip ? band(hy, 0.012, tip) : band(hy, base, tip);
    d += 0.0215 * fin(S.nose, 1) * np * gauss(a, 0, (0.150 + 0.05 * band(hy, tip + 0.020, tip - 0.005)) * fin(S.noseWide, 1));
    d += 0.0045 * fin(S.brow, 1) * gauss(hy, fin(S.browY, 0.020), 0.012) * (1 - band(a, 0.75, 1.05));   /* brow ridge   */
    d -= 0.0075 * fin(S.socket, 1) * gauss(hy, 0.000, 0.013) * gauss(a, 0.36, 0.17);                    /* eye sockets  */
    d += 0.0040 * fin(S.cheek, 1) * gauss(hy, -0.022, 0.018) * gauss(a, 0.80, 0.22);                    /* cheekbones   */
    d += 0.0034 * fin(S.lips, 1) * gauss(hy, lipY, 0.009) * gauss(a, 0, 0.26);                          /* lips         */
    d -= 0.0020 * gauss(hy, fin(S.underLip, -0.084), 0.007) * gauss(a, 0, 0.22);                        /* under lip    */
    d += 0.0042 * fin(S.chin, 1) * gauss(hy, fin(S.chinY, -0.104), 0.012) * gauss(a, 0, 0.30);          /* chin         */
    return d;
  }
  /* A point on the head at ring angle th (0 back, PI/2 the figure's right, PI
     front) and height hy, pushed `extra` metres further out along the ring. */
  function headPoint(th, hy, extra, out) {
    var hk = LOOK.build.head;
    var r = headRow(hy);
    var W = r[1], F = r[2], B = r[3];
    var c = Math.cos(th), s = Math.sin(th);
    var e = 2 / HEAD.n;
    var sx = (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), e), cz = (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), e);
    var x = W * sx, z = (c >= 0 ? B : F) * cz;
    var phi = angWrap(th - PI);
    var push = (c < 0.25 ? faceBump(phi, hy) * band(c, 0.25, -0.15) : 0) + (extra || 0);
    var l = Math.sqrt(x * x + z * z) || 1;
    var bump = push - (extra || 0), yy = hy;
    x += x / l * bump; z += z / l * bump;
    if (extra) {
      /* hair grows along the skull's own normal, not just outward: over the
         crown that is mostly UP, which is what gives the top its height */
      var nx = x / (0.077 * 0.077), ny = Math.max(0, hy - 0.020) / (0.105 * 0.105), nz = z / (0.100 * 0.100);
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      x += nx / nl * extra; yy += ny / nl * extra; z += nz / nl * extra;
    }
    /* built at the height this row really sits at on this face */
    out[0] = x * hk; out[1] = HEAD.eyeY + (headY(hy) + (yy - hy)) * hk; out[2] = HEAD.cz + z * hk;
    return out;
  }
  /* Hairline height (hy) as a function of the angle off dead ahead. */
  function hairLine(phi) {
    var a = Math.abs(phi), HR = LOOK.hair || {}, ln = fin(HR.line, 0.5);
    var top = lerp(0.086, 0.060, ln), k;
    if (HR.style === 'crop') {
      /* a short crop: the roots run nearly straight across the forehead, drop
         almost square at the temple, come down as a short sideburn in front
         of the ear, hug the top of the ear and end in a low neckline */
      var bn = fin(HR.burn, -0.006), nape = fin(HR.nape, -0.094), tc = fin(HR.temple, 0.86);
      k = [[0, top], [tc - 0.30, top + 0.001], [tc - 0.06, top - 0.007], [tc + 0.05, 0.034], [tc + 0.15, 0.012], [tc + 0.28, bn], [tc + 0.40, bn + 0.006],
        [1.40, 0.025], [1.62, 0.024], [1.80, -0.004], [2.10, lerp(-0.004, nape, 0.72)], [2.55, nape], [PI, nape + 0.003]];
    } else {
      k = [[0, top - 0.004], [0.50, top + 0.004], [0.88, 0.046], [1.12, -0.018], [1.30, 0.004], [1.48, 0.026],
        [1.78, -0.010], [2.15, -0.070], [PI, -0.082]];
    }
    for (var i = 0; i < k.length - 1; i++) if (a <= k[i + 1][0]) {
      return lerp(k[i][1], k[i + 1][1], sstep((a - k[i][0]) / (k[i + 1][0] - k[i][0])));
    }
    return k[k.length - 1][1];
  }
  /* How far (metres along the scalp) the point (phi, hy) is from the roots:
     positive in the hair, negative on bare skin. Measured to the hairline as
     a CURVE, not straight down -- at the temple the line runs nearly
     vertical, and a shell that only knows "how far above" grows a staircase
     there instead of an edge. */
  function hairDist(phi, hy) {
    var dv = hy - hairLine(phi), best = Math.abs(dv), R = 0.086;
    if (best > 0.045) return dv;
    for (var k = 1; k <= 16; k++) {
      var dp = k * 0.028, dx = R * dp;
      if (dx >= best) break;
      for (var sg = -1; sg <= 1; sg += 2) {
        var dy = hy - hairLine(angWrap(phi + sg * dp)), dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < best) best = dd;
      }
    }
    return dv >= 0 ? best : -best;
  }
  /* A crop is clipped short where it meets the skin: the body of the hair
     stops a little short of the roots at the sides and back, and what runs on
     down to the line is stubble, which is the atlas's to paint. 0 across the
     forehead, where the fringe hangs instead. */
  function cropLift(phi) {
    var HR = LOOK.hair || {}, a = Math.abs(phi), tc = fin(HR.temple, 0.86);
    var t0 = fin(HR.clipTemple, 0.010), t1 = fin(HR.clipSide, 0.026), t2 = fin(HR.clipBack, 0.030);
    if (a < tc + 0.22) return t0 * band(a, tc - 0.12, tc + 0.22);
    if (a < 1.75) return lerp(t0, t1, band(a, tc + 0.22, 1.45));
    return lerp(t1, t2, band(a, 1.75, 2.5));
  }
  /* 0 across the forehead, 1 from the temple round the back */
  function cropSide(phi) { var tc = fin(LOOK.hair && LOOK.hair.temple, 0.86); return band(Math.abs(phi), tc - 0.12, tc + 0.22); }
  function hairThick(phi, hy) {
    var st = (LOOK.hair && LOOK.hair.style) || 'short';
    if (st === 'bald') return 0;
    var a = Math.abs(phi), topK = band(hy, 0.050, 0.105);
    if (st === 'crop') {
      /* Short at the sides and back, a thick tousled mop on top. "On top" is
         where the scalp faces the sky -- the back of the head is as high as
         the crown and must not get the crown's depth of hair. */
      var HR = LOOK.hair, r = headRow(hy), e = 2 / HEAD.n, cth = -Math.cos(phi), sth = Math.sin(a);
      var hx = r[1] * Math.pow(Math.abs(sth), e), hz = (cth >= 0 ? r[3] : r[2]) * Math.pow(Math.abs(cth), e);
      var nx = hx / (0.077 * 0.077), ny = Math.max(0, hy - 0.020) / (0.105 * 0.105), nz = hz / (0.100 * 0.100);
      var up = band(ny / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1), 0.40, 0.86), front = 1 - band(a, 0.9, 2.3);
      var low = lerp(fin(HR.sides, 0.007), fin(HR.back, 0.011), band(a, 1.6, 2.5));
      var t = lerp(low, fin(HR.top, 0.022) * lerp(0.74, 1, front), up);
      /* tousled: tufts, two sizes of them, standing out of the mass */
      var m = fin(HR.messy, 0.5);
      var tuft = Math.sin(phi * 5.3 + hy * 61) * Math.sin(phi * 2.1 - hy * 113 + 1.7) * 0.30 +
        Math.sin(phi * 11.7 - hy * 187 + 0.6) * Math.sin(phi * 7.9 + hy * 143 + 2.3) * 0.20;
      return t * (1 + m * tuft * lerp(0.35, 1, up));
    }
    if (st === 'buzz') return 0.0035 + 0.002 * topK;
    if (st === 'medium' || st === 'long') {
      var back = band(a, 1.3, 2.4);
      return lerp(0.016 + 0.006 * back, 0.034, topK) + (st === 'long' ? 0.008 * back : 0);
    }
    return lerp(0.009, 0.019, topK) + 0.003 * gauss(a, 0, 0.6) * topK;
  }

  function buildHead(pile) {
    var w = W1('head'), COLS = 44, ROWS = 34, i, j, pt = [0, 0, 0];
    var start = pile.n, row = COLS + 1;
    for (i = 0; i <= ROWS; i++) {
      /* rows are packed toward the face band, where the features need them */
      var t = i / ROWS, hy = lerp(HEAD.y0, HEAD.y1, t);
      for (j = 0; j <= COLS; j++) {
        var th = j / COLS * TAU;
        headPoint(th, hy, 0, pt);
        var c = Math.cos(th);
        /* baked shade: under the chin, the eye sockets, under the nose */
        var phi = angWrap(th - PI);
        var sh = 1 - (LOOK.head ? 0.46 * band(hy, -0.110, -0.129) : 0.30 * band(hy, -0.100, -0.128)) - 0.14 * gauss(hy, 0.002, 0.012) * gauss(Math.abs(phi), 0.34, 0.16) * (c < 0 ? 1 : 0)
          - 0.12 * gauss(hy, -0.052, 0.007) * gauss(phi, 0, 0.16) * (c < 0 ? 1 : 0);
        pile.vert(pt[0], pt[1], pt[2], TILES.head.x + (j / COLS) * TILES.head.w, TILES.head.y + t * TILES.head.h, sh, w);
      }
    }
    for (i = 0; i < ROWS; i++) for (j = 0; j < COLS; j++) {
      var a = start + i * row + j, b = a + 1, c2 = a + row, d = c2 + 1;
      /* the ring runs back -> right -> front, counter-clockwise about +Y, and
         the rows climb, so (angle step) x (row step) points out */
      pile.tri(a, b, c2); pile.tri(b, d, c2);
    }
    /* close the crown */
    headPoint(0, HEAD.y1 + 0.001, 0, pt);
    var top = pile.vert(0, pt[1], HEAD.cz, TILES.head.x + 0.5 * TILES.head.w, TILES.head.y + TILES.head.h, 1, w);
    var lastRow = start + ROWS * row;
    for (j = 0; j < COLS; j++) pile.tri(top, lastRow + j, lastRow + j + 1);

    /* ears */
    var SH = LOOK.head || {};
    for (var s = 0; s < 2; s++) {
      var sg = s ? -1 : 1, hk = LOOK.build.head;
      if (SH.earOut === undefined && SH.earY === undefined && SH.earSize === undefined) {
        var ex = sg * (0.0765 * hk + 0.004), ey = HEAD.eyeY - 0.008 * hk, ez = HEAD.cz + 0.012;
        blob(pile, [ex, ey, ez], 0.0075, 0.031 * hk, 0.0165 * hk, 8, 6, TILES.skin, w,
          { a: [sg * 0.94, 0, 0.34], b: [-sg * 0.34, 0, 0.94], up: [sg * 0.10, 0.99, 0.06], s: 0.9 });
      } else {
        /* a fitted ear: rooted along its front edge on the side of the head at
           the height it really sits, and swung out from there by earOut
           radians -- the back edge is the one that stands off the skull */
        var eyA = fin(SH.earY, -0.008), es = fin(SH.earSize, 1), eo = clamp(fin(SH.earOut, 0.35), 0, 1.2);
        var wE = headRow(headYinv(eyA))[1], rz = 0.0165 * hk * es;
        var na = [sg * Math.cos(eo), 0, -Math.sin(eo)], lb = [sg * Math.sin(eo), 0, Math.cos(eo)];
        var fx = sg * (wE * hk - 0.0015), fz = HEAD.cz + 0.001;
        blob(pile, [fx + lb[0] * rz * 0.90, HEAD.eyeY + eyA * hk, fz + lb[2] * rz * 0.90], 0.0068 * es, 0.031 * hk * es, rz, 8, 6, TILES.skin, w,
          { a: na, b: lb, up: [sg * 0.08, 0.99, 0.05], s: 0.9 });
      }
    }
  }

  function buildHair(pile) {
    var st = (LOOK.hair && LOOK.hair.style) || 'short';
    if (st === 'bald') return;
    var crop = st === 'crop', HR = LOOK.hair || {};
    var w = W1('head'), COLS = crop ? 64 : 44, ROWS = crop ? 42 : 30, i, j, pt = [0, 0, 0];
    var hy0 = crop ? -0.118 : -0.094, hy1 = HEAD.y1, dh = (hy1 - hy0) / ROWS;
    var start = pile.n, row = COLS + 1, keep = [], lock = [];
    /* the crop's fringe: locks of uneven length hanging off the front roots.
       Three rows of the grid are spent on it, slid down each column to that
       column's own length, so the edge is ragged without being stair-stepped. */
    var FRN = 3, frMax = clamp(fin(HR.fringe, 0.014), 0, 0.05), frJag = clamp(fin(HR.jag, 0.5), 0, 1);
    function fringeLen(phi, col) {
      if (!crop || frMax <= 0) return 0;
      var n = 0.5 + 0.5 * Math.sin(col * 2.399 + 0.7) * Math.sin(col * 0.83 + 2.1);
      return frMax * gauss(phi, fin(HR.part, 0), 0.66) * (1 - frJag * 0.62 * n);
    }
    for (i = 0; i <= ROWS; i++) {
      var t = i / ROWS, hy = lerp(hy0, hy1, t);
      for (j = 0; j <= COLS; j++) {
        var th = j / COLS * TAU, phi = angWrap(th - PI);
        var L = hairLine(phi);
        var edge = band(hy - L, -0.004, 0.016);
        /* a fringe: medium and long hair come forward and down off the hairline */
        var fr = (st === 'medium' || st === 'long') ? gauss(phi, 0, 0.75) * band(hy, L - 0.030, L) * (1 - edge) : 0;
        var th2 = hairThick(phi, hy);
        var ex = edge > 0 ? th2 * edge : (fr > 0.05 ? 0.010 * fr : -0.0025);
        if (crop) {
          var fl = fringeLen(phi, j % COLS), hold = fl > 0.0015 ? 0.40 * clamp(fl / Math.max(1e-4, frMax), 0, 1) : 0;
          var dS = hairDist(phi, hy) - cropLift(phi), eg = band(dS, -0.002, 0.012);
          if (hy >= L && hold > 0) {
            /* over the forehead the hair does not thin out to the roots: it is
               the mass the fringe hangs from */
            keep.push(true);
            headPoint(th, hy, th2 * Math.max(eg, hold), pt);
          } else if (hy < L && fl > 0.0015 && Math.ceil((L - hy) / dh - 1e-6) <= FRN) {
            var q = Math.ceil((L - hy) / dh - 1e-6) / FRN;
            headPoint(th, L - fl * q, lerp(hairThick(phi, L) * hold, 0.0016, Math.pow(q, 0.7)), pt);
            keep.push(true); lock[keep.length - 1] = true;
          } else if (eg <= 0.001 && hy + dh <= hy1 + 1e-6 && band(hairDist(phi, hy + dh) - cropLift(phi), -0.002, 0.012) > 0.001) {
            /* the last vertex below the edge of the hair: slide it up its own
               column onto the edge, lying on the scalp, so the hair ends in a
               line there and not in a row of grid-sized cliffs */
            var lo = hy, hi = hy + dh;
            for (var bs = 0; bs < 14; bs++) {
              var md = (lo + hi) / 2;
              if (hairDist(phi, md) - cropLift(phi) > -0.0015) hi = md; else lo = md;
            }
            keep.push(true);
            headPoint(th, hi, 0.0005, pt);
          } else {
            keep.push(eg > 0.001);
            headPoint(th, hy, eg > 0 ? th2 * eg : -0.0025, pt);
          }
          pile.vert(pt[0], pt[1], pt[2], TILES.hair.x + (j / COLS) * TILES.hair.w, TILES.hair.y + t * TILES.hair.h,
            hy >= L ? 0.88 + 0.12 * band(hy - L, 0, 0.03) : 0.80, w);
          continue;
        }
        headPoint(th, hy, ex, pt);
        keep.push(edge > 0.001 || fr > 0.05);
        /* strands lie along v; a little baked shade toward the hairline */
        pile.vert(pt[0], pt[1], pt[2], TILES.hair.x + (j / COLS) * TILES.hair.w, TILES.hair.y + t * TILES.hair.h,
          0.80 + 0.20 * edge, w);
      }
    }
    for (i = 0; i < ROWS; i++) for (j = 0; j < COLS; j++) {
      var a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      if (!(keep[a] || keep[b] || keep[c] || keep[d])) continue;
      /* a lock ends at its tip: no skirt from there down into the forehead */
      if (!keep[a] && !keep[b] && lock[c] && lock[d]) continue;
      pile.tri(start + a, start + b, start + c); pile.tri(start + b, start + d, start + c);
    }
    headPoint(0, hy1, hairThick(0, hy1), pt);
    var top = pile.vert(0, pt[1] + 0.0015, HEAD.cz, TILES.hair.x + 0.5 * TILES.hair.w, TILES.hair.y + TILES.hair.h, 1, w);
    var lastRow = start + ROWS * row;
    for (j = 0; j < COLS; j++) pile.tri(top, lastRow + j, lastRow + j + 1);

    if (st === 'long') {
      /* the length: a curtain off the nape, hanging to the shoulders */
      var rings = [], rows2 = [[1.640, 0.082, 0.050, 0.060], [1.600, 0.086, 0.046, 0.066], [1.555, 0.092, 0.040, 0.070], [1.515, 0.090, 0.032, 0.072]];
      for (i = 0; i < rows2.length; i++) rings.push({
        c: [0, rows2[i][0], rows2[i][3]], a: X, b: Z, ra: rows2[i][1], rb: rows2[i][2], v: 0.45 - i * 0.14,
        w: i < 2 ? W2('head', 'neck', i * 0.5) : W2('neck', 'chest', (i - 1) * 0.4), s: 0.86
      });
      tube(pile, rings, 14, TILES.hair, { capEnd: true });
    }
  }

  /* =========================================================================
     7. THE ATLAS
     Three sheets painted in lock-step -- colour, height and roughness -- so a
     seam that is drawn is also raised and a belt that is leather is also
     shinier than the denim it sits on. The height sheet becomes the normal
     map. Everything is drawn in tile-local (u, v), the same space the
     geometry is unwrapped in, so a pocket lands where the hip is.
     ====================================================================== */
  function hexRGB(c) {
    c = String(c || '#808080').replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var n = parseInt(c, 16);
    if (!isFinite(n)) n = 0x808080;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function css(c, k, a) {
    k = k === undefined ? 1 : k;
    var r = clamp(Math.round(c[0] * k), 0, 255), g = clamp(Math.round(c[1] * k), 0, 255), b = clamp(Math.round(c[2] * k), 0, 255);
    return a === undefined ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function mixc(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function lum(c) { return (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722) / 255; }
  function grey(v, a) { v = clamp(Math.round(v), 0, 255); return a === undefined ? 'rgb(' + v + ',' + v + ',' + v + ')' : 'rgba(' + v + ',' + v + ',' + v + ',' + a + ')'; }

  var PAINT = null;      /* { g, gh, gr } while the atlas is being painted */

  function fillTile(t, col, rough) {
    PAINT.g.fillStyle = css(col); PAINT.g.fillRect(t.px, t.py, t.pw, t.ph);
    PAINT.gh.fillStyle = grey(128); PAINT.gh.fillRect(t.px, t.py, t.pw, t.ph);
    PAINT.gr.fillStyle = grey(rough * 255); PAINT.gr.fillRect(t.px, t.py, t.pw, t.ph);
  }
  /* rect in tile (u, v), v0 < v1 */
  function band2(t, u0, v0, u1, v1, col, rough, hgt) {
    var x = t.X(u0), y = t.Y(v1), w = t.W(u1 - u0), h = t.H(v1 - v0);
    if (u0 <= 0) { w += x - t.px; x = t.px; }
    if (u1 >= 1) w = t.px + t.pw - x;
    if (v0 <= 0) h = t.py + t.ph - y;
    if (v1 >= 1) { h += y - t.py; y = t.py; }
    if (col) { PAINT.g.fillStyle = typeof col === 'string' ? col : css(col); PAINT.g.fillRect(x, y, w, h); }
    if (rough !== undefined && rough !== null) { PAINT.gr.fillStyle = grey(rough * 255); PAINT.gr.fillRect(x, y, w, h); }
    if (hgt !== undefined && hgt !== null) { PAINT.gh.fillStyle = grey(128 + hgt); PAINT.gh.fillRect(x, y, w, h); }
  }
  /* a polyline in tile space, stroked on the colour sheet and (optionally)
     raised or sunk on the height sheet */
  function line(t, pts, col, lw, hgt, hlw, dash) {
    var ctxs = [[PAINT.g, col, lw], [PAINT.gh, hgt === undefined || hgt === null ? null : grey(128 + hgt), hlw || lw + 1.5]];
    for (var c = 0; c < 2; c++) {
      var g = ctxs[c][0], st = ctxs[c][1];
      if (!st) continue;
      g.save();
      g.beginPath(); g.rect(t.px, t.py, t.pw, t.ph); g.clip();
      g.strokeStyle = st; g.lineWidth = ctxs[c][2]; g.lineCap = 'round'; g.lineJoin = 'round';
      if (dash && c === 0) g.setLineDash(dash);
      g.beginPath();
      for (var i = 0; i < pts.length; i++) {
        var x = t.X(pts[i][0]), y = t.Y(pts[i][1]);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
      g.restore();
    }
  }
  /* a stitched seam: a sunk channel with a row of thread either side */
  function seam(t, pts, thread, dbl) {
    line(t, pts, 'rgba(0,0,0,.30)', 1.4, -26, 3.2);
    if (thread) {
      var d = dbl ? 2.6 : 0;
      for (var k = (dbl ? -1 : 0); k <= (dbl ? 1 : 0); k += 2) {
        var sh = [];
        for (var i = 0; i < pts.length; i++) {
          /* offset perpendicular to the local direction, in pixels */
          var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          var dx = t.W(b[0] - a[0]), dy = -t.H(b[1] - a[1]), l = Math.sqrt(dx * dx + dy * dy) || 1;
          sh.push([pts[i][0] + (-dy / l) * (k * d) / t.W(1), pts[i][1] + (-dx / l) * (k * d) / t.H(1)]);
        }
        line(t, sh, thread, 1.1, 14, 1.6, [3.2, 2.4]);
        if (!dbl) break;
      }
    }
  }
  function blotch(t, u, v, ru, rv, col, alpha) {
    var g = PAINT.g, x = t.X(u), y = t.Y(v), rx = Math.abs(t.W(ru)), ry = Math.abs(t.H(rv));
    g.save();
    g.beginPath(); g.rect(t.px, t.py, t.pw, t.ph); g.clip();
    g.translate(x, y); g.scale(1, ry / Math.max(1, rx));
    var gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, css(col, 1, alpha)); gr.addColorStop(1, css(col, 1, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rx, 0, TAU); g.fill();
    g.restore();
  }
  /* a soft crease on the height sheet only: a dark valley with a lit lip */
  function crease(t, pts, depth, lw) {
    line(t, pts, 'rgba(0,0,0,' + (0.07 * Math.min(1.6, depth)) + ')', lw, -34 * depth, lw + 2);
    var up = [];
    for (var i = 0; i < pts.length; i++) up.push([pts[i][0], pts[i][1] + (lw + 1.5) / t.H(1)]);
    line(t, up, 'rgba(255,255,255,' + (0.035 * Math.min(1.6, depth)) + ')', lw, 20 * depth, lw + 1);
  }

  /* Height (m) of a crew neckline round the trunk: u .25 is the back of the
     neck, .75 the hollow of the throat, where it dips. */
  function crewLine(u) { return lerp(1.548, fin(LOOK.top.neckline, 1.512), 0.5 - 0.5 * Math.cos(TAU * (u - 0.25))); }
  /* The cloth's weave is grained into the whole trunk tile after it is
     painted -- including the patch of bare skin inside a crew neck. Put that
     patch back: smooth, and in the shadow of the collar and the chin. */
  function crewSkin(ic, ih) {
    var t = TILES.torso, sk = hexRGB(LOOK.skin);
    for (var py = 0; py < t.ph; py++) {
      var v = 1 - (py - TILE_PAD) / (t.ph - 2 * TILE_PAD), y = TV.y0 + v * (TV.y1 - TV.y0);
      if (y < 1.49) continue;
      for (var px = 0; px < t.pw; px++) {
        var u = (px - TILE_PAD) / (t.pw - 2 * TILE_PAD), d = y - crewLine(clamp(u, 0, 1));
        if (d <= 0.0006) continue;
        var o = ((t.py + py) * ATLAS + t.px + px) * 4;
        var n = hash1(px * 3.7 + py * 91.3), k = (0.74 + 0.22 * band(d, 0, 0.030)) * (0.985 + 0.03 * n);
        ic[o] = sk[0] * k; ic[o + 1] = sk[1] * k * 0.985; ic[o + 2] = sk[2] * k * 0.97;
        ih[o] = ih[o + 1] = ih[o + 2] = 128;
      }
    }
  }

  function paintTop(T) {
    var t = TILES.torso, top = hexRGB(LOOK.top.color), trim = hexRGB(LOOK.top.trim || LOOK.top.color);
    var vB = tv(T.hem - 0.008);
    band2(t, 0, vB, 1, 1, top, 0.86);
    /* under the arms and toward the hem the cloth sits in its own shadow */
    blotch(t, 0.0, tv(1.36), 0.10, 0.20, [0, 0, 0], 0.26);
    blotch(t, 1.0, tv(1.36), 0.10, 0.20, [0, 0, 0], 0.26);
    blotch(t, 0.5, tv(1.36), 0.10, 0.20, [0, 0, 0], 0.26);
    blotch(t, 0.25, tv(1.40), 0.16, 0.14, [255, 255, 255], 0.05);       /* shoulder blades catch light */
    blotch(t, 0.25, tv(1.10), 0.10, 0.12, [0, 0, 0], 0.10);             /* small of the back           */

    var thread = css(top, lum(top) > 0.35 ? 0.72 : 1.45);
    /* side seams */
    seam(t, [[0.004, vB], [0.004, tv(1.43)]], null);
    seam(t, [[0.5, vB], [0.5, tv(1.43)]], null);
    seam(t, [[0.996, vB], [0.996, tv(1.43)]], null);

    if (T.type === 'jacket') {
      /* back yoke, and the same line carried over the front of each shoulder */
      seam(t, [[0.045, tv(1.425)], [0.14, tv(1.405)], [0.25, tv(1.398)], [0.36, tv(1.405)], [0.455, tv(1.425)]], thread, true);
      seam(t, [[0.545, tv(1.44)], [0.66, tv(1.425)]], thread, false);
      seam(t, [[0.84, tv(1.425)], [0.955, tv(1.44)]], thread, false);
      /* centre back */
      seam(t, [[0.25, vB + 0.06], [0.25, tv(1.398)]], null);
      /* ribbed hem band */
      band2(t, 0, vB, 1, vB + 0.058, css(trim), 0.92);
      for (var i = 0; i < 86; i++) {
        var u = (i + 0.5) / 86;
        line(t, [[u, vB + 0.003], [u, vB + 0.056]], 'rgba(0,0,0,.20)', 1.2, -18, 1.8);
      }
      line(t, [[0, vB + 0.060], [1, vB + 0.060]], 'rgba(0,0,0,.34)', 1.6, -30, 3);
      /* welt pockets, slanted */
      seam(t, [[0.625, tv(1.20)], [0.665, tv(1.085)]], thread, true);
      seam(t, [[0.875, tv(1.20)], [0.835, tv(1.085)]], thread, true);
      if (LOOK.top.zip !== false) {
        /* the zip: tape, teeth, a pull */
        band2(t, 0.742, vB, 0.758, tv(1.515), css(trim, 0.8), 0.6, -6);
        for (var k = 0; k < 74; k++) {
          var v = lerp(vB + 0.004, tv(1.512), k / 73);
          line(t, [[0.7455, v], [0.7545, v]], 'rgba(205,205,200,.62)', 1.2, 22, 1.4);
        }
        seam(t, [[0.728, vB + 0.06], [0.728, tv(1.50)]], thread, false);
        seam(t, [[0.772, vB + 0.06], [0.772, tv(1.50)]], thread, false);
      }
      /* the shirt underneath, showing in the V of the open collar */
      var un = hexRGB(LOOK.top.under || '#d8d4cb');
      var g = PAINT.g;
      g.save(); g.fillStyle = css(un);
      g.beginPath(); g.moveTo(t.X(0.70), t.Y(1)); g.lineTo(t.X(0.80), t.Y(1)); g.lineTo(t.X(0.75), t.Y(tv(1.488))); g.closePath(); g.fill();
      g.restore();
    } else if (T.type === 'sweater') {
      /* rib hem band */
      band2(t, 0, vB, 1, vB + 0.066, css(trim), 0.92);
      for (var i3 = 0; i3 < 96; i3++) {
        var u3 = (i3 + 0.5) / 96;
        line(t, [[u3, vB + 0.003], [u3, vB + 0.064]], 'rgba(0,0,0,.20)', 1.2, -18, 1.8);
      }
      line(t, [[0, vB + 0.068], [1, vB + 0.068]], 'rgba(0,0,0,.36)', 1.6, -30, 3);
      /* the body blousing over it */
      crease(t, [[0.02, vB + 0.090], [0.14, vB + 0.100], [0.25, vB + 0.092], [0.37, vB + 0.102], [0.48, vB + 0.090]], 0.9, 3);
      crease(t, [[0.53, vB + 0.092], [0.64, vB + 0.104], [0.75, vB + 0.094], [0.86, vB + 0.104], [0.97, vB + 0.092]], 0.9, 3);
      /* dropped shoulders: the armhole seam sits down on the arm, so all the
         trunk carries is the shoulder seam running out from the neck */
      seam(t, [[0.045, tv(1.468)], [0.004, tv(1.452)]], null);
      seam(t, [[0.455, tv(1.468)], [0.5, tv(1.452)]], null);
      seam(t, [[0.545, tv(1.468)], [0.5, tv(1.452)]], null);
      seam(t, [[0.955, tv(1.468)], [0.996, tv(1.452)]], null);
      /* THE CREW NECK. The neckline dips at the front; above it is the base of
         the neck, and that is skin. The rib band follows the line. */
      var sk = hexRGB(LOOK.skin), NP = 48, q, g2;
      var yN = crewLine;
      var sheets = [[PAINT.g, css(sk)], [PAINT.gh, grey(128)], [PAINT.gr, grey(0.60 * 255)]];
      for (var sI = 0; sI < 3; sI++) {
        g2 = sheets[sI][0];
        g2.save();
        g2.beginPath(); g2.rect(t.px, t.py, t.pw, t.ph); g2.clip();
        g2.fillStyle = sheets[sI][1];
        g2.beginPath(); g2.moveTo(t.px, t.py - 2);
        g2.lineTo(t.px, t.Y(tv(yN(0))));
        for (q = 0; q <= NP; q++) g2.lineTo(q === 0 ? t.px : q === NP ? t.px + t.pw : t.X(q / NP), t.Y(tv(yN(q / NP))));
        g2.lineTo(t.px + t.pw, t.py - 2); g2.closePath(); g2.fill();
        g2.restore();
      }
      /* the throat sits in the shadow of the jaw */
      blotch(t, 0.75, 1.0, 0.16, 0.05, [40, 16, 12], 0.30);
      blotch(t, 0.25, 1.0, 0.20, 0.04, [20, 12, 10], 0.34);
      /* the band: 24 mm of rib standing a little proud, shaded where it rolls */
      var bw = 0.024, bandPts = [], lipPts = [], lowPts = [];
      for (q = 0; q <= NP; q++) {
        var uq = q / NP;
        bandPts.push([uq, tv(yN(uq) - bw * 0.5)]); lipPts.push([uq, tv(yN(uq) - 0.0015)]); lowPts.push([uq, tv(yN(uq) - bw)]);
      }
      line(t, bandPts, css(trim), Math.abs(t.H(tv(0.8 + bw) - tv(0.8))), 14, Math.abs(t.H(tv(0.8 + bw) - tv(0.8))) + 1);
      var gr2 = PAINT.gr;
      gr2.save(); gr2.beginPath(); gr2.rect(t.px, t.py, t.pw, t.ph); gr2.clip();
      gr2.strokeStyle = grey(0.92 * 255); gr2.lineWidth = Math.abs(t.H(tv(0.8 + bw) - tv(0.8))); gr2.beginPath();
      for (q = 0; q <= NP; q++) { if (q) gr2.lineTo(t.X(bandPts[q][0]), t.Y(bandPts[q][1])); else gr2.moveTo(t.X(bandPts[q][0]), t.Y(bandPts[q][1])); }
      gr2.stroke(); gr2.restore();
      for (var r3 = 0; r3 < 132; r3++) {
        var ur = (r3 + 0.5) / 132;
        line(t, [[ur, tv(yN(ur) - bw + 0.002)], [ur, tv(yN(ur) - 0.002)]], 'rgba(0,0,0,.24)', 1.1, -16, 1.6);
      }
      line(t, lipPts, 'rgba(0,0,0,.40)', 1.6, -26, 2.6);
      line(t, lowPts, 'rgba(0,0,0,.34)', 1.5, -30, 3);
      /* cloth pulled between the shoulders and hanging off the chest */
      crease(t, [[0.62, tv(1.40)], [0.70, tv(1.37)], [0.75, tv(1.33)]], 0.6, 3);
      crease(t, [[0.88, tv(1.40)], [0.80, tv(1.37)], [0.75, tv(1.33)]], 0.6, 3);
      crease(t, [[0.58, tv(1.26)], [0.67, tv(1.21)], [0.74, tv(1.19)]], 0.5, 3);
      crease(t, [[0.92, tv(1.26)], [0.83, tv(1.21)], [0.76, tv(1.19)]], 0.5, 3);
    } else if (T.type === 'hoodie') {
      band2(t, 0, vB, 1, vB + 0.050, css(trim), 0.92);
      for (var i2 = 0; i2 < 70; i2++) {
        var u2 = (i2 + 0.5) / 70;
        line(t, [[u2, vB + 0.003], [u2, vB + 0.048]], 'rgba(0,0,0,.18)', 1.2, -16, 1.8);
      }
      /* kangaroo pocket */
      seam(t, [[0.635, tv(1.075)], [0.655, tv(1.19)], [0.845, tv(1.19)], [0.865, tv(1.075)]], thread, true);
      seam(t, [[0.635, tv(1.075)], [0.865, tv(1.075)]], thread, false);
      /* drawstrings */
      line(t, [[0.735, tv(1.50)], [0.728, tv(1.36)]], css(trim, 1.5), 2.2, 20, 2.6);
      line(t, [[0.765, tv(1.50)], [0.772, tv(1.375)]], css(trim, 1.5), 2.2, 20, 2.6);
      /* hood seam down the back of the neck */
      seam(t, [[0.10, tv(1.47)], [0.25, tv(1.44)], [0.40, tv(1.47)]], thread, false);
    } else {
      /* tee / shirt: collar rib, hem stitch, and a placket for a shirt */
      band2(t, 0, tv(1.522), 1, 1, css(trim), 0.9);
      line(t, [[0, tv(1.520)], [1, tv(1.520)]], 'rgba(0,0,0,.30)', 1.4, -22, 2.6);
      seam(t, [[0, vB + 0.022], [1, vB + 0.022]], thread, true);
      if (T.type === 'shirt') {
        seam(t, [[0.738, vB], [0.738, tv(1.52)]], thread, false);
        seam(t, [[0.762, vB], [0.762, tv(1.52)]], thread, false);
        for (var b = 0; b < 7; b++) blotch(t, 0.75, lerp(vB + 0.05, tv(1.49), b / 6), 0.008, 0.009, [235, 232, 224], 0.9);
      }
    }
    /* cloth folds: the waist cinch, the pull across the shoulder blades */
    crease(t, [[0.06, tv(1.11)], [0.17, tv(1.125)], [0.25, tv(1.115)], [0.34, tv(1.13)], [0.44, tv(1.11)]], 0.8, 3);
    crease(t, [[0.10, tv(1.19)], [0.20, tv(1.175)], [0.30, tv(1.18)], [0.41, tv(1.195)]], 0.5, 2.5);
    crease(t, [[0.03, tv(1.31)], [0.09, tv(1.345)], [0.13, tv(1.39)]], 0.8, 2.5);
    crease(t, [[0.47, tv(1.31)], [0.41, tv(1.345)], [0.37, tv(1.39)]], 0.8, 2.5);
    crease(t, [[0.56, tv(1.13)], [0.66, tv(1.118)]], 0.6, 2.5);
    crease(t, [[0.84, tv(1.118)], [0.94, tv(1.13)]], 0.6, 2.5);

    /* ---- sleeves ---------------------------------------------------------- */
    var sl = TILES.sleeve, tot = LEN.upper + LEN.fore;
    function sv(s) { return 1 - (s + 0.05) / (tot + 0.05); }
    fillTile(sl, top, 0.86);
    blotch(sl, 0.0, sv(0.06), 0.16, 0.20, [0, 0, 0], 0.28);              /* armpit */
    blotch(sl, 1.0, sv(0.06), 0.16, 0.20, [0, 0, 0], 0.28);
    seam(sl, [[0.004, 0], [0.004, 1]], null);
    seam(sl, [[0.996, 0], [0.996, 1]], null);
    /* armhole */
    if (T.type === 'sweater') seam(sl, [[0, sv(0.030)], [0.25, sv(0.072)], [0.5, sv(0.096)], [0.75, sv(0.072)], [1, sv(0.030)]], thread, false);
    else seam(sl, [[0, sv(0.012)], [0.25, sv(0.005)], [0.5, sv(-0.012)], [0.75, sv(0.005)], [1, sv(0.012)]], thread, T.type === 'jacket');
    if (T.long) {
      if (T.band) {
        band2(sl, 0, 0, 1, sv(tot - 0.052), css(trim), 0.92);
        for (var c = 0; c < 44; c++) {
          var uc = (c + 0.5) / 44;
          line(sl, [[uc, 0.002], [uc, sv(tot - 0.054)]], 'rgba(0,0,0,.20)', 1.2, -18, 1.8);
        }
        line(sl, [[0, sv(tot - 0.054)], [1, sv(tot - 0.054)]], 'rgba(0,0,0,.34)', 1.6, -30, 3);
      } else seam(sl, [[0, sv(tot - 0.03)], [1, sv(tot - 0.03)]], thread, true);
      /* the elbow: compression folds inside, a stretched cap outside */
      var ve = sv(LEN.upper);
      crease(sl, [[0.86, ve + 0.030], [0.96, ve + 0.012], [1.0, ve + 0.006]], 1.2, 3);
      crease(sl, [[0.0, ve + 0.006], [0.06, ve + 0.012], [0.16, ve + 0.034]], 1.2, 3);
      crease(sl, [[0.84, ve - 0.026], [0.95, ve - 0.012], [1.0, ve - 0.008]], 1.0, 3);
      crease(sl, [[0.0, ve - 0.008], [0.07, ve - 0.014], [0.18, ve - 0.034]], 1.0, 3);
      crease(sl, [[0.30, ve + 0.085], [0.42, ve + 0.070], [0.56, ve + 0.082]], 0.5, 2.5);
      crease(sl, [[0.28, sv(0.47)], [0.44, sv(0.455)], [0.60, sv(0.47)]], 0.6, 2.5);
      crease(sl, [[0.62, sv(0.49)], [0.78, sv(0.505)], [0.95, sv(0.49)]], 0.6, 2.5);
      blotch(sl, 0.5, ve, 0.13, 0.06, [255, 255, 255], 0.05);
    } else {
      seam(sl, [[0, sv(0.150)], [1, sv(0.150)]], thread, true);
    }
  }

  function paintBottom(T) {
    var t = TILES.torso, col = hexRGB(LOOK.bottom.color), st = css(hexRGB(LOOK.bottom.stitch || '#b48a4c'));
    var jeans = (LOOK.bottom.type || 'jeans') === 'jeans';
    var thread = jeans ? st : css(col, lum(col) > 0.35 ? 0.7 : 1.5);
    var vB = tv(T.hem - 0.008);
    if (LOOK.bottom.type === 'track') { paintTrack(t, col, thread, vB); return; }
    band2(t, 0, 0, 1, vB, col, jeans ? 0.90 : 0.84);
    /* seat and thigh fade, dark in the fork */
    if (jeans) {
      blotch(t, 0.17, tv(0.93), 0.085, 0.10, [255, 255, 255], 0.10);
      blotch(t, 0.33, tv(0.93), 0.085, 0.10, [255, 255, 255], 0.10);
    }
    blotch(t, 0.25, tv(0.83), 0.07, 0.07, [0, 0, 0], 0.30);
    blotch(t, 0.75, tv(0.83), 0.07, 0.07, [0, 0, 0], 0.30);
    /* waistband + belt */
    var belt = hexRGB(LOOK.belt || '#1b1612');
    seam(t, [[0, tv(1.022)], [1, tv(1.022)]], thread, false);
    band2(t, 0, tv(1.028), 1, tv(1.062), css(belt), 0.46, 10);
    line(t, [[0, tv(1.028)], [1, tv(1.028)]], 'rgba(0,0,0,.45)', 1.4, -22, 2.4);
    line(t, [[0, tv(1.062)], [1, tv(1.062)]], 'rgba(0,0,0,.45)', 1.4, -22, 2.4);
    band2(t, 0.728, tv(1.026), 0.772, tv(1.064), 'rgb(168,160,140)', 0.28, 26);      /* buckle */
    band2(t, 0.736, tv(1.034), 0.764, tv(1.056), css(belt), 0.46, 6);
    var loops = [0.06, 0.25, 0.44, 0.62, 0.88];
    for (var i = 0; i < loops.length; i++) band2(t, loops[i] - 0.008, tv(1.020), loops[i] + 0.008, tv(1.070), css(col, 0.92), 0.9, 16);
    /* side seams */
    seam(t, [[0.004, 0], [0.004, tv(1.022)]], thread, jeans);
    seam(t, [[0.5, 0], [0.5, tv(1.022)]], thread, jeans);
    seam(t, [[0.996, 0], [0.996, tv(1.022)]], thread, jeans);
    /* back: yoke, centre seam, patch pockets */
    seam(t, [[0.0, tv(1.006)], [0.25, tv(0.972)], [0.5, tv(1.006)]], thread, jeans);
    seam(t, [[0.25, tv(0.972)], [0.25, 0.0]], thread, jeans);
    for (var s = -1; s <= 1; s += 2) {
      var c = 0.25 + s * 0.092, w = 0.058;
      var pk = [[c - w, tv(0.985)], [c + w, tv(0.985)], [c + w * 0.93, tv(0.905)], [c, tv(0.878)], [c - w * 0.93, tv(0.905)], [c - w, tv(0.985)]];
      /* the pocket is a second layer of cloth: lift it a hair */
      var g = PAINT.gh, gc = PAINT.g;
      g.save(); g.fillStyle = grey(128 + 9); g.beginPath();
      gc.save(); gc.fillStyle = 'rgba(0,0,0,.05)'; gc.beginPath();
      for (var q = 0; q < pk.length; q++) {
        if (q) { g.lineTo(t.X(pk[q][0]), t.Y(pk[q][1])); gc.lineTo(t.X(pk[q][0]), t.Y(pk[q][1])); }
        else { g.moveTo(t.X(pk[q][0]), t.Y(pk[q][1])); gc.moveTo(t.X(pk[q][0]), t.Y(pk[q][1])); }
      }
      g.fill(); g.restore(); gc.fill(); gc.restore();
      seam(t, pk, thread, jeans);
      if (jeans) line(t, [[c - w * 0.7, tv(0.955)], [c, tv(0.935)], [c + w * 0.7, tv(0.955)]], st, 1.0, 10, 1.4, [3, 2.4]);
    }
    /* front: fly, scoop pockets */
    seam(t, [[0.75, tv(1.022)], [0.75, 0.0]], thread, false);
    seam(t, [[0.772, tv(1.022)], [0.772, tv(0.915)], [0.764, tv(0.888)], [0.75, tv(0.878)]], thread, jeans);
    seam(t, [[0.675, tv(1.022)], [0.655, tv(0.985)], [0.585, tv(0.962)], [0.545, tv(0.965)]], thread, jeans);
    seam(t, [[0.825, tv(1.022)], [0.845, tv(0.985)], [0.915, tv(0.962)], [0.955, tv(0.965)]], thread, jeans);
    /* whiskers off the fork */
    crease(t, [[0.60, tv(0.905)], [0.68, tv(0.888)], [0.74, tv(0.862)]], 0.7, 2.5);
    crease(t, [[0.90, tv(0.905)], [0.82, tv(0.888)], [0.76, tv(0.862)]], 0.7, 2.5);
    crease(t, [[0.58, tv(0.872)], [0.67, tv(0.858)], [0.735, tv(0.838)]], 0.6, 2.5);
    crease(t, [[0.92, tv(0.872)], [0.83, tv(0.858)], [0.765, tv(0.838)]], 0.6, 2.5);
    crease(t, [[0.12, tv(0.862)], [0.19, tv(0.848)], [0.245, tv(0.830)]], 0.8, 3);
    crease(t, [[0.38, tv(0.862)], [0.31, tv(0.848)], [0.255, tv(0.830)]], 0.8, 3);

    /* ---- legs ------------------------------------------------------------- */
    var lg = TILES.leg;
    function lv(y) { return (y - 0.085) / (0.950 - 0.085); }
    fillTile(lg, col, jeans ? 0.90 : 0.84);
    if (jeans) {
      blotch(lg, 0.75, lv(0.74), 0.17, 0.17, [255, 255, 255], 0.13);     /* thigh fade */
      blotch(lg, 0.75, lv(0.505), 0.12, 0.07, [255, 255, 255], 0.16);    /* knee       */
      blotch(lg, 0.25, lv(0.40), 0.13, 0.10, [255, 255, 255], 0.07);     /* calf       */
    }
    blotch(lg, 0.0, lv(0.84), 0.16, 0.12, [0, 0, 0], 0.30);              /* inside thigh */
    blotch(lg, 1.0, lv(0.84), 0.16, 0.12, [0, 0, 0], 0.30);
    blotch(lg, 0.25, lv(0.50), 0.14, 0.05, [0, 0, 0], 0.16);             /* back of knee */
    seam(lg, [[0.004, 0], [0.004, 1]], thread, false);
    seam(lg, [[0.996, 0], [0.996, 1]], thread, false);
    seam(lg, [[0.5, 0], [0.5, 1]], thread, jeans);
    seam(lg, [[0, lv(0.103)], [1, lv(0.103)]], thread, jeans);            /* hem */
    /* honeycombs behind the knee */
    for (var h = 0; h < 4; h++) {
      var y = 0.535 - h * 0.022;
      crease(lg, [[0.10, lv(y + 0.012)], [0.19, lv(y)], [0.25, lv(y + 0.006)], [0.31, lv(y)], [0.40, lv(y + 0.012)]], 0.9, 2.5);
    }
    /* knee, front */
    crease(lg, [[0.62, lv(0.555)], [0.75, lv(0.545)], [0.88, lv(0.555)]], 0.5, 2.5);
    crease(lg, [[0.63, lv(0.462)], [0.75, lv(0.472)], [0.87, lv(0.462)]], 0.5, 2.5);
    /* the stack at the ankle */
    for (var k = 0; k < 4; k++) {
      var yk = 0.128 + k * 0.026, ph = k * 0.19;
      crease(lg, [[0.0, lv(yk)], [0.14 + ph * 0.2, lv(yk + 0.010)], [0.33, lv(yk - 0.004)], [0.52 + ph * 0.1, lv(yk + 0.011)],
        [0.72, lv(yk - 0.003)], [0.88, lv(yk + 0.009)], [1.0, lv(yk)]], 1.1 - k * 0.15, 3);
    }
    /* thigh drag lines */
    crease(lg, [[0.60, lv(0.86)], [0.74, lv(0.835)], [0.90, lv(0.85)]], 0.5, 2.5);
    crease(lg, [[0.58, lv(0.80)], [0.72, lv(0.78)], [0.86, lv(0.79)]], 0.4, 2.5);
  }

  /* Tracksuit bottoms: knit, no belt, no fly, no rivets -- an elastic waist
     with a drawcord, slant pockets, a soft leg and a rib cuff at the ankle. */
  function paintTrack(t, col, thread, vB) {
    var i, u, stripe = LOOK.bottom.stripe ? hexRGB(LOOK.bottom.stripe) : null;
    band2(t, 0, 0, 1, vB, col, 0.88);
    blotch(t, 0.25, tv(0.83), 0.07, 0.07, [0, 0, 0], 0.30);
    blotch(t, 0.75, tv(0.83), 0.07, 0.07, [0, 0, 0], 0.30);
    /* the waistband: gathered elastic */
    band2(t, 0, tv(1.016), 1, tv(1.066), css(col, 1.10), 0.90, 9);
    for (i = 0; i < 72; i++) {
      u = (i + 0.5) / 72;
      line(t, [[u, tv(1.018)], [u + 0.004 * Math.sin(i * 1.7), tv(1.064)]], 'rgba(0,0,0,.24)', 1.2, -15, 1.8);
    }
    line(t, [[0, tv(1.016)], [1, tv(1.016)]], 'rgba(0,0,0,.40)', 1.5, -26, 2.6);
    line(t, [[0, tv(1.066)], [1, tv(1.066)]], 'rgba(0,0,0,.40)', 1.5, -22, 2.4);
    line(t, [[0.738, tv(1.040)], [0.728, tv(0.955)]], css(col, 2.4), 2.0, 18, 2.4);      /* drawcord */
    line(t, [[0.762, tv(1.040)], [0.770, tv(0.965)]], css(col, 2.4), 2.0, 18, 2.4);
    /* seams: sides, seat and rise */
    seam(t, [[0.004, 0], [0.004, tv(1.016)]], thread, false);
    seam(t, [[0.5, 0], [0.5, tv(1.016)]], thread, false);
    seam(t, [[0.996, 0], [0.996, tv(1.016)]], thread, false);
    seam(t, [[0.25, tv(1.016)], [0.25, 0]], null);
    seam(t, [[0.75, tv(1.016)], [0.75, 0]], null);
    /* slant pockets */
    seam(t, [[0.612, tv(1.010)], [0.566, tv(0.905)]], thread, false);
    seam(t, [[0.888, tv(1.010)], [0.934, tv(0.905)]], thread, false);
    crease(t, [[0.60, tv(0.905)], [0.68, tv(0.890)], [0.74, tv(0.866)]], 0.6, 3);
    crease(t, [[0.90, tv(0.905)], [0.82, tv(0.890)], [0.76, tv(0.866)]], 0.6, 3);
    crease(t, [[0.12, tv(0.862)], [0.19, tv(0.848)], [0.245, tv(0.830)]], 0.7, 3);
    crease(t, [[0.38, tv(0.862)], [0.31, tv(0.848)], [0.255, tv(0.830)]], 0.7, 3);

    var lg = TILES.leg;
    function lv(y) { return (y - 0.085) / (0.950 - 0.085); }
    fillTile(lg, col, 0.88);
    blotch(lg, 0.0, lv(0.84), 0.16, 0.12, [0, 0, 0], 0.30);
    blotch(lg, 1.0, lv(0.84), 0.16, 0.12, [0, 0, 0], 0.30);
    blotch(lg, 0.25, lv(0.50), 0.14, 0.05, [0, 0, 0], 0.16);
    seam(lg, [[0.004, 0], [0.004, 1]], thread, false);
    seam(lg, [[0.996, 0], [0.996, 1]], thread, false);
    seam(lg, [[0.5, lv(0.128)], [0.5, 1]], thread, false);
    if (stripe) {
      band2(lg, 0.468, lv(0.128), 0.486, 1, css(stripe), 0.7, 6);
      band2(lg, 0.514, lv(0.128), 0.532, 1, css(stripe), 0.7, 6);
    }
    /* soft cloth: a bagged knee, long easy folds, nothing sharp */
    crease(lg, [[0.60, lv(0.560)], [0.75, lv(0.548)], [0.90, lv(0.560)]], 0.5, 3.5);
    crease(lg, [[0.62, lv(0.455)], [0.75, lv(0.468)], [0.88, lv(0.455)]], 0.6, 3.5);
    crease(lg, [[0.08, lv(0.530)], [0.25, lv(0.512)], [0.42, lv(0.530)]], 0.8, 3.5);
    crease(lg, [[0.10, lv(0.490)], [0.25, lv(0.476)], [0.40, lv(0.490)]], 0.6, 3.5);
    crease(lg, [[0.58, lv(0.84)], [0.74, lv(0.80)], [0.92, lv(0.82)]], 0.4, 3.5);
    crease(lg, [[0.56, lv(0.70)], [0.70, lv(0.665)], [0.86, lv(0.68)]], 0.35, 3.5);
    crease(lg, [[0.60, lv(0.33)], [0.76, lv(0.30)], [0.92, lv(0.32)]], 0.4, 3.5);
    /* the leg stacking on its cuff */
    for (i = 0; i < 3; i++) {
      var yk = 0.142 + i * 0.030, ph = i * 0.21;
      crease(lg, [[0.0, lv(yk)], [0.15 + ph * 0.2, lv(yk + 0.011)], [0.34, lv(yk - 0.004)], [0.53 + ph * 0.1, lv(yk + 0.012)],
        [0.72, lv(yk - 0.003)], [0.88, lv(yk + 0.010)], [1.0, lv(yk)]], 1.1 - i * 0.2, 3.5);
    }
    /* the cuff: rib */
    band2(lg, 0, 0, 1, lv(0.122), css(col, 1.10), 0.92, 6);
    for (i = 0; i < 44; i++) {
      u = (i + 0.5) / 44;
      line(lg, [[u, 0.004], [u, lv(0.120)]], 'rgba(0,0,0,.24)', 1.2, -16, 1.8);
    }
    line(lg, [[0, lv(0.123)], [1, lv(0.123)]], 'rgba(0,0,0,.42)', 1.6, -30, 3);
  }

  function paintShoes() {
    var t = TILES.shoe, up = hexRGB(LOOK.shoes.color), sole = hexRGB(LOOK.shoes.sole || '#f3f1ea'), acc = hexRGB(LOOK.shoes.accent || LOOK.shoes.color);
    var boots = (LOOK.shoes.type || 'sneakers') === 'boots';
    fillTile(t, up, boots ? 0.62 : 0.74);
    /* underside, then the midsole wrapping up the sides */
    band2(t, 0.385, 0, 0.615, 1, css([52, 50, 48]), 0.92, -8);
    band2(t, 0.300, 0, 0.385, 1, css(sole), 0.66, 12);
    band2(t, 0.615, 0, 0.700, 1, css(sole), 0.66, 12);
    line(t, [[0.300, 0], [0.300, 1]], 'rgba(0,0,0,.42)', 1.6, -30, 3);
    line(t, [[0.700, 0], [0.700, 1]], 'rgba(0,0,0,.42)', 1.6, -30, 3);
    /* toe cap and heel counter */
    seam(t, [[0, 0.80], [0.30, 0.76]], css(up, 0.8), false);
    seam(t, [[0.70, 0.76], [1, 0.80]], css(up, 0.8), false);
    band2(t, 0, 0, 0.30, 0.17, css(acc), 0.6);
    band2(t, 0.70, 0, 1, 0.17, css(acc), 0.6);
    seam(t, [[0, 0.17], [0.30, 0.19]], null);
    seam(t, [[0.70, 0.19], [1, 0.17]], null);
    /* side stripe */
    line(t, [[0.11, 0.30], [0.27, 0.62]], css(acc), 5, 6, 6);
    line(t, [[0.89, 0.30], [0.73, 0.62]], css(acc), 5, 6, 6);
    /* tongue + laces over the instep (u wraps at the top) */
    band2(t, 0, 0.30, 0.055, 0.70, css(up, 0.86), 0.78, 8);
    band2(t, 0.945, 0.30, 1, 0.70, css(up, 0.86), 0.78, 8);
    for (var i = 0; i < 6; i++) {
      var v = 0.34 + i * 0.065;
      line(t, [[0, v], [0.062, v + 0.02]], css(boots ? [60, 52, 44] : [246, 246, 242]), 2.4, 30, 3);
      line(t, [[1, v], [0.938, v + 0.02]], css(boots ? [60, 52, 44] : [246, 246, 242]), 2.4, 30, 3);
    }
    /* collar */
    band2(t, 0, 0.17, 0.10, 0.30, css(up, 0.72), 0.86, 6);
    band2(t, 0.90, 0.17, 1, 0.30, css(up, 0.72), 0.86, 6);
  }

  function paintSkin() {
    var sk = hexRGB(LOOK.skin);
    fillTile(TILES.skin, sk, 0.60);
    blotch(TILES.skin, 0.5, 0.5, 0.6, 0.6, mixc(sk, [200, 90, 80], 0.5), 0.06);
    var trim = hexRGB(LOOK.gloves || LOOK.top.trim || LOOK.top.color);
    fillTile(TILES.trim, trim, LOOK.gloves ? 0.7 : 0.9);
    fillTile(TILES.under, hexRGB(LOOK.top.under || '#d8d4cb'), 0.88);
  }

  /* ---- a photograph for a face -------------------------------------------
     LOOK.face.image is a FRONTAL portrait that has already been straightened
     and scaled so its features sit where this head's do (the tool that writes
     nz-hero-look.js from the photographs does that; the canonical positions
     are in the LOOK block at the top of the file). Here it is projected
     straight back onto the head -- every texel of the head tile knows which
     point of the skull it is, and that point's offset from the nose and
     height above the eyes is where to read the picture. Round the side of the
     head a frontal picture has nothing true to say, so it is feathered back
     into the painted skin, which the same tool has matched to the picture.

     The picture is only ever READ (getImageData on a scratch canvas), never
     drawn into the atlas: a picture the browser will not let a page read --
     a file:// image, a cross-origin one -- would otherwise taint the atlas and
     WebGL would refuse the whole figure's texture. A data: URL always reads. */
  var FACE = { src: null, img: null, state: 0 };       /* 0 none, 1 loading, 2 ready, 3 failed */
  function faceReady() {
    var F = LOOK.face;
    return !!(F && F.image && FACE.state === 2 && FACE.src === F.image && FACE.img);
  }
  function loadFace(done) {
    var F = LOOK.face;
    if (!F || !F.image) { FACE.src = null; FACE.img = null; FACE.state = 0; return; }
    if (FACE.src === F.image && FACE.state) return;
    FACE.src = F.image; FACE.img = null; FACE.state = 1;
    if (typeof F.image !== 'string') {                  /* an <img> or a canvas handed over ready */
      FACE.img = F.image; FACE.state = 2; if (done) done();
      return;
    }
    var want = F.image, im = new global.Image();
    im.onload = function () {
      if (FACE.src !== want) return;                    /* restyled again meanwhile */
      FACE.img = im; FACE.state = 2;
      if (done) done();
    };
    im.onerror = function () {
      if (FACE.src !== want) return;
      FACE.state = 3;
      warn('the face picture did not load (' + String(want).slice(0, 60) + '); keeping the painted face');
    };
    im.src = want;
  }
  /* returns true when the picture went on */
  function projectFace(t) {
    var F = LOOK.face, img = FACE.img, doc = global.document;
    var half = clamp(fin(F.half, 0.090), 0.03, 0.2), top = fin(F.top, 0.125), bot = fin(F.bottom, -0.135);
    var wrap = clamp(fin(F.wrap, 1.15), 0.3, 1.55), fea = clamp(fin(F.feather, 0.40), 0.05, wrap);
    var gain = clamp(fin(F.opacity, 1), 0, 1);
    if (!(top > bot)) return false;
    var iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height;
    if (!(iw > 1 && ih > 1)) return false;
    var sc = Math.min(1, 1024 / Math.max(iw, ih));
    var pc = doc.createElement('canvas');
    pc.width = Math.max(2, Math.round(iw * sc)); pc.height = Math.max(2, Math.round(ih * sc));
    var pg = pc.getContext('2d', { willReadFrequently: true }), src;
    try { pg.drawImage(img, 0, 0, pc.width, pc.height); src = pg.getImageData(0, 0, pc.width, pc.height).data; }
    catch (e) {
      FACE.state = 3;
      warn('the browser will not let the page read the face picture (' + (e && e.message ? e.message : e) + '); embed it as a data: URL. Keeping the painted face');
      return false;
    }
    var PW2 = pc.width, PH2 = pc.height, g = PAINT.g;
    var id = g.getImageData(t.px, t.py, t.pw, t.ph), d = id.data, e2 = 2 / HEAD.n;
    var cut0 = fin(F.cutBottom, bot), cut1 = fin(F.cutTop, top), soft = clamp(fin(F.soft, 0.014), 0.001, 0.05);
    for (var py = 0; py < t.ph; py++) {
      var v = 1 - (py - TILE_PAD) / (t.ph - 2 * TILE_PAD);
      /* the tile is laid out in the table's heights; the picture is of the
         person, so it is read at the height this row really sits at */
      var hyC = HEAD.y0 + v * (HEAD.y1 - HEAD.y0), hy = headY(hyC);
      if (hy > top || hy < bot) continue;
      var r = headRow(hyC);
      var my = band(hy, cut0, cut0 + soft) * (1 - band(hy, cut1 - soft, cut1));
      if (my <= 0) continue;
      var fy = (top - hy) / (top - bot) * (PH2 - 1), y0 = Math.floor(fy), y1 = Math.min(PH2 - 1, y0 + 1), ty = fy - y0;
      for (var px = 0; px < t.pw; px++) {
        var u = (px - TILE_PAD) / (t.pw - 2 * TILE_PAD), phi = (0.5 - u) * TAU, a = Math.abs(phi);
        if (a >= wrap) continue;
        /* this texel's offset from the midline, metres toward the figure's right */
        var x = (phi < 0 ? -1 : 1) * r[1] * Math.pow(Math.sin(Math.min(a, PI / 2)), e2);
        if (Math.abs(x) >= half) continue;
        var m = my * (1 - band(a, wrap - fea, wrap)) * (1 - band(Math.abs(x), half * 0.90, half));
        if (m <= 0.003) continue;
        /* the figure's right is on the picture's left, as in any portrait */
        var fx = (0.5 - x / (2 * half)) * (PW2 - 1), x0 = Math.floor(fx), x1 = Math.min(PW2 - 1, x0 + 1), tx = fx - x0;
        var o00 = (y0 * PW2 + x0) * 4, o10 = (y0 * PW2 + x1) * 4, o01 = (y1 * PW2 + x0) * 4, o11 = (y1 * PW2 + x1) * 4;
        var w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        var al = (src[o00 + 3] * w00 + src[o10 + 3] * w10 + src[o01 + 3] * w01 + src[o11 + 3] * w11) / 255;
        m *= al * gain;
        if (m <= 0.003) continue;
        var o = (py * t.pw + px) * 4;
        d[o] = lerp(d[o], src[o00] * w00 + src[o10] * w10 + src[o01] * w01 + src[o11] * w11, m);
        d[o + 1] = lerp(d[o + 1], src[o00 + 1] * w00 + src[o10 + 1] * w10 + src[o01 + 1] * w01 + src[o11 + 1] * w11, m);
        d[o + 2] = lerp(d[o + 2], src[o00 + 2] * w00 + src[o10 + 2] * w10 + src[o01 + 2] * w01 + src[o11 + 2] * w11, m);
      }
    }
    g.putImageData(id, t.px, t.py);
    return true;
  }

  /* The face. Painted in the head tile, whose (u, v) is (ring angle, height):
     u 0.5 is dead ahead and the figure's right eye is on the left of the
     sheet, the way a portrait is. */
  function paintHead() {
    var t = TILES.head, sk = hexRGB(LOOK.skin), hair = hexRGB((LOOK.hair && LOOK.hair.color) || '#241a13');
    var g = PAINT.g, gh = PAINT.gh, gr = PAINT.gr, hk = 1;
    function hv(hy) { return (hy - HEAD.y0) / (HEAD.y1 - HEAD.y0); }
    function hu(phi) { return 0.5 - phi / TAU; }       /* +phi is the figure's right */
    /* angle off dead ahead for a point `x` metres off the midline, at height hy */
    function ang(x, hy) {
      /* the exact inverse of the superellipse headPoint() lays the ring out on */
      var r = headRow(hy), q = clamp(Math.abs(x) / r[1], 0, 1);
      return (x < 0 ? -1 : 1) * Math.asin(Math.pow(q, HEAD.n / 2));
    }
    void hk;
    fillTile(t, sk, 0.60);
    /* tone: warm in the cheeks, nose and ears, cooler and darker round the eyes and jaw */
    var warm = mixc(sk, [205, 84, 72], 0.55), cool = mixc(sk, [70, 50, 60], 0.6);
    blotch(t, hu(0.62), hv(-0.034), 0.060, 0.090, warm, 0.20);
    blotch(t, hu(-0.62), hv(-0.034), 0.060, 0.090, warm, 0.20);
    blotch(t, 0.5, hv(-0.038), 0.030, 0.060, warm, 0.20);
    blotch(t, 0.25, hv(-0.008), 0.040, 0.10, warm, 0.24);
    blotch(t, 0.75, hv(-0.008), 0.040, 0.10, warm, 0.24);
    blotch(t, hu(0.36), hv(-0.004), 0.050, 0.060, cool, 0.20);
    blotch(t, hu(-0.36), hv(-0.004), 0.050, 0.060, cool, 0.20);
    blotch(t, 0.5, hv(0.060), 0.11, 0.10, [255, 255, 255], 0.06);
    blotch(t, 0.5, hv(-0.122), 0.30, 0.06, [0, 0, 0], 0.22);              /* under the jaw */

    /* a photograph, if there is one: it brings its own beard, eyes and mouth */
    var photo = faceReady() ? projectFace(t) : false;
    var painted = !photo || !!(LOOK.face && LOOK.face.features);

    /* stubble / beard */
    var bd = clamp(fin(LOOK.beard, 0), 0, 1);
    if (bd > 0.02 && painted) {
      var id = g.getImageData(t.px, t.py, t.pw, t.ph), d = id.data;
      for (var py = 0; py < t.ph; py++) for (var px2 = 0; px2 < t.pw; px2++) {
        var u = (px2 - TILE_PAD) / (t.pw - 2 * TILE_PAD), v = 1 - (py - TILE_PAD) / (t.ph - 2 * TILE_PAD);
        var hy = HEAD.y0 + v * (HEAD.y1 - HEAD.y0), a = Math.abs((0.5 - u) * TAU);
        if (a > 1.55 || hy > -0.030) continue;
        /* jaw, chin, upper lip; clear under the lower lip and on the cheek apples */
        var m = band(hy, -0.030, -0.060) * (1 - band(a, 1.05, 1.5)) * (1 - 0.75 * gauss(hy, -0.040, 0.016) * gauss(a, 0.55, 0.30));
        m = Math.max(m, gauss(hy, -0.058, 0.006) * (1 - band(a, 0.20, 0.36)) * 0.9);
        m *= (1 - 0.5 * gauss(hy, -0.084, 0.007) * gauss(a, 0, 0.12));
        if (m < 0.02) continue;
        var nz = hash1(px2 * 13.1 + py * 71.7), k = clamp(m * (bd < 0.45 ? bd * 1.6 * (0.35 + nz * 0.65) : lerp(0.55, 1, bd) * (0.80 + nz * 0.20)), 0, 0.97);
        var o = (py * t.pw + px2) * 4;
        d[o] = lerp(d[o], hair[0], k); d[o + 1] = lerp(d[o + 1], hair[1], k); d[o + 2] = lerp(d[o + 2], hair[2], k);
      }
      g.putImageData(id, t.px, t.py);
    }

    /* scalp: the hairline is painted, so the shell above it never shows skin
       at its edge and a buzz cut is nothing BUT this */
    var st = (LOOK.hair && LOOK.hair.style) || 'short';
    if (st !== 'bald') {
      var id2 = g.getImageData(t.px, t.py, t.pw, t.ph), d2 = id2.data;
      var ir = gr.getImageData(t.px, t.py, t.pw, t.ph), dr = ir.data;
      for (var qy = 0; qy < t.ph; qy++) for (var qx = 0; qx < t.pw; qx++) {
        var u3 = (qx - TILE_PAD) / (t.pw - 2 * TILE_PAD), v3 = 1 - (qy - TILE_PAD) / (t.ph - 2 * TILE_PAD);
        var hy3 = HEAD.y0 + v3 * (HEAD.y1 - HEAD.y0), phi = (0.5 - u3) * TAU;
        var e, n3 = hash1(qx * 7.3 + qy * 113.1), stip = 1;
        if (st === 'crop') {
          /* across the forehead the roots are a line (and a photograph's own
             fringe is left to show below it); round the sides and back the
             hair is clipped down to nothing, so it fades out in stubble */
          var dH = hairDist(phi, hy3), lf = cropSide(phi);
          if (dH < -0.014) continue;
          e = lerp(band(dH, -0.003, 0.010), band(dH, -0.010, 0.012), lf);
          stip = lerp(1, lerp(0.30 + 0.70 * n3, 0.86 + 0.14 * n3, band(dH, -0.002, 0.012)), lf);
        } else e = photo ? band(hy3 - hairLine(phi), -0.003, 0.010) : band(hy3 - hairLine(phi), -0.012, 0.006);
        if (e <= 0) continue;
        var k3 = clamp(e * stip * (0.82 + 0.18 * n3) * (st === 'buzz' ? 0.80 : 1), 0, 1);
        var o3 = (qy * t.pw + qx) * 4, sh = st === 'crop' ? 0.66 + 0.24 * n3 : 0.86 + 0.28 * n3;
        d2[o3] = lerp(d2[o3], hair[0] * sh, k3); d2[o3 + 1] = lerp(d2[o3 + 1], hair[1] * sh, k3); d2[o3 + 2] = lerp(d2[o3 + 2], hair[2] * sh, k3);
        dr[o3] = dr[o3 + 1] = dr[o3 + 2] = lerp(dr[o3], 0.50 * 255, k3);
      }
      g.putImageData(id2, t.px, t.py);
      gr.putImageData(ir, t.px, t.py);
    }

    /* ---- features --------------------------------------------------------- */
    var browC = css(hexRGB(LOOK.brow || LOOK.hair.color)), eyeC = hexRGB(LOOK.eye || '#3b2a1c');
    if (!painted) {
      /* the picture has them; all that is left to say is that an eye is wet */
      for (var se = -1; se <= 1; se += 2) {
        var pu = hu(ang(se * 0.0315, 0.0)), pw = Math.abs(ang(0.0465, 0) - ang(0.0165, 0)) / TAU * 0.5;
        gr.fillStyle = grey(0.22 * 255); gr.beginPath();
        gr.ellipse(t.X(pu), t.Y(hv(0.001)), t.W(pw), t.H(0.0056 / (HEAD.y1 - HEAD.y0)), 0, 0, TAU); gr.fill();
        blotch(t, se > 0 ? 0.262 : 0.738, hv(-0.008), 0.020, 0.060, [70, 34, 30], 0.16);
      }
      return;
    }
    for (var s = -1; s <= 1; s += 2) {
      var ex = s * 0.0315, eu = hu(ang(ex, 0.0)), ev = hv(0.001);
      var ew = Math.abs(ang(Math.abs(ex) + 0.0150, 0) - ang(Math.abs(ex) - 0.0150, 0)) / TAU * 0.5, ehh = 0.0056 / (HEAD.y1 - HEAD.y0);
      var cx = t.X(eu), cy = t.Y(ev), rx = t.W(ew), ry = t.H(ehh);
      /* socket shadow */
      blotch(t, eu, ev + 0.012, ew * 1.9, ehh * 3.2, [40, 24, 22], 0.26);
      /* the eye: white, iris, pupil, a catchlight, the upper lid line */
      g.save();
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); g.closePath();
      g.fillStyle = 'rgb(226,220,212)'; g.fill(); g.clip();
      g.fillStyle = css(eyeC); g.beginPath(); g.arc(cx, cy - ry * 0.10, ry * 1.12, 0, TAU); g.fill();
      g.fillStyle = 'rgb(12,10,10)'; g.beginPath(); g.arc(cx, cy - ry * 0.10, ry * 0.50, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(cx - ry * 0.34, cy - ry * 0.44, ry * 0.20, 0, TAU); g.fill();
      g.fillStyle = 'rgba(30,18,16,.42)'; g.fillRect(cx - rx, cy - ry, rx * 2, ry * 0.52);
      g.restore();
      g.save();
      g.strokeStyle = 'rgba(28,16,14,.9)'; g.lineWidth = 2.0; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx - rx * 1.08, cy + ry * 0.15); g.quadraticCurveTo(cx, cy - ry * 1.55, cx + rx * 1.08, cy + ry * 0.10); g.stroke();
      g.strokeStyle = 'rgba(70,40,34,.42)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(cx - rx * 0.95, cy + ry * 0.45); g.quadraticCurveTo(cx, cy + ry * 1.25, cx + rx * 0.95, cy + ry * 0.40); g.stroke();
      /* lid crease */
      g.strokeStyle = 'rgba(60,34,30,.34)'; g.lineWidth = 1.3;
      g.beginPath(); g.moveTo(cx - rx * 1.0, cy - ry * 1.3); g.quadraticCurveTo(cx, cy - ry * 2.5, cx + rx * 1.05, cy - ry * 1.2); g.stroke();
      g.restore();
      gr.fillStyle = grey(0.16 * 255); gr.beginPath(); gr.ellipse(cx, cy, rx, ry, 0, 0, TAU); gr.fill();
      gh.fillStyle = grey(128 + 10); gh.beginPath(); gh.ellipse(cx, cy, rx, ry, 0, 0, TAU); gh.fill();
      /* brow: a tapered stroke, thick toward the nose */
      var bu0 = hu(ang(s * 0.011, 0.02)), bu1 = hu(ang(s * 0.036, 0.02)), bu2 = hu(ang(s * 0.053, 0.016));
      g.save(); g.strokeStyle = browC; g.lineCap = 'round';
      for (var w = 0; w < 3; w++) {
        g.globalAlpha = 0.55 + w * 0.15; g.lineWidth = [7.5, 5.5, 3.2][w];
        g.beginPath(); g.moveTo(t.X(bu0), t.Y(hv(0.0175)));
        g.quadraticCurveTo(t.X(bu1), t.Y(hv(0.0255)), t.X(lerp(bu1, bu2, [1, 0.8, 0.5][w])), t.Y(hv(0.019)));
        g.stroke();
      }
      g.restore();
      /* nostril and the side of the nose */
      var nu = hu(ang(s * 0.0125, -0.05));
      blotch(t, nu, hv(-0.0505), 0.0115, 0.0125, [30, 14, 12], 0.72);
      blotch(t, hu(ang(s * 0.017, -0.03)), hv(-0.030), 0.012, 0.055, [60, 30, 28], 0.14);
      /* ear: darker in the bowl */
      blotch(t, s > 0 ? 0.262 : 0.738, hv(-0.008), 0.020, 0.060, [70, 34, 30], 0.16);
    }
    /* mouth */
    var mu0 = hu(ang(-0.0245, -0.07)), mu1 = hu(ang(0.0245, -0.07)), mv = hv(-0.0705);
    var lip = mixc(sk, [150, 62, 66], 0.52);
    g.save();
    g.fillStyle = css(lip, 1, 0.80);
    g.beginPath(); g.moveTo(t.X(mu0), t.Y(mv));
    g.quadraticCurveTo(t.X(lerp(mu0, mu1, 0.30)), t.Y(mv + 0.022), t.X(0.5), t.Y(mv + 0.013));
    g.quadraticCurveTo(t.X(lerp(mu0, mu1, 0.70)), t.Y(mv + 0.022), t.X(mu1), t.Y(mv));
    g.quadraticCurveTo(t.X(0.5), t.Y(mv - 0.030), t.X(mu0), t.Y(mv));
    g.fill();
    g.strokeStyle = 'rgba(52,22,24,.82)'; g.lineWidth = 1.8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(t.X(mu0), t.Y(mv)); g.quadraticCurveTo(t.X(0.5), t.Y(mv - 0.005), t.X(mu1), t.Y(mv)); g.stroke();
    g.restore();
    blotch(t, 0.5, mv - 0.034, 0.050, 0.018, [40, 20, 18], 0.20);         /* under the lower lip */
    blotch(t, 0.5, hv(-0.057), 0.010, 0.014, [50, 24, 22], 0.22);          /* philtrum            */
  }

  function paintHair() {
    var t = TILES.hair, hair = hexRGB((LOOK.hair && LOOK.hair.color) || '#241a13');
    var g = PAINT.g, gh = PAINT.gh;
    if (LOOK.hair && LOOK.hair.style === 'crop') {
      /* a tousled crop: matte, and no parting for the strands to agree on --
         short locks lying every way, the light ones over the dark */
      fillTile(t, [hair[0] * 0.80, hair[1] * 0.80, hair[2] * 0.80], 0.86);
      g.save(); g.beginPath(); g.rect(t.px, t.py, t.pw, t.ph); g.clip();
      gh.save(); gh.beginPath(); gh.rect(t.px, t.py, t.pw, t.ph); gh.clip();
      g.lineCap = 'round'; gh.lineCap = 'round';
      for (var c = 0; c < 1700; c++) {
        var cx = t.px + hash1(c * 3.1) * t.pw, cy = t.py + hash1(c * 5.7) * t.ph, len = 7 + hash1(c * 9.3) * 19;
        /* mostly the way it grows -- down the sheet, crown to hairline -- and never quite */
        var an = PI / 2 + (hash1(c * 6.1) - 0.5) * 1.5, curl = (hash1(c * 4.3) - 0.5) * 1.1, kk = hash1(c * 1.7);
        var ex = cx + Math.cos(an) * len, ey = cy + Math.sin(an) * len;
        var mx = (cx + ex) / 2 - Math.sin(an) * len * curl * 0.5, my = (cy + ey) / 2 + Math.cos(an) * len * curl * 0.5;
        var light = c > 700 && kk > 0.42;
        g.strokeStyle = light ? css(hair, 1.15 + (kk - 0.42) * 1.25, 0.34) : css(hair, 0.42 + kk * 0.6, 0.40);
        g.lineWidth = 1.1 + hash1(c * 2.9) * 1.7;
        g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
        gh.strokeStyle = grey(128 + (light ? 1 : -1) * (26 + kk * 40), 0.60);
        gh.lineWidth = g.lineWidth + 0.8;
        gh.beginPath(); gh.moveTo(cx, cy); gh.quadraticCurveTo(mx, my, ex, ey); gh.stroke();
      }
      g.restore(); gh.restore();
      return;
    }
    fillTile(t, hair, 0.50);
    g.save(); g.beginPath(); g.rect(t.px, t.py, t.pw, t.ph); g.clip();
    gh.save(); gh.beginPath(); gh.rect(t.px, t.py, t.pw, t.ph); gh.clip();
    /* strands run crown -> hairline, i.e. down the tile */
    for (var i = 0; i < 520; i++) {
      var x = t.px + hash1(i * 3.1) * t.pw, y = t.py + hash1(i * 5.7) * t.ph, l = 30 + hash1(i * 9.3) * 90;
      var k = hash1(i * 1.7), dx = (hash1(i * 4.3) - 0.5) * 10;
      g.strokeStyle = k > 0.5 ? css(hair, 1.0 + (k - 0.5) * 1.5, 0.30) : css(hair, 0.45 + k, 0.36);
      g.lineWidth = 1 + hash1(i * 2.9) * 1.6;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + dx, y + l * 0.5, x + dx * 0.4, y + l); g.stroke();
      gh.strokeStyle = grey(128 + (k - 0.5) * 90, 0.55);
      gh.lineWidth = g.lineWidth + 0.6;
      gh.beginPath(); gh.moveTo(x, y); gh.quadraticCurveTo(x + dx, y + l * 0.5, x + dx * 0.4, y + l); gh.stroke();
    }
    g.restore(); gh.restore();
  }

  /* Per-pixel pass: cloth grain on the colour sheet, weave on the height sheet. */
  function grainTile(col, hgt, t, amt, weave, sx, sy) {
    var W = ATLAS;
    for (var y = t.py; y < t.py + t.ph; y++) for (var x = t.px; x < t.px + t.pw; x++) {
      var o = (y * W + x) * 4;
      var n = hash1(x * 12.9898 + y * 78.233) - 0.5;
      var n2 = hash1(Math.floor(x / 3) * 3.17 + Math.floor(y / 3) * 91.7) - 0.5;
      var k = 1 + (n * 0.6 + n2 * 0.4) * amt;
      col[o] = clamp(col[o] * k, 0, 255); col[o + 1] = clamp(col[o + 1] * k, 0, 255); col[o + 2] = clamp(col[o + 2] * k, 0, 255);
      if (weave > 0) {
        /* a twill: diagonal ribs, broken by the grain */
        var wv = Math.sin((x * sx + y * sy) * 1.9) * 0.6 + Math.sin((x * sx - y * sy) * 0.83) * 0.25 + n * 0.9;
        var h = hgt[o] + wv * weave;
        hgt[o] = hgt[o + 1] = hgt[o + 2] = clamp(h, 0, 255);
        if (weave > 3) {
          var kk = 1 + Math.sin((x * sx + y * sy) * 1.9) * 0.035;
          col[o] = clamp(col[o] * kk, 0, 255); col[o + 1] = clamp(col[o + 1] * kk, 0, 255); col[o + 2] = clamp(col[o + 2] * kk, 0, 255);
        }
      }
    }
  }

  function bakeAtlas() {
    var doc = global.document;
    function mk() { var c = doc.createElement('canvas'); c.width = c.height = ATLAS; return c; }
    var cc = mk(), ch = mk(), cr = mk();
    PAINT = {
      g: cc.getContext('2d', { willReadFrequently: true }),
      gh: ch.getContext('2d', { willReadFrequently: true }),
      gr: cr.getContext('2d', { willReadFrequently: true })
    };
    PAINT.g.fillStyle = '#808080'; PAINT.g.fillRect(0, 0, ATLAS, ATLAS);
    PAINT.gh.fillStyle = grey(128); PAINT.gh.fillRect(0, 0, ATLAS, ATLAS);
    PAINT.gr.fillStyle = grey(0.8 * 255); PAINT.gr.fillRect(0, 0, ATLAS, ATLAS);

    var T = topSpec();
    paintSkin();
    paintBottom(T);       /* fills the whole torso tile first ...            */
    paintTop(T);          /* ... then the garment goes over the top of it    */
    paintShoes();
    paintHead();
    paintHair();

    var ic = PAINT.g.getImageData(0, 0, ATLAS, ATLAS), ih = PAINT.gh.getImageData(0, 0, ATLAS, ATLAS);
    var jeans = (LOOK.bottom.type || 'jeans') === 'jeans';
    var knit = T.type === 'hoodie' || T.type === 'tshirt' || T.type === 'sweater';
    grainTile(ic.data, ih.data, TILES.torso, 0.10, knit ? 3.0 : 4.5, knit ? 0.9 : 0.62, knit ? 0.0 : 0.62);
    grainTile(ic.data, ih.data, TILES.sleeve, 0.10, knit ? 3.0 : 4.5, knit ? 0.9 : 0.62, knit ? 0.0 : 0.62);
    grainTile(ic.data, ih.data, TILES.leg, jeans ? 0.16 : 0.09, jeans ? 6.5 : 3.5, 0.70, 0.70);
    grainTile(ic.data, ih.data, TILES.shoe, 0.06, 2.0, 0.8, 0.3);
    grainTile(ic.data, ih.data, TILES.skin, 0.035, 1.2, 0.5, 0.9);
    grainTile(ic.data, ih.data, TILES.head, 0.030, 1.0, 0.5, 0.9);
    grainTile(ic.data, ih.data, TILES.hair, 0.10, 0, 1, 1);
    grainTile(ic.data, ih.data, TILES.trim, 0.08, 3.0, 0.9, 0.0);
    grainTile(ic.data, ih.data, TILES.under, 0.05, 2.0, 0.9, 0.0);
    if (T.crew) crewSkin(ic.data, ih.data);
    PAINT.g.putImageData(ic, 0, 0);

    /* height -> tangent-space normal. v runs UP the sheet (flipY), canvas y
       runs down, so +dH/dv is H(y-1) - H(y+1). */
    var H = ih.data, nrm = PAINT.gh.createImageData(ATLAS, ATLAS), N = nrm.data, S = 2.4 / 255;
    for (var y = 0; y < ATLAS; y++) {
      var ym = y > 0 ? y - 1 : y, yp = y < ATLAS - 1 ? y + 1 : y;
      for (var x = 0; x < ATLAS; x++) {
        var xm = x > 0 ? x - 1 : x, xp = x < ATLAS - 1 ? x + 1 : x;
        var dx = (H[(y * ATLAS + xp) * 4] - H[(y * ATLAS + xm) * 4]) * S;
        var dy = (H[(ym * ATLAS + x) * 4] - H[(yp * ATLAS + x) * 4]) * S;
        var l = 1 / Math.sqrt(dx * dx + dy * dy + 1), o = (y * ATLAS + x) * 4;
        N[o] = (-dx * l * 0.5 + 0.5) * 255; N[o + 1] = (-dy * l * 0.5 + 0.5) * 255; N[o + 2] = (l * 0.5 + 0.5) * 255; N[o + 3] = 255;
      }
    }
    PAINT.gh.putImageData(nrm, 0, 0);

    var aniso = 8;
    try { aniso = Math.min(8, NZ.ctx.renderer.capabilities.getMaxAnisotropy()); } catch (e) { }
    function tex(c, srgb) {
      var tx = new THREE.CanvasTexture(c);
      tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
      tx.anisotropy = aniso;
      if (srgb) tx.encoding = THREE.sRGBEncoding;
      tx.needsUpdate = true;
      return tx;
    }
    var out = { map: tex(cc, true), normalMap: tex(ch, false), roughnessMap: tex(cr, false), canvas: cc, normalCanvas: ch };
    PAINT = null;
    return out;
  }

  /* =========================================================================
     8. ASSEMBLY
     ====================================================================== */
  var HERO = null;

  /* How each weapon is carried. The key is WPN[i].vm. */
  var GUNCLS = {
    pistol: 'pistol', shotgun: 'long', rifle: 'long', ak: 'long', m4: 'long', dmr: 'long', nullstar: 'long',
    chaingun: 'heavy', rpg: 'launcher', grenade: 'grenade'
  };

  function makeState() {
    return {
      init: false, t: 0, px: 0, pz: 0, vx: 0, vz: 0, speed: 0,
      phase: 0, moveK: 0, runK: 0, crouchK: 0, proneK: 0, airK: 0, deadK: 0, deadT: 0, deadSide: 1,
      hipYaw: 0, mdx: 0, mdz: -1, eyeS: 1.71, wasGround: true, lastVy: 0,
      land: new Spring(0, 240, 0.42),
      recoil: new Spring(0, 620, 0.52), recoilUp: new Spring(0, 520, 0.5),
      flinchP: new Spring(0, 210, 0.5), flinchR: new Spring(0, 200, 0.5),
      sway: new Spring(0, 60, 0.7),
      lowK: 0, adsK: 0, dashK: 0, aimPitch: 0,
      lastAmmo: -1, lastWeapon: -1, key: '', flashT: 0, flashSeed: 0, throwT: -1, reloadT: -1, reloadDur: 1.5,
      hurtPrev: 0, breath: 0,
      gunYaw: 0, gunPitch: 0, gunInit: false
    };
  }

  function makeGunMat(src) {
    var m = src.clone();
    /* The viewmodel material carries an OWN onBeforeCompile that opts it out
       of nz-render's scene patch (it lives in a private scene with private
       lights). clone() does not copy own function properties, but be explicit:
       in the world this gun must take the same AO, shadows and reflections as
       the hands holding it. */
    try { delete m.onBeforeCompile; delete m.customProgramCacheKey; } catch (e) { }
    m.name = 'nz-hero-gun';
    m.envMapIntensity = 1;
    m.needsUpdate = true;
    return m;
  }

  function buildGuns(H) {
    var src = null, key;
    try { src = NZ.weapons && NZ.weapons.internals && NZ.weapons.internals.WEAPONS; } catch (e) { src = null; }
    var gunMat = null, n = 0;
    if (src) for (key in src) {
      var A = src[key];
      if (!A || !A.root || !A.gripR || !A.gripL) continue;
      /* Instance, do not rebuild: clone(true) shares every BufferGeometry with
         the first-person asset, so the world gun costs a handful of Object3Ds. */
      var node = A.root.clone(true), kill = [];
      node.traverse(function (o) { if (o.name === 'handR' || o.name === 'handL') kill.push(o); });
      for (var k = 0; k < kill.length; k++) if (kill[k].parent) kill[k].parent.remove(kill[k]);
      node.traverse(function (o) {
        if (!o.isMesh) return;
        if (!gunMat) gunMat = makeGunMat(o.material);
        o.material = gunMat; o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      });
      /* parts the first-person animation may have left mid-stroke */
      node.traverse(function (o) {
        if (o.name === 'slide' || o.name === 'pump' || o.name === 'mag' || o.name === 'barrels') {
          if (o.name !== 'mag') o.position.set(0, 0, 0);
          o.rotation.set(0, 0, 0);
        }
        if (o.name === 'rocket' || o.name === 'payload' || o.name === 'nade') o.visible = true;
        if (o.name === 'shell' || o.name === 'can') o.visible = false;
      });
      node.name = 'nz-hero-' + key;
      node.position.set(0, 0, 0); node.rotation.set(0, 0, 0); node.scale.set(1, 1, 1);
      node.visible = false;
      H.gun.add(node);
      H.guns[key] = {
        node: node, cls: GUNCLS[key] || 'long',
        muzzle: (A.muzzleBare || A.muzzle || [0, 0.04, -0.5]).slice(),
        muzzleCan: A.muzzleCan ? A.muzzleCan.slice() : null,
        gripR: A.gripR.p.slice(), gripL: A.gripL.p.slice(),
        sightY: fin(A.sight && A.sight[1], 0.06),
        butt: A.bbox ? A.bbox.max[2] : 0.2,
        can: node.getObjectByName('can') || null
      };
      n++;
    }
    if (!n) {
      /* nz-weapons is absent or tore itself down: two plain stand-ins so the
         figure is never empty-handed */
      var dark = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.55, metalness: 0.6 });
      dark.name = 'nz-hero-gun';
      var mkBox = function (w, h, d, x, y, z) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), dark);
        m.position.set(x, y, z); m.castShadow = true; return m;
      };
      var pist = new THREE.Group();
      pist.add(mkBox(0.028, 0.030, 0.19, 0, 0.022, -0.085)); pist.add(mkBox(0.026, 0.10, 0.036, 0, -0.045, 0.012));
      var longg = new THREE.Group();
      longg.add(mkBox(0.04, 0.055, 0.50, 0, 0.03, -0.20)); longg.add(mkBox(0.028, 0.028, 0.34, 0, 0.042, -0.52));
      longg.add(mkBox(0.034, 0.075, 0.24, 0, 0.0, 0.14)); longg.add(mkBox(0.028, 0.10, 0.036, 0, -0.05, 0.016));
      longg.add(mkBox(0.026, 0.13, 0.05, 0, -0.07, -0.10));
      pist.visible = longg.visible = false;
      H.gun.add(pist); H.gun.add(longg);
      var gp = { node: pist, cls: 'pistol', muzzle: [0, 0.02, -0.18], gripR: [0, -0.03, 0.008], gripL: [-0.022, -0.042, 0.011], sightY: 0.04, butt: 0.03, can: null };
      var gl = { node: longg, cls: 'long', muzzle: [0, 0.042, -0.69], gripR: [0, -0.033, 0.016], gripL: [-0.02, 0.04, -0.21], sightY: 0.07, butt: 0.26, can: null };
      for (key in GUNCLS) H.guns[key] = GUNCLS[key] === 'pistol' ? gp : gl;
    }
  }

  function buildHero() {
    if (!SK.name.length) defineSkeleton();
    var scene = NZ.ctx.scene, i;

    var pile = new Pile();
    var T = buildTorso(pile);
    buildNeck(pile);
    buildCollar(pile, T);
    buildHood(pile, T);
    buildArm(pile, 1, T); buildArm(pile, -1, T);
    buildLeg(pile, 1); buildLeg(pile, -1);
    buildShoe(pile, 1); buildShoe(pile, -1);
    buildHand(pile, 1); buildHand(pile, -1);
    buildHead(pile);
    buildHair(pile);
    var geo = pileToGeometry(pile);

    /* The picture is the LOCAL figure's. A figure built from a look without
       one (a multiplayer puppet, section 11) must leave the loader alone, or
       it would cancel a picture that is still arriving. */
    if (LOOK.face && LOOK.face.image) loadFace(repaintAtlas);
    var tex = bakeAtlas();
    var mat = new THREE.MeshStandardMaterial({
      map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
      roughness: 1, metalness: 0, vertexColors: true
    });
    mat.normalScale.set(1, 1);
    mat.envMapIntensity = 1;
    mat.name = 'nz-hero';

    var bones = [], inv = [];
    for (i = 0; i < SK.name.length; i++) {
      var b = new THREE.Bone(), p = SK.pos[i], pp = SK.parent[i] >= 0 ? SK.pos[SK.parent[i]] : [0, 0, 0];
      b.name = SK.name[i];
      b.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      bones.push(b);
      if (SK.parent[i] >= 0) bones[SK.parent[i]].add(b);
      inv.push(new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]));
    }
    var skeleton = new THREE.Skeleton(bones, inv);

    var root = new THREE.Group();
    root.name = 'nz-hero';
    root.rotation.order = 'YXZ';
    root.visible = false;
    var mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.name = 'nz-hero-body';
    root.add(bones[0]);
    root.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    /* the bind-pose bounding sphere says nothing about a man lying prone */
    mesh.frustumCulled = false;
    mesh.castShadow = true; mesh.receiveShadow = true;
    var gun = new THREE.Group();
    gun.name = 'nz-hero-gun';
    root.add(gun);
    scene.add(root);

    /* the same soft floor receiver every operator stands on */
    var shadow = null;
    try {
      var sm = new THREE.MeshBasicMaterial({
        map: (G.PICKTEX && G.PICKTEX.enemyShadow) || null, color: 0x232a33, transparent: true, opacity: 0.44,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, fog: true
      });
      sm.name = 'nzContactShadow';
      shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.95, 2.95), sm);
      shadow.name = 'heroContactShadow';
      shadow.rotation.x = -PI / 2; shadow.renderOrder = 0; shadow.visible = false;
      scene.add(shadow);
    } catch (e) { shadow = null; }

    /* muzzle flash: two frames of additive card at the crown */
    var flash = null;
    try {
      var fm = new THREE.SpriteMaterial({
        map: (G.PICKTEX && G.PICKTEX.spark) || null, color: 0xffd7a0, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false
      });
      flash = new THREE.Sprite(fm);
      flash.name = 'nz-hero-flash'; flash.visible = false; flash.renderOrder = 4;
      scene.add(flash);
    } catch (e2) { flash = null; }

    HERO = {
      root: root, mesh: mesh, mat: mat, tex: tex, bones: bones, skeleton: skeleton,
      gun: gun, guns: {}, cur: null, shadow: shadow, flash: flash,
      st: makeState(), muzzleW: new THREE.Vector3(), muzzleOK: false,
      verts: pile.n, tris: pile.ix.length / 3,
      /* this figure's own stature: the animator scales by it, and a puppet's
         is not the local player's */
      tall: heroTall()
    };
    buildGuns(HERO);
    initPose();
    return HERO;
  }

  /* The face picture arrives after the figure is built (an image decodes off
     the main thread even from a data: URL): repaint the sheets and swap them
     in under the material that is already on screen. */
  function repaintAtlas() {
    var H = HERO;
    if (!H || DEAD) return;
    try {
      var old = H.tex, nt = bakeAtlas();
      H.mat.map = nt.map; H.mat.normalMap = nt.normalMap; H.mat.roughnessMap = nt.roughnessMap;
      H.mat.needsUpdate = true;
      H.tex = nt;
      old.map.dispose(); old.normalMap.dispose(); old.roughnessMap.dispose();
      NZ.log('hero: face picture applied');
    } catch (err) { panic(err, 'face'); }
  }

  function disposeHero() {
    var H = HERO;
    if (!H) return;
    try {
      if (H.root.parent) H.root.parent.remove(H.root);
      if (H.shadow && H.shadow.parent) H.shadow.parent.remove(H.shadow);
      if (H.flash && H.flash.parent) H.flash.parent.remove(H.flash);
      H.mesh.geometry.dispose(); H.mat.dispose();
      H.tex.map.dispose(); H.tex.normalMap.dispose(); H.tex.roughnessMap.dispose();
    } catch (e) { }
    HERO = null;
  }

  /* =========================================================================
     9. THE ANIMATOR
     Nothing here plays back. Every frame the pose is SOLVED from what the
     player is doing:

       gait      the cycle advances by distance really travelled, so the feet
                 turn over at the speed the body moves and stop when it stops
       legs      a foot path per phase (stance on the ground, swing over it),
                 two-bone IK from wherever the pelvis is
       trunk     pelvis turned toward the direction of travel, spine turned
                 back to the aim, so a strafe is a run with the chest held on
                 target and not a sideways shuffle
       weapon    posed in the AIM frame at the eye, pointed at the world point
                 the crosshair covers; both wrists then solved onto its grips
       head      the pelvis is finally moved so the eyes sit exactly where the
                 first-person camera would be -- crouch and crawl heights are
                 therefore the game's, not an animator's guess

     All of it runs in root space: metres, +Y up, -Z forward, +X right.
     ====================================================================== */
  var V = null;     /* temporaries, allocated once THREE exists */
  var QW = [], PW = [];
  var ARM_BIND_INV = [null, null];

  /* hand grip frames: where the hand's own X (thumb side), Y (toward the
     knuckles) and Z (out of the palm) point, in WEAPON axes */
  var GRIPS = {
    R: [[0, 0.980, -0.199], [0, -0.199, -0.980], [-1, 0, 0]],          /* pistol grip, raked    */
    under: [[0.907, 0, 0.420], [0.420, 0, -0.907], [0, 1, 0]],          /* palm up under a forend */
    wrap: [[0, -0.907, 0.420], [0, -0.420, -0.907], [1, 0, 0]],         /* round the firing hand  */
    vgrip: [[0, -0.980, 0.199], [0, -0.199, -0.980], [1, 0, 0]]         /* vertical foregrip      */
  };
  var PALM = [0.004, 0.060, 0.017];        /* palm centre in the hand's frame (right hand) */

  /* Where the weapon's origin (the web of the firing hand) sits relative to
     the eye, in the aim frame: [right, up, forward]. `sight` rows are measured
     from the sight line, i.e. the weapon's own sight height is taken off. */
  var CARRY = {
    pistol: {
      ready: [0.028, -0.085, 0.470], ads: [0.010, -0.004, 0.500], sight: true, cant: 0.0, left: 'wrap',
      dashP: [0.10, -0.36, 0.30], dashR: [-0.80, 0.30, 0.0], lowP: [0.10, -0.42, 0.24], lowR: [-1.15, 0.2, 0]
    },
    long: {
      ready: [0.088, -0.070, 0.205], ads: [0.058, -0.006, 0.185], sight: true, cant: 0.10, left: 'under',
      dashP: [0.030, -0.300, 0.215], dashR: [0.55, 0.95, -0.30], lowP: [0.10, -0.26, 0.20], lowR: [-0.95, 0.25, 0.15]
    },
    heavy: {
      ready: [0.220, -0.520, 0.170], ads: [0.200, -0.450, 0.200], sight: false, cant: 0.05, left: 'vgrip',
      dashP: [0.215, -0.540, 0.140], dashR: [-0.30, 0.20, 0.0], lowP: [0.22, -0.60, 0.12], lowR: [-0.80, 0.15, 0]
    },
    launcher: {
      ready: [0.158, -0.128, 0.110], ads: [0.150, -0.105, 0.110], sight: false, cant: 0.0, left: 'vgrip',
      dashP: [0.150, -0.240, 0.140], dashR: [0.40, 0.35, 0.0], lowP: [0.16, -0.34, 0.14], lowR: [-0.85, 0.2, 0]
    },
    grenade: {
      ready: [0.215, -0.330, 0.250], ads: [0.200, -0.180, 0.200], sight: false, cant: 0.0, left: null,
      dashP: [0.24, -0.46, 0.14], dashR: [0, 0, 0], lowP: [0.22, -0.50, 0.14], lowR: [0, 0, 0]
    }
  };

  function initPose() {
    if (!V) {
      V = {
        a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(),
        e: new THREE.Vector3(), f: new THREE.Vector3(), g: new THREE.Vector3(), h: new THREE.Vector3(),
        x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(),
        q: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(), q4: new THREE.Quaternion(),
        m: new THREE.Matrix4(), eu: new THREE.Euler(0, 0, 0, 'YXZ'),
        knee: new THREE.Vector3(), end: new THREE.Vector3(),
        gunP: new THREE.Vector3(), gunQ: new THREE.Quaternion(),
        aimF: new THREE.Vector3(), aimR: new THREE.Vector3(), aimU: new THREE.Vector3(),
        tR: new THREE.Vector3(), tL: new THREE.Vector3(), hR: new THREE.Quaternion(), hL: new THREE.Quaternion()
      };
      for (var i = 0; i < SK.name.length; i++) { QW.push(new THREE.Quaternion()); PW.push(new THREE.Vector3()); }
      /* The arm bones are bound pointing down-and-out (A-pose), so their bind
         frame is not the identity one the legs enjoy. frame(-d0, back) is what
         the solver's frame has to be measured against. */
      for (var s = 0; s < 2; s++) {
        var sg = s ? -1 : 1;
        V.y.set(-sg * Math.sin(A_POSE), Math.cos(A_POSE), 0);       /* -d0 */
        V.z.set(0, 0, 1);
        V.x.crossVectors(V.y, V.z);
        V.m.makeBasis(V.x, V.y, V.z);
        ARM_BIND_INV[s] = new THREE.Quaternion().setFromRotationMatrix(V.m).invert();
      }
    }
  }

  function qEuler(out, rx, ry, rz) { V.eu.set(rx, ry, rz, 'YXZ'); return out.setFromEuler(V.eu); }
  /* rotation whose +Y is `up` and whose +Z is as near `back` as that allows */
  function qFrame(out, up, back) {
    V.y.copy(up).normalize();
    V.z.copy(back).addScaledVector(V.y, -back.dot(V.y));
    if (V.z.lengthSq() < 1e-8) V.z.set(0, 0, 1).addScaledVector(V.y, -V.y.z);
    V.z.normalize();
    V.x.crossVectors(V.y, V.z);
    V.m.makeBasis(V.x, V.y, V.z);
    return out.setFromRotationMatrix(V.m);
  }
  /* rotation from three basis columns given as plain arrays */
  function qBasis(out, B) {
    V.x.set(B[0][0], B[0][1], B[0][2]); V.y.set(B[1][0], B[1][1], B[1][2]); V.z.set(B[2][0], B[2][1], B[2][2]);
    V.m.makeBasis(V.x, V.y, V.z);
    return out.setFromRotationMatrix(V.m);
  }

  /* Analytic two-bone IK. A = root joint, T = target, pole = the way the
     middle joint should bend. Writes V.knee and V.end (the reachable target). */
  function ik2(A, T, L1, L2, pole) {
    var dx = T.x - A.x, dy = T.y - A.y, dz = T.z - A.z;
    var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-5) { dx = 0; dy = -1; dz = 0; dist = 1e-5; }
    var ux = dx / dist, uy = dy / dist, uz = dz / dist;
    var d = clamp(dist, Math.abs(L1 - L2) + 0.002, L1 + L2 - 0.0015);
    var a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    var h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    var pd = pole.x * ux + pole.y * uy + pole.z * uz;
    var px = pole.x - ux * pd, py = pole.y - uy * pd, pz = pole.z - uz * pd;
    var pl = Math.sqrt(px * px + py * py + pz * pz);
    if (pl < 1e-5) { px = 0; py = 0; pz = -1; pl = 1; }
    px /= pl; py /= pl; pz /= pl;
    V.knee.set(A.x + ux * a + px * h, A.y + uy * a + py * h, A.z + uz * a + pz * h);
    V.end.set(A.x + ux * d, A.y + uy * d, A.z + uz * d);
    return dist <= L1 + L2;
  }

  /* cycle length (two steps), metres, against speed in m/s */
  var STRIDE = [[0, 1.20], [1.4, 1.45], [3.1, 2.15], [4.3, 2.75], [6.0, 3.50], [8.4, 4.30]];
  function strideAt(v) {
    for (var i = 0; i < STRIDE.length - 1; i++) if (v <= STRIDE[i + 1][0])
      return lerp(STRIDE[i][1], STRIDE[i + 1][1], (v - STRIDE[i][0]) / (STRIDE[i + 1][0] - STRIDE[i][0]));
    return STRIDE[STRIDE.length - 1][1];
  }

  /* One foot at phase `phi` of its own cycle. out = [along, up, pitch, load]
       along  metres ahead of the hip along the direction of travel
       up     ankle lift above its standing height
       pitch  toe-down angle of the foot (negative = toe up) */
  function footPath(phi, duty, Af, Ab, lift, runK, out) {
    if (phi < duty) {
      var s = phi / duty;
      var heel = band(s, 0.60, 1.0);                /* heel coming off the floor */
      var pitch = -lerp(0.26, 0.08, runK) * (1 - band(s, 0.0, 0.16)) + lerp(0.62, 0.95, runK) * heel * heel;
      out[0] = lerp(Af, -Ab, s);
      out[1] = 0.118 * Math.sin(Math.max(0, pitch));
      out[2] = pitch;
      out[3] = 1;
    } else {
      var u = (phi - duty) / (1 - duty);
      var toe = lerp(0.62, 0.95, runK);
      /* the foot keeps going back and up before it comes through */
      var e = sstep(u), carry = lerp(0.02, 0.16, runK) * Math.sin(PI * Math.min(1, u * 1.6)) * (1 - u);
      out[0] = lerp(-Ab, Af, e) - carry;
      out[1] = 0.118 * Math.sin(toe) * (1 - band(u, 0, 0.35)) + lift * Math.sin(PI * Math.pow(u, lerp(0.95, 0.72, runK)));
      out[2] = lerp(toe + lerp(0.10, 0.55, runK) * Math.sin(PI * Math.min(1, u / 0.55)), -lerp(0.26, 0.08, runK), band(u, 0.42, 0.96));
      out[3] = 0;
    }
    return out;
  }
  var _fp = [0, 0, 0, 0];

  /* Forward kinematics up the spine from the pelvis. */
  function fkSpine(lq) {
    var ch = ['spine', 'chest', 'neck', 'head'];
    for (var i = 0; i < ch.length; i++) {
      var b = bi(ch[i]), p = SK.parent[b], bp0 = SK.pos[b], pp = SK.pos[p];
      V.a.set(bp0[0] - pp[0], bp0[1] - pp[1], bp0[2] - pp[2]).applyQuaternion(QW[p]);
      PW[b].copy(PW[p]).add(V.a);
      QW[b].copy(QW[p]).multiply(lq[i]);
    }
  }
  var LQ = null;
  /* positions only, from rotations that are already final */
  function fkSpinePos() {
    for (var b = 1; b <= 4; b++) {
      var p = SK.parent[b], bp0 = SK.pos[b], pp = SK.pos[p];
      V.a.set(bp0[0] - pp[0], bp0[1] - pp[1], bp0[2] - pp[2]).applyQuaternion(QW[p]);
      PW[b].copy(PW[p]).add(V.a);
    }
  }
  /* a solved pose can be parked and blended against the next one */
  var PARK = null;
  function parkPose() {
    var i;
    if (!PARK) { PARK = { q: [], p: new THREE.Vector3() }; for (i = 0; i < SK.name.length; i++) PARK.q.push(new THREE.Quaternion()); }
    for (i = 0; i < SK.name.length; i++) PARK.q[i].copy(QW[i]);
    PARK.p.copy(PW[0]);
  }
  function blendFromPark(k) {
    for (var i = 0; i < SK.name.length; i++) { V.q.copy(PARK.q[i]).slerp(QW[i], k); QW[i].copy(V.q); }
    V.a.copy(PARK.p).lerp(PW[0], k); PW[0].copy(V.a);
    fkSpinePos();
  }

  /* Lying on the ground, facing the aim: propped on the elbows, legs out
     behind, one knee drawing up as the crawl turns over. */
  function solveProne(cyc, moveK, aimPitch, eyeY) {
    var hp = bi('hips'), hdI = bi('head'), chI = bi('chest'), s;
    var sw = Math.sin(cyc) * moveK;
    PW[hp].set(sw * 0.020, 0.120, 0.62);
    qEuler(QW[hp], -(PI / 2 - 0.10), sw * 0.07, sw * 0.10);
    qEuler(LQ[0], 0.24, -sw * 0.05, -sw * 0.05);
    qEuler(LQ[1], 0.32, -sw * 0.04, -sw * 0.05);
    LQ[2].identity(); LQ[3].identity();
    fkSpine(LQ);
    qEuler(V.q, clamp(aimPitch, -0.5, 0.6) * 0.7, HERO.st.gunYaw * 0.3, 0);
    V.q2.copy(QW[chI]).invert().multiply(V.q);
    LQ[2].identity().slerp(V.q2, 0.42);
    V.q3.copy(QW[chI]).multiply(LQ[2]);
    LQ[3].copy(V.q3).invert().multiply(V.q);
    fkSpine(LQ);
    /* slide the whole body so the eyes are over the player's position */
    V.a.set(0, 0.085, -0.020).applyQuaternion(QW[hdI]).add(PW[hdI]);
    V.b.set(-V.a.x, clamp(eyeY - V.a.y, -0.03, 0.05), -V.a.z);
    for (var i = 0; i <= hdI; i++) PW[i].add(V.b);
    for (s = 0; s < 2; s++) {
      var sg = s ? -1 : 1, S = s ? 'L' : 'R';
      var k = Math.max(0, Math.sin(cyc + (s ? PI : 0))) * moveK;
      V.f.set(sg * (0.135 + 0.13 * k), 0.058, PW[hp].z + 0.835 - 0.36 * k);
      V.g.set(sg * (0.10 + 1.0 * k), -1.0 + 0.5 * k, -0.2 * k);
      V.h.set(sg * 0.10, -0.16, 0.98);
      V.d.set(0, -0.98, -0.16);
      solveLeg(S, V.f, V.g, V.h, V.d, 0);
    }
  }

  /* Down. Face to the floor, one knee out, arms where they fell. */
  function solveDead(side) {
    var hp = bi('hips'), hdI = bi('head'), chI = bi('chest'), s;
    PW[hp].set(side * 0.03, 0.108, 0.30);
    qEuler(QW[hp], -(PI / 2 - 0.02), side * 0.10, side * 0.16);
    qEuler(LQ[0], -0.03, side * 0.06, 0);
    qEuler(LQ[1], -0.05, side * 0.08, side * 0.05);
    qEuler(LQ[2], 0.10, side * 0.45, 0);
    qEuler(LQ[3], 0.10, side * 0.55, side * 0.10);
    fkSpine(LQ);
    void hdI; void chI;
    for (s = 0; s < 2; s++) {
      var sg = s ? -1 : 1, S = s ? 'L' : 'R';
      var bent = (sg === side) ? 1 : 0;
      V.f.set(sg * (0.16 + 0.20 * bent), 0.058, PW[hp].z + 0.83 - 0.30 * bent);
      V.g.set(sg * (0.15 + 1.2 * bent), -1.0 + 0.6 * bent, 0);
      V.h.set(sg * 0.35, -0.10, 0.93);
      V.d.set(0, -0.99, -0.10);
      solveLeg(S, V.f, V.g, V.h, V.d, 0);
    }
  }

  /* Solve one leg onto an ankle target and write thigh / shin / foot / toe. */
  function solveLeg(S, ankle, pole, footFwd, footUp, toeBend) {
    var th = bi('thigh' + S), sh = bi('shin' + S), ft = bi('foot' + S), to = bi('toe' + S), hp = bi('hips');
    var bt = SK.pos[th], bh = SK.pos[hp];
    V.a.set(bt[0] - bh[0], bt[1] - bh[1], bt[2] - bh[2]).applyQuaternion(QW[hp]);
    PW[th].copy(PW[hp]).add(V.a);
    ik2(PW[th], ankle, LEN.thigh, LEN.shin, pole);
    PW[sh].copy(V.knee); PW[ft].copy(V.end);
    /* bind frame of a leg bone is the identity: +Y up the bone, +Z behind the knee */
    V.b.subVectors(PW[th], V.knee);
    V.c.copy(pole).multiplyScalar(-1);
    qFrame(QW[th], V.b, V.c);
    V.b.subVectors(V.knee, V.end);
    qFrame(QW[sh], V.b, V.c);
    /* qFrame keeps `up` and bends `back`; a foot wants its toe line kept */
    V.z.copy(footFwd).multiplyScalar(-1).normalize();
    V.y.copy(footUp).addScaledVector(V.z, -footUp.dot(V.z)).normalize();
    V.x.crossVectors(V.y, V.z);
    V.m.makeBasis(V.x, V.y, V.z);
    QW[ft].setFromRotationMatrix(V.m);
    QW[to].copy(QW[ft]).multiply(qEuler(V.q4, toeBend, 0, 0));
    PW[to].copy(PW[ft]);
  }

  /* Solve one arm onto a wrist target; hand orientation is given. */
  function solveArm(side, wrist, handQ, pole, shrug) {
    var S = side > 0 ? 'R' : 'L', s = side > 0 ? 0 : 1;
    var cl = bi('clav' + S), ar = bi('arm' + S), fo = bi('fore' + S), ha = bi('hand' + S), ch = bi('chest');
    var bc = SK.pos[ch], ba = SK.pos[ar];
    QW[cl].copy(QW[ch]);
    V.a.set(ba[0] - bc[0], ba[1] - bc[1], ba[2] - bc[2]).add(shrug).applyQuaternion(QW[ch]);
    PW[ar].copy(PW[ch]).add(V.a);
    PW[cl].copy(PW[ar]);
    ik2(PW[ar], wrist, LEN.upper, LEN.fore, pole);
    PW[fo].copy(V.knee); PW[ha].copy(V.end);
    /* frame: +Y back up the bone, +Z toward the elbow's bend (the pole) */
    V.b.subVectors(PW[ar], V.knee);
    qFrame(QW[ar], V.b, pole).multiply(ARM_BIND_INV[s]);
    V.b.subVectors(V.knee, V.end);
    qFrame(QW[fo], V.b, pole).multiply(ARM_BIND_INV[s]);
    QW[ha].copy(handQ);
  }

  /* world rotations -> the local ones three.js wants, down the hierarchy */
  function writeBones() {
    var B = HERO.bones;
    for (var i = 0; i < B.length; i++) {
      var p = SK.parent[i];
      if (p < 0) { B[i].quaternion.copy(QW[i]); B[i].position.copy(PW[i]); }
      else B[i].quaternion.copy(V.q.copy(QW[p]).invert().multiply(QW[i]));
    }
  }

  /* ---- events ------------------------------------------------------------ */
  function heroReload() {
    var st = HERO.st, P = G.player, W = G.WPN[P.weapon] || {};
    if (st.reloadT >= 0 || W.thrown || !P.alive || P.pending >= 0) return;
    var cls = HERO.cur ? HERO.cur.cls : 'long';
    st.reloadDur = cls === 'pistol' ? 1.35 : cls === 'heavy' ? 2.2 : cls === 'launcher' ? 1.0 : 1.7;
    st.reloadT = 0;
  }

  function setGun(key) {
    var H = HERO, g = H.guns[key] || H.guns.pistol || null;
    if (H.cur === g) return;
    if (H.cur && H.cur.node) H.cur.node.visible = false;
    H.cur = g;
    if (g && g.node) g.node.visible = true;
    H.st.reloadT = -1; H.st.throwT = -1;
  }

  function animateHero(dt) {
    var H = HERO, st = H.st, P = G.player, MU = G.M, HS = MU * fin(H.tall, 1), W = G.WPN[P.weapon] || {};
    var i, s;
    if (!LQ) LQ = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
    st.t += dt;

    /* ================= 1. ground truth =================================== */
    if (!st.init) { st.init = true; st.px = P.x; st.pz = P.z; st.eyeS = fin(P.eyeH, G.EYE) / MU; }
    var dxw = P.x - st.px, dzw = P.z - st.pz;
    st.px = P.x; st.pz = P.z;
    var movedU = Math.sqrt(dxw * dxw + dzw * dzw);
    if (movedU > 4 || dt <= 0) { dxw = 0; dzw = 0; movedU = 0; }       /* teleport, or the clock is stopped */
    if (dt > 0) {
      var kv = 1 - Math.pow(1e-7, dt);
      st.vx += (dxw / dt - st.vx) * kv; st.vz += (dzw / dt - st.vz) * kv;
    }
    var yaw = P.yaw, sy = Math.sin(yaw), cy = Math.cos(yaw);
    /* body-space velocity, m/s: forward and to the right */
    var vf = -(st.vx * sy + st.vz * cy) / HS, vr = (st.vx * cy - st.vz * sy) / HS;
    var speed = Math.sqrt(vf * vf + vr * vr);
    st.speed = speed;
    var alive = !!P.alive;

    /* ================= 2. stance ========================================= */
    var crouchT = (alive && P.crouched && !P.crawling) ? 1 : 0;
    var proneT = (alive && P.crawling) ? 1 : 0;
    st.crouchK = damp(st.crouchK, crouchT, 2e-5, dt);
    st.proneK = damp(st.proneK, proneT, 4e-4, dt);
    st.airK = damp(st.airK, (alive && !P.onGround) ? 1 : 0, 1e-6, dt);
    st.eyeS = damp(st.eyeS, fin(P.eyeH, G.EYE) / MU, 3e-5, dt);
    if (!alive) { st.deadT += dt; if (st.deadK === 0) st.deadSide = hash1(st.t * 9.1) > 0.5 ? 1 : -1; }
    else st.deadT = 0;
    /* the knees go first; the fall to the floor follows it */
    var dieK = alive ? 0 : sstep(st.deadT / 0.42);
    st.deadK = alive ? 0 : sstep((st.deadT - 0.22) / 0.62);
    var crouchK = st.crouchK, proneK = sstep(st.proneK), airK = st.airK, deadK = st.deadK;

    var moveT = band(speed, 0.12, 0.9);
    st.moveK = damp(st.moveK, moveT, 1e-5, dt);
    st.runK = damp(st.runK, band(speed, 2.9, 5.0), 1e-4, dt);
    var moveK = st.moveK, runK = st.runK;
    var dashK = st.dashK = damp(st.dashK, clamp(fin(P.dash), 0, 1), 1e-4, dt);

    /* landing: one impulse into an under-damped spring */
    if (P.onGround && !st.wasGround && st.lastVy < -6) st.land.impulse(clamp(st.lastVy * 0.045, -2.6, 0));
    st.wasGround = !!P.onGround; st.lastVy = fin(P.vy);
    st.land.step(dt);
    var landY = clamp(st.land.x, -0.16, 0.05);

    /* ================= 3. the clock ====================================== */
    if (speed > 0.25) { st.mdx = vr / speed; st.mdz = -vf / speed; }
    var mdx = st.mdx, mdz = st.mdz;                     /* direction of travel, root space */
    var sideK = Math.abs(mdx);
    var stride = strideAt(speed) * (1 - 0.24 * sideK) * (1 - 0.30 * crouchK) * (mdz > 0.3 ? 0.82 : 1);
    var Af = lerp(0.33, 0.27, runK) * (1 - 0.30 * crouchK) * (1 - 0.35 * sideK);
    var Ab = lerp(0.37, 0.50, runK) * (1 - 0.34 * crouchK) * (1 - 0.40 * sideK);
    var duty = clamp((Af + Ab) / Math.max(0.4, stride), 0.20, 0.64);
    if (P.onGround && proneK < 0.5) st.phase += (movedU / HS) / Math.max(0.4, stride);
    else if (proneK >= 0.5) st.phase += (movedU / HS) / 0.95;
    if (st.phase > 4096) st.phase -= 4096;
    var ph = st.phase;
    var lift = lerp(0.055, 0.21, runK) * (1 + 0.45 * dashK) * (1 - 0.35 * crouchK);

    /* ================= 4. pelvis ========================================= */
    /* The hips turn toward where the legs are going; backing up, toward where
       they came from. The spine takes the same angle back out, so the chest
       stays on the aim. */
    var moveAng = Math.atan2(mdx, -mdz);                 /* 0 ahead, + to the right */
    var legAng = Math.abs(moveAng) > 1.95 ? angWrap(moveAng - PI) : moveAng;
    var hipT = -clamp(legAng, -1.0, 1.0) * 0.60 * moveK * (1 - proneK);
    st.hipYaw = damp(st.hipYaw, hipT, 5e-4, dt);
    var hipYaw = st.hipYaw;
    var back = (Math.abs(moveAng) > 1.95) ? 1 : 0;

    var cyc = ph * TAU;
    var twist = Math.sin(cyc) * lerp(0.07, 0.13, runK) * moveK * (back ? -1 : 1);
    var bob = (lerp(-0.020, 0.030, runK) * Math.cos(cyc * 2 + lerp(0, 0.9, runK)) - 0.050 * (1 - runK)) * moveK
      - 0.030 * runK * moveK;
    var swayX = Math.sin(cyc) * 0.020 * moveK * (1 - runK);
    var rollP = Math.sin(cyc) * lerp(0.035, 0.055, runK) * moveK;
    var fwdK = clamp(-mdz, -1, 1) * moveK;
    var lean = 0.035 + 0.075 * runK * fwdK + 0.120 * dashK + 0.40 * crouchK - 0.05 * airK + 0.55 * dieK;

    st.breath += dt * TAU * (0.24 + 0.30 * moveK);
    var breath = Math.sin(st.breath);

    /* aim pitch as the body sees it */
    /* the showcase (U): head level, gun lowered -- he is posing, not aiming */
    st.showK = damp(fin(st.showK), clamp(fin(st.showT), 0, 1), 3e-3, dt);
    st.aimPitch = clamp(P.pitch + fin(P.recoilPitch) * 0.6, -1.35, 1.35) * (1 - sstep(st.showK));
    var aimPitch = st.aimPitch;

    st.flinchP.step(dt); st.flinchR.step(dt);
    if (fin(P.hurtT) > st.hurtPrev + 0.2) { st.flinchP.impulse(-2.2 - hash1(st.t) * 1.4); st.flinchR.impulse((hash1(st.t * 3.3) - 0.5) * 3.2); }
    st.hurtPrev = fin(P.hurtT);
    var flP = clamp(st.flinchP.x, -0.35, 0.35), flR = clamp(st.flinchR.x, -0.3, 0.3);

    var hp = bi('hips');
    /* ---- standing / crouching --------------------------------------------- */
    PW[hp].set(swayX, 0.953 + bob + landY - 0.30 * crouchK, 0.008 + 0.16 * crouchK);
    qEuler(QW[hp], -lean * 0.55, hipYaw + twist, rollP);
    var pitchShare = aimPitch * 0.20;
    qEuler(LQ[0], -lean * 0.25 + pitchShare + flP * 0.4, -(hipYaw + twist) * 0.50 - twist * 0.25, -rollP * 0.6 + flR * 0.4);
    qEuler(LQ[1], -lean * 0.20 + pitchShare + flP * 0.6 + breath * 0.008, -(hipYaw + twist) * 0.50 - twist * 0.35, -rollP * 0.4 + flR * 0.6);
    LQ[2].identity(); LQ[3].identity();
    fkSpine(LQ);

    /* ================= 5. the weapon's aim frame ========================== */
    var key = W.vm || 'pistol';
    if (key !== st.key) { st.key = key; setGun(key); st.lastAmmo = -1; st.gunInit = false; }
    var gun = H.cur, C = CARRY[gun ? gun.cls : 'long'] || CARRY.long;
    var ads = W.altDetonate ? 0 : clamp(fin(P.ads), 0, 1);
    st.adsK = ads;

    /* events off the ammo counter, exactly as nz-weapons reads them */
    var ammo = fin(P.ammo && P.ammo[W.ammo], 0);
    if (st.lastAmmo >= 0 && ammo < st.lastAmmo && dt > 0) {
      if (W.thrown) st.throwT = 0;
      else {
        var kk = Math.sqrt(clamp(fin(W.kick, 1), 0.2, 6)) / Math.max(0.55, fin(W.weight, 1));
        st.recoil.impulse(2.4 * kk); st.recoilUp.impulse(1.5 * kk);
        st.flashT = W.rocket ? 0.07 : 0.045; st.flashSeed = hash1(st.t * 31.7);
      }
      st.reloadT = -1;
    }
    st.lastAmmo = ammo;
    st.recoil.step(dt); st.recoilUp.step(dt);
    var rec = clamp(st.recoil.x, -0.05, 0.12), recUp = clamp(st.recoilUp.x, -0.08, 0.22);

    /* holster / draw */
    var lowT = 0;
    if (P.pending >= 0) lowT = 1 - clamp(fin(P.swapT) / Math.max(0.05, fin(P.swapDur, 0.22)), 0, 1);
    else if (fin(P.raiseT) > 0) lowT = clamp(P.raiseT / Math.max(0.05, fin(P.raiseDur, 0.22)), 0, 1);
    lowT = Math.max(lowT, 0.92 * sstep(fin(st.showK)));
    st.lowK = damp(st.lowK, lowT, 1e-6, dt);
    var lowK = sstep(st.lowK);
    var carryDash = dashK * (1 - ads) * (1 - band(fin(P.cool), 0, 0.12) * 0);

    /* reload */
    var rl = -1;
    if (st.reloadT >= 0) { st.reloadT += dt; rl = st.reloadT / st.reloadDur; if (rl >= 1) { st.reloadT = -1; rl = -1; } }
    var rlK = rl < 0 ? 0 : sstep(Math.min(rl / 0.18, 1)) * sstep(Math.min((1 - rl) / 0.20, 1));

    /* throw */
    var thr = -1;
    if (st.throwT >= 0) { st.throwT += dt; thr = st.throwT / 0.52; if (thr >= 1) { st.throwT = -1; thr = -1; } }

    /* The eye, and the aim frame at it. The gun points at the world point the
       crosshair covers -- converted into root space -- so what the figure is
       visibly aiming at is what the round will hit. */
    var eyeY = st.eyeS - 0.018;
    V.e.set(0, eyeY, 0);
    var gy = 0, gp = aimPitch;
    if (cam.aimOK && VIEW.blend > 0.5 && alive) {
      /* world -> root: translate, un-yaw, un-scale */
      var wx = cam.ax - P.x, wy = cam.ay - (P.y - fin(P.stepSm)), wz = cam.az - P.z;
      var lx = (wx * cy - wz * sy) / HS, lz = (wx * sy + wz * cy) / HS, ly = wy / HS;
      var ox = lx - C.ready[0], oy = ly - (eyeY + C.ready[1]), oz = lz;
      var hd = Math.sqrt(ox * ox + oz * oz);
      if (hd > 0.9 && oz < -0.3) {
        gy = clamp(Math.atan2(-ox, -oz), -0.45, 0.45);
        gp = clamp(Math.atan2(oy, hd), aimPitch - 0.35, aimPitch + 0.35);
      }
    }
    if (!st.gunInit) { st.gunYaw = gy; st.gunPitch = gp; st.gunInit = true; }
    st.gunYaw = damp(st.gunYaw, gy, 1e-7, dt);
    st.gunPitch = damp(st.gunPitch, gp, 1e-9, dt);

    /* ================= 6. head, then put the eyes where they belong ======= */
    /* head: level with the aim, tipped onto the stock when the sights are up */
    var cheek = (gun && gun.cls === 'long') ? (0.35 + 0.65 * ads) * (1 - carryDash) * (1 - lowK) : 0;
    qEuler(V.q, aimPitch * 0.72 + 0.05 * crouchK, st.gunYaw * 0.35 - cheek * 0.05, -cheek * 0.13);
    var nk = bi('neck'), hdI = bi('head'), chI = bi('chest');
    V.q2.copy(QW[chI]).invert().multiply(V.q);          /* head target in chest space */
    LQ[2].identity().slerp(V.q2, 0.42);
    V.q3.copy(QW[chI]).multiply(LQ[2]);
    LQ[3].copy(V.q3).invert().multiply(V.q);
    fkSpine(LQ);
    /* the eye is 85 mm above the head joint and 20 mm forward of it */
    V.a.set(0, 0.085, -0.020).applyQuaternion(QW[hdI]).add(PW[hdI]);
    V.b.set(cheek * 0.022 + swayX * 0.6, eyeY + bob * 0.8 + landY - 0.40 * dieK, 0.10 * dieK).sub(V.a);
    for (i = 0; i <= hdI; i++) PW[i].add(V.b);

    /* ================= 7. legs =========================================== */
    var stag = 0.085 * (1 - moveK) * (1 - 0.5 * crouchK);      /* fighting stance, at rest */
    var chy = Math.cos(hipYaw), shy = Math.sin(hipYaw);
    for (s = 0; s < 2; s++) {
      var sg = s ? -1 : 1, S = s ? 'L' : 'R';
      var phi = fract(ph + (s ? 0.5 : 0));
      footPath(phi, duty, Af, Ab, lift, runK, _fp);
      var along = _fp[0] * moveK, up = _fp[1] * moveK, pitch = _fp[2] * moveK;
      var trackW = lerp(0.105, 0.060, runK * moveK) + 0.045 * crouchK;
      /* stance spot: under the hip, turned with the pelvis; the support (left)
         foot leads at rest */
      var bx = sg * trackW, bz = (s ? -stag : stag * 0.8) + 0.02;
      /* crouched and still he is down on the right knee, the left foot
         planted ahead: the kneeling position, not a squat */
      var kneel = crouchK * (1 - moveK) * (1 - airK);
      if (s) bz -= 0.20 * kneel;
      else { bz += 0.27 * kneel; pitch += 0.95 * kneel; up += 0.118 * Math.sin(0.95 * kneel); }
      var fx = bx * chy + bz * shy + mdx * along + PW[hp].x * 0.5;
      var fz = -bx * shy + bz * chy + mdz * along + (PW[hp].z - 0.008) * 0.35;
      var fyy = 0.085 + up;
      /* airborne: the feet leave the plan and tuck under the body */
      if (airK > 0.001) {
        var lead = Math.sin(cyc + (s ? PI : 0)) > 0 ? 1 : 0;
        var tx = sg * 0.10, ty = PW[hp].y - lerp(0.70, 0.56, lead), tz = PW[hp].z + lerp(0.16, -0.20, lead);
        fx = lerp(fx, tx, airK); fyy = lerp(fyy, ty, airK); fz = lerp(fz, tz, airK);
        pitch = lerp(pitch, 0.45, airK);
      }
      V.f.set(fx, fyy, fz);
      /* knees track the pelvis heading, a little open */
      V.g.set(-shy + sg * 0.16 * chy, 0.05, -chy - sg * 0.16 * shy);
      var toeOut = sg * -0.13 + hipYaw;
      var cp2 = Math.cos(pitch), sp2 = Math.sin(pitch);
      V.h.set(-Math.sin(toeOut) * cp2, -sp2, -Math.cos(toeOut) * cp2);       /* toe line */
      V.c.set(-Math.sin(toeOut) * sp2, cp2, -Math.cos(toeOut) * sp2).multiplyScalar(1);
      V.d.set(0, 1, 0).addScaledVector(V.h, -V.h.y);                           /* sole normal */
      solveLeg(S, V.f, V.g, V.h, V.d.lengthSq() > 1e-6 ? V.d.normalize() : V.d.set(0, 1, 0),
        pitch > 0.05 ? -pitch * 0.85 : 0);
    }

    /* ================= 8. prone, as a second solved pose =================== */
    if (proneK > 0.001) { parkPose(); solveProne(cyc, moveK, aimPitch, eyeY); blendFromPark(proneK); }
    if (deadK > 0.001) { parkPose(); solveDead(st.deadSide); blendFromPark(deadK); }

    /* ================= 9. weapon ========================================== */
    var sight = C.sight && gun ? gun.sightY : 0;
    var rx = lerp(C.ready[0], C.ads[0], ads), ru = lerp(C.ready[1], C.ads[1], ads) - sight, rf = lerp(C.ready[2], C.ads[2], ads);
    var gunBob = Math.sin(cyc * 2) * 0.010 * moveK * (1 - ads * 0.7), gunSway = Math.sin(cyc) * 0.008 * moveK;
    /* aim frame */
    qEuler(V.q, st.gunPitch, st.gunYaw, 0);
    V.aimF.set(0, 0, -1).applyQuaternion(V.q);
    V.aimR.set(1, 0, 0).applyQuaternion(V.q);
    V.aimU.set(0, 1, 0).applyQuaternion(V.q);
    /* the eye point leads the frame; in the ground poses it is the solved head */
    V.e.set(0, eyeY, 0);
    if (proneK > 0.001) { V.a.set(0, 0.085, -0.020).applyQuaternion(QW[hdI]).add(PW[hdI]); V.e.lerp(V.a, proneK); }
    V.gunP.copy(V.e).addScaledVector(V.aimR, rx + gunSway).addScaledVector(V.aimU, ru + gunBob + breath * 0.0025)
      .addScaledVector(V.aimF, rf - rec * 0.55);
    qEuler(V.q2, recUp * 0.16, 0, C.cant * (1 - ads));
    V.gunQ.copy(V.q).multiply(V.q2);
    /* carried pose: sprinting, and the dip of a swap. Blended as a whole frame. */
    var carryK = Math.max(carryDash * (1 - proneK), 0), dipK = Math.max(lowK, rlK * 0.0);
    if (carryK > 0.001 || dipK > 0.001 || rlK > 0.001 || thr >= 0) {
      qEuler(V.q3, 0, 0, 0);
      if (carryK > 0.001) {
        V.a.set(0, eyeY, 0).addScaledVector(V.x.set(1, 0, 0), C.dashP[0]).addScaledVector(V.y.set(0, 1, 0), C.dashP[1] + gunBob * 2.2)
          .addScaledVector(V.z.set(0, 0, -1), C.dashP[2]);
        V.a.x += Math.sin(cyc) * 0.030;
        qEuler(V.q3, C.dashR[0] + Math.sin(cyc * 2) * 0.05, C.dashR[1], C.dashR[2]);
        V.gunP.lerp(V.a, carryK); V.gunQ.slerp(V.q3, carryK);
      }
      if (dipK > 0.001) {
        V.a.copy(V.e).addScaledVector(V.aimR, C.lowP[0]).addScaledVector(V.aimU, C.lowP[1]).addScaledVector(V.aimF, C.lowP[2]);
        qEuler(V.q3, C.lowR[0] + st.gunPitch * 0.4, C.lowR[1], C.lowR[2]);
        V.gunP.lerp(V.a, dipK); V.gunQ.slerp(V.q3, dipK);
      }
      if (rlK > 0.001) {
        /* reload: the gun comes in and tips, the support hand goes to the magazine */
        V.a.copy(V.e).addScaledVector(V.aimR, 0.06).addScaledVector(V.aimU, -0.20 - sight).addScaledVector(V.aimF, 0.24);
        qEuler(V.q3, st.gunPitch + 0.42, 0.20, 0.50);
        V.gunP.lerp(V.a, rlK); V.gunQ.slerp(V.q3, rlK);
      }
    }
    /* the throw: wind back, come over the top, follow through */
    if (thr >= 0) {
      var wind = sstep(Math.min(thr / 0.28, 1)) * (1 - sstep(clamp((thr - 0.28) / 0.22, 0, 1)));
      var over = sstep(clamp((thr - 0.28) / 0.26, 0, 1)) * (1 - sstep(clamp((thr - 0.66) / 0.34, 0, 1)));
      V.a.copy(V.e).addScaledVector(V.aimR, 0.26).addScaledVector(V.aimU, 0.10).addScaledVector(V.aimF, -0.20);
      V.gunP.lerp(V.a, wind);
      V.a.copy(V.e).addScaledVector(V.aimR, 0.16).addScaledVector(V.aimU, 0.02).addScaledVector(V.aimF, 0.52);
      V.gunP.lerp(V.a, over);
    }
    if (deadK > 0.001) {
      /* it leaves the hand and ends up on the floor beside it */
      V.a.set(st.deadSide > 0 ? 0.52 : 0.44, 0.030, st.deadSide > 0 ? -0.36 : -0.70);
      V.gunP.lerp(V.a, deadK); V.gunQ.slerp(qEuler(V.q3, 0, 0.5 * st.deadSide, PI / 2), deadK);
    }
    H.gun.position.copy(V.gunP);
    H.gun.quaternion.copy(V.gunQ);
    if (gun && gun.node) {
      /* the grenade leaves with the throw, and the next one comes up after it */
      if (gun.cls === 'grenade') gun.node.visible = !(thr > 0.42) && ammo > 0 && deadK < 0.5;
      else gun.node.visible = true;
      if (gun.can) gun.can.visible = !!P.suppressed;
    }

    /* ================= 10. arms =========================================== */
    {
      var gR = gun ? gun.gripR : [0, -0.03, 0.01], gL = gun ? gun.gripL : [-0.02, 0.03, -0.2];
      /* right wrist: palm on the right face of the grip */
      qBasis(V.hR, GRIPS.R);
      V.a.set(PALM[0], PALM[1], PALM[2]).applyQuaternion(V.hR);
      V.tR.set(gR[0] + 0.015, gR[1] - 0.014, gR[2] - 0.002).sub(V.a).applyQuaternion(V.gunQ).add(V.gunP);
      V.hR.premultiply(V.gunQ);
      /* left wrist */
      var lk = C.left, free = !lk;
      if (lk) {
        qBasis(V.hL, GRIPS[lk]);
        V.a.set(-PALM[0], PALM[1], PALM[2]).applyQuaternion(V.hL);
        if (lk === 'under') V.tL.set(0.0, gL[1] - 0.036, gL[2]);
        else if (lk === 'wrap') V.tL.set(gR[0] - 0.021, gR[1] - 0.022, gR[2] - 0.014);
        else V.tL.set(gL[0] - 0.015 + 0.02, gL[1] - 0.014, gL[2] - 0.002);
        V.tL.sub(V.a).applyQuaternion(V.gunQ).add(V.gunP);
        V.hL.premultiply(V.gunQ);
      }
      if (rlK > 0.001 && lk) {
        /* support hand to the magazine well, then back */
        V.a.set(-0.005, -0.150, -0.060).applyQuaternion(V.gunQ).add(V.gunP);
        var dip = Math.sin(clamp((rl - 0.15) / 0.62, 0, 1) * PI);
        V.b.set(-0.16, 1.02 - 0.3 * crouchK, -0.10);
        V.a.lerp(V.b, dip * 0.85);
        V.tL.lerp(V.a, rlK);
      }
      if (free) {
        /* nothing to hold: the support arm rides at the chest, guard up */
        V.tL.set(-0.20, eyeY - 0.36, -0.26).applyQuaternion(qEuler(V.q4, 0, st.gunYaw * 0.4, 0));
        V.tL.y = lerp(V.tL.y, PW[chI].y + 0.02, 0.6);
        V.tL.x += PW[chI].x; V.tL.z += PW[chI].z * 0.5;
        qBasis(V.hL, GRIPS.wrap); V.hL.premultiply(qEuler(V.q4, st.gunPitch * 0.4, 0.5, 0));
        if (thr >= 0) V.tL.z -= 0.14 * Math.sin(clamp(thr / 0.6, 0, 1) * PI);
      }
      /* elbows: down and a little out; lower and wider on the ground */
      V.c.set(0.60, -0.78, 0.22); V.d.set(-0.42, -0.86, 0.10);
      if (gun && gun.cls === 'pistol') { V.c.set(0.62, -0.76, 0.10); V.d.set(-0.62, -0.76, 0.10); }
      if (proneK > 0.001) { V.c.lerp(V.a.set(0.86, -0.42, 0.30), proneK); V.d.lerp(V.a.set(-0.86, -0.42, 0.30), proneK); }
      V.c.applyQuaternion(qEuler(V.q4, 0, st.gunYaw, 0)); V.d.applyQuaternion(V.q4);
      if (deadK > 0.001) {
        /* the hands let go: one arm thrown forward, one out to the side, palms down */
        var ds = st.deadSide;
        V.tR.lerp(V.a.set(ds > 0 ? 0.40 : 0.30, 0.045, ds > 0 ? -0.30 : -0.62), deadK);
        V.tL.lerp(V.a.set(ds > 0 ? -0.30 : -0.40, 0.045, ds > 0 ? -0.62 : -0.30), deadK);
        V.hR.slerp(qBasis(V.q4, [[-1, 0, 0], [0, 0, -1], [0, -1, 0]]), deadK);
        V.hL.slerp(qBasis(V.q4, [[-1, 0, 0], [0, 0, -1], [0, -1, 0]]), deadK);
        V.c.lerp(V.a.set(0.9, 0.3, 0.3), deadK); V.d.lerp(V.a.set(-0.9, 0.3, 0.3), deadK);
      }
      /* the shoulders come forward and up to meet a mounted gun */
      V.g.set(0, 0.012 * (1 - carryDash), -0.022 * (1 - carryDash));
      solveArm(1, V.tR, V.hR, V.c, V.g);
      solveArm(-1, V.tL, V.hL, V.d, V.g);
    }

    writeBones();

    /* ================= 11. place it in the world ========================== */
    var footY = P.y - fin(P.stepSm);
    H.root.position.set(P.x, footY, P.z);
    H.root.rotation.set(0, yaw, 0);
    H.root.scale.set(HS, HS, HS);
    H.root.updateMatrixWorld(true);

    if (gun) {
      var mz = (gun.can && P.suppressed && gun.muzzleCan) ? gun.muzzleCan : gun.muzzle;
      H.muzzleW.set(mz[0], mz[1], mz[2]).applyMatrix4(H.gun.matrixWorld);
      H.muzzleOK = gun.cls !== 'grenade';
    } else H.muzzleOK = false;

    if (H.flash) {
      st.flashT = Math.max(0, st.flashT - dt);
      var on = st.flashT > 0 && H.muzzleOK && H.root.visible;
      H.flash.visible = on;
      if (on) {
        var fs = (W.rocket ? 3.4 : W.pellets > 2 ? 2.5 : gun && gun.cls === 'pistol' ? 1.5 : 1.9) * (0.8 + 0.4 * st.flashSeed) * (P.suppressed && gun.can ? 0.35 : 1);
        V.a.set(0, 0, -0.10).applyQuaternion(V.gunQ).applyQuaternion(H.root.quaternion).multiplyScalar(HS);
        H.flash.position.copy(H.muzzleW).add(V.a);
        H.flash.scale.set(fs, fs, 1);
        H.flash.material.rotation = st.flashSeed * TAU;
        H.flash.material.opacity = clamp(st.flashT / 0.03, 0, 1);
      }
    }
    if (H.shadow) {
      var kS = G.shadowStrength ? fin(G.shadowStrength(0), 1) : 1;
      H.shadow.visible = H.root.visible && airK < 0.9;
      H.shadow.position.set(P.x + PW[hp].x * MU * 0, footY + 0.055, P.z);
      H.shadow.scale.setScalar(HS / MU);
      H.shadow.material.opacity = 0.44 * kS * (1 - airK * 0.7);
    }
  }

  /* =========================================================================
     10. FRAME + INSTALL
     ====================================================================== */
  /* A free look at the figure, for checking it: NZ.hero.orbit(az, el, dist)
     parks the lens on a sphere round him (az 0 = dead astern, PI = face on),
     NZ.hero.orbit(null) hands it back. Never set by the game. */
  var DBG = { orbit: null };

  function frame(dt) {
    var ST = G.state, P = G.player;
    if (!ST || !ST.booted || !P) return;
    /* the dressing index builds itself in the background: generously while a
       menu is up, a trickle in play, and it looks for new meshes now and then */
    if (TI.ok) {
      TI.scanT -= dt;
      if (TI.scanT <= 0) { TI.scanT = (TI.queue.length || TI.cur) ? 0.25 : 1.5; tiScan(); }
      if (TI.queue.length || TI.cur) tiStep(ST.playing ? 9000 : 70000);
    }
    showcaseStep(dt);
    updateBlend(dt);
    var H = HERO;
    if (VIEW.blend <= 0.0005 && cam.t <= 0 && !DBG.orbit && !SHOW.active) {
      /* first person, fully: nothing in this file runs past this line */
      if (H && H.root.visible) { H.root.visible = false; if (H.shadow) H.shadow.visible = false; if (H.flash) H.flash.visible = false; }
      cam.init = false;
      return;
    }
    if (!H) return;
    /* The figure lives on the game's clock, so a pause freezes him. Death is
       the exception: the game stops its own clock 1.1 s after the last round
       and the fall has to finish under the red screen. */
    var simDt = (ST.playing || (!P.alive && ST.ended)) ? dt : 0;

    updateCamera(dt);
    var show = VIEW.blend > 0.5 || !!DBG.orbit || SHOW.active;
    if (show && !DBG.orbit && SHOW.active) {
      /* the showcase comes right up to his face on purpose: hide him only with
         the lens actually inside his head (the first frames of a swing out of
         first person) */
      var cp = NZ.ctx.camera.position, ey = P.y - fin(P.stepSm) + fin(P.eyeH, G.EYE) * heroTall();
      var sx = P.x - cp.x, sy = ey - cp.y, sz = P.z - cp.z, rr = 0.30 * G.M * heroTall();
      if (sx * sx + sy * sy + sz * sz < rr * rr) show = false;
    } else if (show && !DBG.orbit) {
      /* the lens pushed up against the back of his head: take him out rather
         than render the inside of a skull */
      var hx = P.x - cam.x, hy = (cam.pivotY) - cam.y, hz = P.z - cam.z;
      if (hx * hx + hy * hy + hz * hz < CAMT.fade * CAMT.fade) show = false;
    }
    H.root.visible = show;
    /* on show: gun lowered, head level (read by the animator from H.st, so a
       multiplayer puppet never inherits it) */
    H.st.showT = SHOW.on ? 1 : 0;
    animateHero(simDt);

    /* Brass. The game throws a spent case from the eye with none of the
       shooter's own velocity -- which nobody can see from behind the eyes,
       where it has left the frame at once. From behind HIM, a running shooter
       leaves a line of cases hanging in the air and the lens flies through
       every one. In this view a new case keeps the speed of the gun it left,
       as a real one does. First person never reaches this line. */
    if (G.parts && simDt > 0 && VIEW.blend > 0.5) {
      var PT = G.parts, sv = H.st;
      for (var i = PT.length - 1, n = 0; i >= 0 && n < 32; i--, n++) {
        var pc = PT[i];
        if (!pc || !pc.casing || pc.nzHero) continue;
        pc.nzHero = 1;
        if (pc.v && pc.max - pc.life < 0.09) { pc.v.x += fin(sv.vx) * 0.92; pc.v.z += fin(sv.vz) * 0.92; }
      }
    }

    if (DBG.orbit) {
      var o = DBG.orbit, c = NZ.ctx.camera, MU = heroScale();
      var a = P.yaw + o.az, ty = P.y - fin(P.stepSm) + fin(o.y, 1.0) * MU, d = o.dist * MU;
      /* az 0 puts the lens behind him, looking the way he looks */
      c.position.set(P.x + Math.sin(a) * Math.cos(o.el) * d, ty + Math.sin(o.el) * d, P.z + Math.cos(a) * Math.cos(o.el) * d);
      c.rotation.order = 'YXZ';
      c.rotation.set(-o.el, a, 0);
      if (o.fov && Math.abs(c.fov - o.fov) > 0.01) { c.fov = o.fov; c.updateProjectionMatrix(); }
      var sky = skyOf(); if (sky) sky.position.copy(c.position);
    }
  }

  NZ.on('render', function (dt) {
    if (DEAD || !NZ.flags.hero) return undefined;
    try { frame(clamp(fin(dt, 0.016), 0, 0.1)); }
    catch (err) { panic(err, 'frame'); }
    return undefined;          /* never owns the frame */
  }, 20);

  /* A restored save moves the player without travelling there. */
  NZ.on('gameRestored', function () {
    try { cam.init = false; if (HERO) { HERO.st.init = false; HERO.st.gunInit = false; } } catch (e) { }
  });

  function install() {
    THREE = NZ.ctx.THREE || global.THREE;
    if (!THREE || !THREE.SkinnedMesh || !THREE.Skeleton || !THREE.Bone) throw new Error('three.js skinning API missing');
    if (!NZ.ctx.scene || !NZ.ctx.camera) throw new Error('scene not available');
    if (!probeGlobals()) throw new Error('game globals not reachable');
    var t0 = (global.performance && performance.now) ? performance.now() : 0;
    buildHero();
    var t1 = (global.performance && performance.now) ? performance.now() : 0;
    tiInit();
    NZ.flags.hero = true;
    loadView();
    buildUI();
    bindKey();
    wrapShowcase();
    NZ.log('hero built in ' + Math.round(t1 - t0) + 'ms: ' + HERO.verts + ' verts, ' + HERO.tris + ' tris, look=' + LOOK.name);
  }

  /* The face picture starts loading now, while the rest of the game is still
     booting, so that by the time the figure is built it is simply there: one
     bake of the atlas instead of a bake, a wait and a second bake. */
  try { if (LOOK.face && LOOK.face.image) loadFace(function () { if (HERO && !DEAD) repaintAtlas(); }); } catch (e) { }

  /* Registered after nz-weapons (script order), so its assets exist to be
     instanced; and before nz-render's late sweep at -1000, so the materials
     made here are composed into its AO / shadow patch like every other. */
  NZ.on('ready', function () {
    try { install(); }
    catch (err) {
      NZ.flags.hero = false;
      VIEW.third = false; VIEW.blend = 0; VIEW.hideVM = false;
      console.error('[nz-hero] install failed, first person only:', err);
    }
  });

  /* =========================================================================
     11. PUPPETS -- the other players in a multiplayer match (nz-net.js)
     The same figure and the same animator, driven by a stand-in player
     object that the network fills in, instead of by the local player.

     Each puppet owns its skeleton, its pose arrays and its animator state.
     The module-level pointers the animator works through (HERO, PW, QW,
     PARK, G.player) are swapped in around each call and put straight back,
     and the crosshair aim correction is switched off for it, so the local
     figure and the local camera never notice a puppet exists. With no
     puppets nothing in this section runs.

       var h = NZ.hero.puppet.create({ color: '#a83232' });
       h.P.x = ...; h.P.yaw = ...; h.P.alive = ...   (same fields as `player`)
       h.setVisible(true); h.shot(); h.hurt(); h.teleported();
       h.hitParts(out)   capsules in world units, from the solved bones
       h.muzzle()        world muzzle point, or null
       h.dispose()
     ====================================================================== */
  var PUPPETS = [];
  var PUP_SEQ = 0;

  function puppetPlayer() {
    return {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vy: 0, onGround: true, alive: true,
      eyeH: G.EYE, crouched: false, crawling: false, dash: 0, ads: 0,
      weapon: 0, pending: -1, swapT: 0, swapDur: 0.22, raiseT: 0, raiseDur: 0.22,
      ammo: {}, cool: 0, stepSm: 0, recoilPitch: 0, hurtT: 0, suppressed: false
    };
  }

  function shade(hex, k) {
    var c = hexRGB(hex);
    var h = function (v) { v = clamp(Math.round(v * k), 0, 255).toString(16); return v.length < 2 ? '0' + v : v; };
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }

  /* A puppet wears the game's default figure, never the local player's
     photo face (that would put your face on your friend), in a jacket of the
     colour the match gave that player. The default figure is the STOCK one:
     a look file (nz-hero-look.js) dresses the local player only, so nothing
     of it -- face, fitted head, haircut, stature -- is copied onto anyone
     else. */
  function puppetLook(opts) {
    var L = JSON.parse(JSON.stringify(LOOK_STOCK));
    L.face = null;
    /* one thing is shared: the bone table, and with it where the shoulder
       joints are. The trunk is cut to match them. */
    L.build.shoulders = LOOK.build.shoulders;
    var o = opts && opts.look;
    if (o && typeof o === 'object') {
      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && L[k] && typeof L[k] === 'object') {
          for (var j in o[k]) if (Object.prototype.hasOwnProperty.call(o[k], j)) L[k][j] = o[k][j];
        } else L[k] = o[k];
      }
    }
    if (opts && typeof opts.color === 'string' && /^#[0-9a-f]{6}$/i.test(opts.color)) {
      L.top.color = opts.color;
      L.top.trim = shade(opts.color, 0.55);
    }
    L.name = 'puppet';
    return L;
  }

  function buildPuppetFigure(opts) {
    var keep = { hero: HERO, pw: PW, qw: QW, park: PARK, look: LOOK };
    var H = null, pw = [], qw = [];
    try {
      LOOK = puppetLook(opts);
      for (var i = 0; i < SK.name.length; i++) { qw.push(new THREE.Quaternion()); pw.push(new THREE.Vector3()); }
      PW = pw; QW = qw; PARK = null;
      H = buildHero();
      H.PW = pw; H.QW = qw; H.PARK = null;
      H.root.name = 'nz-puppet';
      H.root.visible = false;
    } finally {
      HERO = keep.hero; PW = keep.pw; QW = keep.qw; PARK = keep.park; LOOK = keep.look;
    }
    return H;
  }

  function disposeFigure(H) {
    if (!H) return;
    try {
      if (H.root.parent) H.root.parent.remove(H.root);
      if (H.shadow && H.shadow.parent) H.shadow.parent.remove(H.shadow);
      if (H.flash && H.flash.parent) H.flash.parent.remove(H.flash);
      H.mesh.geometry.dispose(); H.mat.dispose();
      H.tex.map.dispose(); H.tex.normalMap.dispose(); H.tex.roughnessMap.dispose();
      var mats = {};
      H.gun.traverse(function (o) { if (o.isMesh && o.material && !mats[o.material.uuid]) { mats[o.material.uuid] = 1; o.material.dispose(); } });
      if (H.shadow) H.shadow.material.dispose();
      if (H.flash) H.flash.material.dispose();
    } catch (e) { }
  }

  function animatePuppet(pup, dt) {
    var H = pup.H;
    var show = pup.show && !pup.broken;
    H.root.visible = show;
    if (!show) {
      if (H.shadow) H.shadow.visible = false;
      if (H.flash) H.flash.visible = false;
      return;
    }
    var keep = { hero: HERO, pw: PW, qw: QW, park: PARK, player: G.player, aim: cam.aimOK };
    HERO = H; PW = H.PW; QW = H.QW; PARK = H.PARK; G.player = pup.P; cam.aimOK = false;
    try {
      animateHero(dt);
      H.PARK = PARK;
    } finally {
      HERO = keep.hero; PW = keep.pw; QW = keep.qw; PARK = keep.park; G.player = keep.player; cam.aimOK = keep.aim;
    }
    pup.posed = true;
  }

  /* Hit volumes from the solved pose: what you see is what you can hit, in
     every stance including prone and the death fall. Metres on the figure,
     returned in world units. */
  var HIT_SPEC = [
    ['head', 'head', null, 0.115, [0, 0.095, -0.012]],
    ['body', 'hips', 'neck', 0.17],
    ['limb', 'thighR', 'shinR', 0.09], ['limb', 'thighL', 'shinL', 0.09],
    ['limb', 'shinR', 'footR', 0.07], ['limb', 'shinL', 'footL', 0.07],
    ['limb', 'armR', 'foreR', 0.06], ['limb', 'armL', 'foreL', 0.06],
    ['limb', 'foreR', 'handR', 0.055], ['limb', 'foreL', 'handL', 0.055]
  ];
  var _hv = null;
  function puppetHitParts(pup, out) {
    out.length = 0;
    var H = pup.H;
    if (!pup.posed || !H.root.visible) return out;
    if (!_hv) _hv = new THREE.Vector3();
    var MU = G.M * fin(H.tall, 1);
    for (var i = 0; i < HIT_SPEC.length; i++) {
      var s = HIT_SPEC[i], a = H.bones[bi(s[1])];
      if (!a) continue;
      var e = a.matrixWorld.elements, ax, ay, az, bx, by, bz;
      if (s[4]) {
        _hv.set(s[4][0], s[4][1], s[4][2]).applyMatrix4(a.matrixWorld);
        ax = bx = _hv.x; ay = by = _hv.y; az = bz = _hv.z;
      } else {
        var b = H.bones[bi(s[2])];
        if (!b) continue;
        var f = b.matrixWorld.elements;
        ax = e[12]; ay = e[13]; az = e[14]; bx = f[12]; by = f[13]; bz = f[14];
      }
      out.push({ zone: s[0], r: s[3] * MU, ax: ax, ay: ay, az: az, bx: bx, by: by, bz: bz });
    }
    return out;
  }

  function puppetHandle(pup) {
    return {
      id: pup.id,
      P: pup.P,
      setVisible: function (v) { pup.show = !!v; },
      /* one round fired: the figure kicks and the muzzle flashes */
      shot: function () {
        var W = (G.WPN && G.WPN[pup.P.weapon]) || null, k = W && W.ammo;
        if (!k) return;
        var a = pup.P.ammo[k];
        pup.P.ammo[k] = (a > 1 ? a : 100000) - 1;
      },
      hurt: function () { pup.P.hurtT = fin(pup.P.hurtT) + 0.5; },
      /* a respawn or a correction: no stride, no velocity across the jump */
      teleported: function () { pup.H.st.init = false; pup.H.st.gunInit = false; pup.H.st.deadT = 0; pup.H.st.deadK = 0; },
      hitParts: function (out) { return puppetHitParts(pup, out || []); },
      muzzle: function () { return (pup.posed && pup.H.muzzleOK) ? pup.H.muzzleW : null; },
      root: function () { return pup.H.root; },
      dispose: function () {
        var i = PUPPETS.indexOf(pup);
        if (i >= 0) PUPPETS.splice(i, 1);
        disposeFigure(pup.H);
        pup.H = null;
      }
    };
  }

  function createPuppet(opts) {
    if (DEAD || !NZ.flags.hero || !HERO || !SK.name.length) return null;
    var pup = { id: ++PUP_SEQ, opts: opts || {}, H: null, P: puppetPlayer(), show: false, broken: false, errors: 0, posed: false };
    pup.H = buildPuppetFigure(pup.opts);
    PUPPETS.push(pup);
    return puppetHandle(pup);
  }

  /* NZ.hero.restyle rebuilds the skeleton; the puppets are rebuilt with it so
     they keep matching the bone table. */
  function rebuildPuppets() {
    for (var i = 0; i < PUPPETS.length; i++) {
      var pup = PUPPETS[i];
      try {
        var vis = pup.H ? pup.H.root.visible : false;
        disposeFigure(pup.H);
        pup.H = buildPuppetFigure(pup.opts);
        pup.H.root.visible = vis; pup.posed = false;
      } catch (err) { pup.broken = true; console.error('[nz-hero] puppet rebuild failed:', err); }
    }
  }

  /* Puppets animate on the real clock: a paused local game does not freeze
     the other players. Priority 19 runs after the local figure (20), and
     after nz-net (40) has written this frame's network state into P. */
  NZ.on('render', function (dt) {
    if (DEAD || !NZ.flags.hero || !PUPPETS.length) return undefined;
    var step = clamp(fin(dt, 0.016), 0, 0.1);
    for (var i = 0; i < PUPPETS.length; i++) {
      var pup = PUPPETS[i];
      if (!pup.H || pup.broken) continue;
      try { animatePuppet(pup, step); }
      catch (err) {
        pup.errors++;
        if (pup.errors <= 3) console.error('[nz-hero] puppet ' + pup.id + ' failed:', err);
        if (pup.errors >= PANIC_MAX) { pup.broken = true; if (pup.H) pup.H.root.visible = false; }
      }
    }
    return undefined;
  }, 19);

  var PUPPET_API = {
    get ready() { return !!HERO && NZ.flags.hero && !DEAD; },
    create: function (opts) {
      try { return createPuppet(opts); }
      catch (err) { console.error('[nz-hero] puppet create failed:', err); return null; }
    },
    count: function () { return PUPPETS.length; }
  };

  /* debug / capture / customisation surface */
  NZ.hero = {
    get ready() { return !!HERO && NZ.flags.hero; },
    look: LOOK,
    /* other players' figures, for nz-net.js (section 11) */
    puppet: PUPPET_API,
    /* the U showcase, for a touch button or a test: NZ.hero.showcase.toggle() */
    showcase: {
      get on() { return SHOW.on; },
      get active() { return SHOW.active; },
      get swing() { return SHOW.k; },
      toggle: function () { try { return SHOW.on ? showcaseOff() : showcaseOn(); } catch (e) { panic(e, 'showcase'); return false; } },
      set: function (v) { try { return v ? showcaseOn() : showcaseOff(); } catch (e) { panic(e, 'showcase'); return false; } },
      zoom: function (z) { if (SHOW.on) SHOW.zoomT = clamp(fin(z, SHOW.zoomT), 0, 1); return SHOW.zoomT; },
      orbit: function (mx, my) { showcaseOrbit(mx, my); }
    },
    view: VIEW,
    setThird: function (on) { setThird(on, false); },
    /* Re-dress the figure in place: NZ.hero.restyle({ top: { color: '#7a1f1f' } }) */
    restyle: function (o) {
      try {
        if (o && typeof o === 'object') for (var k in o) {
          if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && LOOK[k] && typeof LOOK[k] === 'object') {
            for (var j in o[k]) LOOK[k][j] = o[k][j];
          } else LOOK[k] = o[k];
        }
        var vis = HERO ? HERO.root.visible : false, key = HERO ? HERO.st.key : '';
        disposeHero();
        SK.name.length = 0; SK.parent.length = 0; SK.pos.length = 0; SK.idx = {};
        QW.length = 0; PW.length = 0; V = null; PARK = null; LQ = null;
        buildHero();
        HERO.root.visible = vis;
        if (key) { HERO.st.key = ''; }
        if (PUPPETS.length) rebuildPuppets();
        return true;
      } catch (err) { panic(err, 'restyle'); return false; }
    },
    orbit: function (az, el, dist, y, fov) {
      DBG.orbit = (az === null || az === undefined) ? null : { az: az, el: fin(el, 0.1), dist: fin(dist, 3), y: y, fov: fov };
    },
    reload: function () { try { if (HERO) heroReload(); } catch (e) { } },
    atlas: function () { return HERO ? HERO.tex.canvas : null; },
    stats: function () {
      return HERO ? {
        verts: HERO.verts, tris: HERO.tris, bones: HERO.bones.length, visible: HERO.root.visible,
        blend: VIEW.blend, boom: cam.boom, side: cam.side, aimT: cam.aimT, panic: PANIC,
        dressing: { tris: TI.n, meshes: TI.done, pending: TI.queue.length + (TI.cur ? 1 : 0) },
        phase: HERO.st.phase, speed: HERO.st.speed, key: HERO.st.key
      } : { panic: PANIC };
    },
    tune: { cam: CAMT, carry: CARRY, grips: GRIPS },
    /* for the console and for tests: what the boom camera would hit */
    debug: {
      dressing: function (ax, ay, az, bx, by, bz) { return tiSegment(ax, ay, az, bx, by, bz); },
      lensBlocked: function (x, y, z) { return lensBlocked(x, y, z); },
      camera: function () { return { x: cam.x, y: cam.y, z: cam.z, boom: cam.boom, free: cam.free, tight: cam.tight, tightOn: cam.tightOn }; }
    }
  };

})(typeof window !== 'undefined' ? window : this);
