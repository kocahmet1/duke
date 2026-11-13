# CRITIC REPORT — round 2

**Agent:** CRITIC-RIG.
**Snapshot:** `nz-enemies.js` as of the render pass below (the RIG agent is
rewriting it concurrently; anything marked *rig* may already be moving).
**Method:** every claim below was read off a rendered image or off a number the
harness measured out of the framebuffer. Nothing here is inferred from source.

Reproduce the whole set:

```
. /tmp/chsenv.sh
node scripts/render-critic.mjs --cell=calib                       # exposure audit
node scripts/render-critic.mjs --cell=calib  --env=level --view=front
node scripts/render-critic.mjs --cell=maps   --view=front --pose=idle
node scripts/render-critic.mjs --cell=roster --view=front --pose=aim
node scripts/render-critic.mjs --cell=roster --view=front --env=level
node scripts/render-critic.mjs --cell=anim   --pose=walk --view=side
node scripts/render-critic.mjs --cell=scale  --view=front --pose=idle
node scripts/render-critic.mjs --sheet=trooper:aim:tq:weapon,trooper:aim:tq:hands
```

---

## 0. The stage was lying, and it has been fixed

**Every look-dev image produced before this pass was roughly 1.7 stops hot.**
Anyone choosing an albedo from those renders was choosing against a lie, and
the natural correction — "that fatigue looks washed out, darken the albedo" —
would have pushed the art *away* from correct.

Measured, by reading the finished framebuffer back and inverting nz-render's
own composite (exposure → ACES RRT fit → contrast → sRGB):

| probe (true linear albedo) | before | after | ideal |
|---|---|---|---|
| 18% grey card, facing lens | 204/255 (×3.25 albedo) | **117/255 (×0.975)** | 119/255 |
| exposure error | **+1.70 stop** | **−0.04 stop** | 0 |
| 2% black chip | ~73/255 | **28/255** | 17/255 |
| 90% white chip | clipped | **220/255** | 223/255 |
| key : fill at the card | ~1.5 : 1 | **2.87 : 1** | 3 : 1 |
| white balance (R−B) | — | +6.3% (warm key, expected) | — |

**`P.exposure` was not touched.** It is still nz-render's shipping 0.95, and
the arithmetic says it was always right: push scene-linear 0.180 through the
shipping composite and it lands on 119/255 = 0.4665 sRGB, which is an 18% grey
card's own code value to within half a code. The tone curve already maps 18%
to 18%. Only the light was wrong, so only the light was changed — the studio
key and the IBL probe are now solved from measurement:

```
keyIntensity  1.445   (was nz-render's level value, 3.80)
envIrradiance 0.186   (was 0.280)
```

Derivation, the numbers it was solved from, and the failed attempts are written
out in the `CALIB` block in `_critic_operators.html`.

### 0.1 — A colour-management landmine that affects the whole project

three r149 ships `ColorManagement.legacyMode = true`, and `Color.setHex()`
returns early out of `toWorkingColorSpace()` when it is. So

```js
new THREE.MeshStandardMaterial({ color: 0x767676 })
```

is **not** an 18% reflectance surface. It is `0x76/255 = 0.463` used **raw as
linear** — 46% reflectance, a stop and a third brighter than the constant
reads. Textures behave differently: a `CanvasTexture` tagged `SRGBColorSpace`
*is* decoded in the shader.

**So in this build every textured surface is colour-correct and every surface
tinted by a bare hex constant is about a stop too bright, and the two disagree
with each other.** This is not a studio problem; the studio props were simply
the first place it was measured. Worth an audit of every `new THREE.Color(0x…)`
that ends up in a `material.color`, `emissive`, or `groundColor` across
`nz-env.js`, `nz-enemies.js` and `NUKEM.html`. The calibration props now write
reflectance straight into the linear channels where no default can reach them.

### 0.2 — nz-render's own light budget is off by π

`lightBudget()` (around `nz-render.js:3160`) computes the key's diffuse
contribution as `sunKey.intensity / Math.PI`. With `physicallyCorrectLights`
false — the r149 default, and what this project runs — `WebGLLights` multiplies
intensity by π before it reaches the shader and the Lambert `1/π` cancels it.
The scene-linear radiance off a Lambertian surface is `albedo × intensity ×
luma(colour) × cos θ`, with `intensity` **straight**. So the ratio the module
reports and the ratio it renders differ by 3.14×. That is how a key of 3.80 got
signed off as "3.1 : 1 key-dominant" while actually rendering an 18% card at
90% white.

---

## Ranked defect list

Ranked by how badly each one loses a blind A/B against a real CS2 frame.

### 1. Every material is the same material. (`cell=maps`) — CRITICAL

The single loudest defect in the build, and the material cell makes it
undeniable. Sixteen atlas regions on identical chamfered cubes and spheres,
same light, same lens:

