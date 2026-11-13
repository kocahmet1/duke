/* ===========================================================================
   NZ-CORE  --  shared foundation for the AAA subsystem modules.
   Loaded BEFORE the main game script. Owns three things:

     1. NZ.hook      a tiny hook bus so modules can attach to / override the
                     game without any of them editing NUKEM.html.
     2. NZ.tex       a procedural PBR texture bakery: fbm/worley noise,
                     height->normal, and a bake() that emits a full
                     {map, normalMap, roughnessMap, metalnessMap, aoMap} set.
     3. NZ.math      springs, dampers and easing used by weapon + enemy anim.

   Zero assets. Everything is generated at runtime on a 2D canvas.
   ======================================================================== */
(function (global) {
  'use strict';

  const NZ = global.NZ = global.NZ || {};

  /* Feature flags. The game checks these before taking a new code path, so
     any module can be switched off without touching the others. Modules set
     their own flag true once they have successfully installed. */
  NZ.flags = {
    render: false,    // nz-render.js  owns the post stack + IBL
    enemies: false,   // nz-enemies.js owns enemy meshes + animation
    weapons: false,   // nz-weapons.js owns the 3D viewmodel
    audio: false      // nz-audio.js   owns sfx synthesis
  };

  NZ.debug = /[?&]nzdebug=1/.test(global.location ? global.location.search : '');
  NZ.log = function () { if (NZ.debug) console.log.apply(console, ['[nz]'].concat([].slice.call(arguments))); };

  /* ---------------------------------------------------------------- hooks --
     on(name, fn)        register a listener
     call(name, ...a)    fire every listener; returns true if any ran
     first(name, ...a)   fire in order, stop at the first non-undefined
                         result and return it. This is how a module *overrides*
                         a stock behaviour (enemy rig, sfx) rather than adding
                         to it. Returns undefined if nobody handled it.
     A throwing listener is logged and disabled rather than killing the frame. */
  const H = Object.create(null);
  NZ.on = function (name, fn, priority) {
    (H[name] || (H[name] = [])).push({ fn: fn, p: priority || 0, dead: false });
    H[name].sort((a, b) => b.p - a.p);
    return NZ;
  };
  NZ.has = function (name) { return !!(H[name] && H[name].some(l => !l.dead)); };
  NZ.call = function (name) {
    const ls = H[name]; if (!ls) return false;
    const args = [].slice.call(arguments, 1);
    let ran = false;
    for (const l of ls) {
      if (l.dead) continue;
      try { l.fn.apply(null, args); ran = true; }
      catch (err) { l.dead = true; console.error('[nz] hook "' + name + '" disabled after error:', err); }
    }
    return ran;
  };
  NZ.first = function (name) {
    const ls = H[name]; if (!ls) return undefined;
    const args = [].slice.call(arguments, 1);
    for (const l of ls) {
      if (l.dead) continue;
      try { const r = l.fn.apply(null, args); if (r !== undefined) return r; }
      catch (err) { l.dead = true; console.error('[nz] hook "' + name + '" disabled after error:', err); }
    }
    return undefined;
  };

  /* Filled in by NUKEM.html at boot so modules never have to reach for
     globals that may not exist yet. */
  NZ.ctx = { renderer: null, scene: null, camera: null, THREE: null };

  /* ----------------------------------------------------------------- math -- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  /* Critically-damped spring. This is the single most important function for
     making a gun feel AAA: recoil, sway, ADS blend and camera kick all run
     through it. Frame-rate independent, never overshoots unless asked to. */
  function Spring(value, stiffness, damping) {
    this.x = value || 0; this.v = 0; this.target = this.x;
    this.k = stiffness === undefined ? 170 : stiffness;
    this.d = damping === undefined ? 2 * Math.sqrt(this.k) : damping; // critical by default
  }
  Spring.prototype.step = function (dt) {
    /* Semi-implicit Euler, substepped so a 50ms hitch cannot make it explode. */
    let remaining = Math.min(dt, .1);
    const h = 1 / 240;
    while (remaining > 0) {
      const s = Math.min(h, remaining); remaining -= s;
      const a = (this.target - this.x) * this.k - this.v * this.d;
      this.v += a * s; this.x += this.v * s;
    }
    return this.x;
  };
  Spring.prototype.set = function (v) { this.x = v; this.v = 0; return this; };
  Spring.prototype.impulse = function (v) { this.v += v; return this; };

  /* Exponential smoothing that is actually frame-rate independent.
     rate is "fraction remaining after 1 second". */
  const damp = (a, b, rate, dt) => b + (a - b) * Math.pow(rate, dt);

  NZ.math = {
    clamp, lerp, damp, TAU, Spring,
    smoothstep: t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); },
    smootherstep: t => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); },
    easeOutCubic: t => 1 - Math.pow(1 - t, 3),
    easeOutExpo: t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
    easeInOutQuad: t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    /* deterministic per-object jitter so variants are stable across reloads */
    hash: (i) => { let h = Math.sin(i * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); }
  };

  /* -------------------------------------------------------------- noise --- */
  /* Seeded value noise + fbm + worley. Deterministic: the same seed always
     bakes the same texture, so variants are reproducible and debuggable. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* Tileable value-noise lattice. Wrapping is essential -- a seam on a weapon
     receiver reads instantly as amateur work. */
  function lattice(size, rnd) {
    const g = new Float32Array(size * size);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return g;
  }
  function sampleLattice(g, size, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % size) + size) % size, x1 = (x0 + 1) % size;
    const y0 = ((yi % size) + size) % size, y1 = (y0 + 1) % size;
    const a = g[y0 * size + x0], b = g[y0 * size + x1];
    const c = g[y1 * size + x0], d = g[y1 * size + x1];
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  }

  /* Fractal brownian motion over a tiling lattice. Returns Float32Array in
     0..1, `res` wide/high. octaves of 5-6 is the sweet spot for surface grain. */
  function fbm(res, opts) {
    opts = opts || {};
    const octaves = opts.octaves || 5;
    const freq0 = opts.frequency || 4;
    const gain = opts.gain === undefined ? .5 : opts.gain;
    const lacunarity = opts.lacunarity || 2;
    const rnd = mulberry32(opts.seed === undefined ? 1337 : opts.seed);
    const out = new Float32Array(res * res);
    let amp = 1, total = 0, freq = freq0;
    const grids = [];
    for (let o = 0; o < octaves; o++) {
      const s = Math.max(2, Math.round(freq));
      grids.push({ g: lattice(s, rnd), s: s, amp: amp });
      total += amp; amp *= gain; freq *= lacunarity;
    }
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        let v = 0;
        for (const o of grids) v += sampleLattice(o.g, o.s, x / res * o.s, y / res * o.s) * o.amp;
        out[y * res + x] = v / total;
      }
    }
    if (opts.ridged) for (let i = 0; i < out.length; i++) out[i] = 1 - Math.abs(out[i] * 2 - 1);
    return out;
  }

  /* Tiling worley / cellular noise. F1 distance. Drives scratches, cast metal,
     leather pores, scale patterns. */
  function worley(res, opts) {
    opts = opts || {};
    const cells = opts.cells || 8;
    const rnd = mulberry32(opts.seed === undefined ? 99 : opts.seed);
    const pts = [];
    for (let cy = 0; cy < cells; cy++)
      for (let cx = 0; cx < cells; cx++)
        pts.push([(cx + rnd()) / cells, (cy + rnd()) / cells]);
    const out = new Float32Array(res * res);
    const inv = 1 / res;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const px = x * inv, py = y * inv;
        let best = 1e9;
        /* only test the 3x3 neighbourhood, with wrap */
        const gx = Math.floor(px * cells), gy = Math.floor(py * cells);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const ix = ((gx + ox) % cells + cells) % cells, iy = ((gy + oy) % cells + cells) % cells;
          const p = pts[iy * cells + ix];
          let dx = p[0] - px, dy = p[1] - py;
          if (dx > .5) dx -= 1; if (dx < -.5) dx += 1;
          if (dy > .5) dy -= 1; if (dy < -.5) dy += 1;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
        out[y * res + x] = Math.min(1, Math.sqrt(best) * cells);
      }
    }
    if (opts.invert) for (let i = 0; i < out.length; i++) out[i] = 1 - out[i];
    return out;
  }

  /* --------------------------------------------------- height -> normal --- */
  /* Sobel on a tiling height field. strength ~1 is subtle, ~4 is pronounced.
     Emits a Uint8ClampedArray RGBA suitable for putImageData. */
  function normalFromHeight(height, res, strength) {
    const s = strength === undefined ? 2 : strength;
    const out = new Uint8ClampedArray(res * res * 4);
    const at = (x, y) => height[(((y % res) + res) % res) * res + (((x % res) + res) % res)];
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        const l = at(x - 1, y), r = at(x + 1, y);
        const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        let nx = -dx * s, ny = -dy * s, nz = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const i = (y * res + x) * 4;
        out[i] = (nx * .5 + .5) * 255;
        out[i + 1] = (ny * .5 + .5) * 255;
        out[i + 2] = (nz * .5 + .5) * 255;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------- bakery ------ */
  function canvasOf(res) {
    const c = document.createElement('canvas'); c.width = c.height = res; return c;
  }
  /* Every bake does repeated getImageData on these canvases; without this hint
     Chrome keeps them GPU-backed and warns on each readback. */
  function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
  function texFromData(THREE, data, res, srgb) {
    const c = canvasOf(res), g = ctx2d(c);
    const id = g.createImageData(res, res);
    id.data.set(data); g.putImageData(id, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    /* r149: colour maps are sRGB, data maps (normal/rough/metal/ao) are linear */
    if (srgb) { if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding; }
    t.anisotropy = 8;
    return t;
  }
  /* Grey Float32Array -> single-channel-ish linear texture */
  function texFromScalar(THREE, arr, res, lo, hi) {
    lo = lo === undefined ? 0 : lo; hi = hi === undefined ? 1 : hi;
    const data = new Uint8ClampedArray(res * res * 4);
    for (let i = 0; i < arr.length; i++) {
      const v = clamp(lo + arr[i] * (hi - lo), 0, 1) * 255;
      const j = i * 4; data[j] = data[j + 1] = data[j + 2] = v; data[j + 3] = 255;
    }
    return texFromData(THREE, data, res, false);
  }

  /* bake(spec) -> { map, normalMap, roughnessMap, metalnessMap, aoMap, dispose() }
     spec = {
       res:        256,
       seed:       1,
       base:       '#3a4048' | [r,g,b] 0-255,
       paint:      fn(ctx, res, helpers)   optional freehand pass on the albedo
       height:     fn(res) -> Float32Array optional; defaults to fbm grain
       normalScale:2,
       rough:      { base:.55, variance:.28, map: Float32Array|fn }
       metal:      { base:.0,  variance:.1 }
       ao:         { strength:.6 }
       wear:       { amount:.35, colour:'#8d939c' }  edge-ish scuffing
     }
     Everything is optional. Sensible AAA-ish defaults for a painted metal. */
  function bake(spec) {
    const THREE = NZ.ctx.THREE || global.THREE;
    if (!THREE) throw new Error('nz-core: THREE not available yet');
    spec = spec || {};
    const res = spec.res || 256;
    const seed = spec.seed === undefined ? 1 : spec.seed;

    /* ---- height ---- */
    const height = typeof spec.height === 'function'
      ? spec.height(res)
      : fbm(res, { octaves: 6, frequency: 6, seed: seed, gain: .52 });

    /* ---- albedo ---- */
    const c = canvasOf(res), g = ctx2d(c);
    let base = spec.base || '#3d434b';
    if (Array.isArray(base)) base = 'rgb(' + base.map(v => Math.round(v)).join(',') + ')';
    g.fillStyle = base; g.fillRect(0, 0, res, res);

    /* grain modulates the base so it never reads as flat vinyl */
    const grainAmt = spec.grain === undefined ? .16 : spec.grain;
    if (grainAmt > 0) {
      const id = g.getImageData(0, 0, res, res), d = id.data;
      for (let i = 0; i < height.length; i++) {
        const n = (height[i] - .5) * 255 * grainAmt, j = i * 4;
        d[j] = clamp(d[j] + n, 0, 255);
        d[j + 1] = clamp(d[j + 1] + n, 0, 255);
        d[j + 2] = clamp(d[j + 2] + n, 0, 255);
      }
      g.putImageData(id, 0, 0);
    }

    /* wear: worley-driven scuff that lightens and de-saturates, like rubbed
       paint exposing primer. Applied before freehand so decals sit on top. */
    if (spec.wear && spec.wear.amount > 0) {
      const w = worley(res, { cells: spec.wear.cells || 10, seed: seed + 7, invert: true });
      const edge = fbm(res, { octaves: 4, frequency: 14, seed: seed + 13 });
      const id = g.getImageData(0, 0, res, res), d = id.data;
      const col = spec.wear.colour || '#9aa1ab';
      const cr = parseInt(col.slice(1, 3), 16), cg = parseInt(col.slice(3, 5), 16), cb = parseInt(col.slice(5, 7), 16);
      for (let i = 0; i < w.length; i++) {
        const m = clamp((w[i] * .65 + edge[i] * .35 - .62) * 3.2, 0, 1) * spec.wear.amount;
        if (m <= 0) continue;
        const j = i * 4;
        d[j] = lerp(d[j], cr, m); d[j + 1] = lerp(d[j + 1], cg, m); d[j + 2] = lerp(d[j + 2], cb, m);
      }
      g.putImageData(id, 0, 0);
    }

    if (typeof spec.paint === 'function') {
      spec.paint(g, res, { fbm, worley, height, lerp, clamp, TAU, rnd: mulberry32(seed + 91) });
    }

    const map = new THREE.CanvasTexture(c);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    if (THREE.SRGBColorSpace) map.colorSpace = THREE.SRGBColorSpace; else map.encoding = THREE.sRGBEncoding;
    map.anisotropy = 8;

    /* ---- normal ---- */
    const normalMap = texFromData(THREE, normalFromHeight(height, res, spec.normalScale === undefined ? 2 : spec.normalScale), res, false);

    /* ---- roughness ---- */
    const rs = spec.rough || {};
    const rBase = rs.base === undefined ? .55 : rs.base;
    const rVar = rs.variance === undefined ? .26 : rs.variance;
    let rArr;
    if (rs.map instanceof Float32Array) rArr = rs.map;
    else if (typeof rs.map === 'function') rArr = rs.map(res);
    else {
      rArr = fbm(res, { octaves: 4, frequency: 9, seed: seed + 31 });
      /* worn areas polish smoother -- a real, readable material cue */
      const w = worley(res, { cells: (spec.wear && spec.wear.cells) || 10, seed: seed + 7, invert: true });
      for (let i = 0; i < rArr.length; i++) rArr[i] = clamp(rArr[i] - w[i] * .35, 0, 1);
    }
    const rough = new Float32Array(rArr.length);
    for (let i = 0; i < rArr.length; i++) rough[i] = clamp(rBase + (rArr[i] - .5) * rVar * 2, .04, 1);
    const roughnessMap = texFromScalar(THREE, rough, res);

    /* ---- metalness ---- */
    const ms = spec.metal || {};
    const mBase = ms.base === undefined ? 0 : ms.base;
    let metalnessMap = null;
    if (mBase > 0 || ms.variance) {
      const mVar = ms.variance || 0;
      const mArr = new Float32Array(res * res);
      const n = mVar ? fbm(res, { octaves: 3, frequency: 7, seed: seed + 53 }) : null;
      for (let i = 0; i < mArr.length; i++) mArr[i] = clamp(mBase + (n ? (n[i] - .5) * mVar * 2 : 0), 0, 1);
      metalnessMap = texFromScalar(THREE, mArr, res);
    }

    /* ---- ao ---- */
    /* Cavity AO derived from the height field: low areas occlude. Cheap, and
       it is what gives procedural surfaces their sense of depth. */
    const aoStrength = (spec.ao && spec.ao.strength) === undefined ? .55 : spec.ao.strength;
    let aoMap = null;
    if (aoStrength > 0) {
      const blur = new Float32Array(height.length);
      const R = Math.max(1, Math.round(res / 64));
      for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        let sum = 0, n = 0;
        for (let oy = -R; oy <= R; oy += 1) for (let ox = -R; ox <= R; ox += 1) {
          sum += height[(((y + oy) % res + res) % res) * res + (((x + ox) % res + res) % res)]; n++;
        }
        blur[y * res + x] = sum / n;
      }
      const ao = new Float32Array(height.length);
      for (let i = 0; i < ao.length; i++) ao[i] = clamp(1 - Math.max(0, blur[i] - height[i]) * 6 * aoStrength, 0, 1);
      aoMap = texFromScalar(THREE, ao, res);
    }

    const set = { map, normalMap, roughnessMap, metalnessMap, aoMap, canvas: c, height: height, res: res };
    set.dispose = function () {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'])
        if (set[k]) set[k].dispose();
    };
    return set;
  }

  /* Apply a baked set to a MeshStandard/PhysicalMaterial parameter object. */
  function applySet(params, set, repeat) {
    if (!set) return params;
    params.map = set.map;
    params.normalMap = set.normalMap;
    params.roughnessMap = set.roughnessMap;
    if (set.metalnessMap) params.metalnessMap = set.metalnessMap;
    if (set.aoMap) params.aoMap = set.aoMap;
    if (repeat) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'])
      if (params[k]) params[k].repeat.set(repeat[0], repeat[1]);
    return params;
  }

  NZ.tex = {
    fbm, worley, normalFromHeight, bake, applySet, mulberry32,
    texFromScalar, texFromData, canvasOf,
    /* shared cache so enemies and weapons do not each bake their own steel */
    cache: Object.create(null),
    shared: function (key, specFn) {
      return NZ.tex.cache[key] || (NZ.tex.cache[key] = bake(specFn()));
    }
  };

  NZ.log('core ready');
})(typeof window !== 'undefined' ? window : this);
