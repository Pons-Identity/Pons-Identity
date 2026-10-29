import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the SPA runs on Vite and the Express IdP runs on https://localhost:3443.
// Browser navigations to /admin/* are SPA routes; file downloads under /admin are proxied.
const idp = { target: 'https://localhost:3443', secure: false };

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': idp,
      '/saml': idp,
      '/logout': idp,
      '/admin': {
        ...idp,
        bypass: (req) => (req.method === 'GET' && req.headers.accept?.includes('text/html') ? req.url : null),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
});
