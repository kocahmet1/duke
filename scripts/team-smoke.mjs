/* ===========================================================================
   team-smoke.mjs -- the team match with bots, end to end, headless.

   Starts server/mp-server.mjs on a spare port and checks, in order:

     ALONE (one page, so every seat but one is a bot)
      1. the lobby offers the team match, a side and the bot difficulty
      2. joining deals a 2v2 round: the player and a bot against two bots,
         every bot run on this page and drawn as a full figure
      3. the bots leave their bases
      4. the player shoots an enemy bot dead and gets the frag; rounds into
         his own bot do nothing
      5. a bot puts the player down: nobody respawns, he watches his
         team-mate from over its shoulder
      6. the round ends when one side is down, the score moves, the next
         round deals everyone back in; the match ends at the winning score
         and the next one starts from 0-0

     TWO PLAYERS (both asked for red: the two of them against two bots)
      7. the first page runs the match and the bots, the second is dealt in
         and draws the bots where the first one has them
      8. the bot difficulty is the first page's to set, and the second sees it
      9. the second player's rounds kill a bot run on the first page; both
         scoreboards give him the frag
     10. a bot shoots the second player; down, he watches the first
     11. the first page leaves: the second takes the bots over, deals the
         round again with a bot beside him, and the bots carry on
   and fails on any console error from the game.

     node scripts/team-smoke.mjs
     CHROME=/path/to/chrome node scripts/team-smoke.mjs

   Software rendering would hold the bots to a frame or two a second, so
   drawing is switched off once the figures have been drawn a few times;
   everything else (the bots, their figures and hit volumes, the network)
   runs as it does in a real browser. Allow three to five minutes.
   ======================================================================== */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PORT = 4300 + Math.floor(Math.random() * 500);
const roomCode = () => 'T' + Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
const CHROME = process.env.CHROME || [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });

const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(ok, what) {
  if (ok) say('PASS', what); else { failures++; say('FAIL', what); }
  return ok;
}
async function waitFor(page, fn, ms, what, ...args) {
  const until = Date.now() + ms;
  for (; ;) {
    let v = false;
    try { v = await page.evaluate(fn, ...args); } catch { v = false; }
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting for ' + (what || String(fn)));
    await sleep(250);
  }
}

