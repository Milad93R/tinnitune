import React, { useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Download,
  Music,
  Share2,
  Timer,
  Trash2,
  TrendingDown,
  Upload,
  Waves,
} from 'lucide-react';
import { designDigitalBandpass } from '../audio/dsp';
import { buildExportBundle, importExportBundle, isJournalDateKey, isJournalTimestamp, makeId } from '../storage/db';
import {
  RELIEF_NOISE_META,
  SOUND_TYPE_META,
  type JournalCheckIn,
  type ResidualInhibitionRecord,
  type TherapySessionRecord,
  type TinnitusMatch,
} from '../types';
import {
  formatDateTime,
  formatDurationHuman,
  formatEarLabel,
  formatHz,
  formatKhzCompact,
  formatShareHeadline,
  formatShortDate,
  formatShortTime,
  renderShareCardDataUrl,
  todayDateKey,
} from '../utils/format';
import { ShareSheet } from './ShareSheet';
import { MiniSpectrum } from './MiniSpectrum';

interface JournalViewProps {
  matches: TinnitusMatch[];
  sampleRate: number;
  checkins: JournalCheckIn[];
  riTests: ResidualInhibitionRecord[];
  sessions: TherapySessionRecord[];
  activeMatchId: string | null;
  onAddCheckIn: (entry: JournalCheckIn) => Promise<void>;
  onDeleteCheckIn: (id: string) => Promise<void>;
  onDeleteMatch: (id: string) => Promise<void>;
  onDeleteRI: (id: string) => Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
  onSelectActiveMatch: (match: TinnitusMatch) => void;
  onReloadAll: () => Promise<void>;
  onNotify: (msg: string) => void;
}

const CONTEXT_TAGS = [
  'Quiet room',
  'After sleep',
  'High stress',
  'Caffeine',
  'Loud environment',
  'After therapy',
];

const SESSION_END_LABEL: Record<NonNullable<TherapySessionRecord['endReason']>, string> = {
  completed: 'Completed',
  paused: 'Paused',
  muted: 'Muted',
  left: 'Left tool',
  replaced: 'Switched track',
  interrupted: 'Interrupted',
};

type HistoryFilter = 'all' | 'matches' | 'checkins' | 'ri' | 'sessions';
const DELETE_LABEL = {
  matches: 'match',
  checkins: 'check-in',
  ri: 'residual inhibition record',
  sessions: 'therapy session',
};
type RecordType = keyof typeof DELETE_LABEL;

