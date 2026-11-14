/* ===========================================================================
   touch-smoke.mjs -- the phone controls, end to end, headless.

   Starts server/mp-server.mjs on a spare port and opens the game twice:

     1. as a PHONE (Chrome's phone emulation: touch, mobile viewport, 2x
        screen) on mission 2, and drives every control with real touch
        events: the stick (walk, run, sprint), look, both thumbs at once,
        FIRE (tap, hold, drag to aim), double tap to fire, AIM, JUMP, CROUCH (tap and hold),
        WEAPON (tap and the list), MAP, the pause-screen settings, RESUME, and
        the portrait pause. It also checks the phone set-up: controls on, no
        canvas MSAA, the pixel-ratio cap, the street assets skipped.
     2. as a DESKTOP, and checks that nothing changed: no touch layer, no CSS,
        no title changes, no pixel-ratio cap, W still walks, mouse look maths
        unchanged.

   Fails on any console error or warning from the game.

     node scripts/touch-smoke.mjs
     CHROME=/path/to/chrome node scripts/touch-smoke.mjs

   Software rendering (no GPU) is slow: allow several minutes. Enemies are
   frozen (inspect mode) so nothing shoots back while the controls are tested.
   ======================================================================== */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PORT = 4300 + Math.floor(Math.random() * 500);
const CHROME = process.env.CHROME || [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(ok, what, extra) {
  say(ok ? 'PASS' : 'FAIL', what, extra === undefined ? '' : extra);
  if (!ok) failures++;
  return ok;
}
async function waitFor(page, fn, ms, what) {
  const until = Date.now() + ms;
  for (; ;) {
    let v = false;
    try { v = await page.evaluate(fn); } catch { v = false; }
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting for ' + what);
    await sleep(300);
  }
}
if (!CHROME) { console.error('touch-smoke: no Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }

/* ------------------------------------------------------------- server -- */
const srv = spawn(process.execPath, [path.join(REPO, 'server', 'mp-server.mjs')], {
  cwd: REPO, env: { ...process.env, NZ_PORT: String(PORT), PORT: '', HOST: '127.0.0.1', NZ_STUN: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
for (let i = 0; i < 50 && !/server on/.test(srvLog); i++) await sleep(100);
if (!/server on/.test(srvLog)) { console.error(srvLog); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required']
});
const THREE_SRC = fs.readFileSync(path.join(REPO, 'vendor', 'three.r149.min.js'));
/* known and not from the controls: nz-destruct's note that mission 2 has no
   crates, the software GPU's performance notes, nz-render's G-buffer passing
   flatShading to a ShaderMaterial (medium tier and up), and the personal
   look file, which a fresh checkout does not have */
const KNOWN = /CRATE_MESHES registry empty|threw:0 pool|GL Driver Message|'flatShading' is not a property|nz-hero-look\.js/;
async function open(errs, emulate) {
  const page = await browser.newPage();
  /* hermetic: three.js from vendor/ instead of unpkg */
  await page.setRequestInterception(true);
  page.on('request', r => /^https:\/\/unpkg\.com\/three@/.test(r.url())
    ? r.respond({ status: 200, contentType: 'text/javascript', body: THREE_SRC }) : r.continue());
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => {
    const where = (m.location() && m.location().url) || '';
    if ((m.type() === 'error' || m.type() === 'warn') && !KNOWN.test(m.text() + ' ' + where)) errs.push(m.type() + ' ' + m.text() + ' ' + where);
  });
  page.on('requestfailed', r => { if (!KNOWN.test(r.url()) && !/unpkg/.test(r.url())) errs.push('requestfailed ' + r.url()); });
  await emulate(page);
  return page;
}
const ev = (page, fn, arg) => page.evaluate(fn, arg);
/* game time runs at most 0.05 s per frame, so on a slow (software) frame a
   weapon swap takes seconds of real time: wait for the game, not the clock */
const gunUp = (page, n) => waitFor(page, `player.pending < 0 && player.weapon === ${n} && player.raiseT <= 0 && player.cool <= 0`, 90000, 'weapon ' + n).catch(() => 0);
const until = (page, expr, what) => waitFor(page, expr, 30000, what).catch(() => 0);
async function rectOf(page, sel) {
  return page.evaluate(s => {
    const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, vis: getComputedStyle(e).display !== 'none' && r.width > 0 };
  }, sel);
}
/* fingers through the DevTools protocol: always the whole set on the glass */
function fingers(cdp) {
  let live = new Set();
  const send = async pts => {
    if (!pts.length) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); live = new Set(); return; }
    const type = pts.some(p => !live.has(p.id)) ? 'touchStart' : 'touchMove';
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id, radiusX: 6, radiusY: 6, force: 1 })) });
    live = new Set(pts.map(p => p.id));
  };
  return {
    send,
    async tap(r, hold = 100) { await send([{ id: 40, x: r.x, y: r.y }]); await sleep(hold); await send([]); },
    /* down and up back to back. Each protocol touch waits until the page has
       handled it, so behind a slow (software-rendered) frame an awaited
       100 ms tap reaches the page as a long press -- CROUCH and WEAPON would
       rightly treat it as a hold */
    async quick(r) {
      await Promise.all([
        cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y, id: 41, radiusX: 6, radiusY: 6, force: 1 }] }),
        cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      ]);
      live = new Set();
    },
    async drag(id, x0, y0, x1, y1, steps = 8, others = []) {
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        await send(others.concat([{ id, x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k }]));
        await sleep(20);
      }
    }
  };
}

