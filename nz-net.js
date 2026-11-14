/* ===========================================================================
   NZ-NET  --  multiplayer, browser to browser.

   Open the game with  #mp=ROOM&level=N  in the address and it becomes a
   multiplayer room on mission N (2 = ER MEYDANI, 4 = ABLUKA): a team match
   with bots, or the old free-for-all deathmatch if the link also says
   &mode=dm. Without #mp= this file adds one MULTIPLAYER button to the title
   screen, which asks for a map, and nothing else: single player is
   untouched.

   HOW THE PLAYERS TALK
     The game server (server/mp-server.mjs) only introduces the browsers: a
     WebSocket at /signal passes the few setup messages WebRTC needs. Then
     every pair of players is connected DIRECTLY (a full mesh), over two data
     channels each:

       's'  unordered, no resends    state every frame, pings
       'e'  reliable, in order       gunfire, hits, deaths, names, hello,
                                     the round, the damage snapshot for a
                                     late arrival

     Gunfire rides the reliable channel because every round that lands on a
     wall -- a player's or a bot's -- is replayed on the other screens
     through the same surfaceHit hook the shooter's own hitscan used, so a
     pane, a car window or a crate breaks the same way everywhere
     (nz-destruct.js is deterministic for the same hit, direction, origin
     and damage). A lost shot would be a pane intact on one screen and gone
     on another.

     A lost position update is simply skipped -- the next one is a frame
     behind it -- so a dropped packet never stalls the ones after it, which is
     what a WebSocket (TCP) would do.

   WHO DECIDES WHAT
     Each browser simulates its own player, exactly as in single player, so
     your own movement has no network delay at all. The SHOOTER's screen
     decides hits: a round is tested against the other players as they are
     drawn on that screen (the real solved skeleton, see nz-hero.js section
     11), and the victim's browser applies the damage to itself. Deaths are
     announced by the victim; every browser keeps the same score from them.

   DRAWING THE OTHER PLAYERS
     Remote players are shown a couple of packets in the past (interpolated
     between real snapshots, ~25-60 ms behind depending on jitter) and only
     extrapolated briefly when a packet is late. Each one is a full
     third-person figure from nz-hero.js in the jacket colour the room gave
     that player; a capsule stands in if that module is unavailable.

   THE MATCH
     All enemies, pickups and lifts are switched off; normal doors start
     open, secret and key doors stay shut. Everyone spawns with the same
     hitscan arsenal (no RPG, grenades or NULLSTAR yet).

     TEAM MATCH (the default)   Two sides of TEAM_SIZE. Bots (nz-bots.js) sit
     in every seat a person has not taken, so one player alone still gets a
     full match. A round has no respawns: it ends when one side is all down,
     the dead watch a team-mate until then, and the first side to
     ROUNDS_TO_WIN rounds takes the match. You cannot hit your own side.

     DEATHMATCH (&mode=dm)   The original free-for-all: no teams, no bots,
     respawn 3 s after dying at the spawn point farthest from the others.

   THE MAPS
     Mission 2 is played whole. Mission 4 is a whole city, so the match takes
     a fenced part of it (MAPS below): the roundabout where 232 and 233 Sk
     meet, GUVEN ECZANESI, 232 Sk from the north gate to past the car post,
     233 Sk from C-BLOK up the slope to the 230 Sk crossing, and the ground
     floors of A-BLOK, B-BLOK and the C-BLOK hall. canStand() refuses a step out
     of it (players and bots alike), the bots' paths keep to it
     (NZ.bots.setAllow), the fence is the mission's own bariyer (stood by
     nz-street-side through its 'streetSideCordon' hook), only doors inside
     it open, and only spawn points inside it are used. Rounds still fly
     over the fence.

     A slow machine trades resolution for frames during a match (GOV below):
     first the pixel ratio, then the scene scale, each cut kept only if it
     bought frame time. nz-render's own ladder sheds post effects first.

   WHO RUNS A TEAM MATCH
     One browser: of the players who have joined the match, the one who came
     into the room first (authId). It deals the sides, starts and ends the
     rounds, runs the bots and sends each of them out like a player (state
     type 4). A hit on a bot is sent to that browser; a bot's hit on you
     comes from it. If it leaves, the next browser in line takes over and
     the round is dealt again. It repeats the round ('r') every second, so a
     browser that missed a change catches up.

   CONTRACT WITH THE REST OF THE GAME
     Wraps, only in a multiplayer room: spawnEnemy, makePickup, updateLifts,
     useAction, winLevel, saveManualGame, killPlayer, fire, hitscan,
     startGame, placeEntities, and canStand on a fenced map. Reads player,
     WPN, state, D, AMMOMAX, DOORS, LEVEL, MW, MH, CELL, grid by name
     (top-level script bindings); calls castWall, floorAt, impactSurface,
     impactPuff, impactDecal, sfx, tracer, resize. Uses NZ.destruct
     (snapshot/restore, carGlass), NZ.render.setScale/stats,
     NZ.streetPark.gradeAt, NZ.bots.setAllow. 'render' hook at priority
     40, ahead of nz-hero's figures (20 and 19); a second one at 15, after
     them, puts the camera on a team-mate while you are down.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;

  var PROTO = 2;                 /* must equal PROTO in server/mp-server.mjs */
  var NET = NZ.net = { PROTO: PROTO, active: false, room: null };

  /* ------------------------------------------------------------ tuning -- */
  var SEND_MIN = 1 / 62;         /* state packets: every frame, at most ~60/s   */
  var PING_EVERY = 1.0;
  var RESPAWN_DELAY = 3.0;
  var SPAWN_PROTECT = 1.25;      /* seconds of invulnerability after a respawn  */
  var STALE_AFTER = 6.0;         /* no packets for this long: hide the figure    */
  var ZONE_MULT = { head: 2.5, body: 1.0, limb: 0.75 };
  var COLORS = ['#b8322c', '#2f62c9', '#3c9a46', '#d1a32a', '#8e3fb8', '#d0662a', '#2aa6a8', '#cfcfcf'];
  var NAME_KEY = 'nuke-zone-3d:mp-name:v1';
  /* the deathmatch arsenal: every hitscan gun, nothing that explodes yet */
  var LOAD_HAS = [true, true, true, false, true, false, true, true, true, false];
  var LOAD_AMMO = { clip: 120, shell: 40, chain: 200, rifle: 150, ak: 120, dmr: 20 };
  var LOAD_WEAPON = 6;           /* AK-PATTERN */
  /* the team match */
  var TEAM_SIZE = 2;             /* players a side; bots fill the empty seats    */
  var ROUNDS_TO_WIN = 5;
  var ROUND_TIME = 120;          /* seconds; then the side with more standing    */
  var ROUND_GAP = 5.0;           /* between a round ending and the next          */
  var MATCH_GAP = 9.0;           /* between a match ending and the next          */
  var TEAMS = [
    { name: 'KIRMIZI', color: '#b8322c', tag: '#ff8a7c' },
    { name: 'MAVİ', color: '#2f62c9', tag: '#8fb8ff' }
  ];
  var BOT_NAMES = ['BOT KARTAL', 'BOT ŞAHİN', 'BOT DOĞAN', 'BOT ATMACA', 'BOT BOZKURT', 'BOT YILDIRIM', 'BOT POYRAZ', 'BOT TUNA'];
  var BOT_WEAPON = 6;
  var SKILL_KEY = 'nuke-zone-3d:mp-bots:v1';
  var SKILL_NAMES = { easy: 'KOLAY', normal: 'ORTA', hard: 'ZOR' };

  /* ----------------------------------------------------------- helpers -- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function nowS() { return performance.now() / 1000; }
  function angWrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function warn() { try { console.warn.apply(console, ['[nz-net]'].concat([].slice.call(arguments))); } catch (e) { } }
  function routeParam(name) {
    try {
      var m = new RegExp('(?:[#&?])' + name + '=([^&#]*)').exec(global.location.hash + '&' + global.location.search);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function randomCode(n) {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    var buf = new Uint8Array(n);
    (global.crypto && crypto.getRandomValues) ? crypto.getRandomValues(buf) : buf.forEach(function (_, i) { buf[i] = Math.random() * 256; });
    for (var i = 0; i < n; i++) s += A[buf[i] % A.length];
    return s;
  }
  function randomId() { return randomCode(12).toLowerCase().replace(/[^a-z0-9]/g, 'x'); }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function cleanName(s) { return String(s || '').replace(/[^\p{L}\p{N} ._\-]/gu, '').trim().slice(0, 16); }
  function wepName(w) { try { return (WPN[w] && WPN[w].name) || 'SİLAH'; } catch (e) { return 'SİLAH'; } }

  /* ============================================================= maps == */
  /* What a room can be played on, in picker order. A map with `rects` is a
     fenced corner of a bigger mission: grid cells x0,y0..x1,y1 inclusive
     (world = cell * CELL), their union is the arena. `spawns` are cells
     added to the enemy positions that fall inside it. */
  var MAPS = [
    { level: 2, name: 'ER MEYDANI', note: 'kapalı arena, bütün harita' },
    {
      level: 4, name: 'ABLUKA', note: 'Seydişehir: kavşak, dört sokak ve üç blok',
      /* v2 (2026-11-14, "there is no way to hide"): every street pushed back
         -- the north arm to the mission's own north gate, the canyon past
         the parked car to the 230 Sk crossing, the south arm past the car
         post, the uphill boulevard to C-BLOK -- and the ground floors of
         A-BLOK, B-BLOK and the C-BLOK hall for cover. The upper floors
         (lifts are parked in a match) and the park stay out. */
      rects: [
        [121, 1, 144, 35],    /* 232 Sk north arm, to the mission's north gate  */
        [116, 31, 120, 34],   /* GUVEN ECZANESI, the raised corner pharmacy     */
        [78, 36, 144, 52],    /* the roundabout and 233 Sk up the slope to C-BLOK */
        [68, 26, 95, 35],     /* SEYDIKENT C-BLOK's hall and its door (79,35)   */
        [145, 35, 207, 51],   /* 233 Sk east, past the car and 230 Sk, to the
                                 mission's own police line on col 208            */
        [190, 29, 197, 34],   /* 230 Sk's north stub, closed by the police line */
        [121, 53, 144, 88],   /* 232 Sk south arm, past the car post            */
        [145, 19, 184, 33],   /* A-BLOK ground floor: rooms and the corridor    */
        [145, 55, 184, 70]    /* B-BLOK ground floor: rooms and the corridor    */
      ],
      spawns: [[119, 33], [155, 43], [115, 49], [126, 45], [131, 56], [129, 27]],
      /* Cover on the stretches that had none: the mission's own plywood
         crates, in pairs, staggered side to side every six or seven cells.
         They are stock crates in every way -- waist-high, breakable, broken
         the same on every screen -- and keep doors, kerbs and spawns clear. */
      cover: [
        /* 232 Sk north */ [128, 4], [129, 4], [137, 8], [137, 9], [123, 12], [123, 13], [132, 15], [133, 15], [142, 17], [142, 18],
        /* 232 Sk south */ [127, 66], [128, 66], [138, 72], [138, 73], [123, 76], [123, 77], [132, 80], [133, 80], [142, 84], [142, 85],
        /* 233 Sk slope */ [82, 40], [82, 41], [88, 48], [89, 48], [95, 39], [96, 39], [102, 47], [102, 48], [108, 40], [109, 40],
        /* 233 Sk east  */ [178, 43], [179, 43], [201, 41], [201, 42]
      ],
      /* a 1.4 m retaining wall is fence enough: no bariyer on an edge whose
         outside stands this much higher */
      fenceRise: 2.5
    }
  ];
  function mapFor(level) {
    for (var i = 0; i < MAPS.length; i++) if (MAPS[i].level === level) return MAPS[i];
    return null;
  }
  /* The map choice: two buttons under the menu row, shown on demand. Used by
     the title screen's MULTIPLAYER button (a new room) and by the lobby's
     change button (the same room under another map, like the mode switch:
     a link already sent follows it there). */
  function mapCss() {
    if ($('nzMapCss')) return;
    var s = document.createElement('style');
    s.id = 'nzMapCss';
    s.textContent =
      '.nzmaps{display:none;flex-direction:column;align-items:center;gap:1vh;margin-top:1.8vh}' +
      '.nzmaps.on{display:flex}' +
      '.nzmaps .lbl{font-size:clamp(10px,1.4vh,14px);letter-spacing:.16em;color:#9e8c6b}' +
      '.nzmaps .row{display:flex;gap:clamp(9px,1vw,18px);flex-wrap:wrap;justify-content:center}' +
      '.nzmaps .btn{margin-top:0;display:flex;flex-direction:column;align-items:center;gap:.5vh;padding:1.1vh 2.2vw}' +
      '.nzmaps .btn small{font-size:clamp(9px,1.25vh,13px);letter-spacing:.06em;font-weight:600;color:#d6c39a;text-transform:none}' +
      '.nzmaps .btn.cur{border-color:#8fb8ff;color:#cfe0ff}';
    document.head.appendChild(s);
  }
  function mapPicker(id, current, onPick) {
    mapCss();
    var box = document.createElement('div');
    box.className = 'nzmaps'; box.id = id;
    var html = '<div class="lbl">HARİTA SEÇ</div><div class="row">';
    for (var i = 0; i < MAPS.length; i++) {
      var M = MAPS[i];
      html += '<button class="btn' + (M.level === current ? ' cur' : '') + '" type="button" data-level="' + M.level + '">' +
        esc(M.name) + '<small>' + esc(M.note) + '</small></button>';
    }
    box.innerHTML = html + '</div>';
    var bs = box.querySelectorAll('button[data-level]');
    for (var j = 0; j < bs.length; j++) bs[j].onclick = function () { onPick(parseInt(this.getAttribute('data-level'), 10)); };
    return box;
  }

  /* =====================================================================
     NOT A MULTIPLAYER ROOM: one button on the title screen, nothing else.
     ================================================================== */
  var roomParam = routeParam('mp');
  if (roomParam === null) {
    NZ.on('ready', function () {
      try {
        var title = $('scTitle');
        var acts = title && title.querySelector('.menu-actions');
        if (!acts || $('btnMulti')) return;
        var pick = mapPicker('nzMaps', 0, function (level) {
          global.location.hash = 'mp=' + randomCode(5) + '&level=' + level;
          global.location.reload();
        });
        title.insertBefore(pick, acts.nextSibling);
        var b = document.createElement('button');
        b.className = 'btn'; b.id = 'btnMulti'; b.type = 'button';
        b.textContent = 'ÇOK OYUNCULU';
        b.onclick = function () {
          if (global.location.protocol === 'file:') {
            var info = $('continueInfo');
            if (info) { info.textContent = 'ÇOK OYUNCULU İÇİN OYUN SUNUCUSU GEREKLİ — npm run mp KOMUTUNU ÇALIŞTIR VE YAZDIĞI ADRESİ AÇ'; info.className = 'save-note err'; }
            return;
          }
          pick.classList.toggle('on');
        };
        acts.appendChild(b);
      } catch (err) { warn('lobby button failed:', err); }
    });
    return;
  }

  /* =====================================================================
     A MULTIPLAYER ROOM
     ================================================================== */
  var ROOM = String(roomParam).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  NET.active = true;
  NET.room = ROOM;
  /* the room plays mission 2 unless the link says otherwise; boot() reads the
     hash on 'load', after this file has run */
  if (!/(?:[#&?])level=[1-4]/.test(global.location.hash + '&' + global.location.search)) {
    try { history.replaceState(null, '', global.location.pathname + global.location.search + '#' + global.location.hash.replace(/^#/, '') + '&level=2'); }
    catch (e) { }
  }
  /* LEVEL itself is only promoted when boot() runs; the handshake starts
     before that, so it reads the mission from the address the same way */
  var ROUTE_LEVEL = clamp(parseInt(routeParam('level'), 10) || 2, 1, 4);
  /* 'team' unless the link says &mode=dm. A room has one mode: the server
     tells a late joiner which, and everything below asks teamMode(). */
  var MODE = routeParam('mode') === 'dm' ? 'dm' : 'team';
  function teamMode() { return MODE === 'team'; }
  var MAP = mapFor(ROUTE_LEVEL) || { level: ROUTE_LEVEL, name: '', note: '' };
  var AR = null;                 /* fenced map: 1 per grid cell in play       */
  var LATE = { fires: [], snap: null };   /* arrived before the level did   */

  var ME = {
    id: randomId(), name: '', color: 0, welcomed: false, inMatch: false,
    life: 0, frags: 0, deaths: 0, respawnAt: 0, lastSpawn: -1, seq: 0, sendT: 0, pingT: 0, hudT: 0,
    /* team match: side this round (-1: not dealt in), side asked for (-1:
       either), when we came into the room (who runs the match), watching */
    team: -1, want: -1, j: 0, spec: false, spawned: false, hidden: false, firedAt: -9, botSendT: 0,
    /* impacts replayed from others, damage snapshots taken in, the last
       spot inside the fence, when the level came up, pulls back inside */
    replayed: 0, snapsIn: 0, good: null, readyT: 0, fenced: 0
  };
  try { ME.name = cleanName(localStorage.getItem(NAME_KEY)) || ''; } catch (e) { }
  if (!ME.name) ME.name = 'OYUNCU ' + (10 + Math.floor(Math.random() * 90));

  var PEERS = {};                /* id -> peer */
  var BOTS = {};                 /* '#b0'.. -> a bot, drawn exactly like a peer  */
  var SIMS = {};                 /* slot -> its brain; only where the match runs */
  /* the round, as the browser running the match last described it */
  var ROUND = {
    auth: null, q: 0, key: '', n: 0, ph: 'wait', sc: [0, 0], ro: [], win: -1, sk: 'normal',
    endsAt: 0, nextAt: 0, startT: 0, beatT: 0
  };
  var SKILL = 'normal';          /* this browser's bot difficulty, used if it runs the match */
  try { var sk0 = localStorage.getItem(SKILL_KEY); if (sk0 && SKILL_NAMES[sk0]) SKILL = sk0; } catch (e) { }
  var ICE = [];
  var ROOM_MAX = 4, HOST_ID = null;
  var SPAWN_CELLS = [], SPAWN_PTS = [];
  var PENDING_KILLER = null;     /* who is shooting while hurtPlayer runs        */
  var SHOT = { active: false, rays: [], dmg: {}, w: 0, org: null, d: 0 };
  var ORIG = {};
  var ERR = 0;
  var BUILD = 'dev';
  try { var bm = document.querySelector('meta[name="nz-build"]'); if (bm) BUILD = bm.getAttribute('content') || 'dev'; } catch (e) { }

  function netError(err, where) {
    ERR++;
    if (ERR <= 5) console.error('[nz-net] ' + (where || 'frame') + ' failed:', err);
  }

  /* ------------------------------------------------------ game wrappers -- */
  function wrap(name, make) {
    var f = global[name];
    if (typeof f !== 'function') { warn('cannot find ' + name + '() -- multiplayer may misbehave'); return false; }
    ORIG[name] = f;
    global[name] = make(f);
    return true;
  }

  /* No enemies: their spawn points become ours. */
  wrap('spawnEnemy', function () {
    return function (kind, gx, gy) { SPAWN_CELLS.push([gx, gy]); return null; };
  });
  /* No pickups in v1: everyone carries the same arsenal. */
  wrap('makePickup', function () { return function () { return null; }; });
  /* Lifts stay where they start: a lift ridden on one screen and not on the
     others would show players floating. Every level the stairs reach. */
  wrap('updateLifts', function () { return function () { }; });
  /* E opens nothing: doors are open from the start, secrets stay shut. */
  wrap('useAction', function () { return function () { }; });
  wrap('winLevel', function () { return function () { }; });
  wrap('saveManualGame', function () {
    return function () {
      var s = $('saveStatus');
      if (s) { s.textContent = 'ÇOK OYUNCULU MAÇTA KAYIT YAPILAMAZ'; s.className = 'save-note err'; }
      return false;
    };
  });
  wrap('placeEntities', function (orig) {
    return function () {
      var r = orig.apply(this, arguments);
      try { afterPlace(); } catch (err) { netError(err, 'afterPlace'); }
      return r;
    };
  });
  wrap('startGame', function (orig) {
    return function () {
      var r = orig.apply(this, arguments);
      try { enterMatch(); } catch (err) { netError(err, 'enterMatch'); }
      return r;
    };
  });
  /* Death in a match is a 3 s wait, not the end of the game. */
  wrap('killPlayer', function (orig) {
    return function () {
      if (!ME.inMatch) return orig.apply(this, arguments);
      try { localDeath(); } catch (err) { netError(err, 'death'); }
    };
  });
  /* One trigger pull: collect every pellet's ray and every hit, then tell the
     others once. */
  wrap('fire', function (orig) {
    return function () {
      if (!ME.inMatch) return orig.apply(this, arguments);
      SHOT.active = true; SHOT.rays.length = 0; SHOT.dmg = {}; SHOT.w = player.weapon; SHOT.org = null; SHOT.d = 0;
      try { return orig.apply(this, arguments); }
      finally {
        SHOT.active = false;
        try { if (SHOT.rays.length) { ME.firedAt = nowS(); sendFire(SHOT.w, SHOT.rays, SHOT.org, SHOT.d); flushHits(SHOT.w); } }
        catch (err) { netError(err, 'fire'); }
      }
    };
  });
  /* A round is tested against the other players as they are drawn here, up
     to the first wall. A miss is the stock shot: impact, decal, sound. */
  wrap('hitscan', function (orig) {
    return function (org, dir, range, dmg, quiet) {
      if (!ME.inMatch) return orig.apply(this, arguments);
      var wallD = range;
      try { wallD = castWall(org, dir, range); } catch (e) { }
      var hit = null;
      try { hit = rayPeers(org, dir, wallD); } catch (err) { netError(err, 'rayPeers'); }
      var t = hit ? hit.t : wallD;
      if (SHOT.active && SHOT.rays.length < 12) {
        /* the stock path below decides a wall hit only while bestT < range:
           a round that ran out of range landed nowhere, here or there */
        var nowhere = !hit && !(wallD < range - 0.1);
        SHOT.rays.push([org.x + dir.x * t, org.y + dir.y * t, org.z + dir.z * t, hit ? 1 : nowhere ? 2 : 0]);
        if (!SHOT.org) SHOT.org = [org.x, org.y, org.z];
        SHOT.d = fin(dmg, SHOT.d);
      }
      if (!hit) return orig.apply(this, arguments);
      try { hitPeer(hit, org, dir, dmg); } catch (err) { netError(err, 'hitPeer'); }
    };
  });
  /* A fenced map: the edge of the arena is a wall to feet, not to rounds.
     Same footprint test as canStand itself, one cell set wider. */
  function arenaIn(cx, cy) {
    if (!AR) return true;
    return cx >= 0 && cy >= 0 && cx < MW && cy < MH && AR[cy * MW + cx] === 1;
  }
  /* Cover crates (MAPS[].cover) join the level's crate list before the
     level builds its crates, so everything that knows crates -- nz-env's
     merged pile, nz-destruct's hit points, the damage snapshot, the bots'
     walls -- takes them as stock. */
  var COVER = {};
  if (MAP.cover) wrap('makeCrates', function (orig) {
    return function () {
      try { addCover(); } catch (err) { netError(err, 'cover'); }
      var r = orig.apply(this, arguments);
      try { seatCover(); } catch (err) { netError(err, 'cover'); }
      return r;
    };
  });
  function addCover() {
    for (var i = 0; i < MAP.cover.length; i++) {
      var cx = MAP.cover[i][0] | 0, cy = MAP.cover[i][1] | 0;
      if (cx < 0 || cy < 0 || cx >= MW || cy >= MH || grid[idx(cx, cy)] !== S_FLOOR || COVER[cx + ',' + cy]) continue;
      grid[idx(cx, cy)] = S_BLOCK;
      CRATES.push([cx, cy]);
      COVER[cx + ',' + cy] = 1;
    }
  }
  /* The slope is drawn on the park's smooth grade, up to half a unit under
     the stepped floor the grid walks on; a crate there stands on the grade
     at its downhill edge instead of in the air. */
  function coverBase(cx, cy) {
    if (!COVER[cx + ',' + cy]) return null;
    var f = 0;
    try { f = floorAt(cx, cy); } catch (e) { return null; }
    if (!(f > 0.6) || !NZ.streetPark || typeof NZ.streetPark.gradeAt !== 'function') return null;
    var g = NZ.streetPark.gradeAt(cx * CELL + CELL * 0.96);
    return isFinite(g) && g < f && g > f - 1 ? g : null;
  }
  function seatCover() {
    for (var i = 0; i < CRATE_MESHES.length; i++) {
      var c = CRATE_MESHES[i], b = coverBase(c.cx, c.cy);
      if (b !== null && c.mesh) c.mesh.position.y = b + CRATE_H * 0.5;
    }
  }
  if (MAP.cover) NZ.crateBase = coverBase;

  if (MAP.rects) wrap('canStand', function (orig) {
    return function (x, z, rad) {
      if (AR) {
        var r = fin(rad, 0);
        var c0 = Math.floor((x - r) / CELL), c1 = Math.floor((x + r) / CELL);
        var r0 = Math.floor((z - r) / CELL), r1 = Math.floor((z + r) / CELL);
        for (var cy = r0; cy <= r1; cy++) for (var cx = c0; cx <= c1; cx++) if (!arenaIn(cx, cy)) return false;
      }
      return orig.apply(this, arguments);
    };
  });

  /* ------------------------------------------------------ level set-up -- */
  /* the arena of a fenced map, as a cell mask over the level grid */
  function buildArena() {
    if (!MAP.rects) return;
    var m = new Uint8Array(MW * MH);
    for (var i = 0; i < MAP.rects.length; i++) {
      var R = MAP.rects[i];
      for (var y = Math.max(0, R[1]); y <= Math.min(MH - 1, R[3]); y++)
        for (var x = Math.max(0, R[0]); x <= Math.min(MW - 1, R[2]); x++) m[y * MW + x] = 1;
    }
    AR = m;
  }
  /* how far a sight line runs before a wall or the fence */
  function openRun(org, dir, maxD) {
    var free = 0;
    try { free = castWall(org, dir, maxD); } catch (e) { free = 0; }
    if (AR) for (var s = 1; s < free; s++) {
      if (!arenaIn(Math.floor((org.x + dir.x * s) / CELL), Math.floor((org.z + dir.z * s) / CELL))) { free = s; break; }
    }
    return free;
  }

  function afterPlace() {
    buildArena();
    /* Enemy positions are where the level designer put fights: good spawn
       points, spread over every tier. The single-player start joins them;
       on a fenced map only the ones inside count, plus the map's own. */
    var pts = [], used = {};
    var add = function (gx, gy, yaw) {
      var k = gx + ',' + gy;
      if (used[k]) return;
      used[k] = 1;
      if (!arenaIn(gx, gy)) return;
      try { if (typeof liftAt === 'function' && liftAt(gx, gy)) return; } catch (e) { }
      try { if (blockedCell(gx, gy)) return; } catch (e) { }
      /* two spawns a cell apart are one spawn twice as likely */
      for (var n = 0; n < pts.length; n++) {
        if (Math.abs(pts[n].gx - gx) <= 1 && Math.abs(pts[n].gy - gy) <= 1) return;
      }
      var y = 0;
      try { y = floorAt(gx, gy); } catch (e) { }
      pts.push({ x: gx * CELL + CELL / 2, y: fin(y), z: gy * CELL + CELL / 2, yaw: yaw, gx: gx, gy: gy });
    };
    for (var i = 0; i < SPAWN_CELLS.length; i++) add(SPAWN_CELLS[i][0], SPAWN_CELLS[i][1], null);
    add(Math.floor(player.x / CELL), Math.floor(player.z / CELL), player.yaw);
    if (MAP.spawns) for (var ms = 0; ms < MAP.spawns.length; ms++) add(MAP.spawns[ms][0], MAP.spawns[ms][1], null);
    /* Face the longest clear sight line from each spot, so nobody spawns
       nose to a wall; between equally open directions, prefer the one
       toward the middle of the map. */
    var cx = 0, cz = 0;
    for (var j = 0; j < pts.length; j++) { cx += pts[j].x; cz += pts[j].z; }
    cx /= Math.max(1, pts.length); cz /= Math.max(1, pts.length);
    var org = new THREE.Vector3(), dir = new THREE.Vector3();
    var eye = (typeof EYE === 'number') ? EYE : 6;
    for (var k2 = 0; k2 < pts.length; k2++) {
      var p = pts[k2];
      if (p.yaw !== null) continue;
      var toMid = Math.atan2(p.x - cx, p.z - cz), bestYaw = toMid, bestScore = -1;
      for (var a = 0; a < 24; a++) {
        var yaw = a / 24 * Math.PI * 2;
        org.set(p.x, p.y + eye, p.z);
        dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        var free = openRun(org, dir, 120);
        var score = Math.min(free, 120) + 6 * Math.cos(angWrap(yaw - toMid));
        if (score > bestScore) { bestScore = score; bestYaw = yaw; }
      }
      p.yaw = bestYaw;
    }
    SPAWN_PTS = pts;
    /* Doors: open the ordinary ones for good, leave secrets and the key door
       shut (useAction is off, so nobody can open them on one screen only).
       On a fenced map only a door inside the arena opens; one in its edge is
       a wall like the rest of the edge, so it is held shut. */
    try {
      for (var d = 0; d < DOORS.length; d++) {
        var dr = DOORS[d];
        if (dr.secret || dr.kind === 'key') continue;
        if (!arenaIn(dr.cx, dr.cy)) { dr.tgt = 0; continue; }
        dr.tgt = 1; dr.used = true;
      }
      updateDoors(10);
    } catch (err) { netError(err, 'doors'); }
    if (AR && pts.length < 4) warn('only ' + pts.length + ' spawn points inside the arena');
    /* the bots walk the same arena: their paths keep to the cells in play */
    try { if (NZ.bots && NZ.bots.setAllow) NZ.bots.setAllow(AR ? function (i) { return AR[i] === 1; } : null); }
    catch (err) { netError(err, 'bots-arena'); }
  }

  /* ------------------------------------------------ the arena's fence -- */
  /* Every edge between a cell in play and a walkable cell outside it gets a
     bariyer, merged into straight runs and split wherever the ground under
     it steps. nz-street-side builds them while it builds the street, so they
     are lit and merged exactly like the police lines the mission already has.
     Edges against a wall, a block, a closed door or a much higher terrace
     need nothing. */
  function walkableCell(cx, cy, openDoor) {
    if (cx < 0 || cy < 0 || cx >= MW || cy >= MH) return false;
    var t = grid[cy * MW + cx];
    if (t === S_SOLID || t === S_EXIT || t === S_BLOCK) return false;
    if (t === S_DOOR || t === S_KEY || t === S_SECRET) {
      if (!openDoor) return false;
      for (var i = 0; i < DOORS.length; i++) if (DOORS[i].cx === cx && DOORS[i].cy === cy) return DOORS[i].tgt > 0.5;
      return false;
    }
    return true;
  }
  function fenceRuns(api) {
    var edges = {}, rise = fin(MAP.fenceRise, 2.5), C = CELL;
    var vis = function (x, z) {
      /* the visible ground under a point: the street decks on the arms, the
         park's grade on the slope, the grid floor elsewhere */
      var cx = Math.floor(x / C), cy = Math.floor(z / C), f = 0;
      try { f = floorAt(cx, cy); } catch (e) { }
      if (api.armGroundY && x >= 484 && x <= 580 && (z <= 144 || z >= 208)) return api.armGroundY(x);
      if (Math.abs(f) < 0.01) return api.ROAD_TOP;
      if (Math.abs(f - 0.5) < 0.01) return api.PAVE_TOP;
      if (f > 0.6 && NZ.streetPark && typeof NZ.streetPark.gradeAt === 'function') return NZ.streetPark.gradeAt(x);
      return f;
    };
    var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var cy = 0; cy < MH; cy++) for (var cx = 0; cx < MW; cx++) {
      if (!AR[cy * MW + cx] || !walkableCell(cx, cy, true)) continue;
      var fIn = 0; try { fIn = floorAt(cx, cy); } catch (e) { }
      for (var k = 0; k < 4; k++) {
        var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (arenaIn(nx, ny) || !walkableCell(nx, ny, false)) continue;
        var fOut = 0; try { fOut = floorAt(nx, ny); } catch (e) { }
        if (fOut > fIn + rise) continue;
        /* a line key: axis, the line's coordinate and which side is inside */
        var axis = DIRS[k][0] ? 'z' : 'x';
        var line = DIRS[k][0] ? (DIRS[k][0] > 0 ? cx + 1 : cx) * C : (DIRS[k][1] > 0 ? cy + 1 : cy) * C;
        var near = DIRS[k][0] ? -DIRS[k][0] : -DIRS[k][1];
        var key = axis + line + ':' + near;
        (edges[key] || (edges[key] = { axis: axis, c: line, near: near, cells: [] })).cells.push(axis === 'z' ? cy : cx);
      }
    }
    /* Each line breaks into stretches of consecutive cells, and a stretch
       into pieces wherever the ground under it steps (a kerb, a footway
       edge) or has climbed 0.9 u along a grade. A piece too short for the
       bariyer's 1.40 m chevron board joins its neighbour. The panel stands
       at the middle of its piece's ground; the posts find the ground each. */
    var runs = [];
    var emit = function (E, pieces, g) {
      for (var p = 0; p < pieces.length; p++) {
        var P = pieces[p];
        runs.push({ axis: E.axis, c: E.c, near: E.near, a0: P.a + 0.2, a1: P.b - 0.2, y: (P.lo + P.hi) / 2, g: g });
      }
    };
    for (var key2 in edges) {
      var E = edges[key2], cells = E.cells.sort(function (a, b) { return a - b; });
      var o = E.c + E.near * 0.25;           /* a quarter unit inside the line */
      var g = E.axis === 'z' ? (function (o) { return function (s) { return vis(o, s); }; })(o)
                             : (function (o) { return function (s) { return vis(s, o); }; })(o);
      var j = 0;
      while (j < cells.length) {
        var k = j;
        while (k + 1 < cells.length && cells[k + 1] === cells[k] + 1) k++;
        var S0 = cells[j] * C, S1 = (cells[k] + 1) * C, pieces = [];
        var cur = { a: S0, b: S0, lo: Infinity, hi: -Infinity }, prev = null;
        for (var s = S0 + 0.25; s < S1; s += 0.5) {
          var h = g(s);
          if (prev !== null && (Math.abs(h - prev) > 0.15 || Math.max(cur.hi, h) - Math.min(cur.lo, h) > 0.9)) {
            cur.b = s - 0.25; pieces.push(cur);
            cur = { a: s - 0.25, b: s - 0.25, lo: Infinity, hi: -Infinity };
          }
          cur.lo = Math.min(cur.lo, h); cur.hi = Math.max(cur.hi, h); prev = h;
        }
        cur.b = S1; pieces.push(cur);
        /* short pieces take the height of the longer one they join */
        for (var q = 0; q < pieces.length; q++) {
          var P = pieces[q];
          if (P.b - P.a >= 3.4 || pieces.length < 2) continue;
          var into = q > 0 ? pieces[q - 1] : pieces[q + 1];
          into.a = Math.min(into.a, P.a); into.b = Math.max(into.b, P.b);
          pieces.splice(q, 1); q--;
        }
        /* a long flat line (across a street end) stands as sections of
           about 22 u, each with its own board and posts, the way the
           mission's own police lines are pieced; one panel over 26 u also
           loses its contact shadow to the occluder budget */
        for (q = 0; q < pieces.length; q++) {
          P = pieces[q];
          var len = P.b - P.a, parts = len > 24 ? Math.ceil(len / 22) : 1;
          if (parts < 2) continue;
          var cut = [], step = len / parts;
          for (var m = 0; m < parts; m++) cut.push({ a: P.a + step * m, b: P.a + step * (m + 1), lo: P.lo, hi: P.hi });
          pieces.splice.apply(pieces, [q, 1].concat(cut));
          q += parts - 1;
        }
        emit(E, pieces, g);
        j = k + 1;
      }
    }
    return runs;
  }
  NZ.on('streetSideCordon', function (api) {
    if (!AR || !api || typeof api.barrierRun !== 'function') return;
    var runs = fenceRuns(api), n = 0;
    for (var i = 0; i < runs.length; i++) {
      var R = runs[i];
      try { api.barrierRun(R.a0, R.a1, R.c, R.axis, R.y, R.near, R.g); n++; } catch (err) { netError(err, 'fence'); }
    }
    FENCE.runs = n;
    FENCE.list = runs.map(function (r) { return [r.axis, r.c, +r.a0.toFixed(1), +r.a1.toFixed(1), +r.y.toFixed(2), r.near]; });
  });
  var FENCE = { runs: 0, list: [] };

  function giveLoadout() {
    for (var i = 0; i < player.has.length; i++) player.has[i] = !!LOAD_HAS[i];
    for (var k in player.ammo) {
      if (!Object.prototype.hasOwnProperty.call(player.ammo, k)) continue;
      var cap = (typeof AMMOMAX !== 'undefined' && AMMOMAX[k]) || 999;
      player.ammo[k] = Math.min(cap, LOAD_AMMO[k] || 0);
    }
    if (!player.has[player.weapon]) player.weapon = LOAD_WEAPON;
    player.pending = -1;
    player.medpack = 0;
    if (player.keys) player.keys.red = false;
  }

  function foePositions() {
    var out = [];
    for (var id in PEERS) {
      var pr = PEERS[id], s = pr.snaps[pr.snaps.length - 1];
      if (s && (s.flags & 32) && (s.flags & 1) && nowS() - pr.lastRecv < STALE_AFTER) out.push(s);
    }
    return out;
  }

  function pickSpawn() {
    var pts = SPAWN_PTS.length ? SPAWN_PTS : [{ x: player.x, y: player.y, z: player.z, yaw: player.yaw }];
    var foes = foePositions();
    var scored = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], dmin = 1e9;
      for (var j = 0; j < foes.length; j++) {
        var f = foes[j], dx = p.x - f.x, dz = p.z - f.z, dy = (p.y - f.y) * 2;
        dmin = Math.min(dmin, Math.sqrt(dx * dx + dz * dz + dy * dy));
      }
      scored.push({ i: i, d: foes.length ? dmin : Math.random() });
    }
    scored.sort(function (a, b) { return b.d - a.d; });
    var top = scored.slice(0, Math.min(3, scored.length)).filter(function (s) { return s.i !== ME.lastSpawn; });
    if (!top.length) top = scored.slice(0, 1);
    var pick = top[Math.floor(Math.random() * top.length)].i;
    ME.lastSpawn = pick;
    return pts[pick];
  }

  function respawn(at) {
    var sp = at || pickSpawn();
    player.x = sp.x; player.y = sp.y; player.z = sp.z;
    player.yaw = sp.yaw; player.pitch = -0.04;
    player.vy = 0; player.onGround = true; player.crawling = false; player.crouched = false;
    if (typeof EYE === 'number') player.eyeH = EYE;
    player.hp = 100; player.armor = 0; player.alive = true;
    player.hurtT = 0; player.invT = SPAWN_PROTECT;
    player.kick = 0; player.kickV = 0; player.roll = 0;
    player.recoilPitch = 0; player.recoilYaw = 0; player.recoilPitchV = 0; player.recoilYawV = 0;
    giveLoadout();
    state.ended = false;
    ME.life = (ME.life + 1) & 255;
    ME.respawnAt = 0;
    ME.spawned = true; ME.spec = false; ME.hidden = false;
    try { $('ui').style.opacity = '1'; $('overlay').style.opacity = '1'; } catch (e) { }
    /* the third-person camera and figure must not glide across the jump */
    try { NZ.call('gameRestored'); } catch (e) { }
    sendStateNow();
  }

  function enterMatch() {
    if (ME.inMatch) return;
    ME.inMatch = true;
    /* first spawn with the rifle-class gun in hand; later spawns keep
       whatever the player last chose */
    player.weapon = LOAD_WEAPON; player.pending = -1;
    respawn();
    if (teamMode()) {
      /* Into the level at once; the browser running the match deals the
         round again the moment it hears we are in (often this one, in the
         very next line). */
      broadcastEvent({ t: 'in' });
      message('TAKIM MAÇI');
      subtitle('RAUNT HAZIRLANIYOR…', 2200);
      try { if (isAuth()) authTick(nowS(), 0, true); } catch (err) { netError(err, 'round'); }
      return;
    }
    message('SAVAŞ!');
    var n = peerCount();
    subtitle(n ? 'ÖLÜM MAÇI — ' + (n + 1) + ' OYUNCU' : 'ÖLÜM MAÇI — OYUNCU BEKLENİYOR. BAĞLANTIYI GÖNDER!', 4200);
  }

  /* ------------------------------------------------------- local death -- */
  function localDeath() {
    if (!player.alive) return;
    player.alive = false; player.hp = 0;
    try { mouseDown = false; adsDown = false; altQueued = false; } catch (e) { }
    var k = PENDING_KILLER;
    var team = teamMode();
    /* a team round has no respawns: watch a team-mate until the next one */
    if (team) { ME.respawnAt = 0; ME.spec = true; }
    else ME.respawnAt = nowS() + RESPAWN_DELAY;
    broadcastEvent({ t: 'd', by: k ? k.id : '', w: k ? k.w : -1, hd: k && k.head ? 1 : 0, q: ROUND.q });
    noteDeath(ME.id, k ? k.id : '', k ? k.w : -1, !!(k && k.head), ROUND.q);
    try { sfx('dead'); } catch (e) { }
    var who = k && actorOf(k.id) ? nameOf(k.id) : null;
    if (team) subtitle((who ? 'SENİ İNDİREN: ' + who : 'İNDİRİLDİN') + ' — RAUNT BİTENE KADAR İZLİYORSUN', 4200);
    else subtitle((who ? 'SENİ İNDİREN: ' + who : 'ÖLDÜN') + ' — ' + RESPAWN_DELAY + ' SN SONRA GERİ DÖNÜYORSUN', RESPAWN_DELAY * 1000);
    sendStateNow();
  }

  function nameOf(id) {
    if (id === ME.id) return ME.name;
    if (PEERS[id]) return PEERS[id].name;
    if (BOTS[id]) return BOTS[id].name;
    var r = rosterEntry(id);
    return r && r.name ? r.name : 'BİRİ';
  }

  /* Every browser runs this for every death it hears about, its own included,
     so every scoreboard agrees. */
  function noteDeath(victim, killer, w, head, q) {
    var V = actorOf(victim);
    if (V) V.deaths++;
    var fragger = killer && killer !== victim ? killer : null;
    var K = fragger ? actorOf(fragger) : null;
    if (K) K.frags++;
    /* out for this round -- unless the news is from a round that has since
       been dealt again (q is the round its sender was in) */
    if (teamMode() && (q === undefined || q === ROUND.q)) { var re = rosterEntry(victim); if (re) re.dead = true; }
    try { player.kills = ME.frags; } catch (e) { }
    try {
      if (fragger) killFeed(nameOf(fragger), wepName(w), nameOf(victim), { killerYou: fragger === ME.id, victimYou: victim === ME.id, head: head });
      else killFeed('ARENA', 'TEHLİKE', nameOf(victim), { victimYou: victim === ME.id });
    } catch (e) { }
    if (fragger === ME.id) { try { message('İNDİRDİN: ' + nameOf(victim)); } catch (e) { } }
    hudDirty = true;
  }

  /* ======================================================== hit testing == */
  /* Ray vs capsule (segment a-b, radius r), d unit length. Distance to the
     entry point, or -1. */
  function rayCapsule(ox, oy, oz, dx, dy, dz, c) {
    var bax = c.bx - c.ax, bay = c.by - c.ay, baz = c.bz - c.az;
    var oax = ox - c.ax, oay = oy - c.ay, oaz = oz - c.az;
    var baba = bax * bax + bay * bay + baz * baz;
    var r = c.r;
    if (baba > 1e-10) {
      var bard = bax * dx + bay * dy + baz * dz;
      var baoa = bax * oax + bay * oay + baz * oaz;
      var rdoa = dx * oax + dy * oay + dz * oaz;
      var oaoa = oax * oax + oay * oay + oaz * oaz;
      var a = baba - bard * bard;
      if (a > 1e-10) {
        var b = baba * rdoa - baoa * bard;
        var cc = baba * oaoa - baoa * baoa - r * r * baba;
        var h = b * b - a * cc;
        if (h < 0) return -1;
        var t = (-b - Math.sqrt(h)) / a;
        var y = baoa + t * bard;
        if (y > 0 && y < baba) return t;
        var ex = y <= 0 ? oax : ox - c.bx, ey = y <= 0 ? oay : oy - c.by, ez = y <= 0 ? oaz : oz - c.bz;
        var b2 = dx * ex + dy * ey + dz * ez, c2 = ex * ex + ey * ey + ez * ez - r * r, h2 = b2 * b2 - c2;
        return h2 > 0 ? -b2 - Math.sqrt(h2) : -1;
      }
    }
    /* a sphere, or a ray running down the axis: test both ends as spheres */
    var best = -1;
    for (var e = 0; e < 2; e++) {
      var px = e ? c.bx : c.ax, py = e ? c.by : c.ay, pz = e ? c.bz : c.az;
      var qx = ox - px, qy = oy - py, qz = oz - pz;
      var bq = dx * qx + dy * qy + dz * qz, cq = qx * qx + qy * qy + qz * qz - r * r, hq = bq * bq - cq;
      if (hq > 0) { var tq = -bq - Math.sqrt(hq); if (tq > 0 && (best < 0 || tq < best)) best = tq; }
    }
    return best;
  }

  var PARTS = [], RAY = { t: 0, zone: '' };
  /* One ray (unit dx,dy,dz) against one figure standing at fx,fy,fz, whose
     capsules getParts() returns. True on a hit nearer than maxT, with the
     distance and the zone left in RAY. */
  function rayParts(org, dx, dy, dz, maxT, fx, fy, fz, getParts) {
    /* broad phase: anywhere near the line at all */
    var cx = fx - org.x, cy = fy + 3 - org.y, cz = fz - org.z;
    var along = cx * dx + cy * dy + cz * dz;
    if (along < -6 || along > maxT + 6) return false;
    var ox = cx - dx * along, oy = cy - dy * along, oz = cz - dz * along;
    if (ox * ox + oy * oy + oz * oz > 64) return false;
    var parts = getParts(PARTS), hit = false;
    RAY.t = maxT;
    for (var i = 0; i < parts.length; i++) {
      var t = rayCapsule(org.x, org.y, org.z, dx, dy, dz, parts[i]);
      if (t > 0.3 && t < RAY.t) { RAY.t = t; RAY.zone = parts[i].zone; hit = true; }
    }
    return hit;
  }
  function rayOne(pr, org, dx, dy, dz, maxT, best) {
    var av = pr.av;
    if (!av || !pr.shown || !av.P.alive || !isFoe(pr)) return best;
    if (rayParts(org, dx, dy, dz, best ? best.t : maxT, av.P.x, av.P.y, av.P.z, av.hitParts)) return { peer: pr, t: RAY.t, zone: RAY.zone };
    return best;
  }
  /* the local player's round: the other players and, in a team match, the
     bots -- everyone it is allowed to hurt (isFoe) */
  function rayPeers(org, dir, maxT) {
    var best = null, id;
    var dl = Math.hypot(dir.x, dir.y, dir.z) || 1, dx = dir.x / dl, dy = dir.y / dl, dz = dir.z / dl;
    for (id in PEERS) best = rayOne(PEERS[id], org, dx, dy, dz, maxT, best);
    for (id in BOTS) best = rayOne(BOTS[id], org, dx, dy, dz, maxT, best);
    return best;
  }

  function hitPeer(hit, org, dir, dmg) {
    var pr = hit.peer, zone = hit.zone, d = dmg * (ZONE_MULT[zone] || 1);
    var hp = new THREE.Vector3(org.x + dir.x * hit.t, org.y + dir.y * hit.t, org.z + dir.z * hit.t);
    var lethal = false;
    if (SHOT.active) {
      var acc = SHOT.dmg[pr.id] || (SHOT.dmg[pr.id] = { d: 0, head: false });
      acc.d += d; acc.head = acc.head || zone === 'head';
      lethal = pr.hp <= acc.d;
    } else {
      sendHit(pr, d, zone === 'head', player.weapon);
      lethal = pr.hp <= d;
    }
    try { bloodBurst(hp, zone === 'head' ? 9 : 5); } catch (e) { }
    try { sfx(zone === 'head' ? 'hitheadshot' : 'hitflesh', hp.x, hp.z); } catch (e) { }
    try { lastHitZone = zone === 'head' ? 'head' : ''; registerHit(lethal); } catch (e) { }
    if (pr.av) pr.av.hurt();
  }

  function flushHits(w) {
    for (var id in SHOT.dmg) {
      var pr = PEERS[id] || BOTS[id];
      if (pr) sendHit(pr, SHOT.dmg[id].d, SHOT.dmg[id].head, w);
    }
    SHOT.dmg = {};
  }

  function sendHit(pr, d, head, w) {
    var m = { t: 'h', d: Math.round(d * 10) / 10, hd: head ? 1 : 0, w: w, sx: Math.round(player.x * 100) / 100, sz: Math.round(player.z * 100) / 100 };
    if (pr.bot) {
      /* a bot lives in the browser that runs the match: here, or over there */
      if (isAuth()) botDamage(pr, m.d, ME.id, w, head, player.x, player.z);
      else { m.b = pr.slot; var host = PEERS[ROUND.auth]; if (host) sendEvent(host, m); }
      return;
    }
    sendEvent(pr, m);
  }

  /* a round landed: on us, or on a bot this browser is running */
  function onHit(pr, m) {
    var d = clamp(fin(m.d), 0, 400);
    if (!(d > 0)) return;
    if (typeof m.b === 'number') {
      if (!teamMode() || !isAuth()) return;
      var be = BOTS['#b' + (m.b | 0)];
      if (be) botDamage(be, d, pr.id, fin(m.w, 0) | 0, !!m.hd, fin(m.sx, 0), fin(m.sz, 0));
      return;
    }
    /* the shooter is the sender -- or one of the bots the sender runs */
    var by = pr.id;
    if (typeof m.by === 'string' && BOTS[m.by] && pr.id === ROUND.auth) by = m.by;
    hurtMe(d, by, fin(m.w, 0) | 0, !!m.hd, fin(m.sx, player.x), fin(m.sz, player.z));
  }

  function hurtMe(d, by, w, head, sx, sz) {
    if (!ME.inMatch || !player.alive || player.invT > 0) return;
    if (teamMode() && (ROUND.ph !== 'live' || ME.team < 0 || teamOf(by) < 0 || teamOf(by) === ME.team)) return;
    PENDING_KILLER = { id: by, w: w, head: head };
    var scale = 1;
    try { scale = (D && D.dmg > 0) ? D.dmg : 1; } catch (e) { }
    try { hurtPlayer(d / scale, sx, sz); }
    finally { PENDING_KILLER = null; }
    sendStateNow();
  }

  /* ================================================== remote gunfire == */
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function sendFire(w, rays, org, dmg) {
    var e = [];
    for (var i = 0; i < rays.length; i++) e.push([r3(rays[i][0]), r3(rays[i][1]), r3(rays[i][2]), rays[i][3]]);
    var q = 0;
    try { q = player.suppressed && WPN[w] && WPN[w].canSuppress ? 1 : 0; } catch (x) { }
    var m = { t: 'f', w: w, q: q, e: e };
    if (org) { m.o = [r3(org[0]), r3(org[1]), r3(org[2])]; m.d = Math.round(fin(dmg) * 100) / 100; }
    broadcastEvent(m);
  }

  var _v1 = null;
  function onFire(pr, m) {
    var W = null;
    try { W = WPN[m.w | 0]; } catch (e) { }
    if (!W) return;
    /* the level is not built yet: keep the impacts for when it is */
    if (!READY) { if (LATE.fires.length < 300) LATE.fires.push(m); return; }
    var who = pr;
    if (typeof m.b === 'number') {
      /* a bot's shot, from the browser that runs it. Its impacts count even
         before this page knows that browser runs the match: a pane is a
         pane whoever shot it. */
      who = (teamMode() && pr.id === ROUND.auth) ? (BOTS['#b' + (m.b | 0)] || null) : null;
    }
    if (who) { who.firedAt = nowS(); drawFire(who, m); }
    fireImpacts(m, who);
  }
  /* what a shot looks and sounds like from outside: the figure kicks, the
     report, tracers to where the rounds went, blood where one hit a body
     (a wall's puff comes with its impact, below) */
  function drawFire(pr, m) {
    var av = pr.av;
    if (!av || !pr.shown) return;
    var W = null;
    try { W = WPN[m.w | 0]; } catch (e) { }
    if (!W) return;
    av.shot();
    try { sfx(m.q ? 'rifleq' : W.snd, av.P.x, av.P.z); } catch (e) { }
    if (!_v1) _v1 = new THREE.Vector3();
    var mz = av.muzzle();
    var ox = mz ? mz.x : av.P.x, oy = mz ? mz.y : av.P.y + av.P.eyeH - 0.3, oz = mz ? mz.z : av.P.z;
    var ends = Array.isArray(m.e) ? m.e : [];
    for (var i = 0; i < ends.length && i < 12; i++) {
      var e2 = ends[i];
      if (!Array.isArray(e2) || e2.length < 3) continue;
      var ex = fin(e2[0]), ey = fin(e2[1]), ez = fin(e2[2]);
      if (i < 4) { try { tracer(ox, oy, oz, ex, ey, ez, 1.0, 0.78, 0.42, 0.06); } catch (e) { } }
      if (e2[3] === 1) { try { _v1.set(ex, ey, ez); bloodBurst(_v1.clone(), 4); } catch (e) { } }
    }
  }
  /* every round of a shot that ended on a wall (flag 0; 1 is a body, 2 ran
     out of range), from the shooter's own origin when the shot carries it */
  function fireImpacts(m, who) {
    var o = Array.isArray(m.o) && m.o.length === 3 ? m.o : null;
    if (!o && who && who.av && who.shown) {
      var mz = who.av.muzzle();
      if (mz) o = [mz.x, mz.y, mz.z];
    }
    if (!o) return;
    var W = null;
    try { W = WPN[m.w | 0]; } catch (e) { }
    var dmg = fin(m.d, (W && W.dmg) || 12);
    var ends = Array.isArray(m.e) ? m.e : [];
    for (var i = 0; i < ends.length && i < 12; i++) {
      var e2 = ends[i];
      if (Array.isArray(e2) && e2.length >= 3 && !e2[3]) replayImpact(o, fin(e2[0]), fin(e2[1]), fin(e2[2]), dmg);
    }
  }

  /* A round that hit a wall on the shooter's screen hits it here too, through
     the same surfaceHit hook, with the same origin, direction and damage: a
     crate loses the same hit points, a pane cracks the same cells, a car
     window breaks on the same round. What nobody owns falls back to the
     stock puff, decal and sound, exactly like hitscan(). */
  function replayImpact(from, ex, ey, ez, dmg) {
    try {
      var hit = new THREE.Vector3(ex, ey, ez);
      var org = new THREE.Vector3(fin(from[0]), fin(from[1]), fin(from[2]));
      var dir = hit.clone().sub(org), t = dir.length();
      if (!(t > 0.01)) return;
      dir.multiplyScalar(1 / t);
      var surface = impactSurface(hit, dir);
      var owned = false;
      try { owned = NZ.first('surfaceHit', hit, dir, surface, { org: org, dmg: dmg, bestT: t, remote: true }) === true; }
      catch (e) { owned = false; }
      if (!owned) {
        impactPuff(hit, dir, surface.kind); impactDecal(hit, dir, surface);
        sfx('impact_' + surface.kind, hit.x, hit.z);
      }
      ME.replayed++;
    } catch (err) { netError(err, 'impact'); }
  }

  /* ===================================================== late arrivals == */
  /* Someone who opens the link mid-match has a pristine city. When a direct
     link opens, each side sends what it has broken; each side keeps the
     worse of the two, pane by pane and crate by crate, so both end up with
     the union. Car windows have no snapshot of their own: they are hit until
     they reach the stage the sender has. */
  function damageSnapshot() {
    var Dm = NZ.destruct;
    if (!READY || !Dm || !Dm.ok || typeof Dm.snapshot !== 'function') return null;
    var s = Dm.snapshot(), out = { t: 'ds', b: s.broken || [], c: [], g: [], cg: [] };
    /* every live crate: a few dozen short rows, and the receiver keeps the
       lower hit points of the two */
    for (var i = 0; i < (s.crates || []).length; i++) {
      var c = s.crates[i];
      out.c.push([c.cx, c.cy, Math.round(c.hp * 10) / 10, c.bruised ? 1 : 0]);
    }
    for (var j = 0; j < (s.glass || []).length; j++) {
      var g = s.glass[j];
      if (g.stage > 0) out.g.push([j, g.id, g.stage, r3(g.energy), (g.impacts || []).map(function (im) { return [r3(im.u), r3(im.v)]; }), g.removed || []]);
    }
    try {
      if (Dm.carGlass && Dm.carGlass.states) {
        var cs = Dm.carGlass.states();
        for (var k = 0; k < cs.length; k++) if (cs[k] && (cs[k].stage > 0 || cs[k].broken)) out.cg.push([k, cs[k].stage, cs[k].broken ? 1 : 0]);
      }
    } catch (e) { }
    var str = JSON.stringify(out);
    if (str.length > 240000) {           /* a whole facade shot out: send the stages only */
      for (var q = 0; q < out.g.length; q++) out.g[q][5] = [];
      str = JSON.stringify(out);
    }
    return str.length > 240000 ? null : str;
  }
  function sendDamage(pr) {
    try {
      var s = damageSnapshot();
      if (s && pr.chE && pr.chE.readyState === 'open') pr.chE.send(s);
    } catch (err) { netError(err, 'snapshot'); }
  }

  function onDamage(m) {
    if (!READY) { LATE.snap = LATE.snap ? LATE.snap.concat([m]) : [m]; return; }
    var Dm = NZ.destruct;
    if (!Dm || !Dm.ok || typeof Dm.snapshot !== 'function' || typeof Dm.restore !== 'function') return;
    try {
      var s = Dm.snapshot(), changed = false, i;
      var brokenKey = {};
      for (i = 0; i < s.broken.length; i++) brokenKey[s.broken[i][0] + ',' + s.broken[i][1]] = 1;
      var crateAt = {};
      for (i = 0; i < s.crates.length; i++) crateAt[s.crates[i].cx + ',' + s.crates[i].cy] = s.crates[i];
      /* crates: broken anywhere is broken; otherwise the lower hit points */
      var b = Array.isArray(m.b) ? m.b : [];
      for (i = 0; i < b.length; i++) {
        if (!Array.isArray(b[i])) continue;
        var bk = (b[i][0] | 0) + ',' + (b[i][1] | 0);
        if (brokenKey[bk] || !crateAt[bk]) continue;
        brokenKey[bk] = 1; s.broken.push([b[i][0] | 0, b[i][1] | 0]); delete crateAt[bk]; changed = true;
      }
      s.crates = s.crates.filter(function (c) { return !!crateAt[c.cx + ',' + c.cy]; });
      var cr = Array.isArray(m.c) ? m.c : [];
      for (i = 0; i < cr.length; i++) {
        var row = cr[i]; if (!Array.isArray(row)) continue;
        var rec = crateAt[(row[0] | 0) + ',' + (row[1] | 0)];
        if (!rec) continue;
        var hp = fin(row[2], rec.hp);
        if (hp < rec.hp) { rec.hp = Math.max(1, hp); changed = true; }
        if (row[3] && !rec.bruised) { rec.bruised = true; changed = true; }
      }
      /* panes: the further-gone pane wins whole */
      var gl = Array.isArray(m.g) ? m.g : [];
      for (i = 0; i < gl.length; i++) {
        var G = gl[i]; if (!Array.isArray(G) || G.length < 6) continue;
        var mine = s.glass[G[0] | 0];
        if (!mine || mine.id !== G[1] || !(G[2] > mine.stage)) continue;
        s.glass[G[0] | 0] = {
          id: mine.id, stage: G[2] | 0, energy: fin(G[3]),
          impacts: (Array.isArray(G[4]) ? G[4] : []).map(function (p) { return { u: fin(p[0]), v: fin(p[1]) }; }),
          removed: Array.isArray(G[5]) ? G[5].filter(function (n) { return Number.isInteger(n); }) : []
        };
        changed = true;
      }
      if (changed && !Dm.restore(s)) warn('damage snapshot refused');
      /* car windows: hit them until they are as far gone as the sender's */
      var cg = Array.isArray(m.cg) ? m.cg : [];
      if (cg.length && Dm.carGlass && Dm.carGlass.state && Dm.carGlass.damage) {
        for (i = 0; i < cg.length; i++) {
          var C2 = cg[i]; if (!Array.isArray(C2)) continue;
          for (var n = 0; n < 12; n++) {
            var st = Dm.carGlass.state(C2[0] | 0);
            if (!st || st.broken || (!C2[2] && st.stage >= C2[1])) break;
            Dm.carGlass.damage(C2[0] | 0, 1, 16);
          }
        }
      }
      ME.snapsIn++;
    } catch (err) { netError(err, 'snapshot-in'); }
  }

  /* the level is up: what arrived while it loaded */
  function drainLate() {
    var snaps = LATE.snap; LATE.snap = null;
    if (snaps) for (var i = 0; i < snaps.length; i++) onDamage(snaps[i]);
    var f = LATE.fires; LATE.fires = [];
    for (var j = 0; j < f.length; j++) fireImpacts(f[j], null);
  }

  /* ============================================================ avatars == */
  /* The real figure from nz-hero.js, or a plain capsule if that module is
     unavailable. Both offer the same small surface. */
  function makeAvatar(pr) {
    var col = avatarColor(pr);
    try {
      if (NZ.hero && NZ.hero.puppet && NZ.hero.puppet.ready) {
        var h = NZ.hero.puppet.create({ color: col });
        if (h) return h;
      }
    } catch (err) { netError(err, 'puppet'); }
    return makeStandIn(col);
  }

  function makeStandIn(col) {
    var scene = NZ.ctx.scene, MU = (typeof M === 'number') ? M : 3.5;
    var mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(col), roughness: 0.7, metalness: 0.05 });
    var skin = new THREE.MeshStandardMaterial({ color: 0xc08c68, roughness: 0.8 });
    var root = new THREE.Group();
    var body = new THREE.Mesh(new THREE.CylinderGeometry(0.17 * MU, 0.15 * MU, 1.0 * MU, 12), mat);
    var legs = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * MU, 0.11 * MU, 0.85 * MU, 10), new THREE.MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.8 }));
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.115 * MU, 14, 10), skin);
    var gun = new THREE.Mesh(new THREE.BoxGeometry(0.05 * MU, 0.07 * MU, 0.6 * MU), new THREE.MeshStandardMaterial({ color: 0x1b1c1e, metalness: 0.6, roughness: 0.5 }));
    root.add(body); root.add(legs); root.add(head); root.add(gun);
    [body, legs, head, gun].forEach(function (m) { m.castShadow = true; });
    root.visible = false;
    scene.add(root);
    var P = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, eyeH: (typeof EYE === 'number' ? EYE : 6), alive: true, crouched: false, crawling: false, weapon: 0, hurtT: 0, ammo: {} };
    var muz = new THREE.Vector3(), parts = [];
    var api = {
      P: P,
      setVisible: function (v) { root.visible = !!v; },
      shot: function () { }, hurt: function () { }, teleported: function () { },
      muzzle: function () { return muz; },
      hitParts: function (out) {
        out = out || parts; out.length = 0;
        if (!root.visible) return out;
        var h = P.eyeH / MU, top = P.y + (h + 0.11) * MU;
        if (!P.alive) return out;
        out.push({ zone: 'head', r: 0.115 * MU, ax: P.x, ay: top - 0.11 * MU, az: P.z, bx: P.x, by: top - 0.11 * MU, bz: P.z });
        out.push({ zone: 'body', r: 0.18 * MU, ax: P.x, ay: P.y + h * 0.52 * MU, az: P.z, bx: P.x, by: top - 0.30 * MU, bz: P.z });
        out.push({ zone: 'limb', r: 0.15 * MU, ax: P.x, ay: P.y + 0.15 * MU, az: P.z, bx: P.x, by: P.y + h * 0.50 * MU, bz: P.z });
        return out;
      },
      update: function () {
        var h = P.eyeH / MU;
        root.position.set(P.x, P.y, P.z);
        root.rotation.set(P.alive ? 0 : Math.PI / 2, P.yaw, 0, 'YXZ');
        legs.position.set(0, h * 0.25 * MU, 0); legs.scale.y = h / 1.71;
        body.position.set(0, h * 0.72 * MU, 0); body.scale.y = h / 1.71;
        head.position.set(0, (h + 0.02) * MU, 0);
        gun.position.set(0.18 * MU, (h - 0.25) * MU, -0.35 * MU);
        gun.rotation.set(P.pitch, 0, 0);
        root.updateMatrixWorld(true);
        muz.set(0.18 * MU, (h - 0.25) * MU, -0.65 * MU).applyMatrix4(root.matrixWorld);
      },
      dispose: function () {
        scene.remove(root);
        root.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      }
    };
    return api;
  }

  /* ============================================================ peers == */
  function peerCount() { var n = 0; for (var id in PEERS) if (PEERS[id].open) n++; return n; }

  function addPeer(id, name, color, offerer) {
    var pr = PEERS[id];
    if (pr) { if (name) pr.name = name; if (color !== undefined) pr.color = color; return pr; }
    pr = PEERS[id] = {
      id: id, name: name || 'OYUNCU', color: color | 0, offerer: !!offerer,
      pc: null, chS: null, chE: null, cands: [], open: false, conn: 'new', route: '', retries: 0, retryT: 0,
      snaps: [], offs: [], offset: null, late: 0.004, gap: 1 / 60, lastT: 0, lastRecv: 0, rtt: 0,
      frags: 0, deaths: 0, hp: 100, av: null, shown: false, life: -1, saidHi: false, joinedAt: nowS(),
      team: -1, want: -1, inMatch: false, j: null, avKey: null, firedAt: -9, vx: 0, vz: 0
    };
    hudDirty = true;
    return pr;
  }

  function closePC(pr) {
    try { if (pr.chS) pr.chS.close(); } catch (e) { }
    try { if (pr.chE) pr.chE.close(); } catch (e) { }
    try { if (pr.pc) pr.pc.close(); } catch (e) { }
    pr.pc = pr.chS = pr.chE = null; pr.open = false; pr.cands = [];
  }

  function removePeer(id, why) {
    var pr = PEERS[id];
    if (!pr) return;
    closePC(pr);
    if (pr.av) { try { pr.av.dispose(); } catch (e) { } pr.av = null; }
    delete PEERS[id];
    /* gone is as good as down for the rest of this round */
    var re = rosterEntry(id);
    if (re) { re.dead = true; re.name = pr.name; }
    if (pr.saidHi) { try { message(pr.name + ' AYRILDI'); } catch (e) { } }
    hudDirty = true;
    refreshLobby();
  }

  /* ---------------------------------------------------------- WebRTC -- */
  function makePC(pr) {
    closePC(pr);
    var pc = new RTCPeerConnection({ iceServers: ICE });
    pr.pc = pc;
    pr.chS = pc.createDataChannel('s', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    pr.chE = pc.createDataChannel('e', { negotiated: true, id: 1, ordered: true });
    pr.chS.binaryType = 'arraybuffer';
    pr.chS.onmessage = function (ev) { try { onFast(pr, ev.data); } catch (err) { netError(err, 'state'); } };
    pr.chE.onmessage = function (ev) { try { onEventMsg(pr, ev.data); } catch (err) { netError(err, 'event'); } };
    pr.chE.onopen = function () { if (pr.pc === pc) onPeerOpen(pr); };
    pr.chE.onclose = function () {
      if (pr.pc !== pc) return;
      pr.open = false; hudDirty = true;
      if (pr.sigGone) removePeer(pr.id);
    };
    pc.onicecandidate = function (ev) {
      if (ev.candidate && pr.pc === pc) sigSend({ t: 'signal', to: pr.id, data: { cand: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate } });
    };
    pc.onconnectionstatechange = function () {
      if (pr.pc !== pc) return;
      pr.conn = pc.connectionState;
      hudDirty = true;
      if (pr.conn === 'connected') detectRoute(pr);
      if (pr.conn === 'failed') onPcFailed(pr);
    };
    return pc;
  }

  function startOffer(pr) {
    var pc = makePC(pr);
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () {
      if (pr.pc !== pc) return;
      sigSend({ t: 'signal', to: pr.id, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
    }).catch(function (err) { netError(err, 'offer'); });
  }

  function flushCands(pr) {
    var c = pr.cands; pr.cands = [];
    for (var i = 0; i < c.length; i++) pr.pc.addIceCandidate(c[i]).catch(function () { });
  }

  function onSignalData(from, data) {
    if (!data || typeof data !== 'object') return;
    var pr = PEERS[from] || addPeer(from, '', 0, false);
    if (data.sdp && data.sdp.type === 'offer') {
      /* a new offer replaces whatever we had with that player */
      var pc = makePC(pr);
      pc.setRemoteDescription(data.sdp).then(function () {
        if (pr.pc !== pc) return;
        flushCands(pr);
        return pc.createAnswer();
      }).then(function (a) { if (a && pr.pc === pc) return pc.setLocalDescription(a); }).then(function () {
        if (pr.pc !== pc || !pc.localDescription) return;
        sigSend({ t: 'signal', to: from, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
      }).catch(function (err) { netError(err, 'answer'); });
    } else if (data.sdp && data.sdp.type === 'answer') {
      if (!pr.pc) return;
      var pc2 = pr.pc;
      pc2.setRemoteDescription(data.sdp).then(function () { if (pr.pc === pc2) flushCands(pr); }).catch(function (err) { netError(err, 'answer-in'); });
    } else if (data.cand) {
      if (pr.pc && pr.pc.remoteDescription) pr.pc.addIceCandidate(data.cand).catch(function () { });
      else pr.cands.push(data.cand);
    }
  }

  function onPcFailed(pr) {
    pr.open = false;
    /* the side that offered tries again, a few times */
    if (pr.offerer && pr.retries < 3) {
      pr.retries++;
      pr.retryT = nowS() + 1.5 * pr.retries;
    }
    hudDirty = true;
    refreshLobby();
  }

  function detectRoute(pr) {
    var pc = pr.pc;
    if (!pc || !pc.getStats) return;
    pc.getStats().then(function (stats) {
      var pairId = null, local = {}, remote = {}, pairs = {};
      stats.forEach(function (r) {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'candidate-pair') pairs[r.id] = r;
        if (r.type === 'local-candidate') local[r.id] = r;
        if (r.type === 'remote-candidate') remote[r.id] = r;
      });
      var pair = pairId ? pairs[pairId] : null;
      if (!pair) for (var k in pairs) if (pairs[k].state === 'succeeded' && (pairs[k].nominated || pairs[k].selected)) { pair = pairs[k]; break; }
      if (!pair) return;
      var lc = local[pair.localCandidateId], rc = remote[pair.remoteCandidateId];
      var relayed = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay');
      pr.route = relayed ? 'relay' : 'direct';
      hudDirty = true; refreshLobby();
    }).catch(function () { });
  }

  function onPeerOpen(pr) {
    pr.open = true;
    pr.retries = 0;
    sendEvent(pr, { t: 'hi', name: ME.name, color: ME.color, frags: ME.frags, deaths: ME.deaths, proto: PROTO, j: ME.j, tw: ME.want, in: ME.inMatch ? 1 : 0 });
    /* what is already broken here; a page still loading has nothing to say */
    sendDamage(pr);
    hudDirty = true;
    refreshLobby();
  }

  /* ------------------------------------------------------- messages -- */
  function sendEvent(pr, obj) {
    if (!pr.chE || pr.chE.readyState !== 'open') return;
    try { pr.chE.send(JSON.stringify(obj)); } catch (e) { }
  }
  function broadcastEvent(obj) {
    var s = JSON.stringify(obj);
    for (var id in PEERS) {
      var pr = PEERS[id];
      if (pr.chE && pr.chE.readyState === 'open') { try { pr.chE.send(s); } catch (e) { } }
    }
  }
  function broadcastState(data) {
    for (var id in PEERS) {
      var c = PEERS[id].chS;
      if (c && c.readyState === 'open' && c.bufferedAmount < 65536) { try { c.send(data); } catch (e) { } }
    }
  }

  function onEventMsg(pr, data) {
    if (typeof data !== 'string' || data.length > 262144) return;
    /* only the damage snapshot is ever big */
    if (data.length > 8192 && data.lastIndexOf('{"t":"ds"', 0) !== 0) return;
    var m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'f') { onFire(pr, m); return; }
    if (m.t === 'ds') { onDamage(m); return; }
    if (m.t === 'hi') {
      var first = !pr.saidHi;
      pr.saidHi = true;
      if (typeof m.name === 'string') pr.name = cleanName(m.name) || pr.name;
      if (typeof m.color === 'number') pr.color = m.color | 0;
      pr.frags = Math.max(0, fin(m.frags) | 0); pr.deaths = Math.max(0, fin(m.deaths) | 0);
      if (typeof m.j === 'number' && isFinite(m.j)) pr.j = m.j;
      if (m.tw === 0 || m.tw === 1 || m.tw === -1) pr.want = m.tw;
      pr.inMatch = !!m.in;
      if (first) { try { message(pr.name + ' KATILDI'); } catch (e) { } }
      hudDirty = true; refreshLobby();
      /* tell a newcomer where the round stands */
      if (teamMode() && isAuth() && ROUND.ph !== 'wait') sendEvent(pr, roundMsg());
    } else if (m.t === 'h') onHit(pr, m);
    else if (m.t === 'd') {
      /* the sender went down -- or, from the browser running the match, a bot did */
      var victim = pr.id;
      if (typeof m.v === 'string') {
        if (!BOTS[m.v] || pr.id !== ROUND.auth) return;
        victim = m.v;
      }
      noteDeath(victim, typeof m.by === 'string' ? m.by : '', fin(m.w, -1), !!m.hd, typeof m.q === 'number' ? m.q : undefined);
    }
    else if (m.t === 'n') { pr.name = cleanName(m.name) || pr.name; hudDirty = true; refreshLobby(); }
    else if (m.t === 'in') { pr.inMatch = true; hudDirty = true; refreshLobby(); }
    else if (m.t === 't') { if (m.w === 0 || m.w === 1 || m.w === -1) pr.want = m.w; refreshLobby(); }
    else if (m.t === 'r') onRound(pr, m);
  }

  /* binary state and pings ride the fast channel (and gunfire JSON from an
     older page, if one ever sends it there) */
  var SBUF = new ArrayBuffer(48), SDV = new DataView(SBUF);
  var PBUF = new ArrayBuffer(12), PDV = new DataView(PBUF);

  function onFast(pr, data) {
    if (typeof data === 'string') {
      if (data.length > 4096) return;
      var m; try { m = JSON.parse(data); } catch (e) { return; }
      if (m && m.t === 'f') onFire(pr, m);
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength < 12) return;
    var dv = new DataView(data), type = dv.getUint8(0);
    if (type === 2) {                         /* ping: echo it */
      var out = data.slice(0, 12); new DataView(out).setUint8(0, 3);
      if (pr.chS && pr.chS.readyState === 'open') { try { pr.chS.send(out); } catch (e) { } }
      return;
    }
    if (type === 3) {                         /* pong */
      var rtt = nowS() - dv.getFloat64(4, true);
      if (rtt >= 0 && rtt < 5) pr.rtt = pr.rtt ? pr.rtt * 0.75 + rtt * 0.25 : rtt;
      return;
    }
    if ((type !== 1 && type !== 4) || data.byteLength < 48) return;
    if (type === 4) {
      /* one of the bots, from the browser that runs the match: filed under
         the bot, and timed against that browser's clock like its own */
      if (!teamMode() || pr.id !== ROUND.auth) return;
      pr = BOTS['#b' + dv.getUint8(46)];
      if (!pr) return;
    }
    var s = {
      flags: dv.getUint8(1), w: dv.getUint8(2), life: dv.getUint8(3), t: dv.getFloat64(4, true),
      x: dv.getFloat32(12, true), y: dv.getFloat32(16, true), z: dv.getFloat32(20, true),
      yaw: dv.getFloat32(24, true), pitch: dv.getFloat32(28, true), eyeH: dv.getFloat32(32, true),
      vy: dv.getFloat32(36, true), dash: dv.getUint8(40) / 255, ads: dv.getUint8(41) / 255,
      hp: dv.getUint8(42), armor: dv.getUint8(43)
    };
    if (!isFinite(s.t) || !isFinite(s.x) || !isFinite(s.y) || !isFinite(s.z) || !isFinite(s.yaw) || !isFinite(s.pitch)) return;
    if (Math.abs(s.x) > 1e5 || Math.abs(s.y) > 1e5 || Math.abs(s.z) > 1e5) return;
    var S = pr.snaps;
    if (S.length && s.t <= S[S.length - 1].t) return;      /* late duplicate: drop */
    var tr = nowS();
    /* receive time minus send time = clock offset + this packet's delay. The
       smallest over the last few seconds is the offset plus the fastest
       delay; how much later than that a packet arrives is the jitter the
       buffer has to cover. */
    var sample = tr - s.t;
    pr.offs.push(sample, tr);
    while (pr.offs.length > 2 && tr - pr.offs[1] > 3) pr.offs.splice(0, 2);
    var mn = Infinity;
    for (var i = 0; i < pr.offs.length; i += 2) if (pr.offs[i] < mn) mn = pr.offs[i];
    pr.offset = mn;
    pr.late = pr.late * 0.94 + Math.max(0, sample - mn) * 0.06;
    if (pr.lastT) pr.gap = pr.gap * 0.9 + clamp(s.t - pr.lastT, 0.004, 0.25) * 0.1;
    pr.lastT = s.t;
    S.push(s);
    if (S.length > 48) S.splice(0, S.length - 48);
    pr.lastRecv = tr;
    pr.hp = s.hp;
  }

  function encodeState() {
    var f = 0;
    if (player.alive) f |= 1;
    if (player.onGround) f |= 2;
    if (player.crouched) f |= 4;
    if (player.crawling) f |= 8;
    if (player.suppressed) f |= 16;
    if (ME.inMatch && ME.spawned && !ME.hidden) f |= 32;
    SDV.setUint8(0, 1);
    SDV.setUint8(1, f);
    SDV.setUint8(2, clamp(player.weapon | 0, 0, 255));
    SDV.setUint8(3, ME.life & 255);
    SDV.setFloat64(4, nowS(), true);
    SDV.setFloat32(12, player.x, true);
    SDV.setFloat32(16, player.y, true);
    SDV.setFloat32(20, player.z, true);
    SDV.setFloat32(24, player.yaw, true);
    SDV.setFloat32(28, player.pitch, true);
    SDV.setFloat32(32, fin(player.eyeH, typeof EYE === 'number' ? EYE : 6), true);
    SDV.setFloat32(36, fin(player.vy), true);
    SDV.setUint8(40, Math.round(clamp(fin(player.dash), 0, 1) * 255));
    SDV.setUint8(41, Math.round(clamp(fin(player.ads), 0, 1) * 255));
    SDV.setUint8(42, clamp(Math.round(fin(player.hp)), 0, 255));
    SDV.setUint8(43, clamp(Math.round(fin(player.armor)), 0, 255));
    SDV.setUint16(44, ME.seq++ & 65535, true);
    return SBUF;
  }
  function sendStateNow() { ME.sendT = nowS(); broadcastState(encodeState()); }

  /* a bot goes out in the same 48 bytes as a player: type 4, its seat in byte 46 */
  var BBUF = new ArrayBuffer(48), BDV = new DataView(BBUF);
  function encodeBot(sim) {
    var f = 32;
    if (sim.alive) f |= 1;
    if (sim.onGround) f |= 2;
    BDV.setUint8(0, 4);
    BDV.setUint8(1, f);
    BDV.setUint8(2, clamp(sim.weapon | 0, 0, 255));
    BDV.setUint8(3, sim.life & 255);
    BDV.setFloat64(4, nowS(), true);
    BDV.setFloat32(12, sim.x, true);
    BDV.setFloat32(16, sim.y, true);
    BDV.setFloat32(20, sim.z, true);
    BDV.setFloat32(24, sim.yaw, true);
    BDV.setFloat32(28, sim.pitch, true);
    BDV.setFloat32(32, fin(sim.eyeH, 6), true);
    BDV.setFloat32(36, fin(sim.vy), true);
    BDV.setUint8(40, Math.round(clamp(fin(sim.dash), 0, 1) * 255));
    BDV.setUint8(41, Math.round(clamp(fin(sim.ads), 0, 1) * 255));
    BDV.setUint8(42, clamp(Math.round(fin(sim.hp)), 0, 255));
    BDV.setUint8(43, 0);
    BDV.setUint16(44, 0, true);
    BDV.setUint8(46, sim.slot & 255);
    return BBUF;
  }

  function pingAll() {
    PDV.setUint8(0, 2); PDV.setFloat64(4, nowS(), true);
    broadcastState(PBUF);
  }

  /* --------------------------------------------------- interpolation -- */
  var SMP = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, eyeH: 0, vy: 0, dash: 0, ads: 0, flags: 0, w: 0, life: 0 };
  function sampleAt(pr, tNow) {
    var S = pr.snaps;
    if (!S.length || pr.offset === null) return null;
    var buf = clamp(pr.late * 2.2 + pr.gap * 1.25 + 0.004, 0.022, 0.18);
    var tr = tNow - pr.offset - buf;
    var i = S.length - 1;
    while (i > 0 && S[i].t > tr) i--;
    var a = S[i], b = S[i + 1], o = SMP;
    o.flags = a.flags; o.w = a.w; o.life = a.life; o.dash = a.dash; o.ads = a.ads; o.eyeH = a.eyeH; o.vy = a.vy;
    if (tr <= a.t || !b) {
      o.x = a.x; o.y = a.y; o.z = a.z; o.yaw = a.yaw; o.pitch = a.pitch;
      /* late: carry on along the last velocity for at most 100 ms */
      var p0 = S[i - 1];
      if (!b && tr > a.t && p0 && p0.life === a.life && (a.flags & 1)) {
        var span = a.t - p0.t, ex = Math.min(tr - a.t, 0.1);
        if (span > 1e-3 && span < 0.25) {
          o.x += (a.x - p0.x) / span * ex; o.z += (a.z - p0.z) / span * ex;
          if (!(a.flags & 2)) o.y += (a.y - p0.y) / span * ex;
        }
      }
    } else if (b.life !== a.life) {
      o.x = a.x; o.y = a.y; o.z = a.z; o.yaw = a.yaw; o.pitch = a.pitch;     /* a respawn: no glide */
    } else {
      var k = clamp((tr - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
      o.x = lerp(a.x, b.x, k); o.y = lerp(a.y, b.y, k); o.z = lerp(a.z, b.z, k);
      o.yaw = a.yaw + angWrap(b.yaw - a.yaw) * k; o.pitch = lerp(a.pitch, b.pitch, k);
      o.eyeH = lerp(a.eyeH, b.eyeH, k); o.dash = lerp(a.dash, b.dash, k); o.ads = lerp(a.ads, b.ads, k);
      if (k > 0.5) { o.flags = b.flags; o.w = b.w; }
    }
    /* keep a little history behind the render point, no more */
    while (S.length > 3 && S[1].t < tr - 0.5) S.shift();
    return o;
  }

  function updateAvatar(pr, dt, tNow) {
    var fresh = tNow - pr.lastRecv < STALE_AFTER;
    var s = fresh ? sampleAt(pr, tNow) : null;
    /* a bot arrives over the link to the browser that runs it */
    var link = pr.bot ? !!(PEERS[ROUND.auth] && PEERS[ROUND.auth].open) : pr.open;
    /* in a team match a figure wears its side's colour, so it waits for a side */
    var want = !!(s && (s.flags & 32) && link && (!teamMode() || pr.team >= 0));
    if (pr.av && pr.avKey !== avatarKey(pr)) { try { pr.av.dispose(); } catch (e) { } pr.av = null; pr.shown = false; }
    if (want && !pr.av && READY) { pr.av = makeAvatar(pr); pr.avKey = avatarKey(pr); }
    if (!pr.av) return;
    if (!want) { if (pr.shown) { pr.av.setVisible(false); pr.shown = false; } return; }
    driveAvatar(pr, s, dt);
  }

  /* Put a figure where a state sample says it is: a network sample for a
     player or a far-away bot, the brain's own numbers for a bot run here. */
  function driveAvatar(pr, s, dt) {
    var P = pr.av.P;
    if (pr.life !== s.life || !pr.shown) { pr.life = s.life; pr.av.teleported(); pr.vx = 0; pr.vz = 0; }
    else if (dt > 1e-4) {
      /* how fast it is moving, for a bot's aim */
      var kv = Math.min(1, dt * 8);
      pr.vx += (clamp((s.x - P.x) / dt, -40, 40) - pr.vx) * kv;
      pr.vz += (clamp((s.z - P.z) / dt, -40, 40) - pr.vz) * kv;
    }
    P.x = s.x; P.y = s.y; P.z = s.z; P.yaw = s.yaw; P.pitch = s.pitch;
    P.eyeH = s.eyeH; P.vy = s.vy; P.dash = s.dash; P.ads = s.ads;
    var f = s.flags;
    P.alive = !!(f & 1); P.onGround = !!(f & 2); P.crouched = !!(f & 4); P.crawling = !!(f & 8); P.suppressed = !!(f & 16);
    if (P.weapon !== s.w) { P.weapon = s.w; P.raiseDur = 0.26; P.raiseT = 0.26; }
    else if (P.raiseT > 0) P.raiseT = Math.max(0, P.raiseT - dt);
    P.hurtT = Math.max(0, fin(P.hurtT) - dt);
    if (!pr.shown) { pr.av.setVisible(true); pr.shown = true; }
    if (pr.av.update) pr.av.update(dt);
  }

  /* ============================================================== teams == */
  function rosterEntry(id) {
    var ro = ROUND.ro;
    for (var i = 0; i < ro.length; i++) if (ro[i].id === id) return ro[i];
    return null;
  }
  function teamOf(id) { var r = rosterEntry(id); return r ? r.team : -1; }
  function actorOf(id) { return id === ME.id ? ME : (PEERS[id] || BOTS[id] || null); }
  function eachOther(fn) { var id; for (id in PEERS) fn(PEERS[id]); for (id in BOTS) fn(BOTS[id]); }
  /* may a round of mine hurt this one? In a team match, only the other side. */
  function isFoe(e) {
    if (!teamMode()) return true;
    return ME.team >= 0 && e.team >= 0 && e.team !== ME.team;
  }
  function avatarColor(e) {
    if (!teamMode()) return COLORS[e.color % COLORS.length];
    return e.team >= 0 ? TEAMS[e.team].color : '#9a9a9a';
  }
  /* a figure is rebuilt when this changes (its jacket is its side) */
  function avatarKey(e) { return teamMode() ? e.team : -2; }

  /* ------------------------------------------------ who runs the match -- */
  /* Of the browsers that have joined the match, the one that came into the
     room first. Every browser works this out the same way from what the
     others told it ('hi' carries j, 'in' says joined), so it needs no vote
     and survives the server going away. */
  function authId() {
    if (!teamMode()) return null;
    var best = null, bj = 0, id;
    if (ME.inMatch) { best = ME.id; bj = ME.j || 9e15; }
    for (id in PEERS) {
      var pr = PEERS[id];
      if (!pr.open || !pr.inMatch) continue;
      var j = pr.j === null ? 9e15 : pr.j;
      if (best === null || j < bj || (j === bj && id < best)) { best = id; bj = j; }
    }
    return best;
  }
  function isAuth() { return ME.inMatch && authId() === ME.id; }

  /* ----------------------------------------------------- bots as actors -- */
  function botEntry(slot) {
    var id = '#b' + slot, e = BOTS[id];
    if (e) return e;
    e = BOTS[id] = {
      id: id, bot: true, slot: slot, name: BOT_NAMES[slot % BOT_NAMES.length], color: slot, team: -1, open: true,
      snaps: [], offs: [], offset: null, late: 0.004, gap: 1 / 60, lastT: 0, lastRecv: 0, rtt: 0,
      frags: 0, deaths: 0, hp: 100, av: null, shown: false, life: -1, avKey: null, firedAt: -9, vx: 0, vz: 0
    };
    hudDirty = true;
    return e;
  }
  function dropBot(id) {
    var e = BOTS[id];
    if (!e) return;
    if (e.av) { try { e.av.dispose(); } catch (err) { } e.av = null; }
    delete BOTS[id];
    delete SIMS[e.slot];
    hudDirty = true;
  }
  /* make the players and bots agree with the roster */
  function syncActors() {
    var keep = {}, i, id;
    ME.team = -1;
    for (id in PEERS) PEERS[id].team = -1;
    for (i = 0; i < ROUND.ro.length; i++) {
      var r = ROUND.ro[i];
      if (r.bot) {
        var e = botEntry(r.slot);
        e.team = r.team; r.name = e.name; keep[e.id] = 1;
        /* a bot's tally is kept where it runs */
        if (ROUND.auth !== ME.id) { e.frags = r.frags | 0; e.deaths = r.deaths | 0; }
      }
      else if (r.id === ME.id) ME.team = r.team;
      else if (PEERS[r.id]) { PEERS[r.id].team = r.team; r.name = PEERS[r.id].name; }
    }
    for (id in BOTS) if (!keep[id]) dropBot(id);
  }
  function clearTallies() {
    ME.frags = ME.deaths = 0;
    eachOther(function (e) { e.frags = 0; e.deaths = 0; });
    try { player.kills = 0; } catch (e) { }
  }
  /* nobody is in the match any more */
  function resetRound() {
    ROUND.auth = null; ROUND.key = ''; ROUND.ph = 'wait'; ROUND.ro = []; ROUND.win = -1; ROUND.n = 0; ROUND.sc = [0, 0];
    SIMS = {};
    syncActors();
    hudDirty = true;
  }

  /* ------------------------------------------------- the round, on the wire -- */
  function r2(v) { return Math.round(v * 100) / 100; }
  function roundMsg() {
    var t = nowS(), ro = [];
    for (var i = 0; i < ROUND.ro.length; i++) {
      var r = ROUND.ro[i], e = r.bot ? BOTS[r.id] : null;
      ro.push([r.id, r.team, r.bot ? 1 : 0, r.name, [r.sp.x, r.sp.y, r.sp.z, r.sp.yaw], r.dead ? 1 : 0, e ? e.frags : 0, e ? e.deaths : 0]);
    }
    var until = ROUND.ph === 'live' ? ROUND.endsAt : ROUND.nextAt;
    return { t: 'r', q: ROUND.q, n: ROUND.n, ph: ROUND.ph, sc: ROUND.sc, ro: ro, win: ROUND.win, left: Math.max(0, Math.round((until - t) * 10) / 10), sk: SKILL };
  }
  function onRound(pr, m) {
    /* only from the browser that should be running the match */
    if (!teamMode() || isAuth() || pr.id !== authId()) return;
    var ph = (m.ph === 'live' || m.ph === 'over' || m.ph === 'match') ? m.ph : null;
    if (!ph || !Array.isArray(m.ro) || !Array.isArray(m.sc)) return;
    var ro = [], seen = {};
    for (var i = 0; i < m.ro.length && ro.length < 16; i++) {
      var a = m.ro[i];
      if (!Array.isArray(a) || typeof a[0] !== 'string') continue;
      var bot = !!a[2], slot = bot ? clamp(parseInt(a[0].slice(2), 10) || 0, 0, 15) : -1;
      var id = bot ? '#b' + slot : a[0].slice(0, 24), sp = Array.isArray(a[4]) ? a[4] : [];
      if (seen[id]) continue;
      seen[id] = 1;
      ro.push({
        id: id, team: a[1] === 1 ? 1 : 0, bot: bot, slot: slot, name: cleanName(a[3]) || 'OYUNCU',
        sp: { x: fin(sp[0]), y: fin(sp[1]), z: fin(sp[2]), yaw: fin(sp[3]) },
        dead: !!a[5], frags: Math.max(0, fin(a[6]) | 0), deaths: Math.max(0, fin(a[7]) | 0)
      });
    }
    applyRound({
      auth: pr.id, q: fin(m.q) | 0, n: clamp(fin(m.n) | 0, 0, 9999), ph: ph,
      sc: [clamp(fin(m.sc[0]) | 0, 0, 99), clamp(fin(m.sc[1]) | 0, 0, 99)], ro: ro,
      win: fin(m.win, -1) | 0, left: clamp(fin(m.left), 0, 600), sk: SKILL_NAMES[m.sk] ? m.sk : 'normal'
    });
  }
  /* Take a description of the round as the truth. The browser running the
     match calls this on itself too, so there is one code path for a round
     starting or ending on every screen. */
  function applyRound(R) {
    var key = R.auth + ':' + R.q, isNew = key !== ROUND.key, prevPh = ROUND.ph, t = nowS(), i, id;
    var was = {};
    if (!isNew) for (i = 0; i < ROUND.ro.length; i++) if (ROUND.ro[i].dead) was[ROUND.ro[i].id] = 1;
    if (ROUND.auth !== R.auth) {
      /* another browser runs the bots now: its clock, its packets */
      for (id in BOTS) { var e = BOTS[id]; e.snaps.length = 0; e.offs.length = 0; e.offset = null; e.lastT = 0; }
    }
    ROUND.auth = R.auth; ROUND.q = R.q; ROUND.key = key; ROUND.n = R.n; ROUND.ph = R.ph;
    ROUND.sc = [R.sc[0] | 0, R.sc[1] | 0]; ROUND.win = R.win; ROUND.sk = R.sk;
    for (i = 0; i < R.ro.length; i++) if (was[R.ro[i].id]) R.ro[i].dead = true;
    ROUND.ro = R.ro;
    if (R.auth !== ME.id) {
      var until = t + R.left;
      if (R.ph === 'live') { if (isNew || Math.abs(until - ROUND.endsAt) > 0.6) ROUND.endsAt = until; }
      else ROUND.nextAt = until;
    }
    syncActors();
    hudDirty = true;
    refreshLobby();
    if (!isNew) return;
    if (R.ph === 'live') {
      if (R.n === 1 && prevPh === 'match') clearTallies();
      var mine = rosterEntry(ME.id);
      if (ME.inMatch && mine && !mine.dead) {
        respawn(mine.sp);
        try { message('RAUNT ' + R.n); } catch (err) { }
        try { subtitle(TEAMS[mine.team].name + ' TAKIMDASIN — KARŞI TAKIMI İNDİR', 3200); } catch (err) { }
        try { sfx('switch'); } catch (err) { }
      } else if (ME.inMatch && player.alive) sitOut();
    } else announceResult(R);
  }
  /* a round we are not dealt into (the sides are full): watch it */
  function sitOut() {
    player.alive = false; player.hp = 0;
    try { mouseDown = false; adsDown = false; altQueued = false; } catch (e) { }
    ME.spec = true; ME.hidden = true; ME.respawnAt = 0;
    try { subtitle('BU RAUNTTA YER YOK — İZLİYORSUN', 3500); } catch (e) { }
    sendStateNow();
  }
  function announceResult(R) {
    var w = R.win, mine = ME.inMatch ? ME.team : -1;
    var sc = TEAMS[0].name + ' ' + R.sc[0] + ' — ' + R.sc[1] + ' ' + TEAMS[1].name;
    var side = (w === 0 || w === 1) ? TEAMS[w].name + ' TAKIM' : '';
    try {
      if (R.ph === 'match') {
        message(mine >= 0 ? (w === mine ? 'MAÇI KAZANDINIZ!' : 'MAÇI KAYBETTİNİZ') : 'MAÇI ' + side + ' ALDI');
        subtitle(sc + ' · YENİ MAÇ BİRAZDAN', MATCH_GAP * 1000 - 800);
        try { sfx(w === mine ? 'win' : 'switch'); } catch (e) { }
      } else {
        message(!side ? 'RAUNT BERABERE' : mine >= 0 ? (w === mine ? 'RAUNDU ALDINIZ' : 'RAUNDU KAYBETTİNİZ') : 'RAUNDU ' + side + ' ALDI');
        subtitle(sc, ROUND_GAP * 1000 - 800);
      }
    } catch (e) { }
  }

  /* ---------------------------------------------- running the match (auth) -- */
  /* the people in the match, earliest into the room first */
  function matchHumans() {
    var out = [];
    if (ME.inMatch) out.push({ id: ME.id, j: ME.j || 9e15, want: ME.want, name: ME.name });
    for (var id in PEERS) {
      var pr = PEERS[id];
      if (pr.open && pr.inMatch) out.push({ id: id, j: pr.j === null ? 9e15 : pr.j, want: pr.want, name: pr.name });
    }
    out.sort(function (a, b) { return a.j - b.j || (a.id < b.id ? -1 : 1); });
    return out;
  }
  /* The few pairs of spawn points that are furthest apart on foot. One end
     is one side's base for a round, the other end the other side's. */
  var SIDE_PAIRS = null;
  function sidePairs() {
    if (SIDE_PAIRS) return SIDE_PAIRS;
    var pts = SPAWN_PTS, pairs = [], i, j, onFoot = false;
    try { onFoot = !!(NZ.bots && NZ.bots.pathSteps && NZ.bots.ready()); } catch (e) { onFoot = false; }
    for (i = 0; i < pts.length; i++) for (j = i + 1; j < pts.length; j++) {
      var a = pts[i], b = pts[j], d;
      if (onFoot) {
        d = NZ.bots.pathSteps(a.x, a.z, a.y, b.x, b.z, b.y);
        if (d < 0) continue;                 /* no way between them without a lift */
      } else d = Math.hypot(a.x - b.x, a.z - b.z) + Math.abs(a.y - b.y) * 2;
      pairs.push({ a: i, b: j, d: d });
    }
    pairs.sort(function (p, q) { return q.d - p.d; });
    var out = [], used = {};
    for (i = 0; i < pairs.length && out.length < 3; i++) {
      var pp = pairs[i];
      if (used[pp.a] || used[pp.b]) continue;
      if (out.length && pp.d < out[0].d * 0.72) break;
      used[pp.a] = used[pp.b] = 1; out.push(pp);
    }
    if (onFoot || pts.length < 2) SIDE_PAIRS = out;
    return out;
  }
  function seatOf(base, x, z) { return { x: r2(x), y: r2(base.y), z: r2(z), yaw: Math.round(fin(base.yaw) * 1000) / 1000 }; }
  /* a base and room for the rest of the side right beside it */
  function seatsAt(base) {
    var out = [seatOf(base, base.x, base.z)], a0 = Math.random() * 6.2832;
    for (var k = 0; k < 8 && out.length < TEAM_SIZE; k++) {
      var ang = a0 + k * Math.PI / 4, x = base.x + Math.sin(ang) * 3.4, z = base.z + Math.cos(ang) * 3.4, ok = false;
      try { ok = canStand(x, z, PRAD, base.y) && Math.abs(highestFloor(x, z, PRAD * 0.85) - base.y) < 0.6; } catch (e) { ok = false; }
      if (ok) out.push(seatOf(base, x, z));
    }
    while (out.length < TEAM_SIZE) out.push(seatOf(base, base.x, base.z));
    return out;
  }
  function pickSides() {
    var pts = SPAWN_PTS, here = { x: player.x, y: player.y, z: player.z, yaw: player.yaw };
    if (pts.length < 2) return [seatsAt(pts[0] || here), seatsAt(pts[0] || here)];
    var prs = sidePairs(), a = pts[0], b = pts[1];
    if (prs.length) { var pick = prs[Math.floor(Math.random() * prs.length)]; a = pts[pick.a]; b = pts[pick.b]; }
    if (Math.random() < 0.5) { var s = a; a = b; b = s; }
    return [seatsAt(a), seatsAt(b)];
  }

  /* Deal a round: sides, seats, bots in the empty seats. `restart` deals
     the same round number again (somebody joined, or the browser that was
     running it left). */
  function startRound(restart) {
    var t = nowS(), i, k, tm, h;
    var n = ROUND.n, sc = [ROUND.sc[0], ROUND.sc[1]];
    if (ROUND.ph === 'match') { n = 1; sc = [0, 0]; }
    else if (!restart || n < 1) n++;
    var humans = matchHumans(), teams = [[], []];
    /* the side each person asked for, in the order they came in; then the
       undecided, to whichever side has fewer people */
    for (i = 0; i < humans.length; i++) {
      h = humans[i];
      if (h.want !== 0 && h.want !== 1) continue;
      tm = teams[h.want].length < TEAM_SIZE ? h.want : 1 - h.want;
      if (teams[tm].length < TEAM_SIZE) { teams[tm].push(h); h.dealt = true; }
    }
    for (i = 0; i < humans.length; i++) {
      h = humans[i];
      if (h.dealt) continue;
      tm = teams[0].length <= teams[1].length ? 0 : 1;
      if (teams[tm].length >= TEAM_SIZE) tm = 1 - tm;
      if (teams[tm].length < TEAM_SIZE) { teams[tm].push(h); h.dealt = true; }
    }
    var sides = pickSides(), ro = [], keep = {};
    var Bm = NZ.bots, haveBots = !!(Bm && Bm.create && Bm.spawn);
    for (tm = 0; tm < 2; tm++) {
      var seats = sides[tm], used = 0;
      for (i = 0; i < teams[tm].length; i++) {
        h = teams[tm][i];
        ro.push({ id: h.id, team: tm, bot: false, slot: -1, name: h.name, sp: seats[used++], dead: false, frags: 0, deaths: 0 });
      }
      for (k = 0; haveBots && used < TEAM_SIZE; k++) {
        var slot = tm * TEAM_SIZE + k, e = botEntry(slot), sim = SIMS[slot];
        if (!sim || sim.team !== tm) sim = SIMS[slot] = Bm.create({ slot: slot, team: tm, weapon: BOT_WEAPON, skill: SKILL });
        Bm.setSkill(sim, SKILL);
        Bm.spawn(sim, seats[used], t);
        keep[slot] = 1;
        ro.push({ id: e.id, team: tm, bot: true, slot: slot, name: e.name, sp: seats[used++], dead: false, frags: e.frags, deaths: e.deaths });
      }
    }
    for (var s in SIMS) if (!keep[s]) delete SIMS[s];
    ROUND.endsAt = t + ROUND_TIME; ROUND.startT = t; ROUND.beatT = t;
    applyRound({ auth: ME.id, q: ROUND.q + 1, n: n, ph: 'live', sc: sc, ro: ro, win: -1, left: ROUND_TIME, sk: SKILL });
    broadcastEvent(roundMsg());
  }
  /* win: 0 or 1, or 2 for a round nobody took */
  function endRound(win) {
    var t = nowS(), sc = [ROUND.sc[0], ROUND.sc[1]];
    if (win === 0 || win === 1) sc[win]++;
    var match = (win === 0 || win === 1) && sc[win] >= ROUNDS_TO_WIN;
    var gap = match ? MATCH_GAP : ROUND_GAP;
    ROUND.nextAt = t + gap; ROUND.beatT = t;
    applyRound({ auth: ME.id, q: ROUND.q + 1, n: ROUND.n, ph: match ? 'match' : 'over', sc: sc, ro: ROUND.ro, win: win, left: gap, sk: SKILL });
    broadcastEvent(roundMsg());
  }
  function rosterAlive(r) {
    if (r.dead) return false;
    if (r.bot) { var s = SIMS[r.slot]; return !!(s && s.alive); }
    return true;
  }
  function rosterHp(r) {
    if (r.bot) return SIMS[r.slot] ? Math.max(0, SIMS[r.slot].hp) : 0;
    if (r.id === ME.id) return Math.max(0, fin(player.hp));
    return PEERS[r.id] ? fin(PEERS[r.id].hp) : 0;
  }
  /* Everything the browser running the match does each frame. `coarse` is
     the once-a-second call from a hidden tab: the rounds go on, the bots
     wait. */
  function authTick(t, dt, coarse) {
    if (ROUND.auth !== ME.id) { startRound(ROUND.ph === 'live'); return; }
    var i, r;
    if (ROUND.ph === 'live') {
      /* somebody new is in: deal them in at once */
      var humans = matchHumans();
      for (i = 0; i < humans.length; i++) if (!rosterEntry(humans[i].id)) { startRound(true); return; }
      /* a player whose link has gone is out of this round */
      for (i = 0; i < ROUND.ro.length; i++) {
        r = ROUND.ro[i];
        if (!r.bot && !r.dead && r.id !== ME.id && !(PEERS[r.id] && PEERS[r.id].open)) { r.dead = true; hudDirty = true; }
      }
      if (!coarse) stepBots(t, dt);
      if (t - ROUND.startT > 1.0) {
        var alive = [0, 0], size = [0, 0], hp = [0, 0];
        for (i = 0; i < ROUND.ro.length; i++) {
          r = ROUND.ro[i];
          size[r.team]++;
          if (rosterAlive(r)) { alive[r.team]++; hp[r.team] += rosterHp(r); }
        }
        var win = -1;
        if (size[0] && size[1]) {
          if (!alive[0] && !alive[1]) win = 2;
          else if (!alive[0]) win = 1;
          else if (!alive[1]) win = 0;
          else if (t >= ROUND.endsAt) {
            /* time: more standing wins, then more health, else nobody */
            win = alive[0] !== alive[1] ? (alive[0] > alive[1] ? 0 : 1) : (Math.abs(hp[0] - hp[1]) > 1 ? (hp[0] > hp[1] ? 0 : 1) : 2);
          }
        }
        if (win >= 0) { endRound(win); return; }
      }
    } else if (t >= ROUND.nextAt) { startRound(false); return; }
    if (t - ROUND.beatT >= 1.0) { ROUND.beatT = t; broadcastEvent(roundMsg()); }
  }

  /* ------------------------------------------------------ running the bots -- */
  /* Everyone standing, by side, as a bot sees them. */
  var ACT = [[], []];
  function listActors(t) {
    ACT[0].length = 0; ACT[1].length = 0;
    for (var i = 0; i < ROUND.ro.length; i++) {
      var r = ROUND.ro[i], a = null;
      if (r.dead) continue;
      if (r.bot) {
        var sim = SIMS[r.slot];
        if (sim && sim.alive) a = { id: r.id, kind: 'bot', ref: BOTS[r.id], x: sim.x, y: sim.y, z: sim.z, eyeH: sim.eyeH, vx: sim.vx, vz: sim.vz, alive: true, firedAgo: t - sim.firedAt };
      } else if (r.id === ME.id) {
        if (player.alive && !ME.spec) a = { id: r.id, kind: 'me', ref: ME, x: player.x, y: player.y, z: player.z, eyeH: fin(player.eyeH, 6), vx: fin(player.vxs), vz: fin(player.vzs), alive: true, firedAgo: t - ME.firedAt };
      } else {
        var pr = PEERS[r.id];
        if (pr && pr.av && pr.shown && pr.av.P.alive) {
          var P = pr.av.P;
          a = { id: r.id, kind: 'peer', ref: pr, x: P.x, y: P.y, z: P.z, eyeH: fin(P.eyeH, 6), vx: fin(pr.vx), vz: fin(pr.vz), alive: true, firedAgo: t - fin(pr.firedAt, -9) };
        }
      }
      if (a && a.ref) ACT[r.team].push(a);
    }
  }
  var CTX = { now: 0, foes: null, mates: null, fire: null };
  function stepBots(t, dt) {
    var Bm = NZ.bots;
    if (!Bm || !Bm.step) return;
    listActors(t);
    CTX.now = t; CTX.fire = botFire;
    for (var s in SIMS) {
      var sim = SIMS[s];
      if (!sim.alive) continue;
      var side = ACT[sim.team], mates = [], self = BOTS['#b' + sim.slot];
      for (var i = 0; i < side.length; i++) if (side[i].ref !== self) mates.push(side[i]);
      CTX.foes = ACT[1 - sim.team]; CTX.mates = mates;
      try { Bm.step(sim, dt, CTX); } catch (err) { netError(err, 'bot'); }
    }
  }
  /* The local player as three capsules. A bot's round is tested against the
     figures on this screen; the local player is not drawn as one in first
     person, so this stands in for him (same shape as makeStandIn's). */
  function selfParts(out) {
    out.length = 0;
    var MU = (typeof M === 'number') ? M : 3.5, P = player, h = fin(P.eyeH, 6) / MU, top = P.y + (h + 0.11) * MU;
    out.push({ zone: 'head', r: 0.115 * MU, ax: P.x, ay: top - 0.11 * MU, az: P.z, bx: P.x, by: top - 0.11 * MU, bz: P.z });
    out.push({ zone: 'body', r: 0.18 * MU, ax: P.x, ay: P.y + h * 0.52 * MU, az: P.z, bx: P.x, by: top - 0.30 * MU, bz: P.z });
    out.push({ zone: 'limb', r: 0.15 * MU, ax: P.x, ay: P.y + 0.15 * MU, az: P.z, bx: P.x, by: P.y + h * 0.50 * MU, bz: P.z });
    return out;
  }
  function noParts(out) { out.length = 0; return out; }
  /* One round from a bot (nz-bots.js calls this): what it hit, who gets
     told, and what it looks like. dir is unit length. */
  function botFire(sim, org, dir, w) {
    var W = null;
    try { W = WPN[w | 0]; } catch (e) { }
    if (!W) return;
    var range = fin(W.range, 300) || 300, bt = range;
    try { bt = castWall(org, dir, range); } catch (e) { }
    var foes = ACT[1 - sim.team], best = null, bz = '';
    for (var i = 0; i < foes.length; i++) {
      var a = foes[i], parts = a.kind === 'me' ? selfParts : (a.ref.av ? a.ref.av.hitParts : noParts);
      if (rayParts(org, dir.x, dir.y, dir.z, bt, a.x, a.y, a.z, parts)) { best = a; bt = RAY.t; bz = RAY.zone; }
    }
    var e = BOTS['#b' + sim.slot];
    var nowhere = !best && !(bt < range - 0.1);
    var m = {
      t: 'f', b: sim.slot, w: w | 0, q: 0,
      e: [[r3(org.x + dir.x * bt), r3(org.y + dir.y * bt), r3(org.z + dir.z * bt), best ? 1 : nowhere ? 2 : 0]],
      o: [r3(org.x), r3(org.y), r3(org.z)],
      d: Math.round(fin(W.dmg, 12) * fin(sim.skill && sim.skill.dmg, 1) * 100) / 100
    };
    broadcastEvent(m);
    if (e) { e.firedAt = nowS(); drawFire(e, m); }
    /* no hitscan() ran for it here either: its wall impact, on this screen */
    if (!best && !nowhere) fireImpacts(m, null);
    if (!best || ROUND.ph !== 'live') return;
    var d = fin(W.dmg, 12) * (ZONE_MULT[bz] || 1) * fin(sim.skill && sim.skill.dmg, 1);
    var head = bz === 'head', by = '#b' + sim.slot;
    if (best.kind === 'me') hurtMe(d, by, w | 0, head, sim.x, sim.z);
    else if (best.kind === 'peer') sendEvent(best.ref, { t: 'h', d: Math.round(d * 10) / 10, hd: head ? 1 : 0, w: w | 0, sx: r2(sim.x), sz: r2(sim.z), by: by });
    else botDamage(best.ref, d, by, w | 0, head, sim.x, sim.z);
  }
  /* a round landed on a bot this browser runs */
  function botDamage(e, d, by, w, head, sx, sz) {
    var sim = SIMS[e.slot];
    if (!sim || !sim.alive || sim.invT > 0 || ROUND.ph !== 'live') return;
    if (teamOf(by) === sim.team || teamOf(by) < 0) return;
    try { NZ.bots.hurt(sim, d, by, sx, sz, nowS()); } catch (err) { sim.hp -= d; }
    e.hp = Math.max(0, sim.hp);
    if (e.av) e.av.hurt();
    if (sim.hp > 0) return;
    sim.alive = false; sim.hp = 0;
    broadcastEvent({ t: 'd', v: e.id, by: by, w: w, hd: head ? 1 : 0, q: ROUND.q });
    noteDeath(e.id, by, w, head, ROUND.q);
    broadcastState(encodeBot(sim));
  }
  var SIMSMP = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, eyeH: 0, vy: 0, dash: 0, ads: 0, flags: 0, w: 0, life: 0 };
  function driveBot(e, sim, dt) {
    if (e.av && e.avKey !== avatarKey(e)) { try { e.av.dispose(); } catch (err) { } e.av = null; e.shown = false; }
    if (!e.av && READY && e.team >= 0) { e.av = makeAvatar(e); e.avKey = avatarKey(e); }
    e.hp = Math.max(0, sim.hp);
    if (!e.av) return;
    var o = SIMSMP;
    o.x = sim.x; o.y = sim.y; o.z = sim.z; o.yaw = sim.yaw; o.pitch = sim.pitch;
    o.eyeH = fin(sim.eyeH, 6); o.vy = fin(sim.vy); o.dash = fin(sim.dash); o.ads = fin(sim.ads);
    o.flags = 32 | (sim.alive ? 1 : 0) | (sim.onGround ? 2 : 0); o.w = sim.weapon; o.life = sim.life;
    driveAvatar(e, o, dt);
  }

  function teamFrame(t, dt) {
    var auth = isAuth(), id;
    if (auth) authTick(t, dt, false);
    else {
      for (id in SIMS) { SIMS = {}; break; }           /* somebody else runs them now */
      if (ROUND.ph !== 'wait' && authId() === null) resetRound();
    }
    for (id in BOTS) {
      var e = BOTS[id], sim = auth ? SIMS[e.slot] : null;
      if (sim) driveBot(e, sim, dt); else updateAvatar(e, dt, t);
    }
    if (auth && t - ME.botSendT >= SEND_MIN) {
      ME.botSendT = t;
      for (id in SIMS) broadcastState(encodeBot(SIMS[id]));
    }
  }

  /* ------------------------------------------- watching, and name tags -- */
  /* Down in a team round, the camera rides over a team-mate's shoulder. The
     game does not move the camera for a dead player, and nz-hero's own
     camera has had its turn by the time this runs (priority 15). */
  var SPEC = { on: false, id: null, init: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, boom: 2, tip: 0 };
  function specOK(e, anyone) {
    return !!(e && e.av && e.shown && e.av.P.alive && e.team >= 0 && (anyone || e.team === ME.team));
  }
  function specPick() {
    var anyone = ME.team < 0;
    var cur = SPEC.id ? (PEERS[SPEC.id] || BOTS[SPEC.id]) : null;
    if (specOK(cur, anyone)) return cur;
    var best = null;
    eachOther(function (e) { if (!best && specOK(e, anyone)) best = e; });
    /* the whole side is down: stay with the last one */
    return best || ((cur && cur.av && cur.shown) ? cur : null);
  }
  var _sd = { x: 0, y: 0, z: 0 }, _so = { x: 0, y: 0, z: 0 };
  function specCamera(e, dt) {
    var c = NZ.ctx.camera, P = e.av.P;
    var eye = P.y + fin(P.eyeH, 6), pit = clamp(fin(P.pitch) * 0.6 - 0.12, -1.0, 0.8);
    if (!SPEC.init || SPEC.id !== e.id) {
      SPEC.x = P.x; SPEC.y = eye; SPEC.z = P.z; SPEC.yaw = P.yaw; SPEC.pitch = pit; SPEC.boom = 1.5; SPEC.tip = 0; SPEC.init = true; SPEC.id = e.id;
    }
    var k = 1 - Math.exp(-dt * 16), kr = 1 - Math.exp(-dt * 10);
    if (Math.abs(P.x - SPEC.x) + Math.abs(P.z - SPEC.z) + Math.abs(eye - SPEC.y) > 14) { SPEC.x = P.x; SPEC.y = eye; SPEC.z = P.z; }
    SPEC.x += (P.x - SPEC.x) * k; SPEC.y += (eye - SPEC.y) * k; SPEC.z += (P.z - SPEC.z) * k;
    SPEC.yaw += angWrap(P.yaw - SPEC.yaw) * kr; SPEC.pitch += (pit - SPEC.pitch) * kr;
    var sy = Math.sin(SPEC.yaw), cy = Math.cos(SPEC.yaw), sp = Math.sin(SPEC.pitch), cp = Math.cos(SPEC.pitch);
    var fx = -sy * cp, fy = sp, fz = -cy * cp, rx = cy, rz = -sy;
    /* The game's own third-person framing (nz-hero.js, CAMT.hip): a little
       above the eye, out over the right shoulder, then back -- each leg only
       as far as the walls allow. */
    var up = 1.05, side = 1.9, back = 9.6, k;
    _so.x = SPEC.x; _so.y = SPEC.y; _so.z = SPEC.z;
    try { _sd.x = 0; _sd.y = 1; _sd.z = 0; up = clamp(castWall(_so, _sd, up + 0.6) - 0.6, 0, up); } catch (err) { up = 0; }
    _so.y += up;
    try { _sd.x = rx; _sd.y = 0; _sd.z = rz; side = clamp(castWall(_so, _sd, side + 0.6) - 0.6, 0, side); } catch (err) { side = 0; }
    _so.x += rx * side; _so.z += rz * side;
    try { _sd.x = -fx; _sd.y = -fy; _sd.z = -fz; back = clamp(castWall(_so, _sd, back + 0.7) - 0.7, 0.8, back); } catch (err) { back = 3; }
    /* in at once (a lens inside a wall shows the void), out gently */
    SPEC.boom = back < SPEC.boom ? back : SPEC.boom + (back - SPEC.boom) * (1 - Math.exp(-dt * 4));
    var lx = _so.x - fx * SPEC.boom, ly = _so.y - fy * SPEC.boom, lz = _so.z - fz * SPEC.boom, tip = 0;
    /* Backed against a wall, the lens would sit on the back of his head and
       hide everything he is looking at: rise over him instead, and look down
       past him. */
    var lift = Math.min(2.2, Math.max(0, 3.4 - SPEC.boom) * 0.8);
    if (lift > 0.01) {
      _so.x = lx; _so.y = ly; _so.z = lz;
      try { _sd.x = 0; _sd.y = 1; _sd.z = 0; lift = clamp(castWall(_so, _sd, lift + 0.5) - 0.5, 0, lift); } catch (err) { lift = 0; }
      ly += lift;
      tip = Math.atan2(lift, SPEC.boom + 3.5) * 0.9;
    }
    k = 1 - Math.exp(-dt * 6);
    SPEC.tip += (tip - SPEC.tip) * k;
    c.position.set(lx, ly, lz);
    c.rotation.order = 'YXZ';
    c.rotation.set(SPEC.pitch - SPEC.tip, SPEC.yaw, 0);
    if (Math.abs(c.fov - 78) > 0.01) { c.fov = 78; c.updateProjectionMatrix(); }
    try { if (typeof skyMesh !== 'undefined' && skyMesh) skyMesh.position.copy(c.position); } catch (err) { }
    try { if (typeof updateAudioListener === 'function') updateAudioListener(); } catch (err) { }
  }
  /* a name over each team-mate, so you can tell the two red jackets apart
     from the two blue ones at a glance -- and find yours through a wall */
  var TAGS = {}, _tv = null;
  function updateTags() {
    var box = $('nzTags');
    if (!box) return;
    var seen = {}, c = NZ.ctx.camera;
    if (ME.inMatch && ME.team >= 0 && c) {
      if (!_tv) _tv = new THREE.Vector3();
      c.updateMatrixWorld();
      var w = global.innerWidth, h = global.innerHeight;
      eachOther(function (e) {
        if (e.team !== ME.team || !e.av || !e.shown || !e.av.P.alive || (SPEC.on && SPEC.id === e.id)) return;
        var P = e.av.P;
        _tv.set(P.x, P.y + fin(P.eyeH, 6) + 1.1, P.z).project(c);
        if (!(_tv.z > -1 && _tv.z < 1) || Math.abs(_tv.x) > 1.05 || Math.abs(_tv.y) > 1.05) return;
        var el = TAGS[e.id];
        if (!el) { el = TAGS[e.id] = document.createElement('div'); el.className = 'nzTag'; box.appendChild(el); }
        if (el._n !== e.name) { el.textContent = e.name; el._n = e.name; }
        if (el._t !== e.team) { el.style.color = TEAMS[e.team].tag; el._t = e.team; }
        var sx = clamp((_tv.x * 0.5 + 0.5) * w, 56, w - 56), sy = clamp((-_tv.y * 0.5 + 0.5) * h, 20, h - 8);
        el.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) translate(-50%,-100%)';
        if (el._on !== 1) { el.style.display = 'block'; el._on = 1; }
        seen[e.id] = 1;
      });
    }
    for (var id in TAGS) {
      if (seen[id]) continue;
      var t = TAGS[id];
      if (t._on !== 0) { t.style.display = 'none'; t._on = 0; }
      if (!PEERS[id] && !BOTS[id]) { try { box.removeChild(t); } catch (err) { } delete TAGS[id]; }
    }
  }
  function viewFrame(dt) {
    var watch = (ME.inMatch && ME.spec && !player.alive) ? specPick() : null;
    if (watch) {
      specCamera(watch, dt);
      if (NZ.view) NZ.view.hideVM = true;
    }
    if (!!watch !== SPEC.on) {
      SPEC.on = !!watch;
      if (!watch) { SPEC.init = false; SPEC.id = null; if (NZ.view && !(NZ.flags && NZ.flags.hero)) NZ.view.hideVM = false; }
      /* the crosshair and hit marks belong to a player who is playing */
      try { $('overlay').style.opacity = watch ? '0' : '1'; } catch (err) { }
      try { $('cross').style.visibility = watch ? 'hidden' : ''; } catch (err) { }
    }
    var bar = $('nzSpec');
    if (bar) {
      var txt = watch ? 'İZLİYORSUN: ' + watch.name + (watch.hp > 0 ? ' · ' + Math.round(watch.hp) + ' CAN' : '') : '';
      if (bar._t !== txt) { bar.textContent = txt; bar.style.display = txt ? 'block' : 'none'; bar._t = txt; }
    }
    updateTags();
  }
  NZ.on('render', function (dt) {
    if (!NET.active || !teamMode()) return undefined;
    try { viewFrame(clamp(fin(dt, 0.016), 0, 0.1)); } catch (err) { netError(err, 'view'); }
    return undefined;
  }, 15);

  /* ============================================================ the frame == */
  var hudDirty = true;
  NZ.on('render', function (dt) {
    if (!NET.active) return undefined;
    try { netFrame(fin(dt, 0.016)); } catch (err) { netError(err, 'frame'); }
    return undefined;
  }, 40);

  function netFrame(dt) {
    var t = nowS();
    if (ME.inMatch) {
      /* Y is the museum key in single player and makes the player immune;
         in a match nobody gets to be a statue */
      try { if (inspectMode) inspectMode = false; } catch (e) { }
      if (AR && player.alive && !ME.spec) keepInArena();
      if (t - ME.sendT >= SEND_MIN) sendStateNow();
      if (!player.alive && ME.respawnAt && t >= ME.respawnAt) respawn();
      govFrame(dt, t);
    }
    /* what came in while the level loaded, once nz-destruct has its glass */
    if (READY && (LATE.snap || LATE.fires.length) &&
        ((NZ.destruct && NZ.destruct.ok) || t - ME.readyT > 3) && t - ME.readyT > 0.75) drainLate();
    if (t - ME.pingT >= PING_EVERY) { ME.pingT = t; pingAll(); }
    for (var id in PEERS) {
      var pr = PEERS[id];
      if (pr.sigGone && (!pr.open || t - pr.lastRecv > STALE_AFTER)) { removePeer(id); continue; }
      if (pr.retryT && t >= pr.retryT) { pr.retryT = 0; startOffer(pr); }
      updateAvatar(pr, dt, t);
    }
    if (teamMode()) teamFrame(t, dt);
    if (t - ME.hudT > 0.25 || hudDirty) { ME.hudT = t; drawHud(); }
  }

  /* canStand() holds the fence; this is the net under it, for anything that
     moves the player without asking it (a knock-back, a respawn bug) */
  function keepInArena() {
    var cx = Math.floor(player.x / CELL), cy = Math.floor(player.z / CELL);
    if (arenaIn(cx, cy)) { ME.good = [player.x, player.y, player.z]; return; }
    ME.fenced++;
    if (ME.good) { player.x = ME.good[0]; player.y = ME.good[1]; player.z = ME.good[2]; player.vy = 0; }
    else respawn();
  }

  /* ================================================== frame governor == */
  /* nz-render's ladder sheds post effects when frames run long, and stops
     once cutting them buys nothing -- which is exactly the machine that is
     paying for pixels: a laptop's integrated GPU at 1.5x on a big street.
     In a match frames are aim, so this goes one step further, only after the
     ladder is done (locked, pinned or out of rungs): the pixel ratio to 1 on
     a high-DPI desktop, then the scene scale down in two steps. A step that
     buys less than 8% is undone and the governor stops there; three fast
     windows in a row give a step back, and one that does not hold is not
     tried again for a minute and a half. ?nzgov=0 turns it off. */
  var GOV = {
    off: routeParam('nzgov') === '0',
    steps: null, step: 0, hist: [], t0: 0, prevMed: 0, checking: false, probation: false,
    locked: false, good: 0, upBlock: 0, last: null, lastNow: 0, med: 0
  };
  var GOV_SLOW = 28, GOV_FAST = 15.5, GOV_GAIN = 0.92, GOV_WIN = 1.6;
  function govSteps() {
    var s = [{ dpr: 0, mul: 1 }];
    var phone = !!(NZ.touch && NZ.touch.phone);     /* nz-touch owns its dprCap */
    var dp = 1;
    try { dp = renderer.getPixelRatio(); } catch (e) { dp = global.devicePixelRatio || 1; }
    var hiDpi = !phone && dp > 1.05;
    if (hiDpi) s.push({ dpr: 1, mul: 1 });
    if (NZ.flags && NZ.flags.render && NZ.render && NZ.render.setScale) {
      s.push({ dpr: hiDpi ? 1 : 0, mul: 0.85 });
      s.push({ dpr: hiDpi ? 1 : 0, mul: 0.72 });
    }
    return s;
  }
  function govApply(i) {
    var S = GOV.steps[i]; if (!S) return;
    GOV.step = i;
    try {
      if (!(NZ.touch && NZ.touch.phone)) {
        if (S.dpr) NZ.dprCap = S.dpr; else delete NZ.dprCap;
        if (typeof resize === 'function') resize();
      }
    } catch (e) { }
    try { if (NZ.render && NZ.render.setScale) NZ.render.setScale(S.mul); } catch (e) { }
    GOV.hist.length = 0; GOV.t0 = 0;
    GOV.last = { step: i, at: +nowS().toFixed(1) };
  }
  function ladderDone() {
    try {
      var st = NZ.render && NZ.render.stats;
      if (!st) return true;
      return st.locked || st.pinned || st.degrade >= 4;
    } catch (e) { return true; }
  }
  function govFrame(dt, t) {
    /* the game hands hooks a dt clamped to 50 ms, which would hide the very
       difference a cut makes on a 10-20 fps machine: time the frames here */
    var now = performance.now(), ms = GOV.lastNow ? now - GOV.lastNow : 0;
    GOV.lastNow = now;
    if (GOV.off || GOV.fed || document.hidden) { GOV.lastNow = 0; return; }
    govSample(ms, t);
  }
  function govSample(ms, t) {
    if (!GOV.steps) GOV.steps = govSteps();
    if (GOV.steps.length < 2 || !(ms > 0) || ms > 1000) return;   /* over 1 s: a hitch */
    var h = GOV.hist;
    h.push(ms);
    if (!GOV.t0) GOV.t0 = t;
    if (h.length < 40 || t - GOV.t0 < GOV_WIN) return;
    var srt = h.slice().sort(function (a, b) { return a - b; }), med = srt[srt.length >> 1];
    h.length = 0; GOV.t0 = t; GOV.med = Math.round(med * 10) / 10;
    if (GOV.checking) {                      /* did that cut buy anything? */
      GOV.checking = false;
      if (med > GOV.prevMed * GOV_GAIN) { GOV.locked = true; govApply(GOV.step - 1); return; }
    }
    if (GOV.probation) {                     /* did that step back hold? */
      GOV.probation = false;
      if (med > GOV_SLOW) { GOV.upBlock = t + 90; govApply(GOV.step + 1); return; }
    }
    if (med > GOV_SLOW && !GOV.locked && GOV.step < GOV.steps.length - 1 && ladderDone()) {
      GOV.prevMed = med; GOV.checking = true; GOV.good = 0;
      govApply(GOV.step + 1);
      return;
    }
    if (med < GOV_FAST && GOV.step > 0 && t > GOV.upBlock) {
      if (++GOV.good >= 3) { GOV.good = 0; GOV.probation = true; GOV.locked = false; govApply(GOV.step - 1); }
      return;
    }
    GOV.good = 0;
  }

  /* a hidden tab gets no animation frames: keep saying we are here */
  setInterval(function () {
    if (!NET.active || !document.hidden) return;
    try { if (ME.inMatch) sendStateNow(); pingAll(); } catch (e) { }
    /* a match this browser runs keeps its clock and its door open; the bots
       themselves stand still until the tab is looked at again */
    try { if (teamMode() && isAuth()) authTick(nowS(), 0, true); } catch (e) { }
  }, 1000);

  /* ======================================================== signalling == */
  var SIG = { ws: null, backoff: 800, fatal: false, status: 'connecting', msg: 'OYUN SUNUCUSUNA BAĞLANILIYOR…' };

  function sigUrl() {
    var o = routeParam('signal') || global.NZ_NET_SIGNAL;
    if (o) return o;
    return (global.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + global.location.host + '/signal';
  }
  function sigSend(obj) {
    if (SIG.ws && SIG.ws.readyState === 1) { try { SIG.ws.send(JSON.stringify(obj)); } catch (e) { } }
  }
  function setStatus(kind, msg) { SIG.status = kind; SIG.msg = msg; refreshLobby(); }

  function sigConnect() {
    if (SIG.fatal) return;
    if (global.location.protocol === 'file:' && !routeParam('signal')) {
      SIG.fatal = true;
      setStatus('err', 'ÇOK OYUNCULU İÇİN OYUN SUNUCUSU GEREKLİ — npm run mp KOMUTUNU ÇALIŞTIR VE YAZDIĞI ADRESİ AÇ');
      return;
    }
    if (ROOM.length < 4) { SIG.fatal = true; setStatus('err', 'BU ODA KODU GEÇERSİZ'); return; }
    var ws;
    try { ws = new WebSocket(sigUrl()); }
    catch (err) { setStatus('err', 'OYUN SUNUCUSUNA ULAŞILAMADI'); return; }
    SIG.ws = ws;
    ws.onopen = function () {
      SIG.backoff = 800;
      sigSend({ t: 'join', room: ROOM, id: ME.id, name: ME.name, proto: PROTO, build: BUILD, level: ROUTE_LEVEL, mode: MODE });
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      try { onSignal(m); } catch (err) { netError(err, 'signal'); }
    };
    ws.onclose = function () {
      if (SIG.ws === ws) SIG.ws = null;
      if (SIG.fatal) return;
      /* the direct connections do not need this socket; only new arrivals do */
      setStatus(ME.welcomed ? 'warn' : 'connecting', ME.welcomed ? 'OYUN SUNUCUSUNA YENİDEN BAĞLANILIYOR… (MAÇ SÜRÜYOR)' : 'OYUN SUNUCUSUNA BAĞLANILIYOR…');
      setTimeout(sigConnect, SIG.backoff);
      SIG.backoff = Math.min(15000, SIG.backoff * 1.8);
    };
    ws.onerror = function () { };
  }

  function onSignal(m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'welcome') {
      ME.id = m.id; ME.color = m.color | 0; ME.welcomed = true;
      /* when we came in, by the server's clock: the earliest in the match runs it */
      if (!ME.j) ME.j = (typeof m.j === 'number' && isFinite(m.j) && m.j > 0) ? m.j : Date.now();
      if ((m.mode === 'dm' || m.mode === 'team') && m.mode !== MODE && !ME.inMatch) setMode(m.mode);
      ICE = Array.isArray(m.ice) ? m.ice : [];
      ROOM_MAX = m.max | 0 || ROOM_MAX; HOST_ID = m.host;
      var listed = {};
      for (var i = 0; i < (m.peers || []).length; i++) {
        var p = m.peers[i];
        listed[p.id] = 1;
        var pr = addPeer(p.id, p.name, p.color, true);
        pr.offerer = true;
        if (!pr.open && (!pr.pc || pr.conn === 'failed' || pr.conn === 'closed')) startOffer(pr);
      }
      for (var id in PEERS) if (!listed[id] && !PEERS[id].open) removePeer(id);
      setStatus('ok', '');
      enableJoin(true);
    } else if (m.t === 'peer-joined') {
      addPeer(m.id, m.name, m.color, false);
      refreshLobby();
    } else if (m.t === 'peer-left') {
      /* Their socket to the server went away. If we are still hearing from
         them directly, that is a server restart or a network blip on their
         side, not a goodbye: keep playing until the direct link goes too. */
      var gone = PEERS[m.id];
      if (gone && gone.open && nowS() - gone.lastRecv < 3) gone.sigGone = true;
      else removePeer(m.id);
    } else if (m.t === 'peer-name') {
      if (PEERS[m.id]) { PEERS[m.id].name = cleanName(m.name) || PEERS[m.id].name; hudDirty = true; refreshLobby(); }
    } else if (m.t === 'host') {
      HOST_ID = m.id; refreshLobby();
    } else if (m.t === 'signal') {
      onSignalData(m.from, m.data);
    } else if (m.t === 'ice') {
      if (Array.isArray(m.ice)) ICE = m.ice;
    } else if (m.t === 'error') {
      if (m.code === 'level' && m.level) {
        /* the match is on another mission: go there */
        SIG.fatal = true;
        global.location.hash = 'mp=' + ROOM + '&level=' + (m.level | 0);
        global.location.reload();
        return;
      }
      SIG.fatal = true;
      setStatus('err', String(m.msg || 'KATILINAMADI').toLocaleUpperCase('tr-TR'));
      /* already playing (a redeploy happened mid-match): the direct links
         carry on, only newcomers will not find us */
      if (ME.inMatch) { try { subtitle('OYUN GÜNCELLENDİ — BU RAUNT BİTİNCE SAYFAYI YENİLE', 6000); } catch (e) { } }
      else enableJoin(false);
      try { if (SIG.ws) SIG.ws.close(); } catch (e) { }
    }
  }

  /* ================================================================= UI == */
  var UI = { built: false };

  function inviteUrl() {
    var lv = ROUTE_LEVEL;
    return global.location.origin + global.location.pathname + '#mp=' + ROOM + '&level=' + lv + (teamMode() ? '' : '&mode=dm');
  }

  /* the room turned out to be in the other mode: follow it */
  function setMode(mode) {
    MODE = mode === 'dm' ? 'dm' : 'team';
    try {
      var h = global.location.hash.replace(/^#/, '').replace(/(^|&)mode=[^&]*/g, '').replace(/^&/, '');
      history.replaceState(null, '', global.location.pathname + global.location.search + '#' + h + (MODE === 'dm' ? '&mode=dm' : ''));
    } catch (e) { }
    hudDirty = true;
    try { lobbyText(); refreshLobby(); } catch (e) { }
  }

  function enableJoin(on) {
    var b = $('btnStart');
    if (b) { b.disabled = !on; b.style.opacity = on ? '' : '0.5'; }
  }

  function css() {
    if ($('nzNetCss')) return;
    var s = document.createElement('style');
    s.id = 'nzNetCss';
    s.textContent =
      '#nzLobby{margin-top:2.2vh;display:flex;flex-direction:column;align-items:center;gap:1.1vh;width:min(92vw,720px)}' +
      '#nzLobby .row{display:flex;gap:.6vw;align-items:center;justify-content:center;width:100%}' +
      '#nzLobby input{font:inherit;font-size:clamp(11px,1.6vh,17px);letter-spacing:.08em;padding:.9vh 1vw;background:#120802;' +
      'color:#ffdb78;border:1px solid #8a5a1c;outline:none;min-width:0}' +
      '#nzLobby input:focus{border-color:#ffc557}' +
      '#nzLobby #nzLink{flex:1;color:#8fb8ff}' +
      '#nzLobby #nzName{width:16ch;text-transform:uppercase}' +
      '#nzLobby .lbl{font-size:clamp(10px,1.4vh,14px);letter-spacing:.16em;color:#9e8c6b}' +
      '#nzLobby .mini{margin-top:0;padding:.9vh 1.4vw;font-size:clamp(10px,1.4vh,14px)}' +
      '#nzPlayers{display:flex;flex-wrap:wrap;gap:.6vh .8vw;justify-content:center;font-size:clamp(11px,1.5vh,16px);letter-spacing:.1em}' +
      '#nzPlayers .pl{padding:.45vh .8vw;border:1px solid rgba(255,197,74,.35);background:rgba(20,10,3,.7);color:#f0d8a0}' +
      '#nzPlayers .sw,#nzNet .sw{display:inline-block;width:.8em;height:.8em;margin-right:.5em;vertical-align:-.05em;border:1px solid rgba(0,0,0,.6)}' +
      '#nzPlayers .st{color:#7d7566;margin-left:.6em}' +
      '#nzNet{position:absolute;left:max(1.1vw,env(safe-area-inset-left));top:max(1.4vh,env(safe-area-inset-top));' +
      'min-width:15em;padding:.6vh .7vw;background:rgba(10,6,2,.55);border:1px solid rgba(255,197,74,.25);' +
      'font-size:clamp(10px,1.45vh,15px);letter-spacing:.08em;color:#f0d8a0;text-shadow:0 1px 1px #000;pointer-events:none}' +
      '#nzNet .hd{color:#c9a765;font-weight:800;letter-spacing:.16em;margin-bottom:.3vh}' +
      '#nzNet .r{display:flex;gap:.8em;align-items:center;line-height:1.55}' +
      '#nzNet .r .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:11em}' +
      '#nzNet .r .fr{color:#fff;font-weight:800;min-width:1.6em;text-align:right}' +
      '#nzNet .r .pg{color:#8fb8ff;min-width:4.6em;text-align:right}' +
      '#nzNet .r.me .nm{color:#ffdb78}' +
      '#nzNet .r.bad .pg{color:#ff7a62}' +
      '#nzNet .tm{display:flex;gap:.8em;margin-top:.45vh;font-weight:800;letter-spacing:.16em}' +
      '#nzNet .tm .sc{margin-left:auto;color:#fff}' +
      '#nzNet .r.dead{opacity:.45}' +
      '#nzNet .r.dead .nm{text-decoration:line-through}' +
      '#nzLobby .seg{display:flex;gap:.4vw;flex-wrap:wrap;justify-content:center}' +
      '#nzLobby .seg .mini{letter-spacing:.12em}' +
      '#nzLobby .seg .mini.on{background:linear-gradient(180deg,#c9861a,#6a3a06);color:#fff;border-color:#ffe6a8}' +
      '#nzLobby .seg .mini:disabled{opacity:.4}' +
      '#nzLobby .row.pair{gap:1vw;flex-wrap:wrap}' +
      '#nzLobby #nzMapName{color:#ffdb78;font-weight:800;letter-spacing:.18em;font-size:clamp(11px,1.6vh,17px)}' +
      '#nzLobby .nzmaps{margin-top:0}' +
      '#nzSpec{position:absolute;left:0;right:0;bottom:15vh;display:none;text-align:center;pointer-events:none;' +
      'font-size:clamp(12px,2vh,20px);font-weight:800;letter-spacing:.18em;color:#ffdb78;text-shadow:0 2px 2px #000,0 0 8px #000}' +
      '#nzTags{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}' +
      '.nzTag{position:absolute;left:0;top:0;display:none;white-space:nowrap;pointer-events:none;will-change:transform;' +
      'font-size:clamp(9px,1.25vh,13px);font-weight:800;letter-spacing:.1em;text-shadow:0 1px 2px #000,0 0 4px #000}';
    document.head.appendChild(s);
  }

  function buildLobby() {
    if (UI.built) return;
    UI.built = true;
    css();
    var title = $('scTitle');
    if (!title) return;
    var mi = 1;
    try { mi = (typeof LEVEL === 'number') ? LEVEL : 2; } catch (e) { }
    var mname = '';
    try { mname = MISSIONS[mi - 1].name; } catch (e) { mname = 'GÖREV ' + mi; }
    var h2 = title.querySelector('h2');
    if (h2) h2.textContent = 'ÇOK OYUNCULU — ' + mname;
    ['missions', 'skills', 'skilltag', 'btnContinue', 'continueInfo'].forEach(function (id) { var n = $(id); if (n) n.style.display = 'none'; });
    var small = title.querySelector('.small'); if (small) small.textContent = 'ODA ' + ROOM + ' — DAVETİYE BU BAĞLANTI';

    var box = document.createElement('div');
    box.id = 'nzLobby';
    box.innerHTML =
      '<div class="row"><span class="lbl">DAVET BAĞLANTISI</span><input id="nzLink" readonly spellcheck="false">' +
      '<button class="btn mini" id="nzCopy" type="button">KOPYALA</button></div>' +
      '<div class="row"><span class="lbl">ADIN</span><input id="nzName" maxlength="16" spellcheck="false"></div>' +
      '<div class="row pair" id="nzModeRow"><span class="lbl">MOD</span><span class="seg" id="nzModeSeg"></span></div>' +
      '<div class="row" id="nzMapRow"><span class="lbl">HARİTA</span><span id="nzMapName"></span>' +
      '<button class="btn mini" id="nzMapChange" type="button">DEĞİŞTİR</button></div>' +
      '<div class="row pair" id="nzTeamRow"><span class="lbl">TAKIMIN</span><span class="seg" id="nzTeamSeg"></span>' +
      '<span class="lbl">BOTLAR</span><span class="seg" id="nzBotSeg"></span></div>' +
      '<div id="nzPlayers"></div>' +
      '<div class="save-note" id="nzStatus" aria-live="polite"></div>';
    var acts = title.querySelector('.menu-actions');
    title.insertBefore(box, acts || null);
    /* a key pressed on one of these controls is not a title-screen shortcut
       (Enter there starts the game) */
    box.addEventListener('keydown', function (e) { e.stopPropagation(); });
    seg('nzModeSeg', [['team', 'TAKIM ' + TEAM_SIZE + 'v' + TEAM_SIZE + ' + BOT'], ['dm', 'HERKES TEK']], switchMode);
    $('nzMapName').textContent = MAP.name || mname;
    var picker = mapPicker('nzMaps', ROUTE_LEVEL, function (level) {
      if (level === ROUTE_LEVEL) { picker.classList.remove('on'); return; }
      switchMap(level);
    });
    box.insertBefore(picker, $('nzMapRow').nextSibling);
    $('nzMapChange').onclick = function () { picker.classList.toggle('on'); };
    seg('nzTeamSeg', [[-1, 'FARK ETMEZ'], [0, TEAMS[0].name], [1, TEAMS[1].name]], setWant);
    seg('nzBotSeg', [['easy', SKILL_NAMES.easy], ['normal', SKILL_NAMES.normal], ['hard', SKILL_NAMES.hard]], setSkill);
    var link = $('nzLink'); link.value = inviteUrl();
    link.onclick = function () { link.select(); };
    $('nzCopy').onclick = function () {
      var done = function () { $('nzCopy').textContent = 'KOPYALANDI'; setTimeout(function () { $('nzCopy').textContent = 'KOPYALA'; }, 1600); };
      try { navigator.clipboard.writeText(link.value).then(done, function () { link.select(); document.execCommand('copy'); done(); }); }
      catch (e) { link.select(); try { document.execCommand('copy'); done(); } catch (e2) { } }
    };
    var nm = $('nzName'); nm.value = ME.name;
    /* typing a name must not drive the title screen's number-row shortcuts */
    nm.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') nm.blur(); });
    nm.addEventListener('change', function () { setName(nm.value); });
    nm.addEventListener('blur', function () { setName(nm.value); });

    var start = $('btnStart');
    if (start) start.textContent = 'MAÇA KATIL';
    enableJoin(ME.welcomed);
    if (acts) {
      var leave = document.createElement('button');
      leave.className = 'btn'; leave.type = 'button'; leave.id = 'nzLeave';
      leave.textContent = 'TEK OYUNCULU';
      leave.onclick = leaveMatch;
      acts.insertBefore(leave, acts.firstChild);
    }
    /* the pause screen: you are still in the match while it is up */
    var pause = $('scPause');
    if (pause) {
      var sv = $('btnSave'); if (sv) sv.style.display = 'none';
      var pp = pause.querySelector('p');
      if (pp) {
        /* togglePause() writes the single-player difficulty into #pskill on
           every ESC: it has to stay in the page, or ESC throws and the menu
           never opens. It means nothing in a match, so it is only hidden. */
        var psk = $('pskill');
        pp.innerHTML = 'Hâlâ maçtasın &mdash; diğerleri seni görebiliyor.';
        if (psk) { psk.style.display = 'none'; pp.appendChild(psk); }
      }
      var pacts = pause.querySelector('.menu-actions');
      if (pacts) {
        var pl = document.createElement('button');
        pl.className = 'btn'; pl.type = 'button'; pl.textContent = 'MAÇTAN AYRIL'; pl.onclick = leaveMatch;
        pacts.insertBefore(pl, pacts.firstChild);
        /* change sides from the pause screen; it takes effect next round */
        var tb = document.createElement('button');
        tb.className = 'btn'; tb.type = 'button'; tb.id = 'nzTeamBtn';
        tb.onclick = function () { setWant(ME.want === -1 ? 0 : ME.want === 0 ? 1 : -1); };
        pacts.appendChild(tb);
        var bb = document.createElement('button');
        bb.className = 'btn'; bb.type = 'button'; bb.id = 'nzBotBtn';
        bb.onclick = function () { setSkill(SKILL === 'easy' ? 'normal' : SKILL === 'normal' ? 'hard' : 'easy'); };
        pacts.appendChild(bb);
      }
    }
    var hud = document.createElement('div');
    hud.id = 'nzNet';
    var ui = $('ui');
    (ui || document.body).appendChild(hud);
    var spec = document.createElement('div'); spec.id = 'nzSpec';
    var tags = document.createElement('div'); tags.id = 'nzTags';
    /* the tags go in first, so the scoreboard and messages draw over them */
    var host = ui || document.body;
    host.insertBefore(tags, host.firstChild);
    host.appendChild(spec);
    lobbyText();
    refreshLobby();
  }

  /* the words on the title screen that depend on the room's mode */
  function lobbyText() {
    if (!UI.built) return;
    var team = teamMode();
    var brief = $('missionBrief');
    if (brief) {
      brief.innerHTML = team
        ? 'Takım maçı, ' + TEAM_SIZE + '\'ye ' + TEAM_SIZE + '. Boş kalan yerleri botlar doldurur: tek başına da oynayabilirsin.<br>' +
        'Raunt içinde yeniden doğmak yok &mdash; karşı takımın hepsini indiren raundu alır, ilk ' + ROUNDS_TO_WIN + ' raundu alan maçı kazanır.<br>' +
        'Arkadaşını çağırmak için aşağıdaki bağlantıyı gönder: tıklaması yeterli.'
        : 'Ölüm maçı, en fazla ' + ROOM_MAX + ' oyuncu. Aşağıdaki bağlantıyı bir arkadaşına gönder: tıklaması yeterli, maça girer.<br>' +
        'Düşman yok, toplanacak eşya yok &mdash; herkes aynı silahlarla başlar ve öldükten 3 saniye sonra yeniden doğar.';
      if (MAP.rects) brief.innerHTML += ' Maç, polis bariyerleriyle çevrili kavşak ve sokaklarda geçer; A, B ve C bloklarının giriş katlarına girilebilir.';
    }
    var link = $('nzLink'); if (link) link.value = inviteUrl();
    var tr = $('nzTeamRow'); if (tr) tr.style.display = team ? '' : 'none';
    var tb = $('nzTeamBtn'); if (tb) tb.style.display = team ? '' : 'none';
    var bb = $('nzBotBtn'); if (bb) bb.style.display = team ? '' : 'none';
  }

  function seg(id, items, onPick) {
    var box = $(id);
    if (!box) return;
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'btn mini'; b.type = 'button'; b.textContent = it[1];
      b.setAttribute('data-v', String(it[0]));
      b.onclick = function () { onPick(it[0]); };
      box.appendChild(b);
    });
  }
  function segMark(id, v, locked) {
    var box = $(id);
    if (!box) return;
    var bs = box.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute('data-v') === String(v);
      bs[i].classList.toggle('on', on);
      bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      bs[i].disabled = !!locked && !on;
    }
  }
  /* which side you would like; the browser running the match deals it next round */
  function setWant(v) {
    v = (v === 0 || v === 1) ? v : -1;
    if (ME.want === v) return;
    ME.want = v;
    broadcastEvent({ t: 't', w: v });
    refreshLobby();
    if (ME.inMatch) { try { message(v < 0 ? 'TAKIM: FARK ETMEZ' : 'SONRAKİ RAUNT: ' + TEAMS[v].name + ' TAKIM'); } catch (e) { } }
  }
  /* how good the bots are -- it counts on the browser that runs the match */
  function setSkill(v) {
    if (!SKILL_NAMES[v] || skillLocked()) return;
    SKILL = v;
    try { localStorage.setItem(SKILL_KEY, v); } catch (e) { }
    if (isAuth()) {
      ROUND.sk = v;
      try { for (var s in SIMS) NZ.bots.setSkill(SIMS[s], v); } catch (e) { }
      broadcastEvent(roundMsg());
      try { message('BOTLAR: ' + SKILL_NAMES[v]); } catch (e) { }
    }
    refreshLobby();
  }
  /* another browser runs the match, so its bots, its difficulty */
  function skillLocked() { return !!(teamMode() && ROUND.auth && ROUND.auth !== ME.id); }
  /* A room has one mode, so it can only change while nobody else is in it:
     come back into the same room under the other one. */
  function switchMode(v) {
    if (v === MODE || ME.inMatch) return;
    for (var id in PEERS) return;
    try { if (SIG.ws) { SIG.fatal = true; SIG.ws.close(); } } catch (e) { }
    global.location.hash = 'mp=' + ROOM + '&level=' + ROUTE_LEVEL + (v === 'dm' ? '&mode=dm' : '');
    /* give the server a moment to see the old socket go, or the room it
       still holds would hand the old mode straight back */
    setTimeout(function () { global.location.reload(); }, 400);
  }
  /* The map, likewise: alone and not yet in the match, come back into the
     same room under the other mission (a link already sent follows it). */
  function switchMap(level) {
    if (level === ROUTE_LEVEL || ME.inMatch || !mapFor(level)) return;
    for (var id in PEERS) return;
    NET.active = false;
    try { if (SIG.ws) { SIG.fatal = true; SIG.ws.close(); } } catch (e) { }
    global.location.hash = 'mp=' + ROOM + '&level=' + level + (teamMode() ? '' : '&mode=dm');
    setTimeout(function () { global.location.reload(); }, 400);
  }
  function sideColor(team, want, color) {
    if (!teamMode()) return COLORS[color % COLORS.length];
    var s = team >= 0 ? team : want;
    return s >= 0 ? TEAMS[s].color : '#9a9a9a';
  }

  function setName(v) {
    var n = cleanName(String(v || '').toLocaleUpperCase('tr-TR'));
    if (!n || n === ME.name) { var f = $('nzName'); if (f) f.value = ME.name; return; }
    ME.name = n;
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { }
    sigSend({ t: 'name', name: n });
    broadcastEvent({ t: 'n', name: n });
    hudDirty = true; refreshLobby();
  }

  function leaveMatch() {
    NET.active = false;
    try { if (SIG.ws) { SIG.fatal = true; SIG.ws.close(); } } catch (e) { }
    for (var id in PEERS) closePC(PEERS[id]);
    global.location.href = global.location.pathname + '#level=' + ((typeof LEVEL === 'number') ? LEVEL : 2);
    global.location.reload();
  }

  function routeLabel(pr) {
    if (pr.open) return (pr.route === 'relay' ? 'AKTARMALI' : 'DOĞRUDAN') + (pr.rtt ? ' ' + Math.round(pr.rtt * 1000) + ' MS' : '');
    if (pr.conn === 'failed') return pr.retries < 3 && pr.offerer ? 'YENİDEN DENENİYOR…' : 'BAĞLANTI YOK';
    return 'BAĞLANIYOR…';
  }

  function refreshLobby() {
    if (!UI.built) return;
    var box = $('nzPlayers');
    if (box) {
      var html = '<span class="pl"><span class="sw" style="background:' + sideColor(ME.team, ME.want, ME.color) + '"></span>' + esc(ME.name) +
        '<span class="st">SEN' + (HOST_ID === ME.id ? ' · KURUCU' : '') + '</span></span>';
      for (var id in PEERS) {
        var pr = PEERS[id];
        html += '<span class="pl"><span class="sw" style="background:' + sideColor(pr.team, pr.want, pr.color) + '"></span>' + esc(pr.name) +
          '<span class="st">' + esc(routeLabel(pr)) + '</span></span>';
      }
      box.innerHTML = html;
    }
    var st = $('nzStatus');
    if (st) {
      var n = peerCount();
      var anyFail = false;
      for (var k in PEERS) if (PEERS[k].conn === 'failed' && !(PEERS[k].retries < 3 && PEERS[k].offerer)) anyFail = true;
      var msg = SIG.msg ||
        (anyFail ? 'BİR OYUNCUYA DOĞRUDAN ULAŞILAMADI. SUNUCUNUN BİR AKTARMA (RELAY) SUNUCUSUNA İHTİYACI VAR (MULTIPLAYER.MD DOSYASINA BAK).' :
          n ? 'ODADA ' + (n + 1) + ' OYUNCU VAR' :
            teamMode() ? 'BOTLAR HAZIR — TEK BAŞINA DA BAŞLAYABİLİRSİN. ARKADAŞIN İÇİN BAĞLANTIYI GÖNDER.' :
              'ARKADAŞIN BEKLENİYOR — ONA BAĞLANTIYI GÖNDER. ŞİMDİ KATILIP ISINABİLİRSİN.');
      st.textContent = msg;
      st.className = 'save-note' + (SIG.status === 'err' || anyFail ? ' err' : SIG.status === 'ok' ? ' ok' : '');
    }
    var others = false;
    for (var q in PEERS) { others = true; break; }
    segMark('nzModeSeg', MODE, others || ME.inMatch);
    var chg = $('nzMapChange');
    if (chg) chg.style.display = (others || ME.inMatch) ? 'none' : '';
    if (others || ME.inMatch) { var pk = $('nzMaps'); if (pk) pk.classList.remove('on'); }
    segMark('nzTeamSeg', ME.want, false);
    var lock = skillLocked(), sk = lock ? ROUND.sk : SKILL;
    segMark('nzBotSeg', sk, lock);
    var tb = $('nzTeamBtn');
    if (tb) tb.textContent = 'TAKIM: ' + (ME.want < 0 ? 'FARK ETMEZ' : TEAMS[ME.want].name);
    var bb = $('nzBotBtn');
    if (bb) { bb.textContent = 'BOTLAR: ' + SKILL_NAMES[sk]; bb.disabled = lock; }
  }

  function drawHud() {
    hudDirty = false;
    var hud = $('nzNet');
    if (!hud) return;
    if (teamMode()) { hud.innerHTML = teamHud(); return; }
    var rows = [{ me: true, name: ME.name, color: ME.color, frags: ME.frags, deaths: ME.deaths, ping: '', bad: false }];
    for (var id in PEERS) {
      var pr = PEERS[id];
      var stale = nowS() - pr.lastRecv > 2.5;
      rows.push({
        me: false, name: pr.name, color: pr.color, frags: pr.frags, deaths: pr.deaths,
        ping: pr.open ? (stale ? 'KOPTU' : (pr.rtt ? Math.round(pr.rtt * 1000) + 'MS' : '…') + (pr.route === 'relay' ? ' R' : '')) : routeLabel(pr),
        bad: !pr.open || stale || pr.rtt > 0.15
      });
    }
    rows.sort(function (a, b) { return b.frags - a.frags || a.deaths - b.deaths; });
    var html = '<div class="hd">ODA ' + esc(ROOM) + ' · ÖLÜM MAÇI</div>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<div class="r' + (r.me ? ' me' : '') + (r.bad ? ' bad' : '') + '"><span class="sw" style="background:' + COLORS[r.color % COLORS.length] + '"></span>' +
        '<span class="nm">' + esc(r.name) + '</span><span class="fr">' + r.frags + '</span><span class="pg">' + esc(r.me ? 'SEN' : r.ping) + '</span></div>';
    }
    hud.innerHTML = html;
  }

  /* the team match: round and clock, then each side with its score and people */
  function teamHud() {
    var t = nowS(), clock = '', i, tm;
    if (ROUND.ph === 'live') {
      var left = Math.max(0, Math.ceil(ROUND.endsAt - t));
      clock = ' · ' + Math.floor(left / 60) + ':' + (left % 60 < 10 ? '0' : '') + (left % 60);
    }
    var html = '<div class="hd">ODA ' + esc(ROOM) + ' · ' + (ROUND.ro.length ? 'RAUNT ' + ROUND.n + clock : 'TAKIM MAÇI') + '</div>';
    if (!ROUND.ro.length) return html;
    for (tm = 0; tm < 2; tm++) {
      html += '<div class="tm" style="color:' + TEAMS[tm].tag + '"><span>' + TEAMS[tm].name + '</span><span class="sc">' + ROUND.sc[tm] + '</span></div>';
      for (i = 0; i < ROUND.ro.length; i++) {
        var r = ROUND.ro[i];
        if (r.team !== tm) continue;
        var me = r.id === ME.id, a = actorOf(r.id), pr = (!me && !r.bot) ? PEERS[r.id] : null;
        var stale = !!pr && t - pr.lastRecv > 2.5;
        var tail = me ? 'SEN' : r.bot ? 'BOT' : !pr ? 'AYRILDI' :
          pr.open ? (stale ? 'KOPTU' : (pr.rtt ? Math.round(pr.rtt * 1000) + 'MS' : '…') + (pr.route === 'relay' ? ' R' : '')) : routeLabel(pr);
        var bad = !!pr && (!pr.open || stale || pr.rtt > 0.15);
        html += '<div class="r' + (me ? ' me' : '') + (bad ? ' bad' : '') + (r.dead ? ' dead' : '') + '">' +
          '<span class="sw" style="background:' + TEAMS[tm].color + '"></span>' +
          '<span class="nm">' + esc(nameOf(r.id)) + '</span><span class="fr">' + (a ? a.frags : 0) + '</span><span class="pg">' + esc(tail) + '</span></div>';
      }
    }
    return html;
  }

  /* The handshake starts now, while the level is still loading, so the
     direct connections are usually up before the title screen is. Figures
     wait for 'ready' (nz-hero builds them from the weapon models). */
  var READY = false;
  NZ.on('ready', function () {
    READY = true;
    ME.readyT = nowS();
    try { buildLobby(); } catch (err) { netError(err, 'lobby'); }
  });
  try { sigConnect(); } catch (err) { netError(err, 'connect'); }

  global.addEventListener('beforeunload', function () {
    try { if (SIG.ws) { SIG.fatal = true; SIG.ws.close(); } } catch (e) { }
    for (var id in PEERS) closePC(PEERS[id]);
  });

  /* ---------------------------------------------------- debug / tests -- */
  NET.me = function () {
    return {
      id: ME.id, name: ME.name, color: ME.color, inMatch: ME.inMatch, frags: ME.frags, deaths: ME.deaths, life: ME.life, welcomed: ME.welcomed,
      team: ME.team, want: ME.want, spec: ME.spec, j: ME.j
    };
  };
  NET.peers = function () {
    var out = [];
    for (var id in PEERS) {
      var pr = PEERS[id], P = pr.av ? pr.av.P : null;
      out.push({
        id: id, name: pr.name, open: pr.open, conn: pr.conn, route: pr.route, rtt: pr.rtt, frags: pr.frags, deaths: pr.deaths,
        shown: pr.shown, snaps: pr.snaps.length, hp: pr.hp, late: pr.late, gap: pr.gap, team: pr.team, inMatch: pr.inMatch,
        pos: P ? { x: P.x, y: P.y, z: P.z, yaw: P.yaw, alive: P.alive, eyeH: P.eyeH } : null,
        puppet: !!(pr.av && pr.av.root)
      });
    }
    return out;
  };
  NET.spawnPoints = function () { return SPAWN_PTS.slice(); };
  NET.map = function () {
    return { level: MAP.level, name: MAP.name, fenced: !!AR,
             cover: Object.keys(COVER).map(function (k) { return k.split(',').map(Number); }) };
  };
  NET.arena = function () {
    var n = 0;
    if (AR) for (var i = 0; i < AR.length; i++) n += AR[i];
    return { fenced: !!AR, cells: n, fenceRuns: FENCE.runs, fence: FENCE.list.slice(), pulledBack: ME.fenced };
  };
  NET.inArena = function (x, z) { return arenaIn(Math.floor(x / CELL), Math.floor(z / CELL)); };
  NET.gfx = function () {
    var st = null; try { st = NZ.render && NZ.render.stats; } catch (e) { }
    var ratio = 0; try { ratio = renderer.getPixelRatio(); } catch (e) { }
    return { off: GOV.off, step: GOV.step, steps: GOV.steps ? GOV.steps.slice() : null, locked: GOV.locked, last: GOV.last, frameMs: GOV.med,
      dprCap: NZ.dprCap || null, ratio: ratio, scale: st ? st.scale : null, degrade: st ? st.degrade : null, ladderLocked: st ? st.locked : null };
  };
  /* tests: drive the governor with n frames of `ms` each, in its own time */
  NET.govFeed = function (ms, n) {
    GOV.fed = true; GOV.fakeT = GOV.fakeT || nowS();
    for (var i = 0; i < (n | 0); i++) { GOV.fakeT += ms / 1000; govSample(ms, GOV.fakeT); }
    return NET.gfx();
  };
  NET.damage = function () { return { replayed: ME.replayed, snapshotsIn: ME.snapsIn, waiting: LATE.fires.length + (LATE.snap ? LATE.snap.length : 0) }; };
  NET.status = function () { return { status: SIG.status, msg: SIG.msg, host: HOST_ID, max: ROOM_MAX, errors: ERR }; };
  NET.peerHitParts = function (id) { var pr = PEERS[id] || BOTS[id]; return pr && pr.av ? pr.av.hitParts([]).map(function (p) { return Object.assign({}, p); }) : []; };
  NET.mode = function () { return MODE; };
  NET.round = function () {
    var t = nowS();
    return {
      auth: ROUND.auth, mine: isAuth(), q: ROUND.q, n: ROUND.n, ph: ROUND.ph, sc: ROUND.sc.slice(), win: ROUND.win, skill: SKILL, sk: ROUND.sk,
      left: Math.max(0, (ROUND.ph === 'live' ? ROUND.endsAt : ROUND.nextAt) - t),
      ro: ROUND.ro.map(function (r) { return { id: r.id, team: r.team, bot: r.bot, name: nameOf(r.id), dead: !!r.dead, sp: r.sp }; })
    };
  };
  NET.bots = function () {
    var out = [];
    for (var id in BOTS) {
      var e = BOTS[id], sim = SIMS[e.slot], P = e.av ? e.av.P : null;
      out.push({
        id: id, slot: e.slot, name: e.name, team: e.team, hp: e.hp, frags: e.frags, deaths: e.deaths, shown: e.shown, here: !!sim,
        puppet: !!(e.av && e.av.root), snaps: e.snaps.length,
        pos: P ? { x: P.x, y: P.y, z: P.z, yaw: P.yaw, alive: P.alive } : null,
        sim: sim ? { x: sim.x, y: sim.y, z: sim.z, hp: sim.hp, alive: sim.alive, tgt: sim.tgt, vis: sim.vis, shots: sim.shots, stuck: sim.stuck } : null
      });
    }
    return out;
  };
  NET.watching = function () { return SPEC.on ? SPEC.id : null; };
  /* the live brain of a bot this browser runs (tests freeze or shield one) */
  NET.botSim = function (id) { var e = BOTS[id]; return e ? SIMS[e.slot] || null : null; };
  NET.setTeam = function (v) { setWant(v); };
  NET.setSkill = function (v) { setSkill(v); };
  /* tests shorten the clock */
  NET.tune = function (o) {
    o = o || {};
    if (o.roundTime > 0) ROUND_TIME = o.roundTime;
    if (o.roundGap > 0) ROUND_GAP = o.roundGap;
    if (o.matchGap > 0) MATCH_GAP = o.matchGap;
    if (o.toWin > 0) ROUNDS_TO_WIN = o.toWin | 0;
    return { roundTime: ROUND_TIME, roundGap: ROUND_GAP, matchGap: MATCH_GAP, toWin: ROUNDS_TO_WIN };
  };
})(typeof window !== 'undefined' ? window : this);
