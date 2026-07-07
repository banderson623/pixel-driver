// Game orchestration: menu / play / dead states, camera with trauma shake,
// HUD (damage meter + speedometer), and the per-frame update/render loop.

import { World } from './world.js';
import { PlayerCar, CarBody, VEHICLES, VEHICLE_KEYS } from './car.js';
import { Traffic } from './traffic.js';
import { Pedestrians } from './pedestrians.js';
import { Particles } from './particles.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { hashStr } from './rng.js';
import { drawText, drawTextCentered, textWidth } from './font.js';

export const W = 400, H = 300;

// City speed limit (mph). Exceeding it in Rap Sheet mode is an infraction.
const SPEED_LIMIT = 40;

// Selectable game modes. 'cruise' is the original drive-till-totaled sandbox;
// 'rapsheet' layers a live tally of traffic infractions on top.
const MODES = ['cruise', 'rapsheet'];
const MODE_NAMES = { cruise: 'FREE DRIVE', rapsheet: 'RAP SHEET' };

function newInfractions() {
  return { speeding: 0, offroad: 0, wrongWay: 0, redLight: 0, wreck: 0, blownUp: 0, pedestrian: 0 };
}
function infractionTotal(inf) {
  return inf.speeding + inf.offroad + inf.wrongWay + inf.redLight + inf.wreck + inf.blownUp + inf.pedestrian;
}
// Penalty points per infraction — speeding is minor, killing a pedestrian is
// the worst thing you can do. The severity score weights the raw count by these.
const WEIGHTS = { speeding: 1, offroad: 2, wrongWay: 3, redLight: 5, wreck: 8, blownUp: 12, pedestrian: 20 };
function infractionScore(inf) {
  let s = 0;
  for (const k in WEIGHTS) s += inf[k] * WEIGHTS[k];
  return s;
}

class Camera {
  constructor() {
    this.x = 0; this.y = 0;
    this.sx = 0; this.sy = 0;
    this.trauma = 0;
    this.t = 0;
  }
  addTrauma(t) { this.trauma = Math.min(1, this.trauma + t); }
  update(dt, player) {
    this.t += dt;
    const look = 0.32;
    const tx = player.x + player.vx * look;
    const ty = player.y + player.vy * look;
    const k = Math.min(1, 4.5 * dt);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
    // constant low rumble at speed + decaying crash trauma
    const rumble = Math.min(1, player.speed() / 250) * 0.06;
    this.trauma = Math.max(rumble, this.trauma - 1.7 * dt);
    const s = this.trauma * this.trauma * 9;
    this.sx = (Math.sin(this.t * 91) + Math.sin(this.t * 47.3)) * 0.5 * s;
    this.sy = (Math.cos(this.t * 83) + Math.sin(this.t * 59.7)) * 0.5 * s;
  }
  left() { return this.x + this.sx - W / 2; }
  top() { return this.y + this.sy - H / 2; }
}

