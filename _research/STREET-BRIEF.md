# STREET BRIEF — 233. Sokak, Seydişehir / Konya

**Authored by the orchestrator directly off the five reference photographs.**
Reference images live in `_ref/`:

| file | what it shows |
|---|---|
| `ref1-street-canyon.png` | the money shot: A-BLOK on the left, B-BLOK on the right, looking north up the canyon |
| `ref2-corner-junction.png` | same street from the junction, tight on the pink block's brick plinth and gas riser |
| `ref3-canyon-wide.png`   | wider framing, road sign, bare deciduous tree, the road's slight rise |
| `ref4-canyon-clean.png`  | cleanest read of both facades and the conifer line |
| `ref5-open-junction.png` | 232. Sk. — the open junction: older houses, tile roofs, overhead wires, snow-dusted hills |

**Every agent working on this street must open these five files and look at them.**
Nothing below replaces looking. This document is the checklist, not the source.

---

## 0. The one-sentence description

A narrow 1990s Turkish provincial residential street: two facing rows of five-storey
reinforced-concrete apartment blocks in chalky painted render — salmon pink on one
side, cream on the other — every original balcony retrofitted with white PVC glazing,
low painted garden walls with steel railings at the pavement line, dark spruce planted
tight against the facades, worn patched asphalt with no lane markings, elderly white
Tofaş saloons parked nose-to-tail on both kerbs, and a flat white overcast sky that
casts no shadow at all.

---

## 1. Light and atmosphere — get this right first

This is the single biggest determinant of whether the street reads as the photograph.

- **Sky:** flat, blown-out, near-white. Luminance gradient is *inverted* from a clear
  day: brightest near the horizon-ish middle, very slightly cooler and darker at
  zenith. In `ref1` there is one weak break of pale blue upper-right. No sun disc.
  No visible cloud shapes — just a luminous ceiling.
- **Shadows:** effectively none. Soft ambient occlusion only, darkest in the balcony
  reveals, under the eaves, under parked cars, at the wall/pavement junction, and
  inside the entrance porches. **Any hard directional shadow kills the shot.**
- **Colour of the light:** cool, slightly blue-grey (≈6500–7000 K), extremely low
  contrast. Whites in the scene sit around 200–215/255, never clipped. The road
  reads as a mid-grey ~95–120/255.
- **Damp, not wet:** the asphalt in `ref1`/`ref3` is faintly damp — a slightly
  lowered roughness and a very weak sky reflection along the wheel tracks, plus
  darker patches where water sits at the kerb. It is not a mirror. Existing
  `street` material already sits at `wet: 0.28`, which is close to right.
- **Air:** almost no aerial perspective within the street itself (it is only ~90 m
  long). The distant hills in `ref5` are heavily washed to a pale blue-grey.
- **Season:** early spring. Deciduous trees are **bare or barely budding**;
  conifers are full and very dark. Grass is patchy and dull. This is important —
  summer foliage would immediately read as a different place.

---

## 2. Street section (the cross-section, kerb to kerb)

Measured off the photos against the parked cars (a Tofaş Şahin is 4.26 m long,
1.65 m wide; a Skoda Octavia is 4.66 × 1.81 m).

```
  facade   garden   low wall   pavement    kerb   ROADWAY   kerb  pavement  low wall  facade
   line     strip   + railing    2.0 m     0.15    7.0 m    0.15    1.8 m    + rail    line
    |<-- 1.5-3.0 -->|            |          |       |        |       |         |        |
```

- **Roadway: ~7.0 m** kerb to kerb. Two cars can pass only just; with both kerbs
  parked, it is effectively single-lane. No centre line, no edge line, no markings
  of any kind.
- **Crown:** the road is cambered — highest along the centre, falling ~80 mm to
  each kerb. Water and grime collect in the gutter line.
- **Longitudinal grade:** the street climbs gently away from the camera in `ref1`
  and `ref3` — perhaps 2–3 %. Worth reproducing if cheap; it is what makes the far
  end of the canyon sit *higher* in frame than the near end.
- **Pavement: 1.8–2.2 m**, and often *interrupted* — in `ref1` the left pavement is
  swallowed by a garden and the pedestrian route runs in the gutter. Do not build
  two clean continuous pavements; the charm is in the interruptions.
- **Kerb:** precast concrete, ~150 mm exposed face, ~300 mm wide top, laid in
  1.0 m lengths with visible joints, chipped at the corners, often mounted by cars.

