# VERIFY REPORT — does the actual game boot, look right and play?

**Agent:** VERIFY. **Method:** the real `NUKEM.html` booted in headless Chrome with
software WebGL (SwiftShader), 14 separate boot-and-observe passes. Every claim below
is backed by a console capture, a numeric probe read out of the running page, or a
rendered PNG I looked at. Nothing is inferred from source alone unless it says so.

**Verdict: the game boots, plays and does not panic. It does not yet look right.**
No module silently degrades in the shipping configuration — but one *did*, in the
CDN-failure configuration, and that is now fixed (§6).

---

## 0. Scoreboard

| | result |
|---|---|
| boots | **YES** — zero page errors, zero uncaught exceptions, one console warning |
| all modules install | **YES** — `render/enemies/weapons/env` true, `panic: 0`. `audio` false is a harness artefact, proven installable (§3.4) |
| plays | **YES** — enemies spawn/path/take cover/shoot, player kills them, killfeed populates both ways, ragdolls settle, zero NaN |
| looks right | **NO** — operators do not read against the level; the world detail-normal layer is dead in every build |
| deployed build boots | **YES** — `dist/client/game/` verified byte-identical and booted independently |
| regression suite | **PASS** — `npm test` ok, `enemy-harness` 40/40, `node --check` clean on all 8 JS files |

---

## 1. Harness

```
. /tmp/chsenv.sh
node /tmp/verify1.cjs  <out> <W> <H> <watch> <qs> <budget>   # boot + NZ.flags + screenshot
node /tmp/verify6b.cjs <out> <W> <H> <ticks> <shot>          # virtual-clock play + CPU perf
node /tmp/verify8.cjs  <out> <W> <H> <dist> <pick> <eye> <hud> <maxTier> <orbitDeg>
node /tmp/verify10.cjs <out> <ticks>                         # position-discontinuity hunt
node /tmp/verify11.cjs <out> <ticks>                         # full module self-report
node /tmp/verify_cdn.cjs <substring-to-block>                # CDN-failure behaviour
```

The blocker was throughput: `NUKEM.html` needs **30 s** to reach its first frame under
SwiftShader and every rendered frame after that costs 0.2–2.5 s, so a naive run gets
~12 frames — 0.6 s of game time, not enough for anything to happen. Two techniques
fixed that, and both are worth keeping:

- **Virtual clock.** `performance.now` and the rAF timestamp are replaced by one
  synthetic base that advances 1/60 s per tick. The game is untouched — it still sees
  a monotonic clock with sane deltas — but game time is decoupled from wall time.
- **Direct loop drive.** `requestAnimationFrame` is replaced by a queue; draining and
  re-running that queue N times executes N real game frames synchronously. With
  `renderer.render` no-op'd, **600 game frames (10 s of play) run in 2.3 s**, and the
  same instrumentation yields a clean CPU-side profile with rasterization excluded.

A warning for whoever reuses this: sub-stepping *through* rAF instead of draining a
queue multiplies callbacks exponentially (each invocation re-registers), which is how
an early run silently simulated 37 s of game time in 3 browser frames.

---

## 2. It boots — verified

`file://…/NUKEM.html?shot=game&mode=live` reaches `document.title === "SHOT LIVE"` in
30.3 s. Repeated 14×, never failed.

```
flags   { render: true, enemies: true, weapons: true, audio: false, env: true }
THREE.REVISION  149          NZ.ctx  { renderer, scene, camera, THREE, lights }
NZ.enemies      displayName, boneWorld, muzzleWorld, headWorld, hitboxes, poseAim,
                gripLocal, stats, _solver, _loco, ASSET, SPEC, REG, _atlas, scale, setScale
displayName     trooper:RIFLEMAN  pig:BREACHER  enforcer:ASSAULTER  octa:MARKSMAN
page errors     0        uncaught exceptions  0        requestfailed  0
console         [nz] three.js 149
                [nz-env] normal-map fetch not found in the r149 shader ...   <-- §5.2
```

Contract C3 is complete. Module self-reports on the live level (`verify11`):

- `NZ.render.selfCheck()` → `installed: true`, `shaderPatch: LIVE`, materials reached 40 /
  wrapped 16 / foreign 0 / `foreignHookThrew: 0`, `ibl: LIVE`, `skyDome: LIVE`,
  `colorManagement: MANAGED (hex literals are sRGB)`,
  `sunDisc: LIVE 1.41 deg … 5.0% of probe flux`.
  **CRITIC defects 0.1 (colour-management landmine) and 10 (no sun disc) are fixed.**
