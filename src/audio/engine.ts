import type { EarSide, ReliefNoiseType, SoundType } from '../types';
import { formatHz } from '../utils/format';
import {
  createBandpassChain,
  createMasterSafetyLimiter,
  createNoiseBuffer,
  createNotchChain,
  RI_BANDWIDTH_OCT,
  matchOutputCeilingHz,
  measureTruePeak,
  rampGain,
} from './dsp';

export type ActiveSourceKind =
  | 'idle'
  | 'headphone-check'
  | 'calibration'
  | 'match-preview'
  | 'relief-noise'
  | 'relief-music'
  | 'ri-stimulus';

export interface EngineSnapshot {
  isPlaying: boolean;
  sourceKind: ActiveSourceKind;
  comfortLevel: number;
  ear: EarSide;
  sampleRate: number;
}

type Listener = (snap: EngineSnapshot) => void;
export type PlaybackStopReason = 'muted' | 'left' | 'paused' | 'completed' | 'replaced' | 'interrupted' | 'continued';

interface ActiveVoice {
  stop: (fadeSec?: number) => void;
  updateMatch?: (params: MatchSynthParams) => void;
  updateNotch?: (centerHz: number, widthOct: number, enabled: boolean) => void;
  setVolume?: (vol: number) => void;
  setRepeat?: (repeat: boolean) => void;
  setTherapyTiming?: (volume: number, secondsLeft: number, attackSec: number) => void;
}

export interface MatchSynthParams {
  soundType: SoundType;
  frequencyHz: number;
  loudness: number; // 0..100
  bandwidthOct: number;
  pulseRateHz?: number;
  ear: EarSide;
}

export interface ReliefNoiseParams {
  noiseType: ReliefNoiseType;
  centerHz: number;
  notchWidthOct: number;
  notchEnabled: boolean;
  volume: number; // 0..1
  ear: EarSide;
}

export interface RIMaskTiming {
  readonly startedAt: number;
  readonly endsAt: number;
  currentTime: () => number;
  endEarly: () => void;
}

export const BUILTIN_SAMPLE_DURATION_SEC = 14;

export class TinnituneAudioEngine {
  private ctx: AudioContext | OfflineAudioContext | null = null;
  private safetyAcknowledged = false;
  private requestId = 0;
  private stopListeners = new Set<(kind: ActiveSourceKind, reason: PlaybackStopReason) => void>();
  private masterGain: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private analyser: AnalyserNode | null = null;
  private peakAnalysers: AnalyserNode[] = [];
  private noiseCache = new Map<ReliefNoiseType, AudioBuffer>();
  private ambientSampleCache: AudioBuffer | null = null;
  private activeVoice: ActiveVoice | null = null;

  private sourceKind: ActiveSourceKind = 'idle';
  private comfortLevel = 0.55;
  private ear: EarSide = 'both';
  private listeners = new Set<Listener>();
  private timeDomainBuf: Float32Array<ArrayBuffer> | null = null;

  // HTMLAudioElement music state (for local user files)
  private musicEl: HTMLAudioElement | null = null;
  private musicSourceNode: MediaElementAudioSourceNode | null = null;
  private musicGainNode: GainNode | null = null;
  private musicNotch: ReturnType<typeof createNotchChain> | null = null;

  // Buffer-backed music playback state (built-in sample + WebKit fallback)
  private bufferMusicStartCtxTime = 0;
  private bufferMusicStartOffset = 0;
  private bufferMusicDuration = 0;
  private bufferMusicActive = false;
  private bufferMusicRepeat = false;

  constructor(private readonly offlineContext?: OfflineAudioContext) {}

  /**
   * Unlock and lazily construct AudioContext on first user gesture (iOS Safari safe).
   */
  private async ensureContext(): Promise<AudioContext | OfflineAudioContext> {
    if (!this.safetyAcknowledged) {
      throw new Error('Acknowledge the safety notice in Setup before playing sound.');
    }
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx && !this.offlineContext) {
        throw new Error('Web Audio API is not supported in this browser.');
      }
      this.ctx = this.offlineContext ?? new AudioCtx();
      const ctx = this.ctx;
      if (!this.offlineContext) {
        ctx.addEventListener('statechange', () => {
          if (ctx.state !== 'running' && this.activeVoice) this.stop(0.025, 'paused');
        });
      }

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.comfortToGain(this.comfortLevel);

      this.panner = this.ctx.createStereoPanner();
      this.panner.pan.value = this.earToPan(this.ear);

