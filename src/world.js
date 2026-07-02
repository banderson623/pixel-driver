// Endless procedural downtown, fully derived from an integer seed.
//
// The city is an irregular grid: vertical/horizontal roads whose positions
// come from a hashed spacing function, with blocks between them filled by
// buildings, parks, parking lots and plazas. The ground is a grid of 2px
// destructible cells; solid cells (buildings) can be chipped into rubble.
// Skid marks and scorch decals are painted straight onto chunk canvases.

import { hash3 } from './rng.js';

export const CELL = 2;
export const CHUNK = 256;
const CPC = CHUNK / CELL; // cells per chunk side

export const ROAD_HALF = 24;   // half width of asphalt
export const SIDEWALK = 10;
export const EDGE = ROAD_HALF + SIDEWALK; // road center -> block edge

// ---------------------------------------------------------------- palette
export const PAL = [];
const PALINT = [];
function C(css) {
  PAL.push(css);
  const n = parseInt(css.slice(1), 16);
  PALINT.push((0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0);
  return PAL.length - 1;
}

const T = {
  ASPH: C('#26262e'), ASPH2: C('#2c2c35'),
  LANEY: C('#c9a638'), LANEW: C('#c8c8bd'),
  SIDE: C('#7f7f88'), SIDE2: C('#8a8a93'), SIDEC: C('#74747d'), CURB: C('#a5a5ae'),
  GRASS: C('#3c7a3a'), GRASS2: C('#448544'), DIRT: C('#6e5637'),
  RUB: C('#3a3a41'), RUB2: C('#4e4e57'),
  PLINE: C('#bfbfc7'), CROSS: C('#cfcfd7'),
  PLAZA: C('#9a9181'), PLAZA2: C('#a59b89'),
  ALLEY: C('#5c5c64'), ALLEY2: C('#63636b'),
};
export { T };

export const SOLID_START = PAL.length;
const SCHEME_DEFS = [
  ['#7c4436', '#874c3d', '#a06a52', '#54301f'], // brick
  ['#4e5668', '#565e72', '#707a92', '#3c4252'], // slate
  ['#a08a62', '#a9936c', '#c4ae84', '#7c6a48'], // tan
  ['#3f3f47', '#474750', '#5c5c66', '#2f2f36'], // charcoal
  ['#3e6b66', '#46756f', '#5e948c', '#2e514d'], // teal
  ['#6b6b3f', '#757547', '#93935e', '#50502f'], // olive
  ['#6f5566', '#795d70', '#94748a', '#54404d'], // mauve
  ['#8a5a30', '#946336', '#b07f4a', '#684423'], // rust
];
const SCHEMES = SCHEME_DEFS.map(d => ({ roof: C(d[0]), roof2: C(d[1]), edge: C(d[2]), det: C(d[3]) }));

export function isSolidIdx(idx) { return idx >= SOLID_START; }

// -------------------------------------------------------------- prop sprites
function makeSprite(w, h, fn) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  fn(g);
  return c;
}

