#!/usr/bin/env node
/* ===========================================================================
   audio-harness.mjs -- headless numeric verification of nz-audio.js.

   Boots the REAL audio module (nz-core.js + nz-audio.js) inside a Node `vm`
   context against a fully OFFLINE Web Audio stub, installs it through its own
   install path (NZ.on('sfx', ...) -> ensure(AU)), forces every generator with
   NZ.audio._probe(), and measures:

     A. blast bank spectra    peak / centroid / crest / rise / positive phase
     B. barrel modes          odd-only excitation for a closed-open pipe
     C. cue timelines         every scheduled voice, and the voice cost of
                              sustained full-auto fire
     D. decorrelation         per-shot variation of the pistol cue

   The stub is instrumented: every source node that calls start() is recorded
   with its scheduled time, its gain envelope and the filter chain in front of
   it, so a "cue timeline" is a measurement rather than a reading of the code.

   Exit 0 = every assertion green.  Exit 1 = at least one FAIL.

     node scripts/audio-harness.mjs
     node scripts/audio-harness.mjs --json
     node scripts/audio-harness.mjs --verbose
     node scripts/audio-harness.mjs --seed=7 --trials=40

   Reads everything, writes nothing.  nz-audio.js is never modified.
   ======================================================================== */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/* ============================================================== cli ===== */
const ARGV = process.argv.slice(2);
const VALUED = new Set(['root', 'seed', 'trials', 'shots', 'spacing']);
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
  quiet: !!flag('quiet', false),
  seed: Number(flag('seed', 20260803)) || 20260803,
  trials: Math.max(1, Number(flag('trials', 96)) || 96),
  shots: Math.max(2, Number(flag('shots', 20)) || 20),
  spacing: Number(flag('spacing', 0.105)) || 0.105,
  random: !!flag('random', false),
};
const ROOT = OPT.root;
const rd = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

/* ==================================================== thresholds ======== */
/* The mechanism windows are quoted FROM THE MUZZLE BLAST, which is the frame
   the published BCG/slide timings use (they are quoted from primer ignition,
   and the blast follows ignition by a fixed ~1.3 ms) and the frame nz-audio's
   own comments use. On the first-person path the blast is itself pushed back
   to MECH_T0, so the sfx()-call frame is offset from this one by MECH_T0 and
   is reported as context only. */
const T = {
  rifleFrontLo: 380, rifleFrontHi: 620,    /* Hz, 1/(2*pi*T_positive-phase)  */
  pistolFrontLo: 620, pistolFrontHi: 1100,
  crestMinDb: 11,                          /* peak / rms, near banks         */
  modeProminenceDb: 3.0,                   /* odd mode must stand this proud */
  cap: 60,                                 /* NZ.audio.stats().cap at 'high' */
  rifleBattery: [66, 78],                  /* ms after the blast, to battery */
  rifleBuffer: [22, 30],                   /* ms after the blast, buffer btm */
  pistolSlide: [10, 15],                   /* ms after the blast, slide      */
  pistolBattery: [37, 44],                 /* ms after the blast, to battery */
  boltUnderBlastDb: [-8, -1],              /* suppressed: bolt vs blast peak */
};

/* ============================================ constants from the source ==
   Anything the explanatory text quotes is READ OUT OF nz-audio.js, never
   hardcoded here, so retuning the module cannot silently make this harness
   lie about what it is measuring. */
const SRC = (() => { try { return rd('nz-audio.js'); } catch (e) { return ''; } })();
function srcNum(re, dflt) {
  const m = SRC.match(re);
  return m ? Number(m[1]) : dflt;
}
function fnBody(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') { d++; started = true; }
    else if (SRC[k] === '}') { d--; if (started && d === 0) return SRC.slice(i, k + 1); }
  }
  return '';
}
const SRCK = {
  MECH_T0: srcNum(/\bvar\s+MECH_T0\s*=\s*([0-9.eE+-]+)\s*;/, NaN),
  layerFloor: srcNum(/var\s+lo\s*=\s*ctx\.currentTime\s*\+\s*([0-9.eE+-]+)\s*;/, NaN),
  rifleJt: (fnBody('cueRifle').match(/var\s+jt\s*=\s*rr\(\s*0\s*,\s*([0-9.eE+-]+)\s*\)/) || [])[1],
  pistolJt: (fnBody('cuePistol').match(/var\s+jt\s*=\s*rr\(\s*0\s*,\s*([0-9.eE+-]+)\s*\)/) || [])[1],
  mechM: srcNum(/var\s+mechM\s*=\s*supp\s*\?\s*([0-9.eE+-]+)\s*:/, NaN),
  suppBlastScale: srcNum(/near:\s*\(self[^\n]*supp\s*\?\s*([0-9.]+)\s*:\s*1\)/, NaN),
  searT: (fnBody('preTransient').match(/t:\s*([0-9.eE+-]+)\s*\+\s*rr\(0,\s*([0-9.eE+-]+)\)/) || []).slice(1),
  swell: (fnBody('preTransient').match(/t:\s*([0-9.eE+-]+),\s*dur:\s*([0-9.eE+-]+),\s*vol:[^,]+,\s*atk:\s*([0-9.eE+-]+)/) || []).slice(1),
};
const MECH_T0_MS = SRCK.MECH_T0 * 1000;
const jtMs = c => (c === 'pistol' ? Number(SRCK.pistolJt) : Number(SRCK.rifleJt)) * 1000;

/* ================================================ offline web audio ===== */
/* Stringified into the vm so every Float32Array the module touches belongs to
   the sandbox realm. Self-contained: no closure over harness scope. */
function AUDIO_STUB(global, sampleRate) {
  'use strict';

  var REC = {
    nowMs: 0,
    nodeSeq: 0, bufSeq: 0, voiceSeq: 0,
    bufIndex: {},             /* __id -> AudioBuffer, for every buffer played */
    voices: [],
    pending: [],              /* started sources awaiting their stop time    */
    timers: [], timerSeq: 0,
    raf: [], rafAcc: 0,
    buffers: [],
    record: true,
  };
  global.__REC = REC;

  /* ------------------------------------------------------------ params -- */
  function Param(v) {
    this.value = v;
    this.defaultValue = v;
    this.minValue = -3.4028235e38;
    this.maxValue = 3.4028235e38;
    this.events = [];
    this.automationRate = 'a-rate';
  }
  Param.prototype.setValueAtTime = function (v, t) {
    v = +v; t = +t;
    if (v !== v || t !== t) throw new TypeError('non-finite AudioParam value');
    this.events.push({ k: 'set', v: v, t: t }); this.value = v; return this;
  };
  Param.prototype.linearRampToValueAtTime = function (v, t) {
    v = +v; t = +t;
    if (v !== v || t !== t) throw new TypeError('non-finite AudioParam value');
    this.events.push({ k: 'lin', v: v, t: t }); this.value = v; return this;
  };
  Param.prototype.exponentialRampToValueAtTime = function (v, t) {
    v = +v; t = +t;
    if (v !== v || t !== t) throw new TypeError('non-finite AudioParam value');
    /* real Web Audio throws on a zero/sign-crossing target -- keep that so a
       missing EPS guard in the module shows up as a thrown cue, not silence */
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime target must not be 0');
    this.events.push({ k: 'exp', v: v, t: t }); this.value = v; return this;
  };
  Param.prototype.setTargetAtTime = function (v, t, tc) {
    this.events.push({ k: 'tgt', v: +v, t: +t, tc: +tc }); this.value = +v; return this;
  };
  Param.prototype.setValueCurveAtTime = function (curve, t, dur) {
    var mx = -Infinity, i;
    for (i = 0; i < curve.length; i++) if (curve[i] > mx) mx = curve[i];
    this.events.push({ k: 'curve', v: mx, t: +t, dur: +dur, n: curve.length });
    this.value = curve.length ? curve[curve.length - 1] : this.value;
    return this;
  };
  Param.prototype.cancelScheduledValues = function (t) {
    t = +t || 0;
    var out = [], i;
    for (i = 0; i < this.events.length; i++) if (this.events[i].t < t) out.push(this.events[i]);
    this.events = out; return this;
  };
  Param.prototype.cancelAndHoldAtTime = function (t) {
    t = +t || 0;
    var out = [], i;
    for (i = 0; i < this.events.length; i++) if (this.events[i].t <= t) out.push(this.events[i]);
    this.events = out; return this;
  };
  /* peak of everything ever scheduled, plus the standing value */
  Param.prototype.__peak = function () {
    var p = this.events.length ? -Infinity : this.value, i;
    for (i = 0; i < this.events.length; i++) if (this.events[i].v > p) p = this.events[i].v;
    return p;
  };
  Param.prototype.__first = function () { return this.events.length ? this.events[0].v : this.value; };
  Param.prototype.__last = function () { return this.events.length ? this.events[this.events.length - 1].v : this.value; };

  /* ------------------------------------------------------------- nodes -- */
  function baseNode(type) {
    var n = {
      __id: ++REC.nodeSeq, __type: type, __out: [],
      numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers',
      onended: null,
    };
    n.connect = function (d) {
      if (d && n.__out.indexOf(d) < 0) n.__out.push(d);
      return (d && d.__type) ? d : undefined;
    };
    n.disconnect = function (d) {
      if (d === undefined) { n.__out.length = 0; return; }
      var i = n.__out.indexOf(d); if (i >= 0) n.__out.splice(i, 1);
    };
    n.addEventListener = function (k, fn) { if (k === 'ended') n.onended = fn; };
    n.removeEventListener = function () {};
    n.context = ctx;
    return n;
  }

  /* Walk forward from a source to the first GainNode, collecting the filter
     chain on the way. That gain node IS the layer envelope in nz-audio: every
     primitive builds src -> [filters] -> g -> bus.inp. */
  function chainOf(src) {
    var filters = [], cur = src, guard = 0, gain = null;
    while (cur && guard++ < 32) {
      var outs = cur.__out || [], nxt = null, i;
      for (i = 0; i < outs.length; i++) if (outs[i] && outs[i].__type) { nxt = outs[i]; break; }
      if (!nxt) break;
      if (nxt.__type === 'Gain') { gain = nxt; break; }
      if (nxt.__type === 'BiquadFilter')
        filters.push({ t: nxt.type, f: Math.round(nxt.frequency.__first()),
                       f1: Math.round(nxt.frequency.__last()),
                       q: +nxt.Q.__first().toFixed(2), g: +nxt.gain.__first().toFixed(2) });
      else if (nxt.__type === 'WaveShaper') filters.push({ t: 'shaper', curve: nxt.curve });
      else filters.push({ t: nxt.__type });
      cur = nxt;
    }
    return { gain: gain, filters: filters };
  }

  /* |x|max of channel 0, cached on the buffer. Both generators peak-normalise
     (blast to 0.985, ping to 0.95), so gain * bufPeak is a fair peak-amplitude
     comparison between two layers sharing a bus. */
  function bufPeakOf(b) {
    if (!b || typeof b.getChannelData !== 'function') return null;
    if (b.__pk !== undefined) return b.__pk;
    var d = b.getChannelData(0), p = 0, i;
    for (i = 0; i < d.length; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > p) p = a; }
    b.__pk = p;
    return p;
  }
  /* evaluate a WaveShaper curve at x in [-1,1], linear interpolation */
  function shapeAt(curve, x) {
    if (!curve || !curve.length) return x;
    var n = curve.length;
    var f = (x + 1) * 0.5 * (n - 1);
    if (f <= 0) return curve[0];
    if (f >= n - 1) return curve[n - 1];
    var i = f | 0, t = f - i;
    return curve[i] * (1 - t) + curve[i + 1] * t;
  }
  global.__shapeAt = shapeAt;

  /* |x|max and rms of a used buffer over a time window, so "what is this
     layer contributing right now" can be asked of a PRE-RENDERED sample --
     whose gain node is a flat step and therefore says nothing about the
     sample's own decay. */
  global.__bufWindow = function (id, t0, t1) {
    var b = REC.bufIndex[id];
    if (!b) return null;
    var d = b.getChannelData(0), sr = b.sampleRate;
    var i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(d.length, Math.ceil(t1 * sr));
    if (i1 <= i0) return null;
    var p = 0, s = 0, i;
    for (i = i0; i < i1; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > p) p = a; s += d[i] * d[i]; }
    return { peak: p, rms: Math.sqrt(s / (i1 - i0)) };
  };

  function recordVoice(n, kind) {
    if (!REC.record) return null;
    var c = chainOf(n);
    if (n.buffer && n.buffer.__id !== undefined) REC.bufIndex[n.buffer.__id] = n.buffer;
    var v = {
      i: ++REC.voiceSeq,
      kind: kind,
      t: n.__startAt,
      stop: null,
      peak: c.gain ? +c.gain.gain.__peak() : null,
      env: c.gain ? c.gain.gain.events.map(function (e) { return [e.k, +e.v.toFixed(6), +(e.t - n.__startAt).toFixed(6)]; }) : [],
      filters: c.filters,
      buf: n.buffer ? n.buffer.__id : null,
      bufDur: n.buffer ? +n.buffer.duration.toFixed(6) : null,
      bufPeak: n.buffer ? bufPeakOf(n.buffer) : null,
      shaper: (function () { for (var q = 0; q < c.filters.length; q++) if (c.filters[q].t === 'shaper') return c.filters[q].curve; return null; })(),
      bufId: n.buffer ? n.buffer.__id : null,
      bufOffset: n.__offset || 0,
      rate: n.playbackRate ? +n.playbackRate.value.toFixed(4) : null,
      f0: n.frequency ? +n.frequency.__first().toFixed(2) : null,
      f1: n.frequency ? +n.frequency.__last().toFixed(2) : null,
      wave: n.__wave || (n.type || null),
    };
    n.__vrec = v;
    REC.voices.push(v);
    return v;
  }

  function createBufferSource() {
    var n = baseNode('BufferSource');
    n.buffer = null; n.loop = false; n.loopStart = 0; n.loopEnd = 0;
    n.playbackRate = new Param(1); n.detune = new Param(0);
    n.__started = false; n.__stopped = false; n.__startAt = null; n.__stopAt = null;
    n.start = function (when, offset, dur) {
      if (n.__started) throw new Error('cannot call start more than once');
      n.__started = true;
      n.__startAt = (when === undefined ? REC.nowMs / 1000 : +when);
      if (n.__startAt !== n.__startAt) throw new TypeError('non-finite start time');
      n.__offset = +offset || 0;
      recordVoice(n, 'buffer');
      REC.pending.push(n);
    };
    n.stop = function (when) {
      if (!n.__started) throw new Error('cannot call stop without calling start first');
      n.__stopAt = (when === undefined ? REC.nowMs / 1000 : +when);
      if (n.__vrec) n.__vrec.stop = n.__stopAt;
    };
    return n;
  }
  function createOscillator() {
    var n = baseNode('Oscillator');
    n.type = 'sine';
    n.frequency = new Param(440); n.detune = new Param(0);
    n.__started = false; n.__startAt = null; n.__stopAt = null; n.__wave = null;
    n.setPeriodicWave = function (w) { n.__wave = (w && w.__name) || 'periodic'; n.type = 'custom'; };
    n.start = function (when) {
      if (n.__started) throw new Error('cannot call start more than once');
      n.__started = true;
      n.__startAt = (when === undefined ? REC.nowMs / 1000 : +when);
      recordVoice(n, 'osc');
      REC.pending.push(n);
    };
    n.stop = function (when) {
      if (!n.__started) throw new Error('cannot call stop without calling start first');
      n.__stopAt = (when === undefined ? REC.nowMs / 1000 : +when);
      if (n.__vrec) n.__vrec.stop = n.__stopAt;
    };
    return n;
  }
  function createConstantSource() {
    var n = baseNode('ConstantSource');
    n.offset = new Param(1);
    n.__started = false;
    n.start = function (w) { n.__started = true; n.__startAt = (w === undefined ? REC.nowMs / 1000 : +w); REC.pending.push(n); };
    n.stop = function (w) { n.__stopAt = (w === undefined ? REC.nowMs / 1000 : +w); };
    return n;
  }
  function createGain() { var n = baseNode('Gain'); n.gain = new Param(1); return n; }
  function createBiquadFilter() {
    var n = baseNode('BiquadFilter');
    n.type = 'lowpass';
    n.frequency = new Param(350); n.Q = new Param(1); n.gain = new Param(0); n.detune = new Param(0);
    n.getFrequencyResponse = function (f, mag, ph) { for (var i = 0; i < f.length; i++) { mag[i] = 1; ph[i] = 0; } };
    return n;
  }
  function createPanner() {
    var n = baseNode('Panner');
    n.panningModel = 'equalpower'; n.distanceModel = 'inverse';
    n.refDistance = 1; n.maxDistance = 10000; n.rolloffFactor = 1;
    n.coneInnerAngle = 360; n.coneOuterAngle = 360; n.coneOuterGain = 0;
    n.positionX = new Param(0); n.positionY = new Param(0); n.positionZ = new Param(0);
    n.orientationX = new Param(1); n.orientationY = new Param(0); n.orientationZ = new Param(0);
    n.setPosition = function (x, y, z) { n.positionX.value = x; n.positionY.value = y; n.positionZ.value = z; };
    n.setOrientation = function (x, y, z) { n.orientationX.value = x; n.orientationY.value = y; n.orientationZ.value = z; };
    return n;
  }
  function createStereoPanner() { var n = baseNode('StereoPanner'); n.pan = new Param(0); return n; }
  function createDelay(max) { var n = baseNode('Delay'); n.delayTime = new Param(0); n.__max = max || 1; return n; }
  function createWaveShaper() { var n = baseNode('WaveShaper'); n.curve = null; n.oversample = 'none'; return n; }
  function createConvolver() { var n = baseNode('Convolver'); n.buffer = null; n.normalize = true; return n; }
  function createDynamicsCompressor() {
    var n = baseNode('DynamicsCompressor');
    n.threshold = new Param(-24); n.knee = new Param(30); n.ratio = new Param(12);
    n.attack = new Param(0.003); n.release = new Param(0.25); n.reduction = 0;
    return n;
  }
  function createChannelSplitter(c) { var n = baseNode('ChannelSplitter'); n.numberOfOutputs = c || 6; return n; }
  function createChannelMerger(c) { var n = baseNode('ChannelMerger'); n.numberOfInputs = c || 6; return n; }
  function createAnalyser() {
    var n = baseNode('Analyser');
    n.fftSize = 2048; n.frequencyBinCount = 1024;
    n.minDecibels = -100; n.maxDecibels = -30; n.smoothingTimeConstant = 0.8;
    n.getByteFrequencyData = function (a) { for (var i = 0; i < a.length; i++) a[i] = 0; };
    n.getFloatFrequencyData = function (a) { for (var i = 0; i < a.length; i++) a[i] = -Infinity; };
    n.getByteTimeDomainData = function (a) { for (var i = 0; i < a.length; i++) a[i] = 128; };
    n.getFloatTimeDomainData = function (a) { for (var i = 0; i < a.length; i++) a[i] = 0; };
    return n;
  }

  /* -------------------------------------------------------- audiobuffer -- */
  function createBuffer(ch, len, sr) {
    ch = Math.max(1, ch | 0); len = Math.max(1, len | 0); sr = +sr || sampleRate;
    var data = [], i;
    for (i = 0; i < ch; i++) data.push(new Float32Array(len));
    var b = {
      __id: ++REC.bufSeq, __label: null,
      sampleRate: sr, length: len, duration: len / sr, numberOfChannels: ch,
      getChannelData: function (k) {
        k = k | 0;
        if (k < 0 || k >= ch) throw new RangeError('channel index out of range');
        return data[k];
      },
      copyFromChannel: function (dst, k, off) {
        var s = data[k | 0], o = off | 0, j;
        for (j = 0; j < dst.length && o + j < s.length; j++) dst[j] = s[o + j];
      },
      copyToChannel: function (src, k, off) {
        var d = data[k | 0], o = off | 0, j;
        for (j = 0; j < src.length && o + j < d.length; j++) d[o + j] = src[j];
      },
    };
    return b;
  }

  function createPeriodicWave(re, im, opt) {
    return { __name: 'w' + (re && re.length), real: re, imag: im };
  }

  /* ------------------------------------------------------------- ctx ---- */
  var dest = baseNode('Destination');
  dest.maxChannelCount = 2;
  var ctx = {
    sampleRate: sampleRate,
    baseLatency: 0.005, outputLatency: 0.01,
    state: 'running',
    destination: dest,
    listener: {
      positionX: new Param(0), positionY: new Param(0), positionZ: new Param(0),
      forwardX: new Param(0), forwardY: new Param(0), forwardZ: new Param(-1),
      upX: new Param(0), upY: new Param(1), upZ: new Param(0),
      setPosition: function () {}, setOrientation: function () {},
    },
    get currentTime() { return REC.nowMs / 1000; },
    resume: function () { ctx.state = 'running'; return Promise.resolve(); },
    suspend: function () { ctx.state = 'suspended'; return Promise.resolve(); },
    close: function () { ctx.state = 'closed'; return Promise.resolve(); },
    createBuffer: createBuffer,
    createBufferSource: createBufferSource,
    createOscillator: createOscillator,
    createConstantSource: createConstantSource,
    createGain: createGain,
    createBiquadFilter: createBiquadFilter,
    createPanner: createPanner,
    createStereoPanner: createStereoPanner,
    createDelay: createDelay,
    createWaveShaper: createWaveShaper,
    createConvolver: createConvolver,
    createDynamicsCompressor: createDynamicsCompressor,
    createChannelSplitter: createChannelSplitter,
    createChannelMerger: createChannelMerger,
    createAnalyser: createAnalyser,
    createPeriodicWave: createPeriodicWave,
    decodeAudioData: function () { return Promise.reject(new Error('harness: no assets')); },
    addEventListener: function () {}, removeEventListener: function () {},
  };
  global.AudioContext = function () { return ctx; };
  global.webkitAudioContext = global.AudioContext;
  global.__ctx = ctx;

  /* --------------------------------------------------------- timebase --- */
  global.performance = { now: function () { return REC.nowMs; } };
  global.setTimeout = function (fn, ms) {
    var id = ++REC.timerSeq;
    REC.timers.push({ id: id, due: REC.nowMs + (+ms || 0), fn: fn });
    return id;
  };
  global.clearTimeout = function (id) {
    for (var i = 0; i < REC.timers.length; i++) if (REC.timers[i].id === id) { REC.timers.splice(i, 1); return; }
  };
  global.setInterval = function () { return 0; };
  global.clearInterval = function () {};
  global.requestAnimationFrame = function (fn) { REC.raf.push(fn); return REC.raf.length; };
  global.cancelAnimationFrame = function () {};
  global.queueMicrotask = function (fn) { try { fn(); } catch (e) {} };

  /* Advance the single virtual clock that drives ctx.currentTime,
     performance.now(), setTimeout and every source's ended event. */
  global.__advance = function (ms, opts) {
    opts = opts || {};
    var step = opts.step === undefined ? 2 : opts.step;
    var target = REC.nowMs + ms;
    var guard = 0;
    while (REC.nowMs < target - 1e-9 && guard++ < 2000000) {
      var next = Math.min(target, REC.nowMs + step);
      REC.nowMs = next;
      /* due timers, oldest first, re-entrant safe */
      for (var pass = 0; pass < 64; pass++) {
        var due = null, di = -1, i;
        for (i = 0; i < REC.timers.length; i++)
          if (REC.timers[i].due <= REC.nowMs + 1e-9 && (!due || REC.timers[i].due < due.due || (REC.timers[i].due === due.due && REC.timers[i].id < due.id))) { due = REC.timers[i]; di = i; }
        if (!due) break;
        REC.timers.splice(di, 1);
        try { due.fn(); } catch (e) { (global.__stubErrors || (global.__stubErrors = [])).push(String(e && e.message || e)); }
      }
      /* ended events */
      var keep = [], k;
      for (k = 0; k < REC.pending.length; k++) {
        var s = REC.pending[k];
        if (s.__stopAt !== null && s.__stopAt !== undefined && s.__stopAt * 1000 <= REC.nowMs + 1e-9) {
          var cb = s.onended;
          if (cb) { try { cb.call(s, { type: 'ended', target: s }); } catch (e) {} }
        } else keep.push(s);
      }
      REC.pending = keep;
      /* animation frames on a 60 Hz beat */
      REC.rafAcc += step;
      while (REC.rafAcc >= 16.666) {
        REC.rafAcc -= 16.666;
        var q = REC.raf; REC.raf = [];
        for (var r = 0; r < q.length; r++) { try { q[r](REC.nowMs); } catch (e) {} }
      }
    }
  };
  global.__markVoices = function () { return REC.voices.length; };
  global.__voicesSince = function (n) { return REC.voices.slice(n); };
  global.__resetVoices = function () { REC.voices.length = 0; REC.voiceSeq = 0; };
}

