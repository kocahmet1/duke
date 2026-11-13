/* ===========================================================================
   NZ-SPIDER -- procedural mechanical supersoldier rig.

   A self-contained classic-script character module. It owns only the `spider`
   enemy kind and deliberately leaves every biped hook untouched. Geometry and
   materials are shared across actors; each spawn receives only its transform
   hierarchy and animation state.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;

  var THREE = null;
  var ASSETS = null;
  var INSTALLED = false;
  var RIGS = [];
  var PI = Math.PI, TAU = PI * 2;
  /* Authored at the enemy's full 12.8-unit stature. Keeping this native scale
     makes the long, wide leg span honest; the enemy's enlarged navigation and
     hit footprints decide which Crucible passages can actually admit it. */
  var MODEL_H = 12.8;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function fract(v) { return v - Math.floor(v); }
  function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function finite(v, fallback) { return Number.isFinite(v) ? v : fallback; }
  function damp(a, b, rate, dt) { return b + (a - b) * Math.pow(rate, dt); }

  /* The biped module expands the stock rig radius so it can run its own
     instanced LOD. This independent rig is intentionally outside that pool,
     so it hands distant actors back to the already-authored Canvas2D sheet.
     Hysteresis prevents a robot on the threshold flickering between paths. */
  function nearEnough(e, rig) {
    var cam = NZ.ctx && NZ.ctx.camera;
    if (!cam || !cam.position) return true;
    var quality = NZ.render && NZ.render.quality || 'high';
    var maxNear = quality === 'ultra' || quality === 'high' ? 2 : 1;
    var out = quality === 'low' ? 40 : quality === 'med' ? 48 : 64;
    var limit = rig.state.near === false ? out - 8 : out;
    var dx = finite(e.x, 0) - cam.position.x;
    var dy = finite(e.y, 0) - cam.position.y;
    var dz = finite(e.z, 0) - cam.position.z;
    var d2 = dx * dx + dz * dz + dy * dy * 0.30;
    var near = d2 < limit * limit;

    /* The rig is deliberately detailed, so at most the nearest two machines
       own the full hierarchy (one on medium/low). Ranking here is deterministic
       and independent of enemy update order; the rest retain the authored
       billboard, laser tell and hit volume. */
    if (near) {
      var ranked = [];
      for (var i = 0; i < RIGS.length; i++) {
        var rr = RIGS[i], owner = rr && rr.owner;
        if (!owner || owner.rig !== rr || !rr.state || rr.state.failed) continue;
        var rx = finite(owner.x, 0) - cam.position.x;
        var ry = finite(owner.y, 0) - cam.position.y;
        var rz = finite(owner.z, 0) - cam.position.z;
        ranked.push({ rig: rr, d2: rx * rx + rz * rz + ry * ry * 0.30 });
      }
      ranked.sort(function (a, b) {
        return a.d2 - b.d2 || a.rig.state.order - b.rig.state.order;
      });
      var rank = -1;
      for (var n = 0; n < ranked.length; n++) if (ranked[n].rig === rig) { rank = n; break; }
      near = rank >= 0 && rank < maxNear;
    }
    rig.state.near = near;
    return near;
  }

  function presentPath(e, rig, near, dead) {
    var scene = NZ.ctx && NZ.ctx.scene;
    if (scene) {
      if (near && rig.root.parent !== scene) scene.add(rig.root);
      else if (!near && rig.root.parent === scene) scene.remove(rig.root);
    }
    rig.root.visible = near;
    rig.spriteLod = !near;
    if (e.mesh) e.mesh.visible = !near;
    if (e.glow) e.glow.visible = !near && !dead;
  }

  function updateMuzzle(rig, ready) {
    /* Updating the muzzle's ancestor chain avoids walking all eight hidden leg
       hierarchies just to keep a distant laser origin current. */
    rig.muzzle.updateWorldMatrix(true, false);
    rig.muzzleWorld.setFromMatrixPosition(rig.muzzle.matrixWorld);
    rig.muzzleReady = ready;
  }

  function failToSprite(e, rig, dead, err) {
    var first = !rig.state || !rig.state.failed;
    if (rig.state) rig.state.failed = true;
    rig.failed = true;
    rig.spriteLod = true;
    var scene = NZ.ctx && NZ.ctx.scene;
    if (scene && rig.root.parent === scene) scene.remove(rig.root);
    rig.root.visible = false;
    if (e.mesh) e.mesh.visible = true;
    if (e.glow) e.glow.visible = !dead;
    rig.muzzleReady = false;
    if (first && NZ.log) NZ.log('spider rig fell back to sprite:', err && err.message ? err.message : err);
    return true;
  }

  function makeMaterial(color, roughness, metalness, emissive, intensity) {
    return new THREE.MeshStandardMaterial({
      color: color,
      roughness: roughness,
      metalness: metalness,
      emissive: emissive || 0x000000,
      emissiveIntensity: intensity || 0,
      dithering: true,
      fog: true
    });
  }

  function assets() {
    if (ASSETS) return ASSETS;

    /* Unit primitives are scaled per part. Keeping their tessellation modest
       preserves the hard mechanical silhouette and makes eight legs cheap. */
    var geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      hull: new THREE.SphereGeometry(1, 16, 10),
      joint: new THREE.SphereGeometry(1, 10, 7),
      cyl8: new THREE.CylinderGeometry(1, 1, 1, 8, 1, false),
      cyl12: new THREE.CylinderGeometry(1, 1, 1, 12, 1, false),
      cone: new THREE.ConeGeometry(1, 1, 8, 1, false),
      ring: new THREE.TorusGeometry(1, 0.18, 6, 14)
    };

    /* Value, edge response and roughness separate the surfaces. The cyan is
       restricted to the sensor, reactor slit and bore so the machine remains
       a dark tactical silhouette rather than a neon prop. */
    var mat = {
      gunmetal: makeMaterial(0x171d21, 0.54, 0.84),
      armor: makeMaterial(0x252d32, 0.43, 0.78),
      worn: makeMaterial(0x465158, 0.35, 0.90),
      black: makeMaterial(0x070b0d, 0.67, 0.58),
      joint: makeMaterial(0x10171b, 0.38, 0.88),
      piston: makeMaterial(0x69747a, 0.25, 0.94),
      brass: makeMaterial(0x5f512d, 0.49, 0.72),
      cyan: makeMaterial(0x06252c, 0.20, 0.38, 0x00d9ff, 3.2),
      cyanHot: makeMaterial(0x8eefff, 0.14, 0.18, 0x22e8ff, 4.5)
    };

    ASSETS = { geo: geo, mat: mat };
    return ASSETS;
  }

  function group(parent, name, x, y, z) {
    var g = new THREE.Group();
    g.name = name;
    g.position.set(x || 0, y || 0, z || 0);
    parent.add(g);
    return g;
  }

  function part(parent, geometry, material, name, pos, scale, rot) {
    var m = new THREE.Mesh(geometry, material);
    m.name = name;
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    if (scale) m.scale.set(scale[0], scale[1], scale[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    /* Only silhouette-bearing pieces enter the directional shadow pass. Tiny
       washers, emitters and pistons still receive light but do not each cost a
       separate shadow draw. */
    m.castShadow = /strut|upper-armor|shin-guard|foot-pad|central-hull|belly-pan|top-plate|flank-plate|turret-shell|receiver|barrel|shroud/.test(name);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function addRivet(parent, x, y, z, s) {
    var A = assets();
    return part(parent, A.geo.joint, A.mat.worn, 'armor-rivet',
      [x, y, z], [s, s, s]);
  }

  function buildLeg(root, side, row) {
    var A = assets();
    var mountX = side * 1.10;
    var zMount = [1.55, 0.52, -0.52, -1.55][row];
    var restX = side * [3.65, 4.15, 4.15, 3.65][row];
    var restZ = [3.65, 1.28, -1.28, -3.65][row];
    var dx = restX - mountX, dz = restZ - zMount;
    var dl = Math.sqrt(dx * dx + dz * dz);
    dx /= dl; dz /= dl;

    /* Long femur-like upper links push the knees away from the chassis before
       the lower links drop to the floor. This is intentionally broader than
       the navigation hull: a Sentinel owns a room instead of squeezing into
       every human-width recess. */
    var mountY = 8.75;
    var upperLen = 4.00;
    var lowerLen = 7.25;
    var spread = 0.82;
    var baseYaw = Math.atan2(-dz, dx); /* local +X points along (dx,dz) */

    var yaw = group(root, 'leg-' + (side > 0 ? 'R' : 'L') + (row + 1),
      mountX, mountY, zMount);
    /* Keep the tall vertical silhouette while allowing a convincingly broad
       footprint. The old 0.36 scale was the main reason the legs clumped. */
    yaw.scale.set(spread, 1, spread);
    yaw.rotation.y = baseYaw;

    /* The hip bearing remains fixed while the two armoured struts articulate. */
    part(yaw, A.geo.cyl12, A.mat.joint, 'hip-bearing', [0, 0, 0],
      [0.90, 0.34, 0.38], [PI / 2, 0, 0]);
    var upper = group(yaw, 'upper-hinge', 0, 0, 0);
    upper.rotation.z = -0.35;
    part(upper, A.geo.cyl8, A.mat.gunmetal, 'upper-strut',
      [upperLen * 0.50, 0, 0], [0.28, upperLen, 0.28], [0, 0, -PI / 2]);
    part(upper, A.geo.box, A.mat.armor, 'upper-armor',
      [upperLen * 0.45, 0.13, 0], [1.48, 0.30, 0.64], [0, 0, -0.05]);

    var knee = group(upper, 'knee-hinge', upperLen, 0, 0);
    knee.rotation.z = -1.18;
    part(knee, A.geo.joint, A.mat.joint, 'knee-joint', [0, 0, 0],
      [0.78, 0.42, 0.78]);
    part(knee, A.geo.cyl8, A.mat.gunmetal, 'lower-strut',
      [lowerLen * 0.50, 0, 0], [0.22, lowerLen, 0.22], [0, 0, -PI / 2]);
    part(knee, A.geo.box, A.mat.armor, 'shin-guard',
      [lowerLen * 0.30, -0.02, 0], [1.55, 0.24, 0.52], [0, 0, 0.04]);

    var foot = group(knee, 'foot', lowerLen, 0, 0);
    foot.rotation.z = 1.47;
    part(foot, A.geo.box, A.mat.black, 'foot-pad', [0.18, -0.08, 0],
      [0.82, 0.22, 0.62], [0, 0, -0.04]);
    part(foot, A.geo.cone, A.mat.worn, 'toe-claw', [0.55, -0.10, 0],
      [0.17, 0.62, 0.17], [0, 0, -PI / 2]);

    return {
      side: side, row: row, parity: (row + (side > 0 ? 1 : 0)) & 1,
      mount: yaw, upper: upper, knee: knee, foot: foot,
      baseYaw: baseYaw, mountX: mountX, mountY: mountY, mountZ: zMount,
      restX: restX, restZ: restZ, upperLen: upperLen, lowerLen: lowerLen,
      spread: spread, upper0: -0.35, knee0: -1.18,
      anchorX: 0, anchorY: 0, anchorZ: 0,
      fromX: 0, fromY: 0, fromZ: 0,
      toX: 0, toY: 0, toZ: 0,
      liveX: 0, liveY: 0, liveZ: 0, swinging: false
    };
  }

  /* The game owns the collision grid, so it publishes a tiny read-only ground
     probe through NZ.ctx. A null result means wall, crate, shut door or void.
     The fallback keeps this module usable in the isolated rig viewer too. */
  function footY(r, x, z, fallback) {
    var probe = NZ.ctx && NZ.ctx.enemyFootGround;
    if (typeof probe !== 'function') return fallback;
    try {
      var y = probe(x, z);
      return Number.isFinite(y) ? y + 0.12 * r.unit : null;
    } catch (err) { return fallback; }
  }

  var CONTACT_SCALES = [1, 0.86, 0.72, 0.58, 0.44, 0.30, 0.18, 0];
  /* Convert one authored rest contact to world space. Root local +Z is the
     facing direction, matching the rest of the enemy rig pipeline. A proposed
     foothold that lands in geometry retracts toward the chassis until it finds
     real floor; navigation normally keeps the machine far enough away that the
     full-width first candidate wins. */
  function restContact(e, r, leg, face, leadX, leadZ) {
    var cf = Math.cos(face), sf = Math.sin(face), unit = r.unit;
    var lx = leg.restX * unit, lz = leg.restZ * unit;
    var ex = finite(e.x, 0), ez = finite(e.z, 0);
    var fallback = finite(e.y, 0) + 0.12 * unit;
    leadX = finite(leadX, 0); leadZ = finite(leadZ, 0);
    for (var i = 0; i < CONTACT_SCALES.length; i++) {
      var k = CONTACT_SCALES[i];
      var x = ex + (lx * cf + lz * sf + leadX) * k;
      var z = ez + (-lx * sf + lz * cf + leadZ) * k;
      var y = footY(r, x, z, fallback);
      if (y !== null) return { x: x, y: y, z: z };
    }
    /* A valid actor centre should always make the k=0 probe succeed. Fail
       closed at the centre if a host supplies a malformed terrain sampler. */
    return { x: ex, y: fallback, z: ez };
  }

  function resetFooting(e, r, face) {
    for (var i = 0; i < r.legs.length; i++) {
      var leg = r.legs[i], p = restContact(e, r, leg, face);
      leg.anchorX = leg.fromX = leg.toX = leg.liveX = p.x;
      leg.anchorY = leg.fromY = leg.toY = leg.liveY = p.y;
      leg.anchorZ = leg.fromZ = leg.toZ = leg.liveZ = p.z;
      leg.swinging = false;
    }
    r.state.feetReady = true;
  }

  /* Two-link analytic IK in the leg's yaw plane. The yaw node scales only the
     ground plane, so horizontal reach is unscaled before solving. */
  function solveLeg(leg, tx, ty, tz, toeRoll) {
    var dx = tx - leg.mountX, dz = tz - leg.mountZ;
    var planar = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
    leg.mount.position.set(leg.mountX, leg.mountY, leg.mountZ);
    leg.mount.rotation.y = Math.atan2(-dz, dx);

    var px = planar / leg.spread;
    var py = ty - leg.mountY;
    var lo = Math.abs(leg.lowerLen - leg.upperLen) + 0.02;
    var hi = leg.lowerLen + leg.upperLen - 0.02;
    var reach = Math.sqrt(px * px + py * py);
    if (reach < lo || reach > hi) {
      var limited = clamp(reach, lo, hi) / Math.max(reach, 0.001);
      px *= limited; py *= limited;
    }

    var cosKnee = clamp((px * px + py * py - leg.upperLen * leg.upperLen -
      leg.lowerLen * leg.lowerLen) / (2 * leg.upperLen * leg.lowerLen), -1, 1);
    var knee = -Math.acos(cosKnee);
    var upper = Math.atan2(py, px) - Math.atan2(leg.lowerLen * Math.sin(knee),
      leg.upperLen + leg.lowerLen * Math.cos(knee));

    leg.upper.rotation.z = upper;
    leg.knee.rotation.z = knee;
    leg.foot.rotation.z = -(upper + knee);
    leg.foot.rotation.x = toeRoll || 0;
  }

  function buildSpider(e) {
    if (!THREE || !NZ.ctx || !NZ.ctx.scene) return undefined;
    var A = assets();
    var root = new THREE.Group();
    root.name = 'nz-enemy-spider';
    root.rotation.order = 'YXZ';
    root.visible = false;

    var h = e && e.cfg ? finite(e.cfg.h, MODEL_H) : MODEL_H;
    var unit = h / MODEL_H;
    root.scale.setScalar(unit);
    NZ.ctx.scene.add(root);

    var body = group(root, 'spider-chassis', 0, 0, 0);

    /* The hip deck carries both the head and all eight leg bearings. Forked
       suspension spars descend from it to an abdomen that visibly hangs two
       metres below, reversing the old body-on-legs hierarchy. */
    part(body, A.geo.cyl12, A.mat.worn, 'hip-deck', [0, 8.55, 0],
      [1.46, 0.28, 1.72]);
    for (var fork = -1; fork <= 1; fork += 2) {
      part(body, A.geo.box, A.mat.piston, 'suspension-strut',
        [fork * 0.88, 7.95, 0], [0.18, 1.48, 0.24], [0, 0, fork * 0.13]);
    }
    part(body, A.geo.hull, A.mat.gunmetal, 'central-hull', [0, 6.25, 0],
      [1.32, 1.60, 1.62]);
    part(body, A.geo.cyl12, A.mat.black, 'belly-pan', [0, 4.75, 0],
      [1.02, 0.65, 1.02]);
    part(body, A.geo.box, A.mat.armor, 'top-plate', [0, 7.78, -0.03],
      [1.48, 0.22, 1.64], [0.03, 0, 0]);
    part(body, A.geo.box, A.mat.worn, 'top-wear-strip', [0, 7.92, 0.14],
      [0.94, 0.045, 1.20]);
    part(body, A.geo.box, A.mat.armor, 'left-flank-plate', [-1.14, 6.25, 0],
      [0.18, 1.72, 1.22], [0, 0, 0.12]);
    part(body, A.geo.box, A.mat.armor, 'right-flank-plate', [1.14, 6.25, 0],
      [0.18, 1.72, 1.22], [0, 0, -0.12]);

    /* Rear reactor slot is the only body emissive away from the sensor. */
    var core = part(body, A.geo.box, A.mat.cyan, 'reactor-core', [0, 6.32, -1.57],
      [0.62, 0.20, 0.055]);
    part(body, A.geo.box, A.mat.black, 'reactor-guard-L', [-0.52, 6.32, -1.61],
      [0.18, 0.38, 0.09]);
    part(body, A.geo.box, A.mat.black, 'reactor-guard-R', [0.52, 6.32, -1.61],
      [0.18, 0.38, 0.09]);
    for (var rv = -1; rv <= 1; rv++) addRivet(body, rv * 0.62, 7.83, 0.68, 0.07);

    /* Independent armored turret. Local +Z is the firing direction. */
    var turret = group(body, 'turret-yaw', 0, 8.82, 0.18);
    part(turret, A.geo.cyl12, A.mat.joint, 'turret-bearing', [0, 0, 0],
      [0.82, 0.34, 0.82]);
    part(turret, A.geo.hull, A.mat.armor, 'turret-shell', [0, 1.12, 0.02],
      [1.04, 1.08, 1.08]);
    part(turret, A.geo.box, A.mat.worn, 'turret-brow', [0, 1.15, 0.90],
      [1.16, 0.20, 0.22], [-0.08, 0, 0]);

    /* Thirteen independently modelled optics turn the face into an insectile
       sensor cluster. Instancing keeps the intimidation to a single draw. */
    part(turret, A.geo.box, A.mat.black, 'sensor-mask', [0, 1.22, 1.02],
      [1.62, 0.76, 0.12]);
    var eyeData = [
      [-0.45, 1.47, 0.060], [-0.15, 1.51, 0.075], [0.15, 1.51, 0.075], [0.45, 1.47, 0.060],
      [-0.60, 1.23, 0.055], [-0.30, 1.26, 0.080], [0, 1.27, 0.110], [0.30, 1.26, 0.080], [0.60, 1.23, 0.055],
      [-0.45, 1.00, 0.055], [-0.15, 0.98, 0.070], [0.15, 0.98, 0.070], [0.45, 1.00, 0.055]
    ];
    var eyes = new THREE.InstancedMesh(A.geo.joint, A.mat.cyanHot, eyeData.length);
    eyes.name = 'sensor-eye-cluster';
    eyes.castShadow = false;
    eyes.receiveShadow = false;
    eyes.userData.eyeCount = eyeData.length;
    /* Centre the InstancedMesh transform on the cluster. Its subtle breathing
       pulse then grows each eye, not the distance of the whole face from the
       turret pivot (which would make outer optics leave their weak-point). */
    eyes.position.set(0, 1.24, 1.11);
    var eyeDummy = new THREE.Object3D();
    for (var ei = 0; ei < eyeData.length; ei++) {
      eyeDummy.position.set(eyeData[ei][0], eyeData[ei][1] - 1.24, 0);
      eyeDummy.scale.set(eyeData[ei][2], eyeData[ei][2], 0.045);
      eyeDummy.updateMatrix();
      eyes.setMatrixAt(ei, eyeDummy.matrix);
    }
    eyes.instanceMatrix.needsUpdate = true;
    turret.add(eyes);

    /* Twin antennae lift the crown to the full two-soldier silhouette. */
    var masts = [];
    for (var mast = -1; mast <= 1; mast += 2) {
      var mastStem = part(turret, A.geo.cyl8, A.mat.worn, 'sensor-mast', [mast * 0.48, 2.75, -0.05],
        [0.055, 1.50, 0.055]);
      var mastCap = part(turret, A.geo.cone, A.mat.brass, 'mast-cap', [mast * 0.48, 3.58, -0.05],
        [0.12, 0.30, 0.12]);
      masts.push({ part: mastStem, y: 2.75, sy: 1.50 });
      masts.push({ part: mastCap, y: 3.58, sy: 0.30 });
    }

    var gun = group(turret, 'laser-pitch', 0, 0.78, 0.18);
    part(gun, A.geo.box, A.mat.gunmetal, 'laser-receiver', [0, 0, 0.38],
      [0.58, 0.42, 0.76]);
    part(gun, A.geo.box, A.mat.armor, 'receiver-top', [0, 0.27, 0.36],
      [0.39, 0.13, 0.62]);
    part(gun, A.geo.cyl12, A.mat.worn, 'laser-barrel', [0, 0, 1.13],
      [0.17, 1.02, 0.17], [PI / 2, 0, 0]);
    part(gun, A.geo.cyl8, A.mat.black, 'barrel-shroud', [0, 0, 0.92],
      [0.28, 0.58, 0.28], [PI / 2, 0, 0]);
    part(gun, A.geo.ring, A.mat.brass, 'focus-ring', [0, 0, 1.46],
      [0.25, 0.25, 0.25]);
    var bore = part(gun, A.geo.cyl12, A.mat.cyanHot, 'laser-bore', [0, 0, 1.59],
      [0.115, 0.07, 0.115], [PI / 2, 0, 0]);
    var muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0, 1.64);
    gun.add(muzzle);

    var legs = [];
    for (var row = 0; row < 4; row++) {
      legs.push(buildLeg(root, -1, row));
      legs.push(buildLeg(root, 1, row));
    }

    var rig = {
      root: root,
      muzzle: muzzle,
      muzzleWorld: new THREE.Vector3(),
      muzzleReady: false,
      spider: true,
      spiderModule: true,
      owner: e,
      unit: unit,
      body: body,
      turret: turret,
      gun: gun,
      legs: legs,
      masts: masts,
      eyes: eyes,
      glows: [eyes, core, bore],
      state: {
        lastNow: 0,
        lastX: finite(e && e.x, 0),
        lastZ: finite(e && e.z, 0),
        feetReady: false,
        turnPhase: 0,
        turretYaw: 0,
        turretPitch: 0,
        seed: finite(e && e.wander, 0),
        dead: false,
        near: true,
        failed: false,
        order: RIGS.length
      }
    };
    RIGS.push(rig);
    return rig;
  }

  function animateSpider(e, speed, now) {
    if (!e || e.kind !== 'spider') return undefined;
    var r = e.rig;
    if (!r || !r.spiderModule) return undefined;
    if (r.state.failed) return failToSprite(e, r, false, 'disabled after an earlier animation error');

    try {
      var st = r.state;
      var dt = st.lastNow ? clamp(now - st.lastNow, 0.001, 0.10) : 1 / 60;
      st.lastNow = now;
      st.dead = false;

      var rawGait = finite(e.gait, 0);
      var move = clamp(finite(e.speedSm, 0), 0, 1);
      var recoil = clamp(finite(e.recoilT, 0) / 0.15, 0, 1);
      var pain = clamp(finite(e.hitT, 0) / 0.24, 0, 1);
      var face = finite(e.face, 0);
      var turnRate = finite(e.turnV, 0);
      var aimWorld = finite(e.aimYaw, face);
      var aimPitch = clamp(finite(e.aimPitch, 0), -0.42, 0.48);
      var aimRel = clamp(wrap(aimWorld - face), -1.08, 1.08);

      st.turretYaw = damp(st.turretYaw, aimRel, 0.0025, dt);
      st.turretPitch = damp(st.turretPitch, aimPitch, 0.015, dt);

      var stepDX = finite(e.x, 0) - st.lastX;
      var stepDZ = finite(e.z, 0) - st.lastZ;
      var frameTravel = Math.sqrt(stepDX * stepDX + stepDZ * stepDZ);
      var teleported = frameTravel > Math.max(4.5, finite(e.cfg && e.cfg.stride, 7.10) * 0.72);
      var velX = frameTravel > 0.0001 ? stepDX / Math.max(dt, 0.001) : finite(e.vx, 0);
      var velZ = frameTravel > 0.0001 ? stepDZ / Math.max(dt, 0.001) : finite(e.vz, 0);
      var groundSpeed = Math.sqrt(velX * velX + velZ * velZ);
      var dirX = groundSpeed > 0.08 ? velX / groundSpeed : Math.sin(face);
      var dirZ = groundSpeed > 0.08 ? velZ / groundSpeed : Math.cos(face);
      var translating = move > 0.055 && groundSpeed > 0.12;
      var turnStepping = !translating && Math.abs(turnRate) > 0.035;
      /* Phase advances in proportion to angular travel. At this ratio a
         planted tetrad supports about half a radian of chassis rotation before
         the opposing feet take over, so a pivot never twists beyond reach. */
      if (turnStepping) st.turnPhase += Math.abs(turnRate) * dt * 1.15;
      if (st.turnPhase > 65536) st.turnPhase -= 65536;
      var gaitCycle = rawGait + st.turnPhase;
      var phase = gaitCycle * TAU;
      var walking = translating || turnStepping;
      var motionBlend = translating ? move : turnStepping ? clamp(Math.abs(turnRate) * 0.32, 0, 1) : 0;
      st.lastX = finite(e.x, 0);
      st.lastZ = finite(e.z, 0);

      var bob = Math.max(0, Math.sin(phase * 2)) * 0.075 * motionBlend;
      bob += Math.sin(now * 1.7 + st.seed) * (move < 0.08 ? 0.012 : 0.004);
      var turnLean = clamp(-turnRate * 0.010, -0.11, 0.11);
      var hitRoll = finite(e.hitLean, 0) * pain * 0.30;

      r.root.position.set(finite(e.x, 0), finite(e.y, 0), finite(e.z, 0));
      /* Keep the leg frame level so stance feet can truly remain planted.
         Locomotion lean belongs to the suspended chassis, not the floor. */
      r.root.rotation.set(0, face, 0);
      r.root.scale.setScalar(r.unit);
      r.body.position.set(0, bob, 0);
      r.body.rotation.set(-move * 0.018 + pain * 0.010, -st.turretYaw * 0.035,
        turnLean + finite(e.lean, 0) * 0.22 + hitRoll * 0.78);
      r.turret.position.set(0, 8.82, 0.18);
      r.turret.rotation.y = st.turretYaw;
      r.gun.rotation.x = -st.turretPitch + recoil * 0.10;
      r.gun.position.z = 0.18 - recoil * 0.16;
      for (var mi = 0; mi < r.masts.length; mi++) {
        var liveMast = r.masts[mi];
        liveMast.part.position.y = liveMast.y;
        liveMast.part.scale.y = liveMast.sy;
        liveMast.part.visible = true;
      }

      var near = nearEnough(e, r);
      presentPath(e, r, near, false);
      if (!near) {
        /* The billboard has no pitch animation, so its beam uses the analytic
           sprite-aligned muzzle instead of a hidden barrel that could drift a
           metre above or below the painted emitter on cross-storey shots. */
        r.muzzleReady = false;
        st.feetReady = false;
        return true;
      }

      if (!st.feetReady || teleported) resetFooting(e, r, face);

      /* Alternating tetrapods: L1/R2/L3/R4 oppose R1/L2/R3/L4. During stance
         each contact remains fixed in WORLD space while the chassis advances;
         during recovery the foot follows a high, eased arc to its next plant.
         This is the key visual difference between walking and rolling. */
      var duty = 0.58;
      var strideWorld = finite(e.cfg && e.cfg.stride, 7.10);
      var invUnit = 1 / Math.max(r.unit, 0.001);
      var cf = Math.cos(face), sf = Math.sin(face);
      for (var i = 0; i < r.legs.length; i++) {
        var leg = r.legs[i];
        var contact = restContact(e, r, leg, face);
        var cycle = fract(gaitCycle + leg.parity * 0.5 + (leg.row - 1.5) * 0.010);
        var swingNow = walking && cycle >= duty;
        var wx, wy, wz, swingU = 0;

        if (!walking) {
          /* A planted claw never follows the rotating rest pose: doing so makes
             all eight contacts skate together while the body appears to roll.
             Only the tetrad already in recovery may move, and it visibly
             finishes that interrupted step before becoming a fixed anchor. */
          if (leg.swinging) {
            wx = damp(leg.liveX, leg.toX, 0.0015, dt);
            wy = damp(leg.liveY, leg.toY, 0.0015, dt);
            wz = damp(leg.liveZ, leg.toZ, 0.0015, dt);
            if (Math.hypot(wx - leg.toX, wy - leg.toY, wz - leg.toZ) < 0.035 * r.unit) {
              leg.swinging = false;
              leg.anchorX = wx = leg.toX;
              leg.anchorY = wy = leg.toY;
              leg.anchorZ = wz = leg.toZ;
            }
          } else {
            wx = leg.anchorX; wy = leg.anchorY; wz = leg.anchorZ;
          }
        } else if (swingNow) {
          swingU = clamp((cycle - duty) / (1 - duty), 0, 1);
          if (!leg.swinging) {
            leg.swinging = true;
            leg.fromX = leg.anchorX; leg.fromY = leg.anchorY; leg.fromZ = leg.anchorZ;
            /* At liftoff, aim beyond the current chassis so touchdown begins
               ahead of the body. The following stance then spends that lead
               while its world-space contact remains stationary. */
            if (turnStepping) {
              var turnContact = restContact(e, r, leg,
                face + (turnRate < 0 ? -0.62 : 0.62));
              leg.toX = turnContact.x;
              leg.toY = turnContact.y;
              leg.toZ = turnContact.z;
            } else {
              var lead = strideWorld * (1 - duty * 0.5);
              var walkContact = restContact(e, r, leg, face, dirX * lead, dirZ * lead);
              leg.toX = walkContact.x;
              leg.toY = walkContact.y;
              leg.toZ = walkContact.z;
            }
          }
          var arc = smooth(swingU);
          wx = lerp(leg.fromX, leg.toX, arc);
          wz = lerp(leg.fromZ, leg.toZ, arc);
          wy = lerp(leg.fromY, leg.toY, arc) + Math.sin(PI * swingU) * 1.30 * r.unit;
        } else {
          if (leg.swinging) {
            leg.swinging = false;
            leg.anchorX = leg.toX; leg.anchorY = leg.toY; leg.anchorZ = leg.toZ;
          }
          wx = leg.anchorX; wy = leg.anchorY; wz = leg.anchorZ;
        }

        leg.liveX = wx; leg.liveY = wy; leg.liveZ = wz;
        var worldDX = wx - finite(e.x, 0), worldDZ = wz - finite(e.z, 0);
        var localX = (worldDX * cf - worldDZ * sf) * invUnit;
        var localZ = (worldDX * sf + worldDZ * cf) * invUnit;
        var localY = (wy - finite(e.y, 0)) * invUnit;
        solveLeg(leg, localX, localY, localZ,
          swingNow ? leg.side * Math.sin(PI * swingU) * 0.11 : 0);
      }

      /* A shared emissive material cannot be pulsed per actor; a sub-pixel
         scale pulse gives the emitter life without mutating cached assets. */
      var pulse = 1 + Math.sin(now * 9.5 + st.seed) * 0.035 + recoil * 0.22;
      var eyePulse = 1 + Math.sin(now * 9.5 + st.seed) * 0.035;
      r.glows[0].scale.setScalar(eyePulse);
      r.glows[1].scale.set(0.62 * pulse, 0.20 * pulse, 0.055 * pulse);
      r.glows[2].scale.set(0.115 * pulse, 0.07, 0.115 * pulse);
      for (var g = 0; g < r.glows.length; g++) r.glows[g].visible = true;

      updateMuzzle(r, true);
      void speed;
      return true;
    } catch (err) {
      return failToSprite(e, r, false, err);
    }
  }

  function animateSpiderDeath(e, t, fall) {
    if (!e || e.kind !== 'spider') return undefined;
    var r = e.rig;
    if (!r || !r.spiderModule) return undefined;
    if (r.state.failed) return failToSprite(e, r, true, 'disabled after an earlier animation error');

    try {
      var k = smooth(Math.max(finite(t, 0), finite(fall, 0)));
      var side = finite(e.deathSide, 1) < 0 ? -1 : 1;

      if (!r.state.dead) {
        for (var capture = 0; capture < r.legs.length; capture++) {
          r.legs[capture].deathUpper0 = r.legs[capture].upper.rotation.z;
          r.legs[capture].deathKnee0 = r.legs[capture].knee.rotation.z;
          r.legs[capture].deathYaw0 = r.legs[capture].mount.rotation.y;
          r.legs[capture].deathFootX0 = r.legs[capture].foot.rotation.x;
        }
      }
      r.state.dead = true;
      r.root.position.set(finite(e.x, 0), finite(e.y, 0), finite(e.z, 0));
      r.root.rotation.set(0, finite(e.face, 0), 0);
      r.root.scale.setScalar(r.unit);

      r.body.position.set(lerp(0, side * 1.40, k), lerp(0, -3.60, k), 0);
      r.body.rotation.set(lerp(0, 0.20, k), lerp(0, side * 0.10, k),
        lerp(0, side * 0.35, k));
      r.turret.position.y = lerp(8.82, 5.80, k);
      r.turret.position.z = 0.18;
      r.turret.rotation.y = lerp(r.state.turretYaw, side * 0.62, k);
      r.gun.rotation.x = lerp(-r.state.turretPitch, 0.42, k);
      r.gun.position.z = lerp(0.18, 0.04, k);
      for (var mi = 0; mi < r.masts.length; mi++) {
        var deadMast = r.masts[mi];
        deadMast.part.position.y = lerp(deadMast.y, 0.30, k);
        deadMast.part.scale.y = deadMast.sy * (1 - k);
        deadMast.part.visible = k < 0.98;
      }

      var near = nearEnough(e, r);
      presentPath(e, r, near, true);
      if (!near) {
        r.muzzleReady = false;
        return true;
      }

      for (var i = 0; i < r.legs.length; i++) {
        var leg = r.legs[i];
        var fan = (leg.row - 1.5) * leg.side * 0.15;
        var upperDead = -0.32 + (leg.parity ? 0.06 : 0);
        var kneeDead = -2.38 - (leg.parity ? 0.04 : 0);
        /* A parabolic lift keeps the long links above the floor while their
           endpoints transition between standing and fully splayed poses. */
        leg.mount.position.y = lerp(leg.mountY, 3.90, k) + 5.0 * k * (1 - k);
        leg.mount.rotation.y = lerp(finite(leg.deathYaw0, leg.baseYaw), leg.baseYaw + fan, k);
        leg.upper.rotation.z = lerp(finite(leg.deathUpper0, leg.upper0), upperDead, k);
        leg.knee.rotation.z = lerp(finite(leg.deathKnee0, leg.knee0), kneeDead, k);
        leg.foot.rotation.z = -(leg.upper.rotation.z + leg.knee.rotation.z);
        leg.foot.rotation.x = lerp(finite(leg.deathFootX0, 0),
          leg.side * (leg.parity ? 0.18 : -0.12), k);
      }

      /* The sensor stutters out as the chassis hits the floor. */
      var flicker = k < 0.72 || Math.sin((finite(t, 0) + i) * 61) > k * 1.25 - 0.55;
      for (var q = 0; q < r.glows.length; q++) r.glows[q].visible = flicker && k < 0.94;

      updateMuzzle(r, false);
      return true;
    } catch (err) {
      return failToSprite(e, r, true, err);
    }
  }

  function createSpider(e) {
    if (!e || e.kind !== 'spider') return undefined;
    try { return buildSpider(e); }
    catch (err) {
      console.error('[nz-spider] rig creation failed; stock fallback retained:', err);
      return undefined;
    }
  }

  NZ.on('ready', function (ctx) {
    if (INSTALLED) return;
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    if (!THREE || !THREE.Group || !THREE.Mesh || !THREE.MeshStandardMaterial) {
      console.error('[nz-spider] three.js r149-compatible surface unavailable');
      return;
    }

    /* Higher than the generic character module. Unknown kinds return
       undefined, so ordering has no effect on the existing operator roster. */
    NZ.on('createEnemyRig', createSpider, 120);
    NZ.on('animateEnemyRig', animateSpider, 120);
    NZ.on('animateEnemyRigDeath', animateSpiderDeath, 120);
    if (NZ.flags) NZ.flags.spider = true;
    INSTALLED = true;
    if (NZ.log) NZ.log('mechanical spider rig installed');
  });

})(typeof window !== 'undefined' ? window : this);