### Road surface

- Worn asphalt, mid-grey, **heavily patched**. At least three visible generations:
  the base course, darker rectangular trench reinstatements (utility cuts) with
  ragged tar-sealed edges, and long snaking tar seam repairs 60–100 mm wide.
- Aggregate is visible — this is not a smooth new wearing course. Roughness varies
  by patch age: new patches darker and smoother, old ones pale and coarse.
- A pale, almost white worn strip runs down the centre where tyres have polished it
  (clearly visible in `ref1` mid-road).
- Manhole covers, a couple of gully gratings at the kerb, and a water valve cover.
- No painted markings anywhere.

### Pavement surface

- Grey **interlocking concrete pavers** ("kilit taşı") — the standard Turkish
  double-T / I-shape block, ~200 × 165 mm, laid in a herringbone or stretcher bond,
  slightly uneven, some sunken, colour varying block to block from warm grey to
  cool grey with the odd red one.
- Occasional stretches of plain cast concrete with expansion joints instead.
- Where a garden gate meets the pavement there is usually a dropped kerb and a
  crossover of the same pavers laid across the gutter.

---

## 3. The buildings — the vocabulary

Every block on this street is the same building type in different paint. Build one
good parametric block and vary it; do not model five bespoke buildings.

### 3.1 Massing

- **Five storeys**: ground floor + 4. Floor-to-floor **2.90 m**; total facade height
  to eaves ≈ **14.8 m**, plus roof.
- Footprint: long slabs parallel to the street, 22–34 m long, 11–13 m deep.
- **The projecting bay ("çıkma")**: from the first floor upward the facade steps
  out ~1.0–1.3 m over the pavement, cantilevered, with a **sloped or stepped
  soffit** returning to the ground-floor wall plane. This overhang is the single
  most recognisable feature of the type and it must be there.
- Blocks butt against each other or leave a 1.5–3 m slot; the slot is always
  fenced off and full of weeds and a gas riser.

### 3.2 Facade construction and finish

- RC frame with hollow-brick infill, **cement render (sıva)** floated smooth-ish and
  painted. The paint is chalky, matte, and **unevenly weathered**: darker vertical
  streaks below every window sill and balcony nose, general soiling in the first
  1.5 m above the pavement, algal green-black in the shaded north-facing corners,
  and patchy fading where the sun does hit.
- **Palette** (sample straight from the photos):
  - salmon / dusty rose `#c98f8b`–`#d8a09a` (B-BLOK, right side of ref1/ref3/ref4)
  - cream / oatmeal `#ddd3bd`–`#e8dfcc` (A-BLOK, left side)
  - pale butter yellow `#e6dfc0` (ref2 left)
  - mint / sage green `#b9c8b4` (ref5)
  - pale ice blue `#c6d4d8` (ref5)
  - trim, frames, balustrades: off-white `#eae7e0`
- **Horizontal banding**: a shallow render band or a change of tone marks each floor
  line on some blocks; on others a 300 mm painted stripe runs at first-floor level.
- **Ground-floor plinth** — three variants seen, use all three:
  1. **Travertine / limestone tile cladding**, warm beige, 300 × 600 mm, running to
     ~1.6 m (the right-hand block in `ref1`).
  2. **Rough tan brick cladding**, wire-cut, laid stretcher bond (`ref2` right).
  3. Painted render in a darker tone of the body colour, with a splash-back band.
- **Corners**: no quoins, but a crisp arris; render is often chipped away at the
  corner at car-bumper height showing grey mortar.

### 3.3 Windows

- Openings ~1.4 m wide × 1.5 m tall, arranged in a regular vertical grid with 2.5–3.5 m
  between centres. Some blocks show a paired window + balcony rhythm.
- **White PVC frames**, chunky (70 mm sections), two-sash with a fixed transom on
  larger openings. A minority of older **brown-stained timber** or **aluminium**
  frames survive — vary them, uniformity is the tell.
- **Sills**: a projecting render sill with a drip, or a white marble sill slab,
  30–40 mm proud. Every sill is the origin of a dark weather streak below it.
- Glass: reads dark grey-blue, low reflectivity under overcast, with net curtains
  visible in perhaps a third of the windows, and closed curtains or a rolled blind
  in others. Some windows show interior clutter, plants, a laundry rack.
- **Bars/grilles** on ground-floor windows only — plain vertical steel rods or a
  simple decorative pattern, painted white or dark green.