/* ==================================================== sandbox =========== */
const MODULE_ERRORS = [];
const MODULE_WARNINGS = [];
function fmtArg(a) {
  if (a && typeof a === 'object' && typeof a.message === 'string' && ('stack' in a))
    return a.message + (a.stack ? '\n      ' + String(a.stack).split('\n').slice(1, 4).map(s => s.trim()).join('\n      ') : '');
  if (typeof a === 'object' && a) { try { return JSON.stringify(a).slice(0, 300); } catch (e) { return String(a); } }
  return String(a);
}

function makeEl() {
  const el = {
    style: {}, width: 1, height: 1, children: [],
    getContext() { return null; }, appendChild(c) { return c; }, removeChild(c) { return c; },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    toDataURL() { return 'data:,'; },
  };
  return el;
}

function makeSandbox(seed) {
  const s = {};
  s.globalThis = s; s.self = s; s.window = s; s.top = s; s.parent = s;
  s.console = {
    log() {}, info() {}, debug() {},
    warn: (...a) => MODULE_WARNINGS.push(a.map(fmtArg).join(' ')),
    error: (...a) => MODULE_ERRORS.push(a.map(fmtArg).join(' ')),
  };
  s.Date = Date;
  s.navigator = { userAgent: 'node-audio-harness', hardwareConcurrency: 8, deviceMemory: 8, platform: 'node' };
  s.location = { search: '', href: 'http://localhost/', hash: '', protocol: 'http:' };
  s.document = {
    createElement: makeEl, createElementNS: makeEl,
    addEventListener() {}, removeEventListener() {},
    body: makeEl(), head: makeEl(), documentElement: makeEl(),
    visibilityState: 'visible', hidden: false, readyState: 'complete',
  };
  s.addEventListener = () => {}; s.removeEventListener = () => {};
  s.devicePixelRatio = 1; s.innerWidth = 1280; s.innerHeight = 720;
  s.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  s.TextDecoder = TextDecoder; s.TextEncoder = TextEncoder;
  vm.createContext(s);

  /* deterministic Math.random unless --random: mulberry32 in the sandbox */
  if (!OPT.random) {
    vm.runInContext(`
      (function(){
        var a = ${seed >>> 0} >>> 0;
        Math.random = function(){
          a |= 0; a = (a + 0x6D2B79F5) | 0;
          var t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      })();
    `, s, { filename: 'harness:rng' });
  }
  vm.runInContext('(' + AUDIO_STUB.toString() + ')(globalThis, 48000);', s, { filename: 'harness:webaudio-stub' });
  return s;
}

/* The game-scope globals nz-audio reads by bare identifier. These mirror the
   production player scale and prove a firearm cue at the player's exact x/z
   takes the first-person path even though the legacy emitterY (2.4) is 3.585
   units below the current 5.985-unit listener ear.                         */
const GAME_GLOBALS = `
  var CELL = 4, M = 3.5, EYE = 1.71 * M, MW = 64, MH = 48, S_SOLID = 0;
  var player = { x: 100, y: 0, z: 100, yaw: 0, ads: 0, hp: 100 };
  var camera = { matrixWorld: { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] } };
  var grid = new Uint8Array(MW * MH).fill(1);
  function idx(x, z) { return z * MW + x; }
  function inb(x, z) { return x >= 0 && z >= 0 && x < MW && z < MH; }
  function regAt(x, z) { return { f: 0, c: 11, sky: false, ftex: 'concrete' }; }
  function floorAt(x, z) { return 0; }
  var enemies = [];
  var keysDown = {};
  var WPN = null;
`;

/* ======================================================== booting ======= */
class Boot {
  /* `srcOverride` boots a REPLACEMENT text for nz-audio.js instead of the file
     on disk. Used only by the shotgun/chain regression, which reconstructs the
     pre-change build in memory; the file itself is never touched. */
  constructor(seed, srcOverride, label) { this.seed = seed; this.src = srcOverride || null; this.label = label || 'nz-audio.js'; this.notes = []; }
  run() {
    for (const f of ['nz-core.js', 'nz-audio.js'])
      if (!exists(f)) throw new Error(`missing required file: ${f} (looked in ${ROOT})`);
    const s = this.s = makeSandbox(this.seed);
    vm.runInContext(rd('nz-core.js'), s, { filename: 'nz-core.js' });
    if (!s.NZ || !s.NZ.on) throw new Error('nz-core.js did not create the NZ hook bus (NZ.on missing)');
    vm.runInContext(GAME_GLOBALS, s, { filename: 'harness:game-globals' });
    vm.runInContext(this.src === null ? rd('nz-audio.js') : this.src, s, { filename: this.label });
    if (!s.NZ.has('sfx'))
      throw new Error(
        'nz-audio.js parsed but never registered an `sfx` listener, so it can never install. ' +
        'Its top-level guard `var NZ = global.NZ; if (!NZ || !NZ.on) return;` probably took the early ' +
        'return path, or something threw at top level before the NZ.on("sfx", ...) call.');
    if (!s.NZ.audio || typeof s.NZ.audio._probe !== 'function')
      throw new Error('nz-audio.js did not publish NZ.audio._probe(); the offline analysis hook is gone.');

    /* the AU object the game owns. ensure() needs ctx + master. */
    vm.runInContext(`
      var AU = { ctx: new AudioContext(), master: null, muted: false };
      AU.master = AU.ctx.createGain();
      AU.master.gain.value = 0.8;
      AU.master.connect(AU.ctx.destination);
      globalThis.AU = AU;
    `, s, { filename: 'harness:AU' });

    /* install through the module's own path: an sfx name it does not
       implement runs ensure(AU) and then falls through with no cue fired. */
    const t0 = Date.now();
    let r;
    try { r = s.NZ.first('sfx', '__harness_install__', undefined, undefined, s.AU); }
    catch (e) { throw new Error('the sfx hook threw during install: ' + fmtArg(e)); }
    this.installMs = Date.now() - t0;
    if (r !== undefined) this.notes.push('sfx("__harness_install__") returned ' + r + ' (expected undefined)');
    if (!s.NZ.flags.audio)
      throw new Error(
        'ensure(AU) ran but NZ.flags.audio is still false, so nz-audio did not take over. ' +
        (MODULE_ERRORS.length ? 'Module said: ' + MODULE_ERRORS.slice(0, 3).join(' | ')
                              : 'No module error was captured; check ensure() for an early return (AU.ctx / AU.master missing).'));
    this.NZ = s.NZ;
    this.stats0 = s.NZ.audio.stats();
    return this;
  }
  advance(ms, opts) { this.s.__advance(ms, opts); }
  now() { return this.s.__ctx.currentTime; }
  mark() { return this.s.__REC.voices.length; }
  since(n) { return this.s.__REC.voices.slice(n); }
  stats() { return JSON.parse(JSON.stringify(this.NZ.audio.stats())); }
}

/* ============================================================== fft ===== */
/* iterative radix-2 Cooley-Tukey; no dependencies, in-place on re/im */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function spectrum(chan, sr, minPow2) {
  const n = chan.length;
  let N = 1; while (N < Math.max(n * 4, minPow2 || 0)) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = chan[i];
  fft(re, im);
  const half = N >> 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
  return { mag, df: sr / N, N };
}

/* ==================================================== buffer metrics ==== */
function bufMetrics(chan, sr) {
  const n = chan.length;
  let peak = 0, ipk = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(chan[i]);
    if (a > peak) { peak = a; ipk = i; }
    sum2 += chan[i] * chan[i];
  }
  const rms = Math.sqrt(sum2 / n);
  const crestDb = (rms > 1e-12) ? 20 * Math.log10(peak / rms) : Infinity;

  /* rise: 10% -> 90% of the leading edge of the largest excursion */
  const sgn = chan[ipk] >= 0 ? 1 : -1;
  let i10 = ipk, i90 = ipk;
  for (let i = ipk; i >= 0; i--) { if (Math.abs(chan[i]) <= 0.9 * peak) { i90 = i; break; } i90 = 0; }
  for (let i = i90; i >= 0; i--) { if (Math.abs(chan[i]) <= 0.1 * peak) { i10 = i; break; } i10 = 0; }
  const riseSamples = Math.max(0, i90 - i10);
  const riseUs = riseSamples / sr * 1e6;

  /* positive phase: onset (10% point) to the first crossing back through 0 */
  let izc = n - 1;
  for (let i = ipk; i < n; i++) { if (chan[i] * sgn <= 0) { izc = i; break; } }
  const posMs = (izc - i10) / sr * 1000;

  const { mag, df } = spectrum(chan, sr, 32768);
  /* spectral peak below 8 kHz, skipping the DC bin */
  const kMax = Math.min(mag.length - 1, Math.floor(8000 / df));
  let best = 1, bestV = -1;
  for (let k = 1; k <= kMax; k++) if (mag[k] > bestV) { bestV = mag[k]; best = k; }
  /* parabolic interpolation for sub-bin accuracy */
  const interp = (k) => {
    if (k <= 0 || k >= mag.length - 1) return k * df;
    const a = mag[k - 1], b = mag[k], c = mag[k + 1];
    const d = (a - c) / (2 * (a - 2 * b + c) || 1e-30);
    return (k + (Math.abs(d) < 1 ? d : 0)) * df;
  };
  const peakHz = interp(best);
  /* secondary: the peak of the shock front alone, ignoring the gas cloud */
  const kLo = Math.max(1, Math.floor(200 / df));
  let b2 = kLo, b2v = -1;
  for (let k = kLo; k <= kMax; k++) if (mag[k] > b2v) { b2v = mag[k]; b2 = k; }
  const peakHzAbove200 = interp(b2);

  let num = 0, den = 0;
  for (let k = 1; k < mag.length; k++) { num += k * df * mag[k]; den += mag[k]; }
  const centroid = den > 0 ? num / den : 0;

  /* the strongest local maxima below 8 kHz, so a "wrong" spectral peak can be
     attributed to the component that actually stole it */
  const cand = [];
  for (let k = 2; k < kMax; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) cand.push(k);
  cand.sort((a, b) => mag[b] - mag[a]);
  const topPeaks = [];
  for (const k of cand) {
    if (topPeaks.some(p => Math.abs(p.k - k) * df < 45)) continue;
    topPeaks.push({ k, hz: +interp(k).toFixed(1), mag: mag[k], rel: +(20 * Math.log10(mag[k] / bestV)).toFixed(2) });
    if (topPeaks.length >= 6) break;
  }

  /* octave-band share of the magnitude spectrum */
  const bands = [[0, 90], [90, 180], [180, 355], [355, 710], [710, 1420], [1420, 2840], [2840, 5680], [5680, 11360], [11360, 24000]];
  const bandShare = bands.map(([lo, hi]) => {
    let s = 0;
    const a = Math.max(1, Math.round(lo / df)), b = Math.min(mag.length - 1, Math.round(hi / df));
    for (let k = a; k <= b; k++) s += mag[k];
    return { band: `${lo}-${hi}`, share: den > 0 ? +(s / den).toFixed(4) : 0 };
  });

  /* Physically-grounded companion to the raw spectral maximum: a Friedlander
     pulse of positive-phase duration T peaks at 1/(2*pi*T), and T is what the
     time domain measures directly, uncontaminated by the gas cloud and the
     barrel modes that share the buffer. */
  const frontImpliedHz = posMs > 0 ? 1 / (2 * Math.PI * (posMs / 1000)) : 0;

  return {
    samples: n, durMs: n / sr * 1000, peak, rms, crestDb,
    peakHz, peakHzAbove200, centroid, riseUs, riseSamples, posMs, frontImpliedHz,
    onsetSample: i10, peakSample: ipk, zeroCrossSample: izc,
    topPeaks, bandShare,
    mag, df,
  };
}

/* magnitude in a window + local prominence over a median baseline */
function modeAt(m, fLo, fHi, guardHz) {
  const df = m.df, mag = m.mag;
  const kA = Math.max(1, Math.round(fLo / df)), kB = Math.min(mag.length - 1, Math.round(fHi / df));
  let mx = -1, kMx = kA;
  for (let k = kA; k <= kB; k++) if (mag[k] > mx) { mx = mag[k]; kMx = k; }
  const fc = (fLo + fHi) / 2;
  const g = guardHz || 220;
  const nA = Math.max(1, Math.round((fc - g) / df)), nB = Math.min(mag.length - 1, Math.round((fc + g) / df));
  const around = [];
  for (let k = nA; k <= nB; k++) if (k < kA || k > kB) around.push(mag[k]);
  around.sort((a, b) => a - b);
  const base = around.length ? around[Math.floor(around.length / 2)] : 1e-12;
  return {
    hz: kMx * df, mag: mx, baseline: base,
    prominenceDb: 20 * Math.log10(Math.max(mx, 1e-12) / Math.max(base, 1e-12)),
  };
}

