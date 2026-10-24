// Simple synthesized sound effects (no audio files needed).

export type Sfx =
  | 'chop'
  | 'mine'
  | 'pickup'
  | 'fuel'
  | 'hurt'
  | 'swing'
  | 'creatureHit'
  | 'creatureDie'
  | 'build'
  | 'eat'
  | 'fail'
  | 'downed'
  | 'revived'
  | 'dusk'
  | 'night'
  | 'dawn'
  | 'win'
  | 'lose'
  | 'join'
  | 'wall'
  | 'countdown'
  | 'shot'
  | 'search'
  | 'gear'
  | 'zombie'
  | 'zombieDie'
  | 'trample'
  | 'horde';

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crackleGain: GainNode | null = null;
  private crickets: GainNode | null = null;
  private last = new Map<Sfx, number>();
  muted = false;

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Must be called from a user gesture. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        comp.connect(this.ctx.destination);
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(comp);
        this.noise = this.makeNoise();
        this.startAmbience();
      }
      if (this.ctx.state !== 'running') void this.ctx.resume();
    } catch {
      // No audio, no problem.
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private startAmbience(): void {
    const ctx = this.ctx!;
    // Fire crackle: filtered noise with random pops.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.6;
    const pop = ctx.createGain();
    pop.gain.value = 0;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0.25;
    src.connect(bp).connect(pop).connect(this.crackleGain).connect(this.master!);
    src.start();
    const popLoop = () => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      pop.gain.setValueAtTime(0.02, t);
      if (Math.random() < 0.6) {
        pop.gain.setValueAtTime(0.25 + Math.random() * 0.5, t + 0.01);
        pop.gain.exponentialRampToValueAtTime(0.02, t + 0.03 + Math.random() * 0.05);
      }
      setTimeout(popLoop, 40 + Math.random() * 160);
    };
    popLoop();

    // Night crickets.
    this.crickets = ctx.createGain();
    this.crickets.gain.value = 0;
    this.crickets.connect(this.master!);
    const chirp = () => {
      if (!this.ctx || !this.crickets) return;
      if (this.crickets.gain.value > 0.01) {
        const t = this.ctx.currentTime;
        for (let k = 0; k < 3; k++) {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.frequency.value = 4200 + Math.random() * 400;
          g.gain.setValueAtTime(0, t + k * 0.06);
          g.gain.linearRampToValueAtTime(0.05, t + k * 0.06 + 0.01);
          g.gain.linearRampToValueAtTime(0, t + k * 0.06 + 0.04);
          o.connect(g).connect(this.crickets);
          o.start(t + k * 0.06);
          o.stop(t + k * 0.06 + 0.05);
        }
      }
      setTimeout(chirp, 500 + Math.random() * 1500);
    };
    chirp();
  }

  /** fire: 0..1 fuel; night: 0..1 darkness. */
  setAmbience(fire: number, night: number): void {
    if (!this.ctx || !this.crackleGain || !this.crickets) return;
    const t = this.ctx.currentTime;
    this.crackleGain.gain.setTargetAtTime(0.08 + fire * 0.3, t, 0.3);
    this.crickets.gain.setTargetAtTime(night > 0.6 ? 1 : 0, t, 0.8);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private hiss(dur: number, freq: number, vol: number, type: BiquadFilterType = 'bandpass', sweepTo?: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  play(s: Sfx): void {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const now = performance.now();
    if (now - (this.last.get(s) ?? 0) < 45) return;
    this.last.set(s, now);
    switch (s) {
      case 'chop':
        this.tone(180, 0.12, 'triangle', 0.5, 90);
        this.hiss(0.08, 1200, 0.4);
        break;
      case 'mine':
        this.tone(1300, 0.15, 'square', 0.12, 900);
        this.tone(700, 0.1, 'triangle', 0.3, 500);
        this.hiss(0.06, 3000, 0.25, 'highpass');
        break;
      case 'pickup':
        this.tone(620, 0.08, 'sine', 0.25, 940);
        break;
      case 'fuel':
        this.hiss(0.6, 400, 0.5, 'lowpass', 2500);
        this.tone(90, 0.4, 'sine', 0.3, 60);
        break;
      case 'hurt':
        this.tone(140, 0.25, 'sawtooth', 0.3, 60);
        this.hiss(0.12, 800, 0.4, 'lowpass');
        break;
      case 'swing':
        this.hiss(0.14, 900, 0.18, 'bandpass', 2600);
        break;
      case 'creatureHit':
        this.tone(320, 0.14, 'sawtooth', 0.22, 140);
        this.hiss(0.08, 600, 0.3, 'lowpass');
        break;
      case 'creatureDie':
        this.tone(260, 0.5, 'sawtooth', 0.22, 50);
        this.hiss(0.4, 300, 0.35, 'lowpass', 80);
        break;
      case 'build':
        this.tone(240, 0.08, 'triangle', 0.45, 200);
        this.tone(300, 0.08, 'triangle', 0.4, 250, 0.11);
        break;
      case 'eat':
        this.hiss(0.06, 2000, 0.2);
        this.hiss(0.06, 1700, 0.2, 'bandpass', undefined, 0.09);
        this.tone(500, 0.1, 'sine', 0.15, 700, 0.15);
        break;
      case 'fail':
        this.tone(200, 0.12, 'square', 0.08, 160);
        break;
      case 'downed':
        [440, 370, 311, 262].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.25, undefined, i * 0.14));
        break;
      case 'revived':
        [392, 494, 587, 784].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.22, undefined, i * 0.08));
        break;
      case 'dusk':
        [196, 233, 294].forEach((f) => this.tone(f, 2.2, 'sine', 0.18));
        this.tone(98, 2.5, 'triangle', 0.2);
        break;
      case 'night':
        this.tone(70, 1.6, 'sawtooth', 0.12, 45);
        this.hiss(1.4, 200, 0.2, 'lowpass', 60);
        break;
      case 'dawn':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.6, 'sine', 0.16, undefined, i * 0.12));
        break;
      case 'win':
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.2, undefined, i * 0.13));
        break;
      case 'lose':
        [392, 349, 311, 233].forEach((f, i) => this.tone(f, 0.6, 'sawtooth', 0.12, undefined, i * 0.3));
        break;
      case 'join':
        this.tone(660, 0.1, 'sine', 0.2, 990);
        this.tone(990, 0.12, 'sine', 0.15, undefined, 0.08);
        break;
      case 'wall':
        this.tone(110, 0.15, 'square', 0.12, 70);
        this.hiss(0.1, 500, 0.3, 'lowpass');
        break;
      case 'countdown':
        this.tone(880, 0.12, 'sine', 0.2);
        break;
      case 'shot':
        this.hiss(0.18, 1800, 0.9, 'lowpass', 300);
        this.tone(120, 0.15, 'square', 0.3, 50);
        break;
      case 'search':
        this.hiss(0.1, 1500, 0.25);
        this.hiss(0.1, 900, 0.25, 'bandpass', undefined, 0.12);
        this.tone(700, 0.08, 'triangle', 0.15, 900, 0.25);
        break;
      case 'gear':
        this.tone(440, 0.08, 'square', 0.12, 660);
        this.tone(880, 0.15, 'triangle', 0.15, undefined, 0.07);
        break;
      case 'zombie':
        this.tone(95 + Math.random() * 30, 0.5, 'sawtooth', 0.12, 70);
        this.hiss(0.4, 350, 0.15, 'bandpass', 200);
        break;
      case 'zombieDie':
        this.tone(140, 0.45, 'sawtooth', 0.18, 45);
        this.hiss(0.3, 500, 0.3, 'lowpass', 100);
        break;
      case 'trample':
        this.hiss(0.3, 600, 0.35, 'lowpass', 150);
        break;
      case 'horde':
        [80, 92, 104].forEach((f, i) => this.tone(f, 1.4, 'sawtooth', 0.1, f * 0.7, i * 0.25));
        this.hiss(1.5, 300, 0.2, 'bandpass', 120);
        break;
    }
  }
}
