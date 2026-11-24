import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:6805';

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-webgl', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const results = await page.evaluate(async () => {
      const dsp = window.__tinnituneDsp;
      if (!dsp) throw new Error('window.__tinnituneDsp not exposed');

      const sampleRate = 48000;

      // Helper: Welch-averaged magnitude spectrum (dB) over multiple 4096-pt frames
      function avgSpectrumDb(samples, fftSize = 4096) {
        const bins = fftSize / 2;
        const power = new Float64Array(bins);
        const hop = fftSize / 2;
        let frames = 0;
        for (let off = fftSize; off + fftSize <= samples.length; off += hop) {
          const slice = samples.subarray(off, off + fftSize);
          const db = dsp.computeMagnitudeSpectrumDb(slice, fftSize);
          for (let b = 0; b < bins; b++) {
            power[b] += Math.pow(10, db[b] / 10);
          }
          frames++;
        }
        const out = new Float32Array(bins);
        for (let b = 0; b < bins; b++) {
          out[b] = 10 * Math.log10(Math.max(1e-12, power[b] / Math.max(1, frames)));
        }
        return out;
      }

      // 1. Test cascaded notch filter attenuation & passband ripple at 1000 Hz, 6350 Hz, 15500 Hz
      async function measureNotch(centerHz, widthOct = 1.0) {
        const durSec = 1.5;
        const len = Math.floor(sampleRate * durSec);
        const offRef = new OfflineAudioContext(1, len, sampleRate);
        const offNotch = new OfflineAudioContext(1, len, sampleRate);

        const white = new Float32Array(len);
        dsp.fillNoiseChannel(white, 'white', sampleRate, 2026);

        const bufRef = offRef.createBuffer(1, len, sampleRate);
        bufRef.copyToChannel(white, 0);
        const sRef = offRef.createBufferSource();
        sRef.buffer = bufRef;
        sRef.connect(offRef.destination);
        sRef.start(0);

        const bufN = offNotch.createBuffer(1, len, sampleRate);
        bufN.copyToChannel(white, 0);
        const sN = offNotch.createBufferSource();
        sN.buffer = bufN;
        const chain = dsp.createNotchChain(offNotch, centerHz, widthOct, true);
        sN.connect(chain.input);
        chain.output.connect(offNotch.destination);
        sN.start(0);

        const [rRef, rNotch] = await Promise.all([offRef.startRendering(), offNotch.startRendering()]);
        const specRef = avgSpectrumDb(rRef.getChannelData(0), 4096);
        const specNotch = avgSpectrumDb(rNotch.getChannelData(0), 4096);
        const binHz = sampleRate / 4096;

        // Measure attenuation at center bin (exact) and ±1 bin average
        const cBin = Math.round(centerHz / binHz);
        const centerAttenDb = specRef[cBin] - specNotch[cBin];

        // Measure passband ripple & insertion loss outside ±2 octaves from center
        const passDiffs = [];
        for (let b = Math.ceil(250 / binHz); b <= Math.floor(17000 / binHz); b++) {
          const f = b * binHz;
          if (f < centerHz / 4 || f > centerHz * 4) {
            passDiffs.push(specNotch[b] - specRef[b]);
          }
        }
        const maxPassDev = Math.max(...passDiffs.map((d) => Math.abs(d)));
        const minPass = Math.min(...passDiffs);
        const maxPass = Math.max(...passDiffs);
        const rippleDb = maxPass - minPass;

        return { centerHz, centerAttenDb, maxPassDev, rippleDb };
      }

      const notch1k = await measureNotch(1000, 1.0);
      const notch6350 = await measureNotch(6350, 1.0);
      const notch15500 = await measureNotch(15500, 1.0);

      // 2. Test Hard Safety Limiter strictly <= -6 dBFS under extreme +12 dB overload (4.0 peak)
      const limLen = sampleRate;
      const offLim = new OfflineAudioContext(1, limLen, sampleRate);
      const hotBuf = offLim.createBuffer(1, limLen, sampleRate);
      const hotData = hotBuf.getChannelData(0);
      for (let i = 0; i < limLen; i++) {
        // Sudden full-scale transient step + +12 dB sine + noise spikes
        const t = i / sampleRate;
        const burst = i === 1000 ? 6.0 : 0;
        hotData[i] = 4.0 * Math.sin(2 * Math.PI * 1000 * t) + burst;
      }
      const hotSrc = offLim.createBufferSource();
      hotSrc.buffer = hotBuf;
      const limiter = dsp.createMasterSafetyLimiter(offLim);
      hotSrc.connect(limiter.input);
      limiter.output.connect(offLim.destination);
      hotSrc.start(0);
      const limRendered = await offLim.startRendering();
      const limSamples = limRendered.getChannelData(0);
      let maxAbs = 0;
      for (let i = 0; i < limSamples.length; i++) {
        const a = Math.abs(limSamples[i]);
        if (a > maxAbs) maxAbs = a;
      }
      const maxPeakDbfs = 20 * Math.log10(Math.max(1e-10, maxAbs));

      // Probe each actual Web Audio chain, including the response near Nyquist.
      const widths = [];
      const centerGrid = [...new Set([
        250, 1000, 6350, 15500, 18000,
        ...Array.from({ length: 49 }, (_, i) => Math.round(250 * (18000 / 250) ** (i / 48))),
      ])];
      for (const rate of [44100, 48000, 96000]) {
        const offline = new OfflineAudioContext(2, 128, rate);
        for (const center of centerGrid) {
          for (const octaves of [0.5, 1, 1.5]) {
            const design = dsp.designDigitalNotch(center, octaves, rate);
            const chain = dsp.createNotchChain(offline, center, octaves, true);
            const frequencies = new Float32Array(1);
            const magnitude = new Float32Array(1);
            const phase = new Float32Array(1);
            function response(hz) {
              frequencies[0] = hz;
              let gain = 1;
              for (const stage of chain.stages) {
                stage.getFrequencyResponse(frequencies, magnitude, phase);
                gain *= magnitude[0];
              }
              return 20 * Math.log10(Math.max(1e-16, gain));
            }
            function edge(db, upper) {
              let low = upper ? center : 1;
              let high = upper ? rate / 2 - 1 : center;
              for (let i = 0; i < 25; i++) {
                const f = (low + high) / 2;
                if ((response(f) < db) === upper) low = f;
                else high = f;
              }
              return (low + high) / 2;
            }
            const low = edge(-3, false);
            const high = edge(-3, true);
            const low30 = edge(-30, false);
            const high30 = edge(-30, true);
            widths.push({
              rate, center, octaves, low, high, low30, high30,
              width: Math.log2(high / low), width30: Math.log2(high30 / low30),
              depth: -response(center),
              modelErrorHz: Math.max(Math.abs(low - design.lowHz), Math.abs(high - design.highHz)),
              thresholdError: Math.max(...[low, high, low30, high30].map((hz, i) =>
                Math.abs(dsp.theoreticalNotchResponseDb(hz, design) - (i < 2 ? -3 : -30)))),
            });
            chain.disconnect();
          }
        }
      }

      // Measure the actual engine's matching and RI filters, independent of its design math.
      const matchingBands = [];
      for (const rate of [44100, 48000, 96000]) {
        const offline = new OfflineAudioContext(2, 128, rate);
        const engine = new dsp.TinnituneAudioEngine(offline);
        engine.setSafetyAcknowledged(true);
        const makeBiquad = offline.createBiquadFilter.bind(offline);
        const nodes = [];
        offline.createBiquadFilter = () => {
          const node = makeBiquad();
          nodes.push(node);
          return node;
        };
        const frequency = new Float32Array(1);
        const magnitude = new Float32Array(1);
        const phase = new Float32Array(1);
        for (const center of [250, 1000, 6350, 15500, 18000]) {
          for (const type of ['hiss', 'whoosh', 'ri']) {
            const presets = type === 'ri' ? [0.45] : [0.08, 0.25, 0.5, 1.1, 2];
            for (const octaves of presets) {
              nodes.length = 0;
              if (type === 'ri') {
                await engine.startResidualInhibitionStimulus(center, 'both');
              } else {
                await engine.playMatchSound({ soundType: type, frequencyHz: center, loudness: 48,
                  bandwidthOct: octaves, ear: 'both' }, true);
              }
              const stages = nodes.filter((node) => node.type === 'bandpass');
              if (stages.length !== 2) throw new Error(`Expected two active stages for ${type}`);
              const dbAt = (hz) => {
                frequency[0] = hz;
                let gain = 1;
                for (const stage of stages) {
                  stage.getFrequencyResponse(frequency, magnitude, phase);
                  gain *= magnitude[0];
                }
                return 20 * Math.log10(gain);
              };
              const peak = dbAt(center);
              const edge = (upper) => {
                let low = upper ? center : 1;
                let high = upper ? rate / 2 : center;
                for (let i = 0; i < 27; i++) {
                  const hz = (low + high) / 2;
                  if ((dbAt(hz) > peak - 3) === upper) low = hz;
                  else high = hz;
                }
                return (low + high) / 2;
              };
              const low = edge(false);
              const high = edge(true);
              const fitted = dsp.designDigitalBandpass(center, octaves, rate);
              matchingBands.push({ rate, center, type, octaves, low, high, peak,
                width: Math.log2(high / low),
                modelErrorHz: Math.max(Math.abs(low - fitted.lowHz), Math.abs(high - fitted.highHz)),
              });
            }
          }
        }
        engine.stop();
      }

      // Replay the QA sine through the real decoded-music transport and final limiter.
      // Four toggles include both directions and two reversals inside the crossfade.
      const toggles = [];
      for (const rate of [44100, 48000, 96000]) {
        for (const frequency of [250, 500]) {
          for (const phase of [0, Math.PI / 3, Math.PI / 2]) {
            const offline = new OfflineAudioContext(2, Math.ceil(0.47 * rate), rate);
            const engine = new dsp.TinnituneAudioEngine(offline);
            engine.setSafetyAcknowledged(true);
            engine.setComfortLevel(1);
            const buffer = offline.createBuffer(2, offline.length, rate);
            for (let channel = 0; channel < 2; channel++) {
              const samples = buffer.getChannelData(channel);
              for (let i = 0; i < samples.length; i++) {
                samples[i] = 0.98 * Math.sin(2 * Math.PI * frequency * i / rate + phase + channel * 0.71);
              }
            }
            const center = frequency === 250 ? frequency : frequency * 1.025;
            await engine.startDecodedMusicBuffer(buffer, 0, center, 1, false, 1);
            const switches = [[0.15, true], [0.28, false], [0.295, true], [0.31, false]].map(([time, enabled]) =>
              offline.suspend(time).then(async () => {
                engine.updateActiveNotch(center, 1, enabled);
                await offline.resume();
              }));
            const rendered = await offline.startRendering();
            await Promise.all(switches);
            const stats = (data, start, end) => {
              let step = 0;
              let sum = 0;
              let peak = 0;
              const first = Math.ceil(start * rate);
              const last = Math.floor(end * rate);
              for (let i = first; i < last; i++) {
                step = Math.max(step, Math.abs(data[i] - data[i - 1]));
                sum += data[i] ** 2;
                peak = Math.max(peak, Math.abs(data[i]));
              }
              return { step, rms: Math.sqrt(sum / (last - first)), peak };
            };
            for (let channel = 0; channel < 2; channel++) {
              const data = rendered.getChannelData(channel);
              const dry = stats(data, 0.10, 0.14);
              const wet = stats(data, 0.23, 0.27);
              const restoredDry = stats(data, 0.40, 0.46);
              const transition = stats(data, 0.145, 0.39);
              toggles.push({ rate, frequency, phase, channel, beforeStep: dry.step,
                transitionStep: transition.step, stepDeltaDb: 20 * Math.log10(transition.step / dry.step),
                peakDelta: transition.peak - dry.peak,
                attenuationDb: 20 * Math.log10(dry.rms / wet.rms),
                restoredRatio: restoredDry.rms / dry.rms,
              });
            }
          }
        }
      }

      // The native gain envelope reaches silence at the updated deadline even
      // when no JavaScript countdown tick has run.
      const timerRate = 16000;
      const timerContext = new OfflineAudioContext(2, 36 * timerRate, timerRate);
      const timedEngine = new dsp.TinnituneAudioEngine(timerContext);
      timedEngine.setSafetyAcknowledged(true);
      timedEngine.setComfortLevel(1);
      await timedEngine.startNotchedNoise({
        centerHz: 1000, notchWidthOct: 1, notchEnabled: false, noiseType: 'white', volume: 0.72, ear: 'both',
      });
      timedEngine.setTherapyTiming(0.72, 31, 0.14);
      const extend = timerContext.suspend(10).then(async () => {
        timedEngine.setTherapyTiming(0.72, 35 - timerContext.currentTime);
        await timerContext.resume();
      });
      const timerPcm = (await timerContext.startRendering()).getChannelData(0);
      await extend;
      const timerRms = [1, 16, 31.2, 34.5, 35.1].map((start) => {
        const samples = timerPcm.subarray(Math.round(start * timerRate), Math.round((start + 0.3) * timerRate));
        return Math.sqrt(samples.reduce((sum, sample) => sum + sample ** 2, 0) / samples.length);
      });

      const checkRate = 48000;
      const rms = (buffer, channel, start, end) => {
        const pcm = buffer.getChannelData(channel).subarray(Math.round(start * checkRate), Math.round(end * checkRate));
        return Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
      };
      const calibrationRoutes = [];
      for (const ear of ['both', 'left', 'right']) {
        const offline = new OfflineAudioContext(2, checkRate / 2, checkRate);
        const engine = new dsp.TinnituneAudioEngine(offline);
        engine.setSafetyAcknowledged(true);
        engine.setEar(ear === 'right' ? 'left' : 'right');
        if (ear === 'both') await engine.startCalibrationTone();
        else await engine.startCalibrationTone(ear);
        const output = await offline.startRendering();
        calibrationRoutes.push({ ear, channels: [0, 1].map((channel) => rms(output, channel, 0.018, 0.043)) });
      }

      const lowRateEngine = new dsp.TinnituneAudioEngine(new OfflineAudioContext(2, 128, 32000));
      lowRateEngine.setSafetyAcknowledged(true);
      let unsupportedRiPitchBlocked = false;
      try {
        await lowRateEngine.startResidualInhibitionStimulus(18000, 'right');
      } catch (error) {
        unsupportedRiPitchBlocked = error.message.includes('cannot play the saved pitch') && !lowRateEngine.getSnapshot().isPlaying;
      }

      const therapyContext = new OfflineAudioContext(2, checkRate, checkRate);
      const therapyEngine = new dsp.TinnituneAudioEngine(therapyContext);
      therapyEngine.setSafetyAcknowledged(true);
      await therapyEngine.startNotchedNoise({
        centerHz: 2000, notchWidthOct: 1, notchEnabled: false, noiseType: 'white', volume: 0.72, ear: 'both',
      });
      const switches = [[0.34, true], [0.65, false]].map(([time, enabled]) => therapyContext.suspend(time).then(() => {
        therapyEngine.updateActiveNotch(2000, 1, enabled);
        return therapyContext.resume();
      }));
      const therapyPcm = (await therapyContext.startRendering()).getChannelData(0);
      await Promise.all(switches);
      const therapyBands = [0.15, 0.45, 0.78].map((start) => {
        const n = 8192;
        const binHz = checkRate / n;
        const offset = Math.round(start * checkRate);
        const spectrum = dsp.computeMagnitudeSpectrumDb(therapyPcm.subarray(offset, offset + n), n);
        const bandPower = (lo, hi) => spectrum.slice(Math.ceil(lo / binHz), Math.ceil(hi / binHz))
          .reduce((sum, db) => sum + 10 ** (db / 10), 0);
        return 10 * Math.log10(bandPower(1940, 2060) / bandPower(3400, 3520));
      });

      const musicRepeat = [];
      for (const repeat of [false, true]) {
        const offline = new OfflineAudioContext(2, checkRate, checkRate);
        const engine = new dsp.TinnituneAudioEngine(offline);
        engine.setSafetyAcknowledged(true);
        const clip = offline.createBuffer(1, checkRate / 4, checkRate);
        const data = clip.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / checkRate);
        await engine.startDecodedMusicBuffer(clip, 0, 2000, 1, false, 1, { repeat });
        let repeatChange;
        if (repeat) {
          repeatChange = offline.suspend(0.4).then(() => {
            engine.setBufferMusicRepeat(false);
            return offline.resume();
          });
        }
        const output = await offline.startRendering();
        await repeatChange;
        musicRepeat.push({
          repeat, first: rms(output, 0, 0.14, 0.19), second: rms(output, 0, 0.30, 0.36),
          finishing: rms(output, 0, 0.43, 0.47),
          tail: rms(output, 0, 0.6, 0.7),
        });
      }

      // Independent 16×, 64-tap Blackman-windowed sinc reconstruction.
      const sinc = (x) => x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      function kernel(t) {
        const taps = Array.from({ length: 64 }, (_, i) => {
          const x = i - 31 - t;
          return sinc(x) * (0.42 + 0.5 * Math.cos(Math.PI * x / 32) + 0.08 * Math.cos(2 * Math.PI * x / 32));
        });
        const sum = taps.reduce((a, b) => a + b);
        return taps.map((tap) => tap / sum);
      }
      const kernels = Array.from({ length: 15 }, (_, i) => kernel((i + 1) / 16));
      const maxKernelNorm = Math.max(...Array.from({ length: 1025 }, (_, i) =>
        kernel(i / 1024).reduce((sum, weight) => sum + Math.abs(weight), 0)));
      function measure(buffer, independent) {
        let sample = 0;
        let annex = 0;
        let reconstructed = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const pcm = buffer.getChannelData(channel);
          annex = Math.max(annex, dsp.measureTruePeak(pcm));
          for (const x of pcm) {
            if (!Number.isFinite(x)) throw new Error('Non-finite output sample');
            sample = Math.max(sample, Math.abs(x));
          }
          if (!independent) continue;
          for (const taps of kernels) {
            for (let i = -63; i < pcm.length; i++) {
              let sum = 0;
              for (let j = Math.max(0, -i); j < Math.min(64, pcm.length - i); j++) {
                sum += pcm[i + j] * taps[j];
              }
              reconstructed = Math.max(reconstructed, Math.abs(sum));
            }
          }
        }
        return { sample, annex, reconstructed };
      }
      function stressBuffer(ctx, fixture, channels = 2) {
        const buffer = ctx.createBuffer(channels, ctx.length, ctx.sampleRate);
        for (let channel = 0; channel < channels; channel++) {
          const pcm = buffer.getChannelData(channel);
          for (let i = 0; i < pcm.length; i++) {
            const t = i + channel * 13;
            if (fixture === 'impulses') pcm[i] = t % 371 === 0 ? 1 - 2 * channel : 0;
            if (fixture === 'bursts') pcm[i] = t % 233 < 21 ? Math.sin(Math.PI * t / 2 + Math.PI / 4) : 0;
            if (fixture === 'overload') pcm[i] = 4 * Math.sin(2 * Math.PI * 1000 * t / ctx.sampleRate) + (t % 371 === 0 ? 6 : 0);
            if (fixture === 'adversarial') pcm[i] = t % 113 < 64 ? 50 * Math.sign(kernels[7][t % 113]) : 0;
          }
        }
        return buffer;
      }
      const peaks = [];
      for (const rate of [44100, 48000]) {
        for (const type of ['impulses', 'bursts', 'overload', 'adversarial']) {
          const offline = new OfflineAudioContext(2, Math.floor(rate * 0.18), rate);
          const src = offline.createBufferSource();
          src.buffer = stressBuffer(offline, type, type === 'overload' ? 1 : 2);
          const limiter = dsp.createMasterSafetyLimiter(offline);
          src.connect(type === 'adversarial' ? limiter.shaper : limiter.input);
          limiter.output.connect(offline.destination);
          src.start();
          peaks.push({ rate, path: type, ...measure(await offline.startRendering(), true) });
        }

        const fixtures = [
          ...['left', 'right'].map((ear) => ({ path: `chime-${ear}`, play: (engine) => engine.playEarCheck(ear) })),
          { path: 'calibration', play: (engine) => engine.startCalibrationTone() },
          ...[250, 6350, 15500, 18000].flatMap((frequencyHz) => [
            { path: `mask-${frequencyHz}`, play: (engine) => engine.startResidualInhibitionStimulus(frequencyHz, 'right', 0.72) },
            ...['tone', 'hiss', 'whoosh', 'buzz', 'crickets'].flatMap((soundType) =>
              (['hiss', 'whoosh'].includes(soundType) ? [0.08, 0.5, 2] : [0.25]).flatMap((bandwidthOct) =>
                [5, 48, 100].map((loudness) => ({
                  path: `${soundType}-${frequencyHz}-${bandwidthOct}-${loudness}`,
                  play: (engine) => engine.playMatchSound({ soundType, frequencyHz, loudness, bandwidthOct, pulseRateHz: 24, ear: 'both' }),
                })),
              ),
            ),
          ]),
          ...['white', 'pink', 'brown', 'rain', 'ocean'].flatMap((noiseType) =>
            [0.5, 1, 1.5].flatMap((notchWidthOct) => [0.1, 0.72, 1].map((volume) => ({
              path: `${noiseType}-${notchWidthOct}-${volume}`,
              play: (engine) => engine.startNotchedNoise({ noiseType, centerHz: 15500, notchWidthOct, notchEnabled: true, volume, ear: 'left' }),
            }))),
          ),
          ...[false, true].flatMap((notched) => [0.1, 0.78, 1].map((level) => ({
            path: `music-${notched}-${level}`, play: (engine, off) =>
              engine.startDecodedMusicBuffer(stressBuffer(off, 'bursts'), 0, 15500, 1, notched, level), independent: true,
          }))),
          { path: 'music-full-scale-impulses', play: (engine, off) =>
            engine.startDecodedMusicBuffer(stressBuffer(off, 'impulses'), 0, 15500, 1, true, 1), independent: true },
          { path: 'music-built-in', play: (engine) => engine.startBuiltInSample(2, 6350, 1, true, 1), independent: true },
        ];
        for (const { path, play, independent } of fixtures) {
          const offline = new OfflineAudioContext(2, Math.floor(rate * 0.22), rate);
          const engine = new dsp.TinnituneAudioEngine(offline);
          engine.setSafetyAcknowledged(true);
          engine.setComfortLevel(1);
          await play(engine, offline);
          peaks.push({ rate, path, ...measure(await offline.startRendering(), independent) });
          engine.stop(0.005);
        }
      }

      // 3. Test Noise Generators Spectral Slopes (White 0, Pink -3, Brown -6 dB/oct)
      async function measureNoiseSlope(type) {
        const durSec = 2.0;
        const len = Math.floor(sampleRate * durSec);
        const off = new OfflineAudioContext(1, len, sampleRate);
        const buf = dsp.createNoiseBuffer(off, type, durSec);
        const src = off.createBufferSource();
        src.buffer = buf;
        src.connect(off.destination);
        src.start(0);
        const rendered = await off.startRendering();
        const spec = avgSpectrumDb(rendered.getChannelData(0), 4096);
        return dsp.measureSpectralSlopeDbPerOct(spec, sampleRate, 250, 8000);
      }

      const whiteSlope = await measureNoiseSlope('white');
      const pinkSlope = await measureNoiseSlope('pink');
      const brownSlope = await measureNoiseSlope('brown');

      // Render the production ten-second loop through the notch, routing and limiter.
      const noiseSeams = [];
      for (const rate of [44100, 48000, 96000]) {
        const seam = rate * 10;
        for (const noiseType of ['white', 'pink', 'brown', 'rain', 'ocean']) {
          for (const notchEnabled of [false, true]) {
            const offline = new OfflineAudioContext(2, seam + 8, rate);
            const engine = new dsp.TinnituneAudioEngine(offline);
            engine.setSafetyAcknowledged(true);
            await engine.startNotchedNoise({ noiseType, centerHz: 6350, notchWidthOct: 1, notchEnabled, volume: 0.72, ear: 'both' });
            const rendered = await offline.startRendering();
            for (let channel = 0; channel < 2; channel++) {
              const samples = rendered.getChannelData(channel);
              const step = (i) => Math.abs(samples[i] - samples[i - 1]);
              const previous = Float32Array.from({ length: rate }, (_, i) => step(seam - rate - 4 + i));
              previous.sort();
              const typical = previous[Math.floor(previous.length * 0.999)];
              const jump = step(seam);
              const nearbyMax = Math.max(...Array.from({ length: 9 }, (_, i) => step(seam - 4 + i)));
              noiseSeams.push({ rate, noiseType, notchEnabled, channel, jump, nearbyMax, typical, ratio: nearbyMax / typical });
            }
            engine.stop(0.005);
          }
        }
      }

      // 4. Test Click-Free Gain Ramping (no abrupt jump on start/stop)
      const rampLen = Math.floor(sampleRate * 0.25);
      const offRamp = new OfflineAudioContext(1, rampLen, sampleRate);
      const osc = offRamp.createOscillator();
      osc.frequency.value = 440;
      const g = offRamp.createGain();
      g.gain.setValueAtTime(0, 0);
      dsp.rampGain(g.gain, 0.4, 0, 0.035);
      dsp.rampGain(g.gain, 0, 0.15, 0.035);
      osc.connect(g);
      g.connect(offRamp.destination);
      osc.start(0);
      osc.stop(0.22);
      const rampOut = (await offRamp.startRendering()).getChannelData(0);
      let maxSampleJump = 0;
      for (let i = 1; i < rampOut.length; i++) {
        const diff = Math.abs(rampOut[i] - rampOut[i - 1]);
        if (diff > maxSampleJump) maxSampleJump = diff;
      }

      return {
        notch1k,
        notch6350,
        notch15500,
        maxAbs,
        maxPeakDbfs,
        widths,
        matchingBands,
        toggles,
        timerRms,
        calibrationRoutes,
        unsupportedRiPitchBlocked,
        therapyBands,
        musicRepeat,
        peaks,
        maxKernelNorm,
        whiteSlope,
        pinkSlope,
        brownSlope,
        noiseSeams,
        firstSample: Math.abs(rampOut[0]),
        lastSample: Math.abs(rampOut[rampOut.length - 1]),
        maxSampleJump,
      };
    });

    assert.equal(errors.length, 0, `Page errors during DSP test: ${errors.join('; ')}`);

    console.log('DSP OfflineAudioContext + FFT Measurements:');
    const { widths, matchingBands, toggles, peaks, noiseSeams, ...other } = results;
    const selected = widths.filter(({ center, octaves }) => octaves === 1 && [250, 1000, 6350, 15500, 18000].includes(center));
    const ranked = [...peaks].sort((a, b) => Math.max(b.annex, b.reconstructed) - Math.max(a.annex, a.reconstructed));
    const noiseBeds = ['white', 'pink', 'brown', 'rain', 'ocean'];
    console.log(JSON.stringify({
      ...other,
      widthCases: widths.length,
      maximumWidthErrorOct: Math.max(...widths.map((item) => Math.abs(item.width - item.octaves))),
      notchWidths: selected,
      matchingWidthCases: matchingBands.length,
      maximumMatchingWidthErrorOct: Math.max(...matchingBands.map((item) => Math.abs(item.width - item.octaves))),
      maximumMatchingEdgeErrorHz: Math.max(...matchingBands.map((item) => item.modelErrorHz)),
      matchingWidths44100: matchingBands.filter((item) => item.rate === 44100
        && (item.octaves === 0.5 || (item.type === 'whoosh' && item.octaves === 1.1) || item.type === 'ri'))
        .map(({ type, octaves, center, low, high, width }) => ({
          type, octaves, center, low: Math.round(low), high: Math.round(high), width: Number(width.toFixed(6)),
        })),
      notchToggleCases: toggles.length,
      worstToggleStepDelta: toggles.reduce((worst, item) => item.stepDeltaDb > worst.stepDeltaDb ? item : worst),
      maximumPositivePeakDelta: Math.max(...toggles.map((item) => item.peakDelta)),
      qa250Hz48kHzToggle: toggles.filter((item) => item.rate === 48000 && item.frequency === 250)
        .reduce((worst, item) => item.stepDeltaDb > worst.stepDeltaDb ? item : worst),
      peakCases: peaks.length,
      noiseSeamCases: noiseSeams.length,
      largestNoiseSeamJumps: noiseBeds.map((type) =>
        noiseSeams.filter((item) => item.noiseType === type).reduce((worst, item) => item.jump > worst.jump ? item : worst)),
      worstNoiseSeams: noiseBeds.map((type) =>
        noiseSeams.filter((item) => item.noiseType === type).reduce((worst, item) => item.ratio > worst.ratio ? item : worst)),
      peakCasesByRate: [44100, 48000].map((rate) => ({
        rate, peak: ranked.find((item) => item.rate === rate),
        impulse: ranked.find((item) => item.rate === rate && item.path === 'impulses'),
        music: ranked.find((item) => item.rate === rate && item.path.startsWith('music-')),
      })),
    }, null, 2));

    const limit = 10 ** (-6 / 20);
    assert.equal(noiseSeams.length, 60);
    for (const seam of noiseSeams) {
      assert.ok(seam.typical > 0 && seam.ratio <= 1.5,
        `Noise loop jump within ±4 frames must be within 1.5× p99.9 of ordinary steps: ${JSON.stringify(seam)}`);
    }
    assert.ok(results.unsupportedRiPitchBlocked, 'RI must never substitute a lower pitch for an unsupported match');
    for (const { ear, channels } of results.calibrationRoutes) {
      for (const [index, channel] of ['left', 'right'].entries()) {
        assert.ok(ear === 'both' || ear === channel ? channels[index] > 0.001 : channels[index] < 1e-8,
          `Calibration ${ear}: ${channels}`);
      }
    }
    const [dry, notched, restored] = results.therapyBands;
    assert.ok(dry - notched > 24 && restored - notched > 24 && Math.abs(dry - restored) < 6,
      `Therapy dry → notched → dry (dB): ${results.therapyBands}`);
    for (const item of results.musicRepeat) {
      assert.ok(item.first > 0.005 && (item.repeat ? item.second > 0.005 && item.finishing > 0.005 : item.second < 1e-6)
        && item.tail < 1e-6,
        `Decoded one-pass/repeat output: ${JSON.stringify(item)}`);
    }
    assert.ok(results.maxKernelNorm * 0.174 < limit, 'The final sample ceiling must bound the reconstruction kernel');
    for (const item of widths) {
      assert.ok(Math.abs(item.width - item.octaves) < 0.002 && item.depth >= 30
        && item.modelErrorHz < 2 && item.thresholdError < 0.1 && item.width30 > 0 && item.width30 < item.width,
      `Notch mismatch: ${JSON.stringify(item)}`);
    }
    for (const item of matchingBands) {
      assert.ok(Math.abs(item.width - item.octaves) < 0.002 && item.modelErrorHz < 2
        && Math.abs(item.peak) < 0.01, `Bandwidth mismatch: ${JSON.stringify(item)}`);
    }
    for (const item of toggles) {
      assert.ok(item.stepDeltaDb < 1 && item.peakDelta < 0.002 && item.attenuationDb > 35
        && item.restoredRatio > 0.90 && item.restoredRatio < 1.10, `Music notch transition: ${JSON.stringify(item)}`);
    }
    const [initial, middle, afterPreviousDeadline, fading, finished] = results.timerRms;
    assert.ok(initial > middle && middle > afterPreviousDeadline && afterPreviousDeadline > fading
      && fading > 0.0001 && finished < 0.000001, `Timer envelope missed updated deadline: ${results.timerRms}`);
    for (const item of peaks) {
      assert.ok(item.sample > 0.0001 && item.sample <= 0.174001
        && Math.max(item.annex, item.reconstructed) <= limit, `Unsafe or silent audio: ${JSON.stringify(item)}`);
    }

    // Assertions per SPEC Quality criteria
    for (const n of [results.notch1k, results.notch6350, results.notch15500]) {
      assert.ok(
        n.centerAttenDb >= 30,
        `Notch at ${n.centerHz} Hz attenuation must be >= 30 dB, got ${n.centerAttenDb.toFixed(2)} dB`
      );
      assert.ok(
        n.rippleDb < 1.0,
        `Notch at ${n.centerHz} Hz passband ripple must be < 1.0 dB, got ${n.rippleDb.toFixed(3)} dB`
      );
      assert.ok(
        n.maxPassDev < 1.2,
        `Notch at ${n.centerHz} Hz passband deviation must be < 1.2 dB, got ${n.maxPassDev.toFixed(3)} dB`
      );
    }

    assert.ok(
      results.maxPeakDbfs <= -6.0,
      `Hard limiter must NEVER exceed -6.0 dBFS, got ${results.maxPeakDbfs.toFixed(2)} dBFS`
    );

    assert.ok(
      Math.abs(results.whiteSlope - 0) <= 0.7,
      `White noise slope expected 0 ± 0.7 dB/oct, got ${results.whiteSlope.toFixed(2)}`
    );
    assert.ok(
      Math.abs(results.pinkSlope - -3.0) <= 0.8,
      `Pink noise slope expected -3.0 ± 0.8 dB/oct, got ${results.pinkSlope.toFixed(2)}`
    );
    assert.ok(
      Math.abs(results.brownSlope - -6.0) <= 1.0,
      `Brown noise slope expected -6.0 ± 1.0 dB/oct, got ${results.brownSlope.toFixed(2)}`
    );

    assert.ok(results.firstSample < 0.005, `Start must ramp from zero (got ${results.firstSample})`);
    assert.ok(results.lastSample < 0.005, `Stop must ramp to zero (got ${results.lastSample})`);
    assert.ok(results.maxSampleJump < 0.04, `No click/pop discontinuity (max jump ${results.maxSampleJump})`);

    console.log('ALL WEBAUDIO DSP UNIT TESTS PASSED!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('DSP TEST FAILED:', err);
  process.exit(1);
});