- **cloth, camo, nylon, web, leather, knit, scrim, plastic, painted and skin
  are visually indistinguishable.** All ten render as the same pale bone-white
  semi-matte. Only `steel` and `gunmetal` (metalness ≈ 1) and `lens`/`wound`
  read as anything else.
- Cause is visible in the flat albedo atlas in the same image: **every tile is
  a near-neutral grey.** The atlas is effectively a greyscale detail map. All
  of an operator's colour therefore comes from one flat per-part vertex tint,
  which is why a plate carrier, a boonie hat and a boot all read as the same
  fabric in a different shade. CS2 sells material with albedo *hue and
  saturation variation inside a single part* — a nylon strap is a different
  colour from the cordura it is sewn to, not the same colour at a different
  value.
- **Roughness (ORM.g) barely varies between tiles.** `leather`, `knit`,
  `plastic` and `painted` all sit in the same mid-grey band with the same fbm.
  Roughness is what separates painted metal from bare metal from polymer; if
  every tile has the same roughness histogram, nothing can separate them.
- **AO (ORM.r) is essentially absent.** Most tiles are near-white (no
  occlusion) and the few that carry anything carry a hard 1-bit *pattern*, not
  cavity occlusion. There is no dirt-in-the-crevices term anywhere.
- **The normal map is flat on most tiles** and carries **bright pink/green
  bleed along every tile border** — a seam artefact from the 4 px inset not
  being enough for the normal reconstruction, visible as a lattice in the
  normal panel. On a mipped, anisotropically-filtered atlas those seams will
  read as glowing lines on the model at distance.
- The one tile that *does* have strong normal detail (`nylon`, `scrim`,
  `knit`) has it as a uniform, high-frequency, single-direction ribbing — this
  is the "shredded corduroy" the user is seeing. It is one fbm/stripe function
  reused at slightly different frequencies.

**What to fix, in order:** give each tile a real albedo *colour*, not a value;
spread the roughness bands apart (0.25 for a wet-look polymer, 0.55 painted
steel, 0.85 cordura, 0.95 raw cotton); bake real cavity AO; kill the ribbing on
anything that is not actually ribbed; widen the atlas inset to 8 px.

### 2. The lighting the player actually sees swings 2.5 stops. (`cell=calib --env=level`) — CRITICAL

The level rig is not correctable by a global exposure change, because it is
wrong in *both* directions depending on which way you are facing:

| sun position relative to lens | grey card | verdict |
|---|---|---|
| 51° off (sun behind camera) | **181/255, +1.16 stop** | a 90% white renders at 242/255 — scene-linear **1.97**, clipped |
| 89° off (sun to the side) | **60/255, −1.31 stop** | key:fill **0.11 : 1** — pure ambient, no shaping at all |

Both are the same shipping rig (`key 3.80 az −51 / el 34`, `IBL 0.280`,
`exposure 0.95`). Compare `roster.png` (studio) with `roster_level.png`: the
same four operators go from readable olive drab to blown-out pale sand with the
plate carriers clipping and no shadow definition anywhere on the body.

CS2 never does this. Its maps are lit so that a character reads at every
heading, because the sun is one dominant *shaped* source and the ambient is a
narrow, dark, sky-coloured wrap — not a 0.28 omnidirectional lift.
Recommendation: bring the level key down to ≈1.4–1.6, drop `envIrradiance`
toward 0.19, and buy the shadow-side readability back with a real bounce card
or a low, cool second directional, not with more isotropic probe energy.

### 3. Zero roster differentiation. (`cell=roster`) — CRITICAL

All four operators side by side, identical light, lens and standoff. At a
glance they are **one character in four heights**:

- Same helmet shape on all four. RIFLEMAN is specified as *boonie/cap, no
  plate*; he is wearing the same ballistic helmet and the same plate carrier as
  the BREACHER.
- Same plate carrier geometry on all four, same pouch layout, same white
  rectangular buckle at the navel on all four.
- MARKSMAN has no ghillie, no wrap, no low-vis treatment — he is the RIFLEMAN
  with a longer gun.
- ASSAULTER has no visible comms headset, no balaclava, no radio.
- BREACHER reads as marginally bulkier and that is the *entire* difference in
  the roster.
- Colour is identical across all four. Four operators from the same unit would
  still differ in webbing colour, glove colour, sleeve state (rolled vs down),
  helmet cover.

Silhouette is the CS2 test: black these four out and you cannot name one of
them. Height (1.78–1.92 m) is doing all the work, and height is the *weakest*
differentiator at 40 m down a corridor.

### 4. The AK is a proxy with the right outline and no parts. (`cell=weapon`) — HIGH

Length is genuinely good: **OAL 861 mm against a spec of 880 mm, −2.2%**,
3500 tris. The proportions read. What is missing is everything that makes a
receiver look like a receiver:

- **No rear sight.** There is a front sight tower and nothing at the back of
  the receiver. The sight line the brief asks for cannot exist.
- **No trigger and no trigger guard.** The pistol grip meets the receiver with
  nothing between them.
- **No selector lever** — the single most recognisable feature of an AK's right
  side, a full-length stamped lever, absent.
- **No charging handle, no ejection port, no dust-cover ribbing.** The receiver
  is a plain black box.
- **No upper handguard.** The barrel and gas tube are two bare cylinders from
  the front trunnion forward; on an AK the lower handguard and the upper
  gas-tube handguard are the visual mass of the front half.
- **No muzzle device.** The barrel ends in a flat cut. An AK-pattern rifle has
  a slant brake or a birdcage; this is the silhouette's front terminator and
  it is missing.
- **No sling loops, no cleaning-rod channel, no magazine floorplate.**
- **Materials:** the furniture is the *same bone/khaki* as the fatigues — no
  wood grain, no polymer sheen, nothing that says "this is not cloth". The
  receiver is flat black with no roughness variation, no edge wear on the
  stamped corners, and no carbon fouling at the muzzle or ejection port, all
  three of which the brief calls out by name.

### 5. The support hand is on the magazine, not the handguard. (`cell=hands`) — HIGH

This is defect 3.2 in `CS2-ENEMY-BRIEF` and it is still there:

- The forward hand wraps the **magazine well / magazine**, not the handguard.
  Real operators are trained out of the mag-well grip precisely because it
  looks and reads wrong; C-clamp thumb-forward on the handguard is what CS2
  animates.
- The **trigger hand is not on the pistol grip** — the checkered grip is
  visibly unheld while the right arm passes over the top of the receiver.
- The **support elbow is flared high and outboard**, roughly level with the
  shoulder. The brief says elbows "never flare above the shoulder".
- The forearm reads too long for the upper arm; the elbow lands further forward
  than the anthropometry table allows.
- There is no cheek weld: the head is upright and the eye line passes well
  above the (nonexistent) sights.

### 6. Feet: plausible, but the stance foot still slips. (`cell=anim`) — MEDIUM

The animation strip and its burned-in telemetry are the first honest read of
this. Eight phases of one continuous walk cycle, `worst stance-foot slip
13 mm per 1/8 cycle`, ankle height 77–130 mm:

- **77 mm is a correct, constant, planted ankle height** — the stance foot sits
  on the floor and stays there, at a believable ankle height, at every phase.
  This is a real improvement and it should not be re-fixed.
- **13 mm of lateral slip appears at exactly the two phases where weight
  transfers** (p13% and p63%), i.e. the plant is correct in mid-stance and
  breaks at the hand-off. That is a foot-planting IK that locks the foot but
  does not blend the *release* — the classic symptom.
- **The swing foot peaks at only 130 mm.** A 1.83 m human walking clears
  150–200 mm at mid-swing; at 130 mm the foot skims and the gait reads
  shuffling rather than striding.
- **No contra-body rotation.** Across all eight frames the shoulders and the
  head are locked square. A walking human counter-rotates the pelvis against
  the thorax; without it the upper body reads as a mannequin on rails, which is
  a large part of "legs dangle like puppets" even when the feet are correct.
- **No vertical travel.** The pelvis height does not oscillate across the
  cycle. Real gait rises and falls ~40 mm per step.

### 7. Stature is right; posture is not. (`cell=scale`) — MEDIUM

Against a 1.83 m mannequin and a 1.20 m crate:

- Bind-pose mesh height **1.80 m against an ECFG nominal of 1.83 m, −1.5%**.
  That is fine and the scale discipline in the brief clearly landed.
- But the *posed* idle silhouette tops out visibly below the 1.83 m rule — the
  knees are permanently flexed and the neck is sunk into the shoulders, so the
  operator reads as ~1.72 m standing still. He looks squat next to the
  reference mannequin.
- Shoulders are narrower than the 0.41 m biacromial reference; the plate
  carrier is doing the work of shoulder width and it does not reach.
- The head is small relative to the body, which is what makes the whole figure
  read as taller-and-thinner-than-real in a still and squat in motion.

### 8. Faces are a mask with no shading. (`cell=hands`, `cell=head`) — MEDIUM

The exposed skin strip between the balaclava and the helmet brim is a **flat
bone-coloured band with no value variation at all** — no brow shadow, no nose
occlusion, no cheekbone. This is the `skin` atlas tile being near-neutral grey
(defect 1) plus no AO. At any distance it reads as a beige sticker.

### 9. Plate carriers are undifferentiated slabs. (`cell=roster`, `cell=hands`) — MEDIUM

