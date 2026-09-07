import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
      '@cabo': fileURLToPath(new URL('../../packages/engine-cabo/src', import.meta.url)),
      '@pairone': fileURLToPath(new URL('../../packages/engine-pairone/src', import.meta.url)),
      '@seep': fileURLToPath(new URL('../../packages/engine-seep/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
      // Keep the Game Lab API on the same origin during local development.
      // Without this, fetch('/api/lab/...') falls through to Vite's SPA
      // fallback and the client attempts to parse index.html as JSON.
      '/api': {
        target: 'http://127.0.0.1:3000',
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
  define: {
    __DEBUG__: mode !== 'production',
  },
}));
