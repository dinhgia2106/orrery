/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the app under /orrery/ (so does `vite preview`); `vite dev` serves it at /.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/orrery/' : '/',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 900 },
  test: { environment: 'node' },
}));
