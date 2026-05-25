import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteAnnotation,
  deleteEvent,
  fetchEventIndex,
  fetchEventsInRange,
  listAnnotations,
} from './api';
import { EventsList } from './events/EventsList';
import { EventPlayer } from './events/EventPlayer';
import { HourPlaybackViewer } from './events/HourPlayback';
import { LabelPicker } from './events/LabelPicker';
import { BigLiveStat } from './live';
import { HistoryRibbon24h, dayHourToEpoch } from './spectrogram';
import { useTweaks } from './tweaks';
import { formatClock, formatHour, formatHourTick } from './utils';
import type {
  Day,
  DeviceEvent,
  EventIndexEntry,
  RecentEntry,
  SpectrogramAnnotation,
} from './types';
import type { PaletteKey } from './palettes';

const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;

interface RealDayViewProps {
  day: Day;
  deviceId: string;
  threshold: number;
  palette: PaletteKey;
}

/**
 * Day-scoped equivalent of RealLiveView's main panel: banner + day stats +
 * a clickable 24-hour ribbon with event/annotation overlays, plus the
 * inline HourPlaybackViewer + events list + EventPlayer + LabelPicker
 * widgets shared with the live view. Lets the user replay and label any
 * clip captured during the selected day without leaving the dashboard.
 */
