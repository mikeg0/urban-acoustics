# 07 - Frontend Minimal Real-Data Migration

## Goal

Update the existing Vite/React dashboard to display real Phase 1 device data while preserving the current synthetic Riverton demo mode.

The frontend milestone is complete when a configured device ID shows live telemetry, event uploads, audio playback, and labels through `/api/v1/*`.

## Scope

- Add real API client methods.
- Add device ID configuration.
- Keep current synthetic dashboard available.
- Add event list, playback, and label controls.
- Update websocket client to consume real backend live messages.
- Avoid a broad redesign in Phase 1.

## Deliverables

- Updated `frontend/src/api.ts`
- Updated `frontend/src/App.tsx`
- Updated `frontend/src/live.tsx`
- New `frontend/src/events/EventsList.tsx`
- New `frontend/src/events/EventPlayer.tsx`
- New `frontend/src/events/LabelPicker.tsx`
- Type additions in `frontend/src/types.ts`
- Env variables:
  - `VITE_DEVICE_ID`
  - `VITE_DEMO_MODE`, if useful client-side

## API Client Changes

Add functions for:

- Fetch device metadata.
- Fetch telemetry for a time window.
- Fetch recent events.
- Fetch event playback URL.
- Submit an event label.
- Open live websocket for real telemetry updates.

Keep existing functions for:

- `/api/year`
- `/api/day/{key}`
- `/ws/live` demo mode

## UI Behavior

Real mode:

- Top bar shows actual device name/ID and location metadata.
- Current dB reads from recent telemetry or websocket.
- Event panel lists uploaded clips.
- Audio player uses signed playback URL.
- Label picker posts selected taxonomy label.

Demo mode:

- Existing Riverton synthetic dashboard continues to work.
- Existing spectrogram and drill-down views are not broken.

## Dependencies

- Task 03 backend API.
- Task 04 ingest worker for live data.
- Task 05 simulator for repeatable test data.

## Acceptance Criteria

- `npm run build` passes.
- Demo dashboard still loads.
- Real device mode loads with `VITE_DEVICE_ID`.
- Recent telemetry appears from `/api/v1`.
- Websocket updates change the live display.
- Uploaded events appear in the event list.
- Event playback URL can be loaded in an `<audio>` element.
- Label submission persists and updates UI state.

## Risks

- The existing UI assumes a full synthetic year bundle. Do not force real telemetry into that shape unless needed.
- Start with a minimal real-data panel or mode; deeper historical visualizations can evolve after ingestion is stable.