/* ============================================================== PHONE == */
const phoneErrs = [];
const ph = await open(phoneErrs, p => p.emulate({
  viewport: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA
}));
await ph.goto(`http://127.0.0.1:${PORT}/NUKEM.html#skill=0&level=2&fresh=1`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await waitFor(ph, () => state.booted, 300000, 'phone boot');
say('phone booted');
const cdpPh = await ph.createCDPSession();
const F = fingers(cdpPh);

const t = await ev(ph, () => ({
  st: NZ.touch.state(), aa: _refs().renderer.getContext().getContextAttributes().antialias, pr: _refs().renderer.getPixelRatio(),
  assets: typeof window.NZ_BUILDINGS_ASSET + typeof window.NZ_COURIER_ASSET,
  hint: getComputedStyle(document.querySelector('#scTitle .nzt-hint')).display,
  overlap: (() => {
    const k = [...document.getElementById('scTitle').children].filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0);
    let n = 0;
    for (let i = 1; i < k.length; i++) if (k[i].getBoundingClientRect().top < k[i - 1].getBoundingClientRect().bottom - 1) n++;
    return n;
  })()
}));
check(t.st.active && t.st.phone, 'phone detected, touch controls on');
check(t.aa === false && Math.abs(t.pr - 1.5) < 1e-6, 'no canvas MSAA, pixel ratio capped at 1.5', t.pr);
check(t.assets === 'undefinedundefined', 'mission 2 skips the street assets');
check(t.hint === 'inline' && t.overlap === 0, 'title lists the touch controls, nothing overlaps');
/* the rest at LOW: a quarter of the pixels, so software rendering keeps up */
await ev(ph, () => NZ.touch.setGraphics('low'));

await ev(ph, () => document.getElementById('btnStart').scrollIntoView({ block: 'center' }));
await F.tap(await rectOf(ph, '#btnStart'));
await waitFor(ph, () => state.playing && NZ.touch.state().shown, 60000, 'game start');
await ev(ph, () => { inspectMode = true; });
check(!(await ev(ph, () => !!document.pointerLockElement)), 'BEGIN by touch: in the game, controls up, no pointer lock');
const B = {};
for (const a of ['fire', 'aim', 'jump', 'crouch', 'weapon', 'map', 'pause']) B[a] = await rectOf(ph, `#nzTouch [data-act=${a}]`);

