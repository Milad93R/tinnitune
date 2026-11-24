import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookmarkCheck,
  CheckCircle2,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Share2,
  AudioLines,
  Square,
  Waves,
} from 'lucide-react';
import { designDigitalBandpass, freqToNorm, matchOutputCeilingHz, MAX_FREQ_HZ, MIN_FREQ_HZ, normToFreq, nudgeSemitones } from '../audio/dsp';
import { audioEngine, type EngineSnapshot } from '../audio/engine';
import { makeId } from '../storage/db';
import {
  SOUND_TYPE_META,
  type EarSide,
  type SoundType,
  type TinnitusMatch,
} from '../types';
import {
  formatBandEdges,
  formatEarLabel,
  formatHz,
  formatKhzCompact,
  formatMatchHeadline,
  formatShareHeadline,
  renderShareCardDataUrl,
} from '../utils/format';
import { SoundTypeGlyph } from './BrandIcons';
import { TuningDial } from './TuningDial';
import { handleRadioKeyDown } from '../utils/radioKeyboard';
import { PlaybackError } from './PlaybackError';
import { ShareSheet } from './ShareSheet';
import { MiniSpectrum } from './MiniSpectrum';
import { SpectrumVisualizer } from './SpectrumVisualizer';

interface MatchViewProps {
  defaultEar: EarSide;
  activeMatch: TinnitusMatch | null;
  engineState: EngineSnapshot;
  onSaveMatch: (match: TinnitusMatch) => Promise<void>;
  onReviewSetup?: () => void;
  onGoToRelief: (match: TinnitusMatch, isSaved: boolean) => void;
  onNotify: (msg: string) => void;
}

type MatchStep = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS: Array<{ step: MatchStep; title: string; short: string }> = [
  { step: 1, title: 'Sound Type', short: 'Type' },
  { step: 2, title: 'Coarse A/B', short: 'A/B' },
  { step: 3, title: 'Fine & Octave', short: 'Pitch' },
  { step: 4, title: 'Loudness & Width', short: 'Level' },
  { step: 5, title: 'Result Card', short: 'Result' },
];

const SOUND_TYPES: SoundType[] = ['tone', 'hiss', 'whoosh', 'buzz', 'crickets'];

const MATCH_DRAFT_KEY = 'tinnitune_match_draft_v1';

type MatchDraft = Pick<TinnitusMatch, 'soundType' | 'ear' | 'frequencyHz' | 'loudness' | 'bandwidthOct' | 'pulseRateHz' | 'octaveVerified'> & {
  step: MatchStep;
  bracket: [number, number];
  searchRound: number;
};

function loadDraft(): MatchDraft | null {
  try {
    const draft = JSON.parse(localStorage.getItem(MATCH_DRAFT_KEY) ?? 'null') as MatchDraft | null;
    if (!draft || !STEP_LABELS.some(({ step }) => step === draft.step) || !SOUND_TYPES.includes(draft.soundType)
      || !['left', 'both', 'right'].includes(draft.ear)
      || !(draft.frequencyHz >= MIN_FREQ_HZ && draft.frequencyHz <= MAX_FREQ_HZ)
      || !Number.isFinite(draft.loudness) || !Number.isFinite(draft.bandwidthOct)
      || !Array.isArray(draft.bracket) || draft.bracket.length !== 2
      || !(0 <= draft.bracket[0] && draft.bracket[0] < draft.bracket[1] && draft.bracket[1] <= 1)
      || !(draft.searchRound >= 1 && draft.searchRound <= 5)) return null;
    return draft;
  } catch {
    return null;
  }
}

const LOG_SLIDER_TICKS: Array<{ hz: number; label: string; edge?: 'start' | 'end' }> = [
  { hz: 250, label: '250 Hz', edge: 'start' },
  { hz: 500, label: '500', },
  { hz: 1000, label: '1 kHz' },
  { hz: 2000, label: '2 kHz' },
  { hz: 4000, label: '4 kHz' },
  { hz: 8000, label: '8 kHz' },
  { hz: 18000, label: '18 kHz', edge: 'end' },
];

