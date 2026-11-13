# ARENA-SPEC — MISSION 2: "THE CRUCIBLE"
Binding spec for Level 2. All agents implement EXACTLY this; deviations only where the spec says "tune".

## Concept
Unreal-Tournament-style tournament hall: a cylindrical rotunda with an EMPTY central void from
the ground pit to an open oculus at the top. Concentric ring galleries step upward around the void
(colosseum section). From any gallery you see the opposite galleries across the hall at every
height. One radial canyon ("the trench") cuts east from the pit to an express lift; the exit
vestibule hangs off the TOP ring at west, gated by the red keycard found on the top ring east.

Flow: spawn on ground (teleporter pad) → clear pit → stairs up (staggered N/S per storey, forcing
half-laps) → top ring → grab red key at east lip (overlooking trench/lift) → lap west → key door →
exit switch. Express lift = shortcut/return + AI route.

## Engine constraints honoured (from recon; do not fight these)
- Grid 64×48, CELL=4, one region (one `f` floor + one `c` ceiling) per cell. No stacked floors.
- AI/nav: adjacent-cell floor delta ≤ 1.15 (CLIMB) or `makeLift`; no flying enemies; central void
  is a hard AI barrier (intended).
- `validate-level.mjs` executes the slice `const MW =` → `/* ====...= world geometry` in a bare
  vm (only `console`). NOTHING in the slice may touch window/location/document/NZ.
- `public/game/NUKEM.html` must stay byte-identical to root `NUKEM.html`.

## LEVEL plumbing (exact contract)
- Inside the validated slice, immediately after `const MW = 64, MH = 48, CELL = 4;` add EXACTLY:
  `let LEVEL = 1; /* 1 = Hollywood Holocaust, 2 = The Crucible; boot() promotes before buildMap */`
  (validate-level's level-2 pass string-replaces `let LEVEL = 1;` with `let LEVEL = 2;` — keep the
  token verbatim.)
- `boot()` (outside slice), BEFORE the stage list runs: promote via
  `if (/(?:[#&?])level=2/.test(location.hash + location.search)) LEVEL = 2;`
  then `if (window.NZ) NZ.level = LEVEL;` (modules + demo.js gate on `NZ.level`).
- `buildMap()` first line: `if (LEVEL === 2) return buildArenaMap();` — level-1 body untouched.
- `buildArenaMap()` lives inside the slice, uses only slice-local helpers
  (carve/paint/region/light/door/makeLift/spawn/idx).

## Geometry (cell coords; r(x,y)=Math.hypot(x-32, y-24), evaluated per cell at (x,y))
CX=32, CY=24. Carve only within x 4..56, y 2..46. Everything else stays S_SOLID rock.

| Zone        | Band            | f  | c  | notes |
|-------------|-----------------|----|----|-------|
| GROUND HALL | r ≤ 12.2        | 0  | 40 | the pit / hall floor; center disc r ≤ 6 uses `sky:true, c:46` (open oculus; band 40→46 becomes the clerestory drum) |
| GALLERY G1  | 12.2 < r ≤ 15.4 | 8  | 40 | open terrace ring |
| GALLERY G2  | 15.4 < r ≤ 18.6 | 16 | 40 | open terrace ring |
| GALLERY G3  | 18.6 < r ≤ 21.4 | 24 | 40 | top ring |
| EAST TRENCH | x 45..51, y 23..25 | 0 | 40 | radial canyon, overrides bands; galleries become C-arcs open at east |
| LIFT        | x 52..53, y 23..25 | lo 0, hi 24 | 40 | `makeLift(52,23,53,25,0,24,{start:'lo'})`; at hi it adjoins G3 cells y 22 / y 26 |
| EXIT DOOR   | (11,24)         | 24 | 31 | own 1-cell region; `grid=S_KEY; door(11,24,'key')` — off G3 west |
| VESTIBULE   | x 7..10, y 23..25 | 24 | 34 | warm amb; `grid[idx(6,24)] = S_EXIT` (switch wall, level-1 pattern) |

- Paint order: ground/oculus, then G1..G3 annuli, then trench + lift + stairs + pockets override
  (later paint wins). Tune band edges ±0.4 only if an annulus pinches < 3 cells wide anywhere.
- Stairs (each: width 2 cells, straight axis-aligned runs, one region per step, +1.0 per cell,
  8 steps, c=40): G0→G1 at NORTH (around x 31..32, climbing outward y 12→…), G1→G2 at SOUTH,
  G2→G3 at NORTH-WEST. Exact cells: implementer's choice; MUST pass the level-2 BFS
  (spawn→key→exit reachable with climb ≤ 1.15; every enemy/pickup cell reachable).
- Secrets: exactly 8 `S_SECRET` pushwalls (tally is hardcoded /8): 3 off G1 (pockets notched into
  the G2 band at f=8, c=15), 3 off G2 (notched into G3 band, f=16, c=23), 2 off G3 (true rock
  pockets r>21.4, f=24, c=31). Pockets 2×2, placed away from stairs; rings must stay connected
  around each notch.
