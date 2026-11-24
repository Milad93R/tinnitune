import React from 'react';
import { AlertTriangle, Brain, Ear, Headphones, Scale } from 'lucide-react';

const TINNITUS_GUIDELINE = 'https://pubmed.ncbi.nlm.nih.gov/25273878/';

export const EducationView: React.FC = () => {
  return (
    <div className="view-stack">
      <section className="hero-banner hero-banner-compact" aria-label="Evidence-based tinnitus guide">
        <div className="hero-banner-content">
          <div className="eyebrow">Evidence-Based Guide</div>
          <h1>Understanding tinnitus — honestly</h1>
          <p className="lead">
            No miracle claims and no fear-mongering. Here is what audiology research actually shows about
            phantom ringing, notched sound therapy, octave confusion, and when medical care matters.
          </p>
        </div>
        <figure className="onboard-art">
          <img src="/art/field-notes.webp" alt="" className="hero-banner-art"
            width={1200} height={800} loading="lazy" decoding="async" />
        </figure>
      </section>

      <div className="edu-grid">
        <article className="panel-card edu-card">
          <div className="card-title-group">
            <Brain size={19} className="accent-teal" />
            <h2>What tinnitus actually is</h2>
          </div>
          <p>
            Subjective tinnitus — experienced by roughly 10–15% of adults — is not usually an actual
            sound vibrating inside your ear. Instead, when cochlear hair cells lose sensitivity at a
            particular frequency band (often from age, noise exposure, or ear inflammation), the central
            auditory pathway turns up its neural gain in that region.
          </p>
          <p>
            Matching your sound helps you put concrete numbers on an invisible sensation: its center
            pitch, texture (tonal vs. hissing or buzzing), and how stable or reactive it is from day to
            day.
          </p>
          <div className="source-note">
            <a href="https://www.nidcd.nih.gov/health/tinnitus">NIDCD tinnitus fact sheet</a>
            <a href="https://pubmed.ncbi.nlm.nih.gov/23827090/">Baguley et al. (2013) · Tinnitus · The Lancet</a>
            <a href="https://researchportal.hw.ac.uk/en/publications/tinnitus/">Heriot-Watt Research Portal</a>
          </div>
        </article>

        <article className="panel-card edu-card">
          <div className="card-title-group">
            <Scale size={19} className="accent-amber" />
            <h2>Notched sound therapy: honest evidence</h2>
          </div>
          <p>
            Tailor-Made Notched Music Training (TMNMT) removes a 1-octave frequency band centered on your
            tinnitus pitch. The hypothesis is <em>lateral inhibition</em>: stimulating neighboring
            auditory neurons while starving the tinnitus band may gradually down-regulate overactive
            firing.
          </p>
          <p>
            <strong>The evidence is mixed.</strong> Early small trials (Okamoto et al., <em>PNAS</em>{' '}
            2010) reported modest loudness reductions after months of daily listening, whereas larger
            double-blind sham-controlled trials (Stein et al., <em>BMC Neurology</em> 2016; systematic
            reviews 2020–2023) found outcomes close to placebo/sound enrichment alone. Many people still
            find notched rain or music uniquely pleasant and restful — use it as gentle sound enrichment,
            not a guaranteed cure.
          </p>
          <div className="source-note">
            <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC2824261/">Okamoto et al. (2010)</a>
            <a href="https://pubmed.ncbi.nlm.nih.gov/26987755/">Stein et al. (2016)</a>
            <a href="https://www.cochrane.org/evidence/CD013094_sound-therapy-using-amplification-devices-andor-sound-generators-tinnitus">Cochrane sound therapy review</a>
          </div>
        </article>

        <article className="panel-card edu-card">
          <div className="card-title-group">
            <Headphones size={19} className="accent-violet" />
            <h2>Octave confusion &amp; ultra-high pitches</h2>
          </div>
          <p>
            Because pitches separated by an octave (<span className="mono">f/2</span>,{' '}
            <span className="mono">f</span>, <span className="mono">2f</span>) share harmonic similarity,
            clinical pitch-matching studies find that a large share of listeners initially pick a pitch
            one octave too low — especially when their real tinnitus sits above 10 kHz.
          </p>
          <p>
            Consumer earbuds also roll off steeply above 14–16 kHz. Tinnitune spans all the way to{' '}
            <span className="mono">18 kHz</span> and builds an explicit octave-confusion check directly
            into matching so your notch is placed accurately.
          </p>
          <div className="source-note">
            <a href="https://pubmed.ncbi.nlm.nih.gov/20103482/">Moore et al. (2010)</a>
            <a href="https://ohsu.elsevierpure.com/en/publications/comparison-of-two-computer-automated-procedures-for-tinnitus-pitc/">VA pitch-matching study</a>
          </div>
        </article>

        <article className="panel-card edu-card">
          <div className="card-title-group">
            <Ear size={19} className="accent-emerald" />
            <h2>Residual inhibition &amp; habituation</h2>
          </div>
          <p>
            <strong>Residual inhibition (RI)</strong> is the temporary quieting or disappearance of
            tinnitus for seconds to minutes after listening to a matched masking band for ~60 seconds.
            Observing RI is a reassuring sign that your auditory system responds to external acoustic
            input.
          </p>
          <p>
            For persistent bothersome tinnitus, the strongest clinical evidence supports{' '}
            <strong>Cognitive Behavioral Therapy (CBT)</strong> for tinnitus distress, hearing-aid
            amplification when hearing loss is present, and low-level sound enrichment so silence feels
            less stark.
          </p>
          <div className="source-note">
            <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC2580805/">Roberts et al. (2008)</a>
            <a href={TINNITUS_GUIDELINE}>AAO-HNS tinnitus guideline (2014)</a>
          </div>
        </article>
      </div>

      <section className="safety-callout redflags-card" aria-label="When to see a doctor">
        <div className="safety-icon">
          <AlertTriangle size={22} />
        </div>
        <div className="safety-body">
          <h2>When to see a doctor or audiologist promptly</h2>
          <ul className="redflags-list">
            <li>
              <strong>Sudden onset</strong> (especially alongside sudden hearing loss within 72 hours —
              treat as urgent ENT care).
            </li>
            <li>
              <strong>Strictly one-sided (unilateral)</strong> tinnitus that persists without an obvious
              cause like earwax.
            </li>
            <li>
              <strong>Pulsatile tinnitus</strong> — a rhythmic whooshing or thumping synced to your
              heartbeat.
            </li>
            <li>
              <strong>Neurological or ear symptoms</strong> — vertigo, balance loss, facial weakness,
              ear drainage, or pain.
            </li>
            <li>
              <strong>Heavy impact on sleep or mental health</strong> — an audiologist and tinnitus-trained
              CBT therapist can make a dramatic difference.
            </li>
          </ul>
          <div className="source-note">
            <a href={TINNITUS_GUIDELINE}>AAO-HNS tinnitus guideline (2014)</a>
            <a href="https://www.ata.org/about-tinnitus/why-are-my-ears-ringing/who-should-i-see-for-help/">ATA guide to finding care</a>
          </div>
        </div>
      </section>
    </div>
  );
};