if (!CHROME) { console.error('team-smoke: no Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }

/* ------------------------------------------------------------- server -- */
const srv = spawn(process.execPath, [path.join(REPO, 'server', 'mp-server.mjs')], {
  cwd: REPO, env: { ...process.env, NZ_PORT: String(PORT), PORT: '', HOST: '127.0.0.1', NZ_STUN: '', NZ_MAX_PLAYERS: '4' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
for (let i = 0; i < 40 && !/multiplayer server on/.test(srvLog); i++) await sleep(100);
if (!/multiplayer server on/.test(srvLog)) { console.error(srvLog); process.exit(2); }
say(`server on :${PORT}`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--mute-audio']
});

const errors = [];
const open = [];
async function openPage(name, room) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.nzName = name;
  await page.setViewport({ width: 400, height: 250 });
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`${name}: HTTP ${r.status()} ${r.url()}`); });
  await page.evaluateOnNewDocument(n => { try { localStorage.setItem('nuke-zone-3d:mp-name:v1', n); } catch (e) { } }, name);
  await page.goto(`http://127.0.0.1:${PORT}/NUKEM.html?nzq=low#mp=${room}&level=2`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitFor(page, () => typeof state !== 'undefined' && state.booted, 240000, `${name} boot`);
  await waitFor(page, () => window.NZ && NZ.net && NZ.net.me().welcomed, 60000, `${name} welcome`);
  await helpers(page);
  open.push({ page, ctx });
  return page;
}
async function closePage(page) {
  const i = open.findIndex(o => o.page === page);
  if (i >= 0) { await open[i].ctx.close().catch(() => { }); open.splice(i, 1); }
}
/* the level stops being drawn; everything else carries on */
const noDraw = page => page.evaluate(() => { NZ.flags.render = false; renderer.render = function () { }; });

/* in-page test helpers: stand somewhere with a clear shot, aim, fire */
function helpers(page) {
  return page.evaluate(() => {
    const T = window.__t = {};
    T.sleep = ms => new Promise(r => setTimeout(r, ms));
    T.where = id => {
      const b = NZ.net.bots().find(q => q.id === id) || NZ.net.peers().find(q => q.id === id);
      return b && b.pos ? b.pos : null;
    };
    T.alive = id => { const p = T.where(id); return !!(p && p.alive); };
    T.chest = id => {
      const parts = NZ.net.peerHitParts(id);
      const b = parts.find(p => p.zone === 'body') || parts[0];
      return b ? { x: (b.ax + b.bx) / 2, y: (b.ay + b.by) / 2, z: (b.az + b.bz) / 2 } : null;
    };
    /* every other figure standing, so a line of fire can keep clear of them */
    T.others = id => NZ.net.bots().filter(b => b.id !== id && b.pos && b.pos.alive).map(b => b.pos)
      .concat(NZ.net.peers().filter(p => p.id !== id && p.pos && p.pos.alive).map(p => p.pos));
    T.segDist2 = (ax, az, bx, bz, px, pz) => {
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
      return Math.hypot(ax + dx * t - px, az + dz * t - pz);
    };
    /* a spot on the same floor as (x, y, z), dmin..dmax away, from which the
       player's eye has a clear line to (tx, ty, tz) that passes nobody in `avoid` */
    T.spotNear = (x, y, z, tx, ty, tz, dmin, dmax, avoid) => {
      for (let d = dmin; d <= dmax; d += 1.5) for (let k = 0; k < 24; k++) {
        const a = k / 24 * Math.PI * 2, px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
        if (!canStand(px, pz, PRAD, y)) continue;
        const f = highestFloor(px, pz, PRAD * .85);
        if (Math.abs(f - y) > 0.6) continue;
        if (!shotLineClear(px, f + EYE - .25, pz, tx, ty, tz)) continue;
        if (avoid && avoid.some(o => Math.abs(o.y - f) < 8 && T.segDist2(px, pz, tx, tz, o.x, o.z) < 3)) continue;
        return { x: px, y: f, z: pz };
      }
      return null;
    };
    T.put = s => { player.x = s.x; player.y = s.y; player.z = s.z; player.vy = 0; player.onGround = true; };
    T.aim = (tx, ty, tz) => {
      const ox = player.x, oy = player.y + EYE - .25, oz = player.z;
      const dx = tx - ox, dy = ty - oy, dz = tz - oz;
      player.yaw = Math.atan2(-dx, -dz); player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      camera.rotation.set(player.pitch, player.yaw, 0);
    };
    /* stand within range of `id` and put up to n rounds into its chest, one
       every 120 ms, until it is down. Rounds fired, or -1 for no spot. */
    T.shoot = async (id, n, keepGoing) => {
      const w = WPN[player.weapon], keep = [w.spread, w.adsSpread];
      w.spread = 0; w.adsSpread = 0;
      player.moveBlend = 0; player.sprint = 0; player.dash = 0;
      let k = 0, placed = false;
      try {
        for (; k < n; k++) {
          if (!keepGoing && !T.alive(id)) break;
          const c = T.chest(id);
          if (!c) { await T.sleep(100); continue; }
          if (!placed) {
            const p = T.where(id), s = p && T.spotNear(p.x, p.y, p.z, c.x, c.y, c.z, 7, 15, T.others(id));
            if (!s) return -1;
            T.put(s); placed = true;
            await T.sleep(80);
            continue;
          }
          T.aim(c.x, c.y, c.z);
          player.onGround = true;
          fire();
          await T.sleep(120);
        }
      } finally { w.spread = keep[0]; w.adsSpread = keep[1]; }
      return k;
    };
    /* shield / freeze a bot this page runs */
    T.bot = (id, o) => { const s = NZ.net.botSim(id); if (!s) return false; Object.assign(s, o); return true; };
  });
}

const round = page => page.evaluate(() => NZ.net.round());
const me = page => page.evaluate(() => NZ.net.me());

try {
  /* =================================================================== ALONE */
  const roomA = roomCode();
  say(`--- alone, room ${roomA}`);
  let A = await openPage('P1', roomA);

  /* 1. the lobby */
  const lob = await A.evaluate(() => ({
    mode: NZ.net.mode(), start: document.getElementById('btnStart').textContent,
    brief: document.getElementById('missionBrief').textContent,
    segs: [...document.querySelectorAll('#nzLobby .seg')].map(s => [...s.querySelectorAll('button')].map(b => b.textContent + (b.classList.contains('on') ? '*' : ''))),
    link: document.getElementById('nzLink').value
  }));
  check(lob.mode === 'team' && lob.start === 'MAÇA KATIL' && /2'ye 2/.test(lob.brief) && lob.segs.length === 3 && !/mode=/.test(lob.link),
    `lobby offers the team match (${lob.segs.map(s => s.join(' ')).join(' | ')})`);

  /* 2. one player, three bots */
  await A.evaluate(() => { NZ.net.tune({ roundGap: 1.5, matchGap: 2.5, toWin: 2 }); document.getElementById('btnStart').click(); });
  await waitFor(A, () => { const r = NZ.net.round(); return NZ.net.me().inMatch && r.ph === 'live' && r.ro.length === 4; }, 20000, 'round 1 dealt');
  await A.evaluate(() => { player.invT = 1e6; });                  /* shielded until step 5 */
  const r1 = await round(A), meA = await me(A);
  const side = t => r1.ro.filter(r => r.team === t);
  const mate = r1.ro.find(r => r.bot && r.team === meA.team), foes = r1.ro.filter(r => r.team !== meA.team);
  check(r1.mine && r1.n === 1 && side(0).length === 2 && side(1).length === 2 && r1.ro.filter(r => r.bot).length === 3 &&
    mate && foes.length === 2 && foes.every(f => f.bot),
    `round 1 is 2v2: ${r1.ro.map(r => r.name + (r.team ? ' (MAVİ)' : ' (KIRMIZI)')).join(', ')}`);
  const seat = await A.evaluate(() => { const r = NZ.net.round(), m = r.ro.find(q => q.id === NZ.net.me().id); return player.alive && Math.hypot(player.x - m.sp.x, player.z - m.sp.z) < 1.5; });
  check(seat, 'the player starts at his side\'s base');
  await A.evaluate(id => window.__t.bot(id, { invT: 1e6 }), mate.id);   /* the team-mate too, for step 5 */
  await waitFor(A, () => NZ.net.bots().length === 3 && NZ.net.bots().every(b => b.here && b.shown && b.puppet), 30000, 'bot figures');
  check(true, 'all three bots are run on this page and drawn as full figures');
  /* a few frames drawn with the figures up, then drawing off */
  await A.evaluate(() => { window.__fr = 0; (function f() { window.__fr++; requestAnimationFrame(f); })(); });
  await waitFor(A, () => window.__fr > 4, 90000, 'frames drawn');
  const hud = await A.evaluate(() => document.getElementById('nzNet').innerText.replace(/\n+/g, ' / '));
  check(/KIRMIZI/.test(hud) && /MAVİ/.test(hud) && /P1/.test(hud) && /RAUNT 1/.test(hud), `team scoreboard: ${hud}`);
  /* ESC opens the pause menu (it used to throw in a match) and closes it again */
  const pz = await A.evaluate(() => {
    togglePause();
    const r = { shown: document.getElementById('scPause').classList.contains('show'),
      btns: [...document.querySelectorAll('#scPause .menu-actions button')].filter(b => b.style.display !== 'none').map(b => b.textContent) };
    togglePause();
    r.back = state.playing && !document.getElementById('scPause').classList.contains('show');
    return r;
  });
  check(pz.shown && pz.back && pz.btns.some(b => /^TAKIM:/.test(b)) && pz.btns.some(b => /^BOTLAR:/.test(b)) && pz.btns.includes('MAÇTAN AYRIL'),
    `ESC opens the pause menu and closes it (${pz.btns.join(' | ')})`);
  await noDraw(A);

  /* 3. the bots set off */
  const p0 = await A.evaluate(() => NZ.net.bots().map(b => [b.sim.x, b.sim.z]));
  await sleep(4500);
  const p1 = await A.evaluate(() => NZ.net.bots().map(b => [b.sim.x, b.sim.z]));
  const moved = p0.map((a, i) => Math.hypot(a[0] - p1[i][0], a[1] - p1[i][1]));
  check(moved.every(d => d > 12), `the bots leave their bases (${moved.map(d => d.toFixed(0)).join(', ')} units in 4.5 s)`);

  /* 4. the player kills an enemy bot; his own bot cannot be hurt */
  for (const f of foes) await A.evaluate(id => window.__t.bot(id, { holdT: 1e6 }), f.id);
  await A.evaluate(id => window.__t.bot(id, { holdT: 1e6 }), mate.id);
  const n1 = await A.evaluate(id => window.__t.shoot(id, 40), foes[0].id);
  await waitFor(A, id => { const b = NZ.net.bots().find(q => q.id === id); return b && b.sim && !b.sim.alive; }, 5000, 'enemy bot down', foes[0].id);
  const k1 = await A.evaluate(() => ({ frags: NZ.net.me().frags, feed: document.getElementById('feed').textContent, ro: NZ.net.round().ro }));
  check(k1.frags === 1 && k1.feed.includes('P1') && k1.feed.includes(foes[0].name) && k1.ro.find(r => r.id === foes[0].id).dead,
    `the player shot ${foes[0].name} dead in ${n1} rounds (feed: "${k1.feed.slice(0, 50)}")`);
  await A.evaluate(id => window.__t.bot(id, { invT: 0 }), mate.id);
  const ff = await A.evaluate(async id => { const n = await window.__t.shoot(id, 6, true); return { n, hp: NZ.net.botSim(id).hp }; }, mate.id);
  await A.evaluate(id => window.__t.bot(id, { invT: 1e6 }), mate.id);
  check(ff.n === 6 && ff.hp === 100, `six rounds into his own bot do nothing (hp ${ff.hp})`);

  /* 5. a bot puts the player down, and he watches his team-mate */
  const killer = foes[1];
  const placed = await A.evaluate(id => {
    const T = window.__t, p = T.where(id), c = T.chest(id);
    const s = p && c && NZ.net.round().ph === 'live' && T.alive(id) && T.spotNear(p.x, p.y, p.z, c.x, c.y, c.z, 8, 15, T.others(id));
    if (!s) return false;
    T.put(s); T.aim(c.x, c.y, c.z); player.invT = 0;
    T.bot(id, { holdT: 0 });
    return true;
  }, killer.id);
  check(placed, `the player stands in front of ${killer.name}`);
  await waitFor(A, () => !player.alive, 30000, 'a bot kills the player');
  await sleep(600);
  const dead = await A.evaluate(id => {
    const b = NZ.net.bots().find(q => q.id === id), c = camera.position;
    return { spec: NZ.net.me().spec, watching: NZ.net.watching(), d: Math.hypot(c.x - b.pos.x, c.z - b.pos.z), bar: document.getElementById('nzSpec').textContent, feed: document.getElementById('feed').textContent, ph: NZ.net.round().ph, alive: player.alive };
  }, mate.id);
  check(dead.spec && !dead.alive && dead.ph === 'live' && dead.feed.includes(killer.name), `${killer.name} put the player down; the round goes on without him`);
  check(dead.watching === mate.id && dead.d < 14 && dead.bar.includes(mate.name), `he watches ${mate.name} (camera ${dead.d.toFixed(1)} units off it: "${dead.bar}")`);
  await sleep(3500);
  check(await A.evaluate(() => !player.alive), 'and does not respawn mid-round');

  /* 6. rounds and the match */
  await A.evaluate(id => { NZ.net.tune({ roundTime: 45 }); window.__t.bot(id, { holdT: 0, invT: 0 }); }, mate.id);
  await waitFor(A, () => NZ.net.round().ph !== 'live', 90000, 'round 1 ends');
  const e1 = await round(A);
  check(e1.ph === 'over' && e1.sc[0] + e1.sc[1] === 1 && (e1.win === 0 || e1.win === 1) && e1.sc[e1.win] === 1,
    `round 1 over: ${e1.win ? 'MAVİ' : 'KIRMIZI'} took it, ${e1.sc.join('-')}`);
  await waitFor(A, () => { const r = NZ.net.round(); return r.ph === 'live' && r.n === 2; }, 10000, 'round 2');
  const r2 = await A.evaluate(() => ({ alive: player.alive, hp: player.hp, spec: NZ.net.me().spec, bots: NZ.net.bots().map(b => b.sim.alive && b.sim.hp === 100) }));
  check(r2.alive && r2.hp === 100 && !r2.spec && r2.bots.length === 3 && r2.bots.every(Boolean), 'round 2 deals everyone back in at full health');
  await waitFor(A, () => NZ.net.round().ph === 'match', 240000, 'the match ends');
  const m1 = await round(A);
  check(m1.sc[m1.win] === 2, `match over at ${m1.sc.join('-')} (${m1.win ? 'MAVİ' : 'KIRMIZI'})`);
  await waitFor(A, () => { const r = NZ.net.round(); return r.ph === 'live' && r.n === 1; }, 10000, 'the next match');
  const m2 = await A.evaluate(() => ({ sc: NZ.net.round().sc, frags: NZ.net.me().frags, bf: NZ.net.bots().map(b => b.frags) }));
  check(m2.sc[0] === 0 && m2.sc[1] === 0 && m2.frags === 0 && m2.bf.every(f => f === 0), 'the next match starts from 0-0 with clean tallies');
  check((await A.evaluate(() => NZ.net.status().errors)) === 0, 'no multiplayer errors');
  await closePage(A);

  /* ============================================================ TWO PLAYERS */
  const roomB = roomCode();
  say(`--- two players, room ${roomB}`);
  A = await openPage('P1', roomB);
  const B = await openPage('P2', roomB);
  for (const p of [A, B]) await p.evaluate(() => document.querySelector('#nzTeamSeg button[data-v="0"]').click());
  await A.evaluate(() => document.getElementById('btnStart').click());
  await waitFor(A, () => NZ.net.round().ph === 'live', 20000, 'A alone in round 1');
  await B.evaluate(() => document.getElementById('btnStart').click());
  await waitFor(A, () => { const r = NZ.net.round(); return r.ph === 'live' && r.ro.filter(q => !q.bot).length === 2; }, 30000, 'A deals B in');
  await waitFor(B, () => { const r = NZ.net.round(); return r.ph === 'live' && r.ro.length === 4 && NZ.net.me().team === 0 && NZ.net.bots().length === 2; }, 30000, 'B dealt in');
  for (const p of [A, B]) await p.evaluate(() => { player.invT = 1e6; });
  const idA = (await me(A)).id, idB = (await me(B)).id;
  const ra = await round(A), rb = await round(B);
  const bots2 = ra.ro.filter(r => r.bot);
  for (const b of bots2) await A.evaluate(id => window.__t.bot(id, { holdT: 1e6 }), b.id);

  /* 7. who runs it, and the bots on the second page */
  check(ra.mine && !rb.mine && rb.auth === idA && ra.q === rb.q, 'the first page runs the match, the second follows it');
  check(ra.ro.filter(r => !r.bot).every(r => r.team === 0) && bots2.length === 2 && bots2.every(b => b.team === 1),
    `both asked for red and got it: ${rb.ro.map(r => r.name + (r.team ? ' (MAVİ)' : ' (KIRMIZI)')).join(', ')}`);
  await waitFor(B, () => NZ.net.bots().every(b => b.shown && b.puppet && !b.here), 20000, 'B draws the bots');
  await noDraw(A); await noDraw(B);
  await sleep(1500);
  const simPos = await A.evaluate(() => NZ.net.bots().map(b => ({ id: b.id, x: b.sim.x, y: b.sim.y, z: b.sim.z })));
  const seenPos = await B.evaluate(() => NZ.net.bots().map(b => ({ id: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z })));
  const syncErr = Math.max(...simPos.map(s => { const o = seenPos.find(q => q.id === s.id); return o ? Math.hypot(o.x - s.x, o.y - s.y, o.z - s.z) : 1e9; }));
  check(syncErr < 0.25, `the second page draws the bots where the first has them (error ${syncErr.toFixed(3)} units)`);
  const hudB = await B.evaluate(() => document.getElementById('nzNet').innerText.replace(/\n+/g, ' / '));
  check(/P1/.test(hudB) && /P2/.test(hudB) && /BOT/.test(hudB), `scoreboard on the second page: ${hudB}`);

  /* 8. bot difficulty */
  const lockB = await B.evaluate(() => document.querySelectorAll('#nzBotSeg button:disabled').length);
  await A.evaluate(() => NZ.net.setSkill('hard'));
  await waitFor(B, () => NZ.net.round().sk === 'hard', 5000, 'B hears the difficulty');
  const sk = await A.evaluate(ids => ids.map(id => NZ.net.botSim(id).skill.key), bots2.map(b => b.id));
  const segB = await B.evaluate(() => document.querySelector('#nzBotSeg button.on').textContent);
  check(lockB === 2 && sk.every(k => k === 'hard') && segB === 'ZOR', `the first page sets the bots to hard at once; the second shows ${segB} and cannot change it`);

  /* 9. the second player kills a bot that lives on the first page */
  const target = bots2[0];
  const n2 = await B.evaluate(id => window.__t.shoot(id, 40), target.id);
  await waitFor(A, id => !NZ.net.botSim(id).alive, 8000, 'the bot dies on the first page', target.id);
  await waitFor(B, () => NZ.net.me().frags === 1, 5000, 'B credited');
  await waitFor(A, id => (NZ.net.peers().find(p => p.id === id) || {}).frags === 1, 5000, 'A credits B', idB);
  check(n2 > 0, `the second player shot ${target.name} dead in ${n2} rounds; both scoreboards give him the frag`);

  /* 10. a bot shoots the second player */
  const shooter = bots2[1];
  const spotB = await A.evaluate(id => { const s = NZ.net.botSim(id); return { x: s.x, y: s.y, z: s.z, eh: s.eyeH }; }, shooter.id);
  const putB = await B.evaluate(p => {
    const T = window.__t, s = T.spotNear(p.x, p.y, p.z, p.x, p.y + p.eh * 0.7, p.z, 8, 15);
    if (!s) return false;
    T.put(s); T.aim(p.x, p.y + p.eh * 0.7, p.z); player.invT = 0;
    return true;
  }, spotB);
  check(putB, `the second player stands in front of ${shooter.name}`);
  await sleep(500);
  await A.evaluate(id => window.__t.bot(id, { holdT: 0 }), shooter.id);
  await waitFor(B, () => player.hp < 100, 20000, 'the bot hits B');
  check(true, `${shooter.name}, run on the first page, hits the second player`);
  await waitFor(B, () => !player.alive, 30000, 'the bot kills B');
  await sleep(800);
  const wB = await B.evaluate(id => ({ watching: NZ.net.watching(), spec: NZ.net.me().spec }), idA);
  check(wB.spec && wB.watching === idA, 'down, the second player watches the first');

  /* 11. the first page leaves */
  const q0 = (await round(B)).q;
  await closePage(A);
  await waitFor(B, () => NZ.net.round().mine, 20000, 'B takes over');
  await waitFor(B, () => NZ.net.round().ph === 'live' && player.alive, 10000, 'B dealt back in');
  const tk = await B.evaluate(() => ({ r: NZ.net.round(), bots: NZ.net.bots().map(b => ({ id: b.id, here: b.here, team: b.team, x: b.sim && b.sim.x, z: b.sim && b.sim.z })) }));
  check(tk.r.q !== q0 && tk.r.ro.length === 4 && tk.r.ro.filter(r => !r.bot).length === 1 && tk.bots.length === 3 && tk.bots.every(b => b.here) &&
    tk.bots.filter(b => b.team === 0).length === 1,
    `the second page runs the match now: ${tk.r.ro.map(r => r.name + (r.team ? ' (MAVİ)' : ' (KIRMIZI)')).join(', ')}`);
  await sleep(4000);
  const tk2 = await B.evaluate(() => NZ.net.bots().map(b => ({ id: b.id, x: b.sim.x, z: b.sim.z })));
  const mv = tk.bots.map(b => { const o = tk2.find(q => q.id === b.id); return o ? Math.hypot(o.x - b.x, o.z - b.z) : 0; });
  check(mv.every(d => d > 8), `and its bots move (${mv.map(d => d.toFixed(0)).join(', ')} units in 4 s)`);
  check((await B.evaluate(() => NZ.net.status().errors)) === 0, 'no multiplayer errors');
} catch (err) {
  failures++;
  say('FAIL', err.message);
  for (const o of open) {
    try {
      say(`  ${o.page.nzName}:`, JSON.stringify(await o.page.evaluate(() => ({
        me: NZ.net.me(), round: NZ.net.round(), bots: NZ.net.bots().map(b => [b.id, b.team, b.here, b.shown, b.sim && b.sim.alive, b.hp]),
        status: NZ.net.status(), alive: player.alive, hp: player.hp
      }))));
    } catch (e) { say(`  ${o.page.nzName}: closed`); }
  }
  say('  server log:\n' + srvLog.split('\n').slice(-12).join('\n'));
} finally {
  const gameErrors = errors.filter(e => !/favicon|ERR_|net::/.test(e));
  check(gameErrors.length === 0, `no console errors${gameErrors.length ? ':\n  ' + gameErrors.slice(0, 8).join('\n  ') : ''}`);
  await browser.close().catch(() => { });
  srv.kill('SIGTERM');
  say(failures ? `${failures} check(s) failed` : 'all team-match checks passed');
  process.exit(failures ? 1 : 0);
}
