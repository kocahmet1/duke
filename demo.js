/* ============================================================================
   NUKE ZONE 3D  --  DEMO DIRECTOR + CAPTURE RIG
   ----------------------------------------------------------------------------
   Drop-in companion for NUKEM.html. Does nothing until you ask for it.

   Open  NUKEM.html?demo=1   -> title screen grows a "RECORD DEMO" button.
   Click it and the game plays itself through a scripted route at speed,
   while a 1280x720 video (world + weapon + HUD + sound) is recorded and
   saved to your Downloads folder.

   URL knobs (all optional):
     ?demo=1          arm the rig
     &len=30          clip length in real seconds
     &speed=2.2       game-time multiplier (1.0 - 3.0; >3 hits the dt clamp)
     &w=1280&h=720    capture size
     &fps=60          capture frame rate
     &mbps=12         video bitrate
     &hud=0           drop the HUD overlay from the video
     &audio=0         silent capture
     &map=0           skip the automap flourish at the end
     &secret=0        skip the secret-wall beat
     &save=0          do not auto-download (preview panel only)
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------- config -- */
  var Q = new URLSearchParams(location.search);
  var num = function (k, d) { var v = parseFloat(Q.get(k)); return isFinite(v) ? v : d; };
  var flag = function (k, d) { return Q.has(k) ? Q.get(k) !== '0' : d; };

  var CFG = {
    armed: Q.has('demo') || Q.has('rec'),
    len: num('len', 30),
    speed: Math.max(0.5, Math.min(3.0, num('speed', 1.8))),
    W: Math.round(num('w', 1280)),
    H: Math.round(num('h', 720)),
    fps: num('fps', 60),
    bitrate: num('mbps', 12) * 1e6,
    hud: flag('hud', true),
    audio: flag('audio', true),
    map: flag('map', true),
    secret: flag('secret', true),
    save: flag('save', true)
  };

  /* --------------------------------------------------------- time warp --- */
  /* The game derives dt from the rAF timestamp, so scaling the timestamp is
     the whole of "fast mode". dt is clamped at 50ms inside the loop, which is
     why speed is capped at 3x on a 60Hz display.                            */
  var scale = 1, vNow = 0, rPrev = -1;
  var rawRAF = window.requestAnimationFrame.bind(window);
  function warp(t) {
    if (t !== rPrev) {
      if (rPrev < 0) { rPrev = t; vNow = t; }
      else { vNow += (t - rPrev) * scale; rPrev = t; }
    }
    return vNow;
  }
  window.requestAnimationFrame = function (cb) {
    return rawRAF(function (t) { cb(warp(t)); });
  };

  /* -------------------------------------------------------------- utils -- */
  var PI2 = Math.PI * 2;
  function wrapA(a) { a = (a + Math.PI) % PI2; if (a < 0) a += PI2; return a - Math.PI; }
  function cl(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wx(g) { return g * CELL + CELL / 2; }       /* grid cell -> world centre */
  function approach(cur, want, rate, dt) {
    return cur + wrapA(want - cur) * (1 - Math.exp(-rate * dt));
  }

  /* ================================================================ ROUTE ==
     Grid coordinates. Player spawns at the 233 Sk roundabout at (140,44),
     looking west along the straight park-side continuation.  Yildiz Tepesi,
     the split road and the Seydikent blocks now share this one axis.  Beats
     are ordered best-first, so a short clip still gets the good parts and
     anything the timer eats comes off the end.
     ======================================================================== */
  function buildRoute() {
    var R = [];
    var push = function (o) { R.push(o); };

    /* -- 1. establish the linear park climb, then enter the arena frontage -- */
    push({ k: 'look', t: 0.85, at: [112, 44], calm: true });
    push({ k: 'go', at: [132, 44], r: 2.6, tmax: 6 });
    push({ k: 'go', at: [116, 44], r: 2.6, tmax: 8 });
    push({ k: 'go', at: [98, 44], r: 2.6, tmax: 8 });
    push({ k: 'go', at: [84, 44], r: 2.6, tmax: 8 });
    push({ k: 'go', at: [79, 38], r: 2.0, tmax: 7 });
    push({ k: 'go', at: [79, 36], r: 1.6, tmax: 5 });
    push({ k: 'use', at: [79, 35], t: 0.6 });
    push({ k: 'wait', t: 1.0, at: [79, 34] });
    push({ k: 'go', at: [79, 32], r: 1.8, tmax: 5 });
    push({ k: 'clear', t: 3.0, tmax: 8 });
    push({ k: 'go', at: [84, 29], r: 2.2, tmax: 6 });
    push({ k: 'clear', t: 2.5, tmax: 7 });
    push({ k: 'go', at: [73, 30], r: 2.2, tmax: 6 });
    push({ k: 'clear', t: 3.0, tmax: 8 });

    /* Leave by the internal service stair into the original mission.  The
       south door remains the fight building's only public street entrance. */
    push({ k: 'go', at: [68, 30], r: 1.8, tmax: 5 });
    push({ k: 'use', at: [67, 30], t: 0.5 });
    push({ k: 'go', at: [63, 30], r: 2.0, tmax: 6 });
    push({ k: 'go', at: [61, 34], r: 2.0, tmax: 6 });
    push({ k: 'go', at: [61, 38], r: 2.0, tmax: 6 });
    push({ k: 'go', at: [54, 38], r: 2.2, tmax: 7 });
    push({ k: 'go', at: [47, 38], r: 1.8, tmax: 7 });
    push({ k: 'go', at: [46, 30], r: 2.2, tmax: 6 });
    push({ k: 'go', at: [39, 30], r: 2.0, tmax: 5 });
    push({ k: 'go', at: [34, 30], r: 2.0, tmax: 5 });
    push({ k: 'go', at: [30, 28], r: 2.2, tmax: 5 });

    /* -- 2. a suspicious wall on the west side of the street -------------- */
    if (CFG.secret) {
      push({ k: 'go', at: [22, 26], r: 1.7, tmax: 5 });        /* right up to it */
      push({ k: 'use', at: [21, 26], t: 0.5 });                /* A SECRET PLACE! */
      push({ k: 'wait', t: 1.9, at: [19, 26] });               /* wall grinds open */
      push({ k: 'go', at: [19, 26], r: 2.0, tmax: 4 });        /* armour + shells */
      push({ k: 'go', at: [22, 26], r: 1.8, tmax: 4 });        /* back out the gap */
      push({ k: 'go', at: [24, 28], r: 2.6, tmax: 5 });
    }

    /* -- 3. west down the alley toward the theatre ------------------------ */
    push({ k: 'go', at: [23, 32], r: 2.4, tmax: 5 });
    push({ k: 'go', at: [20, 32], r: 2.2, tmax: 5 });
    push({ k: 'go', at: [16, 32], r: 2.2, tmax: 6 });         /* trooper at 14,32 */
    push({ k: 'clear', t: 1.2, tmax: 3 });
    push({ k: 'go', at: [12, 32], r: 2.2, tmax: 6 });

    /* -- 4. theatre lobby: the pig ---------------------------------------- */
    push({ k: 'go', at: [9, 33], r: 2.6, tmax: 6 });
    push({ k: 'clear', t: 1.8, tmax: 4 });
    push({ k: 'go', at: [6, 32], r: 2.6, tmax: 5 });
    push({ k: 'look', t: 0.8, at: [5, 30] });

    /* -- 5. crescendo: back east and kick the hotel door in --------------- */
    push({ k: 'go', at: [12, 32], r: 2.4, tmax: 6 });
    push({ k: 'go', at: [20, 32], r: 2.4, tmax: 6 });
    push({ k: 'go', at: [23, 32], r: 2.2, tmax: 5 });
    push({ k: 'go', at: [26, 30], r: 2.6, tmax: 6 });
    push({ k: 'go', at: [31, 25], r: 2.6, tmax: 6 });
    push({ k: 'go', at: [34, 22], r: 1.8, tmax: 6 });
    push({ k: 'use', at: [34, 21], t: 0.5 });                 /* lobby door */
    push({ k: 'wait', t: 1.2, at: [34, 19] });
    push({ k: 'go', at: [34, 19], r: 2.2, tmax: 5 });
    push({ k: 'go', at: [31, 18], r: 2.6, tmax: 6 });
    push({ k: 'clear', t: 2.2, tmax: 5 });
    push({ k: 'go', at: [28, 17], r: 2.6, tmax: 6 });
    push({ k: 'clear', t: 2.2, tmax: 5 });
    push({ k: 'go', at: [26, 15], r: 2.6, tmax: 6 });
    push({ k: 'clear', t: 2.5, tmax: 5 });

    /* -- 6. overrun: the long corridor, in case the clip is still running -- */
    push({ k: 'go', at: [30, 12], r: 1.8, tmax: 6 });
    push({ k: 'use', at: [30, 11], t: 0.5 });                 /* corridor door */
    push({ k: 'wait', t: 1.2, at: [30, 10] });
    push({ k: 'go', at: [30, 10], r: 2.0, tmax: 5 });
    push({ k: 'go', at: [24, 10], r: 2.4, tmax: 6 });
    push({ k: 'go', at: [18, 10], r: 2.4, tmax: 6 });
    push({ k: 'clear', t: 1.6, tmax: 4 });
    push({ k: 'go', at: [12, 10], r: 2.4, tmax: 6 });
    push({ k: 'clear', t: 2.0, tmax: 4 });
    push({ k: 'go', at: [7, 10], r: 2.4, tmax: 6 });
    push({ k: 'clear', t: 2.5, tmax: 5 });

    return R;
  }

  /* =============================================================== DRIVER ==
     Drives the real input path (keysDown / mouseDown / yaw / pitch), so the
     footage shows the same head-bob, recoil and weapon logic a human gets.
     ======================================================================== */
  var D = {
    live: false, i: 0, t: 0, gt: 0,
    tgt: null, retarget: 0, lostT: 0,
    stuckT: 0, px: 0, pz: 0, kickTimer: 0,
    strafe: 1, strafeT: 0, sway: 0, route: null, done: false
  };

  function clearKeys() {
    keysDown.KeyW = keysDown.KeyS = keysDown.KeyA = keysDown.KeyD = false;
    keysDown.Space = false; keysDown.ShiftLeft = false;
    mouseDown = false;
  }

  /* world direction -> view-relative WASD */
  function drive(dx, dz) {
    var L = Math.hypot(dx, dz);
    if (L < 1e-4) { keysDown.KeyW = keysDown.KeyS = keysDown.KeyA = keysDown.KeyD = false; return; }
    dx /= L; dz /= L;
    var sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
    var f = -sy * dx - cy * dz;
    var s = cy * dx - sy * dz;
    keysDown.KeyW = f > 0.34; keysDown.KeyS = f < -0.34;
    keysDown.KeyD = s > 0.34; keysDown.KeyA = s < -0.34;
  }

  function aimSolve(x, y, z) {
    var dx = x - player.x, dz = z - player.z;
    var dy = y - (player.y + EYE - 0.25);
    var hd = Math.hypot(dx, dz) || 1e-6;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, hd), d: hd };
  }

  function pickTarget() {
    var best = null, bd = 1e9;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.dead) continue;
      var d = Math.hypot(e.x - player.x, e.z - player.z);
      if (d > 64 || Math.abs(e.y - player.y) > 10) continue;
      if (!losGrid(player.x, player.z, e.x, e.z)) continue;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function tick(dt) {
    if (!D.live || !state.playing || !player.alive) return;
    D.gt += dt; D.t += dt; D.sway += dt;

    var op = D.route[D.i] || { k: 'hold' };

    /* ---- target acquisition ------------------------------------------- */
    D.retarget -= dt;
    if (D.tgt && (D.tgt.dead || !losGrid(player.x, player.z, D.tgt.x, D.tgt.z))) D.tgt = null;
    if (!D.tgt && D.retarget <= 0) { D.tgt = pickTarget(); D.retarget = 0.3; }
    /* a door beat that keeps getting interrupted eventually wins the argument */
    var forceUse = op.k === 'use' && D.t > 2.2;
    var fighting = !!D.tgt && !op.calm && !forceUse;

    /* ---- where to look ------------------------------------------------- */
    var want, turn;
    if (fighting) {
      want = aimSolve(D.tgt.x, D.tgt.cy(), D.tgt.z);
      turn = 9.5;
    } else if (op.at) {
      want = aimSolve(wx(op.at[0]), player.y + EYE - 0.25, wx(op.at[1]));
      turn = 5.0;
    } else {
      /* nothing scripted left: sweep the room slowly rather than freeze */
      want = { yaw: player.yaw + 0.55, pitch: 0, d: 1 };
      turn = 1.1;
    }

    /* a little idle sway keeps it from reading as a turret */
    var swayY = Math.sin(D.sway * 1.7) * 0.0075 + Math.sin(D.sway * 0.63) * 0.005;
    var swayP = Math.sin(D.sway * 1.21) * 0.004;

    player.yaw = approach(player.yaw, want.yaw + swayY, turn, dt);
    /* recoil: leave a quarter of it in shot so the kick is visible on camera */
    var comp = player.kick * 0.02 * 0.72;
    player.pitch = cl(approach(player.pitch, want.pitch + swayP - comp, turn, dt), -1.3, 1.3);

    /* ---- trigger -------------------------------------------------------- */
    var yawErr = Math.abs(wrapA(player.yaw - want.yaw));
    var pitErr = Math.abs((player.pitch + player.kick * 0.02) - want.pitch);
    var w = WPN[player.weapon];
    var inRange = fighting && want.d < (w.range || 200) * 0.92;
    mouseDown = !!(fighting && inRange && yawErr < 0.055 && pitErr < 0.06 && player.cool <= 0);

    /* ---- feet ----------------------------------------------------------- */
    var mx = 0, mz = 0;
    if (op.k === 'go' && op.at) {
      mx = wx(op.at[0]) - player.x; mz = wx(op.at[1]) - player.z;
      var dist = Math.hypot(mx, mz);
      if (dist < (op.r || 2.6)) { D.i++; D.t = 0; }
      /* sidestep while trading fire, but only in the open */
      if (fighting && want.d < 26) {
        D.strafeT -= dt;
        if (D.strafeT <= 0) { D.strafeT = 0.9 + Math.random() * 0.8; D.strafe = -D.strafe; }
        var sxv = -(D.tgt.z - player.z), szv = (D.tgt.x - player.x);
        var sl = Math.hypot(sxv, szv) || 1;
        mx += (sxv / sl) * dist * 0.55 * D.strafe;
        mz += (szv / sl) * dist * 0.55 * D.strafe;
      }
      if (op.tmax && D.t > op.tmax) { D.i++; D.t = 0; }
    } else if (op.k === 'look' || op.k === 'clear' || op.k === 'wait') {
      if (D.t > (op.t || 1)) { D.i++; D.t = 0; }
      if (op.k === 'clear' && !D.tgt && D.t > 0.45) { D.i++; D.t = 0; }
      if (op.k === 'clear' && op.tmax && D.t > op.tmax) { D.i++; D.t = 0; }
    } else if (op.k === 'use') {
      if (!fighting && yawErr < 0.12) { useAction(); D.i++; D.t = 0; }
      else if (D.t > 6) { useAction(); D.i++; D.t = 0; }
    } else if (op.k === 'hold') {
      /* script exhausted before the clip did: hunt instead of standing there */
      D.done = true;
      if (D.tgt) {
        var hx = D.tgt.x - player.x, hz = D.tgt.z - player.z;
        var hd2 = Math.hypot(hx, hz) || 1;
        if (hd2 > 15) { mx = hx; mz = hz; }
        else {
          D.strafeT -= dt;
          if (D.strafeT <= 0) { D.strafeT = 1.0 + Math.random() * 0.9; D.strafe = -D.strafe; }
          mx = -hz * D.strafe; mz = hx * D.strafe;
        }
      }
    }
    drive(mx, mz);

    /* ---- unstick -------------------------------------------------------- */
    var moved = Math.hypot(player.x - D.px, player.z - D.pz);
    D.px = player.x; D.pz = player.z;
    var trying = keysDown.KeyW || keysDown.KeyS || keysDown.KeyA || keysDown.KeyD;
    if (trying && moved < 0.045) D.stuckT += dt; else D.stuckT = Math.max(0, D.stuckT - dt * 2);
    if (D.stuckT > 0.55) {
      D.stuckT = 0;
      D.strafe = -D.strafe;
      /* shove sideways for a moment, and skip the waypoint if it keeps up */
      keysDown.KeyD = D.strafe > 0; keysDown.KeyA = D.strafe < 0; keysDown.KeyW = true;
      if (++D.stuckHits > 2) { D.stuckHits = 0; D.i++; D.t = 0; }
    }
  }
  D.stuckHits = 0;

  /* =============================================================== CAPTURE = */
  var cap, cg, rec, chunks = [], stream, running = false, t0 = 0, blobUrl = null;

  function pickMime() {
    var c = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (var i = 0; i < c.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i];
    }
    return '';
  }

  /* Pin the renderer to the capture size so the video is a 1:1 copy of the
     framebuffer rather than a rescale of whatever the window happens to be. */
  function lockView() {
    var view = document.getElementById('view');
    window.removeEventListener('resize', resize);
    renderer.setPixelRatio(1);
    renderer.setSize(CFG.W, CFG.H, false);
    camera.aspect = CFG.W / CFG.H; camera.updateProjectionMatrix();
    ov.width = CFG.W; ov.height = CFG.H;
    var fit = function () {
      var s = Math.min(window.innerWidth / CFG.W, window.innerHeight / CFG.H);
      [view, ov].forEach(function (c) {
        c.style.inset = 'auto'; c.style.left = '50%'; c.style.top = '50%';
        c.style.width = (CFG.W * s) + 'px'; c.style.height = (CFG.H * s) + 'px';
        c.style.transform = 'translate(-50%,-50%)';
      });
    };
    fit();
    window.addEventListener('resize', fit);
  }

  /* ---------------------------------------------------------- HUD paint --- */
  var FONT = '"Consolas","Lucida Console","Courier New",monospace';
  function box(g, x, y, w, h) {
    var grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, '#3a3a3a'); grad.addColorStop(1, '#161616');
    g.fillStyle = grad; g.fillRect(x, y, w, h);
    g.strokeStyle = '#d8a018'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
  function label(g, txt, x, y, size, col) {
    g.font = '700 ' + size + 'px ' + FONT;
    g.fillStyle = '#000'; g.fillText(txt, x + 2, y + 2);
    g.fillStyle = col; g.fillText(txt, x, y);
  }
  function fmt(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); }

  function paintHUD(g) {
    var H = CFG.H, W = CFG.W, u = H / 100;   /* 1 vh */

    /* crosshair */
    g.save();
    g.globalAlpha = 0.9;
    g.fillStyle = '#e8e000';
    g.fillRect(W / 2 - 1, H / 2 - 13, 2, 26);
    g.fillRect(W / 2 - 13, H / 2 - 1, 26, 2);
    g.fillStyle = '#111'; g.fillRect(W / 2 - 3, H / 2 - 3, 6, 6);
    g.restore();

    /* bottom-left boxes */
    var bh = 7.4 * u, by = H - 1.2 * u - bh, bx = 1.1 * u;
    var bw = 9.2 * u;
    var w = WPN[player.weapon];
    var cells = [
      { l: 'HEALTH', v: String(Math.ceil(player.hp)), c: player.hp <= 30 ? '#ff4020' : '#f0c83a' },
      { l: 'AMMO', v: String(player.ammo[w.ammo]), c: '#f0c83a' },
      { l: w.name, v: player.medpack > 0 ? player.medpack + '%' : '--', c: '#f0c83a' }
    ];
    g.textBaseline = 'alphabetic';
    for (var i = 0; i < cells.length; i++) {
      var x = bx + i * (bw + 0.7 * u);
      box(g, x, by, bw, bh);
      g.textAlign = 'center';
      label(g, cells[i].l, x + bw / 2, by + 2.1 * u, Math.round(1.15 * u) + 0, '#cfa93a');
      label(g, cells[i].v, x + bw / 2, by + bh - 1.1 * u, Math.round(4.1 * u), cells[i].c);
    }

    /* T / K / S block */
    g.textAlign = 'left';
    var sy = by - 2.2 * u, ss = 2.05 * u;
    var rows = [['T:', fmt(player.time)], ['K:', player.kills + '/' + totalKills], ['S:', player.secrets + '/8']];
    for (var r = rows.length - 1; r >= 0; r--) {
      var yy = sy - (rows.length - 1 - r) * ss * 1.16;
      label(g, rows[r][0], bx, yy, Math.round(ss), '#d03a2a');
      label(g, rows[r][1], bx + ss * 1.5, yy, Math.round(ss), '#e8b830');
    }

    /* keycard chips */
    g.fillStyle = player.keys.red ? '#c81e1e' : 'rgba(200,30,30,.22)';
    g.fillRect(W - 1.1 * u - 2.1 * u, H - 1.2 * u - 3.1 * u, 2.1 * u, 3.1 * u);
    g.strokeStyle = '#000'; g.lineWidth = 2;
    g.strokeRect(W - 1.1 * u - 2.1 * u, H - 1.2 * u - 3.1 * u, 2.1 * u, 3.1 * u);

    /* top message */
    var m = document.getElementById('msg');
    if (m && parseFloat(m.style.opacity || 0) > 0.05 && m.textContent) {
      g.textAlign = 'center';
      g.font = '700 ' + Math.round(2.35 * u) + 'px ' + FONT;
      g.save();
      g.shadowColor = '#2b5bbf'; g.shadowBlur = 12;
      g.fillStyle = '#000'; g.fillText(m.textContent.toUpperCase(), W / 2 + 2, 4.6 * u + 2);
      g.fillStyle = '#8fb8ff'; g.fillText(m.textContent.toUpperCase(), W / 2, 4.6 * u);
      g.restore();
    }
    var sub = document.getElementById('subtitle');
    if (sub && parseFloat(sub.style.opacity || 0) > 0.05 && sub.textContent) {
      g.textAlign = 'center';
      g.font = Math.round(1.6 * u) + 'px ' + FONT;
      g.fillStyle = '#000'; g.fillText(sub.textContent, W / 2 + 2, 8.9 * u + 2);
      g.fillStyle = '#d94b4b'; g.fillText(sub.textContent, W / 2, 8.9 * u);
    }

    /* damage / pickup flash, matching #flash */
    var fl = document.getElementById('flash');
    var op = fl ? parseFloat(fl.style.opacity || 0) : 0;
    if (op > 0.01) {
      g.save();
      g.globalCompositeOperation = 'screen';
      g.globalAlpha = Math.min(1, op);
      g.fillStyle = fl.style.background || '#a00000';
      g.fillRect(0, 0, W, H);
      g.restore();
    }
  }

  /* ------------------------------------------------------- per-frame job -- */
  var vPrev = -1;
  function post(t) {
    rawRAF(post);
    var vt = warp(t);
    var dt = vPrev < 0 ? 0 : Math.min(0.05, (vt - vPrev) / 1000);
    vPrev = vt;

    try { tick(dt); } catch (e) { console.error('[demo] director', e); }

    if (!running) return;

    var view = document.getElementById('view');
    cg.drawImage(view, 0, 0, CFG.W, CFG.H);
    cg.drawImage(ov, 0, 0, CFG.W, CFG.H);
    if (CFG.hud) { try { paintHUD(cg); } catch (e) { /* never kill the capture */ } }

    var elapsed = (performance.now() - t0) / 1000;

    /* automap flourish over the last beat */
    if (CFG.map) showMap = elapsed > CFG.len - 1.5;

    if (elapsed >= CFG.len) stop();
  }

  /* ------------------------------------------------------------- control -- */
  function start() {
    if (running) return;
    if (window.NZ && NZ.level === 2) return;   /* level-1 route only */
    audioInit();
    if (AU.ctx && AU.ctx.state === 'suspended') AU.ctx.resume();

    /* keep pointer lock out of it: the bot writes yaw/pitch directly and a
       lock change would trip the auto-pause. */
    window.lockMouse = function () { };

    /* the demo should survive a stray plasma ball */
    var hurt = window.hurtPlayer;
    window.hurtPlayer = function (d, x, z) { return hurt(d * 0.34, x, z); };

    lockView();

    cap = document.createElement('canvas');
    cap.width = CFG.W; cap.height = CFG.H;
    cg = cap.getContext('2d', { alpha: false });
    cg.fillStyle = '#000'; cg.fillRect(0, 0, CFG.W, CFG.H);

    stream = cap.captureStream(CFG.fps);
    if (CFG.audio && AU.ctx && AU.master && AU.ctx.createMediaStreamDestination) {
      try {
        var dest = AU.ctx.createMediaStreamDestination();
        AU.master.connect(dest);
        dest.stream.getAudioTracks().forEach(function (tr) { stream.addTrack(tr); });
      } catch (e) { console.warn('[demo] no audio track', e); }
    }

    var mime = pickMime();
    chunks = [];
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: CFG.bitrate } : undefined);
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = finish;

    D.route = buildRoute();
    D.i = 0; D.t = 0; D.gt = 0; D.tgt = null; D.live = true; D.done = false;
    D.px = player.x; D.pz = player.z;

    scale = CFG.speed;
    running = true;
    t0 = performance.now();
    rec.start(250);
    startGame();
    rawRAF(post);
    hint('REC  ' + CFG.W + 'x' + CFG.H + '  ' + CFG.speed.toFixed(1) + 'x  ' + CFG.len + 's');
  }

  function stop() {
    if (!running) return;
    running = false;
    D.live = false;
    clearKeys();
    showMap = false;
    scale = 1;
    state.playing = false;
    try { rec.stop(); } catch (e) { }
  }

  function finish() {
    var type = (rec && rec.mimeType) || 'video/webm';
    var ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    var blob = new Blob(chunks, { type: type.split(';')[0] });
    blobUrl = URL.createObjectURL(blob);
    var name = 'nukezone3d-' + CFG.W + 'x' + CFG.H + '.' + ext;

    if (CFG.save) {
      var a = document.createElement('a');
      a.href = blobUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    }
    panel(blobUrl, name, ext, blob.size);
  }

  /* ---------------------------------------------------------------- chrome */
  function hint(txt) {
    var d = document.getElementById('demoHint') || document.createElement('div');
    d.id = 'demoHint';
    d.style.cssText = 'position:fixed;top:10px;right:12px;z-index:60;font:700 12px ' + FONT +
      ';letter-spacing:.14em;color:#ff5a4a;background:rgba(0,0,0,.6);padding:5px 10px;' +
      'border:1px solid #ff5a4a;border-radius:3px;pointer-events:none';
    d.textContent = txt;
    document.body.appendChild(d);
  }

  function panel(url, name, ext, size) {
    var h = document.getElementById('demoHint'); if (h) h.remove();
    var p = document.createElement('div');
    p.style.cssText = 'position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:16px;background:rgba(0,0,0,.94);' +
      'font-family:' + FONT + ';color:#f0c83a;text-align:center;padding:24px';
    var warn = ext === 'mp4' ? '' :
      '<div style="color:#d94b4b;font-size:13px;max-width:52ch;line-height:1.7">' +
      'Your browser recorded WebM. Twitter/X only accepts MP4 &mdash; run it through ' +
      'any converter (or CloudConvert) before uploading. Chrome on desktop usually ' +
      'gives you MP4 directly.</div>';
    p.innerHTML =
      '<div style="font-size:26px;letter-spacing:.16em;color:#f5a623">CLIP READY</div>' +
      '<video src="' + url + '" controls autoplay loop playsinline ' +
      'style="max-width:min(72vw,900px);max-height:52vh;border:2px solid #d8a018;background:#000"></video>' +
      '<div style="font-size:13px;color:#c9c2b4;letter-spacing:.1em">' +
      name + ' &nbsp;&bull;&nbsp; ' + (size / 1048576).toFixed(1) + ' MB &nbsp;&bull;&nbsp; ' +
      CFG.len + 's @ ' + CFG.speed.toFixed(1) + 'x &nbsp;&bull;&nbsp; ' + player.kills + ' kills' +
      '</div>' + warn +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">' +
      '<a id="dlBtn" class="btn" style="margin-top:0;text-decoration:none;display:inline-block" ' +
      'href="' + url + '" download="' + name + '">SAVE AGAIN</a>' +
      '<button id="reBtn" class="btn" style="margin-top:0">RECORD AGAIN</button>' +
      '<button id="qBtn" class="btn" style="margin-top:0">BACK TO GAME</button>' +
      '</div>';
    document.body.appendChild(p);
    p.querySelector('#reBtn').onclick = function () { location.reload(); };
    p.querySelector('#qBtn').onclick = function () { location.href = location.pathname; };
  }

  /* ------------------------------------------------------------- wire up -- */
  function install() {
    /* the scripted route is Hollywood Holocaust grid coordinates; on The
       Crucible (boot sets NZ.level = 2 before state.booted) stay inert */
    if (window.NZ && NZ.level === 2) return;
    var title = document.getElementById('scTitle');
    if (!title) return;

    if (!CFG.armed) {
      /* unarmed: offer a one-click jump into demo mode, nothing else changes */
      var link = document.createElement('button');
      link.className = 'btn';
      link.style.cssText = 'margin-top:1.4vh;padding:.8vh 2.2vw;font-size:clamp(10px,1.5vh,15px)';
      link.textContent = 'RECORD A 30s DEMO CLIP';
      link.onclick = function () { location.search = '?demo=1'; };
      title.appendChild(link);
      return;
    }

    var start$ = document.getElementById('btnStart');
    start$.textContent = 'RECORD DEMO';
    start$.onclick = start;

    var note = document.createElement('div');
    note.className = 'small';
    note.style.marginTop = '1.6vh';
    note.innerHTML = 'DEMO MODE &mdash; ' + CFG.W + '&times;' + CFG.H + ' &bull; ' +
      CFG.len + 's &bull; ' + CFG.speed.toFixed(1) + '&times; speed &bull; auto-saves when done' +
      '<br>the game plays itself: Yildiz Tepesi arena, 233 Sk, secret wall, alley, theatre';
    title.appendChild(note);
  }

  /* boot() shows the title screen only after the loader finishes */
  var poll = setInterval(function () {
    if (typeof state !== 'undefined' && state.booted) { clearInterval(poll); install(); }
  }, 120);

  /* manual escape hatch */
  window.NUKEDEMO = { start: start, stop: stop, cfg: CFG, D: D, tick: tick, route: buildRoute };
})();
