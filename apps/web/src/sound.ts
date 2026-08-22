/**
 * Tasteful optional sound effects, synthesized with WebAudio — no asset
 * downloads, no background music, muted by default until the user opts in
 * (persisted). Sounds are short, soft "physical" taps and slides.
 */

const STORAGE_KEY = 'game-night:sound';

export type SoundName =
  | 'deal'
  | 'flip'
  | 'draw'
  | 'discard'
  | 'flush'
  | 'join'
  | 'cabo'
  | 'swap'
  | 'reveal'
  | 'match'
  | 'miss'
  | 'error';

let ctx: AudioContext | null = null;
let enabled = loadPref();

function loadPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  if (on) ensureCtx();
}

function ensureCtx(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Short filtered noise burst — a card sliding/snapping on felt. */
function noise(duration: number, freq: number, gainPeak: number, delay = 0): void {
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const frames = Math.max(1, Math.floor(ac.sampleRate * duration));
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 0.9;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(t0);
}

/** Soft sine blip. */
function tone(freq: number, duration: number, gainPeak: number, delay = 0, type: OscillatorType = 'sine'): void {
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export function playSound(name: SoundName): void {
  if (!enabled) return;
  switch (name) {
    case 'deal':
      noise(0.09, 2600, 0.16);
      noise(0.07, 1800, 0.1, 0.05);
      break;
    case 'flip':
      noise(0.06, 3200, 0.14);
      tone(880, 0.07, 0.05, 0.02);
      break;
    case 'draw':
      noise(0.12, 2200, 0.15);
      break;
    case 'discard':
      noise(0.1, 1400, 0.18);
      tone(220, 0.08, 0.06, 0.02, 'triangle');
      break;
    case 'flush':
      // Fast satisfying snap.
      noise(0.05, 2800, 0.2);
      noise(0.05, 3600, 0.16, 0.04);
      tone(660, 0.06, 0.07, 0.05);
      break;
    case 'join':
      tone(523, 0.12, 0.07);
      tone(784, 0.14, 0.06, 0.09);
      break;
    case 'cabo':
      tone(392, 0.16, 0.09);
      tone(523, 0.16, 0.08, 0.12);
      tone(659, 0.22, 0.08, 0.24);
      break;
    case 'swap': {
      // Thrilling swap: a suspenseful rise, then two cards DARTING past
      // each other, ending in a settle tick.
      tone(220, 0.28, 0.045, 0, 'sawtooth');          // low rise
      tone(330, 0.26, 0.04, 0.06, 'sawtooth');
      tone(494, 0.2, 0.05, 0.24, 'triangle');          // leap
      noise(0.22, 1700, 0.06, 0.3);                    // dart whoosh 1
      noise(0.2, 1100, 0.05, 0.36);                    // dart whoosh 2
      tone(1319, 0.09, 0.04, 0.5, 'sine');             // sparkle landing
      noise(0.05, 2800, 0.09, 0.56);                   // settle tick
      break;
    }
    case 'reveal':
      for (let i = 0; i < 4; i++) tone(440 + i * 110, 0.1, 0.05, i * 0.09);
      break;
    case 'match':
      // Pair One: a bright two-note "found it!" chime.
      tone(784, 0.12, 0.08);
      tone(1175, 0.18, 0.07, 0.09);
      noise(0.05, 3000, 0.08, 0.02);
      break;
    case 'miss':
      // Pair One: a soft low "nope" — cards sink back down.
      tone(233, 0.16, 0.07, 0, 'triangle');
      tone(175, 0.2, 0.05, 0.1, 'triangle');
      break;
    case 'error':
      tone(196, 0.12, 0.07, 0, 'square');
      break;
  }
}
