// AI traffic: cars cruise lanes on the road grid, stop for red lights and
// obstacles, turn at intersections along bezier arcs, and switch to loose
// physics when the player slams into them. Parked cars use the same bodies.

import { CarBody, CAR_W, CAR_H, AI_COLORS } from './car.js';
import { hash3 } from './rng.js';

const TARGET_AI = 13;
const DESPAWN_R = 580;

// Right-hand lane centre offset from a road's centreline, for road index k.
// Scales with the road's half-width and lane count: a highway has a painted
// median plus N lanes each way, a local road one lane; bikes hug the curb
// whatever the width. `li` selects the lane (0 = innermost, next to centre).
function laneOff(axis, k, li, bike) {
  const m = axis.meta(k);
  if (bike) return m.half - 4;
  const median = m.hwy ? 4 : 0;
  const lw = (m.half - median) / m.lanes;
  return median + lw * (Math.min(li || 0, m.lanes - 1) + 0.5);
}

const BIKE_SHIRTS = ['#d24b4b', '#3f78d2', '#3fae55', '#d2a53a', '#8f4fd2', '#31b0b0'];
const BIKE_SKIN = ['#caa07a', '#a5744c', '#e3b98f', '#8a5a34'];
const BIKE_FRAMES = ['#2a2a30', '#39424e', '#4a2f2f', '#2f4a3a'];

// AI vehicle roster. len/wid drive collision footprint & drawing; mass makes
// the big rigs shove the player around; hp sets how much abuse they take.
// Motorcycles are pedestrian-class: barely any weight, and one hit ends them.
const TYPES = {
  car:        { len: 24, wid: 13, cruiseLo: 55, cruiseHi: 90,  mass: 1, hpLo: 55,  hpHi: 85 },
  police:     { len: 24, wid: 13, cruiseLo: 62, cruiseHi: 96,  mass: 1, hpLo: 190, hpHi: 215 },
  motorcycle: { len: 14, wid: 5,  cruiseLo: 62, cruiseHi: 104, mass: 0.25, hpLo: 2, hpHi: 5 },
  schoolbus:  { len: 46, wid: 14, cruiseLo: 40, cruiseHi: 56,  mass: 8,  hpLo: 150, hpHi: 210 },
  citybus:    { len: 48, wid: 14, cruiseLo: 40, cruiseHi: 56,  mass: 8,  hpLo: 150, hpHi: 210 },
  dumptruck:  { len: 34, wid: 15, cruiseLo: 46, cruiseHi: 66,  mass: 7,  hpLo: 160, hpHi: 220 },
  gastruck:   { len: 56, wid: 14, cruiseLo: 42, cruiseHi: 60,  mass: 10, hpLo: 170, hpHi: 230 },
  bike:       { len: 11, wid: 4,  cruiseLo: 30, cruiseHi: 46,  mass: 1, hpLo: 1,   hpHi: 4 },
};
// spawn probabilities (cumulative); the remainder to 1.0 is plain cars
const SPAWN_MIX = [
  ['bike', 0.20], ['motorcycle', 0.08], ['schoolbus', 0.06],
  ['citybus', 0.06], ['dumptruck', 0.06], ['gastruck', 0.05], ['police', 0.05],
];
function pickType(r) {
  let acc = 0;
  for (const [kind, p] of SPAWN_MIX) { acc += p; if (r < acc) return kind; }
  return 'car';
}

