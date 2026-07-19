# Plan: Expose urban-acoustics noise data to sleep-atlas via an API-key REST endpoint

> **Status:** fact-checked against the repo (2026-07-18) and corrected. Changes from the
> original draft are called out in **[CORRECTION]** / **[VERIFIED]** notes. The three
> substantive corrections are: (1) the adapter `base_url` — the host-cron topology + a
> self-signed `*.dev.conexed.com` cert make *both* the internal Docker name and the public
> https URL unusable, so the adapter reuses the **existing** `urban-acoustics-api.openclaw`
> Traefik route over plain HTTP (verified working); (2) the shared query helper goes in a new
> `app/queries.py`, **not** `app/data.py` (that module is the synthetic demo generator with no
> DB access); (3) `NoiseCurvePoint` uses plain `float`, matching the existing `TelemetryPoint`.

## Context

sleep-atlas (an Eight Sleep dashboard) already has all the scaffolding to overlay *measured*
ambient noise on each night's sleep timeline and compute noise↔sleep correlations, but today
it only renders **seeded mock dB**. urban-acoustics is a real city noise-monitoring platform
whose `telemetry_1m` continuous aggregate holds exactly the per-minute dB curve sleep-atlas
wants. The two projects share the `dev_conexed_com_default` Traefik network and a common
motivation (documenting downtown noise disturbing sleep as evidence for the quiet
initiative), but **no code connects them**.

This plan adds a purpose-built, machine-to-machine REST endpoint in urban-acoustics —
authenticated by an API key + secret — that returns a device's dB curve for a time window,
and a matching consumer adapter in sleep-atlas. Outcome: a real urban-acoustics sensor
becomes a selectable "microphone" in sleep-atlas, its LAeq curve overlaying the night
timeline and feeding the wakes/deep%/SQS correlations, with zero changes to sleep-atlas's
existing sync/display pipeline.

### Locked design decisions (from user)
- **Auth:** DB-backed `api_clients` table (bcrypt-hashed secrets; supports rotation/revocation) — not a static env pair.
- **Payload:** per-minute curve only (`points[]`); sleep-atlas derives mean/peak/loud-minutes client-side as it already does.
- **Timestamps:** ISO-8601 UTC strings emitted directly by the endpoint, so the sleep-atlas adapter does **zero** timestamp conversion.

### Deployment facts that drive the wiring (confirmed with user)
- **`sync.py` runs on the *host* via cron**, not in a container (`sleep-atlas/README.md:65-69`;
  cron example `/opt/sleep-atlas/sync.py --days 7`; the sleep-atlas container even mounts its
  data dir `:ro`). So the adapter's HTTP call originates on the host.
- **`*.dev.conexed.com` uses a self-signed / dev TLS cert**, which `urllib` rejects by default.
- **The urban-acoustics backend publishes no host port** — only mosquitto (`8883`) and MinIO
  (`9000`) do (`docker-compose.yml`). It listens on `:8000` *inside* the container and is
  reached only via Traefik or the Docker network.

Consequences: from the host, `http://urban-acoustics-backend:8000` (Docker-internal DNS)
does **not** resolve, and `https://…dev.conexed.com` fails urllib cert verification. The
original draft's `base_url` recommendation is broken in both directions.

**The fix already exists on this host** (verified 2026-07-18): there is a live Traefik route
`devlab/traefik/dynamic/urban-acoustics-api.yml` that routes `urban-acoustics-api.openclaw`
straight to the backend container (`http://urban-acoustics-backend:8000`), and its **http
router has no https-redirect middleware** (unlike the `.dev.conexed.com` routers) — by design,
"so devices without the mkcert CA still work." Facts confirmed live from openclaw:
- `urban-acoustics-api.openclaw` resolves to openclaw's own Tailscale IP `100.106.167.85`
  (via `~/dev/openclaw-dnsmasq`).
- `curl http://urban-acoustics-api.openclaw/api/v1/health` → `200 {"ok":true,"seeded":true}`,
  no redirect. **Plain HTTP works, no cert involved.**
- `https://urban-acoustics-api.openclaw/…` *also* succeeds from stdlib `urllib` here, because
  mkcert's CA is installed in openclaw's system trust store. So on-box, either scheme works;
  plain http is chosen to remove the cert dependency entirely.

