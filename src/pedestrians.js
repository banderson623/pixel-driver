// Sidewalk pedestrians: tiny pixel people who keep to the sidewalks and only
// step into the road at crosswalks. They walk beside a road at a fixed lateral
// offset (SIDE_OFF) — that offset lands squarely on the painted crosswalk
// bands, so walking straight through an intersection naturally follows the
// stripes, and "crossing to the other side" hops across on the same bands.
// The player can mow them down: a hit sprays blood, stains the ground, and
// (in Rap Sheet mode) counts as an infraction.

import { ROAD_HALF, SIDEWALK } from './world.js';

// sidewalk centerline offset from a road center. ROAD_HALF+SIDEWALK/2 = 29,
// which sits inside the crosswalk band [ROAD_HALF+2, ROAD_HALF+10] = [26,34].
const SIDE_OFF = ROAD_HALF + SIDEWALK / 2;
const CROSS_BAND = ROAD_HALF + 6; // along-offset from an intersection to a crosswalk
const TARGET = 12;
const DESPAWN_R = 460;
const HIT_R = 8;

const SHIRTS = ['#c94f4f', '#4f7ec9', '#4faf5a', '#c9a63a', '#9a5fc9', '#3ab0b0', '#d07fb0', '#d8d8d8'];
const SKIN = ['#caa07a', '#a5744c', '#e3b98f', '#8a5a34'];

let uid = 1;

class Ped {
  // Walks along road `k` of the given axis, on `side` (+1/-1), heading `dir`.
  constructor(axis, k, side, dir, along, world) {
    this.id = uid++;
    this.axis = axis; this.k = k; this.side = side; this.dir = dir;
    this.along = along;
    const roadC = (axis === 'v' ? world.vA : world.hA).center(k);
    this.lat = roadC + side * SIDE_OFF;
    this.speed = 11 + Math.random() * 11;
    this.pauseT = 0;
    this.mode = 'walk';       // walk | cross
    this.lastCross = null;
    this.shirt = SHIRTS[Math.floor(Math.random() * SHIRTS.length)];
    this.skin = SKIN[Math.floor(Math.random() * SKIN.length)];
    this.step = Math.random() * 4;
    this.dead = false;
    this.vx = 0; this.vy = 0; this.stopT = 0;
    this.syncXY();
  }

  syncXY() {
    if (this.axis === 'v') { this.x = this.lat; this.y = this.along; }
    else { this.x = this.along; this.y = this.lat; }
  }

  update(dt, env) {
    if (this.dead) {
      this.x += this.vx * dt; this.y += this.vy * dt;
      this.vx *= Math.exp(-4 * dt); this.vy *= Math.exp(-4 * dt);
      this.stopT -= dt;
      return;
    }
    const world = env.world;
    const axisA = this.axis === 'v' ? world.vA : world.hA;
    const perpA = this.axis === 'v' ? world.hA : world.vA;
    const roadC = axisA.center(this.k);
    this.step += this.speed * dt * 0.35;

    // crossing the street to the opposite sidewalk (moving laterally along a
    // crosswalk band, `along` held fixed)
    if (this.mode === 'cross') {
      const target = roadC - this.side * SIDE_OFF;
      const stepLat = this.speed * dt;
      if (Math.abs(target - this.lat) <= stepLat) {
        this.lat = target; this.side = -this.side; this.mode = 'walk';
      } else {
        this.lat += Math.sign(target - this.lat) * stepLat;
      }
      this.syncXY();
      return;
    }

    if (this.pauseT > 0) { this.pauseT -= dt; this.syncXY(); return; }

    // keep to the sidewalk centerline and stroll along it
    const laneC = roadC + this.side * SIDE_OFF;
    this.lat += (laneC - this.lat) * Math.min(1, 6 * dt);
    this.along += this.dir * this.speed * dt;

    // at each crosswalk, maybe cross the street, U-turn, or just keep going
    // (going straight already tracks the perpendicular road's crosswalk)
    const j = perpA.locate(this.along);
    const jn = this.dir > 0 ? j + 1 : j;
    const nearBand = perpA.center(jn) - this.dir * CROSS_BAND;
    if (this.lastCross !== jn && Math.abs(this.along - nearBand) < 4) {
      this.lastCross = jn;
      const r = Math.random();
      if (r < 0.22) { this.along = nearBand; this.mode = 'cross'; } // hop to far sidewalk
      else if (r < 0.30) this.dir = -this.dir;                      // turn around
    } else if (Math.random() < 0.004) {
      this.pauseT = 0.4 + Math.random() * 1.4;                      // loiter
    }

    this.syncXY();
  }

