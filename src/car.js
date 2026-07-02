// Cars are grids of individual pixels ("voxels"). Collisions dent and tear
// pixels off. The player car uses an arcade drift model tuned to oversteer.

export const CAR_W = 13, CAR_H = 24;

const PROFILE = [7, 9, 11, 11, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 11, 11, 11, 9, 9];

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
  constructor(baseCol, stripeCol) {
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
    ];
    this.dentCols = this.cols.map(c => c ? shade(c.startsWith('rgb') ? baseCol : c, 0.45) : null);
    // fix dent colors for rgb() entries properly
    this.dentCols = this.cols.map(c => {
      if (!c) return null;
      if (c.startsWith('#')) return shade(c, 0.45);
      return 'rgb(40,40,44)';
    });

    const W = CAR_W, H = CAR_H;
    this.w = W; this.h = H;
    this.px = new Uint8Array(W * H);
    this.dent = new Uint8Array(W * H);

    const set = (x, y, v) => { if (x >= 0 && x < W && y >= 0 && y < H) this.px[y * W + x] = v; };
    const get = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 0 : this.px[y * W + x];

    for (let y = 0; y < H; y++) {
      const w = PROFILE[y], x0 = (W - w) >> 1;
      for (let x = x0; x < x0 + w; x++) set(x, y, 1);
    }
    // outline: body pixels touching empty become dark
    const outline = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (get(x, y) === 1 && (!get(x - 1, y) || !get(x + 1, y) || !get(x, y - 1) || !get(x, y + 1))) outline.push([x, y]);
    }
    for (const [x, y] of outline) set(x, y, 2);
    // windshield / roof / rear window
    for (let y = 6; y <= 9; y++) {
      const w = PROFILE[y], x0 = (W - w) >> 1;
      for (let x = x0 + 2; x < x0 + w - 2; x++) set(x, y, y === 6 ? 5 : 4);
    }
    for (let y = 10; y <= 14; y++) {
      const w = PROFILE[y], x0 = (W - w) >> 1;
      for (let x = x0 + 2; x < x0 + w - 2; x++) set(x, y, x === 6 ? 3 : 1);
    }
    for (let y = 15; y <= 16; y++) {
      const w = PROFILE[y], x0 = (W - w) >> 1;
      for (let x = x0 + 2; x < x0 + w - 2; x++) set(x, y, 4);
    }
    // racing stripe
    if (stripeCol) {
      for (let y = 1; y < H - 1; y++) {
        for (const x of [5, 7]) if (get(x, y) === 1 || get(x, y) === 3) set(x, y, 6);
      }
    }
    // wheels
    for (const ys of [[4, 7], [17, 20]]) {
      for (let y = ys[0]; y <= ys[1]; y++) {
        for (const x of [0, 1, 11, 12]) if (get(x, y)) set(x, y, 7);
      }
    }
    // lights
    for (const x of [4, 5, 7, 8]) set(x, 0, 8);
    for (const x of [3, 4, 8, 9]) set(x, 23, 9);

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

// Hull sample points (local coords, car center at 0,0) for world collision.
const HULL = [];
{
  const hw = CAR_W / 2 - 0.5, hh = CAR_H / 2 - 0.5;
  HULL.push([0, -hh], [-hw + 2, -hh + 1], [hw - 2, -hh + 1]);            // nose
  HULL.push([-hw, -hh + 6], [hw, -hh + 6], [-hw, 0], [hw, 0]);          // sides
  HULL.push([-hw, hh - 6], [hw, hh - 6]);
  HULL.push([0, hh], [-hw + 2, hh - 1], [hw - 2, hh - 1]);              // tail
}

const VMAX = 260;
const ACCEL = 195;
const BRAKE = 340;
const REV_MAX = 80;
const DRAG = 0.34;

// Two-axle drift model. Each axle tries to cancel its lateral velocity
// (a damper, gain K_LAT) but the correcting force is capped by that axle's
// grip. Past the cap the tire slides and only KINETIC of the limit remains
// — that static->kinetic drop is what makes slides progressive and easy to
// hold. Throttle drains rear grip (traction circle -> power slides) and the
// handbrake all but removes it. Yaw is integrated for real: rear breakaway
// rotates the car into the drift, and finite front grip lets counter-steer
// catch it.
const AXLE = 8;          // half wheelbase (px)
const INERTIA = 48;
const K_LAT = 16;        // lateral damping gain (1/s); higher = snappier grip
const GRIP_F = 250;      // front axle grip limit (px/s^2)
const GRIP_R = 295;      // rear axle grip limit
const KINETIC = 0.5;     // grip fraction left once a tire lets go
const HB_REAR = 0.14;    // rear grip fraction under handbrake
const THROTTLE_DRAIN = 0.5; // how much full throttle eats rear grip
const STEER_MAX = 0.55;  // max wheel angle (rad), fades with speed
const STEER_RATE = 10;        // base wheel-swing speed (1/s) when gripping
const STEER_RATE_DRIFT = 13; // extra swing speed added at full slide (catch counter-steer)
const OMEGA_DAMP = 0.9;  // yaw damping (spin-out protection)
const OMEGA_MAX = 3.2;
// Speed kept when plowing through a prop. Props are soft (see PROP_SOFTNESS in
// world.js): 10% of the former 8% scrub, so smashing one barely slows you.
const PROP_SMASH_KEEP = 1 - 0.08 * 0.1; // = 0.992

