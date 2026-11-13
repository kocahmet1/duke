#!/usr/bin/env node
/* Focused runtime + render regression for the parked Courier's breakable
   glazing.  Uses Chrome's built-in DevTools protocol directly so the check has
   no browser-package dependency. */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = [
  process.env.CRITIC_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].filter(Boolean).find(p => fs.existsSync(p));
if (!chrome) throw new Error('Chrome or Edge is required for verify-car-glass.');

function mime(file) {
  if (/\.html$/i.test(file)) return 'text/html; charset=utf-8';
  if (/\.(?:js|mjs)$/i.test(file)) return 'text/javascript; charset=utf-8';
  if (/\.png$/i.test(file)) return 'image/png';
  return 'application/octet-stream';
}
async function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/^\/+/, '') || 'NUKEM.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      if (rel.toLowerCase() === 'nukem.html') data = Buffer.from(data.toString('utf8').replace(
        /<script src="https:\/\/unpkg\.com\/three@0\.149\.0\/build\/three\.min\.js"><\/script>/,
        '<script src="vendor/three.r149.min.js"></script>'));
      res.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-store' }); res.end(data);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: server.address().port };
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return;
      }
      for (const fn of this.events.get(msg.method) || []) fn(msg.params || {});
    });
  }
  on(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); }
  call(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeout = 30000) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch {} await sleep(120); }
  throw new Error(`timed out waiting for ${label}`);
}

