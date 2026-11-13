/* Blender mesh importer for the photographed Seydikent blocks. */
(function (global) {
  'use strict';
  var METRE = 3.5;
  var imul = Math.imul, floor = Math.floor, min = Math.min, max = Math.max;

  // The export deliberately keeps Blender's linear albedo. These neutral,
  // tileable multipliers add material scale without repainting that palette.
  // DataTexture also works in the headless asset verifier (no canvas/DOM).
  function hash(x, y, seed) {
    var h = imul(x, 374761393) + imul(y, 668265263) + imul(seed, 144269);
    h = imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function noiseGrid(period, seed) {
    var grid = new Float32Array(period * period);
    for (var y = 0; y < period; y++) for (var x = 0; x < period; x++)
      grid[y * period + x] = hash(x, y, seed);
    return grid;
  }
  function tileNoise(x, y, period, grid) {
    x *= period; y *= period;
    var ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
    fx *= fx * (3 - 2 * fx); fy *= fy * (3 - 2 * fy);
    var nx = (ix + 1) % period, ny = ((iy + 1) % period) * period;
    iy *= period;
    var a = grid[iy + ix], b = grid[iy + nx], c = grid[ny + ix], d = grid[ny + nx];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }
  function surfaceKind(name) {
    if (/^(butter|butter_light|siding_seam)$/.test(name)) return 'siding';
    if (/^(rose|rose_light|rose_patch|sage|cream|taupe|plinth)$/.test(name)) return 'plaster';
    if (/^(roof|roof_light)$/.test(name)) return 'roof';
    if (/^(sill|pot)$/.test(name)) return 'stone';
    if (/^(curtain|curtain_shadow)$/.test(name)) return 'cloth';
    if (/^(pvc|rail|red_rail|drain|gas|door|dish)$/.test(name)) return 'paint';
    return null;
  }
  function makeSurface(THREE, kind, own, anisotropy) {
    var size = 256, color = new Uint8Array(size * size * 4), detail = new Uint8Array(color.length);
    var seed = { plaster: 233, siding: 342, roof: 175, stone: 63, cloth: 827, paint: 456 }[kind];
    var broadGrid = noiseGrid(4, seed), middleGrid = noiseGrid(16, seed + 1), fineGrid = noiseGrid(64, seed + 2);
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
      var u = x / size, v = y / size, i = (y * size + x) * 4;
      var broad = tileNoise(u, v, 4, broadGrid), middle = tileNoise(u, v, 16, middleGrid);
      var fine = tileNoise(u, v, 64, fineGrid), grain = hash(x, y, seed + 3);
      var variation = broad * .55 + middle * .30 + fine * .15;
      var albedo = .99 - variation * .105 - grain * .014;
      var height = .28 + fine * .30 + grain * .22, rough = .91 + variation * .09;
      if (kind === 'siding') {
        // Physical lap edges already exist in the mesh; avoid a second set.
        albedo = .995 - variation * .068 - grain * .006;
        height = .45 + fine * .09 + grain * .06;
      } else if (kind === 'paint') {
        albedo = .998 - variation * .037; height = .47 + grain * .055;
        rough = .86 + middle * .14;
      } else if (kind === 'stone') {
        albedo = .98 - variation * .12 - grain * .02;
        height = .22 + middle * .30 + fine * .20 + grain * .18;
      } else if (kind === 'cloth') {
        var weave = ((x % 4 < 2) ? .028 : 0) + ((y % 4 < 2) ? .018 : 0);
        albedo = .99 - variation * .06 - weave; height = .45 + weave * 3 + grain * .08;
        rough = 1;
      } else if (kind === 'roof') {
        var row = Math.floor(v * 10), col = Math.floor(u * 12 + (row % 2) * .5);
        var tile = hash(col, row, seed), seamU = (u * 12 + (row % 2) * .5) % 1, seamV = (v * 10) % 1;
        var seam = seamU < .045 || seamV < .06 ? 1 : 0;
        albedo = .98 - tile * .11 - variation * .045 - seam * .10;
        height = .35 + Math.sin(seamU * Math.PI) * .18 + grain * .09 - seam * .16;
      }
      var tone = Math.round(albedo * 255);
      color[i] = color[i + 1] = color[i + 2] = tone; color[i + 3] = 255;
      detail[i] = Math.round(height * 255); detail[i + 1] = Math.round(rough * 255);
      detail[i + 2] = 255; detail[i + 3] = 255;
    }
    function texture(data, label) {
      var tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      tex.name = 'building-' + kind + '-' + label;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true; tex.anisotropy = anisotropy; tex.encoding = THREE.LinearEncoding;
      tex.needsUpdate = true; own.tex.push(tex); return tex;
    }
    return { map: texture(color, 'albedo'), detail: texture(detail, 'height-roughness'),
      metres: { plaster: 4, siding: 3, roof: 3, stone: 2, cloth: .65, paint: 2 }[kind],
      bump: { plaster: .018, siding: .008, roof: .065, stone: .025, cloth: .007, paint: .004 }[kind] };
  }

  function planarUVs(source, scale) {
    var p = source.positions, n = source.normals, uv = new Float32Array(p.length / 3 * 2);
    for (var i = 0, j = 0; i < p.length; i += 3, j += 2) {
      var ax = Math.abs(n[i]), ay = Math.abs(n[i + 1]), az = Math.abs(n[i + 2]);
      // The export has split face normals. World projection therefore leaves
      // crisp corners and gives adjoining strips exactly matching texel scale.
      uv[j] = (ay >= ax && ay >= az ? p[i] : ax > az ? p[i + 2] : p[i]) / scale;
      uv[j + 1] = (ay >= ax && ay >= az ? p[i + 2] : p[i + 1]) / scale;
    }
    return uv;
  }

  // Collect actual undersides from the Blender slabs and sills. A spatial
  // bucket keeps this linear in vertices; no all-mesh ray casts at startup.
  function contactSlabs(asset) {
    var buckets = Object.create(null), seen = Object.create(null), cell = 12;
    asset.meshes.forEach(function (source) {
      if (source.material !== 'sill') return;
      var p = source.positions, n = source.normals, ids = source.indices;
      for (var t = 0; t < ids.length; t += 3) {
        var a = ids[t] * 3, b = ids[t + 1] * 3, c = ids[t + 2] * 3;
        if (n[a + 1] > -.99 || n[b + 1] > -.99 || n[c + 1] > -.99) continue;
        var x0 = Math.min(p[a], p[b], p[c]), x1 = Math.max(p[a], p[b], p[c]);
        var z0 = Math.min(p[a + 2], p[b + 2], p[c + 2]), z1 = Math.max(p[a + 2], p[b + 2], p[c + 2]);
        if (x1 - x0 < .12 || z1 - z0 < .12) continue;
        var h = p[a + 1], key = [x0, x1, h, z0, z1].map(function (v) { return v.toFixed(3); }).join(':');
        if (seen[key]) continue;
        seen[key] = true;
        var slab = { x0: x0, x1: x1, y: h, z0: z0, z1: z1 };
        for (var gx = Math.floor((x0 - .7) / cell); gx <= Math.floor((x1 + .7) / cell); gx++)
          for (var gz = Math.floor((z0 - .7) / cell); gz <= Math.floor((z1 + .7) / cell); gz++) {
            var bucket = gx + ':' + gz;
            (buckets[bucket] || (buckets[bucket] = [])).push(slab);
          }
      }
    });
    return buckets;
  }
  function shadeContacts(geo, source, slabs) {
    if (source.material === 'glass') return; // Pane AO/destruction stay shared.
    var p = source.positions, n = source.normals, colors = geo.attributes.color.array;
    for (var i = 0; i < p.length; i += 3) {
      var x = p[i], y = p[i + 1], z = p[i + 2], ny = n[i + 1];
      var shade = ny < -.65 ? .74 : 1;
      if (ny < .45) {
        var list = slabs[floor(x / 12) + ':' + floor(z / 12)];
        if (list) for (var j = 0; j < list.length; j++) {
          var s = list[j], gap = s.y - y;
          if (gap < .045 || gap > 3.2) continue;
          var edge = max(s.x0 - x, x - s.x1, s.z0 - z, z - s.z1, 0);
          if (edge > .65) continue;
          var shadow = (1 - gap / 3.2) * (1 - edge / .65);
          shade = min(shade, 1 - .28 * shadow);
        }
      }
      colors[i] *= shade; colors[i + 1] *= shade; colors[i + 2] *= shade;
    }
    geo.attributes.color.needsUpdate = true;
  }

  global.NZ_BLENDER_BUILDINGS = {
    install: function (ctx, street, own) {
      var asset = global.NZ_BUILDINGS_ASSET;
      if (!asset || !asset.meshes.length) throw new Error('Blender building asset is missing');
      var THREE = ctx.THREE || global.THREE, scene = ctx.scene;
      var materials = {}, surfaces = {}, meshes = [], glass = null, triangles = 0;
      if (!own.tex) own.tex = [];
      var anisotropy = 4;
      if (ctx.renderer && ctx.renderer.capabilities && ctx.renderer.capabilities.getMaxAnisotropy)
        anisotropy = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());
      var slabs = contactSlabs(asset);
      var occluders = [
        { x0: 580, x1: 756, y0: 0, y1: 53, z0: 96, z1: 138.8 },
        { x0: 580, x1: 756, y0: 0, y1: 53, z0: 209.2, z1: 256 }
      ];
      asset.meshes.forEach(function (source) {
        var spec = asset.materials[source.material], mat = materials[source.material];
        var kind = surfaceKind(source.material), surface = kind && surfaces[kind];
        if (kind && !surface) surface = surfaces[kind] = makeSurface(THREE, kind, own, anisotropy);
        if (!mat) {
          mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(spec.color[0], spec.color[1], spec.color[2]),
            roughness: spec.roughness, metalness: spec.metalness,
            side: source.material === 'glass' || source.material === 'dish' ? THREE.DoubleSide : THREE.FrontSide,
            vertexColors: true, dithering: true,
            transparent: source.material === 'glass',
            opacity: source.material === 'glass' ? .66 : 1,
            depthWrite: source.material !== 'glass'
          });
          if (surface) {
            mat.map = surface.map; mat.bumpMap = surface.detail;
            mat.bumpScale = surface.bump; mat.roughnessMap = surface.detail;
          }
          mat.name = 'nzday:blender-buildings-' + source.material;
          if (street && street.day) street.day(mat, { name: 'blender-buildings-' + source.material,
            intensity: source.material === 'glass' ? .7 : .9, spec: .35 });
          own.mat.push(mat); materials[source.material] = mat;
        }
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(source.normals, 3));
        if (surface) geo.setAttribute('uv', new THREE.BufferAttribute(planarUVs(source, surface.metres * METRE), 2));
        geo.setIndex(source.indices);
        // Material color remains linear, the same convention as the Courier.
        if (street && street.bake) street.bake(geo, { rays: 5, occluders: occluders,
          floor: .44, scale: .97, bias: .06, roofY: 54 });
        if (!geo.attributes.color) {
          var colors = new Float32Array(source.positions.length); colors.fill(.86);
          geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }
        shadeContacts(geo, source, slabs);
        geo.computeBoundingSphere(); geo.computeBoundingBox(); own.geo.push(geo);
        var mesh = new THREE.Mesh(geo, mat);
        mesh.name = 'nzstreet-blender-' + source.name;
        mesh.userData.blenderSource = asset.source;
        mesh.userData.building = source.building;
        mesh.castShadow = false; mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false; mesh.updateMatrix();
        scene.add(mesh); own.obj.push(mesh); meshes.push(mesh);
        if (source.name === 'hero-glass') glass = mesh;
        triangles += source.indices.length / 3;
      });
      var panes = asset.panes.map(function (p) {
        var copy = Object.assign({}, p);
        // This asset stores albedo in the material; instanced colors carry AO only.
        copy.bakedTint = [.82, .82, .82];
        return copy;
      });
      return { meshes: meshes, triangles: triangles, heroGlass: { mesh: glass, panes: panes, count: panes.length },
        replacedRuns: asset.replacedRuns, source: asset.source };
    }
  };
})(typeof window !== 'undefined' ? window : this);
