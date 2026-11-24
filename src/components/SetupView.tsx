import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Headphones,
  ShieldCheck,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { audioEngine, type EngineSnapshot } from '../audio/engine';
import { formatEarLabel } from '../utils/format';
import { handleRadioKeyDown } from '../utils/radioKeyboard';
import { PlaybackError } from './PlaybackError';
import type { EarSide, SetupCalibration } from '../types';

interface SetupViewProps {
  calibration: SetupCalibration;
  engineState: EngineSnapshot;
  onUpdateCalibration: (patch: Partial<SetupCalibration>) => void;
  onProceedToMatch: () => void;
}

export const SetupView: React.FC<SetupViewProps> = ({
  calibration,
  engineState,
  onUpdateCalibration,
  onProceedToMatch,
}) => {
  const [playedSides, setPlayedSides] = useState({ left: false, right: false });
  const [activeSide, setActiveSide] = useState<'left' | 'right' | null>(null);
  const [livePeak, setLivePeak] = useState(-96);
  const [audioError, setAudioError] = useState<{ control: 'chime' | 'bed'; message: string } | null>(null);

  const isCalibrating = engineState.isPlaying && engineState.sourceKind === 'calibration';

  useEffect(() => {
    if (!engineState.isPlaying) {
      setLivePeak(-96);
      return;
    }
    const id = window.setInterval(() => {
      setLivePeak(audioEngine.readCurrentPeakDbfs());
    }, 90);
    return () => window.clearInterval(id);
  }, [engineState.isPlaying]);

  const handleEarTest = async (side: 'left' | 'right') => {
    setAudioError(null);
    try {
      await audioEngine.playEarCheck(side);
      setActiveSide(side);
      window.setTimeout(() => {
        setPlayedSides((previous) => ({ ...previous, [side]: true }));
        setActiveSide((previous) => (previous === side ? null : previous));
      }, 900);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setActiveSide(null);
      setAudioError({
        control: 'chime',
        message: err instanceof Error ? err.message : 'Could not play the headphone chime. Check device sound settings and tap again.',
      });
    }
  };

  const confirmChime = (side: 'left' | 'right') => {
    const leftHeard = side === 'left' || calibration.leftHeard;
    const rightHeard = side === 'right' || calibration.rightHeard;
    onUpdateCalibration({ leftHeard, rightHeard, headphonesChecked: leftHeard && rightHeard });
  };

  const handleToggleCalibration = async () => {
    setAudioError(null);
    if (isCalibrating) {
      audioEngine.stop(0.05);
      return;
    }
    try {
      await audioEngine.startCalibrationTone(calibration.ear);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setAudioError({
        control: 'bed',
        message: err instanceof Error ? err.message : 'Could not start calibration audio. Check device sound settings and tap again.',
      });
    }
  };

  const handleVolumeChange = (val: number) => {
    onUpdateCalibration({ comfortLevel: val });
  };

  const handleEarSelect = (ear: EarSide) => {
    onUpdateCalibration({ ear });
  };

  // Map [-60..-6 dBFS] into 0..100% bar
  const meterPercent = Math.max(0, Math.min(100, ((livePeak + 60) / 54) * 100));

  return (
    <div className="view-stack setup-view">
      <section className="hero-banner" aria-label="Tinnitune introduction">
        <div className="hero-banner-content">
          <div className="eyebrow">Headphone setup</div>
          <h1>Calibrate before you listen</h1>
          <p className="lead">
            Tinnitune runs 100% locally in your browser with a hard brickwall limiter capped at{' '}
            <span className="mono accent-emerald">−6 dBFS</span>. Nothing is recorded or uploaded,
            and all audio stays silent until you tap play.
          </p>
          <div className="hero-pill-strip">
            <span className="hero-meta-pill mono">250 Hz – 18 kHz</span>
            <span className="hero-meta-pill mono">≥ 30 dB Notch Cut</span>
            <span className="hero-meta-pill">100% Private · Offline PWA</span>
          </div>
        </div>
        <figure className="onboard-art">
          <img src="/art/listening-bench.webp" alt="" className="hero-banner-art"
            width={1200} height={800} decoding="async" fetchPriority="high" />
        </figure>
      </section>

      <div className="safety-callout" role="note" aria-label="Medical safety notice">
        <div className="safety-icon">
          <AlertTriangle size={20} />
        </div>
        <div className="safety-body">
          <strong>Not a medical device — when to see a clinician</strong>
          <p>
            Tinnitune is an acoustic self-exploration and sound-enrichment tool. Please consult an
            audiologist or ENT doctor promptly if your tinnitus is <strong>new or sudden</strong>,{' '}
            <strong>one-sided (unilateral)</strong>, <strong>pulsing with your heartbeat</strong>, or
            accompanied by dizziness, ear pain, or hearing loss.
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={calibration.safetyAcknowledged}
              onChange={(e) => onUpdateCalibration({ safetyAcknowledged: e.target.checked })}
              data-testid="safety-ack-checkbox"
            />
            <span>I understand Tinnitune is not a medical device and my headphone volume is set quietly.</span>
          </label>
        </div>
      </div>

      <div className="setup-grid">
        {/* Card 1: Stereo Headphone Check */}
        <article className="panel-card setup-headphones-card">
          <div className="card-head">
            <div className="card-title-group">
              <Headphones size={19} className="accent-teal" />
              <h2>1. Headphones Stereo Check</h2>
            </div>
            {calibration.headphonesChecked && (
              <span className="verified-pill">
                <CheckCircle2 size={14} /> Verified
              </span>
            )}
          </div>
          <p className="card-desc">
            Use wired or Bluetooth headphones in a quiet room so left/right routing and high frequencies
            (up to 18 kHz) are clear. Play each chime, then confirm the side where you heard it.
          </p>

          <div className="ear-check-row">
            <button
              type="button"
              className={`ear-test-btn ${activeSide === 'left' ? 'ringing' : ''} ${
                calibration.leftHeard ? 'heard' : ''
              }`}
              onClick={() => void handleEarTest('left')}
              data-testid="test-left-ear"
            >
              <span className="ear-badge">L</span>
              <span className="ear-btn-label">
                <strong>Test Left Ear</strong>
                <small>{calibration.leftHeard ? 'Confirmed chime' : 'Play 440 Hz chime'}</small>
              </span>
            </button>

            <button
              type="button"
              className={`ear-test-btn ${activeSide === 'right' ? 'ringing' : ''} ${
                calibration.rightHeard ? 'heard' : ''
              }`}
              onClick={() => void handleEarTest('right')}
              data-testid="test-right-ear"
            >
              <span className="ear-badge">R</span>
              <span className="ear-btn-label">
                <strong>Test Right Ear</strong>
                <small>{calibration.rightHeard ? 'Confirmed chime' : 'Play 554 Hz chime'}</small>
              </span>
            </button>
          </div>
          {audioError?.control === 'chime' && <PlaybackError message={audioError.message} testId="setup-audio-error" />}
          <div className="ear-check-row">
            {(['left', 'right'] as const).map((side) =>
              playedSides[side] && !calibration[side === 'left' ? 'leftHeard' : 'rightHeard'] && (
                <button key={side} type="button" className="btn btn-secondary"
                  onClick={() => confirmChime(side)} data-testid={`confirm-${side}-ear`}>
                  I heard the {side} chime
                </button>
              ),
            )}
          </div>
        </article>

        {/* Card 2: Volume Calibration & Limiter */}
        <article className="panel-card">
          <div className="card-head">
            <div className="card-title-group">
              <ShieldCheck size={19} className="accent-emerald" />
              <h2>2. Quiet Volume Calibration</h2>
            </div>
            <span className="mono subtle-pill">Max −6 dBFS</span>
          </div>
          <p className="card-desc">
            Set your device volume low first. Play the gentle pink noise bed below and adjust until it
            sits at a calm, comfortable whisper. The bed plays in {formatEarLabel(calibration.ear)}.
          </p>

          <div className="cal-controls">
            <button
              type="button"
              className={`btn ${isCalibrating ? 'btn-amber' : 'btn-primary'}`}
              onClick={() => void handleToggleCalibration()}
              data-testid="toggle-calibration-audio"
            >
              {isCalibrating ? <VolumeX size={17} /> : <Volume2 size={17} />}
              <span>{isCalibrating ? 'Stop Calibration Bed' : 'Play Calibration Bed'}</span>
            </button>

            {audioError?.control === 'bed' && <PlaybackError message={audioError.message} testId="setup-audio-error" />}
            <div className="slider-group">
              <div className="slider-header">
                <label htmlFor="comfort-slider">Master Comfort Level</label>
                <span className="mono">{Math.round(calibration.comfortLevel * 100)}%</span>
              </div>
              <input
                id="comfort-slider"
                type="range"
                min={10}
                max={100}
                step={1}
                value={Math.round(calibration.comfortLevel * 100)}
                onChange={(e) => handleVolumeChange(Number(e.target.value) / 100)}
                className="range-input"
                data-testid="comfort-volume-slider"
              />
            </div>

            <div className="limiter-meter" aria-label="Output safety level meter">
              <div className="meter-labels">
                <span>Live Output</span>
                <span className="mono">
                  {livePeak > -90 ? `${livePeak.toFixed(1)} dBTP` : 'Silent'} · Hard ceiling −6.0 dBFS
                </span>
              </div>
              <div className="meter-track">
                <div className="meter-fill" style={{ width: `${meterPercent}%` }} />
                <div className="meter-ceiling" title="Hard safety ceiling at −6 dBFS" />
              </div>
            </div>
          </div>
        </article>
      </div>

      {/* Card 3: Ear Selection + Proceed */}
      <article className="panel-card">
        <div className="ear-select-layout">
          <div>
            <h2>3. Which ear do you hear tinnitus in?</h2>
            <p className="card-desc">
              We route matching sounds to your chosen ear (you can change this anytime). If your
              tinnitus is strictly one-sided and newly developed, remember to check in with an ENT or
              audiologist.
            </p>
          </div>

          <div className="segmented-control" role="radiogroup" aria-label="Affected ear selection" onKeyDown={handleRadioKeyDown}>
            {(['left', 'both', 'right'] as EarSide[]).map((side) => (
              <button
                key={side}
                type="button"
                role="radio"
                aria-checked={calibration.ear === side}
                tabIndex={calibration.ear === side ? 0 : -1}
                className={`seg-btn ${calibration.ear === side ? 'active' : ''}`}
                onClick={() => handleEarSelect(side)}
                data-testid={`select-ear-${side}`}
              >
                {side === 'left' ? 'Left Ear' : side === 'right' ? 'Right Ear' : 'Both Ears'}
              </button>
            ))}
          </div>
        </div>

        <div className="setup-footer">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={onProceedToMatch}
            disabled={!calibration.safetyAcknowledged}
            data-testid="start-matching-btn"
          >
            <span>Start Matching Your Sound</span>
            <ArrowRight size={18} />
          </button>
        </div>
      </article>
    </div>
  );
};