let child, cdp, server, profile;
const issues = [];
try {
  const hosted = await serve(); server = hosted.server;
  console.log(`CAR GLASS VERIFY: serving on 127.0.0.1:${hosted.port}`);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nz-car-glass-'));
  const activePort = path.join(profile, 'DevToolsActivePort');
  const q = 'shot=env&mode=single&i=0&width=1280&height=720&ss=1&nzq=low&prewarm=0&warm=1&settle=1&nzdebug=1';
  const url = `http://127.0.0.1:${hosted.port}/NUKEM.html?${q}#skill=0&level=4&fresh=1`;
  const args = ['--headless=new', '--use-gl=angle', `--use-angle=${process.platform === 'win32' ? 'd3d11' : 'swiftshader'}`,
    '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-breakpad', '--disable-crash-reporter', '--noerrdialogs', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,720', url];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  child = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });
  console.log(`  Chrome launched (pid ${child.pid})`);
  const port = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`);
    if (!fs.existsSync(activePort)) return null;
    return Number(fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/)[0]);
  }, 25000, 'Chrome debugger');
  console.log(`  debugger ready on ${port}`);
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find(x => x.type === 'page' && x.url.includes('NUKEM.html'));
  }, 25000, 'game page');
  console.log('  game page connected; waiting for level build');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  cdp = new CDP(ws);
  cdp.on('Runtime.exceptionThrown', p => issues.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  cdp.on('Runtime.consoleAPICalled', p => {
    const text = p.args?.map(a => a.value || a.description || '').join(' ') || '';
    if (p.type === 'error' || /install failed|threw:[1-9]|panic/i.test(text)) issues.push(text);
  });
  await cdp.call('Runtime.enable'); await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => cdp.eval(`document.title === 'SHOT SINGLE' || document.title === 'SHOT READY'`), 180000, 'shot scene');
  console.log(`  ${await cdp.eval('document.title')} -- scene built`);
  const boot = await cdp.eval(`(() => ({
    cars: NZ.streetProps?.cars?.length || 0,
    panes: NZ.destruct?.carGlass?.count?.() || 0,
    ready: !!NZ.destruct?.carGlass?.ready?.(),
    cabin: !!NZ.streetProps?.carMeshes?.()?.cabin,
    windows: NZ.streetProps?.carMeshes?.()?.windows?.length || 0,
    doubleSided: NZ.streetProps?.carMeshes?.()?.windows?.every(x=>x?.material?.side===THREE.DoubleSide) || false,
    states: NZ.destruct?.carGlass?.states?.() || []
  }))()`);
  if (!boot.ready || boot.cars !== 1 || boot.panes !== 8 || boot.windows !== 8 || !boot.cabin || !boot.doubleSided)
    throw new Error(`bad car-glass boot: ${JSON.stringify(boot)}; runtime: ${issues.join(' | ')}`);
  console.log(`  runtime ready: ${boot.panes} double-sided panes + detailed cabin`);

  /* Match the user's broadside inspection angle.  With the near left pane
     removed, this view must still render the inside face of the right pane
     behind the complete front and rear seating. */
  await cdp.eval(`(() => {
    const c = NZ.streetProps.cars[0], nx=Math.cos(c.yaw), nz=Math.sin(c.yaw);
    const lx=Math.sin(c.yaw), lz=-Math.cos(c.yaw);
    const aim={x:c.x+nx*c.spec.L*.03,y:c.y+c.spec.H*.57,z:c.z+nz*c.spec.L*.03};
    const d=13.5, at={x:aim.x+lx*d,y:aim.y+.30,z:aim.z+lz*d};
    const tx=aim.x-at.x, ty=aim.y-at.y, tz=aim.z-at.z;
    const P=NZ.shots.pose; P.x=at.x; P.y=at.y; P.z=at.z;
    P.yaw=Math.atan2(-tx,-tz); P.pitch=Math.atan2(ty,Math.hypot(tx,tz)); P.roll=0; P.fov=37;
    NZ.shots.applyPose();
    NZ.flags.weapons=false;
    const o=document.getElementById('overlay'); if(o)o.style.display='none';
    const b=document.getElementById('nzShotBanner'); if(b)b.remove();
    return true;
  })()`);
  await sleep(1400);
  fs.mkdirSync(path.join(ROOT, '_shots'), { recursive: true });
  async function shot(name) {
    const r = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 60000);
    fs.writeFileSync(path.join(ROOT, '_shots', name), Buffer.from(r.data, 'base64'));
  }
  await shot('car-glass-intact.png');
  console.log('  intact capture written');

  const cracked = await cdp.eval(`(() => {
    const s=NZ.destruct.carGlass.states();
    const i=s.findIndex(x=>x.kind==='side'&&x.side==='left'&&x.id.endsWith('-2'));
    if(i<0) return {i,states:s};
    return {i,state:NZ.destruct.carGlass.damage(i,1,16)};
  })()`);
  if (cracked.i < 0 || cracked.state.stage !== 1 || cracked.state.broken) throw new Error(`crack stage failed: ${JSON.stringify(cracked)}`);
  await sleep(700); await shot('car-glass-cracked.png');
  console.log('  cracked capture written');

  const broken = await cdp.eval(`(() => {
    const i=NZ.destruct.carGlass.states().findIndex(x=>x.kind==='side'&&x.side==='left'&&x.id.endsWith('-2'));
    const state=NZ.destruct.carGlass.damage(i,2,16);
    const d=NZ.streetProps.carWindows[i];
    const farI=NZ.streetProps.carWindows.findIndex(x=>x.kind===d.kind&&x.pane===d.pane&&x.side!==d.side);
    const far=NZ.streetProps.carWindows[farI];
    return {i,state,debris:NZ.destruct.carGlass.debrisCount(),opacity:d.mesh.material.opacity,
      cabin:!!NZ.streetProps.carMeshes().cabin,farI,
      far:{side:far?.side,broken:!!far?.mesh?.userData?.nzCarGlassState?.broken,
        opacity:far?.mesh?.material?.opacity,materialSide:far?.mesh?.material?.side,
        expectedSide:THREE.DoubleSide}};
  })()`);
  if (!broken.state?.broken || broken.state.stage !== 3 || broken.debris < 18 || broken.opacity !== 0 || !broken.cabin ||
      broken.farI < 0 || broken.far?.broken || broken.far?.opacity !== 1 ||
      broken.far?.materialSide !== broken.far?.expectedSide)
    throw new Error(`break stage failed: ${JSON.stringify(broken)}`);
  /* Catch the fragment sheet just as gravity starts pulling it below the
     weatherstrip; shot mode freezes simulation, so advance its debug surface
     by one tenth of a second before taking the regression capture. */
  await cdp.eval(`NZ.destruct.carGlass.advance(.10)`);
  await sleep(120); await shot('car-glass-broken.png');
  console.log('  shattered capture written');
  const settled = await cdp.eval(`(() => ({state:NZ.destruct.carGlass.states()[${broken.i}],
    broken:NZ.destruct.stats.carPanesBroken,peak:NZ.destruct.stats.carGlassDebrisPeak}))()`);
  if (!settled.state?.broken || settled.broken < 1 || settled.peak < 18) throw new Error(`post-break state failed: ${JSON.stringify(settled)}`);
  /* A second QA frame removes the opposite pane too.  This is not the
     one-window gameplay state above; it exposes the upholstery directly so
     regressions cannot hide behind tint/reflection. */
  const revealed = await cdp.eval(`(() => {
    let far=null;
    const states=NZ.destruct.carGlass.states();
    for(let i=0;i<states.length;i++) if(states[i].kind==='side'&&!states[i].broken) {
      const hit=NZ.destruct.carGlass.damage(i,3,16);
      if(i===${broken.farI}) far=hit;
    }
    const c=NZ.streetProps.cars[0], nx=Math.cos(c.yaw), nz=Math.sin(c.yaw);
    const lx=Math.sin(c.yaw), lz=-Math.cos(c.yaw);
    const aim={x:c.x+nx*c.spec.L*.02,y:c.y+c.spec.H*.57,z:c.z+nz*c.spec.L*.02};
    let dx=lx+nx*.24,dz=lz+nz*.24,dl=Math.hypot(dx,dz);dx/=dl;dz/=dl;
    const d=12.5,at={x:aim.x+dx*d,y:aim.y+.34,z:aim.z+dz*d};
    const tx=aim.x-at.x,ty=aim.y-at.y,tz=aim.z-at.z,P=NZ.shots.pose;
    P.x=at.x;P.y=at.y;P.z=at.z;P.yaw=Math.atan2(-tx,-tz);
    P.pitch=Math.atan2(ty,Math.hypot(tx,tz));P.roll=0;P.fov=37;NZ.shots.applyPose();
    return {far,debris:NZ.destruct.carGlass.debrisCount()};
  })()`);
  if (!revealed.far?.broken) throw new Error(`opposite break failed: ${JSON.stringify(revealed)}`);
  await cdp.eval(`NZ.destruct.carGlass.advance(1.25)`);
  await sleep(120); await shot('car-interior-revealed.png');
  console.log('  unobstructed interior capture written');
  if (issues.length) throw new Error(`runtime issues: ${issues.join(' | ')}`);
  console.log(`CAR GLASS OK: ${boot.panes} panes, crack stage ${cracked.state.stage}, broken shards ${broken.debris}, opposite ${broken.far.side} pane intact`);
  console.log('  _shots/car-glass-intact.png');
  console.log('  _shots/car-glass-cracked.png');
  console.log('  _shots/car-glass-broken.png');
  console.log('  _shots/car-interior-revealed.png');
} finally {
  try { if (cdp) await cdp.call('Browser.close', {}, 4000); } catch {}
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
