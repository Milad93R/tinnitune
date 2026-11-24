import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDeviceCalibration, parseExportBundle, saveCalibration, saveDeviceConfirmations } from '../src/storage/db.ts';

const dateKey = '2024-02-29';
const createdAt = Date.parse(`${dateKey}T12:30:00Z`);
const note = `Quiet after rain. ${'Aژ🎧'.repeat(800)}\nEND-MARKER`;
const calibration = {
  ear: 'right', comfortLevel: 0.1, headphonesChecked: true,
  leftHeard: true, rightHeard: true, safetyAcknowledged: true,
};
const bundle = {
  app: 'tinnitune', version: 1, exportedAt: new Date(createdAt).toISOString(), calibration,
  activeMatchId: 'match-1',
  matches: [{
    id: 'match-1', createdAt, soundType: 'crickets', ear: 'right', loudness: 5,
    frequencyHz: 15500, bandwidthOct: 0.2, pulseRateHz: 24, octaveVerified: true, note,
  }],
  checkins: [{ id: 'check-in', createdAt, dateKey, loudness: 5, annoyance: 2, tags: ['Quiet room', 'آرام'], note }],
  riTests: [{ id: 'ri', createdAt, frequencyHz: 15500, ear: 'right', stimulusSeconds: 0.7, reliefSeconds: 3712.5, note }],
  sessions: [{
    id: 'session', createdAt, mode: 'notched-music', trackName: `${'Aژ🎧'.repeat(85)}.wav`,
    frequencyHz: 15500, notchWidthOct: 1.5, durationSeconds: 900, endReason: 'muted',
  }],
};

test('backup codec round-trips every journal store, calibration and selection', () => {
  const raw = JSON.stringify(bundle);
  const { validMatches, validCheckins, validRi, validSessions, calibration, activeMatchId, skipped } = parseExportBundle(raw);
  const rebuilt = JSON.parse(JSON.stringify({
    ...bundle, matches: validMatches, checkins: validCheckins, riTests: validRi, sessions: validSessions, calibration, activeMatchId,
  }));
  assert.deepEqual(rebuilt, bundle);
  assert.equal(skipped, 0);
  assert.equal(parseExportBundle(JSON.stringify({ ...bundle, activeMatchId: null })).activeMatchId, null);
});

test('session backups preserve ordered filter and bed segments and accept older records', () => {
  const legacy = bundle.sessions[0];
  const mixed = {
    ...legacy, id: 'mixed', mode: 'notched-noise', noiseType: 'rain', durationSeconds: 18, endReason: 'interrupted',
    filterSegments: [
      { state: 'bypassed', durationSeconds: 3.125, noiseType: 'rain' },
      { state: 'notched', durationSeconds: 8.875, frequencyHz: 4500, notchWidthOct: 0.5, noiseType: 'ocean' },
      { state: 'bypassed', durationSeconds: 6.012 },
    ],
  };
  const partial = {
    ...mixed, id: 'partial',
    filterSegments: [mixed.filterSegments[0], { state: 'unknown', durationSeconds: 14.875 }],
  };
  const { validSessions } = parseExportBundle(JSON.stringify({ ...bundle, sessions: [mixed, legacy, partial] }));
  const [mixedResult, legacyResult, partialResult] = validSessions;
  assert.deepEqual(mixedResult.filterSegments, mixed.filterSegments);
  assert.equal(mixedResult.endReason, 'interrupted');
  assert.equal(legacyResult.filterSegments, undefined);
  assert.equal(partialResult.filterSegments, undefined);
});

test('invalid calendar dates and unsupported timestamps are counted and skipped', () => {
  const checkin = bundle.checkins[0];
  const checkins = [
    checkin,
    { ...checkin, id: 'not-a-leap-year', dateKey: '2023-02-29' },
    { ...checkin, id: 'bad-calendar', dateKey: '2024-04-31' },
    { ...checkin, id: 'too-far', createdAt: 9e15 },
  ];
  const { validCheckins, skipped } = parseExportBundle(JSON.stringify({ ...bundle, checkins }));
  assert.deepEqual(validCheckins, [checkin]);
  assert.equal(skipped, 3);
});

test('malformed and foreign backups are rejected before persistence', () => {
  assert.throws(() => parseExportBundle('{'), /Invalid JSON/);
  assert.throws(() => parseExportBundle('{"app":"other","version":1}'), /Tinnitune v1/);
});

test('backed-up comfort settings cannot grant device confirmation', (t) => {
  const entries = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  saveCalibration(calibration);
  assert.deepEqual(loadDeviceCalibration(), {
    ...calibration, safetyAcknowledged: false, leftHeard: false, rightHeard: false, headphonesChecked: false,
  });
  saveDeviceConfirmations(calibration);
  assert.deepEqual(loadDeviceCalibration(), calibration);
});
