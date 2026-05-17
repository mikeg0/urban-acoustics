import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API host: when running under docker compose the backend resolves as
// `backend:8000`; locally it's `localhost:8000`. Vite proxies both /api and /ws.
const API_HOST = process.env.VITE_API_HOST ?? 'http://localhost:8000';
const WS_HOST = process.env.VITE_WS_HOST ?? 'ws://localhost:8000';

export default defineConfig({
  plugins: [react()],
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