/* stick */
let p0 = await ev(ph, () => ({ x: player.x, z: player.z, yaw: player.yaw }));
await F.drag(1, 150, 250, 150, 160, 10);
await sleep(1500);
let s = await ev(ph, () => ({ pad: NZ.touch.state().pad, x: player.x, z: player.z }));
await F.send([]);
const run = Math.hypot(s.x - p0.x, s.z - p0.z);
const dot = ((s.x - p0.x) * -Math.sin(p0.yaw) + (s.z - p0.z) * -Math.cos(p0.yaw)) / (run || 1);
check(s.pad.on && s.pad.sprint && run > 1 && dot > 0.9, 'stick all the way up: sprints forward', run.toFixed(2));
check(!(await ev(ph, () => padAxis.on)), 'stick released: stops');
await F.drag(1, 150, 250, 150, 225, 4);
await sleep(200);
s = await ev(ph, () => NZ.touch.state().pad);
await F.send([]);
check(s.walk && !s.sprint && s.fwd > 0, 'light push walks');

/* look, and both thumbs at once */
let y0 = await ev(ph, () => ({ yaw: player.yaw, pitch: player.pitch }));
await F.drag(2, 560, 170, 680, 170, 12);
await F.drag(2, 680, 170, 680, 230, 6);
await F.send([]);
let y1 = await ev(ph, () => ({ yaw: player.yaw, pitch: player.pitch }));
check(Math.abs(y1.yaw - y0.yaw + 0.9) < 0.02 && Math.abs(y1.pitch - y0.pitch + 0.45) < 0.02, 'drag to look (120 px = 0.9 rad)',
  (y1.yaw - y0.yaw).toFixed(3) + ' / ' + (y1.pitch - y0.pitch).toFixed(3));
await ev(ph, () => { player.pitch = 0; });
p0 = await ev(ph, () => ({ x: player.x, z: player.z, yaw: player.yaw }));
await F.send([{ id: 3, x: 140, y: 250 }, { id: 4, x: 640, y: 200 }]);
for (let i = 1; i <= 10; i++) { await F.send([{ id: 3, x: 140 + 9 * i, y: 250 }, { id: 4, x: 640 - 6 * i, y: 200 }]); await sleep(20); }
await sleep(1000);
s = await ev(ph, () => ({ x: player.x, z: player.z, yaw: player.yaw }));
/* lift only the stick thumb (the protocol lifts every finger at once, so
   this one is a synthetic touchend) */
const lifted = await ev(ph, () => {
  const L = document.getElementById('nzTouch');
  const mk = (id, x, y) => new Touch({ identifier: id, target: L, clientX: x, clientY: y });
  L.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [mk(3, 230, 250)], touches: [mk(4, 580, 200)] }));
  const st = NZ.touch.state();
  return { stick: st.stick, look: st.look };
});
await F.send([]);
check(Math.hypot(s.x - p0.x, s.z - p0.z) > 0.5 && Math.abs(s.yaw - p0.yaw - 0.45) < 0.02, 'two thumbs: move and look together');
check(!lifted.stick && lifted.look, 'lifting one thumb leaves the other');

/* FIRE: one shot, then hold-and-drag on an automatic */
await ev(ph, () => { player.has = WPN.map((_, i) => i !== 9); for (const k in player.ammo) player.ammo[k] = 40; selectWeapon(0); });
await gunUp(ph, 0);
let a0 = await ev(ph, () => player.ammo.clip);
await F.tap(B.fire, 150);
await sleep(800);
check(await ev(ph, () => player.ammo.clip) === a0 - 1, 'tap FIRE: one pistol shot');

/* a double tap on the look side fires, a single tap does not. The touches
   carry their own timestamps: each protocol call waits for the page, so
   behind a slow frame two awaited taps would land seconds apart */
