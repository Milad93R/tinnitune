import React from 'react';
import { bandpassMagnitude, frequencyPlotRange, freqToNorm, normToFreq, type DigitalFilterBand } from '../audio/dsp';
import type { SoundType } from '../types';

interface MiniSpectrumProps {
  frequencyHz: number;
  soundType: SoundType;
  band?: DigitalFilterBand;
  compact?: boolean;
}

export const MiniSpectrum: React.FC<MiniSpectrumProps> = ({
  frequencyHz,
  soundType,
  band,
  compact = false,
}) => {
  const width = compact ? 200 : 680;
  const height = compact ? 50 : 124;
  const padX = compact ? 8 : 20;
  const padB = compact ? 8 : 26;
  const plotW = width - padX * 2;
  const baseY = height - padB;
  const peakH = compact ? 32 : 76;

  const [minHz, maxHz] = frequencyPlotRange(band);
  const toNorm = (hz: number) => freqToNorm(hz, minHz, maxHz);
  const peakNorm = toNorm(band?.centerHz ?? frequencyHz);
  const sigma =
    soundType === 'tone'
      ? 0.015
      : soundType === 'crickets'
      ? 0.022
      : 0.026;

  const pts: string[] = [];
  const steps = 90;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = padX + u * plotW;
    const d = (u - peakNorm) / sigma;
    let val = band ? bandpassMagnitude(normToFreq(u, minHz, maxHz), band) : Math.exp(-0.5 * d * d);
    if (soundType === 'buzz') {
      const h2 = toNorm(Math.min(18000, frequencyHz * 2));
      const d2 = (u - h2) / (sigma * 0.9);
      val = Math.max(val, 0.42 * Math.exp(-0.5 * d2 * d2));
    }
    const y = baseY - val * peakH;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  const linePath = `M ${pts.join(' L ')}`;
  const areaPath = `${linePath} L ${(padX + plotW).toFixed(1)},${baseY} L ${padX},${baseY} Z`;
  const peakX = padX + peakNorm * plotW;
  const gradId = `miniSpec-${Math.round(frequencyHz)}-${soundType}-${compact ? 'c' : 'f'}`;
  const ticks = [250, 1000, 4000, 8000, 16000];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`mini-spectrum ${compact ? 'compact' : ''}`}
      role="img"
      aria-label={`Spectrum graphic peaking at ${Math.round(frequencyHz)} Hz`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#863926" stopOpacity="0.48" />
          <stop offset="65%" stopColor="#7a855c" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#7a855c" stopOpacity="0.01" />
        </linearGradient>
      </defs>

      <line
        x1={padX}
        y1={baseY}
        x2={padX + plotW}
        y2={baseY}
        stroke="rgba(77,65,45,0.28)"
        strokeWidth="1"
      />

      {!compact &&
        ticks.map((hz) => {
          const x = padX + toNorm(hz) * plotW;
          return (
            <g key={hz}>
              <line
                x1={x}
                y1={8}
                x2={x}
                y2={baseY}
                stroke="rgba(77,65,45,0.16)"
                strokeWidth="1"
              />
              <text
                x={x}
                y={height - 6}
                textAnchor="middle"
                fill="#524b3c"
                fontSize="17"
                fontFamily="JetBrains Mono, monospace"
              >
                {hz >= 1000 ? `${hz / 1000}k` : hz}
              </text>
            </g>
          );
        })}

      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke="#863926" strokeWidth={compact ? 1.8 : 2.3} strokeLinecap="round" />

      <line
        x1={peakX}
        y1={baseY - peakH - 2}
        x2={peakX}
        y2={baseY}
        stroke="rgba(134,57,38,0.65)"
        strokeWidth="1.2"
        strokeDasharray="3 3"
      />
      <circle cx={peakX} cy={baseY - peakH} r={compact ? 2.8 : 4} fill="#863926" />
    </svg>
  );
};
