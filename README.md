# Urban Acoustics

A public-facing city noise dashboard for the (fictional) city of **Riverton**. It streams live traffic noise from a sensor and lets residents drill through a year of historical readings:

> Year → Month → Day → Hour → 60-minute spectrogram (with 5-minute WAV playback)

The historical view surfaces threshold breaches, anomalies, peak hours, a 7-day forecast, and probable noise sources. The live view shows today's minute-resolution stream with explicit handling for streaming gaps.

## Stack

| Layer    | Tech                                                |
| -------- | --------------------------------------------------- |
| Frontend | Vite 6 · React 18 · TypeScript                      |
| Backend  | FastAPI · Uvicorn (Python 3.12)                     |
| Live     | WebSocket — snapshot + per-minute tick              |
| Storage  | Flat JSON — one file per day, plus aggregates       |
| Dev loop | Docker Compose — uvicorn `--reload` + Vite HMR      |

## Quick start

Requires Docker (with Compose v2) and ports `5173` + `8000` free.

```sh
docker compose up
```

Then open **http://localhost:5173**.

The first run seeds 365 day files under `backend/data/` (≈10 s) and installs npm + pip dependencies inside the images.

## Project layout

```
.
├── backend/
│   ├── app/
│   │   ├── main.py        # FastAPI app + routes
│   │   ├── data.py        # PRNG, year generator, disk loaders
│   │   ├── seed.py        # writes data/days/*.json + aggregates
│   │   └── live.py        # WebSocket handler + simulated stream
│   ├── data/              # generated; one JSON per day + aggregates
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx        # top-level layout, drill flows, routing
│   │   ├── live.tsx       # live page (WebSocket-backed)
│   │   ├── drills.tsx     # Year/Month/Day/Hour views + heatmap
│   │   ├── panels.tsx     # anomalies feed, forecast, peak hours, …
│   │   ├── wavplayer.tsx  # WebAudio synthesis + transport
│   │   ├── spectrogram.tsx
│   │   ├── settings.tsx   # gear-icon dialog (palette/threshold/sensitivity)
│   │   ├── atoms.tsx      # Card, Pill, Sparkline, Crumb, …
│   │   ├── api.ts         # fetch + WebSocket helpers
│   │   ├── tweaks.ts      # client-side settings store (localStorage)
│   │   ├── palettes.ts    # spectrogram color ramps
│   │   ├── utils.ts       # mulberry32, helpers
│   │   ├── types.ts       # shared types
│   │   ├── styles.css     # design tokens + base styles
│   │   └── main.tsx       # entry
│   ├── index.html
│   ├── vite.config.ts     # /api and /ws proxied to backend
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── docker-compose.yml
├── .legacy/                # original Claude Design HTML/JSX prototype
└── README.md
```

## API

### REST

| Endpoint                   | Returns |
| -------------------------- | ------- |
| `GET /api/health`          | `{ok, seeded}` |
| `GET /api/city`            | City metadata (name, sensor, position) |
| `GET /api/year`            | Bulk bundle: `{city, days[], months[], anomalies[], forecast[], peakHours[], sources[]}` — fetched once at app boot |
| `GET /api/day/{YYYY-MM-DD}`| Full hour-resolution detail for one day |

### WebSocket

`ws://<host>/ws/live` — binary upgrade, JSON frames.

On connect, the server pushes a **snapshot**:

```json
{ "type": "snapshot", "date": "2026-04-26", "now_min": 947,
  "minutes": [48.1, 47.6, …], "gaps": [{"start": 372, "end": 398, "reason": "Sensor restart"}],
  "tick_seconds": 4.0 }
```

Then a **tick** every `tick_seconds` (4 s in dev, 1 simulated minute):

```json
{ "type": "tick", "now_min": 948, "db": 72.3 }
```

Closing the socket from the client simulates "stream stopped" in the UI; reconnecting resumes from `now_min`.

## Hot reload

Both services reload on source changes — no need to restart containers.

- **Backend** — uvicorn watches `backend/app/`. Edit a `.py` and watch the container log:
  ```
  WatchFiles detected changes in 'app/main.py'. Reloading...
  ```
- **Frontend** — Vite HMR updates the running page instantly:
  ```
  [vite] (client) hmr update /src/styles.css
  ```

`backend/data/` and `frontend/node_modules/` are persisted via volumes so they survive container restarts.

## Data

The seed script generates 365 days of synthetic dB readings using a deterministic PRNG (mulberry32). Output:

```
backend/data/
├── days/
│   ├── 2025-01-01.json   # 24 hourly dB readings + day metadata
│   ├── …
│   └── 2025-12-31.json
├── city.json
├── months.json           # monthly aggregates
├── anomalies.json        # z-score outliers
├── forecast.json         # next 7 days, weekly seasonality
├── peak_hours.json       # mean dB by hour-of-day
└── sources.json          # probable noise sources breakdown
```

To regenerate from scratch:

```sh
rm -rf backend/data/days backend/data/*.json
docker compose restart backend
```

(The FastAPI startup hook re-runs `app.seed:main` whenever `data/months.json` is missing.)

The live stream is simulated independently in `backend/app/live.py` — the day's curve uses a diurnal model (morning rush, midday plateau, evening rush, nightlife) with two hard-coded gaps. Today's date comes from `date.today()` at process start.

## Settings

Click the gear in the top-right to open the settings dialog. Three tweaks are persisted to `localStorage`:

- **Spectrogram palette** — Heat / Ice / Mono / Neon
- **Breach threshold** — 65–100 dB (default 86)
- **Anomaly sensitivity** — z-score cutoff 1.5–4.0 (default 2.9)

Changes apply live across every spectrogram, ribbon, and feed.

## Local dev without Docker

If you'd rather run the services on the host:

```sh
# backend (Python 3.12)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --reload-dir app

# frontend (Node 22)
cd frontend
npm install
npm run dev
```

Vite still proxies `/api` and `/ws` to `localhost:8000`.

## Production build

The provided Compose setup runs the **dev** server (Vite). For production:

```sh
cd frontend && npm run build   # → frontend/dist/
```

Then serve `frontend/dist/` from any static host (nginx, Caddy, Cloudflare Pages, …) and point it at the FastAPI backend behind a reverse proxy. Don't ship the dev Dockerfile to production.

## Troubleshooting

**`Failed to Setup IP tables` on `docker compose up`**
The Docker daemon's bridge chain is missing — usually after a host firewall reset. Fix:

```sh
sudo systemctl restart docker
```

As a workaround without sudo, run each container with `--network=host`.

**`permission denied` connecting to `/var/run/docker.sock`**
Your shell predates your `docker` group membership. Either log out and back in, or prefix commands with `sg docker -c "..."`.

**Port 5173 or 8000 already in use**
Stop the conflicting process or change the host-side port in `docker-compose.yml`. Vite is `strictPort: true`, so it'll error out rather than auto-pick another port.

**Live page is blank / "stream stopped"**
The WebSocket needs the backend running. Check `docker compose logs backend` for `Application startup complete.` and verify `curl http://localhost:8000/api/health` returns `{"ok":true,…}`.

## Origin

Bootstrapped from a [Claude Design](https://claude.ai/design) HTML/JSX prototype, then migrated to this Vite + FastAPI + Docker setup. The original prototype is preserved in [`.legacy/`](.legacy/) for reference.


