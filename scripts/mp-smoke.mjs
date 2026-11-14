/* ===========================================================================
   mp-smoke.mjs -- multiplayer end-to-end check, headless: the free-for-all
   deathmatch (&mode=dm), on ER MEYDANI or, with --level 4, on ABLUKA. The
   team match with bots has its own check, scripts/team-smoke.mjs (which
   also takes --level 4).

   Starts server/mp-server.mjs on a spare port, opens N real game pages in
   separate browser profiles, joins them to one room and checks, in order:

     1. every page boots, reaches the server and is welcomed
     2. every pair connects DIRECTLY (WebRTC data channels open)
     3. each page draws the others where they really are (state sync)
     4. a shot from page A lands on page B, B's health drops, B dies,
        everyone's scoreboard gives A the frag, B respawns elsewhere
     5. the room refuses a stale build (protocol) and a full room
     6. a page that leaves disappears from the others
   and fails on any console error from the game.

   With --level 4 the room plays ABLUKA, the fenced corner of Mission 4, and
   it also checks that every spawn point is inside the arena, that a facade
   pane and a crate shot on A break the same way on B, and that a player who
   joins afterwards is handed the same damage.

     node scripts/mp-smoke.mjs                 2 players, ER MEYDANI
     node scripts/mp-smoke.mjs --players 3     3 players
     node scripts/mp-smoke.mjs --level 4       2 players, ABLUKA
     CHROME=/path/to/chrome node scripts/mp-smoke.mjs

   Software rendering (SwiftShader) is slow: allow a minute or two.
   ======================================================================== */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const N = Math.max(2, Math.min(4, parseInt(argv[argv.indexOf('--players') + 1], 10) || 2));
