# ZIRHLI DEVRIYE ARACI — the cordon's armoured patrol car
### `nz-apc.js`, mission 4, enemy kind `apc`

---

## 1. What it is, and why a vehicle

Mission 4 is a cordon. Everything else on it is a man on foot, and every fight
on 233. Sokak is therefore the same fight at a different range. The vehicle is
the one actor on the map that changes the shape of the street rather than
occupying it:

* **It cannot follow you inside.** A 2750 mm machine does not fit under a
  2200 mm lintel, and `hullFits` refuses every doorway on the map. Getting
  through a door is a real escape, and it is the only enemy on the level for
  which that is true.
* **Rifle fire is a light show.** Plate is `×0.11`; the answers are the RPG,
  the engine louvres, and the station's optic. Every one of them is a place
  the player has to stand, and every one of them is exposed.
* **You hear it before you see it.** A diesel, a horn, and a searchlight that
  pins you a beat before the gun comes round.
* **It has to use the roads.** So the park, the loggias, the bakery and the
  first floors are all still yours.

It is a 4x4 mine-protected 12-tonner in the Otokar Cobra II mould, which is
the vehicle that would actually be sitting on a cordon in Seydişehir.

| | m | units | | m | units |
|---|---|---|---|---|---|
| length | 5.60 | 19.600 | wheelbase | 3.30 | 11.550 |
| width | 2.50 | 8.750 | track | 2.05 | 7.175 |
| roof | 2.20 | 7.700 | tyre radius | 0.55 | 1.925 |
| over the RCWS | 2.75 | 9.625 | belly clearance | 0.42 | 1.470 |

Turning radius `WB / tan(34°)` = **17.1 units (4.9 m)**. That number governs
more of this module than any other, and section 4 is mostly about it.

---

## 2. The road network

A vehicle does not path-find over the walk grid. `NAV.walk` is baked for a
0.60 m man and knows nothing about lanes having a direction, islands having a
correct side, or a 5.6 m hull being unable to take a corner it can stand in.
Those are road facts, and road facts live on roads.

`buildStreetMap` already carves a real network: a 24-unit carriageway on the
crown z = 172, a 24-unit crossing at x = 564 with a planted island in the
middle of it, a second crossing at x = 776, and five barricades. So the module
authors that as a **31-node graph with six dead ends** and drives it.

Every node is validated against the hull at install and dropped if it will not
admit it, which is also the check that catches an authored coordinate that
drifted when the map moved. It currently drops none.

**The island.** The tree island at x 560…568, z 168…176 sits in a 32-unit
apron: twelve units of channel each side for an 8.75-unit hull, which fits
with 0.93 m to spare. What does *not* fit is a circulating ring — tangent to a
10.8-unit ring the hull's outer corner lands 18.1 units out and the apron is
16 — so the junction is four corner nodes threading the four channels instead,
which is what a long vehicle does at a mini-roundabout. Right-hand traffic
then falls out of the lane offset: eastbound passes south of the island,
northbound passes west of it.

### Turning a node path into a driving line

Five passes, in this order and for these reasons:

1. **Resample** at 6 units, so the pure-pursuit lookahead always has points to
   chew on and a 52-unit straight is not two points.
2. **Keep right** by `LANE` (4.2 units) scaled by the segment's `laneK`. In a
   Y-up world with x east and z south, the vector right of a heading `(dx,dz)`
   is `(-dz, dx)`: head east and your right hand points south, which is the
   lane the eastbound carriageway actually is.
3. **Smooth** — *before* the clearance solve, not after. Smoothing afterwards
   averages every swing-out back into the obstacle it was there to avoid;
   measured, it put the northbound line 1.5 units inside the builder's skip on
   232 Sk and stopped twelve tonnes dead against it.
4. **Solve laterally for CLEARANCE, not for a fit.** The bin run, the skip,
   the market trestles, the roadworks and the parked silver Courier all stand
   *in* the carriageway. Taking the first offset that admits the hull produces
   a line legal by a millimetre, and a vehicle cannot hold a line to a
   millimetre — that alone accounted for 16% of every integration step being
   refused. So each candidate offset is probed with a shrinking half-width
   allowance and scored by the largest that still fits, with a small penalty
   for leaving the correct lane. An open street is driven keeping right; a
   pinched one is driven up the middle; neither is a special case.
