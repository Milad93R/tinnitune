import type { ReliefNoiseType } from '../types';

export const MIN_FREQ_HZ = 250;
export const MAX_FREQ_HZ = 18000;

export function matchOutputCeilingHz(sampleRate: number): number {
  return Math.min(MAX_FREQ_HZ, Math.floor(sampleRate * 0.45));
}

// The final shaper bounds each PCM sample. A reconstructed phase is a weighted
// sum of those samples. Its absolute value is therefore bounded by the ceiling
// times the phase's coefficient L1 norm, independent of the input waveform.
// The BS.1770-5 phases and the 64-tap Blackman-sinc verification kernel both
// have norms below 2.81. 0.174 × 2.81 = 0.489 (< 10 ** (-6 / 20)).
export const LIMITER_CEILING_LINEAR = 0.174;
export const LIMITER_KNEE_LINEAR = 0.145;
export const MAX_ALLOWED_DBFS = -6.0;

// ITU-R BS.1770-5 Annex 2. Only two phases are unique up to reversal.
const truePeakPhases = [
  [28, 180, -322, 544, -974, 2250, 15928, -1676, 780, -436, 244, -136],
  [-478, 480, -848, 1460, -2728, 7620, 12776, -3282, 1664, -954, 542, -310],
];
truePeakPhases.push(...truePeakPhases.map((phase) => [...phase].reverse()));

export function measureTruePeak(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  for (const phase of truePeakPhases) {
    for (let i = -phase.length + 1; i < samples.length; i++) {
      let reconstructed = 0;
      for (let j = Math.max(0, -i); j < Math.min(phase.length, samples.length - i); j++) {
        reconstructed += samples[i + j] * phase[j];
      }
      peak = Math.max(peak, Math.abs(reconstructed) / 16384);
    }
  }
  return peak;
}

/** Logarithmic slider mapping [0..1] <-> [MIN_FREQ_HZ..MAX_FREQ_HZ] */
export function normToFreq(norm: number, minHz = MIN_FREQ_HZ, maxHz = MAX_FREQ_HZ): number {
  const t = Math.max(0, Math.min(1, norm));
  return minHz * Math.pow(maxHz / minHz, t);
}

export function freqToNorm(freqHz: number, minHz = MIN_FREQ_HZ, maxHz = MAX_FREQ_HZ): number {
  const f = Math.max(minHz, Math.min(maxHz, freqHz));
  return Math.log(f / minHz) / Math.log(maxHz / minHz);
}

/** Nudge frequency by signed semitones (1/12 octave steps) */
export function nudgeSemitones(freqHz: number, semitones: number): number {
  const next = freqHz * Math.pow(2, semitones / 12);
  return Math.max(MIN_FREQ_HZ, Math.min(MAX_FREQ_HZ, Math.round(next)));
}

export interface FrequencyBand {
  lowHz: number;
  highHz: number;
}

export interface DigitalFilterBand extends FrequencyBand {
  centerHz: number;
  sampleRate: number;
  q: number;
}

export type DigitalNotch = DigitalFilterBand;

const NOTCH_STAGES = 3;
const BANDPASS_STAGES = 2;
export const RI_BANDWIDTH_OCT = 0.45;
const warp = (hz: number, sampleRate: number) => Math.tan(Math.PI * hz / sampleRate);
const unwarp = (rad: number, sampleRate: number) => Math.atan(rad) * sampleRate / Math.PI;
const notchThreshold = (db: number) => {
  const stagePower = 10 ** (db / (10 * NOTCH_STAGES));
  return Math.sqrt(stagePower / (1 - stagePower));
};

function solveDigitalBand(centerHz: number, widthOct: number, sampleRate: number) {
  const warpedCenter = warp(centerHz, sampleRate);
  const targetRatio = 2 ** widthOct;
  // Both biquads have reciprocal crossings around the warped center. Fit their
  // ratio in Hz, where the two edges become asymmetric near Nyquist.
  let left = 0;
  let right = 1;
  for (let i = 0; i < 32; i++) {
    const k = (left + right) / 2;
    const ratio = Math.atan(warpedCenter / k) / Math.atan(warpedCenter * k);
    if (ratio > targetRatio) left = k;
    else right = k;
  }
  const k = (left + right) / 2;
  return {
    separation: 1 / k - k,
    lowHz: unwarp(warpedCenter * k, sampleRate),
    highHz: unwarp(warpedCenter / k, sampleRate),
  };
}

