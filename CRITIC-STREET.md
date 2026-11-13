# CRITIC REPORT — 233. Sokak

**Agent:** CRITIC-STREET.
**Snapshot:** the five street modules as of `nz-street-props.js` @ 190,390 B / 22:25:25.
`nz-street-props.js` was rewritten **five times while this pass was running** (170,081 B
@ 22:12 → 184,188 B @ 22:14 → 190,090 B @ 22:19 → 190,390 B @ 22:25). Two runs caught
it mid-write with `NZ.flags.streetProps === false`, and the module tore itself out —
those frames (`_shots/critic/hi/street.westend.png`,
`_shots/critic/base/street.{high,northwall,southwall}.png`) contain **no props at all**
and are labelled as such below. Everything else in `_shots/critic/` was rendered with
all five flags true (`--diag`: `{"streetSky":true,"streetGround":true,"street":true,
"streetEntrance":true,"streetProps":true}`). Anything tagged PROPS may already be moving.

**Method:** every claim below was read off a rendered image or off a number measured out
of a PNG framebuffer with numpy. Nothing here is inferred from source. Where a value is
quoted it is sRGB 0–255 out of the PNG, and where a *ratio* is quoted it is because a
ratio survives the exposure difference between a Street View capture and our tone curve
and a raw value does not.

Reproduce the whole set (each call is one boot; the sheet is resumable):

```
. /tmp/chsenv.sh
node scripts/render-level.mjs --sheet=street --out=_shots/critic/md --w=640 --h=400 --taa=1
node scripts/render-level.mjs --sheet=street.northwall,street.alley,street.sky --at=200,6.4,159.5  --out=_shots/critic/c-nwall
node scripts/render-level.mjs --sheet=street.alley,street.northwall,street.sky   --at=242,6.9,158.6 --out=_shots/critic/c-door
node scripts/render-level.mjs --sheet=street.alley                               --at=202,6.4,170.5 --out=_shots/critic/c-car
node scripts/render-level.mjs --sheet=street.kerb,street.westend,street.alley    --at=176,1.2,170.5 --out=_shots/critic/c-graze
node scripts/render-level.mjs --sheet=street.northwall,street.westend            --at=210,44,172    --out=_shots/critic/c-roof
node scripts/render-level.mjs --sheet=street.southwall,street.sky,street.south34 --at=200,6.4,184.5 --out=_shots/critic/c-swall
node scripts/render-level.mjs --sheet=street.southwall,street.sky                --at=182,6.4,153.5 --out=_shots/critic/c-alleyN
node scripts/render-level.mjs --sheet=street.alley                               --at=242,6.0,148   --out=_shots/critic/c-foyer
node scripts/render-level.mjs --sheet=street.westend --q=nzprops=0  --out=_shots/critic/ab-noprops
node scripts/render-level.mjs --sheet=street.westend --q=nzground=0 --out=_shots/critic/ab-noground
```

> Harness note: on this box boot ran 11.6 s – 42.2 s and the first grab after a page load
> costs another 6 – 24 s, so a 45 s shell call yields between zero and eight frames. Budget
> three calls for every one you need.

---

## 0. The exposure audit — the street is not too bright, it is too *flat*

The complaint "the whole frame is washed out" is real but the diagnosis in it is wrong.
Mean luminance is already correct. What is wrong is the **spread**.

Measured over the lower 57 % of the frame (i.e. the street, sky excluded), our money
shot against the two photographs it is a copy of:

| | `_ref/ref1` | `_ref/ref4` | **`_shots/critic/md/street.westend.png`** |
|---|---|---|---|
| luminance p5 | 20.9 | 21.9 | **39.1** — blacks lifted **+18** |
| luminance p50 | 105.7 | 120.5 | 125.7 — fine |
| luminance p95 | 226.2 | 232.7 | **199.9** — highlights **−27 to −33** |
| **spread p95−p5** | **205.3** | **210.8** | **160.8 (−24 %)** |
| **mean saturation** | **0.197** | **0.180** | **0.104 (−45 %)** |
| pixels ≥ 254 | 0.22 % | — | **0.000 %** (frame max 244) |

So: **nothing in this street is ever black and nothing is ever white**, and the colour is
down by nearly half. That is the whole "washed out" impression in two numbers. It is not
fixed by pulling exposure — pulling exposure down makes p95 worse. It is fixed by (a)
putting real occlusion back (§1.2), (b) letting the sky reach its white point (§1.4), and
(c) raising albedo saturation on the render, the pavers and the foliage.

