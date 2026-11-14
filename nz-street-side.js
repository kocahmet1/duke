(function (global) {

/* ==== side-1-kit.js ==== */
/* ===========================================================================
   SECTION 0  MODULE HEADER + GUARDS
   ===========================================================================
   NZ-STREET-SIDE  --  232. Sokak, and every police line that ends a street.

   MISSION 4 ONLY.  The old mission carried one east-west axis; the cordon
   opens the crossing the tree roundabout was always built around, so this
   module owns everything the other five street modules never had a reason to
   author:

     - the two 232 Sk carriageways north and south of the roundabout, and the
       roundabout apron itself: asphalt, kerbs, kilit tasi paving, kerb radii,
       gullies and markings;
     - eleven built flanking/stub elevations with their MASS behind them,
       their roofs,
       their end returns and their corner quoins.  Every face stands 0.02
       units PROUD of the cell boundary: coplanar is how you lose a depth test
       to somebody else's end cap, and 6 mm of proud is invisible at
       1 unit = 286 mm;
     - residential B-BLOK frontage, DOYUM EKMEK FABRIKASI and DEGERLI's
       garage, all with their openings left exactly where the grid puts a door
       or a loggia, so the lintel buildWorld draws is the only thing over each;
     - the four blocked kerb strips.  NUKEM.html marks sixteen road cells
       S_BLOCK for parked cars this rebuild deletes, and S_BLOCK with no mesh
       on it is an invisible wall, so each strip carries a bin run, a skip, a
       market row or a roadworks excavation instead;
     - the barricades.  Four of them, plus the boom gate on the east police
       line.  A closure is never a building: it is a waist-high red-and-white
       line with the street visibly continuing behind it, because a player who
       cannot see where the map stops assumes he has missed a door;
     - what is behind them.  Adil Camii sits beyond the NORTH line, offset
       to the east/right of 232 Sk while the road continues past it.  It is
       never used as a vista plug in the carriageway: the surveyed footprint
       is about 25 m east of the road centreline.  Ordinary town continues
       beyond the south line.

   It does NOT own: the 233 Sk carriageway (nz-street-ground.js), the two
   photographed elevations (nz-street.js), the park, the roundabout island or
   the city terminus (nz-street-park.js), any prop on the main axis
   (nz-street-props.js), or the sky (nz-street-sky.js).  THERE IS NO VEHICLE
   IN THIS MODULE.  The only vehicle in the mission is the silver Tourneo
   Courier nz-street-props.js parks on 233 Sk at x 652..668, z 160..164.

   Visuals only: it never writes a map cell.  Zero external assets, classic
   script, three.js r149 core UMD surface only.  1 unit = 0.2857 m (U = 3.5),
   so every dimension is written m(metres) and only site coordinates are raw.

   THE PIPELINE, which is the whole difference between this and a prototype
   (it is nz-street-park.js's, measured against photographs):
     every canvas map is a near-WHITE, near-NEUTRAL RELIEF layer;
     ALL colour arrives as the per-vertex tone;
     NZ.street.bake() OVERWRITES geo.attributes.color with an achromatic sky
     visibility term, so the tone is multiplied into it AFTERWARDS, in place -
     bake first, multiply second, always;
     alphaTest, never blending, on every alpha pile;
     every atlas cell obeys the MIP RULE (a filled opaque body under the
     strokes) and the GUTTER RULE (12 px of fully transparent margin);
     every arris that has a silhouette is chamfered;
     every group registers an occluder, because at the `low` tier the headless
     shots use, this bake is the ONLY ambient occlusion in frame.
   ======================================================================== */

/* ===========================================================================
   SECTION 1  SCALE, PALETTE, SITE CONSTANTS
   ======================================================================== */

var NZ = global.NZ;
/* Nothing below runs without the core.  This is a top-level return inside the
   module's own IIFE, so it leaves every declaration hoisted and unreachable -
   which is exactly what "inert" means here. */
if (!NZ || !NZ.on) return;

var THREE = null, scene = null, renderer = null;
var installed = false, dead = false;
var MAX_ANISO = 4;

var DISABLED = /[?&]nzside=(?:0|off)(?:&|$)/i.test(
  global.location ? global.location.search : '');

var U = 3.5;
function m(x) { return x * U; }

var STATS = {
  ok: false, draws: 0, tris: 0, verts: 0, ms: 0,
  /* ground */
  roadPatches: 0, kerbs: 0, gullies: 0, marks: 0, pits: 0,
  /* buildings */
  elevations: 0, masses: 0, roofs: 0, returns: 0, quoins: 0,
  openings: 0, windows: 0, balconies: 0, signs: 0, decals: 0,
  /* dressing and scenery */
  lamps: 0, wires: 0, trees: 0, buildings: 0, minarets: 0, vehicles: 0,
  barricades: 0, cones: 0, occluders: 0,
  textureBytes: 0, warnings: 0
};
var DIAG = { warnings: [], piles: [] };
var OWN = { tex: [], mat: [], geo: [], obj: [] };

/* published immediately and REPLACED with the full record at install: a
   consumer that reads this while the module is inert (wrong level, arms not
   carved) still gets every key, never an undefined function. */
NZ.streetSide = {
  ok: false, loaded: true, stats: STATS, diag: DIAG,
  report: report, dispose: dispose, arms: null, gate: null, facades: []
};

function warn(s) {
  DIAG.warnings.push(String(s)); STATS.warnings = DIAG.warnings.length;
  try { console.warn('[nz-street-side] ' + s); } catch (e) {}
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d === undefined ? 0 : d); }

/* One fixed-seed lattice hash, so a render can be MEASURED and the number
   adjusted.  Nothing in this module is allowed to be random per run. */
var SEED = 2320610;
function hash(n) { var s = Math.sin(n * 12.9898 + SEED * 0.00013) * 43758.5453123; return s - Math.floor(s); }
function rr(a, b, lo, hi) { return lo + (hi - lo) * hash(a * 7919 + b * 104729 + 11); }

/* sRGB -> linear, once.  Vertex colours are consumed linear and never
   decoded, so every palette entry below is converted here rather than
   guessed at in the middle of a builder. */
function L(hex) {
  function c(u) { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); }
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}
function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function mulv(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }

/* THE C TABLE IS A SET OF RATIOS AGAINST THE ROAD, NOT A THEME.  Every entry
   is a multiplier on an achromatic bake, so the number that matters is
   Y(surface)/Y(C.asphalt) measured in the SAME render with the road at 1.000.
   The hexes below are the module's authored albedos; they are deliberately
   WARM, because the overcast probe is blue by construction and a neutral
   albedo lands blue after the sky has had its say (nz-street-park measured its
   own road at blue 13 above red before this correction).  When a shot exists,
   re-measure IN OUR OWN FRAME - the transfer is not linear across piles whose
   map means and bake floors differ - and obey the stop rule: two iterations
   per surface, then leave it.  Chasing the last few percent is how the park's
   shelter roof ended up salmon.
   Deleted this pass with the vehicles: car1..car4, tyre, chrome, teal,
   redPale. */
/* THE SUNNY-DAY REPAINT (mission 4 only, which is the only mission this
   module runs on at all -- install() returns at NZ.level !== 4, so every hex
   below is by construction a level-4 look and touches nothing on mission 1).

   The old table carried SEVEN body tones for THIRTEEN runs, three of them
   near-identical pale creams (cream d9d2c0 / sand d6c9a8 / butter d8d0ad sit
   inside 5 luma and 8 degrees of each other), and it was solved against an
   overcast probe: an achromatic sky, no sun term, and a grade that multiplied
   chroma by 1.62.  Under the sunny profile the grade holds chroma at 1.30, so
   the same albedos land ~20 % flatter, and eleven blocks in three creams read
   as one repeated texture rather than as a street.

   So: THIRTEEN tones, one per run, no two adjacent runs sharing a hue family,
   and the VALUE spread widened from 185..218 to 150..233 -- because the thing
   that makes a real sunlit street read is not the chroma of any one block, it
   is that the block beside it is a different BRIGHTNESS.  Hues stay inside the
   Anatolian range (ochre, terracotta, dusty rose, cream, sage, olive, a
   grey-blue) and every one of them is a paint that exists on 233 Sk.
   Chroma sits at S 0.07 (the palest render) to S 0.38 (the terracotta); the
   old table topped out at 0.31 and averaged 0.17. */
var C = {
  /* --- the thirteen body tones, palest first ------------------------- */
  bone:    L(0xece6da),          /* near-white render, the palest block     */
  cream:   L(0xe2dbc9),
  butter:  L(0xe0d5a4),
  sand:    L(0xdcc79a),
  apricot: L(0xd9ba8e),
  ochre:   L(0xd3b283),
  dusty:   L(0xd5b0aa),          /* dusty pink, the commonest repaint       */
  rose:    L(0xc9a49a),
  sage:    L(0xc2c9a9),
  paleblu: L(0xc0cbcf),
  olive:   L(0xb7b287),
  terra:   L(0xc08e78),          /* terracotta, the darkest body            */
  clay:    L(0xc79a80),
  white: L(0xeceae4), grey: L(0xb4b4b0),
  plinth:  L(0x948d80), stone: L(0xcfc9bd), brick: L(0xa9724f),
  roof:    L(0x8d5a3c), gutter: L(0x6f4234),
  steel:   L(0x9aa0a4), dark: L(0x4a4e52), rail: L(0x8c5552), pipe: L(0x8e8b83),
  timber:  L(0x6b4f36),                       /* window frames that are not PVC */
  /* THE PANES WERE SOLVED FOR AN OVERCAST PROBE AND THE SUN BROKE THEM.
     A west-facing 232 Sk pane takes N.L = 0.94 x cos52 = 0.58 of a 2.45 key,
     and MeshStandardMaterial pays that into the DIFFUSE lobe like any other
     surface, so a 0x5d6d78 pane came back at rgb(198,179,166) against a wall
     at (168,164,150): the windows were BRIGHTER and WARMER than the render
     around them -- pale pink slabs, the least window-like thing a window can
     be.  Real glass has almost no diffuse: you see the unlit room, and direct
     sun on the outside of a pane does not light the room behind it.  So the
     pane tone drops to a third of its luminance, which is what lands it back
     under the wall on the lit flank without turning the shaded ones into
     holes; the sheen it does have comes from env 0.34 at roughness 0.28,
     which is untouched, and that lobe IS orientation-dependent, so a pane
     still catches the sky where a real one does. */
  glass:   L(0x3d4750), shade: L(0x6d6f70),
  /* THE HORIZONTAL ALBEDOS WERE SOLVED AGAINST AN OVERCAST SKY AND A BAKED
     SUN, AND MISSION 4 NO LONGER HAS EITHER.
     Under the old rig an up-facing surface received an irradiance of 2.00 from
     the dome, multiplied by its own sky-visibility bake (~0.56 on an open
     carriageway) -- so 0x87888a, a linear 0.235, landed the road near 148/255
     before the grade. The sunny rig separates the two terms and, correctly,
     stops the ambient-occlusion bake from dimming DIRECT sunlight: an open
     road now takes the sun undimmed, and 0.235 came back at 232/255 -- a
     white road. The albedo was never asphalt's; it was a number that happened
     to land right once it had been through a 0.56 occlusion multiply.
     These are the real ones. Dry bituminous asphalt is 0.10-0.14 linear;
     concrete kilit tasi paving and precast kerbs are 0.30-0.36. Measured after
     the change, sunlit road 118/255 and shaded road 44 -- a 4.2:1 sun/shade
     ratio on the same material, which is what a clear day is. */
  asphalt: L(0x5f6163), paver: L(0x9f9990), kerb: L(0xa9a59d),
  line:    L(0xe6e4dc), red: L(0xb43a2e),
  green:   L(0x2f6b45), gold: L(0xbb9a4d), soil: L(0x6e5c46),
  trunk:   L(0x6b5a48), needle: L(0x4a6647), needleD: L(0x33482f)
};
C.alu = C.steel;                              /* aluminium joinery, same albedo */

/* The grime a horizontal precast surface collects.  Linear, near-black-grey:
   a coping toned pure C.white clips past 245 sRGB the moment the bake gives it
   an up-facing 2.00 from the dome. */
var UPGRIME = [0.150, 0.148, 0.142];

/* ---- MISSION 4 IS OVERCAST AGAIN, AND THE GROUND WAS LEFT IN THE SUN ----
   The three horizontal albedos above are the SUNNY re-solve: physical
   bitumen and precast, which is right when an open road takes a 2.45 key
   undimmed.  The photographic-sky pass put the dome back (NZ.street.SKY
   .overcast) and changed nothing here, and with no key those albedos are all
   the ground has.  Measured beside nz-street-ground's 233 Sk carriageway --
   which was never re-solved for the sun and stands at 137/255 -- 232 Sk came
   back at 66 and the kilit tasi in front of the pharmacy at 58: a wet night
   road under a noon sky.  The owner's April 2026 frame of this junction has
   the asphalt at 126 under a 193 sky and the paving at 132.

   So when the published sky is overcast the ground goes back to COMPENSATED
   tones, the same kind nz-street-park's own overcast table carries (its road
   is 0.45): this pipeline hands a horizontal surface roughly 0.38 of its tone
   on screen, so a road that should photograph at 0.20 needs a tone of 0.5.
   UPGRIME rises with them, or upTone() would drag the paving straight back
   down to where it was.  The sunny table is untouched and still wins the
   moment the sky stops reporting overcast. */
function overcastGround() {
  var S = NZ.street && NZ.street.SKY;
  if (!S || !S.overcast) return false;
  C.asphalt = [0.500, 0.500, 0.496];
  C.paver = [0.640, 0.618, 0.578];
  C.kerb = [0.800, 0.790, 0.762];
  UPGRIME = [0.330, 0.325, 0.310];
  return true;
}

/* Vertical alpha cards need a GAIN or they read as a dark rim: an up-facing
   surface receives 2.00 from the overcast dome and a vertical one about 1.30,
   and the MEASURED orientation discount is 0.76, not the 0.65 the ratio
   predicts.  These are nz-street-park's calibrated starting points - they were
   solved against THAT module's bake floors, so re-measure in our frame. */
var CARD_GAIN = 1.40, DRY_CARD = 1.10, HEDGE_GAIN = 1.35, SHRUB_GAIN = 1.30;

/* ---- THE SITE, in world units ----------------------------------------
   Both arms of 232 Sk share the surveyed 63 u / 18 m kerb-to-kerb width.
   The widened south arm takes its extra room from the open park edge; the
   east apartment/yellow-building line stays fixed at x 580. */
var CELL = 4;                            /* grid cell = 4 u = 1.1429 m         */
var XW = 484, XE = 580;                  /* west/east street-envelope limits    */
var NORTH_XW = XW;
var ROAD0 = 500.5, ROAD1 = 563.5;        /* carriageway, 63 u = 18.000 m       */
var NORTH_ROAD0 = ROAD0, NORTH_ROAD1 = ROAD1;
var KERB_W = 1.0;                        /* 286 mm, matching nz-street-ground  */
var ROAD_TOP = 0.12;                     /* road deck top (box y -0.18..0.12)  */
var PAVE_TOP = 0.62;                     /* footway deck top (box y 0.28..0.62)*/
var KERB_TOP = 0.66;                     /* kerb stands 0.04 proud of paving   */
var PROUD = 0.02;                        /* skins stand this far into the street*/

/* nz-street.js's own storey stack, so a corner where the two meet cannot step */
var GH = 11.2, FH = 10.15, EAVES = 51.8;
function fy(i) { return i === 0 ? 0 : GH + (i - 1) * FH; }
/* fy = 0 / 11.2 / 21.35 / 31.5 / 41.65 / 51.8 / 61.95 */

/* MASS BELOW y = 21.0 FILLS ROOMS THE PLAYER STANDS IN.  Both flanks are
   carved: KIZILCALAR's lobby and bakkal, its upper flat and loggia and its
   lift shaft, A-BLOK's corridors and flats, B-BLOK's rooms, DEGERLI's lobby
   and garage, DOYUM EKMEK's bake hall.  The highest carved ceiling anywhere
   behind these elevations is rUpper/rLoggia/rShaft at 21.0, so 21.0 is the
   one universally safe floor for deep mass. */
var MASS_Y0 = 21.0;
var GC = 11.2;                           /* rFlat/rHall/rCorr/rShop/rGarage    */
var UC = 21.0;                           /* rUpper/rLoggia/rShaft              */

var REV = 1.10;                          /* upper-storey reveal, 31 cm         */
var REV_G = 0.72;                        /* ground-storey reveal               */
var PLINTH_D = 0.52;                     /* plinth projection                  */
var PLINTH_TOP = 5.075;                  /* m(1.45)                            */
var ROOF_DEEP = 45.5;                    /* m(13.0), the depth nz-street gives  */
var EAVE_OUT = 2.1;                      /* m(0.60) eave overhang              */
var HIP_RISE = 11.2;                     /* m(3.2)                             */

/* The arms.  The north road is playable down to row 1 and the occupied row 0
   opens onto scenery.  The matching south arm stays playable through row 125;
   its police line is row 126 and the visible continuation reaches row 127. */
var ARM_N = { z0: 4, z1: 144, lineZ: 2, viewZ0: 0, dir: -1 };
var ARM_S = { z0: 212, z1: 504, lineZ: 506, viewZ1: 512, dir: 1 };
var CROSS_X0 = 760, CROSS_X1 = 792;      /* the 230 Sk stub building lines     */
var GATE_X = 832;                        /* where the checkpoint is AUTHORED   */
/* the east police line's plane.  It is no longer a checkpoint -- see
   buildCordon() -- but it is still the plane every piece of its furniture is
   set out from, and the barricade run stands 1.6 u in front of it so the
   panel is not coplanar with buildWorld's own wall. */
var CLOSURE_EAST_X = 832;

/* ===========================================================================
   SECTION 2  PILE + GEOMETRY PRIMITIVES
   ===========================================================================
   One pile per material; every builder writes triangles into a pile and the
   whole pile becomes one indexed BufferGeometry at the end.  Positions are
   world units, uv is planar in world units divided by the pile's tile except
   where an emitter writes explicit uv, and tone is a per-vertex LINEAR colour.

   Three things every emitter carries that the old pile did not:
     an INDEX buffer (a box is 24 verts, not 36 - and the bake's ray budget is
       26e6 / (verts x (1 + boxes*0.45)), so 50% more verts is 33% fewer rays);
     an `ao` term that multiplies the tone, plus an automatic down-face
       darkening, so a soffit and the wall beside it are not the same value;
     a world-space MACRO field, because a 3 m tile that carries metres-wide
       blotches repeats them every 3 m.
   ======================================================================== */

/* 0.30 on a poly face, whose normal is constant across the face.  The tube,
   cone and dome paths interpolate their normals per vertex, so the same term
   lands at roughly 0.34 across a ring - which is the number the brief quotes
   and the reason there is only one constant here. */
var DOWN_AO = 0.30;
var ONE = [1, 1, 1];

function vhash(i, j) {
  var s = Math.sin(i * 127.1 + j * 311.7 + SEED * 0.00017) * 43758.5453123;
  return s - Math.floor(s);
}
function vnoise(x, z, wl) {
  var fx = x / wl, fz = z / wl;
  var i0 = Math.floor(fx), j0 = Math.floor(fz);
  var tx = fx - i0, tz = fz - j0;
  var sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  return lerp(lerp(vhash(i0, j0), vhash(i0 + 1, j0), sx),
              lerp(vhash(i0, j0 + 1), vhash(i0 + 1, j0 + 1), sx), sz);
}
/* the macro half of the grime story, positional and therefore untileable:
   two wavelengths, 17.0 u (4.9 m) and 5.9 u (1.7 m), at 0.62/0.38 */
function macro(x, z, amt) {
  if (!(amt > 0)) return 1;
  var n = vnoise(x, z, 17.0) * 0.62 + vnoise(x + 91.3, z - 47.7, 5.9) * 0.38;
  return 1 + (n - 0.5) * 0.13 * amt;
}

function Pile(name, tile, macroAmt) {
  this.name = name;
  this.tile = tile || 8;
  this.inv = 1 / (tile || 8);
  this.macro = macroAmt === undefined ? 0 : macroAmt;
  this.p = []; this.nm = []; this.uv = []; this.tone = []; this.idx = []; this.n = 0;
}
/* the only vertex emitter.  `tone` may be [r,g,b] OR function(point, ny) -
   every gradient in the module (ground-line soiling, coping grime, a fade up
   a wall) is done with that callback and no second material. */
Pile.prototype.vert = function (x, y, z, nx, ny, nz, u, v, ao, tone) {
  var t = (typeof tone === 'function') ? tone([x, y, z], ny) : tone;
  if (!t || t.length !== 3) t = ONE;
  var sh = (ao === undefined || ao === null ? 1 : ao) * (1 - DOWN_AO * clamp(-ny, 0, 1));
  if (this.macro) sh *= macro(x, z, this.macro);
  this.p.push(fin(x), fin(y), fin(z));
  this.nm.push(fin(nx), fin(ny, 1), fin(nz));
  this.uv.push(fin(u), fin(v));
  this.tone.push(fin(t[0] * sh, 0.5), fin(t[1] * sh, 0.5), fin(t[2] * sh, 0.5));
  return this.n++;
};
Pile.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
Pile.prototype.empty = function () { return this.n === 0; };
Pile.prototype.geometry = function () {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nm, 3));
  var uv = new THREE.Float32BufferAttribute(this.uv, 2);
  g.setAttribute('uv', uv);
  g.setAttribute('uv2', uv);            /* r149's aoMap samples uv2, not uv */
  g.setIndex(this.idx);
  g.computeBoundingSphere();
  if (g.boundingSphere && !isFinite(g.boundingSphere.radius)) g.boundingSphere = null;
  OWN.geo.push(g);
  return g;
};

/* poly(pile, pts, ref, ao, tone)
   `ref` is any point demonstrably INSIDE the solid; it is what lets 26 facets
   of a chamfered box wind outward without anybody tracking orientation.  The
   normal is Newell and ALWAYS NORMALISED - the old hipRoof handed its hips
   (1, 0.5, 0), length 1.118, and every hip in the module came back 11.8%
   over-bright with a seam down both sides. */
function poly(pile, pts, ref, ao, tone) {
  var n = pts.length, i;
  if (n < 3) return;
  var cx = 0, cy = 0, cz = 0;
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
  if (!(len > 1e-9)) return;                       /* degenerate: drop it */
  nx /= len; ny /= len; nz /= len;
  var rx = ref ? ref[0] : cx, ry = ref ? ref[1] : cy - 1, rz = ref ? ref[2] : cz;
  var flip = (nx * (cx - rx) + ny * (cy - ry) + nz * (cz - rz)) < 0;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  var ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  var mode = (ay >= ax && ay >= az) ? 1 : (ax >= az ? 0 : 2);
  var t = pile.inv, base = pile.n, k;
  for (i = 0; i < n; i++) {
    var p = pts[i], u, v;
    if (mode === 1) { u = p[0] * t; v = p[2] * t; }
    else if (mode === 0) { u = p[2] * t; v = p[1] * t; }
    else { u = p[0] * t; v = p[1] * t; }
    pile.vert(p[0], p[1], p[2], nx, ny, nz, u, v, ao, tone);
  }
  for (k = 1; k < n - 1; k++) {
    if (flip) pile.tri(base, base + k + 1, base + k);
    else pile.tri(base, base + k, base + k + 1);
  }
}

/* plain 6-face box, 24 verts / 12 tris, for the hundred small members where a
   chamfer would be sub-pixel anyway */
function box6(pile, x0, x1, y0, y1, z0, z1, ao, tone) {
  var s;
  if (x1 < x0) { s = x0; x0 = x1; x1 = s; }
  if (y1 < y0) { s = y0; y0 = y1; y1 = s; }
  if (z1 < z0) { s = z0; z0 = z1; z1 = s; }
  var r = [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5];
  poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], r, ao, tone);
  poly(pile, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], r, ao, tone);
  poly(pile, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], r, ao, tone);
  poly(pile, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], r, ao, tone);
  poly(pile, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], r, ao, tone);
  poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], r, ao, tone);
}

/* chamfered box, 96 verts / 44 tris.  A pure 90-degree arris is the number one
   tell of a prototype, so the plinth, the cornice, the kerb, the gate cap,
   every coping and every nosing gets one.  k is clamped to 0.49 of the
   smallest half-extent and a k of zero falls back to box6. */
function boxC(pile, cx, cy, cz, hx, hy, hz, k, ao, tone) {
  hx = Math.abs(hx); hy = Math.abs(hy); hz = Math.abs(hz);
  k = Math.min(k, hx * 0.49, hy * 0.49, hz * 0.49);
  if (!(k > 0.0005)) {
    box6(pile, cx - hx, cx + hx, cy - hy, cy + hy, cz - hz, cz + hz, ao, tone);
    return;
  }
  var h = [hx, hy, hz], c = [cx, cy, cz];
  function PT3(axis, s0, s1, s2) {
    var s = [s0, s1, s2], o = [0, 0, 0], i;
    for (i = 0; i < 3; i++) o[i] = c[i] + s[i] * (i === axis ? h[i] : h[i] - k);
    return o;
  }
  var S = [-1, 1], i, j, l, ref = [cx, cy, cz];
  for (i = 0; i < 3; i++) for (j = 0; j < 2; j++) {
    var s = S[j], a1 = (i + 1) % 3, a2 = (i + 2) % 3;
    var q = [], sg = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (l = 0; l < 4; l++) {
      var sv = [0, 0, 0]; sv[i] = s; sv[a1] = sg[l][0]; sv[a2] = sg[l][1];
      q.push(PT3(i, sv[0], sv[1], sv[2]));
    }
    poly(pile, q, ref, ao, tone);
  }
  for (i = 0; i < 3; i++) for (j = i + 1; j < 3; j++) {
    var ax3 = 3 - i - j, si, sj;
    for (si = 0; si < 2; si++) for (sj = 0; sj < 2; sj++) {
      var s1 = S[si], s2 = S[sj], q2 = [];
      var vA = [0, 0, 0], vB = [0, 0, 0];
      vA[i] = s1; vA[j] = s2; vA[ax3] = -1;
      vB[i] = s1; vB[j] = s2; vB[ax3] = 1;
      q2.push(PT3(i, vA[0], vA[1], vA[2]));
      q2.push(PT3(i, vB[0], vB[1], vB[2]));
      q2.push(PT3(j, vB[0], vB[1], vB[2]));
      q2.push(PT3(j, vA[0], vA[1], vA[2]));
      poly(pile, q2, ref, ao, tone);
    }
  }
  var a, b, cq;
  for (a = 0; a < 2; a++) for (b = 0; b < 2; b++) for (cq = 0; cq < 2; cq++) {
    var t0 = S[a], t1 = S[b], t2 = S[cq];
    poly(pile, [PT3(0, t0, t1, t2), PT3(1, t0, t1, t2), PT3(2, t0, t1, t2)], ref, ao, tone);
  }
}

/* a horizontal slab whose top is at y.  The four cheeks are what stop it
   reading as paper when you stand beside it. */
function deck(pile, x0, z0, x1, z1, y, th, ao, tone) {
  box6(pile, x0, x1, y - th, y, z0, z1, ao, tone);
}

/* one vertical panel on a constant-x plane; dir = -1 faces -x, +1 faces +x */
function panelX(pile, x, y0, y1, z0, z1, dir, ao, tone) {
  poly(pile, [[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]],
       [x - (dir < 0 ? -1 : 1), (y0 + y1) * 0.5, (z0 + z1) * 0.5], ao, tone);
}
function panelZ(pile, z, y0, y1, x0, x1, dir, ao, tone) {
  poly(pile, [[x0, y0, z], [x0, y1, z], [x1, y1, z], [x1, y0, z]],
       [(x0 + x1) * 0.5, (y0 + y1) * 0.5, z - (dir < 0 ? -1 : 1)], ao, tone);
}

/* tube(pile, a, b, r, seg, tone, caps, cyl)
   PASS cyl:true FOR ANY TUBE WITH r > 0.6.  The planar projector picks its
   axis from the dominant component of the normal, which on a vertical cylinder
   switches every 45 degrees: four 0.67 m texture discontinuities ran up the
   full 26 m of each minaret shaft in the build this replaces.  The cyl path
   writes u = ringIndex/seg * 2*PI*r / tile and v = distance along the axis /
   tile, with smooth radial normals. */
function tube(pile, a, b, r, seg, tone, caps, cyl) {
  seg = seg || 8;
  var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-4) || !(r > 1e-5)) return;
  dx /= len; dy /= len; dz /= len;
  var hx = Math.abs(dy) > 0.92 ? 1 : 0, hy = Math.abs(dy) > 0.92 ? 0 : 1, hz = 0;
  var ux = dy * hz - dz * hy, uy = dz * hx - dx * hz, uz = dx * hy - dy * hx;
  var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  var vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  var i, ring0 = [], ring1 = [], TAU = Math.PI * 2;
  for (i = 0; i < seg; i++) {
    var q = i / seg * TAU, cq = Math.cos(q) * r, sq = Math.sin(q) * r;
    ring0.push([a[0] + ux * cq + vx * sq, a[1] + uy * cq + vy * sq, a[2] + uz * cq + vz * sq]);
    ring1.push([b[0] + ux * cq + vx * sq, b[1] + uy * cq + vy * sq, b[2] + uz * cq + vz * sq]);
  }
  var ref = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
  if (!cyl) {
    for (i = 0; i < seg; i++)
      poly(pile, [ring0[i], ring0[(i + 1) % seg], ring1[(i + 1) % seg], ring1[i]], ref, 1, tone);
  } else {
    var circ = TAU * r * pile.inv, vlen = len * pile.inv, base = pile.n;
    for (i = 0; i <= seg; i++) {
      var k = i % seg, q2 = i / seg * TAU;
      var nx = ux * Math.cos(q2) + vx * Math.sin(q2);
      var ny = uy * Math.cos(q2) + vy * Math.sin(q2);
      var nz = uz * Math.cos(q2) + vz * Math.sin(q2);
      var p0 = ring0[k], p1 = ring1[k];
      pile.vert(p0[0], p0[1], p0[2], nx, ny, nz, i / seg * circ, 0, 1, tone);
      pile.vert(p1[0], p1[1], p1[2], nx, ny, nz, i / seg * circ, vlen, 1, tone);
    }
    for (i = 0; i < seg; i++) {
      var o = base + i * 2;
      pile.tri(o, o + 2, o + 3); pile.tri(o, o + 3, o + 1);
    }
  }
  /* the caps go through the planar projector even on the cyl path: a cap is
     an end disc, it is buried against whatever the tube stands on in every
     case in this module, and a radial uv for it would cost a second frame */
  if (caps) { poly(pile, ring0, ref, 0.86, tone); poly(pile, ring1, ref, 0.86, tone); }
}

/* cone(pile, cx, cz, y0, y1, r, seg, tone, cap)
   WITH a base cap.  Every cone in the build this replaces is an open shell you
   look up into from below - which is exactly the view a player has of a
   minaret's kulah from the street. */
function cone(pile, cx, cz, y0, y1, r, seg, tone, cap) {
  seg = seg || 10;
  var i, ring = [], TAU = Math.PI * 2, ref = [cx, (y0 + y1) * 0.5, cz];
  for (i = 0; i < seg; i++) {
    var q = i / seg * TAU;
    ring.push([cx + Math.cos(q) * r, y0, cz + Math.sin(q) * r]);
  }
  var apex = [cx, y1, cz];
  for (i = 0; i < seg; i++) poly(pile, [ring[i], ring[(i + 1) % seg], apex], ref, 1, tone);
  if (cap !== false) poly(pile, ring, ref, 0.80, tone);
}

function dome(pile, cx, cz, y0, r, h, seg, rings, tone) {
  seg = seg || 12; rings = rings || 5;
  var i, j, TAU = Math.PI * 2, ref = [cx, y0 - r * 0.2, cz];
  for (j = 0; j < rings; j++) {
    var t0 = j / rings, t1 = (j + 1) / rings;
    var r0 = r * Math.cos(t0 * Math.PI * 0.5), r1 = r * Math.cos(t1 * Math.PI * 0.5);
    var h0 = y0 + h * Math.sin(t0 * Math.PI * 0.5), h1 = y0 + h * Math.sin(t1 * Math.PI * 0.5);
    for (i = 0; i < seg; i++) {
      var a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU;
      if (r1 < 1e-4) {
        poly(pile, [[cx + Math.cos(a0) * r0, h0, cz + Math.sin(a0) * r0],
                    [cx + Math.cos(a1) * r0, h0, cz + Math.sin(a1) * r0],
                    [cx, h1, cz]], ref, 1, tone);
      } else {
        poly(pile, [[cx + Math.cos(a0) * r0, h0, cz + Math.sin(a0) * r0],
                    [cx + Math.cos(a1) * r0, h0, cz + Math.sin(a1) * r0],
                    [cx + Math.cos(a1) * r1, h1, cz + Math.sin(a1) * r1],
                    [cx + Math.cos(a0) * r1, h1, cz + Math.sin(a0) * r1]], ref, 1, tone);
      }
    }
  }
}

/* hipRoof(pile, x0, x1, z0, z1, eave, rise, tone)
   THE TILE SURFACE ONLY, over exactly the rectangle given - the overhang is
   already in the caller's numbers (KIZILCALAR is z 55.4..96.6 for a run of
   56..96).  The fascia board, the soffit slab and the rafter ends belong to
   the caller, because a roof that draws its own soffit cannot be given the
   near-black underside the photographs show.
   Both hips are TRIANGLES with a computed, normalised normal. */
function hipRoof(pile, x0, x1, z0, z1, eave, rise, tone) {
  if (x1 < x0) { var sx = x0; x0 = x1; x1 = sx; }
  if (z1 < z0) { var sz = z0; z0 = z1; z1 = sz; }
  var dx = x1 - x0, dz = z1 - z0, yt = eave + rise;
  var ref = [(x0 + x1) * 0.5, eave - Math.max(2, rise), (z0 + z1) * 0.5];
  if (dx >= dz) {
    var ins = dz * 0.5, rx0 = x0 + ins, rx1 = x1 - ins, zc = (z0 + z1) * 0.5;
    if (rx1 - rx0 < 0.02) { rx0 = rx1 = (x0 + x1) * 0.5; }
    if (rx1 - rx0 < 0.02) {
      poly(pile, [[x0, eave, z1], [x1, eave, z1], [rx0, yt, zc]], ref, 1, tone);
      poly(pile, [[x1, eave, z0], [x0, eave, z0], [rx0, yt, zc]], ref, 1, tone);
    } else {
      poly(pile, [[x0, eave, z1], [x1, eave, z1], [rx1, yt, zc], [rx0, yt, zc]], ref, 1, tone);
      poly(pile, [[x1, eave, z0], [x0, eave, z0], [rx0, yt, zc], [rx1, yt, zc]], ref, 1, tone);
    }
    poly(pile, [[x1, eave, z1], [x1, eave, z0], [rx1, yt, zc]], ref, 1, tone);
    poly(pile, [[x0, eave, z0], [x0, eave, z1], [rx0, yt, zc]], ref, 1, tone);
  } else {
    var ins2 = dx * 0.5, rz0 = z0 + ins2, rz1 = z1 - ins2, xc = (x0 + x1) * 0.5;
    if (rz1 - rz0 < 0.02) { rz0 = rz1 = (z0 + z1) * 0.5; }
    if (rz1 - rz0 < 0.02) {
      poly(pile, [[x1, eave, z0], [x1, eave, z1], [xc, yt, rz0]], ref, 1, tone);
      poly(pile, [[x0, eave, z1], [x0, eave, z0], [xc, yt, rz0]], ref, 1, tone);
    } else {
      poly(pile, [[x1, eave, z0], [x1, eave, z1], [xc, yt, rz1], [xc, yt, rz0]], ref, 1, tone);
      poly(pile, [[x0, eave, z1], [x0, eave, z0], [xc, yt, rz0], [xc, yt, rz1]], ref, 1, tone);
    }
    poly(pile, [[x1, eave, z1], [x0, eave, z1], [xc, yt, rz1]], ref, 1, tone);
    poly(pile, [[x0, eave, z0], [x1, eave, z0], [xc, yt, rz0]], ref, 1, tone);
  }
}

/* gableRoof: two slopes and two gable triangles, ridge along the longer side.
   Same contract as hipRoof - surface only, no soffit. */
function gableRoof(pile, x0, x1, z0, z1, eave, rise, tone) {
  if (x1 < x0) { var sx = x0; x0 = x1; x1 = sx; }
  if (z1 < z0) { var sz = z0; z0 = z1; z1 = sz; }
  var yt = eave + rise, ref = [(x0 + x1) * 0.5, eave - Math.max(2, rise), (z0 + z1) * 0.5];
  if (x1 - x0 >= z1 - z0) {
    var zc = (z0 + z1) * 0.5;
    poly(pile, [[x0, eave, z1], [x1, eave, z1], [x1, yt, zc], [x0, yt, zc]], ref, 1, tone);
    poly(pile, [[x1, eave, z0], [x0, eave, z0], [x0, yt, zc], [x1, yt, zc]], ref, 1, tone);
    poly(pile, [[x1, eave, z1], [x1, eave, z0], [x1, yt, zc]], ref, 1, tone);
    poly(pile, [[x0, eave, z0], [x0, eave, z1], [x0, yt, zc]], ref, 1, tone);
  } else {
    var xc = (x0 + x1) * 0.5;
    poly(pile, [[x1, eave, z0], [x1, eave, z1], [xc, yt, z1], [xc, yt, z0]], ref, 1, tone);
    poly(pile, [[x0, eave, z1], [x0, eave, z0], [xc, yt, z0], [xc, yt, z1]], ref, 1, tone);
    poly(pile, [[x0, eave, z0], [x1, eave, z0], [xc, yt, z0]], ref, 1, tone);
    poly(pile, [[x1, eave, z1], [x0, eave, z1], [xc, yt, z1]], ref, 1, tone);
  }
}

/* sweep(pile, profile, a, b, tone)
   Sweeps a CLOSED 2-D section along the line a -> b; end caps are automatic
   and THERE IS NO REAR QUAD, which is the whole point: every proud element on
   these walls (plinth, storey band, floor bands, cornice, fascia, stallboard,
   cill) started exactly ON the wall plane in the build this replaces, so 66
   rear quads were coplanar with the wall down the full length of eleven runs.

   The profile is [[out, up], ...] in world units measured FROM the line, and
   the +out axis is up x (b-a): to the LEFT of the direction of travel.  So a
   west-flank wall at x = 548.02 facing +x is swept z0 -> z1 (out = +x), and an
   east-flank wall at x = 579.98 facing -x is swept z1 -> z0 (out = -x).  Get
   it backwards and the moulding is inside the building. */
function sweep(pile, prof, a, b, tone) {
  if (!prof || prof.length < 2) return;
  var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0.05)) return;
  dx /= len; dy /= len; dz /= len;
  var ox = dz, oz = -dx, ol = Math.sqrt(ox * ox + oz * oz);
  if (!(ol > 1e-6)) { warn('sweep: vertical run has no out axis'); return; }
  ox /= ol; oz /= ol;
  var i, A = [], B = [];
  for (i = 0; i < prof.length; i++) {
    A.push([a[0] + ox * prof[i][0], a[1] + prof[i][1], a[2] + oz * prof[i][0]]);
    B.push([b[0] + ox * prof[i][0], b[1] + prof[i][1], b[2] + oz * prof[i][0]]);
  }
  var mid = (prof[0][1] + prof[prof.length - 1][1]) * 0.5;
  /* 0.6 BEHIND the section: the solid is closed by the wall the section sits
     on, so a point inside the wall is the reference that winds it outward */
  var ref = [(a[0] + b[0]) * 0.5 - ox * 0.6, (a[1] + b[1]) * 0.5 + mid,
             (a[2] + b[2]) * 0.5 - oz * 0.6];
  for (i = 0; i < prof.length - 1; i++)
    poly(pile, [A[i], B[i], B[i + 1], A[i + 1]], ref, 1, tone);
  poly(pile, A, ref, 0.86, tone);
  poly(pile, B, ref, 0.86, tone);
}

/* ---- the shared occluder registry -------------------------------------
   nz-street-sky.js:1583 SILENTLY DISCARDS any box over 26 u on any axis and
   REG_CAP 220 is shared by all five street modules, so chop everything and
   stay under 45 boxes.  Two more rules, both learned the hard way:
     an occluder box must sit UNDER the geometry it belongs to, NEVER around
     it - hitsBoxT exempts only a ray origin STRICTLY inside a box, so a vertex
     exactly on the boundary is fully blocked and nz-street-park's first render
     came back with both shelter roofs as solid black slabs;
     never register a whole-building mass - the analytic canyon test already
     accounts for it and replaying it darkens the street twice. */
var OCC = [];
var OCC_CAP = 45;
function occ(x0, y0, z0, x1, y1, z1) {
  if (!(isFinite(x0) && isFinite(y0) && isFinite(z0) && isFinite(x1) && isFinite(y1) && isFinite(z1))) {
    warn('occluder dropped, not finite'); return;
  }
  if (!(x1 > x0 && y1 > y0 && z1 > z0)) { warn('occluder dropped, inverted or flat'); return; }
  if (x1 - x0 > 26 || y1 - y0 > 26 || z1 - z0 > 26) {
    warn('occluder dropped, over 26 u: ' + [x0, y0, z0, x1, y1, z1].join(',')); return;
  }
  if (OCC.length >= OCC_CAP) { warn('occluder budget spent at ' + OCC_CAP); return; }
  OCC.push({ x0: x0, x1: x1, y0: y0, y1: y1, z0: z0, z1: z1 });
  STATS.occluders = OCC.length;
}

/* ---- tone helpers -----------------------------------------------------
   Both return a CALLBACK, so the gradient costs no second material and no
   second draw call, and it interpolates across a face instead of stepping. */
function upTone(base) {
  return function (pt, ny) {
    return mix(base, UPGRIME, Math.pow(clamp(ny, 0, 1), 1.5) * 0.55);
  };
}
/* the first 420 mm of every wall is 32% darker: rain splash off the pavement,
   and it is on every facade in the reference frames.  span 1.47 (420 mm) on a
   wall, 1.05 (300 mm) on a low wall. */
function groundTone(base, y0, span) {
  var sp = span || 1.47;
  return function (pt) {
    var k = 0.68 + 0.32 * clamp((pt[1] - y0) / sp, 0, 1);
    return [base[0] * k, base[1] * k, base[2] * k];
  };
}

/* ---- WEATHERING: the wall's own tone, as a function of where you are on it
   ---------------------------------------------------------------------
   groundTone() gives the wall ONE colour plus a splash band at its foot, and
   under an overcast sky that was enough, because the sky itself supplied all
   the value variation a facade had.  Under a raking sun the sky's contribution
   collapses to a slow gradient and the wall becomes what it really is: forty
   metres of one flat number.  That is the "untextured plane" read, and no map
   can fix it -- the maps here are near-white RELIEF by contract and tinting
   one squares the hue.  It has to arrive as tone.

   Three terms, all pure functions of the world point, so adjacent quads that
   share a corner get the same answer and the wall has no seams:

     1. the splash band, exactly as groundTone() had it;
     2. a WEATHER GRADIENT.  The head of a rendered wall is rain-washed and
        sun-bleached: it goes PALER and loses chroma.  The sheltered lower
        storeys keep the paint.  b runs 0 at first-floor level to 1 at the
        eaves and buys +5 % of value and -20 % of chroma across that span,
        which is about what sixteen years does to a lime render;
     3. PATCHINESS at two scales -- a 20-unit drift for differential bleaching
        and a 6-unit one for old repairs and re-renders.  +-6 % and +-3 % of
        value, which is under the eye's threshold on any single quad and
        entirely visible over a whole elevation.

   Amplitudes are on VALUE and CHROMA separately and never on hue: a wall that
   drifts in hue reads as a lighting bug, one that drifts in value reads as a
   wall.  The x of the face is folded into the noise phase so the two sides of
   a street never get the same pattern at the same z. */
function wvn(x) {
  var i0 = Math.floor(x), f = x - i0;
  return lerp(hash(i0 * 1.37 + 9.1), hash((i0 + 1) * 1.37 + 9.1), f * f * (3 - 2 * f));
}
function wvn2(x, y) {
  var j0 = Math.floor(y), f = y - j0;
  return lerp(wvn(x + j0 * 17.7), wvn(x + (j0 + 1) * 17.7), f * f * (3 - 2 * f));
}
function weatherTone(base, top, face) {
  var ph = (face || 0) * 0.0137;
  var ev = Math.max(top || 51.8, 24);
  var Y = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2];
  return function (pt) {
    var y = pt[1], z = pt[2];
    var k = 0.68 + 0.32 * clamp(y / 1.47, 0, 1);
    var b = clamp((y - ev * 0.28) / (ev * 0.68), 0, 1);
    /* THE PATCHINESS IS A FUNCTION OF z ALONE, AND THAT IS NOT A SIMPLIFICATION
       -- it is the only form that cannot seam.  The wall is emitted as strips
       around the openings, each strip is sampled at its FOUR CORNERS and
       Gouraud-interpolated, and neighbouring strips do NOT share their y
       splits: the field above a window is one quad from head to soffit while
       the field beside it is cut at every cill and head on that bay.  Any
       term that varies in y is therefore interpolated along two different
       chords on the two sides of a shared vertical edge, and the mismatch
       shows up as exactly what a first cut at (z,y) noise produced -- a
       rectangle of slightly different render sitting over each window, with
       hard edges on the quad boundaries.  A term in z alone is piecewise
       linear in z and identical on both sides of every edge it crosses, so it
       is continuous everywhere by construction.  It also happens to be the
       truthful pattern: differential bleaching on a rendered block runs in
       vertical bands, bay by bay, because that is how the scaffold lifts and
       the repainting went.  The smooth head-to-foot terms (splash and
       weather) stay in y, where they are continuous for the same reason. */
    var p = wvn2(z * 0.030 + ph, ph) * 2 - 1;
    var q = wvn2(z * 0.082 + ph + 31.4, ph + 3.1) * 2 - 1;
    var v = k * (1 + 0.048 * p + 0.024 * q + 0.050 * b);
    var c = 1 - 0.20 * b + 0.05 * p;
    return [(Y + (base[0] - Y) * c) * v,
            (Y + (base[1] - Y) * c) * v,
            (Y + (base[2] - Y) * c) * v];
  };
}

/* ===========================================================================
   SECTION 3  TEXTURES, ATLASES, MATERIALS
   ===========================================================================
   EVERY map here is a near-WHITE, near-NEUTRAL RELIEF layer.  The colour of a
   wall is its vertex tone; a coloured map multiplied by a coloured tone
   squares the hue and lands every facade in mud, which is the one mistake this
   palette cannot survive.
   ======================================================================== */

var FONT = '"Arial Narrow",Arial,Helvetica,sans-serif';

function cv(w, h) {
  var c = global.document.createElement('canvas');
  c.width = w; c.height = h === undefined ? w : h;
  STATS.textureBytes += c.width * c.height * 4;
  return c;
}
function mkTex(canvas, clampEdge, linear) {
  var t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = clampEdge ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.anisotropy = MAX_ANISO;
  t.encoding = linear ? THREE.LinearEncoding : THREE.sRGBEncoding;
  t.needsUpdate = true;
  OWN.tex.push(t);
  return t;
}

/* a cheap Sobel normal from an albedo canvas.  24 lines, no dependencies, and
   it is the difference between render that has tooth and render that is a flat
   beige plane at every distance. */
function normalTex(src, strength) {
  var w = src.width, h = src.height;
  var sg = src.getContext('2d').getImageData(0, 0, w, h).data;
  var out = cv(w, h), og = out.getContext('2d');
  var img = og.createImageData(w, h), d = img.data, x, y;
  function lum(px, py) {
    var i = (((py + h) % h) * w + ((px + w) % w)) * 4;
    return (sg[i] * 0.299 + sg[i + 1] * 0.587 + sg[i + 2] * 0.114) / 255;
  }
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    var gx = (lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1)) -
             (lum(x - 1, y - 1) + 2 * lum(x - 1, y) + lum(x - 1, y + 1));
    var gy = (lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1)) -
             (lum(x - 1, y - 1) + 2 * lum(x, y - 1) + lum(x + 1, y - 1));
    var nx = -gx * strength, ny = -gy * strength, nz = 1;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    var k = (y * w + x) * 4;
    d[k] = (nx / l * 0.5 + 0.5) * 255;
    d[k + 1] = (ny / l * 0.5 + 0.5) * 255;
    d[k + 2] = (nz / l * 0.5 + 0.5) * 255;
    d[k + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  return out;
}

function asphaltTex() {
  var c = cv(256), g = c.getContext('2d'), i;
  g.fillStyle = '#e7e8e6'; g.fillRect(0, 0, 256, 256);
  for (i = 0; i < 1600; i++) {                       /* aggregate, not dirt */
    var v = (55 + hash(i * 3.1) * 70) | 0;
    g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + (0.04 + hash(i * 7.7 + 1) * 0.12).toFixed(3) + ')';
    g.fillRect(hash(i * 2.3 + 2) * 256, hash(i * 5.1 + 3) * 256,
               0.4 + hash(i * 1.9 + 4) * 1.4, 0.4 + hash(i * 4.7 + 5) * 1.4);
  }
  for (i = 0; i < 2; i++) {                          /* tar seams */
    var y = 64 + i * 128 + hash(i * 13.7 + 21) * 24;
    g.strokeStyle = 'rgba(30,32,32,0.15)'; g.lineWidth = 0.75;
    g.beginPath(); g.moveTo(0, y);
    g.bezierCurveTo(77, y + hash(i + 24) * 30 - 15, 179, y + hash(i + 25) * 30 - 15, 256, y);
    g.stroke();
  }
  return c;
}
function paverTex() {
  /* kilit tasi: 24 x 12 px on a 12-px running bond, which at tile 8.2 is
     220 x 110 mm - the real unit.  At the old 128/tile 7 it was 0.34 m and
     read as brickwork. */
  var c = cv(256), g = c.getContext('2d'), x, y, row = 0;
  g.fillStyle = '#ede9e4'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(76,57,49,0.38)'; g.lineWidth = 1;
  for (y = 0; y < 256; y += 12) {
    var off = (row % 2) ? 12 : 0; row++;
    for (x = -24; x < 256; x += 24) {
      var v = (hash(x * 0.13 + y) * 22) | 0;
      g.fillStyle = 'rgba(' + (222 - v) + ',' + (218 - v) + ',' + (212 - v) + ',0.45)';
      g.fillRect(x + off + 0.5, y + 0.5, 23, 11);
      g.strokeRect(x + off + 0.5, y + 0.5, 23, 11);
    }
  }
  for (x = 0; x < 300; x++) {                        /* dirt in the joints */
    g.fillStyle = 'rgba(70,45,35,' + (0.015 + hash(x * 3.3 + 9) * 0.055).toFixed(3) + ')';
    g.fillRect(hash(x * 1.7 + 10) * 256, hash(x * 2.9 + 11) * 256, 2, 2);
  }
  return c;
}
function renderTex() {
  /* SALT AND PEPPER ONLY.  The map this replaces put 240 specks over 65,536
     texels - 0.37% coverage - and read as polished granite from ten metres. */
  var c = cv(256), g = c.getContext('2d'), i;
  g.fillStyle = '#f0efe9'; g.fillRect(0, 0, 256, 256);
  for (i = 0; i < 1400; i++) {
    var a = (0.015 + hash(i * 5.3 + 2) * 0.075).toFixed(3);
    g.fillStyle = (i & 1) ? 'rgba(60,54,45,' + a + ')' : 'rgba(255,250,245,' + a + ')';
    g.fillRect((hash(i * 3.1) * 256) | 0, (hash(i * 7.7 + 1) * 256) | 0, 1, 1);
  }
  for (i = 0; i < 26; i++) {                         /* float marks */
    g.strokeStyle = 'rgba(96,88,78,' + (0.012 + hash(i * 4.4 + 6) * 0.03).toFixed(3) + ')';
    g.lineWidth = 0.6 + hash(i * 6.6 + 7) * 1.4;
    var sy = hash(i * 11.3 + 5) * 256;
    g.beginPath(); g.moveTo(0, sy); g.lineTo(256, sy + hash(i * 2.2 + 8) * 26 - 13); g.stroke();
  }
  return c;
}
function stoneTex() {
  /* travertine WITH COURSES.  At tile 7 the 22-px course lands a transverse
     joint every 1.20 u and a longitudinal every 1.97 u, which is the Turkish
     precast bordur almost exactly - and it is why kerbs go on P.stone. */
  var c = cv(256), g = c.getContext('2d'), x, y, i, row = 0;
  g.fillStyle = '#ece9e4'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(68,57,49,0.42)'; g.lineWidth = 2;
  for (y = 0; y <= 256; y += 22) {
    g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(256, y + 0.5); g.stroke();
    var off = (row % 2) ? 18 : 0; row++;
    for (x = off; x < 256; x += 36) {
      g.beginPath(); g.moveTo(x + 0.5, y + 0.5); g.lineTo(x + 0.5, y + 22.5); g.stroke();
    }
  }
  for (i = 0; i < 480; i++) {
    g.fillStyle = 'rgba(80,64,52,' + (0.02 + hash(i * 2.7 + 3) * 0.08).toFixed(3) + ')';
    g.fillRect(hash(i * 1.3) * 256, hash(i * 3.9 + 1) * 256, 1 + hash(i * 5.5 + 2) * 3, 1);
  }
  return c;
}
function brickTex() {
  /* 8 courses x 4 stretchers per tile: at tile 9 that is a 119 mm course and a
     238 mm stretcher, a real Turkish tugla. */
  var c = cv(256), g = c.getContext('2d'), i, j;
  g.fillStyle = '#efe7dd'; g.fillRect(0, 0, 256, 256);
  var ch = 32, sw = 64;
  for (j = 0; j < 8; j++) for (i = -1; i < 4; i++) {
    var x = i * sw + (j % 2 ? sw * 0.5 : 0), y = j * ch;
    var v = (hash(i * 7.1 + j * 3.3) * 26) | 0;
    g.fillStyle = 'rgba(' + (206 - v) + ',' + (176 - v) + ',' + (150 - v) + ',0.55)';
    g.fillRect(x + 2, y + 2, sw - 4, ch - 4);
    g.strokeStyle = 'rgba(228,224,216,0.7)'; g.lineWidth = 3;
    g.strokeRect(x + 0.5, y + 0.5, sw, ch);
  }
  for (i = 0; i < 400; i++) {
    g.fillStyle = 'rgba(90,70,58,' + (0.02 + hash(i * 4.1 + 5) * 0.07).toFixed(3) + ')';
    g.fillRect(hash(i * 1.1) * 256, hash(i * 2.1 + 1) * 256, 2, 1);
  }
  return c;
}
function roofTex() {
  /* 256, pitch 17 px: at tile 8.6 the unit lands at 330 mm, a real Marseille
     pantile.  At the old 128 / 10 px it was 192 mm and read as corrugation. */
  var c = cv(256), g = c.getContext('2d'), x, y;
  g.fillStyle = '#efe7e2'; g.fillRect(0, 0, 256, 256);
  for (y = 0; y < 256; y += 26) for (x = 0; x < 256; x += 17) {
    var a = (0.10 + hash(x * 0.7 + y * 3.1) * 0.20).toFixed(3);
    g.fillStyle = 'rgba(120,86,64,' + a + ')';
    g.beginPath(); g.moveTo(x, y + 26); g.lineTo(x, y + 5);
    g.quadraticCurveTo(x + 8.5, y - 3, x + 17, y + 5); g.lineTo(x + 17, y + 26);
    g.fill();
    g.fillStyle = 'rgba(60,38,26,0.22)'; g.fillRect(x, y + 23, 17, 3);
    g.fillStyle = 'rgba(255,250,244,0.16)'; g.fillRect(x + 7, y + 5, 3, 18);
  }
  return c;
}
function barkTex() {
  /* THE GRAIN MUST RUN UP THE TUBE: a tube's uv puts texture-v on world Y, and
     a horizontal-bezier map wraps every trunk in rings and reads as bamboo. */
  var c = cv(128), g = c.getContext('2d'), i;
  g.fillStyle = '#d8cec0'; g.fillRect(0, 0, 128, 128);
  for (i = 0; i < 26; i++) {
    var x = hash(i * 3.7) * 128;
    g.strokeStyle = 'rgba(52,42,33,' + (0.20 + hash(i * 2.3 + 1) * 0.26).toFixed(3) + ')';
    g.lineWidth = 1.2 + hash(i * 5.1 + 2) * 2.2;
    g.beginPath(); g.moveTo(x, -4);
    g.bezierCurveTo(x + hash(i + 3) * 14 - 7, 42, x + hash(i + 4) * 14 - 7, 86, x, 132);
    g.stroke();
  }
  for (i = 0; i < 70; i++) {
    var pale = (i % 3) !== 0;
    g.fillStyle = (pale ? 'rgba(196,186,170,' : 'rgba(96,82,66,') +
      (0.05 + hash(i * 6.1 + 5) * 0.11).toFixed(3) + ')';
    g.fillRect(hash(i * 1.9 + 6) * 128, hash(i * 2.7 + 7) * 128,
               3 + hash(i * 3.3 + 8) * 8, 8 + hash(i * 4.9 + 9) * 16);
  }
  return c;
}
function pvcTex() {
  /* white PVC joinery: a faint extrusion grain and nothing else.  It exists so
     the frames are not a flat untextured white against a walls' worth of
     relief - all of the colour is still the vertex tone. */
  var c = cv(128), g = c.getContext('2d'), i;
  g.fillStyle = '#f4f3f0'; g.fillRect(0, 0, 128, 128);
  for (i = 0; i < 128; i += 2) {
    g.fillStyle = 'rgba(120,118,112,' + (0.012 + hash(i * 1.7) * 0.02).toFixed(3) + ')';
    g.fillRect(i, 0, 1, 128);
  }
  for (i = 0; i < 260; i++) {
    g.fillStyle = 'rgba(90,88,84,' + (0.01 + hash(i * 3.3 + 2) * 0.035).toFixed(3) + ')';
    g.fillRect(hash(i * 1.1) * 128, hash(i * 2.9 + 1) * 128, 1, 1);
  }
  return c;
}
function steelTex() {
  /* galvanised sheet at tile m(0.4) = 1.4: a fine mill grain, so a barricade
     post and a roller shutter are not the same untextured grey. */
  var c = cv(128), g = c.getContext('2d'), i;
  g.fillStyle = '#eeeeec'; g.fillRect(0, 0, 128, 128);
  for (i = 0; i < 900; i++) {
    var v = (100 + hash(i * 2.1) * 120) | 0;
    g.fillStyle = 'rgba(' + v + ',' + v + ',' + (v + 2) + ',' + (0.03 + hash(i * 4.3 + 1) * 0.09).toFixed(3) + ')';
    g.fillRect(hash(i * 1.3 + 2) * 128, hash(i * 3.7 + 3) * 128, 1 + hash(i * 5.9 + 4) * 3, 1);
  }
  return c;
}
function markTex() {
  var c = cv(128), g = c.getContext('2d'), i;
  g.fillStyle = '#f4f3ee'; g.fillRect(0, 0, 128, 128);
  for (i = 0; i < 320; i++) {
    g.fillStyle = 'rgba(120,120,116,' + (0.02 + hash(i * 3.1) * 0.08).toFixed(3) + ')';
    g.fillRect(hash(i * 1.7 + 1) * 128, hash(i * 2.3 + 2) * 128, 1, 1);
  }
  return c;
}

/* ---- THE SIGN ATLAS ---------------------------------------------------
   1024 x 1024, ClampToEdge, alphaTest 0.28, allocated as free rects with a
   per-slot {rect, aspect, capFrac}.  The atlas this replaces was 640 px
   (not a power of two), had 3-px gutters and filled the FULL row width with
   an opaque background, so at mip 2 one fascia's cream ground bled into the
   next one's letters; and signQuad stretched whatever 10:1 row it was handed
   onto whatever quad the caller passed, so four signs carried four different
   letterforms.  Here every board is sized FROM ITS CAP HEIGHT against a world
   0.9625 u (275 mm, what ref1's SEYDIKENT A-BLOK measures against its storey),
   so a 2.29 x 0.48 m fascia and a 1.04 x 0.60 m plate get the same letters. */
var SIGN_RES = 1024, SIGN_GUT = 12;
var SIGN_CAP = m(0.275);                 /* 0.9625 world units */
var SIGN = { slot: {}, tex: null };

function fitTextA(g, txt, weight, maxW, maxH, cx, cy, col, ky) {
  var size = Math.max(6, Math.floor(maxH / 0.716)), i, w = 1, capH = 1;
  for (i = 0; i < 12; i++) {
    g.font = weight + ' ' + size + 'px ' + FONT;
    w = g.measureText(txt).width || 1;
    capH = size * 0.716;
    try {
      var mm = g.measureText('H');
      if (mm && mm.actualBoundingBoxAscent > 0) capH = mm.actualBoundingBoxAscent;
    } catch (e) {}
    if (w <= maxW && capH <= maxH) break;
    var k = Math.min(maxW / w, maxH / capH) * 0.97;
    size = Math.max(6, Math.floor(size * k));
  }
  g.save();
  /* pre-stretch vertically by the destination quad's aspect so the quad's own
     horizontal stretch cancels it; ky is 1 wherever the card is sized from the
     slot aspect, which is everywhere signCard() is used */
  if (ky && ky !== 1) { g.translate(cx, cy); g.scale(1, ky); g.translate(-cx, -cy); }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = col;
  g.fillText(txt, cx, cy);
  g.restore();
  return { w: w, cap: capH * (ky || 1) };
}

function signAtlas() {
  var c = cv(SIGN_RES, SIGN_RES), g = c.getContext('2d');
  g.clearRect(0, 0, SIGN_RES, SIGN_RES);
  var SA = { x: 0, y: 0, rowH: 0 };
  function alloc(w, h) {
    if (SA.x + w > SIGN_RES) { SA.x = 0; SA.y += SA.rowH; SA.rowH = 0; }
    var r = { x0: SA.x, y0: SA.y, x1: SA.x + w, y1: SA.y + h };
    SA.x += w; if (h > SA.rowH) SA.rowH = h;
    if (r.y1 > SIGN_RES) warn('sign atlas overflow at slot y ' + r.y0);
    return r;
  }
  /* Record the DRAWN region in pixels as the uv rect, with the aspect and the
     cap fraction the world size is derived from.  The x extents are cropped to
     the INK plus a margin, so a short name is a short board and not a long
     board with a lot of empty paint at each end - which is also what stops a
     six-letter fascia from overhanging its own shopfront. */
  function put(key, x0, y0, x1, y1, capPx) {
    var w = x1 - x0, h = y1 - y0;
    SIGN.slot[key] = {
      key: key,
      rect: [x0 / SIGN_RES, 1 - y1 / SIGN_RES, x1 / SIGN_RES, 1 - y0 / SIGN_RES],
      aspect: w / Math.max(1, h),
      capFrac: clamp((capPx || h) / Math.max(1, h), 0.05, 1)
    };
  }

  /* --- the lettered boards.  A board with a `bg` is an opaque panel INSIDE
     its gutter (the mip rule); a board without one is cut letters screwed to
     the wall, which is what the apartment names are in every reference frame,
     so those get a soft drop shadow instead of a ground. */
  var boards = [
    { key: 'bblok',    text: 'SEYDIKENT B-BLOK',      fg: '#4f5960', bg: '#e8e3d8' },
    { key: 'ekmek',    text: 'DOYUM EKMEK FABRIKASI', fg: '#7c4a1e', bg: '#e8d9b6' },
    { key: 'bakkal',   text: 'SEYDI BAKKAL',          fg: '#1d4f8c', bg: '#eceae2' },
    { key: 'komagene', text: 'KOMAGENE',              fg: '#f2efe8', bg: '#a8202a' },
    { key: 'garaj',    text: 'OTOPARK',               fg: '#e9e7e0', bg: '#3a3d40' },
    { key: 'polis',    text: 'POLIS  -  DUR',         fg: '#f4f2ec', bg: '#1b3f79' },
    { key: 'kapali',   text: 'YOL KAPALI',            fg: '#20201e', bg: '#e8c531' },
    { key: 'camii',    text: 'ADIL CAMII',            fg: '#f0ece2', bg: '#2b5f4e' },
    { key: 'eczane',   text: 'GÜVEN ECZANESİ',        fg: '#b8292f', bg: '#f4f1e9' },
    { key: 'kizil',    text: 'KIZILCALAR APT.',       fg: '#b03a2e', bg: null },
    { key: 'sila',     text: 'SILA APT.  B-GİRİŞ',    fg: '#b03a2e', bg: null },
    { key: 'degerli',  text: 'DEGERLI APT.',          fg: '#b03a2e', bg: null },
    { key: 'onurlu',   text: 'ONURLU APT.',           fg: '#b03a2e', bg: null },
    { key: 'market',   text: 'SEYDİŞEHİR MARKET',     fg: '#f6f2e8', bg: '#b0202a' }
  ];
  /* 512 x 88 cells, two to a shelf: FOURTEEN boards land in seven shelves and
     the five pictorial cells fit below them, which is what keeps the
     whole atlas inside 1024 x 1024 with 12-px gutters everywhere.  The
     fourteenth is the market fascia, and it lands in the second half of the
     seventh shelf that the thirteenth was already occupying alone. */
  var i, b, cell;
  for (i = 0; i < boards.length; i++) {
    b = boards[i];
    cell = alloc(512, 88);
    var bx = cell.x0 + SIGN_GUT, by = cell.y0 + SIGN_GUT;
    var bw = cell.x1 - SIGN_GUT - bx, bh = cell.y1 - SIGN_GUT - by;
    if (b.bg) { g.fillStyle = b.bg; g.fillRect(bx, by, bw, bh); }
    var cx = bx + bw * 0.5, cy = by + bh * 0.52;
    if (!b.bg) {
      /* the cast shadow of a cut letter, down and right, at 30%.  Both hero
         blocks in the reference frames carry individual letters screwed to the
         render, not a painted panel, and the shadow is what says so. */
      fitTextA(g, b.text, '900', bw * 0.94, bh * 0.62, cx + 2.4, cy + 2.4, 'rgba(38,26,22,0.30)', 1);
    }
    var mt = fitTextA(g, b.text, '900', bw * 0.94, bh * 0.62, cx, cy, b.fg, 1);
    var mg = bh * 0.26;
    var ix0 = clamp(cx - mt.w * 0.5 - mg, bx, cx), ix1 = clamp(cx + mt.w * 0.5 + mg, cx, bx + bw);
    if (!(ix1 - ix0 > 8)) { ix0 = bx; ix1 = bx + bw; }
    put(b.key, ix0, by, ix1, by + bh, mt.cap);
  }

  /* --- the blue Turkish street plate: OZGUR MAH. over 232. SK. */
  cell = alloc(340, 210);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var w = cell.x1 - cell.x0 - SIGN_GUT * 2, h = cell.y1 - cell.y0 - SIGN_GUT * 2;
    g.fillStyle = '#12447e'; g.fillRect(x0, y0, w, h);
    g.strokeStyle = '#f2f1ea'; g.lineWidth = Math.max(2, h * 0.02);
    var ib = h * 0.06;
    g.strokeRect(x0 + ib, y0 + ib, w - 2 * ib, h - 2 * ib);
    fitTextA(g, 'OZGUR MAH.', '700', w * 0.78, h * 0.20, x0 + w * 0.5, y0 + h * 0.30, '#f2f1ea', 1);
    fitTextA(g, '232. SK.', '900', w * 0.80, h * 0.34, x0 + w * 0.5, y0 + h * 0.65, '#f2f1ea', 1);
    /* capFrac 1 on every pictorial cell: for these, signCard's capH IS the
       card height and the width follows the cell aspect */
    put('sokak', x0, y0, x0 + w, y0 + h, h);
  })();

  /* --- the house-number plaque */
  cell = alloc(170, 210);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var w = cell.x1 - cell.x0 - SIGN_GUT * 2, h = cell.y1 - cell.y0 - SIGN_GUT * 2;
    g.fillStyle = '#12447e'; g.fillRect(x0, y0, w, h);
    g.strokeStyle = '#f2f1ea'; g.lineWidth = 3;
    g.strokeRect(x0 + 4, y0 + 4, w - 8, h - 8);
    fitTextA(g, '17', '900', w * 0.66, h * 0.52, x0 + w * 0.5, y0 + h * 0.52, '#f2f1ea', 1);
    put('numara', x0, y0, x0 + w, y0 + h, h);
  })();

  /* --- the pharmacy emblem used by the projecting corner sign and beside
     the fascia lettering.  It was a green cross, which is what a pharmacy
     carries in France or Italy; a Turkish eczane carries a red E on white,
     and the owner's frame of GUVEN ECZANESI shows exactly that between the
     two words of its fascia.  The slot keeps its old key so every caller
     that asks for 'cross' gets the right emblem without being touched. */
  cell = alloc(220, 220);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var s = cell.x1 - cell.x0 - SIGN_GUT * 2;
    g.fillStyle = '#f4f3ee'; g.fillRect(x0, y0, s, s);
    g.strokeStyle = '#c4222b'; g.lineWidth = s * 0.07;
    g.strokeRect(x0 + s * 0.075, y0 + s * 0.075, s * 0.85, s * 0.85);
    fitTextA(g, 'E', '900', s * 0.56, s * 0.56, x0 + s * 0.5, y0 + s * 0.53, '#c4222b', 1);
    put('cross', x0, y0, x0 + s, y0 + s, s);
  })();

  /* --- the crescent alem.  A disc with an offset disc punched out of it, and
     a spike below, so it reads at the top of a 39 m minaret. */
  cell = alloc(170, 250);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var w = cell.x1 - cell.x0 - SIGN_GUT * 2, h = cell.y1 - cell.y0 - SIGN_GUT * 2;
    var cx = x0 + w * 0.5, cy = y0 + h * 0.36, R = Math.min(w, h) * 0.32;
    g.save();
    g.fillStyle = '#c9a54a';
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(cx + R * 0.42, cy - R * 0.10, R * 0.80, 0, Math.PI * 2); g.fill();
    g.restore();
    g.fillStyle = '#c9a54a';
    g.fillRect(cx - w * 0.035, cy + R * 0.7, w * 0.07, h * 0.44);
    g.beginPath(); g.arc(cx, cy + R * 0.72 + h * 0.10, w * 0.09, 0, Math.PI * 2); g.fill();
    put('alem', x0, y0, x0 + w, y0 + h, h);
  })();

  /* --- the hazard chevrons.  FOUR MITRED polylines, each a closed path of its
     own: two mitred half-strips drawn as ONE closed path comes out as a
     lightning bolt, which is what the first barricade looked like. */
  cell = alloc(320, 130);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var w = cell.x1 - cell.x0 - SIGN_GUT * 2, h = cell.y1 - cell.y0 - SIGN_GUT * 2;
    g.fillStyle = '#e8c024'; g.fillRect(x0, y0, w, h);
    /* clipped to the cell, or the last chevron's mitre runs into the gutter
       and out through the neighbouring slot */
    g.save(); g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    g.fillStyle = '#1a1a18';
    var n = 4, pitch = w / n, th = pitch * 0.42, reach = h * 0.5, i2;
    for (i2 = 0; i2 < n; i2++) {
      var x = x0 + i2 * pitch + pitch * 0.10;
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x + reach, y0 + h * 0.5);
      g.lineTo(x, y0 + h);
      g.lineTo(x + th, y0 + h);
      g.lineTo(x + th + reach, y0 + h * 0.5);
      g.lineTo(x + th, y0);
      g.closePath(); g.fill();
    }
    g.restore();
    put('hazard', x0, y0, x0 + w, y0 + h, h);
  })();

  /* --- THE REFUGE'S THREE SIGNS, off the owner's April 2026 frame of the
     island by the pharmacy.  They sit in the shelf the hazard strip left
     two thirds empty: 150 + 124 + 160 px against 704 free.
       aheadleft  the blue mandatory disc, ahead-or-left, white rim
       refuge     the island-head marker under it: black chevrons pointing UP
                  on yellow, taller than wide
       giveway    the inverted triangle the frame shows from behind */
  cell = alloc(150, 150);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var s = cell.x1 - cell.x0 - SIGN_GUT * 2;
    var cx = x0 + s * 0.5, cy = y0 + s * 0.5, R = s * 0.5;
    g.fillStyle = '#f2f1ea'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1757ab'; g.beginPath(); g.arc(cx, cy, R * 0.93, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#f2f1ea'; g.fillStyle = '#f2f1ea';
    g.lineCap = 'butt'; g.lineJoin = 'round'; g.lineWidth = R * 0.17;
    var ax = cx + R * 0.20;
    g.beginPath(); g.moveTo(ax, cy + R * 0.64); g.lineTo(ax, cy - R * 0.30); g.stroke();
    g.beginPath(); g.moveTo(ax, cy - R * 0.74); g.lineTo(ax - R * 0.25, cy - R * 0.28);
    g.lineTo(ax + R * 0.25, cy - R * 0.28); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(ax, cy + R * 0.34);
    g.quadraticCurveTo(ax, cy - R * 0.02, ax - R * 0.30, cy - R * 0.02);
    g.lineTo(ax - R * 0.46, cy - R * 0.02); g.stroke();
    g.beginPath(); g.moveTo(ax - R * 0.86, cy - R * 0.02); g.lineTo(ax - R * 0.44, cy - R * 0.27);
    g.lineTo(ax - R * 0.44, cy + R * 0.23); g.closePath(); g.fill();
    put('aheadleft', x0, y0, x0 + s, y0 + s, s);
  })();
  cell = alloc(124, 150);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var w = cell.x1 - cell.x0 - SIGN_GUT * 2, h = cell.y1 - cell.y0 - SIGN_GUT * 2;
    g.fillStyle = '#e8b21e'; g.fillRect(x0, y0, w, h);
    g.save(); g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    g.fillStyle = '#17150f';
    var pitch = h / 2.35, th = pitch * 0.50, rise = w * 0.46, i3;
    for (i3 = 0; i3 < 4; i3++) {
      var yb = y0 + h + rise * 0.55 - i3 * pitch;
      g.beginPath();
      g.moveTo(x0, yb); g.lineTo(x0 + w * 0.5, yb - rise); g.lineTo(x0 + w, yb);
      g.lineTo(x0 + w, yb - th); g.lineTo(x0 + w * 0.5, yb - rise - th); g.lineTo(x0, yb - th);
      g.closePath(); g.fill();
    }
    g.restore();
    put('refuge', x0, y0, x0 + w, y0 + h, h);
  })();
  cell = alloc(160, 150);
  (function () {
    var x0 = cell.x0 + SIGN_GUT, y0 = cell.y0 + SIGN_GUT;
    var w = cell.x1 - cell.x0 - SIGN_GUT * 2, h = cell.y1 - cell.y0 - SIGN_GUT * 2;
    function tri(inset, col) {
      g.fillStyle = col; g.beginPath();
      g.moveTo(x0 + inset * 1.15, y0 + inset * 0.60);
      g.lineTo(x0 + w - inset * 1.15, y0 + inset * 0.60);
      g.lineTo(x0 + w * 0.5, y0 + h - inset * 1.25);
      g.closePath(); g.fill();
    }
    tri(0, '#c4222b'); tri(h * 0.15, '#f4f2ec');
    put('giveway', x0, y0, x0 + w, y0 + h, h);
  })();

  return c;
}

/* ---- THE DECAL ATLAS --------------------------------------------------
   1024 x 512, eight 256-px cells, BLENDED at alphaTest 0.02, DoubleSide,
   depthWrite off.  Grime is POSITIONAL - a streak starts at a sill, a soil
   band at the ground line, a weep under a bracket - so it cannot live in a
   tiling map, and without it render reads as new.  D_STREAK under every cill
   is the single pass that makes a facade thirty years old.
   THE GUTTER RULE holds throughout: DEC_GUT = 12 px of fully transparent
   margin round every cell plus put()'s further 3 per cent inset, so nothing
   a cell draws can bleed into its neighbour under mipping.
   Cells 0-4 are WASHES and are drawn by the wash engine below; cells 5-7 are
   a casting, a casting and a plant, and are drawn with the 2d context. */
var DEC_W = 1024, DEC_H = 512, DEC_CELL = 256, DEC_GUT = 12;
var DEC = { slot: {}, tex: null };
var D_STREAK = 'streak', D_GROUND = 'ground', D_ALGAE = 'algae', D_RUST = 'rust';
var D_DRIP = 'drip', D_GRATE = 'grate', D_MANHOLE = 'manhole', D_WEED = 'weed';
/* The two sibling modules carry a larger grime vocabulary (nz-street.js has
   thirteen cells: D_FAN, D_DAMP, D_CHIP, D_SOOT, D_FADE, D_SPALL, D_LIME,
   D_BILL, D_CABLE).  Rather than warn at install when a builder reaches for
   one of those names, each resolves to the nearest cell we do carry - the
   colour is the caller's tone anyway, so a soot blotch and a fade blotch are
   the same card at two tones. */
var DEC_ALIAS = {
  fan: 'streak', soot: 'ground', fade: 'ground', bill: 'ground',
  damp: 'algae', lime: 'drip', cable: 'drip', spall: 'rust', chip: 'rust'
};

function decalAtlas() {
  var c = cv(DEC_W, DEC_H), g = c.getContext('2d');
  g.clearRect(0, 0, DEC_W, DEC_H);
  var order = [D_STREAK, D_GROUND, D_ALGAE, D_RUST, D_DRIP, D_GRATE, D_MANHOLE, D_WEED];
  /* the eight cells are laid 4 x 2 at 256 px; `order` is only here so the cell
     index of each slot is readable in one place */
  function cellBox(i) {
    var cx = (i % 4) * DEC_CELL, cy = ((i / 4) | 0) * DEC_CELL;
    return { x: cx + DEC_GUT, y: cy + DEC_GUT, s: DEC_CELL - DEC_GUT * 2 };
  }
  function put(key, i) {
    var b = cellBox(i), ins = b.s * 0.03;
    var x0 = b.x + ins, y0 = b.y + ins, x1 = b.x + b.s - ins, y1 = b.y + b.s - ins;
    DEC.slot[key] = {
      key: key,
      rect: [x0 / DEC_W, 1 - y1 / DEC_H, x1 / DEC_W, 1 - y0 / DEC_H],
      aspect: 1
    };
  }
  var i, j, b;

  /* ---- THE WASH ENGINE --------------------------------------------------
     Weathering is not a stroke, it is a FIELD: darkest where the water ran,
     invisible at its edges, and never anywhere a hard line.  The cells this
     replaces were 46 tapered quads whose TOP ROW started at alpha 0.20..0.46
     hard against alpha 0, and radial lobes that peaked at 0.52 - under the
     material's alphaTest that is a set of near-black islands, which is
     exactly what the render came back with.

     So the five grime cells are an ALPHA FIELD instead: one float buffer per
     cell, accumulated premultiplied, normalised on the way out.  Two
     properties of that are load-bearing and must survive any edit here.
       - RGB is CONSTANT across a wash cell, so the mip chain carries alpha
         only and no gradient can ever drift in hue as it shrinks.
       - RGB is PALE, not near-black.  Every caller already mixes its tone
         0.42..0.62 toward C.dark before handing it over; a near-black atlas
         on top of that multiplies out at about 1 per cent of the wall and
         reads as ink.  Pale here means THE TONE IS THE ALBEDO - the same
         discipline the needle atlas uses for its ground-cover cells.
     A real overcast Seydisehir wash is 10 to 25 per cent darker than the wall
     at its strongest, so the peaks below are 0.24..0.38 and nothing is
     opaque.
     Every field is written over the WHOLE b box and normalised to it, while
     put() samples b inset 3 per cent - so the outer 3 per cent of each cell
     is drawn but never sampled, and is there to be the guard band the top mip
     levels average into.  The 12-px transparent margin outside b is the
     GUTTER RULE proper and nothing here ever writes into it. */
  function wBuf(bx) { var s = bx.s | 0; return { s: s, d: new Float32Array(s * s * 4) }; }
  function wAdd(buf, rgb, fn) {
    var s = buf.s, d = buf.d, px, py, u, v, a, k;
    for (py = 0; py < s; py++) {
      v = (py + 0.5) / s;
      for (px = 0; px < s; px++) {
        u = (px + 0.5) / s;
        a = fn(u, v);
        if (!(a > 0.0005)) continue;
        if (a > 1) a = 1;
        k = (py * s + px) * 4;
        d[k] += rgb[0] * a; d[k + 1] += rgb[1] * a; d[k + 2] += rgb[2] * a;
        d[k + 3] += a;
      }
    }
  }
  function wPut(bx, buf) {
    var s = buf.s, d = buf.d, img = g.createImageData(s, s), o = img.data, k, a;
    for (k = 0; k < s * s; k++) {
      a = d[k * 4 + 3];
      if (!(a > 0)) { o[k * 4 + 3] = 0; continue; }
      /* +0.5 before the truncate: without it a constant 236 comes back 235 on
         every texel and the pale body drifts a step darker for nothing */
      o[k * 4] = (clamp(d[k * 4] / a, 0, 255) + 0.5) | 0;
      o[k * 4 + 1] = (clamp(d[k * 4 + 1] / a, 0, 255) + 0.5) | 0;
      o[k * 4 + 2] = (clamp(d[k * 4 + 2] / a, 0, 255) + 0.5) | 0;
      o[k * 4 + 3] = (clamp(a, 0, 1) * 255 + 0.5) | 0;
    }
    g.putImageData(img, bx.x, bx.y);
  }
  /* value noise, smooth in both arguments - a wash striation that is white
     noise per pixel just turns into film grain three mips down */
  function vn(x) {
    var i0 = Math.floor(x), f = x - i0;
    return lerp(hash(i0 * 1.37 + 9.1), hash((i0 + 1) * 1.37 + 9.1), f * f * (3 - 2 * f));
  }
  function vn2(x, y) {
    var j0 = Math.floor(y), f = y - j0;
    return lerp(vn(x + j0 * 17.7), vn(x + (j0 + 1) * 17.7), f * f * (3 - 2 * f));
  }
  /* smoothstep that also runs BACKWARDS when a0 > a1, so a two-sided taper is
     one expression instead of an if */
  function sstep(a0, a1, t) {
    t = clamp((t - a0) / (a1 - a0), 0, 1); return t * t * (3 - 2 * t);
  }
  /* the pale bodies, sRGB bytes.  Warm, because the overcast probe is blue by
     construction and a neutral wash lands blue after the sky has had its say
     - the same correction the C table carries. */
  var W_WASH   = [236, 229, 214];   /* rain-washed render off a cill or bolt */
  var W_SPLASH = [228, 220, 206];   /* the splash zone, a touch greyer       */
  var W_ALGAE  = [190, 208, 172];   /* green-grey bloom                      */
  var W_RUST   = [226, 162, 110];   /* thin orange-brown weep                */

  /* 0 STREAK: the wash off a cill.  Near-zero alpha at the head, PEAK 0.31 to
     0.36 a third of the way down, zero at the foot and at BOTH flanks.  The
     measured cell edges are 0.031 top and 0.000 on the other three.  The fibres
     run along constant fan coordinate, which is why they spread as the fan
     opens instead of staying parallel like a comb, and the fan's half-width
     never reaches 0.5 so the cell is transparent at its own boundary. */
  b = cellBox(0);
  (function () {
    var buf = wBuf(b);
    function hw(v) { return 0.115 + 0.345 * v; }   /* 0.23 wide at the cill, 0.92 at the foot */
    function prof(v) {
      /* 0.10 of peak at the head so the wash is CONNECTED to the cill without
         drawing a line there: the head measures alpha 0.031, which is a one
         per cent darkening of the wall - present, and not a visible edge */
      if (v < 0.34) return 0.10 + 0.90 * sstep(0, 0.34, v);
      return Math.pow(1 - (v - 0.34) / 0.66, 1.55);  /* zero slope at the foot */
    }
    wAdd(buf, W_WASH, function (u, v) {
      var q = (u - 0.5) / hw(v);
      if (q <= -1 || q >= 1) return 0;
      var e = 1 - q * q, env = prof(v) * e * e;      /* e squared: zero SLOPE at the flanks */
      if (env <= 0) return 0;
      var f = vn(q * 21.0) * 0.60 + vn(q * 57.0 + 6.3) * 0.40;
      f = clamp((f - 0.38) * 2.7, 0, 1);
      f *= 0.74 + 0.26 * vn2(q * 8.0 + 3.1, v * 3.3);
      /* 0.42 body + 0.58 fibre, gained 0.38 so the joint maximum of the two
         noise terms lands the measured peak at 0.31..0.36 across seeds - the
         0.30-0.38 a real wash reaches.  THE MIP RULE is the 0.42: the filled
         low-alpha body is what the cell averages to three levels down, and
         fibres alone go to haze and take the whole grime pass with them. */
      return 0.38 * env * (0.42 + 0.58 * f);
    });
    wPut(b, buf);
  })();
  put(D_STREAK, 0);

  /* 1 GROUND: the splash zone at the foot of a wall.  A wide, VERY soft band,
     strongest along its bottom edge and gone by a third of the way up.  The
     flanks ease off so the patches side-2 lays along a run read as separate
     wettings and not one continuous stripe. */
  b = cellBox(1);
  (function () {
    var buf = wBuf(b);
    wAdd(buf, W_SPLASH, function (u, v) {
      var lat = sstep(0, 0.22, u) * sstep(0, 0.22, 1 - u);
      var env = Math.pow(sstep(0.06, 1.0, v), 1.7) * lat;
      if (env <= 0) return 0;
      /* the tide-line is grainier where it dies out than down at the kerb */
      env *= 0.80 + 0.40 * vn2(u * 26.0 + 11.0, v * 5.0) * (1 - v * 0.6);
      return 0.40 * clamp(env, 0, 1);              /* peak 0.38 at the foot */
    });
    wPut(b, buf);
  })();
  put(D_GROUND, 1);

  /* 2 ALGAE: the damp green-grey bloom in a corner and under a leaking joint.
     WEAK - peak 0.26.  Five big overlapping lobes rather than scattered
     spots: a lobe of r 0.20..0.36 of the cell IS the filled body the mip rule
     asks for, and every one of them is zero before the cell boundary. */
  b = cellBox(2);
  (function () {
    var buf = wBuf(b), lobe = [], q;
    for (q = 0; q < 5; q++)
      lobe.push([0.30 + hash(q * 3.3 + 2.1) * 0.40,        /* centre u  */
                 0.24 + hash(q * 4.7 + 5.3) * 0.52,        /* centre v  */
                 0.20 + hash(q * 2.1 + 8.7) * 0.16]);      /* radius    */
    wAdd(buf, W_ALGAE, function (u, v) {
      var edge = sstep(0, 0.16, u) * sstep(0, 0.16, 1 - u) *
                 sstep(0, 0.14, v) * sstep(0, 0.20, 1 - v);
      if (edge <= 0) return 0;
      var a = 0, k2, dx, dy, r2;
      for (k2 = 0; k2 < lobe.length; k2++) {
        dx = (u - lobe[k2][0]) / lobe[k2][2];
        dy = (v - lobe[k2][1]) / (lobe[k2][2] * 1.45);     /* damp runs downward */
        r2 = dx * dx + dy * dy;
        if (r2 < 1) a += (1 - r2) * (1 - r2) * 0.42;
      }
      a *= 0.62 + 0.38 * vn2(u * 17.0 + 4.4, v * 9.0);
      return 0.26 * clamp(a, 0, 1) * edge;
    });
    wPut(b, buf);
  })();
  put(D_ALGAE, 2);

  /* 3 RUST: the weep under a bracket, a fixing, a shutter guide.  Thin and
     WEAK - peak 0.24.  A soft source bar 8 per cent down, three trails that
     leave it and spread as they run, and a low body under the lot. */
  b = cellBox(3);
  (function () {
    var buf = wBuf(b), tr = [], q;
    for (q = 0; q < 3; q++)
      tr.push([0.40 + hash(q * 5.1 + 3.7) * 0.20,          /* x at the head   */
               0.012 + hash(q * 6.3 + 1.9) * 0.022,        /* half-width      */
               0.55 + hash(q * 7.7 + 6.1) * 0.42]);        /* how far it runs */
    wAdd(buf, W_RUST, function (u, v) {
      var edge = sstep(0, 0.10, u) * sstep(0, 0.10, 1 - u) *
                 sstep(0, 0.05, v) * sstep(0, 0.08, 1 - v);
      if (edge <= 0) return 0;
      var a = 0.62 * sstep(0.16, 0.03, Math.abs(v - 0.085)) *
                     sstep(0.34, 0.16, Math.abs(u - 0.5));
      var k2, w2, dx, run;
      for (k2 = 0; k2 < tr.length; k2++) {
        run = tr[k2][2];
        if (v > run) continue;
        w2 = tr[k2][1] * (1 + v * 2.2);
        dx = Math.abs(u - tr[k2][0] - (vn(v * 3.1 + k2 * 9.0) - 0.5) * 0.05) / w2;
        if (dx < 1) a += (1 - dx * dx) * (1 - v / run) * (1 - v / run) * 0.90;
      }
      /* THE MIP RULE again: three 1-per-cent-wide trails average to nothing,
         so a 0.16 body sits under them down the middle of the cell */
      a += 0.16 * sstep(0.02, 0.30, v) * sstep(1.02, 0.55, v) *
                  sstep(0.26, 0.10, Math.abs(u - 0.5));
      a *= 0.72 + 0.28 * vn2(u * 30.0 + 2.2, v * 6.0);
      return 0.24 * clamp(a, 0, 1) * edge;
    });
    wPut(b, buf);
  })();
  put(D_RUST, 3);

  /* 4 DRIP: D_STREAK narrowed to a POINT source - a bracket, a bolt, a
     satellite-dish fixing.  The trail is 0.044 of the cell at the head, and
     side-2 places this card 0.62 u = 177 mm wide, so that head is 8 mm; it
     spreads to 0.27 of the cell (48 mm) by the foot and no further.  Peak
     0.30, and a soft seep at the fixing itself. */
  b = cellBox(4);
  (function () {
    var buf = wBuf(b);
    function hw(v) { return 0.022 + 0.115 * v; }
    function prof(v) {
      if (v < 0.22) return 0.18 + 0.82 * sstep(0, 0.22, v);
      return Math.pow(1 - (v - 0.22) / 0.78, 1.35);
    }
    wAdd(buf, W_WASH, function (u, v) {
      var q = (u - 0.5) / hw(v), a = 0, e;
      if (q > -1 && q < 1) {
        e = 1 - q * q;
        /* 0.42 body floor on a cell this narrow, or it mips to nothing */
        a = prof(v) * e * e * (0.42 + 0.58 * (0.35 + 0.65 * vn(q * 9.0 + v * 0.8)));
      }
      /* the seep at the fixing.  Centred 0.060 down with a 0.050 vertical
         radius, so it is already zero at the cell's top row - centred any
         higher and the card's head carries a 0.12-alpha cut line. */
      var dx = (u - 0.5) / 0.070, dy = (v - 0.060) / 0.050, r2 = dx * dx + dy * dy;
      if (r2 < 1) a += (1 - r2) * (1 - r2) * 0.70;
      return 0.30 * clamp(a, 0, 1);            /* measured peak 0.295..0.300 */
    });
    wPut(b, buf);
  })();
  put(D_DRIP, 4);

  /* 5 GRATE: the gully.  Body at 0.97 alpha with seven slots at 19-px pitch,
     each with a highlight below it, so the casting has depth from 3 m up. */
  b = cellBox(5);
  (function () {
    var k = b.s / 232;                                 /* park's cell metrics */
    g.fillStyle = 'rgba(30,30,28,0.97)';
    g.fillRect(b.x, b.y + b.s * 0.16, b.s, b.s * 0.68);
    g.strokeStyle = 'rgba(150,150,144,0.75)'; g.lineWidth = 5 * k;
    g.strokeRect(b.x + 2 * k, b.y + b.s * 0.16 + 2 * k, b.s - 4 * k, b.s * 0.68 - 4 * k);
    for (i = 0; i < 7; i++) {
      var sy = b.y + b.s * (0.20 + i * 0.62 / 7);      /* seven slots, even pitch */
      g.fillStyle = 'rgba(12,12,11,0.98)';
      g.fillRect(b.x + b.s * 0.07, sy, b.s * 0.86, 11 * k);
      g.fillStyle = 'rgba(168,168,160,0.55)';
      g.fillRect(b.x + b.s * 0.07, sy + 11 * k, b.s * 0.86, 3 * k);
    }
  })();
  put(D_GRATE, 5);

  /* 6 MANHOLE */
  b = cellBox(6);
  (function () {
    var cx = b.x + b.s * 0.5, cy = b.y + b.s * 0.5, R = b.s * 0.46;
    g.fillStyle = 'rgba(96,94,88,0.98)';
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(150,148,140,0.80)'; g.lineWidth = b.s * 0.02;
    g.beginPath(); g.arc(cx, cy, R * 0.89, 0, Math.PI * 2); g.stroke();
    g.lineWidth = b.s * 0.016;
    for (i = 0; i < 6; i++) {
      var a = i / 6 * Math.PI;
      g.beginPath();
      g.moveTo(cx - Math.cos(a) * R * 0.78, cy - Math.sin(a) * R * 0.78);
      g.lineTo(cx + Math.cos(a) * R * 0.78, cy + Math.sin(a) * R * 0.78);
      g.stroke();
    }
  })();
  put(D_MANHOLE, 6);

  /* 7 WEED: a joint tuft.  THE FILLED TRIANGLE BODY IS THE MIP RULE - without
     it the blades average their alpha away three mips down and the card
     dissolves into grey haze. */
  b = cellBox(7);
  (function () {
    g.fillStyle = 'rgba(78,96,50,0.96)';
    g.beginPath();
    g.moveTo(b.x + b.s * 0.30, b.y + b.s); g.lineTo(b.x + b.s * 0.50, b.y + b.s * 0.52);
    g.lineTo(b.x + b.s * 0.70, b.y + b.s); g.closePath(); g.fill();
    for (i = 0; i < 34; i++) {
      var bx = b.x + b.s * (0.34 + hash(i * 2.3) * 0.32);
      var bh2 = b.s * (0.22 + hash(i * 3.1 + 1) * 0.42);
      g.strokeStyle = 'rgba(' + (66 + ((hash(i * 4.1 + 2) * 54) | 0)) + ',' +
        (92 + ((hash(i * 5.7 + 3) * 58) | 0)) + ',' + (40 + ((hash(i * 6.9 + 4) * 30) | 0)) + ',' +
        (0.72 + hash(i * 7.3 + 5) * 0.28).toFixed(3) + ')';
      g.lineWidth = b.s * (0.009 + hash(i * 8.1 + 6) * 0.011);
      g.beginPath();
      g.moveTo(bx, b.y + b.s);
      g.quadraticCurveTo(bx + b.s * (hash(i * 9.1 + 7) - 0.5) * 0.20, b.y + b.s - bh2 * 0.6,
                         bx + b.s * (hash(i * 9.7 + 8) - 0.5) * 0.34, b.y + b.s - bh2);
      g.stroke();
    }
  })();
  put(D_WEED, 7);
  if (order.length !== 8) warn('decal atlas cell count changed');
  return c;
}

/* ---- THE NEEDLE ATLAS -------------------------------------------------
   768 x 768, 3 x 3 of 256-px cells, ClampToEdge, alphaTest 0.34, DoubleSide.
   Cells: 0 pine tuft, 1 cedar spray, 2 opaque interior mass, 3 upright
   candles, 4 grass, 5 dry grass, 6 hedge, 7 shrub, 8 reserved.
   Cells 0-3 are drawn SATURATED and the caller's tone multiplies them down;
   4-7 are PALE AND NEAR-NEUTRAL so the vertex tone IS the albedo - the only
   way a measured luminance ladder means anything on a card.
   THE MIP RULE and THE GUTTER RULE bind every cell, and every card that
   samples this atlas MUST go through ncard/ncross: conifer() used the pile's
   planar world-space projector in the build this replaces, and with world
   coordinates of 70..300 under ClampToEdge every card sampled the atlas's
   transparent corner texel and was discarded by alphaTest.  All eight trees
   rendered zero pixels and nobody noticed. */
var NRES = 768, NTS = 256, NGUT = 12;
var NRECT = [];
/* cell 8, the reserved one, is the SPRUCE and it is two half cells: the bough
   in plan (stem left, tip right) over the pendulous spray in elevation (stem
   along the top, shoots hanging).  Explicit rects, because ncard() takes
   either a cell index or a rect and these are not a whole cell. */
var NR_BOUGH = null, NR_HANG = null;
var N_PINE = 0, N_SPRAY = 1, N_MASS = 2, N_CANDLE = 3;
var N_GRASS = 4, N_DRY = 5, N_HEDGE = 6, N_SHRUB = 7;

function needleAtlas() {
  var c = cv(NRES, NRES), g = c.getContext('2d'), i, j, k;
  g.clearRect(0, 0, NRES, NRES);
  NRECT.length = 0;
  for (i = 0; i < 9; i++) {
    var cx0 = (i % 3) * NTS, cy0 = ((i / 3) | 0) * NTS, ins = NTS * 0.03;
    NRECT.push([(cx0 + NGUT + ins) / NRES, 1 - (cy0 + NTS - NGUT - ins) / NRES,
                (cx0 + NTS - NGUT - ins) / NRES, 1 - (cy0 + NGUT + ins) / NRES]);
  }
  function box(i2) {
    return { x: (i2 % 3) * NTS + NGUT, y: ((i2 / 3) | 0) * NTS + NGUT, s: NTS - NGUT * 2 };
  }
  /* PINE and CEDR calibrated off the reference frames: a Konya black pine
     under cloud measures rgb 58-62 / 65-69 / 41-43, green 12% above red and
     blue only 60% of green.  A near-neutral body came back 1.7 stops dark. */
  var PINE = ['rgba(140,172,106,', 'rgba(120,150,92,', 'rgba(168,200,128,', 'rgba(104,132,84,'];
  var CEDR = ['rgba(146,178,116,', 'rgba(126,158,100,', 'rgba(174,206,138,', 'rgba(110,140,94,'];
  var PALE = ['rgba(232,236,214,', 'rgba(204,213,185,', 'rgba(248,250,234,', 'rgba(180,192,163,'];
  var DRYC = ['rgba(240,236,210,', 'rgba(216,208,178,', 'rgba(250,246,224,', 'rgba(196,187,158,'];
  var HLEAF = ['rgba(232,238,210,', 'rgba(198,210,178,', 'rgba(255,255,238,', 'rgba(168,184,150,'];

  function tuft(idx, cols, body, n, fan) {
    var b = box(idx), cx = b.x + b.s * 0.5, cy = b.y + b.s * 0.86;
    g.fillStyle = body;                              /* THE OPAQUE BODY */
    g.beginPath();
    g.moveTo(cx, b.y + b.s * 0.10);
    g.lineTo(b.x + b.s * 0.86, b.y + b.s * 0.88);
    g.lineTo(cx, b.y + b.s * 0.70);
    g.lineTo(b.x + b.s * 0.14, b.y + b.s * 0.88);
    g.closePath(); g.fill();
    for (k = 0; k < n; k++) {
      var t = hash(k * 3.3 + idx * 17), yy = b.y + b.s * (0.08 + t * 0.82);
      var w = b.s * (0.06 + t * 0.40) * fan;
      g.strokeStyle = cols[k % 4] + (0.55 + hash(k * 1.7 + idx) * 0.45).toFixed(3) + ')';
      g.lineWidth = b.s * 0.008;
      g.beginPath(); g.moveTo(cx, yy);
      g.lineTo(cx + (hash(k * 2.1 + 1) < 0.5 ? -w : w), yy + b.s * 0.06);
      g.stroke();
    }
  }
  function mass(idx, cols, body) {
    var b = box(idx), cx = b.x + b.s * 0.5, cy = b.y + b.s * 0.52;
    g.fillStyle = body;
    g.beginPath();
    for (k = 0; k <= 24; k++) {
      var a = k / 24 * Math.PI * 2, rr2 = b.s * (0.29 + hash(k * 5.1 + idx * 3) * 0.14);
      var px = cx + Math.cos(a) * rr2, py = cy + Math.sin(a) * rr2 * 0.88;
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
    for (k = 0; k < 190; k++) {
      var a2 = hash(k * 2.7 + idx) * Math.PI * 2, rd = b.s * (0.26 + hash(k * 3.9 + 1) * 0.20);
      g.strokeStyle = cols[k % 4] + (0.40 + hash(k * 1.3 + 2) * 0.45).toFixed(3) + ')';
      g.lineWidth = b.s * 0.007;
      g.beginPath();
      g.moveTo(cx + Math.cos(a2) * rd * 0.7, cy + Math.sin(a2) * rd * 0.6);
      g.lineTo(cx + Math.cos(a2) * rd, cy + Math.sin(a2) * rd * 0.86);
      g.stroke();
    }
  }
  function candles(idx, cols, body) {
    var b = box(idx), i2, k2;
    g.fillStyle = body;
    g.fillRect(b.x + b.s * 0.16, b.y + b.s * 0.62, b.s * 0.68, b.s * 0.32);
    for (i2 = 0; i2 < 7; i2++) {
      var cx2 = b.x + b.s * (0.14 + i2 * 0.12), hgt = b.s * (0.28 + hash(i2 * 4.1 + idx) * 0.52);
      g.strokeStyle = cols[i2 % 4] + '0.92)';
      g.lineWidth = b.s * (0.045 + hash(i2 * 2.3) * 0.045);
      g.beginPath(); g.moveTo(cx2, b.y + b.s * 0.94); g.lineTo(cx2, b.y + b.s * 0.94 - hgt); g.stroke();
      for (k2 = 0; k2 < 10; k2++) {
        var yy2 = b.y + b.s * 0.94 - hgt * (k2 / 10);
        g.strokeStyle = cols[(k2 + 1) % 4] + '0.75)';
        g.lineWidth = b.s * 0.007;
        g.beginPath(); g.moveTo(cx2, yy2);
        g.lineTo(cx2 + (k2 % 2 ? 1 : -1) * b.s * 0.05, yy2 + b.s * 0.03); g.stroke();
      }
    }
  }
  function blades(idx, cols, body, n, tall) {
    var b = box(idx), k2;
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(b.x, b.y + b.s);
    for (k2 = 0; k2 <= 12; k2++)
      g.lineTo(b.x + b.s * k2 / 12, b.y + b.s * (1 - tall * (0.34 + hash(k2 * 3.1 + idx) * 0.22)));
    g.lineTo(b.x + b.s, b.y + b.s); g.closePath(); g.fill();
    for (k2 = 0; k2 < n; k2++) {
      var bx = b.x + b.s * hash(k2 * 2.1 + idx * 5), bh = b.s * tall * (0.42 + hash(k2 * 3.7 + 1) * 0.58);
      g.strokeStyle = cols[k2 % 4] + (0.55 + hash(k2 * 1.9 + 2) * 0.45).toFixed(3) + ')';
      g.lineWidth = b.s * (0.006 + hash(k2 * 4.3 + 3) * 0.008);
      g.beginPath(); g.moveTo(bx, b.y + b.s);
      g.quadraticCurveTo(bx + b.s * (hash(k2 * 5.1 + 4) - 0.5) * 0.10, b.y + b.s - bh * 0.6,
                         bx + b.s * (hash(k2 * 6.3 + 5) - 0.5) * 0.22, b.y + b.s - bh);
      g.stroke();
    }
  }
  function clumps(idx, cols, body, n, holes) {
    var b = box(idx), k2, h2;
    g.fillStyle = body;
    g.fillRect(b.x, b.y + b.s * 0.11, b.s, b.s * 0.89);
    for (k2 = 0; k2 < n; k2++) {                    /* ragged top and sides */
      var cx3 = b.x + b.s * hash(k2 * 2.7 + idx), cy3 = b.y + b.s * (0.08 + hash(k2 * 3.3 + 1) * 0.92);
      g.fillStyle = cols[k2 % 4] + (0.45 + hash(k2 * 1.7 + 2) * 0.5).toFixed(3) + ')';
      g.beginPath();
      g.ellipse(cx3, cy3, b.s * (0.03 + hash(k2 * 4.9 + 3) * 0.05),
                b.s * (0.02 + hash(k2 * 5.3 + 4) * 0.035), hash(k2 * 6.1) * 3.14, 0, Math.PI * 2);
      g.fill();
    }
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (h2 = 0; h2 < holes; h2++) {
      g.fillStyle = 'rgba(0,0,0,1)';
      g.beginPath();
      g.arc(b.x + b.s * hash(h2 * 7.7 + idx * 11), b.y + b.s * (0.06 + hash(h2 * 8.3 + 1) * 0.30),
            b.s * (0.02 + hash(h2 * 9.1 + 2) * 0.05), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  tuft(N_PINE, PINE, 'rgba(96,124,74,1)', 130, 1.65);
  tuft(N_SPRAY, CEDR, 'rgba(102,130,82,1)', 115, 0.95);
  mass(N_MASS, PINE, 'rgba(74,98,58,1)');
  candles(N_CANDLE, CEDR, 'rgba(112,142,88,1)');
  blades(N_GRASS, PALE, 'rgba(176,189,156,1)', 42, 0.74);
  blades(N_DRY, DRYC, 'rgba(190,183,150,1)', 38, 0.66);
  clumps(N_HEDGE, HLEAF, 'rgba(118,132,100,1)', 46, 14);
  clumps(N_SHRUB, HLEAF, 'rgba(126,140,106,1)', 40, 10);

  /* ---- cell 8: the spruce.  A cooler, bluer green than cells 0-3, at
     about the same VALUE as they are: like them this cell carries the
     foliage colour and the vertex tone only trims it.  (Its first drawing
     was 2.8x darker in linear light, on the argument that a Picea under
     cloud is the darkest thing on the street.  It is - the refuge tree in
     the owner's April 2026 frames measures 34,38,29 at its median - but a
     bough is also looked at from underneath, where the rig hands it a fifth
     of the sky, and the two together rendered the tree at 12,14,11: a black
     cut-out.  The darkness belongs in SPRUCE_T, where it can be measured.)
     THE MIP RULE: an opaque lens under the strokes in both halves.
     THE GUTTER RULE: NGUT between the halves as well as round the cell. */
  (function () {
    var b = box(8), hh = (b.s - NGUT) * 0.5, t, w, u, nx, ny, nl;
    var A = { x: b.x, y: b.y, w: b.s, h: hh };
    var B = { x: b.x, y: b.y + hh + NGUT, w: b.s, h: hh };
    function rectOf(r) {
      var ins = 3;
      return [(r.x + ins) / NRES, 1 - (r.y + r.h - ins) / NRES,
              (r.x + r.w - ins) / NRES, 1 - (r.y + ins) / NRES];
    }
    NR_BOUGH = rectOf(A); NR_HANG = rectOf(B);
    var COL = ['rgba(141,192,144,', 'rgba(112,160,118,', 'rgba(179,234,166,', 'rgba(90,131,99,'];
    var WOOD = 'rgba(96,80,64,1)';
    function needle(x0, y0, dx, dy, ci, al) {
      g.strokeStyle = COL[ci & 3] + al.toFixed(2) + ')';
      g.lineWidth = 1.25;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + dx, y0 + dy); g.stroke();
    }

    /* A: the bough in plan */
    g.save(); g.beginPath(); g.rect(A.x, A.y, A.w, A.h); g.clip();
    var cy = A.y + A.h * 0.5;
    g.fillStyle = 'rgba(93,134,99,1)';
    g.beginPath(); g.moveTo(A.x + 2, cy);
    for (k = 0; k <= 16; k++) {
      t = k / 16;
      w = A.h * 0.41 * Math.sin(Math.pow(t, 0.55) * Math.PI) * (0.80 + 0.40 * hash(k * 3.7 + 801));
      g.lineTo(A.x + 2 + (A.w - 6) * t, cy - w);
    }
    for (k = 16; k >= 0; k--) {
      t = k / 16;
      w = A.h * 0.41 * Math.sin(Math.pow(t, 0.55) * Math.PI) * (0.80 + 0.40 * hash(k * 5.3 + 811));
      g.lineTo(A.x + 2 + (A.w - 6) * t, cy + w);
    }
    g.closePath(); g.fill();
    g.strokeStyle = WOOD; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(A.x + 2, cy); g.lineTo(A.x + A.w * 0.93, cy); g.stroke();
    for (k = 0; k < 9; k++) {                       /* side shoots, swept forward */
      var st = 0.07 + k * 0.096, sx = A.x + A.w * st, side = (k & 1) ? 1 : -1;
      var sl = A.h * (0.44 - 0.25 * st) * (0.80 + 0.40 * hash(k * 2.9 + 821));
      var ex = sx + sl * 0.95, ey = cy + side * sl * 0.80;
      g.strokeStyle = 'rgba(86,74,61,0.92)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(sx, cy); g.lineTo(ex, ey); g.stroke();
      for (j = 0; j < 22; j++) {
        u = j / 22; nl = 3.0 + 3.2 * hash(k * 31 + j * 7 + 831);
        needle(sx + (ex - sx) * u, cy + (ey - cy) * u, nl * 0.75, ((j & 1) ? nl : -nl) * 0.8,
               k + j, 0.70 + 0.30 * hash(j * 3.1 + k));
      }
    }
    for (j = 0; j < 150; j++) {                     /* needles on the leader itself */
      u = Math.pow(hash(j * 1.7 + 841), 0.8); nl = 3 + 4 * hash(j * 2.3 + 851);
      nx = A.x + 2 + A.w * 0.92 * u;
      ny = cy + (hash(j * 4.1 + 861) - 0.5) * A.h * 0.62 * Math.sin(Math.pow(u, 0.55) * Math.PI);
      needle(nx, ny, nl * 0.8, (hash(j * 6.7 + 881) - 0.5) * nl * 1.6, j, 0.60 + 0.40 * hash(j * 5.9 + 871));
    }
    g.restore();

    /* B: the pendulous spray in elevation */
    g.save(); g.beginPath(); g.rect(B.x, B.y, B.w, B.h); g.clip();
    var ty = B.y + B.h * 0.15;
    g.fillStyle = 'rgba(86,128,96,1)';
    g.beginPath(); g.moveTo(B.x + 2, ty - B.h * 0.10);
    g.lineTo(B.x + B.w - 4, ty - B.h * 0.03);
    for (k = 14; k >= 0; k--) {
      t = k / 14;
      var dep = B.h * (0.26 + 0.52 * Math.sin(Math.pow(t, 0.7) * Math.PI) * (0.60 + 0.40 * hash(k * 7.1 + 901)));
      g.lineTo(B.x + 2 + (B.w - 6) * t, ty + dep);
    }
    g.closePath(); g.fill();
    g.strokeStyle = WOOD; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(B.x + 2, ty); g.lineTo(B.x + B.w * 0.95, ty + B.h * 0.05); g.stroke();
    for (k = 0; k < 15; k++) {
      var hx = B.x + B.w * (0.05 + k * 0.062);
      var hl = B.h * (0.34 + 0.44 * hash(k * 4.3 + 911)) * (0.60 + 0.40 * Math.sin((k / 14) * Math.PI));
      var sway = (hash(k * 8.9 + 921) - 0.5) * 10;
      g.strokeStyle = 'rgba(83,70,58,0.92)'; g.lineWidth = 1.3;
      g.beginPath(); g.moveTo(hx, ty);
      g.quadraticCurveTo(hx + sway * 0.3, ty + hl * 0.5, hx + sway, ty + hl); g.stroke();
      for (j = 0; j < 16; j++) {
        u = j / 16; nl = 3 + 3 * hash(k * 13 + j * 5 + 931);
        needle(hx + sway * u * u, ty + hl * u, (j & 1) ? nl : -nl, nl * 0.7,
               k + j, 0.65 + 0.35 * hash(j * 2.7 + k * 3));
      }
    }
    g.restore();
  })();
  return c;
}

/* ---- card emitters ----------------------------------------------------
   All three write EXPLICIT per-vertex uv from an atlas rect; none of them ever
   touch the planar projector.  `face`, where given, is the direction the card
   must look: u is negated if u x v opposes it, which is the fix for every shop
   fascia that read in mirror writing from behind. */
function atlasCard(pile, rect, cx, cy, cz, ux, uy, uz, vx, vy, vz, ao, tone, face) {
  var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (face && (nx * face[0] + ny * face[1] + nz * face[2]) < 0) {
    ux = -ux; uy = -uy; uz = -uz;
    nx = -nx; ny = -ny; nz = -nz;
  }
  var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(l > 1e-9)) { warn('card: degenerate axes'); return; }
  nx /= l; ny /= l; nz /= l;
  var b = pile.n;
  pile.vert(cx - ux - vx, cy - uy - vy, cz - uz - vz, nx, ny, nz, rect[0], rect[1], ao, tone);
  pile.vert(cx + ux - vx, cy + uy - vy, cz + uz - vz, nx, ny, nz, rect[2], rect[1], ao, tone);
  pile.vert(cx + ux + vx, cy + uy + vy, cz + uz + vz, nx, ny, nz, rect[2], rect[3], ao, tone);
  pile.vert(cx - ux + vx, cy - uy + vy, cz - uz + vz, nx, ny, nz, rect[0], rect[3], ao, tone);
  pile.tri(b, b + 1, b + 2); pile.tri(b, b + 2, b + 3);
}

/* signCard(pile, slot, cx,cy,cz, ux,uy,uz, vx,vy,vz, capH, tone [, face])
   u and v are DIRECTIONS (they are normalised here); the board's world size
   comes from the slot's aspect and the CAP HEIGHT, default 0.9625 u, so every
   sign on the street carries the same letterforms whatever board it is on.
   For the pictorial slots - sokak, numara, cross, alem, hazard - capFrac is 1,
   so capH IS the card height.
   M.sign is FrontSide by contract: for a double-sided card (for example a
   minaret alem) call this twice with u negated. */
function signCard(pile, slot, cx, cy, cz, ux, uy, uz, vx, vy, vz, capH, tone, face) {
  var s = SIGN.slot[String(slot).toLowerCase()];
  if (!s) { warn('unknown sign slot ' + slot); return null; }
  var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  var vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  ux /= ul; uy /= ul; uz /= ul; vx /= vl; vy /= vl; vz /= vl;
  var h = (capH > 0 ? capH : SIGN_CAP) / s.capFrac;
  var w = h * s.aspect;
  atlasCard(pile, s.rect, cx, cy, cz, ux * w * 0.5, uy * w * 0.5, uz * w * 0.5,
       vx * h * 0.5, vy * h * 0.5, vz * h * 0.5, 1, tone, face);
  STATS.signs++;
  return { w: w, h: h };
}

/* the world size a slot will take at a given cap height, WITHOUT emitting it.
   Read it before placing a board on a short frontage; scale capH down rather
   than let lettering overhang the opening it belongs to. */
function signSize(slot, capH) {
  var s = SIGN.slot[String(slot).toLowerCase()];
  if (!s) return null;
  var h = (capH > 0 ? capH : SIGN_CAP) / s.capFrac;
  return { w: h * s.aspect, h: h, aspect: s.aspect };
}

/* decalCard(pile, slot, cx,cy,cz, ux,uy,uz, vx,vy,vz, w, h, tone [, face])
   u and v are DIRECTIONS; w and h are the card's FULL width and height in
   world units, because a streak is sized by the sill it hangs from, not by a
   cap height.

   TWO THINGS HAPPEN HERE that the atlas cannot do for itself.

   (1) ORIENTATION.  atlasCard puts the cell's canvas TOP on the card's +V, so
   a wash that has a head and a foot lands upside down the moment a caller
   passes V pointing DOWN - and the parts disagree about that: side-2's cill
   streaks, rust weeps and drips all pass (0,-1,0) while side-4 and side-6
   pass (0,1,0) for the same four cells.  Rather than legislate a convention
   across four files that four agents own, the four DIRECTIONAL cells get
   their v0/v1 swapped when the card's V points down, so the head of the wash
   always lands at the head of the card.  Swapping UVs does not touch the
   normal - atlasCard takes that from the u/v vectors - so facing is unchanged.
   The bloom, the two castings and the weed have no up, and are left alone.

   (2) TONE FLOOR.  The wash cells are drawn PALE now and the caller's tone is
   the albedo, which is right; but the callers mix 0.42..0.62 toward C.dark
   and anything darker again would push the wash past the 10-25 per cent a
   real one reaches and back into ink.  0.18 linear is about 118 sRGB: on a
   cream wall mix(C.cream, C.dark, 0.62) is 0.306, so this never bites on the
   tones in the tree today - it is a floor under a future caller, not a
   correction to a present one.  It does NOT apply to grate, manhole or weed,
   which are a casting, a casting and a plant. */
var DEC_WASH = { streak: 1, ground: 1, algae: 1, rust: 1, drip: 1 };
var DEC_UPRIGHT = { streak: 1, ground: 1, rust: 1, drip: 1 };
var DEC_TONE_FLOOR = 0.18;
function decalCard(pile, slot, cx, cy, cz, ux, uy, uz, vx, vy, vz, w, h, tone, face) {
  var key = String(slot).toLowerCase().replace(/^d_/, '');
  var s = DEC.slot[key] || DEC.slot[DEC_ALIAS[key]];
  if (!s) { warn('unknown decal slot ' + slot); return; }
  var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  var vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  ux /= ul; uy /= ul; uz /= ul; vx /= vl; vy /= vl; vz /= vl;
  var r = s.rect;
  /* -0.2, not 0: a card whose V lies in the horizontal plane has no head and
     must not be flipped by a rounding error in the caller's direction */
  if (DEC_UPRIGHT[s.key] && vy < -0.2) r = [r[0], r[3], r[2], r[1]];
  var t = tone;
  if (t && DEC_WASH[s.key])
    t = [t[0] < DEC_TONE_FLOOR ? DEC_TONE_FLOOR : t[0],
         t[1] < DEC_TONE_FLOOR ? DEC_TONE_FLOOR : t[1],
         t[2] < DEC_TONE_FLOOR ? DEC_TONE_FLOOR : t[2]];
  atlasCard(pile, r, cx, cy, cz, ux * w * 0.5, uy * w * 0.5, uz * w * 0.5,
       vx * h * 0.5, vy * h * 0.5, vz * h * 0.5, 1, t, face);
  STATS.decals++;
}

/* ncard(pile, rect, cx,cy,cz, ux,uy,uz, vx,vy,vz, tone)
   rect is a cell INDEX (0..8) or an explicit [u0,v0,u1,v1]; u and v are
   HALF-EXTENT vectors, so the card spans centre +- u +- v. */
function ncard(pile, rect, cx, cy, cz, ux, uy, uz, vx, vy, vz, tone) {
  var r = (typeof rect === 'number') ? NRECT[rect] : rect;
  if (!r || r.length !== 4) { warn('ncard: bad rect ' + rect); return; }
  atlasCard(pile, r, cx, cy, cz, ux, uy, uz, vx, vy, vz, 1, tone);
}
/* ncardN(pile, rect, cx,cy,cz, ux,uy,uz, vx,vy,vz, nx,ny,nz, tone, flipV)
   ncard with the STORED normal given instead of derived from u x v.
   A near-horizontal card of foliage lit as the plane it is drawn on comes
   out wrong twice over: its top takes the whole sky and its underside only
   what the road bounces back (0.18 against 1.4 in the overcast rig), so one
   bough is seven times brighter from above than from the pavement.  A real
   spray is a volume of needles pointing every way and is never that far
   apart on its two sides.  Giving the card a normal that leans OUT of the
   crown rather than straight up puts both of its faces near the horizon's
   irradiance, and sends its bake rays where a branch tip actually looks.
   The triangles are wound so the front face is the one the normal leaves by
   (DoubleSide turns the normal over for the other); flipV mirrors the
   texture across the card WITHOUT turning either of them. */
function ncardN(pile, rect, cx, cy, cz, ux, uy, uz, vx, vy, vz, nx, ny, nz, tone, flipV) {
  var r = (typeof rect === 'number') ? NRECT[rect] : rect;
  if (!r || r.length !== 4) { warn('ncardN: bad rect ' + rect); return; }
  var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(l > 1e-9)) { atlasCard(pile, r, cx, cy, cz, ux, uy, uz, vx, vy, vz, 1, tone); return; }
  nx /= l; ny /= l; nz /= l;
  var v0 = flipV ? r[3] : r[1], v1 = flipV ? r[1] : r[3];
  var gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
  var b = pile.n;
  pile.vert(cx - ux - vx, cy - uy - vy, cz - uz - vz, nx, ny, nz, r[0], v0, 1, tone);
  pile.vert(cx + ux - vx, cy + uy - vy, cz + uz - vz, nx, ny, nz, r[2], v0, 1, tone);
  pile.vert(cx + ux + vx, cy + uy + vy, cz + uz + vz, nx, ny, nz, r[2], v1, 1, tone);
  pile.vert(cx - ux + vx, cy - uy + vy, cz - uz + vz, nx, ny, nz, r[0], v1, 1, tone);
  if (gx * nx + gy * ny + gz * nz >= 0) { pile.tri(b, b + 1, b + 2); pile.tri(b, b + 2, b + 3); }
  else { pile.tri(b, b + 2, b + 1); pile.tri(b, b + 3, b + 2); }
}
/* two crossed cards standing on (x,y,z), w wide and h tall, yawed by rot */
function ncross(pile, rect, x, y, z, w, h, rot, tone) {
  var c1 = Math.cos(rot || 0), s1 = Math.sin(rot || 0);
  ncard(pile, rect, x, y + h * 0.5, z, c1 * w * 0.5, 0, s1 * w * 0.5, 0, h * 0.5, 0, tone);
  ncard(pile, rect, x, y + h * 0.5, z, -s1 * w * 0.5, 0, c1 * w * 0.5, 0, h * 0.5, 0, tone);
}

/* ---- materials --------------------------------------------------------
   Everything goes through NZ.street.day() so this module is graded by the same
   overcast solver as the rest of the street; without it the two arms take the
   night rig at the exact moment the player steps off a daylit junction into
   them.  The 'nzday:' name prefix is load-bearing: nz-render.js:2282 only
   skips neutralizeBakedLighting() for that prefix, and getting it wrong lands
   the street up to 4.5 stops out of exposure. */
function stDay(mat, name, env) {
  var ST = NZ.street;
  mat.name = 'nzday:street-side-' + name;
  if (ST && ST.day) {
    try { ST.day(mat, { name: 'street-side-' + name, intensity: env === undefined ? 0.72 : env }); }
    catch (e) { warn('day() refused ' + name); }
  }
  OWN.mat.push(mat);
  return mat;
}
function mkMat(name, map, rough, metal, opts) {
  opts = opts || {};
  var mt = new THREE.MeshStandardMaterial({
    map: map || null, color: 0xffffff, roughness: rough, metalness: metal,
    vertexColors: true, fog: true, dithering: true,
    side: opts.side || THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity === undefined ? 1 : opts.opacity,
    alphaTest: opts.alphaTest || 0,
    depthWrite: opts.depthWrite === undefined ? true : opts.depthWrite
  });
  if (opts.normalMap) {
    mt.normalMap = opts.normalMap;
    mt.normalScale = new THREE.Vector2(opts.normalScale || 0.6, opts.normalScale || 0.6);
  }
  return stDay(mt, name, opts.env);
}

var P = null, M = null;
function initPiles() {
  /* tile is world units per texture repeat; macro is how hard the positional
     grime field bites (steel 0.20-0.40, concrete 0.40-0.75, wall 0.45-0.68,
     brick 0.45, trim 0.20-0.50, alpha piles 0) */
  P = {
    asphalt: new Pile('asphalt', 10, 0.55),
    paver:   new Pile('paver', 8.2, 0.45),
    render:  new Pile('render', 9, 0.58),
    brick:   new Pile('brick', 9, 0.45),
    stone:   new Pile('stone', 7, 0.50),
    roof:    new Pile('roof', 8.6, 0.45),
    /* tile m(0.4) = 1.4, not 4: real steel is a fine surface and at tile 4 a
       barricade post carried a quarter of a mill grain over its whole length */
    metal:   new Pile('metal', 1.4, 0.30),
    joinery: new Pile('joinery', 3.5, 0.22),
    glass:   new Pile('glass', 8, 0.10),
    sign:    new Pile('sign', 1, 0),
    decal:   new Pile('decal', 1, 0),
    needle:  new Pile('needle', 1, 0),
    mark:    new Pile('mark', 6, 0.30),
    wire:    new Pile('wire', 24, 0.20)
  };

  var cAsp = asphaltTex(), cPav = paverTex(), cRen = renderTex(), cSto = stoneTex();
  var cBrk = brickTex(), cRf = roofTex();
  var tAsp = mkTex(cAsp), tPav = mkTex(cPav), tRen = mkTex(cRen), tSto = mkTex(cSto);
  var tBrk = mkTex(cBrk), tRf = mkTex(cRf);
  var nRen = mkTex(normalTex(cRen, 2.6), false, true);
  var nSto = mkTex(normalTex(cSto, 3.4), false, true);
  var nBrk = mkTex(normalTex(cBrk, 3.0), false, true);
  var nRf = mkTex(normalTex(cRf, 3.8), false, true);
  var tPvc = mkTex(pvcTex()), tStl = mkTex(steelTex()), tMk = mkTex(markTex());
  var tSign = mkTex(signAtlas(), true);
  var tDec = mkTex(decalAtlas(), true);
  var tNdl = mkTex(needleAtlas(), true);
  SIGN.tex = tSign; DEC.tex = tDec;

  M = {
    asphalt: mkMat('asphalt', tAsp, 0.97, 0, { env: 0.46 }),
    paver:   mkMat('paver', tPav, 0.96, 0, { env: 0.54 }),
    render:  mkMat('render', tRen, 0.95, 0, { env: 0.58, normalMap: nRen, normalScale: 0.55 }),
    brick:   mkMat('brick', tBrk, 0.95, 0, { env: 0.56, normalMap: nBrk, normalScale: 0.70 }),
    stone:   mkMat('stone', tSto, 0.99, 0, { env: 0.50, normalMap: nSto, normalScale: 0.50 }),
    roof:    mkMat('roof', tRf, 0.92, 0, { env: 0.52, normalMap: nRf, normalScale: 0.85 }),
    /* REAL STEEL ONLY.  Every white PVC frame, mullion, transom, balcony rail
       and grey PVC downpipe used to go through this material, which is
       metalness 0.62 with no map, so all of them rendered as tinted chrome: a
       metalness 0.62 surface has almost no diffuse lobe left to carry a tone. */
    metal:   mkMat('metal', tStl, 0.58, 0.62, { env: 0.60 }),
    /* the joinery pile is the most important material fix in the module */
    joinery: mkMat('joinery', tPvc, 0.42, 0.02, { env: 0.55 }),
    /* depthWrite FALSE, or panes behind panes punch holes in each other.  A
       real pane on an overcast day is DARK - it shows the room behind it -
       with one weak sheen; env 0.80 at roughness 0.16 was a near-mirror of the
       whole dome and the first render came back with white slabs. */
    glass:   mkMat('glass', null, 0.28, 0.05, {
               env: 0.34, transparent: true, opacity: 0.78,
               depthWrite: false, side: THREE.DoubleSide }),
    /* FrontSide: DoubleSide plus a one-sided wall means every shop fascia
       reads in mirror writing from behind the facade */
    sign:    mkMat('sign', tSign, 0.80, 0, { env: 0.60, alphaTest: 0.28, side: THREE.FrontSide }),
    /* A WEATHERING DECAL IS BLENDED, NOT ALPHA-TESTED.  This carried
       alphaTest 0.42 with transparent false, and on a soft wash that single
       number IS the ink-splat artifact: every texel under 0.42 is DISCARDED
       and every texel over it is drawn at FULL opacity, so a fan that should
       read as a 20 per cent darkening comes back as a hard-edged near-black
       island wherever the gradient happened to cross the threshold, and
       nothing anywhere in between.  A wash has no threshold in it.
       transparent true + depthWrite false keeps the soft body and never
       punches a hole in the wall behind it; alphaTest drops to 0.02, which is
       there for one job only - killing the empty gutter and the far tail of
       a fan so neither costs a blend.  Peak alpha in the five wash cells is
       0.24..0.38, so at 0.02 the cull line is 8 per cent of the weakest peak
       and no shape in the atlas has an edge on it. */
    decal:   mkMat('decal', tDec, 0.95, 0, {
               env: 0.55, alphaTest: 0.02, side: THREE.DoubleSide,
               transparent: true, depthWrite: false }),
    needle:  mkMat('needle', tNdl, 1, 0, { env: 0.46, alphaTest: 0.34, side: THREE.DoubleSide }),
    mark:    mkMat('mark', tMk, 0.94, 0, { env: 0.50 }),
    /* THE OVERHEAD CABLE GETS ITS OWN MATERIAL, and the reason is worth the
       four lines. A 22 mm strand is a sub-pixel object at every distance the
       player sees it from, and it carried a weathered-ACSR albedo of 0.043 --
       i.e. black -- yet rendered as twenty-odd PALE stripes across the sky of
       the opening frame. The albedo was never the problem: on P.metal at
       env 0.55 the strand's single fixed normal, tipped 45 degrees UP, put a
       camera looking up at it near 90 degrees of incidence, where Fresnel goes
       to 1 and EnvironmentBRDF hands the cable the whole sky dome, blurred by
       roughness into a flat neutral. Under an overcast white sky that was
       invisible; under a blue one it is a picket fence. No maps, roughness
       0.90, env 0.14: what is left is a dark cable with a thin sheen. */
    wire:    mkMat('wire', null, 0.90, 0.55, { env: 0.14 })
  };
}

/* ===========================================================================
   SECTION 4  BAKE TABLE, OCC REGISTRY, meshAll
   ===========================================================================
   THE ORDER HERE IS THE WHOLE THING.  NZ.street.bake() does setAttribute
   ('color', ...) with an ACHROMATIC sky-visibility term: it REPLACES whatever
   is in the colour attribute, it does not modulate it.  Handing it a geometry
   that already carries the palette throws the palette away and lands every
   wall on this street as the same grey concrete, which is exactly what the
   first render came back as.  Bake first, multiply the pile's own tone into
   the result second - and it is also what lets nz-street-sky's deferred
   occluder replay multiply a RATIO into the same attribute later, because our
   albedo is already a factor in it.

   EVERY entry carries occluders: OCC.  The module registered ZERO of them
   before this pass, and at the `low` tier every headless shot uses, this bake
   is the ONLY ambient occlusion in frame - so every barricade, tree, minaret
   and the whole 15.7 m gate block floated on flat-lit asphalt.  That, not the
   triangle count, is what "cartoonish" was.
   ======================================================================== */
var BAKE = {
  asphalt: { rays: 4, floor: 0.58, scale: 0.97, occluders: OCC },
  paver:   { rays: 5, floor: 0.54, scale: 0.96, occluders: OCC },
  render:  { rays: 6, floor: 0.46, scale: 0.95, occluders: OCC },
  brick:   { rays: 6, floor: 0.45, scale: 0.95, occluders: OCC },
  stone:   { rays: 6, floor: 0.43, scale: 0.94, occluders: OCC },
  roof:    { rays: 5, floor: 0.48, scale: 0.94, occluders: OCC },
  metal:   { rays: 4, floor: 0.42, scale: 0.93, occluders: OCC },
  joinery: { rays: 5, floor: 0.44, scale: 0.94, occluders: OCC },
  glass:   { rays: 3, floor: 0.56, scale: 0.98, occluders: OCC },
  sign:    { rays: 3, floor: 0.64, scale: 1.00, occluders: OCC },
  decal:   { rays: 3, floor: 0.60, scale: 0.98, occluders: OCC },
  needle:  { rays: 3, floor: 0.56, scale: 0.97, occluders: OCC },
  mark:    { rays: 3, floor: 0.60, scale: 0.98, occluders: OCC },
  wire:    { rays: 3, floor: 0.62, scale: 0.98, occluders: OCC }
};
/* a fixed draw order, so a shot is comparable with the last one */
var PILE_ORDER = ['asphalt', 'paver', 'render', 'brick', 'stone', 'roof',
                  'metal', 'joinery', 'glass', 'sign', 'decal', 'needle', 'mark',
                  'wire'];

function stBake(geo, opts) {
  var ST = NZ.street;
  if (ST && ST.bake) {
    try { return ST.bake(geo, opts); }
    catch (e) { warn('bake() refused ' + opts.name + ': ' + (e && e.message)); }
  }
  /* no sky module: a flat 0.88 so the tone still lands somewhere sane */
  if (geo && geo.attributes && geo.attributes.position) {
    var n = geo.attributes.position.count, a = new Float32Array(n * 3), i;
    for (i = 0; i < a.length; i++) a[i] = 0.88;
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  return geo;
}

function meshAll() {
  var k, i;
  for (k = 0; k < PILE_ORDER.length; k++) {
    var key = PILE_ORDER[k], pl = P[key];
    if (!pl || !pl.n) { DIAG.piles.push({ name: key, verts: 0, tris: 0 }); continue; }
    var g = pl.geometry();
    var opt = BAKE[key] || { rays: 5, floor: 0.48, scale: 0.95, occluders: OCC };
    opt.name = 'street-side-' + key;
    stBake(g, opt);
    var ca = g.attributes.color, arr = ca && ca.array;
    if (!arr) {
      arr = new Float32Array(pl.n * 3);
      for (i = 0; i < arr.length; i++) arr[i] = 1;
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      ca = g.attributes.color;
    }
    for (i = 0; i < Math.min(arr.length, pl.tone.length); i++) arr[i] *= pl.tone[i];
    ca.needsUpdate = true;
    var mesh = new THREE.Mesh(g, M[key]);
    mesh.name = 'nz-street-side:' + key;
    /* the decal pile is blended now, so glass and decal are the module's only
       two transparent meshes and three.js has to be told which composites
       over which.  A decal is always ON a wall and a pane is always in a
       reveal BEHIND one, so the decals draw first: renderOrder sorts within
       the transparent list only, it does not move either mesh ahead of the
       opaque pass. */
    if (key === 'decal') mesh.renderOrder = -1;
    mesh.castShadow = false;
    mesh.receiveShadow = (key !== 'glass' && key !== 'sign' && key !== 'decal' &&
                          key !== 'needle' && key !== 'mark');
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    OWN.obj.push(mesh);
    var tris = (pl.idx.length / 3) | 0;
    STATS.draws++; STATS.tris += tris; STATS.verts += pl.n;
    DIAG.piles.push({ name: key, verts: pl.n, tris: tris });
  }
}

/* ===========================================================================
   SECTION 5  THE RUN TABLE (data only)
   ===========================================================================
   Thirteen runs, PURE DATA with no behaviour.  One agent renders the skin of
   each run, another the mass, roof and returns; they read the same table,
   share no function, and neither may add a field to it.

   x is the FACE PLANE and already includes the 0.02 PROUD offset; dir is +1
   for a face looking toward +x and -1 toward -x.  Every z-extent below is
   grid-verified against NUKEM.html and two of them are corrections:

     N-E2 ENDS AT z 140, NOT 144.  Grid cells 145/35-36 (z 140..148) are FLOOR
     on both sides - that is the walkable passage between the roundabout apron
     and A-BLOK's private forecourt, and the old wall stood across it.
     S-W1 STARTS AT z 212, NOT 208, for the same reason at cells 136/52 and
     137/52.  X-W-N stops at 140 (cells 189-190/35-37 are floor) and X-W-S
     starts at 208 (cells 189-190/51 are floor).

   THE HOLES ARE THE GRID'S DOORS, and they are not decoration.  buildWorld
   draws a door header from min(c, f+8.2) to the region ceiling on both open
   faces, and out here the ceiling is 52; every gameplay door on this junction
   is deliberately on a plane where this module leaves a hole in its wall.
   Move a hole and the engine's lintel lands on 50 m of authored siding.

   N-W3 is the photographed corner pharmacy; S-E1 is an ordinary residential
   corner with no commercial fascia.

   The block-name boards in the sign atlas ('kizil', 'degerli', 'onurlu') are
   NOT in the sign field: that field is the SHOPFRONT sign, and a residential
   run has none.  Anyone lettering a parapet reads the run's own name.
   ======================================================================== */
var RUNS = [
  {
    id: 'N-E1', name: 'KIZILCALAR APT.',
    x: 579.98, dir: -1, z0: 56, z1: 96,
    storeys: 4, top: 51.8, tone: C.ochre    /* N-E1  KIZILCALAR: warm ochre, the lit west-facing run */, bays: 4,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [
      { z0: 84, z1: 88, y0: 0.5, y1: 11.2 },        /* grid 145/21, S_DOOR    */
      { z0: 64, z1: 72, y0: 11.2, y1: 21.0 }        /* grid 145/16-17, rLoggia*/
    ],
    roof: true, cornice: true,
    massPier: [{ x0: 580.0, x1: 584.0, y0: 0, y1: 51.8, z0: 56, z1: 96 }],
    massBlock: [{ x0: 584.0, x1: 625.5, y0: 21.0, y1: 51.8, z0: 56, z1: 96 }],
    capA: true, capB: false
  },
  {
    id: 'N-E2', name: 'SEYDIKENT A-BLOK WEST GABLE',
    x: 579.98, dir: -1, z0: 96, z1: 140,
    storeys: 4, top: 51.8, tone: C.butter   /* N-E2  A-BLOK gable: butter, keyed to A-BLOK cream siding */, bays: 5,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [{ z0: 128, z1: 132, y0: 0.5, y1: 11.2 }],   /* grid 145/32, residential door */
    /* no roof: nz-street.js roofs A-BLOK over x 577.90..758.10, z 94.50..142.10,
       y 53.06..64.00, and a second hip on the same footprint is two roofs
       fighting for the same depth buffer along one ridge */
    roof: false, cornice: true,
    massPier: [{ x0: 580.0, x1: 584.0, y0: 0, y1: 51.8, z0: 96, z1: 140 }],
    massBlock: [{ x0: 584.0, x1: 625.5, y0: 21.0, y1: 51.8, z0: 96, z1: 140 }],
    capA: false, capB: false
  },
  {
    id: 'N-W1', name: '232 SK MODERN APARTMANI',
    x: 484.02, dir: 1, z0: 56, z1: 88,
    storeys: 4, top: 51.8, tone: C.terra    /* N-W1  MODERN: terracotta, the darkest block on the north arm */, bays: 3,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [],
    roof: true, cornice: true,
    massPier: [{ x0: 480.0, x1: 484.0, y0: 0, y1: 51.8, z0: 56, z1: 88 }],
    massBlock: [{ x0: 438.5, x1: 483.98, y0: 21.0, y1: 51.8, z0: 56, z1: 88 }],
    capA: true, capB: false
  },
  {
    id: 'N-W2', name: 'SILA APT. B-GIRIS',
    x: 484.02, dir: 1, z0: 88, z1: 124,
    storeys: 4, top: 51.8, tone: C.cream    /* N-W2  SILA */, bays: 4,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [],
    roof: true, cornice: true,
    /* mass stops at z 103.5: beyond it nz-street-park's northApartment is a
       genuine masonry box (x 490..548, z 103.80..144.38, y 0.55..51.30) whose
       east face is at x = 548, and a mass face of ours there would be coplanar
       with it for the full 40 u.  The pier face at x = 548 is safe SOUTH of
       103.5 because park's box does not start until 103.8 - the coplanar risk
       is a z-range question, not an x one. */
    massPier: [{ x0: 480.0, x1: 484.0, y0: 0, y1: 51.8, z0: 88, z1: 103.5 }],
    massBlock: [{ x0: 438.5, x1: 483.98, y0: 21.0, y1: 51.8, z0: 88, z1: 103.5 }],
    capA: false, capB: false
  },
  {
    id: 'N-W3', name: 'GUVEN ECZANESI CORNER',
    x: 484.02, dir: 1, z0: 124, z1: 144,
    storeys: 4, top: 51.8, tone: C.sage     /* N-W3  ECZANESI corner */, bays: 2,
    /* The park apartment remains the solid mass behind this corner; this skin
       supplies the pharmacy glazing and fascia wrapped around its base. */
    ground: 'shop', shopZ0: 124.45, shopZ1: 143.25, sign: 'eczane',
    /* Always-open side entrance; the map carves the matching threshold. */
    holes: [{ z0: 136, z1: 140, y0: 1.55, y1: 9.25 }],
    /* no roof: park's northApartment roof covers x 488.8..549.2, z 102.5..146.0,
       y 51.30..56.80.  NO MASS EITHER - park's box is the mass here. */
    roof: false, cornice: true,
    massPier: [], massBlock: [],
    capA: false, capB: false
  },
  {
    id: 'S-E1', name: 'SEYDIKENT B-BLOK WEST GABLE',
    x: 579.98, dir: -1, z0: 208, z1: 256,
    storeys: 4, top: 51.8, tone: C.rose     /* S-E1  B-BLOK gable: keyed to B-BLOK salmon next door */, bays: 5,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [{ z0: 228, z1: 232, y0: 0.5, y1: 11.2 }],  /* grid 145/57 apartment entry */
    roof: false, cornice: true,                        /* nz-street.js roofs B-BLOK */
    massPier: [{ x0: 580.0, x1: 584.0, y0: 0, y1: 51.8, z0: 208, z1: 256 }],
    massBlock: [{ x0: 584.0, x1: 625.5, y0: 21.0, y1: 51.8, z0: 208, z1: 256 }],
    capA: false, capB: false
  },
  {
    id: 'S-E2', name: 'DEGERLI APT.',
    x: 579.98, dir: -1, z0: 260, z1: 296,
    storeys: 4, top: 51.8, tone: C.sand     /* S-E2  DEGERLI */, bays: 4,
    ground: 'garage', shopZ0: 262, shopZ1: 270, sign: 'garaj',
    holes: [
      { z0: 272, z1: 276, y0: 0.5, y1: 11.2 },       /* grid 145/68            */
      { z0: 284, z1: 292, y0: 11.2, y1: 21.0 }       /* grid 145/71-72, rLoggia*/
    ],
    roof: true, cornice: true,
    massPier: [{ x0: 580.0, x1: 584.0, y0: 0, y1: 51.8, z0: 260, z1: 296 }],
    massBlock: [{ x0: 584.0, x1: 625.5, y0: 21.0, y1: 51.8, z0: 260, z1: 296 }],
    capA: false, capB: true
  },
  {
    id: 'S-W1', name: 'KOMAGENE BLOCK',
    disabled: true,                         /* surveyed edge is open park */
    x: 548.02, dir: 1, z0: 212, z1: 254,
    storeys: 5, top: 61.95, tone: C.paleblu  /* S-W1  KOMAGENE (disabled) */, bays: 5,
    ground: 'shop', shopZ0: 216, shopZ1: 240, sign: 'komagene',
    holes: [],
    /* cornice only, box x 548.02..548.85 y 61.05..61.95: the roof over this
       corner is park's cornerBlock hip (x 544.40..556.20, z 201.80..302.80) */
    roof: false, cornice: true,
    /* 3.3 u deep and it CANNOT be deeper: x 524..544 is walkable park and
       park's cornerBlock owns x 547.34..548.00 */
    massPier: [{ x0: 544.0, x1: 547.3, y0: 0, y1: 61.95, z0: 212, z1: 254 }],
    massBlock: [],
    capA: true, capB: false
  },
  {
    id: 'S-W2', name: 'ONURLU APT.',
    disabled: true,                         /* surveyed edge is open park */
    x: 548.02, dir: 1, z0: 254, z1: 300,
    storeys: 5, top: 61.95, tone: C.olive    /* S-W2  ONURLU  (disabled) */, bays: 5,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [],
    roof: false, cornice: true,
    massPier: [{ x0: 544.0, x1: 547.3, y0: 0, y1: 61.95, z0: 254, z1: 300 }],
    massBlock: [],
    capA: false, capB: true
  },
  /* the two 230 Sk stubs.  All four stand PROUD 0.02 over buildWorld's own
     concrete on the vista rows (rCrossViewN/S declare openEdges north/south
     only, so the east and west faces DO get an engine quad, which is the mass
     below y 21) and all four are five storeys because the clad top must reach
     the region ceiling c = 52. */
  {
    id: 'X-W-N', name: '230 Sk NORTH WEST',
    x: 760.02, dir: 1, z0: 96, z1: 140,
    storeys: 5, top: 61.95, tone: C.bone     /* X-W-N 230 Sk NW: palest block; it faces east, in shade */, bays: 5,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [],
    roof: false, cornice: true,
    massPier: [],
    /* capped at 52.80: A-BLOK's roof is y 53.06..64.00 over x 577.90..758.10 */
    massBlock: [{ x0: 728.0, x1: 760.0, y0: 21.0, y1: 52.8, z0: 96, z1: 140 }],
    capA: true, capB: false
  },
  {
    id: 'X-W-S', name: '230 Sk SOUTH WEST',
    x: 760.02, dir: 1, z0: 208, z1: 260,
    storeys: 5, top: 61.95, tone: C.apricot  /* X-W-S 230 Sk SW: faces east, in shade */, bays: 6,
    ground: 'render', shopZ0: 0, shopZ1: 0, sign: null,
    holes: [],
    roof: false, cornice: true,
    massPier: [],
    massBlock: [{ x0: 728.0, x1: 760.0, y0: 21.0, y1: 52.8, z0: 208, z1: 260 }],
    capA: false, capB: true
  }
  /* X-E-N and X-E-S -- the two 230 Sk EAST elevations -- are deleted.
     Each stood an elevation at x 791.98 facing the stub and a 17.7 m mass
     behind it running x 792..824, and that mass's blank east gable faced the
     old checkpoint across eight units of road.  From the gate they were two
     featureless five-storey slabs framing the arch; the owner's note on them
     was "they are built weirdly anyway".  With the checkpoint gone to the
     crest, 233 Sk simply runs on to the police line with the terminus town
     and the range behind it, which is what every other closure on this map
     already does.  The two `bystander` runs at x 796..833.5, z 30..94 and
     262..318 still close the view further out. */
];

/* ===========================================================================
   SECTION 11  buildAll(), INSTALL, DISPOSE, REPORT
   ===========================================================================
   buildAll's body is fixed in advance so no builder agent has to touch it, and
   every stage runs inside its own try/catch: one bug in one section must not
   take the whole street down, and the warning it leaves is a diagnostic the
   headless harness surfaces.
   ======================================================================== */
function runStage(name, fn) {
  if (typeof fn !== 'function') { warn('missing builder ' + name); return; }
  try { fn(); }
  catch (e) {
    var msg = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);
    warn(name + ' threw: ' + msg.split('\n')[0]);
  }
}
function buildAll() {
  runStage('buildGround',   typeof buildGround   === 'function' ? buildGround   : null);
  runStage('buildRunSkins', typeof buildRunSkins === 'function' ? buildRunSkins : null);
  runStage('buildRunMass',  typeof buildRunMass  === 'function' ? buildRunMass  : null);
  runStage('buildCorners',  typeof buildCorners  === 'function' ? buildCorners  : null);
  runStage('buildFurniture', typeof buildFurniture === 'function' ? buildFurniture : null);
  runStage('buildTerminus', typeof buildTerminus === 'function' ? buildTerminus : null);
  runStage('buildCordon',   typeof buildCordon   === 'function' ? buildCordon   : null);
  runStage('buildExtraCordon', buildExtraCordon);
}

/* Other modules may stand more bariyer runs on the street before it is
   merged: nz-net.js fences the multiplayer arena on this map with them.
   They get the same builder the police lines use, so the panels join the
   piles above -- the same bake and tone, and no extra meshes. */
function buildExtraCordon() {
  if (!NZ.has || !NZ.has('streetSideCordon')) return;
  NZ.call('streetSideCordon', {
    barrierRun: barrierRun, armGroundY: cdArmGroundY,
    ROAD_TOP: ROAD_TOP, PAVE_TOP: PAVE_TOP, KERB_TOP: KERB_TOP, ROAD0: ROAD0, ROAD1: ROAD1
  });
}

/* our own facade records, in nz-street.js's shape, for future consumers.
   THEY ARE NOT PUSHED INTO NZ.street.facades: nz-street-props.js:3041 derives
   BAYD, SOFF_Y, SOFF_TOP and EAVES_Y from FACES[0] and copies gardenWall
   records wholesale, and nz-destruct.js:1534 does a nearest-facade search that
   today resolves to A-BLOK and B-BLOK near the junction.  Injecting W/E-axis
   records after props has adopted the array buys nothing and risks both, so
   232 Sk is simply not destructible. */
function buildFacadeRecords() {
  var out = [], i, j;
  for (i = 0; i < RUNS.length; i++) {
    var R = RUNS[i], gaps = [];
    if (R.disabled) continue;
    for (j = 0; j < R.holes.length; j++) gaps.push([R.holes[j].z0, R.holes[j].z1]);
    out.push({
      id: R.id, name: R.name,
      axis: 'x', inward: R.dir,
      plane: R.x - R.dir * PROUD,
      wallFace: R.x,
      bayFace: R.x,
      plinthFace: R.x + R.dir * PLINTH_D,
      eaveFace: R.x + R.dir * EAVE_OUT,
      bayA: R.z0, bayB: R.z1,
      soffitY: 10.80, soffitTopY: 11.70, plinthTop: PLINTH_TOP,
      eavesY: R.top, eaveOut: EAVE_OUT, ridgeY: R.roof ? R.top + 0.4 + HIP_RISE : R.top,
      gaps: gaps, blind: false, entrance: null, entrances: [],
      body: R.tone.slice()
    });
  }
  return out;
}

function dispose() {
  var i;
  for (i = 0; i < OWN.obj.length; i++) if (OWN.obj[i].parent) OWN.obj[i].parent.remove(OWN.obj[i]);
  for (i = 0; i < OWN.geo.length; i++) OWN.geo[i].dispose();
  for (i = 0; i < OWN.mat.length; i++) OWN.mat[i].dispose();
  for (i = 0; i < OWN.tex.length; i++) OWN.tex[i].dispose();
  OWN.obj.length = OWN.geo.length = OWN.mat.length = OWN.tex.length = 0;
  installed = false; STATS.ok = false;
  if (NZ.flags) NZ.flags.streetSide = false;
}

function panic(err) {
  dead = true;
  /* The message and the stack as STRINGS, not as an Error object: the headless
     harness surfaces console text, and an Error logged as an argument arrives
     at the other end as `JSHandle@error`, which is the least useful diagnostic
     in the project. */
  var msg = (err && (err.stack || err.message)) ? String(err.stack || err.message) : String(err);
  NZ.streetSide.error = msg;
  DIAG.warnings.push('threw: ' + msg.split('\n')[0]);
  try { dispose(); } catch (e) {}
  try { console.error('[nz-street-side] failed and disabled: ' + msg.split('\n').slice(0, 4).join(' | ')); } catch (e) {}
}

/* the arms may not be carved in this build, and this module must be inert
   rather than wrong if they are not */
function hasArms() {
  var G = global;
  if (typeof G.regAt !== 'function' || typeof G.cellAt !== 'function') return false;
  var R = G.regAt(140, 20);
  if (!R || !R.sky) return false;
  R = G.regAt(140, 66);
  return !!(R && R.sky);
}

function report() {
  var Ls = [];
  Ls.push('NZ-STREET-SIDE ' + (installed ? 'installed' : 'inert') +
    ' draws ' + STATS.draws + ' tris ' + STATS.tris + ' verts ' + STATS.verts +
    ' in ' + STATS.ms + 'ms, ' + DIAG.warnings.length + ' warnings');
  Ls.push('  runs ' + RUNS.length + ' elevations ' + STATS.elevations + ' masses ' + STATS.masses +
    ' roofs ' + STATS.roofs + ' returns ' + STATS.returns + ' quoins ' + STATS.quoins);
  Ls.push('  openings ' + STATS.openings + ' windows ' + STATS.windows + ' balconies ' +
    STATS.balconies + ' signs ' + STATS.signs + ' decals ' + STATS.decals);
  Ls.push('  road patches ' + STATS.roadPatches + ' gullies ' + STATS.gullies + ' marks ' +
    STATS.marks + ' lamps ' + STATS.lamps + ' trees ' + STATS.trees + ' pits ' + STATS.pits);
  Ls.push('  barricades ' + STATS.barricades + ' cones ' + STATS.cones + ' minarets ' +
    STATS.minarets + ' bystander blocks ' + STATS.buildings + ' distant vehicles ' + STATS.vehicles);
  Ls.push('  occluders ' + OCC.length + '/' + OCC_CAP + ' texture ' +
    (STATS.textureBytes / 1048576).toFixed(2) + ' MB');
  var i;
  for (i = 0; i < DIAG.piles.length; i++)
    if (DIAG.piles[i].tris) Ls.push('  pile ' + DIAG.piles[i].name + ' ' +
      DIAG.piles[i].verts + ' verts ' + DIAG.piles[i].tris + ' tris');
  if (DIAG.warnings.length) Ls.push('  warnings: ' + DIAG.warnings.join(' | '));
  return Ls.join('\n');
}

function install(ctx) {
  if (dead || installed) return;
  if (NZ.level !== 4) {
    NZ.log && NZ.log('street-side: level ' + NZ.level + ', module inert');
    return;
  }
  var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
  THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
  scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
  renderer = (ctx && ctx.renderer) || (NZ.ctx && NZ.ctx.renderer);
  if (!THREE || !scene) throw new Error('nz-street-side: renderer context missing');
  if (!global.document || !global.document.createElement) throw new Error('canvas document unavailable');
  if (!hasArms()) { NZ.log && NZ.log('street-side: 232 Sk not carved, module inert'); return; }

  /* ask the renderer rather than hardcoding 8: on a device that caps at 4 the
     hardcoded value is silently clamped and on one that offers 16 it is a
     third of the sharpness at grazing angles, which is every road surface */
  try {
    if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy)
      MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 4);
  } catch (e) { MAX_ANISO = 4; }

  overcastGround();
  initPiles();
  buildAll();
  meshAll();

  installed = true; STATS.ok = true;
  STATS.ms = Math.round(((global.performance && performance.now) ? performance.now() : Date.now()) - t0);
  if (NZ.flags) NZ.flags.streetSide = true;
  NZ.streetSide = {
    ok: true, loaded: true, stats: STATS, diag: DIAG,
    report: report, dispose: dispose,
    arms: { north: ARM_N, south: ARM_S },
    gate: { x: GATE_X, z0: 168, z1: 180 },
    facades: buildFacadeRecords()
  };
  NZ.log && NZ.log('street-side installed:\n' + report());
  /* the headless harness only surfaces a console line whose text matches
     /error|fail|panic|threw|missing/, so `threw:0` is what makes a self-report
     visible in a shot log at all */
  try {
    console.warn('[nz-street-side] threw:0 ' + report().split('\n')[0]);
  } catch (e) {}
}

if (NZ.flags && NZ.flags.streetSide === undefined) NZ.flags.streetSide = false;
if (DISABLED) {
  NZ.log && NZ.log('street-side disabled by ?nzside=0');
} else {
  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); } catch (err) { panic(err); }
  }, -60);
}
NZ.log && NZ.log('street-side module loaded');

/* ==== side-2-skin.js ==== */
/* =======================================================================
   SECTION 6   ELEVATION SKINS
   Walls, openings, windows, balconies, shopfronts, signage, services and
   grime for all thirteen runs of the RUNS table.  Mass, roofs, returns and
   quoins are SECTION 7; ground, furniture and planting SECTION 8.

   THE DEFECT THIS SECTION EXISTS TO FIX.  In the old module every proud
   element -- plinth, ground band, three floor bands, cornice, shop fascia,
   stallboard, glazing rails, shutter -- was a box() whose rear quad landed
   exactly ON the wall plane, so eleven runs z-fought themselves along every
   horizontal for their whole length; and the wall was emitted as one full
   sheet with the window assemblies laid BEHIND it, so all ~180 of them were
   hidden by their own wall.  Here the wall is punched (emitted as strips
   around every opening) and every proud element is a closed prism whose rear
   face sits at d = -0.02, i.e. 0.02 INSIDE the wall plane, where the wall
   quad in front of it occludes it.  Nothing here is coplanar with a wall.

   WHY skMouldZ() AND NOT sweep().  sweep(pile, profile, a, b, tone) takes a
   2-D section, but the kit contract does not pin down which way the section's
   local +u points when the sweep axis reverses, and this section sweeps along
   +z on the west flank and -z on the east flank.  A section that flips
   handedness on six of thirteen runs is a worse failure than a few extra
   triangles, so every moulding here is a closed prism emitted through poly(),
   whose `ref` argument -- a point inside the solid -- winds each facet
   outward with no orientation bookkeeping at all.  Same closed section, same
   absent rear quad, no convention left to get wrong.

   DIMENSIONS.  1 unit = 0.2857 m, U = 3.5.  Metric-authored sizes are written
   m(metres); the skin depths taken from the site plan are written as world
   units with the millimetre reading in the comment beside them, which is what
   a reader needs in order to check them against a tape measure.
   ==================================================================== */


/* -----------------------------------------------------------------------
   6.0  LOCAL EMITTERS

   Three oriented quads and two prism sweeps, all built on the kit's poly().
   poly(pile, pts, ref, ao, tone) points its normal AWAY from `ref`, so none
   of these has to track winding: the caller says which side the solid is on
   and the facet faces the other way.
   -------------------------------------------------------------------- */

/* a quad on a constant-x plane; dir +1 faces +x.  ref is parked 1 u behind
   the face, which is all poly() needs to decide the normal's sign. */
function skQuadX(pile, x, y0, y1, z0, z1, dir, ao, tone) {
  poly(pile, [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]],
       [x - dir * 1.0, (y0 + y1) * 0.5, (z0 + z1) * 0.5], ao, tone);
}

/* a quad on a constant-z plane; dirZ +1 faces +z */
function skQuadZ(pile, z, y0, y1, x0, x1, dirZ, ao, tone) {
  poly(pile, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]],
       [(x0 + x1) * 0.5, (y0 + y1) * 0.5, z - dirZ * 1.0], ao, tone);
}

/* a horizontal quad; dirY +1 faces up (a sill), -1 faces down (a soffit) */
function skQuadY(pile, y, x0, x1, z0, z1, dirY, ao, tone) {
  poly(pile, [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]],
       [(x0 + x1) * 0.5, y - dirY * 1.0, (z0 + z1) * 0.5], ao, tone);
}

/* ---- the moulding sweep ----------------------------------------------
   `sec` is a CONVEX closed section given as [[d, y], ...] where d is the
   distance PROUD of the face (negative = behind it; every section here starts
   at d = -0.02 so its rear face is buried in the wall) and y is an absolute
   height.  The section is extruded along z between two z values.
   Convex only: poly() fans its triangles from vertex 0, so a re-entrant
   section would fold over itself.  Every profile in this file -- plinth,
   bands, cornice, cill, lintel, panjur box, balcony slab, gutter -- is a
   chamfered rectangle or a half-disc, which is convex by construction. */
function skMouldZ(pile, sec, face, dir, z0, z1, ao, tone) {
  var n = sec.length, i, j, cd = 0, cy = 0;
  if (n < 3 || z1 - z0 < 1e-4) return;
  for (i = 0; i < n; i++) { cd += sec[i][0]; cy += sec[i][1]; }
  var ref = [face + dir * (cd / n), cy / n, (z0 + z1) * 0.5];
  var A = [], B = [];
  for (i = 0; i < n; i++) {
    A.push([face + dir * sec[i][0], sec[i][1], z0]);
    B.push([face + dir * sec[i][0], sec[i][1], z1]);
  }
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    poly(pile, [A[i], A[j], B[j], B[i]], ref, ao, tone);
  }
  poly(pile, A, ref, ao, tone);       /* end caps: a moulding that stops     */
  poly(pile, B, ref, ao, tone);       /* mid-run has to show its cut section */
}

/* the same prism on a constant-z face, swept along x.  Used by the balcony
   cheeks and by the west-mouth return, the one elevation on a z plane. */
function skMouldX(pile, sec, zface, zdir, x0, x1, ao, tone) {
  var n = sec.length, i, j, cd = 0, cy = 0;
  if (n < 3 || x1 - x0 < 1e-4) return;
  for (i = 0; i < n; i++) { cd += sec[i][0]; cy += sec[i][1]; }
  var ref = [(x0 + x1) * 0.5, cy / n, zface + zdir * (cd / n)];
  var A = [], B = [];
  for (i = 0; i < n; i++) {
    A.push([x0, sec[i][1], zface + zdir * sec[i][0]]);
    B.push([x1, sec[i][1], zface + zdir * sec[i][0]]);
  }
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    poly(pile, [A[i], A[j], B[j], B[i]], ref, ao, tone);
  }
  poly(pile, A, ref, ao, tone);
  poly(pile, B, ref, ao, tone);
}

/* ---- a chamfered box authored in face-relative depth ------------------
   Everything proud of a wall goes through here, because it is the one place
   that converts a depth range into an x range -- which is what guarantees
   that d0 = -0.02 lands 0.02 behind the face rather than on it.

   TRIANGLE ECONOMY.  boxC is 44 triangles against box6's 12, and boxC clamps
   its chamfer to 0.49 of the smallest half-extent -- so on a 46 mm window
   frame member the chamfer comes out at 11 mm, which is under one pixel at
   any distance the player ever sees that frame from, for 32 extra triangles
   on each of about 1400 members.  Anything whose smallest half-extent is
   below 0.14 u (40 mm) therefore goes to box6.  The arrises that matter --
   plinth, cornice, coping, cill, balcony nose -- are skMouldZ profiles with
   their chamfer written into the section, not boxes. */
function skBoxD(pile, face, dir, d0, d1, y0, y1, z0, z1, k, ao, tone) {
  var xa = face + dir * d0, xb = face + dir * d1;
  var cx = (xa + xb) * 0.5, hx = Math.abs(xb - xa) * 0.5;
  var hy = Math.abs(y1 - y0) * 0.5, hz = Math.abs(z1 - z0) * 0.5;
  if (hx < 1e-4 || hy < 1e-4 || hz < 1e-4) return;
  if (ao === undefined) ao = 1.0;
  if (k === undefined) k = 0.03;
  if (k <= 0 || Math.min(hx, Math.min(hy, hz)) < 0.14) {
    box6(pile, cx - hx, cx + hx, Math.min(y0, y1), Math.max(y0, y1),
         Math.min(z0, z1), Math.max(z0, z1), ao, tone);
    return;
  }
  boxC(pile, cx, (y0 + y1) * 0.5, (z0 + z1) * 0.5, hx, hy, hz, k, ao, tone);
}

/* ---- decal plumbing ---------------------------------------------------
   WI-1 names the eight cells of the 1024x512 decal atlas D_STREAK, D_GROUND,
   D_ALGAE, D_RUST, D_DRIP, D_GRATE, D_MANHOLE and D_WEED, but the kit
   contract does not say whether those ship as module-level constants or as
   string keys, and it gives decalCard()'s tail as "...".  Both shapes are
   resolved here, once, so a mismatch costs a warn() and a missing stain
   rather than a throw that takes the whole skin down.

   HANDEDNESS: u x v must be the OUTWARD face normal, or a card emitter that
   derives its facing from the cross product hangs the stain on the inside of
   the wall.  Every call site below satisfies it; the streak cards run v
   downward, so their u is (0,0,+dir) rather than (0,0,-dir). */
function skDecalCell(nm) {
  switch (nm) {
    case 'D_STREAK': if (typeof D_STREAK !== 'undefined') return D_STREAK; break;
    case 'D_GROUND': if (typeof D_GROUND !== 'undefined') return D_GROUND; break;
    case 'D_ALGAE':  if (typeof D_ALGAE  !== 'undefined') return D_ALGAE;  break;
    case 'D_RUST':   if (typeof D_RUST   !== 'undefined') return D_RUST;   break;
    case 'D_DRIP':   if (typeof D_DRIP   !== 'undefined') return D_DRIP;   break;
    case 'D_WEED':   if (typeof D_WEED   !== 'undefined') return D_WEED;   break;
  }
  return nm;
}

/* hu and hv are the card's FULL width and height, NOT half-extents.  That is
   the kit's own contract -- "w and h are the card's FULL width and height,
   because a streak is sized by the sill it hangs from, not by a cap height"
   -- and reading them as half-extents is what put every streak on this street
   a metre below its source and twice as long as it was written to be.  The
   short-tail branch below is for a decalCard whose axes carry their own
   length; that shape has never shipped, and if it ever does, the extents it
   wants are halves, so it takes hu and hv scaled by 0.5. */
function skDecal(pile, nm, cx, cy, cz, ux, uy, uz, vx, vy, vz, hu, hv, tone) {
  if (typeof decalCard !== 'function') {
    if (!skDecal.warned) { skDecal.warned = 1; warn('decalCard() missing: grime pass skipped'); }
    return;
  }
  var cell = skDecalCell(nm);
  /* Two plausible tails: unit axes plus a full width and height (13+
     parameters counting pile and slot), or axes that already carry their own
     length (12), which are half-extents by construction. */
  if (decalCard.length > 0 && decalCard.length <= 12)
    decalCard(pile, cell, cx, cy, cz, ux * hu * 0.5, uy * hu * 0.5, uz * hu * 0.5,
              vx * hv * 0.5, vy * hv * 0.5, vz * hv * 0.5, tone);
  else
    decalCard(pile, cell, cx, cy, cz, ux, uy, uz, vx, vy, vz, hu, hv, tone);
}

/* ---- occluder budget --------------------------------------------------
   nz-street-sky.js silently discards any registered box over 26 u on an axis
   and REG_CAP 220 is shared by all five street modules, so the skin takes a
   hard fourteen and counts them on the function object rather than in a
   top-level var (this part file declares functions only). */
function skOcc(x0, y0, z0, x1, y1, z1) {
  if (buildRunSkins.occN === undefined) buildRunSkins.occN = 0;
  var sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0), sz = Math.abs(z1 - z0);
  if (sx > 26 || sy > 26 || sz > 26) { warn('skin occluder over 26 u dropped'); return; }
  if (buildRunSkins.occN >= 14) return;
  occ(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
      Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
  buildRunSkins.occN++;
}

/* remove every break span from [z0,z1] and return what survives.  The plinth
   and the ground storey band are NOT continuous: a door, a shopfront, a
   garage or a loggia interrupts them, and a plinth running across a shop
   window is the loudest "nobody looked at this" cue on a street elevation. */
function skSegments(z0, z1, breaks) {
  var cuts = [], i, a, b, out = [], c = z0;
  for (i = 0; i < breaks.length; i++) {
    a = Math.max(z0, breaks[i][0]); b = Math.min(z1, breaks[i][1]);
    if (b > a) cuts.push([a, b]);
  }
  cuts.sort(function (p, q) { return p[0] - q[0]; });
  for (i = 0; i < cuts.length; i++) {
    if (cuts[i][0] > c + 0.05) out.push([c, cuts[i][0]]);
    if (cuts[i][1] > c) c = cuts[i][1];
  }
  if (z1 > c + 0.05) out.push([c, z1]);
  return out;
}


/* -----------------------------------------------------------------------
   6.1  THE PHOTOGRAPHED CORNER RULE

   N-W3 wraps the real-life corner pharmacy around the apartment mass owned by
   nz-street-park.  S-E1 remains an ordinary residential gable with its
   existing gameplay door.

   WI-1 owns RUNS and ought to carry all of this already.  The skin must not
   depend on which copy of the plan that agent read, so it patches by run id
   here and writes nothing back into the table.
   -------------------------------------------------------------------- */
function skinSpec(r) {
  var s = { ground: r.ground, shopZ0: r.shopZ0, shopZ1: r.shopZ1,
            sign: r.sign, nameSign: null };
  if (r.id === 'N-E2') {
    s.ground = 'render'; s.shopZ0 = undefined; s.shopZ1 = undefined; s.sign = null;
  } else if (r.id === 'N-W3') {
    s.ground = 'shop'; s.shopZ0 = 124.45; s.shopZ1 = 143.25;
    s.sign = 'eczane'; s.pharmacy = true; s.quiet = true;
  } else if (r.id === 'S-E1') {
    s.ground = 'render'; s.shopZ0 = undefined; s.shopZ1 = undefined; s.sign = null;
    s.nameSign = 'bblok';
  }
  /* the four blocks that carry their own name over the entrance */
  if (r.id === 'N-E1') s.nameSign = 'kizil';
  else if (r.id === 'N-W2') s.nameSign = 'sila';
  else if (r.id === 'S-E2') s.nameSign = 'degerli';
  else if (r.id === 'S-W2') s.nameSign = 'onurlu';
  return s;
}


/* -----------------------------------------------------------------------
   6.2  THE PUNCHED WALL

   holes are {z0,z1,y0,y1} rectangles on the face plane plus the private
   fields this section adds (rev, sill, head, jamb, noPunch).  They sit on a
   bay/storey lattice, so several share a z span at different heights: the
   wall is split into z bands at every hole edge and each band is walked
   upward, emitting the strips BETWEEN the holes that cover it.  A window is
   an absence in the wall, never a decal laid on one.
   -------------------------------------------------------------------- */
function wallX(pile, x, dir, z0, z1, y0, y1, holes, tone, top) {
  var hs = [], i, j, h, a0, a1, b0, b1;
  holes = holes || [];
  for (i = 0; i < holes.length; i++) {
    h = holes[i];
    if (h.noPunch) continue;
    a0 = Math.max(z0, h.z0); a1 = Math.min(z1, h.z1);
    b0 = Math.max(y0, h.y0); b1 = Math.min(y1, h.y1);
    if (a1 - a0 < 1e-3 || b1 - b0 < 1e-3) continue;
    hs.push({ z0: a0, z1: a1, y0: b0, y1: b1,
              rev: h.rev === undefined ? 1.10 : h.rev,
              sill: h.sill !== false, head: h.head !== false, jamb: h.jamb !== false });
  }
  /* The wall face carries the ground-line soiling, the weather gradient and
     the two scales of patchiness as a tone CALLBACK -- see weatherTone().
     One material, one draw call, no map. */
  var faceTone = weatherTone(tone, top || (y1 - y0), x);

  var zs = [z0, z1];
  for (i = 0; i < hs.length; i++) { zs.push(hs[i].z0); zs.push(hs[i].z1); }
  zs.sort(function (p, q) { return p - q; });
  var band = [];
  for (i = 0; i < zs.length; i++)
    if (zs[i] > z0 - 1e-3 && zs[i] < z1 + 1e-3 &&
        (band.length === 0 || zs[i] - band[band.length - 1] > 1e-3)) band.push(zs[i]);

  for (i = 0; i + 1 < band.length; i++) {
    var za = band[i], zb = band[i + 1], zm = (za + zb) * 0.5;
    var col = [];
    for (j = 0; j < hs.length; j++)
      if (hs[j].z0 <= zm && hs[j].z1 >= zm) col.push(hs[j]);
    col.sort(function (p, q) { return p.y0 - q.y0; });
    var cy = y0;
    for (j = 0; j < col.length; j++) {
      if (col[j].y0 > cy + 1e-3) panelX(pile, x, cy, col[j].y0, za, zb, dir, 1.0, faceTone);
      if (col[j].y1 > cy) cy = col[j].y1;
    }
    if (y1 > cy + 1e-3) panelX(pile, x, cy, y1, za, zb, dir, 1.0, faceTone);
  }

  /* The reveals.  REV 1.10 is 314 mm: a 20 mm render on a 200 mm block with
     the frame set on the inner face.  0.50 was tried first and never cast a
     shadow at any sun angle the overcast bake produces. */
  var jam = mix(tone, C.shade, 0.35), hd = mix(tone, C.shade, 0.55);
  for (i = 0; i < hs.length; i++) {
    h = hs[i];
    var xi = x - dir * h.rev;
    if (h.jamb) {
      skQuadZ(pile, h.z0, h.y0, h.y1, x, xi,  1, 0.62, jam);   /* ao 0.62: gap */
      skQuadZ(pile, h.z1, h.y0, h.y1, x, xi, -1, 0.62, jam);
    }
    if (h.head && h.y1 < y1 - 1e-3)
      skQuadY(pile, h.y1, x, xi, h.z0, h.z1, -1, 0.40, hd);    /* ao 0.40: head */
    if (h.sill && h.y0 > y0 + 1e-3)
      skQuadY(pile, h.y0, x, xi, h.z0, h.z1, 1, 0.62, mix(tone, C.shade, 0.45));
    STATS.openings = (STATS.openings || 0) + 1;
  }
}


/* -----------------------------------------------------------------------
   6.3  WINDOWS

   Every window is seeded.  The old assembly was one fixed unit -- same size,
   same central mullion, same pane tint -- on all ~180 openings, and a facade
   where every pane matches reads as CG instantly.  What varies: frame
   material (PVC 77 / timber 10 / aluminium 13, chosen PER FLAT, because in
   these blocks each flat replaced its own joinery), pane tint (five, per
   window, because curtains are per room), the transom, and whether the flat
   ever fitted an external roller shutter.

   FRAMES GO ON P.joinery, NEVER ON P.metal.  M.metal is roughness 0.58 /
   metalness 0.62; a surface that metallic has almost no diffuse lobe left to
   carry a vertex tone, so white PVC on it comes back as tinted chrome.  Only
   the grilles, brackets, rails and awning struts below are real steel.
   -------------------------------------------------------------------- */

/* the five pane tints */
function skPaneTone(k) {
  switch (k) {
    case 0:  return C.glass;
    case 1:  return mix(C.glass, C.dark, 0.35);      /* an unlit room       */
    /* The curtain and film mixes came down with the pane: at 0.30 of a
       236-code white and 0.28 of sand they were carrying most of the pane's
       value themselves, so darkening C.glass alone would have left four of
       the five variants exactly where they were. */
    case 2:  return mix(C.glass, C.white, 0.20);     /* net curtain         */
    case 3:  return mix(C.glass, C.sand, 0.17);      /* a drawn curtain     */
    default: return mix(C.glass, C.apricot, 0.13);   /* bronze film         */
  }
}

/* frame material: 0 PVC white, 1 timber, 2 aluminium */
function skFrameTone(k) {
  if (k === 1) return L(0x6b4f36);
  if (k === 2) return C.steel;
  return C.white;
}

/* ---- THE STREAK REGISTER ---------------------------------------------

   THE DEFECT THIS REPLACES.  The old streakRun() hung one card under every
   upper cill and read decalCard()'s last two arguments as HALF extents.  They
   are not -- the kit's own contract says "w and h are the card's FULL width
   and height" -- so a card written as m(0.16) x m(1.97) centred at
   ytop - m(1.97) did not start at the cill at all.  It started m(0.99) BELOW
   it, hanging in mid-air with nothing above it, and ended m(2.96) below,
   which on a 2.9 m storey is straight across the head of the window on the
   floor underneath.  Add 6.7's scattered hash pass on top of that and every
   upper wall on the street carried forty-odd dark rectangles, none of them
   under a source and several of them over an opening.

   THE RULE NOW.  A streak has a SOURCE and it runs straight down from it.
   The sources on these elevations are the seven real ones: the cill drip, the
   balcony slab's drip edge, the eaves gutter joint, the downpipe bracket, the
   dish fixing, the A/C condensate outlet, and the splash-back at the foot of
   the wall.  There is no eighth source and there is no scatter.

   Every card goes through streakRun(), which owns the three things no call
   site should re-derive for itself:
     - CLIP.  A run registers its openings, its shopfront, its garage and its
       name board as blocks; a streak is SHORTENED so it stops above whatever
       is under it, and REFUSED outright if its own source sits over one.
       That is the whole of "a streak never crosses a window, a door, a board
       or a shopfront", enforced once instead of guessed at thirteen times.
     - FLOOR.  A card shorter than minLen is a blob, not a streak, so it is
       not drawn at all.  Nothing here may degrade into a smudge.
     - CEILING.  m(4.0).  Dirt does not travel further than four metres down
       a rendered wall before the rain has washed the wall clean again.
   WIDTH stays the call site's business, because a width is a property of the
   SOURCE: a cill streak is as wide as the cill, a bracket weep is 100-200 mm.
   Nothing on a wall is metres wide.  The one exception is the ground-line
   band in 6.7, which is a band and not a streak.

   DEPTH defaults to 0.055 proud, which is what runs the card down OVER the
   floor bands: a band's front face is at 0.18, so the band's solid volume
   swallows the part of the streak that crosses it and the streak reappears
   below -- which is what the real thing does, and 0.055, 0.18 and -0.02 are
   three distinct planes so nothing z-fights.  The plinth is the exception:
   its front face is at 0.52, so anything below y 5.075 has to be laid at
   0.60 or the plinth simply eats it.  The old downpipe splash was at 0.055
   and y 1.4..3.8 -- eleven runs' worth of cards that could not be seen.

   HANDEDNESS is unchanged: u = (0,0,dir), v = (0,-1,0), u x v = (dir,0,0),
   which is the outward face normal. */
function skStreakCtx(face, dir, tone) {
  return { face: face, dir: dir, tone: tone, blocks: [], n: 0 };
}

/* One no-go rectangle on the face plane, in (z, y).  hard 1 means a source
   standing ON it is refused -- that is an opening, a board, a shopfront.
   hard 0 means the rectangle only stops a streak coming down from above it,
   which is what a balcony is: solid from the street, but its own back wall
   is where the dish bracket and the condenser hang. */
function skBlock(g, z0, z1, y0, y1, hard) {
  g.blocks.push({ z0: z0, z1: z1, y0: y0, y1: y1, hard: hard ? 1 : 0 });
}

function streakRun(g, nm, zc, w, ytop, len, minLen, tint, dep) {
  var i, b, hz = w * 0.5, lim = Math.min(len, m(4.0)), clear;
  var floorLen = (minLen === undefined) ? m(1.0) : minLen;
  if (!g) return false;
  for (i = 0; i < g.blocks.length; i++) {
    b = g.blocks[i];
    if (zc + hz <= b.z0 || zc - hz >= b.z1) continue;   /* clear of it in z   */
    if (b.y0 >= ytop - 0.02) continue;                  /* it is above the source */
    if (b.y1 > ytop - 0.02) { if (b.hard) return false; continue; }
    clear = ytop - b.y1;
    if (clear < lim) lim = clear;
  }
  if (lim < floorLen) return false;
  skDecal(P.decal, nm, g.face + g.dir * ((dep === undefined) ? 0.055 : dep),
          ytop - lim * 0.5, zc, 0, 0, g.dir, 0, -1, 0, w, lim,
          (tint === undefined) ? mix(g.tone, C.dark, 0.52) : tint);
  g.n++;
  STATS.streaks = (STATS.streaks || 0) + 1;
  return true;
}

/* ---- a security grille, the ground floor's default in this town -------
   0.10-radius verticals (28 mm bar) at 0.62 u = 177 mm centres, 0.30 proud
   of the face, dark steel on P.metal -- these ones ARE steel. */
function skGrille(face, dir, z0, z1, y0, y1) {
  var n = clamp(Math.round((z1 - z0) / 0.62), 4, 9), i, zz;
  var xf = face + dir * 0.30, tn = mix(C.dark, C.steel, 0.22);
  for (i = 0; i <= n; i++) {
    zz = lerp(z0 + 0.18, z1 - 0.18, i / n);
    tube(P.metal, [xf, y0 + 0.10, zz], [xf, y1 - 0.10, zz], 0.10, 6, tn, true, false);
  }
  tube(P.metal, [xf, y0 + 0.24, z0 + 0.12], [xf, y0 + 0.24, z1 - 0.12], 0.09, 6, tn, true, false);
  tube(P.metal, [xf, y1 - 0.30, z0 + 0.12], [xf, y1 - 0.30, z1 - 0.12], 0.09, 6, tn, true, false);
}

/* ---- panjur kutusu: the external roller-shutter box -------------------
   0.62 x 0.62 u section (177 mm square) immediately over the head, with the
   two guide rails running down the reveal.  The single biggest missing
   Turkish cue on the old street. */
function skShutterBox(face, dir, z0, z1, yhead, tone) {
  var tn = mix(C.white, tone, 0.18);
  skMouldZ(P.joinery, [[-0.02, yhead], [0.62, yhead + 0.12], [0.62, yhead + 0.50],
                       [0.50, yhead + 0.62], [-0.02, yhead + 0.62]],
           face, dir, z0 - 0.26, z1 + 0.26, 1.0, tn);
  /* THE GUIDE RAILS STAND ON THE SOVE, NOT INSIDE IT.  They ran -0.02..0.16
     and the sove that windowX lays down the same jamb runs -0.02..0.22 over
     the same z and the same y -- two boxes sharing a front plane and two side
     planes, which is the coplanar z-fight this whole section exists to
     forbid.  A panjur guide is an aluminium channel SCREWED TO THE FACE of
     the sove anyway, so 0.22..0.40 is both the correct assembly and the one
     depth range that cannot fight: it starts where the sove's front face
     ends.  It also buys 51 mm of relief down each jamb, which is the only
     vertical shadow a window has when the sun is nearly square to the wall. */
  skBoxD(P.joinery, face, dir, 0.22, 0.40, yhead - 3.0, yhead, z0 - 0.20, z0 - 0.02, 0.02, 0.9, tn);
  skBoxD(P.joinery, face, dir, 0.22, 0.40, yhead - 3.0, yhead, z1 + 0.02, z1 + 0.20, 0.02, 0.9, tn);
}

/* ---- one window ------------------------------------------------------
   opt = { rev, ground, seed, tone, frame, streak, flush, g }
   opt.g is the run's streak register; opt.streak is the caller's decision
   that THIS cill is one of the few that stains.  See 6.8 step 6. */
function windowX(face, dir, z0, z1, y0, y1, opt) {
  var rev = opt.rev, tone = opt.tone, sd = opt.seed;
  var oh = y1 - y0, wF = skFrameTone(opt.frame);

  /* WHY THE SASH SITS AT 0.25 AND NOT AT THE BACK OF THE REVEAL.  wallX cuts
     a 1.10 opening, as briefed, and the deep jambs are what carry the shadow.
     But SECTION 7 states its mass front face "sits 0.34 behind the skin plane
     so it becomes the BACK of every window reveal", while its own pier table
     puts that pier at x 580.0..584.0 -- 0.02 behind our skin.  Either number
     would bury a sash set at 0.98, and 223 windows would render as dark
     holes.  So: glass at 0.25 behind the face and frame between 0.32 and
     0.18, all of it inside the shallower of the two, plus our OWN opaque back
     panel at the full reveal depth for the case where SECTION 7 keeps clear.
     The window reads either way.  Flagged to the lead as a section conflict. */
  /* svd, the sove's projection, was 0.16 = 46 mm.  Under the overcast probe
     that was a tone step and nothing else; under a sun whose azimuth is 0.94
     square to these west-facing flanks a 46 mm band throws about 30 mm of
     shadow, i.e. nothing at any distance the player sees it from.  0.22 =
     63 mm is still a flat trim band and not a pilaster, and it is the depth
     the skShutterBox guides now start from. */
  var gd = 0.25, f0 = 0.32, f1 = 0.18, svd = 0.22, spd = rev - 0.04;
  if (opt.flush) {
    /* THE FOUR 230 Sk STUB RUNS.  Those stand 0.02 PROUD of buildWorld's own
       concrete -- rCrossViewN/S declare openEdges north and south only, so
       their east and west faces DO get an engine quad, unlike the 232 arms
       where rSideWalkW/E suppress it.  A sash recessed behind an engine quad
       0.02 away is a sash nobody sees, so on these four the wall is left
       intact (the op carries noPunch) and the whole assembly is built PROUD:
       a dark spandrel on the wall, the sash in front of it, the sove in front
       of that.  A flush window in a trim surround is what a cheap 1990s block
       has anyway, and these four are seen only from down the 230 stub. */
    gd = -0.08; f0 = -0.13; f1 = -0.02; svd = 0.30; spd = -0.03;
  }
  var gx = face - dir * gd;

  /* The dark room behind the glass.  It was mix(C.dark, C.shade, 0.30) --
     a 0x565a5d mid-grey -- which is a room lit by the same overcast sky as
     the wall outside it.  Under the sunny profile that quad is a west-facing
     diffuse surface taking 0.58 of a 2.45 key exactly like the render beside
     it, and a sunlit room interior is a contradiction: the whole point of the
     surface is that it is the ONE thing on the elevation the sun cannot
     reach.  0.62 toward C.dark takes it to a room, not a panel. */
  skQuadX(P.render, face - dir * spd, y0, y1, z0, z1, dir, 0.48,
          mulv(mix(C.dark, C.shade, 0.30), 0.38));

  /* A transom goes on anything taller than m(1.4) = 4.9 u, which is what a
     1.5 m casement is.  The runs whose head is at m(1.35) get a plain
     two-leaf window and the street reads as several separate buildings. */
  var trY = oh > m(1.4) ? y0 + oh * 0.68 : -1;
  var mz = (z0 + z1) * 0.5;
  var lanes = [[z0 + 0.14, mz - 0.09], [mz + 0.09, z1 - 0.14]];
  var li;
  for (li = 0; li < lanes.length; li++) {
    var pane = skPaneTone(Math.floor(hash(sd * 3.0 + li * 17 + 5) * 5));
    if (trY > 0) {
      panelX(P.glass, gx, y0 + 0.16, trY - 0.08, lanes[li][0], lanes[li][1], dir, 1.0, pane);
      panelX(P.glass, gx, trY + 0.08, y1 - 0.16, lanes[li][0], lanes[li][1], dir, 1.0,
             skPaneTone(Math.floor(hash(sd * 3.0 + li * 17 + 41) * 5)));
    } else {
      panelX(P.glass, gx, y0 + 0.16, y1 - 0.16, lanes[li][0], lanes[li][1], dir, 1.0, pane);
    }
  }
  /* cill rail, head rail, two stiles, the centre mullion, the transom */
  skBoxD(P.joinery, face, dir, -f0, -f1, y0, y0 + 0.22, z0, z1, 0, 1.0, wF);
  skBoxD(P.joinery, face, dir, -f0, -f1, y1 - 0.22, y1, z0, z1, 0, 0.9, wF);
  skBoxD(P.joinery, face, dir, -f0, -f1, y0, y1, z0, z0 + 0.20, 0, 1.0, wF);
  skBoxD(P.joinery, face, dir, -f0, -f1, y0, y1, z1 - 0.20, z1, 0, 1.0, wF);
  skBoxD(P.joinery, face, dir, -f0, -f1, y0, y1, mz - 0.11, mz + 0.11, 0, 1.0, wF);
  if (trY > 0)
    skBoxD(P.joinery, face, dir, -f0, -f1, trY - 0.10, trY + 0.10, z0, z1, 0, 0.9, wF);

  /* The sove: the flat trim band down each jamb that these blocks all carry.
     0.16 proud (0.24 on the flush runs) and 0.30 wide, so the opening reads
     as relief from the street whatever SECTION 7 leaves behind it.  It runs
     cill to head only -- the head is already carried by the panjur box at
     0.62 proud or the lintel band at 0.14, and a third band at 0.16 across
     the same y would sit 0.02 off the lintel's front face, which is inside
     depth precision at the far end of a 176 u street. */
  var sv = mix(C.white, tone, 0.25);
  skBoxD(P.render, face, dir, -0.02, svd, y0, y1, z0 - 0.30, z0, 0, 1.0, sv);
  skBoxD(P.render, face, dir, -0.02, svd, y0, y1, z1, z1 + 0.30, 0, 1.0, sv);

  /* The cill: a top that falls 0.06 over the projection and a front lower
     arris standing 0.06 below the bed joint, which IS the drip -- water
     leaves the stone there instead of tracking back into the render.
     upTone() darkens the up-face toward UPGRIME, or a white precast cill
     clips past 245 sRGB the moment the sky dome hits it. */
  skMouldZ(P.stone, [[-0.02, y0 - 0.30], [0.45, y0 - 0.36], [0.45, y0 - 0.06], [-0.02, y0]],
           face, dir, z0 - 0.30, z1 + 0.30, 1.0, upTone(C.white));
  /* the shadow the drip throws on the wall under it, at ao 0.34 */
  skQuadX(P.render, face + dir * 0.045, y0 - 0.74, y0 - 0.36, z0 - 0.30, z1 + 0.30,
          dir, 0.34, mix(tone, C.dark, 0.30));

  /* Head: either a panjur box (55 per cent of upper windows) or a lintel
     band -- never both.  On a real block the box IS the lintel. */
  if (opt.ground) {
    skGrille(face, dir, z0, z1, y0, y1);
  } else if (hash(sd * 7.0 + 13) < 0.55) {
    skShutterBox(face, dir, z0, z1, y1, tone);
  } else {
    skMouldZ(P.render, [[-0.02, y1], [0.14, y1], [0.14, y1 + 0.55], [-0.02, y1 + 0.55]],
             face, dir, z0 - 0.40, z1 + 0.40, 1.0, mix(tone, C.white, 0.42));
  }

  /* THE CILL STREAK.  Its source is the drip arris on the cill above, so it
     starts AT y0 - 0.36 and it is as wide as the cill, which runs
     z0 - 0.30 .. z1 + 0.30.  m(1.6) is asked for and the register gives back
     whatever the wall below actually offers: on a 2.9 m storey with a panjur
     box over the window underneath that is about a metre, which is exactly
     how far a real cill stains before the head below it interrupts.  The
     tint is 0.52 toward dark rather than the old 0.62 -- these are washes on
     render, not paint. */
  if (opt.streak)
    streakRun(opt.g, 'D_STREAK', (z0 + z1) * 0.5, (z1 - z0) + 0.60, y0 - 0.36,
              m(1.6), m(0.80), mix(tone, C.dark, 0.52));
  STATS.windows = (STATS.windows || 0) + 1;
}


/* -----------------------------------------------------------------------
   6.4  BALCONIES AND THE TWO GRID LOGGIAS

   A balcony is a STACK, not a scatter: bay i carries one on every floor when
   i % 3 === 1.  Distributing them by (i+s) instead put a single box on each
   storey at a different bay, which reads as bomb damage rather than as a
   building.  Projection m(1.05) = 3.675 u; the lowest slab soffit is at
   fy(1) - 0.07 = 11.13, far above jumpTop (f + 8.70 = 9.2 on a footway), so
   rule B carries every one of them over the pavement.
   -------------------------------------------------------------------- */

/* A satellite dish.  Built from poly fans rather than the kit's cone(),
   which is not in this section's kit -- and a dish is a dished disc, not a
   cone, so the fan is the honest shape anyway.  Every dish on the street
   looks at the same bird, so the azimuths sit inside +/-0.275 rad of one
   bearing: outward off the flank, well south, tilted up. */
function skDish(cx, cy, cz, r, ax, ay, az) {
  var l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  ax /= l; ay /= l; az /= l;
  var ux = -az, uy = 0, uz = ax, ul = Math.sqrt(ux * ux + uz * uz) || 1;
  ux /= ul; uz /= ul;
  var vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
  var seg = 10, i, a0, a1, dish = 0.20 * r;
  var back = [cx - ax * dish, cy - ay * dish, cz - az * dish];
  var apex = [cx + ax * dish * 0.10, cy + ay * dish * 0.10, cz + az * dish * 0.10];
  var tnF = mix(C.white, C.grey, 0.28), tnB = mix(C.grey, C.dark, 0.22);
  var rim = function (a) {
    return [cx + (ux * Math.cos(a) + vx * Math.sin(a)) * r,
            cy + (uy * Math.cos(a) + vy * Math.sin(a)) * r,
            cz + (uz * Math.cos(a) + vz * Math.sin(a)) * r];
  };
  for (i = 0; i < seg; i++) {
    a0 = i / seg * Math.PI * 2; a1 = (i + 1) / seg * Math.PI * 2;
    poly(P.joinery, [apex, rim(a0), rim(a1)], back, 1.0, tnF);
    poly(P.joinery, [back, rim(a1), rim(a0)], apex, 0.62, tnB);
  }
  /* the LNB on its arm */
  tube(P.joinery, [apex[0], apex[1], apex[2]],
       [cx + ax * r * 1.20, cy + ay * r * 1.20, cz + az * r * 1.20], 0.09, 6,
       mix(C.white, C.grey, 0.40), true, false);
  boxC(P.joinery, cx + ax * r * 1.26, cy + ay * r * 1.26, cz + az * r * 1.26,
       0.16, 0.16, 0.16, 0.05, 1.0, mix(C.white, C.grey, 0.40));
}

/* wall-mounted A/C condenser: 0.90 x 0.55 x 0.28 m on two brackets, never
   more than 0.98 proud so it stays inside HUG on a 1.14 m footway. */
function skCondenser(face, dir, y, zc, tone, g) {
  var w = m(0.90), hgt = m(0.55), dp = Math.min(0.98, 0.04 + m(0.28)), i;
  skBoxD(P.joinery, face, dir, 0.04, dp, y, y + hgt, zc - w * 0.5, zc + w * 0.5,
         0.08, 1.0, mix(C.white, C.grey, 0.34));
  for (i = 0; i < 3; i++)
    skBoxD(P.joinery, face, dir, dp, dp + 0.05, y + 0.55 + i * 0.42,
           y + 0.55 + i * 0.42 + 0.18, zc - w * 0.34, zc + w * 0.34,
           0.01, 0.9, mix(C.grey, C.dark, 0.35));
  skBoxD(P.metal, face, dir, -0.02, 0.14, y - 0.34, y + 0.06, zc - w * 0.42, zc - w * 0.30,
         0.02, 0.62, mix(C.steel, C.dark, 0.30));
  skBoxD(P.metal, face, dir, -0.02, 0.14, y - 0.34, y + 0.06, zc + w * 0.30, zc + w * 0.42,
         0.02, 0.62, mix(C.steel, C.dark, 0.30));
  /* THE CONDENSATE WEEP.  It comes off the NEAR BRACKET, whose foot is at
     y - 0.34, and it is 120 mm wide -- the old one was a card 0.11 m wide
     floating a metre and a half below the bracket in clear air.  On these
     blocks the unit is hung over the balcony door, so the register refuses
     most of them, which is right: a weep drawn on a door leaf is the exact
     thing this pass exists to stop.  Where the unit clears the door the
     stain is there. */
  streakRun(g, 'D_RUST', zc - w * 0.36, m(0.12), y - 0.34, m(1.3), m(0.70),
            mix(tone, C.rail, 0.50));
}

/* a drying rack: two arms and three cloths.  The cloth is flat colour on
   P.joinery -- the needle atlas is not this section's to sample, and a card
   pushed through the planar world-space projector is the exact bug that made
   all eight of the old module's trees render zero pixels. */
function skLaundry(face, dir, y, z0, z1, seed) {
  var xa = face + dir * 0.9, xb = face + dir * 2.9, i, zz, w, hgt, tn;
  tube(P.joinery, [xa, y + 2.4, z0 + 0.4], [xb, y + 2.4, z0 + 0.4], 0.07, 5, C.grey, true, false);
  tube(P.joinery, [xa, y + 2.4, z1 - 0.4], [xb, y + 2.4, z1 - 0.4], 0.07, 5, C.grey, true, false);
  for (i = 0; i < 3; i++) {
    zz = lerp(z0 + 0.9, z1 - 0.9, (i + 0.5) / 3);
    w = rr(seed, i * 5 + 1, 0.7, 1.15); hgt = rr(seed, i * 5 + 2, 1.9, 3.2);
    tn = i === 0 ? C.white : (i === 1 ? mix(C.white, C.rose, 0.55) : mix(C.white, C.glass, 0.45));
    skBoxD(P.joinery, face, dir, 1.0, 2.8, y + 2.3 - hgt, y + 2.3, zz - w * 0.5, zz + w * 0.5,
           0, 0.9, tn);   /* k 0: a chamfered towel is 44 tris for nothing */
  }
}

/* three pots on the parapet.  The greenery is a heavily chamfered box on
   P.render toned olive, for the same reason the laundry is flat colour. */
function skPots(face, dir, y, z0, z1, seed) {
  var i, zz, r;
  for (i = 0; i < 3; i++) {
    zz = lerp(z0 + 0.9, z1 - 0.9, (i + 0.5) / 3);
    r = rr(seed, i * 3 + 7, 0.42, 0.60);
    tube(P.stone, [face + dir * 1.4, y, zz], [face + dir * 1.4, y + 0.85, zz],
         r, 8, mix(C.roof, C.stone, 0.35), true, true);
    boxC(P.render, face + dir * 1.4, y + 1.35, zz, r * 1.5, 0.62, r * 1.5,
         Math.min(r * 0.70, 0.28), 1.0, L(0x25331d));
  }
}

/* what stands on a balcony: 40 dish, 25 A/C, 20 laundry, 15 pots.
   g is the run's streak register and `open` says whether the back wall is
   visible from the street at all -- a weep behind a cam balkon's glass is a
   card nobody will ever see, and this section does not pay for those. */
function skBalconyProp(face, dir, z0, z1, y, seed, tone, g, open) {
  var k = hash(seed * 11.0 + 3), zc = (z0 + z1) * 0.5;
  if (k < 0.40) {
    var az = 0.275 * (hash(seed * 5.0 + 9) * 2 - 1);
    skDish(face + dir * 2.4, y + 2.9, z0 + 0.9,
           rr(seed, 2, m(0.51), m(0.72)) * 0.5,
           dir * (0.55 * Math.cos(az) + 0.20 * Math.sin(az)), 0.34,
           0.75 * Math.cos(az) - 0.15 * Math.sin(az));
    tube(P.joinery, [face + dir * 0.10, y + 2.9, z0 + 0.9],
         [face + dir * (0.10 + m(0.34)), y + 2.9, z0 + 0.9], 0.10, 6, C.grey, true, false);
    /* the rust off the dish's wall fixing: 100 mm wide, m(0.9) long, and only
       where the balcony is open enough to see the back wall */
    if (open) streakRun(g, 'D_RUST', z0 + 0.9, m(0.10), y + 2.75, m(0.9), m(0.60),
                        mix(tone, C.rail, 0.45));
  } else if (k < 0.65) {
    skCondenser(face, dir, y + 1.2, zc, tone, g);
  } else if (k < 0.85) {
    skLaundry(face, dir, y, z0, z1, seed);
  } else {
    skPots(face, dir, y, z0, z1, seed);
  }
}

/* ---- one balcony -----------------------------------------------------
   glazed = cam balkon (55 per cent), else an open loggia (45 per cent).
   THE BUG FIX: the glazed variant used to emit front glass and two jambs and
   NO cheeks, so you saw straight through the sides of every enclosed balcony
   on the street.  Both cheeks are closed here, in glass and frame. */
function balconyX(face, dir, z0, z1, y, glazed, tone, seed, g) {
  var proj = m(1.05);                       /* 3.675 u = 1.05 m            */
  var hgt = m(2.55);                        /* 8.925 u to the screen head  */
  var xf = face + dir * proj;
  var xw = face - dir * 0.02;               /* cheeks start behind the face */
  var i;

  /* the slab: chamfered nose top and bottom, rear buried 0.02 in the wall */
  skMouldZ(P.stone, [[-0.02, y - 0.62], [proj - 0.14, y - 0.62], [proj, y - 0.48],
                     [proj, y - 0.14], [proj - 0.14, y], [-0.02, y]],
           face, dir, z0, z1, 1.0, upTone(mix(tone, C.white, 0.42)));

  if (glazed) {
    var np = clamp(Math.round((z1 - z0) / 2.03), 4, 7), mz;
    var trY = y + hgt * 0.72;
    var fTone = C.white, gTone = skPaneTone(Math.floor(hash(seed * 9.0 + 2) * 5));
    panelX(P.glass, xf - dir * 0.10, y + 0.28, y + hgt - 0.10, z0 + 0.22, z1 - 0.22,
           dir, 1.0, gTone);
    for (i = 0; i < 2; i++) {
      var zc = i === 0 ? z0 : z1;
      var zin = i === 0 ? z0 + 0.10 : z1 - 0.10;
      poly(P.glass, [[xw, y + 0.28, zin], [xf, y + 0.28, zin],
                     [xf, y + hgt - 0.10, zin], [xw, y + hgt - 0.10, zin]],
           [(xw + xf) * 0.5, y + 1.0, i === 0 ? zc + 1.0 : zc - 1.0], 1.0, gTone);
      skBoxD(P.joinery, face, dir, -0.02, proj, y, y + hgt,
             i === 0 ? zc : zc - 0.21, i === 0 ? zc + 0.21 : zc, 0.03, 1.0, fTone);
    }
    skBoxD(P.joinery, face, dir, proj - 0.21, proj, y, y + 0.34, z0, z1, 0.03, 1.0, fTone);
    skBoxD(P.joinery, face, dir, proj - 0.21, proj, y + hgt - 0.21, y + hgt, z0, z1, 0.03, 0.9, fTone);
    skBoxD(P.joinery, face, dir, proj - 0.21, proj, trY - 0.10, trY + 0.10, z0, z1, 0.03, 0.9, fTone);
    for (i = 1; i < np; i++) {
      mz = lerp(z0, z1, i / np);
      skBoxD(P.joinery, face, dir, proj - 0.21, proj, y, y + hgt, mz - 0.105, mz + 0.105,
             0.03, 1.0, fTone);
    }
    skBalconyProp(face, dir, z0 + 0.4, z1 - 0.4, y, seed, tone, g, false);

  } else if (hash(seed * 13.0 + 7) < 0.5) {
    /* open, variant A: a full rendered parapet with a chamfered coping */
    var par = 3.50;
    skMouldZ(P.render, [[proj - 0.30, y], [proj, y], [proj, y + par - 0.12],
                        [proj - 0.06, y + par], [proj - 0.30, y + par]],
             face, dir, z0, z1, 1.0, tone);
    skMouldX(P.render, [[0, y], [0.30, y], [0.30, y + par], [0, y + par]],
             z0 + 0.30, -1, Math.min(xw, xf), Math.max(xw, xf), 1.0, tone);
    skMouldX(P.render, [[0, y], [0.30, y], [0.30, y + par], [0, y + par]],
             z1 - 0.30, 1, Math.min(xw, xf), Math.max(xw, xf), 1.0, tone);
    skMouldZ(P.stone, [[proj - 0.40, y + par], [proj + 0.10, y + par],
                       [proj + 0.10, y + par + 0.22], [proj - 0.02, y + par + 0.30],
                       [proj - 0.40, y + par + 0.30]],
             face, dir, z0 - 0.06, z1 + 0.06, 1.0, upTone(C.white));
    tube(P.metal, [xf - dir * 0.15, y + par + 0.41, z0], [xf - dir * 0.15, y + par + 0.41, z1],
         0.14, 6, C.rail, true, false);
    skBalconyProp(face, dir, z0 + 0.4, z1 - 0.4, y, seed, tone, g, true);

  } else {
    /* open, variant B: a 1.47 u (420 mm) up-stand and a steel balustrade,
       balusters at 0.56 u = 160 mm centres between a bottom rail and the
       handrail at y + 3.605.  Both variants stand on these blocks. */
    var up = 1.47, hr = 3.605, nb, zz;
    skMouldZ(P.render, [[proj - 0.30, y], [proj, y], [proj, y + up - 0.10],
                        [proj - 0.08, y + up], [proj - 0.30, y + up]],
             face, dir, z0, z1, 1.0, tone);
    skMouldX(P.render, [[0, y], [0.30, y], [0.30, y + up], [0, y + up]],
             z0 + 0.30, -1, Math.min(xw, xf), Math.max(xw, xf), 1.0, tone);
    skMouldX(P.render, [[0, y], [0.30, y], [0.30, y + up], [0, y + up]],
             z1 - 0.30, 1, Math.min(xw, xf), Math.max(xw, xf), 1.0, tone);
    var rx = xf - dir * 0.15;
    tube(P.metal, [rx, y + hr, z0], [rx, y + hr, z1], 0.14, 6, C.rail, true, false);
    tube(P.metal, [rx, y + up + 0.11, z0], [rx, y + up + 0.11, z1], 0.11, 6, C.rail, true, false);
    nb = clamp(Math.round((z1 - z0) / 0.56), 6, 14);
    for (i = 0; i <= nb; i++) {
      zz = lerp(z0 + 0.20, z1 - 0.20, i / nb);
      tube(P.metal, [rx, y + up + 0.05, zz], [rx, y + hr, zz], 0.085, 5, C.rail, true, false);
    }
    skBalconyProp(face, dir, z0 + 0.4, z1 - 0.4, y, seed, tone, g, true);
  }

  /* THE SLAB'S DRIP EDGE.  Water leaves the slab at its chamfered nose and
     runs off the ENDS, onto the pier beside the stack -- not down the middle,
     because the middle is where the balcony one storey down is, and the
     register would refuse it anyway.  m(0.20) wide, m(2.2) long, one end per
     slab, and only on the two slabs in five whose drip has actually failed.
     Anchored at y - 0.62, which is the soffit the moulding profile above
     starts from, so the card touches the thing it comes off. */
  if (hash(seed * 21.0 + 5) < 0.38)
    streakRun(g, 'D_STREAK', (hash(seed * 27.0 + 3) < 0.5) ? z0 - 0.55 : z1 + 0.55,
              m(0.20), y - 0.62, m(2.2), m(1.0), mix(tone, C.dark, 0.46));
}

/* ---- the two grid loggias ---------------------------------------------
   N-E1 at z 64..72 and S-E2 at z 284..292 are not decoration: they are
   CARVED ROOMS, region rLoggia, floor y 11.2 and ceiling y 21.0.  The wall is
   punched across the full 8 u, the parapet stands ON the grid's own floor at
   11.2, and the void is left open -- buildWorld draws the floor and the dark
   ceiling behind it.  Glazing these two would put our glass inside a room the
   player can stand in. */
function loggiaVoid(face, dir, z0, z1, y0, tone, seed) {
  var par = 3.50, rev = 1.10;
  /* the parapet fills the reveal depth so the jamb shows no gap behind it */
  skMouldZ(P.render, [[-rev, y0], [0.10, y0], [0.10, y0 + par - 0.10],
                      [-0.04, y0 + par], [-rev, y0 + par]],
           face, dir, z0, z1, 1.0, tone);
  skMouldZ(P.stone, [[-rev - 0.02, y0 + par], [0.22, y0 + par],
                     [0.22, y0 + par + 0.20], [0.10, y0 + par + 0.28],
                     [-rev - 0.02, y0 + par + 0.28]],
           face, dir, z0, z1, 1.0, upTone(C.white));
  tube(P.metal, [face - dir * 0.05, y0 + par + 0.40, z0 + 0.2],
       [face - dir * 0.05, y0 + par + 0.40, z1 - 0.2], 0.13, 6, C.rail, true, false);
  /* a loggia is where the washing goes: hung BEHIND the parapet line */
  skLaundry(face - dir * 2.6, dir, y0 + 1.2, z0 + 0.6, z1 - 0.6, seed + 3);
}


/* -----------------------------------------------------------------------
   6.5  SHOPFRONTS AND SHUTTERS
   -------------------------------------------------------------------- */

/* The folding tente.  Fixed at y 11.72 and falling to 10.95 at the front,
   m(0.95) = 3.325 proud.  The brief hangs it at 10.80, but the ground storey
   band occupies 10.80..11.70 for the whole run, so the fixing goes just above
   the band; the lowest fabric (the valance at 10.05) still clears jumpTop
   (f + 8.70 = 9.2) by 0.85 u, which is what the constraint was for. */
function skAwning(face, dir, z0, z1) {
  var yb = 11.72, yf = 10.95, proj = m(0.95), i, za, zb, tn;
  var xa = face + dir * 0.10, xb = face + dir * proj;
  var t1 = mix(C.white, C.rose, 0.10), t2 = mix(C.white, C.rail, 0.62);
  var n = Math.max(4, Math.round((z1 - z0) / 2.6));
  for (i = 0; i < n; i++) {
    za = lerp(z0, z1, i / n); zb = lerp(z0, z1, (i + 1) / n);
    tn = (i % 2) ? t2 : t1;
    poly(P.joinery, [[xa, yb, za], [xb, yf, za], [xb, yf, zb], [xa, yb, zb]],
         [(xa + xb) * 0.5, yb - 1.0, (za + zb) * 0.5], 1.0, tn);
    poly(P.joinery, [[xa, yb, zb], [xb, yf, zb], [xb, yf, za], [xa, yb, za]],
         [(xa + xb) * 0.5, yb + 1.0, (za + zb) * 0.5], 0.48, mix(tn, C.dark, 0.30));
    poly(P.joinery, [[xb, yf, za], [xb, yf - 0.90, za], [xb, yf - 0.90, zb], [xb, yf, zb]],
         [xb - dir * 1.0, yf, (za + zb) * 0.5], 1.0, tn);
    poly(P.joinery, [[xb, yf, zb], [xb, yf - 0.90, zb], [xb, yf - 0.90, za], [xb, yf, za]],
         [xb + dir * 1.0, yf, (za + zb) * 0.5], 0.62, mix(tn, C.dark, 0.22));
  }
  for (i = 0; i < 4; i++) {
    var zz = lerp(z0 + 0.6, z1 - 0.6, i / 3);
    tube(P.metal, [face + dir * 0.05, yb + 0.12, zz], [xb, yf + 0.10, zz],
         0.126, 6, mix(C.steel, C.dark, 0.20), true, false);
  }
  tube(P.metal, [xb, yf + 0.10, z0], [xb, yf + 0.10, z1], 0.154, 6,
       mix(C.steel, C.dark, 0.20), true, false);
  /* Its contact shadow, 0.42 u clear of the lowest fabric.  A box drawn
     AROUND geometry bakes that geometry solid black, because hitsBoxT exempts
     only a ray origin STRICTLY inside a box -- a vertex exactly on the
     boundary is fully blocked.  nz-street-park's two shelter roofs came back
     as black slabs from precisely this. */
  skOcc(Math.min(xa, xb), yf - 1.83, z0, Math.max(xa, xb), yf - 0.90 - 0.42, z1);
}

/* an A-board leaning on the wall beside the door: 1.68 x 2.94 u
   (480 x 840 mm), and never more than 0.95 proud, inside HUG 0.98. */
function skABoard(face, dir, zc) {
  var w = 1.68, hgt = 2.94, i, d0, d1;
  for (i = 0; i < 2; i++) {
    d0 = 0.16 + i * 0.28; d1 = d0 + 0.50;
    skBoxD(P.joinery, face, dir, d0, d1, 0.5, 0.5 + hgt, zc - w * 0.5, zc + w * 0.5,
           0.04, i ? 0.62 : 1.0, mix(C.dark, C.shade, i ? 0.25 : 0.45));
  }
}

/* A small double-sided green cross projects from the pharmacy wall.  The
   bracket and both faces make it legible from either direction on 232 Sk. */
function pharmacyBlade(face, dir, zc) {
  var px = face + dir * 1.28, py = 9.05;
  tube(P.metal, [face + dir * 0.20, py + 0.76, zc],
       [px, py + 0.76, zc], 0.09, 6, mix(C.steel, C.dark, 0.34), true, false);
  signCard(P.sign, 'cross', px, py, zc + 0.03,
           1, 0, 0, 0, 1, 0, 1.62, C.white);
  signCard(P.sign, 'cross', px, py, zc - 0.03,
           -1, 0, 0, 0, 1, 0, 1.62, C.white);
}

/* A real, raised and traversable corner pharmacy.  The previous shopFront()
   was a 320-mm-deep display box with an opaque panel immediately behind the
   glass, so it could never become a room.  This version owns a full-depth
   tiled interior, leaves the side doorway genuinely open, and climbs from the
   pavement with four shallow stone steps. */
function pharmacyFront(r, spec, seed) {
  var face = r.x, dir = r.dir, tone = r.tone;
  var sz0 = spec.shopZ0, sz1 = spec.shopZ1;
  var door0 = 136.0, door1 = 140.0;
  var floorY = 1.35, sy0 = 1.82, sy1 = 7.05;
  var fa0 = 7.35, fa1 = 10.70;
  var frame = mix(C.steel, C.white, 0.48), alu = C.steel;
  var segs = [[sz0, door0 - 0.32], [door1 + 0.32, sz1]];
  var i, j, mz;

  /* Walkable room: tiled slab, upper shell, rear wall and two short returns.
     The grid supplies collision and the same 1.70 floor datum. */
  deck(P.paver, 464.20, 124.40, 483.76, 143.55, floorY, 0.34, 1,
       upTone(mix(C.paver, C.white, 0.18)));
  box6(P.render, 463.90, 464.28, floorY, 10.72, 124.35, 143.60, 0.86,
       mix(C.cream, C.shade, 0.16));
  box6(P.render, 464.15, 483.78, floorY, 10.72, 124.20, 124.54, 0.86,
       mix(C.cream, C.shade, 0.12));
  box6(P.render, 464.15, 483.78, floorY, 10.72, 143.42, 143.78, 0.86,
       mix(C.cream, C.shade, 0.12));
  box6(P.render, 464.10, 483.82, 10.48, 10.76, 124.30, 143.68, 0.78,
       upTone(mix(C.white, tone, 0.12)));

  /* Rear medicine shelving and a compact dispensing counter, kept clear of
     the doorway and central aisle. */
  for (i = 0; i < 3; i++) {
    var za = 125.10 + i * 5.72;
    box6(P.joinery, 464.42, 466.05, floorY + 0.10, 8.05,
         za, za + 4.55, 0.82, mix(C.white, C.stone, 0.16));
    for (j = 1; j < 4; j++)
      box6(P.joinery, 466.02, 466.30, floorY + j * 1.48, floorY + j * 1.48 + 0.16,
           za + 0.18, za + 4.37, 0.86, mix(C.white, C.steel, 0.20));
  }
  box6(P.stone, 469.10, 472.20, floorY, 4.45, 125.05, 134.10, 0.92,
       mix(C.stone, C.white, 0.22));
  box6(P.joinery, 468.82, 472.46, 4.38, 4.70, 124.82, 134.34, 0.94,
       upTone(mix(C.white, C.stone, 0.10)));
  for (i = 0; i < 3; i++)
    box6(P.joinery, 468.60, 479.70, 10.16, 10.32,
         126.0 + i * 5.25, 127.60 + i * 5.25, 0.84, C.white);

  /* Glazed bays on either side of the always-open doorway. */
  for (i = 0; i < segs.length; i++) {
    var a = segs[i][0], b = segs[i][1];
    if (b <= a + 0.2) continue;
    skMouldZ(P.stone,
             [[-0.02, floorY], [0.30, floorY], [0.30, sy0 - 0.10],
              [0.20, sy0], [-0.02, sy0]],
             face, dir, a, b, 1.0, groundTone(mix(C.stone, C.dark, 0.22), 0, 1.47));
    panelX(P.glass, face + dir * 0.10, sy0 + 0.14, sy1 - 0.16,
           a + 0.16, b - 0.16, dir, 1.0, mix(C.glass, C.dark, 0.20));
    skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy0 + 0.22, a, b, 0.03, 1.0, alu);
    skBoxD(P.joinery, face, dir, -0.02, 0.20, sy1 - 0.24, sy1, a, b, 0.03, 0.9, alu);
    skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy1, a, a + 0.22, 0.03, 1.0, alu);
    skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy1, b - 0.22, b, 0.03, 1.0, alu);
    var mn = Math.max(1, Math.round((b - a) / 4.6));
    for (j = 1; j < mn; j++) {
      mz = lerp(a, b, j / mn);
      skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy1,
             mz - 0.10, mz + 0.10, 0.03, 1.0, alu);
    }
  }

  /* Continuous fascia keeps the corner shop legible as one tenancy. */
  skMouldZ(P.render,
           [[-0.02, fa0], [0.47, fa0], [0.47, fa1 - 0.10],
            [0.37, fa1], [-0.02, fa1]],
           face, dir, sz0 - 0.62, sz1 + 0.62, 1.0, mix(tone, C.white, 0.55));
  signCard(P.sign, 'eczane', face + dir * 0.52, 9.70, 130.25,
           0, 0, -dir, 0, 1, 0, 0.9625, C.white);
  pharmacyBlade(face, dir, sz1 - 1.15);

  /* Four 215-mm risers from the side-street pavement to the 1.70-u shop
     floor.  Their whole 5.8-u run remains inside the six-unit footway and
     therefore never steals width from the new carriageway. */
  var stepTone = upTone(mix(C.paver, C.stone, 0.22));
  var sx = [[488.55, 489.82, 0.66], [487.15, 488.55, 0.88],
            [485.75, 487.15, 1.10], [483.98, 485.75, 1.30]];
  for (i = 0; i < sx.length; i++)
    box6(P.stone, sx[i][0], sx[i][1], 0.30, sx[i][2],
         door0 - 0.52, door1 + 0.52, 0.96, stepTone);
  box6(P.paver, 482.70, 484.16, floorY - 0.18, floorY,
       door0 - 0.52, door1 + 0.52, 0.98, stepTone);
  tube(P.metal, [489.55, 1.02, door0 - 0.72], [484.35, 2.35, door0 - 0.72],
       0.075, 7, frame, true, false);
  tube(P.metal, [489.55, 1.02, door1 + 0.72], [484.35, 2.35, door1 + 0.72],
       0.075, 7, frame, true, false);

  STATS.windows = (STATS.windows || 0) + 4;
  STATS.openings = (STATS.openings || 0) + 1;
  STATS.signs = (STATS.signs || 0) + 2;
}

/* ---- shopFront() -----------------------------------------------------
   ground === 'shop'.  The caller has already punched the wall over the
   glazing with rev 1.30, and an opaque back panel closes the box at that
   depth: M.glass is opacity 0.78 with depthWrite off, so without a back panel
   the player looks through the pane at whatever the neighbouring module left
   behind the pier -- park's masonry box behind N-W2 and N-W3, the A-BLOK and
   B-BLOK piers behind N-E2 and S-E1. */
function shopFront(r, spec, seed) {
  if (spec.pharmacy) { pharmacyFront(r, spec, seed); return; }
  var face = r.x, dir = r.dir, tone = r.tone;
  var sz0 = spec.shopZ0, sz1 = spec.shopZ1;
  var sy0 = 2.17, sy1 = 7.35;            /* stallboard top, glazing head     */
  var fa0 = 7.35, fa1 = 10.70;           /* the fascia band                  */
  var bd = 0.32;                         /* depth of the shop box, 91 mm     */
  var i, mz;

  skQuadX(P.render, face - dir * bd, 0, fa0, sz0, sz1, dir, 0.48,
          mix(C.dark, C.shade, 0.30));

  /* stallboard: dark travertine, chamfered top arris */
  skMouldZ(P.stone, [[-0.02, 0], [0.30, 0], [0.30, sy0 - 0.10], [0.20, sy0], [-0.02, sy0]],
           face, dir, sz0 - 0.10, sz1 + 0.10, 1.0,
           groundTone(mix(C.stone, C.dark, 0.32), 0, 1.47));

  /* the glass 0.10 proud and its aluminium frame -- on P.joinery, not metal */
  var gx = face + dir * 0.10, alu = C.steel;
  panelX(P.glass, gx, sy0 + 0.14, sy1 - 0.16, sz0 + 0.16, sz1 - 0.16, dir, 1.0,
         mix(C.glass, C.dark, 0.22));
  skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy0 + 0.22, sz0, sz1, 0.03, 1.0, alu);
  skBoxD(P.joinery, face, dir, -0.02, 0.20, sy1 - 0.24, sy1, sz0, sz1, 0.03, 0.9, alu);
  skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy1, sz0, sz0 + 0.22, 0.03, 1.0, alu);
  skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy1, sz1 - 0.22, sz1, 0.03, 1.0, alu);
  var mn = clamp(Math.round((sz1 - sz0) / 5.25), 2, 6);
  for (i = 1; i < mn; i++) {
    mz = lerp(sz0, sz1, i / mn);
    skBoxD(P.joinery, face, dir, -0.02, 0.20, sy0, sy1, mz - 0.10, mz + 0.10, 0.03, 1.0, alu);
  }

  /* Kepenk kutusu, 1.26 u (360 mm) proud, sitting at the FOOT of the fascia
     so it bulges out in front of the sign board.  Putting it above the fascia
     as the brief reads would drive it straight through the ground storey band
     at 10.80..11.70; at the foot it is also where the box actually sits on
     every shuttered shop in this town. */
  skMouldZ(P.joinery, [[-0.02, fa0], [1.26, fa0 + 0.14], [1.26, fa0 + 1.12],
                       [1.10, fa0 + 1.26], [-0.02, fa0 + 1.26]],
           face, dir, sz0 - 0.24, sz1 + 0.24, 1.0, mix(C.white, tone, 0.22));

  /* fascia: 0.47 proud, mix(tone, white, 0.55) */
  skMouldZ(P.render, [[-0.02, fa0], [0.47, fa0], [0.47, fa1 - 0.10], [0.37, fa1], [-0.02, fa1]],
           face, dir, sz0 - 0.62, sz1 + 0.62, 1.0, mix(tone, C.white, 0.55));

  /* The board.  u runs along the VIEWER'S right -- +z in front of a wall
     facing -x, -z in front of one facing +x -- and u x v is the outward
     normal, which is the whole mirror-writing fix.  Cap height 0.9625 u =
     275 mm, identical on every board in the module, so a 12 u fascia and a
     24 u fascia carry the same letterforms.  Centred at y 9.70, in the
     8.61..10.70 clear zone the kepenk box leaves. */
  if (spec.sign) {
    signCard(P.sign, spec.sign, face + dir * 0.52, 9.70, (sz0 + sz1) * 0.5,
             0, 0, -dir, 0, 1, 0, 0.9625, C.white);
    STATS.signs = (STATS.signs || 0) + 1;
  }

  if (spec.pharmacy) pharmacyBlade(face, dir, sz1 - 1.15);

  if (!spec.quiet) {
    if (hash(seed * 17.0 + 5) < 0.5) skAwning(face, dir, sz0 - 0.4, sz1 + 0.4);
    skABoard(face, dir, (sz1 + 1.6 < r.z1 - 0.6) ? sz1 + 1.6 : sz0 - 1.6);
  }

}

/* ---- shutterFront() ---------------------------------------------------
   ground === 'garage'.  A corrugated curtain, ribs at 3.15 u pitch, 0.26
   proud, one rust weep and a handle nobody has oiled.  The wall behind is NOT
   punched: the curtain is opaque, so a punch would buy nothing but overdraw. */
function shutterFront(r, spec, seed) {
  var face = r.x, dir = r.dir;
  var sz0 = spec.shopZ0, sz1 = spec.shopZ1, sy1 = 7.35, i, yy;
  var base = mix(C.steel, C.dark, 0.28);
  skMouldZ(P.metal, [[-0.02, 0], [0.26, 0], [0.26, sy1], [-0.02, sy1]],
           face, dir, sz0, sz1, 1.0, groundTone(base, 0, 1.47));
  for (i = 0; i * 3.15 < sy1 - 0.6; i++) {
    yy = 0.42 + i * 3.15;
    skMouldZ(P.metal, [[0.26, yy], [0.44, yy + 0.28], [0.26, yy + 0.56]],
             face, dir, sz0 + 0.05, sz1 - 0.05, 1.0, mix(base, C.white, 0.16));
  }
  skBoxD(P.metal, face, dir, -0.02, 0.42, 0, sy1 + 0.30, sz0 - 0.30, sz0, 0.04, 0.9,
         mix(C.steel, C.dark, 0.40));
  skBoxD(P.metal, face, dir, -0.02, 0.42, 0, sy1 + 0.30, sz1, sz1 + 0.30, 0.04, 0.9,
         mix(C.steel, C.dark, 0.40));
  skMouldZ(P.metal, [[-0.02, sy1], [0.72, sy1], [0.72, sy1 + 1.00], [0.60, sy1 + 1.12],
                     [-0.02, sy1 + 1.12]],
           face, dir, sz0 - 0.36, sz1 + 0.36, 1.0, mix(base, C.dark, 0.18));
  tube(P.metal, [face + dir * 0.30, 2.30, (sz0 + sz1) * 0.5 - 0.9],
       [face + dir * 0.30, 2.30, (sz0 + sz1) * 0.5 + 0.9], 0.11, 6,
       mix(C.steel, C.dark, 0.50), true, false);
  skDecal(P.decal, 'D_RUST', face + dir * 0.30, rr(seed, 9, 3.6, 5.4),
          lerp(sz0 + 0.8, sz1 - 0.8, hash(seed * 6.1)),
          0, 0, dir, 0, -1, 0, 0.55, 3.2, mix(C.rail, C.dark, 0.35));
  if (spec.sign) {
    signCard(P.sign, spec.sign, face + dir * 0.78, sy1 + 0.56, (sz0 + sz1) * 0.5,
             0, 0, -dir, 0, 1, 0, 0.42, C.white);
    STATS.signs = (STATS.signs || 0) + 1;
  }
}


/* -----------------------------------------------------------------------
   6.6  SERVICES

   The things that are on nearly every real facade in this country and were on
   none of the old ones: a gas riser and its meter cabinet, an electricity
   meter box, a stapled telecom drop, two downpipes and a gutter.
   -------------------------------------------------------------------- */

/* One downpipe.  Two swan-necks, which is what the old one needed and did not
   have: its shaft ran at depth 0.546 straight into a cornice that is 0.832
   proud, so the top 0.9 u of every pipe on the street vanished inside the
   cornice -- and it was emitted caps:false, so you looked up an open tube.
   Lower leg 0.76 proud to clear the plinth's 0.52; main shaft 0.56 (0.76
   overall, inside HUG 0.98); head 1.08, which puts the pipe's inner face at
   0.88, clear of the cornice front at 0.83 -- and that leg starts above
   y = top - 1.05, far over jumpTop, so its projection is rule-B legal. */
function skDownpipe(face, dir, zc, top, roofed, tone, g, side) {
  var lo = 0.76, mid = 0.56, hi = 1.08, i, yy;
  var xd = function (d) { return face + dir * d; };
  tube(P.joinery, [xd(lo), 0.90, zc], [xd(lo), 5.60, zc], 0.20, 8, C.pipe, true, false);
  tube(P.joinery, [xd(lo), 5.60, zc], [xd(mid), 6.30, zc], 0.20, 8, C.pipe, true, false);
  tube(P.joinery, [xd(mid), 6.30, zc], [xd(mid), top - 1.05, zc], 0.20, 8, C.pipe, true, false);
  tube(P.joinery, [xd(mid), top - 1.05, zc], [xd(hi), top - 0.35, zc], 0.20, 8, C.pipe, true, false);
  tube(P.joinery, [xd(hi), top - 0.35, zc], [xd(hi), roofed ? top + 0.55 : top - 0.05, zc],
       0.20, 8, C.pipe, true, false);
  /* the shoe: it spits onto the footway, and it is capped */
  tube(P.joinery, [xd(lo), 0.90, zc], [xd(lo + 0.55), 0.42, zc], 0.20, 8, C.pipe, true, false);
  if (!roofed)
    /* no roof of our own on this run, so the pipe ends in a hopper */
    skBoxD(P.joinery, face, dir, hi - 0.42, hi + 0.42, top - 0.05, top + 0.70,
           zc - 0.42, zc + 0.42, 0.10, 1.0, C.pipe);
  for (i = 0; i < 5; i++) {
    yy = lerp(7.5, top - 3.0, i / 4);
    skBoxD(P.metal, face, dir, -0.02, mid + 0.26, yy, yy + 0.26, zc - 0.34, zc + 0.34,
           0.03, 0.62, mix(C.steel, C.dark, 0.32));
  }
  /* ONE bracket weep per pipe, off the second bracket down, which is where
     the socket joint in a 3 m pipe length falls.  The old pass hung one off
     every other bracket -- three per pipe, six per run, each of them a card
     starting 1.4 u BELOW the bracket with clear wall between the two.  `side`
     puts the weep on the corner side of the pipe: the run's outer bay window
     starts about 2.1 u inboard of the pipe and the register would refuse a
     weep laid on that side anyway. */
  streakRun(g, 'D_RUST', zc + (side || -1) * 0.42, m(0.15),
            lerp(7.5, top - 3.0, 0.75), m(1.5), m(0.80),
            mix(tone, C.rail, 0.45));
  /* THE SHOE.  The pipe spits onto the footway and the plinth beside it never
     dries.  This one is laid at d 0.60, ON the plinth face: the old card was
     at 0.055 and y 1.4..3.8, i.e. entirely INSIDE a plinth whose front face
     is at 0.52 -- twenty-two invisible cards over the thirteen runs.  It runs
     from the plinth's own top arris down, and the register refuses it wherever
     a door or a garage has taken the plinth away. */
  streakRun(g, 'D_DRIP', zc, m(0.24), PLINTH_TOP, m(1.2), m(0.80),
            mix(tone, C.dark, 0.44), 0.60);
}

/* The eaves gutter: a HALF-ROUND, not a full cylinder.  The old one was a
   full tube at y 52.0..52.6 while the roof soffit occupies 51.43..52.20, so
   the two interpenetrated for the whole length of every roofed run.  This
   sits 1.05 proud with its lip at y = top + 0.55, clear of the soffit, on
   brackets at 2.8 u centres. */
function skGutter(face, dir, z0, z1, top) {
  var yc = top + 0.55, r = 0.42, sec = [], i, a, zz;
  for (i = 0; i <= 8; i++) {
    a = Math.PI + i / 8 * Math.PI;               /* the lower half only */
    sec.push([1.05 + Math.cos(a) * r, yc + Math.sin(a) * r]);
  }
  skMouldZ(P.metal, sec, face, dir, z0 - 0.30, z1 + 0.30, 1.0, upTone(C.gutter));
  for (i = 0; (z0 + i * 2.8) < z1; i++) {
    zz = z0 + i * 2.8;
    skBoxD(P.metal, face, dir, -0.02, 1.52, yc - 0.55, yc - 0.35, zz - 0.12, zz + 0.12,
           0.03, 0.62, mix(C.steel, C.dark, 0.30));
  }
}

function servicesRun(r, seed, g) {
  var face = r.x, dir = r.dir, top = r.top, tone = r.tone;
  var gz = r.z0 + (r.z1 - r.z0) * 0.32, i;
  /* THE RISER IS NOT YELLOW.  It was, and a six-metre chrome-yellow stack on
     every elevation was the loudest thing on the street from thirty metres -
     brighter than the shopfronts, brighter than the sky on the wall.  A Turkish
     dogalgaz kolonu is a painted steel pipe, grey or cream to match the render
     it is bolted to, and the yellow on it is a LABEL: a 200 mm warning plate on
     the cabinet door, which is all the yellow this wall gets. */
  var riser = mix(C.grey, C.white, 0.42);
  var cab = mix(C.cream, C.grey, 0.30);
  var yellow = L(0xc8a01e);

  /* the gas riser at 0.76 proud (0.96 overall, inside HUG) so it clears the
     plinth's 0.52, and its cabinet ABOVE the plinth top at 5.075 */
  tube(P.joinery, [face + dir * 0.76, 0.30, gz], [face + dir * 0.76, 21.35, gz],
       0.20, 8, riser, true, false);
  skBoxD(P.joinery, face, dir, -0.02, 0.98, 5.40, 7.50, gz - 0.665, gz + 0.665,
         0.06, 1.0, cab);
  for (i = 0; i < 3; i++)
    skBoxD(P.joinery, face, dir, 0.98, 1.02, 5.72 + i * 0.42, 5.72 + i * 0.42 + 0.18,
           gz - 0.48, gz + 0.48, 0.01, 0.9, mix(cab, C.dark, 0.34));
  /* the label: 200 x 140 mm on the cabinet door, and the only yellow here */
  skBoxD(P.joinery, face, dir, 1.02, 1.04, 6.52, 7.02, gz + 0.10, gz + 0.80,
         0.01, 1.0, yellow);
  for (i = 0; i < 5; i++)
    skBoxD(P.metal, face, dir, -0.02, 0.96, 8.4 + i * 2.9, 8.4 + i * 2.9 + 0.22,
           gz - 0.26, gz + 0.26, 0.02, 0.62, mix(C.steel, C.dark, 0.35));

  /* the electricity meter box, also clear of the plinth */
  var ez = r.z0 + (r.z1 - r.z0) * 0.62;
  skBoxD(P.joinery, face, dir, -0.02, 0.60, 5.40, 6.80, ez - 0.525, ez + 0.525,
         0.05, 1.0, mix(C.grey, C.white, 0.35));
  skBoxD(P.joinery, face, dir, 0.60, 0.63, 5.66, 6.54, ez - 0.36, ez + 0.36,
         0.01, 0.9, mix(C.dark, C.grey, 0.30));

  /* the telecom drop, stapled at y 10.9 and zig-zagging, because nobody has
     ever run one of these straight */
  var seg = Math.max(3, Math.floor((r.z1 - r.z0) / 7)), ty = 10.9;
  for (i = 0; i < seg; i++) {
    var za = lerp(r.z0 + 0.8, r.z1 - 0.8, i / seg);
    var zb = lerp(r.z0 + 0.8, r.z1 - 0.8, (i + 1) / seg);
    var ya = ty + rr(seed, i, -0.34, 0.34), yb = ty + rr(seed, i + 1, -0.34, 0.34);
    tube(P.joinery, [face + dir * 0.13, ya, za], [face + dir * 0.13, yb, zb],
         0.06, 5, mix(C.dark, C.grey, 0.28), true, false);
  }

  skDownpipe(face, dir, r.z0 + 1.4, top, r.roof === true, tone, g, -1);
  skDownpipe(face, dir, r.z1 - 1.4, top, r.roof === true, tone, g, 1);
  if (r.roof === true) {
    skGutter(face, dir, r.z0, r.z1, top);
    /* THE GUTTER JOINTS.  A gutter is delivered in three-metre lengths and it
       is the joints that leak, so the streaks go on the BAY LINES -- which is
       also the only place on this elevation with clear wall from the eaves
       down, since every bay centre is a window.  streakRun() refuses any that
       is not clear, so what comes out is whatever the run's own lattice
       allows, capped at three: a fifty-metre elevation is not entitled to
       more leaking joints than that.  Anchored at top + 0.13, the gutter's
       own underside; the cornice at 0.83 proud swallows the first 1.03 u of
       it and the streak reappears below the cornice bed, as it does in life. */
    var nby = r.bays || 2, bwd = (r.z1 - r.z0) / nby, gi, gn = 0;
    for (gi = 1; gi < nby && gn < 3; gi++)
      if (streakRun(g, 'D_STREAK', r.z0 + bwd * gi, m(0.22), top + 0.13,
                    m(2.6), m(1.40), mix(tone, C.dark, 0.44))) gn++;
  }
}


/* -----------------------------------------------------------------------
   6.7  GRIME

   ONE pass now, and it is the one the brief asks to keep: the ground-line
   splash band at the foot of every wall.  That band is what stops a run
   looking printed rather than built, and unlike a streak it is not hung off
   anything -- rain bounces off the whole width of the footway, so it is
   continuous for the whole width of the plinth.

   WHAT WENT.  (a) five algae cards per run "in the corners and under the pipe
   lines", placed by rr() at a y between 1.2 and 6.5 -- three of the five were
   inside the plinth solid at d 0.52 and none of the five had a source.
   (b) the scattered pass: one card per 140 u2 of elevation, 4 to 18 a run,
   212 over the street, positioned by three hashes over the wall area.  That
   pass IS the artifact the renders show -- dark blobs beside balconies, in
   the middle of blank wall and around the block name lettering, none of them
   with anything above them.  A wall does not stain where nothing runs down
   it, so there is no replacement for it: the corners and the open wall are
   now clean, and everything that is dirty is dirty because of the thing
   directly above it.

   TWO THINGS THE BAND ITSELF NEEDED.  It was emitted at 0.46 of its own
   section width, so a 40 u run got two 9.2 u cards 20 u apart -- two blobs at
   the base rather than a band.  And it was emitted across the whole run
   whether or not the plinth was there, so it crossed the shopfronts and the
   garage.  It now runs per PLINTH SEGMENT at 0.99 of the section, so it is
   continuous, it breaks where the plinth breaks, and it covers the whole foot
   of every wall for eleven more cards over the street than the gapped version
   cost -- which is the one place in this section where the count went UP, and
   the only place it should have.
   -------------------------------------------------------------------- */
function grimeRun(r, g, segs) {
  var i, j, sgz0, sgz1, nb, w, zz, tn = mix(r.tone, C.dark, 0.45);
  for (j = 0; j < segs.length; j++) {
    sgz0 = segs[j][0]; sgz1 = segs[j][1];
    if (sgz1 - sgz0 < 1.2) continue;
    /* One card per 14 u (4.0 m) of plinth, each 0.99 of its own section so
       the run of them abuts and reads as one band; laid at d 0.60, 0.08 proud
       of the plinth's own 0.52 front face.  14 and not the old 22 because a
       card is a 256 px atlas cell and 22 u at 1.0 u tall stretches it 22:1 --
       past 14:1 the cell stops reading as grain and starts reading as a
       smear.  A short plinth stub between a garage and a door still gets its
       one card: the band breaking where the plinth breaks is the point. */
    nb = Math.max(1, Math.ceil((sgz1 - sgz0) / 14));
    w = (sgz1 - sgz0) / nb;
    for (i = 0; i < nb; i++) {
      zz = lerp(sgz0, sgz1, (i + 0.5) / nb);
      skDecal(P.decal, 'D_GROUND', g.face + g.dir * 0.60, 1.0, zz,
              0, 0, -g.dir, 0, 1, 0, w * 0.99, 1.0, tn);
    }
  }
}


/* -----------------------------------------------------------------------
   6.8  ONE RUN
   -------------------------------------------------------------------- */
function runSkin(r, ri) {
  var spec = skinSpec(r);
  var face = r.x, dir = r.dir, z0 = r.z0, z1 = r.z1;
  var st = r.storeys, top = r.top, tone = r.tone;
  var seed = ri * 131 + 17;
  var i, s, b, h;

  /* skin depths, from the site plan.  Each is the distance the element stands
     PROUD of the face, and every prism starts at d = -0.02. */
  var PL_D = 0.52, PL_TOP = 5.075;    /* plinth: 149 mm proud, 1.45 m tall  */
  var GB_D = 0.36, GB_Y0 = 10.80, GB_Y1 = 11.70;    /* ground storey band   */
  var FB_D = 0.18;                    /* floor bands: 51 mm                 */
  var CO_D = 0.83;                    /* cornice: 237 mm                    */
  var REV_U = 1.10, REV_GD = 0.72;    /* reveals: 314 mm upper, 206 ground  */
  var WS = m(0.95);                   /* upper sill, 3.325 above the floor  */
  var GS0 = 5.60, GS1 = 10.08;        /* ground window, sill clear of plinth */

  /* THE RUNS WHOSE WINDOWS MUST BE BUILT PROUD.

     The four 230 Sk stubs stand over an engine wall quad 0.02 behind the skin
     (see windowX), so a recessed sash there is a sash nobody sees.

     N-W3 is the SAME DEFECT arriving by a different route, and it is visible
     in every frame of the pharmacy corner.  That run is the one entry in the
     table with massPier: [] and massBlock: [] -- "park's box is the mass
     here" -- and nz-street-park's northApartment stands PROUD of the plane
     our sash sits on.  So punching the wall opens a hole onto ANOTHER
     MODULE'S FACADE: the pane, its frame, the dark room behind it and the
     reveal are all buried, and what the player sees framed by our cill and
     sove is a flat pale rectangle of park's masonry with park's own windows
     printed on it.  Rendered green as a test, not one upper opening on this
     run changed colour, which is the proof: nothing of ours was on screen
     inside those openings at all.

     A run with no mass of its own therefore builds its windows the way the
     stubs do -- wall left intact, dark spandrel on it, sash and sove in front
     -- which is also what the real building is: a shallow uPVC window in a
     trim surround on a rendered wall, not a 310 mm reveal.  Written as a test
     on the table rather than as a second id so a future run that loses its
     mass cannot inherit the bug in silence. */
  /* ...and it is a decision PER OPENING, not per run, because a run's own
     mass does not always reach the ends of its skin.  N-W2's table entry
     stops its pier and block at z 103.5 (section 7 truncates it further, to
     102.30, to stay clear of park's northRoof) while its skin runs to z 124,
     so the last twenty units of that elevation are in exactly N-W3's
     position: nothing of ours behind them and park's masonry standing proud
     of the sash plane.  Testing the opening's own z against the union of the
     run's mass spans catches both, and catches the next one automatically. */
  /* The z span is taken from msMassSpec(), NOT from the run's own massPier /
     massBlock rectangles, because section 7 truncates three of them against
     other modules and the table still carries the untruncated numbers -- N-E2
     is written to z 140 and built to 135.60, N-W2 written to 103.5 and built
     to 102.30.  Asking the mass builder what it actually built is the only
     reading that cannot drift.  If it declines (a disabled or unknown run),
     every opening on that run is flush, which is the safe direction: a flush
     window is a shallower window, a recessed one over nothing is a hole. */
  var alwaysFlush = !!(r.id && r.id.charAt(0) === 'X');
  var msp = null;
  if (!alwaysFlush) {
    try { msp = (typeof msMassSpec === 'function') ? msMassSpec(r) : null; }
    catch (e) { msp = null; }
  }
  function flushAt(zc) {
    if (alwaysFlush || !msp) return true;
    return !(zc > msp.z0 + 0.5 && zc < msp.z1 - 0.5);
  }
  var bays = r.bays || Math.max(2, Math.round((z1 - z0) / m(3.6)));
  var bw = (z1 - z0) / bays;
  var ops = [], breaks = [];

  /* ---- 1. the openings the level itself dictates -------------------- */
  var rh = r.holes || [];
  for (i = 0; i < rh.length; i++) {
    h = rh[i];
    var isDoor = h.y0 < 5.0;
    ops.push({ kind: isDoor ? 'door' : 'loggia', z0: h.z0, z1: h.z1, y0: h.y0, y1: h.y1,
               rev: isDoor ? REV_GD : REV_U, sill: !isDoor });
    breaks.push([h.z0 - 0.30, h.z1 + 0.30]);
  }

  /* ---- 2. the shopfront or the garage ------------------------------- */
  if (spec.ground === 'shop') {
    /* rev 0.34, not the reveal depth: SECTION 7's mass front face is stated
       at 0.34 behind the skin, so a deeper shop box would be covered by it
       and the pane would show render where a dark interior belongs */
    ops.push({ kind: 'shop', z0: spec.shopZ0, z1: spec.shopZ1, y0: 2.17, y1: 7.35,
               rev: 0.34 });
    breaks.push([spec.shopZ0 - 0.70, spec.shopZ1 + 0.70]);
  } else if (spec.ground === 'garage') {
    /* not punched -- the curtain is opaque -- but it still breaks the plinth */
    breaks.push([spec.shopZ0 - 0.40, spec.shopZ1 + 0.40]);
  }

  /* ---- 3. the bay lattice: windows, balcony doors, loggias ---------- */
  var wins = [], bals = [];
  /* one flat on this elevation has replaced its joinery, so no run can come
     out all-PVC by chance */
  var oddS = 1 + Math.floor(hash(seed * 3.7) * st);
  var oddB = Math.floor(hash(seed * 4.3) * bays);
  var oddM = hash(seed * 5.1) < 0.45 ? 1 : 2;
  /* the head height varies by RUN, which is what makes the street read as
     several buildings: m(1.35) is under the transom threshold, the other
     two are over it */
  var wH = [m(1.35), m(1.50), m(1.62)][Math.floor(hash(seed * 6.7) * 3)];

  for (s = 1; s <= st; s++) {
    var yF = fy(s), wy0 = yF + WS, wy1 = yF + WS + wH;
    for (b = 0; b < bays; b++) {
      var bc = z0 + bw * (b + 0.5);
      var hw = Math.min(m(0.72), bw * 0.30);
      var bz0 = bc - hw, bz1 = bc + hw, taken = false;
      for (i = 0; i < rh.length; i++)
        if (rh[i].z1 > bz0 - 1.2 && rh[i].z0 < bz1 + 1.2 &&
            rh[i].y1 > wy0 - 0.5 && rh[i].y0 < wy1 + 0.5) taken = true;
      if (taken) continue;

      if (b % 3 === 1) {
        /* a balcony stack: its door, and on a wide bay a window beside it,
           punched in the wall BEHIND the slab */
        var pz0 = bc - bw * 0.38, pz1 = bc + bw * 0.38;
        var dz0 = pz0 + 0.70, dz1 = dz0 + m(0.95);
        ops.push({ kind: 'baldoor', z0: dz0, z1: dz1, noPunch: flushAt(bc),
                   y0: yF + 0.55, y1: yF + 0.55 + m(2.10), rev: 0.40, sill: false });
        if (pz1 - pz0 > 8.5)
          ops.push({ kind: 'balwin', z0: pz1 - 0.70 - m(0.95), z1: pz1 - 0.70,
                     y0: wy0, y1: wy1, rev: 0.40, noPunch: flushAt(bc) });
        bals.push({ z0: pz0, z1: pz1, y: yF + 0.55, s: s, b: b });
      } else {
        ops.push({ kind: 'win', z0: bz0, z1: bz1, y0: wy0, y1: wy1, rev: REV_U,
                   noPunch: flushAt(bc) });
        wins.push({ z0: bz0, z1: bz1, y0: wy0, y1: wy1, s: s, b: b, ground: false });
      }
    }
  }

  /* the ground storey's own windows, wherever the shop, the garage and the
     doors have left room.  Sill at 5.60 puts them clear of the plinth top at
     5.075 -- 1.46 m over the pavement, which is what a Turkish ground-floor
     sill is, and it is why they are all grilled. */
  for (b = 0; b < bays; b++) {
    var gc = z0 + bw * (b + 0.5);
    var ghw = Math.min(m(0.66), bw * 0.28);
    var gz0 = gc - ghw, gz1 = gc + ghw, ok = true;
    for (i = 0; i < breaks.length; i++)
      if (breaks[i][1] > gz0 - 0.8 && breaks[i][0] < gz1 + 0.8) ok = false;
    if (!ok) continue;
    ops.push({ kind: 'win', z0: gz0, z1: gz1, y0: GS0, y1: GS1, rev: REV_GD,
               noPunch: flushAt(gc) });
    wins.push({ z0: gz0, z1: gz1, y0: GS0, y1: GS1, s: 0, b: b, ground: true });
  }

  /* ---- 3b. the no-go register -------------------------------------- */
  /* Everything a streak may not cross, in (z, y) on the face plane, and it is
     built HERE -- after the lattice, before the first card -- because
     streakRun() clips against the whole list and a block registered later
     than the streak it should have stopped is not a block at all.

     Each rectangle is the opening PLUS its trim: a sove stands 0.30 either
     side, a lintel band 0.40, a panjur box 0.62 over the head, a door
     architrave 0.90 all round.  The rectangle's FOOT is the opening's own
     cill and NOT the cill's drip shadow, so a window's own streak is not
     refused by the window it hangs from.  Balconies go in soft (hard 0):
     solid from the street, so nothing may run down across one, but their back
     wall is where the dish bracket and the condenser hang and those sources
     are legitimately inside the rectangle. */
  var G = skStreakCtx(face, dir, tone), ob;
  for (i = 0; i < ops.length; i++) {
    ob = ops[i];
    if (ob.kind === 'door')
      skBlock(G, ob.z0 - 0.95, ob.z1 + 0.95, ob.y0, ob.y1 + 0.95, 1);
    else if (ob.kind === 'loggia')
      /* the void, plus the parapet and coping standing in front of it */
      skBlock(G, ob.z0 - 0.10, ob.z1 + 0.10, ob.y0,
              Math.max(ob.y1, ob.y0 + 3.85), 1);
    else if (ob.kind === 'shop')
      /* down to the pavement and up to the head of the fascia at 10.70 */
      skBlock(G, ob.z0 - 0.95, ob.z1 + 0.95, 0, 10.75, 1);
    else
      skBlock(G, ob.z0 - 0.42, ob.z1 + 0.42, ob.y0, ob.y1 + 0.66, 1);
  }
  if (spec.ground === 'garage')
    /* not punched, but a streak on a roller shutter is the same mistake */
    skBlock(G, spec.shopZ0 - 0.42, spec.shopZ1 + 0.42, 0, 8.50, 1);
  for (i = 0; i < bals.length; i++)
    skBlock(G, bals[i].z0 - 0.10, bals[i].z1 + 0.10,
            bals[i].y - 0.62, bals[i].y + m(2.55), 0);
  /* the block name board, which is exactly where the renders show a blob */
  if (spec.nameSign) {
    var nsz = (z0 + z1) * 0.5, nsw = 13.0, nsh = 2.2, nss;
    for (i = 0; i < ops.length; i++)
      if (ops[i].kind === 'door') { nsz = (ops[i].z0 + ops[i].z1) * 0.5; break; }
    if (typeof signSize === 'function') {
      nss = signSize(spec.nameSign, 0.72);
      if (nss) { nsw = nss.w; nsh = nss.h; }
    }
    skBlock(G, nsz - nsw * 0.5 - 0.40, nsz + nsw * 0.5 + 0.40,
            12.55 - nsh * 0.5 - 0.40, 12.55 + nsh * 0.5 + 0.40, 1);
  }

  /* ---- 4. the wall, punched ---------------------------------------- */
  wallX(P.render, face, dir, z0, z1, 0, top, ops, tone, top);

  /* ---- 5. the mouldings -------------------------------------------- */
  var segs = skSegments(z0, z1, breaks), sgi;
  /* plinth: travertine, chamfered top arris (k 0.10 = 29 mm), carrying the
     ground-line soiling over its first 420 mm */
  for (sgi = 0; sgi < segs.length; sgi++)
    skMouldZ(P.stone, [[-0.02, 0], [PL_D, 0], [PL_D, PL_TOP - 0.10],
                       [PL_D - 0.10, PL_TOP], [-0.02, PL_TOP]],
             face, dir, segs[sgi][0], segs[sgi][1], 1.0, groundTone(C.stone, 0, 1.47));
  /* the ground storey band, broken by the same things: a door hole reaches
     11.2 and a loggia starts at 11.2, both of which cross 10.80..11.70 */
  for (sgi = 0; sgi < segs.length; sgi++)
    skMouldZ(P.render, [[-0.02, GB_Y0], [GB_D, GB_Y0], [GB_D, GB_Y1 - 0.10],
                        [GB_D - 0.10, GB_Y1], [-0.02, GB_Y1]],
             face, dir, segs[sgi][0], segs[sgi][1], 1.0, mix(tone, C.white, 0.5));
  /* the floor bands */
  for (i = 2; i <= st; i++)
    skMouldZ(P.render, [[-0.02, fy(i) - 0.30], [FB_D, fy(i) - 0.30],
                        [FB_D, fy(i) + 0.22], [-0.02, fy(i) + 0.22]],
             face, dir, z0, z1, 1.0, mix(tone, C.white, 0.30));
  /* the cornice, chamfered, at the head of every run whether or not that run
     also carries a roof of its own */
  skMouldZ(P.render, [[-0.02, top - 0.90], [CO_D - 0.14, top - 0.90],
                      [CO_D, top - 0.62], [CO_D, top - 0.14], [CO_D - 0.14, top],
                      [-0.02, top]],
           face, dir, z0, z1, 1.0, upTone(mix(tone, C.white, 0.35)));

  /* The eaves occluder, chopped into <= 24 u slices.  Registered HERE, before
     the balconies and the awnings, because skOcc() takes a hard fourteen out
     of the 220 nz-street-sky shares between five modules and the eaves band is
     the one that pays: it is the only thing darkening the head of every wall.
     UNDER the cornice, never around it -- the cornice foot is at top - 0.90
     and the box top at top - 1.03, 0.13 u clear -- and the box's inner face is
     0.13 clear of the wall plane, so no wall vertex lands on its boundary.
     hitsBoxT exempts only a ray origin STRICTLY inside a box: a vertex exactly
     on the boundary is fully blocked, which is how nz-street-park's two
     shelter roofs first came back as solid black slabs. */
  if (r.roof === true) {
    var nsl = Math.ceil((z1 - z0) / 24);
    for (i = 0; i < nsl; i++)
      skOcc(face + dir * 0.13, top - 2.45, z0 + (z1 - z0) * i / nsl,
            face + dir * 1.40, top - 1.03, z0 + (z1 - z0) * (i + 1) / nsl);
  }

  /* ---- 6. the assemblies ------------------------------------------- */
  for (i = 0; i < wins.length; i++) {
    var wn = wins[i];
    var wseed = seed + wn.s * 31 + wn.b * 7;
    var fm = (wn.s === oddS && wn.b === oddB) ? oddM
           : (hash(wseed * 2.3) < 0.77 ? 0 : (hash(wseed * 2.9) < 0.43 ? 1 : 2));
    /* A CILL STREAK IS NOT AUTOMATIC.  The old pass put one under every upper
       cill on the street -- twelve to twenty-five on a run, about a hundred
       and eighty in all.  Two gates cut it to three or four.  The TOP TWO
       STOREYS take the weather; everything below stands in the lee of the
       balconies and of the storeys above it and the render there is merely
       dirty, not streaked.  And of the cills up there only about half have a
       drip that has actually failed -- the others still throw the water
       clear, which is what the arris under a cill is for. */
    var wsk = !wn.ground && wn.s >= st - 1 && hash(wseed * 5.3 + 11) < 0.5;
    windowX(face, dir, wn.z0, wn.z1, wn.y0, wn.y1,
            { rev: wn.ground ? REV_GD : REV_U, ground: wn.ground, seed: wseed,
              tone: tone, frame: fm, streak: wsk,
              flush: flushAt((wn.z0 + wn.z1) * 0.5), g: G });
  }

  for (i = 0; i < ops.length; i++) {
    var o = ops[i];
    if (o.kind === 'baldoor') {
      var dseed = seed + Math.round(o.z0) * 3 + Math.round(o.y0);
      /* same shallow-sash rule as windowX: everything visible inside 0.32 */
      var bfl = flushAt((o.z0 + o.z1) * 0.5);
      var bp = bfl ? -0.03 : 0.36, bf0 = bfl ? -0.13 : -0.32, bf1 = bfl ? -0.02 : -0.18;
      var bg = bfl ? -0.08 : 0.25;
      skQuadX(P.render, face - dir * bp, o.y0, o.y1, o.z0, o.z1, dir, 0.48,
              mix(C.dark, C.shade, 0.30));
      skBoxD(P.joinery, face, dir, bf0, bf1, o.y0, o.y1, o.z0, o.z0 + 0.22, 0, 1.0, C.white);
      skBoxD(P.joinery, face, dir, bf0, bf1, o.y0, o.y1, o.z1 - 0.22, o.z1, 0, 1.0, C.white);
      skBoxD(P.joinery, face, dir, bf0, bf1, o.y1 - 0.24, o.y1, o.z0, o.z1, 0, 0.9, C.white);
      panelX(P.glass, face - dir * bg, o.y0 + 0.10, o.y1 - 0.26, o.z0 + 0.20, o.z1 - 0.20,
             dir, 1.0, skPaneTone(Math.floor(hash(dseed * 3.3) * 5)));

    } else if (o.kind === 'balwin') {
      windowX(face, dir, o.z0, o.z1, o.y0, o.y1,
              { rev: 0.40, ground: false, seed: seed + Math.round(o.z0),
                tone: tone, frame: 0, streak: false,
                flush: flushAt((o.z0 + o.z1) * 0.5), g: G });

    } else if (o.kind === 'loggia') {
      loggiaVoid(face, dir, o.z0, o.z1, o.y0, tone, seed + Math.round(o.z0));

    } else if (o.kind === 'door') {
      /* A proud architrave round every gameplay door.  buildWorld draws its
         own header from f + 8.2 to the region ceiling on this plane, and the
         architrave is what stops that seam reading as a mistake. */
      var arc = [[-0.02, o.y0], [0.30, o.y0], [0.30, o.y1 + 0.90], [-0.02, o.y1 + 0.90]];
      var arcT = upTone(mix(C.stone, C.white, 0.25));
      skMouldZ(P.stone, arc, face, dir, o.z0 - 0.90, o.z0, 1.0, arcT);
      skMouldZ(P.stone, arc, face, dir, o.z1, o.z1 + 0.90, 1.0, arcT);
      skMouldZ(P.stone, [[-0.02, o.y1 + 0.30], [0.42, o.y1 + 0.30],
                         [0.42, o.y1 + 0.90], [-0.02, o.y1 + 0.90]],
               face, dir, o.z0 - 0.90, o.z1 + 0.90, 1.0, arcT);
      /* The pharmacy opening is a glazed retail threshold, not an apartment
         door, so it gets no house-number plaque. */
      if (!spec.pharmacy) {
        signCard(P.sign, 'numara', face + dir * 0.06, 8.40, o.z1 + 1.55,
                 0, 0, -dir, 0, 1, 0, 0.42, C.white);
        STATS.signs = (STATS.signs || 0) + 1;
      }
      if (spec.nameSign) {
        signCard(P.sign, spec.nameSign, face + dir * 0.40, 12.55, (o.z0 + o.z1) * 0.5,
                 0, 0, -dir, 0, 1, 0, 0.72, C.white);
        STATS.signs = (STATS.signs || 0) + 1;
        spec.nameSign = null;
      }
    }
  }
  /* a name board on a block that has no door hole of its own */
  if (spec.nameSign) {
    signCard(P.sign, spec.nameSign, face + dir * 0.40, 12.55, (z0 + z1) * 0.5,
             0, 0, -dir, 0, 1, 0, 0.72, C.white);
    STATS.signs = (STATS.signs || 0) + 1;
    spec.nameSign = null;
  }

  /* balconies, seeded per STACK so a stack is consistent from the ground up
     the way a real one is, and glazed or open per stack, not per floor */
  for (i = 0; i < bals.length; i++) {
    var ba = bals[i];
    balconyX(face, dir, ba.z0, ba.z1, ba.y,
             hash(seed * 8.3 + ba.b * 13) > 0.45, tone, seed + ba.b * 47 + ba.s * 11, G);
    /* a contact shadow under the lowest slab of the two stacks that face the
       roundabout, 0.15 u clear of the slab soffit and 0.13 clear of the wall */
    if (ba.s === 1 && (r.id === 'N-E2' || r.id === 'S-W1'))
      skOcc(face + dir * 0.13, ba.y - 1.70, ba.z0 + 0.10,
            face + dir * m(1.05), ba.y - 0.77, ba.z1 - 0.10);
  }

  /* ---- 7. the ground storey's own front ---------------------------- */
  if (spec.ground === 'shop') {
    shopFront(r, spec, seed);
  }
  else if (spec.ground === 'garage') shutterFront(r, spec, seed);

  /* ---- 8. services and grime --------------------------------------- */
  servicesRun(r, seed, G);
  grimeRun(r, G, segs);
  if (G.n > 22) warn('skin ' + r.id + ' emitted ' + G.n + ' streaks');

  STATS.elevations = (STATS.elevations || 0) + 1;
}


/* -----------------------------------------------------------------------
   6.9  THE WEST MOUTH RETURN  (run N-W3, plane z = 144.95, facing +z)

   The park apartment remains the structural mass.  This is an opaque
   residential return with two recessed, grilled ground-floor windows and a
   street plate, matching the low wall-and-window corner in the references.
   -------------------------------------------------------------------- */
function legacyResidentialWestMouthReturn() {
  var zf = 144.95, zd = 1;
  var x0 = 534.00, x1 = 548.02, top = 11.90, tone = C.cream;
  var wy0 = 2.17, wy1 = 7.35;
  var win = [[536.50, 541.00], [541.50, 546.00]];
  var faceTone = groundTone(tone, 0, 1.47);
  var i, mi, mx, wx0, wx1;

  /* the wall, punched: three full-height piers and the two window heads and
     aprons */
  var cols = [[x0, win[0][0]], [win[0][1], win[1][0]], [win[1][1], x1]];
  for (i = 0; i < cols.length; i++)
    skQuadZ(P.render, zf, 0, top, cols[i][0], cols[i][1], zd, 1.0, faceTone);
  for (i = 0; i < win.length; i++) {
    skQuadZ(P.render, zf, 0, wy0, win[i][0], win[i][1], zd, 1.0, faceTone);
    skQuadZ(P.render, zf, wy1, top, win[i][0], win[i][1], zd, 1.0, faceTone);
  }

  for (i = 0; i < win.length; i++) {
    wx0 = win[i][0]; wx1 = win[i][1];
    /* the shallow box: dark back panel, two cheeks, a soffit and a sill */
    skQuadZ(P.render, 144.70, wy0, wy1, wx0, wx1, zd, 0.48, mix(C.dark, C.shade, 0.35));
    skQuadX(P.render, wx0, wy0, wy1, 144.70, zf,  1, 0.62, mix(tone, C.shade, 0.35));
    skQuadX(P.render, wx1, wy0, wy1, 144.70, zf, -1, 0.62, mix(tone, C.shade, 0.35));
    skQuadY(P.render, wy1, wx0, wx1, 144.70, zf, -1, 0.40, mix(tone, C.shade, 0.55));
    skQuadY(P.render, wy0, wx0, wx1, 144.70, zf,  1, 0.62, mix(tone, C.shade, 0.45));
    /* glass 0.03 proud of the face, PVC frame, two intermediate mullions */
    poly(P.glass, [[wx0 + 0.24, wy0 + 0.24, zf + 0.03], [wx1 - 0.24, wy0 + 0.24, zf + 0.03],
                   [wx1 - 0.24, wy1 - 0.26, zf + 0.03], [wx0 + 0.24, wy1 - 0.26, zf + 0.03]],
         [(wx0 + wx1) * 0.5, (wy0 + wy1) * 0.5, zf - 1.0], 1.0, skPaneTone(i === 0 ? 2 : 3));
    skMouldX(P.joinery, [[-0.02, wy0], [0.16, wy0], [0.16, wy0 + 0.24], [-0.02, wy0 + 0.24]],
             zf, zd, wx0, wx1, 1.0, C.white);
    skMouldX(P.joinery, [[-0.02, wy1 - 0.26], [0.16, wy1 - 0.26], [0.16, wy1], [-0.02, wy1]],
             zf, zd, wx0, wx1, 0.9, C.white);
    skMouldX(P.joinery, [[-0.02, wy0], [0.16, wy0], [0.16, wy1], [-0.02, wy1]],
             zf, zd, wx0, wx0 + 0.20, 1.0, C.white);
    skMouldX(P.joinery, [[-0.02, wy0], [0.16, wy0], [0.16, wy1], [-0.02, wy1]],
             zf, zd, wx1 - 0.20, wx1, 1.0, C.white);
    for (mi = 1; mi <= 2; mi++) {
      mx = lerp(wx0, wx1, mi / 3);
      skMouldX(P.joinery, [[-0.02, wy0], [0.16, wy0], [0.16, wy1], [-0.02, wy1]],
               zf, zd, mx - 0.11, mx + 0.11, 1.0, C.white);
    }
    /* The cill with its drip.  NO streak off it: this window's cill is at
       y 1.81 and the plinth top is at 5.075, so there is no wall under it at
       all -- the old card ran from 1.32 down to -0.60, buried in the plinth
       solid at d 0.52 for its whole length and half of it below the paving.
       The splash band along the plinth below is the only grime this frontage
       is entitled to. */
    skMouldX(P.stone, [[-0.02, wy0 - 0.30], [0.45, wy0 - 0.36], [0.45, wy0 - 0.06],
                       [-0.02, wy0]],
             zf, zd, wx0 - 0.30, wx1 + 0.30, 1.0, upTone(C.white));
    /* the same grille every ground-floor window on this street carries, on
       the z plane -- skGrille() is written for an x-plane face and cannot be
       reused here, so the four lines are repeated rather than mis-axised */
    var gn = clamp(Math.round((wx1 - wx0) / 0.62), 4, 9), gi, gxx;
    var gz = zf + 0.30, gt = mix(C.dark, C.steel, 0.22);
    for (gi = 0; gi <= gn; gi++) {
      gxx = lerp(wx0 + 0.18, wx1 - 0.18, gi / gn);
      tube(P.metal, [gxx, wy0 + 0.10, gz], [gxx, wy1 - 0.10, gz], 0.10, 6, gt, true, false);
    }
    tube(P.metal, [wx0 + 0.12, wy0 + 0.24, gz], [wx1 - 0.12, wy0 + 0.24, gz], 0.09, 6, gt, true, false);
    tube(P.metal, [wx0 + 0.12, wy1 - 0.30, gz], [wx1 - 0.12, wy1 - 0.30, gz], 0.09, 6, gt, true, false);
    STATS.windows = (STATS.windows || 0) + 1;
    STATS.openings = (STATS.openings || 0) + 1;
  }

  /* Plinth, and the cornice band that dies into the corner at x = 548.02.
     Both stop 0.02 SHORT of that corner: a swept prism has an end cap, and a
     cap at exactly 548.02 would be coplanar with run N-W3's own face plane
     and with whatever SECTION 7's corner quoin puts on it. */
  skMouldX(P.stone, [[-0.02, 0], [0.52, 0], [0.52, 5.075 - 0.10], [0.42, 5.075], [-0.02, 5.075]],
           zf, zd, x0, x1 - 0.02, 1.0, groundTone(C.stone, 0, 1.47));
  skMouldX(P.render, [[-0.02, 11.20], [0.55, 11.20], [0.55, 11.78], [0.43, 11.90], [-0.02, 11.90]],
           zf, zd, x0, x1 - 0.02, 1.0, upTone(mix(tone, C.white, 0.35)));
  /* the return's own west end cap, so it does not read as a card floating in
     front of the park */
  skQuadX(P.render, x0, 0, top, 144.70, zf + 0.55, -1, 0.62, mix(tone, C.shade, 0.40));
  /* The splash band along the plinth, the full width of the return rather
     than the old 6.0 u sitting in the middle of a 14 u frontage with clear
     render either side of it.  A band is continuous or it is two blobs. */
  skDecal(P.decal, 'D_GROUND', (x0 + x1 - 0.02) * 0.5, 1.0, zf + 0.60,
          1, 0, 0, 0, 1, 0, (x1 - 0.02 - x0) * 0.99, 1.0,
          mix(tone, C.dark, 0.45));

  /* the street plate on the corner where the west arm meets the apron */
  signCard(P.sign, 'sokak', 545.60, 9.60, zf + 0.10, 1, 0, 0, 0, 1, 0, 0.52, C.white);
  STATS.signs = (STATS.signs || 0) + 1;
  STATS.elevations = (STATS.elevations || 0) + 1;
}

/* The south-facing half of the real corner pharmacy.  N-W3 supplies its
   long 232 Sk elevation; this return wraps the glazing, fascia and entrance
   around the junction so it reads as one occupied ground-floor unit. */
function westMouthReturn() {
  var zf = 144.95, zd = 1;
  var x0 = 468.80, x1 = 484.02, top = 11.90;
  var sy0 = 2.17, sy1 = 7.32, fa0 = 7.35, fa1 = 10.70;
  var tone = C.cream, frame = mix(C.steel, C.white, 0.48);
  var gx0 = x0 + 0.36, gx1 = x1 - 0.34, i, mx;

  /* Opaque interior and the narrow rendered wall above the shopfront. */
  skQuadZ(P.render, zf - 0.30, 0, top, x0, x1, zd, 0.46,
          mix(C.dark, C.shade, 0.30));
  skQuadZ(P.render, zf, fa1, top, x0, x1, zd, 0.92,
          upTone(mix(tone, C.white, 0.18)));

  /* Travertine stallboard, recessed glazing and practical aluminium grid. */
  boxC(P.stone, (x0 + x1) * 0.5, sy0 * 0.5, zf + 0.17,
       (x1 - x0) * 0.5, sy0 * 0.5, 0.19, 0.08, 1,
       groundTone(mix(C.stone, C.dark, 0.22), 0, 1.47));
  skQuadZ(P.glass, zf + 0.07, sy0 + 0.12, sy1 - 0.12, gx0, gx1, zd, 1,
          mix(C.glass, C.dark, 0.23));
  box6(P.joinery, gx0 - 0.16, gx1 + 0.16, sy0 - 0.02, sy0 + 0.22,
       zf + 0.02, zf + 0.22, 1, frame);
  box6(P.joinery, gx0 - 0.16, gx1 + 0.16, sy1 - 0.22, sy1 + 0.02,
       zf + 0.02, zf + 0.22, 1, frame);
  for (i = 0; i <= 4; i++) {
    mx = lerp(gx0, gx1, i / 4);
    box6(P.joinery, mx - 0.11, mx + 0.11, sy0, sy1,
         zf + 0.02, zf + 0.22, 1, frame);
  }
  /* White fascia with red lettering, plus the universally recognisable
     projecting pharmacy cross. */
  boxC(P.render, (x0 + x1) * 0.5, (fa0 + fa1) * 0.5, zf + 0.25,
       (x1 - x0) * 0.5 + 0.12, (fa1 - fa0) * 0.5, 0.27, 0.08, 1,
       mix(C.white, tone, 0.12));
  signCard(P.sign, 'eczane', (x0 + x1) * 0.5, 9.05, zf + 0.56,
           1, 0, 0, 0, 1, 0, 0.78, C.white);
  signCard(P.sign, 'cross', x1 - 1.47, 9.05, zf + 0.58,
           1, 0, 0, 0, 1, 0, 1.72, C.white);

  STATS.windows = (STATS.windows || 0) + 4;
  STATS.openings = (STATS.openings || 0) + 1;
  STATS.signs = (STATS.signs || 0) + 2;
  STATS.elevations = (STATS.elevations || 0) + 1;
}

/* -----------------------------------------------------------------------
   6.9b  B-BLOK'S RESIDENTIAL 233 SK RETURN

   A raised apartment entry and two grilled windows sit on B-BLOK's existing
   solid ground storey.  The uneven openings, stone base and small name board
   continue the photographed residential language around the corner without
   inventing a shop on 232 Sk.
   -------------------------------------------------------------------- */
function residentialCornerReturn() {
  var zf = 207.58, zd = -1, x0 = 581.55, x1 = 617.50;
  var tone = mix(C.rose, C.cream, 0.34), frame = mix(C.white, C.stone, 0.10);
  var door0 = 595.7, door1 = 601.3, win = [[583.7, 592.2], [604.4, 614.4]];
  var i, j;

  skQuadZ(P.render, zf, 0.55, 11.20, x0, x1, zd, 0.92,
          groundTone(tone, 0.55, 1.47));
  boxC(P.stone, (x0 + x1) * 0.5, 2.52, zf - 0.20,
       (x1 - x0) * 0.5, 1.97, 0.28, 0.10, 1,
       groundTone(mix(C.stone, C.dark, 0.18), 0.55, 1.47));

  /* bronze-anodised residential door, raised one shallow step */
  boxC(P.stone, (door0 + door1) * 0.5, 0.77, zf - 0.52,
       (door1 - door0) * 0.5 + 0.72, 0.22, 0.86, 0.10, 1, upTone(C.stone));
  skQuadZ(P.glass, zf - 0.36, 0.98, 9.35, door0, door1, zd, 1,
          mix(C.glass, C.dark, 0.45));
  box6(P.joinery, door0 - 0.28, door0, 0.82, 9.58, zf - 0.52, zf - 0.20, 1, C.timber);
  box6(P.joinery, door1, door1 + 0.28, 0.82, 9.58, zf - 0.52, zf - 0.20, 1, C.timber);
  box6(P.joinery, door0 - 0.28, door1 + 0.28, 9.30, 9.58, zf - 0.52, zf - 0.20, 1, C.timber);
  boxC(P.stone, (door0 + door1) * 0.5, 10.02, zf - 0.72,
       (door1 - door0) * 0.5 + 1.10, 0.20, 1.02, 0.10, 1, upTone(C.stone));

  /* high-sill basement/ground windows with ordinary security grilles */
  for (i = 0; i < win.length; i++) {
    var xa = win[i][0], xb = win[i][1], wy0 = 5.25, wy1 = 9.15;
    skQuadZ(P.glass, zf - 0.28, wy0, wy1, xa, xb, zd, 1,
            mix(C.glass, C.dark, 0.34));
    box6(P.joinery, xa - 0.22, xa, wy0 - 0.22, wy1 + 0.22, zf - 0.42, zf - 0.18, 1, frame);
    box6(P.joinery, xb, xb + 0.22, wy0 - 0.22, wy1 + 0.22, zf - 0.42, zf - 0.18, 1, frame);
    box6(P.joinery, xa - 0.22, xb + 0.22, wy0 - 0.22, wy0, zf - 0.42, zf - 0.18, 1, frame);
    box6(P.joinery, xa - 0.22, xb + 0.22, wy1, wy1 + 0.22, zf - 0.42, zf - 0.18, 1, frame);
    for (j = 1; j <= 4; j++) {
      var gx = lerp(xa, xb, j / 5);
      tube(P.metal, [gx, wy0 - 0.12, zf - 0.55], [gx, wy1 + 0.12, zf - 0.55],
           0.08, 5, mix(C.rail, C.dark, 0.30), false, false);
    }
  }
  signCard(P.sign, 'bblok', (door0 + door1) * 0.5, 12.60, zf - 0.38,
           -1, 0, 0, 0, 1, 0, 0.52, C.white, [0, 0, -1]);
  STATS.signs = (STATS.signs || 0) + 1;
  STATS.elevations = (STATS.elevations || 0) + 1;
}


/* -----------------------------------------------------------------------
   6.10  DRIVER
   -------------------------------------------------------------------- */
// Preserve the live ground-floor portals while replacing the photographed
// residential stories. Clip only geometry emitted by this particular run.
function blenderReplacesUpper(r) {
  return !!(global.NZ_BUILDINGS_ASSET && NZ.streetFacade && NZ.streetFacade.source &&
    /^(N-E1|N-E2|N-W1|N-W2|S-E1)$/.test(r.id));
}
function blenderLowerOnly(build) {
  var starts = {}, key, cut = 3.35 * 3.5;
  for (key in P) if (P[key] && P[key].idx) starts[key] = P[key].idx.length;
  build();
  for (key in starts) {
    var pile = P[key], start = starts[key], added = pile.idx.splice(start);
    function vertex(i) {
      return pile.p.slice(i*3,i*3+3).concat(pile.nm.slice(i*3,i*3+3),
        pile.uv.slice(i*2,i*2+2),pile.tone.slice(i*3,i*3+3));
    }
    for (var t=0;t<added.length;t+=3) {
      var ids=added.slice(t,t+3), ys=ids.map(function(i){return pile.p[i*3+1];});
      if (ys.every(function(y){return y<=cut;})) { pile.idx.push.apply(pile.idx,ids); continue; }
      if (ys.every(function(y){return y>cut;})) continue;
      var input=ids.map(vertex), out=[];
      for (var j=0;j<input.length;j++) {
        var a=input[j],b=input[(j+1)%input.length],ai=a[1]<=cut,bi=b[1]<=cut;
        if (ai) out.push(a);
        if(ai!==bi) { var f=(cut-a[1])/(b[1]-a[1]);out.push(a.map(function(v,k){return v+(b[k]-v)*f;})); }
      }
      var base=pile.n;
      out.forEach(function(v){pile.p.push.apply(pile.p,v.slice(0,3));pile.nm.push.apply(pile.nm,v.slice(3,6));pile.uv.push.apply(pile.uv,v.slice(6,8));pile.tone.push.apply(pile.tone,v.slice(8,11));pile.n++;});
      for(j=1;j<out.length-1;j++)pile.idx.push(base,base+j,base+j+1);
    }
  }
}
function buildRunSkins() {
  buildRunSkins.occN = 0;
  if (typeof RUNS === 'undefined' || !RUNS || !RUNS.length) {
    warn('RUNS table missing: no elevation skins built');
    return;
  }
  var i;
  for (i = 0; i < RUNS.length; i++) {
    if (RUNS[i].disabled) continue;
    try {
      if (blenderReplacesUpper(RUNS[i])) blenderLowerOnly(function () { runSkin(RUNS[i], i); });
      else runSkin(RUNS[i], i);
    } catch (e) {
      warn('skin ' + (RUNS[i] && RUNS[i].id) + ' failed: ' + (e && e.message));
    }
  }
  try {
    westMouthReturn();
  } catch (e2) {
    warn('west mouth return failed: ' + (e2 && e2.message));
  }
  try {
    if (blenderReplacesUpper({id:'S-E1'})) blenderLowerOnly(residentialCornerReturn);
    else residentialCornerReturn();
  } catch (e21) {
    warn('B-BLOK residential return failed: ' + (e21 && e21.message));
  }
  /* The second street plate, at the south-west corner of the apron, 0.10
     proud of S-W1's z = 212.00 return.  That return itself is SECTION 7's;
     only the plate on it is skin. */
  try {
    signCard(P.sign, 'sokak', 546.20, 9.60, 211.90, -1, 0, 0, 0, 1, 0, 0.52, C.white);
    STATS.signs = (STATS.signs || 0) + 1;
  } catch (e3) {
    warn('sw street plate failed: ' + (e3 && e3.message));
  }
}

/* ==== side-3-mass.js ==== */
/* ===========================================================================
   SECTION 7  MASS, ROOFS, RETURNS, CORNERS                            (WI-3)
   ===========================================================================
   The owner's complaint - "get rid of that thin facade kind of thing along one
   of the new streets, make it a full street turnable into from the roundabout"
   - is this section's whole job.  Before this pass every run was a single
   one-sided plane on one constant-x plane: M.render is FrontSide, so from
   behind, a forty-metre elevation vanished and you saw the street through it,
   and at every run boundary the wall was a zero-thickness knife edge.  Nine of
   the thirteen runs also grew a 45.5-unit hip roof over open air.

   What goes in here: the mass volume behind each run, the wall head that caps
   it, the four hip roofs and their fascia/soffit/rafters and roof clutter, the
   party slot between S-E1 and S-E2, the nine end returns and the four corner
   quoins.  No windows, no signs, no shopfronts, no ground, no furniture - the
   skin that hangs on these masses is SECTION 6's.

   THE SITE RULE THAT MAKES THIS SAFE.  Behind these elevations the level
   carves real interiors and no carved ceiling exceeds y = 21.0 (rFlat, rHall,
   rCorr, rShop, rGarage top out at GC 11.2, rBake at 13.0, rUpper, rLoggia and
   rShaft at UC 21.0).  Mass is therefore legal from MASS_Y0 = 21.0 upward
   anywhere behind a run; below it, only inside the one-cell pier and only
   where the grid cell is solid.  Every pier below is grid-verified against
   NUKEM.html's carve()/door() list, not against the site plan alone.
   ======================================================================== */


/* ---------------------------------------------------------------------------
   7.1  LOCAL PRIMITIVES

   This part file declares functions only, so every constant lives inside the
   function that uses it and every helper is prefixed ms* to stay out of the
   other five agents' namespaces.
   ------------------------------------------------------------------------ */

/* THE ONE NUMBER THE WHOLE SECTION TURNS ON.

   The brief says "the mass front face sits 0.34 behind the skin plane so it
   becomes the BACK of every window reveal instead of covering it".  Taken
   literally that is 0.34 behind the FACE, which is 0.76 in FRONT of the
   reveal back at REV 1.10 - it would cover every window on the street.  What
   the sentence means, and what this returns, is 0.34 behind the REVEAL:

     REV 1.10 (314 mm of jamb, section 6's number) + 0.34 = 1.44

   At 1.44 the mass face lands 0.30 behind the window joinery (frames reach
   face-dir*1.14 in windowX) and 0.14 behind the shopfront's own dark interior
   panel at face-dir*1.30, so it is the surface you see through the glass and
   through nothing else.  Every mass rectangle in the site plan quotes the
   GRID column (x 580..584, x 544..548); those are the cell bounds, not the
   face plane, and a mass face on the cell bound at x = 580 would sit inside
   every reveal on the east flank. */
function msSet() { return REV + 0.34; }        /* 1.44 u = 411 mm */

/* how far a mass face is pulled inside a grid-cell boundary so it can never
   land on an engine wall quad.  buildWorld draws its region walls exactly ON
   the cell boundary (x = 584 into KIZILCALAR's rHall, x = 792 into the 230 Sk
   vista), and a face of ours on the same plane z-fights it for the full
   height of the room. */
function msCellSet() { return 0.20; }

/* how far a mass end is pulled back from a run end that carries a return, so
   the return quad and the mass end face are never coplanar */
function msEndSet() { return 0.12; }

/* a box with per-face control.  poly()'s `ref` argument winds every face
   outward from a point inside the solid, so the six calls need no orientation
   bookkeeping.  opt.frontX names which x face looks at the street (0 = the x0
   face, 1 = the x1 face) and gives it its own tone and ao; opt.topTone is the
   up-face, which always wants upTone() or it clips past 245 sRGB. */
function msSolid(pile, x0, x1, y0, y1, z0, z1, ao, tone, opt) {
  var s;
  if (x1 < x0) { s = x0; x0 = x1; x1 = s; }
  if (y1 < y0) { s = y0; y0 = y1; y1 = s; }
  if (z1 < z0) { s = z0; z0 = z1; z1 = s; }
  if (!(x1 - x0 > 1e-4 && y1 - y0 > 1e-4 && z1 - z0 > 1e-4)) return;
  var r = [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5];
  var fx = (opt && opt.frontX !== undefined) ? opt.frontX : -1;
  var fT = (opt && opt.frontTone) ? opt.frontTone : tone;
  var fA = (opt && opt.frontAo !== undefined) ? opt.frontAo : ao;
  var tT = (opt && opt.topTone) ? opt.topTone : tone;
  poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], r, ao, tone);
  poly(pile, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], r, ao, tone);
  poly(pile, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], r,
       fx === 0 ? fA : ao, fx === 0 ? fT : tone);
  poly(pile, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], r,
       fx === 1 ? fA : ao, fx === 1 ? fT : tone);
  poly(pile, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], r, ao, tT);
  poly(pile, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], r, ao, tone);
}

/* a box minus a list of (z, y) rectangles - the pier with its doors and its
   loggia taken out of it.  Same z-partition then y-stack the skin's wallX
   uses, for the same reason: the holes are axis-aligned and never nest, so a
   sweep is exact and costs nothing. */
function msPrism(pile, x0, x1, y0, y1, z0, z1, cuts, ao, tone, opt) {
  var i, j, cs = [], zs = [z0, z1], c;
  cuts = cuts || [];
  for (i = 0; i < cuts.length; i++) {
    c = cuts[i];
    var a0 = Math.max(z0, c.z0), a1 = Math.min(z1, c.z1);
    var b0 = Math.max(y0, c.y0), b1 = Math.min(y1, c.y1);
    if (a1 - a0 < 1e-3 || b1 - b0 < 1e-3) continue;
    cs.push({ z0: a0, z1: a1, y0: b0, y1: b1 });
    zs.push(a0); zs.push(a1);
  }
  zs.sort(function (p, q) { return p - q; });
  var band = [];
  for (i = 0; i < zs.length; i++)
    if (zs[i] > z0 - 1e-3 && zs[i] < z1 + 1e-3 &&
        (band.length === 0 || zs[i] - band[band.length - 1] > 1e-3)) band.push(zs[i]);
  for (i = 0; i + 1 < band.length; i++) {
    var za = band[i], zb = band[i + 1], zm = (za + zb) * 0.5, col = [];
    for (j = 0; j < cs.length; j++)
      if (cs[j].z0 <= zm && cs[j].z1 >= zm) col.push(cs[j]);
    col.sort(function (p, q) { return p.y0 - q.y0; });
    var cy = y0;
    for (j = 0; j < col.length; j++) {
      if (col[j].y0 > cy + 1e-3) msSolid(pile, x0, x1, cy, col[j].y0, za, zb, ao, tone, opt);
      if (col[j].y1 > cy) cy = col[j].y1;
    }
    if (y1 > cy + 1e-3) msSolid(pile, x0, x1, cy, y1, za, zb, ao, tone, opt);
  }
}

/* sweep a closed 2-D section along X on a constant-z plane.  `sec` is
   [[depth, y], ...] measured from the plane in the +zdir direction; the
   section is closed, so there is NO REAR QUAD to sit coplanar with the wall
   it is applied to.  This is the return-face twin of section 6's skMouldZ. */
function msRibX(pile, sec, zface, zdir, x0, x1, ao, tone) {
  var n = sec.length, i, j, cd = 0, cy = 0;
  if (n < 3 || x1 - x0 < 1e-4) return;
  for (i = 0; i < n; i++) { cd += sec[i][0]; cy += sec[i][1]; }
  var ref = [(x0 + x1) * 0.5, cy / n, zface + zdir * (cd / n)];
  var A = [], B = [];
  for (i = 0; i < n; i++) {
    A.push([x0, sec[i][1], zface + zdir * sec[i][0]]);
    B.push([x1, sec[i][1], zface + zdir * sec[i][0]]);
  }
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    poly(pile, [A[i], A[j], B[j], B[i]], ref, ao, tone);
  }
  poly(pile, A, ref, ao, tone);
  poly(pile, B, ref, ao, tone);
}

/* a flat plate of thickness `th` whose four corners are given as [x,y,z], so
   a solar collector can be tilted without a matrix.  The four top corners are
   the given points; the bottom four are th below them. */
function msPlate(pile, q, th, ao, tone) {
  var i, lo = [], hi = [], r = [0, 0, 0];
  for (i = 0; i < 4; i++) {
    hi.push([q[i][0], q[i][1], q[i][2]]);
    lo.push([q[i][0], q[i][1] - th, q[i][2]]);
    r[0] += q[i][0] * 0.25; r[1] += (q[i][1] - th * 0.5) * 0.25; r[2] += q[i][2] * 0.25;
  }
  poly(pile, hi, r, ao, tone);
  poly(pile, lo, r, ao, tone);
  for (i = 0; i < 4; i++) {
    var j = (i + 1) % 4;
    poly(pile, [hi[i], hi[j], lo[j], lo[i]], r, ao, tone);
  }
}

/* scale a linear tone.  The roof fascia is quoted as topTone * 0.74. */
function msScale(t, k) { return [t[0] * k, t[1] * k, t[2] * k]; }

/* the three tones the mass answers to.  All colour is per-vertex; the maps
   are near-white relief and must never be tinted as well. */
function msMassTone(r) { return mix(r.tone, C.dark, 0.16); }
/* a pier face seen from the street THROUGH an opening - the back of a window
   reveal, the cheek of a loggia.  It is in shadow and it is the one surface
   on this street that has never seen sunlight. */
function msPierTone(r) { return mix(r.tone, C.shade, 0.45); }

/* the occluder budget for this section.  nz-street-sky.js:1589 silently drops
   any box over REG_MAX = 26 on any axis and REG_CAP 220 is shared by all five
   street modules; the kit caps the whole module at 45 and section 6 already
   takes fourteen, so this section takes twelve and stops.  Two rules besides:
   a box sits UNDER the thing it belongs to and never around it (hitsBoxT
   exempts only a ray origin STRICTLY inside a box, so a vertex exactly on the
   boundary is fully blocked - that is how nz-street-park's first render came
   back with both shelter roofs as solid black slabs), and no whole-building
   mass is ever registered, because the analytic canyon test already accounts
   for it and replaying it darkens the street twice. */
function msOcc(x0, y0, z0, x1, y1, z1) {
  if (msOcc.n === undefined) msOcc.n = 0;
  if (msOcc.n >= 12) return;
  if (Math.abs(x1 - x0) > 26 || Math.abs(y1 - y0) > 26 || Math.abs(z1 - z0) > 26) {
    warn('mass occluder over 26 u dropped'); return;
  }
  occ(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
      Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
  msOcc.n++;
}


/* ---------------------------------------------------------------------------
   7.2  THE MASS TABLE

   One record per run, or null with a reason.  The site plan's rectangles are
   quoted in grid-cell bounds; every number below is those bounds corrected for
   (a) the reveal set-back msSet(), (b) the cell set-back msCellSet() so no
   face lands on a buildWorld wall quad, (c) the end set-back msEndSet() where
   a return covers the end, and (d) the neighbouring modules' AABBs.
   THE MASS FLOOR IS 21.20, NOT MASS_Y0 = 21.0.  21.0 is the highest carved
   CEILING on the street (rUpper, rLoggia and rShaft all take c = UC = 21.0),
   and buildWorld draws a real ceiling quad on that plane: rUpper covers
   x 584..632, z 60..72 and x 584..636, z 284..296, rShaft x 588..592 at
   z 72..76 and 280..284.  A mass floor ON 21.0 is a down-facing quad sitting
   exactly on a down-facing engine ceiling over forty units of KIZILCALAR's and
   DEGERLI's first-floor flats - visible from inside the flat, which is where
   the player fights.  0.20 of clearance costs nothing and is invisible: the
   void between the two is sealed on every side.
   ------------------------------------------------------------------------ */
function msMassSpec(r) {
  var E = msEndSet();                        /* 0.12 */
  /* the three set-backs, computed rather than written out, so the numbers in
     this table cannot drift away from the constants they were derived from */
  var F = r.x - r.dir * msSet();             /* the mass face plane      */
  var PE = 584.0 - msCellSet();              /* east pier rear, 583.80   */
  var PW = 480.0 + msCellSet();              /* relocated west pier rear */
  switch (r.id) {

    /* ---- NORTH ARM, EAST FLANK ------------------------------------------
       pier = grid column 145 (x 580..584), solid the whole way except the
       street door at cell 145/21 and the loggia at cells 145/16-17.  Verified
       against NUKEM.html: carve(145,16,145,17) is the loggia, door [145,21] is
       the street door, and rows 14..15 and 18..34 of column 145 are untouched.
       block = x 584..625.5, y 21..51.8; 625.44 rather than 625.5 so the hip's
       rear edge at 625.48 (which has NO overhang - the eave is on the street
       side only) is not left with a 0.02 sliver of mass top proud of it. */
    case 'N-E1': return {
      front: F, pierRear: PE, blockRear: 625.44,
      pierY1: 21.20, blockY0: 21.20, blockY1: 51.8,
      z0: 56.0 + E, z1: 96.0
    };
    /* N-E2 stops at z 135.60, NOT 140.  nz-street.js's A-BLOK cikma is a SHELL
       (x 580..756, z 135.80..140.00, y 0..51.8) whose FACE PLANE is z = 140.0
       exactly; any mass face of ours at z = 140 z-fights forty-one metres of
       another module's photographed facade.  The quoin at (580, 140) is what
       closes the arris instead. */
    case 'N-E2': return {
      front: F, pierRear: PE, blockRear: 625.44,
      pierY1: 21.20, blockY0: 21.20, blockY1: 51.8,
      z0: 96.0, z1: 135.60
    };

    /* ---- NORTH ARM, WEST FLANK ------------------------------------------
       pier = grid column 136 (x 544..548), solid over rows 14..25; the only
       hole is the DOYUM EKMEK shop door at cell 136/24.
       block = x 502.5..547.98, corrected to 546.58 at the front. */
    case 'N-W1': return {
      front: F, pierRear: PW, blockRear: 438.50,
      pierY1: 21.20, blockY0: 21.20, blockY1: 51.8,
      z0: 56.0 + E, z1: 88.0
    };
    /* N-W2 stops at z 102.30, not the site plan's 103.5.  nz-street-park's
       northRoof() covers x 488.80..549.20, z 102.50..146.00, y 51.30..56.80,
       and our wall head at 51.8 would poke half a unit through its eave.  The
       1.5 u between 102.30 and park's own masonry box at 103.80 is behind our
       skin and under park's roof, so nothing can see into it. */
    case 'N-W2': return {
      front: F, pierRear: PW, blockRear: 438.50,
      pierY1: 21.20, blockY0: 21.20, blockY1: 51.8,
      z0: 88.0, z1: 102.30
    };
    /* N-W3: NO MASS.  nz-street-park's northApartment(490,548) is a genuine
       masonry box at x 490..548, z 103.80..144.38, y 0.55..51.30 with a stone
       base under it - it IS the mass behind this run, and its east face is at
       x = 548, so a face of ours there would be coplanar with it for the full
       forty units.  We contribute the corner quoin and nothing else. */
    case 'N-W3': return null;

    /* ---- SOUTH ARM, EAST FLANK ------------------------------------------
       S-E1 starts at 208.40: nz-street.js's B-BLOK shell is only 0.34 thick
       (x 580..756, z 208.00..208.34) and its face plane is z = 208.0, so our
       mass has to clear the whole shell, not just the plane.
       S-E1 ends at 255.80 and S-E2 starts at 260.20 - the party slot between
       them (z 256..260) is built as a real party condition in 7.6 and its own
       faces must not sit on the mass's end faces. */
    case 'S-E1': return {
      front: F, pierRear: PE, blockRear: 625.44,
      pierY1: 21.20, blockY0: 21.20, blockY1: 51.8,
      z0: 208.40, z1: 255.80
    };
    case 'S-E2': return {
      front: F, pierRear: PE, blockRear: 625.44,
      pierY1: 21.20, blockY0: 21.20, blockY1: 51.8,
      z0: 260.20, z1: 296.0 - E
    };

    /* ---- SOUTH ARM, WEST FLANK ------------------------------------------
       NO MASS, and the site plan's x 544.00..547.30 slot must NOT be built.
       The plan reads nz-street-park's cornerBlock as a 0.66-u mass box at
       x 547.34..548.00 and concludes that everything west of it is free.  It
       is not: cornerBlock's WEST ELEVATION lives in that slot.  Read off
       nz-street-park.js:4158 (its local frame is worldX = 740 - localZ):
         skin plane                x 547.00
         shopfront glass           x 547.30      frames x 547.28
         stone plinth              x 546.45..547.02, y 0.63..1.25
         stone band                x 546.98,        y 1.25..3.60
         white fascia signboard    x 546.45..547.02, y 11.75..14.20
         fascia sign cards         x 546.42
         three horn loudspeakers   x 545.55..546.38, y 17.5
       A box from x 544.00 to 547.30 buries every one of them and puts its own
       east face exactly on their shopfront glass.  The corner is 1.02 u thick
       and it reads solid the way the plan says it does - because BOTH its
       faces are clad, park's at 547.00 looking west into the park and ours at
       548.02 looking east into 232 Sk - and because park's own hip roof
       (x 544.40..556.20, z 201.80..302.80, y 61.80..68.50) crowns it.  What
       this section adds at that corner is the return face at z = 212 and the
       quoin, which is what actually turns a seam into an arris. */
    case 'S-W1': return null;
    case 'S-W2': return null;

    /* ---- THE 230 Sk STUBS -----------------------------------------------
       No pier: rCrossViewN/S declare openEdges north/south only, so buildWorld
       DOES draw its own concrete on the east and west faces of the vista rows,
       from f = 0 to c = 52.  That engine quad is the mass below 52 and our
       skin stands PROUD 0.02 over it; all we owe is the volume above.  The
       west stub is capped at 52.80 because nz-street.js's A-BLOK roof occupies
       x 577.90..758.10, y 53.06..64.00 over z 94.50..142.10 and B-BLOK's the
       same band over z 205.90..253.50.

       X-W-N ends at 135.60 and X-W-S starts at 208.40 for the same reason
       N-E2 and S-E1 do, and it is easy to miss here: x 728..758.58 is INSIDE
       A-BLOK's and B-BLOK's own footprints (both blocks are x 580..756 and
       13 m deep behind their facade planes), so a mass face of ours at z = 140
       or z = 208 lands on twenty-eight units of nz-street.js's photographed
       north and south elevations.
       X-E-N ends at 151.80 and X-E-S starts at 196.20 because buildWorld draws
       its own wall on the cell boundary there: cells 198..205 rows 37 and 49
       are solid and rows 38 and 48 are the 233 Sk carriageway, so there are
       engine quads on z = 152 and z = 196 running from f = 0 to c = 52. */
    case 'X-W-N': return {
      front: F, pierRear: null, blockRear: 728.0,
      pierY1: 21.20, blockY0: 21.20, blockY1: 52.80,
      z0: 96.0 + E, z1: 135.60
    };
    case 'X-E-N': return {
      front: F, pierRear: null, blockRear: 824.0,
      pierY1: 21.20, blockY0: 21.20, blockY1: 61.95,
      z0: 96.0 + E, z1: 151.80
    };
    case 'X-W-S': return {
      front: F, pierRear: null, blockRear: 728.0,
      pierY1: 21.20, blockY0: 21.20, blockY1: 52.80,
      z0: 208.40, z1: 260.0 - E
    };
    case 'X-E-S': return {
      front: F, pierRear: null, blockRear: 824.0,
      pierY1: 21.20, blockY0: 21.20, blockY1: 61.95,
      z0: 196.20, z1: 260.0 - E
    };
  }
  return null;
}

/* the pier's holes, grown 0.20 on every side.  buildWorld lines a door cell
   with its own wall quads on the cell boundaries and lays a floor at the
   region f and a ceiling at the region c; cutting the pier exactly on those
   planes puts our cut faces coplanar with all four of them.  Growing the cut
   buries our faces behind the engine's, which is the only safe order. */
function msCuts(r) {
  var out = [], i, h, hs = r.holes || [];
  for (i = 0; i < hs.length; i++) {
    h = hs[i];
    out.push({
      z0: h.z0 - 0.20, z1: h.z1 + 0.20,
      /* a ground opening is cut right through to the underside: its y0 is the
         footway floor at 0.5 and there is nothing under a threshold */
      y0: (h.y0 <= 1.0) ? -1.0 : h.y0 - 0.20,
      y1: h.y1 + 0.20
    });
  }
  return out;
}


/* ---------------------------------------------------------------------------
   7.3  THE MASS AND ITS WALL HEAD
   ------------------------------------------------------------------------ */
function runMass(r, ri) {
  var sp = msMassSpec(r);
  if (!sp) return 0;
  var face = r.x, dir = r.dir;
  var tone = msMassTone(r);
  var cuts = msCuts(r);
  var opt = {
    /* which x face looks at the street: for a run facing -x (dir -1) the mass
       lies at larger x, so its street face is x0; for a run facing +x it is x1 */
    frontX: dir < 0 ? 0 : 1,
    frontTone: msPierTone(r),
    frontAo: 0.48,
    topTone: upTone(mix(r.tone, C.white, 0.18))
  };

  /* the pier: one grid cell of real wall, full height, punched for the doors
     and the loggia the level carves through it */
  if (sp.pierRear !== null)
    msPrism(P.render, Math.min(sp.front, sp.pierRear), Math.max(sp.front, sp.pierRear),
            0, sp.pierY1, sp.z0, sp.z1, cuts, 1.0, tone, opt);

  /* the block: everything from 21.20 up, where no carved ceiling reaches.
     Not 21.0 - see the note over msMassSpec: 21.0 is where buildWorld draws
     the ceiling of rUpper, rLoggia and rShaft, and a down-facing mass floor on
     that plane fights it from inside KIZILCALAR's and DEGERLI's first floors. */
  msPrism(P.render, Math.min(sp.front, sp.blockRear), Math.max(sp.front, sp.blockRear),
          sp.blockY0, sp.blockY1, sp.z0, sp.z1, cuts, 1.0, tone, opt);

  /* ---- the wall head -------------------------------------------------
     The 1.44 u between the skin plane and the mass face is a real cavity;
     without a cap you look straight down into it from anything above the
     eaves.  It starts at face - dir*0.10 rather than the usual -0.02 because
     section 6's cornice is a CLOSED section whose rear quad sits at -0.02,
     and two quads on that plane is exactly the coplanar defect this rebuild
     exists to remove.  Its top stops 0.06 under the run top on a roofed run,
     which is what leaves the soffit slab's underside at eave - 0.40 = top a
     clear 0.06 above it; on a roofless run there is no soffit and the cap goes
     right up to the run top under the cornice. */
  var hy1 = r.roof ? r.top - 0.06 : r.top;
  var hx0 = face - dir * 0.10, hx1 = sp.front;
  boxC(P.stone, (hx0 + hx1) * 0.5, (hy1 - 0.62 + hy1) * 0.5, (sp.z0 + sp.z1) * 0.5,
       Math.abs(hx1 - hx0) * 0.5, 0.31, (sp.z1 - sp.z0) * 0.5,
       0.09, 1.0, upTone(mix(r.tone, C.white, 0.42)));

  STATS.masses = (STATS.masses || 0) + 1;
  return 1;
}


/* ---------------------------------------------------------------------------
   7.4  ROOFS

   Only four runs get one.  The other nine are clad over somebody else's block
   - A-BLOK's and B-BLOK's roofs on the east flank, nz-street-park's
   northApartment and cornerBlock roofs on the west - and a second hip on the
   same footprint is two roofs fighting for the same depth buffer along one
   ridge.  Those nine keep the cornice section 6 gives every run.

   TWO CORRECTIONS TO THE SITE PLAN'S RECTANGLES, both measured:

   1. N-E1's hip is quoted z 55.4..96.6.  With dx 47.6 > dz 41.2 the hip
      inset is dz/2 = 20.6, so the north-facing slope reaches y 53.34 at
      z = 94.5 - and z = 94.5 is exactly where nz-street.js's A-BLOK roof
      starts, at y 53.06.  Our tiles would cross theirs over a 47-unit sliver.
      Ending the hip at z = 95.60 puts the whole slope 0.25 below their eave,
      and the 0.4 u of wall left between 95.60 and the run end at 96 is roofed
      by theirs anyway.

   2. N-W1 is quoted z 55.4..88.6 and N-W2 z 87.4..124.6: they overlap each
      other by 1.2 u, and N-W2 runs 22 u into nz-street-park's northRoof
      (x 488.80..549.20, z 102.50..146.00, y 51.30..56.80).  Truncating N-W2 at
      102.30 leaves it a 14.3 u span, and a hip on 14.3 u at rise 11.2 is a
      57 degree pitch - a spire, not a Marseille-tiled apartment roof.  So
      N-W2 keeps its own hip but at rise 4.20 (30.4 degrees, matching the other
      three within 5 degrees), ridge y 56.40, which lands 0.40 below park's own
      ridge at 56.80 and abuts it cleanly at z 102.30/102.50.  The valley where
      it meets N-W1's taller hip at z = 88 is what a stepped terrace does.
   ------------------------------------------------------------------------ */
function roofRect(id) {
  switch (id) {
    /* x1 = face + ROOF_DEEP: the rear edge of a roof on this street has NO
       overhang, the eave is on the street side only, exactly as nz-street.js
       roofs A-BLOK (backEdge = face - m(13.0), streetEdge = face + EAVE_OUT) */
    case 'N-E1': return { x0: 577.88, x1: 625.48, z0: 55.40, z1: 95.60,
                          eave: 52.20, rise: 11.20,
                          wx0: 579.98, wx1: 625.44, wz0: 56.0, wz1: 96.0 };
    case 'N-W1': return { x0: 438.50, x1: 486.12, z0: 55.40, z1: 88.00,
                          eave: 52.20, rise: 11.20,
                          wx0: 438.50, wx1: 484.02, wz0: 56.0, wz1: 88.0 };
    case 'N-W2': return { x0: 438.50, x1: 486.12, z0: 88.00, z1: 102.30,
                          eave: 52.20, rise: 4.20,
                          wx0: 438.50, wx1: 484.02, wz0: 88.0, wz1: 102.30 };
    case 'S-E2': return { x0: 577.88, x1: 625.48, z0: 259.40, z1: 296.60,
                          eave: 52.20, rise: 11.20,
                          wx0: 579.98, wx1: 625.44, wz0: 260.0, wz1: 296.0 };
  }
  return null;
}

/* the height of an equal-pitch hip at (x, z).  The inset is half the SHORTER
   span, and the surface rises linearly off whichever of the four eaves is
   nearest until it reaches the ridge.  Roof clutter has to stand on this and
   not float over it. */
function msRoofY(rc, x, z) {
  var dx = rc.x1 - rc.x0, dz = rc.z1 - rc.z0;
  var ins = Math.min(dx, dz) * 0.5;
  if (!(ins > 1e-4)) return rc.eave;
  var d = Math.min(Math.min(x - rc.x0, rc.x1 - x), Math.min(z - rc.z0, rc.z1 - z));
  return rc.eave + rc.rise * clamp(d / ins, 0, 1);
}

function runRoof(r, ri) {
  if (!r.roof) return 0;
  var rc = roofRect(r.id);
  if (!rc) { warn('run ' + r.id + ' asks for a roof with no rectangle'); return 0; }
  var seed = ri * 311;
  var tile = upTone(mix(C.roof, r.tone, 0.10));

  /* ---- the tile surface.  hipRoof() gives the four planes and nothing else:
     the fascia, the soffit and the rafter ends belong here, because a roof
     that draws its own soffit cannot be given the near-black underside the
     photographs show. */
  hipRoof(P.roof, rc.x0, rc.x1, rc.z0, rc.z1, rc.eave, rc.rise, tile);

  /* ---- fascia, soffit and rafter ends, one side at a time.
     FA_H 0.42 = 120 mm of fascia board; the soffit is 0.16 thick with its
     underside at eave - 0.42 + 0.02, so it laps 0.02 INTO the wall head cap
     instead of sharing a plane with it. */
  var FA_H = 0.42, FA_D = 0.20, SO_T = 0.16;
  var yF0 = rc.eave - FA_H, yS0 = yF0 + 0.02, yS1 = yS0 + SO_T;
  var fasc = msScale(mix(r.tone, C.white, 0.35), 0.74);
  var soff = mix(r.tone, C.dark, 0.72);
  var side, i;
  /* [axis, sign, roofEdge, wallEdge] - axis 0 = an x edge, 1 = a z edge.
     `over` is how far the roof edge passes the wall edge, positive OUTWARD on
     both signs, because on an x0/z0 edge the roof edge is the smaller number. */
  var sides = [
    [0, -1, rc.x0, rc.wx0], [0, 1, rc.x1, rc.wx1],
    [1, -1, rc.z0, rc.wz0], [1, 1, rc.z1, rc.wz1]
  ];
  var over4 = [];
  for (side = 0; side < 4; side++)
    over4.push(sides[side][1] * (sides[side][2] - sides[side][3]));
  /* THE EAVE IS MITRED, and it has to be: an x-side strip that runs the whole
     z length and a z-side strip that runs the whole x length overlap at every
     corner of the roof by 1.90 x 0.40 u of same-facing coplanar soffit.  The
     rule taken here is that the X sides own the corners - they run the full z
     span - and the Z sides stop at the WALL, whose corner square is already
     covered by the X strip. */
  for (side = 0; side < sides.length; side++) {
    var S = sides[side], ax = S[0], sg = S[1], re = S[2], we = S[3];
    var over = over4[side];
    if (!(over > 0.05)) continue;         /* no overhang on this side         */
    var a0, a1;
    if (ax === 0) { a0 = rc.z0; a1 = rc.z1; }
    else {
      a0 = rc.x0 + (over4[0] > 0.05 ? FA_D : 0);
      a1 = rc.x1 - (over4[1] > 0.05 ? FA_D : 0);
    }
    if (ax === 0) {
      /* an x-facing eave: the fascia runs along z */
      var fx0 = sg < 0 ? re : re - FA_D, fx1 = sg < 0 ? re + FA_D : re;
      boxC(P.render, (fx0 + fx1) * 0.5, yF0 + FA_H * 0.5, (a0 + a1) * 0.5,
           FA_D * 0.5, FA_H * 0.5, (a1 - a0) * 0.5, 0.06, 1.0, fasc);
      var sx0 = sg < 0 ? re + FA_D : we, sx1 = sg < 0 ? we : re - FA_D;
      msSolid(P.render, sx0, sx1, yS0, yS1, a0, a1, 0.48, soff);
      /* rafter tails at 2.8 u centres (800 mm), hanging 0.14 below the
         soffit board - the only part of a rafter you see under a boxed eave */
      var nR = Math.max(2, Math.round((a1 - a0) / 2.8));
      for (i = 0; i <= nR; i++) {
        var rz = lerp(a0 + 0.5, a1 - 0.5, i / nR);
        msSolid(P.render, sx0 + 0.10, sx1 - 0.10, yS0 - 0.14, yS0 + 0.02,
                rz - 0.13, rz + 0.13, 0.62, C.timber);
      }
    } else {
      /* a z-facing eave: the fascia runs along x */
      var fz0 = sg < 0 ? re : re - FA_D, fz1 = sg < 0 ? re + FA_D : re;
      boxC(P.render, (a0 + a1) * 0.5, yF0 + FA_H * 0.5, (fz0 + fz1) * 0.5,
           (a1 - a0) * 0.5, FA_H * 0.5, FA_D * 0.5, 0.06, 1.0, fasc);
      var sz0 = sg < 0 ? re + FA_D : we, sz1 = sg < 0 ? we : re - FA_D;
      /* the soffit on a z side stops at the wall, not at the roof edge */
      msSolid(P.render, rc.wx0, rc.wx1, yS0, yS1, sz0, sz1, 0.48, soff);
    }
  }

  msRoofClutter(rc, r, seed);

  /* ---- one occluder per 26-unit slice of the street-side eave.
     It is the OVERHANG volume only: it stops 0.08 short of the skin plane so
     no wall vertex is inside it and none is on its boundary, and its top at
     top - 0.55 clears the rafter tails' lowest vertex (eave - 0.54) by 0.53. */
  var eaveX0, eaveX1, dir = r.dir, face = r.x;
  if (dir < 0) { eaveX0 = rc.x0; eaveX1 = face - 0.08; }
  else { eaveX0 = face + 0.08; eaveX1 = rc.x1; }
  var oy0 = r.top - 2.40, oy1 = r.top - 0.55;
  var nSl = Math.max(1, Math.ceil((rc.z1 - rc.z0) / 25.0));
  for (i = 0; i < nSl; i++)
    msOcc(eaveX0, oy0, lerp(rc.z0, rc.z1, i / nSl),
          eaveX1, oy1, lerp(rc.z0, rc.z1, (i + 1) / nSl));

  STATS.roofs = (STATS.roofs || 0) + 1;
  return 1;
}

/* ---- roof clutter -------------------------------------------------------
   What is actually on these roofs, in this town, on an overcast day: one
   galvanised water tank on a frame, one brick flue with a cast cap, and a pair
   of gunes enerjisi collectors on the street slope.  All three are seeded off
   hash(runIndex * 311), so a render can be measured and the number adjusted;
   nothing here is random per run. */

/* the ridge line of an equal-pitch hip: which axis it runs along, the constant
   coordinate of the other axis, and the segment it occupies.  Everything on a
   roof is placed relative to this, because placing off the roof's CENTRE puts
   a 2.4 m collector two metres past the eave of a short hip - which is exactly
   what the first version of this function did to DOYUM EKMEK. */
function msRidge(rc) {
  var dx = rc.x1 - rc.x0, dz = rc.z1 - rc.z0, ins = Math.min(dx, dz) * 0.5;
  if (dx >= dz)
    return { ax: 0, ins: ins, c: (rc.z0 + rc.z1) * 0.5,
             a0: rc.x0 + ins, a1: rc.x1 - ins, y: rc.eave + rc.rise };
  return { ax: 1, ins: ins, c: (rc.x0 + rc.x1) * 0.5,
           a0: rc.z0 + ins, a1: rc.z1 - ins, y: rc.eave + rc.rise };
}
/* the along-axis extent of the roof at a perpendicular distance `off` from
   the ridge.  On a hip the constant-height contour is the footprint inset by
   d = ins - |off| on ALL FOUR sides, which is why placing anything by the
   ridge segment alone is wrong: KIZILCALAR's ridge is 47.6 - 2 x 20.1 = 7.4 u
   long and a 2.4 m collector will not sit on it, yet the contour half way down
   its slope is 22 u long and takes two of them side by side. */
function msRoofSpan(rc, rg, off) {
  var d = Math.max(0, rg.ins - Math.abs(off));
  return rg.ax === 0 ? [rc.x0 + d, rc.x1 - d] : [rc.z0 + d, rc.z1 - d];
}
/* a plan point from an absolute along-axis coordinate and a signed offset */
function msRoofAt(rg, a, off) {
  return rg.ax === 0 ? [a, rg.c + off] : [rg.c + off, a];
}

/* THE LAYOUT RULE that keeps three objects off each other on a hip without a
   single pairwise test: the chimney sits ON the ridge at one end, the tank on
   ONE side of the ridge at that same end, and both collectors on the OTHER
   side at the far end.  It has to be a rule rather than a test because these
   four roofs range from 47.6 x 14.3 to 47.6 x 40.2 and their insets - which is
   what every placement is measured in - range from 7.15 to 20.10. */
function msRoofClutter(rc, r, seed) {
  var rg = msRidge(rc), i;
  var ax = rg.ax;

  /* ---- the chimney: 3.0 x 3.0 x 8.4 (860 x 860 x 2400 mm) of brick with a
     cast cap, ON the ridge where a flue really comes out, so its base is
     buried in the tiles and can never show a gap at its foot. */
  var rs = msRoofSpan(rc, rg, 0);
  var ca = lerp(rs[0] + 2.2, rs[1] - 2.2, 0.20 + hash(seed + 3) * 0.16);
  var cp = msRoofAt(rg, ca, 0);
  var chx = cp[0], chz = cp[1], chY = msRoofY(rc, chx, chz);
  msSolid(P.brick, chx - 1.5, chx + 1.5, chY - 2.4, chY + 8.4, chz - 1.5, chz + 1.5,
          1.0, mix(C.brick, C.dark, 0.10), { topTone: upTone(C.brick) });
  boxC(P.stone, chx, chY + 8.68, chz, 1.92, 0.28, 1.92, 0.10, 1.0,
       upTone(mix(C.stone, C.white, 0.30)));
  /* the flue liner, so the cap is not a solid lid seen from the street */
  msSolid(P.metal, chx - 0.42, chx + 0.42, chY + 8.4, chY + 9.30, chz - 0.42, chz + 0.42,
          0.62, mix(C.dark, C.steel, 0.20));

  /* ---- the water tank: 4.4 x 3.2 x 4.4 (1.26 x 0.91 x 1.26 m) of galvanised
     steel on a low angle-iron frame.  hpT is its half-depth ACROSS the ridge;
     the offset clears the chimney's 1.5 half-width plus 0.5, and is clamped so
     the whole footprint stays 0.8 inside the eave. */
  var hpT = ax === 0 ? 1.6 : 2.2, haT = ax === 0 ? 2.2 : 1.6;
  var tOff = -clamp(rg.ins * 0.34, 1.5 + hpT + 0.5, Math.max(1.6, rg.ins - hpT - 0.8));
  var ts = msRoofSpan(rc, rg, tOff - hpT);
  var ta = lerp(ts[0] + haT + 0.6, ts[1] - haT - 0.6, 0.22 + hash(seed + 23) * 0.14);
  var tp = msRoofAt(rg, ta, tOff);
  var tx = tp[0], tz = tp[1];
  var fh = 1.65;                                    /* frame, 470 mm          */
  var hxT = ax === 0 ? haT : hpT, hzT = ax === 0 ? hpT : haT;
  var tY = -1e9, legs = [], fx, fz;
  for (i = 0; i < 4; i++) {
    fx = tx + ((i & 1) ? hxT - 0.4 : -(hxT - 0.4));
    fz = tz + ((i & 2) ? hzT - 0.4 : -(hzT - 0.4));
    legs.push([fx, fz]);
    tY = Math.max(tY, msRoofY(rc, fx, fz));
  }
  for (i = 0; i < 4; i++)
    msSolid(P.metal, legs[i][0] - 0.16, legs[i][0] + 0.16,
            msRoofY(rc, legs[i][0], legs[i][1]) - 0.6, tY + fh,
            legs[i][1] - 0.16, legs[i][1] + 0.16, 0.80, mix(C.steel, C.dark, 0.30));
  msSolid(P.metal, tx - hxT, tx + hxT, tY + fh, tY + fh + 4.4, tz - hzT, tz + hzT,
          1.0, mix(C.steel, C.white, 0.16), { topTone: upTone(C.steel) });
  boxC(P.metal, tx, tY + fh + 4.52, tz, hxT + 0.08, 0.14, hzT + 0.08, 0.05, 1.0,
       upTone(C.steel));
  /* the feed pipe dropping back through the tiles */
  var px2 = tx + hxT - 0.2, pz2 = tz + hzT - 0.3;
  tube(P.metal, [px2, tY + fh + 0.4, pz2], [px2, msRoofY(rc, px2, pz2) - 0.4, pz2],
       0.20, 6, mix(C.pipe, C.dark, 0.25), true, false);

  /* ---- gunes enerjisi collectors, nominally 8.4 x 5.6 (2.40 x 1.60 m),
     tilted 20 degrees, side by side on the slope OPPOSITE the tank.  The panel
     shortens across the slope if the hip is too shallow to take a full one -
     DOYUM EKMEK's roof is 14.3 u deep, so its inset is 7.15 and a full 1.60 m
     panel would hang 0.7 u past the eave.
     A collector is a dark glazed absorber in a bright aluminium tray, so it
     goes on P.metal.  NOT on P.glass: that material has depthWrite false and
     the tiles would show straight through the panel. */
  var TILT = 20 * Math.PI / 180, cs = Math.cos(TILT);
  var Lp = Math.min(5.6, (rg.ins - 2.0) / cs);
  if (!(Lp > 2.2)) return;                   /* a hip too shallow to carry one */
  var lift = Math.sin(TILT) * Lp, run = cs * Lp;
  var off = rg.ins * 0.50;                   /* midway between ridge and eave  */
  var ps = msRoofSpan(rc, rg, off - run * 0.5);   /* the contour at the high edge */
  var avail = ps[1] - ps[0] - 2.4;
  if (!(avail > 3.4)) return;
  var W = Math.min(8.4, (avail - 1.5) * 0.5), two = true;
  if (!(W > 3.4)) { W = Math.min(8.4, avail); two = false; }
  var n = two ? 2 : 1, base = ps[0] + 1.2, room = ps[1] - 1.2 - base;
  for (i = 0; i < n; i++) {
    /* pushed to the far end of the roof from the chimney and the tank */
    var aC = base + room - (n - i) * W - (n - 1 - i) * 1.5 + W * 0.5;
    var lo = msRoofAt(rg, aC, off + run * 0.5);     /* eave-side edge  */
    var hi = msRoofAt(rg, aC, off - run * 0.5);     /* ridge-side edge */
    var yLo = msRoofY(rc, lo[0], lo[1]) + 0.55;
    var yHi = Math.min(yLo + lift, rg.y - 0.40);
    if (!(yHi > yLo + 0.20)) continue;
    var ha = ax === 0 ? [W * 0.5, 0] : [0, W * 0.5];
    var q = [
      [lo[0] - ha[0], yLo, lo[1] - ha[1]], [hi[0] - ha[0], yHi, hi[1] - ha[1]],
      [hi[0] + ha[0], yHi, hi[1] + ha[1]], [lo[0] + ha[0], yLo, lo[1] + ha[1]]
    ];
    msPlate(P.metal, q, 0.42, 1.0, mix(C.dark, C.glass, 0.28));
    /* the aluminium tray: 0.22 bigger on all four sides, 0.16 under the glass */
    var e = 0.22, ea = ax === 0 ? [e, 0] : [0, e], eb = ax === 0 ? [0, e] : [e, 0];
    msPlate(P.metal, [
      [q[0][0] - ea[0] + eb[0], yLo - 0.16, q[0][2] - ea[1] + eb[1]],
      [q[1][0] - ea[0] - eb[0], yHi + 0.10, q[1][2] - ea[1] - eb[1]],
      [q[2][0] + ea[0] - eb[0], yHi + 0.10, q[2][2] + ea[1] - eb[1]],
      [q[3][0] + ea[0] + eb[0], yLo - 0.16, q[3][2] + ea[1] + eb[1]]
    ], 0.16, 1.0, upTone(C.steel));
    /* the two rear feet holding the ridge-side edge off the tiles */
    var ff;
    for (ff = 0; ff < 2; ff++) {
      var fpx = hi[0] + (ff ? ha[0] * 0.7 : -ha[0] * 0.7);
      var fpz = hi[1] + (ff ? ha[1] * 0.7 : -ha[1] * 0.7);
      msSolid(P.metal, fpx - 0.18, fpx + 0.18,
              msRoofY(rc, fpx, fpz) - 0.30, yHi, fpz - 0.18, fpz + 0.18,
              0.80, mix(C.steel, C.dark, 0.30));
    }
  }
}


/* ---------------------------------------------------------------------------
   7.5  END RETURNS

   Every exposed run end gets a real return face, full height, with the run's
   plinth, storey bands and cornice turning the corner, so the end reads as the
   same building rather than as a cut.  The mass behind it has already been
   pulled back msEndSet() = 0.12 so the two are never coplanar.

   A return is a list of BANDS, [x0, x1, y0, y1, zOffset], because the mass
   silhouette is not one rectangle: it is one cell deep below MASS_Y0 and the
   full block depth above it, and two of the nine ends have to duck another
   module's AABB.  zOffset is SIGNED in the direction the return faces:
   negative is recessed behind the return plane, positive is proud of it.
   ------------------------------------------------------------------------ */
function msReturnSpec(r, which) {
  var z = which === 'A' ? r.z0 : r.z1;
  var zd = which === 'A' ? -1 : 1;          /* the direction the return faces */
  switch (r.id + which) {

    /* KIZILCALAR's north gable, seen straight down the arm from the barricade.
       Band 1 is the one-cell pier standing 0.06 proud of the mass end; band 2
       is the skirt that closes the underside of the block between the pier and
       the rear wall, where no mass is legal below 21.0.  Cells 146..156 row 14
       are uncarved, so nothing of the level is behind it. */
    case 'N-E1A': return { z: z, zd: zd, bands: [
      [579.98, 584.00, 0, 51.80, 0],
      [584.00, 625.44, 0, 21.00, -0.06]
    ] };
    case 'N-W1A': return { z: z, zd: zd, bands: [
      [480.00, 484.02, 0, 51.80, 0],
      [438.50, 480.00, 0, 21.00, -0.06]
    ] };
    /* DEGERLI's south gable.  The skirt goes 0.40 back rather than 0.06:
       cells 146..158 rows 71..73 are rUpper (x 584..636, z 284..296, floor
       11.2, ceiling 21.0) and buildWorld draws that room's south wall exactly
       on z = 296, so a skirt at 296.06 would z-fight it from inside the flat.
       At 296.40 it is inside the solid police-line row 74 (z 296..300), where
       there is no engine geometry at all. */
    case 'S-E2B': return { z: z, zd: zd, bands: [
      [579.98, 584.00, 0, 51.80, 0],
      [584.00, 625.44, 0, 21.00, 0.40]
    ] };

    /* the south-west corner, the one the roundabout looks straight at.
       1.00 u deep, not the site plan's 3.42: x 547.02 is 0.02 in front of
       nz-street-park's cornerBlock skin plane at 547.00, and everything west
       of that is that module's own elevation (see msMassSpec S-W1).
       noArris, because the quoin at (548.02, 212.00) in 7.7 IS this corner's
       arris and the generic pilaster would share its outer plane at 548.32. */
    case 'S-W1A': return { z: 212.00, zd: -1, noArris: true, bands: [
      [547.02, 548.02, 0, 61.95, 0]
    ] };
    /* S-W2's south end needs no face: nz-street-park's cornerBlock mass runs
       x 547.34..548.00 all the way to z = 300.60, 0.60 PAST our run end, so
       that module already caps the arris and a quad of ours at z = 300 would
       be inside its solid.  What is missing is the vertical arris itself,
       which the corner pilaster in 7.7 supplies. */
    case 'S-W2B': return { z: 300.00, zd: 1, pilasterOnly: true, bands: [] };

    /* the four 230 Sk stub ends, closing the two cross-street vistas.
       X-W-N's upper band is pulled to x 758.15 because A-BLOK's roof AABB is
       x 577.90..758.10, z 94.50..142.10, y 53.06..64.00 and z = 96 is inside
       it - a full-depth return there would be geometry inside another module's
       roof.  X-W-S at z = 260 is clear: B-BLOK's roof stops at z 253.50. */
    case 'X-W-NA': return { z: z, zd: zd, corniceX0: 758.15, bands: [
      [756.02, 760.02, 0, 53.00, 0],
      [758.15, 760.02, 53.00, 61.95, 0]
    ] };
    case 'X-E-NA': return { z: z, zd: zd, bands: [
      [791.98, 795.98, 0, 61.95, 0]
    ] };
    case 'X-W-SB': return { z: z, zd: zd, bands: [
      [756.02, 760.02, 0, 61.95, 0]
    ] };
    case 'X-E-SB': return { z: z, zd: zd, bands: [
      [791.98, 795.98, 0, 61.95, 0]
    ] };
  }
  return null;
}

function endReturn(r, which) {
  var sp = msReturnSpec(r, which);
  if (!sp) return 0;
  var face = r.x, dir = r.dir, top = r.top, tone = r.tone;
  var z = sp.z, zd = sp.zd, i;
  var faceTone = groundTone(tone, 0, 1.47);

  /* THE RETURN PLANE IS 0.05 BEHIND THE RUN'S END PLANE.  Section 6 sweeps
     every moulding on the flank with a CLOSED section, so the plinth, the
     ground band, all four floor bands and the cornice each leave an END CAP
     lying exactly in the z = z0 / z = z1 plane - the cornice's is 0.85 x 0.90.
     A return face on the same plane fights all six of them at the one place on
     the run the eye is drawn to.  0.05 back, and section 6's caps read as the
     mouldings dying correctly PROUD of the return, which is what they do on a
     real corner.  The arris pilaster below covers the joint either way. */
  var zf = z - zd * 0.05;

  /* ---- the opaque face(s) */
  var xLo = face, xHi = face;
  for (i = 0; i < sp.bands.length; i++) {
    var b = sp.bands[i];
    panelZ(P.render, zf + zd * b[4], b[2], b[3], b[0], b[1], zd, 1.0, faceTone);
    if (b[4] === 0) { xLo = Math.min(xLo, b[0]); xHi = Math.max(xHi, b[1]); }
  }
  if (sp.pilasterOnly) {
    msReturnPilaster(r, sp);
    STATS.returns = (STATS.returns || 0) + 1;
    return 1;
  }

  /* ---- the mouldings, turning the corner.  Every profile starts at
     d = -0.02 so its rear face is buried 0.02 in the return face instead of
     sitting on it, and the depths are section 6's, so a moulding does not
     step where it comes round the arris.

     mLo/mHi stop the run 0.03 SHORT of the skin plane.  msRibX closes its
     section with an end cap, and an end cap at x = 548.02 or x = 791.98 is a
     quad lying in the plane of section 6's own wall - a 0.52 x 5.08 patch of
     z-fight at the one place on the run the eye is drawn to.  The 0.03 it
     stops short is buried inside the arris pilaster below. */
  var PL_D = 0.52, PL_TOP = 5.075, GB_D = 0.36, FB_D = 0.18, CO_D = 0.83;
  var mLo = (Math.abs(xLo - face) < 0.005) ? xLo + 0.03 : xLo;
  var mHi = (Math.abs(xHi - face) < 0.005) ? xHi - 0.03 : xHi;
  msRibX(P.stone, [[-0.02, 0], [PL_D, 0], [PL_D, PL_TOP - 0.10],
                   [PL_D - 0.10, PL_TOP], [-0.02, PL_TOP]],
         zf, zd, mLo, mHi, 1.0, groundTone(C.stone, 0, 1.47));
  msRibX(P.render, [[-0.02, 10.80], [GB_D, 10.80], [GB_D, 11.60],
                    [GB_D - 0.10, 11.70], [-0.02, 11.70]],
         zf, zd, mLo, mHi, 1.0, mix(tone, C.white, 0.5));
  for (i = 2; i <= r.storeys; i++)
    msRibX(P.render, [[-0.02, fy(i) - 0.30], [FB_D, fy(i) - 0.30],
                      [FB_D, fy(i) + 0.22], [-0.02, fy(i) + 0.22]],
           zf, zd, mLo, mHi, 1.0, mix(tone, C.white, 0.30));
  /* the cornice is the one moulding that can be above y 53.06, so it is the
     one that has to duck A-BLOK's roof at the 230 Sk west stub - corniceX0
     clips it to the 1.92 u east of their roof's x1 = 758.10. */
  var coX0 = (sp.corniceX0 !== undefined) ? Math.max(sp.corniceX0, mLo) : mLo;
  msRibX(P.render, [[-0.02, top - 0.90], [CO_D - 0.14, top - 0.90],
                    [CO_D, top - 0.62], [CO_D, top - 0.14], [CO_D - 0.14, top],
                    [-0.02, top]],
         zf, zd, coX0, mHi, 1.0, upTone(mix(tone, C.white, 0.35)));

  /* ---- the arris.  A 0.30-proud, 1.40-long corner pilaster where the return
     meets the run's own face plane, chamfered 0.07 (20 mm), so the two
     elevations meet on a stopped edge and not on a knife.  Without it the two
     face planes cross at a mathematically sharp line and read as a seam at
     every distance.  It stops at top - 0.90, the underside of the cornice:
     that is where a pilaster dies on a real elevation, and it also keeps its
     up-facing top out of the plane of the wall head cap and the mass top. */
  var ah = (top - 0.90) * 0.5;          /* half-height: 0 .. top - 0.90 */
  if (!sp.noArris)
    boxC(P.stone, face - dir * 0.16, ah, z - zd * 0.40,
         0.46, ah, 0.70, 0.07, 1.0,
         groundTone(mix(C.stone, tone, 0.30), 0, 1.47));

  /* ---- the cornice occluder for the four returns on 232 Sk itself.
     0.83 proud is enough projection to be worth a contact shadow; the box
     hangs under it, clear of the cornice's own lowest vertex at top - 0.90. */
  if (r.id === 'N-E1' || r.id === 'N-W1' || r.id === 'S-E2' || r.id === 'S-W1') {
    var oz0 = Math.min(z, z + zd * 0.83), oz1 = Math.max(z, z + zd * 0.83);
    var ox0 = Math.max(xLo, xHi - 24.0), ox1 = xHi;
    msOcc(ox0, top - 2.40, oz0 - 0.02, ox1, top - 1.00, oz1 + 0.02);
  }

  STATS.returns = (STATS.returns || 0) + 1;
  return 1;
}

/* S-W2's south end: a corner pilaster instead of a face, because park's
   cornerBlock mass already closes the plane.  x 547.70..548.32 straddles our
   skin at 548.02 - the inner half is buried in park's solid (their east face
   is x 548.00), the outer half stands 0.30 proud in the street - and it wraps
   0.30 past the run end so the arris has a stop. */
function msReturnPilaster(r, sp) {
  var top = r.top, tone = r.tone;
  var qt = groundTone(mix(C.stone, tone, 0.30), 0, 1.47);
  boxC(P.stone, 548.01, (top - 0.90) * 0.5, 299.45, 0.31, (top - 0.90) * 0.5, 0.85,
       0.07, 1.0, qt);
  /* the corbel that takes the cornice round the corner */
  boxC(P.stone, 548.09, top - 0.45, 299.37, 0.45, 0.45, 0.93, 0.09, 1.0,
       upTone(mix(C.stone, C.white, 0.30)));
}


/* ---------------------------------------------------------------------------
   7.6  THE PARTY SLOT between S-E1 and S-E2, z 256..260

   Today it is one flat render box x 579.98..600.98, y 0..41.65 - a lump of
   wall with a shopfront's worth of frontage and no reason to exist.  What is
   really there between two blocks of this kind is a party condition: two
   returns four units apart, a recessed party wall between them, and four units
   of shadow.  Grid cells 145..150 row 64 are uncarved, so it stands on solid
   ground and nothing of the level is behind it.
   ------------------------------------------------------------------------ */
function msPartySlot() {
  /* the faces sit 0.05 INTO the slot from the two runs' end planes, for the
     same reason the end returns do: section 6's closed mouldings each leave an
     end cap lying exactly in z = 256 and z = 260, and the cornice's alone is
     0.85 x 0.90.  0.05 in, and those caps read as the mouldings stopping
     proud of the party face - which is what they do. */
  var zA = 256.05, zB = 259.95, back = 585.0, face = 579.98, top = 51.8;
  var mx0 = 580.01;                         /* clear of the skin plane by 0.03 */
  var tA = C.rose, tB = C.apricot;          /* S-E1's and S-E2's own tones    */
  var i;

  /* the two return faces, each carrying its own run's colour */
  panelZ(P.render, zA, 0, top, face, back,  1, 0.62, groundTone(tA, 0, 1.47));
  panelZ(P.render, zB, 0, top, face, back, -1, 0.62, groundTone(tB, 0, 1.47));
  /* the recessed party wall.  ao 0.62 is the shadow-gap number: a 4 x 5 unit
     slot on an overcast day sees almost no sky. */
  panelX(P.render, back, 0, top, zA, zB, -1, 0.62,
         groundTone(mix(mix(tA, tB, 0.5), C.shade, 0.40), 0, 1.47));
  /* the slot's own floor, so you are not looking through it into nothing.
     Ground surfaces belong to section 8; this is 5 x 4 u of concrete inside a
     building, laid at 0.10 so it cannot touch the road at 0.12 or the footway
     at 0.62. */
  deck(P.render, face, zA, back, zB, 0.10, 0.30, 0.62, mix(C.shade, C.dark, 0.30));

  /* both runs' plinths, bands and cornices turn into the slot */
  var PL_D = 0.52, PL_TOP = 5.075, CO_D = 0.83;
  var sides = [[zA, 1, tA], [zB, -1, tB]];
  for (i = 0; i < sides.length; i++) {
    var z = sides[i][0], zd = sides[i][1], tn = sides[i][2];
    msRibX(P.stone, [[-0.02, 0], [PL_D, 0], [PL_D, PL_TOP - 0.10],
                     [PL_D - 0.10, PL_TOP], [-0.02, PL_TOP]],
           z, zd, mx0, back - 0.60, 0.62, groundTone(C.stone, 0, 1.47));
    msRibX(P.render, [[-0.02, 10.80], [0.36, 10.80], [0.36, 11.60],
                      [0.26, 11.70], [-0.02, 11.70]],
           z, zd, mx0, back - 0.60, 0.62, mix(tn, C.white, 0.5));
    msRibX(P.render, [[-0.02, top - 0.90], [CO_D - 0.14, top - 0.90],
                      [CO_D, top - 0.62], [CO_D, top - 0.14], [CO_D - 0.14, top],
                      [-0.02, top]],
           z, zd, mx0, back - 0.60, 0.62, upTone(mix(tn, C.white, 0.35)));
  }

  /* the party wall's own coping, which is what you see of this slot from the
     roundabout: a 0.80-thick blade rising 0.40 above both cornices */
  boxC(P.stone, back - 0.40, 51.80, (zA + zB) * 0.5, 0.40, 0.40, 2.20, 0.10, 1.0,
       upTone(mix(C.stone, C.white, 0.25)));

  /* the arris pilasters at both mouths of the slot, matching the end returns */
  for (i = 0; i < sides.length; i++)
    boxC(P.stone, face + 0.16, (top - 0.90) * 0.5,
         (i ? 260.0 : 256.0) - sides[i][1] * 0.40,
         0.46, (top - 0.90) * 0.5, 0.70, 0.07, 1.0,
         groundTone(mix(C.stone, sides[i][2], 0.30), 0, 1.47));

  STATS.returns = (STATS.returns || 0) + 2;
}


/* ---------------------------------------------------------------------------
   7.7  QUOINS

   Three corners where two MODULES' skins meet.  Left bare, the two face planes
   cross on a mathematically sharp line with a 0.02 step in it and the eye
   reads a seam, not a corner.  A quoin is 1.40 u (400 mm) of pilaster on each
   face standing 0.30 (86 mm) proud, chamfered 0.07, with a corbel at the head.

   The L is emitted as two boxes and arm B stops INSIDE arm A's body rather
   than on its outer plane - two boxes that end on the same plane give two
   coplanar quads of identical material and tone, which is the defect this
   whole rebuild is about.
   ------------------------------------------------------------------------ */
function quoin(faceX, faceDir, retZ, retDir, y0, y1, tone, armB, armBack) {
  var W = 1.40, PR = 0.30, BK = 0.32, K = 0.07;
  /* how far arm B reaches BEHIND the other module's facade plane.  0.10 is
     enough where that facade has a solid shell to bury the rear face in
     (A-BLOK's cikma is 4.2 deep, B-BLOK's 0.34).  It is not enough at the
     north-west corner: nz-street-park's north facade is at z 144.38 and our
     return plane is 0.57 in front of it at 144.95, so an arm that stops at
     144.85 is a column floating half a metre clear of the wall it belongs
     to.  0.75 puts its rear face inside park's masonry box instead. */
  var back = (armBack === undefined) ? 0.10 : armBack;
  var qt = groundTone(mix(C.stone, tone, 0.28), 0, 1.47);

  /* arm A: on the run's own face plane, running W back along the wall and
     PR past the return plane */
  var ax0 = faceX - faceDir * BK, ax1 = faceX + faceDir * PR;
  var az0 = retZ + retDir * PR, az1 = retZ - retDir * W;
  msQBox(ax0, ax1, y0, y1 - 0.70, az0, az1, K, qt);

  /* arm B: on the other module's facade plane.  It starts 0.08 INSIDE arm A,
     so its end face is buried in arm A's solid, and it stands PR - 0.04 proud
     rather than PR, so its outer plane is not arm A's outer plane.  Two boxes
     that end on the same plane give two coplanar quads of identical material
     and identical tone - which is precisely the defect this rebuild exists to
     remove, and it is worse on a quoin than anywhere else because a quoin is
     the one thing on the street the eye is being asked to read as an edge. */
  if (armB !== false) {
    var bz0 = retZ - retDir * back, bz1 = retZ + retDir * (PR - 0.04);
    var bx0 = faceX - faceDir * 0.08, bx1 = faceX - faceDir * (W + 0.08);
    msQBox(bx0, bx1, y0, y1 - 0.70, bz0, bz1, K, qt);
  }

  /* the corbel: 0.44 proud, the last 0.70 of height, which is where the
     cornice would run round if the other module had one to run.  Its x1 shares
     arm A's outer plane deliberately - they are STACKED, not overlapped, so
     that shared plane is one continuous wall face, not two competing quads. */
  var cx0 = faceX - faceDir * BK, cx1 = faceX + faceDir * 0.44;
  var cz0 = retZ + retDir * 0.44, cz1 = retZ - retDir * (W + 0.14);
  msQBox(cx0, cx1, y1 - 0.70, y1, cz0, cz1, 0.10,
         upTone(mix(C.stone, C.white, 0.28)));
  if (armB !== false)
    msQBox(faceX - faceDir * 0.08, faceX - faceDir * (W + 0.22),
           y1 - 0.70, y1, retZ - retDir * back, retZ + retDir * 0.40, 0.10,
           upTone(mix(C.stone, C.white, 0.28)));

  STATS.quoins = (STATS.quoins || 0) + 1;
}
function msQBox(x0, x1, y0, y1, z0, z1, k, tone) {
  if (x1 < x0) { var s = x0; x0 = x1; x1 = s; }
  if (z1 < z0) { var t = z0; z0 = z1; z1 = t; }
  if (!(x1 - x0 > 1e-3 && y1 - y0 > 1e-3 && z1 - z0 > 1e-3)) return;
  boxC(P.stone, (x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5,
       (x1 - x0) * 0.5, (y1 - y0) * 0.5, (z1 - z0) * 0.5, k, 1.0, tone);
}


/* ---------------------------------------------------------------------------
   7.8  DRIVERS
   ------------------------------------------------------------------------ */
function buildRunMass() {
  msOcc.n = 0;
  if (typeof RUNS === 'undefined' || !RUNS || !RUNS.length) {
    warn('RUNS table missing: no mass built');
    return;
  }
  var i, r;
  for (i = 0; i < RUNS.length; i++) {
    r = RUNS[i];
    if (r.disabled) continue;
    try {
      if (blenderReplacesUpper(r)) blenderLowerOnly(function () { runMass(r, i); });
      else runMass(r, i);
    }
    catch (e) { warn('mass ' + (r && r.id) + ' failed: ' + (e && e.message)); }
    try { if (!blenderReplacesUpper(r)) runRoof(r, i); }
    catch (e2) { warn('roof ' + (r && r.id) + ' failed: ' + (e2 && e2.message)); }
    try {
      var returns = function () { if (r.capA) endReturn(r, 'A'); if (r.capB) endReturn(r, 'B'); };
      if (blenderReplacesUpper(r)) blenderLowerOnly(returns); else returns();
    } catch (e3) { warn('return ' + (r && r.id) + ' failed: ' + (e3 && e3.message)); }
  }
  try { msPartySlot(); }
  catch (e4) { warn('party slot failed: ' + (e4 && e4.message)); }
}

function buildCorners() {
  /* (580.0, 140.0) - our N-E2 meets nz-street.js's A-BLOK north facade, whose
     face plane is z = 140.0 and whose cikma shell runs x 580..756, z
     135.80..140.00.  Arm B lies flat on their facade at x 580.06..581.46, in
     front of it by 0.30, and their own west cheek quad at x = 580 disappears
     behind arm A.  Top 51.80: their roof does not start until y 53.06. */
  try { if (!blenderReplacesUpper({id:'N-E2'})) quoin(579.98, -1, 140.00, 1, 0, 51.80, C.cream, true); }
  catch (e) { warn('quoin NE failed: ' + (e && e.message)); }

  /* (580.0, 208.0) - our S-E1 meets B-BLOK, whose shell is only 0.34 thick
     (z 208.00..208.34) and whose face plane is z = 208.0.  Arm B's 0.30
     projection stands in the walkable B-BLOK forecourt (cells 145..189 rows
     49..51); 0.30 is well inside HUG 0.98, so rule A carries it. */
  try { if (!blenderReplacesUpper({id:'S-E1'})) quoin(579.98, -1, 208.00, -1, 0, 51.80, C.rose, true); }
  catch (e2) { warn('quoin SE failed: ' + (e2 && e2.message)); }

  /* (484.02, 144.95) - relocated pharmacy corner.  The return face stops
     below the cornice and the quoin closes the arris between the long side
     elevation and the park-frontage block. */
  try { quoin(484.02, 1, 144.95, 1, 0, 51.15, C.cream, true, 0.75); }
  catch (e3) { warn('quoin NW failed: ' + (e3 && e3.message)); }

  /* No south-west quoin: the park now meets the south arm as an open,
     landscaped edge.  A full-height corner member here would recreate the
     false facade even after its two runs were disabled. */
}

/* ==== side-4-ground.js ==== */
/* =======================================================================
   SECTION 8   GROUND, FURNITURE, PLANTING

   Everything the player walks on and everything standing on it: both
   carriageways, the roundabout apron and its four kerb radii, kerbs,
   gutters, gullies, markings, patches and weeds; then lamp columns, spun
   concrete poles, overhead catenaries, bins, a builder's skip, a market
   trestle run, a roadworks compound, street plates, house numbers and the
   only trees on the street.

   TWO DEFECTS THIS SECTION EXISTS TO FIX.

   (1) THE KERB TOP WAS COPLANAR WITH THE PAVING.  The old carriageway()
   laid the paver deck from the building line all the way to ROAD0 and then
   stood the kerb block inside that footprint, so two opaque up-facing quads
   shared y 0.56 over a 0.34 x 88 u strip down all four kerbs of both arms.
   Here the paving STOPS at the kerb block (x 548..551 and 577..580, top
   0.62), the kerb block owns x 551..552 and 576..577 and its top is 0.66 -
   0.04 proud, which is what makes the arris read.  Nothing else in the
   module is allowed to sit on 0.12 or on 0.62, and every overlay carries
   its own distinct lift:
       road deck top          0.120
       gully channel block    0.142   (+0.022)
       gutter ribbon          0.150   (+0.030)
       centre-line bars       0.152   (+0.032)
       reinstatement patches  0.155   (+0.035)
       gully grate card       0.165   (+0.045)
       manhole card           0.172   (+0.052)
       ground-grime decals    0.178   (+0.058)
       cement wash            0.182   (+0.062)
       tree-pit soil          0.195   (+0.075)
       footway deck top       0.620
       kerb block top         0.660   (+/- 0.015 of settle)

   (2) EVERY TREE RENDERED ZERO PIXELS.  conifer() used to push its cards
   through the pile's planar world-space UV projector.  World coordinates
   out here are 70..300, the needle atlas is ClampToEdge and its corner
   texel is alpha 0 under alphaTest 0.34, so all eight trees were discarded
   fragment by fragment and nobody noticed.  Every needle card below goes
   through ncard()/ncross(), which write explicit per-vertex UVs from the
   atlas cell rect.  There is no other path into P.needle in this file.

   The playable arm keeps its four municipal obstacle strips because their
   cells are collidable.  Ordinary compact cars appear only in the distant
   continuation, where they provide the dense kerb parking in the references
   without introducing invisible collision into the combat route.

   DIMENSIONS.  1 unit = 0.2857 m, U = 3.5.  Anything with a real-world
   size is written m(metres).  Raw world numbers are site coordinates only.
   ==================================================================== */


/* -----------------------------------------------------------------------
   8.0  LOCAL EMITTERS

   The kit's deck() is a single six-face box: four corner vertices carry
   the whole top face, which is fine for a 3 u step and useless for a 190 u
   carriageway, because NZ.street.bake() samples sky visibility PER VERTEX.
   A road with four vertices has four AO samples over 54 m and comes back
   perfectly flat-lit right up to the kerb.  grField() subdivides the top
   face on a grid whose column boundaries are placed where the gradient
   actually is - the two kerb lines, the two gutter edges and the crown -
   and keeps the four cheeks so the slab still reads as a slab end-on.
   -------------------------------------------------------------------- */

/* one up-facing quad, no thickness.  Every thin overlay on the road is one
   of these: a box would put its underside back on the road plane, which is
   the coplanar bug this section is here to avoid. */
function grFlat(pile, x0, z0, x1, z1, y, ao, tone) {
  poly(pile, [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]],
       [(x0 + x1) * 0.5, y - 1.0, (z0 + z1) * 0.5], ao, tone);
}

/* a subdivided slab.  cols is the array of x boundaries, first = x0 and
   last = x1; dz is the nominal row depth (the real one is rounded so the
   rows divide the span exactly).  th > 0 adds the four cheeks. */
function grField(pile, cols, z0, z1, y, th, dz, ao, tone) {
  var n = cols.length, i, j;
  if (n < 2 || !(z1 > z0)) return;
  var rows = Math.max(1, Math.round((z1 - z0) / (dz || 7.0)));
  for (j = 0; j < rows; j++) {
    var a = z0 + (z1 - z0) * (j / rows), b = z0 + (z1 - z0) * ((j + 1) / rows);
    for (i = 0; i < n - 1; i++) {
      poly(pile, [[cols[i], y, a], [cols[i + 1], y, a],
                  [cols[i + 1], y, b], [cols[i], y, b]],
           [(cols[i] + cols[i + 1]) * 0.5, y - 1.0, (a + b) * 0.5], ao, tone);
    }
  }
  if (th > 0) {
    panelX(pile, cols[0], y - th, y, z0, z1, -1, ao, tone);
    panelX(pile, cols[n - 1], y - th, y, z0, z1, 1, ao, tone);
    panelZ(pile, z0, y - th, y, cols[0], cols[n - 1], -1, ao, tone);
    panelZ(pile, z1, y - th, y, cols[0], cols[n - 1], 1, ao, tone);
  }
}

/* an up-facing disc: tree-pit soil, a pole footing, the top of a spoil
   heap.  seg points, one poly, ref parked below so it winds up. */
function grDisc(pile, cx, cz, y, r, seg, ao, tone) {
  var i, pts = [], TAU = Math.PI * 2;
  seg = seg || 10;
  for (i = 0; i < seg; i++) {
    var q = i / seg * TAU;
    pts.push([cx + Math.cos(q) * r, y, cz + Math.sin(q) * r]);
  }
  poly(pile, pts, [cx, y - 1.0, cz], ao, tone);
}

/* A TAPERED TUBE.  tube() carries one radius end to end, and a lamp column
   that does not taper is a scaffold pole: the real 9 m column is 238 mm at
   the collar and 152 mm under the arm.  Same emitter does the lantern
   (230 -> 330 mm), the spun-concrete pole and the mixer drum.  seg quads
   per ring pair, smooth radial normals, explicit cylindrical uv so the
   grain runs UP the member instead of switching projection axis every
   45 degrees the way the planar projector does. */
function grFrustum(pile, ax, ay, az, bx, by, bz, r0, r1, seg, ao, tone, cap0, cap1) {
  seg = seg || 8;
  var dx = bx - ax, dy = by - ay, dz = bz - az;
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-4)) return;
  dx /= len; dy /= len; dz /= len;
  var hx = Math.abs(dy) > 0.92 ? 1 : 0, hy = Math.abs(dy) > 0.92 ? 0 : 1;
  var ux = dy * 0 - dz * hy, uy = dz * hx - dx * 0, uz = dx * hy - dy * hx;
  var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  var vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  var TAU = Math.PI * 2, i, base = pile.n;
  var circ = TAU * (r0 + r1) * 0.5 * pile.inv, vlen = len * pile.inv;
  /* the side wall's normal tilts by the cone half-angle, or a 9 m column
     lights as a cylinder and the taper is invisible */
  var slope = (r0 - r1) / len;
  for (i = 0; i <= seg; i++) {
    var q = i / seg * TAU, cq = Math.cos(q), sq = Math.sin(q);
    var nx = ux * cq + vx * sq, ny = uy * cq + vy * sq, nz = uz * cq + vz * sq;
    var mx = nx + dx * slope, my = ny + dy * slope, mz = nz + dz * slope;
    var ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    mx /= ml; my /= ml; mz /= ml;
    pile.vert(ax + nx * r0, ay + ny * r0, az + nz * r0, mx, my, mz, i / seg * circ, 0, ao, tone);
    pile.vert(bx + nx * r1, by + ny * r1, bz + nz * r1, mx, my, mz, i / seg * circ, vlen, ao, tone);
  }
  for (i = 0; i < seg; i++) {
    var o = base + i * 2;
    pile.tri(o, o + 2, o + 3); pile.tri(o, o + 3, o + 1);
  }
  var j, ring;
  if (cap0 && r0 > 1e-4) {
    ring = [];
    for (j = 0; j < seg; j++) {
      var q0 = j / seg * TAU;
      ring.push([ax + (ux * Math.cos(q0) + vx * Math.sin(q0)) * r0,
                 ay + (uy * Math.cos(q0) + vy * Math.sin(q0)) * r0,
                 az + (uz * Math.cos(q0) + vz * Math.sin(q0)) * r0]);
    }
    poly(pile, ring, [ax + dx, ay + dy, az + dz], (ao || 1) * 0.84, tone);
  }
  if (cap1 && r1 > 1e-4) {
    ring = [];
    for (j = 0; j < seg; j++) {
      var q1 = j / seg * TAU;
      ring.push([bx + (ux * Math.cos(q1) + vx * Math.sin(q1)) * r1,
                 by + (uy * Math.cos(q1) + vy * Math.sin(q1)) * r1,
                 bz + (uz * Math.cos(q1) + vz * Math.sin(q1)) * r1]);
    }
    poly(pile, ring, [bx - dx, by - dy, bz - dz], (ao || 1) * 0.84, tone);
  }
}

/* the module's occluder budget.  OCC_CAP is 45 for the whole file and
   SECTION 6 already takes fourteen, so the ground and its furniture take a
   hard twelve: four luminaires, four blocked-strip groups, two tree crowns
   and two pole cabinets.  A box registered AROUND its object bakes that
   object black (hitsBoxT exempts only a ray origin STRICTLY inside), so
   every one of these is inset from its object's own vertices and its top
   is dropped clear of them. */
function grOcc(x0, y0, z0, x1, y1, z1) {
  if (buildFurniture.occN === undefined) buildFurniture.occN = 0;
  if (buildFurniture.occN >= 10) return;
  if (Math.abs(x1 - x0) > 26 || Math.abs(y1 - y0) > 26 || Math.abs(z1 - z0) > 26) {
    warn('ground occluder over 26 u dropped'); return;
  }
  occ(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
      Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
  buildFurniture.occN++;
}

/* the road's own tones, all derived as ratios against C.asphalt rather
   than picked.  The gutter is 0.70x the road - that ratio is what makes a
   kerb read as a kerb and not as a paving edge - and mixing C.asphalt to
   C.dark at 0.42 lands exactly there in linear Y. */
function grGutterTone() { return mix(C.asphalt, C.dark, 0.42); }
function grPatchDark() { return mix(C.asphalt, C.dark, 0.30); }
function grPatchPale() { return mix(C.asphalt, C.white, 0.15); }


/* -----------------------------------------------------------------------
   8.1  CARRIAGEWAY

   x 551.00..577.00, top y 0.12, 0.30 thick.  The brief's carriageway is
   552..576 with the kerb blocks outside it; the deck is laid the full
   551..577 so both kerb blocks STAND on asphalt instead of on nothing -
   their bases are at y 0.02, ten centimetres under the road top, so not
   one square unit of the extra width is ever visible and no kerb can be
   undercut from a low camera.

   Six columns, boundaries at the two kerb lines, the two gutter edges and
   the crown, so the bake has a vertex exactly where its gradient is.
   -------------------------------------------------------------------- */
function carriageway(x0, x1, z0, z1, gutters, seed) {
  if (!(z1 > z0)) return;
  var g0 = x0 + 1.00, g1 = x1 - 1.00;            /* the kerb faces */
  var cols = [x0, g0 + 1.20, lerp(g0, g1, 0.25), (g0 + g1) * 0.5,
              lerp(g0, g1, 0.75), g1 - 1.20, x1];
  grField(P.asphalt, cols, z0, z1, ROAD_TOP, 0.30, 7.0, 1, C.asphalt);
  STATS.roadPatches++;

  /* THE GUTTER CHANNEL, 1.20 u = 343 mm of darker asphalt against each
     kerb face, PROUD at +0.030 and never sunk: sunk means coplanar with
     the carriageway and the whole ribbon z-fights.  Subdivided on the same
     7 u row pitch so the ribbon carries its own AO gradient. */
  if (gutters) {
    var gt = grGutterTone(), rows = Math.max(1, Math.round((z1 - z0) / 7.0)), j;
    for (j = 0; j < rows; j++) {
      var a = z0 + (z1 - z0) * (j / rows), b = z0 + (z1 - z0) * ((j + 1) / rows);
      grFlat(P.asphalt, g0, a, g0 + 1.20, b, ROAD_TOP + 0.030, 1, gt);
      grFlat(P.asphalt, g1 - 1.20, a, g1, b, ROAD_TOP + 0.030, 1, gt);
    }
  }

  /* MUNICIPAL HISTORY: utility reinstatements at +0.035.  Four-vertex
     patches with each corner offset independently, because a rectangle
     reads as a decal and a trench reads as a trench.  Every fourth one is
     pale (a fresh planing), the rest are dark (a hot-lay). */
  var span = z1 - z0, n = Math.max(2, Math.round(span / 26.0)), i;
  for (i = 0; i < n; i++) {
    var s = seed + i * 13;
    var pw = rr(s, 3, 4.0, 9.5), pl = rr(s, 5, 7.0, 19.0);
    var pcx = lerp(g0 + 2.6, g1 - 2.6, rr(s, 7, 0.08, 0.92));
    var pcz = z0 + span * ((i + rr(s, 9, 0.15, 0.85)) / n);
    if (pcz + pl * 0.5 > z1 - 1.0 || pcz - pl * 0.5 < z0 + 1.0) continue;
    var tp = (i % 4 === 3) ? grPatchPale() : grPatchDark();
    poly(P.asphalt, [
      [pcx - pw * rr(s, 11, 0.42, 0.55), ROAD_TOP + 0.035, pcz - pl * rr(s, 13, 0.42, 0.55)],
      [pcx + pw * rr(s, 15, 0.42, 0.55), ROAD_TOP + 0.035, pcz - pl * rr(s, 17, 0.42, 0.55)],
      [pcx + pw * rr(s, 19, 0.42, 0.55), ROAD_TOP + 0.035, pcz + pl * rr(s, 21, 0.42, 0.55)],
      [pcx - pw * rr(s, 23, 0.42, 0.55), ROAD_TOP + 0.035, pcz + pl * rr(s, 25, 0.42, 0.55)]
    ], [pcx, ROAD_TOP - 1.0, pcz], 1, tp);
    STATS.roadPatches++;
  }
  /* two long trench reinstatements, 1.9-2.3 u (0.54-0.66 m) wide, the
     water main and the gas main, running with the street */
  for (i = 0; i < 2; i++) {
    var tw = rr(seed + 91, i, 1.9, 2.3);
    var tx = lerp(g0 + 3.0, g1 - 3.0, i ? 0.72 : 0.31);
    var ta = z0 + span * rr(seed + 93, i, 0.05, 0.22);
    var tb = Math.min(z1 - 2.0, ta + span * rr(seed + 95, i, 0.42, 0.74));
    if (tb - ta < 8) continue;
    grFlat(P.asphalt, tx - tw * 0.5, ta, tx + tw * 0.5, tb, ROAD_TOP + 0.035, 1,
           i ? grPatchPale() : grPatchDark());
    STATS.roadPatches++;
  }
}


/* -----------------------------------------------------------------------
   8.2  FOOTWAY

   3.0 u = 857 mm of kilit tasi paving, top y 0.62, 0.34 thick.  IT STOPS
   AT THE KERB BLOCK.  upTone() on the paving as well as on the kerb: both
   are horizontal precast and both clip past 245 sRGB the moment the bake
   hands an up-facing surface its 2.00 from the dome.
   -------------------------------------------------------------------- */
function footway(x0, x1, z0, z1) {
  if (!(z1 > z0) || !(x1 > x0)) return;
  var cols = [x0, (x0 + x1) * 0.5, x1];
  grField(P.paver, cols, z0, z1, PAVE_TOP, 0.34, 6.0, 1, upTone(C.paver));
}


/* -----------------------------------------------------------------------
   8.3  KERBS

   A real precast kerb is a 1 m unit.  These are stepped every 3.5 u with a
   0.07 u trim at each end - the trim IS the visible joint, which is how
   nz-street-park lays its own and why its kerb line reads as laid rather
   than extruded.  Each unit is a chamfered box: a pure 90-degree arris on
   a kerb is the loudest prototype tell on the whole street.  Every unit
   takes +/-0.015 u of settle so the run is not dead level; 0.645..0.675
   still clears the paving at 0.62 by four times the settle.
   -------------------------------------------------------------------- */
function kerbRun(xRoad, side, z0, z1, seed) {
  if (!(z1 > z0)) return;
  var bx0 = side < 0 ? xRoad - KERB_W : xRoad;
  var bx1 = side < 0 ? xRoad : xRoad + KERB_W;
  var cx = (bx0 + bx1) * 0.5, hx = (bx1 - bx0) * 0.5;
  var unit = m(1.0), n = Math.max(1, Math.round((z1 - z0) / unit)), i;
  var tone = upTone(C.kerb);
  for (i = 0; i < n; i++) {
    var a = z0 + (z1 - z0) * (i / n) + 0.07;
    var b = z0 + (z1 - z0) * ((i + 1) / n) - 0.07;
    if (!(b > a)) continue;
    var top = KERB_TOP + rr(seed + i, 3, -0.015, 0.015);
    boxC(P.stone, cx, (0.02 + top) * 0.5, (a + b) * 0.5,
         hx, (top - 0.02) * 0.5, (b - a) * 0.5, 0.055, 1, tone);
    STATS.kerbs++;
  }
}

/* THE FOUR KERB RADII, r = 7.0 u (2.0 m), eight segments each.  This is
   what turns the apron from a painted rectangle into a junction: a corner
   with a 2 m radius reads as a road, a square corner reads as a car park.
   Only the kerb block itself is emitted on the arc.  The paving inside the
   corner is ALREADY THERE - nz-street-ground.js lays its 233 Sk pavement
   decks at y 0.56 over x 549..580, z 152..159 and z 189..196, which is
   exactly the ground each arc encloses, and re-paving it would put two
   opaque up-facing quads 0.06 apart over a 7 x 30 u rectangle.  Likewise
   no gutter on the arc: the whole arc is inside that pavement rectangle,
   so a gutter ribbon there would be buried under 0.41 u of someone else's
   concrete.
   Radii 7.00 -> 8.00 with a 0.06 chamfer on the inner top arris. */
function kerbRadius(cx, cz, a0, a1, seed) {
  var seg = 8, i, TAU = Math.PI / 180;
  var r0 = 7.0, r1 = 8.0, tone = upTone(C.kerb);
  for (i = 0; i < seg; i++) {
    var qa = (a0 + (a1 - a0) * (i / seg)) * TAU;
    var qb = (a0 + (a1 - a0) * ((i + 1) / seg)) * TAU;
    var ca = Math.cos(qa), sa = Math.sin(qa), cb = Math.cos(qb), sb = Math.sin(qb);
    var top = KERB_TOP + rr(seed + i, 5, -0.012, 0.012);
    var ch = 0.06;                              /* the arris chamfer, 17 mm */
    var iA = [cx + ca * r0, cz + sa * r0], iB = [cx + cb * r0, cz + sb * r0];
    var cA = [cx + ca * (r0 + ch), cz + sa * (r0 + ch)];
    var cB = [cx + cb * (r0 + ch), cz + sb * (r0 + ch)];
    var oA = [cx + ca * r1, cz + sa * r1], oB = [cx + cb * r1, cz + sb * r1];
    var ref = [cx + (ca + cb) * 0.5 * (r0 + r1) * 0.5, 0.30,
               cz + (sa + sb) * 0.5 * (r0 + r1) * 0.5];
    /* inner face, the one the traffic sees */
    poly(P.stone, [[iA[0], 0.02, iA[1]], [iB[0], 0.02, iB[1]],
                   [iB[0], top - ch, iB[1]], [iA[0], top - ch, iA[1]]], ref, 1, tone);
    /* the chamfer facet */
    poly(P.stone, [[iA[0], top - ch, iA[1]], [iB[0], top - ch, iB[1]],
                   [cB[0], top, cB[1]], [cA[0], top, cA[1]]], ref, 1, tone);
    /* the top */
    poly(P.stone, [[cA[0], top, cA[1]], [cB[0], top, cB[1]],
                   [oB[0], top, oB[1]], [oA[0], top, oA[1]]], ref, 1, tone);
    /* the back, 0.04 of which shows above the paving */
    poly(P.stone, [[oA[0], 0.02, oA[1]], [oB[0], 0.02, oB[1]],
                   [oB[0], top, oB[1]], [oA[0], top, oA[1]]], ref, 1, tone);
    STATS.kerbs++;
  }
}


/* -----------------------------------------------------------------------
   8.4  DRAINAGE AND MARKINGS
   -------------------------------------------------------------------- */

/* A road gully: a 1.0 m precast channel block set 0.022 proud against the
   kerb face, and a 400 x 260 mm cast grating on top of it.  The grating is
   a D_GRATE decal card rather than seven modelled bars - at 0.4 m across
   the bars are two pixels wide at any range the player sees them from, and
   the atlas cell carries them with a highlight under each slot, which is
   the read.  side = -1 for the west kerb (road to the +x of it). */
function gully(xRoad, side, z) {
  var into = side < 0 ? 1 : -1;                  /* which way the road is */
  var bx0 = side < 0 ? xRoad : xRoad - m(0.174);
  var bx1 = side < 0 ? xRoad + m(0.174) : xRoad;
  grFlat(P.stone, bx0, z - m(0.5), bx1, z + m(0.5), ROAD_TOP + 0.022, 1,
         mix(C.stone, C.dark, 0.52));
  var gcx = xRoad + into * 1.05;
  decalCard(P.decal, D_GRATE, gcx, ROAD_TOP + 0.045, z,
            1, 0, 0, 0, 0, 1, 1.4, 0.9, mix(C.dark, C.steel, 0.22), [0, 1, 0]);
  /* the weep down the kerb face under it: a gully that has taken thirty
     years of road water leaves a stain and nothing else does */
  decalCard(P.decal, D_RUST, xRoad + into * 0.012, 0.40, z,
            0, 0, 1, 0, 1, 0, 2.6, 0.50, mix(C.kerb, C.dark, 0.45), [into, 0, 0]);
  STATS.gullies++;
}

/* the dashed centre line, worn.  The photographed road uses a narrow faded
   140 mm stripe, not the oversized 600 mm game marking this replaces.
   These are flat single quads on P.mark at +0.030 - not boxes, because a
   box puts its underside straight back on the road plane. */
function roadMarks(z0, z1, cx, seed) {
  var pitch = m(8.6), barL = m(3.1), barW = m(0.14);
  var z = z0 + pitch * 0.5, i = 0;
  while (z + barL < z1) {
    var wear = rr(seed + i, 7, 0.10, 0.34);
    grFlat(P.mark, cx - barW * 0.5, z, cx + barW * 0.5, z + barL,
           ROAD_TOP + 0.032, 1, mix(C.line, C.asphalt, wear));
    STATS.marks++;
    z += pitch; i++;
  }
}

/* three manhole covers per arm, on the crown where they really sit */
function grManholes(z0, z1, cx, seed) {
  var i;
  for (i = 0; i < 3; i++) {
    var mz = lerp(z0 + 12, z1 - 12, (i + 0.5) / 3) + rr(seed, i, -6, 6);
    var mx = cx + rr(seed + 5, i, -3.2, 3.2);
    decalCard(P.decal, D_MANHOLE, mx, ROAD_TOP + 0.052, mz,
              1, 0, 0, 0, 0, 1, 2.1, 2.1, mix(C.dark, C.steel, 0.30), [0, 1, 0]);
  }
}

/* twelve weed tufts per arm, standing in the joint between the kerb face
   and the channel.  Vertical alpha cards need the gain or they read as a
   dark rim: an up-facing surface takes 2.00 off the overcast dome, a
   vertical one about 1.30. */
function grKerbWeeds(z0, z1, seed, road0, road1) {
  road0 = road0 === undefined ? ROAD0 : road0;
  road1 = road1 === undefined ? ROAD1 : road1;
  var i, gain = CARD_GAIN;
  for (i = 0; i < 12; i++) {
    var side = (i % 2) ? 1 : -1;
    var wx = side < 0 ? road0 + 0.10 : road1 - 0.10;
    var wz = lerp(z0 + 4, z1 - 4, (i + rr(seed, i, 0.1, 0.9)) / 12);
    var wh = rr(seed + 3, i, 0.9, 1.8), ww = rr(seed + 5, i, 0.8, 1.5);
    var t = mix(C.needle, C.needleD, rr(seed + 7, i, 0.1, 0.7));
    decalCard(P.decal, D_WEED, wx, ROAD_TOP + wh * 0.42, wz,
              0, 0, 1, 0, 1, 0, ww, wh,
              [t[0] * gain, t[1] * gain, t[2] * gain * 0.97], [-side, 0, 0]);
  }
}

/* -----------------------------------------------------------------------
   8.4b  THE REFUGE BY THE PHARMACY, AND ITS SPRUCE

   The owner's April 2026 frame of this corner, and the August 2015 one of
   the same spot, are both of ONE thing: the little triangular refuge in
   front of GUVEN ECZANESI and the spruce that stands in it -- a sapling in
   a kerbed lawn in 2015, a thirteen-metre tree in a bed of dry earth now,
   with a blue ahead-or-left disc and an island-head chevron board on a post
   at its nose and the back of a give-way triangle beside it.

   What was here was a kerbed triangle laid at y 0..0.76 and a 4.3 m black
   pine.  The triangle was never visible: this ground is nz-street-park's
   north footway, which climbs west at seven per cent and stands 2.5 units
   above the arm at this x, so the whole island was buried under somebody
   else's paving and only the top of the pine came through it.

   So the refuge is built ON the footway it actually stands on: every height
   below is taken from the park's own grade, the bed covers the three cells
   NUKEM.html blocks for it (128/36, 129/36, 130/37), and both posts and the
   stem stand inside those cells -- rule C, as before.
   -------------------------------------------------------------------- */

/* the park footway's surface under a point: its grade plus the paving deck */
function refugePave(x, z) {
  var PK = NZ.streetPark, gy = NaN;
  try { if (PK && typeof PK.gradeAt === 'function') gy = PK.gradeAt(x, z); } catch (e) { gy = NaN; }
  if (!isFinite(gy)) gy = clamp((552 - x) * 0.07, 0, 20.16);
  return gy + 0.55;
}

/* A Picea under cloud: the boughs, the hanging sprays and the interior.
   Calibrated in our own frame against the refuge tree of the two April 2026
   photographs -- the numbers are in the note at the call.  SPRUCE_NY is how
   far a bough's stored normal leans up off the horizontal; see ncardN(). */
var SPRUCE_T = [1.03, 0.59, 0.79];
var SPRUCE_H = [1.55, 0.89, 1.18];
var SPRUCE_MASS = [0.45, 0.375, 0.48];
var SPRUCE_NY = 0.35;

/* spruce(x, z, y, h, r, cb, seed, yMin)
   The FORM comes from nz-street-props (NZ.streetFlora.spruce), so this tree
   and the row along A-BLOK are one species; this module supplies the stem,
   the atlas and the tone.  yMin is the pruning line: no card hangs below it.
   Returns false, having built nothing, if the form is not there to call. */
function spruce(x, z, y, h, r, cb, seed, yMin) {
  var F = NZ.streetFlora && NZ.streetFlora.spruce;
  if (typeof F !== 'function' || !NR_BOUGH || !NR_HANG) return false;
  var i, TAU = Math.PI * 2;
  var leanX = rr(seed, 1, -0.55, 0.55), leanZ = rr(seed, 2, -0.45, 0.45);
  function stemAt(yy) {
    var q = clamp((yy - y) / h, 0, 1);
    return [x + leanX * q * q, yy, z + leanZ * q * q];
  }
  /* 380 mm through at the foot, which is what the photograph's stem is
     against the 76 mm sign post beside it */
  var trunkR = m(0.19), bark = mix(C.trunk, C.dark, 0.26), n = 7;
  for (i = 0; i < n; i++) {
    var q0 = i / n, q1 = (i + 1) / n;
    var a = stemAt(y + h * 0.96 * q0), b = stemAt(y + h * 0.96 * q1);
    grFrustum(P.render, a[0], a[1], a[2], b[0], b[1], b[2],
              trunkR * (1 - 0.90 * Math.pow(q0, 1.15)) + 0.03,
              trunkR * (1 - 0.90 * Math.pow(q1, 1.15)) + 0.03, 8, 1, bark, false, false);
  }
  for (i = 0; i < 5; i++) {                        /* the root flare */
    var fa = i / 5 * TAU + rr(seed, 8 + i, -0.4, 0.4), fl = rr(seed, 14 + i, 0.9, 1.5);
    grFrustum(P.render, x, y + fl * 1.3, z, x + Math.cos(fa) * fl, y - 0.08, z + Math.sin(fa) * fl,
              trunkR * 0.34, trunkR * 0.56, 5, 1, mix(bark, C.dark, 0.30), false, false);
  }
  for (i = 0; i < 9; i++) {                        /* the spurs of lost branches */
    var sy = y + lerp(h * 0.07, cb - 0.5, i / 8) + rr(seed, 20 + i, -0.3, 0.3);
    var sa = rr(seed, 30 + i, 0, TAU), sl = rr(seed, 40 + i, 0.5, 1.2), sp = stemAt(sy);
    grFrustum(P.render, sp[0], sy, sp[2], sp[0] + Math.cos(sa) * sl, sy - 0.18, sp[2] + Math.sin(sa) * sl,
              0.075, 0.035, 4, 1, mix(bark, C.dark, 0.34), false, true);
  }

  var cards = F({ x: x, y: y, z: z, h: h, cb: cb, r: r, seed: seed, dens: 1, axis: stemAt });
  for (i = 0; i < cards.length; i++) {
    var c = cards[i], k = c[10], cy = c[2];
    var low = cy - Math.abs(c[5]) - Math.abs(c[8]);
    if (yMin !== undefined && low < yMin) cy += yMin - low;
    if (c[0] === 0) {
      /* a bough: its normal leans out of the crown, away from the stem at
         its own height.  Every other one is laid mirrored, so two neighbours
         never show the same side shoots in the same order. */
      var sc = stemAt(cy), ox = c[1] - sc[0], oz = c[3] - sc[2];
      var ol = Math.sqrt(ox * ox + oz * oz);
      if (ol < 0.05) { ox = c[4]; oz = c[6]; ol = Math.sqrt(ox * ox + oz * oz) || 1; }
      ncardN(P.needle, NR_BOUGH, c[1], cy, c[3], c[4], c[5], c[6], c[7], c[8], c[9],
             ox / ol, SPRUCE_NY, oz / ol,
             [SPRUCE_T[0] * k, SPRUCE_T[1] * k, SPRUCE_T[2] * k], (i & 2) !== 0);
      continue;
    }
    var rect = c[0] === 2 ? NRECT[N_MASS] : (c[0] === 1 ? NR_HANG : NR_BOUGH);
    var tn = c[0] === 2 ? SPRUCE_MASS : SPRUCE_H;
    ncard(P.needle, rect, c[1], cy, c[3], c[4], c[5], c[6],
          c[7], c[8], c[9], [tn[0] * k, tn[1] * k, tn[2] * k]);
  }
  /* ONE occluder, inset well inside the skirt: the crown is 24 units of
     shade over a footway and a road, and without it they bake as if the
     tree were not there.  Inset, because a box that touches a card's own
     vertices bakes the card black. */
  grOcc(x - r * 0.46, y + cb + 1.6, z - r * 0.46, x + r * 0.46, y + cb + 1.6 + 23.0, z + r * 0.46);
  STATS.trees++;
  return true;
}

/* one sign on a post: the face, and the grey back of its plate, which is the
   side half of all road signs are seen from.  f is the direction it faces. */
function refugeSign(slot, px, py, pz, fx, fz, size, shape) {
  var fl = Math.sqrt(fx * fx + fz * fz) || 1; fx /= fl; fz /= fl;
  var ux = fz, uz = -fx;                            /* the plate's own width axis */
  var sz2 = signCard(P.sign, slot, px + fx * 0.14, py, pz + fz * 0.14,
                     ux, 0, uz, 0, 1, 0, size, C.white, [fx, 0, fz]);
  if (!sz2) return;
  var hw = sz2.w * 0.5, hh = sz2.h * 0.5, pts = [], i;
  var bx = px + fx * 0.11, bz = pz + fz * 0.11;
  if (shape === 'disc') {
    for (i = 0; i < 14; i++) {
      var q = i / 14 * Math.PI * 2;
      pts.push([bx + ux * Math.cos(q) * hw, py + Math.sin(q) * hh, bz + uz * Math.cos(q) * hw]);
    }
  } else if (shape === 'tri') {
    pts = [[bx - ux * hw, py + hh, bz - uz * hw], [bx + ux * hw, py + hh, bz + uz * hw], [bx, py - hh, bz]];
  } else {
    pts = [[bx - ux * hw, py - hh, bz - uz * hw], [bx + ux * hw, py - hh, bz + uz * hw],
           [bx + ux * hw, py + hh, bz + uz * hw], [bx - ux * hw, py + hh, bz - uz * hw]];
  }
  /* ref on the FACE side, so the plate's normal points out of its back */
  poly(P.metal, pts, [bx + fx, py, bz + fz], 1, mix(C.steel, C.dark, 0.16));
}

function buildNorthSplitterIsland() {
  var Q = [[512.6, 144.5], [520.8, 144.5], [523.7, 151.7], [515.4, 148.6]];
  var n = Q.length, i, cx = 0, cz = 0;
  for (i = 0; i < n; i++) { cx += Q[i][0] / n; cz += Q[i][1] / n; }
  var S = NZ.street && NZ.street.SKY, cloud = !!(S && S.overcast);
  var KH = 0.34, KW = 0.52;
  var inner = [];
  for (i = 0; i < n; i++) {
    var dx = cx - Q[i][0], dz = cz - Q[i][1], dl = Math.sqrt(dx * dx + dz * dz) || 1;
    inner.push([Q[i][0] + dx / dl * KW * 1.5, Q[i][1] + dz / dl * KW * 1.5]);
  }
  /* the kerb: an outer face, a top and an inner face per side, each on the
     footway's own grade so the ring follows the hill instead of cutting it */
  var kerbTop = upTone(mix(C.kerb, C.stone, 0.20));
  for (i = 0; i < n; i++) {
    var a = Q[i], b = Q[(i + 1) % n], ia = inner[i], ib = inner[(i + 1) % n];
    var ya = refugePave(a[0], a[1]), yb = refugePave(b[0], b[1]);
    var yia = refugePave(ia[0], ia[1]), yib = refugePave(ib[0], ib[1]);
    var ref = [(a[0] + b[0] + ia[0] + ib[0]) * 0.25, (ya + yb) * 0.5 + KH * 0.4,
               (a[1] + b[1] + ia[1] + ib[1]) * 0.25];
    poly(P.stone, [[a[0], ya - 0.05, a[1]], [b[0], yb - 0.05, b[1]],
                   [b[0], yb + KH, b[1]], [a[0], ya + KH, a[1]]],
         ref, 0.86, mix(C.kerb, C.dark, 0.18));
    poly(P.stone, [[a[0], ya + KH, a[1]], [b[0], yb + KH, b[1]],
                   [ib[0], yib + KH, ib[1]], [ia[0], yia + KH, ia[1]]],
         [ref[0], ref[1] - 2, ref[2]], 1, kerbTop);
    poly(P.stone, [[ia[0], yia + 0.10, ia[1]], [ib[0], yib + 0.10, ib[1]],
                   [ib[0], yib + KH, ib[1]], [ia[0], yia + KH, ia[1]]],
         ref, 0.78, mix(C.kerb, C.dark, 0.30));
    STATS.kerbs++;
  }
  /* the bed: dry earth, not lawn -- that is the 2026 frame, and it is also
     what is under any street spruce that has shed for ten years */
  var soil = cloud ? [0.360, 0.290, 0.185] : mix(C.soil, C.green, 0.13);
  var bed = [];
  for (i = 0; i < n; i++)
    bed.push([inner[i][0], refugePave(inner[i][0], inner[i][1]) + 0.17, inner[i][1]]);
  poly(P.render, bed, [cx, refugePave(cx, cz) - 1, cz], 0.90, soil);
  /* straw and a little green, thickest along the kerb where the water sits */
  var straw = cloud ? [0.56, 0.48, 0.30] : mix(C.gold, C.white, 0.45);
  for (i = 0; i < 16; i++) {
    var e = i % n, f = rr(771 + i, 3, 0.08, 0.92), g = rr(771 + i, 5, 0.10, 0.62);
    var ex = lerp(inner[e][0], inner[(e + 1) % n][0], f), ez = lerp(inner[e][1], inner[(e + 1) % n][1], f);
    var wx = lerp(ex, cx, g), wz = lerp(ez, cz, g);
    var wh = rr(771 + i, 7, 0.55, 1.25), green = rr(771 + i, 9, 0, 1) < 0.30;
    var t = green ? mix(C.needle, C.needleD, rr(771 + i, 11, 0.2, 0.8)) : straw;
    var gk = (green ? CARD_GAIN : DRY_CARD) * rr(771 + i, 13, 0.82, 1.12);
    ncross(P.needle, green ? N_GRASS : N_DRY, wx, refugePave(wx, wz) + 0.17, wz,
           wh * 1.5, wh, rr(771 + i, 15, 0, Math.PI), [t[0] * gk, t[1] * gk, t[2] * gk * 0.97]);
  }

  /* THE SPRUCE.  13.7 m with 2.8 m of clear stem and a 3.5 m skirt: off the
     two April 2026 frames, where its head stands level with the pharmacy
     block's eaves, its lowest boughs just clear the top of the sign post and
     its skirt is as wide as two parked cars are long.
     The pruning line is the footway's own jumpTop -- rule B.
     TONE, measured over the crown from the photographs' own standpoint
     (552, 6, 176), luminance percentiles 5/10/25/50/75 and the colour at
     the median:
         photographs   11-15 / 16-19 / 24-27 / 36-40 / 54-60    34-38, 38-43, 29-35
         this build       23 /    25 /    29 /    36 /    46    33, 39, 29
     The median and the hue are on; the range is still narrower than a real
     crown's, which has holes through to the sky that these cards do not. */
  var tx = 520.45, tz = 148.90, ty = refugePave(tx, tz) + 0.15;
  var built = spruce(tx, tz, ty, 48.0, 12.4, 9.8, 5213, ty + 8.75);
  if (!built) {
    /* nz-street-props did not load: the old pine, on the right ground */
    conifer(tx, tz, ty, 15.2, 3.15);
    grOcc(tx - 0.55, ty, tz - 0.55, tx + 0.55, ty + 5.9, tz + 0.55);
  }

  /* THE POST AT THE NOSE: blue ahead-or-left over the island-head chevrons,
     facing the roundabout the way the frame shows them facing its camera.
     x 522.9 / z 150.7 is inside cell 130/37. */
  var steel = mix(C.steel, C.dark, 0.20);
  var sx = 522.9, sz = 150.7, sy = refugePave(sx, sz) + 0.17;
  grFrustum(P.metal, sx, sy, sz, sx, sy + 9.9, sz, 0.108, 0.108, 7, 1, steel, false, true);
  refugeSign('aheadleft', sx, sy + 8.55, sz, 0.90, 0.44, 2.12, 'disc');
  refugeSign('refuge', sx, sy + 5.75, sz, 0.90, 0.44, 2.86, 'rect');
  /* ...and the give-way that faces the traffic coming down the arm, which
     is why the frame only ever shows its back.  Cell 128/36. */
  var gx = 513.7, gz = 145.4, gy = refugePave(gx, gz) + 0.17;
  grFrustum(P.metal, gx, gy, gz, gx, gy + 9.2, gz, 0.108, 0.108, 7, 1, steel, false, true);
  refugeSign('giveway', gx, gy + 8.0, gz, -0.26, -0.97, 2.36, 'tri');
  STATS.signs += 3;
  STATS.pits = (STATS.pits || 0) + 1;
}


/* the solid white edge line the April 2026 frame shows down both kerbs of
   the freshly surfaced arm.  120 mm wide, 0.55 m off the kerb face, laid in
   14 u lengths so each can carry its own wear and the line is not one
   perfect ribbon; flat single quads on P.mark at +0.033, like roadMarks(). */
function edgeLines(xL, xR, z0, z1, seed) {
  var w = m(0.12), off = m(0.55), step = 14.0, z, i = 0;
  for (z = z0; z < z1 - 0.5; z += step, i++) {
    var ze = Math.min(z + step - 0.10, z1), k;
    for (k = 0; k < 2; k++) {
      var x = k ? xR - off : xL + off;
      var wear = rr(seed + i, 3 + k, 0.06, 0.30);
      if (rr(seed + i, 9 + k, 0, 1) < 0.07) continue;       /* a length worn right out */
      grFlat(P.mark, x - w * 0.5, z, x + w * 0.5, ze, ROAD_TOP + 0.033, 1,
             mix(C.line, C.asphalt, wear));
      STATS.marks++;
    }
  }
}


/* -----------------------------------------------------------------------
   8.5  buildGround()

   Runs first in buildAll(): everything else in the module stands on what
   this lays.

   WHAT WE DO NOT LAY, AND WHY.  nz-street-ground.js owns 233 Sk from
   x = 548 eastward and its road (x 548..836, z 160..188) is CAMBERED -
   roadY(z) = 0.07 + 0.28*(1 - t^2), so it is 0.07 at each kerb face and
   0.35 on the crown.  The site plan asks for two asphalt slivers at
   x 548..552 and 577..580 over that same z 160..188; a flat slab at our
   0.12 laid there would stand 0.05 proud at the kerb line and be buried
   0.23 deep at the crown, over ground that is already surfaced.  So the
   apron stops at z = 160 and resumes at z = 188 and the slivers are left
   to the module that already cambers them.  Nothing is missing: measured
   against nz-street-ground's own RX0 = 548, its road covers x 548..580
   across that whole band.
   -------------------------------------------------------------------- */
function buildGround() {

  /* ---- 232 Sk, north arm.  The reference is a broad two-lane residential
     street: 63 u / 18.0 m between kerb faces after the requested 25% trim.
     Both verges absorb the change while the surveyed storefront frontages
     stay in place. */
  carriageway(NORTH_ROAD0 - 1, NORTH_ROAD1 + 1, -150.0, 160.0, true, 101);
  footway(NORTH_XW, NORTH_ROAD0 - 1, -150.0, 152.0);
  footway(NORTH_ROAD1 + 1, 580.0, -150.0, 152.0);
  kerbRun(NORTH_ROAD0, -1, -150.0, 152.0, 311);
  kerbRun(NORTH_ROAD1, 1, -150.0, 152.0, 337);
  roadMarks(-144.0, 144.0, (NORTH_ROAD0 + NORTH_ROAD1) * 0.5, 41);
  edgeLines(NORTH_ROAD0, NORTH_ROAD1, -144.0, 142.5, 149);
  grManholes(-130.0, 142.0, (NORTH_ROAD0 + NORTH_ROAD1) * 0.5, 53);
  grKerbWeeds(-142.0, 150.0, 67, NORTH_ROAD0, NORTH_ROAD1);

  /* ---- 232 Sk, south arm.  Same 18 m carriageway and envelope as the north
     arm, carried far enough south to place Adil Camii on its west side. */
  carriageway(ROAD0 - 1, ROAD1 + 1, 188.0, 512.0, true, 137);
  carriageway(ROAD0 - 1, ROAD1 + 1, 512.0, 600.0, false, 139);
  footway(XW, ROAD0 - 1, 196.0, 512.0);
  footway(ROAD1 + 1, XE, 196.0, 512.0);
  kerbRun(ROAD0, -1, 196.0, 512.0, 419);
  kerbRun(ROAD1, 1, 196.0, 512.0, 431);
  roadMarks(214.0, 594.0, (ROAD0 + ROAD1) * 0.5, 71);
  grManholes(216.0, 500.0, (ROAD0 + ROAD1) * 0.5, 83);
  grKerbWeeds(212.0, 502.0, 97, ROAD0, ROAD1);

  /* ---- gullies, every m(12) = 42 u down both kerbs, the two runs offset
     21 u so they interleave rather than face each other across the road */
  var z;
  for (z = -140.0; z < 152.0; z += m(12)) gully(NORTH_ROAD0, -1, z);
  for (z = -119.0; z < 152.0; z += m(12)) gully(NORTH_ROAD1, 1, z);
  for (z = 204.0; z < 512.0; z += m(12)) gully(ROAD0, -1, z);
  for (z = 225.0; z < 512.0; z += m(12)) gully(ROAD1, 1, z);

  /* ---- THE ROUNDABOUT APRON.  Grid cells 137..144 x 36..52 are painted
     rResRoad at f = 0 with no pavement anywhere in them, so the junction
     the owner wants to read as four full streets currently has no kerb of
     its own on the 232 side at all.  The carriageway above already covers
     z 144..160 and 188..212; the footway quadrants and the four radii are
     what make it a junction.  NOTHING goes inside x 550..570, z 164..184 -
     that is nz-street-ground's kerbed island and its soil. */
  kerbRadius(507.5, 152.0, 180, 90, 601);        /* NW: (500.5,152) -> (507.5,159) */
  kerbRadius(556.5, 152.0, 0, 90, 607);          /* NE: (563.5,152) -> (556.5,159) */
  kerbRadius(507.5, 196.0, 180, 270, 613);       /* SW: park edge -> west kerb */
  kerbRadius(556.5, 196.0, 0, -90, 619);         /* SE: east corner -> kerb   */

  buildNorthSplitterIsland();

  /* The two photographed east-corner forecourts are paved pedestrian/parking
     aprons, not lawn.  The world regions below them use a placeholder floor
     texture for collision, so cap that floor with the same kilit tasi used on
     the arm footways.  These are horizontal surfaces over existing solid
     blocks; they are not facade cards. */
  footway(580.0, 648.0, 140.0, 152.0);           /* A-BLOK north corner      */
  footway(580.0, 648.0, 196.0, 208.0);           /* residential B-BLOK corner */

  /* END CAPS on nz-street-ground's two pavement decks.  Those decks run
     x 549..580 at y 0.56 and simply stop in mid-air at their west end,
     which is the first thing the player sees walking in from the park.  A
     1 u end kerb, top 0.60, closes them and reads as the return the real
     thing would have.  0.60 is 0.04 proud of their paving and 0.06 under
     ours, so it is coplanar with neither. */
  var capTone = upTone(C.kerb);
  boxC(P.stone, 548.50, 0.35, 155.50, 0.50, 0.25, 3.50, 0.055, 1, capTone);
  boxC(P.stone, 548.50, 0.35, 192.50, 0.50, 0.25, 3.50, 0.055, 1, capTone);

  /* ---- 230 Sk stubs.  Thirty-two units kerb line to kerb line with no
     footway in the grid: these are vista corridors behind the cordon, seen
     end-on from the junction and from the checkpoint, never walked. */
  carriageway(760, 792, 96.0, 152.0, false, 151);
  roadMarks(98.0, 150.0, 776.0, 163);
  /* the SOUTH stub gets no carriageway and no lane marks.  It is not a
     street: SECTION 9.6 walls and plants it. */
}


/* -----------------------------------------------------------------------
   8.6  TREES

   Built to nz-street-park.js's recipe, not an approximation of it: a
   leaning four-segment tube stem with a root flare, a CLEAR STEM to 42% of
   the height, and everything above that as alpha cards at real 3-D
   positions - never on rings, because a ring reads as a cone from every
   angle at once.  Each clump is four cards: a crossed N_PINE pair at
   r x 0.86r, a rotated N_SPRAY at 0.86/0.70 and an N_MASS opaque core at
   0.62/0.56 toned x 0.56, which is what stops you seeing sky through the
   middle of the crown.  Per-clump tone jitter 0.72..1.34 with blue trimmed
   x 0.97, over a crown gradient of 0.79 at the crown base to 1.32 at the
   sunward head: a crown built from one colour is a silhouette, not a tree.

   EVERY CARD GOES THROUGH ncard().  That is the bug fix - see the section
   banner.  The stem is the only part on a non-atlas pile.

   AND THE TONE HANDED TO A CARD IS A MULTIPLIER, NOT AN ALBEDO.  That is the
   second bug in this section and it is the one that made every pine on the
   street a black cut-out beside nz-street-park's cedar in the same frame.
   Atlas cells 0-3 are drawn SATURATED - N_PINE is an rgb(96,124,74) body
   under strokes at 140,172,106 - so THE CELL ALREADY CARRIES THE FOLIAGE
   COLOUR and the vertex tone is only allowed to trim it.  The build this
   replaces handed each card mix(C.needle, C.needleD), a linear albedo of
   about [0.059, 0.114, 0.054], and multiplied that INTO the cell: the
   product landed at roughly [0.015, 0.047, 0.008] against the park's
   [1.18, 0.81, 1.46] x its own cell - fourteen times dark in red, five in
   green, nineteen in blue.  A crown at that tone has no internal range left
   to read as depth, so it renders as one flat silhouette whatever the bake
   does with it.
   CARD_GAIN IS NOT WANTED HERE AND DROPPING IT IS NOT A REGRESSION.  1.40 is
   the vertical-orientation compensation the PALE cells 4-7 need, where the
   vertex tone IS the albedo (grKerbWeeds, treePit and grPlanter still take
   it, correctly).  Cells 0-3 were solved by nz-street-park WITH the 0.76
   orientation discount already inside the measurement, against the same
   P.needle bake this module uses - rays 3, floor 0.56, scale 0.97, byte for
   byte the same settings - so NEEDLE_T transfers as it stands and a further
   1.40 on top of it would put our pines 40 per cent over the park's.
   -------------------------------------------------------------------- */

/* nz-street-park's last calibration step, and it is a RED one: with the
   atlas landing the crown at the photographs' luminance 58 the render still
   read g/r 1.36 against their 1.12, and a Konya black pine under cloud is a
   dull olive - which is red, not less green.  Copied whole because the cell
   art and the bake settings it was solved against are both identical here. */
var NEEDLE_T = [1.05, 0.72, 1.34];

/* one foliage clump: four cards, eight triangles, explicit UVs.  lift is
   the crown's own top-to-bottom gradient - see conifer(); 1.0 if omitted. */
function grClump(cx, cy, cz, rad, base, seed, lift) {
  var jt = rr(seed, 3, 0.72, 1.34) * (lift > 0 ? lift : 1);
  var t = [base[0] * jt, base[1] * jt, base[2] * jt * 0.97];
  var tm = [t[0] * 0.56, t[1] * 0.56, t[2] * 0.56];
  var a1 = rr(seed, 5, 0, Math.PI), a2 = a1 + Math.PI * 0.5;
  var a3 = rr(seed, 7, 0, Math.PI), a4 = rr(seed, 11, 0, Math.PI);
  ncard(P.needle, N_PINE, cx, cy, cz,
        Math.cos(a1) * rad, 0, Math.sin(a1) * rad, 0, rad * 0.86, 0, t);
  ncard(P.needle, N_PINE, cx, cy, cz,
        Math.cos(a2) * rad, 0, Math.sin(a2) * rad, 0, rad * 0.86, 0, t);
  ncard(P.needle, N_SPRAY, cx, cy + rad * 0.10, cz,
        Math.cos(a3) * rad * 0.86, 0, Math.sin(a3) * rad * 0.86, 0, rad * 0.70, 0, t);
  ncard(P.needle, N_MASS, cx, cy - rad * 0.06, cz,
        Math.cos(a4) * rad * 0.62, 0, Math.sin(a4) * rad * 0.62, 0, rad * 0.56, 0, tm);
}

function conifer(x, z, y, h, r, cbf) {
  var i, j;
  var seed = Math.round(x * 3 + z * 7);
  var top = y + h;
  /* THE CLEAR STEM, 42 per cent of the height by default -- a black pine on
     a street verge.  A garden cypress is not that tree: it carries foliage
     from a fifth of its height, and SECTION 9.6 passes cbf for it. */
  var cb = y + h * (cbf > 0 ? cbf : 0.42);
  var crownH = top - cb;
  var trunkR = r * 0.125;
  var leanX = rr(seed, 1, -0.30, 0.30), leanZ = rr(seed, 2, -0.26, 0.26);
  var bark = mix(C.trunk, C.dark, rr(seed, 4, 0.05, 0.52));
  /* per-TREE variation is +-7 per cent on the multiplier, not a slide down a
     dark-green ramp: two pines in one row differ in vigour, not in species. */
  var tk = rr(seed, 6, 0.93, 1.07);
  var base = [NEEDLE_T[0] * tk, NEEDLE_T[1] * tk, NEEDLE_T[2] * tk];

  /* THE CROWN GRADIENT.  A bake at this scale cannot supply it: the sky
     sample at the foot of a 24 u crown and the one at its head differ by far
     less than the eye expects, because the crown occludes itself and the
     P.needle floor of 0.56 holds the underside up.  nz-street-park supplies
     it by hand at every scale it builds foliage at - the hedge crown row is
     toned x1.18 against a skirt at x0.66, the shrub dome runs 0.70 -> 1.26
     bottom to top - and evergreen() carries a y term of its own.  Here: 0.84
     at the crown base to 1.20 at the head, times 1.10 on the outer bunches
     that stand in open sky and 0.94 on the two inner ones that sit inside the
     crown's own shadow.  Range 0.79 to 1.32, mean about 1.12 over the clump
     population, which is where the park's jt x yj mean lands. */
  function crownLift(cy, outer) {
    var q = clamp((cy - cb) / (crownH > 0.01 ? crownH : 1), 0, 1);
    return (0.84 + 0.36 * q) * (outer ? 1.10 : 0.94);
  }

  /* THE STEM.  No bark map is wired to any pile in this module - barkTex()
     exists in SECTION 3 but no material carries it - so the stem rides
     P.render, whose salt-and-pepper relief at tile 9 is the closest thing
     available, with cyl:true so the grain runs UP the tube instead of
     switching projection axis four times around it. */
  function stemAt(q) {
    return [x + leanX * r * q * q, y + h * 0.94 * q, z + leanZ * r * q * q];
  }
  for (i = 0; i < 4; i++) {
    var q0 = i / 4, q1 = (i + 1) / 4;
    var rA = trunkR * (1 - 0.80 * Math.pow(q0, 1.5)) + trunkR * 0.06;
    var rB = trunkR * (1 - 0.80 * Math.pow(q1, 1.5)) + trunkR * 0.06;
    var a = stemAt(q0), b = stemAt(q1);
    grFrustum(P.render, a[0], a[1], a[2], b[0], b[1], b[2], rA, rB, 7, 1, bark, false, false);
  }
  /* the root flare: four short buttresses.  A stem that meets the ground
     as a clean cylinder is a broom handle. */
  for (i = 0; i < 4; i++) {
    var fa = i / 4 * Math.PI * 2 + rr(seed, 8 + i, -0.4, 0.4);
    var fl = r * rr(seed, 12 + i, 0.10, 0.19);
    grFrustum(P.render, x, y + fl * 1.5, z,
              x + Math.cos(fa) * fl, y - 0.10, z + Math.sin(fa) * fl,
              trunkR * 0.30, trunkR * 0.52, 5, 1, mix(bark, C.dark, 0.30), false, false);
  }

  /* THE LIMBS.  A black pine carries its foliage on the outer third of
     every limb; without the two inner clumps you see straight through the
     middle of the crown, which is what gives a card tree away. */
  var limbs = 3 + Math.floor(rr(seed, 21, 0, 2.999));
  for (i = 0; i < limbs; i++) {
    var la = i / limbs * Math.PI * 2 + rr(seed, 30 + i, -0.5, 0.5);
    var lq = rr(seed, 40 + i, 0.02, 0.88);
    var reach = r * rr(seed, 50 + i, 0.55, 1.02) * (1 - 0.35 * lq);
    var by = cb + crownH * lq;
    var bq = (by - y) / (h * 0.94);
    var bp = stemAt(clamp(bq, 0, 1));
    var tipX = bp[0] + Math.cos(la) * reach;
    var tipZ = bp[2] + Math.sin(la) * reach;
    var tipY = by + crownH * 0.06;
    var mx = lerp(bp[0], tipX, 0.55), my = lerp(by, tipY, 0.55), mz = lerp(bp[2], tipZ, 0.55);
    grFrustum(P.render, bp[0], by, bp[2], mx, my, mz,
              trunkR * 0.44, trunkR * 0.30, 5, 1, bark, false, false);
    grFrustum(P.render, mx, my, mz, tipX, tipY, tipZ,
              trunkR * 0.30, trunkR * 0.14, 4, 1, bark, false, false);
    var nb = 4 + Math.floor(rr(seed, 60 + i, 0, 2.999));
    for (j = 0; j < nb; j++) {
      var s2 = seed + i * 17 + j * 5;
      var bd = reach * rr(s2, 1, 0.10, 0.46);
      var ba = la + rr(s2, 2, -0.85, 0.85);
      var by2 = tipY + rr(s2, 4, -crownH * 0.06, crownH * 0.07);
      grClump(tipX - Math.cos(ba) * bd + rr(s2, 3, -0.6, 0.6), by2,
              tipZ - Math.sin(ba) * bd + rr(s2, 5, -0.6, 0.6),
              r * rr(s2, 6, 0.28, 0.46), base, s2, crownLift(by2, true));
    }
    for (j = 0; j < 2; j++) {
      var f = j ? 0.74 : 0.52, s3 = seed + i * 23 + j * 9;
      var by3 = lerp(by, tipY, f) + rr(s3, 2, -0.4, 0.5);
      grClump(lerp(bp[0], tipX, f), by3,
              lerp(bp[2], tipZ, f), r * rr(s3, 3, 0.22, 0.34), base, s3,
              crownLift(by3, false));
    }
  }
  /* the head: never a point, never a leader spike */
  var nh = 7 + Math.floor(rr(seed, 80, 0, 3.999));
  for (i = 0; i < nh; i++) {
    var ha = i / nh * Math.PI * 2 + rr(seed, 90 + i, -0.6, 0.6);
    var hr = r * rr(seed, 100 + i, 0.18, 0.40);
    var hy = top - crownH * rr(seed, 110 + i, 0.02, 0.20);
    grClump(x + leanX * r * 0.9 + Math.cos(ha) * hr, hy,
            z + leanZ * r * 0.9 + Math.sin(ha) * hr,
            r * rr(seed, 120 + i, 0.30, 0.48), base, seed + 200 + i,
            crownLift(hy, true));
  }
  STATS.trees++;
}

/* A tree pit: a kerbed bed 3.5 x 3.5 (1 m square, the municipal size),
   soil sunk 0.30, a precast edging ring 0.55 wide and 0.30 tall, and three
   weed crosses out at 0.55-0.92 of the pit radius.  A trunk that comes
   straight out of asphalt is the second-loudest prototype tell after a
   square kerb arris. */
function treePit(x, z, gy, seed) {
  var half = m(0.5), e = 0.55, y0 = gy + 0.03, top = gy + 0.30;
  var tone = upTone(mix(C.stone, C.kerb, 0.45)), i;
  var cy = (y0 + top) * 0.5, hy = (top - y0) * 0.5;
  boxC(P.stone, x, cy, z - half + e * 0.5, half + e, hy, e * 0.5, 0.05, 1, tone);
  boxC(P.stone, x, cy, z + half - e * 0.5, half + e, hy, e * 0.5, 0.05, 1, tone);
  boxC(P.stone, x - half + e * 0.5, cy, z, e * 0.5, hy, half - e * 0.5, 0.05, 1, tone);
  boxC(P.stone, x + half - e * 0.5, cy, z, e * 0.5, hy, half - e * 0.5, 0.05, 1, tone);
  /* THE SOIL SITS 0.05 ABOVE THE SURFACE, not 0.30 below it.  A real pit is
     sunk, but the paver deck and the road deck are closed slabs and the
     world floor under them belongs to buildWorld: punching a hole through
     both for a 1 m tree pit risks leaving a hole in the level.  Filled
     nearly flush inside its edging is what a municipal pit looks like
     after twenty years of sweepings anyway, and 0.05 keeps it clear of
     0.12 / 0.62 / 0.66 like everything else here. */
  grDisc(P.render, x, z, gy + 0.075, half - e * 0.6, 10, 0.72, mix(C.soil, C.dark, 0.18));
  for (i = 0; i < 3; i++) {
    var wa = rr(seed, 40 + i, 0, Math.PI * 2);
    var wr = (half - e) * rr(seed, 50 + i, 0.55, 0.92);
    var wh = rr(seed, 60 + i, 0.8, 1.5);
    var t = mix(C.needle, C.needleD, rr(seed, 70 + i, 0.2, 0.8));
    ncross(P.needle, N_GRASS, x + Math.cos(wa) * wr, gy + 0.085, z + Math.sin(wa) * wr,
           wh * 1.15, wh, wa,
           [t[0] * CARD_GAIN, t[1] * CARD_GAIN, t[2] * CARD_GAIN * 0.97]);
  }
  STATS.pits++;
}


/* -----------------------------------------------------------------------
   8.7  LAMP COLUMNS

   A 9 m municipal cobra-head column.  IT CARRIES NO THREE.js LIGHT AND IT
   NEVER WILL: r149 cannot mask a light per object, the night half of this
   campaign shares the scene, and it is the middle of an overcast day - so
   the lantern is what a switched-off lantern is, a grey moulded bowl with
   a flat dark lens.

   These are the ONLY rule-C-legal mast positions on the arms.  The footway
   is 1.14 m wide including its kerb; a 9 m column needs a 0.5 m root and
   would block it end to end.  The four blocked strips are cells the level
   already marks occupied, so a column there costs the player nothing.
   dir = the way the arm reaches over the carriageway.
   -------------------------------------------------------------------- */
function lamp(x, z, dir, seed) {
  var gy = ROAD_TOP;
  var top = gy + m(9.0);                          /* 31.62 */
  var r0 = m(0.068), r1 = m(0.0434);              /* 238 mm -> 152 mm */
  var steel = mix(C.steel, C.dark, 0.34);
  var shaft = groundTone(steel, gy, 1.47);
  var i;

  /* cast base collar to y 1.05 (300 mm) with four holding-down bolts */
  boxC(P.metal, x, gy + 0.52, z, m(0.125), 0.50, m(0.125), 0.09, 1, upTone(steel));
  grFrustum(P.metal, x, gy + 1.02, z, x, gy + 1.28, z, m(0.098), m(0.082), 8, 1, steel, false, true);
  for (i = 0; i < 4; i++) {
    var ba = i / 4 * Math.PI * 2 + Math.PI * 0.25;
    tube(P.metal, [x + Math.cos(ba) * m(0.105), gy + 1.02, z + Math.sin(ba) * m(0.105)],
                  [x + Math.cos(ba) * m(0.105), gy + 1.30, z + Math.sin(ba) * m(0.105)],
         m(0.017), 5, steel, true, false);
  }

  /* four shaft segments, 238 mm at the collar tapering to 152 mm */
  var y0 = gy + 1.05;
  for (i = 0; i < 4; i++) {
    var a = y0 + (top - y0) * (i / 4), b = y0 + (top - y0) * ((i + 1) / 4);
    var ra = lerp(r0, r1, i / 4), rb = lerp(r0, r1, (i + 1) / 4);
    grFrustum(P.metal, x, a, z, x, b, z, ra, rb, 8, 1, shaft, false, false);
  }

  /* the access door and its rust weep, y 1.9..3.7.  Every column in the
     reference frames has one and every one of them is streaked. */
  var dr = lerp(r0, r1, (2.8 - y0) / (top - y0));
  var dnx = dir, dz0 = z - m(0.05), dz1 = z + m(0.05);
  panelX(P.metal, x + dnx * (dr + 0.02), 1.90, 3.70, dz0, dz1, dnx, 0.94, mix(steel, C.dark, 0.25));
  decalCard(P.decal, D_RUST, x + dnx * (dr + 0.04), 1.55, z,
            0, 0, 1, 0, 1, 0, 0.6, 2.2, mix(steel, C.dark, 0.42), [dnx, 0, 0]);

  /* THE ARM.  Seven segments on a quadratic that leaves the shaft top,
     rises over the kerb and drops 1.47 u to the spigot, 5.43 u (1.55 m)
     out over the carriageway.  A straight arm reads as scaffolding. */
  var out = 5.43, drop = 1.47, seg = 7;
  var ax = x, ay = top, az = z;
  var kx = x + dir * out * 0.55, ky = top + 0.55;
  var ex = x + dir * out, ey = top - drop;
  function armPt(t) {
    var u = 1 - t;
    return [u * u * ax + 2 * u * t * kx + t * t * ex,
            u * u * ay + 2 * u * t * ky + t * t * ey, az];
  }
  var prev = armPt(0);
  for (i = 1; i <= seg; i++) {
    var p = armPt(i / seg);
    grFrustum(P.metal, prev[0], prev[1], prev[2], p[0], p[1], p[2],
              lerp(r1, m(0.032), (i - 1) / seg), lerp(r1, m(0.032), i / seg), 7, 1, steel, false, false);
    prev = p;
  }

  /* the lantern: 230 -> 330 mm over 0.75 m, with a flat dark lens box
     280 x 90 mm hung 0.02 under it so the two are not coplanar */
  var lx = ex + dir * m(0.10), ly = ey - m(0.06);
  var lz = z;
  grFrustum(P.metal, lx, ly, lz, lx + dir * m(0.75), ly - m(0.05), lz,
            m(0.115), m(0.165), 9, 1, upTone(mix(C.grey, C.steel, 0.4)), true, true);
  box6(P.glass, lx + dir * m(0.06), lx + dir * m(0.62),
       ly - m(0.115), ly - m(0.085), lz - m(0.14), lz + m(0.14), 0.55,
       mix(C.dark, C.glass, 0.25));

  /* one occluder, under the luminaire and inset from it.  1.4 x 1.0 x 3.2:
     a box AROUND the lantern bakes the lantern black, because hitsBoxT
     exempts only a ray origin STRICTLY inside a box and a vertex exactly
     on the boundary is fully blocked. */
  var ocx = lx + dir * m(0.38);
  grOcc(ocx - 0.70, ly - 1.75, lz - 1.60, ocx + 0.70, ly - 0.75, lz + 1.60);
  STATS.lamps++;
}


/* -----------------------------------------------------------------------
   8.8  POLES, CABINETS AND THE OVERHEAD

   Two 9.6 m octagonal spun-concrete poles, the standard Turkish LV
   distribution pole, each with two channel crossarms, three brown
   porcelain insulators per arm and a junction cabinet at chest height.
   -------------------------------------------------------------------- */
function utilityPole(x, z, dir, seed) {
  var gy = 0.60;                                  /* buried in the kerb block */
  var top = gy + m(9.6);                          /* 34.20 */
  var conc = groundTone(mix(C.stone, C.grey, 0.42), gy, 2.10);
  var i, j;

  /* the pole: eight-sided, 0.62 -> 0.34, spun concrete.  Its own weathering
     is the groundTone soiling; the macro field on P.stone does the rest. */
  grFrustum(P.stone, x, gy, z, x, top, z, 0.62, 0.34, 8, 1, conc, false, true);

  /* two crossarms, at top-1.23 and top-3.85 */
  var steel = mix(C.steel, C.dark, 0.78);
  for (i = 0; i < 2; i++) {
    var ay = top - (i ? 3.85 : 1.23);
    box6(P.metal, x - 0.20, x + 0.20, ay - 0.30, ay + 0.30, z - m(1.0), z + m(1.0), 1, steel);
    /* the vee brace under it, which is what stops a crossarm reading as a
       plank nailed to a post */
    tube(P.metal, [x, ay - 0.30, z - m(0.86)], [x, ay - 1.55, z], 0.09, 5, steel, false, false);
    tube(P.metal, [x, ay - 0.30, z + m(0.86)], [x, ay - 1.55, z], 0.09, 5, steel, false, false);
    /* three insulators.  Glazed brown porcelain goes on P.joinery, NOT on
       P.metal: metalness 0.62 leaves almost no diffuse lobe to carry a
       vertex tone and every insulator on the street would be chrome. */
    for (j = 0; j < 3; j++) {
      var iz = z + (j - 1) * m(0.86);
      grFrustum(P.joinery, x, ay + 0.30, iz, x, ay + 0.30 + m(0.16), iz,
                m(0.048), m(0.038), 7, 1, mix(C.brick, C.dark, 0.32), false, true);
      grFrustum(P.joinery, x, ay + 0.30 + m(0.10), iz, x, ay + 0.30 + m(0.20), iz,
                m(0.072), m(0.052), 7, 1, mix(C.brick, C.dark, 0.32), false, true);
    }
  }

  /* the junction cabinet: 1.33 x 2.10 x 0.77 u = 380 x 600 x 220 mm,
     strapped to the street face of the pole at chest height */
  var cy0 = 4.20, cy1 = 6.30, cd = dir * 0.77;
  boxC(P.joinery, x + cd * 0.5 + dir * 0.34, (cy0 + cy1) * 0.5, z,
       0.385, (cy1 - cy0) * 0.5, 0.665, 0.10, 1, mix(C.grey, C.steel, 0.30));
  /* THE WARNING PLATE IS A LABEL, NOT A LIVERY.  It used to be a chevron band
     at capH 0.55, and because the hazard slot's capFrac is 1 that IS the card
     height, and the slot's aspect is 296/106 = 2.792, so the board came out
     0.55 tall by 1.536 wide = 157 x 439 mm of chrome
     yellow across a cabinet whose door is only 380 mm wide, so it overhung
     the box on both sides and read as roadworks tape wrapped round a post.
     A Turkish LV junction cabinet carries a 200 mm sticker in the top corner
     of its door and nothing else.  Sized from the WIDTH the way side-6 sizes
     its barricade chevrons - 200 mm across, which at the slot's own aspect is
     72 mm tall - and toned off white, because #e8c024 at C.white (0.83
     linear) is the brightest thing on a street whose walls sit at 0.30. */
  var hz = signSize('hazard', 1);
  var hzA = hz ? hz.aspect : 2.792;               /* 296/106 drawn pixels    */
  signCard(P.sign, 'hazard', x + dir * (0.34 + 0.79), cy1 - 0.46, z + 0.30,
           0, 0, 1, 0, 1, 0, m(0.20) / hzA, mix(C.grey, C.white, 0.35),
           [dir, 0, 0]);
  /* two straps */
  for (i = 0; i < 2; i++) {
    var sy = i ? cy1 - 0.32 : cy0 + 0.32;
    box6(P.metal, x - 0.50, x + dir * 0.40 + (dir > 0 ? 0.50 : -0.50), sy - 0.10, sy + 0.10,
         z - 0.72, z + 0.72, 1, steel);
  }
  /* no occluder on the cabinet.  It is 0.38 m across and its underside is
     1.2 m up, so the patch it darkens is smaller than the spacing between
     two bake vertices on the paving under it - and the module's OCC_CAP of
     45 is shared with four other sections. */

  /* the service drop down the pole to the buildings, and its cleats */
  tube(P.joinery, [x + dir * 0.30, top - 5.40, z + 0.30], [x + dir * 0.30, 6.60, z + 0.30],
       0.11, 5, C.dark, false, false);
}

/* A CATENARY, and it has to be a real one.  py = lerp(A.y,B.y,t) -
   sag*(cosh(C) - cosh(C*(2t-1)))/(cosh(C) - 1) with C = 1.62: at t = 0 and
   t = 1 the bracket is exactly cosh(C) so the term is zero, at t = 0.5 it
   is exactly sag.  A parabola is close but the ends leave the bracket at
   the wrong angle and it shows against a flat sky.

   ONE FIXED NORMAL FOR THE WHOLE STRAND, tipped 45 degrees off vertical.
   A tube's per-ring radial normals on a 0.077-radius cable at 30 m make it
   alternate black and white like a string of beads; a single normal makes
   it a line of one value, which is what a cable is at that range.  13 rings,
   four-sided section, three strands per bundle at 0.91 gap. */
function wireRun(ax, az, bx, bz, y, crossing) {
  var dx = bx - ax, dz = bz - az;
  var span = Math.sqrt(dx * dx + dz * dz);
  if (!(span > 2)) return;
  var ux = dx / span, uz = dz / span;
  var px = -uz, pz = ux;                          /* horizontal perpendicular */
  var sag = span * (crossing ? 0.045 : 0.034);
  var CC = 1.62, chC = Math.cosh ? Math.cosh(CC) : (Math.exp(CC) + Math.exp(-CC)) * 0.5;
  function ch(v) { return Math.cosh ? Math.cosh(v) : (Math.exp(v) + Math.exp(-v)) * 0.5; }
  /* the perpendicular is turned to point at the street centre, so the one
     fixed normal always faces the camera's half of the world */
  var midx = (ax + bx) * 0.5;
  var toward = (midx > 564) ? 1 : -1;   /* px is -uz, so this lands the tip */
  if (crossing) toward = 1;             /* on the street side of the run    */
  /* THE NORMAL POINTS DOWN, not up. A player looks UP at an overhead cable, so
     the face he sees is its shaded underside; a normal tipped up puts the
     reflection vector into the brightest part of the sky and returns the one
     surface in the level that is guaranteed to be brighter than everything
     around it. Tipped down, the same strand samples the canyon and the road,
     which is what a real cable against a blue sky actually looks like. */
  var nx = px * 0.835 * toward, ny = -0.55, nz = pz * 0.835 * toward;
  var tone = [0.043, 0.042, 0.041];               /* weathered ACSR, measured */
  var r = 0.077, rings = 13, s, i;
  var WP = P.wire || P.metal;
  for (s = -1; s <= 1; s++) {
    var ox = px * s * 0.91, oz = pz * s * 0.91;
    var base = WP.n;
    for (i = 0; i < rings; i++) {
      var t = i / (rings - 1);
      var cx = lerp(ax, bx, t) + ox, cz = lerp(az, bz, t) + oz;
      var cy = y - sag * (chC - ch(CC * (2 * t - 1))) / (chC - 1);
      var q, corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (q = 0; q < 4; q++) {
        WP.vert(cx + px * corner[q][0] * r, cy + corner[q][1] * r, cz + pz * corner[q][0] * r,
                nx, ny, nz, t * span * WP.inv, q * 0.25, 1, tone);
      }
    }
    for (i = 0; i < rings - 1; i++) {
      var o = base + i * 4, q2;
      for (q2 = 0; q2 < 4; q2++) {
        var a = o + q2, b = o + (q2 + 1) % 4;
        WP.tri(a, b, b + 4); WP.tri(a, b + 4, a + 4);
      }
    }
  }
  STATS.wires++;
}

/* the bracket that stands a catenary 1.925 u (0.55 m) off the facade.  At
   0.30 m the whole run reads as a line drawn ON the wall; at 0.55 m it
   reads as a wire and casts its own shadow band. */
function grWireBracket(faceX, dir, z, y) {
  var steel = mix(C.steel, C.dark, 0.40);
  tube(P.metal, [faceX, y - 0.30, z], [faceX + dir * 1.925, y, z], 0.16, 5, steel, true, false);
  tube(P.metal, [faceX, y - 2.20, z], [faceX + dir * 1.40, y - 0.20, z], 0.11, 5, steel, false, false);
  box6(P.metal, faceX - dir * 0.06, faceX + dir * 0.14, y - 2.60, y + 0.40,
       z - 0.42, z + 0.42, 0.88, steel);
}


/* -----------------------------------------------------------------------
   8.9  THE FOUR BLOCKED KERB STRIPS

   NUKEM.html marks sixteen carriageway cells S_BLOCK for the four parked
   cars this rebuild deletes.  occupy() sets S_BLOCK and pushes nothing to
   CRATES, and geomOpen() draws no wall quad for S_BLOCK, so a blocked cell
   with nothing on it is an invisible wall the player walks into.  This
   module never writes a map cell and NUKEM.html is not to be edited, so
   all four strips carry replacement geometry - and none of it is a
   vehicle.  Rule C allows 0.98 u of overhang on every side, so the legal
   envelope per strip is 5.96 x 17.96 u = 1.70 x 5.13 m.  Every layout
   below was measured against that envelope; where the site plan asks for
   more than 1.70 x 5.13 m of props the count came down, because three
   1.2 m bins, a bagged pile, a 9 m column and a 1.6 m planter do not fit
   in five metres and pretending otherwise buries one of them in another.
   -------------------------------------------------------------------- */

/* a 400-litre municipal wheelie container: 1.20 x 1.00 x 1.25 m.  HDPE, so
   it rides P.joinery (roughness 0.42 / metalness 0.02) - on P.metal at
   metalness 0.62 a green bin comes back as green chrome. */
function grBin(cx, cz, gy, openLid, seed) {
  var HL = m(0.60), HD = m(0.50), H = m(1.25);
  var green = [0.048, 0.100, 0.068];
  var body = gy + m(0.16), lidY = gy + H - m(0.10);
  var i;
  boxC(P.joinery, cx, (body + lidY) * 0.5, cz, HD * 0.96, (lidY - body) * 0.5, HL * 0.96,
       0.22, 1, green);
  /* the lid, chamfered and set 0.02 proud of the tub so the joint reads */
  if (openLid) {
    poly(P.joinery, [[cx - HD, lidY, cz - HL], [cx + HD, lidY, cz - HL],
                     [cx + HD, lidY + m(0.55), cz - HL - m(0.42)],
                     [cx - HD, lidY + m(0.55), cz - HL - m(0.42)]],
         [cx, lidY - 1, cz], 1, mix(green, C.dark, 0.18));
  } else {
    boxC(P.joinery, cx, lidY + m(0.055), cz, HD, m(0.055), HL, 0.10, 1,
         upTone(mix(green, C.dark, 0.10)));
  }
  /* four 110 mm castors and the axle bar */
  for (i = 0; i < 4; i++) {
    var wx = cx + (i < 2 ? -1 : 1) * HD * 0.72;
    var wz = cz + (i % 2 ? 1 : -1) * HL * 0.78;
    tube(P.joinery, [wx - m(0.03), gy + m(0.055), wz], [wx + m(0.03), gy + m(0.055), wz],
         m(0.055), 6, mix(C.dark, C.grey, 0.12), true, false);
  }
  box6(P.joinery, cx - HD * 0.80, cx + HD * 0.80, gy + m(0.11), gy + m(0.17),
       cz - HL * 0.86, cz + HL * 0.86, 0.62, mix(green, C.dark, 0.34));
  /* the grime that makes it municipal rather than new */
  decalCard(P.decal, D_GROUND, cx - HD - 0.02, gy + m(0.42), cz,
            0, 0, 1, 0, 1, 0, HL * 1.9, m(0.75), mix(green, C.dark, 0.55), [-1, 0, 0]);
  decalCard(P.decal, D_STREAK, cx - HD - 0.03, gy + m(0.85), cz + rr(seed, 3, -1.2, 1.2),
            0, 0, 1, 0, 1, 0, m(0.5), m(0.7), mix(green, C.dark, 0.42), [-1, 0, 0]);
}

/* six chamfered sacks.  boxC with k at its clamp is a rounded blob, which
   is what a full bin bag is; six of them at three tones is a fly-tip. */
function grSacks(cx, cz, gy, seed) {
  var i;
  for (i = 0; i < 6; i++) {
    var sx = cx + rr(seed, 10 + i, -1.30, 1.30);
    var sz = cz + rr(seed, 20 + i, -1.15, 1.15);
    var sh = rr(seed, 30 + i, 0.85, 1.45), sw = rr(seed, 40 + i, 1.00, 1.55);
    var lay = i < 3 ? 0 : sh * 0.9;
    var t = mix(C.dark, C.grey, rr(seed, 50 + i, 0.02, 0.30));
    /* +0.03 off the deck: a box whose underside lands exactly on the road
       plane is one more coplanar pair, and there are 24 of these */
    boxC(P.joinery, sx, gy + 0.03 + lay + sh * 0.5, sz, sw * 0.5, sh * 0.5, sw * 0.44,
         Math.min(sw, sh) * 0.44, 1, t);
  }
}

function binRun(cx, gy, zs, seed) {
  var i;
  for (i = 0; i < zs.length; i++) grBin(cx, zs[i], gy, i === 1, seed + i * 7);
}

/* a 12-yard builder's skip.  Sloped ends, a top rail, a rusted body and a
   heaped load - a flat-topped box of spoil is a crate, not a skip.
   z1 is 119.4 rather than the site plan's 120.98 so the downstream water
   barrier still has a legal footprint inside the strip's 0.98 overhang. */
function skip(x0, x1, z0, z1, gy) {
  var H = m(1.25), lean = m(0.45);
  var rust = mix(C.steel, mix(C.brick, C.dark, 0.30), 0.55);
  var side = mix(rust, C.dark, 0.12), i;
  /* floor.  It starts at gy + 0.02 and not at gy: a box bottom laid exactly
     on the road plane is a coplanar pair whether or not you can see it. */
  var f0 = gy + 0.02, f1 = gy + 0.26;
  box6(P.metal, x0, x1, f0, f1, z0, z1, 0.70, mix(rust, C.dark, 0.35));
  /* two long sides */
  panelX(P.metal, x0, f1, gy + H, z0, z1, -1, 1, side);
  panelX(P.metal, x1, f1, gy + H, z0, z1, 1, 1, side);
  panelX(P.metal, x0 + 0.10, f1, gy + H, z0, z1, 1, 0.62, mix(side, C.dark, 0.40));
  panelX(P.metal, x1 - 0.10, f1, gy + H, z0, z1, -1, 0.62, mix(side, C.dark, 0.40));
  /* the two sloped ends */
  poly(P.metal, [[x0, f1, z0], [x1, f1, z0],
                 [x1, gy + H, z0 - lean], [x0, gy + H, z0 - lean]],
       [(x0 + x1) * 0.5, gy + 0.6, z0 + 2], 1, side);
  poly(P.metal, [[x0, f1, z1], [x1, f1, z1],
                 [x1, gy + H, z1 + lean], [x0, gy + H, z1 + lean]],
       [(x0 + x1) * 0.5, gy + 0.6, z1 - 2], 1, side);
  /* the top rail, three ribs and the two lifting lugs */
  tube(P.metal, [x0, gy + H, z0 - lean], [x0, gy + H, z1 + lean], 0.16, 6, rust, true, false);
  tube(P.metal, [x1, gy + H, z0 - lean], [x1, gy + H, z1 + lean], 0.16, 6, rust, true, false);
  for (i = 1; i < 4; i++) {
    var rz = lerp(z0, z1, i / 4);
    box6(P.metal, x0 - 0.10, x0 + 0.02, f1 + 0.06, gy + H, rz - 0.22, rz + 0.22, 1, mix(rust, C.dark, 0.22));
    box6(P.metal, x1 - 0.02, x1 + 0.10, f1 + 0.06, gy + H, rz - 0.22, rz + 0.22, 1, mix(rust, C.dark, 0.22));
  }
  /* the load: three overlapping mounds of broken render and rubble, heaped
     proud of the rail at the middle */
  for (i = 0; i < 3; i++) {
    var mz = lerp(z0 + 2.5, z1 - 2.5, (i + 0.5) / 3);
    var mh = gy + H + rr(701, i, 0.30, 1.25);
    grDisc(P.stone, (x0 + x1) * 0.5 + rr(703, i, -0.7, 0.7), mz, mh,
           rr(705, i, 2.1, 2.9), 9, 0.92, mix(C.stone, C.soil, rr(707, i, 0.25, 0.60)));
    grFrustum(P.stone, (x0 + x1) * 0.5, gy + H - 0.4, mz,
              (x0 + x1) * 0.5, mh, mz, 2.7, rr(709, i, 1.6, 2.4), 8, 1,
              mix(C.stone, C.soil, rr(711, i, 0.20, 0.55)), false, false);
  }
  for (i = 0; i < 5; i++) {
    var bx = lerp(x0 + 1.0, x1 - 1.0, rr(713, i, 0.1, 0.9));
    var bz = lerp(z0 + 1.5, z1 - 1.5, rr(715, i, 0.1, 0.9));
    boxC(P.render, bx, gy + H + rr(717, i, 0.5, 1.4), bz,
         rr(719, i, 0.6, 1.2), 0.30, rr(721, i, 0.5, 1.0), 0.12, 1,
         mix(C.cream, C.stone, rr(723, i, 0.2, 0.8)));
  }
  /* rust weeps down both long faces */
  for (i = 0; i < 4; i++) {
    var wz = lerp(z0 + 2, z1 - 2, (i + 0.5) / 4);
    decalCard(P.decal, D_RUST, x0 - 0.03, gy + H * 0.55, wz,
              0, 0, 1, 0, 1, 0, 1.6, H * 0.85, mix(rust, C.dark, 0.30), [-1, 0, 0]);
  }
}

/* a water-filled plastic barrier, the red-and-white kind every Turkish
   roadworks uses.  P.joinery: it is polyethylene. */
function grWaterBarrier(cx, cz, gy, along, halfLen, seed) {
  var HL = halfLen || m(1.0), HW = m(0.25), H = m(0.95);
  var ax = along === 'x' ? HL : HW, az = along === 'x' ? HW : HL;
  var i, n = 4;
  for (i = 0; i < n; i++) {
    var t0 = i / n, t1 = (i + 1) / n;
    var t = (i % 2) ? C.white : mix(C.red, C.white, 0.10);
    var s0 = -1 + 2 * t0, s1 = -1 + 2 * t1;
    var q0 = along === 'x' ? cx + ax * s0 : cz + az * s0;
    var q1 = along === 'x' ? cx + ax * s1 : cz + az * s1;
    if (along === 'x')
      box6(P.joinery, q0, q1, gy + 0.12, gy + H, cz - az, cz + az, 1, t);
    else
      box6(P.joinery, cx - ax, cx + ax, gy + 0.12, gy + H, q0, q1, 1, t);
  }
  /* the moulded foot and the top handle rail.  The foot is flush with the
     body in plan: a 1.06 flare put the west run of strip 4 outside its own
     0.98 u overhang allowance by 5 cm. */
  var fx = along === 'x' ? ax : ax * 1.10;      /* the flare is always on the */
  var fz = along === 'x' ? az * 1.10 : az;      /* SHORT axis, never the long */
  box6(P.joinery, cx - fx, cx + fx, gy + 0.02, gy + 0.32,
       cz - fz, cz + fz, 0.70, mix(C.grey, C.dark, 0.32));
  if (along === 'x')
    tube(P.joinery, [cx - ax * 0.85, gy + H + 0.10, cz], [cx + ax * 0.85, gy + H + 0.10, cz],
         0.13, 6, mix(C.white, C.grey, 0.30), true, false);
  else
    tube(P.joinery, [cx, gy + H + 0.10, cz - az * 0.85], [cx, gy + H + 0.10, cz + az * 0.85],
         0.13, 6, mix(C.white, C.grey, 0.30), true, false);
  decalCard(P.decal, D_GROUND, cx, gy + 0.62, cz + (along === 'x' ? -az - 0.03 : 0),
            1, 0, 0, 0, 1, 0, ax * 1.6, 0.9, mix(C.grey, C.dark, 0.40),
            along === 'x' ? [0, 0, -1] : [0, 0, 1]);
  return seed;
}

/* the pazar stall: two trestles side by side under one striped canopy.
   Two rather than three, because three 2.0 m tables end to end is 6.0 m
   and the strip's legal length is 5.13 m; side by side they fit its width
   twice over and read as a real market run seen down the street. */
function marketRun(cx, cz, gy, seed) {
  var i, j;
  /* tl and td are HALF extents: a trestle is 2.0 x 0.80 m, so 3.5 x 1.4 u
     each way from the centre = the 7.0 x 2.8 u the site plan asks for */
  var topY = gy + m(0.83), tl = m(1.0), td = m(0.40);
  var timber = mix(C.timber, C.stone, 0.30);
  var steel = mix(C.steel, C.dark, 0.30);
  for (i = 0; i < 2; i++) {
    var tx = cx + (i ? 1 : -1) * m(0.44);
    /* the board top, five planks with a joint between them */
    for (j = 0; j < 4; j++) {
      var px0 = tx - td + (td * 2) * (j / 4) + 0.05;
      var px1 = tx - td + (td * 2) * ((j + 1) / 4) - 0.05;
      boxC(P.joinery, (px0 + px1) * 0.5, topY - m(0.02), cz,
           (px1 - px0) * 0.5, m(0.02), tl, 0.05, 1,
           upTone(mix(timber, C.dark, rr(seed, i * 4 + j, 0.02, 0.22))));
    }
    /* four folding legs */
    for (j = 0; j < 4; j++) {
      var lx = tx + (j < 2 ? -1 : 1) * td * 0.72;
      var lz = cz + (j % 2 ? 1 : -1) * tl * 0.78;
      tube(P.metal, [lx, gy, lz], [lx + (j < 2 ? 0.35 : -0.35), topY - m(0.05), lz],
           0.13, 5, steel, false, false);
    }
    box6(P.metal, tx - td * 0.8, tx + td * 0.8, topY - m(0.30), topY - m(0.26),
         cz - tl * 0.80, cz + tl * 0.80, 0.66, steel);
    /* the produce: shallow crates of it, three per table */
    for (j = 0; j < 3; j++) {
      var qz = lerp(cz - tl * 0.7, cz + tl * 0.7, (j + 0.5) / 3);
      var pt = [mix(C.red, C.gold, 0.35), mix(C.green, C.gold, 0.30), mix(C.gold, C.white, 0.25)][j % 3];
      boxC(P.joinery, tx, topY + m(0.10), qz, td * 0.80, m(0.10), tl * 0.26, 0.10, 1,
           mix(C.timber, C.white, 0.42));
      boxC(P.joinery, tx, topY + m(0.24), qz, td * 0.66, m(0.06), tl * 0.21, 0.16, 1, pt);
    }
  }
  /* crates stacked underneath */
  for (i = 0; i < 5; i++) {
    var bx = cx + rr(seed + 3, i, -1.6, 1.6), bz = cz + rr(seed + 5, i, -tl * 0.7, tl * 0.7);
    var by = gy + 0.03 + (i % 2 ? m(0.34) : 0) + m(0.17);
    boxC(P.joinery, bx, by, bz, m(0.26), m(0.17), m(0.20), 0.10, 1,
         mix(C.timber, C.white, rr(seed + 7, i, 0.20, 0.60)));
  }
  /* The canopy at y 8.4 on four 0.12 poles, striped.  Its eave half-span is
     m(0.85) = 2.975 and not the 3.675 a 1.05 m eave would give: the strip's
     legal envelope is x 571.02..576.98 and 1.05 m of overhang puts the
     canopy edge 0.69 u outside it. */
  var cy = gy + m(2.37), n = 8, ridge = cy + m(0.22), eave = m(0.85);
  for (i = 0; i < 4; i++) {
    var qx = cx + (i < 2 ? -1 : 1) * m(0.72), qz = cz + (i % 2 ? 1 : -1) * (tl + m(0.10));
    tube(P.metal, [qx, gy, qz], [qx, cy, qz], 0.12, 5, steel, false, false);
  }
  for (i = 0; i < n; i++) {
    var s0 = cz - tl - m(0.15) + (2 * tl + m(0.30)) * (i / n);
    var s1 = cz - tl - m(0.15) + (2 * tl + m(0.30)) * ((i + 1) / n);
    var st = (i % 2) ? C.white : mix(C.red, C.white, 0.22);
    poly(P.joinery, [[cx - eave, cy, s0], [cx, ridge, s0], [cx, ridge, s1], [cx - eave, cy, s1]],
         [cx - eave * 0.5, cy - 1, (s0 + s1) * 0.5], 1, upTone(st));
    poly(P.joinery, [[cx + eave, cy, s0], [cx, ridge, s0], [cx, ridge, s1], [cx + eave, cy, s1]],
         [cx + eave * 0.5, cy - 1, (s0 + s1) * 0.5], 1, upTone(st));
  }
}

/* THE EXCAVATION IS BUILT UP, NOT DUG DOWN, AND THAT IS DELIBERATE.  The
   carriageway is one closed slab and the world floor under it belongs to
   buildWorld; cutting a hole through both for one prop risks leaving a
   hole in the level, and there is no way to test that from here.  So the
   trench is a 0.90 u (257 mm) heaped spoil bund with a near-black interior
   dropping back to road level inside it.  From standing height - the only
   height it is ever seen from, since the player cannot climb the bund -
   0.87 u of black between two spoil ridges reads as open ground, and the
   heaped profile on top is what makes it spoil rather than a kerb ring.
   x 552.90..555.10 is a 0.63 m service trench, which is what a water
   connection is dug at, and it leaves 1.53 u each side for the barriers. */
function roadworks(x0, x1, z0, z1, gy, seed) {
  var i;
  var soil = mix(C.soil, C.dark, 0.22), lip = 0.90, e = 0.35;
  var dark = [0.030, 0.028, 0.026];
  /* the bund, four boxes, chamfered so the ridge is not a machined arris */
  boxC(P.stone, (x0 + x1) * 0.5, gy + 0.02 + lip * 0.5, z0 - e * 0.5,
       (x1 - x0) * 0.5 + e, lip * 0.5, e * 0.5, 0.14, 1, upTone(soil));
  boxC(P.stone, (x0 + x1) * 0.5, gy + 0.02 + lip * 0.5, z1 + e * 0.5,
       (x1 - x0) * 0.5 + e, lip * 0.5, e * 0.5, 0.14, 1, upTone(soil));
  boxC(P.stone, x0 - e * 0.5, gy + 0.02 + lip * 0.5, (z0 + z1) * 0.5,
       e * 0.5, lip * 0.5, (z1 - z0) * 0.5, 0.14, 1, upTone(soil));
  boxC(P.stone, x1 + e * 0.5, gy + 0.02 + lip * 0.5, (z0 + z1) * 0.5,
       e * 0.5, lip * 0.5, (z1 - z0) * 0.5, 0.14, 1, upTone(soil));
  /* heaped spoil on the two long ridges: a flat-topped bund is a planter */
  for (i = 0; i < 6; i++) {
    var hz = lerp(z0 + 0.6, z1 - 0.6, (i % 3 + 0.5) / 3);
    var hx = (i < 3) ? x0 - e * 0.5 : x1 + e * 0.5;
    grFrustum(P.stone, hx, gy + lip * 0.4, hz, hx + rr(seed, i, -0.2, 0.2),
              gy + lip + rr(seed + 2, i, 0.25, 0.75), hz,
              e * 1.5, rr(seed + 4, i, 0.35, 0.75), 7, 1,
              upTone(mix(soil, C.stone, rr(seed + 6, i, 0.05, 0.35))), false, true);
  }
  /* the trench itself: floor back at road level, walls near-black */
  grFlat(P.asphalt, x0, z0, x1, z1, gy + 0.026, 0.30, [0.012, 0.012, 0.011]);
  panelX(P.asphalt, x0, gy + 0.026, gy + 0.92, z0, z1, 1, 0.40, dark);
  panelX(P.asphalt, x1, gy + 0.026, gy + 0.92, z0, z1, -1, 0.40, dark);
  panelZ(P.asphalt, z0, gy + 0.026, gy + 0.92, x0, x1, 1, 0.40, dark);
  panelZ(P.asphalt, z1, gy + 0.026, gy + 0.92, x0, x1, -1, 0.40, dark);
  /* the duct the gang is there for, lying in the trench.  No steel road
     plate: a 1.5 x 1.0 m plate needs 5.25 u and the widest free ground
     beside the trench on this strip is 1.88 u. */
  tube(P.joinery, [(x0 + x1) * 0.5, gy + 0.20, z0 + 0.4],
                  [(x0 + x1) * 0.5, gy + 0.20, z1 - 0.4], 0.36, 7,
       mix(C.dark, C.red, 0.30), false, false);
  /* THE MUD THE WHEELS HAVE TRACKED OUT OF IT, AND WHICH WAY UP IT GOES.
     A GROUND DECAL MUST NEVER SHOW A STRAIGHT EDGE THAT IS NOT ALSO A REAL
     EDGE IN THE GEOMETRY, and this was showing four of them.  The D_GROUND
     cell is the splash zone at the foot of a WALL: its alpha eases to zero on
     both flanks and at its head, but it is at FULL STRENGTH along its foot -
     the card's -V edge - because on a wall that edge is the pavement and the
     pavement is a real edge.  Laid flat with V along +z at 4.6 x 4.0 u the
     foot of the wash, which is a hard line by design, became a
     1.3 m dead-straight line of brown across open asphalt, four times over,
     with nothing under it - the card's own rectangle, visible.
     Three changes, and all three are the same rule.  (1) EIGHT SMALLER
     PIECES, 2.4-3.9 u, so no single edge is long enough to read as a ruled
     line.  (2) EACH ONE YAWED, so not one of them is parallel to a kerb, a
     bund or its neighbour.  (3) V POINTS OUTWARD FROM THE TRENCH, which puts
     the wash's foot - its one hard edge - against the spoil bund, a real
     edge, and turns the two soft flanks and the soft head toward the open
     road, where there is nothing for an edge to be an edge of.  The centre is
     set out half a card along V so the foot lands ON the bund face rather
     than two units short of it in open asphalt.
     ALL EIGHT ARE ON THE EAST BUND.  x 552.90..555.10 is hard against the
     west kerb: from that bund face to the kerb at 552.00 there is 0.55 u of
     road, so a west-side track has nowhere to run and the four that used to
     be centred on the trench draped 1.7 u of themselves over the kerb block
     and the footway behind it.  East of the trench there are twenty-one
     units of open carriageway, which is also the side the gang walks out on
     - the barriers stand off it at 556.08. */
  for (i = 0; i < 8; i++) {
    var wz = lerp(z0 - 2.6, z1 + 2.6, (i + rr(seed + 8, i, 0.18, 0.82)) / 8);
    var wl = rr(seed + 10, i, 2.4, 3.9);          /* 0.69-1.11 m of track    */
    var ww = wl * rr(seed + 12, i, 0.62, 0.95);
    /* the outward azimuth, jittered +-34 degrees: v = (cos va, 0, sin va),
       and the centre is set out half a length along it so the wash's foot
       sits on the bund face at x1 + 0.35. */
    var va = rr(seed + 14, i, -0.60, 0.60);
    var vcx = Math.cos(va), vcz = Math.sin(va);
    decalCard(P.decal, D_GROUND,
              x1 + 0.35 + vcx * wl * 0.5, gy + 0.058, wz + vcz * wl * 0.5,
              vcz, 0, -vcx, vcx, 0, vcz, ww, wl,
              mix(C.asphalt, C.soil, rr(seed + 16, i, 0.34, 0.56)), [0, 1, 0]);
  }
}

/* a stack of kilit tasi.  Real unit 200 x 165 x 60 mm; the bulk is one
   chamfered block so the courses do not cost 200 triangles, with the top
   course laid individually and slightly askew because that is the course
   the eye checks. */
function grPaverStack(cx, cz, gy, seed) {
  var W = m(0.60), D = m(0.50), H = m(0.42), i, b0 = gy + 0.03;
  boxC(P.paver, cx, b0 + H * 0.5, cz, W, H * 0.5, D, 0.06, 1,
       upTone(mix(C.paver, C.grey, 0.15)));
  for (i = 0; i < 6; i++) {
    var px = cx + ((i % 3) - 1) * m(0.21) + rr(seed, i, -0.10, 0.10);
    var pz = cz + ((i < 3) ? -1 : 1) * m(0.09) + rr(seed + 2, i, -0.08, 0.08);
    boxC(P.paver, px, b0 + H + m(0.03), pz, m(0.10), m(0.03), m(0.083), 0.03, 1,
         upTone(mix(C.paver, C.stone, rr(seed + 4, i, 0.0, 0.4))));
  }
}

/* a tipping cement mixer, 1.2 m to the drum lip: a drum of two frusta on a
   tubular A-frame with two barrow wheels.  Every site in the reference
   frames has one and nothing else says "the road is up" as quickly. */
function grMixer(cx, cz, gy, seed) {
  var steel = mix(C.steel, C.dark, 0.28), frame = mix(C.red, C.dark, 0.30);
  var dy = gy + m(0.86);
  grFrustum(P.metal, cx - m(0.16), dy - m(0.10), cz, cx + m(0.10), dy + m(0.10), cz,
            m(0.30), m(0.36), 10, 1, steel, true, false);
  grFrustum(P.metal, cx + m(0.10), dy + m(0.10), cz, cx + m(0.34), dy + m(0.24), cz,
            m(0.36), m(0.24), 10, 1, mix(steel, C.dark, 0.20), false, false);
  /* the A-frame and the motor housing */
  tube(P.metal, [cx - m(0.30), gy, cz - m(0.30)], [cx - m(0.05), dy, cz], 0.13, 5, frame, false, false);
  tube(P.metal, [cx - m(0.30), gy, cz + m(0.30)], [cx - m(0.05), dy, cz], 0.13, 5, frame, false, false);
  tube(P.metal, [cx + m(0.34), gy, cz], [cx + m(0.02), dy, cz], 0.13, 5, frame, false, false);
  boxC(P.metal, cx - m(0.42), dy - m(0.18), cz, m(0.16), m(0.14), m(0.14), 0.06, 1,
       mix(C.grey, C.dark, 0.30));
  var i;
  for (i = 0; i < 2; i++) {
    var wz = cz + (i ? 1 : -1) * m(0.32);
    tube(P.joinery, [cx - m(0.36), gy + m(0.16), wz], [cx - m(0.30), gy + m(0.16), wz],
         m(0.16), 8, mix(C.dark, C.grey, 0.10), true, false);
  }
  /* the cement wash under the drum.  Same rule as the trench mud: laid flat
     with V along +z this card put the wash's own hard foot down as a 1.4 m
     ruled line of pale grey across open asphalt, 2.1 u clear of anything
     that could be its edge.  Turned 0.72 rad off the kerb line so no edge of
     it is parallel to one, shrunk to 1.1 x 1.0 m, and set out along V so the
     foot lands UNDER the A-frame, which is a real edge and an opaque one. */
  var wa2 = -0.72, wc = Math.cos(wa2), ws = Math.sin(wa2), wl2 = m(1.0);
  decalCard(P.decal, D_GROUND,
            cx + wc * (wl2 * 0.5 - 0.55), gy + 0.062, cz + ws * (wl2 * 0.5 - 0.55),
            ws, 0, -wc, wc, 0, ws, m(1.1), wl2,
            mix(C.asphalt, C.white, 0.28), [0, 1, 0]);
  return seed;
}

/* a municipal timber planter, 1.60 x 0.91 x 0.80 m, laid ACROSS the strip
   because 1.60 m does not fit along a 5.13 m strip that is already
   carrying a 9 m column and two bins - across it, it clears both edges of
   the legal envelope by 0.18 u. */
function grPlanter(cx, cz, gy, seed) {
  var HX = m(0.80), HZ = m(0.455), H = m(0.80);
  var timber = mix(C.timber, C.dark, 0.10), i;
  /* six boards a side with a joint between, on four corner posts */
  for (i = 0; i < 3; i++) {
    var by = gy + m(0.10) + (H - m(0.14)) * ((i + 0.5) / 3);
    var bh = (H - m(0.14)) / 3 * 0.40;
    var t = upTone(mix(timber, C.stone, rr(seed, i, 0.05, 0.28)));
    box6(P.joinery, cx - HX, cx + HX, by - bh, by + bh, cz - HZ, cz - HZ + 0.30, 1, t);
    box6(P.joinery, cx - HX, cx + HX, by - bh, by + bh, cz + HZ - 0.30, cz + HZ, 1, t);
    box6(P.joinery, cx - HX, cx - HX + 0.30, by - bh, by + bh, cz - HZ, cz + HZ, 1, t);
    box6(P.joinery, cx + HX - 0.30, cx + HX, by - bh, by + bh, cz - HZ, cz + HZ, 1, t);
  }
  for (i = 0; i < 4; i++) {
    var px = cx + (i < 2 ? -1 : 1) * (HX - 0.22), pz = cz + (i % 2 ? 1 : -1) * (HZ - 0.22);
    boxC(P.joinery, px, gy + 0.03 + H * 0.5, pz, 0.30, H * 0.5, 0.30, 0.07, 1,
         upTone(mix(timber, C.dark, 0.22)));
  }
  /* the coping rail and the soil, sunk 0.30 under it */
  boxC(P.joinery, cx, gy + H + 0.14, cz, HX + 0.14, 0.14, HZ + 0.14, 0.09, 1,
       upTone(mix(timber, C.stone, 0.20)));
  grFlat(P.render, cx - HX + 0.34, cz - HZ + 0.34, cx + HX - 0.34, cz + HZ - 0.34,
         gy + H - 0.30, 0.74, mix(C.soil, C.dark, 0.15));
  for (i = 0; i < 4; i++) {
    var wa = rr(seed + 9, i, 0, Math.PI * 2), wr = rr(seed + 11, i, 0.6, 1.8);
    var t2 = mix(C.needle, C.needleD, rr(seed + 13, i, 0.2, 0.7));
    ncross(P.needle, N_SHRUB, cx + Math.cos(wa) * wr, gy + H - 0.28, cz + Math.sin(wa) * wr * 0.55,
           1.5, 1.2, wa, [t2[0] * SHRUB_GAIN, t2[1] * SHRUB_GAIN, t2[2] * SHRUB_GAIN * 0.97]);
  }
}


/* -----------------------------------------------------------------------
   8.10  PLATES AND NUMBERS

   The blue Turkish street plate, OZGUR MAH. over 232. SK.  Mounted at
   y 12.60 (3.60 m), which is where they are in every reference frame and,
   more usefully, above the 0.36-proud storey band at y 10.80..11.70 and
   above the shop fascias at 7.35..10.70 and clear of apartment name boards.
   It stands 0.30 proud of the wall face.
   -------------------------------------------------------------------- */
function namePlate(faceX, dir, z, y) {
  var px = faceX + dir * 0.30;
  /* the plate's own bracket: two lugs, or it floats */
  box6(P.metal, faceX, px, y - 0.90, y - 0.70, z - 1.55, z - 1.25, 0.72, mix(C.steel, C.dark, 0.30));
  box6(P.metal, faceX, px, y - 0.90, y - 0.70, z + 1.25, z + 1.55, 0.72, mix(C.steel, C.dark, 0.30));
  signCard(P.sign, 'sokak', px, y, z, 0, 0, 1, 0, 1, 0, 2.10, C.white, [dir, 0, 0]);
}

function grHouseNumber(faceX, dir, z, y) {
  signCard(P.sign, 'numara', faceX + dir * 0.20, y, z, 0, 0, 1, 0, 1, 0, 1.33, C.white, [dir, 0, 0]);
}


/* -----------------------------------------------------------------------
   8.11  buildFurniture()

   Called after the masses and corners, so everything here stands against
   finished walls.
   -------------------------------------------------------------------- */
function buildFurniture() {
  var gy = ROAD_TOP, i;

  /* The photographed north/downhill arm is intentionally clear: no car,
     skip, water barriers or bin barricade.  Two slim kerb lamps provide the
     sparse rhythm visible in the real street without occupying a traffic lane. */
  lamp(579.45, 72.0, -1, 11);
  lamp(579.45, 116.0, -1, 13);

  /* ---- STRIP 3  x 572..576, z 224..240.  Pazar.  Planter across the
     strip at the north end, the stall in the middle, column at the far
     end - the market side of a Turkish street on a Wednesday. */
  grPlanter(574.0, 224.9, gy, 241);
  marketRun(574.0, 231.0, gy, 251);
  lamp(574.0, 238.5, -1, 17);
  grOcc(571.60, gy + 6.30, 226.20, 576.40, gy + 7.90, 235.80);

  /* ---- STRIP 4  x 552..556, z 256..272.  Roadworks: an excavation ringed
     by eight plastic barriers, a paver stack, a mixer and the column. */
  grMixer(553.0, 256.0, gy, 261);
  grPaverStack(555.5, 256.2, gy, 263);
  roadworks(552.90, 555.10, 259.0, 268.0, gy, 271);
  /* eight plastic barriers ringing the trench.  The two end runs are
     2.80 half-length (1.60 m) rather than the stock 2.00 m unit, because a
     7.0 u barrier laid across a 5.96 u legal envelope hangs 0.5 u out of
     it at both ends. */
  grWaterBarrier(554.0, 257.4, gy, 'x', 2.80, 281);
  grWaterBarrier(554.0, 269.4, gy, 'x', 2.80, 283);
  for (i = 0; i < 3; i++) {
    var bz = 260.6 + i * 3.4;
    grWaterBarrier(551.92, bz, gy, 'z', 3.20, 291 + i);
    grWaterBarrier(556.08, bz, gy, 'z', 3.20, 301 + i);
  }
  lamp(554.0, 270.5, 1, 19);
  grOcc(552.20, gy + 0.42, 257.60, 555.80, gy + 3.20, 268.90);

  /* The planted conifer belongs to the busier south market strip. */
  conifer(574.0, 224.9, gy + m(0.80) - 0.30, 24.5, 5.4);
  /* the crown occluders stop at 558.90 / 569.10 rather than a flat +-8 u,
     because SECTION 6's cornice stands 0.83 proud of both faces (548.85
     and 579.15) and a vertex that lands exactly on an occluder boundary is
     fully blocked - hitsBoxT exempts only origins STRICTLY inside */
  grOcc(569.10, gy + 11.5, 219.80, 578.90, gy + 24.0, 230.00);

  /* ---- THE STREET TREE ROWS.  Every tree in the build this replaces
     stood either 2 u inside a traffic lane (x 554.2 and 574.0) or 5 u
     inside a building (x 755 and 797).  The footway here is 1.14 m wide
     including its kerb and a tree pit needs 3.5 m, so the only mature
     trees on 232 Sk stand BEYOND the two closures, where the player never
     walks and the row closes the vista instead of blocking the pavement.

     THEY STAND IN THE CARRIAGEWAY, at x 558.5 and 569.5, not on the
     footway line.  A pine's outermost card sits at about 1.48 x its stated
     radius (reach 1.02r plus a clump card at 0.46r), so a r 6.6 tree on
     the footway line at x 549.4 throws foliage to x 539.6 - nine units
     inside the terminus block SECTION 9 builds at x 482..548.  From the
     traffic lanes the same tree clears both building lines by 0.7 u.  An
     allee of black pines down the approach to a camii, and down the town
     approach at the other end, is what a Turkish municipality plants
     there anyway.
     The old north pairs at z 41 and 50 have been removed: the road is now
     playable there and trunks in both traffic lanes contradicted the real
     parked-car street.  The mosque precinct supplies irregular mature trees
     beyond the far line.  South keeps one pair behind its barricade.
     because the minaret kup at z 308.3..323.7 (x 545.3..560.7 and
     567.3..582.7) takes everything past it.

     The rule "no tree trunk between x 552 and x 576" is a rule about the
     WALKABLE arms - z 56..144 and z 212..322 - and no trunk of ours stands
     there or anywhere near there.  Behind a barricade the carriageway is
     not a traffic lane, and 232 Sk is 9.14 m building line to building
     line: there is no point on it, in front of the closures or behind
     them, where a mature pine's crown clears both walls from a footway.
     Trunk in the lane and crown clear, or trunk on the footway and nine
     units of foliage inside SECTION 9's terminus block - that is the whole
     choice, and it is only offered at all because the player cannot get
     there. */
  var rows = [[512.5, 516.0, 5.4], [553.5, 520.0, 5.2]];
  for (i = 0; i < rows.length; i++) {
    var tx = rows[i][0], tz = rows[i][1], trad = rows[i][2];
    treePit(tx, tz, ROAD_TOP, 501 + i * 7);
    conifer(tx + rr(509, i, -0.6, 0.6), tz + rr(511, i, -0.7, 0.7),
            ROAD_TOP - 0.24, rr(513, i, 26.0, 31.0), trad);
  }

  /* Keep the utility bundle on the busier south arm.  The photographed north
     side has clean façades and sparse street lighting, so the old pole and
     six criss-crossing cable runs have been removed there. */
  utilityPole(576.4, 246.0, -1, 611);

  /* Wall brackets stand every cable 1.925 u (0.55 m) off the facade.  y is
     33.4 throughout: five times the jump apex above jumpTop, so nothing
     the player can reach ever touches a cable. */
  /* Every anchor z is chosen to land on solid render.  138 and not 140 on
     the east: 140 is exactly N-E2's end and SECTION 7's corner quoin at
     (580,140).  254 and not 256 on the east: 256 is the party slot's own
     return face.  292 is inside S-E2's loggia void (284..292 at y 11.2..21)
     but the bracket is at y 33.4, thirteen units above its head. */
  var WY = 33.4, WE = XE - 1.925;
  var bra = [[XE - PROUD, -1, 216.0], [XE - PROUD, -1, 254.0],
             [XE - PROUD, -1, 292.0]];
  for (i = 0; i < bra.length; i++) grWireBracket(bra[i][0], bra[i][1], bra[i][2], WY);

  /* one unobtrusive south longitudinal run at sag = span * 0.034 */
  wireRun(WE, 216.0, WE, 254.0, WY, false);

  /* ---- street plates: one at each closure and one at each junction
     corner, so the street names itself from both ends of both arms */
  namePlate(XE - PROUD, -1, 136.4, 12.60);        /* N-E2, off the roundabout */
  namePlate(NORTH_XW + PROUD, 1, 126.0, 12.60);   /* N-W3, pharmacy corner */
  namePlate(XE - PROUD, -1, 212.5, 12.60);        /* S-E1 */
  namePlate(NORTH_XW + PROUD, 1, 62.0, 12.60);    /* north apartment corner */
  namePlate(XE - PROUD, -1, 502.0, 12.60);        /* the south closure */

  /* ---- house numbers, one beside every gameplay door on the junction.
     y 12.0 clears the storey band at 10.80..11.70 and sits under the first
     floor band at 21.05, so the plaque is on bare render either way. */
  grHouseNumber(XE - PROUD, -1, 89.6, 12.00);     /* cell (145,21) */
  grHouseNumber(XE - PROUD, -1, 133.2, 12.00);    /* cell (145,32), A-BLOK */
  grHouseNumber(XE - PROUD, -1, 233.6, 12.00);    /* cell (145,57), B-BLOK */
  grHouseNumber(XE - PROUD, -1, 277.6, 12.00);    /* cell (145,68) */
  /* N-W2's old street door was removed when the west frontage moved; the
     pharmacy is the only raised retail threshold on this arm. */
}

/* ==== side-5-terminus.js ==== */
/* ===========================================================================
   SECTION 9  DISTANT STREET SCENERY AND THE MOSQUE
   ===========================================================================
   Everything beyond the police lines is scenery rather than a room.  The
   rebuilt north arm remains playable to row 1 and closes quietly on row 0;
   the matching south arm closes at z = 506.  This is scenery
   in the theatre sense - it exists to be looked
   at down a 32-u corridor for the whole length of a 250-u street, which is
   why the triangles go here and not on the backs of the town blocks.

   THE SURVEY CORRECTION.  Adil Camii is beside the south/opposite arm and on
   the west/left side of 232 Sk when looking away from the island; it does not
   terminate the carriageway.  mosque(frontZ, away) remains depth-parametric,
   while
   shiftedMosque() translates only the geometry emitted by that one call so
   the same detailed precinct can occupy its real off-axis plot.

   WHAT THE AUDIT SAID ABOUT THE MOSQUE THIS REPLACES, and what is done here:
     the dome sprang at y 28.5 UNDER a pantile hip whose ridge was 35.1, so
       the landmark was a bubble poking out of a roof.  It now springs at
       47.00, twelve units clear of the aisle ridges, and is the TOP of the
       composition;
     the two minarets ran r 2.35 with NO taper over 37 m - 1:28, a flagpole -
       with a 3.30-radius tube ABOVE the shaft where the petek should NARROW,
       no pabuc, no balustrade, an uncapped cone that mushroomed wider than
       its own shaft, and a plain gold cylinder for an alem.  Every one of
       those is corrected below: 9.2 u of shaft diameter over 136.6 u of
       height = 1:14.8, which is where a real neighbourhood minaret sits;
     there was not one arch anywhere on a building whose entire vocabulary is
       arches.  Every head on this mosque is a two-centred point.

   MATERIAL NOTE.  The dome and both kulah go on P.render, not P.metal.
   M.metal is metalness 0.62 and a 0.62-metal surface has almost no diffuse
   lobe left to carry a vertex tone, so lead routed through it comes back as
   chrome - which is the same defect that put every white PVC window frame on
   this street through a chrome material.  Lead at 30 m is a rough grey
   dielectric: the near-white render relief carries it and the tone does the
   colour.  Only the alem, the gate ironwork and the roof tanks are metal.
   ======================================================================== */


/* -----------------------------------------------------------------------
   9.0  LOCAL PRIMITIVES

   The kit gives tube/cone/dome as smooth bodies of revolution.  A minaret is
   not a body of revolution: its kup is square, its pabuc is a square lofted
   into an octagon, and its govde and petek are FACETED twelve-sided prisms
   whose arrises are the whole silhouette.  So this section carries one extra
   primitive, tmLoft, and everything round on the mosque is built from it.

   tmLoft writes EXPLICIT cylindrical uv (u = accumulated chord round the
   ring / tile, v = height / tile) and a per-facet normal.  That is the same
   fix the kit's tube(cyl:true) makes and for the same reason: the planar
   projector picks its axis from the dominant normal component, which on a
   vertical prism switches every 45 degrees, and the build this replaces ran
   four 0.67 m texture discontinuities up 26 m of each shaft.
   -------------------------------------------------------------------- */

/* a regular seg-gon of radius r about (cx,cz), CCW in the xz map */
function tmRing(cx, cz, r, seg, rot) {
  var i, a, o = [];
  for (i = 0; i < seg; i++) {
    a = (rot || 0) + i / seg * Math.PI * 2;
    o.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return o;
}

/* the outline of a SQUARE sampled at the same eight angles a regular octagon
   uses - corners at 45 degrees, edge midpoints at 0/90/180/270.  This is
   what lets the pabuc loft straight off the top of the kup with no seam:
   all eight points lie ON the square, so the two solids share an outline. */
function tmSqRing(cx, cz, h) {
  return [[cx + h, cz], [cx + h, cz + h], [cx, cz + h], [cx - h, cz + h],
          [cx - h, cz], [cx - h, cz - h], [cx, cz - h], [cx + h, cz - h]];
}

/* the pabuc's intermediate outline: a square of half-width h morphing into a
   regular octagon of radius r, both sampled at the same eight angles, so a
   straight point-by-point lerp IS the transition surface and its four corner
   facets come out as the triangular pyramidions a pabuc is made of. */
function tmSqRingLerp(cx, cz, h, r, t) {
  var s = tmSqRing(cx, cz, h), o = tmRing(cx, cz, r, 8, 0), i, out = [];
  for (i = 0; i < 8; i++) out.push([lerp(s[i][0], o[i][0], t), lerp(s[i][1], o[i][1], t)]);
  return out;
}

/* tmLoft(pile, cx, cz, ringA, yA, ringB, yB, ao, tone [, nrm])
   One band of faceted quads between two rings of EQUAL length.  Flat-shaded
   (four fresh verts per facet) because an arris that is smoothed away is an
   arris you cannot see, and the twelve arrises of a minaret shaft are how a
   player reads its taper at 90 m.  `nrm`, where given, overrides the facet
   normal; its only user is tmAnnulus, whose facets are flat and whose normal
   cannot come from a radial test. */
function tmLoft(pile, cx, cz, ra, ya, rb, yb, ao, tone, nrm) {
  var n = ra.length, i, j, cum = 0, inv = pile.inv;
  if (!n || rb.length !== n) { warn('tmLoft: ring length mismatch'); return; }
  for (i = 0; i < n; i++) {
    j = (i + 1) % n;
    var ax = ra[i][0], az = ra[i][1], bx = ra[j][0], bz = ra[j][1];
    var cx2 = rb[i][0], cz2 = rb[i][1], dx2 = rb[j][0], dz2 = rb[j][1];
    var ex = bx - ax, ez = bz - az;
    var e = Math.sqrt(ex * ex + ez * ez);
    /* the normal of the winding p0 -> p1 -> p3 */
    var vx = cx2 - ax, vy = yb - ya, vz = cz2 - az;
    var nx = -ez * vy, ny = ez * vx - ex * vz, nz = ex * vy;
    var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(nl > 1e-9)) continue;
    nx /= nl; ny /= nl; nz /= nl;
    var flip = false;
    if (nrm) {
      if (nx * nrm[0] + ny * nrm[1] + nz * nrm[2] < 0) flip = true;
      nx = nrm[0]; ny = nrm[1]; nz = nrm[2];
    } else {
      var mx = (ax + bx + cx2 + dx2) * 0.25 - cx;
      var mz = (az + bz + cz2 + dz2) * 0.25 - cz;
      if (nx * mx + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; flip = true; }
    }
    var u0 = cum * inv, u1 = (cum + e) * inv;
    var b0 = pile.vert(ax, ya, az, nx, ny, nz, u0, ya * inv, ao, tone);
    var b1 = pile.vert(bx, ya, bz, nx, ny, nz, u1, ya * inv, ao, tone);
    var b2 = pile.vert(dx2, yb, dz2, nx, ny, nz, u1, yb * inv, ao, tone);
    var b3 = pile.vert(cx2, yb, cz2, nx, ny, nz, u0, yb * inv, ao, tone);
    /* a ring that closes to a point - the top of the dome, the apex of a
       kulah - collapses one edge of every facet, and emitting the quad whole
       would put a zero-area triangle in the index buffer for each of them.
       Emit the surviving triangle only. */
    var eB = Math.sqrt((dx2 - cx2) * (dx2 - cx2) + (dz2 - cz2) * (dz2 - cz2));
    if (e < 1e-6) {
      if (flip) pile.tri(b0, b3, b2); else pile.tri(b0, b2, b3);
    } else if (eB < 1e-6) {
      if (flip) pile.tri(b0, b2, b1); else pile.tri(b0, b1, b2);
    } else if (flip) {
      pile.tri(b0, b2, b1); pile.tri(b0, b3, b2);
    } else {
      pile.tri(b0, b1, b2); pile.tri(b0, b2, b3);
    }
    cum += e;
  }
}

/* a faceted frustum, optionally cut into `steps` bands.  STEPS MATTER: the
   sky bake is a PER-VERTEX visibility term, so a 54-u shaft emitted as one
   band has exactly two rows of samples up its whole length and no gradient
   at all.  Eight bands on the govde is what puts the canyon darkening on the
   bottom of the shaft, where the eye expects it. */
function tmPrism(pile, cx, cz, y0, y1, r0, r1, seg, rot, steps, ao, tone) {
  steps = steps || 1;
  var k, t0, t1;
  for (k = 0; k < steps; k++) {
    t0 = k / steps; t1 = (k + 1) / steps;
    tmLoft(pile, cx, cz,
           tmRing(cx, cz, lerp(r0, r1, t0), seg, rot), lerp(y0, y1, t0),
           tmRing(cx, cz, lerp(r0, r1, t1), seg, rot), lerp(y0, y1, t1), ao, tone);
  }
}

/* a flat ring between two radii at one height */
function tmAnnulus(pile, cx, cz, y, rIn, rOut, seg, rot, up, ao, tone) {
  tmLoft(pile, cx, cz, tmRing(cx, cz, rIn, seg, rot), y,
         tmRing(cx, cz, rOut, seg, rot), y, ao, tone, [0, up ? 1 : -1, 0]);
}

/* a CHAMFERED ring moulding - the bilezik that hides every joint on a
   minaret and the cornice under every dome.  rIn is buried in whatever the
   collar is wrapped round, so the top and bottom close onto it and there is
   no annulus to draw.  A pure 90-degree arris is the number one tell of a
   prototype and this is the last place the mosque can afford one. */
function tmCollar(pile, cx, cz, y0, y1, rOut, rIn, c, seg, rot, ao, tone) {
  c = Math.min(c, (y1 - y0) * 0.45);
  tmPrism(pile, cx, cz, y0, y0 + c, rIn, rOut, seg, rot, 1, ao, tone);
  tmPrism(pile, cx, cz, y0 + c, y1 - c, rOut, rOut, seg, rot, 1, ao, tone);
  tmPrism(pile, cx, cz, y1 - c, y1, rOut, rIn, seg, rot, 1, ao, tone);
}

/* a flat polygon cap; `up` says which way it looks */
function tmCap(pile, cx, cz, y, r, seg, rot, up, ao, tone) {
  var g = tmRing(cx, cz, r, seg, rot), i, pts = [];
  for (i = 0; i < g.length; i++) pts.push([g[i][0], y, g[i][1]]);
  poly(pile, pts, [cx, y + (up ? -1.5 : 1.5), cz], ao, tone);
}

/* THE TWO-CENTRED ARCH, the only head on this building.
   Each half is an arc struck from a centre ON the springing line, offset by
   d to the far side of the axis:  h^2 = a^2 + 2*a*d  =>  d = (h^2-a^2)/2a,
   R = a + d.  d = 0 degenerates to a semicircle, which is what a drum light
   wants, so one routine draws every opening on the precinct.
   Returns [[u, y, radialU, radialY], ...] left springing -> apex -> right,
   the radial being what the archivolt and the soffit are offset along. */
function tmArchCurve(uc, a, yS, h, k) {
  var out = [], i, th, d, R, phi;
  k = Math.max(3, k || 7);
  if (!(h > 0.05)) h = 0.05;
  d = (h * h - a * a) / (2 * a);
  if (d < 0 && -d > a * 0.98) d = -a * 0.98;
  R = a + d;
  phi = Math.atan2(h, d);
  for (i = 0; i <= k; i++) {
    th = Math.PI - phi * (i / k);
    out.push([uc + d + R * Math.cos(th), yS + R * Math.sin(th),
              Math.cos(th), Math.sin(th)]);
  }
  for (i = 1; i <= k; i++) {
    th = phi * ((k - i) / k);
    out.push([uc - d + R * Math.cos(th), yS + R * Math.sin(th),
              Math.cos(th), Math.sin(th)]);
  }
  return out;
}

/* tmPiercedPanel - a wall with REAL holes in it.
   Everything pierced on this mosque goes through here: the porch arcade
   (open, both faces), the harim's north wall (glazed, one face) and all
   eight drum facets.  Given a plane basis - an origin (bx,bz), a unit
   tangent (ux,uz) and a unit outward normal (nx,nz) - it emits the solid
   between the openings, the spandrel between every pointed head and the top
   of its bay, the jamb / soffit / cill reveals through the wall's thickness
   and, where asked, a dark pane at the back of the reveal.

   `u` is whatever the caller's basis makes it: the x-tangent panels here
   pass bx = 0 and absolute world x, the drum's facets pass the facet's own
   start point and a local 0..length.

   THE OPENINGS MUST BE u-DISJOINT.  Two rows of windows over one another are
   two calls with disjoint y bands, not one call - which is why the harim's
   north wall is built twice, y 1.55..12.0 and y 12.0..31.50.
   -------------------------------------------------------------------- */
function tmPiercedPanel(pile, bx, bz, ux, uz, nx, nz, u0, u1, y0, y1,
                        holes, thick, tone, opts) {
  opts = opts || {};
  var stone = opts.stone || tone, ao = opts.ao === undefined ? 1 : opts.ao;
  var i, hs = (holes || []).slice(0);
  hs.sort(function (a, b) { return a.uc - b.uc; });

  function pt(u, y, d) { return [bx + ux * u + nx * d, y, bz + uz * u + nz * d]; }

  /* a polygon in (u,y) on the outer face, wound outward by a ref point
     driven 1.2 u INTO the masonry.  For a planar face the orientation only
     depends on the ref's component along n, so one rule covers every shape. */
  function outP(p2, aoo, tn) {
    var a = [], su = 0, sy = 0, q;
    for (q = 0; q < p2.length; q++) {
      a.push(pt(p2[q][0], p2[q][1], 0)); su += p2[q][0]; sy += p2[q][1];
    }
    poly(pile, a, pt(su / p2.length, sy / p2.length, -1.2), aoo, tn);
  }
  function inP(p2, aoo, tn) {
    var a = [], su = 0, sy = 0, q;
    for (q = 0; q < p2.length; q++) {
      a.push(pt(p2[q][0], p2[q][1], -thick)); su += p2[q][0]; sy += p2[q][1];
    }
    poly(pile, a, pt(su / p2.length, sy / p2.length, -thick + 1.2), aoo, tn);
  }
  /* a rectangle, SUBDIVIDED at 5 u.  Two reasons, both measurable: the bake
     is per-vertex, so a 30-u panel with four corners has no gradient; and
     groundTone's 420 mm splash band spreads over the whole panel unless
     there are vertices near its foot. */
  function rect(ua, ub, ya, yb, aoo, tn) {
    if (!(ub - ua > 0.01) || !(yb - ya > 0.01)) return;
    var nb = Math.max(1, Math.min(8, Math.ceil((yb - ya) / 5.0))), b, qa, qb;
    for (b = 0; b < nb; b++) {
      qa = lerp(ya, yb, b / nb); qb = lerp(ya, yb, (b + 1) / nb);
      outP([[ua, qa], [ub, qa], [ub, qb], [ua, qb]], aoo, tn);
      if (opts.both) inP([[ua, qa], [ub, qa], [ub, qb], [ua, qb]], aoo, tn);
    }
  }

  /* 1. the solid between the openings, full height */
  var cur = u0;
  for (i = 0; i < hs.length; i++) {
    rect(cur, hs[i].uc - hs[i].half, y0, y1, ao, tone);
    cur = hs[i].uc + hs[i].half;
  }
  rect(cur, u1, y0, y1, ao, tone);

  /* 2. per opening: cill band, head band, spandrels, reveals, pane */
  for (i = 0; i < hs.length; i++) {
    var H = hs[i], ua = H.uc - H.half, ub = H.uc + H.half, s;
    var cv = tmArchCurve(H.uc, H.half, H.spring, H.apex - H.spring, 7);
    rect(ua, ub, y0, H.sill, ao, tone);
    rect(ua, ub, H.apex, y1, ao, tone);
    for (s = 0; s < cv.length - 1; s++) {
      var sp = [[cv[s][0], cv[s][1]], [cv[s + 1][0], cv[s + 1][1]],
                [cv[s + 1][0], H.apex], [cv[s][0], H.apex]];
      outP(sp, ao, tone);
      if (opts.both) inP(sp, ao, tone);
    }
    /* the jambs look INTO the opening, so their ref goes sideways into the
       pier.  0.62 is the kit's shadow-gap ao. */
    poly(pile, [pt(ua, H.sill, 0), pt(ua, H.spring, 0),
                pt(ua, H.spring, -thick), pt(ua, H.sill, -thick)],
         pt(ua - 1.2, (H.sill + H.spring) * 0.5, -thick * 0.5), 0.62, stone);
    poly(pile, [pt(ub, H.sill, 0), pt(ub, H.spring, 0),
                pt(ub, H.spring, -thick), pt(ub, H.sill, -thick)],
         pt(ub + 1.2, (H.sill + H.spring) * 0.5, -thick * 0.5), 0.62, stone);
    /* the arch soffit, one strip per curve segment, its ref pushed radially
       outward because that is the side the masonry is on */
    for (s = 0; s < cv.length - 1; s++) {
      var mu = (cv[s][0] + cv[s + 1][0]) * 0.5, my = (cv[s][1] + cv[s + 1][1]) * 0.5;
      var ru = (cv[s][2] + cv[s + 1][2]) * 0.5, ry = (cv[s][3] + cv[s + 1][3]) * 0.5;
      poly(pile, [pt(cv[s][0], cv[s][1], 0), pt(cv[s + 1][0], cv[s + 1][1], 0),
                  pt(cv[s + 1][0], cv[s + 1][1], -thick), pt(cv[s][0], cv[s][1], -thick)],
           pt(mu + ru * 1.2, my + ry * 1.2, -thick * 0.5), 0.58, stone);
    }
    /* the cill, looking up, in upTone or it clips past 245 sRGB */
    poly(pile, [pt(ua, H.sill, 0), pt(ub, H.sill, 0),
                pt(ub, H.sill, -thick), pt(ua, H.sill, -thick)],
         pt(H.uc, H.sill - 1.2, -thick * 0.5), 1, upTone(stone));
    /* the pane: one CONVEX polygon - the cill line, then the intrados
       backwards.  A rectangle under a two-centred head is convex, and poly
       fans from vertex 0, so this is the one shape that may be drawn whole */
    if (opts.pane) {
      var pp = [], dep = -thick + 0.10, q2;
      pp.push(pt(ua, H.sill, dep)); pp.push(pt(ub, H.sill, dep));
      for (q2 = cv.length - 1; q2 >= 0; q2--) pp.push(pt(cv[q2][0], cv[q2][1], dep));
      poly(opts.paneP || P.glass, pp, pt(H.uc, H.spring, dep - 1.2), 1, opts.pane);
      STATS.windows++;
    } else {
      STATS.openings++;
    }
  }
}

/* an archivolt: a free-standing pointed arch ring extruded between two
   z-planes, used where there is no wall to pierce - the porch arcade and the
   minaret doors.  Four faces per voussoir, and the ref is the mid-section of
   the ring, which is inside the solid, so all four wind outward without
   anybody tracking orientation. */
function tmArchRing(pile, xc, yS, a, h, zA, zB, t, tone) {
  var cv = tmArchCurve(xc, a, yS, h, 8), i, zM = (zA + zB) * 0.5;
  for (i = 0; i < cv.length - 1; i++) {
    var p0 = cv[i], p1 = cv[i + 1];
    var i0 = [p0[0], p0[1]], i1 = [p1[0], p1[1]];
    var o0 = [p0[0] + p0[2] * t, p0[1] + p0[3] * t];
    var o1 = [p1[0] + p1[2] * t, p1[1] + p1[3] * t];
    var rf = [(i0[0] + o0[0] + i1[0] + o1[0]) * 0.25,
              (i0[1] + o0[1] + i1[1] + o1[1]) * 0.25, zM];
    poly(pile, [[i0[0], i0[1], zA], [o0[0], o0[1], zA],
                [o1[0], o1[1], zA], [i1[0], i1[1], zA]], rf, 1, tone);
    poly(pile, [[i0[0], i0[1], zB], [o0[0], o0[1], zB],
                [o1[0], o1[1], zB], [i1[0], i1[1], zB]], rf, 1, tone);
    poly(pile, [[i0[0], i0[1], zA], [i1[0], i1[1], zA],
                [i1[0], i1[1], zB], [i0[0], i0[1], zB]], rf, 0.58, tone);
    poly(pile, [[o0[0], o0[1], zA], [o1[0], o1[1], zA],
                [o1[0], o1[1], zB], [o0[0], o0[1], zB]], rf, 1, tone);
  }
}

/* a lean-to roof slab with a real thickness, so it has a soffit and four
   arrises instead of being a sheet of paper.  axis 'z' slopes along z and
   spans x from a0 to a1; axis 'x' slopes along x and spans z.  Subdivided
   four ways up the slope for the same per-vertex-bake reason as tmPrism, and
   every face gets its OWN ref - a single slab-centre ref lands on the wrong
   side of the top face near the eave and flips it. */
function tmLeanTo(pile, a0, a1, sA, yA, sB, yB, th, ao, tone, axis) {
  var n = 4, i;
  function P4(a, s, y) { return axis === 'x' ? [s, y, a] : [a, y, s]; }
  function quad(p, dx, dy, dz, aoo) {
    var c = [(p[0][0] + p[1][0] + p[2][0] + p[3][0]) * 0.25,
             (p[0][1] + p[1][1] + p[2][1] + p[3][1]) * 0.25,
             (p[0][2] + p[1][2] + p[2][2] + p[3][2]) * 0.25];
    poly(pile, p, [c[0] + dx, c[1] + dy, c[2] + dz], aoo, tone);
  }
  /* unit steps in a and s expressed in xyz, SIGNED by which way each runs:
     the east aisle is emitted with sA > sB (its eave is at x 605.6 and its
     ridge at 586.5), and an unsigned step would push that verge's reference
     point to the wrong side and turn the quad inside out. */
  var sgA = a1 >= a0 ? 1 : -1, sgS = sB >= sA ? 1 : -1;
  var da = P4(sgA, 0, 0), ds = P4(0, sgS, 0);
  for (i = 0; i < n; i++) {
    var t0 = i / n, t1 = (i + 1) / n;
    var s0 = lerp(sA, sB, t0), s1 = lerp(sA, sB, t1);
    var q0 = lerp(yA, yB, t0), q1 = lerp(yA, yB, t1);
    quad([P4(a0, s0, q0), P4(a1, s0, q0), P4(a1, s1, q1), P4(a0, s1, q1)],
         0, -2, 0, ao);
    quad([P4(a0, s0, q0 - th), P4(a1, s0, q0 - th),
          P4(a1, s1, q1 - th), P4(a0, s1, q1 - th)], 0, 2, 0, 0.48);
    quad([P4(a0, s0, q0), P4(a0, s1, q1), P4(a0, s1, q1 - th), P4(a0, s0, q0 - th)],
         da[0] * 2, da[1] * 2, da[2] * 2, 0.90);
    quad([P4(a1, s0, q0), P4(a1, s1, q1), P4(a1, s1, q1 - th), P4(a1, s0, q0 - th)],
         -da[0] * 2, -da[1] * 2, -da[2] * 2, 0.90);
  }
  quad([P4(a0, sA, yA), P4(a1, sA, yA), P4(a1, sA, yA - th), P4(a0, sA, yA - th)],
       ds[0] * 2, ds[1] * 2, ds[2] * 2, 0.90);
  quad([P4(a0, sB, yB), P4(a1, sB, yB), P4(a1, sB, yB - th), P4(a0, sB, yB - th)],
       -ds[0] * 2, -ds[1] * 2, -ds[2] * 2, 0.90);
}

/* the section's occluder budget.  nz-street-sky.js:1583 silently discards any
   box over REG_MAX = 26 on an axis and the kit caps the whole module at 45;
   sections 6, 7 and 8 take fourteen, twelve and ten, and section 10's
   barricades and gate block stand closer to the player than anything here
   does - so this section takes SIX and stops, leaving the cordon four.  Two
   per minaret and two under the avlu wall; the porch and the harim get none,
   because they are read through a seven-unit slot between two kup and a
   contact shadow in there is worth less than one under a barricade.
   Every box below sits UNDER or INSIDE the thing it belongs to and never
   around it: hitsBoxT exempts only a ray origin STRICTLY inside a box, so a
   vertex exactly on a boundary is fully blocked - which is how
   nz-street-park's first render came back with both shelter roofs as solid
   black slabs. */
function tmOcc(x0, y0, z0, x1, y1, z1) {
  if (tmOcc.n === undefined) tmOcc.n = 0;
  if (tmOcc.n >= 6) return;
  if (Math.abs(x1 - x0) > 26 || Math.abs(y1 - y0) > 26 || Math.abs(z1 - z0) > 26) {
    warn('terminus occluder over 26 u dropped'); return;
  }
  occ(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
      Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
  tmOcc.n++;
}

/* the precinct palette.  Warm, because the overcast probe is blue by
   construction and a neutral limewash lands blue once the sky has had its
   say.  LEAD is the one cold entry on the whole street and it is meant to be
   - it is the only surface up here that is not earth or plaster. */
function tmPal() {
  return {
    wash: mix(C.white, C.stone, 0.22),      /* limewashed render           */
    cut:  mix(C.stone, C.white, 0.38),      /* dressed kufeki stone        */
    trim: mix(C.stone, C.dark, 0.16),       /* mouldings, copings, collars */
    lead: mix(C.steel, C.dark, 0.45),       /* dome, kulah, flashings      */
    tile: C.roof,
    dark: mix(C.glass, C.dark, 0.58),       /* a window with a room behind */
    iron: mix(C.dark, C.steel, 0.22)
  };
}

/* a mosque door: a dark leaf 0.05 proud of its wall (never ON it - a leaf on
   the wall plane is a coplanar pair) inside a proud archivolt and two jambs.
   Used on both minaret kup, where the kup is a solid chamfered box and there
   is nothing to pierce. */
function tmDoorZ(xc, zFace, fdir, sill, spring, apex, half, pal) {
  var cv = tmArchCurve(xc, half, spring, apex - spring, 6), pp = [], q;
  var zL = zFace + fdir * 0.05, zA = zFace + fdir * 0.05, zB = zFace + fdir * 0.46;
  pp.push([xc - half, sill, zL]); pp.push([xc + half, sill, zL]);
  for (q = cv.length - 1; q >= 0; q--) pp.push([cv[q][0], cv[q][1], zL]);
  poly(P.metal, pp, [xc, spring, zFace - fdir * 1.2], 0.72, mix(pal.iron, C.dark, 0.30));
  tmArchRing(P.stone, xc, spring, half, apex - spring, zA, zB, 0.72, pal.cut);
  box6(P.stone, xc - half - 0.72, xc - half, sill, spring,
       Math.min(zA, zB), Math.max(zA, zB), 1, pal.cut);
  box6(P.stone, xc + half, xc + half + 0.72, sill, spring,
       Math.min(zA, zB), Math.max(zA, zB), 1, pal.cut);
  STATS.openings++;
}


/* -----------------------------------------------------------------------
   9.1  THE MINARET

   1:14.8.  A real neighbourhood minaret runs 1:12 to 1:16; the one this
   replaces ran 1:28 with no taper, which is why it read as a flagpole in a
   hat.  The stack, all of it from the site plan:

     kup      square base   x,z +-7.70          y   0.00.. 15.75
     pabuc    square -> 8-gon frustum           y  15.75.. 25.20
     govde    12-gon, r 4.60 -> 3.95 TAPERED    y  25.20.. 79.00
     serefe   corbel r 3.95 -> 6.20             y  79.00.. 82.50
              floor r 6.60                      y  82.50.. 83.60
              balustrade r 6.50, 16 balusters   y  83.60.. 87.10
              coping r 6.75                     y  87.10.. 87.80
     petek    12-gon r 3.40 - NARROWER          y  83.60..105.00
     kulah    eave ring r 4.20                  y 105.00..106.40
              lead cone r 4.20 -> apex, CAPPED  y 106.40..127.75
     alem     shaft r 0.28 + crescent card      y 127.75..136.60

   The two are IDENTICAL and symmetric about the street's centreline x = 564,
   standing IN the corridor at z = 316 so they are dead ahead down the whole
   arm.  At x 516/616 - where they were - the ray from a standing eye to a
   39 m shaft 70 u away passes through the neighbour's roof for fifteen units
   before it clears, which is why they were never in frame.
   -------------------------------------------------------------------- */
function minaret(x, z, fdir, pal) {
  var i, a, k, t0, t1, seg = 12, rot = Math.PI / 12;   /* rot puts a FACE and
                                                          not an arris on the
                                                          street axis */
  var st = P.stone;

  /* ---- kup.  Three courses, all chamfered: a base plinth, the die, and a
     moulded cap the pabuc springs off.  0.30 of chamfer is 86 mm, which is
     the arris a mason actually cuts. */
  boxC(st, x, 1.05, z, 8.15, 1.05, 8.15, 0.34, 1, groundTone(pal.cut, 0, 2.6));
  boxC(st, x, 8.15, z, 7.70, 6.05, 7.70, 0.30, 1, groundTone(pal.wash, 0, 2.6));
  boxC(st, x, 14.975, z, 8.05, 0.775, 8.05, 0.26, 1, upTone(pal.trim));
  tmDoorZ(x, z + fdir * 7.70, fdir, 2.10, 7.60, 10.90, 2.05, pal);

  /* ---- pabuc.  The square's eight-point outline lofted into a regular
     octagon; the four corner facets come out as the pyramidions.  Three
     bands so the transition has vertices for the bake to work with. */
  for (k = 0; k < 3; k++) {
    t0 = k / 3; t1 = (k + 1) / 3;
    tmLoft(st, x, z, tmSqRingLerp(x, z, 7.70, 4.60, t0), lerp(15.75, 25.20, t0),
           tmSqRingLerp(x, z, 7.70, 4.60, t1), lerp(15.75, 25.20, t1), 1, pal.wash);
  }
  /* the bilezik that hides the 8-gon / 12-gon joint.  Every real minaret
     carries one here and it is the cheapest way to make two different
     polygon counts meet without a crack: rIn 4.05 is inside both inradii
     (the octagon's is 4.25, the twelve-gon's 4.44) so it is never seen. */
  tmCollar(st, x, z, 24.55, 25.85, 4.98, 4.05, 0.30, seg, rot, 1, pal.trim);

  /* ---- govde, eight bands */
  tmPrism(st, x, z, 25.20, 79.00, 4.60, 3.95, seg, rot, 8, 1, pal.wash);
  tmCollar(st, x, z, 51.20, 52.30, 4.42, 3.80, 0.26, seg, rot, 1, pal.trim);
  tmCollar(st, x, z, 76.40, 77.30, 4.30, 3.70, 0.24, seg, rot, 1, pal.trim);

  /* ---- serefe corbel.  Four STEPPED rings, not a smooth cone: corbelling
     under a balcony is a stack of oversailing courses and the shadow line
     between them is the whole read. */
  var cr = [3.95, 4.42, 5.02, 5.62, 6.20], cy = [79.00, 79.90, 80.80, 81.70, 82.50];
  for (k = 0; k < 4; k++) {
    tmPrism(st, x, z, cy[k], cy[k + 1] - 0.22, cr[k], cr[k + 1] - 0.10, seg, rot, 1, 1, pal.cut);
    tmPrism(st, x, z, cy[k + 1] - 0.22, cy[k + 1], cr[k + 1] - 0.10, cr[k + 1], seg, rot, 1, 1, pal.cut);
    tmAnnulus(st, x, z, cy[k + 1], cr[k + 1] - 0.10, cr[k + 1], seg, rot, false, 0.55, pal.cut);
  }
  /* one tier of mukarnas cells under the floor - twelve little corbels, the
     detail that says stonemason and not lathe */
  for (i = 0; i < seg; i++) {
    a = rot + (i + 0.5) / seg * Math.PI * 2;
    tmPrism(st, x + Math.cos(a) * 5.85, z + Math.sin(a) * 5.85, 81.20, 82.50,
            0.34, 0.62, 4, a, 1, 0.72, pal.cut);
  }

  /* ---- serefe floor, balustrade plinth, balusters, handrail, coping.  The
     balustrade is PIERCED - sixteen balusters with sky between them - which
     is the single biggest thing missing from the shafts this replaces. */
  tmPrism(st, x, z, 82.50, 82.80, 6.30, 6.60, 16, 0, 1, 0.80, pal.cut);
  tmPrism(st, x, z, 82.80, 83.35, 6.60, 6.60, 16, 0, 1, 1, pal.cut);
  tmPrism(st, x, z, 83.35, 83.60, 6.60, 6.50, 16, 0, 1, 1, pal.cut);
  tmAnnulus(st, x, z, 83.60, 3.40, 6.50, 16, 0, true, 1, upTone(pal.cut));
  tmPrism(st, x, z, 83.60, 84.30, 6.50, 6.50, 16, 0, 1, 1, pal.cut);
  for (i = 0; i < 16; i++) {
    a = i / 16 * Math.PI * 2 + Math.PI / 16;
    tmPrism(st, x + Math.cos(a) * 6.30, z + Math.sin(a) * 6.30, 84.30, 86.40,
            0.40, 0.34, 4, a, 1, 1, pal.cut);
  }
  tmCollar(st, x, z, 86.40, 87.10, 6.62, 6.05, 0.20, 16, 0, 1, pal.cut);
  tmCollar(st, x, z, 87.10, 87.80, 6.75, 6.10, 0.24, 16, 0, 1, upTone(pal.trim));

  /* ---- petek.  It NARROWS - r 3.40 against the shaft's 3.95 - which is
     what makes a balcony read as a balcony.  The build this replaces put a
     3.30-radius tube ABOVE a 2.35 shaft, so its serefe was a bulge.  Twelve
     arris colonnettes give it the fluting a petek has. */
  tmCollar(st, x, z, 83.60, 84.90, 3.80, 3.20, 0.28, seg, rot, 1, pal.trim);
  tmPrism(st, x, z, 84.90, 103.20, 3.40, 3.40, seg, rot, 3, 1, pal.wash);
  for (i = 0; i < seg; i++) {
    a = rot + i / seg * Math.PI * 2;
    tube(st, [x + Math.cos(a) * 3.40, 84.90, z + Math.sin(a) * 3.40],
         [x + Math.cos(a) * 3.40, 103.20, z + Math.sin(a) * 3.40],
         0.30, 5, pal.cut, false, false);
  }
  tmCollar(st, x, z, 103.20, 105.00, 3.92, 3.25, 0.30, seg, rot, 1, pal.trim);

  /* ---- kulah.  Lead, on P.render.  Five bands with a slight ogee (t^1.12),
     a real BASE CAP - a player on this street looks UP into a minaret cap,
     and every cone in the build this replaces was an open shell - and a
     standing seam up all twelve arrises, because a seam is what a lead cone
     is made of and it is what carries the silhouette at 90 m. */
  tmCollar(P.render, x, z, 105.00, 106.40, 4.20, 3.40, 0.34, seg, rot, 1, upTone(pal.lead));
  tmCap(P.render, x, z, 106.40, 4.20, seg, rot, false, 0.60, pal.lead);
  var kn = 5, ky0 = 106.40, ky1 = 127.75, kr = 4.20, ra, rb, ya, yb;
  for (k = 0; k < kn; k++) {
    t0 = k / kn; t1 = (k + 1) / kn;
    ra = kr * Math.pow(1 - t0, 1.12); rb = kr * Math.pow(1 - t1, 1.12);
    ya = lerp(ky0, ky1, t0); yb = lerp(ky0, ky1, t1);
    tmLoft(P.render, x, z, tmRing(x, z, ra, seg, rot), ya,
           tmRing(x, z, rb, seg, rot), yb, 1, pal.lead);
    for (i = 0; i < seg; i++) {
      a = rot + i / seg * Math.PI * 2;
      tube(P.render, [x + Math.cos(a) * ra, ya, z + Math.sin(a) * ra],
           [x + Math.cos(a) * rb, yb, z + Math.sin(a) * rb], 0.26, 4,
           pal.lead, false, false);
    }
  }

  /* ---- alem.  Real metal this time, and the crescent is drawn TWICE
     because M.sign is FrontSide by contract - one card faces up the street,
     the other back down it. */
  tube(P.metal, [x, 127.75, z], [x, 133.40, z], 0.28, 6, C.gold, true, false);
  tube(P.metal, [x, 129.10, z], [x, 129.90, z], 0.52, 6, C.gold, true, false);
  signCard(P.sign, 'alem', x, 135.00, z, 1, 0, 0, 0, 1, 0, 3.20, C.gold, [0, 0, fdir]);
  signCard(P.sign, 'alem', x, 135.00, z, 1, 0, 0, 0, 1, 0, 3.20, C.gold, [0, 0, -fdir]);

  /* Two occluders, both INSET from their own surfaces.  The first is the
     kup's mass, which is what puts the base of a 39 m tower on the ground.
     The second lives inside the serefe floor slab: 4.00 of half-width, well
     inside the 6.098 that even the nearest floor vertex reaches, and 0.10
     clear of the corbel below and the petek above - so it darkens the corbel
     and the head of the shaft without containing a single vertex of either.
     A box around the corbel instead would contain the shaft's own surface
     and bake the whole tower black. */
  tmOcc(x - 7.40, 0.30, z - 7.40, x + 7.40, 15.40, z + 7.40);
  tmOcc(x - 4.00, 82.60, z - 4.00, x + 4.00, 83.50, z + 4.00);
  STATS.minarets++;
}


/* Translate exactly the vertices and occluders emitted by one mosque call.
   Keeping the translation outside mosque() preserves all of its internal
   symmetry and arch/minaret dimensions while putting that assembly on the
   surveyed parcel instead of re-authoring a second, subtly different mosque. */
function shiftedMosque(frontZ, away, dx) {
  var marks = [], key, i, j, startOcc = OCC.length;
  for (key in P) if (Object.prototype.hasOwnProperty.call(P, key) &&
      P[key] && P[key].p && typeof P[key].p.length === 'number')
    marks.push({ pile: P[key], start: P[key].p.length });

  mosque(frontZ, away);

  for (i = 0; i < marks.length; i++)
    for (j = marks[i].start; j < marks[i].pile.p.length; j += 3)
      marks[i].pile.p[j] += dx;
  for (i = startOcc; i < OCC.length; i++) {
    OCC[i].x0 += dx; OCC[i].x1 += dx;
  }
}

/* -----------------------------------------------------------------------
   9.2  ADIL CAMII

   mosque(frontZ, away).  Every number is a DEPTH from frontZ.  The live site
   uses away=1 (its entrance faces back toward the roundabout) and
   shiftedMosque moves the complete assembly 176 u / 50.3 m west.

   Front to back: a boundary wall with an open gate and two minarets standing
   in front of it IN the street; a shallow forecourt; a five-arched son
   cemaat yeri under a pantile lean-to; the harim with its portal and its
   pointed lights; two aisle lean-tos; and over all of it the octagonal drum
   and the dome, which is now the TOP of the composition instead of a bubble
   caught in a hip roof.
   -------------------------------------------------------------------- */
function mosque(frontZ, away) {
  var pal = tmPal(), i, k, a;
  var st = P.stone, rn = P.render, rf = P.roof;
  function Z(d) { return frontZ + away * d; }
  var fdir = -away;                 /* the direction the precinct faces */

  var AX = 566.0;                   /* the mosque's own axis.  The street's
                                       is 564; the 2 u offset is in the site
                                       plan and it is deliberate. */
  var PODIUM = 1.55, AVLU = 0.62;

  /* ---- 9.2.1  the precinct ground.  On the live south plot this assembly is
     shifted to x 304..484, flush against the widened street's west footway.
     The courtyard remains at footway height and steps up into the avlu. */
  var gt = upTone(mix(C.paver, C.stone, 0.30));
  deck(P.paver, 480, Z(-41), 548, Z(50), 0.62, 0.36, 1, gt);
  deck(P.paver, 580, Z(-41), 660, Z(50), 0.62, 0.36, 1, gt);
  deck(P.paver, 548, Z(-20), 580, Z(50), 0.62, 0.40, 1, gt);

  /* ---- 9.2.2  the avlu wall, x 508..624 on z 322..323.4, y 0..7.35, with
     the gate opening at x 556..572.  The two minarets stand just in front of
     it and their kup are what the lintel is built into. */
  var wz0 = Z(-20), wz1 = Z(-18.6), wzc = (wz0 + wz1) * 0.5;
  var wzA = Math.min(wz0, wz1), wzB = Math.max(wz0, wz1);
  var wallT = mix(pal.wash, pal.cut, 0.35);
  function avluRun(xa, xb) {
    if (!(xb - xa > 0.05)) return;
    box6(rn, xa, xb, AVLU, 6.60, wzA + 0.10, wzB - 0.10, 1,
         groundTone(wallT, AVLU, 1.47));
    boxC(st, (xa + xb) * 0.5, 6.975, wzc, (xb - xa) * 0.5 + 0.22, 0.375, 0.94,
         0.20, 1, upTone(pal.trim));
    boxC(st, (xa + xb) * 0.5, AVLU + 0.55, wzc, (xb - xa) * 0.5 + 0.18, 0.55,
         0.90, 0.16, 1, groundTone(pal.cut, AVLU, 1.05));
  }
  avluRun(508.0, 556.0);
  avluRun(572.0, 624.0);

  /* the gate lintel, spanning 553..575 so that both of its ends are built
     into a kup, with the mosque's name board on its face.  The board is
     sized to the slot the player actually reads it through: the two kup are
     15.4 u square at 22 u centres, and from the middle of the arm that
     leaves about 7 u of daylight at the lintel plane. */
  var lintF = wzc + fdir * 1.05;
  boxC(st, 564.0, 8.85, wzc, 11.0, 0.95, 1.05, 0.22, 1, upTone(pal.cut));
  var ss = signSize('camii', 1);
  if (ss && ss.w > 0.01) {
    signCard(P.sign, 'camii', 564.0, 8.80, lintF + fdir * 0.07,
             1, 0, 0, 0, 1, 0, 6.40 / ss.w, C.white, [0, 0, fdir]);
  }

  /* the gate leaves, swung INWARD and standing open, because an open gate is
     eight units of visible courtyard and a closed one is a flat panel.
     Wrought iron: a frame, nine bars and a spear head every other bar. */
  for (k = 0; k < 2; k++) {
    var hx = k ? 572.0 : 556.0, sg = k ? -1 : 1;
    var dxu = sg * 0.342, dzu = 0.940 * away;      /* swung back 70 degrees */
    var hz = wzc + away * 0.90, len = 7.0, tq;
    for (i = 0; i <= 8; i++) {
      tq = i / 8 * len;
      tube(P.metal, [hx + dxu * tq, AVLU, hz + dzu * tq],
           [hx + dxu * tq, AVLU + 6.10, hz + dzu * tq], 0.15, 5, pal.iron, false, false);
      if (i % 2 === 0) {
        tube(P.metal, [hx + dxu * tq, AVLU + 6.10, hz + dzu * tq],
             [hx + dxu * tq, AVLU + 6.85, hz + dzu * tq], 0.09, 4, pal.iron, true, false);
      }
    }
    tube(P.metal, [hx, AVLU + 0.40, hz], [hx + dxu * len, AVLU + 0.40, hz + dzu * len],
         0.17, 5, pal.iron, true, false);
    tube(P.metal, [hx, AVLU + 5.90, hz], [hx + dxu * len, AVLU + 5.90, hz + dzu * len],
         0.17, 5, pal.iron, true, false);
  }

  /* two occluders under the wall coping, in 26-u slices because anything
     larger is silently discarded.  They sit INSIDE the wall - 0.25 in from
     both of its faces - so no vertex of the wall is on their boundary, and
     what they darken is the ground at its foot and the bottom of the
     render, which is where a wall's contact shadow belongs. */
  tmOcc(512, 4.00, wzA + 0.25, 536, 6.80, wzB - 0.25);
  tmOcc(596, 4.00, wzA + 0.25, 620, 6.80, wzB - 0.25);

  /* ---- 9.2.3  the podium, two 13 cm risers up out of the avlu.  Chamfered
     nosings in upTone, or a precast nosing toned near-white clips past 245
     sRGB the moment the dome hands it a 2.00 from the overcast dome. */
  deck(P.stone, 526, Z(-14), 606, Z(46), PODIUM, 0.90, 1, upTone(pal.cut));
  for (k = 0; k < 2; k++) {
    var stTop = AVLU + (k + 1) * 0.465;
    boxC(st, AX, (AVLU + stTop) * 0.5, Z(-14) - away * (1.5 - k * 0.75), 21.0,
         (stTop - AVLU) * 0.5, 0.75, 0.12, 1, upTone(pal.cut));
  }

  /* ---- 9.2.4  son cemaat yeri: FIVE POINTED ARCHES on six supports.
     The site plan's five column x-values give FOUR intercolumniations over a
     64-u porch, which is four arches and not the five it asks for; six
     supports at 11.92-u centres (3.4 m, a real neighbourhood
     intercolumniation) over the same x 534..598 give the five, stay
     symmetric about the mosque's own axis, and put the middle arch dead on
     566.  That is the one place this section departs from the plan's
     numbers, and it departs to obey the plan's sentence.

     The arcade is a 0.90-thick PIERCED PANEL whose openings are cut to
     10.32 u, leaving a 1.60-u pier - NARROWER than the 2.10-u column that
     stands in front of it, so the column is what you see and the panel is
     only what carries the arch. */
  var pz0 = Z(-12), pz1 = Z(-2), pzF = Z(-11.55), pT = 0.90;
  var colX = [], nb = 5, cs = 11.92;
  for (i = 0; i < 6; i++) colX.push(536.20 + i * cs);
  var holes = [];
  for (i = 0; i < nb; i++) {
    holes.push({ uc: (colX[i] + colX[i + 1]) * 0.5, half: (cs - 1.60) * 0.5,
                 sill: PODIUM, spring: 12.60, apex: 18.90 });
  }
  tmPiercedPanel(rn, 0, pzF - away * pT * 0.5, 1, 0, 0, fdir, 534.0, 598.0,
                 PODIUM, 22.40, holes, pT, groundTone(pal.wash, PODIUM, 1.47),
                 { both: true, stone: pal.cut });
  for (i = 0; i < nb; i++) {
    tmArchRing(st, holes[i].uc, 12.60, holes[i].half, 6.30,
               pzF - away * (pT * 0.5 + 0.34), pzF - away * pT * 0.5, 0.85, pal.cut);
  }
  /* the columns: pedestal, base, shaft with EXPLICIT cylindrical uv because
     r 1.05 is over the kit's 0.6 threshold, and a baklava capital wider than
     the pier so that the arch has something to spring off */
  for (i = 0; i < 6; i++) {
    var cxx = colX[i];
    boxC(st, cxx, PODIUM + 0.45, pzF, 1.62, 0.45, 1.62, 0.14, 1, upTone(pal.cut));
    tmPrism(st, cxx, pzF, PODIUM + 0.90, PODIUM + 1.70, 1.46, 1.05, 12, 0, 1, 1, pal.cut);
    tube(st, [cxx, PODIUM + 1.70, pzF], [cxx, 11.20, pzF], 1.05, 12, pal.cut, false, true);
    tmPrism(st, cxx, pzF, 11.20, 12.10, 1.05, 1.42, 12, 0, 1, 1, pal.cut);
    boxC(st, cxx, 12.35, pzF, 1.52, 0.25, 1.52, 0.10, 1, upTone(pal.trim));
  }
  /* the porch roof: a lean-to from the arcade eave up to the harim wall,
     with a timber fascia under its low edge */
  tmLeanTo(rf, 532.0, 600.0, pz0 - away * 2.0, 22.40, pz1, 26.00, 0.95, 1,
           upTone(pal.tile), 'z');
  boxC(st, AX, 21.90, pz0 - away * 2.30, 34.0, 0.55, 0.32, 0.12, 1,
       mix(C.timber, C.dark, 0.24));
  /* NO occluder under the porch roof, and none on the harim or the dome.
     The porch is read through a seven-unit slot between the two kup, the
     module's shared budget is 45 boxes for five street modules, and the four
     the minarets take are worth more than anything back here.  The dome is
     excluded on principle besides: the analytic canyon test already accounts
     for a mass that size and replaying it darkens the precinct twice. */

  /* ---- 9.2.5  the harim.  x 528..604, z 340..384, walls to 31.50.
     The north wall is built in TWO y-bands, because tmPiercedPanel needs its
     openings u-disjoint and this wall carries two rows.  Band A is the
     portal and its two flanking lights - the only part a player ever sees,
     through the arcade; band B is the four upper lights the plan asks for,
     read obliquely through the arch heads. */
  var hz0 = Z(-2), hz1 = Z(42), hT = 2.40;
  var hzA = Math.min(hz0, hz1), hzB = Math.max(hz0, hz1);
  var wallTone = groundTone(pal.wash, PODIUM, 1.47);
  tmPiercedPanel(rn, 0, hz0, 1, 0, 0, fdir, 528.0, 604.0, PODIUM, 12.0,
                 [{ uc: 546.0, half: 2.60, sill: 4.40, spring: 8.60, apex: 11.20 },
                  { uc: AX, half: 4.00, sill: PODIUM, spring: 7.60, apex: 11.40 },
                  { uc: 586.0, half: 2.60, sill: 4.40, spring: 8.60, apex: 11.20 }],
                 hT, wallTone, { stone: pal.cut, pane: pal.dark });
  tmPiercedPanel(rn, 0, hz0, 1, 0, 0, fdir, 528.0, 604.0, 12.0, 31.50,
                 [{ uc: 540.0, half: 3.00, sill: 13.0, spring: 19.0, apex: 23.0 },
                  { uc: 552.0, half: 3.00, sill: 13.0, spring: 19.0, apex: 23.0 },
                  { uc: 580.0, half: 3.00, sill: 13.0, spring: 19.0, apex: 23.0 },
                  { uc: 592.0, half: 3.00, sill: 13.0, spring: 19.0, apex: 23.0 }],
                 hT, wallTone, { stone: pal.cut, pane: pal.dark });
  /* the tackapi: a proud rectangular frame round the portal, which is what
     makes a door on a mosque a portal instead of a hole */
  boxC(st, AX, (PODIUM + 19.0) * 0.5, hz0 - away * 0.55, 8.20,
       (19.0 - PODIUM) * 0.5, 0.55, 0.22, 1, pal.cut);
  boxC(st, AX, PODIUM + 0.9, hz0 - away * 0.95, 8.90, 0.9, 0.95, 0.20, 1,
       upTone(pal.cut));

  /* the other three walls, plain: they are seen from the north at a shallow
     angle and nothing on them would read.  The two side walls start BEHIND
     the north panel's inner face, or their end quads land on z = 340 in the
     same plane as it. */
  box6(rn, 528.0, 604.0, PODIUM, 31.50, Math.min(hz1 - away * hT, hz1),
       Math.max(hz1 - away * hT, hz1), 1, wallTone);
  box6(rn, 528.0, 530.4, PODIUM, 31.50, Math.min(hz0 + away * hT, hz1 - away * hT),
       Math.max(hz0 + away * hT, hz1 - away * hT), 1, wallTone);
  box6(rn, 601.6, 604.0, PODIUM, 31.50, Math.min(hz0 + away * hT, hz1 - away * hT),
       Math.max(hz0 + away * hT, hz1 - away * hT), 1, wallTone);
  boxC(st, AX, PODIUM + 1.60, (hz0 + hz1) * 0.5, 38.35, 1.60,
       (hzB - hzA) * 0.5 + 0.35, 0.22, 1, groundTone(pal.cut, PODIUM, 1.47));
  boxC(st, AX, 31.00, (hz0 + hz1) * 0.5, 38.60, 0.50,
       (hzB - hzA) * 0.5 + 0.60, 0.20, 1, pal.trim);

  /* ---- 9.2.6  the side aisles: lean-tos from the outer walls up to the
     drum, and the raking triangles that close them at each end */
  for (k = 0; k < 2; k++) {
    var ox = k ? 604.0 : 528.0, ix = k ? 586.5 : 546.5;
    tmLeanTo(rf, hzA - 1.6, hzB + 1.6, ox + (k ? 1.6 : -1.6), 31.50, ix, 35.00,
             0.95, 1, upTone(pal.tile), 'x');
    poly(rn, [[ox, 31.50, hz0], [ix, 31.50, hz0], [ix, 35.00, hz0]],
         [(ox + ix) * 0.5, 31.0, hz0 + away * 4], 1, wallTone);
    poly(rn, [[ox, 31.50, hz1], [ix, 31.50, hz1], [ix, 35.00, hz1]],
         [(ox + ix) * 0.5, 31.0, hz1 - away * 4], 1, wallTone);
  }
  /* the flat lead deck round the drum's foot - the kasnak - and a parapet on
     the two ends of the central square, where no aisle roof covers it */
  deck(rn, 544.0, hzA, 588.0, hzB, 33.60, 0.55, 1, upTone(pal.lead));
  for (k = 0; k < 2; k++) {
    var pz = k ? hz1 : hz0;
    boxC(st, AX, 32.55, pz + (k ? -away : away) * 0.45, 22.4, 1.05, 0.45,
         0.16, 1, upTone(pal.trim));
  }

  /* ---- 9.2.7  the octagonal drum, r 20 about (566, frontZ + 20), y
     33.60..47.00, with a pointed light in every facet.  Each facet is its
     own pierced panel: the octagon's tangent and outward normal are the
     basis, so the routine that cuts the harim's windows cuts these too. */
  var dcz = Z(20), dr = 20.0, drot = Math.PI / 8;
  var dring = tmRing(AX, dcz, dr, 8, drot);
  tmPrism(rn, AX, dcz, 33.60, 34.90, dr, dr, 8, drot, 1, 1,
          groundTone(pal.wash, 33.60, 1.47));
  for (i = 0; i < 8; i++) {
    var p0 = dring[i], p1 = dring[(i + 1) % 8];
    var ex = p1[0] - p0[0], ez = p1[1] - p0[1];
    var el = Math.sqrt(ex * ex + ez * ez);
    ex /= el; ez /= el;
    tmPiercedPanel(rn, p0[0], p0[1], ex, ez, ez, -ex, 0, el, 34.90, 47.00,
                   [{ uc: el * 0.5, half: 2.50, sill: 36.00, spring: 41.00, apex: 44.50 }],
                   1.80, pal.wash, { stone: pal.cut, pane: pal.dark });
  }
  /* the cornice the dome springs off.  The drum is an octagon of
     circumradius 20 and the dome a circle of radius 20, so the dome
     oversails the facet midpoints by 1.52 u; this ring covers exactly that,
     and a dome springs off a projecting cornice in any case. */
  tmPrism(st, AX, dcz, 45.20, 46.30, 20.30, 21.40, 24, 0, 1, 1, pal.trim);
  tmPrism(st, AX, dcz, 46.30, 47.00, 21.40, 21.40, 24, 0, 1, 1, pal.trim);
  tmAnnulus(st, AX, dcz, 47.00, 19.30, 21.40, 24, 0, true, 1, upTone(pal.trim));

  /* ---- 9.2.8  THE DOME.  Springs at 47.00, twelve units clear of the aisle
     ridges at 35.00, apex 63.00.  Sixteen segments by six rings with a
     standing lead seam up every meridian - the seams are why a lead dome
     reads as lead and not as a grey balloon.  NOTHING is registered as an
     occluder round it: the analytic canyon test already has the mass and
     replaying it would darken the precinct twice. */
  var dseg = 16, drg = 6, dh = 16.0, dy0 = 47.00;
  function domeR(t) { return dr * Math.cos(t * Math.PI * 0.5); }
  function domeY(t) { return dy0 + dh * Math.sin(t * Math.PI * 0.5); }
  for (k = 0; k < drg; k++) {
    var v0 = k / drg, v1 = (k + 1) / drg;
    tmLoft(rn, AX, dcz, tmRing(AX, dcz, domeR(v0), dseg, 0), domeY(v0),
           tmRing(AX, dcz, domeR(v1), dseg, 0), domeY(v1), 1, pal.lead);
    if (k < drg - 1) {
      for (i = 0; i < dseg; i++) {
        a = i / dseg * Math.PI * 2;
        tube(rn, [AX + Math.cos(a) * domeR(v0), domeY(v0), dcz + Math.sin(a) * domeR(v0)],
             [AX + Math.cos(a) * domeR(v1), domeY(v1), dcz + Math.sin(a) * domeR(v1)],
             0.30, 4, pal.lead, false, false);
      }
    }
  }
  tube(P.metal, [AX, 63.00, dcz], [AX, 69.00, dcz], 0.30, 6, C.gold, true, false);
  tube(P.metal, [AX, 64.60, dcz], [AX, 65.50, dcz], 0.58, 6, C.gold, true, false);
  signCard(P.sign, 'alem', AX, 71.40, dcz, 1, 0, 0, 0, 1, 0, 4.60, C.gold, [0, 0, fdir]);
  signCard(P.sign, 'alem', AX, 71.40, dcz, 1, 0, 0, 0, 1, 0, 4.60, C.gold, [0, 0, -fdir]);

  /* ---- 9.2.9  the two minarets, identical and symmetric about the mosque's
     own entrance axis, at 22 u centres so their kup flank the gate */
  minaret(553.0, Z(-26), fdir, pal);
  minaret(575.0, Z(-26), fdir, pal);

  /* ---- 9.2.10  an irregular group of mature conifers inside the avlu wall.
     The references mix open sky, bare gaps and different crown heights; a
     symmetric six-tree row hid the mosque and read as a planted screen.
     conifer() is
     section 8's tree, and the reason it is called rather than re-written is
     that it IS the quality bar this whole rebuild is measured against: a
     real stem with a root flare, limbs, and crown clumps on the needle atlas
     with the card gain already solved against the bake. */
  var grove = [[514, -12, 24.5], [539, -7, 29.0], [591, -18, 26.0], [615, -4, 31.5]];
  for (i = 0; i < grove.length; i++) {
    var th = grove[i][2] + rr(grove[i][0], 91, -1.2, 1.8);
    conifer(grove[i][0], Z(grove[i][1]), 0.62, th, th * rr(719, i, 0.23, 0.29));
  }
}


/* -----------------------------------------------------------------------
   9.3  THE BYSTANDER BLOCK

   The town past every closure.  The build this replaces made these honest
   solids with a grid of flat glass rectangles glued to one face, which at
   20 u - and the nearest of them stands FOUR units past the south barricade
   - reads as a cardboard flat.  This one carries the same silhouette
   language as the street proper: a chamfered stone plinth to 5.075, a storey
   band at the ground-floor head, a floor band at every level, recessed
   windows with cills and a real frame on P.joinery, one balcony stack per
   three bays, a chamfered cornice, and either a hipped pantile roof with a
   fascia and a near-black soffit (four storeys, like the street's own hipped
   runs) or a parapet, a deck and a stair head (five storeys, like S-W1, S-W2
   and all four 230 Sk stubs, which are cornice-only by the site plan).

   faceAt is the SKIN plane and the mass stops AT it: the north-west block's
   547.65 is 0.35 clear of x = 548, where nz-street-park's northApartment has
   its east face, and a mass face of ours on 548 would flicker against it for
   the full length of the block.
   -------------------------------------------------------------------- */
function bystander(x0, x1, z0, z1, storeys, tone, faceDir, faceAt, opts) {
  opts = opts || {};
  var top = fy(storeys + 1), i, s, j;
  var alongX = (faceDir === 'z');
  var mid = alongX ? (z0 + z1) * 0.5 : (x0 + x1) * 0.5;
  var sgn = faceAt > mid ? 1 : -1;
  var mx0 = x0, mx1 = x1, mz0 = z0, mz1 = z1;
  if (alongX) { if (sgn > 0) mz1 = faceAt; else mz0 = faceAt; }
  else { if (sgn > 0) mx1 = faceAt; else mx0 = faceAt; }
  var s0 = alongX ? mx0 : mz0, s1 = alongX ? mx1 : mz1;
  var span = s1 - s0;
  if (!(span > 6) || !(top > 6)) { warn('bystander: degenerate block'); return; }

  /* a point on the face frame: s along the face, y up, d proud of it */
  function FP(sv, y, d) {
    return alongX ? [sv, y, faceAt + sgn * d] : [faceAt + sgn * d, y, sv];
  }
  /* a box in the same frame, d0..d1 proud of the face */
  function FB(pile, sa, sb, ya, yb, d0, d1, ao, tn) {
    var a0 = faceAt + sgn * d0, a1 = faceAt + sgn * d1;
    if (alongX) box6(pile, sa, sb, ya, yb, Math.min(a0, a1), Math.max(a0, a1), ao, tn);
    else box6(pile, Math.min(a0, a1), Math.max(a0, a1), ya, yb, sa, sb, ao, tn);
  }

  /* ---- mass and plinth.  The ground-line splash gradient goes on the
     PLINTH and not on the mass: groundTone's 420 mm span over a 52-u box
     with vertices only at 0 and 52 spreads the darkening over the whole
     elevation and reads as a gradient rather than as dirt. */
  box6(P.render, mx0, mx1, 0, top, mz0, mz1, 1, tone);
  boxC(P.stone, (mx0 + mx1) * 0.5, PLINTH_TOP * 0.5, (mz0 + mz1) * 0.5,
       (mx1 - mx0) * 0.5 + 0.30, PLINTH_TOP * 0.5, (mz1 - mz0) * 0.5 + 0.30,
       0.26, 1, groundTone(mix(C.plinth, C.stone, 0.45), 0, 1.47));

  /* ---- bands, all starting 0.02 INSIDE the face and never on it: a proud
     element that starts exactly on the wall plane puts its own rear quad
     coplanar with the wall down the block's full length, which is the defect
     the audit found on all eleven runs of the street proper. */
  FB(P.render, s0, s1, 10.80, 11.70, -0.02, 0.36, 1, upTone(mix(tone, C.stone, 0.40)));
  for (s = 2; s <= storeys; s++) {
    FB(P.render, s0, s1, fy(s) - 0.30, fy(s) + 0.22, -0.02, 0.18, 1,
       upTone(mix(tone, C.stone, 0.30)));
  }

  /* ---- windows.  Bay pitch m(3.6) = 12.6 u, opening m(1.35) wide by
     m(1.55) tall, reveal REV = 1.10 deep.  Cheap by design - these are read
     at 20 to 120 u - but a reveal, a cill and a frame is the minimum that
     stops a window being a sticker. */
  var bays = Math.max(2, Math.round(span / m(3.6)));
  var wHalf = m(0.675), wH0 = m(0.95), wH1 = m(2.50);
  var frame = mix(C.white, C.stone, 0.18);
  var pane = mix(C.glass, C.dark, 0.30);
  var balA = bays >= 3 ? 1 : -1, balB = bays >= 6 ? bays - 2 : -1;
  for (s = 1; s <= storeys; s++) {
    var yb0 = fy(s) + wH0, yb1 = fy(s) + wH1, ym = (yb0 + yb1) * 0.5;
    for (i = 0; i < bays; i++) {
      var sc = lerp(s0, s1, (i + 0.5) / bays);
      if (sc - wHalf < s0 + 0.8 || sc + wHalf > s1 - 0.8) continue;
      poly(P.render, [FP(sc - wHalf, yb1, 0), FP(sc + wHalf, yb1, 0),
                      FP(sc + wHalf, yb1, -REV), FP(sc - wHalf, yb1, -REV)],
           FP(sc, yb1 + 1.2, -REV * 0.5), 0.40, tone);
      poly(P.render, [FP(sc - wHalf, yb0, 0), FP(sc - wHalf, yb1, 0),
                      FP(sc - wHalf, yb1, -REV), FP(sc - wHalf, yb0, -REV)],
           FP(sc - wHalf - 1.2, ym, -REV * 0.5), 0.62, tone);
      poly(P.render, [FP(sc + wHalf, yb0, 0), FP(sc + wHalf, yb1, 0),
                      FP(sc + wHalf, yb1, -REV), FP(sc + wHalf, yb0, -REV)],
           FP(sc + wHalf + 1.2, ym, -REV * 0.5), 0.62, tone);
      /* the pane at the back of the reveal.  M.glass is depthWrite false, so
         panes behind panes do not punch holes in one another. */
      poly(P.glass, [FP(sc - wHalf, yb0, -REV), FP(sc + wHalf, yb0, -REV),
                     FP(sc + wHalf, yb1, -REV), FP(sc - wHalf, yb1, -REV)],
           FP(sc, ym, -REV - 1.2), 1, pane);
      /* frame on P.joinery and NOT on P.metal: metalness 0.62 has almost no
         diffuse lobe left, and every white PVC frame put through it on this
         street came back as tinted chrome */
      FB(P.joinery, sc - wHalf, sc + wHalf, ym - 0.16, ym + 0.16,
         -REV + 0.06, -REV + 0.34, 1, frame);
      FB(P.joinery, sc - 0.16, sc + 0.16, yb0, yb1, -REV + 0.06, -REV + 0.34, 1, frame);
      var cp = FP(sc, yb0 - 0.22, 0.16);
      boxC(P.stone, cp[0], cp[1], cp[2],
           alongX ? wHalf + 0.34 : 0.42, 0.22, alongX ? 0.42 : wHalf + 0.34,
           0.10, 1, upTone(mix(C.stone, C.white, 0.20)));
      STATS.windows++;
    }
    /* One balcony stack per three bays, capped at two.  Selected distant
       blocks use the mixed open/enclosed balcony language visible on 232 Sk:
       shallow glass winter-gardens alternate with ordinary rail balconies. */
    if (s > 1) {
      for (j = 0; j < 2; j++) {
        var bi = j ? balB : balA;
        if (bi < 0) continue;
        var bc = lerp(s0, s1, (bi + 0.5) / bays), bh = m(1.05), bd = m(1.05), r2;
        FB(P.stone, bc - bh, bc + bh, fy(s) + 0.06, fy(s) + 0.58, 0, bd, 1,
           upTone(mix(C.stone, C.white, 0.15)));
        var enclosed = !!opts.glazedBalconies && ((s + j) % 3 !== 0);
        if (enclosed) {
          var gy0 = fy(s) + 0.70, gy1 = fy(s) + 8.65;
          FB(P.glass, bc - bh + 0.16, bc + bh - 0.16, gy0, gy1,
             bd - 0.18, bd - 0.10, 1, mix(C.glass, C.white, 0.08));
          FB(P.joinery, bc - bh, bc + bh, gy0 - 0.18, gy0 + 0.18,
             bd - 0.24, bd - 0.04, 1, C.white);
          FB(P.joinery, bc - bh, bc + bh, gy1 - 0.18, gy1 + 0.18,
             bd - 0.24, bd - 0.04, 1, C.white);
          for (r2 = 0; r2 <= 4; r2++) {
            var gx2 = lerp(bc - bh + 0.16, bc + bh - 0.16, r2 / 4);
            FB(P.joinery, gx2 - 0.11, gx2 + 0.11, gy0, gy1,
               bd - 0.24, bd - 0.04, 1, C.white);
          }
          FB(P.joinery, bc - bh, bc + bh, fy(s) + 2.45, fy(s) + 2.75,
             bd - 0.24, bd - 0.04, 1, C.white);
        } else {
          for (r2 = 0; r2 < 3; r2++) {
            var ry = fy(s) + 0.58 + [0.30, 1.70, 3.10][r2];
            FB(P.joinery, bc - bh, bc + bh, ry - 0.15, ry + 0.15, 0.10, bd, 1, C.grey);
          }
          for (r2 = 0; r2 <= 4; r2++) {
            var bx2 = lerp(bc - bh + 0.3, bc + bh - 0.3, r2 / 4);
            FB(P.joinery, bx2 - 0.13, bx2 + 0.13, fy(s) + 0.58, fy(s) + 3.90,
               bd - 0.30, bd - 0.04, 1, C.grey);
          }
        }
        STATS.balconies++;
      }
    }
  }

  /* ---- a shop row at the base where the plan asks for one */
  if (opts.shops) {
    var shopN = Math.max(2, Math.round(bays / 2)), sw = span / shopN;
    for (i = 0; i < shopN; i++) {
      var sa = s0 + i * sw + 0.9, sb = s0 + (i + 1) * sw - 0.9;
      FB(P.glass, sa, sb, 2.30, 7.30, -0.34, -0.30, 1, mix(C.glass, C.dark, 0.44));
      FB(P.render, sa - 0.9, sb + 0.9, 7.35, 10.70, -0.02, 0.42, 1,
         mix(tone, C.white, 0.35));
      FB(P.stone, sa - 0.9, sb + 0.9, 1.90, 2.34, -0.02, 0.30, 1,
         upTone(mix(C.stone, C.dark, 0.20)));
      if (i === 0 || i === shopN - 1) {
        var mc = (sa + sb) * 0.5, fp = FP(mc, 9.05, 0.46);
        /* 'komagene' is a franchise and 'garaj' reads OTOPARK, so neither
           duplicates a named shop the player has already walked past.  A
           second SEYDI BAKKAL 250 u down the same street would. */
        signCard(P.sign, i === 0 ? 'komagene' : 'garaj', fp[0], fp[1], fp[2],
                 alongX ? 1 : 0, 0, alongX ? 0 : 1, 0, 1, 0, m(0.24), C.white,
                 alongX ? [0, 0, sgn] : [sgn, 0, 0]);
      }
    }
  }

  /* ---- the top */
  boxC(P.stone, (mx0 + mx1) * 0.5, top - 0.45, (mz0 + mz1) * 0.5,
       (mx1 - mx0) * 0.5 + 0.60, 0.45, (mz1 - mz0) * 0.5 + 0.60, 0.20, 1,
       upTone(mix(C.stone, C.white, 0.12)));
  var rx0 = mx0 - EAVE_OUT, rx1 = mx1 + EAVE_OUT;
  var rz0 = mz0 - EAVE_OUT, rz1 = mz1 + EAVE_OUT;
  var hipped = (storeys <= 4 && opts.roof !== 'flat');
  if (hipped) {
    hipRoof(P.roof, rx0, rx1, rz0, rz1, top + 0.4, HIP_RISE, upTone(C.roof));
    /* the fascia and the soffit belong to the caller: the kit's hipRoof
       emits the tile surface only, precisely so that a soffit can be given
       the near-black underside the photographs show */
    var tim = mix(C.timber, C.dark, 0.30);
    box6(P.stone, rx0, rx1, top - 0.15, top + 0.45, rz0, rz0 + 0.34, 1, tim);
    box6(P.stone, rx0, rx1, top - 0.15, top + 0.45, rz1 - 0.34, rz1, 1, tim);
    box6(P.stone, rx0, rx0 + 0.34, top - 0.15, top + 0.45, rz0, rz1, 1, tim);
    box6(P.stone, rx1 - 0.34, rx1, top - 0.15, top + 0.45, rz0, rz1, 1, tim);
    deck(P.render, rx0, rz0, rx1, rz1, top - 0.15, 0.10, 0.48,
         mix(C.stone, C.dark, 0.45));
    STATS.roofs++;
  } else {
    deck(P.render, mx0 + 0.4, mz0 + 0.4, mx1 - 0.4, mz1 - 0.4, top + 0.20, 0.24, 1,
         upTone(mix(C.asphalt, C.stone, 0.25)));
    boxC(P.render, (mx0 + mx1) * 0.5, top + 1.75, (mz0 + mz1) * 0.5,
         (mx1 - mx0) * 0.5 + 0.10, 1.75, (mz1 - mz0) * 0.5 + 0.10, 0.18, 1,
         upTone(mix(tone, C.stone, 0.35)));
    box6(P.render, mx0 + 4, mx0 + 11, top + 0.2, top + 7.4, mz0 + 4, mz0 + 10, 1,
         mix(tone, C.stone, 0.30));
    box6(P.roof, mx0 + 3.4, mx0 + 11.6, top + 7.4, top + 7.9, mz0 + 3.4, mz0 + 10.6,
         1, upTone(C.roof));
  }

  /* ---- the roof clutter every block on this street carries: a poly water
     tank on a light frame and a rendered chimney with a stone cap.  The tank
     is on P.joinery, which is the white-plastic material - on P.metal it
     would be chrome, the same fault as the window frames. */
  var tkx = lerp(mx0, mx1, 0.34), tkz = lerp(mz0, mz1, 0.62);
  var ty = top + (hipped ? 3.4 : 0.5);
  box6(P.metal, tkx - 2.3, tkx + 2.3, ty, ty + 0.9, tkz - 2.3, tkz + 2.3, 1, C.steel);
  tube(P.joinery, [tkx, ty + 0.9, tkz], [tkx, ty + 4.6, tkz], 2.10, 12,
       mix(C.white, C.stone, 0.10), true, true);
  var chx = lerp(mx0, mx1, 0.78), chz = lerp(mz0, mz1, 0.30);
  var chh = hipped ? 5.0 : 3.2;
  boxC(P.render, chx, top + chh, chz, 1.5, chh, 1.5, 0.16, 1,
       mix(tone, C.stone, 0.45));
  boxC(P.stone, chx, top + chh * 2 + 0.35, chz, 1.9, 0.35, 1.9, 0.12, 1,
       upTone(mix(C.stone, C.white, 0.25)));
  STATS.buildings++;
}

/* Ordinary compact cars for the non-playable continuation.  They are kept to
   three simple volumes plus real wheels, glass, lamps and bumpers so the road
   reads as an inhabited Turkish residential street without spending the hero
   vehicle's mesh budget on background silhouettes. */
function distantCar(x, z, tone, flip, van) {
  var Lc = van ? 16.8 : 14.4, Wc = van ? 6.4 : 6.1;
  var base = ROAD_TOP + 0.72, wheelZ = Lc * 0.31, nose = flip ? -1 : 1;
  var cabinL = van ? 10.8 : 8.2, cabinY = van ? 3.15 : 2.85;
  var tyre = mix(C.dark, L(0x111315), 0.72), glass = mix(C.glass, C.dark, 0.42);
  var i, wz;

  boxC(P.joinery, x, base + 1.10, z, Wc * 0.5, 1.10, Lc * 0.5,
       0.48, 1, mix(tone, C.dark, 0.08));
  boxC(P.glass, x, base + cabinY, z - nose * 0.25, Wc * 0.42,
       van ? 1.65 : 1.35, cabinL * 0.5, 0.38, 1, glass);
  boxC(P.joinery, x, base + cabinY + (van ? 1.72 : 1.42), z - nose * 0.25,
       Wc * 0.44, 0.16, cabinL * 0.5 + 0.12, 0.12, 1, tone);
  /* pillars stop the greenhouse reading as one dark aquarium */
  for (i = -1; i <= 1; i++) {
    var pz = z - nose * 0.25 + i * cabinL * 0.31;
    boxC(P.joinery, x, base + cabinY, pz, Wc * 0.46, van ? 1.68 : 1.38,
         0.11, 0.05, 1, mix(tone, C.dark, 0.14));
  }
  for (i = -1; i <= 1; i += 2) {
    wz = z + i * wheelZ;
    tube(P.metal, [x - Wc * 0.57, base, wz], [x + Wc * 0.57, base, wz],
         1.08, 10, tyre, true, true);
    tube(P.metal, [x - Wc * 0.60, base, wz], [x - Wc * 0.48, base, wz],
         0.58, 10, C.steel, true, true);
    tube(P.metal, [x + Wc * 0.48, base, wz], [x + Wc * 0.60, base, wz],
         0.58, 10, C.steel, true, true);
  }
  /* front/rear bumpers and paired light clusters make headings legible */
  boxC(P.metal, x, base + 0.72, z + nose * (Lc * 0.5 + 0.12),
       Wc * 0.46, 0.28, 0.18, 0.08, 1, mix(C.steel, C.dark, 0.28));
  for (i = -1; i <= 1; i += 2) {
    boxC(P.joinery, x + i * Wc * 0.30, base + 1.50,
         z + nose * (Lc * 0.5 + 0.20), 0.62, 0.30, 0.10, 0.05, 1,
         flip ? C.red : mix(C.white, C.gold, 0.20));
  }
  STATS.vehicles = (STATS.vehicles || 0) + 1;
}


/* -----------------------------------------------------------------------
   9.3b  CEMETERY EDGE

   The photographed cemetery reads mainly as a deep green boundary: a low
   retaining wall, dark ironwork and mature conifers.  A few small stones sit
   well behind the fence, never presented as a theatrical graveyard set.
   -------------------------------------------------------------------- */
function buildCemeteryEdge() {
  var fx = 483.25, z0 = -148.0, z1 = -24.0;
  var iron = mix(C.dark, C.green, 0.18), i, z;

  deck(P.render, 414.0, z0, 484.0, z1, 0.18, 0.18, 1,
       mix(C.soil, C.green, 0.18));
  box6(P.stone, fx - 1.10, fx + 0.10, 0.18, 2.25, z0, z1, 1,
       groundTone(mix(C.stone, C.dark, 0.18), 0.18, 1.47));

  tube(P.metal, [fx, 3.05, z0], [fx, 3.05, z1], 0.11, 6, iron, true, false);
  tube(P.metal, [fx, 5.80, z0], [fx, 5.80, z1], 0.11, 6, iron, true, false);
  for (z = z0 + 1.6, i = 0; z < z1 - 0.8; z += 3.55, i++) {
    var ph = 6.35 + rr(841, i, -0.20, 0.28);
    tube(P.metal, [fx, 2.20, z], [fx, ph, z], 0.085, 5, iron, true, false);
    if (i % 4 === 0)
      tube(P.metal, [fx, ph, z], [fx, ph + 0.55, z], 0.13, 5, iron, true, true);
  }

  /* modest covered entry, matching the dark shelter visible beside the trees */
  var sx0 = 459.5, sx1 = 472.5, sz0 = -34.0, sz1 = -20.0;
  var posts = [[sx0 + 1.0, sz0 + 1.0], [sx1 - 1.0, sz0 + 1.0],
               [sx0 + 1.0, sz1 - 1.0], [sx1 - 1.0, sz1 - 1.0]];
  for (i = 0; i < posts.length; i++)
    boxC(P.metal, posts[i][0], 4.15, posts[i][1], 0.20, 3.55, 0.20,
         0.06, 1, iron);
  hipRoof(P.roof, sx0, sx1, sz0, sz1, 7.55, 3.10,
          upTone(mix(C.roof, C.dark, 0.36)));

  var trees = [
    [471.0, -42.0, 28.0, 5.6], [459.0, -50.0, 31.0, 6.0],
    [472.0, -61.0, 26.0, 5.2], [454.0, -70.0, 33.0, 6.2],
    [469.0, -80.0, 30.0, 5.8], [457.0, -91.0, 27.0, 5.3],
    [472.0, -102.0, 32.0, 6.1], [454.0, -113.0, 29.0, 5.6],
    [468.0, -124.0, 34.0, 6.4], [456.0, -136.0, 28.0, 5.4],
    [474.0, -143.0, 25.0, 5.0]
  ];
  for (i = 0; i < trees.length; i++)
    conifer(trees[i][0], trees[i][1], 0.20, trees[i][2], trees[i][3]);

  var stones = [[473,-48,1.6],[465,-58,1.9],[474,-73,1.5],[462,-86,1.8],
                [472,-98,1.7],[463,-109,1.5],[474,-121,1.9],[464,-134,1.6]];
  for (i = 0; i < stones.length; i++)
    boxC(P.stone, stones[i][0], 0.62 + stones[i][2] * 0.5, stones[i][1],
         0.56, stones[i][2] * 0.5, 0.20, 0.08, 1,
         mix(C.stone, C.dark, 0.10));
}


/* -----------------------------------------------------------------------
   9.4  buildTerminus

   North: the downhill road continues through real apartment scale to the
   cemetery's fenced tree line.
   South: ordinary apartment street.  East and west of 230 Sk: the four stub
   vistas and two cross-vista closers.  Nothing between the two police lines
   is touched here - the live street belongs to sections 6, 7 and 8.
   -------------------------------------------------------------------- */
function buildTerminus() {
  var i;

  /* =====================================================================
     NORTH DOWNHILL STREET - APARTMENTS TO THE CEMETERY
     ================================================================== */

  /* Narrow paved forecourts sit behind the true kerbside footways.  The first
     blocks step back 0.8-1.0 m from the old canyon line, giving the street
     the entrance depth visible in the reference sequence without creating a
     plaza where the cemetery's planted ground should be. */
  var gt = upTone(mix(C.paver, C.stone, 0.30));
  deck(P.paver, 480.8, -22, 484, 56, 0.62, 0.36, 1, gt);
  deck(P.paver, 580, -68, 584.2, 56, 0.62, 0.36, 1, gt);

  /* Split blocks instead of two featureless slabs: varied tones, hipped/flat
     roofs and a mixture of open and enclosed balconies match the real street. */
  bystander(422, 481.2, 18, 52, 4, C.ochre, 'x', 480.85,
            { glazedBalconies: true });
  bystander(422, 481.2, -18, 14, 4, C.bone, 'x', 480.85,
            { glazedBalconies: true });

  buildCemeteryEdge();

  /* Ordinary apartments continue beyond the cemetery on the eastern side;
     the mosque has moved to its surveyed south-arm plot. */
  bystander(580, 648, -96, -24, 5, C.dusty, 'x', 580.35,
            { glazedBalconies: true });

  /* Keep the entire north continuation vehicle-free, matching this mission's
     quiet downhill approach and leaving the cemetery sightline unobstructed. */

  /* =====================================================================
     SOUTH DISTANT STREET - ADIL CAMII AND APARTMENT BLOCKS
     ================================================================== */

  /* Two apartment runs occupy the west side immediately after the park.  The
     mosque begins beyond them, still entirely west of x 484, and faces north
     toward the island.  This buffer matches the photographed street sequence. */
  bystander(416, 484, 300.6, 348.0, 5, C.sage, 'x', 483.65,
            { glazedBalconies: true });
  bystander(416, 484, 352.0, 394.0, 5, C.apricot, 'x', 483.65,
            { glazedBalconies: true });
  shiftedMosque(444, 1, -176);
  bystander(580, 648, 300.6, 321.2, 5, C.bone, 'x', 580.35, { shops: true });
  bystander(580, 648, 324.0, 382.0, 4, C.rose, 'x', 580.35, {});
  bystander(580, 648, 386.0, 454.0, 5, C.olive, 'x', 580.35,
            { glazedBalconies: true });
  bystander(580, 648, 458.0, 500.0, 5, C.cream, 'x', 580.35, {});
  bystander(510, 618, 572.0, 600.0, 5, C.sand, 'z', 571.60, { shops: true });

  /* =====================================================================
     230 Sk STUB VISTAS
     x1 = 833.5 and NOT 856: PLANE.east is 836 and nz-street-sky's daylight
     BOX ends there, so anything past it is outside the graded volume - and
     833.5 is what leaves the eave overhang (+2.1) inside it too.
     The z extents are pulled clear of the four stub RUNS' own mass
     rectangles (x 728..760 and 792..824 over z 96..140, 96..152, 208..260
     and 196..260); the plan's 30..110 and 250..320 would have put a
     bystander mass inside section 7's.
     ================================================================== */

/* ---------------------------------------------------------------------------
   9.4  SEYDISEHIR MARKET, and the planted gap beside it

   The reference is a photograph of the real street: a SMALL building -- shop
   at street level, two floors over it, and no more -- standing between two
   five-storey blocks, clad in coursed yellow ashlar, under a hipped pantile
   roof so deep and so far oversailing that the roof is half the building.
   Three solar water heaters on it, a couple of satellite dishes, roller
   shutters on every window, and a red market fascia at the foot.  Between it
   and the block next door, a gap with conifers in it.

   IT GOES ON THE PLOT THE UPHILL PASS EMPTIED.  Deleting X-E-S left x 792..824
   z 196..260 as bare ground on the east side of the 230 Sk south stub -- solid
   map, never walked, seen head-on from the 233 Sk crossing and across the road
   from the apricot block the owner calls the red building.  A five-storey slab
   there is what was just removed; this is the opposite of one, and it is the
   thing the photograph actually shows.

   THE SCALE IS THE POINT.  Its eaves are at 34.6 against 61.95 either side, so
   it reads as the old low building the tall ones grew up around, which is what
   it is.  Everything below is set out from the face plane x = 791.60 -- 0.14
   in front of the stub's own building line at 791.46, so nothing is coplanar
   with the engine's wall behind it -- and from the road deck at ROAD_TOP.
   ------------------------------------------------------------------------ */
var MKT = {
  face: 791.60,        /* the front plane, facing WEST down the stub          */
  back: 815.60,        /* 24 u = 6.9 m deep.  It was 30 and the north gable it
                          presented to the 233 Sk crossing was the biggest
                          blank plane on this end of the map -- the exact
                          defect the two deleted blocks were removed for.      */
  z0: 200.00, z1: 228.00,
  g0: ROAD_TOP,        /* it stands on the carriageway deck, like its neighbours */
  shop: 11.20,         /* head of the shopfront                                */
  f1: 21.35, f2: 31.50,
  eave: 34.60, over: 2.30, rise: 11.40
};

/* A QUARTER TURN, so the shop faces the STREET.
   The market is authored facing WEST -- down the 230 Sk stub, at the red
   block -- because that is the plot's long edge.  It is the wrong way round:
   233 Sk is the street, the stub is a barricaded side spur nobody walks, and
   a bakkal puts its window where the traffic is.  Rather than re-typing every
   coordinate in 9.4, the finished assembly is turned a quarter clockwise
   about a vertical axis, which maps its -X front onto -Z, i.e. north, onto
   233 Sk.

   Like cdSpin() this is a PROPER motion, so winding survives and the only
   thing it does to a normal is swap and negate: (dx, dz) -> (-dz, dx).

   The pivot is solved from the two planes that have to land.  The front,
   x 791.60, must become z 196.40 -- the south building line of 233 Sk east of
   the 230 crossing, where rCityTailWalk's pavement stops -- so
   pz0 - px0 = -595.20.  The frontage's far end, z 228, must become x 793, one
   unit clear of the stub kerb at 792, so px0 + pz0 = 1021.  That is
   (808.10, 212.90), and it puts the building on x 793..821, z 196.4..220.4:
   28 u of shopfront on the main street, 24 u deep, its eaves oversailing the
   footway the way every shopfront on this map does. */
function mkTurn(mark, px0, pz0) {
  var k, i, pl, p, nm, x, z, nx, nz;
  for (k in mark) {
    if (k === '__occ') continue;
    pl = P[k]; if (!pl) continue;
    p = pl.p; nm = pl.nm;
    for (i = mark[k]; i < pl.n; i++) {
      x = p[i * 3]; z = p[i * 3 + 2];
      p[i * 3]     = px0 - (z - pz0);
      p[i * 3 + 2] = pz0 + (x - px0);
      nx = nm[i * 3]; nz = nm[i * 3 + 2];
      nm[i * 3]     = -nz;
      nm[i * 3 + 2] =  nx;
    }
  }
  for (i = mark.__occ; i < OCC.length; i++) {
    var o = OCC[i];
    var ax = px0 - (o.z1 - pz0), bx = px0 - (o.z0 - pz0);
    var az = pz0 + (o.x0 - px0), bz = pz0 + (o.x1 - px0);
    o.x0 = Math.min(ax, bx); o.x1 = Math.max(ax, bx);
    o.z0 = Math.min(az, bz); o.z1 = Math.max(az, bz);
  }
}

function marketBuilding() {
  var F = MKT.face, B = MKT.back, Z0 = MKT.z0, Z1 = MKT.z1, G = MKT.g0;
  var i;
  /* the two body tones.  Coursed limestone ashlar is warmer and a good deal
     more saturated than the render on the blocks either side -- that contrast
     is most of why the real building stands out in the photograph -- and the
     shopfront storey below it is plain painted render. */
  var ash  = cdWeather ? cdWeather(mix(C.sand, C.ochre, 0.34), G, 3.20)
                       : mix(C.sand, C.ochre, 0.34);
  var ashU = upTone(mix(C.sand, C.ochre, 0.34));
  var rend = groundTone(mix(C.cream, C.white, 0.30), G, 2.40);
  var trim = upTone(mix(C.stone, C.white, 0.28));
  var roofT = mix(C.roof, C.clay, 0.26);

  /* ---- the mass.  Two boxes, because the ashlar storeys stand 0.30 proud of
     the shopfront the way a stone facing course does over a rendered base. */
  box6(P.render, F + 0.30, B, G, MKT.shop, Z0, Z1, 1, rend);
  box6(P.stone,  F,        B, MKT.shop, MKT.eave, Z0, Z1, 1, ash);

  /* the storey band between shop and stone, and the sill band under the top
     floor: both 0.22 proud, which is what stops a flat wall reading as a
     billboard at forty metres */
  boxC(P.stone, F - 0.11, MKT.shop + 0.34, (Z0 + Z1) * 0.5, 0.33, 0.34,
       (Z1 - Z0) * 0.5, 0.08, 1, trim);
  boxC(P.stone, F - 0.11, MKT.f1 + 0.26, (Z0 + Z1) * 0.5, 0.33, 0.26,
       (Z1 - Z0) * 0.5, 0.08, 1, trim);

  /* ---- the quoins.  A coursed-stone building without them reads as wallpaper;
     with them it reads as masonry.  Alternate long and short, both ends. */
  for (i = 0; i < 9; i++) {
    var qy = MKT.shop + 0.6 + i * 2.55, qd = (i % 2) ? 1.35 : 2.10;
    boxC(P.stone, F - 0.10, qy + 1.10, Z0 + qd * 0.5, 0.32, 1.05, qd * 0.5, 0.10, 1, trim);
    boxC(P.stone, F - 0.10, qy + 1.10, Z1 - qd * 0.5, 0.32, 1.05, qd * 0.5, 0.10, 1, trim);
  }

  /* ---- the windows.  Two per upper floor, punched, with a 0.45 reveal, a
     sill, a lintel and a pale roller shutter box over each -- the photograph
     has a shutter on every opening and half of them are down. */
  var wz = [Z0 + 9.5, Z1 - 9.5];
  for (var f = 0; f < 2; f++) {
    var wy0 = (f ? MKT.f2 : MKT.f1) - 7.20, wy1 = wy0 + 5.60;
    for (i = 0; i < 2; i++) {
      var zc = wz[i], hw = 2.55;
      /* THE WALL IS A SOLID BOX AND NOTHING PUNCHES IT.  The first pass set a
         reveal 0.45 INSIDE the ashlar and glazed the back of it, which draws
         a window behind its own wall: from the street all that showed was the
         white shutter box over each opening, and the facade read as blank
         masonry with slabs stuck on it.  Cutting real openings would mean
         building this wall as segments, which is a lot of geometry for a
         building whose whole point is that it is small.  So the opening is
         built PROUD instead -- a stone surround standing 0.30 off the face
         with the joinery, the glass and the shutter inside it.  At any
         distance the player sees this from, a projecting surround and a
         recessed one read the same; a missing one does not. */
      boxC(P.stone, F - 0.16, (wy0 + wy1) * 0.5, zc, 0.32, (wy1 - wy0) * 0.5 + 0.30,
           hw + 0.30, 0.10, 1, trim);
      panelX(P.render, F - 0.30, wy0, wy1, zc - hw, zc + hw, -1, 0.34,
             mix(C.dark, C.stone, 0.16));
      /* THE SHUTTERS ARE NOT ALL DOWN.  Every opening on the first pass was
         three-quarters shuttered, which left 1.45 u of glass under a 4.15 u
         lath -- a dark slit under a white slab, on every window, and the
         facade read as a wall with slots in it.  In the photograph roughly
         half the shutters are up and half are down, and it is that difference
         between neighbouring openings that says the building is lived in.
         Drop is 0 (up), 0.55 or 1.0 by opening. */
      var drop = [1.00, 0.35, 0.00, 0.70][(f * 2 + i) & 3];
      var shTop = wy1 - (wy1 - wy0) * drop;
      if (drop > 0.02)
        box6(P.joinery, F - 0.40, F - 0.28, shTop, wy1, zc - hw + 0.06, zc + hw - 0.06,
             0.86, mix(C.white, C.stone, 0.30));
      panelX(P.glass, F - 0.34, wy0 + 0.10, shTop - 0.04, zc - hw + 0.10, zc + hw - 0.10,
             -1, 0.86, mix(C.glass, C.dark, 0.28));
      if (drop < 0.55)
        box6(P.joinery, F - 0.42, F - 0.30, wy0 + 2.60, wy0 + 2.80,
             zc - hw + 0.10, zc + hw - 0.10, 0.9, trim);
      /* the shutter box over the head, and the sill under the opening */
      boxC(P.joinery, F - 0.50, wy1 + 0.52, zc, 0.28, 0.52, hw + 0.16, 0.08, 1, trim);
      boxC(P.stone,   F - 0.52, wy0 - 0.30, zc, 0.46, 0.24, hw + 0.42, 0.08, 1,
           upTone(mix(C.stone, C.white, 0.20)));
    }
  }

  /* ---- THE NORTH GABLE, which is the face the player actually arrives at.
     The 233 Sk crossing looks straight down the stub, so this building is met
     end-on long before its frontage is: leaving the gable blank puts a
     twenty-three-metre plane of untouched ashlar exactly where the two
     deleted blocks used to put theirs.  Same quoins, same window rhythm, same
     shutter -- one bay narrower, because the gable is. */
  for (i = 0; i < 9; i++) {
    var gy2 = MKT.shop + 0.6 + i * 2.55, gd = (i % 2) ? 1.35 : 2.10;
    boxC(P.stone, B - gd * 0.5, gy2 + 1.10, Z0 - 0.10, gd * 0.5, 1.05, 0.32, 0.10, 1, trim);
  }
  for (var gf = 0; gf < 2; gf++) {
    var gwy0 = (gf ? MKT.f2 : MKT.f1) - 7.20, gwy1 = gwy0 + 5.60;
    var gxs = [F + 7.4, F + 16.4];
    for (i = 0; i < 2; i++) {
      var gxc = gxs[i], ghw = 2.55;
      var gdrop = [0.00, 0.80, 1.00, 0.30][(gf * 2 + i) & 3];
      var gshTop = gwy1 - (gwy1 - gwy0) * gdrop;
      boxC(P.stone, gxc, (gwy0 + gwy1) * 0.5, Z0 - 0.16, ghw + 0.30,
           (gwy1 - gwy0) * 0.5 + 0.30, 0.32, 0.10, 1, trim);
      panelZ(P.render, Z0 - 0.30, gwy0, gwy1, gxc - ghw, gxc + ghw, -1, 0.34,
             mix(C.dark, C.stone, 0.16));
      if (gdrop > 0.02)
        box6(P.joinery, gxc - ghw + 0.06, gxc + ghw - 0.06, gshTop, gwy1,
             Z0 - 0.40, Z0 - 0.28, 0.86, mix(C.white, C.stone, 0.30));
      panelZ(P.glass, Z0 - 0.34, gwy0 + 0.10, gshTop - 0.04, gxc - ghw + 0.10, gxc + ghw - 0.10,
             -1, 0.86, mix(C.glass, C.dark, 0.28));
      boxC(P.joinery, gxc, gwy1 + 0.52, Z0 - 0.50, ghw + 0.16, 0.52, 0.28, 0.08, 1, trim);
      boxC(P.stone,   gxc, gwy0 - 0.30, Z0 - 0.52, ghw + 0.42, 0.24, 0.46, 0.08, 1,
           upTone(mix(C.stone, C.white, 0.20)));
    }
  }
  /* the storey band and the sill band return round the gable */
  boxC(P.stone, (F + B) * 0.5, MKT.shop + 0.34, Z0 - 0.11, (B - F) * 0.5, 0.34, 0.33, 0.08, 1, trim);
  boxC(P.stone, (F + B) * 0.5, MKT.f1 + 0.26, Z0 - 0.11, (B - F) * 0.5, 0.26, 0.33, 0.08, 1, trim);

  /* ---- AND THE OTHER GABLE, for the same reason turned the other way.
     mkTurn maps this face -- authored at z = Z1 -- onto the building's WEST
     flank, which is what the 230 Sk stub and the red block opposite look
     straight at.  Left plain it is a twenty-three-metre blank slab facing the
     one place the owner already asked to have blank slabs removed from.  Two
     openings and a set of quoins, same as the other two faces; no shopfront,
     because a bakkal has one window on the street and a side wall everywhere
     else. */
  for (i = 0; i < 9; i++) {
    var wy2 = MKT.shop + 0.6 + i * 2.55, wd = (i % 2) ? 1.35 : 2.10;
    boxC(P.stone, F + wd * 0.5, wy2 + 1.10, Z1 + 0.10, wd * 0.5, 1.05, 0.32, 0.10, 1, trim);
  }
  for (var wf = 0; wf < 2; wf++) {
    var wwy0 = (wf ? MKT.f2 : MKT.f1) - 7.20, wwy1 = wwy0 + 5.60;
    var wxs = [F + 7.4, F + 16.4];
    for (i = 0; i < 2; i++) {
      var wxc = wxs[i], whw = 2.55;
      var wdrop = [0.55, 1.00, 0.20, 0.90][(wf * 2 + i) & 3];
      var wshTop = wwy1 - (wwy1 - wwy0) * wdrop;
      boxC(P.stone, wxc, (wwy0 + wwy1) * 0.5, Z1 + 0.16, whw + 0.30,
           (wwy1 - wwy0) * 0.5 + 0.30, 0.32, 0.10, 1, trim);
      panelZ(P.render, Z1 + 0.30, wwy0, wwy1, wxc - whw, wxc + whw, 1, 0.34,
             mix(C.dark, C.stone, 0.16));
      if (wdrop > 0.02)
        box6(P.joinery, wxc - whw + 0.06, wxc + whw - 0.06, wshTop, wwy1,
             Z1 + 0.28, Z1 + 0.40, 0.86, mix(C.white, C.stone, 0.30));
      panelZ(P.glass, Z1 + 0.34, wwy0 + 0.10, wshTop - 0.04, wxc - whw + 0.10, wxc + whw - 0.10,
             1, 0.86, mix(C.glass, C.dark, 0.28));
      boxC(P.joinery, wxc, wwy1 + 0.52, Z1 + 0.50, whw + 0.16, 0.52, 0.28, 0.08, 1, trim);
      boxC(P.stone,   wxc, wwy0 - 0.30, Z1 + 0.52, whw + 0.42, 0.24, 0.46, 0.08, 1,
           upTone(mix(C.stone, C.white, 0.20)));
    }
  }
  boxC(P.stone, (F + B) * 0.5, MKT.shop + 0.34, Z1 + 0.11, (B - F) * 0.5, 0.34, 0.33, 0.08, 1, trim);
  boxC(P.stone, (F + B) * 0.5, MKT.f1 + 0.26, Z1 + 0.11, (B - F) * 0.5, 0.26, 0.33, 0.08, 1, trim);

  /* ---- the shopfront: a red fascia with the market board on it, the glazing
     under it, and a doorway at the north end. */
  var red = mix(C.red, C.white, 0.06);
  /* THE FASCIA IS A BOARD, NOT A BAND.  Run the full 28 u of frontage it is a
     thirty-metre red stripe and the building disappears behind its own
     signage; the photograph has a board about a third of the shop's width,
     over the door end, with plain rendered fascia either side of it. */
  var fz0 = Z0 + 2.2, fz1 = Z0 + 14.2;
  boxC(P.render, F + 0.06, MKT.shop - 1.70, (fz0 + fz1) * 0.5, 0.30, 1.35,
       (fz1 - fz0) * 0.5, 0.10, 1, upTone(red));
  signCard(P.sign, 'market', F - 0.26, MKT.shop - 1.70, (fz0 + fz1) * 0.5,
           0, 0, 1, 0, 1, 0, 1.02, C.white, [-1, 0, 0]);
  /* the awning: a shallow sloped canopy under the fascia, red above and a
     pale soffit under it, which is what a market awning looks like from
     below and is the half everybody forgets */
  poly(P.render, [[F + 0.24, MKT.shop - 3.60, Z0 + 0.6], [F + 0.24, MKT.shop - 3.60, Z1 - 0.6],
                  [F - 3.40, MKT.shop - 5.10, Z1 - 0.6], [F - 3.40, MKT.shop - 5.10, Z0 + 0.6]],
       [F, MKT.shop + 2.0, (Z0 + Z1) * 0.5], 1, upTone(red));
  poly(P.render, [[F - 3.40, MKT.shop - 5.22, Z0 + 0.6], [F - 3.40, MKT.shop - 5.22, Z1 - 0.6],
                  [F + 0.24, MKT.shop - 3.72, Z1 - 0.6], [F + 0.24, MKT.shop - 3.72, Z0 + 0.6]],
       [F, MKT.shop - 12.0, (Z0 + Z1) * 0.5], 0.52, mix(C.white, C.grey, 0.34));
  for (i = 0; i < 3; i++) {
    var az = lerp(Z0 + 2.0, Z1 - 2.0, i / 2);
    tube(P.metal, [F + 0.20, MKT.shop - 3.70, az], [F - 3.30, MKT.shop - 5.16, az],
         0.10, 5, mix(C.steel, C.dark, 0.30), false, false);
  }
  /* ---- THE GLAZING, and the reason the first pass had none.
     The shop storey's wall runs from x = F + 0.30, so a pane set at F + 0.34
     is four hundredths BEHIND its own wall: the whole shopfront was drawn
     inside the masonry and what showed was a blank rendered band.  Every plane
     below is PROUD of F + 0.30, and the dark back of the shop is behind it,
     so the window reads as a window and not as a decal.
     Frontage: glazing over the north two thirds, the entrance door in the
     last third, a stone stallboard under both. */
  var sz0 = Z0 + 2.0, sz1 = Z0 + 18.0;          /* the glazed run              */
  var dz0 = Z0 + 19.6, dz1 = Z0 + 23.6;         /* the doorway                 */
  var gy0 = G + 2.10, gy1 = MKT.shop - 4.30;    /* head clear of the awning    */
  /* the dark interior, set back so the glass has something to be in front of */
  panelX(P.render, F + 0.90, G + 0.20, gy1 + 0.20, sz0 - 0.3, dz1 + 0.3, -1, 0.30,
         mix(C.dark, C.brick, 0.22));
  /* the stallboard */
  box6(P.stone, F + 0.12, F + 0.42, G, gy0, sz0 - 0.35, sz1 + 0.35, 1,
       upTone(mix(C.stone, C.dark, 0.14)));
  /* the pane, 0.08 proud of the wall, and its frame */
  panelX(P.glass, F + 0.22, gy0, gy1, sz0, sz1, -1, 0.88, mix(C.glass, C.dark, 0.12));
  box6(P.joinery, F + 0.12, F + 0.30, gy0 - 0.18, gy0, sz0 - 0.20, sz1 + 0.20, 1, trim);
  box6(P.joinery, F + 0.12, F + 0.30, gy1, gy1 + 0.18, sz0 - 0.20, sz1 + 0.20, 0.9, trim);
  for (i = 0; i <= 4; i++) {
    var mz = lerp(sz0, sz1, i / 4);
    box6(P.joinery, F + 0.10, F + 0.30, gy0, gy1, mz - 0.16, mz + 0.16, 1, trim);
  }
  /* the entrance: a recessed dark leaf in a frame, with a step */
  panelX(P.render, F + 0.34, G, gy1, dz0, dz1, -1, 0.34, mix(C.dark, C.brick, 0.34));
  box6(P.joinery, F + 0.14, F + 0.32, G, gy1 + 0.18, dz0 - 0.24, dz0, 1, trim);
  box6(P.joinery, F + 0.14, F + 0.32, G, gy1 + 0.18, dz1, dz1 + 0.24, 1, trim);
  box6(P.joinery, F + 0.14, F + 0.32, gy1, gy1 + 0.18, dz0 - 0.24, dz1 + 0.24, 0.9, trim);
  box6(P.stone, F - 0.55, F + 0.20, G, G + 0.34, dz0 - 0.3, dz1 + 0.3, 1,
       upTone(mix(C.stone, C.dark, 0.20)));
  /* two crates of produce on the pavement outside, which is what a bakkal
     always has and what makes a shopfront read as open */
  for (i = 0; i < 2; i++) {
    var cz = sz0 + 2.4 + i * 4.2;
    boxC(P.joinery, F - 1.55, G + 1.05, cz, 1.30, 1.05, 1.55, 0.10, 1,
         upTone(mix(C.trunk, C.stone, 0.34)));
    boxC(P.render, F - 1.55, G + 2.35, cz, 1.05, 0.35, 1.30, 0.14, 1,
         upTone(i ? mix(C.red, C.gold, 0.34) : mix(C.green, C.gold, 0.40)));
  }

  /* ---- THE ROOF, which is half the building.
     Hipped, oversailing 2.30 all round on an exposed fascia, and pitched at
     35 degrees so its ridge sits 11.4 over the eaves.  hipRoof emits the tile
     surface only; the fascia and the near-black soffit under the overhang
     belong here, and without the soffit a deep eaves reads as a paper brim. */
  var rx0 = F - MKT.over, rx1 = B + MKT.over;
  var rz0 = Z0 - MKT.over, rz1 = Z1 + MKT.over;
  hipRoof(P.roof, rx0, rx1, rz0, rz1, MKT.eave + 0.55, MKT.rise, roofT);
  boxC(P.joinery, (rx0 + rx1) * 0.5, MKT.eave + 0.28, (rz0 + rz1) * 0.5,
       (rx1 - rx0) * 0.5, 0.28, (rz1 - rz0) * 0.5, 0.08, 1,
       upTone(mix(C.white, C.grey, 0.26)));
  poly(P.joinery, [[rx0, MKT.eave - 0.01, rz0], [rx1, MKT.eave - 0.01, rz0],
                   [rx1, MKT.eave - 0.01, rz1], [rx0, MKT.eave - 0.01, rz1]],
       [(rx0 + rx1) * 0.5, MKT.eave + 2.0, (rz0 + rz1) * 0.5], 0.40,
       mix(C.white, C.dark, 0.40));
  /* the gutter along the west eaves, and one downpipe off its south end */
  tube(P.metal, [rx0 + 0.30, MKT.eave + 0.14, rz0 + 0.4], [rx0 + 0.30, MKT.eave + 0.14, rz1 - 0.4],
       0.24, 7, mix(C.gutter, C.white, 0.34), true, true);
  tube(P.metal, [F + 0.16, G, Z1 - 1.4], [F + 0.16, MKT.eave + 0.10, Z1 - 1.4],
       0.20, 6, mix(C.gutter, C.white, 0.30), false, true);

  /* the chimney, off-centre on the north slope the way a flue actually is */
  boxC(P.stone, F + 8.0, MKT.eave + 6.20, Z0 + 6.0, 1.35, 5.60, 1.35, 0.14, 1,
       upTone(mix(C.stone, C.dark, 0.22)));
  boxC(P.stone, F + 8.0, MKT.eave + 11.95, Z0 + 6.0, 1.70, 0.28, 1.70, 0.08, 1, trim);

  /* ---- THREE SOLAR WATER HEATERS, which is the single most Turkish thing on
     a roof in this town and the loudest thing in the reference photograph: a
     dark collector tilted south on a light frame, with a white horizontal
     cylinder above its head. */
  /* THEY HAVE TO SIT ON THE ROOF, and that is a calculation, not a guess.
     hipRoof puts the ridge along x = (rx0 + rx1) / 2 = 803.60 because the
     plan is deeper in z than in x, and the surface falls 11.40 over the 14.30
     from ridge to eaves.  The first pass hung them at eave + 4.2, which on
     that slope is four metres INSIDE the tiles -- three solar heaters buried
     in a roof.  Straddling the ridge at 45.0 they stand on it, which is also
     where every one of them in the photograph is: as near the apex as the
     frame will bolt down, tilted south. */
  var ridgeX = ((F - MKT.over) + (B + MKT.over)) * 0.5;
  for (i = 0; i < 3; i++) {
    var sx = ridgeX - 1.2 + i * 1.1, sz = Z0 + 7.5 + i * 7.0;
    var sy = MKT.eave + 10.40;
    /* the collector: one tilted panel, dark absorber over a pale case */
    poly(P.metal, [[sx - 3.1, sy, sz - 2.4], [sx + 3.1, sy, sz - 2.4],
                   [sx + 3.1, sy + 3.0, sz + 2.4], [sx - 3.1, sy + 3.0, sz + 2.4]],
         [sx, sy - 3.0, sz], 1, mix(C.dark, C.steel, 0.20));
    /* the tank, and the two legs that carry it */
    tube(P.metal, [sx - 3.0, sy + 3.9, sz + 2.7], [sx + 3.0, sy + 3.9, sz + 2.7],
         0.86, 9, upTone(mix(C.white, C.steel, 0.16)), true, true);
    tube(P.metal, [sx - 2.6, sy, sz + 2.6], [sx - 2.6, sy + 3.6, sz + 2.7],
         0.12, 5, cdGalv(), false, false);
    tube(P.metal, [sx + 2.6, sy, sz + 2.6], [sx + 2.6, sy + 3.6, sz + 2.7],
         0.12, 5, cdGalv(), false, false);
  }

  /* ---- two satellite dishes on the front wall, one per upper floor, on the
     side of the opening rather than over it */
  for (i = 0; i < 2; i++) {
    var dy = (i ? MKT.f2 : MKT.f1) - 4.6, dz = i ? Z0 + 3.2 : Z1 - 3.4;
    tube(P.metal, [F, dy, dz], [F - 1.05, dy + 0.10, dz], 0.11, 5, cdGalv(), false, false);
    cdDisc(P.metal, F - 1.35, dz, dy + 0.55, 1.55, 10, [F - 3.0, dy + 0.55, dz], 0.92,
           upTone(mix(C.white, C.stone, 0.22)));
    tube(P.metal, [F - 1.35, dy + 0.55, dz], [F - 2.35, dy + 0.35, dz], 0.09, 5,
         mix(C.steel, C.dark, 0.24), false, false);
  }
}

/* ---------------------------------------------------------------------------
   9.5  THE GROVE

   Between the market and the block at z 262 the photograph has a gap with
   conifers standing in it, and that gap is most of why the small building
   reads as small: something has to be beside it at full height for the eye to
   measure it against, and something has to break the line so the two do not
   read as one long block.

   THE FIRST PASS PUT A WALL THERE.  A coursed stone garden wall with a railing
   over it, which is what the gaps on 233 Sk itself have -- and it turned the
   one soft thing on this end of the map into another length of concrete, seen
   end-on from the crossing.  There is no wall now.  The ground is soil, the
   edge is a row of low shrubs rather than a kerb, and what stands in the gap
   is eleven trees: nine in the lot south of the market and two tight against
   its west flank, so the view up the 230 Sk stub from the red block ends in
   planting instead of in a blank gable.

   Heights run 17 to 27 against a 34.6 eaves, and no two share a height or a
   line -- a grid of identical cones is the one thing that reads as a game.
   These are all WORLD coordinates: the grove is written after mkTurn() has
   already put the building where it belongs, so nothing here is turned.
   ------------------------------------------------------------------------ */
function marketGrove() {
  var G = MKT.g0, i;
  /* the lot's ground: bare soil under the trees rather than the stub's
     asphalt, laid 0.04 over the deck so it never fights it for the depth
     test, and stopping 0.6 short of the carriageway on every side */
  deck(P.render, 792.60, 223.00, 830.00, 259.40, G + 0.04, 0.10, 1,
       upTone(mix(C.soil, C.dark, 0.16)));
  /* a ragged skirt of low shrubs along the lot's street edge, which is what
     replaces the wall: it stops the soil ending on a drawn line */
  for (i = 0; i < 9; i++) {
    var bx = 793.6 + i * 4.2, br = 1.55 + rr(i * 13 + 5, 3, -0.35, 0.55);
    cdDisc(P.needle, bx, 223.9 + rr(i * 7 + 1, 4, -0.5, 0.9), G + 0.10 + br * 0.55,
           br, 7, [bx, G + br * 2.2, 223.9], 0.88,
           [NEEDLE_T[0] * 0.86, NEEDLE_T[1] * 0.92, NEEDLE_T[2] * 0.80]);
  }
  /* the trees.  x, z, height, crown radius. */
  var T = [
    [797.5, 229.0, 25.5, 5.4], [809.0, 227.5, 19.5, 4.3],
    [820.5, 231.0, 22.5, 5.0], [800.5, 238.5, 27.0, 5.8],
    [812.0, 241.0, 17.5, 4.0], [824.5, 239.0, 23.5, 5.2],
    [796.5, 249.0, 21.0, 4.6], [808.0, 251.5, 26.0, 5.6],
    [820.0, 252.0, 18.5, 4.2],
    /* the two on the flank, slimmer so their crowns clear the stub kerb at
       792 and the market's own eaves line */
    [796.2, 203.0, 20.0, 3.4], [796.2, 214.5, 23.0, 3.6]
  ];
  for (i = 0; i < T.length; i++) conifer(T[i][0], T[i][1], G, T[i][2], T[i][3]);
}


/* ---------------------------------------------------------------------------
   9.6  THE 233 Sk GARDEN POCKET

   THERE IS NO STREET HERE.  The owner's correction, and it is the whole of
   this section: the gap between the market and B-BLOK's east end is not a
   side spur with a barricade across it, it is a small walled garden -- a low
   rendered wall on the street line, raised soil behind it, and cypress packed
   in tight enough that you never see the ground.  Every Turkish apartment
   street has two or three of these: a plot too narrow to build on that the
   kat malikleri walled and planted instead.

   WHAT CHANGED WITH IT.  Three things had to move together or the pocket
   would have been a garden you could walk through:

     - NUKEM.html now occupies rows 49..64 of columns 190..197 rather than
       rows 60..64.  The wall is the closure, so the closure cell is row 49
       and the open street in front of it is row 48, the 233 Sk carriageway.
       validate-level.mjs's closure table carries the same pair.
     - the carriageway and the lane marks over z 196..260 are gone from
       SECTION 8.4, and the south line is gone from SECTION 10's stub table.
       A barricade closing a garden closes nothing.
     - the trooper and the shells that stood in the old corridor moved to the
       north stub, which is still a street.

   IT IS STILL A CLOSURE BY THE MODULE'S OWN RULE, which is the thing that
   made this legal: waist high at 4.40 against a 7.10 eye, seen straight over
   from the crossing, with the map visibly carrying on behind it.  What the
   rule forbids is ending a street on a building, and this does not.

   THE PLANTING IS TALL AND THIN, not the fat round crowns the first pass put
   here.  Nine metres of height on a two-metre crown is what a Cupressus does
   in an eight-metre gap between two six-storey blocks; a 5.6 crown radius is
   a park tree and it read as one.  Sixteen of them on a jittered 3 x 6
   lattice, heights 19..33, so the pocket is solid green from the street and
   the engine wall at z 260 is never once visible through it.
   ------------------------------------------------------------------------ */
var GDN = {
  x0: 760.60, x1: 791.40,     /* between the two building plinths            */
  zf: 196.00,                 /* the wall's front plane, on the street line  */
  zb: 197.60,                 /* ...and its back, 1.6 u = 460 mm of blockwork*/
  z1: 259.40,                 /* 0.6 short of the engine wall at z 260       */
  wall: 4.00, cope: 4.40,     /* head of the render, head of the coping      */
  rail: 6.90,                 /* head of the korkuluk over it                */
  soil: 2.10                  /* the bed, 1.54 = 440 mm over the footway     */
};

function gardenWall() {
  var G = GDN, i;
  var body = mix(C.cream, C.stone, 0.30);
  var cope = upTone(mix(C.stone, C.grey, 0.22));
  var pier = mix(C.cream, C.stone, 0.14);
  var steel = mix(C.steel, C.dark, 0.78);

  /* the wall itself, in three bays between four piers.  groundTone() carries
     the splash-line the module puts on every other wall on this street. */
  box6(P.render, G.x0, G.x1, 1.70, G.wall, G.zf, G.zb, 1, body);
  /* a stone base course, 0.12 proud, the same cladding the market carries:
     a 3.70 wall in one flat cream is the blankest thing on the street */
  box6(P.stone, G.x0, G.x1, 0.30, 1.70, G.zf - 0.12, G.zb, 1,
       groundTone(mix(C.stone, C.sand, 0.34), 0.30, 1.05));
  /* the piers: 1.90 wide, 0.34 proud of the render on the street side only,
     because the back of them is inside the soil */
  var px = [G.x0, G.x0 + 10.27, G.x0 + 20.53, G.x1 - 1.90];
  for (i = 0; i < 4; i++) {
    box6(P.render, px[i], px[i] + 1.90, 0.30, G.wall + 0.55, G.zf - 0.34, G.zb, 1,
         groundTone(pier, 0.30, 1.05));
    boxC(P.stone, px[i] + 0.95, G.wall + 0.55 + 0.17, (G.zf + G.zb) * 0.5 - 0.17,
         1.28, 0.17, (G.zb - G.zf) * 0.5 + 0.40, 0.05, 1, cope);
  }
  /* the coping, 0.24 proud each side with a chamfer, run in the three bays so
     it dies into the piers instead of crossing them */
  for (i = 0; i < 3; i++) {
    var a = px[i] + 1.90, b = px[i + 1];
    boxC(P.stone, (a + b) * 0.5, (G.wall + G.cope) * 0.5, (G.zf + G.zb) * 0.5,
         (b - a) * 0.5, (G.cope - G.wall) * 0.5, (G.zb - G.zf) * 0.5 + 0.24,
         0.05, 1, cope);
  }

  /* THE KORKULUK.  16 mm flat bar on 45 mm uprights at 300 mm centres, in a
     near-black paint: the first pass ran 63 mm uprights at 440 mm in a mid
     grey and it read as a timber fence sitting on a plinth.  A real bahce
     korkulugu is a thin dark grid you see the planting straight through. */
  var rz = (G.zf + G.zb) * 0.5;
  for (i = 0; i < 3; i++) {
    var a2 = px[i] + 1.90 + 0.22, b2 = px[i + 1] - 0.22;
    box6(P.metal, a2, b2, G.rail - 0.24, G.rail, rz - 0.11, rz + 0.11, 0.80, steel);
    box6(P.metal, a2, b2, G.cope + 0.62, G.cope + 0.80, rz - 0.09, rz + 0.09, 0.80, steel);
    var n = Math.max(2, Math.round((b2 - a2) / 1.05)), j;
    for (j = 0; j <= n; j++) {
      var ux = lerp(a2, b2, j / n);
      box6(P.metal, ux - 0.08, ux + 0.08, G.cope, G.rail, rz - 0.08, rz + 0.08, 0.80, steel);
    }
    /* the two stanchions that carry the run land on the piers */
    box6(P.metal, a2 - 0.22, a2, G.cope, G.rail + 0.16, rz - 0.13, rz + 0.13, 0.80, steel);
    box6(P.metal, b2, b2 + 0.22, G.cope, G.rail + 0.16, rz - 0.13, rz + 0.13, 0.80, steel);
  }
}

/* A CYPRESS, which is not a pine and cannot be built by conifer().

   conifer() is a black pine: a clear stem, four or five radiating limbs, and
   the foliage carried on the outer third of each.  Open that tree out to a
   0.15 crown base and a 2.5 crown radius -- which is what a garden cypress
   measures -- and you get twenty units of crown carrying fifteen clumps, and
   you can see the building behind it straight through the middle.

   A Cupressus sempervirens is the opposite construction: no limbs to speak
   of, a dense column of foliage packed against the stem from a fifth of the
   height to the tip, widest at about a third and closing to a blunt point.
   So it is built as WHORLS -- three or four clumps a turn, one turn every
   0.75 r up the crown, on a flame profile -- which is dense by construction
   rather than by accident, and 120-odd cards a tree at r 2.5.
   -------------------------------------------------------------------- */
function cypress(x, z, y, h, r) {
  var i, j;
  var seed = Math.round(x * 5 + z * 11) + 7;
  var cb = y + h * rr(seed, 1, 0.10, 0.19);
  var top = y + h;
  var crownH = top - cb;
  var trunkR = r * 0.115;
  var leanX = rr(seed, 2, -0.22, 0.22), leanZ = rr(seed, 3, -0.20, 0.20);
  var bark = mix(C.trunk, C.dark, rr(seed, 4, 0.10, 0.55));
  var tk = rr(seed, 6, 0.90, 1.08);
  /* A CYPRESS IS DARKER AND GREENER THAN A PINE.  NEEDLE_T is calibrated
     for nz-street-park's black pines -- 1.05 / 0.72 / 1.34, a multiplier
     that leaves the atlas cell blue and pale.  Trimming red to 0.70 and
     blue to 0.56 while holding green at 0.88 lands this species where a
     Cupressus actually sits: near-black green in shade, olive in sun. */
  var base = [NEEDLE_T[0] * tk * 0.70, NEEDLE_T[1] * tk * 0.88,
              NEEDLE_T[2] * tk * 0.56];

  function stemAt(q) {
    return [x + leanX * r * q * q, y + h * 0.97 * q, z + leanZ * r * q * q];
  }
  /* THE FLAME.  sin() over 0.10..0.96 of a half turn, softened by the 0.55
     power so the column keeps its width instead of pinching to a spindle. */
  function prof(q) {
    return Math.pow(Math.sin(Math.PI * clamp(0.10 + 0.86 * q, 0.001, 0.999)), 0.55);
  }

  for (i = 0; i < 4; i++) {
    var q0 = i / 4, q1 = (i + 1) / 4;
    var rA = trunkR * (1 - 0.74 * Math.pow(q0, 1.4)) + trunkR * 0.06;
    var rB = trunkR * (1 - 0.74 * Math.pow(q1, 1.4)) + trunkR * 0.06;
    var a = stemAt(q0), b = stemAt(q1);
    grFrustum(P.render, a[0], a[1], a[2], b[0], b[1], b[2], rA, rB, 6, 1, bark, false, false);
  }
  for (i = 0; i < 4; i++) {
    var fa = i / 4 * Math.PI * 2 + rr(seed, 8 + i, -0.4, 0.4);
    var fl = r * rr(seed, 12 + i, 0.08, 0.15);
    grFrustum(P.render, x, y + fl * 1.6, z,
              x + Math.cos(fa) * fl, y - 0.10, z + Math.sin(fa) * fl,
              trunkR * 0.32, trunkR * 0.55, 5, 1, mix(bark, C.dark, 0.30), false, false);
  }

  var turns = Math.max(6, Math.round(crownH / (r * 0.66)));
  for (i = 0; i <= turns; i++) {
    var q = i / turns;
    var cy = cb + crownH * q;
    var w = prof(q) * r;
    var per = 3 + (i % 2);
    /* the crown gradient, 0.82 at the foot to 1.24 at the head: a column of
       one colour is a cut-out, and this one has no limb structure to break
       it up */
    var lift = 0.74 + 0.30 * q;
    var sy = stemAt(clamp((cy - y) / (h * 0.97), 0, 1));
    for (j = 0; j < per; j++) {
      var a2 = (i * 0.83 + j / per) * Math.PI * 2 + rr(seed + i, 20 + j, -0.35, 0.35);
      var d = w * rr(seed + i * 3, 30 + j, 0.20, 0.42);
      grClump(sy[0] + Math.cos(a2) * d,
              cy + rr(seed + i * 5, 40 + j, -crownH * 0.02, crownH * 0.02),
              sy[2] + Math.sin(a2) * d,
              w * rr(seed + i * 7, 50 + j, 0.46, 0.64), base,
              seed + i * 61 + j * 13, lift * (d > w * 0.32 ? 1.05 : 0.90));
    }
  }
  /* the tip: two clumps on the axis so the column closes instead of fraying */
  for (i = 0; i < 2; i++) {
    grClump(stemAt(1)[0], top - crownH * (0.015 + i * 0.05), stemAt(1)[2],
            r * prof(1 - i * 0.05) * 0.56, base, seed + 400 + i, 1.04);
  }
  STATS.trees++;
}

function stubGarden() {
  var G = GDN, i;

  gardenWall();

  /* the bed.  One deck from the back of the wall to 0.6 short of the engine
     wall, standing on its own 2.10 of retained fill -- the side faces are
     inside the two engine walls at x 760 and x 792 and never seen. */
  deck(P.render, G.x0, G.zb, G.x1, G.z1, G.soil, 2.10, 1,
       upTone(mix(C.soil, C.dark, 0.18)));

  /* THE TREES.  A 3 x 6 lattice on x 764.6 / 776.0 / 787.0 and z 203..255,
     jittered per cell, with two cells dropped so the rows never read as rows.
     h 19..33 on r 2.3..3.6: tall, thin, touching. */
  var cx = [765.00, 776.00, 787.00], k = 0;
  for (i = 0; i < 7; i++) {
    /* a QUINCUNX, not a grid: every other row shifts 2.6 so a gap in one row
       is covered by the row behind it.  Three columns on a straight lattice
       left three sightlines straight through the pocket to the block beyond,
       and the whole point of the planting is that there are none. */
    var off = (i % 2) ? 2.60 : -2.60;
    for (var c = 0; c < 3; c++) {
      k++;
      var tx = cx[c] + off + rr(k * 17 + 3, 1, -1.40, 1.40);
      var tz = 203.60 + i * 8.90 + rr(k * 23 + 5, 2, -2.20, 2.20);
      var th = rr(k * 31 + 7, 3, 21.0, 34.0);
      var tr = rr(k * 37 + 11, 4, 1.80, 2.60);
      cypress(tx, tz, G.soil, th, tr);
    }
  }
  /* THE FRONT ROW, and it is the one that makes the pocket read as a garden
     rather than as trees standing in a yard.  conifer() clears its stem to
     42 per cent of the height, so a 25-unit tree carries nothing below 12.6
     and the first pass left a metre and a half of bare trunk in the one band
     the street actually looks at -- between the coping at 4.40 and the rail
     head at 6.90.  Seven SHORT ones, h 9..15, put their crown bases at 5.9
     to 8.4: foliage from the coping up, which is what you see over a garden
     wall in every reference frame of this street. */
  for (i = 0; i < 9; i++) {
    var fx = lerp(G.x0 + 2.4, G.x1 - 2.4, i / 8) + rr(i * 53 + 3, 12, -0.90, 0.90);
    var fz = 200.10 + rr(i * 59 + 5, 13, -0.80, 1.80);
    cypress(fx, fz, G.soil, rr(i * 61 + 7, 14, 8.5, 15.5),
            rr(i * 67 + 11, 15, 1.70, 2.40));
  }

  /* the undergrowth: a ragged front row of shrubs along the back of the wall
     and a scatter through the bed, so the soil is never a flat brown plane */
  for (i = 0; i < 14; i++) {
    var sx = lerp(G.x0 + 1.6, G.x1 - 1.6, (i + 0.5) / 14) + rr(i * 13 + 1, 6, -0.9, 0.9);
    var sz = (i < 9) ? 198.90 + rr(i * 19 + 3, 7, -0.5, 1.3)
                     : 206.00 + (i - 9) * 11.60 + rr(i * 29 + 3, 8, -2.4, 2.4);
    var sw = 4.40 + rr(i * 41 + 5, 9, -0.90, 1.70);
    var st = mix(C.needle, C.needleD, rr(i * 43 + 7, 10, 0.15, 0.72));
    ncross(P.needle, N_SHRUB, sx, G.soil - 0.20, sz, sw, sw * 0.86,
           rr(i * 47 + 9, 11, 0, Math.PI),
           [st[0] * SHRUB_GAIN, st[1] * SHRUB_GAIN, st[2] * SHRUB_GAIN * 0.97]);
  }
}


  bystander(700, 756, 30, 92, 4, C.paleblu, 'x', 756.35, {});
  bystander(796, 833.5, 30, 94, 4, C.sand, 'x', 795.65, {});
  bystander(700, 756, 262, 320, 5, C.terra, 'x', 756.35, {});
  bystander(796, 833.5, 262, 318, 4, C.apricot, 'x', 795.65, {});
  bystander(742, 810, 4, 28, 4, C.grey, 'z', 28.4, {});
  bystander(742, 810, 322, 350, 4, C.butter, 'z', 321.6, {});

  /* the small building on the plot the uphill pass emptied, turned a quarter
     so its shop faces 233 Sk, and the grove beside it -- see 9.4, mkTurn and
     9.5 above.  The grove is authored in world coordinates and therefore
     goes in AFTER the turn. */
  var mkMark = cdMark();
  marketBuilding();
  mkTurn(mkMark, 808.10, 212.90);
  marketGrove();
  stubGarden();
}

/* ==== side-6-cordon.js ==== */
/* ===========================================================================
   SECTION 10  CORDON AND CHECKPOINT
   ===========================================================================
   Four police lines close 232 Sk north and south and both 230 Sk stubs, and
   the keycard gate closes the east end of 233 Sk.

   THE RULE FOR A CLOSURE, and it is the owner's, not a style note: a closure
   is NEVER a building.  It is one occupied row, walkable street on the near
   side, the street visibly continuing on the far side, and the line itself
   waist-high so the player can see past it and understand where the map
   stops.  A player who cannot see where the map ends assumes he has missed a
   door.  NUKEM.html:4155-4166 builds the grid the same way - occupy() one row
   and then five more rows of visible, un-walkable street beyond it.

   WHAT THE GRID GIVES US, cell for cell, because every number below is
   derived from it:
     232 N line   row 0   = z   0.0..  4.0, cols 137..144 = x 548..580
     232 S line   row 126 = z 504.0..508.0, cols 121..144 = x 484..580
     230 N line   row 28  = z 112.0..116.0, cols 190..197 = x 760..792
     230 S      row 49  = z 196.0..200.0 -- NOT a police line.  The south
                  stub is the walled garden of SECTION 9.6 and its closure is
                  the garden wall on the 233 Sk building line; rows 49..64 of
                  cols 190..197 are occupied behind it.
     east line    col 208 = x 832.0..836.0, rows 38..48 = z 152..196, with the
                  keycard door on cell (208,43) = z 172..176 and the lane
                  carved on through cells (209..212, 43) to the exit at
                  (213,43).

   THE ONE FACT THAT SHAPES THE WHOLE CHECKPOINT.  Column 208 is S_BLOCK for
   its full eleven rows and every cell west of it is open road or pavement, so
   buildWorld already stands a concrete-textured wall on the x = 832 plane
   from y = 0 to the region ceiling c = 52 - fifteen metres of it, z 152..196,
   with one door-shaped hole in it.  Nothing this module puts EAST of that
   plane below y = 52 can ever be seen.  The gate block is therefore not a
   free-standing tower on an open road; it is the west face of that wall,
   built out in front of it, with a real passage bored through it on the one
   row the level carves.  FOUR objects the site plan places east of the line -
   the boom, the guard hut, the two flood masts and the sandbag revetment -
   have been moved west of it for exactly this reason, and each move is argued
   from the grid where it happens.  Nothing else in the plan moved.

   NO CHECKPOINT VAN.  Everything that
   used to say "manned" - the van, its light bar - is now said on foot, with
   sandbags, floodlight masts, a boom and a guard cabin.
   ======================================================================== */


/* ---- tones and small helpers -----------------------------------------
   Every one of these is a ratio against the road, the same way the C table
   is: galvanised steel reads about 1.35x C.asphalt in the same frame, a
   painted barricade sheet about 2.0x, and site concrete about 1.6x. */
function cdGalv()  { return mix(C.steel, C.white, 0.30); }   /* hot-dip galv  */
function cdSteel() { return mix(C.steel, C.dark, 0.18); }    /* painted steel */
function cdSheet() { return mix(C.white, C.steel, 0.18); }   /* barrier panel */
function cdConc()  { return mix(C.grey, C.white, 0.30); }    /* site concrete */
/* bariyer red.  The same ten per cent of white the ground section's water
   barrier carries, so the two objects standing in one frame are one red. */
function cdRed()   { return mix(C.red, C.white, 0.10); }     /* signal red    */

/* THE HAZARD TONE, and it is a MULTIPLIER ON THE ATLAS, not an albedo.
   The kit paints the chevron cell chrome yellow #e8c024 = linear
   [0.807,0.527,0.018] and the kapali board #e8c531 alongside it; the sign
   pile's bake floor is 0.64, its material carries no CARD_GAIN, and nothing
   between the canvas and the frame takes a single per cent off either.  Toned
   C.white a chevron lands at Y 0.455 against a cream render wall at about
   0.58 - close enough in luminance that on a grey overcast street the
   SATURATION carries it and the yellow reads brighter than the wall it is
   standing in front of, which is exactly what the thirty-metre renders came
   back with.  This pulls green harder than red and takes blue down with both:
   the chrome goes to a dirty ochre, sRGB (193,152,24) at Y 0.340, a quarter
   darker and a long way less chrome, and the black chevrons darken with it
   rather than floating on a field that has been left brighter than they are.
   Every 'hazard' and every 'kapali' card in this file is toned with it.

   THE RULE THAT GOES WITH IT, because the first build broke it on all four
   closures: a Turkish road closure carries ONE chevron board, on or near the
   centreline, and the rest of the line is the red-and-white panel.  The only
   other place yellow-and-black is allowed on this street is a 600 mm band at
   the base of a mast - and there is not one in the file, because all six
   masts stand BEHIND their line where the panel and the revetment cover their
   bases from every angle the player has, so a band there would buy no reading
   and six more yellow objects in a section that had too many. */
var CD_HAZ = [0.66, 0.60, 0.52];

/* Ground soiling AND up-face grime in ONE callback, because a concrete
   plinth needs both and two materials for it would be two draw calls.  The
   splash band is the kit's 420 mm / 32% figure; the up term is upTone's. */
function cdWeather(base, y0, span) {
  var sp = span || 1.47;
  return function (pt, ny) {
    var k = 0.68 + 0.32 * clamp((pt[1] - y0) / sp, 0, 1);
    var b = [base[0] * k, base[1] * k, base[2] * k];
    return mix(b, UPGRIME, Math.pow(clamp(ny, 0, 1), 1.5) * 0.55);
  };
}

/* THE GROUND UNDER A 232 CLOSURE IS NOT FLAT.  The line crosses, west to
   east: paving at y 0.62, a kerb block at 0.66, 63 u of carriageway at 0.12,
   the far kerb and the far paving.  A run laid at one height either buries
   its two end base-plates half a metre under the footway or floats them.
   Each post asks this for the ground it actually stands on; the panel and
   the rails stay level, the way a line of hand-placed bariyer does. */
function cdArmGroundY(x) {
  if (x < ROAD0 - 1) return PAVE_TOP;         /* 484.00..499.50 paving  */
  if (x < ROAD0)     return KERB_TOP;         /* 499.50..500.50 kerb    */
  if (x < ROAD1)     return ROAD_TOP;         /* 500.50..563.50 road    */
  if (x < ROAD1 + 1) return KERB_TOP;         /* 563.50..564.50 kerb    */
  return PAVE_TOP;                            /* 564.50..580.00 paving  */
}

/* A pile's tile is world units per texture repeat and it is fixed per pile,
   but the uv is written at vertex time - so an object that needs a different
   scale borrows the pile for the length of one builder and hands it back.
   The gate block is the only user: it is a 15.7 m concrete tower and at the
   render pile's tile 9 it carries six tiles of apartment cement-render
   speckle, which reads as siva rather than as shuttered concrete. */
function cdTile(pile, t) { var was = pile.tile; pile.tile = t; pile.inv = 1 / t; return was; }

/* A truncated cone between two rings, wound outward from a reference point
   on the axis.  poly() does the winding, so nothing here tracks orientation.
   r1 = 0 emits triangles to the apex instead of quads. */
function cdFrustum(pile, cx, cz, y0, y1, r0, r1, seg, ao, tone) {
  var i, TAU = Math.PI * 2, ref = [cx, (y0 + y1) * 0.5, cz];
  for (i = 0; i < seg; i++) {
    var a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU;
    var p00 = [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0];
    var p01 = [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0];
    if (r1 < 1e-4) {
      poly(pile, [p00, p01, [cx, y1, cz]], ref, ao, tone);
    } else {
      poly(pile, [p00, p01,
                  [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1],
                  [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1]], ref, ao, tone);
    }
  }
}
/* a flat disc, normal away from `ref` */
function cdDisc(pile, cx, cz, y, r, seg, ref, ao, tone) {
  var i, TAU = Math.PI * 2, pts = [];
  for (i = 0; i < seg; i++) {
    var a = i / seg * TAU;
    pts.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
  }
  poly(pile, pts, ref, ao, tone);
}

/* THE OCCLUDER BUDGET FOR THIS SECTION.  OCC_CAP is 45 for the whole module
   and the four sections that run before this one take fourteen, twelve, ten
   and eight, so the cordon runs last into a registry that may already be
   full.  occ() warns when it is, and a warning here is a warning in the
   install report for something that is nobody's bug, so the count is checked
   BEFORE the call and the boxes are registered in the order the builders run
   in, which is also the order of what the player actually stands next to: the
   two 232 lines, the two stub lines, then the gate cap.  SIX boxes rather
   than the eight the brief allows, one per line instead of two: with the four
   sections ahead of this one taking thirty-five between them there is not
   room for eight, and one 25.8 u box under a closure buys almost all of the
   contact shadow two would.  Every box sits UNDER its object and never around
   it - hitsBoxT exempts only a ray origin STRICTLY inside a box, so a box
   drawn round a post bakes the post black. */
function cdOcc(x0, y0, z0, x1, y1, z1) {
  if (cdOcc.n === undefined) cdOcc.n = 0;
  if (cdOcc.n >= 6 || OCC.length >= OCC_CAP) return;
  if (Math.abs(x1 - x0) > 26 || Math.abs(y1 - y0) > 26 || Math.abs(z1 - z0) > 26) {
    warn('cordon occluder over 26 u dropped'); return;
  }
  occ(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
      Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
  cdOcc.n++;
}


/* ---------------------------------------------------------------------------
   MOVING AN ASSEMBLY, AND WHY IT IS A ROTATION AND NOT A MIRROR

   The uphill pass moved the checkpoint from the east police line to the park
   crest.  Everything in section 10.6..10.9 is authored in absolute world
   coordinates around x 826..848, z 160..188, facing WEST because that is the
   side the player used to come from; at the crest he comes from the EAST, and
   the crest is twenty units higher.

   Re-typing 300 coordinates is how a checkpoint acquires a coplanar face and
   an inside-out reveal, so nothing is re-typed.  The builders run exactly as
   written and the vertices they emit are then moved: a HALF TURN about a
   vertical axis, plus a lift in y.

   A half turn, not a mirror.  Mirroring x is a reflection: it flips the
   handedness of every triangle, so every face this module winds
   counter-clockwise comes out clockwise and the whole block renders inside
   out (or, with FrontSide, not at all).  A rotation is a proper motion --
   winding survives, and the only thing a 180-degree turn about +Y does to a
   normal is negate its x and z, which is exactly what its faces did.

     x' = 2*cx - x      nx' = -nx
     z' = 2*cz - z      nz' = -nz
     y' = y + dy        ny' =  ny

   Solving for the three things that have to land.

   THE BLOCK FACE.  At the east the block's front is x 831.90, one tenth in
   front of the blocked column 208 whose boundary is x 832 -- close enough to
   read as the face of the line, far enough that it is not coplanar with
   buildWorld's own wall, and unreachable anyway behind the player's 1.15 hull
   radius.  At the crest the blocked column is 66, x 264..268, and the player
   stands EAST of it, so the same tenth is on the other side: the face wants
   x 268.10.  That gives cx = (831.90 + 268.10) / 2 = 550.0.

   AND IT IS THE DOOR HEADER THAT SETS IT, not taste.  buildWorld draws the
   keycard cell's header on BOTH of its x faces, 264 and 268; a block whose
   front stopped at 266.35 would cover the far one and leave the near one --
   the one the player walks up to -- as a four-unit-wide strip of door texture
   running fifty units up the sky.  Fronted at 268.10 the block's 16 u depth
   swallows both.

   THE LANE.  z 174 at the east must become z 162 at the crest (grid row 40,
   the centre of the north carriageway), so cz = (174 + 162) / 2 = 168, and
   the archway's z 167.9..180.1 lands on 155.9..168.1 around it.

   THE GRADE.  The crest is parkFloorAtCell(66) = 20.02 against the east
   line's ROAD_TOP of 0.12, so dy = 19.90.

   The tone callbacks and the macro grime field are evaluated at vertex time,
   i.e. at the AUTHORED position.  That is correct rather than a compromise:
   cdWeather measures its splash band from ROAD_TOP, and the block's own
   ground is ROAD_TOP where it is authored; lifting y afterwards carries the
   finished gradient with it instead of measuring it from a datum twenty units
   below the ground the block actually stands on.
   ------------------------------------------------------------------------ */
var CD_SPIN = { cx: 550.0, cz: 168.0, dy: 19.90 };

function cdMark() {
  var m = {}, k;
  for (k in P) if (Object.prototype.hasOwnProperty.call(P, k)) m[k] = P[k].n;
  m.__occ = OCC.length;
  return m;
}
function cdSpin(mark) {
  var cx = CD_SPIN.cx, cz = CD_SPIN.cz, dy = CD_SPIN.dy, k, i, pl, p, nm;
  for (k in mark) {
    if (k === '__occ') continue;
    pl = P[k]; if (!pl) continue;
    p = pl.p; nm = pl.nm;
    for (i = mark[k]; i < pl.n; i++) {
      p[i * 3]     = 2 * cx - p[i * 3];
      p[i * 3 + 1] = p[i * 3 + 1] + dy;
      p[i * 3 + 2] = 2 * cz - p[i * 3 + 2];
      nm[i * 3]     = -nm[i * 3];
      nm[i * 3 + 2] = -nm[i * 3 + 2];
    }
  }
  /* the occluders are axis-aligned boxes and a half turn maps one onto
     another; the two swapped corners have to be re-ordered or occ()'s own
     "inverted or flat" guard would have thrown them away on the way in */
  for (i = mark.__occ; i < OCC.length; i++) {
    var o = OCC[i];
    var nx0 = 2 * cx - o.x1, nx1 = 2 * cx - o.x0;
    var nz0 = 2 * cz - o.z1, nz1 = 2 * cz - o.z0;
    o.x0 = nx0; o.x1 = nx1; o.z0 = nz0; o.z1 = nz1;
    o.y0 += dy; o.y1 += dy;
  }
}


/* ---------------------------------------------------------------------------
   10.1  THE BARRICADE

   A Turkish police bariyer: a galvanised tube frame, two rails, a pressed
   sheet panel between them carrying diagonal hazard stripes, two splayed
   legs per post and a weighted foot plate.

   WHAT THIS REPLACES, because the numbers are the whole finding: the old
   barrierRun computed n = max(3, round(span/8.4)), so a 30 u closure came out
   as FOUR alternating panels and every red or white band was 7.5 u = 2.14 m
   of flat vertex tone - four coloured slabs from 20 m away.  The panel was a
   0.72 u box, which is 206 mm: a concrete beam, not a 34 mm sheet.  There was
   one rail where the real object has two, and every post balanced on a single
   skewed diagonal stick.

   Now: ONE continuous panel per run, 0.12 u = 34 mm thick, painted RED AND
   WHITE, with ONE chevron board on the centreline.  The stripes and the board
   are on the near face only - the far face of a closure is never seen from
   anywhere the player can stand, and painting both costs a second card and a
   second set of bands for nothing.

   WHAT THIS SECOND PASS CHANGES, and it is the whole of the yellow finding:
   the build before this one solved four chevrons to 3.5 u and then laid that
   card end to end down the entire run - seven of them on each 232 line, eight
   on each 230 line, thirty in the section - so 89 per cent of the length of
   every barricade and 78 per cent of its height was chrome yellow, the cards
   ran straight across the intermediate posts, and from thirty metres the
   cordon was the brightest thing in the street: brighter than the shopfronts,
   brighter than the sky on the wall.  A Turkish closure does use the
   yellow-black board, but ONE of them, on the centreline, and the line either
   side of it is the red-and-white panel.  So the chevrons are now a single
   1400 x 500 mm board on its own backing plate at the middle of each run, and
   the red arrives as diagonal bands on the sheet.

     panel   y+2.03..y+3.64   (0.46 m, the sheet)
     rail    y+0.88..y+1.30   (a 60 mm scaffold tube on its own centres)
     posts   r 0.13 (37 mm) at 8.4 u = 2.40 m centres, up to y+3.99 (1.14 m)
     legs    two per post, splayed 1.30 u across the line
     plate   1.4 x 1.4 x 0.20, chamfered, the ballast that stands it up

   a0/a1 are the run's extents on its own axis, c the other horizontal, axis
   'x' or 'z', y the level the RAILS are set out from.  nearDir (+1/-1) is the
   side the player is on and decides which face carries the stripes.  gfn, if
   given, returns the ground height under a given position on the run.
   ------------------------------------------------------------------------ */
function barrierRun(a0, a1, c, axis, y, nearDir, gfn) {
  var sw;
  if (a1 < a0) { sw = a0; a0 = a1; a1 = sw; }
  var span = a1 - a0;
  if (!(span > 3.0)) { warn('barrierRun: span ' + span.toFixed(2) + ' too short at ' + c); return; }
  var xz = (axis !== 'z');
  var nd = (nearDir === -1) ? -1 : 1;
  var galv = cdGalv(), sheet = cdSheet();
  var i;

  /* ---- the sheet panel.  P.joinery, not P.metal: a bariyer panel is
     painted, and M.metal is metalness 0.62, which has almost no diffuse lobe
     left to carry a tone - every painted element that went through it in the
     build this replaces came back as tinted chrome. */
  var py0 = y + 2.03, py1 = y + 3.64, HT = 0.06;
  if (xz) box6(P.joinery, a0, a1, py0, py1, c - HT, c + HT, 1, sheet);
  else    box6(P.joinery, c - HT, c + HT, py0, py1, a0, a1, 1, sheet);

  /* the rolled top and bottom edges of the pressing.  They are 26 mm and
     sub-pixel at 20 m, but they are what stops the panel reading as card. */
  var eA = xz ? [a0 + 0.02, py1, c] : [c, py1, a0 + 0.02];
  var eB = xz ? [a1 - 0.02, py1, c] : [c, py1, a1 - 0.02];
  tube(P.joinery, eA, eB, 0.09, 5, sheet, false, false);
  eA[1] = eB[1] = py0;
  tube(P.joinery, eA, eB, 0.09, 5, sheet, false, false);

  /* ---- THE RED.  The panel keeps its white ground and the red arrives as
     diagonal bands on the near face, 0.02 proud of the sheet at 45 degrees,
     which is how the stripe on a bariyer is masked and sprayed.  The pitch is
     SOLVED TO THE RUN rather than fixed - np = round(span / 2.94), so both
     ends of every line finish on white and no run carries a half band.  It
     comes out at nine bands of 1.533 u on each 232 run and ten of 1.460 on
     each 230 run, which is 310 and 295 mm measured PERPENDICULAR to the
     stripe: the width on the real pressing, and a seventh of the 2.14 m
     slabs the barricade before this one painted.
     A band that starts before a0 or runs past a1 has its outer corners
     clamped to the run's ends rather than properly clipped.  A true clip is a
     pentagon; the wedge this leaves instead is at most 12 mm of taper on the
     two end bands, which is under the rolled edge that runs over it. */
  var red = cdRed(), sy = nd * (HT + 0.02), PH = py1 - py0;
  var np = Math.max(2, Math.round(span / 2.94)), bp = span / np, sbw = bp * 0.5;
  for (i = 0; i < np; i++) {
    var sA = a0 + i * bp - PH * 0.5, sB = sA + sbw;  /* the bottom edge      */
    var b0 = clamp(sA, a0, a1), b1 = clamp(sB, a0, a1);
    var u0 = clamp(sA + PH, a0, a1), u1 = clamp(sB + PH, a0, a1);
    poly(P.joinery,
         xz ? [[b0, py0, c + sy], [b1, py0, c + sy], [u1, py1, c + sy], [u0, py1, c + sy]]
            : [[c + sy, py0, b0], [c + sy, py0, b1], [c + sy, py1, u1], [c + sy, py1, u0]],
         xz ? [(b0 + u1) * 0.5, (py0 + py1) * 0.5, c - nd]
            : [c - nd, (py0 + py1) * 0.5, (b0 + u1) * 0.5],
         1, red);
  }

  /* ---- the lower rail: a 60 mm tube on its own centres, y+0.88..y+1.30 */
  var rA = xz ? [a0, y + 1.09, c] : [c, y + 1.09, a0];
  var rB = xz ? [a1, y + 1.09, c] : [c, y + 1.09, a1];
  tube(P.metal, rA, rB, 0.21, 7, galv, true, false);

  /* ---- posts, legs, plates.  8.4 u nominal centres; the run is divided
     evenly so the two end posts land exactly on the run's ends. */
  var n = Math.max(2, Math.round(span / 8.4));
  for (i = 0; i <= n; i++) {
    var s = lerp(a0, a1, i / n);
    var gy = gfn ? gfn(s) : y;
    var pA = xz ? [s, gy, c] : [c, gy, s];
    var pB = xz ? [s, y + 3.99, c] : [c, y + 3.99, s];
    tube(P.metal, pA, pB, 0.13, 7, galv, true, false);

    /* two splayed legs, not one skewed stick.  They lean ACROSS the line,
       which is the axis a barricade is pushed on. */
    var kk;
    for (kk = -1; kk <= 1; kk += 2) {
      var lA = xz ? [s, gy + 1.62, c] : [c, gy + 1.62, s];
      var lB = xz ? [s, gy + 0.14, c + kk * 1.30] : [c + kk * 1.30, gy + 0.14, s];
      tube(P.metal, lA, lB, 0.10, 6, galv, true, false);
    }
    /* the ballast plate: 1.4 x 1.4 x 0.20, chamfered, in upTone so its top
       face does not clip past 245 sRGB when the dome hands it 2.00.  Its
       underside is set 0.04 BELOW the surface it stands on: a plate whose
       bottom face is coplanar with the road deck is two quads fighting over
       the same depth for the whole of its 1.96 square units. */
    var cx = xz ? s : c, cz = xz ? c : s;
    boxC(P.metal, cx, gy + 0.08, cz, 0.70, 0.12, 0.70, 0.055, 1, upTone(galv));

    /* a rust weep down a third of the posts, from the leg bosses.  Positional
       grime cannot live in a tiling map, which is what the decal atlas is
       for; without it galvanised steel reads as new. */
    if (hash(i * 3.7 + c * 0.11) > 0.66) {
      var wc = xz ? [s, gy + 1.95, c + nd * 0.20] : [c + nd * 0.20, gy + 1.95, s];
      decalCard(P.decal, D_RUST, wc[0], wc[1], wc[2],
                xz ? 1 : 0, 0, xz ? 0 : 1, 0, 1, 0,
                0.62, 2.30, mix(C.rail, C.dark, 0.30),
                xz ? [0, 0, nd] : [nd, 0, 0]);
    }
  }

  /* ---- THE CHEVRON BOARD.  ONE per closure, at the middle of the run, which
     on all four lines is the street's own centreline to within a hundredth of
     a unit: the 232 runs are 550.20..577.80 and the carriageway is 552..576,
     so both centre on x 564.0, and the 230 runs are 761.40..790.60 against a
     760..792 carriageway, so both centre on x 776.0.  That is where a Turkish
     closure hangs its board and it is the only place one belongs.

     The cell is 12 px of transparent gutter round four MITRED black polylines
     on chrome yellow and its capFrac is 1, so signCard's capH IS the card
     height and the width follows the cell aspect.  4.90 u of card = 1.40 m
     wide by 0.50 m tall, which is the levha the municipality buys, and it is
     bolted to the FRONT of the panel on its own backing plate rather than
     painted on it: the plate stands 0.12..0.30 proud with the card 0.06 clear
     of its face - the same clearance the POLIS boards take - it overhangs the
     0.46 m sheet by 55 mm top and bottom, and it is the one thing on the line
     that is meant to be read.  Tone CD_HAZ, not C.white - see the note on it. */
  var hz = signSize('hazard', 1);
  if (hz && hz.aspect > 0.2) {
    var cardW = 4.90, cardH = cardW / hz.aspect;      /* 1.40 x 0.50 m */
    var hs = (a0 + a1) * 0.5, hy = (py0 + py1) * 0.5;
    var bt = nd * 0.21;                               /* board centre, 60 mm  */
    var bk = mix(C.white, C.steel, 0.24);             /* the pressed backing  */
    /* the backing plate.  Its back face is at 0.12, which clears the rolled
       edge tubes' 0.09 by 30 mm - a plate resting ON those two rolls would be
       two curved surfaces meeting a flat one along a tangent line. */
    if (xz) boxC(P.joinery, hs, hy, c + bt, cardW * 0.5 + 0.11, cardH * 0.5 + 0.11,
                 0.09, 0.05, 1, bk);
    else    boxC(P.joinery, c + bt, hy, hs, 0.09, cardH * 0.5 + 0.11,
                 cardW * 0.5 + 0.11, 0.05, 1, bk);
    /* two clamp brackets down into the sheet.  Their back face is at 0.045,
       INSIDE the panel's own 0.06, because a bracket whose back is coplanar
       with the face it is bolted to is a z-fight the width of the bracket. */
    var kk2;
    for (kk2 = -1; kk2 <= 1; kk2 += 2) {
      var ks = hs + kk2 * (cardW * 0.5 - 0.55);
      if (xz) boxC(P.metal, ks, hy, c + nd * 0.1275, 0.16, 0.34, 0.0825, 0.03, 1, galv);
      else    boxC(P.metal, c + nd * 0.1275, hy, ks, 0.0825, 0.34, 0.16, 0.03, 1, galv);
    }
    var off = nd * 0.36;              /* 0.06 clear of the plate face */
    signCard(P.sign, 'hazard',
             xz ? hs : c + off, hy, xz ? c + off : hs,
             xz ? 1 : 0, 0, xz ? 0 : 1, 0, 1, 0,
             cardH, CD_HAZ, xz ? [0, 0, nd] : [nd, 0, 0]);
  }

  /* ---- the soil band that collects along the foot of anything left in a
     road for a month.  It is laid at y + 0.062 on the carriageway only: the
     ground plane already carries markings at +0.030, patches at +0.035, a
     gully grate at +0.045 and a manhole at +0.052, and NOTHING is allowed to
     share a y with any of them. */
  var g0 = a0, g1 = a1;
  if (xz) { g0 = Math.max(a0, ROAD0); g1 = Math.min(a1, ROAD1); }
  if (g1 - g0 > 4.0) {
    var nb = Math.max(1, Math.round((g1 - g0) / 8.0)), bw = (g1 - g0) / nb;
    for (i = 0; i < nb; i++) {
      var bs = g0 + (i + 0.5) * bw;
      decalCard(P.decal, D_GROUND,
                xz ? bs : c, y + 0.062, xz ? c : bs,
                xz ? 1 : 0, 0, xz ? 0 : 1,
                xz ? 0 : 1, 0, xz ? 1 : 0,
                bw, 2.60, mix(C.asphalt, C.soil, 0.42), [0, 1, 0]);
    }
  }
  STATS.barricades++;
}


/* ---------------------------------------------------------------------------
   10.2  TRAFFIC CONE

   ONE cone in three tone bands emitted in a single pass, with a base cap and
   a moulded foot.  What this replaces: the white band was a SECOND SOLID CONE
   at r 0.44 whose base sat 4.5 mm inside the red cone's 0.456 radius, and at
   seven segments the facet chords cut 10% inside the circumscribed radius, so
   the white cone poked through the red one around most of the ring and
   z-fought where it did not.  Nine call sites did this.

   0.72 u base radius = 206 mm and 2.40 u = 686 mm tall is a 700 mm cone,
   which is the size a municipality buys.  Ten segments, not seven.
   ------------------------------------------------------------------------ */
function trafficCone(x, z, y) {
  var SEG = 10;
  /* PVC, so P.joinery - a cone on M.metal is a chrome cone.  Fluorescent
     orange leans C.red toward C.gold; the sleeve is retroreflective white,
     which is a shade cooler and brighter than the render whites. */
  var body = mix(C.red, C.gold, 0.12);
  var band = mix(C.white, C.steel, 0.08);
  /* dirtier at the foot: a cone lives in a gutter */
  var bodyT = groundTone(body, y + 0.12, 1.05);

  var ys = [y + 0.12, y + 1.05, y + 1.62, y + 2.52];
  var rs = [0.72, 0.44, 0.27, 0.055];
  cdFrustum(P.joinery, x, z, ys[0], ys[1], rs[0], rs[1], SEG, 1, bodyT);
  cdFrustum(P.joinery, x, z, ys[1], ys[2], rs[1], rs[2], SEG, 1, band);
  cdFrustum(P.joinery, x, z, ys[2], ys[3], rs[2], rs[3], SEG, 1, body);
  /* the top disc and the BASE CAP.  Every cone in the build this replaces was
     an open shell you looked up into from below under a FrontSide material. */
  cdDisc(P.joinery, x, z, ys[3], rs[3], SEG, [x, ys[3] - 1, z], 0.94, body);
  cdDisc(P.joinery, x, z, ys[0], rs[0], SEG, [x, ys[0] + 1, z], 0.62, body);

  /* the moulded foot, 3.15 x 3.15 x 0.16 = 900 x 900 x 46 mm, its underside
     0.04 into the deck so no two up-facing quads share a y */
  boxC(P.joinery, x, y + 0.06, z, 1.575, 0.10, 1.575, 0.055, 1,
       upTone(mix(body, C.dark, 0.22)));
  STATS.cones++;
}


/* ---------------------------------------------------------------------------
   10.3  SANDBAG REVETMENT

   Three courses, 1.35 x 0.68 x 1.70 u bags (386 x 194 x 486 mm) with a 0.7 u
   course offset so the joints break, on P.render because hessian is a matt
   mineral surface and the render map is the only near-white relief in the
   module with a grain that size.  Each bag is chamfered hard (k 0.20) and
   given its own settle and its own tone - a stack of identical sharp boxes is
   the single loudest "nobody looked at this" cue on a checkpoint.

   AND IT WAS STILL A STACK OF BOXES, which is what the checkpoint render came
   back saying.  boxC clamps k to 0.49 of the SMALLEST half extent, and on a
   0.68 u bag that is the height, so the bag was already as round as one box
   can be made and the chamfer had nothing left to give.  What was wrong was
   never the corner: it was that every bag in a course was the same 0.68 u
   tall and the same 1.70 u deep, so the top of a course was one dead straight
   line across five bags and the face of the wall was one dead flat plane.
   Three things fix it and none of them is a chamfer - the height varies
   0.60..0.78 u, the depth and the lateral set vary with a SECOND hash draw,
   and each bag carries a crown: a smaller block riding half-sunk on top of it
   with its own maximum chamfer, which is the bulge a filled bag has and the
   only part of this that is actually shape rather than jitter.
   ------------------------------------------------------------------------ */
function sandbags(x, z, y, along, n) {
  var i, j, xz = (along !== 'z');
  var lo = 0, hi = 0;
  for (j = 0; j < 3; j++) {
    for (i = 0; i < n - j; i++) {
      var h4 = hash(i * 5.1 + j * 17.3 + x * 0.07);
      /* the second draw.  One hash driving length, height, depth, set AND
         tone together gives every bag in a course the same bag at a different
         value, which is a pattern rather than a pile. */
      var h5 = hash(i * 2.3 + j * 9.7 + x * 0.13 + 4.1);
      var o = j * 0.7 + i * 1.5 + (h4 - 0.5) * 0.16;
      var sag = j * 0.66;                       /* courses settle into each other */
      var t = mix(C.sand, C.dark, 0.10 + h4 * 0.16);
      var bh = 0.30 + h5 * 0.09;                /* half height, 171..223 mm     */
      var bd = 0.76 + h4 * 0.10;                /* half depth across the wall   */
      var bl = 0.675 - h4 * 0.04;               /* half length along the run    */
      var cy = y + sag - 0.04 + bh;             /* bottom course 0.04 into the deck */
      var cA = (xz ? x : z) + o + 0.675;
      var cB = (xz ? z : x) + (h5 - 0.5) * 0.16;  /* the face is not flat either */
      var tn = cdWeather(t, y, 1.05);
      /* the long axis follows `along`; the bag is 1.52..1.72 across, which is
         a two-deep wall in one box - the courses are what read, not the bags */
      if (xz) boxC(P.render, cA, cy, cB, bl, bh, bd, 0.20, 1, tn);
      else    boxC(P.render, cB, cy, cA, bd, bh, bl, 0.20, 1, tn);
      /* the crown, 0.86 of the length and 0.80 of the depth, sunk 0.55 of its
         own height into the bag under it and shifted off centre so the pile
         does not grow a second straight line where the first one was.  k is
         passed as its own half height, which boxC clamps to 0.49 of that -
         the roundest thing the primitive will make. */
      var ch = bh * 0.42, cyy = cy + bh - ch * 0.55, cs = (h4 - 0.5) * 0.10;
      if (xz) boxC(P.render, cA + cs, cyy, cB, bl * 0.86, ch, bd * 0.80, ch, 1, tn);
      else    boxC(P.render, cB, cyy, cA + cs, bd * 0.80, ch, bl * 0.86, ch, 1, tn);
      if (j === 0) { if (i === 0) lo = cA - 0.7; hi = cA + 0.7; }
    }
  }
  /* the soil line where the stack meets the road */
  var mid = (lo + hi) * 0.5, len = Math.max(2.0, hi - lo);
  decalCard(P.decal, D_GROUND,
            xz ? mid : x, y + 0.064, xz ? z : mid,
            xz ? 1 : 0, 0, xz ? 0 : 1,
            xz ? 0 : 1, 0, xz ? 1 : 0,
            len, 2.90, mix(C.asphalt, C.soil, 0.38), [0, 1, 0]);
}


/* ---------------------------------------------------------------------------
   10.4  FLOODLIGHT MAST

   Shaft r 0.34 (194 mm) to y 21.70 = 6.20 m, a base collar and flange, the
   housing at y 21.00..23.10 and the LENS AT 20.60..20.94 - offset 0.06 clear
   below the housing.  In the build this replaces the lens sat at 20.79..21.07
   against a housing starting at 21.00: a 20 mm overlap between a
   depth-writing transparent box and an opaque one, on all three masts.

   NO THREE.js LIGHT.  r149 cannot mask a light per object and the night half
   of the campaign shares this scene; these lamps are switched off anyway, so
   what is modelled is what they are on an overcast morning - a grey housing
   and a cold, dead lens.
   ------------------------------------------------------------------------ */
function floodMast(x, z, y) {
  var galv = cdGalv(), dark = mix(C.steel, C.dark, 0.42);
  var top = 21.70;

  /* flange plate and base collar - a mast is bolted to a pad, never sunk.
     0.90 half-width so the flange never oversails the cast pier the two
     checkpoint masts stand on. */
  boxC(P.metal, x, y + 0.12, z, 0.90, 0.16, 0.90, 0.10, 1, upTone(galv));
  tube(P.metal, [x, y + 0.02, z], [x, y + 1.05, z], 0.52, 8, galv, true, false);
  tube(P.metal, [x, y + 1.00, z], [x, top, z], 0.34, 8, galv, true, false);
  /* the cable conduit clipped up the shaft, 0.40 off the axis */
  tube(P.metal, [x - 0.40, y + 1.05, z], [x - 0.40, top - 1.6, z], 0.075, 5,
       mix(C.pipe, C.dark, 0.30), true, false);

  /* the head: a bracket off the shaft and the housing hung on it */
  tube(P.metal, [x, top - 0.9, z], [x - 1.30, 22.05, z], 0.16, 6, dark, true, false);
  boxC(P.metal, x - 1.30, 22.05, z, 2.10, 1.05, 0.80, 0.16, 1, upTone(dark));
  /* the lens: ONE down-facing quad, not a box.  A box on M.glass draws its
     near and far faces at 0.78 each and composites to 0.95 - a pale slab. */
  poly(P.glass, [[x - 3.40, 20.60, z - 0.62], [x - 3.40, 20.60, z + 0.62],
                 [x + 0.80, 20.60, z + 0.62], [x + 0.80, 20.60, z - 0.62]],
       [x - 1.30, 21.60, z], 0.88, mix(C.glass, C.white, 0.52));
  /* a weep off the flange, because the water runs off the flange */
  decalCard(P.decal, D_RUST, x, y + 1.55, z + 0.56, 1, 0, 0, 0, 1, 0,
            0.90, 2.60, mix(C.rail, C.dark, 0.34), [0, 0, 1]);
}


/* ---------------------------------------------------------------------------
   10.5  WARNING PLATE

   A YOL KAPALI board on a single post.  The front is sheet steel at
   [0.90,0.90,0.90] and the BACK is [0.42,0.43,0.44] - a sign is a pressing
   and the back of one is never the same value as the front, which is the
   single cheapest thing that stops a road sign reading as a floating decal.

   signCard fixes ao at 1, so the back's value is carried in the tone rather
   than in an ao term.  The board is sized from signSize() rather than from
   the nominal 0.9625 u cap: scale capH down rather than let the board
   overhang the plate it is screwed to.  'YOL KAPALI' at the full cap is
   2.3 m of lettering and this
   plate is 6.8 u = 1.94 m wide.
   ------------------------------------------------------------------------ */
function warningPlate(x, z, y, facing) {
  var PW = 6.80, PH = 3.00, top = 8.05;
  var galv = cdGalv();
  var dir = (facing === 'z-') ? [0, 0, -1] : (facing === 'z+') ? [0, 0, 1] :
            (facing === 'x-') ? [-1, 0, 0] : [1, 0, 0];
  var alongZ = (dir[0] !== 0);                 /* board spans z when it faces x */

  tube(P.metal, [x, y, z], [x, top, z], 0.16, 7, galv, true, false);
  boxC(P.metal, x, y + 0.07, z, 0.55, 0.11, 0.55, 0.05, 1, upTone(galv));

  var cy = top - PH * 0.5 - 0.20;
  var hx = alongZ ? 0.07 : PW * 0.5, hz = alongZ ? PW * 0.5 : 0.07;
  boxC(P.joinery, x + dir[0] * 0.20, cy, z + dir[2] * 0.20,
       hx, PH * 0.5, hz, 0.05, 1, [0.90, 0.90, 0.90]);
  /* the grey back, as its own quad 0.02 behind the plate's rear face */
  if (alongZ)
    panelX(P.joinery, x + dir[0] * 0.20 - dir[0] * 0.09, cy - PH * 0.5, cy + PH * 0.5,
           z - PW * 0.5, z + PW * 0.5, -dir[0], 0.80, [0.42, 0.43, 0.44]);
  else
    panelZ(P.joinery, z + dir[2] * 0.20 - dir[2] * 0.09, cy - PH * 0.5, cy + PH * 0.5,
           x - PW * 0.5, x + PW * 0.5, -dir[2], 0.80, [0.42, 0.43, 0.44]);

  /* two channel stiffeners across the back, which is how these are made */
  var i;
  for (i = -1; i <= 1; i += 2) {
    if (alongZ) box6(P.metal, x + dir[0] * 0.02, x + dir[0] * 0.14,
                     cy + i * 0.85 - 0.12, cy + i * 0.85 + 0.12,
                     z - PW * 0.42, z + PW * 0.42, 0.72, galv);
    else        box6(P.metal, x - PW * 0.42, x + PW * 0.42,
                     cy + i * 0.85 - 0.12, cy + i * 0.85 + 0.12,
                     z + dir[2] * 0.02, z + dir[2] * 0.14, 0.72, galv);
  }

  var sz = signSize('kapali', SIGN_CAP);
  var capH = SIGN_CAP;
  if (sz && sz.w > PW - 0.9) capH = SIGN_CAP * (PW - 0.9) / sz.w;
  /* CD_HAZ, not C.white.  The kapali cell is the same chrome yellow as the
     chevron - #e8c531 against the chevron's #e8c024 - and there are four of
     these boards standing at 1.29..2.30 m on posts BEHIND the four lines,
     which is head height and dead centre of frame down both arms.  Toned
     white they were the second brightest yellow in the street after the
     chevron plates; toned down they read as a board that has stood out in a
     road for a month, which is what they are.  The plate around them keeps
     its [0.90,0.90,0.90] sheet steel - the sign gets dirty, not the pressing
     it is screwed to. */
  signCard(P.sign, 'kapali',
           x + dir[0] * 0.30, cy, z + dir[2] * 0.30,
           alongZ ? 0 : 1, 0, alongZ ? 1 : 0, 0, 1, 0,
           capH, CD_HAZ, dir);
}


/* ---------------------------------------------------------------------------
   10.6  THE GATE BLOCK

   The grid carves a lane through the east police line at cells (209..212,43)
   and puts a red keycard door on cell (208,43).  buildWorld draws a door
   header from min(c, f + 8.2) to the region ceiling on BOTH open faces of a
   door cell, and out here the ceiling is 52 - so the level hands this lane a
   4 u wide, 44 u tall grey slab standing in the middle of the road.  It
   cannot be hidden and lowering the ceiling only relocates it into the
   neighbour's wall, so it is not hidden: it is BUILT INTO a concrete gate
   block with an archway, which is what a hard checkpoint has anyway.

   THE COMPOSITION, and every plane in it is set by something:
     x 832.00   buildWorld's own 52 u concrete wall on the police line
     x 831.95   the tunnel cladding and the arch's blind backs, 0.05 clear
     x 831.90   the block face, 0.10 in front of the engine wall
     x 831.40   the portal surround, the string course and the shuttering
                bands' outer line, 0.50 proud
     x 831.05   the plinth, 0.95 proud
     x 830.85   as close as the player can ever get - his hull radius is
                1.15 and he collides on the x = 832 cell boundary, so every
                plane above is out of his reach and none of them can be
                walked into.  This is the whole licence for building the
                block as relief rather than as a 0.10 u bump.
     x 830.50   the cap, at y 52.4, where reach stopped mattering

   THE ARCHWAY is z 167.90..180.10 with its head at y 12.20 - set out 0.10 and
   0.20 over the plan's nominal 12.0 x 12.0 so that after the reveal linings
   take their 0.02 and the road deck its 0.12 the CLEAR opening is still
   12.16 u = 3.47 m wide by 12.06 u = 3.45 m high.  The one it replaces was
   4.8 u = 1.37 m wide with 2.37 m of head: it could not pass the boom the
   same function hangs across it, it could not pass a vehicle and it could not
   pass two players abreast.  Its two flanks (z 167.9..172 and 176..180.1) are
   BLIND - the engine's wall is 0.10 behind them, which is the correct back
   for them and is textured concrete like the rest - and only the middle 4 u
   is a passage.

   THE PASSAGE is real and has to be: cells (209..212, 43) are carved, so
   x 836..848 at z 172..176 is FLOOR THE PLAYER WALKS ON and a solid block
   there would put him inside fifteen metres of concrete.  So the block is
   bored through on that row, its ceiling at y 8.05 - which is also what
   hides both of the engine's door headers, since they start at f + 8.2.
   ------------------------------------------------------------------------ */
function gateBlock() {
  var GXW = 831.90, GXE = 848.00;          /* block face and back           */
  var BZ0 = 160.00, BZ1 = 188.00;          /* the block's own ends          */
  var AZ0 = 167.90, AZ1 = 180.10;          /* the archway                   */
  var LZ0 = 172.00, LZ1 = 176.00;          /* the carved lane / door cell   */
  var ARCH = 12.20, TOP = 52.40, CAP = 55.00, TUN = 8.05;
  var conc = cdConc();
  var wall = cdWeather(conc, ROAD_TOP, 2.60);
  var i, j;

  /* the render pile borrowed at tile 20 = 5.7 m, so 15.7 m of shuttered
     concrete stops carrying six repeats of apartment siva speckle */
  var wasTile = cdTile(P.render, 20);

  /* ---- the two piers.  A blast chamfer on every arris, because a 90-degree
     concrete arris on a checkpoint is the one thing nobody builds. */
  var pierY = (ROAD_TOP + TOP) * 0.5, pierH = (TOP - ROAD_TOP) * 0.5;
  var pierX = (GXW + GXE) * 0.5, pierW = (GXE - GXW) * 0.5;
  boxC(P.render, pierX, pierY, (BZ0 + AZ0) * 0.5, pierW, pierH, (AZ0 - BZ0) * 0.5, 0.40, 1, wall);
  boxC(P.render, pierX, pierY, (AZ1 + BZ1) * 0.5, pierW, pierH, (BZ1 - AZ1) * 0.5, 0.40, 1, wall);
  /* the spandrel over the arch.  THE ONE PIECE OF MASS THAT STAYS box6, and
     it is not an oversight: the two piers are boxC at k 0.40, so each already
     cuts a 0.40 chamfer down its own z = AZ0 / AZ1 arris, and above the arch
     head there is nothing behind that notch but buildWorld's untoned grey
     0.10 back.  A square spandrel FILLS both notches.  Chamfer it as well and
     the block grows a 0.80 u vertical groove up each side of the arch with
     the engine's wall showing at the bottom of it. */
  box6(P.render, GXW, GXE, ARCH, TOP, AZ0, AZ1, 1, wall);

  /* ---- the archway's reveal.  Jambs and soffit at ao 0.48 so the 16 u of
     thickness reads as thickness; each is 0.02 proud of the pier face it
     lines, never coplanar with it. */
  panelZ(P.render, AZ0 + 0.02, ROAD_TOP, ARCH, GXW - 0.50, GXW + 0.02, 1, 0.48, wall);
  panelZ(P.render, AZ1 - 0.02, ROAD_TOP, ARCH, GXW - 0.50, GXW + 0.02, -1, 0.48, wall);
  poly(P.render, [[GXW - 0.50, ARCH - 0.02, AZ0], [GXW + 0.02, ARCH - 0.02, AZ0],
                  [GXW + 0.02, ARCH - 0.02, AZ1], [GXW - 0.50, ARCH - 0.02, AZ1]],
       [GXW - 0.24, ARCH + 1.0, (AZ0 + AZ1) * 0.5], 0.48, wall);
  /* the two blind flanks: the engine's wall is the back of them, 0.05 behind
     this face.  Ours is here so the flank reads in OUR concrete tone and not
     in buildWorld's untoned grey. */
  panelX(P.render, 831.95, ROAD_TOP, ARCH, AZ0, LZ0, -1, 0.62, wall);
  panelX(P.render, 831.95, ROAD_TOP, ARCH, LZ1, AZ1, -1, 0.62, wall);

  /* ---- the portal surround: two jambs and a lintel band, 1.10 u wide and
     0.50 proud, with a keystone.  A 3.4 m opening with no surround is a hole
     punched in a wall; the surround is what makes it a gate. */
  var sur = cdWeather(mix(conc, C.stone, 0.18), ROAD_TOP, 2.60);
  for (i = 0; i < 2; i++) {
    var jz = i ? AZ1 + 0.55 : AZ0 - 0.55;
    boxC(P.render, (GXW + 831.40) * 0.5, (ROAD_TOP + ARCH) * 0.5, jz,
         (GXW - 831.40) * 0.5, (ARCH - ROAD_TOP) * 0.5, 0.55, 0.14, 1, sur);
  }
  boxC(P.render, (GXW + 831.40) * 0.5, ARCH + 0.55, (AZ0 + AZ1) * 0.5,
       (GXW - 831.40) * 0.5, 0.55, (AZ1 - AZ0) * 0.5, 0.14, 1, sur);
  boxC(P.render, (GXW + 831.20) * 0.5, ARCH + 1.85, (AZ0 + AZ1) * 0.5,
       (GXW - 831.20) * 0.5, 0.75, 0.80, 0.12, 1, upTone(sur));

  /* ---- the plinth.  It STOPS either side of the opening: run it through
     and it is a chest-high band across the archway the player walks under.
     It also swallows nz-street-park's own city barrier, whose panels sit at
     x 831.65..832.35, y 2.55..4.20 over z 152.4..170 and 178..203.6 - the
     plinth face at 831.05 is in front of it, so the two do not fight. */
  var plY = (ROAD_TOP + PLINTH_TOP) * 0.5, plH = (PLINTH_TOP - ROAD_TOP) * 0.5;
  var plT = cdWeather(mix(conc, C.plinth, 0.30), ROAD_TOP, 2.10);
  boxC(P.render, (831.05 + 848.50) * 0.5, plY, (158.60 + AZ0) * 0.5,
       (848.50 - 831.05) * 0.5, plH, (AZ0 - 158.60) * 0.5, 0.30, 1, plT);
  boxC(P.render, (831.05 + 848.50) * 0.5, plY, (AZ1 + 189.40) * 0.5,
       (848.50 - 831.05) * 0.5, plH, (189.40 - AZ1) * 0.5, 0.30, 1, plT);

  /* ---- the string course at y 17..18, and the cap.  Both chamfered, both
     in upTone: an up-facing precast surface toned pure white clips past
     245 sRGB the moment the dome hands it 2.00. */
  boxC(P.render, (831.40 + 848.30) * 0.5, 17.50, (159.45 + 188.55) * 0.5,
       (848.30 - 831.40) * 0.5, 0.50, (188.55 - 159.45) * 0.5, 0.16, 1,
       upTone(mix(conc, C.stone, 0.24)));
  boxC(P.render, (830.50 + 849.40) * 0.5, (TOP + CAP) * 0.5, (158.60 + 189.40) * 0.5,
       (849.40 - 830.50) * 0.5, (CAP - TOP) * 0.5, (189.40 - 158.60) * 0.5, 0.34, 1,
       upTone(mix(conc, C.stone, 0.34)));

  /* ---- shuttering joints every 8.0 u, 0.06 proud, right round the block.
     Three metre lifts is how this is poured and the joint is the only thing
     at this scale that says concrete rather than render.  The lowest band
     breaks either side of the portal surround.

     boxC AND NOT box6.  This band is 40 mm tall and stands 60 mm off a wall
     the player walks the length of, so its four arrises are in every frame
     the block is in and a square one is the tell the whole block was built to
     avoid.  k 0.045 is clamped by boxC to 0.49 of the band's own 0.07 half
     height = 0.034 = 10 mm, which is a chamfer on a shutter joint and not a
     bevel on a coping. */
  var bcx = (GXW - 0.06 + GXE + 0.06) * 0.5, bhx = (GXE + 0.06 - GXW + 0.06) * 0.5;
  for (i = 0; i < 6; i++) {
    var by = 8.0 + i * 8.0;
    if (by > TOP - 1.2) break;
    if (Math.abs(by - 17.5) < 1.4) continue;             /* the string course */
    if (by < ARCH + 1.9) {
      boxC(P.render, bcx, by + 0.07, (BZ0 - 0.06 + AZ0 - 1.16) * 0.5, bhx, 0.07,
           (AZ0 - 1.16 - BZ0 + 0.06) * 0.5, 0.045, 1, wall);
      boxC(P.render, bcx, by + 0.07, (AZ1 + 1.16 + BZ1 + 0.06) * 0.5, bhx, 0.07,
           (BZ1 + 0.06 - AZ1 - 1.16) * 0.5, 0.045, 1, wall);
    } else {
      boxC(P.render, bcx, by + 0.07, (BZ0 - 0.06 + BZ1 + 0.06) * 0.5, bhx, 0.07,
           (BZ1 + 0.06 - BZ0 + 0.06) * 0.5, 0.045, 1, wall);
    }
  }

  /* ---- form-tie dimples on a 2.8 u grid, 0.20 square and 0.04 proud, on
     the face the player stands in front of.  They are 57 mm and they are
     one pixel at 30 m - they are here for the six metres where he is under
     the arch, which is where he spends the keycard.  box6 and not boxC for
     exactly that reason: a chamfer on a 57 mm dimple is sub-pixel at every
     range the dimple itself is not, and eighty of them at 44 tris apiece is
     3500 triangles spent on a bevel nobody will ever resolve. */
  var tie = mix(conc, C.dark, 0.38);
  for (i = 0; i < 10; i++) {
    var tz = BZ0 + 1.4 + i * 2.8;
    for (j = 0; j < 8; j++) {
      var ty = 5.6 + j * 2.8;
      var inArch = (tz > AZ0 - 1.7 && tz < AZ1 + 1.7);
      if (inArch && ty < 15.6) continue;                 /* the opening       */
      if (inArch && ty > 18.6 && ty < 23.2) continue;    /* the POLIS board   */
      if (ty > 16.6 && ty < 18.4) continue;              /* the string course */
      if (tz > 183.3 && ty < 8.6) continue;              /* the steel door    */
      if (tz > 163.0 && tz < 166.5 && ty > 11.0 && ty < 13.6) continue;  /* slit */
      /* the north pier below the slit is the blast panel, the isolator box
         and the riser now - a form tie under a bolted plate is a tie nobody
         can see and a tie half under one is worse than either */
      if (tz < 165.6 && ty > 5.0 && ty < 11.6) continue;
      box6(P.render, GXW - 0.04, GXW + 0.02, ty - 0.10, ty + 0.10,
           tz - 0.10, tz + 0.10, 0.70, tie);
    }
  }

  /* ---- the guard slit in the north pier, 2.4 x 0.9 u = 686 x 257 mm at
     y 12.0, with a cill and a drip hood.  The hood is what makes it read as
     an opening rather than as a painted stripe. */
  panelX(P.metal, GXW - 0.02, 12.00, 12.90, 163.55, 165.95, -1, 0.55,
         mix(C.dark, C.shade, 0.20));
  boxC(P.render, (831.35 + GXW) * 0.5, 13.01, 164.75,
       (GXW - 831.35) * 0.5, 0.11, 1.60, 0.06, 1, upTone(sur));
  boxC(P.render, (831.42 + GXW) * 0.5, 11.91, 164.75,
       (GXW - 831.42) * 0.5, 0.09, 1.40, 0.05, 1, upTone(sur));

  /* ---- the steel door into the south pier: 4.2 x 8.0 u = 1.20 x 2.29 m,
     a personnel door for the men who work the gate, with a pressed frame,
     two hinges, a lever and the weep every steel door in this country has.

     THE WHOLE GROUP IS boxC NOW.  A pressed steel frame is 1.20 m of door
     furniture at the player's own height on the last wall in the mission and
     every one of its arrises is a real one; k is written at 0.05 and boxC
     clamps each piece to 0.49 of its own thinnest half extent, which lands
     between 5.6 and 12 mm - a break on a pressing, not a moulding. */
  var stl = cdSteel(), frm = mix(stl, C.dark, 0.25);
  boxC(P.metal, GXW - 0.06, (ROAD_TOP + 8.12) * 0.5, 185.90,
       0.04, (8.12 - ROAD_TOP) * 0.5, 2.00, 0.05, 1, stl);
  boxC(P.metal, GXW - 0.09, (ROAD_TOP + 8.42) * 0.5, 183.725,
       0.07, (8.42 - ROAD_TOP) * 0.5, 0.175, 0.05, 1, frm);
  boxC(P.metal, GXW - 0.09, (ROAD_TOP + 8.42) * 0.5, 187.95,
       0.07, (8.42 - ROAD_TOP) * 0.5, 0.05, 0.05, 1, frm);
  boxC(P.metal, GXW - 0.09, 8.27, 185.775, 0.07, 0.15, 2.225, 0.05, 1, frm);
  for (i = 0; i < 2; i++)
    boxC(P.metal, GXW - 0.14, 1.51 + i * 5.2, 183.80, 0.08, 0.21, 0.18, 0.05, 0.86, cdGalv());
  tube(P.metal, [GXW - 0.24, 4.30, 187.10], [GXW - 0.24, 4.30, 187.62], 0.10, 6, cdGalv(), true, false);
  decalCard(P.decal, D_RUST, GXW - 0.03, 2.10, 183.80, 0, 0, 1, 0, 1, 0,
            1.20, 3.60, mix(C.rail, C.dark, 0.28), [-1, 0, 0]);

  /* ---- THE PASSAGE.  Cells (209..212, 43) are carved floor, so this row is
     bored right through the block: cladding 0.05 in front of buildWorld's own
     metal-textured lane walls, a soffit at 8.05 and a lintel above it whose
     west face closes the gap between the doorway head and the arch head.
     8.05 is the number that matters - both of the engine's door headers start
     at f + 8.2, so a ceiling at 8.05 buries them. */
  var tun = cdWeather(mix(conc, C.shade, 0.22), 0, 2.60);
  panelZ(P.render, LZ0 + 0.06, 0, TUN, 831.95, GXE, 1, 0.58, tun);
  panelZ(P.render, LZ1 - 0.06, 0, TUN, 831.95, GXE, -1, 0.58, tun);
  /* box6 again, and again on purpose: the soffit quad below sits at
     TUN - 0.02 and the doorway frame's head covers this lintel's west-bottom
     arris from 8.14 up, so a chamfer here would open 0.05 of daylight between
     the lintel and its own soffit and buy nothing anybody can see. */
  box6(P.render, GXW, GXE, TUN, ARCH, LZ0, LZ1, 1, wall);
  poly(P.render, [[831.95, TUN - 0.02, LZ0 + 0.06], [GXE, TUN - 0.02, LZ0 + 0.06],
                  [GXE, TUN - 0.02, LZ1 - 0.06], [831.95, TUN - 0.02, LZ1 - 0.06]],
       [(831.95 + GXE) * 0.5, TUN + 1.0, (LZ0 + LZ1) * 0.5], 0.42, tun);
  /* the east portal, seen from the lane once the card has been spent.  Its
     jambs stand INSIDE the lane, not outside it: the flanks either side of
     the tunnel mouth are behind buildWorld's own lane walls on the z = 172
     and z = 176 planes, so a frame set out there is invisible from the only
     place it would ever be looked at.

     boxC on all three: this frame is 1.14 m from the player's eye when he
     comes back out through the lane and there is nothing else in the tunnel
     to look at.  k 0.05 clamps to 0.034 on the 0.07 half thickness. */
  boxC(P.render, GXE + 0.03, (TUN + 0.55) * 0.5, LZ0 + 0.23,
       0.07, (TUN + 0.55) * 0.5, 0.17, 0.05, 1, sur);
  boxC(P.render, GXE + 0.03, (TUN + 0.55) * 0.5, LZ1 - 0.23,
       0.07, (TUN + 0.55) * 0.5, 0.17, 0.05, 1, sur);
  boxC(P.render, GXE + 0.03, TUN + 0.275, (LZ0 + LZ1) * 0.5,
       0.07, 0.275, (LZ1 - LZ0) * 0.5 - 0.06, 0.05, 1, sur);

  /* ---- the doorway frame round the level's own keycard door.  It stands on
     the block face, 0.04 proud, and outlines the 4 u cell the gate is on.

     boxC, k 0.04 - clamped to 0.0245 on the frame's 0.05 half thickness.
     This is the arris the player is closest to in the whole mission: he
     stands square in front of it while the card is read. */
  for (i = 0; i < 2; i++) {
    var fz = i ? LZ1 : LZ0 - 0.55;
    boxC(P.metal, GXW - 0.03, (ROAD_TOP + 8.70) * 0.5, fz + 0.275,
         0.05, (8.70 - ROAD_TOP) * 0.5, 0.275, 0.04, 1, stl);
  }
  boxC(P.metal, GXW - 0.03, 8.42, (LZ0 + LZ1) * 0.5,
       0.05, 0.28, (LZ1 - LZ0) * 0.5 + 0.55, 0.04, 1, stl);

  /* ---- POLIS - DUR, on both faces.  Above the string course rather than at
     the plan's y 12.2: the portal surround and its keystone occupy
     12.20..14.80 and a board at 12.2 would sit on top of them. */
  var bh = 3.40, sp = signSize('polis', SIGN_CAP), pcap = SIGN_CAP;
  if (sp && sp.h > bh - 0.8) pcap = SIGN_CAP * (bh - 0.8) / sp.h;
  for (i = 0; i < 2; i++) {
    var fx = i ? GXE : GXW, fd = i ? 1 : -1;
    boxC(P.joinery, fx + fd * 0.12, 20.90, (AZ0 + AZ1) * 0.5,
         0.12, bh * 0.5, 5.60, 0.08, 1, mix(C.white, C.steel, 0.22));
    signCard(P.sign, 'polis', fx + fd * 0.30, 20.90, (AZ0 + AZ1) * 0.5,
             0, 0, 1, 0, 1, 0, pcap, C.white, [fd, 0, 0]);
  }

  /* ---- and everything a checkpoint carries that a concrete tower does not.
     Called inside the tile borrow so anything it puts on P.render is at the
     block's own tile 20 and not at the apartments' 9. */
  gateDress(GXW, wall, sur, stl);

  cdTile(P.render, wasTile);

  /* two occluders under the cap, in z slices, stopping 0.42 below it - the
     clearance nz-street-park settled on under a shelter roof after its first
     render came back with both roofs as solid black slabs */
  cdOcc(830.50, 50.00, 158.60, 849.40, TOP - 0.42, 174.00);
  cdOcc(830.50, 50.00, 174.00, 849.40, TOP - 0.42, 189.40);
}


/* ---------------------------------------------------------------------------
   10.6b  THE GATE BLOCK'S DRESSING

   The block does its structural job - the archway swallows the engine's 4 u
   wide, 44 u tall door lintel, which is the only reason it exists - and after
   the first render it did nothing else.  Fifteen and a half metres of cream
   tower with a hole in it, at the end of the mission, at the one place in the
   level the player has to STOP, stand still and spend a keycard.  Everything
   below is what a hardened checkpoint carries and, more to the point, what
   the rest of this street already carries and this one wall did not: a blast
   panel over a blocked opening, a cable tray under the string course with
   three cables lying in it, a conduit riser off an isolator box, a lamp over
   the arch, the block's number beside the personnel door, and the base
   weathering every elevation in side-2 has had since the first pass.

   THE ONE PLANE THAT BOUNDS ALL OF IT is x 830.85.  The player collides on
   the x = 832 cell boundary with a hull radius of 1.15, so 830.85 is as close
   as he can ever get, and NOTHING here goes west of it - the deepest thing on
   the whole face is the lamp lens at 831.07, which is 0.22 clear, and the
   deepest solid is the lamp hood at 831.08.  The block face is at 831.90, so
   the whole vocabulary works inside 1.05 u = 300 mm of depth, which is about
   what a surface-mounted tray and a saddled conduit take on a real wall
   anyway.  Nothing here is deeper than it would be in life.

   THE SECOND BOUND is nz-street-park's own city barrier, whose panels sit at
   x 831.65..832.35 over y 2.55..4.20 for z 152.4..170 and 178..203.6.  Every
   solid below is either above 5.07 - the plinth top, which is in front of the
   barrier and swallows it - or east of the arch line where the barrier has
   its gap.  Nothing here can be found half-inside a red-and-white panel.
   ------------------------------------------------------------------------ */
function gateDress(GXW, wall, sur, stl) {
  var galv = cdGalv(), dark = mix(C.steel, C.dark, 0.42);
  var pipeT = mix(C.pipe, C.dark, 0.30);
  var i, yy;

  /* =====================================================================
     THE BLAST PANEL, north pier, z 160.50..164.10 x y 5.70..10.90.

     A 1.03 x 1.49 m embrasure plated over: the checkpoint was built with an
     opening here and somebody decided it was a hole an RPG could see.  It
     sits directly on the plinth's 5.075 shelf with 0.63 u of wall showing
     under it, which is what puts the weep on the plinth face rather than on
     the block.  Its z stops at 164.10, 0.55 short of the guard slit's own
     163.55..165.95 - the two overlap in plan by half a metre and are 1.1 u
     apart in height, which is what a plated door under a later slit looks
     like and is not what a pair of features laid out on a grid looks like.
     ================================================================== */
  var pz = 162.30, pw = 1.80, ph = 2.60, py = 8.30;
  /* the plate itself, 0.27 proud of the face and 0.03 clear of it - a plate
     whose back is coplanar with the wall is a z-fight the size of the plate */
  boxC(P.metal, 831.75, py, pz, 0.12, ph, pw, 0.07, 1, stl);
  /* the four angle bars bolted round its edge, 0.06 proud of the plate */
  boxC(P.metal, 831.60, py + ph - 0.12, pz, 0.05, 0.12, pw, 0.03, 1, mix(stl, C.dark, 0.22));
  boxC(P.metal, 831.60, py - ph + 0.12, pz, 0.05, 0.12, pw, 0.03, 1, mix(stl, C.dark, 0.22));
  boxC(P.metal, 831.60, py, pz - pw + 0.12, 0.05, ph, 0.12, 0.03, 1, mix(stl, C.dark, 0.22));
  boxC(P.metal, 831.60, py, pz + pw - 0.12, 0.05, ph, 0.12, 0.03, 1, mix(stl, C.dark, 0.22));
  /* six bolt heads through the two side bars, 0.10 proud of them */
  for (i = 0; i < 6; i++) {
    var bz = pz + ((i % 2) ? pw - 0.12 : -(pw - 0.12));
    var by2 = py + (Math.floor(i / 2) - 1) * 2.20;
    tube(P.metal, [831.62, by2, bz], [831.52, by2, bz], 0.10, 6, galv, true, false);
  }

  /* =====================================================================
     THE CABLE TRAY, one run, z 159.40..187.60 at y 16.30..16.72.

     It runs the whole face rather than dying into the piers: above the arch
     head at 12.20 the spandrel is continuous from AZ0 to AZ1, so at this
     height the block is one wall and a tray that stopped at the arch would be
     a tray that stopped for no reason the player can see.  It is tucked 0.30
     under the string course's 17.00 soffit, which is where a tray goes, and
     it stands 0.06 proud of the string course face at 831.40 so the two do
     not read as one moulding.  Its brackets clear the y = 16.0 shuttering
     band's top at 16.14 by 0.02 - the band and the bracket are the two things
     on this wall most likely to end up coplanar and they are not.
     ================================================================== */
  var TZ0 = 159.40, TZ1 = 187.60, tzc = (TZ0 + TZ1) * 0.5, tzh = (TZ1 - TZ0) * 0.5;
  boxC(P.metal, 831.60, 16.36, tzc, 0.26, 0.06, tzh, 0.04, 1, upTone(galv));
  boxC(P.metal, 831.36, 16.54, tzc, 0.02, 0.18, tzh, 0.015, 1, galv);
  boxC(P.metal, 831.84, 16.54, tzc, 0.02, 0.18, tzh, 0.015, 1, galv);
  /* three cables lying in it.  This is the part that makes a channel read as
     a tray: an empty tray is a shelf. */
  tube(P.metal, [831.46, 16.50, TZ0 + 0.2], [831.46, 16.50, TZ1 - 0.2], 0.075, 5,
       mix(C.dark, C.steel, 0.18), true, false);
  tube(P.metal, [831.60, 16.50, TZ0 + 0.2], [831.60, 16.50, TZ1 - 0.2], 0.075, 5,
       C.dark, true, false);
  tube(P.metal, [831.74, 16.50, TZ0 + 0.2], [831.74, 16.50, TZ1 - 0.2], 0.075, 5,
       mix(C.grey, C.dark, 0.45), true, false);
  for (i = 0; i < 8; i++)
    boxC(P.metal, 831.63, 16.24, 160.60 + i * 3.85, 0.25, 0.08, 0.11, 0.03, 1, upTone(dark));

  /* =====================================================================
     THE CONDUIT RISER, north pier at z 166.55.

     Off an isolator box at chest height, up the wall on four saddles, into
     the tray.  It is set 0.10 south of the guard slit's drip hood, which ends
     at 166.35, and 0.03 north of the portal surround jamb at 166.80 - the
     only 0.45 u of this pier that a riser fits down, and it is the right one:
     services on a real building run in the corner, not across the face.
     ================================================================== */
  boxC(P.metal, 831.68, 6.60, 166.55, 0.20, 0.70, 0.22, 0.05, 1,
       upTone(mix(C.grey, C.steel, 0.30)));
  tube(P.metal, [831.66, 5.00, 166.55], [831.66, 5.95, 166.55], 0.10, 5, pipeT, true, false);
  tube(P.metal, [831.66, 7.25, 166.55], [831.66, 16.34, 166.55], 0.10, 5, pipeT, true, false);
  for (i = 0; i < 4; i++) {
    yy = 8.60 + i * 2.30;
    boxC(P.metal, 831.78, yy, 166.55, 0.10, 0.07, 0.16, 0.03, 1, galv);
  }
  /* the drop out of the tray to the lamp, on the arch centreline */
  tube(P.metal, [831.62, 16.34, 174.00], [831.62, 15.66, 174.00], 0.09, 5, pipeT, true, false);

  /* =====================================================================
     THE LAMP OVER THE ARCH, at z 174.00, y 14.98..15.73.

     A 149 x 171 x 297 mm wall floodlight on a cast bracket, sitting on the
     keystone's head: the keystone tops out at 14.80 and the housing starts at
     14.98, so the lamp is on it and not floating over it.  NO THREE.js LIGHT,
     for the reason floodMast gives - r149 cannot mask a light per object and
     the night half of the campaign shares this scene - so what is modelled is
     what it is on an overcast morning: a grey housing, a cold lens, and the
     bracket and conduit that say somebody wired it.

     The lens is ONE quad on M.glass 0.05 = 14 mm clear of the housing face.
     A box here draws its near and far faces and composites to a pale slab,
     and 14 mm is the clearance floodMast settled on after its own lens was
     found 20 mm INSIDE its housing on all three masts.
     ================================================================== */
  boxC(P.metal, 831.38, 15.28, 174.00, 0.26, 0.30, 0.52, 0.08, 1, upTone(dark));
  boxC(P.metal, 831.40, 15.64, 174.00, 0.32, 0.09, 0.60, 0.05, 1, upTone(galv));
  panelX(P.glass, 831.07, 15.04, 15.52, 173.56, 174.44, -1, 0.90,
         mix(C.glass, C.white, 0.46));
  tube(P.metal, [831.88, 15.72, 174.00], [831.52, 15.36, 174.00], 0.09, 6, dark, true, false);

  /* =====================================================================
     THE NUMBER, south pier at z 182.40, y 5.92..7.28.

     Beside the personnel door, at the height a number goes.  The atlas has no
     stencil cell - 'numara' is the blue enamel plaque the municipality screws
     to every structure it owns, and a police block on a municipal street is
     one of them - so that is what this is, on a pressed plate with an 80 mm
     margin all round.  Toned mix(C.white, C.steel, 0.10) rather than C.white:
     it is a 270 x 343 mm object and it has no business competing with the
     POLIS board fourteen metres above it.
     ================================================================== */
  boxC(P.joinery, 831.78, 6.60, 182.40, 0.10, 0.68, 0.55, 0.05, 1,
       mix(C.white, C.steel, 0.20));
  signCard(P.sign, 'numara', 831.62, 6.60, 182.40, 0, 0, 1, 0, 1, 0,
           1.20, mix(C.white, C.steel, 0.10), [-1, 0, 0]);

  /* =====================================================================
     THE WEATHERING AT THE BASE.

     cdWeather already darkens the first 2.60 u of the wall and the first 2.10
     of the plinth by 32 per cent, and a tiling map cannot do the rest:
     positional grime is what the decal atlas is for and this block had none
     of it while every facade in side-2 has carried a ground band since the
     first pass.  Six D_GROUND bands, two D_ALGAE blotches in the two corners
     water actually stands in, and four D_RUST weeps off the four things on
     this wall that shed water - the plate, the slit cill, the tray and the
     lamp.  The bands go on the PLINTH face at 831.03 where there is a plinth
     and on the block face at 831.88 in the arch bay where there is not.
     ================================================================== */
  var soil = mix(C.asphalt, C.soil, 0.40), rust = mix(C.rail, C.dark, 0.30);
  for (i = 0; i < 4; i++) {
    var gz = [160.925, 165.575, 182.425, 187.075][i];
    decalCard(P.decal, D_GROUND, 831.03, 1.30, gz, 0, 0, 1, 0, 1, 0,
              4.65, 2.60, soil, [-1, 0, 0]);
  }
  /* the arch bay has no plinth, so its bands sit on the face itself, narrow
     enough at 2.80 to stay clear of the keycard doorway frame at 171.45 */
  decalCard(P.decal, D_GROUND, 831.88, 1.20, 169.60, 0, 0, 1, 0, 1, 0,
            2.80, 2.40, soil, [-1, 0, 0]);
  decalCard(P.decal, D_GROUND, 831.88, 1.20, 178.40, 0, 0, 1, 0, 1, 0,
            2.80, 2.40, soil, [-1, 0, 0]);
  decalCard(P.decal, D_ALGAE, 831.03, 1.90, 159.60, 0, 0, 1, 0, 1, 0,
            2.00, 3.20, mix(C.green, C.dark, 0.58), [-1, 0, 0]);
  decalCard(P.decal, D_ALGAE, 831.03, 1.90, 188.60, 0, 0, 1, 0, 1, 0,
            2.00, 3.20, mix(C.green, C.dark, 0.58), [-1, 0, 0]);
  /* off the blast plate onto the plinth shelf, which is the 0.85 u ledge the
     water actually lands on */
  decalCard(P.decal, D_RUST, 831.03, 3.20, 162.30, 0, 0, 1, 0, 1, 0,
            0.90, 3.60, rust, [-1, 0, 0]);
  /* off the south end of the slit's drip hood, clear of the plate at 164.10 */
  decalCard(P.decal, D_RUST, 831.88, 10.20, 165.30, 0, 0, 1, 0, 1, 0,
            1.20, 3.20, mix(rust, C.dark, 0.10), [-1, 0, 0]);
  /* off two of the tray brackets: the one at 160.60 down the north pier, and
     the one at 176.00 down the spandrel.  NOT down the arch centreline - the
     keystone owns x 831.20..831.90 over y 13.30..14.80 at z 173.20..174.80 and
     a weep at 174.00 would have been swallowed by it for half its length. */
  decalCard(P.decal, D_RUST, 831.88, 13.60, 160.55, 0, 0, 1, 0, 1, 0,
            0.60, 4.80, rust, [-1, 0, 0]);
  decalCard(P.decal, D_RUST, 831.88, 14.75, 176.00, 0, 0, 1, 0, 1, 0,
            0.70, 2.50, rust, [-1, 0, 0]);
}


/* ---------------------------------------------------------------------------
   10.7  THE CARD READER

   ON A POST, touching the ground.  In the build this replaces it was a box
   hanging 4 u clear of the block's face at chest height with nothing under
   it, and its glass lens sat 5.7 mm in front of the metal box under
   depthWrite:true - a guaranteed flicker on the one object in the mission the
   player has to walk up to and use.

   It stands at (827.40, 177.60), out in the roadway beside the door rather
   than flat on the wall, because that is where a reader goes: at the height
   and the reach of a driver's window.
   ------------------------------------------------------------------------ */
function cardReader(x, z) {
  var galv = cdGalv(), dark = mix(C.steel, C.dark, 0.45);
  tube(P.metal, [x, 0, z], [x, 3.68, z], 0.16, 8, galv, true, false);
  boxC(P.metal, x, 0.14, z, 0.52, 0.18, 0.52, 0.08, 1, upTone(galv));
  /* head 0.5 x 1.75 x 0.9 = 143 x 500 x 257 mm, raked back the way they are */
  boxC(P.joinery, x, 4.555, z, 0.25, 0.875, 0.45, 0.09, 1, upTone(dark));
  /* the lens, 0.02 proud on the WEST face only - the face he walks up to */
  panelX(P.glass, x - 0.27, 4.10, 5.10, z - 0.32, z + 0.32, -1, 0.90,
         mix(C.glass, C.dark, 0.30));
  /* the read indicator: a chip of red, unlit, 0.03 in front of the lens */
  panelX(P.joinery, x - 0.30, 5.14, 5.30, z - 0.10, z + 0.10, -1, 1,
         mix(C.red, C.dark, 0.35));
  /* the conduit into the road, so the thing is wired to something */
  tube(P.metal, [x + 0.13, 0.10, z], [x + 0.13, 3.30, z], 0.07, 5,
       mix(C.pipe, C.dark, 0.24), true, false);
}


/* ---------------------------------------------------------------------------
   10.8  THE BOOM

   A hinge post, a 12.6 u = 3.60 m striped arm at y 3.92, a counterweight and
   a drop skirt.

   MOVED WEST OF THE LINE, and this is the one deliberate departure from the
   site plan's coordinates.  The plan hinges it at (849.60, 189.20) and runs
   it to (849.60, 176.60).  Every cell at that x is S_BLOCK - occupy(209, 38,
   215, 48) blocks columns 209..215 for rows 38..48 and only row 43 is carved
   back out - so an arm there lies inside un-modelled solid, behind
   buildWorld's own lane wall on the z = 176 plane, and is not visible from
   any cell the player can occupy.  Hinged on the approach instead it does
   the job it is for: it bars the way to the arch, it is the first thing seen
   coming east down 233 Sk, and it reads from 40 m.
   ------------------------------------------------------------------------ */
function boom(x, hz0, z1, y) {
  var galv = cdGalv(), dark = mix(C.steel, C.dark, 0.40);
  var ay = y + 3.92, i;

  /* the hinge post, 1.8 x 1.8 x 4.03 = 514 x 514 x 1151 mm, and its cap */
  boxC(P.metal, x, y + 1.99, hz0, 0.90, 2.04, 0.90, 0.16, 1, upTone(dark));
  boxC(P.metal, x, y + 4.14, hz0, 1.02, 0.11, 1.02, 0.06, 1, upTone(galv));
  /* the pivot boss */
  tube(P.metal, [x - 1.05, ay, hz0], [x + 1.05, ay, hz0], 0.42, 8, galv, true, false);

  /* the arm, in six 1.9 u bands.  Interior ends are open on purpose: a cap
     disc at every joint would be two coplanar discs and a z-fight at each. */
  var dir = (z1 < hz0) ? -1 : 1, s0 = hz0 + dir * 1.20;
  for (i = 0; i < 6; i++) {
    var b0 = s0 + dir * i * 1.90, b1 = s0 + dir * (i + 1) * 1.90;
    tube(P.metal, [x, ay, b0], [x, ay, b1], 0.17, 8,
         (i % 2) ? mix(C.white, C.steel, 0.10) : mix(C.red, C.gold, 0.10), false, false);
  }
  tube(P.metal, [x, ay, hz0], [x, ay, s0], 0.17, 8, galv, false, false);
  /* the rubber end buffer, wider than the arm, which also closes its end */
  tube(P.metal, [x, ay, z1 + dir * 0.30], [x, ay, z1 - dir * 0.24], 0.26, 8,
       mix(C.dark, C.steel, 0.10), true, false);

  /* the drop skirt: three verticals on the free half, so a low car cannot be
     driven under the arm.  Every boom on a military lane carries them. */
  for (i = 1; i <= 3; i++) {
    var sz = lerp(hz0, z1, i / 4.0);
    tube(P.metal, [x, y + 1.40, sz], [x, ay - 0.14, sz], 0.075, 5,
         (i % 2) ? mix(C.red, C.gold, 0.10) : mix(C.white, C.steel, 0.10), true, false);
  }
  /* the counterweight, on the short arm behind the pivot */
  tube(P.metal, [x, ay, hz0], [x, ay, hz0 - dir * 1.85], 0.17, 6, galv, false, false);
  boxC(P.metal, x, ay, hz0 - dir * 2.05, 0.62, 0.62, 0.42, 0.10, 1, upTone(dark));
}


/* ---------------------------------------------------------------------------
   10.9  THE GUARD CABIN

   MOVED ONTO THE LINE, for the same reason the boom moved.  The site plan
   puts it at x 846..854, z 192..200, which is fourteen units behind
   buildWorld's 52 u wall on the x = 832 plane and cannot be seen from any
   cell the player can occupy.  Built out from the police line instead, on
   the south pavement beside the gate, it is a 1.33 x 1.71 m sentry box with
   its window looking straight down 233 Sk at whoever is walking up.  Which
   is the whole point of a guard hut.

   Its west face is at x 831.35 rather than at the block face: that is 0.30
   in front of nz-street-park's own city barrier (panels x 831.65..832.35),
   so the barrier dies into the hut instead of half-emerging from its front.
   ------------------------------------------------------------------------ */
function guardHut(x0, x1, z0, z1, y) {
  var EAVE = y + 8.37, RISE = 3.15, OVER = 0.70;
  var body = mix(C.white, C.steel, 0.26);
  var frame = mix(C.white, C.grey, 0.30);

  /* the body starts 0.30 UNDER the pavement it stands on - nothing in this
     module is allowed to share an up-facing y with the ground plane */
  box6(P.render, x0, x1, y - 0.30, EAVE, z0, z1, 1, cdWeather(body, y, 1.47));
  /* the window: a recessed pane with a frame, on the west face.  The glass
     is one quad on M.glass, which has depthWrite off - a box here would
     draw its near and far faces and composite to a pale slab. */
  panelX(P.glass, x0 - 0.06, y + 3.12, y + 6.97, z0 + 0.90, z1 - 0.90, -1, 0.94,
         mix(C.glass, C.dark, 0.18));
  box6(P.joinery, x0 - 0.14, x0 + 0.02, y + 2.96, y + 3.16, z0 + 0.74, z1 - 0.74, 1, frame);
  box6(P.joinery, x0 - 0.14, x0 + 0.02, y + 6.93, y + 7.13, z0 + 0.74, z1 - 0.74, 0.86, frame);
  box6(P.joinery, x0 - 0.14, x0 + 0.02, y + 2.96, y + 7.13, z0 + 0.74, z0 + 0.92, 1, frame);
  box6(P.joinery, x0 - 0.14, x0 + 0.02, y + 2.96, y + 7.13, z1 - 0.92, z1 - 0.74, 1, frame);
  /* a centre mullion, because 2.06 m of glass in one pane is a shopfront */
  box6(P.joinery, x0 - 0.12, x0 + 0.02, y + 3.16, y + 6.93,
       (z0 + z1) * 0.5 - 0.09, (z0 + z1) * 0.5 + 0.09, 1, frame);

  /* the hip roof, with a fascia and a near-black soffit under the overhang.
     hipRoof emits the tile surface only - the soffit belongs to the caller,
     because a roof that draws its own cannot be given the underside the
     photographs show. */
  hipRoof(P.roof, x0 - OVER, x1 + OVER, z0 - OVER, z1 + OVER, EAVE + 0.30, RISE,
          mix(C.roof, C.dark, 0.16));
  boxC(P.joinery, (x0 + x1) * 0.5, EAVE + 0.15, (z0 - OVER + z1 + OVER) * 0.5,
       (x1 - x0) * 0.5 + OVER, 0.15, (z1 - z0) * 0.5 + OVER, 0.07, 1,
       upTone(mix(C.white, C.grey, 0.20)));
  poly(P.joinery, [[x0 - OVER, EAVE - 0.01, z0 - OVER], [x1 + OVER, EAVE - 0.01, z0 - OVER],
                   [x1 + OVER, EAVE - 0.01, z1 + OVER], [x0 - OVER, EAVE - 0.01, z1 + OVER]],
       [(x0 + x1) * 0.5, EAVE + 1.0, (z0 + z1) * 0.5], 0.46, mix(C.white, C.dark, 0.34));
  /* the ground line, and a drip stain under the fascia corner */
  decalCard(P.decal, D_GROUND, x0 - 0.03, y + 1.10, (z0 + z1) * 0.5,
            0, 0, 1, 0, 1, 0, (z1 - z0) * 0.92, 2.20,
            mix(body, C.dark, 0.42), [-1, 0, 0]);
}


/* ---------------------------------------------------------------------------
   10.10  buildCordon()

   The four lines and the checkpoint, in the order the player meets them.
   Nothing here blocks the carriageway between the quiet north boundary and
   z 296: the arms themselves belong to the ground and the elevations.
   ------------------------------------------------------------------------ */
function buildCordon() {

  /* =====================================================================
     232 Sk, the two arm closures.

     The south line spans the matching 63-u carriageway, leaving the broad
     paved verges open at both ends of the bariyer run.

     The north boundary now stands on the occupied far row at z 0..4, beyond
     the cemetery.  It is a quiet dark service gate rather than another
     military roadblock.  The southern line is row 126 with scenery to row 127.
     ================================================================== */
  var arms = [
    { line: 2.0,  near:  1, far: -1.00, plate: 0.80, sign: 'z+', quiet: true,
      cone: [[555.0, 7.6], [562.2, 10.8], [572.2, 5.4]],
      bag: 566.0, bagZ: -1.80, wb: [7.0, 9.2] },
    { line: 506.0, near: -1, plate: 507.20, far: 509.00, sign: 'z-',
      cone: [[509.0, 500.4], [532.2, 497.2], [554.2, 502.6]],
      bag: 520.0, bagZ: 508.40, wb: [501.0, 498.8] }
  ];
  var a, i, A;
  for (a = 0; a < arms.length; a++) {
    A = arms[a];

    /* The map edge needs a physical read, but not police theatre.  Two dark
       posts and a low swing rail sit entirely inside the blocked far row and
       disappear into the cemetery tree line from the junction. */
    if (A.quiet) {
      var gateTone = mix(C.dark, C.green, 0.14);
      var qx0 = NORTH_ROAD0 + 1.45, qx1 = NORTH_ROAD1 - 1.45;
      boxC(P.stone, qx0, 2.15, A.line, 0.55, 2.10, 0.55,
           0.10, 1, mix(C.stone, C.dark, 0.22));
      boxC(P.stone, qx1, 2.15, A.line, 0.55, 2.10, 0.55,
           0.10, 1, mix(C.stone, C.dark, 0.22));
      tube(P.metal, [qx0 + 0.55, 2.45, A.line], [qx1 - 0.55, 2.45, A.line],
           0.14, 8, gateTone, true, false);
      tube(P.metal, [qx0 + 0.55, 3.25, A.line], [qx1 - 0.55, 3.25, A.line],
           0.11, 8, gateTone, true, false);
      cdOcc(qx0 - 0.35, 0.13, A.line - 0.70, qx1 + 0.35, 3.50, A.line + 0.70);
      continue;
    }

    barrierRun(ROAD0 + 0.20, ROAD1 - 0.20, A.line, 'x', ROAD_TOP, A.near, cdArmGroundY);

    /* three cones scattered on the near side, none of them square to the line
       and none of them on the four blocked kerb strips - the nearest of those
       is the bin run at x 552..556, z 72..88, and the roadworks at z 256..272,
       and a cone standing in a municipal bin is not a detail anybody forgives */
    for (i = 0; i < 3; i++) trafficCone(A.cone[i][0], A.cone[i][1], ROAD_TOP);

    /* the sign stands BEHIND the line on the blocked row, not in front of it
       in the lane: its board clears the panel top at 3.76 by a metre and a
       half and there is nothing for the player to walk into */
    warningPlate((ROAD0 + ROAD1) * 0.5, A.plate, ROAD_TOP, A.sign);

    /* two masts on the closure side at the carriageway edges - cells 138 and
       143 of rows 13 / 75, both occupied */
    floodMast(ROAD0 + 3.0, A.far, ROAD_TOP);
    floodMast(ROAD1 - 3.0, A.far, ROAD_TOP);

    /* one revetment per line, behind the barricade where the men would be */
    sandbags(A.bag, A.bagZ, ROAD_TOP, 'x', 5);

    /* two spare water-filled plastic barriers stood on the footway by the
       closure, one each side.  The ground section already models this object
       for the roadworks strip, so this borrows that one rather than shipping
       a second design of the same thing; it is guarded because the two parts
       are written separately.  Both z are set so the 7 u body clears the
       barricade line - the west footway one on the south arm ends before it,
       1.4 u short of the panel. */
    if (typeof grWaterBarrier === 'function') {
      grWaterBarrier(XW + 5.60, A.wb[0], PAVE_TOP, 'z', m(1.0), 11);
      grWaterBarrier(XE - 5.60, A.wb[1], PAVE_TOP, 'z', m(1.0), 13);
    }

    /* Three sub-26-u occluders cover the wider line without triggering sky's
       silent REG_MAX discard. */
    cdOcc(ROAD0 + 0.60, 0.13, A.line - 0.70, ROAD0 + 21.50, 0.88, A.line + 0.70);
    cdOcc(ROAD0 + 21.60, 0.13, A.line - 0.70, ROAD0 + 42.50, 0.88, A.line + 0.70);
    cdOcc(ROAD0 + 42.60, 0.13, A.line - 0.70, ROAD1 - 0.60, 0.88, A.line + 0.70);
  }

  /* =====================================================================
     230 Sk, the two stub closures.

     Flat ground here: the stubs are 32 u kerb line to kerb line with no
     footway in the grid at all - vista corridors seen end-on from the
     junction and from the checkpoint, never walked - so one level for the
     whole run and no ground callback.  The stub elevations' plinths stand
     at x 760.54 and 791.46, which is what sets the run's ends.
     ================================================================== */
  /* ONE line, not two.  The south stub is the walled garden in SECTION 9.6
     and a garden does not get a police barricade across it; its closure is
     the wall on the 233 Sk building line. */
  var stubs = [
    { line: 114.0, near:  1, cone: 119.60, plate: 112.80, sign: 'z+', bag: 110.60 }
  ];
  for (a = 0; a < stubs.length; a++) {
    A = stubs[a];
    barrierRun(761.40, 790.60, A.line, 'x', ROAD_TOP, A.near, null);
    /* one cone each, on the near side.  These closures are read end-on from
       80 m down 230 Sk and from the checkpoint; three cones apiece would be
       three cones nobody can resolve. */
    trafficCone(768.40, A.cone, ROAD_TOP);
    warningPlate(776.00, A.plate, ROAD_TOP, A.sign);
    /* one revetment, on the north line only - the south one is seen only from
       the junction and only ever in silhouette */
    if (A.bag) sandbags(770.00, A.bag, ROAD_TOP, 'x', 4);
    cdOcc(764.00, 0.13, A.line - 0.70, 788.00, 0.88, A.line + 0.70);
  }

  /* =====================================================================
     THE EAST POLICE LINE, which is now a plain closure.

     It carried the keycard checkpoint for as long as the mission ran downhill
     into it.  The mission runs uphill now and ends on the park crest, so this
     end goes back to being what the module's own rule says a closure is: one
     row of bariyer, waist high, with the street and the town visible behind
     it.  The two five-storey masses that used to crowd it either side --
     X-E-N and X-E-S, whose blank 17.7 m gable ends faced the gate across
     eight units of road -- are gone with it (SECTION 9's run table).

     THE PANEL ITSELF IS NOT BUILT HERE.  nz-street-park draws the city
     barrier across this whole line already (barrierZ at x 831.65..832.35,
     z 152.4..203.6) and no longer splits it, so a second run laid on top of
     it would be two red-and-white panels in the same 0.7 u of world.  What
     this section owes the line is the furniture the other four closures
     carry: two cones on the approach, one chevron board on the centreline,
     two masts and one revetment. */
  warningPlate(829.20, 174.00, ROAD_TOP, 'x-');
  floodMast(828.60, 157.40, ROAD_TOP);
  floodMast(828.60, 190.60, ROAD_TOP);
  sandbags(829.60, 163.60, ROAD_TOP, 'z', 4);
  trafficCone(827.60, 180.40, ROAD_TOP);
  trafficCone(823.40, 169.20, ROAD_TOP);

  /* =====================================================================
     THE CHECKPOINT, on the park crest.

     Built where it was always authored and then turned end for end by
     cdSpin(): see the note above cdMark().  Everything between the mark and
     the spin is in the ORIGINAL east-line coordinates.
     ================================================================== */
  var cpMark = cdMark();

  gateBlock();

  /* the reader, out in the roadway at the reach of a driver's window */
  cardReader(827.40, 177.60);

  /* the boom across the approach to the arch, hinged south of it */
  boom(829.40, 180.60, 168.00, ROAD_TOP);

  /* the sentry box, on the south pavement beside the gate */
  guardHut(831.35, 836.00, 192.60, 198.60, 0.56);

  /* TWO MASTS, ONE EITHER SIDE OF THE BLOCK, EACH ON A CAST PIER.

     The site plan puts them at x 834.90.  That is 2.9 u BEHIND the engine's
     52 u wall on the x = 832 plane, where nothing below y 52 can be seen, so
     they stand in front of it instead.

     SHAFT AT 831.75, NOT 831.60, AND THE PIER CENTRED ON 831.95, NOT 831.75.
     The old numbers were argued from the SHAFT - 831.60 keeps a 0.34 radius
     0.30 clear of the player's reach at 830.85 - and the shaft is not the
     westernmost thing on a mast.  floodMast's holding-down flange is 0.90 to
     a side, so at 831.60 it ran out to 830.70 and the 2.20 u pier under it to
     830.65, both of them 0.15..0.20 INSIDE the hull the player can put there:
     he would have clipped a corner of each.  At 831.75 the flange lands on
     830.85 and at 831.95 the pier lands on 830.85 - tangent to the reach
     line, which is where the block's own face planes are set out from and is
     the same rule.  What it costs is the shaft's east face, which now runs
     0.09 INTO buildWorld's wall instead of 0.06 clear of it: it is a solid
     round tube inside an opaque slab with no coplanar face anywhere, so it
     costs nothing that can be seen, and the flange oversailing the pier -
     the thing 0.90 was chosen for - still does not happen.

     The pier is not decoration.  nz-street-park's city barrier runs the whole
     line at x 831.65..832.35, y 2.55..4.20, and a bare mast standing there
     has a red-and-white panel passing straight through its shaft; a 1.26 m
     cast pier is what a site mast is bolted to anyway, and it swallows the
     barrier over its own 2.6 u so the line dies cleanly into it.

     z 156.60 and 191.00: both piers clear the block plinth's z 158.6..189.4,
     and the south one clears the guard hut at z 192.6. */
  var piers = [156.60, 191.00];
  for (i = 0; i < 2; i++) {
    boxC(P.render, 831.95, 2.63, piers[i], 1.10, 2.33, 1.30, 0.16, 1,
         cdWeather(mix(cdConc(), C.plinth, 0.26), 0.30, 1.60));
    floodMast(831.75, piers[i], 4.96);
    /* the tie-back.  A 6.2 m mast standing against a face is bolted to it and
       the fixing is what says the two belong to each other - but with the
       shaft moved to 831.75 it stands HARD against buildWorld's wall and
       there is no gap left for a stand-off bracket to bridge; the old one ran
       831.60 to 831.99 and at the new x it would lie inside the shaft's own
       0.34 radius for its whole length.  So what shows is the strap: a
       460 x 300 mm clamp plate on the WEST face of the shaft, 0.13 proud of
       it, bolted through into the concrete behind. */
    boxC(P.metal, 831.44, 17.40, piers[i], 0.16, 0.24, 0.52, 0.06, 1, cdGalv());
  }

  /* the revetment beside the arch, on the north side clear of the boom */
  sandbags(830.05, 161.20, ROAD_TOP, 'z', 4);

  /* two cones on the approach: one at the arch mouth, one dropped out in the
     lane.  Both clear of the reader's base plate, the boom's hinge post and
     the plinth's 831.05 face - a cone half inside a plinth is the tell that
     nobody walked the approach. */
  trafficCone(829.20, 171.20, ROAD_TOP);
  trafficCone(826.20, 173.60, ROAD_TOP);

  /* ...and the whole assembly goes to the crest, facing back down the hill. */
  cdSpin(cpMark);
}

})(typeof window !== 'undefined' ? window : this);