const SPRITES = {
  lamp: makeSprite(3, 3, g => {
    g.fillStyle = '#1e1e24'; g.fillRect(0, 0, 3, 3);
    g.fillStyle = '#ffe9a0'; g.fillRect(1, 1, 1, 1);
  }),
  hydrant: makeSprite(3, 3, g => {
    g.fillStyle = '#b03030'; g.fillRect(0, 0, 3, 3);
    g.fillStyle = '#e8e0d0'; g.fillRect(1, 1, 1, 1);
  }),
  trash: makeSprite(4, 4, g => {
    g.fillStyle = '#3e4a42'; g.fillRect(0, 0, 4, 4);
    g.fillStyle = '#5a6a60'; g.fillRect(1, 1, 2, 2);
  }),
  bench: makeSprite(7, 3, g => {
    g.fillStyle = '#6e4e2e'; g.fillRect(0, 0, 7, 3);
    g.fillStyle = '#8a6238'; g.fillRect(0, 1, 7, 1);
  }),
  cone: makeSprite(3, 3, g => {
    g.fillStyle = '#e07020'; g.fillRect(0, 0, 3, 3);
    g.fillStyle = '#f5e8d5'; g.fillRect(1, 1, 1, 1);
  }),
  dumpster: makeSprite(9, 6, g => {
    g.fillStyle = '#2e5138'; g.fillRect(0, 0, 9, 6);
    g.fillStyle = '#3a6446'; g.fillRect(1, 1, 7, 4);
    g.fillStyle = '#243f2c'; g.fillRect(4, 0, 1, 6);
  }),
  sign: makeSprite(3, 3, g => {
    g.fillStyle = '#a02828'; g.fillRect(0, 0, 3, 3);
    g.fillStyle = '#e8e8e8'; g.fillRect(1, 1, 1, 1);
  }),
  planter: makeSprite(6, 6, g => {
    g.fillStyle = '#8a8a94'; g.fillRect(0, 0, 6, 6);
    g.fillStyle = '#3c7a3a'; g.fillRect(1, 1, 4, 4);
    g.fillStyle = '#448544'; g.fillRect(2, 2, 2, 2);
  }),
  tree0: makeSprite(9, 9, g => {
    g.fillStyle = '#2e5e2c';
    g.fillRect(2, 0, 5, 9); g.fillRect(0, 2, 9, 5);
    g.fillStyle = '#3c7a3a'; g.fillRect(1, 1, 6, 6);
    g.fillStyle = '#4e9a4a'; g.fillRect(2, 2, 3, 3);
  }),
  tree1: makeSprite(7, 7, g => {
    g.fillStyle = '#375f2f';
    g.fillRect(1, 0, 5, 7); g.fillRect(0, 1, 7, 5);
    g.fillStyle = '#4a8442'; g.fillRect(1, 1, 4, 4);
    g.fillStyle = '#5aa050'; g.fillRect(2, 2, 2, 2);
  }),
  lightpole: makeSprite(3, 3, g => {
    g.fillStyle = '#26262c'; g.fillRect(0, 0, 3, 3);
    g.fillStyle = '#3a3a44'; g.fillRect(1, 1, 1, 1);
  }),
};

const PROP_DEFS = {
  light:   { r: 2.5, breakAt: 110, dmg: 5, sturdy: true },
  sign:    { r: 1.5, breakAt: 40,  dmg: 1 },
  lamp:    { r: 2,   breakAt: 105, dmg: 5, sturdy: true },
  hydrant: { r: 2,   breakAt: 85,  dmg: 4, sturdy: true },
  trash:   { r: 2.5, breakAt: 30,  dmg: 1 },
  bench:   { r: 3.5, breakAt: 45,  dmg: 1 },
  cone:    { r: 1.5, breakAt: 8,   dmg: 0 },
  dumpster:{ r: 5,   breakAt: 150, dmg: 6, sturdy: true },
  planter: { r: 3.5, breakAt: 130, dmg: 5, sturdy: true },
  tree0:   { r: 3,   breakAt: 125, dmg: 6, sturdy: true },
  tree1:   { r: 2.5, breakAt: 100, dmg: 4, sturdy: true },
};

const PROP_DEBRIS = {
  light: ['#26262c', '#39d353', '#e05545'],
  sign: ['#a02828', '#e8e8e8', '#555'],
  lamp: ['#26262c', '#ffe9a0', '#3a3a44'],
  hydrant: ['#b03030', '#e8e0d0'],
  trash: ['#3e4a42', '#5a6a60', '#7a8a80'],
  bench: ['#6e4e2e', '#8a6238'],
  cone: ['#e07020', '#f5e8d5'],
  dumpster: ['#2e5138', '#3a6446', '#556'],
  planter: ['#8a8a94', '#3c7a3a', '#6e5637'],
  tree0: ['#3c7a3a', '#4e9a4a', '#5a4026'],
  tree1: ['#4a8442', '#5aa050', '#5a4026'],
};

// ------------------------------------------------------------------- axes
class Axis {
  constructor(seed, id) {
    this.seed = seed; this.id = id;
    this.c = [0]; this.lo = 0; this.hi = 0;
    this.lastK = 0;
  }
  gap(k) { return 310 + Math.floor(hash3(this.seed, this.id, k, 11) * 210); }
  center(k) {
    while (this.hi < k) { this.c.push(this.c[this.c.length - 1] + this.gap(this.hi)); this.hi++; }
    while (this.lo > k) { this.c.unshift(this.c[0] - this.gap(this.lo - 1)); this.lo--; }
    return this.c[k - this.lo];
  }
  locate(x) {
    let k = this.lastK;
    while (this.center(k + 1) <= x) k++;
    while (this.center(k) > x) k--;
    this.lastK = k;
    return k;
  }
  nearest(x) {
    const k = this.locate(x);
    const a = this.center(k), b = this.center(k + 1);
    return (x - a <= b - x) ? { k, c: a } : { k: k + 1, c: b };
  }
}