- `NZ.env.diag` → `anchorsOK: 16, anchorsBad: 0, chained: 16, chainErr: null, glslProbe: true`,
  12 world surfaces upgraded, 1 skipped — **but `detailOK: 0, detailMiss: 16`** (§5.2).
- `NZ.enemies.stats()` → `panic: 0` in every single run.
- `NZ.weapons.ready: true`, `verify()` returns `sightErr: 0` for both weapons (rear and
  front sight land on screen centre in ADS).

---

## 3. It plays — verified

`mode=live`, demo.js driving, 400–600 game frames per run, four independent runs.

### 3.1 The loop closes
Over 10 s of game time (`verify6b`, 600 ticks):

```
HUD    "I GOT THE SHOTGUN!  T:0:10.14  K:3/30  S:1/8  HEALTH 33  AMMO 2"
feed   YOU SHOTGUN ASSAULTER / YOU SHOTGUN ASSAULTER / YOU SHOTGUN RIFLEMAN
       BREACHER COMBAT SHOTGUN YOU
kills 3   damage events 26   secrets 1/8   weapon pickup: yes
```

Enemies spawn (30), path, chase, enter `attack`, and shoot back hard enough to take the
player from 100 to 33 HP and eventually kill him. The killfeed populates in **both**
directions and uses the rig's `displayName` (RIFLEMAN / ASSAULTER / BREACHER), so the
C3 name contract is live in the HUD.

### 3.2 The specific regressions this architecture invites — none found
Probed every enemy every frame via a priority-9999 `animateEnemyRig` /
`animateEnemyRigDeath` listener that returns `undefined` (so it observes without
overriding).

| check | result |
|---|---|
| non-finite root position or `matrixWorld` element | **0** across 30 enemies × 400–600 ticks × 4 runs |
| T-pose / renders-but-does-not-animate | **none**. Skinned enemies show bone motion (`footL` world position moves on 84–87% of frames). Far enemies are not static: `farUpdate()` pushes a 6-pose instanced flipbook (4 walk phases + dead + crouch), so they animate too |
| animates-but-does-not-move | **none**. Idle enemies show bone motion with a static root (E28: root still, bones moving) — the correct signature |
| slides-without-animating | **none**. My "root moves, foot frozen" counter fires 12–33 times per enemy, which is **foot planting working**, not a defect: the stance foot is locked in world space while the hips translate over it |
| vibration / jitter | **none**. Worst direction-reversal count is 21 in 422 ticks and every one is a sub-6 cm step |
| ragdoll settles | **yes**. E0 death → root at rest = **3.38 s**, bones active for ~0.6 s of that |

### 3.3 Performance
SwiftShader, 320×180, `renderer.render` no-op'd to isolate CPU from rasterization.
600 ticks = 10 s of game time, ~29 live enemies, 1.4 corpses.

| | ms per frame |
|---|---|
| **whole frame, CPU, modules on** | **3.82** |
| **whole frame, CPU, modules blocked (stock fallback path)** | **1.51** |
| **→ cost of the overhaul** | **+2.31 ms/frame (2.5×)** |
| `animateEnemyRig`, 29 enemies | 1.13 (**0.0394 / enemy**) |
| `animateEnemyRigDeath`, 1.4 corpses | 0.19 (**0.137 / corpse — 3.5× a live enemy**) |
| nz-render `render` hook (CPU orchestration only) | 0.31 |
| `scenePass` | 0.094 |
| `viewmodel` | 0.008 |
| `enemyKilled` (one-off spike) | 0.9–1.8 per kill |
| `renderer.render()` calls per frame | **8.9** (stock: 1) |
| boot to first frame | 30.3 s (stock: 21.2 s) |

Reading: at 30 enemies the *animation* alone is ~1.1 ms/frame, sitting on top of the
AI agent's measured 1.75–2.04 ms — so ~3 ms/frame of CPU for the enemy system at 30
bodies, which is the dominant module cost. The **8.9 render passes per frame** is where
the GPU budget goes and it is the number to watch on weak hardware, not the CPU.

