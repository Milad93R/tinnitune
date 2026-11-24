import React from 'react';
import type { SoundType } from '../types';

export const TinnituneEmblem: React.FC<{ size?: number }> = ({ size = 26 }) => (
  <svg viewBox="0 0 36 36" width={size} height={size} fill="none" aria-hidden="true">
    <path d="M7 24a12.7 12.7 0 1 1 22 0M6 29h24" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10 19h3m.5-7.5 2 2M18 9.5v3m4.5-1  -2 2M23 19h3" stroke="currentColor" strokeWidth="1.2" />
    <path d="m18 22 9-9" stroke="#e3ab87" strokeWidth="2.1" strokeLinecap="round" />
    <circle cx="18" cy="22" r="2.15" fill="currentColor" />
  </svg>
);

/**
 * Custom scientific SVG glyphs for each tinnitus sound archetype (zero emoji).
 */
export const SoundTypeGlyph: React.FC<{ type: SoundType; size?: number }> = ({
  type,
  size = 24,
}) => {
  switch (type) {
    case 'tone':
      return (
        <svg viewBox="0 0 28 20" width={size} height={Math.round(size * 0.72)} aria-hidden="true">
          <path
            d="M2 10 C5.5 2, 8.5 2, 11 10 C13.5 18, 16.5 18, 19 10 C21.5 2, 24.5 2, 26 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'hiss':
      return (
        <svg viewBox="0 0 28 20" width={size} height={Math.round(size * 0.72)} aria-hidden="true">
          <path
            d="M2 16 L8 16 C11 16, 12 4, 14 4 C16 4, 17 16, 20 16 L26 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line x1="14" y1="2" x2="14" y2="17" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" opacity="0.55" />
        </svg>
      );
    case 'whoosh':
      return (
        <svg viewBox="0 0 28 20" width={size} height={Math.round(size * 0.72)} aria-hidden="true">
          <path
            d="M2 16 C6 15, 9 5, 14 5 C19 5, 22 15, 26 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <path
            d="M5 13 C9 9, 19 9, 23 13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            opacity="0.5"
          />
        </svg>
      );
    case 'buzz':
      return (
        <svg viewBox="0 0 28 20" width={size} height={Math.round(size * 0.72)} aria-hidden="true">
          <line x1="2" y1="16" x2="26" y2="16" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
          <line x1="6" y1="16" x2="6" y2="4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
          <line x1="12" y1="16" x2="12" y2="7.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          <line x1="18" y1="16" x2="18" y2="10.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <line x1="23" y1="16" x2="23" y2="12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
        </svg>
      );
    case 'crickets':
      return (
        <svg viewBox="0 0 28 20" width={size} height={Math.round(size * 0.72)} aria-hidden="true">
          <path
            d="M2 10 L4.5 10 L6 4.5 L7.5 15.5 L9 10 L12 10 L13.5 4.5 L15 15.5 L16.5 10 L19.5 10 L21 4.5 L22.5 15.5 L24 10 L26 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
};
