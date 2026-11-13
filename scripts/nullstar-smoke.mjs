#!/usr/bin/env node
/* Live NULLSTAR regression smoke.
   Boots the canonical game in installed Chrome through the DevTools protocol,
   exercises the Level-2 pickup, projectile, alt-collapse, damage occlusion,
   two-core cap, and viewmodel verifier, then captures two QA frames. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(ROOT, '_shots');
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
].filter(Boolean);
const chrome = chromeCandidates.find(p => fs.existsSync(p));
if (!chrome) throw new Error('Installed Chrome was not found; set CHROME_PATH.');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nz-nullstar-'));
const gameURL = pathToFileURL(path.join(ROOT, 'NUKEM.html')).href + '?level=2&nzdiag=1&nzdebug=1';
const proc = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--allow-file-access-from-files', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1280,720', gameURL
], { stdio: 'ignore', windowsHide: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const activePort = path.join(profile, 'DevToolsActivePort');
let ws;
let nextId = 0;
const pending = new Map();
const runtimeErrors = [];

async function waitFor(fn, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) {}
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const out = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
    userGesture: true, replMode: false
  });
  if (out.exceptionDetails) {
    const text = out.exceptionDetails.exception?.description || out.exceptionDetails.text;
    throw new Error(`Runtime.evaluate failed: ${text}`);
  }
  return out.result?.value;
}

function assert(ok, message, detail) {
  if (!ok) throw new Error(`${message}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`  PASS  ${message}`);
}

async function capture(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, name);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`  SHOT  ${out}`);
  return out;
}

try {
  const portInfo = await waitFor(() => {
    if (!fs.existsSync(activePort)) return null;
    const lines = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
    return lines[0] ? { port: Number(lines[0]), browserPath: lines[1] } : null;
  }, 15000, 'Chrome DevTools port');

  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${portInfo.port}/json/list`)).json();
    return list.find(t => t.type === 'page' && /NUKEM\.html/.test(t.url));
  }, 15000, 'game tab');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      runtimeErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false
  });

  const boot = await waitFor(async () => evaluate(`(() => {
    if (typeof state === 'undefined' || !state.booted) return null;
    const pickup = pickups.find(p => p.kind === 'wnullstar');
    return {
      level: LEVEL, nzLevel: NZ.level, weaponCount: WPN.length,
      arena: !!NZ.flags.arena, weapons: !!NZ.flags.weapons,
      pickup: pickup && { x: pickup.x, y: pickup.y, z: pickup.z },
      errors: (NZ.errors || []).slice()
    };
  })()`), 120000, 'Level 2 boot');
  console.log('NULLSTAR live Chrome smoke');
  assert(boot.level === 2 && boot.nzLevel === 2, 'canonical page booted Mission 2', boot);
  assert(boot.weaponCount === 10, 'ten-slot weapon roster is live', boot.weaponCount);
  assert(boot.arena && boot.weapons, 'arena and 3D weapon modules installed', boot);
  assert(!!boot.pickup, 'NULLSTAR pickup exists in the oculus', boot.pickup);
  assert(!boot.errors.length, 'module registry reports no install errors', boot.errors);

  const pickupResult = await evaluate(`(() => {
    state.playing = false; state.paused = false; inspectMode = true; hideScreens();
    el('ui').style.opacity = '0'; el('overlay').style.opacity = '0';
    const p = pickups.find(q => q.kind === 'wnullstar');
    player.x = p.x; player.y = p.y; player.z = p.z;
    updatePickups(1 / 60);
    return { taken: p.taken, owned: player.has[9], ammo: player.ammo.nullcore,
      pending: player.pending, message: el('msg').textContent };
  })()`);
  assert(pickupResult.taken && pickupResult.owned, 'oculus pickup grants Digit0 / weapon index 9', pickupResult);
  assert(pickupResult.ammo === 4, 'weapon pickup grants four singularity cores', pickupResult);

  const fireResult = await evaluate(`(() => {
    player.weapon = 9; player.pending = -1; player.cool = 0;
    player.firedThisClick = false; player.ammo.nullcore = 4;
    const before = player.ammo.nullcore; fire();
    return { before, after: player.ammo.nullcore, live: nullstars.length,
      inScene: !!(nullstars[0] && nullstars[0].mesh.group.parent),
      kind: WPN[player.weapon].name };
  })()`);
  assert(fireResult.kind === 'NULLSTAR' && fireResult.after === fireResult.before - 1,
    'primary fire spends one core', fireResult);
  assert(fireResult.live === 1 && fireResult.inScene, 'primary fire creates a live rendered field core', fireResult);

  const snapResult = await evaluate(`(() => {
    const before = nullstars.length; const ok = detonateNullstars();
    return { before, ok, after: nullstars.length, killBy: KILL_BY.wep };
  })()`);
  assert(snapResult.before === 1 && snapResult.ok && snapResult.after === 0,
    'RMB snap path collapses a projectile in flight', snapResult);
  assert(snapResult.killBy === 'NULLSTAR', 'collapse records NULLSTAR kill credit', snapResult);

  const damageResult = await evaluate(`(() => {
    const target = enemies.find(e => !e.dead && e.hp > 0);
    if (!target) return { missing: true };
    const at = new THREE.Vector3(target.x, target.cy(), target.z);
    const before = enemies.map((e, i) => ({ i, e, hp: e.hp, x: e.x, y: e.cy(), z: e.z,
      eligible: !e.dead && Math.hypot(e.x - at.x, e.cy() - at.y, e.z - at.z) < 22 &&
        shotLineClear(at.x, at.y, at.z, e.x, e.cy(), e.z) }));
    spawnNullstar(at, new THREE.Vector3(0, 0, 0));
    const core = nullstars[nullstars.length - 1]; armNullstar(core); core.charge = NULL_FUSE;
    collapseNullstar(core, false);
    const changed = before.filter(r => r.e.hp < r.hp).map(r => ({ i: r.i, delta: r.hp - r.e.hp,
      eligible: r.eligible }));
    return { missing: false, changed, leaked: changed.filter(r => !r.eligible),
      targetChanged: target.hp < before.find(r => r.e === target).hp, killBy: KILL_BY.wep };
  })()`);
  assert(!damageResult.missing && damageResult.targetChanged && damageResult.changed.length > 0,
    'full collapse damages exposed enemies', damageResult);
  assert(damageResult.leaked.length === 0,
    'collapse damage respects 3D distance and line-of-sight cover', damageResult.leaked);

  const capResult = await evaluate(`(() => {
    const at = new THREE.Vector3(player.x, player.y + EYE, player.z);
    const zero = new THREE.Vector3(0, 0, 0);
    while (nullstars.length) collapseNullstar(nullstars[0], false);
    spawnNullstar(at, zero); spawnNullstar(at, zero); spawnNullstar(at, zero);
    const afterThird = nullstars.length;
    detonateNullstars();
    return { max: NULL_LIVE_MAX, afterThird, afterCleanup: nullstars.length };
  })()`);
  assert(capResult.max === 2 && capResult.afterThird === 2 && capResult.afterCleanup === 0,
    'third deployment chain-collapses the oldest core and preserves a two-core cap', capResult);

  const verifyResult = await evaluate(`(() => {
    const out = NZ.weapons.verify();
    const issues = (out.issues || []).filter(x => /nullstar/i.test(JSON.stringify(x)));
    return { issues, ok: issues.length === 0, sightErr: out.weapons && out.weapons.nullstar && out.weapons.nullstar.sightErr };
  })()`);
  assert(verifyResult.ok, '3D verifier reports no NULLSTAR framing, depth, sight, or recoil issues', verifyResult);

  const daisView = await evaluate(`(() => {
    const p = { x: 31.5 * CELL, y: floorAt(31, 29), z: 29.5 * CELL };
    camera.position.set(p.x, p.y + 4.5, p.z + 11.5);
    camera.lookAt(p.x, p.y + 1.25, p.z);
    el('cross').style.display = 'none';
    return { camera: camera.position.toArray(), target: [p.x, p.y, p.z] };
  })()`);
  await sleep(400);
  await capture('nullstar-dais.png');
  console.log(`  INFO  dais camera ${JSON.stringify(daisView)}`);

  const shotURL = pathToFileURL(path.join(ROOT, 'NUKEM.html')).href +
    '?shot=weapons&mode=single&i=39&width=1280&height=720&ss=1&warm=14&settle=16&prewarm=30&fov=60&lights=0&hud=0';
  await send('Page.navigate', { url: shotURL });
  await waitFor(async () => {
    const title = await evaluate('document.title');
    return title === 'SHOT SINGLE' || title === 'SHOT READY';
  }, 120000, 'NULLSTAR viewmodel shot');
  await sleep(250);
  await capture('nullstar-viewmodel-fire.png');

  assert(runtimeErrors.length === 0, 'browser produced no uncaught exceptions or console errors', runtimeErrors);
  console.log('NULLSTAR smoke complete');
} finally {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (_) {}
  try { proc.kill(); } catch (_) {}
  await sleep(120);
  const resolved = path.resolve(profile);
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(tmpRoot) && path.basename(resolved).startsWith('nz-nullstar-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
