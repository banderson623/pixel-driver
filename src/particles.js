// Pooled particle system: tire smoke, debris chips, sparks, water, leaves, fire.

const MAX = 700;

export class Particles {
  constructor() {
    this.arr = [];
  }

  spawn(p) {
    if (this.arr.length >= MAX) this.arr.shift();
    p.age = 0;
    this.arr.push(p);
  }

  tireSmoke(x, y, intensity) {
    this.spawn({
      kind: 'smoke', x, y,
      vx: (Math.random() - 0.5) * 12, vy: (Math.random() - 0.5) * 12,
      ttl: 0.5 + Math.random() * 0.5,
      size: 1 + Math.random() * 1.5, grow: 4 + intensity * 4,
      shade: 190 + Math.random() * 50 | 0, alpha: 0.30 + intensity * 0.2,
    });
  }

  engineSmoke(x, y, dark) {
    const s = dark ? 30 + Math.random() * 30 : 120 + Math.random() * 50;
    this.spawn({
      kind: 'smoke', x, y,
      vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8 - 6,
      ttl: 0.8 + Math.random() * 0.8, size: 1.5, grow: 5,
      shade: s | 0, alpha: dark ? 0.5 : 0.35,
    });
  }

  fire(x, y) {
    this.spawn({
      kind: 'fire', x, y,
      vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10 - 8,
      ttl: 0.25 + Math.random() * 0.3, size: 1 + Math.random() * 2, grow: -1,
    });
  }

  debris(x, y, color, n = 4, speed = 60) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.9);
      this.spawn({
        kind: 'debris', x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        ttl: 0.6 + Math.random() * 1.2, size: 1 + (Math.random() < 0.3 ? 1 : 0),
        color,
      });
    }
  }

  sparks(x, y, n = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 50 + Math.random() * 110;
      this.spawn({
        kind: 'spark', x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        ttl: 0.12 + Math.random() * 0.22, size: 1,
      });
    }
  }

  water(x, y) {
    const a = Math.random() * Math.PI * 2;
    const s = 15 + Math.random() * 55;
    this.spawn({
      kind: 'water', x, y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      ttl: 0.4 + Math.random() * 0.5, size: 1 + Math.random(),
    });
  }

  leaves(x, y, n = 8) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 20 + Math.random() * 60;
      this.spawn({
        kind: 'leaf', x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        ttl: 0.7 + Math.random() * 1.1, size: 1,
        color: Math.random() < 0.5 ? '#4e9a4a' : '#3c7a3a',
      });
    }
  }

  update(dt) {
    const arr = this.arr;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.age += dt;
      if (p.age >= p.ttl) { arr.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'debris' || p.kind === 'leaf') {
        p.vx *= Math.exp(-3.2 * dt);
        p.vy *= Math.exp(-3.2 * dt);
      }
      if (p.kind === 'smoke' || p.kind === 'fire') p.size += (p.grow || 0) * dt;
    }
  }

  draw(ctx) {
    for (const p of this.arr) {
      const t = 1 - p.age / p.ttl;
      let s = Math.max(1, p.size | 0);
      switch (p.kind) {
        case 'smoke': {
          const sh = p.shade;
          ctx.fillStyle = `rgba(${sh},${sh},${sh + 6},${(p.alpha * t).toFixed(3)})`;
          break;
        }
        case 'fire':
          ctx.fillStyle = t > 0.5 ? '#ffd23a' : '#e05a1e';
          s = Math.max(1, s);
          break;
        case 'debris': ctx.fillStyle = p.color; break;
        case 'spark': ctx.fillStyle = t > 0.4 ? '#fff3b0' : '#e8a03a'; break;
        case 'water': ctx.fillStyle = `rgba(150,205,235,${(0.7 * t).toFixed(3)})`; break;
        case 'leaf': ctx.fillStyle = p.color; break;
      }
      ctx.fillRect(p.x - s / 2 | 0, p.y - s / 2 | 0, s, s);
    }
  }
}
