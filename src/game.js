// Game orchestration: menu / play / dead states, camera with trauma shake,
// HUD (damage meter + speedometer), and the per-frame update/render loop.

import { World } from './world.js';
import { PlayerCar, CarBody } from './car.js';
import { Traffic } from './traffic.js';
import { Particles } from './particles.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { hashStr } from './rng.js';
import { drawText, drawTextCentered, textWidth } from './font.js';

export const W = 400, H = 300;

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
    this.menuCar = new CarBody('#c23b3b', '#e8e8e8');
    this.buildMenuWorld();

    window.addEventListener('keydown', () => this.sound.ensure(), { once: false });
    window.addEventListener('pointerdown', () => this.sound.ensure());
  }

  // Dev test pad: these seeds generate open pavement with no obstacles.
  isFlatSeed() {
    const s = this.seedStr.toUpperCase();
    return s === 'TESTPAD' || s === 'FLAT' || s === 'DEV';
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
    this.traffic = new Traffic(this.world);
    this.camera = new Camera();
    const vx = this.world.vA.center(0);
    const hy = this.world.hA.center(0);
    // spawn heading up (-y) on the right-hand lane of vertical road 0
    this.player = new PlayerCar(vx + 12, hy + 90, 0);
    this.camera.x = this.player.x; this.camera.y = this.player.y;
    this.stats = {
      t: 0, dist: 0, topSpeed: 0, carsHit: 0, propsSmashed: 0,
      cellsDestroyed: 0, lastHitT: -10,
    };
    this.deathT = 0;
    this.state = 'play';
    // TODO(police): track red-light running + hit counts here to feed a
    // future wanted level / police chase system.
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
    this.particles.update(dt);
    this.updateEmitters(dt);
    this.camera.update(dt, this.player);
    this.world.setFocus(this.player.x, this.player.y);

    const mph = this.player.speedMph();
    this.stats.topSpeed = Math.max(this.stats.topSpeed, mph);
    this.stats.dist += this.player.speed() * dt * 0.19 / 1609; // px→m→mi

    // audio
    const [fx, fy] = this.player.forward();
    const vf = Math.abs(this.player.vx * fx + this.player.vy * fy);
    const rpm = Math.min(1, vf / 250) * 0.8 + (this.input.down('ArrowUp', 'KeyW') ? 0.2 : 0);
    this.sound.setEngine(rpm, !this.player.dead);
    this.sound.setSkid(this.player.skidding ? this.player.skidLevel : 0);

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
      this.buildMenuWorld();
    }
  }

  updateDead(dt) {
    this.deathT += dt;
    const env = {
      world: this.world, particles: this.particles, sound: this.sound,
      camera: this.camera, stats: this.stats, player: this.player,
      t: this.stats.t, obstacles: [],
    };
    this.stats.t += dt;
    env.t = this.stats.t;
    this.player.update(dt, this.input, env); // rolls to a stop, burns
    this.traffic.update(dt, env);
    this.particles.update(dt);
    this.updateEmitters(dt);
    this.camera.update(dt, this.player);
    this.sound.setEngine(0, false);
    this.sound.setSkid(0);

    if (this.deathT > 1 && this.input.pressed('KeyR')) this.startRun();
    if (this.input.pressed('Escape')) {
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
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(6, H - 34, 86, 28);
    drawText(ctx, String(mph).padStart(3, ' '), 12, H - 29, 2, '#ffffff');
    drawText(ctx, 'MPH', 40, H - 24, 1, '#9a9aa4');
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

    // spinning car
    ctx.save();
    ctx.translate(W / 2, 120);
    ctx.rotate(Math.sin(this.menuT * 0.9) * 0.35 + 0.2);
    ctx.scale(3, 3);
    ctx.drawImage(this.menuCar.canvas, -6.5, -12);
    ctx.restore();

    const blink = Math.floor(this.menuT * 2) % 2 === 0 ? '_' : ' ';
    drawTextCentered(ctx, `SEED: ${this.seedStr}${blink}`, W / 2, 168, 2, '#ffffff');
    drawTextCentered(ctx, 'TYPE TO CHANGE SEED', W / 2, 186, 1, '#8a8a94');

    if (Math.floor(this.menuT * 1.4) % 2 === 0) {
      drawTextCentered(ctx, '- PRESS ENTER TO DRIVE -', W / 2, 210, 1, '#39d353');
    }
    drawTextCentered(ctx, 'WASD / ARROWS : DRIVE', W / 2, 236, 1, '#c8c8d0');
    drawTextCentered(ctx, 'SPACE : HANDBRAKE   M : SOUND', W / 2, 248, 1, '#c8c8d0');
    drawTextCentered(ctx, 'DRIVE UNTIL YOUR CAR IS TOTALED', W / 2, 268, 1, '#6a6a74');
  }

  renderDead(ctx) {
    if (this.deathT < 1) return;
    const a = Math.min(0.6, (this.deathT - 1) * 0.8);
    ctx.fillStyle = `rgba(20,4,6,${a.toFixed(2)})`;
    ctx.fillRect(0, 0, W, H);
    const sh = Math.max(0, 1.6 - this.deathT) * 3;
    const ox = (Math.random() - 0.5) * sh, oy = (Math.random() - 0.5) * sh;
    drawTextCentered(ctx, 'TOTALED!', W / 2 + ox + 2, 70 + oy + 2, 4, 'rgba(0,0,0,0.7)');
    drawTextCentered(ctx, 'TOTALED!', W / 2 + ox, 70 + oy, 4, '#e05545');

    const s = this.stats;
    const lines = [
      `DISTANCE  ${s.dist.toFixed(2)} MI`,
      `TOP SPEED ${Math.round(s.topSpeed)} MPH`,
      `CARS HIT  ${s.carsHit}`,
      `SMASHED   ${s.propsSmashed + Math.floor(s.cellsDestroyed / 40)}`,
    ];
    lines.forEach((l, i) => drawTextCentered(ctx, l, W / 2, 120 + i * 14, 1, '#e8e8e8'));

    if (this.deathT > 1.6 && Math.floor(this.deathT * 1.5) % 2 === 0) {
      drawTextCentered(ctx, 'R : DRIVE AGAIN    ESC : MENU', W / 2, 200, 1, '#39d353');
    }
  }
}