5. **One light smoothing pass, re-validated** — anything it pushes back into
   something is put straight back where the solver had it.

---

## 3. The collision hull is not the drawn hull

`COL_L 0.92, COL_W 0.80` — 5.15 × 2.00 m against a drawn 5.60 × 2.50 m.

The world is a 4-unit grid (1143 mm cells) and a blocked cell is blocked in
its entirety. Sampling the exact corners of the drawn box against that grid
means a corner 10 mm inside a kerb cell refuses the whole cell — and since the
pose the vehicle stopped in was legal while every pose 1 mm away is not, it
wedges itself on a knife edge it cannot step off. Measured: both vehicles
pinned, 11,952 refused steps, with `hullFits` reporting the pose they were
standing in as fine.

250 mm of overhang per flank is the mirrors, the flare and the arch lip
passing over a kerb, which is what the drawn hull would do anyway. Every
obstacle it is measured against is kerb furniture.

**And the ground test is a plane fit, not a min/max.** The obvious test —
reject when the highest and lowest cell under the hull differ by more than a
kerb — fails on 233 Sk, because the west half is a steady 7% grade off Yıldız
Tepesi and a 5.6 m hull standing on it legitimately spans 1.4 units of floor.
Raising the threshold until the slope passes then lets the vehicle climb a
0.8 m step, which is worse. So a plane is fitted through the fifteen samples
and the **residual** is judged; the gradient is checked separately against
what the vehicle can actually climb (45%). The sample grid is symmetric about
both axes, so the normal equations collapse to three sums and no matrix.

---

## 4. The driver

A kinematic bicycle model. State is `(x, z, face, v, steer)`, and the only way
to change `face` is to be moving *and* to have lock on:

```
dface = (v / WB) * tan(steer) * dt
dx    = sin(face) * v * dt
dz    = cos(face) * v * dt
```

This is the whole reason for the `enemyDrive` seam. The stock locomotion is a
velocity slew — `accel` caps how fast the velocity *vector* may change in any
direction and `turnEnemy` swings the body independently of it — which is
exactly right for a man, who can step sideways, and impossible for a car.

**Steering** is pure pursuit. For a target at signed bearing offset `α` and
lookahead `Ld` the path curvature is `2 sin α / Ld`; reversing negates it,
because the rear axle is doing the pursuing, which is also why reversing round
a corner feels like it does.

> **The lookahead floor is 21 units and it is load-bearing.** Pure pursuit is
> only stable while the lookahead comfortably exceeds the turning radius. An
> 11-unit lookahead against a 17.1-unit radius asks for a curve tighter than
> the steering can produce, arrives wide, asks harder — and the vehicle drives
> in circles at full lock. Measured, on the apron, for two minutes.

**Speed** is the smallest of four limits: what the corner will take
(`√(a_lat/κ)`), what will stop by the route's end, what the forward probe
allows, and what the situation asks for. The probe sweeps the *arc* the
steering is actually describing, not the tangent — probing the straight line
is how a car brakes to a standstill for a corner it was already turning into.

The probe **limits, and never vetoes**: a want of exactly zero is a standstill
that `integrateStep` never sees, so nothing escalates and the vehicle sits
there for the rest of the level. A 0.9 m/s crawl floor makes `integrateStep`
the authority on whether a move is legal.

### Turning round

Reversing does not change which way a vehicle faces, and a U-turn in one sweep
needs two turning radii plus the width — 41 units, against a 24-unit
carriageway. Both of those facts have to be in the code or the vehicle spends
the level shuttling along one street:

* **A route may not begin with a U-turn.** A mid-route re-plan that hands back
  a line running back the way the vehicle came makes pure pursuit ask for full
  lock, and full lock is a circle it cannot complete: it wedges across the
  carriageway and every recovery rotates it further. 2,312 refused steps in
  one 8-unit square. The guard is skipped where `canTurnAround` says there is
  genuinely room, which is asked by *simulating the manoeuvre* — ten poses at
  full lock through half a turn — because "does the hull fit sideways" is the
  wrong question and gives the wrong answer.
