#!/usr/bin/env node
/* ===========================================================================
   render-critic.mjs -- headless runner for _critic_operators.html.

   Launches chrome-headless-shell with the SwiftShader args that are known to
   give a real WebGL2 context in this sandbox, waits for `document.title` to
   become 'CRITIC READY', pulls the composited sheet straight off the page's
   2D canvas and writes a PNG.

   HARD BUDGET: one invocation must finish inside 40 s, because a shell call
   is capped at 45 s.  Everything below is shaped by that:

     * the default is ONE cell, not a sheet;
     * --sheet renders as many still-missing cells as fit in the remaining
       budget, writing each PNG as it completes, then prints what is left.
       Re-running picks up where it stopped, so a full sheet is built over
       several calls without ever redoing work;
     * every phase prints its elapsed time so the budget stays visible.

   Owned by the CRITIC-RIG agent (this file + _critic_operators.html + /tmp).

     node scripts/render-critic.mjs                                  # one cell
     node scripts/render-critic.mjs --kind=pig --pose=walk --cell=feet
     node scripts/render-critic.mjs --sheet=roster            # 4 calls, resumable
     node scripts/render-critic.mjs --sheet=trooper:aim:tq:full,trooper:aim:tq:hands
     node scripts/render-critic.mjs --list
   ======================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* --------------------------------------------------------------- runtime -- */
/* puppeteer lives outside the repo (the project has no node_modules and must
   not grow one); the chrome build and its hand-extracted shared libs live in
   /tmp.  Everything is overridable so this survives a different sandbox. */
const PP_DIR   = process.env.CRITIC_PP   || '/tmp/pp';
const CHROME   = process.env.CRITIC_CHROME ||
  '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell';
const LIB_DIRS = process.env.CRITIC_LIBS ||
  '/tmp/root/lib/x86_64-linux-gnu:/tmp/root/usr/lib/x86_64-linux-gnu:/tmp/root/usr/lib/x86_64-linux-gnu/nss';

