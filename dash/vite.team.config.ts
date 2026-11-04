import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// The team viewer is a second entry (team.html). The team server serves
// dist/team-dash/index.html, so rename the emitted page.
function renameEntry(): Plugin {
  return {
    name: 'team-entry-index',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const page = bundle['team.html']
      if (page) {
        delete bundle['team.html']
        page.fileName = 'index.html'
        bundle['index.html'] = page
      }
    },
  }
}

const TEAM_SERVER = process.env.CODEBURN_TEAM_SERVER ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwindcss(), renameEntry()],
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: '../dist/team-dash',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./team.html', import.meta.url)) },
  },
  server: {
    port: 5174,
    open: '/team.html',
    // Run `codeburn team serve` (default 8787) and `npm run dev:team`.
    // The server rejects requests whose Origin differs from Host, and the
    // proxy rewrites Host to the target, so present the target's origin too.
    proxy: {
      '/api': {
        target: TEAM_SERVER,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin')) req.setHeader('origin', TEAM_SERVER)
          })
        },
      },
    },
  },
})
