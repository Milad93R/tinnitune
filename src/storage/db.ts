import type {
  EarSide,
  ExportBundle,
  JournalCheckIn,
  ReliefNoiseType,
  ResidualInhibitionRecord,
  SessionFilterSegment,
  SetupCalibration,
  SoundType,
  TherapySessionRecord,
  TinnitusMatch,
} from '../types';

const DB_NAME = 'tinnitune-db';
const DB_VERSION = 1;

const STORE_MATCHES = 'matches';
const STORE_CHECKINS = 'checkins';
const STORE_RI = 'riTests';
const STORE_SESSIONS = 'sessions';

const LS_CALIBRATION = 'tinnitune_calibration_v1';
const LS_ACTIVE_MATCH = 'tinnitune_active_match_v1';
const LS_DEVICE_CONFIRMATIONS = 'tinnitune_device_confirmations_v1';
const LS_RELIEF_ROUTE = 'tinnitune_relief_route_v1';
const RELIEF_DRAFT_KEY = 'tinnitune_relief_draft_v1';
const SESSION_CHECKPOINT_PREFIX = 'tinnitune_session_checkpoint_';
type DeviceConfirmations = Pick<SetupCalibration, 'safetyAcknowledged' | 'leftHeard' | 'rightHeard'>;
export type ReliefRoute = { matchId: string | null; ear: EarSide };

const VALID_SOUND_TYPES = new Set<SoundType>(['tone', 'hiss', 'whoosh', 'buzz', 'crickets']);
const VALID_EARS = new Set<EarSide>(['left', 'right', 'both']);
const VALID_NOISE_TYPES = new Set<ReliefNoiseType>(['white', 'pink', 'brown', 'rain', 'ocean']);

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseFilterSegments(value: unknown, durationSeconds: number): SessionFilterSegment[] | undefined {
  if (!Array.isArray(value) || !value.length) return;
  const segments: SessionFilterSegment[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0) return;
    const segmentDuration = item.durationSeconds as number;
    const bed = VALID_NOISE_TYPES.has(item.noiseType) ? { noiseType: item.noiseType as ReliefNoiseType } : {};
    total += segmentDuration;
    if (item.state === 'bypassed') {
      segments.push({ state: 'bypassed', durationSeconds: segmentDuration, ...bed });
    } else if (item.state === 'notched' && Number.isFinite(item.frequencyHz) && Number.isFinite(item.notchWidthOct)) {
      segments.push({
        state: 'notched', durationSeconds: segmentDuration,
        frequencyHz: Math.round(clampNum(item.frequencyHz, 250, 18000)),
        notchWidthOct: Number(clampNum(item.notchWidthOct, 0.2, 2.5).toFixed(2)),
        ...bed,
      });
    } else {
      return;
    }
  }
  if (Math.abs(total - durationSeconds) <= 0.501) return segments;
}

export function isJournalTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value > 0 && value <= Date.UTC(9999, 11, 31, 23, 59, 59, 999);
}

function safeEar(value: unknown, fallback: EarSide = 'both'): EarSide {
  return typeof value === 'string' && VALID_EARS.has(value as EarSide) ? (value as EarSide) : fallback;
}

export function loadReliefDraft(): TinnitusMatch | null {
  try {
    const draft = JSON.parse(sessionStorage.getItem(RELIEF_DRAFT_KEY) ?? 'null') as TinnitusMatch | null;
    if (draft && typeof draft.id === 'string' && draft.id && isJournalTimestamp(draft.createdAt)
      && VALID_SOUND_TYPES.has(draft.soundType) && VALID_EARS.has(draft.ear)
      && Number.isInteger(draft.frequencyHz) && draft.frequencyHz >= 250 && draft.frequencyHz <= 18000
      && Number.isFinite(draft.loudness) && Number.isFinite(draft.bandwidthOct)
      && typeof draft.octaveVerified === 'boolean'
      && (draft.pulseRateHz === undefined || Number.isFinite(draft.pulseRateHz))) return draft;
  } catch { /* The history marker still identifies the handoff. */ }
  return null;
}

