/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { hugeiconsDeepImports } from './hugeiconsDeepImports'
import { reactCompilerBabel } from './reactCompiler'

const serverOrigin = (process.env.VITE_MANOR_WS ?? 'ws://localhost:8787/ws')
  .replace(/^ws/, 'http')
  .replace(/\/ws$/, '')

// MANOR_WEB_PROFILE=1 builds for render measurement: React's profiling renderer
// (Profiler timings, fiber durations) and unminified component names.
const profile = process.env.MANOR_WEB_PROFILE === '1'

export default defineConfig({
  // Relative assets let the same build load from Electron's file URL and from the
  // Node static server. Manor has no client-side route whose trailing slash can
  // change that resolution.
  base: './',
  plugins: [hugeiconsDeepImports(import.meta.dirname), react({ babel: reactCompilerBabel(import.meta.dirname) }), tailwindcss()],
  ...(profile ? {
    resolve: { alias: [{ find: /^react-dom$/, replacement: 'react-dom/profiling' }] },
    build: { minify: false },
  } : {}),
  server: {
    port: 5173,
    // Artifact thumbnails and note pictures stay same-origin in production. Mirror those
    // paths in Vite so development needs no wider CSP and no credentials in the renderer.
    proxy: {
      '/internal/mymind-thumbnail': { target: serverOrigin },
      '/media/vault/': { target: serverOrigin },
      '/media/project-icon/': { target: serverOrigin },
      '/simulator/': { target: serverOrigin, ws: true },
    },
  },
  // Review probes run only through vitest.review.config.ts.
  test: { exclude: [...configDefaults.exclude, '**/.review/**'] },
})
