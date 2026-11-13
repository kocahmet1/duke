# CS2-QUALITY UPGRADE — SHARED AGENT BRIEF

## Target (decided by the user)
- **Art direction: full CS2 photoreal.** Grounded, physically-plausible materials and
  lighting in the spirit of Dust2 / Mirage / Overpass. Realistic weapon proportions,
  human-scale characters, believable concrete / metal / grime / glass.
  The 90s Duke camp gets toned DOWN. This is not a stylised cartoon shooter any more.
- **Perf: adaptive tiers.** Maximum quality on a high-end GPU, automatically scaling
  down on weaker hardware. `nz-render.js` already has `detectTier()` — extend that
  system, do not bypass it. Nothing may hard-lock the game to a quality level.

## The bar
Every change is judged by one question: **shown blind next to a real Counter-Strike 2
frame, would a harsh critic pick ours?** "Good for a browser game" is a failing grade.
Adversarial critic agents will review screenshots and send back defect lists. Expect
multiple rounds.

## Architecture you must respect
`NUKEM.html` (~5000 lines) is the game: level geometry, player, AI, HUD. It loads
`three.js r149 UMD` from unpkg, then:

```
nz-core.js      NZ.hook bus, NZ.tex procedural PBR bakery, NZ.math springs
nz-render.js    post stack + IBL + lighting
nz-enemies.js   enemy meshes, skinning, animation, ragdoll
nz-weapons.js   first-person viewmodels + FX
nz-audio.js     all sound synthesis
```

Modules attach through the hook bus and never edit each other:

```js
NZ.on(name, fn, priority)   // register
NZ.call(name, ...args)      // fire all listeners
NZ.first(name, ...args)     // fire in order, first non-undefined result wins
                            // -> this is how you OVERRIDE stock behaviour
NZ.ctx = { renderer, scene, camera, THREE }   // filled at boot
NZ.flags = { render, enemies, weapons, audio } // set true once you install cleanly
```

Known hooks: `rendererInit`, `ready`, `resize`, `render`, `scenePass`, `viewmodel`,
`createEnemyRig`, `animateEnemyRig`, `animateEnemyRigDeath`, `enemyDamaged`,
`enemyKilled`, `sfx`.

### Hard rules
1. **One agent owns one file.** Do not edit a file you were not assigned.
   Do not edit `nz-core.js` — request core changes from the orchestrator.
   Do not edit `NUKEM.html` — the orchestrator owns it. Reach the level by
   traversing `NZ.ctx.scene` on the `ready` hook.
2. **Classic scripts only.** No ES modules, no `import`, no build step, no bundler.
   Everything is wrapped in `(function(global){ 'use strict'; ... })(window)`.
3. **three.js r149 UMD surface only.** Anything in `examples/js` does NOT exist —
   no OrbitControls, no EffectComposer, no BufferGeometryUtils, no GLTFLoader.
   Write it yourself. (The existing modules already do; copy their approach.)
4. **Zero external assets.** No image files, no model files, no audio files, no fetch.
   Every texture, mesh, animation curve and sound is generated at runtime.
   `NZ.tex.bake()` in nz-core.js emits a full {map, normalMap, roughnessMap,
   metalnessMap, aoMap} set from procedural fbm/worley noise — use it.
5. **Never break the game.** Wrap installation in try/catch. On any throw, tear your
   module down, set your `NZ.flags` entry false, and let the stock path take over.
   The existing modules all do this (`panic()`); keep that discipline.
6. **Validate before you finish.** `node --check <yourfile>.js` must pass, and
   `npm test` from the project root must pass.

## Quality references — what "CS2 quality" actually means
- **Materials:** no flat colours. Every surface needs albedo variation, a real normal
  map, roughness variation (this is what sells metal vs painted metal vs plastic),
  edge wear on convex edges, dirt accumulation in crevices, and AO in the cavities.
- **Lighting:** physically-scaled intensities, a single dominant key with soft
  shadows, bounce/ambient from an IBL probe rather than a flat ambient term,
  contact shadows so nothing floats.
- **Silhouette first:** an object reads as real from its outline before any texture
  loads. Chamfer every hard edge — a pure 90° edge is the #1 tell of a prototype.
- **Motion:** no linear interpolation anywhere a human would see it. Springs,
  anticipation, follow-through, settle. Feet plant and never skate.
- **Restraint:** CS2 is not loud. It is grounded, desaturated, and readable.
  Resist neon, resist bloom, resist saturation. Contrast and detail carry it.

## Reporting back
Finish with: what you changed, what is measurably better, what you could not reach,
and the specific things you want the critic to look at. Be honest about weak spots —
the critic will find them anyway and an accurate self-assessment saves a round.
