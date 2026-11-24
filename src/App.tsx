import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { audioEngine, type EngineSnapshot } from './audio/engine';
import { EducationView } from './components/EducationView';
import { Header } from './components/Header';
import { JournalView } from './components/JournalView';
import { MatchView } from './components/MatchView';
import { ReliefView, type ReliefMatchSelection } from './components/ReliefView';
import { SetupView } from './components/SetupView';
import { useVisibleViewport } from './hooks/useVisibleViewport';
import {
  dbDeleteCheckIn,
  dbDeleteMatch,
  dbDeleteRITest,
  dbDeleteSession,
  dbSaveCheckIn,
  dbSaveMatch,
  dbSaveRITest,
  dbSaveSession,
  loadActiveMatchId,
  loadAllJournalData,
  loadCalibration,
  loadDeviceCalibration,
  loadReliefDraft,
  recoverSessionCheckpoints,
  saveActiveMatchId,
  saveCalibration,
  saveDeviceConfirmations,
  saveReliefDraft,
} from './storage/db';
import type {
  AppTab,
  JournalCheckIn,
  ResidualInhibitionRecord,
  SetupCalibration,
  TherapySessionRecord,
  TinnitusMatch,
} from './types';

function readHashTab(): AppTab | null {
  const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  if (hash === 'setup' || hash === 'match' || hash === 'relief' || hash === 'journal' || hash === 'learn') {
    return hash;
  }
  return null;
}