export function RealDayView({ day, deviceId, threshold, palette }: RealDayViewProps) {
  const { timeFormat } = useTweaks();

  // The day's UTC window. matches dayHourToEpoch's anchoring so the events
  // we fetch line up with the 24 tile URLs in the ribbon below.
  const dayStartTs = useMemo(() => dayHourToEpoch(day.key, 0), [day.key]);
  const dayEndTs = dayStartTs + DAY_S;

  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventIndex, setEventIndex] = useState<EventIndexEntry[]>([]);
  const [annotations, setAnnotations] = useState<SpectrogramAnnotation[]>([]);

  const [selectedHourTs, setSelectedHourTs] = useState<number | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null);
  const [bandEventId, setBandEventId] = useState<string | null>(null);

  const [hourEvents, setHourEvents] = useState<DeviceEvent[] | null>(null);
  const [hourEventsLoading, setHourEventsLoading] = useState(false);
  const [hourEventsError, setHourEventsError] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [deletingUnlabeled, setDeletingUnlabeled] = useState(false);

  // Pull the full day's events for the merged Recent feed.
  const refreshEvents = useCallback(async () => {
    try {
      const r = await fetchEventsInRange(deviceId, dayStartTs, dayEndTs, 500);
      setEvents(r);
      setEventsError(null);
    } catch (e) {
      setEventsError((e as Error).message);
    }
  }, [deviceId, dayStartTs, dayEndTs]);

  const refreshEventIndex = useCallback(async () => {
    try {
      const r = await fetchEventIndex(deviceId, dayStartTs, dayEndTs);
      setEventIndex(r.events);
    } catch {
      // ignore — bands stay frozen
    }
  }, [deviceId, dayStartTs, dayEndTs]);

  const refreshAnnotations = useCallback(async () => {
    try {
      const r = await listAnnotations(deviceId, dayStartTs, dayEndTs);
      setAnnotations(r);
    } catch {
      // ignore
    }
  }, [deviceId, dayStartTs, dayEndTs]);

  useEffect(() => {
    // Reset selections when the day changes so we never show stale picks.
    setSelectedHourTs(null);
    setSelectedEventId(null);
    setSelectedAnnotationId(null);
    setBandEventId(null);
    setHourEvents(null);
    refreshEvents();
    refreshEventIndex();
    refreshAnnotations();
  }, [day.key, refreshEvents, refreshEventIndex, refreshAnnotations]);

  // Hour-scoped events: when the user picks a tile, swap the events list to
  // that hour's clips. Same fetch path as the live view so older clips
  // surface even if the day's 500-event cap pushed them off the Recent list.
  useEffect(() => {
    if (selectedHourTs == null) {
      setHourEvents(null);
      setHourEventsError(null);
      setHourEventsLoading(false);
      return;
    }
    let cancelled = false;
    setHourEventsLoading(true);
    setHourEventsError(null);
    setSelectedEventId(null);
    fetchEventsInRange(deviceId, selectedHourTs, selectedHourTs + HOUR_S)
      .then((rows) => {
        if (cancelled) return;
        setHourEvents(rows);
        const asc = [...rows].sort((a, b) => a.ts - b.ts);
        if (asc.length) setSelectedEventId(asc[0].event_id);
      })
      .catch((e: Error) => { if (!cancelled) setHourEventsError(e.message); })
      .finally(() => { if (!cancelled) setHourEventsLoading(false); });
    return () => { cancelled = true; };
  }, [deviceId, selectedHourTs]);

  const handleDeleteUnlabeled = useCallback(async () => {
    if (deletingUnlabeled) return;
    const targets = (hourEvents ?? []).filter((e) => e.label == null);
    if (targets.length === 0) return;
    const ok = window.confirm(
      `Delete ${targets.length} unlabeled clip${targets.length === 1 ? '' : 's'} ` +
      `(audio + record) from this hour? This cannot be undone.`,
    );
    if (!ok) return;
    setDeletingUnlabeled(true);
    const results = await Promise.allSettled(
      targets.map((e) => deleteEvent(e.event_id)),
    );
    const deletedIds = new Set(
      results
        .map((r, i) => (r.status === 'fulfilled' ? targets[i].event_id : null))
        .filter((id): id is string => id != null),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    setEvents((prev) => prev.filter((e) => !deletedIds.has(e.event_id)));
    setHourEvents((prev) => prev?.filter((e) => !deletedIds.has(e.event_id)) ?? null);
    setSelectedEventId((prev) => (prev != null && deletedIds.has(prev) ? null : prev));
    setDeletingUnlabeled(false);
    refreshEvents();
    refreshEventIndex();
    if (failed > 0) {
      window.alert(`Failed to delete ${failed} clip${failed === 1 ? '' : 's'}.`);
    }
  }, [deletingUnlabeled, hourEvents, refreshEvents, refreshEventIndex]);

  const handleSelectAnnotation = useCallback((id: number) => {
    setSelectedAnnotationId(id);
    setSelectedEventId(null);
    setBandEventId(null);
  }, []);

  const handleDeleteAnnotation = useCallback(async (id: number) => {
    try {
      await deleteAnnotation(id);
    } catch {
      refreshAnnotations();
      return;
    }
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedAnnotationId((prev) => (prev === id ? null : prev));
  }, [refreshAnnotations]);

  const bandEvent = useMemo(
    () => (bandEventId ? events.find((e) => e.event_id === bandEventId) ?? null : null),
    [bandEventId, events],
  );
  const activeEvents = bandEvent ? [bandEvent] : hourEvents ?? events;
  const selectedEvent = useMemo(
    () => activeEvents.find((e) => e.event_id === selectedEventId) ?? null,
    [activeEvents, selectedEventId],
  );

  const activeAnnotations = useMemo<SpectrogramAnnotation[]>(() => {
    if (bandEvent) return [];
    if (selectedHourTs != null) {
      const lo = selectedHourTs;
      const hi = selectedHourTs + HOUR_S;
      return annotations.filter((a) => a.ts_end > lo && a.ts_start < hi);
    }
    return annotations;
  }, [annotations, bandEvent, selectedHourTs]);

  const recentEntries = useMemo<RecentEntry[]>(() => {
    const eventEntries: RecentEntry[] = activeEvents.map((e) => ({ kind: 'event', event: e }));
    const annEntries: RecentEntry[] = activeAnnotations.map((a) => ({
      kind: 'annotation', annotation: a,
    }));
    const merged = [...eventEntries, ...annEntries];
    merged.sort((a, b) => {
      const ats = a.kind === 'event' ? a.event.ts : a.annotation.ts_start;
      const bts = b.kind === 'event' ? b.event.ts : b.annotation.ts_start;
      return sortDir === 'asc' ? ats - bts : bts - ats;
    });
    return merged;
  }, [activeEvents, activeAnnotations, sortDir]);

  const [prevEvent, nextEvent] = useMemo(() => {
    if (!selectedEventId) return [null, null] as const;
    const sortedEvents = recentEntries.flatMap((e) => (e.kind === 'event' ? [e.event] : []));
    const i = sortedEvents.findIndex((e) => e.event_id === selectedEventId);
    if (i < 0) return [null, null] as const;
    return [
      i > 0 ? sortedEvents[i - 1] : null,
      i + 1 < sortedEvents.length ? sortedEvents[i + 1] : null,
    ] as const;
  }, [recentEntries, selectedEventId]);

  const selectedAnnotation = useMemo(
    () => annotations.find((a) => a.id === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId],
  );

  const dayLabel = useMemo(() => {
    const d = new Date(day.date + 'T00:00:00');
    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  }, [day.date]);

  // Coverage = how many of the 24 hour buckets have a non-zero summary
  // reading. Empty hours (sensor offline) come back as 0 from the daily
  // summary endpoint.
  const coveredHours = day.hours.filter((db) => db > 0).length;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 14,
      minHeight: 0,
    }}>
      <DayBanner day={day} dayLabel={dayLabel} coveredHours={coveredHours} threshold={threshold} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <BigLiveStat
          label="Day peak"
          value={day.peak.toFixed(1)}
          unit={`dB · ${formatHour(day.peakHour, timeFormat)}`}
          tone={day.peak >= threshold ? 'hot' : 'default'}
        />
        <BigLiveStat
          label="Day avg"
          value={day.mean.toFixed(1)}
          unit="dB · LAeq"
        />
        <BigLiveStat
          label="Breach hours"
          value={String(day.breaches)}
          unit={`hrs ≥ ${threshold} dB`}
          tone={day.breaches > 0 ? 'warn' : 'default'}
        />
        <BigLiveStat
          label="Coverage"
          value={`${coveredHours}/24`}
          unit="hrs reported"
        />
      </div>

      <DaySpectrogramPanel
        deviceId={deviceId}
        day={day}
        palette={palette}
        threshold={threshold}
        ribbonEvents={eventIndex}
        annotations={annotations}
        selectedAnnotationId={selectedAnnotationId}
        onSelectAnnotation={handleSelectAnnotation}
        selectedHourTs={selectedHourTs}
        onHourClick={(h) => {
          setBandEventId(null);
          setSelectedHourTs((prev) => (prev === h ? null : h));
        }}
        hourEvents={hourEvents ?? []}
        hourEventsLoading={hourEventsLoading}
        hourEventsError={hourEventsError}
        selectedEventId={selectedEventId}
        onSelectEvent={(id) => {
          setSelectedEventId(id);
          setSelectedAnnotationId(null);
        }}
        onCloseHour={() => setSelectedHourTs(null)}
        onDeleteUnlabeled={handleDeleteUnlabeled}
        deletingUnlabeled={deletingUnlabeled}
      />

      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
        gap: 14, minHeight: 0,
      }}>
        <div style={{
          background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8,
          display: 'flex', flexDirection: 'column', minHeight: 320,
        }}>
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid var(--line)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div className="mono" style={{
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                color: 'var(--ink-2)',
              }}>
                {bandEvent ? 'Selected event'
                  : selectedHourTs != null ? 'Hour events'
                  : 'Day events'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-1)', marginTop: 2 }}>
                {(() => {
                  if (bandEvent) {
                    return `Pinned from ribbon · click ✕ to return to ${selectedHourTs != null ? 'hour' : 'day'} list`;
                  }
                  const eventCount = activeEvents.length;
                  const annCount = activeAnnotations.length;
                  const eventPart = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
                  const annPart = annCount > 0
                    ? ` + ${annCount} annotation${annCount === 1 ? '' : 's'}`
                    : '';
                  const scope = selectedHourTs != null
                    ? ` in ${formatClock(selectedHourTs, timeFormat)} → ${formatClock(selectedHourTs + HOUR_S, timeFormat)}`
                    : ` for ${dayLabel}`;
                  return `${eventPart}${annPart}${scope} · pick one to play & label`;
                })()}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {!bandEvent && (
                <button
                  type="button"
                  onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  title={`Sort ${sortDir === 'asc' ? 'ascending' : 'descending'} · click to flip`}
                  style={smallChipBtn(false)}
                >
                  <span>Sort {sortDir === 'asc' ? 'oldest first' : 'newest first'}</span>
                  <span style={{ color: 'var(--ink-1)' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
                </button>
              )}
              {bandEvent && (
                <button type="button" onClick={() => setBandEventId(null)} style={smallChipBtn(false)}>
                  ✕ Clear event
                </button>
              )}
              {selectedHourTs != null && !bandEvent && (
                <button type="button" onClick={() => setSelectedHourTs(null)} style={smallChipBtn(false)}>
                  ✕ Clear filter
                </button>
              )}
              {(eventsError || hourEventsError) && (
                <span className="mono" style={{ fontSize: 10, color: 'var(--neon-hot)' }}>
                  {hourEventsError ?? eventsError}
                </span>
              )}
            </div>
          </div>
          <EventsList
            entries={recentEntries}
            selectedEventId={selectedEventId}
            selectedAnnotationId={selectedAnnotationId}
            onSelectEvent={(id) => {
              setSelectedEventId(id);
              setSelectedAnnotationId(null);
            }}
            onSelectAnnotation={handleSelectAnnotation}
            threshold={threshold}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div className="mono" style={{
              fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--ink-2)', marginBottom: 8,
            }}>
              Playback
            </div>
            {selectedAnnotation ? (
              <AnnotationPlayback
                annotation={selectedAnnotation}
                onDelete={() => handleDeleteAnnotation(selectedAnnotation.id)}
              />
            ) : (
              <EventPlayer
                event={selectedEvent}
                onNext={nextEvent ? () => setSelectedEventId(nextEvent.event_id) : undefined}
                onPrev={prevEvent ? () => setSelectedEventId(prevEvent.event_id) : undefined}
                onDeleted={(id) => {
                  setEvents((prev) => prev.filter((e) => e.event_id !== id));
                  setHourEvents((prev) => prev?.filter((e) => e.event_id !== id) ?? null);
                  setSelectedEventId(null);
                  refreshEvents();
                  refreshEventIndex();
                }}
              />
            )}
          </div>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div className="mono" style={{
              fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--ink-2)', marginBottom: 8,
            }}>
              Label
            </div>
            {selectedAnnotation ? (
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                Annotation labeled <span style={{ color: 'var(--neon-ok)' }}>{selectedAnnotation.label}</span>.
                Delete and re-draw to change the label.
              </div>
            ) : (
              <LabelPicker
                event={selectedEvent}
                onLabelled={(eventId, label) => {
                  const patch = (e: DeviceEvent) =>
                    e.event_id === eventId ? { ...e, label } : e;
                  setEvents((prev) => prev.map(patch));
                  setHourEvents((prev) => prev?.map(patch) ?? null);
                  const evTs = (events.find((e) => e.event_id === eventId)
                    ?? hourEvents?.find((e) => e.event_id === eventId))?.ts;
                  if (evTs != null) {
                    setEventIndex((prev) =>
                      prev.map((x) => (x.ts === evTs ? { ...x, labeled: true } : x)));
                  }
                  if (nextEvent && nextEvent.event_id !== eventId) {
                    setSelectedEventId(nextEvent.event_id);
                    setSelectedAnnotationId(null);
                    setBandEventId(null);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DayBanner({
  day, dayLabel, coveredHours, threshold,
}: {
  day: Day;
  dayLabel: string;
  coveredHours: number;
  threshold: number;
}) {
  const breach = day.breaches > 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      background: breach ? 'oklch(22% 0.06 35)' : 'var(--bg-1)',
      border: `1px solid ${breach ? 'oklch(50% 0.15 35)' : 'var(--line)'}`,
      borderRadius: 8, gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 10, height: 10, borderRadius: 5,
            background: breach ? 'var(--neon-hot)' : 'var(--neon-ok)',
          }} />
          <span className="mono" style={{
            fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: breach ? 'var(--neon-hot)' : 'var(--neon-ok)',
            fontWeight: 600,
          }}>
            {breach ? `${day.breaches} breach hour${day.breaches === 1 ? '' : 's'}` : 'Within threshold'}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 14, color: 'var(--ink-0)', fontWeight: 500 }}>{dayLabel}</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>
            {day.key} · {coveredHours}/24 hours reported
          </div>
        </div>
        {day.event && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--neon-focus)' }}>
            ◆ {day.event}
          </span>
        )}
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
        THRESHOLD <span style={{ color: 'var(--neon-hot)' }}>≥ {threshold} dB</span>
      </div>
    </div>
  );
}

