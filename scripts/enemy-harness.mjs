#!/usr/bin/env node
/* ===========================================================================
   enemy-harness.mjs -- headless numeric validation of the enemy rig.

   Boots the REAL game modules (vendor/three.r149.min.js + nz-core.js +
   nz-enemies.js) inside a Node `vm` context with a stubbed DOM and a
   functional-enough Canvas2D, installs the module through its own `ready`
   hook, spawns entities shaped exactly like the ones NUKEM.html's spawnEnemy
   makes, drives a scripted 900-frame locomotion scenario at 60 Hz, samples
   bone world matrices every frame, and measures the metrics in section 5 of
   CS2-ENEMY-BRIEF.md.

   Exit 0 = every live metric green.  Exit 1 = at least one FAIL.
   SKIPPED metrics never count as PASS -- they are reported with a reason.

     node scripts/enemy-harness.mjs
     node scripts/enemy-harness.mjs --json
     node scripts/enemy-harness.mjs --kind=trooper --verbose
     node scripts/enemy-harness.mjs --write-baseline=scripts/enemy-baseline.json
     node scripts/enemy-harness.mjs --baseline=scripts/enemy-baseline.json

   Owned by the HARNESS agent (scripts/** + vendor/**).  Reads everything,
   writes nothing outside scripts/.
   ======================================================================== */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/* ============================================================== cli ===== */

const ARGV = process.argv.slice(2);
/* Accepts --name, --name=value and --name value. */
const VALUED = new Set(['root', 'kind', 'frames', 'baseline', 'write-baseline']);
function flag(name, dflt) {
  const i = ARGV.findIndex(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (i < 0) return dflt;
  const hit = ARGV[i], eq = hit.indexOf('=');
  if (eq >= 0) return hit.slice(eq + 1);
  if (VALUED.has(name)) {
    const next = ARGV[i + 1];
    if (next !== undefined && !next.startsWith('--')) return next;
  }
  return true;
}
const OPT = {
  root: String(flag('root', path.resolve(HERE, '..'))),
  json: !!flag('json', false),
  verbose: !!flag('verbose', false),
  kinds: String(flag('kind', '')).split(',').filter(Boolean),
  frames: Number(flag('frames', 0)) || 0,
  baseline: flag('baseline', null),
  writeBaseline: flag('write-baseline', null),
  quiet: !!flag('quiet', false),
  debug: !!flag('debug', false),
};
const ROOT = OPT.root;
const rd = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

/* ================================================= thresholds (brief) === */
/* Section 5 of CS2-ENEMY-BRIEF.md.  SCALE = 3.5 world units per metre, so
   1 mm = 0.0035 units.  Every threshold below carries its millimetre value. */
const MM = 0.0035;                       /* world units per millimetre        */
const T = {
  footSkate:      1.0 * MM,              /* per-frame lateral slip, planted    */
  footPenetrate:  5.0 * MM,              /* sole below ground                  */
  footFloat:      5.0 * MM,              /* sole above ground during stance    */
  kneeInversion:  0,                     /* events over the run                */
  kneeMinDeg:     0,                     /* flexion floor                      */
  kneeMaxDeg:     150,                   /* flexion ceiling                    */
  supportHand:   20.0 * MM,              /* left hand -> handguard             */
  triggerHand:   15.0 * MM,              /* right hand -> pistol grip          */
  nonFinite:      0,
  weaponOALPct:   5,                     /* percent deviation from spec        */
  elbowInTorso:   0,                     /* frames                             */
  strideCohPct:   12,                    /* percent |1 - steps/travel|         */
};

/* Weapon overall length, section 2 of the brief: real OAL x SCALE. */
const WEAPON_SPEC = {
  trooper:  { name: 'AK-pattern AR',  mm: 880,  units: 3.08 },
  enforcer: { name: 'M4-pattern AR',  mm: 840,  units: 2.94 },
  pig:      { name: 'combat shotgun', mm: 1005, units: 3.52 },
  octa:     { name: 'bolt DMR',       mm: 1160, units: 4.06 },
};
const DISPLAY_FALLBACK = { trooper: 'RIFLEMAN', pig: 'BREACHER', enforcer: 'ASSAULTER', octa: 'MARKSMAN' };
const ALL_KINDS = ['trooper', 'pig', 'enforcer', 'octa'];

/* Last-resort ECFG, from CS2-ENEMY-BRIEF.md section 2.  Only used if the real
   literal cannot be found in NUKEM.html; the harness says so when it happens. */
const ECFG_FALLBACK = {
  trooper:  { hp: 34, spd: 10.5, rad: 1.6,  w: 5.0, h: 6.4, stride: 4.6, turn: 6.8, range: 52, sight: 56, keep: 16, accel: 48, decel: 62, glow: [1, .17, .09] },
  pig:      { hp: 80, spd: 9,    rad: 1.82, w: 6.2, h: 7.2, stride: 5.2, turn: 5.4, range: 38, sight: 52, keep: 9,  accel: 38, decel: 54, glow: [.45, .85, 1] },
  enforcer: { hp: 115, spd: 12.5, rad: 1.80, w: 6.0, h: 7.8, stride: 5.6, turn: 7.4, range: 62, sight: 68, keep: 14, accel: 58, decel: 70, burst: true, glow: [1, .60, .12] },
  octa:     { hp: 66, spd: 8.5,  rad: 1.82, w: 6.2, h: 6.2, stride: 4.6, turn: 4.8, range: 52, sight: 58, keep: 18, accel: 30, decel: 38, glow: [.5, 1, .38] },
};

/* ==================================================== canvas 2d stub ==== */
/* Not a renderer -- a shape-correct sink.  NZ.tex.bake() calls fillRect /
   getImageData / putImageData / createImageData / gradients / paths on this
   and must not throw; the harness measures geometry, never pixels. */
function makeCtx2D(canvas) {
  const grad = () => ({ addColorStop() {} });
  return {
    canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    direction: 'ltr', shadowBlur: 0, shadowColor: '#000',
    shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none', miterLimit: 10,
    lineDashOffset: 0, imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto',
    createImageData(w, h) {
      if (w && typeof w === 'object') { h = w.height; w = w.width; }
      w = Math.max(1, w | 0); h = Math.max(1, h | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' };
    },
    getImageData(x, y, w, h) {
      w = Math.max(1, w | 0); h = Math.max(1, h | 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' };
    },
    putImageData() {}, drawImage() {}, save() {}, restore() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, arcTo() {}, ellipse() {},
    rect() {}, roundRect() {}, fill() {}, stroke() {}, clip() {}, resetClip() {},
    fillRect() {}, strokeRect() {}, clearRect() {},
    translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {}, resetTransform() {},
    setLineDash() {}, getLineDash() { return []; },
    fillText() {}, strokeText() {},
    measureText(t) {
      const n = t ? String(t).length : 0;
      return {
        width: n * 6, actualBoundingBoxLeft: 0, actualBoundingBoxRight: n * 6,
        actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2,
      };
    },
    createLinearGradient: grad, createRadialGradient: grad, createConicGradient: grad,
    createPattern() { return { setTransform() {} }; },
    isPointInPath() { return false; }, isPointInStroke() { return false; },
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    drawFocusIfNeeded() {},
  };
}
function makeCanvas() {
  const el = {
    width: 1, height: 1, style: {}, nodeName: 'CANVAS', tagName: 'CANVAS',
    getContext(t) { return (t === '2d' || t === '2D') ? (el._c2d || (el._c2d = makeCtx2D(el))) : null; },
    toDataURL() { return 'data:,'; }, toBlob(cb) { cb && cb({}); },
    addEventListener() {}, removeEventListener() {}, remove() {},
    appendChild(x) { return x; }, setAttribute() {}, getAttribute() { return null; }, focus() {},
    getBoundingClientRect() { return { x: 0, y: 0, width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }; },
    transferToImageBitmap() { return {}; },
  };
  return el;
}
function makeEl(tag) {
  const t = String(tag).toLowerCase();
  if (t === 'canvas') return makeCanvas();
  const el = {
    nodeName: t.toUpperCase(), tagName: t.toUpperCase(), style: {}, children: [], childNodes: [],
    className: '', id: '', dataset: {}, innerHTML: '', textContent: '', value: '',
    appendChild(c) { el.children.push(c); return c; }, removeChild(c) { return c; },
    insertBefore(c) { return c; }, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, remove() {},
    getContext() { return null; }, focus() {}, blur() {}, click() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }; },
  };
  return el;
}

/* ======================================================== sandbox ======= */
function makeSandbox() {
  const s = {};
  s.globalThis = s; s.self = s; s.window = s; s.top = s; s.parent = s;
  s.console = OPT.quiet
    ? { log() {}, warn() {}, error() {}, info() {}, debug() {} }
    : { log() {}, info() {}, debug() {}, warn: (...a) => MODULE_WARNINGS.push(a.map(fmtArg).join(' ')),
        error: (...a) => MODULE_ERRORS.push(a.map(fmtArg).join(' ')) };
  /* simulated clock: the harness owns time, so dt is exact and repeatable */
  s.__clockMs = 0;
  s.performance = { now: () => s.__clockMs };
  s.Date = Date;
  /* rAF is queued, not dropped: nz-enemies runs its LOD pass on its own
     rAF beat, and the harness drains one level of that queue per frame.
     This means tier selection happens through the module's own code path
     instead of the harness poking private state. */
  s.__raf = [];
  s.requestAnimationFrame = fn => { s.__raf.push(fn); return s.__raf.length; };
  s.cancelAnimationFrame = () => {};
  s.setTimeout = () => 0; s.clearTimeout = () => {};
  s.setInterval = () => 0; s.clearInterval = () => {};
  s.queueMicrotask = fn => { try { fn && fn(); } catch (e) {} };
  s.Image = function () { return makeEl('img'); };
  s.OffscreenCanvas = function (w, h) { const c = makeCanvas(); c.width = w; c.height = h; return c; };
  s.ImageData = function (w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; };
  s.document = {
    createElement: makeEl, createElementNS: (ns, tag) => makeEl(tag),
    addEventListener() {}, removeEventListener() {},
    body: makeEl('body'), head: makeEl('head'), documentElement: makeEl('html'),
    getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    getElementsByTagName() { return []; }, createTextNode(v) { return { nodeValue: v }; },
    visibilityState: 'visible', hidden: false, readyState: 'complete',
    exitPointerLock() {}, pointerLockElement: null, fullscreenElement: null,
  };
  s.navigator = { userAgent: 'node-harness', platform: 'node', maxTouchPoints: 0, hardwareConcurrency: 8, language: 'en-US' };
  s.location = { search: '', href: 'http://localhost/', hash: '', protocol: 'http:', hostname: 'localhost' };
  s.devicePixelRatio = 1; s.innerWidth = 1280; s.innerHeight = 720;
  s.addEventListener = () => {}; s.removeEventListener = () => {};
  s.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  s.Blob = class {};
  s.URL = { createObjectURL: () => 'blob:', revokeObjectURL() {} };
  s.fetch = () => Promise.reject(new Error('harness: no network'));
  s.WebGLRenderingContext = function () {}; s.WebGL2RenderingContext = function () {};
  s.TextDecoder = TextDecoder; s.TextEncoder = TextEncoder;
  s.alert = () => {};
  s.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  vm.createContext(s);
  return s;
}
const MODULE_WARNINGS = [];
const MODULE_ERRORS = [];
function fmtArg(a) {
  /* Errors thrown inside the vm belong to the sandbox realm, so `instanceof
     Error` is false here and JSON.stringify flattens them to "{}".  Duck-type
     instead -- this message is the only thing the rig agent will see when
     their module fails to install. */
  if (a && typeof a === 'object' && typeof a.message === 'string' && ('stack' in a))
    return a.message + (a.stack ? '\n      ' + String(a.stack).split('\n').slice(1, 4).map(s => s.trim()).join('\n      ') : '');
  if (typeof a === 'object' && a) { try { return JSON.stringify(a).slice(0, 300); } catch (e) { return String(a); } }
  return String(a);
}

/* ===================================== NUKEM.html config extraction ===== */
/* Pull ECFG / ERIG straight out of the game file so the harness tracks the
   AI agent's edits (e.g. `octa.float` being removed under contract C1)
   rather than drifting against a hard-coded copy. */
function extractObjectLiteral(src, name) {
  const m = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*\\{').exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1, depth = 0, inStr = null, esc = false;
  const start = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/* ======================================================== small maths === */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = 180 / Math.PI;
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* ============================================================ booting === */
class Harness {
  constructor() {
    this.notes = [];
    this.fatal = null;
  }
  note(s) { this.notes.push(s); }

  boot() {
    const need = ['vendor/three.r149.min.js', 'nz-core.js', 'nz-enemies.js', 'NUKEM.html'];
    for (const f of need) if (!exists(f)) throw new Error(`missing required file: ${f} (looked in ${ROOT})`);

    const s = this.s = makeSandbox();
    const step = (label, fn) => {
      try { return fn(); }
      catch (err) { throw new Error(`while ${label}: ${err && err.message ? err.message : err}`); }
    };

    step('loading vendor/three.r149.min.js', () =>
      vm.runInContext(rd('vendor/three.r149.min.js'), s, { filename: 'three.r149.min.js' }));
    if (!s.THREE) throw new Error('vendor/three.r149.min.js did not define THREE');
    this.THREE = s.THREE;
    this.threeRevision = String(s.THREE.REVISION);

    step('loading nz-core.js', () => vm.runInContext(rd('nz-core.js'), s, { filename: 'nz-core.js' }));
    if (!s.NZ || !s.NZ.on) throw new Error('nz-core.js did not create the NZ hook bus (NZ.on missing)');

    /* game-scope globals that nz-enemies probes for by bare name */
    const html = rd('NUKEM.html');
    let ecfgSrc = extractObjectLiteral(html, 'ECFG');
    const erigSrc = extractObjectLiteral(html, 'ERIG');
    if (!ecfgSrc) {
      /* The AI agent owns NUKEM.html; if ECFG moves or is renamed the harness
         degrades to the brief's own table rather than going dark.  Loudly,
         because the numbers are then a round out of date. */
      ecfgSrc = JSON.stringify(ECFG_FALLBACK);
      this.note('WARNING: could not find `const ECFG = {...}` in NUKEM.html -- has it been renamed or restructured? ' +
        'Falling back to the table in CS2-ENEMY-BRIEF.md section 2. Scale-dependent metrics (weapon OAL, foot heights) ' +
        'are only as correct as that table; fix the harness or restore the ECFG literal.');
    }
    if (!erigSrc) this.note('ERIG literal not found in NUKEM.html; using a default {near:25,far:29,max:8}');
    step('installing game globals', () => {
      vm.runInContext('var ECFG = ' + ecfgSrc + ';', s, { filename: 'NUKEM.html:ECFG' });
      vm.runInContext('var ERIG = ' + (erigSrc || '{ geo:null, mats:{}, near:25, far:29, max:8 }') + ';', s, { filename: 'NUKEM.html:ERIG' });
      vm.runInContext(`
        var enemies = [];
        var player  = { x: 0, y: 0, z: 24, r: 1.4, hp: 100, vx: 0, vz: 0 };
        var state   = { playing: true, t: 0, over: false };
        var EYE     = 2.85;
        function moveSlide(x, z, dx, dz, r, floor){ return [x + dx, z + dz]; }
        function particle(){}
        function highestFloor(){ return 0; }
        function floorAt(){ return 0; }
        function sfx(){}
      `, s, { filename: 'harness:globals' });
    });
    this.ECFG = s.ECFG;

    step('loading nz-enemies.js', () => vm.runInContext(rd('nz-enemies.js'), s, { filename: 'nz-enemies.js' }));

    /* three.js scene + a renderer shaped enough for capability probes */
    const THREE = this.THREE;
    const scene = this.scene = new THREE.Scene();
    const camera = this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000);
    camera.rotation.order = 'YXZ';
    const renderer = {
      capabilities: { isWebGL2: true, getMaxAnisotropy: () => 16, maxTextures: 16, maxTextureSize: 8192, precision: 'highp' },
      domElement: s.document.createElement('canvas'),
      getPixelRatio: () => 1, setPixelRatio() {}, setSize() {}, getSize: (v) => v,
      outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1,
      shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap, autoUpdate: true, needsUpdate: false },
      info: { render: {}, memory: {}, programs: [] },
      render() {}, compile() {}, clear() {}, dispose() {}, setRenderTarget() {}, getRenderTarget() { return null; },
      getContext() { return null; }, extensions: { get: () => null, has: () => false },
      properties: { get: () => ({}) }, initTexture() {}, setClearColor() {},
    };
    s.NZ.ctx.renderer = renderer; s.NZ.ctx.scene = scene;
    s.NZ.ctx.camera = camera; s.NZ.ctx.THREE = THREE;

    const hadReady = s.NZ.has('ready');
    const t0 = Date.now();
    let readyErr = null;
    try { s.NZ.call('ready', s.NZ.ctx); } catch (e) { readyErr = e; }
    this.installMs = Date.now() - t0;
    this.installed = !!(s.NZ.flags && s.NZ.flags.enemies);
    if (readyErr) this.note('ready hook threw: ' + fmtArg(readyErr));
    if (!hadReady)
      throw new Error(
        'nz-enemies.js parsed but never registered a `ready` listener, so it never installed. ' +
        'The module bails out early -- most likely `var NZ = global.NZ; if (!NZ || !NZ.on) return;` ' +
        'took the early-return path, or an exception was thrown at top level before the NZ.on("ready", ...) call.');
    if (!this.installed) {
      throw new Error(
        'nz-enemies.js registered a `ready` listener but NZ.flags.enemies is still false, so it did not ' +
        'take over -- its own install() threw and it fell back to the stock rig. ' +
        (MODULE_ERRORS.length
          ? 'Module said: ' + MODULE_ERRORS.slice(0, 2).join(' | ')
          : 'No module error was captured; run with --verbose, or check that install() sets NZ.flags.enemies = true.'));
    }
    const missingHooks = ['createEnemyRig', 'animateEnemyRig'].filter(h => !s.NZ.has(h));
    if (missingHooks.length)
      throw new Error('nz-enemies installed (NZ.flags.enemies = true) but did not register these hooks: ' +
        missingHooks.join(', ') + '. NUKEM.html reaches the rig through NZ.first(<hook>, ...), so nothing will render.');

    this.NZ = s.NZ;
    this.c3 = {};
    for (const k of ['boneWorld', 'muzzleWorld', 'headWorld', 'hitboxes', 'poseAim', 'displayName'])
      if (s.NZ.enemies && s.NZ.enemies[k]) this.c3[k] = true;
    return this;
  }

  drainRaf() {
    const s = this.s;
    const q = s.__raf; s.__raf = [];
    for (const fn of q) { try { fn(s.__clockMs); } catch (e) { /* module panics internally */ } }
  }
}

/* ================================================== entity synthesis ==== */
/* Shaped to match NUKEM.html spawnEnemy() exactly.  Anything the rig reads
   must be present and of the right type or the measurement is measuring the
   harness, not the game. */
function makeEntity(H, kind, x, z) {
  const cfg = H.ECFG[kind];
  if (!cfg) throw new Error(`ECFG has no kind "${kind}"`);
  const THREE = H.THREE;
  const e = {
    kind, cfg,
    mesh: { visible: true, position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1), material: {} },
    mat: {},
    x, z, y: 0,
    hp: cfg.hp, state: 'idle', slot: -1, mir: false, face: 0,
    vx: 0, vz: 0, gait: 0.137, speedSm: 0, turnV: 0, lean: 0,
    animT: 0, atkT: 0, atkTotal: 0.42, coolT: 0,
    painT: 0, hitT: 0, hitLean: 0, recoilT: 0, muzzlePulse: 0,
    dead: false, deathT: 0, deathSide: 1, deathSettled: false,
    litT: 0, wander: 0.7, strafe: 1, strafeT: 0,
    stuckT: 0, shadowKick: 0, foleyT: 3.1,
    rig: null, rigActive: false, rigVariant: 0,
    fired: false, vang: 0, vmir: false, footStamp: 0,
  };
  e.cy = () => e.y + cfg.h * 0.52 + (cfg.float || 0);
  return e;
}

