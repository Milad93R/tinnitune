import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/plus-jakarta-sans/latin-400.css';
import '@fontsource/plus-jakarta-sans/latin-500.css';
import '@fontsource/plus-jakarta-sans/latin-600.css';
import '@fontsource/plus-jakarta-sans/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './styles/tokens.css';
import './styles/app.css';
import * as dsp from './audio/dsp';
import { TinnituneAudioEngine } from './audio/engine';
import { App } from './App';

(window as unknown as { __tinnituneDsp?: typeof dsp & { TinnituneAudioEngine: typeof TinnituneAudioEngine } }).__tinnituneDsp = { ...dsp, TinnituneAudioEngine };

// Register service worker in production for offline PWA support
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Ignore SW registration failures in restricted contexts
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