export function saveReliefDraft(draft: TinnitusMatch | null): void {
  try {
    if (draft) sessionStorage.setItem(RELIEF_DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(RELIEF_DRAFT_KEY);
  } catch { /* The history marker still identifies the handoff. */ }
}

function safeSoundType(value: unknown): SoundType {
  return typeof value === 'string' && VALID_SOUND_TYPES.has(value as SoundType)
    ? (value as SoundType)
    : 'tone';
}

export function isJournalDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const DEFAULT_CALIBRATION: SetupCalibration = {
  headphonesChecked: false,
  leftHeard: false,
  rightHeard: false,
  comfortLevel: 0.55,
  ear: 'both',
  safetyAcknowledged: false,
};

function normalizeCalibration(parsed: Partial<SetupCalibration>): SetupCalibration {
  return {
    headphonesChecked: parsed.headphonesChecked === true,
    leftHeard: parsed.leftHeard === true,
    rightHeard: parsed.rightHeard === true,
    comfortLevel:
      typeof parsed.comfortLevel === 'number' && Number.isFinite(parsed.comfortLevel)
        ? clampNum(parsed.comfortLevel, 0.05, 1)
        : DEFAULT_CALIBRATION.comfortLevel,
    ear: safeEar(parsed.ear, DEFAULT_CALIBRATION.ear),
    safetyAcknowledged: parsed.safetyAcknowledged === true,
  };
}

export function loadCalibration(): SetupCalibration {
  try {
    const raw = localStorage.getItem(LS_CALIBRATION);
    return raw ? normalizeCalibration(JSON.parse(raw)) : { ...DEFAULT_CALIBRATION };
  } catch {
    return { ...DEFAULT_CALIBRATION };
  }
}

export function saveCalibration(cal: SetupCalibration): void {
  try {
    localStorage.setItem(LS_CALIBRATION, JSON.stringify(cal));
  } catch {
    // ignore quota errors
  }
}

export function loadDeviceCalibration(): SetupCalibration {
  const saved = loadCalibration();
  let device: Partial<DeviceConfirmations> = {};
  try {
    device = JSON.parse(localStorage.getItem(LS_DEVICE_CONFIRMATIONS) ?? '{}') ?? {};
  } catch {
    // A release before explicit user confirmation has no device record.
  }
  const leftHeard = saved.leftHeard && device.leftHeard === true;
  const rightHeard = saved.rightHeard && device.rightHeard === true;
  return {
    ...saved,
    leftHeard,
    rightHeard,
    headphonesChecked: leftHeard && rightHeard,
    safetyAcknowledged: saved.safetyAcknowledged && device.safetyAcknowledged === true,
  };
}

export function saveDeviceConfirmations({ safetyAcknowledged, leftHeard, rightHeard }: DeviceConfirmations): void {
  try {
    localStorage.setItem(LS_DEVICE_CONFIRMATIONS, JSON.stringify({ safetyAcknowledged, leftHeard, rightHeard }));
  } catch {
    // The acknowledged runtime state remains available for this visit.
  }
}

export function loadActiveMatchId(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE_MATCH);
  } catch {
    return null;
  }
}

export function saveActiveMatchId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LS_ACTIVE_MATCH, id);
    else localStorage.removeItem(LS_ACTIVE_MATCH);
  } catch {
    // ignore
  }
}

export function loadReliefRoute(): ReliefRoute | null {
  try {
    const route = JSON.parse(localStorage.getItem(LS_RELIEF_ROUTE) ?? 'null');
    if (route && VALID_EARS.has(route.ear) && (typeof route.matchId === 'string' || route.matchId === null)) return route;
  } catch {
    // Fall back to the active match or Setup ear.
  }
  return null;
}

export function saveReliefRoute(route: ReliefRoute | null): void {
  try {
    if (route) localStorage.setItem(LS_RELIEF_ROUTE, JSON.stringify(route));
    else localStorage.removeItem(LS_RELIEF_ROUTE);
  } catch {
    // The override remains available while Relief is open.
  }
}

let connection: IDBDatabase | null = null;
let opening: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (connection) return Promise.resolve(connection);
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MATCHES)) {
        db.createObjectStore(STORE_MATCHES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CHECKINS)) {
        db.createObjectStore(STORE_CHECKINS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_RI)) {
        db.createObjectStore(STORE_RI, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      connection = db;
      db.onclose = () => { if (connection === db) connection = null; };
      db.onversionchange = () => {
        db.close();
        if (connection === db) connection = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }).finally(() => { opening = null; });
  return opening;
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as T[]) ?? [];
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

