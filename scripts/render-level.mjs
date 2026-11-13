#!/usr/bin/env node
/* ===========================================================================
   render-level.mjs -- free-camera stills of the REAL level, headless.

   render-critic.mjs renders operators on a studio stage and cannot show you a
   wall.  This one loads NUKEM.html itself, waits for nz-shots to reach its
   posed, frozen, TAA-converged frame, then flies the camera anywhere you ask
   and grabs a PNG.

   No new page and no file edits are needed, because a free camera already
   exists: nz-shots.js:909-921 calls applyPose() from a priority-1000 'render'
   hook EVERY frame while mode=single, and NZ.shots.pose is the live object it
   reads (nz-shots.js:1501).  So writing NZ.shots.pose.{x,y,z,yaw,pitch,fov}
   from Puppeteer moves the camera on the next frame.  That is the whole trick.

   HARD BUDGET: one invocation must finish inside ~40 s, because a shell call
   is capped at 45 s.  Same discipline as render-critic.mjs:

     * the default is ONE shot, not a sheet;
     * --sheet renders as many still-missing shots as fit in the remaining
       budget, writing each PNG the moment it lands, then prints what is left.
       Re-running picks up where it stopped, so a sheet is built over several
       calls without ever redoing work;
     * ONE page load serves the whole batch -- the boot and the SwiftShader
       shader compiles are paid once, not once per shot;
     * every phase prints its elapsed time so the budget stays visible.

   MEASURED, this sandbox, 640x400 nzq=low, 2 CPUs shared with three other
   agents.  All eleven street presets landed in two calls:

       boot to SHOT SINGLE      9.7 - 30.5 s   varies with what the siblings
                                               are doing; the box has 2 cores
       drain (once per load)    0 - 12 s       boot GPU backlog + shader JIT
       per shot after that      ~2 - 3 s       hold 2 frames + FBO readback
       whole 11-shot sheet      2 calls

   Two claims in RENDER-CONTRACT 6.4 did not survive contact and are corrected
   here, both in code and in the comments at the point of use:

     1. "page.screenshot() works fine, no capture-render-target redirection
        needed."  It returns, but it goes through the compositor, which is the
        one path SwiftShader is hopeless at: 22-30 s for ONE 640x400 grab.
        _critic_operators.html:300-318 already had the answer -- remap
        setRenderTarget(null) to an FBO and read that.  Installed from
        Puppeteer at runtime, so no file changes.  ~0.1 s per grab.
     2. "boot is ~9.2 s."  Only on a quiet box AND only once you stop
        NUKEM.html:302 fetching three.js from unpkg.com on a blocking script
        tag, and stop the browser reading the level off the mounted Windows
        folder.  See the staging block below.

   It also installs its own toolchain.  /tmp is per-session, so chrome, the one
   missing shared library and puppeteer are all gone after a sandbox restart;
   any run that finds them missing puts them back (chrome ~20 s, libxdamage1
   ~2 s, puppeteer ~10 s) and writes /tmp/chsenv.sh so render-critic.mjs and
   the next agent inherit it.  A run that had to install says so and asks you
   to re-run, rather than blowing the shell cap trying to do both.

   Owned by the HARNESS agent (this file + /tmp).  NUKEM.html and every nz-*.js
   belong to somebody else and are never touched.

     node scripts/render-level.mjs --at=176,6.4,172 --look=east --out=_shots/street-west.png
     node scripts/render-level.mjs --shot=street.westend
     node scripts/render-level.mjs --sheet=street              # resumable
     node scripts/render-level.mjs --shot=street.north34 --diag
     node scripts/render-level.mjs --list
     node scripts/render-level.mjs --setup                     # toolchain only

   By default the page is staged into /tmp and boots WITHOUT nz-enemies,
   nz-weapons and nz-audio -- none of them puts a pixel on a facade and all
   three cost boot time.  --full puts them back, --nostage loads the repo
   verbatim.  The module line printed at the end of every run says which, so a
   shot can never quietly be of something other than what you think.

   ANGLES.  +X is east, +Z is south, +Y is up (STREET-MODULE-CONTRACT.md:23).
   nz-shots applies the pose as rotation.set(pitch, yaw, roll, 'YXZ'), so the
   forward vector is (-sin yaw, 0, -cos yaw) and:

       yaw    0 deg = north (-Z)      pitch  +ve = looking UP
       yaw  -90 deg = east  (+X)      pitch  -ve = looking DOWN
       yaw   90 deg = west  (-X)
       yaw  180 deg = south (+Z)

   --look= takes either a compass word or `yaw,pitch` in those degrees, and
   --lookat=x,y,z aims at a world point instead.  Every run prints the yaw it
   resolved together with its compass name, so a wrong sign is visible in the
   log rather than in the picture.

   EYE HEIGHT.  NUKEM.html:3747 has EYE = 1.71 * M = 5.985 units above the
   floor.  The street presets stand at y = 6.4 (the brief's number, and the
   pavement's 0.5 kerb plus a standing eye), which is 0.42 u -- about 12 cm --
   above the true gameplay eyeline.  Use --at with y = 5.985 if you need to
   match what the player actually sees to the centimetre.
   ======================================================================== */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* --------------------------------------------------------------- runtime -- */
/* Same three env vars render-critic.mjs uses, same defaults, so `. /tmp/chsenv.sh`
   configures both.  puppeteer lives outside the repo on purpose: the project
   has no node_modules of its own and must not grow one. */
const PP_DIR = process.env.CRITIC_PP || '/tmp/pp';
const CHROME = process.env.CRITIC_CHROME ||
  '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell';
const LIB_DIRS = process.env.CRITIC_LIBS ||
  '/tmp/root/usr/lib/x86_64-linux-gnu:/tmp/root/lib/x86_64-linux-gnu';

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
  at:     flag('at', null),          /* x,y,z world position                   */
  look:   flag('look', null),        /* compass word | yawDeg,pitchDeg         */
  lookat: flag('lookat', null),      /* x,y,z world point to aim at            */
  shot:   flag('shot', null),        /* named preset                           */
  sheet:  flag('sheet', null),       /* named sheet | comma list of presets    */
  fov:    Number(flag('fov', 0)) || 0,
  w:      Number(flag('w', 0)) || 0,
  h:      Number(flag('h', 0)) || 0,
  nzq:    String(flag('nzq', 'low')),          /* low|med|high|ultra           */
  taa:    Number(flag('taa', 0)) || 0,         /* frames held before the grab  */
  wait:   Number(flag('wait', 0)) || 0,        /* ms cap on that hold          */
  q:      flag('q', null),           /* extra query string, e.g. nzstreet=0    */
  full:   !!flag('full', false),     /* boot enemies+weapons+audio too         */
  nostage: !!flag('nostage', false), /* load the repo directly, warts and all  */
  seed:   Number(flag('seed', 0)) || 0,
  out:    flag('out', null),
  budget: Number(flag('budget', 38)) || 38,
  diag:   !!flag('diag', false),
  hud:    !!flag('hud', false),      /* keep the game's 2D overlay canvas      */
  force:  !!flag('force', false),    /* sheet: redo shots already on disk      */
  one:    !!flag('one', false),      /* sheet: render at most one shot         */
  list:   !!flag('list', false),
  setup:  !!flag('setup', false),
  keep:   !!flag('keep', false),
  quiet:  !!flag('quiet', false),
  car:    flag('car', null),         /* auto-framed turntable on the parked car */
  carIdx: Number(flag('carIdx', 0)) || 0,
  serve:  Number(flag('serve', 0)) || 0,   /* stay up on a port and take orders */
};
/* A daemon has no shell call to fit inside, so it has no budget either -- but
   the number is also handed to page.goto() as a millisecond timeout, and
   anything over ~2.1e9 ms overflows a 32-bit signed int and silently becomes
   1 ms, which fails the navigation instantly.  A day is plenty. */
if (OPT.serve) OPT.budget = 86400;

/* ---------------------------------------------------------- CAR RIG -------
   Judging a vehicle model against photographs needs the camera locked to the
   CAR, not to the street, and it needs a LONG lens.  A 68-deg preset puts a
   94-deg horizontal field on a 4.2 m body 5 m away: every straight line on the
   flank bends, the near wheel doubles in size, and no measurement taken off
   the frame means anything.  These views orbit NZ.streetProps.cars[carIdx],
   aim at a fixed fraction of its own height, and pick their distance so the
   body fills `fill` of the frame at the stated fov -- so `side` is a true
   profile that can be laid straight over the owner's photograph.

     az    degrees around the car from its NOSE.  0 = camera dead ahead of the
           car looking back at the grille, 90 = the driver's flank (the side
           the reference photos show), 180 = square on the tailgate.
     el    camera elevation in degrees above the aim point.
     ah    the aim point's height as a fraction of body height H.
     fov   VERTICAL field, degrees.  24 is a 100 mm lens on full frame.
     fill  fraction of the frame width the body's silhouette should occupy.
     ax/ay/az0  optional aim-point offsets along the car's own length/height
           /width, in fractions of L/H/W, for the close details.            */