/* ====================================================== rig accessor ==== */
/* Everything below prefers the C3 public surface and degrades to scene-graph
   traversal by bone name.  Bone-name aliases are matched loosely so a rename
   inside nz-enemies.js does not silently zero out a metric. */
const ROLE_PATTERNS = {
  hips:    [/^hips?$/i, /^pelvis$/i, /^root_?bone$/i, /hip/i],
  spine:   [/^spine$/i, /^spine_?0?1$/i, /spine(?!2)/i],
  spine2:  [/^spine2$/i, /^spine_?0?2$/i],
  chest:   [/^chest$/i, /^upperchest$/i, /^torso$/i, /^spine_?0?3$/i],
  neck:    [/^neck$/i],
  head:    [/^head$/i],
  weapon:  [/^weapon$/i, /^gun$/i, /^wpn$/i, /^rifle$/i, /^weapon_?bone$/i, /weapon/i, /\bgun\b/i],
};
const SIDED = {
  clav:  [/^clav([LR])$/i, /^clavicle_?([LR])$/i, /^(?:left|right)?shoulder$/i],
  arm:   [/^arm([LR])$/i, /^upperarm_?([LR])$/i, /^shoulder([LR])$/i, /^(?:up)?arm_?([LR])$/i],
  fore:  [/^fore([LR])$/i, /^forearm_?([LR])$/i, /^elbow([LR])$/i, /^lowerarm_?([LR])$/i],
  hand:  [/^hand([LR])$/i, /^wrist_?([LR])$/i, /^hand_?([LR])$/i],
  fing:  [/^fing([LR])$/i, /^finger_?([LR])$/i, /^palm_?([LR])$/i, /^hand_?end_?([LR])$/i],
  thigh: [/^thigh([LR])$/i, /^upperleg_?([LR])$/i, /^leg([LR])$/i, /^hip_?([LR])$/i],
  shin:  [/^shin([LR])$/i, /^calf_?([LR])$/i, /^knee([LR])$/i, /^lowerleg_?([LR])$/i],
  foot:  [/^foot([LR])$/i, /^ankle_?([LR])$/i, /^foot_?([LR])$/i],
  toe:   [/^toe([LR])$/i, /^ball_?([LR])$/i, /^toe_?base_?([LR])$/i],
};

class Rig {
  /* Wraps one live entity: resolves bones, builds geometric probes from the
     bind pose, and samples world state each frame. */
  constructor(H, e) {
    this.H = H; this.e = e;
    this.THREE = H.THREE;
    this.problems = [];
    this.bones = null;
    this.byName = new Map();
    this.role = {};
  }