Two things this measurement is not: absolute (SwiftShader), and a like-for-like A/B —
blocking the modules puts the game on its stock **sprite** enemy path, which does far
less work by design. Read `+2.31 ms` as "cost of the overhaul vs. its own fallback",
not "cost of the overhaul vs. an equivalent 3-D implementation".

### 3.4 Audio
`NZ.flags.audio` is **false in every headless run**, and that is *not* a module failure.
`nz-audio` waits for the game's own `AudioContext`, which is created in `audioInit()`,
which is only ever called from `startGame()` — and `mode=live` bypasses `startGame()`.
Proven by calling it directly on the running page:

```
{ hasFn: "function", flagBefore: false, called: true,
  ctxState: "running", flagAfter: true, sfxHooked: true }
```

The module installs cleanly the instant a context exists. I could not verify that it
*sounds* right — no audio capture in this environment.

---

## 4. It does not look right — with images

Camera driven onto the nearest live operator inside the running game, real level, real
level lighting, real level geometry (`verify8`). Images in `_critic_shots/`.

### `VERIFY_op_close_level.png` — RIFLEMAN at 7 units (2 m), front
The operator is a pale sand/khaki figure in front of a pale sand/khaki wall on a grey
concrete floor. **There is almost no value separation and no hue separation between the
character and the environment.** The boonie hat reads at the same value as the wall
behind it. A second operator ~15 m back is barely distinguishable from the masonry.
Nothing about the figure is wrong in isolation — pose, proportion, weapon carriage all
read — it simply does not separate from the background, which is the one thing CS2
never gets wrong.

### `VERIFY_op_mid_level.png` — same operator at 22 units (6.3 m)
Worse. At an ordinary engagement distance the operator is a small tan blob and **the
orange muzzle flash beside him is more visually prominent than he is.** If a player has
to find the flash to find the man, the character art is not doing its job.

### `VERIFY_op_close_backlit.png` — same operator, camera orbited 180°
Markedly better: real light/dark division across the torso, the pack and plate carrier
read as separate objects, the silhouette is legible. **The same operator at the same
distance in the same second is substantially more readable from one side than the
other** — CRITIC defect #2 (the level lighting swings with heading) is still shipping,
and it is now confirmed in the game rather than in a look-dev stage.

### What I see in all three
1. **Nothing grounds.** There is no contact shadow under the operator, under the medkit,
   or under the crates. Everything is pasted onto the floor. `selfCheck()` explains it:
   at the tier the game selected, `ao: "OFF (tier/degrade)"`, `contact: "OFF"`,
   `ssr: "OFF"`, `pcss: "FALLBACK (stock PCF)"`, `gbuffer: "OFF"`.
2. **The walls are flat.** Almost no surface relief at 2 m. That is §5.2, not an art
   choice.
3. **Monochrome.** Sky, walls, floor, operator and weapon furniture are all in one
   warm tan/grey family. The only saturated things on screen are the muzzle flash and
   the medkit cross.
4. **The viewmodel is the most legible object in every frame** — it reads as a real
   rifle with a real magazine, grip and handguard, and it is the darkest thing on
   screen. The enemy weapons do not get the same treatment at distance.

**Caveat, and it is a big one:** `detectTier()` returned **`low`** on SwiftShader in
every run (`MAX_SKIN [3,4]`, `LOD0_IN 18`, AO/contact/SSR/PCSS all off). **Everything I
say about grounding and shadow is a low-tier observation** and may resolve on real
hardware. The hue/value collision between operator and environment will not — that is
albedo, and it is tier-independent.

---

## 5. Defects, ranked

### 5.1 — CRITICAL, **now fixed by me** (§6): three.js came from a CDN with an r128 fallback that silently destroyed the build
`NUKEM.html:269–272` loaded three from unpkg and, on failure, `document.write`'d
**three r128** from cdnjs. Every `nz-*` module targets the r149 UMD surface.
Reproduced by blocking unpkg (`verify_cdn.cjs unpkg`):

```
THREE.REVISION  "128"
NZ.flags        { render: true, enemies: true, weapons: true, env: true }   <-- ALL TRUE
NZ.enemies.stats().panic   0
page errors     0
console         THREE.WebGLProgram: shader error … ERROR: 0:1363: 'roughness' : no such field   (×6)
                THREE.WebGLShadowMap: THREE.SkinnedMesh with material.skinning set to false
                WebGL: INVALID_OPERATION: useProgram: program not valid
```

