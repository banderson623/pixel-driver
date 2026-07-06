// Cars are grids of individual pixels ("voxels"). Collisions dent and tear
// pixels off. The player car uses an arcade drift model tuned to oversteer.

import { tuning as T } from './tuning.js';
import { countWreck } from './traffic.js';

// Default (sports car) dimensions. Traffic cars use these directly.
export const CAR_W = 13, CAR_H = 24;

const PROFILE = [7, 9, 11, 11, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 11, 11, 11, 9, 9];

// A body "design" describes a vehicle's pixel silhouette: overall size, the
// per-row width profile, and which rows carry glass/roof/bed/wheel/light
// features. CarBody builds any design; feature columns are placed relative to
// the horizontal center so the same rules scale to wider bodies.
const CAR_DESIGN = {
  w: CAR_W, h: CAR_H, profile: PROFILE,
  windshieldRows: [6, 9], roofRows: [10, 14], rearWindowRows: [15, 16], bedRows: null,
  wheelRows: [[4, 7], [17, 20]], headlightRow: 0, taillightRow: 23,
};

// Pickup truck: longer, wider, boxier. A front cab (glass + roof) with an open
// cargo bed behind it, and a second axle set well back.
const TRUCK_PROFILE = [
  9, 11, 13, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 13, 11,
];
const TRUCK_DESIGN = {
  w: 15, h: 30, profile: TRUCK_PROFILE,
  windshieldRows: [7, 8], roofRows: [9, 13], rearWindowRows: [14, 15], bedRows: [17, 27],
  wheelRows: [[4, 8], [21, 26]], headlightRow: 0, taillightRow: 29,
};

// Tank: a long forward gun barrel (thin front rows of the profile), a wide
// armored hull, continuous side tracks (the "wheel" columns run the full hull
// length), and a raised central turret drawn by decorate().
const TANK_PROFILE = [
  3, 3, 3, 3, 3, 3, 3, 3, 9,                                  // barrel + mantlet
  17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17,                 // hull
  17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 15,                 // hull + rear taper
];
const TANK_DESIGN = {
  w: 17, h: 32, profile: TANK_PROFILE,
  windshieldRows: null, roofRows: null, rearWindowRows: null, bedRows: null,
  wheelRows: [[9, 30]], headlightRow: null, taillightRow: null,
  decorate: ({ set, get, cx }) => {
    const hw = 4, y0 = 13, y1 = 24; // turret block
    for (let y = y0; y <= y1; y++)
      for (let x = cx - hw; x <= cx + hw; x++) set(x, y, 3);
    // dark ring around the turret so it reads as raised
    for (let y = y0 - 1; y <= y1 + 1; y++)
      for (let x = cx - hw - 1; x <= cx + hw + 1; x++)
        if (get(x, y) !== 3 &&
            (get(x - 1, y) === 3 || get(x + 1, y) === 3 || get(x, y - 1) === 3 || get(x, y + 1) === 3))
          set(x, y, 2);
    // commander hatch
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) set(cx - 1 + dx, 18 + dy, 4);
  },
};

export const AI_COLORS = [
  ['#c23b3b', null], ['#3b62c2', '#a9c2ea'], ['#d8d8d8', null], ['#d8b53b', '#2a2a30'],
  ['#3ba24b', '#e8e8e8'], ['#42b8c9', null], ['#d977b8', '#f0e6ee'], ['#d97b2f', null],
  ['#2e2e34', '#d8b53b'], ['#8a8a94', null], ['#4a6b3a', '#c9a638'], ['#7a4ac2', null],
];

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

