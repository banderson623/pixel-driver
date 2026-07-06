// AI traffic: cars cruise lanes on the road grid, stop for red lights and
// obstacles, turn at intersections along bezier arcs, and switch to loose
// physics when the player slams into them. Parked cars use the same bodies.

import { CarBody, CAR_W, CAR_H, AI_COLORS } from './car.js';
import { ROAD_HALF } from './world.js';
import { hash3 } from './rng.js';

const LANE = 12;
const BIKE_LANE = LANE + 7; // cyclists hug the curb
const TARGET_AI = 13;
const DESPAWN_R = 580;

const BIKE_SHIRTS = ['#d24b4b', '#3f78d2', '#3fae55', '#d2a53a', '#8f4fd2', '#31b0b0'];
const BIKE_SKIN = ['#caa07a', '#a5744c', '#e3b98f', '#8a5a34'];
const BIKE_FRAMES = ['#2a2a30', '#39424e', '#4a2f2f', '#2f4a3a'];

// AI vehicle roster. len/wid drive collision footprint & drawing; mass makes
// the big rigs shove the player around; hp sets how much abuse they take.
const TYPES = {
  car:        { len: 24, wid: 13, cruiseLo: 55, cruiseHi: 90,  mass: 1, hpLo: 55,  hpHi: 85 },
  motorcycle: { len: 14, wid: 5,  cruiseLo: 62, cruiseHi: 104, mass: 1, hpLo: 10,  hpHi: 18 },
  schoolbus:  { len: 46, wid: 14, cruiseLo: 40, cruiseHi: 56,  mass: 5, hpLo: 150, hpHi: 210 },
  citybus:    { len: 48, wid: 14, cruiseLo: 40, cruiseHi: 56,  mass: 5, hpLo: 150, hpHi: 210 },
  dumptruck:  { len: 34, wid: 15, cruiseLo: 46, cruiseHi: 66,  mass: 5, hpLo: 160, hpHi: 220 },
  gastruck:   { len: 56, wid: 14, cruiseLo: 42, cruiseHi: 60,  mass: 6, hpLo: 170, hpHi: 230 },
  bike:       { len: 11, wid: 4,  cruiseLo: 30, cruiseHi: 46,  mass: 1, hpLo: 1,   hpHi: 4 },
};
// spawn probabilities (cumulative); the remainder to 1.0 is plain cars
const SPAWN_MIX = [
  ['bike', 0.20], ['motorcycle', 0.08], ['schoolbus', 0.06],
  ['citybus', 0.06], ['dumptruck', 0.06], ['gastruck', 0.05],
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
    this.shoveT = 0;
    this.action = 'straight';
    this.turn = null;
    this.parkedOrigin = this.mode === 'parked';
    const scheme = AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)];
    this.body = new CarBody(scheme[0], scheme[1]);
    this.smokeAcc = 0;

    // vehicle type — same lane/light/turn rules for all, differing in size
    // (collision footprint via half/rad), speed, mass, durability and looks.
    this.type = opts.kind || 'car';
    this.bike = this.type === 'bike';
    const cfg = TYPES[this.type] || TYPES.car;
    this.half = cfg.len / 2; this.rad = cfg.wid / 2;
    this.mass = cfg.mass;
    this.cruise = cfg.cruiseLo + Math.random() * (cfg.cruiseHi - cfg.cruiseLo);
    this.hp = cfg.hpLo + Math.random() * (cfg.hpHi - cfg.hpLo);
    this.laneOff = this.bike ? BIKE_LANE : LANE;
    if (this.bike || this.type === 'motorcycle') { // has a visible rider
      this.frame = BIKE_FRAMES[Math.floor(Math.random() * BIKE_FRAMES.length)];
      this.shirt = BIKE_SHIRTS[Math.floor(Math.random() * BIKE_SHIRTS.length)];
      this.skin = BIKE_SKIN[Math.floor(Math.random() * BIKE_SKIN.length)];
    }
  }

  dirVec() { return this.axis === 'v' ? [0, this.dir] : [this.dir, 0]; }

  velocity() {
    if (this.mode === 'shove') return [this.vx, this.vy];
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

  update(dt, env) {
    switch (this.mode) {
      case 'drive': this.updateDrive(dt, env); break;
      case 'turn': this.updateTurn(dt, env); break;
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
  }

  updateDrive(dt, env) {
    const world = env.world;
    const dv = this.dirVec();
    const axisA = this.axis === 'v' ? world.vA : world.hA;   // road we're on
    const axisB = this.axis === 'v' ? world.hA : world.vA;   // crossing roads
    const posAlong = this.axis === 'v' ? this.y : this.x;
    const posLat = this.axis === 'v' ? this.x : this.y;
    const roadC = axisA.center(this.k);

    // lane keeping: right-hand traffic
    // perp(dx,dy) = (-dy,dx): lane center = road center + perp*LANE
    const perp = this.axis === 'v' ? -this.dir : this.dir;
    const laneC = roadC + perp * this.laneOff;
    const latFix = (laneC - posLat) * Math.min(1, 4 * dt);

    // next crossing road
    const j = axisB.locate(posAlong);
    const jn = this.dir > 0 ? j + 1 : j;
    const crossC = axisB.center(jn);
    const stopAt = crossC - this.dir * (ROAD_HALF + 16);
    const dStop = (stopAt - posAlong) * this.dir;

    let ts = this.cruise;

    // traffic light
    const vi = this.axis === 'v' ? this.k : jn;
    const hj = this.axis === 'v' ? jn : this.k;
    if (world.hasLight(vi, hj) && dStop > -2 && dStop < 95) {
      const ph = world.lightPhase(vi, hj, env.t);
      const st = this.axis === 'v' ? ph.ns : ph.ew;
      if (st === 'r' || (st === 'y' && dStop > 28)) {
        ts = Math.min(ts, Math.max(0, dStop) * 1.7);
        if (dStop < 3) ts = 0;
      }
    }

    // obstacle probe (cars + player ahead)
    const probe = 16 + this.speed * 0.6;
    const pax = this.x + dv[0] * probe, pay = this.y + dv[1] * probe;
    for (const o of env.obstacles) {
      if (o === this) continue;
      const ddx = o.x - pax, ddy = o.y - pay;
      if (ddx * ddx + ddy * ddy < 16 * 16) {
        const dd = Math.hypot(o.x - this.x, o.y - this.y);
        ts = Math.min(ts, Math.max(0, (dd - 22) * 1.6));
      }
      const cdx = o.x - this.x, cdy = o.y - this.y;
      if (cdx * dv[0] + cdy * dv[1] > 0 && cdx * cdx + cdy * cdy < 24 * 24) ts = Math.min(ts, 6);
    }

    if (this.speed < ts) this.speed = Math.min(ts, this.speed + 75 * dt);
    else this.speed = Math.max(ts, this.speed - 170 * dt);

    // begin a turn?
    const entry = crossC - this.dir * (ROAD_HALF + 2);
    const dEntry = (entry - posAlong) * this.dir;
    if (this.action !== 'straight' && dEntry <= 1 && dEntry > -10 && this.speed > 4) {
      this.beginTurn(env, crossC, jn);
      return;
    }
    // passed the intersection → decide next move
    if (dEntry <= -ROAD_HALF * 2) {
      // (this triggers repeatedly until next intersection ahead changes; cheap to just re-roll rarely)
    }
    if ((crossC - posAlong) * this.dir < -(ROAD_HALF + 20) && this.lastCross !== jn) {
      this.lastCross = jn;
      this.chooseAction();
    }

    // advance
    this.x += dv[0] * this.speed * dt;
    this.y += dv[1] * this.speed * dt;
    if (this.axis === 'v') this.x += latFix; else this.y += latFix;
    this.heading = lerpAngle(this.heading, headingOf(dv[0], dv[1]), Math.min(1, 8 * dt));
  }

  beginTurn(env, crossC, jn) {
    const world = env.world;
    const dv = this.dirVec();
    // right turn = rotate clockwise, left = counterclockwise
    const nd = this.action === 'right'
      ? [-dv[1], dv[0]]
      : [dv[1], -dv[0]];
    let exit, ctrl, nk, naxis, ndir;
    if (this.axis === 'v') {
      naxis = 'h'; ndir = nd[0];
      nk = jn;
      const vc = world.vA.center(this.k);
      const laneY = crossC + ndir * LANE;
      exit = [vc + ndir * (ROAD_HALF + 4), laneY];
      ctrl = [this.x, laneY];
    } else {
      naxis = 'v'; ndir = nd[1];
      nk = jn;
      const hc = world.hA.center(this.k);
      const laneX = crossC - ndir * LANE;
      exit = [laneX, hc + ndir * (ROAD_HALF + 4)];
      ctrl = [laneX, this.y];
    }
    const p0 = [this.x, this.y];
    const len = 0.85 * (Math.hypot(ctrl[0] - p0[0], ctrl[1] - p0[1]) + Math.hypot(exit[0] - ctrl[0], exit[1] - ctrl[1]));
    this.turn = { p0, ctrl, exit, t: 0, len: Math.max(10, len), naxis, nk, ndir };
    this.mode = 'turn';
  }

  updateTurn(dt, env) {
    const tn = this.turn;
    this.speed = Math.max(30, this.speed - 60 * dt);
    tn.t += this.speed * dt / tn.len;
    if (tn.t >= 1) {
      this.x = tn.exit[0]; this.y = tn.exit[1];
      this.axis = tn.naxis; this.k = tn.nk; this.dir = tn.ndir;
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
          env.sound.crash(imp / 260);
        }
      }
      this.x += nx * 1.5; this.y += ny * 1.5;
      break;
    }

    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 40 && Math.random() < 0.4) {
      env.particles.tireSmoke(this.x, this.y, 0.4);
    }
    if (sp < 12 && this.shoveT <= 0) {
      if (this.hp <= 0) { this.mode = 'wreck'; return; }
      if (this.parkedOrigin) { this.mode = 'idle'; return; }
      this.realign(env.world);
    }
  }

  realign(world) {
    const nv = world.vA.nearest(this.x), nh = world.hA.nearest(this.y);
    const dv = Math.abs(this.x - nv.c), dh = Math.abs(this.y - nh.c);
    const f = [Math.sin(this.heading), -Math.cos(this.heading)];
    if (dv < ROAD_HALF - 4 && dv <= dh) {
      this.axis = 'v'; this.k = nv.k;
      this.dir = f[1] > 0 ? 1 : -1;
      this.mode = 'drive'; this.lastCross = undefined;
      this.chooseAction();
    } else if (dh < ROAD_HALF - 4) {
      this.axis = 'h'; this.k = nh.k;
      this.dir = f[0] > 0 ? 1 : -1;
      this.mode = 'drive'; this.lastCross = undefined;
      this.chooseAction();
    } else {
      this.mode = 'idle'; // stranded off-road; sits there
    }
  }

  applyHit(ix, iy, jx, jy, imp, env) {
    // receive an impulse (jx,jy) at world point (ix,iy)
    this.vx = this.velocity()[0] + jx;
    this.vy = this.velocity()[1] + jy;
    const rx = ix - this.x, ry = iy - this.y;
    this.spinv += (rx * jy - ry * jx) * -0.02;
    this.hp -= imp * 0.55;
    this.mode = this.mode === 'wreck' ? 'wreck' : 'shove';
    this.shoveT = 0.5;
    this.deformAtWorld(ix, iy, Math.min(1, imp / 160), env);
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
    ctx.save();
    ctx.translate(Math.round(this.x - camX), Math.round(this.y - camY));
    ctx.rotate(this.heading);
    switch (this.type) {
      case 'bike': this.drawBike(ctx); break;
      case 'motorcycle': this.drawMotorcycle(ctx); break;
      case 'schoolbus': this.drawBus(ctx, '#e6b400', '#2e2610', true); break;
      case 'citybus': this.drawBus(ctx, '#cbced4', '#c23b3b', false); break;
      case 'dumptruck': this.drawDumpTruck(ctx); break;
      case 'gastruck': this.drawGasTruck(ctx); break;
      default: ctx.drawImage(this.body.canvas, -CAR_W / 2, -CAR_H / 2);
    }
    ctx.restore();
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

  drawGasTruck(ctx) {
    const w = this.rad, h = this.half, L = h * 2;
    const cab1 = -h + L * 0.26, tank0 = -h + L * 0.32;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-w, -h + 1, w * 2 + 1, L);
    ctx.fillStyle = '#c23b3b'; ctx.fillRect(-w, -h, w * 2, cab1 - (-h));    // cab
    ctx.fillStyle = '#20303c'; ctx.fillRect(-w + 1, -h + 1, w * 2 - 2, 2);
    ctx.fillStyle = '#2a2a30'; ctx.fillRect(-1, cab1, 2, tank0 - cab1);     // hitch
    ctx.fillStyle = '#c8ccd2'; ctx.fillRect(-w, tank0, w * 2, h - tank0);   // silver tank
    ctx.fillStyle = '#9aa0a8'; ctx.fillRect(-w, tank0, 1, h - tank0); ctx.fillRect(w - 1, tank0, 1, h - tank0);
    ctx.fillStyle = '#e6e9ee'; ctx.fillRect(-1, tank0, 2, h - tank0);       // highlight ridge
    ctx.fillStyle = '#2a2a30'; ctx.fillRect(-w, tank0 + (h - tank0) * 0.5, w * 2, 1); // strap
    ctx.fillStyle = '#e05545'; ctx.fillRect(-2, h - 4, 4, 3);               // hazard placard
  }
}

