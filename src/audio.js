// All sound is synthesized with WebAudio: engine drone, tire-skid noise,
// crash bursts, prop snaps. No audio files needed.

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
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

    // skid: looping noise through bandpass
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 750;
    skidFilter.Q.value = 0.8;
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noiseBuf;
    skidSrc.loop = true;
    skidSrc.connect(skidFilter);
    skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.master);
    skidSrc.start();
  }

  setEngine(rpm, on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 42 + rpm * 140;
    this.engOsc.frequency.setTargetAtTime(f, t, 0.05);
    this.engSub.frequency.setTargetAtTime(f / 2, t, 0.05);
    const g = (this.muted || !on) ? 0 : 0.035 + rpm * 0.075;
    this.engGain.gain.setTargetAtTime(g, t, 0.08);
  }

  setSkid(level) {
    if (!this.ctx) return;
    const g = this.muted ? 0 : Math.min(1, level) * 0.14;
    this.skidGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05);
  }

  burst(dur, freq, gain, type = 'bandpass') {
    if (!this.ctx || this.muted) return;
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

  crash(mag) {
    if (!this.ctx || this.muted) return;
    mag = Math.min(1, mag);
    this.burst(0.28 + mag * 0.25, 240 + Math.random() * 300, 0.25 + mag * 0.5, 'lowpass');
    this.burst(0.1, 2400, 0.12 + mag * 0.2, 'highpass');
    // low thump
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 * mag + 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.32);
  }

  snap() { this.burst(0.09, 1800, 0.18, 'highpass'); }
  thud() { this.burst(0.12, 300, 0.15, 'lowpass'); }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx && this.muted) {
      this.engGain.gain.value = 0;
      this.skidGain.gain.value = 0;
    }
    return this.muted;
  }
}
