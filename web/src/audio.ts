// Procedural ambience — the whole soundscape is synthesised with WebAudio, no
// audio files to ship (same asset-free spirit as the renderer). Continuous beds
// (surf, wind, a night chirr, a fire bed) cross-fade with the time of day and
// weather; sparse one-shots (birdsong by day, thunder in storm, fire pops at
// night) are scheduled on top. Muted until the user opts in — browsers block
// autoplay, and silence-by-default is the polite default.

type Env = { night: number; storm: number; fire: number; day: number };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = false;
let started = false;

// per-layer gains (targets are ramped toward every frame)
const g: Record<string, GainNode> = {};
// smoothed environment the beds follow
const env: Env = { night: 0, storm: 0, fire: 0, day: 1 };
const target: Env = { night: 0, storm: 0, fire: 0, day: 1 };

const STORAGE_KEY = "audioEnabled";

function noiseBuffer(context: AudioContext, seconds = 2): AudioBuffer {
  const len = Math.floor(context.sampleRate * seconds);
  const buf = context.createBuffer(1, len, context.sampleRate);
  const data = buf.getChannelData(0);
  // brownish noise: integrate white noise so lows dominate (softer than white)
  let last = 0;
  for (let i = 0; i < len; i += 1) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last * 3.2;
  }
  return buf;
}

function loopSource(context: AudioContext, buf: AudioBuffer): AudioBufferSourceNode {
  const src = context.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start();
  return src;
}

// A filtered-noise bed with a slow gain LFO for the "breathing" of surf/wind.
function bed(context: AudioContext, buf: AudioBuffer, filter: BiquadFilterNode,
            lfoHz: number, lfoDepth: number, base: number): GainNode {
  const src = loopSource(context, buf);
  const gain = context.createGain();
  gain.gain.value = base;
  src.connect(filter).connect(gain);

  const lfo = context.createOscillator();
  lfo.frequency.value = lfoHz;
  const lfoGain = context.createGain();
  lfoGain.gain.value = lfoDepth;
  lfo.connect(lfoGain).connect(gain.gain);
  lfo.start();
  return gain;
}

function buildGraph(): void {
  if (started || !ctx) return;
  started = true;
  const c = ctx;
  master = c.createGain();
  master.gain.value = 0;
  master.connect(c.destination);

  const buf = noiseBuffer(c);

  // ── surf: low, wide, always there; the island's pulse ──────────────────────
  const surfLp = c.createBiquadFilter();
  surfLp.type = "lowpass"; surfLp.frequency.value = 480; surfLp.Q.value = 0.6;
  g.surf = bed(c, buf, surfLp, 0.09, 0.05, 0.10);
  g.surf.connect(master);

  // ── wind: mid band, rises with storm ───────────────────────────────────────
  const windBp = c.createBiquadFilter();
  windBp.type = "bandpass"; windBp.frequency.value = 700; windBp.Q.value = 0.7;
  g.wind = bed(c, buf, windBp, 0.05, 0.06, 0.02);
  g.wind.connect(master);

  // ── night chirr: high hiss with a fast tremolo → crickets/insects ──────────
  const nightHp = c.createBiquadFilter();
  nightHp.type = "highpass"; nightHp.frequency.value = 4200; nightHp.Q.value = 0.8;
  g.night = bed(c, buf, nightHp, 14, 0.9, 0.0);   // deep tremolo = pulsing chirr
  g.night.connect(master);

  // ── fire bed: warm mid crackle floor (pops scheduled separately) ───────────
  const fireBp = c.createBiquadFilter();
  fireBp.type = "bandpass"; fireBp.frequency.value = 1600; fireBp.Q.value = 0.5;
  g.fire = bed(c, buf, fireBp, 7, 0.4, 0.0);
  g.fire.connect(master);

  scheduleBirds();
  scheduleThunder();
  scheduleFirePops();
}

