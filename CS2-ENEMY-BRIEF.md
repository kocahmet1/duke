# CS2 ENEMY OVERHAUL — SHARED AGENT BRIEF (round 2)

Read `CS2-BRIEF.md` first for architecture and hard rules. Everything there still
applies. This document adds the enemy-specific target and the **cross-file
contracts** that let three agents work in parallel without colliding.

---

## 1. The decision

**The game is no longer Duke Nukem.** It is a grounded tactical FPS in the CS2
mould. The user's verdict on the current enemies, verbatim:

> "their legs dangle like puppets at times. also how they hold their weapon is very
> weird. also their weapon is not realistic. make them look realistic like in
> counterstrike 2. Also make them more intelligent with better coordination and aim."

The alien/mutant roster is **retired**. All four enemy kinds become **human
operators**. Confirmed by the user.

### Roster mapping — the `kind` IDs DO NOT CHANGE

The string IDs are load-bearing across `NUKEM.html`, `nz-enemies.js`, `nz-audio.js`
and `nz-shots.js`. Renaming them breaks everything. Keep the IDs, replace the
fiction.

| kind ID | was | becomes | kit | primary |
|---|---|---|---|---|
| `trooper` | alien grunt | **RIFLEMAN** | light: fatigues, chest rig, boonie/cap, no plate | AR (AK-pattern) |
| `pig` | pig-cop | **BREACHER** | heavy: full plate carrier, ballistic helmet + visor, knee pads | shotgun |
| `enforcer` | lizard | **ASSAULTER** | medium: plate carrier, comms headset, balaclava, radio | AR (M4-pattern), burst |
| `octa` | flying squid | **MARKSMAN** | light-medium: ghillie-ish wrap, spotter scope, low-vis | bolt-action DMR |

Display names live in a new exported map so the HUD/killfeed can read them:
`NZ.enemies.displayName[kind]`.

---

## 2. Scale — get this right before modelling anything

The world is **not** in metres. Derive everything from the config heights in
`ECFG` (`NUKEM.html`):

```
trooper h = 6.4   pig h = 7.2   enforcer h = 7.8   octa h = 6.2
```

A `trooper` is the baseline adult operator at **1.83 m**, so:

```
SCALE = 3.5 world units per metre          (6.4 units / 1.83 m)
```

**Every dimension you model must be a real-world measurement × SCALE.** No eyeballed
numbers. Write the millimetre value in a comment next to the constant. This one rule
is what separates "looks like a game" from "looks like CS2".

Reference anthropometry (50th-percentile male, metres → units):

| part | real | units |
|---|---|---|
| total height | 1.83 | 6.40 |
| eye height | 1.71 | 5.99 |
| shoulder width (biacromial) | 0.41 | 1.44 |
| shoulder height | 1.50 | 5.25 |
| hip height | 0.94 | 3.29 |
| knee height | 0.50 | 1.75 |
| upper arm | 0.33 | 1.16 |
| forearm | 0.26 | 0.91 |
| hand length | 0.19 | 0.67 |
| thigh | 0.43 | 1.51 |
| shin | 0.42 | 1.47 |
| foot length | 0.27 | 0.95 |
| head height | 0.23 | 0.81 |
| head width | 0.155 | 0.54 |
| neck diameter | 0.12 | 0.42 |

Weapon reference (real overall length → units):

| weapon | real OAL | units | notes |
|---|---|---|---|
| AK-pattern AR | 880 mm | 3.08 | 415 mm barrel, 30-rd curved mag, wood/polymer furniture |
| M4-pattern AR | 840 mm (stock out) | 2.94 | 368 mm barrel, flat-top rail, collapsible stock, red dot |
| combat shotgun | 1005 mm | 3.52 | 470 mm barrel, tube mag, pump forend |
| bolt DMR | 1160 mm | 4.06 | 610 mm barrel, bipod, 10× scope, cheek riser |

**Sanity check that will catch you:** a rifle held at the shoulder should span from
the operator's shoulder to roughly one hand-length past their leading fist. If the
gun is longer than the operator's arm-span or shorter than their forearm, it is
wrong. In the current build the weapon is a featureless white slab about the size of
a canoe paddle — that is exactly the failure mode to eliminate.

---

## 3. The three specific defects the user named

These are the acceptance criteria. Everything else is secondary.

### 3.1 "Their legs dangle like puppets"
Root cause is almost certainly that the leg chain is driven by an open-loop sine
walk cycle with no ground constraint, so feet pass through and float above the floor
and slide laterally while the root translates. Required fix:

- **Foot-planting IK.** When a foot is in stance phase its world position is
  *locked*; the hips solve around it. Zero lateral slip. This is non-negotiable —
  foot skate is the single loudest tell of amateur character animation.
- **Two-bone analytic IK** (hip→knee→ankle) with a knee pole vector so knees never
  invert or hyperextend. Clamp knee flexion to 0°–150°.
- **Ground raycast per foot** against the floor plane so feet conform to the surface
  height and the ankle pitches to match, instead of hovering.
- **Pelvis follow:** hips drop when both feet are planted on uneven ground, and
  counter-rotate against the shoulders (contra-body movement). A human walking
  rotates the pelvis and thorax in opposition — without this, characters look like
  marionettes even with perfect foot contact.
- **Stride length derived from speed**, not the reverse. Phase advances as
  `distanceTravelled / strideLength`. If you drive phase off a clock while the body
  moves at a different rate, the feet WILL skate. This is the bug.
- **Weight shift and settle.** Centre of mass tracks over the support foot. Add
  anticipation before a step and a small settle after heel strike.