/* ------------------------------------------------------------------- cli -- */
const ARGV = process.argv.slice(2);
function flag(name, dflt) {
  const i = ARGV.findIndex(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (i < 0) return dflt;
  const hit = ARGV[i], eq = hit.indexOf('=');
  if (eq >= 0) return hit.slice(eq + 1);
  const next = ARGV[i + 1];
  if (next !== undefined && !next.startsWith('--')) return next;
  return true;
}
const OPT = {
  kind:  String(flag('kind', 'trooper')),
  pose:  String(flag('pose', 'aim')),
  view:  String(flag('view', 'tq')),
  cell:  String(flag('cell', 'full')),
  sheet: flag('sheet', null),
  cols:  Number(flag('cols', 0)) || 0,
  w:     Number(flag('w', 0)) || 0,
  h:     Number(flag('h', 0)) || 0,
  ss:    Number(flag('ss', 1)) || 1,
  nzq:   String(flag('nzq', 'high')),
  nzr:   String(flag('nzr', '1')),
  taa:   Number(flag('taa', 0)) || 0,
  fov:   Number(flag('fov', 0)) || 0,
  key:   flag('key', null),
  grid:  flag('grid', null),
  ev:    Number(flag('ev', 0)) || 0,
  /* which light rig.  studio = the calibrated neutral stage (an 18% grey card
     renders as 18% grey); level = NUKEM.html's own key/ambient/fog, so an
     operator is judged in the light the player actually sees. */
  env:   String(flag('env', 'studio')),
  frames: Number(flag('frames', 0)) || 0,   /* cell=anim strip length */
  keyaz: flag('keyaz', null),
  keyel: flag('keyel', null),
  keyi:  flag('keyi', null),                /* studio key intensity override  */
  envi:  flag('envi', null),                /* studio probe radiance override */
  dbg:   !!flag('dbg', false),
  seed:  Number(flag('seed', 0)) || 0,
  out:   flag('out', null),
  budget: Number(flag('budget', 36)) || 36,
  force: !!flag('force', false),
  one:   !!flag('one', false),          /* sheet: render at most one cell */
  combined: !!flag('combined', false),  /* sheet: also emit the grid image */
  list:  !!flag('list', false),
  keep:  !!flag('keep', false),         /* leave the browser open on failure */
  quiet: !!flag('quiet', false),
};

/* --------------------------------------------------------------- presets -- */
/* A named sheet is just a list of `kind:pose:view:cell` cells.  Kept here and
   not in the page so the runner can render them one PNG at a time. */
const KINDS = ['trooper', 'pig', 'enforcer', 'octa'];
const PRESETS = {
  /* the four operators, same pose, same light: the roster read */
  roster: KINDS.map(k => `${k}:aim:tq:full`),
  /* one operator all the way round */
  turntable: ['front', 'tq', 'side', 'back34', 'back', 'top'].map(v => `${OPT.kind}:aim:${v}:full`),
  /* the pose set the brief asks for */
  poses: ['idle', 'aim', 'walk', 'run', 'crouch', 'turn', 'dead'].map(p => `${OPT.kind}:${p}:tq:full`),
  /* the defects live here: every close-up on one operator */
  detail: [
    `${OPT.kind}:aim:tq:hands`, `${OPT.kind}:aim:side:weld`,
    `${OPT.kind}:walk:tq:feet`, `${OPT.kind}:aim:front:head`,
    `${OPT.kind}:aim:tq:weapon`, `${OPT.kind}:aim:tq:full`,
  ],
  /* every operator's weapon, side by side */
  guns: KINDS.map(k => `${k}:aim:tq:weapon`),
  /* every operator's hands on the gun */
  grips: KINDS.map(k => `${k}:aim:tq:hands`),
  /* every operator's feet mid-stride */
  planted: KINDS.map(k => `${k}:walk:tq:feet`),
  /* silhouette read -- CS2-BRIEF: "an object reads as real from its outline" */
  silhouettes: KINDS.map(k => `${k}:aim:side:silhouette`),
  /* calibration: chrome ball + colourchecker + grey wedge + height ruler */
  calib: [`${OPT.kind}:aim:tq:calib`],
  /* the baked atlas, flat, plus every material region on a cube and a sphere */
  materials: [`${OPT.kind}:idle:front:maps`],
  /* all four operators, one light, one lens, one frame */
  strip: ['-:aim:front:roster'],
  /* one continuous walk cycle laid out in phase order, with foot telemetry */
  anim: [`${OPT.kind}:walk:side:anim`],
  /* operator vs a 1.83 m mannequin and a 1.20 m crate */
  scale: [`${OPT.kind}:idle:front:scale`],
  /* the same operator under BOTH light rigs -- run with --env twice */
  audit: [`${OPT.kind}:aim:tq:calib`, `${OPT.kind}:idle:front:maps`,
          '-:aim:front:roster', `${OPT.kind}:walk:side:anim`, `${OPT.kind}:idle:front:scale`],
};

if (OPT.list) {
  console.log('presets:');
  for (const [k, v] of Object.entries(PRESETS)) console.log('  ' + k.padEnd(12) + v.length + ' cells  ' + v.join(' '));
  console.log('\ncells:  full silhouette calib head hands weld feet weapon');
  console.log('        maps roster anim scale        (composite: one cell, whole frame)');
  console.log('poses:  idle aim walk run crouch turn dead');
  console.log('views:  front tq side back34 back top left left34');
  console.log('kinds:  ' + KINDS.join(' '));
  console.log('env:    studio (calibrated 18%->18%) | level (NUKEM.html rig verbatim)');
  process.exit(0);
}

/* --------------------------------------------------------------- helpers -- */
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const say = (...a) => { if (!OPT.quiet) console.log('[' + el() + ']', ...a); };
const left = () => OPT.budget - (Date.now() - T0) / 1000;

function cellsOf() {
  if (!OPT.sheet) return [`${OPT.kind}:${OPT.pose}:${OPT.view}:${OPT.cell}`];
  const s = String(OPT.sheet);
  if (PRESETS[s]) return PRESETS[s].slice();
  return s.split(',').map(x => x.trim()).filter(Boolean);
}
function normCell(c, i) {
  const p = String(c).split(':');
  const pick = (k, d) => (p[k] && p[k] !== '-') ? p[k] : d;
  return {
    spec: c,
    kind: pick(0, OPT.kind), pose: pick(1, OPT.pose),
    view: pick(2, OPT.view), cell: pick(3, OPT.cell),
    i,
  };
}
/* the environment is part of the identity of a shot: a studio-lit and a
   level-lit frame of the same operator are two different pictures and must not
   overwrite each other */
const ENVTAG = OPT.env === 'level' ? '_level' : '';
function outPathFor(c, dir) {
  return path.join(dir, `${String(c.i).padStart(2, '0')}_${c.kind}_${c.pose}_${c.view}_${c.cell}${ENVTAG}.png`);
}

/* default sizes: a standing operator wants a portrait frame, a close-up a
   square one.  Too small is the same as not rendering -- a critic cannot see
   a stock weld in 300 px. */
/* Sized against the measured cost of this sandbox's software rasteriser:
   ~8 us per pixel per TAA frame at nzq=high.  Bigger than this and a single
   cell no longer fits in one 40 s shell call, which is worse than a slightly
   smaller image -- but small enough that a defect is invisible is also a
   failure, so these are the largest that still let 2-3 cells through. */
/* The composite cells are wide because that is their whole point -- four
   operators or eight gait phases cannot be compared in a square. The pixel
   budgets below were picked against the measured ~8.2 us/px/TAA-frame cost so
   each still lands inside one 40 s shell call:
     roster 1200x580 x3 = 2.1 Mpx-frames ~ 17 s
     scale   800x880 x3 = 2.1 Mpx-frames ~ 17 s
     maps   1200x820, of which only the 1200x~350 ball row is rendered ~ 9 s
     anim   1280x460, rendered as 8 x (160x~340) sub-frames    ~ 11 s        */
function sizeFor(cell) {
  if (OPT.w && OPT.h) return [OPT.w, OPT.h];
  if (cell === 'full' || cell === 'silhouette') return [OPT.w || 580, OPT.h || 780];
  if (cell === 'calib') return [OPT.w || 900, OPT.h || 620];
  if (cell === 'maps') return [OPT.w || 1200, OPT.h || 820];
  if (cell === 'roster') return [OPT.w || 1200, OPT.h || 580];
  if (cell === 'anim') return [OPT.w || 1280, OPT.h || 460];
  if (cell === 'scale') return [OPT.w || 800, OPT.h || 880];
  return [OPT.w || 700, OPT.h || 580];
}
/* how much of the cell is actually rasterised (the rest is 2D overlay) */
const RENDER_FRACTION = { maps: 0.42, anim: 0.74, calib: 1, roster: 1, scale: 1 };
/* seconds of GPU + readback for one cell of this size, measured empirically */
const PX_FRAME_US = 8.2;
function costOf(cell, taa) {
  const [w, h] = sizeFor(cell);
  const frac = RENDER_FRACTION[cell] === undefined ? 1 : RENDER_FRACTION[cell];
  return (w * h * frac * taa * PX_FRAME_US) / 1e6 + 1.4;
}

function buildURL(cells, size, cols, deadlineMs) {
  const q = new URLSearchParams();
  if (cells.length === 1) {
    q.set('kind', cells[0].kind); q.set('pose', cells[0].pose);
    q.set('view', cells[0].view); q.set('cell', cells[0].cell);
  } else {
    q.set('sheet', cells.map(c => `${c.kind}:${c.pose}:${c.view}:${c.cell}`).join(','));
    q.set('cols', String(cols));
  }
  q.set('w', String(size[0])); q.set('h', String(size[1]));
  q.set('ss', String(OPT.ss));
  q.set('nzq', OPT.nzq);
  q.set('nzr', OPT.nzr);
  q.set('taa', String(OPT.taa || 3));
  q.set('env', OPT.env === 'level' ? 'level' : 'studio');
  if (OPT.frames) q.set('frames', String(OPT.frames));
  if (OPT.fov) q.set('fov', String(OPT.fov));
  if (OPT.key) q.set('key', String(OPT.key));
  if (OPT.keyaz !== null) q.set('keyaz', String(OPT.keyaz));
  if (OPT.keyel !== null) q.set('keyel', String(OPT.keyel));
  if (OPT.keyi !== null) q.set('keyi', String(OPT.keyi));
  if (OPT.envi !== null) q.set('envi', String(OPT.envi));
  if (OPT.grid) q.set('grid', '1');
  if (OPT.ev) q.set('ev', String(OPT.ev));
  if (OPT.dbg) q.set('dbg', '1');
  if (OPT.seed) q.set('seed', String(OPT.seed));
  if (deadlineMs) q.set('deadline', String(Math.round(deadlineMs)));
  const file = 'file://' + ROOT.split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:') +
               '/_critic_operators.html';
  return file.replace(/ /g, '%20') + '?' + q.toString();
}

/* --------------------------------------------------------------- the run -- */
(async () => {
  if (!fs.existsSync(path.join(ROOT, '_critic_operators.html')))
    fail('missing ' + path.join(ROOT, '_critic_operators.html'));
  if (!fs.existsSync(CHROME))
    fail('chrome-headless-shell not found at ' + CHROME +
      '\n  re-create it: unzip ~/.cache/puppeteer/dl/chs.zip -d /tmp/chs' +
      '\n  and the libs: for d in /tmp/deb/*.deb; do dpkg-deb -x "$d" /tmp/root; done');

  /* the shared libs were hand-extracted, so the loader has to be told */
  const ld = process.env.LD_LIBRARY_PATH ? LIB_DIRS + ':' + process.env.LD_LIBRARY_PATH : LIB_DIRS;
  process.env.LD_LIBRARY_PATH = ld;

  const require = createRequire(path.join(PP_DIR, 'noop.cjs'));
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch (e) { fail('puppeteer not importable from ' + PP_DIR + ': ' + e.message); }

  const all = cellsOf().map(normCell);
  const outArg = OPT.out ? String(OPT.out) : null;
  const isSheet = all.length > 1;
  const outDir = isSheet
    ? path.resolve(ROOT, outArg || path.join('_critic_shots', String(OPT.sheet || 'sheet').replace(/[^\w.-]/g, '_')))
    : path.dirname(path.resolve(ROOT, outArg || path.join('_critic_shots', `${all[0].kind}_${all[0].pose}_${all[0].view}_${all[0].cell}${ENVTAG}.png`)));
  fs.mkdirSync(outDir, { recursive: true });

  /* resumable: skip anything already on disk */
  let todo = all;
  const singleOut = !isSheet ? path.resolve(ROOT, outArg || path.join('_critic_shots', `${all[0].kind}_${all[0].pose}_${all[0].view}_${all[0].cell}${ENVTAG}.png`)) : null;
  if (isSheet && !OPT.force) {
    todo = all.filter(c => !fs.existsSync(outPathFor(c, outDir)));
    const done = all.length - todo.length;
    if (done) say(`resume: ${done}/${all.length} cells already on disk in ${path.relative(ROOT, outDir)}`);
  }
  if (!todo.length) {
    say('nothing to do -- every cell exists. --force to redo.');
    if (OPT.combined) await combine(all, outDir);
    process.exit(0);
  }

  const [W, H] = sizeFor(todo[0].cell);
  say(`plan: ${todo.length} cell(s) pending, ${W}x${H} ss${OPT.ss} nzq=${OPT.nzq}, budget ${OPT.budget}s`);

  const tLaunch = Date.now();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--allow-file-access-from-files',
      '--enable-webgl', '--ignore-gpu-blocklist', '--hide-scrollbars',
      /* an accelerated 2D canvas deadlocks on toDataURL() after a WebGL
         drawImage under SwiftShader -- keep the compositor off it */
      '--disable-accelerated-2d-canvas',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--window-size=1280,800'],
  });
  say(`launch ${Date.now() - tLaunch}ms`);

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const issues = [];
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' || /error|fail|panic|warn|missing|NOT FOUND|DID NOT/i.test(t)) issues.push(m.type() + ': ' + t.slice(0, 400));
    else if (/^\[critic\]/.test(t)) say('page ' + t.slice(0, 220));
  });
  page.on('pageerror', e => issues.push('PAGEERROR: ' + String(e.message).slice(0, 400)));

  const written = [];
  let stopped = null;

  /* ONE page load for the whole pending batch.  The ~4.7 s module boot and the
     ~3 s of SwiftShader shader compilation are paid once, not once per cell,
     which is the difference between 1 cell and 6 cells inside 40 s.  The page
     publishes each finished cell as its own PNG and announces it through
     document.title, so a batch that runs out of budget still leaves every
     completed cell on disk -- nothing is lost and nothing is redone. */
  let batch = todo.filter(c => c.cell === todo[0].cell || !isSheet ||
    sizeFor(c.cell).join('x') === sizeFor(todo[0].cell).join('x'));
  if (OPT.one) batch = batch.slice(0, 1);
  const skippedSize = todo.length - batch.length;
  /* The page owns the stop decision -- it is the only thing that knows what a
     cell actually costs -- but it needs to be told where the wall is. */
  const deadlineMs = Math.max(6000, (OPT.budget - (Date.now() - T0) / 1000 - 2.5) * 1000);
  const u = buildURL(batch, sizeFor(batch[0].cell), OPT.cols || Math.ceil(Math.sqrt(batch.length)), deadlineMs);
  const taaN = OPT.taa || 3;
  say(`estimate: ~${costOf(batch[0].cell, taaN).toFixed(1)}s/cell + ~5.5s boot; page deadline ${(deadlineMs / 1000).toFixed(1)}s`);
  let grabbed = 0;
  try {
    /* NOT awaited: with a document.write'd module script in the head, this
       page's DOMContentLoaded does not fire until every cell has already been
       drawn, so awaiting goto would mean discovering the whole batch at the
       end instead of collecting cells as they land. */
    const g0 = Date.now();
    page.goto(u, { waitUntil: 'domcontentloaded', timeout: Math.max(4000, left() * 1000) })
      .then(() => say(`domcontentloaded ${Date.now() - g0}ms`))
      .catch(e => say('goto: ' + String(e.message).split('\n')[0]));
    say(`navigating -> ${batch.length} cell(s) queued`);

    /* Poll the title and pull each cell down the moment it is announced.
       The page's main thread is blocked solid during a readback, so a title
       poll can be several seconds stale and several announcements can be
       collapsed into one -- always drain up to whatever the page says it has,
       and drain again on READY. */
    let tCell = Date.now();
    const drainTo = async (idx) => {
      while (grabbed <= idx) {
        const c = batch[grabbed];
        const target = isSheet ? outPathFor(c, outDir) : singleOut;
        const dataUrl = await page.evaluate(k => (window.__criticCellPNG ? window.__criticCellPNG(k) : null), grabbed);
        if (!dataUrl) break;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(dataUrl.split(',')[1], 'base64'));
        written.push(target);
        say(`ok  ${path.relative(ROOT, target)}  (+${((Date.now() - tCell) / 1000).toFixed(1)}s)`);
        tCell = Date.now();
        grabbed++;
      }
    };
    let lastTitle = '';
    for (;;) {
      let title = '';
      try { title = await page.title(); } catch (e) { /* mid-navigation */ }
      if (title !== lastTitle) {
        lastTitle = title;
        const m = /^CRITIC CELL (\d+)\/(\d+)/.exec(title);
        if (m) await drainTo(+m[1] - 1);
      }
      if (title === 'CRITIC READY') { await drainTo(batch.length - 1); break; }
      if (left() < 2.5) {
        stopped = `budget exhausted after ${grabbed}/${batch.length} cells`;
        await drainTo(batch.length - 1).catch(() => {});
        break;
      }
      await new Promise(r => setTimeout(r, 90));
    }

    const info = await page.evaluate(() => (window.__criticInfo ? {
      marks: window.__criticInfo.timing.marks, total: window.__criticInfo.timing.totalMs,
      warn: window.__criticInfo.warn, cells: window.__criticInfo.cells,
      stoppedEarly: window.__criticInfo.stoppedEarly,
      calib: window.__criticInfo.calib || null,
      anim: window.__criticInfo.anim || null,
      q: window.__criticInfo.render && window.__criticInfo.render.quality,
    } : null)).catch(() => null);
    if (info) {
      say(`page: ${(info.marks || []).join(' ')} total=${info.total}ms tier=${info.q}`);
      if (info.calib) {
        const c = info.calib;
        say(`CALIB env=${c.mode}  18% key tab -> ${c.key ? c.key.srgb : '?'}/255 ` +
            `(scene-linear ${c.key ? c.key.lin : '?'}, x${c.key ? c.key.mul : '?'} of albedo) ` +
            `=> ${c.err === null ? 'n/a' : (c.err > 0 ? '+' : '') + c.err} stop` +
            (c.wb !== undefined ? `, wb R-B ${c.wb > 0 ? '+' : ''}${c.wb}%` : ''));
        for (const p of c.probes) say(`   ${String(p.name).padEnd(7)} albedo ${p.a.toFixed(3)} -> ${String(p.srgb).padStart(3)}/255 ` +
            `lin ${String(p.lin).padEnd(6)} x${p.mul} rgb[${p.rgb.join(',')}]${p.clip ? '  CLIPPED' : ''}`);
      }
      if (info.anim) for (const t of info.anim)
        say(`   anim p${Math.round(t.phase * 100)}%  ankleL ${t.lY === null ? '--' : (t.lY / 3.5 * 1000).toFixed(0)}mm  ankleR ${t.rY === null ? '--' : (t.rY / 3.5 * 1000).toFixed(0)}mm`);
      if (info.stoppedEarly) say(`page stopped early -- ${info.stoppedEarly}`);
      for (const c of (info.cells || [])) say(`  cell ${c.spec.kind}/${c.spec.pose}/${c.spec.cell}: pose=${c.poseMs}ms draw=${c.drawMs}ms lod=${c.tier} dist=${c.dist}`);
      if (info.warn && info.warn.length) for (const w of info.warn) console.log('  WARN ' + w);
    }
    if (!stopped && isSheet && grabbed >= batch.length && OPT.combined) {
      const dataUrl = await page.evaluate(() => window.__criticPNG()).catch(() => null);
      if (dataUrl) {
        const dst = path.join(outDir, '_contact_sheet.png');
        fs.writeFileSync(dst, Buffer.from(dataUrl.split(',')[1], 'base64'));
        say('combined -> ' + path.relative(ROOT, dst));
      }
    }
  } catch (err) {
    const title = await page.title().catch(() => '?');
    console.log(`[${el()}] FAIL after ${grabbed} cell(s) -- ${err.message} (last title "${title}")`);
    stopped = 'error: ' + err.message;
  }
  if (skippedSize) say(`${skippedSize} cell(s) deferred: different output size, rerun to pick them up`);

  if (issues.length) {
    console.log('--- page issues ---');
    for (const i of [...new Set(issues)].slice(0, 24)) console.log('  ' + i);
  }
  if (!OPT.keep) await browser.close();

  if (isSheet) {
    const remaining = all.filter(c => !fs.existsSync(outPathFor(c, outDir)));
    say(`sheet ${all.length - remaining.length}/${all.length} complete in ${path.relative(ROOT, outDir)}`);
    if (remaining.length) {
      console.log(`[${el()}] ${stopped || 'stopped'} -- rerun the SAME command to continue:`);
      console.log('       remaining: ' + remaining.map(r => r.spec).join(' '));
    } else if (OPT.combined && !fs.existsSync(path.join(outDir, '_contact_sheet.png'))) {
      await combine(all, outDir);
    }
  }
  say(`done in ${el()}, wrote ${written.length} file(s)`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

/* ------------------------------------------------------------- utilities -- */

async function waitReady(page, budgetS) {
  const t0 = Date.now(), lim = budgetS * 1000;
  let last = '';
  for (;;) {
    let title = '';
    try { title = await page.title(); } catch (e) { /* navigating */ }
    if (title && title !== last) { last = title; if (/^CRITIC \d/.test(title)) say('    ' + title); }
    if (title === 'CRITIC READY') return;
    if (Date.now() - t0 > lim) throw new Error(`timed out after ${(lim / 1000).toFixed(1)}s waiting for CRITIC READY (title="${title}")`);
    await new Promise(r => setTimeout(r, 90));
  }
}

/* Stitch the per-cell PNGs into one contact sheet.  Uses the browser that is
   already here rather than pulling in an image library. */
async function combine(all, dir) {
  const require = createRequire(path.join(PP_DIR, 'noop.cjs'));
  const puppeteer = require('puppeteer');
  const files = all.map(c => outPathFor(c, dir)).filter(f => fs.existsSync(f));
  if (!files.length) return;
  const cols = OPT.cols || Math.ceil(Math.sqrt(files.length));
  const b = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files', '--disable-dev-shm-usage'] });
  const p = (await b.pages())[0] || await b.newPage();
  /* an about:blank page has an opaque origin and cannot read file:// images
     even with --allow-file-access-from-files; a real file:// page can, so the
     stitcher is written next to the cells it is stitching */
  const stitchHtml = path.join(dir, '_stitch.html');
  fs.writeFileSync(stitchHtml, '<!doctype html><meta charset=utf-8><title>stitch</title><body></body>');
  const urls = files.map(f => encodeURIComponent(path.basename(f)));
  await p.goto('file://' + stitchHtml.split(path.sep).join('/').replace(/ /g, '%20'));
  const out = await p.evaluate(async (urls, cols) => {
    const imgs = await Promise.all(urls.map(u => new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('load ' + u)); i.src = u;
    })));
    const cw = Math.max(...imgs.map(i => i.width)), ch = Math.max(...imgs.map(i => i.height));
    const rows = Math.ceil(imgs.length / cols);
    const c = document.createElement('canvas');
    c.width = cw * cols; c.height = ch * rows;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#0d0f11'; g.fillRect(0, 0, c.width, c.height);
    imgs.forEach((im, k) => g.drawImage(im, (k % cols) * cw, Math.floor(k / cols) * ch));
    return c.toDataURL('image/png');
  }, urls, cols);
  const dst = path.join(dir, '_contact_sheet.png');
  fs.writeFileSync(dst, Buffer.from(out.split(',')[1], 'base64'));
  try { fs.unlinkSync(stitchHtml); } catch (e) {}
  await b.close();
  say('combined -> ' + path.relative(ROOT, dst));
}

function fail(msg) { console.error('render-critic: ' + msg); process.exit(2); }
