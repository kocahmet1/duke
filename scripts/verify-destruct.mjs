#!/usr/bin/env node
/* ===========================================================================
   verify-destruct.mjs -- proves nz-destruct.js with live rounds, headless.

   Boots the staged page in nz-shots single mode (sim frozen, free camera),
   then from inside the page:

     1. empties enemies[] so nothing soaks a test round,
     2. fires hitscan() bursts at a parked car's flank and glazing,
     3. fires a cluster at a facade (same spot twice, for the deepen path),
     4. shoots a crate to death and asserts the grid cell opened,
     5. detonates explode() beside a second crate for the blast path,

   then poses the free camera at each scar and writes PNGs to _shots/.
   Boot, staging, rAF brake and FBO capture are all render-level.mjs's
   mechanics, reused verbatim; see that file for why each one exists.
   Toolchain: run `node scripts/render-level.mjs --setup` once first.
   ======================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const say = (m) => console.log(`[${el()}] ${m}`);

const PP_DIR = process.env.CRITIC_PP || '/tmp/pp';
const CHROME = process.env.CRITIC_CHROME ||
  '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell';
const LIB_DIRS = process.env.CRITIC_LIBS ||
  '/tmp/root/usr/lib/x86_64-linux-gnu:/tmp/root/lib/x86_64-linux-gnu';
if (!fs.existsSync(CHROME)) { console.error('no chrome -- run: node scripts/render-level.mjs --setup'); process.exit(1); }

/* ---- stage (same shape as render-level.mjs, lean: no enemies/weapons/audio,
        but nz-destruct.js itself always ships) ------------------------------ */
const STAGE = path.join(os.tmpdir(), 'nzverify');
                                 /* separate from nzlvl; os.tmpdir() also keeps
                                    the stage writable on managed Windows */
const FULL = process.argv.includes('--full');
const LEAN_OUT = FULL ? [] : ['nz-enemies.js', 'nz-weapons.js', 'nz-audio.js'];
function stageLevel() {
  fs.mkdirSync(path.join(STAGE, 'vendor'), { recursive: true });
  const sync = (rel) => {
    const src = path.join(ROOT, rel), dst = path.join(STAGE, rel);
    if (!fs.existsSync(src)) return;
    const a = fs.statSync(src);
    let b = null; try { b = fs.statSync(dst); } catch (e) {}
    if (b && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 1) return;
    fs.copyFileSync(src, dst);
    try { fs.utimesSync(dst, a.atime, a.mtime); } catch (e) {}
  };
  for (const f of fs.readdirSync(ROOT)) if (/\.(js|png)$/.test(f)) sync(f);
  if (fs.existsSync(path.join(ROOT, 'vendor')))
    for (const f of fs.readdirSync(path.join(ROOT, 'vendor'))) sync(path.join('vendor', f));
  let html = fs.readFileSync(path.join(ROOT, 'NUKEM.html'), 'utf8');
  html = html.replace(/<script src="https:\/\/unpkg\.com\/three@[^"]*"><\/script>/,
    '<script src="vendor/three.r149.min.js"></script>');
  for (const f of LEAN_OUT)
    html = html.replace(new RegExp('<script src="' + f.replace('.', '\\.') + '"></script>', 'g'),
      '<!-- verify lean: ' + f + ' -->');
  const out = path.join(STAGE, 'NUKEM.verify.html');
  const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (prev !== html) fs.writeFileSync(out, html);
  return out;
}

