import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// API host: when running under docker compose the backend resolves as
// `backend:8000`; locally it's `localhost:8000`. Vite proxies both /api and /ws.
const API_HOST = process.env.VITE_API_HOST ?? 'http://localhost:8000';
const WS_HOST = process.env.VITE_WS_HOST ?? 'ws://localhost:8000';

// Self-contained static demo pages live at public/<slug>/index.html. Vite's
// public/ middleware doesn't serve directory indexes, so requests for /<slug>
// or /<slug>/ would otherwise fall through to the SPA index.html. This
// middleware serves the static page directly for those URLs.
const STATIC_DEMO_SLUGS = ['enforcement-demo', 'enforcement-map'];
function staticDemoMiddleware() {
  return {
    name: 'serve-static-demos',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = (req.url || '').split('?')[0];
        for (const slug of STATIC_DEMO_SLUGS) {
          if (url === `/${slug}` || url === `/${slug}/`) {
            const file = path.resolve(__dirname, `public/${slug}/index.html`);
            try {
              const html = fs.readFileSync(file, 'utf8');
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              res.end(html);
              return;
            } catch (e) {
              // fall through to default handling
            }
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), staticDemoMiddleware()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['urban-acoustics.dev.conexed.com'],
    // Polling needed when the source is on a bind-mounted Docker volume on
    // macOS/Windows hosts. Harmless on Linux.
    watch: { usePolling: true, interval: 250 },
    proxy: {
      // ws: true so the live-telemetry WebSocket under
      // /api/v1/devices/{id}/live upgrades through Vite to FastAPI.
      '/api': { target: API_HOST, changeOrigin: true, ws: true },
      '/ws': { target: WS_HOST, ws: true, changeOrigin: true },
    },
  },
});