  kill(vx, vy, env) {
    this.dead = true;
    this.vx = vx; this.vy = vy;
    this.stopT = 0.7;
    env.particles.debris(this.x, this.y, '#8a1414', 6, 95);
    env.particles.debris(this.x, this.y, this.shirt, 4, 70);
    env.world.decal(this.x, this.y, (g) => {
      g.fillStyle = 'rgba(120,16,16,0.5)';
      g.fillRect(-2, -2, 4, 4);
      g.fillStyle = 'rgba(120,16,16,0.28)';
      g.fillRect(-4, -1, 8, 2); g.fillRect(-1, -4, 2, 8);
    });
  }

  draw(ctx, camX, camY) {
    const x = Math.round(this.x - camX), y = Math.round(this.y - camY);
    if (this.dead) {
      ctx.fillStyle = 'rgba(120,16,16,0.45)';
      ctx.fillRect(x - 3, y - 1, 7, 3);
      ctx.fillStyle = this.shirt;
      ctx.fillRect(x - 2, y - 1, 4, 2);
      ctx.fillStyle = this.skin;
      ctx.fillRect(x + 2, y - 1, 1, 1);
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - 1, y + 2, 3, 1);
    const bob = Math.floor(this.step) & 1;
    ctx.fillStyle = '#2c2c34';
    ctx.fillRect(x - 1 + bob, y + 1, 1, 1);
    ctx.fillRect(x + 1 - bob, y + 1, 1, 1);
    ctx.fillStyle = this.shirt;
    ctx.fillRect(x - 1, y - 1, 2, 2);
    ctx.fillStyle = this.skin;
    ctx.fillRect(x - 1, y - 3, 2, 1);
  }
}

export class Pedestrians {
  constructor(world) {
    this.world = world;
    this.peds = [];
    this.spawnT = 0;
  }

  update(dt, env) {
    const player = env.player;
    this.spawnT -= dt;
    if (!this.world.flat && this.spawnT <= 0) {
      this.spawnT = 0.5;
      const alive = this.peds.reduce((n, p) => n + (p.dead ? 0 : 1), 0);
      if (alive < TARGET) this.trySpawn(player);
      for (let i = this.peds.length - 1; i >= 0; i--) {
        const p = this.peds[i];
        if (Math.hypot(p.x - player.x, p.y - player.y) > DESPAWN_R) this.peds.splice(i, 1);
      }
    }
    for (const p of this.peds) p.update(dt, env);
    this.collide(env);
  }

  trySpawn(player) {
    const world = this.world;
    for (let a = 0; a < 5; a++) {
      const useV = Math.random() < 0.5;
      const axisA = useV ? world.vA : world.hA;
      const along = useV ? player.y : player.x;   // travel axis
      const lat = useV ? player.x : player.y;      // road-index axis
      const k = axisA.locate(lat) + Math.floor(Math.random() * 4) - 1;
      const roadC = axisA.center(k);
      if (Math.abs(roadC - lat) > 420) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const along0 = along + (Math.random() < 0.5 ? 1 : -1) * (120 + Math.random() * 170);
      const ped = new Ped(useV ? 'v' : 'h', k, side, dir, along0, world);
      if (Math.hypot(ped.x - player.x, ped.y - player.y) < 90) continue;
      this.peds.push(ped);
      return;
    }
  }

  // run down any live pedestrian the moving player overlaps
  collide(env) {
    const player = env.player;
    const [fx, fy] = player.forward();
    const off = player.collOff || 0;
    const pts = [[player.x + fx * off, player.y + fy * off], [player.x - fx * off, player.y - fy * off]];
    const speed = player.speed();
    const rr = HIT_R + (player.collR || 6);
    for (const p of this.peds) {
      if (p.dead) continue;
      for (const c of pts) {
        const dx = p.x - c[0], dy = p.y - c[1];
        if (dx * dx + dy * dy >= rr * rr) continue;
        if (speed > 12) {
          p.kill(player.vx * 1.3 + (Math.random() - 0.5) * 30,
                 player.vy * 1.3 + (Math.random() - 0.5) * 30, env);
          env.sound.thud();
          env.camera.addTrauma(0.28);
          env.stats.peds = (env.stats.peds || 0) + 1;
          if (env.stats.infractions) {
            env.stats.infractions.pedestrian++;
            env.stats.lastInfractionT = env.t;
          }
        } else {
          const d = Math.hypot(dx, dy) || 1; // slow bump: shove aside
          p.x += (dx / d) * (rr - d); p.y += (dy / d) * (rr - d);
        }
        break;
      }
    }
  }

  draw(ctx, camX, camY, W, H) {
    for (const p of this.peds) {
      if (Math.abs(p.x - camX) > W / 2 + 12 || Math.abs(p.y - camY) > H / 2 + 12) continue;
      p.draw(ctx, camX - W / 2, camY - H / 2);
    }
  }
}
