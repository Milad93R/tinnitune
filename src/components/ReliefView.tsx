import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  Disc3,
  FolderOpen,
  Lock,
  Music,
  Pause,
  Play,
  Sliders,
  Sparkles,
  Square,
  Timer,
  Waves,
} from 'lucide-react';
import { designDigitalBandpass, designDigitalNotch, freqToNorm, MAX_FREQ_HZ, MIN_FREQ_HZ, normToFreq, RI_BANDWIDTH_OCT } from '../audio/dsp';
import { audioEngine, BUILTIN_SAMPLE_DURATION_SEC, type EngineSnapshot, type PlaybackStopReason, type RIMaskTiming } from '../audio/engine';
import { clearSessionCheckpoint, loadReliefRoute, makeId, saveReliefRoute, saveSessionCheckpoint } from '../storage/db';
import {
  RELIEF_NOISE_META,
  type EarSide,
  type ReliefNoiseType,
  type ReliefSubMode,
  type ResidualInhibitionRecord,
  type SessionFilter,
  type TherapySessionRecord,
  type TinnitusMatch,
} from '../types';
import { formatBandEdges, formatClock, formatEarLabel, formatHz, formatKhzCompact } from '../utils/format';
import { handleRadioKeyDown } from '../utils/radioKeyboard';
import { PlaybackError } from './PlaybackError';
import { NotchGarden } from './NotchGarden';
import { SpectrumVisualizer } from './SpectrumVisualizer';

export type ReliefMatchSelection = { match: TinnitusMatch | null; saved: true } | {
  match: TinnitusMatch | null;
  saved: false;
  previous: TinnitusMatch | null;
};

interface ReliefViewProps {
  selection: ReliefMatchSelection;
  onSaveMatch: (match: TinnitusMatch) => Promise<void>;
  onSelectSavedMatch: (match: TinnitusMatch) => void;
  defaultEar: EarSide;
  engineState: EngineSnapshot;
  onLogRITest: (record: ResidualInhibitionRecord) => Promise<void>;
  onLogSession: (record: TherapySessionRecord) => Promise<void>;
  onGoToMatch: () => void;
  onReviewSetup?: () => void;
  onNotify: (msg: string) => void;
}

const NOISE_TYPES: ReliefNoiseType[] = ['rain', 'pink', 'brown', 'ocean', 'white'];
const TIMER_PRESETS = [15, 30, 45, 60];
const RELIEF_TOOLS = [
  { id: 'therapy', label: 'Notched Sound', icon: Waves },
  { id: 'music', label: 'Notch Your Music', icon: Music },
  { id: 'ri', label: 'Residual Inhibition', icon: Timer },
] as const;

// Safari and iOS browsers use Web Audio's decoded buffer, avoiding WebKit's Blob media pipeline.
const STREAM_LOCAL_FILES = !/AppleWebKit\//.test(navigator.userAgent) || /Chrom(?:e|ium)\//.test(navigator.userAgent);

type RIPhase = 'ready' | 'masking' | 'listening' | 'done';
type MusicSourceMode = 'none' | 'builtin' | 'file';
type RunningSession = Omit<TherapySessionRecord, 'durationSeconds' | 'endReason' | 'filterSegments'> & {
  startedAt: number | null;
  elapsedMs: number;
  filterChanges: { atMs: number; filter: SessionFilter; noiseType?: ReliefNoiseType }[];
};
const elapsedPlaybackMs = (session: RunningSession) =>
  session.elapsedMs + (session.startedAt === null ? 0 : performance.now() - session.startedAt);

const sessionFilter = (enabled: boolean, frequencyHz: number, notchWidthOct: number): SessionFilter =>
  enabled ? { state: 'notched', frequencyHz, notchWidthOct } : { state: 'bypassed' };

const notchCeilingHz = (sampleRate: number) => Math.min(MAX_FREQ_HZ, Math.floor(sampleRate * 0.49));

function recordFilterChange(
  session: RunningSession,
  filter: SessionFilter,
  atMs = elapsedPlaybackMs(session),
  noiseType = session.filterChanges.at(-1)?.noiseType,
) {
  const previous = session.filterChanges.at(-1);
  if (noiseType === previous?.noiseType && filter.state === previous?.filter.state &&
    (filter.state === 'bypassed' || (previous.filter.state === 'notched' &&
      filter.frequencyHz === previous.filter.frequencyHz && filter.notchWidthOct === previous.filter.notchWidthOct))) return;
  session.filterChanges.push({ atMs: Math.round(atMs), filter, noiseType });
}

function sessionRecord(session: RunningSession, endReason: NonNullable<TherapySessionRecord['endReason']>) {
  const elapsed = Math.round(elapsedPlaybackMs(session));
  if (elapsed < 15000) return;
  const { startedAt, elapsedMs, filterChanges, ...record } = session;
  const filterSegments = filterChanges.flatMap(({ atMs, filter, noiseType }, index) => {
    const end = Math.min(filterChanges[index + 1]?.atMs ?? elapsed, elapsed);
    return end > atMs ? [{ ...filter, ...(noiseType ? { noiseType } : {}), durationSeconds: (end - atMs) / 1000 }] : [];
  });
  return { ...record, durationSeconds: Math.round(elapsed / 1000), filterSegments, endReason };
}
type RITest = Pick<ResidualInhibitionRecord, 'id' | 'frequencyHz' | 'ear'>;