* **At a barricade it backs out**, on its own short route to the nearest
  three-armed junction. The route direction is the direction of travel, so
  keep-right still puts it in the correct lane while it is going backwards.
* **Everywhere else it three-point turns.** Full lock one way, full lock the
  other, as many bites as it takes; each bite of arc length L buys L/R
  radians, so 20 units against a 17.1-unit radius is 67° and 180° is three
  bites. Nine bites and it gives up and drives the route as best it can,
  because a vehicle that will not stop shuffling is worse than one pointing
  the wrong way.
* **The destination is chosen first, and how to get pointed at it second.**
  Taking the first road that happens to run forward means a vehicle that has
  just backed out of a barricade takes the 26-unit hop to the next node up the
  same street, and then the next, and never leaves it — measured, both
  vehicles spent five minutes on 232 Sk and the other three streets were never
  visited once.

### Traffic

232 Sk north has five dismounts standing on it, and a man who has stopped to
shoot never steps aside — his own locomotion zeroes his intent while `stop` is
set. So the driver's patience runs out on a ramp: lean on the horn at a second
and a half, and by five seconds simply drive. `shoveInfantry` is what actually
clears the road — an oriented de-penetration that pushes a man out of the real
footprint at his own top speed — because `separateEnemies` only fires on a
circle-circle overlap of `cfg.rad`, and `rad` is 4.9 on a hull 9.8 long.

The player is different. The player gets run over.

---

## 5. Armour

`hitscan` broad-phases every actor as a vertical cylinder of `cfg.hitRad`, and
`enemyHitZone` splits it into head / body / legs by height band. For a
5.6 × 2.5 m box that cylinder has to be 10.3 units to reach the bumper, which
makes 1.1 m of empty air beside each flank shootable — and "head at 76% of
stature" is not a sentence about an armoured car. So the module supplies both
halves through `enemyRayTest` (a real ray/oriented-box narrow phase against
the hull *and* the traversed turret, so a miss carries on to the wall behind
it) and `enemyHitZone`:

| zone | × | what it is |
|---|---|---|
| armour | 0.11 | plate. Sparks, and nothing else |
| legs | 0.55 | belly and running gear |
| wheel | 0.90 | and it deflates the tyre it hit |
| block | 1.25 | screen, door lights, vision blocks |
| deck | 1.90 | the engine louvres over the bonnet |
| head | 2.60 | the RCWS optic, the only glass on the station |