const CARVIEWS = {
  side:      { az:  90, el:  0, ah: 0.50, fov: 24, fill: 0.88, note: 'true profile, driver flank -- lay it over the owner photo' },
  sideoff:   { az: 270, el:  0, ah: 0.50, fov: 24, fill: 0.88, note: 'true profile, offside/kerb flank' },
  front:     { az:   0, el:  0, ah: 0.50, fov: 24, fill: 0.86, note: 'square on the face' },
  rear:      { az: 180, el:  0, ah: 0.50, fov: 24, fill: 0.86, note: 'square on the tailgate' },
  front34:   { az:  35, el:  7, ah: 0.52, fov: 28, fill: 0.86, note: 'the showroom three-quarter' },
  rear34:    { az: 145, el:  7, ah: 0.52, fov: 28, fill: 0.86, note: 'rear three-quarter' },
  front34b:  { az:  55, el:  4, ah: 0.50, fov: 28, fill: 0.86, note: 'shallower front three-quarter' },
  plan:      { az:  90, el: 78, ah: 0.50, fov: 30, fill: 0.82, note: 'near-plan, for roof, glass plan and tumblehome' },
  eye:       { az:  40, el: 12, ah: 0.62, fov: 55, fill: 0.62, note: 'what the player actually sees walking up' },
  nose:      { az:  20, el:  6, ah: 0.34, fov: 26, fill: 1.55, ax:  0.36, note: 'grille, lamps, bumper, fog pockets' },
  tail:      { az: 160, el:  6, ah: 0.44, fov: 26, fill: 1.55, ax: -0.36, note: 'tailgate, clusters, plate, bumper' },
  wheel:     { az:  90, el:  4, ah: 0.20, fov: 26, fill: 2.30, ax:  0.30, note: 'front arch, tyre, alloy face, sill' },
  dlo:       { az:  70, el:  8, ah: 0.74, fov: 26, fill: 1.35, note: 'the daylight opening: pillars, panes, seals' },
  roofline:  { az:  90, el: 22, ah: 0.78, fov: 26, fill: 1.05, note: 'roof arc, rails, aerial, spoiler' },
};
const CARSHEETS = {
  key:   ['side', 'front34', 'front', 'rear34'],
  full:  ['side', 'sideoff', 'front', 'rear', 'front34', 'rear34', 'plan', 'eye'],
  detail:['nose', 'tail', 'wheel', 'dlo', 'roofline'],
  all:   ['side', 'sideoff', 'front', 'rear', 'front34', 'front34b', 'rear34', 'plan',
          'eye', 'nose', 'tail', 'wheel', 'dlo', 'roofline'],
};
/* rec = {x, y, z, yaw, L, W, H} straight off NZ.streetProps.cars[i]; v is a
   CARVIEWS entry; W/H the frame.  Returns the pose fields a shot needs. */
function carPose(rec, v, W, H, fovOverride) {
  const azR = v.az * D2R, elR = v.el * D2R;
  /* the silhouette of a box of L x W x H seen from this azimuth/elevation */
  const sH = rec.L * Math.abs(Math.sin(azR)) + rec.W * Math.abs(Math.cos(azR));
  const sV = sH * Math.sin(elR) + rec.H * Math.cos(elR);
  const fov = fovOverride || v.fov;
  const vf = fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * (W / H));
  /* The silhouette is not at the centre of the car, it is at the near face,
     and on a 4.2 m body seen down a long lens that is most of the distance:
     framing the profile as if the flank sat on the pivot put the camera 2.9 u
     too close and cut both bumpers off the plate.  Solve for the distance to
     the NEAR surface, then push the camera back by the half-depth along the
     view axis. */
  const halfDepth = 0.5 * (rec.L * Math.abs(Math.cos(azR)) + rec.W * Math.abs(Math.sin(azR))) * Math.cos(elR)
                  + 0.5 * rec.H * Math.sin(elR);
  const d = Math.max(sH / v.fill / (2 * Math.tan(hf / 2)),
                     sV / v.fill / (2 * Math.tan(vf / 2)), 2.0) + halfDepth;
  const aimY = rec.y + rec.H * (v.ah === undefined ? 0.5 : v.ah);
  const ax = (v.ax || 0) * rec.L;
  const aim = [rec.x + Math.cos(rec.yaw) * ax, aimY, rec.z + Math.sin(rec.yaw) * ax];
  /* MINUS, not plus: the car parks on the NORTH kerb with a brick garden wall
     a metre off its flank, so the orbit has to run on the ROAD side or every
     view is a photograph of the wall.  az therefore increases clockwise seen
     from above, and az 90 lands on the roadside flank -- the one the owner's
     side photograph shows. */
  const dir = [Math.cos(rec.yaw - azR), Math.sin(rec.yaw - azR)];
  const at = [aim[0] + dir[0] * d * Math.cos(elR),
              aimY + d * Math.sin(elR),
              aim[2] + dir[1] * d * Math.cos(elR)];
  const ld = aimAt(at, aim);
  return { x: +at[0].toFixed(3), y: +at[1].toFixed(3), z: +at[2].toFixed(3),
    yawDeg: ld[0], pitchDeg: ld[1], yaw: ld[0] * D2R, pitch: ld[1] * D2R,
    fov, dist: d };
}

/* --------------------------------------------------------------- presets -- */
/* The street canyon, from STREET-MODULE-CONTRACT.md AMENDMENT 2 (widened):
     body      x [168,252]  z [152,192]   floor y 0,  ceiling/eaves y 52
     roadway   z [160,184]  (crown z = 172), pavements z [152,160] and [184,192]
     kerb top  y 0.5   -> eye on the pavement is 6.9, on the road 6.4
     north facade z=152, south facade z=192, west gable x=168, dead end x=252
     junction  side street enters from the north at x [176,192], z <= 152,
               under the c 28->52 bridge band; junction throat painted road f=0
     island    kerbed teardrop x [184,192] z [168,176], S_BLOCK, conifer+signs
     foyer door x [240,244] at z=152
   A camera must stay >= PRAD (1.15) off a wall plane; everything below has at
   least 3 units of clearance so a facade agent adding a 1-unit bay projection
   cannot bury a preset inside its own geometry. */
const EYE_ROAD = 6.4;     /* the brief's standing eye on the roadway   */
const EYE_WALK = 6.9;     /* the same eye on a 0.5-unit kerb           */
/* Exact gameplay eye height, used by the revised long-route QA cameras.
   The park road now climbs west along the same X axis as 233 Sk.  Its floor
   is the old north/south grade rotated into place, so x=552 is the zero datum
   and every world unit west adds 0.07.  Keeping the arithmetic here lets
   --list work without loading the game. */
const EYE_PLAYER = 5.985;
const PARK_FLOOR = x => +Math.max(0, Math.min(20.16, (552 - x) * 0.07)).toFixed(3);
const PARK_EYE = x => +(PARK_FLOOR(x) + EYE_PLAYER).toFixed(3);
const ARENA_FLOOR = +(PARK_FLOOR(79 * 4 + 2) + 2.10).toFixed(3); /* raised fight floor = 18.48 */
const ARENA_EYE = +(ARENA_FLOOR + EYE_PLAYER).toFixed(3);

