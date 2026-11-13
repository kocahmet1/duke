#!/usr/bin/env node
/* Fallen-weapons smoke test. Every armed enemy now drops his gun on death
   and the player can pick it up and use it -- three of the four guns
   (AK-PATTERN, M4-PATTERN, BOLT DMR) are brand-new player weapons with
   real 3D viewmodels in nz-weapons; the breacher's shotgun feeds slot 2.
   This stages NUKEM.html into /tmp exactly the way smoke-grenade.mjs does
   (local three.js, street/render/audio modules dropped, nz-weapons AND
   nz-enemies kept -- the drop path crosses both), boots headless, then
   drives the game deterministically with hand-stepped ticks:

     1. static surface: WPN 7-9, PICKDEF drops, icons, pools, 9-slot has[]
     2. 3D assets: WEAPONS.ak/m4/dmr built, nodes present, BAL/TUNE keyed
     3. death drops: one kill per kind -> the right pickup appears by the
        body, and the rig's welded gun is hidden when a rig was driving it
     4. pickups: walk-over grants weapon+ammo; a useless drop STAYS
     5. live fire: select+fire all three, ammo spent, right rig visible
     6. screenshots: hip + ADS frames per gun, pickup icons, for eyeball QA

   Exits non-zero on any failure or any page error. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = '/tmp/nzdrop';
const OUT = process.env.DROP_OUT || '/tmp/drop-out';
const DROP = ['nz-render.js', 'nz-audio.js', 'nz-street.js', 'nz-street-ground.js',
  'nz-street-entrance.js', 'nz-street-props.js', 'nz-street-sky.js', 'nz-shots.js'];

fs.mkdirSync(path.join(STAGE, 'vendor'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f)) {
  try { fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f)); } catch (e) { }
}
for (const f of fs.readdirSync(path.join(ROOT, 'vendor')))
  fs.copyFileSync(path.join(ROOT, 'vendor', f), path.join(STAGE, 'vendor', f));
let html = fs.readFileSync(path.join(ROOT, 'NUKEM.html'), 'utf8');
html = html.replace(/<script src="https:\/\/unpkg\.com\/three@[^"]*"><\/script>/,
  '<script src="vendor/three.r149.min.js"></script>');
for (const f of DROP)
  html = html.replaceAll('<script src="' + f + '"></script>', '<!-- drop-test: ' + f + ' dropped -->');
fs.writeFileSync(path.join(STAGE, 'NUKEM.drop.html'), html);

const env = fs.readFileSync('/tmp/chsenv.sh', 'utf8');
const CHROME = (env.match(/CRITIC_CHROME=([^\n"]+)/) || [])[1];
const PP_DIR = (env.match(/CRITIC_PP=([^\n"]+)/) || [])[1] || '/tmp/pp';
const LIBS = (env.match(/CRITIC_LIBS=([^\n"]+)/) || [])[1];
if (LIBS) process.env.LD_LIBRARY_PATH = LIBS + ':' + (process.env.LD_LIBRARY_PATH || '');
const require = createRequire(path.join(PP_DIR, 'noop.cjs'));
const puppeteer = require('puppeteer-core');

const fails = [];
const ok = (cond, label) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) fails.push(label);
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--allow-file-access-from-files',
      '--enable-webgl', '--ignore-gpu-blocklist', '--hide-scrollbars',
      '--disable-accelerated-2d-canvas',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      '--window-size=960,540'],
    protocolTimeout: 180000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message).split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text().split('\n')[0]); });
  page.on('error', e => { console.log('  !!    page CRASHED: ' + e.message); });

  const t0 = Date.now();
  await page.goto('file://' + path.join(STAGE, 'NUKEM.drop.html'), { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('typeof state !== "undefined" && state.booted === true', { timeout: 120000 });
  console.log('boot ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  /* ---- 1. static surface ------------------------------------------------ */
  const stat = await page.evaluate(() => ({
    wpnLen: WPN.length,
    names: WPN.map(w => w.name),
    vms: WPN.map(w => w.vm),
    akPool: AMMOMAX.ak, dmrPool: AMMOMAX.dmr,
    ammoInit: player.ammo.ak === 0 && player.ammo.dmr === 0,
    hasLen: player.has.length,
    picks: ['dak', 'dm4', 'ddmr', 'dshot'].every(k => !!PICKDEF[k]),
    icons: ['dak', 'dm4', 'ddmr', 'dshot'].every(k => !!PICKTEX[k] && !!PICKTEX[k + '_canvas']),
    wdrops: ['trooper', 'pig', 'enforcer', 'octa'].map(k => ECFG[k].wdrop),
    scope: !!WPN[8].scope,
    flags: window.NZ ? NZ.flags : null
  }));
  ok(stat.wpnLen === 10, 'WPN has 10 slots');
  ok(stat.names[6] === 'AK-PATTERN' && stat.names[7] === 'M4-PATTERN' && stat.names[8] === 'BOLT DMR',
    'slots 7-9 are AK-PATTERN / M4-PATTERN / BOLT DMR');
  ok(stat.akPool === 120 && stat.dmrPool === 30 && stat.ammoInit, 'ak/dmr ammo pools exist, start empty');
  ok(stat.hasLen === stat.wpnLen, 'player.has covers every WPN slot');
  ok(stat.picks && stat.icons, 'PICKDEF + baked icons for dak/dm4/ddmr/dshot');
  ok(stat.wdrops.join(',') === 'dak,dshot,dm4,ddmr', 'ECFG wdrop per kind (trooper/pig/enforcer/octa)');
  ok(stat.scope, 'DMR carries the scope flag');
  ok(stat.flags && stat.flags.weapons === true, 'nz-weapons installed');
  ok(stat.flags && stat.flags.enemies === true, 'nz-enemies installed');

  /* ---- 2. the three new 3D assets --------------------------------------- */
  const rig = await page.evaluate(() => {
    const W = NZ.weapons.internals.WEAPONS, out = {};
    for (const k of ['ak', 'm4', 'dmr']) {
      const A = W[k];
      out[k] = A ? {
        meshes: A.meshes.length,
        nodes: !!(A.nodes.slide && A.nodes.mag && A.nodes.trigger),
        sight: !!A.sight, muzzle: !!A.muzzle, grips: !!(A.gripR && A.gripL),
        tris: A.meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count / 3 : 0), 0)
      } : null;
    }
    out.bal = ['ak', 'm4', 'dmr'].every(k => !!NZ.weapons.ballistics[k]);
    out.tune = ['ak', 'm4', 'dmr'].every(k => !!NZ.weapons.tune[k]);
    return out;
  });
  for (const k of ['ak', 'm4', 'dmr']) {
    const a = rig[k];
    ok(a && a.meshes >= 4 && a.nodes && a.sight && a.muzzle && a.grips,
      k + ' asset built (' + (a ? a.meshes + ' meshes, ' + Math.round(a.tris) + ' tris' : 'MISSING') + ')');
  }
  ok(rig.bal && rig.tune, 'BAL + TUNE entries for ak/m4/dmr');

  /* ---- icon dump for eyeball QA ---- */
  const art = await page.evaluate(() => ({
    dak: PICKTEX['dak_canvas'].toDataURL(), dm4: PICKTEX['dm4_canvas'].toDataURL(),
    ddmr: PICKTEX['ddmr_canvas'].toDataURL(), dshot: PICKTEX['dshot_canvas'].toDataURL()
  }));
  for (const [k, v] of Object.entries(art))
    fs.writeFileSync(path.join(OUT, 'icon_' + k + '.png'), Buffer.from(v.split(',')[1], 'base64'));

  /* ---- 3. one kill per kind -> the right drop by the body ---------------- */
  await page.evaluate(() => {
    startGame();
    state.playing = false; state.paused = true;   /* freeze: hand ticks only */
    state.graceT = 0;
  });
  const kills = await page.evaluate(() => {
    const out = [];
    const want = { trooper: 'dak', pig: 'dshot', enforcer: 'dm4', octa: 'ddmr' };
    for (const kind in want) {
      let e = enemies.find(x => x.kind === kind && !x.dead);
      if (!e) { out.push({ kind, missing: true }); continue; }
      const before = pickups.length;
      damageEnemy(e, 500, null, null, true);
      const dropped = pickups.slice(before).map(p => p.kind);
      const wp = pickups.slice(before).find(p => p.kind === want[kind]);
      out.push({
        kind, missing: false, dead: e.dead, dropped,
        gotWeapon: !!wp,
        nearBody: wp ? Math.hypot(wp.x - e.x, wp.z - e.z) < 5 : false,
        rigHidden: !!(e._nz && e._nz.weaponHidden)
      });
    }
    return out;
  });
  for (const k of kills) {
    ok(!k.missing && k.dead && k.gotWeapon && k.nearBody,
      k.kind + ' drops ' + (k.dropped.join('+') || 'nothing') + ' by the body' +
      (k.rigHidden ? ' (rig gun hidden)' : ' (no skinned rig here: sprite corpse keeps art)'));
  }

  /* ---- 4. walk-over pickups grant; a useless drop stays ------------------ */
  const grab = await page.evaluate(() => {
    const out = {};
    const take = kind => {
      const p = pickups.find(p => p.kind === kind && !p.taken);
      if (!p) return null;
      player.x = p.x; player.z = p.z; player.y = p.y;
      updatePickups(.016);
      return p.taken;
    };
    out.dak = take('dak'); out.akState = { has: player.has[6], ammo: player.ammo.ak };
    out.dm4 = take('dm4'); out.m4State = { has: player.has[7], rifle: player.ammo.rifle };
    out.ddmr = take('ddmr'); out.dmrState = { has: player.has[8], ammo: player.ammo.dmr };
    out.dshot = take('dshot'); out.shotState = { has: player.has[1], shell: player.ammo.shell };
    /* now a drop the player cannot use: full AK pool + owned -> must stay */
    player.ammo.ak = AMMOMAX.ak;
    const e = enemies.find(x => x.kind === 'trooper' && !x.dead);
    let stayed = null;
    if (e) {
      const before = pickups.length;
      damageEnemy(e, 500, null, null, true);
      const p = pickups.slice(before).find(p => p.kind === 'dak');
      if (p) {
        player.x = p.x; player.z = p.z; player.y = p.y;
        updatePickups(.016);
        stayed = !p.taken;
      }
    }
    out.stayed = stayed;
    out.weapon = player.weapon;
    return out;
  });
  ok(grab.dak === true && grab.akState.has && grab.akState.ammo === 25, 'fallen AK grants slot 7 + 25rnd');
  ok(grab.dm4 === true && grab.m4State.has && grab.m4State.rifle >= 25, 'fallen M4 grants slot 8 + 5.56');
  ok(grab.ddmr === true && grab.dmrState.has && grab.dmrState.ammo === 4, 'fallen DMR grants slot 9 + 4rnd');
  ok(grab.dshot === true && grab.shotState.has && grab.shotState.shell >= 4, 'fallen shotgun grants slot 2 + shells');
  ok(grab.stayed === true, 'a drop the player cannot use stays on the ground');

  /* ---- 5. live fire on all three ----------------------------------------- */
  /* Headless chrome throttles rAF on an unfocused page to a crawl, so the
     module's per-frame tick cannot be waited for -- it is PUMPED, exactly
     the way drawOverlay pumps it in production: NZ.call('viewmodel', dt).
     Deterministic, and no wall-clock in the loop at all. */
  for (const [slot, key, pool] of [[6, 'ak', 'ak'], [7, 'm4', 'rifle'], [8, 'dmr', 'dmr']]) {
    const fireRes = await page.evaluate(([slot, pool]) => {
      player.ammo[pool] = Math.max(player.ammo[pool], 10);
      selectWeapon(slot);
      for (let i = 0; i < 40 && (player.pending >= 0 || player.weapon !== slot); i++) updatePlayer(.05);
      for (let i = 0; i < 12; i++) updatePlayer(.05);
      player.yaw = 0; player.pitch = 0;
      camera.rotation.y = player.yaw; camera.rotation.x = player.pitch;
      player.cool = 0;
      const before = player.ammo[pool];
      fire();
      /* each pump is a full SwiftShader render, so the count is kept to the
         minimum that proves the point: swap seen, fire seen, springs moving */
      for (let i = 0; i < 5; i++) NZ.call('viewmodel', .06, innerWidth, innerHeight);
      const W = NZ.weapons.internals.WEAPONS;
      const vis = [];
      for (const k in W) if (W[k] && W[k].root && W[k].root.visible) vis.push(k);
      return {
        weapon: player.weapon, before, after: player.ammo[pool], fed: KILL_BY.wep,
        cur: NZ.weapons.stats().weapon, vis
      };
    }, [slot, pool]);
    ok(fireRes.weapon === slot && fireRes.after === fireRes.before - 1,
      key + ' selected + fire() spends 1 (' + fireRes.before + '->' + fireRes.after + '), feed=' + fireRes.fed);
    ok(fireRes.cur === slot && fireRes.vis.length === 1 && fireRes.vis[0] === key,
      key + ' 3D rig is the one visible viewmodel');
  }

  /* ---- 6. beauty shots: each gun alone on a studio renderer -------------- */
  /* Rendering the live game canvas under SwiftShader is minutes per frame
     and OOM-prone; the appearance QA does not need the level at all. Each
     asset root is CLONED out of the viewmodel scene into a fresh 3-light
     studio scene on a small standalone renderer -- a few thousand triangles,
     milliseconds even in software -- and shot from two angles. */
  for (const key of ['ak', 'm4', 'dmr']) {
    for (const [tag, cam] of [
      ['3quarter', [0.34, 0.16, 0.30]],
      ['side', [-0.62, 0.06, -0.26]]
    ]) {
      const name = 'gun_' + key + '_' + (tag === 'side' ? 'side' : '3q') + '.png';
      try {
        const shot = await page.evaluate(([key, cx, cy, cz]) => {
          const W = NZ.weapons.internals.WEAPONS;
          let cv = document.getElementById('nz-qa-cv');
          if (!cv) {
            cv = document.createElement('canvas');
            cv.id = 'nz-qa-cv'; cv.width = 720; cv.height = 405;
            cv.style.display = 'none'; document.body.appendChild(cv);
            window.__qaR = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
            window.__qaR.setSize(720, 405, false);
            if (THREE.SRGBColorSpace) window.__qaR.outputColorSpace = THREE.SRGBColorSpace;
            window.__qaR.toneMapping = THREE.ACESFilmicToneMapping;
            window.__qaR.toneMappingExposure = 1.6;
          }
          const sc = new THREE.Scene();
          sc.background = new THREE.Color(0x20242a);
          sc.add(new THREE.HemisphereLight(0xbfc8d6, 0x2a241c, 0.55));
          const k1 = new THREE.DirectionalLight(0xffe2b8, 2.1); k1.position.set(-0.6, 0.9, 0.5); sc.add(k1);
          const k2 = new THREE.DirectionalLight(0xaebccf, 0.5); k2.position.set(0.8, -0.2, -0.7); sc.add(k2);
          const g = W[key].root.clone(true);
          g.visible = true;
          g.traverse(o => {
            /* the live hands ride the active asset's root; a cloned pair
               floating on a studio gun is not the subject here */
            if (o.name === 'handR' || o.name === 'handL') { o.visible = false; return; }
            o.visible = true;
          });
          sc.add(g);
          const cam2 = new THREE.PerspectiveCamera(34, 720 / 405, 0.02, 10);
          cam2.position.set(cx, cy, cz);
          cam2.lookAt(0, 0.015, -0.24);
          window.__qaR.render(sc, cam2);
          return cv.toDataURL('image/png');
        }, [key, ...cam]);
        fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.split(',')[1], 'base64'));
      } catch (e) {
        console.log('  !!    beauty shot ' + name + ' failed: ' + String(e.message).split('\n')[0]);
      }
    }
  }

  ok(pageErrors.length === 0, 'no page errors' + (pageErrors.length ? ': ' + pageErrors.slice(0, 3).join(' | ') : ''));

  await browser.close();
  console.log(fails.length ? '\n' + fails.length + ' FAILURE(S)' : '\nALL PASS');
  console.log('art + screenshots in ' + OUT);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