The carrier front is two smooth planes with a chamfer. No cummerbund, no
shoulder-strap loop, no MOLLE webbing rows with actual depth, no magazine
pouches that read as separate objects with their own shadow, no drag handle.
The one pouch-like object on the chest is a flat rounded rectangle. Compare a
CS2 T-side model: the carrier is where most of the silhouette information
lives.

### 10. No specular sun anywhere. (`cell=calib`, chrome/gloss balls) — LOW/MEDIUM

The chrome ball shows a clean sky-to-ground gradient with a plausible horizon
line, but **no sun disc**: `nzSky()` builds the probe without one, and the
PMREM at 256 px could not resolve a 0.5° disc even if it did. Consequence: no
metal object in the game — a rifle receiver, a door handle, a railing — can
ever produce a sharp specular highlight from the key. The gloss ball
(roughness 0.22) shows the broad key lobe correctly, which confirms the
direct-light specular path is alive and it is only the *environment* that is
missing its sun. Adding a disc to `nzSky()` and raising the cube capture to
512 px would give every metal surface in the level its highlight back.

---

## What is genuinely good — do not spend another round on these

1. **Weapon length discipline.** AK OAL 861 mm vs 880 mm spec (−2.2%). The
   scale rule in the brief is being followed and it shows.
2. **Overall stature.** 1.80 m mesh against 1.83 m nominal, −1.5%. The
   3.5 units/metre convention is holding.
3. **Foot plant in mid-stance.** 77 mm ankle height, dead constant across five
   consecutive phases, no penetration, no float. The original "dangling legs"
   complaint is largely *solved* in mid-stance; only the hand-off and the swing
   arc remain.
4. **The tone curve.** ACES + 0.16 contrast + `exposure 0.95` maps 18% to 18%
   exactly. Do not touch it — the exposure problem was never here.
5. **Silhouette chamfering.** No pure 90° edges are visible on the operator or
   the weapon at close range; the chamfer discipline is real.
6. **Restraint.** No neon, no glowing eyes, no bloom halo. The emissive is down
   to a single IR strobe. The build is correctly *not* loud.

---

## Harness changes shipped with this report

Owned files only: `_critic_operators.html`, `scripts/render-critic.mjs`,
`build-static.mjs`, `CRITIC-REPORT.md`, `_critic_shots/`.

**Calibrated stage + a second environment.** `--env=studio|level`. `studio` is
the calibrated neutral rig above; `level` mirrors `NUKEM.html`'s own key
colour/intensity/azimuth, ambient, hemisphere, rim, fog and clear colour, hands
them to nz-render exactly as `boot()` does, and applies **none** of the
calibration — so it shows the shipping light, warts included. The burned-in
header names the active environment in green (studio) or amber (level), and the
calib cell grades itself and prints the measured stop error and key:fill on the
image.

**Four new cells.**

| cell | invocation | what it answers |
|---|---|---|
| `maps` | `--cell=maps --view=front --pose=idle` | albedo / normal / roughness / AO atlases flat and labelled with a 4×4 tile-name grid, plus all 16 regions on a chamfered cube and a sphere carrying the operator's real material |
| `roster` | `--cell=roster --view=front --pose=aim` | all four operators, one light, one lens, one standoff, one frame, name-plated |
| `anim` | `--cell=anim --pose=walk --view=side --frames=8` | N phases of one *continuous* cycle in sequence, with a projected world-y=0 line and per-frame ankle height and stance-foot slip in millimetres |
| `scale` | `--cell=scale --view=front --pose=idle` | operator beside a 1.83 m anthropometric mannequin and a 1.20 m crate, with projected 0.5 m rules and a measured stature readout |

Presets `--sheet=materials|strip|anim|scale|audit`. The existing CLI
(`--kind --pose --view --cell --sheet --nzq --ev --w --h --ss --force --list`)
is unchanged; everything above is additive. Every single-cell invocation
completes in 17–27 s.

**Static build fixed.** `build-static.mjs` copied `public/` and nothing else,
so the deployed `public/game/NUKEM.html` 404'd on **all seven** `nz-*.js`
module tags. Classic scripts fail silently, so the shipped game fell back to
its stock path with no error — the entire overhaul was missing from the
artifact while `npm test` passed, because `validate-game.mjs` only parses the
*inline* scripts. The build now copies all seven modules plus `demo.js` and
`vendor/` into `dist/client/game/`, ships the canonical root `NUKEM.html`
(warning when the `public/` duplicate has drifted), and **re-parses the built
page and fails the build if any local `<script src>` does not resolve**:

```
build ok: 8 module(s) + NUKEM.html -> dist/client/game/, 8/9 script tags local and all resolved
```

(the 9th is the unpkg three.js CDN URL). Verified negative: deleting one module
from the manifest gives `build FAILED: 1 script tag(s) … do not resolve:
nz-render.js`, exit 1. `npm test` passes.
