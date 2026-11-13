/* ===========================================================================
   NZ-AUDIO  --  CS2-grade sound subsystem for NUKEM.

   Classic script. No modules, no fetch, no sample files. Every waveform in
   this file is computed at runtime: the noise beds, the impulse responses,
   and - new in this revision - a bank of physically-modelled muzzle-blast,
   ballistic-crack, footstep and casing transients rendered sample-by-sample
   into AudioBuffers at first use.

   Why pre-render transients at all?
     A gunshot is defined by its first 500 microseconds. You cannot get a
     20 us shock front out of an oscillator or a filtered noise burst: the
     gain ramp is the fastest thing you have and a biquad smears the edge.
     Rendering the Friedlander blast wave, the barrel modes, the ground
     bounce and the supersonic N-wave directly into a buffer gives exact
     control of that first half-millisecond, which is the difference between
     "gun" and "synth pop". Everything else stays live so nothing repeats.

   What it owns
     * gunshots        supersonic crack / muzzle blast / bore modes / jet /
                       mech / tail, per weapon, with SEPARATE near and far
                       renderings crossfaded by distance
     * propagation     the crack arrives at once, the blast arrives late -
                       scheduled, not delay-noded, so the two can diverge
     * convolution     image-source early reflections + 3-band decay tails,
                       five spaces, crossfaded with hysteresis
     * occlusion       transmission (dark, quiet) AND diffraction (a portal
                       search: blocked sound is re-panned to the corner it
                       actually comes around)
     * footsteps       nine surfaces, granular synthesis, heel-toe pairs,
                       loudness and brightness driven by movement speed
     * mix bus         category submixes, spectrally-tilted ducking so
                       footsteps survive gunfire, glue comp, damage filter
     * voice mgmt      hard cap, node pools, priority-weighted stealing

   Installs through NZ.on('sfx', ...). Any cue this file does not implement
   returns undefined and falls through to the game's stock synthesis, so a
   partial install is never a silent install.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { try { console.error('[nz-audio] nz-core.js not loaded; audio module inert'); } catch (e) {} return; }

  /* =======================================================================
     0. numeric hygiene
     A NaN reaching an AudioParam either throws or silently poisons the whole
     downstream graph, and the game's clamp() passes NaN straight through
     (every comparison against NaN is false). So: one validator, used on the
     way into every single param write. No exceptions.
     ==================================================================== */
  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function fin(v, d) { return isNum(v) ? v : d; }
  function cl(v, lo, hi) { v = isNum(v) ? v : lo; return v < lo ? lo : (v > hi ? hi : v); }
  function rr(a, b) { return a + Math.random() * (b - a); }
  function smoothstep(a, b, x) {
    if (!(b > a)) return x >= b ? 1 : 0;
    var t = cl((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  var EPS = 0.00012;            /* exponential ramps may never target zero */
  var C_AIR = 343;              /* m/s */

  /* =======================================================================
     1. module state
     ==================================================================== */
  var ctx = null;               /* the GAME's AudioContext - never a second one */
  var AUref = null;             /* the game's AU object */
  var G = null;                 /* my node graph */
  var installed = false, dead = false;
  var SR = 48000;

  var TIER = 'high';
  var CAP = 60;                 /* hard concurrent-source cap */
  var live = [];                /* active voices, for stealing */
  var peakVoices = 0;
  /* Steal accounting. Sustained full-auto is the only thing in the game that
     can push the pool to the cap, and the question that matters when it does
     is not "how often" but "what got killed": a stolen gunshot tail costs
     nothing, a stolen enemy footstep costs a round. NZ.audio.stats() reports
     the histogram so that is checkable while playing rather than assumed. */
  var steals = 0, stolenPri = {}, deniedVoices = 0;

  var NOISE = {};               /* white / pink / brown / crackle buffers */
  var WAVES = {};               /* PeriodicWaves for glottal sources */
  var CURVES = {};              /* WaveShaper curves */

  var BANK = {};                /* pre-rendered transient banks, lazily filled */
  var lastVar = {};             /* per-bank last index, for no-immediate-repeat */
  var genCost = {};             /* ms spent generating each bank, for the report */

  var IR = {};                  /* space name -> AudioBuffer */
  /* Global wet-gain trim applied when normalising impulse responses.
     Adjustable at runtime via NZ.audio.setIrTrim(v) - regenerates the cache. */
  var IRTRIM = 0.5;
  var IRQ = ['room', 'corridor', 'hall', 'outdoor', 'stair'];
  var irRT = {};                /* measured RT60 per space, for the report */

  var space = { name: 'room', open: 0.5, height: 12, wet: 0.16, sky: false, size: 1 };
  var spaceCell = -1, spaceT = 0, spaceWant = '', spaceWantT = 0, spaceLock = 0;

  var occCache = new Map();     /* my own LOS+portal cache */
  var portalBudget = 0, portalLast = 0;
  var chain = { spin: 0, last: -9, nodes: null, seq: 0 };
  var rifleSeq = 0;             /* shot counter: drives the even/odd timbre bias */
  var rifleLast = -9;           /* last rifle cue, ANY shooter: burst-density gate */
  var pistolSeq = 0;            /* the pistol had neither, and it showed */
  var pistolLast = -9;
  var springLast = -9;          /* buffer spring: do not stack ring-downs */
  var lastImpact = 0, impactBudget = 0;

  var METERS_PER_UNIT = 0.45;   /* EYE 2.85 units ~ 1.7 m eye height */

  /* Gunfire gets its own additive lift; no ambience, UI, footsteps or voices
     are turned down to make room for it. The first multiplier is a modest
     +1.7 dB for every firearm report. A shot emitted by the player receives
     another +4.3 dB, for a clearly audible +6 dB first-person bang before the
     existing safety limiter. Keeping this at the cue bus preserves every
     weapon's carefully authored blast / body / mechanism balance. */
  var GUNSHOT_GAIN = 1.22;
  var PLAYER_GUNSHOT_GAIN = 1.64;

  /* =======================================================================
     2. lazy access to the game's globals
     player / CELL / grid / REG are top-level `const` in NUKEM.html's classic
     script: they live in the global LEXICAL environment, so they are visible
     as bare identifiers from this file but are NOT properties of window.
     Reading them before the game script has evaluated throws (TDZ), so every
     read goes through a thunk wrapped in try/catch and is resolved lazily.
     ==================================================================== */
  function tryGet(fn) { try { var v = fn(); return v; } catch (e) { return undefined; } }
  var W = null;
  function world() {
    if (W) { W.camera = tryGet(function () { return camera; }) || W.camera; return W; }
    var p = tryGet(function () { return player; });
    if (!p) return null;
    W = {
      player: p,
      CELL: fin(tryGet(function () { return CELL; }), 4),
      EYE: fin(tryGet(function () { return EYE; }), 2.85),
      MW: fin(tryGet(function () { return MW; }), 64),
      MH: fin(tryGet(function () { return MH; }), 48),
      S_SOLID: fin(tryGet(function () { return S_SOLID; }), 0),
      grid: tryGet(function () { return grid; }) || null,
      idx: tryGet(function () { return idx; }) || null,
      inb: tryGet(function () { return inb; }) || null,
      regAt: tryGet(function () { return regAt; }) || null,
      floorAt: tryGet(function () { return floorAt; }) || null,
      losClear: tryGet(function () { return shotLineClear; }) || null,
      blocked: tryGet(function () { return shotBlocked; }) || null,
      WPN: tryGet(function () { return WPN; }) || null,
      keys: tryGet(function () { return keysDown; }) || null,
      enemies: tryGet(function () { return enemies; }) || null,
      camera: tryGet(function () { return camera; }) || null
    };
    return W;
  }

  /* Legacy positional-emitter height. Kept unchanged here so the gunfire
     retune cannot move or re-level voices, footsteps, impacts, or ambience. */
  function emitterY(x, z) {
    var w = world(); if (!w) return 3;
    var cx = Math.floor(fin(x, 0) / w.CELL), cz = Math.floor(fin(z, 0) / w.CELL);
    if (w.inb && w.floorAt && w.inb(cx, cz)) return fin(w.floorAt(cx, cz), 0) + 2.4;
    return fin(w.player.y, 0) + w.EYE;
  }

  /* Unit forward vector of the listener, from the camera when it exists.
     Used for the front/back pinna cue - HRTF alone disambiguates weakly. */
  var FWD = { x: 0, y: 0, z: -1 };
  function listenerFwd() {
    var w = world();
    if (w && w.camera && w.camera.matrixWorld && w.camera.matrixWorld.elements) {
      var e = w.camera.matrixWorld.elements;
      /* three.js column-major: -Z column is the view direction */
      var fx = -fin(e[8], 0), fy = -fin(e[9], 0), fz = -fin(e[10], -1);
      var L = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (L > 1e-4) { FWD.x = fx / L; FWD.y = fy / L; FWD.z = fz / L; return FWD; }
    }
    if (w && isNum(w.player.yaw)) {
      FWD.x = -Math.sin(w.player.yaw); FWD.y = 0; FWD.z = -Math.cos(w.player.yaw);
    }
    return FWD;
  }

  /* =======================================================================
     3. node pools
     BufferSources and Oscillators are one-shot by spec and cannot be pooled,
     but everything they hang off can be. At 12 chaingun rounds a second the
     difference is a few hundred allocations a second versus a few dozen.
     ==================================================================== */
  var pool = { g: [], bq: [], pn: [], dl: [], sh: [], sp: [] };
  var POOLMAX = 128;

  function getGain(v) {
    var n = pool.g.pop();
    if (n) { try { n.gain.cancelScheduledValues(0); } catch (e) {} n.gain.value = cl(v === undefined ? 1 : v, 0, 8); n.onended = null; }
    else { n = ctx.createGain(); n.gain.value = cl(v === undefined ? 1 : v, 0, 8); }
    return n;
  }
  function putGain(n) { if (!n) return; try { n.disconnect(); } catch (e) {} if (pool.g.length < POOLMAX) pool.g.push(n); }

  function getBQ(type, f, q, gdb) {
    var n = pool.bq.pop();
    if (n) {
      try {
        n.frequency.cancelScheduledValues(0); n.Q.cancelScheduledValues(0);
        n.gain.cancelScheduledValues(0); n.detune.cancelScheduledValues(0);
      } catch (e) {}
      n.detune.value = 0;
    } else n = ctx.createBiquadFilter();
    n.type = type || 'lowpass';
    n.frequency.value = cl(f === undefined ? 1000 : f, 10, SR * 0.48);
    n.Q.value = cl(q === undefined ? 1 : q, 0.0001, 40);
    n.gain.value = cl(gdb === undefined ? 0 : gdb, -40, 40);
    return n;
  }
  function putBQ(n) { if (!n) return; try { n.disconnect(); } catch (e) {} if (pool.bq.length < POOLMAX) pool.bq.push(n); }

  function getPanner(model) {
    var n = pool.pn.pop();
    if (!n) {
      n = ctx.createPanner();
      n.distanceModel = 'inverse';
      n.refDistance = 1; n.rolloffFactor = 0;   /* direction only; gain is mine */
      n.maxDistance = 10000;
      n.coneInnerAngle = 360; n.coneOuterAngle = 360; n.coneOuterGain = 1;
      n._pm = '';
    }
    if (n._pm !== model) { try { n.panningModel = model; n._pm = model; } catch (e) {} }
    if (n.positionX) {
      try {
        n.positionX.cancelScheduledValues(0);
        n.positionY.cancelScheduledValues(0);
        n.positionZ.cancelScheduledValues(0);
      } catch (e) {}
    }
    return n;
  }
  function putPanner(n) { if (!n) return; try { n.disconnect(); } catch (e) {} if (pool.pn.length < 28) pool.pn.push(n); }

  function getDelay(t) {
    var n = pool.dl.pop();
    if (n) { try { n.delayTime.cancelScheduledValues(0); } catch (e) {} }
    else n = ctx.createDelay(0.62);
    n.delayTime.value = cl(t, 0, 0.6);
    return n;
  }
  function putDelay(n) { if (!n) return; try { n.disconnect(); } catch (e) {} if (pool.dl.length < 24) pool.dl.push(n); }

  function getShaper(name) {
    var n = pool.sh.pop();
    if (!n) { n = ctx.createWaveShaper(); n.oversample = '2x'; }
    n.curve = CURVES[name] || CURVES.soft;
    return n;
  }
  function putShaper(n) { if (!n) return; try { n.disconnect(); } catch (e) {} if (pool.sh.length < 16) pool.sh.push(n); }

  function getStereo(p) {
    if (!ctx.createStereoPanner) return null;
    var n = pool.sp.pop();
    if (n) { try { n.pan.cancelScheduledValues(0); } catch (e) {} } else n = ctx.createStereoPanner();
    n.pan.value = cl(p, -1, 1);
    return n;
  }
  function putStereo(n) { if (!n) return; try { n.disconnect(); } catch (e) {} if (pool.sp.length < 16) pool.sp.push(n); }

  function putAny(kind, n) {
    if (kind === 'g') putGain(n);
    else if (kind === 'bq') putBQ(n);
    else if (kind === 'pn') putPanner(n);
    else if (kind === 'dl') putDelay(n);
    else if (kind === 'sp') putStereo(n);
    else if (kind === 'sh') putShaper(n);
    else { try { n.disconnect(); } catch (e) {} }
  }

  /* =======================================================================
     4. safe AudioParam automation
     Nothing is ever scheduled in the past, no non-finite value ever reaches a
     param, and no exponential ramp ever targets exactly zero.
     ==================================================================== */
  function pSet(p, v, t) { try { p.setValueAtTime(fin(v, 0), Math.max(fin(t, 0), ctx.currentTime)); } catch (e) {} }
  function pLin(p, v, t) { try { p.linearRampToValueAtTime(fin(v, 0), Math.max(fin(t, 0), ctx.currentTime + 0.0005)); } catch (e) {} }
  function pExp(p, v, t) {
    v = fin(v, EPS); if (v > -EPS && v < EPS) v = v < 0 ? -EPS : EPS;
    try { p.exponentialRampToValueAtTime(v, Math.max(fin(t, 0), ctx.currentTime + 0.0005)); } catch (e) {}
  }
  function pHold(p, t) {
    t = Math.max(fin(t, 0), ctx.currentTime);
    if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(t); return; } catch (e) {} }
    var v = fin(p.value, 0);
    try { p.cancelScheduledValues(t); p.setValueAtTime(v, t); } catch (e) {}
  }
  /* points = [[timeOffset, value], ...] relative to t0. Linear ramps only:
     setValueCurveAtTime throws if any other event lands inside its window, and
     a throw here would take out a whole cue. */
  function pCurve(p, pts, t0, mn, mx) {
    if (!pts || !pts.length) return;
    pSet(p, cl(pts[0][1], mn, mx), t0 + fin(pts[0][0], 0));
    for (var i = 1; i < pts.length; i++) pLin(p, cl(pts[i][1], mn, mx), t0 + fin(pts[i][0], 0));
  }

  /* =======================================================================
     5. offline DSP kit
     Used only while filling AudioBuffers at generation time. Nothing here
     runs in the audio thread.
     ==================================================================== */
  function mulberry(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* RBJ cookbook biquad. Q here is the TRUE quality factor (not the Web Audio
     dB convention) because this filter is mine, not a BiquadFilterNode. */
  function bqCoef(type, f0, Q, sr, gdb) {
    f0 = cl(f0, 10, sr * 0.49); Q = cl(Q, 0.05, 40);
    var w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    var al = sw / (2 * Q), A = Math.pow(10, fin(gdb, 0) / 40);
    var b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    } else if (type === 'bandpass') {
      b0 = al; b1 = 0; b2 = -al;
      a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    } else if (type === 'peaking') {
      b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A;
      a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
    } else if (type === 'lowshelf') {
      var s2 = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - (A - 1) * cw + s2);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - s2);
      a0 = (A + 1) + (A - 1) * cw + s2;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - s2;
    } else {                                  /* lowpass */
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  /* in-place direct-form-I run. src may equal dst. */
  function bqRun(d, c, from, to) {
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0, x, y;
    from = from || 0; to = (to === undefined) ? d.length : to;
    for (var i = from; i < to; i++) {
      x = d[i];
      y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      d[i] = y;
    }
  }
  function bqInto(dst, src, c, gain) {
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0, x, y, n = src.length;
    for (var i = 0; i < n; i++) {
      x = src[i];
      y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      dst[i] += y * gain;
    }
  }

  /* Damped sinusoid via the two-pole resonator recursion. Three multiplies a
     sample instead of a Math.sin call, which matters when a footstep is a
     hundred grains. */
  function addMode(d, i0, f, tau, amp, ph, sr) {
    if (!(f > 0) || !(tau > 0) || !(amp > 0)) return;
    var n = d.length;
    if (i0 >= n) return;
    var r = Math.exp(-1 / (tau * sr));
    if (r >= 0.99999) r = 0.99999;
    var w = 2 * Math.PI * f / sr;
    if (w >= Math.PI * 0.995) return;
    var len = Math.min(n - i0, Math.ceil(6.9 * tau * sr) + 2);
    var c1 = 2 * r * Math.cos(w), c2 = -r * r;
    var y2 = amp * Math.sin(ph);
    var y1 = amp * r * Math.sin(w + ph);
    if (i0 >= 0) d[i0] += y2;
    if (i0 + 1 < n && len > 1) d[i0 + 1] += y1;
    for (var k = 2; k < len; k++) {
      var y = c1 * y1 + c2 * y2;
      y2 = y1; y1 = y;
      d[i0 + k] += y;
    }
  }

  /* Friedlander blast wave: instantaneous overpressure rise, exponential
     decay through zero at t=T into a negative phase, then recovery. This is
     the actual physics of a muzzle blast and the reason a real gunshot has a
     crest factor a synth pad can only dream of. */
  function addFriedlander(d, i0, T, amp, sr) {
    var n = d.length;
    if (i0 >= n || !(T > 0)) return;
    var len = Math.min(n - i0, Math.ceil(T * sr * 9) + 3);
    var iT = 1 / (T * sr);
    var st = Math.exp(-iT), e = amp;
    for (var k = 0; k < len; k++) {
      if (i0 + k >= 0) d[i0 + k] += e * (1 - k * iT);
      e *= st;
    }
  }

  /* Supersonic N-wave: the projectile's shock cone. Instant rise to +P,
     linear fall to -P over T, instant recovery. T grows with miss distance
     (~d^0.25); at typical engagement ranges it is 150-500 microseconds,
     which is why the crack is so much brighter than the blast. */
  function addNWave(d, i0, T, amp, sr, riseSamp) {
    var n = d.length, len = Math.ceil(T * sr);
    if (i0 >= n || len < 2) return;
    var rs = Math.max(1, riseSamp | 0);
    for (var k = 0; k < len + rs && i0 + k < n; k++) {
      var v;
      if (k < rs) v = (k + 1) / rs;                       /* leading shock */
      else if (k < len) v = 1 - 2 * (k - rs) / Math.max(1, len - rs);
      else v = -1 + (k - len + 1) / rs;                   /* trailing shock */
      if (v < -1) v = -1;
      d[i0 + k] += amp * v;
    }
  }

  function peakOf(d) { var p = 0, i; for (i = 0; i < d.length; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > p) p = a; } return p; }
  function normalise(d, target) {
    var p = peakOf(d);
    if (p < 1e-9) return 0;
    var k = target / p;
    for (var i = 0; i < d.length; i++) d[i] *= k;
    return p;
  }
  /* remove DC / infrasonic content that a speaker only turns into excursion */
  function dcTrim(d, sr, f) {
    var a = 1 - Math.exp(-2 * Math.PI * (f || 28) / sr), s = 0;
    for (var i = 0; i < d.length; i++) { s += (d[i] - s) * a; d[i] -= s; }
  }
  /* short raised-cosine tail so a truncated buffer never clicks */
  function fadeTail(d, samples) {
    var n = d.length, m = Math.min(samples | 0, n);
    for (var i = 0; i < m; i++) {
      var w = 0.5 - 0.5 * Math.cos(Math.PI * i / m);
      d[n - 1 - i] *= w;
    }
  }

  /* =======================================================================
     6. procedural source material (long looping beds)
     ==================================================================== */
  function buildNoise() {
    var n = Math.floor(SR * 2.4), i, r = mulberry(0x9E37);

    var w = ctx.createBuffer(1, n, SR), wd = w.getChannelData(0);
    for (i = 0; i < n; i++) wd[i] = r() * 2 - 1;
    NOISE.white = w;

    /* Paul Kellet pink filter - a proper 1/f slope, not white through a shelf */
    var p = ctx.createBuffer(1, n, SR), pd = p.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (i = 0; i < n; i++) {
      var wn = wd[i];
      b0 = 0.99886 * b0 + wn * 0.0555179; b1 = 0.99332 * b1 + wn * 0.0750759;
      b2 = 0.96900 * b2 + wn * 0.1538520; b3 = 0.86650 * b3 + wn * 0.3104856;
      b4 = 0.55000 * b4 + wn * 0.5329522; b5 = -0.7616 * b5 - wn * 0.0168980;
      pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + wn * 0.5362) * 0.16;
      b6 = wn * 0.115926;
    }
    NOISE.pink = p;

    /* leaky-integrated brown: the rumble bed under explosions and wind */
    var br = ctx.createBuffer(1, n, SR), bd = br.getChannelData(0), acc = 0;
    for (i = 0; i < n; i++) { acc = acc * 0.996 + wd[i] * 0.045; bd[i] = cl(acc * 3.2, -1, 1); }
    NOISE.brown = br;

    /* crackle: sparse decaying impulses. Debris, gibs, splintering wood. */
    var ck = ctx.createBuffer(1, n, SR), cd = ck.getChannelData(0);
    for (i = 0; i < n; i++) cd[i] = 0;
    var grains = Math.floor(n / 260);
    for (var gI = 0; gI < grains; gI++) {
      var at = (r() * (n - 400)) | 0, len = 24 + ((r() * 190) | 0), amp = Math.pow(r(), 2.4);
      var ph = 0, step = 0.03 + r() * 0.5;
      for (var k = 0; k < len; k++) {
        var e = Math.pow(1 - k / len, 3);
        ph += step;
        cd[at + k] += Math.sin(ph) * e * amp * 0.9;
      }
    }
    for (i = 0; i < n; i++) cd[i] = cl(cd[i], -1, 1);
    NOISE.crackle = ck;

    /* grit: dense, very short micro-impacts. Gravel, sand, plaster dust. */
    var gr = ctx.createBuffer(1, n, SR), gd = gr.getChannelData(0);
    for (i = 0; i < n; i++) gd[i] = 0;
    var gn = Math.floor(n / 46);
    for (var q = 0; q < gn; q++) {
      var ga = (r() * (n - 90)) | 0, gl = 6 + ((r() * 60) | 0), gm = Math.pow(r(), 3.1) * 0.9;
      var gw = 0.25 + r() * 1.6, gp = r() * 6.283;
      for (var m = 0; m < gl; m++) {
        gd[ga + m] += Math.sin(gp + m * gw) * Math.pow(1 - m / gl, 2.6) * gm;
      }
    }
    for (i = 0; i < n; i++) gd[i] = cl(gd[i], -1, 1);
    NOISE.grit = gr;
  }

  /* Glottal-ish pulse waves. A raw sawtooth reads as a synth; a pulse with a
     steeper high-harmonic rolloff and a slight asymmetry reads as a throat. */
  function buildWaves() {
    function mk(name, fn, N) {
      var re = new Float32Array(N + 1), im = new Float32Array(N + 1);
      for (var h = 1; h <= N; h++) { im[h] = fn(h); re[h] = 0; }
      try { WAVES[name] = ctx.createPeriodicWave(re, im, { disableNormalization: false }); } catch (e) {}
    }
    mk('glottal', function (h) { return Math.pow(h, -1.72) * (h % 2 ? 1 : 0.62); }, 40);
    mk('buzz', function (h) { return Math.pow(h, -0.92); }, 32);
    mk('hollow', function (h) { return (h % 2) ? Math.pow(h, -1.25) : 0; }, 30);
    mk('rasp', function (h) { return Math.pow(h, -0.7) * (1 + 0.5 * Math.sin(h * 2.1)); }, 26);
  }

  function buildCurves() {
    function mk(name, f) {
      var n = 1024, c = new Float32Array(n);
      for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = cl(f(x), -1, 1); }
      CURVES[name] = c;
    }
    mk('soft', function (x) { return Math.tanh(x * 1.9); });
    mk('crunch', function (x) { return Math.tanh(x * 5.5) * 0.86; });
    mk('radio', function (x) { var y = Math.tanh(x * 7); return y * 0.8 + Math.sin(x * 6.0) * 0.12; });
    mk('fold', function (x) { return Math.sin(x * 2.6) * 0.9; });
    /* asymmetric: even harmonics, which is what a blast through a barrel
       actually produces and what makes the report read as "pressure". */
    mk('blast', function (x) { return Math.tanh(x * 3.1 + 0.22 * x * x) * 0.92; });
    /* The same asymmetry at a third of the drive, for the FIRST-PERSON blast.
       'blast' costs about 9.7 dB of crest factor (tanh(3.1x) lifts x=0.05 by
       2.84x while leaving the peak alone), and in smp() the shaper sits BEFORE
       the gain node, so it always sees the buffer at unity no matter how quiet
       the layer is. Applying that to the player's own shot destroys exactly the
       thing addFriedlander exists to produce, at exactly the range where the
       real crest factor is highest - a 5.56 measures 158-162 dB peak at the
       shooter's ear with a positive phase under 0.2 ms. Same character, a
       quarter of the flattening. */
    mk('blastLite', function (x) { return Math.tanh(x * 1.30 + 0.15 * x * x) * 0.99; });
  }

  /* =======================================================================
     7. transient banks
     A gunshot is its first half-millisecond. Nothing in the Web Audio node
     graph can produce a 20 microsecond shock front, so these waveforms are
     rendered sample-by-sample. Everything downstream of them - the jet, the
     tail, the mech, the reverb - stays live and randomised, so the bank never
     becomes audible as a sample.
     ==================================================================== */

  /* Barrel length -> open-pipe fundamental c/2L. This is where each weapon's
     pitch centre comes from, and it is why the pistol snaps at 1.5 kHz and
     the launcher tube honks at 180 Hz. */
  /* T is the positive-phase duration of the shock front. A Friedlander wave
     of duration T has its spectral peak at 1/(2*pi*T), so T is literally the
     pitch of the report: 0.4 ms -> 400 Hz for a pistol, 1.35 ms -> 118 Hz for
     a shotgun. gasMul/gasAmp add the much longer propellant-cloud
     overpressure underneath, which is where the boom lives. */
  var GUN = {
    /* 9x19 service pistol. The two numbers that changed here are T and gasAmp,
       and both were backwards.

       T. A Friedlander pulse p(t) = P0(1 - t/T)e^(-t/T) has the closed-form
       spectrum |P(w)| = P0*w/(T^-2 + w^2), which peaks at EXACTLY f = 1/(2*pi*T)
       and falls +6/-6 dB per octave either side. Measured handgun blast at the
       shooter's ear peaks at 640-1060 Hz, which pins T at 0.15-0.25 ms. It was
       0.40 ms here (398 Hz) - an octave low, and LONGER than the rifle's, which
       is the wrong way round. Blast scaling is unambiguous on this: the
       characteristic length is lambda = (E/p_inf)^(1/3), so duration goes as
       E^(1/3). A 9 mm burns ~0.35 g of powder against a 5.56's ~1.69 g, giving
       lambda 0.20 m vs 0.36 m. The rifle's pulse is the longer and lower of the
       two. A handgun does not read as "flat" because its pulse is long - it
       reads as flat because its shock is weaker (30-50 MPa uncorking against
       55-90 MPa) so the rise time is slower, and because it has no N-wave.

       gasAmp. Same argument: a fifth of the powder cannot make more gas-cloud
       overpressure than the rifle. 0.70 against the rifle's 0.46 had the pistol
       carrying more low end than the carbine. gasMul is raised to 6.8 purely to
       hold the gas term at ~117 Hz now that T is half what it was.

       Both gasAmps were then trimmed again after measuring the finished banks.
       A Friedlander's spectral peak scales as amp*T, so a long soft gas pulse
       beats a short hard shock on that metric long before it beats it on
       energy - at the first values here the 113/117 Hz gas cloud was the
       loudest thing in the spectrum, which put the report's peak an octave
       and a half below where every published measurement of small-arms muzzle
       blast puts it (250-700 Hz). 0.32 and 0.46 hand the peak back to the
       shock while keeping the rifle 3 dB ahead of the pistol on gas energy,
       which is the ordering that was wrong in the first place. */
    pistol: {
      len: 0.048, farLen: 0.135,
      T: 0.00020, p2: 0.28, p3: 0.15, gasMul: 6.8, gasAmp: 0.32,
      /* boreAmp down from 0.30: a 4.4" barrel puts c/2L at 1531 Hz, and at 0.30
         that single mode was measuring as the loudest thing in the whole bank -
         above the shock. A barrel ring should colour the report, not be it. */
      bore: 0.112, boreAmp: 0.19, boreTau: 0.0021, boreN: 9, stretch: 0.013, pipe: 1,
      jet: 0.0055, jetF: 4200, jetQ: 0.75, jetAmp: 0.085,
      gb: 0.22, gbT: 0.0011, gbF: 3600, gbSign: 1,
      farT: 5.0, farGb: 0.30, farGbT: 0.0062, farRes: 240
    },
    /* 5.56x45 carbine. This entry used to be written as "the pistol but faster
       and further up", with T SHORTER than the pistol's on the reasoning that a
       steeper shock means a shorter pulse. Those are two different quantities.
       Shock steepness is the RISE time (a few microseconds free-field, and the
       reason instrumentation for this work is specified at <20 us); T is the
       positive-phase DURATION, which is set by the energy released, and a 5.56
       releases about five times the pistol's. Measured A-durations for an
       unsuppressed .223 come in under 0.2 ms at the muzzle mic, and the blast
       spectral peak measured at 3.67 m sits near 650 Hz, with one-third-octave
       maxima for rifle muzzle blast reported down in the 250-315 Hz bands.
       T = 0.36 ms puts f = 1/(2*pi*T) at 442 Hz, between those, and correctly
       BELOW the pistol's 796 Hz.

       gasAmp 0.66 restores the ordering: 1.69 g of powder makes a bigger gas
       cloud than 0.35 g does. gasMul 3.9 holds the gas overpressure at
       T*3.9 = 1.40 ms -> ~113 Hz, the same brief chest thump as before.

       bore 0.368 m is a 14.5" barrel. With pipe:1 it is now treated as the
       closed-open tube it physically is during firing - breech shut, muzzle
       open - so only odd modes are excited. c/2L = 466 Hz reads as the first
       quarter-wave mode of a 0.368 m tube at the ~700 m/s sound speed of the
       propellant gas actually in it, which is why the number was right by
       accident; the even harmonics at 932 and 1864 Hz were never there. */
    rifle: {
      len: 0.058, farLen: 0.145,
      T: 0.00036, p2: 0.26, p3: 0.14, gasMul: 3.9, gasAmp: 0.46,
      bore: 0.368, boreAmp: 0.30, boreTau: 0.0026, boreN: 11, stretch: 0.018, pipe: 1,
      jet: 0.0070, jetF: 4700, jetQ: 0.72, jetAmp: 0.112,
      /* gbT down from 1.2 to 0.6 ms, and it has to move now that the sign has
         flipped. An in-phase reflection combs at (k+1/2)/tau, not k/tau, so at
         1.2 ms the first notch would have swept 260-694 Hz - straight across
         the new 442 Hz blast peak AND the 466 Hz barrel fundamental. 0.6 ms is
         a 0.2 m path, which is honestly what the near reflector is (optic,
         rail, your own chest), and it puts the notch at 521-1389 Hz where
         there is now nothing to damage: the even barrel modes that used to
         live there have been removed by pipe:1. The blast peak and the
         fundamental sit in the constructive lobe at DC instead, which is what
         a rigid surface a hand's width away actually does to them. */
      gb: 0.23, gbT: 0.0006, gbF: 3400, gbSign: 1,
      farT: 2.25, farGb: 0.31, farGbT: 0.0068, farRes: 275
    },
    chain: {
      len: 0.052, farLen: 0.150,
      T: 0.00055, p2: 0.30, p3: 0.17, gasMul: 3.8, gasAmp: 0.78,
      bore: 0.420, boreAmp: 0.34, boreTau: 0.0030, boreN: 8, stretch: 0.010,
      jet: 0.0075, jetF: 3400, jetQ: 0.8, jetAmp: 0.095,
      gb: 0.24, gbT: 0.0014, gbF: 3200,
      farT: 2.6, farGb: 0.32, farGbT: 0.0072, farRes: 205
    },
    shotgun: {
      len: 0.090, farLen: 0.210,
      T: 0.00120, p2: 0.32, p3: 0.18, gasMul: 3.2, gasAmp: 0.86,
      bore: 0.510, boreAmp: 0.38, boreTau: 0.0055, boreN: 8, stretch: 0.008,
      jet: 0.016, jetF: 2400, jetQ: 0.7, jetAmp: 0.115,
      gb: 0.26, gbT: 0.0021, gbF: 2600,
      farT: 2.4, farGb: 0.34, farGbT: 0.0088, farRes: 165
    },
    rpg: {
      len: 0.170, farLen: 0.280,
      T: 0.00300, p2: 0.34, p3: 0.20, gasMul: 2.8, gasAmp: 0.90,
      bore: 0.950, boreAmp: 0.46, boreTau: 0.0130, boreN: 7, stretch: 0.006,
      jet: 0.045, jetF: 1500, jetQ: 0.6, jetAmp: 0.150,
      gb: 0.24, gbT: 0.0032, gbF: 1800,
      farT: 2.2, farGb: 0.32, farGbT: 0.0110, farRes: 130
    },
    boom: {
      len: 0.240, farLen: 0.420,
      T: 0.00480, p2: 0.36, p3: 0.22, gasMul: 3.0, gasAmp: 0.95,
      bore: 0, boreAmp: 0, boreTau: 0.01, boreN: 0, stretch: 0,
      jet: 0.075, jetF: 900, jetQ: 0.5, jetAmp: 0.175,
      gb: 0.28, gbT: 0.0052, gbF: 1200,
      farT: 2.0, farGb: 0.34, farGbT: 0.0165, farRes: 95
    }
  };

  function genBlast(name, far, seed) {
    var S = GUN[name] || GUN.pistol;
    var r = mulberry(seed);
    var len = far ? S.farLen : S.len;
    var n = Math.max(64, Math.ceil(SR * len));
    var d = new Float32Array(n);

    /* ---- 1. Friedlander pulse train.
       One shock front, two small reflected pulses off the muzzle device, and
       a much longer gas-cloud overpressure underneath. The reflected pulses
       are deliberately SMALL and opposite in sign: two opposite-polarity
       pulses a fraction of a millisecond apart act as a differentiator and
       will strip the bass out of the report if you let them get large. That
       is the classic failure mode of synthesised gunfire - all snap, no
       weight - and it is exactly what the band-balance numbers catch. ---- */
    var T = S.T * (far ? S.farT : 1) * (0.82 + r() * 0.40);
    addFriedlander(d, 0, T, 1, SR);
    addFriedlander(d, Math.round(T * SR * (0.26 + r() * 0.40)),
      T * (1.2 + r() * 0.9), -S.p2 * (0.55 + r() * 0.95), SR);
    addFriedlander(d, Math.round(T * SR * (0.9 + r() * 1.3)),
      T * (1.8 + r() * 1.5), S.p3 * (r() < 0.3 ? -1 : 1) * (0.5 + r() * 1.1), SR);
    addFriedlander(d, Math.round(T * SR * (0.18 + r() * 0.42)),
      T * S.gasMul * (0.74 + r() * 0.58), S.gasAmp * (0.72 + r() * 0.52), SR);
    /* one or two extra vents at random. Chamber pressure does not release
       identically twice, and this is the cheapest place to buy variation that
       survives being heard twelve times a second. */
    var extraP = 1 + ((r() * 2) | 0);
    for (var xp = 0; xp < extraP; xp++) {
      addFriedlander(d, Math.round(T * SR * (0.4 + r() * 2.4)),
        T * (0.7 + r() * 2.6), (r() < 0.5 ? -1 : 1) * (0.06 + r() * 0.22), SR);
    }

    /* ---- 2. barrel modes.
       A barrel at the instant of uncorking is a CLOSED-OPEN pipe: the breech is
       shut by a locked bolt and a chambered case, the muzzle is open. That
       geometry supports odd multiples of the quarter-wave only - there is no
       mode with a pressure node at the breech, because the breech cannot move.
       An open-open pipe (both ends free) is what the integer series n*c/2L
       describes, and it is the wrong instrument: it puts strong partials at 932
       and 1864 Hz for the carbine, and 3062 and 6124 Hz for the pistol, that no
       real barrel produces. Guns with `pipe` set skip the even members.
       The pitch centre is left alone. ---- */
    if (S.bore > 0 && !far) {
      var f0 = C_AIR / (2 * S.bore);
      var odd = S.pipe === 1;
      /* the tube is fixed but which modes get excited is not: gas flow,
         fouling and where the bullet is when the gas catches it all move it.
         Dropping a mode at random is the cheapest real decorrelation there
         is, and unlike a time shift it changes the actual timbre. */
      var tauJ = 0.62 + r() * 0.76, stretchJ = S.stretch * (0.5 + r() * 1.3);
      for (var m = 1; m <= S.boreN; m++) {
        if (odd && (m % 2) === 0) continue;
        var fm = f0 * m * (1 + stretchJ * m);
        if (fm > SR * 0.44) break;
        if (m > 2 && r() < 0.28) continue;
        addMode(d, Math.round(T * SR * (0.15 + r() * 0.4)), fm * (0.985 + r() * 0.03),
          S.boreTau * tauJ / Math.pow(m, 0.65),
          S.boreAmp / Math.pow(m, 1.15) * (0.45 + r() * 1.1),
          r() * 6.283, SR);
      }
    } else if (S.bore > 0) {
      /* at range only the first couple of modes survive - the rest is
         air-absorbed. The odd-only rule applies here too: a barrel does not
         change boundary condition with distance, and leaving m=2 in was
         synthesising a 932 Hz mode for the carbine that the near bank had just
         been corrected to remove. */
      var ff = C_AIR / (2 * S.bore);
      var oddF = S.pipe === 1;
      for (var m2 = 1; m2 <= (oddF ? 3 : 2); m2++) {
        if (oddF && (m2 % 2) === 0) continue;
        addMode(d, Math.round(T * SR * 0.4), ff * m2 * (1 + S.stretch * m2),
          S.boreTau * 1.6 / m2, S.boreAmp * 0.45 / m2, r() * 6.283, SR);
      }
    }

    /* ---- 3. turbulent gas jet: broadband, band-limited, fast-rise/slow-fall.
       This is the "hiss" that sits on top of the thump. ---- */
    if (S.jetAmp > 0) {
      var jn = new Float32Array(n);
      var jt = (far ? S.jet * 2.4 : S.jet) * (0.7 + r() * 0.6);
      var jf = (far ? S.jetF * 0.34 : S.jetF) * (0.68 + r() * 0.66);
      var sR = Math.exp(-1 / (0.00016 * SR)), sF = Math.exp(-1 / (jt * SR));
      var eR = 1, eF = 1;
      for (var i = 0; i < n; i++) {
        jn[i] = (r() * 2 - 1) * (1 - eR) * eF;
        eR *= sR; eF *= sF;
      }
      bqRun(jn, bqCoef('bandpass', jf, S.jetQ, SR, 0), 0, n);
      /* level relative to the pulse train, which is normalised to peak 1.
         Push this up and the report turns into a hiss - the band-balance
         readout goes 60/40 the wrong way long before the ear complains. */
      var ja = S.jetAmp * (far ? 0.45 : 1);
      for (var i2 = 0; i2 < n; i2++) d[i2] += jn[i2] * ja * 3.2;
    }

    /* ---- 4. ground / body bounce. A delayed, darkened copy. The comb this
       puts in the low-mid is the single most recognisable "recorded outdoors"
       fingerprint there is.

       POLARITY. It matters which sign this gets, and the two cases are not the
       same. A wave striking a rigid surface at near-normal incidence reflects
       IN PHASE (pressure doubles at the boundary); a wave striking soft ground
       at grazing incidence reflects INVERTED. The near delay here is 1.1-1.2 ms
       = a 0.4 m path difference, which is not the ground at all - it is the
       shooter's own chest, optic and rail, hard surfaces a hand's width away,
       and those come back positive. Subtracting them was notching the spectrum
       at k/gbT: 520-1390 Hz and multiples, landing squarely on the barrel modes
       and hollowing out the body band. That is the exact "two opposite-polarity
       pulses act as a differentiator and strip the bass out" failure the
       comment 75 lines above warns about. The far bounce IS the ground, at
       grazing incidence, and keeps its inversion. ---- */
    var gbT = far ? S.farGbT : S.gbT;
    var gbA = (far ? S.farGb : S.gb) * (0.7 + r() * 0.6);
    var gbS = far ? -1 : (S.gbSign === 1 ? 1 : -1);
    var gi = Math.round(gbT * (0.6 + r() * 1.0) * SR);
    if (gi > 0 && gi < n - 4) {
      var cp = new Float32Array(n);
      for (var i3 = 0; i3 + gi < n; i3++) cp[i3 + gi] = d[i3];
      bqRun(cp, bqCoef('lowpass', S.gbF, 0.62, SR, 0), 0, n);
      for (var i4 = 0; i4 < n; i4++) d[i4] += cp[i4] * gbA * gbS;
    }

    /* ---- 5. far rendering: the shock front smears with propagation
       (rise time grows roughly as d^0.25), the top octave is gone, and a
       low-mid channel resonance takes over. That is why a rifle at 40 m is a
       different SOUND, not the same sound quieter. ---- */
    if (far) {
      bqRun(d, bqCoef('lowpass', 2600, 0.72, SR, 0), 0, n);
      bqRun(d, bqCoef('lowpass', 4200, 0.6, SR, 0), 0, n);
      bqRun(d, bqCoef('peaking', S.farRes, 1.15, SR, 6.5), 0, n);
      bqRun(d, bqCoef('highpass', 62, 0.7, SR, 0), 0, n);
    } else {
      bqRun(d, bqCoef('highpass', 46, 0.65, SR, 0), 0, n);
    }

    dcTrim(d, SR, 26);
    fadeTail(d, Math.min(n >> 2, Math.round(SR * 0.006)));
    normalise(d, 0.985);

    var buf = ctx.createBuffer(1, n, SR);
    buf.getChannelData(0).set(d);
    return buf;
  }

  /* The supersonic crack. This is the layer that makes a gun sound dangerous
     rather than loud: an N-wave a few hundred microseconds long, which puts
     its spectral peak up around 3-6 kHz with a hard 1/f skirt either side. */
  function genCrack(seed, wide) {
    var r = mulberry(seed);
    var n = Math.ceil(SR * 0.006);
    var d = new Float32Array(n);
    /* N-wave duration scales with miss distance (~d^0.25), so across a bank it
       has to span the whole plausible range or every crack sounds the same. */
    /* an N-wave of duration T peaks near 1/T, so 0.14-0.40 ms puts the crack
       between 2.5 and 7 kHz - bright and dangerous, not a hi-hat */
    var T = (wide ? 0.00034 : 0.00018) * (0.78 + r() * 1.3);
    addNWave(d, 1 + ((r() * 3) | 0), T, 1, SR, 1 + ((r() * 2) | 0));

    /* Secondary shocks: the same cone bouncing off whatever is close by and
       coming back a fraction of a millisecond later, sometimes inverted. This
       is real, and it is most of what makes one crack differ from the next. */
    var sec = (r() * 3) | 0;
    for (var s = 0; s < sec; s++) {
      var st = 0.00012 + r() * 0.0012;
      addNWave(d, Math.round(st * SR), T * (0.65 + r() * 1.0),
        (r() < 0.5 ? -1 : 1) * (0.20 + r() * 0.40), SR, 1 + ((r() * 3) | 0));
    }

    /* turbulent wake behind the shock: short, bright, irregular */
    var wamp = 0.09 + r() * 0.28, wtau = SR * (0.00028 + r() * 0.00120);
    var wn = Math.ceil(SR * 0.004), i0 = 2 + Math.ceil(T * SR);
    for (var i = 0; i < wn && i0 + i < n; i++) {
      d[i0 + i] += (r() * 2 - 1) * wamp * Math.exp(-i / wtau);
    }

    /* two or three very tight resonances give the crack a pitch centre so it
       does not read as a bare tick */
    var modes = 2 + ((r() * 2) | 0);
    for (var m = 0; m < modes; m++) {
      addMode(d, 1 + ((r() * 4) | 0), 2100 + r() * 6800,
        0.00035 + r() * 0.00110, 0.07 + r() * 0.15, r() * 6.283, SR);
    }
    bqRun(d, bqCoef('highpass', 280 + r() * 480, 0.7, SR, 0), 0, n);
    fadeTail(d, 48);
    normalise(d, 0.98);
    var buf = ctx.createBuffer(1, n, SR);
    buf.getChannelData(0).set(d);
    return buf;
  }

  /* =======================================================================
     7b. footstep grain banks
     A footstep is not a filtered noise burst: it is a few dozen to a few
     hundred tiny collisions, each a damped mode, spread over 5-60 ms with a
     surface-specific frequency and damping distribution. Generating it that
     way is the whole reason concrete, grating and gravel come out different.
     ==================================================================== */
  var FOOTSPEC = {
    concrete: { len: 0.16, grains: 26, spread: 0.011, timeSkew: 1.7, f0: 420, f1: 3400,
                tau0: 0.0012, tau1: 0.010, ampSkew: 1.5, fade: 0.6, hiss: 0.16, hissF: 2100, hissD: 0.030, hissQ: 0.9 },
    tile:     { len: 0.20, grains: 22, spread: 0.007, timeSkew: 2.2, f0: 1300, f1: 6200,
                tau0: 0.0025, tau1: 0.030, ampSkew: 1.3, fade: 0.5, hiss: 0.20, hissF: 4200, hissD: 0.016, hissQ: 0.8,
                ring: [[2450, 0.055, 0.16], [3720, 0.042, 0.10]] },
    wood:     { len: 0.20, grains: 20, spread: 0.010, timeSkew: 1.6, f0: 190, f1: 1600,
                tau0: 0.0035, tau1: 0.035, ampSkew: 1.4, fade: 0.6, hiss: 0.12, hissF: 1300, hissD: 0.025, hissQ: 0.9,
                ring: [[131, 0.075, 0.34], [214, 0.055, 0.18], [388, 0.030, 0.10]] },
    metal:    { len: 0.30, grains: 16, spread: 0.006, timeSkew: 2.4, f0: 300, f1: 3800,
                tau0: 0.012, tau1: 0.085, ampSkew: 1.2, fade: 0.4, hiss: 0.10, hissF: 3000, hissD: 0.012, hissQ: 1.1,
                ring: [[418, 0.090, 0.40], [712, 0.070, 0.24], [1163, 0.055, 0.15], [1907, 0.040, 0.09]] },
    grate:    { len: 0.30, grains: 18, spread: 0.008, timeSkew: 2.0, f0: 500, f1: 5200,
                tau0: 0.008, tau1: 0.060, ampSkew: 1.3, fade: 0.4, hiss: 0.14, hissF: 3600, hissD: 0.014, hissQ: 1.0,
                ring: [[622, 0.070, 0.34], [1043, 0.055, 0.22], [1741, 0.040, 0.14], [2820, 0.028, 0.08]],
                rattle: { n: 9, t0: 0.028, t1: 0.190, f0: 900, f1: 4200, tau: 0.020, amp: 0.26 } },
    carpet:   { len: 0.10, grains: 10, spread: 0.013, timeSkew: 1.2, f0: 140, f1: 800,
                tau0: 0.0025, tau1: 0.012, ampSkew: 2.2, fade: 0.8, hiss: 0.30, hissF: 620, hissD: 0.038, hissQ: 0.6 },
    gravel:   { len: 0.22, grains: 110, spread: 0.045, timeSkew: 1.5, f0: 1200, f1: 8200,
                tau0: 0.0004, tau1: 0.0035, ampSkew: 2.6, fade: 0.75, hiss: 0.22, hissF: 3400, hissD: 0.055, hissQ: 0.6 },
    dirt:     { len: 0.18, grains: 55, spread: 0.030, timeSkew: 1.6, f0: 260, f1: 2400,
                tau0: 0.0006, tau1: 0.0050, ampSkew: 2.4, fade: 0.8, hiss: 0.26, hissF: 900, hissD: 0.045, hissQ: 0.6 },
    water:    { len: 0.26, grains: 70, spread: 0.055, timeSkew: 1.3, f0: 700, f1: 5200,
                tau0: 0.0008, tau1: 0.0060, ampSkew: 2.0, fade: 0.6, hiss: 0.34, hissF: 2600, hissD: 0.080, hissQ: 0.5,
                bubbles: 14 }
  };

  function genFoot(surf, seed) {
    var S = FOOTSPEC[surf] || FOOTSPEC.concrete;
    var r = mulberry(seed);
    var n = Math.ceil(SR * S.len);
    var d = new Float32Array(n);
    var i, u;

    /* granular body */
    var lf = Math.log(S.f1 / S.f0), lt = Math.log(S.tau1 / S.tau0);
    for (i = 0; i < S.grains; i++) {
      u = Math.pow(r(), S.timeSkew);
      var i0 = Math.round(u * S.spread * SR);
      var f = S.f0 * Math.exp(lf * r());
      var tau = S.tau0 * Math.exp(lt * r());
      var a = Math.pow(r(), S.ampSkew) * (1 - u * S.fade);
      addMode(d, i0, f, tau, a, r() * 6.283, SR);
    }

    /* structural ring: the plate, the plank, the tile - a few strong,
       inharmonic modes that carry the surface identity */
    if (S.ring) {
      for (i = 0; i < S.ring.length; i++) {
        var R = S.ring[i];
        addMode(d, 0, R[0] * (0.94 + r() * 0.12), R[1] * (0.85 + r() * 0.3),
          R[2] * (0.8 + r() * 0.4), r() * 6.283, SR);
      }
    }

    /* grating rattle: the panel bouncing in its frame after the strike.
       Nothing else in a level sounds like this, so it is worth the code. */
    if (S.rattle) {
      var R2 = S.rattle;
      for (i = 0; i < R2.n; i++) {
        var tt = R2.t0 + (R2.t1 - R2.t0) * Math.pow(r(), 0.8);
        addMode(d, Math.round(tt * SR), R2.f0 + (R2.f1 - R2.f0) * r(),
          R2.tau * (0.5 + r()), R2.amp * Math.pow(r(), 1.4) * (1 - tt / R2.t1 * 0.7),
          r() * 6.283, SR);
      }
    }

    /* rising-pitch bubbles: the Van den Doel water model. A bubble's
       resonance climbs as it rises, which is the whole cue for "wet". */
    if (S.bubbles) {
      for (i = 0; i < S.bubbles; i++) {
        var bt = Math.pow(r(), 1.3) * 0.14, bi = Math.round(bt * SR);
        var bf = 700 + r() * 2600, bd = 0.006 + r() * 0.030;
        var bl = Math.min(n - bi, Math.ceil(bd * SR));
        var ba = Math.pow(r(), 1.8) * 0.28, ph = 0;
        for (var k = 0; k < bl; k++) {
          var tt2 = k / SR;
          ph += 2 * Math.PI * (bf * Math.exp(tt2 / (bd * 1.6))) / SR;
          d[bi + k] += Math.sin(ph) * ba * Math.exp(-tt2 / (bd * 0.42));
        }
      }
    }

    /* broadband scuff: sole against surface */
    if (S.hiss > 0) {
      var hn = new Float32Array(n);
      var hsF = Math.exp(-1 / (S.hissD * SR)), hsR = Math.exp(-1 / (0.0006 * SR));
      var heF = 1, heR = 1;
      for (i = 0; i < n; i++) { hn[i] = (r() * 2 - 1) * heF * (1 - heR); heF *= hsF; heR *= hsR; }
      bqRun(hn, bqCoef('bandpass', S.hissF, S.hissQ, SR, 0), 0, n);
      for (i = 0; i < n; i++) d[i] += hn[i] * S.hiss * 3.4;
    }

    dcTrim(d, SR, 34);
    fadeTail(d, Math.min(n >> 2, Math.round(SR * 0.008)));
    normalise(d, 0.96);
    var buf = ctx.createBuffer(1, n, SR);
    buf.getChannelData(0).set(d);
    return buf;
  }

  /* Small metallic object hitting a hard floor: shell casings, links, keys.
     Inharmonic modes only - a harmonic set rings like a bell. */
  function genPing(seed, base, dur, bright) {
    var r = mulberry(seed);
    var n = Math.ceil(SR * dur);
    var d = new Float32Array(n);
    var ratios = [1, 1.593, 2.135, 2.917, 3.51, 4.83];
    for (var i = 0; i < ratios.length; i++) {
      var f = base * ratios[i] * (0.96 + r() * 0.08);
      if (f > SR * 0.44) break;
      addMode(d, (r() * 3) | 0, f, (dur * 0.34) / Math.pow(i + 1, 0.8),
        (bright ? 1 : 0.8) / Math.pow(i + 1, 0.75) * (0.7 + r() * 0.6), r() * 6.283, SR);
    }
    /* contact noise: the first 200 us of any impact is broadband */
    var cn = Math.ceil(SR * 0.0012);
    for (var k = 0; k < cn; k++) d[k] += (r() * 2 - 1) * 0.55 * (1 - k / cn);
    bqRun(d, bqCoef('highpass', 320, 0.7, SR, 0), 0, n);
    fadeTail(d, 64);
    normalise(d, 0.95);
    var buf = ctx.createBuffer(1, n, SR);
    buf.getChannelData(0).set(d);
    return buf;
  }

  /* ---- bank access: everything is lazy, so boot never hitches ---- */
  var VARIANTS = { high: 5, med: 4, low: 3 };
  function nowMs() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  /* One variant is rendered synchronously so the cue that asked for it is
     never silent; the rest arrive over the next few frames. Generating a
     whole five-variant bank inside a single sfx() call is a 30-100 ms hitch
     and would be felt as a dropped frame the first time you step on grating. */
  function bank(key, make) {
    var b = BANK[key];
    if (b) return b;
    var nv = VARIANTS[TIER] || 4, out = [];
    var seed = 0;
    for (var c = 0; c < key.length; c++) seed = (seed * 131 + key.charCodeAt(c)) | 0;
    var t0 = nowMs();
    try { out.push(make(seed + 17)); } catch (e) { NZ.log('bank gen failed ' + key, e); }
    if (!out.length) { BANK[key] = out; return out; }   /* cache the failure; callers fall back */
    BANK[key] = out;
    /* sync = the only cost that can ever land inside a frame */
    genCost[key] = { sync: Math.round((nowMs() - t0) * 10) / 10, total: Math.round((nowMs() - t0) * 10) / 10, n: 1 };
    (function fill(i) {
      if (dead || i >= nv) return;
      global.setTimeout(function () {
        if (dead || BANK[key] !== out) return;
        var s0 = nowMs();
        try { out.push(make(seed + i * 7919 + 17)); } catch (e) {}
        var g = genCost[key];
        if (g) { g.total = Math.round((g.total + nowMs() - s0) * 10) / 10; g.n = out.length; }
        fill(i + 1);
      }, 45 + i * 25);
    })(1);
    return out;
  }
  function blastBank(name, far) {
    var key = 'bl_' + name + (far ? '_f' : '_n');
    return bank(key, function (s) { return genBlast(name, far, s); });
  }
  function crackBank(wide) {
    return bank(wide ? 'ck_w' : 'ck_n', function (s) { return genCrack(s, wide); });
  }
  function footBank(surf) {
    return bank('ft_' + surf, function (s) { return genFoot(surf, s); });
  }
  function pingBank(key, base, dur, bright) {
    return bank(key, function (s) { return genPing(s, base, dur, bright); });
  }
  /* one variant, never the same one twice running */
  function pickBuf(list, key) {
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    var last = lastVar[key], i;
    do { i = (Math.random() * list.length) | 0; } while (i === last);
    lastVar[key] = i;
    return list[i];
  }

  /* =======================================================================
     8. procedural impulse responses
     Early reflections come from an image-source model of a shoebox with the
     space's real dimensions, so the reflection PATTERN is a consequence of
     the geometry rather than a hand-typed list. The late tail is three
     independently-decaying bands - highs die first, which is the single most
     important thing a synthetic reverb usually gets wrong.
     ==================================================================== */
  var IRSPEC = {
    room:     { W: 9.0,  D: 12.0, H: 3.3,  refl: 0.62, rt: [0.62, 0.48, 0.29], energy: 0.85,
                pre: 0.009, spread: 0.0016, erGain: 0.44, sky: false },
    corridor: { W: 2.7,  D: 26.0, H: 2.9,  refl: 0.80, rt: [0.82, 0.66, 0.37], energy: 0.55,
                pre: 0.005, spread: 0.0009, erGain: 0.62, sky: false },
    hall:     { W: 22.0, D: 28.0, H: 9.0,  refl: 0.84, rt: [1.95, 1.52, 0.84], energy: 1.85,
                pre: 0.021, spread: 0.0032, erGain: 0.52, sky: false },
    stair:    { W: 3.4,  D: 3.6,  H: 15.0, refl: 0.86, rt: [1.65, 1.32, 0.72], energy: 1.35,
                pre: 0.010, spread: 0.0021, erGain: 0.70, sky: false },
    outdoor:  { W: 17.0, D: 52.0, H: 40.0, refl: 0.55, rt: [0.92, 0.58, 0.27], energy: 0.55,
                pre: 0.026, spread: 0.0044, erGain: 0.80, sky: true }
  };
  /* Tier scale on tail length. Convolution cost is roughly linear in IR
     length, and a 2 s stereo IR at 48 kHz is the single most expensive node
     in the graph, so this is the main CPU dial. */
  var IRLEN = { high: 0.90, med: 0.66, low: 0.42 };

  /* Image-source early reflections up to order 2. The image-source model
     supplies the PATTERN - which reflection arrives when, and how the cluster
     thins out - and `erGain` supplies the level. The gains are normalised to
     the strongest reflection first, because otherwise the level of the whole
     cluster depends on the accident of how far apart the notional source and
     listener happen to be, and a narrow stairwell (where they are almost on
     top of each other) ends up with no early field at all. */
  function imageER(S, r) {
    var tall = S.H > 8 && !S.sky;
    var lx = S.W * (0.42 + r() * 0.16), lz = S.D * (0.30 + r() * 0.12), ly = 1.7;
    var sx = S.W * (0.44 + r() * 0.14), sz = S.D * (0.62 + r() * 0.14);
    /* in a shaft the interesting source is a floor above you, not beside you */
    var sy = tall ? S.H * (0.24 + r() * 0.30) : 1.5;
    var dd = Math.sqrt((sx - lx) * (sx - lx) + (sy - ly) * (sy - ly) + (sz - lz) * (sz - lz));
    if (dd < 0.6) dd = 0.6;
    var out = [], mx = 0;
    function mirror(p, n, L) { return (n & 1) ? ((n + 1) * L - p) : (n * L + p); }
    for (var i = -2; i <= 2; i++) for (var j = -2; j <= 2; j++) for (var k = -2; k <= 2; k++) {
      var order = Math.abs(i) + Math.abs(j) + Math.abs(k);
      if (order === 0 || order > 2) continue;
      if (S.sky && k > 0) continue;                    /* no ceiling outdoors */
      var ix = mirror(sx, i, S.W), iy = mirror(sy, k, S.H), iz = mirror(sz, j, S.D);
      var dx = ix - lx, dy = iy - ly, dz = iz - lz;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var dl = (dist - dd) / C_AIR;
      if (dl < 0.0008 || dl > 0.55) continue;
      var g = Math.pow(S.refl, order) * (dd / dist);
      if (g < 0.008) continue;
      if (g > mx) mx = g;
      out.push([dl, g, dz > 0 ? 1 : -1]);
    }
    if (mx > 1e-6) for (var q = 0; q < out.length; q++) out[q][1] /= mx;
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }

  function makeIR(name) {
    var S = IRSPEC[name] || IRSPEC.room;
    var t0 = (global.performance && performance.now) ? performance.now() : 0;
    var scale = IRLEN[TIER] || 1;
    var rtMax = Math.max(S.rt[0], S.rt[1], S.rt[2]);
    var len = cl(rtMax * 1.02 * scale, 0.28, 2.2);
    var n = Math.max(512, Math.floor(SR * len));
    var buf = ctx.createBuffer(2, n, SR);
    var seedBase = 0;
    for (var c = 0; c < name.length; c++) seedBase = (seedBase * 31 + name.charCodeAt(c)) | 0;

    /* mixing time: a real tail is not fully diffuse from sample zero.
       t_mix ~ sqrt(V) ms is the standard estimate. */
    var V = S.W * S.D * S.H;
    var tmix = cl(Math.sqrt(V) * 0.001, 0.006, 0.09);
    var diffuse = S.sky ? 0.34 : 1.0;    /* a street has almost no diffuse field */

    var wn = new Float32Array(n), tmp = new Float32Array(n);
    var i;

    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var r = mulberry(seedBase + ch * 7919 + 13);
      var er = imageER(S, mulberry(seedBase + ch * 104729 + 5));
      /* nothing at all arrives before the first reflection does */
      var t0d = er.length ? er[0][0] : 0.004;
      for (i = 0; i < n; i++) { wn[i] = r() * 2 - 1; d[i] = 0; }

      /* --- three-band late tail. Bands are LP(340) / BP / HP(3200) and each
         gets its own RT60, so the tail progressively darkens exactly the way
         air and absorbent surfaces make it. --- */
      var bands = [
        ['lowpass', 340, 0.7, S.rt[0], 0.95, 0],
        ['bandpass', 1100, 0.55, S.rt[1], 1.00, 0],
        ['highpass', 3200, 0.7, S.rt[2], 0.62, 0]
      ];
      for (var bi = 0; bi < 3; bi++) {
        var B = bands[bi];
        var co = bqCoef(B[0], B[1], B[2], SR, 0);
        /* filter a fresh copy, envelope it, accumulate */
        tmp.set(wn);
        bqRun(tmp, co, 0, n);
        /* second pass: 4th-order skirts. Worth the cost - with one pass the
           bands bleed into each other and the measured high-band RT60 comes
           out nearly as long as the low, i.e. the frequency-dependent decay
           that this whole three-band structure exists for stops working. */
        bqRun(tmp, co, 0, n);
        /* recursive decay: one multiply a sample instead of a Math.exp.
           A 2 s stereo hall IR is 190k samples times three bands, and
           570k transcendental calls is the difference between a 60 ms
           generation and a quarter-second freeze. */
        var k60 = 6.9078 / Math.max(0.05, B[3]);
        var stepE = Math.exp(-k60 / SR), envE = B[4];
        for (i = 0; i < n; i++) { d[i] += tmp[i] * envE; envE *= stepE; }
      }
      /* Density build-up. The diffuse field cannot exist before the first
         reflection has arrived and it does not reach full density until the
         mixing time, so the ramp is delayed AND steep. Get this wrong and the
         early reflections drown in diffuse noise, which is precisely what
         makes a synthetic reverb sound like a reverb rather than a room. */
      var i0d = Math.min(n, Math.floor(t0d * SR));
      var bm = Math.min(n - i0d, Math.ceil(tmix * SR));
      for (i = 0; i < i0d; i++) d[i] = 0;
      for (i = 0; i < bm; i++) {
        var u = i / bm, ss = u * u * (3 - 2 * u);
        d[i0d + i] *= ss * ss;
      }
      for (i = 0; i < n; i++) d[i] *= diffuse;

      /* --- early reflections from the image-source model. Each is a short
         filtered burst, not a bare spike: a single-sample impulse convolves
         as a bright click and gives the synthesis away immediately. --- */
      for (var e = 0; e < er.length; e++) {
        var et = er[e][0] + (ch ? S.spread * (1 + e * 0.3) : 0) + (r() - 0.5) * 0.0018;
        var ai = Math.floor(et * SR);
        if (ai < 1 || ai >= n - 200) continue;
        var g = er[e][1] * S.erGain * (0.8 + r() * 0.4) * (ch ? er[e][2] : 1);
        var blen = 70 + ((r() * 220) | 0);
        var bl = 0, dk = 0.16 + r() * 0.48;
        for (var kk = 0; kk < blen && ai + kk < n; kk++) {
          bl += dk * ((r() * 2 - 1) - bl);
          d[ai + kk] += bl * g * Math.pow(1 - kk / blen, 2.1) * 1.5;
        }
      }
      dcTrim(d, SR, 32);
      fadeTail(d, Math.min(n >> 3, Math.round(SR * 0.05)));
    }

    /* Energy normalise so the wet level is predictable per space.
       This must use the L2 norm, NOT the RMS. Convolution gain scales with the
       IR's L2 norm; RMS additionally divides by length, so a long sparse tail
       reports a tiny RMS and gets scaled up enormously - then hard-clipped
       into a distorted roar. With the L2 norm the wet gain is independent of
       IR length, which is what `energy` is meant to express. */
    var sum = 0, L = buf.getChannelData(0), R2 = buf.getChannelData(1), j;
    for (j = 0; j < n; j++) sum += L[j] * L[j] + R2[j] * R2[j];
    var norm = Math.sqrt(sum);
    var k2 = norm > 1e-9 ? (S.energy * IRTRIM) / norm : 1;
    if (!isNum(k2)) k2 = 1;
    var clipped = 0, a2, b2;
    for (j = 0; j < n; j++) {
      a2 = L[j] * k2; b2 = R2[j] * k2;
      if (a2 > 1 || a2 < -1 || b2 > 1 || b2 < -1) clipped++;
      L[j] = cl(a2, -1, 1); R2[j] = cl(b2, -1, 1);
    }
    if (clipped) console.warn('[nz-audio] IR "' + name + '" clipped ' + clipped +
      ' of ' + n + ' samples - lower NZ.audio.setIrTrim()');

    irRT[name] = { len: +len.toFixed(3), design: S.rt,
                   ms: Math.round(((global.performance && performance.now) ? performance.now() : 0) - t0) };
    return buf;
  }

  function getIR(name) {
    if (IR[name]) return IR[name];
    try { IR[name] = makeIR(name); } catch (e) { NZ.log('IR gen failed ' + name, e); IR[name] = null; }
    return IR[name];
  }
  /* Generating a 1.8 s stereo hall IR is tens of milliseconds of straight-line
     float work, so it goes on the idle queue where the browser offers one.
     Only the default room is built synchronously, and only because something
     has to be in the convolver before the first cue plays. */
  function idle(fn) {
    if (global.requestIdleCallback) { try { global.requestIdleCallback(fn, { timeout: 900 }); return; } catch (e) {} }
    global.setTimeout(fn, 45);
  }
  function primeIRs() {
    getIR('room');
    var i = 0;
    (function next() {
      while (i < IRQ.length && IR[IRQ[i]]) i++;
      if (i >= IRQ.length || dead) return;
      getIR(IRQ[i]); i++;
      idle(next);
    })();
  }

  /* =======================================================================
     9. the mix bus
        layers -> spatial chain -> category bus -> [duck] -> glue -> dmgLP
                                                                 -> AU.master

        The duck is deliberately NOT a flat gain. Gunfire pushes the low-mid
        down hard and the presence band only a little, so an enemy footstep -
        which lives at 2-6 kHz - stays audible under sustained fire. That is
        what CS2 does and it is the reason its mix reads as disciplined
        instead of merely loud.
     ==================================================================== */
  function buildGraph() {
    var g = {};

    g.out = ctx.createGain(); g.out.gain.value = 0.92;
    g.dmgLP = ctx.createBiquadFilter(); g.dmgLP.type = 'lowpass';
    g.dmgLP.frequency.value = 20000; g.dmgLP.Q.value = 0.6;

    g.glue = ctx.createDynamicsCompressor();
    /* 3 ms attack deliberately lets the shock front THROUGH uncompressed -
       the crack is the point - and then clamps the body. 140 ms release so a
       pistol at 5 rounds/s is fully recovered between shots. */
    g.glue.threshold.value = -12; g.glue.knee.value = 9; g.glue.ratio.value = 3.2;
    g.glue.attack.value = 0.003; g.glue.release.value = 0.14;

    g.glue.connect(g.dmgLP); g.dmgLP.connect(g.out); g.out.connect(AUref.master);

    /* --- the spectrally-tilted duck --- */
    g.duckTilt = ctx.createBiquadFilter();
    g.duckTilt.type = 'lowshelf'; g.duckTilt.frequency.value = 900; g.duckTilt.gain.value = 0;
    g.duck = ctx.createGain(); g.duck.gain.value = 1;
    g.duckTilt.connect(g.duck); g.duck.connect(g.glue);

    /* footsteps get a lighter duck and a presence lift so they cut through */
    g.footEQ = ctx.createBiquadFilter();
    g.footEQ.type = 'peaking'; g.footEQ.frequency.value = 3800;
    g.footEQ.Q.value = 0.9; g.footEQ.gain.value = 2.6;
    g.footHP = ctx.createBiquadFilter();
    g.footHP.type = 'highpass'; g.footHP.frequency.value = 58; g.footHP.Q.value = 0.7;
    g.duckFoot = ctx.createGain(); g.duckFoot.gain.value = 1;
    g.footEQ.connect(g.footHP); g.footHP.connect(g.duckFoot); g.duckFoot.connect(g.glue);

    g.bus = {
      weapon: ctx.createGain(),   /* never ducked - it is the ducker */
      enemy: ctx.createGain(),
      world: ctx.createGain(),
      foot: ctx.createGain(),
      ui: ctx.createGain()
    };
    g.bus.weapon.gain.value = 1.0; g.bus.weapon.connect(g.glue);
    g.bus.enemy.gain.value = 0.98; g.bus.enemy.connect(g.duckTilt);
    g.bus.world.gain.value = 0.95; g.bus.world.connect(g.duckTilt);
    g.bus.foot.gain.value = 1.06; g.bus.foot.connect(g.footEQ);
    g.bus.ui.gain.value = 1.0; g.bus.ui.connect(g.glue);

    /* --- reverb: two convolvers, crossfaded on space change --- */
    g.revIn = ctx.createGain(); g.revIn.gain.value = 1;
    g.revPre = ctx.createDelay(0.12); g.revPre.delayTime.value = 0.012;
    g.revHP = ctx.createBiquadFilter(); g.revHP.type = 'highpass';
    g.revHP.frequency.value = 150; g.revHP.Q.value = 0.5;
    g.revLP = ctx.createBiquadFilter(); g.revLP.type = 'lowpass';
    g.revLP.frequency.value = 9000; g.revLP.Q.value = 0.6;
    g.revIn.connect(g.revPre); g.revPre.connect(g.revHP); g.revHP.connect(g.revLP);

    g.cvA = ctx.createConvolver(); g.cvA.normalize = false;
    g.cvB = ctx.createConvolver(); g.cvB.normalize = false;
    g.gA = ctx.createGain(); g.gA.gain.value = 1;
    g.gB = ctx.createGain(); g.gB.gain.value = 0;
    g.revOut = ctx.createGain(); g.revOut.gain.value = 1.0;
    g.revLP.connect(g.cvA); g.revLP.connect(g.cvB);
    g.cvA.connect(g.gA); g.cvB.connect(g.gB);
    g.gA.connect(g.revOut); g.gB.connect(g.revOut);
    g.revOut.connect(g.duckTilt);   /* tails duck with the world, as they should */
    g.active = 'A';

    /* --- ambient bed: wind outside, plant hum inside --- */
    g.bedA = ctx.createBufferSource(); g.bedA.buffer = NOISE.brown; g.bedA.loop = true;
    g.bedAF = ctx.createBiquadFilter(); g.bedAF.type = 'lowpass';
    g.bedAF.frequency.value = 300; g.bedAF.Q.value = 0.7;
    g.bedAG = ctx.createGain(); g.bedAG.gain.value = 0.0;
    g.bedA.connect(g.bedAF); g.bedAF.connect(g.bedAG); g.bedAG.connect(g.bus.world);

    g.bedB = ctx.createBufferSource(); g.bedB.buffer = NOISE.pink; g.bedB.loop = true;
    g.bedBF = ctx.createBiquadFilter(); g.bedBF.type = 'bandpass';
    g.bedBF.frequency.value = 1400; g.bedBF.Q.value = 0.55;
    g.bedBG = ctx.createGain(); g.bedBG.gain.value = 0.0;
    g.bedB.connect(g.bedBF); g.bedBF.connect(g.bedBG); g.bedBG.connect(g.bus.world);

    /* very slow cutoff drift so the bed never sits still */
    g.bedLFO = ctx.createOscillator(); g.bedLFO.frequency.value = 0.043;
    g.bedLFOG = ctx.createGain(); g.bedLFOG.gain.value = 90;
    g.bedLFO.connect(g.bedLFOG); g.bedLFOG.connect(g.bedAF.frequency);

    var t = ctx.currentTime + 0.05;
    try { g.bedA.start(t, rr(0, 1.2)); g.bedB.start(t, rr(0, 1.2)); g.bedLFO.start(t); } catch (e) {}

    /* --- chaingun sustain rig: created once, gain 0 when idle --- */
    var cg = {};
    cg.motor = ctx.createOscillator(); cg.motor.type = 'sawtooth'; cg.motor.frequency.value = 52;
    cg.motorF = ctx.createBiquadFilter(); cg.motorF.type = 'bandpass';
    cg.motorF.frequency.value = 210; cg.motorF.Q.value = 2.6;
    cg.motorG = ctx.createGain(); cg.motorG.gain.value = 0;
    cg.motor.connect(cg.motorF); cg.motorF.connect(cg.motorG);

    cg.whine = ctx.createOscillator(); cg.whine.type = 'sawtooth';
    cg.whine.frequency.value = 168; cg.whine.detune.value = 9;
    cg.whineF = ctx.createBiquadFilter(); cg.whineF.type = 'bandpass';
    cg.whineF.frequency.value = 1250; cg.whineF.Q.value = 5.5;
    cg.whineG = ctx.createGain(); cg.whineG.gain.value = 0;
    cg.whine.connect(cg.whineF); cg.whineF.connect(cg.whineG);

    cg.bed = ctx.createBufferSource(); cg.bed.buffer = NOISE.brown; cg.bed.loop = true;
    cg.bedF = ctx.createBiquadFilter(); cg.bedF.type = 'lowpass';
    cg.bedF.frequency.value = 620; cg.bedF.Q.value = 0.8;
    cg.bedG = ctx.createGain(); cg.bedG.gain.value = 0;
    cg.bed.connect(cg.bedF); cg.bedF.connect(cg.bedG);

    cg.sum = ctx.createGain(); cg.sum.gain.value = 1;
    cg.motorG.connect(cg.sum); cg.whineG.connect(cg.sum); cg.bedG.connect(cg.sum);
    var sp = getStereo(0.1);
    if (sp) { cg.sum.connect(sp); sp.connect(g.bus.weapon); cg.pan = sp; }
    else cg.sum.connect(g.bus.weapon);
    /* the sustain gets its own small reverb send so bursts bloom in a hall */
    cg.send = ctx.createGain(); cg.send.gain.value = 0.06;
    cg.sum.connect(cg.send); cg.send.connect(g.revIn);
    try { cg.motor.start(t); cg.whine.start(t); cg.bed.start(t, rr(0, 1.0)); } catch (e) {}
    chain.nodes = cg;

    return g;
  }

  /* =======================================================================
     10. voice accounting
     ==================================================================== */
  function purge() {
    var now = ctx.currentTime, n = 0;
    for (var i = 0; i < live.length; i++) {
      var v = live[i];
      if (!v.done && v.end > now) live[n++] = v;
    }
    live.length = n;
  }
  function steal() {
    /* kill the least important thing playing: lowest priority first, and among
       equals whichever has the least remaining life (least disruptive). */
    var now = ctx.currentTime, best = -1, bestScore = Infinity;
    for (var i = 0; i < live.length; i++) {
      var v = live[i];
      var sc = v.pri * 1000 + (v.end - now) * 10;
      if (sc < bestScore) { bestScore = sc; best = i; }
    }
    if (best < 0) return false;
    var vv = live[best];
    steals++;
    var pk = 'p' + (vv.pri | 0);
    stolenPri[pk] = (stolenPri[pk] || 0) + 1;
    var t = now + 0.001;
    try { pHold(vv.gain.gain, t); pLin(vv.gain.gain, EPS, t + 0.014); } catch (e) {}
    try { vv.src.stop(t + 0.02); } catch (e) {}
    vv.end = t + 0.02;
    /* MUST be flagged done, not merely given a near end time: purge() keeps
       anything whose end is still in the future, so without this the pool
       creeps past CAP under sustained fire instead of holding at it. */
    vv.done = true;
    return true;
  }
  function track(src, gain, end, pri) {
    purge();
    if (live.length >= CAP) {
      var guard = 0;
      while (live.length >= CAP && guard++ < 8) { if (!steal()) break; purge(); }
      if (live.length >= CAP) { deniedVoices++; return false; }
    }
    var v = { src: src, gain: gain, end: fin(end, ctx.currentTime + 0.2), pri: fin(pri, 2), done: false };
    live.push(v);
    if (live.length > peakVoices) peakVoices = live.length;
    return v;
  }

  /* =======================================================================
     11. spatial chain (one per cue, not per layer)

        in -> [air/back shelf] -> [distance LPF] -> [dry -> panner -> bus]
                                                  + [wet -> reverb in]

        Propagation delay is applied by the SCHEDULER, not a DelayNode. That
        costs a node less and - much more importantly - it lets one cue put
        its ballistic crack at t=0 while its muzzle blast arrives dist/c
        later. A gun 40 m away should go crack ... thump, and that gap is the
        most recognisable thing about CS2's long-range gunfire.
     ==================================================================== */
  var busesThisCue = [];
  var hrtfLive = 0;             /* concurrent HRTF panners, hard-budgeted */

  function occlusionAt(x, z, sy) {
    var w = world();
    var res = { clear: true, thick: 0, px: x, pz: z, extra: 0 };
    if (!w || !w.losClear) return res;
    var cs = w.CELL;
    var key = (Math.floor(w.player.x / cs) * 97 + Math.floor(w.player.z / cs)) * 8191 +
              (Math.floor(x / cs) * 97 + Math.floor(z / cs));
    var now = ctx.currentTime, c = occCache.get(key);
    if (c && now - c.t < 0.22) return c.v;

    var lx = fin(w.player.x, 0), ly = fin(w.player.y, 0) + w.EYE, lz = fin(w.player.z, 0);
    var clear = true;
    try { clear = !!w.losClear(lx, ly, lz, x, sy, z); } catch (e) { clear = true; }
    res.clear = clear;

    if (!clear) {
      /* How much wall is in the way. This must be the ABSOLUTE thickness in
         metres, not the fraction of the path that is solid: the same 0.6 m
         partition is the same partition whether the shooter is 5 m or 40 m
         behind it, and a fractional measure makes distant sources sound
         progressively less occluded, which is backwards. */
      var dx = x - lx, dy = sy - ly, dz = z - lz;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var steps = Math.max(6, Math.min(120, Math.ceil(dist / 0.55)));
      var stepM = (dist / steps) * METERS_PER_UNIT;
      var solid = 0;
      if (w.blocked) {
        for (var i = 1; i < steps; i++) {
          var u = i / steps;
          try { if (w.blocked(lx + dx * u, ly + dy * u, lz + dz * u)) solid++; } catch (e) {}
        }
      } else solid = 2;
      /* half a metre of masonry is total occlusion; LOS was blocked at all, so
         there is always at least a partition even if the march undersampled it */
      res.thick = cl((solid * stepM) / 0.5, 0.3, 1);

      /* --- diffraction: find the corner the sound actually comes around.
         Sound that reaches you through a doorway arrives FROM THE DOORWAY, and
         re-panning it there is the difference between "muffled somewhere" and
         "he is coming down the left corridor". --- */
      var budgetOK = (now - portalLast) > 0.02 && portalBudget > 0;
      if (budgetOK && dist < 90) {
        portalBudget -= 1; portalLast = now;
        /* Three rings. A doorway you are standing in is one cell away; a
           doorway across the room is three or four. A single ring at 1.3
           cells only ever finds a corner you are already touching, which in
           practice means the diffraction path is never found at all and
           everything behind a wall stays glued to the wall. */
        var found = false, bestLen = 1e9;
        var rad = [cs * 1.3, cs * 2.7, cs * 4.4];
        var ri, a, ang, px, pz, l1, l2, ok;
        for (ri = 0; ri < rad.length; ri++) {
          var R = rad[ri];
          if (R > dist * 0.85) break;
          for (a = 0; a < 8; a++) {
            ang = a * Math.PI / 4 + 0.19 + ri * 0.39;
            px = lx + Math.cos(ang) * R; pz = lz + Math.sin(ang) * R;
            ok = false;
            try { ok = !!w.losClear(lx, ly, lz, px, ly, pz) && !!w.losClear(px, ly, pz, x, sy, z); } catch (e) { ok = false; }
            if (!ok) continue;
            l1 = Math.sqrt((px - lx) * (px - lx) + (pz - lz) * (pz - lz));
            l2 = Math.sqrt((x - px) * (x - px) + (sy - ly) * (sy - ly) + (z - pz) * (z - pz));
            if (l1 + l2 < bestLen) { bestLen = l1 + l2; res.px = px; res.pz = pz; found = true; }
          }
          if (found) break;               /* the nearest ring wins: shortest path */
        }
        if (found) {
          /* It bent round a corner, it did not push through a wall: far less
             low-passed, delayed by the extra path length, and localised AT
             the corner rather than at the wall in front of you. */
          res.thick = Math.min(res.thick, 0.34);
          res.extra = cl((bestLen - dist) * METERS_PER_UNIT / C_AIR, 0, 0.08);
          res.portal = true;
        }
      }
    }
    occCache.set(key, { t: now, v: res });
    if (occCache.size > 200) occCache.clear();
    return res;
  }

  function newBus(x, z, o) {
    o = o || {};
    var w = world();
    var cat = G.bus[o.cat || 'world'] || G.bus.world;
    var b = {
      inp: getGain(1), nodes: [], released: false,
      maxEnd: ctx.currentTime + 0.05, dist: 0, dm: 0, prop: 0,
      self: true, ownShot: false, firstPerson: true,
      occluded: false, near: 1, far: 0, cat: o.cat || 'world', shotGain: 1
    };
    var positional = isNum(x) && isNum(z) && w;

    if (!positional) {
      /* Non-positional: player-attached, UI. Still gets a modest send so the
         player's own footsteps and pickups live in the same room. */
      var head = b.inp;
      if (isNum(o.pan) && ctx.createStereoPanner) {
        var sp = getStereo(o.pan); if (sp) { head.connect(sp); sp.connect(cat); b.nodes.push(['sp', sp]); }
        else head.connect(cat);
      } else head.connect(cat);
      var wg0 = getGain(cl((o.wet === undefined ? 0.10 : o.wet) * space.wet * 3.2, 0, 2));
      b.inp.connect(wg0); wg0.connect(G.revIn);
      b.nodes.push(['g', wg0]);
      busesThisCue.push(b);
      return b;
    }

    var dx = fin(x, 0) - fin(w.player.x, 0), dz = fin(z, 0) - fin(w.player.z, 0);
    var sy = emitterY(x, z);
    var dy = sy - (fin(w.player.y, 0) + w.EYE);
    var dist = cl(Math.sqrt(dx * dx + dy * dy + dz * dz), 0, 4000);
    b.dist = dist;
    b.dm = dist * METERS_PER_UNIT;
    /* Player fire passes the player's exact x/z. Use that ownership signal
       for firearm cues instead of requiring the legacy emitter height to sit
       within two 3D units of the newly taller player's ear. The tight planar
       threshold cannot mistake a nearby enemy for the shooter, and no other
       sound category changes its positioning or level. */
    var planar = Math.sqrt(dx * dx + dz * dz);
    b.self = dist < 2.0;
    b.ownShot = !!(o.shot && planar < 0.5);
    b.firstPerson = b.self || b.ownShot;
    if (o.shot) b.shotGain = GUNSHOT_GAIN * (b.firstPerson ? PLAYER_GUNSHOT_GAIN : 1);
    /* the two renderings and their crossfade. 8..34 units is 3.6..15 m. */
    b.near = 1 - smoothstep(9, 40, dist);
    b.far = smoothstep(16, 62, dist);

    /* --- distance gain. Inverse-ish with a soft far cut. Weapons roll off a
           little slower than the physics because distant gunfire is
           tactically load-bearing. --- */
    var ref = 7;
    var roll = (o.cat === 'weapon') ? 0.86 : 1;
    var dg = Math.pow(ref / (ref + 0.92 * Math.max(0, dist - ref)), roll);
    dg *= cl(1 - Math.max(0, dist - 150) / 70, 0, 1);
    dg = cl(dg, 0, 1);

    /* --- occlusion --- */
    var occ = (dist < 4) ? { clear: true, thick: 0, px: x, pz: z, extra: 0 }
                         : occlusionAt(fin(x, 0), fin(z, 0), sy);
    b.occluded = !occ.clear;
    var px = occ.px, pz = occ.pz;

    /* --- air absorption + pinna back-shadow, folded into ONE high shelf so
           close, unoccluded, in-front sources cost no node at all. --- */
    var hfDb = -cl(b.dm * 0.16, 0, 22);
    if (!occ.clear) hfDb -= 4 * occ.thick;
    var back = 0;
    if (!b.firstPerson) {
      var f = listenerFwd();
      var L = Math.max(1e-4, dist);
      var dot = (dx * f.x + dy * f.y + dz * f.z) / L;
      back = cl(-dot, 0, 1);                 /* 1 = directly behind */
      hfDb -= 3.6 * back;
    }
    var headNode = b.inp;
    if (hfDb < -0.8) {
      var hs = getBQ('highshelf', 3600, 0.7, cl(hfDb, -30, 0));
      headNode.connect(hs); b.nodes.push(['bq', hs]); headNode = hs;
    }

    /* --- band-limit: distance and walls both eat the top --- */
    var lpF = 20000 / (1 + b.dm / 16);
    if (!occ.clear) lpF = Math.min(lpF, cl(3000 * Math.exp(-occ.thick * 2.1), 190, 3000));
    if (lpF < 17000) {
      var lp = getBQ('lowpass', cl(lpF, 150, 20000), 0.68);
      headNode.connect(lp); b.nodes.push(['bq', lp]); headNode = lp;
    }
    if (!occ.clear) dg *= cl(0.62 * Math.exp(-occ.thick * 1.15), 0.06, 0.8);

    /* --- propagation delay, applied in the scheduler --- */
    b.prop = cl(b.dm / C_AIR + fin(occ.extra, 0), 0, 1.2);
    if (b.prop < 0.004) b.prop = 0;

    /* --- dry --- */
    var dry = getGain(cl(dg * (o.gain === undefined ? 1 : o.gain) * b.shotGain, 0, 4));
    headNode.connect(dry); b.nodes.push(['g', dry]);
    if (b.firstPerson) {
      /* the muzzle is on your shoulder, not 3 m in front of your face */
      var spn = getStereo(cl(o.pan === undefined ? 0.1 : o.pan, -1, 1));
      if (spn) { dry.connect(spn); spn.connect(cat); b.nodes.push(['sp', spn]); }
      else dry.connect(cat);
    } else {
      /* HRTF is by far the most expensive node in the graph - it is a real
         convolution per source - so it is spent only where it buys something:
         gunfire, voices and footsteps close enough to be localised. Beyond
         that, and beyond a hard concurrency budget, equal-power. One panner
         per CUE rather than per layer is what makes this affordable at all;
         a five-layer gunshot would otherwise cost five HRTF convolutions. */
      var hrtfMax = TIER === 'low' ? 26 : (TIER === 'med' ? 44 : 72);
      var hrtfCap = TIER === 'low' ? 3 : (TIER === 'med' ? 7 : 12);
      var wantH = dist < hrtfMax && (o.cat === 'weapon' || o.cat === 'enemy' || o.cat === 'foot');
      if (wantH && (hrtfLive >= hrtfCap || live.length > CAP * 0.78)) wantH = false;
      var pn = getPanner(wantH ? 'HRTF' : 'equalpower');
      if (wantH) { hrtfLive++; b.hrtf = true; }
      /* occluded sound is localised at the corner it bent around, not at the
         wall in front of you */
      var ex = occ.portal ? px : fin(x, 0), ez = occ.portal ? pz : fin(z, 0);
      var ey = occ.portal ? (fin(w.player.y, 0) + w.EYE) : fin(sy, 2);
      try {
        if (pn.positionX) { pn.positionX.value = ex; pn.positionY.value = ey; pn.positionZ.value = ez; }
        else pn.setPosition(ex, ey, ez);
      } catch (e) {}
      b.pn = pn; b.ex = ex; b.ey = ey; b.ez = ez;
      dry.connect(pn); pn.connect(cat); b.nodes.push(['pn', pn]);
    }

    /* --- wet: tapped BEFORE the distance gain and with only a mild rolloff.
           Direct/reverb ratio is what the ear reads as distance, so the wet
           must NOT fall off as fast as the dry. Occluded sources go wetter,
           which is what "muffled through a wall" actually sounds like. --- */
    var wetAmt = (o.wet === undefined ? 1 : o.wet) * space.wet;
    wetAmt *= cl(1 / (1 + dist / 85), 0.18, 1);
    if (!occ.clear) wetAmt *= (occ.portal ? 1.7 : 2.4);
    wetAmt *= b.shotGain;
    var wet = getGain(cl(wetAmt, 0, 2));
    headNode.connect(wet); wet.connect(G.revIn); b.nodes.push(['g', wet]);

    busesThisCue.push(b);
    return b;
  }

  function releaseBus(b) {
    if (!b || b.released) return;
    b.released = true;
    if (b.hrtf) { b.hrtf = false; if (hrtfLive > 0) hrtfLive--; }
    try { b.inp.disconnect(); } catch (e) {}
    putGain(b.inp);
    for (var i = 0; i < b.nodes.length; i++) putAny(b.nodes[i][0], b.nodes[i][1]);
    b.nodes.length = 0;
    b.pn = null;
  }
  function finishCue() {
    for (var i = 0; i < busesThisCue.length; i++) {
      (function (b) {
        var ms = Math.max(60, (b.maxEnd - ctx.currentTime + 0.30) * 1000);
        global.setTimeout(function () { releaseBus(b); }, Math.min(ms, 12000));
      })(busesThisCue[i]);
    }
    busesThisCue.length = 0;
  }

  /* =======================================================================
     12. layer primitives
     ==================================================================== */
  function cleanup(src, gain, extra) {
    var done = false;
    return function () {
      if (done) return; done = true;
      if (src) { src.onended = null; try { src.disconnect(); } catch (e) {} }
      if (extra) for (var i = 0; i < extra.length; i++) putAny(extra[i][0], extra[i][1]);
      putGain(gain);
    };
  }
  /* start time for a layer: now + propagation + the cue-relative offset.
     nodl skips propagation - that is how the crack outruns the blast. */
  function layerT(b, o) {
    var t = ctx.currentTime + (o.nodl ? 0 : b.prop) + fin(o.t, 0);
    var lo = ctx.currentTime + 0.0015;
    return t < lo ? lo : t;
  }

  /* Filtered noise burst. The workhorse: bodies, tails, whooshes, scrapes. */
  function nz(b, o) {
    if (!b || dead) return 0;
    var t = layerT(b, o);
    var dur = cl(o.dur, 0.004, 6);
    var vol = cl(o.vol, 0, 4);
    if (vol <= 0.0006) return t + dur;
    var buf = NOISE[o.buf || 'white'] || NOISE.white;

    var s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = cl(o.rate === undefined ? 1 : o.rate, 0.06, 6);
    var g = getGain(0);
    var extra = [];
    var head = s;

    if (o.ftype !== 'none') {
      var f = getBQ(o.ftype || 'bandpass', cl(o.f0, 12, SR * 0.47), o.q === undefined ? 1 : o.q);
      if (isNum(o.f1)) {
        pSet(f.frequency, cl(o.f0, 12, SR * 0.47), t);
        if (isNum(o.fmid)) pExp(f.frequency, cl(o.fmid, 12, SR * 0.47), t + dur * 0.35);
        pExp(f.frequency, cl(o.f1, 12, SR * 0.47), t + dur);
      }
      if (isNum(o.q1)) { pSet(f.Q, cl(o.q, 0.0001, 40), t); pLin(f.Q, cl(o.q1, 0.0001, 40), t + dur); }
      head.connect(f); head = f; extra.push(['bq', f]);
    }
    if (isNum(o.hp)) {
      var h = getBQ('highpass', cl(o.hp, 12, SR * 0.47), o.hpq === undefined ? 0.6 : o.hpq);
      head.connect(h); head = h; extra.push(['bq', h]);
    }
    if (o.drive) {
      var sh = getShaper(o.drive);
      head.connect(sh); head = sh; extra.push(['sh', sh]);
    }
    head.connect(g); g.connect(b.inp);

    var atk = cl(o.atk === undefined ? 0.003 : o.atk, 0.0003, dur * 0.9);
    pSet(g.gain, EPS, t);
    pLin(g.gain, vol, t + atk);
    if (o.hold) pSet(g.gain, vol, t + Math.min(dur * 0.9, atk + cl(o.hold, 0, dur)));
    if (o.shape === 'lin') pLin(g.gain, EPS, t + dur); else pExp(g.gain, EPS, t + dur);

    var end = t + dur + 0.02;
    var v = track(s, g, end, o.pri === undefined ? 2 : o.pri);
    var fin_ = cleanup(s, g, extra);
    if (!v) { fin_(); return t + dur; }
    s.onended = fin_;
    var off = Math.random() * Math.max(0.02, (buf.duration - dur / (s.playbackRate.value || 1) - 0.05));
    try { s.start(t, cl(off, 0, buf.duration - 0.02)); s.stop(end); } catch (e) { fin_(); }
    if (end > b.maxEnd) b.maxEnd = end;
    return end;
  }

  /* Pitched element: sub thumps, body cracks, vocal fundamentals, UI beeps. */
  function tn(b, o) {
    if (!b || dead) return 0;
    var t = layerT(b, o);
    var dur = cl(o.dur, 0.006, 8);
    var vol = cl(o.vol, 0, 4);
    if (vol <= 0.0006) return t + dur;

    var s = ctx.createOscillator();
    if (o.wave && WAVES[o.wave]) { try { s.setPeriodicWave(WAVES[o.wave]); } catch (e) { s.type = 'sawtooth'; } }
    else s.type = o.type || 'sine';
    s.detune.value = cl(fin(o.detune, 0) + rr(-6, 6), -2400, 2400);

    var f0 = cl(o.f0, 8, SR * 0.45);
    pSet(s.frequency, f0, t);
    if (isNum(o.fm1)) pExp(s.frequency, cl(o.fm1, 8, SR * 0.45), t + dur * cl(o.fmAt === undefined ? 0.4 : o.fmAt, 0.05, 0.95));
    if (isNum(o.f1)) pExp(s.frequency, cl(o.f1, 8, SR * 0.45), t + dur);

    var g = getGain(0), extra = [], head = s;
    if (isNum(o.lp)) { var lf = getBQ('lowpass', cl(o.lp, 20, SR * 0.47), 0.7); head.connect(lf); head = lf; extra.push(['bq', lf]); }
    if (o.drive) { var sh = getShaper(o.drive); head.connect(sh); head = sh; extra.push(['sh', sh]); }
    head.connect(g); g.connect(b.inp);

    var atk = cl(o.atk === undefined ? 0.004 : o.atk, 0.0004, dur * 0.9);
    pSet(g.gain, EPS, t);
    pLin(g.gain, vol, t + atk);
    if (o.hold) pSet(g.gain, vol, t + Math.min(dur * 0.9, atk + cl(o.hold, 0, dur)));
    pExp(g.gain, EPS, t + dur);

    var end = t + dur + 0.02;
    var v = track(s, g, end, o.pri === undefined ? 2 : o.pri);
    var fin_ = cleanup(s, g, extra);
    if (!v) { fin_(); return t + dur; }
    s.onended = fin_;
    try { s.start(t); s.stop(end); } catch (e) { fin_(); }
    if (end > b.maxEnd) b.maxEnd = end;
    return end;
  }

  /* Pre-rendered transient playback. NOTE: no attack ramp - the buffer IS the
     attack, and a gain ramp of even half a millisecond would round off the
     shock front that the whole design exists to preserve. */
  function smp(b, o) {
    if (!b || dead || !o.buf) return 0;
    var t = layerT(b, o);
    var vol = cl(o.vol, 0, 4);
    var rate = cl(o.rate === undefined ? 1 : o.rate, 0.25, 4);
    var dur = o.buf.duration / rate;
    if (vol <= 0.0006) return t + dur;

    var s = ctx.createBufferSource();
    s.buffer = o.buf;
    s.playbackRate.value = rate;
    var g = getGain(0), extra = [], head = s;

    if (isNum(o.lp)) { var lf = getBQ('lowpass', cl(o.lp, 40, SR * 0.47), o.lpq === undefined ? 0.7 : o.lpq); head.connect(lf); head = lf; extra.push(['bq', lf]); }
    if (isNum(o.hp)) { var hf = getBQ('highpass', cl(o.hp, 20, SR * 0.47), o.hpq === undefined ? 0.7 : o.hpq); head.connect(hf); head = hf; extra.push(['bq', hf]); }
    if (isNum(o.peak)) {
      var pk = getBQ('peaking', cl(o.peak, 40, SR * 0.45), o.peakq === undefined ? 1.1 : o.peakq, cl(o.peakg, -24, 18));
      head.connect(pk); head = pk; extra.push(['bq', pk]);
    }
    if (o.drive) { var sh = getShaper(o.drive); head.connect(sh); head = sh; extra.push(['sh', sh]); }
    head.connect(g); g.connect(b.inp);

    /* step, not ramp */
    pSet(g.gain, vol, t);
    var stop = t + dur;
    if (isNum(o.dur) && o.dur < dur) { pExp(g.gain, EPS, t + o.dur); stop = t + o.dur + 0.005; }

    var end = stop + 0.02;
    var v = track(s, g, end, o.pri === undefined ? 5 : o.pri);
    var fin_ = cleanup(s, g, extra);
    if (!v) { fin_(); return end; }
    s.onended = fin_;
    try { s.start(t); s.stop(stop + 0.004); } catch (e) { fin_(); }
    if (end > b.maxEnd) b.maxEnd = end;
    return end;
  }

  /* Small metallic hit: bolts, ejectors, latches. Uses the ping bank when it
     is already built and falls back to filtered noise when it is not, so the
     first frame after install is never silent. */
  function tick(b, o) {
    var t = fin(o.t, 0), f = cl(o.f, 300, 14000), v = cl(o.vol, 0, 3), d = cl(o.dur, 0.006, 0.5);
    var key = 'pg_mech';
    var lst = pingBank(key, 1550, 0.20, false);
    var buf = pickBuf(lst, key);
    if (buf) {
      smp(b, { t: t, buf: buf, vol: v * 1.05, rate: cl(f / 1550, 0.3, 3.6) * rr(0.96, 1.05),
               dur: d * 1.6, hp: f * 0.35, pri: o.pri === undefined ? 1 : o.pri, nodl: o.nodl });
      if (o.body) tn(b, { t: t, dur: d * 1.3, f0: f * 0.24, f1: f * 0.14, vol: v * 0.45, type: 'triangle', atk: 0.001, pri: 1, nodl: o.nodl });
      return;
    }
    nz(b, { t: t, dur: d * 0.28, vol: v, atk: 0.0005, ftype: 'highpass', f0: f * 1.5, q: 0.6, shape: 'lin', pri: 1, nodl: o.nodl });
    nz(b, { t: t, dur: d, vol: v * 0.85, atk: 0.0006, ftype: 'bandpass', f0: f, q: cl(o.q, 3, 30) || 9, pri: 1, nodl: o.nodl });
    if (o.body) tn(b, { t: t, dur: d * 1.3, f0: f * 0.24, f1: f * 0.14, vol: v * 0.5, type: 'triangle', atk: 0.001, pri: 1, nodl: o.nodl });
  }

  /* =======================================================================
     13. formant voice engine
     Source (glottal pulse wave or noise) -> series peaking filters that sweep
     between two vowel targets -> optional drive -> envelope. Sweeping the
     formants rather than holding them is what makes these read as an
     utterance instead of a filtered buzz.
     ==================================================================== */
  var VOWEL = {
    a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010],
    o: [570, 840, 2410], u: [300, 870, 2240], er: [490, 1350, 1690],
    ae: [660, 1720, 2410], aw: [570, 840, 2410]
  };

  function vox(b, o) {
    if (!b || dead) return 0;
    var t = layerT(b, o);
    var dur = cl(o.dur, 0.03, 4);
    var vol = cl(o.vol, 0, 3);
    if (vol <= 0.0008) return t + dur;

    var src = null, extra = [], head = null;
    var g = getGain(0);

    /* -- glottal source -- */
    if (o.tonal !== false) {
      src = ctx.createOscillator();
      if (o.wave && WAVES[o.wave]) { try { src.setPeriodicWave(WAVES[o.wave]); } catch (e) { src.type = 'sawtooth'; } }
      else src.type = o.type || 'sawtooth';
      src.detune.value = cl(fin(o.detune, 0), -2400, 2400);
      var pts = o.f0 || [[0, 140], [1, 110]];
      var fp = [];
      for (var i = 0; i < pts.length; i++) fp.push([cl(pts[i][0], 0, 1) * dur, cl(pts[i][1], 12, 4000)]);
      pCurve(src.frequency, fp, t, 12, 4000);
      head = src;
    }

    /* -- breath / rasp noise, summed with the tonal source -- */
    var nsrc = null;
    if (o.breath > 0 || o.tonal === false) {
      nsrc = ctx.createBufferSource();
      nsrc.buffer = NOISE[o.nbuf || 'white'];
      nsrc.playbackRate.value = cl(o.nrate === undefined ? 1 : o.nrate, 0.1, 4);
      var nf = getBQ('bandpass', cl(o.breathF === undefined ? 1600 : o.breathF, 60, 16000), o.breathQ === undefined ? 0.8 : o.breathQ);
      if (isNum(o.breathF1)) { pSet(nf.frequency, cl(o.breathF, 60, 16000), t); pExp(nf.frequency, cl(o.breathF1, 60, 16000), t + dur); }
      var ng = getGain(cl(o.tonal === false ? 1 : o.breath, 0, 3));
      nsrc.connect(nf); nf.connect(ng);
      extra.push(['bq', nf]); extra.push(['g', ng]);
      if (head) { var mix = getGain(1); head.connect(mix); ng.connect(mix); extra.push(['g', mix]); head = mix; }
      else head = ng;
    }
    if (!head) { putGain(g); return t + dur; }

    /* -- vocal tract: three peaking bands, swept from vowel A to vowel B -- */
    var vA = o.from ? (VOWEL[o.from] || o.from) : [600, 1200, 2500];
    var vB = o.to ? (VOWEL[o.to] || o.to) : vA;
    var fq = o.fq || [7, 9, 11];
    var fg = o.fg || [15, 11, 7];
    for (var k = 0; k < 3; k++) {
      var pk = getBQ('peaking', cl(vA[k], 60, 12000), cl(fq[k], 0.4, 30), cl(fg[k], -30, 26));
      pSet(pk.frequency, cl(vA[k], 60, 12000), t);
      pExp(pk.frequency, cl(vB[k], 60, 12000), t + dur * 0.92);
      head.connect(pk); head = pk; extra.push(['bq', pk]);
    }
    /* tract band-limit: nothing lives below ~70 Hz or above ~5 kHz in a throat */
    var hp = getBQ('highpass', cl(o.hp === undefined ? 80 : o.hp, 20, 2000), 0.65);
    head.connect(hp); head = hp; extra.push(['bq', hp]);
    var lp = getBQ('lowpass', cl(o.lp === undefined ? 4200 : o.lp, 200, 18000), o.lpq === undefined ? 0.8 : o.lpq);
    head.connect(lp); head = lp; extra.push(['bq', lp]);

    if (o.drive) { var sh = getShaper(o.drive); head.connect(sh); head = sh; extra.push(['sh', sh]); }
    head.connect(g); g.connect(b.inp);

    /* -- growl / tremolo: audio-rate AM summed on top of the envelope -- */
    var lfo = null, lg = null;
    if (o.growl && o.growl.rate > 0) {
      lfo = ctx.createOscillator();
      lfo.type = o.growl.type || 'sine';
      pSet(lfo.frequency, cl(o.growl.rate, 0.2, 300), t);
      if (isNum(o.growl.rate1)) pExp(lfo.frequency, cl(o.growl.rate1, 0.2, 300), t + dur);
      lg = getGain(cl(o.growl.depth, 0, 1) * vol);
      lfo.connect(lg); lg.connect(g.gain);
      extra.push(['g', lg]);
    }

    var atk = cl(o.atk === undefined ? 0.012 : o.atk, 0.0006, dur * 0.6);
    var rel = cl(o.rel === undefined ? dur * 0.45 : o.rel, 0.01, dur);
    pSet(g.gain, EPS, t);
    pLin(g.gain, vol, t + atk);
    pSet(g.gain, vol, t + Math.max(atk, dur - rel));
    pExp(g.gain, EPS, t + dur);

    var end = t + dur + 0.03;
    var mainSrc = src || nsrc;
    var v = track(mainSrc, g, end, o.pri === undefined ? 3 : o.pri);
    var base = cleanup(mainSrc, g, extra);
    var fin_ = function () {
      try { if (src && src !== mainSrc) src.disconnect(); } catch (e) {}
      try { if (nsrc && nsrc !== mainSrc) nsrc.disconnect(); } catch (e) {}
      try { if (lfo) lfo.disconnect(); } catch (e) {}
      base();
    };
    if (!v) { fin_(); return t + dur; }
    mainSrc.onended = fin_;
    try { if (src) { src.start(t); src.stop(end); } } catch (e) {}
    try { if (nsrc) { nsrc.start(t, rr(0, 1.5)); nsrc.stop(end); } } catch (e) {}
    try { if (lfo) { lfo.start(t); lfo.stop(end); } } catch (e) {}
    if (end > b.maxEnd) b.maxEnd = end;
    return end;
  }

  /* =======================================================================
     14. ducking + damage processing
     ==================================================================== */
  function duck(amount, rel) {
    if (!G) return;
    var t = ctx.currentTime;
    amount = cl(amount, 0, 1);
    /* Broadband component stays gentle; the low shelf does the heavy lifting.
       For a full-strength duck that is about -12 dB below 900 Hz and only
       -3 dB in the presence band, so an enemy footstep - which lives at
       2-6 kHz - is still there between two shots. Duck flat instead and the
       footstep goes with the rumble, which is the usual mistake. */
    var lo = cl(1 - amount * 0.62, 0.38, 1);
    var tilt = -cl(amount * 17, 0, 16);
    rel = cl(rel, 0.06, 1.4);
    pHold(G.duck.gain, t);
    pLin(G.duck.gain, lo, t + 0.010);
    pSet(G.duck.gain, lo, t + 0.045);
    pLin(G.duck.gain, 1, t + 0.045 + rel);
    pHold(G.duckTilt.gain, t);
    pLin(G.duckTilt.gain, tilt, t + 0.010);
    pSet(G.duckTilt.gain, tilt, t + 0.045);
    pLin(G.duckTilt.gain, 0, t + 0.045 + rel * 0.72);
    /* footsteps duck barely at all - they are the tactical channel */
    var flo = cl(1 - amount * 0.24, 0.7, 1);
    pHold(G.duckFoot.gain, t);
    pLin(G.duckFoot.gain, flo, t + 0.012);
    pLin(G.duckFoot.gain, 1, t + 0.012 + rel * 0.55);
  }

  function damageFX(sev) {
    if (!G) return;
    sev = cl(sev, 0, 1);
    var t = ctx.currentTime;
    pHold(G.dmgLP.frequency, t);
    pLin(G.dmgLP.frequency, cl(19000 - sev * 18100, 780, 19000), t + 0.035);
    pExp(G.dmgLP.frequency, 19000, t + 0.05 + 0.55 + sev * 2.1);
    if (sev > 0.5) {
      var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.02 });
      var ring = 4200 + rr(-260, 420);
      tn(b, { t: 0.02, dur: 1.5 + sev * 1.9, f0: ring, f1: ring * 0.965, vol: 0.028 * sev, type: 'sine', atk: 0.03, pri: 5 });
      tn(b, { t: 0.02, dur: 1.2 + sev * 1.6, f0: ring * 1.47, f1: ring * 1.44, vol: 0.016 * sev, type: 'sine', atk: 0.05, pri: 5 });
      tn(b, { t: 0.0, dur: 0.22, f0: 190, f1: 62, vol: 0.16 * sev, type: 'sine', atk: 0.002, pri: 5 });
    }
  }

  /* =======================================================================
     15. weapons

     Structure of every report, in the order the ear receives it:

       1  ballistic crack   the projectile's shock cone. Arrives essentially
                            at once (the bullet outruns its own sound), is a
                            few hundred microseconds long, and is the reason
                            being shot AT sounds different from shooting.
                            Subsonic loads - buckshot, rockets - do not have
                            one, and that absence is a real weapon signature.
       2  muzzle blast      arrives dist/c later. Friedlander pulse train,
                            barrel modes at c/2L, gas jet, ground bounce.
       3  sub               felt, not heard; scaled out with distance.
       4  mechanical        bolt, ejector, belt. Near field only.
       5  tail              the room, from the convolver plus a rolloff layer
                            whose shape is a function of the space.

     Near and far are separate pre-rendered timbres crossfaded by distance,
     because a rifle at 40 m is a different sound, not a quieter one.
     ==================================================================== */
  function subScale(b) { return cl(1 - b.dist / 55, 0.06, 1); }

  /* The low-frequency roll that follows every report. The convolver supplies
     the reflection cluster; this supplies the body of the tail, and at range
     it grows into the long rolling slap-back that distant gunfire actually
     has in a built-up space. */
  function report(b, weight, t) {
    var sp = space.name, f = b.far;
    var w = cl(weight, 0.1, 2);
    var lvl = 1 + f * 1.35;                 /* the tail dominates at range */

    if (sp === 'outdoor') {
      nz(b, { t: t + 0.03, dur: 0.30 + w * 0.22, vol: 0.045 * w * lvl, atk: 0.02,
              ftype: 'lowpass', f0: 900, f1: 180, q: 0.5, buf: 'pink', pri: 2 });
      nz(b, { t: t + 0.10 + rr(0, 0.05), dur: 0.30 + w * 0.20, vol: 0.030 * w * lvl, atk: 0.05,
              ftype: 'bandpass', f0: 620, f1: 240, q: 0.7, buf: 'pink', pri: 1 });
    } else if (sp === 'corridor') {
      nz(b, { t: t + 0.012, dur: 0.16 + w * 0.14, vol: 0.070 * w * lvl, atk: 0.006,
              ftype: 'bandpass', f0: 1450, f1: 380, q: 0.9, buf: 'white', pri: 2 });
      tn(b, { t: t + 0.02, dur: 0.16 + w * 0.12, f0: 138, f1: 62, vol: 0.038 * w, type: 'sine', atk: 0.008, pri: 2 });
    } else if (sp === 'hall' || sp === 'stair') {
      nz(b, { t: t + 0.028, dur: 0.42 + w * 0.34, vol: 0.062 * w * lvl, atk: 0.02,
              ftype: 'lowpass', f0: 1600, f1: 210, q: 0.55, buf: 'pink', pri: 2 });
      tn(b, { t: t + 0.04, dur: 0.42 + w * 0.30, f0: 104, f1: 40, vol: 0.040 * w, type: 'sine', atk: 0.02, pri: 2 });
      if (sp === 'stair') nz(b, { t: t + 0.07, dur: 0.34, vol: 0.026 * w, atk: 0.01,
              ftype: 'bandpass', f0: 2100, f1: 900, q: 3.2, buf: 'white', pri: 1 });
    } else {
      nz(b, { t: t + 0.018, dur: 0.24 + w * 0.20, vol: 0.058 * w * lvl, atk: 0.01,
              ftype: 'lowpass', f0: 1350, f1: 250, q: 0.6, buf: 'pink', pri: 2 });
      tn(b, { t: t + 0.03, dur: 0.24 + w * 0.18, f0: 118, f1: 46, vol: 0.032 * w, type: 'sine', atk: 0.012, pri: 2 });
    }

    /* At range, discrete slap-backs off whatever is around. Delays are
       physical: a facade 12-45 m off the line gives 70-260 ms. This is the
       "rolling" quality of distant fire and it is almost entirely what makes
       far gunfire read as far. */
    if (f > 0.18 && !b.firstPerson) {
      var slaps = space.sky ? 3 : 2;
      for (var i = 0; i < slaps; i++) {
        var dly = 0.055 + i * rr(0.055, 0.115) + rr(0, 0.03);
        nz(b, { t: t + dly, dur: 0.22 + i * 0.14, vol: 0.030 * w * f * (1 - i * 0.28), atk: 0.012 + i * 0.01,
                ftype: 'lowpass', f0: 1200 - i * 340, f1: 190, q: 0.6, buf: 'pink', pri: 1 });
      }
    }
  }

  /* Fires the two-part direct sound: near timbre and far timbre, crossfaded.
     Returns nothing; the caller adds sub, mech and tail. */
  function blast(b, name, o) {
    o = o || {};
    var nearW = b.near * (o.gain === undefined ? 1 : o.gain);
    var farW = b.far * (o.gain === undefined ? 1 : o.gain);
    /* +-1.3 semitones by default, on top of variant rotation. `jit` narrows it:
       a weapon that fires ten times a second wants LESS pitch scatter and more
       timbral scatter, because at that rate a wandering pitch centre reads as
       a broken sampler rather than as variation. */
    var jit = fin(o.jit, 1);
    var rate = 1 + rr(-0.072, 0.078) * jit;
    var lst, buf;

    /* `t` lets a first-person cue push its whole blast back by a couple of
       milliseconds so the structure-borne precursor has room in front of it;
       `lp` is how a suppressor gets its stretched, shock-less front edge. */
    var t0 = fin(o.t, 0);
    if (nearW > 0.02) {
      lst = blastBank(name, false);
      buf = pickBuf(lst, 'bl_' + name + '_n');
      if (buf) smp(b, { t: t0, buf: buf, vol: cl(o.near * nearW, 0, 3), rate: rate, lp: o.lp,
                        drive: o.drive, peak: o.peak, peakg: o.peakg, peakq: o.peakq, pri: 6 });
    }
    if (farW > 0.02) {
      lst = blastBank(name, true);
      buf = pickBuf(lst, 'bl_' + name + '_f');
      if (buf) smp(b, { t: t0, buf: buf, vol: cl(o.far * farW, 0, 3), lp: o.lp,
                        rate: rate * rr(0.97, 1.03), pri: 6 });
    }
  }

  /* The supersonic crack. nodl:true - it does NOT wait for the propagation
     delay, because the bullet gets to you long before its muzzle blast does. */
  function ballistic(b, vol, wide, o) {
    if (vol <= 0.004) return;
    o = o || {};
    var key = wide ? 'ck_w' : 'ck_n';
    var lst = crackBank(wide);
    var buf = pickBuf(lst, key);
    if (!buf) return;
    /* the crack loses its top to air just like everything else, but it stays
       a crack: at range it turns into a whip snap, not a thump */
    var lp = cl(20000 / (1 + b.dm / 9), 1400, 20000);
    /* `rate` is the N-wave's duration dial: playing the bank faster shortens
       T, which moves the crack's spectral peak UP. That is how one shared
       crack bank serves a 9 mm and a 5.56 without a bespoke bank per calibre -
       and how the same shot's crack sags in pitch as it gets further away,
       which is the real d^0.25 growth of the shock cone. */
    smp(b, { nodl: true, buf: buf, vol: vol,
             rate: (isNum(o.rate) && o.rate > 0) ? cl(o.rate, 0.25, 4) : rr(0.9, 1.12),
             lp: lp, hp: fin(o.hp, 320),
             peak: o.peak, peakg: o.peakg, peakq: o.peakq, pri: 6 });
  }

  function mech(b, list, near) {
    if (!near) return;
    for (var i = 0; i < list.length; i++) tick(b, list[i]);
  }

  /* =======================================================================
     15b. FIRST-PERSON MECHANISM
     ---------------------------------------------------------------------
     Everything in this block exists only when the gun is in your hands, and
     none of it is audible to anyone else in the level. That is not a mixing
     convenience - it is what the measurements say.

     Two facts drive the whole design.

     ONE: YOU DO NOT HEAR YOUR OWN BULLET.
     A supersonic round drags a conical shock behind it with half-angle
     mu = arcsin(1/M). For M855 at ~945 m/s that is M = 2.75, mu = 21.3 deg,
     and the cone only exists at points downrange of the apex - formally where
     x >= r*sqrt(M^2-1). Your ear is roughly 0.6 m BEHIND the muzzle, on the
     wrong side of the apex, permanently outside the cone. Four independent
     measurement programmes say the same thing: on a 3.67 m arc around an M16A4
     the ballistic shock is plainly present at 15 deg off axis and there is "no
     ballistic shot evident" at 90 deg; the shock/blast separation shrinks with
     azimuth and vanishes at high azimuths; and to the side of and behind the
     firer only the muzzle blast is distinguishable. The crack is real, it is
     loud - 148 dB a metre off the flight path at 55 yards - and it is
     generated downrange and travels away from you with the bullet. The only
     way it ever comes back is as a reflection off something you shot at.

     This module used to give the player's own rifle a crack at -4 dB relative
     to the blast peak, the second loudest layer in the cue, and the pistol one
     at -2 dB below that. It is now gone from both, and what it was actually
     buying - high-frequency bite - is supplied by the sources that genuinely
     produce it at your ear: the shock front of the blast itself, and the hard
     near-field scatter off your own optic, rail and chest.

     TWO: WHAT YOU HEAR INSTEAD IS THE MACHINE.
     At the shooter's position there are sources that no observer gets. A mic
     at a shooter's head picks up the trigger, sear and hammer 2 ms BEFORE the
     muzzle blast, then the powder burning and the bullet travelling, radiated
     through the barrel and receiver as structure-borne sound, at around 123 dB
     peak. Direct-impingement rifles vent unlocking gas out of the ejection
     port beside your face - that vent is why a suppressed AR measures 20-30 dB
     down at the shooter's left ear but only 10-18 dB down at the right. And
     the bolt carrier returning to battery has been measured at 132 dBZ at the
     shooter's ear, which is within a few dB of a SUPPRESSED muzzle. Against an
     unsuppressed 160 dB blast that mechanism is 28 dB down and forward-masked
     into nothing; drop the blast and it becomes the loudest thing in the cue.
     That is the real reason a can makes a rifle sound like a machine tool, and
     it is modelled here as an explicit masking scale rather than a guess.
     ==================================================================== */

  /* ---- the ignition offset ----
     Every first-person cue schedules its muzzle blast at MECH_T0 rather than
     at zero, so that the structure-borne precursor has somewhere to live.

     The value is NOT the 2.6 ms the measurement gives, and the reason is worth
     writing down. layerT() floors every scheduled layer at now + 1.5 ms, and on
     a self bus that floor always bites: b.prop is the propagation delay, and
     newBus zeroes it below 4 ms, which a bus 0.2 m away always is. So a layer
     asked for at t = 0.2 ms does not happen at 0.2 ms - it happens at 1.5 ms,
     along with everything else below the floor, with its per-shot jitter nulled
     because they all land on the same clamp. Setting MECH_T0 to 2.6 ms bought a
     real lead of 1.1 ms, collapsed the two precursor layers onto one instant,
     and let the swell peak AFTER the blast it was supposed to lead.

     4.2 ms clears the floor with room for the precursor to be a precursor: the
     sear knock lands at 1.6-2.1 ms with its jitter intact, 2.1-2.6 ms ahead of
     the blast, which is what was measured. The cost is 4.2 ms of latency on
     your own gunshot - a quarter of a frame at 60 Hz, well under the ~10 ms
     where onset delay starts to read as input lag, and perceptually the shot
     still lands when you pull because the precursor IS the onset. */
  var MECH_T0 = 0.0042;

  /* Trigger, sear, hammer, then the powder burning and the bullet running up
     the bore - all of it conducted out through the receiver and the stock
     against your cheek. About 31 dB under the blast and 2 ms ahead of it. You
     never hear this consciously; taking it away makes the gun feel like it
     starts at the bang instead of being fired by you. */
  function preTransient(b, o) {
    o = o || {};
    var v = fin(o.vol, 1);
    /* sear release and hammer fall: a small dry mechanical knock */
    tick(b, { t: 0.0016 + rr(0, 0.0005), f: fin(o.searF, 2400) * rr(0.92, 1.10),
              vol: 0.020 * v, dur: 0.006, q: 6, pri: 3 });
    /* Interior ballistics radiating through the barrel and receiver: a low-mid
       swell that RISES into the blast rather than decaying - the one envelope
       in this file that runs the other way round. The attack is set so the peak
       lands ON the muzzle blast, because that is when it physically peaks: the
       bore is loudest at the instant it uncorks. dur is 4.4 ms rather than the
       2.4 the geometry wants, because nz() clamps dur to a 4 ms floor and a
       silently-doubled envelope is worse than an honest one - so it decays
       through the first 2 ms of the blast, which is also what a real barrel
       does rather than stopping dead. */
    nz(b, { t: 0.0018, dur: 0.0044, vol: 0.028 * v, atk: 0.0024,
            ftype: 'bandpass', f0: fin(o.boreF, 520) * rr(0.9, 1.12), f1: fin(o.boreF, 520) * 1.9,
            q: 1.1, shape: 'lin', pri: 3 });
  }

  /* ---- ejection port gas ----
     Direct impingement dumps unlocking gas straight out of the port, a hand's
     width from your face and biased to your right. Broadband, fast rise, and
     it keeps venting for as long as the carrier is back. Cannot be suppressed:
     it is upstream of any can, which is precisely why the right ear loses
     10-15 dB less than the left when you screw one on. */
  function portGas(b, t0, v, wide) {
    if (v <= 0.002) return;
    nz(b, { t: t0, dur: 0.020 + rr(0, 0.014), vol: 0.052 * v, atk: 0.0010,
            ftype: 'bandpass', f0: rr(1500, 2400), f1: rr(600, 900), q: 0.55,
            pri: 3 });
    /* the sharper hiss of the jet through the port itself */
    nz(b, { t: t0 + 0.0006, dur: 0.011 + rr(0, 0.008), vol: 0.030 * v, atk: 0.0005,
            ftype: 'bandpass', f0: rr(4200, 7000), f1: rr(1800, 2600), q: 0.8,
            shape: 'lin', pri: 3 });
    if (wide)
      nz(b, { t: t0 + 0.004 + rr(0, 0.006), dur: 0.045 + rr(0, 0.040), vol: 0.020 * v, atk: 0.006,
              ftype: 'bandpass', f0: rr(900, 1500), f1: rr(400, 700), q: 0.7, pri: 2 });
  }

  /* ---- the buffer spring ----
     The single most recognisable thing an AR does, and the reason people who
     have never fired one still know the noise. Mechanism: a 37-39 coil helical
     spring surging longitudinally while its coils scrape the inside of a
     thin-walled aluminium receiver extension, which is simultaneously the
     source, a resonant pipe, and a rod pressed against your cheek.

     The part almost nobody models is the GLIDE. The air column behind the
     buffer is a closed-open cavity whose length is being modulated by the
     buffer itself - roughly 7 inches shortening to 3.5 as the carrier goes
     back, then lengthening again on the return. A quarter-wave over that range
     sweeps about 480 Hz up to 960 and back down, at the cycle rate. That
     rise-and-fall is the "sproing"; without it you get a buzz.

     Two detuned modes beat against each other under a high-Q noise band, all
     three following the same glide. Rings 100-300 ms - two orders of magnitude
     longer than the blast - so it is still going when everything else has
     stopped, and because it reaches you partly by bone conduction through the
     stock it is one of the few things hearing protection does not touch. */
  function bufferSpring(b, t0, v, longTail) {
    if (v <= 0.002) return 0;
    var sf = rr(455, 545);                       /* first surge partial */
    var up = sf * rr(1.85, 2.10);                /* cavity shortened, buffer at rear */
    var dur = longTail ? rr(0.155, 0.265) : rr(0.075, 0.115);
    /* mode 1: out, up, and back down as the buffer returns */
    tn(b, { t: t0, dur: dur, f0: sf, fm1: up, fmAt: 0.34, f1: sf * rr(0.94, 1.04),
            vol: 0.034 * v, type: 'triangle', atk: 0.0035, pri: 3 });
    /* mode 2: detuned a little over a semitone, so the pair beats at 25-40 Hz -
       that shimmer is the difference between a spring and a sine */
    tn(b, { t: t0 + rr(0, 0.0022), dur: dur * rr(0.82, 0.98),
            f0: sf * rr(1.055, 1.085), fm1: up * rr(1.05, 1.09), fmAt: 0.34,
            f1: sf * rr(0.98, 1.09), vol: 0.023 * v, type: 'triangle', atk: 0.004, pri: 2 });
    if (longTail)
      /* coil-on-tube scrape: the inharmonic dirt that stops the two modes
         reading as a synth patch */
      nz(b, { t: t0 + 0.001, dur: dur * 0.72, vol: 0.017 * v, atk: 0.006,
              ftype: 'bandpass', f0: sf * 1.9, fmid: up * 1.7, f1: sf * 1.5, q: 7.5,
              buf: 'grit', rate: rr(0.7, 1.3), pri: 2 });
    return dur;
  }

  /* ---- case out of the port ----
     Brass is high-Q and it is the one genuinely tonal event in the cycle - a
     bell, briefly, off the deflector. Distinct from cueCase, which is the
     casing hitting the deck the better part of a second later and is triggered
     by the particle system. This is the near-field one, the one you actually
     hear over the top of your own gun. */
  function caseOut(b, t0, v) {
    if (v <= 0.002) return;
    tick(b, { t: t0, f: rr(4600, 6600), vol: 0.026 * v * rr(0.88, 1.12), dur: 0.013, q: 13, pri: 3 });
    /* the strike on the brass deflector: lower, shorter, and it is what tells
       you the case went right rather than straight up */
    tick(b, { t: t0 + 0.0022 + rr(0, 0.0016), f: rr(1500, 2100),
              vol: 0.020 * v, dur: 0.028, q: 6, body: true, pri: 2 });
  }

  /* ------------------------------------------------------------ 9x19 pistol
     Rebuilt around the shooter's position. The short version of what changed:
     the crack is gone, the slide is three times faster, the bass came down,
     and every layer now moves shot to shot.

     THE CRACK. Standard 9 mm sits ON the sonic boundary, not above it -
     115 gr and 124 gr loads chronograph between M 0.94 and M 1.07 depending on
     which pistol they came out of, and 147 gr is flatly subsonic at M 0.84-0.89.
     Even where it is supersonic the Mach cone half-angle is 72 degrees, so any
     shock arrives essentially on top of the muzzle blast and 30 dB under it,
     and the bullet drops back through Mach 1 inside about ten metres. This cue
     used to play the rifle's own N-wave bank at 0.30 for the shooter and carry
     it out to 90 m for everyone else. It is now a faint transonic edge at
     close range only, and nothing at all for the man holding it.

     THE SLIDE. Measured on a 9 mm short-recoil pistol with laser
     triangulation: the barrel unlocks at 1.63 ms, the case is struck by the
     ejector around 7.9 ms, the slide hits the frame at 12.57 ms doing 2.99 m/s
     with a contact time of 1.2-1.6 ms and about 1100 N behind it, and it is
     back in battery at 40.0 ms. The old code had those two impacts at 36-40 ms
     and 70-76 ms - roughly three times too slow, which is why the pistol read
     as a slow "clunk-clunk" rather than the fast metallic slap it is.

     The two impacts are deliberately different animals. The rear one is a
     1.2-1.6 ms force pulse, and a pulse that long cannot contain much above
     about 800 Hz, so it is a low thud with a bright ring-out riding on it. The
     return to battery is steel breech face onto steel barrel hood over a much
     smaller contact patch: less energy (1.4 J against 2.35 J) but far sharper,
     and it is the one people actually recognise as "a pistol".
     -------------------------------------------------------------------- */
  function cuePistol(x, z) {
    var b = newBus(x, z, { cat: 'weapon', wet: 0.95, pan: 0.14, shot: true });
    var self = b.firstPerson, ss = subScale(b);
    var nearGate = self || b.dist < 26;

    /* Per-shot decorrelation. The rifle had all of this and the pistol had
       none of it, which at 5.3 rps was audible as a drum machine: two pings at
       a FIXED 2750 and 1850 Hz on a fixed grid after every round, with every
       level in the cue a literal. Four things move now - variant, rate, level,
       time - plus an even/odd resonance bias on the blast. */
    var n = pistolSeq++;
    var alt = (n & 1) ? 1 : 0;
    var jv = rr(-0.12, 0.10);        /* ~1 dB */
    var jt = rr(0, 0.0028);
    var opening = (ctx.currentTime - pistolLast) > 0.30;
    pistolLast = ctx.currentTime;

    /* --- 0. what you hear before the bang, if it is your hand on it --- */
    if (self) preTransient(b, { searF: 2600, boreF: 620, vol: 1 });
    var T0 = self ? MECH_T0 : 0;

    /* --- 1. transonic edge, for observers only. A 9 mm makes little shock and
       loses it fast, so this is a quarter of what it was and collapses by 45 m
       instead of 90. The shooter gets none: at the cone apex there is nothing
       to hear. --- */
    if (!self)
      ballistic(b, 0.17 * cl(1 - b.dm / 45, 0, 1) * (1 + jv), false,
                { rate: rr(0.52, 0.74), hp: 260 });

    /* --- 2. muzzle blast. T is now 0.20 ms, so f = 1/(2*pi*T) puts the peak at
       796 Hz where the measurements put it, and 'blastLite' on the self path
       keeps the crest factor a real handgun has. The peaking bump alternates
       open/scooped around the 640-1060 Hz measured range. --- */
    blast(b, 'pistol', {
      t: T0,
      near: (self ? 0.74 : 0.60) * (1 + jv),
      far: 0.52 * (1 + jv),
      drive: self ? 'blastLite' : null,
      jit: 0.8,
      peak: (alt ? 980 : 700) * rr(0.82, 1.24),
      peakg: (alt ? 2.6 : -2.0) + rr(-1.7, 1.7),
      peakq: rr(0.7, 2.2)
    });

    /* --- 3. sub. Trimmed from 0.24/100 ms: a 9 mm burns about a fifth of the
       rifle's powder and cannot out-thump it, which is what the old numbers
       had it doing. --- */
    tn(b, { t: T0 + jt + 0.0006, dur: 0.078 + rr(0, 0.016), f0: 163 * rr(0.93, 1.08), f1: 54,
            vol: 0.175 * ss * (1 + jv), type: 'sine', atk: 0.0012, pri: 5 });

    /* --- 4. live top. Short handgun barrels uncork at high residual pressure
       through a wide bore, which is where the blunt metallic edge comes from -
       and with the crack gone this is now carrying it. --- */
    nz(b, { t: T0 + jt + 0.0009, dur: 0.042 + rr(0, 0.016), vol: 0.150 * b.near * (1 + jv), atk: 0.0006,
            ftype: 'bandpass', f0: rr(3400, 5200), f1: rr(1300, 1800), q: 1.5, shape: 'lin', pri: 4 });

    /* --- 5. the action, at measured times --- */
    if (nearGate) {
      /* Same argument as the rifle's MECH_G, landing on a different number.
         A pistol's mechanism is MORE prominent against its own blast than a
         carbine's, and for a physical reason: the blast is about a fifth of
         the rifle's energy while the moving mass is not smaller at all - a
         340 g slide arriving at 3 m/s carries 2.35 J into the frame, against
         a 326 g carrier in the AR. Less bang, same machine. So 0.55 here
         against the rifle's 0.42, putting the battery slam ~23.5 dB under the
         muzzle rather than 28. */
      var pmv = (1 + jv) * 0.55;
      var pdetail = TIER !== 'low' && live.length < CAP * 0.55;

      /* barrel unlocks and drops onto the frame: small, bright, buried under
         the blast unless you are behind the gun */
      if (self)
        tick(b, { t: T0 + jt + 0.0016 + rr(0, 0.0006), f: rr(3000, 4200),
                  vol: 0.018 * pmv, dur: 0.009, q: 9, pri: 3 });

      /* case clears the port at ~9 ms */
      if (self && pdetail) caseOut(b, T0 + jt + 0.0090 + rr(0, 0.0018), 0.85 * pmv);

      /* 12.57 ms: slide into the frame. The long contact time is why this is a
         thud and not a click - a 1.4 ms force pulse has its first null near
         700 Hz, so almost all of it is below that. */
      /* The slide impact is the one event in either cue that gets LESS timing
         jitter than the rest, and it is not an oversight. It was measured at
         12.57 ms with a standard deviation of 0.15 ms over ten shots - a
         mechanically determined instant, far tighter than the 0-2.8 ms of slop
         the cue applies everywhere else. Passing the full jt put nearly a
         quarter of shots past 15 ms, i.e. wandering further than the real
         mechanism does. A third of it, plus its own narrow tolerance. */
      var tR = T0 + jt * 0.35 + 0.0126 + rr(-0.0006, 0.0008);
      tn(b, { t: tR, dur: 0.030 + rr(0, 0.010), f0: rr(320, 400), f1: rr(150, 200),
              vol: 0.115 * pmv, type: 'triangle', atk: 0.0013, drive: 'soft', pri: 3 });
      nz(b, { t: tR, dur: 0.014 + rr(0, 0.008), vol: 0.050 * pmv, atk: 0.0007,
              ftype: 'bandpass', f0: rr(700, 1050), f1: rr(300, 460), q: 1.3, pri: 3 });
      /* the slide shell ringing out on top - a hollowed steel bar, 2-4 kHz */
      tick(b, { t: tR + 0.0004, f: rr(2300, 3600) * rr(0.94, 1.07),
                vol: 0.030 * pmv, dur: 0.026, q: 11, pri: 2 });

      /* 40 ms: into battery. Less energy than the rear impact but a far
         smaller contact patch and steel on steel both sides, so it is the
         sharper and the more recognisable of the two. */
      var tB = T0 + jt + 0.0400 + rr(-0.0015, 0.0025);
      tick(b, { t: tB, f: rr(1900, 2600) * rr(0.92, 1.10),
                vol: 0.090 * pmv, dur: 0.038, q: 7, body: true, pri: 3 });
      tick(b, { t: tB + 0.0008, f: rr(4400, 6200), vol: 0.026 * pmv, dur: 0.014, q: 12, pri: 2 });
      /* recoil spring, quietly, on the counter-recoil stroke where it is loudest */
      if (self && Math.random() < 0.55)
        nz(b, { t: T0 + jt + 0.020 + rr(0, 0.008), dur: rr(0.040, 0.075), vol: 0.014, atk: 0.004,
                ftype: 'bandpass', f0: rr(900, 1400), f1: rr(500, 800), q: 8,
                buf: 'grit', rate: rr(1.0, 1.7), pri: 1 });
    }

    /* --- 6. tail. This used to fire unconditionally and was 55% of the whole
       pistol voice budget: two 330 ms layers at -26 dB, of which consecutive
       ones are inaudible inside each other. Gated the way the rifle's is. --- */
    var pRep = self ? 0.50 : 0.55;
    if (live.length > CAP * 0.62) pRep *= 0.45;
    if (opening || Math.random() < pRep)
      report(b, (0.46 + b.far * 0.24) * (opening ? 1.14 : 1), T0 + jt);

    if (self && !b.ownShot) duck(0.36, 0.16);
    return true;
  }

  function cueShotgun(x, z) {
    var b = newBus(x, z, { cat: 'weapon', wet: 1.15, pan: 0.16, shot: true });
    var self = b.firstPerson, ss = subScale(b);
    var nearGate = self || b.dist < 30;

    /* NO ballistic crack: buckshot is subsonic. All blast, and the absence of
       the crack is exactly what makes a shotgun identifiable by ear. */
    blast(b, 'shotgun', { near: self ? 0.80 : 0.66, far: 0.60, drive: self ? 'blast' : null });

    tn(b, { t: 0.0014, dur: 0.34, f0: 108, f1: 29, vol: 0.42 * ss, type: 'sine', atk: 0.0022, pri: 5 });
    tn(b, { t: 0.003, dur: 0.20, f0: 196, f1: 58, vol: 0.20 * ss, type: 'triangle', atk: 0.0018, drive: 'soft', pri: 4 });
    nz(b, { t: 0.002, dur: 0.12, vol: 0.22 * b.near, atk: 0.0011,
            ftype: 'bandpass', f0: rr(680, 860), f1: 210, q: 1.1, pri: 4 });

    /* pump action: timings match the viewmodel + casing eject at .23 / .43 */
    if (nearGate) {
      var p1 = 0.225 + rr(-0.008, 0.008);
      nz(b, { t: p1, dur: 0.075, vol: 0.055, atk: 0.012, ftype: 'bandpass', f0: 1150, f1: 2450, q: 3.4, pri: 2 });
      tick(b, { t: p1 + 0.052, f: 2450, vol: 0.075, dur: 0.048, q: 8 });
      tick(b, { t: p1 + 0.062, f: 5400, vol: 0.030, dur: 0.022, q: 12 });   /* shell out */
      var p2 = 0.425 + rr(-0.01, 0.01);
      nz(b, { t: p2, dur: 0.060, vol: 0.048, atk: 0.010, ftype: 'bandpass', f0: 2300, f1: 1050, q: 3.0, pri: 2 });
      tick(b, { t: p2 + 0.048, f: 1650, vol: 0.105, dur: 0.070, q: 5, body: true });
      nz(b, { t: p2 + 0.050, dur: 0.055, vol: 0.045, atk: 0.001, ftype: 'lowpass', f0: 420, f1: 130, q: 0.8, pri: 2 });
    }
    report(b, 1.0 + b.far * 0.34, 0);
    if (self && !b.ownShot) duck(0.46, 0.24);
    return true;
  }

  function cueChain(x, z) {
    var b = newBus(x, z, { cat: 'weapon', wet: 0.75, pan: 0.08, shot: true });
    var self = b.firstPerson, ss = subScale(b);
    /* Per-round variation. Without this, 12 rounds a second is audibly one
       sample retriggered, which is the single loudest "browser game" tell.
       Pitch, level, timing and an even/odd barrel character all move, and the
       blast bank rotates variants on top of that. */
    var n = chain.seq++;
    var alt = (n & 1) ? 1 : 0;
    var jv = rr(-0.13, 0.10);
    var jt = rr(0, 0.0035);

    ballistic(b, (self ? 0.26 : 0.50 * cl(1 - b.dm / 100, 0.2, 1)) * (1 + jv), false);
    /* Twelve rounds a second is where a shared transient bank would start to
       be heard as one sample retriggered, so on top of the variant rotation
       and the pitch jitter every round also gets its own resonance: an
       even/odd barrel bias plus a continuous random offset. Free - it is one
       pooled biquad that the layer needed anyway. */
    blast(b, 'chain', {
      near: (self ? 0.56 : 0.48) * (1 + jv), far: 0.46 * (1 + jv),
      drive: self ? 'blast' : null,
      peak: (alt ? 2400 : 1750) * rr(0.78, 1.28),
      peakg: (alt ? 2.6 : -2.0) + rr(-1.8, 1.8),
      peakq: rr(0.7, 2.2)
    });

    tn(b, { t: jt, dur: 0.055 + rr(0, 0.012), f0: 205 * rr(0.92, 1.08), f1: 62,
            vol: 0.135 * ss * (1 + jv), type: 'sawtooth', atk: 0.0009, lp: 900, drive: 'soft', pri: 4 });
    nz(b, { t: jt + 0.001, dur: 0.05 + rr(0, 0.02), vol: 0.10 * b.near * (1 + jv), atk: 0.0008,
            ftype: 'bandpass', f0: rr(2400, 3900), f1: 700, q: 1.1, pri: 3 });

    /* belt feed / bolt: jittered independently so the mech does not lock to
       the report and turn into a machine-gun rhythm section */
    if (self || b.dist < 30) {
      tick(b, { t: jt + 0.014 + rr(0, 0.006), f: 2400 * rr(0.92, 1.1), vol: 0.036 * (1 + jv), dur: 0.020, q: 8 });
      if ((n % 3) === 0) tick(b, { t: jt + 0.030 + rr(0, 0.008), f: 3900, vol: 0.020, dur: 0.014, q: 12 });
    }
    if (Math.random() < (self ? 0.26 : 0.55)) report(b, 0.30 + b.far * 0.34, jt);

    if (self) {
      /* sustained layer: a spinning-motor bed under the per-shot transients.
         This is what turns 12 discrete impulses into one machine. */
      chain.spin = Math.min(1, chain.spin + 0.30);
      chain.last = ctx.currentTime;
      if (!b.ownShot) duck(0.22, 0.12);
    }
    return true;
  }

  /* ---------------------------------------------------------------- rifle --
     A 5.56 carbine at 9.5 rounds a second. Everything here is arranged around
     one problem: at a 105 ms shot interval the ear stops hearing shots and
     starts hearing a texture, and whether that texture reads as a rifle or as
     a stuck sampler is decided entirely by what overlaps and what does not.

     So the layers are deliberately split into three timescales:

       SHORT, locked to the beat  - the supersonic crack (6 ms, observers only)
         and the fast half of the mech: unlock at 2 ms, case out at 14 ms,
         buffer bottoming at 24 ms. These are the articulation, nine and a half
         distinct events a second, and they must stay clear of the next round.
       MID, one per shot, nearly filling the gap - the return to battery at
         70 ms. It ends around 104 ms against a 105 ms interval, which is not
         an accident: a real carbine is only just getting the bolt home before
         the next round goes, and that near-collision is what makes sustained
         fire sound mechanical rather than sampled.
       LONG, free to overlap      - the blast body (58 ms buffer + a ~95 ms
         live band), the buffer spring (75-265 ms) and the tail (240-590 ms).
         These fuse across shots into the continuous roar underneath, which is
         what a real rip sounds like. The spring deliberately overlaps: it rings
         two orders of magnitude longer than the blast, and a shooter hears the
         previous round's spring under the current round's report.

     Against the neighbours:
       vs PISTOL   T is 0.36 ms against 0.20 - the rifle's blast pulse is the
                   LONGER and LOWER of the two, because pulse duration scales
                   as the cube root of the energy released and a 5.56 burns
                   five times the powder. What makes it read sharper is the
                   steeper shock front and, for anyone downrange, the N-wave -
                   not the pulse length. The live top sits at 4.2-6.2 kHz
                   against 3.4-5.2, and the body decays in 18 ms instead of
                   ringing. The mech is also a different machine: a gas-driven
                   carrier over 70 ms against a recoiling slide over 40.
       vs CHAINGUN the chaingun owns the low end (gasAmp 0.78, a sustained
                   motor bed, 12 rps) and reads rotary. The rifle's sustain is
                   a buffer spring rather than a motor - inharmonic, decaying,
                   and gone between bursts - so it reads precise and
                   semi-mechanical rather than heavy.
     -------------------------------------------------------------------- */
  function cueRifle(x, z, supp) {
    var b = newBus(x, z, { cat: 'weapon', wet: supp ? 0.5 : 0.9, pan: 0.12, shot: true });
    var self = b.firstPerson, ss = subScale(b);
    var nearGate = self || b.dist < 28;
    supp = supp === true;

    /* SUPPRESSED. A can is not a volume knob and it is not a low-pass either.
       What it does is drop the release pressure and smear the release over
       time, so the SHOCK goes - rise time stretches by more than an order of
       magnitude and the peak falls 24-26 dB at the left ear - while the low
       frequency content is much less affected. Measured 1/3-octave sound power
       shows the largest reduction below 2 kHz and an actual INCREASE between
       1.6 and 6 kHz, because the baffle stack becomes a new high-frequency
       source of its own. So: big cut, biggest in the low mids, plus a fresh
       band of jetting hiss that was not there before. Relatively speaking the
       residual is BRIGHTER than the unsuppressed shot, not darker.

       And the mechanism does not get quieter at all - which is the point, and
       also the trap. Unsuppressed, a 160 dB blast forward-masks a 130 dB action
       for 100-200 ms and you hear one event; drop the blast to 134-140 and the
       carrier returning to battery, measured at 132 dBZ at the shooter's ear,
       is suddenly co-equal with it. But that unmasking is ALREADY PAID FOR by
       the 0.085 scale on the blast below. Boosting the mech on top of it as
       well double-counts, and the first version of this did exactly that: it
       multiplied the mech by 2.5 and ended up with the bolt 11 dB LOUDER than
       the muzzle, when the measurements put it 2-8 dB under.

       So mechM is 1.15, not 2.5, and the 1.15 is not a mix fudge either: a can
       raises back-pressure and drives the carrier measurably harder - cyclic
       rate goes up 5-15% and more gas comes out of the port - so the mechanism
       genuinely is a little louder with one fitted. Everything else you hear is
       the blast getting out of the way. */
    var mechM = supp ? 1.15 : 1;

    /* Per-shot decorrelation. Nine and a half shots a second is well past the
       point where a shared transient bank is heard as one sample retriggered,
       so four independent things move on every round: the bank variant (never
       twice running), the playback rate (+-70 cents), an alternating plus a
       continuous resonance offset, and the level. Timing is jittered too, but
       NOT on the crack - see below. */
    var n = rifleSeq++;
    var alt = (n & 1) ? 1 : 0;
    var jv = rr(-0.11, 0.09);        /* +-1 dB of level */
    var jt = rr(0, 0.0032);          /* up to 3.2 ms of internal slop */
    /* Is this the round that OPENS fire, or round nine of a burst? The first
       shot out of silence is the one that tells the player what the weapon is
       and what room it is in, so it gets everything. The ones after it are
       texture, and texture can be thinned. Measured across all shooters,
       because what is being protected is one shared voice pool. */
    var opening = (ctx.currentTime - rifleLast) > 0.25;
    rifleLast = ctx.currentTime;

    /* --- 0. the precursor. Trigger, sear and hammer, then the powder burning
       and the bullet running the bore, radiated through the receiver into your
       cheek about 2 ms before the muzzle uncorks. Measured at ~123 dB peak at
       a shooter's head, i.e. some 31 dB under the blast, which is exactly
       loud enough to be felt as "I fired this" and not loud enough to be heard
       as a separate noise. --- */
    if (self) preTransient(b, { searF: 2250, boreF: 470, vol: supp ? 1.35 : 1 });
    var T0 = self ? MECH_T0 : 0;

    /* --- 1. supersonic crack ------------------------------------------------
       For OBSERVERS ONLY. The shooter is behind the apex of the Mach cone and
       receives no ballistic shock from their own round - see the long note at
       the head of section 15b. This layer used to run at 0.38 for the player,
       second loudest thing in the cue; it is now zero for them and unchanged
       for everyone else, because a rifle fired AT you absolutely does crack.

       nodl:true, t=0, no jitter. This is the only layer whose timing is
       nailed down, and that is on purpose: it is the layer that carries the
       rhythm, and 3 ms of wander on it at 9.5 rps is audible as a flam.
       Everything else in the cue is allowed to slide around behind it.
       The rate scales DOWN with distance because the N-wave's duration grows
       as (miss distance)^0.25 - so a rifle across the map goes from a whip
       crack to a flatter snap without changing bank.

       A can does not touch this. Measured either side of the same suppressor
       at 55 yards: M855 reads 148.5 dB unsuppressed and 148.1 suppressed. The
       N-wave is a function of Mach number and nothing else, which is why a
       suppressed supersonic rifle is still loud to the man downrange. --- */
    if (!self)
      ballistic(b, 0.62 * cl(1 - b.dm / 110, 0.20, 1) * (1 + jv), false, {
        rate: rr(1.04, 1.26) * cl(1 - b.dm / 300, 0.72, 1),
        hp: 420,                                   /* keep it clear of the body */
        peak: (alt ? 4300 : 3050) * rr(0.82, 1.24),
        peakg: (alt ? 3.4 : 1.5) + rr(-2.2, 2.2),
        peakq: rr(0.8, 2.4)
      });

    /* --- 2. muzzle blast body: the pre-rendered near/far pair. The random
       peaking bump lives in 340-780 Hz, i.e. inside the body band, and flips
       between an "open" and a "scooped" character on alternate rounds. That
       alternation is what stops a long burst from developing a fixed comb
       colour, which is the specific way retriggered gunfire goes phasey. --- */
    blast(b, 'rifle', {
      t: T0,
      near: (self ? 0.64 : 0.56) * (1 + jv) * (supp ? 0.085 : 1),
      far: 0.50 * (1 + jv) * (supp ? 0.075 : 1),
      /* 'blastLite' rather than 'blast' on the self path. The old curve lifted
         a 0.05 sample by 2.84x while leaving the peak alone - about 9.7 dB of
         crest factor thrown away, applied ONLY to the player's own shot, at
         precisely the range where a real 5.56 has the most crest there is to
         keep. It made your rifle rounder and bigger than the enemy's, which is
         backwards in every way that matters. */
      drive: self ? 'blastLite' : null,
      jit: 0.55,                                 /* +-70 cents, not +-1.3 st */
      /* suppressed, the release is stretched rather than shocked: the peak
         moves down into the low mids and the top comes off the front edge */
      lp: supp ? rr(2300, 4200) : undefined,
      peak: supp ? rr(280, 420) : (alt ? 620 : 430) * rr(0.80, 1.26),
      peakg: supp ? (2.0 + rr(-1.4, 1.4)) : ((alt ? 2.4 : -2.2) + rr(-1.6, 1.6)),
      peakq: rr(0.8, 2.4)
    });

    /* Suppressed baffle jetting. Counter-intuitive and measured: 1/3-octave
       sound power goes UP between 1.6 and 6 kHz when you fit a can, because
       gas tearing through a stack of small orifices is a broadband source that
       simply did not exist before. Without this the suppressed rifle sounds
       like the unsuppressed one behind a blanket, which is the standard way
       games get suppressors wrong. */
    if (supp)
      nz(b, { t: T0 + jt + 0.0008, dur: 0.030 + rr(0, 0.026), vol: 0.075 * b.near * (1 + jv), atk: 0.0016,
              ftype: 'bandpass', f0: rr(2100, 3400), f1: rr(1100, 1700), q: 0.6, pri: 4 });

    /* The two live layers exist to decorrelate the NEAR rendering - they are
       what stops consecutive rounds from laying the same waveform over each
       other. Once the near/far crossfade has handed over, the far bank is
       already the correct timbre and these two are contributing about -25 dB
       for a full voice slot each, so they stop. At 9.5 rps with several
       shooters that is the single largest saving in the cue. */
    if (b.near > 0.12 && !supp) {
      /* live body: a 200-900 Hz band falling to 235 Hz over ~95 ms. At 105 ms
         spacing consecutive bodies just barely overlap, which is the fused
         roar the crack articulates on top of. */
      nz(b, { t: T0 + jt + 0.0012, dur: 0.088 + rr(0, 0.018), vol: 0.150 * b.near * (1 + jv), atk: 0.0009,
              ftype: 'bandpass', f0: rr(760, 980), fmid: rr(400, 520), f1: 235, q: 0.95,
              drive: self ? 'soft' : null, pri: 4 });
      /* live top: the HF energy that separates 5.56 from 9 mm. With the crack
         correctly gone from the self path this is now carrying the bite on
         your own rifle, so it is up from 0.110 - and it is the RIGHT source
         for it, being blast shock and near-field scatter rather than a shock
         cone you are standing behind. */
      nz(b, { t: T0 + jt + 0.0008, dur: 0.030 + rr(0, 0.012),
              vol: (self ? 0.168 : 0.110) * b.near * (1 + jv), atk: 0.0006,
              ftype: 'bandpass', f0: rr(4200, 6200), f1: 1900, q: 1.3, shape: 'lin', pri: 4 });
      /* Hard near-field scatter: your own optic, rail and chest are rigid
         surfaces a hand's width from the muzzle blast, and they throw a bright
         copy back at your ear a few hundred microseconds later. First-person
         only - nobody else is standing inside your rifle. */
      if (self)
        nz(b, { t: T0 + jt + 0.0004 + rr(0, 0.0007), dur: 0.010 + rr(0, 0.008),
                vol: 0.085 * (1 + jv), atk: 0.0004,
                ftype: 'bandpass', f0: rr(5200, 8800), f1: rr(2400, 3600), q: 0.9,
                shape: 'lin', pri: 3 });
    }

    /* --- 3. low thump. 116 -> 44 Hz in 72 ms: present, brief, and roughly
       half the shotgun's weight. A rifle you can feel; it is not a boom -
       and past about 22 m you do not feel it at all, so it stops rather than
       spending a voice on 30 dB below the crack. --- */
    if (ss > 0.12)
      tn(b, { t: T0 + jt + 0.0009, dur: 0.072 + rr(0, 0.014), f0: 116 * rr(0.94, 1.07), f1: 44,
              vol: 0.195 * ss * (1 + jv) * (supp ? 0.30 : 1), type: 'sine', atk: 0.0013, pri: 5 });

    /* --- 4. the bolt carrier group, at measured times ------------------------
       The old version put three bright pings at 15.5, 26 and 40.5 ms. Two of
       those are at instants when nothing happens, and the loudest event in the
       entire cycle was not there at all. The real sequence, timed from primer
       ignition and therefore quoted here relative to the muzzle blast:

         +2.1 ms  bolt unlocks. Gas reached the carrier at essentially the same
                  moment the bullet left - in a carbine the action is already
                  being loaded while the round is still in the bore - and the
                  carrier picks up the bolt 2.4 ms after the bullet passed the
                  gas port, having travelled 7.6 mm at 6.3 m/s. A dry cam-pin
                  scrape, no ring.
         +14 ms   case clears the ejection port. Brass off the deflector: the
                  one high-Q, genuinely bell-like event in the cycle.
         +24 ms   buffer bottoms in the receiver extension. This is the loudest
                  REARWARD event and it must be DULL - hardened steel into
                  anodised ALUMINIUM, which is low density and high loss, so it
                  thuds like wood rather than ringing like steel. The loose
                  weights inside the buffer shift and strike about a
                  millisecond later, splitting the transient in two; that dead-
                  blow action is the whole reason the weights are in there.
         +70 ms   bolt returns to battery and locks. Steel lugs into a steel
                  barrel extension: brighter, harder, and the loudest single
                  mechanical event of the cycle - it has been measured at
                  132 dBZ at the shooter's ear, which is within a few dB of a
                  SUPPRESSED muzzle blast. Nothing marked this before.

       Each tick is jittered independently of the shot and of each other so the
       mech never phase-locks to the report. --- */
    if (nearGate) {
      /* MECH_G is the one number that sets how loud the whole machine is
         against the blast, and it is set from the measurement rather than by
         ear. The bolt returning to battery has been metered at 132 dBZ at the
         shooter's ear against an unsuppressed muzzle blast of 158-162 dB peak,
         i.e. about 28 dB down. The per-layer numbers below carry the internal
         balance of the mechanism - battery louder than buffer, buffer louder
         than unlock - and this scales the lot to land the battery slam at that
         28 dB.

         Getting this wrong is not subtle and it propagates: suppressed level is
         entirely determined by the unsuppressed ratio, because a can scales the
         blast and leaves the mechanism alone. At the first value here the bolt
         sat 18.6 dB under the blast, which after the 21.4 dB suppressed scale
         put it 4 dB OVER it - the opposite of the 2-8 dB under that was
         measured. Fixing that by cutting mechM would have meant claiming a
         suppressor makes a bolt carrier quieter, which it does not; the error
         was here.

         Note this is 28 dB below the blast PEAK, not below what is still
         sounding at 70 ms - and those are very different numbers. Measured at
         the instant the bolt actually lands, the blast buffer has already
         stopped (it ends at 67.6 ms) and the live body is 45 dB down. What is
         still there is the two report() tails, 3.7 and 6.0 dB off their own
         peaks, and the slam clears their combined power by about 5 dB - in a
         band they barely occupy, since the slam is a 1.6-2.3 kHz ping against
         a 1350->250 Hz roll and a 118 Hz sine. So it is masked, not buried,
         and that distinction is what the whole suppressed path turns on. */
      var MECH_G = 0.337;
      var mv = (1 + jv) * mechM * MECH_G;
      /* Detail thinning. The mech block is now the most expensive thing in the
         cue - it was 14 voices against the tail's 4 - and unlike the tail it
         had no yield path at all, which on the 34-voice low tier meant the
         player's own sustained fire could saturate the pool by itself and start
         stealing enemy footsteps. These two layers are the ones to drop: they
         are near-field detail nobody misses under pressure, and dropping them
         costs 5 voices a shot. */
      var detail = TIER !== 'low' && live.length < CAP * 0.55;

      /* Unlock: a dry cam-pin scrape in a steel-lined track. Deliberately NOT
         tick() - tick plays the inharmonic ping bank, which rings, and the one
         thing this event does not do is ring. Its `q` would have been ignored
         there anyway; the ping path only reads f and dur. */
      nz(b, { t: T0 + jt + 0.0021 + rr(0, 0.0008), dur: 0.005 + rr(0, 0.004),
              vol: 0.026 * mv, atk: 0.0005, ftype: 'bandpass',
              f0: rr(1800, 3000), f1: rr(3600, 5800), q: 0.85, shape: 'lin', pri: 3 });

      /* gas out of the ejection port, past your face and biased right. A
         suppressor cannot touch this - it is upstream of the can, which is
         exactly why the right ear only loses 10-18 dB when the left loses
         20-30. Suppressed it becomes one of the loudest things in the cue. */
      if (self && detail) portGas(b, T0 + jt + 0.0030 + rr(0, 0.0012), 0.7 * mv, supp);

      /* case out */
      if (self && detail) caseOut(b, T0 + jt + 0.0140 + rr(0, 0.0035), 0.9 * mv);

      /* buffer bottoming: dull, aluminium, plus the weights a beat behind */
      var tBuf = T0 + jt + 0.0240 + rr(0, 0.0040);
      tn(b, { t: tBuf, dur: 0.026 + rr(0, 0.012), f0: rr(230, 300), f1: rr(110, 150),
              vol: 0.052 * mv, type: 'triangle', atk: 0.0016, drive: 'soft', pri: 3 });
      nz(b, { t: tBuf, dur: 0.016 + rr(0, 0.010), vol: 0.030 * mv, atk: 0.0009,
              ftype: 'bandpass', f0: rr(600, 950), f1: rr(260, 400), q: 1.1, pri: 2 });
      tick(b, { t: tBuf + 0.0010 + rr(0, 0.0007), f: rr(1100, 1700),
                vol: 0.020 * mv, dur: 0.018, q: 6, pri: 2 });

      /* the spring. Fired on every round when it is your gun, but only given
         its full 150-265 ms ring-down when the previous one has actually
         decayed - at 105 ms spacing three overlapping tails is a drone, not a
         twang. Suppressed it is markedly louder because nothing is masking it
         and because it reaches you through the stock rather than the air. */
      if (self) {
        var longTail = (ctx.currentTime - springLast) > 0.16 && detail;
        bufferSpring(b, tBuf + 0.0035 + rr(0, 0.0030), mv, longTail);
        springLast = ctx.currentTime;
      }

      /* INTO BATTERY - the loudest mechanical event there is, and it was
         missing entirely. Steel on steel, bright, hard, small contact patch.
         At a 105 ms shot interval it lands cleanly inside the gap. */
      var tBat = T0 + jt + 0.0700 + rr(-0.0025, 0.0055);
      tick(b, { t: tBat, f: rr(1600, 2300) * rr(0.93, 1.09),
                vol: 0.072 * mv, dur: 0.034, q: 6, body: true, pri: 3 });
      tick(b, { t: tBat + 0.0009, f: rr(4200, 6400), vol: 0.030 * mv, dur: 0.013, q: 12, pri: 2 });
    }

    /* --- 5. tail. The convolver already gives every shot the room for free;
       report() adds the low roll and, at range, the discrete slap-backs.
       It is fired on a coin toss rather than every round because at 9.5 rps a
       guaranteed 2-4 extra voices per shot with a 0.24-0.60 s life is a dozen
       standing voices that buy nothing - consecutive tails are inaudible
       inside each other, so all they do is crowd the pool.

       And the odds get cut again once the pool is more than about two thirds
       full. This is the whole reason the rifle can be full-auto without
       starving anything: the tail is the ONLY layer in the cue that is both
       expensive and redundant, so it is the one that yields. A squad-sized
       firefight sheds rifle tails and keeps enemy footsteps, which is the
       correct trade every time. --- */
    var pRep = self ? 0.42 : 0.46;
    if (live.length > CAP * 0.62) pRep *= 0.42;
    /* Suppressed: the opening shot only. A can leaves so little energy for the
       room to work on that consecutive tails are inaudible inside each other,
       and the first one is the only one carrying information about where you
       are. Written as an explicit branch rather than folded into pRep, because
       the combined form silently made pRep unreachable in the suppressed case. */
    if (supp ? opening : (opening || Math.random() < pRep))
      report(b, (0.50 + b.far * 0.28) * (opening ? 1.16 : 1) * (supp ? 0.30 : 1), T0 + jt);

    /* Release just longer than the shot interval, so a burst settles to a
       steady -2.3 dB tilt instead of pumping at 9.5 Hz.
       Suppressed, there is far less to duck AND the point is that you can hear
       the world through your own fire, so it barely engages. */
    if (self && !b.ownShot) duck(supp ? 0.09 : 0.26, supp ? 0.07 : 0.115);
    return true;
  }

  /* Suppressed rifle. The game emits sfx('rifleq') the moment you press J, and
     until now this module had no handler for that name at all - the cue fell
     straight through to the stock inline synthesis in NUKEM.html, so fitting a
     can silently dropped the entire audio engine. */
  function cueRifleQ(x, z) { return cueRifle(x, z, true); }

  /* ------------------------------------------------- rifle reload mechanics
     Three cues, emitted by the weapons module at its own choreography points.
     They are all on the WEAPON bus: it is never ducked, because your own hands
     working the gun is exactly the information you must not lose in a firefight.

     The material story is the whole point. An AR magazine is glass-filled
     polymer in an aluminium well, and polymer is the opposite of everything
     else in this file: it is DARK, it is LOW-Q, and it does not ring. So the
     mag cues are built from short low-Q knocks and box modes with tau under
     20 ms, while the bolt cue - which is steel into aluminium - gets the
     inharmonic ping bank and a 100-170 ms ring-down. Play them back to back
     and you should be able to hear which parts are plastic.
     -------------------------------------------------------------------- */

  /* Mag release: steel detent, polymer sliding on aluminium, spring and the
     column of rounds shifting as the box swings free, then the deck. */
  function cueRifleMagOut(x, z) {
    var b = newBus(x, z, { cat: 'weapon', wet: 0.5, pan: 0.13 });
    var near = b.self || b.dist < 26;

    /* 1. the catch. A steel detent in an aluminium receiver: tiny, crisp,
       and much higher than anything else in the cue. */
    tick(b, { t: 0, f: 3250 * rr(0.94, 1.07), vol: 0.062, dur: 0.014, q: 12 });
    nz(b, { t: 0, dur: 0.008, vol: 0.030, atk: 0.0005, ftype: 'highpass',
            f0: 5200, q: 0.6, shape: 'lin', pri: 3 });

    /* 2. the magazine breaks free and slides down the well. Polymer on
       aluminium is a dry scrape with no pitch centre at all - grit noise
       through a falling band, not a filtered tone. */
    var t1 = 0.022 + rr(0, 0.010);
    nz(b, { t: t1, dur: rr(0.048, 0.078), vol: 0.042, atk: 0.006, ftype: 'bandpass',
            f0: rr(900, 1300), fmid: rr(600, 820), f1: rr(340, 480), q: 1.5,
            buf: 'grit', rate: rr(0.80, 1.25), pri: 2 });

    /* 3. it clears the well: a hollow polymer knock. Low Q, dark, dead. */
    var t2 = t1 + 0.040 + rr(0, 0.014);
    tick(b, { t: t2, f: 780 * rr(0.92, 1.10), vol: 0.070, dur: 0.030, q: 4, body: true });
    tn(b, { t: t2, dur: 0.055, f0: rr(214, 268), f1: rr(120, 150), vol: 0.060,
            type: 'triangle', lp: 900, atk: 0.0012, pri: 3 });

    /* 4. spring rattle: the follower and the stack of rounds shifting inside
       the box as it swings out of the hand. Count, timing and pitch all move,
       because a rattle that repeats is a rattle you stop believing. */
    if (near) {
      var nr = 3 + ((Math.random() * 3) | 0);
      for (var i = 0; i < nr; i++)
        nz(b, { t: t2 + 0.006 + rr(0, 0.075), dur: rr(0.008, 0.022), vol: rr(0.008, 0.021),
                atk: 0.0006, ftype: 'bandpass', f0: rr(1900, 4400), q: rr(8, 18), pri: 1 });
      nz(b, { t: t2 + 0.010, dur: rr(0.05, 0.11), vol: 0.016, atk: 0.008, ftype: 'bandpass',
              f0: rr(2400, 3600), f1: rr(1100, 1800), q: 5, buf: 'grit', rate: rr(1.2, 2.0), pri: 1 });
    }

    /* 5. the deck. Two knocks with the restitution spacing cueCase() uses, but
       polymer, so: dull, dark and gone. On carpet or dirt it barely happens. */
    var w = world();
    var surf = isNum(x) && isNum(z) ? surfaceAt(x, z)
                                    : (w ? surfaceAt(w.player.x, w.player.z) : 'concrete');
    var soft = (surf === 'carpet' || surf === 'dirt' || surf === 'water');
    var t3 = t2 + rr(0.20, 0.30), amp = soft ? 0.026 : 0.058;
    var dt = rr(0.055, 0.085), e = soft ? rr(0.22, 0.34) : rr(0.44, 0.60);
    for (var k = 0; k < (soft ? 1 : 2); k++) {
      tick(b, { t: t3, f: rr(560, 760) * (soft ? 0.8 : 1), vol: amp, dur: 0.026, q: 3.5, body: true });
      nz(b, { t: t3, dur: rr(0.020, 0.038), vol: amp * 0.5, atk: 0.0008, ftype: 'lowpass',
              f0: rr(900, 1400), f1: rr(220, 340), q: 0.8, pri: 1 });
      t3 += dt; dt *= e; amp *= Math.pow(e, 1.5);
    }
    return true;
  }

  /* Mag in: the fresh magazine arrives, catches the lip of the well, and is
     driven home. The seat is the money layer - a hollow polymer box being
     struck, with the steel catch snapping over its notch ~10 ms LATER. That
     gap is what makes the seat read as firm rather than as a bump; run the
     two together and it turns into one flat click. */
  function cueRifleMagIn(x, z) {
    var b = newBus(x, z, { cat: 'weapon', wet: 0.5, pan: 0.13 });
    var near = b.self || b.dist < 26;

    /* hand and magazine arriving: cloth and air, no pitch */
    nz(b, { t: 0, dur: rr(0.055, 0.085), vol: 0.026, atk: 0.020, ftype: 'bandpass',
            f0: rr(1600, 2400), f1: rr(700, 1100), q: 1.2, buf: 'pink', pri: 2 });

    /* the mag mouth catching the lip of the well: light, glancing */
    var t1 = 0.040 + rr(0, 0.014);
    tick(b, { t: t1, f: 1750 * rr(0.90, 1.12), vol: 0.038, dur: 0.018, q: 7 });

    /* THE SEAT. A struck polymer box: a hard low-mid thock, the box's own
       fundamental around 190 Hz with a second mode near 400, and a dark knock
       body. Everything decays inside 90 ms - polymer does not sustain. */
    var t2 = t1 + 0.028 + rr(0, 0.010);
    nz(b, { t: t2, dur: 0.030, vol: 0.100, atk: 0.0007, ftype: 'lowpass',
            f0: rr(760, 980), f1: 230, q: 0.8, drive: 'soft', pri: 4 });
    tn(b, { t: t2, dur: 0.085, f0: rr(178, 214), f1: rr(96, 118), vol: 0.115,
            type: 'triangle', lp: 780, atk: 0.0013, pri: 4 });
    tn(b, { t: t2 + 0.0015, dur: 0.045, f0: rr(360, 430), f1: rr(210, 250), vol: 0.055,
            type: 'sine', atk: 0.0011, pri: 3 });
    tick(b, { t: t2, f: 900 * rr(0.92, 1.10), vol: 0.075, dur: 0.026, q: 4, body: true });

    /* the catch engaging: steel, crisp, high, and deliberately late */
    tick(b, { t: t2 + 0.010 + rr(0, 0.004), f: 3400 * rr(0.94, 1.08), vol: 0.055, dur: 0.013, q: 13 });

    /* the tug: everyone who has ever run this gun pulls down on the magazine
       to confirm it is locked, and the gun wiggles a little in the well. */
    if (near) {
      var t3 = t2 + 0.085 + rr(0, 0.035);
      tick(b, { t: t3, f: rr(1400, 2200), vol: 0.022, dur: 0.016, q: 8 });
      tick(b, { t: t3 + 0.030 + rr(0, 0.018), f: rr(1900, 2900), vol: 0.016, dur: 0.013, q: 10 });
      nz(b, { t: t3, dur: rr(0.030, 0.060), vol: 0.012, atk: 0.004, ftype: 'bandpass',
              f0: rr(2200, 3400), f1: rr(900, 1500), q: 6, buf: 'grit', rate: rr(1.1, 1.7), pri: 1 });
    }
    return true;
  }

  /* Bolt release: the palm slaps the paddle, the carrier runs forward off the
     buffer spring, and 30 ms later a 320 g steel carrier arrives in battery.
     That last event is the loudest thing the gun does that is not a shot, and
     unlike everything in the mag cues it is steel into aluminium, so it gets
     the inharmonic ping bank and a real ring-down. */
  function cueRifleBolt(x, z) {
    var b = newBus(x, z, { cat: 'weapon', wet: 0.62, pan: 0.13 });
    var near = b.self || b.dist < 30;

    /* 1. the slap. Flesh on aluminium: broadband, dull, completely dead - the
       hand damps the receiver, so there is no ring here at all. */
    nz(b, { t: 0, dur: 0.030, vol: 0.115, atk: 0.0008, ftype: 'lowpass',
            f0: rr(620, 860), f1: 190, q: 0.9, pri: 4 });
    nz(b, { t: 0, dur: 0.014, vol: 0.055, atk: 0.0005, ftype: 'bandpass',
            f0: rr(1700, 2400), q: 1.6, shape: 'lin', pri: 3 });
    tn(b, { t: 0.0005, dur: 0.045, f0: rr(148, 186), f1: 62, vol: 0.075,
            type: 'sine', atk: 0.0016, pri: 3 });

    /* 2. the catch lets go and the carrier runs: a short RISING hiss as the
       spring unwinds behind it. Rising, not falling - the thing is
       accelerating. */
    var t1 = 0.008 + rr(0, 0.004);
    nz(b, { t: t1, dur: rr(0.016, 0.028), vol: 0.045, atk: 0.002, ftype: 'bandpass',
            f0: rr(900, 1300), fmid: rr(1800, 2400), f1: rr(2600, 3600), q: 1.4,
            buf: 'grit', rate: rr(1.3, 2.1), pri: 3 });

    /* 3. INTO BATTERY. Hard contact transient, dark body, low thunk. */
    var t2 = t1 + 0.024 + rr(0, 0.007);
    tick(b, { t: t2, f: 1520 * rr(0.94, 1.07), vol: 0.155, dur: 0.055, q: 5, body: true });
    nz(b, { t: t2, dur: 0.020, vol: 0.100, atk: 0.0005, ftype: 'highpass',
            f0: rr(2600, 3800), q: 0.7, shape: 'lin', pri: 5 });
    nz(b, { t: t2, dur: 0.070, vol: 0.105, atk: 0.0009, ftype: 'lowpass',
            f0: rr(900, 1250), f1: 210, q: 0.85, drive: 'soft', pri: 4 });
    tn(b, { t: t2 + 0.0008, dur: 0.090, f0: rr(122, 152), f1: rr(52, 66), vol: 0.135,
            type: 'sine', atk: 0.0016, pri: 4 });

    /* 4. ring-down: the receiver and the barrel extension, inharmonic and
       short. This is the layer that says "metal" - drop it and the same
       envelope reads as a car door. */
    tick(b, { t: t2 + 0.0012, f: rr(3100, 4200), vol: 0.052, dur: 0.100, q: 12 });
    tn(b, { t: t2 + 0.002, dur: rr(0.10, 0.17), f0: rr(2350, 2900), f1: rr(2280, 2820),
            vol: 0.030, type: 'sine', atk: 0.0012, pri: 3 });
    tn(b, { t: t2 + 0.003, dur: rr(0.07, 0.13), f0: rr(3900, 4900), vol: 0.018,
            type: 'sine', atk: 0.0012, pri: 2 });

    /* 5. the buffer spring settling in the tube. Two close, detuned modes
       beating against each other under a high-Q noise band: the "sproing".
       It is the single most recognisable thing an AR does and it is why this
       cue cannot just be a generic metal slam. */
    if (near) {
      var sf = rr(430, 560);
      tn(b, { t: t2 + 0.004, dur: rr(0.13, 0.22), f0: sf, f1: sf * rr(0.86, 0.94),
              vol: 0.030, type: 'triangle', lp: 2400, atk: 0.004, drive: 'soft', pri: 2 });
      tn(b, { t: t2 + 0.006, dur: rr(0.10, 0.18), f0: sf * rr(1.42, 1.54), f1: sf * 1.30,
              vol: 0.018, type: 'sine', detune: rr(-24, 24), atk: 0.005, pri: 2 });
      nz(b, { t: t2 + 0.005, dur: rr(0.08, 0.15), vol: 0.014, atk: 0.006, ftype: 'bandpass',
              f0: sf * rr(1.8, 2.6), f1: sf * rr(1.1, 1.5), q: 11, pri: 1 });
    }
    return true;
  }

  function cueRPG(x, z) {
    var b = newBus(x, z, { cat: 'weapon', wet: 1.2, pan: 0.2, shot: true });
    var self = b.firstPerson, ss = subScale(b);
    if (self) tick(b, { t: 0, f: 1900, vol: 0.05, dur: 0.020, q: 8 });
    blast(b, 'rpg', { near: self ? 0.58 : 0.48, far: 0.44, drive: 'blast' });
    /* motor whoosh: rising band as the grain catches */
    nz(b, { t: 0.012, dur: 0.44, vol: 0.44, atk: 0.006, ftype: 'bandpass',
            f0: 420, fmid: 1900, f1: 2900, q: 0.65, buf: 'pink', drive: 'soft', pri: 5 });
    nz(b, { t: 0.014, dur: 0.30, vol: 0.30, atk: 0.004, ftype: 'lowpass', f0: 1100, f1: 130, q: 0.6, pri: 5 });
    /* departure: the rocket flies away - level down, top end down */
    nz(b, { t: 0.09, dur: 0.85, vol: 0.20, atk: 0.05, ftype: 'lowpass', f0: 3000, f1: 520, q: 0.7, buf: 'pink', pri: 3 });
    tn(b, { t: 0.09, dur: 0.80, f0: 260, f1: 96, vol: 0.055, type: 'sawtooth', atk: 0.08, lp: 700, pri: 3 });
    /* back-blast: pressure behind the shooter */
    tn(b, { t: 0.010, dur: 0.46, f0: 68, f1: 24, vol: 0.40 * ss, type: 'sine', atk: 0.004, pri: 5 });
    nz(b, { t: 0.012, dur: 0.36, vol: 0.26, atk: 0.005, ftype: 'lowpass', f0: 560, f1: 80, q: 0.7, buf: 'brown', pri: 4 });
    report(b, 0.86, 0.01);
    if (self && !b.ownShot) duck(0.5, 0.30);
    return true;
  }

  function cuePlasma(x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.25 });
    /* ring-modulated energy: two detuned sources through a folding shaper
       gives a metallic inharmonic spectrum for free */
    tn(b, { t: 0, dur: 0.30, f0: 1450, fm1: 620, f1: 235, vol: 0.20, type: 'sine', atk: 0.0018, pri: 4 });
    tn(b, { t: 0.002, dur: 0.26, f0: 2050, f1: 330, vol: 0.085, type: 'triangle', detune: 24, atk: 0.002, drive: 'fold', pri: 3 });
    nz(b, { t: 0, dur: 0.24, vol: 0.13, atk: 0.0018, ftype: 'bandpass', f0: 2600, f1: 520, q: 3.4, pri: 3 });
    nz(b, { t: 0.004, dur: 0.10, vol: 0.06, atk: 0.001, ftype: 'highpass', f0: 5200, q: 0.6, pri: 2 });
    tn(b, { t: 0.01, dur: 0.35, f0: 96, f1: 42, vol: 0.10, type: 'sine', atk: 0.006, pri: 3 });
    return true;
  }

  /* NULLSTAR is a field projector, so its three events share magnetic sweeps
     and clean containment intervals rather than any of the firearm banks.
     Fire travels OUT from a hard capacitor dump; arm climbs into a stable
     fifth; collapse does the opposite, converging before its pressure front. */
  function cueNullFire(x, z) {
    /* shot:true is intentional even without a muzzle blast: the projector is
       a full-power player weapon and must receive the same first-person lift
       and ownership detection as the conventional reports. */
    var b = newBus(x, z, { cat: 'weapon', wet: 0.92, pan: 0.17, shot: true });
    var self = b.firstPerson, ss = subScale(b);

    /* The contactor and arc arrive together. The very short folded band is
       electricity; the dark impulse underneath is the several-kilo field
       cage taking the reaction force. */
    tick(b, { t: 0, f: rr(4300, 5100), vol: 0.075, dur: 0.018, q: 13, pri: 5 });
    nz(b, { t: 0, dur: 0.030, vol: 0.215, atk: 0.0005, ftype: 'highpass',
            f0: 8200, f1: 2400, q: 0.72, drive: 'fold', shape: 'lin', pri: 5 });
    nz(b, { t: 0.001, dur: 0.105, vol: 0.310, atk: 0.0007, ftype: 'lowpass',
            f0: 1850, fmid: 430, f1: 92, q: 0.58, buf: 'pink', drive: 'soft', pri: 5 });

    /* Two falling magnetic modes make this a mass-driver release instead of
       a laser chirp. They separate quickly, while the sub is almost pitchless
       at the end and supplies the recoil weight at the player's chest. */
    tn(b, { t: 0.002, dur: 0.32, f0: rr(1780, 1950), fm1: rr(430, 510), f1: rr(96, 116),
            vol: 0.195, type: 'sawtooth', lp: 3600, atk: 0.0015, drive: 'soft', pri: 5 });
    tn(b, { t: 0.004, dur: 0.39, f0: rr(860, 980), fm1: rr(210, 250), f1: rr(47, 58),
            vol: 0.125, type: 'triangle', lp: 1900, detune: 17, atk: 0.0025, pri: 4 });
    tn(b, { t: 0.004, dur: 0.50, f0: rr(106, 118), f1: rr(24, 29),
            vol: 0.315 * ss, type: 'sine', atk: 0.003, pri: 5 });

    /* Ionised air peels away after the core has left. A narrow moving band is
       deliberately quieter than the driver body but carries the cue at range. */
    nz(b, { t: 0.018, dur: 0.35, vol: 0.145, atk: 0.008, ftype: 'bandpass',
            f0: 3900, fmid: 1450, f1: 310, q: 4.8, q1: 1.2,
            buf: 'pink', rate: rr(0.94, 1.08), pri: 4 });
    nz(b, { t: 0.010, dur: 0.16, vol: 0.070, atk: 0.002, ftype: 'bandpass',
            f0: 6100, f1: 1850, q: 9, buf: 'crackle', rate: rr(1.1, 1.5), pri: 2 });
    tick(b, { t: 0.060 + rr(0, 0.012), f: rr(1800, 2350), vol: 0.040,
             dur: 0.026, q: 8, body: true, pri: 2 });
    report(b, 0.72, 0.012);
    if (self) duck(0.50, 0.30);
    return true;
  }

  function cueNullArm(x, z) {
    /* This cue belongs to the core in the room, not to the player's hands.
       A generous send lets the rising lock reveal exactly where it attached. */
    var b = newBus(x, z, { cat: 'world', wet: 1.38, gain: 0.92 });
    tick(b, { t: 0, f: rr(2700, 3300), vol: 0.048, dur: 0.024, q: 11, pri: 4 });

    /* The bands tighten as they rise: diffuse field energy becoming a stable
       containment cage. The tones resolve to 680/1020/2040 Hz, an open fifth
       plus octave which stays identifiable through walls and reverb. */
    nz(b, { t: 0, dur: 0.25, vol: 0.082, atk: 0.055, ftype: 'bandpass',
            f0: 310, fmid: 1180, f1: 3400, q: 1.4, q1: 12,
            buf: 'pink', rate: rr(0.92, 1.10), pri: 3 });
    tn(b, { t: 0.004, dur: 0.40, f0: 340, fm1: 570, f1: 680,
            vol: 0.105, type: 'sine', atk: 0.024, pri: 4 });
    tn(b, { t: 0.016, dur: 0.42, f0: 510, fm1: 850, f1: 1020,
            vol: 0.080, type: 'sine', detune: 5, atk: 0.032, pri: 4 });
    tn(b, { t: 0.034, dur: 0.38, f0: 1020, fm1: 1680, f1: 2040,
            vol: 0.050, type: 'triangle', lp: 4800, detune: -7, atk: 0.038, pri: 3 });

    /* A quiet low fundamental appears only after the lock point; it is the
       audible promise that the armed core now has mass and is pulling. */
    tn(b, { t: 0.195, dur: 0.46, f0: 136, f1: 102,
            vol: 0.068, type: 'sine', atk: 0.018, pri: 3 });
    tick(b, { t: 0.205, f: rr(4700, 5400), vol: 0.036, dur: 0.045, q: 15, pri: 3 });
    return true;
  }

  function cueNullCollapse(x, z) {
    var b = newBus(x, z, { cat: 'world', wet: 1.65, gain: 0.98 });
    var ss = subScale(b), hit = 0.174;
    var close = cl(1 - b.dist / 120, 0.20, 1);

    /* Reverse-shaped, narrowing noise and two opposing glissandi converge on
       the same instant. The long attacks are crucial: a normal decaying sweep
       reads as a projectile, while this one audibly pulls the room inward. */
    nz(b, { t: 0, dur: hit, vol: 0.235, atk: 0.145, ftype: 'bandpass',
            f0: 240, fmid: 1450, f1: 7600, q: 0.75, q1: 15,
            buf: 'pink', rate: rr(0.92, 1.08), pri: 5 });
    tn(b, { t: 0, dur: hit, f0: 155, fm1: 840, f1: 3180,
            vol: 0.145, type: 'sine', atk: 0.142, pri: 5 });
    tn(b, { t: 0.004, dur: hit - 0.004, f0: 2380, fm1: 520, f1: 82,
            vol: 0.105, type: 'triangle', lp: 4200, detune: 19, atk: 0.136, pri: 4 });

    /* The centre snaps shut, then rebounds as a real pressure event. A modest
       boom-bank layer supplies microsecond attack definition; blastLite keeps
       its crest instead of squaring it off, and every live layer remains well
       below unity before the global glue compressor. */
    nz(b, { t: hit, dur: 0.024, vol: 0.285, atk: 0.0004, ftype: 'highpass',
            f0: 9200, f1: 2600, q: 0.62, shape: 'lin', pri: 6 });
    blast(b, 'boom', { t: hit, near: 0.58, far: 0.50, drive: 'blastLite', jit: 0.45 });
    nz(b, { t: hit + 0.002, dur: 0.80, vol: 0.445, atk: 0.0015, ftype: 'lowpass',
            f0: 1350, fmid: 250, f1: 42, q: 0.50, buf: 'brown', drive: 'soft', pri: 5 });
    nz(b, { t: hit + 0.004, dur: 0.43, vol: 0.255, atk: 0.0015, ftype: 'bandpass',
            f0: 2850, fmid: 760, f1: 150, q: 1.15, buf: 'pink', drive: 'soft', pri: 4 });

    /* The octave-spaced low pair is the destructive release. The upper mode
       speaks on small speakers; the 82 Hz fundamental and its fall are felt
       on a full-range system without spending level on infrasonic DC. */
    tn(b, { t: hit + 0.002, dur: 0.96, f0: 82, fm1: 39, f1: 18,
            vol: 0.420 * ss, type: 'sine', atk: 0.0035, pri: 6 });
    tn(b, { t: hit + 0.004, dur: 0.58, f0: 164, fm1: 78, f1: 34,
            vol: 0.205 * ss, type: 'triangle', lp: 520, atk: 0.003, drive: 'soft', pri: 5 });
    tn(b, { t: hit + 0.003, dur: 0.46, f0: 1850, fm1: 330, f1: 58,
            vol: 0.125, type: 'sawtooth', lp: 3100, atk: 0.0015, drive: 'soft', pri: 4 });
    nz(b, { t: hit + 0.055, dur: 0.55, vol: 0.085, atk: 0.018, ftype: 'bandpass',
            f0: 5200, f1: 620, q: 5.2, q1: 1.4,
            buf: 'crackle', rate: rr(0.75, 1.2), pri: 2 });
    report(b, 1.45, hit);
    duck(0.26 + 0.28 * close, 0.56);
    return true;
  }

  function cueBoom(x, z) {
    var b = newBus(x, z, { cat: 'world', wet: 1.5, gain: 1.15 });
    var ss = subScale(b);
    blast(b, 'boom', { near: 0.86, far: 0.72, drive: 'blast' });
    nz(b, { t: 0.002, dur: 0.85, vol: 0.52, atk: 0.0022, ftype: 'lowpass', f0: 2400, fmid: 420, f1: 62, q: 0.5, buf: 'pink', drive: 'soft', pri: 5 });
    tn(b, { t: 0.003, dur: 0.80, f0: 84, f1: 22, vol: 0.55 * ss, type: 'sine', atk: 0.004, pri: 5 });
    tn(b, { t: 0.006, dur: 0.55, f0: 47, f1: 19, vol: 0.30 * ss, type: 'sine', atk: 0.008, pri: 4 });
    /* debris, scattered and never the same twice */
    nz(b, { t: 0.09, dur: 0.62, vol: 0.13, atk: 0.03, ftype: 'bandpass', f0: 2100, f1: 700, q: 1.6, buf: 'crackle', rate: rr(0.85, 1.2), pri: 2 });
    for (var i = 0; i < 3; i++)
      tick(b, { t: 0.12 + rr(0, 0.42), f: rr(1400, 4200), vol: rr(0.02, 0.05), dur: rr(0.03, 0.09), q: rr(5, 14) });
    report(b, 1.6, 0.01);
    duck(0.45, 0.40);
    return true;
  }

  /* =======================================================================
     16. impacts, ricochets, casings
     These cues have NO case in the game's switch - every bullet that hits
     geometry would otherwise be silent. Rate-limited and low priority so a
     chaingun burst cannot swamp the voice pool.
     ==================================================================== */
  function impactAllowed() {
    var now = ctx.currentTime;
    impactBudget = Math.min(6, impactBudget + (now - lastImpact) * 15);
    lastImpact = now;
    if (impactBudget < 1) return false;
    impactBudget -= 1;
    return true;
  }

  var IMPACT = {
    metal:    { base: 2600, dur: 0.22, bright: true,  thud: [190, 0.05, 0.06], spray: 'crackle', ricP: 0.42 },
    wood:     { base: 640,  dur: 0.14, bright: false, thud: [250, 0.06, 0.09], spray: 'crackle', ricP: 0.05 },
    concrete: { base: 1250, dur: 0.10, bright: false, thud: [180, 0.05, 0.08], spray: 'grit',    ricP: 0.22 }
  };

  function cueImpact(kind, x, z) {
    if (!impactAllowed()) return true;
    var S = IMPACT[kind] || IMPACT.concrete;
    var b = newBus(x, z, { cat: 'world', wet: 0.8 });
    var v = cl(1 - b.dist / 90, 0.12, 1);
    var key = 'im_' + kind;
    var lst = pingBank(key, S.base, S.dur, S.bright);
    var buf = pickBuf(lst, key);
    if (buf) {
      smp(b, { buf: buf, vol: 0.30 * v, rate: rr(0.84, 1.24), pri: 2,
               peak: S.base * rr(0.7, 1.5), peakg: rr(-4, 5), peakq: 2.4 });
    } else {
      nz(b, { t: 0, dur: 0.05, vol: 0.16 * v, atk: 0.0006, ftype: 'bandpass', f0: S.base, q: 6, pri: 1 });
    }
    /* the substrate: every impact pushes the wall it hit */
    tn(b, { t: 0, dur: S.thud[1], f0: S.thud[0] * rr(0.85, 1.2), f1: S.thud[0] * 0.4,
            vol: S.thud[2] * v, type: 'sine', atk: 0.001, pri: 1 });
    /* ejecta: fragments leaving the surface */
    nz(b, { t: 0.004, dur: rr(0.09, 0.20), vol: 0.05 * v, atk: 0.006, ftype: 'bandpass',
            f0: rr(2200, 3400), f1: rr(800, 1500), q: 1.8, buf: S.spray, rate: rr(0.9, 1.7), pri: 1 });
    if (Math.random() < S.ricP) ricochet(b, 0.055 * v, 0.006);
    return true;
  }

  /* Ricochet with doppler. The fragment leaves at a few hundred m/s, so its
     whine falls in pitch AND its apparent position sweeps away from you -
     both are automated here, the pitch on the oscillator and the position on
     the bus panner. */
  function ricochet(b, vol, t0) {
    var f0 = rr(2600, 4600);
    var dur = rr(0.22, 0.46);
    var t = layerT(b, { t: t0 });
    tn(b, { t: t0, dur: dur, f0: f0, fm1: f0 * 0.74, fmAt: 0.35, f1: f0 * 0.36,
            vol: vol, type: 'sine', atk: 0.004, pri: 2 });
    tn(b, { t: t0 + 0.004, dur: dur * 0.8, f0: f0 * 1.51, f1: f0 * 0.55,
            vol: vol * 0.45, type: 'triangle', atk: 0.006, detune: 17, pri: 1 });
    nz(b, { t: t0, dur: dur * 0.55, vol: vol * 0.5, atk: 0.003, ftype: 'bandpass',
            f0: f0 * 1.1, f1: f0 * 0.42, q: 12, pri: 1 });
    /* fly away from the listener */
    if (b.pn && b.pn.positionX) {
      var w = world();
      if (w) {
        var lx = fin(w.player.x, 0), lz = fin(w.player.z, 0);
        var dx = b.ex - lx, dz = b.ez - lz;
        var L = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
        var k = 1 + rr(9, 22) / L;
        try {
          pSet(b.pn.positionX, b.ex, t); pLin(b.pn.positionX, lx + dx * k, t + dur);
          pSet(b.pn.positionZ, b.ez, t); pLin(b.pn.positionZ, lz + dz * k, t + dur);
          pSet(b.pn.positionY, b.ey, t); pLin(b.pn.positionY, b.ey + rr(1, 5), t + dur);
        } catch (e) {}
      }
    }
  }

  function cueRic(x, z) {
    var b = newBus(x, z, { cat: 'world', wet: 1.0 });
    var v = cl(1 - b.dist / 90, 0.15, 1);
    var lst = pingBank('im_metal', 2600, 0.22, true);
    var buf = pickBuf(lst, 'im_metal');
    if (buf) smp(b, { buf: buf, vol: 0.16 * v, rate: rr(1.1, 1.7), dur: 0.05, hp: 1800, pri: 2 });
    else nz(b, { t: 0, dur: 0.0025, vol: 0.13 * v, atk: 0.0005, ftype: 'highpass', f0: 6000, shape: 'lin', pri: 1 });
    ricochet(b, 0.11 * v, 0.001);
    return true;
  }

  /* Shell casing. Successive bounce intervals of a dropped object scale by
     the coefficient of restitution, and the amplitude by roughly e^1.5, so a
     geometric train with a roll at the end is not a stylisation - it is the
     actual timing. Getting this right is one of those details that a critic
     cannot name but always notices. */
  function cueCase() {
    var b = newBus(undefined, undefined, { cat: 'world', wet: 0.45, pan: rr(0.05, 0.42) });
    var surf = world() ? surfaceAt(world().player.x, world().player.z) : 'concrete';
    var hard = !(surf === 'carpet' || surf === 'dirt');
    var e = hard ? rr(0.52, 0.70) : rr(0.24, 0.36);
    var base = rr(2600, 4200) * (hard ? 1 : 0.72);
    var lst = pingBank('pg_case', 3200, 0.10, true);
    var t = 0, dt = rr(0.055, 0.085), amp = hard ? 0.052 : 0.028;
    var bounces = hard ? (4 + ((Math.random() * 3) | 0)) : 2;
    for (var i = 0; i < bounces; i++) {
      var buf = pickBuf(lst, 'pg_case');
      if (buf) smp(b, { t: t, buf: buf, vol: amp, rate: cl(base / 3200, 0.4, 2.4) * rr(0.94, 1.09),
                        dur: hard ? undefined : 0.03, pri: 1 });
      else nz(b, { t: t, dur: 0.03, vol: amp, atk: 0.0005, ftype: 'bandpass', f0: base, q: 16, pri: 1 });
      t += dt; dt *= e; amp *= Math.pow(e, 1.5);
      if (dt < 0.008) break;
    }
    /* roll / settle: a dense rattle as it stops rocking */
    if (hard) nz(b, { t: t, dur: rr(0.10, 0.22), vol: 0.016, atk: 0.004, ftype: 'bandpass',
                      f0: base * 1.1, f1: base * 0.7, q: 9, buf: 'grit', rate: rr(1.3, 2.1), pri: 1 });
    return true;
  }

  function cueHitFlesh(x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 0.6 });
    nz(b, { t: 0, dur: 0.030, vol: 0.20, atk: 0.0006, ftype: 'bandpass', f0: rr(700, 1100), q: 1.1, pri: 3 });
    nz(b, { t: 0.001, dur: 0.10, vol: 0.20, atk: 0.0012, ftype: 'lowpass', f0: rr(380, 520), f1: 110, q: 0.9, pri: 3 });
    tn(b, { t: 0.001, dur: 0.075, f0: rr(120, 165), f1: 52, vol: 0.13, type: 'sine', atk: 0.0016, pri: 3 });
    if (Math.random() < 0.45)
      nz(b, { t: 0.008, dur: 0.09, vol: 0.045, atk: 0.004, ftype: 'bandpass', f0: 2400, f1: 900, q: 3, buf: 'crackle', rate: rr(1.2, 1.9), pri: 1 });
    return true;
  }

  function cueGib(x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.1 });
    nz(b, { t: 0, dur: 0.006, vol: 0.30, atk: 0.0004, ftype: 'highpass', f0: 2600, q: 0.5, shape: 'lin', pri: 4 });
    nz(b, { t: 0.001, dur: 0.26, vol: 0.44, atk: 0.0016, ftype: 'lowpass', f0: 1500, fmid: 380, f1: 95, q: 0.7, drive: 'soft', pri: 4 });
    tn(b, { t: 0.002, dur: 0.22, f0: 130, f1: 38, vol: 0.26, type: 'sine', atk: 0.003, pri: 4 });
    /* bone + wet spray */
    nz(b, { t: 0.01, dur: 0.34, vol: 0.16, atk: 0.006, ftype: 'bandpass', f0: 1900, f1: 620, q: 1.8, buf: 'crackle', rate: rr(0.8, 1.15), pri: 2 });
    nz(b, { t: 0.02, dur: 0.42, vol: 0.075, atk: 0.03, ftype: 'bandpass', f0: 3600, f1: 1200, q: 1.2, buf: 'crackle', rate: rr(1.3, 2.0), pri: 1 });
    for (var i = 0; i < 3; i++)
      nz(b, { t: 0.06 + rr(0, 0.3), dur: rr(0.05, 0.12), vol: rr(0.02, 0.05), atk: 0.002,
              ftype: 'bandpass', f0: rr(400, 900), f1: rr(150, 300), q: 1.4, pri: 1 });
    return true;
  }

  /* =======================================================================
     17. enemy vocals
     One voice per species. The trooper is a human shout squashed through a
     comms channel; the pig is a low growl with a snort transient; the
     enforcer is hiss-dominant with a low rattle carrier; the octa is
     inharmonic with formants in the "wrong" order so it cannot read as human.
     ==================================================================== */
  function cueVoxTrooper(x, z, mode) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.0 });
    var base = rr(104, 128), hot = mode === 'alert' ? 1.25 : 1.0;
    vox(b, {
      t: 0, dur: 0.15 * hot, vol: 0.115 * hot, wave: 'glottal',
      f0: [[0, base * 1.18], [0.12, base * 1.32], [1, base * 0.95]],
      from: 'a', to: 'ae', fq: [7, 8, 10], fg: [17, 13, 8],
      breath: 0.10, breathF: 2300, breathF1: 1400,
      lp: 3400, hp: 220, drive: 'radio', atk: 0.006, rel: 0.05, pri: 4
    });
    vox(b, {
      t: 0.175, dur: 0.24 * hot, vol: 0.10 * hot, wave: 'glottal',
      f0: [[0, base * 1.05], [0.2, base * 1.12], [1, base * 0.76]],
      from: 'e', to: 'o', fq: [8, 9, 11], fg: [16, 12, 7],
      breath: 0.13, breathF: 1900, breathF1: 900,
      lp: 3100, hp: 240, drive: 'radio', atk: 0.010, rel: 0.10, pri: 4
    });
    nz(b, { t: 0.175 + 0.24 * hot + 0.01, dur: 0.045, vol: 0.028, atk: 0.002,
            ftype: 'bandpass', f0: 2600, f1: 1500, q: 3.4, pri: 1 });
    return b;
  }

  function cueVoxPig(x, z, mode) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.0 });
    var base = rr(66, 84), hot = mode === 'alert' ? 1.2 : 1.0;
    vox(b, {
      t: 0, dur: 0.30 * hot, vol: 0.145 * hot, wave: 'buzz',
      f0: [[0, base * 1.25], [0.15, base * 1.05], [1, base * 0.82]],
      from: 'o', to: 'u', fq: [5, 6, 8], fg: [18, 10, 4],
      breath: 0.18, breathF: 900, breathF1: 420, nbuf: 'pink',
      growl: { rate: rr(22, 30), rate1: rr(14, 19), depth: 0.42 },
      lp: 2200, hp: 55, drive: 'crunch', atk: 0.008, rel: 0.11, pri: 4
    });
    nz(b, { t: 0.26 * hot, dur: 0.13, vol: 0.085, atk: 0.006, ftype: 'bandpass',
            f0: 1500, fmid: 900, f1: 480, q: 2.0, buf: 'pink', rate: rr(0.85, 1.15), pri: 3 });
    nz(b, { t: 0.30 * hot, dur: 0.09, vol: 0.05, atk: 0.004, ftype: 'bandpass', f0: 2600, f1: 1300, q: 3.5, pri: 2 });
    tn(b, { t: 0.02, dur: 0.34, f0: base * 0.52, f1: base * 0.38, vol: 0.075, type: 'sine', atk: 0.02, pri: 3 });
    return b;
  }

  function cueVoxLizard(x, z, mode) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.05 });
    var hot = mode === 'alert' ? 1.2 : 1.0;
    for (var i = 0; i < 5; i++)
      nz(b, { t: i * rr(0.015, 0.022), dur: 0.010, vol: 0.030 * hot, atk: 0.0006,
              ftype: 'bandpass', f0: rr(2600, 4200), q: 9, shape: 'lin', pri: 2 });
    vox(b, {
      t: 0.05, dur: 0.30 * hot, vol: 0.085 * hot, tonal: true, wave: 'rasp',
      f0: [[0, rr(58, 72)], [1, rr(40, 50)]],
      from: [700, 1750, 3100], to: [520, 1250, 2600], fq: [4, 6, 9], fg: [12, 12, 10],
      breath: 1.35, breathF: 3000, breathF1: 900, breathQ: 0.7,
      growl: { rate: rr(34, 46), depth: 0.28 },
      lp: 6200, hp: 300, drive: 'crunch', atk: 0.02, rel: 0.14, pri: 4
    });
    nz(b, { t: 0.05, dur: 0.34 * hot, vol: 0.055, atk: 0.03, ftype: 'bandpass',
            f0: 4600, f1: 1700, q: 1.5, pri: 3 });
    return b;
  }

  function cueVoxOcta(x, z, mode) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.6 });
    var hot = mode === 'alert' ? 1.15 : 1.0;
    var base = rr(200, 265);
    tn(b, { t: 0, dur: 0.55 * hot, f0: base, f1: base * 0.38, vol: 0.085 * hot, type: 'sine', atk: 0.06, pri: 4 });
    tn(b, { t: 0.01, dur: 0.52 * hot, f0: base * 1.414, f1: base * 0.55, vol: 0.045 * hot, type: 'triangle', detune: -26, atk: 0.08, pri: 3 });
    vox(b, {
      t: 0.02, dur: 0.48 * hot, vol: 0.05 * hot, wave: 'hollow',
      f0: [[0, base * 0.5], [0.4, base * 0.62], [1, base * 0.3]],
      from: [1500, 700, 2900], to: [900, 420, 2100], fq: [6, 7, 9], fg: [14, 12, 9],
      breath: 0.5, breathF: 1900, breathF1: 620,
      growl: { rate: 6.5, rate1: 11, depth: 0.5 },
      lp: 5200, hp: 140, atk: 0.06, rel: 0.2, pri: 3
    });
    nz(b, { t: 0.0, dur: 0.50 * hot, vol: 0.045, atk: 0.09, ftype: 'bandpass',
            f0: 900, fmid: 2200, f1: 380, q: 5, pri: 2 });
    return b;
  }

  function cuePain(kind, x, z) {
    var b;
    if (kind === 'pig') {
      b = newBus(x, z, { cat: 'enemy', wet: 0.9 });
      vox(b, { t: 0, dur: 0.24, vol: 0.17, wave: 'buzz',
        f0: [[0, rr(150, 180)], [0.1, rr(160, 195)], [1, rr(62, 78)]],
        from: 'a', to: 'o', fq: [5, 7, 9], fg: [18, 11, 5], breath: 0.22, breathF: 1100, breathF1: 400,
        growl: { rate: 30, depth: 0.3 }, lp: 2600, hp: 60, drive: 'crunch', atk: 0.0025, rel: 0.11, pri: 4 });
    } else if (kind === 'enforcer') {
      b = newBus(x, z, { cat: 'enemy', wet: 1.0 });
      vox(b, { t: 0, dur: 0.21, vol: 0.10, wave: 'rasp',
        f0: [[0, rr(220, 280)], [1, rr(90, 120)]],
        from: [900, 2100, 3400], to: [560, 1300, 2500], fq: [4, 6, 8], fg: [13, 13, 11],
        breath: 1.1, breathF: 3600, breathF1: 900, breathQ: 0.6,
        lp: 7000, hp: 320, drive: 'crunch', atk: 0.0022, rel: 0.10, pri: 4 });
      nz(b, { t: 0, dur: 0.20, vol: 0.06, atk: 0.0016, ftype: 'bandpass', f0: 2100, f1: 480, q: 3.6, pri: 3 });
    } else if (kind === 'octa') {
      b = newBus(x, z, { cat: 'enemy', wet: 1.5 });
      tn(b, { t: 0, dur: 0.32, f0: rr(660, 780), f1: rr(115, 150), vol: 0.115, type: 'sine', atk: 0.0026, pri: 4 });
      tn(b, { t: 0.004, dur: 0.28, f0: rr(920, 1080), f1: 210, vol: 0.055, type: 'triangle', detune: 31, atk: 0.003, drive: 'fold', pri: 3 });
      nz(b, { t: 0, dur: 0.26, vol: 0.06, atk: 0.002, ftype: 'bandpass', f0: 2300, f1: 420, q: 4.2, pri: 3 });
    } else {
      b = newBus(x, z, { cat: 'enemy', wet: 0.9 });
      vox(b, { t: 0, dur: 0.20, vol: 0.135, wave: 'glottal',
        f0: [[0, rr(190, 235)], [0.12, rr(200, 250)], [1, rr(95, 125)]],
        from: 'a', to: 'er', fq: [7, 8, 10], fg: [17, 12, 7],
        breath: 0.2, breathF: 2400, breathF1: 1100,
        lp: 3400, hp: 200, drive: 'radio', atk: 0.002, rel: 0.09, pri: 4 });
      nz(b, { t: 0.16, dur: 0.14, vol: 0.035, atk: 0.02, ftype: 'bandpass', f0: 1600, f1: 700, q: 1.6, pri: 2 });
    }
    return true;
  }

  function cueDie(x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.1 });
    vox(b, { t: 0, dur: 0.62, vol: 0.145, wave: 'glottal',
      f0: [[0, rr(200, 250)], [0.1, rr(190, 230)], [1, rr(46, 62)]],
      from: 'a', to: 'u', fq: [6, 8, 10], fg: [17, 11, 6],
      breath: 0.28, breathF: 2100, breathF1: 500,
      growl: { rate: 9, rate1: 26, depth: 0.3 },
      lp: 3000, hp: 90, drive: 'crunch', atk: 0.004, rel: 0.34, pri: 4 });
    nz(b, { t: 0.30, dur: 0.42, vol: 0.055, atk: 0.06, ftype: 'bandpass', f0: 1300, f1: 380, q: 1.2, buf: 'pink', pri: 2 });
    return true;
  }

  /* =======================================================================
     18. footsteps

     Tactically the most important sound in the game, so it gets the most
     care:
       * nine surfaces, each a different grain distribution, not a different
         filter setting on the same noise
       * heel-then-toe, with the gap closing as the mover speeds up
       * loudness AND brightness driven by speed, the way CS2 does it: a
         crouch-walk is nearly inaudible, a sprint is unmistakable
       * every parameter jittered and the grain variant rotated, so no two
         steps in a session are the same waveform
     ==================================================================== */
  function surfKind(ftex) {
    if (typeof ftex !== 'string') return 'concrete';
    if (/grate/.test(ftex)) return 'grate';
    if (/metal|steel|plate/.test(ftex)) return 'metal';
    if (/carpet|rug/.test(ftex)) return 'carpet';
    if (/wood|plank|board/.test(ftex)) return 'wood';
    if (/tile|marble|ceram/.test(ftex)) return 'tile';
    if (/street|asphalt|gravel|road/.test(ftex)) return 'gravel';
    if (/water|pool|flood/.test(ftex)) return 'water';
    if (/dirt|sand|mud|earth|soil/.test(ftex)) return 'dirt';
    return 'concrete';
  }
  function surfaceAt(x, z) {
    var w = world(); if (!w || !w.regAt || !w.inb) return 'concrete';
    var cx = Math.floor(fin(x, 0) / w.CELL), cz = Math.floor(fin(z, 0) / w.CELL);
    if (!w.inb(cx, cz)) return 'concrete';
    var R = w.regAt(cx, cz);
    return surfKind(R && R.ftex);
  }

  /* per-surface mix weights: how much low thud, how much grain, how bright */
  var SURFMIX = {
    concrete: { grain: 1.00, thud: 1.00, f: 118, bright: 1.00, wet: 1.00 },
    tile:     { grain: 1.05, thud: 0.78, f: 132, bright: 1.30, wet: 1.10 },
    wood:     { grain: 0.92, thud: 1.12, f: 96,  bright: 0.85, wet: 0.95 },
    metal:    { grain: 1.10, thud: 0.86, f: 108, bright: 1.20, wet: 1.05 },
    grate:    { grain: 1.14, thud: 0.62, f: 124, bright: 1.25, wet: 1.00 },
    carpet:   { grain: 0.55, thud: 0.90, f: 82,  bright: 0.42, wet: 0.55 },
    gravel:   { grain: 1.05, thud: 0.92, f: 104, bright: 1.05, wet: 0.80 },
    dirt:     { grain: 0.80, thud: 1.00, f: 88,  bright: 0.62, wet: 0.70 },
    water:    { grain: 1.15, thud: 0.70, f: 90,  bright: 0.95, wet: 1.15 }
  };

  /* the player's own gait state, read straight off the game's inputs */
  function playerSpeed01() {
    var w = world(); if (!w) return 0.55;
    var k = w.keys;
    var crouch = !!(k && (k.ControlLeft || k.ControlRight || k.KeyC));
    var walk = !!(k && (k.ShiftLeft || k.ShiftRight));
    var spd = crouch ? 8.5 : (walk ? 11 : 21);
    spd *= (1 - 0.28 * cl(fin(w.player.ads, 0), 0, 1));
    return { s01: cl((spd - 6) / 16, 0, 1), crouch: crouch, walk: walk };
  }
  /* enemy gait: match the emitter position to an enemy and read its smoothed
     speed, so a sprinting trooper is audibly louder than a shuffling one */
  function enemySpeed01(x, z) {
    var w = world(); if (!w || !w.enemies) return 0.75;
    var best = -1, bd = 9;
    for (var i = 0; i < w.enemies.length; i++) {
      var e = w.enemies[i];
      if (!e || e.dead) continue;
      var dx = fin(e.x, 1e9) - x, dz = fin(e.z, 1e9) - z;
      var d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return 0.75;
    return cl(fin(w.enemies[best].speedSm, 0.75), 0, 1);
  }

  var stepParity = 0;
  function footstep(x, z, weight, opt) {
    opt = opt || {};
    var positional = isNum(x) && isNum(z);
    var w = world();
    var surf = positional ? surfaceAt(x, z)
                          : (w ? surfaceAt(w.player.x, w.player.z) : 'concrete');
    var M = SURFMIX[surf] || SURFMIX.concrete;

    /* --- speed drives everything. Crouching is close to silent, which is
           the single most load-bearing gameplay behaviour in the whole
           subsystem. --- */
    var s01, quiet = 1;
    if (positional) s01 = enemySpeed01(x, z);
    else {
      var g = playerSpeed01();
      s01 = g.s01;
      quiet = g.crouch ? 0.17 : (g.walk ? 0.46 : 1);
    }
    var loud = (0.34 + 0.80 * s01) * quiet;
    if (loud < 0.03) return true;

    var par = (stepParity = (stepParity + 1) & 1);
    var b = newBus(x, z, {
      cat: 'foot', wet: 0.85 * M.wet,
      pan: positional ? undefined : (par ? rr(-0.24, -0.06) : rr(0.06, 0.24))
    });

    /* every value below moves. Two identical footsteps in a row is the single
       fastest way to make a game sound cheap. */
    var jp = rr(0.90, 1.13) * (par ? 1.035 : 0.965);
    var jv = rr(0.86, 1.13);
    var wt = cl(weight, 0.2, 2.2) * loud;
    var key = 'ft_' + surf;
    var lst = footBank(surf);

    /* --- heel: mass arriving. Low-biased, hardest transient. --- */
    var hb = pickBuf(lst, key);
    if (hb) smp(b, { buf: hb, vol: 0.30 * wt * jv * M.grain, rate: jp * rr(0.94, 1.07),
                     lp: cl(9000 * M.bright * (0.55 + 0.55 * s01), 700, 18000),
                     pri: 3 });
    else nz(b, { t: 0, dur: 0.05, vol: 0.10 * wt, atk: 0.0008, ftype: 'bandpass', f0: 1100 * jp, q: 1.3, pri: 2 });

    nz(b, { t: 0, dur: 0.085 / jp, vol: 0.105 * wt * jv * M.thud, atk: 0.0011,
            ftype: 'lowpass', f0: 300 * jp, f1: 78 * jp, q: 0.75, pri: 2 });
    tn(b, { t: 0, dur: 0.070 / jp, f0: M.f * jp, f1: M.f * 0.48 * jp,
            vol: 0.052 * wt * jv * M.thud, type: 'sine', atk: 0.0016, pri: 2 });

    /* --- toe / ball: the second half of a real footfall. The gap closes as
           the mover speeds up; at a sprint the two nearly merge. --- */
    var gap = cl(0.062 - 0.036 * s01, 0.018, 0.075) * rr(0.85, 1.15);
    var tb = pickBuf(lst, key);
    if (tb) smp(b, { t: gap, buf: tb, vol: 0.15 * wt * jv * M.grain, rate: jp * rr(1.02, 1.16),
                     hp: 340, lp: cl(11000 * M.bright, 900, 18000), pri: 2 });
    nz(b, { t: gap, dur: 0.045, vol: 0.030 * wt * M.thud, atk: 0.0012,
            ftype: 'lowpass', f0: 420 * jp, f1: 140, q: 0.8, pri: 1 });

    /* --- scuff: the sole sliding on the plant. Only when moving fast.
           It trails the heel rather than leading it, because a negative
           offset would just clamp to "now" and stack on the transient. --- */
    if (s01 > 0.45 && Math.random() < 0.55)
      nz(b, { t: 0.004 + rr(0, 0.010), dur: rr(0.020, 0.042), vol: 0.022 * wt * M.bright,
              atk: 0.004, ftype: 'bandpass', f0: rr(1800, 3600), f1: rr(900, 1700),
              q: 1.6, buf: 'grit', rate: rr(0.9, 1.6), pri: 1 });

    /* --- claw / hoof: an extra hard tip strike after the pad --- */
    if (opt.claw) {
      nz(b, { t: 0.006 + rr(0, 0.008), dur: rr(0.035, 0.07), vol: 0.030 * wt, atk: 0.003,
              ftype: 'bandpass', f0: rr(2600, 4200), f1: rr(1100, 1900), q: 6, pri: 1 });
      nz(b, { t: 0.002, dur: 0.03, vol: 0.020 * wt, atk: 0.0006, ftype: 'highpass', f0: 5200, shape: 'lin', pri: 1 });
    }

    /* --- gear: webbing, magazines, plate edges. Count and offsets vary. --- */
    if (wt > 0.55) {
      var n = 2 + ((Math.random() * 3) | 0);
      for (var i = 0; i < n; i++)
        nz(b, { t: 0.012 + rr(0, 0.075), dur: rr(0.012, 0.035), vol: rr(0.006, 0.018) * wt,
                atk: 0.0007, ftype: 'bandpass', f0: rr(1600, 4800), q: rr(6, 16), pri: 1 });
    }
    return true;
  }

  function cueBodyfall(x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.0 });
    nz(b, { t: 0, dur: 0.26, vol: 0.20, atk: 0.0018, ftype: 'lowpass', f0: 340, f1: 52, q: 0.6, pri: 3 });
    tn(b, { t: 0, dur: 0.24, f0: rr(66, 84), f1: 27, vol: 0.115, type: 'sine', atk: 0.003, pri: 3 });
    nz(b, { t: 0.012, dur: 0.13, vol: 0.055, atk: 0.001, ftype: 'bandpass', f0: rr(700, 1100), q: 1.1, pri: 2 });
    var n = 3 + ((Math.random() * 3) | 0);
    for (var i = 0; i < n; i++)
      nz(b, { t: 0.03 + rr(0, 0.16), dur: rr(0.015, 0.05), vol: rr(0.01, 0.03),
              atk: 0.0008, ftype: 'bandpass', f0: rr(1400, 4200), q: rr(6, 15), pri: 1 });
    nz(b, { t: rr(0.13, 0.22), dur: 0.13, vol: 0.075, atk: 0.0016, ftype: 'lowpass', f0: 280, f1: 62, q: 0.7, pri: 2 });
    return true;
  }

  /* weapon handling: bolt, safety, sling, cloth */
  function cueReady(heavy, x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 0.8 });
    if (heavy) {
      nz(b, { t: 0, dur: 0.09, vol: 0.055, atk: 0.010, ftype: 'bandpass', f0: 900, f1: 1900, q: 2.6, pri: 2 });
      tick(b, { t: 0.075, f: 1500, vol: 0.085, dur: 0.055, q: 6, body: true });
      nz(b, { t: 0.08, dur: 0.08, vol: 0.045, atk: 0.0012, ftype: 'lowpass', f0: 320, f1: 95, q: 0.8, pri: 2 });
      tick(b, { t: 0.155 + rr(0, 0.02), f: 2400, vol: 0.045, dur: 0.03, q: 9 });
    } else {
      nz(b, { t: 0, dur: 0.055, vol: 0.032, atk: 0.006, ftype: 'bandpass', f0: 1400, f1: 2900, q: 3.2, pri: 2 });
      tick(b, { t: 0.048 + rr(0, 0.012), f: 2600, vol: 0.050, dur: 0.028, q: 8 });
      tick(b, { t: 0.086 + rr(0, 0.014), f: 1900, vol: 0.036, dur: 0.022, q: 7 });
      nz(b, { t: 0.01, dur: 0.11, vol: 0.016, atk: 0.02, ftype: 'bandpass', f0: 2600, f1: 1100, q: 1.1, buf: 'pink', pri: 1 });
    }
    return true;
  }

  function cueCharge(x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 1.4 });
    tn(b, { t: 0, dur: 0.30, f0: 150, f1: 940, vol: 0.085, type: 'sine', atk: 0.05, pri: 3 });
    tn(b, { t: 0.01, dur: 0.27, f0: 302, f1: 1390, vol: 0.042, type: 'triangle', detune: 11, atk: 0.07, drive: 'fold', pri: 3 });
    nz(b, { t: 0, dur: 0.29, vol: 0.038, atk: 0.09, ftype: 'bandpass', f0: 700, f1: 2600, q: 4.5, pri: 2 });
    nz(b, { t: 0.05, dur: 0.24, vol: 0.020, atk: 0.10, ftype: 'bandpass', f0: 5200, f1: 7800, q: 8, pri: 1 });
    tick(b, { t: 0.295, f: 3200, vol: 0.030, dur: 0.02, q: 12 });
    return true;
  }

  function cueMech(x, z) {
    var b = newBus(x, z, { cat: 'enemy', wet: 0.7 });
    tick(b, { t: 0.028 + rr(0, 0.01), f: 2450 * rr(0.9, 1.12), vol: 0.038, dur: 0.024, q: 8 });
    tick(b, { t: 0.052 + rr(0, 0.014), f: 1500 * rr(0.9, 1.12), vol: 0.030, dur: 0.032, q: 6, body: true });
    if (Math.random() < 0.5)
      nz(b, { t: 0.07 + rr(0, 0.03), dur: 0.03, vol: 0.016, atk: 0.0008, ftype: 'bandpass', f0: rr(3600, 5600), q: 13, pri: 1 });
    return true;
  }

  /* =======================================================================
     19. world / player / UI
     ==================================================================== */
  function cueDoor(x, z, big) {
    var b = newBus(x, z, { cat: 'world', wet: 1.0 });
    var d = big ? 1.0 : 0.75;
    tick(b, { t: 0, f: 1700, vol: 0.05, dur: 0.035, q: 6 });
    nz(b, { t: 0.02, dur: 0.70 * d, vol: 0.20, atk: 0.05, ftype: 'lowpass', f0: 340, f1: 110, q: 0.65, buf: 'brown', pri: 2 });
    tn(b, { t: 0.02, dur: 0.68 * d, f0: 62, f1: 44, vol: 0.10, type: 'sawtooth', atk: 0.06, lp: 260, pri: 2 });
    nz(b, { t: 0.03, dur: 0.62 * d, vol: 0.045, atk: 0.06, ftype: 'bandpass', f0: 1150, f1: 620, q: 2.2, pri: 1 });
    nz(b, { t: 0.70 * d, dur: 0.14, vol: 0.075, atk: 0.0016, ftype: 'lowpass', f0: 420, f1: 88, q: 0.8, pri: 2 });
    return true;
  }
  function cueLift(x, z) {
    var b = newBus(x, z, { cat: 'world', wet: 0.9 });
    nz(b, { t: 0, dur: 0.55, vol: 0.16, atk: 0.09, ftype: 'lowpass', f0: 190, f1: 120, q: 0.7, buf: 'brown', pri: 2 });
    tn(b, { t: 0, dur: 0.52, f0: 47, f1: 43, vol: 0.085, type: 'sawtooth', atk: 0.1, lp: 190, pri: 2 });
    nz(b, { t: 0.02, dur: 0.48, vol: 0.030, atk: 0.1, ftype: 'bandpass', f0: 780, f1: 560, q: 4, pri: 1 });
    return true;
  }
  function cuePush(x, z) {
    var b = newBus(x, z, { cat: 'world', wet: 1.1 });
    nz(b, { t: 0, dur: 1.05, vol: 0.26, atk: 0.13, ftype: 'lowpass', f0: 260, f1: 70, q: 0.55, buf: 'brown', pri: 3 });
    nz(b, { t: 0.02, dur: 0.95, vol: 0.07, atk: 0.15, ftype: 'bandpass', f0: 900, f1: 380, q: 1.6, buf: 'pink', pri: 2 });
    tn(b, { t: 0, dur: 1.0, f0: 44, f1: 33, vol: 0.10, type: 'sine', atk: 0.15, pri: 2 });
    for (var i = 0; i < 4; i++)
      nz(b, { t: rr(0.1, 0.85), dur: rr(0.03, 0.08), vol: rr(0.012, 0.03), atk: 0.002,
              ftype: 'bandpass', f0: rr(700, 2400), q: rr(4, 11), pri: 1 });
    return true;
  }

  function cueStep() {
    if (!world()) return undefined;
    return footstep(undefined, undefined, 0.62, null);
  }
  function cueJump() {
    var b = newBus(undefined, undefined, { cat: 'foot', wet: 0.4 });
    nz(b, { t: 0, dur: 0.09, vol: 0.055, atk: 0.002, ftype: 'bandpass', f0: 700, f1: 260, q: 1.1, pri: 2 });
    for (var i = 0; i < 3; i++)
      nz(b, { t: rr(0, 0.05), dur: rr(0.012, 0.03), vol: rr(0.008, 0.018), atk: 0.0008,
              ftype: 'bandpass', f0: rr(1800, 4600), q: rr(7, 15), pri: 1 });
    tn(b, { t: 0, dur: 0.07, f0: 130, f1: 74, vol: 0.03, type: 'sine', atk: 0.003, pri: 1 });
    return true;
  }
  function cueLand() {
    var b = newBus(undefined, undefined, { cat: 'foot', wet: 0.55 });
    var surf = world() ? surfaceAt(world().player.x, world().player.z) : 'concrete';
    var M = SURFMIX[surf] || SURFMIX.concrete;
    var lst = footBank(surf), buf = pickBuf(lst, 'ft_' + surf);
    if (buf) smp(b, { buf: buf, vol: 0.42 * M.grain, rate: rr(0.80, 0.92), pri: 4 });
    nz(b, { t: 0, dur: 0.15, vol: 0.16 * M.thud, atk: 0.0014, ftype: 'lowpass', f0: 300, f1: 62, q: 0.7, pri: 3 });
    tn(b, { t: 0, dur: 0.13, f0: M.f * 0.8, f1: 36, vol: 0.088 * M.thud, type: 'sine', atk: 0.002, pri: 3 });
    for (var i = 0; i < 4; i++)
      nz(b, { t: 0.008 + rr(0, 0.06), dur: rr(0.012, 0.035), vol: rr(0.01, 0.026), atk: 0.0008,
              ftype: 'bandpass', f0: rr(1600, 4800), q: rr(6, 16), pri: 1 });
    return true;
  }

  function cueHurt() {
    var w = world();
    var hp = w ? cl(w.player.hp, 0, 100) : 100;
    var sev = cl((52 - hp) / 52, 0, 1);
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.25 });
    nz(b, { t: 0, dur: 0.055, vol: 0.24, atk: 0.0008, ftype: 'bandpass', f0: rr(1200, 1900), q: 1.4, pri: 5 });
    nz(b, { t: 0.001, dur: 0.16, vol: 0.22, atk: 0.0014, ftype: 'lowpass', f0: 620, f1: 110, q: 0.8, pri: 5 });
    tn(b, { t: 0.001, dur: 0.18, f0: 112, f1: 40, vol: 0.20, type: 'sine', atk: 0.002, pri: 5 });
    vox(b, { t: 0.03, dur: 0.22, vol: 0.11 + sev * 0.06, wave: 'glottal',
      f0: [[0, rr(120, 150)], [0.15, rr(128, 160)], [1, rr(72, 92)]],
      from: 'a', to: 'er', fq: [6, 8, 10], fg: [16, 11, 6],
      breath: 0.32, breathF: 1600, breathF1: 620,
      lp: 3000, hp: 100, drive: 'soft', atk: 0.008, rel: 0.11, pri: 5 });
    damageFX(sev);
    duck(0.28, 0.26);
    return true;
  }

  function cueDeadPlayer() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.6 });
    damageFX(1);
    vox(b, { t: 0, dur: 1.0, vol: 0.16, wave: 'glottal',
      f0: [[0, 165], [0.1, 150], [1, 44]], from: 'a', to: 'u', fq: [6, 8, 10], fg: [16, 10, 5],
      breath: 0.35, breathF: 1500, breathF1: 340, growl: { rate: 8, rate1: 22, depth: 0.35 },
      lp: 2600, hp: 70, drive: 'crunch', atk: 0.01, rel: 0.6, pri: 5 });
    var seq = [188, 149, 118, 88];
    for (var i = 0; i < seq.length; i++)
      tn(b, { t: 0.28 + i * 0.23, dur: 0.55, f0: seq[i], f1: seq[i] * 0.62, vol: 0.13,
              type: 'sawtooth', lp: 1100, atk: 0.02, drive: 'soft', pri: 5 });
    tn(b, { t: 0.28, dur: 2.0, f0: 58, f1: 32, vol: 0.12, type: 'sine', atk: 0.15, pri: 5 });
    return true;
  }

  function cuePickup(kind) {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.12 });
    if (kind === 'weapon') {
      tick(b, { t: 0, f: 1500, vol: 0.075, dur: 0.05, q: 6, body: true });
      tick(b, { t: 0.055, f: 2400, vol: 0.055, dur: 0.04, q: 8 });
      nz(b, { t: 0.02, dur: 0.10, vol: 0.02, atk: 0.02, ftype: 'bandpass', f0: 2600, f1: 1200, q: 1.2, buf: 'pink', pri: 2 });
      tn(b, { t: 0.03, dur: 0.09, f0: 440, vol: 0.13, type: 'square', lp: 3000, pri: 4 });
      tn(b, { t: 0.10, dur: 0.10, f0: 660, vol: 0.12, type: 'square', lp: 3400, pri: 4 });
      tn(b, { t: 0.17, dur: 0.16, f0: 990, vol: 0.11, type: 'square', lp: 4200, pri: 4 });
    } else if (kind === 'key') {
      tick(b, { t: 0, f: 3800, vol: 0.05, dur: 0.03, q: 12 });
      tn(b, { t: 0.01, dur: 0.13, f0: 920, vol: 0.14, type: 'triangle', pri: 4 });
      tn(b, { t: 0.10, dur: 0.24, f0: 1420, f1: 1400, vol: 0.13, type: 'triangle', pri: 4 });
      tn(b, { t: 0.10, dur: 0.22, f0: 2130, vol: 0.045, type: 'sine', pri: 3 });
    } else {
      tick(b, { t: 0, f: 2800, vol: 0.035, dur: 0.022, q: 10 });
      tn(b, { t: 0.005, dur: 0.065, f0: 800, vol: 0.13, type: 'square', lp: 3600, pri: 4 });
      tn(b, { t: 0.055, dur: 0.09, f0: 1200, vol: 0.12, type: 'square', lp: 4200, pri: 4 });
    }
    return true;
  }

  function cueSecret() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.5 });
    var seq = [660, 880, 1320];
    for (var i = 0; i < seq.length; i++) {
      tn(b, { t: i * 0.1, dur: 0.32, f0: seq[i], vol: 0.13, type: 'triangle', atk: 0.006, pri: 4 });
      tn(b, { t: i * 0.1, dur: 0.30, f0: seq[i] * 2.005, vol: 0.035, type: 'sine', atk: 0.008, pri: 3 });
    }
    return true;
  }
  function cueWin() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.7 });
    var seq = [523, 659, 784, 1046];
    for (var i = 0; i < seq.length; i++) {
      tn(b, { t: i * 0.16, dur: 0.5, f0: seq[i], vol: 0.14, type: 'square', lp: 3800, atk: 0.008, drive: 'soft', pri: 5 });
      tn(b, { t: i * 0.16, dur: 0.48, f0: seq[i] * 0.5, vol: 0.07, type: 'triangle', atk: 0.01, pri: 4 });
    }
    return true;
  }
  function cueSwitch() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.4 });
    tick(b, { t: 0, f: 2200, vol: 0.07, dur: 0.035, q: 7, body: true });
    tn(b, { t: 0.005, dur: 0.18, f0: 260, f1: 940, vol: 0.16, type: 'square', lp: 3200, atk: 0.003, pri: 5 });
    nz(b, { t: 0.01, dur: 0.14, vol: 0.03, atk: 0.01, ftype: 'bandpass', f0: 1400, f1: 3200, q: 3, pri: 2 });
    return true;
  }
  function cueLocked() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.3 });
    tick(b, { t: 0, f: 900, vol: 0.10, dur: 0.06, q: 5, body: true });
    tn(b, { t: 0.005, dur: 0.10, f0: 152, vol: 0.16, type: 'square', lp: 1400, pri: 4 });
    tick(b, { t: 0.115, f: 780, vol: 0.085, dur: 0.06, q: 5, body: true });
    tn(b, { t: 0.12, dur: 0.13, f0: 118, vol: 0.14, type: 'square', lp: 1200, pri: 4 });
    return true;
  }
  function cueEmpty() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.25, pan: 0.12 });
    tick(b, { t: 0, f: 2900, vol: 0.075, dur: 0.028, q: 9 });
    tick(b, { t: 0.012, f: 1700, vol: 0.045, dur: 0.03, q: 6, body: true });
    return true;
  }
  /* Weapon swap, told as a real handling sequence: the old weapon comes off
     the shoulder, the sling takes the weight, the new one seats, the bolt
     goes home. Four events, all jittered. */
  function cueSwap() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.3, pan: 0.1 });
    nz(b, { t: 0, dur: 0.11, vol: 0.030, atk: 0.02, ftype: 'bandpass', f0: 2400, f1: 900, q: 1.3, buf: 'pink', pri: 2 });
    tick(b, { t: 0.028 + rr(0, 0.012), f: rr(1100, 1500), vol: 0.038, dur: 0.030, q: 6 });
    tick(b, { t: 0.070 + rr(0, 0.02), f: rr(1500, 2400), vol: 0.058, dur: 0.038, q: 7, body: true });
    nz(b, { t: 0.075, dur: 0.07, vol: 0.026, atk: 0.008, ftype: 'bandpass', f0: 1200, f1: 2600, q: 2.4, pri: 1 });
    tick(b, { t: 0.128 + rr(0, 0.03), f: rr(2600, 3600), vol: 0.032, dur: 0.024, q: 10 });
    return true;
  }
  function cueConfirm() {
    var b = newBus(undefined, undefined, { cat: 'ui', wet: 0.03 });
    tn(b, { t: 0, dur: 0.035, f0: 1500, f1: 1150, vol: 0.055, type: 'sine', atk: 0.0008, pri: 5 });
    nz(b, { t: 0, dur: 0.010, vol: 0.030, atk: 0.0005, ftype: 'highpass', f0: 4600, shape: 'lin', pri: 5 });
    return true;
  }

  /* =======================================================================
     20. cue table
     Anything absent falls through to the game's stock synthesis.
     ==================================================================== */
  var CUES = {
    pistol: function (x, z) { return cuePistol(x, z); },
    shotgun: function (x, z) { return cueShotgun(x, z); },
    chain: function (x, z) { return cueChain(x, z); },
    rifle: function (x, z) { return cueRifle(x, z); },
    rifleq: function (x, z) { return cueRifleQ(x, z); },
    rifle_magout: function (x, z) { return cueRifleMagOut(x, z); },
    rifle_magin: function (x, z) { return cueRifleMagIn(x, z); },
    rifle_bolt: function (x, z) { return cueRifleBolt(x, z); },
    rpg: function (x, z) { return cueRPG(x, z); },
    plasma: function (x, z) { return cuePlasma(x, z); },
    nullfire: function (x, z) { return cueNullFire(x, z); },
    nullarm: function (x, z) { return cueNullArm(x, z); },
    nullcollapse: function (x, z) { return cueNullCollapse(x, z); },
    boom: function (x, z) { return cueBoom(x, z); },
    ric: function (x, z) { return cueRic(x, z); },
    hitflesh: function (x, z) { return cueHitFlesh(x, z); },
    gib: function (x, z) { return cueGib(x, z); },
    die: function (x, z) { return cueDie(x, z); },

    impact_metal: function (x, z) { return cueImpact('metal', x, z); },
    impact_wood: function (x, z) { return cueImpact('wood', x, z); },
    impact_concrete: function (x, z) { return cueImpact('concrete', x, z); },

    alert1: function (x, z) { cueVoxTrooper(x, z, 'alert'); cueReady(false, x, z); return true; },
    alert2: function (x, z) { cueVoxLizard(x, z, 'alert'); return true; },
    oink: function (x, z) { cueVoxPig(x, z, 'alert'); return true; },

    enemy_vox_trooper: function (x, z) { cueVoxTrooper(x, z, 'idle'); return true; },
    enemy_vox_pig: function (x, z) { cueVoxPig(x, z, 'idle'); return true; },
    enemy_vox_lizard: function (x, z) { cueVoxLizard(x, z, 'idle'); return true; },
    enemy_vox_octa: function (x, z) { cueVoxOcta(x, z, 'idle'); return true; },

    enemy_pain_trooper: function (x, z) { return cuePain('trooper', x, z); },
    enemy_pain_pig: function (x, z) { return cuePain('pig', x, z); },
    enemy_pain_enforcer: function (x, z) { return cuePain('enforcer', x, z); },
    enemy_pain_octa: function (x, z) { return cuePain('octa', x, z); },

    enemy_step_light: function (x, z) { return footstep(x, z, 0.72, null); },
    enemy_step_heavy: function (x, z) { return footstep(x, z, 1.32, null); },
    enemy_step_claw: function (x, z) { return footstep(x, z, 0.95, { claw: true }); },
    enemy_bodyfall: function (x, z) { return cueBodyfall(x, z); },
    enemy_ready: function (x, z) { return cueReady(false, x, z); },
    enemy_ready_heavy: function (x, z) { return cueReady(true, x, z); },
    enemy_charge: function (x, z) { return cueCharge(x, z); },
    enemy_weapon_mech: function (x, z) { return cueMech(x, z); },

    pain: function (x, z) { return cuePain('trooper', x, z); },
    hurt: function () { return cueHurt(); },
    dead: function () { return cueDeadPlayer(); },

    pickup: function () { return cuePickup('pickup'); },
    weapon: function () { return cuePickup('weapon'); },
    key: function () { return cuePickup('key'); },
    secret: function () { return cueSecret(); },
    win: function () { return cueWin(); },
    switch: function () { return cueSwitch(); },
    locked: function () { return cueLocked(); },
    empty: function () { return cueEmpty(); },
    swap: function () { return cueSwap(); },
    confirm: function () { return cueConfirm(); },
    case: function () { return cueCase(); },
    step: function () { return cueStep(); },
    jump: function () { return cueJump(); },
    land: function () { return cueLand(); },

    door: function (x, z) { return cueDoor(x, z, true); },
    lift: function (x, z) { return cueLift(x, z); },
    push: function (x, z) { return cuePush(x, z); }
  };

  /* =======================================================================
     21. space detection + per-frame housekeeping

     The classifier runs 5x a second but the reverb only follows it after the
     answer has been stable for 0.35 s AND at least 1.2 s has passed since the
     last change. Without that, walking a doorway at speed retriggers the
     crossfade every 200 ms and the tail smears into mush - which is the
     failure mode the brief specifically calls out.
     ==================================================================== */
  function classify() {
    var w = world(); if (!w) return;
    var cx = Math.floor(fin(w.player.x, 0) / w.CELL), cz = Math.floor(fin(w.player.z, 0) / w.CELL);
    var cell = cx * 4096 + cz;
    if (cell === spaceCell) return;
    spaceCell = cell;

    var R = (w.inb && w.regAt && w.inb(cx, cz)) ? w.regAt(cx, cz) : null;
    var h = R ? cl(fin(R.c, 11) - fin(R.f, 0), 2, 60) : 11;
    var sky = !!(R && R.sky);

    /* openness + floor relief from a 9x9 cell scan. Cheap, and it separates a
       corridor from a room far better than ceiling height alone. */
    var open = 0, tot = 0, fmin = 1e9, fmax = -1e9;
    if (w.grid && w.idx && w.inb) {
      for (var dz = -4; dz <= 4; dz++) for (var dx = -4; dx <= 4; dx++) {
        var gx = cx + dx, gz = cz + dz;
        tot++;
        if (!w.inb(gx, gz)) continue;
        if (w.grid[w.idx(gx, gz)] === w.S_SOLID) continue;
        open++;
        if (w.floorAt) {
          var fv = fin(w.floorAt(gx, gz), 0);
          if (fv < fmin) fmin = fv; if (fv > fmax) fmax = fv;
        }
      }
    } else { open = 40; tot = 81; }
    var o = tot ? open / tot : 0.5;
    var relief = (fmax > -1e8 && fmin < 1e8) ? (fmax - fmin) : 0;

    var k;
    if (sky) k = 'outdoor';
    else if (relief > 2.6 && o < 0.5) k = 'stair';
    else if (h >= 16 && o > 0.44) k = 'hall';
    else if (o < 0.30) k = 'corridor';
    else k = 'room';

    space.open = o; space.height = h; space.sky = sky;
    space.size = cl(h * o / 6, 0.3, 3);
    /* wet amount: big + reflective spaces get more send, the street almost none */
    space.wet = sky ? 0.055 : cl(0.10 + (h / 46) * 0.16 + o * 0.10, 0.09, 0.34);
    if (k === 'stair') space.wet *= 1.25;
    if (k === 'corridor') space.wet *= 0.92;

    if (k === space.name) { spaceWant = ''; updateBed(); return; }
    /* hysteresis: want it for a while before you get it */
    var now = ctx.currentTime;
    if (k !== spaceWant) { spaceWant = k; spaceWantT = now; return; }
    if (now - spaceWantT < 0.35) return;
    if (now - spaceLock < 1.2) return;
    spaceLock = now; spaceWant = '';
    setSpace(k);
  }

  function setSpace(k) {
    space.name = k;
    var buf = getIR(k);
    if (!buf || !G) { updateBed(); return; }
    var t = ctx.currentTime, XF = 0.55;
    var inc = (G.active === 'A') ? G.gB : G.gA;
    var outc = (G.active === 'A') ? G.gA : G.gB;
    var incConv = (G.active === 'A') ? G.cvB : G.cvA;
    try { incConv.buffer = buf; } catch (e) { return; }
    /* equal-power crossfade in three linear segments: a straight linear pair
       dips 3 dB in the middle, which is audible as a hole in the tail. */
    pHold(inc.gain, t);
    pLin(inc.gain, 0.707, t + XF * 0.5); pLin(inc.gain, 1, t + XF);
    pHold(outc.gain, t);
    pLin(outc.gain, 0.707, t + XF * 0.5); pLin(outc.gain, 0, t + XF);
    G.active = (G.active === 'A') ? 'B' : 'A';
    /* pre-delay follows the space; a hall needs the tail to arrive later */
    var pre = (IRSPEC[k] || IRSPEC.room).pre;
    pHold(G.revPre.delayTime, t); pLin(G.revPre.delayTime, cl(pre, 0, 0.11), t + XF);
    /* and the send band-limit: a big concrete space keeps more top than a
       carpeted room, a street keeps almost none because there is nothing to
       reflect off */
    var lp = k === 'outdoor' ? 5200 : (k === 'hall' || k === 'stair' ? 10500 : 8000);
    pHold(G.revLP.frequency, t); pLin(G.revLP.frequency, lp, t + XF);
    /* free the convolver we faded out, once it is silent */
    var freeing = (G.active === 'A') ? G.cvB : G.cvA;
    global.setTimeout(function () {
      if (dead || !G) return;
      var stillOut = (G.active === 'A') ? G.cvB : G.cvA;
      if (stillOut === freeing) { try { freeing.buffer = null; } catch (e) {} }
    }, (XF + 0.35) * 1000);
    updateBed();
  }

  function updateBed() {
    if (!G) return;
    var t = ctx.currentTime, k = space.name;
    var lowF, lowG, hiF, hiG;
    if (k === 'outdoor') { lowF = 260; lowG = 0.028; hiF = 1900; hiG = 0.009; }
    else if (k === 'hall') { lowF = 150; lowG = 0.020; hiF = 900; hiG = 0.0035; }
    else if (k === 'stair') { lowF = 175; lowG = 0.016; hiF = 1200; hiG = 0.004; }
    else if (k === 'corridor') { lowF = 190; lowG = 0.014; hiF = 1100; hiG = 0.0045; }
    else { lowF = 205; lowG = 0.017; hiF = 1000; hiG = 0.004; }
    pHold(G.bedAF.frequency, t); pLin(G.bedAF.frequency, cl(lowF, 30, 8000), t + 1.4);
    pHold(G.bedAG.gain, t); pLin(G.bedAG.gain, cl(lowG, 0, 0.2), t + 1.4);
    pHold(G.bedBF.frequency, t); pLin(G.bedBF.frequency, cl(hiF, 60, 12000), t + 1.4);
    pHold(G.bedBG.gain, t); pLin(G.bedBG.gain, cl(hiG, 0, 0.2), t + 1.4);
  }

  var lastTick = 0, mutedNow = false;
  function tick_(now) {
    if (dead) return;
    global.requestAnimationFrame(tick_);
    if (!installed || !ctx || !G) return;
    var dt = lastTick ? cl((now - lastTick) / 1000, 0, 0.25) : 0.016;
    lastTick = now;

    /* the game's M key toggles AU.muted and sfx() bails before the hook, so
       one-shots stop by themselves; the beds, the reverb tail and the
       chaingun sustain need to be told. */
    var m = !!(AUref && AUref.muted);
    if (m !== mutedNow) {
      mutedNow = m;
      var t = ctx.currentTime;
      pHold(G.out.gain, t); pLin(G.out.gain, m ? 0 : 0.92, t + 0.04);
    }

    /* portal raycasts are the one genuinely expensive thing in here, so they
       run on a refilling budget rather than on demand */
    portalBudget = Math.min(4, portalBudget + dt * 9);

    spaceT -= dt;
    if (spaceT <= 0) { spaceT = 0.2; try { classify(); } catch (e) {} }

    /* chaingun spin-up / spin-down, single writer per param */
    var cg = chain.nodes;
    if (cg) {
      if (ctx.currentTime - chain.last > 0.9) chain.spin = 0;
      else chain.spin *= Math.pow(0.02, dt);
      if (chain.spin < 0.0008) chain.spin = 0;
      var s = cl(chain.spin, 0, 1), tt = ctx.currentTime, R = 0.05;
      pHold(cg.motorG.gain, tt); pLin(cg.motorG.gain, 0.085 * s, tt + R);
      pHold(cg.whineG.gain, tt); pLin(cg.whineG.gain, 0.030 * s * s, tt + R);
      pHold(cg.bedG.gain, tt); pLin(cg.bedG.gain, 0.050 * s, tt + R);
      pHold(cg.motor.frequency, tt); pLin(cg.motor.frequency, 46 + 20 * s, tt + R);
      pHold(cg.whine.frequency, tt); pLin(cg.whine.frequency, 138 + 62 * s, tt + R);
      pHold(cg.motorF.frequency, tt); pLin(cg.motorF.frequency, 180 + 150 * s, tt + R);
    }
    if (live.length > 8) purge();
  }

  /* =======================================================================
     22. install
     ==================================================================== */
  function detectTier() {
    var q = null;
    try { q = NZ.render && NZ.render.quality; } catch (e) {}
    if (q === 'low' || q === 'med' || q === 'high') return q;
    var hc = 4;
    try { hc = fin(global.navigator && navigator.hardwareConcurrency, 4); } catch (e) {}
    var mem = 4;
    try { mem = fin(global.navigator && navigator.deviceMemory, 4); } catch (e) {}
    if (hc >= 8 && mem >= 8) return 'high';
    if (hc >= 4) return 'med';
    return 'low';
  }

  /* Prime the banks the first second of play will certainly need, one per
     tick so a 20 ms generation never lands inside a frame that matters. */
  function primeBanks() {
    var q = [
      function () { crackBank(false); },
      function () { blastBank('pistol', false); },
      function () { footBank(world() ? surfaceAt(world().player.x, world().player.z) : 'concrete'); },
      function () { pingBank('pg_mech', 1550, 0.20, false); },
      /* The rifle is full-auto: the first burst is the worst possible moment
         to be generating a bank one variant at a time, because rounds 2-5
         would all draw the single synchronous variant and the burst would
         open with four identical shots. */
      function () { blastBank('rifle', false); },
      function () { blastBank('pistol', true); },
      function () { footBank('concrete'); },
      function () { pingBank('pg_case', 3200, 0.10, true); }
    ], i = 0;
    (function next() {
      if (dead || i >= q.length) return;
      try { q[i](); } catch (e) { NZ.log('bank prime failed', e); }
      i++;
      global.setTimeout(next, 55);
    })();
  }

  function ensure(AU) {
    if (installed) return true;
    if (!AU || !AU.ctx || !AU.master) return false;
    AUref = AU;
    ctx = AU.ctx;
    SR = fin(ctx.sampleRate, 48000);
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    TIER = detectTier();
    CAP = TIER === 'low' ? 34 : (TIER === 'med' ? 48 : 60);
    buildNoise();
    buildWaves();
    buildCurves();
    G = buildGraph();
    primeIRs();
    try { G.cvA.buffer = getIR('room'); } catch (e) {}
    installed = true;
    lastTick = 0;
    global.requestAnimationFrame(tick_);
    try { classify(); } catch (e) {}
    updateBed();
    primeBanks();
    NZ.flags.audio = true;
    NZ.log('audio module installed (sr=' + SR + ', tier=' + TIER + ', cap=' + CAP + ')');
    return true;
  }

  function panic(err) {
    if (dead) return;
    dead = true;
    NZ.flags.audio = false;
    try { console.error('[nz-audio] disabled after error; stock audio takes over:', err); } catch (e) {}
    try {
      if (G) {
        if (G.out) { G.out.gain.value = 0; G.out.disconnect(); }
        if (chain.nodes) { chain.nodes.motorG.gain.value = 0; chain.nodes.whineG.gain.value = 0; chain.nodes.bedG.gain.value = 0; }
        if (G.bedAG) G.bedAG.gain.value = 0;
        if (G.bedBG) G.bedBG.gain.value = 0;
      }
    } catch (e) {}
    G = null;
    installed = false;
  }

  NZ.on('sfx', function (name, x, z, AU) {
    if (dead) return undefined;
    try {
      if (!ensure(AU)) return undefined;
      var fn = CUES[name];
      if (!fn) return undefined;                 /* fall through to stock */
      busesThisCue.length = 0;
      var r = fn(isNum(x) ? x : undefined, isNum(z) ? z : undefined);
      finishCue();
      return r === true ? true : undefined;
    } catch (err) {
      try { finishCue(); } catch (e) {}
      panic(err);
      return undefined;                          /* stock synthesis still runs */
    }
  });

  /* Debug surface. NZ.audio.stats() in the console while playing. */
  NZ.audio = {
    stats: function () {
      return {
        installed: installed, dead: dead, tier: TIER,
        space: space.name, wet: +space.wet.toFixed(3),
        openness: +space.open.toFixed(2), height: +space.height.toFixed(1),
        gunGain: +GUNSHOT_GAIN.toFixed(2),
        playerGunGain: +(GUNSHOT_GAIN * PLAYER_GUNSHOT_GAIN).toFixed(2),
        voices: live.length, peakVoices: peakVoices, cap: CAP, hrtf: hrtfLive,
        /* who loses when the pool is full. Healthy = almost all p1/p2 (gunshot
           tails and mech detail); p3+ appearing in quantity means footsteps
           and enemy voices are being cut and something is over-spending. */
        steals: steals, stolenPri: stolenPri, denied: deniedVoices,
        pools: { gain: pool.g.length, biquad: pool.bq.length, panner: pool.pn.length, delay: pool.dl.length },
        irs: irRT, banks: genCost, chainSpin: +chain.spin.toFixed(2)
      };
    },
    setSpace: function (k) { if (IRSPEC[k]) { spaceLock = 0; setSpace(k); } },
    /* Reverb wet trim. Drops the whole IR cache so the next cue rebuilds at the
       new level - call with a smaller value if the tails are too loud. */
    setIrTrim: function (v) {
      v = +v;
      if (!isNum(v) || v <= 0 || v > 4) { console.warn('[nz-audio] irTrim must be 0-4'); return IRTRIM; }
      IRTRIM = v; IR = {}; irRT = {};
      try { if (G && G.cvA) G.cvA.buffer = getIR(space.name); } catch (e) {}
      return IRTRIM;
    },
    getIrTrim: function () { return IRTRIM; },
    setTier: function (t) {
      if (t !== 'low' && t !== 'med' && t !== 'high') return TIER;
      TIER = t; CAP = t === 'low' ? 34 : (t === 'med' ? 48 : 60);
      IR = {}; irRT = {}; BANK = {}; genCost = {};
      try { if (G && G.cvA) { G.cvA.buffer = getIR(space.name); G.gA.gain.value = 1; G.gB.gain.value = 0; G.active = 'A'; } } catch (e) {}
      return TIER;
    },
    disable: function () { panic('manual disable'); },

    /* ---- offline analysis hook ----
       Forces every generator to run and hands back the raw buffers so a test
       harness can measure attack time, crest factor, spectral centroid and
       RT60 without a soundcard. Not used by the game. */
    _probe: function () {
      var out = { sr: SR, tier: TIER, blast: {}, crack: {}, foot: {}, ping: {}, ir: {} };
      var names = ['pistol', 'rifle', 'chain', 'shotgun', 'rpg', 'boom'], i;
      for (i = 0; i < names.length; i++) {
        out.blast[names[i] + '_near'] = blastBank(names[i], false);
        out.blast[names[i] + '_far'] = blastBank(names[i], true);
      }
      out.crack.narrow = crackBank(false);
      out.crack.wide = crackBank(true);
      for (var k in FOOTSPEC) if (FOOTSPEC.hasOwnProperty(k)) out.foot[k] = footBank(k);
      out.ping.mech = pingBank('pg_mech', 1550, 0.20, false);
      out.ping.casing = pingBank('pg_case', 3200, 0.10, true);
      for (i = 0; i < IRQ.length; i++) out.ir[IRQ[i]] = getIR(IRQ[i]);
      out.irSpec = IRSPEC;
      out.gunSpec = GUN;
      out.footSpec = FOOTSPEC;
      out.erPattern = {};
      for (i = 0; i < IRQ.length; i++) {
        var sb = 0, nm = IRQ[i];
        for (var c2 = 0; c2 < nm.length; c2++) sb = (sb * 31 + nm.charCodeAt(c2)) | 0;
        out.erPattern[nm] = imageER(IRSPEC[nm], mulberry(sb + 104729 + 5));
      }
      return out;
    }
  };

  NZ.log('audio module loaded, waiting for the game AudioContext');

})(typeof window !== 'undefined' ? window : this);
