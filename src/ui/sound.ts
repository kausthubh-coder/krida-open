/**
 * Interface sounds, synthesized so there are no files to load. Each one confirms something the screen
 * already shows, stays under 300ms and between 0.02 and 0.07 gain, and never plays for things that
 * happen constantly (play/pause, seeking, hover, tabs). The two rare moments, an invite and someone
 * joining, may ring to about half a second. The Sounds switch in Settings turns all of them off.
 */
let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundsEnabled(value: boolean) {
  enabled = value;
}

function audio() {
  if (!enabled) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx.state === "running" ? ctx : null;
  } catch {
    return null;
  }
}

type Tone = {
  type?: OscillatorType;
  frequency: number;
  /** Glide to this frequency over the note, for pops and swoops. */
  to?: number;
  at?: number;
  gain: number;
  decay?: number;
};

function tone(ac: AudioContext, t0: number, { type = "sine", frequency, to, at = 0, gain, decay = 0.18 }: Tone) {
  const start = t0 + at;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, start + decay);
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(gain, start + 0.003);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + decay);
  osc.connect(amp).connect(ac.destination);
  osc.start(start);
  osc.stop(start + decay + 0.02);
}

/**
 * A note struck on glass: the tone plus a quiet partial at 2.76 times its pitch. That inharmonic
 * overtone is what makes it ring like glass instead of beeping.
 */
function glass(ac: AudioContext, t0: number, { frequency, at = 0, gain, decay = 0.3 }: Omit<Tone, "type" | "to">) {
  tone(ac, t0, { frequency, at, gain, decay });
  tone(ac, t0, { frequency: frequency * 2.76, at, gain: gain * 0.16, decay: decay * 0.5 });
}

/** A short burst of band-passed noise: the "press" texture under a tone. */
function tap(ac: AudioContext, t0: number, { at = 0, gain = 0.03, frequency = 2600, decay = 0.018 } = {}) {
  const start = t0 + at;
  const length = Math.ceil(ac.sampleRate * (decay + 0.01));
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  const amp = ac.createGain();
  amp.gain.setValueAtTime(gain, start);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + decay);
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start(start);
  src.stop(start + decay + 0.01);
}

function play(build: (ac: AudioContext, t0: number) => void) {
  const ac = audio();
  if (!ac) return;
  build(ac, ac.currentTime + 0.005);
}

/** An invite arrived: a rising fourth on glass. Rare, and you may be looking elsewhere, so it rings a little. */
export const playInvite = () =>
  play((ac, t) => {
    glass(ac, t, { frequency: 659.25, gain: 0.055, decay: 0.4 });
    glass(ac, t, { frequency: 880, at: 0.08, gain: 0.045, decay: 0.45 });
  });

/** Someone joined: C-E-G on glass with a high shimmer, the one moment that gets a little ceremony. */
export const playJoin = () =>
  play((ac, t) => {
    [523.25, 659.25, 783.99].forEach((f, i) => glass(ac, t, { frequency: f, at: i * 0.06, gain: 0.045, decay: 0.32 }));
    tone(ac, t, { frequency: 2093, at: 0.2, gain: 0.008, decay: 0.3 });
  });

/** The stream is ready after a wait you may have looked away from: two glass notes, lifting, done in 300ms. */
export const playReady = () =>
  play((ac, t) => {
    glass(ac, t, { frequency: 880, gain: 0.04, decay: 0.24 });
    glass(ac, t, { frequency: 1318.5, at: 0.05, gain: 0.035, decay: 0.25 });
  });

/** Something added (a suggestion, a title lined up, link copied): a drop rising into place. */
export const playAdd = () =>
  play((ac, t) => {
    tone(ac, t, { frequency: 480, to: 1250, gain: 0.05, decay: 0.11 });
    tone(ac, t, { frequency: 2500, at: 0.04, gain: 0.01, decay: 0.08 });
    tap(ac, t, { gain: 0.015, frequency: 3000 });
  });

/** Something removed: the same drop, falling. */
export const playRemove = () =>
  play((ac, t) => {
    tone(ac, t, { frequency: 1100, to: 420, gain: 0.045, decay: 0.12 });
    tap(ac, t, { gain: 0.015, frequency: 1800 });
  });

/** Your message went out: a quick rising run. */
export const playSend = () =>
  play((ac, t) => [783.99, 1046.5, 1318.5].forEach((f, i) => tone(ac, t, { frequency: f, at: i * 0.035, gain: 0.03 - i * 0.006, decay: 0.12 })));

/** A message from someone else: one soft glass blip, quieter than anything you trigger yourself. */
export const playMessage = () => play((ac, t) => glass(ac, t, { frequency: 987.77, gain: 0.035, decay: 0.16 }));

/** Browsers keep audio locked until the first gesture; unlock it then so later cues can play. */
export function unlockAudioOnFirstGesture() {
  const unlock = () => {
    if (enabled) {
      try {
        ctx ??= new AudioContext();
        void ctx.resume();
      } catch {
        // No audio available; the visual change still happens.
      }
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}