function qbez(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

// heading convention: 0 = up (-y), increases clockwise
function headingOf(dx, dy) { return Math.atan2(dx, -dy); }

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// A "wreck" infraction: any major collision (car-to-car or into a building).
// Shared 0.6s debounce so one crash counts once even with several contacts.
export function countWreck(env) {
  const s = env.stats;
  if (!s || !s.infractions) return;
  if (env.t - (s.lastWreckT || -10) < 0.6) return;
  s.lastWreckT = env.t;
  s.infractions.wreck++;
  s.lastInfractionT = env.t;
}

let uid = 1;

export class AICar {
  constructor(x, y, opts = {}) {
    this.id = uid++;
    this.x = x; this.y = y;
    this.heading = opts.heading || 0;
    this.mode = opts.mode || 'drive'; // drive | turn | shove | idle | wreck | parked
    this.axis = opts.axis || 'v';
    this.k = opts.k || 0;
    this.dir = opts.dir || 1;
    this.speed = 0;
    this.vx = 0; this.vy = 0;
    this.spinv = 0;
    this.dodge = 0;   // lateral evasive offset from the lane centre
    this.bypass = 0; this.bypassTarget = null; this.waitT = 0; // dead-blocker overtake
    this.shoveT = 0;
    this.action = 'straight';
    this.turn = null;
    this.parkedOrigin = this.mode === 'parked';
    const scheme = opts.kind === 'police'
      ? ['#e3e7ec', '#16161c']                                     // black-and-white cruiser
      : AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)];
    this.body = new CarBody(scheme[0], scheme[1]);
    this.smokeAcc = 0;
    this.honkT = Math.random() * 4;   // horn cooldown

    // vehicle type — same lane/light/turn rules for all, differing in size
    // (collision footprint via half/rad), speed, mass, durability and looks.
    this.type = opts.kind || 'car';
    this.bike = this.type === 'bike';
    const cfg = TYPES[this.type] || TYPES.car;
    this.half = cfg.len / 2; this.rad = cfg.wid / 2;
    this.mass = cfg.mass;
    this.cruise = cfg.cruiseLo + Math.random() * (cfg.cruiseHi - cfg.cruiseLo);
    this.hp = cfg.hpLo + Math.random() * (cfg.hpHi - cfg.hpLo);
    this.maxHp = this.hp;           // for the little on-screen damage meter
    this.laneIndex = opts.laneIndex || 0;  // which lane (0 = next to centreline)
    if (this.bike || this.type === 'motorcycle') { // has a visible rider
      this.frame = BIKE_FRAMES[Math.floor(Math.random() * BIKE_FRAMES.length)];
      this.shirt = BIKE_SHIRTS[Math.floor(Math.random() * BIKE_SHIRTS.length)];
      this.skin = BIKE_SKIN[Math.floor(Math.random() * BIKE_SKIN.length)];
    }
    if (this.type === 'gastruck') {   // articulated: cab + hinged tank trailer
      this.cabLen = 16;               // cab length
      this.trailerLen = 34;           // tank length, hitch → rear
      this.hitch = 8;                 // hitch distance behind the cab center
      this.trailerHeading = this.heading;
      this.trailerRear = null;        // rear-axle world point (lazily initialised)
    }
    if (this.type === 'police') {
      this.police = true;
      // Flip `pursuit` on and the roof light bar flashes red/blue; patrol cars
      // run the normal traffic rules until then.
      this.pursuit = false;
      this.lightT = 0;
      this.chaseT = 0;   // time spent in active pursuit — feeds desperation
    }
    // every motor vehicle goes up in a fireball (with splash damage) when
    // destroyed; two-wheelers (pedal bikes and motorcycles) just crumple —
    // a motorcycle is basically a pedestrian with an engine
    this.canExplode = this.type !== 'bike' && this.type !== 'motorcycle';
  }

  // Blast strength when destroyed — scales with the vehicle's weight and
  // length, so heavier/larger vehicles make bigger fireballs. The fuel tanker
  // gets an extra multiplier on top: it's huge.
  explodePower() {
    const size = 0.5 + (this.mass || 1) * 0.14 + this.half * 0.028;
    return this.type === 'gastruck' ? size * 1.4 : size;
  }

  dirVec() { return this.axis === 'v' ? [0, this.dir] : [this.dir, 0]; }

  velocity() {
    if (this.mode === 'shove' || this.mode === 'pursue') return [this.vx, this.vy];
    if (this.mode === 'drive' || this.mode === 'turn') {
      const f = [Math.sin(this.heading), -Math.cos(this.heading)];
      return [f[0] * this.speed, f[1] * this.speed];
    }
    return [0, 0];
  }

  chooseAction() {
    const r = Math.random();
    this.action = r < 0.55 ? 'straight' : r < 0.8 ? 'right' : 'left';
  }

  // Pursuit driving: intercept the player and ram, swerving around buildings.
  // Ignores lanes/lights entirely — it's trying to wreck you.
  updatePursue(dt, env) {
    const world = env.world, player = env.player;
    // Desperation: the longer this cruiser has been chasing, the more unhinged
    // it gets — faster, tighter steering, and less and less willing to steer
    // around anything it could just smash through. Fully rabid after ~45s.
    this.chaseT = (this.chaseT || 0) + dt;
    const desp = Math.min(1, this.chaseT / 45);
    this.desp = desp;   // light bar flash rate tracks it
    // lead the target (aim where they're going) so the cruiser cuts you off
    // and slams into you instead of trailing behind
    const dist = Math.hypot(player.x - this.x, player.y - this.y) || 1;
    const lead = Math.min(0.55, dist / 320);
    // each cruiser aims at its own flank of the target, so a pack spreads out
    // instead of piling onto one point; the offset collapses to a pure ram as
    // it closes in
    const flank = ((this.id % 5) - 2) * 15 * Math.min(1, Math.max(0, (dist - 70) / 140));
    const pdx = (player.x - this.x) / dist, pdy = (player.y - this.y) / dist;
    const tx = player.x + player.vx * lead - pdy * flank;
    const ty = player.y + player.vy * lead + pdx * flank;
    const dx = tx - this.x, dy = ty - this.y;
    let desired = headingOf(dx, dy);

    // obstacle avoidance: cast forward whiskers that detect buildings AND
    // vehicles (parked cars, traffic, other cruisers) and steer around whatever
    // is in the way, easing off the throttle as it closes in. Moving vehicles
    // are checked at where they'll BE when the cruiser reaches each whisker
    // point, so it threads through traffic instead of dodging stale positions.
    // A desperate cop stops looking as far ahead (corner-cutting)...
    const look = (24 + this.speed * 0.5) * (1 - 0.3 * desp);
    const near = [], nearV = [], nearR = [];
    for (const o of env.obstacles) {
      if (o === this || o === player || o.exploded) continue;
      if ((o.x - this.x) ** 2 + (o.y - this.y) ** 2 < (look + 32) * (look + 32)) {
        near.push(o);
        nearV.push(o.velocity ? o.velocity() : [o.vx || 0, o.vy || 0]);
        // ...and light vehicles fade out of its whiskers entirely: at full
        // desperation it plows straight through cars and bikes, only still
        // swerving for buildings and the big rigs that would stop it dead.
        const rr = (o.rad || 6) + 7;
        nearR.push((o.mass || 1) > 2 ? rr : rr * (1 - 0.85 * desp));
      }
    }
    const spd = Math.max(20, this.speed);
    const clearDist = (ang) => {
      const s = Math.sin(this.heading + ang), c = -Math.cos(this.heading + ang);
      for (let d = 8; d <= look; d += 4) {
        const px = this.x + s * d, py = this.y + c * d;
        if (world.solidAt(px, py)) return d;
        const t = d / spd;   // seconds until the cruiser is here
        for (let i = 0; i < near.length; i++) {
          const o = near[i], ox = o.x + nearV[i][0] * t, oy = o.y + nearV[i][1] * t;
          const rr = nearR[i];
          if ((ox - px) ** 2 + (oy - py) ** 2 < rr * rr) return d;
        }
      }
      return look + 1;
    };
    // five whiskers: a centre cone decides "blocked", wide feelers tell us
    // which side actually has room
    const cC = clearDist(0), cL1 = clearDist(-0.3), cR1 = clearDist(0.3);
    const cL = Math.max(cL1, clearDist(-0.65)), cR = Math.max(cR1, clearDist(0.65));
    const nearest = Math.min(cC, cL1, cR1);
    const blocked = nearest <= look;
    if (blocked) {
      // hysteresis: stick with the side we already committed to unless the
      // other side is clearly better — kills the frame-to-frame zigzag
      let side = this.swerve || 0;
      if (!side || (side < 0 ? cR > cL * 1.35 : cL > cR * 1.35)) side = cL >= cR ? -1 : 1;
      this.swerve = side;
      this.swerveT = 0.4;
      const strength = 0.5 + 0.7 * (1 - nearest / look);   // sharper when closer
      desired = this.heading + side * strength;
    } else {
      this.swerveT = (this.swerveT || 0) - dt;
      if (this.swerveT <= 0) this.swerve = 0;
    }

    // steer the nose toward the target (faster when dodging, twitchier when
    // desperate) — hard swerves break the back loose into a drift
    this.heading = lerpAngle(this.heading, desired, Math.min(1, (blocked ? 8 + 2 * desp : 6 + 2 * desp) * dt));

    // drift model: thrust along the heading, but only bleed sideways velocity
    // slowly (limited grip) — the car slides through turns
    const fwd = [Math.sin(this.heading), -Math.cos(this.heading)];
    const rgt = [Math.cos(this.heading), Math.sin(this.heading)];
    let vf = this.vx * fwd[0] + this.vy * fwd[1];   // forward speed
    let vl = this.vx * rgt[0] + this.vy * rgt[1];   // lateral (slide) speed
    // lunge to ram only when the way to the player is clear; otherwise ease
    // off — though a desperate cop runs hotter and barely lifts for anything
    let top = this.cruise + desp * 20 + (!blocked && dist < 130 + 90 * desp ? 55 : 0);
    if (blocked) top = Math.min(top, this.cruise * Math.min(1, 0.4 + 0.5 * (nearest / look) + 0.55 * desp));
    // corner throttle: lift in proportion to how far the nose is from where
    // we want to go, so the cruiser arcs onto the target instead of orbiting
    // past it at full tilt — a desperate cop lifts less and drifts more
    let aerr = Math.abs(desired - this.heading) % (Math.PI * 2);
    if (aerr > Math.PI) aerr = Math.PI * 2 - aerr;
    top *= 1 - (0.45 - 0.2 * desp) * Math.min(1, aerr / 1.2);
    vf = Math.min(top, vf + 200 * dt);
    vf *= Math.exp(-0.3 * dt);
    vl *= Math.exp(-3.0 * dt);                       // grip: how fast the slide scrubs off
    this.vx = fwd[0] * vf + rgt[0] * vl;
    this.vy = fwd[1] * vf + rgt[1] * vl;
    this.x += this.vx * dt; this.y += this.vy * dt;
    // soft ground bogs the cruiser just like it bogs the player — grass slows
    // it down, and a lake is a genuine trap for an over-eager cop
    const sdrag = world.surfaceDrag(this.x, this.y);
    if (sdrag > 1.05) {
      const f2 = Math.exp(-(sdrag - 1) * 1.1 * dt);
      this.vx *= f2; this.vy *= f2;
    }
    this.speed = Math.hypot(this.vx, this.vy);

    // hard resolve + damage if we plow into a building
    if (world.solidAt(this.x, this.y)) {
      let nx = (world.solidAt(this.x - 3, this.y) ? 1 : 0) - (world.solidAt(this.x + 3, this.y) ? 1 : 0);
      let ny = (world.solidAt(this.x, this.y - 3) ? 1 : 0) - (world.solidAt(this.x, this.y + 3) ? 1 : 0);
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      this.x += nx * 2; this.y += ny * 2;
      const imp = this.speed;                       // crash speed
      this.vx *= 0.5; this.vy *= 0.5; this.speed *= 0.5;
      if (imp > 25) {                               // reckless driving hurts
        this.hp -= (imp - 25) * 0.11;
        this.deformAtWorld(this.x - nx * 4, this.y - ny * 4, Math.min(0.7, imp / 220), env);
        env.particles.sparks(this.x - nx * 4, this.y - ny * 4, 3);
        env.sound.crash(imp / 280, this.x, this.y);
        if (this.hp <= 0) { this.explode(env, this.explodePower()); return; }
      }
    }

    // tyre smoke while drifting hard
    if (Math.abs(vl) > 22 && Math.random() < 0.5) {
      env.particles.tireSmoke(this.x, this.y, Math.min(1, Math.abs(vl) / 60));
    }
  }

  update(dt, env) {
    switch (this.mode) {
      case 'drive': this.updateDrive(dt, env); break;
      case 'turn': this.updateTurn(dt, env); break;
      case 'round': this.updateRound(dt, env); break;
      case 'pursue': this.updatePursue(dt, env); break;
      case 'shove': this.updateShove(dt, env); break;
      case 'wreck':
        this.smokeAcc += dt;
        if (this.smokeAcc > 0.12) {
          this.smokeAcc = 0;
          env.particles.engineSmoke(this.x + (Math.random() - 0.5) * 6, this.y + (Math.random() - 0.5) * 8, true);
          if (this.hp < -60 && Math.random() < 0.35) env.particles.fire(this.x, this.y);
        }
        break;
    }
    if (this.type === 'gastruck') this.updateTrailer();
    else if (this.police) this.lightT += dt;
    if (this.honkT > 0) this.honkT -= dt;
  }

  // Trailer follows the cab through a kingpin: the rear axle is held at a fixed
  // distance from the hitch and swings toward it, so the tank lags and bends
  // around corners like a real semi.
  updateTrailer() {
    const f = [Math.sin(this.heading), -Math.cos(this.heading)];
    const hx = this.x - f[0] * this.hitch, hy = this.y - f[1] * this.hitch; // hitch point
    if (!this.trailerRear) {
      this.trailerRear = [hx - f[0] * this.trailerLen, hy - f[1] * this.trailerLen];
      this.trailerHeading = this.heading;
      return;
    }
    let dx = hx - this.trailerRear[0], dy = hy - this.trailerRear[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;                             // unit rear→hitch
    this.trailerRear = [hx - dx * this.trailerLen, hy - dy * this.trailerLen];
    this.trailerHeading = Math.atan2(dx, -dy);        // 0 = up, same as headings
  }

  updateDrive(dt, env) {
    const world = env.world;
    const dv = this.dirVec();
    const axisA = this.axis === 'v' ? world.vA : world.hA;   // road we're on
    const axisB = this.axis === 'v' ? world.hA : world.vA;   // crossing roads
    const posAlong = this.axis === 'v' ? this.y : this.x;
    const posLat = this.axis === 'v' ? this.x : this.y;
    const roadC = axisA.centerAt(this.k, posAlong);      // curved centreline here

    // lane keeping: right-hand traffic
    // perp(dx,dy) = (-dy,dx): lane center = road center + perp*laneOff
    const perp = this.axis === 'v' ? -this.dir : this.dir;
    const laneC = roadC + perp * laneOff(axisA, this.k, this.laneIndex, this.bike);

    // Collision avoidance: project every nearby body's closest approach along
    // current velocities; anything on a converging course gets a swerve (a
    // lateral dodge away from the predicted miss point, clamped to the
    // pavement) and, if it's dead ahead and imminent, hard braking. This is
    // what makes traffic dive out of the player's way instead of eating the
    // hit.
    const mvx = dv[0] * this.speed, mvy = dv[1] * this.speed;
    let want = 0, panic = 0;
    for (const o of env.obstacles) {
      if (o === this || o.exploded) continue;
      const rx = o.x - this.x, ry = o.y - this.y;
      if (rx * rx + ry * ry > 140 * 140) continue;
      const ov = o.velocity ? o.velocity() : [o.vx || 0, o.vy || 0];
      const rvx = ov[0] - mvx, rvy = ov[1] - mvy;
      const rv2 = rvx * rvx + rvy * rvy;
      if (rv2 < 25) continue;                          // barely converging
      const t = -(rx * rvx + ry * rvy) / rv2;          // time of closest approach
      if (t < 0 || t > 1.3) continue;
      const mx = rx + rvx * t, my = ry + rvy * t;      // miss vector at that time
      const need = (this.rad || 7) + (o.rad || 7) + 3;
      const miss = Math.hypot(mx, my);
      if (miss >= need) continue;
      const u = (1 - t / 1.3) * (1 - miss / need);     // urgency 0..1
      const latMiss = this.axis === 'v' ? mx : my;     // which side it passes on
      want -= Math.sign(latMiss || (Math.random() - 0.5)) * 16 * u;
      // only threats in front of us also warrant braking
      if (rx * dv[0] + ry * dv[1] > 0) panic = Math.max(panic, u);
    }
    // pedestrians get the same look-ahead — they're small and near-stationary
    // at car speeds, so this reads as "brake and edge away", not a hard swerve
    if (env.peds) {
      for (const p of env.peds) {
        if (p.dead) continue;
        const rx = p.x - this.x, ry = p.y - this.y;
        if (rx * rx + ry * ry > 90 * 90) continue;
        const rv2 = mvx * mvx + mvy * mvy;
        if (rv2 < 25) continue;
        const t = (rx * mvx + ry * mvy) / rv2;         // closest approach to a standstill target
        if (t < 0 || t > 1.1) continue;
        const mx = rx - mvx * t, my = ry - mvy * t;
        const need = (this.rad || 7) + 5;
        const miss = Math.hypot(mx, my);
        if (miss >= need) continue;
        const u = (1 - t / 1.1) * (1 - miss / need);
        const latMiss = this.axis === 'v' ? mx : my;
        want -= Math.sign(latMiss || 1) * 12 * u;
        if (rx * dv[0] + ry * dv[1] > 0) panic = Math.max(panic, u);
      }
    }
    want += this.bypass || 0;   // active blocker bypass rides the same channel
    this.dodge += (Math.max(-24, Math.min(24, want)) - this.dodge) * Math.min(1, 5 * dt);
    const maxLat = axisA.half(this.k) - (this.rad || 4);
    const latT = Math.max(roadC - maxLat, Math.min(roadC + maxLat, laneC + this.dodge));
    // swerves pull to the target faster than routine lane keeping
    const latFix = (latT - posLat) * Math.min(1, (4 + 4 * Math.abs(this.dodge) / 16) * dt);

    // next crossing road
    const j = axisB.locate(posAlong);
    const jn = this.dir > 0 ? j + 1 : j;
    const crossC = axisB.center(jn);
    const crossHalf = axisB.half(jn);                    // width of the road ahead
    const stopAt = crossC - this.dir * (crossHalf + 16);
    const dStop = (stopAt - posAlong) * this.dir;

    // roundabout dead ahead → yield at the rim to circulating traffic, then
    // circulate instead of crossing/turning
    const rvi = this.axis === 'v' ? this.k : jn;
    const rhj = this.axis === 'v' ? jn : this.k;
    const rb = world.roundabout(rvi, rhj);
    let yieldTs = Infinity;
    if (rb) {
      const dc = Math.hypot(this.x - rb.cx, this.y - rb.cy);
      let busy = false;
      if (dc < rb.rOut + 30) {
        for (const o of env.obstacles) {
          if (o === this || o.mode !== 'round') continue;
          if (Math.hypot(o.x - this.x, o.y - this.y) < 50) { busy = true; break; }
        }
      }
      if (dc < rb.rOut + 3 && !busy) { this.beginRound(rb, rvi, rhj); return; }
      if (busy) yieldTs = Math.max(0, (dc - rb.rOut + 2) * 1.8);
    }

    let ts = this.cruise * axisA.speedMul(this.k);       // highways run faster
    if (yieldTs < Infinity) ts = Math.min(ts, yieldTs);

    // traffic light: brake from actual physics — start slowing once the stop
    // line enters our braking envelope, and only run a yellow when we
    // genuinely can't stop any more
    const vi = this.axis === 'v' ? this.k : jn;
    const hj = this.axis === 'v' ? jn : this.k;
    if (world.hasLight(vi, hj) && dStop > -2) {
      const brakeD = this.speed * this.speed / (2 * 110) + 8;
      if (dStop < Math.max(60, brakeD + 30)) {
        const ph = world.lightPhase(vi, hj, env.t);
        const st = this.axis === 'v' ? ph.ns : ph.ew;
        if (st === 'r' || (st === 'y' && dStop > brakeD * 0.8)) {
          // constant-decel speed profile down to the line
          ts = Math.min(ts, Math.sqrt(Math.max(0, dStop - 3) * 2 * 110));
          if (dStop < 3) ts = 0;
        }
      }
    }

    // unsignalled crossings: right-of-way — a local road yields to a highway,
    // and on equal-rank roads vertical yields to horizontal (a deterministic
    // tiebreak, so nobody T-bones and nobody deadlocks). Hold at the line
    // while anything with priority is bearing down on the intersection.
    const myHwy = axisA.meta(this.k).hwy, crossHwy = axisB.meta(jn).hwy;
    const mustYield = (crossHwy && !myHwy) || (crossHwy === myHwy && this.axis === 'v');
    if (!rb && mustYield && dStop > -2 && dStop < 70 && !world.hasLight(vi, hj)) {
      const ix = this.axis === 'v' ? axisA.centerAt(this.k, crossC) : crossC;
      const iy = this.axis === 'v' ? crossC : axisA.centerAt(this.k, crossC);
      for (const o of env.obstacles) {
        if (o === this) continue;
        const ov = o.velocity ? o.velocity() : [o.vx || 0, o.vy || 0];
        const os = Math.hypot(ov[0], ov[1]);
        if (os < 25) continue;
        const dxi = ix - o.x, dyi = iy - o.y;
        const di = Math.hypot(dxi, dyi) || 1;
        if (di > 170) continue;
        if ((ov[0] * dxi + ov[1] * dyi) / (os * di) < 0.7) continue;    // not heading here
        if (Math.abs(ov[0] * dv[0] + ov[1] * dv[1]) > os * 0.7) continue; // parallel → not cross traffic
        ts = Math.min(ts, Math.max(0, dStop) * 1.7);
        if (dStop < 3) ts = 0;
        break;
      }
    }

    // car-following, in the lane frame: only things roughly in our own lane
    // ahead matter, and we track the leader's speed at a speed-scaled gap.
    // (The old isotropic point-probe phantom-braked for the adjacent highway
    // lane and for close oncoming passes.)
    let blocked = false, copAhead = false, lead = null, leadAlong = 0, leadSpeed = 0;
    for (const o of env.obstacles) {
      if (o === this || o.exploded) continue;
      const cdx = o.x - this.x, cdy = o.y - this.y;
      const along = cdx * dv[0] + cdy * dv[1];
      if (along <= 0 || along > 30 + this.speed * 1.2) continue;
      const lat = (this.axis === 'v' ? o.x : o.y) - latT;  // vs where we're steering
      if (Math.abs(lat) > (this.rad || 7) + (o.rad || 7) + 2) continue;
      if (lead === null || along < leadAlong) {
        lead = o; leadAlong = along;
        const ov = o.velocity ? o.velocity() : [o.vx || 0, o.vy || 0];
        leadSpeed = Math.max(0, ov[0] * dv[0] + ov[1] * dv[1]);
      }
    }
    if (lead) {
      const gap = (this.half || 12) + (lead.half || 12) + 6 + this.speed * 0.25; // headway
      let follow = Math.max(0, leadSpeed + (leadAlong - gap) * 2.0);
      if (lead === this.bypassTarget) follow = Math.max(follow, 14);  // nose past the blocker
      ts = Math.min(ts, follow);
      if (leadAlong < gap + 6 && leadSpeed < 12) {
        blocked = true;
        if (lead.police) copAhead = true;
      }
    }
    // a lead that will never move (wreck, stranded or parked car) — or a
    // dawdling cyclist — can't be waited out. TTCA avoidance is blind to it
    // once we've stopped (nothing converges), so after a patient pause feed a
    // steady offset into the dodge channel and slip around.
    if (this.bypassTarget) {
      const b = this.bypassTarget;
      const along = (b.x - this.x) * dv[0] + (b.y - this.y) * dv[1];
      if (along < -((b.half || 12) + 6) || along > 120) {   // passed it (or it drove off)
        this.bypassTarget = null; this.bypass = 0; this.waitT = 0;
      }
    } else {
      const stuckLead = lead && (leadSpeed < 2
        ? (lead.mode === 'wreck' || lead.mode === 'idle' || lead.mode === 'parked' || lead.exploded)
        : (lead.bike === true && ts < this.cruise * 0.55));
      this.waitT = stuckLead ? (this.waitT || 0) + dt : 0;
      if (this.waitT > 2.2) {
        this.bypassTarget = lead;
        const latLead = (this.axis === 'v' ? lead.x : lead.y) - roadC;
        this.bypass = latLead >= posLat - roadC ? -24 : 24; // pass on the freer side
        this.waitT = 0;
      }
    }
    // stuck behind someone slow on a multi-lane road → change lanes when the
    // target lane is clear alongside and behind
    if (lead && ts < this.cruise * 0.5 && axisA.lanes(this.k) > 1) {
      this.stuckT = (this.stuckT || 0) + dt;
      if (this.stuckT > 1.3) {
        this.stuckT = 0.6;   // re-check soon, not every frame
        const cand = [];
        if (this.laneIndex > 0) cand.push(this.laneIndex - 1);
        if (this.laneIndex < axisA.lanes(this.k) - 1) cand.push(this.laneIndex + 1);
        for (const li of cand) {
          const c2 = roadC + perp * laneOff(axisA, this.k, li, this.bike);
          let clear = true;
          for (const o of env.obstacles) {
            if (o === this || o.exploded) continue;
            const along = (o.x - this.x) * dv[0] + (o.y - this.y) * dv[1];
            if (along < -30 || along > 60) continue;
            if (Math.abs((this.axis === 'v' ? o.x : o.y) - c2) < 16) { clear = false; break; }
          }
          if (clear) { this.laneIndex = li; this.stuckT = 0; break; }
        }
      }
    } else this.stuckT = 0;
    // panic braking on top of the swerve when a collision is imminent ahead
    if (panic > 0.25) ts = Math.min(ts, this.cruise * (1 - panic));
    // lay on the horn when something's stopped in front of you (city ambiance)
    // — but cops have sirens, not horns, and nobody honks at a cop; a hard
    // dodge also gets an angry honk
    if (((blocked && !copAhead) || panic > 0.55) && !this.police && this.honkT <= 0 && env.sound) {
      const dp = Math.hypot(this.x - env.player.x, this.y - env.player.y);
      if (dp < 320 && Math.random() < 0.5) { env.sound.honk(this.x, this.y); this.honkT = 1.6 + Math.random() * 2.6; }
    }

    // a left turn crosses the oncoming lane: hold short of the box for a gap
    const entry = crossC - this.dir * (crossHalf + 2);
    const dEntry = (entry - posAlong) * this.dir;
    const waitLeft = this.action === 'left' && dEntry > -10 && dEntry < 40 &&
      this.oncomingBlocks(env, dv);
    if (waitLeft) {
      ts = Math.min(ts, Math.max(0, dEntry - 2) * 1.7);
      if (dEntry < 3) ts = 0;
    }

    // eased throttle: soft rolloff approaching the target, gentle trims but
    // hard stops when braking — kills the lockstep surge-and-slam
    if (this.speed < ts) {
      const a = 45 + 60 * Math.min(1, (ts - this.speed) / 25);
      this.speed = Math.min(ts, this.speed + a * dt);
    } else {
      const d = 50 + Math.min(170, (this.speed - ts) * 5);
      this.speed = Math.max(ts, this.speed - d * dt);
    }

    // begin a turn?
    if (this.action !== 'straight' && dEntry <= 1 && dEntry > -10 && this.speed > 4 && !waitLeft) {
      this.beginTurn(env, crossC, jn);
      return;
    }
    // passed the intersection → decide the next move
    if ((crossC - posAlong) * this.dir < -(crossHalf + 20) && this.lastCross !== jn) {
      this.lastCross = jn;
      this.chooseAction();
    }

    // advance along the (possibly curved) road: move along the local tangent
    // — not the raw axis — so the body follows the bend instead of crabbing
    // and letting the lane-keeper drag it sideways
    const sl = axisA.slope(this.k, posAlong);
    const tvx = this.axis === 'v' ? sl * this.dir : this.dir;
    const tvy = this.axis === 'v' ? this.dir : sl * this.dir;
    const tl = Math.hypot(tvx, tvy);
    this.x += (tvx / tl) * this.speed * dt;
    this.y += (tvy / tl) * this.speed * dt;
    if (this.axis === 'v') this.x += latFix; else this.y += latFix;
    this.heading = lerpAngle(this.heading, headingOf(tvx, tvy), Math.min(1, 8 * dt));
  }

  // Any oncoming vehicle on our road close enough that turning left across
  // its lane would cut it off?
  oncomingBlocks(env, dv) {
    for (const o of env.obstacles) {
      if (o === this || o.exploded) continue;
      const cdx = o.x - this.x, cdy = o.y - this.y;
      const along = cdx * dv[0] + cdy * dv[1];
      if (along < 6 || along > 130) continue;
      if (Math.abs(this.axis === 'v' ? cdx : cdy) > 46) continue;  // not on our road
      const ov = o.velocity ? o.velocity() : [o.vx || 0, o.vy || 0];
      if (ov[0] * dv[0] + ov[1] * dv[1] < -20) return true;        // closing head-on
    }
    return false;
  }

  // Someone directly off the nose (used mid-turn/roundabout, where there is
  // no lane frame to reason in).
  maneuverBlocked(env) {
    const f = [Math.sin(this.heading), -Math.cos(this.heading)];
    const rgt = [Math.cos(this.heading), Math.sin(this.heading)];
    for (const o of env.obstacles) {
      if (o === this || o.exploded) continue;
      const dx = o.x - this.x, dy = o.y - this.y;
      const along = dx * f[0] + dy * f[1];
      if (along <= 0 || along > (this.half || 12) + (o.half || 12) + 12) continue;
      if (Math.abs(dx * rgt[0] + dy * rgt[1]) < (this.rad || 7) + (o.rad || 7) + 2) return true;
    }
    return false;
  }

  beginTurn(env, crossC, jn) {
    const world = env.world;
    const dv = this.dirVec();
    // right turn = rotate clockwise, left = counterclockwise
    const nd = this.action === 'right'
      ? [-dv[1], dv[0]]
      : [dv[1], -dv[0]];
    let exit, ctrl, nk, naxis, ndir, nli;
    if (this.axis === 'v') {
      naxis = 'h'; ndir = nd[0]; nk = jn;
      nli = Math.floor(Math.random() * world.hA.lanes(nk));     // pick an exit lane
      const myC = world.vA.centerAt(this.k, crossC);            // our x at the crossing
      const laneY = crossC + ndir * laneOff(world.hA, nk, nli, this.bike);
      exit = [myC + ndir * (world.vA.half(this.k) + 4), laneY];
      ctrl = [this.x, laneY];
    } else {
      naxis = 'v'; ndir = nd[1]; nk = jn;
      nli = Math.floor(Math.random() * world.vA.lanes(nk));
      const myC = world.hA.centerAt(this.k, crossC);
      const laneX = crossC - ndir * laneOff(world.vA, nk, nli, this.bike);
      exit = [laneX, myC + ndir * (world.hA.half(this.k) + 4)];
      ctrl = [laneX, this.y];
    }
    const p0 = [this.x, this.y];
    const len = 0.85 * (Math.hypot(ctrl[0] - p0[0], ctrl[1] - p0[1]) + Math.hypot(exit[0] - ctrl[0], exit[1] - ctrl[1]));
    this.turn = { p0, ctrl, exit, t: 0, len: Math.max(10, len), naxis, nk, ndir, nli };
    this.mode = 'turn';
  }

  // Roundabout: circulate around the central island (keeping it on the left)
  // and peel off at the leg picked by `action`. Legs sit every 90°, so a
  // quarter/half/three-quarter arc always lands squarely on a real road.
  beginRound(rb, vi, hj) {
    const cx = rb.cx, cy = rb.cy;
    const r = (rb.rIn + rb.rOut) / 2;
    const ang = Math.atan2(this.y - cy, this.x - cx);
    // circulation sign: whichever tangent direction agrees with our heading
    const fwd = [Math.sin(this.heading), -Math.cos(this.heading)];
    const tanCCW = [-Math.sin(ang), Math.cos(ang)];
    const sign = (fwd[0] * tanCCW[0] + fwd[1] * tanCCW[1]) >= 0 ? 1 : -1;
    const arc = this.action === 'right' ? Math.PI / 2 : this.action === 'left' ? Math.PI * 1.5 : Math.PI;
    this.round = { cx, cy, r, ang, sign, arc, done: 0, vi, hj };
    this.mode = 'round';
  }

  updateRound(dt, env) {
    const rd = this.round;
    // same patience pattern as turns: hold for a blocker, else settle to a
    // steady circulating pace instead of snapping to a speed floor
    const held = this.maneuverBlocked(env);
    this.stallT = held ? (this.stallT || 0) + dt : 0;
    const target = held && this.stallT < 2.5 ? 0 : Math.min(46, Math.max(26, this.cruise));
    const rate = target < this.speed ? (target === 0 ? 210 : 70) : 55;
    this.speed += Math.max(-rate * dt, Math.min(rate * dt, target - this.speed));
    if (this.speed <= 0.1) return;
    const step = this.speed * dt / rd.r;                        // radians this frame
    rd.ang += rd.sign * step;
    rd.done += step;
    this.x = rd.cx + Math.cos(rd.ang) * rd.r;
    this.y = rd.cy + Math.sin(rd.ang) * rd.r;
    // tangent heading in the direction of travel
    const tx = -Math.sin(rd.ang) * rd.sign, ty = Math.cos(rd.ang) * rd.sign;
    this.heading = lerpAngle(this.heading, headingOf(tx, ty), Math.min(1, 10 * dt));
    if (rd.done < rd.arc) return;

    // reached the exit leg: snap to the nearest cardinal and drive out
    const world = env.world;
    const a = ((rd.ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const quad = Math.round(a / (Math.PI / 2)) % 4;             // 0:E 1:S 2:W 3:N
    let naxis, nk, ndir;
    if (quad === 0)      { naxis = 'h'; nk = rd.hj; ndir = 1; }
    else if (quad === 2) { naxis = 'h'; nk = rd.hj; ndir = -1; }
    else if (quad === 1) { naxis = 'v'; nk = rd.vi; ndir = 1; }
    else                 { naxis = 'v'; nk = rd.vi; ndir = -1; }
    const axisN = naxis === 'v' ? world.vA : world.hA;
    this.axis = naxis; this.k = nk; this.dir = ndir;
    this.laneIndex = Math.floor(Math.random() * axisN.lanes(nk));
    // no lateral snap: the lane-keeper reels us onto the lane centre over the
    // next half second instead of teleporting sideways at the exit
    this.mode = 'drive';
    this.round = null;
    this.lastCross = undefined;
    this.chooseAction();
  }

  updateTurn(dt, env) {
    const tn = this.turn;
    // hold for anyone blocking the arc (with a patience timer so two turners
    // can't deadlock forever), otherwise settle smoothly onto cornering pace
    const held = this.maneuverBlocked(env);
    this.stallT = held ? (this.stallT || 0) + dt : 0;
    const target = held && this.stallT < 2.5 ? 0 : 32;
    const rate = target < this.speed ? (target === 0 ? 210 : 70) : 60;
    this.speed += Math.max(-rate * dt, Math.min(rate * dt, target - this.speed));
    if (this.speed <= 0.1) return;
    tn.t += this.speed * dt / tn.len;
    if (tn.t >= 1) {
      this.x = tn.exit[0]; this.y = tn.exit[1];
      this.axis = tn.naxis; this.k = tn.nk; this.dir = tn.ndir; this.laneIndex = tn.nli || 0;
      this.mode = 'drive';
      this.lastCross = undefined;
      this.chooseAction();
      return;
    }
    const [nx, ny] = qbez(tn.p0, tn.ctrl, tn.exit, tn.t);
    const dx = nx - this.x, dy = ny - this.y;
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) this.heading = headingOf(dx, dy);
    this.x = nx; this.y = ny;
  }

  updateShove(dt, env) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= Math.exp(-2.1 * dt);
    this.vy *= Math.exp(-2.1 * dt);
    // soft ground bogs a sliding car just like it bogs everything else
    const sdrag = env.world.surfaceDrag(this.x, this.y);
    if (sdrag > 1.05) {
      const f2 = Math.exp(-(sdrag - 1) * 1.4 * dt);
      this.vx *= f2; this.vy *= f2;
    }
    this.heading += this.spinv * dt;
    this.spinv *= Math.exp(-2.5 * dt);
    this.shoveT -= dt;

    // bounce off buildings
    const world = env.world;
    const f = [Math.sin(this.heading), -Math.cos(this.heading)];
    for (const off of [7, -7, 0]) {
      const wx = this.x + f[0] * off, wy = this.y + f[1] * off;
      if (!world.solidAt(wx, wy)) continue;
      let nx = (world.solidAt(wx - 3, wy) ? 1 : 0) - (world.solidAt(wx + 3, wy) ? 1 : 0);
      let ny = (world.solidAt(wx, wy - 3) ? 1 : 0) - (world.solidAt(wx, wy + 3) ? 1 : 0);
      const nl = Math.hypot(nx, ny);
      if (nl < 0.01) { nx = this.x - wx; ny = this.y - wy; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l; }
      else { nx /= nl; ny /= nl; }
      const vn = this.vx * nx + this.vy * ny;
      if (vn < 0) {
        this.vx -= 1.4 * vn * nx;
        this.vy -= 1.4 * vn * ny;
        const imp = -vn;
        this.hp -= imp * 0.4;
        if (imp > 40) {
          const destroyed = world.damage(wx, wy, 2 + imp / 60, Math.min(0.8, imp / 150));
          for (const col of destroyed) env.particles.debris(wx, wy, col, 1, 60);
          this.deformAtWorld(wx, wy, Math.min(0.8, imp / 200), env);
          env.sound.crash(imp / 260, this.x, this.y);
        }
        if (this.canExplode && this.hp <= 0) { this.explode(env, this.explodePower()); return; }
      }
      this.x += nx * 1.5; this.y += ny * 1.5;
      break;
    }

    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 40 && Math.random() < 0.4) {
      env.particles.tireSmoke(this.x, this.y, 0.4);
    }
    if (sp < 12 && this.shoveT <= 0) {
      if (this.hp <= 0) {
        if (this.canExplode) this.explode(env, this.explodePower());
        else this.mode = 'wreck';
        return;
      }
      if (this.pursuit) { this.mode = 'pursue'; return; } // shrug it off, keep chasing
      if (this.parkedOrigin) { this.mode = 'idle'; return; }
      this.realign(env.world);
    }
  }

  realign(world) {
    const nv = world.vA.nearest(this.x), nh = world.hA.nearest(this.y);
    const dv = Math.abs(this.x - world.vA.centerAt(nv.k, this.y));
    const dh = Math.abs(this.y - world.hA.centerAt(nh.k, this.x));
    const f = [Math.sin(this.heading), -Math.cos(this.heading)];
    // resume from the residual slide (projected onto the new direction of
    // travel), in whichever lane we actually landed in — not the stale
    // pre-hit cruise speed and a hard cut across to lane 0
    const resume = (axis, k, dir) => {
      this.axis = axis; this.k = k; this.dir = dir;
      this.laneIndex = this.nearestLane(world, axis, k, dir);
      const ndv = axis === 'v' ? [0, dir] : [dir, 0];
      this.speed = Math.max(0, this.vx * ndv[0] + this.vy * ndv[1]);
      this.mode = 'drive'; this.lastCross = undefined;
      this.chooseAction();
    };
    if (dv < world.vA.half(nv.k) - 4 && dv <= dh) {
      resume('v', nv.k, f[1] > 0 ? 1 : -1);
    } else if (dh < world.hA.half(nh.k) - 4) {
      resume('h', nh.k, f[0] > 0 ? 1 : -1);
    } else {
      this.mode = 'idle'; // stranded off-road; sits there
    }
  }

  // Which lane index is closest to where we're actually sitting?
  nearestLane(world, axis, k, dir) {
    const ax = axis === 'v' ? world.vA : world.hA;
    const perp = axis === 'v' ? -dir : dir;
    const posAlong = axis === 'v' ? this.y : this.x;
    const posLat = axis === 'v' ? this.x : this.y;
    const c = ax.centerAt(k, posAlong);
    let best = 0, bd = Infinity;
    for (let li = 0; li < ax.lanes(k); li++) {
      const d = Math.abs(c + perp * laneOff(ax, k, li, this.bike) - posLat);
      if (d < bd) { bd = d; best = li; }
    }
    return best;
  }

  applyHit(ix, iy, jx, jy, imp, env) {
    // receive an impulse (jx,jy) at world point (ix,iy). Heavier vehicles
    // barely deflect (impulse ÷ mass) and take less damage.
    const m = this.mass || 1;
    this.vx = this.velocity()[0] + jx / m;
    this.vy = this.velocity()[1] + jy / m;
    const rx = ix - this.x, ry = iy - this.y;
    this.spinv += (rx * (jy / m) - ry * (jx / m)) * -0.02;
    // Cops take damage on the same scale as the player's car, but with a 200 hp
    // pool (~2x the race car's 100), so they survive twice the punishment.
    if (this.police) { if (imp > 22) this.hp -= (imp - 22) * 0.07; }
    else this.hp -= imp * 0.55 / Math.sqrt(m);
    this.deformAtWorld(ix, iy, Math.min(1, imp / 160), env);
    if (this.canExplode && this.hp <= 0) { this.explode(env, this.explodePower()); return; }
    // Big rigs stay glued to their route: only a hit large relative to their
    // mass (or one that finally totals them) knocks them into loose physics.
    // Light vehicles (cars, bikes) always break loose as before.
    if (this.mode === 'wreck') { /* stays wrecked */ }
    else if (this.hp <= 0 || m <= 2 || imp > 20 * m) {
      this.mode = 'shove';
      this.shoveT = 0.5;
    } else if (this.mode === 'drive' || this.mode === 'turn') {
      this.speed = Math.max(0, this.speed - imp * 0.4); // just scrubs speed, keeps driving
    }
  }

  // Vehicle destroyed: a fireball that damages everything nearby, then it
  // burns out as a wreck. `power` scales the blast (the fuel tanker is bigger).
  explode(env, power = 1) {
    if (this.exploded) return;
    this.exploded = true;
    this.pursuit = false;
    this.mode = 'wreck';
    this.hp = -100;                 // wreck handler keeps it flaming
    this.vx = this.vy = 0;
    const R = 30 * power;           // splash radius
    this.deformAtWorld(this.x, this.y, 1, env);
    env.particles.sparks(this.x, this.y, Math.round(14 * power) + 4);
    env.particles.debris(this.x, this.y, '#20202a', Math.round(10 * power) + 2, 150);
    env.particles.debris(this.x, this.y, '#e3a24a', Math.round(6 * power) + 2, 130);
    const nf = Math.round(12 * power) + 4;
    for (let i = 0; i < nf; i++) {
      env.particles.fire(this.x + (Math.random() - 0.5) * R, this.y + (Math.random() - 0.5) * R);
    }
    env.sound.crash(1, this.x, this.y);

    // The tanker doesn't leave a wreck — it's blown to bits: 3-8 flying chunks,
    // a pall of smoke, a scorch mark, and no truck left to draw.
    if (this.type === 'gastruck') {
      this.blownApart = true;
      const cols = ['#c8ccd2', '#9aa0a8', '#e6e9ee', '#c23b3b', '#2a2a30'];
      const chunks = 3 + Math.floor(Math.random() * 6);   // 3..8
      for (let i = 0; i < chunks; i++) {
        env.particles.chunk(this.x + (Math.random() - 0.5) * 12, this.y + (Math.random() - 0.5) * 12,
          cols[Math.floor(Math.random() * cols.length)], 3 + Math.floor(Math.random() * 3));
      }
      for (let i = 0; i < 8; i++) {
        env.particles.engineSmoke(this.x + (Math.random() - 0.5) * R * 0.6, this.y + (Math.random() - 0.5) * R * 0.6, true);
      }
      env.world.decal(this.x, this.y, (g) => { g.fillStyle = 'rgba(10,10,12,0.5)'; g.fillRect(-9, -9, 18, 18); });
    }

    // mayhem bonus: blowing up a vehicle is worth extra points
    if (env.stats && env.stats.infractions) {
      env.stats.infractions.blownUp = (env.stats.infractions.blownUp || 0) + 1;
      env.stats.lastInfractionT = env.t;
    }

    if (env.obstacles) this.splashDamage(env, R, power);
    const d = Math.hypot(this.x - env.player.x, this.y - env.player.y);
    if (d < R * 7) env.camera.addTrauma(Math.min(0.95, power * (1 - d / (R * 7))));
  }

  // Area-of-effect blast: hurt & knock back every vehicle (and the player)
  // within the radius, falling off with distance. Can chain-detonate cops and
  // tankers caught in the blast.
  splashDamage(env, R, power) {
    for (const o of env.obstacles) {
      if (o === this || !o) continue;
      const dx = o.x - this.x, dy = o.y - this.y;
      const d = Math.hypot(dx, dy);
      if (d > R || d < 0.001) continue;
      const f = 1 - d / R;
      const nx = dx / d, ny = dy / d;
      const push = 150 * f * power;
      if (o === env.player) {
        o.addDamage(32 * f * power, env);
        o.vx += nx * push; o.vy += ny * push;
        o.deformAtWorld(o.x - nx * 6, o.y - ny * 6, Math.min(1, f * power), env);
      } else {
        o.hp -= 70 * f * power;
        const v = o.velocity ? o.velocity() : [o.vx, o.vy];
        o.vx = v[0] + nx * push; o.vy = v[1] + ny * push;
        if (o.mode !== 'wreck') { o.mode = 'shove'; o.shoveT = 0.5; }
        o.deformAtWorld(o.x - nx * 6, o.y - ny * 6, Math.min(1, f), env);
        if (o.hp <= 0) {
          if (o.canExplode) o.explode(env, o.explodePower()); // chain reaction
          else o.mode = 'wreck';
        }
      }
    }
  }

  deformAtWorld(wx, wy, power, env) {
    const dx = wx - this.x, dy = wy - this.y;
    const cs = Math.cos(this.heading), sn = Math.sin(this.heading);
    const lx = dx * cs + dy * sn + CAR_W / 2;
    const ly = -dx * sn + dy * cs + CAR_H / 2;
    const removed = this.body.deform(lx, ly, power);
    for (const col of removed) if (col) env.particles.debris(wx, wy, col, 1, 80);
  }

  draw(ctx, camX, camY) {
    if (this.type === 'gastruck') { if (!this.blownApart) this.drawGasTruck(ctx, camX, camY); return; } // hidden once blown to bits
    ctx.save();
    ctx.translate(Math.round(this.x - camX), Math.round(this.y - camY));
    ctx.rotate(this.heading);
    switch (this.type) {
      case 'bike': this.drawBike(ctx); break;
      case 'motorcycle': this.drawMotorcycle(ctx); break;
      case 'schoolbus': this.drawBus(ctx, '#e6b400', '#2e2610', true); break;
      case 'citybus': this.drawBus(ctx, '#cbced4', '#c23b3b', false); break;
      case 'dumptruck': this.drawDumpTruck(ctx); break;
      case 'police': ctx.drawImage(this.body.canvas, -CAR_W / 2, -CAR_H / 2); this.drawLightbar(ctx); break;
      default: ctx.drawImage(this.body.canvas, -CAR_W / 2, -CAR_H / 2);
    }
    ctx.restore();
  }

  // Small floating health bar, shown only once a vehicle has taken some damage
  // (and isn't already a burnt-out wreck). Drawn unrotated in screen space.
  drawDamageMeter(ctx, left, top) {
    if (this.mode === 'wreck' || this.exploded) return;
    const frac = this.hp / this.maxHp;
    if (frac >= 1 || frac <= 0) return;
    const sx = Math.round(this.x - left);
    const sy = Math.round(this.y - top) - ((this.half || 12) + 4);
    const bw = Math.max(10, Math.round(this.rad * 2) + 2), x0 = sx - (bw >> 1);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x0 - 1, sy - 1, bw + 2, 4);
    ctx.fillStyle = '#0c0c10'; ctx.fillRect(x0, sy, bw, 2);
    ctx.fillStyle = frac > 0.5 ? '#39d353' : frac > 0.25 ? '#e8c33a' : '#e05545';
    ctx.fillRect(x0, sy, Math.round(bw * frac), 2);
  }

  // Roof light bar. Steady & dim while patrolling; alternates bright red/blue
  // once `pursuit` is set (the hook for the police-chase feature).
  drawLightbar(ctx) {
    ctx.fillStyle = '#101014';
    ctx.fillRect(-3, -1, 6, 2);           // housing
    let red = '#5a1414', blue = '#141c5a';
    if (this.pursuit) {
      // flashes quicken as the chase drags on — you can read a cop's
      // desperation off its roof
      const phase = Math.floor(this.lightT * (8 + 10 * (this.desp || 0))) % 2;
      red = phase ? '#ff2a2a' : '#4a0000';
      blue = phase ? '#0a0a3a' : '#3a7bff';
    }
    ctx.fillStyle = red; ctx.fillRect(-3, -1, 3, 2);
    ctx.fillStyle = blue; ctx.fillRect(0, -1, 3, 2);
  }

  // All drawn in local space, heading 0 = nose toward -y, body spanning
  // [-rad,rad] x [-half,half].
  drawBike(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(-1, -3, 3, 7);
    ctx.fillStyle = '#141418';
    ctx.fillRect(-1, -4, 2, 2); ctx.fillRect(-1, 2, 2, 2); // wheels
    ctx.fillStyle = this.frame; ctx.fillRect(-1, -3, 2, 6);
    ctx.fillStyle = this.shirt; ctx.fillRect(-1, -1, 2, 3);
    ctx.fillStyle = this.skin; ctx.fillRect(-1, -2, 2, 1);
  }

  drawMotorcycle(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-2, -6, 4, 12);
    ctx.fillStyle = '#141418';
    ctx.fillRect(-1, -6, 2, 3); ctx.fillRect(-1, 3, 2, 3);  // fat tires
    ctx.fillStyle = this.frame; ctx.fillRect(-2, -3, 4, 6); // fairing/engine
    ctx.fillStyle = this.shirt; ctx.fillRect(-1, -1, 2, 3); // rider
    ctx.fillStyle = this.skin; ctx.fillRect(-1, -3, 2, 1);  // helmet
  }

  drawBus(ctx, body, accent, school) {
    const w = this.rad, h = this.half;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-w, -h + 1, w * 2 + 1, h * 2);
    ctx.fillStyle = body; ctx.fillRect(-w, -h, w * 2, h * 2);
    ctx.fillStyle = accent;                                 // trim
    ctx.fillRect(-w, -h, 1, h * 2); ctx.fillRect(w - 1, -h, 1, h * 2);
    ctx.fillRect(-w, h - 1, w * 2, 1);
    ctx.fillStyle = '#20303c'; ctx.fillRect(-w + 1, -h + 1, w * 2 - 2, 3); // windshield
    ctx.fillStyle = '#3a5a6a';                              // side windows
    for (let y = -h + 6; y < h - 3; y += 5) { ctx.fillRect(-w, y, 1, 3); ctx.fillRect(w - 1, y, 1, 3); }
    ctx.fillStyle = accent; ctx.fillRect(-1, -h + 6, 2, h * 2 - 9); // roof ridge
    if (school) { ctx.fillStyle = '#111'; ctx.fillRect(-w, -h + 4, w * 2, 1); }
  }

  drawDumpTruck(ctx) {
    const w = this.rad, h = this.half, cab = h * 2 * 0.34;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-w, -h + 1, w * 2 + 1, h * 2);
    ctx.fillStyle = '#d0902f'; ctx.fillRect(-w, -h, w * 2, cab);            // cab
    ctx.fillStyle = '#20303c'; ctx.fillRect(-w + 1, -h + 1, w * 2 - 2, 2);  // windshield
    ctx.fillStyle = '#5a5e66'; ctx.fillRect(-w, -h + cab, w * 2, h * 2 - cab); // bed walls
    ctx.fillStyle = '#6e5637'; ctx.fillRect(-w + 2, -h + cab + 1, w * 2 - 4, h * 2 - cab - 3); // gravel
    ctx.fillStyle = '#2a2a30'; ctx.fillRect(-w, -h, 1, h * 2); ctx.fillRect(w - 1, -h, 1, h * 2);
  }

  // Articulated: the cab is drawn in its own frame and the tank trailer in the
  // trailer frame (its own heading), hinged at the kingpin — so it bends
  // through turns. Drawn directly in world space, not the shared draw() rotate.
  drawGasTruck(ctx, camX, camY) {
    const w = this.rad;
    const f = [Math.sin(this.heading), -Math.cos(this.heading)];
    const hx = this.x - f[0] * this.hitch, hy = this.y - f[1] * this.hitch; // kingpin
    const th = this.trailerHeading != null ? this.trailerHeading : this.heading;
    const ft = [Math.sin(th), -Math.cos(th)];
    const tl = this.trailerLen;
    const tcx = hx - ft[0] * tl / 2, tcy = hy - ft[1] * tl / 2;             // tank center

    // --- tank trailer ---
    ctx.save();
    ctx.translate(Math.round(tcx - camX), Math.round(tcy - camY));
    ctx.rotate(th);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-w, -tl / 2 + 1, w * 2 + 1, tl);
    ctx.fillStyle = '#c8ccd2'; ctx.fillRect(-w, -tl / 2, w * 2, tl);        // silver tank
    ctx.fillStyle = '#9aa0a8'; ctx.fillRect(-w, -tl / 2, 1, tl); ctx.fillRect(w - 1, -tl / 2, 1, tl);
    ctx.fillStyle = '#e6e9ee'; ctx.fillRect(-1, -tl / 2, 2, tl);            // highlight ridge
    ctx.fillStyle = '#2a2a30'; ctx.fillRect(-w, -tl / 2 + 3, w * 2, 1); ctx.fillRect(-w, tl / 2 - 5, w * 2, 1); // straps
    ctx.fillStyle = '#e05545'; ctx.fillRect(-2, tl / 2 - 4, 4, 3);          // hazard placard (rear)
    ctx.restore();

    // --- coupling stub at the kingpin, masks the seam between the pieces ---
    ctx.fillStyle = '#1c1c22';
    ctx.fillRect(Math.round(hx - camX) - 1, Math.round(hy - camY) - 1, 3, 3);

    // --- cab ---
    const cl = this.cabLen;
    ctx.save();
    ctx.translate(Math.round(this.x - camX), Math.round(this.y - camY));
    ctx.rotate(this.heading);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-w, -cl / 2 + 1, w * 2 + 1, cl);
    ctx.fillStyle = '#c23b3b'; ctx.fillRect(-w, -cl / 2, w * 2, cl);        // cab
    ctx.fillStyle = '#20303c'; ctx.fillRect(-w + 1, -cl / 2 + 1, w * 2 - 2, 3); // windshield
    ctx.fillStyle = '#2a2a30'; ctx.fillRect(-w, -cl / 2, 1, cl); ctx.fillRect(w - 1, -cl / 2, 1, cl);
    ctx.restore();
  }
}