// ------------------------------------------------------------------- chunk
class Chunk {
  constructor(world, cx, cy) {
    this.cx = cx; this.cy = cy;
    this.x0 = cx * CHUNK; this.y0 = cy * CHUNK;
    this.cells = new Uint8Array(CPC * CPC);
    this.canvas = document.createElement('canvas');
    this.canvas.width = CHUNK; this.canvas.height = CHUNK;
    this.ctx = this.canvas.getContext('2d');
    this.props = [];
    this.carSpawns = [];

    const img = this.ctx.createImageData(CHUNK, CHUNK);
    const buf = new Uint32Array(img.data.buffer);
    for (let cyy = 0; cyy < CPC; cyy++) {
      const wy = this.y0 + cyy * CELL + 1;
      for (let cxx = 0; cxx < CPC; cxx++) {
        const wx = this.x0 + cxx * CELL + 1;
        const idx = world.classify(wx, wy);
        this.cells[cyy * CPC + cxx] = idx;
        const col = PALINT[idx];
        const px = cxx * CELL, py = cyy * CELL;
        for (let a = 0; a < CELL; a++) {
          let row = (py + a) * CHUNK + px;
          for (let b = 0; b < CELL; b++) buf[row + b] = col;
        }
      }
    }
    this.ctx.putImageData(img, 0, 0);
    world.populate(this);
  }

  repaintCell(ci, cj) {
    const idx = this.cells[cj * CPC + ci];
    this.ctx.fillStyle = PAL[idx];
    this.ctx.fillRect(ci * CELL, cj * CELL, CELL, CELL);
  }
}

// ------------------------------------------------------------------- world
export class World {
  constructor(seed) {
    this.seed = seed | 0;
    this.vA = new Axis(this.seed, 1);
    this.hA = new Axis(this.seed, 2);
    this.chunks = new Map();
    this.blocks = new Map();
    this.emitters = [];
    this.focusX = 0; this.focusY = 0;
  }

  noise(wx, wy) {
    let n = Math.imul(wx | 0, 73856093) ^ Math.imul(wy | 0, 19349663) ^ this.seed;
    n = Math.imul(n, 2654435761);
    return ((n >>> 16) & 255) / 255;
  }

  // ---- traffic lights
  hasLight(vi, hj) { return hash3(this.seed, vi, hj, 5) < 0.7; }
  lightPhase(vi, hj, t) {
    const off = hash3(this.seed, vi, hj, 9) * 12;
    const s = (t + off) % 12;
    if (s < 5) return { ns: 'g', ew: 'r' };
    if (s < 6) return { ns: 'y', ew: 'r' };
    if (s < 11) return { ns: 'r', ew: 'g' };
    return { ns: 'r', ew: 'y' };
  }