function readReliefHandoff(): { id: string; match: TinnitusMatch | null } | null {
  const id = window.history.state?.reliefDraftId;
  if (id === null) return null;
  const draft = loadReliefDraft();
  if (typeof id === 'string') return { id, match: draft?.id === id ? draft : null };
  return draft ? { id: draft.id, match: draft } : null;
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const fromHash = readHashTab();
    if (fromHash) return fromHash;
    const cal = loadDeviceCalibration();
    return cal.safetyAcknowledged ? 'match' : 'setup';
  });

  const [calibration, setCalibration] = useState<SetupCalibration>(loadDeviceCalibration);
  const calibrationRef = useRef(calibration);
  const [journalReady, setJournalReady] = useState(false);
  const [engineState, setEngineState] = useState<EngineSnapshot>(() => audioEngine.getSnapshot());
  const [matches, setMatches] = useState<TinnitusMatch[]>([]);
  const [checkins, setCheckins] = useState<JournalCheckIn[]>([]);
  const [riTests, setRiTests] = useState<ResidualInhibitionRecord[]>([]);
  const [sessions, setSessions] = useState<TherapySessionRecord[]>([]);
  const [activeMatchId, setActiveMatchId] = useState<string | null>(() => loadActiveMatchId());
  const [reliefHandoff, setReliefHandoff] = useState(readReliefHandoff);
  const reliefDraftId = reliefHandoff?.id ?? null;
  const [notification, setNotification] = useState<{ message: string; showToast: boolean } | null>(null);

  useVisibleViewport(useCallback((viewport) => {
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--viewport-covered-bottom', `${covered}px`);
  }, []));

  const notify = useCallback((message: string, showToast = true) => {
    setNotification({ message, showToast });
  }, []);

  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 3200);
    return () => window.clearTimeout(id);
  }, [notification]);

  const applyCalibration = useCallback((next: SetupCalibration) => {
    if (next.ear !== calibrationRef.current.ear) audioEngine.setEar(next.ear);
    calibrationRef.current = next;
    audioEngine.setSafetyAcknowledged(next.safetyAcknowledged);
    audioEngine.setComfortLevel(next.comfortLevel);
    setCalibration(next);
  }, []);

  const reloadAll = useCallback(async () => {
    applyCalibration(loadDeviceCalibration());
    try {
      await recoverSessionCheckpoints();
      const data = await loadAllJournalData();
      setMatches(data.matches);
      setCheckins(data.checkins);
      setRiTests(data.riTests);
      setSessions(data.sessions);
      const savedId = loadActiveMatchId();
      if (savedId && data.matches.some((m) => m.id === savedId)) {
        setActiveMatchId(savedId);
      } else {
        setActiveMatchId(null);
        if (savedId) saveActiveMatchId(null);
      }
    } catch {
      // IndexedDB unavailable (private mode fallback)
    } finally {
      setJournalReady(true);
    }
  }, [applyCalibration]);

  useEffect(() => {
    const unsub = audioEngine.subscribe(setEngineState);
    void reloadAll();

    // Seed initial history hash so Back/Forward stays cleanly inside tab history
    if (!readHashTab()) {
      window.history.replaceState({ ...window.history.state, tab: activeTab }, '', `#${activeTab}`);
    }

    const syncTabFromHistory = () => {
      audioEngine.stop(0.04, 'left');
      const next = readHashTab() ?? (loadDeviceCalibration().safetyAcknowledged ? 'match' : 'setup');
      setActiveTab(next);
    };

    const stopOnPageHide = () => audioEngine.stop(0.04, 'interrupted');
    const restoreOnPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void reloadAll();
    };
    window.addEventListener('pageshow', restoreOnPageShow);
    window.addEventListener('pagehide', stopOnPageHide);
    window.addEventListener('hashchange', syncTabFromHistory);
    window.addEventListener('popstate', syncTabFromHistory);
    return () => {
      unsub();
      window.removeEventListener('pagehide', stopOnPageHide);
      window.removeEventListener('pageshow', restoreOnPageShow);
      window.removeEventListener('hashchange', syncTabFromHistory);
      window.removeEventListener('popstate', syncTabFromHistory);
    };
  }, [reloadAll]);

  // Keep a marker independent of the draft payload so a reload can fail closed.
  useLayoutEffect(() => {
    if (window.history.state?.reliefDraftId !== reliefDraftId) {
      window.history.replaceState({ ...window.history.state, reliefDraftId }, '');
    }
  }, [activeTab, reliefDraftId]);

  const handleSelectTab = (tab: AppTab) => {
    if (tab !== activeTab) {
      audioEngine.stop(0.04, 'left');
      setActiveTab(tab);
      if (window.location.hash !== `#${tab}`) {
        window.history.pushState({ tab, reliefDraftId }, '', `#${tab}`);
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  };

  const handleUpdateCalibration = (patch: Partial<SetupCalibration>) => {
    const next = { ...calibrationRef.current, ...patch };
    saveCalibration({ ...loadCalibration(), ...patch });
    if (patch.safetyAcknowledged !== undefined || patch.leftHeard !== undefined || patch.rightHeard !== undefined) {
      saveDeviceConfirmations(next);
    }
    applyCalibration(next);
  };

  const activeMatch = useMemo(() => {
    if (!matches.length) return null;
    return matches.find((m) => m.id === activeMatchId) ?? matches[0];
  }, [matches, activeMatchId]);

  const reliefMatch: ReliefMatchSelection = reliefHandoff
    ? { match: reliefHandoff.match, saved: false, previous: activeMatch }
    : { match: activeMatch, saved: true };
  const reviewSetup = calibration.safetyAcknowledged ? undefined : () => handleSelectTab('setup');

  const selectSavedMatch = (match: TinnitusMatch) => {
    setActiveMatchId(match.id);
    saveReliefDraft(null);
    setReliefHandoff(null);
    saveActiveMatchId(match.id);
  };

  const handleSaveMatch = async (match: TinnitusMatch) => {
    await dbSaveMatch(match);
    setMatches((prev) => [match, ...prev.filter((m) => m.id !== match.id)]);
    selectSavedMatch(match);
    notify('Tinnitus signature saved to journal', false);
  };

  const handleAddCheckIn = async (entry: JournalCheckIn) => {
    await dbSaveCheckIn(entry);
    setCheckins((prev) => [entry, ...prev.filter((item) => item.id !== entry.id)]);
  };

  const handleLogRITest = async (record: ResidualInhibitionRecord) => {
    await dbSaveRITest(record);
    setRiTests((prev) => [record, ...prev]);
  };

  const handleLogSession = useCallback(async (record: TherapySessionRecord) => {
    await dbSaveSession(record);
    setSessions((prev) => [record, ...prev.filter((item) => item.id !== record.id)]);
  }, []);

  const handleDeleteMatch = async (id: string) => {
    await dbDeleteMatch(id);
    setMatches((prev) => {
      const next = prev.filter((m) => m.id !== id);
      if (activeMatchId === id) {
        const fallback = next[0]?.id ?? null;
        setActiveMatchId(fallback);
        saveActiveMatchId(fallback);
      }
      return next;
    });
    notify('Match removed');
  };

  const handleDeleteCheckIn = async (id: string) => {
    await dbDeleteCheckIn(id);
    setCheckins((prev) => prev.filter((c) => c.id !== id));
    notify('Check-in removed');
  };

  const handleDeleteRI = async (id: string) => {
    await dbDeleteRITest(id);
    setRiTests((prev) => prev.filter((r) => r.id !== id));
    notify('Residual inhibition entry removed');
  };

  const handleDeleteSession = async (id: string) => {
    await dbDeleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    notify('Therapy session removed');
  };

  return (
    <div className="app-shell">
      <Header
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        isPlaying={engineState.isPlaying}
        onStopAudio={() => audioEngine.stop(0.04)}
        activeMatch={reliefMatch.match}
      />

      <main className="main-container" id="main-content">
        {!calibration.safetyAcknowledged && (activeTab === 'match' || activeTab === 'relief') && (
          <div className="safety-callout">
            <button type="button" className="btn btn-secondary" onClick={() => handleSelectTab('setup')}>
              Review safety in Setup
            </button>
            <span>Acknowledge the safety notice before playing sound.</span>
          </div>
        )}
        {activeTab === 'setup' && (
          <SetupView
            calibration={calibration}
            engineState={engineState}
            onUpdateCalibration={handleUpdateCalibration}
            onProceedToMatch={() => handleSelectTab('match')}
          />
        )}

        {activeTab === 'match' && journalReady && (
          <MatchView
            onReviewSetup={reviewSetup}
            defaultEar={calibration.ear}
            activeMatch={activeMatch}
            engineState={engineState}
            onSaveMatch={handleSaveMatch}
            onGoToRelief={(m, isSaved) => {
              if (isSaved) {
                selectSavedMatch(m);
              } else {
                saveReliefDraft(m);
                setReliefHandoff({ id: m.id, match: m });
              }
              handleSelectTab('relief');
            }}
            onNotify={notify}
          />
        )}

        {activeTab === 'relief' && journalReady && (
          <ReliefView
            selection={reliefMatch}
            onSaveMatch={handleSaveMatch}
            onSelectSavedMatch={selectSavedMatch}
            onReviewSetup={reviewSetup}
            defaultEar={calibration.ear}
            engineState={engineState}
            onLogRITest={handleLogRITest}
            onLogSession={handleLogSession}
            onGoToMatch={() => handleSelectTab('match')}
            onNotify={notify}
          />
        )}

        {activeTab === 'journal' && (
          <JournalView
            sampleRate={engineState.sampleRate}
            matches={matches}
            checkins={checkins}
            riTests={riTests}
            sessions={sessions}
            activeMatchId={activeMatch?.id ?? null}
            onAddCheckIn={handleAddCheckIn}
            onDeleteCheckIn={handleDeleteCheckIn}
            onDeleteMatch={handleDeleteMatch}
            onDeleteRI={handleDeleteRI}
            onDeleteSession={handleDeleteSession}
            onSelectActiveMatch={(m) => {
              selectSavedMatch(m);
              notify(`Loaded ${Math.round(m.frequencyHz)} Hz into Relief`);
              handleSelectTab('relief');
            }}
            onReloadAll={reloadAll}
            onNotify={notify}
          />
        )}

        {activeTab === 'learn' && <EducationView />}
      </main>

      <footer className="app-footer">
        <div className="footer-inner">
          <span>Tinnitune · 100% private in-browser Web Audio · Hard safety limiter ≤ −6 dBFS</span>
          <span>Not a medical device · Works offline</span>
        </div>
      </footer>

      <div className="sr-only" role="status">
        {notification && !notification.showToast ? notification.message : ''}
      </div>
      {notification?.showToast && (
        <div className="toast-banner" role="status" aria-live="polite" data-testid="toast-banner">
          {notification.message}
        </div>
      )}
    </div>
  );
};

export default App;