export class Traffic {
  constructor(world, mode) {
    this.world = world;
    // Free Drive is a cop-free sandbox: no cruisers in traffic, no pursuits.
    this.cops = mode !== 'cruise';
    this.cars = [];
    this.parkedChunks = new Set();
    this.spawnT = 0;
    this.pursuitT = 0;
    this.copsDestroyed = 0;   // blown-up cruisers are never replaced
  }

  update(dt, env) {
    const player = env.player;
    env.obstacles = this.cars.concat([player]);

    this.spawnT -= dt;
    if (!this.world.flat && this.spawnT <= 0) {
      this.spawnT = 0.4;
      this.syncParked(player);
      // pursuit cruisers don't count against the civilian traffic budget
      const driving = this.cars.filter(c => !c.parkedOrigin && !c.pursuit && c.mode !== 'wreck').length;
      if (driving < TARGET_AI) this.trySpawn(player);
      // despawn far cars (pursuit cars are kept alive at a longer range)
      for (let i = this.cars.length - 1; i >= 0; i--) {
        const c = this.cars[i];
        const r = c.pursuit ? 950 : DESPAWN_R;
        if (Math.hypot(c.x - player.x, c.y - player.y) > r) this.cars.splice(i, 1);
      }
    }

    this.updatePursuit(dt, env);

    for (const c of this.cars) c.update(dt, env);
    this.collide(env);
  }