const SHOTS = {
  /* --- the two ends of the canyon: the establishing pair ----------------- */
  'street.westend': {
    at: [171, EYE_ROAD, 170], lookat: [252, 7.5, 172], fov: 68,
    note: 'west end behind the island, looking east down the full 84 units to the dead end',
  },
  'street.island': {
    at: [171, EYE_WALK, 158], lookat: [216, 7.5, 176], fov: 70,
    note: 'the ref8 composition from the NW pavement corner: island centre-right, minibus beyond it, street receding east. The old camera at (177,179) ended up 1 m from the new junction parking bay.',
  },
  'street.deadend': {
    at: [248, EYE_ROAD, 172], look: 'west', fov: 68,
    note: 'the dead end at x=252, looking west back up the street to the junction',
  },

  /* --- the two facades, three-quarter: where a flat wall gives itself away */
  'street.north34': {
    at: [198, EYE_WALK, 185.5], lookat: [234, 18, 152], fov: 66,
    note: 'three-quarter on the NORTH facade (z=152, SEYDIKENT B-BLOK pink) from the south pavement',
  },
  'street.south34': {
    at: [198, EYE_WALK, 157], lookat: [234, 18, 192], fov: 66,
    note: 'three-quarter on the SOUTH facade (z=192, SEYDIKENT A-BLOK cream siding) from the north pavement',
  },

  /* --- the flat elevations: proportion, storey rhythm, window grid -------- */
  'street.northwall': {
    at: [206, EYE_ROAD, 180], look: [0, 20], fov: 75,
    note: 'north facade square on, pitched up 20 deg to catch the eaves at y=51.8',
  },
  'street.southwall': {
    at: [206, EYE_ROAD, 164], look: [180, 20], fov: 75,
    note: 'south facade square on, pitched up 20 deg',
  },

  /* --- the destination -------------------------------------------------- */
  'street.entrance': {
    at: [228, EYE_ROAD, 176], lookat: [242, 9, 152], fov: 62,
    note: 'the foyer entrance at x~242, z=152, seen obliquely from the road',
  },

  /* --- the junction, both directions ------------------------------------- */
  'street.junction': {
    at: [196, EYE_ROAD, 178], lookat: [182, 10, 152], fov: 72,
    note: 'from east of the island looking north-west into the side street under the bridge band',
  },
  'street.alley': {
    at: [182, EYE_ROAD, 168], look: 'north', fov: 70,
    note: 'the side-street throat, x [176,192] at z=152, seen from the roadway',
  },

  /* --- the sky, which is a whole module's worth of work ------------------- */
  'street.sky': {
    at: [212, EYE_ROAD, 172], look: 'up', fov: 90,
    note: 'straight up from the crown of the road: both eaves lines and the open sky above c=52',
  },

  /* --- composition ------------------------------------------------------- */
  'street.high': {
    at: [173, 30, 168], lookat: [252, 6, 174], fov: 74,
    note: 'high wide from the west end at mid-facade height, the whole canyon in one frame',
  },

  /* --- the 2 m believability test (non-negotiable 10) --------------------- */
  'street.kerb': {
    at: [204, EYE_WALK, 157.5], look: 'east', fov: 55,
    note: 'on the north pavement 1.6 m off the wall, looking east: no visible tiling at arm\'s length',
  },

  /* --- revised 233 Sk route: player-height acceptance views ------------- */
  'route.corridor': {
    at: [566, EYE_PLAYER, 174], lookat: [756, 10, 174], fov: 62,
    note: 'from the tree roundabout, east through the widened A/B corridor toward 230 Sk; checks both level facades, road/car scale and sparse parking',
  },
  'route.230-vista': {
    at: [778, EYE_PLAYER, 174], lookat: [850, 34, 174], fov: 64,
    note: 'at the 233/230 intersection looking east across only 10-15 m of road to the police closure, low buildings and mountain vista',
  },
  'park.lower-uphill': {
    at: [530, PARK_EYE(530), 174], lookat: [310, PARK_EYE(310), 174], fov: 68,
    note: 'at the roundabout-side end, looking west/uphill along the straight split road beside Yildiz Tepesi; checks that park and 233 Sk share one axis',
  },
  'park.upper-arena': {
    at: [326, PARK_EYE(326), 226], lookat: [318, ARENA_FLOOR + 7.5, 140], fov: 66,
    note: 'from the far/upper park at player height, looking north across 233 Sk to the fight-arena apartment and its public entrance',
  },
  'arena.exterior-entry': {
    at: [338, PARK_EYE(338), 184], lookat: [318, ARENA_FLOOR + 7.5, 140], fov: 68,
    note: 'wider street-level oblique read of the arena entry, canopy, stairs/rails and ordinary apartment frontage',
  },
  'arena.interior-forward': {
    at: [318, ARENA_EYE, 134], lookat: [318, ARENA_FLOOR + 6, 108], fov: 68,
    note: 'just inside the south threshold looking north through the combat floor',
  },
  'arena.interior-back': {
    at: [318, ARENA_EYE, 116], lookat: [318, ARENA_FLOOR + 6, 146], fov: 68,
    note: 'inside the arena looking south through its only public entrance toward the street and park',
  },

  /* --- MISSION 4, THE CORDON.  Run these with --q=level=4; every one of them
     is dark and empty on mission 1, because on mission 1 none of it exists.
     232 Sk is grid columns 137..144, so its crown is world x = 564 and its two
     building lines are 548 and 580. -------------------------------------- */
  'cordon.roundabout': {
    at: [592, EYE_ROAD, 178], lookat: [556, 12, 118], fov: 78,
    note: 'the four-way from east of the island: 233 Sk, the tree roundabout and both new 232 Sk arms in one frame',
  },
  'cordon.n-arm': {
    at: [564, EYE_ROAD, 150], lookat: [558, 13, -72], fov: 72,
    note: '232 Sk north from the apron: clear road, varied apartments and the cemetery tree line at the far left',
  },
  'cordon.n-barricade': {
    at: [564, EYE_ROAD, 74], lookat: [540, 12, -70], fov: 70,
    note: 'downhill approach to the cemetery; the distant map boundary reads as a quiet service gate',
  },
  'cordon.n-balcony': {
    at: [556, EYE_WALK, 94], lookat: [582, 15, 66], fov: 66,
    note: 'the KIZILCALAR loggia over the north arm: the first-floor firing position, from the street it owns',
  },
  'cordon.n-sila': {
    at: [572, EYE_WALK, 120], lookat: [546, 9, 100], fov: 66,
    note: "SILA APT.'s residential facade and doorway on the west kerb",
  },
  'cordon.kizil-flat': {
    at: [612, 11.2 + EYE_PLAYER, 66], lookat: [576, 14.5, 68], fov: 70,
    note: 'inside the first-floor flat that holds the red card, looking out over its own balcony',
  },
  'cordon.s-arm': {
    at: [532, EYE_ROAD, 208], lookat: [532, 14, 470], fov: 70,
    note: 'matching-width 232 Sk south from the apron, lengthened toward Adil Camii',
  },
  'cordon.s-barricade': {
    at: [532, EYE_ROAD, 474], lookat: [532, 14, 550], fov: 68,
    note: 'the south police line, with the street carrying on behind it',
  },
  'cordon.s-bblok': {
    at: [570, EYE_WALK, 200], lookat: [600, 9, 214], fov: 66,
    note: "B-BLOK's residential south-east 233/232 Sk corner and the door the player uses",
  },
  'cordon.s-park': {
    at: [532, EYE_ROAD, 250], lookat: [450, 10, 260], fov: 76,
    note: 'the open park edge beside the widened south arm',
  },
  'cordon.s-balcony': {
    at: [556, EYE_WALK, 268], lookat: [582, 15, 288], fov: 66,
    note: "DEGERLI's loggia over the south arm, seen from the road below it",
  },
  'cordon.checkpoint': {
    at: [300, PARK_EYE(300), 162], lookat: [250, 26, 162], fov: 74,
    note: 'the boom gate, hut and card reader in the lane through the park-crest police line (the checkpoint moved uphill)',
  },
  'cordon.east-line': {
    at: [806, EYE_ROAD, 174], lookat: [860, 10, 174], fov: 76,
    note: 'the east police line, which is a plain barricade now: no gate, and the two blank-ended blocks that used to frame it are gone',
  },
  'cordon.spawn-east': {
    at: [826, EYE_ROAD, 178], lookat: [560, 8, 174], fov: 80,
    note: "mission 4's opening frame after the flip: the east tail, with the whole street climbing away west",
  },
  'cordon.230-north': {
    at: [776, EYE_ROAD, 152], lookat: [776, 12, 92], fov: 68,
    note: 'the north 230 Sk stub, closed by a barricade instead of by the old blank map edge',
  },
  'cordon.230-south': {
    at: [776, EYE_ROAD, 206], lookat: [776, 12, 264], fov: 68,
    note: 'the south 230 Sk stub and its closure',
  },
  'cordon.ablok-in': {
    at: [634, 0.5 + EYE_PLAYER, 128], lookat: [586, 6.5, 128], fov: 68,
    note: "A-BLOK's ground floor looking west down the service passage to the 232 Sk door",
  },
  'cordon.bblok-in': {
    at: [606, 0.5 + EYE_PLAYER, 234], lookat: [580, 6.5, 230], fov: 68,
    note: 'inside the B-BLOK west apartment looking out through the residential entrance',
  },
  'cordon.spawn': {
    at: [278, PARK_EYE(278), 186], lookat: [560, 9, 182], fov: 74,
    note: "mission 4's opening frame: the park crest with the whole street falling away east",
  },

  /* --- the four-way read: what you actually see turning off the island --- */
  'junction.north': {
    at: [564, EYE_ROAD, 168], lookat: [564, 16, 96], fov: 76,
    note: 'from the island, north into 232 Sk: does the mouth read as two corner buildings or as two paper walls',
  },
  'junction.south': {
    at: [564, EYE_ROAD, 188], lookat: [564, 16, 262], fov: 76,
    note: 'from the island, south into 232 Sk',
  },
  'junction.west': {
    at: [576, EYE_ROAD, 174], lookat: [420, 20, 176], fov: 76,
    note: 'from the island, west along 233 Sk into the park',
  },
  'junction.east': {
    at: [552, EYE_ROAD, 174], lookat: [720, 16, 176], fov: 76,
    note: 'from the island, east along 233 Sk into the Seydikent canyon',
  },
  'junction.oblique': {
    at: [600, 34, 210], lookat: [556, 10, 130], fov: 80,
    note: 'high oblique over the island: all four arms and both new corners in one frame',
  },

  /* --- MISSION 1 regression.  The street was lifted out of it; this is the
     spawn it went back to. ------------------------------------------------ */
  'm1.spawn': {
    at: [114, EYE_PLAYER, 146], lookat: [114, 9, 88], fov: 70,
    note: 'mission 1 opens in the night canyon again, facing the hotel door at the far end',
  },
  'm1.alley': {
    at: [178, EYE_PLAYER, 130], lookat: [178, 9, 96], fov: 70,
    note: 'the east alley, where the two sentries the fight hall borrowed have gone back',
  },
};

/* A sheet is just an ordered list of preset names. */
const SHEETS = {
  street: Object.keys(SHOTS).filter(k => k.startsWith('street.')),
  /* the four-frame read when you only have one shell call */
  quick: ['street.westend', 'street.island', 'street.north34', 'street.south34'],
  /* the two facades, every way of looking at them */
  facades: ['street.north34', 'street.south34', 'street.northwall', 'street.southwall', 'street.kerb'],
  revised233: ['route.corridor', 'route.230-vista', 'park.lower-uphill', 'park.upper-arena',
    'arena.exterior-entry', 'arena.interior-forward', 'arena.interior-back'],
  /* MISSION 4. Every one of these needs --q=level=4. */
  cordon: Object.keys(SHOTS).filter(k => k.startsWith('cordon.')),
  cordonquick: ['cordon.roundabout', 'cordon.n-arm', 'cordon.s-arm', 'cordon.checkpoint'],
  junction: ['junction.north', 'junction.south', 'junction.west', 'junction.east', 'junction.oblique'],
  cordonside: ['cordon.n-arm', 'cordon.n-barricade', 'cordon.n-balcony', 'cordon.n-sila',
    'cordon.s-arm', 'cordon.s-barricade', 'cordon.s-bblok', 'cordon.s-balcony'],
  /* MISSION 1 after the street was lifted out of it. */
  mission1: ['m1.spawn', 'm1.alley'],
};

/* --------------------------------------------------------------- helpers -- */
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const say = (...a) => { if (!OPT.quiet) console.log('[' + el() + ']', ...a); };
const left = () => OPT.budget - (Date.now() - T0) / 1000;
function fail(msg) { console.error('[' + el() + '] FAIL: ' + msg); process.exit(1); }

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const COMPASS = {
  north: [0, 0], n: [0, 0],
  south: [180, 0], s: [180, 0],
  east: [-90, 0], e: [-90, 0],
  west: [90, 0], w: [90, 0],
  northeast: [-45, 0], ne: [-45, 0],
  northwest: [45, 0], nw: [45, 0],
  southeast: [-135, 0], se: [-135, 0],
  southwest: [135, 0], sw: [135, 0],
  up: [0, 89], down: [0, -89],
};
/* name a yaw back, so the log is self-checking */
function compassOf(yawDeg) {
  const n = ['north', 'northwest', 'west', 'southwest', 'south', 'southeast', 'east', 'northeast'];
  let a = ((yawDeg % 360) + 360) % 360;
  return n[Math.round(a / 45) % 8];
}
function triple(s, what) {
  const p = String(s).split(',').map(Number);
  if (p.length !== 3 || p.some(v => !isFinite(v))) fail(`--${what} wants x,y,z -- got "${s}"`);
  return p;
}
/* forward = (-sin yaw, 0, -cos yaw), so yaw = atan2(-dx, -dz) */
function aimAt(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const h = Math.hypot(dx, dz);
  return [Math.atan2(-dx, -dz) * R2D, Math.atan2(dy, h || 1e-6) * R2D];
}
function resolveLook(spec, from) {
  if (Array.isArray(spec)) return spec.slice(0, 2).map(Number);
  const s = String(spec == null ? 'north' : spec).trim().toLowerCase();
  if (COMPASS[s]) return COMPASS[s].slice();
  const p = s.split(',').map(Number);
  if (p.length >= 1 && p.every(v => isFinite(v))) return [p[0], p[1] || 0];
  fail(`--look wants a compass word or yaw,pitch in degrees -- got "${spec}"` +
       `\n  words: ${Object.keys(COMPASS).join(' ')}`);
}
/* one shot, fully resolved: world position, radians, lens, filename stem */
function normShot(name, def) {
  const at = def.at.map(Number);
  let ld = def.lookat ? aimAt(at, def.lookat) : resolveLook(def.look, at);
  if (OPT.look) ld = resolveLook(OPT.look, at);
  if (OPT.lookat) ld = aimAt(at, triple(OPT.lookat, 'lookat'));
  return {
    name,
    x: at[0], y: at[1], z: at[2],
    yawDeg: ld[0], pitchDeg: ld[1],
    yaw: ld[0] * D2R, pitch: ld[1] * D2R,
    fov: OPT.fov || def.fov || 68,
    note: def.note || '',
  };
}