420 hit points behind that becomes: **three RPG rockets**, or seven rifle
rounds into the louvres from in front, or a magazine into the flank for
nothing. Subsystems are separate — each tyre is worth 15.5% of mobility, the
engine most of it, and the optic blinds the station rather than killing the
vehicle (`react` is held open so the brain's own gate stops it firing).

---

## 6. The four seams into NUKEM.html

Everything else is a normal character-module hook. Remove `nz-apc.js` and the
`apc` kind simply never gets a rig; nothing else changes.

| hook | site | why |
|---|---|---|
| `enemyDrive` | `enemyLocomote` | a wheeled hull cannot strafe and has a turning circle |
| `enemyRayTest` | `hitscan` | oriented-box narrow phase |
| `enemyHitZone` | `enemyHitZone` | armour is not anatomy |
| `render` (36) | frame loop | engine audio; returns `undefined`, never claims the frame |

Plus four one-line changes, each of which is a generalisation rather than a
special case:

* `separateEnemies` — an `immovable` actor takes none of the pair correction
  and the other takes all of it. Two ordinary actors still split it evenly.
* `selectEnemyRigLods` — an `alwaysRig` actor keeps its 3D rig at every range.
  A vehicle is never a billboard.
* `ECFG.apc` — the stat block.
* the `P4` spawn table — two vehicles, cells (152, 43) and (141, 24).

---

## 7. Sound

nz-audio.js has no vehicle in it and no looping-positional API to build one
out of: every cue there is one-shot and its bus is recycled on a timeout, by
design. What it does hand over is `AU.ctx`, so the engine is built here and
driven from the frame loop.

A 6.7-litre six firing three times a revolution is N/20 Hz — 40 Hz at an 800
rpm idle, 132 Hz at the 2650 rpm peak — and everything hangs off that one
number: sawtooth at `f` for the firing order, `2f` for the exhaust note, a
square at `f/2` for the lumpy off-beat that makes it a diesel, brown noise
opening with load for induction and tyre roar, injector clatter gated above
idle, and a turbo that lags coming on and sighs coming off. Every parameter is
ramped, never set. `AU.muted` short-circuits `sfx()` *before* the hook, so a
loop we own has to watch it or the M key does nothing.

Two owned cues, which exist only while this module is loaded: `apc_hmg` (a
12.7 is not a chaingun — slower, lower, and a slap on the front of it) and
`apc_horn` (two tones a minor third apart; a vehicle crew leans on the horn,
it does not shout).

---

## 8. Checking it

    npm test                       # all four missions, unchanged
    _apc_stage.html                # the model on a stage, no street, no AI
                                   #   ?view=front34|side|rear34|front|rear|
                                   #        plan|rcws|wheel|eye|low
                                   #   &turn=1  &dead=1
    NUKEM.html#level=4             # ?nzapc=0 disables, ?nzapc=debug arms the
                                   #   per-frame block histogram

`NZ.apc` exposes `stats()`, `why(i)` (the whole speed solve for one vehicle,
including which of the four limits is binding), `fitWhy(i)` (why the hull will
not stand where it is standing, and a heading sweep), `blockCells()` and
`line(a, b)` (the solved driving line between two named nodes). All of it is
how the numbers in this document were measured, and none of it is called by
the game.

**Measured, five minutes of patrol, two vehicles, no rendering:** 30 distinct
40-unit cells visited across all four streets and the park slope, 2,285
refused integration steps out of 36,000 (6.3% — mostly the last bite of a
three-point turn, and the squeeze past the sentinel standing on the cordon),
10 reversals, 6 three-point turns, no exceptions, no NaN.

---

## 9. The two SENTINELs

Mission 4 also gained two of mission 2 and 3's mechanical supersoldiers, and
they are outdoor enemies here for a reason that is worth writing down.

`navBuild` already bakes a second walk grid for anything carrying
`navProfile: 'spider'`, against a 4.2-unit footprint and 13.25 units of
headroom. Run that over the cordon and it comes out at **3,610 cells, not one
of them inside a building**: every ground floor on this map is 10.7 units slab
to slab, so the machine is locked out of all of them by its own height. The
only roofed room on the level it fits in at all is the Yıldız Tepesi hall,
which is 19 units tall.

It is not posted there. The whole outdoor grid — park, slope, the 233 Sk axis,
both 232 Sk arms and 230 Sk — is one connected component, so a sentinel that
can follow you across all of it is worth more than one standing in a room. And
it lands on the same bargain the armoured car offers, arrived at from the
opposite direction: **get inside and neither of them can follow you.** One
vehicle is too wide and too tall for the doors; one machine is simply too
tall. Every interior on the cordon is a refuge from both.

    ['spider', 139, 47]    the roundabout, south of the tree island — what you
                           see first, from the park crest, coming down the slope
    ['spider', 202, 43]    the cordon itself, in front of the boom

Both cells were checked against the real bake before being authored, and both
sit in the largest open areas on the level (135 and 103 spider-walkable cells
within six). Verified at runtime: both spawn, both take the `nz-spider.js`
rig rather than the stock fallback, and both close on the player and hold the
38-unit standoff their `keep` asks for.

The one interaction worth knowing about: a sentinel standing on the
carriageway is something the armoured car has to get past, and it does —
`trafficBrake`'s patience ramp leans on the horn and then squeezes through,
and `separateEnemies` moves the machine because it is not `immovable`. That
exchange is most of the difference between the 4.2% and the 6.3% above.
