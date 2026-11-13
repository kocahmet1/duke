#!/usr/bin/env node
/* Live, dependency-free Chromium verification for the A/B facade glass.
   Uses Chrome DevTools Protocol through Node's built-in WebSocket. */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

if (typeof fetch !== 'function' || typeof WebSocket !== 'function')
  throw new Error('verify-hero-glass requires Node.js 22+ (global fetch and WebSocket).');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_shots');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function chromePath() {
  const candidates = [
    process.env.CRITIC_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
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
      /* Keep the verifier offline/restricted-network safe.  The production
         page retains its CDN-first tag, but the harness always uses the exact
         vendored r149 build already shipped by build-static.mjs. */
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
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params || {});
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  call(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 5000) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

async function waitFor(fn, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch {}
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function connectDebugger(port, targetNeedle) {
  let target;
  for (let i = 0; i < 300; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes(targetNeedle));
      if (target) break;
    } catch {}
    await sleep(100);
  }
  if (!target) throw new Error('Chrome page target did not appear');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

async function waitForGame(cdp) {
  let lastTitle = '';
  let stalledDetail = null;
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const state = await cdp.eval(`({ title: document.title,
      ready: !!(window.NZ && NZ.destruct && NZ.destruct.glass && NZ.destruct.glass.ready()) })`).catch(() => null);
    if (state?.title && state.title !== lastTitle) {
      lastTitle = state.title;
      console.log(`  INFO  page title: ${lastTitle}`);
    }
    if (state?.ready && (state.title === 'SHOT SINGLE' || state.title === 'SHOT READY')) return state;
    if (state?.title === 'SHOT ERROR' || state?.title === 'SHOT STALLED') {
      const detail = await cdp.eval(`({
        banner: document.getElementById('nzShotBanner')?.textContent || '',
        flags: window.NZ ? { ...NZ.flags } : null,
        run: window.NZ && NZ.shots ? { armed: NZ.shots.run.armed, phase: NZ.shots.run.phase,
          done: NZ.shots.run.done, cells: NZ.shots.run.cells && NZ.shots.run.cells.length } : null,
        diag: document.body ? document.body.innerText.slice(0, 5000) : ''
      })`).catch(() => null);
      if (state.title === 'SHOT ERROR')
        throw new Error(`boot ended at ${state.title}: ${JSON.stringify(detail)}`);
      stalledDetail = detail;
    }
    await sleep(100);
  }
  throw new Error(`game boot timeout: ${JSON.stringify(stalledDetail)}`);
}

async function renderPane(cdp, index, storeKey = '', compareKey = '') {
  const visual = await cdp.eval(`(() => {
    const storeKey = ${JSON.stringify(String(storeKey))};
    const compareKey = ${JSON.stringify(String(compareKey))};
    const d = NZ.destruct.glass.panes[${index}];
    if (NZ.shots && NZ.shots.run) NZ.shots.run.armed = false;
    /* Let destruction publish any newly spawned shard instances, then freeze
       gameplay before taking control of the camera.  Leaving state.playing
       true lets the normal RAF updatePlayer() reclaim the camera between this
       CDP evaluation and Page.captureScreenshot. */
    if (typeof state !== 'undefined') {
      state.playing = true; state.paused = false;
      NZ.first('render', .016);
      state.playing = false;
    }
    const dist = d.roomKind === 'balcony' ? 13 : 10;
    camera.position.set(d.center[0] + d.normal[0] * dist + d.tangent[0] * .8,
      d.center[1] + .25, d.center[2] + d.normal[2] * dist + d.tangent[2] * .8);
    camera.fov = 48; camera.updateProjectionMatrix();
    camera.lookAt(new THREE.Vector3(d.center[0], d.center[1], d.center[2]));
    const ui = document.getElementById('ui'); if (ui) ui.style.display = 'none';
    const ov = document.getElementById('overlay'); if (ov) ov.style.display = 'none';
    const banner = document.getElementById('nzShotBanner'); if (banner) banner.remove();
    for (let i = 0; i < 3; i++) if (!(NZ.first('render', .016) === true)) renderer.render(scene, camera);
    /* Sample the rendered opening while it is still in the WebGL backbuffer.
       This catches a room that exists in metadata but remains visually hidden
       by misplaced shell geometry or an unreplaced glass sheet. */
    const sw = 96, sh = 96, sample = document.createElement('canvas');
    sample.width = sw; sample.height = sh;
    const sx = renderer.domElement.width * .31, sy = renderer.domElement.height * .15;
    const sctx = sample.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(renderer.domElement, sx, sy, renderer.domElement.width * .38,
      renderer.domElement.height * .70, 0, 0, sw, sh);
    const pixels = sctx.getImageData(0, 0, sw, sh).data;
    const frames = window.__heroGlassFrames || (window.__heroGlassFrames = Object.create(null));
    const out = { pixels: sw * sh, changedFraction: 0, meanDelta: 0 };
    if (compareKey && frames[compareKey]) {
      const before = frames[compareKey]; let changed = 0, deltaSum = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const delta = Math.abs(pixels[i] - before[i]) +
          Math.abs(pixels[i + 1] - before[i + 1]) +
          Math.abs(pixels[i + 2] - before[i + 2]);
        deltaSum += delta; if (delta > 48) changed++;
      }
      out.changedFraction = changed / (sw * sh);
      out.meanDelta = deltaSum / (sw * sh * 3);
    }
    if (storeKey) frames[storeKey] = Array.from(pixels);
    return out;
  })()`, 60000);
  await sleep(120);
  return visual;
}

