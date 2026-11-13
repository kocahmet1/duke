/* ===========================================================================
   NZ-FINALE -- Mission 3: BLACKSTAR reactor-citadel presentation.

   The grid owns collision, AI, lighting bake and progression. This module is
   deliberately presentation-only: it fills the sealed reactor void with a
   moving set piece, adds code-native navigation light and industrial detail,
   and gives the compact finale its own colour script. Removing the file leaves
   a completely playable level with the stock world meshes.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;
  if (NZ.flags && NZ.flags.finale === undefined) NZ.flags.finale = false;

  var THREE = null, scene = null, ROOT = null;
  var RINGS = [], ROTORS = [], PULSES = [], LIGHTS = [];
  var PARTICLES = null, PARTICLE_POS = null, PARTICLE_SEED = null;
  var dead = false, installed = false, time = 0;
  var PI = Math.PI, TAU = PI * 2;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fract(v) { return v - Math.floor(v); }
  function hash(n) { return fract(Math.sin(n * 127.1 + 311.7) * 43758.5453123); }

  function material(name, color, roughness, metalness, emissive, ei, transparent, opacity) {
    var m = new THREE.MeshStandardMaterial({
      name: 'nzfinale:' + name,
      color: color,
      roughness: roughness,
      metalness: metalness,
      emissive: emissive || 0x000000,
      emissiveIntensity: ei || 0,
      transparent: !!transparent,
      opacity: opacity === undefined ? 1 : opacity,
      depthWrite: transparent ? false : true
    });
    return m;
  }

  function mesh(geo, mat, name, x, y, z) {
    var m = new THREE.Mesh(geo, mat);
    m.name = 'nzfinale-' + name;
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = !mat.transparent;
    m.receiveShadow = !mat.transparent;
    ROOT.add(m);
    return m;
  }

  function box(mat, name, x, y, z, sx, sy, sz) {
    return mesh(new THREE.BoxGeometry(sx, sy, sz), mat, name, x, y, z);
  }

  function beamBetween(a, b, radius, mat, name, sides) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    var len = Math.hypot(dx, dy, dz);
    var m = mesh(new THREE.CylinderGeometry(radius, radius, len, sides || 10, 1, false), mat,
      name, (a[0] + b[0]) * .5, (a[1] + b[1]) * .5, (a[2] + b[2]) * .5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
    return m;
  }

  function makeCore(M) {
    var cx = 130, cz = 124;

    /* The void is solid to gameplay but opened on four visual faces by the
       map's directional aperture regions. A broad base catches the opening
       even at crouch height; the narrow core preserves sight around it. */
    mesh(new THREE.CylinderGeometry(15.5, 17.2, 1.1, 32), M.black, 'core-plinth', cx, .15, cz);
    mesh(new THREE.CylinderGeometry(13.8, 13.8, .16, 48), M.redGlass, 'core-plinth-glow', cx, .76, cz);
    mesh(new THREE.CylinderGeometry(4.5, 5.8, 25, 24), M.black, 'core-spine', cx, 13.0, cz);
    var plasma = mesh(new THREE.CylinderGeometry(3.55, 3.55, 24, 32, 1, true), M.plasma,
      'plasma-column', cx, 13.2, cz);
    PULSES.push({ mesh: plasma, base: 1.65, amp: .75, speed: 2.7, phase: 0 });

    /* Counter-rotating containment rings establish scale from every balcony. */
    for (var i = 0; i < 5; i++) {
      var ring = mesh(new THREE.TorusGeometry(7.0 + (i % 2) * 1.2, .28, 8, 40),
        i === 2 ? M.redGlow : M.cyanGlow, 'containment-ring-' + i, cx, 4.2 + i * 4.5, cz);
      ring.rotation.x = PI * .5;
      ring.rotation.y = (i & 1) ? .22 : -.18;
      RINGS.push({ mesh: ring, speed: (i & 1 ? -1 : 1) * (.23 + i * .035), phase: i * .8 });
    }

    /* Eight structural vanes frame the reactor without closing the apertures. */
    for (var n = 0; n < 8; n++) {
      var a = n * TAU / 8, r = 11.7;
      var x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r;
      beamBetween([x, 1, z], [cx + Math.sin(a) * 7.3, 27, cz + Math.cos(a) * 7.3],
        .42, M.steel, 'core-vane-' + n, 8);
      var node = mesh(new THREE.OctahedronGeometry(.72, 0), n & 1 ? M.redGlow : M.cyanGlow,
        'core-node-' + n, cx + Math.sin(a) * 8.15, 21.5, cz + Math.cos(a) * 8.15);
      ROTORS.push({ mesh: node, speed: .35 + n * .025, axis: n & 1 });
    }

    /* Helical energy traces read as a controlled catastrophe rather than a
       decorative neon cylinder. Additive blending lets them survive fog. */
    for (var h = 0; h < 3; h++) {
      var points = [];
      for (var q = 0; q <= 96; q++) {
        var t = q / 96, ang = t * TAU * (2.5 + h * .35) + h * 2.1;
        points.push(new THREE.Vector3(cx + Math.cos(ang) * (4.7 + h * .55),
          2.0 + t * 23.0, cz + Math.sin(ang) * (4.7 + h * .55)));
      }
      var lg = new THREE.BufferGeometry().setFromPoints(points);
      var lm = new THREE.LineBasicMaterial({
        color: h === 1 ? 0xff361d : 0x55e8ff,
        transparent: true, opacity: .56, blending: THREE.AdditiveBlending, depthWrite: false
      });
      var line = new THREE.Line(lg, lm);
      line.name = 'nzfinale-core-arc-' + h;
      ROOT.add(line);
      RINGS.push({ mesh: line, speed: (h === 1 ? -.18 : .14) * (h + 1), phase: h });
    }

    /* Rising motes sell the volume without allocating or sorting sprites. */
    var count = 120;
    PARTICLE_POS = new Float32Array(count * 3);
    PARTICLE_SEED = new Float32Array(count * 4);
    for (var p = 0; p < count; p++) {
      PARTICLE_SEED[p * 4] = hash(p * 4 + 1);
      PARTICLE_SEED[p * 4 + 1] = hash(p * 4 + 2);
      PARTICLE_SEED[p * 4 + 2] = hash(p * 4 + 3);
      PARTICLE_SEED[p * 4 + 3] = hash(p * 4 + 4);
    }
    var pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(PARTICLE_POS, 3));
    var pm = new THREE.PointsMaterial({
      color: 0x8ff5ff, size: .22, transparent: true, opacity: .72,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    PARTICLES = new THREE.Points(pg, pm);
    PARTICLES.name = 'nzfinale-core-motes';
    ROOT.add(PARTICLES);

    var c1 = new THREE.PointLight(0x33dfff, 3.2, 65, 2);
    var c2 = new THREE.PointLight(0xff2918, 2.4, 52, 2);
    c1.position.set(cx, 13, cz); c2.position.set(cx, 5, cz);
    c1.castShadow = c2.castShadow = false;
    ROOT.add(c1, c2);
    LIGHTS.push({ light: c1, base: 3.2, amp: .62, speed: 2.1, phase: 0 });
    LIGHTS.push({ light: c2, base: 2.4, amp: .48, speed: 3.7, phase: 1.4 });
  }

  function strip(M, name, x, y, z, sx, sz, red) {
    var s = box(red ? M.redGlow : M.cyanGlow, name, x, y + .045, z, sx, .07, sz);
    s.castShadow = false; s.receiveShadow = false;
    PULSES.push({ mesh: s, base: red ? 2.1 : 1.65, amp: .32, speed: red ? 3.4 : 2.0,
      phase: x * .013 + z * .019 });
    return s;
  }

  function makeGuides(M) {
    /* Route language: cyan leads to ascent, red marks reactor/turbine danger,
       and amber owns command. Strips are thin overlays, never collision. */
    strip(M, 'breach-guide-a', 124, 0, 178, 12, .34, false);
    strip(M, 'breach-guide-b', 108, 0, 166, 16, .34, false);
    strip(M, 'coolant-guide', 38, 0, 142, 20, .28, false);
    strip(M, 'ring-guide-south', 130, 0, 146, 26, .32, true);
    strip(M, 'turbine-guide', 214, 0, 132, 25, .30, true);
    strip(M, 'lift-guide', 164, 0, 91, 10, .30, false);
    strip(M, 'conduit-guide-west', 82, 8, 78, 26, .26, false);
    strip(M, 'bridge-guide', 136, 8, 73, 35, .25, true);
    strip(M, 'conduit-guide-east', 160, 8, 47, 22, .26, false);
    strip(M, 'command-guide', 150, 16, 22, 66, .28, true);
    strip(M, 'vault-guide', 48, 16, 22, 26, .30, false);

    /* Lift jambs and command threshold are permanent visual landmarks. */
    for (var i = 0; i < 4; i++) {
      var x = i < 2 ? 159.7 : 172.3, z = i % 2 ? 80.3 : 91.7;
      box(M.steel, 'lift-jamb-' + i, x, 7, z, .45, 14, .45);
      var lamp = mesh(new THREE.SphereGeometry(.24, 8, 6), M.cyanGlow,
        'lift-jamb-lamp-' + i, x, 12.8, z);
      PULSES.push({ mesh: lamp, base: 1.8, amp: .6, speed: 2.8, phase: i * .8 });
    }
    box(M.black, 'command-header', 214, 27, 34, 8.2, 1.0, .7);
    strip(M, 'command-header-light', 214, 27, 33.6, 6.8, .12, true);
  }

  function canvasPanel(title, sub, accent) {
    var c = document.createElement('canvas'); c.width = 512; c.height = 160;
    var g = c.getContext('2d');
    g.fillStyle = '#071014'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = accent; g.lineWidth = 8; g.strokeRect(5, 5, c.width - 10, c.height - 10);
    g.fillStyle = accent; g.fillRect(22, 24, 10, 112);
    g.font = '900 58px Arial Black, sans-serif'; g.fillText(title, 52, 78);
    g.font = '700 24px monospace'; g.fillStyle = '#c5d8de'; g.fillText(sub, 54, 119);
    g.fillStyle = accent; g.fillRect(54, 132, 420, 4);
    var tx = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) tx.encoding = THREE.sRGBEncoding;
    tx.minFilter = THREE.LinearMipmapLinearFilter; tx.magFilter = THREE.LinearFilter;
    var mat = new THREE.MeshBasicMaterial({ map: tx, transparent: false, toneMapped: false });
    var panel = new THREE.Mesh(new THREE.PlaneGeometry(10.2, 3.18), mat);
    panel.name = 'nzfinale-sign-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    ROOT.add(panel);
    return panel;
  }

  function makeSigns() {
    var s = canvasPanel('BLACKSTAR', 'REACTOR CITADEL // ZERO HOUR', '#50e8ff');
    s.position.set(128, 7.2, 167.9);             /* breach north wall, faces spawn */

    s = canvasPanel('COOLANT', 'WEST LOOP // AUXILIARY ASCENT', '#50e8ff');
    s.position.set(66.1, 6.4, 128); s.rotation.y = PI * .5;

    s = canvasPanel('TURBINE', 'EAST LOOP // CORE LIFT', '#ff4a2d');
    s.position.set(193.9, 7.0, 128); s.rotation.y = -PI * .5;

    s = canvasPanel('COMMAND', 'KEYCARD AUTHORIZATION REQUIRED', '#ff9a3d');
    s.position.set(211.9, 23.4, 34); s.rotation.y = -PI * .5;

    s = canvasPanel('SHUTDOWN', 'BLACKSTAR TERMINATION CONTROL', '#60ff8c');
    s.position.set(68.1, 23.5, 22); s.rotation.y = PI * .5;
  }

  function makeIndustry(M) {
    /* Coolant pipes, turbine bus bars and bridge hangers add an authored
       silhouette without spending draw calls on unique materials. */
    for (var i = 0; i < 4; i++) {
      var z = 91 + i * 18;
      beamBetween([29, 9.7, z], [62, 9.7, z], .34, M.pipeBlue, 'coolant-pipe-' + i, 10);
      beamBetween([198, 12.7, z], [231, 12.7, z], .38, M.pipeRed, 'turbine-bus-' + i, 10);
    }
    for (var h = 0; h < 6; h++) {
      var x = 116 + h * 8;
      beamBetween([x, 10.2, 69], [x, 22.5, 69], .22, M.steel, 'bridge-hanger-' + h, 8);
      box(M.black, 'bridge-cap-' + h, x, 22.4, 69, 2.2, .38, 1.1);
    }
    for (var b = 0; b < 5; b++) {
      var bx = 84 + b * 27;
      box(M.steel, 'command-rib-' + b, bx, 31.8, 18, .55, 3.5, 14);
      box(M.black, 'command-rib-cap-' + b, bx, 33.3, 18, 2.0, .35, 15);
    }
  }

  function updateParticles(t) {
    if (!PARTICLES || !PARTICLE_POS) return;
    var n = PARTICLE_POS.length / 3;
    for (var i = 0; i < n; i++) {
      var a = PARTICLE_SEED[i * 4] * TAU + t * (.12 + PARTICLE_SEED[i * 4 + 1] * .2);
      var r = 2.8 + PARTICLE_SEED[i * 4 + 2] * 7.5;
      var y = fract(PARTICLE_SEED[i * 4 + 3] + t * (.035 + PARTICLE_SEED[i * 4 + 1] * .055)) * 27;
      PARTICLE_POS[i * 3] = 130 + Math.sin(a) * r;
      PARTICLE_POS[i * 3 + 1] = 1 + y;
      PARTICLE_POS[i * 3 + 2] = 124 + Math.cos(a) * r;
    }
    PARTICLES.geometry.attributes.position.needsUpdate = true;
  }

  function tick(dt) {
    if (dead || !installed || !ROOT) return undefined;
    time += Math.min(.05, Math.max(0, dt || 0));
    for (var i = 0; i < RINGS.length; i++) RINGS[i].mesh.rotation.y = RINGS[i].phase + time * RINGS[i].speed;
    for (var r = 0; r < ROTORS.length; r++) {
      ROTORS[r].mesh.rotation.x += dt * ROTORS[r].speed;
      ROTORS[r].mesh.rotation.y += dt * ROTORS[r].speed * (ROTORS[r].axis ? -1.4 : 1.2);
    }
    for (var p = 0; p < PULSES.length; p++) {
      var mat = PULSES[p].mesh.material;
      if (mat && mat.emissiveIntensity !== undefined)
        mat.emissiveIntensity = PULSES[p].base + Math.sin(time * PULSES[p].speed + PULSES[p].phase) * PULSES[p].amp;
    }
    for (var l = 0; l < LIGHTS.length; l++)
      LIGHTS[l].light.intensity = LIGHTS[l].base + Math.sin(time * LIGHTS[l].speed + LIGHTS[l].phase) * LIGHTS[l].amp;
    updateParticles(time);
    return undefined;
  }

  function disposeObject(o) {
    if (!o) return;
    o.traverse(function (n) {
      if (n.geometry && n.geometry.dispose) n.geometry.dispose();
      if (n.material) {
        var ms = Array.isArray(n.material) ? n.material : [n.material];
        for (var i = 0; i < ms.length; i++) {
          if (ms[i].map && ms[i].map.dispose) ms[i].map.dispose();
          if (ms[i].dispose) ms[i].dispose();
        }
      }
    });
    if (o.parent) o.parent.remove(o);
  }

  function panic(err) {
    dead = true; installed = false;
    if (err) try { console.error('[nz-finale] install failed:', err); } catch (e) {}
    disposeObject(ROOT); ROOT = null;
    if (NZ.flags) NZ.flags.finale = false;
  }

  function install(ctx) {
    if (installed || dead) return;
    var lvl = NZ.level === undefined || NZ.level === null ? 1 : NZ.level;
    if (lvl !== 3) { NZ.log && NZ.log('finale: level ' + lvl + ', module inert'); return; }
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
    if (!THREE || !scene) throw new Error('renderer context unavailable');

    ROOT = new THREE.Group(); ROOT.name = 'nzfinale-blackstar-root'; scene.add(ROOT);
    var M = {
      steel: material('steel', 0x26333b, .32, .86),
      black: material('black-ceramic', 0x06090c, .20, .82),
      pipeBlue: material('coolant-pipe', 0x1f5368, .28, .74),
      pipeRed: material('turbine-bus', 0x6a211a, .30, .72),
      cyanGlow: material('cyan-emitter', 0x43d9ec, .20, .55, 0x20cbe8, 1.7),
      redGlow: material('red-emitter', 0xff4126, .20, .55, 0xff1c0b, 2.1),
      plasma: material('core-plasma', 0xbdfaff, .08, .12, 0x35dcff, 1.65, true, .54),
      redGlass: material('core-warning-glass', 0xff3a21, .12, .25, 0xff1709, 1.85, true, .68)
    };

    makeCore(M);
    makeGuides(M);
    makeSigns();
    makeIndustry(M);

    /* Grade only this mission. The shared render module still owns exposure,
       tone mapping and post; these values establish the blue-black/red base. */
    if (scene.background && scene.background.set) scene.background.set(0x02080d);
    if (scene.fog && scene.fog.color && scene.fog.color.set) {
      scene.fog.color.set(0x07131a);
      scene.fog.near = 42; scene.fog.far = 260;
    }

    updateParticles(0);
    NZ.on('render', tick, 35);
    installed = true;
    if (NZ.flags) NZ.flags.finale = true;
    NZ.finale = { root: ROOT, dispose: function () { panic(null); } };
    NZ.log && NZ.log('finale: BLACKSTAR reactor presentation installed');
  }

  /* After nz-env's world-material pass, before the renderer's final sweep. */
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); } catch (err) { panic(err); }
  }, -60);

  NZ.log && NZ.log('finale module loaded');
})(typeof window !== 'undefined' ? window : this);