So `sync.py` (running on openclaw) uses `base_url = http://urban-acoustics-api.openclaw/api/v1/partner`
with **no urban-acoustics compose change and no published port**. Use `urban-acoustics-api.openclaw`
(the dedicated API host that hits the backend directly), **not** `urban-acoustics.openclaw`
(that's the frontend/Vite host — it would only reach the API through the SPA dev-server proxy).

---

## The JSON contract (the interface both sides build to)

**Request** — `GET /api/v1/partner/devices/{device_id}/noise`
- Headers: `X-API-Key: <key>`, `X-API-Secret: <secret>`
- Query params:
  - `from` — ISO-8601, inclusive (FastAPI parses a `datetime` param directly)
  - `to` — ISO-8601, exclusive (`to` must be > `from`)
  - `res` — `raw` | `1m` | `1h`, default `1m` (a night is ~8–10 h → `1m` gives ~480–600 points)
- Window caps reused from telemetry: `raw ≤ 24 h`, `1m ≤ 30 d`, `1h ≤ 1 y`.
- **[CORRECTION] tz-awareness:** require both `from` and `to` to be timezone-aware. Reject
  naive datetimes with `400` (or coerce to UTC explicitly). Rationale: a naive value breaks
  the `to − from` cap subtraction against an aware value *and* asyncpg's `TIMESTAMPTZ`
  binding. sleep-atlas sends bedtime with a real offset (e.g. `…-06:00` Mountain), which is
  fine — it's an unambiguous instant; Postgres compares it correctly against the
  `TIMESTAMPTZ` columns.

**Response** — `200 application/json`
```json
{
  "device_id": "5f3b…-uuid",
  "resolution": "1m",
  "unit": "dB_SPL",
  "from_ts": "2025-12-03T02:45:00+00:00",
  "to_ts":   "2025-12-03T11:15:00+00:00",
  "points": [
    { "ts": "2025-12-03T02:45:00+00:00", "laeq": 41.2, "lafmax": 47.8, "lcpeak": 60.3 },
    { "ts": "2025-12-03T02:46:00+00:00", "laeq": 39.9, "lafmax": 45.1, "lcpeak": 58.0 }
  ]
}
```
- `laeq` (A-weighted equivalent) is the curve sleep-atlas overlays; `lafmax` (A-weighted Fast
  max) and `lcpeak` (C-weighted peak) are included for envelope/future use at ~zero cost.
  **[VERIFIED]** all three live in the `telemetry_1m` aggregate as `AVG(laeq)`, `MAX(lafmax)`,
  `MAX(lcpeak)` (`app/migrations/versions/0003_telemetry_continuous_aggregates.py:81-83`).
- `ts`/`from_ts`/`to_ts` are ISO-8601 (Pydantic serializes `datetime` → `…+00:00`). **[VERIFIED]**
  sleep-atlas's `iso_parse` (`sync.py:45-47`) handles the `+00:00` form via `fromisoformat`.

**Auth failures:** `401` on missing/invalid key or secret. Companion discovery endpoint
`GET /api/v1/partner/devices` (same auth) returns the existing device list so sleep-atlas can
resolve/label a `device_id`.

---

## urban-acoustics changes (expose side) — `urban-acoustics/backend/`

1. **`api_clients` table + model.**
   - Migration `app/migrations/versions/0010_api_clients.py`, `down_revision = "0009"`,
     mirroring `0008_users.py`. Columns: `api_key TEXT PRIMARY KEY`, `secret_hash TEXT NOT
     NULL`, `label TEXT NOT NULL`, `is_active BOOLEAN NOT NULL DEFAULT true`, `created_at
     TIMESTAMPTZ NOT NULL`, `last_used_at TIMESTAMPTZ NULL`.
     **[VERIFIED]** latest migration is `0009_spectrogram_retention.py` (`revision = "0009"`),
     so `down_revision = "0009"` is correct.
   - ORM model `ApiClient` in `app/models.py`, mirroring `User` (`models.py:191-201`), so
     `Base.metadata` stays in sync.

2. **API-key auth dependency** — new `app/auth/api_key.py`.
   - `require_api_key`: read `X-API-Key`/`X-API-Secret` via `Header(...)` (shape from
     `app/auth/device.py:33-57`), look up the active `api_clients` row, verify the secret with
     `verify_password` (`app/auth/password.py:24`). Structure follows `require_permission`
     (`app/auth/user.py:74-87`). Return a `ResolvedApiClient` dataclass.
   - Hardening: when no row matches, still run one `verify_password` against a dummy bcrypt
     hash to equalize timing (avoid key enumeration). Optionally stamp `last_used_at`.

3. **Response models** — in `app/contracts.py`, styled on `TelemetryPoint`/
   `TelemetryReadResponse` (`contracts.py:257-269`):
   - `NoiseCurvePoint(BaseModel)`: `ts: datetime`, **[CORRECTION] `laeq/lafmax/lcpeak: float`**
     — match the existing `TelemetryPoint`, which uses plain `float` (`contracts.py:259-261`),
     **not** `DbLevel`. `DbLevel` (`contracts.py:30`) is a bounded `Annotated[float, ge=-20,
     le=200]`; using it on an *outbound* model means a stray out-of-range aggregate value
     raises a `ValidationError` at serialization time instead of passing through. Plain
     `float` is the safer, consistent choice for a read endpoint.
   - `NoiseCurveResponse(BaseModel)`: `device_id: UUID`, `resolution: TelemetryResolution`
     (reuse enum, `contracts.py:251`), `unit: str = "dB_SPL"`, `from_ts: datetime`,
     `to_ts: datetime`, `points: list[NoiseCurvePoint]`.

4. **[CORRECTION] Shared query helper — new `app/queries.py`, NOT `app/data.py`.**
   The original draft put `fetch_telemetry_points` in `app/data.py`, but that module is the
   **synthetic demo-data generator** (mulberry32 PRNG + on-disk JSON loader) with no
   SQLAlchemy/DB session imports (`app/data.py:1-281`) — a live Timescale query does not
   belong there. Instead:
   - Add `app/queries.py` with `async def fetch_telemetry_points(session, device_id, from_dt,
     to_dt, res) -> list[Row]`. Move the `_RESOLUTIONS` mapping, the window-cap check, the
     device-existence 404, and the raw-vs-CA SQL (`telemetry.py:29-89`) into it. Return rows
     that carry a `datetime` `ts` (do **not** call `.timestamp()` inside the helper).
   - `telemetry.py` calls the helper, then builds `TelemetryPoint(ts=row.ts.timestamp(), …)`.
   - `partner.py` calls the same helper, then builds `NoiseCurvePoint(ts=row.ts, …)` (datetime
     → ISO). This keeps `res`/window-cap semantics from drifting between the two endpoints
     (the draft's own "query duplication" risk).
   - *Lower-churn alternative:* keep the helper as a module-level function in `telemetry.py`
     and import it into `partner.py`. Acceptable, but a dedicated `queries.py` reads cleaner.

5. **Partner router** — new `app/api/v1/partner.py`,
   `router = APIRouter(dependencies=[Depends(require_api_key)])` (router-wide gate exactly like
   `telemetry.py:24`).
   - `GET /partner/devices/{device_id}/noise` → `NoiseCurveResponse`, via
     `fetch_telemetry_points`.
   - `GET /partner/devices` → reuse the `DeviceResponse` list model behind `GET /devices`
     (`app/api/v1/devices.py:80-86`). **[VERIFIED]** that model/handler exists.

6. **Register the router** — `app/main.py`: add `from .api.v1 import partner as partner_router`
   (with the other v1 imports, `main.py:28-39`) and
   `app.include_router(partner_router.router, prefix=V1, tags=["partner"])` (with the other
   `include_router` calls, ending `main.py:213`). **[VERIFIED]** `V1 == "/api/v1"`, so the full
   path is `/api/v1/partner/devices/{device_id}/noise`.

7. **[CORRECTION] No backend infra change — reuse the existing `urban-acoustics-api.openclaw`
   Traefik route.** The partner endpoints ride on the API host that already routes to the
   backend; the adapter's `base_url` is `http://urban-acoustics-api.openclaw/api/v1/partner`
   (plain HTTP, no redirect, no cert). Nothing to add to `docker-compose.yml`. New partner
   routes under `/api/v1/*` are automatically reachable because the Traefik service forwards
   the whole path to `urban-acoustics-backend:8000`.
   - **Operational caveat (fragility):** this dynamic route file is untracked and load-bearing
     — the memory note `arch_pi_api_traefik_route.md` warns that if it disappears, the device
     audio-upload flow silently breaks (events stuck at `announced`, playback 409s). It was
     also rotated *today* (there's a `retired/urban-acoustics-api.yml.retired-2026-07-18`
     copy). The sleep-atlas integration would inherit this same dependency: if the route file
     is lost, both the Pi API and the noise feed break together. Acceptable (the API host is
     already load-bearing for real devices), but note it.
   - *Fallback if you want the integration decoupled from Traefik:* publish a loopback port on
     the backend — add `ports: ["127.0.0.1:8001:8000"]` to the `backend` service and set
     `base_url = http://127.0.0.1:8001/api/v1/partner`. Self-contained (no Traefik/route
     dependency); port publishing is known-good on this host (mosquitto `8883`, MinIO `9000`
     already publish). Only needed if the shared-route fragility above is unacceptable.

8. **Credential creation script** — new `scripts/create_api_client.py`, mirroring
   `scripts/register_device.py` (`sys.path` shim + `app.*` imports + `main()` at `:74-86`, run
   as `python -m scripts.create_api_client`). `--label` arg; generate
   `api_key = "ak_" + secrets.token_urlsafe(12)` and `secret = secrets.token_urlsafe(32)`;
   store `hash_password(secret)`; insert the row; **print the key + plaintext secret once**
   (unrecoverable afterward). Run: `docker compose exec backend python -m scripts.create_api_client --label sleep-atlas`.
   **[VERIFIED]** `token_urlsafe(32)` ≈ 43 chars, under `hash_password`'s 72-byte bcrypt cap
   (`password.py:17-21`) — do not raise the token size past ~53 bytes or hashing will throw.

9. **No new env vars / no settings.py change** — credentials live in the DB. No
   `ENV_VARS`/`Settings` edits.

10. **No CORS change** — sleep-atlas calls server-to-server from `sync.py` (no `Origin`
    header), so `ALLOWED_ORIGINS` (browser-only) is irrelevant.

11. **Tests** — `backend/tests/`, patterned on `test_auth_jwt.py`/`test_permissions.py`
    **[VERIFIED]** both exist:
    - `test_api_key_auth.py`: valid → 200; missing headers → 401; wrong secret → 401;
      `is_active=false` → 401.
    - `test_partner_noise.py`: seed telemetry for a device, assert `points` shape, ISO `ts`,
      window filtering, `to <= from` → 400, and a naive-datetime `from` → 400.

---

## sleep-atlas changes (consume side) — `sleep-atlas/`

1. **New adapter** — `mic_adapters/urban_acoustics.py`. **[CORRECTION]** it is *modeled on* but
   not a drop-in copy of `generic_http.py`: that adapter expects a **top-level JSON list** and
   an `Authorization` header, whereas the partner endpoint returns `{"points":[…]}` with
   `X-API-Key`/`X-API-Secret`. Write a small custom `fetch(config, start_dt, end_dt)` (stdlib
   `urllib`, `timeout=15`, raise on bad shape — `urlopen` already raises `HTTPError` on non-2xx):
   - Read `base_url`, `device_id`, `api_key`, `api_secret`, optional `field` (default `"laeq"`),
     optional `res` (default `"1m"`).
   - GET `{base_url}/devices/{device_id}/noise?from={start_dt.isoformat()}&to={end_dt.isoformat()}&res={res}`
     with `X-API-Key`/`X-API-Secret` headers.
   - Return `[[p["ts"], p[field]] for p in data["points"] if p.get("ts") and p.get(field) is not None]`.
   - **[VERIFIED]** the endpoint emits ISO-8601 `ts`, so this drops straight into
     `resample_timeseries` (`sync.py:70`) — matching the `list[[iso, db], …]` contract
     (`mic_adapters/__init__.py:4`). `iso_parse` handles the offset.

2. **Runtime catalog entry** (not committed — `microphones.json` lives in the gitignored data
   dir, default `~/.eightctl/data/`, **[VERIFIED]** `app.py:12`). Provide this to drop in:
   ```json
   {
     "mics": [
       {
         "id": "urban-state-st",
         "label": "State St @ 400 S",
         "color": "#ff7a5c",
         "enabled": true,
         "adapter": "urban_acoustics",
         "config": {
           "base_url": "http://urban-acoustics-api.openclaw/api/v1/partner",
           "device_id": "5f3b…-uuid",
           "api_key": "ak_…",
           "api_secret": "…",
           "field": "laeq",
           "res": "1m"
         }
       }
     ]
   }
   ```
   - **[CORRECTION] `base_url` = `http://urban-acoustics-api.openclaw/api/v1/partner`** — the
     existing API-host Traefik route (expose-side step 7), verified reachable over plain HTTP
     from openclaw. Do **not** use `http://urban-acoustics-backend:8000` (the original draft's
     value): that Docker-internal name is unresolvable from the host where `sync.py` runs. Do
     not use `https://…dev.conexed.com` (self-signed cert → urllib rejects it off-box), and do
     not use `urban-acoustics.openclaw` (frontend host — reaches the API only via the SPA proxy).
   - Credentials are auto-redacted: `/api/microphones` (**[VERIFIED]** `app.py:107-117`) copies
     only `id/label/color/enabled` — the whole `config` never reaches the browser, so
     `api_key`/`api_secret` are safe.

3. **No other sleep-atlas code changes.** `load_microphones`, `fetch_external_noise`,
   `resample_timeseries`, `_refresh_external_noise` (`sync.py`), the `/api/microphones`
   redaction (`app.py`), and the frontend overlay + correlations are already source-agnostic.
   **[VERIFIED]** the frontend consumes `externalNoise` at `timeline.jsx:52`, `data.jsx:125`,
   `app.jsx:610`, and computes `r_wakes`/`r_deep`/`r_sqs` + a `missing` count via
   `buildCorrelationFromMic` (`app.jsx:591-621`, `data.jsx:123`). The per-slot array length is
   guaranteed by `resample_timeseries(total_slots=len(night["stages"]))`
   (`sync.py:192-208`), and out-of-`(20,120)`-dB samples are dropped (`sync.py:30,80-81`).

---

## Verification (end-to-end)

**urban-acoustics (expose):**
1. Restart the backend so the migration applies — the compose backend `command` runs
   `alembic upgrade head` before uvicorn (**[VERIFIED]** `docker-compose.yml`). Confirm the
   `api_clients` table exists and the API host answers from the host:
   `curl http://urban-acoustics-api.openclaw/api/v1/health` → `200`
   (**[VERIFIED]** already returns `{"ok":true,"seeded":true}` today).
2. `docker compose exec backend python -m scripts.create_api_client --label sleep-atlas` →
   capture the printed key + secret.
3. With `DEMO_MODE=1` seeding telemetry, pick a `device_id` from `GET /api/v1/partner/devices`
   (with the headers), then from the host:
   ```sh
   curl -H "X-API-Key: ak_…" -H "X-API-Secret: …" \
     "http://urban-acoustics-api.openclaw/api/v1/partner/devices/<device_id>/noise?from=2025-12-03T02:45:00Z&to=2025-12-03T11:15:00Z&res=1m"
   ```
   Assert: 200, `points[].ts` are ISO-8601, values in a sane dB range. Repeat with no/invalid
   headers → **401**; `to <= from` → **400**; a naive `from` (no offset) → **400**.
4. `docker compose exec backend pytest tests/test_api_key_auth.py tests/test_partner_noise.py`.

**sleep-atlas (consume):**
5. Drop the `microphones.json` above into `~/.eightctl/data/` with the real `device_id` +
   credentials. Confirm `python sync.py --mics-only --days 7` logs
   `microphones: 1 configured, 1 enabled`.
6. `python sync.py --mics-only --days 7` (on the host) → verify targeted night JSON files gain
   `externalNoise["urban-state-st"]` arrays whose length equals that night's `stages` length,
   populated with real dB (not all-zero — all-zero means timestamps/units were dropped upstream).
7. Load the dashboard, open a night with the noise overlay on: the mic's curve renders on the
   timeline, the mic is selectable in the Noise view, and the wakes↔noise / deep%↔noise /
   SQS↔noise correlations populate (not `missing`).

## Risks / watch-items
- **Reachability** was the biggest gap in the original draft (resolved by reusing the existing
  `urban-acoustics-api.openclaw` route over plain HTTP). Do not fall back to
  `https://…dev.conexed.com` from a host *other* than openclaw — the mkcert CA isn't trusted
  off-box, so urllib will reject it. The `.openclaw` route depends on `~/dev/openclaw-dnsmasq`
  resolving the name and on the (untracked, load-bearing) Traefik route file surviving.
- **All-zero `externalNoise`** after step 6 ⇒ samples dropped in `resample_timeseries` — a
  non-ISO/naive timestamp or out-of-`(20,120)`-dB value. The ISO decision removes the timestamp
  risk; confirm dB values land in range.
- **Query duplication**: keep the telemetry point-fetch DRY via `app/queries.py` so `res`/
  window-cap semantics can't drift between the two endpoints.
- **tz-aware inputs**: enforce timezone-aware `from`/`to`; a naive value breaks the cap check
  and asyncpg's `TIMESTAMPTZ` binding.

## Out of scope / unaffected
- The current branch's working-tree changes (`frontend/src/spectrogram.tsx` and Pi firmware
  `raspberry-pi-zero-2w/urban_acoustics/{dsp,telemetry}.py` + firmware tests) do not touch the
  backend API, contracts, migrations, or sleep-atlas — this plan is independent of them.