### 3.2 "How they hold their weapon is very weird"
- The weapon is parented to the **right hand**, not floating in front of the chest.
  The right hand grips the pistol grip with the trigger finger indexed along the
  receiver (finger off trigger until firing — CS2 does this and it reads).
- The **left hand is IK-solved onto the handguard**, not mirrored from the right.
  Support-hand grip: C-clamp thumb-forward on the AR, forend on the shotgun, on the
  bipod/stock bag for the DMR.
- Both elbows are solved *after* the hands are placed. Elbows swing out and down
  naturally; they never clip the torso and never flare above the shoulder.
- The stock is welded to the shoulder pocket, with a cheek weld to the comb. The
  sight line runs through the operator's dominant eye. Draw an imaginary line from
  eye → rear sight → front sight → target: if it doesn't fit, the pose is wrong.
- **Aim is a layered additive**, not a rotation of the whole body: pitch is spread
  across spine (30%), chest (30%), neck (20%), head (20%). Yaw likewise. The body
  turns to follow only once the aim exceeds ~45°, then the feet step to re-square.

### 3.3 "Their weapon is not realistic"
Model actual firearms, not proxies. Each weapon needs at minimum: receiver, barrel
with a distinct profile, muzzle device, handguard with rail or furniture, pistol
grip, trigger guard + trigger, magazine (correct curve and length), stock, sights or
optic, sling mounts. Chamfer every edge. Gunmetal is not a flat grey — it needs
roughness variation, edge wear on the high points, and carbon fouling near the
muzzle and ejection port.

---

## 4. Cross-file contracts (agents must honour these exactly)

### C1 — `octa` stops flying
`octa` becomes a ground-based marksman. The `float: 3.4` property and the projectile
attack are removed by the **AI agent** in `NUKEM.html`; the **rig agent** must
therefore ship `octa` as a normal biped with legs, sharing the biped skeleton and
locomotion. Neither agent may assume the other has landed yet — both must tolerate
`cfg.float` being present or absent.

### C2 — kind IDs are frozen
`trooper` / `pig` / `enforcer` / `octa`. Do not rename. Add `NZ.enemies.displayName`
for human-readable names.

### C3 — public surface of `nz-enemies.js`
The rig agent guarantees these stay available:
```js
NZ.enemies = {
  displayName: { trooper:'RIFLEMAN', pig:'BREACHER', enforcer:'ASSAULTER', octa:'MARKSMAN' },
  boneWorld(e, name)     // world-space Vector3 of a named bone, or null
  muzzleWorld(e)         // world-space muzzle point + forward dir {p, d} for tracers
  headWorld(e)           // world head centre + radius, for headshot hitboxes
  hitboxes(e)            // array of {name, centre, halfExtents, mult} capsules/boxes
  poseAim(e, yaw, pitch) // request an aim direction; rig blends toward it
}
```
The AI agent may call these but must null-guard every one (module may have panicked).

### C4 — file ownership, absolute
- `nz-enemies.js` → **RIG agent only**
- `NUKEM.html` → **AI agent only**
- `scripts/**`, `vendor/**` → **HARNESS agent only**
- `nz-core.js`, `nz-render.js`, `nz-env.js`, `nz-weapons.js`, `nz-audio.js`,
  `nz-shots.js` → nobody this round. Request changes from the orchestrator.

### C5 — validation gate
Before reporting done: `node --check <file>` on every JS you touched, `npm test`
passes, and `node scripts/enemy-harness.mjs` (built by the HARNESS agent) reports no
regressions. Never leave the tree in a broken state.

---

## 5. Headless validation is available — use it

Three.js r149 runs fine inside a Node `vm` context. `vendor/three.r149.min.js` is
already vendored. This means the classic-script modules can be loaded and exercised
**without a browser**, and animation can be measured numerically rather than guessed
at. Minimal bootstrap:

```js
const vm = require('vm'), fs = require('fs');
const s = {}; s.globalThis = s; s.self = s; s.window = s; s.console = console;
s.performance = { now: () => Date.now() };
s.requestAnimationFrame = () => 0;
s.document = { createElement: () => ({ getContext: () => null, style:{}, width:0, height:0 }),
               createElementNS: () => ({ style:{} }), addEventListener(){}, body:{ appendChild(){} } };
s.navigator = { userAgent: 'node' };
vm.createContext(s);
vm.runInContext(fs.readFileSync('vendor/three.r149.min.js','utf8'), s);
// s.THREE.REVISION === '149'
```

Canvas 2D is not available, so texture baking must be stubbed or skipped in the
harness — measure geometry and animation, not pixels.

**Metrics that must be green:**

| metric | threshold |
|---|---|
| foot skate (lateral slip of a planted foot per frame) | < 1 mm equivalent (0.0035 units) |
| foot ground penetration | < 5 mm (0.018 units) |
| foot float above ground during stance | < 5 mm |
| knee inversion events over 600 frames | 0 |
| support hand → handguard grip point distance | < 20 mm (0.07 units) |
| trigger hand → pistol grip distance | < 15 mm |
| any bone NaN / non-finite | 0 |
| weapon OAL vs. spec | within 5% |
| self-intersection: elbow inside torso capsule | 0 frames |

---

## 6. The bar

Shown blind next to a real CS2 frame, would a harsh critic pick ours? "Good for a
browser game" is a failing grade. Adversarial critics will review the rendered
contact sheet and send back defect lists. Expect multiple rounds. Report honestly on
what you could not reach — the critic finds it anyway.
