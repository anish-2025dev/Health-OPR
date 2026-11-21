import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const surface =
    process.env.VITE_APP_SURFACE ||
    (mode === 'mgt'
      ? 'mgt'
      : mode === 'ops'
        ? 'ops'
        : mode === 'patient'
          ? 'patient'
          : mode === 'platform'
            ? 'platform'
            : 'staff');
  process.env.VITE_APP_SURFACE = surface;

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_APP_SURFACE': JSON.stringify(surface),
    },
    // Read VITE_* variables from the repository-root .env so there is one env file to manage.
    envDir: path.resolve(here, '../..'),
    resolve: {
      alias: { '@': path.resolve(here, 'src') },
    },
    server: {
      // Port allocation by surface:
      // mgt: 5173, ops: 5175, patient: 5174, platform: 5176
      port:
        surface === 'patient'
          ? 5174
          : surface === 'ops'
            ? 5175
            : surface === 'platform'
              ? 5176
              : 5173,
      host: true,
      strictPort: true,
      // Same-origin API in development (mirrors the Render /api rewrite), so auth cookies are first-party.
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET ?? 'http://localhost:4000',
          changeOrigin: false,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.js'],
      css: false,
    },
  };
});
