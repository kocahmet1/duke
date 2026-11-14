/* ===========================================================================
   NZ-BOTS  --  the computer-controlled players of a multiplayer team match.

   nz-net.js owns the match: who is on which side, the rounds, the network,
   and how a bot is drawn (the same third-person figure as a human player).
   This file is only the brain. One browser in the room runs it -- the one
   nz-net.js picks -- and broadcasts each bot as if it were a player, so
   every screen sees the same bots.

     var b = NZ.bots.create({ slot: 0, team: 0, weapon: 6, skill: 'normal' });
     NZ.bots.spawn(b, { x, y, z, yaw }, now);
     NZ.bots.step(b, dt, { now, foes, mates, fire });        every frame
     NZ.bots.hurt(b, damage, byId, fromX, fromZ, now);

   foes / mates are plain lists of { id, x, y, z, eyeH, vx, vz, alive,
   firedAgo }. fire(bot, origin, direction, weapon) is called once for every
   round a bot fires; nz-net.js decides what the round hit.

   WHAT A BOT DOES
     Nobody in sight: it walks the level's nav grid (NAV in NUKEM.html, the
     grid the single-player enemies use) to where it last saw or heard an
     enemy, and failing that toward a rough fix on the nearest one, taken
     again every few seconds. That last part is on purpose: a round ends
     when one side is gone, so nobody can hide from a bot for ever -- but
     the fix is old and a few metres out, so a flank can work for a while.
     Somebody in sight: after a reaction delay it turns onto him and fires
     bursts while side-stepping. What it aims at is a point that wanders
     round the target -- wide at first, tighter the longer it keeps him in
     view; a moving target, its own movement and being hit widen it again.
     The three skill levels change those numbers and nothing else.

   Lifts never move in a match and the stairs reach every tier, so a path
   skips any lift car that is not level with the floor beside it.

   Reads from NUKEM.html by name: NAV, liftOf, WPN, CELL, MW, MH, CLIMB,
   PRAD, GRAV, EYE, moveSlide, highestFloor, shotLineClear.

   A map that is a fenced corner of a mission (ABLUKA) hands its arena in
   through NZ.bots.setAllow(fn): fn(cell index) is true for a cell in play,
   and no path, short cut or standing spot leaves those cells.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ) return;

  /* react   seconds between seeing a new enemy and the first round
     sig0/1  aim wander in radians: on first sight / once settled on him
     turn    how fast it can swing the gun, radians a second
     burst   rounds in a burst; rest: seconds between bursts
     dmg     damage multiplier; speed: run speed (a player runs at 21)
     fov     half-angle it notices things in; head: how often it goes for the head */
  var SKILLS = {
    easy: { key: 'easy', react: 0.75, sig0: 0.064, sig1: 0.032, turn: 4.6, burst: [2, 4], rest: [0.55, 1.05], dmg: 0.8, speed: 17.5, fov: 1.25, head: 0.04 },
    normal: { key: 'normal', react: 0.44, sig0: 0.038, sig1: 0.016, turn: 7.0, burst: [3, 6], rest: [0.30, 0.65], dmg: 1.0, speed: 19.5, fov: 1.65, head: 0.14 },
    hard: { key: 'hard', react: 0.27, sig0: 0.024, sig1: 0.009, turn: 10.0, burst: [4, 8], rest: [0.16, 0.42], dmg: 1.0, speed: 21.0, fov: 2.0, head: 0.34 }
  };
  var SIGHT = 240;               /* how far it can pick a man out, world units   */
  var HEAR = 150;                /* how far a gunshot turns its head             */

  var B = NZ.bots = { SKILLS: SKILLS };

  /* ----------------------------------------------------------- helpers -- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function angWrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function rr(a, b) { return a + Math.random() * (b - a); }
  function irand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function gauss() { return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.866; }

  /* the game globals this file leans on; false until the level is up */
  var OK = false;
  function world() {
    if (OK) return true;
    try {
      OK = !!(NAV && NAV.ready && NAV.adj && NAV.walk && NAV.fl && liftOf && WPN &&
        typeof CELL === 'number' && typeof MW === 'number' && typeof MH === 'number' &&
        typeof CLIMB === 'number' && typeof PRAD === 'number' && typeof GRAV === 'number' && typeof EYE === 'number' &&
        typeof moveSlide === 'function' && typeof highestFloor === 'function' && typeof shotLineClear === 'function');
    } catch (e) { OK = false; }
    return OK;
  }
  B.ready = function () { return world(); };

  /* ------------------------------------------------------------- cells -- */
  /* the cells a match is played in, or null for the whole level */
  var ALLOW = null;
  function allowed(i) { return !ALLOW || ALLOW(i) === true; }
  function cellOf(x, z) {
    var cx = Math.floor(x / CELL), cy = Math.floor(z / CELL);
    return (cx < 0 || cy < 0 || cx >= MW || cy >= MH) ? -1 : cy * MW + cx;
  }
  function wx(i) { return (i % MW) * CELL + CELL / 2; }
  function wz(i) { return ((i / MW) | 0) * CELL + CELL / 2; }
  /* the walkable cell a body at x,z (feet at y) counts as standing in */
  function walkCell(x, z, y) {
    var c = cellOf(x, z);
    if (c >= 0 && NAV.walk[c] && allowed(c) && Math.abs(NAV.fl[c] - y) <= CLIMB * 2.6) return c;
    var cx = Math.floor(x / CELL), cy = Math.floor(z / CELL), best = -1, bs = 1e9;
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
      var nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
      var i = ny * MW + nx;
      if (!NAV.walk[i] || !allowed(i)) continue;
      var s = Math.hypot(wx(i) - x, wz(i) - z) + Math.abs(NAV.fl[i] - y) * 1.5;
      if (s < bs) { bs = s; best = i; }
    }
    return best;
  }
  /* A lift car is linked to both of its storeys in NAV.adj; in a match it is
     parked, so only the storey it is level with counts. */
  function linkOK(a, b) {
    return liftOf[a] === liftOf[b] || Math.abs(NAV.fl[a] - NAV.fl[b]) <= CLIMB;
  }
  function standable(x, z, y) {
    var c = cellOf(x, z);
    return c >= 0 && NAV.walk[c] === 1 && allowed(c) && liftOf[c] < 0 && Math.abs(NAV.fl[c] - y) <= CLIMB;
  }

  /* ------------------------------------------------------------- paths -- */
  /* A distance field: steps from every cell to one goal cell. The level does
     not change during a match (doors stand open, lifts are parked), so a
     field is good for as long as it stays in the cache. */
  var FIELDS = [], FIELD_MAX = 24, QUEUE = null, CLOCK = 0;
  function bfs(start, d) {
    if (!QUEUE || QUEUE.length < NAV.n) QUEUE = new Int32Array(NAV.n);
    d.fill(-1);
    var adj = NAV.adj, head = 0, tail = 0;
    QUEUE[tail++] = start; d[start] = 0;
    while (head < tail) {
      var c = QUEUE[head++], o = c * 8, dc = d[c] + 1;
      for (var k = 0; k < 8; k++) {
        var n = adj[o + k];
        if (n < 0 || d[n] >= 0 || !linkOK(c, n) || !allowed(n)) continue;
        d[n] = dc; QUEUE[tail++] = n;
      }
    }
    return tail;
  }
  function field(goal) {
    if (goal < 0 || !NAV.walk[goal]) return null;
    var f = null, i;
    for (i = 0; i < FIELDS.length; i++) if (FIELDS[i].goal === goal) { f = FIELDS[i]; break; }
    if (!f) {
      if (FIELDS.length < FIELD_MAX) { f = { goal: -1, d: new Int16Array(NAV.n), use: 0, n: 0 }; FIELDS.push(f); }
      else { f = FIELDS[0]; for (i = 1; i < FIELDS.length; i++) if (FIELDS[i].use < f.use) f = FIELDS[i]; }
      f.goal = goal;
      f.n = bfs(goal, f.d);
    }
    f.use = ++CLOCK;
    return f;
  }
  /* the downhill neighbour; between equals, the one nearer the goal as the crow flies */
  function downhill(f, c, gx, gz) {
    var adj = NAV.adj, o = c * 8, d = f.d, here = d[c], best = 0, be = 0, bi = -1;
    for (var k = 0; k < 8; k++) {
      var n = adj[o + k];
      if (n < 0) continue;
      var dn = d[n];
      if (dn < 0 || dn >= here || !linkOK(c, n)) continue;
      var e = Math.hypot(wx(n) - gx, wz(n) - gz);
      if (bi < 0 || dn < best || (dn === best && e < be)) { best = dn; be = e; bi = n; }
    }
    return bi;
  }
  /* can a body walk the straight line? centre and both shoulders, half a cell at a time */
  function lineWalk(x0, z0, y, x1, z1) {
    var dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return true;
    var steps = Math.min(28, Math.ceil(dist / (CELL * 0.45)));
    var sx = dx / steps, sz = dz / steps, px = -dz / dist, pz = dx / dist, fy = y;
    for (var i = 1; i <= steps; i++) {
      var qx = x0 + sx * i, qz = z0 + sz * i, c = cellOf(qx, qz);
      if (c < 0 || !NAV.walk[c] || !allowed(c) || liftOf[c] >= 0 || Math.abs(NAV.fl[c] - fy) > CLIMB) return false;
      var l = cellOf(qx + px, qz + pz), r = cellOf(qx - px, qz - pz);
      if (l < 0 || r < 0 || !NAV.walk[l] || !NAV.walk[r] || !allowed(l) || !allowed(r)) return false;
      if (Math.abs(NAV.fl[l] - NAV.fl[c]) > CLIMB || Math.abs(NAV.fl[r] - NAV.fl[c]) > CLIMB) return false;
      fy = NAV.fl[c];
    }
    return true;
  }
  /* Point the bot down the field. Returns the steps left to the goal, 0 on
     arrival, -1 when this goal cannot be reached from where it stands. */
  function steer(b, f) {
    b.mx = 0; b.mz = 0;
    var c = walkCell(b.x, b.z, b.y);
    if (c < 0 || !f || f.d[c] < 0) return -1;
    if (f.d[c] === 0) return 0;
    var gx = wx(f.goal), gz = wz(f.goal);
    var n1 = downhill(f, c, gx, gz);
    if (n1 < 0) return -1;
    var tx, tz;
    if (b.strict > 0) {
      /* it was stuck a moment ago: square up on this cell's centre, then
         take the route one cell at a time */
      var ox = wx(c) - b.x, oz = wz(c) - b.z;
      if (!b.squared && ox * ox + oz * oz > 0.5) { tx = wx(c); tz = wz(c); }
      else { b.squared = true; tx = wx(n1); tz = wz(n1); }
    } else {
      /* cut the corner to the furthest of the next few cells it can walk
         straight to, so it does not march from centre to centre */
      var pick = n1, cur = n1;
      for (var s = 0; s < 3 && f.d[cur] > 0; s++) {
        var nn = downhill(f, cur, gx, gz);
        if (nn < 0 || !lineWalk(b.x, b.z, b.y, wx(nn), wz(nn))) break;
        pick = nn; cur = nn;
      }
      tx = wx(pick); tz = wz(pick);
    }
    var dx = tx - b.x, dz = tz - b.z, l = Math.hypot(dx, dz);
    if (l > 1e-3) { b.mx = dx / l; b.mz = dz / l; }
    return f.d[c];
  }
  /* The enemy is somewhere this bot cannot walk to (he jumped onto
     something): the reachable cell nearest him will have to do. */
  function nearestReachable(from, gx, gy, gz) {
    var f = field(from);
    if (!f) return -1;
    var d = f.d, fl = NAV.fl, best = -1, bs = 1e9;
    for (var i = 0; i < NAV.n; i++) {
      if (d[i] < 0) continue;
      var s = Math.hypot(wx(i) - gx, wz(i) - gz) + Math.abs(fl[i] - gy) * 2;
      if (s < bs) { bs = s; best = i; }
    }
    return best;
  }

  /* how many steps of walking apart two spots are, -1 if you cannot walk it
     (nz-net.js uses this to put the two sides far from each other) */
  /* the arena (see the header); every cached path is forgotten with it */
  B.setAllow = function (fn) {
    ALLOW = typeof fn === 'function' ? fn : null;
    FIELDS.length = 0;
  };

  B.pathSteps = function (ax, az, ay, bx, bz, by) {
    if (!world()) return -1;
    var a = walkCell(ax, az, ay), b = walkCell(bx, bz, by);
    if (a < 0 || b < 0) return -1;
    var f = field(a);
    return f ? f.d[b] : -1;
  };

  /* ---------------------------------------------------------- the body -- */
  function moveBot(b, speed, dt) {
    var ox = b.x, oz = b.z;
    if ((b.mx || b.mz) && speed > 0) {
      var st = speed * dt;
      var np = moveSlide(b.x, b.z, b.mx * st, b.mz * st, PRAD, b.y);
      b.x = np[0]; b.z = np[1];
    }
    var gf = highestFloor(b.x, b.z, PRAD * 0.85);
    b.vy -= GRAV * dt;
    b.y += b.vy * dt;
    if (b.y <= gf) { b.y = gf; b.vy = 0; b.onGround = true; } else b.onGround = false;
    var iv = 1 / Math.max(dt, 1e-4), k = Math.min(1, dt * 10);
    b.vx += ((b.x - ox) * iv - b.vx) * k;
    b.vz += ((b.z - oz) * iv - b.vz) * k;
  }
  function turnTo(b, yawT, pitT, rate, dt) {
    var dy = angWrap(yawT - b.yaw), dp = pitT - b.pitch;
    var m = Math.max(Math.abs(dy), Math.abs(dp));
    var r = rate * clamp(m / 0.45, 0.22, 1) * dt;      /* eases in as it comes onto the mark */
    b.yaw = angWrap(b.yaw + clamp(dy, -r, r));
    b.pitch = clamp(b.pitch + clamp(dp, -r, r), -1.3, 1.3);
    return m;
  }

  /* ---------------------------------------------------------- the eyes -- */
  /* 2: chest in view, 1: only his head, 0: nothing */
  function sees(b, f) {
    var ex = b.x, ey = b.y + b.eyeH - 0.1, ez = b.z, eh = fin(f.eyeH, EYE);
    if (shotLineClear(ex, ey, ez, f.x, f.y + eh * 0.68, f.z)) return 2;
    if (shotLineClear(ex, ey, ez, f.x, f.y + eh * 0.98, f.z)) return 1;
    return 0;
  }
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function perceive(b, ctx) {
    var S = b.skill, now = ctx.now, foes = ctx.foes, best = null, bestV = 0, bs = 1e9;
    for (var i = 0; i < foes.length; i++) {
      var f = foes[i];
      if (!f.alive) continue;
      var dx = f.x - b.x, dz = f.z - b.z, dy = f.y - b.y, dist = Math.hypot(dx, dz, dy);
      var heard = fin(f.firedAgo, 9) < 0.6 && dist < HEAR;
      if (dist > SIGHT) continue;
      var off = Math.abs(angWrap(Math.atan2(-dx, -dz) - b.yaw));
      var aware = off < S.fov || dist < 18 || f.id === b.tgt || heard || (b.hurtBy === f.id && now - b.hurtAt < 3);
      var v = aware ? sees(b, f) : 0;
      if (!v) {
        /* a shot it cannot see the source of: go and look */
        if (heard && !b.vis) { b.seen = { x: f.x, y: f.y, z: f.z, t: now }; b.seenDone = false; if (!b.tgt) b.tgt = f.id; }
        continue;
      }
      var s = dist * (f.id === b.tgt ? 0.7 : 1);
      if (s < bs) { bs = s; best = f; bestV = v; }
    }
    if (!best) { b.vis = 0; return; }
    if (b.tgt !== best.id || now - b.visT > 0.7) {
      /* a new face, or the old one back from behind cover: react afresh */
      b.seeT = 0;
      b.react = S.react * rr(0.8, 1.35) * (b.hurtBy === best.id && now - b.hurtAt < 3 ? 0.6 : 1);
      b.aimHead = Math.random() < S.head;
      b.errT = 0;
      b.burst = 0; b.rest = 0;
    }
    b.tgt = best.id; b.vis = bestV; b.visT = now;
    b.seen = { x: best.x, y: best.y, z: best.z, t: now }; b.seenDone = false;
  }

  /* ----------------------------------------------------------- the gun -- */
  function shoot(b, ctx, W) {
    var move = Math.min(1, Math.hypot(b.vx, b.vz) / 21);
    var sp = fin(W.spread, 0.015) * (1 + 0.8 * move);
    var cp = Math.cos(b.pitch);
    var dx = -Math.sin(b.yaw) * cp + rr(-1, 1) * sp;
    var dy = Math.sin(b.pitch) + rr(-1, 1) * sp;
    var dz = -Math.cos(b.yaw) * cp + rr(-1, 1) * sp;
    var l = Math.hypot(dx, dy, dz) || 1;
    b.firedAt = ctx.now;
    b.shots++;
    /* the muzzle climbs a little through a burst */
    b.ey += 0.0035 * fin(W.kick, 1);
    ctx.fire(b, { x: b.x, y: b.y + b.eyeH - 0.25, z: b.z }, { x: dx / l, y: dy / l, z: dz / l }, b.weapon);
  }
  function fight(b, tgt, ctx, dt) {
    var S = b.skill, W = WPN[b.weapon] || WPN[0];
    b.seeT += dt;
    var eh = fin(tgt.eyeH, EYE);
    var ax = tgt.x, az = tgt.z, ay = tgt.y + eh * ((b.vis === 1 || b.aimHead) ? 0.97 : 0.70);
    var ox = b.x, oy = b.y + b.eyeH - 0.25, oz = b.z;
    var dx = ax - ox, dy = ay - oy, dz = az - oz, flat = Math.hypot(dx, dz) || 1e-3;
    var yawT = Math.atan2(-dx, -dz), pitT = Math.atan2(dy, flat);

    /* the point it is actually trying to hold: the target plus a wander */
    b.errT -= dt;
    if (b.errT <= 0) {
      b.errT = rr(0.18, 0.42);
      var sig = S.sig0 + (S.sig1 - S.sig0) * clamp(b.seeT / 1.4, 0, 1);
      var tv = Math.min(1.4, Math.hypot(fin(tgt.vx), fin(tgt.vz)) / 21);
      var ov = Math.min(1, Math.hypot(b.vx, b.vz) / 21);
      sig *= 1 + 0.7 * tv + 0.45 * ov;
      if (b.hurtT > 0) sig *= 1.5;
      b.egx = gauss() * sig; b.egy = gauss() * sig * 0.7;
    }
    var k = 1 - Math.exp(-dt * 7);
    b.ex += (b.egx - b.ex) * k; b.ey += (b.egy - b.ey) * k;
    var off = turnTo(b, yawT + b.ex, pitT + b.ey, S.turn, dt);

    if (b.burst <= 0) b.rest -= dt;
    if (b.seeT >= b.react && off < 0.07 && b.invT <= 0) {
      if (b.burst <= 0 && b.rest <= 0) b.burst = irand(S.burst[0], S.burst[1]);
      if (b.burst > 0 && b.cool <= 0) {
        shoot(b, ctx, W);
        b.burst--;
        b.cool = fin(W.rof, 0.11) * rr(1.0, 1.18);
        if (b.burst <= 0) b.rest = rr(S.rest[0], S.rest[1]);
      }
    }
    return flat;
  }

  /* ---------------------------------------------------------- the legs -- */
  function nearestFoe(b, ctx) {
    var best = null, bs = 1e9;
    for (var i = 0; i < ctx.foes.length; i++) {
      var f = ctx.foes[i];
      if (!f.alive) continue;
      var s = Math.hypot(f.x - b.x, f.z - b.z) + Math.abs(f.y - b.y) * 2;
      if (s < bs) { bs = s; best = f; }
    }
    return best;
  }
  /* walk toward a spot; returns steps left, 0 on arrival */
  function walkTo(b, gx, gy, gz) {
    var goal = walkCell(gx, gz, gy);
    var f = field(goal);
    var left = steer(b, f);
    if (left < 0) {
      /* no way there on foot: get as near as the floor allows. Where that
         is does not depend on where the bot stands, so it is worked out
         once per goal, and again only if it turns out not to answer. */
      var c = walkCell(b.x, b.z, b.y);
      if (c < 0) return -1;
      if (!b.alt || b.alt.goal !== goal) b.alt = { goal: goal, from: c, cell: nearestReachable(c, gx, gy, gz) };
      left = steer(b, field(b.alt.cell));
      if (left < 0 && b.alt.from !== c) {
        b.alt = { goal: goal, from: c, cell: nearestReachable(c, gx, gy, gz) };
        left = steer(b, field(b.alt.cell));
      }
    }
    return left;
  }
  function crowd(b, ctx) {
    /* players pass through each other; two bots walking the same path would
       be one bot with four arms */
    var m = ctx.mates, px = 0, pz = 0;
    for (var i = 0; i < m.length; i++) {
      if (!m[i].alive) continue;
      var dx = b.x - m[i].x, dz = b.z - m[i].z, d = Math.hypot(dx, dz);
      if (d > 3.4 || Math.abs(b.y - m[i].y) > 4) continue;
      if (d < 0.05) { dx = Math.cos(b.slot * 2.4); dz = Math.sin(b.slot * 2.4); d = 1; }
      var w = (1 - d / 3.4) * 0.9;
      px += dx / d * w; pz += dz / d * w;
    }
    if (!px && !pz) return;
    var nx = b.mx + px, nz = b.mz + pz, l = Math.hypot(nx, nz);
    if (l < 1e-3) return;
    if (l > 1) { nx /= l; nz /= l; }
    if (standable(b.x + nx * 2.2, b.z + nz * 2.2, b.y)) { b.mx = nx; b.mz = nz; }
  }
  function unstick(b, wanted, speed, dt) {
    b.progT += dt;
    if (b.strict > 0) b.strict -= dt;
    if (b.progT < 0.5) return;
    var moved = Math.hypot(b.x - b.px, b.z - b.pz);
    b.px = b.x; b.pz = b.z; b.progT = 0;
    if (!wanted || moved > speed * 0.5 * 0.22) { b.stuck = 0; return; }
    b.stuck++;
    if (b.stuck >= 2) { b.strict = 1.2; b.squared = false; }
    if (b.stuck >= 5) {
      /* wedged for real: stand it on the middle of its cell and start over */
      var c = walkCell(b.x, b.z, b.y);
      if (c >= 0) { b.x = wx(c); b.z = wz(c); b.y = NAV.fl[c]; b.vy = 0; }
      b.stuck = 0;
    }
  }

  /* ============================================================ public == */
  B.create = function (o) {
    o = o || {};
    return {
      slot: o.slot | 0, team: o.team | 0, weapon: fin(o.weapon, 6) | 0,
      skill: SKILLS[o.skill] || SKILLS.normal,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, onGround: true,
      alive: false, hp: 0, eyeH: 6, dash: 0, ads: 0, life: 0, shots: 0,
      invT: 0, holdT: 0, hurtT: 0, hurtBy: null, hurtAt: -9, firedAt: -9,
      tgt: null, vis: 0, visT: -9, seeT: 0, react: 0.4, aimHead: false,
      seen: null, seenDone: false, hunt: null, huntPos: null, pickT: 0, alt: null,
      ex: 0, ey: 0, egx: 0, egy: 0, errT: 0, burst: 0, rest: 0, cool: 0,
      strafe: 1, strafeT: 0, thinkT: 0, alertT: 0, alertYaw: 0,
      mx: 0, mz: 0, px: 0, pz: 0, progT: 0, stuck: 0, strict: 0, squared: false
    };
  };
  B.setSkill = function (b, key) { b.skill = SKILLS[key] || SKILLS.normal; };

  B.spawn = function (b, pt, now) {
    b.x = fin(pt.x); b.y = fin(pt.y); b.z = fin(pt.z); b.yaw = fin(pt.yaw); b.pitch = 0;
    b.vx = b.vy = b.vz = 0; b.onGround = true;
    b.alive = true; b.hp = 100; b.life = (b.life + 1) & 255;
    try { b.eyeH = EYE; } catch (e) { b.eyeH = 6; }
    b.dash = 0; b.ads = 0;
    b.invT = 1.25; b.holdT = rr(0.7, 1.5); b.hurtT = 0; b.hurtBy = null; b.hurtAt = -9; b.firedAt = -9;
    b.tgt = null; b.vis = 0; b.visT = -9; b.seeT = 0; b.seen = null; b.seenDone = false; b.hunt = null; b.huntPos = null; b.pickT = 0; b.alt = null;
    b.ex = b.ey = b.egx = b.egy = 0; b.errT = 0; b.burst = 0; b.rest = 0; b.cool = 0.3;
    b.strafe = Math.random() < 0.5 ? -1 : 1; b.strafeT = 0; b.thinkT = Math.random() * 0.15; b.alertT = 0;
    b.mx = b.mz = 0; b.px = b.x; b.pz = b.z; b.progT = 0; b.stuck = 0; b.strict = 0; b.squared = false;
  };

  B.hurt = function (b, d, by, fromX, fromZ, now) {
    if (!b.alive) return;
    b.hp -= d;
    b.hurtT = 0.45; b.hurtBy = by; b.hurtAt = now;
    b.ex += gauss() * 0.03; b.ey += gauss() * 0.02;
    if (!b.vis) {
      /* hit from somewhere it was not looking: turn round and go there */
      b.alertYaw = Math.atan2(-(fromX - b.x), -(fromZ - b.z)); b.alertT = 1.2;
      b.seen = { x: fromX, y: b.y, z: fromZ, t: now }; b.seenDone = false;
      b.tgt = by;
    }
  };

  B.step = function (b, dt, ctx) {
    if (!world()) return;
    dt = clamp(fin(dt, 0.016), 0, 0.1);
    b.mx = 0; b.mz = 0;
    if (!b.alive) { b.vx = b.vz = 0; return; }
    var S = b.skill, now = ctx.now;
    b.invT = Math.max(0, b.invT - dt);
    b.hurtT = Math.max(0, b.hurtT - dt);
    b.alertT = Math.max(0, b.alertT - dt);
    b.cool -= dt;
    if (b.holdT > 0) { b.holdT -= dt; moveBot(b, 0, dt); return; }

    b.thinkT -= dt;
    if (b.thinkT <= 0) { b.thinkT = 0.10 + Math.random() * 0.06; perceive(b, ctx); }
    var tgt = b.tgt ? byId(ctx.foes, b.tgt) : null;
    if (b.tgt && (!tgt || !tgt.alive)) { b.tgt = null; b.vis = 0; b.seeT = 0; b.seen = null; tgt = null; }

    var speed = 0, pathing = false, wantDash = 0, wantAds = 0;
    if (tgt && b.vis) {
      /* ---- he is in view: shoot, and keep moving ---- */
      var flat = fight(b, tgt, ctx, dt);
      wantAds = flat > 45 ? 1 : 0.35;
      if (flat > 105) {
        /* too far to be worth the ammunition standing still: close in */
        walkTo(b, tgt.x, tgt.y, tgt.z);
        speed = S.speed * 0.85; pathing = true;
      } else {
        b.strafeT -= dt;
        if (b.strafeT <= 0) { b.strafeT = rr(0.5, 1.3); b.strafe = Math.random() < 0.18 ? 0 : (Math.random() < 0.5 ? -1 : 1); }
        var tx = (tgt.x - b.x) / flat, tz = (tgt.z - b.z) / flat;
        var mx = -tz * b.strafe, mz = tx * b.strafe;
        if (flat < 20) { mx -= tx * 0.8; mz -= tz * 0.8; }
        var l = Math.hypot(mx, mz);
        if (l > 1e-3) {
          mx /= l; mz /= l;
          if (standable(b.x + mx * 2.6, b.z + mz * 2.6, b.y)) { b.mx = mx; b.mz = mz; speed = S.speed * 0.6; }
          else { b.strafe = -b.strafe; b.strafeT = rr(0.4, 0.9); }
        }
      }
    } else {
      /* ---- nobody in view: go and find somebody ---- */
      var goal = null;
      if (b.seen && !b.seenDone && now - b.seen.t < 6) goal = b.seen;
      else {
        var hf = b.hunt ? byId(ctx.foes, b.hunt) : null;
        if (now >= b.pickT || !hf || !hf.alive || !b.huntPos) {
          var nf = nearestFoe(b, ctx);
          b.hunt = nf ? nf.id : null;
          b.huntPos = nf ? { x: nf.x + rr(-5, 5), y: nf.y, z: nf.z + rr(-5, 5) } : null;
          b.pickT = now + rr(2.5, 4.5);
        }
        goal = b.huntPos;
      }
      if (goal) {
        var left = walkTo(b, goal.x, goal.y, goal.z);
        /* there, and nobody: look again */
        if (left >= 0 && left <= 1) { if (goal === b.seen) b.seenDone = true; else b.pickT = 0; }
        if (b.mx || b.mz) { speed = S.speed; pathing = true; wantDash = left > 16 ? 1 : 0; }
      }
      /* look where it is going, or at whatever just hit it */
      var yawT = b.alertT > 0 ? b.alertYaw : ((b.mx || b.mz) ? Math.atan2(-b.mx, -b.mz) : b.yaw);
      turnTo(b, yawT, 0, S.turn * (b.alertT > 0 ? 1 : 0.7), dt);
      b.ex *= 0.9; b.ey *= 0.9;
    }

    crowd(b, ctx);
    b.dash += (wantDash - b.dash) * (1 - Math.exp(-dt * 6));
    b.ads += (wantAds - b.ads) * (1 - Math.exp(-dt * 8));
    speed *= 1 + 0.22 * b.dash;
    moveBot(b, speed, dt);
    unstick(b, pathing && speed > 0, speed, dt);
  };

  /* debug / tests */
  B.fieldCount = function () { return FIELDS.length; };
})(typeof window !== 'undefined' ? window : this);
