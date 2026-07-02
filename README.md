# Downtown Drifter

A top-down pixel-art driving game. Drift through an endless, procedurally
generated downtown, dodge traffic, smash what you can't dodge, and keep going
until your car is 100% totaled.

![genre](https://img.shields.io/badge/genre-arcade%20driving-red)

## Run it

Any static file server works (it's plain HTML5 + ES modules — runs on Mac,
Windows, Linux):

```sh
cd pixel-driver
python3 -m http.server 8712
# then open http://localhost:8712
```

or `npx serve .` — then open the printed URL. The game window is 800x600.

## Controls

| Key | Action |
|-----|--------|
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake / reverse |
| `A`/`D` / `←`/`→` | Steer |
| `Space` | Handbrake (drift!) |
| `M` | Toggle sound |
| `R` | Restart after being totaled |
| `Esc` | Back to menu |

On the menu, type letters/digits to set the **seed** — the same seed always
rebuilds the exact same city, forever, in every direction.

## What's inside

- **Endless seeded city** — an irregular road grid generated chunk-by-chunk
  from a hash of the seed: buildings, parks, plazas, parking lots full of
  cars, traffic lights, lamps, hydrants, benches, cones, trees.
- **Destructible everything** — the world is a grid of 2px cells; buildings
  chip into rubble when you hit them. Every car is a grid of individual
  pixels that dent and tear off per-impact. Skid marks and scorch decals are
  painted permanently into the world.
- **Drift physics** — arcade bicycle-ish model with deliberate oversteer,
  handbrake-initiated slides, tire smoke, and persistent rubber marks.
- **AI traffic** — cars keep to right-hand lanes, queue behind each other,
  stop at red lights, turn at intersections, and turn into loose physics
  bodies (then wrecks) when you plow into them.
- **Dynamic camera** — velocity lookahead plus trauma-based shake that scales
  with impact intensity and speed.
- **Procedural audio** — engine, skids, crashes and prop snaps are all
  synthesized with WebAudio; there are no asset files at all.
- **HUD** — damage meter, speedometer, odometer, seed readout.

Rendering is a 400x300 buffer scaled 2x with nearest-neighbor for the chunky
pixel look; simulation runs at a fixed 60 Hz.

## Code map

| File | What it does |
|------|--------------|
| `src/world.js` | Seeded road grid, block layouts, destructible cell chunks, props, decals |
| `src/car.js` | Deformable pixel car bodies + player drift physics & collisions |
| `src/traffic.js` | AI drivers, traffic-light obedience, turns, car-vs-car impacts |
| `src/game.js` | Menu / play / dead states, camera, HUD, stats |
| `src/particles.js` | Smoke, debris, sparks, water, leaves, fire |
| `src/audio.js` | WebAudio synth SFX |
| `src/font.js` | 3x5 bitmap font |
| `src/rng.js` | Seeded hashing / PRNG |

## Notes & roadmap

- Destruction persists while an area stays in the chunk cache; drive far
  enough away and back, and the city heals itself (deliberate — keeps the
  endless world memory-bounded).
- **Police chases**: hooks are in place (`game.js` tracks collisions and the
  light phases are queryable) — a wanted level + pursuing cruisers is the
  planned next feature.