async function settleEffects(cdp) {
  await cdp.eval(`(() => {
    state.playing = true;
    if (typeof updateParts === 'function') updateParts(9);
    NZ.first('render', 9);
    state.playing = false;
    return true;
  })()`, 60000);
}

async function capture(cdp, file) {
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));
}

async function renderCorridor(cdp) {
  await cdp.eval(`(() => {
    if (NZ.shots && NZ.shots.run) NZ.shots.run.armed = false;
    if (typeof state !== 'undefined') {
      state.playing = true; state.paused = false;
      NZ.first('render', .016);
      state.playing = false;
    }
    camera.position.set(566, 5.985, 174);
    camera.fov = 62; camera.updateProjectionMatrix();
    camera.lookAt(new THREE.Vector3(756, 10, 174));
    const ui = document.getElementById('ui'); if (ui) ui.style.display = 'none';
    const ov = document.getElementById('overlay'); if (ov) ov.style.display = 'none';
    const banner = document.getElementById('nzShotBanner'); if (banner) banner.remove();
    for (let i = 0; i < 3; i++) if (!(NZ.first('render', .016) === true)) renderer.render(scene, camera);
    return true;
  })()`, 60000);
  await sleep(120);
}

async function shootPaneToStage(cdp, index, targetStage, oblique = 0) {
  return cdp.eval(`(() => {
    const index = ${index | 0}, target = ${targetStage | 0}, oblique = ${Number(oblique) || 0};
    const d = NZ.destruct.glass.panes[index];
    const samples = [[0,0],[-.34,-.34],[.34,-.34],[-.34,.34],[.34,.34],
      [0,-.36],[0,.36],[-.36,0],[.36,0],[-.18,-.18],[.18,-.18],[-.18,.18],[.18,.18],
      [-.36,-.18],[-.36,.18],[.36,-.18],[.36,.18],[-.18,-.36],[.18,-.36],[-.18,.36],[.18,.36]];
    let attempts = 0;
    for (let pass = 0; pass < 5 && NZ.destruct.glass.state(index).stage < target; pass++) {
      for (let i = 0; i < samples.length && NZ.destruct.glass.state(index).stage < target; i++) {
        const u = samples[i][0] * d.width + (pass - 2) * d.width * .018;
        const v = samples[i][1] * d.height + ((pass + i) % 3 - 1) * d.height * .014;
        const aim = new THREE.Vector3(d.center[0] + d.tangent[0] * u,
          d.center[1] + v, d.center[2] + d.tangent[2] * u);
        const org = aim.clone().add(new THREE.Vector3(d.normal[0] * 11 + d.tangent[0] * oblique,
          0, d.normal[2] * 11 + d.tangent[2] * oblique));
        hitscan(org, aim.clone().sub(org).normalize(), 60, 24, true); attempts++;
      }
    }
    return { ...NZ.destruct.glass.state(index), attempts };
  })()`, 30000);
}

const chrome = chromePath();
if (!chrome) { console.error('VERIFY FAIL: Chrome/Edge not found'); process.exit(1); }

