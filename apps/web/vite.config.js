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
    port: 5173,
    host: true,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});
