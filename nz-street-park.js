/* ===========================================================================
   NZ-STREET-PARK -- the linear park reach of 233. Sokak.

   Visuals only.  The parent level owns the grid, collision, navigation and
   gameplay.  This module adds the split climbing road, Yildiz Tepesi park,
   the ordinary apartment/office shell that hides the arena entrance, and the
   open barrier-and-vista closure.  It never writes a map cell or a game
   global.  Geometry is procedural, deterministic and merged by material.

   Scale: 1 metre = 3.5 world units.  Three.js r149 classic-script API only.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) return;

  var U = 3.5;
  /*
     The first park pass was authored with its length on +Z.  The real site is
     one continuous east/west reach of 233 Sk, so all authored park geometry is
     rotated and its longitudinal direction reversed at the vertex boundary:

         world X = 740 - authored Z
         world Z = authored X

     This keeps every small garden composition intact while making the two
     carriageways, median, park and arena genuinely parallel to the Seydikent
     blocks.  City-terminus scenery is already authored in world coordinates
     and temporarily opts out of this transform below.
  */
  var TRANSFORM_AUTHORED = true;
  var AXIS_ORIGIN = 740;
  var ROUTE = {
    x0: 260, x1: 548,
    northFacade: 144,
    northWalk: { z0: 144, z1: 152 },
    northRoad: { z0: 152, z1: 172 },
    median: { z0: 172, z1: 184, x0: 266, x1: 536 },
    southRoad: { z0: 184, z1: 204 },
    /* The promenade widened 8 u -> 12 u in the street pass; the park lawn's
       north edge follows it to world Z 216 and its east edge now stops at the
       matching 232 Sk envelope, world X 484. */
    promenade: { z0: 204, z1: 216 },
    park: { x0: 268, x1: 484, z0: 216, z1: 265 },
    apron: { z0: 204, z1: 216, x0: 268, x1: 484 },
    service: { z0: 271.31, z1: 292.69, x0: 268, x1: 484, crown: 282 },
    junction: { x0: 484, x1: 500.5, z0: 204, z1: 293 },
    buildingLine: 299.0
  };
  var ARENA = {
    x0: 268, x1: 380, z0: 104, z1: 144,
    storeys: 6,
    entrance: { x: 318, x0: 316, x1: 320, z: 144, gridX: 79, gridY: 35 },
    publicName: 'SEYDIKENT C-BLOK'
  };
  var CLOSURE = {
    cityX: 832,
    parkX: 266,
    northSpan: { z0: 153.2, z1: 170.8 },
    southSpan: { z0: 185.2, z1: 202.8 },
    parkFenceX: 266,
    vistaX: 994
  };
  function grade(z) { return Math.max(0, Math.min(20.16, (z - 192) * 0.07)); }
  function worldGrade(x) { return grade(AXIS_ORIGIN - x); }

  var STATS = {
    ok: false, tier: 'high', draws: 0, tris: 0, verts: 0, textureBytes: 0,
    roadPatches: 0, curbSegments: 0, medianTrees: 0, parkTrees: 0,
    hedges: 0, gazebos: 0, benches: 0, lamps: 0, buildings: 0,
    windows: 0, barriers: 0, marks: 0, gullies: 0, pits: 0,
    ms: 0, warnings: 0,
    /* JOB B's counters, LAST: scripts/render-level.mjs prints only the first
       24 keys of this object, and `warnings` is the acceptance signal. */
    tufts: 0, hedgeCards: 0, shrubs: 0
  };
  var DIAG = { warnings: [], piles: [] };
  var OWN = { tex: [], mat: [], geo: [], obj: [] };
  var THREE = null, scene = null, renderer = null;
  var installed = false, dead = false;
  var DISABLED = /[?&]nzpark=(?:0|off)(?:&|$)/i.test(
    global.location ? global.location.search : '');

  if (NZ.flags && NZ.flags.streetPark === undefined) NZ.flags.streetPark = false;
  NZ.streetPark = {
    ok: false, loaded: true, stats: STATS, diag: DIAG,
    route: ROUTE, arena: ARENA, closure: CLOSURE, gradeAt: worldGrade
  };

  function warn(s) {
    DIAG.warnings.push(String(s)); STATS.warnings = DIAG.warnings.length;
    try { console.warn('[nz-street-park] ' + s); } catch (e) {}
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function fin(v, d) { return typeof v === 'number' && isFinite(v) ? v : (d || 0); }
  function col(hex) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }
  function mixColor(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  /* Fixed-seed lattice noise.  Placement and texture noise are reproducible. */
  var SEED = 23320456;
  function hash(n) {
    var s = Math.sin(n * 12.9898 + SEED * 0.00017) * 43758.5453123;
    return s - Math.floor(s);
  }
  function rnd(a, b) { return hash(a * 7919 + b * 104729 + 17); }
  function rr(a, b, lo, hi) { return lo + (hi - lo) * rnd(a, b); }

  /* The park is the only street module with no carve test of its own, which
     was harmless while mission 1 owned the street.  Mission 1 no longer does:
     without this it builds a hundred thousand triangles of daylight park
     inside the night level's solid rock, where the rooftop can see the east
     edge of it.  Probe the graded park columns the level actually carves. */
  function hasPark() {
    /* regAt is a function DECLARATION in the page and therefore on window;
       inb is a top-level `const` arrow and is NOT, so testing for it here
       fails open and the gate never closes.  Only probe what is really there. */
    var at = global.regAt;
    if (typeof at !== 'function') return true;
    for (var cx = 70; cx <= 130; cx += 10) {
      var R = at(cx, 50);
      if (R && R.sky && R.c > 50) return true;
    }
    return false;
  }

  function laterMission() {
    if (NZ.level !== undefined && NZ.level !== 1 && NZ.level !== 4) return true;
    var q = '';
    try { q = (global.location.search || '') + (global.location.hash || ''); } catch (e) {}
    return /(?:[?&#])level=(?:2|3)(?:[&#]|$)/i.test(q);
  }

  function stDay(mat, opts) {
    var s = NZ.street;
    if (s && typeof s.day === 'function') {
      try { return s.day(mat, opts || {}); }
      catch (e) { warn('NZ.street.day failed: ' + e.message); }
    }
    mat.name = 'nzday:' + ((opts && opts.name) || mat.name || 'street-park');
    return mat;
  }
  function stBake(geo, opts) {
    var s = NZ.street;
    if (s && typeof s.bake === 'function') {
      try { return s.bake(geo, opts || {}); }
      catch (e) { warn('NZ.street.bake failed: ' + e.message); }
    }
    if (geo && geo.attributes && geo.attributes.position) {
      var n = geo.attributes.position.count, a = new Float32Array(n * 3), i;
      for (i = 0; i < a.length; i++) a[i] = 0.88;
      geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    return geo;
  }

  /* ---- merged geometry ------------------------------------------------- */
  function Pile(name, tile) {
    this.name = name; this.tile = tile || 8;
    this.p = []; this.nm = []; this.uv = []; this.tone = []; this.idx = [];
    this.n = 0;
  }
  Pile.prototype.v = function (x, y, z, nx, ny, nz, u, v, tone) {
    if (TRANSFORM_AUTHORED) {
      var wx = AXIS_ORIGIN - z, wz = x;
      var wnx = -nz, wnz = nx;
      x = wx; z = wz; nx = wnx; nz = wnz;
    }
    this.p.push(x, y, z); this.nm.push(nx, ny, nz); this.uv.push(u, v);
    this.tone.push(tone[0], tone[1], tone[2]);
    return this.n++;
  };
  Pile.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Pile.prototype.geometry = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    OWN.geo.push(g);
    return g;
  };

  function poly(pile, pts, ref, tone, uvRect) {
    var n = pts.length, i, cx = 0, cy = 0, cz = 0;
    if (n < 3) return;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
    cx /= n; cy /= n; cz /= n;
    var nx = 0, ny = 0, nz = 0;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0.000001)) return;
    nx /= len; ny /= len; nz /= len;
    var flip = nx * (cx - ref[0]) + ny * (cy - ref[1]) + nz * (cz - ref[2]) < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    var ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    var mode = ay >= ax && ay >= az ? 1 : (ax >= az ? 0 : 2);
    var base = pile.n, inv = 1 / pile.tile;
    for (i = 0; i < n; i++) {
      var p = pts[i], u, v;
      if (uvRect && n === 4) {
        /* panelX/panelZ order is bottom-left, top-left, top-right,
           bottom-right, not the usual strip order. */
        var q = [[uvRect[0], uvRect[1]], [uvRect[0], uvRect[3]],
                 [uvRect[2], uvRect[3]], [uvRect[2], uvRect[1]]][i];
        u = q[0]; v = q[1];
      } else if (mode === 1) { u = p[0] * inv; v = p[2] * inv; }
      else if (mode === 0) { u = p[2] * inv; v = p[1] * inv; }
      else { u = p[0] * inv; v = p[1] * inv; }
      pile.v(p[0], p[1], p[2], nx, ny, nz, u, v, tone);
    }
    for (i = 1; i < n - 1; i++) {
      if (flip) pile.tri(base, base + i + 1, base + i);
      else pile.tri(base, base + i, base + i + 1);
    }
  }

  function box(p, x0, y0, z0, x1, y1, z1, t) {
    if (x1 < x0) { var tx = x0; x0 = x1; x1 = tx; }
    if (y1 < y0) { var ty = y0; y0 = y1; y1 = ty; }
    if (z1 < z0) { var tz = z0; z0 = z1; z1 = tz; }
    var r = [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5];
    poly(p, [[x0,y0,z0],[x0,y1,z0],[x0,y1,z1],[x0,y0,z1]], r, t);
    poly(p, [[x1,y0,z1],[x1,y1,z1],[x1,y1,z0],[x1,y0,z0]], r, t);
    poly(p, [[x0,y0,z1],[x0,y1,z1],[x1,y1,z1],[x1,y0,z1]], r, t);
    poly(p, [[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z0]], r, t);
    poly(p, [[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]], r, t);
    poly(p, [[x0,y0,z1],[x1,y0,z1],[x1,y0,z0],[x0,y0,z0]], r, t);
  }

  function surf(p, x0, x1, z0, z1, lift, t) {
    poly(p, [[x0,grade(z0)+lift,z0],[x1,grade(z0)+lift,z0],
             [x1,grade(z1)+lift,z1],[x0,grade(z1)+lift,z1]],
         [(x0+x1)*0.5, grade((z0+z1)*0.5)-2, (z0+z1)*0.5], t);
  }

  function panelX(p, x, y0, y1, z0, z1, dir, t, uvRect) {
    var pts;
    if (dir > 0) pts = [[x,y0,z0],[x,y1,z0],[x,y1,z1],[x,y0,z1]];
    else pts = [[x,y0,z1],[x,y1,z1],[x,y1,z0],[x,y0,z0]];
    poly(p, pts, [x-dir, (y0+y1)*0.5, (z0+z1)*0.5], t, uvRect);
  }

  function panelZ(p, z, y0, y1, x0, x1, dir, t, uvRect) {
    var pts;
    if (dir > 0) pts = [[x1,y0,z],[x1,y1,z],[x0,y1,z],[x0,y0,z]];
    else pts = [[x0,y0,z],[x0,y1,z],[x1,y1,z],[x1,y0,z]];
    poly(p, pts, [(x0+x1)*0.5,(y0+y1)*0.5,z-dir], t, uvRect);
  }

  function tube(p, a, b, r, sides, t, caps) {
    var dx=b[0]-a[0], dy=b[1]-a[1], dz=b[2]-a[2];
    var dl=Math.sqrt(dx*dx+dy*dy+dz*dz); if (!(dl>0.0001)) return;
    dx/=dl; dy/=dl; dz/=dl;
    var hx=Math.abs(dy)>0.9?1:0, hy=Math.abs(dy)>0.9?0:1, hz=0;
    var ux=dy*hz-dz*hy, uy=dz*hx-dx*hz, uz=dx*hy-dy*hx;
    var ul=Math.sqrt(ux*ux+uy*uy+uz*uz); ux/=ul; uy/=ul; uz/=ul;
    var vx=dy*uz-dz*uy, vy=dz*ux-dx*uz, vz=dx*uy-dy*ux;
    var i, ring0=[], ring1=[];
    for (i=0;i<sides;i++) {
      var q=i*Math.PI*2/sides, cq=Math.cos(q)*r, sq=Math.sin(q)*r;
      ring0.push([a[0]+ux*cq+vx*sq,a[1]+uy*cq+vy*sq,a[2]+uz*cq+vz*sq]);
      ring1.push([b[0]+ux*cq+vx*sq,b[1]+uy*cq+vy*sq,b[2]+uz*cq+vz*sq]);
    }
    var ref=[(a[0]+b[0])*.5,(a[1]+b[1])*.5,(a[2]+b[2])*.5];
    for(i=0;i<sides;i++) poly(p,[ring0[i],ring0[(i+1)%sides],ring1[(i+1)%sides],ring1[i]],ref,t);
    if(caps){ poly(p,ring0,ref,t); poly(p,ring1,ref,t); }
  }

  function frustum(p, x, y0, z, r0, y1, r1, sides, t, cap) {
    var i, a=[], b=[], ref=[x,(y0+y1)*.5,z];
    for(i=0;i<sides;i++){
      var q=i*Math.PI*2/sides;
      a.push([x+Math.cos(q)*r0,y0,z+Math.sin(q)*r0]);
      b.push([x+Math.cos(q)*r1,y1,z+Math.sin(q)*r1]);
    }
    for(i=0;i<sides;i++) poly(p,[a[i],a[(i+1)%sides],b[(i+1)%sides],b[i]],ref,t);
    if(cap){ poly(p,a,ref,t); poly(p,b,ref,t); }
  }

  function blob(p, x, y, z, rx, ry, rz, t) {
    var rings=4, seg=8, j, i, pts=[], ref=[x,y,z];
    for(j=0;j<=rings;j++){
      var ph=-Math.PI*.5+j*Math.PI/rings, ring=[];
      for(i=0;i<seg;i++){
        var q=i*Math.PI*2/seg;
        ring.push([x+Math.cos(ph)*Math.cos(q)*rx,y+Math.sin(ph)*ry,z+Math.cos(ph)*Math.sin(q)*rz]);
      }
      pts.push(ring);
    }
    for(j=0;j<rings;j++) for(i=0;i<seg;i++)
      poly(p,[pts[j][i],pts[j][(i+1)%seg],pts[j+1][(i+1)%seg],pts[j+1][i]],ref,t);
  }

  function hipRoof(p, x0, x1, z0, z1, y, rise, t) {
    var e=1.6, xa=x0-e, xb=x1+e, za=z0-e, zb=z1+e;
    var cx=(xa+xb)*.5, inset=Math.min(10,(zb-za)*.18);
    var r0=[cx,y+rise,za+inset], r1=[cx,y+rise,zb-inset], ref=[cx,y-2,(za+zb)*.5];
    poly(p,[[xa,y,za],[xb,y,za],r0],ref,t);
    poly(p,[[xb,y,za],[xb,y,zb],r1,r0],ref,t);
    poly(p,[[xb,y,zb],[xa,y,zb],r1],ref,t);
    poly(p,[[xa,y,zb],[xa,y,za],r0,r1],ref,t);
  }

  /* hipRoof always runs its ridge along AUTHORED Z.  The corner block's long
     axis is authored X, and the south blocks want deeper eaves than the
     fixed 1.6 u, so this is the same six triangles with one extra branch and
     an optional overhang.  hipRoof itself is left byte-identical because
     buildArena and buildCityTerminus call it and are frozen. */
  function hipRoofAxis(p, x0, x1, z0, z1, y, rise, t, axis, e) {
    if (e === undefined) e = 1.6;
    var xa = x0 - e, xb = x1 + e, za = z0 - e, zb = z1 + e;
    if (axis === 'x') {
      var cz = (za + zb) * .5, ix = Math.min(10, (xb - xa) * .18);
      var r0 = [xa + ix, y + rise, cz], r1 = [xb - ix, y + rise, cz];
      var ref = [(xa + xb) * .5, y - 2, cz];
      poly(p, [[xa, y, za], [xb, y, za], r1, r0], ref, t);
      poly(p, [[xb, y, zb], [xa, y, zb], r0, r1], ref, t);
      poly(p, [[xa, y, zb], [xa, y, za], r0], ref, t);
      poly(p, [[xb, y, za], [xb, y, zb], r1], ref, t);
    } else {
      var cx = (xa + xb) * .5, iz = Math.min(10, (zb - za) * .18);
      var q0 = [cx, y + rise, za + iz], q1 = [cx, y + rise, zb - iz];
      var rf = [cx, y - 2, (za + zb) * .5];
      poly(p, [[xa, y, za], [xb, y, za], q0], rf, t);
      poly(p, [[xb, y, za], [xb, y, zb], q1, q0], rf, t);
      poly(p, [[xb, y, zb], [xa, y, zb], q1], rf, t);
      poly(p, [[xa, y, zb], [xa, y, za], q0, q1], rf, t);
    }
  }

  /* one horizontal quad; up = +1 faces the sky, -1 faces the ground */
  function hquad(p, y, x0, x1, z0, z1, up, t) {
    poly(p, [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]],
         [(x0 + x1) * .5, y - up, (z0 + z1) * .5], t);
  }

  function bakeTone(g, p, opts) {
    stBake(g, opts || { rays: 6, floor: 0.48, scale: 0.96 });
    var c=g.attributes.color, a=c&&c.array, t=p.tone, i;
    if(!a){ a=new Float32Array(p.n*3); for(i=0;i<a.length;i++)a[i]=1; g.setAttribute('color',new THREE.BufferAttribute(a,3)); }
    for(i=0;i<Math.min(a.length,t.length);i++) a[i]*=t[i];
    g.attributes.color.needsUpdate=true;
  }

  /* ---- textures and materials ----------------------------------------- */
  function canvasTexture(kind, base, accent, size) {
    size=size||128;
    var c=global.document&&document.createElement?document.createElement('canvas'):null;
    if(!c) throw new Error('canvas unavailable');
    c.width=c.height=size; var g=c.getContext('2d'), i, x, y;
    g.fillStyle=base; g.fillRect(0,0,size,size);
    if(kind==='asphalt'){
      for(i=0;i<1600;i++){ var v=Math.floor(rr(i,1,55,125)); g.fillStyle='rgba('+v+','+v+','+v+','+rr(i,2,.04,.16)+')'; g.fillRect(rr(i,3,0,size),rr(i,4,0,size),rr(i,5,.4,1.8),rr(i,6,.4,1.8)); }
      g.strokeStyle='rgba(30,32,32,.15)'; g.lineWidth=.75;
      for(i=0;i<2;i++){g.beginPath();g.moveTo(rr(i,9,0,size),0);g.bezierCurveTo(rr(i,10,0,size),size*.3,rr(i,11,0,size),size*.7,rr(i,12,0,size),size);g.stroke();}
    } else if(kind==='paver'){
      g.strokeStyle=accent; g.lineWidth=1;
      for(y=0;y<size;y+=12) for(x=-12;x<size;x+=24){ var xx=x+((y/12)%2)*12; g.strokeRect(xx,y,22,10); }
      for(i=0;i<300;i++){g.fillStyle='rgba(70,45,35,'+rr(i,2,.015,.07)+')';g.fillRect(rr(i,3,0,size),rr(i,4,0,size),2,2);}
    } else if(kind==='grass'||kind==='leaf'){
      for(i=0;i<1000;i++){g.strokeStyle=i%5===0?accent:'rgba(35,60,34,.16)';g.lineWidth=rr(i,2,.4,1.3);x=rr(i,3,0,size);y=rr(i,4,0,size);g.beginPath();g.moveTo(x,y);g.lineTo(x+rr(i,5,-1.5,1.5),y-rr(i,6,1,5));g.stroke();}
    } else if(kind==='stone'){
      g.strokeStyle=accent; g.lineWidth=2;
      for(y=0;y<size;y+=22){g.beginPath();g.moveTo(0,y);g.lineTo(size,y);g.stroke();for(x=((y/22)%2)*18;x<size;x+=36){g.beginPath();g.moveTo(x,y);g.lineTo(x,y+22);g.stroke();}}
      for(i=0;i<260;i++){g.fillStyle='rgba(80,64,52,'+rr(i,3,.02,.10)+')';g.fillRect(rr(i,4,0,size),rr(i,5,0,size),rr(i,6,1,4),1);}
    } else if(kind==='render'){
      for(i=0;i<1400;i++){var al=rr(i,2,.015,.09);g.fillStyle=i%2?'rgba(60,54,45,'+al+')':'rgba(255,255,245,'+al+')';g.fillRect(rr(i,3,0,size),rr(i,4,0,size),1,1);}
    } else if(kind==='roof'){
      g.strokeStyle=accent; g.lineWidth=1.4;
      for(x=0;x<size;x+=10){g.beginPath();g.moveTo(x,0);g.lineTo(x,size);g.stroke();}
      for(y=0;y<size;y+=9){g.strokeStyle='rgba(80,32,27,.34)';g.beginPath();g.moveTo(0,y);g.lineTo(size,y);g.stroke();}
    } else if(kind==='bark'){
      /* A pine trunk is not a plank.  Pinus nigra bark is a dark grey-brown
         broken into long vertical plates by pale fissures, so the grain runs
         UP the tube -- and a tube's UV puts texture-v on world Y, which means
         the fissures have to be drawn as vertical strokes here.  The old
         'wood' map's horizontal bezier grain wrapped the trunk in rings and
         every park tree came out looking like bamboo. */
      for(i=0;i<26;i++){
        var fx=rr(i,1,0,size);
        g.strokeStyle='rgba(52,42,33,'+rr(i,2,.20,.46)+')'; g.lineWidth=rr(i,3,1.2,3.4);
        g.beginPath(); g.moveTo(fx,0);
        g.bezierCurveTo(fx+rr(i,4,-7,7),size*.34,fx+rr(i,5,-7,7),size*.68,fx+rr(i,6,-5,5),size);
        g.stroke();
      }
      for(i=0;i<40;i++){
        var px2=rr(i,7,0,size), py2=rr(i,8,0,size);
        g.strokeStyle='rgba(70,58,45,'+rr(i,9,.10,.30)+')'; g.lineWidth=rr(i,10,.8,2.0);
        g.beginPath(); g.moveTo(px2,py2); g.lineTo(px2+rr(i,11,-4,4),py2+rr(i,12,7,26)); g.stroke();
      }
      /* the plates between the fissures, as broad soft patches */
      for(i=0;i<70;i++){
        g.fillStyle=(i%3?'rgba(196,186,170,':'rgba(96,82,66,')+rr(i,13,.05,.16)+')';
        g.fillRect(rr(i,14,0,size),rr(i,15,0,size),rr(i,16,3,11),rr(i,17,8,24));
      }
    } else if(kind==='wood'){
      g.strokeStyle=accent; g.lineWidth=1;
      for(y=4;y<size;y+=7){g.beginPath();g.moveTo(0,y);g.bezierCurveTo(size*.3,y+2,size*.7,y-2,size,y+1);g.stroke();}
    }
    var tex=new THREE.CanvasTexture(c);
    tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
    tex.minFilter=THREE.LinearMipmapLinearFilter; tex.magFilter=THREE.LinearFilter;
    try{tex.anisotropy=Math.min(8,renderer&&renderer.capabilities?renderer.capabilities.getMaxAnisotropy():4);}catch(e){tex.anisotropy=4;}
    if('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace=THREE.SRGBColorSpace;
    else if('encoding' in tex && THREE.sRGBEncoding) tex.encoding=THREE.sRGBEncoding;
    tex.needsUpdate=true; OWN.tex.push(tex); STATS.textureBytes+=size*size*4;
    return tex;
  }

  function material(name, tex, rough, metal, opts) {
    opts=opts||{};
    var m=new THREE.MeshStandardMaterial({
      map:tex||null, color:0xffffff, roughness:rough, metalness:metal,
      vertexColors:true, fog:true, dithering:true,
      side:opts.side||THREE.FrontSide,
      transparent:!!opts.transparent, opacity:opts.opacity===undefined?1:opts.opacity,
      alphaTest:opts.alphaTest||0, depthWrite:opts.depthWrite===undefined?true:opts.depthWrite
    });
    stDay(m,{name:'street-park-'+name,intensity:opts.env===undefined?.78:opts.env,spec:opts.spec});
    OWN.mat.push(m); return m;
  }

  var P=null, M=null, SIGN_TEX=null;
  var C={
    /* THE ROAD IS NOT BLUE.  Measured on the money shot the park carriageway
       came back rgb 95,106,108 -- blue a full 13 above red -- against 135,
       134,133 (ref2), 141,136,130 (ref6) and 94,93,77 (ref11), every one of
       which is neutral or WARM.  The albedo was already neutral; what tints
       it is the overcast probe, which is blue by construction, so the fix is
       a warm albedo that lands neutral once the sky has had its say.  Same
       correction, same ratios, on all three asphalt tones.
       The grass gets the milder half of it: early spring in Konya is straw
       with a green cast (ref11 83,79,56 -- red ABOVE green), and the first
       pass ran g/r 1.22, which is an English lawn in June. */
    /* THE RATIO IS THE ACCEPTANCE TEST, NOT THE HEX.  Every entry is a
       multiplier on an achromatic bake, so the number that matters is
       Y(surface)/Y(road) measured in the SAME render, with C.asphalt as the
       1.000 reference.  Luminance was corrected against the photographs in
       this pass; the warm hue bias above was NOT touched.  Target ladder:
       render white 1.60 · kerb 1.34 · pink band 1.20 · rose paver 1.14 ·
       cream motif 1.00 · terracotta 0.90 · shelter roof 0.48 · grass 0.38 ·
       shrub 0.30 · timber 0.29 · pine 0.18 · hedge 0.12 · black steel 0.06. */
    asphalt:col(0x736b61), asphaltDark:col(0x5a554f), asphaltPale:col(0x867b70),
    /* ground and street, JOB A */
    paver:col(0x78716d),        /* 1.14 desaturated rose, R-B ~ 0.045 */
    paverCream:col(0x675f5d),   /* 1.00 the chevron motif, same hue, 12% down */
    paverTan:col(0x8e7856),
    curb:col(0x9d9d9c),         /* 1.34 the only truly NEUTRAL surface here */
    edging:col(0xa2a09b),       /* 1.38 white precast edging strip */
    gutter:col(0x4e4a44),       /* 0.70 the dark ribbon inside every kerb */
    paint:col(0x9d9a92),        /* 1.45 worn road paint, never pure white */
    stone:col(0x5d5146),
    /* lawn and planting, JOB B */
    grass:col(0x393927),        /* 0.38 YELLOW-green, never blue-green */
    grassDry:col(0x46432c),     /* 0.46 */
    soil:col(0x6e5c46),         /* 0.62 bare earth at every desire line */
    hedge:col(0x0c0e07),        /* 0.12 NEAR-BLACK OLIVE, not hedge green */
    shrub:col(0x1d2313),        /* 0.30 */
    /* furniture, JOB C */
    benchTimber:col(0x1f2016),  /* 0.29 weathered grey-green */
    picnicTimber:col(0x281e14), /* 0.29 warm mid-brown -- a DIFFERENT timber */
    railBlack:col(0x070706),    /* 0.06 */
    oxide:col(0x44302e),        /* 0.48 shelter/kamelya roof red.  DO NOT
                                   RENDER THIS BRIGHTER -- 0.475/0.488 measured
                                   in two independently exposed photographs. */
    binRed:col(0x54231d), binBody:col(0x6b7377),
    fitFrame:col(0x8e9393), yellow:col(0xa88e2a), signTeal:col(0x1e5a5c),
    /* buildings, JOB D */
    white:col(0xabaea7), cream:col(0x988e74),
    pinkBand:col(0x88807d), peach:col(0x8a574c),
    roofTile:col(0x533531), wallRed:col(0x702e28),
    glass:col(0x293a40), stainless:col(0x8d9390),
    /* trees are frozen */
    pine:col(0x203829), blossom:col(0xa8aaa0), trunk:col(0x504031),
    bark:col(0x6b5c4b), barkDark:col(0x4a3f33),
    red:col(0xb23532), city:col(0x8d908b), mountain:col(0x778b99)
  };
  /* Retired names kept as aliases so the frozen builders keep compiling. */
  C.wood = C.picnicTimber; C.steel = C.railBlack;
  C.pink = C.pinkBand; C.roof = C.roofTile;

  /* =====================================================================
     MISSION 4 ONLY -- THE SUNNY-DAY PROFILE.
     Everything above was calibrated against a flat overcast dome whose
     up-facing irradiance is a fraction of what the CORDON's key light now
     delivers: nz-street-sky.js gives level 4 a 2.45-intensity directional
     at 44 deg, so a horizontal surface receives better than 2x what the
     C table was solved for.  Measured off _shots/pk0, the park's own
     carriageway came back at sRGB 229 -- an asphalt road rendered as
     printer paper, because C.asphalt carries albedo 0.45, which is the
     albedo of a WHITEWASHED WALL and was only ever readable because the
     old sky could not light it.
     So mission 4 gets PHYSICAL albedos instead of compensated ones:
     asphalt 0.11-0.13, concrete 0.26-0.38, turf 0.11-0.15 with real
     chroma, foliage warm-olive instead of the overcast's blue-olive.
     applySunnyProfile() is called from install() and ONLY when
     NZ.level === 4; mission 1 never runs a line of it and keeps every
     number and every ratio above exactly as calibrated.
     ================================================================== */
  var SUNNY = false;
  /* wheel tracks, grit margins and tar bandages: authored for the sun, but a
     sealed crack is on the road in any weather.  Built from whichever asphalt
     triple is live, so under cloud it is a few levels of difference and under
     sun a stop. */
  var ROAD_DETAIL = false;
  /* unit vector TOWARD the mission-4 key light: south-west, 44 deg up. */
  var SUN = [-0.56, 0.69, 0.45];
  /* tone multipliers for the pine/cedar/deciduous crowns; the atlas is
     sampled sRGB->linear before this multiplies, so these are LINEAR. */
  var TDECID = [0.58, 0.66, 0.44];

  function applySunnyProfile() {
    SUNNY = true;
    /* ---- carriageway: real bitumen, not paper ------------------------ */
    C.asphalt     = [0.096, 0.091, 0.085];
    C.asphaltDark = [0.070, 0.067, 0.064];
    C.asphaltPale = [0.132, 0.124, 0.113];
    C.gutter      = [0.073, 0.070, 0.066];
    /* ---- concrete family: kilit tasi, kerb, precast edging ----------- */
    C.paver       = [0.300, 0.272, 0.238];
    C.paverCream  = [0.256, 0.238, 0.214];
    C.paverTan    = [0.345, 0.292, 0.209];
    C.curb        = [0.372, 0.368, 0.358];
    C.edging      = [0.386, 0.380, 0.366];
    C.paint       = [0.560, 0.548, 0.520];
    C.stone       = [0.232, 0.202, 0.172];
    /* ---- planting: chroma, and a lot less luminance ------------------ */
    C.grass       = [0.118, 0.138, 0.051];
    C.grassDry    = [0.152, 0.142, 0.063];
    C.soil        = [0.238, 0.196, 0.148];
    C.hedge       = [0.076, 0.096, 0.032];
    C.shrub       = [0.106, 0.130, 0.046];
    /* ---- furniture and timber --------------------------------------- */
    C.benchTimber  = [0.118, 0.112, 0.082];
    C.picnicTimber = [0.176, 0.124, 0.076];
    C.oxide        = [0.196, 0.096, 0.076];
    C.railBlack    = [0.046, 0.046, 0.048];
    C.wood = C.picnicTimber; C.steel = C.railBlack;
    /* ---- bark: warm in the light, and never the same grey as the road */
    C.bark     = [0.268, 0.222, 0.166];
    C.barkDark = [0.152, 0.124, 0.094];
    /* ---- crowns: warm olive.  The overcast profile ran blue at 1.34 of
       red, which is what a pine looks like under a white sky and nothing
       like one under a blue one with the sun on it. */
    TCOL.pine  = [1.03, 0.76, 0.80];
    TCOL.cedar = [1.00, 0.76, 0.84];
    TDECID     = [0.78, 0.76, 0.50];
  }
  /* the sun-side ramp needs to know which crown a clump belongs to; the
     builders park the crown's centre here before they emit. */
  var TREEC = [0, 0, 0], TREER = 1;

  /* Bake occluders, world space, appended by every job and consumed by every
     bakeTone() call in meshAll().  nz-street-sky.js:1573 SILENTLY DISCARDS any
     box with a dimension over 26 world units and REG_CAP = 220 is shared by
     all five street modules, so chop everything and stay under 45 boxes. */
  var OCC = [];
  function occ(x0, y0, z0, x1, y1, z1) {
    if (x1 - x0 > 26 || y1 - y0 > 26 || z1 - z0 > 26) {
      warn('occluder dropped, over 26 u: ' + [x0, y0, z0, x1, y1, z1].join(','));
      return;
    }
    OCC.push({ x0: x0, x1: x1, y0: y0, y1: y1, z0: z0, z1: z1 });
  }

  function signTexture() {
    var c=document.createElement('canvas'); c.width=1024; c.height=512;
    var g=c.getContext('2d'); g.clearRect(0,0,c.width,c.height);
    var cx=256,cy=256,ro=218,ri=157,i;
    function starPath(radd){
      g.beginPath();
      for(i=0;i<16;i++){
        var q=-Math.PI/2+i*Math.PI/8, r=(i%2?ri:ro)+radd;
        var x=cx+Math.cos(q)*r,y=cy+Math.sin(q)*r;
        if(i===0)g.moveTo(x,y);else g.lineTo(x,y);
      }
      g.closePath();
    }
    starPath(0); g.fillStyle='#f2f0e7'; g.fill(); g.lineWidth=22; g.strokeStyle='#188b9b'; g.stroke();
    starPath(-30); g.lineWidth=9; g.strokeStyle='#87c6ca'; g.stroke();
    g.textAlign='center'; g.textBaseline='middle'; g.font='bold 35px Arial'; g.fillStyle='#3d4b43'; g.fillText('SEYDİŞEHİR',cx,170);
    g.font='bold 52px Arial'; g.fillStyle='#b33534'; g.fillText('ŞEHİTLER',cx,225);
    g.font='bold 47px Arial'; g.fillStyle='#177d88'; g.fillText('ÇAMLIK',cx,282);
    g.font='bold 42px Arial'; g.fillStyle='#487348'; g.fillText('PARKI',cx,330);
    g.textAlign='left'; g.textBaseline='middle'; g.fillStyle='#b53b37';
    g.font='bold 68px Arial'; g.fillText('SEYDİKENT',570,210);
    g.font='bold 54px Arial'; g.fillText('C-BLOK',665,292);
    var tex=new THREE.CanvasTexture(c); tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;
    tex.minFilter=THREE.LinearMipmapLinearFilter; tex.magFilter=THREE.LinearFilter;
    if('colorSpace' in tex&&THREE.SRGBColorSpace)tex.colorSpace=THREE.SRGBColorSpace;
    else if('encoding' in tex&&THREE.sRGBEncoding)tex.encoding=THREE.sRGBEncoding;
    tex.needsUpdate=true; OWN.tex.push(tex); STATS.textureBytes+=c.width*c.height*4;
    return tex;
  }

  /* ---- the apron paving map -------------------------------------------
     "Kilit tasi": 200 x 100 x 60 mm interlocking concrete pavers laid in
     diagonal running courses at 45 deg to the kerb, in a DUSKY ROSE field
     carrying a repeating cream-buff sawtooth.  Measured off the master
     photograph the rose is 1.143x road and the cream 0.995x -- only 12 %
     apart and the SAME HUE, so the chevron is drawn here as a luminance
     step in one map rather than as a second material.  Albedo comes from
     the pile's vertex tone (C.paver); this canvas is a near-neutral relief
     layer, exactly like the other maps in the module.
     Seamless BOTH axes: the 45-deg lattice uses 10 units of 18.102 px and
     22 courses of 8.228 px per 181.019 px diagonal, i.e. exactly one whole
     lattice per 256-px edge with EVEN course parity, so the running-bond
     half-offset survives the wrap. */
  var TILE_APRON = 10.4;

  function chevronTexture() {
    var size = 256, i, k, m;
    var c = global.document && document.createElement ? document.createElement('canvas') : null;
    if (!c) throw new Error('canvas unavailable');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var sc = 0; function R() { sc++; return hash(sc * 3.77 + 11); }
    g.fillStyle = '#ede9e4'; g.fillRect(0, 0, size, size);

    /* the sawtooth first, so the paver joints run straight over it */
    var b, j;
    for (b = 0; b < 2; b++) {
      var xc = 64 + 128 * b;
      for (j = -2; j < 4; j++) {
        var y0 = j * 128 + b * 64, dir = ((j + b) & 1) ? -1 : 1;
        g.fillStyle = 'rgba(74,58,50,0.155)';
        g.beginPath();
        g.moveTo(xc - 38 * dir, y0);
        g.lineTo(xc - 38 * dir, y0 + 128);
        g.lineTo(xc + 38 * dir, y0 + 64);
        g.closePath(); g.fill();
      }
    }

    /* the 45-degree running bond */
    var S = Math.SQRT1_2, du = 181.019 / 10, dv = 181.019 / 22;
    function jit(kk, mm) {
      return (hash((((kk % 22) + 22) % 22) * 31.7 + (((mm % 10) + 10) % 10) * 7.3 + 5) - 0.5) * 2.0;
    }
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(76,57,49,.34)'; g.lineWidth = 1.05;
    for (k = -24; k <= 24; k++) {
      var v = k * dv + jit(k, 0) * 0.35;
      g.beginPath();
      g.moveTo(S * (-40 + v), S * (-40 - v));
      g.lineTo(S * (420 + v), S * (420 - v));
      g.stroke();
    }
    g.strokeStyle = 'rgba(76,57,49,.30)'; g.lineWidth = 0.95;
    for (k = -24; k <= 24; k++) {
      var va = k * dv, vb = va + dv, off = ((((k % 2) + 2) % 2) ? du * 0.5 : 0);
      for (m = -3; m <= 23; m++) {
        var uu = m * du + off + jit(k, m);
        g.beginPath();
        g.moveTo(S * (uu + va), S * (uu - va));
        g.lineTo(S * (uu + vb), S * (uu - vb));
        g.stroke();
      }
    }

    /* wear: 300 stains and joint weed specks, kept 6 px clear of the edges
       so the wrap stays clean */
    for (i = 0; i < 300; i++) {
      var sx = 6 + R() * (size - 16), sy = 6 + R() * (size - 16);
      g.fillStyle = 'rgba(' + (58 + ((R() * 40) | 0)) + ',' + (48 + ((R() * 36) | 0)) +
        ',' + (42 + ((R() * 30) | 0)) + ',' + (0.03 + R() * 0.09).toFixed(3) + ')';
      g.fillRect(sx, sy, 1 + R() * 4, 1 + R() * 3);
    }
    for (i = 0; i < 70; i++) {
      g.fillStyle = 'rgba(84,96,58,' + (0.10 + R() * 0.22).toFixed(3) + ')';
      g.fillRect(6 + R() * (size - 16), 6 + R() * (size - 16), 1, 1 + R() * 2);
    }
    /* a soft blotchy settling so the 2.97 m repeat does not read as a grid */
    for (i = 0; i < 14; i++) {
      var bx = 8 + R() * (size - 16), by = 8 + R() * (size - 16), br = 14 + R() * 30;
      var gr = g.createRadialGradient(bx, by, 0, bx, by, br);
      gr.addColorStop(0, 'rgba(96,80,70,' + (0.05 + R() * 0.05).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(96,80,70,0)');
      g.fillStyle = gr; g.fillRect(bx - br, by - br, br * 2, br * 2);
    }

    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    try { tex.anisotropy = Math.min(8, renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4); } catch (e) { tex.anisotropy = 4; }
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true; OWN.tex.push(tex); STATS.textureBytes += size * size * 4;
    return tex;
  }

  /* Corrugated sheet, VERTICAL RIBS ONLY.  canvasTexture('roof') draws
     horizontal pantile lines as well, and pantiles are exactly what the
     shelters must not read as; the photographs call these roofs "red-brown
     tile/metal sheet" and the shelter roofs are plainly corrugated.  At
     P.roof.tile 8.6 the 32 ribs land at 0.269 u = 77 mm pitch. */
  function corrugatedTexture(size) {
    size = size || 256;
    var c = document.createElement('canvas'); c.width = c.height = size;
    var g = c.getContext('2d'), i, x;
    var sc = 0; function R() { sc++; return hash(sc * 3.77 + 29); }
    g.fillStyle = '#efe8e5'; g.fillRect(0, 0, size, size);
    var pitch = size / 32;
    for (x = 0; x < size; x += pitch) {
      var gr = g.createLinearGradient(x, 0, x + pitch, 0);
      gr.addColorStop(0.00, 'rgba(48,22,19,.46)');
      gr.addColorStop(0.16, 'rgba(48,22,19,.16)');
      gr.addColorStop(0.40, 'rgba(255,250,245,.22)');
      gr.addColorStop(0.66, 'rgba(255,250,245,.06)');
      gr.addColorStop(1.00, 'rgba(48,22,19,.46)');
      g.fillStyle = gr; g.fillRect(x, 0, pitch + 0.6, size);
    }
    /* weathering runs DOWN the ribs, never across them */
    for (i = 0; i < 90; i++) {
      var rx = Math.floor(R() * 32) * pitch + pitch * (0.2 + R() * 0.6);
      var ry = R() * size, rh = size * (0.10 + R() * 0.45);
      g.fillStyle = (i % 3 ? 'rgba(52,26,20,' : 'rgba(230,222,214,') + (0.03 + R() * 0.10).toFixed(3) + ')';
      g.fillRect(rx, ry, 0.8 + R() * 1.6, rh);
    }
    for (i = 0; i < 200; i++) {
      g.fillStyle = 'rgba(74,34,26,' + (0.03 + R() * 0.10).toFixed(3) + ')';
      g.fillRect(R() * size, R() * size, 1 + R() * 3, 1 + R() * 2);
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    try { tex.anisotropy = Math.min(8, renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4); } catch (e) { tex.anisotropy = 4; }
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true; OWN.tex.push(tex); STATS.textureBytes += size * size * 4;
    return tex;
  }

  /* Turf at two blade scales with six bare-soil blotches and a low-frequency
     clumping mottle, so that at P.grass.tile 5 (1.43 m repeat) the lawn does
     not read as one flat field with a grid in it. */
  function grassTexture(size) {
    size = size || 256;
    var c = document.createElement('canvas'); c.width = c.height = size;
    var g = c.getContext('2d'), i, dx, dy;
    var sc = 0; function R() { sc++; return hash(sc * 3.77 + 47); }
    g.fillStyle = '#e4e9df'; g.fillRect(0, 0, size, size);
    function blot(x, y, r, style) {
      for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) {
        var px = x + dx * size, py = y + dy * size;
        if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
        var gr = g.createRadialGradient(px, py, 0, px, py, r);
        gr.addColorStop(0, style); gr.addColorStop(1, style.replace(/[\d.]+\)$/, '0)'));
        g.fillStyle = gr; g.fillRect(px - r, py - r, r * 2, r * 2);
      }
    }
    for (i = 0; i < 22; i++)
      blot(R() * size, R() * size, 26 + R() * 46,
        (i % 2 ? 'rgba(118,132,92,0.' : 'rgba(214,218,196,0.') + (10 + ((R() * 8) | 0)) + ')');
    for (i = 0; i < 6; i++)
      blot(R() * size, R() * size, 16 + R() * 20, 'rgba(150,124,92,0.30)');
    for (i = 0; i < 380; i++) {
      var x1 = R() * size, y1 = R() * size, ln = 5 + R() * 9;
      g.strokeStyle = 'rgba(' + (52 + ((R() * 40) | 0)) + ',' + (74 + ((R() * 44) | 0)) +
        ',' + (38 + ((R() * 26) | 0)) + ',' + (0.16 + R() * 0.20).toFixed(3) + ')';
      g.lineWidth = 1.0 + R() * 1.2;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 + (R() - 0.5) * 4, y1 - ln); g.stroke();
    }
    for (i = 0; i < 900; i++) {
      var x2 = R() * size, y2 = R() * size, l2 = 2 + R() * 5;
      g.strokeStyle = 'rgba(' + (60 + ((R() * 60) | 0)) + ',' + (86 + ((R() * 56) | 0)) +
        ',' + (44 + ((R() * 30) | 0)) + ',' + (0.10 + R() * 0.16).toFixed(3) + ')';
      g.lineWidth = 0.4 + R() * 0.6;
      g.beginPath(); g.moveTo(x2, y2); g.lineTo(x2 + (R() - 0.5) * 3, y2 - l2); g.stroke();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    try { tex.anisotropy = Math.min(8, renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4); } catch (e) { tex.anisotropy = 4; }
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true; OWN.tex.push(tex); STATS.textureBytes += size * size * 4;
    return tex;
  }

  /* ---- the decal atlas -------------------------------------------------
     1024 x 512, eight 256-px cells, ClampToEdge.  Every emitter writes its
     own UVs, so a cell may carry several sub-rects.  TWO RULES BIND EVERY
     CELL: (1) THE MIP RULE -- a tile drawn only as thin strokes averages its
     alpha away three mip levels down and turns into grey haze, so everything
     carries a filled body under the strokes; (2) THE GUTTER RULE -- 12 px of
     fully transparent margin, because alpha-0 gutters erode the card edge
     under mipping instead of bleeding a neighbour's RGB in. */
  var MARK_TEX = null;
  var M_TEXT_A = null, M_TEXT_B = null, M_ARROW = null, M_DASH = null,
      M_GRATE = null, M_FASCIA = null, M_SIGN_DISC = null, M_SIGN_CHEV = null,
      M_SIGN_TRI = null, M_RAIL = null, M_WEED = null, M_STAIN = null,
      M_MANHOLE = null;

  function markAtlas() {
    var W = 1024, H = 512, i, k;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d'); g.clearRect(0, 0, W, H);
    var sc = 0; function R() { sc++; return hash(sc * 3.77 + 11); }
    function rect(x0, y0, x1, y1) { return [x0 / W, 1 - y1 / H, x1 / W, 1 - y0 / H]; }
    function fitText(s, font, x0, y0, x1, y1, fill, stroke, lw) {
      g.save();
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      var mw = g.measureText(s).width || 1;
      var fs = parseInt(font.replace(/[^0-9]/g, ''), 10) || 100;
      /* Arial caps are about 0.72 em; scale to the box on both axes. */
      var sx = (x1 - x0) / mw, sy = (y1 - y0) / (fs * 0.72);
      g.translate((x0 + x1) * 0.5, y1);
      g.scale(sx, sy);
      g.lineJoin = 'round';
      g.fillStyle = fill; g.fillText(s, 0, 0);
      if (stroke) { g.lineWidth = lw / Math.max(sx, sy); g.strokeStyle = stroke; g.strokeText(s, 0, 0); }
      g.restore();
    }
    function wear(x0, y0, x1, y1, n, amt) {
      g.save(); g.globalCompositeOperation = 'destination-out';
      for (var q = 0; q < n; q++) {
        g.fillStyle = 'rgba(0,0,0,' + (amt * (0.3 + R() * 0.7)).toFixed(3) + ')';
        g.fillRect(x0 + R() * (x1 - x0), y0 + R() * (y1 - y0), 1 + R() * 7, 1 + R() * 5);
      }
      g.restore();
    }

    /* 0  '233.'  white OUTLINE caps, 15.8 x 6.3 u  -------------------- */
    fitText('233.', 'bold 140px Arial', 14, 82, 242, 174,
            'rgba(252,250,244,0.74)', 'rgba(252,250,244,1)', 10);
    wear(14, 82, 242, 174, 60, 0.45);
    M_TEXT_A = rect(12, 78, 244, 178);

    /* 1  'Sk.'  8.0 x 6.3 u  ----------------------------------------- */
    fitText('Sk.', 'bold 140px Arial', 272, 40, 496, 216,
            'rgba(252,250,244,0.74)', 'rgba(252,250,244,1)', 10);
    wear(272, 40, 496, 216, 50, 0.45);
    M_TEXT_B = rect(268, 36, 500, 220);

    /* 2  worn arrow 7 x 12 u, plus a worn paint bar for edge and lane -- */
    g.save();
    g.fillStyle = 'rgba(250,248,242,0.95)';
    g.beginPath(); g.moveTo(582, 18); g.lineTo(626, 84); g.lineTo(598, 84);
    g.lineTo(598, 205); g.lineTo(566, 205); g.lineTo(566, 84); g.lineTo(538, 84);
    g.closePath(); g.fill();
    g.restore();
    wear(534, 14, 630, 209, 90, 0.7);
    M_ARROW = rect(524, 12, 640, 211);
    g.fillStyle = 'rgba(250,248,242,0.94)'; g.fillRect(524, 224, 232, 20);
    wear(524, 224, 756, 244, 70, 0.65);
    M_DASH = rect(524, 222, 756, 246);

    /* 3  slotted gully grate, 1.4 x 0.9 u ---------------------------- */
    g.fillStyle = 'rgba(30,30,28,0.97)'; g.fillRect(780, 12, 232, 149);
    g.strokeStyle = 'rgba(150,150,144,0.75)'; g.lineWidth = 5;
    g.strokeRect(783, 15, 226, 143);
    for (i = 0; i < 7; i++) {
      var sy0 = 26 + i * 19;
      g.fillStyle = 'rgba(6,6,6,1)'; g.fillRect(796, sy0, 200, 11);
      g.fillStyle = 'rgba(168,168,160,0.55)'; g.fillRect(796, sy0 + 11, 200, 3);
    }
    M_GRATE = rect(778, 10, 1014, 163);

    /* 4  reserved neutral fascia texture: plain aged render for any generic
          ground-floor band. ----------------------------------------------- */
    g.fillStyle = 'rgba(224,220,210,1)'; g.fillRect(12, 300, 232, 68);
    g.fillStyle = 'rgba(148,142,132,.34)'; g.fillRect(12, 300, 232, 4);
    g.fillRect(12, 364, 232, 4);
    wear(12, 300, 244, 368, 40, 0.28);
    M_FASCIA = rect(12, 298, 244, 370);

    /* 5  three junction signs -------------------------------------- */
    g.fillStyle = 'rgba(22,52,120,1)';
    g.beginPath(); g.arc(318, 318, 50, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(240,240,236,0.95)'; g.lineWidth = 5;
    g.beginPath(); g.arc(318, 318, 46, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(244,244,240,1)';
    g.beginPath(); g.moveTo(300, 296); g.lineTo(336, 318); g.lineTo(300, 340);
    g.closePath(); g.fill();
    g.fillRect(292, 310, 14, 16);
    M_SIGN_DISC = rect(266, 266, 370, 370);

    g.fillStyle = 'rgba(20,20,18,1)'; g.fillRect(384, 268, 76, 114);
    g.fillStyle = 'rgba(226,182,26,1)';
    for (i = 0; i < 3; i++) {
      var cy0 = 282 + i * 36;
      g.beginPath(); g.moveTo(392, cy0); g.lineTo(392, cy0 + 26);
      g.lineTo(420, cy0 + 13); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(422, cy0); g.lineTo(422, cy0 + 26);
      g.lineTo(450, cy0 + 13); g.closePath(); g.fill();
    }
    M_SIGN_CHEV = rect(382, 266, 462, 384);

    g.fillStyle = 'rgba(178,44,38,1)';
    g.beginPath(); g.moveTo(318, 390); g.lineTo(364, 468); g.lineTo(272, 468);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(244,242,236,1)';
    g.beginPath(); g.moveTo(318, 404); g.lineTo(352, 461); g.lineTo(284, 461);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(24,24,22,1)';
    g.fillRect(314, 424, 8, 22); g.fillRect(314, 450, 8, 7);
    M_SIGN_TRI = rect(270, 388, 366, 470);

    /* 6  an 8-baluster railing run at 0.385 u centres WITH the mid-height
          bulb.  3.08 x 3.5 u -- ONE CARD PER TILE-LENGTH, never u > 1. --*/
    var rx0 = 524, ry0 = 268, rw = 204, rh = 232, RB = 'rgba(10,10,9,1)';
    g.fillStyle = RB;
    g.fillRect(rx0, ry0, rw, 13);                 /* top rail   */
    g.fillRect(rx0, ry0 + 110, rw, 9);            /* mid rail   */
    g.fillRect(rx0, ry0 + rh - 12, rw, 12);       /* bottom rail*/
    for (i = 0; i < 8; i++) {
      var bx = rx0 + (i + 0.5) * (rw / 8);
      g.fillRect(bx - 3.5, ry0 + 10, 7, rh - 20);
      g.beginPath();
      g.moveTo(bx, ry0 + 148); g.lineTo(bx + 8, ry0 + 162);
      g.lineTo(bx, ry0 + 176); g.lineTo(bx - 8, ry0 + 162);
      g.closePath(); g.fill();
    }
    M_RAIL = rect(rx0 - 2, ry0 - 2, rx0 + rw + 2, ry0 + rh + 2);

    /* 7  weed tuft, oil stain, manhole cover ------------------------ */
    g.save(); g.lineCap = 'round';
    g.fillStyle = 'rgba(46,58,30,0.92)';
    g.beginPath(); g.moveTo(786, 366); g.lineTo(830, 322); g.lineTo(874, 366);
    g.closePath(); g.fill();
    for (i = 0; i < 34; i++) {
      var wx = 812 + (R() - 0.5) * 42, wh = 26 + R() * 44;
      g.strokeStyle = 'rgba(' + (66 + ((R() * 54) | 0)) + ',' + (92 + ((R() * 58) | 0)) +
        ',' + (40 + ((R() * 30) | 0)) + ',' + (0.72 + R() * 0.28).toFixed(2) + ')';
      g.lineWidth = 2.4 + R() * 2.6;
      g.beginPath(); g.moveTo(wx, 366);
      g.quadraticCurveTo(wx + (R() - 0.5) * 16, 366 - wh * 0.6, wx + (R() - 0.5) * 34, 366 - wh);
      g.stroke();
    }
    g.restore();
    M_WEED = rect(778, 268, 882, 370);

    g.fillStyle = 'rgba(72,66,58,0.86)';
    g.beginPath();
    for (i = 0; i <= 20; i++) {
      var a = i / 20 * Math.PI * 2, rr0 = 34 + R() * 18;
      var px = 948 + Math.cos(a) * rr0, py = 324 + Math.sin(a) * rr0 * 0.82;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
    for (i = 0; i < 9; i++) {
      g.fillStyle = 'rgba(78,72,62,' + (0.5 + R() * 0.4).toFixed(2) + ')';
      var dr = 4 + R() * 9;
      g.beginPath(); g.arc(948 + (R() - 0.5) * 108, 324 + (R() - 0.5) * 88, dr, 0, Math.PI * 2);
      g.fill();
    }
    M_STAIN = rect(892, 268, 1004, 380);

    g.fillStyle = 'rgba(96,94,88,0.98)';
    g.beginPath(); g.arc(838, 442, 56, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(150,148,140,0.8)'; g.lineWidth = 5;
    g.beginPath(); g.arc(838, 442, 50, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(52,50,46,0.9)'; g.lineWidth = 4;
    for (i = 0; i < 6; i++) {
      var an = i / 6 * Math.PI;
      g.beginPath();
      g.moveTo(838 - Math.cos(an) * 44, 442 - Math.sin(an) * 44);
      g.lineTo(838 + Math.cos(an) * 44, 442 + Math.sin(an) * 44);
      g.stroke();
    }
    M_MANHOLE = rect(780, 384, 896, 500);

    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    try { tex.anisotropy = Math.min(8, renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4); } catch (e) { tex.anisotropy = 4; }
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true; OWN.tex.push(tex); STATS.textureBytes += W * H * 4;
    MARK_TEX = tex; return tex;
  }

  function initPilesMaterials() {
    P={
      asphalt:new Pile('asphalt',10), paver:new Pile('paver',8.2), grass:new Pile('grass',5),
      apron:new Pile('apron',TILE_APRON),
      masonry:new Pile('masonry',8), stone:new Pile('stone',7), roof:new Pile('roof',8.6),
      wood:new Pile('wood',4), bark:new Pile('bark',3.2),
      metal:new Pile('metal',4), glass:new Pile('glass',8),
      foliage:new Pile('foliage',7), needle:new Pile('needle',1),
      mark:new Pile('mark',1),
      panel:new Pile('panel',1), vista:new Pile('vista',50)
    };
    /* Albedo comes from the pile's measured tint.  These maps are deliberately
       near-neutral relief/detail layers so map * vertexColor does not square
       every facade and road colour into mud. */
    var ta=canvasTexture('asphalt','#e7e8e6','#737776',128);
    /* paver at 256 keeps the drawn unit at 24 x 12 px, so at tile 8.2 it is
       0.77 x 0.38 u = 220 x 110 mm -- the real kilit tasi.  At the old
       128/tile 7 it rendered at 0.34 x 0.16 m and read as brickwork. */
    var tp=canvasTexture('paver','#ede9e4','rgba(76,57,49,.38)',256);
    var tg=grassTexture(256);
    var tc=chevronTexture();
    var tr=canvasTexture('render','#f0efe9','rgba(65,57,48,.10)',128);
    var ts=canvasTexture('stone','#ece9e4','rgba(68,57,49,.45)',128);
    var troof=corrugatedTexture(256);
    var tw=canvasTexture('wood','#eee7df','rgba(65,40,28,.42)',128);
    var tb=canvasTexture('bark','#d8cec0',null,128);
    var tf=canvasTexture('leaf','#e3e8df','rgba(74,103,67,.28)',128);
    SIGN_TEX=signTexture(); needleAtlas(); markAtlas();
    M={
      /* mission 4 only: a sunlit carriageway takes a broad grazing sheen off
         a 44-degree key, and 0.98 roughness has none at all.  The night
         mission keeps its matte road. */
      asphalt:material('asphalt',ta,SUNNY?.79:.98,0,{env:SUNNY?.56:.46}),
      paver:material('paver',tp,.97,0,{env:.54}),
      grass:material('grass',tg,1,0,{env:.48}),
      apron:material('apron',tc,.96,0,{env:.54}),
      masonry:material('render',tr,.96,0,{env:.56}),
      stone:material('stone',ts,1,0,{env:.49}),
      roof:material('roof',troof,.92,0,{env:.52}),
      wood:material('wood',tw,.92,0,{env:.55}),
      bark:material('bark',tb,1,0,{env:.40}),
      metal:material('metal',null,.62,.55,{env:.58}),
      glass:material('glass',null,.38,.05,{env:.48,transparent:true,opacity:.78,depthWrite:false,side:THREE.DoubleSide}),
      foliage:material('foliage',tf,1,0,{env:.40,side:THREE.DoubleSide}),
      /* alphaTest, not blending: an alpha-blended crown sorts against itself
         and every card fights the one behind it.  0.34 is low on purpose --
         the atlas carries an opaque body under the needles, so the cut is
         made by that body's edge and the crown survives its own mip chain. */
      needle:material('needle',NEEDLE_TEX,1,0,{env:.48,alphaTest:.34,side:THREE.DoubleSide}),
      /* road markings, gully grates, weeds, stains, rail runs and shop
         fascias all ride one atlas.  alphaTest, never blending. */
      mark:material('mark',MARK_TEX,.95,0,{env:.50,alphaTest:.42,side:THREE.DoubleSide}),
      panel:material('sign',SIGN_TEX,.75,0,{env:.62,transparent:true,opacity:1,alphaTest:.08,side:THREE.DoubleSide}),
      vista:new THREE.MeshBasicMaterial({vertexColors:true,fog:true,side:THREE.DoubleSide,transparent:false})
    };
    M.vista.name='nzday:street-park-vista'; OWN.mat.push(M.vista);
  }

  /* ---- road, kerbs, median and park ground ----------------------------- */
  function roadY(x,z) {
    var crown=0;
    if(x>=152&&x<=172)crown=.24*(1-Math.abs(x-162)/10);
    else if(x>=184&&x<=204)crown=.24*(1-Math.abs(x-194)/10);
    /* the new service street's own crown band.  Outside every band roadY
       returns grade(z)+.54, which is what a flat junction mouth wants. */
    else if(x>=271.31&&x<=292.69)crown=.24*(1-Math.abs(x-282)/10.69);
    /* The gameplay floor is quantised once per four-world-unit map column,
       whereas this visual ribbon is a continuous 7% grade.  A 0.54-unit
       clearance keeps it above the highest full-cell step and removes the
       dense transverse z-fighting bands that made the road resemble rails. */
    return grade(z)+.54+Math.max(0,crown);
  }

  function roadQuad(x0,x1,z0,z1,t) {
    poly(P.asphalt,[[x0,roadY(x0,z0),z0],[x1,roadY(x1,z0),z0],
      [x1,roadY(x1,z1),z1],[x0,roadY(x0,z1),z1]],
      [(x0+x1)*.5,grade((z0+z1)*.5)-2,(z0+z1)*.5],t);
  }

  function roadPatchQuad(x0,x1,z0,z1,t) {
    poly(P.asphalt,[[x0,roadY(x0,z0)+.038,z0],[x1,roadY(x1,z0)+.038,z0],
      [x1,roadY(x1,z1)+.038,z1],[x0,roadY(x0,z1)+.038,z1]],
      [(x0+x1)*.5,grade((z0+z1)*.5)-2,(z0+z1)*.5],t);
  }

  function medianHalf(z) {
    if(z<=202||z>=476)return .35;
    if(z<224)return lerp(.35,6,(z-202)/22);
    if(z>450)return lerp(6,.35,(z-450)/26);
    return 6;
  }

  /* Turkish precast bordur, counted off the joints in the reference: 0.50 m
     units, 0.15 m exposed face, UNPAINTED and NEUTRAL -- the only truly
     neutral surface in the scene, and getting it neutral is what makes the
     paving beside it read as rose rather than as terracotta.
     Three changes from the first pass.  (a) The step is 3.5 u (1 m, every
     other real joint) instead of 7; the existing 0.07 end trim is what reads
     as the joint.  (b) FOUR quads, not five: the back face is buried under
     pavement at grade+0.56 against a kerb top at grade+0.57, so 0.01 u of it
     is exposed and it is never seen.  `side` says which long face survives:
     +1 keeps the face on the +px side, -1 the -px side.  (c) P.stone, not
     P.masonry -- the 'stone' canvas draws 22-px courses with staggered 36-px
     perps, which at tile 7 is a transverse line every 1.20 u and a
     longitudinal every 1.97 u, i.e. the precast joint almost exactly, where
     the 'render' map is salt-and-pepper with no joints at all. */
  function curbSegment(a,b,width,height,t,side) {
    var dx=b[0]-a[0],dz=b[1]-a[1],len=Math.sqrt(dx*dx+dz*dz);if(len<.1)return;
    dx/=len;dz/=len;var px=-dz*width*.5,pz=dx*width*.5;
    var trim=.07,ax=a[0]+dx*trim,az=a[1]+dz*trim,bx=b[0]-dx*trim,bz=b[1]-dz*trim;
    var ya=grade(az)+.04,yb=grade(bz)+.04;
    var pts0=[[ax+px,ya,az+pz],[ax-px,ya,az-pz],[bx-px,yb,bz-pz],[bx+px,yb,bz+pz]];
    var pts1=[[ax+px,ya+height,az+pz],[ax-px,ya+height,az-pz],[bx-px,yb+height,bz-pz],[bx+px,yb+height,bz+pz]];
    var ref=[(ax+bx)*.5,(ya+yb)*.5+height*.45,(az+bz)*.5],i;
    /* side 0 keeps both long faces: the median turf sits 0.08 u below the
       kerb top, so there is nothing there to bury the back face in. */
    var drop=(side===0)?-1:((side===undefined||side>0)?1:3);
    poly(P.stone,pts1,[ref[0],ref[1]-2,ref[2]],t);
    for(i=0;i<4;i++){
      if(i===drop)continue;
      poly(P.stone,[pts0[i],pts0[(i+1)%4],pts1[(i+1)%4],pts1[i]],ref,t);
    }
    STATS.curbSegments++;
  }

  function curbLine(points,width,height,t,side) {
    for(var i=0;i<points.length-1;i++)curbSegment(points[i],points[i+1],width,height,t,side);
  }

  /* a kerb line at constant authored x (= constant world Z) */
  function straightCurb(x,z0,z1,side) {
    var pts=[],z;
    for(z=z0;z<z1;z+=3.5)pts.push([x,z]); pts.push([x,z1]);
    curbLine(pts,.62,.53,C.curb,side===undefined?1:side);
  }

  /* a kerb line at constant authored z (= constant world X): the return kerb
     round the mouth of the T-junction */
  function crossCurb(z,x0,x1,side) {
    var pts=[],x;
    for(x=x0;x<x1;x+=3.5)pts.push([x,z]); pts.push([x1,z]);
    curbLine(pts,.62,.53,C.curb,side===undefined?1:side);
  }

  /* ---- world-space helpers for the ground plane ------------------------
     Everything below is authored, and the transform is
         authored x = world Z ,  authored z = 740 - world X ,
         world X = 740 - authored z ,  world Z = authored x .
     wp() converts a WORLD point into the authored triple poly()/box() want,
     so the street reads in the coordinates the photographs are measured in
     and only one conversion can ever be got wrong. */
  function wp(wx, wy, wz) { return [wz, wy, AXIS_ORIGIN - wx]; }

  /* smooth value noise on one axis; used for settled, wavy paving */
  function wobble(t, seed, amp) {
    var i0 = Math.floor(t), f = t - i0;
    var a = rr(i0, seed, -1, 1), b = rr(i0 + 1, seed, -1, 1);
    f = f * f * (3 - 2 * f);
    return (a + (b - a) * f) * amp;
  }
  /* THE single source of surface height on the park apron.  chevronBand(),
     the border courses and the tree pits all sample it, so nothing on the
     apron can ever z-fight against anything else on the apron. */
  function apronY(wx) { return worldGrade(wx) + 0.56 + wobble(wx / 11, 7, 0.045); }

  /* ---- walkway: the direct-UV paving emitter ---------------------------
     pts is a polyline of WORLD [X, Z] centres.  poly() planar-projects its
     UVs, so a curving path paved with poly() SWIMS -- the texture stays put
     while the ribbon turns.  This resamples a hand-written Catmull-Rom at
     4-u steps and writes u = +-width/(2*TILE_APRON), v = arcLength/TILE_APRON
     straight into the pile, which is what makes the paving follow the curve.
     opts: lift (default .56), yfn(wx,wz) -> finished surface y (overrides
     lift and the height wobble), wobble, widthWobble, seed, step, edge
     (default true), edgeTone, edgeStep.  Returns the sample array so a
     caller can hang tufts or bins off the run. */
  function walkway(pts, width, tone, opts) {
    opts = opts || {};
    var lift = opts.lift === undefined ? 0.56 : opts.lift;
    var yfn = opts.yfn || null;
    var amp = opts.wobble === undefined ? 0.045 : opts.wobble;
    var wamp = opts.widthWobble === undefined ? 0.15 : opts.widthWobble;
    var sd = opts.seed === undefined ? 3 : opts.seed;
    var step = opts.step || 4;
    var i, j, n = pts.length;
    if (n < 2) return null;

    function cr(p0, p1, p2, p3, t, k) {
      var t2 = t * t, t3 = t2 * t;
      return 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
    }
    var dense = [];
    for (i = 0; i < n - 1; i++) {
      var q0 = pts[i > 0 ? i - 1 : 0], q1 = pts[i], q2 = pts[i + 1];
      var q3 = pts[i + 2 < n ? i + 2 : n - 1];
      var dxx = q2[0] - q1[0], dzz = q2[1] - q1[1];
      var seg = Math.max(2, Math.ceil(Math.sqrt(dxx * dxx + dzz * dzz) / 2));
      for (j = 0; j < seg; j++) {
        var t = j / seg;
        dense.push([cr(q0, q1, q2, q3, t, 0), cr(q0, q1, q2, q3, t, 1)]);
      }
    }
    dense.push([pts[n - 1][0], pts[n - 1][1]]);

    var acc = 0, out = [[dense[0][0], dense[0][1], 0]];
    for (i = 1; i < dense.length; i++) {
      var ax2 = dense[i][0] - dense[i - 1][0], az2 = dense[i][1] - dense[i - 1][1];
      var d = Math.sqrt(ax2 * ax2 + az2 * az2);
      if (d < 1e-6) continue;
      acc += d; out.push([dense[i][0], dense[i][1], acc]);
    }
    if (!(acc > 0.5)) return null;
    var ns = Math.max(1, Math.round(acc / step)), samples = [], k = 1;
    for (i = 0; i <= ns; i++) {
      var target = acc * i / ns;
      while (k < out.length - 1 && out[k][2] < target) k++;
      var a0 = out[k - 1], a1 = out[k], sl = a1[2] - a0[2];
      var f2 = sl > 1e-6 ? (target - a0[2]) / sl : 0;
      samples.push([a0[0] + (a1[0] - a0[0]) * f2, a0[1] + (a1[1] - a0[1]) * f2, target]);
    }

    var pile = P.apron, L = [], Rt = [], edges = [];
    for (i = 0; i < samples.length; i++) {
      var s = samples[i];
      var pn = samples[Math.min(i + 1, samples.length - 1)];
      var pp = samples[Math.max(i - 1, 0)];
      var tx = pn[0] - pp[0], tz = pn[1] - pp[1];
      var tl = Math.sqrt(tx * tx + tz * tz) || 1; tx /= tl; tz /= tl;
      var nx = -tz, nz = tx;
      var hw = width * 0.5 + wobble(s[2] / 13, sd + 1, wamp);
      var lx = s[0] + nx * hw, lz = s[1] + nz * hw;
      var rx = s[0] - nx * hw, rz = s[1] - nz * hw;
      var yl, yr;
      if (yfn) { yl = yfn(lx, lz); yr = yfn(rx, rz); }
      else {
        var w2 = wobble(s[2] / 11, sd, amp);
        yl = worldGrade(lx) + lift + w2; yr = worldGrade(rx) + lift + w2;
      }
      var uu = width / (2 * TILE_APRON), vv = s[2] / TILE_APRON;
      L.push(pile.v(lz, yl, AXIS_ORIGIN - lx, 0, 1, 0, -uu, vv, tone));
      Rt.push(pile.v(rz, yr, AXIS_ORIGIN - rx, 0, 1, 0, uu, vv, tone));
      edges.push([lx, lz, yl, rx, rz, yr, nx, nz]);
    }
    for (i = 0; i < samples.length - 1; i++) {
      pile.tri(L[i], L[i + 1], Rt[i + 1]);
      pile.tri(L[i], Rt[i + 1], Rt[i]);
    }

    /* The white precast edging strip, both sides.  It is present on both
       sides of every path and pad in the reference photographs and it is the
       brightest line in the composition -- it is what draws the curve. */
    if (opts.edge !== false) {
      var et = opts.edgeTone || C.edging, es = Math.max(1, opts.edgeStep || 1);
      var EW = 0.55, EH = 0.12, side, e0, e1;
      for (side = 0; side < 2; side++) {
        for (i = 0; i + es < edges.length; i += es) {
          e0 = edges[i]; e1 = edges[i + es];
          var sg = side ? -1 : 1;
          var i0x = side ? e0[3] : e0[0], i0z = side ? e0[4] : e0[1], i0y = side ? e0[5] : e0[2];
          var i1x = side ? e1[3] : e1[0], i1z = side ? e1[4] : e1[1], i1y = side ? e1[5] : e1[2];
          var o0x = i0x + e0[6] * sg * EW, o0z = i0z + e0[7] * sg * EW;
          var o1x = i1x + e1[6] * sg * EW, o1z = i1z + e1[7] * sg * EW;
          var mx = (i0x + o1x) * 0.5, mz = (i0z + o1z) * 0.5;
          poly(P.stone, [wp(i0x, i0y + EH, i0z), wp(i1x, i1y + EH, i1z),
                         wp(o1x, i1y + EH, o1z), wp(o0x, i0y + EH, o0z)],
               wp(mx, (i0y + i1y) * 0.5 - 2, mz), et);
          poly(P.stone, [wp(o0x, i0y - 0.10, o0z), wp(o0x, i0y + EH, o0z),
                         wp(o1x, i1y + EH, o1z), wp(o1x, i1y - 0.10, o1z)],
               wp((i0x + i1x) * 0.5, (i0y + i1y) * 0.5, (i0z + i1z) * 0.5), et);
        }
      }
    }
    return samples;
  }

  /* ---- railRun -- the picnic terrace railing as alpha cards ------------
     220 modelled balusters is 2,200 triangles for one object.  One M_RAIL
     card per 3.08-u tile plus three continuous rail tubes is 58 triangles
     for the same 33-u run, and at 2 m the mid-height bulb is legible because
     it is drawn at 256 px rather than modelled at six sides.  MARK_TEX is
     ClampToEdge, so it is ONE CARD PER TILE-LENGTH and never u > 1.
     JOB A defines this and never calls it; JOB C calls it. */
  function railRun(wx0, wz0, wx1, wz1, height, tone, baseY) {
    var dx = wx1 - wx0, dz = wz1 - wz0, len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > 0.2)) return;
    dx /= len; dz /= len;
    var tile = 3.08, nT = Math.max(1, Math.round(len / tile)), i;
    var t = tone || C.railBlack;
    /* baseY: omit for ground level, pass a number for a level deck, or pass
       a function(wx,wz) to follow one -- JOB C's terrace deck sits 0.55 u up. */
    var y0fn = typeof baseY === 'function' ? baseY
             : typeof baseY === 'number' ? function () { return baseY; }
             : function (wx) { return grade(AXIS_ORIGIN - wx) + 0.56; };
    for (i = 0; i < nT; i++) {
      var cq = (i + 0.5) / nT;
      var cx = wx0 + dx * len * cq, cz = wz0 + dz * len * cq;
      var hw = len / nT * 0.5, y = y0fn(cx, cz);
      ncard(P.mark, cz, y + height * 0.5, AXIS_ORIGIN - cx,
            dz * hw, 0, -dx * hw, 0, height * 0.5, 0, M_RAIL, t);
    }
    for (i = 0; i < 3; i++) {
      var hy = height * (i === 0 ? 0.985 : i === 1 ? 0.50 : 0.045);
      tube(P.metal, [wz0, y0fn(wx0, wz0) + hy, AXIS_ORIGIN - wx0],
           [wz1, y0fn(wx1, wz1) + hy, AXIS_ORIGIN - wx1], 0.10, 5, t, false);
    }
  }

  /* ---- decals ---------------------------------------------------------- */
  /* a horizontal alpha card lying on the ground.  lx runs along WORLD X,
     lz across it on WORLD Z; the texture's reading direction is world +X and
     the top of the glyph points NORTH, which is how the street name is
     painted in every reference frame. */
  /* THE CARD MUST LIE IN THE ROAD PLANE, NOT LEVEL.  worldGrade falls a
     constant 0.07 u per world X across this module's whole reach, so a card
     emitted at one height is buried in its own western half: the 15.8-u
     "233." swings 1.11 u end to end and measured 45% of its length under the
     asphalt, which is why it read as "33.".  The along-X half-axis carries
     that slope; the across-Z crown term is under 0.08 u over a card and is
     left flat. */
  function markDecal(wx, wz, lx, lz, y, rect, tone) {
    ncard(P.mark, wz, y, AXIS_ORIGIN - wx,
          0, -0.07 * lx * 0.5, -lx * 0.5, -lz * 0.5, 0, 0, rect, tone || C.paint);
    STATS.marks++;
  }
  function markCard(wx, wz, lx, lz, yoff, rect, tone) {
    markDecal(wx, wz, lx, lz, roadY(wz, AXIS_ORIGIN - wx) + (yoff === undefined ? 0.05 : yoff),
              rect, tone);
  }
  function roadText(wx, wz, lx, lz, rect) { markCard(wx, wz, lx, lz, 0.05, rect, C.paint); }

  /* a kerbside gully: one grate card in the gutter plus a sunken precast
     block, so the kerb line is broken exactly where water goes */
  function gully(wx, kerbZ, roadSide) {
    var az = AXIS_ORIGIN - wx, gy = grade(az);
    var gz = kerbZ + roadSide * 1.05;
    markDecal(wx, gz, 1.4, 0.9, roadY(gz, az) + 0.05, M_GRATE, C.curb);
    box(P.stone, kerbZ + roadSide * 0.34, gy + 0.04, az - 1.75,
        kerbZ + roadSide * 0.95, gy + 0.40, az + 1.75, C.curb);
    STATS.gullies++;
  }

  /* THE THING THAT MAKES A ROAD READ AS A ROAD.  A kerb with no gutter line
     beside it looks like a paving edge; 1.2 u of darker asphalt hugging the
     inside of every kerb is what fixes it.  Emitted 0.03 u PROUD rather than
     0.02 u sunk as first drafted -- sunk means coplanar with the carriageway
     and the whole ribbon z-fights. */
  function gutterChannel(kerbZ, roadSide, az0, az1) {
    var a = kerbZ + roadSide * 0.31, b = kerbZ + roadSide * 1.51;
    poly(P.asphalt, [[a, roadY(a, az0) + 0.030, az0], [b, roadY(b, az0) + 0.030, az0],
                     [b, roadY(b, az1) + 0.030, az1], [a, roadY(a, az1) + 0.030, az1]],
         [(a + b) * .5, grade((az0 + az1) * .5) - 2, (az0 + az1) * .5], C.gutter);
  }

  function wheelTracks(wz, wx0, wx1, w) {
    roadPatchQuad(wz - w * 0.5, wz + w * 0.5, AXIS_ORIGIN - wx1, AXIS_ORIGIN - wx0, C.asphaltPale);
  }

  function oilStains(n, seed, wz0, wz1, wx0, wx1) {
    for (var i = 0; i < n; i++) {
      var wx = rr(i + seed, 4, wx0, wx1), wz = rr(i + seed, 5, wz0, wz1);
      var s = rr(i + seed, 6, 2.4, 5.6);
      markDecal(wx, wz, s, s * rr(i + seed, 7, 0.7, 1.3),
                roadY(wz, AXIS_ORIGIN - wx) + 0.045, M_STAIN, C.asphaltDark);
    }
  }

  /* An octagonal soil pit with the white precast edging round it, a grate
     and a weed collar.  The photographs show pines growing straight through
     the paving, and it is the pit -- not the tree -- that stops the apron
     reading as a slab. */
  function treePit(wx, wz, r) {
    var i, pts = [], y = apronY(wx);
    for (i = 0; i < 8; i++) {
      var a = (i + 0.5) / 8 * Math.PI * 2;
      pts.push(wp(wx + Math.cos(a) * r, y + 0.020, wz + Math.sin(a) * r));
    }
    poly(P.grass, pts, wp(wx, y - 2, wz), C.soil);
    for (i = 0; i < 8; i++) {
      var a0 = (i + 0.5) / 8 * Math.PI * 2, a1 = (i + 1.5) / 8 * Math.PI * 2;
      var x0 = wx + Math.cos(a0) * r, z0 = wz + Math.sin(a0) * r;
      var x1 = wx + Math.cos(a1) * r, z1 = wz + Math.sin(a1) * r;
      var o0x = wx + Math.cos(a0) * (r + 0.55), o0z = wz + Math.sin(a0) * (r + 0.55);
      var o1x = wx + Math.cos(a1) * (r + 0.55), o1z = wz + Math.sin(a1) * (r + 0.55);
      poly(P.stone, [wp(x0, y + 0.12, z0), wp(x1, y + 0.12, z1),
                     wp(o1x, y + 0.12, o1z), wp(o0x, y + 0.12, o0z)],
           wp(wx, y - 2, wz), C.edging);
      poly(P.stone, [wp(o0x, y - 0.10, o0z), wp(o0x, y + 0.12, o0z),
                     wp(o1x, y + 0.12, o1z), wp(o1x, y - 0.10, o1z)],
           wp(wx, y, wz), C.edging);
    }
    markDecal(wx + r * 0.52, wz - r * 0.42, 1.4, 0.9, y + 0.05, M_GRATE, C.curb);
    for (i = 0; i < 3; i++) {
      var wa = rr(i, wx, 0, Math.PI * 2), wr = r * rr(i, wz, 0.55, 0.92);
      ncross(P.mark, wz + Math.sin(wa) * wr, y + 0.02, AXIS_ORIGIN - (wx + Math.cos(wa) * wr),
             1.7, rr(i, wx + 3, 1.5, 2.6), wa, M_WEED, C.grassDry);
    }
    STATS.pits++;
  }

  /* the chevron as GEOMETRY on top of the chevron in the map.  Not
     redundant: the texture chevron mips to flat rose past about 25 m, and
     the chevron converging with the hedge top is the strongest perspective
     cue in the along-the-apron composition.  Geometry survives every mip. */
  function chevronBand(wx0, wx1, wzc, pitch, amp, tone) {
    var n = Math.floor((wx1 - wx0) / pitch), i;
    for (i = 0; i < n; i++) {
      var xa = wx0 + i * pitch, xb = xa + pitch, xm = (xa + xb) * 0.5;
      var s = (i & 1) ? -1 : 1;
      var za = wzc - amp * 0.5 * s, zb = wzc + amp * 0.5 * s;
      poly(P.apron, [wp(xa, apronY(xa) + 0.030, za), wp(xb, apronY(xb) + 0.030, za),
                     wp(xm, apronY(xm) + 0.030, zb)],
           wp(xm, apronY(xm) - 2, wzc), tone);
    }
  }

  /* the plain cream border course.  Its inner edge follows the settled
     apron field exactly, its outer edge sits flat against the kerb or the
     lawn edging, so neither joint can open a crack. */
  function apronBorder(wx0, wx1, wzIn, wzOut) {
    var n = Math.max(1, Math.round((wx1 - wx0) / 16)), i;
    for (i = 0; i < n; i++) {
      var xa = wx0 + (wx1 - wx0) * i / n, xb = wx0 + (wx1 - wx0) * (i + 1) / n;
      poly(P.paver, [wp(xa, apronY(xa), wzIn), wp(xb, apronY(xb), wzIn),
                     wp(xb, worldGrade(xb) + 0.56, wzOut), wp(xa, worldGrade(xa) + 0.56, wzOut)],
           wp((xa + xb) * 0.5, worldGrade((xa + xb) * 0.5) - 2, (wzIn + wzOut) * 0.5),
           C.paverCream);
    }
  }

  function trafficSign(wx, wz) {
    var az = AXIS_ORIGIN - wx, ax = wz, y = grade(az) + 0.58;
    tube(P.metal, [ax - 1.0, y, az], [ax - 1.0, y + 9.2, az], 0.13, 5, C.stainless, false);
    tube(P.metal, [ax + 1.0, y, az], [ax + 1.0, y + 9.2, az], 0.13, 5, C.stainless, false);
    ncard(P.mark, ax, y + 7.70, az, 1.05, 0, 0, 0, 1.05, 0, M_SIGN_DISC, C.white);
    ncard(P.mark, ax, y + 4.55, az, 1.05, 0, 0, 0, 1.575, 0, M_SIGN_CHEV, C.white);
    STATS.marks += 2;
  }

  /* ---- JOB A: the ground plane ---------------------------------------- */
  function buildRoadway() {
    var i, z;

    /* THE NORTH HALF OF 233 SK.  Nothing moves.  The "dual carriageway with
       a median" already is, element for element, the photographed cross
       section of this street; it only ever needed re-dressing. */
    roadQuad(152, 162, 192, 480, C.asphalt); roadQuad(162, 172, 192, 480, C.asphalt);
    roadQuad(172, 184, 192, 480, C.asphaltDark);
    roadQuad(184, 194, 192, 480, C.asphalt); roadQuad(194, 204, 192, 480, C.asphalt);
    surf(P.paver, 144, 152, 192, 480, .56, C.paverTan);
    straightCurb(152, 192, 480, -1);

    /* Tapered median grass and its genuinely segmented precast kerbs.  Both
       long faces stay on these: the median turf sits 0.08 u below the kerb
       top, so a dropped back face would show a slot across the verge. */
    var zs = [];
    for (z = 202; z < 476; z += 7) zs.push(z); zs.push(476);
    for (i = 0; i < zs.length - 1; i++) {
      var z0 = zs[i], z1 = zs[i + 1], h0 = medianHalf(z0), h1 = medianHalf(z1);
      poly(P.grass, [[178 - h0, grade(z0) + .49, z0], [178 + h0, grade(z0) + .49, z0],
        [178 + h1, grade(z1) + .49, z1], [178 - h1, grade(z1) + .49, z1]],
        [178, grade((z0 + z1) * .5) - 2, (z0 + z1) * .5], C.grass);
    }
    var left = [], right = [];
    for (i = 0; i < zs.length; i++) {
      left.push([178 - medianHalf(zs[i]), zs[i]]);
      right.push([178 + medianHalf(zs[i]), zs[i]]);
    }
    curbLine(left, .6, .53, C.curb, 0); curbLine(right, .6, .53, C.curb, 0);

    /* THE SERVICE STREET, world Z 271.31..292.69 over world X 268..484,
       turning into the widened 232 Sk mouth at world X 484..500.5. */
    roadQuad(271.31, 282.00, 256, 472, C.asphalt);
    roadQuad(282.00, 292.69, 256, 472, C.asphalt);
    roadQuad(204, 237.5, 239.5, 256, C.asphalt);
    roadQuad(237.5, 271.0, 239.5, 256, C.asphalt);
    roadQuad(271.0, 292.69, 239.5, 256, C.asphalt); /* the junction's own corner */
    straightCurb(271, 256, 472, -1);
    straightCurb(293, 239.5, 472, 1);
    crossCurb(239.5, 212, 271, 1);                  /* return at west road kerb */

    /* margins and footways */
    var SLAB = mixColor(C.curb, C.paverCream, .42);          /* plain grey slab */
    surf(P.paver, 265, 271, 256, 472, .56, C.paverCream);    /* north margin  */
    surf(P.paver, 293.2, 299, 256, 472, .56, SLAB);          /* block footway */

    /* THE PARK APRON, widened 8 u -> 12 u: world Z 204..216, X 268..484.
       Rose chevron field between two plain cream border courses, laid with
       walkway() so the paving keeps its own UVs and never swims. */
    walkway([[268, 210], [484, 210]], 7.6, C.paver,
            { yfn: apronY, edge: false, seed: 5, step: 8, widthWobble: 0.15 });
    apronBorder(268, 484, 206.7, 204.35);   /* against the kerb  */
    apronBorder(268, 484, 213.3, 216.00);   /* against the lawn  */
    /* The geometry chevron takes its UVs from poly()'s planar projection,
       lands it on the map's own drawn chevron -- i.e. on the DARK 15 % --
       where the walkway's UVs put the field on the plain rose.  Measured in
       render, C.paverCream on these triangles came back at 0.80x road
       against the field's 1.19, so the motif tone is lifted to land the
       geometry chevron near 0.90: still a clear step below the rose (the
       photographs measure rose 1.143 against cream motif 0.995, the SAME
       hue), and unlike the map chevron it survives every mip level, which
       is the entire reason this overlay exists. */
    var MOTIF = [C.paverCream[0] * 1.12, C.paverCream[1] * 1.12, C.paverCream[2] * 1.12];
    chevronBand(268.0, 484, 208.3, 6.5, 4.3, MOTIF);
    chevronBand(271.25, 484, 211.9, 6.5, 4.3, MOTIF);
    straightCurb(204, 256, 472, 1);

    /* GUTTERS.  1.2 u of darker asphalt inside every service kerb. */
    gutterChannel(271.31, 1, 256, 472);
    gutterChannel(292.69, -1, 239.5, 472);

    /* PARKING WEAR.  Z 152..172 is a parking lane, not a carriageway: no
       markings at all, two wheel-track polish strips and nine oil stains. */
    wheelTracks(158, 300, 520, 5.0);
    wheelTracks(166, 300, 520, 5.0);
    oilStains(9, 0, 154, 170, 296, 524);
    for (i = 0; i < 6; i++) {                  /* kerbside grit wedges */
      var gx = rr(i, 31, 280, 520), gw = rr(i, 32, 4.5, 11.0);
      poly(P.asphalt, [wp(gx, roadY(152.5, AXIS_ORIGIN - gx) + 0.036, 152.5),
                       wp(gx + gw, roadY(152.5, AXIS_ORIGIN - gx - gw) + 0.036, 152.5),
                       wp(gx + gw * 0.5, roadY(154.6, AXIS_ORIGIN - gx - gw * 0.5) + 0.036, 154.6)],
           wp(gx, grade(AXIS_ORIGIN - gx) - 2, 153.5), C.asphaltPale);
    }
    /* the service street's own parking lane, against the south kerb */
    roadPatchQuad(284.7, 292.7, 256, 472, mixColor(C.asphaltDark, C.asphalt, .35));
    oilStains(9, 60, 285, 292, 280, 480);

    /* Dark irregular utility patches.  The original 22 keep their seeds; the
       new 14 use rr(i+40, ...) so the two sets cannot collide. */
    for (i = 0; i < 22; i++) {
      var lane = i % 2 ? 194 : 162, cz = 207 + i * 11.7 + rr(i, 2, -3, 3);
      var w = rr(i, 3, 4.0, 8.5), l = rr(i, 4, 7, 17);
      var cx = lane + rr(i, 5, -5, 5), tt = i % 4 === 0 ? C.asphaltPale : C.asphaltDark;
      poly(P.asphalt, [[cx - w * .52, roadY(cx - w * .52, cz - l * .5) + .035, cz - l * .5],
        [cx + w * .44, roadY(cx + w * .44, cz - l * .45) + .035, cz - l * .45],
        [cx + w * .55, roadY(cx + w * .55, cz + l * .5) + .035, cz + l * .5],
        [cx - w * .43, roadY(cx - w * .43, cz + l * .42) + .035, cz + l * .42]],
        [cx, grade(cz) - 1, cz], tt); STATS.roadPatches++;
    }
    for (i = 0; i < 14; i++) {
      var j = i + 40, sz = 224 + i * 17.4 + rr(j, 2, -4, 4);
      var sw = rr(j, 3, 4.0, 9.5), sl = rr(j, 4, 8, 19);
      var sx = 282 + rr(j, 5, -8, 8), st = i % 4 === 0 ? C.asphaltPale : C.asphaltDark;
      poly(P.asphalt, [[sx - sw * .52, roadY(sx - sw * .52, sz - sl * .5) + .035, sz - sl * .5],
        [sx + sw * .44, roadY(sx + sw * .44, sz - sl * .45) + .035, sz - sl * .45],
        [sx + sw * .55, roadY(sx + sw * .55, sz + sl * .5) + .035, sz + sl * .5],
        [sx - sw * .43, roadY(sx - sw * .43, sz + sl * .42) + .035, sz + sl * .42]],
        [sx, grade(sz) - 1, sz], st); STATS.roadPatches++;
    }
    /* Long trench reinstatements give the patching a municipal history. */
    roadPatchQuad(155.3, 157.2, 250, 359, C.asphaltDark);
    roadPatchQuad(198.1, 200.4, 327, 451, C.asphaltPale);
    roadPatchQuad(274.6, 276.9, 238, 366, C.asphaltDark);
    roadPatchQuad(288.2, 290.1, 300, 440, C.asphaltPale);

    /* ROAD MARKINGS.  On the park reach there is NO centre line and NO edge
       line; the only marking is the street name, painted large in white
       outline lettering, and it appears in four of the fifteen reference
       photographs.  Everything else is at the junction end. */
    roadText(352, 194, 15.8, 6.3, M_TEXT_A); roadText(370, 194, 8.0, 6.3, M_TEXT_B);
    roadText(462, 194, 15.8, 6.3, M_TEXT_A); roadText(480, 194, 8.0, 6.3, M_TEXT_B);
    /* 232 Sk owns the widened junction markings from world X 484 eastward. */

    /* GULLIES every 34 u along both service kerbs, and three manholes on the
       crown.  Sixteen gullies: a kerb line with no gully in it is a kerb. */
    for (i = 0; i < 6; i++) {
      gully(276 + i * 34, 271.31, 1);
      gully(288 + i * 34, 292.69, -1);
    }
    markCard(318, 282, 2.1, 2.1, 0.052, M_MANHOLE, C.curb);
    markCard(400, 282, 2.1, 2.1, 0.052, M_MANHOLE, C.curb);
    if (SUNNY || ROAD_DETAIL) sunRoadDetail();
  }

  /* =====================================================================
     MISSION 4 ONLY -- THE ROAD AS A SURFACE, NOT A PLANE.
     Under the overcast dome the carriageway had three tones and no
     longitudinal structure, and that was defensible: a white sky puts the
     same light on the wheel track and the crown and the difference between
     them is a couple of levels.  Under a 44-degree key it is not.  A real
     sunlit carriageway carries, in order of how much of the frame they own:
       * a POLISHED WHEEL-TRACK PAIR per lane -- bitumen brought to a shine
         by tyres, a clear stop above the matrix around it;
       * a DARKER, DIRTIER CENTRE between the tracks where nothing runs;
       * a PALE GRIT MARGIN inside every kerb, where the sweeper never
         reaches and the fines collect;
       * TAR BANDAGES -- crack sealant, the darkest and the smoothest thing
         on the road, laid at whatever angle the crack ran.
     All four are roadPatchQuad()s at the existing +0.038 patch lift, so they
     cost four triangles each and cannot z-fight the carriageway under them.
     Nothing in here is reached on mission 1.
     ================================================================== */
  function sunRoadDetail() {
    /* authored x = across the street, authored z = along it */
    var TRACK = mixColor(C.asphalt, C.asphaltPale, 0.70);
    var CENTRE = mixColor(C.asphalt, C.asphaltDark, 0.52);
    var GRIT = scaleT(C.asphaltPale, 0.96);
    var SEAL = scaleT(C.asphaltDark, 0.74);
    /* [lane centre, z0, z1, half-gauge]. 1.5 m track gauge = 5.25 u. */
    var LANE = [[157.0, 192, 480, 2.6], [167.0, 192, 480, 2.6],
                [189.0, 192, 480, 2.6], [199.0, 192, 480, 2.6],
                [276.6, 256, 472, 2.6], [287.4, 256, 472, 2.6]];
    var i, L;
    for (i = 0; i < LANE.length; i++) {
      L = LANE[i];
      /* the dirty middle first, so a track edge always wins over it */
      roadPatchQuad(L[0] - L[3] * 0.62, L[0] + L[3] * 0.62, L[1], L[2], CENTRE);
      roadPatchQuad(L[0] - L[3] - 1.35, L[0] - L[3] + 1.35, L[1], L[2], TRACK);
      roadPatchQuad(L[0] + L[3] - 1.35, L[0] + L[3] + 1.35, L[1], L[2], TRACK);
    }
    /* the grit margin inside each kerb line and each median face */
    var EDGE = [[152.10, 153.7, 192, 480], [202.5, 203.95, 192, 480],
                [172.05, 173.5, 202, 476], [182.6, 183.95, 202, 476],
                [271.40, 272.9, 256, 472], [291.3, 292.60, 239.5, 472]];
    for (i = 0; i < EDGE.length; i++)
      roadPatchQuad(EDGE[i][0], EDGE[i][1], EDGE[i][2], EDGE[i][3], GRIT);
    /* TAR BANDAGES.  Sixteen skewed ribbons, each one a sealed crack: they
       are the only thing on the carriageway that is not parallel to it, and
       that is what stops the whole surface reading as extruded. */
    for (i = 0; i < 16; i++) {
      var band = i % 3, xa, xb;
      if (band === 0) { xa = 152.4; xb = 171.6; }
      else if (band === 1) { xa = 184.4; xb = 203.6; }
      else { xa = 271.8; xb = 292.2; }
      var z0 = 200 + i * 17.3 + rr(i + 71, 3, -5, 5);
      var sk = rr(i + 71, 4, -7.5, 7.5), w = rr(i + 71, 5, 0.55, 1.15);
      var cut = rr(i + 71, 6, 0.35, 1.0);
      var xm = xa + (xb - xa) * (1 - cut);
      poly(P.asphalt, [[xm, roadY(xm, z0) + 0.041, z0],
                       [xb, roadY(xb, z0 + sk) + 0.041, z0 + sk],
                       [xb, roadY(xb, z0 + sk + w) + 0.041, z0 + sk + w],
                       [xm, roadY(xm, z0 + w) + 0.041, z0 + w]],
           [(xm + xb) * 0.5, grade(z0) - 2, z0], SEAL);
      STATS.roadPatches++;
    }
  }

  /* ---- JOB A: everything that stands on the street --------------------- */
  function plantStreet() {
    var i;
    /* The existing pine row on the central grass verge, world Z 178.  It is
       part of the photographed cross-section and does not move; the seeds are
       the shipped ones so the row is unchanged frame for frame.  The gap in
       it keeps the roundabout-end tree below the driver's vanishing line. */
    var medZ = [232, 265, 299, 335, 373, 390, 447];
    for (i = 0; i < medZ.length; i++) {
      var mh = i === 0 ? rr(i, 9, 16, 19) : rr(i, 9, 20, 28);
      var mr = i === 0 ? rr(i, 10, 3.8, 4.6) : rr(i, 10, 5.0, 6.7);
      evergreen(178 + rr(i, 8, -.8, .8), medZ[i], mh, mr, true);
    }
    /* Pines standing IN the paved apron -- the photographs are explicit that
       they grow straight through it.  NOTHING between world X 310 and 326:
       that is the arena-door sightline corridor the module already protects. */
    var PINE = [[452, 30, 8.5], [392, 33, 9.2], [344, 28, 8.0],
                [296, 31, 8.8]];
    for (i = 0; i < PINE.length; i++) {
      evergreen(210, PINE[i][0], PINE[i][1], PINE[i][2], false);
      treePit(AXIS_ORIGIN - PINE[i][0], 210, 2.0);
    }
    /* spring blossom in the lawn's south fringe -- the verge read */
    deciduous(262, 440, 17, 5.0, true); deciduous(262, 368, 16, 4.6, true);
    deciduous(262, 296, 18, 5.2, true); deciduous(262, 240, 16, 4.8, true);

    /* Tall grey swan-neck columns, stepping down alternate sides.  There are
       NO short park bollard lamps and NO post-top lanterns anywhere here. */
    lamp(210, 416, -1); lamp(210, 272, -1);
    lamp(268, 440, 1); lamp(296, 368, -1);

    trafficSign(478, 208);

    /* weeds in the apron joints and stains along the kerb line */
    for (i = 0; i < 12; i++) {
      var wx = rr(i, 71, 272, 480), wz = 204.6 + rr(i, 72, 0, 10.6);
      ncross(P.mark, wz, apronY(wx) + 0.02, AXIS_ORIGIN - wx,
             1.5, rr(i, 73, 1.2, 2.4), rr(i, 74, 0, 3.14), M_WEED, C.grassDry);
    }
    for (i = 0; i < 6; i++) {
      var sx = rr(i, 75, 280, 476);
      markDecal(sx, 204.9, 3.4, 2.0, apronY(sx) + 0.022, M_STAIN, C.asphaltDark);
    }

    /* OCCLUDERS.  nz-street-sky.js SILENTLY DISCARDS any box over 26 u, so
       every one of these is chopped.  JOB A's allocation is five. */
    occ(322.4, 43.8, 200.0, 327.4, 47.4, 211.5);   /* lamp arm, world X 324 */
    occ(466.4, 33.6, 200.0, 471.4, 37.2, 211.5);   /* lamp arm, world X 468 */
    occ(279.5, 31.0, 201.5, 296.5, 49.0, 218.5);   /* apron pine crown X 288 */
    occ(388.0, 22.0, 202.0, 404.0, 40.0, 218.0);   /* apron pine crown X 396 */
  }


  /* ---- the needle atlas ------------------------------------------------
     The park's trees used to be stacks of solid ellipsoids under a tiling
     "leaf" map, which from any acceptance camera is a toy Christmas tree --
     the exact complaint the owner's photographs answer.  Yildiz Tepesi is
     planted with Pinus nigra and one big Cedrus at the roundabout, and both
     are read almost entirely off their SILHOUETTE: a bare reddish stem, then
     dark tufted masses with sky between them.  That needs an alpha cutout,
     so this is a 2 x 2 atlas of canvas strokes -- a pine tuft, a cedar spray,
     an opaque near-black interior mass and an upright candle -- with the
     alpha coming out of the strokes.

     THE MIP TRAP (learned in nz-street-props.js): a tile drawn only as thin
     strokes averages its alpha away three mip levels down and the crown turns
     into a grey haze.  Every tile therefore carries a FILLED dark body under
     the needles, and the needles are only the edge. */
  var NEEDLE_TEX=null, NRECT=[];
  var N_PINE=0, N_SPRAY=1, N_MASS=2, N_CANDLE=3;
  /* JOB B extends the atlas from 2x2 to 3x3.  cell() and push() were already
     parameterised by N and res, so NRECT recomputes and cells 0-3 keep their
     meaning exactly; cell 8 is reserved.  Extending here rather than adding a
     `leaf` pile is why the park gets alpha ground cover for ZERO new draws. */
  var N_GRASS=4, N_GRASSDRY=5, N_HEDGE=6, N_SHRUB=7;

  function needleAtlas() {
    var res=768, N=3, ts=res/N;
    var c=document.createElement('canvas'); c.width=c.height=res;
    var g=c.getContext('2d'); g.clearRect(0,0,res,res);
    var sc=0; function R(){ sc++; return hash(sc*3.77+11); }
    function cell(i){ return [(i%N)*ts, Math.floor(i/N)*ts]; }
    function push(i){ var o=cell(i), pad=ts*0.03;
      NRECT[i]=[(o[0]+pad)/res, 1-(o[1]+ts-pad)/res, (o[0]+ts-pad)/res, 1-(o[1]+pad)/res]; }

    /* a pine tuft: a short woody stub with a dense fan of long needles at its
       end, which is what a Pinus nigra shoot actually is */
    function pineTuft(i, cols, body, nn, fan) {
      var o=cell(i), x0=o[0]+ts*0.06, y0=o[1]+ts*0.50, k;
      g.save(); g.lineCap='round'; g.lineJoin='round';
      g.fillStyle=body;
      g.beginPath();
      g.moveTo(x0, y0);
      for(k=0;k<=14;k++){ var t=k/14;
        g.lineTo(x0+ts*0.90*t, y0 - ts*0.30*Math.sin(t*Math.PI)*(0.55+0.45*R())); }
      for(k=14;k>=0;k--){ var t2=k/14;
        g.lineTo(x0+ts*0.90*t2, y0 + ts*0.30*Math.sin(t2*Math.PI)*(0.55+0.45*R())); }
      g.closePath(); g.fill();
      g.strokeStyle='rgba(44,36,28,1)'; g.lineWidth=ts*0.030;
      g.beginPath(); g.moveTo(x0,y0); g.lineTo(x0+ts*0.42,y0); g.stroke();
      for(k=0;k<nn;k++){
        var t3=0.22+0.78*Math.pow(R(),0.62);
        var bx=x0+ts*0.86*t3, by=y0+(R()-0.5)*ts*0.34*Math.sin(t3*Math.PI);
        var an=(R()-0.5)*fan + (R()<0.5?0.10:-0.10);
        var ln=ts*(0.13+R()*0.20)*(1.05-0.35*t3);
        g.strokeStyle=cols[(R()*cols.length)|0];
        g.lineWidth=ts*(0.010+R()*0.009);
        g.beginPath(); g.moveTo(bx,by);
        g.lineTo(bx+Math.cos(an)*ln*1.2, by+Math.sin(an)*ln);
        g.stroke();
      }
      g.restore(); push(i);
    }

    /* an opaque interior mass with a ragged needled rim */
    function massTile(i, cols, body, n) {
      var o=cell(i), cx=o[0]+ts*0.5, cy=o[1]+ts*0.5, k;
      g.save(); g.lineCap='round';
      g.fillStyle=body; g.beginPath();
      for(k=0;k<=24;k++){ var a=k/24*Math.PI*2, rad=ts*(0.29+0.14*R());
        var px=cx+Math.cos(a)*rad, py=cy+Math.sin(a)*rad*0.88;
        if(k===0)g.moveTo(px,py); else g.lineTo(px,py); }
      g.closePath(); g.fill();
      for(k=0;k<n;k++){
        var a2=R()*Math.PI*2, r2=ts*0.44*Math.pow(R(),0.58);
        var bx=cx+Math.cos(a2)*r2, by=cy+Math.sin(a2)*r2*0.88;
        var ln=ts*(0.05+R()*0.10), an=R()*Math.PI*2;
        g.strokeStyle=cols[(R()*cols.length)|0]; g.lineWidth=ts*(0.013+R()*0.011);
        g.beginPath(); g.moveTo(bx,by); g.lineTo(bx+Math.cos(an)*ln,by+Math.sin(an)*ln); g.stroke();
      }
      g.restore(); push(i);
    }

    /* upright candles: the short vertical shoots that give a cedar plate its
       fuzzy top edge and a pine crown its broken outline */
    function candles(i, cols, body, n) {
      var o=cell(i), base=o[1]+ts*0.96, cx=o[0]+ts*0.5, k;
      g.save(); g.lineCap='round';
      for(k=0;k<n;k++){
        var sx=cx+(R()-0.5)*ts*0.80;
        var hh=ts*(0.28+R()*0.52), lean=(R()-0.5)*ts*0.12;
        g.strokeStyle=body; g.lineWidth=ts*(0.045+R()*0.045);
        g.beginPath(); g.moveTo(sx,base);
        g.quadraticCurveTo(sx+lean*0.4, base-hh*0.6, sx+lean, base-hh); g.stroke();
        for(var q=0;q<10;q++){
          var tq=0.15+0.85*R();
          var nx2=sx+lean*tq, ny2=base-hh*tq;
          var side=R()<0.5?1:-1, nl=ts*(0.035+R()*0.055);
          g.strokeStyle=cols[(R()*cols.length)|0]; g.lineWidth=ts*(0.009+R()*0.008);
          g.beginPath(); g.moveTo(nx2,ny2);
          g.lineTo(nx2+side*nl, ny2-nl*(0.5+R()*0.9)); g.stroke();
        }
      }
      g.restore(); push(i);
    }

    /* Konya, early spring, overcast.  A black pine reads 30-60/255 and the
       shaded interior is nearly black; the cedar is a touch bluer. */
    /* CALIBRATED, not chosen.  Sampled over the whole crown silhouette of
        _ref photos 11, 12, 13 and 6, a Konya black pine under this overcast
        measures rgb 58-62 / 65-69 / 41-43 -- luminance about 62, green 12 %
        above red and blue only 60 % of green.  The first pass ran a
        near-neutral 24,35,28 body and the crowns came back at luminance 37
        with blue at 82 % of green: 1.7 stops dark and barely green at all,
        i.e. a black cut-out rather than foliage.  These are the photograph's
        own numbers walked back through the bake. */
    var PINE=['rgba(140,172,106,1)','rgba(120,150,92,1)','rgba(168,200,128,1)','rgba(104,132,84,1)'];
    var CEDR=['rgba(146,178,116,1)','rgba(126,158,100,1)','rgba(174,206,138,1)','rgba(110,140,94,1)'];
    pineTuft(N_PINE, PINE, 'rgba(96,124,74,1)', 130, 1.65);
    pineTuft(N_SPRAY, CEDR, 'rgba(102,130,82,1)', 115, 0.95);
    massTile(N_MASS, PINE, 'rgba(74,98,58,1)', 190);
    candles(N_CANDLE, CEDR, 'rgba(112,142,88,1)', 7);

    /* ---- JOB B: the ground-cover cells ------------------------------
       Cells 0-3 are drawn SATURATED and TCOL multiplies them down.  These
       four are drawn PALE AND NEAR-NEUTRAL on purpose, so that the pile's
       vertex tone (C.grass / C.grassDry / C.hedge / C.shrub) IS the albedo
       -- which is the only way the C table's ratios mean anything on a card.
       THE MIP RULE still binds every one of them: a filled opaque body
       under the strokes, or the tile averages its alpha away three mip
       levels down and turns into grey haze.  12 px of transparent gutter. */
    function ell(x, y, rx, ry, rot) {
      /* CanvasRenderingContext2D.ellipse is not universal; arc under a
         scaled transform is.  A leaf tip is an ellipse, not a disc. */
      g.save(); g.translate(x, y); g.rotate(rot); g.scale(rx / ry, 1);
      g.beginPath(); g.arc(0, 0, ry, 0, Math.PI * 2); g.fill(); g.restore();
    }

    /* a fan of blades rising from v0 over an opaque root wedge */
    function grassTile(i, body, blades, n, tall) {
      var o = cell(i), m = 12, k, t;
      var x0 = o[0] + m, x1 = o[0] + ts - m, b0 = o[1] + ts - m;
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
      g.fillStyle = body; g.beginPath(); g.moveTo(x0, b0);
      for (k = 0; k <= 12; k++) {
        t = k / 12;
        g.lineTo(x0 + (x1 - x0) * t,
                 b0 - ts * (0.09 + 0.14 * R()) * Math.sin(Math.PI * (0.22 + 0.78 * t)));
      }
      g.lineTo(x1, b0); g.closePath(); g.fill();
      for (k = 0; k < n; k++) {
        var sx = x0 + (x1 - x0) * R();
        var hw = ts * (0.011 + R() * 0.015), hh = ts * tall * (0.42 + 0.58 * R());
        var lean = (R() - 0.5) * ts * 0.34;
        g.fillStyle = blades[(R() * blades.length) | 0];
        g.beginPath(); g.moveTo(sx - hw, b0);
        g.quadraticCurveTo(sx - hw + lean * 0.30, b0 - hh * 0.60, sx + lean, b0 - hh);
        g.quadraticCurveTo(sx + hw + lean * 0.40, b0 - hh * 0.58, sx + hw, b0);
        g.closePath(); g.fill();
      }
      g.restore(); push(i);
    }

    /* A DENSE SMALL-LEAVED CLIPPED MASS, RAGGED ON EVERY EDGE.  The body is
       drawn DARK and the leaf tips BRIGHT -- toned down to C.hedge the whole
       tile lands inside about ten 8-bit levels, so all of its readability
       has to come from internal contrast, not from the tone.  A flat body
       with same-value leaves on it renders as one smooth dark mass, which is
       the green-brick read again by another route. */
    function hedgeTile(i, body, leaves, n) {
      var o = cell(i), m = 12, k;
      var x0 = o[0] + m, x1 = o[0] + ts - m, y0 = o[1] + m, y1 = o[1] + ts - m;
      var w = x1 - x0, hgt = y1 - y0;
      g.save();
      g.fillStyle = body; g.beginPath();
      for (k = 0; k <= 15; k++)                       /* top: 20 % ragged  */
        g.lineTo(x0 + w * k / 15, y0 + ts * (0.015 + 0.20 * R()));
      for (k = 0; k <= 5; k++)                        /* right: 7 %        */
        g.lineTo(x1 - ts * 0.07 * R(), y0 + hgt * (0.2 + 0.8 * k / 5));
      for (k = 0; k <= 5; k++)                        /* bottom: 5 %       */
        g.lineTo(x1 - w * k / 5, y1 - ts * 0.05 * R());
      for (k = 0; k <= 5; k++)                        /* left: 7 %         */
        g.lineTo(x0 + ts * 0.07 * R(), y1 - hgt * (0.8 * k / 5));
      g.closePath(); g.fill();
      /* the leaf mat, in clusters so the surface has a scale to it */
      for (k = 0; k < n; k++) {
        var cxx = x0 + w * R(), cyy = y0 + ts * 0.05 + (hgt - ts * 0.05) * R();
        var cl = leaves[(R() * leaves.length) | 0], q;
        for (q = 0; q < 4; q++) {
          g.fillStyle = cl;
          var lr = ts * (0.011 + R() * 0.017);
          ell(cxx + (R() - 0.5) * ts * 0.09, cyy + (R() - 0.5) * ts * 0.09,
              lr * 1.4, lr, R() * 3.1);
        }
      }
      /* leaf tips standing OVER the clipped line */
      for (k = 0; k < 52; k++) {
        g.fillStyle = leaves[(R() * leaves.length) | 0];
        var tr = ts * (0.009 + R() * 0.015);
        ell(x0 + w * R(), y0 + ts * (0.004 + 0.16 * R()), tr * 1.3, tr, R() * 3.1);
      }
      /* a few punched holes: through them the eye sees the 0.62x core, and
         that is what makes 12 triangles of box read as depth */
      g.globalCompositeOperation = 'destination-out';
      for (k = 0; k < 14; k++) {
        g.fillStyle = 'rgba(0,0,0,1)';
        var hr = ts * (0.014 + R() * 0.024);
        ell(x0 + w * R(), y0 + ts * 0.10 + (hgt - ts * 0.10) * R(), hr * 1.3, hr, R() * 3.1);
      }
      g.globalCompositeOperation = 'source-over';
      g.restore(); push(i);
    }

    /* a rounder mid-green leaf mass, ragged all round */
    function shrubTile(i, body, leaves, n) {
      var o = cell(i), m = 12, k;
      var cx = o[0] + ts * 0.5, cy = o[1] + ts * 0.5, rad = ts * 0.5 - m;
      g.save();
      g.fillStyle = body; g.beginPath();
      for (k = 0; k <= 22; k++) {
        var a = k / 22 * Math.PI * 2, rr2 = rad * (0.66 + 0.32 * R());
        var px = cx + Math.cos(a) * rr2, py = cy + Math.sin(a) * rr2 * 0.94;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fill();
      for (k = 0; k < n; k++) {
        var a2 = R() * Math.PI * 2, r2 = rad * Math.pow(R(), 0.55);
        var bx2 = cx + Math.cos(a2) * r2, by2 = cy + Math.sin(a2) * r2 * 0.94, q2;
        var cl2 = leaves[(R() * leaves.length) | 0];
        for (q2 = 0; q2 < 3; q2++) {
          g.fillStyle = cl2;
          var lr2 = ts * (0.013 + R() * 0.020);
          ell(bx2 + (R() - 0.5) * ts * 0.08, by2 + (R() - 0.5) * ts * 0.08,
              lr2 * 1.35, lr2, R() * 3.1);
        }
      }
      g.globalCompositeOperation = 'destination-out';
      for (k = 0; k < 10; k++) {
        g.fillStyle = 'rgba(0,0,0,1)';
        var hr2 = ts * (0.013 + R() * 0.020), ah = R() * Math.PI * 2;
        var rh = rad * (0.30 + 0.65 * R());
        ell(cx + Math.cos(ah) * rh, cy + Math.sin(ah) * rh * 0.94, hr2 * 1.3, hr2, R() * 3.1);
      }
      g.globalCompositeOperation = 'source-over';
      g.restore(); push(i);
    }

    var GBLADE = ['rgba(232,236,214,1)', 'rgba(204,213,185,1)',
                  'rgba(248,250,234,1)', 'rgba(180,192,163,1)'];
    var GDRY   = ['rgba(240,236,210,1)', 'rgba(216,208,178,1)',
                  'rgba(250,246,224,1)', 'rgba(196,187,158,1)'];
    var HLEAF  = ['rgba(232,238,210,1)', 'rgba(198,210,178,1)',
                  'rgba(255,255,238,1)', 'rgba(168,184,150,1)'];
    grassTile(N_GRASS,    'rgba(176,189,156,1)', GBLADE, 42, 0.74);
    grassTile(N_GRASSDRY, 'rgba(190,183,150,1)', GDRY,   38, 0.66);
    hedgeTile(N_HEDGE,    'rgba(118,132,100,1)', HLEAF,  46);
    shrubTile(N_SHRUB,    'rgba(126,140,106,1)', HLEAF,  46);

    var tex=new THREE.CanvasTexture(c);
    tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;
    tex.minFilter=THREE.LinearMipmapLinearFilter; tex.magFilter=THREE.LinearFilter;
    try{tex.anisotropy=Math.min(8,renderer&&renderer.capabilities?renderer.capabilities.getMaxAnisotropy():4);}catch(e){tex.anisotropy=4;}
    if('colorSpace' in tex&&THREE.SRGBColorSpace)tex.colorSpace=THREE.SRGBColorSpace;
    else if('encoding' in tex&&THREE.sRGBEncoding)tex.encoding=THREE.sRGBEncoding;
    tex.needsUpdate=true; OWN.tex.push(tex); STATS.textureBytes+=res*res*4;
    NEEDLE_TEX=tex; return tex;
  }

  /* an atlas-mapped quad.  c is the centre, u/v the HALF axes (authored
     coords -- Pile.v rotates both the position and the normal). */
  function ncard(pile, cx, cy, cz, ux, uy, uz, vx, vy, vz, rect, tone) {
    var nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    var l=Math.sqrt(nx*nx+ny*ny+nz*nz)||1; nx/=l; ny/=l; nz/=l;
    var b=pile.n;
    pile.v(cx-ux-vx, cy-uy-vy, cz-uz-vz, nx,ny,nz, rect[0],rect[1], tone);
    pile.v(cx+ux-vx, cy+uy-vy, cz+uz-vz, nx,ny,nz, rect[2],rect[1], tone);
    pile.v(cx+ux+vx, cy+uy+vy, cz+uz+vz, nx,ny,nz, rect[2],rect[3], tone);
    pile.v(cx-ux+vx, cy-uy+vy, cz-uz+vz, nx,ny,nz, rect[0],rect[3], tone);
    pile.tri(b,b+1,b+2); pile.tri(b,b+2,b+3);
  }
  function ncross(pile, x, y, z, w, h, rot, rect, tone) {
    var c1=Math.cos(rot), s1=Math.sin(rot);
    ncard(pile, x, y+h*0.5, z, c1*w*0.5,0,s1*w*0.5, 0,h*0.5,0, rect, tone);
    ncard(pile, x, y+h*0.5, z, -s1*w*0.5,0,c1*w*0.5, 0,h*0.5,0, rect, tone);
  }

  /* ---- trees ------------------------------------------------------------
     Yildiz Tepesi is planted with Pinus nigra: a long bare stem in warm grey
     bark, then a crown of dark tufted masses carried on a few heavy limbs,
     rounded to flat-topped in an old one and always broken -- there is sky
     THROUGH a black pine, and that is the whole silhouette.  The median and
     the roundabout approach carry cedars, whose foliage lies in near-level
     plates instead.  `kind` picks: 0/1 pine, 2 cedar.

     Everything below the crown base is a tube; everything above it is alpha
     cards out of the needle atlas.  Nothing is an ellipsoid any more. */
  /* The last calibration step, and it is a RED one.  With the atlas and the
     bake landing the crown at luminance 58 -- the photographs' own number --
     the render was still reading g/r 1.36 against their 1.12: too acid, the
     classic procedural-foliage green.  A Konya pine under cloud is a dull
     olive, and that is red, not less green. */
  var TCOL = { pine:[1.05,0.72,1.34], cedar:[1.02,0.72,1.38] };

  /* THE SUN-SIDE RAMP (mission 4 only).  Projects a foliage card's offset
     from its own crown centre onto the key light and returns a tone that is
     brighter and warmer on the south-west shoulder and darker and cooler on
     the north-east one.  Returns the tone untouched on every other mission,
     so mission 1's calibrated flat-dome crowns are bit-identical. */
  function sunRamp(tone, x, y, z, amt) {
    if (!SUNNY) return tone;
    var ax=x-TREEC[0], ay=y-TREEC[1], az=z-TREEC[2], sx, sy, sz;
    /* the key expressed in the frame this pile is being authored in */
    if (TRANSFORM_AUTHORED) { sx=SUN[2]; sy=SUN[1]; sz=-SUN[0]; }
    else { sx=SUN[0]; sy=SUN[1]; sz=SUN[2]; }
    var dl=Math.sqrt(ax*ax+ay*ay+az*az);
    var kk=dl>1e-4?(ax*sx+ay*sy+az*sz)/dl:0;         /* -1 shaded .. +1 lit */
    var g=1+kk*amt;
    return [tone[0]*g*(1+kk*0.10), tone[1]*g*(1+kk*0.015), tone[2]*g*(1-kk*0.16)];
  }

  function needleClump(x,y,z, dx,dz, rad, tone0, flat) {
    var px=-dz, pz=dx, r1;
    /* per-clump tone jitter.  A crown built from one colour is a silhouette,
       not a tree: the sunlit outer tufts of a black pine are most of a stop
       above the ones behind them even under cloud, and that internal range is
       what makes the mass read as deep rather than as a black cut-out. */
    var jt=rr(x*1.7,z*2.3,0.72,1.34), yj=1+(y*0.013%0.18);
    var tone=[tone0[0]*jt*yj, tone0[1]*jt*yj, tone0[2]*jt*yj*0.97];
    var core=0.56;
    /* MISSION 4 ONLY -- THE SUN-SIDE RAMP.  Under the overcast dome a crown
       is lit from everywhere and one jittered tone per clump is honest.  Under
       a 44-degree key it is not: the south-west shoulder of a black pine is
       most of two stops above the north-east one and it is WARMER, while the
       shaded side goes down AND cool.  jt alone is uncorrelated noise, which
       is exactly the flat-green look the owner is complaining about, so the
       clump's own offset from the crown centre is projected onto the key. */
    if (SUNNY) { tone=sunRamp(tone,x,y,z,0.44); core=0.34; }
    var t0=NRECT[rnd(x*3.1,z*1.7)<0.5?N_PINE:N_SPRAY];
    if (flat) {
      /* a cedar plate: flat, with a tilted twin and a black underside */
      ncard(P.needle, x,y,z, dx*rad,0,dz*rad, px*rad*0.80,0,pz*rad*0.80, t0, tone);
      r1=rr(x*2.3,z*1.9,0.30,0.52)*(rnd(x,z+3)<0.5?1:-1);
      ncard(P.needle, x,y+rad*0.15,z, dx*rad*0.9,rad*r1*0.5,dz*rad*0.9,
            px*rad*0.62,rad*r1,pz*rad*0.62, NRECT[N_SPRAY], tone);
      ncard(P.needle, x,y-rad*0.12,z, dx*rad*0.66,0,dz*rad*0.66,
            px*rad*0.52,0,pz*rad*0.52, NRECT[N_MASS],
            [tone[0]*core*0.98,tone[1]*core*0.98,tone[2]*core*1.06]);
    } else {
      /* a pine tuft: a rough ball of three crossed cards plus a dark core */
      ncard(P.needle, x,y,z, rad,0,0, 0,rad*0.86,0, t0, tone);
      ncard(P.needle, x,y,z, 0,0,rad, 0,rad*0.86,0, NRECT[N_PINE], tone);
      ncard(P.needle, x,y,z, dx*rad*0.86,0,dz*rad*0.86, px*rad*0.70,0,pz*rad*0.70,
            NRECT[N_SPRAY], tone);
      ncard(P.needle, x,y,z, rad*0.62,0,0, 0,rad*0.56,0, NRECT[N_MASS],
            [tone[0]*core,tone[1]*core,tone[2]*core*1.08]);
    }
  }

  function evergreen(x,z,h,r,median) {
    var gy=grade(z)+(median?.50:.52);
    var kind=Math.floor(rnd(x,z)*3);
    var cedar=(kind===2);
    var leanX=rr(x,z+1,-.30,.30), leanZ=rr(x,z+2,-.26,.26);
    var i,j,k;
    /* THE CLEAR STEM.  A black pine in a municipal park has been lifted to
       three or four metres and an old one to six; the bare stem under the
       crown is most of what makes it read as a real tree at 40 m. */
    var cb=gy+h*(cedar?.30:.42);
    var top=gy+h;
    var trunkR=r*(cedar?.140:.125);
    /* the stem, in four leaning segments so it is never a perfect cylinder */
    var seg=4, prev=[x,gy,z];
    for(i=1;i<=seg;i++){
      var q=i/seg, ny=gy+(top-gy)*q*(cedar?1:.96);
      var nx2=x+leanX*q*q, nz2=z+leanZ*q*q;
      tube(P.bark,prev,[nx2,ny,nz2],trunkR*(1-.80*Math.pow(q,1.5))+trunkR*.06,
           7,mixColor(C.bark,C.barkDark,rr(i,x,0,.55)),false);
      prev=[nx2,ny,nz2];
    }
    /* root flare */
    for(k=0;k<4;k++){
      var fa=k/4*Math.PI*2+rr(k,x,0,.7), fl=r*rr(k,z,.10,.19);
      tube(P.bark,[x,gy+r*.20,z],[x+Math.cos(fa)*fl,gy-.1,z+Math.sin(fa)*fl],
           trunkR*.42,5,C.barkDark,false);
    }

    var tone=cedar?TCOL.cedar:TCOL.pine;
    /* the crown centre the sun-side ramp in needleClump() measures from */
    TREEC=[x+leanX*0.60, cb+(top-cb)*(cedar?0.46:0.52), z+leanZ*0.60]; TREER=r;
    if(cedar){
      /* PLATES.  Six or seven near-level tiers, widest a third of the way up,
         with real sky between them and no leader spike at the top. */
      var nT=6+((rnd(x,z+7)*2)|0);
      for(i=0;i<nT;i++){
        var uu=nT>1?i/(nT-1):0;
        var wy=cb+(top-cb)*(0.03+0.97*Math.pow(uu,1.16));
        var cx2=x+leanX*uu*uu, cz2=z+leanZ*uu*uu;
        var prof=Math.pow(1-uu,.60)*(0.80+0.34*Math.sin(Math.min(uu/0.30,1)*Math.PI*0.5));
        var Rw=r*prof*rr(i,x+z,.90,1.22);
        if(uu>0.93)Rw*=0.55;
        if(Rw<r*.10)continue;
        var nb=Math.max(4,Math.round(6*(0.72+(1-uu)*0.55)));
        var a0=rr(i,z,0,Math.PI*2);
        for(k=0;k<nb;k++){
          if(rnd(i*31+k,x)<0.12)continue;
          var an=a0+k/nb*Math.PI*2+rr(i*17+k,z,-.30,.30);
          var dx=Math.cos(an),dz=Math.sin(an);
          var Lb=Rw*rr(i*13+k,x,.72,1.10), rise=r*rr(i*11+k,z,.04,.13);
          tube(P.bark,[cx2,wy,cz2],[cx2+dx*Lb,wy+rise,cz2+dz*Lb],
               trunkR*(.34-.18*uu),5,C.barkDark,false);
          var nc=3;
          for(j=0;j<nc;j++){
            var t=0.36+0.64*(j/(nc-1));
            needleClump(cx2+dx*Lb*t, wy+rise*t*0.9+rr(j,i+k,-.4,.4),
                        cz2+dz*Lb*t, dx,dz, Rw*(0.30+0.15*t)*rr(j*7,k,.82,1.20),
                        tone,true);
          }
          if(rnd(i+k*5,z)<.8)
            ncross(P.needle,cx2+dx*Lb,wy+rise-Rw*.05,cz2+dz*Lb,
                   Rw*.26,Rw*.30,rr(k,i,0,Math.PI),NRECT[N_CANDLE],tone);
        }
        /* the plate's dark middle */
        for(j=0;j<2;j++)
          ncard(P.needle,cx2+rr(j,i,-.5,.5)*Rw*.4,wy,cz2+rr(j+9,i,-.5,.5)*Rw*.4,
                Rw*.42,0,0, 0,0,Rw*.42, NRECT[N_MASS],
                [tone[0]*.48,tone[1]*.48,tone[2]*.48]);
      }
      /* the broad lopsided head -- never a point */
      for(i=0;i<5;i++){
        var ha=i/5*Math.PI*2+rr(i,x,0,.9), hd=r*.30*rr(i,z,.2,1.0);
        needleClump(x+leanX+Math.cos(ha)*hd, top-h*.06+rr(i,x+z,-.5,.5),
                    z+leanZ+Math.sin(ha)*hd, Math.cos(ha),Math.sin(ha),
                    r*rr(i,z+4,.16,.28), tone, true);
      }
      STATS.medianTrees+=median?1:0; if(!median)STATS.parkTrees++;
      return;
    }

    /* PINE.  Three to five heavy limbs leaving the stem at a wide angle,
       each ending in a bunch of tufts, plus a rounded head.  The crown is
       assembled from clumps at real 3D positions rather than from rings, so
       it is irregular in every direction and never reads as a cone. */
    var limbs=3+((rnd(x,z+3)*3)|0);
    var crownH=h-(cb-gy);
    for(i=0;i<limbs;i++){
      var la=i/limbs*Math.PI*2+rr(i,x,-.5,.5);
      var lq=rr(i,z,.02,.88);                        /* height up the crown */
      var ly=cb+crownH*lq;
      var lx=x+leanX*(lq*.6+.3), lz=z+leanZ*(lq*.6+.3);
      var reach=r*rr(i,x+z,.55,1.02)*(1-.35*lq);
      var ldx=Math.cos(la), ldz=Math.sin(la);
      var eyv=ly+crownH*rr(i,z+5,.05,.30);
      tube(P.bark,[lx,ly,lz],[lx+ldx*reach*.55,ly+(eyv-ly)*.45,lz+ldz*reach*.55],
           trunkR*.44,5,mixColor(C.bark,C.barkDark,.45),false);
      tube(P.bark,[lx+ldx*reach*.55,ly+(eyv-ly)*.45,lz+ldz*reach*.55],
           [lx+ldx*reach,eyv,lz+ldz*reach],trunkR*.26,4,C.barkDark,false);
      /* the bunch on the end of the limb, and a second smaller one half way
         along it -- a black pine carries foliage on the outer third of every
         limb, not only on the tip, and without the inner set you can see the
         sky straight through the middle of the crown */
      var nb2=4+((rnd(i*7,x)*3)|0);
      for(k=0;k<nb2;k++){
        var ba=rr(i*23+k,z,0,Math.PI*2), bd=reach*rr(i*19+k,x,.10,.46);
        needleClump(lx+ldx*reach+Math.cos(ba)*bd,
                    eyv+rr(i*5+k,z+1,-.12,.18)*crownH,
                    lz+ldz*reach+Math.sin(ba)*bd,
                    ldx,ldz, r*rr(i*3+k,x+z,.28,.46), tone, false);
      }
      for(k=0;k<2;k++){
        var mt=0.52+0.22*k;
        needleClump(lx+ldx*reach*mt+rr(i*29+k,x,-.3,.3)*r*.2,
                    ly+(eyv-ly)*mt*1.05+rr(i*31+k,z,-.1,.1)*crownH,
                    lz+ldz*reach*mt+rr(i*37+k,z,-.3,.3)*r*.2,
                    ldx,ldz, r*rr(i*41+k,x,.22,.34), tone, false);
      }
    }
    /* the head: a rounded, deliberately uneven cap of tufts */
    var nh=7+((rnd(x+1,z)*4)|0);
    for(i=0;i<nh;i++){
      var ha2=i/nh*Math.PI*2+rr(i,z+11,0,.8);
      var hr=r*rr(i,x+7,.06,.46);
      needleClump(x+leanX+Math.cos(ha2)*hr, top-crownH*rr(i,z+13,.02,.20),
                  z+leanZ+Math.sin(ha2)*hr, Math.cos(ha2),Math.sin(ha2),
                  r*rr(i,x+13,.30,.48), tone, false);
    }
    if(median){STATS.medianTrees++;}else STATS.parkTrees++;
  }

  function deciduous(x,z,h,r,blossom) {
    var gy=grade(z)+.52, fork=gy+h*.40, i, k;
    var R0=r*.11;
    tube(P.bark,[x,gy,z],[x,fork,z],R0,7,mixColor(C.bark,C.barkDark,.35),true);
    var tone=blossom?mixColor(C.blossom,C.white,.30):TDECID;
    TREEC=[x, fork+h*0.34, z]; TREER=r;
    var prim=4+((rnd(x,z)*3)|0);
    for(i=0;i<prim;i++){
      var a=i/prim*Math.PI*2+rr(i,x,-.4,.4);
      var reach=r*rr(i,z,.55,.95), up=h*rr(i,x+z,.22,.42);
      var ex=x+Math.cos(a)*reach, ez=z+Math.sin(a)*reach, ey=fork+up;
      tube(P.bark,[x,fork-h*.03,z],[x+Math.cos(a)*reach*.5,fork+up*.55,z+Math.sin(a)*reach*.5],
           R0*.55,5,C.barkDark,false);
      tube(P.bark,[x+Math.cos(a)*reach*.5,fork+up*.55,z+Math.sin(a)*reach*.5],
           [ex,ey,ez],R0*.30,4,C.barkDark,false);
      for(k=0;k<3;k++){
        var ba=rr(i*13+k,z,0,Math.PI*2), bd=r*rr(i*9+k,x,.08,.34);
        var cr=r*rr(i*5+k,z+3,.26,.44);
        var cx2=ex+Math.cos(ba)*bd, cz2=ez+Math.sin(ba)*bd;
        var cy2=ey+rr(i+k,x+1,-.10,.18)*h;
        var lt=sunRamp(tone,cx2,cy2,cz2,0.40);
        ncard(P.needle,cx2,cy2,cz2, cr,0,0, 0,cr*.82,0, NRECT[N_SPRAY], lt);
        ncard(P.needle,cx2,cy2,cz2, 0,0,cr, 0,cr*.82,0, NRECT[N_PINE], lt);
        ncard(P.needle,cx2,cy2,cz2, cr*.60,0,0, 0,cr*.52,0, NRECT[N_MASS],
              scaleT(lt,SUNNY?0.36:0.58));
      }
    }
    STATS.parkTrees++;
  }

  /* hedge() -- one box(P.foliage,...) per hedge, i.e. a green brick with
     mitred corners -- is DELETED.  It and its 16-row H table were half of the
     owner's "cartoonish": nine of those rows lay inside the new service
     street and every one of them was a cuboid.  hedgeRun() and hedgeLoaf()
     below replace it with the clad-core strategy. */

  /* bench() and gazebo() are GONE FROM HERE.  The old bench was two solid
     boxes and two tubes with its yaw argument silently discarded (it
     branched on |sin(yaw)| < .5 and picked an axis-aligned box either way),
     and the old gazebo was an 11.2-u deck, four VERTICAL tubes and a 28.8
     degree pyramid with no fascia, no soffit and no eaves shadow -- the
     "gazebos" the owner named.  Both are rebuilt in the JOB C block below,
     in a proper local frame, next to kamelya(), picnicShelter() and the
     rest of the park furniture. */

  /* Pale grey galvanised TAPERED shaft to the arm, a single smooth swan-neck
     outreach, a small flat-bottomed shoebox lantern and a yellow warning
     band at about 2.5 m -- reference 7ae22aea, and no decorative collar.
     frustum() was declared at the top of this file and had never once been
     called; it costs the same triangles as the tube it replaces and gives
     the correct silhouette. */
  function lamp(x,z,dir) {
    var y=grade(z)+.58,h=29;
    frustum(P.metal,x,y,z,.28,y+h,.18,8,C.stainless,true);
    box(P.metal,x-.31,y+8.75,z-.31,x+.31,y+9.65,z+.31,C.yellow);
    var prev=[x,y+h,z];
    for(var i=1;i<=4;i++){
      var q=i/4,nxt=[x+dir*(2.0*i),y+h+1.8*Math.sin(q*Math.PI*.75),z];
      tube(P.metal,prev,nxt,.16,7,C.stainless,false);prev=nxt;
    }
    box(P.metal,prev[0]-1.0,prev[1]-.38,prev[2]-.48,prev[0]+.6,prev[1]+.15,prev[2]+.48,C.steel);
    STATS.lamps++;
  }

  function fence(x0,z0,x1,z1,height) {
    var dx=x1-x0,dz=z1-z0,L=Math.sqrt(dx*dx+dz*dz),n=Math.max(1,Math.floor(L/5.2)),i;
    for(i=0;i<=n;i++){
      var q=i/n,x=lerp(x0,x1,q),z=lerp(z0,z1,q),y=grade(z)+.58;
      tube(P.metal,[x,y,z],[x,y+height,z],.10,5,C.steel,false);
    }
    for(i=1;i<=2;i++){
      var ya=grade(z0)+.58+height*i/2,yb=grade(z1)+.58+height*i/2;
      tube(P.metal,[x0,ya,z0],[x1,yb,z1],.11,6,C.steel,false);
    }
  }

  /* ---- JOB B / JOB C stubs, wired by JOB A ---------------------------
     The prerequisite refactor splits the old buildParkDetails() four ways.
     buildRoadway() and plantStreet() above are JOB A's and are finished;
     the four below are declared here so buildAll() and meshAll() can ship
     complete, and their bodies belong to the later jobs.  A missing
     makeMesh() line is silent -- the pile fills, costs build time and never
     reaches the scene -- so the wiring goes in once, here, and B, C and D
     only ever fill these bodies in.
     THE GEOMETRIC SPLIT LINE IS WORLD Z = 216.  JOB B owns Z 216..265 (the
     lawn and its planting), JOB A owns Z <= 216 and Z 265..299, JOB C owns
     everything that STANDS on either, JOB D everything vertical at the two
     building lines. */

  /* JOB B.  The lawn is world X 268..484 by world Z 216..265 -- the north
     edge moved from 212 to 216 with the promenade widening and the east edge
     now follows the matching 232 Sk envelope.  JOB B REPLACES THIS
     ENTIRE BODY with the displaced 8 x 8 mesh, the wear field, the fringe
     and the scatter, and defines lawnY(wx,wz) as the single source of ground
     height inside it.  The flat quad below is a PLACEHOLDER so the interim
     level has a floor under the park; it is not the lawn. */
  /* =====================================================================
     JOB B -- THE PARK'S GROUND COVER
     lawn, curved paths, hedges, shrub domes.

     THE TRANSFORM, restated: worldX = 740 - authoredZ, worldZ = authoredX,
     grade(z) takes an AUTHORED z and worldGrade(x) = grade(740 - x).  Every
     number below is a WORLD coordinate and the conversion happens exactly
     once, in wp() / wcard() / wcross(), so there is no authored arithmetic
     to get wrong.  ARGUMENT ORDERS, stated explicitly as the brief demands:
       lawnY(worldX, worldZ)              -> finished turf surface Y
       hedgeRun(wx0, wx1, wzCentre, thickness, height, seed)
       hedgeLoaf(wxCentre, wzCentre, length, width, height, seed)
       shrubDome(worldX, worldZ, radius, height, tone, seed)
       fringeAlong(wx0, wz0, wx1, wz1, spacing, seed)
     ===================================================================== */

  var LAWN = { x0: 268, x1: 484, z0: 216, z1: 265, nx: 27, nz: 6 };
  LAWN.dx = (LAWN.x1 - LAWN.x0) / LAWN.nx;      /* 8.00 u */
  LAWN.dz = (LAWN.z1 - LAWN.z0) / LAWN.nz;      /* 8.17 u */

  /* THE HARD LIMIT.  The gameplay floor is quantised per 4-u column at
     (137.5-cx)*0.28 and runs +0.14..+0.42 above worldGrade inside a cell,
     so no turf vertex may sit below worldGrade + 0.45.  Base 0.58 with a
     +-0.12 relief lands the lowest vertex at +0.46 and the boundary at
     +0.58 -- 0.02 proud of Job A's apron at +0.56, which is exactly the
     "settled paving with grass proud at the edge" the photographs show.
     (The spec's literal 0.49 +- 0.12 would bottom out at +0.37 and put the
     player's feet 3 cm in the air over half the lawn.) */
  var LAWN_BASE = 0.58, LAWN_AMP = 0.12;

  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  /* one at the middle of the lawn, zero at every boundary over the last
     6 u, so the displaced mesh lands exactly on the abutting pavement */
  function edgeFade(wx, wz) {
    return smooth(Math.min(wx - LAWN.x0, LAWN.x1 - wx,
                           wz - LAWN.z0, LAWN.z1 - wz) / 6.0);
  }
  function lawnLift(i, j) { return rr(i * 1.7 + 3, j * 2.9 + 5, -LAWN_AMP, LAWN_AMP); }

  /* THE ONLY SOURCE OF GROUND HEIGHT INSIDE THE LAWN.  Bilinear over the
     same 8-u lattice the mesh is built on, so at a lattice point it returns
     the mesh vertex exactly and nothing can ever float or sink.  Paths,
     tufts, hedges, domes, soil and every piece of JOB C's furniture sample
     this and NOTHING computes its own.  Pure function; safe outside the
     lawn, where it clamps to the boundary lattice and the fade is zero. */
  function lawnY(wx, wz) {
    var fx = clamp((wx - LAWN.x0) / LAWN.dx, 0, LAWN.nx);
    var fz = clamp((wz - LAWN.z0) / LAWN.dz, 0, LAWN.nz);
    var i0 = Math.min(LAWN.nx - 1, Math.floor(fx));
    var j0 = Math.min(LAWN.nz - 1, Math.floor(fz));
    var tx = smooth(fx - i0), tz = smooth(fz - j0);
    var a = lerp(lawnLift(i0, j0), lawnLift(i0 + 1, j0), tx);
    var b = lerp(lawnLift(i0, j0 + 1), lawnLift(i0 + 1, j0 + 1), tx);
    return worldGrade(wx) + LAWN_BASE + lerp(a, b, tz) * edgeFade(wx, wz);
  }

  /* LAYER 2, WEAR.  A low-frequency straw/green field.  Uniform green says
     "texture"; green worn brown where the feet go says "people walk here",
     and that is the strongest single cue in the park per triangle. */
  function wearF(i, j) { return clamp(hash(i * 3.1 + j * 7.7) * 1.4 - 0.28, 0, 1); }
  function lawnTone(i, j) {
    var t = mixColor(C.grass, C.grassDry, wearF(i, j));
    /* thinning, not a flat field: a second low-frequency factor at the same
       8-u (2.3 m) lattice, wide enough that watered patches and burnt ones
       are visibly different colours rather than the same green twice */
    /* MEASURED: with k centred on 1.00 the whole lawn came back at 0.345x
       the road against the C table's 0.38, so the field is lifted 9 % here
       rather than by touching C.grass, which is JOB A's entry. */
    var k = 0.90 + 0.32 * rnd(i + 31, j + 17);
    return [t[0] * k, t[1] * k, t[2] * k];
  }
  function wearAt(wx, wz) {
    var fx = clamp((wx - LAWN.x0) / LAWN.dx, 0, LAWN.nx);
    var fz = clamp((wz - LAWN.z0) / LAWN.dz, 0, LAWN.nz);
    var i0 = Math.min(LAWN.nx - 1, Math.floor(fx));
    var j0 = Math.min(LAWN.nz - 1, Math.floor(fz));
    var tx = smooth(fx - i0), tz = smooth(fz - j0);
    return lerp(lerp(wearF(i0, j0), wearF(i0 + 1, j0), tx),
                lerp(wearF(i0, j0 + 1), wearF(i0 + 1, j0 + 1), tx), tz);
  }

  /* ---- world-space emitters ------------------------------------------ */
  /* a quad from four WORLD points, with a WORLD reference on the back side */
  function wquad(pile, a, b, c, d, ref, tone) {
    poly(pile, [wp(a[0], a[1], a[2]), wp(b[0], b[1], b[2]),
                wp(c[0], c[1], c[2]), wp(d[0], d[1], d[2])],
         wp(ref[0], ref[1], ref[2]), tone);
  }
  /* an atlas card placed in WORLD coordinates.  A world direction (dx,dy,dz)
     is authored (dz, dy, -dx) -- derived once, here, and nowhere else. */
  function wcard(pile, px, py, pz, ux, uy, uz, vx, vy, vz, rect, tone) {
    ncard(pile, pz, py, AXIS_ORIGIN - px, uz, uy, -ux, vz, vy, -vx, rect, tone);
  }
  function wcross(pile, px, py, pz, w, h, rot, rect, tone) {
    ncross(pile, pz, py, AXIS_ORIGIN - px, w, h, rot, rect, tone);
  }
  function scaleT(t, k) { return [t[0] * k, t[1] * k, t[2] * k]; }

  /* CARD GAIN.  Contract 5.4: an up-facing surface receives 2.00 from the
     overcast dome and a vertical one about 1.30, so a standing alpha card
     toned with the same albedo as the turf under it renders a third darker
     and the fringe reads as a dark rim instead of as grass.  These are the
     measured compensations, applied once, here. */
  var GRASS_CARD = 1.40, DRY_CARD = 1.10, HEDGE_GAIN = 1.35, SHRUB_GAIN = 1.30;
  var T_GRASSC = null, T_DRYC = null, T_HEDGE = null, T_SHRUB = null;
  function initToneCache() {
    T_GRASSC = scaleT(C.grass, GRASS_CARD);
    /* the straw cards get LESS gain than the green ones: at 1.45 they read
       as little yellow flowers scattered over the turf, which is the one
       thing the photographs never show */
    T_DRYC   = scaleT(C.grassDry, DRY_CARD);
    /* MEASURED, TWICE, AND THEN STOPPED (RISKS.md: two iterations per
       surface, no more).  At gain 2.05 the vertical hedge face came back at
       0.189x the road in the along-the-apron frame and the domes at 0.385;
       the targets are 0.12 and 0.30, so the gains are 2.05*0.12/0.189 =
       1.35 and 1.45*0.30/0.385 = 1.13.  The vertical-orientation discount
       measures 0.76, not the 0.65 the contract's 1.30/2.00 predicts, which
       is why the raw C.hedge alone lands at 0.092 and needs the lift.
       SHRUB_GAIN then went back up to 1.30: with the region isolated by hue
       instead of by eye the lit face of a dome reads 0.20, and the master
       photograph ed2f6a5c measures its own domes at 0.205 against its own
       road -- so the spec's 0.30 and the photograph disagree and this sits
       between them.  Same photograph, same method: hedge 0.177, grass 0.78,
       rose paver 1.188.  Numbers, and where they came from, in the report. */
    T_HEDGE  = scaleT(C.hedge, HEDGE_GAIN);
    T_SHRUB  = scaleT(C.shrub, SHRUB_GAIN);
  }

  /* ---- path clearance ------------------------------------------------- */
  /* every walkway sample the park owns, so nothing is ever planted on a
     path and the scatter can thin out where the paving is */
  var PATHPTS = [], DOMES = [];
  function keepPaths(samples) {
    if (!samples) return samples;
    for (var i = 0; i < samples.length; i++) PATHPTS.push(samples[i]);
    return samples;
  }
  function pathDist2(wx, wz) {
    var best = 1e9, i;
    for (i = 0; i < PATHPTS.length; i++) {
      var dx = PATHPTS[i][0] - wx, dz = PATHPTS[i][1] - wz;
      var d = dx * dx + dz * dz; if (d < best) best = d;
    }
    return best;
  }
  function clearOfPaths(wx, wz, margin) { return pathDist2(wx, wz) > margin * margin; }

  /* JOB C's furniture footprints, kept clear of planting.  Stated here so
     the two jobs cannot fight over the same square metre. */
  var RESERVED = [
    [433, 234, 471, 254],    /* picnic shelter terrace, world (452,244) */
    [340, 250, 356, 266],    /* kamelya A, world (348,258)              */
    [292, 232, 308, 248],    /* kamelya B, world (300,240)              */
    [402, 226, 442, 244],    /* the four fitness rigs                   */
    [460, 214, 476, 226]     /* the park name sign                      */
  ];
  function clearOfFurniture(wx, wz, pad) {
    for (var i = 0; i < RESERVED.length; i++) {
      var r = RESERVED[i];
      if (wx > r[0] - pad && wx < r[2] + pad && wz > r[1] - pad && wz < r[3] + pad)
        return false;
    }
    return true;
  }

  /* ---- LAYER 1: the mesh ---------------------------------------------- */
  /* A flat quad has a perfectly level far horizon; a real lawn's far edge
     wobbles by 10 cm and that wobble is visible at 30 m.  192 quads. */
  function lawnMesh() {
    var i, j, rows = [], p = P.grass, inv = 1 / p.tile;
    for (j = 0; j <= LAWN.nz; j++) {
      var row = [];
      for (i = 0; i <= LAWN.nx; i++) {
        var wx = LAWN.x0 + i * LAWN.dx, wz = LAWN.z0 + j * LAWN.dz;
        var ax = wz, az = AXIS_ORIGIN - wx;
        row.push(p.v(ax, lawnY(wx, wz), az, 0, 1, 0,
                     ax * inv, az * inv, lawnTone(i, j)));
      }
      rows.push(row);
    }
    for (j = 0; j < LAWN.nz; j++) for (i = 0; i < LAWN.nx; i++) {
      var a = rows[j][i], b = rows[j][i + 1];
      var c = rows[j + 1][i + 1], d = rows[j + 1][i];
      p.tri(a, d, b); p.tri(b, d, c);
    }
  }

  /* ---- LAYER 2: bare soil --------------------------------------------- */
  function soilPatch(wx, wz, r, seed) {
    var n = 6, i, pts = [];
    for (i = 0; i < n; i++) {
      var a = (i + 0.5) / n * Math.PI * 2 + rr(seed + i, 3, -0.2, 0.2);
      var rad = r * rr(seed * 3 + i, seed + 7, 0.58, 1.18);
      var px = wx + Math.cos(a) * rad, pz = wz + Math.sin(a) * rad;
      pts.push(wp(px, lawnY(px, pz) + 0.030, pz));
    }
    poly(P.grass, pts, wp(wx, lawnY(wx, wz) - 2, wz),
         mixColor(C.soil, C.grassDry, rr(seed, 11, 0, 0.22)));
  }

  /* a bare-earth chord cutting the inside of a curve.  Wear only, no
     paving -- this is where the feet actually go. */
  function desireLine(wx0, wz0, wx1, wz1, w, seed) {
    var dx = wx1 - wx0, dz = wz1 - wz0, L = Math.sqrt(dx * dx + dz * dz);
    if (!(L > 1)) return;
    var nx = -dz / L, nz = dx / L, n = Math.max(2, Math.round(L / 6)), i;
    var t0 = mixColor(C.soil, C.grassDry, 0.30);
    for (i = 0; i < n; i++) {
      var u0 = i / n, u1 = (i + 1) / n;
      var ax0 = wx0 + dx * u0, az0 = wz0 + dz * u0;
      var ax1 = wx0 + dx * u1, az1 = wz0 + dz * u1;
      var h0 = w * 0.5 * rr(seed + i, 13, 0.55, 1.20);
      var h1 = w * 0.5 * rr(seed + i + 1, 13, 0.55, 1.20);
      var pA = [ax0 + nx * h0, az0 + nz * h0], pB = [ax1 + nx * h1, az1 + nz * h1];
      var pC = [ax1 - nx * h1, az1 - nz * h1], pD = [ax0 - nx * h0, az0 - nz * h0];
      wquad(P.grass,
            [pA[0], lawnY(pA[0], pA[1]) + 0.030, pA[1]],
            [pB[0], lawnY(pB[0], pB[1]) + 0.030, pB[1]],
            [pC[0], lawnY(pC[0], pC[1]) + 0.030, pC[1]],
            [pD[0], lawnY(pD[0], pD[1]) + 0.030, pD[1]],
            [(ax0 + ax1) * 0.5, lawnY(ax0, az0) - 2, (az0 + az1) * 0.5], t0);
    }
  }

  /* ---- LAYER 3: the fringe -------------------------------------------- */
  /* Real turf is only ever read as grass AT ITS EDGE, and a quad has a
     razor edge.  Single cards -- not crosses -- standing perpendicular to
     the boundary, which is the direction you look at that boundary from. */
  function fringeCard(wx, wz, tdx, tdz, k) {
    var dry = rnd(k, 6) < 0.20;
    var h = rr(k, 11, 1.0, 1.5), w = rr(k, 12, 1.3, 2.0);
    var ya = rr(k, 13, -0.25, 0.25), ca = Math.cos(ya), sa = Math.sin(ya);
    var dx2 = tdx * ca - tdz * sa, dz2 = tdx * sa + tdz * ca;
    var lean = rr(k, 14, -0.22, 0.22);
    var y = lawnY(wx, wz) - 0.12;
    wcard(P.needle, wx, y + h * 0.5, wz,
          dx2 * w * 0.5, 0, dz2 * w * 0.5,
          dx2 * lean, h * 0.5, dz2 * lean,
          NRECT[dry ? N_GRASSDRY : N_GRASS], dry ? T_DRYC : T_GRASSC);
    STATS.tufts++;
  }
  function fringeAlong(wx0, wz0, wx1, wz1, spacing, seed) {
    var dx = wx1 - wx0, dz = wz1 - wz0, L = Math.sqrt(dx * dx + dz * dz);
    if (!(L > 0.5)) return;
    var n = Math.max(1, Math.round(L / spacing)), i;
    for (i = 0; i < n; i++) {
      var t = (i + 0.5 + rr(seed + i, 21, -0.34, 0.34)) / n;
      fringeCard(wx0 + dx * t, wz0 + dz * t, dx / L, dz / L, seed + i * 7);
    }
  }
  /* both sides of a returned walkway sample run */
  function fringePath(samples, halfWidth, seed) {
    if (!samples) return;
    var i, side;
    for (i = 0; i < samples.length; i += 2) {
      var s = samples[i];
      var pn = samples[Math.min(i + 1, samples.length - 1)];
      var pp = samples[Math.max(i - 1, 0)];
      var tx = pn[0] - pp[0], tz = pn[1] - pp[1];
      var tl = Math.sqrt(tx * tx + tz * tz) || 1; tx /= tl; tz /= tl;
      for (side = 0; side < 2; side++) {
        var sg = side ? -1 : 1;
        var px = s[0] - tz * sg * (halfWidth + 0.75);
        var pz = s[1] + tx * sg * (halfWidth + 0.75);
        if (pz < LAWN.z0 - 1 || pz > LAWN.z1 + 1) continue;
        fringeCard(px, pz, tx, tz, seed + i * 13 + side * 3);
      }
    }
  }

  /* ---- LAYER 4: the scatter ------------------------------------------- */
  function tuftScatter(n, seed) {
    var i, placed = 0;
    for (i = 0; i < n * 3 && placed < n; i++) {
      var wx = rr(i + seed, 41, LAWN.x0 + 3, LAWN.x1 - 3);
      var wz = rr(i + seed, 42, LAWN.z0 + 2.5, LAWN.z1 - 2.5);
      if (!clearOfPaths(wx, wz, 4.6)) continue;
      var w2 = wearAt(wx, wz);
      if (rnd(i + seed, 43) < w2 * 0.85) continue;    /* none in the bare patches */
      var dry = rnd(i + seed, 44) < 0.12 + w2 * 0.28;
      wcross(P.needle, wx, lawnY(wx, wz) - 0.16, wz,
             rr(i + seed, 45, 1.1, 1.8), rr(i + seed, 46, 0.85, 1.45),
             rr(i + seed, 47, 0, Math.PI),
             NRECT[dry ? N_GRASSDRY : N_GRASS], dry ? T_DRYC : T_GRASSC);
      placed++; STATS.tufts += 2;
    }
  }

  /* ---- THE HEDGES: the clad core -------------------------------------- */
  /* A clipped hedge is flat-topped and vertical-sided, but its SURFACE is a
     mat of leaf tips, so the silhouette against the sky is a fine ragged
     fuzz about 5 cm deep.  A cuboid is straight at 10 m and straight at
     1 m; a cloud of cards is ragged at both.  You need the level core AND
     the ragged skin: the core is the light-stopper (without it the skin
     cards see daylight through each other and the whole hedge glows) and
     the cards are the only thing that makes silhouette. */
  function foliageCore(wxa, wxb, wza, wzb, h, round, tone) {
    var inset = 0.35, drop = 0.45;
    var xa = wxa + inset, xb = wxb - inset;
    var zA = wza + inset, zB = wzb - inset;
    if (!(xb > xa + 0.2) || !(zB > zA + 0.2)) return;
    var zc = (wza + wzb) * 0.5;
    var n = Math.max(1, Math.round((xb - xa) / 6)), i;
    var cham = round ? Math.min(0.8, (zB - zA) * 0.3) : 0;
    var chamY = round ? Math.min(1.1, h * 0.30) : 0;
    var topT = scaleT(tone, 1.18);
    function gy(wx) { return lawnY(wx, zc); }
    for (i = 0; i < n; i++) {
      var x0 = xa + (xb - xa) * i / n, x1 = xa + (xb - xa) * (i + 1) / n;
      var b0 = gy(x0) - 0.40, b1 = gy(x1) - 0.40;
      var t0 = gy(x0) + h - drop, t1 = gy(x1) + h - drop;
      var s0 = t0 - chamY, s1 = t1 - chamY;
      var ref = [(x0 + x1) * 0.5, (b0 + t0) * 0.5, zc];
      wquad(P.foliage, [x0, b0, zA], [x1, b1, zA], [x1, s1, zA], [x0, s0, zA], ref, tone);
      wquad(P.foliage, [x0, b0, zB], [x1, b1, zB], [x1, s1, zB], [x0, s0, zB], ref, tone);
      if (round) {
        wquad(P.foliage, [x0, s0, zA], [x1, s1, zA],
              [x1, t1, zA + cham], [x0, t0, zA + cham], ref, tone);
        wquad(P.foliage, [x0, s0, zB], [x1, s1, zB],
              [x1, t1, zB - cham], [x0, t0, zB - cham], ref, tone);
      }
      wquad(P.foliage, [x0, t0, zA + cham], [x1, t1, zA + cham],
            [x1, t1, zB - cham], [x0, t0, zB - cham],
            [(x0 + x1) * 0.5, b0, zc], topT);
    }
    /* the two ends */
    var ea = gy(xa), eb = gy(xb), mid = [(xa + xb) * 0.5, (ea + eb) * 0.5, zc];
    wquad(P.foliage, [xa, ea - 0.40, zA], [xa, ea + h - drop, zA + cham],
          [xa, ea + h - drop, zB - cham], [xa, ea - 0.40, zB], mid, tone);
    wquad(P.foliage, [xb, eb - 0.40, zA], [xb, eb + h - drop, zA + cham],
          [xb, eb + h - drop, zB - cham], [xb, eb - 0.40, zB], mid, tone);
  }

  /* the cladding.  Two staggered rows on each long face plus a row along
     the top edge, each card rotated +-6 deg, top edges varying +-0.21 u --
     and THE CORE'S TOP STAYS DEAD LEVEL, which is what keeps the run a
     straight receding line at 10 m and a fuzz at 1 m. */
  function hedgeSkin(wxa, wxb, wza, wzb, h, spacing, seed, tone) {
    var CS = 2.6, i, r, face;
    var zc = (wza + wzb) * 0.5;
    function gy(wx) { return lawnY(wx, zc); }
    /* topAlign: the card's TOP EDGE is placed, not its centre.  The tile
       carries its ragged edge in the top 11 % of the cell, so a card whose
       top edge sits 0.37 u over the clipped line lands its opaque body ON
       that line with about 9 cm of leaf tips above it -- which is the whole
       specification of a clipped hedge.  Placing card CENTRES instead puts
       half a card of foliage above the line and the run reads as a lumpy
       bank rather than as a straight receding edge at 10 m. */
    function put(px, pz, tdx, tdz, yy, f0, k, topAlign) {
      var f = f0 * rr(k, 61, 0.92, 1.08);
      var rot = rr(k, 62, -0.105, 0.105);
      var cr2 = Math.cos(rot), sr = Math.sin(rot);
      var hu = CS * 0.5 * rr(k, 63, 0.86, 1.16);
      var hv = CS * 0.5 * rr(k, 64, 0.88, 1.12);
      var cy = topAlign ? yy - hv : yy;
      wcard(P.needle, px, cy, pz,
            tdx * hu * cr2, hu * sr, tdz * hu * cr2,
            -tdx * hv * sr, hv * cr2, -tdz * hv * sr,
            NRECT[N_HEDGE], scaleT(tone, f));
      STATS.hedgeCards++;
    }
    /* two staggered rows per long face: a SKIRT whose foot goes under the
       turf and a CROWN aligned on the clipped line, toned 0.66 and 1.18 --
       the vertical gradient the bake cannot supply at this scale */
    for (face = 0; face < 2; face++) {
      var pz2 = face ? wzb + 0.15 : wza - 0.15;
      var n = Math.max(1, Math.round((wxb - wxa) / spacing));
      for (r = 0; r < 2; r++) for (i = 0; i < n; i++) {
        var t = (i + 0.5 + (r ? 0.5 : 0)) / n;
        if (t > 1) t -= 1;
        var px = wxa + (wxb - wxa) * t;
        var k = seed + face * 977 + r * 131 + i * 17;
        if (r) put(px, pz2, 1, 0, gy(px) + h + 0.37 + rr(k, 65, -0.12, 0.12),
                   1.18, k, true);
        else   put(px, pz2, 1, 0, gy(px) + h * 0.40, 0.66, k, false);
      }
    }
    /* THE ENDS.  A run seen down its own length is otherwise a flat
       rectangle of core -- the green-brick read again by another route.
       Four cards per end, spread across the thickness AND up the height;
       three on a diagonal leaves both corners bare. */
    for (face = 0; face < 2; face++) for (i = 0; i < 4; i++) {
      var ex = face ? wxb + 0.15 : wxa - 0.15;
      var k2 = seed + 4001 + face * 137 + i * 29;
      var hi = (i & 2) !== 0;
      put(ex, zc + ((i & 1) ? 0.62 : -0.62) * (wzb - wza) * 0.5 + rr(k2, 68, -0.25, 0.25),
          0, 1, hi ? gy(ex) + h + 0.30 : gy(ex) + h * 0.38,
          hi ? 1.14 : 0.68, k2, hi);
    }
    /* the top row: cards standing over the clipped line on the centreline */
    var nt = Math.max(1, Math.round((wxb - wxa) / (spacing * 1.35)));
    for (i = 0; i < nt; i++) {
      var tx = wxa + (wxb - wxa) * (i + 0.5) / nt;
      var k3 = seed + 8101 + i * 23;
      put(tx, zc + rr(k3, 66, -0.55, 0.55), 1, 0,
          gy(tx) + h + 0.42 + rr(k3, 67, -0.10, 0.16), 1.28, k3, true);
    }
  }

  /* (a) THE CONTINUOUS FLAT-TOPPED RUN, hard-clipped, sitting DIRECTLY IN
     THE GRASS with no kerbed bed -- ed2f6a5c, 2015.  Its top edge is the
     strongest perspective cue in the along-the-apron composition and it is
     built parallel to Job A's chevron so the two converge together. */
  function hedgeRun(wx0, wx1, wzc, thick, h, seed) {
    var za = wzc - thick * 0.5, zb = wzc + thick * 0.5;
    foliageCore(wx0, wx1, za, zb, h, false, scaleT(T_HEDGE, 0.62));
    hedgeSkin(wx0, wx1, za, zb, h, 2.35, seed, T_HEDGE);
    STATS.hedges++;
  }
  /* (b) THE DISCRETE LOAF BLOCK, rounded top -- de5ba0a8, 2026.  The same
     planting eleven years apart; both forms are in the photographs. */
  function hedgeLoaf(wxc, wzc, len, wid, h, seed) {
    var t = scaleT(T_HEDGE, rr(seed, 71, 0.93, 1.07));
    foliageCore(wxc - len * 0.5, wxc + len * 0.5,
                wzc - wid * 0.5, wzc + wid * 0.5, h, true, scaleT(t, 0.62));
    hedgeSkin(wxc - len * 0.5, wxc + len * 0.5,
              wzc - wid * 0.5, wzc + wid * 0.5, h, 2.35, seed, t);
    STATS.hedges++;
  }

  /* ---- THE SHRUB DOMES ------------------------------------------------ */
  /* A clipped dome has a HARD, EVEN OUTLINE -- it has been sheared -- but a
     FURRY SURFACE.  The core's silhouette stays smooth and the cards are
     SHORT, not wispy: the exact opposite of a tree crown. */
  function shrubDome(wx, wz, r, h, tone, seed) {
    var y0 = lawnY(wx, wz) - 0.45, i;
    /* the core is the light-stopper only: it is pulled well inside the
       cards, because a six-sided frustum with cards on its shoulders reads
       as a hexagonal prism wearing a hat */
    frustum(P.foliage, wz, y0, AXIS_ORIGIN - wx, r * 0.55, y0 + h * 0.70,
            r * 0.26, 6, scaleT(tone, 0.62), true);
    /* THREE RINGS OF FOUR, not twelve at random heights: a random-q ring
       leaves the core's base uncovered about half the time and the six flat
       facets of the frustum then read as a hexagonal prism in a hat. */
    for (i = 0; i < 12; i++) {
      var a = (i + rr(seed + i, 81, -0.30, 0.30)) / 12 * Math.PI * 2 + (i % 3) * 0.52;
      var q = (i % 3) * 0.36 + rr(seed + i, 82, 0.0, 0.14);
      var rad = r * (0.80 - 0.46 * q) + 0.22;
      var cy = y0 + h * (0.16 + 0.66 * q);
      var hu = r * rr(seed + i, 83, 0.48, 0.66);
      var hv = r * rr(seed + i, 84, 0.44, 0.60);
      var f = 0.70 + 0.56 * q;
      wcard(P.needle, wx + Math.cos(a) * rad, cy, wz + Math.sin(a) * rad,
            -Math.sin(a) * hu, 0, Math.cos(a) * hu,
            0, hv, 0, NRECT[N_SHRUB], scaleT(tone, f));
    }
    for (i = 0; i < 2; i++) {
      var a2 = rr(seed + i, 85, 0, Math.PI);
      var hu2 = r * rr(seed + i, 86, 0.48, 0.66);
      wcard(P.needle, wx, y0 + h * (0.86 + i * 0.06), wz,
            Math.cos(a2) * hu2, 0, Math.sin(a2) * hu2,
            -Math.sin(a2) * hu2 * 0.7, hu2 * 0.24, Math.cos(a2) * hu2 * 0.7,
            NRECT[N_SHRUB], scaleT(tone, 1.20));
    }
    /* bare stems at the base: the underside of a sheared dome is open */
    if (rnd(seed, 87) < 0.55) {
      for (i = 0; i < 2; i++) {
        var a3 = rr(seed + i, 88, 0, Math.PI * 2), rd = r * 0.30;
        tube(P.bark, [wz + Math.sin(a3) * rd, y0 - 0.1, AXIS_ORIGIN - wx - Math.cos(a3) * rd],
             [wz, y0 + h * 0.42, AXIS_ORIGIN - wx], 0.13, 4, C.barkDark, false);
      }
    }
    STATS.shrubs++;
  }

  /* a columnar thuja: an ncross stack, no core, because at 1.2 m tall and
     0.5 m wide there is no interior to stop light with */
  function thuja(wx, wz, h, seed) {
    var y = lawnY(wx, wz) - 0.15, i;
    for (i = 0; i < 3; i++)
      wcross(P.needle, wx, y + h * 0.30 * i, wz,
             h * (0.44 - 0.10 * i), h * 0.46, rr(seed + i, 91, 0, Math.PI),
             NRECT[N_SHRUB], scaleT(T_SHRUB, 0.80 + 0.20 * i));
    STATS.shrubs++;
  }

  /* ---- THE PATHS ------------------------------------------------------ */
  /* NOTHING IN THIS PARK IS STRAIGHT EXCEPT THE HEDGE AND THE KERB.  The
     paving RIDES 9 cm above the turf sampling the identical lawnY -- the
     mesh is NOT cut around it.  A cut needs sub-metre lawn tessellation and
     always leaves a ragged seam; riding is robust, free, and matches the
     photographs, which show settled paving with the grass proud at its
     edge.  It is the WHITE EDGING LINE curving through the grass that reads
     as "municipal park path" in every one of the fifteen references --
     remove it and the path is a stain. */
  function pathY(wx, wz) { return lawnY(wx, wz) + 0.09; }
  function apronPathY(wx, wz) { return Math.max(lawnY(wx, wz), apronY(wx)) + 0.09; }

  function buildPathNetwork() {
    var A = keepPaths(walkway([[272, 220], [312, 232], [352, 242], [396, 238],
                               [440, 246], [468, 242], [480, 250]], 5.0, C.paver,
      { yfn: pathY, seed: 11, step: 4, edgeTone: C.edging, widthWobble: 0.20 }));
    var B = keepPaths(walkway([[312, 232], [318, 248], [330, 256], [348, 260]],
      4.6, C.paverCream,
      { yfn: pathY, seed: 12, step: 4, edgeTone: C.edging, widthWobble: 0.18,
        edgeStep: 2 }));
    var Cc = keepPaths(walkway([[396, 238], [390, 250], [378, 258], [368, 262]],
      4.6, C.paver,
      { yfn: pathY, seed: 13, step: 4, edgeTone: C.edging, widthWobble: 0.18,
        edgeStep: 2 }));
    var D = keepPaths(walkway([[440, 246], [452, 254], [462, 258], [472, 254],
                               [480, 260]], 4.6, C.paverCream,
      { yfn: pathY, seed: 14, step: 4, edgeTone: C.edging, widthWobble: 0.18,
        edgeStep: 2 }));
    var E = keepPaths(walkway([[468, 242], [470, 252], [476, 258], [480, 260]],
      4.6, C.paver,
      { yfn: pathY, seed: 15, step: 4, edgeTone: C.edging, widthWobble: 0.18,
        edgeStep: 2 }));

    /* SIX apron connectors crossing world Z 216 at the hedge gaps.  Each is
       given a slight S so that not one path in the park is straight. */
    var CX = [276, 312, 368, 424, 468, 480], i, CN = [];
    for (i = 0; i < CX.length; i++) {
      var x = CX[i], b = rr(i, 51, -1.6, 1.6);
      CN.push(keepPaths(walkway([[x, 206.5], [x + b, 212], [x - b, 219.5],
                                 [x + b * 0.5, 225.5]], 4.4, C.paverCream,
        { yfn: apronPathY, seed: 21 + i, step: 4, edgeTone: C.edging,
          widthWobble: 0.14 })));
    }
    return { A: A, B: B, C: Cc, D: D, E: E, CN: CN, CX: CX };
  }

  /* FIVE DESIRE LINES cutting the inside of the curves and the junctions */
  function desireLines() {
    desireLine(314, 236, 326, 251, 3.2, 101);      /* inside of B          */
    desireLine(394, 243, 380, 255, 3.0, 102);      /* inside of C          */
    desireLine(437, 250, 452, 258, 2.8, 103);      /* A/D junction         */
    desireLine(466, 246, 476, 256, 2.8, 104);      /* A/E junction         */
    desireLine(306, 228, 316, 240, 2.6, 105);      /* A/B spur junction    */
  }

  /* ---- THE WHITE EDGING STRIP AT THE LAWN'S NORTH EDGE ----------------
     Job A's cream border course ends flat at world Z 216.00; this is the
     0.55 u x 0.12 u precast strip that stands on it, and it is the
     brightest line in the composition.  There is NO wall and NO railing
     along the park's street frontage: the boundary is the kerb, this
     strip, and the hedge line standing directly in the grass behind it. */
  function lawnEdging(gaps) {
    var i, n = 22, x0 = LAWN.x0, x1 = LAWN.x1, EW = 0.55, EH = 0.12;
    for (i = 0; i < n; i++) {
      var xa = x0 + (x1 - x0) * i / n, xb = x0 + (x1 - x0) * (i + 1) / n;
      var xm = (xa + xb) * 0.5, skip = false, k;
      for (k = 0; k < gaps.length; k++)
        if (Math.abs(xm - gaps[k]) < 4.0) { skip = true; break; }
      if (skip) continue;
      var ya = worldGrade(xa) + 0.56, yb = worldGrade(xb) + 0.56;
      wquad(P.stone, [xa, ya + EH, 216.00], [xb, yb + EH, 216.00],
            [xb, yb + EH, 216 + EW], [xa, ya + EH, 216 + EW],
            [xm, (ya + yb) * 0.5 - 2, 216.3], C.edging);
      wquad(P.stone, [xa, ya - 0.12, 216.00], [xa, ya + EH, 216.00],
            [xb, yb + EH, 216.00], [xb, yb - 0.12, 216.00],
            [xm, (ya + yb) * 0.5, 217.0], C.edging);
    }
  }

  /* ===================== the two entry points ========================= */
  function buildLawn() {
    PATHPTS.length = 0; DOMES.length = 0;
    initToneCache();
    lawnMesh();
    var net = buildPathNetwork();
    lawnEdging(net.CX);
    desireLines();

    /* bare soil where the feet go: eleven patches at the path junctions,
       under the park pines and along the two desire lines */
    soilPatch(313, 234, 6.0, 201); soilPatch(395, 241, 5.4, 202);
    soilPatch(440, 249, 5.0, 203); soilPatch(478, 245, 4.0, 204);
    soilPatch(476, 259, 3.8, 205); soilPatch(348, 259, 4.2, 206);
    soilPatch(368, 261, 3.8, 207); soilPatch(274, 223, 5.6, 208);
    soilPatch(334, 252, 6.2, 209); soilPatch(466, 231, 5.6, 210);
    soilPatch(458, 224, 4.2, 211);

    /* LAYER 3.  The lawn perimeter first -- the north edge at 1.8 u is the
       hero, everything else at 3.0-3.4. */
    var i;
    for (i = 0; i < 16; i++) {
      var xa = LAWN.x0 + (LAWN.x1 - LAWN.x0) * i / 16;
      var xb = LAWN.x0 + (LAWN.x1 - LAWN.x0) * (i + 1) / 16;
      fringeAlong(xa, 216.62, xb, 216.62, 2.2, 300 + i * 40);
      fringeAlong(xa, 264.85, xb, 264.85, 4.0, 700 + i * 40);
    }
    fringeAlong(268.2, 217, 268.2, 264, 4.0, 1100);
    fringeAlong(483.8, 217, 483.8, 264, 4.0, 1200);
    fringePath(net.A, 2.5, 1300);
    fringePath(net.B, 2.3, 1700);
    fringePath(net.C, 2.3, 1900);
    fringePath(net.D, 2.3, 2100);
    fringePath(net.E, 2.3, 2300);
    for (i = 0; i < net.CN.length; i++) fringePath(net.CN[i], 2.2, 2500 + i * 90);

    /* LAYER 4 */
    tuftScatter(130, 3300);
  }

  /* Hedges, shrub domes, the three park pines and the occluder list. */
  function plantLawn() {
    var i;
    /* (a) the five continuous runs at world Z 216.4..219.4, immediately
       behind the edging strip, broken by the connector gaps.  The first
       starts at X 282, not 272: path A's west entrance lands at (272,220)
       and a run starting at 272 would be paved straight through. */
    var RUNS = [[282, 306], [318, 362], [374, 418], [430, 462]];
    for (i = 0; i < RUNS.length; i++)
      hedgeRun(RUNS[i][0], RUNS[i][1], 217.9, 3.0, 3.3, 601 + i * 37);

    /* (b) nine loaf blocks out in the lawn.  Length, width and gap are all
       rr-driven and every one is tested against the path network and JOB
       C's furniture footprints before it is placed. */
    var lx = 292, placed = 0;
    for (i = 0; i < 40 && placed < 9 && lx < 476; i++) {
      var len = rr(i, 111, 8.7, 14.0), wid = rr(i, 112, 4.2, 5.2);
      var h = rr(i, 113, 3.5, 4.2), cx = lx + len * 0.5, got = -1, q;
      if (cx + len * 0.5 > 480) break;
      /* the whole footprint is tested, not one point with a huge margin */
      for (q = 0; q < 7 && got < 0; q++) {
        var cz = rr(i * 7 + q, 114, 224, 252);
        if (!clearOfFurniture(cx, cz, wid * 0.5 + 2.0)) continue;
        var free = true, e;
        for (e = -1; e <= 1; e++)
          if (!clearOfPaths(cx + e * len * 0.42, cz, wid * 0.5 + 3.4)) free = false;
        if (free) got = cz;
      }
      if (got >= 0) {
        hedgeLoaf(cx, got, len, wid, h, 771 + i * 53);
        lx += len + rr(i, 115, 3.5, 10.0); placed++;
      } else lx += rr(i, 118, 4.0, 9.0);
    }

    /* 20 clipped domes at irregular 5-8 m spacing, and four columnar
       thuja.  1.2-1.6 m across, 0.9-1.2 m tall.  NO FLOWER BEDS. */
    var dn = 0;
    for (i = 0; i < 520 && dn < 20; i++) {
      var wx = rr(i, 121, LAWN.x0 + 6, LAWN.x1 - 6);
      var wz = rr(i, 122, LAWN.z0 + 6, LAWN.z1 - 5);
      if (!clearOfPaths(wx, wz, 5.6) || !clearOfFurniture(wx, wz, 3.5)) continue;
      var ok = true, j;
      for (j = 0; j < DOMES.length; j++) {
        var ddx = DOMES[j][0] - wx, ddz = DOMES[j][1] - wz;
        if (ddx * ddx + ddz * ddz < 13.0 * 13.0) { ok = false; break; }
      }
      if (!ok) continue;
      DOMES.push([wx, wz]);
      shrubDome(wx, wz, rr(i, 123, 2.1, 2.8), rr(i, 124, 3.2, 4.2),
                scaleT(T_SHRUB, rr(i, 125, 0.86, 1.14)), 901 + i * 29);
      dn++;
    }
    var TH = [[290, 252], [412, 258], [458, 224], [474, 250]];
    for (i = 0; i < TH.length; i++)
      if (clearOfPaths(TH[i][0], TH[i][1], 4.5))
        thuja(TH[i][0], TH[i][1], rr(i, 131, 3.2, 5.2), 951 + i * 17);

    /* THREE PARK PINES.  evergreen() is frozen and is called unmodified;
       authored x = world Z, authored z = 740 - world X.  Each gets bare
       soil at its base, because that is where the grass has gone. */
    var PP = [[334, 254, 29, 8.2], [466, 232, 27, 7.6], [300, 228, 25, 7.0]];
    for (i = 0; i < PP.length; i++) {
      evergreen(PP[i][1], AXIS_ORIGIN - PP[i][0], PP[i][2], PP[i][3], false);
      soilPatch(PP[i][0], PP[i][1], 4.2, 400 + i);
      fringeAlong(PP[i][0] - 4, PP[i][1] + 4.2, PP[i][0] + 4, PP[i][1] + 4.2,
                  2.2, 460 + i * 20);
    }

    /* OCCLUDERS, JOB B's nine.  nz-street-sky.js:1573 SILENTLY DISCARDS any
       box with a dimension over 26 u, so every run is chopped to a 24-u
       box centred on it -- a 44-u run registered whole would get exactly
       zero contact shadow and no warning. */
    for (i = 0; i < RUNS.length; i++) {
      var cxr = (RUNS[i][0] + RUNS[i][1]) * 0.5;
      var w = Math.min(24, RUNS[i][1] - RUNS[i][0]);
      var gyr = worldGrade(cxr) + 0.58;
      occ(cxr - w * 0.5, gyr - 0.3, 216.2, cxr + w * 0.5, gyr + 3.3, 219.6);
    }
    occ(340, worldGrade(352) - 0.2, 226, 364, worldGrade(352) + 4.4, 250);
    for (i = 0; i < PP.length; i++)
      occ(PP[i][0] - 8, worldGrade(PP[i][0]) + PP[i][2] * 0.45, PP[i][1] - 8,
          PP[i][0] + 8, worldGrade(PP[i][0]) + PP[i][2] * 0.98, PP[i][1] + 8);
  }


  /* =====================================================================
     JOB C -- THE PARK FURNITURE
     benches, the two kamelyas, the picnic shelter and its railed terrace,
     picnic sets, the fitness rigs, the bins, the fences and the park sign.

     THE OWNER NAMED THE GAZEBOS.  What was there: an 11.2-u timber deck,
     four 0.18-u VERTICAL tubes and a solid pyramid running from eaves
     gy+8.7 to an apex at gy+12.0 -- a 28.8 degree hip, no fascia, no
     soffit, no eaves shadow, one tone top and bottom.  Every one of those
     is a separate reason it read as a paper toy.  The photographs
     (de5ba0a8, c3cd09a9) show the opposite on all four counts: a nearly
     FLAT hip at about 17 degrees, a VISIBLE fascia edge, a soffit that
     reads near-black against the lit slope, and slender black steel posts
     that VISIBLY RAKE outward.  All four are built below.

     THE TRANSFORM, restated: worldX = 740 - authoredZ, worldZ = authoredX,
     grade(z) takes an AUTHORED z and worldGrade(x) = grade(740 - x).
     Every number in this block is a WORLD coordinate; the conversion
     happens exactly once, in lpt(), so there is no authored arithmetic
     anywhere in the furniture and it cannot be got wrong twice.
     ARGUMENT ORDERS, stated so nothing has to be guessed:
       frameAt(worldX, worldZ, yaw)      -> a local frame; yaw 0 puts local
                                            +x on world +X and +z on +Z
       lpt(f, localX, y, localZ)         -> the authored triple poly() wants
       obox(pile, f, x0, x1, yc, zc, hu, hv, rake, tone)
       roofSlab(pile, f, hx, hz, yEaves, rise, inset, thick, top, under)
       bench(worldX, worldZ, yaw)   kamelya(worldX, worldZ, yaw)
       fitnessRig(worldX, worldZ, yaw, kind)
     ===================================================================== */

  /* ---- the local frame ------------------------------------------------
     Furniture is the one thing in this module that is NOT axis-aligned: a
     bench has to face its path and a kamelya has to sit square to the run
     of the park, so everything here is authored in the object's own frame
     and converted once at the vertex. */
  function frameAt(wx, wz, yaw) {
    return { x: wx, z: wz, c: Math.cos(yaw || 0), s: Math.sin(yaw || 0) };
  }
  function lwx(f, lx, lz) { return f.x + lx * f.c - lz * f.s; }
  function lwz(f, lx, lz) { return f.z + lx * f.s + lz * f.c; }
  function lpt(f, lx, y, lz) {
    return [f.z + lx * f.s + lz * f.c, y,
            AXIS_ORIGIN - (f.x + lx * f.c - lz * f.s)];
  }

  /* THE ONE SOURCE OF GROUND HEIGHT UNDER A PIECE OF FURNITURE.  Inside
     the lawn that is JOB B's lawnY and nothing else; outside it, JOB A's
     apron datum.  Nothing in this block computes its own. */
  function groundY(wx, wz) {
    if (wx >= LAWN.x0 - 1 && wx <= LAWN.x1 + 1 &&
        wz >= LAWN.z0 - 1 && wz <= LAWN.z1 + 1) return lawnY(wx, wz);
    return worldGrade(wx) + 0.56;
  }
  function padY(wx, wz) { return lawnY(wx, wz) + 0.06; }

  /* ---- MEASURED TONE GAINS -------------------------------------------
     THE RATIO IS THE ACCEPTANCE TEST, NOT THE HEX.  The C table's entries
     were solved as Y(tone)/Y(C.asphalt), which is only valid where the map
     mean and the bake floor/scale match the road's -- and they do not.
     P.roof carries the corrugated map (strong dark ribs, mean well under
     the asphalt map's) and bakes at floor .48 / scale .94 against the
     road's .58 / .97; P.wood is the darkest-floored pile in the module at
     .40 / .92 and its map is drawn with heavy grain.
     MEASURED, ONCE, in _shots/jobc/meas.png with the regions isolated by
     hue on a per-pixel mask rather than by hand-drawn boxes (hand boxes
     mixed sky into the roof and gave an answer 2x out), the road taken as
     the median of 12,080 near-neutral carriageway pixels and CROSS-CHECKED
     against JOB B's shipped lawn, which came back at 0.355 against its
     stated 0.37 -- i.e. the reference in that frame is good to 4 %:
         C.oxide  as passed   0.173   target 0.48   ->  gain 1.87
     AND THE TRANSFER IS NOT LINEAR, which is the whole reason the C
     table's predicted hexes miss.  Gain 2.60 was tried first and the roof
     came back at 0.827 -- salmon, the exact circus tent the spec warns
     about -- so the two measured points (1.00 -> 0.173, 2.60 -> 0.827)
     were interpolated in log space, which puts 0.48 at gain 1.87.  Two
     iterations on this surface and then stop, per RISKS.md.
         C.picnicTimber       0.060   target 0.29   ->  under the shelter
                                                       roof, i.e. fully
                                                       occluded; open-air
                                                       timber measures
                                                       about 0.14, so 2.10
         C.fitFrame           1.513   target 1.35   ->  11 % high, LEFT
         C.yellow             1.257   target 1.30   ->  on target, LEFT
         C.railBlack          0.049   target 0.06   ->  on target, LEFT
     The gains live here and NOT in the C table, which is JOB A's and is
     shared with buildCityTerminus, northApartment and the south frontage.
     THE SOFFIT DOES NOT TAKE THE GAIN: the photographs put the lit slope
     at dusty terracotta and the far slope's underside at near-black, and
     0.45 against 0.095 is that 4.7 : 1. */
  var OXIDE_GAIN = 1.87, TIMBER_GAIN = 2.10;
  var T_OXIDE = null, T_SOFFIT = null, T_BENCHW = null, T_PICNICW = null;
  function initFurnitureTones() {
    T_OXIDE   = scaleT(C.oxide, OXIDE_GAIN);
    /* 0.26 measured 0.020 against the road -- black, not near-black, and
       it swallowed everything under the shelter.  0.55 keeps the far
       slope's underside reading dark against a 0.46 lit slope while the
       corrugation and the posts stay legible from underneath. */
    T_SOFFIT  = scaleT(C.oxide, 0.55);
    T_BENCHW  = scaleT(C.benchTimber, TIMBER_GAIN);
    T_PICNICW = scaleT(C.picnicTimber, TIMBER_GAIN);
  }

  /* JOB B's shrub domes are placed by rejection sampling against the path
     network and against RESERVED, and RESERVED holds the kamelyas, the
     terrace, the rigs and the sign -- but NOT the six bench pads, which
     did not exist when plantLawn ran.  The first render put a dome
     squarely in front of bench 6.  DOMES is module scope and is filled
     before buildParkFurniture, so a bench slides along its own long axis
     until it is clear of every dome and still off the path.  Deterministic,
     and it moves the bench rather than the planting, which is JOB B's. */
  function clearOfDomes(wx, wz, r) {
    for (var i = 0; i < DOMES.length; i++) {
      var dx = DOMES[i][0] - wx, dz = DOMES[i][1] - wz;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }
  function benchSpot(wx, wz, yaw) {
    var ca = Math.cos(yaw), sa = Math.sin(yaw), i;
    var OFF = [0, 7, -7, 12, -12, 17, -17, 22, -22];
    for (i = 0; i < OFF.length; i++) {
      /* slide along the bench's OWN LONG AXIS (local x, world (ca, sa)),
         which runs parallel to the path it faces -- sliding along local z
         would walk it into or away from that path instead */
      var x = wx + OFF[i] * ca, z = wz + OFF[i] * sa;
      if (x < LAWN.x0 + 6 || x > LAWN.x1 - 6) continue;
      if (z < LAWN.z0 + 5 || z > LAWN.z1 - 5) continue;
      if (!clearOfDomes(x, z, 7.0)) continue;
      if (!clearOfPaths(x, z, 6.2)) continue;
      return [x, z];
    }
    return [wx, wz];
  }

  /* An oriented box.  Local x runs x0..x1; in the local (y,z) plane it is a
     rectangle centred (yc,zc) with half-extent hu along (cos rake, sin rake)
     and hv along the perpendicular.  rake = 0 is an ordinary axis-aligned
     box; rake != 0 is what tilts the bench back off vertical, which box()
     cannot do at all.  poly() flips every face against the centre, so the
     winding cannot invert.  12 triangles, the same as box(). */
  function obox(p, f, x0, x1, yc, zc, hu, hv, rake, t) {
    var cr = Math.cos(rake || 0), sr = Math.sin(rake || 0);
    function V(sx, su, sv) {
      return lpt(f, sx, yc + su * hu * cr - sv * hv * sr,
                       zc + su * hu * sr + sv * hv * cr);
    }
    var r = lpt(f, (x0 + x1) * 0.5, yc, zc);
    poly(p, [V(x0,-1,-1), V(x0,-1, 1), V(x0, 1, 1), V(x0, 1,-1)], r, t);
    poly(p, [V(x1,-1,-1), V(x1,-1, 1), V(x1, 1, 1), V(x1, 1,-1)], r, t);
    poly(p, [V(x0,-1,-1), V(x1,-1,-1), V(x1,-1, 1), V(x0,-1, 1)], r, t);
    poly(p, [V(x0, 1,-1), V(x1, 1,-1), V(x1, 1, 1), V(x0, 1, 1)], r, t);
    poly(p, [V(x0,-1,-1), V(x1,-1,-1), V(x1, 1,-1), V(x0, 1,-1)], r, t);
    poly(p, [V(x0,-1, 1), V(x1,-1, 1), V(x1, 1, 1), V(x0, 1, 1)], r, t);
  }
  /* a tube between two LOCAL points.  Every end here is buried in the
     ground, in a deck or in another member, so caps are always off: a
     capped tube costs 2*sides + 2*(sides-2) instead of 2*sides, and
     BUDGET.md is explicit that P.metal is already 60 % of this module. */
  function ltube(p, f, x0, y0, z0, x1, y1, z1, r, sides, t) {
    tube(p, lpt(f, x0, y0, z0), lpt(f, x1, y1, z1), r, sides, t, false);
  }

  /* ---- roofSlab: the three things that stop a shelter roof looking like
     paper, implemented once for both the kamelya and the shelter --------
     (1) IT IS A SLAB, NOT A PLANE.  Top skin, soffit, and an edge band all
         the way round that reads as a FASCIA.  The photographs are
         explicit -- "the lit slope reads dusty terracotta; the underside of
         the far slope reads near-black" -- and a single-sided plane cannot
         do this at all.  That absence is why the old gazebo read as card.
     (2) the posts rake (see kamelya/picnicShelter below).
     (3) the eaves overhang, and the roof is registered as a bake occluder,
         which is what puts the dark line under the eaves that separates
         roof from post.
     inset > 0 gives a HIP (the kamelya); inset 0 gives a GABLE (the
     shelter), whose end fascia follows the rake instead of cutting across
     it.  20 triangles either way.  CORRUGATION IS FREE: it comes off JOB
     A's retuned 'roof' canvas -- vertical ribs at 0.27 u -- which this
     block consumes and never edits. */
  function roofSlab(p, f, hx, hz, yE, rise, inset, thick, topT, underT) {
    var rx0 = -hx + inset, rx1 = hx - inset, yR = yE + rise, d = thick;
    var fasT = scaleT(topT, 0.74);
    function T(lx, y, lz) { return lpt(f, lx, y, lz); }
    var refT = lpt(f, 0, yE - 4, 0);            /* top skin looks up   */
    var refU = lpt(f, 0, yR + 4, 0);            /* soffit looks down   */
    var refF = lpt(f, 0, yE - d * 0.5, 0);
    poly(p, [T(-hx,yE,-hz), T(hx,yE,-hz), T(rx1,yR,0), T(rx0,yR,0)], refT, topT);
    poly(p, [T(hx,yE,hz), T(-hx,yE,hz), T(rx0,yR,0), T(rx1,yR,0)], refT, topT);
    poly(p, [T(-hx,yE-d,-hz), T(hx,yE-d,-hz), T(rx1,yR-d,0), T(rx0,yR-d,0)], refU, underT);
    poly(p, [T(hx,yE-d,hz), T(-hx,yE-d,hz), T(rx0,yR-d,0), T(rx1,yR-d,0)], refU, underT);
    if (inset > 0.01) {
      poly(p, [T(-hx,yE,-hz), T(-hx,yE,hz), T(rx0,yR,0)], refT, topT);
      poly(p, [T(hx,yE,hz), T(hx,yE,-hz), T(rx1,yR,0)], refT, topT);
      poly(p, [T(-hx,yE-d,-hz), T(-hx,yE-d,hz), T(rx0,yR-d,0)], refU, underT);
      poly(p, [T(hx,yE-d,hz), T(hx,yE-d,-hz), T(rx1,yR-d,0)], refU, underT);
    }
    /* THE FASCIA, 0.42 u deep and visible: the eaves shadow line is the
       second-strongest cue after the pitch itself. */
    poly(p, [T(-hx,yE,-hz), T(hx,yE,-hz), T(hx,yE-d,-hz), T(-hx,yE-d,-hz)], refF, fasT);
    poly(p, [T(-hx,yE,hz), T(hx,yE,hz), T(hx,yE-d,hz), T(-hx,yE-d,hz)], refF, fasT);
    if (inset > 0.01) {
      poly(p, [T(-hx,yE,-hz), T(-hx,yE,hz), T(-hx,yE-d,hz), T(-hx,yE-d,-hz)], refF, fasT);
      poly(p, [T(hx,yE,-hz), T(hx,yE,hz), T(hx,yE-d,hz), T(hx,yE-d,-hz)], refF, fasT);
    } else {
      var e;
      for (e = -1; e <= 1; e += 2) {
        var sx = e * hx;
        poly(p, [T(sx,yE,-hz), T(sx,yR,0), T(sx,yR-d,0), T(sx,yE-d,-hz)],
             refF, fasT);
        poly(p, [T(sx,yE,hz), T(sx,yR,0), T(sx,yR-d,0), T(sx,yE-d,hz)],
             refF, fasT);
      }
    }
  }

  /* ---- the bench ------------------------------------------------------
     length 1.7 m = 5.95 u, seat 0.45 m = 1.58 u, back top 0.88 m = 3.08 u.
     THE CUE IS THE SLAT GAPS: at 2 m you see grass and light between them,
     and the shadow under the seat is striped, which bakeTone gives free
     from a slatted build.  Two solid boxes can do neither.
     DEVIATION, DELIBERATE: the brief's slat section -- 1.05 u wide by 0.42
     thick with 0.18 gaps -- is a 300 x 120 mm timber, and four of them make
     a 4.74 u (1.35 m) deep seat, which on a 1.7 m bench is a table.  The
     photographed bench (ed2f6a5c at 1340,285) is four ~95 mm battens on a
     0.50 m seat, and that is what is built: the gap count, the gap cue and
     the 168-triangle budget are all honoured, the section is not.
     COLOUR: weathered grey-green, C.benchTimber, never a fresh colour. */
  function bench(wx, wz, yaw) {
    var f = frameAt(wx, wz, yaw), g = padY(wx, wz);
    var L = 5.95, HS = 1.58, i;
    var st = T_BENCHW, mt = C.railBlack;
    var sw = 0.34, sg = 0.13, sth = 0.11;         /* 97 mm batten, 37 mm gap */
    var depth = 4 * sw + 3 * sg, z0 = -depth * 0.5;
    for (i = 0; i < 4; i++)
      obox(P.wood, f, -L * 0.5, L * 0.5, g + HS,
           z0 + sw * 0.5 + i * (sw + sg), sth, sw * 0.5, 0, st);
    /* the back, four battens RAKED 10 degrees off vertical */
    var rk = 10 * Math.PI / 180, bw = 0.28, bg = 0.10;
    var yb = g + HS + 0.10, zb = z0 + depth - 0.14;
    for (i = 0; i < 4; i++) {
      var dk = 0.16 + bw * 0.5 + i * (bw + bg);
      obox(P.wood, f, -L * 0.5, L * 0.5,
           yb + dk * Math.cos(rk), zb + dk * Math.sin(rk),
           bw * 0.5, 0.10, rk, st);
    }
    /* TWO SIMPLE ANGLED FLAT-STEEL LEG FRAMES, three members each -- not
       cast scrolls, not turned tubes.  Four sides at r 0.07 is a 0.14 u
       section, which is exactly the open-metalwork concession R3 allows in
       walkable ground, and 8 triangles instead of a box's 12. */
    for (i = 0; i < 2; i++) {
      var xe = (i ? 1 : -1) * (L * 0.5 - 0.55);
      ltube(P.metal, f, xe, g, z0 - 0.42, xe, g + HS, z0 + 0.30, 0.07, 4, mt);
      ltube(P.metal, f, xe, g, zb + 0.46, xe, g + HS, zb - 0.05, 0.07, 4, mt);
      ltube(P.metal, f, xe, g + HS - 0.14, z0 - 0.20,
                        xe, g + HS - 0.14, zb + 0.22, 0.07, 4, mt);
    }
    STATS.benches++;
  }

  /* SECOND CUE, consistent across every bench in the master photograph:
     the bench sits on ITS OWN SMALL PAVED PAD let into the grass, edged
     with the white 0.15 m strip, SET BACK FROM THE PATH AND FACING IT.
     R1 caps a solid pad at 0.62 u of relief, but the photograph shows the
     pad flush with the turf, not standing on it, so it rides at lawnY+0.06
     with only its 0.12 u edging proud -- legal twice over. */
  function benchPad(wx, wz, yaw, seed) {
    var f = frameAt(wx, wz, yaw);
    return walkway([[lwx(f, -4.2, 0), lwz(f, -4.2, 0)],
                    [lwx(f,  4.2, 0), lwz(f,  4.2, 0)]], 6.3, C.paver,
      { yfn: padY, seed: seed, step: 4.2, edgeTone: C.edging,
        widthWobble: 0.06, wobble: 0.02 });
  }

  /* ---- the picnic set -------------------------------------------------
     table 0.75 m = 2.63 u, bench seats 0.45 m = 1.58 u, warm MID-BROWN
     timber on steel underframes.  C.picnicTimber and C.benchTimber are two
     DIFFERENT timbers at the same 0.29 ratio and are deliberately not
     merged: the park benches are weathered grey-green, these are brown. */
  function picnicSet(f, g, len) {
    var tw = T_PICNICW, mt = C.railBlack, hl = len * 0.5, i;
    for (i = 0; i < 3; i++)
      obox(P.wood, f, -hl, hl, g + 2.63, -1.05 + i * 1.05, 0.15, 0.46, 0, tw);
    for (i = 0; i < 2; i++)
      obox(P.wood, f, -hl * 0.94, hl * 0.94, g + 1.58,
           (i ? 1 : -1) * 2.95, 0.13, 0.72, 0, tw);
    for (i = 0; i < 2; i++) {
      var xf = (i ? 1 : -1) * hl * 0.60;
      ltube(P.metal, f, xf, g, -3.5, xf, g + 2.48, 0.55, 0.11, 5, mt);
      ltube(P.metal, f, xf, g,  3.5, xf, g + 2.48, -0.55, 0.11, 5, mt);
      ltube(P.metal, f, xf, g + 1.45, -3.5, xf, g + 1.45, 3.5, 0.09, 5, mt);
    }
  }

  /* ---- the kamelya ----------------------------------------------------
     roof plan 3.4 m = 11.2 u, eaves 2.3 m = 8.05 u, RIDGE 2.8 m = 9.80 u,
     so the RISE IS 1.75 u, NOT the old 3.3 -- a 17 degree hip, nearly
     flat.  Fixing the pitch alone removes half the toy read.  Overhang
     0.35 m = 1.22 u on all four sides; fascia 0.42 u and visible; soffit
     near-black.  FOUR POSTS THAT VISIBLY RAKE: top inset 0.5 u from the
     roof corner, base splayed 0.72 u out on each axis (1.02 u on the
     diagonal), which is the 6-8 degrees the photographs show.  Vertical
     posts read as a table; raked posts read as a municipal shelter.
     THE ROOF IS LEVEL AND THE GROUND IS NOT.  worldGrade falls 7 % and
     0.78 u across an 11.2-u kamelya, so the eaves datum is taken at the
     HIGH corner: the low corner simply gets a longer post, which is what
     the real ones do.  The clearance is checked there too -- eaves land at
     worldGrade + 9.33 against a SAFE_Y of worldGrade + 8.60, so nothing
     the player can jump into is ever below the soffit. */
  function kamelya(cx, cz, yaw) {
    var f = frameAt(cx, cz, yaw);
    var hx = 5.6, hz = 4.9, OH = 1.22, i, j;
    var gHi = -1e9, gc = groundY(cx, cz);
    for (i = -1; i <= 1; i += 2) for (j = -1; j <= 1; j += 2) {
      var q = groundY(lwx(f, i * hx, j * hz), lwz(f, i * hx, j * hz));
      if (q > gHi) gHi = q;
    }
    var yE = gHi + 8.75;
    roofSlab(P.roof, f, hx, hz, yE, 1.75, 4.2, 0.42, T_OXIDE, T_SOFFIT);
    var px = hx - OH - 0.5, pz = hz - OH - 0.5;
    for (i = -1; i <= 1; i += 2) for (j = -1; j <= 1; j += 2) {
      var bx = i * (px + 0.72), bz = j * (pz + 0.72);
      ltube(P.metal, f, bx, groundY(lwx(f, bx, bz), lwz(f, bx, bz)) - 0.35, bz,
                        i * px, yE - 0.42, j * pz, 0.19, 4, C.railBlack);
    }
    picnicSet(f, gc, 8.4);
    binBox(lwx(f, 6.4, 2.6), lwz(f, 6.4, 2.6));
    /* THE OCCLUDER SITS UNDER THE ROOF, NOT AROUND IT.  hitsBoxT
       (nz-street-sky.js:1442) only exempts a vertex STRICTLY inside a box,
       so a box drawn round the whole roof leaves every eaves and ridge
       vertex exactly ON its boundary -- and with the shelter's two boxes,
       each one eats half the other's hemisphere.  The first render came
       back with both roofs baked to the floor: not terracotta at 0.48, a
       black slab.  The box top is therefore 0.13 u clear of the lowest
       roof vertex (the fascia foot at yE - 0.42), which shades everything
       BELOW the eaves -- posts, table, deck, grass -- and nothing above. */
    occ(cx - hx, yE - 2.4, cz - hz, cx + hx, yE - 0.55, cz + hz);
    STATS.gazebos++;
  }

  /* ---- the picnic shelter and its railed terrace, the hero object -----
     Deck 9.5 x 4.3 m = 33 x 15 u.  THE DECK IS RAISED 0.55 u AND FOLLOWS
     THE GROUND.  Two compromises are forced here and both are deliberate:
     (a) the photographed terrace is a 0.40-0.50 m plinth, but the gameplay
     collision floor is flat per 4-u column and R1 caps visual relief at
     0.62 u, so a real terrace would put the player's feet 25 cm in the air
     with nothing to hide it -- 0.55 u is the cap and this is the explicit
     compromise; (b) worldGrade falls 2.31 u across the deck's 33 u, so a
     LEVEL deck would bury its west end and float its east end past the same
     cap.  The deck top therefore rides groundY + 0.55 everywhere, which
     keeps the relief legal along the whole run.  DO NOT "FIX" EITHER BACK
     INTO A COLLISION BUG.
     The roof, being far above SAFE_Y, is free to be level, and is.
     A PINE GROWS STRAIGHT THROUGH THE DECK -- the deck top is split around
     a 4.0-u octagonal well and evergreen() is called unmodified.  It is in
     two of the three reference photographs and it is what makes the
     structure read as built-around rather than placed. */
  function picnicShelter(cx, cz) {
    var f = frameAt(cx, cz, 0);
    var HX = 16.5, HZ = 7.5, i, j;
    function dy(lx, lz) {
      return groundY(lwx(f, lx, lz), lwz(f, lx, lz)) + 0.55;
    }
    function dp(lx, lz) { return lpt(f, lx, dy(lx, lz), lz); }
    var deckT = mixColor(C.asphaltDark, C.asphalt, 0.30);
    function dquad(p, x0, x1, z0, z1, t) {
      poly(p, [dp(x0, z0), dp(x1, z0), dp(x1, z1), dp(x0, z1)],
           lpt(f, (x0 + x1) * 0.5, dy((x0 + x1) * 0.5, (z0 + z1) * 0.5) - 4,
               (z0 + z1) * 0.5), t);
    }
    /* PALE CONCRETE COPING on top of the rendered face, then the dark
       paved field inside it, split around the tree well. */
    var IX = HX - 0.9, IZ = HZ - 0.9;
    dquad(P.stone, -HX, HX, -HZ, -IZ, C.curb);
    dquad(P.stone, -HX, HX,  IZ,  HZ, C.curb);
    dquad(P.stone, -HX, -IX, -IZ,  IZ, C.curb);
    dquad(P.stone,  IX,  HX, -IZ,  IZ, C.curb);
    var XS = [-IX, -3, 3, IX], ZS = [-IZ, -3, 3, IZ];
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      dquad(P.asphalt, XS[i], XS[i + 1], ZS[j], ZS[j + 1], deckT);
    }
    function ring(an) {
      var ca = Math.cos(an), sa = Math.sin(an);
      var k = 3.0 / Math.max(Math.abs(ca), Math.abs(sa));
      return [[ca * 2.0, sa * 2.0], [ca * k, sa * k]];
    }
    for (i = 0; i < 8; i++) {
      var r0 = ring(i * Math.PI / 4), r1 = ring((i + 1) * Math.PI / 4);
      poly(P.asphalt, [dp(r0[0][0], r0[0][1]), dp(r1[0][0], r1[0][1]),
                       dp(r1[1][0], r1[1][1]), dp(r0[1][0], r0[1][1])],
           lpt(f, 0, dy(0, 0) - 4, 0), deckT);
    }
    /* the grey rendered face, subdivided so it follows the ground it
       stands on instead of cutting a straight line across it */
    var faceT = mixColor(C.stone, C.white, 0.42);
    for (i = 0; i < 6; i++) {
      var x0 = -HX + HX * 2 * i / 6, x1 = -HX + HX * 2 * (i + 1) / 6;
      for (j = -1; j <= 1; j += 2) {
        var zf = j * HZ;
        poly(P.masonry,
             [lpt(f, x0, dy(x0, zf), zf), lpt(f, x1, dy(x1, zf), zf),
              lpt(f, x1, dy(x1, zf) - 0.92, zf), lpt(f, x0, dy(x0, zf) - 0.92, zf)],
             lpt(f, (x0 + x1) * 0.5, dy(0, 0), 0), faceT);
      }
    }
    for (i = -1; i <= 1; i += 2) {
      var xf = i * HX;
      poly(P.masonry,
           [lpt(f, xf, dy(xf, -HZ), -HZ), lpt(f, xf, dy(xf, HZ), HZ),
            lpt(f, xf, dy(xf, HZ) - 0.92, HZ), lpt(f, xf, dy(xf, -HZ) - 0.92, -HZ)],
           lpt(f, 0, dy(0, 0), 0), faceT);
    }

    /* ROOF: shallow gable, RED CORRUGATED, eaves 8.05 u, ridge 10.15 u,
       overhang 1.4 u.  Level, with the datum taken at the high (west) end
       so the clearance is right where the ground is highest. */
    var yE = dy(-HX, 0) + 8.05;
    roofSlab(P.roof, f, HX + 1.4, HZ + 1.4, yE, 2.10, 0, 0.28, T_OXIDE, T_SOFFIT);

    /* EIGHT POSTS at 8.75 u centres, black steel, VISIBLY RAKED OUTWARD */
    var PXS = [-13.1, -4.4, 4.4, 13.1];
    for (i = 0; i < PXS.length; i++) for (j = -1; j <= 1; j += 2) {
      var tz = j * (HZ - 0.6), bz2 = j * (HZ + 0.35);
      ltube(P.metal, f, PXS[i], dy(PXS[i], bz2) - 0.30, bz2,
                        PXS[i], yE - 0.28, tz, 0.19, 4, C.railBlack);
    }

    /* THE RAILING IS AN ALPHA CARD RUN, NOT GEOMETRY.  220 modelled
       balusters is 2,200 triangles for one object; one M_RAIL card per
       3.08-u tile plus three rail tubes is 52 for a 33-u run, and at 2 m
       the mid-height bulb is legible because it is drawn at 256 px rather
       than modelled at six sides.  The north side is broken for the
       entry.  MARK_TEX is ClampToEdge -- one card per tile-length. */
    function railY(wx, wz) { return groundY(wx, wz) + 0.55; }
    var RX0 = cx - HX + 0.45, RX1 = cx + HX - 0.45;
    var RZ0 = cz - HZ + 0.45, RZ1 = cz + HZ - 0.45;
    railRun(RX0, RZ1, RX1, RZ1, 3.5, C.railBlack, railY);
    railRun(RX0, RZ0, RX0, RZ1, 3.5, C.railBlack, railY);
    railRun(RX1, RZ0, RX1, RZ1, 3.5, C.railBlack, railY);
    railRun(RX0, RZ0, cx - 4.5, RZ0, 3.5, C.railBlack, railY);
    railRun(cx + 4.5, RZ0, RX1, RZ0, 3.5, C.railBlack, railY);

    /* THREE PICNIC SETS, arranged round the tree well */
    picnicSet(frameAt(lwx(f, -11.8, 0), lwz(f, -11.8, 0), 0), dy(-11.8, 0), 10.5);
    picnicSet(frameAt(lwx(f,  11.8, 0), lwz(f,  11.8, 0), 0), dy( 11.8, 0), 10.5);
    picnicSet(frameAt(lwx(f, 0, 4.9), lwz(f, 0, 4.9), 0), dy(0, 4.9), 8.4);

    /* the Type-A red arch bin at the corner */
    binArch(lwx(f, -14.6, -5.4), lwz(f, -14.6, -5.4), 0, dy(-14.6, -5.4));

    /* THE PINE THROUGH THE DECK.  evergreen() is frozen and is called
       unmodified: authored x = world Z 244, authored z = 740 - 452. */
    evergreen(244, 288, 31, 8.8, false);
    soilPatch(cx, cz, 2.5, 991);

    /* OCCLUDERS.  nz-street-sky.js:1573 SILENTLY DISCARDS any box with a
       dimension over 26 u, so the 35.8-u roof is chopped in two and the
       33-u deck is registered as the 24-u box under the middle of it -- a
       whole-length box would get exactly zero contact shadow and no
       warning at all.  Both roof boxes stop 0.42 u UNDER the roof slab and
       the deck box 0.15 u under the deck, for the self-shadow reason
       written out at kamelya() above. */
    occ(cx - HX - 1.4, yE - 2.6, cz - HZ - 1.4, cx, yE - 0.42, cz + HZ + 1.4);
    occ(cx, yE - 2.6, cz - HZ - 1.4, cx + HX + 1.4, yE - 0.42, cz + HZ + 1.4);
    occ(cx - 12, dy(0, 0) - 1.4, cz - HZ, cx + 12, dy(0, 0) - 0.15, cz + HZ);
    STATS.gazebos++;
  }

  /* ---- outdoor fitness, "acik hava spor aleti" ------------------------
     Silver-grey painted steel with BRIGHT YELLOW pads, standing DIRECTLY
     ON THE GRASS with no rubber surfacing, beside a path.  THE YELLOW IS
     THE POINT: it is the only saturated warm accent in the park besides
     the shelter roofs and it is what the eye lands on.
     SHAPE, CORRECTED AGAINST THE PHOTOGRAPH (ed2f6a5c at 1060,210) AFTER
     THE FIRST RENDER: this gear is NOT a tube A-frame.  It is one or two
     STOUT VERTICAL COLUMNS on FLARED CAST FEET, carrying round YELLOW DISC
     seats on short stalks and a few horizontal arms.  The first pass built
     splayed four-leg frames and they read as camera tripods in the park.
     frustum() gives the flared foot and the disc for the same triangles a
     tube would cost.  Five and six sides, caps only where a face is up. */
  function fitnessRig(wx, wz, yaw, kind) {
    var f = frameAt(wx, wz, yaw), g = groundY(wx, wz);
    var F = C.fitFrame, Y = C.yellow;
    function T(x0, y0, z0, x1, y1, z1, r) {
      ltube(P.metal, f, x0, y0, z0, x1, y1, z1, r === undefined ? 0.13 : r, 5, F);
    }
    /* the flared cast foot every one of them stands on */
    function foot(lx, lz, h) {
      var w = lpt(f, lx, 0, lz);
      frustum(P.metal, w[0], g - 0.35, w[2], 1.05, g + 0.85, 0.40, 6, F, false);
      T(lx, g - 0.3, lz, lx, g + h, lz, 0.34);
    }
    /* a round yellow disc seat or foot plate on its stalk */
    function disc(lx, ly, lz, r) {
      var w = lpt(f, lx, 0, lz);
      frustum(P.metal, w[0], ly - 0.34, w[2], r * 0.86, ly + 0.10, r, 6, Y, true);
    }
    if (kind === 1) {
      /* TWISTER: one column, a big yellow foot plate, a handle hoop */
      foot(0, 0, 4.6);
      disc(0, g + 1.05, 0, 1.55);
      T(-1.15, g + 4.5, 0, 1.15, g + 4.5, 0, 0.12);
      T(-1.15, g + 4.5, 0, -1.15, g + 3.6, 0.95, 0.11);
      T(1.15, g + 4.5, 0, 1.15, g + 3.6, 0.95, 0.11);
    } else if (kind === 2) {
      /* CHEST PRESS: two columns, a yellow disc seat, a yellow back pad
         and two push arms */
      foot(-1.5, 0, 5.0); foot(1.5, 0, 5.0);
      T(-1.5, g + 4.9, 0, 1.5, g + 4.9, 0, 0.13);
      disc(0, g + 2.35, -1.5, 1.15);
      obox(P.metal, f, -0.95, 0.95, g + 3.35, -0.30, 0.80, 0.14, 0.20, Y);
      T(-1.5, g + 3.7, -0.35, -1.5, g + 3.1, -1.9, 0.11);
      T(1.5, g + 3.7, -0.35, 1.5, g + 3.1, -1.9, 0.11);
    } else {
      /* AIR WALKER: one column, a cross-head, two swinging arms with
         yellow foot pads and two handles */
      foot(0, 0, 5.4);
      T(0, g + 5.3, -0.75, 0, g + 5.3, 0.75, 0.15);
      T(0, g + 5.25, -0.62, -1.55, g + 1.50, -0.72, 0.12);
      T(0, g + 5.25, 0.62, 1.55, g + 1.50, 0.72, 0.12);
      obox(P.metal, f, -2.05, -1.15, g + 1.42, -0.72, 0.13, 0.36, 0, Y);
      obox(P.metal, f, 1.15, 2.05, g + 1.42, 0.72, 0.13, 0.36, 0, Y);
      T(0, g + 5.1, -0.62, -0.95, g + 4.3, -1.0, 0.11);
      T(0, g + 5.1, 0.62, 0.95, g + 4.3, 1.0, 0.11);
    }
  }

  /* ---- bins -----------------------------------------------------------
     TYPE A, the red arch: a semicircular RED-OXIDE steel frame 1.10 m tall
     by 0.45 m wide from which a PALE BLUE-GREY body hangs, with a small
     white label.  One only, at the terrace corner. */
  function binArch(wx, wz, yaw, y) {
    var f = frameAt(wx, wz, yaw);
    var g = (y === undefined) ? groundY(wx, wz) : y;
    var R = C.binRed, W = 0.80, H = 3.85, st = H - W, i;
    ltube(P.metal, f, -W, g - 0.3, 0, -W, g + st, 0, 0.11, 5, R);
    ltube(P.metal, f,  W, g - 0.3, 0,  W, g + st, 0, 0.11, 5, R);
    for (i = 0; i < 3; i++) {
      var a0 = Math.PI * i / 3, a1 = Math.PI * (i + 1) / 3;
      ltube(P.metal, f, -W * Math.cos(a0), g + st + W * Math.sin(a0), 0,
                        -W * Math.cos(a1), g + st + W * Math.sin(a1), 0,
            0.10, 5, R);
    }
    obox(P.metal, f, -0.62, 0.62, g + 1.95, 0, 0.79, 0.53, 0, C.binBody);
    obox(P.metal, f, -0.30, 0.30, g + 2.05, -0.56, 0.22, 0.03, 0, C.edging);
  }
  /* TYPE B, the dark box on a post: 0.45 x 0.35 x 0.60 m with its top at
     0.90 m = 3.15 u, near-black.  Three of them. */
  function binBox(wx, wz) {
    var f = frameAt(wx, wz, 0), g = groundY(wx, wz);
    ltube(P.metal, f, 0, g - 0.4, 0, 0, g + 1.3, 0, 0.16, 5, C.railBlack);
    obox(P.wood, f, -0.79, 0.79, g + 2.10, 0, 1.05, 0.62, 0,
         scaleT(C.railBlack, 2.6));
    obox(P.metal, f, -0.86, 0.86, g + 3.22, 0, 0.10, 0.69, 0, C.railBlack);
  }

  /* ===================== JOB C's entry point ========================== */
  function buildParkFurniture() {
    var i;
    initFurnitureTones();

    /* SIX BENCHES, each on its own pad, each set back 7 u from the
       centreline of a path and turned to FACE it.  7 u is the smallest
       offset that keeps the 6.3-u pad clear of the 5.0-u path and its
       edging, and R5 wants nothing above 0.62 u within 2 u of a
       centreline anyway. */
    var BENCH = [
      [282, 229, Math.PI], [330, 229, 0], [376, 247, Math.PI],
      [404, 247, Math.PI], [456, 237, 0], [472, 243, 0]
    ];
    for (i = 0; i < BENCH.length; i++) {
      var bs = benchSpot(BENCH[i][0], BENCH[i][1], BENCH[i][2]);
      benchPad(bs[0], bs[1], BENCH[i][2] + Math.PI * 0.5, 60 + i * 7);
      bench(bs[0], bs[1], BENCH[i][2]);
      /* JOB B did the lawn perimeter, both sides of every path and the
         three park pines but could not fringe pads that did not exist
         yet, so every pad gets its own grass fringe here. */
      fringeAlong(bs[0] - 4.2, bs[1] - 3.4, bs[0] + 4.2, bs[1] - 3.4,
                  2.6, 5100 + i * 40);
      fringeAlong(bs[0] - 4.2, bs[1] + 3.4, bs[0] + 4.2, bs[1] + 3.4,
                  2.6, 5300 + i * 40);
    }

    /* THE TWO KAMELYAS, on the footprints JOB B kept clear */
    kamelya(348, 258, -0.16);
    kamelya(300, 240, 0.12);

    /* THE HERO: the picnic shelter and its railed terrace */
    picnicShelter(452, 244);

    /* FOUR FITNESS UNITS beside path A.  The fourth is moved from the
       brief's (434,237) to (432,234): at 434 its 4.2-u footprint runs into
       the terrace's west face at world X 435.5. */
    fitnessRig(410, 232, 0.10, 0);
    fitnessRig(418, 238, -0.22, 1);
    fitnessRig(426, 232, 0.30, 2);
    fitnessRig(432, 234, -0.10, 0);
    /* the yellow tarpaulin left on the grass beside them */
    var tf = frameAt(400, 229, 0.4), tg = groundY(400, 229) + 0.04;
    poly(P.masonry, [lpt(tf, -2.6, tg, -1.9), lpt(tf, 2.6, tg, -1.7),
                     lpt(tf, 2.4, tg, 1.9), lpt(tf, -2.8, tg, 1.6)],
         lpt(tf, 0, tg - 3, 0), scaleT(C.yellow, 0.82));

    /* THE THIRD TYPE-B BIN.  The brief puts it "on the apron", but R5
       forbids anything above 0.62 u in the apron (world Z 204..216)
       because that is the desire line off the kerb, so it stands just
       inside the grass beside the X 424 hedge gap, where it still reads
       as the apron bin from the street. */
    binBox(428, 221);
  }

  /* JOB C.  fence(296,204,...) and fence(296,372,...) are DELETED: both sat
     at world Z 296, inside the new service carriageway.  The west closure
     rail stays -- it is the only thing that explains the collision column at
     world X 266 -- and JOB C re-runs it from the lawn's north edge. */
  function buildFences() {
    fence(216, 474, 299, 474, 3.1);
  }

  /* JOB D.  The south frontage: D/E/F-BLOK on the building line at world
     Z 299.00, five and six storeys, horizontal pink spandrel bands, glazed
     cam balkon, painted plot wall, entrances, downpipes, weather streaking
     and hipped roofs crowded with chimneys and solar heaters.  The builders
     live with the rest of the architecture, below cornerBlock(). */
  function southFrontage() { southFrontageBuild(); }

  /* ---- park sign ------------------------------------------------------- */
  /* ---- the park name sign ---------------------------------------------
     The 16-point star and SIGN_TEX are right and are untouched.  Four
     corrections, all photograph-driven (de5ba0a8 at 275,395):
     (a) IT MOVES from authored (211.45, 221) -- world (519, ., 211.45), out
         on the paved apron -- to authored (219, 272) = WORLD (468, ., 219),
         standing in the grass just behind the hedge line, which is where
         the photograph puts it.  It rises clear out of the 3.3-u hedge run
         and its posts are hidden inside it, exactly as photographed.
     (b) TWO DARK POSTS, set 0.30 u BEHIND the panel plane so the two
         surfaces can never z-fight, and uncapped -- one end is buried and
         the other is behind the star.
     (c) TOP AT 2.0 m = 7.0 u.  The old star was 6.5 u across with its top
         at ground + 9.25; at a 7.0-u top that geometry would sit its
         bottom edge 0.5 u off the grass and swallow both posts, so the
         star is 5.2 u across (1.49 m, the photographed size) with its
         bottom at ground + 2.0 and 1.4 u of visible post beneath it.  The
         UV fan is written in units of ro and is unchanged by the rescale.
     (d) RE-TONED off C.white.  A flat C.white lands the panel at 1.60x the
         road and it glows like a lightbox against 0.38 grass.  SIGN_TEX
         already draws the teal border and the red lettering, so toning the
         whole fan to a flat C.signTeal would drown both; the tone is
         C.white carried a third of the way to C.signTeal, which lands the
         white field near the render ladder and the drawn teal border down
         at the ~0.55 the brief asks for. */
  function buildStarSign() {
    var x=219,z=272,g=lawnY(AXIS_ORIGIN-z,x);
    var ro=2.6,ri=1.87,y=g+7.0-ro,pts=[],i;
    var tone=mixColor(C.white,C.signTeal,0.34);
    for(i=0;i<16;i++){
      var q=-Math.PI/2+i*Math.PI/8,r=i%2?ri:ro;
      pts.push([x,y+Math.sin(q)*r,z+Math.cos(q)*r]);
    }
    /* Triangulate the star as a fan; every ray lands on the center. */
    for(i=0;i<16;i++){
      var a=pts[i],b=pts[(i+1)%16];
      var u0=.25+(a[2]-z)/(ro*4),v0=.5+(a[1]-y)/(ro*2);
      var u1=.25+(b[2]-z)/(ro*4),v1=.5+(b[1]-y)/(ro*2);
      var base=P.panel.n,normal=[-1,0,0];
      P.panel.v(x,y,z,normal[0],normal[1],normal[2],.25,.5,tone);
      P.panel.v(a[0],a[1],a[2],normal[0],normal[1],normal[2],u0,v0,tone);
      P.panel.v(b[0],b[1],b[2],normal[0],normal[1],normal[2],u1,v1,tone);
      P.panel.tri(base,base+2,base+1);
    }
    tube(P.metal,[x+.30,g-.3,z-1.35],[x+.30,y+.6,z-1.35],.13,6,C.railBlack,false);
    tube(P.metal,[x+.30,g-.3,z+1.35],[x+.30,y+.6,z+1.35],.13,6,C.railBlack,false);
  }

  /* ---- arena apartment shell ------------------------------------------ */
  /* THE FRAME OPTIMISATION.  A window frame used to be FOUR SOLID BOXES --
     48 triangles for a member 0.34 u wide with a 0.23 u return -- on 332
     windows across five builders, i.e. 15,936 triangles, forty per cent of
     this module's whole budget, spent on frames that are invisible past
     fifteen metres.  Each member is now TWO QUADS: the outward face, and the
     single inner reveal that keeps the frame reading at a grazing angle down
     a long facade.  The back face sits against masonry and the outer side
     face is coplanar with the wall; neither can ever be seen.  The head and
     sill stop at the jambs so no two coplanar quads overlap.  48 -> 16
     triangles, 332 x 32 = 10,624 saved.  panelX/panelZ/hquad each derive
     their reference point from `dir`, so the winding cannot invert. */
  function frameX(x,y0,y1,z0,z1,dir) {
    var d=dir*.23,xx0=Math.min(x,x+d),xx1=Math.max(x,x+d),w=.34;
    var xo=dir>0?xx1:xx0;
    panelX(P.metal,xo,y0,y1,z0-w,z0+w,dir,C.white);
    panelX(P.metal,xo,y0,y1,z1-w,z1+w,dir,C.white);
    panelX(P.metal,xo,y0-w,y0+w,z0+w,z1-w,dir,C.white);
    panelX(P.metal,xo,y1-w,y1+w,z0+w,z1-w,dir,C.white);
    panelZ(P.metal,z0+w,y0,y1,xx0,xx1, 1,C.white);
    panelZ(P.metal,z1-w,y0,y1,xx0,xx1,-1,C.white);
    hquad(P.metal,y0+w,xx0,xx1,z0+w,z1-w, 1,C.white);
    hquad(P.metal,y1-w,xx0,xx1,z0+w,z1-w,-1,C.white);
  }

  function balcony(x,z,y,dir) {
    var front=x+dir*3.8,z0=z-4.1,z1=z+4.1;
    box(P.masonry,Math.min(x,front),y-.35,z0,Math.max(x,front),y,z1,C.white);
    panelX(P.glass,front+dir*.04,y+.15,y+6.5,z0+.3,z1-.3,dir,C.glass);
    frameX(front+dir*.12,y+.15,y+6.5,z0+.3,z1-.3,dir);
    for(var j=1;j<4;j++){
      var zz=lerp(z0+.3,z1-.3,j/4);
      box(P.metal,Math.min(front,front+dir*.22),y+.15,zz-.10,Math.max(front,front+dir*.22),y+6.5,zz+.10,C.white);
    }
    box(P.metal,Math.min(front,front+dir*.22),y+2.1,z0+.2,Math.max(front,front+dir*.22),y+2.35,z1-.2,C.stainless);
  }

  function arenaCanopy(baseY) {
    /* A normal apartment-entry hood: 4.3 m wide, 1.65 m deep and only two
       pavement posts.  The previous 13-by-14-unit barrel structure looked
       like a bus shelter and swallowed the door, steps and ground-floor bay. */
    var inner=144.34,outer=150.15,z0=414.5,z1=429.5;
    var yi=baseY+8.35,yo=baseY+7.72,mid=(z0+z1)*.5,i;
    poly(P.glass,[[inner,yi,z0],[inner,yi,z1],[outer,yo,z1],[outer,yo,z0]],
      [(inner+outer)*.5,baseY+6.0,mid],mixColor(C.glass,C.steel,.08));
    tube(P.metal,[inner,yi,z0],[inner,yi,z1],.12,6,C.steel,false);
    tube(P.metal,[outer,yo,z0],[outer,yo,z1],.12,6,C.steel,false);
    tube(P.metal,[inner,yi,z0],[outer,yo,z0],.12,6,C.steel,false);
    tube(P.metal,[inner,yi,z1],[outer,yo,z1],.12,6,C.steel,false);
    for(i=1;i<3;i++){
      var zz=lerp(z0,z1,i/3);
      tube(P.metal,[inner,yi,zz],[outer,yo,zz],.085,5,C.stainless,false);
    }
    tube(P.metal,[outer,grade(z0)+.60,z0],[outer,yo,z0],.14,7,C.steel,true);
    tube(P.metal,[outer,grade(z1)+.60,z1],[outer,yo,z1],.14,7,C.steel,true);
  }

  function buildArena() {
    /* Two traversable grid risers lift the hall 0.60 m above the road.  Keep
       this datum identical to NUKEM.html's rParkArena so the authored stairs,
       visible door and collision threshold all meet instead of overlapping. */
    var floorY=grade(426)+2.10,storey=10.15,eaves=floorY+storey*6;
    ARENA.floorY=floorY; ARENA.eavesY=eaves; ARENA.entrance.y=floorY;
    /* A level slab on a climbing street exposes a tall, useful stone base. */
    box(P.stone,104,grade(360)-.2,360,144,floorY,472,C.stone);
    /* A hollow apartment shell rather than one solid facade box.  The front
       skin is split around old-z 420..424, which transforms exactly to the
       gameplay door cell x316..320 at world z=144.  No hidden rear face or
       static pane survives behind the opening when that door slides away. */
    box(P.masonry,104,floorY,360,105.2,eaves,472,C.cream);       /* rear wall */
    box(P.masonry,105.2,floorY,360,144,eaves,361.2,C.cream);    /* east gable */
    box(P.masonry,105.2,floorY,470.8,144,eaves,472,C.cream);    /* west gable */
    box(P.masonry,143.55,floorY,361.2,144.10,eaves,420,C.cream);
    box(P.masonry,143.55,floorY,424,144.10,eaves,470.8,C.cream);
    box(P.masonry,143.55,floorY+9.0,420,144.10,eaves,424,C.cream);
    var bands=[[365,379],[400,414],[444,458]],i,f;
    for(i=0;i<bands.length;i++)box(P.masonry,143.95,floorY,bands[i][0],144.22,eaves,bands[i][1],C.peach);

    /* A continuous stone plinth and a peach entrance bay give the ordinary
       apartment shell the same grounded, two-tone hierarchy as the reference
       blocks.  The portal pieces stop cleanly at the live gameplay opening. */
    box(P.stone,143.72,floorY,361.2,144.30,floorY+2.35,420,C.stone);
    box(P.stone,143.72,floorY,424,144.30,floorY+2.35,470.8,C.stone);
    box(P.masonry,143.38,floorY,412.2,144.32,floorY+16.2,419.55,C.peach);
    box(P.masonry,143.38,floorY,424.45,144.32,floorY+16.2,431.8,C.peach);
    box(P.masonry,143.38,floorY+12.25,419.55,144.32,floorY+16.2,424.45,C.peach);
    panelX(P.glass,144.36,floorY+8.82,floorY+12.0,419.8,424.2,1,
      mixColor(C.glass,C.steel,.26));
    frameX(144.40,floorY+8.82,floorY+12.0,419.8,424.2,1);

    /* Nine-bay rhythm: ordinary windows alternating with enclosed balconies. */
    for(i=0;i<9;i++){
      var zc=368+i*12.1,isBal=i===1||i===4||i===7;
      for(f=0;f<6;f++){
        var y0=floorY+f*storey+2.45,y1=y0+4.9;
        if(isBal&&f>0){balcony(144.05,zc,floorY+f*storey+.42,1);STATS.windows++;}
        else{
          panelX(P.glass,144.24,y0,y1,zc-2.7,zc+2.7,1,C.glass);
          frameX(144.30,y0,y1,zc-2.7,zc+2.7,1);STATS.windows++;
          box(P.stone,144.04,y0-.25,zc-3.0,144.42,y0,zc+3.0,mixColor(C.stone,C.white,.45));
        }
      }
    }
    /* The near and far gables are visible for most of the climb.  Leaving
       either as a blank cream rectangle recreates the very closure-wall look
       the references reject, so carry the residential window rhythm around
       both corners. */
    for(var side=0;side<2;side++){
      var gz=side?472.18:359.82,dirZ=side?1:-1;
      box(P.masonry,120.0,floorY,Math.min(gz,gz+dirZ*.24),128.0,eaves,
        Math.max(gz,gz+dirZ*.24),C.peach);
      for(var gx=0;gx<3;gx++)for(f=0;f<6;f++){
        var xc=111.5+gx*12.2,gy0=floorY+f*storey+2.45,gy1=gy0+4.9;
        panelZ(P.glass,gz+dirZ*.05,gy0,gy1,xc-2.45,xc+2.45,dirZ,C.glass);
        box(P.metal,xc-2.75,gy0-.28,Math.min(gz,gz+dirZ*.30),xc+2.75,gy0+.02,
          Math.max(gz,gz+dirZ*.30),C.white);
        box(P.metal,xc-2.75,gy1-.02,Math.min(gz,gz+dirZ*.30),xc+2.75,gy1+.28,
          Math.max(gz,gz+dirZ*.30),C.white);
        box(P.metal,xc-2.75,gy0,Math.min(gz,gz+dirZ*.30),xc-2.45,gy1,
          Math.max(gz,gz+dirZ*.30),C.white);
        box(P.metal,xc+2.45,gy0,Math.min(gz,gz+dirZ*.30),xc+2.75,gy1,
          Math.max(gz,gz+dirZ*.30),C.white);
        STATS.windows++;
      }
    }
    hipRoof(P.roof,104,144,360,472,eaves,7.0,C.roof);
    for(i=0;i<4;i++)box(P.masonry,112+i*8,eaves+4.2,374+i*25,116+i*8,eaves+9.3,379+i*25,mixColor(C.cream,C.stone,.25));

    /* Clearly readable but still residential entrance.  Only a perimeter
       frame is static; the visible leaf is the real gameplay door. */
    frameX(144.46,floorY+.12,floorY+8.75,420,424,1);
    /* Reversed U because an east-side viewer faces -X, whose screen-right is
       world -Z.  The facade name therefore reads left-to-right in game. */
    panelX(P.panel,144.50,floorY+12.75,floorY+16.05,414.5,429.5,1,C.white,[.98,.20,.53,.80]);

    /* Four conventional risers, a proper landing and paired handrails. */
    var steps=4,run=6.4,rise=(floorY-(grade(422)+.60))/steps;
    for(i=0;i<steps;i++){
      var xa=145.2+i*run/steps,xb=145.2+(i+1)*run/steps,top=floorY-i*rise;
      box(P.stone,xa,grade(422)+.55,419.35,xb,top,424.65,mixColor(C.stone,C.white,.30));
    }
    box(P.stone,143.85,floorY-.45,419.20,145.45,floorY,424.80,mixColor(C.stone,C.white,.32));

    /* Long, usable-looking ramp comes up from the higher southern sidewalk. */
    var rz0=430,rz1=462,rx0=145.2,rx1=150.0,lo=grade(rz1)+.62,hi=floorY;
    poly(P.paver,[[rx0,hi,rz0],[rx1,hi,rz0],[rx1,lo,rz1],[rx0,lo,rz1]],
      [(rx0+rx1)*.5,grade(446)-1,446],C.paverTan);
    var sides=[rx0,rx1];
    for(var s=0;s<2;s++){
      tube(P.metal,[sides[s],hi+3.0,rz0],[sides[s],lo+3.0,rz1],.12,6,C.stainless,false);
      for(i=0;i<=5;i++){
        var q=i/5,zz=lerp(rz0,rz1,q),yy=lerp(hi,lo,q);
        tube(P.metal,[sides[s],yy,zz],[sides[s],yy+3.0,zz],.10,5,C.stainless,false);
      }
    }
    /* Matching stair rails. */
    tube(P.metal,[145.0,floorY+3.0,419.25],[151.6,grade(422)+3.65,419.25],.12,6,C.stainless,false);
    tube(P.metal,[145.0,floorY+3.0,424.75],[151.6,grade(422)+3.65,424.75],.12,6,C.stainless,false);
    for(i=0;i<=3;i++){
      var rq=i/3,rx=lerp(145.0,151.6,rq),ry=lerp(floorY,grade(422)+.65,rq);
      tube(P.metal,[rx,ry,419.25],[rx,ry+3.0,419.25],.09,5,C.stainless,false);
      tube(P.metal,[rx,ry,424.75],[rx,ry+3.0,424.75],.09,5,C.stainless,false);
    }
    arenaCanopy(floorY);
    STATS.buildings++;
  }

  function buildParkEndVistaFacade() {
    /* The four non-playable sightline columns beyond the west rail still own
       a full-height north containment face.  Dress that face as the shallow
       end building visible behind the porous closure, instead of exposing a
       blank grey map slab beside the arena. */
    var z0=472.15,z1=494.0,floorY=grade(483)+.62,sh=9.8,eaves=floorY+sh*5;
    var sage=mixColor(C.cream,C.hedge,.23),accent=mixColor(C.peach,C.stone,.20);
    /* This is deliberately a shallow scenic skin.  Giving it a full building
       depth created a new blank end-gable and a dark roof slab in the park
       camera -- precisely the containment-wall silhouette it was masking. */
    box(P.masonry,143.18,floorY,z0,144.16,eaves,z1,sage);
    box(P.stone,143.55,floorY,z0,144.28,floorY+2.8,z1,C.stone);
    box(P.masonry,143.68,floorY,z0+7.0,144.30,eaves,z0+11.2,accent);
    for(var bay=0;bay<3;bay++)for(var f=0;f<5;f++){
      var zc=lerp(z0+3.8,z1-3.8,bay/2),y0=floorY+f*sh+2.25,y1=y0+4.45;
      panelX(P.glass,144.31,y0,y1,zc-2.15,zc+2.15,1,
        mixColor(C.glass,C.steel,.14));
      frameX(144.34,y0,y1,zc-2.15,zc+2.15,1);
      STATS.windows++;
    }
    box(P.roof,142.72,eaves,z0-.8,144.62,eaves+1.35,z1+.8,
      mixColor(C.roof,C.stone,.08));
    STATS.buildings++;
  }

  function buildParkEndSideFacade() {
    /* The west sightline strip also exposes its long east-facing boundary in
       the upper-park camera.  A thin five-storey urban side elevation turns
       that residual concrete plane and ceiling lip into believable distant
       streetscape, while remaining entirely behind the x=266 police rail. */
    /* JOB D EXTENDS THE SPAN ONLY.  It covered authored x 144..212 = world
       Z 144..212, so the park rows Z 212..300 at the west end had no scenery
       at all and rParkViewCols suppresses the west face at world X 248:
       looking west along the new service street you saw void.  The span now
       reaches authored x 320 with the same shallow skin, the same zWall and
       the same window rhythm, and the four boxed lintels per window become
       one frameZWorld call -- the same two-quad member as everywhere else,
       which is what pays for the extra bays. */
    var zWall=491.58,x0=144.0,x1=320.0;
    var floorY=grade(492)+.62,sh=10.2,eaves=floorY+56.4;
    var body=mixColor(C.cream,C.hedge,.16),accent=mixColor(C.peach,C.stone,.24);
    /* MISSION 4 BORES THE CHECKPOINT LANE THROUGH THIS SKIN.
       The wall is authored on the x = 491.58 plane, which after the module's
       own transform (world X = 740 - authored Z) is world x 247.80..248.42 --
       and the lane NUKEM.html carves behind the crest gate runs west along
       world z 160..164 to a switch bay on the x = 248 plane.  Left continuous,
       this five-storey skin stands 0.42 in front of that bay and the player
       walks up the lane into a lit apartment elevation with the switch behind
       it.  Split around authored x 157..167 (world z 157..167) it becomes
       what it should be: a building the lane is cut through. */
    var GAP0 = 157.0, GAP1 = 167.0, cut = (NZ.level === 4);
    if (cut) {
      box(P.masonry,x0,floorY,zWall,GAP0,eaves,zWall+.62,body);
      box(P.masonry,GAP1,floorY,zWall,x1,eaves,zWall+.62,body);
      box(P.stone,x0,floorY,zWall-.16,GAP0,floorY+3.0,zWall+.72,C.stone);
      box(P.stone,GAP1,floorY,zWall-.16,x1,floorY+3.0,zWall+.72,C.stone);
      /* the two reveals, so the cut reads as a passage and not as a missing
         panel: 0.02 proud of the cut faces, in the body tone */
      panelX(P.masonry,GAP0-0.02,floorY,eaves,zWall,zWall+.62,-1,body);
      panelX(P.masonry,GAP1+0.02,floorY,eaves,zWall,zWall+.62, 1,body);
    } else {
      box(P.masonry,x0,floorY,zWall,x1,eaves,zWall+.62,body);
      box(P.stone,x0,floorY,zWall-.16,x1,floorY+3.0,zWall+.72,C.stone);
    }
    box(P.masonry,171.5,floorY,zWall-.18,181.5,eaves,zWall+.78,accent);
    box(P.masonry,262.0,floorY,zWall-.18,272.0,eaves,zWall+.78,accent);
    for(var bay=0;bay<15;bay++)for(var f=0;f<5;f++){
      var xc=lerp(x0+6.0,x1-6.0,bay/14),y0=floorY+f*sh+2.35,y1=y0+4.35;
      /* no window hanging in the middle of the cut */
      if (cut && xc > GAP0 - 3.0 && xc < GAP1 + 3.0) continue;
      panelZ(P.glass,zWall-.22,y0,y1,xc-2.55,xc+2.55,-1,
        mixColor(C.glass,C.steel,.12));
      frameZWorld(zWall-.26,y0,y1,xc-2.55,xc+2.55,-1);
      STATS.windows++;
    }
    box(P.roof,x0-1.0,eaves,zWall-1.0,x1+1.0,eaves+3.4,zWall+1.15,C.roof);
    STATS.buildings++;
  }

  /* ---- linear north frontage between arena and roundabout ------------- */
  /* The same two-quad member as frameX, on the perpendicular plane. */
  function frameZWorld(z,y0,y1,x0,x1,dir) {
    var d=dir*.24,za=Math.min(z,z+d),zb=Math.max(z,z+d),w=.30;
    var zo=dir>0?zb:za;
    panelZ(P.metal,zo,y0,y1,x0-w,x0+w,dir,C.white);
    panelZ(P.metal,zo,y0,y1,x1-w,x1+w,dir,C.white);
    panelZ(P.metal,zo,y0-w,y0+w,x0+w,x1-w,dir,C.white);
    panelZ(P.metal,zo,y1-w,y1+w,x0+w,x1-w,dir,C.white);
    panelX(P.metal,x0+w,y0,y1,za,zb, 1,C.white);
    panelX(P.metal,x1-w,y0,y1,za,zb,-1,C.white);
    hquad(P.metal,y0+w,x0+w,x1-w,za,zb, 1,C.white);
    hquad(P.metal,y1-w,x0+w,x1-w,za,zb,-1,C.white);
  }

  function northRoof(x0,x1,y,tone) {
    var xa=x0-1.2,xb=x1+1.2,zn=102.5,zs=146.0,zc=124.0,rise=5.5;
    var rw0=[xa+7.0,y+rise,zc],rw1=[xb-7.0,y+rise,zc],ref=[(xa+xb)*.5,y-2,zc];
    poly(P.roof,[[xa,y,zs],[xb,y,zs],rw1,rw0],ref,tone);
    poly(P.roof,[[xb,y,zn],[xa,y,zn],rw0,rw1],ref,tone);
    poly(P.roof,[[xa,y,zn],[xa,y,zs],rw0],ref,tone);
    poly(P.roof,[[xb,y,zs],[xb,y,zn],rw1],ref,tone);
  }

  function northBalcony(x,y,closed) {
    var x0=x-4.15,x1=x+4.15,z0=144.18,z1=148.35;
    box(P.masonry,x0,y-.34,z0,x1,y,z1,C.white);
    /* The dark back panel keeps an open balcony from reading as another flat
       window pasted onto the cream wall. */
    panelZ(P.glass,144.47,y+.25,y+6.35,x0+.35,x1-.35,1,
      mixColor(C.glass,C.steel,.22));
    if(closed){
      panelZ(P.glass,z1+.05,y+.18,y+6.45,x0+.25,x1-.25,1,
        mixColor(C.glass,C.white,.10));
      frameZWorld(z1+.10,y+.18,y+6.45,x0+.25,x1-.25,1);
      for(var j=1;j<4;j++){
        var xx=lerp(x0+.25,x1-.25,j/4);
        box(P.metal,xx-.10,y+.18,z1,xx+.10,y+6.45,z1+.24,C.white);
      }
    }else{
      box(P.metal,x0+.18,y+1.95,z1-.05,x1-.18,y+2.25,z1+.22,C.stainless);
      for(var i=0;i<=5;i++){
        var bx=lerp(x0+.25,x1-.25,i/5);
        tube(P.metal,[bx,y+.15,z1],[bx,y+2.25,z1],.085,5,C.stainless,false);
      }
      tube(P.metal,[x0+.2,y+.15,z0+.25],[x0+.2,y+2.25,z1],.09,5,C.stainless,false);
      tube(P.metal,[x1-.2,y+.15,z0+.25],[x1-.2,y+2.25,z1],.09,5,C.stainless,false);
    }
  }

  function northEntrance(x,floorY,accent) {
    var x0=x-2.15,x1=x+2.15;
    panelZ(P.glass,144.50,floorY+.28,floorY+7.4,x0,x1,1,
      mixColor(C.glass,C.steel,.18));
    frameZWorld(144.55,floorY+.28,floorY+7.4,x0,x1,1);
    box(P.metal,x-.10,floorY+.35,144.48,x+.10,floorY+7.25,144.78,C.stainless);
    /* Three broad, shallow entrance steps and a modest translucent hood. */
    for(var i=0;i<3;i++){
      var z0=144.2+i*1.25,z1=z0+1.45,top=floorY-.05-i*.34;
      box(P.stone,x0-.75,floorY-1.10,z0,x1+.75,top,z1,
        mixColor(C.stone,C.white,.40));
    }
    box(P.metal,x0-.75,floorY+7.75,144.0,x1+.75,floorY+8.05,149.3,accent);
    tube(P.metal,[x0-.55,floorY,148.5],[x0-.55,floorY+7.8,148.5],.12,6,C.steel,true);
    tube(P.metal,[x1+.55,floorY,148.5],[x1+.55,floorY+7.8,148.5],.12,6,C.steel,true);
  }

  function northApartment(x0,x1,body,accent,storeys,seed,opts) {
    /* Each block has one level facade plane at z=144.35.  A deep stone base
       absorbs the 7% street grade; upper floors and the roof remain straight,
       as in the real apartment row, instead of protruding bay by bay. */
    opts=opts||{};
    var floorY=opts.floorY===undefined ? worldGrade(x1)+.55 : opts.floorY;
    var sh=10.15,eaves=floorY+storeys*sh;
    if (!opts.pharmacy) {
      box(P.stone,x0,worldGrade(x1)-.45,103.8,x1,floorY+3.45,144.38,C.stone);
      box(P.masonry,x0,floorY,103.8,x1,eaves,144.38,body);
    } else {
      /* Keep the upper residential shell, but leave the ground-floor corner
         as a real room for GUVEN ECZANESI.  The side module supplies its
         glazed elevation; these end walls and the slab make the interior
         read as part of the same apartment block. */
      box(P.stone,x0,Math.min(worldGrade(x1)-.45,floorY-.02),103.8,x1,floorY,144.38,C.stone);
      box(P.masonry,x0,floorY+10.72,103.8,x1,eaves,144.38,body);
    }
    var bays=Math.max(5,Math.round((x1-x0)/10.8)),bw=(x1-x0)/bays;
    var doorBay=Math.floor(bays*.5),i,f;
    for(i=0;i<bays;i++){
      var bx0=x0+i*bw,bx1=x0+(i+1)*bw,xc=(bx0+bx1)*.5;
      if(i===1||i===bays-2)
        box(P.masonry,bx0+.15,floorY,144.30,bx0+.72,eaves,144.62,accent);
      for(f=0;f<storeys;f++){
        var y0=floorY+f*sh+2.35,y1=y0+4.85;
        if(opts.pharmacy && f===0){ continue; }
        if(f===0&&i===doorBay){ northEntrance(xc,floorY,accent); continue; }
        if(f>0&&(i+seed)%3===1){
          northBalcony(xc,floorY+f*sh+.40,((i+f+seed)&1)===0);
        }else{
          panelZ(P.glass,144.48,y0,y1,xc-2.45,xc+2.45,1,C.glass);
          frameZWorld(144.53,y0,y1,xc-2.45,xc+2.45,1);
          box(P.stone,xc-2.75,y0-.25,144.29,xc+2.75,y0,144.65,
            mixColor(C.stone,C.white,.48));
        }
        STATS.windows++;
      }
    }
    northRoof(x0,x1,eaves,mixColor(C.roof,accent,.10));
    for(i=0;i<2;i++){
      var cx=lerp(x0+10,x1-10,i);
      box(P.masonry,cx-1.6,eaves+3.2,116+i*11,cx+1.6,eaves+8.0,120+i*11,
        mixColor(body,C.stone,.25));
    }
    STATS.buildings++;
  }

  function buildNorthFrontage() {
    var wasAuthored=TRANSFORM_AUTHORED;
    TRANSFORM_AUTHORED=false;
    try{
      /* No gaps: these three ordinary slabs cover the entire grid wall from
         the arena gable at x380 to the roundabout apron at x548. */
      northApartment(380,416,C.cream,C.peach,5,2);
      northApartment(416,452,mixColor(C.cream,C.white,.28),mixColor(C.peach,C.stone,.28),6,5);
      northApartment(452,484,mixColor(C.peach,C.white,.18),C.cream,5,8,
        { pharmacy: true, floorY: 1.35 });
    }finally{
      TRANSFORM_AUTHORED=wasAuthored;
    }
  }

  /* =====================================================================
     JOB D -- ARCHITECTURE.  resBlock() and buildBackdrop() are DELETED.

     What was here: a bare six-storey slab whose skin sat at world Z 295.45
     while the player reaches Z 298.85, so the player walked 3.4 u INSIDE the
     building and saw out through front-only masonry; six identical storeys
     of 10.15 u = 60.9 u (17.4 m) against a measured ~15 m; a vertical pink
     pilaster on every third bay where the photographs show the exact
     opposite; and NO GROUND FLOOR AT ALL -- no plinth, no entrance, no
     downpipe, no boundary wall, nothing between the render and the grass.
     That is the user's complaint, and everything below answers it.

     THE TRANSFORM (restated).  worldX = 740 - authoredZ, worldZ = authoredX.
     A constant-WORLD-Z plane is authored with panelX at authored x = worldZ
     and dir = -1 gives a world normal (0,0,-1) FACING NORTH INTO THE PARK.
     grade(z) takes an AUTHORED z, and authored z IS 740 - worldX, so
     grade(authoredZ) === worldGrade(worldX) with no conversion.

     THE COLLISION RULE THAT SHAPES ALL OF IT (contract 3.5, PRAD = 1.15).
     Map solid starts at world Z 300, so the player centre reaches Z 298.85
     and the skin plane is world Z 299.00 -- authored x 299.00.  BELOW
     SAFE_Y(x) = grade(x) + 8.60 the skin is STRICTLY PLANAR: recesses at
     most 0.35 u, and the proud decal depths used here (0.01 .. 0.10) all
     keep at least 0.06 u of daylight between the geometry and the player's
     capsule.  Above SAFE_Y, balcony slabs, entrance hoods, the signboard
     band and the eaves project freely. */

  /* Promoted from buildCityTerminus's closure, unchanged in behaviour: the
     optional half-extents default to the values that builder passed
     implicitly, so the city roofline is byte-identical, while the apartment
     roofs can ask for the photographed 3.5 x 2.1 u stack.  Neither function
     calls grade(), so both are safe in authored mode. */
  function chimney(x,z,y,h,t,hx,hz) {
    hx=hx||.48; hz=hz||.48;
    box(P.masonry,x-hx,y,z-hz,x+hx,y+h,z+hz,t);
    box(P.metal,x-hx-.12,y+h,z-hz-.12,x+hx+.12,y+h+.25,z+hz+.12,C.steel);
  }
  function solarHeater(x,z,y,big) {
    if(!big){
      /* A dark, shallow collector and pale horizontal storage cylinder. */
      box(P.glass,x-.18,y,z-3.1,x+.22,y+2.05,z+3.1,mixColor(C.glass,C.city,.18));
      tube(P.metal,[x-.05,y+2.55,z-2.45],[x-.05,y+2.55,z+2.45],.48,8,C.stainless,true);
      return;
    }
    /* The apartment version the photographs show: a TILTED 7 x 3.5 u
       collector on a low frame with a horizontal r 0.875 u x 6.3 u storage
       cylinder above its head.  Four of these break the sky on every roof
       in de5ba0a8 and af406276 and they cost forty triangles. */
    var hl=3.15, w=3.5;
    poly(P.glass,[[x-w*.5,y+.30,z-hl],[x+w*.5,y+2.05,z-hl],
                  [x+w*.5,y+2.05,z+hl],[x-w*.5,y+.30,z+hl]],
         [x,y-2,z],mixColor(C.glass,C.city,.18));
    box(P.metal,x+w*.5-.26,y,z-hl,x+w*.5,y+2.10,z+hl,C.stainless);
    tube(P.metal,[x+w*.16,y+2.95,z-hl],[x+w*.16,y+2.95,z+hl],.875,8,C.stainless,true);
  }

  /* One 0.42-u downpipe, full height, discharging into a shoe.  It is a
     SOLID mass, so it cannot stand proud in walkable ground: the pipe is
     seated 0.16 u INTO the wall (a legal <= 0.35 u reveal) and shows as the
     half round it would read as anyway.  Front of pipe = world Z 298.95. */
  function downpipe(zc, y0, y1) {
    var t = mixColor(C.white, C.stone, .70);
    tube(P.metal, [299.16, y0 + .30, zc], [299.16, y1, zc], .21, 5, t, false);
    box(P.metal, 298.91, y0, zc - .30, 299.41, y0 + 1.10, zc + .30, t);
  }

  /* One 0.3-u-wide, 4-u-tall darkened quad under each sill, 0.02 u proud.
     332 quads, and it is what makes render look thirty years old. */
  function weatherStreak(zc, ySill, body) {
    panelX(P.masonry, 298.945, ySill - 4.0, ySill - .06, zc - .16, zc + .16, -1,
           mixColor(body, C.asphaltDark, .62));
  }

  /* THE PAINTED PLOT WALL, FLUSH.  R1 forbids a free-standing wall standing
     in walkable ground, so the white / dark-red safety paint the photographs
     put on this block's plot wall (a5fc70d1, 23fc8c82, 7de6c74a, 6b8a566e)
     is painted onto the facade plinth itself -- which is exactly what a
     rendered blockwork boundary looks like where the plot has no setback.
     DOCUMENTED FIDELITY LOSS: the real wall stands about a metre forward
     with a planted strip behind it, and the 0.62 u relief cap forbids that.
     Do not "fix" this back into a collision bug.
     3.15-u period, 0.16-u pale coping, and one panel in five carries a
     smaller repaint in the other colour. */
  function plinthBand(z0, z1, skips) {
    var period = 3.15, n = Math.floor((z1 - z0) / period), i, k;
    var cope = mixColor(C.white, C.stone, .38);
    for (i = 0; i < n; i++) {
      var za = z0 + i * period, zb = za + period, zm = (za + zb) * .5, skip = false;
      for (k = 0; k < skips.length; k++)
        if (zm > skips[k][0] && zm < skips[k][1]) { skip = true; break; }
      if (skip) continue;
      /* wider than tall, and chalky rather than a clean white: at 3.42 u
         tall with a pure C.white the panels read as a repeating decal. */
      var gy = grade(zm) + .56;
      var t = (i & 1) ? mixColor(C.white, C.stone, .20) : C.wallRed;
      panelX(P.masonry, 298.960, gy + .10, gy + 2.52, za + .06, zb - .06, -1, t);
      panelX(P.masonry, 298.960, gy + 2.52, gy + 2.66, za, zb, -1, cope);
      panelX(P.masonry, 298.965, gy + 2.66, gy + 3.68, za, zb, -1,
             mixColor(C.white, C.stone, .34));
      if (rnd(i, 61) < .20) {
        var pw = period * .42;
        panelX(P.masonry, 298.930, gy + .28, gy + 1.30,
               zm - pw * .5, zm + pw * .5, -1,
               (i & 1) ? C.wallRed : mixColor(C.white, C.stone, .20));
      }
    }
  }

  /* CAM BALKON -- the enclosed balcony.  The majority of balconies on this
     street are glazed in with white aluminium/PVC: a continuous glazed panel
     across the bay on a dusty-rose parapet, white mullions and a visible
     horizontal transom at mid height.  balcony() is left alone for the arena;
     this replaces it on the south frontage.  Every call site is above
     SAFE_Y, so the 3.8 u projection is legal. */
  function camBalkon(x, z, y, dir, glazed, accent) {
    var front = x + dir * 3.8, z0 = z - 4.3, z1 = z + 4.3;
    var xa = Math.min(x, front), xb = Math.max(x, front);
    var pa = front, pb = front - dir * .34;
    box(P.masonry, xa, y - .38, z0, xb, y, z1, mixColor(C.white, C.stone, .16));
    box(P.masonry, Math.min(pa, pb), y, z0, Math.max(pa, pb), y + 3.4, z1, accent);
    if (glazed) {
      var gy0 = y + 3.4, gy1 = y + 9.45, gl = mixColor(C.glass, C.white, .34);
      panelX(P.glass, front + dir * .05, gy0, gy1, z0, z1, dir, gl);
      panelZ(P.glass, z0, gy0, gy1, xa, xb, -1, gl);
      panelZ(P.glass, z1, gy0, gy1, xa, xb, 1, gl);
      var mx = front + dir * .10, j;
      for (j = 1; j < 4; j++) {
        var zz = lerp(z0, z1, j / 4);
        panelX(P.masonry, mx, gy0, gy1, zz - .15, zz + .15, dir, C.white);
      }
      panelX(P.masonry, mx, gy0, gy1, z0, z0 + .30, dir, C.white);
      panelX(P.masonry, mx, gy0, gy1, z1 - .30, z1, dir, C.white);
      panelX(P.masonry, mx, y + 6.05, y + 6.35, z0, z1, dir, C.white);
    } else {
      box(P.metal, Math.min(pa, pb) - (dir < 0 ? .05 : 0), y + 3.4, z0,
          Math.max(pa, pb) + (dir > 0 ? .05 : 0), y + 3.68, z1, C.stainless);
    }
  }

  /* ---- the south frontage ---------------------------------------------
     DATUM.  The spec's fy = grade(midpoint) + 0.55 buries the western third
     of a 94-u block: worldGrade falls 6.6 u across it while the block sits
     level, so the entrances, the plinth and the ground-floor sills of the
     three western bays end up UNDER the footway.  The datum is therefore
     taken at the HIGH (western) end, the storey heights are exactly as
     specified -- fy + 11.2 + (storeys-1) * 10.15 -- and the P.stone base
     strip, level on top and following the ground underneath, absorbs the
     fall.  That is what the base strip is for; northApartment (1330 ff.)
     does the same thing with a level base and it reads as the plinth. */
  function southBlock(z0, z1, body, accent, storeys, seed) {
    var XE = 299.00;                     /* the elevation plane, world Z 299 */
    var XB = 299.34;                     /* recess back: the maximum 0.35 u  */
    var xb = 336.0;                      /* back, inside solid rock          */
    var gLo = grade(Math.min(z0, z1)), gHi = grade(Math.max(z0, z1));
    var fy = gHi + .55;
    var ey = fy + 11.2 + (storeys - 1) * 10.15;
    var i, f, k;
    function floorBase(n) { return fy + (n ? 11.2 + (n - 1) * 10.15 : 0); }

    /* THE MASS.  Its front face is the BACK of every recess, 0.34 u behind
       the building line -- the elevation itself is a strip field emitted
       around each opening at exactly world Z 299.00.  One masonry slab at
       the building line would simply cover every recessed window, which is
       the trap: the windows would still be there and you would only ever
       see their frames. */
    box(P.masonry, XB, gLo - 5.0, z0, xb, ey, z1, mixColor(body, C.asphaltDark, .16));

    var bays = 8, bw = (z1 - z0) / bays;
    var accBay = 2 + (seed % 3);
    var ent = [1, 4, 7], skips = [];
    for (k = 0; k < ent.length; k++) {
      var ez = z0 + (ent[k] + .5) * bw;
      skips.push([ez - 4.8, ez + 4.8]);
    }

    /* HORIZONTAL PINK.  de5ba0a8 and af406276 show a warm off-white render
       field with dusty rose-pink SPANDREL BANDS under every window head and
       at every balcony parapet -- the defining look of the quarter -- not
       the vertical pilaster resBlock put on every third bay.  The band is
       part of the elevation field, so it costs no extra quad and cannot
       z-fight the wall.  ONE vertical accent bay per block survives.  The
       band is pulled a quarter back toward the body: at full strength a
       continuous terracotta stripe on every floor line shouts far louder
       than the photograph's, which is a render colour change.  Measured in
       render the softening costs 12 % of the band's target ratio, so it is
       held to 0.14 rather than the 0.25 the first pass used. */
    /* Measured in render, mix(accent, body, .14) came back at R-B 0.024 --
       i.e. neutral grey, not the dusty rose the photographs show, because
       C.pinkBand's own R-B is only 0.043 and the tone map desaturates it
       further.  SHARED.md is explicit that where a photograph contradicts a
       HUE RELATIONSHIP the photograph wins, so the band is pushed a tenth
       of the way toward C.red: R-B 0.086, g/r 0.87, and 0.77 of the white
       field against a 0.75 target. */
    var bandT = mixColor(mixColor(accent, body, .14), C.red, .10);
    var accT = mixColor(accent, C.stone, .30);
    /* C.stone straight is a warm brown and the 'stone' map's 1.2 u courses
       turn a six-unit base strip into a brick wall.  The photographed
       plinth is a grey-buff render, so it is pulled toward the neutral
       kerb tone. */
    var PLINTH = mixColor(C.stone, C.curb, .50);

    for (i = 0; i < bays; i++) {
      var cz0 = z0 + i * bw, cz1 = z0 + (i + 1) * bw, zc = (cz0 + cz1) * .5;
      var bodyT = i === accBay ? accT : body;
      var isEnt = i === 1 || i === 4 || i === 7;
      for (f = 0; f < storeys; f++) {
        var fb = floorBase(f);
        var cy0 = f === 0 ? gLo - 5.0 : fb;
        var cy1 = f === storeys - 1 ? ey : floorBase(f + 1);
        var oy0 = fb + 2.6, oy1 = oy0 + 4.9;
        var topT = f === storeys - 1 ? bandT : bodyT;
        if (isEnt && f === 0) {
          /* ENTRANCE at footway level.  R1 forbids the step flight the
             photographs show, so the threshold sits on the pavement. */
          var gy = grade(zc) + .56;
          panelX(P.masonry, XE, cy0, gy, cz0, cz1, -1, bodyT);
          panelX(P.masonry, XE, gy + 8.0, cy1 - 2.6, cz0, cz1, -1, bodyT);
          panelX(P.masonry, XE, cy1 - 2.6, cy1, cz0, cz1, -1, bandT);
          panelX(P.masonry, XE, gy, gy + 8.0, cz0, zc - 2.6, -1, bodyT);
          panelX(P.masonry, XE, gy, gy + 8.0, zc + 2.6, cz1, -1, bodyT);
          southEntrance(zc, fy, body, accent);
          continue;
        }
        if (isEnt) {
          /* balcony bay: solid behind the glazing, then the cam balkon */
          panelX(P.masonry, XE, cy0, oy0 - 2.6, cz0, cz1, -1, bodyT);
          panelX(P.masonry, XE, oy0 - 2.6, oy0, cz0, cz1, -1, bandT);
          panelX(P.masonry, XE, oy0, cy1, cz0, cz1, -1, bodyT);
          camBalkon(XE, zc, fb + .45, -1, ((i + f + seed) & 1) === 0, bandT);
          STATS.windows++;
          continue;
        }
        /* punched window, 4.2 x 4.9 u = 1.2 x 1.4 m, strict alignment */
        panelX(P.masonry, XE, cy0, oy0 - 2.6, cz0, cz1, -1, bodyT);
        panelX(P.masonry, XE, oy0 - 2.6, oy0, cz0, cz1, -1, bandT);
        panelX(P.masonry, XE, oy1, cy1, cz0, cz1, -1, topT);
        panelX(P.masonry, XE, oy0, oy1, cz0, zc - 2.1, -1, bodyT);
        panelX(P.masonry, XE, oy0, oy1, zc + 2.1, cz1, -1, bodyT);
        panelX(P.glass, 299.31, oy0, oy1, zc - 2.1, zc + 2.1, -1, C.glass);
        frameX(299.27, oy0, oy1, zc - 2.1, zc + 2.1, -1);
        panelX(P.stone, 298.955, oy0 - .30, oy0, zc - 2.45, zc + 2.45, -1,
               mixColor(C.stone, C.white, .50));
        hquad(P.stone, oy0 - .30, 298.955, XE, zc - 2.45, zc + 2.45, -1,
              mixColor(C.stone, C.white, .30));
        /* WEATHER STREAKING under the sill.  Skipped on the ground floor,
           where the painted plot wall already owns the surface. */
        if (f > 0) weatherStreak(zc, oy0 - .34, bodyT);
        STATS.windows++;
      }
      if (i % 2 === 0) downpipe(cz0 + .9, grade(cz0 + .9) + .56, ey - .4);
    }

    /* THE BASE STRIP: TOP LEVEL at fy + 2.2, BOTTOM FOLLOWING the ground,
       subdivided every 8 u.  Without it the plinth line is a straight cut
       across ground that falls 6.6 u along the block (northApartment 1330
       has the same problem and the same answer). */
    var segs = Math.max(2, Math.round((z1 - z0) / 8)), pTop = fy + 2.2;
    for (i = 0; i < segs; i++) {
      var za = lerp(z0, z1, i / segs), zbb = lerp(z0, z1, (i + 1) / segs);
      /* capped at 6 u: the block is level and the ground falls 6.6 u along
         it, so an uncapped skirt reaches 1.9 m of masonry at the low end
         and reads as a retaining wall.  The painted plot wall, which
         follows the footway, always overlaps the cap, so the cap can never
         open a gap between the plinth and the ground. */
      poly(P.stone, [[298.98, Math.max(grade(za) - .60, pTop - 6.0), za],
                     [298.98, pTop, za], [298.98, pTop, zbb],
                     [298.98, Math.max(grade(zbb) - .60, pTop - 6.0), zbb]],
           [300.5, fy, (za + zbb) * .5], PLINTH);
    }
    plinthBand(z0, z1, skips);

    /* ROOFSCAPE.  Shallow hip, 2.2 u eaves (0.63 m), dark red fascia over a
       full soffit -- and CROWDED.  The roofline is what you read at forty
       metres and resBlock had none at all. */
    var rise = 6.0, ov = 2.2, xr = 324.0;
    /* The roof spans only the front 25 u of the 37-u mass.  The rest of the
       mass is buried in rock and its flat top can never be seen from
       walkable ground, and a 37-u-deep hip puts the ridge so far back that
       the chimneys sit BELOW the eaves sightline from the far pavement --
       which is exactly the "resBlock has no roofline" failure this is
       meant to answer.  Chimneys and heaters stand on the FRONT slope for
       the same reason. */
    /* The eave is clamped at authored z 195.4 so no part of it crosses
       world X 548, where nz-street.js owns everything and this module may
       build nothing. */
    var rz0 = Math.max(z0, 195.4), rz1 = z1;
    box(P.roof, XE - ov, ey - 1.05, rz0 - ov, xr + ov, ey, rz1 + ov,
        mixColor(C.roofTile, C.wallRed, .45));         /* fascia + soffit */
    hipRoofAxis(P.roof, XE, xr, rz0, rz1, ey, rise, mixColor(C.roofTile, accent, .10),
                'z', ov);
    var xa = XE - ov, cx = (XE - ov + xr + ov) * .5;
    function roofY(x) { return ey + rise * clamp((x - xa) / (cx - xa), 0, 1); }
    for (i = 0; i < 4; i++) {
      var chx = i & 1 ? 303.2 : 307.6;
      var chz = lerp(z0 + 9, z1 - 9, i / 3) + rr(i + seed, 21, -3, 3);
      chimney(chx, chz, roofY(chx) - 1.1, 5.3, mixColor(C.white, C.stone, .30), 1.75, 1.05);
    }
    for (i = 0; i < 3; i++) {
      var shz = lerp(z0 + 16, z1 - 16, i / 2) + rr(i + seed, 22, -4, 4);
      solarHeater(305.0, shz, roofY(305.0) - .4, true);
    }
    STATS.buildings++;
  }

  /* The entrance itself: recessed, glazed, with a C.pinkBand hood held
     ABOVE SAFE_Y(x) = grade(x) + 8.60 so the only thing projecting into the
     footway is out of the player's reach. */
  function southEntrance(zc, fy, body, accent) {
    var gy = grade(zc) + .56;
    panelX(P.masonry, 299.32, gy, gy + 8.0, zc - 2.6, zc + 2.6, -1,
           mixColor(body, C.asphaltDark, .34));
    panelX(P.glass, 299.30, gy + .30, gy + 7.5, zc - 2.4, zc + 2.4, -1,
           mixColor(C.glass, C.steel, .30));
    frameX(299.26, gy + .30, gy + 7.5, zc - 2.4, zc + 2.4, -1);
    var hy = Math.max(fy + 8.35, gy + 8.45);
    box(P.masonry, 297.55, hy, zc - 3.8, 299.00, hy + .62, zc + 3.8, accent);
  }

  function southFrontageBuild() {
    /* The old frontage crossed both the widened road and the mosque parcel.
       Keep only the west block, world X 264..304; Adil Camii begins at x 304
       and the open 232 Sk envelope begins at x 484. */
    southBlock(436, 476, mixColor(C.white, C.cream, .55), C.pinkBand, 5, 8);

    /* OCCLUDERS -- twelve, over world Z 291..300, every one chopped to
       26 u because nz-street-sky.js:1573 SILENTLY DISCARDS anything longer
       and an 88-u facade run would get exactly zero contact shadow. */
    var runs = [[264, 304, 71.9]], i, k;
    for (k = 0; k < runs.length; k++) {
      for (i = 0; i < 4; i++) {
        var xa = lerp(runs[k][0], runs[k][1], i / 4);
        var xb = lerp(runs[k][0], runs[k][1], (i + 1) / 4);
        occ(xa, runs[k][2] - 2.0, 294.5, xb, runs[k][2] + 1.6, 300.0);
      }
    }
  }

  /* ---- the corner block -----------------------------------------------
     THE DEFECT, verified in source: rParkCols (NUKEM.html:3331-3338)
     declares openEdges ['north','south'] and never 'east', so column 136's
     east face survives as a full-height concrete quad at WORLD X = 548,
     WORLD Z 212..300, Y 0.42..58.42 -- 5,104 u^2, the largest blank quad in
     the daylight half of the level, and it faces WEST, straight at the
     player standing in the park.  It reads as polished granite because wtex
     'concrete' carries a hard scored line at v = 0.5 and MirroredRepeat at
     WORLD_TEX_REPEAT 0.55 puts a mirrored tile every 7.27 u in both axes.
     Every sibling module declares BOX x 548..836 or x 168..252, so world
     X 248..548 is served EXCLUSIVELY from here.  This block clads it.

     The mass is one unit deep because nothing may be built past world
     X = 548; the elevation is drawn onto its west face at exactly world
     X = 547.00 and the roof gives the silhouette the depth it needs.
     Six storeys against the photograph's ~16 m is deliberate: the skin MUST
     reach 58.42 u to cover the wall, and a fake cornice deep enough to
     bridge the gap reads worse than an extra floor.  6-7 storeys at
     junctions are normal in the quarter (93b97ea9). */
  function cornerBlock() {
    var ax0 = 204.0, ax1 = 300.6;          /* world Z 204.0 .. 300.6      */
    var ZE = 193.00;                       /* elevation, world X 547.00   */
    var ZB = 192.66;                       /* recess back, world X 547.34 */
    var fy = .55, gf = 11.75, ey = 62.50;  /* 5 upper floors of 10.15     */
    var body = mixColor(C.cream, C.white, .42);
    /* GREY-BROWN TAUPE, not terracotta: 93b97ea9's accent panels are a warm
       grey.  Mixed off C.stone toward the neutral kerb rather than off
       C.peach, which rendered as a second pink. */
    var taupe = mixColor(C.stone, C.curb, .35);
    var i, f;

    /* The mass, its NORTH RETURN and its top in twelve triangles.  The
       return is NOT optional: at world X 544..548, Z 144..212 the map is
       walkable park-column floor, so without it the player walks to the
       skin's north edge and sees straight through into the 1-u slot. */
    box(P.masonry, ax0, -1.0, 192.0, ax1, ey, ZB, mixColor(body, C.asphaltDark, .14));
    /* and the 0.34 u recess slot at its north edge, which would otherwise be
       a full-height slit straight through the building at world Z 204 */
    panelX(P.masonry, ax0, -1.0, ey, ZB, 193.02, -1, body);

    /* GROUND FLOOR.  Rock-faced buff stone plinth drawn as a 0.62-u
       kerb-and-plinth band, NOT the step-up the photograph shows: the
       collision floor is flat per 4-u map column and a 1.0 m step would put
       the player's feet in the air with no way to hide it.  A deliberate,
       documented fidelity loss -- do not "fix" it back into a collision
       bug.  Local ground here is 0.665, so 0.63..1.25 is 0.585 of relief
       and qualifies under R1 exactly as a kerb does. */
    box(P.stone, ax0, .63, 192.98, ax1, 1.25, 193.55, C.stone);
    panelZ(P.stone, 193.02, 1.25, 3.60, ax0, ax1, 1, C.stone);

    /* Continuous aluminium-and-glass shopfronts, six bays, PUNCHED into the
       elevation so the piers between them read as piers. */
    var bays = 6, bw = (ax1 - ax0) / bays;
    for (i = 0; i < bays; i++) {
      var xa = ax0 + i * bw + .55, xb2 = ax0 + (i + 1) * bw - .55;
      panelZ(P.masonry, ZE, 3.60, gf, ax0 + i * bw, xa, 1, body);
      panelZ(P.glass, 192.70, 3.60, 11.55, xa, xb2, 1, mixColor(C.glass, C.steel, .22));
      frameZWorld(192.72, 3.60, 11.55, xa, xb2, 1);
      var mxx = (xa + xb2) * .5;
      panelZ(P.masonry, 192.94, 3.60, 11.55, mxx - .22, mxx + .22, 1, C.stainless);
      panelZ(P.masonry, ZE, 11.55, gf, xa, xb2, 1, body);
    }
    panelZ(P.masonry, ZE, 3.60, gf, ax1 - .55, ax1, 1, body);

    /* Plain rendered head band: no retail lettering or medical symbol. */
    box(P.masonry, ax0, gf, 192.98, ax1, gf + 2.45, 193.55,
        mixColor(body, C.stone, .18));

    /* FLOORS 1-5: pale cream/magnolia render with GREY-BROWN TAUPE accent
       panels marking the recessed balcony bays and the corner strips,
       seven bays, paired punched windows 4.2 x 4.9 u. */
    var ubays = 7, ubw = (ax1 - ax0) / ubays;
    panelZ(P.masonry, 193.02, gf + 2.45, ey, ax0, ax0 + 3.2, 1, taupe);
    panelZ(P.masonry, 193.02, gf + 2.45, ey, ax1 - 3.2, ax1, 1, taupe);
    for (i = 0; i < ubays; i++) {
      var ux0 = ax0 + i * ubw, uxc = ux0 + ubw * .5, ux1 = ux0 + ubw;
      var recess = (i % 2) === 1;
      if (recess) panelZ(P.masonry, 193.02, gf + 2.45, ey, ux0 + .9, ux1 - .9, 1, taupe);
      for (f = 0; f < 5; f++) {
        var fy0 = gf + 2.45 + f * 10.15, fy1 = fy0 + 10.15;
        var wy0 = fy0 + 2.35, wy1 = wy0 + 4.9;
        var ow = recess ? 4.6 : 5.0;
        panelZ(P.masonry, ZE, fy0, wy0, ux0, ux1, 1, body);
        panelZ(P.masonry, ZE, wy1, Math.min(fy1, ey), ux0, ux1, 1, body);
        panelZ(P.masonry, ZE, wy0, wy1, ux0, uxc - ow, 1, body);
        panelZ(P.masonry, ZE, wy0, wy1, uxc + ow, ux1, 1, body);
        if (recess) {
          panelZ(P.glass, 192.70, wy0, wy1, uxc - ow, uxc + ow, 1,
                 mixColor(C.glass, C.white, .30));
          frameZWorld(192.72, wy0, wy1, uxc - ow, uxc + ow, 1);
          STATS.windows++;
        } else {
          panelZ(P.masonry, ZE, wy0, wy1, uxc - .55, uxc + .55, 1, body);
          var pd;
          for (pd = 0; pd < 2; pd++) {
            var pc = uxc + (pd ? 2.65 : -2.65);
            panelZ(P.glass, 192.70, wy0, wy1, pc - 2.1, pc + 2.1, 1, C.glass);
            frameZWorld(192.72, wy0, wy1, pc - 2.1, pc + 2.1, 1);
            STATS.windows++;
          }
          panelZ(P.stone, 193.04, wy0 - .30, wy0, uxc - ow, uxc + ow, 1,
                 mixColor(C.stone, C.white, .50));
        }
      }
    }

    /* Three white horn loudspeakers -- the municipal PA of this junction,
       clamped above SAFE_Y, and they cost thirty triangles. */
    for (i = 0; i < 3; i++) {
      var hx = lerp(ax0 + 16, ax1 - 16, i / 2);
      tube(P.metal, [hx, 17.5, 193.62], [hx, 17.5, 194.45], .52, 5, C.white, false);
      tube(P.metal, [hx, 17.5, 193.10], [hx, 17.5, 193.70], .13, 4, C.stainless, false);
    }

    /* ROOF.  Ridge along world Z, so hipRoofAxis with axis 'x'.  Eaves at
       62.50 clear the wall top at 58.42 by 4.08 u, and everything above
       y = 62.5 paints straight onto the skybox (the region is sky:true). */
    var rz0 = 186.0, rz1 = 193.4, ov = 2.2;
    box(P.roof, ax0 - ov, ey - .70, rz0 - ov, ax1 + ov, ey, rz1 + ov,
        mixColor(C.roofTile, C.wallRed, .45));
    hipRoofAxis(P.roof, ax0, ax1, rz0, rz1, ey, 6.0,
                mixColor(C.roofTile, C.peach, .10), 'x', ov);
    for (i = 0; i < 4; i++)
      chimney(lerp(ax0 + 12, ax1 - 12, i / 3), 189.6, ey + 3.4, 4.2,
              mixColor(C.white, C.stone, .30), 1.75, 1.05);
    for (i = 0; i < 3; i++)
      solarHeater(lerp(ax0 + 26, ax1 - 26, i / 2), 191.0, ey + 4.2, true);

    /* four occluders over world X 541..548 -- eaves and shopfront fascia */
    occ(541, ey - 2.0, 204, 548, ey + 1.6, 228);
    occ(541, ey - 2.0, 228, 548, ey + 1.6, 252);
    occ(541, ey - 2.0, 252, 548, ey + 1.6, 276);
    occ(541, gf - 1.0, 276, 548, gf + 3.0, 300);
    STATS.buildings++;
  }

  /* ---- barriers and open vista ---------------------------------------- */
  function barrier(x0,x1,z) {
    var y=grade(z)+.55,n=5,i;
    for(i=0;i<n;i++){
      var xa=lerp(x0,x1,i/n)+.12,xb=lerp(x0,x1,(i+1)/n)-.12;
      box(P.masonry,xa,y+2.0,z-.35,xb,y+3.65,z+.35,i%2?C.white:C.red);
    }
    for(i=0;i<=n;i++){
      var x=lerp(x0,x1,i/n);
      tube(P.metal,[x,y,z],[x,y+4.0,z],.12,6,C.steel,true);
      tube(P.metal,[x-1.1,y+.05,z-.8],[x+1.1,y+.05,z+.8],.10,5,C.steel,false);
    }
    STATS.barriers++;
  }

  function barrierZ(z0,z1,x) {
    var y=.55,n=6,i;
    for(i=0;i<n;i++){
      var za=lerp(z0,z1,i/n)+.12,zb=lerp(z0,z1,(i+1)/n)-.12;
      box(P.masonry,x-.35,y+2.0,za,x+.35,y+3.65,zb,i%2?C.white:C.red);
    }
    for(i=0;i<=n;i++){
      var z=lerp(z0,z1,i/n);
      tube(P.metal,[x,y,z],[x,y+4.0,z],.12,6,C.steel,true);
      tube(P.metal,[x-.8,y+.05,z-1.1],[x+.8,y+.05,z+1.1],.10,5,C.steel,false);
    }
    STATS.barriers++;
  }

  function cityWindow(x,y0,y1,z0,z1) {
    panelX(P.glass,x,y0,y1,z0,z1,-1,C.glass);
    frameX(x-.05,y0,y1,z0,z1,-1);
  }

  function buildCityTerminus() {
    /* Collision is one cell deep at x=832.  The road barricade is waist-high,
       while simple railings explain the equally solid pavement edges without
       hiding the 230 Sk crossing or the view beyond. */
    var wasAuthored=TRANSFORM_AUTHORED;
    TRANSFORM_AUTHORED=false;
    try {
      /* MISSION 4 drives a checkpoint lane through this barricade on grid row
         43 (world z 172..176), so the boom gate the level puts there is not
         standing behind two metres of concrete.  Every other mission keeps the
         continuous line. */
      /* THE EAST LINE IS A PLAIN CLOSURE AGAIN.  It carried a lane through
         it for the keycard gate while the checkpoint stood here; the
         checkpoint is on the park crest now and this end is what every other
         closure on the map is -- one continuous run of bariyer with the town
         visible behind it.  No mission splits it any more. */
      barrierZ(152.4,203.6,CLOSURE.cityX);
      fence(CLOSURE.cityX,144.4,CLOSURE.cityX,151.5,3.0);
      fence(CLOSURE.cityX,204.5,CLOSURE.cityX,211.6,3.0);
      /* The collision shell on the short post-230 apron remains unchanged,
         but it reads as an open street edge: these waist-high rails replace
         the generated full-height concrete side walls. */
      fence(792.2,152.15,CLOSURE.cityX,152.15,3.0);
      /* THE MARKET'S FRONTAGE IS NOT A PAVEMENT EDGE ANY MORE.
         This rail was drawn the full width of the south tail because the plot
         behind it was a blank five-storey mass and the rail was all that
         explained why the pavement stopped.  nz-street-side now puts a shop
         there, fronting 233 Sk over x 797..821, and a railing across a shop
         window is the one thing that says nobody looked at it.  Split around
         the frontage; the two stubs either side still do the job at the ends. */
      if (NZ.level === 4) {
        fence(792.2,195.85,795.0,195.85,3.0);
        fence(823.0,195.85,CLOSURE.cityX,195.85,3.0);
      } else {
        fence(792.2,195.85,CLOSURE.cityX,195.85,3.0);
      }
      fence(792.15,112.2,792.15,151.5,3.0);
      fence(792.15,196.5,792.15,243.8,3.0);
      fence(760.2,112.15,792.15,112.15,3.0);
      fence(760.2,243.85,792.15,243.85,3.0);

      /* The photograph is not a wall of generic blocks.  From left to right
         it shows a pale blue two-storey house, a low tan tiled roof with its
         normal rooftop clutter, and a taller sage house with a narrow white
         enclosed balcony.  Keep all three several metres beyond the police
         line so the 11.4 m playable tail still reads correctly. */
      function smallWindow(x,y,z,w,h) {
        cityWindow(x,y,y+h,z-w*.5,z+w*.5);
      }
      /* Pale blue/cream house on the left, two ordinary window rows. */
      var blue=mixColor(C.city,C.white,.54);
      box(P.masonry,866,.2,134,891,20.4,158,blue);
      smallWindow(865.72,4.0,140.2,4.4,5.1);
      smallWindow(865.72,4.0,151.3,4.4,5.1);
      smallWindow(865.72,12.0,140.2,4.4,5.1);
      smallWindow(865.72,12.0,151.3,4.4,5.1);
      hipRoof(P.roof,866,891,134,158,20.4,4.2,mixColor(C.roof,C.city,.30));
      chimney(876,139.5,22.4,2.5,mixColor(C.cream,C.white,.18));

      /* Low intervening row: broad tan roof, modest windows, chimneys and a
         solar-water installation.  Its varied eaves keep the silhouette from
         becoming another pastel rectangle. */
      var low=mixColor(C.cream,C.white,.26);
      box(P.masonry,882,.2,158,921,15.6,187,low);
      smallWindow(881.72,3.7,163.5,4.0,4.5);
      smallWindow(881.72,3.7,173.0,4.0,4.5);
      smallWindow(881.72,3.7,182.2,4.0,4.5);
      smallWindow(881.72,9.6,163.5,4.0,4.2);
      smallWindow(881.72,9.6,173.0,4.0,4.2);
      smallWindow(881.72,9.6,182.2,4.0,4.2);
      hipRoof(P.roof,882,921,158,187,15.6,5.0,mixColor(C.roof,C.cream,.18));
      chimney(895,164.5,18.0,3.1,mixColor(C.cream,C.white,.15));
      chimney(909,181.5,18.0,2.7,mixColor(C.cream,C.white,.08));
      solarHeater(913,172.5,19.0);

      /* Sage three-storey house on the right.  Window panes are deliberately
         domestic in scale; the earlier single 14-by-12 unit pane made this
         read as a warehouse.  The white bay projects only 0.45 m and is split
         floor by floor like the enclosed balcony in the reference. */
      var sage=mixColor(C.city,C.grass,.38);
      box(P.masonry,870,.2,188,899,29.0,218,sage);
      smallWindow(869.72,4.0,192.8,3.7,5.0);
      smallWindow(869.72,4.0,213.0,3.7,5.0);
      smallWindow(869.72,12.3,192.8,3.7,5.0);
      smallWindow(869.72,12.3,213.0,3.7,5.0);
      smallWindow(869.72,20.6,192.8,3.7,5.0);
      smallWindow(869.72,20.6,213.0,3.7,5.0);
      box(P.masonry,868.45,3.0,197.0,870.05,20.8,208.5,C.white);
      cityWindow(868.18,4.0,10.4,198.0,207.5);
      cityWindow(868.18,12.3,19.0,198.0,207.5);
      hipRoof(P.roof,870,899,188,218,29.0,5.2,mixColor(C.roof,C.city,.18));
      chimney(884,212.5,31.3,3.2,mixColor(C.cream,C.white,.08));

      /* A washed second rank makes the town continue behind the foreground
         roofs, but stays low enough that the mountain is never occluded. */
      box(P.masonry,930,5.0,142,958,22.0,163,mixColor(C.white,C.city,.46));
      hipRoof(P.roof,930,958,142,163,22.0,3.8,mixColor(C.roof,C.city,.38));
      box(P.masonry,938,6.0,177,967,25.0,199,mixColor(C.cream,C.city,.46));
      hipRoof(P.roof,938,967,177,199,25.0,4.1,mixColor(C.roof,C.city,.34));

      /* Small roadside crowns, plus one fuller evergreen at the far-left
         edge, echo the reference without closing the central sightline. */
      evergreen(848,145.8,14.2,3.9,false);
      deciduous(855,164.0,9.5,3.2,false);
      deciduous(860,221.0,10.5,3.4,false);
      STATS.buildings+=5;
    } finally {
      TRANSFORM_AUTHORED=wasAuthored;
    }
  }

  function buildVista() {
    /* MISSION 4 DRIVES THE CHECKPOINT LANE THROUGH THIS LINE.
       The cordon used to end at the east police line and the mission ran
       downhill into it; it runs uphill now and the crest is where it ends.
       NUKEM.html carves grid row 40 -- world z 160..164, the centre of the
       north carriageway -- through the closure at column 66, so the north
       barrier is split around it exactly the way buildCityTerminus used to
       split its own line, and for the same reason: a boom gate standing
       behind two metres of concrete panel is a boom gate nobody can see.
       Every other mission keeps the continuous line. */
    if (NZ.level === 4) {
      barrier(CLOSURE.northSpan.z0, 158.60, 474);
      barrier(165.40, CLOSURE.northSpan.z1, 474);
    } else {
      barrier(CLOSURE.northSpan.z0,CLOSURE.northSpan.z1,474);
    }
    barrier(CLOSURE.southSpan.z0,CLOSURE.southSpan.z1,474);
    /* This is the park crest, not the mountain-facing 230 terminus.  Keep it
       porous against sky and foliage; the city/mountain composition belongs on
       the main east-west axis and is built by buildCityTerminus(). */
  }

  function buildAll() {
    buildRoadway(); plantStreet();                        /* JOB A */
    buildLawn(); plantLawn();                             /* JOB B */
    buildParkFurniture(); buildFences(); buildStarSign(); /* JOB C */
    buildArena(); buildParkEndVistaFacade(); buildParkEndSideFacade(); buildNorthFrontage();
    /* The photographed south-arm edge is open park.  cornerBlock() is kept
       above as historical geometry documentation, but deliberately not built:
       it was the one-unit-deep facade strip the site correction removes. */
    southFrontage();                                      /* JOB D */
    buildVista(); buildCityTerminus();
  }

  function makeMesh(key,bake) {
    var p=P[key]; if(!p||!p.n)return null;
    var g=p.geometry();
    if(key==='vista'){
      var ca=new Float32Array(p.tone),j; for(j=0;j<ca.length;j++)ca[j]=clamp(ca[j],0,1);
      g.setAttribute('color',new THREE.BufferAttribute(ca,3));
    } else bakeTone(g,p,bake);
    var mesh=new THREE.Mesh(g,M[key]);
    mesh.name='nz-street-park:'+key; mesh.matrixAutoUpdate=false; mesh.updateMatrix();
    mesh.castShadow=false;
    mesh.receiveShadow=key!=='glass'&&key!=='panel'&&key!=='vista'&&key!=='mark';
    scene.add(mesh);OWN.obj.push(mesh);
    var tris=Math.floor(p.idx.length/3);
    STATS.draws++;STATS.tris+=tris;STATS.verts+=p.n;
    DIAG.piles.push({name:key,verts:p.n,tris:tris});
    return mesh;
  }

  /* EVERY bake carries the module's occluder list.  Until this pass the park
     registered ZERO occluders while nz-street-ground/props/entrance register
     fifteen between them, and at the `low` tier every headless shot uses,
     this bake is the ONLY ambient occlusion in frame -- so nothing in the
     park cast a contact shadow and every object floated on a uniformly lit
     lawn.  That, not the triangle count, is what "cartoonish" was.
     NZ.street.bake auto-registers and REPLAYS occluders onto geometries
     baked earlier, so the list may still be growing while meshAll runs. */
  function meshAll() {
    makeMesh('asphalt',{rays:4,floor:.58,scale:.97,occluders:OCC});
    makeMesh('paver',{rays:5,floor:.54,scale:.96,occluders:OCC});
    makeMesh('apron',{rays:5,floor:.54,scale:.96,occluders:OCC});
    makeMesh('grass',{rays:4,floor:.60,scale:.98,occluders:OCC});
    makeMesh('masonry',{rays:6,floor:.46,scale:.95,occluders:OCC});
    makeMesh('stone',{rays:6,floor:.43,scale:.94,occluders:OCC});
    makeMesh('roof',{rays:5,floor:.48,scale:.94,occluders:OCC});
    makeMesh('wood',{rays:5,floor:.40,scale:.92,occluders:OCC});
    makeMesh('bark',{rays:5,floor:.34,scale:.90,occluders:OCC});
    makeMesh('metal',{rays:4,floor:.42,scale:.93,occluders:OCC});
    makeMesh('glass',{rays:3,floor:.56,scale:.98,occluders:OCC});
    makeMesh('foliage',{rays:3,floor:.55,scale:.96,occluders:OCC});
    makeMesh('needle',{rays:3,floor:.56,scale:.97,occluders:OCC});
    makeMesh('mark',{rays:3,floor:.60,scale:.98,occluders:OCC});
    makeMesh('panel',{rays:3,floor:.64,scale:1,occluders:OCC});
    makeMesh('vista',null);
  }

  function report() {
    var L=['NZ-STREET-PARK '+(installed?'installed':'inert')+' draws '+STATS.draws+
      ' tris '+STATS.tris+' verts '+STATS.verts+' '+STATS.ms+'ms'];
    /* ROUTE carries x0/x1, never z0/z1; the old line printed
       'route z undefined..undefined grade 0..NaN'. */
    L.push('  route x '+ROUTE.x0+'..'+ROUTE.x1+' grade '+
      worldGrade(ROUTE.x1).toFixed(2)+'..'+worldGrade(ROUTE.x0).toFixed(2));
    L.push('  park '+ROUTE.park.x0+'..'+ROUTE.park.x1+' / '+ROUTE.park.z0+'..'+ROUTE.park.z1+
      ' arena '+ARENA.x0+'..'+ARENA.x1+' / '+ARENA.z0+'..'+ARENA.z1+' entrance z '+ARENA.entrance.z);
    L.push('  patches '+STATS.roadPatches+' curbs '+STATS.curbSegments+' trees '+
      (STATS.medianTrees+STATS.parkTrees)+' hedges '+STATS.hedges+' gazebos '+STATS.gazebos+
      ' benches '+STATS.benches+' lamps '+STATS.lamps+' barriers '+STATS.barriers);
    L.push('  lawn '+LAWN.nx+'x'+LAWN.nz+' quads  fringe/tuft cards '+STATS.tufts+
      '  hedge cards '+STATS.hedgeCards+'  shrubs '+STATS.shrubs+
      '  path samples '+PATHPTS.length);
    L.push('  marks '+STATS.marks+' gullies '+STATS.gullies+' tree pits '+STATS.pits+
      ' occluders '+OCC.length+' texture '+(STATS.textureBytes/1048576).toFixed(2)+' MB');
    for(var i=0;i<DIAG.piles.length;i++)L.push('  pile '+DIAG.piles[i].name+' '+DIAG.piles[i].tris+' tris');
    if(DIAG.warnings.length)L.push('  warnings: '+DIAG.warnings.join(' | '));
    return L.join('\n');
  }

  function dispose() {
    var i;
    for(i=0;i<OWN.obj.length;i++)if(OWN.obj[i]&&OWN.obj[i].parent)OWN.obj[i].parent.remove(OWN.obj[i]);
    for(i=0;i<OWN.geo.length;i++)try{OWN.geo[i].dispose();}catch(e){}
    for(i=0;i<OWN.mat.length;i++)try{OWN.mat[i].dispose();}catch(e2){}
    for(i=0;i<OWN.tex.length;i++)try{OWN.tex[i].dispose();}catch(e3){}
    OWN.obj.length=OWN.geo.length=OWN.mat.length=OWN.tex.length=0;
    installed=false;STATS.ok=false;if(NZ.flags)NZ.flags.streetPark=false;
    if(NZ.streetPark)NZ.streetPark.ok=false;
  }

  function panic(err) {
    dead=true;dispose();
    try{console.error('[nz-street-park] disabled after error:',err);}catch(e){}
  }

  function install(ctx) {
    if(dead||installed)return;
    if(laterMission()){
      NZ.streetPark.skipped='later-mission';
      NZ.log&&NZ.log('street-park skipped on level '+NZ.level);
      return;
    }
    if(!hasPark()){
      NZ.streetPark.skipped='carve-absent';
      NZ.log&&NZ.log('street-park: park carve not present, module inert');
      return;
    }
    var t0=global.performance&&performance.now?performance.now():Date.now();
    THREE=(ctx&&ctx.THREE)||(NZ.ctx&&NZ.ctx.THREE)||global.THREE;
    scene=(ctx&&ctx.scene)||(NZ.ctx&&NZ.ctx.scene);
    renderer=(ctx&&ctx.renderer)||(NZ.ctx&&NZ.ctx.renderer);
    if(!THREE||!scene)throw new Error('Three.js scene context unavailable');
    if(!global.document||!document.createElement)throw new Error('canvas document unavailable');
    /* MISSION 4 ONLY.  Must run before initPilesMaterials(), initToneCache()
       and initFurnitureTones(), all of which cache derivatives of C. */
    /* ...AND ONLY WHILE THE SKY IS ACTUALLY SUNNY.  Mission 4 went back to
       an overcast dome with the photographic sky, and the physical albedos
       applySunnyProfile() installs have nothing to light them there: the
       park carriageway measured 54/255 beside nz-street-ground's 137.  The
       table at the top of this file IS the overcast calibration, so under
       NZ.street.SKY.overcast the right move is to not replace it.  The road
       detail pass is kept either way -- see ROAD_DETAIL. */
    var skyNow=NZ.street&&NZ.street.SKY;
    if(NZ.level===4){ROAD_DETAIL=true;if(!(skyNow&&skyNow.overcast))applySunnyProfile();}
    initPilesMaterials();buildAll();meshAll();
    installed=true;STATS.ok=true;STATS.ms=Math.round((global.performance&&performance.now?performance.now():Date.now())-t0);
    if(NZ.flags)NZ.flags.streetPark=true;
    NZ.streetPark={
      ok:true,loaded:true,stats:STATS,diag:DIAG,route:ROUTE,arena:ARENA,closure:CLOSURE,
      gradeAt:worldGrade,report:report,dispose:dispose
    };
    NZ.log&&NZ.log('street-park installed: '+STATS.draws+' draws '+STATS.tris+' tris in '+STATS.ms+'ms');
    try{console.warn('[nz-street-park] threw:0 '+STATS.draws+' draws, '+STATS.tris+
      ' tris, '+STATS.gazebos+' gazebos, '+(STATS.medianTrees+STATS.parkTrees)+' trees, '+
      DIAG.warnings.length+' warnings');}catch(e){}
  }

  if(DISABLED){
    NZ.streetPark.skipped='query';
    NZ.log&&NZ.log('street-park disabled by ?nzpark=0');
  }else{
    NZ.on('ready',function(ctx){
      if(dead)return;
      try{install(ctx);}catch(err){panic(err);}
    },-35);
  }
  NZ.log&&NZ.log('street-park module loaded');
})(typeof window!=='undefined'?window:this);