Exposure-independent surface ratios, which is where the individual defects live:

| ratio | reference | render | verdict |
|---|---|---|---|
| conifer foliage / road | **0.27** (ref1), **0.29** (ref4) | **0.59** | trees **2.1× too light** |
| pavement pavers / road | **0.70 / 0.61 / 0.63** (ref1/3/4) | **1.13** | pavers **1.8× too light — the sign is inverted** |
| road under a car / open road | **0.46 / 0.41** (ref1) | **0.99** | **no under-car occlusion at all** |
| porch recess / open render | **0.57** (ref2), **0.39** (ref1) | **0.86** | recess AO is a sixth of what it should be |
| roof pantile / sky | **≈0.50** (ref5) | **0.84** | roof **1.7× too light** |
| window glass / window frame | **0.79** (ref4) | **1.00** | glass and frame are the same value |

---

## Ranked defect list

Ranked by how much fixing it moves the frame toward the photograph.

### 1. The parked cars are untextured wedges. — `nz-street-props.js` — **BLOCKER**

Evidence: `_shots/critic/c-car/street.alley.png` (camera 1.0 m off a car's flank),
`_shots/critic/z-carleft.png` (3× crop of `md/street.westend.png`),
`_shots/critic/md/street.deadend.png`, `_shots/critic/z-undercar.png`.

At one metre the car is **a white truncated pyramid**. Specifically, and every one of
these is visible in `c-car/street.alley.png`:

- **There is no greenhouse.** No windscreen, no side glass, no backlight, no DLO
  aperture of any kind on the white cars — the body is one continuous solid from sill to
  roof. Reference: `ref1` foreground Şahin has a full six-light DLO with a black rubber
  and a bright A-pillar.
- **No wheel arches.** The body sides run straight down to the road with a single hard
  bottom edge. The wheels exist (`c-graze/street.alley.png` shows one from road level)
  but the body's rocker sits so low they are completely occluded at eye height, so from
  a standing camera the car has no wheels.
- **No panel breaks**: no door shutlines, no bonnet/boot gaps, no B-pillar, no swage
  line, no mirrors, no handles, no bumpers, no lights, no plate. The only surface
  feature is a coarse dark speckle band along the lower flank that reads as gravel.
- **No chamfer on any edge** — the roof-to-side fold is a 90° arris (CS2-BRIEF: "a pure
  90° edge is the #1 tell of a prototype").
- **The underside is white.** `c-graze/street.alley.png` looks straight under a car at
  0.34 m: the cavity measures **lum 96.6 against open road 97.3 — ratio 0.99**. The
  reference is 0.46 (`ref1`, under the white Tofaş) and 0.41 (under the blue saloon).
  There is no chassis, no dark cavity, no contact shadow at the tyre (contact patch
  0.93 of open road).
- **They are all the same object in the same white.** `md/street.deadend.png` shows six
  nose-to-tail and they are identical. The brief's explicit anti-goal: "No repeated
  identical … parked car."
- The one exception is the dark saloon (`z-undercar.png`), which does have tail lamps, a
  plate and a boot crease — but its rear panel carries a **high-frequency black granular
  texture that reads as tarmac glued to the car**, and its near-white roof against its
  navy body is a two-tone that exists nowhere in the references.

Nothing in any frame reads as a Tofaş Şahin. The brief calls it "the signature vehicle"
and says there are at least three in the photographs.

**Highest-value fix:** one boxy three-box saloon with a *separate glass material* for a
real DLO, cut wheel arches with the tyre proud of the rocker, a chamfer on every arris,
and a dark under-body plane; then vary body colour, dirt level and parking angle per
instance.

### 2. The street has effectively no ambient occlusion. — `nz-street-sky.js` (`bake()`) + every caller — **BLOCKER**

Evidence: `_shots/critic/c-graze/street.alley.png`, `_shots/critic/md/street.entrance.png`,
`_shots/critic/z-porch.png`, `_shots/critic/c-nwall/street.sky.png`,
`_shots/critic/md/street.north34.png`.

At `low` tier GTAO is off and `NZ.street.bake()` is the only occlusion in frame
(STREET-MODULE-CONTRACT §5.2). It is not delivering:

| cavity | reference ratio | our ratio |
|---|---|---|
| road under a parked car | 0.46 / 0.41 (`ref1`) | **0.99** |
| entrance porch recess vs open render | 0.57 (`ref2`), 0.39 (`ref1`) | **0.86** |
| balcony slab soffit vs wall face | soffits are the darkest facade surface (brief §3.4) | **0.82** |

The çıkma soffit in `c-nwall/street.sky.png` — looking straight up from 1 m off the north
facade — is one of the *lightest* surfaces in the frame. The brief: "Under-slab soffits
are the darkest surfaces on the facade and carry a hard AO contact line where they meet
the wall." There is no contact line anywhere in this street: not wall-to-pavement, not
plinth-to-paver, not handrail-base-to-step, not tyre-to-road, not downpipe-to-render.

This single defect is doing most of the work in §0's 24 % spread deficit, because AO is
where a photograph's dark end comes from.

**Highest-value fix:** `bake()` needs a real cone/hemisphere sweep against the passed
occluders with a near-field term, and the callers need to actually pass their local
boxes — car bodies, balcony slabs, the bay soffit, the porch reveal, the kerb nose.
`nz-street.js` reports `occluders=26` for six blocks with 44 balconies; that is far too
few to produce a soffit line.

### 3. The sky is a flat white card. — `nz-street-sky.js` — **BLOCKER**

Evidence: `_shots/critic/md/street.sky.png` (straight up from the crown, fov 90),
`_shots/critic/c-roof/street.northwall.png`.

Measured over 16,596 clean sky pixels:

- **rgb 212.2, 219.0, 226.0 — lum 219.3, sd 2.71.** sd 2.7 is dither noise. There is
  **no cloud structure of any kind**. `ref1` measures sd 5.0–8.1 *inside a small patch*
  and has visible cloud shapes and one break of pale blue upper-right; `ref4` sd 4.8–6.1.
- **The gradient is 0.9 code values over 45° of dome.** Row means down the frame:
  219.0, 219.4, 219.2, 219.4, 219.3, 219.4, 219.3, 218.5. Cross-check against a second
  camera: sky at ~60° elevation in `c-roof/street.northwall.png` is 221.7 — 2.4 codes
  from zenith. `ref1` falls **240.9 → 203.9 (37 codes)** over a comparable arc; `ref4`
  falls 234.7 → 228.8 with clear modulation.
- **The white point is 12–21 codes too low.** 219 against `ref1` 233–241, `ref2` 240,
  `ref4` 229–236. Combined with §0's p95 deficit, the street has no highlight anchor.
- Colour temperature is *right*: B−R = +13.8 against `ref1` +9.3 and `ref4` +17.8. Keep it.

The module's own `NZ.street.SKY` reports `horizon [1.787,1.795,1.787]` vs
`zenith [0.731,0.870,1.065]` — a 2.4× ratio it clearly intends and is not rendering.
Whatever the visible sky quad is sampling, it is not that ramp.

**Highest-value fix:** put the horizon→zenith ramp on the actual sky quad, add two or
three octaves of very low-contrast fbm cloud (±6 codes is enough), and lift the white
point to ~233.

### 4. The render (sıva) is a flat colour at one metre. — `nz-street.js` — **BLOCKER**

Evidence: `_shots/critic/c-nwall/street.northwall.png` and
`_shots/critic/c-nwall/street.alley.png` (camera 1.0 m off the north facade),
`_shots/critic/z-wallbase.png`.

- **Standard deviation of the wall at 1 m is 6.53.** The same surface in the photographs
  measures **sd 14.8 (ref1 cream), 19.6 (ref2 butter), 25.5–30.0 (ref3/ref5)** — two and
  a half to five times more albedo variation than we have.
- The only feature on it is a **faint pale-grey worley crack web** at a fixed world
  scale. It is the same web everywhere. There is no float texture, no aggregate, no
  trowel direction, no patch repair, no colour drift.
- **No weather streaks.** The brief ranks "weather streaks below every sill, balcony nose
  and gutter joint" as the **#1** believability item and "ground-line soiling — the first
  1.0–1.5 m of every wall is dirtier, splashed and greener" as **#2**. Neither exists on
  any of the six blocks. `ref1`'s cream block has a black algal streak under every sill.
- The same texture at 0.5 m (`c-door/street.alley.png`, the entrance reveal) reads as
  **cracked dried mud** — high-contrast black crack lines at ~5 cm. So the crack network
  has no scale discipline: invisible at 1 m, violent at 0.5 m.

This is non-negotiable #10 ("Everything must be believable at 2 m … no untextured flats")
failing outright, on the surface that covers the largest area of every frame.

### 5. The conifers are 2.1× too light and the wrong green. — `nz-street-props.js` — **MAJOR**

Evidence: `_shots/critic/md/street.westend.png`, `_shots/critic/z-conifer.png`,
`_shots/critic/c-nwall/street.sky.png`.

- Masked foliage in the money shot: **rgb 74, 88, 79 — lum 84.1**.
  `ref1`: **26, 35, 22 — lum 31.9**. `ref4`: **37, 45, 32 — lum 42.1**.
  Against the road in the same frame: **ours 0.59, reference 0.27–0.29.**
- The **hue is wrong as well as the value**: our foliage has B−R = **+5** (a cool sage /
  mint); both references have B−R = **−4 to −5** (a warm-dark blue-green with red above
  blue). "Almost frosted grey-green" is exactly what the numbers say.
- The fronds are **flat alpha cards with hard cut edges**, drawn as long triangular
  spikes with no sub-branching and no soft silhouette (`z-conifer.png`, `z-balcony.png`).
  They are simultaneously too light against the facades and near-black against the sky,
  which is what an unlit cutout does.
- **Trunks are smooth pale cylinders** with a low-contrast mottle and no bark relief, and
  they are fully visible through the canopy because it is too sparse.

Reference: `ref1` and `ref4` show these as the strongest vertical elements on the street
after the buildings, dense enough to read as solid mass, and darker than anything else in
frame except the shadowed recesses.

### 6. The pavement is brighter than the road. The sign is inverted. — `nz-street-ground.js` — **MAJOR**

Evidence: `_shots/critic/md/street.kerb.png`, `_shots/critic/md/street.alley.png`.

- Our pavers: **rgb 161.7, 163.1, 164.0 — lum 162.8, saturation 0.014** (achromatic).
- Reference pavers: `ref1` **87, 83, 72 — lum 82.9, sat 0.175, sd 33.7**.
- **pavers ÷ road: reference 0.70 / 0.61 / 0.63; ours 1.13.** In every photograph the
  interlocking concrete blocks are markedly *darker* than the asphalt; in our street they
  are brighter than it.
- Saturation 0.014 means there is **no block-to-block colour variation at all**. The
  brief: "colour varying block to block from warm grey to cool grey with the odd red
  one", and `ref1`'s sd of 33.7 across a paver run is mostly that variation.

**Highest-value fix:** drop paver albedo by ~40 %, warm it, and give each block a random
tint offset of ±8 % with an occasional red one.

### 7. The road loses all texture where the player actually looks at it, and shows a triangle seam. — `nz-street-ground.js` — **MAJOR**

Evidence: `_shots/critic/c-graze/street.westend.png`, `_shots/critic/z-graze.png`
(camera 0.34 m above the crown, looking east — the grazing case).

- Texture variation **falls** with proximity, which is backwards:

  | distance from camera | sd |
  |---|---|
  | 0.3 – 0.8 m | **6.84** |
  | ~1.5 m | 10.93 |
  | ~4 m | 10.63 |
  | ~8 m | **31.25** |

  The nearest 0.8 m of asphalt — the metre in front of the player's feet, permanently in
  frame — is a **flat grey plane**. That is mip collapse at grazing incidence:
  `anisotropy` is not being set on the road maps.
- **A hard triangle seam** runs diagonally across the near road. Sampling one raster row
  across it: 142.7 → 128.0 over 20 px, a **14.7-code step at a straight edge**. That is
  the vertex bake being interpolated per-triangle with no smoothing across the shared
  edge — the road's tessellation is visible.
- The trench-reinstatement patches have **hard un-feathered rectangular boundaries** with
  no tar-sealed ragged edge (brief §2: "darker rectangular trench reinstatements with
  ragged tar-sealed edges").

What is right: the camber, the tar seams, the polished centre strip and the damp sheen
all read correctly at 4–20 m. This is purely a near-field problem.

### 8. Overhead wires read as strings of beads. — `nz-street-props.js` — **MAJOR**

Evidence: `_shots/critic/z-wires.png` (2× crop of `md/street.north34.png`),
`_shots/critic/md/street.sky.png`, `_shots/critic/z-gantry.png`.

- The cables are **thick, lumpy, alternating black-and-white chains**. They read as
  barbed wire or a rope of beads, not as cable: the tube's segment count is low enough
  that each segment's lighting flips, and the diameter is several times too large for
  the distance.
- **There are far too many of them and they radiate**. In `md/street.sky.png` and
  `md/street.north34.png` the sky is a starburst lattice. `ref5` — the reference the
  brief cites for wires — has perhaps eight cables, roughly parallel, sagging in
  catenaries between two poles.
- Some pass **in front of and through** facade geometry.
- This is also the answer to "something orange/red and gantry-like sits high at frame
  centre" in `_shots/final2/westend.png`: `z-gantry.png` resolves it as **the far block's
  roof pantile band seen almost edge-on** (a flat orange strip whose ripple reads as a
  lattice) with the wire tangle crossing in front of it. See §9 for why the tiles are
  that colour.

### 9. The roof pantiles render 2.1× brighter than their own albedo. — `nz-street.js` — **MAJOR**

Evidence: `_shots/critic/c-roof/street.northwall.png` (camera at eaves height),
`_shots/critic/z-roof.png`.

- The module's own texture report: `set rooftile 128px rgb 136,69,48 lum 87 sat 0.645` —
  a correct dark red-brown.
- **Rendered, the same tiles measure rgb 208.3, 177.7, 162.1 — lum 183.1, sat 0.22.**
  That is 2.1× the albedo's luminance and a third of its saturation.
- Reference: `ref5` tile roof **122, 118, 105 — lum 118**. Ours is **55 % brighter**, and
  against the sky in the same frame: ours 0.84, reference ≈0.50.
- Cause is almost certainly the up-facing bake: the contract calibrates "an up-facing
  white surface receives 2.00, a vertical one about 1.30". A 25–30° pitch is getting
  close to the full 2.00 with nothing to hold it down. Per the contract's own rule —
  "If your surface comes out hot, lower the albedo, not the light" — the tile albedo
  needs to come down to roughly half.
- No tile-to-tile colour variation, no lichen, no slipped tiles.

What is right in the same crop: the gutter with visible brackets, the dark soffit with
**rafter ends**, and the satellite dishes. Those are good and should not be touched.

### 10. Daylight leaks into the night half at the alley mouth as a hard-edged quad. — `nz-street-sky.js` / `nz-street.js` — **MAJOR**

Evidence: `_shots/critic/md/street.alley.png` and its 3× crop
`_shots/critic/z-alleyleak.png`; `_shots/critic/c-alleyN/street.sky.png`.

- Standing in the roadway looking north into the covered passage, a **crisp pale
  blue-white rectangle floats above the alley's interior back wall**, inside the night
  half of the level. Measured **lum 124.7 against the night wall at 72.3** — a 1.7× step
  with a hard straight boundary. It reads as a hole in the roof.
- This is precisely the hole STREET-MODULE-CONTRACT §5 warned about: "above the alley
  mouth (`x ∈ [176,188]`) … the facade stops at `y = 52` with open air behind and the
  night dome shows through", which FACADE was asked to close with a roof mass at
  `z < 156, y ∈ [52,64]`. It is not closed, and the sky module's fade strip is what is
  showing.
- The transition itself is a **hard cut**: from inside the mouth (`c-alleyN/street.sky.png`)
  the night ceiling measures **rgb 58.7, 51.5, 42.8** (warm, amber-lit) and the daylight
  patch immediately beyond measures **rgb 77.8, 85.1, 90.4** (cool) with no intermediate
  band. There is no daylight spill onto the alley floor and no falloff.

### 11. Windows: the glass is the same value as its frame, and has no depth. — `nz-street.js` — **MAJOR**

Evidence: `_shots/critic/c-swall/street.southwall.png` (1 m off the south facade),
`_shots/critic/ab-noprops-s/street.southwall.png`, `_shots/critic/z-glass.png`.

- **glass ÷ frame = 1.00** (glass lum 166.9, frame lum 167.4). `ref4` measures **0.79**
  (glass 125.9, frame 159.5). The brief: "Glass: reads dark grey-blue, low reflectivity
  under overcast." At 1 m the window is one flat pale panel with white lines on it.
- The glass is a **flat blue-grey gradient with no reflection, no interior, no curtain,
  no dirt**. The brief asks for net curtains in about a third, closed curtains or a
  rolled blind in others, and interior clutter in some.
- **The frame has no section.** A 70 mm PVC frame has a face, a rebate and a glazing
  bead; ours is a flat ribbon with no depth, no opening light, no handle, no transom.
- **The frame texture reads as corrosion.** `set pvc 128px rgb 229,228,223 relief 0.15mm`
  renders at 1 m as a heavy pitted speckle (`z-glass.png`) that looks like weathered bone.
- **No reveal.** The whole assembly sits flush in the wall plane; there is no jamb, no
  head shadow, and no projecting sill — and therefore no origin for the weather streak
  the brief asks for under every sill.
- Ground-floor **grilles are present and correct** (`md/street.alley.png`) — keep those.

### 12. Enclosed balconies are opaque louvres, identical in every bay. — `nz-street.js` — **MAJOR**

Evidence: `_shots/critic/z-balcony.png`, `_shots/critic/c-roof/street.northwall.png`,
`_shots/critic/md/street.north34.png`.

- The glazing is **opaque**. glazing ÷ wall = 1.02 — it is the same value as the render
  behind it, so the balcony reads as a filled-in wall panel with white stripes on it, not
  as glass. In `ref1` and `ref4` roughly half the glazed bays show a dark interior through
  the glass and the other half a sky reflection; the variance between bays is the point.
- Every bay on a facade uses **the same white, the same pane count and the same
  division**. The brief: "**They are not uniform** … Randomise per flat — a facade where
  every balcony matches instantly looks CG", and lists the variants (never glazed, half
  glazed, bronze-tinted, curtain inside, washing line, dish on the parapet).
- The **white precast balustrades where a balcony was left open are good** and are the
  one place the facade currently shows real variation. There should be more of them.

### 13. The travertine plinth is a flat beige tile band running the full 24 m. — `nz-street.js` — **MAJOR**

Evidence: `_shots/critic/ab-noprops/street.westend.png` (props off — the band is still
there, so it is FACADE's, not PROPS' or GROUND's), `_shots/critic/z-wallbase.png`,
`_shots/critic/c-nwall/street.alley.png`.

This is the "untextured white mass" in the original note, and the A/B pins it on
`nz-street.js`.

- At 1 m: **sd 11.0**, one flat beige (`set travertine rgb 205,195,176`), joints as thin
  darker lines, **no veining, no tile-to-tile colour variation, no chipping, no dirt in
  the joint**, and the same 300×600 grid unbroken along both facades for the whole street.
- Reference `ref1` right-hand block: warm beige travertine to ~1.6 m with obvious stone
  figure, tile-to-tile value steps and a chipped corner at bumper height. `ref2` uses
  wire-cut tan brick instead. The brief asks for **all three** plinth variants across the
  street; we appear to run travertine almost everywhere (`pile nzstreet-brick tris 44`
  against `nzstreet-travertine tris 44` — so brick is used once).
- **No splash zone, no ground-line soiling, no weeds at the base** where the plinth meets
  the pavers.

### 14. The shop fascia lettering is mirrored. — `nz-street-props.js` — **MAJOR (cheap)**

Evidence: `_shots/critic/z-sign.png` (4× crop of `c-swall/street.southwall.png`);
attribution confirmed by `_shots/critic/ab-noprops-s/street.southwall.png`, where the
fascia disappears with `?nzprops=0`.

The teal shop fascia on the south facade renders its text **mirror-imaged and
right-to-left**. Either the quad's winding/UV is flipped, or the text is being drawn on
the back face. It is unmissable at any range on that side of the street. The block-name
lettering on the facades is *not* affected — `ÖZGURKENT B-BLOK`, `ÇINARKENT A-BLOK` and
`AKŞEHİRKENT C-BLOK` all read left-to-right with a correctly formed Ş cedilla
(`md/street.entrance.png`, `z-letter1.png`, `z-letter2.png`), which is a genuine win.
(The dotted `İ` is not resolvable at the range I could shoot it from; worth one close
check while you are in there.)

### 15. The porch handrails are a thicket. — `nz-street-entrance.js` — **MINOR**

Evidence: `_shots/critic/z-porch.png` (3× crop of `md/street.entrance.png`).

Three or four separate maroon rail runs overlap and cross in front of the steps at
inconsistent angles, one of them passing across the tread line. The brief asks for a
handrail **each side**, 40 mm tube, simple bent verticals. Also: the treads and risers are
both plain white with **no darker nosing strip** (brief: "tiled treads — grey or beige
ceramic with a darker nosing strip"), the base plates have no rust bleed and no contact
shadow, and the porch is not in shadow (§2).

### 16. Downpipes and pilasters read as speckled stone. — `nz-street.js` — **MINOR**

Evidence: `_shots/critic/z-wallbase.png`, `_shots/critic/z-balcony.png`,
`_shots/critic/c-roof/street.northwall.png`.

The full-height downpipes and the vertical strips between bays carry a coarse grey
speckle that reads as granite or concrete, not painted metal or grey PVC. They have no
brackets except two white blobs that read as lumps of snow, at least one terminates in
mid-air without meeting a gully, and none of them casts a contact line on the render.

### 17. The entrance's wall material does not match the facade's at the seam. — `nz-street-entrance.js` — **MINOR**

Evidence: `_shots/critic/c-door/street.alley.png` (0.7 m from the door) against
`_shots/critic/c-nwall/street.alley.png` (1.0 m from the same facade plane, 12 m west).

At the recess the render is a violent black-cracked mud; twelve metres along the same
wall it is an almost invisible pale web. Whichever of the two is right, a player walking
from one to the other crosses a material change on a continuous painted wall.

### 18. Utility poles lean at random angles. — `nz-street-props.js` — **MINOR**

Evidence: `_shots/critic/c-car/street.alley.png`, `_shots/critic/md/street.alley.png` —
grey poles crossing the frame at ~20° off vertical. They read as fallen or as stray
geometry rather than as raked poles.

### 19. Roof furniture is under-specified. — `nz-street.js` — **POLISH**

`c-roof/street.northwall.png`: the water tank is a plain grey box that reads as an
air-conditioning condenser; the brief asks for **white polyethylene** tanks. No chimney
stacks with cowls and no aerial forest are visible on the north block from eaves height.

### 20. The kerb has no joints. — `nz-street-ground.js` — **POLISH**

`md/street.kerb.png`, `z-graze.png`: the kerb runs as a continuous extrusion. The brief
asks for precast units "laid in 1.0 m lengths with visible joints, chipped at the corners,
often mounted by cars". `ref1` measures the kerb+gutter at sd 4.9 — it is a quiet
surface, but the joint rhythm is what gives the street its scale.

---

## Per module

### `nz-street-sky.js`

**Right:** the colour temperature of the light is correct (sky B−R = +13.8 against
reference +9.3 to +17.8, and nothing in frame has a warm cast). There is **no hard
directional shadow anywhere in any of the 48 frames in `_shots/critic/`** — the brief's
single loudest anti-goal is respected. Mean frame luminance lands within 1 code of `ref1`.
`NZ.street` installs cleanly, publishes a sane `SKY` block, and the `day()`/`bake()`
contract is being honoured by all four consumers.

**Wrong:** the sky quad is a constant (0.9 codes of gradient over 45°, sd 2.71, no cloud);
its white point is 12–21 codes low; `bake()` produces almost no occlusion (under-car
ratio 0.99 against a reference 0.41–0.46) and that alone accounts for most of the 24 %
tonal-spread deficit; the daylight fade strip is visible from inside the night alley.

**Single highest-value change:** make `bake()` produce real cavity occlusion. It is the
only shading cue at `low` and it is currently flat.

### `nz-street-ground.js`

**Right:** this is the best-observed module in the set. Camber, crown, the polished
centre strip, tar seams, trench patches, the damp sheen and the gutter darkening all read
correctly at 4–20 m, and the A/B (`ab-noground/street.westend.png`) shows how much of the
street's credibility it is carrying — with it off, the frame collapses to bright grey.
Road mid-distance measures lum 143.7 against `ref3` 147.3 and `ref4` 143.3: a direct hit.

**Wrong:** the pavers are 1.8× too light relative to the road and completely achromatic;
the near road loses all texture at grazing incidence (sd 6.84 at 0.5 m against 31.25 at
8 m); a triangle seam is visible in the vertex bake; patch edges are hard rectangles.

**Single highest-value change:** darken and warm the pavers, and give them per-block
colour variation. It is a two-line albedo change that fixes an inverted tonal
relationship across a quarter of every frame.

### `nz-street.js`

**Right:** the massing is correct and it is the thing that makes the street read as
Turkish at all — five storeys, the çıkma projection with a returning soffit, the storey
rhythm, and a genuinely good palette (salmon, cream, mint, ice blue) chosen straight off
the photographs. The name lettering works, including the Turkish glyphs, and it is
convincingly faded and skewed. Ground-floor window grilles, the brick alley portal, the
eaves with rafter ends and gutter brackets, and the open balconies with precast
balustrades are all brief-compliant and good.

**Wrong:** the render at 1 m carries sd 6.5 against a reference 15–36 and has no weather
streaking and no ground-line soiling — the brief's #1 and #2 believability items; the
travertine plinth is a flat band for 24 m; window glass is the same value as its frame
and has no reveal or sill; balcony glazing is opaque and identical in every bay; the roof
tiles render 2.1× their own albedo; the alley-mouth roof mass the contract asked for is
missing.

**Single highest-value change:** put grime on the render — a per-facade streak/soil mask
driven off sill and balcony-nose positions plus a 1.5 m ground-line gradient. It raises
albedo variance and lowers the pale end at the same time, and it is the difference the
brief itself ranks first.

### `nz-street-entrance.js`

**Right:** the best-realised object in the street and the only place that survives a 0.7 m
camera. `c-door/street.alley.png` shows a bronze-anodised glazed door with a real
horizontal push bar and a brass lever, glass you can actually see the foyer through, a
numbered letterbox bank, an electricity meter box, a yellow gas riser with its cabinet, a
canopy, and four tiled steps with handrails. The foyer behind it (`c-foyer/street.alley.png`)
is coherent and correctly stays on the night side. `door=reskinned … slideDir 8.04
preserved` in the diag means it did the hard thing without breaking the level.

**Wrong:** the recess is not in shadow (0.86 of the open wall against a reference 0.57);
the handrails tangle; the treads have no nosing; the wall material does not match the
facade's at the seam; the canopy soffit is lighter than the wall under it.

**Single highest-value change:** darken the recess. A porch that is the same value as the
sunlit wall beside it cannot read as a porch, and this one is the destination of the
whole street.

### `nz-street-props.js`

*Caveat: this file moved four times during the pass; some of this may already be fixed.*

**Right:** the dressing inventory is genuinely rich and much of it is exactly what the
brief asked for — the flaking maroon garden wall with its steel railing
(`md/street.kerb.png`) is close to `ref1`'s, there is a **carpet thrown over a garden
wall** and weeds at the wall base (`c-car/street.alley.png`), satellite dishes at the roof
edge, cobra-head lamps, wheelie bins, and bare deciduous trees whose thin irregular
branching reads correctly for early spring.

**Wrong:** the cars are the worst thing in the level by a distance, and both establishing
frames are full of them; the conifers are 2.1× too light and the wrong hue; the wires
are beaded chains in a starburst; the shop fascia is mirrored; poles lean.

**Single highest-value change:** rebuild one car properly. Cars occupy roughly a quarter
of the lower half of both establishing shots and currently read as concrete barriers.

---

## If you only fix five things

1. **Give the cars a greenhouse, wheel arches and a dark underside.** — `nz-street-props.js`
   (defect 1). Biggest single area of the money shot, currently unrecognisable as vehicles.
2. **Make `bake()` produce real occlusion, and pass it real occluders.** —
   `nz-street-sky.js` + all callers (defect 2). Restores the dark end that the 24 %
   spread deficit is missing, and fixes the porch, the soffits and the under-car patch
   in one change.
3. **Darken the conifers to lum ≈ 40 and shift the hue warm-blue-green.** —
   `nz-street-props.js` (defect 5). rgb 26,35,22 not 74,88,79. Two constants, and they
   are the strongest verticals in the street.
4. **Put a gradient and cloud on the sky and lift its white point to ~233.** —
   `nz-street-sky.js` (defect 3). The reference sky has 6–37 codes of ramp; ours has 0.9.
5. **Grime the render and darken the pavers.** — `nz-street.js` + `nz-street-ground.js`
   (defects 4, 6). Weather streaks below every sill and balcony nose, a 1.5 m ground-line
   soil gradient, and pavers at 0.65 of the road instead of 1.13.
