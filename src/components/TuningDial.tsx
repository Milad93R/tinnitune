import { useRef, useState, type PointerEvent } from 'react';
import { freqToNorm, MAX_FREQ_HZ, MIN_FREQ_HZ, normToFreq, nudgeSemitones } from '../audio/dsp';
import { formatHz } from '../utils/format';

const SWEEP = 252;
const CENTER = { x: 170, y: 138 };
const DETENTS = Math.floor(12 * Math.log2(MAX_FREQ_HZ / MIN_FREQ_HZ));
const SCALE = [250, 500, 1000, 2000, 4000, 8000, 18000];

function polar(angle: number, r: number) {
  const radians = (angle * Math.PI) / 180;
  return { x: CENTER.x + r * Math.sin(radians), y: CENTER.y - r * Math.cos(radians) };
}

function angleAt(dial: SVGSVGElement, e: Pick<PointerEvent, 'clientX' | 'clientY'>) {
  const bounds = dial.getBoundingClientRect();
  const x = (e.clientX - bounds.left) * (340 / bounds.width) - CENTER.x;
  const y = (e.clientY - bounds.top) * (247 / bounds.height) - CENTER.y;
  return (Math.atan2(x, -y) * 180) / Math.PI;
}

const angleFor = (hz: number) => (freqToNorm(hz) - 0.5) * SWEEP;
const arcStart = polar(-SWEEP / 2, 102);
const arcEnd = polar(SWEEP / 2, 102);
const scaleArc = `M ${arcStart.x} ${arcStart.y} A 102 102 0 1 1 ${arcEnd.x} ${arcEnd.y}`;

interface Props {
  frequencyHz: number;
  onChange: (hz: number) => void;
}