interface DaySpectrogramPanelProps {
  deviceId: string;
  day: Day;
  palette: PaletteKey;
  threshold: number;
  ribbonEvents: EventIndexEntry[];
  annotations: SpectrogramAnnotation[];
  selectedAnnotationId: number | null;
  onSelectAnnotation: (id: number) => void;
  selectedHourTs: number | null;
  onHourClick: (hourTs: number) => void;
  hourEvents: DeviceEvent[];
  hourEventsLoading: boolean;
  hourEventsError: string | null;
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
  onCloseHour: () => void;
  onDeleteUnlabeled: () => void;
  deletingUnlabeled: boolean;
}

function DaySpectrogramPanel({
  deviceId, day, palette, threshold,
  ribbonEvents, annotations, selectedAnnotationId, onSelectAnnotation,
  selectedHourTs, onHourClick,
  hourEvents, hourEventsLoading, hourEventsError,
  selectedEventId, onSelectEvent, onCloseHour,
  onDeleteUnlabeled, deletingUnlabeled,
}: DaySpectrogramPanelProps) {
  const { timeFormat } = useTweaks();
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 8, gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500 }}>
            24-hour spectrogram · {day.key}
          </div>
          <div className="mono" style={{
            fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginTop: 2,
          }}>
            CLICK A TILE TO REPLAY · breach ≥ {threshold} dB
          </div>
        </div>
        <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', alignItems: 'center' }}>
          <LegendDot color="oklch(82% 0.14 160)" label="Labeled" />
          <LegendDot color="oklch(88% 0.16 80)" label="Unlabeled" />
          <LegendDot color="oklch(82% 0.16 270)" label="Annotation" dashed />
        </div>
      </div>

      <HistoryRibbon24h
        deviceId={deviceId}
        dayKey={day.key}
        palette={palette}
        height={64}
        selectedHourTs={selectedHourTs}
        onHourClick={onHourClick}
        events={ribbonEvents}
        annotations={annotations}
        selectedAnnotationId={selectedAnnotationId}
        onAnnotationClick={onSelectAnnotation}
      />
      <div className="mono" style={{
        display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)',
        fontSize: 9, color: 'var(--ink-3)', marginTop: 4,
      }}>
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} style={{ textAlign: 'center', opacity: h % 3 === 0 ? 1 : 0.4 }}>
            {formatHourTick(h, timeFormat)}
          </div>
        ))}
      </div>

      {selectedHourTs != null && (
        <HourPlaybackViewer
          hourTs={selectedHourTs}
          threshold={threshold}
          events={hourEvents}
          loading={hourEventsLoading}
          error={hourEventsError}
          selectedId={selectedEventId}
          onSelect={onSelectEvent}
          onClose={onCloseHour}
          onDeleteUnlabeled={onDeleteUnlabeled}
          deletingUnlabeled={deletingUnlabeled}
          deviceId={deviceId}
          palette={palette}
          annotations={annotations}
          selectedAnnotationId={selectedAnnotationId}
          onSelectAnnotation={onSelectAnnotation}
        />
      )}
    </div>
  );
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        width: 14, height: 8, borderRadius: 1,
        background: color, opacity: 0.55,
        border: `1px ${dashed ? 'dashed' : 'solid'} ${color}`,
      }} />
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
    </span>
  );
}

