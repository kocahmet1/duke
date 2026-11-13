# MISSION 4 — THE CORDON
### 233. Sokak, Seydişehir, decoupled from mission 1 and extended

---

## 1. What moved, and why the coordinates did not

The outdoor half of mission 1 — the 233 Sk axis, Yıldız Tepesi park, the
roundabout, both Seydikent forecourts, the 230 Sk crossing and the Yıldız
Tepesi fight hall — is now `buildStreetMap()` and mission 1 is the indoor
Hollywood Holocaust again, opening at (28, 36) in the night canyon.

**Every one of those cells kept its grid coordinate.** `nz-street.js`,
`-ground`, `-props`, `-park` and `-sky` author in ABSOLUTE world units: the
A-BLOK elevation is a fifty-metre run at x 580…756, z 140. Move the carve one
cell and a photographed facade slides off its own pavement. So mission 4
reproduces the axis literally and every new thing is built around it.

The six street modules now gate on `NZ.level !== 1 && NZ.level !== 4`, and
`nz-street-park.js` gained the carve test the other five already had — without
it, mission 1 (which no longer carves the park) built a hundred thousand
triangles of daylight park inside its own solid rock.

## 2. The two new side streets

232. Sokak, the crossing the tree roundabout was always built around, carved
north and south of the apron:

| | cells | world | closure |
|---|---|---|---|
| north arm | x 137–144, y 15–35 | x 548–580, z 60–144 | row 14 |
| south arm | x 137–144, y 53–73 | x 548–580, z 212–296 | row 74 |

Six road cells kerb-to-kerb (6.86 m) with a 1.14 m walk each side; about 24 m
from the apron to each barricade, then four more cells of street you can see
but not walk.

**A closure is never a building.** One occupied row, walkable street on the
near side, visible un-walkable street on the far side. 230 Sk north got the
same treatment at row 28, replacing the blank map edge it used to dead-end
into. `runLevel4Pass` asserts all six.

**230 Sk south is not a street.** It is the small walled garden between
SEYDİŞEHİR MARKET and B-BLOK's east end: a 1.05 m rendered wall with a coping
and a korkuluk on the 233 Sk building line, raised soil behind it, and
twenty-nine cypress packed tight enough that the ground is never visible.
The wall is the closure — row 49 occupied, row 48 (the 233 Sk carriageway)
open in front of it, and rows 50..64 occupied behind — and it still obeys the
rule above: waist high against a 7.1 eye, seen straight over from the
crossing, with the map visibly carrying on behind it. nz-street-side
SECTION 9.6 builds it; there is no carriageway, no lane marking and no police
line over z 196..260.

## 3. Interiors