/* ================================================= voice labelling ======
   Identification of a recorded voice against the call sites in nz-audio.js.
   Three fingerprints, and only the first of them is written down here:

     TIME    every cue schedules its blast at T0 and its mechanism at
             T0 + jt + <offset>, so blast-relative time is exactly
             jt + <offset> and is independent of MECH_T0. Those offsets are
             measurements of a bolt carrier and a slide -- physical facts, not
             tuning -- so they are the stable key and every layer is located
             BY them, either by the offset itself or by the name of the
             variable the cue schedules it from (tBuf, tBat, tR, tB).
     SHAPE   the node type (osc / buffer) plus the head of the filter chain,
             which separates the primitives outright: tick()->smp() leads with
             a highpass, nz() with its own band filter, blast()->smp() with
             the peaking bump and the shaper.
     LEVEL   the peak of the layer's gain envelope -- PARSED OUT OF THE
             SOURCE rather than tabulated, see below.

   WHY THE LEVELS ARE PARSED. The gains are this module's tuning surface:
   MECH_G, pmv and the per-layer literals get retuned, and every time they do,
   a labeller holding last week's numbers stops recognising the layer it
   exists to measure. That reports SKIP -- and a SKIP is not a PASS, it is the
   assertion quietly not running, which is strictly worse than a FAIL because
   it looks green. So each layer's window is computed from the `vol:`
   expression written at its own call site, evaluated at the corners of that
   cue's jitter (jv, rr(), opening), and pushed through whatever the primitive
   does to it on the way to the gain node -- which is read out of the
   primitive by the same machinery. Changing MECH_G from 1 to 0.42 moves these
   windows on its own; so does editing 0.072, or replacing mv with something
   else, as long as the layer still stands where the measurement puts it.

   Ratios are preserved for free: everything the mech block schedules shares
   one scale factor, so a relative fingerprint would also survive a retune --
   but the absolute window is strictly more selective and costs nothing once
   the expression is being read anyway. */

/* ---- just enough of JavaScript to read a `vol:` -------------------------
   Comments are stripped first: the walk below counts braces and commas, and
   this module's prose contains plenty of both. */
const SRC_NC = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/gm, '$1');
const OPENC = '([{', CLOSEC = ')]}';
function balanced(s, i) {                     /* i indexes an opener -> index past its match */
  let d = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (OPENC.indexOf(c) >= 0) d++;
    else if (CLOSEC.indexOf(c) >= 0) { if (--d === 0) return k + 1; }
  }
  return -1;
}
function splitTop(s) {                        /* top-level commas only */
  const out = []; let d = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (OPENC.indexOf(c) >= 0) d++;
    else if (CLOSEC.indexOf(c) >= 0) d--;
    else if (c === ',' && d === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(x => x.length);
}
/* object-literal fields. The FIRST colon is the key separator, so a ternary
   value (`drive: self ? 'blastLite' : null`) survives intact. */
function fieldsOf(objText) {
  const out = {};
  for (const part of splitTop(String(objText).trim().replace(/^\{/, '').replace(/\}$/, ''))) {
    const c = part.indexOf(':');
    if (c < 0) continue;
    const k = part.slice(0, c).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(k)) out[k] = part.slice(c + 1).trim();
  }
  return out;
}
const FNSRC = new Map();
function fnSrcNC(name) {
  if (!FNSRC.has(name)) {
    const i = SRC_NC.indexOf('function ' + name + '(');
    let out = '';
    if (i >= 0) {
      const j = SRC_NC.indexOf('{', i), k = j >= 0 ? balanced(SRC_NC, j) : -1;
      if (k > 0) out = SRC_NC.slice(i, k);
    }
    FNSRC.set(name, out);
  }
  return FNSRC.get(name);
}
/* every call to `prim` inside function `fn`, with its balanced argument text.
   Scanning resumes past each match, so a primitive nested in another's
   arguments is never counted twice, and `function prim(` is skipped. */
const CALLC = new Map();
function callsOf(fn, prim) {
  const key = fn + '\u0000' + prim;
  if (CALLC.has(key)) return CALLC.get(key);
  const src = fnSrcNC(fn), out = [];
  if (src) {
    const re = new RegExp('\\b' + prim + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src))) {
      if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) {
        re.lastIndex = m.index + m[0].length; continue;
      }
      const open = m.index + m[0].length - 1, end = balanced(src, open);
      if (end < 0) break;
      out.push({ arg: src.slice(open + 1, end - 1) });
      re.lastIndex = end;
    }
  }
  CALLC.set(key, out);
  return out;
}
/* `var a = x, b = y;` declarations in source order, multi-declarator aware */
const DECLC = new Map();
function declsOf(fn) {
  if (DECLC.has(fn)) return DECLC.get(fn);
  const src = fnSrcNC(fn), out = [];
  const re = /\bvar\s+/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, d = 0;
    const s0 = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (OPENC.indexOf(c) >= 0) d++;
      else if (CLOSEC.indexOf(c) >= 0) { if (d === 0) break; d--; }
      else if (c === ';' && d === 0) break;
    }
    for (const part of splitTop(src.slice(s0, i))) {
      const q = part.indexOf('=');
      if (q < 0) continue;
      const nm = part.slice(0, q).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) out.push([nm, part.slice(q + 1).trim()]);
    }
    re.lastIndex = i;
  }
  DECLC.set(fn, out);
  return out;
}
const FCACHE = new Map();
function EV(expr, env) {
  const ks = Object.keys(env), key = ks.join(',') + '\u0000' + expr;
  let f = FCACHE.get(key);
  if (!f) { f = new Function(...ks, '"use strict";return (' + expr + ');'); FCACHE.set(key, f); }
  return f(...ks.map(k => env[k]));
}
/* The harness fires every cue first-person with the listener on the emitter,
   which is what newBus() turns into near = 1, far = 0 and a sub scale of
   1 - dist/55. Anything a declaration needs that only exists at run time
   (ctx, TIER, live, the bus itself) throws and is simply left alone. */
