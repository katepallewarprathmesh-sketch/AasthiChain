import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Stamp the build into the bundle so a tab can tell whether the code it is
// running is the code the server is serving. Vercel exposes the commit as an
// env var; locally we ask git.
function buildStamp() {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT
  if (fromEnv) return String(fromEnv).slice(0, 12)
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim().slice(0, 12) } catch { return 'dev' }
}

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp()) },
  plugins: [react()],
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Keep the first-load bundle small: React/router ship in one long-lived
        // vendor chunk, auth and heavy one-off libs load only when used.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('@clerk')) return 'clerk'
          if (id.includes('qrcode-generator')) return 'qrcode'
          if (id.includes('react-router')) return 'router'
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('scheduler')) return 'react'
          return 'vendor'
        }
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    cors: true,
    hmr: { clientPort: 443 },
    // Allow preview host for Arena
    allowedHosts: true,
    headers: {
      'X-Frame-Options': 'ALLOWALL'
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      }
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    cors: true
  }
})