async function putInStore<T>(storeName: string, item: T): Promise<void> {
  const db = connection ?? await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFromStore(storeName: string, id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface AllStoredData {
  matches: TinnitusMatch[];
  checkins: JournalCheckIn[];
  riTests: ResidualInhibitionRecord[];
  sessions: TherapySessionRecord[];
}

export async function loadAllJournalData(): Promise<AllStoredData> {
  const [matches, checkins, riTests, sessions] = await Promise.all([
    getAllFromStore<TinnitusMatch>(STORE_MATCHES),
    getAllFromStore<JournalCheckIn>(STORE_CHECKINS),
    getAllFromStore<ResidualInhibitionRecord>(STORE_RI),
    getAllFromStore<TherapySessionRecord>(STORE_SESSIONS),
  ]);

  matches.sort((a, b) => b.createdAt - a.createdAt);
  checkins.sort((a, b) => b.createdAt - a.createdAt);
  riTests.sort((a, b) => b.createdAt - a.createdAt);
  sessions.sort((a, b) => b.createdAt - a.createdAt);

  return { matches, checkins, riTests, sessions };
}

export const dbSaveMatch = (m: TinnitusMatch) => putInStore(STORE_MATCHES, m);
export const dbDeleteMatch = (id: string) => deleteFromStore(STORE_MATCHES, id);

export const dbSaveCheckIn = (c: JournalCheckIn) => putInStore(STORE_CHECKINS, c);
export const dbDeleteCheckIn = (id: string) => deleteFromStore(STORE_CHECKINS, id);

export const dbSaveRITest = (r: ResidualInhibitionRecord) => putInStore(STORE_RI, r);
export const dbDeleteRITest = (id: string) => deleteFromStore(STORE_RI, id);

export const dbSaveSession = (s: TherapySessionRecord) => putInStore(STORE_SESSIONS, s);
export const dbDeleteSession = (id: string) => deleteFromStore(STORE_SESSIONS, id);

export function saveSessionCheckpoint(record: TherapySessionRecord, scope: 'tab' | 'device' = 'tab'): void {
  try {
    // The last lifecycle snapshot must survive tab close without waiting for a transaction.
    const storage = scope === 'device' ? localStorage : sessionStorage;
    storage.setItem(SESSION_CHECKPOINT_PREFIX + record.id, JSON.stringify(record));
  } catch { /* Storage may be unavailable. */ }
}

export function clearSessionCheckpoint(id: string): void {
  try {
    sessionStorage.removeItem(SESSION_CHECKPOINT_PREFIX + id);
  } catch { /* Storage may be unavailable. */ }
  try {
    localStorage.removeItem(SESSION_CHECKPOINT_PREFIX + id);
  } catch { /* Storage may be unavailable. */ }
}

function readSessionCheckpoints(scope: 'tab' | 'device') {
  const checkpoints: { storage: Storage; key: string; raw: string; record: TherapySessionRecord }[] = [];
  try {
    const storage = scope === 'device' ? localStorage : sessionStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(SESSION_CHECKPOINT_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw) as TherapySessionRecord | null;
        if (record?.id && key === SESSION_CHECKPOINT_PREFIX + record.id &&
            Number.isFinite(record.durationSeconds) && record.durationSeconds >= 15) {
          record.filterSegments = parseFilterSegments(record.filterSegments, record.durationSeconds);
          checkpoints.push({ storage, key, raw, record });
        }
      } catch { /* Skip malformed checkpoints. */ }
    }
  } catch { /* Read any valid checkpoints already collected. */ }
  return checkpoints;
}

const checkpointDuration = (record: TherapySessionRecord) =>
  record.filterSegments?.reduce((total, segment) => total + segment.durationSeconds, 0) ?? record.durationSeconds;