function randomSeedStr() {
  return String(10000 + Math.floor(Math.random() * 90000));
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.input = new Input();
    this.sound = new Sound();
    this.state = 'menu';
    this.seedStr = randomSeedStr();
    this.menuT = 0;
    this.fps = 60;
    this.muteFlash = 0;
    // selected vehicle (remembered between sessions)
    this.vehicleKey = VEHICLE_KEYS.includes(localStorage.getItem('pixeldriver.vehicle'))
      ? localStorage.getItem('pixeldriver.vehicle') : 'car';
    // selected game mode (remembered between sessions)
    this.mode = MODES.includes(localStorage.getItem('pixeldriver.mode'))
      ? localStorage.getItem('pixeldriver.mode') : 'cruise';
    this.buildMenuCar();
    this.buildMenuWorld();

    window.addEventListener('keydown', () => this.sound.ensure(), { once: false });
    window.addEventListener('pointerdown', () => this.sound.ensure());
  }

  // Dev test pad: these seeds generate open pavement with no obstacles.
  isFlatSeed() {
    const s = this.seedStr.toUpperCase();
    return s === 'TESTPAD' || s === 'FLAT' || s === 'DEV';
  }

  buildMenuCar() {
    const v = VEHICLES[this.vehicleKey];
    this.menuCar = new CarBody(v.base, v.stripe, v.design);
  }

  switchVehicle(dir) {
    const i = VEHICLE_KEYS.indexOf(this.vehicleKey);
    this.vehicleKey = VEHICLE_KEYS[(i + dir + VEHICLE_KEYS.length) % VEHICLE_KEYS.length];
    try { localStorage.setItem('pixeldriver.vehicle', this.vehicleKey); } catch (e) { /* ignore */ }
    this.buildMenuCar();
  }

  switchMode(dir) {
    const i = MODES.indexOf(this.mode);
    this.mode = MODES[(i + dir + MODES.length) % MODES.length];
    try { localStorage.setItem('pixeldriver.mode', this.mode); } catch (e) { /* ignore */ }
  }

  buildMenuWorld() {
    this.world = new World(hashStr(this.seedStr), this.isFlatSeed());
    this.camera = new Camera();
    const vx = this.world.vA.center(0);
    this.camera.x = vx; this.camera.y = 60;
  }

  startRun() {
    const seed = hashStr(this.seedStr);
    this.world = new World(seed, this.isFlatSeed());
    this.particles = new Particles();
    this.traffic = new Traffic(this.world, this.mode);
    this.pedestrians = new Pedestrians(this.world);
    this.camera = new Camera();
    const vx = this.world.vA.center(0);
    const hy = this.world.hA.center(0);
    // spawn heading up (-y) on the right-hand lane of vertical road 0
    this.player = new PlayerCar(vx + 12, hy + 90, 0, VEHICLES[this.vehicleKey]);
    this.camera.x = this.player.x; this.camera.y = this.player.y;
    this.stats = {
      t: 0, dist: 0, topSpeed: 0, carsHit: 0, propsSmashed: 0,
      cellsDestroyed: 0, lastHitT: -10, peds: 0,
      infractions: newInfractions(), lastInfractionT: -10, lastWreckT: -10,
    };
    // infraction edge-detector state (see trackInfractions)
    this._speeding = false;
    this._offRoadClear = true;
    this._wrongClear = true;
    this._interId = null;
    this.deathT = 0;
    this.sound.suppressed = false;
    this.state = 'play';
  }

  update(dt) {
    if (this.input.pressed('KeyM')) {
      const m = this.sound.toggleMute();
      this.muteFlash = 1.5;
      this.muteState = m;
    }
    this.muteFlash = Math.max(0, this.muteFlash - dt);

    switch (this.state) {
      case 'menu': this.updateMenu(dt); break;
      case 'play': this.updatePlay(dt); break;
      case 'dead': this.updateDead(dt); break;
    }
    this.input.endFrame();
  }

  updateMenu(dt) {
    this.menuT += dt;
    // slow scenic pan
    const vx = this.world.vA.center(0);
    this.camera.x = vx + Math.sin(this.menuT * 0.11) * 150;
    this.camera.y = Math.cos(this.menuT * 0.07) * 220;
    this.world.setFocus(this.camera.x, this.camera.y);

    // seed editing
    for (const key of this.input.readTyped()) {
      if (key === 'Backspace') this.seedStr = this.seedStr.slice(0, -1);
      else if (/^[a-zA-Z0-9]$/.test(key) && this.seedStr.length < 10) {
        this.seedStr += key.toUpperCase();
        this.buildMenuWorld();
      }
    }
    if (this.input.pressed('Backspace')) this.buildMenuWorld();
    // vehicle select
    if (this.input.pressed('ArrowLeft')) this.switchVehicle(-1);
    if (this.input.pressed('ArrowRight')) this.switchVehicle(1);
    // game mode select
    if (this.input.pressed('ArrowUp')) this.switchMode(-1);
    if (this.input.pressed('ArrowDown')) this.switchMode(1);
    if (this.input.pressed('Enter')) {
      if (!this.seedStr.length) this.seedStr = randomSeedStr();
      this.sound.ensure();
      this.startRun();
    }
  }

  updatePlay(dt) {
    const env = {
      world: this.world, particles: this.particles, sound: this.sound,
      camera: this.camera, stats: this.stats, player: this.player,
      t: this.stats.t, obstacles: [],
    };
    this.stats.t += dt;
    env.t = this.stats.t;

    this.player.update(dt, this.input, env);
    this.traffic.update(dt, env);
    this.pedestrians.update(dt, env);
    this.particles.update(dt);
    this.updateEmitters(dt);
    this.camera.update(dt, this.player);
    this.world.setFocus(this.player.x, this.player.y);
    this.trackInfractions();

    const mph = this.player.speedMph();
    this.stats.topSpeed = Math.max(this.stats.topSpeed, mph);
    this.stats.dist += this.player.speed() * dt * 0.19 / 1609; // px→m→mi

    // audio
    this.sound.setListener(this.player.x, this.player.y);
    const [fx, fy] = this.player.forward();
    const vf = Math.abs(this.player.vx * fx + this.player.vy * fy);
    const rpm = Math.min(1, vf / 250) * 0.8 + (this.input.down('ArrowUp', 'KeyW') ? 0.2 : 0);
    this.sound.setEngine(rpm, !this.player.dead);
    this.sound.setSkid(this.player.skidding ? this.player.skidLevel : 0);
    // sirens wail louder the closer the nearest pursuing cop is
    let siren = 0;
    for (const c of this.traffic.cars) {
      if (!c.pursuit) continue;
      siren = Math.max(siren, 1 - Math.hypot(c.x - this.player.x, c.y - this.player.y) / 520);
    }
    this.sound.setSiren(siren);

    if (this.player.damage >= 100 && !this.player.dead) {
      this.player.dead = true;
      this.deathT = 0;
      this.camera.addTrauma(1);
      this.sound.crash(1);
      // blow pixels off the whole body
      this.player.deformAtWorld(this.player.x, this.player.y, 1, env);
      this.particles.debris(this.player.x, this.player.y, '#c23b3b', 14, 120);
      this.particles.sparks(this.player.x, this.player.y, 12);
      this.world.emitters.push({ x: this.player.x, y: this.player.y, type: 'fire', ttl: 30, acc: 0 });
      this.state = 'dead';
    }
    if (this.input.pressed('Escape')) {
      this.state = 'menu';
      this.sound.setEngine(0, false);
      this.sound.setSkid(0);
      this.sound.setSiren(0);
      this.buildMenuWorld();
    }
  }

  // Detect the three "driving" infractions each frame (wrecks and pedestrian
  // hits are counted at their collision sites). Each uses edge detection so a
  // sustained offense counts once per episode, not once per frame.
  trackInfractions() {
    const s = this.stats, inf = s.infractions, p = this.player;
    if (p.dead) return;

    // speeding: one count each time you cross above the limit (hysteresis so
    // hovering at the limit doesn't rack up dozens)
    const mph = p.speedMph();
    if (!this._speeding && mph > SPEED_LIMIT) {
      this._speeding = true;
      inf.speeding++; s.lastInfractionT = s.t;
    } else if (this._speeding && mph < SPEED_LIMIT - 6) {
      this._speeding = false;
    }

    // off-road: one count per excursion off the asphalt
    if (this.world.isRoad(p.x, p.y)) {
      this._offRoadClear = true;
    } else if (this._offRoadClear) {
      this._offRoadClear = false;
      inf.offroad++; s.lastInfractionT = s.t;
    }

    // running a red: count when you first enter an intersection box whose
    // signal (for your direction of travel) is red
    const vi = this.world.vA.nearest(p.x), hj = this.world.hA.nearest(p.y);
    const vcx = this.world.vA.centerAt(vi.k, p.y), hcy = this.world.hA.centerAt(hj.k, p.x);
    const vHalf = this.world.vA.half(vi.k), hHalf = this.world.hA.half(hj.k);
    const inBox = Math.abs(p.x - vcx) < vHalf + 3 && Math.abs(p.y - hcy) < hHalf + 3;
    if (!inBox) {
      this._interId = null;
    } else {
      const id = vi.k + ',' + hj.k;
      if (this._interId !== id) {
        this._interId = id;
        if (this.world.hasLight(vi.k, hj.k)) {
          const ph = this.world.lightPhase(vi.k, hj.k, s.t);
          const st = Math.abs(p.vy) >= Math.abs(p.vx) ? ph.ns : ph.ew;
          if (st === 'r') { inf.redLight++; s.lastInfractionT = s.t; }
        }
      }
    }

    // wrong side of the road (right-hand traffic): the correct lane is on your
    // right, so the signed offset from road center must oppose your heading on
    // a vertical road and match it on a horizontal one. Only checked while
    // clearly driving down a lane — never at an intersection or off the road.
    const dxv = p.x - vcx, dyh = p.y - hcy;
    const movingNS = Math.abs(p.vy) >= Math.abs(p.vx);
    let onWrong = false, onCorrect = false;
    if (mph > 8 && !inBox) {
      if (movingNS && Math.abs(dxv) < vHalf && Math.abs(dxv) > 3) {
        const dir = Math.sign(p.vy);
        if (dir !== 0) { if (dxv * dir > 0) onWrong = true; else onCorrect = true; }
      } else if (!movingNS && Math.abs(dyh) < hHalf && Math.abs(dyh) > 3) {
        const dir = Math.sign(p.vx);
        if (dir !== 0) { if (dyh * dir < 0) onWrong = true; else onCorrect = true; }
      }
    }
    if (onCorrect) this._wrongClear = true;
    else if (onWrong && this._wrongClear) {
      this._wrongClear = false;
      inf.wrongWay++; s.lastInfractionT = s.t;
    }
  }

  updateDead(dt) {
    this.deathT += dt;
    // dead = silent: kill the engine/skid/siren and gag every one-shot effect
    this.sound.suppressed = true;
    this.sound.setEngine(0, false);
    this.sound.setSkid(0);
    this.sound.setSiren(0);

    // the wreck keeps burning and the city keeps moving for a while, then the
    // whole world freezes (you can still restart with R or bail with Esc)
    if (this.deathT < 15) {
      const env = {
        world: this.world, particles: this.particles, sound: this.sound,
        camera: this.camera, stats: this.stats, player: this.player,
        t: this.stats.t, obstacles: [],
      };
      this.stats.t += dt;
      env.t = this.stats.t;
      this.player.update(dt, this.input, env); // rolls to a stop, burns
      this.traffic.update(dt, env);
      this.pedestrians.update(dt, env);
      this.particles.update(dt);
      this.updateEmitters(dt);
      this.camera.update(dt, this.player);
      this.sound.setListener(this.player.x, this.player.y);
    }

    if (this.deathT > 1 && this.input.pressed('KeyR')) this.startRun();
    if (this.input.pressed('Escape')) {
      this.sound.suppressed = false;
      this.state = 'menu';
      this.buildMenuWorld();
    }
  }

  updateEmitters(dt) {
    const em = this.world.emitters;
    for (let i = em.length - 1; i >= 0; i--) {
      const e = em[i];
      e.ttl -= dt;
      if (e.ttl <= 0) { em.splice(i, 1); continue; }
      e.acc += dt;
      const rate = e.type === 'water' ? 0.02 : 0.05;
      while (e.acc > rate) {
        e.acc -= rate;
        if (e.type === 'water') this.particles.water(e.x, e.y);
        else if (e.type === 'fire') {
          const p = this.player;
          this.particles.fire(p.x + (Math.random() - 0.5) * 8, p.y + (Math.random() - 0.5) * 10);
          this.particles.engineSmoke(p.x, p.y, true);
        }
      }
    }
  }

  // ------------------------------------------------------------- rendering
  render() {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    const cam = this.camera;
    const left = Math.round(cam.left()), top = Math.round(cam.top());

    this.world.draw(ctx, left + W / 2, top + H / 2, W, H);

    if (this.state !== 'menu') {
      this.pedestrians.draw(ctx, left + W / 2, top + H / 2, W, H);
      this.traffic.draw(ctx, left + W / 2, top + H / 2, W, H);
      this.player.draw(ctx, left, top);
      ctx.save();
      ctx.translate(-left, -top);
      this.particles.draw(ctx);
      ctx.restore();
    }
    this.world.drawOverhead(ctx, left + W / 2, top + H / 2, W, H, this.stats ? this.stats.t : 0);

    switch (this.state) {
      case 'menu': this.renderMenu(ctx); break;
      case 'play': this.renderHud(ctx); break;
      case 'dead': this.renderHud(ctx); this.renderDead(ctx); break;
    }

    if (this.muteFlash > 0) {
      drawTextCentered(ctx, this.muteState ? 'SOUND OFF' : 'SOUND ON', W / 2, 34, 1, '#ffffff');
    }
    drawText(ctx, `${Math.round(this.fps)}`, W - 12, H - 8, 1, 'rgba(255,255,255,0.25)');
  }

  renderHud(ctx) {
    const s = this.stats;
    // damage meter
    const flash = s.t - s.lastHitT < 0.25;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(6, 6, 96, 20);
    drawText(ctx, 'DAMAGE', 10, 9, 1, flash ? '#ffffff' : '#c8c8d0');
    ctx.fillStyle = '#0c0c10';
    ctx.fillRect(10, 16, 88, 6);
    const dmg = this.player.damage / 100;
    const r = Math.round(120 + dmg * 135), g = Math.round(160 - dmg * 130);
    ctx.fillStyle = `rgb(${r},${g},40)`;
    ctx.fillRect(10, 16, Math.round(88 * dmg), 6);
    if (flash) {
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(9.5, 15.5, 89, 7);
    }

    // speedometer
    const mph = Math.round(this.player.speedMph());
    const over = this.mode === 'rapsheet' && mph > SPEED_LIMIT;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(6, H - 34, 86, 28);
    drawText(ctx, String(mph).padStart(3, ' '), 12, H - 29, 2, over ? '#e05545' : '#ffffff');
    drawText(ctx, 'MPH', 40, H - 24, 1, '#9a9aa4');
    if (this.mode === 'rapsheet') drawText(ctx, `LIM ${SPEED_LIMIT}`, 63, H - 31, 1, over ? '#e05545' : '#6a6a74');
    ctx.fillStyle = '#0c0c10';
    ctx.fillRect(10, H - 14, 78, 5);
    const sp = Math.min(1, mph / 110);
    ctx.fillStyle = sp < 0.5 ? '#39d353' : sp < 0.8 ? '#e8c33a' : '#e05545';
    ctx.fillRect(10, H - 14, Math.round(78 * sp), 5);

    // steering wheel gauge (shows driver input; tints as the car slides)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(96, H - 34, 40, 28);
    drawText(ctx, 'STEER', 100, H - 31, 1, '#9a9aa4');
    this.drawSteeringWheel(ctx, 116, H - 16, 9, this.player.steerS, this.player.skidLevel);

    // seed + odometer
    const info = `SEED ${this.seedStr}  ${s.dist.toFixed(2)} MI`;
    drawText(ctx, info, W - textWidth(info, 1) - 6, 9, 1, 'rgba(255,255,255,0.55)');

    // rap-sheet penalty points, shown large (top center)
    if (this.mode === 'rapsheet') {
      const pts = infractionScore(s.infractions);
      const flash = s.t - s.lastInfractionT < 0.4;
      drawTextCentered(ctx, String(pts), W / 2, 6, 3, flash ? '#ffffff' : '#e05545');
      drawTextCentered(ctx, 'PTS', W / 2, 24, 1, flash ? '#ffffff' : '#9a9aa4');
    }

    // cops in pursuit — flashing red/blue like a siren, shown while chased
    const pursuers = this.traffic ? this.traffic.pursuers() : 0;
    if (pursuers > 0) {
      const y = this.mode === 'rapsheet' ? 34 : 8;
      const phase = Math.floor(s.t * 6) % 2;
      drawTextCentered(ctx, `${pursuers} IN PURSUIT`, W / 2, y, 1, phase ? '#e05545' : '#3a7bff');
    }
  }

  // Top-down steering wheel that rotates with steerS. A fixed notch marks
  // 12 o'clock so you can read the wheel's offset from straight-ahead.
  drawSteeringWheel(ctx, cx, cy, r, steer, skid) {
    const t = Math.min(1, skid);
    const col = t < 0.45 ? '#ffffff' : t < 0.8 ? '#e8c33a' : '#e05545';
    // fixed reference notch (does not rotate)
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(cx - 1, cy - r - 3, 2, 3);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(steer * 2.4); // full lock ~ +/-137 degrees
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r, 0); ctx.lineTo(r, 0); // horizontal spokes
    ctx.moveTo(0, 0); ctx.lineTo(0, r);  // lower spoke
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillRect(-2, -2, 4, 4);           // hub
    ctx.restore();
  }

  renderMenu(ctx) {
    ctx.fillStyle = 'rgba(8,8,14,0.48)';
    ctx.fillRect(0, 0, W, H);

    const bob = Math.sin(this.menuT * 2) * 2;
    drawTextCentered(ctx, 'DOWNTOWN', W / 2 + 2, 38 + bob + 2, 4, 'rgba(0,0,0,0.6)');
    drawTextCentered(ctx, 'DOWNTOWN', W / 2, 38 + bob, 4, '#e8c33a');
    drawTextCentered(ctx, 'DRIFTER', W / 2 + 2, 64 + bob + 2, 4, 'rgba(0,0,0,0.6)');
    drawTextCentered(ctx, 'DRIFTER', W / 2, 64 + bob, 4, '#e05545');

    // spinning selected vehicle
    ctx.save();
    ctx.translate(W / 2, 116);
    ctx.rotate(Math.sin(this.menuT * 0.9) * 0.35 + 0.2);
    ctx.scale(2, 2);
    ctx.drawImage(this.menuCar.canvas, -this.menuCar.w / 2, -this.menuCar.h / 2);
    ctx.restore();

    // vehicle selector: < NAME >  with tagline underneath
    const v = VEHICLES[this.vehicleKey];
    drawTextCentered(ctx, `< ${v.name} >`, W / 2, 150, 2, '#e8c33a');
    drawTextCentered(ctx, v.tagline, W / 2, 168, 1, '#39d353');

    // game-mode selector
    drawTextCentered(ctx, `- ${MODE_NAMES[this.mode]} -`, W / 2, 182, 1, '#e07050');

    const blink = Math.floor(this.menuT * 2) % 2 === 0 ? '_' : ' ';
    drawTextCentered(ctx, `SEED: ${this.seedStr}${blink}`, W / 2, 196, 1, '#ffffff');
    drawTextCentered(ctx, '< > CAR   UP/DN MODE   TYPE SEED', W / 2, 208, 1, '#8a8a94');

    if (Math.floor(this.menuT * 1.4) % 2 === 0) {
      drawTextCentered(ctx, '- PRESS ENTER TO DRIVE -', W / 2, 224, 1, '#39d353');
    }
    drawTextCentered(ctx, 'WASD / ARROWS : DRIVE', W / 2, 244, 1, '#c8c8d0');
    drawTextCentered(ctx, 'SPACE : HANDBRAKE   M : SOUND', W / 2, 256, 1, '#c8c8d0');
    const flavor = this.mode === 'rapsheet'
      ? 'HOW MANY LAWS CAN YOU BREAK?' : 'DRIVE UNTIL YOUR CAR IS TOTALED';
    drawTextCentered(ctx, flavor, W / 2, 270, 1, '#6a6a74');
  }

  renderDead(ctx) {
    if (this.deathT < 1) return;
    const a = Math.min(0.6, (this.deathT - 1) * 0.8);
    ctx.fillStyle = `rgba(20,4,6,${a.toFixed(2)})`;
    ctx.fillRect(0, 0, W, H);
    const sh = Math.max(0, 1.6 - this.deathT) * 3;
    const ox = (Math.random() - 0.5) * sh, oy = (Math.random() - 0.5) * sh;
    const ty = this.mode === 'rapsheet' ? 52 : 70;
    drawTextCentered(ctx, 'TOTALED!', W / 2 + ox + 2, ty + oy + 2, 4, 'rgba(0,0,0,0.7)');
    drawTextCentered(ctx, 'TOTALED!', W / 2 + ox, ty + oy, 4, '#e05545');

    const promptY = this.mode === 'rapsheet'
      ? (this.renderRapSheet(ctx), 214) : (this.renderRunStats(ctx), 200);

    if (this.deathT > 1.6 && Math.floor(this.deathT * 1.5) % 2 === 0) {
      drawTextCentered(ctx, 'R : DRIVE AGAIN    ESC : MENU', W / 2, promptY, 1, '#39d353');
    }
  }

  renderRunStats(ctx) {
    const s = this.stats;
    const lines = [
      `DISTANCE  ${s.dist.toFixed(2)} MI`,
      `TOP SPEED ${Math.round(s.topSpeed)} MPH`,
      `CARS HIT  ${s.carsHit}`,
      `SMASHED   ${s.propsSmashed + Math.floor(s.cellsDestroyed / 40)}`,
    ];
    lines.forEach((l, i) => drawTextCentered(ctx, l, W / 2, 120 + i * 14, 1, '#e8e8e8'));
  }

  // Itemized ledger of everything you did wrong, styled like a citation. Each
  // row shows the count and its weighted penalty points; the score sums them.
  renderRapSheet(ctx) {
    const inf = this.stats.infractions;
    const x0 = W / 2 - 56, x1 = W / 2 + 56;
    const xCt = W / 2 + 22; // right edge of the count column
    drawTextCentered(ctx, '- RAP SHEET -', W / 2, 88, 1, '#e8c33a');
    const rows = [
      ['SPEEDING', 'speeding'],
      ['OFF-ROAD', 'offroad'],
      ['WRONG WAY', 'wrongWay'],
      ['RAN REDS', 'redLight'],
      ['WRECKS', 'wreck'],
      ['BLEW UP', 'blownUp'],
      ['PEDESTRIANS', 'pedestrian'],
    ];
    rows.forEach(([label, key], i) => {
      const y = 100 + i * 11;
      const n = inf[key], pts = n * WEIGHTS[key];
      const col = n > 0 ? '#e05545' : '#6a6a74';
      drawText(ctx, label, x0, y, 1, n > 0 ? '#c8c8d0' : '#6a6a74');
      const cv = String(n);
      drawText(ctx, cv, xCt - textWidth(cv, 1), y, 1, col);
      const pv = pts > 0 ? '+' + pts : '-';
      drawText(ctx, pv, x1 - textWidth(pv, 1), y, 1, col);
    });
    // column captions (small, above the first row)
    drawText(ctx, 'CT', xCt - textWidth('CT', 1), 94, 1, '#6a6a74');
    drawText(ctx, 'PTS', x1 - textWidth('PTS', 1), 94, 1, '#6a6a74');
    // divider + weighted severity score
    ctx.fillStyle = '#3a3a44';
    ctx.fillRect(x0, 179, x1 - x0, 1);
    drawText(ctx, 'SEVERITY', x0, 185, 1, '#ffffff');
    const sv = String(infractionScore(inf));
    drawText(ctx, sv, x1 - textWidth(sv, 2), 183, 2, '#ffffff');
  }
}