const pageNow = () => ev(ph, () => performance.timeOrigin + performance.now());
const stamped = (type, x, y, tMs) => cdpPh.send('Input.dispatchTouchEvent', {
  type, timestamp: tMs / 1000, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 42, radiusX: 6, radiusY: 6, force: 1 }]
});
const tapAt = (x, y, tMs) => Promise.all([stamped('touchStart', x, y, tMs), stamped('touchEnd', 0, 0, tMs + 45)]);
await gunUp(ph, 0);
a0 = await ev(ph, () => player.ammo.clip);
let tt = await pageNow();
await tapAt(620, 190, tt);
await sleep(1500);
const single = await ev(ph, () => player.ammo.clip);
tt = await pageNow();
await tapAt(620, 190, tt);
await tapAt(640, 180, tt + 160);
await until(ph, `player.ammo.clip < ${single}`, 'double tap');
check(single === a0 && await ev(ph, () => player.ammo.clip) === a0 - 1, 'a single tap does nothing, a double tap fires one shot');
await ev(ph, () => selectWeapon(2));
await gunUp(ph, 2);
a0 = await ev(ph, () => ({ am: player.ammo.chain, yaw: player.yaw }));
await F.send([{ id: 5, x: B.fire.x, y: B.fire.y }]);
for (let i = 1; i <= 10; i++) { await F.send([{ id: 5, x: B.fire.x - 4 * i, y: B.fire.y }]); await sleep(120); }
await sleep(600);
let a1 = await ev(ph, () => ({ am: player.ammo.chain, yaw: player.yaw }));
await F.send([]);
await sleep(300);
check(a0.am - a1.am >= 2 && a1.yaw - a0.yaw > 0.25 && !(await ev(ph, () => mouseDown)), 'hold FIRE and drag: keeps firing and aims, stops on release');

/* AIM, JUMP, CROUCH */
await F.tap(B.aim);
await until(ph, 'player.ads > 0.5', 'aim');
const adsOnNow = await ev(ph, () => adsDown && player.ads > 0.5);
await F.tap(B.aim);
await sleep(300);
check(adsOnNow && !(await ev(ph, () => adsDown)), 'AIM toggles the sights');
const jy = await ev(ph, () => player.y);
await F.send([{ id: 7, x: B.jump.x, y: B.jump.y }]);
let peak = jy;
for (let i = 0; i < 8; i++) { await sleep(120); peak = Math.max(peak, await ev(ph, () => player.y)); }
await F.send([]);
check(peak > jy + 0.5, 'JUMP', (peak - jy).toFixed(2));
await until(ph, 'player.onGround', 'landed');
await F.quick(B.crouch);
await until(ph, 'player.crouched', 'crouch');
const cr = await ev(ph, () => player.crouched && !player.crawling);
await F.quick(B.crouch);
await until(ph, '!player.crouched', 'stand');
await F.send([{ id: 11, x: B.crouch.x, y: B.crouch.y }]);
await until(ph, 'player.crawling', 'crawl');
await F.send([]);
const prone = await ev(ph, () => player.crawling);
await F.tap(B.jump);
await until(ph, '!player.crawling', 'stand up');
check(cr && prone && !(await ev(ph, () => player.crawling)), 'CROUCH tap crouches, hold crawls, JUMP stands up');

/* WEAPON: tap = next, hold = the list */
await ev(ph, () => selectWeapon(0));
await gunUp(ph, 0);
await F.quick(B.weapon);
await sleep(200);
check(await ev(ph, () => player.pending >= 0 ? player.pending : player.weapon) === 1, 'WEAPON tap: next gun');
await gunUp(ph, 1);
await F.send([{ id: 8, x: B.weapon.x, y: B.weapon.y }]);
await until(ph, 'NZ.touch.state().picker', 'weapon list');
await F.send([]);
const n = await ev(ph, () => document.querySelectorAll('#nzTouch .nzt-pick').length);
const dmr = await rectOf(ph, '#nzTouch .nzt-pick[data-w="8"]');
if (dmr) await F.tap(dmr);
await sleep(300);
check(n === 9 && await ev(ph, () => (player.pending >= 0 ? player.pending : player.weapon) === 8 && !NZ.touch.state().picker),
  'hold WEAPON: the list, tap a gun', n + ' guns listed');

/* MAP */
await F.tap(B.map);
await until(ph, 'showMap', 'map');
const mapOn = await ev(ph, () => showMap);
await F.tap(B.map);
await sleep(300);
check(mapOn && !(await ev(ph, () => showMap)), 'MAP toggles the map');

