import React, { useEffect, useRef } from 'react';
import { freqToNorm, MAX_FREQ_HZ, MIN_FREQ_HZ, normToFreq, frequencyPlotRange, theoreticalNotchResponseDb, type DigitalNotch, type FrequencyBand } from '../audio/dsp';
import { audioEngine } from '../audio/engine';
import { formatKhzCompact } from '../utils/format';

export interface SpectrumVisualizerProps {
  isPlaying: boolean;
  markerHz?: number;
  markerLabel?: string;
  showOctaves?: boolean;
  notchEnabled?: boolean;
  notch?: DigitalNotch;
  bracketRange?: [number, number] | null;
  probes?: { aHz: number; bHz: number; active?: 'A' | 'B' | null } | null;
  band?: FrequencyBand;
  height?: number;
  caption?: string;
}

const GRID_TICKS = [250, 500, 1000, 2000, 4000, 8000, 14000, 18000];
const NUM_SPEC_PTS = 144;
const NOTCH_CURVE_PTS = 120;

export const SpectrumVisualizer: React.FC<SpectrumVisualizerProps> = ({
  isPlaying,
  markerHz,
  markerLabel,
  showOctaves = false,
  notchEnabled = false,
  notch,
  bracketRange = null,
  probes = null,
  band,
  height = 216,
  caption,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawOnceRef = useRef<(() => void) | null>(null);
  const propsRef = useRef({
    isPlaying,
    markerHz,
    markerLabel,
    showOctaves,
    notchEnabled,
    notch,
    bracketRange,
    probes,
    band,
  });

  propsRef.current = {
    isPlaying,
    markerHz,
    markerLabel,
    showOctaves,
    notchEnabled,
    notch,
    bracketRange,
    probes,
    band,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let rafId = 0;
    let freqData: Uint8Array<ArrayBuffer> | null = null;
    const smoothBins = new Float32Array(NUM_SPEC_PTS);
    let lastDraw = 0;

    // Precomputed FFT bin lookup cache (eliminates 300+ Math.pow calls per frame)
    let cachedBinKey = '';
    const binStart = new Int32Array(NUM_SPEC_PTS);
    const binEnd = new Int32Array(NUM_SPEC_PTS);

    // Cached theoretical notch curve (recomputed only when center/width changes)
    let cachedNotchKey = '';
    const notchCurveNormY = new Float32Array(NOTCH_CURVE_PTS + 1);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.round(rect.width * dpr);
      const targetH = Math.round(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
    };

    const renderNow = () => {
      const p = propsRef.current;
      const [minHz, maxHz] = frequencyPlotRange(p.notch ?? p.band);
      const toNorm = (hz: number) => freqToNorm(hz, minHz, maxHz);
      const toHz = (norm: number) => normToFreq(norm, minHz, maxHz);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      if (w <= 0 || h <= 0) return;

      ctx.save();
      ctx.scale(dpr, dpr);

      const padL = 14;
      const padR = 14;
      const padT = 18;
      const padB = 28;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const baseY = padT + plotH;

      // Warm paper with ink grid
      const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
      bgGrad.addColorStop(0, '#f2e7cd');
      bgGrad.addColorStop(1, '#e9dcc0');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // 1. Subtle horizontal dB grid lines
      ctx.strokeStyle = 'rgba(70, 61, 38, 0.10)';
      ctx.lineWidth = 1;
      for (let g = 1; g <= 3; g++) {
        const gy = padT + (plotH * g) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, gy);
        ctx.lineTo(w - padR, gy);
        ctx.stroke();
      }

      // 2. Logarithmic frequency ticks
      ctx.font = '500 10.5px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      const ticks = [minHz, ...GRID_TICKS.filter((tick) =>
        toNorm(tick) > 0.08 && toNorm(tick) < 0.91 && (w >= 430 || tick !== 14000)
      ), maxHz];
      for (const tick of ticks) {
        const x = padL + toNorm(tick) * plotW;
        ctx.strokeStyle = 'rgba(70, 61, 38, 0.13)';
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, baseY);
        ctx.stroke();

        ctx.fillStyle = 'rgba(70, 61, 38, 0.9)';
        const label = tick >= 1000 ? `${Number((tick / 1000).toFixed(1))}k` : `${Math.round(tick)}`;
        const clampedX = Math.max(padL + 14, Math.min(w - padR - 14, x));
        ctx.fillText(label, clampedX, h - 9);
      }

      // 3. Binary search narrowing bracket overlay
      if (p.bracketRange) {
        const [lowHz, highHz] = p.bracketRange;
        const x1 = padL + toNorm(lowHz) * plotW;
        const x2 = padL + toNorm(highHz) * plotW;
        const bw = Math.max(4, x2 - x1);
        const brGrad = ctx.createLinearGradient(x1, 0, x2, 0);
        brGrad.addColorStop(0, 'rgba(61, 90, 58, 0.06)');
        brGrad.addColorStop(0.5, 'rgba(61, 90, 58, 0.14)');
        brGrad.addColorStop(1, 'rgba(61, 90, 58, 0.06)');
        ctx.fillStyle = brGrad;
        ctx.fillRect(x1, padT, bw, plotH);

        ctx.strokeStyle = 'rgba(61, 90, 58, 0.42)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, padT);
        ctx.lineTo(x1, baseY);
        ctx.moveTo(x2, padT);
        ctx.lineTo(x2, baseY);
        ctx.stroke();
      }

      // 4. Luminous Notch "Light Band" overlay (SPEC signature visual)
      if (p.notchEnabled && p.notch) {
        const { lowHz: lowNotch, highHz: highNotch } = p.notch;
        const x1 = padL + toNorm(lowNotch) * plotW;
        const x2 = padL + toNorm(highNotch) * plotW;
        const bw = Math.max(4, x2 - x1);

        const bandGrad = ctx.createLinearGradient(x1, padT, x2, padT);
        bandGrad.addColorStop(0, 'rgba(61, 90, 58, 0.03)');
        bandGrad.addColorStop(0.28, 'rgba(61, 90, 58, 0.16)');
        bandGrad.addColorStop(0.5, 'rgba(100, 124, 75, 0.30)');
        bandGrad.addColorStop(0.72, 'rgba(61, 90, 58, 0.16)');
        bandGrad.addColorStop(1, 'rgba(61, 90, 58, 0.03)');
        ctx.fillStyle = bandGrad;
        ctx.fillRect(x1, padT, bw, plotH);

        const vWash = ctx.createLinearGradient(0, padT, 0, baseY);
        vWash.addColorStop(0, 'rgba(145, 148, 88, 0.18)');
        vWash.addColorStop(0.6, 'rgba(61, 90, 58, 0.05)');
        vWash.addColorStop(1, 'rgba(61, 90, 58, 0)');
        ctx.fillStyle = vWash;
        ctx.fillRect(x1, padT, bw, plotH);

        ctx.strokeStyle = 'rgba(61, 90, 58, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, padT);
        ctx.lineTo(x1, baseY);
        ctx.moveTo(x2, padT);
        ctx.lineTo(x2, baseY);
        ctx.stroke();
        ctx.setLineDash([]);

        const nKey = `${p.notch.centerHz}:${p.notch.q}:${p.notch.sampleRate}`;
        if (nKey !== cachedNotchKey) {
          cachedNotchKey = nKey;
          for (let i = 0; i <= NOTCH_CURVE_PTS; i++) {
            const f = toHz(i / NOTCH_CURVE_PTS);
            const db = Math.max(-42, theoreticalNotchResponseDb(f, p.notch));
            notchCurveNormY[i] = -db / 42;
          }
        }
        ctx.beginPath();
        for (let i = 0; i <= NOTCH_CURVE_PTS; i++) {
          const x = padL + (i / NOTCH_CURVE_PTS) * plotW;
          const y = padT + 14 + notchCurveNormY[i] * (plotH - 22);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(65, 85, 56, 0.52)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // 5. Bandwidth ribbon around marker (for hiss/whoosh match)
      if (p.band) {
        const x1 = padL + toNorm(p.band.lowHz) * plotW;
        const x2 = padL + toNorm(p.band.highHz) * plotW;
        ctx.fillStyle = 'rgba(145, 62, 36, 0.12)';
        ctx.fillRect(x1, padT, Math.max(4, x2 - x1), plotH);
      }

      // 6. Live FFT Spectrum (or calm resting acoustic floor when silent)
      const analyser = audioEngine.getAnalyser();
      if (analyser && p.isPlaying) {
        if (!freqData || freqData.length !== analyser.frequencyBinCount) {
          freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        }
        const sr = analyser.context.sampleRate;
        const binKey = `${sr}:${analyser.fftSize}:${freqData.length}:${minHz}:${maxHz}`;
        if (binKey !== cachedBinKey) {
          cachedBinKey = binKey;
          const binHz = sr / analyser.fftSize;
          for (let i = 0; i < NUM_SPEC_PTS; i++) {
            const u = i / (NUM_SPEC_PTS - 1);
            const fLow = toHz(Math.max(0, u - 0.0045));
            const fHigh = toHz(Math.min(1, u + 0.0045));
            binStart[i] = Math.max(1, Math.floor(fLow / binHz));
            binEnd[i] = Math.min(freqData.length - 1, Math.ceil(fHigh / binHz));
          }
        }
        analyser.getByteFrequencyData(freqData);
        for (let i = 0; i < NUM_SPEC_PTS; i++) {
          let maxVal = 0;
          const b0 = binStart[i];
          const b1 = binEnd[i];
          for (let b = b0; b <= b1; b++) {
            if (freqData[b] > maxVal) maxVal = freqData[b];
          }
          smoothBins[i] = smoothBins[i] * 0.62 + (maxVal / 255) * 0.38;
        }
      } else {
        for (let i = 0; i < NUM_SPEC_PTS; i++) {
          const u = i / (NUM_SPEC_PTS - 1);
          smoothBins[i] = 0.10 + 0.022 * Math.sin(u * 9.0 + 0.6) + 0.012 * Math.cos(u * 17.0);
        }
      }

      ctx.beginPath();
      ctx.moveTo(padL, baseY);
      for (let i = 0; i < NUM_SPEC_PTS; i++) {
        const x = padL + (i / (NUM_SPEC_PTS - 1)) * plotW;
        const val = Math.max(0, Math.min(1, smoothBins[i]));
        ctx.lineTo(x, baseY - val * (plotH - 12));
      }
      ctx.lineTo(padL + plotW, baseY);
      ctx.closePath();

      const specFill = ctx.createLinearGradient(0, padT, 0, baseY);
      if (p.isPlaying) {
        specFill.addColorStop(0, 'rgba(61, 90, 58, 0.42)');
        specFill.addColorStop(0.55, 'rgba(61, 90, 58, 0.14)');
        specFill.addColorStop(1, 'rgba(61, 90, 58, 0.01)');
      } else {
        specFill.addColorStop(0, 'rgba(70, 78, 101, 0.16)');
        specFill.addColorStop(1, 'rgba(61, 90, 58, 0.01)');
      }
      ctx.fillStyle = specFill;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < NUM_SPEC_PTS; i++) {
        const x = padL + (i / (NUM_SPEC_PTS - 1)) * plotW;
        const val = Math.max(0, Math.min(1, smoothBins[i]));
        const y = baseY - val * (plotH - 12);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = p.isPlaying ? '#354f3a' : 'rgba(65, 82, 54, 0.45)';
      ctx.lineWidth = p.isPlaying ? 2.1 : 1.3;
      ctx.stroke();

      // 7. Octave ghost lines (f/2 and 2f)
      if (p.showOctaves && p.markerHz) {
        const ghosts = [
          { hz: p.markerHz / 2, label: 'f/2' },
          { hz: p.markerHz * 2, label: '2f' },
        ];
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        for (const g of ghosts) {
          if (g.hz < MIN_FREQ_HZ || g.hz > MAX_FREQ_HZ) continue;
          const gx = padL + toNorm(g.hz) * plotW;
          ctx.strokeStyle = 'rgba(70, 78, 101, 0.46)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(gx, padT + 14);
          ctx.lineTo(gx, baseY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = 'rgba(55, 65, 82, 0.85)';
          ctx.fillText(g.label, gx, padT + 10);
        }
      }

      // 8. A/B Binary-search probes
      if (p.probes) {
        const drawProbe = (hz: number, tag: 'A' | 'B', isActive: boolean) => {
          const px = padL + toNorm(hz) * plotW;
          ctx.strokeStyle = isActive ? '#863926' : 'rgba(79, 69, 45, 0.42)';
          ctx.lineWidth = isActive ? 2.4 : 1.4;
          ctx.beginPath();
          ctx.moveTo(px, padT + 18);
          ctx.lineTo(px, baseY);
          ctx.stroke();

          ctx.fillStyle = isActive ? '#863926' : '#dcd0b5';
          ctx.beginPath();
          ctx.arc(px, padT + 14, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = isActive ? '#f9f1dc' : 'rgba(70, 61, 38, 0.4)';
          ctx.lineWidth = 1.2;
          ctx.stroke();

          ctx.fillStyle = isActive ? '#fff6e5' : '#2f4133';
          ctx.font = '700 11px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(tag, px, padT + 18);
        };
        drawProbe(p.probes.aHz, 'A', p.probes.active === 'A');
        drawProbe(p.probes.bHz, 'B', p.probes.active === 'B');
      }

      // 9. Warm Amber Frequency Cursor
      if (p.markerHz) {
        const mx = padL + toNorm(p.markerHz) * plotW;
        const beamGlow = ctx.createLinearGradient(mx - 18, 0, mx + 18, 0);
        beamGlow.addColorStop(0, 'rgba(145, 62, 36, 0)');
        beamGlow.addColorStop(0.5, 'rgba(145, 62, 36, 0.22)');
        beamGlow.addColorStop(1, 'rgba(145, 62, 36, 0)');
        ctx.fillStyle = beamGlow;
        ctx.fillRect(mx - 18, padT, 36, plotH);

        ctx.strokeStyle = '#863926';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx, padT + 20);
        ctx.lineTo(mx, baseY);
        ctx.stroke();

        const text = p.markerLabel ?? formatKhzCompact(p.markerHz);
        ctx.font = '600 11px "JetBrains Mono", monospace';
        const tw = ctx.measureText(text).width + 16;
        const bx = Math.max(padL, Math.min(w - padR - tw, mx - tw / 2));
        ctx.fillStyle = 'rgba(145, 62, 36, 0.18)';
        ctx.beginPath();
        ctx.roundRect(bx, padT - 2, tw, 20, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(145, 62, 36, 0.72)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#632b1f';
        ctx.textAlign = 'center';
        ctx.fillText(text, bx + tw / 2, padT + 12);
      }

      ctx.restore();
    };

    const drawLoop = (ts: number) => {
      if (document.hidden || !propsRef.current.isPlaying) {
        rafId = 0;
        return;
      }
      const minInterval = reducedMotion ? 180 : 16;
      if (ts - lastDraw >= minInterval) {
        lastDraw = ts;
        renderNow();
      }
      rafId = requestAnimationFrame(drawLoop);
    };

    const syncRenderState = () => {
      resize();
      renderNow();
      if (propsRef.current.isPlaying && !document.hidden && !rafId) {
        lastDraw = 0;
        rafId = requestAnimationFrame(drawLoop);
      } else if (!propsRef.current.isPlaying && rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    drawOnceRef.current = syncRenderState;
    const ro = new ResizeObserver(() => {
      resize();
      renderNow();
    });
    ro.observe(canvas);

    const handleVisibility = () => {
      if (document.hidden && rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      } else if (!document.hidden) {
        syncRenderState();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    syncRenderState();

    return () => {
      drawOnceRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibility);
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // Re-render cleanly on any visual prop change (and start/stop 60fps loop with isPlaying)
  useEffect(() => {
    drawOnceRef.current?.();
  }, [
    isPlaying,
    markerHz,
    markerLabel,
    showOctaves,
    notchEnabled,
    notch,
    bracketRange,
    probes,
    band,
  ]);

  const [minHz, maxHz] = frequencyPlotRange(notch ?? band);
  return (
    <div className="spectrum-shell" role="region" aria-label="Live acoustic frequency spectrum visualizer" data-marker-hz={markerHz}>
      <div className="spectrum-topbar">
        <span className="spectrum-tag">
          <span className={`live-dot ${isPlaying ? 'active' : ''}`} aria-hidden="true" />
          {isPlaying ? 'Live Spectrum' : 'Frequency scale'} · {formatKhzCompact(minHz)} – {formatKhzCompact(maxHz)}
        </span>
        {caption && <span className="spectrum-caption">{caption}</span>}
      </div>
      <canvas
        ref={canvasRef}
        className="spectrum-canvas"
        style={{ height: `${height}px` }}
        aria-hidden="true"
      />
    </div>
  );
};
