export type AppTab = 'setup' | 'match' | 'relief' | 'journal' | 'learn';

export type EarSide = 'left' | 'right' | 'both';

export type SoundType = 'tone' | 'hiss' | 'whoosh' | 'buzz' | 'crickets';

export type ReliefNoiseType = 'white' | 'pink' | 'brown' | 'rain' | 'ocean';

export type ReliefSubMode = 'therapy' | 'music' | 'ri';

export interface TinnitusMatch {
  id: string;
  createdAt: number;
  soundType: SoundType;
  frequencyHz: number;
  ear: EarSide;
  /** Matched loudness 0..100 (mapped inside safe −6 dBFS envelope) */
  loudness: number;
  /** Filter bandwidth in octaves (relevant for hiss/whoosh; stored for all) */
  bandwidthOct: number;
  /** Optional modulation rate in Hz (for crickets/pulsed) */
  pulseRateHz?: number;
  /** Whether the user explicitly confirmed the f/2 · f · 2f octave check */
  octaveVerified: boolean;
  note?: string;
}

export interface JournalCheckIn {
  id: string;
  createdAt: number;
  /** ISO date YYYY-MM-DD */
  dateKey: string;
  /** 1..10 */
  loudness: number;
  /** 1..10 */
  annoyance: number;
  tags: string[];
  note: string;
}

export interface ResidualInhibitionRecord {
  id: string;
  createdAt: number;
  frequencyHz: number;
  stimulusSeconds: number;
  /** Seconds of quietness/reduction after stimulus ended; 0 means no RI observed */
  reliefSeconds: number;
  ear: EarSide;
  note?: string;
}

export type SessionFilter = { state: 'bypassed' } | {
  state: 'notched';
  frequencyHz: number;
  notchWidthOct: number;
};

export type SessionFilterSegment = SessionFilter & { durationSeconds: number; noiseType?: ReliefNoiseType };

export interface TherapySessionRecord {
  id: string;
  createdAt: number;
  mode: 'notched-noise' | 'notched-music';
  noiseType?: ReliefNoiseType;
  trackName?: string;
  frequencyHz: number;
  notchWidthOct: number;
  durationSeconds: number;
  /** Older records did not track filter state. */
  filterSegments?: SessionFilterSegment[];
  endReason?: 'completed' | 'paused' | 'muted' | 'left' | 'replaced' | 'interrupted';
}

export interface SetupCalibration {
  headphonesChecked: boolean;
  leftHeard: boolean;
  rightHeard: boolean;
  /** User comfort master level 0.1..1.0 (strictly under hard −6 dBFS limiter) */
  comfortLevel: number;
  ear: EarSide;
  safetyAcknowledged: boolean;
}

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  app: 'tinnitune';
  calibration: SetupCalibration;
  activeMatchId: string | null;
  matches: TinnitusMatch[];
  checkins: JournalCheckIn[];
  riTests: ResidualInhibitionRecord[];
  sessions: TherapySessionRecord[];
}

export const SOUND_TYPE_META: Record<
  SoundType,
  {
    label: string;
    shortLabel: string;
    subtitle: string;
    hasBandwidth: boolean;
    defaultBandwidthOct: number;
  }
> = {
  tone: {
    label: 'Pure Tone',
    shortLabel: 'pure tone',
    subtitle: 'Steady tonal ringing or whistle',
    hasBandwidth: false,
    defaultBandwidthOct: 0.1,
  },
  hiss: {
    label: 'Narrow-Band Hiss',
    shortLabel: 'narrow-band hiss',
    subtitle: 'Focused steam, static, or sibilant hiss',
    hasBandwidth: true,
    defaultBandwidthOct: 0.25,
  },
  whoosh: {
    label: 'Broadband Whoosh',
    shortLabel: 'broadband whoosh',
    subtitle: 'Wider rushing air or soft surf-like band',
    hasBandwidth: true,
    defaultBandwidthOct: 1.1,
  },
  buzz: {
    label: 'Buzz / Hum',
    shortLabel: 'buzz / hum',
    subtitle: 'Harmonic-rich electrical hum or vibration',
    hasBandwidth: false,
    defaultBandwidthOct: 0.3,
  },
  crickets: {
    label: 'Crickets / Pulsed',
    shortLabel: 'crickets / pulsed',
    subtitle: 'High rhythmic chirp or modulated shimmer',
    hasBandwidth: false,
    defaultBandwidthOct: 0.2,
  },
};

export const RELIEF_NOISE_META: Record<
  ReliefNoiseType,
  { label: string; slope: string; description: string }
> = {
  white: { label: 'White', slope: '0 dB/oct', description: 'Crisp full-spectrum energy' },
  pink: { label: 'Pink', slope: '−3 dB/oct', description: 'Balanced, natural waterfall texture' },
  brown: { label: 'Brown', slope: '−6 dB/oct', description: 'Deep, warm low-frequency rumble' },
  rain: { label: 'Rain', slope: 'Sculpted', description: 'Soft steady rainfall with gentle droplets' },
  ocean: { label: 'Ocean', slope: 'Modulated', description: 'Slowly breathing shoreline surf' },
};