export class CarBody {
  constructor(baseCol, stripeCol, design = CAR_DESIGN) {
    // pixel value -> color
    this.cols = [null,
      baseCol,               // 1 body
      shade(baseCol, 0.55),  // 2 outline
      shade(baseCol, 1.3),   // 3 highlight
      '#1c222c',             // 4 glass
      '#303a48',             // 5 glass highlight
      stripeCol || baseCol,  // 6 stripe
      '#17171a',             // 7 tire
      '#f4e79a',             // 8 headlight
      '#d04040',             // 9 taillight
      '#20252e',             // 10 cargo-bed liner
    ];
    // dent colors: darkened variants (rgb() entries can't be re-shaded)
    this.dentCols = this.cols.map(c => {
      if (!c) return null;
      if (c.startsWith('#')) return shade(c, 0.45);
      return 'rgb(40,40,44)';
    });

    const W = design.w, H = design.h, profile = design.profile;
    const cx = W >> 1; // horizontal center column, for feature placement
    this.w = W; this.h = H;
    this.px = new Uint8Array(W * H);
    this.dent = new Uint8Array(W * H);

    const set = (x, y, v) => { if (x >= 0 && x < W && y >= 0 && y < H) this.px[y * W + x] = v; };
    const get = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 0 : this.px[y * W + x];
    // fill the inner span of a row (skips the 2px body edge) with a value
    const fillInner = (y, fn) => {
      const w = profile[y], x0 = (W - w) >> 1;
      for (let x = x0 + 2; x < x0 + w - 2; x++) set(x, y, fn(x, y));
    };
    const rows = ([y0, y1], fn) => { for (let y = y0; y <= y1; y++) fillInner(y, fn); };

    for (let y = 0; y < H; y++) {
      const w = profile[y], x0 = (W - w) >> 1;
      for (let x = x0; x < x0 + w; x++) set(x, y, 1);
    }
    // outline: body pixels touching empty become dark
    const outline = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (get(x, y) === 1 && (!get(x - 1, y) || !get(x + 1, y) || !get(x, y - 1) || !get(x, y + 1))) outline.push([x, y]);
    }
    for (const [x, y] of outline) set(x, y, 2);
    // windshield / roof / rear window / cargo bed
    if (design.windshieldRows) rows(design.windshieldRows, (x, y) => y === design.windshieldRows[0] ? 5 : 4);
    if (design.roofRows) rows(design.roofRows, (x) => x === cx ? 3 : 1);
    if (design.rearWindowRows) rows(design.rearWindowRows, () => 4);
    if (design.bedRows) rows(design.bedRows, () => 10);
    // racing stripe (two columns astride center)
    if (stripeCol) {
      for (let y = 1; y < H - 1; y++) {
        for (const x of [cx - 1, cx + 1]) if (get(x, y) === 1 || get(x, y) === 3) set(x, y, 6);
      }
    }
    // wheels / tracks: two outer columns on each side, over each axle's span
    for (const [y0, y1] of design.wheelRows) {
      for (let y = y0; y <= y1; y++) {
        for (const x of [0, 1, W - 2, W - 1]) if (get(x, y)) set(x, y, 7);
      }
    }
    // lights, placed relative to center (skipped when a row is null)
    if (design.headlightRow != null)
      for (const x of [cx - 2, cx - 1, cx + 1, cx + 2]) set(x, design.headlightRow, 8);
    if (design.taillightRow != null)
      for (const x of [cx - 3, cx - 2, cx + 2, cx + 3]) set(x, design.taillightRow, 9);
    // custom pixels (e.g. a tank turret + barrel) that rows can't express
    if (design.decorate) design.decorate({ set, get, W, H, cx });