  /* -- locate the skinned character in the scene graph ------------------- */
  discover() {
    const THREE = this.THREE, e = this.e;
    const rig = e.rig;
    if (!rig || !rig.root) { this.problems.push('entity has no rig.root'); return false; }
    let skinned = null;
    const boneSet = [];
    rig.root.traverse(o => {
      if (o.isSkinnedMesh && !skinned) skinned = o;
      if (o.isBone) boneSet.push(o);
    });
    if (!skinned) {
      /* the rig may be sitting on the far/instanced tier: no skinned mesh at
         all.  That is a harness setup problem, not a rig defect -- say so. */
      this.problems.push('no SkinnedMesh under rig.root (LOD tier never reached 0/1)');
    }
    this.skinned = skinned;
    this.skeleton = skinned && skinned.skeleton ? skinned.skeleton : null;
    this.bones = this.skeleton ? this.skeleton.bones : boneSet;
    if (!this.bones || !this.bones.length) { this.problems.push('no bones found under rig.root'); return false; }
    for (const b of this.bones) if (b.name) this.byName.set(b.name, b);

    /* resolve roles */
    const names = [...this.byName.keys()];
    const findOne = pats => {
      for (const p of pats) { for (const n of names) if (p.test(n)) return this.byName.get(n); }
      return null;
    };
    for (const [role, pats] of Object.entries(ROLE_PATTERNS)) this.role[role] = findOne(pats);
    for (const [base, pats] of Object.entries(SIDED)) {
      for (const side of ['L', 'R']) {
        let hit = null;
        for (const p of pats) {
          for (const n of names) {
            const m = p.exec(n);
            if (m && (m[1] ? m[1].toUpperCase() === side : new RegExp(side === 'L' ? 'left|_l\\b|^l' : 'right|_r\\b|^r', 'i').test(n))) { hit = this.byName.get(n); break; }
          }
          if (hit) break;
        }
        this.role[base + side] = hit;
      }
    }
    const missing = ['hips', 'chest', 'head', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'handL', 'handR', 'foreL', 'foreR']
      .filter(r => !this.role[r]);
    if (missing.length) this.problems.push('unresolved bone roles: ' + missing.join(', ') + ' (known bones: ' + names.slice(0, 40).join(',') + ')');
    return true;
  }

  /* -- geometry probes derived from the bind pose ------------------------ */
  /* Contact points, torso slices and weapon extents all come from the rig's
     OWN mesh, so no anthropometric constant is hard-coded into the harness. */
  buildProbes() {
    const THREE = this.THREE;
    this.probes = { footL: [], footR: [] };
    this.torso = [];
    this.weapon = null;
    this.gripPoints = null;
    this.gripSource = 'none';
    if (!this.skinned || !this.skeleton) { this.probeNote = 'no SkinnedMesh: contact probes fall back to foot/toe bone origins'; this.fallbackProbes(); return; }

    const geo = this.skinned.geometry;
    const pos = geo.getAttribute('position');
    const si = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
    if (!pos || !si || !sw) { this.probeNote = 'skinned mesh lacks skinIndex/skinWeight; falling back to bone origins'; this.fallbackProbes(); return; }

    const bones = this.skeleton.bones;
    const boneIndex = new Map();
    bones.forEach((b, i) => boneIndex.set(b, i));
    const idxOf = role => (this.role[role] && boneIndex.has(this.role[role])) ? boneIndex.get(this.role[role]) : -1;

    /* dominant bone per vertex.  Read the raw arrays rather than
       getComponent(): r149's BufferAttribute does not have it, and the
       attribute may be interleaved. */
    const n = pos.count;
    const comp = (attr, v, k) => {
      if (typeof attr.getComponent === 'function') return attr.getComponent(v, k);
      const stride = attr.data ? attr.data.stride : attr.itemSize;
      const base = attr.data ? (attr.offset || 0) : 0;
      const arr = attr.data ? attr.data.array : attr.array;
      return arr[v * stride + base + k];
    };
    const dom = new Int32Array(n);
    for (let v = 0; v < n; v++) {
      let best = -1, bw = -1;
      for (let k = 0; k < Math.min(4, si.itemSize || 4); k++) {
        const w = comp(sw, v, k);
        if (w > bw) { bw = w; best = comp(si, v, k); }
      }
      dom[v] = best;
    }
    this.dom = dom;

    /* Bind-space -> bone-local: boneInverses maps model space to bone space.
       In the bind pose the mesh vertices ARE model space, so
       local = boneInverse * vertex.                                       */
    const inv = this.skeleton.boneInverses;
    const tmp = new THREE.Vector3();
    const localOf = (v, bi) => {
      tmp.fromBufferAttribute(pos, v);
      return tmp.clone().applyMatrix4(inv[bi]);
    };

    /* ---- foot contact probes ---- */
    for (const side of ['L', 'R']) {
      const key = 'foot' + side;
      const fi = idxOf('foot' + side), ti = idxOf('toe' + side);
      const cand = [];
      for (let v = 0; v < n; v++) {
        const d = dom[v];
        if (d !== fi && d !== ti) continue;
        tmp.fromBufferAttribute(pos, v);
        cand.push({ v, y: tmp.y, bone: d });
      }
      if (cand.length < 8) { this.probes[key] = this.originProbes(side); continue; }
      /* keep the sole band: the lowest 18% of the foot cloud */
      cand.sort((a, b) => a.y - b.y);
      const cut = cand[Math.min(cand.length - 1, Math.floor(cand.length * 0.18))].y;
      const sole = cand.filter(c => c.y <= cut + 1e-6);
      /* cluster into up to 12 probes along the foot so heel / ball / toe are
         each represented: an instantaneous-centre test needs the real spread */
      const zs = sole.map(c => { tmp.fromBufferAttribute(pos, c.v); return tmp.z; });
      const zmin = Math.min(...zs), zmax = Math.max(...zs), span = Math.max(1e-4, zmax - zmin);
      const NB = 10, buckets = Array.from({ length: NB }, () => []);
      sole.forEach((c, i) => {
        const b = clamp(Math.floor((zs[i] - zmin) / span * NB), 0, NB - 1);
        buckets[b].push(c);
      });
      const out = [];
      for (const bkt of buckets) {
        if (!bkt.length) continue;
        /* the lowest vertex in the bucket, expressed in its own bone's space */
        bkt.sort((a, b) => a.y - b.y);
        const c = bkt[0];
        out.push({ bone: bones[c.bone], boneIndex: c.bone, local: localOf(c.v, c.bone) });
      }
      this.probes[key] = out.length ? out : this.originProbes(side);
    }

    /* ---- torso slices (star hull, per dominant bone) ----
       Capped at the shoulder joint height: a deltoid cap is not "the torso"
       for the purpose of "elbows never clip the torso", and including it
       manufactures false positives whenever an arm is raised. */
    let shoulderBindY = Infinity;
    for (const r of ['armL', 'armR', 'clavL', 'clavR']) {
      const bi = idxOf(r);
      if (bi < 0) continue;
      const bw = new THREE.Matrix4().copy(inv[bi]).invert();
      shoulderBindY = Math.min(shoulderBindY, bw.elements[13]);
    }
    this.shoulderBindY = shoulderBindY;
    const torsoRoles = ['hips', 'spine', 'spine2', 'chest'];
    for (const role of torsoRoles) {
      const bi = idxOf(role);
      if (bi < 0) continue;
      const boneBindY = new THREE.Matrix4().copy(inv[bi]).invert().elements[13];
      const pts = [];
      for (let v = 0; v < n; v++) if (dom[v] === bi) pts.push(localOf(v, bi));
      if (pts.length < 12) continue;
      /* split by local Y into 3 slices, each an axis-aligned ellipse */
      const ys = pts.map(p => p.y).sort((a, b) => a - b);
      const y0 = percentile(ys, 0.02), y1 = percentile(ys, 0.98);
      const NS = 4;
      for (let sIdx = 0; sIdx < NS; sIdx++) {
        const lo = y0 + (y1 - y0) * (sIdx / NS), hi = y0 + (y1 - y0) * ((sIdx + 1) / NS);
        /* drop anything at or above the shoulder joints */
        if (Number.isFinite(shoulderBindY) && boneBindY + lo >= shoulderBindY - 1e-6) continue;
        const band = pts.filter(p => p.y >= lo - 1e-6 && p.y <= hi + 1e-6);
        if (band.length < 16) continue;
        /* Centre on the BONE AXIS, not the vertex centroid.  A torso cross
           section is a ring around the spine; centring on the centroid of a
           forward-projecting cluster (chest rig, sling, pouch stack) would
           describe that cluster instead and then read anything near its
           middle as "inside the body". */
        const cx = 0, cz = 0;
        /* Star-shaped hull: SECT angular sectors, each taking the MEDIAN
           radius of its points.  A bounding ellipse gets dragged outward by
           a sling loop, a pouch, or weapon vertices that bled onto the chest
           weights -- the median of a sector does not.  The result tracks the
           real torso silhouette and is conservative about calling a clip. */
        const SECT = 12;
        const buckets = Array.from({ length: SECT }, () => []);
        for (const p of band) {
          const dx = p.x - cx, dz = p.z - cz;
          const r = Math.hypot(dx, dz);
          if (r < 1e-6) continue;
          const a = Math.atan2(dz, dx);
          const b = clamp(Math.floor((a + Math.PI) / (2 * Math.PI) * SECT), 0, SECT - 1);
          buckets[b].push(r);
        }
        const rad = new Float64Array(SECT);
        let filled = 0;
        for (let b = 0; b < SECT; b++) {
          if (!buckets[b].length) { rad[b] = NaN; continue; }
          buckets[b].sort((a, c) => a - c);
          rad[b] = percentile(buckets[b], 0.5);
          filled++;
        }
        if (filled < SECT * 0.6) continue;
        /* fill gaps from neighbours so the hull is closed */
        for (let b = 0; b < SECT; b++) {
          if (Number.isFinite(rad[b])) continue;
          let l = b, r = b;
          for (let k = 1; k <= SECT; k++) { l = (b - k + SECT) % SECT; if (Number.isFinite(rad[l])) break; }
          for (let k = 1; k <= SECT; k++) { r = (b + k) % SECT; if (Number.isFinite(rad[r])) break; }
          rad[b] = Math.min(rad[l], rad[r]);
        }
        if (!rad.every(Number.isFinite)) continue;
        this.torso.push({ bone: bones[bi], role, lo, hi, cx, cz, rad, sect: SECT });
      }
    }

    /* ---- weapon cloud ---- */
    const wi = idxOf('weapon');
    if (wi >= 0) {
      const pts = [];
      for (let v = 0; v < n; v++) if (dom[v] === wi) pts.push(localOf(v, wi));
      if (pts.length >= 24) {
        this.weapon = { bone: bones[wi], boneIndex: wi, pts, count: pts.length };
        this.measureWeapon();
      } else {
        this.weaponNote = `only ${pts.length} vertices are skinned to the weapon bone (need >=24); the weapon may be a separate mesh or merged into the body`;
      }
    } else {
      this.weaponNote = 'no bone matched the "weapon" role';
    }
    /* named grip anchors beat inference: look for them anywhere under the rig */
    this.findGripAnchors();
  }