/** Solve the actual digital −3 dB edge ratio while keeping the null at the requested pitch. */
export function designDigitalNotch(centerHz: number, widthOct: number, sampleRate: number): DigitalNotch {
  const center = Math.max(150, Math.min(centerHz, sampleRate * 0.49));
  const { separation, lowHz, highHz } = solveDigitalBand(center, Math.max(0.15, Math.min(2.5, widthOct)), sampleRate);
  return { centerHz: center, sampleRate, q: notchThreshold(-3) / separation, lowHz, highHz };
}

/** Relative to the cascade peak, bandwidth is log2(high / low) at −3 dB. */
export function designDigitalBandpass(centerHz: number, widthOct: number, sampleRate: number): DigitalFilterBand {
  const center = Math.max(150, Math.min(centerHz, sampleRate * 0.49));
  const { separation, lowHz, highHz } = solveDigitalBand(center, Math.max(0.08, Math.min(2, widthOct)), sampleRate);
  const q = Math.sqrt(10 ** (3 / (10 * BANDPASS_STAGES)) - 1) / separation;
  return { centerHz: center, sampleRate, q, lowHz, highHz };
}

export function bandpassMagnitude(hz: number, band: DigitalFilterBand): number {
  const ratio = warp(hz, band.sampleRate) / warp(band.centerHz, band.sampleRate);
  return (1 + (band.q * (ratio - 1 / ratio)) ** 2) ** (-BANDPASS_STAGES / 2);
}

export function createBandpassChain(ctx: BaseAudioContext, centerHz: number, widthOct: number) {
  const stages = Array.from({ length: BANDPASS_STAGES }, () => {
    const stage = ctx.createBiquadFilter();
    stage.type = 'bandpass';
    return stage;
  });
  stages[0].connect(stages[1]);
  const update = (center: number, width: number, rampSec = 0) => {
    const band = designDigitalBandpass(center, width, ctx.sampleRate);
    const now = ctx.currentTime;
    for (const stage of stages) {
      if (rampSec > 0) {
        stage.frequency.setTargetAtTime(band.centerHz, now, rampSec);
        stage.Q.setTargetAtTime(band.q, now, rampSec);
      } else {
        stage.frequency.value = band.centerHz;
        stage.Q.value = band.q;
      }
    }
    return band;
  };
  const band = update(centerHz, widthOct);
  return { input: stages[0], output: stages[1], band, update, disconnect: () => stages.forEach((stage) => stage.disconnect()) };
}

export function frequencyPlotRange(band?: FrequencyBand): [number, number] {
  return band
    ? [Math.min(MIN_FREQ_HZ, band.lowHz), Math.max(MAX_FREQ_HZ, band.highHz)]
    : [MIN_FREQ_HZ, MAX_FREQ_HZ];
}

/**
 * Soft-knee brickwall waveshaper curve strictly bounded to [-LIMITER_CEILING_LINEAR, +LIMITER_CEILING_LINEAR].
 * Linear for |x| <= LIMITER_KNEE_LINEAR, C1-smooth tanh saturation above.
 */
export function createLimiterCurve(samples = 8192): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const knee = LIMITER_KNEE_LINEAR;
  const headroom = LIMITER_CEILING_LINEAR - knee;

  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1; // [-1, 1]
    // Inputs beyond unity use the bounded endpoint of the curve.
    const ax = Math.abs(x);
    let y: number;
    if (ax <= knee) {
      y = ax;
    } else {
      y = knee + headroom * Math.tanh((ax - knee) / headroom);
    }
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

/** Build the master safety limiter pair (DynamicsCompressor + brickwall WaveShaper) */
export function createMasterSafetyLimiter(ctx: BaseAudioContext): {
  input: AudioNode;
  output: AudioNode;
  compressor: DynamicsCompressorNode;
  shaper: WaveShaperNode;
} {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 8;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.08;

  const shaper = ctx.createWaveShaper();
  shaper.curve = createLimiterCurve();
  // This must be the last signal-changing node. Reconstruction inside an
  // oversampled shaper can overshoot its own curve.
  shaper.oversample = 'none';

  compressor.connect(shaper);
  return { input: compressor, output: shaper, compressor, shaper };
}