`_critic_shots/VERIFY_r128_fallback.png`: the level renders in the wrong colours and
the enemy is a flat white cruciform blob — the un-skinned bind pose. **This is exactly
the failure this project is most exposed to: the game is visibly destroyed and every
panic guard reports success**, because a wrong-revision three.js is not an exception,
it is a different API that happens to have the same names. Numerically, that frame is
**5× further from a correct frame** than the fallback now is (mean |Δ| 25.65/channel vs
5.07/channel; 89.3% of pixels off by >6/channel vs 22.6%).

`vendor/three.r149.min.js` was already vendored, and `build-static.mjs` was already
copying it into `dist/client/game/vendor/` — **no script tag anywhere referenced it.**

### 5.2 — HIGH: the world detail-normal layer has never worked, in any build
Measured on the live game: `NZ.env.diag` = `{ detailOK: 0, detailMiss: 16 }`, while
every other injection lands (`anchorsOK: 16, anchorsBad: 0`). A warning is printed to
the console **on every boot** and nobody has resolved it.

Root cause, from source. `nz-env.js:1629`:

```js
var NRM_SRC = 'texture2D( normalMap, vUv ).xyz * 2.0 - 1.0';
if (f.indexOf(NRM_SRC) >= 0) { f = f.split(NRM_SRC).join('nzMapN( vUv )'); DIAG.detailOK++; }
else { DIAG.detailMiss++; … }
```

That literal lives inside `THREE.ShaderChunk.normal_fragment_maps`. three.js resolves
`#include` directives in `WebGLProgram`, **after** `onBeforeCompile` returns — so at the
moment this code runs, `shader.fragmentShader` still contains the bare string
`#include <normal_fragment_maps>` and the literal is *never* present. Every other anchor
in the same function (`#include <color_fragment>`, `<roughnessmap_fragment>`,
`<metalnessmap_fragment>`, `<lights_fragment_end>`, `<beginnormal_vertex>`,
`<begin_vertex>`) targets a `#include` **directive**, which is why those all succeed and
this one alone always fails. `detailOK: 0 / detailMiss: 16` is exactly what the theory
predicts.

**Consequence:** `nzMapN()` — the two-tap detail-normal function declared at
`nz-env.js:1477` with its own uniforms at 1530 — is compiled into all 16 world shaders
and **never called**. Every surface in the level renders with only its base normal map
at its base tiling frequency. This is why the walls read flat at 2 m in §4.
Fix is either patching `THREE.ShaderChunk.normal_fragment_maps` before compile, or
appending an override after `#include <normal_fragment_maps>`. I do not own `nz-env.js`
— reporting, not fixing.

### 5.3 — HIGH: operators do not read against the level
§4, with three images. Partly tier-dependent (contact shadow / AO off at `low`), partly
not (operator albedo sits in the same hue and value band as the concrete). The
CRITIC's defects #2 (lighting swings 2.5 stops by heading) and #3 (zero roster
differentiation) are both still visible in the shipping game.

### 5.4 — MEDIUM: corpses jump ~0.6 m every time they cross an LOD boundary
`verify10`, 600 ticks, 9 position discontinuities > 1 unit. The signature is
unambiguous — the **entity does not move at all** while the **rig root snaps**:

```
t=223  E0 trooper  dRoot 2.03  dE 0.00  tier 0->2  dead  root (97.9,0,119.8) -> (95.9,0,119.6)
t=373  E0 trooper  dRoot 2.00  dE 0.00  tier 2->1  dead  root (95.9,0,119.6) -> (97.9,0,119.8)
t=331  E1 enforcer dRoot 2.31  dE 0.03  tier 2->1  dead
t=342  E1 enforcer dRoot 2.39  dE 0.00  tier 1->2  dead
t=538  E1 enforcer dRoot 2.36  dE 0.00  tier 2->1  dead
```

Cause: the skinned ragdoll leaves `rig.root` wherever the body settled, but
`farUpdate()` (`nz-enemies.js`, §13) hard-sets `rig.root.position.set(e.x, y, e.z)` —
the entity's *logical* position, which the ragdoll drifted away from as it fell. The two
differ by ~2.3 units (0.66 m), so a corpse pops back and forth by two thirds of a metre
as the player walks toward and away from it. E1 did it three times in 10 s. LOD
hysteresis stops it shimmering; it does not stop it popping.