  originProbes(side) {
    const out = [];
    const f = this.role['foot' + side], t = this.role['toe' + side];
    const V = this.THREE.Vector3;
    if (f) out.push({ bone: f, local: new V(0, 0, 0) });
    if (t) out.push({ bone: t, local: new V(0, 0, 0) });
    return out;
  }
  fallbackProbes() {
    this.probes = { footL: this.originProbes('L'), footR: this.originProbes('R') };
    this.torso = []; this.weapon = null;
  }

  measureWeapon() {
    const w = this.weapon;
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of w.pts) {
      min[0] = Math.min(min[0], p.x); max[0] = Math.max(max[0], p.x);
      min[1] = Math.min(min[1], p.y); max[1] = Math.max(max[1], p.y);
      min[2] = Math.min(min[2], p.z); max[2] = Math.max(max[2], p.z);
    }
    const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let axis = 0;
    if (ext[1] > ext[axis]) axis = 1;
    if (ext[2] > ext[axis]) axis = 2;
    w.bbox = { min, max, ext };
    w.axis = axis;
    w.oalLocal = ext[axis];
    w.axisName = 'xyz'[axis];
    /* long-axis parameter t in [0,1] per point, used for grip inference */
    const a0 = min[axis], span = Math.max(1e-6, ext[axis]);
    w.t = w.pts.map(p => ([p.x, p.y, p.z][axis] - a0) / span);
    /* which end is the muzzle?  The muzzle end is the thin end: compare the
       mean cross-section radius of the first and last 12% of the length. */
    const other = [0, 1, 2].filter(i => i !== axis);
    const rad = (p) => Math.hypot(p[['x', 'y', 'z'][other[0]]], p[['x', 'y', 'z'][other[1]]]);
    let rFront = 0, nF = 0, rBack = 0, nB = 0;
    w.pts.forEach((p, i) => {
      if (w.t[i] > 0.88) { rFront += rad(p); nF++; }
      else if (w.t[i] < 0.12) { rBack += rad(p); nB++; }
    });
    w.thinEndIsHigh = (nF && nB) ? (rFront / nF) < (rBack / nB) : true;
  }

  findGripAnchors() {
    const want = {
      support: [/grip_?support/i, /support_?grip/i, /handguard/i, /forend/i, /foregrip/i, /fore_?grip/i, /grip_?fore/i, /grip_?l\b/i, /^gripL$/i],
      trigger: [/grip_?trigger/i, /trigger_?grip/i, /pistol_?grip/i, /grip_?pistol/i, /grip_?r\b/i, /^gripR$/i],
    };
    const found = { support: null, trigger: null };
    const root = this.e.rig && this.e.rig.root;
    if (root) {
      root.traverse(o => {
        if (!o.name) return;
        for (const k of ['support', 'trigger'])
          if (!found[k] && want[k].some(p => p.test(o.name))) found[k] = o;
      });
    }
    if (found.support && found.trigger) { this.gripPoints = found; this.gripSource = 'named-anchors'; return; }
    /* inference from the weapon cloud */
    if (!this.weapon) { this.gripSource = 'none'; return; }
    const w = this.weapon, axis = w.axis, an = ['x', 'y', 'z'][axis];
    const hi = w.thinEndIsHigh;                /* muzzle at t=1 if true      */
    const tFwd = v => (hi ? v : 1 - v);        /* 0 = butt, 1 = muzzle       */
    const pick = (loT, hiT, belowBore) => {
      const sel = [];
      /* bore axis = the long axis; "below" = the local direction with the
         largest downward mass in the rear third (the grip + magazine) */
      w.pts.forEach((p, i) => {
        const t = tFwd(w.t[i]);
        if (t < loT || t > hiT) return;
        sel.push(p);
      });
      if (!sel.length) return null;
      let filtered = sel;
      if (belowBore) {
        const ys = sel.map(p => p.y).sort((a, b) => a - b);
        const med = percentile(ys, 0.5);
        const low = sel.filter(p => p.y < med);
        if (low.length >= 4) filtered = low;
      }
      const c = new this.THREE.Vector3();
      for (const p of filtered) c.add(p);
      c.multiplyScalar(1 / filtered.length);
      return c;
    };
    const support = pick(0.48, 0.72, false);
    const trigger = pick(0.16, 0.36, true);
    if (support && trigger) {
      this.gripPoints = {
        support: { __local: support, __bone: w.bone },
        trigger: { __local: trigger, __bone: w.bone },
      };
      this.gripSource = 'inferred-from-weapon-geometry';
    } else this.gripSource = 'none';
  }

  gripWorld(which, out) {
    const g = this.gripPoints && this.gripPoints[which];
    if (!g) return null;
    if (g.__local) { out.copy(g.__local).applyMatrix4(g.__bone.matrixWorld); return out; }
    return g.getWorldPosition(out);
  }

  /* -- per-frame world sampling ----------------------------------------- */
  boneWorld(role, out) {
    /* C3 first: NZ.enemies.boneWorld(e, name) -> Vector3 | null */
    const b = this.role[role];
    if (!b) return null;
    if (this.H.c3.boneWorld) {
      try {
        const v = this.H.NZ.enemies.boneWorld(this.e, b.name);
        if (v && Number.isFinite(v.x)) { out.set(v.x, v.y, v.z); return out; }
      } catch (err) { /* fall through to traversal */ }
    }
    const m = b.matrixWorld.elements;
    out.set(m[12], m[13], m[14]);
    return out;
  }
}

/* ================================================== scenario driver ===== */
/* Idle -> walk 10 units -> strafe -> turn 180 -> sprint -> stop ->
   aim at a moving target -> fire -> die.  Segment boundaries are recorded
   so a failure can be attributed to a phase.                              */
function buildScenario(cfg, frames) {
  const HZ = 60, dt = 1 / HZ;
  const walkSpd = Math.max(1.6, cfg.spd * 0.36);
  const sprintSpd = Math.max(2.4, cfg.spd * 1.0);
  const seg = [];
  const push = (name, sec, fn) => seg.push({ name, n: Math.round(sec * HZ), fn });
  push('idle',      1.5, () => ({ v: 0, dir: 0, faceTo: 0, state: 'idle' }));
  push('walk',      4.0, () => ({ v: walkSpd, dir: 0, faceTo: 0, state: 'chase' }));
  push('strafe',    2.0, () => ({ v: walkSpd * 0.85, dir: Math.PI / 2, faceTo: 0, state: 'chase' }));
  push('turn180',   1.5, (t) => ({ v: 0, dir: 0, faceTo: Math.PI * Math.min(1, t / 0.75), state: 'chase' }));
  push('sprint',    2.5, () => ({ v: sprintSpd, dir: 0, faceTo: Math.PI, state: 'chase' }));
  push('stop',      1.0, (t) => ({ v: sprintSpd * Math.max(0, 1 - t / 0.5), dir: 0, faceTo: Math.PI, state: 'chase' }));
  push('aim',       2.0, (t) => ({ v: 0, dir: 0, faceTo: Math.PI + Math.sin(t * 2.2) * 0.7, state: 'chase', aimTarget: true }));
  push('fire',      1.0, () => ({ v: 0, dir: 0, faceTo: Math.PI, state: 'attack', aimTarget: true, firing: true }));
  push('die',       1.5, () => ({ v: 0, dir: 0, faceTo: Math.PI, state: 'dead', dying: true }));
  let total = seg.reduce((a, s) => a + s.n, 0);
  if (frames && frames > total) seg[1].n += frames - total;      /* stretch the walk */
  total = seg.reduce((a, s) => a + s.n, 0);
  return { seg, total, dt, HZ };
}