  // ---- block layouts (the space between roads)
  block(i, j) {
    const key = i + ',' + j;
    let L = this.blocks.get(key);
    if (L) return L;
    const x0 = this.vA.center(i) + EDGE, x1 = this.vA.center(i + 1) - EDGE;
    const y0 = this.hA.center(j) + EDGE, y1 = this.hA.center(j + 1) - EDGE;
    const w = x1 - x0, h = y1 - y0;
    let n = 0;
    const R = () => hash3(this.seed ^ 0x51ab, i, j, n++);

    const roll = R();
    let type = 'bldg';
    if (roll >= 0.62 && roll < 0.76) type = 'park';
    else if (roll >= 0.76 && roll < 0.90) type = 'lot';
    else if (roll >= 0.90) type = 'plaza';
    L = { x0, y0, x1, y1, type, rects: [], props: [], cars: [] };

    const prop = (t, x, y) => {
      const d = PROP_DEFS[t];
      L.props.push({ type: t, x, y, r: d.r, breakAt: d.breakAt, dmg: d.dmg, broken: false });
    };

    if (type === 'bldg') {
      const nx = Math.max(1, Math.min(3, Math.round(w / 120)));
      const ny = Math.max(1, Math.min(3, Math.round(h / 120)));
      const gapS = 12;
      const lw = (w - (nx - 1) * gapS) / nx, lh = (h - (ny - 1) * gapS) / ny;
      for (let gy = 0; gy < ny; gy++) {
        for (let gx = 0; gx < nx; gx++) {
          const lx0 = x0 + gx * (lw + gapS), ly0 = y0 + gy * (lh + gapS);
          const r = R();
          if (r < 0.10) {
            L.rects.push({ x0: lx0, y0: ly0, x1: lx0 + lw, y1: ly0 + lh, kind: 'g' });
            if (R() < 0.7) prop(R() < 0.5 ? 'tree0' : 'tree1', lx0 + lw / 2, ly0 + lh / 2);
            continue;
          }
          const in0 = 2 + R() * 5, in1 = 2 + R() * 5, in2 = 2 + R() * 5, in3 = 2 + R() * 5;
          const bx0 = lx0 + in0, by0 = ly0 + in1;
          const bx1 = Math.max(bx0 + 20, lx0 + lw - in2), by1 = Math.max(by0 + 20, ly0 + lh - in3);
          const s = Math.floor(R() * SCHEMES.length);
          L.rects.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, kind: 'b', s });
          const m = 1 + Math.floor(R() * 3);
          for (let d = 0; d < m; d++) {
            const dw = 5 + R() * 6, dh = 5 + R() * 6;
            if (bx1 - bx0 < dw + 8 || by1 - by0 < dh + 8) continue;
            const dx0 = bx0 + 3 + R() * (bx1 - bx0 - dw - 6);
            const dy0 = by0 + 3 + R() * (by1 - by0 - dh - 6);
            L.rects.push({ x0: dx0, y0: dy0, x1: dx0 + dw, y1: dy0 + dh, kind: 'd', s });
          }
        }
      }
      // alley dumpsters
      if (nx > 1) {
        for (let gy = 0; gy < ny; gy++) {
          if (R() < 0.55) {
            const ax = x0 + (lw + gapS) * (1 + Math.floor(R() * (nx - 1))) - gapS / 2;
            prop('dumpster', ax, y0 + R() * h);
          }
        }
      }
    } else if (type === 'park') {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const pv = R() < 0.75, ph = R() < 0.75;
      if (pv) L.rects.push({ x0: cx - 3, y0, x1: cx + 3, y1, kind: 'p' });
      if (ph) L.rects.push({ x0, y0: cy - 3, x1, y1: cy + 3, kind: 'p' });
      for (let tx = x0 + 14; tx < x1 - 8; tx += 32) {
        for (let ty = y0 + 14; ty < y1 - 8; ty += 32) {
          const jx = tx + (R() - 0.5) * 14, jy = ty + (R() - 0.5) * 14;
          if (pv && Math.abs(jx - cx) < 9) continue;
          if (ph && Math.abs(jy - cy) < 9) continue;
          if (R() < 0.7) prop(R() < 0.6 ? 'tree0' : 'tree1', jx, jy);
        }
      }
      if (R() < 0.8) prop('bench', x0 + 10 + R() * (w - 20), y0 + 5);
      if (R() < 0.8) prop('bench', x0 + 10 + R() * (w - 20), y1 - 5);
    } else if (type === 'lot') {
      for (let rowY = y0 + 8; rowY + 26 < y1; rowY += 48) {
        for (let sx = x0 + 6; sx + 15 < x1 - 6; sx += 15) {
          L.rects.push({ x0: sx, y0: rowY, x1: sx + 1.5, y1: rowY + 24, kind: 'l' });
          if (R() < 0.45) {
            L.cars.push({ x: sx + 8, y: rowY + 12, ang: (R() < 0.5 ? 0 : Math.PI) + (R() - 0.5) * 0.08 });
          }
        }
      }
    } else { // plaza
      const np = 2 + Math.floor(R() * 3);
      for (let p = 0; p < np; p++) {
        const pw = 10 + R() * 10, phh = 10 + R() * 10;
        const px = x0 + 6 + R() * (w - pw - 12), py = y0 + 6 + R() * (h - phh - 12);
        L.rects.push({ x0: px, y0: py, x1: px + pw, y1: py + phh, kind: 'g' });
        if (R() < 0.5) prop(R() < 0.5 ? 'tree0' : 'planter', px + pw / 2, py + phh / 2);
      }
      for (let b = 0; b < 3; b++) {
        if (R() < 0.6) prop('bench', x0 + 8 + R() * (w - 16), y0 + 8 + R() * (h - 16));
      }
    }

    this.blocks.set(key, L);
    if (this.blocks.size > 500) {
      const first = this.blocks.keys().next().value;
      this.blocks.delete(first);
    }
    return L;
  }

  // ---- pixel classification (used during chunk generation)
  classify(wx, wy) {
    const nv = this.vA.nearest(wx), nh = this.hA.nearest(wy);
    const dxv = wx - nv.c, dyh = wy - nh.c;
    const adx = Math.abs(dxv), ady = Math.abs(dyh);
    const inRX = adx < ROAD_HALF, inRY = ady < ROAD_HALF;
    const nz = this.noise(wx, wy);

    if (inRX && inRY) return nz < 0.12 ? T.ASPH2 : T.ASPH;

    if (inRX) { // on a vertical road
      if (ady >= ROAD_HALF + 2 && ady < ROAD_HALF + 10) {
        if ((((wx - nv.c + ROAD_HALF) >> 2) & 1) === 0) return T.CROSS;
        return nz < 0.12 ? T.ASPH2 : T.ASPH;
      }
      if (ady >= ROAD_HALF + 11 && ady < ROAD_HALF + 14 && dxv * dyh > 0) return T.LANEW;
      if (adx < 1 && ady > ROAD_HALF + 16 && Math.floor(wy / 12) % 2 === 0) return T.LANEY;
      return nz < 0.12 ? T.ASPH2 : T.ASPH;
    }
    if (inRY) { // on a horizontal road
      if (adx >= ROAD_HALF + 2 && adx < ROAD_HALF + 10) {
        if ((((wy - nh.c + ROAD_HALF) >> 2) & 1) === 0) return T.CROSS;
        return nz < 0.12 ? T.ASPH2 : T.ASPH;
      }
      if (adx >= ROAD_HALF + 11 && adx < ROAD_HALF + 14 && dxv * dyh < 0) return T.LANEW;
      if (ady < 1 && adx > ROAD_HALF + 16 && Math.floor(wx / 12) % 2 === 0) return T.LANEY;
      return nz < 0.12 ? T.ASPH2 : T.ASPH;
    }

    if (adx < EDGE || ady < EDGE) { // sidewalk ring
      if (adx >= ROAD_HALF && adx < ROAD_HALF + 2 && adx < EDGE) return T.CURB;
      if (ady >= ROAD_HALF && ady < ROAD_HALF + 2 && ady < EDGE) return T.CURB;
      if ((wx & 15) === 0 || (wy & 15) === 0) return T.SIDEC;
      return nz < 0.25 ? T.SIDE2 : T.SIDE;
    }

    // block interior
    const i = dxv < 0 ? nv.k - 1 : nv.k;
    const j = dyh < 0 ? nh.k - 1 : nh.k;
    const L = this.block(i, j);
    for (let r = L.rects.length - 1; r >= 0; r--) {
      const q = L.rects[r];
      if (wx >= q.x0 && wx < q.x1 && wy >= q.y0 && wy < q.y1) {
        switch (q.kind) {
          case 'b': {
            const sc = SCHEMES[q.s];
            if (wx < q.x0 + 2 || wx >= q.x1 - 2 || wy < q.y0 + 2 || wy >= q.y1 - 2) return sc.edge;
            return nz < 0.15 ? sc.roof2 : sc.roof;
          }
          case 'd': return SCHEMES[q.s].det;
          case 'g': return nz < 0.3 ? T.GRASS2 : T.GRASS;
          case 'p': return T.DIRT;
          case 'l': return T.PLINE;
        }
      }
    }
    switch (L.type) {
      case 'park': return nz < 0.3 ? T.GRASS2 : T.GRASS;
      case 'lot': return nz < 0.12 ? T.ASPH2 : T.ASPH;
      case 'plaza': return nz < 0.25 ? T.PLAZA2 : T.PLAZA;
      default: return nz < 0.2 ? T.ALLEY2 : T.ALLEY;
    }
  }

  // ---- props & parked-car spawns for a chunk
  populate(ch) {
    const x0 = ch.x0, y0 = ch.y0, x1 = x0 + CHUNK, y1 = y0 + CHUNK;
    const inCh = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const mkProp = (t, x, y, extra) => {
      const d = PROP_DEFS[t];
      ch.props.push(Object.assign({ type: t, x, y, r: d.r, breakAt: d.breakAt, dmg: d.dmg, broken: false }, extra));
    };

    // roads crossing this chunk (with margin)
    const vroads = [], hroads = [];
    {
      let k = this.vA.locate(x0 - EDGE - 10);
      while (this.vA.center(k) < x1 + EDGE + 10) {
        if (this.vA.center(k) > x0 - EDGE - 10) vroads.push({ k, c: this.vA.center(k) });
        k++;
      }
      k = this.hA.locate(y0 - EDGE - 10);
      while (this.hA.center(k) < y1 + EDGE + 10) {
        if (this.hA.center(k) > y0 - EDGE - 10) hroads.push({ k, c: this.hA.center(k) });
        k++;
      }
    }

    // intersections: traffic lights or stop signs at corners
    for (const v of vroads) for (const h of hroads) {
      const lit = this.hasLight(v.k, h.k);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const px = v.c + sx * (ROAD_HALF + 4), py = h.c + sy * (ROAD_HALF + 4);
        if (!inCh(px, py)) continue;
        if (lit) mkProp('light', px, py, { vi: v.k, hj: h.k, facing: sx * sy > 0 ? 'ns' : 'ew' });
        else if (sx * sy > 0) mkProp('sign', px, py);
      }
    }

    const nearH = (y) => hroads.some(h => Math.abs(y - h.c) < EDGE + 14);
    const nearV = (x) => vroads.some(v => Math.abs(x - v.c) < EDGE + 14);

    // sidewalk furniture along vertical roads
    for (const v of vroads) {
      for (let s = Math.floor((y0 - 10) / 96); s <= Math.ceil((y1 + 10) / 96); s++) {
        const py = s * 96 + hash3(this.seed, v.k, s, 21) * 24;
        if (nearH(py)) continue;
        for (const side of [-1, 1]) {
          const px = v.c + side * (ROAD_HALF + 5);
          if (!inCh(px, py)) continue;
          const r = hash3(this.seed, v.k * 2 + (side > 0 ? 1 : 0), s, 22);
          if (r < 0.55) mkProp('lamp', px, py);
          else if (r < 0.7) mkProp('hydrant', px, py);
          else if (r < 0.85) mkProp('trash', px, py);
        }
      }
      // occasional cones in a lane
      for (let s = Math.floor(y0 / 64); s <= Math.ceil(y1 / 64); s++) {
        if (hash3(this.seed, v.k, s, 31) < 0.05) {
          const py = s * 64 + 8;
          if (nearH(py)) continue;
          const side = hash3(this.seed, v.k, s, 32) < 0.5 ? -1 : 1;
          for (let cn = 0; cn < 3; cn++) {
            const px = v.c + side * 12 + (cn - 1) * 4, py2 = py + cn * 7;
            if (inCh(px, py2)) mkProp('cone', px, py2);
          }
        }
      }
    }
    // sidewalk furniture along horizontal roads
    for (const h of hroads) {
      for (let s = Math.floor((x0 - 10) / 96); s <= Math.ceil((x1 + 10) / 96); s++) {
        const px = s * 96 + hash3(this.seed, h.k, s, 23) * 24;
        if (nearV(px)) continue;
        for (const side of [-1, 1]) {
          const py = h.c + side * (ROAD_HALF + 5);
          if (!inCh(px, py)) continue;
          const r = hash3(this.seed, h.k * 2 + (side > 0 ? 1 : 0), s, 24);
          if (r < 0.55) mkProp('lamp', px, py);
          else if (r < 0.7) mkProp('hydrant', px, py);
          else if (r < 0.85) mkProp('trash', px, py);
        }
      }
      for (let s = Math.floor(x0 / 64); s <= Math.ceil(x1 / 64); s++) {
        if (hash3(this.seed, h.k, s, 33) < 0.05) {
          const px = s * 64 + 8;
          if (nearV(px)) continue;
          const side = hash3(this.seed, h.k, s, 34) < 0.5 ? -1 : 1;
          for (let cn = 0; cn < 3; cn++) {
            const px2 = px + cn * 7, py = h.c + side * 12 + (cn - 1) * 4;
            if (inCh(px2, py)) mkProp('cone', px2, py);
          }
        }
      }
    }

    // block-owned props and parked cars (shared objects — damage persists
    // while the block layout stays cached)
    const iA = this.vA.locate(x0), iB = this.vA.locate(x1);
    const jA = this.hA.locate(y0), jB = this.hA.locate(y1);
    for (let i = iA; i <= iB; i++) {
      for (let j = jA; j <= jB; j++) {
        const L = this.block(i, j);
        for (const p of L.props) if (inCh(p.x, p.y)) ch.props.push(p);
        for (const c of L.cars) if (inCh(c.x, c.y)) ch.carSpawns.push(c);
      }
    }
  }

  // ---- chunk access
  chunkAt(cx, cy) {
    const key = cx + ',' + cy;
    let ch = this.chunks.get(key);
    if (!ch) {
      ch = new Chunk(this, cx, cy);
      this.chunks.set(key, ch);
      if (this.chunks.size > 80) this.evict();
    }
    return ch;
  }

  evict() {
    const fx = this.focusX, fy = this.focusY;
    const entries = [...this.chunks.entries()];
    entries.sort((a, b) => {
      const da = (a[1].x0 + 128 - fx) ** 2 + (a[1].y0 + 128 - fy) ** 2;
      const db = (b[1].x0 + 128 - fx) ** 2 + (b[1].y0 + 128 - fy) ** 2;
      return db - da;
    });
    for (let i = 0; i < 20; i++) this.chunks.delete(entries[i][0]);
  }

  setFocus(x, y) { this.focusX = x; this.focusY = y; }

  cellAt(wx, wy) {
    const cx = Math.floor(wx / CHUNK), cy = Math.floor(wy / CHUNK);
    const ch = this.chunkAt(cx, cy);
    const ci = Math.min(CPC - 1, Math.max(0, (wx - ch.x0) >> 1));
    const cj = Math.min(CPC - 1, Math.max(0, (wy - ch.y0) >> 1));
    return ch.cells[cj * CPC + ci];
  }

  solidAt(wx, wy) { return isSolidIdx(this.cellAt(wx, wy)); }

  surfaceDrag(wx, wy) {
    const c = this.cellAt(wx, wy);
    if (c === T.GRASS || c === T.GRASS2) return 2.1;
    if (c === T.DIRT) return 1.8;
    if (c === T.RUB || c === T.RUB2) return 1.6;
    if (c === T.SIDE || c === T.SIDE2 || c === T.SIDEC || c === T.CURB ||
        c === T.PLAZA || c === T.PLAZA2) return 1.25;
    if (c === T.ALLEY || c === T.ALLEY2) return 1.1;
    return 1;
  }

  // Chip solid cells into rubble around (wx,wy). Returns destroyed colors.
  damage(wx, wy, radius, chance) {
    const out = [];
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius) continue;
        const px = wx + dx * CELL, py = wy + dy * CELL;
        const cx = Math.floor(px / CHUNK), cy = Math.floor(py / CHUNK);
        const ch = this.chunks.get(cx + ',' + cy);
        if (!ch) continue;
        const ci = (px - ch.x0) >> 1, cj = (py - ch.y0) >> 1;
        if (ci < 0 || cj < 0 || ci >= CPC || cj >= CPC) continue;
        const idx = ch.cells[cj * CPC + ci];
        if (!isSolidIdx(idx)) continue;
        if (Math.random() < chance * (1 - d / (radius + 1))) {
          out.push(PAL[idx]);
          ch.cells[cj * CPC + ci] = Math.random() < 0.5 ? T.RUB : T.RUB2;
          ch.repaintCell(ci, cj);
        }
      }
    }
    return out;
  }

  // Paint a decal (skid mark, scorch, stain) directly onto the chunk canvas.
  decal(wx, wy, fn) {
    const cx = Math.floor(wx / CHUNK), cy = Math.floor(wy / CHUNK);
    const ch = this.chunks.get(cx + ',' + cy);
    if (!ch) return;
    ch.ctx.save();
    ch.ctx.translate(wx - ch.x0, wy - ch.y0);
    fn(ch.ctx);
    ch.ctx.restore();
  }

  propsNear(x, y, radius, out) {
    out.length = 0;
    const c0x = Math.floor((x - radius - 8) / CHUNK), c1x = Math.floor((x + radius + 8) / CHUNK);
    const c0y = Math.floor((y - radius - 8) / CHUNK), c1y = Math.floor((y + radius + 8) / CHUNK);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const ch = this.chunks.get(cx + ',' + cy);
        if (!ch) continue;
        for (const p of ch.props) {
          if (p.broken) continue;
          const dx = p.x - x, dy = p.y - y;
          if (dx * dx + dy * dy < (radius + p.r) * (radius + p.r)) out.push(p);
        }
      }
    }
    return out;
  }

  breakProp(p, particles, sound) {
    if (p.broken) return;
    p.broken = true;
    const cols = PROP_DEBRIS[p.type] || ['#888'];
    for (const c of cols) particles.debris(p.x, p.y, c, 3, 80);
    if (p.type === 'tree0' || p.type === 'tree1') particles.leaves(p.x, p.y, 10);
    if (p.type === 'hydrant') {
      this.emitters.push({ x: p.x, y: p.y, type: 'water', ttl: 7, acc: 0 });
    }
    // remains stain
    this.decal(p.x, p.y, (g) => {
      g.fillStyle = 'rgba(20,20,24,0.5)';
      g.fillRect(-p.r, -p.r, p.r * 2, p.r * 2);
      g.fillStyle = cols[0];
      g.globalAlpha = 0.6;
      g.fillRect(-1, -1, 2, 2);
    });
    if (sound) sound.snap();
  }

  // ---- rendering
  draw(ctx, camX, camY, W, H) {
    const left = camX - W / 2, top = camY - H / 2;
    const c0x = Math.floor(left / CHUNK), c1x = Math.floor((left + W) / CHUNK);
    const c0y = Math.floor(top / CHUNK), c1y = Math.floor((top + H) / CHUNK);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const ch = this.chunkAt(cx, cy);
        ctx.drawImage(ch.canvas, Math.round(ch.x0 - left), Math.round(ch.y0 - top));
      }
    }
    // ground props
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const ch = this.chunks.get(cx + ',' + cy);
        if (!ch) continue;
        for (const p of ch.props) {
          if (p.broken) continue;
          const spr = p.type === 'light' ? SPRITES.lightpole : SPRITES[p.type];
          if (!spr) continue;
          ctx.drawImage(spr, Math.round(p.x - left - spr.width / 2), Math.round(p.y - top - spr.height / 2));
        }
      }
    }
  }

  // light heads render above cars
  drawOverhead(ctx, camX, camY, W, H, t) {
    const left = camX - W / 2, top = camY - H / 2;
    const c0x = Math.floor(left / CHUNK), c1x = Math.floor((left + W) / CHUNK);
    const c0y = Math.floor(top / CHUNK), c1y = Math.floor((top + H) / CHUNK);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const ch = this.chunks.get(cx + ',' + cy);
        if (!ch) continue;
        for (const p of ch.props) {
          if (p.type !== 'light' || p.broken) continue;
          const ph = this.lightPhase(p.vi, p.hj, t);
          const st = p.facing === 'ns' ? ph.ns : ph.ew;
          const px = Math.round(p.x - left), py = Math.round(p.y - top);
          // arm toward intersection center
          const ax = p.x < this.vA.nearest(p.x).c ? 1 : -1;
          const ay = p.y < this.hA.nearest(p.y).c ? 1 : -1;
          ctx.fillStyle = '#1a1a20';
          ctx.fillRect(px + (ax > 0 ? 1 : -4), py + (ay > 0 ? 1 : -4), 4, 4);
          ctx.fillStyle = st === 'g' ? '#39d353' : st === 'y' ? '#e8c33a' : '#e05545';
          ctx.fillRect(px + (ax > 0 ? 2 : -3), py + (ay > 0 ? 2 : -3), 2, 2);
        }
      }
    }
  }
}