const query = 'shot=env&mode=single&i=0&width=1280&height=720&ss=1&nzq=low&prewarm=0&warm=1&settle=1&nzdebug=1';
let pass = false;
let cdp, server, port, profile, activePort, pageURL, child, childError;
const issues = [];
try {
  ({ server, port } = await serveRoot());
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nz-hero-glass-'));
  activePort = path.join(profile, 'DevToolsActivePort');
  pageURL = `http://127.0.0.1:${port}/NUKEM.html?${query}`;
  const angleBackend = process.platform === 'win32' ? 'd3d11' : 'swiftshader';
  const chromeArgs = [
    '--headless=new', '--use-gl=angle', `--use-angle=${angleBackend}`,
    '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-breakpad',
    '--disable-crash-reporter', '--noerrdialogs',
    '--disable-renderer-backgrounding', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,720', pageURL
  ];
  if (process.platform === 'linux') chromeArgs.splice(1, 0, '--no-sandbox', '--disable-setuid-sandbox');
  child = spawn(chrome, chromeArgs, { stdio: 'ignore', windowsHide: true });
  child.once('error', err => { childError = err; });
  console.log(`Hero-glass live Chrome verification\n  INFO  ${pageURL}`);
  const portInfo = await waitFor(() => {
    if (childError) return { error: childError.message };
    if (child.exitCode !== null) return { error: `Chrome exited ${child.exitCode}` };
    if (!fs.existsSync(activePort)) return null;
    const lines = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
    return lines[0] ? { port: Number(lines[0]) } : null;
  }, 15000, 'Chrome DevTools port');
  if (portInfo.error) throw new Error(portInfo.error);
  cdp = await connectDebugger(portInfo.port, 'NUKEM.html');
  cdp.on('Runtime.exceptionThrown', p => issues.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  cdp.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error')
      issues.push(p.args.map(a => a.value || a.description || '').join(' '));
  });
  cdp.on('Log.entryAdded', p => {
    if (p.entry?.level === 'error')
      issues.push(p.entry.text + (p.entry.url ? ` @ ${p.entry.url}` : ''));
  });
  await cdp.call('Runtime.enable'); await cdp.call('Log.enable'); await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitForGame(cdp);

  const base = await cdp.eval(`(() => {
    const panes = NZ.destruct.glass.panes;
    const ab = panes.findIndex(p => p.building === 'AB' && p.roomKind === 'flat' &&
      String(p.room).includes(':window:') && p.center[1] > 13 && p.center[1] < 22);
    let bb = -1, bbBack = -1, pairArea = -1;
    for (let i = 0; i < panes.length; i++) {
      const f = panes[i];
      if (f.building !== 'BB' || f.roomKind !== 'balcony') continue;
      const backRoom = String(f.room).replace(':loggia-front:', ':loggia-back:');
      for (let j = 0; j < panes.length; j++) {
        const b = panes[j]; if (String(b.room) !== backRoom) continue;
        const du = Math.abs((b.center[0] - f.center[0]) * f.tangent[0] +
          (b.center[2] - f.center[2]) * f.tangent[2]);
        const dy = Math.abs(b.center[1] - f.center[1]);
        const area = Math.max(0, (b.width + f.width) * .5 - du) *
          Math.max(0, (b.height + f.height) * .5 - dy);
        if (area > pairArea) { pairArea = area; bb = i; bbBack = j; }
      }
    }
    const neighbour = panes.findIndex((p, i) => i !== ab && p.building === 'AB' && p.room === panes[ab].room);
    const abBal = panes.findIndex(p => p.building === 'AB' && p.roomKind === 'balcony' &&
      Math.abs(p.center[0] - panes[ab].center[0]) > 12);
    const bbFlat = panes.findIndex(p => p.building === 'BB' && p.roomKind === 'flat' &&
      String(p.room).includes(':window:') && Math.abs(p.center[0] - panes[bb].center[0]) > 12);
    const blastBack = panes.findIndex((p, i) => {
      if (i === bbBack || p.building !== 'BB' || !String(p.room).includes(':loggia-back:')) return false;
      const frontRoom = String(p.room).replace(':loggia-back:', ':loggia-front:');
      return !panes.some(q => String(q.room) === frontRoom);
    });
    window.__glassCheck = { ab, bb, bbBack, neighbour, abBal, bbFlat, blastBack };
    return { count: panes.length, ab, bb, bbBack, neighbour, abBal, bbFlat, blastBack, pairArea,
      buildings: [...new Set(panes.map(p => p.building))],
      counts: panes.reduce((out, p) => (out[p.building] = (out[p.building] || 0) + 1, out), {}),
      fallback: NZ.destruct.glass.fallbackVisible(),
      stats: { ...NZ.destruct.stats } };
  })()`);
  if (base.count !== 677 || base.counts.AB !== 304 || base.counts.BB !== 373 ||
      base.ab < 0 || base.bb < 0 || base.bbBack < 0 || base.neighbour < 0 ||
      base.abBal < 0 || base.bbFlat < 0 || base.blastBack < 0 || base.fallback !== false)
    throw new Error(`registry mismatch: ${JSON.stringify(base)}`);

  await renderCorridor(cdp); await capture(cdp, 'hero-glass-corridor-intact.png');
  const abIntactVisual = await renderPane(cdp, base.ab, 'ab-intact');
  await capture(cdp, 'hero-glass-0-intact.png');
  const phases = [['1-chipped', 1], ['2-partial', 2], ['3-half', 3], ['4-collapsed', 4]];
  const states = [];
  let fallBefore = [], fallAfter = [], shardInstancesDuringFall = 0;
  for (const [name, target] of phases) {
    if (target === 4) await cdp.eval(`state.playing = false; true`);
    const stageState = await shootPaneToStage(cdp, base.ab, target);
    states.push(stageState);
    if (target === 4) fallBefore = await cdp.eval('NZ.destruct.glass.debrisState()');
    await renderPane(cdp, base.ab); await capture(cdp, `hero-glass-${name}.png`);
    if (target === 4) {
      shardInstancesDuringFall = await cdp.eval(
        `scene.getObjectByName('nzdestruct-falling-glass-pool')?.count || 0`);
      await cdp.eval(`(() => {
        state.playing = true;
        for (let i = 0; i < 8; i++) NZ.first('render', .05);
        state.playing = false;
        return true;
      })()`, 60000);
      fallAfter = await cdp.eval('NZ.destruct.glass.debrisState()');
    }
  }
  const bbIntactVisual = await renderPane(cdp, base.bb, 'bb-intact');
  await capture(cdp, 'hero-glass-bblok-balcony-intact.png');
  const bbState = await shootPaneToStage(cdp, base.bb, 4);
  await renderPane(cdp, base.bb); await capture(cdp, 'hero-glass-bblok-balcony.png');

  /* Complete the 2x2 emitter-family matrix through the real user shot path. */
  console.log('  INFO  live-hit emitter matrix');
  const abBalHit = await shootPaneToStage(cdp, base.abBal, 1);
  const bbFlatHit = await shootPaneToStage(cdp, base.bbFlat, 1);

  /* Make the paired front screen broadly open, then prove an oblique live
     round can pass it and reach the recessed rear sash.  The 12.5u lateral
     offset needs more than the old fixed 5.4u ray allowance. */
  console.log('  INFO  oblique front-to-back route');
  await cdp.eval(`(() => {
    const panes = NZ.destruct.glass.panes, room = panes[${base.bb}].room;
    for (let i = 0; i < panes.length; i++) if (panes[i].room === room)
      NZ.destruct.glass.damage(i, 6, 24);
    return true;
  })()`, 60000);
  const backHit = await shootPaneToStage(cdp, base.bbBack, 1, 12.5);
  await settleEffects(cdp);
  const bbOpenVisual = await renderPane(cdp, base.bb, '', 'bb-intact');
  await capture(cdp, 'hero-glass-bblok-balcony-open.png');

  /* Exercise the wrapped, occlusion-aware explosion path against a rear sash
     whose balcony is open (no front glazing to consume the candidate budget). */
  console.log('  INFO  occluded blast route');
  const blastHit = await cdp.eval(`(() => {
    const i = ${base.blastBack}, d = NZ.destruct.glass.panes[i];
    const p = new THREE.Vector3(d.center[0] + d.normal[0] * 7, d.center[1],
      d.center[2] + d.normal[2] * 7);
    explode(p, 10, 60, 'VERIFY', { occluded: true, selfScale: 0, edgeDamage: 0 });
    return NZ.destruct.glass.state(i);
  })()`, 60000);

  /* Exhaust the nearest 18 panes around a fresh blast site, then prove the
     real wrapped explosion advances to pane 19 instead of repeatedly spending
     its bounded work budget on fragments that cannot shed any more glass. */
  console.log('  INFO  repeated-blast propagation');
  const blastPropagation = await cdp.eval(`(() => {
    const panes = NZ.destruct.glass.panes, radius = 18;
    let pick = null;
    for (let s = 0; s < panes.length && !pick; s++) {
      if (NZ.destruct.glass.state(s).stage !== 0) continue;
      const seed = panes[s];
      const p = new THREE.Vector3(seed.center[0] + seed.normal[0] * 7,
        seed.center[1], seed.center[2] + seed.normal[2] * 7);
      const hits = [];
      for (let i = 0; i < panes.length; i++) {
        const d = panes[i], dx = p.x - d.center[0], dz = p.z - d.center[2];
        const u = dx * d.tangent[0] + dz * d.tangent[2], v = p.y - d.center[1];
        const n = dx * d.normal[0] + dz * d.normal[2];
        const eu = Math.max(0, Math.abs(u) - d.width * .5);
        const ev = Math.max(0, Math.abs(v) - d.height * .5);
        const dist = Math.hypot(eu, ev, n);
        if (dist < radius * .85) hits.push({ i, dist });
      }
      hits.sort((a, b) => a.dist - b.dist || a.i - b.i);
      if (hits.length >= 25 && hits.slice(0, 25).every(h => NZ.destruct.glass.state(h.i).stage === 0))
        pick = { p, hits };
    }
    if (!pick) return { ok: false, reason: 'no clean 25-pane blast cluster' };
    for (let k = 0; k < 18; k++) NZ.destruct.glass.damage(pick.hits[k].i, 16, 24);
    const target = pick.hits[18].i, before = NZ.destruct.glass.state(target);
    explode(pick.p, radius, 60, 'VERIFY', { occluded: false, selfScale: 0, edgeDamage: 0 });
    const after = NZ.destruct.glass.state(target);
    return { ok: after.stage > before.stage, target, before, after };
  })()`, 60000);

  console.log('  INFO  final assertions');
  const result = await cdp.eval(`(() => {
    const C = window.__glassCheck, ab = NZ.destruct.glass.state(C.ab), bb = NZ.destruct.glass.state(C.bb);
    const neighbour = NZ.destruct.glass.state(C.neighbour);
    const enemyBefore = neighbour.energy;
    const d = NZ.destruct.glass.panes[C.neighbour];
    const dir = new THREE.Vector3(-d.normal[0], 0, -d.normal[2]);
    NZ.first('surfaceHit', new THREE.Vector3(d.center[0], d.center[1], d.center[2]), dir,
      { normal: new THREE.Vector3(d.normal[0], 0, d.normal[2]), kind: 'concrete' },
      { enemy: true, first: true });
    return { ab, bb, neighbour: NZ.destruct.glass.state(C.neighbour),
      enemyBefore, debris: NZ.destruct.glass.debrisCount(), rooms: NZ.destruct.glass.roomsVisible(),
      flatContents: NZ.destruct.glass.roomContents(C.ab),
      balconyContents: NZ.destruct.glass.roomContents(C.bb),
      shardInstances: scene.getObjectByName('nzdestruct-falling-glass-pool')?.count || 0,
      roomPools: scene.children.filter(o => /^nzdestruct-room-pool-/.test(o.name)).length,
      stats: { ...NZ.destruct.stats } };
  })()`, 30000);

  if (base.neighbour >= 0) {
    await cdp.eval(`NZ.destruct.glass.damage(${base.neighbour}, 6, 24)`, 30000);
    /* The staged captures intentionally show airborne shards.  Let transient
       impact particles and debris expire for one clean interior-reveal proof. */
    await settleEffects(cdp);
    var abOpenVisual = await renderPane(cdp, base.ab, '', 'ab-intact');
    await capture(cdp, 'hero-glass-flat-room-open.png');
  }

  const ranges = [[.72, .88], [.48, .68], [.22, .40], [.05, .17]];
  const monotonic = states.map(s => s.stage).join(',') === '1,2,3,4' &&
    states.every((s, i) => s.remaining > ranges[i][0] && s.remaining < ranges[i][1]) &&
    states.every((s, i) => i === 0 || s.remaining < states[i - 1].remaining);
  const shotBudget = states[0].attempts <= 2 &&
    states.reduce((sum, s) => sum + s.attempts, 0) <= 20 &&
    states.every(s => s.attempts <= 8);
  const beforeById = new Map(fallBefore.map(d => [d.id, d]));
  const falling = fallBefore.length > 0 && fallAfter.length > 0 &&
    fallAfter.some(d => {
      const before = beforeById.get(d.id);
      return before && (d.y < before.y - .02 || d.bounces > before.bounces);
    });
  const flatFurniture = ['sofa-base', 'television', 'coffee-table', 'picture'].every(n => result.flatContents.includes(n));
  const balconyFurniture = ['planter', 'table-top', 'chair-back'].every(n => result.balconyContents.includes(n));
  const roomsRendered = abOpenVisual && bbOpenVisual &&
    abOpenVisual.changedFraction > .025 && abOpenVisual.meanDelta > 2.5 &&
    bbOpenVisual.changedFraction > .025 && bbOpenVisual.meanDelta > 2.5;
  const fatalIssues = issues.filter(x => !/favicon\.ico/i.test(x));
  pass = monotonic && shotBudget && roomsRendered &&
    result.ab.stage === 4 && result.ab.remaining > .03 && result.ab.remaining < .17 &&
    bbState.stage === 4 && result.bb.stage === 4 && result.bb.remaining > .03 && result.bb.remaining < .17 &&
    abBalHit.stage === 1 && bbFlatHit.stage === 1 && backHit.stage >= 1 && blastHit.stage >= 1 &&
    blastPropagation.ok &&
    result.neighbour.stage === 0 && result.neighbour.energy === result.enemyBefore &&
    result.debris > 0 && shardInstancesDuringFall > 0 && falling && result.rooms >= 6 &&
    flatFurniture && balconyFurniture && result.roomPools > 0 && fatalIssues.length === 0;
  console.log(JSON.stringify({ base, states, shotBudget, abIntactVisual, abOpenVisual,
    bbState, bbIntactVisual, bbOpenVisual, roomsRendered,
    abBalHit, bbFlatHit, backHit, blastHit, blastPropagation,
    falling, shardInstancesDuringFall,
    fallBefore: fallBefore.slice(0, 3), fallAfter: fallAfter.slice(0, 3),
    flatFurniture, balconyFurniture, result, issues: fatalIssues }, null, 2));
  console.log(pass ? 'VERIFY PASS' : 'VERIFY FAIL');
} catch (err) {
  console.error('VERIFY FAIL:', err.stack || err.message);
  if (issues.length) console.error('BROWSER ISSUES:', JSON.stringify(issues, null, 2));
} finally {
  try {
    if (cdp?.ws?.readyState === WebSocket.OPEN)
      await cdp.call('Browser.close', {}, 4000);
  } catch {}
  try { if (cdp?.ws?.readyState === WebSocket.OPEN) cdp.ws.close(); } catch {}
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise(resolve => {
        if (child.exitCode !== null) resolve(); else child.once('exit', resolve);
      }),
      sleep(4000)
    ]);
  }
  if (child && child.exitCode === null) {
    try {
      if (process.platform === 'win32' && child.pid)
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGKILL');
    } catch {}
    await Promise.race([
      new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)),
      sleep(3000)
    ]);
  }
  if (server) {
    try {
      const closed = new Promise(resolve => server.close(resolve));
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await Promise.race([closed, sleep(2500)]);
    } catch {}
  }
  if (profile) {
    const tempRoot = path.resolve(os.tmpdir()), resolvedProfile = path.resolve(profile);
    if (resolvedProfile.startsWith(tempRoot + path.sep)) {
      for (let attempt = 0; attempt < 20 && fs.existsSync(resolvedProfile); attempt++) {
        try { fs.rmSync(resolvedProfile, { recursive: true, force: true }); } catch {}
        if (fs.existsSync(resolvedProfile)) await sleep(150 + attempt * 50);
      }
      if (fs.existsSync(resolvedProfile)) {
        pass = false;
        console.error(`VERIFY FAIL: Chrome profile cleanup failed: ${resolvedProfile}`);
      }
    } else {
      pass = false;
      console.error(`VERIFY FAIL: refusing to clean profile outside temp: ${resolvedProfile}`);
    }
  }
}

process.exit(pass ? 0 : 1);