export const ReliefView: React.FC<ReliefViewProps> = ({
  selection,
  onSaveMatch,
  onSelectSavedMatch,
  defaultEar,
  engineState,
  onLogRITest,
  onLogSession,
  onGoToMatch,
  onReviewSetup,
  onNotify,
}) => {
  const [subMode, setSubMode] = useState<ReliefSubMode>('therapy');
  const [gardenTransport, setGardenTransport] = useState(() => window.matchMedia('(max-width: 530px)').matches);
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 530px)');
    const onChange = () => setGardenTransport(phone.matches);
    phone.addEventListener('change', onChange);
    return () => phone.removeEventListener('change', onChange);
  }, []);
  const activeMatch = selection.match;
  const previousMatch = selection.saved ? null : selection.previous;

  // Shared notch controls initialized from activeMatch
  const [requestedCenterHz, setRequestedCenterHz] = useState<number>(activeMatch?.frequencyHz ?? 6350);
  const maxCenterHz = notchCeilingHz(engineState.sampleRate);
  const centerHz = Math.min(requestedCenterHz, maxCenterHz);
  const [notchWidthOct, setNotchWidthOct] = useState<number>(1.0);
  const notch = useMemo(
    () => designDigitalNotch(centerHz, notchWidthOct, engineState.sampleRate),
    [centerHz, notchWidthOct, engineState.sampleRate],
  );
  const [notchEnabled, setNotchEnabled] = useState<boolean>(true);
  const [route, setRoute] = useState(loadReliefRoute);
  const matchId = activeMatch?.id ?? null;
  const matchEar = activeMatch?.ear ?? defaultEar;
  const ear = route?.matchId === matchId ? route.ear : matchEar;
  const [audioError, setAudioError] = useState<{ control: string; message: string } | null>(null);

  useEffect(() => {
    if (activeMatch) {
      setRequestedCenterHz(activeMatch.frequencyHz);
    }
  }, [activeMatch?.id, activeMatch?.frequencyHz]);

  const selectOutputEar = (side: EarSide) => {
    const next = side === matchEar ? null : { matchId, ear: side };
    setRoute(next);
    saveReliefRoute(next);
    audioEngine.setEar(side);
  };

  // --- Sub-mode A: Notched Sound Therapy ---
  const [noiseType, setNoiseType] = useState<ReliefNoiseType>('rain');
  const [therapyVolume, setTherapyVolume] = useState<number>(0.72);
  const [sessionMinutes, setSessionMinutes] = useState<number>(30);
  const [remainingSec, setRemainingSec] = useState<number>(30 * 60);
  const sessionRef = useRef<RunningSession | null>(null);
  const [isTherapyPaused, setIsTherapyPaused] = useState(false);
  const therapyControls = useRef({ minutes: sessionMinutes, volume: therapyVolume });
  const transportRequest = useRef(0);
  const maskRun = useRef<(RITest & { timing: RIMaskTiming }) | null>(null);
  const quietRun = useRef<(RITest & { stimulusSeconds: number; quietSince: number }) | null>(null);

  const isTherapyPlaying = engineState.isPlaying && engineState.sourceKind === 'relief-noise';

  const currentFilter = useRef({ centerHz, notchWidthOct, notchEnabled });
  useLayoutEffect(() => {
    currentFilter.current = { centerHz, notchWidthOct, notchEnabled };
    const session = sessionRef.current;
    if (!session || session.startedAt === null) return;
    audioEngine.updateActiveNotch(centerHz, notchWidthOct, notchEnabled);
    recordFilterChange(session, sessionFilter(notchEnabled, centerHz, notchWidthOct));
  }, [centerHz, notchWidthOct, notchEnabled]);

  const syncStartedFilter = (session: RunningSession, bed?: ReliefNoiseType) => {
    const next = currentFilter.current;
    if (next.centerHz !== centerHz || next.notchWidthOct !== notchWidthOct || next.notchEnabled !== notchEnabled) {
      audioEngine.updateActiveNotch(next.centerHz, next.notchWidthOct, next.notchEnabled);
    }
    const actualCenterHz = Math.min(next.centerHz, notchCeilingHz(audioEngine.getSnapshot().sampleRate));
    recordFilterChange(session, sessionFilter(next.notchEnabled, actualCenterHz, next.notchWidthOct),
      elapsedPlaybackMs(session), bed);
  };

  useEffect(() => {
    if (!isTherapyPlaying) return;
    const tick = () => {
      const session = sessionRef.current;
      if (!session || audioEngine.getSnapshot().sourceKind !== 'relief-noise') return;
      const leftMs = Math.max(0, sessionMinutes * 60000 - elapsedPlaybackMs(session));
      setRemainingSec(Math.ceil(leftMs / 1000));
      if (leftMs === 0) {
        session.elapsedMs = sessionMinutes * 60000;
        session.startedAt = null;
        audioEngine.stop(0.04, 'completed');
      }
    };
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [isTherapyPlaying, sessionMinutes]);

  const applyTherapyTiming = (minutes: number, volume: number, attack?: number) => {
    const session = sessionRef.current;
    const seconds = Math.max(0, (minutes * 60000 - (session ? elapsedPlaybackMs(session) : 0)) / 1000);
    setRemainingSec(Math.ceil(seconds));
    audioEngine.setTherapyTiming(volume, seconds, attack);
  };

  const selectTimer = (minutes: number) => {
    therapyControls.current.minutes = minutes;
    setSessionMinutes(minutes);
    const session = sessionRef.current;
    if (session?.mode === 'notched-noise' && elapsedPlaybackMs(session) >= minutes * 60000) {
      audioEngine.stop(0.04, 'completed');
      setRemainingSec(0);
      return;
    }
    applyTherapyTiming(minutes, therapyVolume);
  };

  const handleToggleTherapy = async () => {
    setAudioError(null);
    if (isTherapyPlaying) {
      audioEngine.stop(0.12, 'paused');
      return;
    }

    try {
      await audioEngine.startNotchedNoise({
        noiseType,
        centerHz,
        notchWidthOct,
        notchEnabled,
        volume: therapyVolume,
        ear,
      });
      const startedAt = performance.now();
      const paused = sessionRef.current;
      const actualCenterHz = Math.min(centerHz, notchCeilingHz(audioEngine.getSnapshot().sampleRate));
      const session: RunningSession = paused?.mode === 'notched-noise'
        ? { ...paused, startedAt }
        : {
          id: makeId('sess'), createdAt: Date.now(), startedAt, elapsedMs: 0, mode: 'notched-noise',
          noiseType, frequencyHz: actualCenterHz, notchWidthOct, filterChanges: [],
        };
      recordFilterChange(session, sessionFilter(notchEnabled, actualCenterHz, notchWidthOct), session.elapsedMs, noiseType);
      syncStartedFilter(session);
      sessionRef.current = session;
      setIsTherapyPaused(false);
      applyTherapyTiming(therapyControls.current.minutes, therapyControls.current.volume, 0.14);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setAudioError({
        control: 'therapy',
        message: err instanceof Error ? err.message : 'Could not start notched sound therapy. Check sound settings and tap again.',
      });
    }
  };

  const handleChangeNoise = async (next: ReliefNoiseType) => {
    setAudioError(null);
    setNoiseType(next);
    if (isTherapyPlaying) {
      try {
        await audioEngine.startNotchedNoise({
          noiseType: next,
          centerHz,
          notchWidthOct,
          notchEnabled,
          volume: therapyVolume,
          ear,
        }, true);
        if (sessionRef.current) syncStartedFilter(sessionRef.current, next);
        applyTherapyTiming(therapyControls.current.minutes, therapyControls.current.volume, 0.14);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setAudioError({
          control: next,
          message: err instanceof Error ? err.message : 'Could not switch therapy sound bed. Check sound settings and tap again.',
        });
      }
    }
  };

  // --- Sub-mode B: Notch Your Own Music ---
  // Persistent <audio> element stays mounted across Relief sub-tab switches (prevents orphaned MediaElementSource)
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedFileRef = useRef<File | null>(null);
  const decodedBufferRef = useRef<AudioBuffer | null>(null);

  const [musicSourceMode, setMusicSourceMode] = useState<MusicSourceMode>('none');
  const [trackName, setTrackName] = useState<string>('');
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  const [musicVolume, setMusicVolume] = useState<number>(0.78);
  const [musicCurrentTime, setMusicCurrentTime] = useState<number>(0);
  const [musicDuration, setMusicDuration] = useState<number>(0);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [repeatMusic, setRepeatMusic] = useState(false);
  const repeatMusicRef = useRef(false);

  const isMusicPlaying = engineState.isPlaying && engineState.sourceKind === 'relief-music';
  const hasMusicLoaded = musicSourceMode !== 'none';
  const canReplay = musicDuration > 0 && musicCurrentTime >= musicDuration;

  const selectRepeat = (repeat: boolean) => {
    repeatMusicRef.current = repeat;
    setRepeatMusic(repeat);
    audioEngine.setBufferMusicRepeat(repeat);
  };

  useEffect(() => {
    if (!isTherapyPlaying && !isMusicPlaying && !isTherapyPaused) return;
    const checkpoint = (scope: 'tab' | 'device') => {
      const session = sessionRef.current;
      if (!session || (scope === 'tab' && session.startedAt === null)) return;
      const record = sessionRecord(session, 'interrupted');
      if (record) saveSessionCheckpoint(record, scope);
    };
    const onVisibilityChange = () => {
      if (document.hidden) checkpoint('device');
    };
    const id = isTherapyPlaying || isMusicPlaying ? window.setInterval(() => checkpoint('tab'), 1000) : undefined;
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isTherapyPlaying, isMusicPlaying, isTherapyPaused]);

  const prevBlobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioElRef.current) {
        audioElRef.current.pause();
      }
      if (prevBlobUrlRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(prevBlobUrlRef.current);
      }
    };
  }, []);

  // Poll buffer-backed playback position for the built-in ambient sample or decoded fallback
  useEffect(() => {
    if (!isMusicPlaying) return;
    if (musicSourceMode !== 'builtin' && !decodedBufferRef.current) return;
    const id = window.setInterval(() => {
      setMusicCurrentTime(audioEngine.getBufferMusicTime());
    }, 500);
    return () => window.clearInterval(id);
  }, [isMusicPlaying, musicSourceMode]);

  const stopTransport = (fade: number, reason: PlaybackStopReason) => {
    transportRequest.current++;
    audioEngine.stop(fade, reason);
  };

  const startMusicSession = () => {
    const actualCenterHz = Math.min(centerHz, notchCeilingHz(audioEngine.getSnapshot().sampleRate));
    const session: RunningSession = {
      id: makeId('sess'), createdAt: Date.now(), startedAt: performance.now(), elapsedMs: 0, mode: 'notched-music',
      trackName: trackName || 'Local audio', frequencyHz: actualCenterHz, notchWidthOct, filterChanges: [],
    };
    recordFilterChange(session, sessionFilter(notchEnabled, actualCenterHz, notchWidthOct), 0);
    syncStartedFilter(session);
    sessionRef.current = session;
  };

  const loadLocalFileTrack = (file: File) => {
    setMusicError(null);
    stopTransport(0.03, 'replaced');
    const url = STREAM_LOCAL_FILES ? URL.createObjectURL(file) : null;
    const oldUrl = prevBlobUrlRef.current;
    prevBlobUrlRef.current = url;
    loadedFileRef.current = file;
    decodedBufferRef.current = null;
    setMusicSourceMode('file');
    selectRepeat(false);
    setTrackUrl(url);
    setTrackName(file.name);
    setMusicCurrentTime(0);
    setMusicDuration(0);
    if (audioElRef.current) {
      audioElRef.current.pause();
      if (url) audioElRef.current.src = url;
    }
    if (oldUrl && oldUrl !== url && oldUrl.startsWith('blob:')) {
      window.setTimeout(() => URL.revokeObjectURL(oldUrl), 1000);
    }
  };

  const handleFilePicked = (file: File | undefined) => {
    if (!file) return;
    if (file.size === 0) {
      setMusicError('This audio file is empty. Choose a file with a playable track.');
      return;
    }
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file.name)) {
      setMusicError('Please choose an audio file (MP3, WAV, M4A, OGG, or FLAC).');
      return;
    }
    loadLocalFileTrack(file);
    onNotify('Audio file loaded locally');
  };

  const handleLoadBuiltInSample = () => {
    setMusicError(null);
    stopTransport(0.03, 'replaced');
    loadedFileRef.current = null;
    decodedBufferRef.current = null;
    setMusicSourceMode('builtin');
    selectRepeat(true);
    setTrackUrl(null);
    setTrackName('Nocturne Dmaj9 Ambient Sample (Built-in)');
    setMusicCurrentTime(0);
    setMusicDuration(BUILTIN_SAMPLE_DURATION_SEC);
    onNotify('Loaded built-in ambient audio sample');
  };

  const handleToggleMusicPlay = async () => {
    if (!hasMusicLoaded) return;
    if (isMusicPlaying) {
      if (musicSourceMode === 'builtin' || decodedBufferRef.current) setMusicCurrentTime(audioEngine.getBufferMusicTime());
      stopTransport(0.06, 'paused');
      return;
    }

    setMusicError(null);
    const request = ++transportRequest.current;
    const offset = canReplay ? 0 : musicCurrentTime;
    if (canReplay) setMusicCurrentTime(0);
    try {
      if (musicSourceMode === 'builtin') {
        const dur = await audioEngine.startBuiltInSample(
          offset,
          centerHz,
          notchWidthOct,
          notchEnabled,
          musicVolume,
          { repeat: repeatMusicRef.current },
        );
        if (request !== transportRequest.current) return;
        audioEngine.setBufferMusicRepeat(repeatMusicRef.current);
        setMusicDuration(dur);
        startMusicSession();
        return;
      }

      const file = loadedFileRef.current;
      if (!file) return;
      const el = audioElRef.current;
      if (el && trackUrl && !decodedBufferRef.current) {
        try {
          if (canReplay || el.ended) el.currentTime = 0;
          await audioEngine.attachAndPlayMusicElement(el, centerHz, notchWidthOct, notchEnabled, musicVolume);
          if (request === transportRequest.current) startMusicSession();
          return;
        } catch (error) {
          if (request !== transportRequest.current || (error instanceof DOMException && error.name === 'AbortError')) return;
          // Some formats can be decoded by Web Audio when the streaming media element fails.
        }
      }

      const decoded = decodedBufferRef.current ?? await audioEngine.decodeFileToBuffer(file);
      if (request !== transportRequest.current || loadedFileRef.current !== file) return;
      decodedBufferRef.current = decoded;
      const dur = await audioEngine.startDecodedMusicBuffer(
        decoded, offset, centerHz, notchWidthOct, notchEnabled, musicVolume, { repeat: repeatMusicRef.current },
      );
      if (request !== transportRequest.current) return;
      audioEngine.setBufferMusicRepeat(repeatMusicRef.current);
      setMusicDuration(dur);
      startMusicSession();
    } catch (err) {
      if (request !== transportRequest.current || (err instanceof DOMException && err.name === 'AbortError')) return;
      setMusicError(
        err instanceof Error
          ? err.message
          : 'Could not decode or play this audio file in your browser.'
      );
    }
  };

  const handleMusicSeek = async (nextSec: number) => {
    setMusicCurrentTime(nextSec);
    setMusicError(null);
    const request = transportRequest.current;
    try {
      const element = audioElRef.current;
      if (musicSourceMode === 'file' && trackUrl && !decodedBufferRef.current && element) {
        element.currentTime = nextSec;
        return;
      }
      if (!isMusicPlaying) return;
      const options = { continuing: true, repeat: repeatMusicRef.current };
      if (musicSourceMode === 'builtin') {
        await audioEngine.startBuiltInSample(nextSec, centerHz, notchWidthOct, notchEnabled, musicVolume, options);
      } else if (decodedBufferRef.current) {
        await audioEngine.startDecodedMusicBuffer(
          decodedBufferRef.current, nextSec, centerHz, notchWidthOct, notchEnabled, musicVolume, options,
        );
      }
      audioEngine.setBufferMusicRepeat(repeatMusicRef.current);
      if (sessionRef.current) syncStartedFilter(sessionRef.current);
    } catch (err) {
      if (request !== transportRequest.current || (err instanceof DOMException && err.name === 'AbortError')) return;
      setMusicError(err instanceof Error ? err.message : 'Could not seek to that part of the track. Try again.');
    }
  };

  // --- Sub-mode C: Residual-Inhibition (RI) Test ---
  const [riDurationSec, setRiDurationSec] = useState<number>(60);
  const [riPhase, setRiPhase] = useState<RIPhase>('ready');
  const [riMaskLeftSec, setRiMaskLeftSec] = useState<number>(60);
  const [riElapsedMs, setRiElapsedMs] = useState<number>(0);
  const [riLastResult, setRiLastResult] = useState<ResidualInhibitionRecord | null>(null);
  const riResponse = useRef<HTMLDivElement>(null);
  const riReturnedButton = useRef<HTMLButtonElement>(null);
  const savingMatch = useRef(false);
  const [riSavingMatch, setRiSavingMatch] = useState(false);
  const riMatch = (riPhase === 'ready' ? null : maskRun.current ?? quietRun.current ?? riLastResult) ?? activeMatch;
  const riFrequency = riMatch?.frequencyHz;
  const riBand = useMemo(() => !selection.saved || riFrequency === undefined ? undefined
    : designDigitalBandpass(riFrequency, RI_BANDWIDTH_OCT, engineState.sampleRate),
    [selection.saved, riFrequency, engineState.sampleRate]);

  const handleSaveRIMatch = async () => {
    if (selection.saved || !selection.match || savingMatch.current) return;
    savingMatch.current = true;
    setRiSavingMatch(true);
    setAudioError(null);
    try {
      await onSaveMatch(selection.match);
    } catch {
      setAudioError({ control: 'ri-save', message: 'Could not save the match. Try again.' });
    } finally {
      savingMatch.current = false;
      setRiSavingMatch(false);
    }
  };

  useEffect(() => {
    const finishPlayback = (kind: string, reason: PlaybackStopReason) => {
      if (reason === 'continued') return;
      transportRequest.current++;
      if (kind === 'relief-music' && reason === 'completed') setMusicCurrentTime(musicDuration);
      if (kind === 'ri-stimulus' && reason !== 'completed') {
        maskRun.current = null;
        setRiMaskLeftSec(riDurationSec);
        setRiPhase('ready');
      }
      const session = sessionRef.current;
      if (!session) return;
      const pausedTherapy = session.mode === 'notched-noise' && session.startedAt === null;
      if (kind !== 'relief-noise' && kind !== 'relief-music' && !(kind === 'idle' && pausedTherapy)) return;
      const elapsed = elapsedPlaybackMs(session);
      if (kind === 'relief-noise' && reason === 'paused') {
        session.elapsedMs = elapsed;
        session.startedAt = null;
        const record = sessionRecord(session, 'interrupted');
        if (record) saveSessionCheckpoint(record);
        setIsTherapyPaused(true);
        setRemainingSec(Math.max(0, Math.ceil(sessionMinutes * 60 - elapsed / 1000)));
        return;
      }
      sessionRef.current = null;
      if (session.mode === 'notched-noise') {
        setIsTherapyPaused(false);
        setRemainingSec(reason === 'completed' ? 0 : sessionMinutes * 60);
      }
      const record = sessionRecord(session, reason);
      if (!record) return;
      if (reason === 'interrupted') {
        saveSessionCheckpoint(record, 'device');
        return;
      }
      saveSessionCheckpoint(record);
      void onLogSession(record)
        .then(() => {
          clearSessionCheckpoint(record.id);
          if (reason === 'completed' && kind === 'relief-noise') onNotify('Therapy session complete and logged');
        })
        .catch(() => onNotify('Could not save the therapy session'));
    };
    return audioEngine.subscribeToStop(finishPlayback);
  }, [onLogSession, onNotify, riDurationSec, sessionMinutes, musicDuration]);

  useEffect(() => {
    if (riPhase !== 'masking') return;
    const run = maskRun.current;
    if (!run) return;
    const id = window.setInterval(() => {
      if (maskRun.current !== run) return;
      const { timing, ...test } = run;
      const remaining = timing.endsAt - timing.currentTime();
      setRiMaskLeftSec(Math.ceil(Math.max(0, remaining)));
      if (remaining > 0) return;
      const lateMs = -remaining * 1000;
      quietRun.current = {
        ...test,
        stimulusSeconds: Math.round((timing.endsAt - timing.startedAt) * 10) / 10,
        quietSince: performance.now() - lateMs,
      };
      maskRun.current = null;
      setRiElapsedMs(lateMs);
      setRiPhase('listening');
    }, 100);
    return () => window.clearInterval(id);
  }, [riPhase]);

  useLayoutEffect(() => {
    if (riPhase !== 'listening') return;
    riReturnedButton.current?.focus({ preventScroll: true });
    riResponse.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [riPhase]);

  useEffect(() => {
    if (riPhase !== 'listening') return;
    const id = window.setInterval(() => {
      if (quietRun.current) setRiElapsedMs(Math.max(0, performance.now() - quietRun.current.quietSince));
    }, 100);
    return () => window.clearInterval(id);
  }, [riPhase]);

  const handleStartRI = async () => {
    if (!selection.saved || !activeMatch) return;
    const { frequencyHz, ear } = activeMatch;
    setAudioError(null);
    setRiLastResult(null);
    try {
      const timing = await audioEngine.startResidualInhibitionStimulus(frequencyHz, ear, 0.72, riDurationSec);
      maskRun.current = { id: makeId('ri'), frequencyHz, ear, timing };
      setRiMaskLeftSec(riDurationSec);
      setRiPhase('masking');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setRiPhase('ready');
      setAudioError({
        control: 'ri-start',
        message: err instanceof Error ? err.message : 'Could not start residual inhibition stimulus. Check sound settings and tap again.',
      });
    }
  };

  const resetRI = () => {
    maskRun.current = null;
    quietRun.current = null;
    setRiPhase('ready');
    setRiMaskLeftSec(riDurationSec);
    setRiElapsedMs(0);
  };

  const handleAbortRI = () => {
    stopTransport(0.08, 'paused');
    resetRI();
  };

  const handleSelectMode = (mode: ReliefSubMode) => {
    if (mode === subMode) return;
    setMusicError(null);
    stopTransport(0.05, 'left');
    resetRI();
    setAudioError(null);
    setSubMode(mode);
  };

  const handleFinishRI = async (noEffect = false) => {
    const run = quietRun.current;
    if (!run) return;
    quietRun.current = null;
    const seconds = noEffect ? 0 : Math.max(0, Math.round((performance.now() - run.quietSince) / 100) / 10);
    const rec: ResidualInhibitionRecord = {
      id: run.id,
      createdAt: Date.now(),
      frequencyHz: run.frequencyHz,
      stimulusSeconds: run.stimulusSeconds,
      reliefSeconds: seconds,
      ear: run.ear,
    };
    try {
      await onLogRITest(rec);
      setRiLastResult(rec);
      setRiPhase('done');
      onNotify(seconds > 0 ? `Logged ${seconds}s of residual inhibition` : 'Logged residual inhibition test (no quiet period)');
    } catch {
      quietRun.current = run;
      setAudioError({ control: 'ri-result', message: 'Could not save the residual inhibition result. Try again.' });
    }
  };

  const errorAt = (control: string) => audioError?.control === control
    ? <PlaybackError message={audioError.message} testId="relief-audio-error" onReviewSetup={onReviewSetup} />
    : null;

  const activeIsReliefPlaying = isTherapyPlaying || isMusicPlaying;
  const therapyTransportLabel = `${isTherapyPlaying ? 'Pause' : isTherapyPaused ? 'Resume' : 'Start'} ${RELIEF_NOISE_META[noiseType].label}`;
  const therapyTransportDetail = notchEnabled ? ' Notched Therapy' : ' (Bypassed)';
  const therapyTransport = (
    <button
      type="button"
      className={`btn ${gardenTransport ? 'btn-sm garden-transport' : 'btn-lg'} ${isTherapyPlaying ? 'btn-amber' : gardenTransport ? 'btn-secondary' : 'btn-primary'}`}
      onClick={() => void handleToggleTherapy()}
      aria-label={therapyTransportLabel + therapyTransportDetail}
      data-testid="therapy-play-toggle"
    >
      {isTherapyPlaying ? <Pause size={16} /> : <Play size={16} />}
      <span>{therapyTransportLabel}{!gardenTransport && therapyTransportDetail}</span>
    </button>
  );

  const riMaskProgress =
    riDurationSec > 0 ? Math.max(0, Math.min(1, (riDurationSec - riMaskLeftSec) / riDurationSec)) : 0;

  return (
    <div className="view-stack relief-view">
      {/* Persistent audio element mounted across sub-tabs to prevent orphaned MediaElementSourceNode */}
      <audio
        ref={audioElRef}
        loop={repeatMusic}
        onTimeUpdate={(e) => {
          if (musicSourceMode === 'file' && !decodedBufferRef.current) {
            setMusicCurrentTime(e.currentTarget.currentTime);
          }
        }}
        onLoadedMetadata={(e) => {
          if (musicSourceMode === 'file') {
            setMusicDuration(e.currentTarget.duration || 0);
          }
        }}
      />

      <div className="section-head-row">
        <div>
          <div className="eyebrow">Relief</div>
          <h1>Notched Sound &amp; Residual Inhibition</h1>
        </div>

        {subMode !== 'ri' && !activeMatch && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onGoToMatch}>
            Match pitch first →
          </button>
        )}
      </div>

      {/* Sub-mode Switcher */}
      <div className="submode-tabs" role="tablist" aria-label="Relief tools" onKeyDown={(event) => {
        const current = RELIEF_TOOLS.findIndex(({ id }) => id === subMode);
        const count = RELIEF_TOOLS.length;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
          : event.key === 'ArrowLeft' ? (current + count - 1) % count
          : event.key === 'ArrowRight' ? (current + 1) % count : -1;
        if (next < 0) return;
        event.preventDefault();
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        handleSelectMode(RELIEF_TOOLS[next].id);
      }}>
        {RELIEF_TOOLS.map(({ id, label, icon: Icon }) => (
          <button key={id} id={`relief-tab-${id}`} type="button" role="tab"
            aria-selected={subMode === id} aria-controls={`relief-panel-${id}`} tabIndex={subMode === id ? 0 : -1}
            className={`subtab-btn ${subMode === id ? 'active' : ''}`}
            onClick={() => handleSelectMode(id)} data-testid={`relief-tab-${id}`}>
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {RELIEF_TOOLS.filter(({ id }) => id !== subMode).map(({ id }) => (
        <div key={id} role="tabpanel" id={`relief-panel-${id}`} aria-labelledby={`relief-tab-${id}`} hidden />
      ))}
      <div className="relief-tool" role="tabpanel" id={`relief-panel-${subMode}`} aria-labelledby={`relief-tab-${subMode}`} tabIndex={0}>
      {subMode !== 'ri' && (
        <>
          <NotchGarden notch={notch} enabled={notchEnabled} playing={activeIsReliefPlaying}
            captionAction={subMode === 'therapy' && gardenTransport ? therapyTransport : undefined} />
          {subMode === 'therapy' && gardenTransport && errorAt('therapy')}
          <SpectrumVisualizer
            isPlaying={activeIsReliefPlaying}
            markerHz={notchEnabled ? notch.centerHz : centerHz}
            markerLabel={notchEnabled
              ? `Notch ${formatKhzCompact(notch.centerHz)}`
              : `Bypassed (${formatKhzCompact(centerHz)})`}
            notchEnabled={notchEnabled}
            notch={notch}
            height={127}
            caption={notchEnabled
              ? `${notchWidthOct.toFixed(1)} oct at −3 dB · ${formatKhzCompact(notch.lowHz)}–${formatKhzCompact(notch.highHz)} · ≥ 30 dB at center`
              : 'Notch bypassed (full unfiltered spectrum)'}
          />
        </>
      )}

      {/* Shared Notch Parameters Strip (for Therapy & Music) */}
      {subMode !== 'ri' && (
        <section className="panel-card compact-card">
          <div className="notch-strip">
            <div className="notch-strip-main">
              <div className="notch-toggle-row">
                <div className="card-title-group">
                  <Sliders size={17} className="accent-teal" />
                  <strong>Notch Filter</strong>
                  <span className="mono accent-amber">{formatHz(centerHz)}</span>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={notchEnabled}
                  className={`switch-pill ${notchEnabled ? 'on' : 'off'}`}
                  onClick={() => setNotchEnabled((v) => !v)}
                  data-testid="notch-bypass-toggle"
                >
                  <span className="switch-knob" />
                  <span>{notchEnabled ? 'Notch Active' : 'Bypassed'}</span>
                </button>
              </div>

              <div className="notch-controls-grid">
                <div className="slider-group">
                  <div className="slider-header">
                    <label htmlFor="notch-center-slider">Notch Center Frequency</label>
                    <span className="mono">{formatKhzCompact(centerHz)}</span>
                  </div>
                  <input
                    id="notch-center-slider"
                    type="range"
                    min={0}
                    max={1000}
                    value={Math.round(freqToNorm(centerHz, MIN_FREQ_HZ, maxCenterHz) * 1000)}
                    aria-valuetext={formatHz(centerHz)}
                    aria-describedby={requestedCenterHz > maxCenterHz ? 'notch-output-limit' : undefined}
                    onChange={(e) => setRequestedCenterHz(Math.round(normToFreq(Number(e.target.value) / 1000, MIN_FREQ_HZ, maxCenterHz)))}
                    className="range-input range-amber"
                    data-testid="notch-center-slider"
                  />
                  {requestedCenterHz > maxCenterHz && (
                    <p className="hint-text" id="notch-output-limit" role="status">
                      This audio output limits the notch center to {formatHz(maxCenterHz)}.
                      {' '}Your requested pitch is {formatHz(requestedCenterHz)}.
                    </p>
                  )}
                </div>

                <div className="width-picker">
                  <div className="slider-header">
                    <span>Notch Width</span>
                    <span className="mono">{notchWidthOct.toFixed(1)} oct</span>
                  </div>
                  <div className="pill-row">
                    {[0.5, 1.0, 1.5].map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={`mini-pill-btn ${Math.abs(notchWidthOct - w) < 0.05 ? 'active' : ''}`}
                        aria-pressed={notchWidthOct === w}
                        onClick={() => setNotchWidthOct(w)}
                        data-testid={`notch-width-${w}`}
                      >
                        {w.toFixed(1)} oct
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* SUB-MODE A: NOTCHED SOUND THERAPY */}
      {subMode === 'therapy' && (
        <section className="panel-card" data-testid="therapy-panel">
          <div className="card-head">
            <div>
              <h2>Notched Sound Therapy</h2>
              <p className="card-desc">
                {notchEnabled
                  ? `Energy around ${formatHz(centerHz)} is filtered over ${notchWidthOct.toFixed(1)} octaves.`
                  : 'The sound bed plays with the notch bypassed.'}
                {' '}The sound fades as your timer ends.
              </p>
            </div>
          </div>

          <div className="noise-grid" role="radiogroup" aria-label="Therapy sound bed" onKeyDown={handleRadioKeyDown}>
            {NOISE_TYPES.map((t) => {
              const meta = RELIEF_NOISE_META[t];
              const selected = noiseType === t;
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  className={`noise-card ${selected ? 'selected' : ''}`}
                  onClick={() => void handleChangeNoise(t)}
                  data-testid={`noise-type-${t}`}
                >
                  <div className="noise-card-top">
                    <strong>{meta.label}</strong>
                    <span className="mono noise-slope">{meta.slope}</span>
                  </div>
                  <span className="noise-desc">{meta.description}</span>
                </button>
              );
            })}
          </div>

          {errorAt(noiseType)}
          <div className="therapy-bottom-grid">
            <div className="slider-group">
              <div className="slider-header">
                <label htmlFor="therapy-vol">Therapy Level</label>
                <span className="mono">{Math.round(therapyVolume * 100)}%</span>
              </div>
              <input
                id="therapy-vol"
                type="range"
                min={10}
                max={100}
                value={Math.round(therapyVolume * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100;
                  therapyControls.current.volume = v;
                  setTherapyVolume(v);
                  if (isTherapyPlaying) applyTherapyTiming(sessionMinutes, v);
                }}
                className="range-input"
              />

              <div className="ear-inline-row">
                <span className="hint-text">Output routing:</span>
                <div className="pill-row" role="group" aria-label="Output routing">
                  {(['both', 'left', 'right'] as EarSide[]).map((side) => (
                    <button
                      key={side}
                      type="button"
                      className={`mini-pill-btn ${ear === side ? 'active' : ''}`}
                      aria-pressed={ear === side}
                      data-testid={`therapy-ear-${side}`}
                      onClick={() => selectOutputEar(side)}
                    >
                      {side === 'both' ? 'Both' : side === 'left' ? 'Left' : 'Right'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="timer-box">
              <div className="slider-header">
                <span className="timer-label-inline">
                  <Clock size={14} /> Session Timer · 30s fade
                </span>
                <span className="mono accent-teal" data-testid="therapy-countdown">
                  {formatClock(remainingSec)}
                </span>
              </div>
              <div className="pill-row" role="group" aria-label="Session timer">
                {TIMER_PRESETS.map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    className={`mini-pill-btn ${sessionMinutes === mins ? 'active' : ''}`}
                    aria-pressed={sessionMinutes === mins}
                    onClick={() => selectTimer(mins)}
                    data-testid={`timer-${mins}`}
                  >
                    {mins}m
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!gardenTransport && <div className="therapy-cta-row">{therapyTransport}</div>}
          {!gardenTransport && errorAt('therapy')}
        </section>
      )}

      {/* SUB-MODE B: NOTCH YOUR OWN MUSIC */}
      {subMode === 'music' && (
        <section className="panel-card" data-testid="music-panel">
          <div className="card-head">
            <div>
              <h2>Notch Your Own Music</h2>
              <p className="card-desc">
                {notchEnabled
                  ? `Your local audio plays through a ${formatKhzCompact(centerHz)} notch filter.`
                  : 'Your local audio plays with the notch bypassed.'}
              </p>
            </div>
            <span className="verified-pill">
              <Lock size={13} /> Never uploaded
            </span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              handleFilePicked(e.target.files?.[0]);
              e.currentTarget.value = '';
            }}
            data-testid="music-file-input"
          />

          <div
            className="dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFilePicked(e.dataTransfer.files?.[0]);
            }}
          >
            <Disc3 size={28} className="accent-teal" />
            <div className="dropzone-text">
              <strong dir="auto" className="track-filename" title={trackName || undefined}>
                {trackName || 'Drop an audio file here (MP3, WAV, M4A, FLAC)'}
              </strong>
              <span>Processed 100% locally in Web Audio memory — zero bytes leave your device.</span>
            </div>
            <div className="dropzone-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => fileInputRef.current?.click()}
                data-testid="choose-music-file-btn"
              >
                <FolderOpen size={16} /> Choose Local Audio
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleLoadBuiltInSample}
                data-testid="load-sample-music-btn"
              >
                <Sparkles size={16} /> Try Built-in Ambient Sample
              </button>
            </div>
          </div>

          {musicError && <PlaybackError message={musicError} testId="music-error" onReviewSetup={onReviewSetup} />}

          {hasMusicLoaded && (
            <div className="music-transport" data-testid="music-transport">
              <div className="music-actions">
                <button
                  type="button"
                  className={`btn btn-lg ${isMusicPlaying ? 'btn-amber' : 'btn-primary'}`}
                  onClick={() => void handleToggleMusicPlay()}
                  data-testid="music-play-toggle"
                >
                  {isMusicPlaying ? <Pause size={18} /> : <Play size={18} />}
                  <span>{isMusicPlaying ? 'Pause' : canReplay ? 'Replay' : 'Play'} {notchEnabled ? 'Notched' : 'Bypassed'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label="Repeat track"
                  aria-pressed={repeatMusic}
                  onClick={() => selectRepeat(!repeatMusic)}
                  data-testid="music-repeat-toggle"
                >
                  Repeat {repeatMusic ? 'On' : 'Off'}
                </button>
              </div>

              <div className="music-scrub">
                <div className="slider-header">
                  <bdi className="truncate" title={trackName}>{trackName}</bdi>
                  <span className="mono">
                    {formatClock(musicCurrentTime)} / {formatClock(musicDuration)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, Math.floor(musicDuration))}
                  value={Math.floor(musicCurrentTime)}
                  onChange={(e) => void handleMusicSeek(Number(e.target.value))}
                  className="range-input"
                  aria-label="Audio playback position"
                />
              </div>

              <div className="music-vol">
                <label htmlFor="music-vol-slider" className="hint-text">
                  Level
                </label>
                <input
                  id="music-vol-slider"
                  type="range"
                  min={10}
                  max={100}
                  value={Math.round(musicVolume * 100)}
                  onChange={(e) => {
                    const v = Number(e.target.value) / 100;
                    setMusicVolume(v);
                    audioEngine.setActiveVolume(v);
                  }}
                  className="range-input"
                />
              </div>
            </div>
          )}
        </section>
      )}

      {/* SUB-MODE C: RESIDUAL-INHIBITION TEST */}
      {subMode === 'ri' && (
        <section className="panel-card" data-testid="ri-panel">
          <div className="card-head">
            <div>
              <h2>Residual-Inhibition (RI) Test</h2>
              <p className="card-desc">
                In ~60–80% of tonal tinnitus cases, listening to matched band-pass noise for 60 seconds
                briefly quiets the ringing afterward. This test times how long any quietness lasts and
                logs it to your journal.
              </p>
            </div>
          </div>

          {riMatch && (
            <p className="hint-text mono" data-testid="ri-match">
              {selection.saved ? 'Saved match' : 'Unsaved match'} · {formatHz(riMatch.frequencyHz)} · {formatEarLabel(riMatch.ear)}
              {riBand && <><br />Mask band · <span data-testid="ri-band-edges">{formatBandEdges(riBand)}</span></>}
            </p>
          )}
          {!selection.saved && (
            <div className="ri-stage">
              {!activeMatch && (
                <p role="status" data-testid="ri-lost-handoff">
                  The draft handoff was lost. Reopen your draft from Match or choose a saved match to continue.
                </p>
              )}
              <div className="ri-btn-row">
                {activeMatch && (
                  <button type="button" className="btn btn-primary" disabled={riSavingMatch}
                    onClick={() => void handleSaveRIMatch()} data-testid="ri-save-match">
                    Save this match to run RI
                  </button>
                )}
                {previousMatch && (
                  <button type="button" className="btn btn-secondary" disabled={riSavingMatch}
                    onClick={() => {
                      setAudioError(null);
                      onSelectSavedMatch(previousMatch);
                    }} data-testid="ri-use-previous-match">
                    Use previous saved match · {formatHz(previousMatch.frequencyHz)} · {formatEarLabel(previousMatch.ear)}
                  </button>
                )}
                <button type="button" className="btn btn-ghost" disabled={riSavingMatch} onClick={onGoToMatch} data-testid="ri-match-first">
                  Refine match
                </button>
              </div>
              {errorAt('ri-save')}
            </div>
          )}
          {selection.saved && !riMatch && (
            <div className="ri-stage">
              <p>Match and save a pitch to set the masking sound and ear for this test.</p>
              <button type="button" className="btn btn-secondary" onClick={onGoToMatch} data-testid="ri-match-first">
                Match pitch first
              </button>
            </div>
          )}

          {riPhase === 'ready' && selection.saved && activeMatch && (
            <div className="ri-stage">
              <div className="ri-setup-row">
                <div>
                  <strong>Stimulus Duration</strong>
                  <p className="hint-text">Clinical standard is 60 seconds at a gentle masking level.</p>
                </div>
                <div className="pill-row">
                  {[60, 30, 10].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      className={`mini-pill-btn ${riDurationSec === sec ? 'active' : ''}`}
                      aria-pressed={riDurationSec === sec}
                      onClick={() => {
                        setRiDurationSec(sec);
                        setRiMaskLeftSec(sec);
                      }}
                      data-testid={`ri-dur-${sec}`}
                    >
                      {sec === 60 ? '60s (Standard)' : `${sec}s`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ri-cta-center">
                <button
                  type="button"
                  className="btn btn-primary btn-xl"
                  onClick={() => void handleStartRI()}
                  data-testid="ri-start-btn"
                >
                  <Activity size={20} />
                  <span>Begin {riDurationSec}s Masking Phase</span>
                </button>
              </div>
              {errorAt('ri-start')}
            </div>
          )}

          {riPhase === 'masking' && (
            <div className="ri-stage ri-active" data-testid="ri-masking-phase">
              <div className="ri-ring-wrap">
                <svg viewBox="0 0 160 160" className="ri-ring" aria-hidden="true">
                  <circle cx="80" cy="80" r="68" fill="none" stroke="rgba(81,72,47,0.21)" strokeWidth="8" />
                  <circle
                    cx="80"
                    cy="80"
                    r="68"
                    fill="none"
                    stroke="#3b5340"
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 68}
                    strokeDashoffset={2 * Math.PI * 68 * (1 - riMaskProgress)}
                    transform="rotate(-90 80 80)"
                  />
                </svg>
                <div className="ri-ring-center">
                  <span className="ri-phase-tag">MASKING</span>
                  <strong className="mono ri-big-time">{riMaskLeftSec}s</strong>
                </div>
              </div>
              <p className="ri-instruction">
                Relax your jaw and shoulders. The sound fades as the timer reaches zero.
                Then the silence timer starts automatically.
              </p>
              <div className="ri-btn-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => maskRun.current?.timing.endEarly()}
                  data-testid="ri-skip-to-silence"
                >
                  End Masking Early → Start Silence Timer
                </button>
                <button type="button" className="btn btn-ghost" onClick={handleAbortRI}>
                  <Square size={14} /> Cancel
                </button>
              </div>
            </div>
          )}

          <span className="sr-only" role="status">{riPhase === 'listening' ? 'Silence timer started.' : ''}</span>
          {riPhase === 'listening' && (
            <div className="ri-stage ri-active" data-testid="ri-listening-phase">
              <div className="ri-response" ref={riResponse}>
                <div className="ri-phase-pill">SILENCE · OBSERVING QUIETNESS</div>
                <div className="ri-stopwatch mono" data-testid="ri-stopwatch">
                  {(riElapsedMs / 1000).toFixed(1)} s
                </div>
                <button
                  ref={riReturnedButton}
                  type="button"
                  className="btn btn-amber btn-xl"
                  onClick={() => void handleFinishRI(false)}
                  data-testid="ri-returned-btn"
                >
                  My Ringing Has Returned
                </button>
              </div>
              <p className="ri-instruction">
                Notice whether your ringing feels quieter or paused. Respond when your tinnitus returns to its usual level.
              </p>
              <div className="ri-btn-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void handleFinishRI(true)}
                  data-testid="ri-no-change-btn"
                >
                  No quietness noticed (0 s)
                </button>
              </div>
              {errorAt('ri-result')}
            </div>
          )}

          {riPhase === 'done' && riLastResult && (
            <div className="ri-stage ri-done" data-testid="ri-done-phase">
              <span className="verified-pill">
                <CheckCircle2 size={14} /> Saved to Journal
              </span>
              <div className="ri-result-val mono">
                {riLastResult.reliefSeconds > 0
                  ? `${riLastResult.reliefSeconds.toFixed(1)} seconds`
                  : 'No immediate suppression'}
              </div>
              <p className="ri-instruction">
                {riLastResult.reliefSeconds >= 30
                  ? 'Notable residual inhibition response. Sound-based relief tools may feel especially soothing for your auditory profile.'
                  : riLastResult.reliefSeconds > 0
                  ? 'Brief residual inhibition recorded. Even short suppression shows your tinnitus responds to acoustic masking.'
                  : 'Not everyone experiences residual inhibition on a given day — this is completely normal and still useful data to log.'}
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setRiMaskLeftSec(riDurationSec);
                  setRiPhase('ready');
                }}
              >
                Run Another Test
              </button>
            </div>
          )}
          {riMatch && riBand && (
            <SpectrumVisualizer
              isPlaying={riPhase === 'masking'}
              markerHz={riBand.centerHz}
              markerLabel={`Mask ${formatKhzCompact(riMatch.frequencyHz)}`}
              band={riBand}
              height={104}
            />
          )}
        </section>
      )}
      </div>
    </div>
  );
};