export const MatchView: React.FC<MatchViewProps> = ({
  defaultEar,
  activeMatch,
  engineState,
  onSaveMatch,
  onGoToRelief,
  onReviewSetup,
  onNotify,
}) => {
  const [initialDraft] = useState(loadDraft);
  const initialPitch = initialDraft ?? activeMatch;
  const [step, setStep] = useState<MatchStep>(initialDraft?.step ?? 1);
  const previousStep = useRef(step);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (previousStep.current !== step) stepHeading.current?.focus({ preventScroll: true });
    previousStep.current = step;
  }, [step]);
  const [soundType, setSoundType] = useState<SoundType>(initialPitch?.soundType ?? 'tone');
  const [ear, setEar] = useState<EarSide>(initialPitch?.ear ?? defaultEar);
  const [frequencyHz, setFrequencyHz] = useState<number>(initialPitch?.frequencyHz ?? 6000);
  const [loudness, setLoudness] = useState<number>(initialPitch?.loudness ?? 48);
  const [bandwidthOct, setBandwidthOct] = useState<number>(initialPitch?.bandwidthOct ?? 0.25);
  const [pulseRateHz, setPulseRateHz] = useState<number>(initialPitch?.pulseRateHz ?? 11);
  const [octaveVerified, setOctaveVerified] = useState<boolean>(initialPitch?.octaveVerified ?? false);
  const [activeOctaveChoice, setActiveOctaveChoice] = useState<'half' | 'current' | 'double' | null>(null);
  const [savedMatch, setSavedMatch] = useState<TinnitusMatch | null>(activeMatch);
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const [shareCardUrl, setShareCardUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<{ control: string; message: string } | null>(null);
  useEffect(() => setAudioError(null), [step]);

  // Binary search bracket in log space [0..1] across 250 Hz..18 kHz
  const [bracket, setBracket] = useState<[number, number]>(initialDraft?.bracket ?? [0, 1]);
  const [searchRound, setSearchRound] = useState<number>(initialDraft?.searchRound ?? 1);
  const [activeProbe, setActiveProbe] = useState<'A' | 'B' | null>(null);
  const [previewType, setPreviewType] = useState<SoundType | null>(null);
  const pendingSave = useRef(false);
  const [saving, setSaving] = useState(false);

  const draft: MatchDraft = { step, soundType, ear, frequencyHz, loudness, bandwidthOct, pulseRateHz, octaveVerified, bracket, searchRound };
  const serializedDraft = JSON.stringify(draft);
  const initialDraftState = useRef(serializedDraft);
  const draftWritten = useRef(Boolean(initialDraft));
  useLayoutEffect(() => {
    if (!draftWritten.current && serializedDraft === initialDraftState.current) return;
    try {
      localStorage.setItem(MATCH_DRAFT_KEY, serializedDraft);
      draftWritten.current = true;
    } catch { /* storage unavailable */ }
  }, [serializedDraft]);

  const isPreviewPlaying = engineState.isPlaying && engineState.sourceKind === 'match-preview';
  const playingOctaveChoice = isPreviewPlaying ? activeOctaveChoice : null;
  const playableMaxHz = matchOutputCeilingHz(engineState.sampleRate);
  const pitchPlayable = frequencyHz <= playableMaxHz;
  const playablePitch = Math.min(frequencyHz, playableMaxHz);
  const halfHz = Math.round(frequencyHz / 2);
  const doubleHz = Math.round(frequencyHz * 2);
  const halfValid = halfHz >= MIN_FREQ_HZ;
  const doubleValid = doubleHz <= MAX_FREQ_HZ;

  const probeAHz = useMemo(
    () => Math.round(normToFreq(bracket[0] + (bracket[1] - bracket[0]) * 0.3)),
    [bracket]
  );
  const probeBHz = useMemo(
    () => Math.round(normToFreq(bracket[0] + (bracket[1] - bracket[0]) * 0.7)),
    [bracket]
  );
  const bracketHz: [number, number] = useMemo(
    () => [Math.round(normToFreq(bracket[0])), Math.round(normToFreq(bracket[1]))],
    [bracket]
  );

  const draftSignatureKey = `${soundType}:${Math.round(frequencyHz)}:${ear}:${loudness}:${bandwidthOct.toFixed(2)}:${soundType === 'crickets' ? pulseRateHz : ''}:${octaveVerified}`;

  // Clear stale share card whenever any match parameter changes
  useEffect(() => {
    setShareCardUrl(null);
  }, [draftSignatureKey]);

  const isSavedCurrent = useMemo(() => {
    if (!savedMatch) return false;
    return (
      savedMatch.soundType === soundType &&
      savedMatch.frequencyHz === Math.round(frequencyHz) &&
      savedMatch.ear === ear &&
      savedMatch.loudness === loudness &&
      Math.abs(savedMatch.bandwidthOct - bandwidthOct) < 0.005 &&
      (savedMatch.pulseRateHz ?? null) === (soundType === 'crickets' ? pulseRateHz : null) &&
      savedMatch.octaveVerified === octaveVerified
    );
  }, [savedMatch, soundType, frequencyHz, ear, loudness, bandwidthOct, pulseRateHz, octaveVerified]);

  const currentDraftMatch: TinnitusMatch = useMemo(
    () => ({
      id: isSavedCurrent && savedMatch ? savedMatch.id : makeId('match'),
      createdAt: isSavedCurrent && savedMatch ? savedMatch.createdAt : Date.now(),
      soundType,
      frequencyHz: Math.round(frequencyHz),
      ear,
      loudness,
      bandwidthOct,
      pulseRateHz: soundType === 'crickets' ? pulseRateHz : undefined,
      octaveVerified,
    }),
    [isSavedCurrent, savedMatch, soundType, frequencyHz, ear, loudness, bandwidthOct, pulseRateHz, octaveVerified]
  );

  // Single source of truth for Step 5 Result Card, headline, stats, CTA, and share card
  const displayMatch = isSavedCurrent && savedMatch ? savedMatch : currentDraftMatch;

  // The pitch and level controls own adjustable playback. Auditions have
  // their own target and never use this draft update while starting.
  useEffect(() => {
    if (!isPreviewPlaying || (step !== 3 && step !== 4) || activeOctaveChoice) return;
    audioEngine.updateMatchSound({ soundType, frequencyHz, loudness, bandwidthOct, pulseRateHz, ear });
  }, [soundType, frequencyHz, loudness, bandwidthOct, pulseRateHz, ear, isPreviewPlaying, step, activeOctaveChoice]);

  useEffect(() => audioEngine.subscribeToStop((kind, reason) => {
    if ((kind === 'match-preview' || kind === 'idle') && reason !== 'replaced') setActiveOctaveChoice(null);
  }), []);

  // Stop audio when navigating away from MatchView
  useEffect(() => {
    return () => {
      if (audioEngine.getSnapshot().sourceKind === 'match-preview') {
        audioEngine.stop(0.03);
      }
    };
  }, []);

  const handleSelectSoundType = (type: SoundType) => {
    setSoundType(type);
    setOctaveVerified(false);
    const meta = SOUND_TYPE_META[type];
    setBandwidthOct(meta.defaultBandwidthOct);
  };

  const handlePreviewType = async (type: SoundType) => {
    setAudioError(null);
    const isSameAndPlaying = isPreviewPlaying && previewType === type;
    if (isSameAndPlaying) {
      audioEngine.stop(0.03);
      return;
    }
    const meta = SOUND_TYPE_META[type];
    setPreviewType(type);
    try {
      await audioEngine.playMatchSound({
        soundType: type,
        frequencyHz,
        loudness,
        bandwidthOct: meta.defaultBandwidthOct,
        pulseRateHz,
        ear,
      }, true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setAudioError({
        control: type,
        message: err instanceof Error ? err.message : 'Could not start preview audio. Check sound settings and tap again.',
      });
    }
  };

  const handlePlayProbe = async (which: 'A' | 'B') => {
    setAudioError(null);
    if (isPreviewPlaying && activeProbe === which) {
      audioEngine.stop(0.03);
      setActiveProbe(null);
      return;
    }
    const targetHz = which === 'A' ? probeAHz : probeBHz;
    setActiveProbe(which);
    try {
      await audioEngine.playMatchSound({
        soundType,
        frequencyHz: targetHz,
        loudness,
        bandwidthOct,
        pulseRateHz,
        ear,
      }, true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setActiveProbe(null);
      setAudioError({
        control: which,
        message: err instanceof Error ? err.message : 'Could not start A/B probe audio. Check sound settings and tap again.',
      });
    }
  };

  const handleChooseCloser = (choice: 'A' | 'B' | 'between') => {
    audioEngine.stop(0.025);
    setActiveProbe(null);
    const [lo, hi] = bracket;
    const mid = (lo + hi) / 2;
    let nextLo = lo;
    let nextHi = hi;

    if (choice === 'A') {
      nextHi = lo + (hi - lo) * 0.62;
    } else if (choice === 'B') {
      nextLo = lo + (hi - lo) * 0.38;
    } else {
      const span = (hi - lo) * 0.25;
      nextLo = Math.max(0, mid - span);
      nextHi = Math.min(1, mid + span);
    }

    const nextMidHz = Math.round(normToFreq((nextLo + nextHi) / 2));
    setFrequencyHz(nextMidHz);
    setBracket([nextLo, nextHi]);

    if (searchRound >= 5 || nextHi - nextLo < 0.08) {
      setStep(3);
      setOctaveVerified(false);
    } else {
      setSearchRound((r) => r + 1);
    }
  };

  const handleResetSearch = () => {
    audioEngine.stop(0.025);
    setActiveProbe(null);
    setBracket([0, 1]);
    setSearchRound(1);
  };

  const handleToggleFinePlay = async () => {
    setAudioError(null);
    setActiveOctaveChoice(null);
    if (isPreviewPlaying && !playingOctaveChoice) {
      audioEngine.stop(0.03);
      return;
    }
    try {
      await audioEngine.playMatchSound({
        soundType,
        frequencyHz,
        loudness,
        bandwidthOct,
        pulseRateHz,
        ear,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setAudioError({
        control: 'fine',
        message: err instanceof Error ? err.message : 'Could not start tone preview. Check sound settings and tap again.',
      });
    }
  };

  const handlePlayOctave = async (mode: 'half' | 'current' | 'double') => {
    setAudioError(null);
    if (playingOctaveChoice === mode) {
      audioEngine.stop(0.03);
      setActiveOctaveChoice(null);
      return;
    }
    if ((mode === 'half' && !halfValid) || (mode === 'double' && !doubleValid)) return;
    const targetHz = mode === 'half' ? halfHz : mode === 'double' ? doubleHz : frequencyHz;
    setActiveOctaveChoice(mode);
    try {
      await audioEngine.playMatchSound({
        soundType,
        frequencyHz: targetHz,
        loudness,
        bandwidthOct,
        pulseRateHz,
        ear,
      }, true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setActiveOctaveChoice(null);
      setAudioError({
        control: mode,
        message: err instanceof Error ? err.message : 'Could not play octave comparison tone. Check sound settings and tap again.',
      });
    }
  };

  const handleSelectOctavePitch = (mode: 'half' | 'current' | 'double') => {
    audioEngine.stop(0.03);
    setActiveOctaveChoice(null);
    if (mode === 'half' && halfValid) {
      setFrequencyHz(halfHz);
    } else if (mode === 'double' && doubleValid) {
      setFrequencyHz(doubleHz);
    }
    setOctaveVerified(true);
    onNotify('Octave check confirmed');
  };

  const handleSaveDraft = async (showResult = false) => {
    if (pendingSave.current) return;
    if (showResult) audioEngine.stop(0.03);
    if (isSavedCurrent) {
      if (showResult) setStep(5);
      return;
    }
    pendingSave.current = true;
    setSaving(true);
    try {
      await onSaveMatch(currentDraftMatch);
      setSavedMatch(currentDraftMatch);
      if (showResult) setStep(5);
    } catch {
      onNotify('Could not save the match. Try again.');
    } finally {
      pendingSave.current = false;
      setSaving(false);
    }
  };

  const handleGenerateShareCard = () => {
    const url = renderShareCardDataUrl(displayMatch, engineState.sampleRate);
    setShareCardUrl(url);
  };

  const handleDownloadShareCard = () => {
    if (!shareCardUrl) return;
    const a = document.createElement('a');
    a.href = shareCardUrl;
    a.download = `tinnitune-${Math.round(displayMatch.frequencyHz)}hz.png`;
    a.click();
    onNotify('Result card PNG downloaded');
  };

  const soundMeta = SOUND_TYPE_META[soundType];
  const displayMeta = SOUND_TYPE_META[displayMatch.soundType];

  const updateFineFrequency = (hz: number) => {
    if (activeOctaveChoice) audioEngine.stop(0.03);
    setFrequencyHz(hz);
    setActiveOctaveChoice(null);
    setOctaveVerified(false);
  };

  const visualizerMarkerHz = playingOctaveChoice === 'half' ? halfHz
    : playingOctaveChoice === 'double' ? doubleHz : frequencyHz;

  const errorAt = (control: string) => audioError?.control === control
    ? <PlaybackError message={audioError.message} testId="match-audio-error" onReviewSetup={onReviewSetup} />
    : null;

  const pitchNotice = pitchPlayable ? errorAt('fine') : (
    <p className="inline-error playback-error hint-text" role="status" data-testid="match-pitch-unavailable">
      {formatHz(frequencyHz)} is above this output’s {formatHz(playableMaxHz)} audition limit. Your match keeps its pitch.
    </p>
  );
  const sliderTicks = [
    ...LOG_SLIDER_TICKS.filter((tick) => tick.hz < playableMaxHz),
    { hz: playableMaxHz, label: formatKhzCompact(playableMaxHz), edge: 'end' },
  ];

  const plottedType = step === 1 && previewType ? previewType : soundType;
  const matchBand = SOUND_TYPE_META[plottedType].hasBandwidth
    ? designDigitalBandpass(visualizerMarkerHz, step === 1 ? SOUND_TYPE_META[plottedType].defaultBandwidthOct : bandwidthOct, engineState.sampleRate)
    : undefined;
  const resultBand = displayMeta.hasBandwidth && step === 5
    ? designDigitalBandpass(displayMatch.frequencyHz, displayMatch.bandwidthOct, engineState.sampleRate)
    : undefined;

  const spectrum = (
    <SpectrumVisualizer
      isPlaying={isPreviewPlaying}
      markerHz={step === 2 ? undefined : visualizerMarkerHz}
      showOctaves={step === 3}
      bracketRange={step === 2 ? bracketHz : null}
      probes={step === 2 ? { aHz: probeAHz, bHz: probeBHz, active: isPreviewPlaying ? activeProbe : null } : null}
      band={step === 2 ? undefined : matchBand}
      height={step === 3 ? 110 : 126}
      caption={step === 2
        ? `Search window: ${formatKhzCompact(bracketHz[0])} – ${formatKhzCompact(bracketHz[1])}`
        : `${previewType && step === 1 ? SOUND_TYPE_META[previewType].label : soundMeta.label} · ${formatEarLabel(ear)}`}
    />
  );

  return (
    <div className="view-stack">
      <div className={`section-head-row ${step === 3 ? 'tuning-heading' : ''}`}>
        <div>
          <div className="eyebrow">Pitch matching</div>
          <h1>Match your sound</h1>
        </div>

        <div className="ear-mini-switch" role="radiogroup" aria-label="Matching ear" onKeyDown={handleRadioKeyDown}>
          {(['left', 'both', 'right'] as EarSide[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={ear === s}
              tabIndex={ear === s ? 0 : -1}
              aria-label={formatEarLabel(s)}
              data-testid={`match-ear-${s}`}
              className={`mini-pill-btn ${ear === s ? 'active' : ''}`}
              onClick={() => {
                setEar(s);
                audioEngine.setEar(s);
              }}
            >
              {s === 'left' ? 'L' : s === 'right' ? 'R' : 'L+R'}
            </button>
          ))}
        </div>
      </div>

      {/* Stepper */}
      <ol className="stepper" aria-label="Matching steps">
        {STEP_LABELS.map(({ step: s, title, short }) => (
          <li key={s} className={`step-item ${step === s ? 'active' : ''} ${step > s ? 'done' : ''}`}>
            <button
              type="button"
              className="step-btn"
              onClick={() => {
                audioEngine.stop(0.025);
                setActiveProbe(null);
                setActiveOctaveChoice(null);
                setStep(s);
              }}
              aria-current={step === s ? 'step' : undefined}
              data-testid={`match-step-${s}`}
            >
              <span className="step-num">{s}</span>
              <span className="step-label step-label-full">{title}</span>
              <span className="step-label step-label-short">{short}</span>
            </button>
          </li>
        ))}
      </ol>

      {((step === 1 && isPreviewPlaying) || step === 4) && spectrum}

      {/* STEP 1: Sound Type */}
      {step === 1 && (
        <section className="panel-card" data-testid="step-1-panel">
          <div className="card-head">
            <div>
              <h2 ref={stepHeading} tabIndex={-1}>1. What texture is closest to your tinnitus?</h2>
              <p className="card-desc">
                Tinnitus isn&apos;t always a pure beep. Preview each texture gently and choose the closest family.
              </p>
            </div>
          </div>

          <div className="sound-type-grid">
            {SOUND_TYPES.map((type) => {
              const meta = SOUND_TYPE_META[type];
              const selected = soundType === type;
              const playingThis = isPreviewPlaying && previewType === type;
              return (
                <article key={type} className={`sound-type-card ${selected ? 'selected' : ''}`}>
                  <button
                    type="button"
                    className="sound-type-select"
                    aria-pressed={selected}
                    onClick={() => handleSelectSoundType(type)}
                    data-testid={`sound-type-${type}`}
                  >
                    <span className={`sound-glyph-wrap ${selected ? 'selected' : ''}`}>
                      <SoundTypeGlyph type={type} size={24} />
                    </span>
                    <span className="sound-type-name">{meta.label}</span>
                    <span className="sound-type-sub">{meta.subtitle}</span>
                  </button>
                  <button
                    type="button"
                    className={`preview-chip ${playingThis ? 'playing' : ''}`}
                    onClick={() => void handlePreviewType(type)}
                    aria-label={`${playingThis ? 'Stop' : 'Preview'} ${meta.label}`}
                    data-testid={`preview-type-${type}`}
                  >
                    {playingThis ? <Square size={12} /> : <Play size={12} />}
                    <span>{playingThis ? 'Stop' : 'Preview'}</span>
                  </button>
                  {errorAt(type)}
                </article>
              );
            })}
          </div>

          <div className="step-actions">
            <span className="hint-text">Selected: <strong>{soundMeta.label}</strong></span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                audioEngine.stop(0.03);
                setStep(2);
              }}
              data-testid="step-1-next"
            >
              <span>Continue to Coarse Pitch Search</span>
              <ArrowRight size={17} />
            </button>
          </div>
        </section>
      )}

      {/* STEP 2: Binary Search A/B */}
      {step === 2 && (
        <section className="panel-card" data-testid="step-2-panel">
          <div className="card-head">
            <div>
              <h2 ref={stepHeading} tabIndex={-1}>2. Which sound is closer in pitch?</h2>
              <p className="card-desc">
                Round {searchRound} of 5 · Listen to Sound A and Sound B, then tap whichever feels closer to your tinnitus. Each choice narrows the logarithmic frequency window.
              </p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleResetSearch}>
              <RotateCcw size={14} /> Reset
            </button>
          </div>

          <div className="ab-grid">
            <div className={`ab-card ${isPreviewPlaying && activeProbe === 'A' ? 'active' : ''}`}>
              <div className="ab-tag">SOUND A · LOWER</div>
              <div className="ab-freq mono">{formatHz(probeAHz)}</div>
              <div className="ab-btn-row">
                <button
                  type="button"
                  className={`btn ${isPreviewPlaying && activeProbe === 'A' ? 'btn-amber' : 'btn-secondary'}`}
                  onClick={() => void handlePlayProbe('A')}
                  data-testid="play-probe-a"
                >
                  {isPreviewPlaying && activeProbe === 'A' ? <Square size={15} /> : <Play size={15} />}
                  <span>{isPreviewPlaying && activeProbe === 'A' ? 'Stop A' : 'Play Sound A'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleChooseCloser('A')}
                  data-testid="choose-probe-a"
                >
                  A is closer
                </button>
              </div>
              {errorAt('A')}
            </div>

            <div className={`ab-card ${isPreviewPlaying && activeProbe === 'B' ? 'active' : ''}`}>
              <div className="ab-tag">SOUND B · HIGHER</div>
              <div className="ab-freq mono">{formatHz(probeBHz)}</div>
              <div className="ab-btn-row">
                <button
                  type="button"
                  className={`btn ${isPreviewPlaying && activeProbe === 'B' ? 'btn-amber' : 'btn-secondary'}`}
                  onClick={() => void handlePlayProbe('B')}
                  data-testid="play-probe-b"
                >
                  {isPreviewPlaying && activeProbe === 'B' ? <Square size={15} /> : <Play size={15} />}
                  <span>{isPreviewPlaying && activeProbe === 'B' ? 'Stop B' : 'Play Sound B'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleChooseCloser('B')}
                  data-testid="choose-probe-b"
                >
                  B is closer
                </button>
              </div>
              {errorAt('B')}
            </div>
          </div>

          {spectrum}

          <div className="ab-mid-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => handleChooseCloser('between')}
              data-testid="choose-probe-between"
            >
              My pitch sits right between A &amp; B
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                audioEngine.stop(0.025);
                setActiveProbe(null);
                setStep(3);
              }}
              data-testid="skip-to-fine"
            >
              Skip straight to fine tuning →
            </button>
          </div>

          <div className="step-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                audioEngine.stop(0.025);
                setActiveProbe(null);
                setStep(1);
              }}
            >
              <ArrowLeft size={16} /> Back
            </button>
            <span className="mono hint-text">Current center: {formatHz(frequencyHz)}</span>
          </div>
        </section>
      )}

      {/* STEP 3: Fine Log Slider + Octave Confusion Check */}
      {step === 3 && (
        <section className="panel-card" data-testid="step-3-panel">
          <div className="dial-instrument">
            <div className="dial-controls">
              <div className="eyebrow">Fine pitch · Logarithmic scale</div>
              <h2 ref={stepHeading} tabIndex={-1}>Turn to your tone</h2>
              <div className="fine-readout-bar">
                <div>
                  <div className="readout-label">Matched frequency</div>
                  <div className="readout-big mono" data-testid="fine-freq-readout">{formatHz(frequencyHz)}</div>
                </div>
                <button type="button"
                  className={`btn btn-lg ${isPreviewPlaying && !playingOctaveChoice ? 'btn-amber' : 'btn-primary'}`}
                  disabled={!pitchPlayable}
                  onClick={() => void handleToggleFinePlay()} data-testid="fine-play-toggle">
                  {isPreviewPlaying && !playingOctaveChoice ? <Square size={17} /> : <Play size={17} />}
                  <span>{isPreviewPlaying && !playingOctaveChoice ? 'Pause Tone' : 'Listen & Tune'}</span>
                </button>
              </div>
              <p className="hint-text dial-help" id="dial-help">
                Turn the dial or tap a tick. Each detent is a semitone. Use the slider for finer adjustments.
              </p>
              {pitchNotice}
            </div>
            <TuningDial frequencyHz={frequencyHz} onChange={updateFineFrequency} />
          </div>

          <div className="slider-group">
            <div className="slider-header">
              <label htmlFor="log-freq-slider">Logarithmic Frequency (250 Hz – {formatKhzCompact(playableMaxHz)})</label>
              <span className="mono">{formatKhzCompact(playablePitch)}</span>
            </div>
            <input
              id="log-freq-slider"
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(freqToNorm(playablePitch, MIN_FREQ_HZ, playableMaxHz) * 1000)}
              aria-valuetext={formatHz(playablePitch)}
              onChange={(e) => updateFineFrequency(Math.round(normToFreq(Number(e.target.value) / 1000, MIN_FREQ_HZ, playableMaxHz)))}
              className="range-input range-amber"
              data-testid="fine-freq-slider"
            />
            <div className="scale-marks-log mono" aria-hidden="true" data-testid="log-scale-ticks">
              {sliderTicks.map((tick) => {
                const norm = freqToNorm(tick.hz, MIN_FREQ_HZ, playableMaxHz);
                const leftExpr =
                  tick.edge === 'start'
                    ? '0%'
                    : tick.edge === 'end'
                    ? '100%'
                    : `calc(12px + (100% - 24px) * ${norm.toFixed(5)})`;
                return (
                  <span
                    key={tick.hz}
                    className={`log-tick ${tick.edge ? `edge-${tick.edge}` : ''}`}
                    style={{ left: leftExpr }}
                    data-tick-hz={tick.hz}
                  >
                    {tick.label}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="nudge-row" aria-label="Semitone frequency nudges">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => updateFineFrequency(nudgeSemitones(frequencyHz, -1))}
              data-testid="nudge-down-semitone"
            >
              <Minus size={15} /> 1/12 oct
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => updateFineFrequency(Math.max(MIN_FREQ_HZ, Math.round(frequencyHz * 0.99)))}
            >
              −1%
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => updateFineFrequency(Math.min(MAX_FREQ_HZ, Math.round(frequencyHz * 1.01)))}
            >
              +1%
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => updateFineFrequency(nudgeSemitones(frequencyHz, 1))}
              data-testid="nudge-up-semitone"
            >
              <Plus size={15} /> 1/12 oct
            </button>
          </div>

          <div className="fine-spectrum">{spectrum}</div>

          {/* Octave-Confusion Check */}
          <div className="octave-box" data-testid="octave-check-box">
            <div className="octave-head">
              <div>
                <h3>
                  <AudioLines size={16} className="accent-violet" /> Octave-Confusion Check (f/2 · f · 2f)
                </h3>
                <p>
                  Many people accidentally match one octave too low or too high. Compare these three
                  related pitches and confirm which truly matches your ringing. The dial covers 250 Hz–18 kHz, including 14–17 kHz tones.
                </p>
              </div>
              {octaveVerified && (
                <span className="verified-pill">
                  <CheckCircle2 size={14} /> Verified
                </span>
              )}
            </div>

            <div className="octave-grid">
              <div className={`octave-card ${playingOctaveChoice === 'half' ? 'playing' : ''}`}>
                <span className="octave-label">f / 2 (Octave Lower)</span>
                <strong className="mono">{halfValid ? formatHz(halfHz) : 'Below 250 Hz'}</strong>
                <div className="octave-btns">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={!halfValid && playingOctaveChoice !== 'half'}
                    onClick={() => void handlePlayOctave('half')}
                    data-testid="play-octave-half"
                  >
                    {playingOctaveChoice === 'half' ? 'Stop' : 'Hear f/2'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!halfValid}
                    onClick={() => handleSelectOctavePitch('half')}
                    data-testid="pick-octave-half"
                  >
                    Use f/2
                  </button>
                </div>
                {errorAt('half')}
              </div>

              <div className={`octave-card current ${playingOctaveChoice === 'current' ? 'playing' : ''}`}>
                <span className="octave-label">f (Current Match)</span>
                <strong className="mono">{formatHz(frequencyHz)}</strong>
                <div className="octave-btns">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handlePlayOctave('current')}
                    data-testid="play-octave-current"
                  >
                    {playingOctaveChoice === 'current' ? 'Stop' : 'Hear f'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => handleSelectOctavePitch('current')}
                    data-testid="confirm-octave-current"
                  >
                    Confirm f
                  </button>
                </div>
                {errorAt('current')}
              </div>

              <div className={`octave-card ${playingOctaveChoice === 'double' ? 'playing' : ''}`}>
                <span className="octave-label">2f (Octave Higher)</span>
                <strong className="mono">{doubleValid ? formatHz(doubleHz) : 'Above 18 kHz'}</strong>
                <div className="octave-btns">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={!doubleValid && playingOctaveChoice !== 'double'}
                    onClick={() => void handlePlayOctave('double')}
                    data-testid="play-octave-double"
                  >
                    {playingOctaveChoice === 'double' ? 'Stop' : 'Hear 2f'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!doubleValid}
                    onClick={() => handleSelectOctavePitch('double')}
                    data-testid="pick-octave-double"
                  >
                    Use 2f
                  </button>
                </div>
                {errorAt('double')}
              </div>
            </div>
          </div>

          <div className="step-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                audioEngine.stop(0.025);
                setStep(2);
              }}
            >
              <ArrowLeft size={16} /> Back to A/B
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                audioEngine.stop(0.025);
                setActiveOctaveChoice(null);
                setStep(4);
              }}
              data-testid="step-3-next"
            >
              <span>Match Loudness &amp; Width</span>
              <ArrowRight size={17} />
            </button>
          </div>
        </section>
      )}

      {/* STEP 4: Loudness & Bandwidth */}
      {step === 4 && (
        <section className="panel-card" data-testid="step-4-panel">
          <div className="card-head">
            <div>
              <h2 ref={stepHeading} tabIndex={-1}>4. Match loudness {soundMeta.hasBandwidth ? '& bandwidth' : '& texture'}</h2>
              <p className="card-desc">
                Adjust until the preview matches the perceived loudness of your tinnitus
                {soundMeta.hasBandwidth
                  ? ' and widen or narrow the spectral band to match its sharpness.'
                  : '.'}
              </p>
            </div>
            <button
              type="button"
              className={`btn ${isPreviewPlaying ? 'btn-amber' : 'btn-primary'}`}
              disabled={!pitchPlayable}
              onClick={() => void handleToggleFinePlay()}
              data-testid="step-4-play-toggle"
            >
              {isPreviewPlaying ? <Square size={15} /> : <Play size={15} />}
              <span>{isPreviewPlaying ? 'Pause' : 'Play Preview'}</span>
            </button>
          </div>

          {pitchNotice}
          <div className="sliders-stack">
            <div className="slider-group">
              <div className="slider-header">
                <label htmlFor="loudness-match-slider">Perceived Loudness Match</label>
                <span className="mono">{loudness}%</span>
              </div>
              <input
                id="loudness-match-slider"
                type="range"
                min={5}
                max={100}
                step={1}
                value={loudness}
                onChange={(e) => setLoudness(Number(e.target.value))}
                className="range-input"
                data-testid="loudness-match-slider"
              />
              <div className="scale-marks">
                <span>Barely audible</span>
                <span>Moderate</span>
                <span>Prominent (still ≤ −6 dBFS)</span>
              </div>
            </div>

            {soundMeta.hasBandwidth && (
              <div className="slider-group">
                <div className="slider-header">
                  <label htmlFor="bandwidth-match-slider">Spectral Bandwidth</label>
                  <span className="mono">{bandwidthOct.toFixed(2)} octaves</span>
                </div>
                <input
                  id="bandwidth-match-slider"
                  type="range"
                  min={8}
                  max={200}
                  step={1}
                  value={Math.round(bandwidthOct * 100)}
                  aria-valuetext={`${bandwidthOct.toFixed(2)} octaves`}
                  onChange={(e) => setBandwidthOct(Number(e.target.value) / 100)}
                  className="range-input range-amber"
                  data-testid="bandwidth-match-slider"
                />
                <div className="scale-marks-log mono bandwidth-scale">
                  {[{ value: 0.08, label: '0.08 oct' }, { value: 0.5, label: '0.5 oct' }, { value: 2, label: '2.0 oct' }].map(({ value, label }, index) => (
                    <span key={value} className={`log-tick ${index === 0 ? 'edge-start' : index === 2 ? 'edge-end' : ''}`}
                      data-width-oct={value} style={{ left: `${((value - 0.08) / (2 - 0.08)) * 100}%` }}>
                      {label}
                    </span>
                  ))}
                </div>
                {matchBand && <p className="hint-text" data-testid="match-band-edges">{formatBandEdges(matchBand)}</p>}
              </div>
            )}

            {soundType === 'crickets' && (
              <div className="slider-group">
                <div className="slider-header">
                  <label htmlFor="pulse-rate-slider">Chirp / Pulse Rate</label>
                  <span className="mono">{pulseRateHz} Hz</span>
                </div>
                <input
                  id="pulse-rate-slider"
                  type="range"
                  min={4}
                  max={24}
                  step={1}
                  value={pulseRateHz}
                  aria-valuetext={formatHz(pulseRateHz)}
                  onChange={(e) => setPulseRateHz(Number(e.target.value))}
                  className="range-input range-amber"
                />
              </div>
            )}
          </div>

          <div className="step-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                audioEngine.stop(0.025);
                setStep(3);
              }}
            >
              <ArrowLeft size={16} /> Back
            </button>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={saving}
              onClick={() => void handleSaveDraft(true)}
              data-testid="save-and-view-result"
            >
              <BookmarkCheck size={18} />
              <span>Save Match &amp; See Result Card</span>
            </button>
          </div>
        </section>
      )}

      {/* STEP 5: Result Card (derived from single unified displayMatch) */}
      {step === 5 && (
        <section className="result-hero-card" data-testid="result-card">
          <div className="fingerprint-masthead">
            <span>Sound fingerprint</span>
            <span className="mono">{new Date(displayMatch.createdAt).toLocaleDateString('en-US', {
              day: '2-digit', month: 'short', year: 'numeric',
            })}</span>
          </div>
          <div className="result-badge-row">
            {isSavedCurrent ? (
              <span className="verified-pill" data-testid="result-saved-badge">
                <CheckCircle2 size={14} /> Saved to Private Journal
              </span>
            ) : (
              <span className="draft-pill" data-testid="result-unsaved-badge">
                Unsaved draft — not yet logged to journal
              </span>
            )}
            {displayMatch.octaveVerified && <span className="subtle-pill mono">Octave Checked</span>}
          </div>

          <h2 ref={stepHeading} tabIndex={-1} className="result-headline" data-testid="result-headline">
            {formatMatchHeadline(displayMatch)}
          </h2>

          <div className="result-meta-grid">
            <div className="stat-box">
              <span className="stat-label">Center Pitch</span>
              <strong className="mono" data-testid="result-center-pitch">
                {formatHz(displayMatch.frequencyHz)}
              </strong>
            </div>
            <div className="stat-box">
              <span className="stat-label">Texture</span>
              <strong>{displayMeta.label}</strong>
            </div>
            <div className="stat-box">
              <span className="stat-label">Ear</span>
              <strong className="capitalize">{formatEarLabel(displayMatch.ear)}</strong>
            </div>
            <div className="stat-box">
              <span className="stat-label">{displayMeta.hasBandwidth ? 'Bandwidth' : 'Matched Level'}</span>
              <strong className="mono">
                {displayMeta.hasBandwidth
                  ? `${displayMatch.bandwidthOct.toFixed(2)} oct`
                  : `${displayMatch.loudness}%`}
              </strong>
              {resultBand && <span className="hint-text" data-testid="result-band-edges">{formatBandEdges(resultBand)}</span>}
            </div>
          </div>

          <div className="result-spectrum-wrap">
            <MiniSpectrum
              frequencyHz={displayMatch.frequencyHz}
              soundType={displayMatch.soundType}
              band={resultBand}
            />
          </div>

          <div className="result-actions">
            {!isSavedCurrent && (
              <button
                type="button"
                className="btn btn-amber btn-lg"
                disabled={saving}
                onClick={() => void handleSaveDraft()}
                data-testid="step5-save-match"
              >
                <BookmarkCheck size={18} />
                <span>Save Match to Journal</span>
              </button>
            )}

            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => onGoToRelief(displayMatch, isSavedCurrent)}
              data-testid="result-start-relief"
            >
              <Waves size={18} />
              <span>Open Notched Relief ({formatKhzCompact(displayMatch.frequencyHz)})</span>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              ref={shareTrigger}
              onClick={handleGenerateShareCard}
              data-testid="generate-share-card"
            >
              <Share2 size={16} />
              <span>Create Share Card</span>
            </button>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setStep(3)}
              data-testid="result-refine-pitch"
            >
              Refine Pitch
            </button>
          </div>

          {shareCardUrl && (
            <ShareSheet
              headline={formatShareHeadline(displayMatch)}
              description="Spoiler-free share image ready · No personal details included"
              url={shareCardUrl}
              testId="share-card-preview"
              opener={shareTrigger.current}
              onClose={() => setShareCardUrl(null)}
              onDownload={handleDownloadShareCard}
            />
          )}
        </section>
      )}
    </div>
  );
};
