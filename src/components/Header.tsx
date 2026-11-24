import React from 'react';
import {
  Activity,
  BookOpen,
  Headphones,
  NotebookPen,
  ShieldCheck,
  Volume2,
  VolumeX,
  Waves,
} from 'lucide-react';
import type { AppTab, TinnitusMatch } from '../types';
import { formatEarLabel, formatHz, formatKhzCompact } from '../utils/format';
import { TinnituneEmblem } from './BrandIcons';

interface HeaderProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  isPlaying: boolean;
  onStopAudio: () => void;
  activeMatch: TinnitusMatch | null;
}

const NAV_ITEMS: Array<{ id: AppTab; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'setup', label: 'Setup', icon: Headphones },
  { id: 'match', label: 'Match', icon: Activity },
  { id: 'relief', label: 'Relief', icon: Waves },
  { id: 'journal', label: 'Journal', icon: NotebookPen },
  { id: 'learn', label: 'Learn', icon: BookOpen },
];

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onSelectTab,
  isPlaying,
  onStopAudio,
  activeMatch,
}) => {
  return (
    <>
      <header className="app-header">
        <div className="header-inner">
          <button
            type="button"
            className="brand-btn"
            onClick={() => onSelectTab('match')}
            aria-label="Tinnitune home"
          >
            <span className="brand-mark" aria-hidden="true">
              <TinnituneEmblem size={26} />
            </span>
            <span className="brand-text">
              <span className="brand-name">Tinnitune</span>
              <span className="brand-sub">Acoustic Relief</span>
            </span>
          </button>

          <nav className="desktop-nav" aria-label="Primary navigation">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`nav-pill ${activeTab === id ? 'active' : ''}`}
                aria-current={activeTab === id ? 'page' : undefined}
                onClick={() => onSelectTab(id)}
                data-testid={`nav-${id}`}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="header-status">
            {activeMatch && (
              <button
                type="button"
                className="profile-chip"
                onClick={() => onSelectTab('relief')}
                title={`Active match · ${formatHz(activeMatch.frequencyHz)} · ${formatEarLabel(activeMatch.ear)}`}
                data-testid="header-profile-chip"
              >
                <span className="profile-dot" aria-hidden="true" />
                <span className="mono">{formatKhzCompact(activeMatch.frequencyHz)}</span>
                <span className="profile-ear">{activeMatch.ear}</span>
              </button>
            )}

            <span className="limiter-badge" title="Hard brickwall safety limiter active below −6 dBFS">
              <ShieldCheck size={14} />
              <span className="mono">≤ −6 dBFS</span>
            </span>

            <button
              type="button"
              className={`audio-mute-btn ${isPlaying ? 'playing' : ''}`}
              onClick={onStopAudio}
              disabled={!isPlaying}
              aria-label={isPlaying ? 'Stop all sound immediately' : 'Audio is muted'}
              data-testid="global-stop-audio"
            >
              {isPlaying ? <Volume2 size={16} /> : <VolumeX size={16} />}
              <span>{isPlaying ? 'Mute' : 'Silent'}</span>
            </button>
          </div>
        </div>
      </header>

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`mobile-nav-btn ${activeTab === id ? 'active' : ''}`}
            aria-current={activeTab === id ? 'page' : undefined}
            onClick={() => onSelectTab(id)}
            data-testid={`mobile-nav-${id}`}
          >
            <Icon size={19} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  );
};
