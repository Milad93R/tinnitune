import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { freqToNorm, frequencyPlotRange, type DigitalNotch } from '../audio/dsp';
import { formatKhzCompact } from '../utils/format';

const WIDTH = 1000;
const STEMS = Array.from({ length: 56 }, (_, i) => {
  const x = (i + 0.5) / 56;
  const seed = ((i * 73 + 11) % 101) / 101;
  const height = 31 + seed * 85;
  return { x, height, sway: (seed - 0.48) * 22, delay: -seed * 6 };
});

interface Props {
  notch: DigitalNotch;
  enabled: boolean;
  playing: boolean;
  captionAction?: ReactNode;
}

export function NotchGarden({ notch, enabled, playing, captionAction }: Props) {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const updateVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  const [minHz, maxHz] = frequencyPlotRange(notch);
  const left = freqToNorm(notch.lowHz, minHz, maxHz);
  const right = freqToNorm(notch.highHz, minHz, maxHz);

  return (
    <figure className={`notch-garden ${playing && visible ? 'swaying' : ''}`} data-testid="notch-garden">
      <div className="garden-plate">
        <img src="/art/garden-at-dusk.webp" alt="" width="1200" height="590" decoding="async" />
        {enabled && (
          <div className="garden-gap" data-testid="garden-gap" aria-hidden="true"
            style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }} />
        )}
        <svg viewBox="0 0 1000 150" preserveAspectRatio="none" aria-hidden="true" className="garden-stems">
          {STEMS.map(({ x, height, sway, delay }) => {
            const quiet = enabled && x >= left && x <= right;
            return (
              <g key={x} className={`garden-stem ${quiet ? 'quiet' : ''}`}
                style={{ '--stem-delay': `${delay}s` } as CSSProperties}
                transform={`translate(${x * WIDTH} 150)`}>
                <g>
                  <path d={`M0 5 Q${-sway * 0.4} ${-height * 0.5} ${sway} ${-height}`} />
                  <path d={`M${sway * 0.4} ${-height * 0.58} q-14 -8 -11 -16`} className="garden-leaf" />
                  <ellipse cx={sway} cy={-height} rx="2.1" ry="5" />
                </g>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="garden-legend">
        {!captionAction && <span className="mono">{formatKhzCompact(minHz)}</span>}
        <strong>{enabled ? `Quiet band · ${formatKhzCompact(notch.centerHz)}` : 'Night garden'}</strong>
        {captionAction ?? <span className="mono">{formatKhzCompact(maxHz)}</span>}
      </figcaption>
    </figure>
  );
}
