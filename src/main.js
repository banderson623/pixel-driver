import { Game } from './game.js';

const canvas = document.getElementById('game');
const game = new Game(canvas);
window.__game = game; // debugging handle

let last = performance.now();
let acc = 0;
let fpsSmooth = 60;
const STEP = 1 / 60;

function frame(t) {
  requestAnimationFrame(frame);
  let dt = (t - last) / 1000;
  last = t;
  if (dt > 0.1) dt = 0.1;
  fpsSmooth += (1 / Math.max(dt, 1e-4) - fpsSmooth) * 0.05;
  game.fps = fpsSmooth;

  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 3) {
    game.update(STEP);
    acc -= STEP;
    n++;
  }
  if (n === 3) acc = 0; // don't spiral if we fall behind
  game.render();
}
requestAnimationFrame(frame);