/** Keep both dry and notched signals ready so bypass never changes a live filter's type. */
export function createNotchChain(
  ctx: BaseAudioContext,
  centerHz: number,
  widthOct: number,
  enabled: boolean
): {
  input: AudioNode;
  output: AudioNode;
  stages: BiquadFilterNode[];
  update: (centerHz: number, widthOct: number, enabled: boolean, rampSec?: number) => void;
  disconnect: () => void;
} {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const stages = Array.from({ length: NOTCH_STAGES }, () => {
    const stage = ctx.createBiquadFilter();
    stage.type = 'notch';
    return stage;
  });
  input.connect(dry).connect(output);
  input.connect(stages[0]);
  stages[0].connect(stages[1]);
  stages[1].connect(stages[2]);
  stages[2].connect(wet).connect(output);
  dry.gain.value = enabled ? 0 : 1;
  wet.gain.value = enabled ? 1 : 0;

  const tune = (fc: number, wOct: number, rampSec = 0) => {
    const { centerHz: safeFc, q } = designDigitalNotch(fc, wOct, ctx.sampleRate);
    const now = ctx.currentTime;

    for (const stage of stages) {
      if (rampSec > 0) {
        stage.frequency.setTargetAtTime(safeFc, now, rampSec);
        stage.Q.setTargetAtTime(q, now, rampSec);
      } else {
        stage.frequency.value = safeFc;
        stage.Q.value = q;
      }
    }
  };

  tune(centerHz, widthOct);

  return {
    input,
    output,
    stages,
    update: (fc, wOct, active, rampSec = 0.03) => {
      if (fc !== centerHz || wOct !== widthOct) {
        tune(fc, wOct, rampSec);
        centerHz = fc;
        widthOct = wOct;
      }
      if (active !== enabled) {
        enabled = active;
        const now = ctx.currentTime;
        // With the same time constant the gains stay complementary, including
        // when another toggle interrupts a fade. The mix settles within 45 ms.
        dry.gain.setTargetAtTime(active ? 0 : 1, now, 0.008);
        wet.gain.setTargetAtTime(active ? 1 : 0, now, 0.008);
      }
    },
    disconnect: () => [input, output, dry, wet, ...stages].forEach((node) => node.disconnect()),
  };
}

/** Deterministic PRNG (Mulberry32) so tests and noise buffers are reproducible and crisp */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fill raw channel samples for a noise bed. Loop preparation happens in createNoiseBuffer.
 */
export function fillNoiseChannel(
  out: Float32Array,
  type: 'white' | 'pink' | 'brown' | 'rain' | 'ocean',
  sampleRate: number,
  seed = 1337
): void {
  const rand = mulberry32(seed);
  const n = out.length;

  if (type === 'white') {
    for (let i = 0; i < n; i++) {
      out[i] = (rand() * 2 - 1) * 0.32;
    }
  } else if (type === 'pink') {
    // Paul Kellet's refined 7-stage pink noise filter (±0.05 dB accuracy 20 Hz - 20 kHz)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    // Warm up filter state so initial samples match steady-state spectrum
    for (let w = 0; w < 512; w++) {
      const white = rand() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      b6 = white * 0.115926;
    }
    for (let i = 0; i < n; i++) {
      const white = rand() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      out[i] = pink * 0.045;
    }
  } else if (type === 'brown') {
    // True Brownian (-6 dB/octave) leaky integrator scaled to sampleRate
    // Pole at ~18 Hz keeps -6 dB/oct accurate across 80 Hz..16 kHz without DC blowup
    const pole = Math.exp((-2 * Math.PI * 18) / sampleRate);
    let last = 0;
    for (let w = 0; w < 1024; w++) {
      last = pole * last + (1 - pole) * (rand() * 2 - 1);
    }
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      last = pole * last + (1 - pole) * (rand() * 2 - 1);
      out[i] = last;
      sumSq += last * last;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n)) || 1;
    const targetRms = 0.20;
    const scale = targetRms / rms;
    for (let i = 0; i < n; i++) {
      out[i] = Math.max(-0.48, Math.min(0.48, out[i] * scale));
    }
  } else if (type === 'rain') {
    // Layered pink rain bed + delicate stochastic soft droplet texture
    fillNoiseChannel(out, 'pink', sampleRate, seed);
    let dropEnv = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      if (rand() < 0.0012) {
        dropEnv = Math.min(1, dropEnv + 0.35 + rand() * 0.45);
      }
      dropEnv *= 0.992;
      const hiss = (rand() * 2 - 1) * 0.18;
      lp = lp * 0.72 + (out[i] * 0.92 + hiss * (0.28 + dropEnv * 0.45)) * 0.28;
      out[i] = lp * 1.45;
    }
  } else {
    // Ocean: warm brown+pink bed modulated gently (paired with LFO filter in engine)
    const brown = new Float32Array(n);
    const pink = new Float32Array(n);
    fillNoiseChannel(brown, 'brown', sampleRate, seed);
    fillNoiseChannel(pink, 'pink', sampleRate, seed + 97);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const swell = 0.55 + 0.45 * Math.sin(2 * Math.PI * (t / 6.0));
      out[i] = brown[i] * 0.75 + pink[i] * 0.42 * swell;
    }
  }
}

