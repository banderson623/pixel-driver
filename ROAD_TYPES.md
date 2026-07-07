# Road types — design exploration

Branch: `road-types`. Goal: add **highways**, **curvier roads**, and
**roundabouts** to the procedural city.

> **Status: implemented.** All four steps below are in. Tuning knobs live at the
> top of `src/world.js` (`HWY_*`, `CURVE_*`, `RBOUT_RATE`). Verified headless
> across ~14 seeds: rendering of all three types, plus traffic entering,
> circulating, and exiting roundabouts with no cars ever stuck and no runtime
> errors. This doc is kept as the rationale/architecture record.

## The one constraint that shapes everything

The city is an **axis-aligned grid used as a navigation graph**, not just as
scenery:

- `world.js` has two `Axis` objects (`vA`, `hA`). Each emits an infinite run of
  centerlines (`center(k)`) at hashed gaps of 310–520px. Vertical roads live at
  `x = vA.center(i)`, horizontal at `y = hA.center(j)`. **Every** vertical road
  crosses **every** horizontal road → a full grid.
- `classify(wx,wy)` paints every pixel purely from its distance to the nearest
  vertical axis and nearest horizontal axis. Road width, lane stripes,
  crosswalks and the sidewalk ring are all `ROAD_HALF`-relative bands.
- `traffic.js` cars are *locked to the graph*: each carries `axis` ('v'/'h'), a
  road index `k`, a `dir`, and a lane offset. Lane-keeping snaps to
  `axisA.center(k) + perp*LANE`. Turns are bezier arcs between two perpendicular
  axis roads at an intersection.
- Physics (`isRoad`, `surfaceDrag`, `solidAt`) is geometry-agnostic — it only
  samples the surface *type* of a cell, so it doesn't care about road shape.

So `ROAD_HALF` (24) and `LANE` (12) are effectively global assumptions baked
into `world.js`, `traffic.js`, `game.js`, and `pedestrians.js`.

**Design decision:** keep the grid *topology* (every road still meets every
cross road). It's what keeps traffic AI, chunk generation, seeding, and the
"same seed → same city" guarantee working. All three features are expressible
as *decorations on the existing graph* rather than a new generator. A free-form
road network (branches, dead-ends, arbitrary curves) would be a from-scratch
rewrite of world + traffic and is explicitly out of scope here.

## The unifying abstraction

Replace the two global constants with **per-road profile functions on `Axis`**,
plus an optional lateral offset. Everything else queries these:

```
axis.rank(k)      -> 'local' | 'arterial' | 'highway'   (hash of k)
axis.half(k)      -> road half-width in px               (from rank)
axis.lanes(k)     -> lanes per direction                 (from rank)
axis.speedMul(k)  -> cruise multiplier                   (from rank)
axis.offset(k, along) -> lateral wobble in px            (0 = straight; curvy roads)
axis.centerAt(k, along) = center(k) + offset(k, along)   (the actual centerline)
```

`offset` is a smooth, seeded sinusoid/noise of the along-coordinate, **bounded**
well under the min gap so curved roads still never cross their neighbours —
which is what keeps `nearest()` well-defined and the grid intact.

Roundabouts are a per-*intersection* property, not per-road:

```
world.roundabout(i, j) -> { r } | null   (hash of i,j, gated so highways opt out)
```

## Build order (each step ships something playable)

### 0. Foundation refactor — *no visible change*
Route every `ROAD_HALF` / `LANE` reference through `axis.half(k)` / lane helpers.
Add `centerAt(k, along)` and make `nearest()` offset-aware (evaluate candidate
roads' actual x/y at the query's along-coord; only 2–3 candidates matter since
offset ≪ gap). Ship with all roads identical → pixel-for-pixel the same city.
De-risks everything after it.

### 1. Highways — *biggest payoff, purely additive*
Promote ~1 in 5 axes to `highway` rank: wider asphalt, a painted/planted
median, 2–3 lanes each way, sparser cross-lights, higher traffic cruise. Mostly
falls out of the profile functions once step 0 lands. Watch items: variable
half-width ripples into crosswalk bands, the sidewalk ring, prop placement, and
traffic stop/turn positions — all already routed through `half(k)` after step 0.

### 2. Roundabouts — *localized to intersections*
At selected non-highway intersections, `classify` carves an asphalt annulus
around a central island (grass/planter, solid inner disc) with the four
approaches fanning in. Traffic gets an **arc-follow** mode: yield on entry,
circulate the ring, exit at the chosen leg. Bounded to the intersection, so it
doesn't perturb straight-road driving.

### 3. Curvy roads — *most invasive, do last*
Turn on `offset(k, along)` for some roads. `classify` and `nearest` already
handle it after step 0. Lane-keeping follows the curve almost for free (the
lateral-correction term continuously pulls cars toward `centerAt`), but heading
init on spawn, turn-arc endpoints, and crosswalk/prop placement all need to
sample `centerAt` instead of `center`. Pairs naturally with roundabouts (both
are arc-following for traffic).

## Open choices (my defaults in **bold**, easy to change)

- Highway lights: **overpass-free but ungridded** (fewer lights, faster) vs.
  true grade separation (much harder). Going with the former.
- Curvy roads: **both axes can wobble** independently vs. only one. Both.
- Tuning: expose `half`/`offset amplitude`/`roundabout rate` via the existing
  `tuner.js` so we can dial the feel live. **Yes.**
</content>
</invoke>
