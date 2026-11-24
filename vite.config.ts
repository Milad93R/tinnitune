import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Post-build plugin that injects the exact hashed Vite bundle assets, self-hosted .woff2 fonts,
 * WebP art assets, and PWA icons into dist/sw.js (explicitly excluding /index.html which
 * Cloudflare Pages 308-redirects to /).
 */
function injectSwPrecacheManifest(): Plugin {
  return {
    name: 'tinnitune-sw-precache',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(process.cwd(), 'dist');
      const swPath = path.join(distDir, 'sw.js');
      if (!fs.existsSync(swPath)) return;

      const urls = new Set<string>(['/']);
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          const rel = '/' + path.relative(distDir, full).split(path.sep).join('/');
          // Never precache /index.html (Cloudflare Pages 308 redirects it to /), sw.js, or edge meta files
          if (
            rel === '/index.html' ||
            rel === '/sw.js' ||
            rel === '/_headers' ||
            rel === '/robots.txt' ||
            rel === '/404.html'
          ) {
            continue;
          }
          // Modern browsers use .woff2; skip legacy .woff from precache to keep install lightweight
          if (rel.endsWith('.woff')) continue;
          urls.add(rel);
        }
      };

      walk(distDir);
      const sortedUrls = Array.from(urls).sort();
      const hash = crypto
        .createHash('sha256')
        .update(sortedUrls.join('\n'))
        .digest('hex')
        .slice(0, 8);

      let sw = fs.readFileSync(swPath, 'utf8');
      sw = sw.replace(
        /const CACHE_NAME = '[^']+';/,
        `const CACHE_NAME = 'tinnitune-v2-${hash}';`
      );
      sw = sw.replace(
        /const PRECACHE = \/\*__PRECACHE_MANIFEST__\*\/ \[[\s\S]*?\];/,
        `const PRECACHE = ${JSON.stringify(sortedUrls, null, 2)};`
      );
      fs.writeFileSync(swPath, sw, 'utf8');
    },
  };
}

export default defineConfig({
  plugins: [react(), injectSwPrecacheManifest()],
  server: {
    host: '127.0.0.1',
    port: 6805,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 6805,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
});
