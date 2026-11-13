#!/usr/bin/env node
/* Durable-save browser regression.  A real headless Chrome process writes a
   manual save, exits, then a second process reuses the profile and continues
   the game.  CDP is used directly so the check has no npm dependencies. */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

if (typeof fetch !== 'function' || typeof WebSocket !== 'function')
  throw new Error('verify-save requires Node.js 22+ (global fetch and WebSocket).');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function chromePath() {
  const candidates = [
    process.env.CRITIC_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

function contentType(file) {
  if (/\.html$/i.test(file)) return 'text/html; charset=utf-8';
  if (/\.(?:js|mjs)$/i.test(file)) return 'text/javascript; charset=utf-8';
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.jpe?g$/i.test(file)) return 'image/jpeg';
  return 'application/octet-stream';
}

async function serveRoot() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const rel = pathname === '/' ? 'NUKEM.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!(file === ROOT || file.startsWith(ROOT + path.sep))) {
      res.writeHead(403).end('forbidden'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('missing'); return; }
      /* Keep the check independent of external network access. */
      if (rel.toLowerCase() === 'nukem.html') {
        data = Buffer.from(data.toString('utf8').replace(
          /<script src="https:\/\/unpkg\.com\/three@0\.149\.0\/build\/three\.min\.js"><\/script>/,
          '<script src="vendor/three.r149.min.js"></script>'));
      }
      res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
        return;
      }
      for (const listener of this.listeners.get(msg.method) || []) listener(msg.params || {});
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  call(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: err => { clearTimeout(timer); reject(err); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 10000) {
    const result = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    }, timeoutMs);
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function connectDebugger(port, targetNeedle) {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find(item => item.type === 'page' && item.url.includes(targetNeedle));
  }, 30000, 'Chrome page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

const chrome = chromePath();
if (!chrome) {
  console.error('SAVE VERIFY FAIL: Chrome/Edge not found');
  process.exit(1);
}

let server;
let profile;
let child = null;
let cdp = null;
let childError = null;
const issues = [];

async function launch(pageURL) {
  const activePort = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(activePort)) fs.rmSync(activePort, { force: true });
  const angleBackend = process.platform === 'win32' ? 'd3d11' : 'swiftshader';
  const args = [
    '--headless=new', '--use-gl=angle', `--use-angle=${angleBackend}`,
    '--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-breakpad', '--disable-crash-reporter',
    '--noerrdialogs', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1280,720', pageURL
  ];
  if (process.platform === 'linux') args.splice(1, 0, '--no-sandbox', '--disable-setuid-sandbox');
  childError = null;
  child = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });
  child.once('error', err => { childError = err; });
  const portInfo = await waitFor(() => {
    if (childError) return { error: childError.message };
    if (child.exitCode !== null) return { error: `Chrome exited ${child.exitCode}` };
    if (!fs.existsSync(activePort)) return null;
    const lines = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
    return lines[0] ? { port: Number(lines[0]) } : null;
  }, 20000, 'Chrome DevTools port');
  if (portInfo.error) throw new Error(portInfo.error);
  cdp = await connectDebugger(portInfo.port, 'NUKEM.html');
  cdp.on('Runtime.exceptionThrown', params =>
    issues.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'runtime exception'));
  cdp.on('Runtime.consoleAPICalled', params => {
    if (params.type === 'error')
      issues.push(params.args.map(arg => arg.value || arg.description || '').join(' '));
  });
  cdp.on('Log.entryAdded', params => {
    if (params.entry?.level === 'error')
      issues.push(params.entry.text + (params.entry.url ? ` @ ${params.entry.url}` : ''));
  });
  await cdp.call('Runtime.enable');
  await cdp.call('Log.enable');
  await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false
  });
  await waitFor(async () => cdp.eval(`(() => ({
    booted: typeof state !== 'undefined' && state.booted,
    title: !!document.getElementById('scTitle')?.classList.contains('show'),
    save: typeof saveManualGame === 'function'
  }))()`).then(value => value.booted && value.title && value.save),
  180000, 'game title and save systems');
}