if (OPT.list) {
  console.log('presets:');
  for (const [k, v] of Object.entries(SHOTS)) {
    const s = normShot(k, v);
    console.log('  ' + k.padEnd(26) +
      `at ${[s.x, s.y, s.z].join(',')}`.padEnd(25) +
      `yaw ${s.yawDeg.toFixed(0)} (${compassOf(s.yawDeg)}) pitch ${s.pitchDeg.toFixed(0)} fov ${s.fov}`);
    if (v.note) console.log(' '.repeat(20) + v.note);
  }
  console.log('\nsheets:');
  for (const [k, v] of Object.entries(SHEETS)) console.log('  ' + k.padEnd(12) + v.length + ' shots  ' + v.join(' '));
  console.log('\nlook words: ' + Object.keys(COMPASS).join(' '));
  console.log('angles:     yaw 0=north(-Z) -90=east(+X) 90=west(-X) 180=south(+Z); pitch +ve = up');
  console.log('revised route: straight 233 x [264,836], road z [160,188]; park x [264,548] beside the same axis, westward grade 0.07; A/B x [580,760]; 230 Sk x [760,792]; exact player eye 5.985 above floor');
  process.exit(0);
}

/* ------------------------------------------------------------ toolchain -- */
/* /tmp is per-session.  Rather than leave the next agent to rediscover the
   recipe in RENDER-CONTRACT.md section 6.2, put it back automatically and say
   so.  Each step is idempotent and guarded by its own artefact. */
function sh(cmd, ms) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: ms || 40000, encoding: 'utf8' });
}
function haveChrome() { return fs.existsSync(CHROME); }
function haveLibs() { return LIB_DIRS.split(':').some(d => fs.existsSync(path.join(d, 'libXdamage.so.1'))); }
function havePP() { return fs.existsSync(path.join(PP_DIR, 'node_modules', 'puppeteer', 'package.json')); }

