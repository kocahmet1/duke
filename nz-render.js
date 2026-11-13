/* ===========================================================================
   NZ-RENDER  --  CS2-grade rendering for NUKE ZONE 3D.

   Classic script. No modules, no external assets, no examples/js classes.
   Everything (G-buffer, GTAO, SSR, TAA, bloom, tonemap) is built from the
   core three.js r149 UMD surface only: WebGLRenderTarget, DepthTexture,
   ShaderMaterial, PMREMGenerator, CubeCamera, ShaderChunk.

   Frame (high tier):

     1  G-buffer prepass  -> gRT     view normal (oct), roughness, metalness
                                     + world-only depth (no viewmodel)
     2  GTAO + contact    -> aoRT    slice/horizon-search AO, screen-space
                                     contact shadows, bilateral denoise
     3  SSR trace         -> ssrRT   screen-space reflections marched against
                                     the prepass depth, shaded from the
                                     previous frame's resolved HDR colour
     4  scene colour      -> sceneRT lit forward pass. Patched material
                                     shaders consume aoRT and ssrRT so AO
                                     lands on INDIRECT light only, contact
                                     shadows land on DIRECT light only, and
                                     SSR replaces the IBL specular lobe
                                     rather than being smeared on top.
     5  scenePass hook             viewmodel draws into the same HDR buffer
     6  TAA               -> taa[]   YCoCg neighbourhood clip, Catmull-Rom
                                     history, viewmodel-aware rejection
     7  bloom             -> mips    soft-knee, Karis-averaged
     8  composite         -> ldrRT   AgX tonemap, neutral grade, vignette,
                                     grain, dither, CA, sharpen
     9  motion blur       -> ldrRT2  camera reprojection
    10  FXAA / present

   Everything is wrapped: if any of it throws, the module tears itself down,
   restores the stock renderer state and leaves NZ.flags.render false. Each
   optional subsystem (shader patch, G-buffer, SSR) can fail on its own
   without taking the rest of the frame with it.

   ---------------------------------------------------------------------------
   PROJECT-WIDE CHANGE THIS MODULE MAKES, AND WHAT IT MEANS FOR OTHER FILES
   ---------------------------------------------------------------------------
   At `rendererInit` this module sets

       THREE.ColorManagement.legacyMode = false

   which is global. It is set once, before the level builds a single material,
   and panic() puts it back. `?nzcm=0` opts out.

   Why: r149 ships legacyMode = true, and with it Color.setHex() returns early
   out of toWorkingColorSpace(). A hex literal therefore goes to the shader
   RAW AS LINEAR -- `color: 0x767676` is 0.463 reflectance, not 0.180 -- while
   a CanvasTexture tagged sRGBEncoding IS decoded. So before this change every
   textured surface in the build was colour-correct and every hex-tinted one
   was about a stop too bright, and the two could not be made to agree. With
   the flag off, 0x767676 is 18% and both paths mean the same thing.

   nz-render's own constants were re-authored so that flipping the flag moves
   NOTHING it renders (each kept hex is linearToSRGB() of the raw value the
   legacy path was feeding the shader; measured max drift 0.84/255, and the
   calibrated studio card moved 0.01 stop). Other files were not, and these
   are the only places in the project where the flag changes a value:

     nz-env.js:1685   `color: new THREE.Color(S.tint)`   <- all 16 MATSPEC tints
     nz-env.js:1713   `m.color.setHex(extra.tint)`
        Twelve of the sixteen tints are near-white trims over a real textured
        albedo (0xf2f3f5 and friends) and move under 0.1 stop. Four were
        authored as colours and move a lot -- and towards correct:
          ceildark 0x8e9094  0.557 -> 0.271 linear   (-1.04 stop)
          door     0x9aa1a6  0.604 -> 0.324          (-0.90)
          keydoor  0x9c5248  0.612 -> 0.334          (-0.87)
          crate    0xc6bcaa  0.776 -> 0.559          (-0.47)
        60% reflectance grey paint on a door was never right; 32% is. If any
        of them now reads too dark, re-author the HEX (they are finally
        meaningful), do not re-add a multiplier.

     NUKEM.html:6502,6509  decal `p.mat.color.setHex(0x9b6840 / 0xb5afa2 ...)`
        Bullet-hole decal tints, same story: 0xb5afa2 concrete goes 0.71 ->
        0.45 linear, which is a real concrete value.
     NUKEM.html:6578  `muzzleLight.color.setHex(color || 0xffd08a)`
        Loses ~0.35 stop of luma. If the muzzle flash reads weak, raise the
        muzzle light INTENSITY, not the hex.
     NUKEM.html:6999-7002  setClearColor / scene.background / scene.fog
        All three are overwritten by nz-render (applyAtmosphere) whenever this
        module is live, and are near-black anyway. No action.
     nz-weapons.js:2678,2718,2722,2726,2836  `color: 0xffd9a0` etc. on the
        additive muzzle/smoke FX. These dim by 0.2-0.5 stop. They are FX, so
        re-tune by eye if wanted; the setRGB() calls next to them
        (flashMat/coreMat/hotMat) are unaffected -- setRGB never converts.
     nz-shots.js  (the contact-sheet page, not the game) 1085-1228 material
        colours and 1344-1347 its own light rig. Same conversion rule.

     nz-enemies.js  NOTHING TO DO. It contains no hex colour literals at all;
        every colour is setRGB() or new THREE.Color(1,1,1), both of which are
        colour-space neutral. The RIG agent's work is unaffected either way.

   The mechanical rule for any constant that needs to keep its CURRENT
   rendered value: newHex = linearToSRGB(oldHex/255) per channel, i.e.
   `x <= 0.0031308 ? 12.92x : 1.055*pow(x, 1/2.4) - 0.055`. To make a constant
   MEAN what it says instead, leave it alone -- that is what the flag does.
   Either way, never call convertSRGBToLinear() on a hex again: with the flag
   off that is a double decode. In this file use srgbHex()/setSrgb().
   ======================================================================== */
