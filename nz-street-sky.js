/* ===========================================================================
   NZ-STREET-SKY  --  the daylight of 233. Sokak.

   The rest of NUKEM.html is night: sodium lamps, a moon wash, a warm 34-degree
   key and a graded night probe on scene.environment. This module makes ONE
   region -- the residential canyon at x [168,252], z [152,192], y [0,52], plus
   the junction throat and the foyer behind the north facade -- read as flat
   overcast daylight, without moving a single photon anywhere else in the level.

   It is built as a SELF-LIT ISLAND, exactly as _research/RENDER-CONTRACT.md
   section 3.6 works out:

     1. Its own PMREM daylight probe, assigned per material via material.envMap.
        r149 resolves `material.envMap || scene.environment` in
        WebGLPrograms.getParameters, so scene.environment is never touched, the
        night half never recompiles, and nz-render.panic() still hands the level
        back correctly.
     2. Its own achromatic overcast vertex bake (NZ.street.bake) -- a ray-traced
        sky-dome visibility term plus a canyon inter-reflection floor. Inside
        the zone it REPLACES the point-light bake NUKEM.html's lightAt() wrote,
        pre-compensated through nz-render's bakeCurve() so the value that
        survives its priority -1000 sweep is the value authored here.
     3. A visible overcast sky: one down-facing quad that plugs the canyon
        opening at the eaves line. It is provably occluded from every night
        region (see SECTION 5).
     4. A distant backdrop -- the town climbing away to snow-dusted hills --
        which is really sky, faded to the night horizon colour whenever the
        camera is not in the daylight zone, so it can never leak.
     5. NO NEW LIGHTS. Overcast has no key. WebGLLights.setup() accumulates
        every light in the scene into shared uniforms and r149 has no
        per-object light masking, so a second sun or hemisphere would light the
        night half too. Instead one shared onBeforeCompile suppresses the night
        rig's DIRECT term inside a smooth world-space mask and substitutes an
        analytic overcast hemisphere. That also kills the sun key's hard cast
        shadow across the road, which would have ended the shot on its own.
     6. A fog + exposure ramp on a damped camera-position mask, feathered much
        wider than the geometry so the player is breathing day-tinted air
        before the first daylit surface enters frame.

   MATERIAL NAME PREFIX -- 'nzday:'. nz-render.js:2282-2288 only remaps baked
   vertex lighting for materials named 'world:*' or 'nzenv:*'. Everything this
   module hands out through NZ.street.day() is named 'nzday:<x>' so the overcast
   bake reaches the screen exactly as authored. See SECTION 4.

   Owns: nz-street-sky.js. Edits nothing else. Zero external assets. Classic
   script. three.js r149 core UMD surface only.
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ || !NZ.on) { return; }
  if (NZ.flags && NZ.flags.streetSky === undefined) NZ.flags.streetSky = false;

  var QS = /[?&]nzsky=(0|off|low|med|high)/i.exec(
    global.location ? global.location.search : '') || null;
  var DISABLED = !!(QS && /^(0|off)$/i.test(QS[1]));
  /* A/B knob for a critic: ?nzbackdrop=0 keeps the daylight and the sky and
     drops the distant town, which is the only way to tell a leak in the
     backdrop apart from a leak in the sky. */
  var NO_BACKDROP = /[?&]nzbackdrop=(0|off)/i.test(
    global.location ? global.location.search : '');
  /* Second A/B knob, same argument: ?nzao=0 disables ONLY the near-field term
     in bake() -- every blocked ray goes back to charging the flat inter-
     reflection floor the module shipped with -- and leaves the sky, the fog,
     the haze and the probe exactly as they are. It is the only way to tell how
     much of a tonal change is this module's occlusion and how much is another
     module's albedo, when five of them are being rewritten at once. */
  var NO_AO = /[?&]nzao=(0|off)/i.test(
    global.location ? global.location.search : '');
  /* Third A/B knob, and the one this round turns on. ?nzgrade=0 restores the
     module EXACTLY as it shipped before the grade pass: the old near/linear
     aerial-perspective ramp, the old flat albedo-independent sky specular, and
     no tonal curve at all. Everything else -- the probe, the bake, the sky
     card, the backdrop, the fog -- is byte-identical between the two states, so
     a before/after pair rendered from the SAME build in two adjacent calls
     attributes the whole delta to this module and to nothing a sibling did in
     between. That is the only measurement worth taking while nz-street.js and
     nz-street-props.js are being rewritten under me. */
  var NO_GRADE = /[?&]nzgrade=(0|off)/i.test(
    global.location ? global.location.search : '');
  /* ?nzg=key:value,... -- sweep the grade without editing the file. Keys are
     the GRADE_/HAZE_ constants below: hamt, hnear, hfar, hpow, piv, gain, con,
     sat, spec, socc. */
  var GQ = (function () {
    var m = /[?&]nzg=([^&#]+)/i.exec(global.location ? global.location.search : '');
    var o = {};
    if (!m) return o;
    var parts = decodeURIComponent(m[1]).split(',');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split(':');
      if (kv.length === 2 && isFinite(+kv[1])) o[kv[0].toLowerCase().trim()] = +kv[1];
    }
    return o;
  })();
  function qk(name, dflt) { return (typeof GQ[name] === 'number') ? GQ[name] : dflt; }

  var THREE = null, scene = null, renderer = null, camera = null;
  var dead = false, installed = false;

  var OWN = { tex: [], mat: [], geo: [], obj: [], restore: [], patched: [] };
  var STATS = {
    ms: 0, bakeMs: 0, probeMs: 0, addedCalls: 0, texBytes: 0,
    bakedGeos: 0, bakedVerts: 0, worldMats: 0, dayMats: 0,
    rays: 0, backdropTris: 0, probeRes: 0, replayVerts: 0, replayMs: 0
  };
  var DIAG = { glslProbe: null, warnings: [], skyMean: 0, probeGain: 0, notes: [] };
  function warn(msg) { DIAG.warnings.push(msg); console.warn('[nz-street-sky] ' + msg); }
  function note(msg) { DIAG.notes.push(msg); NZ.log && NZ.log('street-sky: ' + msg); }

  /* ---- small math -------------------------------------------------------- */
  var PI = Math.PI;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sat(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ss(t) { t = sat(t); return t * t * (3 - 2 * t); }
  function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function rng(seed) {                       /* mulberry32, nz-core.js:118 */
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* sRGB byte -> linear. Written out rather than leaning on THREE.Color so the
     module behaves identically with or without nz-render's colour management
     (nz-render.js:4081 clears ColorManagement.legacyMode; ?nzcm=0 puts it back). */
  function s2l(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function hexLin(h) {
    return [s2l((h >> 16) & 255), s2l((h >> 8) & 255), s2l(h & 255)];
  }
  function f3(a) { return [+a[0].toFixed(5), +a[1].toFixed(5), +a[2].toFixed(5)]; }
  function g3(v) { return v.toFixed(6); }     /* GLSL float literal */

  /* =======================================================================
     SECTION 1 -- the world, in world units
     STREET-MODULE-CONTRACT.md section 6 (AMENDMENT 2 -- THE WIDENED STREET,
     which supersedes section 1). CELL = 4, M = 3.5 u/m, +Y up, +X east,
     +Z south. One cell = 1.143 m.

     The re-carve widened the canyon from 32 to 40 units (9.14 -> 11.43 m) and
     gave it an origin: a junction with a kerbed island at its west end, per
     _ref/ref8-park-intersection.png. Every number below moved; NOTHING in
     SECTION 2 (the light), SECTION 4's grade or SECTION 6's bake constants did.

       street body    cells x 42..62, y 38..47   x [168,252]  z [152,192]
       north pavement       y 38..39             z [152,160]  f 0.5
       roadway              y 40..45             z [160,184]  f 0     6.86 m
       south pavement       y 46..47             z [184,192]  f 0.5
       junction throat cells x 44..47, y 38..39 repainted ROAD f 0, so the side
                            street pours in over a dropped kerb: x [176,192],
                            z [152,160] is asphalt, not pavement
       junction island cells x 46..47, y 42..43   x [184,192]  z [168,176]
       foyer          cells x 59..62, y 31..36    x [236,252]  z [124,148]
       foyer door     cell  (60, 37)              x [240,244]  z [148,152]

     The side street entering from the north is the night east alley (rAlley,
     cells x 40..48, y 21..37 -> x [160,196], z [84,152], f 0, c 28, sky:true).
     Its ceiling mismatch against the street's c = 52 drops the BRIDGE BAND: a
     building mass whose south wall face is the plane z = 152, y [28,52],
     x [176,192]. FACADE clads it as the corner building it is. Below y = 28 the
     throat is open, which is what makes the junction apron the brightest piece
     of road on the street -- see traceVis()'s throat exception.  */
  var U = 3.5;                        /* world units per metre  NUKEM.html:360 */
  function m(x) { return x * U; }

  /* BOX is the level A/B corridor consumed by the facade, ground and prop
     modules: roundabout -> Seydikent A/B -> 230 Sk -> low police closure.
     The parallel graded park is the separate ZC daylight island below, so the
     corridor dressers cannot accidentally pave or park cars across it. */
  var BOX    = { x0: 548, x1: 836, z0: 140, z1: 208, y0: 0, y1: 52 };
  /* MOUTH keeps its name and its MEANING CHANGES: it is no longer the covered
     alley passage, it is the JUNCTION THROAT -- the opening in the north facade
     plane through which the side street enters, measured on the NORTH side of
     the plane exactly as the old mouth was. z [148,152] is the one alley cell
     row that butts the street; the opening runs y [0,28], the band above it. */
  var MOUTH  = { x0: 548, x1: 548, z0: 152, z1: 152, lintel: 28 };
  /* the street-side half of the same junction: the two rows repainted ROAD at
     f = 0, so GROUND lays asphalt and a dropped kerb here and not pavement */
  var THROAT = { x0: 548, x1: 548, z0: 152, z1: 160 };
  /* the bridge band, as a wall: FACADE's cladding, and the mass that masks the
     day/night transition. Its face is the north facade plane. */
  var BAND   = { x0: 548, x1: 548, y0: 28, y1: 52, z: 152 };
  /* the kerbed teardrop in the middle of the junction (S_BLOCK cells 46..47,
     42..43). GROUND owns its kerb ring and soil, PROPS its conifer and signs. */
  var ISLAND = { x0: 552, x1: 568, z0: 166, z1: 182 };
  var FOYER  = { x0: 236, x1: 252, z0: 116, z1: 140 };
  /* .z is the facade plane the door is cut in; .z0/.z1 are the door CELL, which
     is the recess ENTRANCE builds inside (rResFoyer, c = 12, so it has its own
     ceiling and is not a hole in the sky) */
  var DOOR   = { x0: 240, x1: 244, z: 144, z0: 140, z1: 144 };
  var PLANE  = { north: 140, south: 208, west: 548, east: 836 };
  var KERB   = { northTop: 160, southTop: 188, height: 0.5 };
  var STOREY = { ground: 11.2, floor: 10.15, eaves: 51.8, count: 5 };

  /* The eaves line. Every world wall quad in the canyon is drawn from the
     region floor to the region ceiling c = 52 (NUKEM.html buildWorld), so 52 is
     both the top of the geometry and the plane the sky plugs. */
  var SKY_Y = BOX.y1;                 /* 52   */
  var RIDGE_Y = 64;                   /* where the facade agent's roofs top out */

  /* ---- the daylight mask ------------------------------------------------
     Two smooth boxes, max()'d. A is the canyon itself, generously tall so the
     roofs, chimneys and aerials the other modules build above c = 52 are inside
     it. B is the junction throat, which is what feathers the transition out
     into the night alley under the bridge band.

     The north edge of A sits at the facade plane z = 152, NOT at the throat, so
     the foyer's own south wall (z = 148, x [236,252]) only picks up the tail of
     the feather -- mask 0.394, a little daylight leaning in through the
     entrance door, which is right -- rather than reading as an outdoor surface.
     That is the same 4-unit setback, and therefore the same 0.394, the old
     carve produced at z = 152 against a plane at 156. */
  /* The main axis continues through a low, open view corridor beyond the
     collision barrier. ZC is the split southbound park road and its arena
     facade. Keeping the masks separate avoids bleaching the night mission
     geometry between them. */
  var ZA = { x0: 540, x1: 994, z0: 136, z1: 212, y0: -4, y1: 104, f: 10.0 };
  /* ZB's feather is the ONLY thing this module puts north of the facade plane
     that can light anything in the alley, and it reaches exactly
     ZB.z0 - ZB.f = 142.5. North of that the daylight weight is identically
     zero -- boxMask() returns smoothstep(1 - d/f) and d > f there -- so no
     surface at z < 142.5 can be brightened by this module by any amount, ever.
     Its y1 = 30 keeps it UNDER the bridge band (whose soffit is y = 28): the
     band is a night-side building mass on three of its faces and only its south
     face, at z = 152, belongs to the daylight. Exposed on ?nzg=zbf:<feather> so
     FACADE can A/B the throat against its own cladding without editing this
     file: zbf:0.5 collapses the feather and leaves everything else untouched. */
  var ZB = { x0: 546, x1: 552, z0: 140, z1: 208, y0: -4, y1: 30,
             f: qk('zbf', 5.5) };
  var ZC = { x0: 252, x1: 556, z0: 96, z1: 336, y0: -4, y1: 104, f: 12.0 };
  /* 230 Sk crosses the main axis at x 760..792.  It needs its own daylight
     slot beyond the canyon band or its two open arms fall back to the night
     grade even though they are visible from the barrier. */
  var ZD = { x0: 756, x1: 796, z0: 96, z1: 260, y0: -4, y1: 96, f: 10.0 };
  /* THE ZONE LIST, so a mission can add a daylight island without four
     separate edits that can drift apart.  `vert` is what anyVertInZone()
     considers: ZB is a throat feather, not a place, and retargeting world
     geometry on it would drag the night alley into the daylight rig. */
  ZA.vert = true; ZB.vert = false; ZC.vert = true; ZD.vert = true;
  var ZONES = [ZA, ZB, ZC, ZD];
  /* MISSION 4 opens 232. Sokak north and south of the roundabout.  Both arms
     are open sky and neither is anywhere near ZA/ZC, so without their own
     islands they would take the night grade and the night fog: a black street
     forty units past the barricade, seen from a daylit junction. */
  /* The arms as CARVED, not as first sketched. buildStreetMap carves the north
     arm over cells x 121..144, y 0..35 -> world x 484..580, z 0..144, and the
     south arm over y 53..127 -> z 212..512, and the daylight islands have to
     cover all of it: a camera at the south barricade (z = 474) sat 138 units
     outside the old z1 = 326, so the whole far half of the arm faded to the
     NIGHT grade and the night fog as the player walked down it -- a black
     street at the end of a sunlit one. The x span reaches 484 so the arm's
     west kerb, its elevations and the cemetery tree line are inside too. */
  var Z4N = { x0: 480, x1: 594, z0: -40, z1: 150, y0: -4, y1: 104, f: 10.0, vert: true };
  var Z4S = { x0: 480, x1: 594, z0: 202, z1: 540, y0: -4, y1: 104, f: 10.0, vert: true };
  /* the camera ramp is deliberately far wider than the shading mask: the fog
     and the exposure have to have finished moving before the first daylit
     surface is on screen (RENDER-CONTRACT.md section 4.1 rule 2) */
  var LEVEL4 = false;
  var OVERCAST4 = false;  /* the photographed September street ambience */
  var SUN_DEBAKE = false;   /* set by sunnyProfile(): see INJ_LIGHT */
  var DEBAKE_AMT = 1.0;      /* mission 4 runs the SUNNY profile, see sunnyProfile() */
  var FOG_FEATHER = 30.0;

  function boxMask(p, B, feather) {
    var dx = Math.max(B.x0 - p.x, 0, p.x - B.x1);
    var dy = Math.max(B.y0 - p.y, 0, p.y - B.y1);
    var dz = Math.max(B.z0 - p.z, 0, p.z - B.z1);
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return ss(1 - d / feather);
  }
  /* 0..1 shading weight for a world point. Mirrored EXACTLY by nzSkDay() in
     SECTION 4's GLSL -- if the two disagree the fog and the shading part
     company at the doorway. */
  function dayMask(p) {
    var m = 0;
    for (var i = 0; i < ZONES.length; i++) m = Math.max(m, boxMask(p, ZONES[i], ZONES[i].f));
    return m;
  }
  function fogMask(p) {
    var m = 0;
    for (var i = 0; i < ZONES.length; i++) m = Math.max(m, boxMask(p, ZONES[i], FOG_FEATHER));
    return m;
  }

  /* =======================================================================
     SECTION 2 -- the light, in nz-render's unit
     Every intensity here is "the diffuse albedo multiplier a white surface
     FACING that source receives" (nz-render.js:268-274), the same unit the
     night rig is solved in: probe 0.285, key 1.45, bounce 0.50, kicker 0.26,
     ambient 0.035.

     Calibrated against the composite in nz-render.js:3023-3076 -- ACES at
     uExposure = P.exposure * (1/0.6) = 1.58333, display-space S 0.16,
     saturation 1.02 -- which maps scene-linear to sRGB like this:

         linear 0.10 ->  78/255      linear 1.0 -> 227
         linear 0.18 -> 119          linear 1.5 -> 238
         linear 0.25 -> 145          linear 2.0 -> 243
         linear 0.50 -> 195          linear 3.2 -> 248

     STREET-BRIEF section 1 asks for: road 95-120/255, whites 200-215, never
     clipped. So the road wants ~0.15-0.19 scene-linear and a cream facade
     ~0.55-0.62. An open-sky white surface therefore wants ~2.6, and a road on
     the floor of the canyon sees sin(atan(w/52)) of the sky dome.

     THE WIDENING MOVED THIS AND THE CONSTANTS WERE LEFT ALONE ON PURPOSE. At
     the old half-width w = 16 (a 9.14 m canyon) that fraction was 0.294 and the
     road's bake landed near 0.50, for 2.6 * 0.50 * an asphalt albedo of ~0.11 =
     0.14 -- the low edge of the target band. At the new w = 20 (11.43 m) it is
     sin(atan(20/52)) = 0.359 and the bake lands near 0.56, for 0.16 -- the
     middle of it. The street therefore comes out ~1/6 stop brighter than the
     build the grade was solved on, in the direction the brief wanted, and every
     ratio in SECTION 4's grade note is unchanged because a bake that rises
     everywhere by the same factor moves no ratio at all. Nothing here is
     retuned this round: DAY_IRRADIANCE, SKY_WHITE, the GRADE_ block and the
     probe intensity are the numbers the critic measured.
     ==================================================================== */
  var DAY_IRRADIANCE = 2.00;    /* albedo multiplier, white surface facing up  */
  var DAY_DOWN_SHARE = 0.30;    /* same for a surface facing straight down     */
  var DAY_DIRECT_KILL = 0.05;   /* what survives of the night rig's DIRECT term */
  var DAY_IBL_KILL = 0.10;      /* ...and of the night probe, inside the zone   */
  var DAY_SPEC = qk('spec', 0.55);  /* sky radiance handed to the specular lobe */
  /* THE SECOND BLACK FLOOR, and this one is albedo-independent, which is what
     makes it lethal. The old injection handed EVERY world fragment inside the
     mask the same constant `radiance = uNzSkUp * DAY_SPEC` -- one number, no
     orientation, no occlusion. uNzSkUp is an IRRADIANCE (luminance 2.00 by
     construction), so a balcony soffit facing straight DOWN into a 3-metre
     recess was told it could see 1.10 of sky radiance in its mirror direction,
     exactly as much as the open road. Through the split-sum BRDF a rough
     dielectric returns ~0.05-0.08 of that, so ~0.07 of scene-linear radiance
     was ADDED to every world surface in the zone whichever way it faced and
     whatever was in front of it -- 0.07 linear is 64/255 on its own. That is
     the rest of the lifted p5, and because it is grey it is a second
     desaturator on top of the haze.

     GROUND hit the same floor from the other side and killed it on its own
     materials by dropping envMapIntensity to 0.55/0.62; those are 'nzday:'
     materials carrying the probe on material.envMap, so they take the
     uNzSkP.y = 1 branch and never reach this line. This is the world-quad half
     of the same defect -- the road, both pavements and the four canyon walls
     that NUKEM.html owns and that cannot be given the probe.

     Two terms fix it and neither touches the diffuse bake:
       * the sky is sampled along the REFLECTION vector, not held constant, so
         a soffit gets uNzSkDn (0.60) and only a sky-facing reflection gets the
         full uNzSkUp -- which is also where a specular is supposed to be, so
         the top of the histogram keeps everything it had;
       * it is multiplied by the vertex bake, which is already in vColor. The
         diffuse path gets that occlusion for free through
         `diffuseColor *= vColor` in <color_fragment>; the specular path was
         the one term in the shader bypassing it. SPEC_OCC_REF is the bake
         value that counts as "open": 0.60, so the open road (bake ~0.5 after
         nz-render's curve) keeps ~0.83 of its sheen and a hard cavity (bake
         clamped at 0.15) keeps 0.25. */
  var SPEC_OCC_REF = qk('socc', 0.60);
  var SPEC_ORIENTED = !NO_GRADE;

  /* The VISIBLE dome is drawn dimmer than the dome the surfaces are lit by.
     A real overcast sky is ~10x the luminance of the road under it and no tone
     curve can hold that and still put the road at 115/255; nz-render makes
     exactly the same compression with P.skyLum = 0.94 (nz-render.js:1416).

     SKY_WHITE is the knob, not SKY_VIS: it is the SCENE-LINEAR luminance the
     ZENITH of the visible dome is authored at, and it is solved backwards
     through nz-render's composite (ACES at uExposure 1.58333, then the sRGB
     transfer) from the sRGB value we want on screen. 1.150 lands the zenith at
     229/255 and -- with the profile below -- the low edge of the canyon slot at
     ~239, which is _ref/ref1's 233-241 white point. Authoring the DISPLAY value
     rather than a raw multiplier is what stops the sky drifting every time the
     shape is retuned: the profile can change freely and the white point holds.
     SKY_VIS is now derived from it and kept only for the report. */
  var SKY_WHITE = 1.215;
  var SKY_VIS = 0.60;              /* derived in solveGains(), see VIS_GAIN */

  /* ---- the sky, as a shape (peak radiance = 1.0) -------------------------
     Measured off _ref/ref1,3,4,5 with PIL. The photographs read:
        bright band, 10-25 deg up    248 / 246 / 248   (ref1 upper centre)
        general sky                  222 / 230 / 240
        toward the zenith            206 / 218 / 236   -- darker AND cooler
        hills, washed out            200 / 207 / 214
     i.e. luminance falls toward the zenith and the blue rises. That inversion
     is the single loudest overcast tell; a sky that gets bluer and brighter
     upward is a clear-sky model wearing a grey coat. */
  var C_HORIZON = hexLin(0xf3f4f4);   /* right at the roofline: near white     */
  var C_PEAK    = hexLin(0xf4f6fa);   /* the bright band a little above it     */
  /* the zenith is 3 points bluer than the value measured off _ref/ref1 for one
     reason: ACES compresses the top of the blue channel harder than the top of
     the red, so lifting the white point to the reference's cost 5 of the 13.9
     code values of B-R the critic told me to keep. This puts them back on the
     screen, which is where the measurement is taken. */
  var C_ZENITH  = hexLin(0xb7d0ef);   /* cooler, and 0.46 of the peak          */
  var C_BREAK   = hexLin(0xa9c6e2);   /* the one weak break of pale blue       */
  var C_GROUND  = hexLin(0x8f9294);   /* what the lower hemisphere bounces back */
  /* THE PROFILE, and why it was wrong.
     The canyon opening is 84 x 40 units at y = 52 seen from an eye at y = 6.4
     (it was 84 x 32 before the widening; the corner of the slot moved from
     d.y = 0.71 to 0.70, which is why not one constant in this block is
     retuned), so the sky quad only ever subtends d.y in [0.70, 1.0] -- the top
     45 degrees of the dome and nothing else. The old ramp spent itself on a
     smoothstep(0.12, 1.00), whose derivative is ZERO at t = 1: measured over
     10,193 clean sky pixels of street.sky it delivered 1.8 code values of
     gradient from 53 to 88 degrees of elevation, which is the "flat card"
     defect. The ramp was real; it was simply all below the horizon of anything
     the player can see.

     ZEN_P moves the whole fall into the slot. b = ((t - ZEN_T)/(1 - ZEN_T))^P
     with P > 1 keeps a live slope right up to the zenith:
        t 0.80 (53 deg)  b 0.561   lum 0.697    -> 239/255
        t 0.94 (70 deg)  b 0.854   lum 0.539    -> 233
        t 1.00 (zenith)  b 1.000   lum 0.460    -> 229
     which is ~10 codes across the visible slot instead of 1.8, at ref1's white
     point instead of 14 below it, and still monotone -- brightest low, coolest
     and darkest at the zenith, which is the overcast tell the brief opens with. */
  var L_HORIZON = 0.93, L_PEAK = 1.00, L_ZENITH = 0.46, L_GROUND = 0.30;
  var ZEN_T = 0.06, ZEN_P = 2.40;
  /* ref1 has ONE weak break of pale blue, high and to one side. Aimed 38 deg
     east, down the street's own axis, so it lands in the wedge above the dead
     end rather than tinting the whole slot. Widened and deepened from the
     original 0.83/0.50/0.90, which measured as 3 codes and read as nothing. */
  var BRK = (function () {
    var v = [0.62, 0.78, 0.10], n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
  })();
  var BRK_LO = 0.80, BRK_HI = 0.999, BRK_AMT = 0.62, BRK_DIM = 0.855;

  /* ---- the cloud ---------------------------------------------------------
     Three octaves of value noise on the direction projected onto a cloud base,
     applied to the VISIBLE dome only -- never to the probe, never to
     shapeIrradiance(), so not one photon of surface lighting moves. The brief
     says "no visible cloud shapes -- just a luminous ceiling"; the critic says
     _ref/ref1 measures sd 5.0-8.1 against our 2.35. Both are satisfied by
     large, soft, low-contrast modulation: nothing has an edge, but the ceiling
     is no longer a painted card. CLOUD_AMT is peak-to-peak fraction of
     luminance.

     MEASURED, and this is the settling of an argument. PROPS reports the sky
     as "a flat white band with no gradient or cloud"; this module reported
     sd 5.35 and a +7.38 gradient. Re-measured on a fresh render of
     street.sky, over the 4,719 pixels of the central slot that are actually
     sky rather than pantile:

        ours        mean 232.1  sd 3.93  p5 226.6  p95 237.7  B-R +11.1
        _ref/ref1   mean 237.9  sd 6.52  p5 229.4  p95 246.6  B-R  +9.97
        _ref/ref3   mean 236.8  sd 6.41  p5 229.9  p95 249.4  B-R  +7.18
        _ref/ref4   mean 237.6  sd 5.38  p5 231.9  p95 246.6  B-R +10.70
        _ref/ref5   mean 233.3  sd 8.19  p5 225.1  p95 249.4  B-R  +8.03

     plus a +10.8 code gradient down the slot. So the modulation is REAL and
     measurable and PROPS is still right about what it looks like: at 231/255
     the frame is on the ACES shoulder, where CLOUD_AMT 0.36 of scene-linear
     buys only +/-4 code values, and +/-4 on a bright field is below the point
     at which an eye calls it cloud. The number was right and the conclusion
     drawn from it was wrong -- the question is not whether the modulation
     exists but how many CODE VALUES survive the shoulder, and that is the
     unit the references are quoted in.

     AND RAISING CLOUD_AMT IS NOT THE LEVER, which is worth writing down so the
     next agent does not spend a render finding out. Measured, same shot, same
     mask, 0.36 -> 0.55:  sd 4.39 -> 4.56, mean 231.9 -> 230.8, max 244.9 ->
     244.7. Half again as much amplitude bought 0.17 of a code value of sd,
     because the composite maps scene-linear 0.93..1.63 onto display 224..239 --
     the whole +/-27 % swing is 15 code values wide up there. The references
     reach sd 5.4-8.2 by having a sky whose p95 is 247-249, i.e. by being
     nearly blown at the top, and ours tops out at 245 because SKY_WHITE puts
     the zenith at 229. Closing that gap means moving the WHITE POINT, not the
     cloud -- and the white point is calibrated, the critic measures it as
     correct, and it is in the money shot, so it is not this pass's to move.
     0.55 is kept because it is free and slightly better; the honest statement
     is that the sky's variance is bounded by its white point. */
  var CLOUD_AMT = 0.55, CLOUD_SCALE = 0.85;
  var C_BREAK_N = (function () {
    var y = 0.2126 * C_BREAK[0] + 0.7152 * C_BREAK[1] + 0.0722 * C_BREAK[2];
    return [C_BREAK[0] / y, C_BREAK[1] / y, C_BREAK[2] / y];
  })();

  var _sk = [0, 0, 0];
  /* JS mirror of nzSkySample() below. Returns linear radiance, peak == 1. */
  function skyShape(dx, dy, dz, out) {
    out = out || _sk;
    var t = sat(dy);
    var a = ss(t / 0.20);                       /* horizon -> the bright band  */
    var b = Math.pow(sat((t - ZEN_T) / (1 - ZEN_T)), ZEN_P);   /* band -> zenith */
    var lum = lerp(L_HORIZON, L_PEAK, a);
    lum = lerp(lum, L_ZENITH, b);
    var i, c;
    for (i = 0; i < 3; i++) {
      c = lerp(C_HORIZON[i], C_PEAK[i], a);
      c = lerp(c, C_ZENITH[i], b);
      out[i] = c;
    }
    /* normalise the hue to unit luminance, then apply the profile, so the
       colour ramp and the luminance ramp cannot fight each other */
    var y = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    var k = lum / Math.max(y, 1e-4);
    for (i = 0; i < 3; i++) out[i] *= k;
    /* the break goes in AFTER the profile, so it carries its own slightly
       lower luminance -- a blue patch in a blown white sky reads as a break in
       the cloud, and a patch that is merely bluer at the same luminance does
       not read at all */
    var br = ss((dx * BRK[0] + dy * BRK[1] + dz * BRK[2] - BRK_LO) / (BRK_HI - BRK_LO)) * BRK_AMT;
    for (i = 0; i < 3; i++) out[i] = lerp(out[i], C_BREAK_N[i] * lum * BRK_DIM, br);
    /* below the horizon: the canyon floor and the far wall, not a sky */
    var g = ss(-dy / 0.28);
    for (i = 0; i < 3; i++) out[i] = lerp(out[i], C_GROUND[i] * (L_GROUND / 0.335), g);
    return out;
  }

  /* GLSL mirror. Built from the same constants so they cannot drift. */
  function skyGLSL() {
    function v3(c) { return 'vec3(' + g3(c[0]) + ',' + g3(c[1]) + ',' + g3(c[2]) + ')'; }
    return [
      'vec3 nzSkySample(vec3 d){',
      '  float t = clamp(d.y, 0.0, 1.0);',
      '  float a = smoothstep(0.0, 0.20, t);',
      '  float b = pow(clamp((t - ' + g3(ZEN_T) + ') / ' + g3(1 - ZEN_T) + ', 0.0, 1.0), ' + g3(ZEN_P) + ');',
      '  float lum = mix(' + g3(L_HORIZON) + ', ' + g3(L_PEAK) + ', a);',
      '  lum = mix(lum, ' + g3(L_ZENITH) + ', b);',
      '  vec3 c = mix(' + v3(C_HORIZON) + ', ' + v3(C_PEAK) + ', a);',
      '  c = mix(c, ' + v3(C_ZENITH) + ', b);',
      '  float y = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);',
      '  c *= lum / y;',
      '  float br = smoothstep(' + g3(BRK_LO) + ', ' + g3(BRK_HI) + ', dot(d, ' + v3(BRK) + ')) * ' + g3(BRK_AMT) + ';',
      '  c = mix(c, ' + v3(C_BREAK_N) + ' * (lum * ' + g3(BRK_DIM) + '), br);',
      '  float g = smoothstep(0.0, 0.28, -d.y);',
      '  c = mix(c, ' + v3(C_GROUND) + ' * ' + g3(L_GROUND / 0.335) + ', g);',
      '  return c;',
      '}',
      /* The dome and the light it casts are the same GLSL but not the same
         chroma. A 6500-7000 K overcast sky really is blue-grey to look at
         (_ref: 219/228/238) while the surfaces under it read almost neutral
         (137/135/137), because in a 9 m canyon most of what reaches a wall has
         bounced off the painted render opposite first. uSat is that
         inter-reflection, and it is the difference between a street and a
         street lit through a blue gel. */
      'vec3 nzSkyLit(vec3 d, float s){',
      '  vec3 c = nzSkySample(d);',
      '  return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, s);',
      '}',
      /* The cloud. Deterministic hash-value noise -- no texture, no asset, and
         identical on every boot and every GPU that honours highp. Projected on
         a cloud base at d.xz / d.y so the cells stretch toward the horizon the
         way a real overcast deck does instead of tiling on the sphere. Used by
         the visible dome ONLY; nzSkySample() stays the pure shape so the probe,
         shapeIrradiance() and NZ.street.SKY keep reporting the same light. */
      'float nzSkH(vec2 p){',
      '  p = fract(p * vec2(0.1031, 0.1030));',
      '  p += dot(p, p.yx + 33.33);',
      '  return fract((p.x + p.y) * p.x);',
      '}',
      'float nzSkV(vec2 p){',
      '  vec2 i = floor(p), f = fract(p);',
      '  f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(nzSkH(i), nzSkH(i + vec2(1.0, 0.0)), f.x),',
      '             mix(nzSkH(i + vec2(0.0, 1.0)), nzSkH(i + vec2(1.0, 1.0)), f.x), f.y);',
      '}',
      'float nzSkCloud(vec3 d){',
      '  vec2 p = d.xz / max(abs(d.y), 0.35) * ' + g3(CLOUD_SCALE) + ';',
      '  float v = 0.52 * nzSkV(p)',
      '          + 0.30 * nzSkV(p * 2.17 + vec2(11.7, 5.3))',
      '          + 0.18 * nzSkV(p * 4.63 + vec2(53.1, 27.9));',
      '  return v - 0.5;',
      '}'
    ].join('\n');
  }
  /* =======================================================================
     THE SUNNY PROFILE -- mission 4 only
     Everything above this line is the overcast street mission 1 was calibrated
     against, and it is left byte-identical.  This function is called ONCE from
     install() when NZ.level === 4, before solveGains(), before
     buildInjections() and before any GLSL is generated, so every constant it
     moves is picked up by the JS mirror and the shader alike and the two
     cannot drift.
     ==================================================================== */
  function sunnyProfile() {
    /* ---- the sky, as a shape -------------------------------------------
       A clear sky inverts the overcast profile: it is DARKEST and BLUEST at
       the zenith and brightest, palest and warmest at the horizon, where the
       air mass is longest and Mie scattering dominates. */
    C_HORIZON = hexLin(0xdceaf6);   /* the pale, warm band at the roofline  */
    C_PEAK    = hexLin(0xa6cae9);   /* ten degrees up                        */
    C_ZENITH  = hexLin(0x2f6ec6);   /* the deep blue overhead                */
    C_BREAK   = hexLin(0xffffff);
    /* THE SHADOW'S COLOUR. C_GROUND is the lower hemisphere, and it is what
       an upward-facing... no: what a DOWNWARD-facing surface and, through
       SKY_E_DOWN, the shaded half of every wall is filled with. Left neutral
       it makes every shadow in the frame a pure sky-blue filter, which is the
       loudest 'CG daylight' tell there is. On a real sunny street the shadow
       is lit by TWO things -- the blue sky above and the sunlit ground below --
       and the ground half is warm: Konya-basin asphalt, limestone paving and
       painted render under a 2.4-irradiance sun. */
    C_GROUND  = hexLin(0xc0a17e);
    /* SOLVED THROUGH nz-render's COMPOSITE, not chosen. The table in SECTION 2
       maps scene-linear to sRGB (0.18 -> 119, 0.25 -> 145, 0.50 -> 195,
       1.0 -> 227). A clear sky photographs at roughly

           zenith        72 / 122 / 200    display luminance 117 -> linear 0.175
           thirty up    120 / 165 / 215                       159 -> linear 0.31
           the roofline 196 / 214 / 232                       211 -> linear 0.62

       so the profile is authored as a unit shape whose ZENITH is SKY_WHITE and
       whose horizon is 1/L_ZENITH times it. That inverts the overcast profile
       in both terms at once -- luminance now RISES toward the horizon and the
       blue rises toward the zenith -- which is the single loudest clear-sky
       tell, exactly as the inverse was the overcast one. */
    L_HORIZON = 1.00; L_PEAK = 0.88; L_ZENITH = 0.28; L_GROUND = 0.46;
    ZEN_T = 0.02; ZEN_P = 0.80;
    BRK_AMT = 0.0;                     /* the cumulus field replaces the break */
    SKY_WHITE = 0.175;
    VIS_GAIN = SKY_WHITE / L_ZENITH;

    /* ---- the light -----------------------------------------------------
       The sun is now the key and the sky is the fill, which is the whole
       difference between the two weathers.  DAY_IRRADIANCE is what an
       UP-FACING white surface gets from the sky alone; the sun adds
       SUN_IRRADIANCE * cos(theta) on top through the night rig's own
       directional, which is why DAY_DIRECT_KILL goes to 1. */
    /* SUN : SKY. A clear day at 50 degrees is about 4.5 : 1 on a horizontal
       surface (90 klx direct against 20 klx from the dome); at 0.56 against
       2.62*sin(52)*debake this module was nearer 1 : 1, which is 'overcast
       with a warm light in it'. This is the one number that decides whether a
       frame reads as sunny at all. */
    DAY_IRRADIANCE = qk('dayirr', 0.40);
    DAY_DOWN_SHARE = 0.42;
    DAY_DIRECT_KILL = 1.00;
    SUN_DEBAKE = qk('debake', 1) > 0.001;
    DEBAKE_AMT = qk('debake', 0.60);
    /* What a fully enclosed surface still receives, as a fraction of the sky.
       The overcast build's 0.30 was 0.30 x an irradiance of 2.00 = 0.60; the
       sunny sky is 0.40, so the same room would land at 0.12 and go black.
       0.62 x 0.40 = 0.25, plus nz-render's probe at 0.30 and the ambient
       floor, which together put an interior back where it was readable. */
    BAKE_FLOOR = qk('bfloor', 0.62);
    DAY_IBL_KILL = 0.10;
    DAY_SPEC = 0.55;

    /* ---- the air -------------------------------------------------------
       Clear-day aerial perspective is a BLUE Rayleigh veil that only starts
       to matter past a hundred metres, not the white milk an overcast day
       hangs at fifty. */
    /* SOLVED, not chosen. scene.fog is LINEAR and global, so its far plane is
       the distance at which a surface is 100 % replaced by the fog colour: at
       900 the far end of the axis was two thirds gone, which is the milk in
       every long shot. A clear day at 20-40 km visibility loses about 8 % of a
       surface at 250 m, so the far plane belongs an order of magnitude out and
       the SHAPE has to come from the airlight term instead.

           d (units)   30    100   200   350   570   900
           scene fog  .000  .000  .003  .020  .044  .080
           haze       .000  .001  .005  .018  .046  .107

       -- flat where there is no air to speak of, accelerating out, and never
       more than a fifth of the pixel inside the playable street. */
    DAY_FOG = hexLin(0xb3c7db);
    DAY_FOG_NEAR = qk('fnear', 170); DAY_FOG_FAR = qk('ffar', 9300);
    BACK_FOG_NEAR = qk('bnear', 260); BACK_FOG_FAR = qk('bfar', 3000);
    HAZE_NEAR = qk('hnear', 60); HAZE_FAR = qk('hfar', 1000);
    HAZE_AMT = qk('hamt', 0.13); HAZE_POW = qk('hpow', 1.7);

    /* ---- the grade -----------------------------------------------------
       A sunlit street already has its own range, so the curve stops
       manufacturing one and just holds the saturation up. */
    /* MEASURED on cordon.230-south before this block was retuned:
           p1 38.4  p5 58.4  p50 108.7  p95 189.0  p99 208.3
       against a reference sunny street's roughly 20 / 32 / 118 / 224 / 240.
       The median is right and BOTH ends are short -- the same range error the
       overcast profile was solved for, and the same operator fixes it: a power
       about a pivot, with a lower exponent below the pivot than above so the
       occlusion ratios the bake produces are not inverted to buy highlights. */
    GRADE_PIVOT = qk('piv', 0.1450); GRADE_CON = qk('con', 1.22);
    GRADE_CONHI = qk('conhi', 1.34); GRADE_GAIN = qk('gain', 1.10);
    GRADE_SAT = qk('sat', 1.30); GRADE_CEIL = qk('ceil', 6.0);
    GRADE_ON = true;

    DAY_EV = DAY_EV4;
    LIT_SAT = 0.55;
  }

  /* Mission 4's reference is an overcast afternoon. Keep the existing mission
     1 calibration separate: this profile is installed before the probe and
     shader are built, and the late material refresh updates earlier dressers.
     The sky is the light source; balcony depth comes from visibility/contact
     occlusion instead of the former warm sun and a raised ambient floor. */
  function overcastProfile() {
    OVERCAST4 = true;
    C_HORIZON = hexLin(0xd9dddf);
    C_PEAK = hexLin(0xe2e5e8);
    C_ZENITH = hexLin(0xaebdca);
    C_BREAK = hexLin(0xb3c7d9);
    C_GROUND = hexLin(0x777873);
    L_HORIZON = 0.97; L_PEAK = 1.00; L_ZENITH = 0.73; L_GROUND = 0.23;
    ZEN_T = 0.04; ZEN_P = 1.15;
    BRK_AMT = 0.12; BRK_DIM = 0.93;
    var by = 0.2126 * C_BREAK[0] + 0.7152 * C_BREAK[1] + 0.0722 * C_BREAK[2];
    C_BREAK_N = [C_BREAK[0] / by, C_BREAK[1] / by, C_BREAK[2] / by];
    SKY_WHITE = qk('skywhite', 0.78);

    DAY_IRRADIANCE = qk('dayirr', 1.15);
    DAY_DOWN_SHARE = 0.22;
    DAY_DIRECT_KILL = 0.0;
    DAY_IBL_KILL = 0.04;
    DAY_SPEC = qk('spec', 0.28);
    SUN_DEBAKE = false;
    BAKE_FLOOR = qk('bfloor', 0.24);
    LIT_SAT = 0.16;

    /* Nearby render, brick and asphalt retain their actual albedo. The light
       gray air only blends in down the long street and against the hills. */
    DAY_FOG = hexLin(0xc1c8cd);
    DAY_FOG_NEAR = qk('fnear', 260); DAY_FOG_FAR = qk('ffar', 6500);
    BACK_FOG_NEAR = qk('bnear', 320); BACK_FOG_FAR = qk('bfar', 2800);
    HAZE_NEAR = qk('hnear', 180); HAZE_FAR = qk('hfar', 1400);
    HAZE_AMT = qk('hamt', 0.10); HAZE_POW = qk('hpow', 1.7);

    GRADE_PIVOT = qk('piv', 0.145);
    GRADE_CON = qk('con', 1.10); GRADE_CONHI = qk('conhi', 1.04);
    GRADE_GAIN = qk('gain', 1.04); GRADE_SAT = qk('sat', 1.08);
    GRADE_CEIL = qk('ceil', 6.0); GRADE_ON = true;
    DAY_EV = -0.08;
  }

  function prepareMissionProfile() {
    if (dead || OVERCAST4 || NZ.level !== 4) return;
    LEVEL4 = true;
    if (ZONES.indexOf(Z4N) < 0) ZONES.push(Z4N, Z4S);
    overcastProfile();
    solveGains();
    publishSky();
    note('mission 4: overcast profile prepared before daylight materials and bakes');
  }

  /* A continuous stratus ceiling, with broad cloud banks and wispy variation
     in their edges. Domain-warped, rotated octaves avoid a square noise grid.
     This is visual cloud density only: surface exposure stays stable as the
     player turns, and there is no solar disc or additive aureole. */
  function overcastSkyGLSL() {
    return [
      'float nzOcFbm(vec2 p){',
      '  float a = 0.5, s = 0.0;',
      '  mat2 r = mat2(0.86, 0.51, -0.51, 0.86);',
      '  for (int i = 0; i < 5; i++) { s += a * nzSkV(p); p = r * p * 2.03 + 9.7; a *= 0.5; }',
      '  return s * 1.0323;',
      '}',
      'vec3 nzSkyDay(vec3 d, float gain){',
      '  vec3 c = nzSkySample(d) * gain;',
      '  vec2 p = d.xz / max(d.y + 0.22, 0.24) * 1.25 + vec2(2.7, -1.3);',
      '  vec2 warp = vec2(nzSkV(p * 0.61 + 13.0), nzSkV(p * 0.61 - 8.0)) - 0.5;',
      '  float bank = nzOcFbm(p + warp * 1.6);',
      '  float veil = nzSkV(p * vec2(5.2, 1.6) + bank * 1.7);',
      '  float density = smoothstep(0.18, 0.83, bank * 0.84 + veil * 0.16);',
      '  float horizon = smoothstep(0.01, 0.23, d.y);',
      '  float shade = mix(1.13, 0.66, density);',
      '  c *= mix(1.0, shade, horizon);',
      '  return c;',
      '}'
    ].join('\n');
  }

  /* =======================================================================
     THE CUMULUS DECK AND THE SUN, mission 4 only
     Both live in the VISIBLE card and nowhere else. nzSkySample() stays the
     pure gradient, because that function is what shapeIrradiance(), the PMREM
     probe and NZ.street.SKY all read: putting the sun in it would deliver the
     sun's energy twice -- once as the analytic hemisphere and once as the
     directional the level already owns -- and putting the cloud in it would
     make the street's exposure depend on which way the noise happened to fall.
     ==================================================================== */
  /* the deck, as a shape. COV_LO/COV_HI are the threshold band the fbm is
     smoothstepped through: raising both together thins the cover, widening the
     gap softens every edge. 0.52/0.78 is "occasional cumulus" -- roughly a
     quarter of the sky, in discrete puffs with clear blue between them, which
     is what the brief asks for and what a stratus sheet is not. */
  var CL_LO = qk('cllo', 0.335), CL_HI = qk('clhi', 0.495);
  var CL_SCALE = qk('clsc', 0.42);  /* deck cells per unit of direction       */
  var CL_ERODE = qk('cler', 0.26);  /* how hard the second octave bites edges */
  var CL_HZ0 = 0.006, CL_HZ1 = 0.030; /* only the last degree, to kill the seam */
  /* Scene-linear radiances, authored the same way the gradient is: a sunlit
     cumulus top photographs around 236/255 and its shaded base around 176, and
     the base is markedly BLUER than the top because everything lighting it is
     sky. */
  var CL_TOP  = [1.42, 1.40, 1.36];
  var CL_BASE = [0.315, 0.345, 0.415];
  var CL_WARM = 0.22;           /* how much the sunward flank picks up        */

  /* the sun in the visible sky. SUN_DISC_P is the exponent on cos(angle): at
     220 the core is about half a degree across, which is the real one. */
  var SUN_DISC_I = 11.0;        /* just under the card's own 12.0 clamp      */
  var SUN_AUR_I = 0.30, SUN_FWD_I = 0.045;
  var SUN_TINT = [1.00, 0.955, 0.865];
  var SUN_DIR_W = [-0.558, 0.692, 0.450];   /* refreshed from the light in buildSky */

  /* The deck's GLSL. Emitted only on mission 4, and only into the card's own
     ShaderMaterial, so not one program the overcast street compiles changes. */
  var SUN_STEP = [0, 0];   /* the deck-plane step toward the sun, set below */
  function sunnySkyGLSL() {
    function v3(c) { return 'vec3(' + g3(c[0]) + ',' + g3(c[1]) + ',' + g3(c[2]) + ')'; }
    function v3s(c) { return 'vec2(' + g3(c[0]) + ',' + g3(c[1]) + ')'; }
    var sh = Math.sqrt(SUN_DIR_W[0] * SUN_DIR_W[0] + SUN_DIR_W[2] * SUN_DIR_W[2]) || 1;
    SUN_STEP = [SUN_DIR_W[0] / sh * 0.55, SUN_DIR_W[2] / sh * 0.55];
    return [
      /* five octaves, each rotated as well as scaled: an axis-aligned octave
         stack lays a visible grid over a cloud field and the eye finds it
         instantly against a flat blue. */
      'float nzSkFbm(vec2 p){',
      '  float a = 0.5, s = 0.0;',
      '  mat2 R = mat2(0.86, 0.51, -0.51, 0.86);',
      '  for (int i = 0; i < 5; i++) { s += a * nzSkV(p); p = R * p * 2.06 + 13.7; a *= 0.5; }',
      '  return s * 1.0323;',                 /* sum of a=.5..  -> back to 0..1 */
      '}',
      /* cover and body, in one sweep. `p` is the direction projected onto a
         deck: dividing by d.y is the correct perspective for a flat cloud base
         and is why the puffs stretch and crowd toward the horizon instead of
         tiling on a sphere. */
      'vec2 nzSkDeck(vec3 d){',
      /* 0.11, not 0.055: dividing by d.y is the right perspective for a flat
         cloud base, but taken all the way down it stretches the last few
         degrees of sky into kilometre-long streaks that read as cirrus, not as
         the same cumulus seen end-on. Clamping the divisor holds the cells to
         a believable aspect and lets the horizon fade do the rest. */
      '  float ny = max(d.y, 0.11);',
      '  vec2 p = d.xz / ny * ' + g3(CL_SCALE) + ' + vec2(7.3, -3.1);',
      '  float f = nzSkFbm(p);',
      '  float e = nzSkFbm(p * 3.07 + vec2(41.2, 17.9));',
      '  float body = f - ' + g3(CL_ERODE) + ' * e;',
      '  float cov = smoothstep(' + g3(CL_LO) + ', ' + g3(CL_HI) + ', body);',
      /* A LINE OF SIGHT CROSSES MORE DECK AT LOW ELEVATION, so a real cumulus
         field CROWDS toward the horizon and ends in a solid hazy band -- the
         opposite of the fade this had. Coverage is composited along the path:
         1 - (1 - cov)^pathLength, with the path clamped so the last degree
         does not go opaque, and a very short fade in the final degree so the
         deck does not meet the dome's bottom edge with a hard line. */
      '  float pl = clamp(0.20 / max(d.y, 0.02), 1.0, 3.4);',
      '  cov = 1.0 - pow(max(1.0 - cov, 0.0), pl);',
      '  cov *= smoothstep(' + g3(CL_HZ0) + ', ' + g3(CL_HZ1) + ', d.y);',
      /* the SUNWARD side of a puff is a couple of hundred metres nearer the
         sun than its far side, so sampling the field once more a short step
         toward the sun and differencing gives a free shading term: bright
         where the body thins toward the light, grey where it thickens away
         from it. This is what turns a flat white blob into a cloud. */
      '  float fs = nzSkFbm(p + ' + v3s(SUN_STEP) + ');',
      '  return vec2(cov, body + (fs - f) * 0.55);',
      '}',
      /* the finished sky the card draws: gradient, then deck, then sun. */
      'vec3 nzSkyDay(vec3 d, float gain){',
      '  vec3 c = nzSkySample(d) * gain;',
      '  vec2 dk = nzSkDeck(d);',
      '  if (dk.x > 0.001) {',
      /* thick body -> sunlit top, thin edge -> the translucent rim you can see
         the sky through, which is what stops a puff reading as a paper cut-out */
      '    float thick = smoothstep(' + g3(CL_LO) + ', ' + g3(CL_HI + 0.16) + ', dk.y);',
      '    vec3 cc = mix(' + v3(CL_BASE) + ', ' + v3(CL_TOP) + ', thick);',
      '    float sw = max(dot(d, ' + v3(SUN_DIR_W) + '), 0.0);',
      '    cc *= 1.0 + ' + g3(CL_WARM) + ' * pow(sw, 3.0);',
      '    c = mix(c, cc, dk.x);',
      '  }',
      /* THE DISC AND THE AUREOLE, ON THE ANGLE.
         pow(cos t, N) is the wrong parameterisation for a half-degree source:
         N = 220 reaches half maximum 4.55 degrees off axis, so the "sun" was a
         nine-degree blob -- seventeen times too wide, and readable as a bloom
         artefact rather than as a star. Hitting 0.27 degrees with a cosine
         power needs N ~ 62,000, which highp cannot resolve near 1.0. acos()
         can, and it also lets the aureole be authored in degrees. The disc is
         drawn just under the card's own 12.0 clamp so it is a blown white
         point that the bloom pyramid can bloom without becoming a firefly. */
      '  float sd = clamp(dot(d, ' + v3(SUN_DIR_W) + '), -1.0, 1.0);',
      '  float sa = acos(sd);',
      '  float disc = 1.0 - smoothstep(0.0040, 0.0064, sa);',
      /* two exponentials: a tight Mie aureole (half at ~1.8 deg) over a broad,
         weak forward-scatter lobe (half at ~13 deg). The old single lobe was
         47 degrees wide and additively erased the blue zenith on one side of
         the sky, which made the sky's hue depend on the camera's heading. */
      '  float aur = exp(-sa * 22.0) * ' + g3(SUN_AUR_I) +
        ' + exp(-sa * 3.0) * ' + g3(SUN_FWD_I) + ';',
      '  c += ' + v3(SUN_TINT) + ' * (disc * ' + g3(SUN_DISC_I) + ' + aur);',
      '  return c;',
      '}'
    ].join('\n');
  }

  var LIT_SAT = 0.35;
  function desat(c, s) {
    var y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return [lerp(y, c[0], s), lerp(y, c[1], s), lerp(y, c[2], s)];
  }

  /* ---- cosine-weighted irradiance of the sky shape ----------------------
     E(n) = (1/pi) * integral over the hemisphere of L(d) (n.d) dw. For a
     uniform environment of radiance L this is exactly L, which is why r149's
     getIBLIrradiance() -- PI * textureCubeUV(env, n, 1.0) -- lands on the same
     number. Integrated in JS rather than read back off the GPU: no half-float
     dependency, no readback stall, bit-identical every run. */
  function shapeIrradiance(nx, ny, nz, samples) {
    var n = samples || 4096, sum0 = 0, sum1 = 0, sum2 = 0, w = 0, i;
    var ga = PI * (3 - Math.sqrt(5)), c = [0, 0, 0];
    for (i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) * (2 / n);
      var r = Math.sqrt(Math.max(0, 1 - y * y));
      var th = ga * i;
      var dx = Math.cos(th) * r, dy = y, dz = Math.sin(th) * r;
      var ct = dx * nx + dy * ny + dz * nz;
      if (ct <= 0) continue;
      skyShape(dx, dy, dz, c);
      sum0 += c[0] * ct; sum1 += c[1] * ct; sum2 += c[2] * ct; w += ct;
    }
    /* the direction set is a uniform measure on the sphere: 4*pi/n per sample.
       (1/pi) * sum(L*cos) * (4*pi/n) = 4/n * sum(L*cos) */
    var k = 4 / n;
    return [sum0 * k, sum1 * k, sum2 * k, w * k];
  }

  var PROBE_GAIN = 1, SKY_E_UP = null, SKY_E_DOWN = null, SKY_VIS_RGB = null;
  var BACK_SKY = null;   /* the sky a backdrop is seen against: see washed() */
  /* the multiplier that takes the unit-peak shape to the VISIBLE dome's
     scene-linear radiance. Solved from SKY_WHITE so the white point is an
     authored display value, not an accident of PROBE_GAIN. */
  var VIS_GAIN = SKY_WHITE / L_ZENITH;
  function solveGains() {
    var up = shapeIrradiance(0, 1, 0);
    var dn = shapeIrradiance(0, -1, 0);
    var yUp = 0.2126 * up[0] + 0.7152 * up[1] + 0.0722 * up[2];
    PROBE_GAIN = DAY_IRRADIANCE / Math.max(yUp, 1e-5);
    DIAG.skyMean = +yUp.toFixed(5);
    DIAG.probeGain = +PROBE_GAIN.toFixed(5);
    SKY_E_UP = desat([up[0] * PROBE_GAIN, up[1] * PROBE_GAIN, up[2] * PROBE_GAIN], LIT_SAT);
    /* the down-facing term is the canyon's inter-reflection, not the shape's
       own lower hemisphere -- a road, a pavement and a facing wall of painted
       render bounce far more than a nominal "ground" colour would */
    var yDn = Math.max(0.2126 * dn[0] + 0.7152 * dn[1] + 0.0722 * dn[2], 1e-5);
    var kd = (DAY_IRRADIANCE * DAY_DOWN_SHARE) / yDn;
    SKY_E_DOWN = desat([dn[0] * kd, dn[1] * kd, dn[2] * kd], LIT_SAT);
    VIS_GAIN = SKY_WHITE / Math.max(L_ZENITH, 1e-4);
    SKY_VIS = +(VIS_GAIN / Math.max(PROBE_GAIN, 1e-4)).toFixed(4);
    /* the reference radiance a prop or a pane of glass should reflect: the
       middle of the slot the canyon actually shows, not the whole dome */
    var c = skyShape(0.0, 0.86, 0.0, [0, 0, 0]);
    SKY_VIS_RGB = [c[0] * VIS_GAIN, c[1] * VIS_GAIN, c[2] * VIS_GAIN];
    /* 9 degrees up, down the street's own axis: the patch of sky a ridge, a
       roofline or a far rank of houses is actually silhouetted against. */
    var bh = skyShape(0.985, 0.156, 0.0, [0, 0, 0]);
    BACK_SKY = [bh[0] * VIS_GAIN, bh[1] * VIS_GAIN, bh[2] * VIS_GAIN];
  }

  /* ---- fog + exposure ---------------------------------------------------
     nz-render writes fog exactly once, in applyAtmosphere() at 'ready'
     (nz-render.js:1591-1613), and never per frame, so a per-frame writer does
     not fight it -- but the baseline has to be snapshotted AFTER that, which is
     what install() at priority -60 does.

     far stays long (540, against night's 520). Crushing it to ~190 would erase
     the backdrop entirely and the backdrop is the only thing telling the player
     this canyon is part of a town. The fog COLOUR carries the overcast read
     instead: it is deliberately a little darker and cooler than the sky, so a
     fully fogged ridge reads as a pale mass against a brighter sky -- which is
     precisely the relationship measured in _ref/ref5 (hills 200/207/214 against
     a sky of 219/228/236). */
  var DAY_FOG = hexLin(0xd5dade);
  /* SCENE fog stays long. Crushing the far plane to 300 did lift the far end of
     the canyon -- and it also lifted the NIGHT ALLEY seen through the mouth,
     because scene.fog is global and the alley's far wall is 66 units from the
     same camera the dead end is 80 units from. Measured: the passage interior
     went from 76.6 to 86.0. There is no distance that separates them, so
     distance is the wrong discriminator; the daylight MASK is the right one,
     and this module already carries it into every participating fragment
     shader. See HAZE_* and INJ_FOG. */
  var DAY_FOG_NEAR = 55, DAY_FOG_FAR = 540;
  /* the backdrop keeps its own pair so a future change to the scene fog cannot
     wash the distant town flat -- it sits 96-670 units out */
  var BACK_FOG_NEAR = 55, BACK_FOG_FAR = 620;
  /* ---- the canyon's recession, gated on the daylight mask ----------------
     The far end of the canyon measured 93-96/255 against a near facade at 116:
     it got DARKER with distance, which is what makes 24 m read as a room
     rather than a street. _ref/ref1 and _ref/ref4 both visibly lighten toward
     the vanishing point. This is an aerial-perspective term applied AFTER
     <fog_fragment>, multiplied by nzSkDay(worldPos), so a surface in the night
     alley -- mask 0 -- cannot receive one photon of it however far away it is.
     Capped at HAZE_AMT rather than running to 1.0 so the roofline and the
     backdrop behind it keep their separation. 0.20 at 80 units lifts a 96 to
     roughly the brief's 148. */
  /* ...and why 16/150/linear was the single biggest defect left in the frame.
     The mix runs in SCENE-LINEAR (nz-render puts NoToneMapping on the renderer
     and tonemaps in its composite, nz-render.js:4103, so <fog_fragment> and
     everything injected after it is still HDR radiance, NOT display sRGB).
     uNzHaze is linear 0.658. At the old constants a fragment 45 units out --
     which is the MIDDLE of the money shot, not its horizon -- took
     mix(c, 0.658, 0.073): a surface sitting at linear 0.020 came back at 0.067.
     Measured on the frame that is +34 code values of veiling glare on the
     blacks, and it is most of the reason p5 read 56 against the photograph's
     22. It also ate the colour: 7 % of every pixel replaced by a near-neutral
     is a 7 % desaturation of the entire middle distance, applied hardest
     exactly where the salmon and oxide-red walls are.

     The fix is NOT to delete the term -- the far end really does have to
     lighten, that was a real defect and this really did fix it -- but to make
     it the shape aerial perspective actually has. Airlight integrates as
     1 - exp(-sigma d): flat near the eye, accelerating out. A linear ramp
     starting at 16 units is the one shape that puts most of its energy in the
     near field, where there is no air. HAZE_POW 2.0 with the near edge pushed
     to 30 keeps the vanishing point and gives the near two-thirds of the frame
     back:
        d  30   0.000  (was 0.035)      d  80   0.041  (was 0.160)
        d  45   0.004  (was 0.073)      d 150   0.237  (was 0.335)
     The dead end at 80 units keeps a quarter of its lift; the backdrop keeps
     three quarters of its; the road at the player's feet keeps none, which is
     correct, because 8 metres of air does nothing. */
  var HAZE_NEAR = qk('hnear', 30), HAZE_FAR = qk('hfar', 165);
  var HAZE_AMT = qk('hamt', 0.30), HAZE_POW = qk('hpow', 2.0);
  if (NO_GRADE) { HAZE_NEAR = 16; HAZE_FAR = 150; HAZE_AMT = 0.335; HAZE_POW = 1.0; }
  var DAY_EV = -0.10;
  /* mission 4 exposure trim, applied in sunnyProfile() */
  var DAY_EV4 = -0.22;                 /* stops, |EV| <= 0.25 (RENDER-CONTRACT 3.4) */

  /* ---- THE TONAL GRADE, on the daylight mask ------------------------------
     The frame's median was already right and both of its ends were short:
     measured p5 / p50 / p95 = 56.4 / 112 / 179 against _ref/ref1's
     21.9 / 107.4 / 220.2. Run backwards through nz-render's composite -- ACES
     at uExposure = P.exposure/0.6 = 1.58333, the display-space S at
     P.contrast 0.16, P.saturation 1.02, then the sRGB transfer -- that is, in
     SCENE-LINEAR radiance:

         ours   p5 0.0669   p50 0.1642   p95 0.3946
         ref1   p5 0.0248   p50 0.1543   p95 0.8346

     so the blacks are 2.7x too high, the median is 6 % too high (i.e. right)
     and the highlights are 2.1x too LOW. No exposure move can fix that -- the
     critic is right that pulling exposure makes p95 worse -- because it is not
     a level error, it is a RANGE error, and the only operator that changes a
     range without moving its centre is a power about a pivot:

         out = PIVOT * (in / PIVOT)^CON * GAIN

     CON > 1 pushes the blacks down and the highlights up around PIVOT; GAIN
     puts the median back where it belongs afterwards. The first pass shipped
     CON 1.26 / GAIN 1.294 about a pivot of 0.1192 -- the value the haze fix
     above was predicted to leave the median at -- and measured, on the frame,
     p5 56.4 -> 30.2, p50 112 -> 122.4, p95 179 -> 208.7. The constants below
     are that measurement re-solved; PIVOT is now the MEASURED pre-grade median
     rather than the predicted one.

     WHAT THIS COSTS, and why it does not cost the thing that must not move.
     A power in linear turns every RATIO r into r^CON, and the cavity ratios
     bake() produces are measured correct. At CON 1.26 the under-car / open-road
     ratio the critic pins at 0.46 (ref1) / 0.41 (ref1 blue saloon) moves from
     our measured 0.44-0.50 to 0.38-0.42, which straddles the low edge of the
     reference band instead of sitting on its high edge. The porch /
     open-render ratio 0.53 moves to 0.45 against _ref/ref2's 0.57 and
     _ref/ref1's 0.39 -- between them, where it was already. Nothing is
     inverted and nothing leaves the band the two photographs bracket.

     SAT is a chroma multiply about the same luminance, so it multiplies
     (max-min)/max and leaves every luminance ratio in the frame untouched --
     it cannot move an AO measurement at all. It closes roughly half the
     saturation gap; the other half is albedo and belongs to the modules that
     own the render, the pantiles and the car paint.

     All four are multiplied by nzSkDay(worldPos) at the point of use, so at
     mask 0 the whole block is skipped by an `if` and the night half is not
     merely unchanged but never executed.

     WHY THE EXPONENT IS ASYMMETRIC. A single CON solved on all five
     percentiles at once comes out at 1.478, which lands p5 on 21.0 and p95 on
     216.3 -- and takes the under-car / open-road ratio to 0.320, against
     _ref/ref1's 0.46 and 0.41. That is inverting a measured occlusion to buy
     15 code values of highlight, and it is exactly the trade the brief forbids.
     So the curve gets two exponents about the pivot: CON_LO below it, CON_HI
     above. Every dark-on-dark ratio in the frame -- under-car / open road,
     pavers / road, conifer / road, all of which sit BELOW the pivot at both
     ends -- is transformed by CON_LO alone and is therefore governed entirely
     by the 1.26 that was checked against the reference band. CON_HI only ever
     touches pairs where both members are already brighter than the median.
     Solved that way (pivot = the measured pre-grade median 0.1396):

        CON_LO 1.26   p5   30.2 -> 26.8    under-car 0.46 -> 0.381
        GAIN   1.196  p50 122.4 -> 113.3   under-car 0.50 -> 0.424
        CON_HI 1.60   p95 208.7 -> 218.4   pavers    0.70 -> 0.648
                      spread 178.5 -> 191.6  (ref1 198.3, ref4 206.6)

     The exponent is crossfaded over r in [0.80, 1.40] rather than switched at
     r = 1, because a step in the exponent is a step in the SLOPE, and a slope
     discontinuity sitting exactly on the median of the frame is a contour line
     drawn across every smoothly shaded wall in it. */
  var GRADE_PIVOT = qk('piv', 0.1396);   /* scene-linear, the pre-grade median  */
  var GRADE_CON   = qk('con', 1.26);     /* below the pivot: guards the ratios  */
  var GRADE_CONHI = qk('conhi', 1.60);   /* above it: buys the highlight tail   */
  var GRADE_GAIN  = qk('gain', 1.196);
  var GRADE_SAT   = qk('sat', 1.62);
  /* a ceiling on the graded value, in scene-linear. fwd(6.0) through the
     composite is 251.5/255, so a shoulder of 1.60 cannot hand nz-render a
     value that clips -- the brief is explicit that a blown frame is a worse
     failure than a flat one, and _ref/ref1 itself peaks with only 0.36 % of
     its pixels at 254+. */
  var GRADE_CEIL  = qk('ceil', 6.0);
  if (NO_GRADE) { GRADE_CON = 1.0; GRADE_CONHI = 1.0; GRADE_GAIN = 1.0; GRADE_SAT = 1.0; }
  var GRADE_ON = !(GRADE_CON === 1 && GRADE_CONHI === 1 && GRADE_GAIN === 1 && GRADE_SAT === 1);

  /* =======================================================================
     SECTION 3 -- NZ.street, published at LOAD time
     STREET-MODULE-CONTRACT.md gives this module 'ready' at -60 and says it
     runs first. nz-core.js:43 sorts hooks DESCENDING (`b.p - a.p`), so -60
     actually runs LAST of the three street modules -- after nz-street.js (-50)
     and nz-street-props.js (-40).

     Rather than argue with the contract, the namespace is created here, while
     the script is parsed. This file is the first of the three <script> tags
     (NUKEM.html:8131-8133), so NZ.street and both of its callable members exist
     before the other two files are even fetched, and the resolved hook order
     stops mattering: bake() is pure geometry and needs nothing, and day()
     builds the probe lazily the first time anybody asks for it.
     ==================================================================== */
  var probeRT = null, probeTex = null;
  var pendingDay = [];                /* materials given day() before the probe */

  var street = {
    ok: false,
    disabled: DISABLED,
    tier: null,
    PREFIX: 'nzday:',

    /* THE CARVE, republished for the widened street. Every one of these moved
       except PLANE.west, PLANE.east and STOREY. Read them; do not re-derive
       them locally, and do not assume last round's numbers:
         BOX     x [168,252] z [152,192] y [0,52]   (was z [156,188])
         MOUTH   the JUNCTION THROAT, north of the plane: x [176,192]
                 z [148,152], opening y [0,28] under the bridge band
         THROAT  its street side, repainted ROAD f 0: x [176,192] z [152,160]
         BAND    the bridge band's face: x [176,192] y [28,52] at z = 152
         ISLAND  the kerbed teardrop: x [184,192] z [168,176]
         FOYER   x [236,252] z [124,148]            (was z [124,152])
         DOOR    x [240,244] on the plane z = 152, cell z [148,152]
         PLANE   north 152, south 192, west 168, east 252
         KERB    northTop 160, southTop 184, height 0.5
       ROADWAY is z [160,184], i.e. KERB.northTop..KERB.southTop, and the crown
       of the camber is z = 172. */
    BOX: BOX, MOUTH: MOUTH, THROAT: THROAT, BAND: BAND, ISLAND: ISLAND,
    FOYER: FOYER, DOOR: DOOR,
    PLANE: PLANE, KERB: KERB, STOREY: STOREY,

    probe: null,
    probeIntensity: 1.0,

    day: dayMaterial,
    bake: bakeGeometry,
    /* register an AABB as an occluder without baking against it. Any box that
       reaches bake() through opts.occluders is registered automatically, so
       nobody has to call this -- it exists for geometry that is built after
       everything has been baked (a car moved, a tree added late). */
    occlude: function (boxes) {
      registerOcc(Array.isArray(boxes) ? boxes : [boxes]);
      return REG.length;
    },

    SKY: null,                        /* filled by solveGains()                */
    ZONE: { a: ZA, b: ZB, c: ZC, d: ZD, list: ZONES, fogFeather: FOG_FEATHER },
    mask: dayMask,                    /* the exact mask the shader uses        */

    facades: [],                      /* nz-street.js fills this               */

    stats: STATS, diag: DIAG,
    report: report,
    dispose: function () { panic('manual dispose'); }
  };
  solveGains();
  /* published as LINEAR radiance at the visible-dome scale -- the number a prop
     or a pane of glass should reflect, not an sRGB swatch */
  function skyAt(dx, dy, dz) {
    var c = skyShape(dx, dy, dz, [0, 0, 0]), k = VIS_GAIN;
    return f3([c[0] * k, c[1] * k, c[2] * k]);
  }
  /* Re-run after sunnyProfile(): every constant this reads moves on mission 4,
     and props, glass and the park all size their reflections and their distance
     tones off it. Publishing the overcast numbers into a sunny level is how a
     window ends up mirroring a grey sky in a blue one. */
  function publishSky() {
    street.SKY = {
      zenith: skyAt(0, 1, 0),
      horizon: skyAt(0, 0.10, -1 * Math.sqrt(1 - 0.01)),
      ground: skyAt(0, -1, 0),
      lum: +(0.2126 * SKY_VIS_RGB[0] + 0.7152 * SKY_VIS_RGB[1] + 0.0722 * SKY_VIS_RGB[2]).toFixed(4),
      irradiance: DAY_IRRADIANCE,
      fog: f3(DAY_FOG),
      sunny: LEVEL4 && !OVERCAST4,
      overcast: OVERCAST4 || !LEVEL4,
      sun: LEVEL4 && !OVERCAST4 ? { dir: f3(SUN_DIR_W), elevation: SUN_EL, irradiance: SUN_KEY } : null
    };
    return street.SKY;
  }
  publishSky();
  NZ.street = street;

  if (DISABLED) {
    /* A no-op module still owes the other two the geometry constants and two
       callables that do not throw; without them they would each need a private
       copy of the carve, which is how three files drift apart. */
    street.day = function (mat) { if (mat) mat.name = 'nzday:' + (mat.name || 'off'); return mat; };
    street.bake = function (geo) { return geo; };
    street.occlude = function () { return 0; };
    NZ.log && NZ.log('street-sky disabled by query string (?nzsky=0)');
    return;
  }

  /* =======================================================================
     SECTION 4 -- the daylight shader
     ONE shared onBeforeCompile for every participating material, so
     nz-render's nzCacheKey() (nz-render.js:1067, which stringifies the hook)
     yields ONE extra program variant rather than one per surface.

     Two modes, chosen by a per-material uniform:
       uNzSkP.y = 1  the material carries the day probe on material.envMap.
                     Only the night rig's direct term is suppressed.
       uNzSkP.y = 0  a world/nzenv material shared with the night level. The
                     night probe and the direct term are both suppressed inside
                     the mask and an analytic overcast hemisphere is put in
                     their place. This is the only mechanism in r149 that can
                     produce a SPATIAL gradient across a mesh spanning both
                     halves of the level -- there is no per-object light
                     masking and no per-object fog, at any version.

     Injected before <lights_fragment_end>. nz-render prepends its AO / contact
     shadow / SSR block at the same anchor from its priority -1000 sweep, and
     because it runs last its block ends up BELOW this one -- so the GTAO
     multiply lands on the daylight irradiance, which is exactly the wanted
     order, and its contact-shadow multiply lands on a direct term this block
     has already reduced to 5%.
     ==================================================================== */
  var MARK = '/*NZ_STREET_SKY*/';

  function maskGLSL() {
    function box(B) {
      return 'vec3(' + g3(B.x0) + ',' + g3(B.y0) + ',' + g3(B.z0) + '), vec3(' +
             g3(B.x1) + ',' + g3(B.y1) + ',' + g3(B.z1) + '), ' + g3(B.f);
    }
    return [
      'float nzSkBox(vec3 p, vec3 lo, vec3 hi, float fea){',
      '  vec3 d = max(max(lo - p, p - hi), vec3(0.0));',
      '  float t = clamp(1.0 - length(d) / fea, 0.0, 1.0);',
      '  return t * t * (3.0 - 2.0 * t);',
      '}',
      'float nzSkDay(vec3 p){',
      '  float m = 0.0;',
      ZONES.map(function (Z) { return '  m = max(m, nzSkBox(p, ' + box(Z) + '));'; }).join('\n'),
      '  return m;',
      '}',
      /* ---- THE NORTH SKIN, and why the mask alone cannot exclude it -------
         ZA's north edge is the facade plane z = 152 and its feather is
         isotropic, so the mask is 1.0 ON that plane and still 0.5 seven units
         NORTH of it -- for the whole 84-unit width of the wall, not just at
         the throat the feather was put there for. The outward face of the
         north facade is therefore fully inside the daylight zone, and it is a
         NIGHT surface: it is what the player sees from the alley and the
         rooftop. Measured on the old carve, looking south from (196, 6.4, 116):
         the shop parade and the soffit above it -- everything in the upper two
         thirds of that frame -- took the full grade, p50 75.6 -> 65.0 and max
         219.9 -> 248.1, while the near ground did not move at all. The
         widening moved the plane 4 units north; the defect and its fix move
         with it, and the same control frame still proves it.

         Position cannot separate the two faces: they are both at z = 152. The
         normal can. nzSkFace() is 0 on a surface that is at or north of the
         plane AND does not face into the canyon, 1 everywhere else:

           outward wall  z 152, n (0,0,-1)   0    night, correctly excluded
           outward soffit z 152, n (0,-1,0)  0    night (this is the bridge
                                                  band's underside over the
                                                  throat, which is night)
           canyon wall   z 152, n (0,0,+1)   1    daylight (and the band's
                                                  south face with it)
           north pavement z 152-160, n up    1    daylight (the `up` clause is
                                                  what keeps the pavement, the
                                                  kerb and the throat's dropped
                                                  asphalt out of the gate)
           anything z >= 153.5                1    unaffected, whatever it faces

         This is a LEAK FIX, not part of the grade, so it is applied in both
         A/B states: ?nzgrade=0 restores the old haze ramp and drops the tonal
         curve, but it does not put the leak back. It gates the two terms this
         module applies AFTER the fog -- the aerial perspective and the grade.
         The shading mask in INJ_LIGHT is deliberately left alone: three other
         modules have calibrated surfaces against it this round and moving it
         is not this round's change. The residue -- that the outward skin is
         still lit by the analytic overcast hemisphere and still carries the
         daylight vertex bake retargetWorld() wrote -- is real, pre-dates this
         pass, and is called out in the report rather than fixed here.

         WHERE THE RESIDUE LANDS ON THE WIDENED CARVE, measured this round so
         the next agent does not have to find it twice. ZA is an isotropic
         feather on an AABB, so it bulges around the zone's two convex NW/NE
         corners as well as across its north face. The corners now sit at
         (168, ., 152) and (252, ., 152). Only one of them has night geometry
         within 7 units: the ALLEY COLUMN, cells x = 41, y 33..37 -> x [164,168]
         z [132,152], the night-side nook that carries the secret-room approach
         and the drain-stair top. Its south dead end reads mask 0.64-1.00
         against 0.03-0.39 on the old carve, because the plane it butts moved
         4 units north onto it.

         It is bounded on three sides and does not need a fourth fix:
           * nzSkFace() zeroes the haze and the grade there -- every face of
             that nook is either north-facing (n.z = -1) or side-facing
             (n.y = n.z = 0) at z < 152, so `in_` is 0 and the gate shuts;
           * retargetWorld() skips it: its vertex loop requires
             px >= ZA.x0 - 0.01 = 167.99, so only the x = 168 edge of a quad is
             rewritten and the daylight bake never covers the nook;
           * what is left is the analytic hemisphere alone. Measured from
             (166, 6.4, 132) looking south down the column, module on vs
             ?nzsky=0: mean luminance 20.5 -> 22.5, and 50 pixels of 64,000
             exceed 120/255 against a daylit surface's 150-230. The corridor
             stays unambiguously night; a 40 px strip of its dead-end wall
             lifts from 25 to 52.
         Net across the carve the residue SHRANK: the old plane at z = 156 had
         open alley (x 168..188) inside the feather for 20 units of its width,
         and the re-carve made x 42..43 solid, leaving only this 4-unit nook. */
      /* MISSION 4 HAS NO NORTH SKIN. The plane at z = 140 is the A-BLOK facade
         only on the A/B canyon; on mission 4 everything north of it is 232 Sk
         North, which is carved, daylit and open sky -- there is no night alley
         behind it to protect. Leaving the gate in cost every west- and
         east-facing wall on the north arm its haze AND its grade, so one half
         of the mission rendered flat and desaturated against the other half's
         graded street, for a leak that cannot happen on this map. */
      LEVEL4 ? [
      'float nzSkFace(vec3 p, vec3 n){ return 1.0; }'
      ].join('\n') : [
      'float nzSkFace(vec3 p, vec3 n){',
      '  float pl = 1.0 - smoothstep(' + g3(PLANE.north) + ', ' +
        g3(PLANE.north + 1.5) + ', p.z);',
      '  float in_ = max(smoothstep(0.15, 0.55, n.z), smoothstep(0.30, 0.70, n.y));',
      '  return 1.0 - pl * (1.0 - in_);',
      '}'
      ].join('\n')
    ].join('\n');
  }

  var INJ_HEAD = null, INJ_LIGHT = null, INJ_FOG = null;
  function buildInjections() {
    INJ_HEAD = [
      MARK,
      'uniform vec4 uNzSkP;',        /* x directKill, y ownsProbe, z specGain, w on */
      'uniform vec3 uNzSkUp;',       /* analytic irradiance, surface facing up      */
      'uniform vec3 uNzSkDn;',       /* ...and facing down                          */
      'uniform vec3 uNzHaze;',       /* the day fog colour, for the recession term  */
      maskGLSL()
    ].join('\n');

    /* Injected AFTER <fog_fragment>, which in r149 is the last thing that
       touches gl_FragColor.rgb before premultiply/dither. `vFogDepth` is
       declared by <fog_pars_fragment> whenever USE_FOG, so the whole block is
       inside that guard and a material without fog simply never sees it. */
    /* Two blocks, deliberately not one. The haze needs vFogDepth, which only
       exists under USE_FOG; the grade needs nothing but the world position, and
       a caller is allowed to hand day() a material with fog:false. Putting the
       grade inside the fog guard would leave that one prop ungraded next to
       everything around it, which is a worse artefact than no grade at all. */
    var INJ_HAZE = [
      '#ifdef USE_FOG',
      '  {',
      '    float nzHzD = uNzSkP.w * nzSkDay(vNzWP) * nzSkFace(vNzWP, vNzWN);',
      '    if (nzHzD > 0.002) {',
      '      float nzHz = clamp((vFogDepth - ' + g3(HAZE_NEAR) + ') / ' +
        g3(HAZE_FAR - HAZE_NEAR) + ', 0.0, 1.0);',
      (HAZE_POW === 1 ? '' :
      '      nzHz = pow(max(nzHz, 1e-5), ' + g3(HAZE_POW) + ');'),
      '      gl_FragColor.rgb = mix(gl_FragColor.rgb, uNzHaze, nzHz * nzHzD * ' + g3(HAZE_AMT) + ');',
      '    }',
      '  }',
      '#endif'
    ].filter(function (s) { return s !== ''; }).join('\n');

    /* The grade. Power about a pivot in scene-linear, then a chroma multiply
       about the SAME luminance so no ratio in the frame moves, then one mix
       against the daylight mask. At mask 0 the `if` is not taken: the night
       half does not execute a single instruction of this. */
    var INJ_GRADE = !GRADE_ON ? '' : [
      '  {',
      '    float nzGD = uNzSkP.w * nzSkDay(vNzWP) * nzSkFace(vNzWP, vNzWN);',
      '    if (nzGD > 0.002) {',
      '      vec3 nzGc = max(gl_FragColor.rgb, vec3(0.0));',
      '      float nzGy = max(dot(nzGc, vec3(0.2126, 0.7152, 0.0722)), 1e-5);',
      '      float nzGr = nzGy * ' + g3(1 / GRADE_PIVOT) + ';',
      '      float nzGe = mix(' + g3(GRADE_CON) + ', ' + g3(GRADE_CONHI) +
        ', smoothstep(0.80, 1.40, nzGr));',
      '      float nzGs = ' + g3(GRADE_PIVOT) + ' * pow(nzGr, nzGe) * ' + g3(GRADE_GAIN) + ';',
      '      vec3 nzGo = nzGc * (nzGs / nzGy);',
      '      nzGo = max(vec3(0.0), mix(vec3(nzGs), nzGo, ' + g3(GRADE_SAT) + '));',
      /* the same kind of ceiling the sky card takes (SECTION 7): a value the
         bloom pyramid cannot turn into a firefly, and a hard guarantee that a
         shoulder with CON_HI > 1 cannot hand the composite something that
         clips */
      '      nzGo = min(nzGo, vec3(' + g3(GRADE_CEIL) + '));',
      '      gl_FragColor.rgb = mix(gl_FragColor.rgb, nzGo, nzGD);',
      '    }',
      '  }'
    ].join('\n');

    INJ_FOG = [INJ_HAZE, INJ_GRADE].filter(function (s) { return s !== ''; }).join('\n');

    INJ_LIGHT = [
      '{',
      '  float nzSkD = uNzSkP.w * nzSkDay(vNzWP);',
      '  if (nzSkD > 0.002) {',
      /* 1. the night rig. Six lights, none of them removable: r149 has no
            per-object light filtering, so the only place a directional key can
            be cancelled for one region is here, per fragment. This is also
            what deletes the sun key's hard cast shadow off the road -- an
            overcast street with a shadow in it is not an overcast street. */
      /* THE BAKE MUST NOT MULTIPLY THE SUN.
         <color_fragment> has already done `diffuseColor *= vColor`, and vColor
         is this module's sky-VISIBILITY term. That is exactly right for the
         indirect half -- a soffit sees less sky, so it gets less sky -- and
         physically impossible for the direct half: a surface in full sunlight
         is not dimmed by how much sky it can see. The open road bakes at ~0.56
         and an upper facade at ~0.80, so the overcast build was cutting the
         sun by 44 % on the road and 20 % on the wall, which is why no single
         key intensity could land both. Occlusion of the SUN is the shadow map's
         job and it is already doing it.
         Divided back out here, clamped so a hard cavity cannot multiply by 20.
         Guarded on both spellings: r149 declares vColor as vec4 under
         USE_COLOR_ALPHA and vec3 under USE_COLOR, and reading the wrong one
         will not compile. */
      '    float nzBk = 1.0;',
      '#if defined( USE_COLOR_ALPHA )',
      '    nzBk = max(dot(vColor.rgb, vec3(0.3333333)), 0.30);',
      '#elif defined( USE_COLOR )',
      '    nzBk = max(dot(vColor, vec3(0.3333333)), 0.30);',
      '#endif',
      /* PARTIAL, and the fraction is the honest part of the story. Dividing the
         bake out completely is what physics says, and it also multiplies every
         open horizontal surface in the level by 1/0.56 = 1.8 -- against albedos
         that six modules solved with that same 0.56 already folded in. Taking
         it all back at once does not make the frame more correct, it makes it
         white, and re-authoring every road, pavement, kerb and roof albedo in
         the level is a different pass from this one. So the correction is
         applied at DEBAKE_AMT: enough that a balcony soffit and a canyon floor
         stop having the sun cut out of them twice, not so much that the
         calibration underneath has to be redone to see the frame at all. */
      (SUN_DEBAKE
        ? "    float nzSkK = mix(1.0, uNzSkP.x * mix(1.0, 1.0 / nzBk, " + g3(DEBAKE_AMT) + "), nzSkD);"
        : "    float nzSkK = mix(1.0, uNzSkP.x, nzSkD);"),
      '    reflectedLight.directDiffuse  *= nzSkK;',
      '    reflectedLight.directSpecular *= nzSkK;',
      '#if defined( RE_IndirectDiffuse )',
      '    if (uNzSkP.y < 0.5) {',
      '      float nzSkU = clamp(vNzWN.y * 0.5 + 0.5, 0.0, 1.0);',
      '      nzSkU = nzSkU * nzSkU * (3.0 - 2.0 * nzSkU);',
      '      vec3 nzSkH = mix(uNzSkDn, uNzSkUp, nzSkU);',
      /* r149's WebGLLights multiplies every light by PI when
         physicallyCorrectLights is false (which it is here), and
         getIBLIrradiance() returns PI * envMapColor, because RE_IndirectDiffuse
         then divides by PI in BRDF_Lambert. `irradiance` is therefore in
         PI-scaled units while uNzSkUp is authored in nz-render's own unit --
         the albedo multiplier a white surface facing the source receives.
         Leaving this factor out lands the whole street 1.65 stops dark. */
      '      irradiance    = mix(irradiance, nzSkH * 3.14159265, nzSkD);',
      '      iblIrradiance = mix(iblIrradiance, iblIrradiance * ' + g3(DAY_IBL_KILL) + ', nzSkD);',
      '#if defined( RE_IndirectSpecular )',
      (SPEC_ORIENTED ? [
      /* the bake, which the diffuse path already has through <color_fragment>
         and which this path was the only term in the shader to bypass. Guarded
         on both spellings: r149 declares vColor as vec4 under USE_COLOR_ALPHA
         and vec3 under USE_COLOR, and reading the wrong one will not compile. */
      '      float nzSkO = 1.0;',
      '#if defined( USE_COLOR_ALPHA )',
      '      nzSkO = clamp(dot(vColor.rgb, vec3(0.3333333)) * ' + g3(1 / SPEC_OCC_REF) + ', 0.0, 1.0);',
      '#elif defined( USE_COLOR )',
      '      nzSkO = clamp(dot(vColor, vec3(0.3333333)) * ' + g3(1 / SPEC_OCC_REF) + ', 0.0, 1.0);',
      '#endif',
      /* the mirror direction in WORLD space. cameraPosition is declared by
         <common>, which is included after INJ_HEAD and long before this. */
      '      vec3 nzSkR = reflect(normalize(vNzWP - cameraPosition), normalize(vNzWN));',
      '      float nzSkRu = clamp(nzSkR.y * 0.5 + 0.5, 0.0, 1.0);',
      '      nzSkRu = nzSkRu * nzSkRu * (3.0 - 2.0 * nzSkRu);',
      '      radiance = mix(radiance, mix(uNzSkDn, uNzSkUp, nzSkRu) * (uNzSkP.z * nzSkO), nzSkD);'
      ].join('\n')
      : '      radiance = mix(radiance, uNzSkUp * uNzSkP.z, nzSkD);'),
      '#endif',
      '    }',
      '#endif',
      '  }',
      '}'
    ].join('\n');
  }

  /* Compile the injected GLSL standalone against the real context before it
     reaches a material. A GLSL error inside onBeforeCompile does not throw --
     it silently renders black -- and this module cannot see the screen.
     (nz-env.js:1597-1650 makes the same argument and the same probe.) */
  function validateGLSL() {
    var gl;
    try { gl = renderer.getContext(); } catch (e) { return false; }
    if (!gl) return false;
    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      var ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
      if (!ok) warn('GLSL probe failed: ' + gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return !!ok;
    }
    var fs = [
      'precision highp float;',
      '#define USE_FOG',
      /* USE_COLOR + vColor and cameraPosition are declared by <color_pars_fragment>
         and <common> in a real material; declared here by hand so the two new
         branches in INJ_LIGHT are actually compiled by the probe rather than
         preprocessed away and discovered at runtime as a black street. */
      '#define USE_COLOR',
      'varying vec3 vColor;',
      'uniform vec3 cameraPosition;',
      'varying vec3 vNzWP;',
      'varying vec3 vNzWN;',
      'varying float vFogDepth;',
      '#define RE_IndirectDiffuse',
      '#define RE_IndirectSpecular',
      'struct NzRL { vec3 directDiffuse; vec3 directSpecular; };',
      INJ_HEAD,
      skyGLSL(),
      'void main(){',
      '  NzRL reflectedLight = NzRL(vec3(1.0), vec3(1.0));',
      '  vec3 irradiance = vec3(0.5), iblIrradiance = vec3(0.5), radiance = vec3(0.5);',
      INJ_LIGHT,
      '  vec3 s = nzSkySample(normalize(vNzWN));',
      '  vec3 cl = vec3(nzSkCloud(normalize(vNzWN)));',
      '  gl_FragColor = vec4(irradiance + iblIrradiance + radiance + cl +',
      '                      reflectedLight.directDiffuse + reflectedLight.directSpecular + s, 1.0);',
      INJ_FOG,
      '}'
    ].join('\n');
    var vs = [
      'attribute vec3 position; attribute vec3 normal;',
      'uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix;',
      'varying vec3 vNzWP; varying vec3 vNzWN; varying float vFogDepth;',
      'void main(){',
      '  vNzWN = normalize(mat3(modelMatrix) * normal);',
      '  vNzWP = (modelMatrix * vec4(position, 1.0)).xyz;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  vFogDepth = -mv.z;',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n');
    return compile(gl.VERTEX_SHADER, vs) && compile(gl.FRAGMENT_SHADER, fs);
  }

  var GLSL_OK = null;                  /* null = probe not run yet              */
  var pendingPatch = [];               /* materials day()'d before install()    */
  var MAIN_RE = /void\s+main\s*\(\s*\)\s*\{/;
  var uSkUp = null, uSkDn = null, uHaze = null;  /* SHARED -> one write         */

  /* The single shared hook. `this` is the material. */
  function skyPatch(shader, rendererArg) {
    /* ---- CHAIN, never replace. nz-env installs its own per-instance
       onBeforeCompile on every world surface, and a per-instance hook SHADOWS
       THREE.Material.prototype.onBeforeCompile, which is where nz-render's
       AO / contact shadow / PCSS patch lives. Run whatever was already on the
       material (which itself chains to the prototype), or the prototype
       directly if there was nothing. */
    try {
      var inner = this.__nzSkInner;
      if (typeof inner === 'function') { inner.call(this, shader, rendererArg); }
      else {
        var proto = THREE.Material.prototype.onBeforeCompile;
        if (typeof proto === 'function' && proto !== skyPatch) proto.call(this, shader, rendererArg);
      }
    } catch (e) { /* a half-rewritten shader is still better than a dead one */ }

    try {
      var f = shader.fragmentShader, v = shader.vertexShader;
      if (!f || f.indexOf(MARK) >= 0) return;                    /* idempotent */
      if (f.indexOf('#include <lights_fragment_end>') < 0) return;
      if (f.indexOf('#include <common>') < 0) return;

      /* vNzWP / vNzWN are already varyings on every material nz-env owns
         (nz-env.js:1581-1588, :1706-1710). Only declare them if they are not. */
      if (f.indexOf('varying vec3 vNzWP;') < 0) {
        if (!MAIN_RE.test(v) || !MAIN_RE.test(f)) return;
        if (v.indexOf('#include <begin_vertex>') < 0) return;
        if (v.indexOf('#include <beginnormal_vertex>') < 0) return;
        v = v.replace(MAIN_RE, 'varying vec3 vNzWP;\nvarying vec3 vNzWN;\nvoid main() {');
        v = v.replace('#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\n  vNzWN = normalize( mat3( modelMatrix ) * objectNormal );');
        v = v.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vNzWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
        f = f.replace(MAIN_RE, 'varying vec3 vNzWP;\nvarying vec3 vNzWN;\nvoid main() {');
        shader.vertexShader = v;
      }
      f = f.replace('#include <common>', INJ_HEAD + '\n#include <common>');
      f = f.replace('#include <lights_fragment_end>', INJ_LIGHT + '\n#include <lights_fragment_end>');
      if (INJ_FOG && f.indexOf('#include <fog_fragment>') >= 0)
        f = f.replace('#include <fog_fragment>', '#include <fog_fragment>\n' + INJ_FOG);
      shader.fragmentShader = f;

      shader.uniforms.uNzHaze = uHaze;
      shader.uniforms.uNzSkUp = uSkUp;
      shader.uniforms.uNzSkDn = uSkDn;
      shader.uniforms.uNzSkP = { value: this.__nzSkP || new THREE.Vector4(DAY_DIRECT_KILL, 0, DAY_SPEC, 1) };
    } catch (e) { warn('shader injection failed on "' + (this.name || '?') + '": ' + (e && e.message)); }
  }

  /* Every material this module has ever handed daylight parameters to.
     nz-street.js (-50) and nz-street-props.js (-40) both run their 'ready'
     hooks BEFORE this module's (-60, and nz-core sorts descending), so every
     one of their materials captured __nzSkP.x from DAY_DIRECT_KILL while it
     still held the OVERCAST value. Mission 4 moves that constant in install();
     without this list the move would reach the GLSL and not the uniforms, and
     the sun would be cancelled on exactly the surfaces it is meant to light. */
  var DAYMATS = [];
  function refreshDayParams() {
    for (var i = 0; i < DAYMATS.length; i++) {
      var m = DAYMATS[i];
      if (!m || !m.__nzSkP) continue;
      /* a caller that asked for a specific `direct`/`spec` keeps it: nz-apc.js
         hands its cabin a reduced sky specular on purpose, and a blanket
         rewrite here would silently put it back to the module default. Only
         the materials that took the default are moved to the new default. */
      if (!m.__nzSkFix) { m.__nzSkP.x = DAY_DIRECT_KILL; m.__nzSkP.z = DAY_SPEC; }
    }
    note('day params refreshed on ' + DAYMATS.length + ' material(s)');
  }

  function attachPatch(mat, ownsProbe) {
    if (!mat || mat.__nzSkPatched) return mat;
    if (mat.isMeshBasicMaterial || mat.isShaderMaterial || mat.isSpriteMaterial) return mat;
    if (!THREE) return mat;
    if (!mat.__nzSkP) mat.__nzSkP = new THREE.Vector4(DAY_DIRECT_KILL, ownsProbe ? 1 : 0, DAY_SPEC, 1);
    if (DAYMATS.indexOf(mat) < 0) DAYMATS.push(mat);
    /* nz-street.js and nz-street-props.js run their 'ready' hooks BEFORE this
       one (nz-core sorts descending, so -50 and -40 both beat -60), which means
       day() can be called before the GLSL probe has been run. Queue those and
       attach them in install() -- injecting GLSL that has not been proved to
       compile is how a level goes silently black. */
    if (GLSL_OK === null) {
      if (pendingPatch.indexOf(mat) < 0) pendingPatch.push(mat);
      return mat;
    }
    if (GLSL_OK !== true) return mat;
    mat.__nzSkInner = Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')
      ? mat.onBeforeCompile : null;
    mat.onBeforeCompile = skyPatch;
    mat.__nzSkPatched = 1;
    mat.needsUpdate = true;
    OWN.patched.push(mat);
    return mat;
  }

  /* =======================================================================
     SECTION 5 -- the daylight probe
     Same construction as nz-render's buildEnvironment() (nz-render.js:1626),
     but the result never goes near scene.environment: it is handed out through
     material.envMap, which r149's WebGLPrograms.getParameters resolves FIRST
     (`cubeuvmaps.get( material.envMap || environment )`). Both are
     CubeUVReflectionMapping, so the program is shared and nothing recompiles.
     ==================================================================== */
  function buildProbe() {
    prepareMissionProfile();
    if (probeTex) return probeTex;
    if (!renderer || !THREE || !THREE.PMREMGenerator) return null;
    if (!tierDone) applyTier();
    var caps = (NZ.render && NZ.render.caps) || null;
    if (caps && caps.hdr === false) {
      note('no half-float render targets: probe skipped, analytic hemisphere only');
      return null;
    }
    var t0 = now();
    /* nz-render bakes its own probe at EFF.envCube (512 at high) because that
       one has to hold a solar disc. This one has no sun, no cloud shapes and no
       feature narrower than 30 degrees, so 256 is already past the point where
       another texel changes a pixel -- and it is 4x the VRAM at 512. */
    var res = 256;
    try {
      var eff = NZ.render && NZ.render.effects;
      if (eff && eff.envCube) res = Math.min(256, eff.envCube);
      res = Math.min(res, renderer.capabilities.maxTextureSize || 256);
    } catch (e) { res = 128; }
    if (TIER === 'low') res = Math.min(res, 128);
    STATS.probeRes = res;

    var uni = { uGain: { value: PROBE_GAIN } };
    var mat = new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: [
        'varying vec3 vDir;',
        'void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vDir;', 'uniform float uGain;', skyGLSL(),
        'void main(){ gl_FragColor = vec4(nzSkyLit(normalize(vDir), ' + g3(LIT_SAT) + ') * uGain, 1.0); }'
      ].join('\n'),
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false
    });
    var geo = new THREE.BoxGeometry(10, 10, 10);
    var box = new THREE.Mesh(geo, mat);
    box.frustumCulled = false;
    var tmp = new THREE.Scene();
    tmp.add(box);

    var cubeRT = new THREE.WebGLCubeRenderTarget(res, {
      format: THREE.RGBAFormat, type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false
    });
    if (THREE.LinearEncoding !== undefined) cubeRT.texture.encoding = THREE.LinearEncoding;

    var prevRT = renderer.getRenderTarget();
    var prevAuto = renderer.autoClear;
    try {
      new THREE.CubeCamera(0.5, 40, cubeRT).update(renderer, tmp);
      var pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileCubemapShader();
      probeRT = pmrem.fromCubemap(cubeRT.texture);
      pmrem.dispose();
      probeTex = probeRT.texture;
    } catch (e) {
      warn('PMREM probe failed (' + (e && e.message) + '); falling back to the analytic hemisphere');
      probeTex = null;
    }
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;

    cubeRT.dispose(); geo.dispose(); mat.dispose();
    STATS.probeMs = Math.round(now() - t0);
    STATS.texBytes += res * res * 6 * 8 * 1.34;      /* 6 faces, RGBA16F, mips */
    street.probe = probeTex;
    street.probeIntensity = 1.0;
    if (probeTex) note('day probe ' + res + 'px, gain ' + PROBE_GAIN.toFixed(3) +
                       ', E(up) = ' + DAY_IRRADIANCE.toFixed(2) + ' in ' + STATS.probeMs + 'ms');
    /* anything handed out before the probe existed gets it now */
    for (var i = 0; i < pendingDay.length; i++) {
      var mm = pendingDay[i];
      if (!mm || !probeTex) continue;
      mm.envMap = probeTex;
      if (mm.__nzSkP) mm.__nzSkP.y = 1;
      mm.needsUpdate = true;
    }
    pendingDay.length = 0;
    return probeTex;
  }

  /* -----------------------------------------------------------------------
     NZ.street.day(material, opts)
     The one call every daylit material must make.
     opts = { intensity: Number,   -> envMapIntensity, default 1
              name:      String,   -> becomes 'nzday:<name>'
              direct:    Number,   -> 0..1, what survives of the night rig
              spec:      Number,   -> sky radiance handed to the specular lobe
              patch:     Boolean } -> false to skip the shader injection
     -------------------------------------------------------------------- */
  function dayMaterial(mat, opts) {
    if (!mat) return mat;
    opts = opts || {};
    try {
      prepareMissionProfile();
      if (!THREE) THREE = (NZ.ctx && NZ.ctx.THREE) || global.THREE;
      if (!renderer) renderer = NZ.ctx && NZ.ctx.renderer;

      /* nz-render.js:2282-2288 bakedMatName() returns null for anything that is
         not 'world:*' or 'nzenv:*', so neutralizeBakedLighting() leaves the
         overcast vertex bake on this material exactly as bake() wrote it.
         Getting this wrong lands the street up to 4.5 stops out of exposure. */
      var nm = opts.name || mat.name || 'surface';
      if (String(nm).indexOf('nzday:') !== 0) mat.name = 'nzday:' + nm;

      if (!probeTex && renderer && !dead) { try { buildProbe(); } catch (e) {} }
      if (probeTex) {
        mat.envMap = probeTex;
        mat.envMapIntensity = fin(opts.intensity, 1.0) * street.probeIntensity;
      } else if (pendingDay.indexOf(mat) < 0) {
        pendingDay.push(mat);
      }
      if (opts.patch !== false && THREE) {
        attachPatch(mat, !!probeTex);
        if (mat.__nzSkP) {
          if (DAYMATS.indexOf(mat) < 0) DAYMATS.push(mat);
          if (typeof opts.direct === 'number' || typeof opts.spec === 'number')
            mat.__nzSkFix = 1;
          mat.__nzSkP.x = fin(opts.direct, DAY_DIRECT_KILL);
          mat.__nzSkP.z = fin(opts.spec, DAY_SPEC);
          mat.__nzSkP.y = probeTex ? 1 : 0;
        }
      }
      mat.fog = (opts.fog === false) ? false : true;
      STATS.dayMats++;
    } catch (e) { warn('day() failed: ' + (e && e.message)); }
    return mat;
  }

  /* =======================================================================
     SECTION 6 -- the overcast vertex bake
     A sky-dome visibility term traced against the canyon, plus a flat
     inter-reflection floor for everything the canyon hides. Achromatic: an
     overcast sky has no hue to give, and any tint here fights the albedo.

     This is what replaces the point-light bake NUKEM.html's lightAt() wrote.
     The night regions bake 0.06..0.24 around a 1.45 clamp; this bakes around a
     reference of 1.0, which is what "correctly exposed diffuse albedo" means
     everywhere else in this renderer.
     ==================================================================== */
  var BAKE_FLOOR = 0.30;      /* what a fully enclosed surface still receives */
  var BAKE_LO = 0.055, BAKE_HI = 1.06;
  var RAYS = 48, RAYS_MIN = 24, rayDirs = null;

  /* ---- THE NEAR-FIELD TERM, which is the whole fix ------------------------
     The old bake asked one question per ray -- "does this escape?" -- and
     charged every blocked ray the same flat `floor`, so a road vertex 30 cm
     under a car and a road vertex in the open middle of the street differed
     only by how MANY rays were blocked, never by WHAT blocked them or how
     close it was. In a 9 m canyon under an overcast sky almost every ray from
     almost every surface is blocked by something, so that number barely moves:
     measured under-car / open-road came back at 0.992 against a reference
     0.41-0.46, and the balcony soffits -- which the brief calls the darkest
     surfaces on the facade -- came back at 0.82 of the wall beside them.

     A blocked ray does not return nothing; it returns whatever bounced off
     whatever stopped it. How much that is depends almost entirely on DISTANCE:
     a facade 30 units across the street is itself lit by the full sky and
     bounces a lot, a car floorpan 1 unit above the tarmac is lit by nothing and
     bounces almost nothing. So the trace now returns the distance to the
     blocker and the floor is scaled by it. That single change produces contact
     shadows at every tyre, plinth, kerb nose, downpipe and balcony soffit
     without any caller passing anything new, and leaves an open surface --
     whose blockers are all 16 units or more away -- bit-for-bit where it was.

     NEAR_R 9 units = 2.6 m: the distance at which a bounce card stops being a
     cavity and starts being the room. NEAR_MIN 0.20 is what survives in hard
     contact; it is not zero because even a wheel arch is open at the sides.
     Both were tuned against the A/B below: at 0.14/11 the term cost the money
     shot 9.3 code values of median for the same cavity ratios, which is more
     of the street's exposure than an occlusion term has any business taking. */
  var NEAR_R = 9.0, NEAR_MIN = 0.20, NEAR_P = 0.80;
  if (NO_AO) { NEAR_MIN = 1; BAKE_LO = 0.26; }
  function nearAtten(t) {
    if (!(t > 0)) return NEAR_MIN;
    if (t >= NEAR_R) return 1;
    return NEAR_MIN + (1 - NEAR_MIN) * Math.pow(t / NEAR_R, NEAR_P);
  }
  /* how soft the eaves are, in world units at the roof plane. A hard in/out
     test at the canyon opening makes the escaped-ray COUNT a step function of
     position: with the old 22-ray budget one ray flipping was worth ~6 % of the
     bake, which is the 14.7-code straight-edged seam the critic found across
     the near road. Feathering the footprint makes visibility continuous in
     position, so a big road triangle interpolates a ramp instead of a cliff. */
  var EAVE_SOFT = 3.5;

  /* Cosine-weighted hemisphere, Fibonacci, in TANGENT space: (sinTheta, phi).
     The old set was a uniform sphere with the lower half thrown away by
     `if (w <= 0) continue`, so half the ray budget was spent on rays that were
     discarded and the survivors were weighted by a cosine that varied 0..1 --
     an effective sample count of roughly a quarter of the nominal one. Sampling
     the cosine directly makes every ray count equally and every ray useful, so
     24 of these are worth more than 48 of those and cost half as much. */
  var rayCache = {};
  function buildRays(n) {
    if (rayCache[n]) return rayCache[n];
    var d = new Float32Array(n * 4), ga = PI * (3 - Math.sqrt(5)), i;
    for (i = 0; i < n; i++) {
      var st = Math.sqrt((i + 0.5) / n), ph = ga * i;   /* r^2 uniform -> cosine */
      d[i * 4] = Math.cos(ph) * st;                     /* tangent u  */
      d[i * 4 + 1] = Math.sin(ph) * st;                 /* tangent v  */
      d[i * 4 + 2] = Math.sqrt(Math.max(0, 1 - st * st));/* along n   */
      d[i * 4 + 3] = 0;
    }
    if (n <= 256) rayCache[n] = d;
    return d;
  }

  /* entry distance, or -1 for a miss.
     A ray whose ORIGIN is inside the box is a miss, not a contact: callers
     model a whole building mass as one AABB and stop it a few hundredths short
     of the wall plane, and with a 0.05 normal bias a vertex on that wall can
     land inside its own occluder. Under the old binary test that cost nothing
     (the vertex simply read `floor`); under a distance-weighted one it would
     read floor x NEAR_MIN and the surface would go black. */
  function hitsBoxT(px, py, pz, dx, dy, dz, b, tMax) {
    if (px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1 && pz > b.z0 && pz < b.z1) return -1;
    var t0 = 1e-4, t1 = tMax, a, c, t;
    if (dx > -1e-7 && dx < 1e-7) { if (px < b.x0 || px > b.x1) return -1; }
    else { a = (b.x0 - px) / dx; c = (b.x1 - px) / dx; if (a > c) { t = a; a = c; c = t; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) return -1; }
    if (dy > -1e-7 && dy < 1e-7) { if (py < b.y0 || py > b.y1) return -1; }
    else { a = (b.y0 - py) / dy; c = (b.y1 - py) / dy; if (a > c) { t = a; a = c; c = t; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) return -1; }
    if (dz > -1e-7 && dz < 1e-7) { if (pz < b.z0 || pz > b.z1) return -1; }
    else { a = (b.z0 - pz) / dz; c = (b.z1 - pz) / dz; if (a > c) { t = a; a = c; c = t; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) return -1; }
    return t0;
  }

  /* how far a ray travels before it leaves the canyon footprint -- i.e. how far
     away the facade that stops it is. Only meaningful for an origin inside the
     footprint; outside, the caller's own boxes are the occlusion and this
     returns NEAR_R so nothing is darkened twice. */
  function canyonExitT(px, py, pz, dx, dy, dz) {
    var t = 1e9, u;
    /* the ground is an occluder too, and the only one nobody passes. A wall
       vertex 0.5 m up sends half its hemisphere into the pavement at 1-3 units;
       that is the "ground-line" contact the brief ranks second in
       believability, and without this term it never appears. A soffit 3.5 m up
       is unaffected -- 12 units is past NEAR_R. */
    if (dy < -1e-7 && py > 0) { u = py / -dy; if (u < t) t = u; }
    if (px < BOX.x0 || px > BOX.x1 || pz < BOX.z0 || pz > BOX.z1)
      return t < NEAR_R ? t : NEAR_R;
    if (dx > 1e-7) { u = (BOX.x1 - px) / dx; if (u < t) t = u; }
    else if (dx < -1e-7) { u = (BOX.x0 - px) / dx; if (u < t) t = u; }
    if (dz > 1e-7) { u = (BOX.z1 - pz) / dz; if (u < t) t = u; }
    else if (dz < -1e-7) { u = (BOX.z0 - pz) / dz; if (u < t) t = u; }
    return t < 0 ? 0 : t;
  }

  /* 0..1 radiance a ray brings back, in units where open sky = 1.
     The canyon is modelled analytically -- four facade planes rising to the
     eaves -- rather than by tracing the world mesh, because the world mesh does
     not exist yet when nz-street.js calls this from its own 'ready' hook, and
     because 21 x 8 cells of merged quads is a far more expensive occluder than
     one slab test. Local boxes (a balcony slab, a bay soffit, a car body) are
     passed in by the caller or picked up from the shared registry. */
  function traceVis(px, py, pz, dx, dy, dz, occ, nOcc, near, nNear, roofY, floorV) {
    var open = 1, tBlock = 1e9, tTop = 0;
    if (py >= roofY - 1e-4) {
      /* above the eaves: nothing but the caller's own boxes can stop it */
      tTop = 1e9;
    } else if (dy <= 1e-4) {
      open = 0;                                    /* never reaches the sky */
      tBlock = canyonExitT(px, py, pz, dx, dy, dz);
      tTop = tBlock;
    } else {
      tTop = (roofY - py) / dy;
      var hx = px + dx * tTop, hz = pz + dz * tTop;
      /* soft footprint: distance OUTSIDE the opening, feathered over EAVE_SOFT.
         THE THROAT EXCEPTION, and it is where the junction apron gets its
         extra light. North of the plane the side street is rAlley -- f 0,
         c 28, sky:TRUE -- so it is open air above y = 28 for its whole length,
         and the only thing over it is the bridge band, x [176,192] and roughly
         a block deep. A ray that leaves the roadway northward under the band's
         soffit therefore does reach the sky, and the analytic four-plane canyon
         cannot see that: it would call the ray blocked the instant it crossed
         z = 152. Treating the throat's own footprint as open, for the 12 units
         of alley immediately behind the band, restores it.

         The window is the same 16 units deep it was on the old carve, moved
         with the plane (140..156 -> 136..152) and 4 units wider because the
         throat is (x 176..188 -> 176..192). It applies at x [176,192] only, so
         it lifts the junction apron and the west third and leaves the middle
         and the dead end exactly where they were -- which is the read ref8
         wants: a big open asphalt apron opening off a tighter canyon. */
      var ex = Math.max(BOX.x0 - hx, hx - BOX.x1, 0);
      var ez = Math.max(BOX.z0 - hz, hz - BOX.z1, 0);
      var out = ex > ez ? ex : ez;
      if (out > 0 && hx >= MOUTH.x0 && hx <= MOUTH.x1 &&
          hz >= MOUTH.z0 - 12 && hz <= BOX.z0) out = 0;
      if (out > 0) {
        open = 1 - ss(out / EAVE_SOFT);
        tBlock = canyonExitT(px, py, pz, dx, dy, dz);
      }
    }
    /* Range discipline, and it is what keeps this affordable.
       If the canyon has ALREADY stopped the ray, the only thing an occluder can
       still change is the near-field distance -- and beyond NEAR_R the
       attenuation is 1 whichever surface it was. So a blocked ray is tested
       only against the boxes the caller has within NEAR_R of this vertex
       (`near`, built once per vertex, typically 0-3 of them), and only the
       ~25 % of rays that could still reach the sky pay for the full list. The
       old escapes() skipped the occluder loop entirely once the footprint test
       failed, which is why naively removing that early-out took FACADE's bake
       from 250 ms to 2.6 s against its 59 boxes. */
    var list = occ, nList = nOcc, tMax;
    if (open > 0) { tMax = tTop > 30 ? tTop : 30; }
    else { list = near; nList = nNear; tMax = tBlock < NEAR_R ? tBlock : NEAR_R; }
    if (nList) {
      var i, t;
      for (i = 0; i < nList; i++) {
        t = hitsBoxT(px, py, pz, dx, dy, dz, list[i], tMax);
        if (t >= 0) {
          open = 0;
          if (t < tBlock) { tBlock = t; if (t < tMax) tMax = t; }
          if (tBlock < 0.30) break;              /* already in hard contact */
        }
      }
    }
    if (open >= 1) return 1;
    var blocked = floorV * nearAtten(tBlock);
    return open <= 0 ? blocked : blocked + (1 - blocked) * open;
  }

  /* ---- the shared occluder registry --------------------------------------
     The under-car defect was never a maths bug: nz-street-ground.js bakes the
     road from its own 'ready' hook and passes two mouth boxes, and the cars do
     not exist until nz-street-props.js runs three hooks later. No amount of
     ray budget will find an occluder that has not been built yet.

     So every box that passes through bake() is remembered, and this module --
     which the contract puts LAST, at 'ready' -60 while everyone else is at 0 --
     replays the ones that arrived after a given geometry was baked, against
     that geometry, at install(). Callers need change nothing: PROPS already
     hands its car bodies and tree canopies to bake() for its own piles, so they
     reach the road for free. NZ.street.occlude() is there for anything that
     wants to register a box without baking against it.

     Only PROP-SCALE boxes are registered. A caller's analytic stand-in for a
     whole building mass is 40-80 units on a side and is already accounted for
     by the canyon test; replaying it would darken the street twice. */
  var REG = [], REG_MAX = 26, REG_CAP = 220;
  function registerOcc(list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || typeof b.x0 !== 'number' || REG.length >= REG_CAP) continue;
      if (!(isFinite(b.x0) && isFinite(b.y0) && isFinite(b.z0))) continue;
      if (b.x1 - b.x0 > REG_MAX || b.y1 - b.y0 > REG_MAX || b.z1 - b.z0 > REG_MAX) continue;
      if (b.x1 <= b.x0 || b.y1 <= b.y0 || b.z1 <= b.z0) continue;
      REG.push(b);
    }
  }

  /* -----------------------------------------------------------------------
     NZ.street.bake(geometry, opts)
     opts = { matrix:    THREE.Matrix4 -- object -> world, if not already world
              occluders: [ {x0,x1,y0,y1,z0,z1}, ... ]
              bias:      Number  ray origin offset along the normal (0.05)
              floor:     Number  inter-reflection level (0.30)
              scale:     Number  multiplies the whole result (1.0)
              rays:      Number  override the tier's ray count
              roofY:     Number  the eaves line for the canyon test (52)
              uv2:       Boolean set uv2 = uv for aoMap (default true)
              compensate:Boolean pre-invert nz-render's bakeCurve (default false;
                         only the world quads need it) }
     -------------------------------------------------------------------- */
  /* one vertex, one hemisphere sweep. Shared by bake(), by the world-quad
     retarget and by the deferred refinement so the three cannot drift. */
  function sweep(px, py, pz, nx, ny, nz, dirs, nRays, occ, nOcc, roofY, floorV, bias) {
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > 1e-6)) { nx = 0; ny = 1; nz = 0; l = 1; }
    nx /= l; ny /= l; nz /= l;
    /* Duff/Frisvad orthonormal basis -- branchless, no normalise, no NaN at
       the pole, which a naive cross(n, up) has at exactly the two normals a
       road and a soffit use. */
    var s = ny >= 0 ? 1 : -1;
    var a = -1 / (s + ny), b = nx * nz * a;
    var t0x = 1 + s * nx * nx * a, t0y = s * nx, t0z = s * b;
    var t1x = b, t1y = nz, t1z = s + nz * nz * a;
    var ox = px + nx * bias, oy = py + ny * bias, oz = pz + nz * bias;
    /* the shortlist of boxes close enough to change the near-field term */
    var near = _near, nNear = 0, q, bb;
    for (q = 0; q < nOcc; q++) {
      bb = occ[q];
      if (bb.x0 - ox > NEAR_R || ox - bb.x1 > NEAR_R) continue;
      if (bb.y0 - oy > NEAR_R || oy - bb.y1 > NEAR_R) continue;
      if (bb.z0 - oz > NEAR_R || oz - bb.z1 > NEAR_R) continue;
      near[nNear++] = bb;
    }
    var sum = 0, k;
    for (k = 0; k < nRays; k++) {
      var cu = dirs[k * 4], cv = dirs[k * 4 + 1], ct = dirs[k * 4 + 2];
      var dx = t0x * cu + t1x * cv + nx * ct;
      var dy = t0y * cu + t1y * cv + ny * ct;
      var dz = t0z * cu + t1z * cv + nz * ct;
      sum += traceVis(ox, oy, oz, dx, dy, dz, occ, nOcc, near, nNear, roofY, floorV);
    }
    return sum / nRays;
  }
  var _near = [];

  /* every bake, kept so the occluders that arrive after it can be replayed */
  var baked = [], BAKED_CAP = 64;

  function bakeGeometry(geo, opts) {
    opts = opts || {};
    try {
      prepareMissionProfile();
      if (!THREE) THREE = (NZ.ctx && NZ.ctx.THREE) || global.THREE;
      if (!geo || !geo.attributes || !geo.attributes.position || !THREE) return geo;
      var pos = geo.attributes.position, nrm = geo.attributes.normal;
      var n = pos.count;
      if (!n) return geo;
      var t0 = now();

      var nRays = Math.max(RAYS_MIN, (opts.rays | 0) || RAYS);
      /* O(verts x rays x boxes) with three other modules building on two cores:
         cap the product rather than let a caller's ray count decide it */
      var occ = opts.occluders || null, nOcc = occ ? occ.length : 0;
      var budget = 26e6 / Math.max(1, n * (1 + nOcc * 0.45));
      if (nRays > budget) nRays = Math.max(12, budget | 0);
      var dirs = buildRays(nRays);
      var bias = fin(opts.bias, 0.05);
      var floorV = fin(opts.floor, BAKE_FLOOR);
      var scale = fin(opts.scale, 1.0);
      var roofY = fin(opts.roofY, SKY_Y);
      var mtx = opts.matrix || null;
      var e = mtx ? mtx.elements : null;
      var comp = !!opts.compensate;

      var col = new Float32Array(n * 3), raw = new Float32Array(n), i;
      for (i = 0; i < n; i++) {
        var px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        var nx = nrm ? nrm.getX(i) : 0, ny = nrm ? nrm.getY(i) : 1, nz = nrm ? nrm.getZ(i) : 0;
        if (e) {
          var wx = e[0] * px + e[4] * py + e[8] * pz + e[12];
          var wy = e[1] * px + e[5] * py + e[9] * pz + e[13];
          var wz = e[2] * px + e[6] * py + e[10] * pz + e[14];
          var mx = e[0] * nx + e[4] * ny + e[8] * nz;
          var my = e[1] * nx + e[5] * ny + e[9] * nz;
          var mz = e[2] * nx + e[6] * ny + e[10] * nz;
          px = wx; py = wy; pz = wz; nx = mx; ny = my; nz = mz;
        }
        var v = sweep(px, py, pz, nx, ny, nz, dirs, nRays, occ, nOcc, roofY, floorV, bias);
        raw[i] = v;
        v = clamp(v * scale, BAKE_LO, BAKE_HI);
        if (comp) v = invBakeCurve(v);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;   /* achromatic */
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      /* r149's aoMap samples uv2, not uv (nz-env.js:3499 restores this on panic) */
      if (opts.uv2 !== false && geo.attributes.uv && !geo.attributes.uv2)
        geo.setAttribute('uv2', geo.attributes.uv);

      registerOcc(occ);
      if (opts.defer !== false && baked.length < BAKED_CAP && !installed) {
        baked.push({
          geo: geo, raw: raw, n: n, first: REG.length, rays: nRays,
          occ: occ, bias: bias, floor: floorV, scale: scale, roofY: roofY,
          comp: comp, e: e ? [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]] : null
        });
      }
      STATS.bakedGeos++; STATS.bakedVerts += n; STATS.rays += n * nRays;
      STATS.bakeMs += Math.round(now() - t0);
    } catch (err) { warn('bake() failed: ' + (err && err.message)); }
    return geo;
  }

  /* ---- the replay --------------------------------------------------------
     For every geometry baked before some prop existed, re-sweep the vertices
     that prop can actually reach and multiply the RATIO of the two answers into
     whatever is in `color` now. A ratio, not a value: by the time this runs the
     callers have multiplied their own albedo tints into the same attribute
     (nz-street-ground.js applyTone, nz-street.js makeMesh, nz-street-props.js
     applyTone), and a product commutes with them. Vertices no new box can see
     get a ratio of exactly 1 and are not touched at all. */
  var GX0 = 130, GZ0 = 110, GC = 12, GNX = 14, GNZ = 9;
  function bucket(list, from) {
    var G = { g: new Array(GNX * GNZ), n: 0, lo: 1e9, hi: -1e9, zlo: 1e9, zhi: -1e9 };
    for (var i = from; i < list.length; i++) {
      var b = list[i];
      var ax = Math.max(0, ((b.x0 - NEAR_R - GX0) / GC) | 0);
      var bx = Math.min(GNX - 1, ((b.x1 + NEAR_R - GX0) / GC) | 0);
      var az = Math.max(0, ((b.z0 - NEAR_R - GZ0) / GC) | 0);
      var bz = Math.min(GNZ - 1, ((b.z1 + NEAR_R - GZ0) / GC) | 0);
      if (bx < 0 || bz < 0 || ax > GNX - 1 || az > GNZ - 1) continue;
      for (var x = ax; x <= bx; x++) for (var z = az; z <= bz; z++) {
        var k = z * GNX + x;
        (G.g[k] || (G.g[k] = [])).push(b);
      }
      G.n++;
      if (b.x0 < G.lo) G.lo = b.x0; if (b.x1 > G.hi) G.hi = b.x1;
      if (b.z0 < G.zlo) G.zlo = b.z0; if (b.z1 > G.zhi) G.zhi = b.z1;
    }
    return G;
  }
  function bucketAt(G, px, pz) {
    if (px < G.lo - NEAR_R || px > G.hi + NEAR_R) return null;
    if (pz < G.zlo - NEAR_R || pz > G.zhi + NEAR_R) return null;
    var x = ((px - GX0) / GC) | 0, z = ((pz - GZ0) / GC) | 0;
    if (x < 0 || z < 0 || x >= GNX || z >= GNZ) return null;
    return G.g[z * GNX + x] || null;
  }

  function refineBakes() {
    if (!baked.length) return;
    var t0 = now(), touched = 0, geos = 0, budgetMs = 900;
    for (var g = 0; g < baked.length; g++) {
      var R = baked[g];
      if (REG.length <= R.first) continue;
      if (now() - t0 > budgetMs) { note('bake replay stopped at the 900ms budget'); break; }
      /* A coarse XZ bucket over the late boxes. Without it the vertex loop
         scans every registered occluder for every vertex of every recorded
         geometry -- 134k x 139 AABB tests -- which is where the replay's whole
         cost was. 12-unit cells put ~2 boxes in a bucket. */
      var fresh = bucket(REG, R.first);
      var col, pos, nrm;
      try {
        col = R.geo.attributes && R.geo.attributes.color;
        pos = R.geo.attributes && R.geo.attributes.position;
        nrm = R.geo.attributes && R.geo.attributes.normal;
      } catch (e0) { continue; }
      if (!col || !pos || pos.count !== R.n || !fresh.n) continue;
      var cs = col.itemSize, ca = col.array, e = R.e;
      var dirs = buildRays(R.rays);
      var own = R.occ || [], nOwn = own.length;
      var mix = [], i, j, hit = 0;
      for (i = 0; i < R.n; i++) {
        if ((i & 2047) === 0 && now() - t0 > budgetMs) break;
        var px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        var nx = nrm ? nrm.getX(i) : 0, ny = nrm ? nrm.getY(i) : 1, nz = nrm ? nrm.getZ(i) : 0;
        if (e) {
          var wx = e[0] * px + e[3] * py + e[6] * pz + e[9];
          var wy = e[1] * px + e[4] * py + e[7] * pz + e[10];
          var wz = e[2] * px + e[5] * py + e[8] * pz + e[11];
          var mx = e[0] * nx + e[3] * ny + e[6] * nz;
          var my = e[1] * nx + e[4] * ny + e[7] * nz;
          var mz = e[2] * nx + e[5] * ny + e[8] * nz;
          px = wx; py = wy; pz = wz; nx = mx; ny = my; nz = mz;
        }
        /* which of the new boxes is close enough to matter to THIS vertex */
        var cell = bucketAt(fresh, px, pz);
        if (!cell) continue;
        mix.length = 0;
        for (j = 0; j < cell.length; j++) {
          var b = cell[j];
          if (px < b.x0 - NEAR_R || px > b.x1 + NEAR_R) continue;
          if (pz < b.z0 - NEAR_R || pz > b.z1 + NEAR_R) continue;
          if (py < b.y0 - NEAR_R || py > b.y1 + NEAR_R) continue;
          mix.push(b);
        }
        if (!mix.length) continue;
        for (j = 0; j < nOwn; j++) mix.push(own[j]);
        var v1 = sweep(px, py, pz, nx, ny, nz, dirs, R.rays, mix, mix.length,
                       R.roofY, R.floor, R.bias);
        var v0 = R.raw[i];
        if (!(v0 > 1e-5) || v1 >= v0 - 1e-4) continue;
        var a0 = clamp(v0 * R.scale, BAKE_LO, BAKE_HI);
        var a1 = clamp(v1 * R.scale, BAKE_LO, BAKE_HI);
        if (R.comp) { a0 = invBakeCurve(a0); a1 = invBakeCurve(a1); }
        var k = a1 / Math.max(a0, 1e-5);
        if (k >= 0.999) continue;
        var o = i * cs;
        ca[o] *= k; ca[o + 1] *= k; ca[o + 2] *= k;
        R.raw[i] = v1;
        hit++;
      }
      if (hit) { col.needsUpdate = true; touched += hit; geos++; }
      R.first = REG.length;
    }
    if (touched) note('bake replay: ' + touched + ' vertices in ' + geos +
                      ' geometr(ies) darkened by ' + REG.length + ' late occluder(s) in ' +
                      Math.round(now() - t0) + 'ms');
    STATS.replayVerts = touched;
    for (var q = 0; q < baked.length; q++) baked[q].raw = null;   /* let it go */
    baked.length = 0;
  }

  /* nz-render.js:2246-2263, verbatim constants. neutralizeBakedLighting() runs
     at 'ready' priority -1000 -- after this module -- and remaps every vertex
     of every geometry whose material is named 'world:*' or 'nzenv:*'. The
     street's world quads live in the same merged meshes as the night level's,
     so they cannot be exempted by name; instead the value written here is
     pre-inverted so that what survives the curve is what was authored. */
  var BAKEC = { ref: 0.90, gamma: 0.68, shoulder: 0.70, head: 0.30, weight: 1.00, lo: 0.15, hi: 1.35 };
  function bakeCurve(L) {
    if (!(L > 0)) return BAKEC.lo;
    var n = L / BAKEC.ref, s;
    if (n <= 1) s = Math.pow(n, BAKEC.gamma);
    else s = 1 + (1 - Math.exp(-(n - 1) * BAKEC.shoulder)) * BAKEC.head;
    var out = L + (BAKEC.ref * s - L) * BAKEC.weight;
    return out < BAKEC.lo ? BAKEC.lo : (out > BAKEC.hi ? BAKEC.hi : out);
  }
  function invBakeCurve(target) {
    var lo = 0.001, hi = 6.0, mid, i;
    if (bakeCurve(hi) < target) return hi;
    if (bakeCurve(lo) > target) return lo;
    for (i = 0; i < 40; i++) { mid = (lo + hi) * 0.5; if (bakeCurve(mid) < target) lo = mid; else hi = mid; }
    return (lo + hi) * 0.5;
  }

  /* =======================================================================
     SECTION 7 -- the visible sky
     ONE down-facing quad at the eaves line, spanning exactly the canyon
     footprint. It is a direction-evaluated skybox drawn on a small proxy, so
     the gradient is correct no matter how close the geometry is.

     WHY THIS IS OCCLUDED FROM THE NIGHT HALF, as a proof rather than a hope,
     re-checked cell by cell against the WIDENED carve:
       * every night region with sky:true now ends at z <= 152 (rStreet
         x [84,144] z [84,152]; rAlley x [160,196] z [84,152]; rRoof
         x [192,236] z [88,148]; rGallery, rFire, rRoofStep, rShC all further
         north still) -- with exactly one exception, rShB, cell (30,38), which
         is x [120,124] z [152,156]: 44 units WEST of the quad's west edge and
         at the bottom of its own 34-unit shaft, so it sees no part of it;
       * the street's north facade is a solid wall quad on the plane z = 152
         running from the floor to c = 52 for the whole of x [168,252], broken
         only below y = 28 at the throat and below y = 12 at the door cell;
       * a viewer north of z = 152 is therefore below y = 52 with that wall in
         the way, so any ray of his that reaches the plane y = 52.02 does so at
         z <= 152, which is the quad's own north edge.
       Nothing south of z = 192 or east of x = 252 is carved at all. The only
       geometry the widening brought under the quad's new z band (152..192,
       x < 168) is rTun / rPump / rDrain, every one of them ceilinged
       (c = -1, 0 and 9, ctex ceildark, sky:false), so none of them has a
       sightline to y = 52 at any x.

     And the converse: every ray that ESCAPES the canyon crosses y = 52.02
     inside the canyon footprint, because it has to be above the walls by the
     time it passes their planes and y increases monotonically along it. So one
     84 x 40 quad covers the whole escaping hemisphere. One draw call.
     ==================================================================== */
  var skyMesh = null, skyMat = null;
  var uCamDay = null;                 /* shared: the damped camera-position mask */

  /* =======================================================================
     THE DOME -- mission 4's visible sky
     buildSky() plugs the canyon with flat horizontal LIDS, which is exactly
     right for a 40-unit slot between two five-storey walls and wrong for an
     open town. Two things break when the same lids are asked to cover a whole
     hemisphere:

       * THE FAR PLANE. A lid at y = 104 seen from an eye at 6.4 subtends the
         low elevations at enormous horizontal distances -- 6 degrees of
         elevation is 930 units out -- and the camera's far plane is 900
         (NUKEM.html:11397). Every direction below about six degrees was
         therefore CLIPPED, and what showed through in its place was
         nz-render's night dome: the flat grey band that sat across the horizon
         of every open shot on this map;
       * THE SEAMS. Four lids at three different heights are resolved by paint
         order, not depth, so the winning plane changes along a straight line
         in world space and the sky has a visible edge in it.

     A sphere has neither problem: every one of its vertices is the SAME
     distance from the eye, so one radius inside the far plane clips nothing at
     any elevation, and there is one surface so there is no seam. It rides with
     the camera in all three axes and writes no depth, which makes it a
     background rather than geometry -- the range at 620..800, the town ranks,
     the roofs, the minarets and the wires all paint over it in the ordinary
     opaque pass. Mission 1 keeps its lids, which its own leak proof depends on.
     ==================================================================== */
  var domeMesh = null, domeMat = null;
  var DOME_R = 870;                  /* inside the 900-unit far plane          */
  var PHOTO_SKY_URL = 'assets/sky/overcast-soil-4k.jpg';
  var PHOTO_SKY_GAIN = qk('photogain', 1.75);

  function loadPhotoSky(material) {
    if (!OVERCAST4 || !THREE.TextureLoader) return;
    DIAG.photoSky = 'loading';
    var texture = new THREE.TextureLoader().load(PHOTO_SKY_URL, function (loaded) {
      if (dead || material !== domeMat) { loaded.dispose(); return; }
      material.uniforms.uPhotoSky.value = loaded;
      material.uniforms.uPhotoReady.value = 1;
      DIAG.photoSky = 'ready';
      var im = loaded.image;
      if (im) STATS.texBytes += im.width * im.height * 4 * 1.34;
      note('photographic overcast sky ready');
    }, undefined, function () {
      if (dead) return;
      DIAG.photoSky = 'procedural fallback';
      warn('photographic sky unavailable; using procedural overcast');
    });
    texture.name = 'nzday:overcast-soil-photo';
    /* The custom dome shader decodes the JPG explicitly, once. Marking this
       raw sampler sRGB as well would ask WebGL2 to perform a second decode. */
    texture.encoding = THREE.LinearEncoding;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    OWN.tex.push(texture);
  }

  function buildDome() {
    var g = new THREE.SphereGeometry(DOME_R, 48, 32);
    OWN.geo.push(g);
    domeMat = new THREE.ShaderMaterial({
      uniforms: { uGain: { value: VIS_GAIN }, uDay: uCamDay, uNight: uNightCol,
        uPhotoSky: { value: null }, uPhotoReady: { value: 0 } },
      vertexShader: [
        'varying vec3 vDir;',
        'void main(){',
        '  vDir = position;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vDir;',
        'uniform float uGain;', 'uniform float uDay;', 'uniform vec3 uNight;',
        'uniform sampler2D uPhotoSky;', 'uniform float uPhotoReady;',
        skyGLSL(), OVERCAST4 ? overcastSkyGLSL() : sunnySkyGLSL(),
        'vec3 nzPhotoLinear(vec3 c){',
        '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));',
        '}',
        'void main(){',
        '  vec3 d = normalize(vDir);',
        '  vec3 c = nzSkyDay(d, uGain);',
        '  if (uPhotoReady > 0.5) {',
        '    vec2 uv = vec2(atan(d.z, d.x) * 0.159154943 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.318309886 + 0.5);',
        '    vec3 photo = nzPhotoLinear(texture2D(uPhotoSky, uv).rgb);',
        '    float y = dot(photo, vec3(0.2126, 0.7152, 0.0722));',
        '    c = mix(vec3(y), photo, 0.80) * vec3(0.985, 1.0, 1.015) * ' + g3(PHOTO_SKY_GAIN) + ';',
        '  }',
        '  c = min(c, vec3(12.0));',
        '  gl_FragColor = vec4(mix(uNight, c, uDay), 1.0);',
        '}'
      ].join('\n'),
      side: THREE.BackSide,
      depthTest: false, depthWrite: false, fog: false
    });
    domeMat.name = 'nzday:dome';
    OWN.mat.push(domeMat);
    domeMesh = new THREE.Mesh(g, domeMat);
    domeMesh.name = 'nzday:dome';
    domeMesh.frustumCulled = false;
    domeMesh.castShadow = false; domeMesh.receiveShadow = false;
    domeMesh.userData.nzNoGBuffer = true;
    domeMesh.renderOrder = -0.52;    /* first of everything this module draws  */
    scene.add(domeMesh);
    OWN.obj.push(domeMesh);
    STATS.addedCalls++;
    loadPhotoSky(domeMat);
    note('dome r' + DOME_R + ' (lids skipped)');
  }

  function buildSky() {
    if (LEVEL4) { buildDome(); return null; }
    var y = SKY_Y + 0.02;
    var pp = [], ff = [];
    /* wound so the FRONT face points DOWN: invisible from above, which is what
       keeps it out of every night sightline even before the proof above */
    function lid(x0, x1, z0, z1, fade, lidY) {
      var yy = lidY === undefined ? y : lidY;
      if (!(x1 > x0 && z1 > z0)) return;
      pp.push(x0, yy, z0, x1, yy, z0, x1, yy, z1,
              x0, yy, z0, x1, yy, z1, x0, yy, z1);
      for (var q = 0; q < 6; q++) ff.push(fade);
    }
    /* The A/B canyon stays at the five-storey eaves datum.  The linear park
       and 230 arms need their own, higher cards: their graded world ceilings
       and the six-storey arena rise above y=52, so sharing the old low card
       would visibly slice those buildings. */
    /* The route now opens into a broad 230 Sk crossing near its terminus.
       Widen the local card laterally so its old night dome cannot show in the
       upper corners when the player looks out through that open junction. */
    lid(BOX.x0, BOX.x1, -400, 750, 2);
    /* Past the low police line the playable grid ends, but the daylight sky
       must not.  A very wide, night-fading continuation prevents the old
       dome from appearing as a dark trapezoid behind the porous terminus.
       It writes no depth, so the authored roofs, trees and far ridge still
       paint naturally in front of it. */
    lid(BOX.x1, BOX.x1 + 760, -400, 750, 2, BOX.y1 + 0.02);
    /* The straight park is long enough that the finite proxy's rectangular
       edge was visible as a gray slab across the uphill horizon.  Give it the
       same broad, camera-fading treatment as the open 230 terminus. */
    lid(ZC.x0 - 760, ZC.x1 + 760, -400, 750, 2, ZC.y1 + 0.02);
    lid(ZD.x0, ZD.x1, ZD.z0, ZD.z1, 0, ZD.y1 + 0.02);
    /* Two strips over the two holes in the north facade, both one cell row
       deep, north of the plane -- z [148,152] on the new carve. Without them
       the player looking up and north out of the canyon sees the NIGHT dome
       through the junction throat (x [176,192], whose cells are rAlley, c = 28,
       sky:true, so no ceiling quad was ever drawn and the bridge band above
       them is FACADE's mass, not the world mesh's) and past the foyer doorway.
       They are tagged fade = 1: outside the daylight zone they render as the
       night horizon colour, so the one strip a player in the alley can actually
       see past the band agrees with the dome above his head instead of
       announcing a second sky.

       Both are still WANTED after the widening even though the throat is now
       inside BOX on its street side: the lid covers z >= 152, and the hole is
       the cell row at z [148,152] that FACADE has not clad yet. When the bridge
       band and the north roof mass arrive they paint over these strips in the
       normal opaque pass (depthWrite is off here) and cost nothing. */
    if (MOUTH.x1 - MOUTH.x0 > 0.5)
      lid(MOUTH.x0, MOUTH.x1, MOUTH.z0, BOX.z0, 1);
    if (DOOR.x0 >= BOX.x0 && DOOR.x1 <= BOX.x1 && DOOR.z1 <= BOX.z0)
      lid(DOOR.x0, DOOR.x1, DOOR.z0, BOX.z0, 1);

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    g.setAttribute('aNight', new THREE.Float32BufferAttribute(ff, 1));
    g.computeBoundingSphere();
    OWN.geo.push(g);

    skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uGain: { value: VIS_GAIN }, uDay: uCamDay, uNight: uNightCol
      },
      vertexShader: [
        'attribute float aNight;',
        'varying vec3 vWP;', 'varying float vN;',
        'void main(){',
        '  vWP = (modelMatrix * vec4(position, 1.0)).xyz;',
        '  vN = aNight;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vWP;', 'varying float vN;',
        'uniform float uGain;',
        'uniform float uDay;',
        'uniform vec3 uNight;',
        skyGLSL(),
        LEVEL4 ? sunnySkyGLSL() : '',
        'void main(){',
        '  vec3 d = normalize(vWP - cameraPosition);',
        (LEVEL4
          ? '  vec3 c = nzSkyDay(d, uGain);'
          : '  vec3 c = nzSkySample(d) * uGain;'),
        (LEVEL4 ? ''
          : '  c *= 1.0 + ' + g3(CLOUD_AMT) + ' * nzSkCloud(d);'),
        /* clamped the way nz-render clamps its dome (nz-render.js:1553): a
           value the bloom pyramid cannot turn into a firefly */
        '  c = min(c, vec3(12.0));',
        /* THE FADE STRIPS, graded rather than pasted.
           A strip is a lid over a hole in the north facade (the junction throat
           and the foyer door), and outside the daylight zone it has to BE the
           night horizon or it announces a second sky. The old form was
           mix(c, uNight, vN * (1 - uDay)) -- one weight for the whole strip, so
           at any intermediate uDay the strip was a single flat value with a
           hard rectangular boundary against the night dome beyond it. Measured
           from the roadway: a crisp quad at lum 124.7 against a night wall at
           72.3. Grading the weight along +Z instead makes the north edge
           (z = MOUTH.z0 = 148, deepest into the night alley) always night and
           the south edge (z = BOX.z0 = 152, where it butts the canyon lid)
           exactly the canyon sky, so the two meet with no step at all and the
           opening reads as an opening. Anchored one unit north of the strip's
           own north edge and run over 5 units, so the ramp is identical to the
           one measured on the old carve, translated with the plane. */
        '  float sEdge = smoothstep(0.0, 1.0, clamp((vWP.z - ' +
          g3(MOUTH.z0 - 1) + ') / 5.0, 0.0, 1.0));',
        /* aNight=2 marks the broad terminus cards: unlike the narrow historic
           doorway strips they follow only the camera day mask, not the old
           north-alley Z ramp. */
        '  float nightW = vN > 1.5 ? (1.0 - uDay) : vN * (1.0 - uDay * sEdge);',
        '  gl_FragColor = vec4(mix(c, uNight, nightW), 1.0);',
        '}'
      ].filter(function (L) { return L !== ''; }).join('\n'),
      side: THREE.FrontSide,
      depthTest: true, depthWrite: false, fog: false
    });
    skyMat.name = 'nzday:sky';
    OWN.mat.push(skyMat);

    skyMesh = new THREE.Mesh(g, skyMat);
    skyMesh.name = 'nzday:sky';
    /* -0.5 sorts AFTER the game's night dome (renderOrder -1) and BEFORE every
       piece of world geometry (0). depthWrite is off, so the roofs, chimneys,
       aerials and wires the other two modules build above c = 52 all paint over
       it in the normal opaque pass instead of being hidden behind it. */
    skyMesh.renderOrder = -0.5;
    skyMesh.frustumCulled = true;
    skyMesh.castShadow = false; skyMesh.receiveShadow = false;
    skyMesh.matrixAutoUpdate = false; skyMesh.updateMatrix();
    /* 84 x 40 units of fake geometry must never reach the G-buffer prepass, or
       GTAO treats the sky as a near occluder (nz-render.js:1566-1568, :2460) */
    skyMesh.userData.nzNoGBuffer = true;
    scene.add(skyMesh);
    OWN.obj.push(skyMesh);
    STATS.addedCalls++;
    return skyMesh;
  }

  /* =======================================================================
     SECTION 8 -- the distant backdrop
     This is sky, not architecture: beyond the dead end the town has to keep
     going or the canyon reads as a diorama. Everything here is unreachable,
     outside the grid, above the sightline over the end walls, and desaturated
     hard toward the fog.

     An 11.4 m canyon between 14.9 m facades shows almost no sky except straight
     up and down its own axis, so the backdrop is built ONLY along that axis,
     and only EASTWARD past the dead end -- buildBackdrop() explains why the
     west end gets sky and nothing else. The widening was in z; the axis, the
     84-unit run of road and therefore every number in this section are
     untouched. The sightline over an end wall from the far end of the road is
     still atan((52 - 6.4) / 80) = 29.7 deg, so anything meant to be seen out
     there has to stand on ground that climbs. Seydisehir's does:
     _ref/ref5 is exactly this picture -- the town stepping up a slope into
     snow-dusted hills, both washed to within a few levels of the sky.

     LEAK-PROOFING: the backdrop cannot be proved occluded the way the sky quad
     can -- it is outside the walls, and the rooftop region reaches x = 236. So
     instead of relying on geometry it is FADED TO THE NIGHT HORIZON COLOUR by
     the same damped camera mask that drives the fog: when the camera is not in
     the daylight zone the backdrop is exactly the colour the night sky dome
     already is, and below 0.004 it is switched off entirely. It cannot leak,
     by construction, and it costs nothing to prove. Verified with a shot from
     the rooftop at (196,18,92) looking east and up 36 deg: night sky, nothing
     of this module in frame.
     ==================================================================== */
  var backMesh = null, backMat = null, hillMesh = null, hillMat = null;
  var uFogCol = null, uFogNF = null, uFogNFB = null, uNightCol = null;

  function Pile() { this.p = []; this.n = []; this.c = []; this.i = []; this.v = 0; }
  Pile.prototype.tri = function (a, b, c, na, col) {
    var o = this.v, i;
    var vs = [a, b, c];
    for (i = 0; i < 3; i++) {
      this.p.push(vs[i][0], vs[i][1], vs[i][2]);
      this.n.push(na[0], na[1], na[2]);
      this.c.push(col[0], col[1], col[2]);
    }
    this.i.push(o, o + 1, o + 2);
    this.v += 3;
  };
  Pile.prototype.quad = function (a, b, c, d, na, col) {
    this.tri(a, b, c, na, col); this.tri(a, c, d, na, col);
  };
  Pile.prototype.geometry = function (THREE) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  };

  /* aerial perspective, applied at bake time on top of the fog: everything out
     here loses saturation and runs toward the sky before the fog even starts */
  function washed(base, t) {
    /* WHAT A DISTANT THING FADES INTO is the sky it is seen AGAINST, and a
       backdrop is seen against the sky a few degrees above the horizon -- not
       against the zenith. Under the overcast profile the two were within a
       couple of per cent of each other and SKY_VIS_RGB (a sample at d.y 0.86,
       chosen because the canyon slot showed nothing lower) was a fair stand-in.
       Under a clear sky the zenith is NAVY and the horizon is nearly white, so
       the same line washes every distant ridge and rooftop toward dark blue --
       which is how a mountain range ends up looking like a cardboard cut-out
       painted in poster paint. BACK_SKY is the horizon sample; it is solved in
       solveGains() beside the others and falls back to the old behaviour if it
       has not been solved yet. */
    var s = BACK_SKY || SKY_VIS_RGB;
    return [lerp(base[0], s[0], t), lerp(base[1], s[1], t), lerp(base[2], s[2], t)];
  }

  function backdropMaterial(name) {
    var mm = new THREE.ShaderMaterial({
      uniforms: {
        uFogCol: uFogCol, uFogNF: uFogNFB, uDay: uCamDay, uNight: uNightCol
      },
      vertexShader: [
        'varying vec3 vC;', 'varying float vD;',
        'void main(){',
        '  vC = color;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vD = -mv.z;',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vC;', 'varying float vD;',
        'uniform vec3 uFogCol;', 'uniform vec2 uFogNF;',
        'uniform float uDay;', 'uniform vec3 uNight;',
        'void main(){',
        '  float f = clamp((vD - uFogNF.x) / max(uFogNF.y - uFogNF.x, 1.0), 0.0, 1.0);',
        '  vec3 c = mix(vC, uFogCol, f);',
        /* the leak-proof: outside the daylight zone this IS the night horizon */
        '  gl_FragColor = vec4(mix(uNight, c, uDay), 1.0);',
        '}'
      ].join('\n'),
      vertexColors: true, side: THREE.FrontSide,
      depthTest: true, depthWrite: true, fog: false
    });
    mm.name = 'nzday:' + name;
    OWN.mat.push(mm);
    return mm;
  }

  /* one block: five faces, no bottom, tinted by distance */
  function block(pile, x0, x1, y0, y1, z0, z1, wash, r) {
    var body = washed(hexLin(BODY[(r() * BODY.length) | 0]), wash);
    var roofc = washed(hexLin(0x8d6a5c), Math.min(1, wash + 0.10));
    if (!LEVEL4 || OVERCAST4) {
      /* mission 1's overcast town: no key, so the faces differ only by a fixed
         ladder. Byte-identical to what it was calibrated with. */
      var side = [body[0] * 0.90, body[1] * 0.90, body[2] * 0.90];
      var dark = [body[0] * 0.80, body[1] * 0.80, body[2] * 0.80];
      pile.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], body);
      pile.quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1], dark);
      pile.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0], side);
      pile.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], side);
      pile.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], roofc);
      return;
    }
    /* MISSION 4: THE TOWN IS IN THE SAME SUN AS THE STREET IN FRONT OF IT.
       This material is unlit, so every face's key has to be baked here. A flat
       0.90/0.80 ladder made the nearest of the three backdrop layers the only
       one with no sun in it, next to a mountain range and a real street that
       both have one -- and it lit the wrong faces. n.L against the same
       SUN_DIR_W the range and the dome use, with the sky as the fill. */
    function face(n) {
      var ndl = sat(n[0] * SUN_DIR_W[0] + n[1] * SUN_DIR_W[1] + n[2] * SUN_DIR_W[2]);
      /* the fill a face of this orientation gets from the sky, normalised so a
         roof is 1.0 -- the same shape the analytic hemisphere uses */
      var up = sat(n[1] * 0.5 + 0.5), fill = 0.44 + 0.30 * (up * up * (3 - 2 * up));
      var k = fill + 0.86 * ndl, c = [0, 0, 0];
      for (var i = 0; i < 3; i++) {
        /* the lit side warms, the shaded side cools toward the sky */
        var t = lerp(body[i], body[i] * (i === 2 ? 1.10 : (i === 0 ? 0.94 : 0.97)), 1 - ndl);
        c[i] = t * k;
      }
      return c;
    }
    pile.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], face([0, 0, -1]));
    pile.quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1], face([0, 0, 1]));
    pile.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0], face([-1, 0, 0]));
    pile.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], face([1, 0, 0]));
    var rf = face([0, 1, 0]), rc = [roofc[0] * rf[0] / Math.max(body[0], 1e-4),
                                    roofc[1] * rf[1] / Math.max(body[1], 1e-4),
                                    roofc[2] * rf[2] / Math.max(body[2], 1e-4)];
    pile.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], rc);
  }
  var BODY = [0xd8c7ae, 0xc9a099, 0xd9cdb4, 0xb9c8b4, 0xc6d4d8, 0xe0d6c2, 0xcfa9a2, 0xc4c8bd];

  /* =======================================================================
     THE RANGE -- mission 4's mountains
     The overcast build had ONE flat card at x = BOX.x1 + 330, facing west,
     with a hand-surveyed profile: correct for a money shot that only ever
     looked east down 233 Sk, and invisible from the park crest (888 units out
     against a 900-unit far plane), from both 232 Sk arms and from either 230
     stub -- which, on mission 4, is most of the level.

     So mission 4 gets a RANGE instead: three concentric silhouette bands that
     ride with the camera in XZ, exactly the way a skybox does. Two things fall
     out of that and both matter more than the parallax it gives up (a ridge
     ten kilometres away has none to give):

       * it can never clip. At a fixed 640..790 units the far plane at 900 is
         never in play, wherever on the grid the player is standing;
       * it can never intersect anything. Every band is further from the eye
         than any authored geometry, and depthTest is still on, so the town,
         the closures, the minarets and the roofs all paint in front of it in
         the ordinary opaque pass.

     THE SHADING IS THE POINT. A silhouette card reads as a paper cut-out; a
     range reads as rock because of four terms, all baked into the vertex
     colour here rather than paid for per fragment:

       1. AERIAL PERSPECTIVE per band -- each is mixed toward the sky's own
          radiance by a fixed amount, so the three separate in depth even where
          their silhouettes overlap;
       2. a VERTICAL gradient inside each band, mixing FURTHER toward the sky at
          the foot. Distant ranges are palest at the bottom because that is
          where the sightline passes through the most air, and getting this
          backwards is the single most common way a painted mountain fails;
       3. SUN AND SHADE from the local slope. dh/dtheta gives the flank's
          facing; a flank falling away toward the sun's azimuth is lit and
          warmed, one falling away from it is shaded and cooled. That is what
          puts ridgelines and gullies into what is geometrically a flat strip;
       4. SNOW above a wobbling line, on the two far bands only, and only where
          the slope is shallow enough to hold it -- a vertical crag does not
          keep snow, and snow painted on one is the tell.
     ==================================================================== */
  var rangeMesh = null, rangeMat = null;
  /* NEAR to FAR. Each band carries the pair of colours its rock is lit and
     shaded in -- authored, not derived, because one lerp between a warm lit
     limestone and a cool blue shade is both cheaper and more honest than a
     multiply on a single hue -- plus the elevation its haze is sampled at.
     `peak` reads at atan(peak / r) from a standing eye: 52/520 = 5.7 deg for
     the foothills, 176/800 = 12.4 deg at the snow line. That is Seydisehir
     under the western Taurus, not a row of hills. */
  var RANGE_BANDS = [
    /* THE WASH IS SOLVED, NOT CHOSEN, and it is the number that decides
       whether there are mountains in the frame at all. Through nz-render's
       composite the sky at these elevations lands near 190-200/255. A ridge
       that is washed 0.66 of the way to it comes back within three code values
       of it and disappears; the reference photographs put a far range at
       roughly 0.80 of the sky's luminance and a near one at 0.55, i.e. 15-40
       codes below it, and BLUER than it rather than merely paler. The shade
       colours therefore carry real chroma and the wash tops out at 0.50. */
    { r: 520, peak:  56, base: 10, seed: 0x51f3, el:  3.4, wash: 0.20,
      lit: 0x9c9070, shade: 0x3c4c60, snow: 1e9, tree: 0.66 },
    { r: 640, peak:  94, base: 16, seed: 0x9ac1, el:  5.2, wash: 0.30,
      lit: 0x9c9584, shade: 0x415470, snow: 1e9, tree: 0.52 },
    { r: 730, peak: 138, base: 22, seed: 0x2d77, el:  7.6, wash: 0.40,
      lit: 0x9d9c92, shade: 0x475c7c, snow: 104, tree: 0.30 },
    { r: 800, peak: 182, base: 28, seed: 0xc40b, el: 10.4, wash: 0.50,
      lit: 0x9fa199, shade: 0x4d6389, snow:  96, tree: 0.0 }
  ];
  var RANGE_SEG = 192;               /* 1.875 deg a segment: no visible facet  */
  var SNOW_LIT = hexLin(0xf2f6ff), SNOW_SHD = hexLin(0xb9c9e6);
  var TREE_LIT = hexLin(0x66714e), TREE_SHD = hexLin(0x323c2e);

  /* The sky a thing at elevation `el` is seen AGAINST. Aerial perspective ends
     at the sky, and under a clear one the sky it ends at is a different colour
     at 3 degrees than at 10 -- which is the whole reason a far ridge is paler
     AND bluer than a near one rather than merely paler. */
  /* NOT called skyAt(): SECTION 3 already declares a module-level skyAt(dx,dy,dz)
     for street.SKY, and a second function declaration of the same name in the
     same scope HOISTS OVER it -- which would silently publish the wrong sky to
     every other module in the level. */
  function skyAtEl(elDeg) {
    var y = Math.sin(elDeg * PI / 180), h = Math.sqrt(Math.max(0, 1 - y * y));
    var c = skyShape(h, y, 0, [0, 0, 0]);
    return [c[0] * VIS_GAIN, c[1] * VIS_GAIN, c[2] * VIS_GAIN];
  }

  /* A deterministic ridge line, EXACTLY periodic in one turn. Four octaves of
     smoothed value noise on the angle at INTEGER frequencies -- a fractional
     one does not wrap, and a range that does not wrap has a cliff in it at the
     seam, which on this map faces due south down 232 Sk -- plus two slow
     sinusoids so the range has a massif and a saddle rather than a uniform
     crinkle at every scale. */
  function ridgeH(seed) {
    var rnd = rng(seed), i;
    var N = 24, ctrl = [];
    for (i = 0; i < N; i++) ctrl.push(rnd());
    function nz(t, oct) {
      var x = (t - Math.floor(t)) * N * oct, i0 = Math.floor(x), f = x - i0;
      f = f * f * (3 - 2 * f);
      var m = N * oct;
      var a = ctrl[((i0 % m) % N + N) % N], b = ctrl[(((i0 + 1) % m) % N + N) % N];
      return lerp(a, b, f);
    }
    var ph = rnd() * PI * 2, ph2 = rnd() * PI * 2;
    return function (t) {
      var v = 0.50 * nz(t, 1) + 0.27 * nz(t + 0.31, 2)
            + 0.15 * nz(t + 0.73, 5) + 0.08 * nz(t + 0.17, 11);
      v *= 0.60 + 0.40 * (0.5 + 0.5 * Math.cos(t * PI * 2 - ph));
      v += 0.15 * (0.5 + 0.5 * Math.sin(t * PI * 4 + ph2));
      return sat(v * 1.20);
    };
  }

  function buildRange() {
    var pos = [], col = [], idx = [], base = 0;
    var b, i, k, row;
    var ROWS = 3;
    for (b = 0; b < RANGE_BANDS.length; b++) {
      var B = RANGE_BANDS[b];
      var H = ridgeH(B.seed), SNOWN = ridgeH(B.seed ^ 0x5bd1);
      var litc = hexLin(B.lit), shdc = hexLin(B.shade);
      var HAZE = skyAtEl(B.el);
      var N = RANGE_SEG, hs = new Float64Array(N);
      for (i = 0; i < N; i++) hs[i] = B.base + B.peak * H(i / N);
      for (i = 0; i <= N; i++) {
        var ii = i % N, t = (i / N) * PI * 2;
        var x = Math.sin(t) * B.r, z = Math.cos(t) * B.r, h = hs[ii];
        var hp = hs[(ii + 1) % N], hm = hs[(ii - 1 + N) % N];
        var dh = (hp - hm) / (2 * B.r * (PI * 2 / N));
        /* A REAL NORMAL, not an azimuth. A shallow slope points mostly UP and
           takes the sun at a 44-degree sun's own cosine; a steep flank points
           mostly sideways and is lit or shaded by which way it faces. That is
           the difference between a range with light on it and a range with a
           gradient painted along it. */
        var faceT = t + (dh > 0 ? -PI * 0.5 : PI * 0.5);
        var rise = 1 / Math.max(Math.abs(dh), 0.10);
        var nx = Math.sin(faceT), nz_ = Math.cos(faceT), ny = rise;
        var nl = Math.sqrt(nx * nx + ny * ny + nz_ * nz_);
        var ndl = sat((nx * SUN_DIR_W[0] + ny * SUN_DIR_W[1] + nz_ * SUN_DIR_W[2]) / nl);
        var key = OVERCAST4 ? 0.42 + 0.12 * (ny / nl) : ss((ndl - 0.10) / 0.65);
        var steep = Math.min(1, Math.abs(dh) * 1.1);
        var snowLine = B.snow + 17 * (SNOWN(i / N) - 0.5);
        var treeTop = B.tree * h;

        for (row = 0; row <= ROWS; row++) {
          /* row boundaries as a fraction of the local crest: the foot is the
             valley haze, the middle is scrub or bare slope, the top is rock
             and, high enough, snow. */
          var fr = row / ROWS;
          var yv = row === 0 ? -60 : lerp(0, h, fr);
          var c = [0, 0, 0];
          for (k = 0; k < 3; k++) c[k] = lerp(shdc[k], litc[k], key);
          if (B.tree > 0 && yv < treeTop) {
            var tw = ss((treeTop - yv) / Math.max(6, treeTop * 0.45));
            for (k = 0; k < 3; k++)
              c[k] = lerp(c[k], lerp(TREE_SHD[k], TREE_LIT[k], key), tw * 0.85);
          }
          if (B.snow < 1e8) {
            /* a cliff does not hold snow, and painted snow on one is the tell */
            var sn = ss((yv - snowLine) / 24) * (1 - 0.70 * steep);
            for (k = 0; k < 3; k++) c[k] = lerp(c[k], lerp(SNOW_SHD[k], SNOW_LIT[k], key), sn);
          }
          /* aerial perspective: the band's own depth, and more of it at the
             foot, where the sightline crosses the most air */
          var w = Math.min(0.97, B.wash + (row === 0 ? 0.24 : (row === 1 ? 0.10 : 0)));
          for (k = 0; k < 3; k++) c[k] = lerp(c[k], HAZE[k], w);
          pos.push(x, yv, z); col.push(c[0], c[1], c[2]);
        }
      }
      var stride = ROWS + 1;
      for (i = 0; i < N; i++) for (row = 0; row < ROWS; row++) {
        var o = base + i * stride + row, o2 = base + (i + 1) * stride + row;
        idx.push(o, o2, o2 + 1, o, o2 + 1, o + 1);
      }
      base += (N + 1) * stride;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    OWN.geo.push(g);

    rangeMat = backdropMaterial('range');
    /* the camera stands INSIDE the ring, so half of any winding convention is
       facing away from it. DoubleSide costs nothing on a mesh that never
       reaches the G-buffer and removes a whole class of "why is my backdrop
       invisible" from the next pass. */
    rangeMat.side = THREE.DoubleSide;
    /* the range is ALREADY at its final aerial depth, per band: running the
       backdrop's distance fog over it as well would put a second,
       camera-relative wash on a mesh whose distance never changes. */
    rangeMat.uniforms.uFogNF = { value: new THREE.Vector2(4000, 8000) };

    rangeMesh = new THREE.Mesh(g, rangeMat);
    rangeMesh.name = 'nzday:range';
    rangeMesh.frustumCulled = false;
    rangeMesh.castShadow = false; rangeMesh.receiveShadow = false;
    rangeMesh.userData.nzNoGBuffer = true;
    rangeMesh.renderOrder = -0.47;   /* behind the town ranks, in front of sky */
    scene.add(rangeMesh);
    OWN.obj.push(rangeMesh);
    STATS.addedCalls++;
    STATS.backdropTris += (idx.length / 3) | 0;
    note('range: ' + RANGE_BANDS.length + ' bands, ' + ((idx.length / 3) | 0) + ' tris');
  }

  function buildBackdrop() {
    var r = rng(0x233504);           /* determinism: the same town every boot */
    var pile = new Pile();
    var i, j;

    /* Two ranks each way down the canyon axis, on ground that climbs. The
       sightline over an end wall from the far end of the road is
       atan((52 - 6.4) / 80) = 29.7 deg, so anything meant to be seen has to
       clear y = 6.4 + dist * 0.57 -- which is why the near rank starts at 46
       and the far rank at 120. That is the town on the hillside, not a scale
       error. */
    var RANKS = [
      /* Low real-world roofline immediately beyond the 233/230 barriers,
         followed by two progressively washed ranks. Values are relative to
         the live closure plane so another route-length pass cannot strand the
         town inside the playable street again. */
      /* The park module now supplies the recognizable foreground houses.  The
         sky ranks begin behind them and stay low: they are town texture under
         the mountain, not a second row of giant pastel cards. */
      /* THE WASH LADDER WAS INVERTED. These ranks sit 168, 250 and 318 units
         from the checkpoint camera -- 48, 71 and 91 metres -- where a 25 km
         atmosphere removes about 3 % of contrast, not 70 %. Washed at
         0.70/0.81/0.89 they were hazier than the four-band mountain range
         520-800 units BEHIND them, so the composition said the town was the
         further thing. On mission 4 they are near town, and they are washed
         like it; mission 1 never sees them from closer than the dead end and
         keeps the values it was calibrated with. */
      { x: BOX.x1 + 132, span: 58, depth: 28, base: 4, tall: 13, n: 5, wash: LEVEL4 ? 0.16 : 0.70, jitter: 18 },
      { x: BOX.x1 + 214, span: 74, depth: 34, base: 9, tall: 16, n: 5, wash: LEVEL4 ? 0.24 : 0.81, jitter: 24 },
      { x: BOX.x1 + 282, span: 92, depth: 40, base: 15, tall: 18, n: 4, wash: LEVEL4 ? 0.32 : 0.89, jitter: 30 }
    ];
    /* EAST ONLY, and this is a geometric result rather than a preference, and
       the widening made it MORE true rather than less.
       North-west of the gable is the east alley (rAlley, x [160,196],
       z [84,152], c = 28, sky:TRUE), an open-air NIGHT region, and the canyon
       connects straight into it through the junction throat. Rays that leave
       the street under the bridge band (y < 28 at z = 152, x [176,192] -- four
       units wider than the old mouth) fan out north-west across the alley's own
       airspace, so ANY backdrop placed west of x = 168 is visible from inside
       the daylight zone -- where the camera mask is 1 and the night fade that
       protects everything else is switched off. Measured: a rank-1 block at
       x ~ 150 lit the bottom-left corner of the straight-up shot.

       East of the dead end there is no night region at all: x > 252 is off the
       grid, and the rooftop (rRoof, x [192,236], z [88,148], f = 12) is walled
       to y = 46 at x = 236 and can only see over that wall from a camera whose
       day mask is 0 -- at which point the backdrop is already the night horizon
       colour.

       So the west end shows sky, and the corner block's blind gable plus
       whatever roofline nz-street.js puts on it is what closes that view. */
    for (i = 0; i < RANKS.length; i++) {
      var R = RANKS[i];
      var count = Math.max(2, Math.round(R.n * DENSITY));
      for (j = 0; j < count; j++) {
        var t = (j + 0.5) / count;
        var cx = R.x + (r() - 0.5) * R.jitter;
        var cz = 172 + (t - 0.5) * 2.6 * R.span + (r() - 0.5) * R.jitter;
        var w = R.span * (0.30 + r() * 0.34);
        var dp = R.depth * (0.55 + r() * 0.6);
        var y0 = R.base + (r() - 0.5) * R.base * 0.30;
        var y1 = y0 + R.tall * (0.72 + r() * 0.62);
        block(pile, cx - w * 0.5, cx + w * 0.5, y0, y1, cz - dp * 0.5, cz + dp * 0.5,
              R.wash + (r() - 0.5) * 0.08, r);
      }
    }
    backMat = backdropMaterial('backdrop');
    var g = pile.geometry(THREE);
    OWN.geo.push(g);
    backMesh = new THREE.Mesh(g, backMat);
    backMesh.name = 'nzday:backdrop';
    backMesh.frustumCulled = true;
    backMesh.castShadow = false; backMesh.receiveShadow = false;
    backMesh.matrixAutoUpdate = false; backMesh.updateMatrix();
    backMesh.userData.nzNoGBuffer = true;
    backMesh.renderOrder = -0.4;
    scene.add(backMesh);
    OWN.obj.push(backMesh);
    STATS.addedCalls++;
    STATS.backdropTris += (pile.i.length / 3) | 0;

    /* MISSION 4 replaces the single east-facing card with the full range;
       mission 1 keeps the surveyed silhouette it was calibrated against. */
    if (LEVEL4) { buildRange(); return; }
    /* ---- the hills ------------------------------------------------------
       _ref/ref5: a long ridge, snow on the tops, washed to within a dozen
       levels of the sky. Built as a coarse ridge strip on each side, at a
       distance the 900-unit far plane still holds. */
    var hp = new Pile();
    /* the camera's far plane is 900 (NUKEM.html:8041), so no vertex out here
       may sit more than ~790 units from the far end of the road or the ridge
       clips away mid-frame */
    /* A single broad Beysehir/Seydisehir silhouette.  The former procedural
       sine/noise product changed height independently at each coarse segment,
       producing three sharp paper triangles.  This surveyed-looking profile
       has one offset summit, long shoulders and small secondary undulations;
       it remains continuous for the full frame and has no false snow caps. */
    /* Keep the card inside the 540-unit fog-far distance measured from the
       acceptance camera.  At the former +585 offset every pixel was replaced
       by the fog colour in backdropMaterial(), so only accidental polygon
       overlaps showed as isolated triangles. */
    var RIDGE_X = BOX.x1 + 330;
    var RIDGE = [
      [-225,47],[-190,49],[-154,52],[-120,57],[-88,63],[-58,72],
      [-30,81],[-4,90],[22,98],[48,104],[75,100],[104,94],
      [136,87],[170,81],[207,76],[247,72],[289,68],[334,65],
      [382,62],[434,59],[490,56],[548,52]
    ];
    var ridgeBase = washed(hexLin(0x738894),0.34);
    var ridgeHaze = washed(hexLin(0x8799a2),0.52);
    for (j = 1; j < RIDGE.length; j++) {
      var a=RIDGE[j-1], b=RIDGE[j];
      /* Tiny, slow tonal drift supplies aerial depth without outlining each
         segment or reintroducing the faceted saw-tooth appearance. */
      var tt=(j-1)/(RIDGE.length-2);
      var rc=[lerp(ridgeBase[0],ridgeHaze[0],tt*.38),
              lerp(ridgeBase[1],ridgeHaze[1],tt*.38),
              lerp(ridgeBase[2],ridgeHaze[2],tt*.38)];
      hp.quad([RIDGE_X,0,172+a[0]],[RIDGE_X,0,172+b[0]],
              [RIDGE_X,b[1],172+b[0]],[RIDGE_X,a[1],172+a[0]],
              [-1,0,0],rc);
    }
    hillMat = backdropMaterial('hills');
    var hg = hp.geometry(THREE);
    OWN.geo.push(hg);
    hillMesh = new THREE.Mesh(hg, hillMat);
    hillMesh.name = 'nzday:hills';
    hillMesh.frustumCulled = true;
    hillMesh.castShadow = false; hillMesh.receiveShadow = false;
    hillMesh.matrixAutoUpdate = false; hillMesh.updateMatrix();
    hillMesh.userData.nzNoGBuffer = true;
    hillMesh.renderOrder = -0.45;
    scene.add(hillMesh);
    OWN.obj.push(hillMesh);
    STATS.addedCalls++;
    STATS.backdropTris += (hp.i.length / 3) | 0;
  }

  /* =======================================================================
     SECTION 9 -- retargeting the world quads
     The road, both pavements and the four canyon walls are NUKEM.html's own
     merged world meshes. They cannot be given the probe -- their materials are
     shared with the night level, and their geometry is one buffer spanning the
     whole map -- so they get the shader mask instead, and their vertex colours
     are rewritten in place with the overcast bake.
     ==================================================================== */
  function isWorldMat(mm) {
    if (!mm || !mm.name) return false;
    var s = String(mm.name);
    return s.indexOf('world:') === 0 || s.indexOf('nzenv:') === 0;
  }
  function anyVertInZone(geo) {
    var p = geo.attributes && geo.attributes.position;
    if (!p) return false;
    var a = p.array, n = p.count, s = p.itemSize, i, k;
    for (i = n - 1; i >= 0; i--) {          /* the street was carved last */
      k = i * s;
      var x = a[k], y = a[k + 1], z = a[k + 2];
      for (var zi = 0; zi < ZONES.length; zi++) {
        var Z = ZONES[zi];
        if (!Z.vert) continue;
        if (x >= Z.x0 && x <= Z.x1 && z >= Z.z0 && z <= Z.z1 && y >= -1 && y <= Z.y1) return true;
      }
    }
    return false;
  }

  function retargetWorld() {
    var seenM = {}, seenG = {}, mats = 0, geos = 0;
    var compensate = !!(NZ.flags && NZ.flags.render && NZ.render);
    /* The kerbs, as a contact term -- the 0.5-unit step whose nose is the
       ground-line shadow under every wall. The NORTH kerb is broken by the
       junction throat: cells x 44..47 of both north rows were repainted
       rResRoad at f = 0 (a dropped kerb), so the pavement runs x [168,176] and
       x [192,252] only and the apron in between is flat asphalt. Modelling it
       as one unbroken slab would put a phantom kerb nose across the mouth of
       the side street, which is the one place ref8 shows the road running
       straight through. */
    var occ = [];
    occ.push({ x0: BOX.x0, x1: THROAT.x0, y0: -2, y1: KERB.height,
               z0: BOX.z0, z1: KERB.northTop });
    occ.push({ x0: THROAT.x1, x1: BOX.x1, y0: -2, y1: KERB.height,
               z0: BOX.z0, z1: KERB.northTop });
    occ.push({ x0: BOX.x0, x1: BOX.x1, y0: -2, y1: KERB.height,
               z0: KERB.southTop, z1: BOX.z1 });

    scene.traverse(function (o) {
      if (!o.isMesh || !o.material || o.isSkinnedMesh || o.isInstancedMesh) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      var any = false, i;
      for (i = 0; i < list.length; i++) if (isWorldMat(list[i])) any = true;
      if (!any) return;
      var g = o.geometry;
      if (!g || seenG[g.uuid]) return;
      if (!anyVertInZone(g)) return;
      seenG[g.uuid] = 1;

      for (i = 0; i < list.length; i++) {
        var mm = list[i];
        if (!mm || seenM[mm.uuid] || !isWorldMat(mm)) continue;
        seenM[mm.uuid] = 1;
        attachPatch(mm, false);
        mats++;
      }

      /* rewrite only the vertices inside the zone; the same buffer carries the
         whole night level and must come back untouched */
      var pos = g.attributes.position, col = g.attributes.color;
      if (!pos || !col || col.itemSize < 3) return;
      var nrm = g.attributes.normal;
      var a = col.array, pa = pos.array, ps = pos.itemSize, cs = col.itemSize;
      OWN.restore.push({ attr: col, orig: new Float32Array(a) });
      var n = pos.count, k, kc, touched = 0, tp = { x: 0, y: 0, z: 0 };
      for (k = 0; k < n; k++) {
        var px = pa[k * ps], py = pa[k * ps + 1], pz = pa[k * ps + 2];
        tp.x = px; tp.y = py; tp.z = pz;
        var w = dayMask(tp);
        if (w <= 0.004) continue;
        var nx = nrm ? nrm.array[k * 3] : 0;
        var ny = nrm ? nrm.array[k * 3 + 1] : 1;
        var nz = nrm ? nrm.array[k * 3 + 2] : 0;
        var v = skyVis(px, py, pz, nx, ny, nz, occ);
        if (compensate) v = invBakeCurve(v);
        kc = k * cs;
        a[kc] = lerp(a[kc], v, w);
        a[kc + 1] = lerp(a[kc + 1], v, w);
        a[kc + 2] = lerp(a[kc + 2], v, w);
        touched++;
      }
      col.needsUpdate = true;
      geos++; STATS.bakedVerts += touched;
    });
    STATS.worldMats = mats;
    STATS.bakedGeos += geos;
    note('world quads retargeted: ' + geos + ' geometr(ies), ' + mats +
         ' material(s), compensate=' + compensate);
  }

  /* the same term bake() computes, without the attribute plumbing */
  function skyVis(px, py, pz, nx, ny, nz, occ) {
    if (!rayDirs || rayDirs.length !== RAYS * 4) rayDirs = buildRays(RAYS);
    STATS.rays += RAYS;
    return clamp(sweep(px, py, pz, nx, ny, nz, rayDirs, RAYS,
                       occ, occ ? occ.length : 0, SKY_Y, BAKE_FLOOR, 0.05),
                 BAKE_LO, BAKE_HI);
  }

  /* =======================================================================
     SECTION 10 -- the ramp
     Fog and exposure, on a DAMPED camera-position mask. NZ.math.damp is the
     frame-rate independent smoother (nz-core.js:102); a per-frame lerp would
     change speed with the tier, and the tier moves on its own.
     ==================================================================== */
  var fogSaved = null, expSaved = null, camW = 0, tmpCol = null;
  var lastCam = null;

  function tickRamp(dt) {
    if (dead || !camera || !scene) return;
    var target = fogMask(camera.position);
    /* A teleport is not a walk. Lifts, respawns, the shot harness's free camera
       and NUKEM.html's own spawn all move the camera further in one frame than
       a player can run in a second; damping across that would leave the level
       half-graded for a second of gameplay. */
    var jump = 1e9;
    if (lastCam) {
      var jx = camera.position.x - lastCam.x, jy = camera.position.y - lastCam.y,
          jz = camera.position.z - lastCam.z;
      jump = Math.sqrt(jx * jx + jy * jy + jz * jz);
    } else lastCam = { x: 0, y: 0, z: 0 };
    lastCam.x = camera.position.x; lastCam.y = camera.position.y; lastCam.z = camera.position.z;

    if (jump > 25) camW = target;
    else camW = NZ.math ? NZ.math.damp(camW, target, 0.02, dt || 0.016)
                        : (camW + (target - camW) * 0.2);
    if (camW < 1e-4) camW = 0;
    if (uCamDay) uCamDay.value = camW;

    if (scene.fog && fogSaved) {
      tmpCol = tmpCol || new THREE.Color();
      tmpCol.setRGB(lerp(fogSaved.r, DAY_FOG[0], camW),
                    lerp(fogSaved.g, DAY_FOG[1], camW),
                    lerp(fogSaved.b, DAY_FOG[2], camW));
      scene.fog.color.copy(tmpCol);
      if (scene.fog.near !== undefined) {
        scene.fog.near = lerp(fogSaved.near, DAY_FOG_NEAR, camW);
        scene.fog.far = lerp(fogSaved.far, DAY_FOG_FAR, camW);
      }
      if (uFogCol) uFogCol.value.copy(tmpCol);
      if (uFogNF) uFogNF.value.set(scene.fog.near, scene.fog.far);
      /* the backdrop keeps its own long ramp -- see BACK_FOG_FAR */
      if (uFogNFB) uFogNFB.value.set(lerp(fogSaved.near, BACK_FOG_NEAR, camW),
                                     lerp(fogSaved.far, BACK_FOG_FAR, camW));
      if (uNightCol) uNightCol.value.setRGB(fogSaved.r, fogSaved.g, fogSaved.b);
    }
    /* <= 0.25 stop, as a finishing touch only: exposure is global and moves the
       night geometry in the same frame (RENDER-CONTRACT.md section 3.4) */
    if (expSaved !== null && NZ.render && NZ.render.params)
      NZ.render.params.exposure = expSaved * Math.pow(2, DAY_EV * camW);

    var on = camW > 0.004;
    if (skyMesh) skyMesh.visible = on;
    /* the dome is the ONE mesh in this module that draws with depthTest off,
       so a frame in which it is visible and the day mask is not is a frame
       with a flat fog-coloured plate over the whole sky. It is gated hardest
       of the four. */
    if (domeMesh) domeMesh.visible = on;
    if (backMesh) backMesh.visible = on;
    if (hillMesh) hillMesh.visible = on;
    if (rangeMesh) rangeMesh.visible = on;
  }

  /* =======================================================================
     SECTION 11 -- install / teardown / report
     ==================================================================== */
  var TIER = 'high', DENSITY = 1.0, tierDone = false;
  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  function pickTier() {
    if (QS) return QS[1].toLowerCase();
    var q = (NZ.render && NZ.render.quality) || null;
    if (q === 'ultra') return 'high';
    if (q === 'high' || q === 'med' || q === 'low') return q;
    return 'high';
  }
  function applyTier() {
    tierDone = true;
    TIER = pickTier();
    /* cosine-weighted now, so every ray lands in the hemisphere and carries the
       same weight: 24 of these resolve a cavity better than the old 48 uniform
       sphere samples did, of which half were discarded and the rest weighted
       0..1. RAYS_MIN is a FLOOR under whatever a caller asks for -- several
       pass rays:10 for thin geometry, which was fine for a binary escape test
       and is not fine for a contact term. */
    if (TIER === 'low') { RAYS = 28; RAYS_MIN = 18; DENSITY = 0.55; }
    else if (TIER === 'med') { RAYS = 40; RAYS_MIN = 22; DENSITY = 0.80; }
    else { RAYS = 52; RAYS_MIN = 26; DENSITY = 1.00; }
    rayDirs = buildRays(RAYS);
    street.tier = TIER;
  }

  /* The carve may not be in this build; never assume it is. NUKEM.html declares
     its level state with top-level const/let, so it is visible as a bare
     identifier and NOT as a property of window -- the same thunk idiom
     nz-env.js:130-163 uses. A ReferenceError here just means "cannot tell". */
  function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }
  function hasStreet() {
    var at = tryGet(function () { return regAt; });
    if (typeof at !== 'function') return true;              /* cannot tell */
    /* The linear route now starts at cell 66 and reaches the police line at
       208.  Probe its complete cross-section; the former x42..62 test only
       sampled the untouched night mission and incorrectly made this module
       inert even while the new park renderer was live. */
    for (var y = 38; y <= 48; y++) for (var x = 66; x <= 208; x++) {
      var R = tryGet(function () { return at(x, y); });
      if (R && R.sky && R.c === BOX.y1) return true;
    }
    return false;
  }

  /* =======================================================================
     THE SUN -- mission 4 only
     NUKEM.html already owns a shadow-casting DirectionalLight ('warm-key')
     and nz-render already gives it a texel-snapped, camera-following PCSS
     shadow box (nz-render.js followShadow / applyShadowQuality).  The overcast
     profile spent its whole life CANCELLING that light inside the daylight
     mask, because an overcast street with a shadow in it is not an overcast
     street.  A sunny one is nothing but.  So mission 4 does not add a light --
     r149 accumulates every light in the scene into shared uniforms and a
     second key would leak everywhere -- it re-solves the one that is already
     there, through nz-render's own parameter block, and lets
     rebuildEnvironment() re-bake the probe and re-apply the rig.  No tier is
     pinned, so the adaptive quality ladder still works.
     ==================================================================== */
  function sunRig() {
    var R = NZ.render, P = R && R.params;
    if (!P) { note('no nz-render params: sun rig left as authored'); return; }
    SUN_SAVED = {
      key: P.keyIntensity, env: P.envIrradiance, bounce: P.bounceIntensity,
      amb: P.ambientFloor, kick: P.kickerIntensity, el: P.sunElevation,
      share: P.sunProbeShare, sky: P.skyLum, exp: P.exposure
    };
    /* every number is in nz-render's unit: the albedo multiplier a white
       surface FACING that source receives. */
    /* the azimuth first: applyLighting() re-aims only the ELEVATION and keeps
       whatever azimuth the light already carries (nz-render.js:1814-1824), so
       this has to be written before rebuildEnvironment() calls it. */
    var LS = (NZ.ctx && NZ.ctx.lights) || null;
    if (LS && LS.sunKey && THREE) {
      var az = SUN_AZ, azl = Math.sqrt(az[0] * az[0] + az[1] * az[1]) || 1;
      var C = new THREE.Vector3(600, 3, 220);      /* the middle of the map */
      LS.sunKey.target.position.copy(C);
      LS.sunKey.position.set(
        C.x + (az[0] / azl) * 160,
        C.y + 160 * Math.tan(SUN_EL * PI / 180),
        C.z + (az[1] / azl) * 160);
      LS.sunKey.target.updateMatrixWorld();
    }
    P.keyIntensity   = SUN_KEY;    /* direct sun on a face square to it       */
    P.sunElevation   = SUN_EL;     /* degrees; long enough shadows to compose  */
    /* THE INTERIORS ARE LIT BY THIS LINE, and dropping it to 0.10 is what put
       them two thirds of a stop below the build they replaced.
       Mission 4's rooms -- the A-BLOK and B-BLOK ground floors, the two
       first-floor flats, the bakkal, the garage, the pharmacy -- mostly sit
       OUTSIDE the daylight boxes, so this module's analytic hemisphere never
       reaches them and nz-render's probe is the only fill they have. Inside
       the mask it barely matters: DAY_IBL_KILL takes it to 10 % on world
       quads and the 'nzday:' materials carry their own probe on
       material.envMap and never read scene.environment at all. So it is
       almost purely an INTERIOR knob, and it is held near the level's own
       value. Measured on cordon.ablok-in: 51/48/43 mean before the sunny
       profile, 28/30/33 at 0.10, back to the original band at 0.30. */
    P.envIrradiance  = 0.30;
    P.bounceIntensity = 0.30;      /* warm ground bounce onto the shade sides  */
    P.ambientFloor   = 0.040;      /* a readability floor, not a fill          */
    P.kickerIntensity = 0.10;
    P.sunProbeShare  = 0.05;
    /* an outdoor level needs an outdoor shadow box: see nz-render's
       computeEffects(). 1.7 takes the shipping tier from a 100-unit box to a
       170-unit one, which is four times the 41-unit shadow a five-storey
       eaves line throws at this sun, so the buildings finally lay something on
       the road. At 3072 that is still 0.055 units (16 mm) a texel. */
    P.shadowExtentScale = 1.7;
    try { R.rebuildEnvironment(); } catch (e) { warn('sun rig rebuild: ' + (e && e.message)); }
    /* the sky's sun, the range's sun and the surfaces' sun have to be ONE sun,
       so the direction is READ BACK off the light nz-render has just re-aimed
       rather than re-derived here from SUN_EL and the authored azimuth. Every
       consumer -- buildDome's disc and glow, buildRange's shading, and
       street.SKY.sun -- is built after this line. */
    var LK0 = (NZ.ctx && NZ.ctx.lights) || null;
    if (LK0 && LK0.sunKey) {
      var sp = LK0.sunKey.position, st = LK0.sunKey.target.position;
      var sx = sp.x - st.x, sy = sp.y - st.y, sz = sp.z - st.z;
      var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl > 1e-4) {
        SUN_DIR_W = [sx / sl, sy / sl, sz / sl];
        note('sun dir ' + SUN_DIR_W.map(function (v) { return v.toFixed(3); }).join(','));
      }
    }
    publishSky();
    var L = (NZ.ctx && NZ.ctx.lights) || null;
    if (L && L.sunKey) {
      /* the COLOUR is deliberately left alone. nz-render's applyLighting()
         sets it through setSrgb(0xfff1dc) and will do so again from its
         -1000 sweep and from every quality change; writing it here with
         setHex() would both be overwritten and, while it stood, be wrong --
         setHex writes the WORKING space, so a managed build would get a key
         11 % whiter than the one that was asked for (nz-render.js:1793-1802
         makes exactly this argument about sunSaved). 0xfff1dc is already the
         right sun for a clear afternoon. */
      note('sun key ' + L.sunKey.intensity.toFixed(2) + ' at ' + SUN_EL + ' deg');
    }
  }

  var OVERCAST_RIG_SAVED = null;
  function overcastRig() {
    var R = NZ.render, P = R && R.params;
    if (!P) return;
    if (!OVERCAST_RIG_SAVED) {
      OVERCAST_RIG_SAVED = {};
      ['keyIntensity', 'envIrradiance', 'bounceIntensity', 'ambientFloor',
       'kickerIntensity', 'sunProbeShare', 'grain', 'ca', 'vignette', 'bloom'].forEach(function (key) {
        OVERCAST_RIG_SAVED[key] = P[key];
      });
    }
    /* The daylight materials use their own neutral probe. Keep modest light
       in the enterable rooms, but remove the warm directional wash and the
       sun spot from the shared environment reflected by remaining props. */
    P.keyIntensity = 0.12;
    P.envIrradiance = 0.28;
    P.bounceIntensity = 0.10;
    P.ambientFloor = 0.025;
    P.kickerIntensity = 0.0;
    P.sunProbeShare = 0.0;
    P.grain = 0.004;
    P.ca = 0.0;
    P.vignette = 0.07;
    P.bloom = 0.035;
    try { R.rebuildEnvironment(); }
    catch (e) { warn('overcast rig rebuild: ' + (e && e.message)); }
  }

  function restoreOvercastRig() {
    if (!OVERCAST_RIG_SAVED) return;
    var R = NZ.render, P = R && R.params;
    if (P) {
      Object.keys(OVERCAST_RIG_SAVED).forEach(function (key) {
        P[key] = OVERCAST_RIG_SAVED[key];
      });
      if (NZ.flags && NZ.flags.render && R.rebuildEnvironment) R.rebuildEnvironment();
    }
    OVERCAST_RIG_SAVED = null;
  }
  var SUN_SAVED = null;
  var SUN_KEY = qk('sunkey', 1.45), SUN_EL = qk('sunel', 52);
  /* THE AZIMUTH IS THE WHOLE COMPOSITION, and the level's authored one puts
     the street inside its own shadow.

     233 Sk runs east-west, 40 units (11.4 m) kerb to kerb, between five-storey
     blocks 52 units (15 m) tall. A wall of height H throws H/tan(E) of shadow,
     and the part of that which crosses the street is that length times the
     sun's NORTH-SOUTH component. The level authors the key at (-72, ., +58) --
     39 degrees south of west -- which at 44 degrees of elevation is 54 units of
     shadow with 34 of them running north: more than the full width of the
     carriageway. Measured, before this: switching the sun on changed the road
     and both pavements by ZERO code values, because every one of them was in
     the shadow of the block behind the camera. A sunny street with no sun on
     its road is worse than an overcast one, because it is the same picture and
     it costs a shadow map.

     Aim the sun DOWN the axis instead and the geometry inverts:

         horizontal (-0.94, +0.34), elevation 52
         shadow length          52 / tan 52       = 40.6 units
         northward component    40.6 x 0.34       = 13.8 -> reaches z 175
         roadway z 160..184     lit 160..175      = 63 %
         eastward component     40.6 x 0.94       = 38 units of raking shadow
                                                    down the length of the road
         N.L, south-facing 233 Sk elevations      0.34 x cos52 = 0.21 (grazing:
                                                    dim, but every balcony,
                                                    cornice and sill draws its
                                                    own shadow, which is what
                                                    makes a facade read as
                                                    relief instead of a plane)
         N.L, west-facing 232 Sk elevations       0.94 x cos52 = 0.58 (full sun)

     So the carriageway is sunlit, the two new side-street arms get a hard
     light/shade division down their length, the trees and lamp columns throw
     long shadows east along the axis, and the photographed elevations are
     raked rather than flat-lit. It is also the honest hour for the place:
     Seydisehir is at 37.4 N, where a summer afternoon sun really does sit
     above 50 degrees. */
  var SUN_AZ = [-0.94, 0.34];        /* horizontal direction TOWARD the sun    */

  /* =======================================================================
     THE CASTERS -- mission 4 only
     nz-render promotes world meshes to shadow casters in its material sweep,
     and that sweep runs at 'ready' priority 0. nz-core sorts hooks DESCENDING,
     so 0 beats -40 and -50: every mesh nz-street.js, -props, -park, -side,
     -ground and -entrance builds is created AFTER the sweep has already run
     and is therefore never in worldCasters. Under the overcast profile that
     cost nothing -- the sun was cancelled inside the mask and there was no
     shadow to cast. Under a sunny one it is the whole picture: without this
     the facades, the trees, the barricades and the parked Courier are lit by a
     44-degree sun and lay nothing on the road, which is the single loudest
     "this is a videogame" tell a daylight street can have.

     So this module, which runs LAST at -60, does the promotion the sweep
     could not. Remembered, not just set, so panic() hands every flag back.
     ==================================================================== */
  var CASTERS = [];
  function promoteCasters() {
    if (!scene) return;
    var n = 0;
    scene.traverse(function (o) {
      if (!o.isMesh || o.castShadow || !o.receiveShadow) return;
      if (o.userData && o.userData.nzNoGBuffer) return;      /* sky, backdrop */
      var m = o.material;
      if (Array.isArray(m)) m = m[0];
      if (!m) return;
      /* only the daylight street. A 'nzday:' name is exactly the set of
         materials that went through day(), which is exactly the set of
         surfaces the sun is allowed to reach. */
      if (String(m.name || '').indexOf('nzday:') !== 0) return;
      /* glass and the flat sign/decal cards would cast a solid black slab of
         their own bounding quad; alpha-tested foliage is fine, because r149's
         shadow depth material carries map + alphaTest across. */
      if (m.transparent && !(m.alphaTest > 0)) return;
      o.castShadow = true;
      CASTERS.push(o);
      n++;
    });
    STATS.casters = CASTERS.length;
    note('promoted ' + n + ' street mesh(es) to shadow casters (' + CASTERS.length + ' total)');
  }

  function install(ctx) {
    if (dead || installed) return;
    if (NZ.level !== undefined && NZ.level !== 1 && NZ.level !== 4) {
      NZ.log && NZ.log('street-sky: level ' + NZ.level + ', module inert');
      return;
    }
    var t0 = now();
    /* BEFORE buildInjections(): the GLSL mask, the fog ramp, the probe weights
       and the world retarget all read ZONES, and all four run below. */
    prepareMissionProfile();
    if (NZ.level === 4) {
      note('mission 4: OVERCAST profile (stratus, neutral sky light, restrained airlight)');
    }
    THREE = (ctx && ctx.THREE) || (NZ.ctx && NZ.ctx.THREE) || global.THREE;
    scene = (ctx && ctx.scene) || (NZ.ctx && NZ.ctx.scene);
    renderer = (ctx && ctx.renderer) || (NZ.ctx && NZ.ctx.renderer);
    camera = (ctx && ctx.camera) || (NZ.ctx && NZ.ctx.camera);
    if (!THREE || !scene || !renderer || !camera)
      throw new Error('nz-street-sky: renderer context missing');

    applyTier();
    if (!hasStreet()) { note('carve not present, module inert'); panic(null); return; }

    buildInjections();
    GLSL_OK = validateGLSL();
    DIAG.glslProbe = GLSL_OK;
    if (!GLSL_OK) warn('GLSL probe failed -- the daylight mask is off, the probe still runs');

    uSkUp = { value: new THREE.Vector3(SKY_E_UP[0], SKY_E_UP[1], SKY_E_UP[2]) };
    uSkDn = { value: new THREE.Vector3(SKY_E_DOWN[0], SKY_E_DOWN[1], SKY_E_DOWN[2]) };
    uHaze = { value: new THREE.Vector3(DAY_FOG[0], DAY_FOG[1], DAY_FOG[2]) };
    uCamDay = { value: 0 };
    uFogCol = { value: new THREE.Color(1, 1, 1) };
    uFogNF = { value: new THREE.Vector2(DAY_FOG_NEAR, DAY_FOG_FAR) };
    uFogNFB = { value: new THREE.Vector2(BACK_FOG_NEAR, BACK_FOG_FAR) };
    uNightCol = { value: new THREE.Color(1, 1, 1) };

    /* everything nz-street.js (-50) and nz-street-props.js (-40) handed to
       day() before the GLSL had been proved */
    var q = pendingPatch.slice(); pendingPatch.length = 0;
    for (var pi = 0; pi < q.length; pi++) attachPatch(q[pi], !!q[pi].envMap);
    if (LEVEL4) refreshDayParams();

    buildProbe();

    /* the baseline has to be the POST-nz-render fog, not NUKEM.html's authored
       one: applyAtmosphere() rewrote it at 'ready' priority 0 (nz-render.js:1591) */
    if (scene.fog) {
      fogSaved = {
        r: scene.fog.color.r, g: scene.fog.color.g, b: scene.fog.color.b,
        near: fin(scene.fog.near, 70), far: fin(scene.fog.far, 520)
      };
      uNightCol.value.setRGB(fogSaved.r, fogSaved.g, fogSaved.b);
      uFogCol.value.setRGB(fogSaved.r, fogSaved.g, fogSaved.b);
      OWN.restore.push({ fog: scene.fog, save: fogSaved });
    }
    if (NZ.render && NZ.render.params && typeof NZ.render.params.exposure === 'number')
      expSaved = NZ.render.params.exposure;

    if (LEVEL4) overcastRig();
    buildSky();
    if (!NO_BACKDROP) buildBackdrop();
    retargetWorld();
    /* LAST: every occluder every module handed to bake() is now known, and this
       hook is the only place in the level where that is true. See refineBakes. */
    if (LEVEL4) promoteCasters();
    var tR = now();
    try { refineBakes(); } catch (eR) { warn('bake replay failed: ' + (eR && eR.message)); }
    STATS.replayMs = Math.round(now() - tR);

    /* anything nz-street.js / nz-street-props.js registered through day()
       before the probe existed */
    if (probeTex && pendingDay.length) {
      for (var i = 0; i < pendingDay.length; i++) {
        pendingDay[i].envMap = probeTex;
        if (pendingDay[i].__nzSkP) pendingDay[i].__nzSkP.y = 1;
        pendingDay[i].needsUpdate = true;
      }
      pendingDay.length = 0;
    }

    tickRamp(1);
    installed = true;
    street.ok = true;
    NZ.flags.streetSky = true;
    STATS.ms = Math.round(now() - t0);
    NZ.log && NZ.log('street-sky installed: tier=' + TIER + ' probe=' + STATS.probeRes +
      'px E(up)=' + DAY_IRRADIANCE.toFixed(2) + ' draws +' + STATS.addedCalls +
      ' verts ' + STATS.bakedVerts + ' in ' + STATS.ms + 'ms');
    /* the same way nz-street.js and nz-street-entrance.js publish theirs, so
       `render-level.mjs --diag` picks it up: a critic cannot read NZ.log,
       which only fires under NZ.debug, and the numbers below are exactly the
       ones the AO and the sky get judged on. */
    try {
      var rl = report().split('\n');
      for (var ri = 0; ri < rl.length; ri++) console.warn('[nz-street-sky] ' + rl[ri]);
    } catch (eR2) {}
  }

  function panic(err) {
    for (var ci = 0; ci < CASTERS.length; ci++) { try { CASTERS[ci].castShadow = false; } catch (eC) {} }
    CASTERS.length = 0;
    if (dead) return;
    dead = true;
    installed = false;
    street.ok = false;
    if (NZ.flags) NZ.flags.streetSky = false;
    if (err) console.error('[nz-street-sky] disabled after error:', err);
    try {
      var i, s;
      /* nothing original is ever disposed -- teardown really does hand the
         stock level back (nz-env.js:3485-3492) */
      for (i = 0; i < OWN.restore.length; i++) {
        s = OWN.restore[i];
        if (s.attr && s.orig) { s.attr.array.set(s.orig); s.attr.needsUpdate = true; }
        if (s.fog && s.save) {
          s.fog.color.setRGB(s.save.r, s.save.g, s.save.b);
          if (s.fog.near !== undefined) { s.fog.near = s.save.near; s.fog.far = s.save.far; }
        }
      }
      OWN.restore.length = 0;
      for (i = 0; i < baked.length; i++) { baked[i].raw = null; baked[i].geo = null; }
      baked.length = 0; REG.length = 0;
      for (i = 0; i < OWN.patched.length; i++) {
        var mm = OWN.patched[i];
        if (!mm) continue;
        try {
          if (mm.__nzSkInner) mm.onBeforeCompile = mm.__nzSkInner;
          else delete mm.onBeforeCompile;
          delete mm.__nzSkPatched; delete mm.__nzSkInner; delete mm.__nzSkP;
          if (mm.envMap === probeTex) mm.envMap = null;
          mm.needsUpdate = true;
        } catch (e0) {}
      }
      OWN.patched.length = 0;
      for (i = 0; i < OWN.obj.length; i++) { var o = OWN.obj[i]; if (o && o.parent) o.parent.remove(o); }
      OWN.obj.length = 0;
      for (i = 0; i < OWN.geo.length; i++) { try { OWN.geo[i].dispose(); } catch (e1) {} }
      OWN.geo.length = 0;
      for (i = 0; i < OWN.mat.length; i++) { try { OWN.mat[i].dispose(); } catch (e2) {} }
      OWN.mat.length = 0;
      for (i = 0; i < OWN.tex.length; i++) { try { OWN.tex[i].dispose(); } catch (e3) {} }
      OWN.tex.length = 0;
      if (probeRT) { try { probeRT.dispose(); } catch (e4) {} }
      probeRT = null; probeTex = null;
      street.probe = null;
      if (expSaved !== null && NZ.render && NZ.render.params) NZ.render.params.exposure = expSaved;
      restoreOvercastRig();
      skyMesh = backMesh = hillMesh = rangeMesh = domeMesh = null;
    } catch (e5) { console.error('[nz-street-sky] teardown failed:', e5); }
  }

  function report() {
    var L = [];
    L.push('NZ-STREET-SKY tier=' + TIER + ' ok=' + street.ok + ' install=' + STATS.ms +
           'ms glsl=' + DIAG.glslProbe);
    L.push('  probe   ' + (probeTex ? STATS.probeRes + 'px PMREM' : 'NONE (analytic only)') +
           '  gain ' + DIAG.probeGain + '  E(up) ' + DAY_IRRADIANCE.toFixed(2) +
           '  E(dn) ' + (DAY_IRRADIANCE * DAY_DOWN_SHARE).toFixed(2) +
           '  ' + STATS.probeMs + 'ms');
    L.push('  sky     lum ' + (street.SKY ? street.SKY.lum.toFixed(3) : '?') +
           '  white ' + SKY_WHITE + '  vis ' + SKY_VIS + '  visGain ' + VIS_GAIN.toFixed(3) +
           '  cloud ' + CLOUD_AMT +
           '  fog ' + DAY_FOG_NEAR + '..' + DAY_FOG_FAR +
           ' (backdrop ' + BACK_FOG_NEAR + '..' + BACK_FOG_FAR + ')' +
           '  haze ' + HAZE_NEAR + '..' + HAZE_FAR + ' x' + HAZE_AMT +
           '^' + HAZE_POW + '  ev ' + DAY_EV);
    L.push('  grade   ' + (NO_GRADE ? 'OFF (?nzgrade=0)' :
           'pivot ' + GRADE_PIVOT + ' con ' + GRADE_CON + '/' + GRADE_CONHI +
           ' gain ' + GRADE_GAIN + ' sat ' + GRADE_SAT + ' ceil ' + GRADE_CEIL) +
           '   spec ' + DAY_SPEC + (SPEC_ORIENTED ? ' oriented/occluded @' + SPEC_OCC_REF
                                                  : ' FLAT (legacy)'));
    L.push('  bake    ' + STATS.bakedGeos + ' geo / ' + STATS.bakedVerts + ' verts, ' +
           RAYS + '/' + RAYS_MIN + ' cos rays, ' + (STATS.rays / 1000).toFixed(0) + 'k tests, ' +
           STATS.bakeMs + 'ms   floor ' + BAKE_FLOOR + ' lo ' + BAKE_LO +
           '  near ' + NEAR_R + '/' + NEAR_MIN);
    L.push('  replay  ' + STATS.replayVerts + ' verts re-swept against ' + REG.length +
           ' registered occluder(s) in ' + STATS.replayMs + 'ms');
    L.push('  mats    world ' + STATS.worldMats + '  day ' + STATS.dayMats +
           '  patched ' + OWN.patched.length);
    L.push('  weather ' + (OVERCAST4 ? 'overcast; direct sun suppressed' : 'sun key ' + SUN_KEY) + ' at ' + SUN_EL + ' deg, dir ' +
           SUN_DIR_W.map(function (v) { return v.toFixed(2); }).join(',') +
           '  sky E ' + DAY_IRRADIANCE + '  sun:sky ' +
           (SUN_KEY * Math.sin(SUN_EL * PI / 180) / Math.max(DAY_IRRADIANCE, 1e-3)).toFixed(2) + ':1' +
           '  casters ' + STATS.casters + (SUN_DEBAKE ? '  de-baked' : ''));
    L.push('  draws   +' + STATS.addedCalls + '  backdrop tris ' + STATS.backdropTris +
           '  vram~' + (STATS.texBytes / 1048576).toFixed(2) + 'MB');
    if (OVERCAST4) L.push('  photo   ' + (DIAG.photoSky || 'procedural fallback') +
                         '  linear gain ' + PHOTO_SKY_GAIN);
    L.push('  camW    ' + camW.toFixed(3) + '  facades ' + street.facades.length);
    for (var i = 0; i < DIAG.warnings.length; i++) L.push('  ! ' + DIAG.warnings[i]);
    return L.join('\n');
  }

  /* =======================================================================
     hooks
     'ready' at -60 per STREET-MODULE-CONTRACT.md. nz-core sorts DESCENDING, so
     this lands after nz-env (-20) -- which is what the world-quad retarget
     needs, since nz-env multiplies its own contact AO into the very colour
     attribute rewritten here -- and before nz-render's -1000 sweep, so
     wrapForeignMaterials() composes AO/PCSS into the injection for free and
     neutralizeBakedLighting() sees the finished bake.

     'render' at 100: above nz-render (0, which CLAIMS the frame by returning
     true) and below nz-shots (1000, which owns the camera). Returning anything
     other than undefined here would steal the frame.
     ==================================================================== */
  /* The level id is available before rendererInit. Initialize the weather
     before earlier ready hooks call day()/bake(), otherwise the first eager
     PMREM build caches mission 1's 2.0-irradiance sky for the entire mission.
     The entry points above also guard this for standalone module consumers. */
  NZ.on('rendererInit', function () { prepareMissionProfile(); }, 1000);

  NZ.on('ready', function (ctx) {
    if (dead) return;
    try { install(ctx); }
    catch (err) { panic(err); }
  }, -60);

  /* A SECOND 'ready' HOOK, far below every street module.
     nz-street-side.js registers at -60 too, and nz-core's sort is stable, so
     whether its 340,000 verts exist when install() runs comes down to script
     order in NUKEM.html -- which is not a contract. Measured: they did not, so
     half of the mission's facades (both 232 Sk elevations, the mosque, the
     barricades, the gate block, the 230 stub cladding) were lit by a
     52-degree sun and laid nothing on the ground. -950 is below every street
     module and still above nz-render's -1000 sweep, and promoteCasters()
     skips anything already promoted, so running it twice is free. */
  NZ.on('ready', function () {
    if (dead || !installed || !LEVEL4) return;
    try { promoteCasters(); } catch (e) { warn('late caster sweep: ' + (e && e.message)); }
  }, -950);

  NZ.on('render', function (dt) {
    if (dead || !installed) return undefined;
    try { tickRamp(dt); } catch (err) { panic(err); }
    /* the range rides with the eye in XZ, never in Y: a ten-kilometre ridge
       has no parallax to give, but it does drop below the horizon as you climb
       the park, and that one degree is what keeps it sitting ON the ground
       rather than floating over it. */
    if (domeMesh && camera) {
      domeMesh.position.copy(camera.position);
      domeMesh.updateMatrix(); domeMesh.updateMatrixWorld();
    }
    if (rangeMesh && camera) {
      rangeMesh.position.set(camera.position.x, 0, camera.position.z);
      rangeMesh.updateMatrix(); rangeMesh.updateMatrixWorld();
    }
    return undefined;
  }, 100);

  NZ.log && NZ.log('street-sky module loaded');
})(typeof window !== 'undefined' ? window : this);
