import { bandpassMagnitude, designDigitalBandpass, frequencyPlotRange, freqToNorm, normToFreq, type FrequencyBand } from '../audio/dsp';
import { SOUND_TYPE_META, type EarSide, type TinnitusMatch } from '../types';

export function formatHz(hz: number): string {
  const rounded = Math.round(hz);
  return `${rounded.toLocaleString('en-US')} Hz`;
}

export function formatKhzCompact(hz: number): string {
  if (hz >= 1000) {
    const khz = hz / 1000;
    const decimals = khz >= 10 ? 1 : 2;
    return `${Number(khz.toFixed(decimals))} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

export function formatBandEdges(band: FrequencyBand): string {
  return `${Math.round(band.lowHz).toLocaleString('en-US')}–${formatHz(band.highHz)} at −3 dB`;
}

export function formatEarLabel(ear: EarSide): string {
  if (ear === 'left') return 'left ear';
  if (ear === 'right') return 'right ear';
  return 'both ears';
}

export function formatMatchHeadline(match: TinnitusMatch): string {
  const meta = SOUND_TYPE_META[match.soundType];
  return `Your tinnitus ≈ ${formatHz(match.frequencyHz)} ${meta.shortLabel}, ${formatEarLabel(match.ear)}`;
}

export function formatShareHeadline(match: TinnitusMatch): string {
  const meta = SOUND_TYPE_META[match.soundType];
  return `My tinnitus: ${formatKhzCompact(match.frequencyHz)} ${meta.shortLabel}`;
}

export function formatClock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDurationHuman(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function formatShortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDateTime(ts: number): string {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function todayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Render a crisp, spoiler-free 1200×675 PNG result card on an offscreen canvas.
 * Uses a single shared horizontal coordinate frame for ticks, curve, vertical guide, and apex dot.
 */
export function renderShareCardDataUrl(match: TinnitusMatch, sampleRate: number): string {
  const w = 1200;
  const h = 675;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';

  ctx.fillStyle = '#f0e5cc';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fbf3e2';
  ctx.fillRect(36, 36, w - 72, h - 72);
  ctx.strokeStyle = '#9b8866';
  ctx.lineWidth = 2;
  ctx.strokeRect(36, 36, w - 72, h - 72);
  ctx.fillStyle = '#263d30';
  ctx.fillRect(36, 36, w - 72, 104);

  ctx.save();
  ctx.translate(85, 70);
  ctx.strokeStyle = '#fbf3e2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(18, 16, 14, Math.PI * 5 / 6, Math.PI * 13 / 6);
  ctx.moveTo(3, 34);
  ctx.lineTo(33, 34);
  ctx.stroke();
  ctx.strokeStyle = '#e3ab87';
  ctx.beginPath();
  ctx.moveTo(18, 23);
  ctx.lineTo(28, 13);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#fbf3e2';
  ctx.font = '600 20px "JetBrains Mono", monospace';
  ctx.fillText('TINNITUNE / SOUND FINGERPRINT', 135, 95);
  ctx.textAlign = 'right';
  ctx.fillText(formatEarLabel(match.ear).toUpperCase(), w - 84, 95);
  ctx.textAlign = 'left';

  const meta = SOUND_TYPE_META[match.soundType];
  ctx.fillStyle = '#232c22';
  ctx.font = '400 66px "Instrument Serif", Georgia, serif';
  ctx.fillText(`My tinnitus: ${formatKhzCompact(match.frequencyHz)}`, 84, 216);

  ctx.fillStyle = '#863926';
  ctx.font = '600 28px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.fillText(
    `${meta.label}${meta.hasBandwidth ? ` · ${match.bandwidthOct.toFixed(2)} oct width` : ''}`,
    84,
    263,
  );

  // Spectrum plot region with ONE unified inner horizontal frame
  const plotX = 84;
  const plotY = 306;
  const plotW = w - 168;
  const plotH = 228;
  const innerX = plotX + 34;
  const innerW = plotW - 68;

  ctx.fillStyle = '#f0e5cc';
  ctx.fillRect(plotX, plotY, plotW, plotH);
  ctx.strokeStyle = '#9b8866';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(plotX, plotY, plotW, plotH);

  const band = meta.hasBandwidth ? designDigitalBandpass(match.frequencyHz, match.bandwidthOct, sampleRate) : undefined;
  const [minHz, maxHz] = frequencyPlotRange(band);
  const toNorm = (hz: number) => freqToNorm(hz, minHz, maxHz);

  // Frequency grid ticks using unified innerX / innerW
  const ticks = [250, 500, 1000, 2000, 4000, 8000, 16000];
  ctx.font = '500 16px "JetBrains Mono", monospace';
  ctx.fillStyle = '#514a39';
  ctx.textAlign = 'center';
  for (const hz of ticks) {
    const x = innerX + toNorm(hz) * innerW;
    ctx.strokeStyle = 'rgba(75, 66, 47, 0.22)';
    ctx.beginPath();
    ctx.moveTo(x, plotY + 14);
    ctx.lineTo(x, plotY + plotH - 36);
    ctx.stroke();
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x, plotY + plotH - 12);
  }

  // Synthesized signature curve using exact same innerX / innerW coordinate frame
  const peakNorm = toNorm(band?.centerHz ?? match.frequencyHz);
  const sigma =
    match.soundType === 'tone'
      ? 0.012
      : match.soundType === 'crickets'
      ? 0.018
      : 0.025;

  const baselineY = plotY + plotH - 42;
  const peakH = 148;
  const peakX = innerX + peakNorm * innerW;

  const evalCurve = (u: number): number => {
    if (band) return bandpassMagnitude(normToFreq(u, minHz, maxHz), band);
    const d = (u - peakNorm) / sigma;
    let val = Math.exp(-0.5 * d * d);
    if (match.soundType === 'buzz') {
      const h2 = toNorm(Math.min(18000, match.frequencyHz * 2));
      const d2 = (u - h2) / (sigma * 0.9);
      val = Math.max(val, 0.42 * Math.exp(-0.5 * d2 * d2));
    }
    return val;
  };

  ctx.beginPath();
  ctx.moveTo(innerX, baselineY);
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = innerX + u * innerW;
    const y = baselineY - evalCurve(u) * peakH;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(innerX + innerW, baselineY);
  ctx.closePath();

  ctx.fillStyle = 'rgba(134, 57, 38, 0.16)';
  ctx.fill();

  // Crisp stroke on top
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = innerX + u * innerW;
    const y = baselineY - evalCurve(u) * peakH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#863926';
  ctx.lineWidth = 3.5;
  ctx.stroke();

  // Center dashed vertical line + apex dot (dead-center on peakX)
  ctx.strokeStyle = 'rgba(134, 57, 38, 0.75)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(peakX, plotY + 18);
  ctx.lineTo(peakX, baselineY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#863926';
  ctx.beginPath();
  ctx.arc(peakX, baselineY - peakH, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fbf3e2';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Footer
  ctx.textAlign = 'left';
  ctx.fillStyle = '#514a39';
  ctx.font = '500 20px "JetBrains Mono", monospace';
  ctx.fillText(
    `${formatHz(match.frequencyHz)}${match.octaveVerified ? ' · Octave-checked' : ''}`,
    84,
    598
  );

  ctx.textAlign = 'right';
  ctx.fillStyle = '#514a39';
  ctx.font = '500 20px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.fillText('tinnitune.algoty.com · 100% private in-browser', w - 84, 598);

  return canvas.toDataURL('image/png');
}