export async function recoverSessionCheckpoints(): Promise<void> {
  const checkpoints = [...readSessionCheckpoints('tab'), ...readSessionCheckpoints('device')];
  if (!checkpoints.length) return;
  const latest = new Map<string, TherapySessionRecord>();
  for (const { record } of checkpoints) {
    const previous = latest.get(record.id);
    if (!previous || checkpointDuration(record) >= checkpointDuration(previous)) latest.set(record.id, record);
  }

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    for (const record of latest.values()) {
      const existing = store.get(record.id);
      existing.onsuccess = () => {
        const saved = existing.result as TherapySessionRecord | undefined;
        if (!saved || (saved.endReason === 'interrupted' && checkpointDuration(record) > checkpointDuration(saved))) {
          store.put(record);
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  for (const { storage, key, raw } of checkpoints) {
    try {
      if (storage.getItem(key) === raw) storage.removeItem(key);
    } catch { /* A later startup can retry cleanup. */ }
  }
}

export async function buildExportBundle(): Promise<ExportBundle> {
  const data = await loadAllJournalData();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: 'tinnitune',
    calibration: loadCalibration(),
    activeMatchId: loadActiveMatchId(),
    ...data,
  };
}

export function parseExportBundle(rawJson: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid JSON file. Please select a valid Tinnitune backup.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup format is not recognized.');
  }

  const obj = parsed as Partial<ExportBundle>;
  if (obj.app !== 'tinnitune' || obj.version !== 1) {
    throw new Error('This file does not appear to be a Tinnitune v1 backup.');
  }

  const rawMatches = Array.isArray(obj.matches) ? obj.matches : [];
  const rawCheckins = Array.isArray(obj.checkins) ? obj.checkins : [];
  const rawRiTests = Array.isArray(obj.riTests) ? obj.riTests : [];
  const rawSessions = Array.isArray(obj.sessions) ? obj.sessions : [];

  const validMatches: TinnitusMatch[] = [];
  for (const m of rawMatches) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as Partial<TinnitusMatch>;
    if (typeof rec.id !== 'string' || !rec.id.trim() || !isJournalTimestamp(rec.createdAt) || typeof rec.frequencyHz !== 'number' || !Number.isFinite(rec.frequencyHz)) {
      continue;
    }
    const soundType = safeSoundType(rec.soundType);
    validMatches.push({
      id: rec.id,
      createdAt: rec.createdAt,
      soundType,
      frequencyHz: Math.round(clampNum(rec.frequencyHz, 250, 18000)),
      ear: safeEar(rec.ear),
      loudness: Math.round(clampNum(typeof rec.loudness === 'number' ? rec.loudness : 50, 5, 100)),
      bandwidthOct: Number(clampNum(typeof rec.bandwidthOct === 'number' ? rec.bandwidthOct : 0.25, 0.05, 2.5).toFixed(2)),
      pulseRateHz:
        soundType === 'crickets' && typeof rec.pulseRateHz === 'number' && Number.isFinite(rec.pulseRateHz)
          ? Math.round(clampNum(rec.pulseRateHz, 4, 24))
          : undefined,
      octaveVerified: Boolean(rec.octaveVerified),
      note: typeof rec.note === 'string' ? rec.note : undefined,
    });
  }

  const validCheckins: JournalCheckIn[] = [];
  for (const c of rawCheckins) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Partial<JournalCheckIn>;
    if (
      typeof rec.id !== 'string' ||
      !rec.id.trim() ||
      !isJournalTimestamp(rec.createdAt) ||
      !isJournalDateKey(rec.dateKey) ||
      typeof rec.loudness !== 'number' ||
      !Number.isFinite(rec.loudness)
    ) {
      continue;
    }
    const annoyanceVal =
      typeof rec.annoyance === 'number' && Number.isFinite(rec.annoyance) ? rec.annoyance : rec.loudness;
    const tags = Array.isArray(rec.tags)
      ? rec.tags
          .filter((t): t is string => typeof t === 'string')
      : [];
    validCheckins.push({
      id: rec.id,
      createdAt: rec.createdAt,
      dateKey: rec.dateKey,
      loudness: Math.round(clampNum(rec.loudness, 1, 10)),
      annoyance: Math.round(clampNum(annoyanceVal, 1, 10)),
      tags,
      note: typeof rec.note === 'string' ? rec.note : '',
    });
  }

  const validRi: ResidualInhibitionRecord[] = [];
  for (const r of rawRiTests) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Partial<ResidualInhibitionRecord>;
    if (
      typeof rec.id !== 'string' ||
      !rec.id.trim() ||
      !isJournalTimestamp(rec.createdAt) ||
      typeof rec.reliefSeconds !== 'number' ||
      !Number.isFinite(rec.reliefSeconds)
    ) {
      continue;
    }
    validRi.push({
      id: rec.id,
      createdAt: rec.createdAt,
      frequencyHz: Math.round(clampNum(typeof rec.frequencyHz === 'number' ? rec.frequencyHz : 6000, 250, 18000)),
      stimulusSeconds: typeof rec.stimulusSeconds === 'number' && Number.isFinite(rec.stimulusSeconds) ? Math.max(0, rec.stimulusSeconds) : 60,
      reliefSeconds: Math.max(0, rec.reliefSeconds),
      ear: safeEar(rec.ear),
      note: typeof rec.note === 'string' ? rec.note : undefined,
    });
  }

  const validSessions: TherapySessionRecord[] = [];
  for (const s of rawSessions) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as Partial<TherapySessionRecord>;
    if (
      typeof rec.id !== 'string' ||
      !rec.id.trim() ||
      !isJournalTimestamp(rec.createdAt) ||
      typeof rec.durationSeconds !== 'number' ||
      !Number.isFinite(rec.durationSeconds)
    ) {
      continue;
    }
    const mode: 'notched-noise' | 'notched-music' =
      rec.mode === 'notched-music' ? 'notched-music' : 'notched-noise';
    const noiseType =
      typeof rec.noiseType === 'string' && VALID_NOISE_TYPES.has(rec.noiseType as ReliefNoiseType)
        ? (rec.noiseType as ReliefNoiseType)
        : mode === 'notched-noise'
        ? 'rain'
        : undefined;
    const durationSeconds = Math.max(1, Math.round(rec.durationSeconds));
    validSessions.push({
      id: rec.id,
      createdAt: rec.createdAt,
      mode,
      noiseType,
      trackName: typeof rec.trackName === 'string' ? rec.trackName : undefined,
      frequencyHz: Math.round(clampNum(typeof rec.frequencyHz === 'number' ? rec.frequencyHz : 6000, 250, 18000)),
      notchWidthOct: Number(clampNum(typeof rec.notchWidthOct === 'number' ? rec.notchWidthOct : 1.0, 0.2, 2.5).toFixed(2)),
      durationSeconds,
      filterSegments: parseFilterSegments(rec.filterSegments, durationSeconds),
      endReason: rec.endReason && ['completed', 'paused', 'muted', 'left', 'replaced', 'interrupted'].includes(rec.endReason)
        ? rec.endReason : undefined,
    });
  }

  const calibration = obj.calibration && typeof obj.calibration === 'object'
    ? normalizeCalibration(obj.calibration) : undefined;
  const activeMatchId = typeof obj.activeMatchId === 'string' && obj.activeMatchId.trim()
    ? obj.activeMatchId : obj.activeMatchId === null ? null : undefined;
  const skipped = rawMatches.length + rawCheckins.length + rawRiTests.length + rawSessions.length
    - validMatches.length - validCheckins.length - validRi.length - validSessions.length;

  return { validMatches, validCheckins, validRi, validSessions, calibration, activeMatchId, skipped };
}

export async function importExportBundle(rawJson: string) {
  const { validMatches, validCheckins, validRi, validSessions, calibration, activeMatchId, skipped } = parseExportBundle(rawJson);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORE_MATCHES, STORE_CHECKINS, STORE_RI, STORE_SESSIONS],
      'readwrite'
    );
    for (const m of validMatches) tx.objectStore(STORE_MATCHES).put(m);
    for (const c of validCheckins) tx.objectStore(STORE_CHECKINS).put(c);
    for (const r of validRi) tx.objectStore(STORE_RI).put(r);
    for (const s of validSessions) tx.objectStore(STORE_SESSIONS).put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  if (calibration) saveCalibration(calibration);
  if (activeMatchId !== undefined) saveActiveMatchId(activeMatchId);

  return {
    matchesAdded: validMatches.length,
    checkinsAdded: validCheckins.length,
    riAdded: validRi.length,
    sessionsAdded: validSessions.length,
    skipped,
  };
}

export function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
