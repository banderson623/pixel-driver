// All sound is synthesized with WebAudio: engine drone, tyre screech, sirens,
// horns, crashes, prop snaps. No audio files needed. Positional one-shots
// (crashes, horns, explosions) fade with distance from the listener (the
// player), so far-off mayhem is quiet or silent.

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.suppressed = false;    // hard-silence everything (e.g. after you die)
    this.lx = 0; this.ly = 0;   // listener (player) world position
  }

  // Must be called from a user gesture (keydown) before anything is audible.
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    // shared noise buffer
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // engine: saw + sub square through a lowpass
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 480;
    this.engOsc = ctx.createOscillator();
    this.engOsc.type = 'sawtooth';
    this.engOsc.frequency.value = 50;
    this.engSub = ctx.createOscillator();
    this.engSub.type = 'square';
    this.engSub.frequency.value = 25;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.engOsc.connect(engFilter);
    this.engSub.connect(subGain);
    subGain.connect(engFilter);
    engFilter.connect(this.engGain);
    this.engGain.connect(this.master);
    this.engOsc.start();
    this.engSub.start();

    // tyre screech: one looping noise source split into a low rubber "roar"
    // and a high resonant "squeal" whose pitch wobbles so it sounds alive
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noiseBuf;
    skidSrc.loop = true;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    const roar = ctx.createBiquadFilter();
    roar.type = 'bandpass'; roar.frequency.value = 620; roar.Q.value = 1.1;
    skidSrc.connect(roar); roar.connect(this.skidGain); this.skidGain.connect(this.master);
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    const squeal = ctx.createBiquadFilter();
    squeal.type = 'bandpass'; squeal.frequency.value = 2300; squeal.Q.value = 7;
    skidSrc.connect(squeal); squeal.connect(this.squealGain); this.squealGain.connect(this.master);
    const wob = ctx.createOscillator();
    wob.type = 'sine'; wob.frequency.value = 9;
    const wobG = ctx.createGain(); wobG.gain.value = 350;
    wob.connect(wobG); wobG.connect(squeal.frequency); wob.start();
    skidSrc.start();

    // siren: a sawtooth swept between two pitches by a slow LFO (a wail),
    // shaped by a resonant bandpass
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'sawtooth'; this.sirenOsc.frequency.value = 850;
    const sirenFilt = ctx.createBiquadFilter();
    sirenFilt.type = 'bandpass'; sirenFilt.frequency.value = 1100; sirenFilt.Q.value = 3;
    const sLfo = ctx.createOscillator();
    sLfo.type = 'sine'; sLfo.frequency.value = 0.55;
    const sLfoG = ctx.createGain(); sLfoG.gain.value = 300;   // sweep depth in Hz
    sLfo.connect(sLfoG); sLfoG.connect(this.sirenOsc.frequency);
    this.sirenOsc.connect(sirenFilt); sirenFilt.connect(this.sirenGain); this.sirenGain.connect(this.master);
    this.sirenOsc.start(); sLfo.start();
  }

  setListener(x, y) { this.lx = x; this.ly = y; }

  // 0..1 volume for a world-positioned sound, fading with distance; silent
  // beyond ~640px. Sounds with no position given play at full volume.
  atten(x, y) {
    if (x == null) return 1;
    const d = Math.hypot(x - this.lx, y - this.ly), R = 640;
    return d >= R ? 0 : (1 - d / R) ** 1.4;
  }

  setEngine(rpm, on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 42 + rpm * 140;
    this.engOsc.frequency.setTargetAtTime(f, t, 0.05);
    this.engSub.frequency.setTargetAtTime(f / 2, t, 0.05);
    const g = (this.muted || this.suppressed || !on) ? 0 : 0.035 + rpm * 0.075;
    this.engGain.gain.setTargetAtTime(g, t, 0.08);
  }

  setSkid(level) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, l = Math.min(1, level);
    const off = this.muted || this.suppressed;
    this.skidGain.gain.setTargetAtTime(off ? 0 : l * 0.13, t, 0.05);
    // the squeal only bites hard in a big slide
    this.squealGain.gain.setTargetAtTime(off ? 0 : l * l * 0.11, t, 0.05);
  }

  setSiren(level) {
    if (!this.ctx) return;
    const g = (this.muted || this.suppressed) ? 0 : Math.min(1, level) * 0.07;
    this.sirenGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.12);
  }

  burst(dur, freq, gain, type = 'bandpass') {
    if (!this.ctx || this.muted || this.suppressed || gain <= 0.0006) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur);
  }

  crash(mag, x, y) {
    if (!this.ctx || this.muted || this.suppressed) return;
    const a = this.atten(x, y);
    if (a <= 0) return;
    mag = Math.min(1, mag);
    this.burst(0.28 + mag * 0.25, 240 + Math.random() * 300, (0.25 + mag * 0.5) * a, 'lowpass');
    this.burst(0.1, 2400, (0.12 + mag * 0.2) * a, 'highpass');
    // low thump
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime((0.35 * mag + 0.1) * a, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.32);
  }

  snap(x, y) { this.burst(0.09, 1800, 0.18 * this.atten(x, y), 'highpass'); }
  thud(x, y) { this.burst(0.12, 300, 0.15 * this.atten(x, y), 'lowpass'); }

  // two-tone car horn
  honk(x, y) {
    if (!this.ctx || this.muted || this.suppressed) return;
    const a = this.atten(x, y);
    if (a <= 0) return;
    const ctx = this.ctx, t = ctx.currentTime, dur = 0.3 + Math.random() * 0.25;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08 * a, t + 0.02);
    g.gain.setValueAtTime(0.08 * a, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    lp.connect(g); g.connect(this.master);
    const base = 400 + Math.random() * 60;
    for (const f of [base, base * 1.26]) {   // roughly a major third
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.12);
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx && this.muted) {
      this.engGain.gain.value = 0;
      this.skidGain.gain.value = 0;
      this.squealGain.gain.value = 0;
      this.sirenGain.gain.value = 0;
    }
    return this.muted;
  }
}