      const limiter = createMasterSafetyLimiter(this.ctx);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.78;
      this.analyser.minDecibels = -95;
      this.analyser.maxDecibels = -6;
      const splitter = this.ctx.createChannelSplitter(2);
      const meterSize = 4096;
      this.timeDomainBuf = new Float32Array(new ArrayBuffer(meterSize * 4));
      this.peakAnalysers = [0, 1].map((channel) => {
        const meter = ctx.createAnalyser();
        meter.fftSize = meterSize;
        splitter.connect(meter, channel);
        return meter;
      });

      // Every voice reaches the final shaper before the destination. Meters tap
      // the output in parallel, keeping channel conversion outside the signal path.
      this.panner.connect(this.masterGain);
      this.masterGain.connect(limiter.input);
      limiter.output.connect(this.analyser);
      limiter.output.connect(splitter);
      limiter.output.connect(this.ctx.destination);
    }

    if (!this.offlineContext && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        throw new Error(
          'Audio output could not start in this browser session. Check your sound settings and tap again.'
        );
      }
    }
    return this.ctx;
  }

  private async beginPlayback() {
    const requestId = ++this.requestId;
    const context = await this.ensureContext();
    this.checkRequest(requestId);
    return { context, requestId };
  }

  private checkRequest(requestId: number): void {
    if (requestId !== this.requestId || !this.safetyAcknowledged) {
      throw new DOMException('Playback was canceled.', 'AbortError');
    }
  }

  public setSafetyAcknowledged(acknowledged: boolean): void {
    this.safetyAcknowledged = acknowledged;
    if (!acknowledged) this.stop();
  }

  public subscribeToStop(fn: (kind: ActiveSourceKind, reason: PlaybackStopReason) => void): () => void {
    this.stopListeners.add(fn);
    return () => { this.stopListeners.delete(fn); };
  }

  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  public getSnapshot(): EngineSnapshot {
    return {
      isPlaying: this.sourceKind !== 'idle',
      sourceKind: this.sourceKind,
      comfortLevel: this.comfortLevel,
      ear: this.ear,
      sampleRate: this.ctx?.sampleRate ?? 48000,
    };
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  public readCurrentPeakDbfs(): number {
    if (!this.timeDomainBuf || this.sourceKind === 'idle') return -96;
    let peak = 0;
    for (const analyser of this.peakAnalysers) {
      analyser.getFloatTimeDomainData(this.timeDomainBuf);
      peak = Math.max(peak, measureTruePeak(this.timeDomainBuf));
    }
    return peak < 1e-5 ? -96 : 20 * Math.log10(peak);
  }

  private comfortToGain(level: number): number {
    const clamped = Math.max(0.05, Math.min(1, level));
    return Math.pow(clamped, 1.55) * 0.44;
  }

  private earToPan(ear: EarSide): number {
    if (ear === 'left') return -1;
    if (ear === 'right') return 1;
    return 0;
  }

  public setComfortLevel(level: number): void {
    this.comfortLevel = Math.max(0.05, Math.min(1, level));
    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      const gain = this.masterGain.gain;
      const target = this.comfortToGain(this.comfortLevel);
      if (this.sourceKind === 'idle') {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(target, now);
      } else {
        rampGain(gain, target, now, target < gain.value ? 0.005 : 0.035);
      }
    }
    this.emit();
  }

  public setEar(ear: EarSide, immediately = false): void {
    this.ear = ear;
    if (this.ctx && this.panner) {
      const { pan } = this.panner;
      const now = this.ctx.currentTime;
      const target = this.earToPan(ear);
      if (immediately) {
        pan.cancelScheduledValues(now);
        pan.setValueAtTime(target, now);
      } else {
        pan.setTargetAtTime(target, now, 0.02);
      }
    }
    this.emit();
  }

  private getNoiseBuffer(ctx: BaseAudioContext, type: ReliefNoiseType): AudioBuffer {
    let buf = this.noiseCache.get(type);
    if (!buf || buf.sampleRate !== ctx.sampleRate) {
      buf = createNoiseBuffer(ctx, type, 10);
      this.noiseCache.set(type, buf);
    }
    return buf;
  }

  /** Stop any currently playing sound cleanly with click-free gain ramp */
  public stop(fadeSec = 0.04, reason: PlaybackStopReason = 'muted'): void {
    ++this.requestId;
    if (this.sourceKind === 'idle') {
      for (const fn of this.stopListeners) fn('idle', reason);
    }
    this.stopVoice(fadeSec, reason);
  }

  private stopVoice(fadeSec: number, reason: PlaybackStopReason = 'replaced'): void {
    const hadActiveVoice = this.activeVoice !== null;
    if (this.activeVoice) {
      const voice = this.activeVoice;
      this.activeVoice = null;
      voice.stop(fadeSec);
    }
    this.bufferMusicActive = false;
    // Only pause musicEl immediately as a fallback when no activeVoice fade ramp owns it
    if (!hadActiveVoice && this.musicEl && !this.musicEl.paused) {
      this.musicEl.pause();
    }
    if (this.sourceKind !== 'idle') {
      const previous = this.sourceKind;
      this.sourceKind = 'idle';
      for (const fn of this.stopListeners) fn(previous, reason);
      this.emit();
    }
  }

  /** Play a gentle stereo verification chime in left or right ear */
  public async playEarCheck(side: 'left' | 'right'): Promise<void> {
    const { context: ctx } = await this.beginPlayback();
    this.stopVoice(0.02);

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const env = ctx.createGain();
    const localPan = ctx.createStereoPanner();

    const baseHz = side === 'left' ? 440 : 554.37;
    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(baseHz, now);
    osc2.frequency.setValueAtTime(baseHz * 2, now);

    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.12;

    localPan.pan.setValueAtTime(side === 'left' ? -1 : 1, now);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.45, now + 0.045);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);

    osc1.connect(env);
    osc2.connect(harmonicGain);
    harmonicGain.connect(env);
    env.connect(localPan);
    localPan.connect(this.masterGain!);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.9);
    osc2.stop(now + 0.9);

    this.sourceKind = 'headphone-check';
    this.emit();

    const timeout = window.setTimeout(() => {
      if (this.sourceKind === 'headphone-check') {
        this.sourceKind = 'idle';
        this.activeVoice = null;
        this.emit();
      }
    }, 900);

    this.activeVoice = {
      stop: (fade = 0.025) => {
        window.clearTimeout(timeout);
        const t = ctx.currentTime;
        rampGain(env.gain, 0.0001, t, fade);
        try {
          osc1.stop(t + fade + 0.01);
          osc2.stop(t + fade + 0.01);
        } catch {
          // already stopped
        }
      },
    };
  }

  /** Play gentle pink-noise calibration bed for volume comfort setup */
  public async startCalibrationTone(ear: EarSide = 'both'): Promise<void> {
    const { context: ctx } = await this.beginPlayback();
    this.stopVoice(0.03);
    this.setEar(ear, true);

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(ctx, 'pink');
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2800;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    rampGain(gain.gain, 0.55, now, 0.08);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.panner!);
    src.start(now);

    this.sourceKind = 'calibration';
    this.emit();

    this.activeVoice = {
      stop: (fade = 0.04) => {
        const t = ctx.currentTime;
        rampGain(gain.gain, 0.0001, t, fade);
        window.setTimeout(() => {
          try {
            src.stop();
            src.disconnect();
            filter.disconnect();
            gain.disconnect();
          } catch {
            // noop
          }
        }, Math.ceil((fade + 0.03) * 1000));
      },
    };
  }

  /** Start or seamlessly update the tinnitus matcher synthesizer */
  public async playMatchSound(params: MatchSynthParams, restart = false): Promise<void> {
    const { context: ctx } = await this.beginPlayback();
    const ceilingHz = matchOutputCeilingHz(ctx.sampleRate);
    if (params.frequencyHz > ceilingHz) {
      if (this.sourceKind === 'match-preview') this.stop();
      else this.emit();
      throw new Error(`This output can audition pitches up to ${formatHz(ceilingHz)}. ${formatHz(params.frequencyHz)} is unavailable.`);
    }
    this.setEar(params.ear);

    if (!restart && this.sourceKind === 'match-preview' && this.activeVoice?.updateMatch) {
      this.activeVoice.updateMatch(params);
      return;
    }

    this.stopVoice(0.025);
    this.buildMatchVoice(ctx, params);
  }

  public updateMatchSound(params: MatchSynthParams): void {
    if (this.sourceKind !== 'match-preview' || !this.ctx) return;
    if (params.frequencyHz > matchOutputCeilingHz(this.ctx.sampleRate)) {
      this.stop();
      return;
    }
    this.activeVoice?.updateMatch?.(params);
  }

  private buildMatchVoice(ctx: BaseAudioContext, initial: MatchSynthParams): void {
    let currentType = initial.soundType;
    const now = ctx.currentTime;
    const outGain = ctx.createGain();
    const targetLevel = this.loudnessToGain(initial.loudness, initial.soundType);

    outGain.gain.setValueAtTime(0.0001, now);
    rampGain(outGain.gain, targetLevel, now, 0.04);
    outGain.connect(this.panner!);

    const cleanups: Array<() => void> = [];
    let updateParams: (p: MatchSynthParams) => void = () => {};

    const safeFreq = (f: number) => Math.max(200, Math.min(ctx.sampleRate * 0.45, f));

    if (initial.soundType === 'tone') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(safeFreq(initial.frequencyHz), now);
      osc.connect(outGain);
      osc.start(now);

      cleanups.push(() => {
        try { osc.stop(); osc.disconnect(); } catch { /* noop */ }
      });
      updateParams = (p) => {
        const t = ctx.currentTime;
        osc.frequency.setTargetAtTime(safeFreq(p.frequencyHz), t, 0.02);
        outGain.gain.setTargetAtTime(this.loudnessToGain(p.loudness, p.soundType), t, 0.025);
      };
    } else if (initial.soundType === 'hiss' || initial.soundType === 'whoosh') {
      const src = ctx.createBufferSource();
      src.buffer = this.getNoiseBuffer(ctx, initial.soundType === 'hiss' ? 'white' : 'pink');
      src.loop = true;

      const filter = createBandpassChain(ctx, initial.frequencyHz, initial.bandwidthOct);
      const makeup = ctx.createGain();
      const makeupLevel = (q: number) => Math.min(3.4, 1.15 + Math.sqrt(q) * 0.55);
      makeup.gain.setValueAtTime(makeupLevel(filter.band.q), now);

      src.connect(filter.input);
      filter.output.connect(makeup);

      if (initial.soundType === 'whoosh') {
        const modGain = ctx.createGain();
        modGain.gain.setValueAtTime(0.85, now);
        const lfo = ctx.createOscillator();
        const lfoDepth = ctx.createGain();
        lfo.frequency.setValueAtTime(0.45, now);
        lfoDepth.gain.setValueAtTime(0.16, now);
        lfo.connect(lfoDepth);
        lfoDepth.connect(modGain.gain);
        lfo.start(now);

        makeup.connect(modGain);
        modGain.connect(outGain);
        cleanups.push(() => {
          try { lfo.stop(); lfo.disconnect(); lfoDepth.disconnect(); modGain.disconnect(); } catch { /* noop */ }
        });
      } else {
        makeup.connect(outGain);
      }

      src.start(now);
      cleanups.push(() => {
        try { src.stop(); src.disconnect(); filter.disconnect(); makeup.disconnect(); } catch { /* noop */ }
      });

      updateParams = (p) => {
        const t = ctx.currentTime;
        const band = filter.update(p.frequencyHz, p.bandwidthOct, 0.025);
        makeup.gain.setTargetAtTime(makeupLevel(band.q), t, 0.03);
        outGain.gain.setTargetAtTime(this.loudnessToGain(p.loudness, p.soundType), t, 0.025);
      };
    } else if (initial.soundType === 'buzz') {
      const harmonics = [
        { mult: 1, amp: 0.62 },
        { mult: 2, amp: 0.24 },
        { mult: 3, amp: 0.11 },
        { mult: 4, amp: 0.05 },
      ];
      const oscNodes: Array<{ osc: OscillatorNode; gain: GainNode; mult: number; baseAmp: number }> = [];
      for (const h of harmonics) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = h.mult === 1 ? 'triangle' : 'sine';
        const hf = initial.frequencyHz * h.mult;
        osc.frequency.setValueAtTime(safeFreq(hf), now);
        g.gain.setValueAtTime(hf < ctx.sampleRate * 0.45 ? h.amp : 0, now);
        osc.connect(g);
        g.connect(outGain);
        osc.start(now);
        oscNodes.push({ osc, gain: g, mult: h.mult, baseAmp: h.amp });
      }
      cleanups.push(() => {
        for (const item of oscNodes) {
          try { item.osc.stop(); item.osc.disconnect(); item.gain.disconnect(); } catch { /* noop */ }
        }
      });
      updateParams = (p) => {
        const t = ctx.currentTime;
        for (const item of oscNodes) {
          const hf = p.frequencyHz * item.mult;
          item.osc.frequency.setTargetAtTime(safeFreq(hf), t, 0.02);
          item.gain.gain.setTargetAtTime(hf < ctx.sampleRate * 0.45 ? item.baseAmp : 0, t, 0.02);
        }
        outGain.gain.setTargetAtTime(this.loudnessToGain(p.loudness, p.soundType), t, 0.025);
      };
    } else {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.type = 'sine';
      osc2.type = 'sine';
      const f0 = safeFreq(initial.frequencyHz);
      osc1.frequency.setValueAtTime(f0, now);
      osc2.frequency.setValueAtTime(safeFreq(f0 * 1.006), now);

      const carrierMix = ctx.createGain();
      carrierMix.gain.setValueAtTime(0.55, now);

      const pulseGain = ctx.createGain();
      pulseGain.gain.setValueAtTime(0.5, now);

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(initial.pulseRateHz ?? 11, now);
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.setValueAtTime(0.42, now);
      lfo.connect(lfoDepth);
      lfoDepth.connect(pulseGain.gain);

      osc1.connect(carrierMix);
      osc2.connect(carrierMix);
      carrierMix.connect(pulseGain);
      pulseGain.connect(outGain);

      osc1.start(now);
      osc2.start(now);
      lfo.start(now);

      cleanups.push(() => {
        try {
          osc1.stop(); osc2.stop(); lfo.stop();
          osc1.disconnect(); osc2.disconnect(); lfo.disconnect();
          carrierMix.disconnect(); pulseGain.disconnect(); lfoDepth.disconnect();
        } catch { /* noop */ }
      });

      updateParams = (p) => {
        const t = ctx.currentTime;
        const f = safeFreq(p.frequencyHz);
        osc1.frequency.setTargetAtTime(f, t, 0.02);
        osc2.frequency.setTargetAtTime(safeFreq(f * 1.006), t, 0.02);
        if (p.pulseRateHz) {
          lfo.frequency.setTargetAtTime(p.pulseRateHz, t, 0.03);
        }
        outGain.gain.setTargetAtTime(this.loudnessToGain(p.loudness, p.soundType), t, 0.025);
      };
    }

    this.sourceKind = 'match-preview';
    this.emit();

    this.activeVoice = {
      updateMatch: (p) => {
        if (p.soundType !== currentType) {
          currentType = p.soundType;
          this.stopVoice(0.02);
          this.buildMatchVoice(ctx, p);
          return;
        }
        updateParams(p);
      },
      stop: (fade = 0.035) => {
        const t = ctx.currentTime;
        rampGain(outGain.gain, 0.0001, t, fade);
        window.setTimeout(() => {
          for (const fn of cleanups) fn();
          try { outGain.disconnect(); } catch { /* noop */ }
        }, Math.ceil((fade + 0.03) * 1000));
      },
    };
  }

  private loudnessToGain(loudness: number, type: SoundType): number {
    const norm = Math.max(0.04, Math.min(1, loudness / 100));
    const base = type === 'tone' || type === 'crickets' ? 0.36 : type === 'buzz' ? 0.42 : 0.68;
    return Math.pow(norm, 1.4) * base;
  }

  /** Start notched sound therapy bed (white / pink / brown / rain / ocean) */
  public async startNotchedNoise(params: ReliefNoiseParams, continuing = false): Promise<void> {
    const { context: ctx } = await this.beginPlayback();
    this.stopVoice(0.04, continuing ? 'continued' : 'replaced');
    this.setEar(params.ear);

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(ctx, params.noiseType);
    src.loop = true;

    const notch = createNotchChain(ctx, params.centerHz, params.notchWidthOct, params.notchEnabled);
    const volGain = ctx.createGain();
    volGain.gain.setValueAtTime(0.0001, now);
    rampGain(volGain.gain, Math.max(0.05, params.volume) * 0.85, now, 0.14);

    const extraStops: Array<() => void> = [];

    if (params.noiseType === 'ocean') {
      const surfFilter = ctx.createBiquadFilter();
      surfFilter.type = 'lowpass';
      surfFilter.frequency.setValueAtTime(950, now);
      surfFilter.Q.value = 0.7;

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.11, now);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(520, now);
      lfo.connect(lfoGain);
      lfoGain.connect(surfFilter.frequency);
      lfo.start(now);

      src.connect(surfFilter);
      surfFilter.connect(notch.input);
      extraStops.push(() => {
        try { lfo.stop(); lfo.disconnect(); lfoGain.disconnect(); surfFilter.disconnect(); } catch { /* noop */ }
      });
    } else {
      src.connect(notch.input);
    }

    notch.output.connect(volGain);
    volGain.connect(this.panner!);
    src.start(now);

    this.sourceKind = 'relief-noise';
    this.emit();

    this.activeVoice = {
      updateNotch: (cHz, wOct, en) => {
        notch.update(cHz, wOct, en, 0.03);
      },
      setTherapyTiming: (volume, secondsLeft, attackSec) => {
        const now = ctx.currentTime;
        const fadeStart = secondsLeft - 30;
        const level = Math.max(0.05, volume) * 0.85;
        const attack = Math.min(attackSec, secondsLeft);
        const target = level * Math.min(1, Math.max(0, (secondsLeft - attack) / 30));
        rampGain(volGain.gain, target, now, attack);
        if (fadeStart > attack) volGain.gain.setValueAtTime(level, now + fadeStart);
        if (secondsLeft > attack) volGain.gain.linearRampToValueAtTime(0, now + secondsLeft);
      },
      stop: (fade = 0.06) => {
        const t = ctx.currentTime;
        rampGain(volGain.gain, 0.0001, t, fade);
        window.setTimeout(() => {
          try {
            src.stop();
            src.disconnect();
            notch.disconnect();
            volGain.disconnect();
          } catch { /* noop */ }
          extraStops.forEach((fn) => fn());
        }, Math.ceil((fade + 0.04) * 1000));
      },
    };
  }

  public updateActiveNotch(centerHz: number, widthOct: number, enabled: boolean): void {
    this.activeVoice?.updateNotch?.(centerHz, widthOct, enabled);
  }

  public setTherapyTiming(volume: number, secondsLeft: number, attackSec = 0.06): void {
    this.activeVoice?.setTherapyTiming?.(volume, secondsLeft, attackSec);
  }

  public setActiveVolume(vol: number): void {
    this.activeVoice?.setVolume?.(vol);
  }

  /**
   * Disconnect prior MediaElementAudioSourceNode chain cleanly before attaching a new element.
   */
  private disconnectMusicElementChain(): void {
    try {
      this.musicSourceNode?.disconnect();
    } catch { /* noop */ }
    try {
      this.musicNotch?.disconnect();
    } catch { /* noop */ }
    try {
      this.musicGainNode?.disconnect();
    } catch { /* noop */ }
    this.musicSourceNode = null;
    this.musicNotch = null;
    this.musicGainNode = null;
    this.musicEl = null;
  }

  private connectMusicSource(source: AudioNode, centerHz: number, widthOct: number, enabled: boolean) {
    const ctx = source.context;
    const notch = createNotchChain(ctx, centerHz, widthOct, enabled);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(notch.input);
    notch.output.connect(gain);
    gain.connect(this.masterGain!);
    return { notch, gain };
  }

  /**
   * Connect an HTMLAudioElement (local file object URL) into the notch chain + limiter.
   * Connects directly to masterGain so stereo music preserves L/R balance without mutating global ear routing.
   */
  public async attachAndPlayMusicElement(
    audioEl: HTMLAudioElement,
    centerHz: number,
    widthOct: number,
    notchEnabled: boolean,
    volume: number
  ): Promise<void> {
    const { context: ctx, requestId } = await this.beginPlayback();
    if (!('createMediaElementSource' in ctx)) throw new Error('Streaming needs a real-time audio context.');
    if (this.sourceKind !== 'relief-music' || this.bufferMusicActive) {
      this.stopVoice(0.03);
    }

    if (this.musicEl !== audioEl) {
      this.disconnectMusicElementChain();
      this.musicEl = audioEl;
      this.musicSourceNode = ctx.createMediaElementSource(audioEl);
      const { notch, gain } = this.connectMusicSource(this.musicSourceNode, centerHz, widthOct, notchEnabled);
      this.musicNotch = notch;
      this.musicGainNode = gain;
    } else if (this.musicNotch) {
      this.musicNotch.update(centerHz, widthOct, notchEnabled, 0.02);
    }

    await audioEl.play();
    try {
      this.checkRequest(requestId);
    } catch (error) {
      if (!this.activeVoice || this.musicEl !== audioEl) audioEl.pause();
      throw error;
    }
    if (this.musicGainNode) {
      rampGain(this.musicGainNode.gain, Math.max(0.05, volume) * 0.85, ctx.currentTime, 0.06);
    }

    this.bufferMusicActive = false;
    this.sourceKind = 'relief-music';
    this.emit();

    const voice: ActiveVoice = {
      updateNotch: (cHz, wOct, en) => {
        this.musicNotch?.update(cHz, wOct, en, 0.03);
      },
      setVolume: (v) => {
        if (this.musicGainNode) {
          this.musicGainNode.gain.setTargetAtTime(Math.max(0.02, v) * 0.85, ctx.currentTime, 0.03);
        }
      },
      stop: (fade = 0.05) => {
        audioEl.removeEventListener('ended', onEnded);
        if (this.musicGainNode) {
          rampGain(this.musicGainNode.gain, 0.0001, ctx.currentTime, fade);
        }
        window.setTimeout(() => {
          // A quick replay of the same element installs a new voice; never pause that one mid-play.
          const replayingSameElement =
            this.activeVoice !== null &&
            this.activeVoice !== voice &&
            this.sourceKind === 'relief-music' &&
            !this.bufferMusicActive &&
            this.musicEl === audioEl;
          if (!replayingSameElement) {
            audioEl.pause();
          }
        }, Math.ceil((fade + 0.025) * 1000));
      },
    };
    const onEnded = () => {
      if (audioEl.ended && this.activeVoice === voice) this.stopVoice(0.01, 'completed');
    };
    this.activeVoice = voice;
    audioEl.addEventListener('ended', onEnded);
  }

  /**
   * Build the lush, broadband Dmaj9 ambient acoustic sample directly as a Web Audio AudioBuffer.
   * Avoids large blob: WAV URLs on <audio>, which are fragile on WebKit / iOS Safari.
   */
  private getAmbientSampleBuffer(ctx: BaseAudioContext): AudioBuffer {
    if (this.ambientSampleCache && this.ambientSampleCache.sampleRate === ctx.sampleRate) {
      return this.ambientSampleCache;
    }
    const sampleRate = ctx.sampleRate;
    const durationSec = BUILTIN_SAMPLE_DURATION_SEC;
    const totalSamples = Math.floor(sampleRate * durationSec);
    const buffer = ctx.createBuffer(2, totalSamples, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const chord = [146.83, 220.0, 277.18, 329.63, 440.0, 554.37, 659.25];
    let pinkL = 0;
    let pinkR = 0;
    let seed = 7771;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 4294967296) * 2 - 1;
    };

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      const env =
        Math.min(1, t / 0.6) *
        Math.min(1, (durationSec - t) / 0.6) *
        (0.75 + 0.25 * Math.sin((2 * Math.PI * t) / 7));

      let padL = 0;
      let padR = 0;
      for (let c = 0; c < chord.length; c++) {
        const f = chord[c];
        const shimmer = 1 + 0.0018 * Math.sin(2 * Math.PI * (0.18 + c * 0.05) * t);
        const s1 = Math.sin(2 * Math.PI * f * shimmer * t);
        const s2 = Math.sin(2 * Math.PI * (f * 2) * t) * 0.22;
        const w = (1 / chord.length) * (c % 2 === 0 ? 1.0 : 0.8);
        padL += (s1 + s2) * w * (0.65 + 0.35 * Math.sin(c + t * 0.3));
        padR += (s1 + s2) * w * (0.65 + 0.35 * Math.cos(c + t * 0.3));
      }

      const wL = nextRand();
      const wR = nextRand();
      pinkL = pinkL * 0.82 + wL * 0.18;
      pinkR = pinkR * 0.82 + wR * 0.18;

      left[i] = Math.max(-0.85, Math.min(0.85, (padL * 0.52 + (pinkL * 0.24 + wL * 0.07)) * env));
      right[i] = Math.max(-0.85, Math.min(0.85, (padR * 0.52 + (pinkR * 0.24 + wR * 0.07)) * env));
    }

    this.ambientSampleCache = buffer;
    return buffer;
  }

  /**
   * Play the built-in ambient sample (or any decoded AudioBuffer) natively via AudioBufferSourceNode
   * through the identical 3-stage notch chain and brickwall safety limiter.
   */
  public async startBuiltInSample(
    offsetSec: number,
    centerHz: number,
    widthOct: number,
    notchEnabled: boolean,
    volume: number,
    options: { continuing?: boolean; repeat?: boolean } = {},
  ): Promise<number> {
    const { context: ctx } = await this.beginPlayback();
    const buf = this.getAmbientSampleBuffer(ctx);
    return this.startDecodedMusicBuffer(buf, offsetSec, centerHz, widthOct, notchEnabled, volume, { repeat: true, ...options });
  }

  public async decodeFileToBuffer(file: File): Promise<AudioBuffer> {
    const ctx = await this.ensureContext();
    const arr = await file.arrayBuffer();
    return ctx.decodeAudioData(arr.slice(0));
  }

  public async startDecodedMusicBuffer(
    buffer: AudioBuffer,
    offsetSec: number,
    centerHz: number,
    widthOct: number,
    notchEnabled: boolean,
    volume: number,
    { continuing = false, repeat = false }: { continuing?: boolean; repeat?: boolean } = {},
  ): Promise<number> {
    const { context: ctx } = await this.beginPlayback();
    this.stopVoice(0.03, continuing ? 'continued' : 'replaced');

    const now = ctx.currentTime;
    const dur = buffer.duration;
    const safeOffset = repeat ? Math.max(0, offsetSec) % dur : Math.max(0, Math.min(offsetSec, dur));

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = repeat;

    const { notch, gain: volGain } = this.connectMusicSource(src, centerHz, widthOct, notchEnabled);
    rampGain(volGain.gain, Math.max(0.05, volume) * 0.85, now, 0.08);
    src.start(now, safeOffset);

    this.bufferMusicStartCtxTime = now;
    this.bufferMusicStartOffset = safeOffset;
    this.bufferMusicDuration = dur;
    this.bufferMusicActive = true;
    this.bufferMusicRepeat = repeat;
    this.sourceKind = 'relief-music';
    this.emit();

    const voice: ActiveVoice = {
      updateNotch: (cHz, wOct, en) => {
        notch.update(cHz, wOct, en, 0.03);
      },
      setVolume: (v) => {
        volGain.gain.setTargetAtTime(Math.max(0.02, v) * 0.85, ctx.currentTime, 0.03);
      },
      setRepeat: (enabled) => {
        if (src.loop === enabled) return;
        this.bufferMusicStartOffset = this.getBufferMusicTime();
        this.bufferMusicStartCtxTime = ctx.currentTime;
        this.bufferMusicRepeat = enabled;
        src.loop = enabled;
      },
      stop: (fade = 0.05) => {
        const t = ctx.currentTime;
        rampGain(volGain.gain, 0.0001, t, fade);
        this.bufferMusicActive = false;
        window.setTimeout(() => {
          try {
            src.stop();
            src.disconnect();
            notch.disconnect();
            volGain.disconnect();
          } catch { /* noop */ }
        }, Math.ceil((fade + 0.03) * 1000));
      },
    };
    this.activeVoice = voice;
    src.onended = () => {
      if (this.activeVoice === voice) this.stopVoice(0.01, 'completed');
    };

    return dur;
  }

  public getBufferMusicTime(): number {
    if (!this.bufferMusicActive || !this.ctx || this.bufferMusicDuration <= 0) {
      return this.bufferMusicStartOffset;
    }
    const elapsed = Math.max(0, this.ctx.currentTime - this.bufferMusicStartCtxTime);
    const position = this.bufferMusicStartOffset + elapsed;
    return this.bufferMusicRepeat ? position % this.bufferMusicDuration : Math.min(position, this.bufferMusicDuration);
  }

  public setBufferMusicRepeat(repeat: boolean): void {
    this.activeVoice?.setRepeat?.(repeat);
  }

  /** Play matched narrow-band masking noise for Residual Inhibition test */
  public async startResidualInhibitionStimulus(
    centerHz: number,
    ear: EarSide,
    volume = 0.72,
    durationSec = 60,
  ): Promise<RIMaskTiming> {
    const { context: ctx } = await this.beginPlayback();
    if (centerHz > ctx.sampleRate * 0.49) {
      throw new Error('This audio output cannot play the saved pitch. Choose another audio output to run this test.');
    }
    this.stopVoice(0.03);
    this.setEar(ear, true);

    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(ctx, 'white');
    src.loop = true;

    const filter = createBandpassChain(ctx, centerHz, RI_BANDWIDTH_OCT);
    const gain = ctx.createGain();
    src.connect(filter.input);
    filter.output.connect(gain);
    gain.connect(this.panner!);

    const startedAt = ctx.currentTime;
    let endsAt = startedAt + durationSec;
    const level = Math.max(0.1, volume) * 0.95;
    const fadeStartsAt = endsAt - Math.min(0.25, durationSec / 2);
    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.linearRampToValueAtTime(level, startedAt + Math.min(0.35, durationSec / 2));
    gain.gain.setValueAtTime(level, fadeStartsAt);
    gain.gain.linearRampToValueAtTime(0, endsAt);

    const shorten = (fade = 0.25) => {
      const now = ctx.currentTime;
      const earlierEnd = now + fade;
      if (earlierEnd >= endsAt) return;
      rampGain(gain.gain, 0, now, fade);
      endsAt = earlierEnd;
      src.stop(endsAt);
    };
    const voice: ActiveVoice = {
      stop: (fade) => shorten(!this.offlineContext && ctx.state !== 'running' ? 0 : fade),
    };
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
      if (this.activeVoice === voice) {
        this.activeVoice = null;
        this.stopVoice(0, 'completed');
      }
    };
    src.start(startedAt);
    src.stop(endsAt);
    this.activeVoice = voice;
    this.sourceKind = 'ri-stimulus';
    this.emit();

    return {
      startedAt,
      get endsAt() { return endsAt; },
      currentTime: () => ctx.currentTime,
      endEarly: () => { if (this.activeVoice === voice) shorten(0.2); },
    };
  }
}

export const audioEngine = new TinnituneAudioEngine();