export class PlayerCar {
  constructor(x, y, heading) {
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
    this.body = new CarBody('#c23b3b', '#e8e8e8');
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
    this.damage = Math.min(100, this.damage + d);
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
    const rate = STEER_RATE + this.skidLevel * STEER_RATE_DRIFT; // ~7 gripping, ~20 in a full slide
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
    if (throttle) {
      vf += ACCEL * (1 - 0.55 * Math.max(0, vf) / VMAX) * dt;
      driveFrac = 1;
    }
    if (brake) {
      if (vf > 5) vf -= BRAKE * dt;
      else vf = Math.max(-REV_MAX, vf - ACCEL * 0.55 * dt);
    }
    vf -= vf * DRAG * surf * dt;
    if (hand) vf *= Math.exp(-0.6 * dt); // locked rears scrub speed
    this.vx = fwd[0] * vf + right[0] * vl0;
    this.vy = fwd[1] * vf + right[1] * vl0;

    // --- steering: wheel angle shrinks with speed for high-speed stability,
    // but a slide restores most of that lock so you keep the authority to
    // counter-steer and hold the drift ---
    const speedAtten = 1 + (Math.abs(vf) / 170) * (1 - 0.75 * this.skidLevel);
    const delta = this.steerS * STEER_MAX / speedAtten;

    // --- axle grip limits (traction circle: throttle drains the rear) ---
    const gscale = 1 / Math.sqrt(surf); // grass/dirt slide much sooner
    const frontLimit = GRIP_F * gscale;
    const rearLimit = GRIP_R * gscale *
      (1 - THROTTLE_DRAIN * driveFrac * Math.min(1, Math.abs(vf) / 60 + 0.4)) *
      (hand ? HB_REAR : 1);

    const frontSlide = this.axle(1, delta, frontLimit, dt);
    const rearSlide = this.axle(-1, 0, rearLimit, dt);

    // yaw damping + cap: the "don't spin out" guards
    this.spin *= Math.exp(-OMEGA_DAMP * dt);
    if (this.spin > OMEGA_MAX) this.spin = OMEGA_MAX;
    else if (this.spin < -OMEGA_MAX) this.spin = -OMEGA_MAX;
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
    const demand = K_LAT * lat;
    const excess = Math.abs(demand) / limit;
    const a = excess > 1 ? Math.sign(demand) * limit * KINETIC : demand;
    // half the mass rides on each axle
    this.vx -= wrx * a * dt * 0.5;
    this.vy -= wry * a * dt * 0.5;
    this.spin += (rx * wry - ry * wrx) * -0.5 * a / INERTIA * dt;
    return excess;
  }

  collideWorld(env) {
    const world = env.world;
    const cs = Math.cos(this.heading), sn = Math.sin(this.heading);
    let hitX = 0, hitY = 0, nX = 0, nY = 0, hits = 0;
    for (const [lx, ly] of HULL) {
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
      for (const [lx, ly] of HULL) {
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
      // chip the building
      const destroyed = world.damage(hitX, hitY, 2 + impact / 45, Math.min(0.9, impact / 130));
      for (const col of destroyed) env.particles.debris(hitX, hitY, col, 1, 70);
      env.stats.cellsDestroyed += destroyed.length;
      this.deformAtWorld(hitX, hitY, Math.min(1, impact / 190), env);
      env.particles.sparks(hitX, hitY, 4);
      env.sound.crash(impact / 170);
      env.camera.addTrauma(Math.min(0.75, impact / 190));
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
    const c1 = [this.x + fwd[0] * 6, this.y + fwd[1] * 6];
    const c2 = [this.x - fwd[0] * 6, this.y - fwd[1] * 6];
    for (const p of props) {
      for (const c of [c1, c2]) {
        const dx = p.x - c[0], dy = p.y - c[1];
        const d = Math.hypot(dx, dy);
        const rr = p.r + 6.5;
        if (d >= rr) continue;
        const nx = d > 0.01 ? dx / d : 1, ny = d > 0.01 ? dy / d : 0;
        const approach = this.vx * nx + this.vy * ny; // speed toward prop
        if (approach > p.breakAt) {
          env.world.breakProp(p, env.particles, env.sound);
          this.addDamage(p.dmg, env);
          env.stats.propsSmashed++;
          env.camera.addTrauma(0.12 + p.dmg * 0.03);
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
              env.camera.addTrauma(Math.min(0.4, approach / 260));
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
    const lx = dx * cs + dy * sn + CAR_W / 2;
    const ly = -dx * sn + dy * cs + CAR_H / 2;
    const removed = this.body.deform(lx, ly, power);
    for (const col of removed) if (col) env.particles.debris(wx, wy, col, 1, 90);
  }

  draw(ctx, camX, camY) {
    ctx.save();
    ctx.translate(Math.round(this.x - camX), Math.round(this.y - camY));
    ctx.rotate(this.heading);
    ctx.drawImage(this.body.canvas, -CAR_W / 2, -CAR_H / 2);
    ctx.restore();
  }
}