### 5.5 — MEDIUM: a live enemy warped 1.5 m in one 16 ms tick
`E19` (`pig`), state `chase`, tier 2: `t=227 dE 5.2` from (162,0,10) to (160.2,0,14.9),
then `t=240 dE 2.6`. That is ~89 m/s. This one is the **entity** position, not a rig
artefact — the rig follows one tick later. 2 events in 600 ticks, both on far enemies,
both in the same part of the map. Rare and distant, but it is a nav/AI warp.

### 5.6 — LOW/MEDIUM: a third of the roster stands still while in `chase`
Fraction of `chase` ticks on which the enemy actually moved:

```
E23 octa    488 chase ticks,  98 moved (20%)      E3  trooper 460 / 137 (30%)
E22 trooper 488 chase ticks, 151 moved (31%)      E27 octa    460 / 162 (35%)
```

The game's own `stuckT` never fires (max 0.32 s), so the AI does not consider them
stuck. Most are on other elevations (y = 12, y = −9) with no path to the player. It may
be intentional hold-in-place behaviour; it may be pathing that silently gives up.
Nobody has looked, and from the player's side it means a third of the level's occupants
never arrive.

### 5.7 — LOW: 10 pure-black `MeshBasicMaterial` meshes in the level
nz-render's own scanner finds them: `selfCheck().blackSurfaces` lists ten
`(unnamed mesh) / MeshBasicMaterial: albedo=black`. Pure black is the prototype tell
`CS2-BRIEF` calls out by name, and the module is already reporting it to nobody.

### 5.8 — LOW: the capture harness ships to production
`dist/client/game/NUKEM.html` contains `<script src="nz-shots.js">` — 64 KB of critic
harness in the shipped artifact. A user who hits the deployed URL with
`?shot=game&mode=live` gets the demo director instead of the game.

### 5.9 — LOW: `build-static.mjs` cannot clean `dist/`
`build: could not clean dist/ (EPERM) -- overwriting in place`, every run, on this
volume. Stale artifacts survive, which quietly weakens the build's own
"fail if any `<script src>` does not resolve" guarantee — a leftover file from a
previous build satisfies it.

### 5.10 — INFO: viewmodel shotgun is 26% under spec
`NZ.weapons.verify()` → `shotgun.lengthM = 0.7392` against the brief's 1005 mm
(`pistol.lengthM = 0.2357`, which is correct). Viewmodels are conventionally
foreshortened so this is probably deliberate, but it is far outside the ±5% the brief
demands and nothing documents the exception. The *enemy* weapons are within 2.7%
(harness).

---

## 6. What I changed

**One edit, to `NUKEM.html` only**, for defect 5.1 — proven above with a console
capture, a screenshot and a pixel diff.

Replaced the r128 cdnjs fallback with the already-vendored r149 build, and added a
revision assertion so a wrong-revision three.js can never again be silent:

```html
<script src="https://unpkg.com/three@0.149.0/build/three.min.js"></script>
<script>
window.THREE || document.write(decodeURIComponent('…src="vendor/three.r149.min.js"…'));
</script>
<script>
if (window.THREE) console.log('[nz] three.js', THREE.REVISION);
else console.error('[nz] three.js failed to load from the CDN or from vendor/three.r149.min.js …');
if (window.THREE && THREE.REVISION !== '149')
  console.error('[nz] three.js r' + THREE.REVISION + ' loaded, but every nz-* module targets r149; …');
</script>
```

**Why this and nothing else:** it is the only defect I found that is both fatal and
invisible, the correct asset was already vendored *and already copied into `dist/`* by
`build-static.mjs`, and the change is additive — it only executes when `window.THREE` is
falsy, so the normal path is untouched.

**Verified after the change:**

```
unpkg blocked  ->  THREE.REVISION 149   flags {render,enemies,weapons,env} all true
                   cdnjs never requested   shader errors 0   skinning warnings 0   page errors 0
pixel diff vs a normal boot   mean|d| 5.07/ch, 22.6% >6/ch   (was 25.65/ch, 89.3%)
npm test                      PASS
node scripts/enemy-harness.mjs  40 pass, 0 fail, 0 skipped
node --check on all 8 JS files  PASS
npm run build                 build ok: 8 module(s) + NUKEM.html -> dist/client/game/,
                              8/9 script tags local and all resolved
normal boot (unblocked)       unchanged: rev 149, all flags, 0 errors
```