- GRACE_ZONE: leave all-zero on level 2. No `S_BLOCK` anywhere (void stays empty; no crates).

## Population (tune counts ±20%, keep composition)
- Enemies (~30): pit 3 pig + 4 trooper; trench 2 pig + 1 enforcer; G1 4 trooper + 2 enforcer;
  G2 3 enforcer + 2 octa (opposite quadrants — cross-void sniper duels); G3 2 enforcer + 3 octa
  spread around the ring + 2 pig guarding the key; west G3 near exit 1 octa + 1 enforcer.
- Pickups: wshotgun near spawn; wchain G1; wrifle G2; secrets get wrpg, wgrenade, armor, atomic,
  medpack + ammo; keyred on G3 EAST lip (overlooking lift); spread clip×5, shells×4, cbelt×3,
  rmag×2, rockets×2, medkit×4, firstaid×2, armor×1 across floors.
- Player: `spawn('player', 32, 34)` (ground, south of center, default yaw looks north across the
  whole rotunda for the money shot).

## Lighting
- Sconces: every ~5 cells along each gallery's OUTER edge, worldY = f+5, warm amber
  [1.0,.72,.42], radius 22, intensity ~1.15 (radius < 30 ⇒ nz-env auto-hangs fixture geometry).
- Teal alien accents [.45,.85,1.0] at trench walls, lift shaft, key pedestal, spawn pad.
- Clerestory: 8 cool fills [.62,.72,.95] at worldY 42, radius 34 (≥30 ⇒ no fixture), int ~.9.
- Vestibule: warm red-amber. Region `amb`: ground [.07,.08,.11], G1 [.06,.07,.10],
  G2 [.055,.065,.095], G3 [.05,.06,.09], vestibule [.12,.08,.06].
- Textures: reuse existing SURFACE_STYLE names only (grep buildTextures; e.g. concrete/tilefloor/
  ceildark family). No new texture keys in the slice.

## nz-arena.js (visual module; separate file, loads after nz-env.js)
- Gate: install on `NZ.on('ready')` ONLY when `NZ.level === 2`; on level 1 do nothing. Bind game
  globals with the street `tryGet` pattern (MW, CELL, regAt, cellAt, floorAt, lightAt, LIGHTS…).
- Derive all placement from the GRID (regAt floor heights), not from hardcoded copies of this
  table, so slice tuning can't desync it.
- Content: pilasters + arched niches on every riser wall; knee-high parapet trim at gallery void
  edges (visual only, ≤0.5 proud, gaps at stairs); alien-tournament banners on G2/G3 risers;
  glowing clerestory ring; radial rib beams under the ring ceiling; teleporter spawn pad; floating
  holo-ring "scoreboard" over the pit at worldY ≈ 32 (no collision, above jump reach); lift-shaft
  and trench dressing; key pedestal glow on G3 east.
- Materials: NZ.tex bakes; COPY nz-env's material-naming contract (`nzenv:*` etc.) so
  nz-render's wrapForeignMaterials/neutralizeBakedLighting treats them correctly (study
  nz-render.js:2282 area first). Bake per-vertex colour via captured `lightAt` for cohesion.
- Budget: ≤ 20 draw calls (merged Pile-style geometry per material), ≤ 180k tris,
  matrixAutoUpdate=false, castShadow=false, receiveShadow=true.

## Flow / UI wiring (outside slice)
- Win screen: level 1 win adds a `NEXT MISSION` button →
  `location.hash = 'skill=' + SKILL_I + '&level=2'; location.reload();`
  Level 2 win: h1 becomes `CAMPAIGN COMPLETE`, no next button (PLAY AGAIN → strip level=2 from
  hash so it restarts mission 1). btnRetry/btnAgain on level 2 must PRESERVE level=2 (death retry
  restarts the arena).
- Titles: on LEVEL 2 set document.title and title-screen mission line to
  `MISSION 2: THE CRUCIBLE`; objective subtitle: `REACH THE TOP RING - FIND THE RED KEYCARD`.
- Automap legend: make the storey legend level-aware (level 2: PIT / GALLERY 1 / 2 / TOP RING).
- demo.js: no-op when `NZ.level === 2` (its scripted inputs are level-1 coords).
- Fall damage: check the landing-damage formula; G1→pit (8 units) must be a viable shortcut.

## Build/test wiring
- NUKEM.html: add `<script src="nz-arena.js">` tag after nz-env.js (before nz-enemies.js block order
  is fine; match existing tag style). build-static.mjs MODULES: add "nz-arena.js".
- validate-level.mjs: keep level-1 pass untouched; ADD a level-2 pass — re-run the slice with
  `let LEVEL = 1;` → `let LEVEL = 2;` replaced, then assert: exactly one player spawn + one keyred;
  BFS (climb ≤1.15, doors passable, key-before-lock) reaches keycard, exit, every enemy/pickup/
  secret; 8 secrets; lift links both storeys; all carved cells within bounds; band widths ≥ 2.
- After all edits: copy root NUKEM.html byte-identical to public/game/NUKEM.html. `npm test` must
  pass. Headless renders via `npm run shot -- --q='level=2' ...`.