function runScenario(H, kind, opt) {
  const THREE = H.THREE, NZ = H.NZ, s = H.s;
  const cfg = H.ECFG[kind];
  const out = { kind, ok: false, notes: [], frames: 0 };
  const e = makeEntity(H, kind, 0, 0);
  s.enemies.length = 0; s.enemies.push(e);

  /* The LOD pass promotes whatever is near the camera, so the camera is
     chained to the actor for the whole run and the module's own beat picks
     tier 0.  A tier swap re-uses a pooled character and legitimately jumps
     the pose; that is a separate concern from locomotion quality, so the
     harness holds the tier fixed and records any switch as a note. */
  H.camera.position.set(0, 5, -10);
  H.camera.rotation.set(0, 0, 0);
  const followCamera = () => {
    H.camera.position.set(e.x, e.y + 5, e.z - 10);
    H.camera.rotation.set(0, 0, 0);
    H.camera.updateMatrixWorld(true);
  };
  followCamera();

  const rigObj = NZ.first('createEnemyRig', e);
  if (!rigObj) { out.error = 'createEnemyRig returned nothing for kind "' + kind + '" (module may have panicked)'; return out; }
  e.rig = rigObj; e.rigActive = true;
  if (rigObj.root) rigObj.root.visible = true;

  const sc = buildScenario(cfg, opt.frames);
  const R = new Rig(H, e);

  /* --- sample buffers --- */
  const N = sc.total;
  const rec = {
    seg: new Array(N),
    bodyXZ: new Float64Array(N * 2),
    speed: new Float64Array(N),
    foot: { L: null, R: null },      /* per-probe world XZ+Y, filled after discovery */
    knee: { L: new Float64Array(N), R: new Float64Array(N) },
    kneeSign: { L: new Float64Array(N), R: new Float64Array(N) },
    elbow: { L: new Float64Array(N), R: new Float64Array(N) },
    elbowIn: { L: new Uint8Array(N), R: new Uint8Array(N) },
    handGrip: { support: new Float64Array(N).fill(NaN), trigger: new Float64Array(N).fill(NaN) },
    elbowDepth: { L: new Float64Array(N), R: new Float64Array(N) },
    elbowWhere: { L: new Array(N), R: new Array(N) },
    wpnScale: [],
    nonFinite: [], nonFiniteCount: 0,
    groundY: new Float64Array(N),
    tier: new Int8Array(N).fill(-1),
    tierSwitch: [],
  };
  const V = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();

  let discovered = false, probeAlloc = false;
  let f = 0, tAbs = 0;
  const player = s.player;

  for (const segment of sc.seg) {
    for (let i = 0; i < segment.n; i++, f++) {
      const tSeg = i / sc.HZ;
      const st = segment.fn(tSeg);
      const dt = sc.dt;
      tAbs += dt;
      s.__clockMs = tAbs * 1000;

      /* ---- drive the entity the way NUKEM.html's AI + presentEnemy do ---- */
      const prevFace = e.face;
      if (st.faceTo !== undefined) {
        const want = st.faceTo;
        const d = Math.atan2(Math.sin(want - e.face), Math.cos(want - e.face));
        const rate = (cfg.turn || 6) * dt;
        e.face += clamp(d, -rate, rate);
      }
      e.turnV = Math.atan2(Math.sin(e.face - prevFace), Math.cos(e.face - prevFace)) / dt;
      const heading = e.face + (st.dir || 0);
      const vx = Math.sin(heading) * st.v, vz = Math.cos(heading) * st.v;
      e.vx = vx; e.vz = vz;
      if (!st.dying) { e.x += vx * dt; e.z += vz * dt; }
      e.y = 0;                                   /* flat floor at y = 0 */
      e.state = st.dying ? 'dead' : st.state;

      /* a moving target so the aim layer actually has to work */
      if (st.aimTarget) {
        player.x = e.x + Math.sin(tAbs * 1.7) * 12;
        player.z = e.z + 20 + Math.cos(tAbs * 1.1) * 5;
        player.y = Math.sin(tAbs * 0.9) * 1.2;
      } else { player.x = 0; player.z = 26; player.y = 0; }

      const speed = Math.hypot(vx, vz);
      const speed01 = clamp(speed / Math.max(1, cfg.spd), 0, 1);
      e.speedSm += (speed01 - e.speedSm) * Math.min(1, dt * 9);
      e.hitT = Math.max(0, e.hitT - dt);
      e.recoilT = Math.max(0, e.recoilT - dt);
      e.muzzlePulse = Math.max(0, e.muzzlePulse - dt * 7.5);
      e.shadowKick = Math.max(0, e.shadowKick - dt * 5.5);
      const leanWant = clamp(-e.turnV * 0.018 + e.strafe * e.speedSm * 0.012, -0.18, 0.18);
      e.lean += (leanWant - e.lean) * Math.min(1, dt * 9);
      if (st.firing) { e.muzzlePulse = 1; e.recoilT = 0.15; e.fired = false; }

      /* let the module run its own rAF beat (LOD tier selection) */
      followCamera();
      H.drainRaf();

      /* ---- optional C3 aim request ---- */
      if (st.aimTarget && H.c3.poseAim) {
        try {
          const dx = player.x - e.x, dz = player.z - e.z;
          NZ.enemies.poseAim(e, Math.atan2(dx, dz), Math.atan2((player.y + 2.85) - (e.y + cfg.h * 0.86), Math.hypot(dx, dz)));
        } catch (err) { /* optional */ }
      }

      /* ---- the call under test ---- */
      if (st.dying) {
        if (!e.dead) { e.dead = true; e.deathT = 0; NZ.call('enemyKilled', e, 40, { x: 0, y: 0, z: 1 }, { x: e.x, y: e.y + 3, z: e.z }); }
        e.deathT += dt;
        NZ.first('animateEnemyRigDeath', e, e.deathT, clamp(e.deathT / 0.6, 0, 1));
      } else {
        NZ.first('animateEnemyRig', e, speed, tAbs);
      }
      if (rigObj.root) rigObj.root.updateMatrixWorld(true);

      /* ---- discovery on the first frame that has a skinned character ---- */
      if (!discovered) {
        R.discover();
        if (R.skinned) {
          discovered = true;
          R.buildProbes();
          out.boneNames = [...R.byName.keys()];
          out.probeNote = R.probeNote || null;
          out.weaponNote = R.weaponNote || null;
          out.gripSource = R.gripSource;
          rec.foot.L = R.probes.footL.map(() => new Float64Array(N * 3));
          rec.foot.R = R.probes.footR.map(() => new Float64Array(N * 3));
          probeAlloc = true;
        }
      }

      /* ---- sample ---- */
      rec.seg[f] = segment.name;
      rec.bodyXZ[f * 2] = e.x; rec.bodyXZ[f * 2 + 1] = e.z;
      rec.speed[f] = speed;
      rec.groundY[f] = e.y;
      const tier = (e._nz && e._nz.tier !== undefined) ? e._nz.tier : -1;
      rec.tier[f] = tier;
      if (f > 0 && rec.tier[f - 1] !== tier) rec.tierSwitch.push({ frame: f, from: rec.tier[f - 1], to: tier });

      if (discovered) {
        /* non-finite sweep over every bone matrix.  Every occurrence is
           counted; only the first few are described, so the reported value
           is a true total and not a display cap. */
        for (const b of R.bones) {
          const m = b.matrixWorld.elements;
          for (let k = 0; k < 16; k++) {
            if (!Number.isFinite(m[k])) {
              rec.nonFiniteCount++;
              if (rec.nonFinite.length < 8) rec.nonFinite.push({ frame: f, seg: segment.name, bone: b.name || '(unnamed)', el: k });
              break;
            }
          }
        }
        /* foot contact probes */
        if (probeAlloc) {
          for (const side of ['L', 'R']) {
            const ps = R.probes['foot' + side], buf = rec.foot[side];
            for (let pi = 0; pi < ps.length; pi++) {
              V.copy(ps[pi].local).applyMatrix4(ps[pi].bone.matrixWorld);
              const o = f * 3;
              buf[pi][o] = V.x; buf[pi][o + 1] = V.y; buf[pi][o + 2] = V.z;
            }
          }
        }
        /* knee + elbow signed flexion, absolute frame from facing */
        const fwd = V3.set(Math.sin(e.face), 0, Math.cos(e.face));
        const lat = new THREE.Vector3(0, 1, 0).cross(fwd).normalize();
        for (const side of ['L', 'R']) {
          if (R.boneWorld('thigh' + side, A) && R.boneWorld('shin' + side, B) && R.boneWorld('foot' + side, C)) {
            const d1 = B.clone().sub(A).normalize(), d2 = C.clone().sub(B).normalize();
            const dot = clamp(d1.dot(d2), -1, 1);
            const ang = Math.acos(dot) * DEG;
            const sgn = d1.clone().cross(d2).dot(lat);
            rec.knee[side][f] = ang;
            rec.kneeSign[side][f] = sgn;
          } else { rec.knee[side][f] = NaN; rec.kneeSign[side][f] = NaN; }
          if (R.boneWorld('arm' + side, A) && R.boneWorld('fore' + side, B) && R.boneWorld('hand' + side, C)) {
            const d1 = B.clone().sub(A).normalize(), d2 = C.clone().sub(B).normalize();
            rec.elbow[side][f] = Math.acos(clamp(d1.dot(d2), -1, 1)) * DEG;
          } else rec.elbow[side][f] = NaN;
          /* elbow inside the torso?  Depth as well as the boolean: a 1 mm
             graze and a forearm buried in the ribcage are not the same
             defect and the rig agent needs to tell them apart. */
          if (R.torso.length && R.boneWorld('fore' + side, A)) {
            const d = torsoDepth(R, A, THREE);
            rec.elbowDepth[side][f] = d;
            rec.elbowIn[side][f] = d > 0 ? 1 : 0;
            if (d > 0) rec.elbowWhere[side][f] = R._tdSlice ? R._tdSlice.role : '?';
            if (OPT.debug && d > (rec._dbgDeep || 0) && segment.name !== 'die') {
              rec._dbgDeep = d;
              rec._dbgMsg = `[debug ${kind}] deepest elbow-in-torso so far: f${f} ${side} depth ${(d / 0.0035).toFixed(1)}mm slice=${R._tdSlice.role}[${R._tdSlice.lo.toFixed(2)}..${R._tdSlice.hi.toFixed(2)}] local=(${R._tdInfo.lx.toFixed(3)},${R._tdInfo.ly.toFixed(3)},${R._tdInfo.lz.toFixed(3)}) r=${R._tdInfo.r.toFixed(3)} surf=${R._tdInfo.surf.toFixed(3)}`;
            }
          }
        }
        /* Weapon world scale along its own long axis.  The rendered length
           is the bind-space extent times THIS, not times the root scale:
           a rig that scales the weapon bone at runtime would otherwise slip
           past the OAL check entirely. */
        if (R.weapon && segment.name !== 'die') {
          const m = R.weapon.bone.matrixWorld.elements, a = R.weapon.axis;
          rec.wpnScale.push(Math.hypot(m[a * 4], m[a * 4 + 1], m[a * 4 + 2]));
        }
        /* grip distances */
        if (R.gripPoints) {
          const hL = R.role.fingL || R.role.handL, hR = R.role.fingR || R.role.handR;
          if (hL && R.gripWorld('support', V)) {
            const m = hL.matrixWorld.elements;
            rec.handGrip.support[f] = Math.hypot(m[12] - V.x, m[13] - V.y, m[14] - V.z);
          }
          if (hR && R.gripWorld('trigger', V2)) {
            const m = hR.matrixWorld.elements;
            rec.handGrip.trigger[f] = Math.hypot(m[12] - V2.x, m[13] - V2.y, m[14] - V2.z);
          }
        }
      }
    }
  }
  /* A module that panicked mid-run stops updating bones and starts feeding
     the far/instanced path, which would read as a perfectly still, perfectly
     planted character.  That is the single most dangerous way for a harness
     to lie, so it is checked explicitly and poisons the whole run. */
  try {
    const st = NZ.enemies && typeof NZ.enemies.stats === 'function' ? NZ.enemies.stats() : null;
    if (st && st.panic) out.panic = st.panic;
  } catch (err) { /* stats() is optional */ }
  const farFrames = Array.from(rec.tier).filter(t => t === 2).length;
  if (farFrames > 0) out.farFrames = farFrames;

  out.frames = N;
  out.rig = R;
  out.rec = rec;
  out.scenario = sc;
  out.entity = e;
  out.discovered = discovered;
  if (rec.tierSwitch.length)
    out.tierNote = `LOD tier changed ${rec.tierSwitch.length}x during the run (${rec.tierSwitch.slice(0, 4).map(t => `f${t.frame}:${t.from}->${t.to}`).join(' ')}); a pooled character swap jumps the pose, so locomotion numbers around those frames are noisy`;
  if (OPT.debug && R.weapon) {
    const w = R.weapon;
    console.error(`[debug ${kind}] weapon bone "${w.bone.name}" verts=${w.count} bbox ext=[${w.bbox.ext.map(v => v.toFixed(3)).join(', ')}] long axis=${w.axisName} local OAL=${w.oalLocal.toFixed(3)} unit=${((rigObj.unit || 1) * ((e._nz || {}).scale || 1)).toFixed(4)} muzzleAtHighEnd=${w.thinEndIsHigh}`);
    if (R.gripPoints) {
      const g = R.gripPoints;
      const l = k => g[k].__local ? `(${g[k].__local.x.toFixed(3)}, ${g[k].__local.y.toFixed(3)}, ${g[k].__local.z.toFixed(3)})` : 'named:' + g[k].name;
      console.error(`[debug ${kind}] grip source=${R.gripSource} support=${l('support')} trigger=${l('trigger')}`);
    }
    console.error(`[debug ${kind}] torso slices=${R.torso.length} ` + R.torso.map(s => {
      const rs = Array.from(s.rad);
      return `${s.role}[y ${s.lo.toFixed(2)}..${s.hi.toFixed(2)} r ${Math.min(...rs).toFixed(3)}-${Math.max(...rs).toFixed(3)}]`;
    }).join(' '));
    console.error(`[debug ${kind}] probes L=${R.probes.footL.length} R=${R.probes.footR.length} bones=${R.bones.length} tierSwitches=${rec.tierSwitch.length} shoulderBindY=${R.shoulderBindY}`);
    if (rec._dbgMsg) console.error(rec._dbgMsg);
  }
  if (!discovered) out.error = 'never reached a skinned LOD tier: ' + (R.problems.join('; ') || 'unknown');
  out.problems = R.problems;
  /* world scale of the rig, needed to convert local weapon extents */
  const st = e._nz || {};
  out.rigUnit = (rigObj.unit || 1) * (st.scale || 1);
  return out;
}

/* Penetration depth of a world point into the torso hull, in world units.
   0 = outside every slice.  Depth is measured radially inside the slice's
   ellipse and converted back through the bone's world scale. */