  // Heat: one pursuit cruiser per 10 infractions, each arriving from off-screen.
  updatePursuit(dt, env) {
    if (!this.cops) return;
    this.pursuitT -= dt;
    // once a cruiser blows up it's gone for good — tally destroyed cops so the
    // dispatch target permanently drops and we never send a replacement
    for (const c of this.cars) {
      if (c.police && c.exploded && !c._countedDestroyed) { c._countedDestroyed = true; this.copsDestroyed++; }
    }
    const player = env.player;
    const inf = env.stats && env.stats.infractions;
    if (this.world.flat || !inf || player.dead) return;
    // a patrol cop that sees an infraction go down lights up on the spot
    if (env.t - (env.stats.lastInfractionT || -10) < 0.35) {
      for (const c of this.cars) {
        if (!c.police || c.pursuit || c.exploded || c.mode === 'wreck' || c.parkedOrigin) continue;
        if (Math.hypot(c.x - player.x, c.y - player.y) > 230) continue;
        const [cvx, cvy] = c.velocity();      // capture before the mode flips
        c.vx = cvx; c.vy = cvy;
        c.pursuit = true; c.mode = 'pursue'; c.chaseT = 0;
        c.cruise = Math.max(c.cruise, 105 + Math.random() * 20);
      }
    }
    const total = Object.values(inf).reduce((a, b) => a + b, 0);
    const want = Math.floor(total / 10) - this.copsDestroyed;
    if (want <= 0) return;
    const active = this.pursuers();
    if (active < want && this.pursuitT <= 0 && this.spawnPursuit(player)) this.pursuitT = 2;
  }

