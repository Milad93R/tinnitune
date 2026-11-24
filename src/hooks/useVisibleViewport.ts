import { useLayoutEffect } from 'react';

export function useVisibleViewport(onChange: (viewport: VisualViewport) => void) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => onChange(viewport);
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
    };
  }, [onChange]);
}
