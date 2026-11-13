/* ===========================================================================
   NZ-TOUCH  --  the game on a phone.

   A phone has no mouse to lock and no keys to hold, so this file puts a
   controller on the glass and drives the same player the keyboard and mouse
   drive, through the same globals:

     LEFT THUMB    a floating stick. It appears wherever the thumb lands in
                   the left 42% of the screen and follows the thumb if it
                   wanders. A light push walks (quiet steps), a normal push
                   runs, all the way up sprints.
     RIGHT THUMB   drag anywhere on the right to look. FIRE is held like a
                   trigger and can be dragged as well, so the thumb that
                   shoots also aims -- the one thing every phone shooter
                   learned the hard way.
     BUTTONS       AIM toggles the sights / scope (SNAP on the NULLSTAR),
                   JUMP, CROUCH (tap; hold = crawl), USE, WEAPON (tap = next
                   gun; hold = the list), MAP, PAUSE. SUP and MED appear only
                   when they can do something.

   And the housekeeping a mobile browser needs:
     - no pointer lock (iOS has none; Android's fails without a mouse)
     - the HUD moved out from under the thumbs
     - title, pause and lobby screens that fit -- and scroll on -- a 360 px
       tall landscape phone, with the controls explained instead of the keys
     - full screen and a landscape lock where the browser allows it
       (Android), a home-screen tip where it does not (iPhone)
     - in portrait the game pauses behind a "turn your phone" card and picks
       up again when the phone is turned back
     - switching apps pauses; a back gesture pauses instead of leaving
     - the screen is kept awake; audio is woken after iOS suspends it
     - a SHARE button for the multiplayer invite
     - a reload card if the phone takes the GPU away and does not give it back

   SETTINGS (pause screen, remembered per device): look speed, button size,
   graphics (LOW / MEDIUM / HIGH = a render tier plus a pixel-ratio ceiling),
   full screen, vibration, sound.

   WHEN IT RUNS
     On a phone or tablet it switches on at load. Elsewhere it only listens
     for a first touch (a touchscreen laptop) and switches off again when the
     keyboard or a mouse is used. #touch=1 in the address forces it on,
     #touch=0 keeps it off. Until it is on, nothing in the page is changed.

   CONTRACT WITH THE REST OF THE GAME (all guarded on this side)
     NUKEM.html   padAxis {on, fwd, str, walk, sprint}   the stick, read by updatePlayer
                  lookBy(mx, my)                         look, in mouse counts
                  NZ.dprCap                              pixel-ratio ceiling, read by resize()
                  NZ.touch.phone                         read by boot(): no canvas MSAA
                  by bare name: player, WPN, state, keysDown, mouseDown,
                  fireQueued, adsDown, altQueued, showMap, mouseSens, AU;
                  calls selectWeapon, useAction, useMedpack, toggleSuppressor,
                  toggleCrawl, standFromCrawl, togglePause, resize; replaces
                  window.lockMouse while the controls are on.
     nz-render    detectTier() asks NZ.touch.startTier(); this file calls
                  NZ.render.setQuality(tier, true), which keeps the
                  frame-time ladder running on top of the chosen tier.
     nz-net       #nzLink / #nzCopy (the SHARE button) and NZ.net.active (no
                  USE button in a match). Its 'ready' runs before ours (-50).
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  var doc = global.document;
  if (!NZ || !NZ.on || !doc) return;
  var html = doc.documentElement;
  var NAV = global.navigator || {};

  /* ------------------------------------------------------------- tuning -- */
  var STICK_ZONE = 0.42;     /* left share of the screen that starts the stick     */
  var DEAD = 0.14;           /* stick dead zone, as a share of its radius          */
  var WALK_BELOW = 0.5;      /* a lighter push walks: ALT speed, quiet steps        */
  var SPRINT_AT = 0.9;       /* this far out ...                                   */
  var SPRINT_COS = 0.77;     /* ... and within 40 degrees of straight up sprints    */
  var LOOK_RAD = 0.0075;     /* look speed 1.0: radians of turn per CSS px dragged  */
  var HOLD_MS = 380;         /* long press on CROUCH and WEAPON                    */
  var SENS_STEPS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3];
  /* GRAPHICS = a render tier (nz-render.js) plus a pixel-ratio ceiling. A
     phone screen is 3x and its GPU is not: the ceiling is most of the frame
     rate. MEDIUM is the low tier (no TAA / GTAO / SSR) drawn at 1.5x, which
     is still sharp at phone pixel densities. */
  var GFX = {
    low: { tier: 'low', dpr: 1.0 },
    medium: { tier: 'low', dpr: 1.5 },
    high: { tier: 'med', dpr: 2.0 }
  };
  var SIZES = { small: 0.86, normal: 1, large: 1.16 };
  var SET_KEY = 'nuke-zone-3d:touch:v1';

  /* ------------------------------------------------------------ helpers -- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  function $(id) { return doc.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  var warned = 0;
  function warn() {
    if (++warned > 12) return;
    try { console.warn.apply(console, ['[nz-touch]'].concat([].slice.call(arguments))); } catch (e) { }
  }
  function mq(q) { try { return !!(global.matchMedia && global.matchMedia(q).matches); } catch (e) { return false; } }
  function routeParam(name) {
    try {
      var m = new RegExp('(?:[#&?])' + name + '=([^&#]*)').exec(global.location.hash + '&' + global.location.search);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  var raf = global.requestAnimationFrame ? function (f) { global.requestAnimationFrame(f); }
    : function (f) { setTimeout(function () { f(now()); }, 16); };
  /* Game functions are top-level declarations, i.e. properties of window,
     and the multiplayer module may have wrapped some of them there: always
     call through window, never through a copy taken early. */
  function call(name) {
    var f = global[name];
    if (typeof f !== 'function') return undefined;
    try { return f.apply(global, [].slice.call(arguments, 1)); }
    catch (err) { warn(name + '() failed:', err); return undefined; }
  }

  /* --------------------------------------------------------- game state --
     The game's const objects never change identity, so they are bound once.
     Its `let`s (mouseDown, adsDown ...) are re-read and written by bare name
     every time: a classic script shares the page's global lexical scope. */
  var G = null;
  function bind() {
    if (G) return G;
    var g = {};
    /* eslint-disable no-undef */
    try { g.player = player; } catch (e) { }
    try { g.state = state; } catch (e) { }
    try { g.WPN = WPN; } catch (e) { }
    try { g.keys = keysDown; } catch (e) { }
    try { g.pad = padAxis; } catch (e) { g.pad = null; }
    /* eslint-enable no-undef */
    if (!g.player || !g.state || !g.WPN || !g.keys) return null;
    if (!g.pad) warn('NUKEM.html has no padAxis: the stick falls back to the WASD keys');
    G = g;
    return G;
  }
  /* eslint-disable no-undef */
  function setFire(on, queue) { try { mouseDown = !!on; if (on && queue) fireQueued = true; } catch (e) { } }
  function fireHeld() { try { return !!mouseDown; } catch (e) { return false; } }
  function adsOn() { try { return !!adsDown; } catch (e) { return false; } }
  function setAds(on) { try { adsDown = !!on; } catch (e) { } }
  function snapCores() { try { altQueued = true; } catch (e) { } }
  function mapOn() { try { return !!showMap; } catch (e) { return false; } }
  function flipMap() { try { showMap = !showMap; } catch (e) { } }
  function mouseSensNow() { try { return +mouseSens || 0.0023; } catch (e) { return 0.0023; } }
  function audio() { try { return AU; } catch (e) { return null; } }
  /* eslint-enable no-undef */
  function keyOn(code) { return !!(G && G.keys[code]); }
  function keySet(code, on) { if (G) G.keys[code] = !!on; }
  function playingNow() { var s = G && G.state; return !!(s && s.booted && s.playing && !s.paused && !s.ended); }
  function inGame() { var s = G && G.state; return !!(s && s.booted && !s.ended && (s.playing || s.paused)); }
  function inMatch() { return !!(NZ.net && NZ.net.active); }
  function curWeapon() { var p = G.player; return p.pending >= 0 ? p.pending : p.weapon; }

  /* ---------------------------------------------------------- detection -- */
  var UA = NAV.userAgent || '';
  var MTP = NAV.maxTouchPoints | 0;
  var IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && MTP > 1);
  var MOBILE_UA = IOS || /Android|Mobile|Silk|Kindle|IEMobile|Opera Mini/i.test(UA);
  /* a phone or a tablet: touch is the primary input */
  var HANDHELD = MTP > 0 && (MOBILE_UA || (mq('(pointer: coarse)') && !mq('(any-pointer: fine)')));
  var FORCE = routeParam('touch');
  var NEVER = FORCE === '0';
  var AUTO = !NEVER && (FORCE === '1' || HANDHELD);
  var STICKY = FORCE === '1' || HANDHELD;     /* keys and mouse do not switch it off */
  var SMALL = HANDHELD && (function () {
    var s = global.screen || {};
    return Math.min(s.width || global.innerWidth || 0, s.height || global.innerHeight || 0) < 600;
  })();
  var CAN_VIBRATE = typeof NAV.vibrate === 'function';

  /* ----------------------------------------------------------- settings -- */
  var SET = { sens: 1, gfx: 'medium', size: 'normal', fs: true, vib: true };
  (function load() {
    try {
      var o = JSON.parse(global.localStorage.getItem(SET_KEY) || 'null');
      if (!o || typeof o !== 'object') return;
      if (typeof o.sens === 'number' && isFinite(o.sens)) SET.sens = clamp(o.sens, 0.3, 3);
      if (GFX[o.gfx]) SET.gfx = o.gfx;
      if (SIZES[o.size]) SET.size = o.size;
      if (typeof o.fs === 'boolean') SET.fs = o.fs;
      if (typeof o.vib === 'boolean') SET.vib = o.vib;
    } catch (e) { }
  })();
  function saveSettings() { try { global.localStorage.setItem(SET_KEY, JSON.stringify(SET)); } catch (e) { } }
  /* read by resize() in NUKEM.html; set now, before boot sizes the canvas */
  if (HANDHELD) NZ.dprCap = GFX[SET.gfx].dpr;

  var ON = false;
  var touchApi = NZ.touch = {
    /* the hardware: a phone or a tablet. boot() and nz-render read it. */
    phone: HANDHELD,
    get active() { return ON; },
    startTier: function () { return HANDHELD ? GFX[SET.gfx].tier : null; },
    enable: function (on) { if (on) activate(); else deactivate(); },
    settings: function () { return { sens: SET.sens, gfx: SET.gfx, size: SET.size, fs: SET.fs, vib: SET.vib }; },
    setGraphics: function (k) { applyGfx(k); },
    state: function () { return debugState(); }
  };

  /* ================================================================ ICONS */
  var SVG = {
    fire: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.4"/><path d="M12 1.8v4.3M12 17.9v4.3M1.8 12h4.3M17.9 12h4.3"/><circle cx="12" cy="12" r="1.4" class="f"/></svg>',
    aim: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2"/><path d="M12 2.8v5.6M12 15.6v5.6M2.8 12h5.6M15.6 12h5.6"/></svg>',
    jump: '<svg viewBox="0 0 24 24"><path d="M5 16.5l7-7 7 7"/><path d="M5 10.5l7-7 7 7" opacity=".5"/></svg>',
    crouch: '<svg viewBox="0 0 24 24"><path d="M5 7l7 7 7-7"/><path d="M4.5 20h15"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M8.5 5v14M15.5 5v14" stroke-width="3.2"/></svg>',
    map: '<svg viewBox="0 0 24 24"><path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>',
    phone: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="21" y="8" width="22" height="40" rx="4"/><path d="M29 42h6"/><path d="M50 30a18 18 0 0 1-8 15" opacity=".55"/><path d="M42 45l0.2-5.6 5 2.4" opacity=".55"/></svg>'
  };

  /* ================================================================== CSS */
  var CSS = [
    /* the page: no selection, no callouts, no rubber band, no double-tap zoom */
    'html.nzt-on,html.nzt-on body{overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;',
    '-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%;text-size-adjust:100%}',
    'html.nzt-on input{-webkit-user-select:text;user-select:text}',
    'html.nzt-on #game{touch-action:none}',
    '.nzt-hint{display:none}',
    'html.nzt-on .nzt-hint{display:inline}',
    'html.nzt-on .nzt-keys{display:none}',
    'html.nzt-on.nzt-mp .nzt-sp{display:none}',

    /* screens: scroll when they do not fit, centre when they do (the two
       pseudo items soak up the free space; with none left they are 0 tall) */
    'html.nzt-on .screen{touch-action:pan-y;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;justify-content:flex-start;',
    'padding:max(10px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}',
    'html.nzt-on .screen:before{content:"";flex:0 0 auto;margin-top:auto}',
    'html.nzt-on .screen:after{content:"";flex:0 0 auto;margin-bottom:auto}',
    /* overflow scrolls; nothing gets squeezed into the row below it */
    'html.nzt-on .screen>*{flex-shrink:0}',
    'html.nzt-on .btn{min-height:42px;touch-action:manipulation}',
    'html.nzt-on .btn:hover,html.nzt-on .skill:hover{transform:none;filter:none}',
    'html.nzt-on .btn:active,html.nzt-on .skill:active{filter:brightness(1.3)}',
    'html.nzt-on .skill{min-height:36px;touch-action:manipulation}',
    'html.nzt-on #views .skill{min-height:34px}',
    'html.nzt-on #nzLobby input{font-size:16px}',     /* under 16px iOS zooms the page on focus */
    'html.nzt-on #nzLobby .row{flex-wrap:wrap}',
    '#nztShare{display:none}',
    'html.nzt-on #nztShare{display:inline-block}',
    '.nzt-turn,.nzt-ios{display:none}',
    'html.nzt-on .nzt-ios{display:block;color:#8fb8ff}',
    '@media (orientation:portrait){html.nzt-on.nzt-small .nzt-turn{display:block;margin:0 0 10px;padding:8px 14px;',
    'border:1px solid rgba(255,197,74,.5);background:rgba(40,20,4,.62);color:#ffdb78;font-weight:800;font-size:12px;letter-spacing:.18em}}',

    /* short landscape screens: everything a size down */
    '@media (max-height:540px){',
    'html.nzt-on .screen h1{font-size:clamp(22px,8.5vh,42px);letter-spacing:.1em}',
    'html.nzt-on .screen h2{font-size:clamp(10px,3.4vh,15px);letter-spacing:.26em;margin-top:2px}',
    'html.nzt-on .screen p{font-size:clamp(10px,3.2vh,13px);line-height:1.45;margin-top:8px;max-width:96ch}',
    'html.nzt-on #missions,html.nzt-on #skills{margin-top:8px;gap:5px}',
    'html.nzt-on .skill{min-width:0;padding:5px 12px 6px}',
    'html.nzt-on .skill .sn{font-size:12px;letter-spacing:.12em}',
    'html.nzt-on .skill .sd{display:none}',
    'html.nzt-on #skilltag{margin-top:4px;min-height:0;font-size:11px}',
    'html.nzt-on #views{margin-top:6px!important}',
    'html.nzt-on #views .skill{padding:5px 12px!important}',
    'html.nzt-on #views .skill .sn{font-size:12px!important}',
    'html.nzt-on .menu-actions{margin-top:10px;gap:8px}',
    'html.nzt-on .btn{padding:8px 22px;font-size:15px;letter-spacing:.18em}',
    'html.nzt-on .small{margin-top:8px;font-size:10px}',
    'html.nzt-on .save-note{margin-top:4px;min-height:0;font-size:10px}',
    'html.nzt-on #tallies{margin-top:8px;font-size:14px;line-height:1.6}',
    'html.nzt-on #nzLobby{margin-top:8px;gap:6px}',
    'html.nzt-on #nzLobby input{padding:6px 8px}',
    '}',
    '@media (max-height:420px){',
    'html.nzt-on .screen h1{font-size:clamp(20px,8vh,32px)}',
    'html.nzt-on .screen p{font-size:12px;line-height:1.38;margin-top:6px}',
    'html.nzt-on #missions,html.nzt-on #skills{margin-top:6px}',
    'html.nzt-on .menu-actions{margin-top:8px}',
    'html.nzt-on .btn{min-height:40px;padding:7px 20px}',
    '}',

    /* the HUD, out from under the thumbs: vitals bottom centre, run stats and
       the keycard top left under the pause / map buttons */
    'html.nzt-on #hud{left:50%;right:auto;bottom:max(6px,env(safe-area-inset-bottom));transform:translateX(-50%);gap:5px}',
    'html.nzt-on #hud .box{min-width:0;padding:2px 9px 4px;border-left-width:2px}',
    'html.nzt-on #hud .box .lbl{font-size:9px;letter-spacing:.16em}',
    'html.nzt-on #hud .box .val{font-size:clamp(17px,calc(var(--nzt-u,46px)*.5),30px)}',
    'html.nzt-on #invbox{min-width:0}',
    'html.nzt-on #invicon{width:20px;height:20px}',
    'html.nzt-on #invtxt{font-size:10px}',
    'html.nzt-on #stats{left:max(8px,env(safe-area-inset-left));top:calc(max(6px,env(safe-area-inset-top)) + var(--nzt-u,46px)*.92 + 10px);',
    'bottom:auto;font-size:11px;padding:2px 6px}',
    'html.nzt-on.nzt-mp #stats{display:none}',
    'html.nzt-on #keys{right:auto;bottom:auto;top:max(6px,env(safe-area-inset-top));',
    'left:calc(max(8px,env(safe-area-inset-left)) + var(--nzt-u,46px)*1.84 + 24px);padding:4px 6px}',
    'html.nzt-on #nzNet{top:calc(max(6px,env(safe-area-inset-top)) + var(--nzt-u,46px)*.92 + 10px);min-width:0;font-size:11px}',
    'html.nzt-on #feed{top:max(6px,env(safe-area-inset-top))}',
    'html.nzt-on #feed .kf{font-size:11px}',
    'html.nzt-on #msg{top:max(8px,env(safe-area-inset-top));padding:0 20%;font-size:clamp(13px,4.4vh,22px)}',
    'html.nzt-on #subtitle{top:calc(max(8px,env(safe-area-inset-top)) + 28px);padding:0 22%;font-size:clamp(10px,3.1vh,14px)}',

    /* the control layer */
    '#nzTouch{position:absolute;left:0;top:0;right:0;bottom:0;z-index:12;display:none;touch-action:none;-webkit-user-select:none;user-select:none;',
    '-webkit-touch-callout:none;font-family:"Bahnschrift Condensed","Arial Narrow","Segoe UI",sans-serif;',
    '--u:var(--nzt-u,46px);--sl:max(8px,env(safe-area-inset-left));--sr:max(8px,env(safe-area-inset-right));',
    '--st:max(6px,env(safe-area-inset-top));--sb:max(6px,env(safe-area-inset-bottom))}',
    'html.nzt-on #nzTouch.show{display:block}',
    '#nzTouch .nzt-b{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;',
    'gap:1px;border-radius:50%;color:#ffd978;border:1.5px solid rgba(255,197,74,.5);',
    'background:radial-gradient(circle at 50% 36%,rgba(74,58,34,.4),rgba(6,7,10,.44) 72%);',
    'box-shadow:0 3px 12px rgba(0,0,0,.32),inset 0 1px rgba(255,235,186,.14);text-shadow:0 1px 2px #000;opacity:.9;',
    'transition:background .08s,border-color .08s,opacity .2s}',
    /* hit area a little larger than the drawing */
    '#nzTouch .nzt-b:before{content:"";position:absolute;left:-5px;top:-5px;right:-5px;bottom:-5px;border-radius:inherit}',
    '#nzTouch .nzt-b svg{width:46%;height:46%;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;',
    'filter:drop-shadow(0 1px 1px #000);pointer-events:none}',
    '#nzTouch .nzt-b svg .f{fill:currentColor;stroke:none}',
    '#nzTouch .nzt-b b{font-weight:800;font-size:calc(var(--u)*.3);letter-spacing:.1em;line-height:1;pointer-events:none}',
    '#nzTouch .nzt-b i{font-style:normal;font-weight:800;font-size:calc(var(--u)*.19);letter-spacing:.14em;line-height:1;opacity:.85;pointer-events:none}',
    '#nzTouch .nzt-b i:empty{display:none}',
    '#nzTouch .nzt-b.down{background:radial-gradient(circle at 50% 40%,rgba(255,176,64,.55),rgba(96,42,8,.6) 74%);',
    'border-color:#ffe39a;color:#fff6d0;opacity:1}',
    '#nzTouch .nzt-b.on{border-color:#ffdb78;color:#fff3c2;opacity:1;box-shadow:0 0 16px rgba(255,160,40,.5),inset 0 0 14px rgba(255,170,60,.32)}',
    '#nzTouch.dead .nzt-b:not(.nzt-sq){opacity:.25}',
    /* right thumb. right / bottom = edge inset + centre - radius, in units */
    '#nzTouch .nzt-fire{width:calc(var(--u)*1.85);height:calc(var(--u)*1.85);right:calc(var(--sr) + var(--u)*1.475);',
    'bottom:calc(var(--sb) + var(--u)*1.575);border-width:2px}',
    '#nzTouch .nzt-fire svg{width:52%;height:52%}',
    '#nzTouch .nzt-aim{width:calc(var(--u)*1.2);height:calc(var(--u)*1.2);right:calc(var(--sr) + var(--u)*.15);bottom:calc(var(--sb) + var(--u)*2.45)}',
    '#nzTouch .nzt-aim svg{width:40%;height:40%}',
    '#nzTouch .nzt-jump{width:calc(var(--u)*1.3);height:calc(var(--u)*1.3);right:calc(var(--sr) + var(--u)*.25);bottom:calc(var(--sb) + var(--u)*.4)}',
    '#nzTouch .nzt-crouch{width:calc(var(--u)*1.05);height:calc(var(--u)*1.05);right:calc(var(--sr) + var(--u)*1.925);bottom:calc(var(--sb) + var(--u)*.2)}',
    '#nzTouch .nzt-crouch svg{width:42%;height:42%}',
    '#nzTouch .nzt-use{width:var(--u);height:var(--u);right:calc(var(--sr) + var(--u)*3.5);bottom:calc(var(--sb) + var(--u)*.95)}',
    '#nzTouch .nzt-use b{font-size:calc(var(--u)*.2);letter-spacing:0}',
    '#nzTouch .nzt-wpn{width:calc(var(--u)*2.2);height:calc(var(--u)*.8);border-radius:6px 14px 6px 6px;flex-direction:row;gap:.55em;',
    'right:calc(var(--sr) + var(--u)*.65);bottom:calc(var(--sb) + var(--u)*3.8)}',
    '#nzTouch .nzt-wpn b{font-size:calc(var(--u)*.28);white-space:nowrap}',
    '#nzTouch .nzt-wpn i{font-size:calc(var(--u)*.16);opacity:.55}',
    '#nzTouch .nzt-sup{width:calc(var(--u)*.85);height:calc(var(--u)*.85);right:calc(var(--sr) + var(--u)*3.175);bottom:calc(var(--sb) + var(--u)*3.125)}',
    '#nzTouch .nzt-sup b,#nzTouch .nzt-med b{font-size:calc(var(--u)*.24)}',
    '#nzTouch .nzt-med{width:calc(var(--u)*.9);height:calc(var(--u)*.9);right:calc(var(--sr) + var(--u)*3.6);bottom:calc(var(--sb) + var(--u)*2.15);',
    'color:#a6e6ae;border-color:rgba(120,220,140,.55)}',
    'html.nzt-mp #nzTouch .nzt-use{display:none}',
    /* top left */
    '#nzTouch .nzt-sq{width:calc(var(--u)*.92);height:calc(var(--u)*.92);border-radius:6px 12px 6px 6px;top:var(--st)}',
    '#nzTouch .nzt-sq svg{width:50%;height:50%}',
    '#nzTouch .nzt-pause{left:var(--sl)}',
    '#nzTouch .nzt-map{left:calc(var(--sl) + var(--u)*.92 + 12px)}',
    /* the stick: a zero-size anchor moved by transform, base and knob centred on it */
    '#nzTouch .nzt-stick{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;will-change:transform}',
    '#nzTouch .nzt-base,#nzTouch .nzt-knob{position:absolute;border-radius:50%;box-sizing:border-box}',
    '#nzTouch .nzt-base{width:calc(var(--u)*2.5);height:calc(var(--u)*2.5);left:calc(var(--u)*-1.25);top:calc(var(--u)*-1.25);',
    'border:2px solid rgba(255,197,74,.4);background:radial-gradient(circle,rgba(255,197,74,.06) 0,rgba(4,5,8,.28) 70%);',
    'transition:border-color .15s,box-shadow .15s}',
    '#nzTouch .nzt-knob{width:calc(var(--u)*1.05);height:calc(var(--u)*1.05);left:calc(var(--u)*-.525);top:calc(var(--u)*-.525);',
    'border:1.5px solid #ffd978;background:radial-gradient(circle at 44% 36%,rgba(255,228,160,.72),rgba(160,92,18,.55) 72%);',
    'box-shadow:0 2px 10px rgba(0,0,0,.4);will-change:transform}',
    '#nzTouch .nzt-stick.idle{opacity:.34}',
    '#nzTouch .nzt-stick.sprint .nzt-base{border-color:#ffdb78;box-shadow:0 0 18px rgba(255,170,40,.5)}',
    /* beside the ring, toward the middle of the screen: never under the knob */
    '#nzTouch .nzt-stick.sprint .nzt-base:after{content:"KOŞU";position:absolute;left:100%;top:50%;margin:-.6em 0 0 10px;',
    'font-weight:800;font-size:11px;line-height:1.2;letter-spacing:.22em;color:#ffdb78;text-shadow:0 1px 2px #000;white-space:nowrap}',
    /* the weapon list */
    '#nzTouch .nzt-picker{position:absolute;display:none;grid-template-columns:repeat(2,minmax(calc(var(--u)*2.1),auto));gap:6px;padding:8px;',
    'right:calc(var(--sr) + var(--u)*4.75);bottom:calc(var(--sb) + var(--u)*.3);max-height:calc(100% - var(--st) - var(--sb) - 12px);overflow:hidden;',
    'background:rgba(5,6,9,.86);border:1px solid rgba(255,197,74,.5);border-left-width:3px;border-radius:3px 10px 3px 3px;box-shadow:0 8px 28px rgba(0,0,0,.55)}',
    '#nzTouch .nzt-picker.show{display:grid}',
    '#nzTouch .nzt-picker.wide{grid-template-columns:repeat(3,minmax(calc(var(--u)*1.95),auto))}',
    '#nzTouch .nzt-pick{position:relative;min-height:calc(var(--u)*.86);padding:6px 10px;display:flex;flex-direction:column;justify-content:center;',
    'border:1px solid rgba(255,197,74,.3);border-left-width:3px;border-radius:2px 7px 2px 2px;',
    'background:linear-gradient(180deg,rgba(60,30,10,.55),rgba(10,6,4,.75));color:#e8d2a0}',
    '#nzTouch .nzt-pick *{pointer-events:none}',
    '#nzTouch .nzt-pick b{font-weight:800;font-size:13px;letter-spacing:.1em;white-space:nowrap}',
    '#nzTouch .nzt-pick small{font-size:10px;letter-spacing:.12em;color:#a8946e;margin-top:2px}',
    '#nzTouch .nzt-pick.cur{background:linear-gradient(180deg,#743307,#2b1103);border-color:#ffc557;color:#ffdb78}',
    '#nzTouch .nzt-pick.empty{opacity:.45}',

    /* full-screen cards: turn your phone, lost graphics */
    '.nzt-card{position:absolute;left:0;top:0;right:0;bottom:0;z-index:40;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;',
    'padding:24px;text-align:center;background:rgba(2,3,8,.95);color:#f5bd42;touch-action:none;',
    'font:800 16px/1.4 "Bahnschrift Condensed","Arial Narrow","Segoe UI",sans-serif;letter-spacing:.2em}',
    '.nzt-card.show{display:flex}',
    '.nzt-card small{display:block;color:#9e8c6b;letter-spacing:.14em;font-size:12px;font-weight:700}',
    '#nzRotate svg{width:84px;height:84px;color:#ffd978;animation:nztTurn 2.2s ease-in-out infinite}',
    '@keyframes nztTurn{0%,22%{transform:rotate(0)}52%,82%{transform:rotate(-90deg)}100%{transform:rotate(0)}}',

    /* pause screen settings */
    '#nztOpts{display:none;margin-top:12px;flex-direction:column;gap:7px;align-items:center;width:min(96vw,780px)}',
    'html.nzt-on #nztOpts{display:flex}',
    '#nztOpts .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center}',
    '#nztOpts .lbl{font-size:11px;letter-spacing:.18em;color:#9e8c6b;margin:0 4px 0 10px}',
    '#nztOpts .o{font:inherit;font-weight:800;font-size:12px;letter-spacing:.14em;min-height:36px;min-width:44px;padding:6px 12px;',
    'border:1px solid rgba(255,197,74,.35);border-left-width:3px;border-radius:2px 7px 3px 3px;cursor:pointer;touch-action:manipulation;',
    'background:linear-gradient(180deg,rgba(60,30,10,.5),rgba(10,6,4,.72));color:#c9a765}',
    '#nztOpts .o[aria-checked="true"]{background:linear-gradient(180deg,#743307,#2b1103);border-color:#ffc557;color:#ffdb78}',
    '#nztOpts .v{min-width:3.4em;text-align:center;color:#ffdb78;font-weight:800;font-size:13px;letter-spacing:.08em}',
    '#nztSafe{position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;',
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}'
  ].join('\n');

  var TOUCH_HINT =
    '<span class="keyhint">SOL BAŞPARMAK</span> hareket (hızlı koşmak için sonuna kadar it) &nbsp;&bull;&nbsp; ' +
    '<span class="keyhint">SAĞ BAŞPARMAK</span> sürükleyerek bak<br>' +
    '<span class="keyhint">ATEŞ</span> ateş et &mdash; ateş ederken sürükleyip nişan al &nbsp;&bull;&nbsp; ' +
    '<span class="keyhint">NİŞAN</span> nişangâh / dürbün' +
    '<span class="nzt-sp"> &nbsp;&bull;&nbsp; <span class="keyhint">KULLAN</span> kapılar, asansörler, şalterler</span><br>' +
    '<span class="keyhint">ÇÖMEL</span> basılı tut: sürün &nbsp;&bull;&nbsp; <span class="keyhint">SİLAH</span> basılı tut: liste &nbsp;&bull;&nbsp; ' +
    '<span class="keyhint">&#10074;&#10074;</span> duraklat ve ayarlar<br><br>';

  /* ================================================================== DOM */
  var L = null, B = {}, stickEl = null, knobEl = null, pickerEl = null, rotateEl = null, lostEl = null, safeEl = null;

  function mk(tag, cls, parent, inner) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (inner) n.innerHTML = inner;
    if (parent) parent.appendChild(n);
    return n;
  }
  function build() {
    if (L) return;
    if (!$('nzTouchCss')) {
      var st = mk('style', '', doc.head || html);
      st.id = 'nzTouchCss';
      st.textContent = CSS;
    }
    var game = $('game') || doc.body;
    L = mk('div', '', game);
    L.id = 'nzTouch';
    L.setAttribute('aria-hidden', 'true');
    stickEl = mk('div', 'nzt-stick idle', L);
    mk('div', 'nzt-base', stickEl);
    knobEl = mk('div', 'nzt-knob', stickEl);
    var btn = function (act, cls, inner) {
      var b = mk('div', 'nzt-b ' + cls, L, inner);
      b.setAttribute('data-act', act);
      B[act] = b;
      return b;
    };
    btn('pause', 'nzt-sq nzt-pause', SVG.pause);
    btn('map', 'nzt-sq nzt-map', SVG.map);
    btn('crouch', 'nzt-crouch', SVG.crouch + '<i></i>');
    btn('jump', 'nzt-jump', SVG.jump);
    btn('use', 'nzt-use', '<b>KULLAN</b>');
    btn('med', 'nzt-med', '<b>+</b><i></i>');
    btn('sup', 'nzt-sup', '<b>SUS</b>');
    btn('weapon', 'nzt-wpn', '<b>--</b><i>&#9650;</i>');
    btn('aim', 'nzt-aim', SVG.aim + '<i>NİŞAN</i>');
    btn('fire', 'nzt-fire', SVG.fire);
    B.sup.style.display = 'none';
    B.med.style.display = 'none';
    pickerEl = mk('div', 'nzt-picker', L);

    rotateEl = mk('div', 'nzt-card', game, SVG.phone + '<div>TELEFONU YAN ÇEVİR<small id="nztTurnSub">OYUN DURAKLATILDI</small></div>');
    rotateEl.id = 'nzRotate';
    lostEl = mk('div', 'nzt-card', game,
      '<div>TELEFON GRAFİKLERİ SIFIRLADI<small>OYUNU YENİDEN YÜKLEMEK İÇİN DOKUN</small><small id="nztLostSub"></small></div>');
    lostEl.id = 'nzLost';
    lostEl.addEventListener('click', function () { global.location.reload(); });
    safeEl = mk('div', '', doc.body);
    safeEl.id = 'nztSafe';

    L.addEventListener('touchstart', onStart, { passive: false });
    L.addEventListener('touchmove', onMove, { passive: false });
    L.addEventListener('touchend', onEnd, { passive: false });
    L.addEventListener('touchcancel', onEnd, { passive: false });
    /* A real mouse on the layer (a touchscreen laptop): hand the game back to
       the mouse. A touch never gets here -- its touchstart is cancelled, and
       a cancelled touchstart produces no mouse events. */
    L.addEventListener('mousedown', function () {
      if (STICKY) return;
      deactivate();
      call('lockMouse');
    });
  }

  /* ============================================================ GEOMETRY */
  var U = 46, VW = 800, VH = 400, SAFE = { t: 0, r: 0, b: 0, l: 0 }, seenW = -1, seenH = -1;
  function measure() {
    VW = global.innerWidth || VW; VH = global.innerHeight || VH;
    seenW = VW; seenH = VH;
    if (safeEl) {
      try {
        var cs = global.getComputedStyle(safeEl);
        SAFE.t = parseFloat(cs.paddingTop) || 0; SAFE.r = parseFloat(cs.paddingRight) || 0;
        SAFE.b = parseFloat(cs.paddingBottom) || 0; SAFE.l = parseFloat(cs.paddingLeft) || 0;
      } catch (e) { }
    }
    /* one unit sizes every control; set in px so the CSS and this file agree
       exactly (on iOS 12vh is not 12% of innerHeight while the bars show) */
    U = clamp(VH * 0.12, 40, 72) * (SIZES[SET.size] || 1);
    html.style.setProperty('--nzt-u', U.toFixed(2) + 'px');
    html.classList.toggle('nzt-small', SMALL);
    if (stick.id === null) placeIdleStick();
  }

  /* ============================================================== THE STICK */
  var TT = {};                 /* touch identifier (string) -> what that finger is doing */
  var stick = { id: null, cx: 0, cy: 0, R: 58, sprint: false };
  var lookId = null, fireN = 0, pickOpen = false;

  function setStickPos(x, y) { stickEl.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)'; }
  function setKnob(x, y) { knobEl.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)'; }
  function placeIdleStick() {
    if (!stickEl) return;
    stick.R = U * 1.25;
    stick.cx = Math.max(8, SAFE.l) + U * 2.2;
    stick.cy = VH - Math.max(6, SAFE.b) - U * 2.15;
    setStickPos(stick.cx, stick.cy);
    setKnob(0, 0);
  }
  function startStick(id, x, y) {
    /* The base appears centred under the thumb, wherever it lands -- not
       clamped on screen: clamping would put the knob off-centre and the
       player would start walking before the thumb has moved. */
    stick.id = id; stick.R = U * 1.25; stick.cx = x; stick.cy = y;
    TT[id] = { kind: 'stick', x: x, y: y };
    stickEl.classList.remove('idle');
    setStickPos(x, y);
    setKnob(0, 0);
    applyStick(0, 0, 0);
  }
  function moveStick(x, y) {
    var R = stick.R, dx = x - stick.cx, dy = y - stick.cy, d = Math.sqrt(dx * dx + dy * dy);
    /* a thumb that wanders off the base drags the base along behind it */
    var follow = R * 1.3;
    if (d > follow) {
      var k = (d - follow) / d;
      stick.cx += dx * k; stick.cy += dy * k;
      dx = x - stick.cx; dy = y - stick.cy; d = follow;
      setStickPos(stick.cx, stick.cy);
    }
    var m = Math.min(1, d / R), ux = d > 1e-6 ? dx / d : 0, uy = d > 1e-6 ? dy / d : 0;
    setKnob(ux * m * R, uy * m * R);
    applyStick(ux, uy, m);
  }
  function applyStick(ux, uy, m) {
    var mag = m <= DEAD ? 0 : (m - DEAD) / (1 - DEAD);
    var fwd = -uy * mag, str = ux * mag;
    var sprint = mag >= SPRINT_AT && -uy >= SPRINT_COS;
    var walk = mag > 0 && mag < WALK_BELOW;
    /* running drops the sights, as on every phone shooter: holding them
       would cap the run at aiming speed and lock the sprint out */
    if (sprint && !stick.sprint && adsOn()) setAds(false);
    stick.sprint = sprint;
    var pad = G.pad;
    if (pad) {
      pad.on = true; pad.fwd = fwd; pad.str = str; pad.walk = walk; pad.sprint = sprint;
    } else {
      var k = G.keys;
      k.KeyW = fwd > 0.38; k.KeyS = fwd < -0.38; k.KeyD = str > 0.38; k.KeyA = str < -0.38;
      k.ShiftLeft = sprint; k.AltLeft = walk;
    }
  }
  function endStick() {
    stick.id = null; stick.sprint = false;
    var pad = G && G.pad;
    if (pad) { pad.on = false; pad.fwd = 0; pad.str = 0; pad.walk = false; pad.sprint = false; }
    else if (G) { var k = G.keys; k.KeyW = k.KeyS = k.KeyA = k.KeyD = false; k.ShiftLeft = false; k.AltLeft = false; }
    if (stickEl) { stickEl.classList.add('idle'); stickEl.classList.remove('sprint'); }
    placeIdleStick();
  }

  /* ================================================================ LOOK */
  function look(dx, dy) {
    if ((!dx && !dy) || !playingNow()) return;
    var p = G.player, w = G.WPN[p.weapon] || {};
    var k = LOOK_RAD * SET.sens / mouseSensNow();
    /* lookBy already slows a magnified scope; iron sights zoom about 0.72x,
       so the same drag should turn about that much less while aiming */
    if (!w.scope) k *= 1 - 0.28 * clamp(+p.ads || 0, 0, 1);
    if (typeof global.lookBy === 'function') {
      try { global.lookBy(dx * k, dy * k); } catch (err) { warn('lookBy failed:', err); }
    } else {
      var ms = mouseSensNow();
      p.yaw -= dx * k * ms;
      p.pitch = clamp(p.pitch - dy * k * ms, -1.35, 1.35);
    }
  }

  /* ============================================================= BUTTONS */
  function pressButton(id, x, y, b) {
    var act = b.getAttribute('data-act');
    var s = { kind: 'btn', act: act, el: b, x: x, y: y, sx: x, sy: y, held: false, holdDue: false, moved: false, done: false, timer: 0, looks: false };
    TT[id] = s;
    b.classList.add('down');
    var p = G.player;
    switch (act) {
      case 'fire':
        s.looks = true; fireN++; setFire(true, true);
        break;
      case 'aim':
        s.looks = true;
        snapCores();                                 /* RMB is also NULLSTAR's snap trigger */
        if (!(G.WPN[p.weapon] || {}).altDetonate) setAds(!adsOn());
        break;
      case 'jump':
        /* prone, the jump button gets you up, exactly as SPACE does */
        if (p.crawling) call('standFromCrawl'); else keySet('Space', true);
        break;
      case 'weapon':
        if (pickOpen) { closePicker(); s.done = true; break; }
      /* falls through */
      case 'crouch':
        /* The timer only says a hold is DUE; the next animation frame acts on
           it. Input is handled before animation frames, so a finger that has
           already lifted -- its touchend stuck in the queue behind one long
           frame -- is seen first, and the press stays a tap. Acting in the
           timer itself turned quick taps into holds on a slow frame. */
        s.timer = setTimeout(function () { s.timer = 0; if (TT[id] === s) s.holdDue = true; }, HOLD_MS);
        break;
      case 'pick':
        pickWeapon(+b.getAttribute('data-w'));
        s.done = true;
        break;
      case 'use': call('useAction'); break;
      case 'map': flipMap(); refreshSoon(); break;
      case 'sup': call('toggleSuppressor'); refreshSoon(); break;
      case 'med': call('useMedpack'); refreshSoon(); break;
      case 'pause':
        releaseAll();
        call('togglePause');
        break;
    }
  }
  /* a hold that came due and survived to an animation frame */
  function runHolds() {
    for (var id in TT) {
      var s = TT[id];
      if (!s || s.kind !== 'btn' || !s.holdDue || s.held || s.moved) continue;
      s.held = true;
      if (s.act === 'crouch') {
        if (G.player.crawling) { keySet('KeyC', false); call('standFromCrawl'); }
        else call('toggleCrawl');
        buzz(12);
        refreshSoon();
      } else if (s.act === 'weapon') openPicker();
    }
  }
  function releaseButton(s, cancelled, x, y) {
    s.el.classList.remove('down');
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    switch (s.act) {
      case 'fire':
        fireN = Math.max(0, fireN - 1);
        if (!fireN) setFire(false);
        break;
      case 'jump': keySet('Space', false); break;
      case 'crouch':
        if (s.held || s.moved || cancelled) break;
        /* a tap: stand <-> crouch; from prone it comes up into a crouch */
        if (G.player.crawling) { keySet('KeyC', true); call('standFromCrawl'); }
        else keySet('KeyC', !keyOn('KeyC'));
        refreshSoon();
        break;
      case 'weapon':
        if (s.done) break;
        if (s.held) {
          /* held, the list opened under the thumb: let go over a gun to take it */
          if (!cancelled && x !== undefined) {
            var hit = doc.elementFromPoint(x, y);
            var pk = hit && hit.closest ? hit.closest('[data-act="pick"]') : null;
            if (pk) pickWeapon(+pk.getAttribute('data-w'));
          }
        } else if (!s.moved && !cancelled) nextWeapon();
        break;
    }
  }

  /* Next gun, skipping the empty ones unless they are all empty. Counts from
     a swap already in flight, so two quick taps go two guns along. */
  function nextWeapon() {
    var p = G.player, W = G.WPN, n0 = curWeapon(), any = -1;
    for (var i = 1; i <= W.length; i++) {
      var n = (n0 + i) % W.length;
      if (!p.has[n] || n === n0) continue;
      if (any < 0) any = n;
      if ((p.ammo[W[n].ammo] | 0) >= (W[n].use || 1)) { call('selectWeapon', n); return; }
    }
    if (any >= 0) call('selectWeapon', any);
  }
  function pickWeapon(n) {
    closePicker();
    if (!(n >= 0) || !G.player.has[n]) return;
    call('selectWeapon', n);
    refreshSoon();
  }
  function openPicker() {
    var p = G.player, W = G.WPN, cur = curWeapon(), h = '', n = 0;
    for (var i = 0; i < W.length; i++) {
      if (!p.has[i]) continue;
      n++;
      var am = p.ammo[W[i].ammo] | 0;
      h += '<div class="nzt-pick' + (i === cur ? ' cur' : '') + (am < (W[i].use || 1) ? ' empty' : '') +
        '" data-act="pick" data-w="' + i + '"><b>' + esc(W[i].name) + '</b><small>MERMİ ' + am + '</small></div>';
    }
    if (!n) return;
    pickerEl.innerHTML = h;
    pickerEl.className = 'nzt-picker show' + (n > 6 ? ' wide' : '');
    pickOpen = true;
    buzz(8);
  }
  function closePicker() {
    if (!pickOpen || !pickerEl) return;
    pickOpen = false;
    pickerEl.className = 'nzt-picker';
    pickerEl.innerHTML = '';
  }

  /* ======================================================= TOUCH EVENTS */
  function onStart(e) {
    if (e.cancelable) e.preventDefault();
    wakeAudio();
    if (!G) return;
    sweep(e.touches);
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], id = String(t.identifier);
      if (TT[id]) endTouch(id, true);
      var tg = t.target, b = tg && tg.closest ? tg.closest('[data-act]') : null;
      if (b && !L.contains(b)) b = null;
      if (pickOpen && !(b && (b === B.weapon || b.getAttribute('data-act') === 'pick'))) closePicker();
      if (!playingNow()) { TT[id] = { kind: 'none' }; continue; }
      if (b) pressButton(id, t.clientX, t.clientY, b);
      else if (t.clientX < VW * STICK_ZONE && stick.id === null) startStick(id, t.clientX, t.clientY);
      else if (t.clientX >= VW * STICK_ZONE && lookId === null) { lookId = id; TT[id] = { kind: 'look', x: t.clientX, y: t.clientY }; }
      else TT[id] = { kind: 'none' };
    }
  }
  function onMove(e) {
    if (e.cancelable) e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], s = TT[String(t.identifier)];
      if (!s || s.kind === 'none') continue;
      var x = t.clientX, y = t.clientY, dx = x - s.x, dy = y - s.y;
      s.x = x; s.y = y;
      if (s.kind === 'stick') moveStick(x, y);
      else if (s.kind === 'look') look(dx, dy);
      else if (s.kind === 'btn') {
        if (s.looks) look(dx, dy);
        if (!s.moved && Math.abs(x - s.sx) + Math.abs(y - s.sy) > 22) s.moved = true;
      }
    }
  }
  function onEnd(e) {
    if (e.cancelable) e.preventDefault();
    var cancelled = e.type === 'touchcancel';
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      endTouch(String(t.identifier), cancelled, t.clientX, t.clientY);
    }
  }
  function endTouch(id, cancelled, x, y) {
    var s = TT[id];
    if (!s) return;
    delete TT[id];
    if (s.kind === 'stick') { if (stick.id === id) endStick(); }
    else if (s.kind === 'look') { if (lookId === id) lookId = null; }
    else if (s.kind === 'btn') releaseButton(s, cancelled, x, y);
  }
  /* A finger the browser forgot to report lifting (a system gesture, an
     alert, a rotation): anything not in the live list is gone. */
  function sweep(list) {
    var live = {};
    for (var i = 0; i < list.length; i++) live[String(list[i].identifier)] = true;
    for (var id in TT) if (!live[id]) endTouch(id, true);
  }
  function releaseAll() {
    if (!G) return;
    for (var id in TT) {
      var s = TT[id];
      if (s && s.kind === 'btn') { s.el.classList.remove('down'); if (s.timer) clearTimeout(s.timer); }
    }
    TT = {};
    if (stick.id !== null) endStick();
    lookId = null;
    if (fireN) { fireN = 0; setFire(false); }
    keySet('Space', false);
    closePicker();
  }

  /* ========================================================= ACTIVATION */
  var lockOrig = null;
  function patchLock() {
    if (lockOrig !== null) return;
    lockOrig = typeof global.lockMouse === 'function' ? global.lockMouse : false;
    /* NUKEM.html calls lockMouse() by bare name, which resolves to this
       property; the same trick nz-net.js uses for fire() and demo.js for
       this very function */
    global.lockMouse = function () {
      if (ON) return;
      if (typeof lockOrig === 'function') return lockOrig.apply(this, arguments);
    };
  }

  var looping = false;
  function activate() {
    if (ON || NEVER) return;
    if (!bind()) { warn('game globals missing: touch controls stay off'); return; }
    build();
    patchLock();
    ON = true;
    html.classList.add('nzt-on');
    html.classList.toggle('nzt-mp', inMatch());
    measure();
    if (doc.pointerLockElement && doc.exitPointerLock) doc.exitPointerLock();   /* the game pauses on the unlock */
    adaptScreens();
    if (!looping) { looping = true; raf(tick); }
  }
  function deactivate() {
    if (!ON) return;
    releaseAll();
    keySet('KeyC', false);        /* a crouch toggled on the glass is not a C key held down */
    ON = false;
    shown = false;
    html.classList.remove('nzt-on');
    if (L) L.classList.remove('show');
    if (rotateEl) rotateEl.classList.remove('show');
  }

  /* ================================================== SCREENS & SETTINGS */
  var READY = false, adapted = false;
  function adaptScreens() {
    if (adapted || !READY || !ON) return;
    adapted = true;
    try { adaptTitle(); } catch (e) { warn('title screen:', e); }
    try { adaptPause(); } catch (e) { warn('pause screen:', e); }
    try { adaptLobby(); } catch (e) { warn('lobby:', e); }
  }
  function adaptTitle() {
    var t = $('scTitle');
    if (!t) return;
    /* the key list becomes a control list: the keys are kept (a tablet with
       a keyboard, or the controls switched off again) and only hidden */
    var brief = $('missionBrief'), p = brief && brief.parentNode;
    if (p && !p.querySelector('.nzt-keys')) {
      var keys = doc.createElement('span');
      keys.className = 'nzt-keys';
      while (p.firstChild && p.firstChild !== brief) keys.appendChild(p.firstChild);
      p.insertBefore(keys, brief);
      var hint = doc.createElement('span');
      hint.className = 'nzt-hint';
      hint.innerHTML = TOUCH_HINT;
      p.insertBefore(hint, brief);
    }
    var small = t.querySelector('.small');
    if (small && !small.querySelector('.nzt-keys') && small.innerHTML.indexOf('<span class="keyhint">E</span>\'YE BAS') >= 0) {
      small.innerHTML = small.innerHTML.replace('<span class="keyhint">E</span>\'YE BAS',
        '<span class="nzt-keys"><span class="keyhint">E</span>\'YE BAS</span><span class="nzt-hint"><span class="keyhint">KULLAN</span>\'A DOKUN</span>');
    }
    if (!t.querySelector('.nzt-turn')) {
      var turn = doc.createElement('div');
      turn.className = 'nzt-turn';
      turn.textContent = 'OYNAMAK İÇİN TELEFONU YAN ÇEVİR';
      t.insertBefore(turn, t.firstChild);
    }
    /* iPhone Safari has no full-screen mode for a page; a home-screen icon
       opens it without the browser bars */
    if (IOS && !fsSupported() && !NAV.standalone && !t.querySelector('.nzt-ios')) {
      var tip = doc.createElement('div');
      tip.className = 'save-note nzt-ios';
      tip.innerHTML = 'IPHONE\'DA TAM EKRAN: <b>PAYLAŞ</b> &rarr; <b>ANA EKRANA EKLE</b>, SONRA SİMGEDEN OYNA';
      var note = $('continueInfo');
      if (note && note.parentNode === t) t.insertBefore(tip, note.nextSibling); else t.appendChild(tip);
    }
  }
  function adaptPause() {
    var ps = $('scPause');
    if (!ps) return;
    var small = ps.querySelector('.small');
    if (small && !small.querySelector('.nzt-keys')) {
      small.innerHTML = '<span class="nzt-keys">' + small.innerHTML + '</span><span class="nzt-hint">OYUNA DÖNMEK İÇİN DEVAM ET DÜĞMESİNE DOKUN</span>';
    }
    if ($('nztOpts')) return;
    var o = doc.createElement('div');
    o.id = 'nztOpts';
    var chip = function (k, v, label) { return '<button type="button" class="o" data-o="' + k + '" data-v="' + v + '">' + label + '</button>'; };
    var rows = [];
    rows.push('<div class="row"><span class="lbl">BAKIŞ HIZI</span>' + chip('sens', '-1', '&minus;') +
      '<span class="v" id="nztSensV"></span>' + chip('sens', '1', '+') +
      '<span class="lbl">DÜĞMELER</span>' + chip('size', 'small', 'KÜÇÜK') + chip('size', 'normal', 'NORMAL') + chip('size', 'large', 'BÜYÜK') + '</div>');
    if (HANDHELD) {
      rows.push('<div class="row"><span class="lbl">GRAFİK</span>' + chip('gfx', 'low', 'DÜŞÜK') + chip('gfx', 'medium', 'ORTA') +
        chip('gfx', 'high', 'YÜKSEK') + '</div>');
    }
    var toggles = '';
    if (fsSupported()) toggles += chip('fs', '', '');
    if (CAN_VIBRATE) toggles += chip('vib', '', '');
    toggles += chip('snd', '', '');
    rows.push('<div class="row">' + toggles + '</div>');
    o.innerHTML = rows.join('');
    o.addEventListener('click', onOption);
    if (small && small.parentNode === ps) ps.insertBefore(o, small); else ps.appendChild(o);
    refreshOptions();
  }
  function adaptLobby() {
    var copy = $('nzCopy'), link = $('nzLink');
    if (!copy || !link || $('nztShare') || typeof NAV.share !== 'function') return;
    var b = doc.createElement('button');
    b.className = 'btn mini'; b.type = 'button'; b.id = 'nztShare';
    b.textContent = 'PAYLAŞ';
    b.onclick = function () {
      try {
        var r = NAV.share({ title: 'Seydişehir Çatışma', text: 'Ölüm maçı: katılmak için bağlantıya dokun.', url: link.value });
        if (r && r.catch) r.catch(function () { });
      } catch (e) { }
    };
    copy.parentNode.insertBefore(b, copy.nextSibling);
  }

  function nearestSens(v) {
    var best = 0;
    for (var i = 1; i < SENS_STEPS.length; i++) if (Math.abs(SENS_STEPS[i] - v) < Math.abs(SENS_STEPS[best] - v)) best = i;
    return best;
  }
  function onOption(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-o]') : null;
    if (!b) return;
    var k = b.getAttribute('data-o'), v = b.getAttribute('data-v');
    if (k === 'sens') SET.sens = SENS_STEPS[clamp(nearestSens(SET.sens) + (+v), 0, SENS_STEPS.length - 1)];
    else if (k === 'size' && SIZES[v]) { SET.size = v; measure(); }
    else if (k === 'gfx' && GFX[v]) applyGfx(v);
    else if (k === 'fs') {
      SET.fs = !SET.fs;
      if (SET.fs) enterFullscreen(true); else exitFullscreen();
    } else if (k === 'vib') { SET.vib = !SET.vib; if (SET.vib) buzz(30); }
    else if (k === 'snd') {
      var au = audio();
      if (au) au.muted = !au.muted;
    }
    saveSettings();
    refreshOptions();
  }
  function refreshOptions() {
    var o = $('nztOpts');
    if (!o) return;
    var sv = $('nztSensV');
    if (sv) {
      var txt = SET.sens.toFixed(2).replace(/0$/, '');
      sv.textContent = (/\.$/.test(txt) ? txt + '0' : txt) + 'x';
    }
    var au = audio();
    var list = o.querySelectorAll('[data-o]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i], k = b.getAttribute('data-o'), v = b.getAttribute('data-v');
      if (k === 'size') b.setAttribute('aria-checked', SET.size === v ? 'true' : 'false');
      else if (k === 'gfx') b.setAttribute('aria-checked', SET.gfx === v ? 'true' : 'false');
      else if (k === 'fs') { b.textContent = 'TAM EKRAN: ' + (SET.fs ? 'AÇIK' : 'KAPALI'); b.setAttribute('aria-checked', SET.fs ? 'true' : 'false'); }
      else if (k === 'vib') { b.textContent = 'TİTREŞİM: ' + (SET.vib ? 'AÇIK' : 'KAPALI'); b.setAttribute('aria-checked', SET.vib ? 'true' : 'false'); }
      else if (k === 'snd') {
        var on = !(au && au.muted);
        b.textContent = 'SES: ' + (on ? 'AÇIK' : 'KAPALI'); b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
  }
  function applyGfx(key) {
    var g = GFX[key];
    if (!g || !HANDHELD) return;
    SET.gfx = key;
    saveSettings();
    NZ.dprCap = g.dpr;
    try {
      if (NZ.flags && NZ.flags.render && NZ.render && NZ.render.setQuality) NZ.render.setQuality(g.tier, true);
    } catch (err) { warn('setQuality failed:', err); }
    call('resize');
    refreshOptions();
  }

  /* ========================================================= THE BROWSER */
  function fsSupported() {
    return !!((doc.fullscreenEnabled || doc.webkitFullscreenEnabled) && (html.requestFullscreen || html.webkitRequestFullscreen));
  }
  function fsElement() { return doc.fullscreenElement || doc.webkitFullscreenElement || null; }
  function enterFullscreen(force) {
    if ((!HANDHELD && !force) || !SET.fs || !fsSupported()) return;
    if (fsElement()) { lockLandscape(); return; }
    var req = html.requestFullscreen || html.webkitRequestFullscreen;
    try {
      var r = req.call(html, { navigationUI: 'hide' });
      if (r && typeof r.then === 'function') r.then(lockLandscape, function () { });
      else setTimeout(lockLandscape, 350);
    } catch (e) { }
  }
  function exitFullscreen() {
    try {
      if (!fsElement()) return;
      var r = (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      if (r && r.catch) r.catch(function () { });
    } catch (e) { }
  }
  /* only in full screen (Android); a no-op everywhere else */
  function lockLandscape() {
    if (!SMALL) return;
    try {
      var o = global.screen && global.screen.orientation;
      if (o && o.lock) { var r = o.lock('landscape'); if (r && r.catch) r.catch(function () { }); }
    } catch (e) { }
  }
  var wake = null, wakeBusy = false;
  function grabWake() {
    if (wake || wakeBusy || !NAV.wakeLock || doc.hidden) return;
    wakeBusy = true;
    try {
      NAV.wakeLock.request('screen').then(function (s) {
        wakeBusy = false; wake = s;
        s.addEventListener('release', function () { wake = null; });
      }, function () { wakeBusy = false; });
    } catch (e) { wakeBusy = false; }
  }
  /* iOS suspends (and after a call, "interrupts") the AudioContext; only a
     touch may resume it, so every touch tries */
  function wakeAudio() {
    var au = audio(), c = au && au.ctx;
    if (c && c.state !== 'running' && c.resume) { try { var r = c.resume(); if (r && r.catch) r.catch(function () { }); } catch (e) { } }
  }
  function buzz(pattern) {
    if (!SET.vib || !CAN_VIBRATE || !ON) return;
    try { NAV.vibrate(pattern); } catch (e) { }
  }
  /* A back swipe in the middle of a match would leave the page. One extra
     history entry turns the first back into a pause; on the title screen it
     is let through, so back still leaves the game from there. */
  var backGuard = false;
  function guardBack() {
    if (backGuard || !HANDHELD || !global.history || !history.pushState) return;
    backGuard = true;
    try { history.pushState({ nzt: 1 }, '', global.location.href); } catch (e) { return; }
    global.addEventListener('popstate', function () {
      if (!ON || !G || !inGame()) return;
      if (G.state.playing) { releaseAll(); call('togglePause'); }
      try { history.pushState({ nzt: 1 }, '', global.location.href); } catch (e) { }
    });
  }

  /* starting or resuming a game is the gesture that full screen, the wake
     lock and the back guard all need */
  doc.addEventListener('click', function (e) {
    if (!ON) return;
    wakeAudio();
    var b = e.target && e.target.closest ? e.target.closest('#btnStart,#btnContinue,#btnResume') : null;
    if (!b || b.disabled) return;
    enterFullscreen(false);
    grabWake();
    guardBack();
  }, true);
  doc.addEventListener('touchend', function () { if (ON) wakeAudio(); }, true);
  /* iOS ignores user-scalable=no; its pinch arrives as gesture events */
  doc.addEventListener('gesturestart', function (e) { if (ON && e.cancelable) e.preventDefault(); }, { passive: false });
  doc.addEventListener('visibilitychange', function () {
    if (!ON) return;
    if (doc.hidden) {
      releaseAll();
      if (G && G.state.playing) call('togglePause');
    } else if (inGame()) grabWake();
  });

  /* ------------------------------------------- touchscreen laptops etc. -- */
  if (!AUTO && !NEVER) {
    var armed = false;
    doc.addEventListener('touchend', function () {
      if (ON || armed) return;
      /* after the tap's click has landed, so the relayout cannot move the
         button out from under it */
      armed = true;
      setTimeout(function () { armed = false; activate(); }, 320);
    }, { capture: true, passive: true });
    doc.addEventListener('keydown', function (e) {
      if (ON && /^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code)) deactivate();
    }, true);
  }

  /* ------------------------------------------------------- lost graphics -- */
  if (HANDHELD) {
    var cv = $('view'), lostAt = 0;
    if (cv) {
      cv.addEventListener('webglcontextlost', function () {
        lostAt = now();
        setTimeout(function () {
          if (!lostAt || now() - lostAt < 2900 || !lostEl) return;
          var sub = $('nztLostSub');
          if (sub) sub.textContent = inMatch() ? 'AYNI ODAYA GERİ DÖNERSİN' : 'KAYITLI OYUN KORUNUR';
          lostEl.classList.add('show');
        }, 3000);
      }, false);
      cv.addEventListener('webglcontextrestored', function () {
        lostAt = 0;
        if (lostEl) lostEl.classList.remove('show');
      }, false);
    }
  }

  /* ============================================================ THE LOOP */
  var shown = false, lastUI = 0, lastOpts = 0, uiKey = '', lastW = -1, lastHp = 100, wasAlive = true;
  var turnPaused = false, turnShown = false, dirty = false;
  function refreshSoon() { dirty = true; }
  function portrait() { return SMALL && VH > VW * 1.05; }

  function tick(ts) {
    raf(tick);
    if (!ON || !G) return;
    try { frame(ts || now()); } catch (err) { warn('frame failed:', err); }
  }
  function frame(ts) {
    if (global.innerWidth !== seenW || global.innerHeight !== seenH) measure();
    checkTurn();
    var play = playingNow(), p = G.player;
    if (play !== shown) {
      shown = play;
      L.classList.toggle('show', play);
      if (!play) releaseAll();
      else { lastHp = p.hp; wasAlive = p.alive; }   /* a restored save is not a hit */
      uiKey = ''; dirty = true;
    }
    /* still watching through the second the single-player death takes */
    if (play || (G.state.ended && wasAlive)) feel();
    if (!play) {
      if (ts - lastOpts > 400 && $('scPause') && $('scPause').classList.contains('show')) { lastOpts = ts; refreshOptions(); }
      return;
    }
    /* the game drops the trigger on a death or a respawn; a finger still on
       FIRE is still a finger on the trigger */
    if (fireN > 0 && p.alive && !fireHeld()) setFire(true, false);
    runHolds();
    if (dirty || ts - lastUI > 90) { lastUI = ts; dirty = false; refreshButtons(); }
  }
  function shortName(n) { return String(n || '--').replace(/ TİPİ$/, '').replace(/^SÜRGÜLÜ /, '').replace(/^EL BOMBASI$/, 'BOMBA'); }
  function refreshButtons() {
    var p = G.player, wi = curWeapon(), w = G.WPN[wi] || {};
    /* a new gun comes up from the hip */
    if (wi !== lastW) { if (lastW >= 0 && adsOn()) setAds(false); lastW = wi; }
    var crouch = p.crawling ? 2 : (keyOn('KeyC') || keyOn('ControlLeft') || keyOn('ControlRight')) ? 1 : 0;
    var mp = inMatch();
    var key = [wi, w.name, adsOn() ? 1 : 0, w.altDetonate ? 1 : 0, crouch, mapOn() ? 1 : 0, w.canSuppress ? 1 : 0,
      p.suppressed ? 1 : 0, Math.round(p.medpack || 0), p.alive ? 1 : 0, mp ? 1 : 0, stick.sprint ? 1 : 0].join('|');
    if (key === uiKey) return;
    uiKey = key;
    B.weapon.firstChild.textContent = shortName(w.name);
    B.aim.classList.toggle('on', adsOn());
    B.aim.lastChild.textContent = w.altDetonate ? 'PATLAT' : 'NİŞAN';
    B.crouch.classList.toggle('on', crouch > 0);
    B.crouch.lastChild.textContent = crouch === 2 ? 'YÜZÜSTÜ' : '';
    B.map.classList.toggle('on', mapOn());
    B.sup.style.display = w.canSuppress ? '' : 'none';
    B.sup.classList.toggle('on', !!(w.canSuppress && p.suppressed));
    B.med.style.display = p.medpack > 0 ? '' : 'none';
    B.med.lastChild.textContent = p.medpack > 0 ? Math.round(p.medpack) + '%' : '';
    L.classList.toggle('dead', !p.alive);
    stickEl.classList.toggle('sprint', stick.sprint);
    html.classList.toggle('nzt-mp', mp);
  }
  /* a short buzz when hit, a longer one on death; a respawn (multiplayer)
     comes up standing, with nothing toggled */
  function feel() {
    var p = G.player;
    if (p.alive && p.hp < lastHp - 0.5) buzz(Math.round(Math.min(70, 14 + (lastHp - p.hp) * 1.2)));
    if (wasAlive && !p.alive) buzz([40, 60, 110]);
    if (!wasAlive && p.alive) { keySet('KeyC', false); keySet('Space', false); setAds(false); refreshSoon(); }
    lastHp = p.hp; wasAlive = p.alive;
  }

  /* Portrait during a game: pause behind the card, and pick up again on the
     way back -- unless the player paused it themselves. */
  function checkTurn() {
    var por = portrait(), show = por && inGame();
    if (show !== turnShown) {
      turnShown = show;
      rotateEl.classList.toggle('show', show);
      var sub = $('nztTurnSub');
      if (sub) sub.textContent = inMatch() ? 'HÂLÂ MAÇTASIN' : 'OYUN DURAKLATILDI';
    }
    if (show && G.state.playing) {
      releaseAll();
      call('togglePause');
      turnPaused = true;
    } else if (!por && turnPaused) {
      turnPaused = false;
      setTimeout(function () {
        var ps = $('scPause');
        if (!portrait() && G.state.paused && !G.state.ended && ps && ps.classList.contains('show')) call('togglePause');
      }, 250);
    }
  }

  function debugState() {
    var pad = G && G.pad;
    return {
      active: ON, shown: shown, phone: HANDHELD, small: SMALL, ios: IOS,
      stick: stick.id !== null, sprint: stick.sprint, look: lookId !== null, fire: fireN, aim: adsOn(), picker: pickOpen,
      pad: pad ? { on: pad.on, fwd: pad.fwd, str: pad.str, walk: pad.walk, sprint: pad.sprint } : null,
      portrait: portrait(), turnPaused: turnPaused, unit: U, view: { w: VW, h: VH },
      safe: { t: SAFE.t, r: SAFE.r, b: SAFE.b, l: SAFE.l }, touches: Object.keys(TT).length,
      settings: touchApi.settings(), dprCap: NZ.dprCap || null
    };
  }

  /* ----------------------------------------------------------- start up -- */
  /* last of the 'ready' listeners that matter: nz-hero has added its VIEW
     row and nz-net its lobby by the time this restyles them */
  NZ.on('ready', function () {
    READY = true;
    if (ON) {
      html.classList.toggle('nzt-mp', inMatch());
      adaptScreens();
    }
  }, -50);
  if (AUTO) activate();
})(typeof window !== 'undefined' ? window : this);