function torsoDepth(R, p, THREE) {
  const local = R._tdV || (R._tdV = new THREE.Vector3());
  const inv = R._tdM || (R._tdM = new THREE.Matrix4());
  let deepest = 0;
  for (const sl of R.torso) {
    inv.copy(sl.bone.matrixWorld).invert();
    local.copy(p).applyMatrix4(inv);
    if (local.y < sl.lo || local.y > sl.hi) continue;
    const dx = local.x - sl.cx, dz = local.z - sl.cz;
    const r = Math.hypot(dx, dz);
    const a = Math.atan2(dz, dx);
    /* linear interpolation between the two nearest sector radii */
    const u = (a + Math.PI) / (2 * Math.PI) * sl.sect - 0.5;
    const i0 = ((Math.floor(u) % sl.sect) + sl.sect) % sl.sect;
    const i1 = (i0 + 1) % sl.sect;
    const t = u - Math.floor(u);
    const surf = sl.rad[i0] * (1 - t) + sl.rad[i1] * t;
    if (r >= surf) continue;
    const s = sl.bone.matrixWorld.elements;
    const worldScale = Math.hypot(s[0], s[1], s[2]) || 1;
    const d = (surf - r) * worldScale;
    if (d > deepest) { deepest = d; R._tdSlice = sl; R._tdInfo = { r, surf, ly: local.y, lx: local.x, lz: local.z }; }
  }
  return deepest;
}