function bootstrap() {
  let did = [];
  if (!haveChrome()) {
    say('toolchain: chrome-headless-shell missing -> downloading Chrome for Testing (~120 MB, ~20 s)');
    const t = Date.now();
    const v = sh(`curl -sS https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json` +
      ` | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).channels.Stable.version))"`, 20000).trim();
    sh(`curl -sS -C - -o /tmp/chs.zip "https://storage.googleapis.com/chrome-for-testing-public/${v}/linux64/chrome-headless-shell-linux64.zip"`, 90000);
    sh(`unzip -qo /tmp/chs.zip -d /tmp/chs && chmod +x ${CHROME}`, 40000);
    did.push('chrome ' + v);
    say(`toolchain: chrome ${v} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  if (!haveLibs()) {
    /* libXdamage1 is the ONE shared library missing on this image; everything
       else chrome asks for is already here.  No root needed for either half. */
    say('toolchain: libXdamage.so.1 missing -> apt-get download libxdamage1 + dpkg-deb -x');
    const t = Date.now();
    sh('mkdir -p /tmp/deb && cd /tmp/deb && apt-get download libxdamage1 >/dev/null 2>&1' +
       ' && for d in /tmp/deb/*.deb; do dpkg-deb -x "$d" /tmp/root; done', 40000);
    did.push('libxdamage1');
    say(`toolchain: libs in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  if (!havePP()) {
    /* puppeteer-core only, aliased as "puppeteer", so npm never downloads a
       second browser.  The repo's own node_modules/@puppeteer tree is an empty
       husk and is deliberately left alone. */
    say('toolchain: puppeteer missing -> npm install puppeteer-core@23 into ' + PP_DIR + ' (~10 s)');
    const t = Date.now();
    sh(`mkdir -p ${PP_DIR} && cd ${PP_DIR} && [ -f package.json ] || echo '{"name":"pp","private":true}' > package.json`, 10000);
    sh(`cd ${PP_DIR} && npm install puppeteer-core@23 --no-audit --no-fund --loglevel=error`, 90000);
    sh(`mkdir -p ${PP_DIR}/node_modules/puppeteer` +
       ` && printf '{"name":"puppeteer","version":"0.0.0","main":"index.cjs"}' > ${PP_DIR}/node_modules/puppeteer/package.json` +
       ` && printf "module.exports = require('puppeteer-core');" > ${PP_DIR}/node_modules/puppeteer/index.cjs` +
       ` && echo noop > ${PP_DIR}/noop.cjs`, 10000);
    did.push('puppeteer-core@23');
    say(`toolchain: puppeteer in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  /* render-critic.mjs and every other harness read these three, so leave them
     on disk whether or not we installed anything this run. */
  if (!fs.existsSync('/tmp/chsenv.sh') || did.length) {
    fs.writeFileSync('/tmp/chsenv.sh',
      '# chrome-headless-shell environment -- written by scripts/render-level.mjs\n' +
      `export CRITIC_PP=${PP_DIR}\n` +
      `export CRITIC_CHROME=${CHROME}\n` +
      `export CRITIC_LIBS=${LIB_DIRS}\n` +
      'export LD_LIBRARY_PATH="$CRITIC_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\n');
  }
  return did;
}

/* ----------------------------------------------------------- staging ----- */
/* Boot was measured at 11 s once and 35+ s five minutes later on the same
   unchanged repo.  Two causes, both fixable from outside the repo:

   1. NUKEM.html:302 pulls three.js from unpkg.com on a BLOCKING script tag in
      the head.  Every run is a fresh browser profile, so every run re-fetches
      ~600 kB over the network before the parser moves on.  The page already
      ships the identical library at vendor/three.r149.min.js as its own
      fallback (NUKEM.html:312) -- so point the tag at it.
   2. The repo lives on a mounted Windows folder.  bash reads it fast, but the
      browser's file:// reads out of its sandbox are not: domcontentloaded
      measured 0.35 s from /tmp and 5-6 s from the mount.

   So the page is staged into /tmp (which this script owns) and loaded from
   there.  The stage is refreshed by size+mtime on every run, so an art agent's
   save is always picked up -- --nostage loads the repo directly if you ever
   need to prove the staging is not lying to you.

   --lean (the default) also drops nz-enemies / nz-weapons / nz-audio from the
   staged copy.  None of them puts a pixel on a street facade, all three cost
   boot time baking rigs, viewmodels and sfx, and the game is required to run
   with any module deleted (STREET-MODULE-CONTRACT.md non-negotiable 4).
   --full puts them back. */
/* Use the platform temp directory.  A root-relative `/tmp` becomes `C:\\tmp`
   on Windows and may be outside the writable sandbox even though the actual
   per-user temporary directory is available. */
const STAGE = process.env.CRITIC_STAGE || path.join(os.tmpdir(), 'nzlvl');
const LEAN_OUT = ['nz-enemies.js', 'nz-weapons.js', 'nz-audio.js'];

function stageLevel(lean) {
  fs.mkdirSync(path.join(STAGE, 'vendor'), { recursive: true });
  let copied = 0;
  const sync = (rel) => {
    const src = path.join(ROOT, rel), dst = path.join(STAGE, rel);
    if (!fs.existsSync(src)) return;
    const a = fs.statSync(src);
    let b = null; try { b = fs.statSync(dst); } catch (e) { }
    if (b && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 1) return;
    fs.copyFileSync(src, dst);
    try { fs.utimesSync(dst, a.atime, a.mtime); } catch (e) { }
    copied++;
  };
  for (const f of fs.readdirSync(ROOT)) if (/\.(js|png)$/.test(f)) sync(f);
  if (fs.existsSync(path.join(ROOT, 'vendor')))
    for (const f of fs.readdirSync(path.join(ROOT, 'vendor'))) sync(path.join('vendor', f));

  let html = fs.readFileSync(path.join(ROOT, 'NUKEM.html'), 'utf8');
  const cdn = /<script src="https:\/\/unpkg\.com\/three@[^"]*"><\/script>/;
  const hadCdn = cdn.test(html);
  html = html.replace(cdn, '<script src="vendor/three.r149.min.js"></script><!-- staged: local r149, was unpkg -->');
  const dropped = [];
  if (lean) for (const f of LEAN_OUT) {
    const tag = new RegExp('<script src="' + f.replace('.', '\\.') + '"></script>', 'g');
    if (tag.test(html)) { html = html.replace(tag, '<!-- staged lean: ' + f + ' -->'); dropped.push(f); }
  }
  const out = path.join(STAGE, 'NUKEM.staged.html');
  const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (prev !== html) { fs.writeFileSync(out, html); copied++; }
  return { file: out, copied, hadCdn, dropped };
}

/* --------------------------------------------------------------- the run -- */
(async () => {
  if (!fs.existsSync(path.join(ROOT, 'NUKEM.html'))) fail('missing ' + path.join(ROOT, 'NUKEM.html'));

  let installed = [];
  try { installed = bootstrap(); }
  catch (e) {
    fail('toolchain install failed: ' + String(e.message).split('\n')[0] +
      '\n  do it by hand (RENDER-CONTRACT.md section 6.2):' +
      '\n    curl -sS -o /tmp/chs.zip https://storage.googleapis.com/chrome-for-testing-public/<ver>/linux64/chrome-headless-shell-linux64.zip' +
      '\n    unzip -qo /tmp/chs.zip -d /tmp/chs' +
      '\n    mkdir -p /tmp/deb && cd /tmp/deb && apt-get download libxdamage1 && dpkg-deb -x /tmp/deb/*.deb /tmp/root' +
      '\n    mkdir -p /tmp/pp && cd /tmp/pp && npm i puppeteer-core@23');
  }
  if (installed.length) {
    say('toolchain installed: ' + installed.join(', ') + ' -- /tmp/chsenv.sh written');
    if (OPT.setup || left() < 16) {
      say(`stopping here at ${el()} so the install does not blow the 45 s shell cap.`);
      say('RE-RUN THE SAME COMMAND -- the toolchain is now in place and boot is ~9 s.');
      process.exit(0);
    }
  } else if (OPT.setup) {
    say('toolchain already complete: chrome + libXdamage + puppeteer, /tmp/chsenv.sh written');
    process.exit(0);
  }

  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? LIB_DIRS + ':' + process.env.LD_LIBRARY_PATH : LIB_DIRS;
  const require = createRequire(path.join(PP_DIR, 'noop.cjs'));
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch (e) { fail('puppeteer not importable from ' + PP_DIR + ': ' + e.message + '\n  try: node scripts/render-level.mjs --setup'); }

  /* ------------------------------------------------------------- plan --- */
  let names;
  if (OPT.car) {
    const s = String(OPT.car) === 'true' ? 'key' : String(OPT.car);
    names = CARSHEETS[s] ? CARSHEETS[s].slice() : s.split(',').map(x => x.trim()).filter(Boolean);
    const bad = names.filter(n => !CARVIEWS[n]);
    if (bad.length) fail('unknown car view(s): ' + bad.join(', ') +
      '\n  views: ' + Object.keys(CARVIEWS).join(' ') +
      '\n  sheets: ' + Object.keys(CARSHEETS).join(' '));
    names = names.map(n => 'car.' + n);
  } else if (OPT.sheet) {
    const s = String(OPT.sheet);
    names = SHEETS[s] ? SHEETS[s].slice() : s.split(',').map(x => x.trim()).filter(Boolean);
    const bad = names.filter(n => !SHOTS[n]);
    if (bad.length) fail('unknown preset(s): ' + bad.join(', ') + '  (--list)');
  } else if (OPT.shot) {
    if (!SHOTS[OPT.shot]) fail(`unknown preset "${OPT.shot}"  (--list)`);
    names = [String(OPT.shot)];
  } else if (OPT.at) {
    names = ['@adhoc'];
  } else {
    names = ['street.westend'];   /* the establishing shot is the sane default */
  }

  const isSheet = names.length > 1;
  const adhoc = names[0] === '@adhoc';
  const all = names.map(n => {
    if (n === '@adhoc') {
      const at = triple(OPT.at, 'at');
      return normShot('adhoc', { at, look: OPT.look || 'north', fov: OPT.fov || 68 });
    }
    if (OPT.car) {
      /* placeholder: the real pose cannot exist until the level is built and
         NZ.streetProps.cars has published where the body actually stands.
         solveCarPoses() below overwrites every field except the name. */
      const v = CARVIEWS[n.slice(4)];
      return { name: n, x: 0, y: 0, z: 0, yawDeg: 0, pitchDeg: 0, yaw: 0, pitch: 0,
        fov: OPT.fov || v.fov, note: v.note, view: v };
    }
    const def = Object.assign({}, SHOTS[n]);
    /* an explicit --at/--look on top of a preset overrides just that field */
    if (OPT.at) def.at = triple(OPT.at, 'at');
    return normShot(n, def);
  });

  const W = OPT.w || 640, H = OPT.h || 400;
  const outArg = OPT.out ? String(OPT.out) : null;
  const outDir = isSheet
    ? path.resolve(ROOT, outArg || path.join('_shots', OPT.car
        ? 'car' : String(OPT.sheet).replace(/[^\w.-]/g, '_')))
    : path.dirname(path.resolve(ROOT, outArg || path.join('_shots', (adhoc
        ? `at_${all[0].x}_${all[0].y}_${all[0].z}_${compassOf(all[0].yawDeg)}`
        : all[0].name.replace(/[^\w.-]/g, '_')) + '.png')));
  fs.mkdirSync(outDir, { recursive: true });
  const outPathFor = s => isSheet
    ? path.join(outDir, s.name.replace(/[^\w.-]/g, '_') + '.png')
    : path.resolve(ROOT, outArg || path.join('_shots', (adhoc
        ? `at_${s.x}_${s.y}_${s.z}_${compassOf(s.yawDeg)}`
        : s.name.replace(/[^\w.-]/g, '_')) + '.png'));

  /* resumable: a shot already on disk is a shot already paid for */
  let todo = all;
  if (isSheet && !OPT.force && !OPT.car) {
    todo = all.filter(s => !fs.existsSync(outPathFor(s)));
    const done = all.length - todo.length;
    if (done) say(`resume: ${done}/${all.length} already on disk in ${path.relative(ROOT, outDir)}`);
  }
  if (OPT.one) todo = todo.slice(0, 1);
  if (!todo.length) { say('nothing to do -- every shot exists. --force to redo.'); process.exit(0); }

  /* How many frames to hold after a camera cut -- and this is THE number that
     decides whether a run fits, so it is worth knowing why.

     A frame's JS costs ~20 ms here, but SwiftShader runs behind a command
     queue, so the GPU work is not paid until something forces a sync.  The
     readback at the end of the shot is that something: measured 3.8 s to drain
     4 frames, 8.3 s to drain 4 frames plus a backlog.  So the real price of a
     shot is roughly ONE SECOND PER RENDERED FRAME at 640x400 nzq=low, and it
     shows up in the grab, not in the hold.  Render fewer frames, not faster
     ones.

     At nzq=low the TAA is off entirely (nz-render.js:157), so one frame after
     the pose write is already correct -- applyPose() runs at priority 1000,
     before nz-render draws that same frame -- and 2 is belt and braces.  At
     med and above the TAA history has to be refilled after a cut, which is why
     those tiers are a one-shot-per-call proposition.
     Cost scales with pixels: --w/--h double the area, double the seconds. */
  const HOLD_FRAMES = OPT.taa || (OPT.nzq === 'low' ? 2 : 10);
  const HOLD_MS = OPT.wait || 8000;
  say(`plan: ${todo.length} shot(s) ${W}x${H} nzq=${OPT.nzq} hold=${HOLD_FRAMES}f/${HOLD_MS}ms, budget ${OPT.budget}s`);

  const tLaunch = Date.now();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--allow-file-access-from-files',
      '--enable-webgl', '--ignore-gpu-blocklist', '--hide-scrollbars',
      /* an accelerated 2D canvas deadlocks on readback after a WebGL drawImage
         under SwiftShader -- keep the compositor off it (render-critic.mjs:297) */
      '--disable-accelerated-2d-canvas',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      `--window-size=${W},${H}`],
  });
  say(`launch ${Date.now() - tLaunch}ms`);

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  /* Console capture.  A street module that panicked logs one line and sets its
     NZ.flags entry false; both halves of that have to reach the operator. */
  const issues = [], modLog = [];
  const noteMsg = (kind, t) => {
    const s = kind + ': ' + String(t).slice(0, 400);
    if (/\[nz-?[a-z-]*\]|\[nz\]/i.test(t)) modLog.push(s);
    if (kind === 'error' || kind === 'PAGEERROR' || /error|fail|panic|threw|missing|cannot|undefined is not/i.test(t)) issues.push(s);
  };
  page.on('console', m => noteMsg(m.type(), m.text()));
  page.on('pageerror', e => noteMsg('PAGEERROR', e.message));
  page.on('requestfailed', r => {
    const u = r.url();
    if (/nz-[\w-]+\.js$/.test(u)) noteMsg('error', 'SCRIPT NOT LOADED ' + u.split('/').pop() + ' (' + (r.failure() ? r.failure().errorText : '?') + ')');
  });

  /* ------------------------------------------------------------- boot --- */
  /* nz-shots mode=single: one preset, full screen, sim frozen, camera posed by
     applyPose() every frame.  prewarm=0 is what takes boot from the ~30 s
     VERIFY-REPORT quotes down to ~9 s (RENDER-CONTRACT 6.4).

     warm/settle are pinned to 1 because this script does its own holding: every
     frame nz-shots spends settling on ITS preset pose is a frame rendered at a
     camera we are about to throw away, and a frame here is 0.5-2.5 s.  The
     freeze still happens (setPlaying(false) fires at RUN.f === warm), we just
     do not pay for it twice.

     width/height must equal the viewport: nz-shots letterboxes the canvas to
     fit the window, so a mismatched aspect costs resolution for nothing. */
  const q = new URLSearchParams({
    shot: 'env', mode: 'single', i: '0',
    width: String(W), height: String(H),
    ss: '1', nzq: OPT.nzq, prewarm: '0', warm: '1', settle: '1',
  });
  if (OPT.seed) q.set('seed', String(OPT.seed));
  if (OPT.diag) q.set('nzdebug', '1');

  let pageFile = path.join(ROOT, 'NUKEM.html'), stagedNote = 'repo (--nostage)';
  if (!OPT.nostage) {
    const t = Date.now();
    const st = stageLevel(!OPT.full);
    pageFile = st.file;
    stagedNote = `${STAGE} (${st.copied} file(s) refreshed in ${Date.now() - t}ms` +
      (st.hadCdn ? ', unpkg->vendor/three.r149' : '') +
      (st.dropped.length ? ', lean: no ' + st.dropped.join('/') : ', full') + ')';
  }
  /* pathToFileURL is important on Windows: the staged file is a native
     drive-letter path.  Hand-building `file://` used to point Chrome at a
     different, nonexistent location.  The helper also handles spaces and
     non-ASCII safely. */
  const u = url.pathToFileURL(pageFile).href + '?' + q.toString() +
    (OPT.q ? '&' + String(OPT.q) : '');
  say('stage ' + stagedNote);
  say('boot  ' + path.basename(pageFile) + '?' + q.toString().slice(0, 80) + '...');

  const written = [];
  let stopped = null, tookFirst = 0;
  try {
    /* NOT awaited: DOMContentLoaded fires long before the level is built, and
       the title is the real ready signal. */
    const g0 = Date.now();
    page.goto(u, { waitUntil: 'domcontentloaded', timeout: Math.max(4000, left() * 1000) })
      .then(() => say(`domcontentloaded ${Date.now() - g0}ms`))
      .catch(e => say('goto: ' + String(e.message).split('\n')[0]));

    /* nz-shots.js:1447 sets 'SHOT SINGLE' the moment the level is built and
       RUN is armed -- which is also the moment NZ.shots.pose starts being read
       every frame.  That, not the later 'SHOT READY' (:916, warm+settle frames
       later), is when the free camera becomes usable.  Waiting for READY would
       burn several 1-2 s frames on a pose we are about to overwrite. */
    let title = '';
    for (;;) {
      try { title = await page.title(); } catch (e) { /* mid-navigation */ }
      if (title === 'SHOT SINGLE' || title === 'SHOT READY') break;
      if (title === 'SHOT ERROR' || title === 'SHOT STALLED') {
        stopped = 'nz-shots reported ' + title + ' -- the level did not build';
        break;
      }
      if (left() < 6) { stopped = `boot did not reach SHOT SINGLE inside the budget (title="${title}")`; break; }
      await new Promise(r => setTimeout(r, 120));
    }
    if (!stopped) {
      say(`${title} -- level built, boot ${el()}`);
      /* Boot has been measured at 9.7 s and 30.5 s on the same unchanged repo
         within ten minutes.  This box has 2 cores and the other agents are
         building on them; nothing here can fix that, but it can say so instead
         of letting the shell's 45 s cap kill a half-written PNG. */
      if ((Date.now() - T0) / 1000 > 20)
        say('NOTE: boot was slow -- the box is contended (2 cores, sibling agents building).');
      if (left() < 5) {
        stopped = `boot ate the budget (${el()} of ${OPT.budget}s); no time left to render`;
        say('BUDGET: ' + stopped + ' -- re-run, the box may be quieter.');
      }
    }

    if (stopped) {
      say('BOOT FAILED: ' + stopped);
    } else {
      /* Three things get installed here, all from the page side, so that no
         file on disk has to change.

         1. A frame counter on the 'render' hook at priority 500 -- BELOW
            nz-shots' 1000 (so the pose for this frame is already applied) and
            ABOVE nz-render's, which is the load-bearing half: 'render' is
            dispatched with NZ.first(), which stops at the handler that returns
            true, and nz-render returns true when it draws (RENDER-CONTRACT
            appendix).  A counter installed below nz-render never runs at all --
            it silently reports zero frames forever, which is exactly the bug
            this comment exists to stop the next person rediscovering.
            The hook returns undefined so nz-render still gets the frame.

         2. A pause/resume brake on requestAnimationFrame.  NUKEM.html:8003
            re-arms the loop with a bare requestAnimationFrame(), so parking the
            callback stops the loop after the current frame and hands it back
            untouched on resume.  Capturing against a parked loop means the
            capture does not have to queue behind a 2 s software frame, and
            nothing can overwrite the converged frame between hold and grab.

         3. THE CAPTURE TARGET.  This is the whole performance story, and it
            corrects RENDER-CONTRACT 6.4: page.screenshot() does return, but it
            goes through the compositor, and the compositor is the one path
            SwiftShader is terrible at -- measured 22-30 s for a single 640x400
            grab of the open street, which does not fit in a 45 s shell call.
            _critic_operators.html:300-318 already solved this: remap
            setRenderTarget(null) to an FBO we own, then readRenderTargetPixels
            + putImageData + toDataURL, which is a pure CPU path and costs
            ~0.3 s.  The same remap works on the live game because nz-render
            presents through renderer.setRenderTarget like everything else.
            The visible canvas goes black afterwards; headless, nobody cares. */
      const capOK = await page.evaluate((hud) => {
        const orig = window.requestAnimationFrame.bind(window);
        window.__lvlPending = null; window.__lvlPaused = false;
        window.requestAnimationFrame = function (cb) {
          if (window.__lvlPaused) { window.__lvlPending = cb; return -1; }
          return orig(cb);
        };
        window.__lvlPause = function () { window.__lvlPaused = true; };
        window.__lvlResume = function () {
          window.__lvlPaused = false;
          const c = window.__lvlPending; window.__lvlPending = null;
          if (c) orig(c);
        };
        /* Exact frame stepping.  A JS frame costs ~20 ms but queues ~1 s of
           SwiftShader work, so a poll-and-pause loop from Node overshoots by
           several frames -- i.e. by several seconds -- before it can stop.
           Counting down inside the hook stops the loop on the exact frame. */
        window.__lvlFrames = 0; window.__lvlBudget = 0;
        NZ.on('render', function () {
          window.__lvlFrames++;
          if (window.__lvlBudget > 0 && --window.__lvlBudget === 0) window.__lvlPause();
          return undefined;
        }, 500);
        window.__lvlRun = function (n) { window.__lvlBudget = n; window.__lvlResume(); };
        if (!hud) { const o = document.getElementById('overlay'); if (o) o.style.display = 'none'; }
        const b = document.getElementById('nzShotBanner'); if (b) b.remove();

        try {
          const R = NZ.ctx.renderer, T = NZ.ctx.THREE || window.THREE;
          const RW = R.domElement.width, RH = R.domElement.height;
          const rt = new T.WebGLRenderTarget(RW, RH, {
            format: T.RGBAFormat, type: T.UnsignedByteType,
            minFilter: T.LinearFilter, magFilter: T.LinearFilter,
            depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
          });
          if (T.SRGBColorSpace) rt.texture.colorSpace = T.SRGBColorSpace;
          else rt.texture.encoding = T.sRGBEncoding;
          const setRT = R.setRenderTarget.bind(R);
          R.setRenderTarget = function (t, a, m) { return setRT((t === null || t === undefined) ? rt : t, a, m); };

          const pix = new Uint8Array(RW * RH * 4);
          const cv = document.createElement('canvas');
          cv.width = RW; cv.height = RH;
          const c2 = cv.getContext('2d', { willReadFrequently: true });
          const idat = c2.createImageData(RW, RH);
          window.__lvlGrab = function () {
            R.readRenderTargetPixels(rt, 0, 0, RW, RH, pix);
            const dst = idat.data, row = RW * 4;          /* GL is bottom-up */
            for (let y = 0; y < RH; y++) {
              const s = (RH - 1 - y) * row, d = y * row;
              for (let i = 0; i < row; i += 4) {
                dst[d + i] = pix[s + i]; dst[d + i + 1] = pix[s + i + 1];
                dst[d + i + 2] = pix[s + i + 2]; dst[d + i + 3] = 255;
              }
            }
            c2.putImageData(idat, 0, 0);
            return cv.toDataURL('image/png');
          };
          /* allocate the FBO and the readback path now, while it is free (a
             1x1 read costs 5 ms), so the first real grab measures the frame
             queue and nothing else */
          const one = new Uint8Array(4);
          window.__lvlWarm = function () { R.readRenderTargetPixels(rt, 0, 0, 1, 1, one); };
          return RW + 'x' + RH;
        } catch (e) { return 'FAILED: ' + e.message; }
      }, OPT.hud).catch(e => 'FAILED: ' + e.message);
      if (String(capOK).startsWith('FAILED')) {
        say('capture target ' + capOK + ' -- falling back to page.screenshot() (slow: ~25s/shot)');
      } else say('capture target ' + capOK + ' (FBO readback, compositor bypassed)');
      const useFBO = !String(capOK).startsWith('FAILED');
      if (useFBO) {
        /* Drain the boot backlog before the clock starts on shot 1.  Building
           the level queues a lot of GPU work that SwiftShader has not executed
           yet -- nothing has forced a sync -- and it also has every shader in
           the scene still to JIT.  The first readback pays all of it: measured
           7-12 s, and it is a property of the page load, not of the shot.
           Paying it here keeps it out of the per-shot estimate. */
        const t = Date.now();
        await page.evaluate(() => window.__lvlWarm()).catch(() => {});
        say(`drain ${((Date.now() - t) / 1000).toFixed(1)}s (boot backlog + shader JIT, once per page load)`);
      }

      /* one camera move + one FBO readback, with no budget arithmetic in it --
         the daemon below has no budget, and the sheet loop keeps its own. */
      async function grabShot(s) {
        const moved = await page.evaluate((p, n) => {
          const P = NZ.shots.pose;
          P.x = p.x; P.y = p.y; P.z = p.z;
          P.yaw = p.yaw; P.pitch = p.pitch; P.roll = 0; P.fov = p.fov;
          window.__lvlRun(n);
          return window.__lvlFrames;
        }, s, Math.max(HOLD_FRAMES, 2));
        const tPose = Date.now();
        let held = 0;
        while ((Date.now() - tPose < HOLD_MS || held < 1) && Date.now() - tPose < 45000) {
          const st = await page.evaluate(() => [window.__lvlFrames, window.__lvlPaused])
            .catch(() => [1e9, true]);
          held = st[0] - moved;
          if (st[1]) break;
          await new Promise(r => setTimeout(r, 40));
        }
        await page.evaluate(() => { if (window.__lvlPause) window.__lvlPause(); }).catch(() => {});
        if (!useFBO) return null;
        const durl = await page.evaluate(() => window.__lvlGrab()).catch(e => 'ERR ' + e.message);
        if (typeof durl === 'string' && durl.startsWith('data:image/png'))
          return Buffer.from(durl.split(',')[1], 'base64');
        return null;
      }

      /* ---------------------------------------------------- solve the rig --
         nz-street-props publishes {x, z, y: baseY, spec, yaw} for every parked
         body (nz-street-props.js:4601).  Read it, and every car view becomes a
         pose the model itself decides -- so re-proportioning the Courier
         re-frames its own photographs on the next run instead of drifting out
         of the crop. */
      if (OPT.car) {
        const rec = await page.evaluate((idx) => {
          const cs = (window.NZ && NZ.streetProps && NZ.streetProps.cars) || [];
          const c = cs[idx];
          if (!c) return { n: cs.length };
          return { n: cs.length, x: c.x, y: c.y, z: c.z, yaw: c.yaw,
            L: c.spec.L, W: c.spec.W, H: c.spec.H, nm: c.spec.nm };
        }, OPT.carIdx).catch(e => ({ err: e.message }));
        if (!rec || rec.err || rec.x === undefined)
          fail('--car: NZ.streetProps.cars[' + OPT.carIdx + '] is not there ' +
               '(cars published: ' + (rec && rec.n) + (rec && rec.err ? ', ' + rec.err : '') + ')');
        say(`car[${OPT.carIdx}] "${rec.nm}" centre ${rec.x.toFixed(1)},${rec.y.toFixed(2)},${rec.z.toFixed(1)} ` +
            `yaw ${(rec.yaw * 180 / Math.PI).toFixed(1)} deg  LxWxH ${rec.L.toFixed(2)} x ${rec.W.toFixed(2)} x ${rec.H.toFixed(2)} u ` +
            `(${(rec.L / 3.5).toFixed(2)} x ${(rec.W / 3.5).toFixed(2)} x ${(rec.H / 3.5).toFixed(2)} m)`);
        for (const s of todo) {
          Object.assign(s, carPose(rec, s.view, W, H, OPT.fov));
          say(`  ${s.name.padEnd(14)} d ${s.dist.toFixed(1)}u  at ${s.x},${s.y},${s.z}  ` +
              `yaw ${s.yawDeg.toFixed(0)} pitch ${s.pitchDeg.toFixed(0)} fov ${s.fov}`);
        }
      }

      /* ================================================== STUDIO DAEMON ====
         Boot is 78 s and the first readback another 40 s on this box, against
         ~30-50 s for the shot itself.  Iterating on a MODEL means dozens of
         camera moves against one unchanged build, so paying that 118 s per
         camera move is the whole cost of the exercise.  --serve pays it once,
         then stays up and takes camera orders over the loopback:

           node scripts/render-level.mjs --car --serve=7788 --w=640 --h=400 &
           curl 'http://127.0.0.1:7788/shot?views=side,front34&out=_shots/it3'
           curl http://127.0.0.1:7788/quit

         There is deliberately NO reload endpoint: re-staging and re-booting
         inside the daemon costs exactly what killing it and starting a new one
         costs, and a fresh process cannot inherit a half-torn-down GL context.
         Edit the model, kill, restart.  /ping answers as soon as the level is
         up, which is the signal a caller should poll for. */
      if (OPT.serve) {
        const http = await import('node:http');
        let busy = false;
        const server = http.createServer(async (req, res) => {
          const uq = new URL(req.url, 'http://127.0.0.1');
          const send = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj, null, 1));
          };
          if (uq.pathname === '/ping') return send(200, { ok: 1, up: +el().replace('s', '') });
          if (uq.pathname === '/quit') { send(200, { ok: 1, bye: 1 }); setTimeout(() => process.exit(0), 60); return; }
          if (uq.pathname !== '/shot') return send(404, { err: 'try /ping /shot /quit' });
          if (busy) return send(429, { err: 'a shot is already rendering' });
          busy = true;
          const t0 = Date.now();
          try {
            const vs = String(uq.searchParams.get('views') || 'side').split(',')
              .map(x => x.trim()).filter(Boolean);
            const bad = vs.filter(n => !CARVIEWS[n]);
            if (bad.length) { busy = false; return send(400, { err: 'unknown view(s) ' + bad.join(',') , views: Object.keys(CARVIEWS) }); }
            const dir = path.resolve(ROOT, uq.searchParams.get('out') || '_shots/car');
            fs.mkdirSync(dir, { recursive: true });
            const fovQ = Number(uq.searchParams.get('fov')) || 0;
            /* re-read every time: a rebuilt body moves its own centre */
            const rc = await page.evaluate((idx) => {
              const c = ((window.NZ && NZ.streetProps && NZ.streetProps.cars) || [])[idx];
              return c ? { x: c.x, y: c.y, z: c.z, yaw: c.yaw, L: c.spec.L, W: c.spec.W, H: c.spec.H } : null;
            }, OPT.carIdx);
            if (!rc) { busy = false; return send(500, { err: 'no car published' }); }
            const out = [];
            for (const n of vs) {
              const s = Object.assign({ name: 'car.' + n }, carPose(rc, CARVIEWS[n], W, H, fovQ));
              const tgt = path.join(dir, 'car.' + n + '.png');
              const buf = await grabShot(s);
              if (!buf) { out.push({ view: n, err: 'grab failed' }); continue; }
              fs.writeFileSync(tgt, buf);
              out.push({ view: n, file: path.relative(ROOT, tgt), kB: Math.round(buf.length / 1024),
                at: [s.x, s.y, s.z], yaw: +s.yawDeg.toFixed(1), pitch: +s.pitchDeg.toFixed(1), fov: s.fov });
              say(`served ${n} -> ${path.relative(ROOT, tgt)} (${((Date.now() - t0) / 1000).toFixed(1)}s cumulative)`);
            }
            busy = false;
            return send(200, { ok: 1, secs: +((Date.now() - t0) / 1000).toFixed(1), shots: out });
          } catch (e) { busy = false; return send(500, { err: String(e && e.message || e) }); }
        });
        await new Promise(r => server.listen(OPT.serve, '127.0.0.1', r));
        say(`SERVING on http://127.0.0.1:${OPT.serve}  (/ping /shot?views=..&out=.. /quit)`);
        await new Promise(() => {});    /* forever; /quit exits the process */
      }

      for (let i = 0; i < todo.length; i++) {
        const s = todo[i];
        /* Stop BEFORE starting a shot we cannot finish, so the budget is spent
           on whole PNGs and never on a half-written one.

           Estimate from the LAST shot, not the first.  The first grab of a page
           load also pays for SwiftShader JIT-compiling the scene's shaders --
           measured 12 s for the first shot and ~2-3 s for every one after it --
           so budgeting the whole sheet at the first shot's price stops the run
           about six shots too early. */
        const est = tookFirst || 12;
        if (i > 0 && left() < est * 1.1 + 1.5) {
          stopped = `budget: ${todo.length - i} shot(s) left, ~${est.toFixed(1)}s each`;
          break;
        }
        const t = Date.now();

        /* THE FREE CAMERA. nz-shots.js:911 calls applyPose() every frame, so
           the pose is live on the very next frame the loop runs.

           The frame budget is handed to the page, not policed from here: a JS
           frame is ~20 ms and a Node poll round-trip is ~40 ms, so polling
           overshoots by two or three frames -- which, at ~1 s of queued GPU
           work per frame, is two or three seconds thrown away per shot.  The
           hook parks the loop on the exact frame instead.

           The first shot runs one extra frame so nz-shots' warm(1)+settle(1)
           has gone by and setPlaying(false) has frozen the sim. */
        const need = i === 0 ? Math.max(HOLD_FRAMES, 3) : HOLD_FRAMES;
        const moved = await page.evaluate((p, n) => {
          const P = NZ.shots.pose;
          P.x = p.x; P.y = p.y; P.z = p.z;
          P.yaw = p.yaw; P.pitch = p.pitch; P.roll = 0; P.fov = p.fov;
          window.__lvlRun(n);
          return window.__lvlFrames;
        }, s, need);
        const tPose = Date.now();

        let held = 0;
        /* On Windows Chrome + SwiftShader the first presented frame can take
           longer than the normal 8 s hold cap while shaders compile.  Never
           capture the still-uninitialised (black) FBO: allow a bounded grace
           period until at least one frame has actually completed. */
        const hardHoldMs = Math.max(HOLD_MS, 45000);
        while ((Date.now() - tPose < HOLD_MS || held < 1) &&
               Date.now() - tPose < hardHoldMs && left() > 3) {
          const st = await page.evaluate(() => [window.__lvlFrames, window.__lvlPaused])
            .catch(() => [1e9, true]);
          held = st[0] - moved;
          if (st[1]) break;             /* parked itself on frame n */
          await new Promise(r => setTimeout(r, 40));
        }
        await page.evaluate(() => { if (window.__lvlPause) window.__lvlPause(); }).catch(() => {});
        const tHeld = Date.now();

        /* FBO readback, not the compositor -- see the capture target above. */
        const target = outPathFor(s);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let buf = null;
        if (useFBO) {
          const durl = await page.evaluate(() => window.__lvlGrab()).catch(e => 'ERR ' + e.message);
          if (typeof durl === 'string' && durl.startsWith('data:image/png'))
            buf = Buffer.from(durl.split(',')[1], 'base64');
          else say('FBO grab failed (' + String(durl).slice(0, 100) + ')');
        }
        if (!buf && page.isClosed && !page.isClosed() && browser.connected !== false) {
          /* last resort: the compositor.  ~25 s, so only when there is room. */
          if (left() > 26) {
            say('falling back to page.screenshot() -- slow (~25s)');
            await page.evaluate(() => { if (window.__lvlResume) window.__lvlResume(); }).catch(() => {});
            buf = await page.screenshot({ type: 'png' }).catch(() => null);
          } else say('no budget left for the page.screenshot() fallback');
        }
        if (!buf) { stopped = `grab failed on ${s.name}`; break; }
        fs.writeFileSync(target, buf);
        written.push(target);
        /* the cheapest shot so far is the honest marginal price: the first one
           still carries whatever shaders the drain did not reach */
        const cost = (Date.now() - t) / 1000;
        tookFirst = tookFirst ? Math.min(tookFirst, cost) : cost;
        say(`ok  ${path.relative(ROOT, target)}  ${(buf.length / 1024).toFixed(0)}kB  ` +
            `at ${[s.x, s.y, s.z].join(',')} yaw ${s.yawDeg.toFixed(1)} (${compassOf(s.yawDeg)}) ` +
            `pitch ${s.pitchDeg.toFixed(1)} fov ${s.fov}  ` +
            `(+${((Date.now() - t) / 1000).toFixed(1)}s = hold ${held}f/${((tHeld - tPose) / 1000).toFixed(1)}s ` +
            `+ grab ${((Date.now() - tHeld) / 1000).toFixed(1)}s)`);
      }
    }

    /* -------------------------------------------------------- diagnosis -- */
    /* Always cheap-check the modules; --diag adds the expensive detail.  A
       failing module has to be visible in the SAME call as the picture it
       ruined, or somebody spends an hour blaming the lighting. */
    /* renderer.info is reset by three.js at the start of every renderer.render()
       call, so reading it cold reports the LAST pass -- for nz-render that is a
       one-quad present, i.e. "1 draw call, 2 triangles", which is a lie anybody
       checking the street's <= 40 draw-call budget would act on.  Turn autoReset
       off, zero it, render exactly one more frame, and the totals are the real
       per-frame cost of every pass added up.  Costs one frame, so --diag only. */
    if (OPT.diag && !stopped) {
      const t = Date.now();
      await page.evaluate(() => {
        const I = NZ.ctx.renderer.info;
        I.autoReset = false; I.reset();
        window.__lvlRun(1);
      }).catch(() => {});
      const tw = Date.now();
      while (Date.now() - tw < 9000 && left() > 2) {
        if (await page.evaluate(() => window.__lvlPaused).catch(() => true)) break;
        await new Promise(r => setTimeout(r, 40));
      }
      await page.evaluate(() => window.__lvlWarm && window.__lvlWarm()).catch(() => {});
      say(`diag frame ${((Date.now() - t) / 1000).toFixed(1)}s (renderer.info measured over one whole frame)`);
    }

    const probe = await page.evaluate(() => {
      const safe = (v, d) => {
        if (v == null || d > 3) return null;
        const t = typeof v;
        if (t === 'number' || t === 'string' || t === 'boolean') return v;
        if (t === 'function') return '[fn]';
        if (Array.isArray(v)) return v.length > 12 ? '[' + v.length + ']' : v.map(x => safe(x, d + 1));
        if (v.isTexture) return '[Texture ' + (v.image ? (v.image.width + 'x' + v.image.height) : '?') + ']';
        if (v.isMaterial || v.isObject3D || v.isVector3) return '[' + v.type + ']';
        const o = {};
        for (const k of Object.keys(v).slice(0, 24)) { try { o[k] = safe(v[k], d + 1); } catch (e) { } }
        return o;
      };
      const out = {
        flags: {}, street: null, streetGround: null, streetEntrance: null,
        streetPark: null, render: null, info: null, cam: null
      };
      try { out.flags = Object.assign({}, NZ.flags); } catch (e) { }
      try {
        const c = NZ.ctx.camera;
        out.cam = { pos: [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)],
                    yaw: +(c.rotation.y * 180 / Math.PI).toFixed(1), pitch: +(c.rotation.x * 180 / Math.PI).toFixed(1), fov: c.fov };
      } catch (e) { }
      try {
        const r = NZ.ctx.renderer.info;
        out.info = { calls: r.render.calls, tris: r.render.triangles, lines: r.render.lines,
                     textures: r.memory.textures, geometries: r.memory.geometries,
                     programs: r.programs ? r.programs.length : null };
      } catch (e) { }
      try {
        out.render = { tier: NZ.render.quality, exposure: NZ.render.params.exposure,
                       rig: safe(NZ.render.lightRig, 2), self: safe(NZ.render.selfCheck(), 1) };
      } catch (e) { }
      try {
        if (NZ.street) {
          out.street = { ok: NZ.street.ok, tier: NZ.street.tier,
                         facades: NZ.street.facades ? NZ.street.facades.length : 0,
                         stats: safe(NZ.street.stats, 0), SKY: safe(NZ.street.SKY, 0),
                         keys: Object.keys(NZ.street).join(' ') };
        }
      } catch (e) { }
      try {
        if (NZ.streetGround) {
          out.streetGround = {
            ok: NZ.streetGround.ok, tier: NZ.streetGround.tier,
            BOX: safe(NZ.streetGround.BOX, 0), ROAD: safe(NZ.streetGround.ROAD, 0),
            island: safe(NZ.streetGround.ISLAND, 0),
            bays: NZ.streetGround.bays ? NZ.streetGround.bays.length : 0,
            pits: NZ.streetGround.pits ? NZ.streetGround.pits.length : 0,
            stats: safe(NZ.streetGround.stats, 0)
          };
        }
      } catch (e) { }
      try {
        if (NZ.streetEntrance) {
          out.streetEntrance = {
            ok: NZ.streetEntrance.ok, tier: NZ.streetEntrance.tier,
            gate: safe(NZ.streetEntrance.gate, 0),
            recess: safe(NZ.streetEntrance.recess, 0),
            doorCell: safe(NZ.streetEntrance.doorCell, 0),
            stats: safe(NZ.streetEntrance.stats, 0)
          };
        }
      } catch (e) { }
      try {
        if (NZ.streetPark) {
          out.streetPark = {
            ok: NZ.streetPark.ok,
            route: safe(NZ.streetPark.route, 0),
            arena: safe(NZ.streetPark.arena, 0),
            closure: safe(NZ.streetPark.closure, 0),
            stats: safe(NZ.streetPark.stats, 0),
            keys: Object.keys(NZ.streetPark).join(' ')
          };
        }
      } catch (e) { }
      /* nz-env's diag carries a per-surface array that is pages long and is not
         what anyone is asking this harness -- keep the scalars only */
      try {
        if (NZ.env && NZ.env.diag) {
          out.env = {};
          for (const [k, v] of Object.entries(NZ.env.diag)) {
            if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) out.env[k] = v;
            else if (Array.isArray(v)) out.env[k] = '[' + v.length + ']';
          }
        }
      } catch (e) { }
      try { const f = NZ.ctx.scene.fog; if (f) out.fog = [f.color.getHexString(), f.near, f.far]; } catch (e) { }
      return out;
    }).catch(e => ({ evalFailed: String(e.message) }));

    /* Which modules are supposed to exist?  A file on disk whose flag is not
       true is a panic; a file that is not there yet is just not written yet. */
    const MODULES = [
      ['render', 'nz-render.js'], ['enemies', 'nz-enemies.js'], ['weapons', 'nz-weapons.js'],
      ['audio', 'nz-audio.js'], ['env', 'nz-env.js'],
      ['streetSky', 'nz-street-sky.js'], ['street', 'nz-street.js'],
      ['streetGround', 'nz-street-ground.js'], ['streetEntrance', 'nz-street-entrance.js'],
      ['streetProps', 'nz-street-props.js'], ['streetPark', 'nz-street-park.js'],
    ];
    const leanOut = (!OPT.nostage && !OPT.full) ? LEAN_OUT : [];
    const panicked = [];
    const modline = MODULES.map(([k, f]) => {
      const onDisk = fs.existsSync(path.join(ROOT, f));
      const v = probe.flags ? probe.flags[k] : undefined;
      if (leanOut.includes(f)) return k + '=lean';  /* we dropped it on purpose */
      if (!onDisk) return k + '=-';                 /* not written yet */
      if (v === true) return k + '=ok';
      panicked.push([k, f]);
      return k + '=' + (v === undefined ? 'ABSENT' : 'FAILED');
    }).join(' ');
    say('modules: ' + modline + '   (- = file not written yet, lean = staged out, --full to include)');
    if (probe.cam) say(`camera:  ${probe.cam.pos.join(',')} yaw ${probe.cam.yaw} pitch ${probe.cam.pitch} fov ${probe.cam.fov}`);

    for (const [k, f] of panicked) {
      console.error(`[${el()}] MODULE FAILED: ${f} loaded but NZ.flags.${k} is not true`);
      const tag = '[' + f.replace(/\.js$/, '') + ']';
      const lines = modLog.concat(issues).filter(l => l.includes(tag) || l.toLowerCase().includes(f.toLowerCase()));
      for (const l of lines.slice(0, 6)) console.error('    ' + l);
      if (!lines.length) console.error('    (no log line -- run with --diag, which sets ?nzdebug=1)');
    }

    if (OPT.diag) {
      say('--- diag ---------------------------------------------------------');
      if (probe.render) say('render:  ' + JSON.stringify(probe.render));
      if (probe.info) say('info:    ' + JSON.stringify(probe.info) + '   <- draw calls / triangles / textures / programs');
      if (probe.fog) say('fog:     #' + probe.fog[0] + ' near ' + probe.fog[1] + ' far ' + probe.fog[2]);
      say('flags:   ' + JSON.stringify(probe.flags));
      say('street:  ' + (probe.street ? JSON.stringify(probe.street) : 'NZ.street does not exist'));
      say('ground:  ' + (probe.streetGround ? JSON.stringify(probe.streetGround) : 'NZ.streetGround does not exist'));
      say('entrance:' + (probe.streetEntrance ? ' ' + JSON.stringify(probe.streetEntrance) : ' NZ.streetEntrance does not exist'));
      say('park:    ' + (probe.streetPark ? JSON.stringify(probe.streetPark) : 'NZ.streetPark does not exist'));
      if (probe.env) say('env:     ' + JSON.stringify(probe.env).slice(0, 600));
    }
    if (issues.length) {
      say(`console: ${issues.length} error/warning line(s)` + (OPT.diag ? '' : ' -- --diag prints them all'));
      for (const l of issues.slice(0, OPT.diag ? 40 : 6)) console.error('    ' + l);
    }
  } finally {
    if (!OPT.keep) await browser.close().catch(() => {});
  }

  /* ------------------------------------------------------------- wrap --- */
  if (isSheet) {
    const missing = all.filter(s => !fs.existsSync(outPathFor(s)));
    if (missing.length) {
      say(`${stopped || 'incomplete'} -- ${missing.length} left: ${missing.map(s => s.name).join(' ')}`);
      say('re-run the same command; finished shots are skipped.');
    } else say(`sheet complete: ${all.length} shot(s) in ${path.relative(ROOT, outDir)}`);
  }
  say(`done in ${el()}, wrote ${written.length} file(s)`);
  if (!written.length) process.exit(1);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
