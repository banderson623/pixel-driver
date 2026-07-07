// Sidewalk pedestrians: tiny pixel people who keep to the sidewalks and only
// step into the road at crosswalks. They walk beside a road at a fixed lateral
// offset (SIDE_OFF) — that offset lands squarely on the painted crosswalk
// bands, so walking straight through an intersection naturally follows the
// stripes, and "crossing to the other side" hops across on the same bands.
// The player can mow them down: a hit sprays blood, stains the ground, and
// (in Rap Sheet mode) counts as an infraction.

import { SIDEWALK, lakeShore } from './world.js';

// Sidewalk centreline offset from a road centre = half(k)+SIDEWALK/2, which
// lands inside that road's crosswalk band. Scales with the road's width, so
// pedestrians hug the kerb of a wide highway just as they do a narrow street.
const sideOff = (axis, k) => axis.half(k) + SIDEWALK / 2;
const crossBand = (axis, k) => axis.half(k) + 6; // along-offset to the crosswalk
const TARGET = 12;
const DESPAWN_R = 460;
const HIT_R = 8;

const SHIRTS = ['#c94f4f', '#4f7ec9', '#4faf5a', '#c9a63a', '#9a5fc9', '#3ab0b0', '#d07fb0', '#d8d8d8'];
const SKIN = ['#caa07a', '#a5744c', '#e3b98f', '#8a5a34'];
const TOWELS = ['#d84f4f', '#4f7ed8', '#e8c33a', '#3ab0a0', '#d07fb0', '#efe9dc'];
const SWIM = ['#e05545', '#3f78d2', '#e8c33a', '#39d353', '#d07fb0', '#ff8c42', '#9a5fc9'];

let uid = 1;

// Shared gore: getting run over works the same on a sidewalk or a beach.
function splatter(p, vx, vy, env) {
  p.dead = true;
  p.vx = vx; p.vy = vy;
  p.stopT = 0.7;
  env.particles.debris(p.x, p.y, '#8a1414', 6, 95);
  env.particles.debris(p.x, p.y, p.shirt, 4, 70);
  env.world.decal(p.x, p.y, (g) => {
    g.fillStyle = 'rgba(120,16,16,0.5)';
    g.fillRect(-2, -2, 4, 4);
    g.fillStyle = 'rgba(120,16,16,0.28)';
    g.fillRect(-4, -1, 8, 2); g.fillRect(-1, -4, 2, 8);
  });
}

class Ped {
  // Walks along road `k` of the given axis, on `side` (+1/-1), heading `dir`.
  constructor(axis, k, side, dir, along, world) {
    this.id = uid++;
    this.axis = axis; this.k = k; this.side = side; this.dir = dir;
    this.along = along;
    const ax = axis === 'v' ? world.vA : world.hA;
    this.lat = ax.centerAt(k, along) + side * sideOff(ax, k);
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
    const roadC = axisA.centerAt(this.k, this.along);
    const off = sideOff(axisA, this.k);
    this.step += this.speed * dt * 0.35;

    // crossing the street to the opposite sidewalk (moving laterally along a
    // crosswalk band, `along` held fixed)
    if (this.mode === 'cross') {
      const target = roadC - this.side * off;
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
    const laneC = roadC + this.side * off;
    this.lat += (laneC - this.lat) * Math.min(1, 6 * dt);
    this.along += this.dir * this.speed * dt;

    // at each crosswalk, maybe cross the street, U-turn, or just keep going
    // (going straight already tracks the perpendicular road's crosswalk)
    const j = perpA.locate(this.along);
    const jn = this.dir > 0 ? j + 1 : j;
    const nearBand = perpA.center(jn) - this.dir * crossBand(perpA, jn);
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

  kill(vx, vy, env) { splatter(this, vx, vy, env); }

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

// Beachgoers around a lake: loungers lie on towels soaking up the sun;
// players romp between spots straddling the waterline, splashing in the
// shallows. They share the pedestrian roster (and can be run over the same
// way) but never leave their lake.
class BeachPed {
  constructor(lk) {
    this.id = uid++;
    this.lk = lk;
    this.beach = true;
    this.dead = false;
    this.vx = 0; this.vy = 0; this.stopT = 0;
    this.shirt = SWIM[Math.floor(Math.random() * SWIM.length)];
    this.skin = SKIN[Math.floor(Math.random() * SKIN.length)];
    this.towel = TOWELS[Math.floor(Math.random() * TOWELS.length)];
    this.lounging = Math.random() < 0.55;
    this.speed = 8 + Math.random() * 10;
    this.step = Math.random() * 4;
    this.pauseT = 0;
    const a = Math.random() * Math.PI * 2;
    // loungers settle on the sand; players start near the waterline
    const u = this.lounging ? 1.06 + Math.random() * (lk.beach * 0.8)
                            : 0.92 + Math.random() * 0.24;
    [this.x, this.y] = this.spot(a, u);
    this.tx = this.x; this.ty = this.y;
  }

  // world point at shore-angle a and normalized shore distance u (1 = waterline)
  spot(a, u) {
    const w = lakeShore(this.lk, a);
    return [this.lk.cx + Math.cos(a) * this.lk.rx * u * w,
            this.lk.cy + Math.sin(a) * this.lk.ry * u * w];
  }

  // normalized shore distance of the current position (<1 = in the water)
  shoreU() {
    const dx = this.x - this.lk.cx, dy = this.y - this.lk.cy;
    return Math.hypot(dx / this.lk.rx, dy / this.lk.ry) / lakeShore(this.lk, Math.atan2(dy, dx));
  }

  update(dt, env) {
    if (this.dead) {
      this.x += this.vx * dt; this.y += this.vy * dt;
      this.vx *= Math.exp(-4 * dt); this.vy *= Math.exp(-4 * dt);
      this.stopT -= dt;
      return;
    }
    this.step += this.speed * dt * 0.35;
    if (this.lounging) return;                       // soaking up the sun
    if (this.pauseT > 0) { this.pauseT -= dt; return; }
    const dx = this.tx - this.x, dy = this.ty - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) {
      // pick the next romp spot a little way along the shore
      const a = Math.atan2(this.y - this.lk.cy, this.x - this.lk.cx) + (Math.random() - 0.5) * 1.4;
      [this.tx, this.ty] = this.spot(a, 0.90 + Math.random() * 0.3);
      if (Math.random() < 0.4) this.pauseT = 0.3 + Math.random() * 1.2;
    } else {
      const inWater = this.shoreU() < 1;
      const sp = this.speed * (inWater ? 0.55 : 1);  // wading is slow
      this.x += (dx / d) * sp * dt;
      this.y += (dy / d) * sp * dt;
      if (inWater && Math.random() < dt * 1.5) env.particles.water(this.x, this.y);
    }
  }

  kill(vx, vy, env) { splatter(this, vx, vy, env); }

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
    if (this.lounging) {
      ctx.fillStyle = this.towel;
      ctx.fillRect(x - 3, y - 2, 6, 4);
      ctx.fillStyle = this.shirt;         // sunbather stretched along the towel
      ctx.fillRect(x - 2, y - 1, 3, 2);
      ctx.fillStyle = this.skin;
      ctx.fillRect(x + 1, y - 1, 1, 1);
      return;
    }
    // splashing about: the standard walker with an exaggerated hop
    const bob = Math.floor(this.step) & 1;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - 1, y + 2, 3, 1);
    ctx.fillStyle = '#2c2c34';
    ctx.fillRect(x - 1 + bob, y + 1, 1, 1);
    ctx.fillRect(x + 1 - bob, y + 1, 1, 1);
    ctx.fillStyle = this.shirt;
    ctx.fillRect(x - 1, y - 1 - bob, 2, 2);
    ctx.fillStyle = this.skin;
    ctx.fillRect(x - 1, y - 3 - bob, 2, 1);
  }
}