const LEVEL = argv.includes('--level') && parseInt(argv[argv.indexOf('--level') + 1], 10) === 4 ? 4 : 2;
const PORT = 4300 + Math.floor(Math.random() * 500);
const ROOM = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
/* the wire version the server will accept, read from the server itself */
const PROTO = +(/const PROTO = (\d+);/.exec(fs.readFileSync(path.join(REPO, 'server', 'mp-server.mjs'), 'utf8')) || [0, 1])[1];
const CHROME = process.env.CHROME || [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell',
  '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
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
async function waitFor(page, expr, ms, what) {
  const until = Date.now() + ms;
  for (; ;) {
    let v = false;
    try { v = await page.evaluate(expr); } catch { v = false; }
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting for ' + (what || expr));
    await sleep(250);
  }
}

if (!CHROME) { console.error('mp-smoke: no Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }

/* ------------------------------------------------------------- server -- */
const srv = spawn(process.execPath, [path.join(REPO, 'server', 'mp-server.mjs')], {
  cwd: REPO, env: { ...process.env, NZ_PORT: String(PORT), PORT: '', HOST: '127.0.0.1', NZ_STUN: '', NZ_MAX_PLAYERS: String(N) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
for (let i = 0; i < 40 && !/multiplayer server on/.test(srvLog); i++) await sleep(100);
if (!/multiplayer server on/.test(srvLog)) { console.error(srvLog); process.exit(2); }
say(`server on :${PORT}, room ${ROOM}, ${N} players, mission ${LEVEL}`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
    /* host candidates as plain IPs, so separate profiles can reach each other here */
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--mute-audio']
});

const pages = [], errors = [];
try {
  const url = `http://127.0.0.1:${PORT}/NUKEM.html?nzq=low#mp=${ROOM}&level=${LEVEL}&mode=dm`;
  /* slow software rendering: give a crowded machine proportionally longer */
  const SLOW = N / 2;
  for (let i = 0; i < N; i++) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 400, height: 250 });
    page.on('console', m => {
      if (m.type() === 'error') errors.push(`page ${i}: ${m.text()}`);
    });
    page.on('pageerror', e => errors.push(`page ${i}: ${e.message}`));
    page.on('response', r => { if (r.status() >= 400) errors.push(`page ${i}: HTTP ${r.status()} ${r.url()}`); });
    await page.evaluateOnNewDocument(n => { try { localStorage.setItem('nuke-zone-3d:mp-name:v1', n); } catch (e) { } }, 'P' + (i + 1));
    /* with 3+ players the last one watches in third person: its own figure and
       the others' figures on screen together */
    await page.goto(N >= 3 && i === N - 1 ? url + '&view=3' : url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    pages.push(page);
  }

  /* 1. boot + welcome */
  for (let i = 0; i < N; i++) {
    await waitFor(pages[i], 'typeof state !== "undefined" && state.booted', 240000, `page ${i} boot`);
    await waitFor(pages[i], 'window.NZ && NZ.net && NZ.net.me().welcomed', 60000 * SLOW, `page ${i} welcome`);
  }
  check(true, `all ${N} pages booted and were welcomed`);
  const lobby = await pages[0].evaluate(() => ({
    link: document.getElementById('nzLink') && document.getElementById('nzLink').value,
    start: document.getElementById('btnStart').textContent,
    title: document.querySelector('#scTitle h2').textContent
  }));
  check(lobby.link && lobby.link.includes('#mp=' + ROOM) && lobby.link.includes('mode=dm') && lobby.start === 'MAÇA KATIL', `lobby UI (${lobby.title} / ${lobby.start})`);
  check(await pages[0].evaluate(() => NZ.net.mode() === 'dm' && NZ.net.round().ph === 'wait'), 'the room is a deathmatch: no rounds, no bots');

  /* everyone presses JOIN MATCH */
  for (const p of pages) await p.evaluate(() => { document.getElementById('btnStart').click(); });
  for (let i = 0; i < N; i++) await waitFor(pages[i], 'NZ.net.me().inMatch && player.alive', 10000, `page ${i} in match`);
  const noEnemies = await pages[0].evaluate(() => enemies.length === 0 && pickups.length === 0 && NZ.net.spawnPoints().length > 5);
  check(noEnemies, 'match level: no enemies, no pickups, spawn points from the level');
  if (LEVEL === 4) {
    const ar = await pages[0].evaluate(() => ({ a: NZ.net.arena(), map: NZ.net.map(), inside: NZ.net.spawnPoints().every(s => NZ.net.inArena(s.x, s.z)), me: NZ.net.inArena(player.x, player.z) }));
    check(ar.map.name === 'ABLUKA' && ar.a.fenced && ar.a.fenceRuns >= 10 && ar.inside && ar.me,
      `ABLUKA arena: ${ar.a.cells} cells, ${ar.a.fenceRuns} fence runs, every spawn inside`);
  }

  /* 2. direct connections */
  for (let i = 0; i < N; i++) {
    await waitFor(pages[i], `NZ.net.peers().filter(p => p.open).length === ${N - 1}`, 30000 * SLOW, `page ${i} connected to all`);
    await waitFor(pages[i], `NZ.net.peers().every(p => p.shown && p.rtt > 0)`, 20000 * SLOW, `page ${i} sees everyone`);
  }
  const routes = await pages[0].evaluate(() => NZ.net.peers().map(p => p.route + ' ' + Math.round(p.rtt * 1000) + 'ms puppet=' + p.puppet));
  check(true, `connected: ${routes.join(', ')}`);

  /* 3. state sync: move B somewhere known; A must draw it there */
  const ids = [];
  for (const p of pages) ids.push(await p.evaluate(() => NZ.net.me().id));
  const spot = await pages[1].evaluate(() => {
    const sp = NZ.net.spawnPoints()[3];
    player.x = sp.x; player.z = sp.z; player.y = sp.y; player.vy = 0; player.yaw = 0.7;
    return { x: sp.x, y: sp.y, z: sp.z };
  });
  await sleep(2500 * SLOW);
  const real = await pages[1].evaluate(() => ({ x: player.x, y: player.y, z: player.z, yaw: player.yaw }));
  const seen = await pages[0].evaluate(id => (NZ.net.peers().find(p => p.id === id) || {}).pos, ids[1]);
  const err = seen ? Math.hypot(seen.x - real.x, seen.z - real.z) : 1e9;
  say(`  B set to (${spot.x.toFixed(2)}, ${spot.z.toFixed(2)}), B is at (${real.x.toFixed(2)}, ${real.z.toFixed(2)}) yaw ${real.yaw.toFixed(2)}; A draws (${seen && seen.x.toFixed(2)}, ${seen && seen.z.toFixed(2)}) yaw ${seen && seen.yaw.toFixed(2)}`);
  check(err < 0.25 && seen && Math.abs(Math.atan2(Math.sin(seen.yaw - real.yaw), Math.cos(seen.yaw - real.yaw))) < 0.05, `A draws B where B really is (error ${err.toFixed(3)} units)`);

  /* interpolation smoothness: B walks a straight line; A samples what it draws */
  /* along x on mission 2; on ABLUKA north up 232 Sk, which stays inside */
  const AX = LEVEL === 4 ? 'z' : 'x', STEP = LEVEL === 4 ? -0.35 : 0.35;
  await pages[1].evaluate((ax, st) => {
    window.__walk = setInterval(() => { player[ax] += st; }, 16);
  }, AX, STEP);
  const trail = [];
  for (let k = 0; k < 30; k++) {
    trail.push(await pages[0].evaluate((id, ax) => { const p = NZ.net.peers().find(q => q.id === id); return p && p.pos ? p.pos[ax] : null; }, ids[1], AX));
    await sleep(33);
  }
  await pages[1].evaluate(() => clearInterval(window.__walk));
  let back = 0;
  for (let k = 1; k < trail.length; k++) if (trail[k] !== null && trail[k - 1] !== null && (trail[k] - trail[k - 1]) * Math.sign(STEP) < -1e-4) back++;
  check(back === 0, `remote movement never jumps backwards (${back} reversals in ${trail.length} samples)`);
  const lag = await pages[0].evaluate(id => { const p = NZ.net.peers().find(q => q.id === id); return p ? { late: p.late, gap: p.gap } : null; }, ids[1]);
  say(`  interpolation: packet gap ${(lag.gap * 1000).toFixed(1)} ms, jitter ${(lag.late * 1000).toFixed(1)} ms`);

  /* 4. a shot: A aims at B's chest (as A draws it) and fires until B drops */
  await pages[1].evaluate(() => { player.invT = 0; });
  await sleep(600);
  const before = await pages[1].evaluate(() => ({ hp: player.hp, life: NZ.net.me().life }));
  const shots = await pages[0].evaluate(async (id) => {
    const w = WPN[player.weapon]; w.spread = 0; w.adsSpread = 0;
    player.moveBlend = 0; player.sprint = 0; player.dash = 0; player.onGround = true;
    let n = 0;
    for (; n < 40; n++) {
      const peer = NZ.net.peers().find(p => p.id === id);
      if (!peer || !peer.pos || !peer.pos.alive) break;
      const parts = NZ.net.peerHitParts(id);
      const body = parts.find(p => p.zone === 'body') || parts[0];
      if (!body) { await new Promise(r => setTimeout(r, 100)); continue; }
      const tx = (body.ax + body.bx) / 2, ty = (body.ay + body.by) / 2, tz = (body.az + body.bz) / 2;
      /* stand 12 units away from B, in the open, facing it */
      if (n === 0) { player.x = tx + 12; player.z = tz; player.y = peer.pos.y; }
      const ox = player.x, oy = player.y + EYE - 0.25, oz = player.z;
      const dx = tx - ox, dy = ty - oy, dz = tz - oz;
      player.yaw = Math.atan2(-dx, -dz); player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      camera.rotation.set(player.pitch, player.yaw, 0);
      fire();
      await new Promise(r => setTimeout(r, 120));
    }
    return n;
  }, ids[1]);
  await waitFor(pages[1], '!player.alive || NZ.net.me().deaths > 0', 8000 * SLOW, 'B dies');
  const dead = await pages[1].evaluate(() => ({ hp: player.hp, deaths: NZ.net.me().deaths }));
  check(dead.deaths === 1, `A shot B dead in ${shots} rounds (B hp ${before.hp} -> ${dead.hp})`);
  for (let i = 0; i < N; i++) {
    await waitFor(pages[i], i === 0 ? `NZ.net.me().frags === 1` : `NZ.net.peers().find(p => p.id === '${ids[0]}').frags === 1`, 6000, `page ${i} credits A`);
    if (N >= 3 && i === N - 1) {
      const tp = await pages[i].evaluate(() => ({ third: NZ.view && NZ.view.third, puppets: NZ.hero && NZ.hero.puppet ? NZ.hero.puppet.count() : -1 }));
      check(tp.third && tp.puppets === N - 1, `third-person observer draws its own figure and ${tp.puppets} other players`);
    }
  }
  check(true, 'every scoreboard gives A the frag');
  const feed = await pages[0].evaluate(() => document.getElementById('feed').textContent);
  check(/P1.*P2/.test(feed), `kill feed on A: "${feed.slice(0, 60)}"`);
  await waitFor(pages[1], `player.alive && NZ.net.me().life !== ${before.life}`, 8000 * SLOW, 'B respawns');
  const resp = await pages[1].evaluate(() => ({ hp: player.hp, x: player.x, z: player.z, has: player.has.slice() }));
  check(resp.hp === 100, `B respawned with full health at (${resp.x.toFixed(1)}, ${resp.z.toFixed(1)})`);
  /* ESC opens the pause menu in a match and closes it again (it used to throw) */
  const pz = await pages[0].evaluate(() => {
    togglePause();
    const shown = document.getElementById('scPause').classList.contains('show');
    togglePause();
    return shown && state.playing && !document.getElementById('scPause').classList.contains('show');
  });
  check(pz, 'ESC opens and closes the pause menu in a match');

  /* 4b. ABLUKA: what A breaks, B sees broken */
  let paneI = -1, crateKey = null;
  if (LEVEL === 4) {
    /* a facade pane A can see from inside the arena, and a crate in it */
    const pick = await pages[0].evaluate(() => {
      const G = NZ.destruct && NZ.destruct.glass;
      let pane = null;
      if (G && G.ready()) {
        for (let i = 0; i < G.panes.length; i++) {
          const d = G.panes[i], st = G.state(i);
          if (!st || st.stage !== 0) continue;
          for (const sgn of [1, -1]) for (const back of [10, 14, 18, 24]) {
            const sx = d.center[0] + d.normal[0] * back * sgn, sz = d.center[2] + d.normal[2] * back * sgn;
            const cx = Math.floor(sx / CELL), cz = Math.floor(sz / CELL);
            if (!NZ.net.inArena(sx, sz) || blockedCell(cx, cz)) continue;
            const fy = floorAt(cx, cz), eye = new THREE.Vector3(sx, fy + EYE - 0.25, sz);
            const dir = new THREE.Vector3(d.center[0] - sx, d.center[1] - eye.y, d.center[2] - sz);
            const dist = dir.length(); dir.normalize();
            if (Math.abs(castWall(eye, dir, dist + 6) - dist) > 1.2) continue;
            const score = Math.hypot(sx - 540, sz - 170);
            if (!pane || score < pane.score) pane = { i, id: d.id, sx, sz, fy, tx: d.center[0], ty: d.center[1], tz: d.center[2], score };
          }
        }
      }
      let crate = null;
      try {
        for (const c of NZ.destruct.snapshot().crates) {
          if (!NZ.net.inArena(c.cx * CELL + 2, c.cy * CELL + 2)) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ax = c.cx + dx * 3, ay = c.cy + dy * 3;
            if (!NZ.net.inArena(ax * CELL + 2, ay * CELL + 2) || blockedCell(ax, ay) || blockedCell(c.cx + dx, c.cy + dy) || blockedCell(c.cx + dx * 2, c.cy + dy * 2)) continue;
            const fy = floorAt(ax, ay);
            crate = { cx: c.cx, cy: c.cy, hp: c.hp, sx: ax * CELL + CELL / 2, sz: ay * CELL + CELL / 2, fy,
              tx: c.cx * CELL + CELL / 2, ty: fy + 2.0, tz: c.cy * CELL + CELL / 2 };
            break;
          }
          if (crate) break;
        }
      } catch (e) { }
      return { pane, crate, panes: G ? G.panes.length : 0 };
    });
    say(`  ${pick.panes} breakable panes; target pane ${pick.pane ? pick.pane.id : 'none'}, crate ${pick.crate ? pick.crate.cx + ',' + pick.crate.cy : 'none'}`);
    const shoot = (t, n) => pages[0].evaluate(async (t, n) => {
      const w = WPN[player.weapon]; w.spread = 0; w.adsSpread = 0;
      player.x = t.sx; player.z = t.sz; player.y = t.fy; player.vy = 0; player.invT = 99;
      player.moveBlend = 0; player.sprint = 0; player.dash = 0; player.onGround = true;
      for (let k = 0; k < n; k++) {
        const ox = player.x, oy = player.y + EYE - 0.25, oz = player.z;
        const dx = t.tx - ox, dy = t.ty - oy, dz = t.tz - oz;
        player.yaw = Math.atan2(-dx, -dz); player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        camera.rotation.set(player.pitch, player.yaw, 0);
        fire();
        await new Promise(r => setTimeout(r, 160));
      }
    }, t, n);
    if (check(!!pick.pane, 'a breakable pane in reach of the arena')) {
      paneI = pick.pane.i;
      await shoot(pick.pane, 3);
      await sleep(2500 * SLOW);
      const ga = await pages[0].evaluate(i => NZ.destruct.glass.state(i), paneI);
      const gb = await pages[1].evaluate(i => NZ.destruct.glass.state(i), paneI);
      check(ga.stage > 0 && gb.stage === ga.stage && gb.energy === ga.energy && gb.remaining === ga.remaining,
        `pane ${ga.id}: A stage ${ga.stage} energy ${ga.energy}, B stage ${gb.stage} energy ${gb.energy} (same cracks on both)`);
    }
    if (check(!!pick.crate, 'a crate inside the arena')) {
      const c = pick.crate;
      crateKey = c.cx + ',' + c.cy;
      await shoot(c, 12);
      await sleep(2500 * SLOW);
      const ka = await pages[0].evaluate(k => NZ.destruct.brokenCells.some(b => b[0] + ',' + b[1] === k), crateKey);
      const kb = await pages[1].evaluate(k => NZ.destruct.brokenCells.some(b => b[0] + ',' + b[1] === k), crateKey);
      check(ka && kb, `crate ${crateKey} broken on A (${ka}) and on B (${kb})`);
    }
    const rep = await pages[1].evaluate(() => NZ.net.damage());
    say(`  B replayed ${rep.replayed} impacts from A`);
  }

  /* 5. the server turns away a stale protocol and a full room */
  const probe = (msg) => new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/signal`);
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', d => { res(JSON.parse(String(d))); ws.close(); });
    ws.on('error', () => res(null));
    setTimeout(() => res(null), 4000);
  });
  const v = await probe({ t: 'join', room: ROOM, proto: 999, name: 'old', level: 2 });
  check(v && v.t === 'error' && v.code === 'version', `stale page refused (${v && v.code})`);
  const f = await probe({ t: 'join', room: ROOM, proto: PROTO, name: 'extra', level: LEVEL });
  check(f && f.t === 'error' && f.code === 'full', `full room refused (${f && f.code})`);
  const l = await probe({ t: 'join', room: ROOM, proto: PROTO, name: 'lost', level: LEVEL === 4 ? 2 : 4 });
  check(l && l.t === 'error' && l.code === 'level' && l.level === LEVEL, `wrong mission redirected to ${l && l.level}`);

  /* 6. leaving */
  await pages[N - 1].close();
  await waitFor(pages[0], `NZ.net.peers().length === ${N - 2}`, 15000 * SLOW, 'leaver removed');
  check(true, 'a player who closes the tab disappears from the others');

  /* 7. ABLUKA: someone who joins now is handed what is already broken */
  if (LEVEL === 4 && (paneI >= 0 || crateKey)) {
    const ctx = await browser.createBrowserContext();
    const late = await ctx.newPage();
    await late.setViewport({ width: 400, height: 250 });
    late.on('console', m => { if (m.type() === 'error') errors.push(`late: ${m.text()}`); });
    late.on('pageerror', e => errors.push(`late: ${e.message}`));
    await late.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitFor(late, 'typeof state !== "undefined" && state.booted && NZ.net.me().welcomed', 240000, 'late page boot');
    await waitFor(late, 'NZ.net.peers().some(p => p.open)', 30000, 'late page connects');
    await waitFor(late, 'NZ.net.damage().snapshotsIn > 0', 20000, 'late page gets the damage');
    await sleep(1500);
    const lp = paneI >= 0 ? await late.evaluate(i => NZ.destruct.glass.state(i), paneI) : null;
    const ap = paneI >= 0 ? await pages[0].evaluate(i => NZ.destruct.glass.state(i), paneI) : null;
    if (lp) check(lp.stage === ap.stage && lp.stage > 0, `late arrival's pane: stage ${lp.stage}, A has ${ap.stage}`);
    if (crateKey) {
      const lk = await late.evaluate(k => NZ.destruct.brokenCells.some(b => b[0] + ',' + b[1] === k), crateKey);
      check(lk, `late arrival's crate ${crateKey} is broken too`);
    }
    await late.close();
  }

  const hudTxt = await pages[0].evaluate(() => document.getElementById('nzNet').textContent);
  say(`  HUD on A: ${hudTxt}`);
  const st = await pages[0].evaluate(() => NZ.net.status());
  check(st.errors === 0, `no multiplayer errors (${st.errors})`);
  check(await pages[0].evaluate(() => NZ.net.bots().length === 0), 'no bots in a deathmatch');
} catch (err) {
  failures++;
  say('FAIL', err.message);
  for (let i = 0; i < pages.length; i++) {
    try { say(`  page ${i}:`, JSON.stringify(await pages[i].evaluate(() => ({ booted: typeof state !== 'undefined' && state.booted, net: window.NZ && NZ.net && NZ.net.status ? NZ.net.status() : null, me: window.NZ && NZ.net && NZ.net.me ? NZ.net.me() : null, peers: window.NZ && NZ.net && NZ.net.peers ? NZ.net.peers().map(p => p.conn + '/' + p.open) : null })))); } catch (e) { say(`  page ${i}: closed`); }
  }
  say('  server log:\n' + srvLog.split('\n').slice(-12).join('\n'));
} finally {
  const gameErrors = errors.filter(e => !/favicon|ERR_|net::/.test(e));
  check(gameErrors.length === 0, `no console errors${gameErrors.length ? ':\n  ' + gameErrors.slice(0, 8).join('\n  ') : ''}`);
  await browser.close().catch(() => { });
  srv.kill('SIGTERM');
  say(failures ? `${failures} check(s) failed` : 'all multiplayer checks passed');
  process.exit(failures ? 1 : 0);
}
