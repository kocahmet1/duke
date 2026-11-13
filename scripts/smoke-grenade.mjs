#!/usr/bin/env node
/* Grenade feature smoke test. Stages NUKEM.html into /tmp (local three.js,
   street modules dropped for boot speed, nz-weapons KEPT because the
   grenade's interplay with the 3D viewmodel module is exactly what needs
   testing; --enemies keeps nz-enemies too), boots it headless, then drives
   the game DETERMINISTICALLY: the world is paused the moment it starts and
   every gameplay tick is stepped by hand inside page.evaluate --
   updatePlayer/updateGrenades called with fixed dt, no wall-clock, no
   SwiftShader rendering of a woken enemy horde. The rAF loop keeps painting
   a frozen scene, which is all the nz-weapons visibility checks need.

     1. static surface: WPN[5], PICKDEF.wgrenade, VM sprites, level spawn
     2. swap to grenade: nz-weapons parks its 3D rig for the 2D glove
     3. throw: arc physics, bounce, fuse, explosion, GRENADE kill credit
     4. blast: enemy takes radius damage, aiNoise wiring
     5. swap back: the 3D rig returns for the pistol
     6. last grenade: the empty hand autoswaps away
     7. dumps VM frames + pickup icon as PNGs for eyeball QA

   Exits non-zero on any failure or any page error. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = '/sessions/adoring-vigilant-pascal/mnt/duke nukem';
const STAGE = '/tmp/nzs2b';
const OUT = process.env.SMOKE_OUT || '/tmp/smoke-out';
const WITH_ENEMIES = process.argv.includes('--enemies');
const DROP = ['nz-render.js', 'nz-audio.js', 'nz-env.js', 'nz-street.js', 'nz-street-ground.js',
  'nz-street-entrance.js', 'nz-street-props.js', 'nz-street-sky.js', 'nz-shots.js']
  .concat(WITH_ENEMIES ? [] : ['nz-enemies.js']);

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
  html = html.replaceAll('<script src="' + f + '"></script>', '<!-- smoke: ' + f + ' dropped -->');
fs.writeFileSync(path.join(STAGE, 'NUKEM.smoke.html'), html);

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
      '--window-size=320,200'],
    protocolTimeout: 120000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 200 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message).split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text().split('\n')[0]); });
  page.on('error', e => { console.log('  !!    page CRASHED: ' + e.message); });

  const t0 = Date.now();
  await page.goto('file://' + path.join(STAGE, 'NUKEM.smoke.html'), { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('typeof state !== "undefined" && state.booted === true', { timeout: 90000 });
  console.log('boot ' + ((Date.now() - t0) / 1000).toFixed(1) + 's' + (WITH_ENEMIES ? '  (with nz-enemies)' : ''));

  /* ---- 1. static surface ---- */
  const stat = await page.evaluate(() => ({
    wpnLen: WPN.length, name: WPN[5] && WPN[5].name, thrown: !!(WPN[5] && WPN[5].thrown),
    sprite2d: !!(WPN[5] && WPN[5].sprite2d),
    pickdef: !!PICKDEF.wgrenade, ammoMax: AMMOMAX.grenade,
    vm: !!(VM.grenade && VM.grenade.length === 3 && VM.grenade_ads && VM.grenade_ads.length === 3),
    tex: !!(PICKTEX.wgrenade && PICKTEX.grenade),
    spawned: SPAWNS.some(s => s.kind === 'wgrenade' && s.x === 19 && s.y === 25),
    world: pickups.some(p => p.kind === 'wgrenade' && !p.taken),
    hasLen: player.has.length, flags: window.NZ ? NZ.flags : null
  }));
  /* length-agnostic: other agents add weapons to WPN behind slot 6 */
  ok(stat.wpnLen >= 6 && stat.name === 'GRENADE' && stat.thrown, 'WPN[5] GRENADE thrown');
  ok(stat.pickdef && stat.ammoMax === 10, 'PICKDEF.wgrenade + AMMOMAX.grenade');
  ok(stat.vm && stat.tex, 'VM frames (3+3ads) + pickup textures baked');
  ok(stat.spawned && stat.world, 'wgrenade spawned in west chamber (19,25)');
  ok(stat.hasLen === stat.wpnLen, 'player.has covers every WPN slot');
  ok(stat.flags && stat.flags.weapons === true, 'nz-weapons installed');
  if (WITH_ENEMIES) ok(stat.flags && stat.flags.enemies === true, 'nz-enemies installed');

  /* ---- art dump for eyeball QA ---- */
  const art = await page.evaluate(() => ({
    f0: VM.grenade[0].toDataURL(), f1: VM.grenade[1].toDataURL(), f2: VM.grenade[2].toDataURL(),
    icon: PICKTEX['wgrenade_canvas'].toDataURL(), world: PICKTEX['grenade_canvas'].toDataURL()
  }));
  for (const [k, v] of Object.entries(art))
    fs.writeFileSync(path.join(OUT, 'vm_' + k + '.png'), Buffer.from(v.split(',')[1], 'base64'));

  /* ---- 2. start paused, arm, hand-tick the swap ---- */
  const armed = await page.evaluate(() => {
    startGame();
    state.playing = false; state.paused = true;   /* freeze: we tick by hand */
    state.graceT = 0;
    player.has[5] = true; player.ammo.grenade = 3;
    selectWeapon(5);
    for (let i = 0; i < 30 && (player.pending >= 0 || player.weapon !== 5); i++) updatePlayer(.05);
    /* burn the raise animation too, or a paused overlay grab catches the
       glove still below the frame */
    for (let i = 0; i < 10; i++) updatePlayer(.05);
    return { weapon: player.weapon, pending: player.pending };
  });
  ok(armed.weapon === 5 && armed.pending < 0, 'grenade selected (slot 6)');
  /* a few real frames so nz-weapons' viewmodel hook sees the change */
  await new Promise(r => setTimeout(r, 900));
  const rig = await page.evaluate(() => {
    const W = NZ.weapons.internals.WEAPONS; const v = [];
    for (const k in W) if (W[k] && W[k].root && W[k].root.visible) v.push(k);
    const tris = NZ.weapons.stats().tris;
    return { cur: NZ.weapons.stats().weapon, visible: v, tris };
  });
  ok(rig.cur === 5 && rig.visible.length === 1 && rig.visible[0] === 'grenade',
    'nz-weapons shows its 3D grenade rig (was 2D fallback)');
  ok(rig.tris > 400, '3D grenade has real geometry (' + rig.tris + ' tris)');

  /* in-situ grab of the 2D overlay: the glove + grenade as the player sees
     it (2D canvas -> toDataURL is instant, unlike a SwiftShader readback) */
  const ovShot = await page.evaluate(() => document.getElementById('overlay').toDataURL());
  fs.writeFileSync(path.join(OUT, 'vm_ingame.png'), Buffer.from(ovShot.split(',')[1], 'base64'));

  /* ---- 2b. rig round-trip EARLY, while the scene is calm: the module's
     memory footprint tripled with the AK/M4/DMR builders and this sandbox's
     SwiftShader does not survive long once a blast has woken the map, so
     every real-frame wait happens before the first explosion. ---- */
  await page.evaluate(() => {
    selectWeapon(0);
    for (let i = 0; i < 40 && (player.pending >= 0 || player.weapon !== 0); i++) updatePlayer(.05);
  });
  /* condition, not clock: frames run at single digits under SwiftShader */
  await page.waitForFunction('NZ.weapons.stats().weapon === 0', { timeout: 20000 });
  const rig2 = await page.evaluate(() => {
    const W = NZ.weapons.internals.WEAPONS; const v = [];
    for (const k in W) if (W[k] && W[k].root && W[k].root.visible) v.push(k);
    return { visible: v, cur: NZ.weapons.stats().weapon };
  });
  ok(rig2.cur === 0 && rig2.visible.length === 1 && rig2.visible[0] === 'pistol',
    'swap back to pistol restores the 3D viewmodel');
  await page.evaluate(() => {
    selectWeapon(5);
    for (let i = 0; i < 40 && (player.pending >= 0 || player.weapon !== 5); i++) updatePlayer(.05);
  });

  /* ---- 3. throw + hand-stepped flight + fuse + blast ---- */
  const flight = await page.evaluate(() => {
    player.yaw = 0; player.pitch = 0.30;   /* lob north up the street, arcing */
    camera.rotation.y = player.yaw; camera.rotation.x = player.pitch;
    player.cool = 0;
    const before = player.ammo.grenade;
    fire();
    const g = grenades[0];
    if (!g) return { spawned: false, before, after: player.ammo.grenade };
    const x0 = g.p.x, z0 = g.p.z, cool = player.cool;
    /* 3 simulated seconds at 20 Hz: arc, bounces, roll-out, fuse, boom.
       Range = farthest point reached, because a bounced ball rolls back. */
    let peak = g.p.y, restAt = -1, steps = 0, range = 0;
    for (let i = 0; i < 60 && grenades.length; i++) {
      updateGrenades(.05); steps = i + 1;
      if (grenades[0]) {
        peak = Math.max(peak, grenades[0].p.y);
        range = Math.max(range, Math.hypot(grenades[0].p.x - x0, grenades[0].p.z - z0));
        if (grenades[0].rest && restAt < 0) restAt = i * .05;
      }
    }
    return {
      spawned: true, before, after: player.ammo.grenade, cool,
      exploded: grenades.length === 0, travelled: range,
      peak, restAt, bounces: g.bounces, steps,
      parts: parts.length, fed: KILL_BY.wep
    };
  });
  ok(flight.spawned && flight.before === 3 && flight.after === 2, 'fire() spends 1 grenade, spawns projectile');
  ok(flight.cool > 0, 'throw sets rate-of-fire cooldown');
  ok(flight.travelled > 5, 'grenade travelled (arc physics ran)');
  ok(flight.bounces > 0 || flight.restAt >= 0, 'grenade bounced / came to rest before the fuse');
  ok(flight.exploded, 'fuse expired -> grenade exploded and cleaned up');
  ok(flight.parts > 0, 'explosion particles spawned');
  ok(flight.fed === 'GRENADE', 'kill credit label is GRENADE');
  console.log('  info  flew ' + flight.travelled.toFixed(1) + 'u, peak y ' + flight.peak.toFixed(1) +
    ', ' + flight.bounces + ' bounce(s), rest at ' + (flight.restAt >= 0 ? flight.restAt.toFixed(2) + 's' : 'never') +
    ', boom after ' + (flight.steps * .05).toFixed(2) + 's');

  /* ---- 4. point-blank blast on an enemy: radius damage + noise wiring ---- */
  const dmg = await page.evaluate(() => {
    const e = enemies.find(e => !e.dead);
    if (!e) return { none: true };
    const hp0 = e.hp;
    let noise = null;
    const realNoise = aiNoise;
    aiNoise = (x, z, r, k) => { noise = { r, k }; realNoise(x, z, r, k); };
    player.x = e.x + 60; player.z = e.z + 60;   /* out of self-splash range */
    explode(new THREE.Vector3(e.x, e.cy(), e.z), 22, 150, 'GRENADE');
    aiNoise = realNoise;
    return {
      none: false, hp0, hp1: e.hp, dead: e.dead,
      noise,
      alerted: !!(e.ai && (e.ai.alert > 0 || e.ai.heard || e.ai.state !== 'idle'))
    };
  });
  ok(!dmg.none && (dmg.dead || dmg.hp1 < dmg.hp0), 'explode() deals radius damage to enemies');
  ok(dmg.noise && dmg.noise.r === 210, 'blast rings aiNoise at 210 units (enemies converge)');
  console.log('  info  enemy hp ' + dmg.hp0 + ' -> ' + (dmg.dead ? 'DEAD' : dmg.hp1) + (dmg.alerted ? ' (AI reacted)' : ''));

  /* ---- 5. autoswap off the empty hand (hand-ticked, no real waits) ---- */
  const auto = await page.evaluate(() => {
    player.ammo.grenade = 1;
    if (player.weapon !== 5) { selectWeapon(5); for (let i = 0; i < 40 && (player.pending >= 0 || player.weapon !== 5); i++) updatePlayer(.05); }
    player.cool = 0;
    fire();
    const spent = player.ammo.grenade;
    for (let i = 0; i < 40 && player.weapon === 5 && player.pending < 0; i++) updatePlayer(.05);
    return { spent, dest: player.pending >= 0 ? player.pending : player.weapon };
  });
  ok(auto.spent === 0 && auto.dest !== 5, 'empty hand autoswaps off the grenade (to slot ' + (auto.dest + 1) + ')');

  ok(pageErrors.length === 0, 'zero page errors' + (pageErrors.length ? ' -- ' + pageErrors.slice(0, 3).join(' | ') : ''));

  await browser.close();
  console.log(fails.length ? '\nSMOKE FAILED: ' + fails.length : '\nSMOKE PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('smoke crashed: ' + e.message); process.exit(2); });
