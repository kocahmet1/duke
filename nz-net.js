/* ===========================================================================
   NZ-NET  --  multiplayer deathmatch, browser to browser.

   Open the game with  #mp=ROOM  in the address and it becomes a deathmatch
   room. Without it this file adds one MULTIPLAYER button to the title screen
   and nothing else: single player is untouched.

   HOW THE PLAYERS TALK
     The game server (server/mp-server.mjs) only introduces the browsers: a
     WebSocket at /signal passes the few setup messages WebRTC needs. Then
     every pair of players is connected DIRECTLY (a full mesh), over two data
     channels each:

       's'  unordered, no resends    state every frame, pings, gunfire
       'e'  reliable, in order       hits, deaths, names, hello

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

   THE MATCH (v1)
     All enemies, pickups and lifts are switched off; normal doors start
     open, secret and key doors stay shut. Everyone spawns with the same
     hitscan arsenal (no RPG, grenades or NULLSTAR yet) and respawns 3 s after
     dying, at the spawn point farthest from the other players.

   CONTRACT WITH THE REST OF THE GAME
     Wraps, only in a multiplayer room: spawnEnemy, makePickup, updateLifts,
     useAction, winLevel, saveManualGame, killPlayer, fire, hitscan,
     startGame, placeEntities. Reads player, WPN, state, D, AMMOMAX, DOORS,
     LEVEL by name (top-level script bindings). 'render' hook at priority
     40, ahead of nz-hero's figures (20 and 19).
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;

  var PROTO = 1;                 /* must equal PROTO in server/mp-server.mjs */
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

  /* =====================================================================
     NOT A MULTIPLAYER ROOM: one button on the title screen, nothing else.
     ================================================================== */
  var roomParam = routeParam('mp');
  if (roomParam === null) {
    NZ.on('ready', function () {
      try {
        var acts = document.querySelector('#scTitle .menu-actions');
        if (!acts || $('btnMulti')) return;
        var b = document.createElement('button');
        b.className = 'btn'; b.id = 'btnMulti'; b.type = 'button';
        b.textContent = 'ÇOK OYUNCULU';
        b.onclick = function () {
          if (global.location.protocol === 'file:') {
            var info = $('continueInfo');
            if (info) { info.textContent = 'ÇOK OYUNCULU İÇİN OYUN SUNUCUSU GEREKLİ — npm run mp KOMUTUNU ÇALIŞTIR VE YAZDIĞI ADRESİ AÇ'; info.className = 'save-note err'; }
            return;
          }
          global.location.hash = 'mp=' + randomCode(5) + '&level=2';
          global.location.reload();
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

  var ME = {
    id: randomId(), name: '', color: 0, welcomed: false, inMatch: false,
    life: 0, frags: 0, deaths: 0, respawnAt: 0, lastSpawn: -1, seq: 0, sendT: 0, pingT: 0, hudT: 0
  };
  try { ME.name = cleanName(localStorage.getItem(NAME_KEY)) || ''; } catch (e) { }
  if (!ME.name) ME.name = 'OYUNCU ' + (10 + Math.floor(Math.random() * 90));

  var PEERS = {};                /* id -> peer */
  var ICE = [];
  var ROOM_MAX = 4, HOST_ID = null;
  var SPAWN_CELLS = [], SPAWN_PTS = [];
  var PENDING_KILLER = null;     /* who is shooting while hurtPlayer runs        */
  var SHOT = { active: false, rays: [], dmg: {}, w: 0 };
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
      SHOT.active = true; SHOT.rays.length = 0; SHOT.dmg = {}; SHOT.w = player.weapon;
      try { return orig.apply(this, arguments); }
      finally {
        SHOT.active = false;
        try { if (SHOT.rays.length) { sendFire(SHOT.w, SHOT.rays); flushHits(SHOT.w); } }
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
      if (SHOT.active && SHOT.rays.length < 12) SHOT.rays.push([org.x + dir.x * t, org.y + dir.y * t, org.z + dir.z * t, hit ? 1 : 0]);
      if (!hit) return orig.apply(this, arguments);
      try { hitPeer(hit, org, dir, dmg); } catch (err) { netError(err, 'hitPeer'); }
    };
  });

  /* ------------------------------------------------------ level set-up -- */
  function afterPlace() {
    /* Enemy positions are where the level designer put fights: good spawn
       points, spread over every tier. The single-player start joins them. */
    var pts = [], used = {};
    var add = function (gx, gy, yaw) {
      var k = gx + ',' + gy;
      if (used[k]) return;
      used[k] = 1;
      try { if (typeof liftAt === 'function' && liftAt(gx, gy)) return; } catch (e) { }
      var y = 0;
      try { y = floorAt(gx, gy); } catch (e) { }
      pts.push({ x: gx * CELL + CELL / 2, y: fin(y), z: gy * CELL + CELL / 2, yaw: yaw });
    };
    for (var i = 0; i < SPAWN_CELLS.length; i++) add(SPAWN_CELLS[i][0], SPAWN_CELLS[i][1], null);
    add(Math.floor(player.x / CELL), Math.floor(player.z / CELL), player.yaw);
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
        var free = 0;
        try { free = castWall(org, dir, 120); } catch (e) { free = 0; }
        var score = Math.min(free, 120) + 6 * Math.cos(angWrap(yaw - toMid));
        if (score > bestScore) { bestScore = score; bestYaw = yaw; }
      }
      p.yaw = bestYaw;
    }
    SPAWN_PTS = pts;
    /* Doors: open the ordinary ones for good, leave secrets and the key door
       shut (useAction is off, so nobody can open them on one screen only). */
    try {
      for (var d = 0; d < DOORS.length; d++) {
        var dr = DOORS[d];
        if (dr.secret || dr.kind === 'key') continue;
        dr.tgt = 1; dr.used = true;
      }
      updateDoors(10);
    } catch (err) { netError(err, 'doors'); }
  }

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

  function respawn() {
    var sp = pickSpawn();
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
    ME.respawnAt = nowS() + RESPAWN_DELAY;
    broadcastEvent({ t: 'd', by: k ? k.id : '', w: k ? k.w : -1, hd: k && k.head ? 1 : 0 });
    noteDeath(ME.id, k ? k.id : '', k ? k.w : -1, !!(k && k.head));
    try { sfx('dead'); } catch (e) { }
    var who = k && PEERS[k.id] ? PEERS[k.id].name : null;
    subtitle((who ? 'SENİ İNDİREN: ' + who : 'ÖLDÜN') + ' — ' + RESPAWN_DELAY + ' SN SONRA GERİ DÖNÜYORSUN', RESPAWN_DELAY * 1000);
    sendStateNow();
  }

  function nameOf(id) {
    if (id === ME.id) return ME.name;
    return PEERS[id] ? PEERS[id].name : 'BİRİ';
  }

  /* Every browser runs this for every death it hears about, its own included,
     so every scoreboard agrees. */
  function noteDeath(victim, killer, w, head) {
    if (victim === ME.id) ME.deaths++;
    else if (PEERS[victim]) PEERS[victim].deaths++;
    var fragger = killer && killer !== victim ? killer : null;
    if (fragger === ME.id) ME.frags++;
    else if (fragger && PEERS[fragger]) PEERS[fragger].frags++;
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

  var PARTS = [];
  function rayPeers(org, dir, maxT) {
    var best = null;
    var dl = Math.hypot(dir.x, dir.y, dir.z) || 1, dx = dir.x / dl, dy = dir.y / dl, dz = dir.z / dl;
    for (var id in PEERS) {
      var pr = PEERS[id], av = pr.av;
      if (!av || !pr.shown || !av.P.alive) continue;
      /* broad phase: anywhere near the line at all */
      var P = av.P, cx = P.x - org.x, cy = P.y + 3 - org.y, cz = P.z - org.z;
      var along = cx * dx + cy * dy + cz * dz;
      if (along < -6 || along > maxT + 6) continue;
      var ox = cx - dx * along, oy = cy - dy * along, oz = cz - dz * along;
      if (ox * ox + oy * oy + oz * oz > 64) continue;
      var parts = av.hitParts(PARTS);
      for (var i = 0; i < parts.length; i++) {
        var t = rayCapsule(org.x, org.y, org.z, dx, dy, dz, parts[i]);
        if (t > 0.3 && t < maxT && (!best || t < best.t)) best = { peer: pr, t: t, zone: parts[i].zone };
      }
    }
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
      var pr = PEERS[id];
      if (pr) sendHit(pr, SHOT.dmg[id].d, SHOT.dmg[id].head, w);
    }
    SHOT.dmg = {};
  }

  function sendHit(pr, d, head, w) {
    sendEvent(pr, { t: 'h', d: Math.round(d * 10) / 10, hd: head ? 1 : 0, w: w, sx: Math.round(player.x * 100) / 100, sz: Math.round(player.z * 100) / 100 });
  }

  /* someone hit us */
  function onHit(pr, m) {
    if (!ME.inMatch || !player.alive || player.invT > 0) return;
    var d = clamp(fin(m.d), 0, 400);
    if (!(d > 0)) return;
    PENDING_KILLER = { id: pr.id, w: fin(m.w, 0) | 0, head: !!m.hd };
    var scale = 1;
    try { scale = (D && D.dmg > 0) ? D.dmg : 1; } catch (e) { }
    try { hurtPlayer(d / scale, fin(m.sx, player.x), fin(m.sz, player.z)); }
    finally { PENDING_KILLER = null; }
    sendStateNow();
  }

  /* ================================================== remote gunfire == */
  function sendFire(w, rays) {
    var e = [];
    for (var i = 0; i < rays.length; i++) e.push([Math.round(rays[i][0] * 100) / 100, Math.round(rays[i][1] * 100) / 100, Math.round(rays[i][2] * 100) / 100, rays[i][3]]);
    var q = 0;
    try { q = player.suppressed && WPN[w] && WPN[w].canSuppress ? 1 : 0; } catch (x) { }
    broadcastState(JSON.stringify({ t: 'f', w: w, q: q, e: e }));
  }

  var _v1 = null, _v2 = null;
  function onFire(pr, m) {
    var av = pr.av;
    if (!av || !pr.shown) return;
    var W = null;
    try { W = WPN[m.w | 0]; } catch (e) { }
    if (!W) return;
    av.shot();
    try { sfx(m.q ? 'rifleq' : W.snd, av.P.x, av.P.z); } catch (e) { }
    if (!_v1) { _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }
    var mz = av.muzzle();
    var ox = mz ? mz.x : av.P.x, oy = mz ? mz.y : av.P.y + av.P.eyeH - 0.3, oz = mz ? mz.z : av.P.z;
    var ends = Array.isArray(m.e) ? m.e : [];
    for (var i = 0; i < ends.length && i < 12; i++) {
      var e2 = ends[i];
      if (!Array.isArray(e2) || e2.length < 3) continue;
      var ex = fin(e2[0]), ey = fin(e2[1]), ez = fin(e2[2]);
      if (i < 4) { try { tracer(ox, oy, oz, ex, ey, ez, 1.0, 0.78, 0.42, 0.06); } catch (e) { } }
      /* the puff where it landed, unless it landed in a player */
      if (!e2[3]) {
        try {
          _v1.set(ex, ey, ez); _v2.set(ex - ox, ey - oy, ez - oz).normalize();
          var surf = impactSurface(_v1, _v2);
          impactPuff(_v1.clone(), _v2.clone(), surf && surf.kind ? surf.kind : 'concrete');
        } catch (e) { }
      }
    }
  }

  /* ============================================================ avatars == */
  /* The real figure from nz-hero.js, or a plain capsule if that module is
     unavailable. Both offer the same small surface. */
  function makeAvatar(pr) {
    var col = COLORS[pr.color % COLORS.length];
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
      frags: 0, deaths: 0, hp: 100, av: null, shown: false, life: -1, saidHi: false, joinedAt: nowS()
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
    sendEvent(pr, { t: 'hi', name: ME.name, color: ME.color, frags: ME.frags, deaths: ME.deaths, proto: PROTO });
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
    if (typeof data !== 'string' || data.length > 8192) return;
    var m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hi') {
      var first = !pr.saidHi;
      pr.saidHi = true;
      if (typeof m.name === 'string') pr.name = cleanName(m.name) || pr.name;
      if (typeof m.color === 'number') pr.color = m.color | 0;
      pr.frags = Math.max(0, fin(m.frags) | 0); pr.deaths = Math.max(0, fin(m.deaths) | 0);
      if (first) { try { message(pr.name + ' KATILDI'); } catch (e) { } }
      hudDirty = true; refreshLobby();
    } else if (m.t === 'h') onHit(pr, m);
    else if (m.t === 'd') noteDeath(pr.id, typeof m.by === 'string' ? m.by : '', fin(m.w, -1), !!m.hd);
    else if (m.t === 'n') { pr.name = cleanName(m.name) || pr.name; hudDirty = true; refreshLobby(); }
  }

  /* binary state, pings, and the gunfire JSON all ride the fast channel */
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
    if (type !== 1 || data.byteLength < 48) return;
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
    if (ME.inMatch) f |= 32;
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
    var want = !!(s && (s.flags & 32) && pr.open);
    if (want && !pr.av && READY) pr.av = makeAvatar(pr);
    if (!pr.av) return;
    if (!want) { if (pr.shown) { pr.av.setVisible(false); pr.shown = false; } return; }
    var P = pr.av.P;
    if (pr.life !== s.life) { pr.life = s.life; pr.av.teleported(); }
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
      if (t - ME.sendT >= SEND_MIN) sendStateNow();
      if (!player.alive && ME.respawnAt && t >= ME.respawnAt) respawn();
    }
    if (t - ME.pingT >= PING_EVERY) { ME.pingT = t; pingAll(); }
    for (var id in PEERS) {
      var pr = PEERS[id];
      if (pr.sigGone && (!pr.open || t - pr.lastRecv > STALE_AFTER)) { removePeer(id); continue; }
      if (pr.retryT && t >= pr.retryT) { pr.retryT = 0; startOffer(pr); }
      updateAvatar(pr, dt, t);
    }
    if (t - ME.hudT > 0.25 || hudDirty) { ME.hudT = t; drawHud(); }
  }

  /* a hidden tab gets no animation frames: keep saying we are here */
  setInterval(function () {
    if (!NET.active || !document.hidden) return;
    try { if (ME.inMatch) sendStateNow(); pingAll(); } catch (e) { }
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
      sigSend({ t: 'join', room: ROOM, id: ME.id, name: ME.name, proto: PROTO, build: BUILD, level: ROUTE_LEVEL });
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
    return global.location.origin + global.location.pathname + '#mp=' + ROOM + '&level=' + lv;
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
      '#nzNet .r.bad .pg{color:#ff7a62}';
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
    var brief = $('missionBrief');
    if (brief) brief.innerHTML = 'Ölüm maçı, en fazla ' + ROOM_MAX + ' oyuncu. Aşağıdaki bağlantıyı bir arkadaşına gönder: tıklaması yeterli, maça girer.<br>' +
      'Düşman yok, toplanacak eşya yok &mdash; herkes aynı silahlarla başlar ve öldükten 3 saniye sonra yeniden doğar.';
    ['missions', 'skills', 'skilltag', 'btnContinue', 'continueInfo'].forEach(function (id) { var n = $(id); if (n) n.style.display = 'none'; });
    var small = title.querySelector('.small'); if (small) small.textContent = 'ODA ' + ROOM + ' — DAVETİYE BU BAĞLANTI';

    var box = document.createElement('div');
    box.id = 'nzLobby';
    box.innerHTML =
      '<div class="row"><span class="lbl">DAVET BAĞLANTISI</span><input id="nzLink" readonly spellcheck="false">' +
      '<button class="btn mini" id="nzCopy" type="button">KOPYALA</button></div>' +
      '<div class="row"><span class="lbl">ADIN</span><input id="nzName" maxlength="16" spellcheck="false"></div>' +
      '<div id="nzPlayers"></div>' +
      '<div class="save-note" id="nzStatus" aria-live="polite"></div>';
    var acts = title.querySelector('.menu-actions');
    title.insertBefore(box, acts || null);
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
      if (pp) pp.innerHTML = 'Hâlâ maçtasın &mdash; diğerleri seni görebiliyor.';
      var pacts = pause.querySelector('.menu-actions');
      if (pacts) {
        var pl = document.createElement('button');
        pl.className = 'btn'; pl.type = 'button'; pl.textContent = 'MAÇTAN AYRIL'; pl.onclick = leaveMatch;
        pacts.insertBefore(pl, pacts.firstChild);
      }
    }
    var hud = document.createElement('div');
    hud.id = 'nzNet';
    var ui = $('ui');
    (ui || document.body).appendChild(hud);
    refreshLobby();
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
      var html = '<span class="pl"><span class="sw" style="background:' + COLORS[ME.color % COLORS.length] + '"></span>' + esc(ME.name) +
        '<span class="st">SEN' + (HOST_ID === ME.id ? ' · KURUCU' : '') + '</span></span>';
      for (var id in PEERS) {
        var pr = PEERS[id];
        html += '<span class="pl"><span class="sw" style="background:' + COLORS[pr.color % COLORS.length] + '"></span>' + esc(pr.name) +
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
          n ? 'ODADA ' + (n + 1) + ' OYUNCU VAR' : 'ARKADAŞIN BEKLENİYOR — ONA BAĞLANTIYI GÖNDER. ŞİMDİ KATILIP ISINABİLİRSİN.');
      st.textContent = msg;
      st.className = 'save-note' + (SIG.status === 'err' || anyFail ? ' err' : SIG.status === 'ok' ? ' ok' : '');
    }
  }

  function drawHud() {
    hudDirty = false;
    var hud = $('nzNet');
    if (!hud) return;
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

  /* The handshake starts now, while the level is still loading, so the
     direct connections are usually up before the title screen is. Figures
     wait for 'ready' (nz-hero builds them from the weapon models). */
  var READY = false;
  NZ.on('ready', function () {
    READY = true;
    try { buildLobby(); } catch (err) { netError(err, 'lobby'); }
  });
  try { sigConnect(); } catch (err) { netError(err, 'connect'); }

  global.addEventListener('beforeunload', function () {
    try { if (SIG.ws) { SIG.fatal = true; SIG.ws.close(); } } catch (e) { }
    for (var id in PEERS) closePC(PEERS[id]);
  });

  /* ---------------------------------------------------- debug / tests -- */
  NET.me = function () {
    return { id: ME.id, name: ME.name, color: ME.color, inMatch: ME.inMatch, frags: ME.frags, deaths: ME.deaths, life: ME.life, welcomed: ME.welcomed };
  };
  NET.peers = function () {
    var out = [];
    for (var id in PEERS) {
      var pr = PEERS[id], P = pr.av ? pr.av.P : null;
      out.push({
        id: id, name: pr.name, open: pr.open, conn: pr.conn, route: pr.route, rtt: pr.rtt, frags: pr.frags, deaths: pr.deaths,
        shown: pr.shown, snaps: pr.snaps.length, hp: pr.hp, late: pr.late, gap: pr.gap,
        pos: P ? { x: P.x, y: P.y, z: P.z, yaw: P.yaw, alive: P.alive, eyeH: P.eyeH } : null,
        puppet: !!(pr.av && pr.av.root)
      });
    }
    return out;
  };
  NET.spawnPoints = function () { return SPAWN_PTS.slice(); };
  NET.status = function () { return { status: SIG.status, msg: SIG.msg, host: HOST_ID, max: ROOM_MAX, errors: ERR }; };
  NET.peerHitParts = function (id) { var pr = PEERS[id]; return pr && pr.av ? pr.av.hitParts([]).map(function (p) { return Object.assign({}, p); }) : []; };
})(typeof window !== 'undefined' ? window : this);