  // number of cop cars currently chasing the player (exploded cops clear their
  // own pursuit flag, so they don't count)
  pursuers() {
    let n = 0;
    for (const c of this.cars) if (c.pursuit) n++;
    return n;
  }

  // Spawn a flashing cruiser on a road beyond the view, already hunting you.
  spawnPursuit(player) {
    const world = this.world;
    for (let attempt = 0; attempt < 6; attempt++) {
      const useV = Math.random() < 0.5;
      const axisA = useV ? world.vA : world.hA;
      const along = useV ? player.y : player.x;
      const lat = useV ? player.x : player.y;
      const k = axisA.locate(lat) + Math.floor(Math.random() * 4) - 1;
      const roadC = axisA.center(k);
      if (Math.abs(roadC - lat) > 500) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      const dist = 330 + Math.random() * 110;          // beyond the ~250px view radius
      const dir = -side;                                // heading back toward the player
      const perp = useV ? -dir : dir;
      const posAlong = along + side * dist;
      const cen = axisA.centerAt(k, posAlong) + perp * laneOff(axisA, k, 0, false);
      const x = useV ? cen : posAlong;
      const y = useV ? posAlong : cen;
      if (Math.hypot(x - player.x, y - player.y) < 300) continue; // must be off-screen
      let blocked = false;
      for (const c of this.cars) if (Math.hypot(c.x - x, c.y - y) < 40) { blocked = true; break; }
      if (blocked) continue;
      const dv = useV ? [0, dir] : [dir, 0];
      const cop = new AICar(x, y, {
        axis: useV ? 'v' : 'h', k, dir, mode: 'pursue',
        heading: headingOf(dv[0], dv[1]), kind: 'police',
      });
      cop.pursuit = true;
      cop.cruise = 105 + Math.random() * 22;           // cruises at a catchable pace…
      cop.speed = cop.cruise * 0.85;
      this.cars.push(cop);
      return true;
    }
    return false;
  }

