import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* variables from the repository-root .env so there is one env file to manage.
  envDir: path.resolve(here, '../..'),
  resolve: {
    alias: { '@': path.resolve(here, 'src') },
  },
  server: {
    // Staff/employee app on 5173; patient website (VITE_APP_SURFACE=patient) on 5174.
    port: process.env.VITE_APP_SURFACE === 'patient' ? 5174 : 5173,
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
});