**Side effect you should know about:** `public/game/NUKEM.html` was a byte-identical
copy of the root and has now drifted, so the build prints
`build: public/game/NUKEM.html differs from ./NUKEM.html (357592 vs 358389 bytes) --
shipping the root copy`. That is `build-static.mjs` working as designed and the shipped
artifact is correct. I left `public/game/` alone deliberately — it is not mine, it has
no `vendor/` directory, and it already 404s on all seven modules, so it is not a
functioning standalone copy either way. Someone should decide whether it should exist
at all.

---

## 7. The deployed build — verified

```
npm run build  ->  build ok: 8 module(s) + NUKEM.html -> dist/client/game/,
                   8/9 script tags local and all resolved
md5 dist/client/game/* vs source:  IDENTICAL for all 9 files
                                   (nz-enemies.js showed a mismatch once — a race with the
                                    RIG agent writing it mid-build; re-running the build matched)
script tags in dist:  nz-core, nz-shots, nz-render, nz-env, nz-enemies, nz-weapons,
                      nz-audio, demo  +  the unpkg CDN URL
vendor/three.r149.min.js present in dist/client/game/vendor/
```

The artifact was then **booted independently** out of `dist/client/game/`:
`SHOT LIVE`, `flags {render:true, enemies:true, weapons:true, audio:false, env:true}`,
`THREE 149`, **0 page errors**. Not trusted from the report — actually run.

---

## 8. Regression suite — verified

```
node --check      nz-audio nz-core nz-enemies nz-env nz-render nz-shots nz-weapons demo   ALL PASS
npm test          Level OK: 1619 traversable nodes, 19 doors, 4 lifts, 119 spawns
                  NUKEM.html: 4 inline scripts parsed
                  public/game/NUKEM.html: 4 inline scripts parsed
enemy-harness     40 pass, 0 fail, 0 skipped   (trooper/pig/enforcer/octa × 10 metrics)
```

All re-run **after** my `NUKEM.html` edit.

Worth flagging: `validate-game.mjs` only parses **inline** scripts. It would not have
caught defect 5.1, it did not catch defect 5.2, and it cannot catch anything that lives
in an external module. The real safety net here is `enemy-harness.mjs`, and it only
covers `nz-enemies.js`.

---

## 9. What I could NOT test, and why

| | why |
|---|---|
| **medium / ultra render tiers** | `detectTier()` returned `low` on SwiftShader in all 14 runs. AO, contact shadows, SSR, PCSS and the larger LOD budgets (`MAX_SKIN [6,10]`, `LOD0_IN 26 / LOD1_IN 72`) were **never once exercised**. This is the single biggest hole in this report — the configuration real users get is untested |
| **real GPU frame time** | every absolute number here is SwiftShader. Only the CPU-side ratios transfer |
| **audio output** | installs correctly (§3.4) but no audio capture available; never heard |
| **input** | drove the game through demo.js, never through synthetic keyboard/mouse events. Aim, ADS, weapon switching and the pointer-lock path are unverified |
| **the title screen / `startGame()` path** | `mode=live` bypasses it. The normal player entry point has not been booted |
| **`_shot_*.html` launchers, and the `enemies`/`env`/`weapons`/`materials` scenes** | only the `game` scene was exercised |
| **both CDNs down** | tested unpkg-down (now resolves to local vendor). Never tested with the local vendor file also missing |
| **sessions longer than ~10 s of game time** | no soak test, no memory-growth measurement, no check that the ragdoll/corpse pool is bounded. Corpses cost 3.5× a live enemy per frame, so this matters |
| **the level beyond the demo route's first 10 seconds** | demo.js walks a fixed route; most of the 119 spawns and 19 doors were never reached |

---

## 10. If you fix one thing next

**Defect 5.2 — the dead detail-normal layer in `nz-env.js`.** 5.1 is fixed. 5.3 is a big
art problem that will take a round. 5.2 is a **one-line targeting bug that silently
removes surface detail from every surface in the game**, it has been announcing itself
in the console on every boot since it was written, the code to do the work is already
compiled into all 16 world shaders, and the fix is to attach the substitution to the
`#include <normal_fragment_maps>` directive instead of to a string that only exists
after three.js has already expanded it. It is the highest ratio of visible improvement
to work in the tree.