/* PAUSE: settings, then RESUME */
await F.tap(B.pause);
await waitFor(ph, () => state.paused && document.getElementById('scPause').classList.contains('show'), 10000, 'pause');
const opt = async sel => { await ev(ph, x => document.querySelector(x).scrollIntoView({ block: 'center' }), sel); await sleep(150); await F.tap(await rectOf(ph, sel)); await sleep(600); };
await opt('#nztOpts [data-o=gfx][data-v=high]');
await until(ph, 'NZ.dprCap === 2', 'high');
const gh = await ev(ph, () => ({ q: NZ.render ? NZ.render.quality : 'med', cap: NZ.dprCap }));
await opt('#nztOpts [data-o=gfx][data-v=low]');
check(gh.q === 'med' && gh.cap === 2, 'GRAPHICS HIGH switches tier and pixel ratio', JSON.stringify(gh));
await opt('#nztOpts [data-o=sens][data-v="1"]');
check(await ev(ph, () => JSON.parse(localStorage.getItem('nuke-zone-3d:touch:v1')).sens) === 1.15, 'LOOK SPEED + is remembered');
await opt('#nztOpts [data-o=sens][data-v="-1"]');
await ev(ph, () => document.getElementById('btnResume').scrollIntoView({ block: 'center' }));
await F.tap(await rectOf(ph, '#btnResume'));
await waitFor(ph, () => state.playing && NZ.touch.state().shown, 15000, 'resume');
check(true, 'RESUME by touch');

/* portrait pauses, landscape carries on */
await ph.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false });
await until(ph, `state.paused && document.getElementById('nzRotate').classList.contains('show')`, 'portrait');
const por = await ev(ph, () => state.paused && document.getElementById('nzRotate').classList.contains('show'));
await ph.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
await until(ph, `state.playing && !document.getElementById('nzRotate').classList.contains('show')`, 'landscape');
check(por && await ev(ph, () => state.playing && !document.getElementById('nzRotate').classList.contains('show')),
  'portrait pauses behind the turn card, landscape carries on');
check(phoneErrs.length === 0, 'phone: no console errors or warnings', phoneErrs.slice(0, 6).join(' | '));
await ph.close();

/* ============================================================ DESKTOP == */
const pcErrs = [];
const pc = await open(pcErrs, p => p.setViewport({ width: 1280, height: 720 }));
await pc.goto(`http://127.0.0.1:${PORT}/NUKEM.html#skill=0&level=2&fresh=1`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await waitFor(pc, () => state.booted, 300000, 'desktop boot');
say('desktop booted');
const d = await ev(pc, () => ({
  on: NZ.touch.active || NZ.touch.phone, dom: !!document.querySelector('#nzTouch,#nzTouchCss,.nzt-keys,.nzt-hint,#nztOpts'),
  cls: document.documentElement.className, cap: NZ.dprCap, aa: _refs().renderer.getContext().getContextAttributes().antialias
}));
check(!d.on && !d.dom && !d.cls && d.cap === undefined && d.aa === true, 'desktop: page exactly as before', JSON.stringify(d));
await pc.click('#btnStart');
await waitFor(pc, () => state.playing, 60000, 'desktop start');
await ev(pc, () => { inspectMode = true; });
await sleep(1000);
p0 = await ev(pc, () => ({ x: player.x, z: player.z }));
await pc.keyboard.down('KeyW');
await sleep(1500);
await pc.keyboard.up('KeyW');
const p1 = await ev(pc, () => ({ x: player.x, z: player.z }));
check(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 1, 'desktop: W walks');
const lk = await ev(pc, () => { player.weapon = 0; player.ads = 0; const y = player.yaw, p = player.pitch; lookBy(100, 50); return [player.yaw - y, player.pitch - p]; });
check(Math.abs(lk[0] + 0.23) < 1e-9 && Math.abs(lk[1] + 0.115) < 1e-9, 'desktop: mouse look maths unchanged');
check(pcErrs.length === 0, 'desktop: no console errors or warnings', pcErrs.slice(0, 6).join(' | '));

await browser.close();
srv.kill();
say(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