    this.total = 0;
    for (let i = 0; i < W * H; i++) if (this.px[i]) this.total++;
    this.lost = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.cctx = this.canvas.getContext('2d');
    this.redraw();
  }

  redraw() {
    const g = this.cctx;
    g.clearRect(0, 0, this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const v = this.px[y * this.w + x];
        if (!v) continue;
        g.fillStyle = this.dent[y * this.w + x] ? this.dentCols[v] : this.cols[v];
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  // Deform around a local grid point. power 0..1. Returns colors of removed pixels.
  deform(gx, gy, power) {
    const removed = [];
    const r = 1.5 + power * 3.5;
    const W = this.w, H = this.h;
    for (let y = Math.max(0, Math.floor(gy - r)); y <= Math.min(H - 1, Math.ceil(gy + r)); y++) {
      for (let x = Math.max(0, Math.floor(gx - r)); x <= Math.min(W - 1, Math.ceil(gx + r)); x++) {
        const i = y * W + x;
        if (!this.px[i]) continue;
        const d = Math.hypot(x - gx, y - gy);
        if (d > r) continue;
        const edge = !this.px[y * W + Math.max(0, x - 1)] || !this.px[y * W + Math.min(W - 1, x + 1)] ||
                     (y > 0 && !this.px[(y - 1) * W + x]) || (y < H - 1 && !this.px[(y + 1) * W + x]);
        const p = (1 - d / (r + 0.5)) * power;
        if ((edge || Math.random() < 0.35) && Math.random() < p * 1.4) {
          removed.push(this.cols[this.px[i]]);
          this.px[i] = 0;
          this.lost++;
        } else if (Math.random() < p * 2.5) {
          this.dent[i] = 1;
        }
      }
    }
    if (removed.length || true) this.redraw();
    return removed;
  }

  integrity() { return 1 - this.lost / this.total; }
}

// Hull sample points (local coords, body center at 0,0) for world collision,
// scaled to the given body size so larger vehicles collide with their real
// footprint.
function makeHull(w, h) {
  const hw = w / 2 - 0.5, hh = h / 2 - 0.5;
  return [
    [0, -hh], [-hw + 2, -hh + 1], [hw - 2, -hh + 1],   // nose
    [-hw, -hh + 6], [hw, -hh + 6], [-hw, 0], [hw, 0],  // sides
    [-hw, hh - 6], [hw, hh - 6],
    [0, hh], [-hw + 2, hh - 1], [hw - 2, hh - 1],       // tail
  ];
}

// Selectable player vehicles. Handling comes from the shared tuning knobs;
// each vehicle then scales top speed / acceleration, grip (gripMul, more =
// more traction), how much crash damage it absorbs (damageMul < 1 = tougher),
// how much damage it deals to the world/props/traffic (smashMul), and how
// heavy it is (mass) — a much heavier vehicle shoves lighter cars aside
// (carrying them at its own speed) instead of trading momentum with them.
export const VEHICLES = {
  car: {
    name: 'SPORTS CAR', tagline: 'FAST - FRAGILE',
    base: '#c23b3b', stripe: '#e8e8e8', design: CAR_DESIGN,
    speedMul: 1, accelMul: 1, gripMul: 1, damageMul: 1, smashMul: 1, mass: 1, shakeMul: 1,
  },
  truck: {
    name: 'TRUCK', tagline: 'SLOW - TOUGH',
    base: '#c2662f', stripe: null, design: TRUCK_DESIGN,
    speedMul: 0.72, accelMul: 0.68, gripMul: 1, damageMul: 0.4, smashMul: 1.4, mass: 3, shakeMul: 0.6,
  },
  tank: {
    name: 'TANK', tagline: 'SLOW - UNSTOPPABLE',
    base: '#5a6a3a', stripe: null, design: TANK_DESIGN,
    speedMul: 0.5, accelMul: 0.45, gripMul: 1.7, damageMul: 0.12, smashMul: 4.5, mass: 8, shakeMul: 0.3,
  },
};
export const VEHICLE_KEYS = ['car', 'truck', 'tank'];

const REV_MAX = 80;
const AXLE = 8;          // half wheelbase (px)

// Two-axle drift model. Each axle tries to cancel its lateral velocity
// (a damper, gain K_LAT) but the correcting force is capped by that axle's
// grip. Past the cap the tire slides and only KINETIC of the limit remains
// — that static->kinetic drop is what makes slides progressive and easy to
// hold. Throttle drains rear grip (traction circle -> power slides) and the
// handbrake all but removes it. Yaw is integrated for real: rear breakaway
// rotates the car into the drift, and finite front grip lets counter-steer
// catch it.
//
// Every knob below (STEER_MAX, GRIP_F/R, KINETIC, DRAG, ...) lives in
// tuning.js and is read through `T` each frame, so the on-screen sliders
// change the handling live. See tuning.js for defaults and ranges.
// Speed kept when plowing through a prop. Props are soft (see PROP_SOFTNESS in
// world.js): 10% of the former 8% scrub, so smashing one barely slows you.
const PROP_SMASH_KEEP = 1 - 0.08 * 0.1; // = 0.992

export class PlayerCar {
  constructor(x, y, heading, spec = VEHICLES.car) {
    this.x = x; this.y = y;
    this.heading = heading;
    this.vx = 0; this.vy = 0;
    this.spin = 0;
    this.steerS = 0;
    this.damage = 0;
    this.dead = false;
    this.skidding = false;
    this.skidLevel = 0;
    this.lastScrape = 0;
    this.spec = spec;
    this.speedMul = spec.speedMul;
    this.accelMul = spec.accelMul;
    this.gripMul = spec.gripMul;
    this.damageMul = spec.damageMul;
    this.smashMul = spec.smashMul;
    this.mass = spec.mass;
    this.shakeMul = spec.shakeMul;
    this.body = new CarBody(spec.base, spec.stripe, spec.design);
    // collision geometry derived from the actual body size
    this.hull = makeHull(this.body.w, this.body.h);
    this.collR = this.body.w / 2;                     // prop-collision radius
    this.collOff = this.body.h / 2 - this.body.w / 2; // front/rear circle offset
  }

  forward() { return [Math.sin(this.heading), -Math.cos(this.heading)]; }
  rightVec() { return [Math.cos(this.heading), Math.sin(this.heading)]; }
  speed() { return Math.hypot(this.vx, this.vy); }
  speedMph() {
    const [fx, fy] = this.forward();
    return Math.abs(this.vx * fx + this.vy * fy) * 0.425;
  }

  addDamage(d, env) {
    if (this.dead) return;
    // tougher vehicles shrug off a fraction of every hit
    this.damage = Math.min(100, this.damage + d * this.damageMul);
    if (env) env.stats.lastHitT = env.stats.t;
  }

  update(dt, input, env) {
    let throttle = 0, brake = 0, steer = 0, hand = false;
    if (!this.dead) {
      if (input.down('ArrowUp', 'KeyW')) throttle = 1;
      if (input.down('ArrowDown', 'KeyS')) brake = 1;
      if (input.down('ArrowLeft', 'KeyA')) steer -= 1;
      if (input.down('ArrowRight', 'KeyD')) steer += 1;
      hand = input.down('Space');
    }
    // steering response: the wheel swings faster the harder you're sliding,
    // so counter-steer snaps over quickly enough to catch a drift
    const target = steer;
    const rate = T.STEER_RATE + this.skidLevel * T.STEER_RATE_DRIFT; // ~7 gripping, ~20 in a full slide
    this.steerS += (target - this.steerS) * Math.min(1, rate * dt);

    this.step(dt / 2, throttle, brake, hand, env);
    this.step(dt / 2, throttle, brake, hand, env);

    // tire smoke + skid marks
    this.skidding = this.skidLevel > 0.05;
    if (this.skidding && this.speed() > 30) {
      const [fx, fy] = this.forward();
      const [rx, ry] = this.rightVec();
      for (const s of [-1, 1]) {
        const wx = this.x - fx * 9 + rx * 5 * s;
        const wy = this.y - fy * 9 + ry * 5 * s;
        if (Math.random() < this.skidLevel * 0.9) env.particles.tireSmoke(wx, wy, this.skidLevel);
        env.world.decal(wx, wy, (g) => {
          g.fillStyle = 'rgba(12,12,16,0.16)';
          g.fillRect(-1, -1, 2, 2);
        });
      }
    }
    // damage smoke / fire
    if (this.damage > 55 && Math.random() < (this.damage - 55) / 45 * 0.5) {
      const [fx, fy] = this.forward();
      env.particles.engineSmoke(this.x + fx * 7, this.y + fy * 7, this.damage > 82);
    }
    if (this.dead && Math.random() < 0.6) {
      env.particles.fire(this.x + (Math.random() - 0.5) * 8, this.y + (Math.random() - 0.5) * 10);
      if (Math.random() < 0.5) env.particles.engineSmoke(this.x, this.y, true);
    }
  }

  step(dt, throttle, brake, hand, env) {
    const fwd = this.forward(), right = this.rightVec();
    let vf = this.vx * fwd[0] + this.vy * fwd[1];
    const vl0 = this.vx * right[0] + this.vy * right[1];

    // --- longitudinal: engine, brakes, drag (forward component only) ---
    const surf = env.world.surfaceDrag(this.x, this.y);
    let driveFrac = 0;
    const vmax = T.VMAX * this.speedMul, accel = T.ACCEL * this.accelMul;
    if (throttle) {
      vf += accel * (1 - 0.55 * Math.max(0, vf) / vmax) * dt;
      driveFrac = 1;
    }
    if (brake) {
      if (vf > 5) vf -= T.BRAKE * dt;
      else vf = Math.max(-REV_MAX, vf - accel * 0.55 * dt);
    }
    vf -= vf * T.DRAG * surf * dt;
    if (hand) {
      // locked rears scrub speed; 10x stronger below 15 mph so the handbrake
      // hauls the car down to a stop hard once you're already slow
      const hbRate = Math.abs(vf) * 0.425 < 15 ? 6.0 : 0.6;
      vf *= Math.exp(-hbRate * dt);
    }
    this.vx = fwd[0] * vf + right[0] * vl0;
    this.vy = fwd[1] * vf + right[1] * vl0;

    // --- steering: wheel angle shrinks with speed for high-speed stability,
    // but a slide restores most of that lock so you keep the authority to
    // counter-steer and hold the drift ---
    const speedAtten = 1 + (Math.abs(vf) / T.STEER_FALLOFF) * (1 - 0.75 * this.skidLevel);
    const delta = this.steerS * T.STEER_MAX / speedAtten;

    // --- axle grip limits (traction circle: throttle drains the rear) ---
    const gscale = this.gripMul / Math.sqrt(surf); // grass/dirt slide much sooner
    const frontLimit = T.GRIP_F * gscale;
    const rearLimit = T.GRIP_R * gscale *
      (1 - T.THROTTLE_DRAIN * driveFrac * Math.min(1, Math.abs(vf) / 60 + 0.4)) *
      (hand ? T.HB_REAR : 1);

    const frontSlide = this.axle(1, delta, frontLimit, dt);
    const rearSlide = this.axle(-1, 0, rearLimit, dt);

    // yaw damping + cap: the "don't spin out" guards
    this.spin *= Math.exp(-T.OMEGA_DAMP * dt);
    if (this.spin > T.OMEGA_MAX) this.spin = T.OMEGA_MAX;
    else if (this.spin < -T.OMEGA_MAX) this.spin = -T.OMEGA_MAX;
    this.heading += this.spin * dt;

    // skid intensity drives smoke, marks and sound (rear-biased)
    let target = 0;
    if (rearSlide > 1) target = Math.min(1, (rearSlide - 1) * 0.8 + 0.3);
    if (frontSlide > 1) target = Math.max(target, 0.3);
    if (hand && Math.abs(vf) > 50) target = Math.max(target, 0.5);
    this.skidLevel += (target - this.skidLevel) * Math.min(1, 14 * dt);

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.collideWorld(env);
    this.collideProps(env);
  }

  // One tire pass: a damper that cancels the axle's lateral velocity,
  // capped by grip. Past the cap the tire slides and keeps only KINETIC of
  // the limit. Applies force to velocity AND torque to spin, so rear
  // breakaway rotates the car into a drift and the front catches it.
  // Returns demand/limit — above 1 means this axle is sliding.
  axle(sign, delta, limit, dt) {
    const fwd = this.forward(), right = this.rightVec();
    const rx = fwd[0] * AXLE * sign, ry = fwd[1] * AXLE * sign;
    // this axle's ground velocity = body velocity + spin x r
    const avx = this.vx - this.spin * ry;
    const avy = this.vy + this.spin * rx;
    // wheel sideways direction (front axle rotated by steering angle)
    const cs = Math.cos(delta), sn = Math.sin(delta);
    const wrx = right[0] * cs - right[1] * sn;
    const wry = right[0] * sn + right[1] * cs;
    const lat = avx * wrx + avy * wry;
    const demand = T.K_LAT * lat;
    const excess = Math.abs(demand) / limit;
    const a = excess > 1 ? Math.sign(demand) * limit * T.KINETIC : demand;
    // half the mass rides on each axle
    this.vx -= wrx * a * dt * 0.5;
    this.vy -= wry * a * dt * 0.5;
    this.spin += (rx * wry - ry * wrx) * -0.5 * a / T.INERTIA * dt;
    return excess;
  }

  collideWorld(env) {
    const world = env.world;
    const cs = Math.cos(this.heading), sn = Math.sin(this.heading);
    let hitX = 0, hitY = 0, nX = 0, nY = 0, hits = 0;
    for (const [lx, ly] of this.hull) {
      const wx = this.x + lx * cs - ly * sn;
      const wy = this.y + lx * sn + ly * cs;
      if (!world.solidAt(wx, wy)) continue;
      hits++;
      hitX += wx; hitY += wy;
      nX += (world.solidAt(wx - 3, wy) ? 1 : 0) - (world.solidAt(wx + 3, wy) ? 1 : 0);
      nY += (world.solidAt(wx, wy - 3) ? 1 : 0) - (world.solidAt(wx, wy + 3) ? 1 : 0);
    }
    if (!hits) return;
    hitX /= hits; hitY /= hits;
    let nl = Math.hypot(nX, nY);
    if (nl < 0.01) {
      nX = this.x - hitX; nY = this.y - hitY;
      nl = Math.hypot(nX, nY) || 1;
    }
    nX /= nl; nY /= nl;

    const vn = this.vx * nX + this.vy * nY;
    const impact = Math.max(0, -vn);
    if (vn < 0) {
      this.vx -= 1.45 * vn * nX;
      this.vy -= 1.45 * vn * nY;
      // torque from off-center hit
      const rx = hitX - this.x, ry = hitY - this.y;
      this.spin += (rx * nY - ry * nX) * impact * 0.004;
    }
    // push out
    for (let i = 0; i < 8; i++) {
      let stuck = false;
      for (const [lx, ly] of this.hull) {
        const wx = this.x + lx * cs - ly * sn;
        const wy = this.y + lx * sn + ly * cs;
        if (world.solidAt(wx, wy)) { stuck = true; break; }
      }
      if (!stuck) break;
      this.x += nX * 1.2;
      this.y += nY * 1.2;
    }

    if (impact > 30) {
      const dmg = (impact - 30) * 0.085;
      this.addDamage(dmg, env);
      // chip the building — a bigger crater and higher clear-out chance the
      // more destructive the vehicle (a tank tears through walls)
      const destroyed = world.damage(hitX, hitY,
        (2 + impact / 45) * this.smashMul,
        Math.min(0.98, impact / 130 * this.smashMul));
      for (const col of destroyed) env.particles.debris(hitX, hitY, col, 1, 70);
      env.stats.cellsDestroyed += destroyed.length;
      this.deformAtWorld(hitX, hitY, Math.min(1, impact / 190), env);
      env.particles.sparks(hitX, hitY, 4);
      env.sound.crash(impact / 170);
      countWreck(env);
      env.camera.addTrauma(Math.min(0.75, impact / 190) * this.shakeMul);
      world.decal(hitX, hitY, (g) => {
        g.fillStyle = 'rgba(15,15,18,0.35)';
        g.fillRect(-3, -3, 6, 6);
      });
    } else if (this.speed() > 40) {
      // scraping along a wall
      env.stats.t - this.lastScrape > 0.12 && env.particles.sparks(hitX, hitY, 2);
      this.lastScrape = env.stats.t;
      this.addDamage(6 * (1 / 60), env);
    }
  }

  collideProps(env) {
    const props = env.world.propsNear(this.x, this.y, 18, env._propBuf || (env._propBuf = []));
    if (!props.length) return;
    const fwd = this.forward();
    const c1 = [this.x + fwd[0] * this.collOff, this.y + fwd[1] * this.collOff];
    const c2 = [this.x - fwd[0] * this.collOff, this.y - fwd[1] * this.collOff];
    for (const p of props) {
      for (const c of [c1, c2]) {
        const dx = p.x - c[0], dy = p.y - c[1];
        const d = Math.hypot(dx, dy);
        const rr = p.r + this.collR;
        if (d >= rr) continue;
        const nx = d > 0.01 ? dx / d : 1, ny = d > 0.01 ? dy / d : 0;
        const approach = this.vx * nx + this.vy * ny; // speed toward prop
        // destructive vehicles smash even sturdy props at low speed
        if (approach > p.breakAt / this.smashMul) {
          env.world.breakProp(p, env.particles, env.sound);
          this.addDamage(p.dmg, env);
          env.stats.propsSmashed++;
          env.camera.addTrauma((0.12 + p.dmg * 0.03) * this.shakeMul);
          this.vx *= PROP_SMASH_KEEP; this.vy *= PROP_SMASH_KEEP;
          if (p.dmg >= 4) this.deformAtWorld(p.x, p.y, 0.35, env);
        } else {
          // solid bollard: bounce off
          const push = rr - d;
          this.x -= nx * push; this.y -= ny * push;
          if (approach > 0) {
            this.vx -= 1.6 * approach * nx;
            this.vy -= 1.6 * approach * ny;
            if (approach > 35) {
              this.addDamage((approach - 30) * 0.05, env);
              this.deformAtWorld(p.x, p.y, Math.min(0.6, approach / 220), env);
              env.particles.sparks(p.x, p.y, 3);
              env.sound.thud();
              env.camera.addTrauma(Math.min(0.4, approach / 260) * this.shakeMul);
            }
          }
        }
        break;
      }
    }
  }

  deformAtWorld(wx, wy, power, env) {
    const dx = wx - this.x, dy = wy - this.y;
    const cs = Math.cos(this.heading), sn = Math.sin(this.heading);
    const lx = dx * cs + dy * sn + this.body.w / 2;
    const ly = -dx * sn + dy * cs + this.body.h / 2;
    const removed = this.body.deform(lx, ly, power);
    for (const col of removed) if (col) env.particles.debris(wx, wy, col, 1, 90);
  }

  draw(ctx, camX, camY) {
    ctx.save();
    ctx.translate(Math.round(this.x - camX), Math.round(this.y - camY));
    ctx.rotate(this.heading);
    ctx.drawImage(this.body.canvas, -this.body.w / 2, -this.body.h / 2);
    ctx.restore();
  }
}