/* ====================================================== measurement ===== */
function analyse(H, run) {
  const M = [];
  const kind = run.kind;
  const add = (id, label, status, value, threshold, extra) =>
    M.push(Object.assign({ id, label, status, value, threshold, kind }, extra || {}));
  const skip = (id, label, reason) => add(id, label, 'SKIP', null, null, { reason });

  /* A panicked or de-tiered run cannot be trusted: every metric becomes SKIP
     with the reason, because a frozen rig scores perfectly on all of them. */
  if (!run.error && (run.panic || run.farFrames)) {
    run.error = run.panic
      ? `nz-enemies raised its internal panic counter to ${run.panic} during the run -- the module caught an exception, stopped animating and fell back to its own safe path. Every number below would be measuring a frozen rig, so nothing is reported as PASS. Run the game with ?nzdebug=1, or check the module's console.error output.`
      : `the rig spent ${run.farFrames}/${run.frames} frames on the far/instanced LOD tier instead of a skinned tier, so the bones were not being animated. This is usually a MAX_SKIN/pool exhaustion or an acquireChar failure.`;
    run.discovered = false;
  }

  if (!run.discovered) {
    for (const [id, label] of [
      ['footSkate', 'foot skate (planted, per frame)'],
      ['footPenetrate', 'foot ground penetration'],
      ['footFloat', 'foot float during stance'],
      ['kneeInversion', 'knee inversion / hyperextension events'],
      ['supportHand', 'support hand -> handguard'],
      ['triggerHand', 'trigger hand -> pistol grip'],
      ['nonFinite', 'non-finite bone matrix values'],
      ['weaponOAL', 'weapon overall length vs spec'],
      ['elbowInTorso', 'elbow inside torso capsule'],
      ['strideCoherence', 'stride vs distance travelled'],
    ]) skip(id, label, run.error || 'rig never built');
    return M;
  }

  const rec = run.rec, N = run.frames, R = run.rig;
  const unit = run.rigUnit;

  /* ---------- 1. non-finite ---------- */
  add('nonFinite', 'non-finite bone matrix values', rec.nonFiniteCount <= T.nonFinite ? 'PASS' : 'FAIL',
    rec.nonFiniteCount, T.nonFinite,
    rec.nonFiniteCount ? { worstFrame: rec.nonFinite[0].frame, bone: rec.nonFinite[0].bone, seg: rec.nonFinite[0].seg,
      detail: `${rec.nonFiniteCount} bone-frames with a NaN/Inf in matrixWorld; first at frame ${rec.nonFinite[0].frame} (${rec.nonFinite[0].seg}) on bone "${rec.nonFinite[0].bone}", matrix element ${rec.nonFinite[0].el}. Bones affected: ` +
        [...new Set(rec.nonFinite.map(x => x.bone))].join(', ') } : {});

  /* ---------- 2. feet ---------- */
  const footStats = {};
  let anyFoot = false;
  for (const side of ['L', 'R']) {
    const bufs = rec.foot[side];
    if (!bufs || !bufs.length) continue;
    anyFoot = true;
    /* per-frame lowest probe height, and per-probe horizontal speed */
    const h = new Float64Array(N);
    const lowIdx = new Int32Array(N);
    for (let f = 0; f < N; f++) {
      let best = Infinity, bi = 0;
      for (let p = 0; p < bufs.length; p++) {
        const y = bufs[p][f * 3 + 1];
        if (y < best) { best = y; bi = p; }
      }
      h[f] = best - rec.groundY[f];
      lowIdx[f] = bi;
    }
    /* stance = the foot is in the bottom band of its OWN vertical travel.
       Data-driven so it does not assume a lift height, and so a rig that
       never lifts its feet shows up as a tiny clearance rather than as a
       free pass. */
    /* Height statistics over the LIVE frames only: a ragdoll settling into
       the floor drags the 5th percentile far below ground and would move the
       stance band down with it, hiding every stance frame of the walk. */
    const live = [];
    for (let f = 0; f < N; f++) if (rec.seg[f] !== 'die') live.push(h[f]);
    const hs = live.sort((a, b) => a - b);
    const p05 = percentile(hs, 0.05), p95 = percentile(hs, 0.95);
    const clearance = p95 - p05;
    /* Anchor the band at the ground plane, never below it: a rig that sinks
       is measured against the floor (so penetration reads), a rig that
       hovers is measured against its own plateau (so float reads). */
    const stanceRef = Math.max(p05, 0);
    /* The height histogram of a foot is bimodal: a dense plateau at ground
       level (stance) and a broad hump above it (swing).  The bottom ~8% of
       the foot's OWN vertical travel isolates the plateau without assuming
       any absolute clearance, so a rig that hovers still registers stance
       (and then fails the float metric) instead of registering nothing. */
    const band = Math.max(clearance * 0.08, 0.004);
    const stance = new Uint8Array(N);
    for (let f = 0; f < N; f++) stance[f] = (rec.seg[f] !== 'die' && h[f] <= stanceRef + band) ? 1 : 0;
    /* interior of each stance interval: the frames spanning touchdown and
       toe-off still contain airborne motion and are not "planted" yet */
    const TRIM = 2;
    const planted = new Uint8Array(N);
    { let s0 = -1;
      for (let f = 0; f <= N; f++) {
        const on = f < N && stance[f];
        if (on && s0 < 0) s0 = f;
        else if (!on && s0 >= 0) {
          for (let g = s0 + TRIM; g <= f - 1 - TRIM; g++) planted[g] = 1;
          s0 = -1;
        }
      } }

    /* instantaneous-centre skate: during stance at least ONE ground-touching
       probe must be world-stationary.  This credits a correct heel-to-toe
       roll (the contact point migrates while the material points stay put)
       and still catches a foot sliding as a rigid body. */
    let worstSkate = -1, worstSkateFrame = -1, snap = -1, snapFrame = -1;
    const contactBand = Math.max(clearance * 0.35, 0.02);
    const perFrameSkate = new Float64Array(N).fill(NaN);
    for (let f = 1; f < N; f++) {
      if (!stance[f] || !stance[f - 1]) continue;
      if (rec.seg[f] === 'die' || rec.seg[f - 1] === 'die') continue;
      let minSlip = Infinity, touching = 0;
      for (let p = 0; p < bufs.length; p++) {
        const o = f * 3, o0 = (f - 1) * 3;
        const y = bufs[p][o + 1] - rec.groundY[f];
        if (y > h[f] + contactBand) continue;         /* this probe is airborne */
        touching++;
        const dx = bufs[p][o] - bufs[p][o0], dz = bufs[p][o + 2] - bufs[p][o0 + 2];
        const slip = Math.hypot(dx, dz);
        if (slip < minSlip) minSlip = slip;
      }
      if (!touching) continue;
      if (minSlip > snap) { snap = minSlip; snapFrame = f; }
      if (!planted[f] || !planted[f - 1]) continue;   /* touchdown / toe-off */
      perFrameSkate[f] = minSlip;
      if (minSlip > worstSkate) { worstSkate = minSlip; worstSkateFrame = f; }
    }
    /* penetration / float */
    let pen = 0, penFrame = -1, flo = 0, floFrame = -1;
    for (let f = 0; f < N; f++) {
      if (rec.seg[f] === 'die') continue;
      if (h[f] < pen) { pen = h[f]; penFrame = f; }
      if (stance[f] && h[f] > flo) { flo = h[f]; floFrame = f; }
    }
    /* stance intervals -> plant points, for stride coherence */
    const plants = [];
    let s0 = -1;
    for (let f = 0; f <= N; f++) {
      const on = f < N && stance[f] && rec.seg[f] !== 'die';
      if (on && s0 < 0) s0 = f;
      else if (!on && s0 >= 0) {
        const mid = (s0 + f - 1) >> 1;
        const p = lowIdx[mid];
        plants.push({ f0: s0, f1: f - 1, mid, x: bufs[p][mid * 3], z: bufs[p][mid * 3 + 2], seg: rec.seg[mid] });
        s0 = -1;
      }
    }
    const skSorted = Array.from(perFrameSkate).filter(Number.isFinite).sort((a, b) => a - b);
    let nStance = 0, nPlanted = 0;
    for (let f = 0; f < N; f++) { if (stance[f]) nStance++; if (planted[f]) nPlanted++; }
    footStats[side] = { h, stance, planted, clearance, p05, p95, worstSkate, worstSkateFrame, snap, snapFrame,
      pen, penFrame, flo, floFrame, plants, perFrameSkate, nStance, nPlanted,
      skateP50: percentile(skSorted, 0.5), skateP95: percentile(skSorted, 0.95), skateN: skSorted.length,
      stanceFrac: nStance / N };
    if (OPT.debug)
      console.error(`[debug ${kind}] foot${side}: h p05=${p05.toFixed(4)} p50=${percentile(hs, 0.5).toFixed(4)} p95=${p95.toFixed(4)} clearance=${clearance.toFixed(4)} ref=${stanceRef.toFixed(4)} band=${band.toFixed(4)} stance=${nStance} planted=${nPlanted} skateSamples=${skSorted.length} intervals=${plants.length}`);
  }

  if (!anyFoot) {
    skip('footSkate', 'foot skate (planted, per frame)', 'no foot bones resolved');
    skip('footPenetrate', 'foot ground penetration', 'no foot bones resolved');
    skip('footFloat', 'foot float during stance', 'no foot bones resolved');
    skip('strideCoherence', 'stride vs distance travelled', 'no foot bones resolved');
  } else {
    const worst = (sel) => {
      let bv = -Infinity, bs = null;
      for (const side of Object.keys(footStats)) {
        const v = sel(footStats[side]);
        if (v > bv) { bv = v; bs = side; }
      }
      return { v: bv, side: bs };
    };
    const totalSkateSamples = Object.values(footStats).reduce((a, s) => a + s.skateN, 0);
    const sk = worst(s => s.worstSkate);
    if (totalSkateSamples < 20 || sk.v < 0) {
      const cl = Object.entries(footStats).map(([s, v]) => `foot${s} clearance ${v.clearance.toFixed(4)}u, ${v.nStance} stance / ${v.nPlanted} planted frames, ${v.plants.length} intervals`).join('; ');
      skip('footSkate', 'foot skate (planted, per frame)',
        `only ${totalSkateSamples} usable planted frames -- there is nothing to measure slip over. ${cl}. ` +
        `Either the feet never plant, or they never leave the ground (no detectable swing phase).`);
    } else
    add('footSkate', 'foot skate (planted, per frame)', sk.v <= T.footSkate ? 'PASS' : 'FAIL',
      sk.v < 0 ? 0 : sk.v, T.footSkate,
      { bone: 'foot' + sk.side, worstFrame: footStats[sk.side].worstSkateFrame,
        seg: rec.seg[footStats[sk.side].worstSkateFrame],
        p50: footStats[sk.side].skateP50, p95: footStats[sk.side].skateP95,
        replantSnap: footStats[sk.side].snap, replantSnapFrame: footStats[sk.side].snapFrame,
        detail: `peak ${(sk.v / 0.0035).toFixed(1)} mm/frame, median ${(footStats[sk.side].skateP50 / 0.0035).toFixed(2)} mm, p95 ${(footStats[sk.side].skateP95 / 0.0035).toFixed(1)} mm over ${footStats[sk.side].skateN} planted frames. ` +
          `foot${sk.side} swing clearance ${footStats[sk.side].clearance.toFixed(3)}u, stance duty ${(footStats[sk.side].stanceFrac * 100).toFixed(0)}%. ` +
          `Touchdown/toe-off frames excluded; including them the worst jump is ${(footStats[sk.side].snap / 0.0035).toFixed(1)} mm at frame ${footStats[sk.side].snapFrame} (${rec.seg[footStats[sk.side].snapFrame] || '-'}) -- that number is the re-plant snap, not the plant lock. ` +
          `A high median means the whole stance slides; a low median with a high peak means a single re-plant.` });

    const pe = worst(s => -s.pen);
    add('footPenetrate', 'foot ground penetration', pe.v <= T.footPenetrate ? 'PASS' : 'FAIL',
      Math.max(0, pe.v), T.footPenetrate,
      { bone: 'foot' + pe.side, worstFrame: footStats[pe.side].penFrame, seg: rec.seg[footStats[pe.side].penFrame] || '-',
        detail: `${(Math.max(0, pe.v) / 0.0035).toFixed(1)} mm below the floor plane` });

    const totalStance = Object.values(footStats).reduce((a, s) => a + s.nStance, 0);
    const fl = worst(s => s.flo);
    if (totalStance < 20)
      skip('footFloat', 'foot float during stance', `only ${totalStance} stance frames detected across both feet -- no stance to measure float over`);
    else
      add('footFloat', 'foot float during stance', fl.v <= T.footFloat ? 'PASS' : 'FAIL',
        Math.max(0, fl.v), T.footFloat,
        { bone: 'foot' + fl.side, worstFrame: footStats[fl.side].floFrame, seg: rec.seg[footStats[fl.side].floFrame] || '-',
          detail: `${(Math.max(0, fl.v) / 0.0035).toFixed(1)} mm above the floor while planted; ` +
            `swing clearance foot${fl.side} ${footStats[fl.side].clearance.toFixed(3)}u over ${footStats[fl.side].nStance} stance frames` });

    /* stride vs travel: sum of same-foot plant-to-plant displacement over the
       locomotion segments should equal the distance the body actually moved.
       This is the phase-vs-translation coherence that causes skate. */
    const locoSegs = new Set(['walk', 'sprint']);
    let bestErr = null;
    for (const side of Object.keys(footStats)) {
      const st = footStats[side];
      for (const segName of locoSegs) {
        const ps = st.plants.filter(p => p.seg === segName);
        if (ps.length < 3) continue;
        let stepSum = 0;
        for (let i = 1; i < ps.length; i++) stepSum += Math.hypot(ps[i].x - ps[i - 1].x, ps[i].z - ps[i - 1].z);
        const f0 = ps[0].mid, f1 = ps[ps.length - 1].mid;
        const travel = Math.hypot(rec.bodyXZ[f1 * 2] - rec.bodyXZ[f0 * 2], rec.bodyXZ[f1 * 2 + 1] - rec.bodyXZ[f0 * 2 + 1]);
        if (travel < 0.5) continue;
        const ratio = stepSum / travel;
        const errPct = Math.abs(1 - ratio) * 100;
        if (!bestErr || errPct > bestErr.errPct)
          bestErr = { errPct, ratio, side, segName, steps: ps.length - 1, stepSum, travel, frame: ps[0].mid };
      }
    }
    if (!bestErr) skip('strideCoherence', 'stride vs distance travelled', 'not enough complete stance intervals in the walk/sprint segments to measure (character may not be stepping)');
    else add('strideCoherence', 'stride vs distance travelled', bestErr.errPct <= T.strideCohPct ? 'PASS' : 'FAIL',
      bestErr.errPct, T.strideCohPct,
      { bone: 'foot' + bestErr.side, worstFrame: bestErr.frame, seg: bestErr.segName,
        detail: `${bestErr.steps} strides covering ${bestErr.stepSum.toFixed(2)}u while the body travelled ${bestErr.travel.toFixed(2)}u (ratio ${bestErr.ratio.toFixed(3)}; 1.000 = perfectly phase-locked)` });
  }

  /* ---------- 3. knees ---------- */
  let kneeEvents = 0, kneeWorst = null;
  let haveKnee = false;
  for (const side of ['L', 'R']) {
    const ang = rec.knee[side], sgn = rec.kneeSign[side];
    if (!ang || Number.isNaN(ang[0]) && Number.isNaN(ang[N - 1])) continue;
    haveKnee = true;
    for (let f = 0; f < N; f++) {
      if (rec.seg[f] === 'die') continue;
      const a = ang[f];
      if (!Number.isFinite(a)) continue;
      let bad = null;
      /* a human knee only flexes one way: with lat = up x forward, correct
         flexion (ankle behind the knee) yields a positive cross product. */
      if (a > 4 && sgn[f] < 0) bad = 'inverted (bends the wrong way)';
      else if (a > T.kneeMaxDeg) bad = 'hyperflexed beyond ' + T.kneeMaxDeg + ' deg';
      if (bad) {
        kneeEvents++;
        if (!kneeWorst || a > kneeWorst.a) kneeWorst = { a, f, side, bad, sgn: sgn[f] };
      }
    }
  }
  if (!haveKnee) skip('kneeInversion', 'knee inversion / hyperextension events', 'thigh/shin/foot bones not resolvable');
  else {
    const kr = { L: null, R: null };
    for (const side of ['L', 'R']) {
      const v = Array.from(rec.knee[side]).filter(Number.isFinite).sort((a, b) => a - b);
      if (v.length) kr[side] = [percentile(v, 0.02).toFixed(1), percentile(v, 0.98).toFixed(1)];
    }
    add('kneeInversion', 'knee inversion / hyperextension events', kneeEvents <= T.kneeInversion ? 'PASS' : 'FAIL',
      kneeEvents, T.kneeInversion,
      Object.assign({ detail: `flexion range L ${kr.L ? kr.L.join('-') : 'n/a'} deg, R ${kr.R ? kr.R.join('-') : 'n/a'} deg (legal 0-${T.kneeMaxDeg})` },
        kneeWorst ? { worstFrame: kneeWorst.f, bone: 'shin' + kneeWorst.side, seg: rec.seg[kneeWorst.f],
          detail: `worst: ${kneeWorst.a.toFixed(1)} deg ${kneeWorst.bad} on shin${kneeWorst.side}; flexion range L ${kr.L ? kr.L.join('-') : 'n/a'}, R ${kr.R ? kr.R.join('-') : 'n/a'} deg` } : {}));
  }

  /* ---------- 4. elbow inside torso ---------- */
  if (!R.torso || !R.torso.length)
    skip('elbowInTorso', 'elbow inside torso capsule', 'could not build a torso volume from the mesh (no vertices dominated by hips/spine/chest)');
  else {
    let cnt = 0, first = -1, side = null, deepest = 0, deepFrame = -1, deepSide = null;
    const bySeg = new Map(), byWhere = new Map();
    for (const s of ['L', 'R']) for (let f = 0; f < N; f++) {
      if (rec.seg[f] === 'die') continue;
      if (rec.elbowIn[s][f]) {
        cnt++; if (first < 0) { first = f; side = s; }
        const k = rec.seg[f] + '/' + s;
        bySeg.set(k, (bySeg.get(k) || 0) + 1);
        const w = rec.elbowWhere[s][f] || '?';
        byWhere.set(w, (byWhere.get(w) || 0) + 1);
      }
      if (rec.elbowDepth[s][f] > deepest) { deepest = rec.elbowDepth[s][f]; deepFrame = f; deepSide = s; }
    }
    const breakdown = [...bySeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' ');
    const where = [...byWhere.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
    add('elbowInTorso', 'elbow inside torso capsule', cnt <= T.elbowInTorso ? 'PASS' : 'FAIL',
      cnt, T.elbowInTorso,
      cnt ? { worstFrame: deepFrame, bone: 'fore' + deepSide, seg: rec.seg[deepFrame], depth: deepest,
        detail: `${cnt}/${N} frames with an elbow joint centre inside the ${R.torso.length}-slice torso hull; deepest ${(deepest / 0.0035).toFixed(0)} mm inside on fore${deepSide} at frame ${deepFrame} (${rec.seg[deepFrame]}). ` +
          `By phase/side: ${breakdown}. By body region: ${where}. ` +
          `A few mm is a graze; tens of mm is a real clip. The hull is a per-bone star polygon of median sector radii built from the rig's own mesh, capped below the shoulder joints.` }
          : { detail: `${R.torso.length}-slice elliptical torso hull built from the mesh` });
  }

  /* ---------- 5. grips ---------- */
  const gripReason = R.gripSource === 'none'
    ? (R.weaponNote || 'no weapon geometry and no named grip anchors found')
    : null;
  for (const [id, label, key, thr] of [
    ['supportHand', 'support hand -> handguard', 'support', T.supportHand],
    ['triggerHand', 'trigger hand -> pistol grip', 'trigger', T.triggerHand],
  ]) {
    const arr = rec.handGrip[key];
    const vals = [];
    for (let f = 0; f < N; f++) { if (rec.seg[f] === 'die') continue; if (Number.isFinite(arr[f])) vals.push({ v: arr[f], f }); }
    if (!vals.length) { skip(id, label, gripReason || 'hand bone or grip point unavailable'); continue; }
    vals.sort((a, b) => b.v - a.v);
    const worstV = vals[0], med = vals[Math.floor(vals.length / 2)].v;
    add(id, label, worstV.v <= thr ? 'PASS' : 'FAIL', worstV.v, thr,
      { worstFrame: worstV.f, bone: key === 'support' ? (R.role.fingL || R.role.handL || {}).name : (R.role.fingR || R.role.handR || {}).name,
        seg: rec.seg[worstV.f], median: med, gripSource: R.gripSource,
        detail: `worst ${(worstV.v / 0.0035).toFixed(0)} mm, median ${(med / 0.0035).toFixed(0)} mm; grip point source: ${R.gripSource}` +
          (R.gripSource === 'inferred-from-weapon-geometry'
            ? '. The grip point is a centroid inferred from the weapon vertex cloud (support = 48-72% along the barrel axis, trigger = rear 16-36% below the bore). For an exact measurement, parent an Object3D named "grip_support" and "grip_trigger" under the weapon bone at the real contact points; the harness picks named anchors over inference automatically.'
            : '') });
  }

  /* ---------- 6. weapon OAL ---------- */
  const spec = WEAPON_SPEC[kind];
  if (!R.weapon) skip('weaponOAL', 'weapon overall length vs spec', R.weaponNote || 'no weapon geometry found');
  else if (!spec) skip('weaponOAL', 'weapon overall length vs spec', 'no spec entry for kind ' + kind);
  else {
    const ws = rec.wpnScale.slice().sort((a, b) => a - b);
    const worldScale = ws.length ? percentile(ws, 0.5) : unit;
    const oal = R.weapon.oalLocal * worldScale;
    const errPct = Math.abs(oal - spec.units) / spec.units * 100;
    add('weaponOAL', 'weapon overall length vs spec', errPct <= T.weaponOALPct ? 'PASS' : 'FAIL',
      errPct, T.weaponOALPct,
      { bone: R.weapon.bone.name, measured: oal, worldScale,
        detail: `measured ${oal.toFixed(3)}u (${(oal / 3.5 * 1000).toFixed(0)} mm) along local ${R.weapon.axisName}; spec ${spec.name} ${spec.units}u (${spec.mm} mm). ` +
          `Bind extent ${R.weapon.oalLocal.toFixed(3)} x median weapon-bone world scale ${worldScale.toFixed(4)}; ${R.weapon.count} verts skinned to the weapon bone. ` +
          `SCALE is 3.5 world units per metre.` });
  }
  return M;
}

/* ========================================================= reporting ==== */
const COL = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => COL ? `[${n}m${s}[0m` : s;
const green = s => c(32, s), red = s => c(31, s), yellow = s => c(33, s), dim = s => c(90, s), bold = s => c(1, s);

function fmtNum(v) {
  if (v === null || v === undefined) return '-';
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.001) return v.toFixed(5);
  return v.toExponential(2);
}
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function printReport(result) {
  const { kinds, meta } = result;
  console.log('');
  console.log(bold('  NUKE ZONE 3D  --  enemy rig validation harness'));
  console.log(dim(`  three r${meta.threeRevision} | install ${meta.installMs} ms | ${meta.frames} frames @ 60 Hz | commit ${meta.commit}`));
  console.log(dim(`  C3 surface present: ${meta.c3.length ? meta.c3.join(', ') : bold(red('none')) + dim(' (using scene-graph traversal by bone name)')}`));
  console.log('');
  let fails = 0, skips = 0, passes = 0;
  for (const k of kinds) {
    const label = (meta.displayName && meta.displayName[k.kind]) || DISPLAY_FALLBACK[k.kind] || k.kind;
    console.log(bold(`  ${k.kind}  ${dim('(' + label + ')')}`));
    if (k.error && !k.metrics.some(m => m.status !== 'SKIP')) console.log('    ' + red('! ' + k.error));
    console.log(dim('    ' + pad('metric', 38) + padL('measured', 12) + padL('threshold', 12) + '  status'));
    for (const m of k.metrics) {
      const st = m.status === 'PASS' ? green('PASS') : m.status === 'FAIL' ? red('FAIL') : yellow('SKIP');
      if (m.status === 'PASS') passes++; else if (m.status === 'FAIL') fails++; else skips++;
      console.log('    ' + pad(m.label, 38) + padL(fmtNum(m.value), 12) + padL(m.threshold === null ? '-' : fmtNum(m.threshold), 12) + '  ' + st);
      if (m.status === 'FAIL') {
        const bits = [];
        if (m.worstFrame !== undefined && m.worstFrame >= 0) bits.push(`worst frame ${m.worstFrame}` + (m.seg ? ` (${m.seg})` : ''));
        if (m.bone) bits.push(`bone ${m.bone}`);
        if (bits.length) console.log(dim('       -> ' + bits.join(', ')));
        if (m.detail) console.log(dim('       -> ' + m.detail));
      } else if (m.status === 'SKIP') {
        console.log(yellow('       -> skipped: ') + dim(m.reason || 'unknown'));
      } else if (OPT.verbose && m.detail) {
        console.log(dim('       -> ' + m.detail));
      }
    }
    if (k.notes && k.notes.length) for (const n of k.notes) console.log(dim('    . ' + n));
    console.log('');
  }
  if (result.baselineCompare) {
    console.log(bold('  vs baseline ') + dim(result.baselineCompare.file + '  (' + result.baselineCompare.commit + ')'));
    for (const row of result.baselineCompare.rows) {
      const arrow = row.dir === 'better' ? green('improved') : row.dir === 'worse' ? red('REGRESSED') : dim('same');
      console.log('    ' + pad(row.kind + ' / ' + row.id, 44) + padL(fmtNum(row.was), 12) + ' -> ' + padL(fmtNum(row.now), 12) + '  ' + arrow);
    }
    const sc = result.baselineCompare.statusChanges || [];
    if (sc.length) {
      console.log(dim('    status changes:'));
      for (const s of sc) {
        const arrow = s.dir === 'better' ? green(s.was + ' -> ' + s.now) : s.dir === 'worse' ? red(s.was + ' -> ' + s.now) : yellow(s.was + ' -> ' + s.now);
        console.log('    ' + pad(s.kind + ' / ' + s.id, 44) + arrow);
      }
    }
    console.log('');
  }
  if (result.notes.length) { for (const n of result.notes) console.log(dim('  note: ' + n)); console.log(''); }
  const summary = `  ${passes} pass, ${fails} fail, ${skips} skipped`;
  console.log(fails ? red(bold(summary)) : skips ? yellow(bold(summary)) : green(bold(summary)));
  if (skips) console.log(dim('  SKIPPED is not PASS -- those metrics were not measurable, see reasons above.'));
  console.log('');
}

