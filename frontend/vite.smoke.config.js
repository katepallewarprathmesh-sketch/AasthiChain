// Build config for the render smoke test (see smoke/smoke-render.jsx).
// Bundles the smoke entry for Node so every route can be rendered server-side
// in CI, catching render-time crashes that `vite build` cannot see.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    ssr: 'smoke/smoke-render.jsx',
    outDir: 'node_modules/.smoke',
    emptyOutDir: true,
    minify: false
  }
})