export const JournalView: React.FC<JournalViewProps> = ({
  matches,
  sampleRate,
  checkins,
  riTests,
  sessions,
  activeMatchId,
  onAddCheckIn,
  onDeleteCheckIn,
  onDeleteMatch,
  onDeleteRI,
  onDeleteSession,
  onSelectActiveMatch,
  onReloadAll,
  onNotify,
}) => {
  const [loudness, setLoudness] = useState<number>(5);
  const [annoyance, setAnnoyance] = useState<number>(4);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [note, setNote] = useState<string>('');
  const [savingCheckIn, setSavingCheckIn] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const lastSubmission = useRef(-Infinity);
  const retryCheckIn = useRef<JournalCheckIn | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [sharePreview, setSharePreview] = useState<{ url: string; headline: string; hz: number; opener: HTMLButtonElement } | null>(
    null
  );
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [pendingDelete, setPendingDelete] = useState<{ type: RecordType; id: string; opener: HTMLButtonElement } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const deletionInProgress = useRef(false);
  const deletePromptId = useId();
  const historyHeading = useRef<HTMLHeadingElement>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  const confirmDelete = async () => {
    if (!pendingDelete || deletionInProgress.current) return;
    const deleteRecord = { matches: onDeleteMatch, checkins: onDeleteCheckIn, ri: onDeleteRI, sessions: onDeleteSession };
    deletionInProgress.current = true;
    setDeleting(true);
    setDeleteError(false);
    try {
      await deleteRecord[pendingDelete.type](pendingDelete.id);
      setPendingDelete(null);
      historyHeading.current?.focus({ preventScroll: true });
    } catch {
      setDeleteError(true);
    } finally {
      deletionInProgress.current = false;
      setDeleting(false);
    }
  };

  const isDeletePending = (type: RecordType, id: string) => pendingDelete?.type === type && pendingDelete.id === id;

  const deleteButton = (type: RecordType, id: string) => {
    const pending = isDeletePending(type, id);
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={(event) => {
          if (deletionInProgress.current || pending) return;
          setDeleteError(false);
          setPendingDelete({ type, id, opener: event.currentTarget });
        }}
        aria-label={`Delete ${DELETE_LABEL[type]}`}
        aria-expanded={pending}
        aria-controls={pending ? deletePromptId : undefined}
        data-testid={type === 'sessions' ? 'delete-session-btn' : undefined}
      >
        <Trash2 size={14} />
      </button>
    );
  };

  const deletePrompt = (type: RecordType, id: string) => isDeletePending(type, id) && (
    <div className="history-delete-prompt" id={deletePromptId} data-testid="history-delete-prompt">
      <strong>Delete this {DELETE_LABEL[type]}?</strong>
      <div className="history-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={deleting} onClick={() => {
          pendingDelete?.opener.focus();
          setPendingDelete(null);
        }}>Cancel</button>
        <button type="button" className="btn btn-amber btn-sm" disabled={deleting}
          onClick={() => void confirmDelete()}>Delete</button>
      </div>
      {deleteError && <p role="alert">Could not delete this record. Try again.</p>}
    </div>
  );

  const toggleTag = (tag: string) => {
    lastSubmission.current = -Infinity;
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const handleSaveCheckIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    lastSubmission.current = performance.now();
    setSavingCheckIn(true);
    setCheckInError(null);
    const entry: JournalCheckIn = {
      id: retryCheckIn.current?.id ?? makeId('chk'),
      createdAt: retryCheckIn.current?.createdAt ?? Date.now(),
      dateKey: retryCheckIn.current?.dateKey ?? todayDateKey(),
      loudness,
      annoyance,
      tags: selectedTags,
      note: note.trim(),
    };
    retryCheckIn.current = entry;
    try {
      await onAddCheckIn(entry);
      retryCheckIn.current = null;
      setNote('');
      setSelectedTags([]);
      onNotify('Daily check-in saved');
    } catch {
      lastSubmission.current = -Infinity;
      setCheckInError('Could not save the check-in. Try again.');
    } finally {
      savingRef.current = false;
      setSavingCheckIn(false);
    }
  };

  const handleExportJson = async () => {
    const bundle = await buildExportBundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tinnitune-journal-${todayDateKey()}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onNotify('Journal JSON exported');
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      const summary = await importExportBundle(text);
      await onReloadAll();
      if (summary.skipped) {
        const label = summary.skipped === 1 ? 'record was' : 'records were';
        setImportError(`${summary.skipped} ${label} skipped because required fields or dates were invalid.`);
      }
      onNotify(
        (() => {
          const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
          const parts = [
            summary.matchesAdded ? n(summary.matchesAdded, 'match', 'matches') : '',
            summary.checkinsAdded ? n(summary.checkinsAdded, 'check-in', 'check-ins') : '',
            summary.riAdded ? n(summary.riAdded, 'RI test', 'RI tests') : '',
            summary.sessionsAdded ? n(summary.sessionsAdded, 'session', 'sessions') : '',
          ].filter(Boolean);
          return parts.length ? `Imported ${parts.join(', ')}` : 'Backup read — nothing new to import';
        })()
      );
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import JSON.');
    }
  };

  const handleShareMatch = (match: TinnitusMatch, opener: HTMLButtonElement) => {
    const url = renderShareCardDataUrl(match, sampleRate);
    setSharePreview({
      url,
      headline: formatShareHeadline(match),
      hz: match.frequencyHz,
      opener,
    });
  };

  const chartCheckins = useMemo(() => {
    return checkins.filter((item) => isJournalTimestamp(item.createdAt) && isJournalDateKey(item.dateKey))
      .sort((a, b) => a.createdAt - b.createdAt).slice(-14);
  }, [checkins]);

  const avgLoudness = useMemo(() => {
    const valid = checkins.filter((item) => isJournalTimestamp(item.createdAt) && isJournalDateKey(item.dateKey));
    if (!valid.length) return null;
    const sum = valid.reduce((s, c) => s + Math.max(1, Math.min(10, c.loudness)), 0);
    return (sum / valid.length).toFixed(1);
  }, [checkins]);

  const avgRI = useMemo(() => {
    if (!riTests.length) return null;
    return (riTests.reduce((s, r) => s + r.reliefSeconds, 0) / riTests.length).toFixed(1);
  }, [riTests]);

  const visibleCount =
    historyFilter === 'all'
      ? matches.length + checkins.length + riTests.length + sessions.length
      : historyFilter === 'matches'
      ? matches.length
      : historyFilter === 'checkins'
      ? checkins.length
      : historyFilter === 'ri'
      ? riTests.length
      : sessions.length;

  return (
    <div className="view-stack journal-view">
      <div className="section-head-row">
        <div>
          <div className="eyebrow">Saved on this device</div>
          <h1>Tinnitus Journal</h1>
        </div>

        <div className="header-actions-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void handleExportJson()}
            data-testid="export-json-btn"
          >
            <Download size={15} /> Export JSON
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => importInputRef.current?.click()}
            data-testid="import-json-btn"
          >
            <Upload size={15} /> Import JSON
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              void handleImportFile(e.target.files?.[0]);
              e.currentTarget.value = '';
            }}
            data-testid="import-json-input"
          />
        </div>
      </div>

      {importError && (
        <div className="inline-error" role="alert" data-testid="import-error">
          {importError}
        </div>
      )}

      <div className="journal-top-grid">
        <article className={`panel-card journal-trend ${chartCheckins.length ? 'has-entries' : ''}`}>
          <div className="card-head">
            <div className="card-title-group">
              <TrendingDown size={18} className="accent-teal" />
              <h2>Loudness &amp; Annoyance Trend</h2>
            </div>
            <div className="chart-legend">
              <span className="legend-dot amber">Loudness</span>
              <span className="legend-dot violet">Annoyance</span>
            </div>
          </div>

          {chartCheckins.length === 0 ? (
            <div className="empty-chart empty-chart-illustrated" data-testid="empty-chart-state">
              <img
                src="/art/field-notes.webp"
                alt=""
                aria-hidden="true"
                className="empty-state-art"
                loading="lazy"
                width={640}
                height={320}
              />
              <p>Log your first daily check-in to start visualizing trends over time.</p>
              <span className="hint-text">All history stays privately in IndexedDB on this device.</span>
            </div>
          ) : (
            <TrendChart entries={chartCheckins} />
          )}

          {matches.length > 0 && (
            <div className="share-quick-bar">
              <div>
                <strong>Share latest match card</strong>
                <p className="hint-text">{formatShareHeadline(matches[0])}</p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={(e) => handleShareMatch(matches[0], e.currentTarget)}
                data-testid="journal-share-latest"
              >
                <Share2 size={15} /> Share Image
              </button>
            </div>
          )}
        </article>
        {/* Daily Check-in Form */}
        <form className="panel-card" onSubmit={(e) => void handleSaveCheckIn(e)} data-testid="checkin-form">
          <div className="card-head">
            <h2>Daily Check-In</h2>
            <span className="mono subtle-pill">{todayDateKey()}</span>
          </div>

          <div className="scale-block">
            <div className="slider-header">
              <label>Loudness (1 = barely there · 10 = very loud)</label>
              <strong className="mono accent-amber">{loudness} / 10</strong>
            </div>
            <div className="rating-row" role="radiogroup" aria-label="Loudness rating 1 to 10">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={loudness === n}
                  className={`rating-pill ${loudness === n ? 'active amber' : ''}`}
                  onClick={() => { lastSubmission.current = -Infinity; setLoudness(n); }}
                  data-testid={`loudness-rate-${n}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="scale-block">
            <div className="slider-header">
              <label>Annoyance / Intrusiveness (1 = calm · 10 = exhausting)</label>
              <strong className="mono accent-violet">{annoyance} / 10</strong>
            </div>
            <div className="rating-row" role="radiogroup" aria-label="Annoyance rating 1 to 10">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={annoyance === n}
                  className={`rating-pill ${annoyance === n ? 'active violet' : ''}`}
                  onClick={() => { lastSubmission.current = -Infinity; setAnnoyance(n); }}
                  data-testid={`annoyance-rate-${n}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="tags-wrap">
            {CONTEXT_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`tag-chip ${selectedTags.includes(tag) ? 'selected' : ''}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>

          <textarea
            className="note-input"
            dir="auto"
            rows={2}
            placeholder="Optional note (sleep quality, triggers, quiet moments)..."
            value={note}
            onChange={(e) => { lastSubmission.current = -Infinity; setNote(e.target.value); }}
            data-testid="checkin-note-input"
          />

          {checkInError && <p className="inline-error" role="alert">{checkInError}</p>}
          <button type="submit" className="btn btn-primary" data-testid="save-checkin-btn"
            disabled={savingCheckIn}
            onClick={(event) => {
              if (event.detail > 1 && performance.now() - lastSubmission.current < 750) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
            }}>
            <CheckCircle2 size={17} /> Save Today&apos;s Check-In
          </button>
        </form>
      </div>

      {/* Summary Metrics Strip */}
      <div className="metrics-strip">
        <div className="stat-box">
          <span className="stat-label">Logged Matches</span>
          <strong className="mono">{matches.length}</strong>
        </div>
        <div className="stat-box">
          <span className="stat-label">Avg Loudness</span>
          <strong className="mono" data-testid="metric-avg-loudness">
            {avgLoudness ? `${avgLoudness} / 10` : '—'}
          </strong>
        </div>
        <div className="stat-box">
          <span className="stat-label">Avg Residual Inhib.</span>
          <strong className="mono">{avgRI ? `${avgRI} s` : '—'}</strong>
        </div>
        <div className="stat-box">
          <span className="stat-label">Therapy Sessions</span>
          <strong className="mono" data-testid="metric-sessions-count">
            {sessions.length}
          </strong>
        </div>
      </div>

      {/* Share Card Preview Panel */}
      {sharePreview && (
        <ShareSheet
          headline={sharePreview.headline}
          description="Spoiler-free acoustic card · Zero personal or medical history included"
          url={sharePreview.url}
          testId="journal-share-preview"
          opener={sharePreview.opener}
          onClose={() => setSharePreview(null)}
          onDownload={() => {
            const a = document.createElement('a');
            a.href = sharePreview.url;
            a.download = `tinnitune-${Math.round(sharePreview.hz)}hz.png`;
            a.click();
            onNotify('Share card downloaded');
          }}
        />
      )}

      {/* History Timeline */}
      <section className="panel-card">
        <div className="card-head history-head">
          <h2 ref={historyHeading} tabIndex={-1}>History</h2>
          <div className="pill-row">
            {(
              [
                ['all', 'All'],
                ['matches', `Matches (${matches.length})`],
                ['checkins', `Check-ins (${checkins.length})`],
                ['ri', `RI Tests (${riTests.length})`],
                ['sessions', `Sessions (${sessions.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`mini-pill-btn ${historyFilter === key ? 'active' : ''}`}
                onClick={() => {
                  if (deletionInProgress.current || key === historyFilter) return;
                  setPendingDelete(null);
                  setHistoryFilter(key);
                }}
                data-testid={`history-filter-${key}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {visibleCount === 0 ? (
          <div className="empty-list">
            {historyFilter === 'all'
              ? 'No saved entries yet. Complete a pitch match, run a notched therapy session or residual-inhibition test, or log a daily check-in above.'
              : `No ${historyFilter === 'ri' ? 'residual inhibition tests' : historyFilter} logged yet.`}
          </div>
        ) : (
          <div className="history-list" data-testid="journal-history-list">
            {(historyFilter === 'all' || historyFilter === 'matches') &&
              matches.map((m) => (
                <React.Fragment key={m.id}>
                  <div className="history-row match-row" data-testid="history-match-row">
                    <div className="history-main">
                      <div className="history-title-line">
                        <Activity size={15} className="accent-amber" />
                        <strong>
                          {formatHz(m.frequencyHz)} · {SOUND_TYPE_META[m.soundType].label}
                        </strong>
                        <span className="subtle-pill">{formatEarLabel(m.ear)}</span>
                        {m.id === activeMatchId && <span className="verified-pill">Active</span>}
                      </div>
                      <span className="hint-text mono">{formatDateTime(m.createdAt)}</span>
                    </div>

                    <MiniSpectrum
                      frequencyHz={m.frequencyHz}
                      soundType={m.soundType}
                      band={SOUND_TYPE_META[m.soundType].hasBandwidth
                        ? designDigitalBandpass(m.frequencyHz, m.bandwidthOct, sampleRate) : undefined}
                      compact
                    />

                    <div className="history-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => onSelectActiveMatch(m)}
                      >
                        <Waves size={14} /> Use
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={(e) => handleShareMatch(m, e.currentTarget)}
                        aria-label="Generate share card for this match"
                      >
                        <Share2 size={14} />
                      </button>
                      {deleteButton('matches', m.id)}
                    </div>
                  </div>
                  {deletePrompt('matches', m.id)}
                </React.Fragment>
              ))}

            {(historyFilter === 'all' || historyFilter === 'checkins') &&
              checkins.map((c) => (
                <React.Fragment key={c.id}>
                  <div className="history-row" data-testid="history-checkin-row">
                    <div className="history-main">
                      <div className="history-title-line">
                        <strong>Daily Check-In</strong>
                        <span className="mono accent-amber">Loudness {c.loudness}/10</span>
                        <span className="mono accent-violet">Annoyance {c.annoyance}/10</span>
                      </div>
                      <div className="history-sub">
                        <span className="hint-text mono">{formatDateTime(c.createdAt)}</span>
                        {c.tags.length > 0 && <span className="hint-text">· {c.tags.join(', ')}</span>}
                      </div>
                      {c.note && <HistoryNote text={c.note} />}
                    </div>
                    {deleteButton('checkins', c.id)}
                  </div>
                  {deletePrompt('checkins', c.id)}
                </React.Fragment>
              ))}

            {(historyFilter === 'all' || historyFilter === 'ri') &&
              riTests.map((r) => (
                <React.Fragment key={r.id}>
                  <div className="history-row" data-testid="history-ri-row">
                    <div className="history-main">
                      <div className="history-title-line">
                        <Timer size={15} className="accent-teal" />
                        <strong>
                          Residual Inhibition:{' '}
                          <span className="mono accent-teal">{r.reliefSeconds.toFixed(1)} s</span>
                        </strong>
                        <span className="subtle-pill mono">
                          {formatKhzCompact(r.frequencyHz)} · {formatEarLabel(r.ear)} · {r.stimulusSeconds}s mask
                        </span>
                      </div>
                      <span className="hint-text mono">{formatDateTime(r.createdAt)}</span>
                    </div>
                    {deleteButton('ri', r.id)}
                  </div>
                  {deletePrompt('ri', r.id)}
                </React.Fragment>
              ))}

            {(historyFilter === 'all' || historyFilter === 'sessions') &&
              sessions.map((s) => {
                const isMusic = s.mode === 'notched-music';
                const bedLabel = s.noiseType ? RELIEF_NOISE_META[s.noiseType].label : 'Sound';
                return (
                  <React.Fragment key={s.id}>
                    <div className="history-row" data-testid="history-session-row">
                      <div className="history-main">
                        <div className="history-title-line">
                          {isMusic ? (
                            <Music size={15} className="accent-teal" />
                          ) : (
                            <Waves size={15} className="accent-teal" />
                          )}
                          <strong>{isMusic ? 'Music' : `${bedLabel} Therapy`}</strong>
                          <span className="subtle-pill mono">
                            {(!Number.isInteger(s.durationSeconds) || s.filterSegments?.some((segment) => !Number.isInteger(segment.durationSeconds))) && '≈'}
                            {formatDurationHuman(s.durationSeconds)}
                          </span>
                        </div>
                        {isMusic && s.trackName && (
                          <bdi className="history-track track-filename" title={s.trackName}>{s.trackName}</bdi>
                        )}
                        <div className="hint-text mono" data-testid="history-session-filter">
                          {s.filterSegments?.length ? s.filterSegments.map((segment, index) => (
                            <div key={index}>
                              {segment.noiseType && `${RELIEF_NOISE_META[segment.noiseType].label} · `}
                              {segment.state === 'notched'
                                ? `Notched · ${formatKhzCompact(segment.frequencyHz)} · ${segment.notchWidthOct.toFixed(1)} oct`
                                : 'Bypassed'}
                              {' · '}{segment.durationSeconds < 1 ? '<1s'
                                : `${Number.isInteger(segment.durationSeconds) ? '' : '≈'}${formatDurationHuman(segment.durationSeconds)}`}
                            </div>
                          )) : 'Filter state unavailable'}
                        </div>
                        <span className="hint-text mono">
                          {formatDateTime(s.createdAt)}{s.endReason ? ` · ${SESSION_END_LABEL[s.endReason]}` : ''}
                        </span>
                      </div>
                      {deleteButton('sessions', s.id)}
                    </div>
                    {deletePrompt('sessions', s.id)}
                  </React.Fragment>
                );
              })}
          </div>
        )}
      </section>
    </div>
  );
};

const HistoryNote = React.memo(function HistoryNote({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const noteId = useId();
  const preview = text.match(/^[^\r\n]{0,180}/u)?.[0] ?? '';
  const canExpand = preview.length < text.length;
  const visibleText = canExpand && !expanded ? `${preview.trimEnd()}…` : text;
  // Explicit breaks keep long mixed-script words within WebKit's card width.
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return (
    <>
      <p id={noteId} className="history-note" dir="auto">
        {visibleText.split(/(\S{32,})/u).map((part, partIndex) => {
          if (partIndex % 2 === 0) return part;
          const characters = segmenter ? Array.from(segmenter.segment(part), (item) => item.segment) : Array.from(part);
          const parts = [];
          for (let i = 0; i < characters.length; i += 24) {
            parts.push(
              <React.Fragment key={i}>
                {i > 0 && <wbr />}
                {characters.slice(i, i + 24).join('')}
              </React.Fragment>,
            );
          }
          return <React.Fragment key={partIndex}>{parts}</React.Fragment>;
        })}
      </p>
      {canExpand && (
        <button type="button" className="btn btn-ghost btn-sm history-note-toggle"
          aria-expanded={expanded} aria-controls={noteId}
          onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Read full note'}
        </button>
      )}
    </>
  );
});

const TrendChart: React.FC<{ entries: JournalCheckIn[] }> = ({ entries }) => {
  const w = 460;
  const h = 194;
  const padL = 34;
  const padR = 36;
  const padT = 16;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const clampRating = (val: number) => Math.max(1, Math.min(10, Number.isFinite(val) ? val : 1));
  const xAt = (idx: number) =>
    entries.length <= 1 ? padL + plotW / 2 : padL + (idx / (entries.length - 1)) * plotW;
  const yAt = (val: number) => padT + plotH - ((clampRating(val) - 1) / 9) * plotH;

  const loudPts = entries.map((e, i) => `${xAt(i).toFixed(1)},${yAt(e.loudness).toFixed(1)}`);
  const annoyPts = entries.map((e, i) => `${xAt(i).toFixed(1)},${yAt(e.annoyance).toFixed(1)}`);

  // Determine which tick indices to display and disambiguate same-day labels cleanly
  const shownIndices = entries
    .map((_, i) => i)
    .filter((i) => i === 0 || i === entries.length - 1 || entries.length <= 6);

  const seenDays = new Set<string>();
  const minuteCounts = new Map<string, number>();
  const tickLabels = new Map<number, string>();
  for (const i of shownIndices) {
    const entry = entries[i];
    const day = formatShortDate(entry.createdAt);
    const time = formatShortTime(entry.createdAt);
    const minute = `${entry.dateKey}:${time}`;
    const count = (minuteCounts.get(minute) ?? 0) + 1;
    minuteCounts.set(minute, count);
    tickLabels.set(i, !seenDays.has(entry.dateKey) ? day : count === 1 ? time : `${time} #${count}`);
    seenDays.add(entry.dateKey);
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="trend-chart-svg"
      role="img"
      aria-label="Loudness and annoyance trend chart"
      data-testid="trend-chart-svg"
    >
      {[1, 5, 10].map((v) => {
        const y = yAt(v);
        return (
          <g key={v}>
            <line
              x1={padL}
              y1={y}
              x2={w - padR}
              y2={y}
              stroke="rgba(80,65,36,0.22)"
              strokeDasharray="3 3"
            />
            <text
              x={padL - 8}
              y={y + 4}
              textAnchor="end"
              fill="#554c39"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
            >
              {v}
            </text>
          </g>
        );
      })}

      {entries.length > 1 && (
        <>
          <polyline
            fill="none"
            stroke="#863926"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={loudPts.join(' ')}
          />
          <polyline
            fill="none"
            stroke="#48536b"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={annoyPts.join(' ')}
          />
        </>
      )}

      {entries.map((e, i) => {
        const tickText = tickLabels.get(i);
        return (
          <g key={e.id}>
            <circle cx={xAt(i)} cy={yAt(e.loudness)} r="4" fill="#863926" />
            <circle cx={xAt(i)} cy={yAt(e.annoyance)} r="4" fill="#48536b" />
            {tickText && (
              <text
                x={xAt(i)}
                y={h - 10}
                textAnchor="middle"
                fill="#554c39"
                fontSize="9.5"
                fontFamily="JetBrains Mono, monospace"
              >
                {tickText}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};