// ── one-shots ────────────────────────────────────────────────────────────────
function chirp(): void {
  if (!ctx || !master) return;
  const c = ctx;
  const t0 = c.currentTime;
  const notes = 2 + Math.floor(Math.random() * 3);
  const base = 2600 + Math.random() * 1800;
  for (let i = 0; i < notes; i += 1) {
    const o = c.createOscillator();
    o.type = "triangle";
    const t = t0 + i * (0.06 + Math.random() * 0.05);
    const f = base * (0.9 + Math.random() * 0.5);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.35, t + 0.05);
    const gn = c.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(0.05 * env.day, t + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(gn).connect(master);
    o.start(t); o.stop(t + 0.12);
  }
}

function thunder(): void {
  if (!ctx || !master) return;
  const c = ctx;
  const t0 = c.currentTime;
  const src = loopSource(c, noiseBuffer(c, 1.6));
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(220, t0);
  lp.frequency.exponentialRampToValueAtTime(70, t0 + 1.4);
  const gn = c.createGain();
  gn.gain.setValueAtTime(0.0001, t0);
  gn.gain.exponentialRampToValueAtTime(0.28 * env.storm, t0 + 0.12);
  gn.gain.exponentialRampToValueAtTime(0.06, t0 + 0.6);
  gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
  src.connect(lp).connect(gn).connect(master);
  src.stop(t0 + 1.6);
}

function firePop(): void {
  if (!ctx || !master) return;
  const c = ctx;
  const t0 = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.08);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 1400 + Math.random() * 1600; bp.Q.value = 4;
  const gn = c.createGain();
  gn.gain.setValueAtTime(0.0001, t0);
  gn.gain.exponentialRampToValueAtTime(0.08 * env.fire, t0 + 0.004);
  gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
  src.connect(bp).connect(gn).connect(master);
  src.start(t0); src.stop(t0 + 0.08);
}

// Recursive self-scheduling: cadence depends on the live environment, and the
// events stay silent (env gate near 0) when out of season.
function scheduleBirds(): void {
  const gap = 1400 + Math.random() * 4200;
  setTimeout(() => {
    if (enabled && env.day > 0.4 && env.storm < 0.4 && Math.random() < 0.7) chirp();
    scheduleBirds();
  }, gap);
}
function scheduleThunder(): void {
  const gap = 4000 + Math.random() * 9000;
  setTimeout(() => {
    if (enabled && env.storm > 0.45 && Math.random() < 0.8) thunder();
    scheduleThunder();
  }, gap);
}
function scheduleFirePops(): void {
  const gap = 120 + Math.random() * 380;
  setTimeout(() => {
    if (enabled && env.fire > 0.2 && Math.random() < 0.6) firePop();
    scheduleFirePops();
  }, gap);
}

// ── public API ────────────────────────────────────────────────────────────────
export function audioEnabled(): boolean { return enabled; }

/** Toggle sound; lazily builds the graph and resumes the context on first use. */
export function toggleAudio(): boolean {
  if (!ctx) {
    ctx = new (window.AudioContext || (window as unknown as {
      webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    buildGraph();
  }
  enabled = !enabled;
  if (enabled) void ctx.resume();
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  return enabled;
}

export function audioWanted(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

/** Called every frame with the live scene environment (0..1 each). */
export function updateAudioEnv(next: Env, dt: number): void {
  target.night = next.night; target.storm = next.storm;
  target.fire = next.fire; target.day = next.day;
  const k = Math.min(1, dt * 1.5);
  env.night += (target.night - env.night) * k;
  env.storm += (target.storm - env.storm) * k;
  env.fire += (target.fire - env.fire) * k;
  env.day += (target.day - env.day) * k;

  if (!started || !master || !ctx) return;
  const now = ctx.currentTime;
  const set = (node: GainNode | undefined, v: number) => {
    if (node) node.gain.setTargetAtTime(v, now, 0.3);
  };
  // beds respond to the environment; wind swells in storm, surf dips a touch at
  // night, the chirr and fire only live after dark
  set(g.surf, 0.09 - env.night * 0.02 + env.storm * 0.03);
  set(g.wind, 0.015 + env.storm * 0.11);
  set(g.night, env.night * 0.9 * (1 - env.storm * 0.5) * 0.06);
  set(g.fire, env.fire * env.night * 0.05);
  set(master, enabled ? 0.55 : 0.0);
}