const EMIT_B = { self: true, near: 1, far: 0, dist: 0.451, dm: 0.0338 };
function baseEnv(over) {
  return Object.assign({
    Math: Math,
    rr: (a) => a,
    fin: (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d,
    cl: (v, lo, hi) => { v = (typeof v === 'number' && isFinite(v)) ? v : lo; return v < lo ? lo : (v > hi ? hi : v); },
    isNum: (v) => typeof v === 'number' && isFinite(v),
    subScale: (bb) => Math.min(Math.max(1 - bb.dist / 55, 0.06), 1),
    b: Object.assign({}, EMIT_B),
    self: true, ss: Math.max(1 - EMIT_B.dist / 55, 0.06),
    supp: false, T0: 0, jt: 0, jv: 0, n: 0, alt: 0, opening: true, mechM: 1,
  }, over || {});
}
function bodyEnv(fn, seed) {
  const env = Object.assign({}, seed);
  for (const [nm, x] of declsOf(fn)) {
    let val;
    try { val = EV(x, env); } catch (err) { continue; }
    if (val !== undefined) env[nm] = val;
  }
  return env;
}
/* A gain recipe is the chain of call sites a level passes through on its way
   from the cue to the gain node that finally carries it:
     [fn, primitive, which, field, bindAs]
       which  RegExp matched against that call's own argument text, or an index
       field  object-literal key, or a positional argument index
       bindAs how the previous hop's value enters this one; omitted on hop 0
   Evaluated at the four corners of (rr low/high) x (opening true/false):
   every vol expression in this module is a product of positive terms, so the
   corners of the jitter box are the extremes of the gain. */
const GAIN_MISS = [];
function gainOf(tag, over, hops) {
  const corners = [];
  for (const lo of [true, false]) for (const op of [true, false]) {
    let val = null, ok = true;
    for (const h of hops) {
      const [fn, prim, which, field, bind] = h;
      const cs = callsOf(fn, prim);
      const call = which instanceof RegExp ? cs.find(c => which.test(c.arg)) : cs[which || 0];
      if (!call) { ok = false; break; }
      const seed = baseEnv(Object.assign({ rr: (a, x) => lo ? a : x, opening: op }, over));
      if (bind === 'o.vol') seed.o = { vol: val };
      else if (bind === 'o.near') seed.o = { near: val };
      else if (bind) seed[bind] = val;
      const env = bodyEnv(fn, seed);
      const args = splitTop(call.arg);
      const expr = typeof field === 'number' ? args[field] : fieldsOf(args[args.length - 1] || '')[field];
      if (expr === undefined) { ok = false; break; }
      try { val = EV(expr, env); } catch (err) { ok = false; break; }
      if (typeof val !== 'number' || !isFinite(val)) { ok = false; break; }
    }
    if (!ok) { GAIN_MISS.push(tag); return null; }
    corners.push(val);
  }
  return [Math.min(...corners), Math.max(...corners)];
}
/* the two layers tick() splits into, both read out of tick() itself */
const TICK_SMP = ['tick', 'smp', 0, 'vol', 'o.vol'];      /* bright sample     */
const TICK_TONE = ['tick', 'tn', 0, 'vol', 'o.vol'];      /* body:true low tone */

/* `fam` is the head of the filter chain the primitive builds. */
const FAM = { hp: /^highpass@/, bp: /^bandpass@/, lp: /^lowpass@/, blast: /peaking@|shaper/ };
const e = (name, tLo, tHi, kind, gain, fam) => ({
  name, tLo, tHi, kind, fam: fam ? FAM[fam] : null,
  gLo: gain ? gain[0] : null, gHi: gain ? gain[1] : null,
});
/* Windows are jt-inclusive: rifle jt is 0-3.2 ms, pistol jt 0-2.8 ms.
   preTransient() schedules in absolute cue time rather than from T0, so its
   two layers sit at -MECH_T0 + t. */
const P0 = -MECH_T0_MS;                 /* where the sfx() call is, blast-rel */

/* The suppressed rifle is the same cue with supp = true, so it is the same
   table evaluated in a different environment rather than a second copy that
   can drift out of step with the first. The layers that only exist on one
   path -- the live pair and the near-field scatter unsuppressed, the baffle
   jetting and the wide port gas suppressed -- are gated the same way the cue
   gates them, because two of them overlap in both time and level and would
   otherwise be able to answer for each other. */
function rifleMap(supp) {
  const over = { supp: !!supp };
  const tag = supp ? 'rifleq' : 'rifle';
  const G = (what, ...hops) => gainOf(tag + ':' + what, over, hops);
  const PRE = ['cueRifle', 'preTransient', 0, 'vol'];
  const PG = ['cueRifle', 'portGas', 0, 2];
  const CO = ['cueRifle', 'caseOut', 0, 2];
  const BS = ['cueRifle', 'bufferSpring', 0, 2];
  const REP = ['cueRifle', 'report', 0, 1];
  return [
    e('sear/hammer', P0 + 1.6, P0 + 2.1, 'buffer',
      G('sear', PRE, ['preTransient', 'tick', 0, 'vol', 'o.vol'], TICK_SMP), 'hp'),
    e('bore precursor', P0 + 1.8, P0 + 1.8, 'buffer',
      G('bore', PRE, ['preTransient', 'nz', 0, 'vol', 'o.vol']), 'bp'),
    e('muzzle blast (near)', -0.05, 0.05, 'buffer',
      G('blast', ['cueRifle', 'blast', 0, 'near'], ['blast', 'smp', 0, 'vol', 'o.near']), 'blast'),
    ...(supp ? [
      e('baffle jetting', 0.8, 4.0, 'buffer', G('baffle', ['cueRifle', 'nz', /rr\(2100/, 'vol']), 'bp'),
      e('port gas (wide)', 7.0, 17.4, 'buffer', G('portwide', PG, ['portGas', 'nz', 2, 'vol', 'v']), 'bp'),
    ] : [
      e('near-field scatter', 0.4, 4.3, 'buffer', G('scatter', ['cueRifle', 'nz', /rr\(5200/, 'vol']), 'bp'),
      e('live top', 0.8, 4.0, 'buffer', G('livetop', ['cueRifle', 'nz', /rr\(4200,\s*6200\)/, 'vol']), 'bp'),
      e('live body', 1.2, 4.4, 'buffer', G('livebody', ['cueRifle', 'nz', /rr\(760/, 'vol']), 'bp'),
    ]),
    e('sub thump', 0.9, 4.1, 'osc', G('sub', ['cueRifle', 'tn', /f0:\s*116/, 'vol'])),
    e('bolt unlock', 2.1, 6.1, 'buffer', G('unlock', ['cueRifle', 'nz', /0\.0021/, 'vol']), 'bp'),
    e('port gas', 3.0, 7.4, 'buffer', G('port', PG, ['portGas', 'nz', 0, 'vol', 'v']), 'bp'),
    e('port gas (jet)', 3.6, 8.0, 'buffer', G('portjet', PG, ['portGas', 'nz', 1, 'vol', 'v']), 'bp'),
    e('case out', 14.0, 20.7, 'buffer', G('caseout', CO, ['caseOut', 'tick', 0, 'vol', 'v'], TICK_SMP), 'hp'),
    e('case deflector', 16.2, 24.5, 'buffer', G('casedef', CO, ['caseOut', 'tick', 1, 'vol', 'v'], TICK_SMP), 'hp'),
    e('case deflector', 16.2, 24.5, 'osc', G('casedefT', CO, ['caseOut', 'tick', 1, 'vol', 'v'], TICK_TONE)),
    e('report (roll)', 18.0, 21.2, 'buffer', G('reproll', REP, ['report', 'nz', 5, 'vol', 'weight']), 'lp'),
    e('buffer bottoming', 24.0, 31.2, 'osc', G('bufT', ['cueRifle', 'tn', /t:\s*tBuf\s*,/, 'vol'])),
    e('buffer bottoming', 24.0, 31.2, 'buffer', G('bufN', ['cueRifle', 'nz', /t:\s*tBuf\s*,/, 'vol']), 'bp'),
    e('buffer weights', 25.0, 32.9, 'buffer',
      G('bufW', ['cueRifle', 'tick', /t:\s*tBuf\s*\+/, 'vol'], TICK_SMP), 'hp'),
    e('buffer spring', 27.5, 38.2, 'osc', G('spring1', BS, ['bufferSpring', 'tn', 0, 'vol', 'v'])),
    e('buffer spring 2', 27.5, 40.4, 'osc', G('spring2', BS, ['bufferSpring', 'tn', 1, 'vol', 'v'])),
    e('spring scrape', 28.5, 39.2, 'buffer', G('scrape', BS, ['bufferSpring', 'nz', 0, 'vol', 'v']), 'bp'),
    e('report (body)', 30.0, 33.2, 'osc', G('repbody', REP, ['report', 'tn', 2, 'vol', 'weight'])),
    e('into battery', 67.5, 78.7, 'buffer',
      G('battery', ['cueRifle', 'tick', /t:\s*tBat\s*,/, 'vol'], TICK_SMP), 'hp'),
    e('into battery', 67.5, 78.7, 'osc',
      G('batteryT', ['cueRifle', 'tick', /t:\s*tBat\s*,/, 'vol'], TICK_TONE)),
    e('into battery ring', 68.4, 79.6, 'buffer',
      G('batteryR', ['cueRifle', 'tick', /t:\s*tBat\s*\+/, 'vol'], TICK_SMP), 'hp'),
  ];
}
function pistolMap() {
  const G = (what, ...hops) => gainOf('pistol:' + what, {}, hops);
  const PRE = ['cuePistol', 'preTransient', 0, 'vol'];
  const CO = ['cuePistol', 'caseOut', 0, 2];
  const REP = ['cuePistol', 'report', 0, 1];
  return [
    e('sear/hammer', P0 + 1.6, P0 + 2.1, 'buffer',
      G('sear', PRE, ['preTransient', 'tick', 0, 'vol', 'o.vol'], TICK_SMP), 'hp'),
    e('bore precursor', P0 + 1.8, P0 + 1.8, 'buffer',
      G('bore', PRE, ['preTransient', 'nz', 0, 'vol', 'o.vol']), 'bp'),
    e('muzzle blast (near)', -0.05, 0.05, 'buffer',
      G('blast', ['cuePistol', 'blast', 0, 'near'], ['blast', 'smp', 0, 'vol', 'o.near']), 'blast'),
    e('sub thump', 0.6, 3.4, 'osc', G('sub', ['cuePistol', 'tn', /f0:\s*163/, 'vol'])),
    e('live top', 0.9, 3.7, 'buffer', G('livetop', ['cuePistol', 'nz', /rr\(3400/, 'vol']), 'bp'),
    e('barrel unlock', 1.6, 5.0, 'buffer',
      G('unlock', ['cuePistol', 'tick', /rr\(3000/, 'vol'], TICK_SMP), 'hp'),
    e('case out', 9.0, 13.6, 'buffer', G('caseout', CO, ['caseOut', 'tick', 0, 'vol', 'v'], TICK_SMP), 'hp'),
    e('case deflector', 11.2, 17.4, 'buffer', G('casedef', CO, ['caseOut', 'tick', 1, 'vol', 'v'], TICK_SMP), 'hp'),
    e('case deflector', 11.2, 17.4, 'osc', G('casedefT', CO, ['caseOut', 'tick', 1, 'vol', 'v'], TICK_TONE)),
    e('slide -> frame', 11.8, 16.6, 'osc', G('slideT', ['cuePistol', 'tn', /t:\s*tR\s*,/, 'vol'])),
    e('slide -> frame', 11.8, 16.6, 'buffer', G('slideN', ['cuePistol', 'nz', /t:\s*tR\s*,/, 'vol']), 'bp'),
    e('slide ring', 12.2, 17.0, 'buffer',
      G('slideR', ['cuePistol', 'tick', /t:\s*tR\s*\+/, 'vol'], TICK_SMP), 'hp'),
    e('report (roll)', 18.0, 20.8, 'buffer', G('reproll', REP, ['report', 'nz', 5, 'vol', 'weight']), 'lp'),
    e('recoil spring', 20.0, 30.8, 'buffer', G('recoil', ['cuePistol', 'nz', /'grit'/, 'vol']), 'bp'),
    e('report (body)', 30.0, 32.8, 'osc', G('repbody', REP, ['report', 'tn', 2, 'vol', 'weight'])),
    e('into battery', 38.5, 45.3, 'buffer',
      G('battery', ['cuePistol', 'tick', /t:\s*tB\s*,/, 'vol'], TICK_SMP), 'hp'),
    e('into battery', 38.5, 45.3, 'osc',
      G('batteryT', ['cuePistol', 'tick', /t:\s*tB\s*,/, 'vol'], TICK_TONE)),
    e('into battery ring', 39.3, 46.1, 'buffer',
      G('batteryR', ['cuePistol', 'tick', /t:\s*tB\s*\+/, 'vol'], TICK_SMP), 'hp'),
  ];
}
const RIFLE_MAP = rifleMap(false);
const RIFLEQ_MAP = rifleMap(true);
const PISTOL_MAP = pistolMap();
/* what the parse produced, so a wrong window is visible rather than inferred
   from a missing label */
function mapDump(map) {
  return map.map(c => ({
    layer: c.name, kind: c.kind,
    msFromBlast: [+c.tLo.toFixed(2), +c.tHi.toFixed(2)],
    peakGain: c.gLo === null ? null : [+c.gLo.toFixed(5), +c.gHi.toFixed(5)],
  }));
}
/* The `vol:` a call site actually writes, and the leading coefficient in it,
   for diagnostics that have to name a number to change. */
function volExprOf(fn, prim, which) {
  const cs = callsOf(fn, prim);
  const call = which instanceof RegExp ? cs.find(c => which.test(c.arg)) : cs[which || 0];
  if (!call) return null;
  const args = splitTop(call.arg);
  const expr = fieldsOf(args[args.length - 1] || '').vol;
  if (!expr) return null;
  const k = Number((expr.match(/^\s*([0-9.]+(?:[eE][+-]?\d+)?)/) || [])[1]);
  return { expr: expr.replace(/\s+/g, ' '), k: isFinite(k) ? k : null };
}
/* `--gains` prints the parsed windows and stops: the fastest way to see what
   an edit to nz-audio.js did to the identification table. */
if (flag('gains', false)) {
  console.log(JSON.stringify({
    unresolvedRecipes: GAIN_MISS,
    rifle: mapDump(RIFLE_MAP), rifleq: mapDump(RIFLEQ_MAP), pistol: mapDump(PISTOL_MAP),
  }, null, 1));
  process.exit(0);
}

function labelVoice(ms, kind, peak, filt, map) {
  /* first pass: kind, gain and filter family must all agree, then nearest in
     time. A recipe that failed to parse leaves the gain unconstrained, which
     degrades this to time + node type + filter family rather than to nothing. */
  let best = null, bestD = Infinity, exact = false;
  for (const c of map) {
    if (c.kind && c.kind !== kind) continue;
    if (c.fam && !c.fam.test(filt || '')) continue;
    const gOk = c.gLo === null || (peak !== null && peak >= c.gLo * 0.98 && peak <= c.gHi * 1.02);
    if (!gOk) continue;
    const d = ms < c.tLo ? c.tLo - ms : (ms > c.tHi ? ms - c.tHi : 0);
    if (d < bestD) { bestD = d; best = c.name; exact = d <= 1.5; }
  }
  if (best) return exact ? best : best + '?';
  /* second pass: time only */
  for (const c of map) {
    if (c.kind && c.kind !== kind) continue;
    const d = ms < c.tLo ? c.tLo - ms : (ms > c.tHi ? ms - c.tHi : 0);
    if (d < bestD) { bestD = d; best = c.name; }
  }
  return best && bestD <= 1.5 ? best + '?' : '?';
}

/* ---- envelope readout ---------------------------------------------------
   The recorded gain automation, evaluated at an arbitrary instant. Needed to
   ask what is still SOUNDING when a later layer arrives, which is a different
   question from what any of them peaked at. Returns null once the source has
   stopped: a buffer that has run out contributes nothing whatever its last
   scheduled gain was. */
function envAt(v, msFromCue) {
  if (!v || !v.env || !v.env.length) return null;
  if (msFromCue < v.ms - 1e-6) return null;
  if (v.durMs !== null && msFromCue > v.ms + v.durMs) return null;
  const t = (msFromCue - v.ms) / 1000;
  let prev = null;
  for (const ev of v.env) {
    const k = ev[0], val = ev[1], tt = ev[2];
    if (tt >= t) {
      if (!prev) return tt <= t + 1e-12 ? val : 0;
      const pv = prev[1], pt = prev[2];
      const f = (t - pt) / Math.max(1e-9, tt - pt);
      if (k === 'lin') return pv + (val - pv) * f;
      if (k === 'exp') return pv * Math.pow(Math.max(1e-12, val) / Math.max(1e-12, pv), f);
      return pv;                              /* a step holds what came before */
    }
    prev = ev;
  }
  return prev ? prev[1] : null;
}
/* What a buffer-backed layer is actually putting out at some instant: where
   its playhead has got to, read straight out of the buffer over a 5 ms
   window. This is the correction that matters for a PRE-RENDERED blast --
   smp() sets a flat gain for the whole sample, so its envelope is silent
   about the fact that the sample itself has decayed to nothing. Oscillators
   have no buffer and return null; for them the envelope IS the level. */
function localLevel(H, v, msFromCue) {
  if (!v || v.bufId === null || v.bufId === undefined) return null;
  const pos = (v.bufOffset || 0) + Math.max(0, (msFromCue - v.ms) / 1000) * (v.rate || 1);
  try { return H.s.__bufWindow(v.bufId, Math.max(0, pos - 0.0025), pos + 0.0025); }
  catch (err) { return null; }
}

/* ==================================================== measurements ====== */
const ASSERTS = [];
function assert(id, label, ok, value, threshold, detail) {
  ASSERTS.push({ id, label, status: ok === null ? 'SKIP' : (ok ? 'PASS' : 'FAIL'), value, threshold, detail });
}
/* A measured number that is REPORTED but does not gate: a companion frame, a
   diagnostic, a number whose "correct" value is a design choice rather than a
   fact about the thing being modelled. Never counted as pass or fail. */
function note(id, label, value, threshold, detail) {
  ASSERTS.push({ id, label, status: 'INFO', value, threshold, detail });
}

function measureBlastBanks(H, probe) {
  const sr = probe.sr;
  const want = ['pistol_near', 'rifle_near', 'pistol_far', 'rifle_far'];
  const out = {};
  for (const key of want) {
    const bankArr = probe.blast[key];
    if (!bankArr || !bankArr.length) { out[key] = { error: 'bank empty (generation failed)' }; continue; }
    const variants = [];
    for (let i = 0; i < bankArr.length; i++) {
      const b = bankArr[i];
      if (!b || typeof b.getChannelData !== 'function') continue;
      variants.push(bufMetrics(b.getChannelData(0), b.sampleRate || sr));
    }
    if (!variants.length) { out[key] = { error: 'no readable AudioBuffer in bank' }; continue; }
    const mean = f => variants.reduce((a, v) => a + f(v), 0) / variants.length;
    const med = f => { const a = variants.map(f).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    out[key] = {
      variants: variants.length,
      peakHz: med(v => v.peakHz), peakHzAll: variants.map(v => +v.peakHz.toFixed(1)),
      peakHzAbove200: med(v => v.peakHzAbove200),
      centroid: mean(v => v.centroid),
      crestDb: mean(v => v.crestDb), crestDbAll: variants.map(v => +v.crestDb.toFixed(2)),
      riseUs: med(v => v.riseUs), riseUsAll: variants.map(v => +v.riseUs.toFixed(1)),
      riseSamples: med(v => v.riseSamples),
      posMs: med(v => v.posMs), posMsAll: variants.map(v => +v.posMs.toFixed(3)),
      frontImpliedHz: med(v => v.frontImpliedHz),
      frontImpliedHzAll: variants.map(v => +v.frontImpliedHz.toFixed(1)),
      durMs: variants[0].durMs,
      topPeaks: variants[0].topPeaks.map(p => ({ hz: p.hz, relDb: p.rel })),
      bandShare: variants[0].bandShare,
      __m: variants,
    };
  }
  return out;
}

/* Incoherent average of the magnitude spectra of every variant in a bank.
   The bore modes sit at (nearly) the same place in every variant while the
   gas jet is fresh noise each time, so averaging lifts the modes out of the
   broadband floor by ~sqrt(nVariants) without touching their frequencies. */
function avgSpectrum(variants) {
  const df = variants[0].df, len = variants[0].mag.length;
  for (const v of variants) if (v.df !== df || v.mag.length !== len) return null;
  const mag = new Float64Array(len);
  for (const v of variants) for (let k = 0; k < len; k++) mag[k] += v.mag[k];
  for (let k = 0; k < len; k++) mag[k] /= variants.length;
  return { mag, df };
}

function modeTable(spec, variants) {
  const f0 = 343 / (2 * spec.bore);
  const st = spec.stretch;
  /* genBlast jitters the stretch: stretchJ = stretch * (0.5 .. 1.8), then
     each mode frequency is multiplied by 0.985..1.015. Windows cover that. */
  const win = m => [f0 * m * (1 + st * 0.5 * m) * 0.980, f0 * m * (1 + st * 1.8 * m) * 1.020];
  const avg = avgSpectrum(variants);
  const rows = [];
  for (const m of [1, 2, 3, 4]) {
    const [lo, hi] = win(m);
    const guard = Math.max(200, f0 * 0.5);
    const per = variants.map(v => modeAt(v, lo, hi, guard));
    const a = avg ? modeAt(avg, lo, hi, guard) : per[0];
    rows.push({
      m, odd: (m % 2) === 1, target: +(f0 * m * (1 + st * m)).toFixed(1),
      window: [+lo.toFixed(1), +hi.toFixed(1)],
      hz: +a.hz.toFixed(1), mag: a.mag, baseline: a.baseline, prominenceDb: a.prominenceDb,
      perVariantProminenceDb: per.map(p => +p.prominenceDb.toFixed(2)),
      perVariantHz: per.map(p => +p.hz.toFixed(1)),
    });
  }
  return { f0: +f0.toFixed(1), stretch: st, pipe: spec.pipe || 0, bore: spec.bore, averagedOver: variants.length, rows };
}

function measureModes(probe, spectra) {
  const S = probe.gunSpec && probe.gunSpec.rifle;
  if (!S) return { error: 'GUN.rifle missing from _probe()' };
  const bank = spectra.rifle_near;
  if (!bank || !bank.__m) return { error: 'rifle_near bank not measurable' };
  const out = modeTable(S, bank.__m);
  /* cross-check: the pistol is the other `pipe: 1` entry, and its f0 is
     1531 Hz, far from the blast's own spectral peak, so its odd/even
     separation is the cleaner of the two. */
  const P = probe.gunSpec.pistol, pb = spectra.pistol_near;
  if (P && P.pipe === 1 && pb && pb.__m) out.pistolCrossCheck = modeTable(P, pb.__m);
  return out;
}

/* Buffer identity: every pre-rendered bank handed back by _probe() is indexed
   by the sandbox-unique AudioBuffer id the stub stamps on it, so a recorded
   voice can be attributed to "the rifle near blast bank" as a FACT rather than
   guessed at from its filter chain. Filled by main() once the probe has run. */
const BANKID = new Map();
function indexBanks(probe) {
  BANKID.clear();
  const add = (label, arr) => {
    if (!arr) return;
    for (const b of arr) if (b && b.__id !== undefined) BANKID.set(b.__id, label);
  };
  for (const k of Object.keys(probe.blast || {})) add('bl_' + k, probe.blast[k]);
  add('ck_narrow', probe.crack && probe.crack.narrow);
  add('ck_wide', probe.crack && probe.crack.wide);
  for (const k of Object.keys(probe.ping || {})) add('pg_' + k, probe.ping[k]);
  for (const k of Object.keys(probe.foot || {})) add('ft_' + k, probe.foot[k]);
  return BANKID.size;
}

/* fire one cue and return its recorded voice list, offsets in ms */
function fireCue(H, name, map, x, z) {
  const t0 = H.now();
  const mark = H.mark();
  const before = H.stats();
  const px = x === undefined ? H.s.player.x : x;
  const pz = z === undefined ? H.s.player.z : z;
  const ret = H.NZ.first('sfx', name, px, pz, H.s.AU);
  const after = H.stats();
  const raw = H.since(mark);
  const voices = raw.map(v => {
    const ms = (v.t - t0) * 1000;
    /* the instant this layer's own envelope reaches its maximum, relative to
       the cue -- for a rising layer this is start + attack, not start */
    let envPeakMs = ms, pk = -Infinity;
    for (const ev of v.env) if (ev[1] > pk) { pk = ev[1]; envPeakMs = ms + ev[2] * 1000; }
    return {
      ms: +ms.toFixed(3),
      kind: v.kind,
      peak: v.peak === null ? null : +v.peak.toFixed(5),
      durMs: v.stop !== null ? +((v.stop - v.t) * 1000).toFixed(2) : null,
      envPeakMs: +envPeakMs.toFixed(3),
      f0: v.f0, rate: v.rate,
      filt: v.filters.map(f => f.t === 'shaper' ? 'shaper' : `${f.t}@${f.f}${f.f1 !== f.f ? '->' + f.f1 : ''}`).join('+'),
      bufDur: v.bufDur,
      bufId: v.bufId, bufOffset: v.bufOffset,
      bufPeak: v.bufPeak === null ? null : +v.bufPeak.toFixed(5),
      shaper: v.shaper || null,
      bank: v.buf !== null ? (BANKID.get(v.buf) || null) : null,
      label: null,
      /* the whole automation, not just its peak: needed to ask what is still
         SOUNDING at some later instant. Stripped from the JSON timelines. */
      env: v.env,
    };
  }).sort((a, b) => a.ms - b.ms);
  /* The muzzle blast is the reference frame: the published mechanism timings
     are quoted from primer ignition, the blast follows ignition by a fixed
     ~1.3 ms, and every cue in this module schedules its blast at T0 and its
     mechanism at T0 + jt + <offset>. So blast-relative time IS jt + offset.
     The blast layer is identified by bank membership, not by heuristics. */
  const blast = voices.find(v => v.bank && v.bank.startsWith('bl_'));
  const blastMs = blast ? blast.ms : null;
  if (blastMs !== null) for (const v of voices) v.msFromBlast = +(v.ms - blastMs).toFixed(3);
  if (map) for (const v of voices)
    v.label = labelVoice(v.msFromBlast === undefined ? v.ms : v.msFromBlast, v.kind, v.peak, v.filt, map);
  return { name, handled: ret === true, t0, voices, blastMs, blast,
           denied: after.denied - before.denied, steals: after.steals - before.steals };
}

function hasVoiceIn(voices, lo, hi) {
  return voices.filter(v => v.ms >= lo && v.ms <= hi);
}

/* ============================================================ main ====== */
function gitCommit() {
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return 'unknown'; }
}
function fileHashes() {
  const out = {};
  for (const f of ['nz-audio.js', 'nz-core.js']) {
    try {
      const buf = fs.readFileSync(path.join(ROOT, f));
      let h = 5381;
      for (let i = 0; i < buf.length; i++) h = ((h * 33) ^ buf[i]) >>> 0;
      out[f] = { bytes: buf.length, hash: h.toString(16) };
    } catch (e) { out[f] = null; }
  }
  return out;
}
const cv = arr => {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (Math.abs(m) < 1e-12) return Infinity;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
  return sd / Math.abs(m);
};

/* HARNESS_TRACE=1 prints a stderr checkpoint per section; the run is long
   enough (several full boots, four bank probes, ~500 cue firings) that a hang
   is otherwise indistinguishable from slowness. */
const TRACE = !!process.env.HARNESS_TRACE;
const trace = (s) => { if (TRACE) process.stderr.write(`[${(process.uptime()).toFixed(1)}s] ${s}\n`); };

function main() {
  const result = { ok: true, meta: {}, A: {}, B: {}, C: {}, D: {}, notes: [] };
  let H;
  try { H = new Boot(OPT.seed).run(); }
  catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (OPT.json) console.log(JSON.stringify({ ok: false, fatal: msg, moduleErrors: MODULE_ERRORS.slice(0, 6) }, null, 2));
    else {
      console.error('\n  audio-harness could not boot nz-audio.js.');
      console.error('  ' + msg);
      if (MODULE_ERRORS.length) { console.error('  module errors:'); for (const e of MODULE_ERRORS.slice(0, 6)) console.error('    ' + e); }
      console.error('\n  This is a harness/module-shape problem, not a metric failure.\n');
    }
    process.exit(1);
  }

  result.meta = {
    installMs: H.installMs, commit: gitCommit(), files: fileHashes(),
    when: new Date().toISOString(), seed: OPT.random ? 'random' : OPT.seed,
    stats: H.stats0,
  };

  trace('A: banks + spectra');
  /* ---------------------------------------------------------------- A --- */
  /* let the deferred bank fills and IR queue run so every variant exists */
  H.advance(1200, { step: 4 });
  const t0probe = Date.now();
  const probe = H.NZ.audio._probe();
  H.advance(2500, { step: 4 });
  const probe2 = H.NZ.audio._probe();      /* now with the filled variants */
  result.meta.probeMs = Date.now() - t0probe;

  const spectra = measureBlastBanks(H, probe2);
  result.A = {};
  for (const k of Object.keys(spectra)) {
    const v = spectra[k];
    result.A[k] = v.error ? { error: v.error } : {
      variants: v.variants,
      spectralPeakHz: +v.peakHz.toFixed(1),
      spectralPeakHzPerVariant: v.peakHzAll,
      spectralPeakAbove200Hz: +v.peakHzAbove200.toFixed(1),
      spectralCentroidHz: +v.centroid.toFixed(1),
      crestFactorDb: +v.crestDb.toFixed(2),
      crestPerVariant: v.crestDbAll,
      riseTimeUs: +v.riseUs.toFixed(2),
      riseSamples: v.riseSamples,
      riseUsPerVariant: v.riseUsAll,
      positivePhaseMs: +v.posMs.toFixed(3),
      posMsPerVariant: v.posMsAll,
      frontImpliedHz: +v.frontImpliedHz.toFixed(1),
      frontImpliedHzPerVariant: v.frontImpliedHzAll,
      bufferMs: +v.durMs.toFixed(1),
      topPeaks: v.topPeaks,
      bandShare: v.bandShare,
    };
  }
  const rn = spectra.rifle_near, pn = spectra.pistol_near;
  if (rn && !rn.error && pn && !pn.error) {
    /* WHAT IS BEING ASSERTED, AND WHY IT IS NOT THE SPECTRAL MAXIMUM.
       The global magnitude maximum below 8 kHz is the wrong estimator for the
       shock front: the buffer also contains a much longer, much softer
       gas-cloud Friedlander (peak near 1/(2*pi*T*gasMul), and a Friedlander's
       spectral height scales as amp*T, so a long soft pulse beats a short hard
       one) and a set of barrel modes, either of which can own the maximum
       while the front is completely intact. What DEFINES the front is its
       positive-phase duration, which the time domain measures directly and
       which those other components cannot contaminate; a Friedlander pulse of
       positive phase T peaks at 1/(2*pi*T). That is the quantity asserted
       here. The raw spectral maxima stay in the output as diagnostics. */
    const gasHz = g => 1 / (2 * Math.PI * g.T * g.gasMul);
    const boreHz = g => 343 / (2 * g.bore);
    const diag = (m, g, name) =>
      `implied peak per variant: ${m.frontImpliedHzAll.join(', ')} Hz from positive-phase durations ` +
      `${m.posMsAll.join(', ')} ms; GUN.${name}.T = ${g.T}s predicts ${(1 / (2 * Math.PI * g.T)).toFixed(0)} Hz ` +
      `before genBlast's +-20% per-shot jitter on T. DIAGNOSTIC ONLY -- the raw spectral maximum below 8 kHz is ` +
      `${m.peakHz.toFixed(1)} Hz (per variant ${m.peakHzAll.join(', ')}), strongest maxima ` +
      `${m.topPeaks.map(p => `${p.hz} Hz (${p.relDb} dB)`).join(', ')}; the two components that compete for it are the ` +
      `gas-cloud Friedlander at 1/(2*pi*T*gasMul) = ${gasHz(g).toFixed(0)} Hz (gasAmp ${g.gasAmp}) and the m=1 barrel ` +
      `mode at c/2L = ${boreHz(g).toFixed(0)} Hz (boreAmp ${g.boreAmp}, tau ${g.boreTau}s).`;
    assert('A1', 'rifle_near implied peak BELOW pistol_near implied peak',
      rn.frontImpliedHz < pn.frontImpliedHz, +rn.frontImpliedHz.toFixed(1), '< ' + pn.frontImpliedHz.toFixed(1),
      `rifle front implies ${rn.frontImpliedHz.toFixed(1)} Hz (positive phase ${rn.posMs.toFixed(3)} ms), pistol implies ` +
      `${pn.frontImpliedHz.toFixed(1)} Hz (positive phase ${pn.posMs.toFixed(3)} ms). GUN.rifle.T = ${probe2.gunSpec.rifle.T}s ` +
      `-> ${(1 / (2 * Math.PI * probe2.gunSpec.rifle.T)).toFixed(0)} Hz and GUN.pistol.T = ${probe2.gunSpec.pistol.T}s ` +
      `-> ${(1 / (2 * Math.PI * probe2.gunSpec.pistol.T)).toFixed(0)} Hz, i.e. the longer pulse must be the lower one.`);
    assert('A2', `rifle_near implied peak in ${T.rifleFrontLo}-${T.rifleFrontHi} Hz`,
      rn.frontImpliedHz >= T.rifleFrontLo && rn.frontImpliedHz <= T.rifleFrontHi,
      +rn.frontImpliedHz.toFixed(1), `${T.rifleFrontLo}-${T.rifleFrontHi}`,
      diag(rn, probe2.gunSpec.rifle, 'rifle'));
    assert('A3', `pistol_near implied peak in ${T.pistolFrontLo}-${T.pistolFrontHi} Hz`,
      pn.frontImpliedHz >= T.pistolFrontLo && pn.frontImpliedHz <= T.pistolFrontHi,
      +pn.frontImpliedHz.toFixed(1), `${T.pistolFrontLo}-${T.pistolFrontHi}`,
      diag(pn, probe2.gunSpec.pistol, 'pistol'));
    assert('A4', 'rifle_near crest factor > 11 dB',
      rn.crestDb > T.crestMinDb, +rn.crestDb.toFixed(2), '> ' + T.crestMinDb,
      `per variant: ${rn.crestDbAll.join(', ')} dB`);
    assert('A5', 'pistol_near crest factor > 11 dB',
      pn.crestDb > T.crestMinDb, +pn.crestDb.toFixed(2), '> ' + T.crestMinDb,
      `per variant: ${pn.crestDbAll.join(', ')} dB`);
  } else {
    assert('A1', 'rifle_near peak BELOW pistol_near peak', null, null, null, 'blast banks not measurable');
  }

  trace('B: barrel modes');
  /* ---------------------------------------------------------------- B --- */
  const modes = measureModes(probe2, spectra);
  result.B = modes;
  if (!modes.error) {
    const [m1, m2, m3, m4] = modes.rows;
    const ratio = (a, b) => 20 * Math.log10(Math.max(a.mag, 1e-12) / Math.max(b.mag, 1e-12));
    result.B.oddOverEvenDb = { 'm1/m2': +ratio(m1, m2).toFixed(2), 'm3/m4': +ratio(m3, m4).toFixed(2) };
    const px = modes.pistolCrossCheck;
    if (px) result.B.pistolOddOverEvenDb = { 'm1/m2': +ratio(px.rows[0], px.rows[1]).toFixed(2), 'm3/m4': +ratio(px.rows[2], px.rows[3]).toFixed(2) };
    assert('B1', 'm=1 (466 Hz, odd) is a distinct peak',
      m1.prominenceDb >= T.modeProminenceDb, +m1.prominenceDb.toFixed(2), '>= ' + T.modeProminenceDb + ' dB',
      `found at ${m1.hz} Hz (predicted ${m1.target} Hz), |X| = ${m1.mag.toFixed(4)} against a local median of ${m1.baseline.toFixed(4)}. ` +
      `Per variant: ${m1.perVariantProminenceDb.join(', ')} dB.`);
    assert('B2', 'm=3 (1398 Hz, odd) carries more energy than m=4',
      m3.mag > m4.mag && m3.prominenceDb > m4.prominenceDb,
      +ratio(m3, m4).toFixed(2), '> 0 dB',
      `m=3 at ${m3.hz} Hz |X| = ${m3.mag.toFixed(4)} (prominence ${m3.prominenceDb.toFixed(2)} dB); ` +
      `m=4 at ${m4.hz} Hz |X| = ${m4.mag.toFixed(4)} (prominence ${m4.prominenceDb.toFixed(2)} dB). ` +
      `m=3 amplitude in genBlast is boreAmp/m^1.15 = ${(0.30 / Math.pow(3, 1.15)).toFixed(4)} with tau/m^0.65, ` +
      `and modes above m=2 are additionally dropped at random 28% of the time, so it is a weak, broad partial by design.`);
    assert('B3', 'm=2 (932 Hz, even) is NOT a distinct peak',
      m2.prominenceDb < T.modeProminenceDb, +m2.prominenceDb.toFixed(2), '< ' + T.modeProminenceDb + ' dB',
      `${m2.hz} Hz (would-be target ${m2.target} Hz), |X| = ${m2.mag.toFixed(4)}; m1 stands ${ratio(m1, m2).toFixed(2)} dB above it.`);
    assert('B4', 'm=4 (1864 Hz, even) is NOT a distinct peak',
      m4.prominenceDb < T.modeProminenceDb, +m4.prominenceDb.toFixed(2), '< ' + T.modeProminenceDb + ' dB',
      `${m4.hz} Hz (would-be target ${m4.target} Hz), |X| = ${m4.mag.toFixed(4)}; m3 stands ${ratio(m3, m4).toFixed(2)} dB above it.`);
  }

  trace('C: cue timelines');
  /* ---------------------------------------------------------------- C --- */
  result.meta.banksIndexed = indexBanks(probe2);
  result.meta.srcConstants = {
    MECH_T0: SRCK.MECH_T0, layerTFloor: SRCK.layerFloor,
    rifleJt: Number(SRCK.rifleJt), pistolJt: Number(SRCK.pistolJt),
    mechM: SRCK.mechM, suppBlastScale: SRCK.suppBlastScale,
    preTransientSear: SRCK.searT.map(Number), preTransientSwell: SRCK.swell.map(Number),
  };
  /* the identification table, as parsed out of nz-audio.js on this run */
  result.meta.layerGains = {
    unresolvedRecipes: GAIN_MISS,
    rifle: mapDump(RIFLE_MAP), rifleq: mapDump(RIFLEQ_MAP), pistol: mapDump(PISTOL_MAP),
  };
  /* single cues, well separated so each is an "opening" shot */
  const cueSpec = [['rifle', RIFLE_MAP], ['rifleq', RIFLEQ_MAP], ['pistol', PISTOL_MAP]];
  result.C = { cues: {}, sustained: null };
  const primary = {};
  for (const [name, map] of cueSpec) {
    H.advance(900, { step: 4 });
    const c = fireCue(H, name, map);
    primary[name] = c;
    result.C.cues[name] = {
      handled: c.handled, voices: c.voices.length,
      blastAtMs: c.blastMs,
      totalPeakGain: +c.voices.reduce((a, v) => a + (v.peak || 0), 0).toFixed(4),
      timeline: c.voices.map(v => { const { env, ...rest } = v; return rest; }),
    };
  }
  /* Window assertions are evaluated over --trials repeats so a marginal window
     shows up as a hit rate rather than as luck.

     THE FRAME. The pass/fail is measured FROM THE MUZZLE BLAST. That is the
     physically meaningful reference: the published BCG and slide timings are
     quoted from primer ignition, the blast follows ignition by a fixed
     ~1.3 ms, and nz-audio schedules the blast at T0 and the mechanism at
     T0 + jt + <offset>, so blast-relative time is exactly jt + <offset> -- the
     number the code's comments quote. The sfx()-call frame differs from it by
     MECH_T0 (read from the source, currently below) and is a property of the
     module's input-latency budget, not of the machine being modelled, so it is
     reported as context and does not gate. */
  const windowTrials = {};
  for (const [name, map] of cueSpec) {
    if (name === 'rifleq') continue;
    /* [id, human label, window, the label the intended mechanism voice carries] */
    const wins = name === 'rifle'
      ? [['C3', 'return to battery', T.rifleBattery, 'into battery'], ['C4', 'buffer bottoming', T.rifleBuffer, 'buffer bottoming']]
      : [['C5', 'slide into frame', T.pistolSlide, 'slide -> frame'], ['C6', 'into battery', T.pistolBattery, 'into battery']];
    const hitsAny = wins.map(() => 0), hitsAnyB = wins.map(() => 0);
    const evT = wins.map(() => []), evB = wins.map(() => []);
    const named = (c, want) => c.voices.filter(v => v.label === want);
    for (let t = 0; t < OPT.trials; t++) {
      H.advance(420, { step: 6 });
      const c = fireCue(H, name, map);
      wins.forEach(([id, lbl, w, want], wi) => {
        if (hasVoiceIn(c.voices, w[0], w[1]).length) hitsAny[wi]++;
        if (c.blastMs !== null && c.voices.some(v => v.msFromBlast >= w[0] && v.msFromBlast <= w[1])) hitsAnyB[wi]++;
        const nm = named(c, want);
        if (nm.length) { evT[wi].push(nm[0].ms); if (nm[0].msFromBlast !== undefined) evB[wi].push(nm[0].msFromBlast); }
      });
    }
    const stat = arr => {
      const a = arr.slice().sort((x, y) => x - y);
      return a.length ? { n: a.length, min: +a[0].toFixed(2), med: +a[Math.floor(a.length / 2)].toFixed(2), max: +a[a.length - 1].toFixed(2) } : null;
    };
    wins.forEach(([id, lbl, w, want], wi) => {
      const s = stat(evT[wi]), sb = stat(evB[wi]);
      const inside = (v) => v !== null && v.med >= w[0] && v.med <= w[1];
      const frac = a => a.length ? a.filter(v => v >= w[0] && v <= w[1]).length / a.length : 0;
      windowTrials[id] = {
        cue: name, label: lbl, window: w, frame: 'from muzzle blast', expectedVoice: want, trials: OPT.trials,
        fromMuzzleBlast: sb, fromCueStart: s,
        fractionInsideFromBlast: +frac(evB[wi]).toFixed(3),
        fractionInsideFromCueStart: +frac(evT[wi]).toFixed(3),
        anyVoiceHitRateFromBlast: +(hitsAnyB[wi] / OPT.trials).toFixed(3),
        anyVoiceHitRateFromCueStart: +(hitsAny[wi] / OPT.trials).toFixed(3),
        primaryFiringMsFromBlast: (named(primary[name], want)[0] || {}).msFromBlast ?? null,
      };
      if (!sb) {
        assert(id, `${name}: "${want}" at blast + ${w[0]}-${w[1]} ms`, null, null, `${w[0]}-${w[1]} ms`,
          `no voice could be identified as "${want}" in ${OPT.trials} firings -- the labelling table in this harness is ` +
          `out of date with nz-audio.js, or the layer is gated off.`);
        return;
      }
      const jt = jtMs(name);
      const detail =
        `"${want}" lands at ${sb.min}/${sb.med}/${sb.max} ms (min/med/max over ${sb.n} firings) AFTER THE MUZZLE BLAST, ` +
        `and ${(frac(evB[wi]) * 100).toFixed(0)}% of firings put it inside the window. cue` +
        `${name === 'pistol' ? 'Pistol' : 'Rifle'} sets T0 = self ? MECH_T0 : 0, fires the blast at T0 and schedules ` +
        `this event at T0 + jt + <offset> with jt = rr(0, ${jt.toFixed(1)} ms), so the spread above is jt plus the ` +
        `event's own jitter and the median sits at <offset> + jt/2.`;
      assert(id, `${name}: "${want}" at blast + ${w[0]}-${w[1]} ms`,
        inside(sb), sb.med, `${w[0]}-${w[1]} ms`, detail);
      note(id + '~', `  ...same event, from the sfx() call (context)`, s ? s.med : null, `+${MECH_T0_MS.toFixed(1)} ms`,
        `Measured at ${s ? `${s.min}/${s.med}/${s.max}` : 'n/a'} ms from the sfx() call. The offset from the frame above ` +
        `is MECH_T0 = ${SRCK.MECH_T0}s = ${MECH_T0_MS.toFixed(1)} ms, read from nz-audio.js, which is the first-person ` +
        `input latency the module spends to give the structure-borne precursor somewhere to live above layerT()'s ` +
        `${(SRCK.layerFloor * 1000).toFixed(1)} ms floor. It is not a property of the mechanism and does not gate.`);
    });
  }
  result.C.windows = windowTrials;

  trace('C: sustained fire');
  /* sustained fire: fresh boot so peakVoices / steals / denied are clean */
  let H2 = null, sustainedErr = null;
  try { H2 = new Boot(OPT.seed + 1).run(); }
  catch (e) { sustainedErr = e && e.message ? e.message : String(e); }
  if (H2) {
    H2.advance(1500, { step: 4 });            /* let banks + IRs settle */
    const base = H2.stats();
    const perShot = [];
    for (let i = 0; i < OPT.shots; i++) {
      const mark = H2.mark();
      H2.NZ.first('sfx', 'rifle', H2.s.player.x, H2.s.player.z, H2.s.AU);
      const st = H2.stats();
      perShot.push({ shot: i + 1, voices: st.voices, peakVoices: st.peakVoices, spawned: H2.mark() - mark });
      H2.advance(OPT.spacing * 1000, { step: 3 });
    }
    const end = H2.stats();
    result.C.sustained = {
      shots: OPT.shots, spacingMs: OPT.spacing * 1000,
      cap: end.cap, tier: end.tier,
      peakVoices: end.peakVoices, peakVoicesBefore: base.peakVoices,
      denied: end.denied - base.denied, steals: end.steals - base.steals,
      stolenPri: end.stolenPri,
      voicesPerShot: perShot.map(p => p.spawned),
      liveAfterEachShot: perShot.map(p => p.voices),
    };
    assert('C1', `peak concurrent voices < CAP (${end.cap})`,
      end.peakVoices < end.cap, end.peakVoices, '< ' + end.cap,
      `${OPT.shots} rifle shots at ${(OPT.spacing * 1000).toFixed(0)} ms; live voices after each shot ` +
      `min ${Math.min(...perShot.map(p => p.voices))} / max ${Math.max(...perShot.map(p => p.voices))}; ` +
      `${perShot.map(p => p.spawned).reduce((a, b) => a + b, 0)} voices spawned in total.`);
    assert('C2', 'no voices denied under sustained fire',
      (end.denied - base.denied) === 0, end.denied - base.denied, '0',
      `steals ${end.steals - base.steals}, stolen by priority ${JSON.stringify(end.stolenPri)}`);
  } else {
    assert('C1', 'peak concurrent voices < CAP', null, null, null, 'sustained-fire boot failed: ' + sustainedErr);
    assert('C2', 'no voices denied under sustained fire', null, null, null, 'sustained-fire boot failed: ' + sustainedErr);
  }

  trace('D: decorrelation');
  H2 = null;                                  /* release the sustained-fire sandbox */
  H.s.__resetVoices();

  /* ---------------------------------------------------------------- D --- */
  /* 12 pistol shots, 350 ms apart so every one takes the `opening` path and
     the only thing varying is the module's own per-shot decorrelation. */
  const shots = [];
  for (let i = 0; i < 12; i++) {
    H.advance(350, { step: 6 });
    const c = fireCue(H, 'pistol', PISTOL_MAP);
    const slide = c.voices.filter(v => v.label === 'slide -> frame' && v.kind === 'osc');
    shots.push({
      i: i + 1,
      voices: c.voices.length,
      totalGain: +c.voices.reduce((a, v) => a + (v.peak || 0), 0).toFixed(6),
      slideMs: slide.length ? slide[0].ms : null,
      blastMs: c.voices.length ? c.voices[0].ms : null,
      times: c.voices.map(v => v.ms),
      peaks: c.voices.map(v => v.peak),
    });
  }
  const totals = shots.map(s => s.totalGain);
  const slides = shots.map(s => s.slideMs).filter(v => v !== null);
  const sameTimes = shots.every(s => JSON.stringify(s.times) === JSON.stringify(shots[0].times));
  const samePeaks = shots.every(s => JSON.stringify(s.peaks) === JSON.stringify(shots[0].peaks));
  result.D = {
    shots: shots.map(s => ({ i: s.i, voices: s.voices, totalGain: s.totalGain, slideMs: s.slideMs })),
    totalGainCV: +cv(totals).toFixed(5),
    totalGainRange: [Math.min(...totals), Math.max(...totals)],
    slideTimeCV: slides.length > 1 ? +cv(slides).toFixed(5) : null,
    slideTimeRange: slides.length ? [Math.min(...slides), Math.max(...slides)] : null,
    slideSamples: slides.length,
    identicalTimes: sameTimes, identicalPeaks: samePeaks,
  };
  assert('D1', 'pistol scheduled times vary shot to shot',
    !sameTimes, sameTimes ? 0 : 1, '1',
    slides.length > 1
      ? `slide-impact time CV ${(cv(slides) * 100).toFixed(2)}% over ${slides.length} shots, range ${Math.min(...slides).toFixed(2)}-${Math.max(...slides).toFixed(2)} ms`
      : 'slide-impact voice not isolated; comparing whole timelines instead');
  assert('D2', 'pistol peak gains vary shot to shot',
    !samePeaks, samePeaks ? 0 : 1, '1',
    `per-shot total peak gain CV ${(cv(totals) * 100).toFixed(2)}%, range ${Math.min(...totals).toFixed(4)}-${Math.max(...totals).toFixed(4)}`);

  trace('E: precursor');
  /* ---------------------------------------------------------------- E --- */
  /* THE STRUCTURE-BORNE PRECURSOR.
     preTransient() puts two layers in front of the muzzle blast: a dry sear /
     hammer knock via tick(), and a bore swell via nz() whose envelope RISES
     into the blast. Both are scheduled in absolute cue time, not off T0, so
     what protects them is the gap between their offsets and layerT()'s floor
     of now + 1.5 ms -- below that floor every layer is clamped to the same
     instant and its per-shot jitter is destroyed. That failure is invisible in
     the code and obvious here, so all four properties are measured: distinct
     instants, surviving jitter, both ahead of the blast, and a swell whose
     envelope peaks at (not after) the blast onset. */
  result.E = {};
  const searSrc = SRCK.searT.map(Number), swellSrc = SRCK.swell.map(Number);
  const floorMs = SRCK.layerFloor * 1000;
  for (const [name, map, ids] of [['rifle', RIFLE_MAP, ['E1', 'E2', 'E3', 'E4']],
                                  ['pistol', PISTOL_MAP, ['E5', 'E6', 'E7', 'E8']]]) {
    const sear = [], swell = [], gaps = [], leadSear = [], leadSwell = [], swellPeakRelBlast = [];
    let n = 0;
    for (let i = 0; i < OPT.trials; i++) {
      H.advance(400, { step: 6 });
      const c = fireCue(H, name, map);
      const s = c.voices.find(v => v.label === 'sear/hammer');
      const w = c.voices.find(v => v.label === 'bore precursor');
      if (!s || !w || c.blastMs === null) continue;
      n++;
      sear.push(s.ms); swell.push(w.ms);
      gaps.push(Math.abs(s.ms - w.ms));
      leadSear.push(c.blastMs - s.ms);
      leadSwell.push(c.blastMs - w.ms);
      swellPeakRelBlast.push(w.envPeakMs - c.blastMs);
    }
    const st = a => a.length ? { n: a.length, min: +Math.min(...a).toFixed(3), med: +a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(3), max: +Math.max(...a).toFixed(3) } : null;
    const E = result.E[name] = {
      firings: n, blastAtMs: +MECH_T0_MS.toFixed(2), layerTFloorMs: +floorMs.toFixed(2),
      searScheduledMs: st(sear), searSourceWindowMs: [searSrc[0] * 1000, (searSrc[0] + searSrc[1]) * 1000],
      searDistinctInstants: new Set(sear.map(v => v.toFixed(4))).size,
      swellScheduledMs: st(swell),
      swellSourceMs: swellSrc[0] * 1000, swellAtkMs: swellSrc[2] * 1000, swellDurMs: swellSrc[1] * 1000,
      gapMs: st(gaps), coincidentFraction: +(gaps.filter(g => g < 0.02).length / Math.max(1, n)).toFixed(3),
      searLeadOverBlastMs: st(leadSear), swellLeadOverBlastMs: st(leadSwell),
      swellEnvPeakMinusBlastMs: st(swellPeakRelBlast),
    };
    if (!n) {
      for (const id of ids) assert(id, `${name}: precursor`, null, null, null, 'no precursor voices identified');
      continue;
    }
    const nominal = (searSrc[1] * 1000);
    const spread = +(E.searScheduledMs.max - E.searScheduledMs.min).toFixed(3);
    E.searSpreadMs = spread;
    /* The failure being ruled out is the CLAMP, which has an unmistakable
       signature: both layers on one instant, that instant being the floor, and
       zero spread. It is NOT "the two are never within 20 us of each other" --
       the swell's fixed 1.8 ms sits inside the sear's 1.6-2.1 ms window, so a
       working build is expected to put them near-coincident on roughly
       ${(0.04 / nominal * 100)|0}% of shots by chance. Median separation and
       clearance over the floor are the discriminating quantities. */
    assert(ids[0], `${name}: precursor layers not collapsed onto one instant`,
      E.gapMs.med > 0.05 && E.searScheduledMs.min > floorMs + 0.02 && E.swellScheduledMs.min > floorMs + 0.02,
      E.gapMs.med, '> 0.05 ms apart',
      `over ${n} firings the sear sits at ${E.searScheduledMs.min}-${E.searScheduledMs.max} ms and the swell at a fixed ` +
      `${E.swellScheduledMs.med} ms, separated by ${E.gapMs.min}/${E.gapMs.med}/${E.gapMs.max} ms (min/med/max). Both ` +
      `clear layerT()'s ${floorMs.toFixed(1)} ms floor by ${(E.searScheduledMs.min - floorMs).toFixed(2)} and ` +
      `${(E.swellScheduledMs.min - floorMs).toFixed(2)} ms. Below that floor a layer is not delayed, it is CLAMPED, so ` +
      `everything under it arrives on the same instant with its jitter gone -- which is what MECH_T0 = 0.0026 did. ` +
      `They land within 20 us of each other on ${(E.coincidentFraction * 100).toFixed(0)}% of shots, which is the ` +
      `expected ~${Math.round(0.04 / nominal * 100)}% chance overlap of a fixed instant inside a ${nominal} ms window, ` +
      `not a clamp.`);
    /* A spread test needs samples: at n < 12 the expected range of n uniform
       draws is only (n-1)/(n+1) of the window and at n = 1 it is identically
       zero, so below that this reports SKIP rather than a meaningless FAIL. */
    assert(ids[1], `${name}: sear per-shot jitter survives the clamp`,
      n < 12 ? null
             : (E.searScheduledMs.min > floorMs + 0.02 && spread > nominal * 0.5 && E.searDistinctInstants > Math.max(1, n * 0.5)),
      spread, n < 12 ? `needs >= 12 firings` : `> ${(nominal * 0.5).toFixed(2)} ms spread`,
      `nz-audio schedules the sear at ${searSrc[0]} + rr(0, ${searSrc[1]}), i.e. a nominal ` +
      `${E.searSourceWindowMs[0]}-${E.searSourceWindowMs[1]} ms window ${(E.searSourceWindowMs[0] - floorMs).toFixed(1)} ms ` +
      `above the ${floorMs.toFixed(1)} ms floor. Measured: ${E.searScheduledMs.min}-${E.searScheduledMs.max} ms over ${n} ` +
      `firings, ${E.searDistinctInstants} distinct instants, ${spread} ms of realised spread against ${nominal.toFixed(1)} ms ` +
      `nominal (${(spread / nominal * 100).toFixed(0)}%)` +
      (n < 12 ? `. NOT ASSERTED: ${n} firings cannot resolve a spread (the expected range of n uniform draws is ` +
                `(n-1)/(n+1) of the window, and 0 at n = 1). Re-run with --trials=12 or more` : '') + `. ` +
      `Distinct instants are counted at the 1 us resolution the ` +
      `recorder rounds to, so a few birthday collisions among ${n} draws over a ${(nominal * 1000).toFixed(0)} us window ` +
      `are expected; a CLAMPED layer shows a spread of exactly 0 and exactly ONE distinct instant, sitting on the floor.`);
    assert(ids[2], `${name}: both precursor layers precede the muzzle blast`,
      E.searLeadOverBlastMs.min > 0 && E.swellLeadOverBlastMs.min > 0,
      +Math.min(E.searLeadOverBlastMs.min, E.swellLeadOverBlastMs.min).toFixed(3), '> 0 ms',
      `the blast sits at MECH_T0 = ${MECH_T0_MS.toFixed(1)} ms. The sear leads it by ` +
      `${E.searLeadOverBlastMs.min}-${E.searLeadOverBlastMs.max} ms and the swell by a fixed ` +
      `${E.swellLeadOverBlastMs.med} ms.`);
    assert(ids[3], `${name}: swell envelope peaks AT or before the blast onset`,
      E.swellEnvPeakMinusBlastMs.max <= 0.02 && E.swellEnvPeakMinusBlastMs.min >= -1.5,
      E.swellEnvPeakMinusBlastMs.med, '-1.5..0 ms',
      `the swell starts at ${E.swellScheduledMs.med} ms with atk ${E.swellAtkMs} ms, so its gain envelope reaches ` +
      `maximum at ${(E.swellScheduledMs.med + E.swellAtkMs).toFixed(2)} ms, which is ` +
      `${E.swellEnvPeakMinusBlastMs.med >= 0 ? '+' : ''}${E.swellEnvPeakMinusBlastMs.med} ms relative to the blast at ` +
      `${MECH_T0_MS.toFixed(1)} ms. This is the one rising envelope in the module and its whole purpose is to peak when ` +
      `the bore uncorks; peaking after the blast makes it read as a separate event behind the bang.`);
  }

  H.s.__resetVoices();
  trace('F: suppressed balance');
  /* ---------------------------------------------------------------- F --- */
  /* SUPPRESSED BALANCE. Both layers land on the same bus, so the bus chain
     cancels and the ratio of their scheduled gains IS the ratio at the ear,
     up to the buffer peaks (both generators peak-normalise) and the one
     waveshaper in the chain, both of which are folded in below. */
  const boltDb = { rifleq: null, rifle: null, pistol: null };
  /* Which layers ARE the machine. Everything else in a weapon cue is blast,
     body or room, and it is that "everything else" the bolt has to be heard
     over -- a different and more useful question than the ratio to the peak. */
  const MECH_LAYERS = new Set([
    'sear/hammer', 'bore precursor', 'bolt unlock', 'barrel unlock',
    'port gas', 'port gas (jet)', 'port gas (wide)', 'case out', 'case deflector',
    'buffer bottoming', 'buffer weights', 'buffer spring', 'buffer spring 2',
    'spring scrape', 'recoil spring', 'slide -> frame', 'slide ring',
    'into battery', 'into battery ring',
  ]);
  for (const [name, map] of [['rifleq', RIFLEQ_MAP], ['rifle', RIFLE_MAP], ['pistol', PISTOL_MAP]]) {
    const g = [], eff = [], mSum = [], mTop = [];
    let sample = null, maskSample = null;
    for (let i = 0; i < 48; i++) {
      H.advance(600, { step: 6 });
      const c = fireCue(H, name, map);
      const bl = c.blast;
      const bolt = c.voices.find(v => v.label === 'into battery' && v.kind === 'buffer');
      if (!bl || !bolt || !bl.peak || !bolt.peak) continue;
      /* smp() builds src -> [filters] -> [shaper] -> gain, so the shaper acts
         on the buffer sample and the gain scales what comes out of it. */
      const sh = (v) => v.shaper ? H.s.__shapeAt(v.shaper, v.bufPeak) : v.bufPeak;
      g.push(20 * Math.log10(bolt.peak / bl.peak));
      eff.push(20 * Math.log10((bolt.peak * sh(bolt)) / (bl.peak * sh(bl))));
      /* --- THE MASKER. Not the blast peak: what the blast side is still
         putting out at the instant the carrier gets home. Every layer's
         recorded automation is evaluated at that instant, and layers whose
         source has already stopped contribute nothing however loud they
         peaked -- which is the whole point, the near blast buffer is ~58 ms
         long and is simply over by then. --- */
      const at = bolt.ms;                     /* smp() steps its gain: no attack */
      const parts = [];
      for (const v of c.voices) {
        if (v === bolt) continue;
        if (MECH_LAYERS.has(String(v.label || '').replace(/\?$/, ''))) continue;
        const gn = envAt(v, at);
        if (gn === null || !(gn > 1e-6)) continue;
        /* For a PRE-RENDERED layer the gain node is a flat step, so the
           envelope says nothing about the sample's own decay -- read the
           buffer instead, over 5 ms centred on where the playhead is. */
        const w = localLevel(H, v, at);
        const amp = gn * (w === null ? 1 : (v.shaper ? H.s.__shapeAt(v.shaper, w.peak) : w.peak));
        parts.push({
          layer: v.label, kind: v.kind, startedMs: v.ms,
          endsMs: v.durMs === null ? null : +(v.ms + v.durMs).toFixed(1),
          peakGain: v.peak, gainAtBolt: +gn.toFixed(6), ampAtBolt: +amp.toFixed(6),
          bufLevelAtBolt: w === null ? null : +w.peak.toFixed(4),
          downFromOwnPeakDb: +(20 * Math.log10(gn / v.peak)).toFixed(2),
        });
      }
      parts.sort((a, b) => b.ampAtBolt - a.ampAtBolt);
      /* uncorrelated sources: power sum, not amplitude sum */
      const sum = Math.sqrt(parts.reduce((a, x) => a + x.ampAtBolt * x.ampAtBolt, 0));
      const bw = localLevel(H, bolt, bolt.envPeakMs);
      const boltAmp = bolt.peak * (bw === null ? (bolt.bufPeak === null ? 1 : sh(bolt)) : bw.peak);
      if (sum > 0) mSum.push(20 * Math.log10(boltAmp / sum));
      if (parts.length) mTop.push(20 * Math.log10(boltAmp / parts[0].ampAtBolt));
      if (!sample) sample = {
        blastGain: bl.peak, blastBufPeak: bl.bufPeak, blastShaped: +sh(bl).toFixed(4), blastFilters: bl.filt,
        boltGain: bolt.peak, boltBufPeak: bolt.bufPeak, boltShaped: +sh(bolt).toFixed(4), boltFilters: bolt.filt,
        boltAtMsFromBlast: bolt.msFromBlast,
      };
      if (!maskSample) maskSample = {
        boltAtMsFromCue: bolt.ms, boltAtMsFromBlast: bolt.msFromBlast,
        boltAmp: +boltAmp.toFixed(6), maskerAmp: +sum.toFixed(6), stillSounding: parts,
      };
    }
    const med = a => a.length ? +a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(2) : null;
    boltDb[name] = { firings: g.length, gainDb: med(g), effectiveDb: med(eff), sample,
                     gainDbRange: g.length ? [+Math.min(...g).toFixed(2), +Math.max(...g).toFixed(2)] : null,
                     overMaskerDb: med(mSum), overLoudestMaskerDb: med(mTop), maskSample };
  }
  result.F = { suppressed: boltDb.rifleq, unsuppressed: boltDb.rifle, pistol: boltDb.pistol,
               mechM: SRCK.mechM, blastScale: SRCK.suppBlastScale };
  if (boltDb.rifleq && boltDb.rifleq.firings) {
    const q = boltDb.rifleq, u = boltDb.rifle;
    /* Where the number comes from, in dB, all read from the measurement:
         suppressed ratio = unsuppressed ratio + 20log10(mechM) - 20log10(scale)
       so the suppressed balance is NOT a free parameter once the unsuppressed
       one is fixed -- which is what makes this diagnosable rather than a
       matter of taste. */
    const mechDb = 20 * Math.log10(SRCK.mechM), scaleDb = 20 * Math.log10(SRCK.suppBlastScale);
    const needU = [T.boltUnderBlastDb[0] - mechDb + scaleDb, T.boltUnderBlastDb[1] - mechDb + scaleDb];
    /* the number a fix would have to move, read out of the source rather than
       quoted from memory */
    const IB = volExprOf('cueRifle', 'tick', /t:\s*tBat\s*,/) || { expr: '?', k: null };
    const ibK = IB.k === null ? 1 : IB.k;
    const needMechM = [SRCK.mechM * Math.pow(10, (T.boltUnderBlastDb[0] - q.gainDb) / 20),
                       SRCK.mechM * Math.pow(10, (T.boltUnderBlastDb[1] - q.gainDb) / 20)];
    const common =
      `Suppressed, cueRifle multiplies the mech by mechM = ${SRCK.mechM} (${mechDb >= 0 ? '+' : ''}${mechDb.toFixed(2)} dB) ` +
      `and the blast by ${SRCK.suppBlastScale} (${scaleDb.toFixed(2)} dB). Measured on the same bus over ${q.firings} ` +
      `firings: into-battery gain ${q.sample.boltGain} against blast gain ${q.sample.blastGain}, i.e. ` +
      `${q.gainDb >= 0 ? '+' : ''}${q.gainDb} dB (range ${q.gainDbRange.join(' .. ')} dB -- both layers carry the SAME ` +
      `(1 + jv) level jitter, so the ratio is exact, not noisy). Folding in the buffer peaks (${q.sample.boltBufPeak} vs ` +
      `${q.sample.blastBufPeak}) and the '${/shaper/.test(q.sample.blastFilters) ? 'blastLite' : 'no'}' waveshaper on the ` +
      `blast (${q.sample.blastBufPeak} -> ${q.sample.blastShaped}) gives ${q.effectiveDb >= 0 ? '+' : ''}${q.effectiveDb} dB ` +
      `of actual peak amplitude. ` +
      `THE ARITHMETIC: suppressed ratio = unsuppressed ratio + 20log10(mechM) - 20log10(blast scale) = ` +
      `${u.gainDb} ${mechDb >= 0 ? '+' : '-'} ${Math.abs(mechDb).toFixed(2)} + ${Math.abs(scaleDb).toFixed(2)} = ` +
      `${(u.gainDb + mechDb - scaleDb).toFixed(2)} dB, so the suppressed balance is fully determined by the UNSUPPRESSED ` +
      `one and mechM cannot be blamed for it. The unsuppressed rifle puts this bolt ${u.gainDb} dB under its own blast; ` +
      `the measurement the comment cites is 132 dBZ against ~160 dB, i.e. about -28 dB. To land in ` +
      `${T.boltUnderBlastDb[0]}..${T.boltUnderBlastDb[1]} dB the unsuppressed ratio has to be ` +
      `${needU[0].toFixed(1)}..${needU[1].toFixed(1)} dB, i.e. the into-battery layer wants to come down by ` +
      `${(u.gainDb - needU[1]).toFixed(1)}-${(u.gainDb - needU[0]).toFixed(1)} dB (into-battery vol is written ` +
      `'${IB.expr}', so the ${ibK} in it wants to be ` +
      `${(ibK * Math.pow(10, (needU[1] - u.gainDb) / 20)).toFixed(4)}-${(ibK * Math.pow(10, (needU[0] - u.gainDb) / 20)).toFixed(4)}, ` +
      `or the scale factor multiplying it has to move by the same ratio) ` +
      `or the blast scale has to rise. Reaching it through mechM alone would need mechM = ` +
      `${needMechM[1].toFixed(2)}-${needMechM[0].toFixed(2)}, i.e. the can would have to make the mechanism QUIETER, ` +
      `which contradicts the back-pressure argument the comment makes for 1.15 being above 1.`;
    assert('F1', 'suppressed: bolt is NOT above the muzzle blast',
      q.gainDb < 0, q.gainDb, '< 0 dB', common);
    assert('F2', `suppressed: bolt ${T.boltUnderBlastDb[0]}..${T.boltUnderBlastDb[1]} dB under the blast`,
      q.gainDb >= T.boltUnderBlastDb[0] && q.gainDb <= T.boltUnderBlastDb[1], q.gainDb,
      `${T.boltUnderBlastDb[0]}..${T.boltUnderBlastDb[1]} dB`, common);
    note('F3', '  ...same ratio including buffer peak + waveshaper', q.effectiveDb, 'dB',
      `Gain nodes alone say ${q.gainDb >= 0 ? '+' : ''}${q.gainDb} dB. The blast buffer normalises to ` +
      `${q.sample.blastBufPeak} and the ping buffer to ${q.sample.boltBufPeak}, and the blast alone runs through a ` +
      `waveshaper that maps its peak to ${q.sample.blastShaped}, so the peak-amplitude ratio is ` +
      `${q.effectiveDb >= 0 ? '+' : ''}${q.effectiveDb} dB. Filter magnitude responses are not modelled here, so this is ` +
      `a floor on the discrepancy rather than a full rendering: the suppressed blast additionally loses its top edge to ` +
      `lp ${(/lowpass@(\d+)/.exec(q.sample.blastFilters) || [0, '?'])[1]} Hz, which can only lower it further.`);
    note('F4', '  unsuppressed: same bolt against its own blast peak', u.gainDb, 'dB',
      `The number the suppressed one is derived FROM, and the one to check against the cited measurement: the ` +
      `into-battery slam metered at 132 dBZ at the shooter's ear against an unsuppressed muzzle blast of 158-162 dB ` +
      `peak is 26-30 dB down. Measured here over ${u.firings} firings: ${u.gainDb} dB (range ` +
      `${u.gainDbRange.join(' .. ')} dB), i.e. into-battery gain ${u.sample.boltGain} against blast gain ` +
      `${u.sample.blastGain}. Including the buffer peaks and the 'blastLite' shaper on the blast this becomes ` +
      `${u.effectiveDb} dB of peak amplitude.`);
  } else {
    assert('F1', 'suppressed: bolt is NOT above the muzzle blast', null, null, null, 'rifleq layers not identified');
    assert('F2', 'suppressed: bolt under the blast', null, null, null, 'rifleq layers not identified');
  }
  /* AUDIBILITY, as distinct from balance. The ratio above is to the blast
     PEAK, which happens ~70 ms before the carrier gets home and is therefore
     the wrong masker. This is the ratio that decides whether the slam is
     heard: the bolt against everything on the blast side of the same cue that
     is STILL SOUNDING at the instant it lands. */
  for (const [nm, d] of [['F5', boltDb.rifle], ['F5q', boltDb.rifleq]]) {
    if (!d || !d.maskSample) continue;
    const ms = d.maskSample, top = ms.stillSounding[0];
    const listed = ms.stillSounding.slice(0, 5).map(
      p => `${p.layer} ${p.ampAtBolt.toFixed(5)} (peaked ${p.peakGain}, ${p.downFromOwnPeakDb} dB, runs ` +
           `${p.startedMs.toFixed(1)}-${p.endsMs} ms)`).join('; ');
    note(nm, `  ${nm === 'F5' ? 'unsuppressed' : 'suppressed'}: bolt over what is still sounding at +${ms.boltAtMsFromBlast.toFixed(0)} ms`,
      d.overMaskerDb, 'dB',
      `The blast PEAK is not the masker: by the time the carrier arrives the near blast buffer (~58 ms long) has ` +
      `stopped outright and everything else is well down its own decay. Evaluating every layer's recorded gain ` +
      `automation at the bolt's arrival, ${ms.stillSounding.length} blast-side layers are still running and their ` +
      `power sum is ${ms.maskerAmp} against the bolt's ${ms.boltAmp}, i.e. ${d.overMaskerDb >= 0 ? '+' : ''}` +
      `${d.overMaskerDb} dB. Loudest single masker ${top ? top.layer : 'none'} at ` +
      `${d.overLoudestMaskerDb >= 0 ? '+' : ''}${d.overLoudestMaskerDb} dB under the bolt. Still sounding: ${listed}. ` +
      `Amplitudes are the layer's envelope times what its own buffer is doing in a 5 ms window at that instant ` +
      `(times the waveshaper where there is one), so a pre-rendered blast is counted at the level its SAMPLE has ` +
      `decayed to and not at the flat gain smp() gives it. Filter magnitudes and the spectral distance between the ` +
      `bolt's 1.6-2.3 kHz ping and the low-mid maskers are NOT modelled, and both work in the bolt's favour, so this ` +
      `is a floor.`);
  }
  if (boltDb.pistol && boltDb.pistol.firings) {
    const p = boltDb.pistol;
    const PB = volExprOf('cuePistol', 'tick', /t:\s*tB\s*,/) || { expr: '?' };
    note('F6', '  pistol: into battery against its own muzzle blast', p.gainDb, 'dB',
      `Same measurement on the pistol, which is never suppressed here. Into-battery vol is written '${PB.expr}'. ` +
      `Over ${p.firings} firings: ${p.gainDb} dB (range ${p.gainDbRange.join(' .. ')} dB), gain ` +
      `${p.sample.boltGain} against blast gain ${p.sample.blastGain}; with buffer peaks and the shaper folded in, ` +
      `${p.effectiveDb} dB. A pistol's mechanism is deliberately more prominent against its own blast than a ` +
      `carbine's -- about a fifth of the powder behind a slide that is not lighter than a carrier -- which is the ` +
      `argument the source makes for the pistol scale sitting above the rifle's. Against what is still sounding when ` +
      `the slide gets home, ${p.overMaskerDb >= 0 ? '+' : ''}${p.overMaskerDb} dB.`);
  }

  H.s.__resetVoices();
  trace('G: low tier');
  /* ---------------------------------------------------------------- G --- */
  /* LOW TIER VOICE BUDGET. This is the tier the mech thinning exists for: at
     CAP 34 the player's own sustained fire could saturate the pool by itself
     and start stealing enemy footsteps, so `detail` gates portGas, caseOut and
     the spring's long tail off entirely when TIER === 'low'. */
  let H3 = null, lowErr = null;
  try { H3 = new Boot(OPT.seed + 2).run(); }
  catch (e) { lowErr = e && e.message ? e.message : String(e); }
  if (H3) {
    trace('G: booted, switching tier');
    const tierSet = H3.NZ.audio.setTier('low');
    trace('G: tier switched, settling banks + IRs');
    H3.advance(2000, { step: 4 });          /* banks and IRs regenerate at the new tier */
    trace('G: settled, firing');
    const base = H3.stats();
    const per = [];
    for (let i = 0; i < OPT.shots; i++) {
      const mark = H3.mark();
      H3.NZ.first('sfx', 'rifle', H3.s.player.x, H3.s.player.z, H3.s.AU);
      const st = H3.stats();
      per.push({ voices: st.voices, spawned: H3.mark() - mark });
      H3.advance(OPT.spacing * 1000, { step: 3 });
      trace('G: shot ' + (i + 1) + ' -> live ' + st.voices);
    }
    const end = H3.stats();
    result.G = {
      tier: end.tier, tierSetReturned: tierSet, cap: end.cap,
      shots: OPT.shots, spacingMs: OPT.spacing * 1000,
      peakVoices: end.peakVoices, denied: end.denied - base.denied,
      steals: end.steals - base.steals, stolenPri: end.stolenPri,
      voicesPerShot: per.map(p => p.spawned), liveAfterEachShot: per.map(p => p.voices),
      headroom: end.cap - end.peakVoices,
    };
    assert('G1', `LOW tier: peak concurrent voices < CAP (${end.cap})`,
      end.peakVoices < end.cap && end.tier === 'low', end.peakVoices, '< ' + end.cap,
      `${OPT.shots} rifle shots at ${(OPT.spacing * 1000).toFixed(0)} ms on tier "${end.tier}". Voices spawned per shot ` +
      `${Math.min(...per.map(p => p.spawned))}-${Math.max(...per.map(p => p.spawned))}` +
      (result.C.sustained ? ` (against ${Math.min(...result.C.sustained.voicesPerShot)}-` +
        `${Math.max(...result.C.sustained.voicesPerShot)} at tier high)` : '') + `, ` +
      `live after each shot ${Math.min(...per.map(p => p.voices))}-${Math.max(...per.map(p => p.voices))}, headroom ` +
      `${end.cap - end.peakVoices} voices. The saving is the mech thinning: TIER !== 'low' gates portGas, caseOut and ` +
      `the spring's long tail.`);
    assert('G2', 'LOW tier: no voices denied',
      (end.denied - base.denied) === 0, end.denied - base.denied, '0',
      `steals ${end.steals - base.steals}, stolen by priority ${JSON.stringify(end.stolenPri)}. A denial is a layer that ` +
      `was asked for and never sounded; a steal is a layer cut short to make room, which is the designed yield path.`);
  } else {
    assert('G1', 'LOW tier: peak concurrent voices < CAP', null, null, null, 'low-tier boot failed: ' + lowErr);
    assert('G2', 'LOW tier: no voices denied', null, null, null, 'low-tier boot failed: ' + lowErr);
  }

  trace('H: far path');
  H3 = null;                                  /* release the low-tier sandbox */

  /* ---------------------------------------------------------------- H --- */
  /* THE FAR / OBSERVER PATH, which shares no code with the first-person one
     beyond blast() itself. A rifle fired across the level must still produce
     the two-part signature: the ballistic crack, which is nodl and therefore
     arrives immediately, and the far blast bank, which waits out the
     propagation delay. */
  H.advance(1200, { step: 6 });
  const farX = H.s.player.x + 60, farZ = H.s.player.z;
  const farCue = fireCue(H, 'rifle', null, farX, farZ);
  const crack = farCue.voices.find(v => v.bank === 'ck_narrow' || v.bank === 'ck_wide');
  const farBlast = farCue.voices.find(v => v.bank === 'bl_rifle_far');
  const nearBlast = farCue.voices.find(v => v.bank === 'bl_rifle_near');
  /* anything scheduled ahead of the blast that is NOT the crack would be a
     first-person layer leaking onto the observer path */
  const selfOnly = farCue.voices.filter(v => v.msFromBlast !== undefined && v.msFromBlast < -1 &&
    !(v.bank && v.bank.startsWith('ck_')));
  result.H = {
    firedAt: [farX, farZ], playerAt: [H.s.player.x, H.s.player.z],
    handled: farCue.handled, voices: farCue.voices.length,
    crack: crack ? { atMs: crack.ms, gain: crack.peak, bank: crack.bank, filters: crack.filt } : null,
    farBlast: farBlast ? { atMs: farBlast.ms, gain: farBlast.peak, bank: farBlast.bank, bufMs: +(farBlast.bufDur * 1000).toFixed(1) } : null,
    nearBlastPresent: !!nearBlast,
    crackToBlastMs: (crack && farBlast) ? +(farBlast.ms - crack.ms).toFixed(2) : null,
    firstPersonLayersPresent: selfOnly.length,
    timeline: farCue.voices.map(v => ({ ms: v.ms, kind: v.kind, peak: v.peak, bank: v.bank, filt: v.filt })),
  };
  assert('H1', 'far rifle still produces a ballistic crack layer',
    !!crack, crack ? crack.ms : null, 'present',
    crack ? `crack from bank ${crack.bank} at ${crack.ms} ms, gain ${crack.peak}, chain "${crack.filt}". ballistic() sets ` +
            `nodl:true so it skips the propagation delay entirely -- that is what makes a distant rifle go crack ... thump.`
          : `no voice in the cue came from the crack bank. ballistic() is gated on vol > 0.004 and on the bank existing; ` +
            `at ${(60 * 0.45).toFixed(1)} m the level is 0.62 * cl(1 - dm/110, 0.20, 1).`);
  assert('H2', 'far rifle still produces a far blast layer',
    !!farBlast, farBlast ? farBlast.ms : null, 'present',
    farBlast ? `far blast from bank ${farBlast.bank}, a ${(farBlast.bufDur * 1000).toFixed(0)} ms buffer, at ` +
               `${farBlast.ms} ms, gain ${farBlast.peak}. The near bank is correctly absent (b.near falls to 0 by 40 units).`
             : `blast() only fires the far bank when b.far * gain > 0.02; b.far = smoothstep(16, 62, dist).`);
  assert('H3', 'far: crack arrives well before the blast',
    !!(crack && farBlast) && (farBlast.ms - crack.ms) > 30, result.H.crackToBlastMs, '> 30 ms',
    crack && farBlast
      ? `crack at ${crack.ms} ms, blast at ${farBlast.ms} ms, gap ${result.H.crackToBlastMs} ms. The emitter is 60 units ` +
        `= ${(60 * 0.45).toFixed(1)} m away, so b.prop = ${(60 * 0.45 / 343 * 1000).toFixed(1)} ms, and layerT() adds the ` +
        `${floorMs.toFixed(1)} ms floor to the crack. Also confirms no first-person layers leaked onto the observer path: ` +
        `${selfOnly.length} voices scheduled ahead of the blast.`
      : 'crack or far blast missing');

  trace('I: shotgun/chain regression');
  /* ---------------------------------------------------------------- I --- */
  /* SHOTGUN / CHAIN REGRESSION. Two independent checks.
     (1) static: none of the changed constants or the rewritten cue code is
         reachable from cueShotgun / cueChain;
     (2) dynamic: reconstruct the pre-change build in memory by reverting the
         numeric constants that were retuned, boot it beside the real one with
         the same seed, and diff the shotgun and chain cues voice for voice.
     Reverting the constants is enough for this purpose: every other edit is
     inside cueRifle / cuePistol / preTransient, which neither cue calls. */
  const REVERTS = [
    ['var MECH_T0 = 0.0042;', 'var MECH_T0 = 0.0026;', 'MECH_T0'],
    ['var mechM = supp ? 1.15 : 1;', 'var mechM = supp ? 2.5 : 1;', 'mechM'],
    ['gb: 0.23, gbT: 0.0006, gbF: 3400, gbSign: 1,', 'gb: 0.23, gbT: 0.0012, gbF: 3400, gbSign: 1,', 'rifle gbT'],
    ['gasMul: 3.9, gasAmp: 0.46,', 'gasMul: 3.9, gasAmp: 0.66,', 'rifle gasAmp'],
    ['gasMul: 6.8, gasAmp: 0.32,', 'gasMul: 6.8, gasAmp: 0.44,', 'pistol gasAmp'],
    ['bore: 0.112, boreAmp: 0.19,', 'bore: 0.112, boreAmp: 0.30,', 'pistol boreAmp'],
  ];
  let beforeSrc = SRC, revertOk = [], revertBad = [];
  for (const [from, to, what] of REVERTS) {
    const hits = beforeSrc.split(from).length - 1;
    if (hits === 1) { beforeSrc = beforeSrc.replace(from, to); revertOk.push(what); }
    else revertBad.push(`${what} (${hits} matches)`);
  }
  /* static reachability */
  const shotBody = fnBody('cueShotgun'), chainBody = fnBody('cueChain');
  const forbidden = ['MECH_T0', 'preTransient', 'mechM', 'supp', 'T0'];
  const leaks = [];
  for (const f of forbidden) {
    const re = new RegExp('\\b' + f + '\\b');
    if (re.test(shotBody)) leaks.push(`cueShotgun references ${f}`);
    if (re.test(chainBody)) leaks.push(`cueChain references ${f}`);
  }
  const fp = v => `${v.ms.toFixed(3)}|${v.kind}|${v.peak}|${v.durMs}|${v.filt}|${v.bufDur}|${v.bufPeak}`;
  const runPair = (src, label) => {
    const B = new Boot(OPT.seed + 3, src, label).run();
    B.advance(2200, { step: 4 });
    const pr = B.NZ.audio._probe();
    B.advance(1500, { step: 4 });
    const pr2 = B.NZ.audio._probe();
    indexBanks(pr2);
    const out = {};
    for (const nm of ['shotgun', 'chain']) {
      B.advance(700, { step: 6 });
      const c = fireCue(B, nm, null);
      out[nm] = { voices: c.voices.length, fp: c.voices.map(fp),
                  timeline: c.voices.map(v => { const { env, ...rest } = v; return rest; }) };
    }
    /* content hash of the two banks these cues actually play */
    const hashBank = arr => {
      let h = 2166136261 >>> 0;
      for (const b of (arr || [])) {
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i += 7) { h ^= Math.round(d[i] * 32767) & 0xffff; h = Math.imul(h, 16777619) >>> 0; }
      }
      return h.toString(16);
    };
    out.banks = {
      shotgun_near: hashBank(pr2.blast.shotgun_near), shotgun_far: hashBank(pr2.blast.shotgun_far),
      chain_near: hashBank(pr2.blast.chain_near), chain_far: hashBank(pr2.blast.chain_far),
      rifle_near: hashBank(pr2.blast.rifle_near), pistol_near: hashBank(pr2.blast.pistol_near),
    };
    return out;
  };
  let after = null, before = null, regErr = null;
  if (!revertBad.length) {
    try { after = runPair(null, 'nz-audio.js'); before = runPair(beforeSrc, 'nz-audio.js@before'); }
    catch (e) { regErr = e && e.message ? e.message : String(e); }
  }
  result.I = {
    revertsApplied: revertOk, revertsFailed: revertBad, staticLeaks: leaks,
    error: regErr,
    shotgun: after ? { voices: after.shotgun.voices, timeline: after.shotgun.timeline } : null,
    chain: after ? { voices: after.chain.voices, timeline: after.chain.timeline } : null,
    banksAfter: after ? after.banks : null, banksBefore: before ? before.banks : null,
  };
  if (after && before) {
    const same = nm => after[nm].voices === before[nm].voices &&
                       after[nm].fp.join('\n') === before[nm].fp.join('\n');
    const diffOf = nm => {
      const d = [];
      const A = after[nm].fp, Bf = before[nm].fp;
      for (let i = 0; i < Math.max(A.length, Bf.length); i++)
        if (A[i] !== Bf[i]) d.push(`#${i}: after "${A[i] || '(missing)'}" vs before "${Bf[i] || '(missing)'}"`);
      return d;
    };
    const bankSame = ['shotgun_near', 'shotgun_far', 'chain_near', 'chain_far']
      .filter(k => after.banks[k] === before.banks[k]);
    const gunChanged = ['rifle_near', 'pistol_near'].filter(k => after.banks[k] !== before.banks[k]);
    result.I.shotgunIdentical = same('shotgun');
    result.I.chainIdentical = same('chain');
    result.I.shotgunDiff = diffOf('shotgun');
    result.I.chainDiff = diffOf('chain');
    result.I.banksIdentical = bankSame;
    result.I.banksChanged = gunChanged;
    const ctl = `Control: the same comparison on the banks that WERE retuned shows ` +
      `${gunChanged.length ? gunChanged.join(' and ') + ' differ' : 'NO difference, which would mean the reconstruction did nothing'}` +
      `, so the reconstruction is live. Reverted: ${revertOk.join(', ')}.` +
      (leaks.length ? ' STATIC LEAK: ' + leaks.join('; ') : ' Statically, neither cue references MECH_T0, preTransient, mechM, supp or T0.');
    assert('I1', 'sfx("shotgun") unchanged: voice count + layer structure',
      same('shotgun') && bankSame.includes('shotgun_near') && bankSame.includes('shotgun_far'),
      after.shotgun.voices, before.shotgun.voices + ' voices',
      `${after.shotgun.voices} voices in both builds, and every layer matches on scheduled time, node type, peak gain, ` +
      `duration, filter chain, buffer length and buffer peak. Both shotgun blast banks hash identically ` +
      `(${after.banks.shotgun_near}/${after.banks.shotgun_far}). ${result.I.shotgunDiff.length ? 'DIFFERENCES: ' + result.I.shotgunDiff.slice(0, 4).join(' | ') : ''} ${ctl}`);
    assert('I2', 'sfx("chain") unchanged: voice count + layer structure',
      same('chain') && bankSame.includes('chain_near') && bankSame.includes('chain_far'),
      after.chain.voices, before.chain.voices + ' voices',
      `${after.chain.voices} voices in both builds, all layers identical field for field. Both chain blast banks hash ` +
      `identically (${after.banks.chain_near}/${after.banks.chain_far}). ` +
      `${result.I.chainDiff.length ? 'DIFFERENCES: ' + result.I.chainDiff.slice(0, 4).join(' | ') : ''} ${ctl}`);
  } else {
    const why = regErr || ('could not reconstruct the pre-change build: ' + revertBad.join(', '));
    assert('I1', 'sfx("shotgun") unchanged vs the pre-change build', null, null, null, why);
    assert('I2', 'sfx("chain") unchanged vs the pre-change build', null, null, null, why);
  }

  trace('S: health');
  /* ---------------------------------------------------------- health --- */
  const endStats = H.stats();
  result.meta.statsAfter = endStats;
  /* A recipe that no longer resolves means a layer this harness is supposed to
     be able to find has moved or been renamed. That must be loud: it is the
     failure mode that turns an assertion into a SKIP. */
  assert('S0', 'every layer gain recipe still resolves against nz-audio.js',
    GAIN_MISS.length === 0, GAIN_MISS.length, '0 unresolved',
    GAIN_MISS.length
      ? `could not read a vol: expression for ${[...new Set(GAIN_MISS)].join(', ')} -- those layers fall back to ` +
        `time + node type + filter family alone, which is weaker and may mislabel.`
      : `all ${RIFLE_MAP.length + RIFLEQ_MAP.length + PISTOL_MAP.length} layer windows were computed by parsing the ` +
        `call sites in nz-audio.js (the vol: expression, the scale factors it references, and the multiplier the ` +
        `primitive applies), so retuning any of those numbers moves the windows with them instead of unlabelling ` +
        `the layer.`);
  assert('S1', 'module still installed and never panicked',
    endStats.installed === true && endStats.dead === false,
    endStats.dead ? 'dead' : (endStats.installed ? 'installed' : 'not installed'), 'installed',
    `after ${OPT.trials * 2 + 15 + OPT.shots} cue firings: voices ${endStats.voices}, peak ${endStats.peakVoices}, ` +
    `steals ${endStats.steals}, denied ${endStats.denied}, space "${endStats.space}", IRs ${Object.keys(endStats.irs || {}).join(',')}. ` +
    (MODULE_ERRORS.length ? 'console.error seen: ' + MODULE_ERRORS.slice(0, 2).join(' | ') : 'no console.error from the module.'));

  /* -------------------------------------------------------------- out --- */
  result.asserts = ASSERTS;
  result.summary = {
    pass: ASSERTS.filter(a => a.status === 'PASS').length,
    fail: ASSERTS.filter(a => a.status === 'FAIL').length,
    skip: ASSERTS.filter(a => a.status === 'SKIP').length,
    info: ASSERTS.filter(a => a.status === 'INFO').length,
  };
  if (MODULE_ERRORS.length) result.notes.push(MODULE_ERRORS.length + ' console.error from the module: ' + MODULE_ERRORS.slice(0, 3).join(' | '));
  if (MODULE_WARNINGS.length) result.notes.push(MODULE_WARNINGS.length + ' console.warn from the module: ' + MODULE_WARNINGS.slice(0, 3).join(' | '));
  if (H.s.__stubErrors && H.s.__stubErrors.length) result.notes.push('stub caught ' + H.s.__stubErrors.length + ' error(s) inside deferred module callbacks: ' + H.s.__stubErrors.slice(0, 3).join(' | '));

  /* `shaper` holds a live reference to the module's WaveShaper curve so the
     F section can evaluate it; it is thousands of samples and has no business
     in the JSON, as have the raw magnitude spectra. */
  if (OPT.json) console.log(JSON.stringify(result,
    (k, v) => (k === '__m' || k === 'shaper' || k === 'curve' || ((k === 'mag' || k === 'env') && ArrayBuffer.isView(v))) ? undefined : v, 2));
  else printReport(result);
  process.exit(result.summary.fail ? 1 : 0);
}

/* ========================================================= reporting ==== */
const COL = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => COL ? `\x1b[${n}m${s}\x1b[0m` : s;
const green = s => c(32, s), red = s => c(31, s), yellow = s => c(33, s), dim = s => c(90, s), bold = s => c(1, s);
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const num = v => (v === null || v === undefined) ? '-' : (typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4)) : String(v));

function printReport(R) {
  console.log('');
  console.log(bold('  NUKE ZONE 3D  --  nz-audio offline verification harness'));
  console.log(dim(`  install ${R.meta.installMs} ms | probe ${R.meta.probeMs} ms | sr ${R.meta.stats.tier ? '48000' : '?'} | tier ${R.meta.stats.tier} | cap ${R.meta.stats.cap} | seed ${R.meta.seed} | commit ${R.meta.commit}`));
  console.log('');

  /* A */
  console.log(bold('  A. blast bank spectra'));
  console.log(dim('    ' + pad('bank', 15) + padL('peak Hz', 10) + padL('pk>200Hz', 10) + padL('centroid', 10) + padL('crest dB', 10) +
    padL('rise us', 9) + padL('pos ms', 9) + padL('1/2piT', 9) + padL('len ms', 8) + padL('vars', 6)));
  for (const k of ['pistol_near', 'rifle_near', 'pistol_far', 'rifle_far']) {
    const a = R.A[k];
    if (!a) continue;
    if (a.error) { console.log('    ' + pad(k, 15) + red(a.error)); continue; }
    console.log('    ' + pad(k, 15) + padL(a.spectralPeakHz, 10) + padL(a.spectralPeakAbove200Hz, 10) + padL(a.spectralCentroidHz, 10) +
      padL(a.crestFactorDb, 10) + padL(a.riseTimeUs, 9) + padL(a.positivePhaseMs, 9) +
      padL(a.frontImpliedHz.toFixed(1), 9) + padL(a.bufferMs, 8) + padL(a.variants, 6));
    console.log(dim('       strongest spectral maxima < 8 kHz: ' +
      a.topPeaks.map(p => `${p.hz} Hz (${p.relDb} dB)`).join(', ')));
    if (OPT.verbose) {
      console.log(dim('       per-variant peak Hz: ' + a.spectralPeakHzPerVariant.join(', ')));
      console.log(dim('       per-variant crest dB: ' + a.crestPerVariant.join(', ')));
      console.log(dim('       band share: ' + a.bandShare.map(b => `${b.band}:${(b.share * 100).toFixed(1)}%`).join(' ')));
    }
  }
  console.log(dim('    rise us 0 = the shock front reaches 90% within a single sample (< 20.8 us at 48 kHz).'));
  console.log(dim('    1/2piT is the Friedlander peak implied by the measured positive-phase duration.'));
  console.log('');

  /* B */
  console.log(bold('  B. rifle_near barrel modes  ') + dim(`(closed-open pipe: f0 = 343/(2*${R.B.bore}) = ${R.B.f0} Hz, stretch ${R.B.stretch}, pipe:${R.B.pipe}, spectra averaged over ${R.B.averagedOver} variants)`));
  if (R.B.error) console.log('    ' + red(R.B.error));
  else {
    const tbl = (rows) => {
      console.log(dim('    ' + pad('mode', 8) + padL('target Hz', 11) + padL('found Hz', 10) + padL('|X|', 11) + padL('baseline', 11) + padL('prominence', 12) + '  parity'));
      for (const r of rows)
        console.log('    ' + pad('m=' + r.m, 8) + padL(r.target, 11) + padL(r.hz, 10) + padL(r.mag.toFixed(4), 11) +
          padL(r.baseline.toFixed(4), 11) + padL(r.prominenceDb.toFixed(2) + ' dB', 12) + '  ' +
          (r.odd ? green('odd (expected)') : yellow('even (should be absent)')));
    };
    tbl(R.B.rows);
    console.log(dim(`    odd/even magnitude ratio: m1/m2 ${R.B.oddOverEvenDb['m1/m2']} dB, m3/m4 ${R.B.oddOverEvenDb['m3/m4']} dB`));
    if (R.B.pistolCrossCheck) {
      console.log('');
      console.log('    ' + dim(`cross-check, pistol_near (also pipe:1, f0 = ${R.B.pistolCrossCheck.f0} Hz):`));
      tbl(R.B.pistolCrossCheck.rows);
      console.log(dim(`    odd/even magnitude ratio: m1/m2 ${R.B.pistolOddOverEvenDb['m1/m2']} dB, m3/m4 ${R.B.pistolOddOverEvenDb['m3/m4']} dB`));
    }
  }
  console.log('');

  /* C */
  console.log(bold('  C. cue timelines (self = true, listener at the emitter)'));
  for (const name of Object.keys(R.C.cues)) {
    const cu = R.C.cues[name];
    console.log('    ' + bold(name) + dim(`  handled=${cu.handled}  voices=${cu.voices}  sum(peak gain)=${cu.totalPeakGain}  muzzle blast at ${cu.blastAtMs} ms`));
    console.log(dim('      ' + padL('ms', 8) + padL('ms/blast', 10) + '  ' + pad('type', 8) + padL('peak g', 9) + padL('dur ms', 9) + '  ' + pad('filters', 30) + 'likely source'));
    for (const v of cu.timeline) {
      console.log('      ' + padL(v.ms.toFixed(2), 8) + padL(v.msFromBlast === undefined ? '-' : v.msFromBlast.toFixed(2), 10) +
        '  ' + pad(v.kind, 8) + padL(v.peak === null ? '-' : v.peak.toFixed(4), 9) +
        padL(v.durMs === null ? '-' : v.durMs.toFixed(1), 9) + '  ' + pad(v.filt || (v.f0 ? 'f0=' + v.f0 : ''), 30) + dim(v.label || ''));
    }
    console.log('');
  }
  if (R.C.sustained) {
    const s = R.C.sustained;
    console.log('    ' + bold('sustained fire: ') + dim(`${s.shots} rifle shots at ${s.spacingMs} ms`));
    console.log('      peak concurrent voices ' + bold(String(s.peakVoices)) + ' of cap ' + s.cap +
      ' | denied ' + s.denied + ' | steals ' + s.steals);
    console.log(dim('      voices spawned per shot: ' + s.voicesPerShot.join(' ')));
    console.log(dim('      live voices after each shot: ' + s.liveAfterEachShot.join(' ')));
    console.log('');
  }

  /* D */
  console.log(bold('  D. pistol decorrelation (12 shots)'));
  console.log(dim('      ' + padL('shot', 6) + padL('voices', 8) + padL('sum gain', 11) + padL('slide ms', 10)));
  for (const s of R.D.shots)
    console.log('      ' + padL(s.i, 6) + padL(s.voices, 8) + padL(s.totalGain.toFixed(4), 11) + padL(s.slideMs === null ? '-' : s.slideMs.toFixed(2), 10));
  console.log(`      total-gain CV ${(R.D.totalGainCV * 100).toFixed(2)}%   slide-time CV ${R.D.slideTimeCV === null ? '-' : (R.D.slideTimeCV * 100).toFixed(2) + '%'}` +
    `   identical timings: ${R.D.identicalTimes ? red('YES') : green('no')}   identical gains: ${R.D.identicalPeaks ? red('YES') : green('no')}`);
  console.log('');

  /* E */
  if (R.E) {
    console.log(bold('  E. structure-borne precursor  ') +
      dim(`(MECH_T0 = ${R.meta.srcConstants.MECH_T0}s = ${(R.meta.srcConstants.MECH_T0 * 1000).toFixed(1)} ms, layerT floor ${(R.meta.srcConstants.layerTFloor * 1000).toFixed(1)} ms, both read from nz-audio.js)`));
    console.log(dim('    ' + pad('cue', 9) + padL('sear ms', 22) + padL('swell ms', 10) + padL('gap ms', 20) +
      padL('sear lead', 20) + padL('swell env - blast', 20)));
    for (const k of Object.keys(R.E)) {
      const E = R.E[k];
      const s3 = v => v === null ? '-' : `${v.min}/${v.med}/${v.max}`;
      console.log('    ' + pad(k, 9) + padL(s3(E.searScheduledMs), 22) + padL(E.swellScheduledMs ? E.swellScheduledMs.med : '-', 10) +
        padL(s3(E.gapMs), 20) + padL(s3(E.searLeadOverBlastMs), 20) + padL(s3(E.swellEnvPeakMinusBlastMs), 20));
      console.log(dim(`       ${E.firings} firings | sear source window ${E.searSourceWindowMs[0]}-${E.searSourceWindowMs[1]} ms, ` +
        `${E.searDistinctInstants} distinct instants measured | swell t ${E.swellSourceMs} ms + atk ${E.swellAtkMs} ms ` +
        `= peak at ${(E.swellSourceMs + E.swellAtkMs).toFixed(2)} ms vs blast at ${E.blastAtMs} ms | ` +
        `coincident (< 20 us apart) on ${(E.coincidentFraction * 100).toFixed(0)}% of shots`));
    }
    console.log('');
  }

  /* F */
  if (R.F && R.F.suppressed && R.F.suppressed.sample) {
    const q = R.F.suppressed, u = R.F.unsuppressed, s = q.sample;
    console.log(bold('  F. suppressed balance: into battery vs the muzzle blast, same bus'));
    console.log(dim('    ' + pad('build', 14) + padL('blast g', 10) + padL('bolt g', 10) + padL('gain dB', 10) + padL('peak dB', 10) + padL('bolt at', 10)));
    console.log('    ' + pad('rifleq (supp)', 14) + padL(s.blastGain.toFixed(4), 10) + padL(s.boltGain.toFixed(4), 10) +
      padL((q.gainDb >= 0 ? '+' : '') + q.gainDb, 10) + padL((q.effectiveDb >= 0 ? '+' : '') + q.effectiveDb, 10) +
      padL('+' + s.boltAtMsFromBlast + 'ms', 10));
    for (const [nm, d] of [['rifle', u], ['pistol', R.F.pistol]])
      if (d && d.sample)
        console.log('    ' + pad(nm, 14) + padL(d.sample.blastGain.toFixed(4), 10) + padL(d.sample.boltGain.toFixed(4), 10) +
          padL(String(d.gainDb), 10) + padL(String(d.effectiveDb), 10) + padL('+' + d.sample.boltAtMsFromBlast + 'ms', 10));
    console.log(dim(`      mechM ${R.F.mechM}, suppressed blast scale ${R.F.blastScale}. blast chain "${s.blastFilters}" ` +
      `(buffer peak ${s.blastBufPeak} -> ${s.blastShaped} through the shaper); bolt chain "${s.boltFilters}" (buffer peak ${s.boltBufPeak}).`));
    console.log(dim(`      range over ${q.firings} firings: ${q.gainDbRange.join(' .. ')} dB. Negative = bolt under the blast.`));
    /* against the real masker rather than against the peak */
    console.log('');
    console.log(bold('     ...and against what is actually still sounding when the bolt lands'));
    console.log(dim('    ' + pad('build', 14) + padL('bolt amp', 10) + padL('masker', 10) + padL('over dB', 10) + padL('vs top', 10) + '  ' + 'still sounding (amp at the bolt)'));
    for (const [nm, d] of [['rifleq (supp)', q], ['rifle', u], ['pistol', R.F.pistol]]) {
      if (!d || !d.maskSample) continue;
      const m = d.maskSample;
      console.log('    ' + pad(nm, 14) + padL(m.boltAmp.toFixed(5), 10) + padL(m.maskerAmp.toFixed(5), 10) +
        padL((d.overMaskerDb >= 0 ? '+' : '') + d.overMaskerDb, 10) +
        padL((d.overLoudestMaskerDb >= 0 ? '+' : '') + d.overLoudestMaskerDb, 10) + '  ' +
        m.stillSounding.map(p => `${p.layer} ${p.ampAtBolt.toFixed(4)}`).join(', '));
    }
    console.log(dim('      amplitude = envelope x what the layer\'s own buffer is doing in a 5 ms window there x shaper, ' +
      'so a pre-rendered blast counts at what its SAMPLE has decayed to, not at the flat gain smp() holds.'));
    console.log(dim('      filter magnitudes and the spectral distance between the ping and the low-mid maskers are not ' +
      'modelled, and both favour the bolt, so these are floors.'));
    console.log('');
  }

  /* G */
  if (R.G) {
    console.log(bold('  G. LOW tier voice budget  ') + dim(`(setTier('low') -> tier ${R.G.tier}, cap ${R.G.cap})`));
    console.log('      peak concurrent voices ' + bold(String(R.G.peakVoices)) + ' of cap ' + R.G.cap +
      ' | denied ' + (R.G.denied ? red(String(R.G.denied)) : green('0')) + ' | steals ' + R.G.steals + ' | headroom ' + R.G.headroom);
    console.log(dim('      voices spawned per shot: ' + R.G.voicesPerShot.join(' ')));
    console.log(dim('      live voices after each shot: ' + R.G.liveAfterEachShot.join(' ')));
    console.log(dim('      stolen by priority: ' + JSON.stringify(R.G.stolenPri)));
    console.log('');
  }

  /* H */
  if (R.H) {
    console.log(bold('  H. far / observer path  ') + dim(`(emitter at ${R.H.firedAt.join(',')}, player at ${R.H.playerAt.join(',')})`));
    console.log(dim('      ' + padL('ms', 8) + '  ' + pad('type', 8) + padL('peak g', 9) + '  ' + pad('bank', 14) + 'filters'));
    for (const v of R.H.timeline)
      console.log('      ' + padL(v.ms.toFixed(2), 8) + '  ' + pad(v.kind, 8) + padL(v.peak === null ? '-' : v.peak.toFixed(4), 9) +
        '  ' + pad(v.bank || '-', 14) + dim(v.filt || ''));
    console.log(dim(`      crack -> blast gap ${R.H.crackToBlastMs} ms | near blast present: ${R.H.nearBlastPresent} | ` +
      `first-person layers leaked: ${R.H.firstPersonLayersPresent}`));
    console.log('');
  }

  /* I */
  if (R.I) {
    console.log(bold('  I. shotgun / chain regression against the pre-change build'));
    if (R.I.error) console.log('    ' + red(R.I.error));
    else if (R.I.revertsFailed.length) console.log('    ' + red('could not reconstruct: ' + R.I.revertsFailed.join(', ')));
    else {
      console.log(dim(`      reverted for the comparison: ${R.I.revertsApplied.join(', ')}`));
      console.log(`      shotgun: ${R.I.shotgun.voices} voices, structure ${R.I.shotgunIdentical ? green('identical') : red('CHANGED')}`);
      console.log(`      chain:   ${R.I.chain.voices} voices, structure ${R.I.chainIdentical ? green('identical') : red('CHANGED')}`);
      console.log(dim(`      bank hashes identical: ${R.I.banksIdentical.join(', ') || 'none'} | deliberately changed: ${R.I.banksChanged.join(', ') || 'none'}`));
      console.log(dim(`      static: ${R.I.staticLeaks.length ? red(R.I.staticLeaks.join('; ')) : 'neither cue references MECH_T0 / preTransient / mechM / supp / T0'}`));
      for (const d of (R.I.shotgunDiff || []).slice(0, 3)) console.log('        ' + red('shotgun ' + d));
      for (const d of (R.I.chainDiff || []).slice(0, 3)) console.log('        ' + red('chain ' + d));
    }
    console.log('');
  }

  /* assertions */
  console.log(bold('  ASSERTIONS'));
  console.log(dim('    ' + pad('id', 5) + pad('assertion', 52) + padL('measured', 11) + padL('required', 20) + '  status'));
  for (const a of R.asserts) {
    const st = a.status === 'PASS' ? green('PASS') : a.status === 'FAIL' ? red('FAIL')
             : a.status === 'INFO' ? dim('info') : yellow('SKIP');
    console.log('    ' + pad(a.id, 5) + pad(a.label, 52) + padL(num(a.value), 11) + padL(a.threshold === null ? '-' : String(a.threshold), 20) + '  ' + st);
    if (a.status === 'FAIL' || a.status === 'SKIP' || a.status === 'INFO' || OPT.verbose) {
      if (a.detail) for (const line of wrap(a.detail, 108)) console.log(dim('       -> ' + line));
    }
  }
  console.log('');
  for (const n of R.notes) console.log(dim('  note: ' + n));
  const sum = `  ${R.summary.pass} pass, ${R.summary.fail} fail, ${R.summary.skip} skipped, ${R.summary.info} reported`;
  console.log(R.summary.fail ? red(bold(sum)) : R.summary.skip ? yellow(bold(sum)) : green(bold(sum)));
  console.log('');
}
function wrap(s, w) {
  const words = String(s).split(/\s+/), out = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > w) { out.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

main();