export function TuningDial({ frequencyHz, onChange }: Props) {
  const drag = useRef<{ id: number; pointer: number; origin: number; current: number } | null>(null);
  const [turning, setTurning] = useState(false);
  const angle = angleFor(frequencyHz);

  const setFromAngle = (next: number) => {
    const u = Math.min(1, Math.max(0, next / SWEEP + 0.5));
    const hz = u === 1 ? MAX_FREQ_HZ : MIN_FREQ_HZ * 2 ** (Math.round(12 * Math.log2(normToFreq(u) / MIN_FREQ_HZ)) / 12);
    const rounded = Math.min(MAX_FREQ_HZ, Math.round(hz));
    if (rounded !== frequencyHz) onChange(rounded);
  };

  const endTurn = () => {
    drag.current = null;
    setTurning(false);
  };

  return (
    <svg
      className={`tuning-dial ${turning ? 'turning' : ''}`}
      viewBox="0 0 340 247"
      role="slider"
      tabIndex={0}
      aria-label="Radio tuning dial"
      aria-describedby="dial-help"
      aria-valuemin={MIN_FREQ_HZ}
      aria-valuemax={MAX_FREQ_HZ}
      aria-valuenow={Math.round(frequencyHz)}
      aria-valuetext={formatHz(frequencyHz)}
      data-testid="tuning-dial"
      onKeyDown={(e) => {
        const increments: Record<string, number> = {
          ArrowLeft: -1, ArrowDown: -1, ArrowUp: 1, ArrowRight: 1, PageDown: -12, PageUp: 12,
        };
        const next = e.key === 'Home' ? MIN_FREQ_HZ : e.key === 'End' ? MAX_FREQ_HZ
          : Object.hasOwn(increments, e.key) ? nudgeSemitones(frequencyHz, increments[e.key]) : null;
        if (next !== null) {
          e.preventDefault();
          onChange(next);
        }
      }}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        const pointer = angleAt(e.currentTarget, e);
        const fromKnob = e.target instanceof Element && Boolean(e.target.closest('[data-dial-knob]'));
        if (!fromKnob) return;
        const origin = angle;
        drag.current = { id: e.pointerId, pointer, origin, current: origin };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        setTurning(true);
      }}
      onPointerMove={(e) => {
        const turn = drag.current;
        if (!turn || turn.id !== e.pointerId) return;
        const pointer = angleAt(e.currentTarget, e);
        const delta = ((pointer - turn.pointer + 540) % 360) - 180;
        turn.current = Math.min(SWEEP / 2, Math.max(-SWEEP / 2, turn.current + delta));
        turn.pointer = pointer;
        if (Math.abs(turn.current - turn.origin) > 0.6) setFromAngle(turn.current);
      }}
      onLostPointerCapture={endTurn}
    >
      <defs>
        <linearGradient id="enamel" x2="0" y2="1">
          <stop stopColor="#faf1d9" />
          <stop offset="1" stopColor="#d7c5a3" />
        </linearGradient>
        <linearGradient id="brass" x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="#ebd4a0" />
          <stop offset=".44" stopColor="#c1a16a" />
          <stop offset="1" stopColor="#8e7046" />
        </linearGradient>
      </defs>
      <rect width="340" height="247" fill="transparent" />
      <circle cx="170" cy="138" r="106" fill="url(#enamel)" stroke="#c2ae8e" />
      <circle cx="170" cy="138" r="97" fill="none" stroke="#c2ae8e" strokeDasharray="1 3" />
      <path d={scaleArc} fill="none" stroke="#514d3a" strokeWidth=".8" />
      {Array.from({ length: DETENTS + 1 }, (_, index) => {
        const tickAngle = angleFor(MIN_FREQ_HZ * 2 ** (index / 12));
        const outer = polar(tickAngle, 98);
        const inner = polar(tickAngle, index % 12 === 0 ? 82 : index % 3 === 0 ? 88 : 92);
        return <line key={index} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y}
          stroke="#625b42" strokeWidth={index % 12 === 0 ? 1.4 : 0.8} />;
      })}
      {SCALE.map((hz) => {
        const point = polar(angleFor(hz), 121);
        return <text key={hz} x={point.x} y={point.y} dominantBaseline="central" textAnchor="middle"
          className="dial-legend">{hz < 1000 ? hz : `${hz / 1000}k`}</text>;
      })}
      <g className="dial-needle" style={{ transform: `rotate(${angle}deg)` }}>
        <path d="M166 141 L168.5 47 L170 39 L171.5 47 L174 141 Z" fill="#9a412e" />
        <circle cx="170" cy="39" r="2.2" fill="#9a412e" />
      </g>
      <path className="dial-scale-hit" d={scaleArc} fill="none" stroke="transparent" strokeWidth="22"
        aria-hidden="true" onClick={(event) => {
          const dial = event.currentTarget.ownerSVGElement;
          if (!dial) return;
          setFromAngle(angleAt(dial, event));
          dial.focus({ preventScroll: true });
        }} />
      <g data-dial-knob="">
        <circle cx="170" cy="143" r="47" fill="#514831" opacity=".28" />
        <circle cx="170" cy="138" r="47" fill="#303b31" stroke="#19251d" />
        <circle cx="170" cy="138" r="43" fill="none" stroke="#807556" strokeWidth="5" strokeDasharray="1 2.2" />
        <circle cx="170" cy="138" r="36" fill="url(#brass)" stroke="#665333" />
        <circle cx="170" cy="138" r="29" fill="none" stroke="#ecdaa6" strokeOpacity=".62" />
        <circle cx="170" cy="138" r="25" fill="none" stroke="#695337" strokeOpacity=".32" />
        <g className="dial-needle" style={{ transform: `rotate(${angle}deg)` }}>
          <path d="M170 106 V117" stroke="#f8eccf" strokeWidth="2.7" strokeLinecap="round" />
        </g>
        <path d="M160 139 h5 l3 -5 5 9 3 -4 h5" fill="none" stroke="#393523" strokeWidth="1.7" />
      </g>
      <text className="dial-legend dial-unit" x="170" y="213" textAnchor="middle">HERTZ</text>
    </svg>
  );
}