export class Pedestrians {
  constructor(world) {
    this.world = world;
    this.peds = [];
    this.spawnT = 0;
    this.beachKeys = new Set();   // lake blocks whose crowd is already placed
  }

  update(dt, env) {
    const player = env.player;
    this.spawnT -= dt;
    if (!this.world.flat && this.spawnT <= 0) {
      this.spawnT = 0.5;
      this.syncBeaches(player);
      // beach crowds don't count against the sidewalk-stroller budget
      const alive = this.peds.reduce((n, p) => n + (p.dead || p.beach ? 0 : 1), 0);
      if (alive < TARGET) this.trySpawn(player);
      for (let i = this.peds.length - 1; i >= 0; i--) {
        const p = this.peds[i];
        // beach peds live longer so a lakeshore doesn't empty out mid-visit
        const r = p.beach ? 700 : DESPAWN_R;
        if (Math.hypot(p.x - player.x, p.y - player.y) > r) this.peds.splice(i, 1);
      }
    }
    for (const p of this.peds) p.update(dt, env);
    this.collide(env);
  }

  // Drop a crowd on each lake beach as the player approaches. One batch per
  // lake; the claim is released once the player is far enough away that the
  // whole crowd has despawned, so a return visit finds the beach busy again.
  syncBeaches(player) {
    const world = this.world;
    const iA = world.vA.locate(player.x - 450), iB = world.vA.locate(player.x + 450);
    const jA = world.hA.locate(player.y - 450), jB = world.hA.locate(player.y + 450);
    for (let i = iA; i <= iB; i++) {
      for (let j = jA; j <= jB; j++) {
        const L = world.block(i, j);
        if (L.type !== 'lake') continue;
        const key = i + ',' + j;
        if (this.beachKeys.has(key)) continue;
        const lk = L.lake;
        if (Math.hypot(lk.cx - player.x, lk.cy - player.y) > 620) continue;
        this.beachKeys.add(key);
        const n = 5 + Math.floor(Math.random() * 5);
        for (let m = 0; m < n; m++) this.peds.push(new BeachPed(lk));
      }
    }
    for (const key of [...this.beachKeys]) {
      const [i, j] = key.split(',').map(Number);
      const cx = (world.vA.center(i) + world.vA.center(i + 1)) / 2;
      const cy = (world.hA.center(j) + world.hA.center(j + 1)) / 2;
      if (Math.hypot(cx - player.x, cy - player.y) > 900) this.beachKeys.delete(key);
    }
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