async function closeChrome() {
  try {
    if (cdp?.ws?.readyState === WebSocket.OPEN)
      await cdp.call('Browser.close', {}, 5000);
  } catch {}
  try { if (cdp?.ws?.readyState === WebSocket.OPEN) cdp.ws.close(); } catch {}
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)),
      sleep(6000)
    ]);
  }
  if (child && child.exitCode === null) {
    try {
      if (process.platform === 'win32' && child.pid)
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
        });
      else child.kill('SIGKILL');
    } catch {}
    await Promise.race([
      new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)),
      sleep(3000)
    ]);
  }
  child = null;
  cdp = null;
  await sleep(250);
}

let pass = false;
try {
  const served = await serveRoot();
  server = served.server;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nz-save-'));
  const saveLevel = process.env.NZ_SAVE_LEVEL === '2' ? 2 : 1;
  const directFile = process.env.NZ_SAVE_PROTOCOL === 'file';
  const pageBase = directFile ? pathToFileURL(path.join(ROOT, 'NUKEM.html')).href :
    `http://127.0.0.1:${served.port}/NUKEM.html`;
  const pageURL = `${pageBase}?nzq=low#skill=0&level=${saveLevel}&fresh=1`;
  console.log(`Durable-save Chrome verification\n  INFO  ${pageURL}`);

  console.log('  INFO  launch 1: create a paused manual save');
  await launch(pageURL);
  const written = await cdp.eval(`(() => {
    const emptyCheckpoint = document.getElementById('btnContinue');
    const emptyStart = {
      visible: !!emptyCheckpoint && getComputedStyle(emptyCheckpoint).display !== 'none',
      disabled: !!emptyCheckpoint?.disabled,
      label: emptyCheckpoint?.textContent || '',
      info: document.getElementById('continueInfo')?.textContent || ''
    };
    startGame();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    let pos = null;
    for (let cy = 1; cy < MH - 1 && !pos; cy++) for (let cx = 1; cx < MW - 1; cx++) {
      const x = cx * CELL + CELL / 2, z = cy * CELL + CELL / 2, y = floorAt(cx, cy);
      if (Math.hypot(x - player.x, z - player.z) > CELL * 8 && canStand(x, z, PRAD, y)) {
        pos = { x, y, z }; break;
      }
    }
    if (!pos) pos = { x: player.x, y: player.y, z: player.z };
    player.x = pos.x; player.y = pos.y; player.z = pos.z;
    player.yaw = 1.2345; player.pitch = -.321; player.vy = 0; player.onGround = true;
    player.hp = 73; player.armor = 41; player.medpack = 62; player.crawling = true;
    player.has = WPN.map((_, i) => i === 0 || i === 4 || i === 8);
    Object.assign(player.ammo, {
      clip: 91, shell: 11, chain: 37, rocket: 9, rifle: 77,
      grenade: 4, ak: 33, dmr: 19, nullcore: 2
    });
    player.weapon = 8; player.pending = -1; player.keys.red = true; player.suppressed = true;
    player.kills = Math.min(2, totalKills); player.secrets = 2; player.time = 123.456;
    state.graceT = 4.25;

    const door = DOORS[0];
    if (door) { door.open = .63; door.tgt = 1; door.used = true; restoreDoorPose(door); }
    const lift = LIFTS[0];
    if (lift) {
      lift.y = (lift.lo + lift.hi) * .5; lift.tgt = lift.hi;
      lift.waitT = 1.25; lift.standT = .75; lift.lock = true;
      if (lift.mesh) lift.mesh.position.y = lift.y - .25;
    }
    const wounded = enemies[0], corpse = enemies[1];
    if (wounded) { wounded.hp = Math.max(1, Math.floor(wounded.cfg.hp * .5)); wounded.ai.alert = .42; }
    if (corpse) {
      corpse.hp = 0; corpse.dead = true; corpse.state = 'dead'; corpse.deathT = 1;
      corpse.deathSide = -1; corpse.deathSettled = true; corpse.vx = corpse.vz = 0;
    }
    makePickup('ddmr', pos.x + .25, pos.z + .25, pos.y);
    seen.fill(0); [1, 17, 501].forEach(i => { if (i < seen.length) seen[i] = 1; });
    const cratesBroken = NZ.destruct.breakAll();
    const glass = NZ.destruct.glass.damage(0, 6, 24);
    document.getElementById('btnSave').click();
    const raw = localStorage.getItem(MANUAL_SAVE_KEY), saved = raw && JSON.parse(raw);
    return {
      emptyStart,
      saved: !!saved, paused: state.paused,
      status: document.getElementById('saveStatus').textContent,
      level: saved && saved.level, hp: saved && saved.player.hp,
      weapon: saved && saved.player.weapon,
      cratesBroken, storedBroken: saved?.world?.destruct?.broken?.length || 0,
      glassStage: glass?.stage || 0,
      storedGlassStage: saved?.world?.destruct?.glass?.[0]?.stage || 0,
      woundedUid: wounded?.uid ?? -1, corpseUid: corpse?.uid ?? -1,
      pickupCount: saved?.world?.pickups?.length || 0
    };
  })()`, 60000);
  const requiresStreetDestruct = saveLevel === 1;
  if (!written.emptyStart.visible || !written.emptyStart.disabled ||
      written.emptyStart.label !== 'SON KAYDI YÜKLE' || !/HENÜZ KAYIT YOK/.test(written.emptyStart.info) ||
      !written.saved || !written.paused || !/OYUN KAYDEDİLDİ/.test(written.status) ||
      written.level !== saveLevel || written.hp !== 73 || written.weapon !== 8 ||
      (requiresStreetDestruct && (written.cratesBroken < 1 || written.storedBroken !== written.cratesBroken ||
        written.glassStage < 1 || written.storedGlassStage !== written.glassStage)))
    throw new Error(`save write mismatch: ${JSON.stringify(written)}`);
  console.log(`  INFO  stored ${written.pickupCount} pickups, ${written.cratesBroken} broken crates, glass stage ${written.glassStage}`);

  await closeChrome();

  console.log('  INFO  launch 2: discover the slot and Continue');
  await launch(pageURL);
  const restored = await cdp.eval(`(() => {
    const fail = [], eq = (a, b, label) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) fail.push(label);
    };
    const saved = JSON.parse(localStorage.getItem(MANUAL_SAVE_KEY) || 'null');
    const button = document.getElementById('btnContinue');
    const before = {
      level: LEVEL,
      visible: !!button && getComputedStyle(button).display !== 'none',
      disabled: !!button?.disabled,
      begin: document.getElementById('btnStart')?.textContent || '',
      info: document.getElementById('continueInfo')?.textContent || ''
    };
    button.click();
    const continuePlaying = state.playing;
    /* Freeze in the same task as the click, before an animation frame can
       advance AI, doors, lifts, or the saved play clock. */
    state.playing = false; state.paused = true;

    const p = saved.player;
    for (const key of ['x','y','z','yaw','pitch','vy','hp','armor','medpack','weapon','kills','secrets','time'])
      if (Math.abs(Number(player[key]) - Number(p[key])) > 1e-7) fail.push('player.' + key);
    eq(player.has, p.has, 'player.has');
    eq(Object.fromEntries(Object.keys(AMMOMAX).map(key => [key, player.ammo[key]])), p.ammo, 'player.ammo');
    if (player.onGround !== p.onGround) fail.push('player.onGround');
    if (player.crawling !== p.crawling) fail.push('player.crawling');
    if (player.keys.red !== p.redKey) fail.push('player.redKey');
    if (player.suppressed !== p.suppressed) fail.push('player.suppressed');
    if (Math.abs(state.graceT - saved.world.graceT) > 1e-7) fail.push('world.graceT');

    eq(DOORS.map(d => ({ cx: d.cx, cy: d.cy, kind: d.kind, open: d.open, tgt: d.tgt,
      used: !!d.used, locked: !!d.locked })), saved.world.doors, 'world.doors');
    eq(LIFTS.map(L => ({ x0: L.x0, y0: L.y0, y: L.y, tgt: L.tgt, waitT: L.waitT,
      standT: L.standT, lock: !!L.lock })), saved.world.lifts, 'world.lifts');
    const liveSeen = [];
    for (let i = 0; i < seen.length; i++) if (seen[i]) liveSeen.push(i);
    eq(liveSeen, saved.world.seen, 'world.seen');
    eq(pickups.filter(pick => !pick.taken).map(pick => ({
      kind: pick.kind, x: pick.x, y: pick.y, z: pick.z
    })), saved.world.pickups, 'world.pickups');

    for (const uid of [${written.woundedUid}, ${written.corpseUid}]) {
      const expected = saved.world.enemies.find(enemy => enemy.uid === uid);
      const live = enemies[uid];
      if (!expected || !live || live.kind !== expected.kind) { fail.push('enemy.' + uid + '.identity'); continue; }
      for (const key of ['x','y','z','hp','state','dead','deathT','deathSide','deathSettled'])
        if (live[key] !== expected.actor[key]) fail.push('enemy.' + uid + '.' + key);
      if (uid === ${written.woundedUid} && Math.abs(live.ai.alert - expected.ai.alert) > 1e-7)
        fail.push('enemy.' + uid + '.ai.alert');
    }
    eq(NZ.destruct.snapshot(), saved.world.destruct, 'world.destruct');
    return {
      fail, before, continuePlaying, hp: player.hp, armor: player.armor,
      weapon: player.weapon, position: [player.x, player.y, player.z],
      status: document.getElementById('msg')?.textContent || ''
    };
  })()`, 60000);
  if (!restored.before.visible || restored.before.disabled || restored.before.level !== saveLevel ||
      restored.before.begin !== 'YENİDEN BAŞLA' || !new RegExp(`GÖREV ${saveLevel}`).test(restored.before.info) ||
      !restored.continuePlaying || restored.fail.length)
    throw new Error(`restore mismatch: ${JSON.stringify(restored)}`);

  /* A level tweak after a checkpoint was written must not throw the player
     back to the title screen. Corrupt only the world-layout portion here and
     prove the compatibility path still restores the player state. */
  const compatible = await cdp.eval(`(() => {
    const saved = JSON.parse(localStorage.getItem(MANUAL_SAVE_KEY) || 'null');
    saved.world.enemies.pop();
    saved.world.pickups = [{ kind: 'constructor', x: 0, y: 0, z: 0 }];
    localStorage.setItem(MANUAL_SAVE_KEY, JSON.stringify(saved));
    state.playing = false; state.paused = false; showScreen('scTitle');
    document.getElementById('btnContinue').click();
    return {
      playing: state.playing,
      compatible: lastRestoreWasCompatible,
      hp: player.hp,
      armor: player.armor,
      weapon: player.weapon,
      position: [player.x, player.y, player.z]
    };
  })()`);
  if (!compatible.playing || !compatible.compatible || compatible.hp !== 73 ||
      compatible.armor !== 41 || compatible.weapon !== 8)
    throw new Error(`compatibility restore mismatch: ${JSON.stringify(compatible)}`);

  /* CDP Runtime.evaluate is deliberately not a trusted click, so Chrome logs
     the normal pointer-lock user-gesture warning when startGame() is invoked
     from the harness. A real Begin/Continue click does not produce it. */
  const fatalIssues = issues.filter(issue => !/favicon\.ico/i.test(issue) &&
    !/NotAllowedError: A user gesture is required to request Pointer Lock/i.test(issue));
  if (fatalIssues.length) throw new Error(`browser errors: ${JSON.stringify(fatalIssues)}`);
  console.log(`  INFO  restored health ${restored.hp}, armor ${restored.armor}, weapon slot ${restored.weapon}`);
  console.log('SAVE VERIFY PASS');
  pass = true;
} catch (err) {
  console.error('SAVE VERIFY FAIL:', err.stack || err.message);
  if (issues.length) console.error('BROWSER ISSUES:', JSON.stringify(issues, null, 2));
} finally {
  await closeChrome();
  if (server) {
    try {
      const closed = new Promise(resolve => server.close(resolve));
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await Promise.race([closed, sleep(2500)]);
    } catch {}
  }
  if (profile) {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(profile);
    if (resolved.startsWith(tempRoot + path.sep)) {
      for (let attempt = 0; attempt < 20 && fs.existsSync(resolved); attempt++) {
        try { fs.rmSync(resolved, { recursive: true, force: true }); } catch {}
        if (fs.existsSync(resolved)) await sleep(150 + attempt * 50);
      }
      if (fs.existsSync(resolved)) {
        pass = false;
        console.error(`SAVE VERIFY FAIL: Chrome profile cleanup failed: ${resolved}`);
      }
    } else {
      pass = false;
      console.error(`SAVE VERIFY FAIL: refusing to clean profile outside temp: ${resolved}`);
    }
  }
}

process.exit(pass ? 0 : 1);