(async () => {
  const requireCwd = createRequire(path.join(PP_DIR, 'package.json'));
  /* The shared capture toolchain may expose puppeteer-core through its
     browser-less `puppeteer` alias.  Accept either layout so this verifier
     uses the exact same dependency that already rendered the QA sheet. */
  let puppeteer;
  try { puppeteer = requireCwd('puppeteer-core'); }
  catch (_) { puppeteer = requireCwd('puppeteer'); }
  process.env.LD_LIBRARY_PATH = LIB_DIRS + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');
  const W = 960, H = 600;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-accelerated-2d-canvas', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', `--window-size=${W},${H}`],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const issues = [], destructLog = [];
  page.on('console', m => {
    const t = m.text();
    if (/nz-destruct/i.test(t)) destructLog.push(t.slice(0, 300));
    if (m.type() === 'error' || /PAGEERROR|panic|threw:[1-9]|install failed/i.test(t)) issues.push(t.slice(0, 300));
  });
  page.on('pageerror', e => issues.push('PAGEERROR: ' + e.message));

  const pageFile = stageLevel();
  const q = 'shot=env&mode=single&i=0&width=' + W + '&height=' + H +
    '&ss=1&nzq=low&prewarm=0&warm=1&settle=1&nzdebug=1';
  const u = 'file://' + pageFile.split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:').replace(/ /g, '%20') + '?' + q;
  say('boot ' + path.basename(pageFile));
  page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  let title = '';
  for (;;) {
    try { title = await page.title(); } catch (e) {}
    if (title === 'SHOT SINGLE' || title === 'SHOT READY') break;
    if (title === 'SHOT ERROR' || title === 'SHOT STALLED') { console.error('BOOT: ' + title); process.exit(1); }
    if ((Date.now() - T0) / 1000 > 120) { console.error('BOOT timeout, title=' + title); process.exit(1); }
    await new Promise(r => setTimeout(r, 120));
  }
  say(title + ' -- level built');

  /* rAF brake + FBO capture, verbatim mechanics from render-level.mjs */
  const capOK = await page.evaluate(() => {
    const orig = window.requestAnimationFrame.bind(window);
    window.__vPending = null; window.__vPaused = false;
    window.requestAnimationFrame = function (cb) {
      if (window.__vPaused) { window.__vPending = cb; return -1; }
      return orig(cb);
    };
    window.__vResume = function () {
      window.__vPaused = false;
      const c = window.__vPending; window.__vPending = null; if (c) orig(c);
    };
    window.__vFrames = 0; window.__vBudget = 0;
    NZ.on('render', function () {
      window.__vFrames++;
      if (window.__vBudget > 0 && --window.__vBudget === 0) window.__vPaused = true;
      return undefined;
    }, 500);
    window.__vRun = function (n) { window.__vBudget = n; window.__vResume(); };
    const o = document.getElementById('overlay'); if (o) o.style.display = 'none';
    const b = document.getElementById('nzShotBanner'); if (b) b.remove();
    try {
      const R = NZ.ctx.renderer, T = NZ.ctx.THREE || window.THREE;
      const RW = R.domElement.width, RH = R.domElement.height;
      const rt = new T.WebGLRenderTarget(RW, RH, {
        format: T.RGBAFormat, type: T.UnsignedByteType,
        minFilter: T.LinearFilter, magFilter: T.LinearFilter,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      });
      if (T.SRGBColorSpace) rt.texture.colorSpace = T.SRGBColorSpace;
      else rt.texture.encoding = T.sRGBEncoding;
      const setRT = R.setRenderTarget.bind(R);
      R.setRenderTarget = function (t, a, m) { return setRT((t === null || t === undefined) ? rt : t, a, m); };
      const pix = new Uint8Array(RW * RH * 4);
      const cv = document.createElement('canvas'); cv.width = RW; cv.height = RH;
      const c2 = cv.getContext('2d', { willReadFrequently: true });
      const idat = c2.createImageData(RW, RH);
      window.__vGrab = function () {
        R.readRenderTargetPixels(rt, 0, 0, RW, RH, pix);
        const dst = idat.data, row = RW * 4;
        for (let y = 0; y < RH; y++) {
          const s = (RH - 1 - y) * row, d = y * row;
          for (let i = 0; i < row; i += 4) {
            dst[d + i] = pix[s + i]; dst[d + i + 1] = pix[s + i + 1];
            dst[d + i + 2] = pix[s + i + 2]; dst[d + i + 3] = 255;
          }
        }
        c2.putImageData(idat, 0, 0);
        return cv.toDataURL('image/png');
      };
      const one = new Uint8Array(4);
      window.__vWarm = function () { R.readRenderTargetPixels(rt, 0, 0, 1, 1, one); };
      return RW + 'x' + RH;
    } catch (e) { return 'FAILED: ' + e.message; }
  }).catch(e => 'FAILED: ' + e.message);
  say('capture ' + capOK);
  if (String(capOK).startsWith('FAILED')) { console.error('no FBO capture'); process.exit(1); }
  let t = Date.now();
  await page.evaluate(() => window.__vWarm()).catch(() => {});
  say(`drain ${((Date.now() - t) / 1000).toFixed(1)}s`);

  /* ------------------------------------------------ live-fire test pass -- */
  const R = await page.evaluate(() => {
    const out = { ok: true, notes: [] };
    const note = (s) => out.notes.push(s);
    try {
      for (const e of enemies) { try { if (e.mesh) scene.remove(e.mesh); } catch (e2) {} }
      enemies.length = 0;                        /* nothing soaks a round */
      const V = (x, y, z) => new THREE.Vector3(x, y, z);
      const aim = (o, t) => V(t.x - o.x, t.y - o.y, t.z - o.z).normalize();
      const burst = (org, tgt, n, dmg, jit) => {
        for (let i = 0; i < n; i++) {
          const T2 = V(tgt.x + (Math.random() - .5) * jit, tgt.y + (Math.random() - .5) * jit,
            tgt.z + (Math.random() - .5) * jit);
          hitscan(org, aim(org, T2), 90, dmg, false);
        }
      };

      /* 1 -- the car */
      const cars = (NZ.streetProps && NZ.streetProps.cars) || [];
      out.cars = cars.length;
      let car = null;
      if (cars.length) {
        car = cars[0];
        const roadZ = 172;                        /* street canyon centre */
        const side = car.z < roadZ ? 1 : -1;      /* stand on the roadway  */
        const org = V(car.x, car.y + car.spec.H * .55, car.z + side * 11);
        /* glazing first: the per-frame mesh-ray budget is 3, and this whole
           pass runs inside one frame -- the glass path only proves itself on
           a refined ray */
        burst(org, V(car.x + car.spec.L * .1, car.y + car.spec.H * .80, car.z), 3, 16, 1.2);
        burst(org, V(car.x, car.y + car.spec.H * .45, car.z), 7, 16, 2.2);   /* flank */
        burst(org, V(car.x - car.spec.L * .25, car.y + car.spec.H * .50, car.z), 2, 16, 1.4);
        out.carPose = { x: car.x, y: car.y, z: car.z, H: car.spec.H, side: side };
      } else note('no cars published');

      /* 2 -- a facade cluster on the blind west gable (x = 168: flat render,
         no ground-floor gaps to swallow the marks), with a repeat-hit crater */
      {
        const gx = 168, org2 = V(177, 8.2, 171);
        burst(org2, V(gx, 9.4, 171), 4, 16, 3.2);
        for (let i = 0; i < 5; i++) hitscan(org2, aim(org2, V(gx, 9.2, 172.3)), 90, 16, false);
        out.facadePose = { gx: gx, y: 9.2, z: 171.5 };
      }

      /* 3 -- shoot a crate to death */
      const reg = (typeof CRATE_MESHES !== 'undefined') ? CRATE_MESHES : [];
      out.crates = reg.length;
      if (reg.length) {
        const pick = (i) => reg[i];
        const tryKill = (rec) => {
          const p = rec.mesh.position;
          for (const d of [[10, 0], [-10, 0], [0, 10], [0, -10], [6, 6], [-6, -6]]) {
            const org3 = V(p.x + d[0], p.y + .6, p.z + d[1]);
            const dist = castWall(org3, aim(org3, p), 20);
            if (dist > 13) continue;               /* something else in the way */
            const before = (NZ.destruct.stats.crateHits | 0);
            for (let i = 0; i < 8; i++) hitscan(org3, aim(org3, V(p.x, p.y + .3, p.z)), 30, 16, false);
            if ((NZ.destruct.stats.crateHits | 0) > before) return { org: { x: org3.x, y: org3.y, z: org3.z }, p: { x: p.x, y: p.y, z: p.z } };
          }
          return null;
        };
        let shot = null, si = 0;
        for (; si < reg.length && !shot; si++) shot = tryKill(pick(si));
        if (shot) {
          /* the ray may have reached a NEIGHBOUR of the crate we aimed at
             (the [5,2]/[6,2]/[5,3] cluster) -- assert on the module's own
             broken-cell ledger, and pose the camera on the first entry */
          const gone = NZ.destruct.brokenCells;
          out.broken = gone.slice();
          out.crateOpened = gone.length > 0 &&
            gone.every(k => grid[idx(k[0], k[1])] === S_FLOOR);
          if (gone.length) {
            const gp = { x: gone[0][0] * CELL + CELL / 2, z: gone[0][1] * CELL + CELL / 2 };
            out.cratePose = { org: shot.org, p: { x: gp.x, y: shot.p.y, z: gp.z } };
          } else out.cratePose = shot;
        } else note('no crate had a clear firing lane');

        /* 4 -- blast a second one */
        out.explodeWrapped = (typeof explode === 'function')
          ? explode.toString().slice(0, 90).replace(/\s+/g, ' ') : 'missing';
        try {
          const goneKeys = new Set(NZ.destruct.brokenCells.map(k => k[0] + ',' + k[1]));
          for (let i = 0; i < reg.length; i++) {
            const k = reg[i];
            if (goneKeys.has(k.cx + ',' + k.cy)) continue;   /* already broken */
            const p2 = k.mesh.position;
            explode(V(p2.x + 2.5, p2.y, p2.z + 1.5), 18, 90, 'RPG');
            out.blastPose = { x: p2.x, y: p2.y, z: p2.z };
            break;
          }
        } catch (be) { note('explode threw: ' + be.message); }

        /* 5 -- a rocket against the west gable, beside the pistol cluster:
           the wall must now take a crater + soot + shrapnel, not nothing */
        try {
          explode(V(171.6, 8.6, 174.5), 20, 120, 'RPG');
          out.gablePose = { gx: 168, y: 8.8, z: 173.2 };
        } catch (ge) { note('gable explode threw: ' + ge.message); }
      }

      /* the sim is frozen, so the muzzle smoke never dissipates and would fog
         every still: age the stock particle system out by hand */
      try { for (let i = 0; i < 9; i++) updateParts(.5); } catch (pe) { note('updateParts: ' + pe.message); }

      out.stats = JSON.parse(JSON.stringify(NZ.destruct.stats));
      out.flags = { destruct: NZ.flags.destruct };
      out.debris = NZ.destruct.debrisCount();
      out.envCrates = !!(NZ.envCrates && NZ.envCrates.mesh);
      out.warnings = NZ.destruct.diag.warnings.slice();
    } catch (e) { out.ok = false; out.err = e.message + '\n' + (e.stack || '').slice(0, 500); }
    return out;
  });

  say('live fire: ' + JSON.stringify({
    ok: R.ok, cars: R.cars, crates: R.crates, opened: R.crateOpened, broken: R.broken,
    envCrates: R.envCrates,
    stats: R.stats, debris: R.debris, notes: R.notes, warnings: R.warnings, err: R.err
  }));

  /* ------------------------------------------------------------- stills -- */
  fs.mkdirSync(path.join(ROOT, '_shots'), { recursive: true });
  /* NZ.shots.pose is consumed by camera.rotation.set() -- RADIANS */
  const lookAt = (cx, cy, cz, tx, ty, tz) => {
    const dx = tx - cx, dz = tz - cz;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(ty - cy, Math.hypot(dx, dz)) };
  };
  const poses = [];
  if (R.carPose) {
    const c = R.carPose;
    const cam = { x: c.x + 2.5, y: c.y + c.H * .9, z: c.z + c.side * 7.5 };
    poses.push({ name: 'destruct-car', ...cam, ...lookAt(cam.x, cam.y, cam.z, c.x, c.y + c.H * .45, c.z), fov: 55 });
  }
  if (R.facadePose) {
    const f = R.facadePose;
    const cam = { x: f.gx + 6.5, y: f.y - .2, z: f.z };
    poses.push({ name: 'destruct-facade', ...cam, ...lookAt(cam.x, cam.y, cam.z, f.gx, f.y, f.z), fov: 52 });
  }
  if (R.cratePose) {
    const k = R.cratePose;
    const cam = { x: k.org.x * .4 + k.p.x * .6, y: k.p.y + 4.5, z: k.org.z * .4 + k.p.z * .6 };
    poses.push({ name: 'destruct-crate-broken', ...cam, ...lookAt(cam.x, cam.y, cam.z, k.p.x, k.p.y - 1.5, k.p.z), fov: 62 });
  }
  if (R.blastPose) {
    const b2 = R.blastPose;
    const cam = { x: b2.x + 7, y: b2.y + 5, z: b2.z + 7 };
    poses.push({ name: 'destruct-blast', ...cam, ...lookAt(cam.x, cam.y, cam.z, b2.x, b2.y - 1, b2.z), fov: 60 });
  }
  if (R.gablePose) {
    const g3 = R.gablePose;
    const cam = { x: g3.gx + 8.5, y: g3.y, z: g3.z - 1.2 };
    poses.push({ name: 'destruct-gable-blast', ...cam, ...lookAt(cam.x, cam.y, cam.z, g3.gx, g3.y, g3.z), fov: 62 });
  }
  /* --only=substring renders a subset; the live-fire assertions above ran
     in full either way */
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const wanted = onlyArg ? poses.filter(p => p.name.includes(onlyArg.slice(7))) : poses;
  let first = true;
  for (const p of wanted) {
    const t2 = Date.now();
    await page.evaluate((p2, n) => {
      const P = NZ.shots.pose;
      P.x = p2.x; P.y = p2.y; P.z = p2.z; P.yaw = p2.yaw; P.pitch = p2.pitch; P.roll = 0; P.fov = p2.fov;
      window.__vRun(n);
    }, p, first ? 4 : 2);
    first = false;
    for (let w = 0; w < 300; w++) {
      const paused = await page.evaluate(() => window.__vPaused).catch(() => true);
      if (paused) break;
      await new Promise(r => setTimeout(r, 40));
    }
    const png = await page.evaluate(() => window.__vGrab());
    const file = path.join(ROOT, '_shots', p.name + '.png');
    fs.writeFileSync(file, Buffer.from(png.slice('data:image/png;base64,'.length), 'base64'));
    say(`${p.name}.png  ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  }

  if (destructLog.length) for (const l of destructLog.slice(0, 6)) say('log: ' + l);
  if (issues.length) { say('ISSUES:'); for (const l of issues.slice(0, 10)) console.error('  ' + l); }

  const pass = R.ok && R.stats && R.stats.holes > 0 && (R.stats.carHits + R.stats.glassHits) > 0 &&
    R.stats.cratesBroken >= 2 && R.stats.scorches >= 3 && R.crateOpened === true;
  say(pass ? 'VERIFY PASS' : 'VERIFY FAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
