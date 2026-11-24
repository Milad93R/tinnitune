import { useLayoutEffect, useRef } from 'react';

export function PlaybackError({ message, testId, onReviewSetup }: {
  message: string;
  testId: string;
  onReviewSetup?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const headerBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? top;
    const nav = document.querySelector('.mobile-bottom-nav');
    const navTop = nav?.getClientRects().length && getComputedStyle(nav).visibility === 'visible'
      ? nav.getBoundingClientRect().top : bottom;
    if (rect.top < Math.max(top, headerBottom) || rect.bottom > Math.min(bottom, navTop)) {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [message]);

  return (
    <div ref={ref} className="inline-error playback-error" data-testid={testId}>
      <div role="alert">{message}</div>
      {onReviewSetup && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReviewSetup}>
          Review safety in Setup
        </button>
      )}
    </div>
  );
}