/** Create a stereo decorrelated seamless AudioBuffer for any relief noise bed */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  type: ReliefNoiseType,
  durationSec = 10
): AudioBuffer {
  const length = Math.max(2048, Math.floor(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const overlap = Math.min(Math.floor(length / 8), Math.floor(ctx.sampleRate * 0.25));
  const samples = new Float32Array(length + overlap);
  const seeds = [1001 + type.length * 31, 4099 + type.length * 53];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    fillNoiseChannel(samples, type, ctx.sampleRate, seeds[channel]);
    const loop = buffer.getChannelData(channel);
    loop.set(samples.subarray(0, length));
    // At wrap the first frame follows the last raw frame. Fade from that
    // continuation into the head, then carry on past the blended samples.
    for (let i = 0; i < overlap; i++) {
      const angle = i * Math.PI / (2 * overlap);
      loop[i] = samples[length + i] * Math.cos(angle) + samples[i] * Math.sin(angle);
    }
  }
  return buffer;
}

/** Smooth click-free gain ramp helper (supports mid-ramp reversals and future scheduling) */
export function rampGain(
  param: AudioParam,
  target: number,
  now: number,
  durationSec = 0.035
): void {
  const safeTarget = Math.max(0, target);
  const dur = Math.max(0.005, durationSec);
  if (typeof param.cancelAndHoldAtTime === 'function') {
    try {
      param.cancelAndHoldAtTime(now);
      param.linearRampToValueAtTime(safeTarget, now + dur);
      return;
    } catch {
      // Fallback below
    }
  }
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(safeTarget, now + dur);
}

/** Radix-2 Cooley-Tukey FFT (pure TypeScript, used for DSP tests & offline spectral checks) */
export function computeMagnitudeSpectrumDb(
  samples: Float32Array,
  fftSize = 4096
): Float32Array {
  const n = fftSize;
  const re = new Float32Array(n);
  const im = new Float32Array(n);

  // Apply Hann window
  const len = Math.min(samples.length, n);
  for (let i = 0; i < len; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = samples[i] * w;
  }

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = k * step;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * wr - im[i + k + half] * wi;
        const vIm = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
      }
    }
  }

  const bins = n >> 1;
  const db = new Float32Array(bins);
  const norm = 2 / n;
  for (let i = 0; i < bins; i++) {
    const mag = Math.hypot(re[i], im[i]) * norm;
    db[i] = 20 * Math.log10(Math.max(1e-10, mag));
  }
  return db;
}

/** Measure linear spectral slope in dB/octave across [lowHz, highHz] via least-squares regression */
export function measureSpectralSlopeDbPerOct(
  spectrumDb: Float32Array,
  sampleRate: number,
  lowHz = 250,
  highHz = 8000
): number {
  const fftSize = spectrumDb.length * 2;
  const binHz = sampleRate / fftSize;
  const startBin = Math.max(1, Math.floor(lowHz / binHz));
  const endBin = Math.min(spectrumDb.length - 1, Math.floor(highHz / binHz));

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let count = 0;

  // Weight bins inversely by frequency (log-spaced density) so high bins don't dominate
  for (let b = startBin; b <= endBin; b++) {
    const freq = b * binHz;
    const x = Math.log2(freq);
    const y = spectrumDb[b];
    const w = 1 / b;
    sumX += w * x;
    sumY += w * y;
    sumXX += w * x * x;
    sumXY += w * x * y;
    count += w;
  }

  const denom = count * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return 0;
  return (count * sumXY - sumX * sumY) / denom;
}

/** Response of the same digital model that sets the Web Audio notch Q. */
export function theoreticalNotchResponseDb(freqHz: number, notch: DigitalNotch): number {
  if (freqHz <= 0 || freqHz >= notch.sampleRate / 2) return 0;
  const ratio = warp(freqHz, notch.sampleRate) / warp(notch.centerHz, notch.sampleRate);
  const u = ratio - 1 / ratio;
  const power = u * u / (u * u + 1 / (notch.q * notch.q));
  return 10 * NOTCH_STAGES * Math.log10(Math.max(1e-12, power));
}