/* ============================================================== main ==== */
function gitCommit() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return 'unknown'; }
}
function fileHashes() {
  const out = {};
  for (const f of ['nz-enemies.js', 'nz-core.js', 'NUKEM.html']) {
    try {
      const buf = fs.readFileSync(path.join(ROOT, f));
      let h = 5381;
      for (let i = 0; i < buf.length; i++) h = ((h * 33) ^ buf[i]) >>> 0;
      out[f] = { bytes: buf.length, hash: h.toString(16) };
    } catch (e) { out[f] = null; }
  }
  return out;
}

function main() {
  const H = new Harness();
  try { H.boot(); }
  catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (OPT.json) { console.log(JSON.stringify({ ok: false, fatal: msg, moduleErrors: MODULE_ERRORS.slice(0, 5) }, null, 2)); }
    else {
      console.error('');
      console.error(red(bold('  enemy-harness could not boot the game modules.')));
      console.error('  ' + msg);
      if (MODULE_ERRORS.length) { console.error(dim('  module errors:')); for (const e of MODULE_ERRORS.slice(0, 5)) console.error(dim('    ' + e)); }
      console.error(dim('\n  This is a harness/module-shape problem, not a metric failure.'));
      console.error(dim('  Check: does nz-enemies.js still register createEnemyRig/animateEnemyRig on the `ready` hook?\n'));
    }
    process.exit(1);
  }

  const kinds = (OPT.kinds.length ? OPT.kinds : ALL_KINDS).filter(k => H.ECFG[k]);
  const unknown = (OPT.kinds.length ? OPT.kinds : []).filter(k => !H.ECFG[k]);
  const results = [];
  for (const kind of kinds) {
    let run;
    try { run = runScenario(H, kind, OPT); }
    catch (err) { run = { kind, discovered: false, error: 'scenario threw: ' + (err && err.message ? err.message : err), frames: 0, problems: [] }; }
    const metrics = analyse(H, run);
    results.push({
      kind, error: run.error || null, frames: run.frames, metrics,
      boneCount: run.rig && run.rig.bones ? run.rig.bones.length : 0,
      gripSource: run.gripSource || (run.rig && run.rig.gripSource) || 'none',
      notes: [run.probeNote, run.weaponNote, run.tierNote, ...(run.problems || [])].filter(Boolean),
      rigUnit: run.rigUnit,
    });
  }

  const displayName = (H.NZ.enemies && H.NZ.enemies.displayName) || null;
  const meta = {
    threeRevision: H.threeRevision, installMs: H.installMs,
    frames: results.length ? results[0].frames : 0,
    commit: gitCommit(), files: fileHashes(), when: new Date().toISOString(),
    c3: Object.keys(H.c3), displayName,
    thresholds: T, weaponSpec: WEAPON_SPEC,
  };
  const notes = H.notes.slice();
  if (unknown.length) notes.push('unknown kind(s) requested and skipped: ' + unknown.join(', '));
  if (!displayName) notes.push('NZ.enemies.displayName is missing (contract C2/C3 asks for it)');
  if (MODULE_WARNINGS.length) notes.push(MODULE_WARNINGS.length + ' warning(s) from nz-enemies during install' + (OPT.verbose ? ': ' + MODULE_WARNINGS.slice(0, 3).join(' | ') : ''));

  const result = { ok: true, meta, kinds: results, notes };

  /* baseline comparison */
  if (OPT.baseline && typeof OPT.baseline === 'string' && fs.existsSync(OPT.baseline)) {
    try {
      const base = JSON.parse(fs.readFileSync(OPT.baseline, 'utf8'));
      const rows = [], statusChanges = [];
      const lowerIsBetter = new Set(['footSkate', 'footPenetrate', 'footFloat', 'kneeInversion', 'supportHand', 'triggerHand', 'nonFinite', 'weaponOAL', 'elbowInTorso', 'strideCoherence']);
      for (const k of results) {
        const bk = (base.kinds || []).find(x => x.kind === k.kind);
        if (!bk) continue;
        for (const m of k.metrics) {
          const bm = bk.metrics.find(x => x.id === m.id);
          if (!bm) continue;
          if (bm.status !== m.status)
            statusChanges.push({ kind: k.kind, id: m.id, was: bm.status, now: m.status,
              dir: m.status === 'PASS' ? 'better' : (bm.status === 'PASS' ? 'worse' : 'same') });
          if (bm.value === null || m.value === null) continue;
          const eps = Math.max(1e-9, Math.abs(bm.value) * 0.02);
          const d = m.value - bm.value;
          const dir = Math.abs(d) <= eps ? 'same' : (lowerIsBetter.has(m.id) ? (d < 0 ? 'better' : 'worse') : (d > 0 ? 'better' : 'worse'));
          rows.push({ kind: k.kind, id: m.id, was: bm.value, now: m.value, dir });
        }
      }
      result.baselineCompare = { file: String(OPT.baseline), commit: (base.meta && base.meta.commit) || '?', rows, statusChanges };
    } catch (err) { notes.push('baseline compare failed: ' + err.message); }
  }

  if (OPT.writeBaseline) {
    const file = OPT.writeBaseline === true ? path.join(HERE, 'enemy-baseline.json') : String(OPT.writeBaseline);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    if (!OPT.json) console.log(dim(`  baseline written to ${file}`));
  }

  const fails = results.reduce((a, k) => a + k.metrics.filter(m => m.status === 'FAIL').length, 0);
  const skips = results.reduce((a, k) => a + k.metrics.filter(m => m.status === 'SKIP').length, 0);
  result.summary = {
    pass: results.reduce((a, k) => a + k.metrics.filter(m => m.status === 'PASS').length, 0),
    fail: fails, skip: skips,
  };
  if (OPT.json) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
  process.exit(fails ? 1 : 0);
}

main();