  syncParked(player) {
    const world = this.world;
    const c0x = Math.floor((player.x - 384) / 256), c1x = Math.floor((player.x + 384) / 256);
    const c0y = Math.floor((player.y - 384) / 256), c1y = Math.floor((player.y + 384) / 256);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const key = cx + ',' + cy;
        if (this.parkedChunks.has(key)) continue;
        const ch = world.chunks.get(key);
        if (!ch) continue;
        this.parkedChunks.add(key);
        for (const s of ch.carSpawns) {
          this.cars.push(new AICar(s.x, s.y, { mode: 'parked', heading: s.ang }));
        }
      }
    }
    // release chunk claims that scrolled far away so cars can respawn later
    for (const key of [...this.parkedChunks]) {
      const [cx, cy] = key.split(',').map(Number);
      const dx = cx * 256 + 128 - player.x, dy = cy * 256 + 128 - player.y;
      if (dx * dx + dy * dy > 800 * 800) this.parkedChunks.delete(key);
    }
  }

  trySpawn(player) {
    const world = this.world;
    for (let attempt = 0; attempt < 4; attempt++) {
      const useV = Math.random() < 0.5;
      const axisA = useV ? world.vA : world.hA;
      const along = useV ? player.y : player.x;
      const lat = useV ? player.x : player.y;
      const k = axisA.locate(lat) + Math.floor(Math.random() * 4) - 1;
      const roadC = axisA.center(k);
      if (Math.abs(roadC - lat) > 460) continue;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const dist = 260 + Math.random() * 180;
      const side = Math.random() < 0.5 ? 1 : -1;
      const posAlong = along + side * dist;
      let kind = pickType(Math.random());
      if (kind === 'police' && !this.cops) kind = 'car';
      const bike = kind === 'bike';
      const li = bike ? 0 : Math.floor(Math.random() * axisA.lanes(k)); // pick a lane
      const perp = useV ? -dir : dir;
      const cen = axisA.centerAt(k, posAlong) + perp * laneOff(axisA, k, li, bike);
      const x = useV ? cen : posAlong;
      const y = useV ? posAlong : cen;
      if (Math.hypot(x - player.x, y - player.y) < 240) continue;
      let blocked = false;
      for (const c of this.cars) {
        if (Math.hypot(c.x - x, c.y - y) < 45) { blocked = true; break; }
      }
      if (blocked) continue;
      const dv = useV ? [0, dir] : [dir, 0];
      const car = new AICar(x, y, {
        axis: useV ? 'v' : 'h', k, dir, laneIndex: li,
        heading: headingOf(dv[0], dv[1]), kind,
      });
      car.speed = car.cruise * 0.7;
      car.chooseAction();
      this.cars.push(car);
      return;
    }
  }

  // car-vs-car collisions, including the player
  collide(env) {
    const player = env.player;
    const bodies = this.cars.concat([player]);
    for (let a = 0; a < bodies.length; a++) {
      for (let b = a + 1; b < bodies.length; b++) {
        const A = bodies[a], B = bodies[b];
        const dx = B.x - A.x, dy = B.y - A.y;
        const reach = (A.half || 6) + (B.half || 6) + (A.rad || 7) + (B.rad || 7);
        if (dx * dx + dy * dy > reach * reach) continue;
        this.resolvePair(A, B, env);
      }
    }
  }

  resolvePair(A, B, env) {
    // sample a row of collision circles along each body's length so long
    // buses/trucks collide over their whole footprint, not just the center
    const samples = (c) => {
      const f = c.forward ? c.forward() : [Math.sin(c.heading), -Math.cos(c.heading)];
      const r = c.rad || 7, half = Math.max(0, (c.half || 6) - r);
      const n = Math.max(2, Math.round((half * 2) / r) + 1);
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : -half + (2 * half) * i / (n - 1);
        out.push([c.x + f[0] * t, c.y + f[1] * t]);
      }
      return out;
    };
    const sum = (A.rad || 7) + (B.rad || 7);
    const ca = samples(A), cb = samples(B);
    for (const pa of ca) {
      for (const pb of cb) {
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
        const d = Math.hypot(dx, dy);
        if (d >= sum) continue;
        const nx = d > 0.01 ? dx / d : 1, ny = d > 0.01 ? dy / d : 0;
        const va = A.velocity ? A.velocity() : [A.vx, A.vy];
        const vb = B.velocity ? B.velocity() : [B.vx, B.vy];
        const rvx = va[0] - vb[0], rvy = va[1] - vb[1];
        const vn = rvx * nx + rvy * ny;
        const imp = Math.max(0, vn);
        // masses drive the response; AI cars have no mass field (default 1).
        const mA = A.mass || 1, mB = B.mass || 1, invSum = 1 / (mA + mB);
        const isPA = A === env.player, isPB = B === env.player;
        const ix = (pa[0] + pb[0]) / 2, iy = (pa[1] + pb[1]) / 2;

        // positional separation (heavier body budges less) — always
        const sep = sum - d;
        A.x -= nx * sep * mB * invSum; A.y -= ny * sep * mB * invSum;
        B.x += nx * sep * mA * invSum; B.y += ny * sep * mA * invSum;

        // Two-wheelers (cyclists AND motorcyclists) are as fragile as
        // pedestrians: the player plows straight through, flinging the rider
        // and totalling the bike, taking no damage and barely slowing.
        const twoWheelsB = B.bike || B.type === 'motorcycle';
        const twoWheelsA = A.bike || A.type === 'motorcycle';
        if ((isPA && twoWheelsB) || (isPB && twoWheelsA)) {
          if (imp > 6) {
            const bike = isPA ? B : A;
            const dirx = isPA ? nx : -nx, diry = isPA ? ny : -ny;
            const fling = Math.max(imp, 70) * 1.3;
            bike.hp = -999;
            bike.applyHit(ix, iy, dirx * fling, diry * fling, imp, env);
            env.sound.thud();
            env.camera.addTrauma(0.22 * (env.player.shakeMul || 1));
            env.particles.debris(ix, iy, '#8a1414', 3, 70);
            env.particles.sparks(ix, iy, 3);
            if (env.t - (env.stats.lastCarHitT || -1) > 0.5) { env.stats.carsHit++; countWreck(env); }
            env.stats.lastCarHitT = env.t;
          }
          return;
        }

        // A much-heavier player (truck/tank) doesn't trade momentum — it PUSHES.
        // The car is carried up to the player's own speed along the contact
        // normal, never launched faster, and the player barely slows.
        if ((isPA && mA > mB * 1.5) || (isPB && mB > mA * 1.5)) {
          const P = isPA ? A : B, C = isPA ? B : A;
          const pdx = isPA ? nx : -nx, pdy = isPA ? ny : -ny; // player -> car
          const pv = P.velocity ? P.velocity() : [P.vx, P.vy];
          const cv = C.velocity ? C.velocity() : [C.vx, C.vy];
          const pvp = pv[0] * pdx + pv[1] * pdy;  // player speed toward the car
          const cvp = cv[0] * pdx + cv[1] * pdy;  // car speed along that dir
          // carry the car up to the player's push speed along the normal (never
          // below 0 — it can't keep driving into the player)...
          const dvp = Math.max(cvp, Math.max(pvp, 0)) - cvp;
          let ncx = cv[0] + dvp * pdx, ncy = cv[1] + dvp * pdy;
          // ...then cap its total speed to the player's, so a push never leaves
          // the car moving faster than the vehicle that shoved it.
          const pSpeed = Math.hypot(pv[0], pv[1]), nSpeed = Math.hypot(ncx, ncy);
          if (nSpeed > pSpeed && nSpeed > 0.01) { const s = pSpeed / nSpeed; ncx *= s; ncy *= s; }
          C.applyHit(ix, iy, ncx - cv[0], ncy - cv[1], imp * (P.smashMul || 1), env);
          // player sheds only a sliver of speed (mass-weighted soft stop)
          if (vn > 0) {
            const k = 1.8 * (isPA ? mB : mA) * invSum;
            if (isPA) { A.vx -= vn * nx * k; A.vy -= vn * ny * k; }
            else { B.vx += vn * nx * k; B.vy += vn * ny * k; }
          }
          if (imp > 22) { // real impact feedback (not steady pushing)
            P.addDamage((imp - 22) * 0.07, env);
            P.deformAtWorld(ix, iy, Math.min(1, imp / 180), env);
            if (env.t - (env.stats.lastCarHitT || -1) > 0.5) { env.stats.carsHit++; countWreck(env); }
            env.stats.lastCarHitT = env.t;
            env.camera.addTrauma(Math.min(0.6, imp / 200) * (P.shakeMul || 1));
            env.sound.crash(imp / 150);
            env.particles.sparks(ix, iy, 5);
          }
          return;
        }

        // --- equal-ish masses: momentum-trading collision ---
        if (imp < 20) {
          // gentle contact: driving AI yields, player feels a soft stop
          if (A !== env.player && A.mode === 'drive') A.speed = Math.min(A.speed, 3);
          if (B !== env.player && B.mode === 'drive') B.speed = Math.min(B.speed, 3);
          if (vn > 0) {
            if (isPA) { const k = 1.8 * mB * invSum; A.vx -= vn * nx * k; A.vy -= vn * ny * k; }
            if (isPB) { const k = 1.8 * mA * invSum; B.vx += vn * nx * k; B.vy += vn * ny * k; }
          }
          continue;
        }
        const j = 0.68 * vn; // (1+e)/2 per body, e≈0.36
        // player side
        if (isPA || isPB) {
          const P = isPA ? A : B;
          const mP = isPA ? mA : mB, mO = isPA ? mB : mA;
          const sgn = isPA ? -1 : 1;
          const rec = j * 2 * mO / (mP + mO); // barely recoils when heavy (=j at parity)
          P.vx += sgn * rec * nx;
          P.vy += sgn * rec * ny;
          const rx = ix - P.x, ry = iy - P.y;
          P.spin += (rx * (sgn * rec * ny) - ry * (sgn * rec * nx)) * -0.015;
          // a cruiser ram hurts at lower speeds and hits ~2x harder — it's out
          // to total you
          const ram = (isPA ? B : A).pursuit === true;
          const thr = ram ? 8 : 22;
          if (imp > thr) {
            let dmg = (imp - thr) * 0.07;
            if (ram) dmg = Math.min(35, dmg * 2.2);
            P.addDamage(dmg, env);
            P.deformAtWorld(ix, iy, Math.min(1, imp / 180), env);
            if (env.t - (env.stats.lastCarHitT || -1) > 0.5) { env.stats.carsHit++; countWreck(env); }
            env.stats.lastCarHitT = env.t;
            env.camera.addTrauma(Math.min(0.8, imp / (ram ? 130 : 170)) * (P.shakeMul || 1));
            env.sound.crash(imp / 150);
            env.particles.sparks(ix, iy, 5);
          }
        }
        // AI sides
        if (!isPA) A.applyHit(ix, iy, -j * nx, -j * ny, imp, env);
        if (!isPB) B.applyHit(ix, iy, j * nx, j * ny, imp, env);
        if (!isPA && !isPB && imp > 25) {
          env.sound.crash(imp / 220, ix, iy);
          env.particles.sparks(ix, iy, 4);
        }
        return;
      }
    }
  }

  draw(ctx, camX, camY, W, H) {
    const left = camX - W / 2, top = camY - H / 2;
    for (const c of this.cars) {
      const m = (c.half || 12) + 16;
      if (Math.abs(c.x - camX) > W / 2 + m || Math.abs(c.y - camY) > H / 2 + m) continue;
      c.draw(ctx, left, top);
      c.drawDamageMeter(ctx, left, top);
    }
  }
}