### 3.4 The enclosed balconies — the defining detail

This is what makes it Turkish rather than generic Eastern European.

- The original balcony is a **cantilevered RC slab** 1.2–1.5 m deep with a solid
  parapet 1.0 m high, the parapet either plain rendered or an **openwork balustrade**
  of white-painted precast or turned members.
- Almost every one has since been **glazed in** by the owner: a white PVC or
  aluminium frame filling the space from parapet top to slab soffit, divided into
  **4–6 vertical panes**, most of them sliding, with the frames left in a slightly
  different white from the balustrade.
- **They are not uniform.** Some flats never glazed theirs; some glazed only half;
  some used bronze-tinted glass; some hung a curtain inside; one or two have a
  washing line or a satellite dish bolted to the parapet. **Randomise per flat** —
  a facade where every balcony matches instantly looks CG.
- Under-slab soffits are the darkest surfaces on the facade and carry a hard AO
  contact line where they meet the wall.

### 3.5 Roof

- Shallow-to-medium **hipped roof**, 25–30°, **red-brown concrete pantiles** with a
  strong horizontal ripple, faded and lichened, with a few slipped tiles.
- **Overhanging eaves 500–700 mm** with a painted white or bare timber soffit and
  visible rafter ends; a half-round gutter and a downpipe at each end running the
  full height of the facade.
- On the roof: white **polyethylene water tanks**, occasional solar thermal panels
  with their cylinder, brick or render **chimney stacks** with a metal cowl, and
  a forest of **TV aerials and small satellite dishes**.

### 3.6 The name lettering

- Each block carries its name on the facade in **red block capitals**, mounted at
  first-floor level or just above the entrance: `SEYDİKENT A-BLOK`, `SEYDİKENT B-BLOK`.
- Letters are ~350–450 mm tall, plain grotesque capitals, either painted directly
  on the render or individual cast/cut letters standing 20 mm proud. Slightly
  faded, imperfectly aligned. Turkish characters (`İ`, `Ş`, `Ğ`, `Ü`, `Ö`, `Ç`) must
  render correctly.
- Reuse the naming convention but **do not copy the exact name** — use plausible
  invented block names in the same pattern.

### 3.7 Entrance — the destination of this street

The street terminates at a building entrance and this is the set-piece.

- A **recessed porch** in the facade plane, 2.2–2.8 m wide, one storey tall, often
  under the projecting bay above so it is already in shadow.
- **3–6 concrete steps** up from pavement level (ground floor sits 0.6–1.1 m above
  the pavement because of the semi-basement), with **tiled treads** — grey or beige
  ceramic with a darker nosing strip — and chipped edges.
- **Steel handrails** both sides, 40 mm tube, painted (white, or the same maroon as
  the garden wall), with simple bent verticals, rust bleeding at the welds and at
  the base plate.
- A **glazed aluminium or steel door**, single or double leaf, with a large fixed
  glass panel, a horizontal push bar, and a fanlight above. Frame anodised bronze
  or painted dark green.
- To one side: the **intercom / buzzer panel** (a small brushed-metal plate with a
  column of buttons and name cards), a **letterbox bank**, a bell push, and the
  building's **number plaque**.
- Above: a small flat **canopy** or a projecting slab, sometimes with a single
  bulkhead light.
- Around the door: the **yellow natural-gas riser** with its meter cabinet, the
  electricity meter box, a bundle of telecom cable stapled to the render, and a
  water stopcock cover in the paving.

---

## 4. Garden strips, walls and railings

Between facade and pavement there is nearly always a strip 1.5–3.0 m deep:

- **Low wall**, 400–700 mm, rendered concrete, painted — in `ref1` a strong
  **maroon/oxide red with the paint flaking off in big patches** to show white
  render beneath, which is a beautiful and very specific texture. Elsewhere plain
  white or the building's body colour.
- On top, a **steel railing** 700–900 mm: plain verticals with a top and bottom
  rail, or a simple decorative scroll, painted **white, dark green, or the same
  oxide red**, with rust at the joints and missing paint on the top rail.
- Some walls carry a run of **white precast balusters** instead (visible in `ref1`
  left, next to the porch stair).
- A **pedestrian gate** of the same railing, usually ajar or missing.
- Inside: bare earth, gravel, weeds, patchy grass, a rose bush cut back for winter,
  a plastic chair, stacked firewood, a coiled hose, an old carpet over the wall.

---

## 5. Planting