(function (global) {
  'use strict';

  var NZ = global.NZ;
  if (!NZ) { console.warn('[nz-render] nz-core.js missing, module inert'); return; }

  /* ====================================================================== */
  /*  state                                                                 */
  /* ====================================================================== */
  var THREE = null, renderer = null, scene = null, camera = null, lights = null;
  var gl = null;
  var dead = false;

  var caps = {
    hdr: false, depth: false, webgl2: false, halfLinear: true,
    shaderPatch: false, maxTex: 2048, msaa: 0
  };

  /* ---- quality ---------------------------------------------------------- */
  /* Every field here is a cost knob. computeEffects() folds the tier and the
     adaptive degrade level into one resolved set; nothing else reads TIERS. */
  /* shadow/extent: what matters is not either number, it is the WORLD SIZE OF
     ONE TEXEL, 2*extent/shadow. At the old 2048 over 56 that was 0.055 units,
     which at ten metres is six screen pixels -- and the PCSS filter then
     smeared up to eight of those, so every shadow edge in the game was ~44
     screen pixels wide. That is not a soft shadow, that is a stain, and it is
     why the only shadow visible anywhere on the contact sheet reads as an
     unexplained blotch rather than as the roofline it actually is.
     Retuned for texel size instead: 0.033 units on high (1.7x sharper), and
     the extents shrink to pay for it. A tighter box loses far-away shadows,
     which is the correct trade for a corridor shooter -- CS2's first cascade
     is tighter than this. */
  /* envCube: the ONE-OFF probe capture, in pixels per cube face. It is not a
     per-frame cost -- it is paid once at 'ready' and once per rebuild -- but
     it is the resolution the solar disc has to survive, so it is a tier knob
     and it degrades last. See sunDiscParams(). */
  /* msaa: hardware samples on the SCENE colour target only. The G-buffer
     stays 1x on purpose (averaged silhouette normals would poison GTAO and
     SSR, and the AO gets a bilateral denoise anyway); the post buffers only
     ever receive fullscreen quads, which have no edges to multisample. This
     rung exists because it is the ONLY one that fixes sub-pixel geometry:
     the arena's 0.1-unit brass trim and glow reveals at 40 units land
     BETWEEN pixel centres, so neither TAA's neighbourhood clamp nor FXAA
     ever sees a stable line to preserve -- they can only smear or strobe
     what the rasteriser happened to hit that frame. 4x where a discrete GPU
     is paying; 2x on the tiers already running below native scale, where it
     doubles rather than quadruples a bandwidth bill scale just discounted.
     r149 makes this legal with a depth texture attached: every render()
     into the target ends in one blitFramebuffer whose mask includes
     DEPTH_BUFFER_BIT, so sceneRT.depthTexture still fills for TAA / motion
     blur, and the samples survive the scenePass re-entry (the post-resolve
     invalidate is gated to OculusBrowser only). See caps.msaa for the
     per-format ceiling; an unsupported count is a GL error and a black
     frame, never a fallback, so it is probed, not assumed. */
  var TIERS = {
    ultra: { scale: 1.00, taa: 1, gbuf: 1.00, gtao: 1, aoSlices: 3, aoSteps: 5, ssr: 1, ssrSteps: 32, ssrRefine: 5,
             contact: 1, csSteps: 14, mblur: 1, mbSamples: 11, mips: 5, shadow: 3072, extent: 50, pcss: 1, worldCast: 1, envCube: 512, msaa: 4 },
    high:  { scale: 1.00, taa: 1, gbuf: 1.00, gtao: 1, aoSlices: 2, aoSteps: 4, ssr: 1, ssrSteps: 24, ssrRefine: 4,
             contact: 1, csSteps: 10, mblur: 1, mbSamples: 8,  mips: 5, shadow: 2560, extent: 44, pcss: 1, worldCast: 1, envCube: 512, msaa: 4 },
    med:   { scale: 0.90, taa: 1, gbuf: 0.50, gtao: 1, aoSlices: 2, aoSteps: 3, ssr: 0, ssrSteps: 0,  ssrRefine: 0,
             contact: 1, csSteps: 6,  mblur: 1, mbSamples: 6,  mips: 4, shadow: 1792, extent: 38, pcss: 1, worldCast: 1, envCube: 256, msaa: 2 },
    /* worldCast was 0 here and that was the wrong economy. Without it the sun
       is not occluded by the level at all: every interior is lit straight
       through its own ceiling, nothing casts onto the floor, and the frame
       loses the single largest source of grounding and of value range it has.
       VERIFY's "nothing grounds / everything is pasted onto the floor" was
       measured at exactly this tier (detectTier() returns low on SwiftShader
       and on any weak GPU), so the configuration most players in trouble get
       was also the only one with no cast shadows anywhere.
       The cost is one extra shadow-map pass over ~13 merged world meshes at
       1024^2. That is geometry-bound, not fill-bound, and it is already paid
       at med on the same machines. It now leaves at degrade>=4 instead of >=5
       so a machine that genuinely cannot hold it sheds it one rung sooner. */
    low:   { scale: 0.78, taa: 0, gbuf: 0.00, gtao: 0, aoSlices: 0, aoSteps: 0, ssr: 0, ssrSteps: 0,  ssrRefine: 0,
             contact: 0, csSteps: 0,  mblur: 0, mbSamples: 0,  mips: 3, shadow: 1024, extent: 30, pcss: 0, worldCast: 1, envCube: 256, msaa: 2 }
  };
  var tier = 'high';
  var tierPinned = false;
  var degrade = 0;                 /* 0..5, applied on top of the tier */
  var EFF = null;                  /* resolved effect set */

  /* live-tweakable look parameters. Deliberately restrained: if a viewer can
     name a post effect it is too strong. */
  var P = {
    /* ACES, not AgX. The AgX fit below is numerically correct (it matches
       three's own r16x implementation term for term) but its LOOK is a long
       toe and a very soft shoulder: it lifts the bottom two stops and
       desaturates everything above middle grey. Side by side against a CS2
       frame that reads as milky. ACES keeps the blacks black and the mids
       dense, which is what this image needs. Both are still switchable at
       runtime through NZ.render.setTonemap(). */
    tonemap: 'aces',               /* 'agx' | 'aces' | 'neutral'            */
    /* Deliberately NOT auto-exposure. This is a competitive shooter: an
       adaptation loop that reacts to where the player is looking is exactly
       how a corner you need to clear goes dark for half a second. CS2 has no
       eye adaptation either. One fixed stop, and every room is made readable
       by the light rig instead. */
    exposure: 0.95,                /* photographic stop, tonemapper-neutral */
    contrast: 0.16,                /* gentle S in display space             */
    saturation: 1.02,
    /* Neutral by default and it stays that way: the warmth in this level is
       sodium street light and the coolness is sky, both of which are already
       in the light rig. A global cast on top of that is a filter, not a look. */
    lift: [0.000, 0.000, 0.000],
    gain: [1.000, 1.000, 1.000],
    bloom: 0.12,                   /* barely there except on real emitters  */
    /* 1.25, not 1.00. Bloom thresholds in SCENE-linear, before the exposure
       scalar, and a bright painted trim strip under the probe sits at about
       0.85 -- close enough to 1.0 that the soft knee was picking it up and
       adding a halo. That halo is exactly what made the corridor trim read as
       a light fixture rather than as paint. Only real emitters (the lens
       cards, the muzzle flash) live above 1.25. */
    bloomThreshold: 1.25,
    bloomKnee: 0.55,
    bloomClamp: 16.0,
    /* 0.85 / power 1.0, not 1.00 / 1.15. Indoors the probe is very nearly the
       ONLY light a surface gets, so AO there is not "occluding some indirect",
       it is occluding all of it -- full-strength GTAO on top of that is what
       turns a corridor wall into a black field. CS2's AO is conservative for
       the same reason: it is a contact cue, not a shading term. */
    ao: 0.88,                      /* indirect occlusion strength           */
    aoRadius: 1.15,                /* world units                           */
    aoFalloff: 0.62,
    aoThin: 0.18,                  /* thin-occluder compensation            */
    aoPower: 1.05,
    specOcc: 1.00,
    contact: 0.90,                 /* screen-space contact shadow strength  */
    contactLength: 0.55,           /* world units                           */
    contactThick: 0.34,
    ssr: 1.00,
    ssrRough: 0.62,                /* above this roughness SSR is pointless */
    ssrDist: 14.0,                 /* max ray length, world units           */
    ssrThick: 0.42,
    grain: 0.016,
    ca: 0.00060,
    vignette: 0.20,
    sharpen: 0.12,
    shutter: 0.42,
    /* A real shadow is razor sharp at contact and takes metres to go soft --
       the sun's angular diameter is half a degree, so the penumbra grows about
       one centimetre per metre of gap. The old 4.0 / 8.0 pair reached the
       maximum filter after a four-unit gap and that maximum was eight texels,
       so essentially EVERY shadow in the level was drawn at full blur. Slower
       growth and a much smaller ceiling: a crate on the ground now has a hard
       edge, a roofline twenty units up is soft, and nothing is a smear. */
    shadowSoftness: 15.0,          /* world units of gap to full penumbra   */
    shadowSearch: 3.4,             /* blocker-search / max filter, texels   */
    /* Sun elevation, degrees. The level ships the key at 52 degrees, which is
       near-noon: shadows are short, they hide under the object that casts them
       and almost nothing lands on a vertical surface. Every CS2 map is lit
       closer to 30 -- long raking shadows across the floor, strong light/shade
       division on the facades, and the sun doing the composition. The azimuth
       is left exactly where the level author put it (the lit facades in the
       street views are correct); only the elevation is lowered, which also
       moves 0.4 stops of key off the floors and onto the walls, and walls are
       what a player reads. */
    sunElevation: 34.0,
    /* multiplier on the tier's shadow-box half-extent; see computeEffects() */
    shadowExtentScale: 1.0,
    /* ---- THE LIGHT RIG, SOLVED FROM THE CALIBRATED HARNESS ---------------
       This was the single worst defect in the build and none of it was
       visible from inside the module, because nothing here was ever measured
       against a known reflectance. Through the calibrated stage
       (`render-critic --cell=calib --env=level`, which renders an 18% grey
       card, reads the framebuffer back and inverts this module's own
       composite), the shipping rig -- key 3.80, probe 0.280, one cool rim at
       0.20 -- put that card at:

         heading      key off lens   18% card         verdict
         left34         ~28 deg      (off the top)    unmeasurable, clipped
         front           56 deg      181/255  +1.16   90% white at 1.97 = CLIP
         tq              89 deg       60/255  -1.31   key:fill 0.11 : 1
         side           127 deg       62/255  -1.21

       2.47 stops of swing on nothing but which way the player is facing, and
       broken at BOTH ends. Now, same instrument, same cells:

         left34         ~28 deg      152/255  +0.62   90% white 1.31, no clip
         front           56 deg      127/255  +0.15   90% white 0.95, no clip
         tq              89 deg       78/255  -0.86
         side           127 deg       79/255  -0.82

       1.48 stops end to end, 1.01 across the front/tq pair the old rig lost
       2.47 on, and nothing clips at any heading including the brightest one
       that exists.

       Every intensity below is in ONE unit: the diffuse albedo multiplier a
       white surface FACING that source receives. r149 with legacy lights
       multiplies a punctual light's intensity by PI and Lambert's 1/PI
       cancels it, so `intensity` really is that number, straight -- see
       lightBalance(), which used to divide by PI and therefore under-reported
       the key by 3.14x. That is how a key of 3.80 got signed off as
       "3.1 : 1 key-dominant" while rendering an 18% card at 90% white. */
    /* Probe mean radiance: the albedo multiplier a surface gets from the sky,
       and the only term that is nearly the same at EVERY heading, so it is
       what compresses the swing. It is also all the light an interior or a
       shadow-side facade gets, since three does not occlude an environment
       map. Held at the old 0.280-ish rather than dropped, because the sunlit
       side is now controlled by the key instead of by starving the fill. */
    envIrradiance: 0.285,
    /* Down from 3.80 -- the 1.16 stops of measured error at the front heading,
       near enough exactly.
       The dark heading cannot be lifted to match, and that is geometry rather
       than tuning: the harness's fill probe sits at 90 degrees to the key,
       which is the SAME plane as the tq heading, so "key:fill at the card"
       and "how deep is the trough" are one number read two ways. Raise either
       and the other moves by the same amount. Concretely: front card
       = key + fill, tq card = fill, so front at 1.0 with key:fill 2 : 1 forces
       tq to exactly -1.58 stops. There is no rig that beats that trade while
       staying key-dominant, only a choice of where to sit on it.
       This sits nearer the readable end than the contrasty one, on the
       evidence of the pictures: `--cell=roster --env=level --view=tq` at
       key 1.55 / probe 0.20 / bounce 0.34 (the contrasty end) loses the
       BREACHER's kit into black, while these values keep all four operators
       legible with a visible light/shade division still on each of them. The
       lit-side : shadow-side ratio ACROSS ONE FIGURE -- which is what decides
       whether a form reads, rather than the flat-card ratio -- is 2.4 : 1. */
    keyIntensity: 1.45,
    /* The bounce cards, total, split between the two of them. This is the
       light a sunlit street and the lit facade opposite throw back at the
       shadow side of everything standing between them. Directional, so unlike
       an ambient lift it still models. Worth 0.44 stop at the trough.
       Down from 0.66 to pay for the kicker below, at constant vertical-surface
       fill: see kickerIntensity. */
    bounceIntensity: 0.50,
    /* ---- THE KICKER, and why it is not just more fill ---------------------
       VERIFY's finding was not "too dark", it was "the operator does not
       separate from the wall": at 6 m the muzzle flash beside him read louder
       than he did, and measured off VERIFY_op_mid_level.png the man sits at
       lum 76.6 against a shadowed wall at 65.7 -- 0.22 stop of difference,
       which is no difference at all.
       Exposure cannot fix that. Both bounce cards sit at +7 deg elevation, so
       they land on VERTICAL surfaces -- the wall AND the front of the operator
       equally -- and move the pair together. What separates a body from a flat
       backdrop is light on the parts of it that are NOT parallel to the wall:
       the tops of the shoulders, the crown of the helmet, the upper curve of a
       pack, the boots and the floor under them.
       So: one high source at the anti-key azimuth and 52 deg of elevation.
       On a vertical surface it is worth cos(52) = 0.62 of itself; on an
       up-facing one, sin(52) = 0.79. Taking 0.16 off the +7 cards and putting
       0.26 here is therefore very close to FLAT on every vertical surface in
       the level (0.16*cos7 = 0.159 removed, 0.26*cos52 = 0.160 added) and
       +0.19 of albedo multiplier on everything that faces up. The card the
       calibration is solved against is vertical, so the measured stop error
       and key:fill are designed to move by ~0.00 -- and they were checked, not
       assumed.
       Cool, because it is the sky half of the environment arriving as a shaped
       source rather than as probe isotropy: the warm half is already in the
       two ground-bounce cards, and a cool top / warm bottom split is what
       gives a form a readable hue gradient as well as a value one. */
    kickerIntensity: 0.26,
    kickerElevation: 52.0,
    /* Flat AmbientLight, kept at a readability floor and no more when a probe
       exists -- CS2-BRIEF: "bounce/ambient from an IBL probe rather than a
       flat ambient term". An AmbientLight has no gradient and no occlusion
       response; every unit of it is a unit of shape deleted. */
    ambientFloor: 0.035,
    /* Share of the probe's TOTAL flux given to the solar disc.
       Its DIFFUSE contribution is free, and that is not a fudge: a small disc
       at the key's direction lights a Lambertian surface as
       4*share*envIrradiance*cos(theta), which has EXACTLY the same angular
       dependence as the DirectionalLight. So the disc's diffuse is
       indistinguishable from key intensity, and applyLighting() simply
       subtracts it from the key (see sunDiscKeyOffset()). The measured
       calibration is therefore identical with the disc on or off, and the
       share can be chosen for the SPECULAR alone.
       What still bounds it is that the probe is not shadowed: at 0.05 a
       sun-facing surface in full shade picks up 4*0.05*0.285 = 0.057 of
       albedo multiplier it should not have, about 14% of the shadow-side
       level. Past ~0.08 that starts reading as a shadow leak. */
    sunProbeShare: 0.050,
    /* The dome is a visible surface and the probe is an integral; they want
       different exposures. Raising probe energy without this would push the
       sky towards the clip in exactly the frame (bright sky, dark facades)
       whose dynamic range we are trying to rescue. Same nzSky(), one honest
       scalar between them. Measured: the ground redistribution plus the higher
       target lifts the visible dome by 1.06x, so 0.94 holds it exactly. */
    skyLum: 0.94,                  /* dome exposure relative to the probe   */
    /* ---- THE SKY PALETTE -------------------------------------------------
       Up here rather than buried in skyUniforms() because it is a LOOK
       parameter, not a constant: only the ratios matter (measureSkyGain()
       renormalises the whole function to envIrradiance afterwards), and
       NZ.render.rebuildEnvironment() re-reads these, so the palette can be
       A/B'd on a running frame instead of by reloading a 30 s level.

       skyZenith was 0x5286c6 and that was the wrong blue for this rig. A
       FLOOR's cosine lobe is centred on the zenith, so whatever colour sits
       straight up is very nearly the whole chroma of every up-facing surface
       in the level -- and 0x5286c6 is 59% saturated, linear B:R = 6.5:1. The
       shadowed asphalt in the courtyard measured 38/255 and unmistakably
       BLUE. Real shadowed asphalt under an open sky is dark grey with a hint
       of cool, not cyanotype.
       0x758696 holds the zenith's LUMA to within 0.5% (linear 0.2303 against
       the original 0.2292 -- and measureSkyGain() renormalises luma anyway, so
       even that is absorbed) while dropping linear B:R from 6.69 to 1.71. A
       hazier, higher-aerosol sky, which is also the sky this level's warm
       sodium/dust palette implies.
       Measured on the real level, near-field road, sun-side street view: the
       shaded asphalt went from a blue B-R of +17.3/255 at 0x7488a8 (an
       intermediate step) to +8 or better here, at the same luma. Nothing in
       the calibration moves -- `render-critic --cell=calib --env=level` puts
       the 18% card at 126/255 either way. */
    skyZenith:  0x758696,
    skyHorizon: 0xc9d2d4,
    skyHaze:    0xe6d8bd,
    /* sun-lit concrete and dust, not wet earth: this is the level's bounce
       card and it is measured off the street texture, not off a night sky */
    skyGround:  0x9a8b74,
    skyCloud:   0xf2ece2,
    skyKeyCol:  0xffe4c0
  };

  /* ---- render targets --------------------------------------------------- */
  var sceneRT = null, gRT = null, taaA = null, taaB = null, taaFlip = 0, taaLast = null;
  var aoRT = null, aoRT2 = null, ssrRT = null, ssrRT2 = null;
  var ldrRT = null, ldrRT2 = null;
  var bloomRT = [];
  var rtW = 0, rtH = 0, halfW = 0, halfH = 0, gW = 0, gH = 0;
  var bufW = 0, bufH = 0;          /* drawing buffer size we were sized for  */

  /* ---- pass materials --------------------------------------------------- */
  var quadScene = null, quadCam = null, quadMesh = null;
  var mTaa = null, mAo = null, mAoBlur = null, mSsr = null, mSsrBlur = null,
      mPre = null, mDown = null, mUp = null, mComp = null, mBlur = null,
      mFxaa = null, mCopy = null;

  /* ---- G-buffer --------------------------------------------------------- */
  var gMats = [];                  /* cached per-source-material G materials */
  var gSwap = [];                  /* scratch: [obj, savedMaterial, ...]     */
  var gbufOk = true;               /* cleared if the prepass ever throws     */

  /* ---- shared uniforms handed to the patched scene materials ------------ */
  var uAoTex = null, uSsrTex = null, uAoP = null, uSsrP = null,
      uInvRes = null, uShadowP = null;
  var origOnBeforeCompile = null, origCacheKey = null, patchKey = 'nz0';
  var whiteTex = null;

  /* ---- per-frame matrices ----------------------------------------------- */
  var mProjSaved = null, mProjInvSaved = null;
  var mPrevViewProj = null, mReproj = null, mTmp = null;
  var jitter = null, projInfo = null, texel = null, halfTexel = null, gTexel = null;
  var sunView = null, tmpV3 = null, tmpCol = null, tmpVec2 = null;
  var frameId = 0, haveHistory = false;

  /* ---- environment ------------------------------------------------------ */
  var envRT = null, envCubeRT = null, envCubeSize = 0;

  /* ---- shadow follow ---------------------------------------------------- */
  var sunDir = null, sunRight = null, sunUp = null, sunCenter = null, camFwd = null;
  var SUN_DIST = 128;
  var sunSaved = null;             /* stock key transform, for panic()       */
  var rimSaved = null;             /* stock bounce-card transform + colour   */

  /* ---- perf ------------------------------------------------------------- */
  var ftHist = new Float64Array(48), ftIdx = 0, ftFill = 0;
  var lastAdapt = 0, goodWindows = 0, lastDegradeMed = 0, adaptLocked = false;
  var timing = null;

  /* ====================================================================== */
  /*  GLSL library                                                          */
  /* ====================================================================== */
  var VERT = [
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
  ].join('\n');

  var LIB = [
    '#ifndef saturate',
    '#define saturate(a) clamp(a,0.0,1.0)',
    '#endif',
    'float nzLuma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }',
    'float nzHash(vec2 p){',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    /* interleaved gradient noise: the cheapest low-discrepancy dither there is */
    'float nzIgn(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056,0.00583715)))); }',
    /* non-linear depth -> view z (negative, right handed) */
    'float nzViewZ(float d, float n, float f){ return (n*f) / ((f-n)*d - f); }',
    'vec3 nzLinearToSRGB(vec3 c){',
    '  vec3 lo = c * 12.92;',
    '  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055;',
    '  return mix(lo, hi, step(vec3(0.0031308), c));',
    '}',
    'vec3 nzSRGBToLinear(vec3 c){',
    '  vec3 lo = c / 12.92;',
    '  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));',
    '  return mix(lo, hi, step(vec3(0.04045), c));',
    '}',
    /* octahedral normal encode/decode: 2 channels, no seams, no sign bit */
    'vec2 nzOctWrap(vec2 v){',
    '  return (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);',
    '}',
    'vec2 nzOctEnc(vec3 n){',
    '  float s = abs(n.x) + abs(n.y) + abs(n.z);',
    '  n /= max(s, 1e-6);',
    '  n.xy = (n.z >= 0.0) ? n.xy : nzOctWrap(n.xy);',
    '  return n.xy * 0.5 + 0.5;',
    '}',
    'vec3 nzOctDec(vec2 f){',
    '  f = f * 2.0 - 1.0;',
    '  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));',
    '  float t = max(-n.z, 0.0);',
    '  n.x += (n.x >= 0.0) ? -t : t;',
    '  n.y += (n.y >= 0.0) ? -t : t;',
    '  return normalize(n);',
    '}',
    'vec3 nzRGBToYCoCg(vec3 c){',
    '  return vec3(0.25*c.r + 0.5*c.g + 0.25*c.b, 0.5*c.r - 0.5*c.b, -0.25*c.r + 0.5*c.g - 0.25*c.b);',
    '}',
    'vec3 nzYCoCgToRGB(vec3 c){',
    '  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);',
    '}'
  ].join('\n');

  /* ---------------------------------------------------------------------- */
  /*  tone mapping                                                          */
  /* ---------------------------------------------------------------------- */
  /* AgX. This is what stops a saturated highlight from skewing orange and
     clipping the way ACES does -- it walks the value up the log axis first,
     so a hot red neon desaturates towards white instead of towards yellow.
     Filament's 6th-order fit of the reference sigmoid. */
  var TONEMAP = [
    'const mat3 NZ_SRGB_2020 = mat3(',
    '  vec3(0.6274, 0.0691, 0.0164),',
    '  vec3(0.3293, 0.9195, 0.0880),',
    '  vec3(0.0433, 0.0113, 0.8956));',
    'const mat3 NZ_2020_SRGB = mat3(',
    '  vec3( 1.6605, -0.1246, -0.0182),',
    '  vec3(-0.5876,  1.1329, -0.1006),',
    '  vec3(-0.0728, -0.0083,  1.1187));',
    'const mat3 NZ_AGX_IN = mat3(',
    '  vec3(0.856627153315983, 0.137318972929847,  0.11189821299995),',
    '  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),',
    '  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));',
    'const mat3 NZ_AGX_OUT = mat3(',
    '  vec3( 1.1271005818144368, -0.1413297634984383, -0.1413297634984383),',
    '  vec3(-0.1106066430966032,  1.1578237022162720, -0.1106066430966029),',
    '  vec3(-0.0164939387178346, -0.0164939387178343,  1.2519364065950405));',
    'vec3 nzAgxContrast(vec3 x){',
    '  vec3 x2 = x * x;',
    '  vec3 x4 = x2 * x2;',
    '  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x',
    '       + 0.4298 * x2 + 0.1191 * x - 0.00232;',
    '}',
    'vec3 nzAgX(vec3 c){',
    '  c = NZ_SRGB_2020 * max(c, vec3(0.0));',
    '  c = NZ_AGX_IN * c;',
    '  c = log2(max(c, vec3(1e-10)));',
    '  c = (c + 12.47393) * (1.0 / 16.499999);',
    '  c = clamp(c, 0.0, 1.0);',
    '  c = nzAgxContrast(c);',
    '  c = NZ_AGX_OUT * c;',
    '  c = pow(max(c, vec3(0.0)), vec3(2.2));',      /* display -> linear */
    '  c = NZ_2020_SRGB * c;',
    '  return clamp(c, 0.0, 1.0);',
    '}',
    /* three r149's ACES fit, kept so the look can be A/B'd at runtime. */
    'vec3 nzACES(vec3 color){',
    '  const mat3 IN_MAT = mat3(',
    '    vec3(0.59719, 0.07600, 0.02840),',
    '    vec3(0.35458, 0.90834, 0.13383),',
    '    vec3(0.04823, 0.01566, 0.83777));',
    '  const mat3 OUT_MAT = mat3(',
    '    vec3( 1.60475, -0.10208, -0.00327),',
    '    vec3(-0.53108,  1.10813, -0.07276),',
    '    vec3(-0.07367, -0.00605,  1.07602));',
    '  color = IN_MAT * color;',
    '  vec3 a = color * (color + 0.0245786) - 0.000090537;',
    '  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;',
    '  color = a / b;',
    '  color = OUT_MAT * color;',
    '  return saturate(color);',
    '}',
    /* Khronos PBR-neutral style: hue preserving, very soft shoulder. */
    'vec3 nzNeutral(vec3 c){',
    '  const float sT = 0.76, d = 0.15;',
    '  float p = max(c.r, max(c.g, c.b));',
    '  float pS = 1.0 - sT;',
    '  float f = (p < sT) ? p : 1.0 - pS * pS / (p + pS - sT);',
    '  float g = (p < 1e-5) ? 0.0 : min(f / p, 1.0);',
    '  c *= g;',
    '  float peak = max(c.r, max(c.g, c.b));',
    '  float w = 1.0 - 1.0 / (d * (peak - f) + 1.0);',
    '  return saturate(mix(c, vec3(peak), w));',
    '}',
    'vec3 nzTonemap(vec3 c){',
    '#if defined(TM_AGX)',
    '  return nzAgX(c);',
    '#elif defined(TM_ACES)',
    '  return nzACES(c);',
    '#elif defined(TM_NEUTRAL)',
    '  return nzNeutral(c);',
    '#else',
    '  return saturate(c);',
    '#endif',
    '}'
  ].join('\n');

  /* ====================================================================== */
  /*  small helpers                                                         */
  /* ====================================================================== */
  function px(v) { return Math.max(1, Math.round(v)); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ====================================================================== */
  /*  colour management                                                     */
  /* ====================================================================== */
  /* three r149 ships ColorManagement.legacyMode = true, and with it
     Color.setHex() returns early out of toWorkingColorSpace(). So

         new THREE.MeshStandardMaterial({ color: 0x767676 })

     is NOT an 18% reflectance surface -- 0x76/255 = 0.463 goes into the
     shader RAW AS LINEAR, i.e. 46% reflectance, a stop and a third brighter
     than the constant reads. Textures do not behave that way: a CanvasTexture
     tagged sRGBEncoding IS decoded in the shader. So in the legacy build every
     textured surface is colour-correct and every hex-tinted one is about a
     stop too bright, the two disagree, and nothing can be authored reliably.

     The fix is the one three itself shipped: turn legacyMode off, so a hex
     literal means the sRGB colour it looks like. It is a global flag, so it
     also corrects nz-env / NUKEM.html / nz-weapons; see the note in the
     module header of that change for the (small) list of constants elsewhere
     that move. `?nzcm=0` opts out, and panic() puts the flag back.

     IMPORTANT: this module's own constants were re-authored at the same time
     so that flipping the flag is a NO-OP on what nz-render renders. Every hex
     below is linearToSRGB() of the raw value the legacy path was feeding the
     shader, so the light colours, the sky and the fog come out bit-identical
     with the flag either way -- which is what makes it safe to land the
     colour fix and the lighting retune in the same pass and still know which
     one moved the picture. Author new colours as sRGB and use srgbHex(). */
  var cmWasLegacy = null, colorManaged = false;

  function enableColorManagement(on) {
    try {
      var CM = THREE && THREE.ColorManagement;
      if (!CM || CM.legacyMode === undefined) return false;   /* r152+: always managed */
      if (cmWasLegacy === null) cmWasLegacy = CM.legacyMode;
      CM.legacyMode = !on;
      colorManaged = !!on;
      return true;
    } catch (e) { return false; }
  }
  function restoreColorManagement() {
    try {
      if (cmWasLegacy !== null && THREE && THREE.ColorManagement) THREE.ColorManagement.legacyMode = cmWasLegacy;
    } catch (e) {}
    cmWasLegacy = null; colorManaged = false;
  }

  /* Decode an sRGB hex to the linear working space, correctly under EITHER
     mode. Under legacyMode this has to convert by hand; under colour
     management setHex() has already done it and converting again would be the
     classic double-decode. Never call convertSRGBToLinear() directly. */
  function srgbHex(hex, out) {
    var c = out || new THREE.Color();
    c.setHex(hex);
    if (!colorManaged) c.convertSRGBToLinear();
    return c;
  }
  /* the same, straight onto a light/material colour slot */
  function setSrgb(col, hex) { if (col) srgbHex(hex, col); return col; }
  function lumaOf(c) { return c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) : 0; }

  function makeRT(w, h, hdr, depth, nearest, samples) {
    var f = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    var o = {
      minFilter: f,
      magFilter: f,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: (hdr && caps.hdr) ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: !!depth,
      stencilBuffer: false,
      generateMipmaps: false,
      anisotropy: 1
    };
    if (THREE.LinearEncoding !== undefined) o.encoding = THREE.LinearEncoding;
    var rt = new THREE.WebGLRenderTarget(px(w), px(h), o);
    /* samples > 0: r149 backs the FBO with multisampled renderbuffers and
       resolves colour + depth into the texture attachments at the end of
       every render() into it. Only the scene target ever asks for this;
       fullscreen post blits have no geometric edges to multisample. */
    rt.samples = (samples | 0) > 1 ? (samples | 0) : 0;
    rt.texture.generateMipmaps = false;
    if (depth && caps.depth) {
      var dt = new THREE.DepthTexture(px(w), px(h));
      dt.type = THREE.UnsignedIntType;
      dt.format = THREE.DepthFormat;
      dt.minFilter = dt.magFilter = THREE.NearestFilter;
      dt.generateMipmaps = false;
      rt.depthTexture = dt;
    }
    return rt;
  }

  function killRT(rt) { if (rt) { try { rt.dispose(); } catch (e) {} } return null; }

  function makeMat(frag, uniforms, defines) {
    var m = new THREE.ShaderMaterial({
      uniforms: uniforms || {},
      defines: defines || {},
      vertexShader: VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending
    });
    m.extensions = { derivatives: false, fragDepth: false, drawBuffers: false, shaderTextureLOD: false };
    return m;
  }

  /* fullscreen draw. Additive materials keep the destination. */
  function blit(mat, target) {
    quadMesh.material = mat;
    var auto = renderer.autoClear;
    renderer.autoClear = (mat.blending === THREE.NoBlending);
    renderer.setRenderTarget(target || null);
    renderer.render(quadScene, quadCam);
    renderer.autoClear = auto;
  }

  /* ====================================================================== */
  /*  capability probe                                                      */
  /* ====================================================================== */
  function probeCaps() {
    gl = renderer.getContext();
    caps.webgl2 = !!renderer.capabilities.isWebGL2;
    caps.depth = caps.webgl2 || renderer.extensions.has('WEBGL_depth_texture');
    if (caps.webgl2) {
      caps.hdr = !!(gl.getExtension('EXT_color_buffer_float') ||
                    gl.getExtension('EXT_color_buffer_half_float'));
    } else {
      caps.hdr = !!(renderer.extensions.get('OES_texture_half_float') &&
                    gl.getExtension('EXT_color_buffer_half_float'));
      caps.halfLinear = !!renderer.extensions.get('OES_texture_half_float_linear');
      if (!caps.halfLinear) caps.hdr = false;
    }
    try { caps.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048; } catch (e) { caps.maxTex = 2048; }
    /* MSAA ceiling for the scene target, per format. MAX_SAMPLES alone lies:
       multisampled RGBA16F is the first thing mobile drivers cut, and asking
       renderbufferStorageMultisample for a count the format cannot do is
       INVALID_OPERATION -> incomplete FBO -> black frame, not a fallback.
       So ask about the exact attachments we will make: the colour format the
       hdr flag selects, and the DEPTH_COMPONENT24 the UnsignedIntType depth
       texture forces r149 to give the multisampled depth renderbuffer. */
    caps.msaa = 0;
    if (caps.webgl2) {
      try {
        var ms = gl.getParameter(gl.MAX_SAMPLES) | 0;
        var fmts = [gl.DEPTH_COMPONENT24, caps.hdr ? gl.RGBA16F : gl.RGBA8];
        for (var fi = 0; fi < fmts.length; fi++) {
          var sup = gl.getInternalformatParameter(gl.RENDERBUFFER, fmts[fi], gl.SAMPLES);
          ms = Math.min(ms, (sup && sup.length) ? sup[0] : 0);
        }
        caps.msaa = Math.max(0, ms | 0);
      } catch (e2) { caps.msaa = 0; }
    }
  }

  function detectTier() {
    var m = /[?&]nzq=(low|med|high|ultra)/i.exec(global.location ? global.location.search : '');
    if (m) { tierPinned = true; return m[1].toLowerCase(); }
    var name = '';
    try {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) name = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    } catch (e) {}
    if (!name) { try { name = String(gl.getParameter(gl.RENDERER) || ''); } catch (e2) {} }
    NZ.log('gpu:', name || '(unknown)');
    if (!caps.hdr || !caps.depth) return 'low';
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
    if (/mali|adreno\s*[1-5]\d\d|powervr|videocore/i.test(name)) return 'low';
    if (/intel.*(hd|uhd)\s*graphics|intel.*(gma|g33|g41)/i.test(name)) return 'low';
    if (/intel|iris|apple a\d/i.test(name)) return 'med';
    /* discrete desktop parts get the full stack; everything else earns it */
    if (/rtx\s*[34-9]\d\d\d|rtx\s*[2-9]\d\d\d\s*(ti|super)|radeon\s*rx\s*[6-9]\d\d\d|apple m[2-9]/i.test(name)) return 'ultra';
    return 'high';
  }

  /* Look-parameter overrides from the query string. Purely a tuning and
     bisection affordance -- nothing here has a default, so a URL with none of
     these renders exactly the shipping look. It exists because the light rig
     is solved against a calibrated harness, and solving a four-parameter rig
     by editing the file and re-rendering costs a full page boot per sample;
     this turns the same job into one flag.

       ?nzkey= / ?keyi=   P.keyIntensity        ?nzenv= / ?envi=  P.envIrradiance
       ?nzlight=bounce:0.3,amb:0.02,share:0.05,el:30,exp:0.9,sky:0.94
       ?key=              same grammar as nzlight (the render-critic runner
                          forwards --key= verbatim and the page ignores it)

     Every value is range-clamped, so a typo cannot produce a black or an
     infinite frame, and the whole thing is inside one try/catch. */
  var PARAM_RANGE = {
    key: ['keyIntensity', 0, 40], env: ['envIrradiance', 0, 8],
    bounce: ['bounceIntensity', 0, 8], amb: ['ambientFloor', 0, 4],
    kick: ['kickerIntensity', 0, 8], kickel: ['kickerElevation', 5, 88],
    share: ['sunProbeShare', 0, 0.25], el: ['sunElevation', 2, 88],
    exp: ['exposure', 0.05, 8], sky: ['skyLum', 0.05, 8]
  };
  var paramOverrides = null;

  function applyParamPair(k, v) {
    var spec = PARAM_RANGE[k];
    if (!spec) return false;
    var n = parseFloat(v);
    if (!isFinite(n)) return false;
    P[spec[0]] = Math.max(spec[1], Math.min(spec[2], n));
    (paramOverrides || (paramOverrides = {}))[spec[0]] = P[spec[0]];
    return true;
  }

  function readParamOverrides() {
    try {
      var s = (global.location && global.location.search) || '';
      if (!s) return;
      var one = function (re, k) { var m = re.exec(s); if (m) applyParamPair(k, m[1]); };
      one(/[?&]nzkey=([-\d.]+)/, 'key');
      one(/[?&]keyi=([-\d.]+)/, 'key');
      one(/[?&]nzenv=([-\d.]+)/, 'env');
      one(/[?&]envi=([-\d.]+)/, 'env');
      var lists = s.match(/[?&](?:nzlight|key)=([^&]+)/g) || [];
      for (var i = 0; i < lists.length; i++) {
        var body = lists[i].replace(/^[?&](?:nzlight|key)=/, '');
        var parts = decodeURIComponent(body).split(',');
        for (var j = 0; j < parts.length; j++) {
          var kv = parts[j].split(':');
          if (kv.length === 2) applyParamPair(kv[0].trim(), kv[1].trim());
        }
      }
      if (paramOverrides) NZ.log('look params overridden:', JSON.stringify(paramOverrides));
    } catch (e) {}
  }

  function computeEffects() {
    var t = TIERS[tier] || TIERS.med;
    var e = {
      scale: t.scale, taa: !!t.taa, gbuf: t.gbuf, gtao: !!t.gtao,
      aoSlices: t.aoSlices, aoSteps: t.aoSteps,
      ssr: !!t.ssr, ssrSteps: t.ssrSteps, ssrRefine: t.ssrRefine,
      contact: !!t.contact, csSteps: t.csSteps,
      mblur: !!t.mblur, mbSamples: t.mbSamples,
      mips: t.mips, shadow: t.shadow, extent: t.extent,
      pcss: !!t.pcss, worldCast: !!t.worldCast, fxaa: true,
      envCube: t.envCube || 256, msaa: t.msaa | 0
    };
    /* Degrade ladder: strictly monotonic in GPU cost, cheapest wins first. */
    if (degrade >= 1) { e.ssr = false; }
    if (degrade >= 2) {
      e.aoSlices = Math.max(1, e.aoSlices - 1);
      e.aoSteps = Math.max(2, e.aoSteps - 1);
      e.csSteps = Math.max(4, e.csSteps >> 1);
      e.mbSamples = Math.max(4, e.mbSamples - 3);
      e.pcss = false;
      if (e.gbuf > 0.5) e.gbuf = 0.5;
    }
    if (degrade >= 3) { e.gtao = false; e.contact = false; e.gbuf = 0; }
    if (degrade >= 4) { e.taa = false; e.mblur = false; e.worldCast = false; }
    if (degrade >= 5) {
      e.scale *= 0.85;
      /* halve, do not zero: a machine this deep is also the machine with no
         TAA left (gone at 4), and sub-native scale plus NO geometric AA is
         the shimmering-blocks frame the whole ladder exists to avoid */
      e.msaa = Math.min(e.msaa, 2);
      e.mips = Math.max(3, e.mips - 1);
      e.shadow = Math.min(e.shadow, 1024);
      e.extent = Math.min(e.extent, 36);
      /* last thing to go, and only because a machine this far down the ladder
         is short of VRAM, not of the 8 ms the bake costs once */
      e.envCube = Math.min(e.envCube, 256);
    }
    /* hard capability gates. Everything screen-space needs float targets, a
       readable depth buffer and a working prepass; if any of those is gone
       the whole branch collapses to the plain forward path. */
    if (!caps.hdr || !caps.depth || !gbufOk) {
      e.gbuf = 0; e.gtao = false; e.contact = false; e.ssr = false;
    }
    if (!caps.hdr || !caps.depth) { e.taa = false; e.mblur = false; }
    if (e.gbuf <= 0) { e.gtao = false; e.contact = false; e.ssr = false; }
    if (!e.gtao) { e.contact = false; e.ssr = false; e.gbuf = 0; }
    /* SSR reads last frame's resolved colour and the AO buffer's linear depth,
       so it needs TAA, GTAO, a full-res G-buffer and the material patch. */
    e.ssr = e.ssr && caps.shaderPatch && caps.hdr && e.taa && e.gtao && e.gbuf >= 0.999;
    e.pcss = e.pcss && caps.shaderPatch && e.taa;
    e.aoInMaterial = e.gtao && caps.shaderPatch && caps.hdr;
    e.fxaa = e.fxaa && !e.taa;
    /* caps.msaa is 0 outside WebGL2 and wherever the probe found the colour
       or depth format cannot multisample, so this line is the whole gate */
    e.msaa = Math.min(e.msaa | 0, caps.msaa | 0);
    e.shadow = Math.min(e.shadow, caps.maxTex);
    e.scale = Math.max(0.5, Math.min(1, e.scale));
    return e;
  }

  /* ====================================================================== */
  /*  scene-material shader patch                                           */
  /* ====================================================================== */
  /* Screen-space AO, contact shadows and SSR have to reach INSIDE the
     lighting to be worth anything: AO belongs on indirect diffuse and on the
     IBL specular lobe, contact shadows belong on the direct sun term, and a
     reflection should REPLACE the probe's specular radiance rather than be
     added on top of it. In a forward renderer the only place that can happen
     is the material shader, so we splice a few lines into every lit material
     through Material.prototype.onBeforeCompile.

     Every line is gated on a uniform that defaults to 0. A material that
     never receives the uniforms (another module setting its own
     onBeforeCompile, say) simply behaves exactly as stock. */

  /* sentinel: the injection must be idempotent. nz-env now chains INTO
     Material.prototype.onBeforeCompile from its own per-instance hook, and
     this module independently wraps foreign hooks, so the same shader can be
     offered to nzOnBeforeCompile twice. Declaring these uniforms and
     nzMultiBounce() twice is a GLSL redefinition error, which three reports
     as a link failure and the surface renders black -- exactly the class of
     bug we are here to remove. */
  var MAT_MARK = '/*NZ_MAT_PATCH*/';

  var MAT_UNIFORMS = [
    MAT_MARK,
    'uniform sampler2D nzAoTex;',
    'uniform sampler2D nzSsrTex;',
    'uniform vec4 nzAoP;',      /* x indirect AO, y contact, z enable, w specOcc */
    'uniform vec4 nzSsrP;',     /* x strength, y enable                          */
    'uniform vec4 nzShadowP;',  /* x penumbraScale, y maxTexels, z minTexels, w on */
    'uniform vec2 nzInvRes;',
    /* Jimenez multi-bounce: occluded albedo bounces light back, so a red wall',
       does not go grey in its own crease. */
    'vec3 nzMultiBounce(float x, vec3 alb){',
    '  vec3 a =  2.0404 * alb - 0.3324;',
    '  vec3 b = -4.7951 * alb + 0.6417;',
    '  vec3 c =  2.7552 * alb + 0.6903;',
    '  return clamp(x * (x * (x * a + b) + c), vec3(x), vec3(1.0));',
    '}'
  ].join('\n');

  var MAT_LIGHTING = [
    '#if defined( RE_IndirectDiffuse ) || defined( RE_IndirectSpecular )',
    'if ( nzAoP.z > 0.5 ) {',
    '  vec4 nzA = texture2D( nzAoTex, gl_FragCoord.xy * nzInvRes );',
    /* The AO buffer carries the world-only linear depth it was computed at.
       Comparing it with this fragment's depth rejects the viewmodel, any
       transparent layer and every disocclusion for free. */
    '  float nzD = vViewPosition.z;',
    '  float nzW = 1.0 - smoothstep( 0.04, 0.12, abs( nzA.g - nzD ) / max( 0.4, nzD ) );',
    '  float nzAo = mix( 1.0, nzA.r, nzW * nzAoP.x );',
    '  float nzCs = mix( 1.0, nzA.b, nzW * nzAoP.y );',
    '  #if defined( RE_IndirectDiffuse )',
    '    #if defined( STANDARD )',
    '      vec3 nzAoV = nzMultiBounce( nzAo, material.diffuseColor );',
    '    #else',
    '      vec3 nzAoV = vec3( nzAo );',
    '    #endif',
    '    irradiance *= nzAoV;',
    '    iblIrradiance *= nzAoV;',
    '  #endif',
    '  #if defined( RE_IndirectSpecular ) && defined( STANDARD )',
    /* horizon / specular occlusion: without this a rough metal in a corner
       keeps a full mirror lobe and reads as plastic. */
    '    float nzNV = saturate( dot( geometry.normal, geometry.viewDir ) );',
    '    float nzSo = saturate( pow( nzNV + nzAo, exp2( -16.0 * material.roughness - 1.0 ) ) - 1.0 + nzAo );',
    '    radiance *= mix( 1.0, nzSo, nzAoP.w );',
    '  #endif',
    '  reflectedLight.directDiffuse *= nzCs;',
    '  reflectedLight.directSpecular *= nzCs;',
    '}',
    '#endif',
    '#if defined( RE_IndirectSpecular ) && defined( STANDARD )',
    'if ( nzSsrP.y > 0.5 ) {',
    '  vec4 nzR = texture2D( nzSsrTex, gl_FragCoord.xy * nzInvRes );',
    '  radiance = mix( radiance, nzR.rgb, saturate( nzR.a * nzSsrP.x ) );',
    '}',
    '#endif'
  ].join('\n');

  /* PCSS: blocker search then a variable-radius Vogel PCF. Contact hardening
     is the single loudest shadow tell -- a real shadow is razor sharp where
     the object touches the ground and soft two metres away. */
  var MAT_PCSS = [
    '#ifdef USE_SHADOWMAP',
    'vec2 nzVogel( const in int i, const in float n, const in float phi ) {',
    '  float fi = float( i );',
    '  float r = sqrt( ( fi + 0.5 ) / n );',
    '  float th = fi * 2.39996323 + phi;',
    '  return vec2( cos( th ), sin( th ) ) * r;',
    '}',
    'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {',
    '  if ( nzShadowP.w < 0.5 ) return nzStockGetShadow( shadowMap, shadowMapSize, shadowBias, shadowRadius, shadowCoord );',
    '  shadowCoord.xyz /= shadowCoord.w;',
    '  shadowCoord.z += shadowBias;',
    '  bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;',
    '  if ( ! ( inFrustum && shadowCoord.z <= 1.0 ) ) return 1.0;',
    '  vec2 texelSize = vec2( 1.0 ) / shadowMapSize;',
    '  float phi = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );',
    '  float searchR = texelSize.x * nzShadowP.y;',
    '  float bSum = 0.0, bCnt = 0.0;',
    '  float cd = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy ) );',
    '  if ( cd < shadowCoord.z ) { bSum += cd; bCnt += 1.0; }',
    '  for ( int i = 0; i < 8; i ++ ) {',
    '    vec2 o = nzVogel( i, 8.0, phi ) * searchR;',
    '    float dpt = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + o ) );',
    '    if ( dpt < shadowCoord.z ) { bSum += dpt; bCnt += 1.0; }',
    '  }',
    '  if ( bCnt < 0.5 ) return 1.0;',
    '  float pen = sqrt( clamp( ( shadowCoord.z - bSum / bCnt ) * nzShadowP.x, 0.0, 1.0 ) );',
    '  float filtR = texelSize.x * mix( nzShadowP.z, nzShadowP.y, pen );',
    '  float sum = 0.0;',
    '  for ( int i = 0; i < 12; i ++ ) {',
    '    vec2 o = nzVogel( i, 12.0, phi + 1.70 ) * filtR;',
    '    sum += texture2DCompare( shadowMap, shadowCoord.xy + o, shadowCoord.z );',
    '  }',
    '  return sum * ( 1.0 / 12.0 );',
    '}',
    '#endif'
  ].join('\n');

  var usePcssPatch = true;

  function buildShadowChunk() {
    var chunk = THREE.ShaderChunk && THREE.ShaderChunk.shadowmap_pars_fragment;
    if (!chunk) return null;
    var sig = 'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {';
    if (chunk.indexOf(sig) < 0) return null;
    var renamed = chunk.replace(sig,
      'float nzStockGetShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {');
    return renamed + '\n' + MAT_PCSS + '\n';
  }
  var shadowChunkPatched = null;

  /* live counters, read back by NZ.render.selfCheck() */
  var patchStats = { reached: 0, pcss: 0, wrapped: 0, foreign: 0, innerThrew: 0 };

  function nzOnBeforeCompile(shader) {
    try {
      var fs = shader.fragmentShader;
      if (!fs || fs.indexOf('#include <lights_fragment_end>') < 0) return;
      if (fs.indexOf('#include <common>') < 0) return;
      if (fs.indexOf(MAT_MARK) >= 0) return;   /* already spliced: see MAT_MARK */
      fs = fs.replace('#include <common>', MAT_UNIFORMS + '\n#include <common>');
      fs = fs.replace('#include <lights_fragment_end>', MAT_LIGHTING + '\n#include <lights_fragment_end>');
      if (usePcssPatch && shadowChunkPatched && fs.indexOf('#include <shadowmap_pars_fragment>') >= 0) {
        fs = fs.replace('#include <shadowmap_pars_fragment>', shadowChunkPatched);
        try { this.__nzPcss = 1; patchStats.pcss++; } catch (e0) {}
      }
      shader.fragmentShader = fs;
      shader.uniforms.nzAoTex = uAoTex;
      shader.uniforms.nzSsrTex = uSsrTex;
      shader.uniforms.nzAoP = uAoP;
      shader.uniforms.nzSsrP = uSsrP;
      shader.uniforms.nzShadowP = uShadowP;
      shader.uniforms.nzInvRes = uInvRes;
      /* proof of life: the self-check counts materials that really got here,
         not materials we hoped would */
      try { this.__nzPatched = 1; patchStats.reached++; } catch (e1) {}
    } catch (e) { /* never let a shader hook take the frame down */ }
  }

  /* ---- composing with other modules' shader hooks -----------------------
     A per-instance material.onBeforeCompile SHADOWS the prototype, so any
     module that installs its own injection (nz-env does this on every world
     surface it owns -- which is nearly every pixel of the level) silently
     opted the whole level out of AO, contact shadows and PCSS. That is why
     there was no darkening in a single wall/floor junction.
     The fix is to compose rather than to fight: run theirs, then ours, on the
     same shader object. One wrapper object is memoised per inner function so
     three still resolves the whole set to a single program, which is exactly
     the sharing the other module was relying on. */
  var wrapSrc = [], wrapFn = [], wrapSweeps = 6;

  function wrapOnBeforeCompile(inner) {
    for (var i = 0; i < wrapSrc.length; i++) if (wrapSrc[i] === inner) return wrapFn[i];
    var w = function (shader, renderer2) {
      var ok = true;
      try { inner.call(this, shader, renderer2); }
      catch (e) { ok = false; patchStats.innerThrew++; }
      /* if theirs threw the shader may be half-rewritten; adding ours on top
         of that could only turn a bad frame into a dead one */
      if (ok) nzOnBeforeCompile.call(this, shader, renderer2);
    };
    w.__nzWrap = inner;
    w.__nzInnerKey = String(inner);
    wrapSrc.push(inner); wrapFn.push(w);
    return w;
  }

  function wrapForeignMaterials() {
    if (!scene || !caps.shaderPatch) return 0;
    var n = 0, seen = {};
    scene.traverse(function (o) {
      if (!o.material) return;
      var l = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < l.length; i++) {
        var m = l[i];
        if (!m || seen[m.uuid]) continue;
        seen[m.uuid] = 1;
        if (!Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) continue;
        var f = m.onBeforeCompile;
        if (typeof f !== 'function' || f === nzOnBeforeCompile || f.__nzWrap) continue;
        /* a material with its own cache key is managing its own program
           identity; leave it completely alone */
        if (Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')) { patchStats.foreign++; continue; }
        m.onBeforeCompile = wrapOnBeforeCompile(f);
        m.needsUpdate = true;
        n++;
      }
    });
    patchStats.wrapped += n;
    if (n) NZ.log('composed AO/PCSS into ' + n + ' foreign-patched material(s)');
    return n;
  }

  function nzCacheKey() {
    var f = this.onBeforeCompile;
    if (f === nzOnBeforeCompile) return patchKey + '|nz';
    if (f && f.__nzInnerKey) return patchKey + '|w|' + f.__nzInnerKey;
    return patchKey + '|' + String(f);
  }

  function installShaderPatch() {
    if (origOnBeforeCompile) return;
    origOnBeforeCompile = THREE.Material.prototype.onBeforeCompile;
    origCacheKey = THREE.Material.prototype.customProgramCacheKey;
    shadowChunkPatched = buildShadowChunk();
    THREE.Material.prototype.onBeforeCompile = nzOnBeforeCompile;
    THREE.Material.prototype.customProgramCacheKey = nzCacheKey;
  }

  /* Teardown has to undo the wrappers too. A wrapper calls nzOnBeforeCompile
     DIRECTLY, not through the prototype, so restoring the prototype alone
     would leave every wrapped material still sampling nzAoTex -- and by then
     the AO target has been disposed, which would hand the level a black
     screen after a panic instead of the stock renderer. */
  function unwrapForeignMaterials() {
    if (!scene) return;
    var seen = {};
    scene.traverse(function (o) {
      if (!o.material) return;
      var l = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < l.length; i++) {
        var m = l[i];
        if (!m || seen[m.uuid]) continue;
        seen[m.uuid] = 1;
        var f = m.onBeforeCompile;
        if (f && f.__nzWrap) { m.onBeforeCompile = f.__nzWrap; m.needsUpdate = true; }
      }
    });
    wrapSrc.length = 0; wrapFn.length = 0; wrapSweeps = 0;
  }

  function removeShaderPatch() {
    if (!origOnBeforeCompile) return;
    THREE.Material.prototype.onBeforeCompile = origOnBeforeCompile;
    THREE.Material.prototype.customProgramCacheKey = origCacheKey;
    origOnBeforeCompile = null; origCacheKey = null;
    caps.shaderPatch = false;
    /* belt and braces: even a program that survives the unwrap reads these,
       and z=0 makes the whole injected block inert */
    try { if (uAoP) uAoP.value.set(0, 0, 0, 0); if (uSsrP) uSsrP.value.set(0, 0, 0, 0); } catch (e) {}
    unwrapForeignMaterials();
    touchAllMaterials();
  }

  function touchAllMaterials() {
    if (!scene) return;
    scene.traverse(function (o) {
      if (!o.material) return;
      var l = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < l.length; i++) if (l[i]) l[i].needsUpdate = true;
    });
  }

  /* Compile a throwaway scene that exercises every branch of the patch and
     actually draw it. A link failure shows up either as three logging to
     console.error or as an INVALID_OPERATION on the draw; either way we bail
     out and the stock path takes over with nothing lost. */
  function validateShaderPatch(withEnv) {
    var ok = true, ts = null, cam = null, rt = null, i;
    var junk = [], dl = null;
    try {
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      ts = new THREE.Scene();
      ts.fog = new THREE.Fog(0x000000, 10, 100);
      cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      cam.position.set(0, 0, 4);
      dl = new THREE.DirectionalLight(0xffffff, 1.0);
      dl.position.set(2, 4, 3); dl.castShadow = true;
      dl.shadow.mapSize.set(64, 64);
      ts.add(dl); ts.add(dl.target);
      ts.add(new THREE.AmbientLight(0xffffff, 0.3));
      ts.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.3));
      if (withEnv && envRT) ts.environment = envRT.texture;
      var geo = new THREE.BoxGeometry(1, 1, 1);
      junk.push(geo);
      var mats = [
        new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.5, fog: true, dithering: true }),
        new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0, vertexColors: false, fog: false }),
        new THREE.MeshPhongMaterial({ shininess: 20, fog: true }),
        new THREE.MeshLambertMaterial({ fog: true }),
        new THREE.MeshBasicMaterial({ fog: true })
      ];
      for (i = 0; i < mats.length; i++) {
        junk.push(mats[i]);
        var mesh = new THREE.Mesh(geo, mats[i]);
        mesh.position.set((i - 2) * 1.6, 0, 0);
        mesh.castShadow = true; mesh.receiveShadow = true;
        ts.add(mesh);
      }
      var errs = 0;
      var oldErr = console.error;
      console.error = function () { errs++; try { oldErr.apply(console, arguments); } catch (e) {} };
      var prevTarget = renderer.getRenderTarget();
      var prevAuto = renderer.autoClear;
      try {
        renderer.compile(ts, cam);
        rt = new THREE.WebGLRenderTarget(8, 8);
        renderer.autoClear = true;
        renderer.setRenderTarget(rt);
        renderer.render(ts, cam);
      } finally {
        console.error = oldErr;
        renderer.setRenderTarget(prevTarget);
        renderer.autoClear = prevAuto;
      }
      var e2 = gl.getError();
      ok = (errs === 0) && (e2 === gl.NO_ERROR);
      if (!ok) NZ.log('shader patch validation failed: errs=' + errs + ' gl=' + e2);
    } catch (err) {
      NZ.log('shader patch validation threw:', err && err.message);
      ok = false;
    }
    try {
      for (i = 0; i < junk.length; i++) if (junk[i] && junk[i].dispose) junk[i].dispose();
      if (dl && dl.shadow && dl.shadow.map) { dl.shadow.map.dispose(); dl.shadow.map = null; }
      if (dl && dl.dispose) dl.dispose();
      killRT(rt);
    } catch (e3) {}
    return ok;
  }

  function tryShaderPatch(withEnv) {
    if (!caps.hdr || !caps.depth) return false;
    try {
      installShaderPatch();
      patchKey = 'nz' + (frameId + 1) + (usePcssPatch ? 'p' : '');
      if (validateShaderPatch(withEnv)) { caps.shaderPatch = true; return true; }
      /* second chance without the shadow rewrite: AO and SSR are worth more */
      if (usePcssPatch) {
        usePcssPatch = false;
        patchKey = 'nz' + (frameId + 1) + 'n';
        if (validateShaderPatch(withEnv)) {
          caps.shaderPatch = true;
          NZ.log('shader patch installed without PCSS');
          return true;
        }
      }
      removeShaderPatch();
      return false;
    } catch (err) {
      NZ.log('shader patch install failed:', err && err.message);
      try { removeShaderPatch(); } catch (e) {}
      return false;
    }
  }

  /* ====================================================================== */
  /*  procedural environment probe                                          */
  /* ====================================================================== */
  /* ONE sky function, used by exactly two things: the visible dome and the
     cube camera the PMREM probe is built from. They cannot disagree, because
     they are the same GLSL. The stock dome was a near-black night texture
     (#05070f zenith) which is why the probe carried almost no energy and no
     directional structure -- a sky that dark is worth about a tenth of a stop
     of fill, so the only light left in the frame was flat AmbientLight.
     A CS2 exterior is the other way round: the sky is a dominant, strongly
     graded source and the sun sits on top of it. */
  var SKY_FN = [
    'uniform vec3 uZenith, uHorizon, uHaze, uGround;',
    'uniform vec3 uKeyCol, uKeyDir, uCloudCol;',
    'uniform vec3 uSunDisc;',   /* x cos(outer), y cos(inner), z radiance (pre-gain) */
    'uniform float uKeyGlow, uKeyCore, uHazeInt, uGain, uClampMax;',
    'uniform float uCloudScale, uCloudCover, uCloudInt;',
    'uniform vec2 uCloudDrift;',
    'float nzVN(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = nzHash(i), b = nzHash(i + vec2(1.0, 0.0));',
    '  float c = nzHash(i + vec2(0.0, 1.0)), e = nzHash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);',
    '}',
    'float nzFbm2(vec2 p){',
    '  float s = 0.0, a = 0.52;',
    '  for (int i = 0; i < 4; i++) { s += a * nzVN(p); p = p * 2.03 + 7.13; a *= 0.5; }',
    '  return s;',
    '}',
    'vec3 nzSky(vec3 d){',
    '  float up = d.y;',
    '  float h = saturate(up);',
    /* Rayleigh-ish grade: deep at the zenith, washing out to a bright hazy
       band at eye level. The RATIO between these two is what gives every
       up-facing surface in the level a different value from every down-facing
       one -- that is where hemispherical form shading comes from. */
    '  vec3 col = mix(uHorizon, uZenith, pow(h, 0.48));',
    '  col = mix(col, uHaze, uHazeInt * exp(-h * 6.5));',
    /* one cirrus layer, projected onto a plane overhead. Cheap, and it stops
       the dome reading as a gradient ramp. */
    '  if (uCloudInt > 0.001 && up > 0.0) {',
    '    vec2 cp = (d.xz / max(up, 0.055)) * uCloudScale + uCloudDrift;',
    '    float cf = nzFbm2(cp);',
    '    float cov = smoothstep(uCloudCover, uCloudCover + 0.30, cf) * smoothstep(0.0, 0.17, up);',
    '    col = mix(col, uCloudCol * (0.62 + 0.68 * cf), saturate(cov * uCloudInt));',
    '  }',
    /* the sun: a wide forward-scatter glow, a tighter aureole, and -- new --
       an actual SOLAR DISC.
       Without the disc no metal in the game can catch a specular highlight
       from the key: three's punctual DirectionalLight specular collapses
       towards nothing as roughness -> 0, so a chrome ball, a gun barrel, an
       optic or a door handle gets its mirror lobe from the environment map
       and from nothing else. An environment with no sun in it therefore has
       no highlight to give, which is exactly what the chrome ball was
       showing: a clean sky-to-ground gradient and no sun.
       pow(kd, 1400.0) was NOT that disc: its half-power angle is 1.8 deg,
       roughly seven times the real sun, and its peak was 34x the sky, which
       is four orders of magnitude too dim to read as a specular. It stays,
       demoted to the aureole it actually was.

       uSunDisc = vec3(cosOuter, cosInner, radiance). The rendered disc is
       widened to at least a couple of cube texels so it antialiases, and the
       radiance is then ENERGY COMPENSATED for however wide it ended up (see
       sunDiscParams), so the flux it puts into the probe is the same at any
       capture resolution and the highlight simply gets softer on a coarse
       cube instead of brighter or dimmer. */
    '  float kd = saturate(dot(d, uKeyDir));',
    '  col += uKeyCol * (uKeyGlow * pow(kd, 7.0) + uKeyCore * pow(kd, 1400.0));',
    '  col = min(col, vec3(uClampMax));',
    /* Warm bounce off the ground plane. This half of the probe is what lights
       every VERTICAL surface in the level -- a wall's cosine lobe is centred
       on the horizon, so it integrates the ground band and the haze band far
       more heavily than the zenith. The old version handed it a dark brown at
       a hard smoothstep(0, 0.13) edge, so a facade the sun could not see was
       reading a near-black lower hemisphere and going to silhouette.
       A sunlit street is not dark: it is the brightest bounce source in an
       exterior. Widening the transition to (-0.03, 0.42) keeps the bright haze
       band spilling below the horizon the way real aerial bounce does, which
       moves probe energy from up-facing surfaces (which already read) onto
       vertical ones (which did not). measureSkyGain() renormalises the whole
       sphere afterwards, so this is a redistribution, not a brightness cheat. */
    '  float g = saturate(-up);',
    '  vec3 gcol = uGround * (0.62 + 0.38 * (1.0 - g));',
    '  col = mix(col, gcol, smoothstep(-0.03, 0.42, g));',
    /* Disc last, and deliberately ABOVE uClampMax: that clamp is a NaN/inf
       guard on the gradient, not a look control, and clamping the sun to 60
       would delete the very thing the disc is here to provide. It is also
       added AFTER the ground mix so the horizon blend cannot dilute it.
       The half-float cube tops out at 65504, so the ceiling below is real. */
    '  if (uSunDisc.z > 0.0) col += uKeyCol * uSunDisc.z * smoothstep(uSunDisc.x, uSunDisc.y, dot(d, uKeyDir));',
    '  return min(col * uGain, vec3(60000.0));',
    '}'
  ].join('\n');

  function skyUniforms(keyDir) {
    return {
      /* Only the RATIOS here matter: measureSkyGain() renormalises the whole
         function to P.envIrradiance afterwards. srgbHex(), not
         convertSRGBToLinear(), so these do not double-decode once colour
         management is on -- and so the probe is bit-identical either way. */
      uZenith:   { value: srgbHex(P.skyZenith) },
      uHorizon:  { value: srgbHex(P.skyHorizon) },
      uHaze:     { value: srgbHex(P.skyHaze) },
      uGround:   { value: srgbHex(P.skyGround) },
      uCloudCol: { value: srgbHex(P.skyCloud) },
      uKeyCol:   { value: srgbHex(P.skyKeyCol) },
      uKeyDir:   { value: keyDir.clone() },
      /* 0.35 / 12, down from 0.85 / 34. These two were standing in for a sun
         the probe did not have, and they paid for it by piling probe energy
         into the sky NEAR the sun -- measured, the probe was worth 1.94x its
         own mean on a surface square to the key azimuth and only 1.09x on one
         90 deg away, i.e. the supposedly isotropic fill was itself swinging
         0.8 stop with heading and making the heading swing worse rather than
         damping it. Now that uSunDisc carries the sun properly the aureole
         can go back to being an aureole, and every 0.1 taken off this number
         is heading consistency bought for nothing: it costs no key dominance,
         because it moves probe energy between headings rather than adding
         any. Measured, the probe's azimuthal spread drops from 1.94 .. 1.09
         to about 1.45 .. 1.20. */
      uKeyGlow:  { value: 0.35 },
      uKeyCore:  { value: 12.0 },
      uHazeInt:  { value: 0.72 },
      uCloudScale: { value: 0.85 },
      uCloudCover: { value: 0.52 },
      uCloudInt: { value: 0.55 },
      uCloudDrift: { value: new THREE.Vector2(11.3, 4.7) },
      uGain:     { value: 1.0 },
      uClampMax: { value: 60.0 },
      /* solved by sunDiscParams() once the capture resolution and the
         measured sky mean are both known; zero until then, which is also what
         measureSkyGain() integrates against (see there for why) */
      uSunDisc:  { value: new THREE.Vector3(1.0, 1.0, 0.0) }
    };
  }

  /* ---- solar disc -------------------------------------------------------
     The real sun subtends 0.53 deg -- a half-angle of 0.265 deg, cos =
     0.9999893. On a 256 px cube face one texel spans 90/256 = 0.35 deg, so a
     physically-sized disc is SMALLER THAN A TEXEL and lands wherever the
     sampling grid happens to put it: sometimes a single blazing texel,
     sometimes nothing. Either way it aliases, and PMREM then propagates that
     into every roughness mip.

     So the disc is drawn at max(true radius, ~1.3 texels) and its radiance is
     divided by however much the solid angle grew. Flux is therefore exactly
     conserved: a coarse cube gets a slightly larger, proportionally dimmer
     sun, which is what a prefiltered probe wants anyway, and the roughness
     mips receive the same energy at any capture size.

     How bright? Not physically -- the DirectionalLight is already carrying
     the sun's direct diffuse, and three cannot exclude the probe from
     diffuse, so a radiometrically correct disc would double-count it. Instead
     the disc is specified as a share of the probe's total flux
     (P.sunProbeShare). At the default 0.03 it adds 0.03*4*cos(theta) = up to
     12% of the probe's irradiance on a sun-facing surface -- a real "sun is
     in this sky" contribution, small enough not to disturb the diffuse
     balance the calibration solved -- while the disc RADIANCE comes out
     around 4 orders of magnitude above the sky, which is what a mirror needs
     to show a sun rather than a slightly brighter patch of blue. */
  var SUN_HALF_RAD = 0.265 * Math.PI / 180;

  function sunDiscParams(cubeRes, skyMean) {
    var texelRad = (Math.PI * 0.5) / Math.max(16, cubeRes || 256);   /* 90 deg per face */
    /* Never smaller than two cube texels. At 512 that is a 0.70 deg disc
       against the sun's true 0.53 -- 1.3x, flux conserved, and the reason is
       sampling not taste: a bilinear fetch out of the CubeUV base level has
       about two texels of support, so a disc narrower than that lands
       between sample points and appears or disappears with sub-texel
       alignment. Since the energy is compensated, widening costs nothing but
       highlight sharpness on a perfect mirror, and buys a highlight that is
       actually THERE on every frame instead of on some of them. */
    var half = Math.max(SUN_HALF_RAD, texelRad * 2.0);
    /* smoothstep from cos(outer) to cos(inner); the half-power point sits at
       `half`, so integrate the ramp for the effective solid angle */
    var inner = Math.max(0, half - texelRad * 0.75);
    var outer = half + texelRad * 0.75;
    /* solid angle of the smoothstep ramp: 2pi*(1-cos) of the midpoint radius
       is exact to better than a percent for these tiny angles */
    var omega = 2 * Math.PI * (1 - Math.cos(half));
    var trueOmega = 2 * Math.PI * (1 - Math.cos(SUN_HALF_RAD));
    /* share of the WHOLE SPHERE's mean radiance the disc is allowed to be:
       R*omega/(4pi) = share*mean  ->  R = share*mean*4pi/omega. Expressed
       pre-gain (nzSky multiplies by uGain on the way out) so it survives the
       renormalisation unchanged. */
    var share = Math.max(0, Math.min(0.25, P.sunProbeShare));
    var radiance = (skyMean > 1e-6 && omega > 0)
      ? share * skyMean * 4 * Math.PI / omega : 0;
    return {
      cosOuter: Math.cos(outer), cosInner: Math.cos(inner),
      radiance: radiance, halfDeg: half * 180 / Math.PI,
      widened: half / SUN_HALF_RAD, omega: omega, trueOmega: trueOmega
    };
  }

  var sunDiscInfo = null;

  /* How much of P.keyIntensity the probe's disc is already delivering.
     A disc of solid angle W and radiance R at the key direction gives a
     Lambertian surface an albedo multiplier of R*W*cos(theta)/PI, and by
     construction R*W = 4*PI*share*envIrradiance, so that is
     4*share*envIrradiance*cos(theta) -- the same cos(theta) the
     DirectionalLight has. Divide out the key's colour luma and it is
     literally a number of units of keyIntensity. */
  function sunDiscKeyOffset(S) {
    if (!envRT || !sunDiscInfo || !(sunDiscInfo.radiance > 0)) return 0;
    var kl = lumaOf(S && S.color);
    if (!(kl > 1e-3)) return 0;
    return 4 * Math.max(0, P.sunProbeShare) * P.envIrradiance / kl;
  }

  function applySunDisc(uniforms, cubeRes, skyMean) {
    var d = sunDiscParams(cubeRes, skyMean);
    sunDiscInfo = d;
    if (uniforms && uniforms.uSunDisc) uniforms.uSunDisc.value.set(d.cosOuter, d.cosInner, d.radiance);
    return d;
  }

  /* The game's own sky dome: a BackSide MeshBasicMaterial carrying the night
     canvas. We take the MESH, not just the material, because the dome has to
     be re-shaded with nzSky() -- leaving the black texture up there while the
     probe says "bright sky" is the exact contradiction the frame was showing. */
  function findSkyMesh() {
    var found = null;
    scene.traverse(function (o) {
      if (found || !o.isMesh || !o.material || Array.isArray(o.material)) return;
      var m = o.material;
      if (m.__nzSkyDome) { found = o; return; }
      if (m.isMeshBasicMaterial && m.side === THREE.BackSide && m.fog === false && m.map) found = o;
    });
    return found;
  }

  /* Integrate the probe numerically so its mean radiance can be normalised to
     a known target. Guessing the gain by eye is how a level ends up 3 stops
     off; measuring it costs one 64x32 render and one readback.

     The SUN DISC IS OFF while this runs, and that is not an oversight. This
     grid is 64x32, so one texel spans 5.6 degrees: a 0.53 degree disc either
     misses every sample centre and contributes nothing, or lands on one and
     contributes 1/2048th of a four-figure radiance -- i.e. the measurement
     would swing by a factor of two on where the sun happened to fall, and
     the gain, the fog tint and the whole level's fill would swing with it.
     So the GRADIENT is measured (which is what needs normalising) and the
     disc is then solved analytically against that measured mean, which makes
     its flux exact and its effect on the diffuse balance a stated constant
     rather than a sampling accident. */
  function measureSkyGain(uniforms, defines) {
    var W = 64, H = 32, gain = 1.0;
    var rt = null;
    var discSaved = uniforms.uSunDisc ? uniforms.uSunDisc.value.z : 0;
    if (uniforms.uSunDisc) uniforms.uSunDisc.value.z = 0;
    envMeanRadiance = 0;
    try {
      rt = makeRT(W, H, true, false);
      var frag = [
        LIB, SKY_FN,
        'varying vec2 vUv;',
        'void main(){',
        '  float phi = (vUv.x * 2.0 - 1.0) * 3.14159265;',
        '  float th  = (vUv.y - 0.5) * 3.14159265;',
        '  vec3 d = vec3(cos(th) * sin(phi), sin(th), cos(th) * cos(phi));',
        '  gl_FragColor = vec4(nzSky(d), 1.0);',
        '}'
      ].join('\n');
      var mat = makeMat(frag, uniforms, defines);
      blit(mat, rt);
      renderer.setRenderTarget(null);

      var n = W * H * 4, sum = 0, wsum = 0, ok = false;
      if (caps.hdr && THREE.DataUtils && THREE.DataUtils.fromHalfFloat) {
        var buf = new Uint16Array(n);
        renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
        for (var y = 0; y < H; y++) {
          var th = ((y + 0.5) / H - 0.5) * Math.PI;
          var w = Math.cos(th);
          for (var x = 0; x < W; x++) {
            var i = (y * W + x) * 4;
            var r = THREE.DataUtils.fromHalfFloat(buf[i]);
            var g = THREE.DataUtils.fromHalfFloat(buf[i + 1]);
            var b = THREE.DataUtils.fromHalfFloat(buf[i + 2]);
            if (!isFinite(r) || !isFinite(g) || !isFinite(b)) continue;
            sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) * w;
            wsum += w;
          }
        }
        ok = wsum > 0;
      }
      mat.dispose();
      if (ok) {
        var mean = sum / wsum;
        envMeanRadiance = mean;
        if (mean > 1e-5) gain = P.envIrradiance / mean;
        NZ.log('env mean radiance', mean.toFixed(4), '-> gain', gain.toFixed(3));
      } else {
        NZ.log('env readback unavailable, using fallback gain');
      }
    } catch (err) {
      NZ.log('env measure failed:', err && err.message);
    }
    killRT(rt);
    if (uniforms.uSunDisc) uniforms.uSunDisc.value.z = discSaved;
    return Math.max(0.2, Math.min(8, gain));
  }

  /* the dome material we install over the game's night sky, plus what it
     replaced so panic() can hand the level back exactly as it was */
  var skyDomeMat = null, skyDomeMesh = null, skyDomeOrig = null;

  function installSkyDome(uniforms) {
    var mesh = findSkyMesh();
    if (!mesh) { NZ.log('no sky dome found; probe still built'); return; }

    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: [
        'varying vec3 vDir;',
        'void main(){',
        '  vDir = position;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        LIB, SKY_FN,
        'varying vec3 vDir;',
        'uniform float uDomeGain;',
        /* The VISIBLE dome gets the disc clamped hard. Four figures of
           radiance is right for the probe -- a mirror is meant to blow out --
           but drawn straight into the HDR buffer it is a firefly: TAA
           neighbourhood clipping fights it, the bloom pyramid smears it and
           one pixel of sun sets the exposure of the whole sky. 26 is a
           clipped white disc with a believable bloom skirt and no artefact,
           which is what looking at the sun in a game should cost. */
        'void main(){ gl_FragColor = vec4(min(nzSky(normalize(vDir)) * uDomeGain, vec3(26.0)), 1.0); }'
      ].join('\n'),
      side: THREE.BackSide,
      depthTest: true, depthWrite: false,
      fog: false, toneMapped: false
    });
    mat.uniforms.uDomeGain = { value: P.skyLum };
    mat.__nzSkyDome = true;
    mat.name = 'nz:sky-dome';

    skyDomeMesh = mesh;
    if (skyDomeOrig === null) skyDomeOrig = mesh.material;
    mesh.material = mat;
    /* the dome is 460 units of fake geometry: it must never reach the
       prepass or GTAO would treat the sky as a near occluder */
    mesh.userData.nzNoGBuffer = true;
    if (skyDomeMat) { try { skyDomeMat.dispose(); } catch (e) {} }
    skyDomeMat = mat;
  }

  function restoreSkyDome() {
    try {
      if (skyDomeMesh && skyDomeOrig) skyDomeMesh.material = skyDomeOrig;
      if (skyDomeMesh) delete skyDomeMesh.userData.nzNoGBuffer;
    } catch (e) {}
    if (skyDomeMat) { try { skyDomeMat.dispose(); } catch (e2) {} }
    skyDomeMat = null; skyDomeMesh = null; skyDomeOrig = null;
  }

  var envMeanRadiance = 0;
  var fogSaved = null, bgSaved = null, bgSavedSet = false;

  /* The level ships scene.fog = Fog(0x01040b, 52, 338) -- a near-black haze
     that starts 52 units out. Under a night sky that was consistent; under a
     lit one it is a grey-out that eats contrast from every mid-distance
     surface and welds the far wall to the shadows. Aerial perspective in a
     CS2 exterior is the SKY leaking into the distance, so the fog is retinted
     to the measured horizon radiance and pushed back out of the play space. */
  function applyAtmosphere(uniforms) {
    if (!scene) return;
    try {
      var horizon = uniforms.uHorizon.value, haze = uniforms.uHaze.value;
      var gain = uniforms.uGain.value * P.skyLum;
      tmpCol.setRGB(
        (horizon.r * 0.55 + haze.r * 0.45) * gain,
        (horizon.g * 0.55 + haze.g * 0.45) * gain,
        (horizon.b * 0.55 + haze.b * 0.45) * gain
      );
      if (scene.fog) {
        if (!fogSaved) {
          fogSaved = { color: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far };
        }
        scene.fog.color.copy(tmpCol);
        if (scene.fog.near !== undefined) { scene.fog.near = 70; scene.fog.far = 520; }
      }
      /* insurance only: the dome covers every sky pixel, but a clear colour
         two stops below the sky would show through any gap in the geometry */
      if (!bgSavedSet) { bgSaved = scene.background; bgSavedSet = true; }
      if (scene.background && scene.background.isColor) scene.background.copy(tmpCol);
    } catch (e) { NZ.log('atmosphere retint failed:', e && e.message); }
  }

  function restoreAtmosphere() {
    try {
      if (fogSaved && scene && scene.fog) {
        scene.fog.color.copy(fogSaved.color);
        if (scene.fog.near !== undefined) { scene.fog.near = fogSaved.near; scene.fog.far = fogSaved.far; }
      }
      if (bgSavedSet && scene) scene.background = bgSaved;
    } catch (e) {}
    fogSaved = null; bgSaved = null; bgSavedSet = false;
  }

  function buildEnvironment() {
    var keyDir = lights.sunKey.position.clone().sub(lights.sunKey.target.position).normalize();
    var uniforms = skyUniforms(keyDir);
    var defines = {};

    /* Capture resolution is a tier knob like everything else. 256 could not
       resolve a solar disc at all (one texel = 0.35 deg against a 0.53 deg
       sun); 512 gives three texels across it, which is what lets PMREM carry
       a tight highlight into the low-roughness mips instead of a smear.
       It is a ONE-OFF bake, not a per-frame cost, so it degrades late. */
    var cubeRes = Math.min(EFF && EFF.envCube ? EFF.envCube : 256, caps.maxTex);

    /* The dome and the fog go up even on the no-float path. A machine that
       cannot hold a half-float target still should not be looking at a black
       sky -- it just does not get the probe that samples it. */
    if (caps.hdr) uniforms.uGain.value = measureSkyGain(uniforms, defines);
    /* solved against the MEASURED gradient mean and the capture resolution;
       see sunDiscParams(). Pre-gain, so nzSky's own uGain scales it with the
       rest of the sky and the share stays exact. */
    applySunDisc(uniforms, cubeRes, envMeanRadiance);

    /* the visible dome shares this uniform object, so a later gain change or
       a sun move reaches both the probe and the pixels behind the walls */
    installSkyDome(uniforms);
    applyAtmosphere(uniforms);

    if (!caps.hdr) { NZ.log('no float render targets: sky installed, skipping IBL'); return false; }

    var cubeFrag = [
      LIB, SKY_FN,
      'varying vec3 vDir;',
      'void main(){ gl_FragColor = vec4(nzSky(normalize(vDir)), 1.0); }'
    ].join('\n');
    var cubeMat = new THREE.ShaderMaterial({
      uniforms: uniforms, defines: defines,
      vertexShader: [
        'varying vec3 vDir;',
        'void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: cubeFrag,
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false
    });

    envCubeRT = new THREE.WebGLCubeRenderTarget(cubeRes, {
      format: THREE.RGBAFormat, type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false
    });
    if (THREE.LinearEncoding !== undefined) envCubeRT.texture.encoding = THREE.LinearEncoding;

    var box = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), cubeMat);
    box.frustumCulled = false;
    var tmp = new THREE.Scene();
    tmp.add(box);

    var cubeCam = new THREE.CubeCamera(0.5, 40, envCubeRT);
    var prevTarget = renderer.getRenderTarget();
    cubeCam.update(renderer, tmp);
    renderer.setRenderTarget(prevTarget);

    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    envRT = pmrem.fromCubemap(envCubeRT.texture);
    pmrem.dispose();

    scene.environment = envRT.texture;   /* background is left to the game */
    envCubeSize = cubeRes;
    NZ.log('env probe: cube ' + cubeRes + 'px, sun disc ' +
           (sunDiscInfo ? (sunDiscInfo.halfDeg * 2).toFixed(2) + ' deg (x' +
             sunDiscInfo.widened.toFixed(1) + ' true), radiance ' +
             (sunDiscInfo.radiance * uniforms.uGain.value).toFixed(0) : 'off'));

    box.geometry.dispose(); cubeMat.dispose();
    envCubeRT.dispose(); envCubeRT = null;
    return true;
  }

  /* ====================================================================== */
  /*  lighting rebalance                                                    */
  /* ====================================================================== */
  /* Stock rig: AmbientLight 0.80 + hemi 0.27 + key 0.62 + rim 0.22 -- four
     sources of comparable strength pointing four different ways, which is the
     definition of a flat image. The previous pass moved some of that into the
     probe but left key 1.18 against ambient 0.13 + hemi 0.20 + rim 0.26 + a
     probe normalised to 0.36 mean radiance: summed, the omnidirectional fill
     was still roughly TWICE the key. Nothing can cast a readable shadow into
     that.
     Now: one shadow-casting key at a low, raking elevation, a probe carrying
     every bounce, and one unshadowed anti-sun BOUNCE CARD so the surfaces the
     key cannot reach do not fall off the bottom of the tone curve. The flat
     hemisphere stays at zero while the probe exists (it is a strictly worse
     version of the same thing -- no gradient, no occlusion response) and the
     ambient term is a readability floor, not a fill.

     COLOUR NOTE. Every hex in here is an sRGB colour read through srgbHex(),
     and the two that were kept (ambient, key) were re-authored to
     linearToSRGB() of the raw values the legacy path was actually feeding the
     shader -- 0xbcd0e8 -> 0xdfe9f5, 0xffe0b6 -> 0xfff1dc. So turning colour
     management on does not move a single rendered pixel of this rig; it only
     makes the constants say what they were always doing. The lighting retune
     below is the part that deliberately changes the picture, which is what
     lets the two be told apart in a measurement. */
  function applyLighting(ibl) {
    var L = lights;
    if (L.ambient) {
      /* not literally zero: an interior with no probe visibility and no lamp
         would otherwise be unplayably black. This is a floor, not a fill. */
      setSrgb(L.ambient.color, 0xdfe9f5);       /* = legacy 0xbcd0e8 rendered */
      L.ambient.intensity = ibl ? P.ambientFloor : 0.55;
    }
    if (L.skyFill) {
      setSrgb(L.skyFill.color, 0xcee2f8);       /* = legacy 0x9dc2f0 rendered */
      setSrgb(L.skyFill.groundColor, 0x7e7160); /* = legacy 0x352a1e rendered */
      L.skyFill.intensity = ibl ? 0.0 : 0.30;
    }
    var S = L.sunKey;
    if (!S) return;
    /* snapshot the level's own key transform once, before followShadow() or
       the elevation re-aim below has ever touched it */
    /* col is stored as a Color CLONE, not a getHex(). getHex() round-trips
       through the colour space: captured with colour management on it returns
       the sRGB hex, and panic() puts the legacy flag back before it restores,
       so setHex() of that number would hand the stock rig a key 11% whiter
       than the one the level author set. A cloned Color is working-space and
       has no opinion about the flag. */
    if (!sunSaved) {
      sunSaved = { pos: S.position.clone(), tgt: S.target.position.clone(),
                   col: S.color.clone() };
    }
    setSrgb(S.color, 0xfff1dc);                 /* = legacy 0xffe0b6 rendered */
    /* P.keyIntensity is the TOTAL sun diffuse. The probe's solar disc already
       delivers part of it with identical angular dependence, so hand the
       DirectionalLight the remainder and the two sum to exactly the declared
       number -- which is what makes the disc's brightness a pure specular
       decision instead of a lighting one. */
    S.intensity = (ibl ? P.keyIntensity : P.keyIntensity * 0.62) - (ibl ? sunDiscKeyOffset(S) : 0);
    if (!(S.intensity > 0)) S.intensity = 0.01;
    S.castShadow = true;
    applyShadowQuality();

    /* Re-aim to P.sunElevation, keeping the level's azimuth. Idempotent: the
       elevation is recomputed from the horizontal magnitude every time, so it
       is safe to run again after followShadow() has moved the light, and after
       a setQuality() or a probe rebuild. */
    sunDir = S.position.clone().sub(S.target.position);
    var horiz = Math.sqrt(sunDir.x * sunDir.x + sunDir.z * sunDir.z);
    if (horiz > 1e-3 && P.sunElevation > 1 && P.sunElevation < 89) {
      sunDir.y = horiz * Math.tan(P.sunElevation * Math.PI / 180);
    }
    sunDir.normalize();
    if (!(isFinite(sunDir.x) && isFinite(sunDir.y) && isFinite(sunDir.z)) || sunDir.lengthSq() < 0.5) {
      sunDir.set(-0.52, 0.62, 0.59).normalize();
    }
    S.target.position.copy(S.position).addScaledVector(sunDir, -SUN_DIST);
    S.target.updateMatrixWorld();
    /* three's Object3D.lookAt uses up=(0,1,0), so this basis matches the
       shadow camera's exactly -- required for texel snapping to work. */
    sunRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
    sunUp = new THREE.Vector3().crossVectors(sunDir, sunRight).normalize();
    sunCenter = new THREE.Vector3();
    camFwd = new THREE.Vector3();

    applyBounceCards(ibl);
  }

  /* ---- the bounce cards ---------------------------------------------------
     TWO of them, at the key's azimuth +/- 130 degrees and 8 degrees BELOW the
     horizon, both unshadowed. Why two, and why 130:

     One anti-sun card (the old coolRim, at +180) leaves the fill ZERO on any
     vertical surface square to the key azimuth -- the key grazes it at 90
     degrees and so does the card at 90 the other way. That is not a corner
     case, it is the single most common heading in a corridor shooter, and it
     measured -1.63 stop on the calibrated card: the deepest trough anywhere
     on the compass and a knife edge the player walks straight through.

     At +/-130 the two cards and the key between them cover every azimuth:
     the weakest point is +/-65 degrees off the key, where the key is still
     worth 0.35 of itself and the near card is opening up at 0.42 of itself.
     Measured, the trough lifts by ~0.5 stop and no new one appears.

     Elevation +7, and that number is not taste either. A card exactly on the
     horizon gives a FLOOR nothing (sin 0), and the light this replaced sat at
     +21 and was giving floors 0.139*sin(21) = 0.050 of albedo multiplier.
     Indoors that is not a rounding error, it is most of what a floor gets:
     the probe is the only other source there and the GTAO pass multiplies
     indirect diffuse, so the probe's share of a corridor floor is crushed to
     near nothing while a directional lands on directDiffuse and survives.
     Dropping the cards below the horizon measured 0.6 stop off the corridor
     walls and floor. At +7 the pair returns 0.416*sin(7) = 0.051 -- the same
     floor contribution the old rim had -- and a VERTICAL surface loses
     cos(7)/cos(8) = 0.3% for it, which is nothing.

     Warm-neutral, not the old sky blue: this is sunlight off concrete and off
     the lit facade opposite, and the cool half of the fill is already in the
     probe's upper hemisphere.

     Re-aimed from sunDir on every applyLighting(), so they track a sun move
     for free, and split so the PAIR is worth P.bounceIntensity on the surface
     that faces one of them squarely. */
  var bounceB = null, bounceBTarget = null;

  function aimBounce(light, relDeg) {
    var bh = Math.sqrt(sunDir.x * sunDir.x + sunDir.z * sunDir.z);
    if (bh < 1e-4) return;
    var a = Math.atan2(sunDir.x / bh, sunDir.z / bh) + relDeg * Math.PI / 180;
    var el = 7.0 * Math.PI / 180;
    var d = new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el));
    light.position.copy(d).multiplyScalar(SUN_DIST);
    if (light.target) {
      light.target.position.set(0, 0, 0);
      light.target.updateMatrixWorld();
    }
  }

  function applyBounceCards(ibl) {
    var L = lights, i = (ibl ? P.bounceIntensity : P.bounceIntensity * 0.85) * 0.5;
    if (L.coolRim) {
      if (!rimSaved) {
        rimSaved = { pos: L.coolRim.position.clone(), col: L.coolRim.color.clone(),
                     tgt: L.coolRim.target ? L.coolRim.target.position.clone() : null,
                     inten: L.coolRim.intensity };
      }
      setSrgb(L.coolRim.color, 0xd8cfc0);
      L.coolRim.intensity = i;
      L.coolRim.castShadow = false;
      aimBounce(L.coolRim, 130);
    }
    /* The level ships exactly one fill light, so the second card is ours to
       make. It is added to the scene rather than to NZ.ctx.lights (which is
       the game's own record of its rig) and panic() takes it back out. */
    try {
      if (!bounceB && scene && sunDir) {
        bounceB = new THREE.DirectionalLight(0xffffff, 0);
        bounceB.name = 'nz:bounce-b';
        bounceB.castShadow = false;
        bounceBTarget = bounceB.target;
        scene.add(bounceB);
        scene.add(bounceBTarget);
      }
      if (bounceB) {
        setSrgb(bounceB.color, 0xd8cfc0);
        bounceB.intensity = i;
        aimBounce(bounceB, -130);
      }
    } catch (e) { NZ.log('second bounce card unavailable:', e && e.message); }
    applyKicker(ibl);
  }

  function removeBounceB() {
    try {
      if (bounceB && bounceB.parent) bounceB.parent.remove(bounceB);
      if (bounceBTarget && bounceBTarget.parent) bounceBTarget.parent.remove(bounceBTarget);
    } catch (e) {}
    bounceB = null; bounceBTarget = null;
  }

  /* ---- the sky kicker ---------------------------------------------------
     See P.kickerIntensity for the argument. One unshadowed DirectionalLight
     at the anti-key azimuth, high, cool. Unshadowed on purpose: it stands in
     for the whole upper hemisphere, which is not occluded by the punctual
     shadow map either, and a shadowed kicker would carve a second sun-shaped
     shadow into every frame. Owned by this module, added to the scene rather
     than to NZ.ctx.lights, removed by panic(). */
  var kicker = null, kickerTarget = null;

  function applyKicker(ibl) {
    var want = (ibl ? P.kickerIntensity : P.kickerIntensity * 0.7);
    try {
      if (!kicker && scene && sunDir && want > 0) {
        kicker = new THREE.DirectionalLight(0xffffff, 0);
        kicker.name = 'nz:sky-kicker';
        kicker.castShadow = false;
        kickerTarget = kicker.target;
        scene.add(kicker);
        scene.add(kickerTarget);
      }
      if (!kicker) return;
      /* daylight sky, not a blue gel: 0xd6e4f6 is the hazy zenith band a
         north-facing skylight actually delivers, and it lands at 0.94/0.97/
         1.04 relative luma -- enough to read as "sky" next to the warm ground
         bounce without tinting anything visibly blue. */
      setSrgb(kicker.color, 0xd6e4f6);
      kicker.intensity = want;
      var bh = Math.sqrt(sunDir.x * sunDir.x + sunDir.z * sunDir.z);
      if (bh < 1e-4) return;
      var a = Math.atan2(sunDir.x / bh, sunDir.z / bh) + Math.PI;
      var el = Math.max(20, Math.min(80, P.kickerElevation)) * Math.PI / 180;
      var d = new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el));
      kicker.position.copy(d).multiplyScalar(SUN_DIST);
      if (kickerTarget) { kickerTarget.position.set(0, 0, 0); kickerTarget.updateMatrixWorld(); }
    } catch (e) { NZ.log('sky kicker unavailable:', e && e.message); }
  }

  function removeKicker() {
    try {
      if (kicker && kicker.parent) kicker.parent.remove(kicker);
      if (kickerTarget && kickerTarget.parent) kickerTarget.parent.remove(kickerTarget);
    } catch (e) {}
    kicker = null; kickerTarget = null;
  }

  /* P.shadowExtentScale exists for ONE case: an OUTDOOR level.
     The extents in TIERS are solved for the interiors this engine was written
     for, where the whole room fits inside a 60-100 unit box and a doorway's
     shadow is the longest thing in frame. On an open street with five-storey
     blocks the shadow of a 52-unit eaves line at a 52-degree sun is 41 units
     long, so at extent 30 the ARCHITECTURE casts nothing that reaches the
     ground: the frame gets tree, kerb and bollard shadows and no building
     shadows at all, which reads as an overcast street with props sitting on
     it. Read LIVE rather than folded into computeEffects(), so a module that
     sets it after the effects have been applied does not have to force a
     tier change (and therefore pin the adaptive quality ladder) to be heard.
     Both readers of the extent go through here so the texel snap in
     followShadow() cannot fall out of step with the projection. */
  function shadowExtent() {
    var k = P.shadowExtentScale;
    return EFF.extent * (k > 0 ? k : 1);
  }

  function applyShadowQuality() {
    var S = lights.sunKey; if (!S) return;
    var e = shadowExtent(), res = EFF.shadow;
    S.shadow.mapSize.set(res, res);
    if (S.shadow.map && (S.shadow.map.width !== res || S.shadow.map.height !== res)) {
      S.shadow.map.dispose(); S.shadow.map = null;
    }
    var c = S.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.near = 1; c.far = SUN_DIST + e * 2.4;
    c.updateProjectionMatrix();
    var texelWorld = (2 * e) / res;
    /* tight frustum -> good depth precision, so constant bias can stay tiny
       and normal-offset does the real work (no peter-panning, no acne) */
    S.shadow.bias = -0.00012;
    S.shadow.normalBias = Math.max(0.012, texelWorld * 1.45);
    S.shadow.radius = 2;
    if (uShadowP) {
      var range = Math.max(1, c.far - c.near);
      uShadowP.value.set(range / Math.max(0.2, P.shadowSoftness),
                         P.shadowSearch, 0.85, EFF.pcss ? 1 : 0);
    }
  }

  /* Slide the shadow box with the player and snap it to the shadow-map texel
     grid, otherwise the frustum crawls with every step and every edge boils. */
  function followShadow() {
    var S = lights.sunKey; if (!S || !sunDir) return;
    var e = shadowExtent();
    camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    camFwd.y = 0;
    if (camFwd.lengthSq() < 1e-6) camFwd.set(0, 0, -1); else camFwd.normalize();

    sunCenter.copy(camera.position).addScaledVector(camFwd, e * 0.40);
    sunCenter.y -= 1.2;

    var t = (2 * e) / EFF.shadow;
    var a = sunCenter.dot(sunRight), b = sunCenter.dot(sunUp), c = sunCenter.dot(sunDir);
    a = Math.round(a / t) * t; b = Math.round(b / t) * t;
    sunCenter.set(0, 0, 0)
      .addScaledVector(sunRight, a)
      .addScaledVector(sunUp, b)
      .addScaledVector(sunDir, c);

    S.target.position.copy(sunCenter);
    S.position.copy(sunCenter).addScaledVector(sunDir, SUN_DIST);
  }

  /* ====================================================================== */
  /*  material upgrade                                                      */
  /* ====================================================================== */
  /* scene.environment only reaches MeshStandardMaterial in r149 and the whole
     level is MeshPhong. Diffuse response is identical in this version (both
     Lambert) so the baked vertex lighting survives untouched -- only the
     specular lobe changes, from Blinn-Phong to GGX.

     [roughness, metalness, normalStrength, roughnessVariance] */
  var SURF = {
    metal:     [0.34, 0.78, 0.55, 0.26], grate:    [0.42, 0.62, 0.70, 0.28],
    door:      [0.38, 0.55, 0.50, 0.22], keydoor:  [0.37, 0.52, 0.50, 0.22],
    switch:    [0.33, 0.60, 0.40, 0.20], glass:    [0.10, 0.05, 0.00, 0.06],
    tilefloor: [0.31, 0.06, 0.40, 0.30], wood:     [0.62, 0.00, 0.55, 0.26],
    crate:     [0.66, 0.00, 0.60, 0.26], street:   [0.55, 0.02, 0.45, 0.34],
    concrete:  [0.74, 0.00, 0.45, 0.30], brick:    [0.80, 0.00, 0.85, 0.26],
    stone:     [0.76, 0.00, 0.60, 0.26], hotelwall:[0.72, 0.00, 0.35, 0.26],
    ceil:      [0.62, 0.08, 0.35, 0.24], ceildark: [0.72, 0.05, 0.35, 0.24],
    carpet:    [0.92, 0.00, 0.30, 0.18]
  };

  var derivedMaps = [];

  /* Deriving a normal map by Sobel-filtering an albedo is only valid where
     the albedo's luminance really is relief. In these hand-painted canvases
     it mostly is NOT: the cream stucco is a large, soft, meandering painted
     pattern, and a Sobel of that produced raised embossed ridges that looked
     exactly like the contour lines on a map. That artifact is far worse than
     having no normal map at all.
     Two changes keep the honest part and drop the lie:
       1. HIGH-PASS the height before differentiating. A real surface's relief
          is high-frequency (grain, chips, mortar lines); a painted pattern is
          low-frequency. Subtracting a wide box blur keeps the first and
          deletes the second, which is precisely the ridges.
       2. Cut the amplitude hard. Every SURF strength above is roughly a third
          of what it was, and normalScale is a quarter.
     Where relief is genuinely painted in -- brick mortar, grating -- it is
     high-frequency, so it survives the high-pass and still reads. */
  var ROUGH_CENTER = 0.82;   /* three MULTIPLIES roughnessMap.g by material.roughness */

  /* separable box blur with wrap-around, radius in texels */
  function blurWrap(src, res, r) {
    var n = res * res, tmp = new Float32Array(n), out = new Float32Array(n);
    var inv = 1 / (2 * r + 1), x, y, i, k, s;
    for (y = 0; y < res; y++) {
      var row = y * res;
      s = 0;
      for (k = -r; k <= r; k++) s += src[row + ((k % res) + res) % res];
      for (x = 0; x < res; x++) {
        tmp[row + x] = s * inv;
        s -= src[row + ((x - r) % res + res) % res];
        s += src[row + ((x + r + 1) % res + res) % res];
      }
    }
    for (x = 0; x < res; x++) {
      s = 0;
      for (k = -r; k <= r; k++) s += tmp[((k % res) + res) % res * res + x];
      for (y = 0; y < res; y++) {
        out[y * res + x] = s * inv;
        s -= tmp[(((y - r) % res + res) % res) * res + x];
        s += tmp[(((y + r + 1) % res + res) % res) * res + x];
      }
    }
    return out;
  }

  function deriveMaps(tex, strength, roughVar) {
    if (!tex || !tex.image) return null;
    if (!(strength > 0)) return null;
    var img = tex.image;
    var res = img.width | 0;
    if (!res || img.height !== res || res > 512) return null;
    var c = NZ.tex.canvasOf(res);
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, res, res);
    var d = g.getImageData(0, 0, res, res).data;
    var n = res * res, i, mean = 0;
    var h = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var j = i * 4;
      h[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255;
      mean += h[i];
    }
    mean /= n;

    /* high-pass: anything broader than ~1/16 of the tile is paint, not relief */
    var hp = h;
    try {
      var rad = Math.max(2, Math.round(res / 16));
      var lo = blurWrap(h, res, rad);
      hp = new Float32Array(n);
      for (i = 0; i < n; i++) hp[i] = clamp01(0.5 + (h[i] - lo[i]) * 1.35);
    } catch (e) { hp = h; }

    var nrm = NZ.tex.normalFromHeight(hp, res, strength);
    var normalMap = NZ.tex.texFromData(THREE, nrm, res, false);
    var r = new Float32Array(n);
    for (i = 0; i < n; i++) {
      /* darker, deeper areas hold grime and read rougher; raised, lighter
         areas polish. That correlation is what sells a real surface. */
      r[i] = clamp01(ROUGH_CENTER + (mean - h[i]) * roughVar * 2.0);
    }
    var roughnessMap = NZ.tex.texFromScalar(THREE, r, res);
    derivedMaps.push(normalMap, roughnessMap);
    return { normalMap: normalMap, roughnessMap: roughnessMap };
  }

  var mapCache = null;

  function upgradeMaterials() {
    var converted = 0, standard = 0, seen = {}, casters = 0;
    var toDispose = [];
    mapCache = mapCache || {};

    scene.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || seen[m.uuid]) {
          if (m && m.__nzNew) { if (Array.isArray(o.material)) o.material[i] = m.__nzNew; else o.material = m.__nzNew; }
          continue;
        }
        seen[m.uuid] = 1;

        if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
          m.envMapIntensity = 1.0;
          m.needsUpdate = true;
          standard++;
          continue;
        }
        if (!m.isMeshPhongMaterial) continue;

        var key = (m.name || '').replace(/^world:/, '');
        var s = SURF[key];
        if (!s) {
          /* fall back to the Blinn exponent the level author already chose */
          var rr = Math.sqrt(2 / (Math.max(1, m.shininess) + 2));
          s = [Math.min(0.95, Math.max(0.12, 0.30 + rr * 1.10)), 0.0, 1.2, 0.24];
        }
        var n = new THREE.MeshStandardMaterial({
          map: m.map,
          color: m.color.clone(),
          vertexColors: m.vertexColors,
          roughness: s[0],
          metalness: s[1],
          fog: m.fog,
          side: m.side,
          transparent: m.transparent,
          opacity: m.opacity,
          alphaTest: m.alphaTest,
          depthWrite: m.depthWrite,
          dithering: true
        });
        /* derived relief: skip glass (its albedo is lit windows, not relief)
           and anything transparent */
        if (m.map && s[2] > 0 && !m.transparent && key !== 'glass') {
          try {
            var ck = key + '|' + s[2] + '|' + s[3];
            var set = mapCache[ck];
            if (set === undefined) {
              set = deriveMaps(m.map, s[2], s[3]);
              mapCache[ck] = set || null;
            }
            if (set) {
              n.normalMap = set.normalMap;
              /* 0.20, not 0.75. At three quarters the derived relief was the
                 loudest thing in the frame and it was the one thing in the
                 frame that was not real. */
              n.normalScale.set(0.20, 0.20);
              /* the map is centred on ROUGH_CENTER and three multiplies, so
                 the scalar has to be pre-divided or the surface ends up at
                 roughness squared */
              var rScalar = s[0] / ROUGH_CENTER;
              if (rScalar <= 1.0) { n.roughnessMap = set.roughnessMap; n.roughness = rScalar; }
            }
          } catch (e) { /* relief is a bonus, never a requirement */ }
        }
        n.envMapIntensity = 1.0;
        n.name = m.name;
        n.userData.nzRough = s[0];
        n.userData.nzMetal = s[1];
        m.__nzNew = n;
        toDispose.push(m);
        if (Array.isArray(o.material)) o.material[i] = n; else o.material = n;
        converted++;
      }
    });

    /* second sweep: shared materials referenced by more than one mesh */
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      if (Array.isArray(o.material)) {
        for (var i = 0; i < o.material.length; i++)
          if (o.material[i] && o.material[i].__nzNew) o.material[i] = o.material[i].__nzNew;
      } else if (o.material.__nzNew) {
        o.material = o.material.__nzNew;
      }
      /* big merged level meshes: let them cast so interiors actually get
         occluded from the sun instead of being lit through the ceiling.
         Remembered, not just set: worldCast is a tier/degrade knob and this
         sweep only ever runs once, so without the list a machine that
         degrades past it would keep paying for it forever. setWorldCast()
         below is what actually honours the ladder, and panic() uses the same
         list to hand every mesh its original flag back. */
      if (o.receiveShadow && !o.castShadow &&
          o.geometry && o.geometry.attributes && o.geometry.attributes.color) {
        worldCasters.push(o);
        if (EFF.worldCast) { o.castShadow = true; casters++; }
      }
    });

    for (var d = 0; d < toDispose.length; d++) { toDispose[d].__nzNew = null; toDispose[d].dispose(); }

    NZ.log('materials: ' + converted + ' phong->standard, ' + standard + ' standard tuned, ' +
           casters + ' new shadow casters, ' + (derivedMaps.length >> 1) + ' relief sets');
  }

  /* ====================================================================== */
  /*  baked-lighting neutralisation                                         */
  /* ====================================================================== */
  /* THE root cause of the per-room exposure lottery, and it is not exposure.
     There is no auto-exposure in this pipeline at all -- P.exposure is a
     constant -- so nothing here can "react per view".

     NUKEM.html bakes a night-time light solution into the level's vertex
     colours (buildWorld -> quad3 -> lightAt): a per-region ambient term of
     0.06..0.24 plus point lamps with 1/r^2 falloff and a line-of-sight test,
     clamped to 1.45. makeWorldMaterial() then sets vertexColors:true, so that
     bake is a MULTIPLIER on albedo. nz-env keeps it (it multiplies its own
     contact AO into the same attribute and applies it at <color_fragment>),
     and doors/lifts carry the same number in material.color.

     Consequence: a surface the bake never reached is multiplied by ~0.10
     before a single real photon is considered. Sky IBL, sun, probe, none of it
     can recover a factor of ten. That is exactly the split seen in the contact
     sheet -- the theatre-lobby floor sits under a lamp and reads correctly at
     ~0.8, the brick wall two metres away has no lamp in line of sight and sits
     at ~0.12, so the SAME room is three stops apart; the street-scene facades
     that face away from a lamp go to pure black against a correctly bright sky;
     and the corridor trim, which is close enough to a lamp to hit the 1.45
     clamp, blows out into white bars against those crushed walls.

     A bake and a live light rig are the same light counted twice. The live rig
     is the one with direction, occlusion and shadows, so it is the one that
     should carry the image. This compresses the bake onto a narrow multiplier
     around 1.0: it stops being a light solution and becomes what a level
     artist's vertex paint actually is -- a gentle tint and shaping pass.

     The curve is calibrated against the ACES transfer this pipeline actually
     ships, not by eye. That matters more than it sounds: three's ACES fit has
     a slope of about 0.10 at the origin, so near black a factor of eight in
     scene light is a factor of eighty on screen. A naive "lift the bake to 1.0
     everywhere" correction overshoots a 19/255 wall to 104/255 -- milky, flat,
     and a worse frame than the one it replaced. Measured targets, then:

       bake  ->  out    +stops     predicted screen value on this contact sheet
       0.10  -> 0.199   +0.99      alley wall       23 -> 62
       0.12  -> 0.224   +0.90      theatre brick    19 -> 51
       0.145 -> 0.256   +0.82      street facade    10 -> 31
       0.20  -> 0.322   +0.69      corridor wall    56 -> 107
       0.30  -> 0.424   +0.50
       0.60  -> 0.688   +0.20
       0.85  -> 0.868   +0.03      hotel lobby      98 -> 126
       0.90  -> 0.900    0.00      sunlit street    84 -> 82
       1.45  -> 0.994   -0.54      corridor trim   223 -> 212

     Dynamic range 20.7:1 -> 6.3:1: still two and a half stops of lamp shaping,
     but no longer four and a half stops of accidental exposure lottery. ref
     sits where the rooms that already read correctly sit, so those barely move
     and the crushed ones do all the travelling. */
  var BAKE = {
    ref: 0.90,        /* bake level treated as correctly exposed          */
    gamma: 0.68,      /* compression below ref -- this is the lift        */
    shoulder: 0.70,   /* rolloff rate above ref                           */
    head: 0.30,       /* most the brightest bake may exceed ref           */
    weight: 1.00,     /* 0 = keep the bake as-is, 1 = full curve          */
    tint: 0.55,       /* how much of the bake's colour cast survives      */
    lo: 0.15, hi: 1.35
  };

  function bakeCurve(L) {
    if (!(L > 0)) return BAKE.lo;
    var n = L / BAKE.ref, s;
    if (n <= 1) s = Math.pow(n, BAKE.gamma);
    else s = 1 + (1 - Math.exp(-(n - 1) * BAKE.shoulder)) * BAKE.head;
    var out = L + (BAKE.ref * s - L) * BAKE.weight;
    return out < BAKE.lo ? BAKE.lo : (out > BAKE.hi ? BAKE.hi : out);
  }

  /* remap one RGB triple in place through bakeCurve(), preserving hue at
     reduced saturation. r*k has luminance exactly t, so mixing it with vec3(t)
     changes only the chroma -- the level lands where the curve puts it no
     matter what colour the lamp was. */
  var bakeTmp = [0, 0, 0];
  function bakeRemapRGB(r, g, b) {
    var L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    var t = bakeCurve(L);
    if (L < 1e-5) { bakeTmp[0] = bakeTmp[1] = bakeTmp[2] = t; return bakeTmp; }
    var k = (t / L) * BAKE.tint, u = t * (1 - BAKE.tint);
    bakeTmp[0] = u + r * k; bakeTmp[1] = u + g * k; bakeTmp[2] = u + b * k;
    return bakeTmp;
  }

  /* Only the level. Enemy rigs, viewmodels and nz-env's emissive lens cards
     all use vertex colours for real colour data, never for a light bake, and
     every one of them is outside these two name spaces. */
  function bakedMatName(m) {
    if (!m || !m.name) return null;
    var s = String(m.name);
    if (s.indexOf('world:') === 0) return s.slice(6);
    if (s.indexOf('nzenv:') === 0) return s.slice(6);
    return null;
  }

  var bakeRestore = [];      /* [{attr, orig} | {mat, r,g,b}] */
  var bakeStats = { geos: 0, verts: 0, mats: 0, lo: 1, hi: 0, ran: false };

  function neutralizeBakedLighting() {
    if (!scene) return 0;
    var verts = 0, geos = 0, mats = 0, seenG = {}, seenM = {};
    bakeStats.lo = 1e9; bakeStats.hi = -1e9; bakeStats.ran = true;
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material || o.isSkinnedMesh || o.isInstancedMesh) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      var anyBaked = false;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        var key = bakedMatName(m);
        if (key === null) continue;
        /* the lens cards ARE the light fixtures; they must stay hot */
        if (key === 'lens' || m.isMeshBasicMaterial) continue;
        anyBaked = true;
        if (!m.vertexColors && m.color && !m.__nzBakeFixed && !seenM[m.uuid]) {
          seenM[m.uuid] = 1;
          /* doors, lifts and any un-upgraded box: the bake landed in
             material.color instead of an attribute */
          bakeRestore.push({ mat: m, r: m.color.r, g: m.color.g, b: m.color.b });
          var c = bakeRemapRGB(m.color.r, m.color.g, m.color.b);
          m.color.setRGB(c[0], c[1], c[2]);
          m.__nzBakeFixed = 1;
          mats++;
        }
      }
      if (!anyBaked) return;
      var g = o.geometry;
      if (!g || !g.attributes || !g.attributes.color) return;
      if (g.userData && g.userData.nzBakeFixed) return;
      if (seenG[g.uuid]) return;
      seenG[g.uuid] = 1;
      var attr = g.attributes.color;
      if (attr.itemSize < 3 || !attr.array || !attr.array.length) return;
      var a = attr.array, n = attr.count, s = attr.itemSize, j, k;
      bakeRestore.push({ attr: attr, orig: new Float32Array(a) });
      for (j = 0; j < n; j++) {
        k = j * s;
        var Lin = 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2];
        if (Lin < bakeStats.lo) bakeStats.lo = Lin;
        if (Lin > bakeStats.hi) bakeStats.hi = Lin;
        var v = bakeRemapRGB(a[k], a[k + 1], a[k + 2]);
        a[k] = v[0]; a[k + 1] = v[1]; a[k + 2] = v[2];
      }
      attr.needsUpdate = true;
      g.userData.nzBakeFixed = 1;
      verts += n; geos++;
    });
    bakeStats.geos = geos; bakeStats.verts = verts; bakeStats.mats = mats;
    if (!geos) { bakeStats.lo = 0; bakeStats.hi = 0; }
    if (geos || mats) {
      NZ.log('baked lighting neutralised: ' + geos + ' geometries (' + verts +
             ' verts), ' + mats + ' flat-colour materials; bake range ' +
             bakeStats.lo.toFixed(3) + '..' + bakeStats.hi.toFixed(3) + ' -> ' +
             bakeCurve(bakeStats.lo).toFixed(3) + '..' + bakeCurve(bakeStats.hi).toFixed(3));
    } else {
      NZ.log('baked lighting: NO world geometry matched -- rooms will still be crushed');
    }
    return geos;
  }

  function restoreBakedLighting() {
    for (var i = 0; i < bakeRestore.length; i++) {
      var e = bakeRestore[i];
      try {
        if (e.attr) {
          e.attr.array.set(e.orig);
          e.attr.needsUpdate = true;
        } else if (e.mat) {
          e.mat.color.setRGB(e.r, e.g, e.b);
          e.mat.__nzBakeFixed = 0;
        }
      } catch (err) {}
    }
    bakeRestore.length = 0;
    if (scene) {
      scene.traverse(function (o) {
        if (o.geometry && o.geometry.userData) o.geometry.userData.nzBakeFixed = 0;
      });
    }
  }

  /* ====================================================================== */
  /*  G-buffer prepass                                                      */
  /* ====================================================================== */
  /* View normal (octahedral, 2ch) + roughness + metalness, plus a world-only
     depth buffer that the viewmodel never touches. Drawn by swapping every
     opaque mesh's material for a cached lightweight twin -- three's own
     shader chunks give us skinning for free, so the aliens land in the
     G-buffer with their real animated normals. */
  var G_VERT = [
    '#include <common>',
    '#include <skinning_pars_vertex>',
    'varying vec3 vNzN;',
    'void main(){',
    '  #include <beginnormal_vertex>',
    '  #include <skinbase_vertex>',
    '  #include <skinnormal_vertex>',
    '  #include <defaultnormal_vertex>',
    '  vNzN = transformedNormal;',
    '  #include <begin_vertex>',
    '  #include <skinning_vertex>',
    '  #include <project_vertex>',
    '}'
  ].join('\n');

  function gFrag() {
    return [
      LIB,
      'uniform vec2 nzRM;',
      'varying vec3 vNzN;',
      'void main(){',
      /* a mesh with no normal attribute would hand us a zero vector and
         normalize() would poison the whole G-buffer with NaN */
      '  float nl = length(vNzN);',
      '  vec3 n = (nl > 1e-6) ? (vNzN / nl) : vec3(0.0, 0.0, 1.0);',
      '#ifdef DOUBLE_SIDED',
      '  n *= gl_FrontFacing ? 1.0 : -1.0;',
      '#endif',
      '  gl_FragColor = vec4(nzOctEnc(n), nzRM.x, nzRM.y);',
      '}'
    ].join('\n');
  }

  function gMatFor(src) {
    if (!src || src.transparent || src.wireframe) return null;
    if (src.isMeshBasicMaterial) return null;      /* sky dome, unlit decals */
    if (src.alphaTest > 0) return null;
    if (src.__nzG) return src.__nzG;
    var rough = 0.6, metal = 0.0;
    if (src.userData && src.userData.nzRough !== undefined) {
      rough = src.userData.nzRough; metal = src.userData.nzMetal || 0;
    } else if (src.isMeshStandardMaterial) {
      rough = src.roughness; metal = src.metalness;
    } else if (src.isMeshPhongMaterial) {
      rough = Math.min(0.95, Math.max(0.10, Math.sqrt(2 / (Math.max(1, src.shininess) + 2))));
    }
    var m = new THREE.ShaderMaterial({
      uniforms: { nzRM: { value: new THREE.Vector2(clamp01(rough), clamp01(metal)) } },
      vertexShader: G_VERT,
      fragmentShader: gFrag(),
      side: src.side,
      flatShading: !!src.flatShading,
      depthTest: true, depthWrite: true,
      blending: THREE.NoBlending,
      fog: false
    });
    m.extensions = { derivatives: false, fragDepth: false, drawBuffers: false, shaderTextureLOD: false };
    src.__nzG = m;
    gMats.push(m);
    return m;
  }

  function renderGBuffer() {
    if (!gRT || !gbufOk) return false;
    var i, k, ok = false;
    /* shadow maps are re-rendered on every renderer.render(); the prepass
       must not pay for them twice */
    var prevShadowAuto = renderer.shadowMap.autoUpdate;
    var prevShadowNeed = renderer.shadowMap.needsUpdate;
    var prevAuto = renderer.autoClear;
    var prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(tmpCol);
    gSwap.length = 0;
    try {
      scene.traverse(function (o) {
        if (!o.isMesh || !o.visible || !o.material) return;
        if (o.userData && o.userData.nzNoGBuffer) return;
        var mm = o.material, g;
        if (Array.isArray(mm)) {
          var arr = [];
          for (var j = 0; j < mm.length; j++) {
            g = gMatFor(mm[j]);
            if (!g) return;
            arr.push(g);
          }
          gSwap.push(o, mm);
          o.material = arr;
        } else {
          g = gMatFor(mm);
          if (!g) return;
          gSwap.push(o, mm);
          o.material = g;
        }
      });

      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(gRT);
      renderer.render(scene, camera);
      ok = true;
    } catch (err) {
      gbufOk = false;
      NZ.log('g-buffer prepass disabled after error:', err && err.message);
    }
    try {
      renderer.setClearColor(tmpCol, prevAlpha);
      renderer.autoClear = prevAuto;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeed;
    } catch (e2) {}
    for (i = 0, k = gSwap.length; i < k; i += 2) gSwap[i].material = gSwap[i + 1];
    gSwap.length = 0;
    return ok;
  }

  function disposeGMats() {
    for (var i = 0; i < gMats.length; i++) {
      try { gMats[i].dispose(); } catch (e) {}
    }
    gMats.length = 0;
    if (scene) {
      scene.traverse(function (o) {
        if (!o.material) return;
        var l = Array.isArray(o.material) ? o.material : [o.material];
        for (var j = 0; j < l.length; j++) if (l[j]) l[j].__nzG = null;
      });
    }
  }

  /* ====================================================================== */
  /*  pass materials                                                        */
  /* ====================================================================== */
  function buildQuad() {
    quadScene = new THREE.Scene();
    quadScene.matrixWorldAutoUpdate = false;
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quadMesh.frustumCulled = false;
    quadMesh.matrixAutoUpdate = false;
    quadScene.add(quadMesh);
  }

  /* shared view-space reconstruction helpers, jitter aware */
  var VIEWSPACE = [
    'uniform vec2 uProjInfo, uJitter;',
    'uniform float uNear, uFar;',
    'vec3 nzPosAt(vec2 uv, float z){ return vec3(((uv * 2.0 - 1.0) + uJitter) * uProjInfo * (-z), z); }',
    'vec2 nzUvOf(vec3 p){ return ((p.xy / (uProjInfo * max(1e-4, -p.z))) - uJitter) * 0.5 + 0.5; }'
  ].join('\n');

  function buildMaterials() {
    disposeMaterials();

    /* --------------------------------------------------------------- GTAO */
    /* Slice-based horizon search with cosine weighting and a thin-occluder
       heuristic (Jimenez / XeGTAO). Unlike a hemisphere-sample SSAO this
       integrates the actual visible arc, so it does not halo at silhouettes
       and it does not go grey on flat walls. The same pass ray-marches the
       sun direction for contact shadows -- it already has the depth and the
       normal in registers, so the marginal cost is small. */
    mAo = makeMat([
      LIB, VIEWSPACE,
      'uniform sampler2D tDepth, tNormal;',
      'uniform vec2 uTexel;',
      'uniform float uRadius, uProjScale, uFalloffMul, uFalloffAdd, uThin, uPower, uSeed;',
      'uniform float uMinPix, uMaxPix;',
      'uniform vec3 uSunView;',
      'uniform float uCsLen, uCsThick, uCsBias, uCsFade, uCsOn;',
      'varying vec2 vUv;',
      'float nzZ(vec2 uv){ return nzViewZ(texture2D(tDepth, uv).x, uNear, uFar); }',
      'void main(){',
      '  float d = texture2D(tDepth, vUv).x;',
      '  if (d >= 0.999995) { gl_FragColor = vec4(1.0, uFar, 1.0, 1.0); return; }',
      '  float vz = nzViewZ(d, uNear, uFar);',
      '  vec3 P = nzPosAt(vUv, vz);',
      '  vec3 N = nzOctDec(texture2D(tNormal, vUv).rg);',
      '  vec3 V = normalize(-P);',
      '  if (dot(N, V) < 0.0) N = -N;',
      '  float noise = nzIgn(gl_FragCoord.xy + uSeed);',
      '  float pixR = clamp(uRadius * uProjScale / max(0.05, -vz), uMinPix, uMaxPix);',
      '  float vis = 0.0;',
      '  for (int s = 0; s < AO_SLICES; s++) {',
      '    float phi = (float(s) + noise) * (3.14159265 / float(AO_SLICES));',
      '    vec2 omega = vec2(cos(phi), sin(phi));',
      '    vec3 dirV = vec3(omega, 0.0);',
      '    vec3 orthoV = dirV - dot(dirV, V) * V;',
      '    vec3 axisV = normalize(cross(orthoV, V));',
      '    vec3 projN = N - axisV * dot(N, axisV);',
      '    float projLen = length(projN);',
      '    if (projLen < 1e-4) continue;',
      '    float sgn = (dot(orthoV, projN) < 0.0) ? -1.0 : 1.0;',
      '    float cosNorm = clamp(dot(projN, V) / projLen, 0.0, 1.0);',
      '    float nAng = sgn * acos(cosNorm);',
      '    float lowCos0 = cos(nAng + 1.5707963);',
      '    float lowCos1 = cos(nAng - 1.5707963);',
      '    float hCos0 = lowCos0, hCos1 = lowCos1;',
      '    for (int t = 0; t < AO_STEPS; t++) {',
      '      float st = (float(t) + fract(noise + float(t) * 0.6180339887)) / float(AO_STEPS);',
      '      st = st * st;',
      '      vec2 off = omega * (pixR * max(st, 1.5 / max(pixR, 1.5))) * uTexel;',
      '      vec2 uvA = vUv + off, uvB = vUv - off;',
      '      if (uvA.x > 0.0 && uvA.x < 1.0 && uvA.y > 0.0 && uvA.y < 1.0) {',
      '        float za = nzZ(uvA);',
      '        vec3 da = nzPosAt(uvA, za) - P;',
      '        float la = length(da);',
      '        float ca = (la > 1e-5) ? dot(da / la, V) : lowCos0;',
      '        float wa = saturate(la * uFalloffMul + uFalloffAdd);',
      '        ca = mix(lowCos0, ca, wa);',
      '        hCos0 = (ca > hCos0) ? ca : mix(hCos0, ca, uThin);',
      '      }',
      '      if (uvB.x > 0.0 && uvB.x < 1.0 && uvB.y > 0.0 && uvB.y < 1.0) {',
      '        float zb = nzZ(uvB);',
      '        vec3 db = nzPosAt(uvB, zb) - P;',
      '        float lb = length(db);',
      '        float cb = (lb > 1e-5) ? dot(db / lb, V) : lowCos1;',
      '        float wb = saturate(lb * uFalloffMul + uFalloffAdd);',
      '        cb = mix(lowCos1, cb, wb);',
      '        hCos1 = (cb > hCos1) ? cb : mix(hCos1, cb, uThin);',
      '      }',
      '    }',
      '    float h0 = -acos(clamp(hCos1, -1.0, 1.0));',
      '    float h1 =  acos(clamp(hCos0, -1.0, 1.0));',
      '    h0 = nAng + max(h0 - nAng, -1.5707963);',
      '    h1 = nAng + min(h1 - nAng,  1.5707963);',
      '    float sn = sin(nAng);',
      '    float iarc0 = (cosNorm + 2.0 * h0 * sn - cos(2.0 * h0 - nAng)) * 0.25;',
      '    float iarc1 = (cosNorm + 2.0 * h1 * sn - cos(2.0 * h1 - nAng)) * 0.25;',
      '    vis += projLen * (iarc0 + iarc1);',
      '  }',
      '  vis = saturate(vis / float(AO_SLICES));',
      '  vis = pow(vis, uPower);',
      /* -------- screen-space contact shadow along the sun direction ------ */
      '  float cs = 1.0;',
      '#ifdef USE_CONTACT',
      '  if (uCsOn > 0.5 && dot(N, uSunView) > 0.02) {',
      '    vec3 ro = P + N * (uCsBias * (1.0 + 0.25 * (-vz)));',
      '    float stepLen = uCsLen / float(CS_STEPS);',
      '    float jit = fract(noise * 1.37 + 0.5);',
      '    for (int i = 1; i <= CS_STEPS; i++) {',
      '      vec3 sp = ro + uSunView * (stepLen * (float(i) - jit));',
      '      if (sp.z > -uNear) break;',
      '      vec2 suv = nzUvOf(sp);',
      '      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;',
      '      float sd = texture2D(tDepth, suv).x;',
      '      if (sd >= 0.999995) continue;',
      '      float sz = nzViewZ(sd, uNear, uFar);',
      '      float diff = sz - sp.z;',
      '      if (diff > 0.012 && diff < uCsThick) { cs = 0.0; break; }',
      '    }',
      '    cs = mix(1.0, cs, saturate(1.0 - (-vz) / uCsFade));',
      '  }',
      '#endif',
      '  gl_FragColor = vec4(vis, -vz, cs, 1.0);',
      '}'
    ].join('\n'), {
      tDepth: { value: null }, tNormal: { value: null },
      uTexel: { value: new THREE.Vector2() }, uProjInfo: { value: new THREE.Vector2() },
      uJitter: { value: new THREE.Vector2() },
      uNear: { value: 0.1 }, uFar: { value: 900 },
      uRadius: { value: P.aoRadius }, uProjScale: { value: 500 },
      uFalloffMul: { value: -1 }, uFalloffAdd: { value: 1 },
      uThin: { value: P.aoThin }, uPower: { value: P.aoPower }, uSeed: { value: 0 },
      uMinPix: { value: 3 }, uMaxPix: { value: 96 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uCsLen: { value: P.contactLength }, uCsThick: { value: P.contactThick },
      uCsBias: { value: 0.018 }, uCsFade: { value: 26 }, uCsOn: { value: 1 }
    }, (function () {
      var dfn = { AO_SLICES: Math.max(1, EFF.aoSlices), AO_STEPS: Math.max(1, EFF.aoSteps) };
      if (EFF.contact) { dfn.USE_CONTACT = ''; dfn.CS_STEPS = Math.max(2, EFF.csSteps); }
      return dfn;
    })());

    /* ------------------------------------------------ depth-aware denoise */
    mAoBlur = makeMat([
      LIB,
      'uniform sampler2D tAO;',
      'uniform vec2 uDir;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec4 c = texture2D(tAO, vUv);',
      '  float zc = c.g;',
      '  float w[4];',
      '  w[0] = 0.194595; w[1] = 0.121622; w[2] = 0.054054; w[3] = 0.016216;',
      '  float rSum = c.r * 0.227027, cSum = c.b * 0.227027, wSum = 0.227027;',
      '  float tol = max(0.06, zc * 0.035);',
      '  for (int i = 1; i <= 4; i++) {',
      '    vec2 o = uDir * float(i);',
      '    vec4 a = texture2D(tAO, vUv + o);',
      '    vec4 b = texture2D(tAO, vUv - o);',
      '    float wa = w[i - 1] * exp(-abs(a.g - zc) / tol);',
      '    float wb = w[i - 1] * exp(-abs(b.g - zc) / tol);',
      '    rSum += a.r * wa + b.r * wb;',
      '    cSum += a.b * wa + b.b * wb;',
      '    wSum += wa + wb;',
      '  }',
      '  gl_FragColor = vec4(rSum / max(1e-4, wSum), zc, cSum / max(1e-4, wSum), 1.0);',
      '}'
    ].join('\n'), {
      tAO: { value: null }, uDir: { value: new THREE.Vector2() }
    });

    /* ---------------------------------------------------------------- SSR */
    if (EFF.ssr) {
      mSsr = makeMat([
        LIB, VIEWSPACE,
        'uniform sampler2D tDepth, tG, tPrev;',
        'uniform vec2 uTexel;',
        'uniform mat4 uReproj;',
        'uniform float uSeed, uRoughCut, uMaxDist, uThick, uMaxPix, uEdge, uClamp, uHasHist;',
        'varying vec2 vUv;',
        'float nzZ(vec2 uv){ return nzViewZ(texture2D(tDepth, uv).x, uNear, uFar); }',
        'void main(){',
        '  gl_FragColor = vec4(0.0);',
        '  if (uHasHist < 0.5) return;',
        '  vec4 g = texture2D(tG, vUv);',
        '  float rough = g.b;',
        '  if (rough > uRoughCut) return;',
        '  float d = texture2D(tDepth, vUv).x;',
        '  if (d >= 0.999995) return;',
        '  float vz = nzViewZ(d, uNear, uFar);',
        '  vec3 P = nzPosAt(vUv, vz);',
        '  vec3 N = nzOctDec(g.rg);',
        '  vec3 V = normalize(-P);',
        '  if (dot(N, V) < 0.0) N = -N;',
        '  vec3 R = reflect(-V, N);',
        /* roughness cone: jitter the ray inside the lobe and let TAA and the
           bilateral resolve do the integration */
        '  float r0 = nzIgn(gl_FragCoord.xy + uSeed);',
        '  float r1 = nzHash(gl_FragCoord.xy + uSeed * 1.61);',
        '  vec3 T = normalize(cross((abs(N.z) < 0.9) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0), N));',
        '  vec3 B = cross(N, T);',
        '  float lobe = rough * rough * 0.72 * sqrt(r1);',
        '  float ang = r0 * 6.2831853;',
        '  R = normalize(R + (T * cos(ang) + B * sin(ang)) * lobe);',
        '  if (dot(R, N) <= 0.02) return;',
        '  vec3 P0 = P + N * (0.02 - 0.004 * vz);',
        '  float dist = uMaxDist;',
        '  vec3 P1 = P0 + R * dist;',
        '  if (P1.z > -uNear - 0.01) {',
        '    dist = max(0.05, (-uNear - 0.01 - P0.z) / max(1e-4, R.z));',
        '    P1 = P0 + R * dist;',
        '  }',
        '  vec2 uv0 = nzUvOf(P0), uv1 = nzUvOf(P1);',
        '  float k0 = 1.0 / max(1e-4, -P0.z), k1 = 1.0 / max(1e-4, -P1.z);',
        '  vec2 duv = uv1 - uv0;',
        '  float lenPix = length(duv / uTexel);',
        '  if (lenPix > uMaxPix) { float f = uMaxPix / lenPix; uv1 = uv0 + duv * f; k1 = mix(k0, k1, f); }',
        '  if (lenPix < 1.0) return;',
        '  float steps = float(SSR_STEPS);',
        '  float tHit = -1.0, tLo = 0.0;',
        '  for (int i = 1; i <= SSR_STEPS; i++) {',
        /* quadratic step schedule: sub-pixel near the origin where contact
           reflections live and the eye checks alignment, coarse far away
           where the binary refine cleans up. This is the cheap stand-in for
           a hierarchical depth march. */
        '    float f = (float(i) - r0) / steps;',
        '    float t = f * f;',
        '    if (t <= 0.0) continue;',
        '    vec2 suv = mix(uv0, uv1, t);',
        '    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;',
        '    float sd = texture2D(tDepth, suv).x;',
        '    float rayZ = -1.0 / mix(k0, k1, t);',
        '    if (sd >= 0.999995) { tLo = t; continue; }',
        '    float sceneZ = nzViewZ(sd, uNear, uFar);',
        '    float diff = sceneZ - rayZ;',
        '    if (diff > 0.0 && diff < uThick - 0.03 * rayZ) { tHit = t; break; }',
        '    tLo = t;',
        '  }',
        '  if (tHit < 0.0) return;',
        '  float lo = tLo, hi = tHit;',
        '  for (int j = 0; j < SSR_REFINE; j++) {',
        '    float mid = (lo + hi) * 0.5;',
        '    float rz = -1.0 / mix(k0, k1, mid);',
        '    float sz = nzZ(mix(uv0, uv1, mid));',
        '    if (sz - rz > 0.0) hi = mid; else lo = mid;',
        '  }',
        '  vec2 hitUv = mix(uv0, uv1, hi);',
        '  float hitZ = nzZ(hitUv);',
        '  vec3 hitP = nzPosAt(hitUv, hitZ);',
        '  vec4 hg = texture2D(tG, hitUv);',
        '  vec3 hitN = nzOctDec(hg.rg);',
        '  float facing = saturate(-dot(hitN, R) * 2.0);',
        '  if (facing <= 0.01) return;',
        /* the colour comes from last frame's resolved HDR buffer, reprojected */
        '  vec4 pc = uReproj * vec4(hitP, 1.0);',
        '  if (pc.w <= 0.0) return;',
        '  vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;',
        '  if (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) return;',
        '  vec3 col = min(texture2D(tPrev, puv).rgb, vec3(uClamp));',
        '  vec2 fh = smoothstep(vec2(0.0), vec2(uEdge), hitUv) * (1.0 - smoothstep(vec2(1.0 - uEdge), vec2(1.0), hitUv));',
        '  vec2 fp = smoothstep(vec2(0.0), vec2(uEdge), puv) * (1.0 - smoothstep(vec2(1.0 - uEdge), vec2(1.0), puv));',
        '  float conf = fh.x * fh.y * fp.x * fp.y * facing;',
        '  conf *= 1.0 - smoothstep(uRoughCut * 0.55, uRoughCut, rough);',
        '  conf *= 1.0 - 0.30 * hi * hi;',
        '  gl_FragColor = vec4(col, saturate(conf));',
        '}'
      ].join('\n'), {
        tDepth: { value: null }, tG: { value: null }, tPrev: { value: null },
        uTexel: { value: new THREE.Vector2() }, uProjInfo: { value: new THREE.Vector2() },
        uJitter: { value: new THREE.Vector2() },
        uNear: { value: 0.1 }, uFar: { value: 900 },
        uReproj: { value: new THREE.Matrix4() },
        uSeed: { value: 0 }, uRoughCut: { value: P.ssrRough },
        uMaxDist: { value: P.ssrDist }, uThick: { value: P.ssrThick },
        uMaxPix: { value: 520 }, uEdge: { value: 0.12 }, uClamp: { value: 12 },
        uHasHist: { value: 0 }
      }, { SSR_STEPS: Math.max(4, EFF.ssrSteps), SSR_REFINE: Math.max(1, EFF.ssrRefine) });

      /* roughness-driven cone blur, depth guided so it never bleeds between
         two surfaces at different distances */
      mSsrBlur = makeMat([
        LIB,
        'uniform sampler2D tSsr, tG, tAO;',
        'uniform vec2 uDir;',
        'uniform float uScale;',
        'varying vec2 vUv;',
        'void main(){',
        '  vec4 c = texture2D(tSsr, vUv);',
        '  float rough = texture2D(tG, vUv).b;',
        '  float zc = texture2D(tAO, vUv).g;',
        '  float rad = max(1.0, rough * uScale);',
        '  vec3 acc = c.rgb * c.a;',
        '  float aSum = c.a, wSum = 1.0;',
        '  float tol = max(0.08, zc * 0.05);',
        '  for (int i = 1; i <= 4; i++) {',
        '    vec2 o = uDir * (float(i) * rad);',
        '    vec4 a = texture2D(tSsr, vUv + o);',
        '    vec4 b = texture2D(tSsr, vUv - o);',
        '    float za = texture2D(tAO, vUv + o).g;',
        '    float zb = texture2D(tAO, vUv - o).g;',
        '    float wa = exp(-abs(za - zc) / tol) * (1.0 - 0.15 * float(i));',
        '    float wb = exp(-abs(zb - zc) / tol) * (1.0 - 0.15 * float(i));',
        '    acc += a.rgb * a.a * wa + b.rgb * b.a * wb;',
        '    aSum += a.a * wa + b.a * wb;',
        '    wSum += wa + wb;',
        '  }',
        '  gl_FragColor = vec4(acc / max(1e-4, aSum), aSum / max(1e-4, wSum));',
        '}'
      ].join('\n'), {
        tSsr: { value: null }, tG: { value: null }, tAO: { value: null },
        uDir: { value: new THREE.Vector2() }, uScale: { value: 6.0 }
      });
    }

    /* ---------------------------------------------------------------- TAA */
    /* Neighbourhood clip in YCoCg (chroma ghosting is what the eye catches),
       Catmull-Rom history resampling so the resolve is not a blur, and an
       explicit viewmodel test: the gun moves with the camera, so reprojecting
       it like world geometry is exactly what smears it. */
    var taaDef = {};
    if (EFF.gbuf >= 0.999) taaDef.USE_VMMASK = '';
    mTaa = makeMat([
      LIB,
      'uniform sampler2D tCur, tHist, tDepth, tWorldDepth;',
      'uniform mat4 uReproj;',
      'uniform vec2 uTexel, uProjInfo, uJitter, uRes;',
      'uniform float uNear, uFar, uBlend, uHasHist;',
      'varying vec2 vUv;',
      'vec3 nzCatmullRom(sampler2D tex, vec2 uv){',
      '  vec2 sp = uv * uRes;',
      '  vec2 tp1 = floor(sp - 0.5) + 0.5;',
      '  vec2 f = sp - tp1;',
      '  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));',
      '  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);',
      '  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));',
      '  vec2 w3 = f * f * (-0.5 + 0.5 * f);',
      '  vec2 w12 = w1 + w2;',
      '  vec2 o12 = w2 / max(w12, vec2(1e-5));',
      '  vec2 tp0 = (tp1 - 1.0) / uRes;',
      '  vec2 tp3 = (tp1 + 2.0) / uRes;',
      '  vec2 tp12 = (tp1 + o12) / uRes;',
      '  vec3 r = vec3(0.0); float wsum = 0.0; float w;',
      '  w = w12.x * w0.y;  r += texture2D(tex, vec2(tp12.x, tp0.y)).rgb * w;  wsum += w;',
      '  w = w0.x * w12.y;  r += texture2D(tex, vec2(tp0.x, tp12.y)).rgb * w;  wsum += w;',
      '  w = w12.x * w12.y; r += texture2D(tex, vec2(tp12.x, tp12.y)).rgb * w; wsum += w;',
      '  w = w3.x * w12.y;  r += texture2D(tex, vec2(tp3.x, tp12.y)).rgb * w;  wsum += w;',
      '  w = w12.x * w3.y;  r += texture2D(tex, vec2(tp12.x, tp3.y)).rgb * w;  wsum += w;',
      '  return max(r / max(1e-5, wsum), vec3(0.0));',
      '}',
      /* Karis AABB clip: pull the history along the line back to the mean
         instead of clamping per channel. Per-channel clamping is what leaves
         a coloured fringe trailing a moving alien. */
      'vec3 nzClipAABB(vec3 mn, vec3 mx, vec3 q){',
      '  vec3 ctr = 0.5 * (mx + mn);',
      '  vec3 ext = 0.5 * (mx - mn) + 1e-5;',
      '  vec3 v = q - ctr;',
      '  vec3 a = abs(v / ext);',
      '  float ma = max(a.x, max(a.y, a.z));',
      '  return (ma > 1.0) ? (ctr + v / ma) : q;',
      '}',
      'void main(){',
      '  vec3 cur = texture2D(tCur, vUv).rgb;',
      '  if (uHasHist < 0.5) { gl_FragColor = vec4(cur, 1.0); return; }',
      '  float d = texture2D(tDepth, vUv).x;',
      '  float vz = nzViewZ(d, uNear, uFar);',
      '  vec2 prevUv;',
      '  float isVm = 0.0;',
      '#ifdef USE_VMMASK',
      /* The viewmodel is drawn after the prepass, so it is the only thing in
         the colour depth buffer that is nearer than the world depth buffer.
         It is also rigid with the camera, which is exactly why reprojecting
         it like world geometry smears it across the screen on every turn. */
      '  float wz = -nzViewZ(texture2D(tWorldDepth, vUv).x, uNear, uFar);',
      '  float sz = -vz;',
      '  isVm = (sz < 6.0 && (wz - sz) > max(0.30, sz * 0.30)) ? 1.0 : 0.0;',
      '#endif',
      '  if (isVm > 0.5) {',
      /* screen-locked: the viewmodel is rigid with the camera, zero motion */
      '    prevUv = vUv;',
      '  } else {',
      '    vec2 ndc = (vUv * 2.0 - 1.0) + uJitter;',
      '    vec3 P = vec3(ndc * uProjInfo * (-vz), vz);',
      '    vec4 pc = uReproj * vec4(P, 1.0);',
      '    if (pc.w <= 0.0) { gl_FragColor = vec4(cur, 1.0); return; }',
      '    prevUv = (pc.xy / pc.w) * 0.5 + 0.5;',
      '  }',
      '  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {',
      '    gl_FragColor = vec4(cur, 1.0); return;',
      '  }',
      '  vec3 curY = nzRGBToYCoCg(cur);',
      '  vec3 m1 = vec3(0.0), m2 = vec3(0.0), mn = curY, mx = curY;',
      '  for (int y = -1; y <= 1; y++) {',
      '    for (int x = -1; x <= 1; x++) {',
      '      vec3 s = nzRGBToYCoCg(texture2D(tCur, vUv + vec2(float(x), float(y)) * uTexel).rgb);',
      '      m1 += s; m2 += s * s; mn = min(mn, s); mx = max(mx, s);',
      '    }',
      '  }',
      '  vec3 mu = m1 / 9.0;',
      '  vec3 sg = sqrt(max(vec3(0.0), m2 / 9.0 - mu * mu));',
      '  vec3 lo = max(mn, mu - 1.25 * sg);',
      '  vec3 hi = min(mx, mu + 1.25 * sg);',
      '  vec3 histY = nzClipAABB(lo, hi, nzRGBToYCoCg(nzCatmullRom(tHist, prevUv)));',
      '  vec3 hist = max(nzYCoCgToRGB(histY), vec3(0.0));',
      '  float vel = length((vUv - prevUv) * uRes);',
      '  float a = mix(uBlend, 0.42, saturate(vel / 24.0));',
      '  a = mix(a, 0.30, isVm);',
      /* Karis weighting: keeps one hot pixel from flickering forever */
      '  float wc = a / (1.0 + nzLuma(cur));',
      '  float wh = (1.0 - a) / (1.0 + nzLuma(hist));',
      '  gl_FragColor = vec4((cur * wc + hist * wh) / max(1e-5, wc + wh), 1.0);',
      '}'
    ].join('\n'), {
      tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
      tWorldDepth: { value: null },
      uReproj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uProjInfo: { value: new THREE.Vector2() },
      uJitter: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() },
      uNear: { value: 0.1 }, uFar: { value: 900 },
      uBlend: { value: 0.11 }, uHasHist: { value: 0 }
    }, taaDef);

    /* --------------------------------------------------- bloom prefilter */
    mPre = makeMat([
      LIB,
      'uniform sampler2D tSrc;',
      'uniform vec2 uTexel;',
      'uniform vec3 uCurve;',
      'uniform float uClampMax;',
      'varying vec2 vUv;',
      'vec3 tap(vec2 uv){ return min(texture2D(tSrc, uv).rgb, vec3(uClampMax)); }',
      'void main(){',
      '  vec3 a = tap(vUv + vec2(-1.0,-1.0) * uTexel);',
      '  vec3 b = tap(vUv + vec2( 1.0,-1.0) * uTexel);',
      '  vec3 c = tap(vUv + vec2(-1.0, 1.0) * uTexel);',
      '  vec3 d = tap(vUv + vec2( 1.0, 1.0) * uTexel);',
      '  float wa = 1.0 / (1.0 + nzLuma(a)), wb = 1.0 / (1.0 + nzLuma(b));',
      '  float wc = 1.0 / (1.0 + nzLuma(c)), wd = 1.0 / (1.0 + nzLuma(d));',
      '  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);',
      '  float br = max(col.r, max(col.g, col.b));',
      '  float soft = clamp(br - uCurve.x + uCurve.y, 0.0, 2.0 * uCurve.y);',
      '  soft = soft * soft * uCurve.z;',
      '  gl_FragColor = vec4(col * (max(soft, br - uCurve.x) / max(br, 1e-5)), 1.0);',
      '}'
    ].join('\n'), {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uCurve: { value: new THREE.Vector3() }, uClampMax: { value: P.bloomClamp }
    });

    mDown = makeMat([
      LIB,
      'uniform sampler2D tSrc;',
      'uniform vec2 uTexel;',
      'varying vec2 vUv;',
      'vec3 t(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }',
      'void main(){',
      '  vec3 a = t(vec2(-2.0, 2.0)), b = t(vec2(0.0, 2.0)), c = t(vec2(2.0, 2.0));',
      '  vec3 d = t(vec2(-2.0, 0.0)), e = t(vec2(0.0, 0.0)), f = t(vec2(2.0, 0.0));',
      '  vec3 g = t(vec2(-2.0,-2.0)), h = t(vec2(0.0,-2.0)), i = t(vec2(2.0,-2.0));',
      '  vec3 j = t(vec2(-1.0, 1.0)), k = t(vec2(1.0, 1.0));',
      '  vec3 l = t(vec2(-1.0,-1.0)), m = t(vec2(1.0,-1.0));',
      '  vec3 o = e * 0.125;',
      '  o += (a + c + g + i) * 0.03125;',
      '  o += (b + d + f + h) * 0.0625;',
      '  o += (j + k + l + m) * 0.125;',
      '  gl_FragColor = vec4(o, 1.0);',
      '}'
    ].join('\n'), {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }
    });

    mUp = makeMat([
      LIB,
      'uniform sampler2D tSrc;',
      'uniform vec2 uTexel;',
      'uniform float uScale;',
      'varying vec2 vUv;',
      'vec3 t(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uScale).rgb; }',
      'void main(){',
      '  vec3 s = t(vec2(-1.0, 1.0)) + t(vec2(0.0, 2.0)) * 2.0 + t(vec2(1.0, 1.0));',
      '  s += t(vec2(-2.0, 0.0)) * 2.0 + t(vec2(0.0, 0.0)) * 4.0 + t(vec2(2.0, 0.0)) * 2.0;',
      '  s += t(vec2(-1.0,-1.0)) + t(vec2(0.0,-2.0)) * 2.0 + t(vec2(1.0,-1.0));',
      '  gl_FragColor = vec4(s * (1.0 / 16.0), 1.0);',
      '}'
    ].join('\n'), {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uScale: { value: 1 }
    });
    mUp.blending = THREE.AdditiveBlending;

    /* ---------------------------------------------------------- composite */
    var compDef = {};
    if (EFF.gtao && !EFF.aoInMaterial) compDef.USE_AO = '';
    if (EFF.taa) compDef.USE_SHARPEN = '';
    if (caps.hdr) {
      compDef.USE_HDR = '';
      if (P.tonemap === 'aces') compDef.TM_ACES = '';
      else if (P.tonemap === 'neutral') compDef.TM_NEUTRAL = '';
      else compDef.TM_AGX = '';
    }

    mComp = makeMat([
      LIB, TONEMAP,
      'uniform sampler2D tScene, tBloom, tAO;',
      'uniform vec2 uTexel;',
      'uniform float uExposure, uBloom, uAO, uCA, uVignette, uGrain, uSeed;',
      'uniform float uSharpen, uAspect, uSat, uContrast, uDither;',
      'uniform vec3 uLift, uGain;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec2 dir = vUv - 0.5;',
      '  float r2 = dot(dir, dir);',
      /* lateral chromatic aberration, quadratic toward the corners only */
      '  vec2 off = dir * r2 * uCA;',
      '  vec3 c;',
      '  c.r = texture2D(tScene, vUv + off).r;',
      '  c.g = texture2D(tScene, vUv).g;',
      '  c.b = texture2D(tScene, vUv - off).b;',
      '#ifdef USE_SHARPEN',
      /* Ratio sharpen, not an absolute unsharp mask. Adding a laplacian to
         raw HDR values throws a white halo around every bright edge; scaling
         by a bounded luminance ratio recovers the resolve softness TAA costs
         without inventing energy or shifting hue. */
      '  float lc = nzLuma(c);',
      '  float ln = nzLuma(texture2D(tScene, vUv + vec2(0.0, uTexel.y)).rgb);',
      '  float ls = nzLuma(texture2D(tScene, vUv - vec2(0.0, uTexel.y)).rgb);',
      '  float le = nzLuma(texture2D(tScene, vUv + vec2(uTexel.x, 0.0)).rgb);',
      '  float lw = nzLuma(texture2D(tScene, vUv - vec2(uTexel.x, 0.0)).rgb);',
      '  float lap = lc * 4.0 - (ln + ls + le + lw);',
      '  c *= clamp(1.0 + uSharpen * (lap / max(lc, 0.02)), 0.70, 1.45);',
      '  c = max(c, vec3(0.0));',
      '#endif',
      '#ifdef USE_AO',
      /* fallback path only: without the material patch we cannot separate
         direct from indirect, so back off where the pixel is already hot */
      '  vec4 ao = texture2D(tAO, vUv);',
      '  float aoW = uAO * (1.0 - saturate(nzLuma(c) * 0.5));',
      '  c *= mix(1.0, ao.r * ao.b, aoW);',
      '#endif',
      '  c += texture2D(tBloom, vUv).rgb * uBloom;',
      /* exposure vignette before the curve reads as lens falloff, not a mask */
      '  float vig = 1.0 - uVignette * pow(saturate(length(dir * vec2(uAspect, 1.0)) * 1.32), 2.2);',
      '#ifdef USE_HDR',
      '  c = nzTonemap(c * uExposure * vig);',
      '#else',
      '  c = saturate(c * vig);',
      '#endif',
      /* gentle display-space S. Anything stronger and the grade starts to
         read as a filter rather than as a camera. */
      '  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);',
      '  c = max(vec3(0.0), c * uGain + uLift);',
      '  c = max(vec3(0.0), mix(vec3(nzLuma(c)), c, uSat));',
      '  vec3 srgb = nzLinearToSRGB(saturate(c));',
      /* grain lives in display space, thins out of highlights and shadows */
      '  float g = nzHash(gl_FragCoord.xy + uSeed) - 0.5;',
      '  float gw = 1.0 - abs(nzLuma(srgb) * 1.7 - 0.85);',
      '  srgb += g * uGrain * (0.35 + 0.65 * saturate(gw));',
      /* triangular dither: a night scene banding in 8 bit is a dead giveaway */
      '  float d1 = nzHash(gl_FragCoord.xy + uSeed + 11.3);',
      '  float d2 = nzHash(gl_FragCoord.xy + uSeed + 71.9);',
      '  srgb += (d1 + d2 - 1.0) * uDither;',
      '  gl_FragColor = vec4(saturate(srgb), 1.0);',
      '}'
    ].join('\n'), {
      tScene: { value: null }, tBloom: { value: null }, tAO: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uExposure: { value: 1.2 },
      uBloom: { value: P.bloom / Math.max(1, EFF.mips) },
      uAO: { value: 1.0 }, uCA: { value: P.ca }, uVignette: { value: P.vignette },
      uGrain: { value: P.grain }, uSeed: { value: 0 }, uSharpen: { value: P.sharpen },
      uAspect: { value: 1.7 }, uSat: { value: P.saturation },
      uContrast: { value: P.contrast }, uDither: { value: 1.0 / 255.0 },
      uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
      uGain: { value: new THREE.Vector3(1.0, 1.0, 1.0) }
    }, compDef);

    /* -------------------------------------------------------- motion blur */
    mBlur = makeMat([
      LIB,
      'uniform sampler2D tColor, tDepth, tWorldDepth;',
      'uniform mat4 uReproj;',
      'uniform vec2 uProjInfo, uJitter, uTexel;',
      'uniform float uNear, uFar, uStrength, uMaxLen, uSeed, uNearCut;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec3 base = texture2D(tColor, vUv).rgb;',
      '  float d = texture2D(tDepth, vUv).x;',
      '  float vz = nzViewZ(d, uNear, uFar);',
      '#ifdef USE_VMMASK',
      /* the viewmodel has no world velocity of its own; keep it crisp */
      '  float wz = -nzViewZ(texture2D(tWorldDepth, vUv).x, uNear, uFar);',
      '  if (-vz < 6.0 && (wz + vz) > max(0.30, -vz * 0.30)) { gl_FragColor = vec4(base, 1.0); return; }',
      '#endif',
      '  vec2 ndc = (vUv * 2.0 - 1.0) + uJitter;',
      '  vec3 P = vec3(ndc * uProjInfo * (-vz), vz);',
      '  vec4 pc = uReproj * vec4(P, 1.0);',
      '  if (pc.w <= 0.0) { gl_FragColor = vec4(base, 1.0); return; }',
      '  vec2 vel = (vUv - ((pc.xy / pc.w) * 0.5 + 0.5)) * uStrength;',
      '  vel *= smoothstep(uNearCut, uNearCut * 2.6, -vz);',
      '  float len = length(vel);',
      '  if (len < 0.0006) { gl_FragColor = vec4(base, 1.0); return; }',
      '  vel *= min(1.0, uMaxLen / len);',
      '  float j = (nzHash(gl_FragCoord.xy + uSeed) - 0.5) / float(MB_SAMPLES);',
      '  vec3 acc = vec3(0.0);',
      '  for (int i = 0; i < MB_SAMPLES; i++) {',
      '    float t = (float(i) + 0.5) / float(MB_SAMPLES) - 0.5 + j;',
      '    acc += texture2D(tColor, clamp(vUv + vel * t, vec2(0.0), vec2(1.0))).rgb;',
      '  }',
      '  gl_FragColor = vec4(acc / float(MB_SAMPLES), 1.0);',
      '}'
    ].join('\n'), {
      tColor: { value: null }, tDepth: { value: null }, tWorldDepth: { value: null },
      uReproj: { value: new THREE.Matrix4() },
      uProjInfo: { value: new THREE.Vector2() }, uJitter: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.1 }, uFar: { value: 900 },
      uStrength: { value: P.shutter }, uMaxLen: { value: 0.030 },
      uSeed: { value: 0 }, uNearCut: { value: 1.1 }
    }, (function () {
      var dfn = { MB_SAMPLES: Math.max(3, EFF.mbSamples || 6) };
      if (EFF.gbuf >= 0.999) dfn.USE_VMMASK = '';
      return dfn;
    })());

    /* --------------------------------------------------------------- FXAA */
    mFxaa = makeMat([
      LIB,
      'uniform sampler2D tDiffuse;',
      'uniform vec2 uTexel;',
      'varying vec2 vUv;',
      'float lum(vec3 c){ return sqrt(dot(c, vec3(0.299, 0.587, 0.114))); }',
      'void main(){',
      '  vec2 inv = uTexel;',
      '  vec3 cc = texture2D(tDiffuse, vUv).rgb;',
      '  float lc = lum(cc);',
      '  float lD = lum(texture2D(tDiffuse, vUv + vec2(0.0,-1.0) * inv).rgb);',
      '  float lU = lum(texture2D(tDiffuse, vUv + vec2(0.0, 1.0) * inv).rgb);',
      '  float lL = lum(texture2D(tDiffuse, vUv + vec2(-1.0,0.0) * inv).rgb);',
      '  float lR = lum(texture2D(tDiffuse, vUv + vec2( 1.0,0.0) * inv).rgb);',
      '  float lmin = min(lc, min(min(lD, lU), min(lL, lR)));',
      '  float lmax = max(lc, max(max(lD, lU), max(lL, lR)));',
      '  float range = lmax - lmin;',
      '  if (range < max(0.0312, lmax * 0.125)) { gl_FragColor = vec4(cc, 1.0); return; }',
      '  float lDL = lum(texture2D(tDiffuse, vUv + vec2(-1.0,-1.0) * inv).rgb);',
      '  float lUR = lum(texture2D(tDiffuse, vUv + vec2( 1.0, 1.0) * inv).rgb);',
      '  float lUL = lum(texture2D(tDiffuse, vUv + vec2(-1.0, 1.0) * inv).rgb);',
      '  float lDR = lum(texture2D(tDiffuse, vUv + vec2( 1.0,-1.0) * inv).rgb);',
      '  float lDU = lD + lU, lLR = lL + lR;',
      '  float lLC = lDL + lUL, lDC = lDL + lDR, lRC = lDR + lUR, lUC = lUR + lUL;',
      '  float eH = abs(-2.0 * lL + lLC) + abs(-2.0 * lc + lDU) * 2.0 + abs(-2.0 * lR + lRC);',
      '  float eV = abs(-2.0 * lU + lUC) + abs(-2.0 * lc + lLR) * 2.0 + abs(-2.0 * lD + lDC);',
      '  bool horz = eH >= eV;',
      '  float l1 = horz ? lD : lL;',
      '  float l2 = horz ? lU : lR;',
      '  float g1 = l1 - lc, g2 = l2 - lc;',
      '  bool steep1 = abs(g1) >= abs(g2);',
      '  float gScaled = 0.25 * max(abs(g1), abs(g2));',
      '  float stepLen = horz ? inv.y : inv.x;',
      '  float lAvg = 0.0;',
      '  if (steep1) { stepLen = -stepLen; lAvg = 0.5 * (l1 + lc); } else { lAvg = 0.5 * (l2 + lc); }',
      '  vec2 cuv = vUv;',
      '  if (horz) cuv.y += stepLen * 0.5; else cuv.x += stepLen * 0.5;',
      '  vec2 off = horz ? vec2(inv.x, 0.0) : vec2(0.0, inv.y);',
      '  vec2 uv1 = cuv - off, uv2 = cuv + off;',
      '  float e1 = lum(texture2D(tDiffuse, uv1).rgb) - lAvg;',
      '  float e2 = lum(texture2D(tDiffuse, uv2).rgb) - lAvg;',
      '  bool r1 = abs(e1) >= gScaled, r2 = abs(e2) >= gScaled;',
      '  bool both = r1 && r2;',
      '  if (!r1) uv1 -= off;',
      '  if (!r2) uv2 += off;',
      '  float q = 1.0;',
      '  for (int i = 2; i < 12; i++) {',
      '    if (both) break;',
      '    if (!r1) { e1 = lum(texture2D(tDiffuse, uv1).rgb) - lAvg; r1 = abs(e1) >= gScaled; }',
      '    if (!r2) { e2 = lum(texture2D(tDiffuse, uv2).rgb) - lAvg; r2 = abs(e2) >= gScaled; }',
      '    both = r1 && r2;',
      '    if (!r1) uv1 -= off * q;',
      '    if (!r2) uv2 += off * q;',
      '    q = min(q * 1.5, 4.0);',
      '  }',
      '  float d1 = horz ? (vUv.x - uv1.x) : (vUv.y - uv1.y);',
      '  float d2 = horz ? (uv2.x - vUv.x) : (uv2.y - vUv.y);',
      '  bool dir1 = d1 < d2;',
      '  float dFinal = min(d1, d2);',
      '  float thick = d1 + d2;',
      '  float pxOff = -dFinal / max(1e-6, thick) + 0.5;',
      '  bool smaller = lc < lAvg;',
      '  bool okVar = ((dir1 ? e1 : e2) < 0.0) != smaller;',
      '  float finalOff = okVar ? pxOff : 0.0;',
      '  float la = (1.0 / 12.0) * (2.0 * (lDU + lLR) + lLC + lRC);',
      '  float sp1 = clamp(abs(la - lc) / range, 0.0, 1.0);',
      '  float sp2 = (-2.0 * sp1 + 3.0) * sp1 * sp1;',
      '  finalOff = max(finalOff, sp2 * sp2 * 0.75);',
      '  vec2 fuv = vUv;',
      '  if (horz) fuv.y += finalOff * stepLen; else fuv.x += finalOff * stepLen;',
      '  gl_FragColor = vec4(texture2D(tDiffuse, fuv).rgb, 1.0);',
      '}'
    ].join('\n'), {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }
    });

    /* ---------------------------------------------------------------- copy */
    mCopy = makeMat([
      'uniform sampler2D tDiffuse;',
      'varying vec2 vUv;',
      'void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); }'
    ].join('\n'), { tDiffuse: { value: null } });
  }

  function disposeMaterials() {
    var all = [mTaa, mAo, mAoBlur, mSsr, mSsrBlur, mPre, mDown, mUp, mComp, mBlur, mFxaa, mCopy];
    for (var i = 0; i < all.length; i++) if (all[i]) all[i].dispose();
    mTaa = mAo = mAoBlur = mSsr = mSsrBlur = null;
    mPre = mDown = mUp = mComp = mBlur = mFxaa = mCopy = null;
  }

  /* ====================================================================== */
  /*  render target management                                              */
  /* ====================================================================== */
  function ensureTargets(force) {
    var size = renderer.getDrawingBufferSize(tmpVec2);
    var w = px(size.x * EFF.scale), h = px(size.y * EFF.scale);
    /* the sample count is baked into the FBO: a tier/degrade move that
       changes it needs a rebuild of the scene target, not a resize */
    var wantMs = EFF.msaa > 1 ? EFF.msaa : 0;
    if (sceneRT && (sceneRT.samples | 0) !== wantMs) sceneRT = killRT(sceneRT);
    var changed = force || w !== rtW || h !== rtH || !sceneRT;

    bufW = size.x; bufH = size.y;

    if (changed) {
      rtW = w; rtH = h;
      halfW = px(w / 2); halfH = px(h / 2);

      if (!sceneRT) sceneRT = makeRT(w, h, true, true, false, wantMs);
      else sceneRT.setSize(w, h);

      if (!ldrRT) ldrRT = makeRT(w, h, false, false);
      else ldrRT.setSize(w, h);
    }

    /* G-buffer + AO run at the same resolution so they share a depth buffer */
    var ngW = px(rtW * (EFF.gbuf || 1)), ngH = px(rtH * (EFF.gbuf || 1));
    if (EFF.gbuf > 0 && gbufOk) {
      /* nearest: bilinear across a silhouette blends two unrelated normals
         and SSR turns that into a smeared arc at every object edge */
      if (!gRT) { gRT = makeRT(ngW, ngH, false, true, true); gW = ngW; gH = ngH; }
      else if (changed || gW !== ngW || gH !== ngH) { gRT.setSize(ngW, ngH); gW = ngW; gH = ngH; }
    } else if (gRT) { gRT = killRT(gRT); gW = gH = 0; }

    if (EFF.gtao && gRT) {
      if (!aoRT) aoRT = makeRT(gW, gH, true, false);
      else if (changed || aoRT.width !== gW || aoRT.height !== gH) aoRT.setSize(gW, gH);
      if (!aoRT2) aoRT2 = makeRT(gW, gH, true, false);
      else if (changed || aoRT2.width !== gW || aoRT2.height !== gH) aoRT2.setSize(gW, gH);
    } else if (aoRT) { aoRT = killRT(aoRT); aoRT2 = killRT(aoRT2); }

    if (EFF.ssr && gRT) {
      if (!ssrRT) ssrRT = makeRT(rtW, rtH, true, false);
      else if (changed) ssrRT.setSize(rtW, rtH);
      if (!ssrRT2) ssrRT2 = makeRT(rtW, rtH, true, false);
      else if (changed) ssrRT2.setSize(rtW, rtH);
    } else if (ssrRT) { ssrRT = killRT(ssrRT); ssrRT2 = killRT(ssrRT2); }

    /* TAA history pair */
    if (EFF.taa) {
      if (!taaA) { taaA = makeRT(rtW, rtH, true, false); haveHistory = false; taaLast = null; }
      else if (changed) { taaA.setSize(rtW, rtH); haveHistory = false; taaLast = null; }
      if (!taaB) { taaB = makeRT(rtW, rtH, true, false); haveHistory = false; taaLast = null; }
      else if (changed) { taaB.setSize(rtW, rtH); haveHistory = false; taaLast = null; }
    } else if (taaA) { taaA = killRT(taaA); taaB = killRT(taaB); haveHistory = false; taaLast = null; }

    /* motion blur destination */
    if (EFF.mblur) {
      if (!ldrRT2) ldrRT2 = makeRT(rtW, rtH, false, false);
      else if (changed) ldrRT2.setSize(rtW, rtH);
    } else if (ldrRT2) { ldrRT2 = killRT(ldrRT2); }

    /* bloom mip chain */
    if (changed || bloomRT.length !== EFF.mips) {
      for (var i = 0; i < bloomRT.length; i++) killRT(bloomRT[i]);
      bloomRT = [];
      var bw = halfW, bh = halfH;
      for (var m = 0; m < EFF.mips; m++) {
        bloomRT.push(makeRT(bw, bh, true, false));
        bw = px(bw / 2); bh = px(bh / 2);
        if (bw < 2 || bh < 2) break;
      }
    }

    if (!whiteTex) {
      var data = new Uint8Array([255, 255, 255, 255]);
      whiteTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
      whiteTex.needsUpdate = true;
    }
  }

  function disposeTargets() {
    sceneRT = killRT(sceneRT); gRT = killRT(gRT);
    ldrRT = killRT(ldrRT); ldrRT2 = killRT(ldrRT2);
    taaA = killRT(taaA); taaB = killRT(taaB); taaLast = null;
    aoRT = killRT(aoRT); aoRT2 = killRT(aoRT2);
    ssrRT = killRT(ssrRT); ssrRT2 = killRT(ssrRT2);
    for (var i = 0; i < bloomRT.length; i++) killRT(bloomRT[i]);
    bloomRT = [];
    if (whiteTex) { try { whiteTex.dispose(); } catch (e) {} whiteTex = null; }
    rtW = rtH = gW = gH = 0;
  }

  /* ====================================================================== */
  /*  timing                                                                */
  /* ====================================================================== */
  function makeTiming() {
    var t = {
      names: [], cpu: {}, gpu: {}, ext: null, active: null, pool: [], pending: [],
      frames: 0, last: 0
    };
    if (NZ.debug && caps.webgl2) {
      try { t.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch (e) { t.ext = null; }
    }
    return t;
  }
  function tBegin(name) {
    if (!NZ.debug || !timing) return;
    timing.active = { name: name, t0: performance.now(), q: null };
    if (timing.ext && timing.pending.length < 24) {
      try {
        var q = timing.pool.pop() || gl.createQuery();
        gl.beginQuery(timing.ext.TIME_ELAPSED_EXT, q);
        timing.active.q = q;
      } catch (e) { timing.ext = null; }
    }
  }
  function tEnd() {
    if (!NZ.debug || !timing || !timing.active) return;
    var a = timing.active; timing.active = null;
    var ms = performance.now() - a.t0;
    timing.cpu[a.name] = (timing.cpu[a.name] || 0) * 0.9 + ms * 0.1;
    if (a.q) {
      try { gl.endQuery(timing.ext.TIME_ELAPSED_EXT); timing.pending.push(a); }
      catch (e) { timing.ext = null; }
    }
    if (timing.names.indexOf(a.name) < 0) timing.names.push(a.name);
  }
  function tPoll() {
    if (!NZ.debug || !timing) return;
    if (timing.ext) {
      for (var i = timing.pending.length - 1; i >= 0; i--) {
        var a = timing.pending[i];
        try {
          if (!gl.getQueryParameter(a.q, gl.QUERY_RESULT_AVAILABLE)) continue;
          var disjoint = gl.getParameter(timing.ext.GPU_DISJOINT_EXT);
          if (!disjoint) {
            var ns = gl.getQueryParameter(a.q, gl.QUERY_RESULT);
            timing.gpu[a.name] = (timing.gpu[a.name] || 0) * 0.9 + (ns / 1e6) * 0.1;
          }
        } catch (e) { timing.ext = null; }
        timing.pending.splice(i, 1);
        timing.pool.push(a.q);
      }
    }
    if (++timing.frames % 90 === 0) {
      var parts = [], total = 0;
      for (var n = 0; n < timing.names.length; n++) {
        var k = timing.names[n];
        var v = timing.gpu[k] !== undefined ? timing.gpu[k] : timing.cpu[k];
        total += v || 0;
        parts.push(k + ' ' + (v || 0).toFixed(2));
      }
      console.log('[nz] ' + (timing.ext ? 'gpu' : 'cpu') + ' ms | ' + parts.join('  ') +
        '  | total ' + total.toFixed(2) + '  | ' + rtW + 'x' + rtH +
        ' q=' + tier + ' d=' + degrade + ' frame ' + medianFrame().toFixed(2));
    }
  }

  /* ====================================================================== */
  /*  quality adaptation                                                    */
  /* ====================================================================== */
  function medianFrame() {
    if (!ftFill) return 16.7;
    var a = Array.prototype.slice.call(ftHist.subarray(0, ftFill));
    a.sort(function (x, y) { return x - y; });
    return a[a.length >> 1];
  }

  /* Walk the ladder to the next rung that actually resolves to a different
     effect set. On a low tier most rungs are already no-ops (you cannot turn
     SSR off twice), and stepping through them one 1.5s window at a time would
     waste ten seconds before reaching the rung that matters. */
  function nextDegrade(dir) {
    var cur = effectSignature(EFF);
    var save = degrade, d = degrade, e;
    while (dir > 0 ? d < 5 : d > 0) {
      d += dir;
      degrade = d;
      e = computeEffects();
      degrade = save;
      if (effectSignature(e) !== cur) return d;
    }
    degrade = save;
    return dir > 0 ? Math.min(5, save + 1) : Math.max(0, save - 1);
  }

  function effectSignature(e) {
    return [e.scale, e.taa ? 1 : 0, e.gbuf, e.gtao ? 1 : 0, e.aoSlices, e.aoSteps,
            e.ssr ? 1 : 0, e.ssrSteps, e.contact ? 1 : 0, e.csSteps,
            e.mblur ? 1 : 0, e.mbSamples, e.mips, e.shadow, e.extent,
            e.pcss ? 1 : 0, e.worldCast ? 1 : 0, e.msaa].join(',');
  }

  /* One step per 1.5s window, and it refuses to keep cutting quality when
     cutting quality is not buying frame time -- that is the death spiral
     where a CPU-bound game ends up at 480p for nothing. Two consecutive
     ineffective steps is the trigger, so a single unlucky window (a level
     hitch, a garbage collection) cannot lock the whole system down. */
  var noGain = 0;

  function adapt(now) {
    if (adaptLocked) return;
    if (now - lastAdapt < 1500) return;
    if (ftFill < ftHist.length) return;
    var med = medianFrame();
    if (med > 20.5 && degrade < 5) {
      if (degrade > 0 && lastDegradeMed > 0) {
        if (med > lastDegradeMed * 0.97) {
          noGain++;
          if (noGain >= 2) {
            degrade = Math.max(0, degrade - 2);
            adaptLocked = true;
            lastAdapt = now;
            NZ.log('adapt: two quality cuts bought nothing (' + med.toFixed(1) +
                   'ms), we are not GPU-post bound -- locking at degrade ' + degrade);
            applyEffects();
            return;
          }
        } else {
          noGain = 0;
        }
      }
      lastDegradeMed = med;
      degrade = nextDegrade(1); goodWindows = 0; lastAdapt = now;
      NZ.log('frame ' + med.toFixed(1) + 'ms -> degrade ' + degrade);
      applyEffects();
    } else if (med < 11.5 && degrade > 0) {
      /* wide dead band: 11.5 to 20.5ms. Anything tighter and the loop
         oscillates between two rungs forever on a machine sitting right on
         the boundary, which is far more distracting than either rung. */
      if (++goodWindows >= 3) {
        degrade = nextDegrade(-1);
        goodWindows = 0; lastAdapt = now; lastDegradeMed = 0; noGain = 0;
        NZ.log('frame ' + med.toFixed(1) + 'ms -> degrade ' + degrade);
        applyEffects();
      }
    } else {
      goodWindows = 0;
    }
  }

  /* meshes this module promoted to shadow casters, so the promotion can be
     undone by the degrade ladder and by panic() */
  var worldCasters = [];
  function setWorldCast(on) {
    for (var i = 0; i < worldCasters.length; i++) {
      try { worldCasters[i].castShadow = !!on; } catch (e) {}
    }
  }

  function applyEffects() {
    var prev = EFF;
    EFF = computeEffects();
    if (!prev || prev.worldCast !== EFF.worldCast) setWorldCast(EFF.worldCast);
    var needMat = !prev ||
      prev.gtao !== EFF.gtao || prev.taa !== EFF.taa || prev.ssr !== EFF.ssr ||
      prev.contact !== EFF.contact || prev.aoInMaterial !== EFF.aoInMaterial ||
      prev.aoSlices !== EFF.aoSlices || prev.aoSteps !== EFF.aoSteps ||
      prev.csSteps !== EFF.csSteps || prev.ssrSteps !== EFF.ssrSteps ||
      prev.ssrRefine !== EFF.ssrRefine || prev.mbSamples !== EFF.mbSamples ||
      prev.mips !== EFF.mips || prev.gbuf !== EFF.gbuf;
    if (needMat) buildMaterials();
    if (!prev || prev.shadow !== EFF.shadow || prev.extent !== EFF.extent ||
        prev.pcss !== EFF.pcss) applyShadowQuality();
    ensureTargets(!prev || prev.scale !== EFF.scale || prev.gbuf !== EFF.gbuf);
    ftFill = 0; ftIdx = 0;
    if (NZ.render) NZ.render.quality = tier;
  }

  /* ====================================================================== */
  /*  main frame                                                            */
  /* ====================================================================== */
  var HALTON = [];
  (function () {
    function halton(i, b) { var f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }
    for (var i = 1; i <= 8; i++) HALTON.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
  })();

  function setMaterialUniforms(aoOn, ssrOn) {
    if (!uAoP) return;
    uAoTex.value = (aoOn && aoRT) ? aoRT.texture : whiteTex;
    uSsrTex.value = (ssrOn && ssrRT) ? ssrRT.texture : whiteTex;
    uAoP.value.set(P.ao, P.contact, aoOn ? 1 : 0, P.specOcc);
    uSsrP.value.set(P.ssr, ssrOn ? 1 : 0, 0, 0);
    uInvRes.value.set(1 / Math.max(1, rtW), 1 / Math.max(1, rtH));
    if (uShadowP) uShadowP.value.w = EFF.pcss ? 1 : 0;
  }

  function renderFrame(dt) {
    var now = performance.now();
    ftHist[ftIdx] = Math.min(60, dt * 1000);
    ftIdx = (ftIdx + 1) % ftHist.length;
    if (ftFill < ftHist.length) ftFill++;
    if (!tierPinned || degrade > 0) adapt(now);

    /* the game resizes the canvas without always telling us */
    var size = renderer.getDrawingBufferSize(tmpVec2);
    if (size.x !== bufW || size.y !== bufH) ensureTargets(true);
    if (!sceneRT) return false;

    frameId++;
    var jIdx = frameId % HALTON.length;

    /* Materials keep appearing for a while after 'ready' -- weapons build
       their viewmodels lazily, enemies build a rig on first spawn. Re-sweep a
       handful of times early on so a late foreign shader hook still gets the
       AO/PCSS composition, then stop paying for the traverse. */
    if (wrapSweeps > 0 && (frameId % 40) === 3) { wrapSweeps--; wrapForeignMaterials(); }
    /* twice: once as soon as the world has drawn, once after the viewmodel
       and the first enemies have compiled their programs */
    if (diagWanted && (frameId === 16 || frameId === 200)) { diagDone = false; emitDiag(); }

    camera.updateMatrixWorld();
    mProjSaved.copy(camera.projectionMatrix);
    mProjInvSaved.copy(camera.projectionMatrixInverse);

    /* --- jitter ------------------------------------------------------- */
    if (EFF.taa) {
      jitter.set(HALTON[jIdx][0] * 2 / rtW, HALTON[jIdx][1] * 2 / rtH);
      camera.projectionMatrix.elements[8] += jitter.x;
      camera.projectionMatrix.elements[9] += jitter.y;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    } else {
      jitter.set(0, 0);
    }

    var tanY = Math.tan(camera.fov * Math.PI / 360);
    projInfo.set(tanY * camera.aspect, tanY);
    texel.set(1 / rtW, 1 / rtH);
    halfTexel.set(1 / halfW, 1 / halfH);
    if (gW) gTexel.set(1 / gW, 1 / gH);

    /* reprojection matrix: prevViewProj * inverse(currView) */
    mTmp.copy(camera.matrixWorld);
    mReproj.copy(mPrevViewProj).multiply(mTmp);

    /* --- shadow follow ------------------------------------------------ */
    followShadow();

    /* --- G-buffer prepass --------------------------------------------- */
    var haveG = false;
    if (EFF.gbuf > 0 && gRT && gbufOk) {
      tBegin('gbuf');
      haveG = renderGBuffer();
      tEnd();
      if (!haveG && !gbufOk) { applyEffects(); }
    }

    /* --- GTAO + contact shadows --------------------------------------- */
    var aoOn = false;
    if (haveG && EFF.gtao && aoRT && aoRT2 && mAo) {
      tBegin('gtao');
      if (sunDir) sunView.copy(sunDir).transformDirection(camera.matrixWorldInverse);
      var fr = Math.max(0.05, P.aoFalloff) * P.aoRadius;
      mAo.uniforms.tDepth.value = gRT.depthTexture;
      mAo.uniforms.tNormal.value = gRT.texture;
      mAo.uniforms.uTexel.value.copy(gTexel);
      mAo.uniforms.uProjInfo.value.copy(projInfo);
      mAo.uniforms.uJitter.value.copy(jitter);
      mAo.uniforms.uNear.value = camera.near;
      mAo.uniforms.uFar.value = camera.far;
      mAo.uniforms.uRadius.value = P.aoRadius;
      mAo.uniforms.uProjScale.value = 0.5 * gH / Math.max(1e-4, tanY);
      mAo.uniforms.uFalloffMul.value = -1 / fr;
      mAo.uniforms.uFalloffAdd.value = (P.aoRadius - fr) / fr + 1;
      mAo.uniforms.uThin.value = P.aoThin;
      mAo.uniforms.uPower.value = P.aoPower;
      /* cap the screen-space footprint: a metre-wide radius three inches from
         the camera would spread five samples over half the screen and the AO
         would boil. Clamping it turns close-up AO into a tight contact term,
         which is what it should read as anyway.
         0.035, not 0.07. At 720p the old ceiling was fifty pixels, and four
         samples spread over fifty pixels is not a contact term -- it is a
         low-frequency stain that follows the camera, which is the second
         ingredient in the alley wall's unexplained dark patch. Half that
         radius keeps the crease darkening and drops the stain. */
      mAo.uniforms.uMaxPix.value = Math.max(10, gH * 0.035);
      mAo.uniforms.uSeed.value = (frameId % 64) * 13.0;
      mAo.uniforms.uSunView.value.copy(sunView);
      mAo.uniforms.uCsLen.value = P.contactLength;
      mAo.uniforms.uCsThick.value = P.contactThick;
      mAo.uniforms.uCsOn.value = EFF.contact ? 1 : 0;
      blit(mAo, aoRT);

      /* separable depth-aware denoise, ping-ponged back into aoRT so the
         texture identity handed to the materials never changes */
      mAoBlur.uniforms.tAO.value = aoRT.texture;
      mAoBlur.uniforms.uDir.value.set(gTexel.x, 0);
      blit(mAoBlur, aoRT2);
      mAoBlur.uniforms.tAO.value = aoRT2.texture;
      mAoBlur.uniforms.uDir.value.set(0, gTexel.y);
      blit(mAoBlur, aoRT);
      aoOn = true;
      tEnd();
    }

    /* --- SSR ----------------------------------------------------------- */
    var ssrOn = false;
    if (haveG && EFF.ssr && ssrRT && ssrRT2 && mSsr && taaLast && haveHistory && aoOn) {
      tBegin('ssr');
      mSsr.uniforms.tDepth.value = gRT.depthTexture;
      mSsr.uniforms.tG.value = gRT.texture;
      mSsr.uniforms.tPrev.value = taaLast.texture;
      mSsr.uniforms.uTexel.value.copy(texel);
      mSsr.uniforms.uProjInfo.value.copy(projInfo);
      mSsr.uniforms.uJitter.value.copy(jitter);
      mSsr.uniforms.uNear.value = camera.near;
      mSsr.uniforms.uFar.value = camera.far;
      mSsr.uniforms.uReproj.value.copy(mReproj);
      mSsr.uniforms.uSeed.value = (frameId % 128) * 7.31;
      mSsr.uniforms.uRoughCut.value = P.ssrRough;
      mSsr.uniforms.uMaxDist.value = P.ssrDist;
      mSsr.uniforms.uThick.value = P.ssrThick;
      mSsr.uniforms.uMaxPix.value = Math.max(64, rtH * 0.45);
      mSsr.uniforms.uHasHist.value = 1;
      blit(mSsr, ssrRT);

      /* roughness cone approximation: a depth-guided separable blur whose
         radius tracks the surface roughness, ping-ponged back into ssrRT */
      mSsrBlur.uniforms.tG.value = gRT.texture;
      mSsrBlur.uniforms.tAO.value = aoRT.texture;
      mSsrBlur.uniforms.uScale.value = 7.0;
      mSsrBlur.uniforms.tSsr.value = ssrRT.texture;
      mSsrBlur.uniforms.uDir.value.set(texel.x, 0);
      blit(mSsrBlur, ssrRT2);
      mSsrBlur.uniforms.tSsr.value = ssrRT2.texture;
      mSsrBlur.uniforms.uDir.value.set(0, texel.y);
      blit(mSsrBlur, ssrRT);
      ssrOn = true;
      tEnd();
    }

    /* --- scene colour -------------------------------------------------- */
    setMaterialUniforms(aoOn && EFF.aoInMaterial, ssrOn);
    tBegin('scene');
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    tEnd();

    /* the viewmodel lands on a fully lit world buffer and is deliberately
       excluded from world AO, contact shadows and reflections */
    setMaterialUniforms(false, false);
    if (NZ.has('scenePass')) {
      NZ.call('scenePass', {
        renderer: renderer, target: sceneRT, camera: camera, dt: dt, quality: tier
      });
    }

    /* --- TAA ---------------------------------------------------------- */
    var colorTex = sceneRT.texture;
    if (EFF.taa && taaA && taaB) {
      tBegin('taa');
      var dst = taaFlip ? taaB : taaA;
      var src = taaFlip ? taaA : taaB;
      mTaa.uniforms.tCur.value = sceneRT.texture;
      mTaa.uniforms.tHist.value = src.texture;
      mTaa.uniforms.tDepth.value = sceneRT.depthTexture;
      mTaa.uniforms.tWorldDepth.value = haveG ? gRT.depthTexture : sceneRT.depthTexture;
      mTaa.uniforms.uReproj.value.copy(mReproj);
      mTaa.uniforms.uTexel.value.copy(texel);
      mTaa.uniforms.uRes.value.set(rtW, rtH);
      mTaa.uniforms.uProjInfo.value.copy(projInfo);
      mTaa.uniforms.uJitter.value.copy(jitter);
      mTaa.uniforms.uNear.value = camera.near;
      mTaa.uniforms.uFar.value = camera.far;
      mTaa.uniforms.uHasHist.value = haveHistory ? 1 : 0;
      blit(mTaa, dst);
      colorTex = dst.texture;
      taaLast = dst;
      taaFlip ^= 1;
      haveHistory = true;
      tEnd();
    }

    /* --- bloom -------------------------------------------------------- */
    tBegin('bloom');
    var knee = Math.max(1e-4, P.bloomKnee);
    mPre.uniforms.tSrc.value = colorTex;
    mPre.uniforms.uTexel.value.copy(texel);
    mPre.uniforms.uCurve.value.set(P.bloomThreshold, knee, 1 / (4 * knee));
    mPre.uniforms.uClampMax.value = caps.hdr ? P.bloomClamp : 1.0;
    blit(mPre, bloomRT[0]);

    var i;
    for (i = 1; i < bloomRT.length; i++) {
      mDown.uniforms.tSrc.value = bloomRT[i - 1].texture;
      mDown.uniforms.uTexel.value.set(1 / bloomRT[i - 1].width, 1 / bloomRT[i - 1].height);
      blit(mDown, bloomRT[i]);
    }
    for (i = bloomRT.length - 1; i >= 1; i--) {
      mUp.uniforms.tSrc.value = bloomRT[i].texture;
      mUp.uniforms.uTexel.value.set(1 / bloomRT[i].width, 1 / bloomRT[i].height);
      mUp.uniforms.uScale.value = 0.5;
      blit(mUp, bloomRT[i - 1]);
    }
    tEnd();

    /* --- composite ---------------------------------------------------- */
    tBegin('composite');
    mComp.uniforms.tScene.value = colorTex;
    mComp.uniforms.tBloom.value = bloomRT[0].texture;
    mComp.uniforms.tAO.value = aoRT ? aoRT.texture : whiteTex;
    mComp.uniforms.uTexel.value.copy(texel);
    mComp.uniforms.uExposure.value = P.exposure * (P.tonemap === 'aces' ? (1 / 0.6) : (P.tonemap === 'neutral' ? 1.35 : 1.05));
    mComp.uniforms.uBloom.value = P.bloom / Math.max(1, bloomRT.length);
    mComp.uniforms.uAO.value = (aoOn && !EFF.aoInMaterial) ? P.ao : 0.0;
    mComp.uniforms.uCA.value = P.ca;
    mComp.uniforms.uVignette.value = P.vignette;
    mComp.uniforms.uGrain.value = P.grain;
    mComp.uniforms.uSharpen.value = P.sharpen;
    mComp.uniforms.uSat.value = P.saturation;
    mComp.uniforms.uContrast.value = P.contrast;
    mComp.uniforms.uLift.value.set(P.lift[0], P.lift[1], P.lift[2]);
    mComp.uniforms.uGain.value.set(P.gain[0], P.gain[1], P.gain[2]);
    mComp.uniforms.uAspect.value = rtW / Math.max(1, rtH);
    mComp.uniforms.uSeed.value = (frameId % 1024) * 7.13;
    var target = ((EFF.mblur && ldrRT2) || EFF.fxaa) ? ldrRT : null;
    blit(mComp, target);
    tEnd();

    /* --- motion blur -------------------------------------------------- */
    var lastRT = ldrRT;
    if (EFF.mblur && ldrRT2 && target) {
      tBegin('mblur');
      mBlur.uniforms.tColor.value = ldrRT.texture;
      mBlur.uniforms.tDepth.value = sceneRT.depthTexture;
      mBlur.uniforms.tWorldDepth.value = haveG ? gRT.depthTexture : sceneRT.depthTexture;
      mBlur.uniforms.uReproj.value.copy(mReproj);
      mBlur.uniforms.uProjInfo.value.copy(projInfo);
      mBlur.uniforms.uJitter.value.copy(jitter);
      mBlur.uniforms.uTexel.value.copy(texel);
      mBlur.uniforms.uNear.value = camera.near;
      mBlur.uniforms.uFar.value = camera.far;
      /* velocity is per-frame; hold the smear length steady across framerates */
      mBlur.uniforms.uStrength.value = P.shutter * Math.min(1.6, (1 / 60) / Math.max(1e-4, dt));
      mBlur.uniforms.uSeed.value = (frameId % 512) * 3.7;
      blit(mBlur, EFF.fxaa ? ldrRT2 : null);
      lastRT = ldrRT2;
      tEnd();
    }

    /* --- FXAA / present ----------------------------------------------- */
    if (EFF.fxaa) {
      tBegin('fxaa');
      mFxaa.uniforms.tDiffuse.value = lastRT.texture;
      mFxaa.uniforms.uTexel.value.copy(texel);
      blit(mFxaa, null);
      tEnd();
    }

    renderer.setRenderTarget(null);

    /* --- store history matrices --------------------------------------- */
    mTmp.copy(camera.matrixWorldInverse);
    mPrevViewProj.copy(camera.projectionMatrix).multiply(mTmp);

    /* --- restore the camera the game handed us ------------------------ */
    camera.projectionMatrix.copy(mProjSaved);
    camera.projectionMatrixInverse.copy(mProjInvSaved);

    tPoll();
    return true;
  }

  /* ====================================================================== */
  /*  self-check                                                            */
  /* ====================================================================== */
  /* Every one of these subsystems is allowed to fail quietly and fall back to
     something that still draws a frame. That is correct behaviour and it is
     also why a flat image looked "fine" from the console: nothing errors.
     So state it out loud instead -- for each path, live or fallen back, and
     why. ?nzdiag=1 mirrors it onto the page through console.warn, which the
     page's overlay already captures, so it can be screenshotted. */
  var diagWanted = false, diagDone = false, stockExposure = 1.18;

  /* THE LIGHT BUDGET, and it used to be wrong by pi.
     `sunKey.intensity / Math.PI` is the right arithmetic for
     physicallyCorrectLights = TRUE. This project runs r149's default, which is
     false, and there WebGLLights multiplies every punctual light's intensity
     by PI on the way to the shader, where BRDF_Lambert's 1/PI cancels it
     again. The scene-linear radiance leaving a Lambertian surface is

         albedo * intensity * luma(lightColour) * max(0, N.L)

     with intensity STRAIGHT. So the old key number was 3.14x under the one it
     rendered, and that is exactly how a key of 3.80 was signed off as
     "3.1 : 1 key-dominant" while the calibrated harness measured it putting an
     18% grey card at 90% white. Same mistake on coolRim.

     Two other corrections while we are here: the light COLOUR was ignored (a
     warm key at luma 0.78 is not worth 1.00 of white light -- and once colour
     management is on a hex constant means something different again), and the
     probe now carries a solar disc whose diffuse share is a known constant.
     Everything below reduces to the same unit as the harness: the albedo
     multiplier a white surface facing the source receives. Compare it
     directly with `--cell=calib`'s key:fill. */
  function lightBalance() {
    var L = lights || {};
    /* The sun is the DirectionalLight PLUS the probe's solar disc, which
       applyLighting() subtracts from the light precisely because the two are
       the same lobe. Adding it back here is what makes this the sun's real
       total rather than whatever fraction happened to be analytic. */
    var key = (L.sunKey ? (L.sunKey.intensity + sunDiscKeyOffset(L.sunKey)) * lumaOf(L.sunKey.color) : 0);
    /* the probe's mean radiance IS the albedo multiplier a surface in a
       uniform environment receives, so it needs no conversion at all -- and
       the disc is deliberately NOT counted here, it is counted in the key */
    var probe = envRT ? P.envIrradiance : 0;
    /* coolRim is counted once and bounceB is deliberately NOT: the pair is
       aimed +/-130 deg apart, so no surface can face both, and counting both
       would report a fill no surface ever receives. The kicker IS counted --
       it is at the anti-key azimuth and 52 deg up, so a shadow-side vertical
       surface really does see the coolRim and the kicker together. */
    var kick = kicker ? kicker.intensity * lumaOf(kicker.color) : 0;
    var fill = (L.ambient ? L.ambient.intensity * lumaOf(L.ambient.color) : 0) +
               (L.skyFill ? L.skyFill.intensity * lumaOf(L.skyFill.color) : 0) * 0.5 +
               (L.coolRim ? L.coolRim.intensity * lumaOf(L.coolRim.color) : 0) +
               kick + probe;
    return { key: +key.toFixed(3), fill: +fill.toFixed(3), probe: +probe.toFixed(3),
             kicker: +kick.toFixed(3),
             ratio: +(key / Math.max(1e-4, fill)).toFixed(2) };
  }

  /* Anything that will draw as a pure black silhouette no matter how it is
     lit. The two ways to get there are a black albedo and vertexColors=true
     with either no colour attribute (WebGL hands the shader (0,0,0)) or an
     all-zero one. */
  function scanBlackSurfaces(limit) {
    var out = [], cap = limit || 10;
    if (!scene) return out;
    scene.traverse(function (o) {
      if (out.length >= cap) return;
      if (!o.isMesh || !o.material) return;
      var l = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < l.length; i++) {
        var m = l[i], why = null;
        if (!m) continue;
        if (m.color && (m.color.r + m.color.g + m.color.b) < 0.01) why = 'albedo=black';
        if (!why && m.vertexColors) {
          var a = o.geometry && o.geometry.attributes && o.geometry.attributes.color;
          if (!a) why = 'vertexColors=true with NO color attribute -> shader reads (0,0,0)';
          else {
            var mx = 0, cnt = a.count, step = Math.max(1, Math.floor(cnt / 400));
            for (var v = 0; v < cnt; v += step) {
              var s = a.getX(v) + a.getY(v) + a.getZ(v);
              if (s > mx) mx = s;
            }
            if (mx < 0.03) why = 'every baked vertex colour is ~0 (max ' + mx.toFixed(4) + ')';
          }
        }
        if (why) {
          out.push((o.name || '(unnamed mesh)') + ' / ' + (m.name || m.type) + ': ' + why);
          break;
        }
      }
    });
    return out;
  }

  function selfCheck() {
    var e = EFF || {};
    var lb = lightBalance();
    var r = {
      installed: !!(NZ.flags && NZ.flags.render) && !dead,
      tier: tier, degrade: degrade,
      caps: { hdr: caps.hdr, depth: caps.depth, webgl2: caps.webgl2 },
      /* --- the injected material paths --------------------------------- */
      shaderPatch: caps.shaderPatch ? 'LIVE' : 'FALLBACK (stock lighting, no AO/SSR/PCSS in-material)',
      materialsReached: patchStats.reached,
      materialsWrapped: patchStats.wrapped,
      materialsLeftAlone: patchStats.foreign,
      foreignHookThrew: patchStats.innerThrew,
      ao: !e.gtao ? 'OFF (tier/degrade)'
        : !gbufOk ? 'FALLBACK (g-buffer prepass failed)'
        : e.aoInMaterial ? 'LIVE (indirect-only, in material)'
        : 'FALLBACK (flat multiply in composite)',
      contact: e.contact ? 'LIVE' : 'OFF',
      /* the geometric AA rung: what was asked for, what the formats allow,
         and what the scene target is actually built with right now */
      msaa: (sceneRT && sceneRT.samples > 0)
        ? ('LIVE ' + sceneRT.samples + 'x (cap ' + caps.msaa + ')')
        : ('OFF (tier ' + (e.msaa | 0) + 'x, cap ' + caps.msaa + ')'),
      ssr: e.ssr ? 'LIVE' : (caps.shaderPatch ? 'OFF (tier/degrade/deps)' : 'FALLBACK (needs shader patch)'),
      pcss: e.pcss && patchStats.pcss > 0 ? 'LIVE (' + patchStats.pcss + ' programs)'
        : (usePcssPatch ? 'FALLBACK (stock PCF)' : 'FALLBACK (PCSS splice rejected at validation)'),
      gbuffer: (e.gbuf > 0 && gbufOk) ? (gW + 'x' + gH) : 'OFF',
      /* --- the light rig ------------------------------------------------ */
      ibl: envRT ? 'LIVE' : 'FALLBACK (no probe; ambient carries the scene)',
      skyDome: skyDomeMat ? 'LIVE (probe and dome share one nzSky())' : 'STOCK (dome not found)',
      skyMeanRadiance: +envMeanRadiance.toFixed(4),
      /* All three in ONE unit: the albedo multiplier a white surface FACING
         that source receives. That makes them comparable with each other and
         with `render-critic --cell=calib`, whose key:fill is measured at a
         card the key hits at an angle and is therefore always the lower
         number. Neither is divided by pi -- see lightBalance(). */
      keyIrradiance: lb.key, fillIrradiance: lb.fill, probeIrradiance: lb.probe,
      keyToFill: lb.ratio,
      kicker: kicker ? ('LIVE ' + kicker.intensity.toFixed(3) + ' at el ' +
                        P.kickerElevation.toFixed(0) + ' deg, anti-key azimuth')
                     : 'OFF',
      worldShadowCasters: (EFF && EFF.worldCast) ? worldCasters.length
                                                 : ('OFF (' + worldCasters.length + ' available)'),
      colorManagement: colorManaged ? 'MANAGED (hex literals are sRGB)'
        : 'LEGACY (hex literals go to the shader raw as linear -- 0x767676 is 46% not 18%)',
      sunDisc: (envRT && sunDiscInfo && sunDiscInfo.radiance > 0)
        ? ('LIVE ' + (sunDiscInfo.halfDeg * 2).toFixed(2) + ' deg on a ' + envCubeSize +
           'px cube (x' + sunDiscInfo.widened.toFixed(1) + ' true size, flux-compensated), ' +
           (P.sunProbeShare * 100).toFixed(1) + '% of probe flux')
        : 'OFF (no metal can catch a specular highlight from the key)',
      sunElevation: +sunElevationDeg().toFixed(1),
      shadowMap: e.shadow + 'px over ' + (e.extent * 2) + ' units = ' +
                 (2 * e.extent / Math.max(1, e.shadow)).toFixed(4) + ' units/texel',
      shadowPenumbraMax: +(2 * e.extent / Math.max(1, e.shadow) * P.shadowSearch).toFixed(3),
      /* the single biggest exposure lever in the frame, and it depends on
         material NAMES owned by another module -- so say out loud whether it
         actually found the level */
      bakedLighting: !bakeStats.ran ? 'NOT RUN'
        : bakeStats.geos ? ('NEUTRALISED (' + bakeStats.geos + ' geo / ' + bakeStats.verts +
            ' verts / ' + bakeStats.mats + ' mats; ' + bakeStats.lo.toFixed(3) + '..' +
            bakeStats.hi.toFixed(3) + ' -> ' + bakeCurve(bakeStats.lo).toFixed(3) + '..' +
            bakeCurve(bakeStats.hi).toFixed(3) + ')')
        : 'FOUND NOTHING',
      tonemap: P.tonemap, exposure: +P.exposure.toFixed(3),
      blackSurfaces: scanBlackSurfaces(10)
    };
    if (lb.ratio < 2.0) r.WARN_FLAT = 'key:fill is ' + lb.ratio + ':1 -- under 2:1 the image reads as flat ambient';
    if (envMeanRadiance > 0 && envMeanRadiance < 0.02) r.WARN_DARK_SKY = 'probe sky mean radiance ' + envMeanRadiance.toFixed(4) + ' -- contributes no light';
    if (bakeStats.ran && !bakeStats.geos) {
      r.WARN_BAKE = 'no baked-lighting geometry matched: every world material name changed. ' +
                    'The level is still multiplied by its night-time vertex bake and rooms WILL be crushed.';
    }
    return r;
  }

  function sunElevationDeg() {
    if (!sunDir) return 0;
    var h = Math.sqrt(sunDir.x * sunDir.x + sunDir.z * sunDir.z);
    return Math.atan2(sunDir.y, Math.max(1e-6, h)) * 180 / Math.PI;
  }

  function emitDiag() {
    if (diagDone) return;
    diagDone = true;
    var r;
    try { r = selfCheck(); } catch (e) { console.warn('[nz-render] selfcheck threw', e && e.message); return; }
    try {
      console.warn('[nz-render] patch=' + r.shaderPatch + ' reached=' + r.materialsReached +
                   ' wrapped=' + r.materialsWrapped + ' leftAlone=' + r.materialsLeftAlone +
                   ' innerThrew=' + r.foreignHookThrew);
      console.warn('[nz-render] ao=' + r.ao + ' contact=' + r.contact + ' ssr=' + r.ssr + ' pcss=' + r.pcss + ' gbuf=' + r.gbuffer);
      console.warn('[nz-render] ibl=' + r.ibl + ' sky=' + r.skyDome + ' skyMean=' + r.skyMeanRadiance +
                   ' key=' + r.keyIrradiance + ' fill=' + r.fillIrradiance + ' (probe ' + r.probeIrradiance +
                   ') key:fill=' + r.keyToFill + ':1');
      console.warn('[nz-render] colour=' + r.colorManagement + ' sunDisc=' + r.sunDisc);
      console.warn('[nz-render] tonemap=' + r.tonemap + ' exposure=' + r.exposure +
                   ' shadow=' + r.shadowMap + ' penumbraMax=' + r.shadowPenumbraMax +
                   ' sunElev=' + r.sunElevation + ' tier=' + r.tier + '+' + r.degrade);
      console.warn('[nz-render] bake=' + r.bakedLighting);
      if (r.WARN_BAKE) console.warn('[nz-render] ' + r.WARN_BAKE);
      if (r.WARN_FLAT) console.warn('[nz-render] ' + r.WARN_FLAT);
      if (r.WARN_DARK_SKY) console.warn('[nz-render] ' + r.WARN_DARK_SKY);
      if (r.blackSurfaces.length) {
        console.warn('[nz-render] BLACK SURFACES (' + r.blackSurfaces.length + '), not fixable from nz-render:');
        for (var i = 0; i < r.blackSurfaces.length; i++) console.warn('[nz-render]   - ' + r.blackSurfaces[i]);
      } else {
        console.warn('[nz-render] black-surface scan: none found in scene materials');
      }
    } catch (e2) {}
  }

  /* ====================================================================== */
  /*  teardown                                                              */
  /* ====================================================================== */
  function panic(err) {
    if (dead) return;
    dead = true;
    NZ.flags.render = false;
    console.error('[nz-render] disabled after error:', err);
    try {
      renderer.setRenderTarget(null);
      renderer.autoClear = true;
      renderer.shadowMap.autoUpdate = true;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = stockExposure;
      scene.environment = null;
      restoreSkyDome();
      restoreAtmosphere();
      restoreBakedLighting();
      removeShaderPatch();
      /* The stock path's hex constants were authored against the legacy
         interpretation, so handing it back a colour-managed three would make
         every one of them a stop and a third dark. Put the flag back exactly
         as it was found, BEFORE touchAllMaterials() re-uploads anything. */
      restoreColorManagement();
      /* r149 does not re-check toneMapping per frame, so force a recompile */
      touchAllMaterials();
      if (lights && lights.ambient) lights.ambient.intensity = 0.80;
      if (lights && lights.skyFill) lights.skyFill.intensity = 0.27;
      if (lights && lights.sunKey) {
        lights.sunKey.intensity = 0.62;
        /* the elevation re-aim and followShadow() both moved this light; hand
           the stock rig back the geometry it shipped with, not ours */
        if (sunSaved) {
          lights.sunKey.position.copy(sunSaved.pos);
          lights.sunKey.target.position.copy(sunSaved.tgt);
          lights.sunKey.color.copy(sunSaved.col);
          lights.sunKey.target.updateMatrixWorld();
        }
        var c = lights.sunKey.shadow.camera;
        c.left = -174; c.right = 174; c.top = 136; c.bottom = -136;
        c.near = 12; c.far = 360; c.updateProjectionMatrix();
        lights.sunKey.shadow.mapSize.set(1536, 1536);
        lights.sunKey.shadow.bias = -0.00028;
        lights.sunKey.shadow.normalBias = 0.035;
        if (lights.sunKey.shadow.map) { lights.sunKey.shadow.map.dispose(); lights.sunKey.shadow.map = null; }
      }
      removeBounceB();
      removeKicker();
      /* every mesh in worldCasters had castShadow false when we found it */
      setWorldCast(false); worldCasters.length = 0;
      if (lights && lights.coolRim) {
        lights.coolRim.intensity = 0.22;
        /* applyLighting() re-aimed this light to the anti-sun bounce vector;
           the stock rig expects it exactly where the level author put it */
        if (rimSaved) {
          lights.coolRim.position.copy(rimSaved.pos);
          lights.coolRim.color.copy(rimSaved.col);
          if (rimSaved.tgt && lights.coolRim.target) {
            lights.coolRim.target.position.copy(rimSaved.tgt);
            lights.coolRim.target.updateMatrixWorld();
          }
        }
      }
      disposeTargets();
      disposeMaterials();
      disposeGMats();
      envRT = killRT(envRT);
      envCubeRT = killRT(envCubeRT);
    } catch (e) { console.error('[nz-render] teardown failed:', e); }
  }

  /* ====================================================================== */
  /*  hooks                                                                 */
  /* ====================================================================== */
  NZ.on('rendererInit', function (ctx) {
    try {
      THREE = ctx.THREE; renderer = ctx.renderer; scene = ctx.scene;
      camera = ctx.camera; lights = ctx.lights || {};

      probeCaps();
      tier = detectTier();
      try { diagWanted = /[?&]nzdiag=1/.test(global.location ? global.location.search : ''); } catch (e0) { diagWanted = false; }

      /* Colour management goes on FIRST -- before applyLighting(), before
         buildMaterials(), before the level has built a single material -- so
         nothing is ever authored against the legacy interpretation and no
         program has to be recompiled to pick it up. `?nzcm=0` opts out for an
         A/B; panic() puts the flag back the way it found it. */
      var wantCM = true;
      try { if (/[?&]nzcm=0/.test(global.location ? global.location.search : '')) wantCM = false; } catch (e1) {}
      if (enableColorManagement(wantCM)) {
        NZ.log('colour management ' + (wantCM ? 'ON (hex literals are sRGB)' : 'OFF (legacy: hex goes to the shader raw)'));
      }
      readParamOverrides();

      uAoTex = { value: null };
      uSsrTex = { value: null };
      uAoP = { value: new THREE.Vector4(1, 1, 0, 1) };
      uSsrP = { value: new THREE.Vector4(1, 0, 0, 0) };
      uShadowP = { value: new THREE.Vector4(70, 6, 0.85, 0) };
      uInvRes = { value: new THREE.Vector2(1 / 1920, 1 / 1080) };

      /* The game's 1.18 was set for the stock rig (key 0.62 against 0.80 of
         ambient). The key is now 3.15 and the fills are gone, so the scene is
         roughly 2.7 stops hotter and inheriting that exposure would clip every
         sunlit wall. P.exposure is a look parameter this module owns; only the
         teardown value is borrowed. */
      stockExposure = renderer.toneMappingExposure || 1.18;
      /* the curve moves into the composite. r149 bakes tone mapping into every
         material program and never re-checks it, so this must be set once,
         before anything compiles, and never flipped per frame. */
      if (caps.hdr) {
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.toneMappingExposure = 1.0;
      }
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      /* Install and prove the material patch BEFORE the level builds a single
         material, so a failure costs nothing and reverting is free. The
         renderer's tone mapping and shadow type are already final here, so
         the throwaway programs match the ones the level will really use. */
      tryShaderPatch(false);

      EFF = computeEffects();
      NZ.log('tier ' + tier + (tierPinned ? ' (pinned)' : '') +
             ' hdr=' + caps.hdr + ' depth=' + caps.depth + ' webgl2=' + caps.webgl2 +
             ' patch=' + caps.shaderPatch + ' msaa=' + EFF.msaa + '/' + caps.msaa);

      mProjSaved = new THREE.Matrix4();
      mProjInvSaved = new THREE.Matrix4();
      mPrevViewProj = new THREE.Matrix4();
      mReproj = new THREE.Matrix4();
      mTmp = new THREE.Matrix4();
      jitter = new THREE.Vector2();
      projInfo = new THREE.Vector2();
      texel = new THREE.Vector2();
      halfTexel = new THREE.Vector2();
      gTexel = new THREE.Vector2();
      tmpVec2 = new THREE.Vector2();
      tmpV3 = new THREE.Vector3();
      tmpCol = new THREE.Color();
      sunView = new THREE.Vector3(0, 1, 0);
      timing = makeTiming();

      buildQuad();
      buildMaterials();
      applyLighting(false);   /* provisional: probe is built at 'ready' */

      NZ.render = {
        quality: tier,
        params: P,
        caps: caps,
        setQuality: function (q) {
          if (!TIERS[q] || dead) return;
          tier = q; degrade = 0; tierPinned = true;
          adaptLocked = false; lastDegradeMed = 0; noGain = 0;
          applyEffects();
          applyLighting(!!envRT);
        },
        setTonemap: function (name) {
          if (dead) return;
          if (name !== 'agx' && name !== 'aces' && name !== 'neutral') return;
          P.tonemap = name;
          buildMaterials();
        },
        /* Global three.js flag; see the note at the top of this file for the
           list of constants in OTHER modules that move when it is on. Exposed
           so the change can be A/B'd at runtime without a reload -- material
           colours are re-read per frame, so nothing needs recompiling. */
        get colorManaged() { return colorManaged; },
        setColorManagement: function (on) {
          if (dead) return colorManaged;
          enableColorManagement(!!on);
          applyLighting(!!envRT);
          return colorManaged;
        },
        /* The light rig in one place, in ONE unit (the albedo multiplier a
           white surface facing the source receives), so it can be re-solved
           against `render-critic --cell=calib` without hunting through P. */
        get lightRig() {
          return { key: P.keyIntensity, probe: P.envIrradiance,
                   bounce: P.bounceIntensity, ambient: P.ambientFloor,
                   sunElevation: P.sunElevation, sunProbeShare: P.sunProbeShare,
                   overrides: paramOverrides, budget: lightBalance(),
                   sunDisc: sunDiscInfo, envCube: envCubeSize };
        },
        get effects() { return EFF; },
        /* "is the pipeline actually doing what it claims" -- see selfCheck().
           Also mirrored to the page by ?nzdiag=1 sixteen frames in. */
        selfCheck: function () { try { return selfCheck(); } catch (e) { return { error: String(e && e.message) }; } },
        blackScan: function (n) { try { return scanBlackSurfaces(n || 20); } catch (e) { return []; } },
        diag: function () { diagDone = false; emitDiag(); return selfCheck(); },
        get stats() {
          return { ms: medianFrame(), quality: tier, degrade: degrade, locked: adaptLocked,
                   width: rtW, height: rtH, msaa: EFF ? EFF.msaa : 0, gbuf: gW + 'x' + gH,
                   patch: caps.shaderPatch, gpu: timing ? timing.gpu : null };
        },
        rebuildEnvironment: function () {
          try {
            envRT = killRT(envRT);
            if (buildEnvironment()) applyLighting(true);
          } catch (e) { NZ.log('env rebuild failed', e); }
        },
        dispose: function () { panic('manual dispose'); }
      };

      NZ.flags.render = true;
      NZ.log('render module installed');
    } catch (err) {
      panic(err);
    }
  });

  NZ.on('ready', function () {
    if (dead) return;
    try {
      /* the probe borrows the game's own sky, so it can only be built once
         the textures exist -- which is exactly now, before the first frame */
      var ok = buildEnvironment();
      /* re-prove the patch now that an env map exists: the IBL branches only
         compile when USE_ENVMAP is on, and a failure here is still free */
      if (caps.shaderPatch && ok) {
        patchKey = 'nzr' + (usePcssPatch ? 'p' : 'n');
        if (!validateShaderPatch(true)) {
          NZ.log('shader patch failed with envmap, reverting');
          removeShaderPatch();
        }
      }
      EFF = computeEffects();
      applyLighting(ok);
      upgradeMaterials();
      buildMaterials();
      applyShadowQuality();
      ensureTargets(true);
      NZ.log('world ready, ibl=' + ok + ' patch=' + caps.shaderPatch +
             ' ssr=' + EFF.ssr + ' gtao=' + EFF.gtao + ' pcss=' + EFF.pcss);
    } catch (err) {
      panic(err);
    }
  });

  /* Runs after every other module's 'ready' (nz-env is at -20), so the world
     materials it just installed -- each carrying its own onBeforeCompile --
     are visible to the composition sweep. Without this the entire level
     silently opts out of AO, contact shadows and PCSS. */
  NZ.on('ready', function () {
    if (dead) return;
    try {
      wrapForeignMaterials();
      /* Must be last: nz-env rewrites the very colour attribute we are about
         to remap (it multiplies its own contact AO into it) at priority -20,
         so running any earlier would either be undone or double-counted. */
      try { neutralizeBakedLighting(); }
      catch (e) { NZ.log('bake neutralise failed:', e && e.message); }
      applyLighting(!!envRT);
      applyShadowQuality();
    } catch (err) { NZ.log('late ready sweep failed:', err && err.message); }
  }, -1000);

  NZ.on('resize', function () {
    if (dead || !renderer) return;
    try { ensureTargets(true); haveHistory = false; taaLast = null; }
    catch (err) { panic(err); }
  });

  NZ.on('render', function (dt) {
    if (dead || !NZ.flags.render) return undefined;
    try {
      if (renderFrame(dt || 0.016)) return true;
    } catch (err) {
      panic(err);
    }
    return undefined;
  });

})(typeof window !== 'undefined' ? window : this);