Ground floor at 0.5 → 11.2 (nz-street.js's own `GH`), first floor at
11.2 → 21.0, so a flat laid at 11.2 sits exactly where the photographed facade
puts its first slab.

* **Yıldız Tepesi hall** — unchanged, one public door at (79, 35).
* **SEYDİKENT A-BLOK** ground floor — rear corridor, three rooms, service
  passage out onto 232 Sk North, party-wall link into KIZILCALAR.
* **SEYDİKENT B-BLOK** ground floor — GÜVEN ECZANESİ in its west end with a
  shopfront on 232 Sk South, plus lobby and two flats.
* **KIZILCALAR APT.** (232 Sk North) — lobby, bakkal, a lift, and the
  first-floor flat that holds the red card, with a loggia over the arm.
* **DEĞERLİ APT.** (232 Sk South) — lobby, garage, lift, second first-floor
  flat and loggia.
* **DOYUM EKMEK FABRİKASI** — shop and bake hall on the arm's west flank.

**Why no gameplay door on 233 Sk.** A door cell makes `buildWorld` draw a
lintel on the cell boundary it stands in. On the two photographed elevations
that boundary IS the facade plane, so the quad lands coplanar with fifty metres
of authored siding and z-fights it. Every gameplay door therefore lives on a
gable that `nz-street-side.js` authors itself, and the residential entrances on
233 Sk stay exactly what the reference shows: doors nobody in this fight opens.

## 4. The checkpoint — UPHILL

**The mission runs east to west.** The player is put out on the east tail of
233 Sk at cell (206, 44) facing west, with the whole street climbing away from
him at the park's 7 %, and the checkpoint is on the crest.

Red card in KIZILCALAR's first-floor flat → the gate on the **park-crest** line
at (66, 40) → the lane through cells (62…65, 40) → the switch at (61, 40).

The lane is on grid row 40 — world z 160…164, the centre of the north
carriageway — and not on the axis crown at row 43, because west of the
roundabout 233 Sk splits around a planted median (z 172…184) and row 43 is the
middle of it. `nz-street-park.js` splits its **west park barrier** around the
lane on mission 4 only, and no longer splits the city barrier at the east.

The engine's door lintel is 4 units wide and runs to the region ceiling, and
lowering the lane's own ceiling only relocates the same slab onto the mouth of
the tunnel — so the gate block stays: a concrete mass with an archway bored
through it, fronted at x 268.10 so its 16 u depth swallows the header on BOTH
faces of the door cell.

It is not rebuilt at the crest. `nz-street-side.js` builds it where it has
always been authored — around x 826…848, z 160…188, facing west — and then
turns the whole assembly end for end with `cdSpin()`: a half turn about
(x 550, z 168) plus 19.90 of lift. A half turn and not a mirror, because a
reflection flips the handedness of every triangle and the block would render
inside out; a rotation is a proper motion and only negates nx and nz.

### The east line

Plain closure. One continuous run of nz-street-park's bariyer, a YOL KAPALI
board, two masts, one revetment and two cones — the same kit the four other
closures carry. The two five-storey masses that used to frame the gate,
`X-E-N` and `X-E-S` (elevation at x 791.98, mass x 792…824, 17.7 m, blank east
gable), are deleted: from the gate they were two featureless slabs eight units
apart, and with the checkpoint gone the street simply runs on to the line with
the terminus town and the range behind it.

## 5. nz-street-side.js

Owns the two 232 Sk carriageways, the four flanking elevations with their
openings left exactly where the grid puts them, DOYUM EKMEK and GÜVEN ECZANESİ,
the four barricades and the gate block, the 230 Sk stub cladding, and Adil
Camii with its two minarets on the surveyed parcel east/right of 232 Sk.  The
north carriageway remains visible past the mosque instead of terminating at
its gate.

Two rules it was written to, both learned the hard way:

* **Bake first, tone second.** `NZ.street.bake()` REPLACES the colour attribute
  with an achromatic sky term. Hand it a geometry that already carries the
  palette and every wall on the street comes out the same grey concrete.
* **Every elevation stands 0.02 proud of its cell boundary.** Coplanar is how
  you lose a depth test to somebody else's end cap.

## 6. Checking it

    npm test                      # all four missions
    npm run shot -- --sheet=cordon --q=level=4
    npm run shot -- --sheet=mission1

---

## 7. The rebuild — what changed after the first pass, and why

The first build of `nz-street-side.js` was a layout sketch. An audit against
`nz-street-park.js` and `nz-street.js` found three defects that cost visible
pixels and one that cost the whole point of the street:

* **Every tree rendered zero pixels.** `conifer()` emitted its cards through the
  pile's world-space planar UV projector while the needle atlas is
  ClampToEdge — with world coordinates of 70..300 every card sampled the
  atlas's transparent corner texel and was discarded by alphaTest.
* **Every proud element z-fought its own wall.** Plinth, storey band, floor
  bands, cornice, fascia, stallboard and shutter were all `box()` calls whose
  rear face landed exactly on the wall plane, along the full length of eleven
  runs.
* **The module registered no bake occluders at all.** At the tier the game
  ships, that bake is the only ambient occlusion in frame, so every barricade,
  tree and minaret floated on flat-lit asphalt. There are 45 now.
* **And the elevations were skins.** One one-sided plane per run with nothing
  behind it — which is what you could see, edge-on, turning south off the
  roundabout.

The rebuilt module is 9,186 lines in six banner-marked sections (kit and
atlases; elevation skins; mass, roofs and corners; ground and furniture;
mosque and terminus; cordon), and it carries the two rules the park module
proved:

* **Bake first, tone second.** `NZ.street.bake()` REPLACES the colour
  attribute with an achromatic sky term. The palette is multiplied in
  afterwards or every wall on the street comes out the same grey.
* **Every map is a near-white, near-neutral RELIEF layer.** All colour arrives
  as the per-vertex tone. Tint the map as well and the hue squares.

### The three corrections the owner asked for

1. **Adil Camii is north and east/right of 232 Sk.** The road continues past
   it; the mosque assembly is translated to x = 652, about 25 m east of the
   carriageway centreline, instead of closing either end of the street.
2. **The thin park-side facade is genuinely gone.** The shallow KOMAGENE /
   ONURLU runs, their quoin, overhead-wire supports and the one-unit-deep park
   `cornerBlock()` are not built. The east edge of the park's last grid column
   is open to the south arm, exposing the landscaped park and its paths.
3. **GÜVEN ECZANESİ is in B-BLOK's west end on the south-east corner.** The
   shop is cells 146..152 x 55..60, its gameplay door is grid (145,57), and
   the glazing and fascia wrap from 232 Sk around onto 233 Sk. A-BLOK's north
   gable is residential again.

### No vehicles

The mission carries exactly one, the silver Tourneo Courier `nz-street-props`
parks on 233 Sk. The four occupied kerb strips on the arms carry a municipal
bin run, a builder's skip, a market trestle row and a roadworks trench
instead — and the four lamp columns, because a 1.14 m footway has nowhere
rule-C-legal to stand a 9 m mast.