- **Dark spruce / cedar**, 6–12 m, planted very close to the facade — often close
  enough to touch it — with the lower branches removed or dead. Very dark
  blue-green, dense, conical. These are the strongest vertical elements on the
  street after the buildings.
- **Bare deciduous trees** — fruit trees, poplars, planes — 4–8 m, only buds. Thin
  irregular branching, pale grey-brown bark.
- One or two show the **first white blossom** (`ref3` mid-distance).
- Ivy or a grape vine on a garden wall.
- Weeds at every wall base and in every pavement joint.

---

## 6. Vehicles

Parked nose-to-tail along both kerbs, some half on the pavement, one or two badly
angled. Nothing exotic; everything a bit dirty.

| type | notes |
|---|---|
| **Tofaş Şahin / Kartal** | the boxy Fiat-131-derived saloon and its estate. **White.** Square everything, chrome-ish bumpers, small wheels, faded paint, plastic wheel trims missing. There are at least three in these photos and they are the signature vehicle. |
| **Renault 12 Toros** | equally boxy, equally white, equally common |
| dark blue mid-size saloon | `ref1` right foreground — Renault Laguna era, rounded 90s |
| white Skoda Octavia | `ref1` right — modern, clean |
| black Toyota compact MPV | `ref2` — Corolla Verso shape |
| white/silver small hatchbacks | Fiat, Renault Clio, Hyundai i20 |
| white Nissan Qashqai | `ref5`, moving |
| small white panel van | Fiat Doblo / Ford Transit Connect |

Cars must be **dirty**: road film up the lower body, salt/dust haze on the glass,
dull clear-coat on the older ones, tyre sidewalls grey not black. Under each car
there is a hard dark AO patch and the tarmac is a shade cleaner.

---

## 7. Street furniture and services

- **Street lamps**: 8–10 m galvanised steel pole with a single curved arm and a grey
  **cobra-head** luminaire, on the pavement at the kerb line, roughly every 30 m,
  alternating sides. Off — it is daytime. A second type appears as a **bracket lamp
  fixed to the facade** on the narrower stretches.
- **Overhead wires**: bundles of electricity and telecom cable sagging between
  poles and clipped to facades, crossing the street diagonally. In `ref5` they are
  everywhere and they matter — a Turkish street with clean skies overhead is wrong.
- **Concrete/wooden utility poles** with a transformer box or a junction cabinet.
- **Wall-mounted services**: yellow gas riser + meter cabinet on nearly every
  facade, grey electricity meter boxes, a cluster of water pipes, drain downpipes.
- **Satellite dishes**: dozens, on balcony parapets and roof edges, mostly small
  white/grey offset dishes at similar azimuth.
- **Signage**: a small blue-and-white street name plate (`233. SK.`) on a corner
  wall; a red banner with the white crescent-and-star (`ref5`); a modest shop
  fascia or two at ground-floor level with a roller shutter, an awning frame, and
  an A-board on the pavement; a *no parking* sign on a pole.
- **Bins**: a galvanised or green plastic wheelie bin at a wall, a small pile of
  bagged rubbish.

---

## 8. Grime and story pass — what makes it real

Ranked by how much each contributes to believability:

1. **Weather streaks** below every sill, balcony nose, and gutter joint.
2. **Ground-line soiling** — the first 1.0–1.5 m of every wall is dirtier, splashed,
   and greener than the rest.
3. **Flaking paint** on the garden walls and railings, with the substrate showing.
4. **Asphalt patching** — trench reinstatements and tar seams.
5. **Rust** at every steel base plate, weld, and fixing, bleeding down onto render.
6. **Irregularity** — no two balconies, curtains, frames or paint fades identical.
7. **Human traces** — a carpet over a railing, laundry on a balcony, a bike, a
   child's toy, a stack of firewood, a satellite dish at a rakish angle.
8. **Vegetation in the cracks** at every wall base and paving joint.

---

## 9. Explicit anti-goals

- No hard sun, no cast shadows, no golden hour, no lens flare.
- No lane markings, no crosswalks, no bike lanes, no modern street furniture.
- No Western/American signage, no English shopfronts, no neon.
- No summer foliage, no flowers in bloom beyond a single blossoming tree.
- No repeated identical building, identical balcony, or identical parked car.
- No visibly tiling texture — this street is short and the player will walk its
  whole length looking at the walls from 2 m away.
- No wet-mirror asphalt. Damp, not flooded.