function smallChipBtn(active: boolean): React.CSSProperties {
  return {
    fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
    textTransform: 'uppercase', padding: '3px 8px',
    background: active ? 'var(--bg-3)' : 'var(--bg-2)',
    border: '1px solid var(--line)',
    color: active ? 'var(--ink-0)' : 'var(--ink-2)',
    borderRadius: 3, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 6,
  };
}

function AnnotationPlayback({
  annotation, onDelete,
}: {
  annotation: SpectrogramAnnotation;
  onDelete: () => void;
}) {
  const { timeFormat } = useTweaks();
  const duration = annotation.ts_end - annotation.ts_start;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
        Spectrogram annotation · no audio
      </div>
      <div className="mono" style={{ fontSize: 12, color: 'var(--ink-1)' }}>
        {formatClock(annotation.ts_start, timeFormat, { withSeconds: true })} → {formatClock(annotation.ts_end, timeFormat, { withSeconds: true })} · {duration.toFixed(1)} s ·{' '}
        <span style={{ color: 'var(--neon-ok)' }}>{annotation.label}</span>
      </div>
      <div>
        <button
          type="button"
          onClick={onDelete}
          style={{
            fontSize: 10, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
            textTransform: 'uppercase', padding: '5px 12px',
            background: 'var(--bg-2)',
            border: '1px solid var(--neon-hot)',
            color: 'var(--neon-hot)',
            borderRadius: 4, cursor: 'pointer',
          }}
        >🗑 Delete annotation</button>
      </div>
    </div>
  );
}