export class Traffic {
  constructor(world) {
    this.world = world;
    this.cars = [];
    this.parkedChunks = new Set();
    this.spawnT = 0;
  }

  update(dt, env) {
    const player = env.player;
    env.obstacles = this.cars.concat([player]);

    this.spawnT -= dt;
    if (!this.world.flat && this.spawnT <= 0) {
      this.spawnT = 0.4;
      this.syncParked(player);
      const driving = this.cars.filter(c => !c.parkedOrigin && c.mode !== 'wreck').length;
      if (driving < TARGET_AI) this.trySpawn(player);
      // despawn far cars
      for (let i = this.cars.length - 1; i >= 0; i--) {
        const c = this.cars[i];
        if (Math.hypot(c.x - player.x, c.y - player.y) > DESPAWN_R) this.cars.splice(i, 1);
      }
    }

    for (const c of this.cars) c.update(dt, env);
    this.collide(env);
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
      const kind = pickType(Math.random());
      const off = kind === 'bike' ? BIKE_LANE : LANE;
      const perp = useV ? -dir : dir;
      const x = useV ? roadC + perp * off : posAlong;
      const y = useV ? posAlong : roadC + perp * off;
      if (Math.hypot(x - player.x, y - player.y) < 240) continue;
      let blocked = false;
      for (const c of this.cars) {
        if (Math.hypot(c.x - x, c.y - y) < 45) { blocked = true; break; }
      }
      if (blocked) continue;
      const dv = useV ? [0, dir] : [dir, 0];
      const car = new AICar(x, y, {
        axis: useV ? 'v' : 'h', k, dir,
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

        // Cyclists are as fragile as pedestrians: the player plows straight
        // through, flinging the rider and totalling the bike, taking no damage
        // and barely slowing.
        if ((isPA && B.bike) || (isPB && A.bike)) {
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
          if (imp > 22) {
            P.addDamage((imp - 22) * 0.07, env);
            P.deformAtWorld(ix, iy, Math.min(1, imp / 180), env);
            if (env.t - (env.stats.lastCarHitT || -1) > 0.5) { env.stats.carsHit++; countWreck(env); }
            env.stats.lastCarHitT = env.t;
            env.camera.addTrauma(Math.min(0.7, imp / 170) * (P.shakeMul || 1));
            env.sound.crash(imp / 150);
            env.particles.sparks(ix, iy, 5);
          }
        }
        // AI sides
        if (!isPA) A.applyHit(ix, iy, -j * nx, -j * ny, imp, env);
        if (!isPB) B.applyHit(ix, iy, j * nx, j * ny, imp, env);
        if (!isPA && !isPB && imp > 25) {
          env.sound.crash(imp / 220);
          env.particles.sparks(ix, iy, 4);
        }
        return;
      }
    }
  }

  draw(ctx, camX, camY, W, H) {
    for (const c of this.cars) {
      const m = (c.half || 12) + 8;
      if (Math.abs(c.x - camX) > W / 2 + m || Math.abs(c.y - camY) > H / 2 + m) continue;
      c.draw(ctx, camX - W / 2, camY - H / 2);
    }
  }
}
