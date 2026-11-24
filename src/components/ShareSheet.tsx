import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { useVisibleViewport } from '../hooks/useVisibleViewport';

interface Props {
  headline: string;
  description: string;
  url: string;
  testId: string;
  opener: HTMLElement | null;
  onClose: () => void;
  onDownload: () => void;
}

export function ShareSheet({ headline, description, url, testId, opener, onClose, onDownload }: Props) {
  const titleId = useId();
  const [downloaded, setDownloaded] = useState(false);
  const [shortLayout, setShortLayout] = useState<'split' | 'stacked'>();
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const sheet = ref.current;
    if (!sheet) return;
    const focusTarget = opener ?? document.activeElement;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    document.body.style.setProperty('--locked-scroll-y', `-${scrollY}px`);
    document.body.classList.add('sheet-open');
    sheet.showModal();
    return () => {
      sheet.close();
      document.body.classList.remove('sheet-open');
      document.body.style.removeProperty('--locked-scroll-y');
      if (focusTarget instanceof HTMLElement) focusTarget.focus({ preventScroll: true });
      const restoreScroll = () => window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      restoreScroll();
      // WebKit may finish its native dialog focus scroll on the next frame.
      window.requestAnimationFrame(() => {
        if (!document.body.classList.contains('sheet-open')) restoreScroll();
      });
    };
  }, [opener]);

  useVisibleViewport(useCallback((viewport) => {
    const sheet = ref.current;
    if (!sheet || Math.abs(viewport.scale - 1) > 0.01) return;
    sheet.style.setProperty('--sheet-height', `${viewport.height}px`);
    sheet.style.setProperty('--sheet-top', `${viewport.offsetTop}px`);
    const { width, height } = viewport;
    setShortLayout(width >= 560 && height >= 140 && height <= 210 ? 'split' : height <= 260 ? 'stacked' : undefined);
  }, []));

  return createPortal(
    <dialog ref={ref} className="share-sheet" aria-labelledby={titleId} data-testid={testId} data-short={shortLayout}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="share-sheet-panel" tabIndex={shortLayout === 'stacked' ? 0 : undefined}>
        <header className="share-sheet-header">
          <h2 id={titleId}>Share your sound fingerprint</h2>
          <button type="button" className="btn btn-ghost sheet-close" onClick={onClose}
            aria-label="Close share preview" autoFocus>
            <X size={20} />
          </button>
        </header>
        <div className="share-sheet-scroll" tabIndex={shortLayout === 'stacked' ? undefined : 0}
          role="region" aria-label="Sound fingerprint preview">
          <img src={url} alt={headline} className="share-card-img" width={1200} height={675} />
          <div className="share-sheet-caption">
            <strong>{headline}</strong>
            <p>{description}</p>
          </div>
        </div>
        <footer className="share-sheet-footer">
          <span className="hint-text" role="status">{downloaded ? 'PNG download started' : ''}</span>
          <button type="button" className="btn btn-primary"
            onClick={() => { onDownload(); setDownloaded(true); }} data-testid="download-share-card">
            <Download size={16} /> Download PNG
          </button>
        </footer>
      </section>
    </dialog>,
    document.body,
  );
}
