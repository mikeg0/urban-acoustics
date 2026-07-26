import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  fetchCorrelatedEventCandidates,
  fetchCorrelatedEventFrames,
  fetchCorrelatedEventSettings,
  fetchEvent,
  fetchEventIndex,
  fetchEventPlaybackUrl,
  fetchEventsInRange,
  putCorrelatedEventSettings,
  reviewCorrelatedEventCandidate,
} from './api';
import { Card, Pill } from './atoms';
import { Clock, UserChip } from './chrome';
import { HourPlaybackViewer } from './events/HourPlayback';
import { HistoryRibbon24h, SpectrogramCanvas } from './spectrogram';
import { useTweaks } from './tweaks';
import { formatHourTick } from './utils';
import type {
  CandidateAudioFilter,
  CandidateGroup,
  CandidateLabel,
  CandidateReviewFilter,
  CorrelatedEventCandidate,
  CorrelatedEventFrames,
  CorrelatedEventSettings,
  CorrelatedEventSettingsUpdate,
  DeviceEvent,
  EventIndexEntry,
  EventLabel,
} from './types';
import { EVENT_LABELS, WEATHER_LABELS } from './types';


const REVIEW_FILTERS: CandidateReviewFilter[] = ['pending', 'labeled', 'dismissed', 'all'];
const GROUP_FILTERS: Array<CandidateGroup | 'all'> = ['all', 'correlated', 'outside_only'];
const WEATHER_LABEL_SET = new Set<EventLabel>(WEATHER_LABELS);
const NON_WEATHER_LABELS = EVENT_LABELS.filter((label) => !WEATHER_LABEL_SET.has(label));
// 'linked' leads because only those candidates can be labeled; the rest are for
// judging whether the device's own recording threshold is set too high.
const AUDIO_FILTERS: Array<{ value: CandidateAudioFilter; text: string }> = [
  { value: 'linked', text: 'ready' },
  { value: 'pending', text: 'awaiting' },
  { value: 'missing', text: 'no clip' },
  { value: 'all', text: 'all' },
];

const actionButton: CSSProperties = {
  border: '1px solid var(--line-strong)',
  borderRadius: 6,
  background: 'var(--bg-2)',
  padding: '9px 16px',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
};

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...actionButton,
        padding: '5px 9px',
        background: active ? 'var(--bg-3)' : 'transparent',
        color: active ? 'var(--ink-0)' : 'var(--ink-3)',
      }}
    >
      {children}
    </button>
  );
}

function formatMoment(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function CandidateHistoryRibbons({
  settings,
  selectedHourTs,
  onHourClick,
  events,
  hourEvents,
  hourEventsLoading,
  hourEventsError,
  selectedEventId,
  onEventClick,
}: {
  settings: CorrelatedEventSettings;
  selectedHourTs: number | null;
  onHourClick: (hourTs: number) => void;
  events: EventIndexEntry[];
  hourEvents: DeviceEvent[];
  hourEventsLoading: boolean;
  hourEventsError: string | null;
  selectedEventId: string | null;
  onEventClick: (eventId: string) => void;
}) {
  const { spectroColor, timeFormat } = useTweaks();
  return (
    <div style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg-1)' }}>
      <div className="mono" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        gap: 12, marginBottom: 5, fontSize: 9, color: 'var(--ink-3)',
        letterSpacing: '0.12em',
      }}>
        <span>OUTSIDE · WIND-EXPOSED · LAST 24 H · MAX/SEC PER HOUR-TILE · CLICK A TILE TO FILTER REVIEW QUEUE</span>
        <span style={{ whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--neon-warn)' }}>■ UNLABELED</span>
          {' · '}
          <span style={{ color: 'var(--neon-ok)' }}>■ LABELED</span>
          {' · NOW →'}
        </span>
      </div>
      <HistoryRibbon24h
        deviceId={settings.outside_device_id}
        palette={spectroColor}
        height={56}
        selectedHourTs={selectedHourTs}
        onHourClick={onHourClick}
        events={events}
      />
      <div className="mono" style={{
        display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)',
        marginTop: 4, fontSize: 9, color: 'var(--ink-3)',
      }}>
        {Array.from({ length: 24 }).map((_, i) => {
          const hoursAgo = 23 - i;
          const show = hoursAgo === 0 || hoursAgo % 4 === 0;
          const hour = new Date(Date.now() - hoursAgo * 3600 * 1000).getHours();
          return <div key={i} style={{ textAlign: 'center' }}>{show ? formatHourTick(hour, timeFormat) : ''}</div>;
        })}
      </div>
      {selectedHourTs != null && (
        <HourPlaybackViewer
          hourTs={selectedHourTs}
          threshold={settings.outside_min_db}
          events={hourEvents}
          loading={hourEventsLoading}
          error={hourEventsError}
          selectedId={selectedEventId}
          onSelect={onEventClick}
          onClose={() => onHourClick(selectedHourTs)}
          onDeleteUnlabeled={() => {}}
          deletingUnlabeled={false}
          deviceId={settings.outside_device_id}
          palette={spectroColor}
          colorEventsByLabel
          instruction={`${hourEvents.length} CLIP${hourEvents.length === 1 ? '' : 'S'} · CLICK AN EVENT BAND TO FILTER REVIEW QUEUE`}
          showDelete={false}
        />
      )}
      {selectedHourTs != null && (
        <div className="mono" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: 9, marginTop: 8, fontSize: 9, color: 'var(--neon-focus)',
        }}>
          REVIEW QUEUE FILTERED TO {formatMoment(selectedHourTs)} → {formatMoment(selectedHourTs + 3600)}
          {selectedEventId != null && <span>· SELECTED EVENT</span>}
          <button onClick={() => onHourClick(selectedHourTs)} style={{ ...actionButton, padding: '3px 7px' }}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function streamMatrix(frames: CorrelatedEventFrames['streams'][number]['frames']): number[][] {
  if (frames.length === 0) return [];
  const bands = frames[0].bands.length;
  return Array.from({ length: bands }, (_, band) =>
    frames.map((frame) => Math.max(0, Math.min(1, (frame.bands[band] - 20) / 90))),
  );
}

type AudioStatus = 'loading' | 'ready' | 'empty';

function AudioClip({
  url,
  status,
  emptyLabel,
  hideEmptyLabel = false,
  label,
  audioRef,
  onProgress,
}: {
  url: string | null;
  status: AudioStatus;
  emptyLabel: string;
  hideEmptyLabel?: boolean;
  label: string;
  audioRef: RefObject<HTMLAudioElement>;
  onProgress: (currentTime: number) => void;
}) {
  if (status === 'empty' && hideEmptyLabel) return null;
  if (status !== 'ready' || !url) {
    return (
      <div className="mono" style={{ height: 32, display: 'grid', placeItems: 'center', color: status === 'empty' ? 'var(--neon-warn)' : 'var(--ink-3)', fontSize: 9 }}>
        {status === 'loading' ? 'LOADING AUDIO…' : emptyLabel}
      </div>
    );
  }
  const reportProgress = () => {
    const clip = audioRef.current;
    if (clip && Number.isFinite(clip.duration) && clip.duration > 0) {
      onProgress(clip.currentTime);
    }
  };
  return (
    <audio
      ref={audioRef}
      hidden
      preload="metadata"
      src={url}
      aria-label={label}
      onLoadedMetadata={reportProgress}
      onTimeUpdate={reportProgress}
    />
  );
}

/** The outside clip the label depends on. The detector links it server-side, so
 *  this plays an exact known event rather than guessing from a time range. */
function OutsideAudio({
  eventId,
  audioRef,
  onProgress,
  onEventChange,
}: {
  eventId: string | null;
  audioRef: RefObject<HTMLAudioElement>;
  onProgress: (currentTime: number) => void;
  onEventChange: (event: DeviceEvent | null) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioStatus>('loading');

  useEffect(() => {
    setUrl(null);
    onEventChange(null);
    if (!eventId) { setStatus('empty'); return; }
    setStatus('loading');
    let cancelled = false;
    fetchEvent(eventId)
      .then((event) => {
        if (cancelled) return;
        if (!event.playback_url) throw new Error('event has no playback URL');
        onEventChange(event);
        setUrl(event.playback_url);
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('empty'); });
    return () => { cancelled = true; };
  }, [eventId, onEventChange]);

  return (
    <AudioClip
      url={url}
      status={status}
      emptyLabel="OUTDOOR CLIP UNAVAILABLE"
      label="Outside microphone clip"
      audioRef={audioRef}
      onProgress={onProgress}
    />
  );
}

/** Inside audio is a bonus cross-check, not a labeling requirement, so it stays
 *  a best-effort search over the snapshot window. */
function InsideAudio({
  deviceId,
  fromTs,
  toTs,
  peakTs,
  audioRef,
  onProgress,
  onStatusChange,
  onEventChange,
}: {
  deviceId: string | undefined;
  fromTs: number;
  toTs: number;
  peakTs: number | null;
  audioRef: RefObject<HTMLAudioElement>;
  onProgress: (currentTime: number) => void;
  onStatusChange: (status: AudioStatus) => void;
  onEventChange: (event: DeviceEvent | null) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioStatus>('loading');

  useEffect(() => {
    setUrl(null);
    setStatus('loading');
    onEventChange(null);
    if (!deviceId) return;
    let cancelled = false;
    fetchEventsInRange(deviceId, fromTs, toTs)
      .then((events) => {
        if (cancelled) return null;
        const playable = events.filter((event) =>
          event.status === 'available' || event.status === 'uploaded');
        const nearest = playable.sort((a, b) =>
          Math.abs(a.ts - (peakTs ?? fromTs)) - Math.abs(b.ts - (peakTs ?? fromTs)))[0];
        if (!nearest) return null;
        onEventChange(nearest);
        return fetchEventPlaybackUrl(nearest.event_id);
      })
      .then((playback) => {
        if (cancelled) return;
        if (playback) {
          setUrl(playback.url);
          setStatus('ready');
        } else {
          setStatus('empty');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('empty');
    });
    return () => { cancelled = true; };
  }, [deviceId, fromTs, toTs, peakTs, onEventChange]);

  useEffect(() => {
    onStatusChange(status);
  }, [status, onStatusChange]);

  return (
    <AudioClip
      url={url}
      status={status}
      emptyLabel="NO INSIDE CLIP IN SNAPSHOT"
      hideEmptyLabel
      label="Inside microphone clip"
      audioRef={audioRef}
      onProgress={onProgress}
    />
  );
}

function CandidateList({
  items,
  selectedId,
  onSelect,
}: {
  items: CorrelatedEventCandidate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="mono" style={{ padding: 28, textAlign: 'center', color: 'var(--ink-3)', fontSize: 11 }}>
        NO CANDIDATES IN THIS VIEW
      </div>
    );
  }
  return (
    <div style={{ overflowY: 'auto', minHeight: 0 }}>
      {items.map((item) => {
        const active = item.candidate_id === selectedId;
        return (
          <button
            key={item.candidate_id}
            onClick={() => onSelect(item.candidate_id)}
            style={{
              width: '100%',
              display: 'grid',
              gridTemplateColumns: '9px 1fr auto',
              alignItems: 'center',
              gap: 9,
              padding: '10px 12px',
              textAlign: 'left',
              border: 'none',
              borderBottom: '1px solid var(--line)',
              background: active ? 'var(--bg-3)' : 'transparent',
              cursor: 'pointer',
            }}
          >
            <span style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: item.candidate_group === 'correlated' ? 'var(--neon-ok)' : 'var(--neon-warn)',
            }} />
            <span style={{ minWidth: 0 }}>
              <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--ink-1)' }}>
                {formatMoment(item.outside_peak_ts)}
              </span>
              <span className="mono" style={{ display: 'block', fontSize: 9, color: 'var(--ink-3)', marginTop: 2 }}>
                {item.candidate_group.replace('_', ' ')} · outside +{item.outside_rise_db.toFixed(1)} dB
                {!item.labelable && (
                  <span style={{ color: 'var(--neon-warn)' }}>
                    {item.audio_state === 'pending' ? ' · awaiting audio' : ' · no clip'}
                  </span>
                )}
              </span>
            </span>
            <span className="mono" style={{ fontSize: 10, color: item.label ? 'var(--neon-cool)' : 'var(--ink-3)' }}>
              {item.dismissed ? 'DISMISSED' : (item.label?.toUpperCase() ?? 'OPEN')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MicSnapshot({
  title,
  frames,
  peak,
  baseline,
  rise,
  headerNotice,
  audio,
  audioRef,
  playbackTime,
  audioStartTs,
  clipStartTs,
  clipDurationS,
  snapshotStart,
  snapshotEnd,
  hoverFraction,
  onHoverFraction,
}: {
  title: string;
  frames: CorrelatedEventFrames['streams'][number] | undefined;
  peak: number | null;
  baseline: number | null;
  rise: number | null;
  headerNotice?: string;
  audio: ReactNode;
  audioRef: RefObject<HTMLAudioElement>;
  playbackTime: number | null;
  audioStartTs: number | null;
  clipStartTs: number | null;
  clipDurationS: number | null;
  snapshotStart: number;
  snapshotEnd: number;
  hoverFraction: number | null;
  onHoverFraction: (fraction: number | null) => void;
}) {
  const matrix = useMemo(() => streamMatrix(frames?.frames ?? []), [frames]);
  const fractionFromEvent = (event: MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  };
  const toggleSpectrogramPlayback = (event: MouseEvent<HTMLDivElement>) => {
    const clip = audioRef.current;
    if (!clip || !Number.isFinite(clip.duration) || clip.duration <= 0) return;
    if (clip.paused || clip.ended) {
      const clickTs = snapshotStart + fractionFromEvent(event) * (snapshotEnd - snapshotStart);
      clip.currentTime = audioStartTs == null
        ? fractionFromEvent(event) * clip.duration
        : Math.max(0, Math.min(clip.duration, clickTs - audioStartTs));
      void clip.play();
    } else {
      clip.pause();
    }
  };
  const playbackFraction = playbackTime == null
    ? null
    : audioStartTs == null
      ? Math.min(1, playbackTime / (audioRef.current?.duration || 1))
      : (audioStartTs + playbackTime - snapshotStart) / (snapshotEnd - snapshotStart);
  const clipStartFraction = clipStartTs == null
    ? null
    : Math.max(0, (clipStartTs - snapshotStart) / (snapshotEnd - snapshotStart));
  const clipEndFraction = clipStartTs == null || clipDurationS == null
    ? null
    : Math.min(1, (clipStartTs + clipDurationS - snapshotStart) / (snapshotEnd - snapshotStart));

  return (
    <div style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg-1)' }}>
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-2)', letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>{title}</div>
        {headerNotice && (
          <div className="mono" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', color: 'var(--neon-warn)', fontSize: 9, whiteSpace: 'nowrap' }}>
            {headerNotice}
          </div>
        )}
        <div className="mono" style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--ink-2)', textAlign: 'right', whiteSpace: 'nowrap' }}>
          <span>{peak == null ? 'NO PEAK' : `${peak.toFixed(1)} dB PEAK`}</span>
          <span style={{ color: 'var(--ink-3)' }}>
            {baseline == null || rise == null
              ? `— · ${frames?.frames.length ?? 0} permanent frames`
              : `${baseline.toFixed(1)} baseline · ${frames?.frames.length ?? 0} permanent frames · +${rise.toFixed(1)}`}
          </span>
        </div>
      </div>
      {matrix.length ? (
        <div
          onClick={toggleSpectrogramPlayback}
          onMouseMove={(event) => onHoverFraction(fractionFromEvent(event))}
          onMouseLeave={() => onHoverFraction(null)}
          title="Click to play or pause audio"
          style={{ position: 'relative', cursor: 'pointer' }}
        >
          <SpectrogramCanvas data={matrix} palette="heat" height={145} showGrid />
          {clipStartFraction != null && clipEndFraction != null && clipEndFraction > clipStartFraction && (
            <div style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${clipStartFraction * 100}%`,
              width: `${(clipEndFraction - clipStartFraction) * 100}%`,
              border: '2px solid var(--neon-warn)',
              boxSizing: 'border-box',
              pointerEvents: 'none',
            }} />
          )}
          {playbackFraction != null && playbackFraction >= 0 && playbackFraction <= 1 && (
            <div style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${playbackFraction * 100}%`,
              width: 2, marginLeft: -1,
              background: 'var(--neon-hot)',
              boxShadow: '0 0 6px var(--neon-hot)',
              pointerEvents: 'none',
            }} />
          )}
          {hoverFraction != null && (
            <div style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${hoverFraction * 100}%`,
              width: 1,
              background: 'rgba(255,255,255,0.9)',
              pointerEvents: 'none',
            }} />
          )}
        </div>
      ) : (
        <div className="mono" style={{ height: 145, display: 'grid', placeItems: 'center', color: 'var(--ink-3)', background: 'var(--bg-0)', borderRadius: 4, fontSize: 10 }}>
          NO SNAPSHOTTED FRAMES
        </div>
      )}
      <div style={{ marginTop: 8 }}>{audio}</div>
    </div>
  );
}

function CandidateDetail({
  candidate,
  frames,
  busy,
  onReview,
}: {
  candidate: CorrelatedEventCandidate | null;
  frames: CorrelatedEventFrames | null;
  busy: boolean;
  onReview: (body: { label?: CandidateLabel | null; dismissed?: boolean }) => void;
}) {
  const outsideAudioRef = useRef<HTMLAudioElement>(null);
  const insideAudioRef = useRef<HTMLAudioElement>(null);
  const [outsidePlayback, setOutsidePlayback] = useState<number | null>(null);
  const [insidePlayback, setInsidePlayback] = useState<number | null>(null);
  const [outsideEvent, setOutsideEvent] = useState<DeviceEvent | null>(null);
  const [insideEvent, setInsideEvent] = useState<DeviceEvent | null>(null);
  const [insideAudioStatus, setInsideAudioStatus] = useState<AudioStatus>('loading');
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);

  useEffect(() => {
    setOutsidePlayback(null);
    setInsidePlayback(null);
    setOutsideEvent(null);
    setInsideEvent(null);
    setInsideAudioStatus('loading');
    setHoverFraction(null);
  }, [candidate?.candidate_id]);

  if (!candidate) {
    return <div className="mono" style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--ink-3)' }}>SELECT A CANDIDATE</div>;
  }
  const outside = frames?.streams.find((s) => s.device_id === candidate.outside_device_id);
  const inside = frames?.streams.find((s) => s.device_id === candidate.inside_device_id);
  return (
    <div style={{ padding: 14, overflowY: 'auto', minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ fontSize: 18, margin: 0, fontWeight: 550 }}>{formatMoment(candidate.outside_peak_ts)}</h2>
            <Pill tone={candidate.candidate_group === 'correlated' ? 'cool' : 'warn'}>
              {candidate.candidate_group.replace('_', ' ').toUpperCase()}
            </Pill>
            <Pill tone={candidate.labelable ? 'ok' : 'hot'}>
              {candidate.labelable ? 'AUDIO READY' : `AUDIO ${candidate.audio_state.toUpperCase()}`}
            </Pill>
          </div>
          <div className="mono" style={{ fontSize: 9, color: 'var(--ink-3)', marginTop: 4 }}>
            {candidate.candidate_id} · metric {candidate.metric.toUpperCase()} · ±{((candidate.snapshot_end - candidate.snapshot_start) / 2).toFixed(0)}s snapshot
          </div>
        </div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', textAlign: 'right' }}>
          {candidate.reviewed_at
            ? `Reviewed ${formatMoment(candidate.reviewed_at)}${candidate.reviewed_by_email ? ` by ${candidate.reviewed_by_email}` : ''}`
            : 'Awaiting review'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
        <MicSnapshot
          title="OUTSIDE · WIND-EXPOSED"
          frames={outside}
          peak={candidate.outside_peak_db}
          baseline={candidate.outside_baseline_db}
          rise={candidate.outside_rise_db}
          audioRef={outsideAudioRef}
          playbackTime={outsidePlayback}
          audioStartTs={outsideEvent?.ts ?? null}
          clipStartTs={outsideEvent?.ts ?? null}
          clipDurationS={outsideEvent?.duration_s ?? null}
          snapshotStart={candidate.snapshot_start}
          snapshotEnd={candidate.snapshot_end}
          hoverFraction={hoverFraction}
          onHoverFraction={setHoverFraction}
          audio={(
            <OutsideAudio
              eventId={candidate.outside_event_id}
              audioRef={outsideAudioRef}
              onProgress={setOutsidePlayback}
              onEventChange={setOutsideEvent}
            />
          )}
        />
        <MicSnapshot
          title="INSIDE · WIND-IMMUNE"
          frames={inside}
          peak={candidate.inside_peak_db}
          baseline={candidate.inside_baseline_db}
          rise={candidate.inside_rise_db}
          headerNotice={insideAudioStatus === 'empty' ? 'NO INSIDE CLIP IN SNAPSHOT' : undefined}
          audioRef={insideAudioRef}
          playbackTime={insidePlayback}
          audioStartTs={insideEvent?.ts ?? null}
          clipStartTs={outsideEvent?.ts ?? null}
          clipDurationS={outsideEvent?.duration_s ?? null}
          snapshotStart={candidate.snapshot_start}
          snapshotEnd={candidate.snapshot_end}
          hoverFraction={hoverFraction}
          onHoverFraction={setHoverFraction}
          audio={(
            <InsideAudio
              deviceId={inside?.device_id}
              fromTs={candidate.snapshot_start}
              toTs={candidate.snapshot_end}
              peakTs={candidate.inside_peak_ts}
              audioRef={insideAudioRef}
              onProgress={setInsidePlayback}
              onStatusChange={setInsideAudioStatus}
              onEventChange={setInsideEvent}
            />
          )}
        />
      </div>

      <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg-1)' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 10 }}>
          SOURCE LABEL · WEATHER = SUPPRESS · ALL OTHER SOURCES = REAL · X DISMISSES
        </div>
        {!candidate.labelable && (
          <div className="mono" style={{ fontSize: 10, color: 'var(--neon-warn)', marginBottom: 10, lineHeight: 1.5 }}>
            {candidate.audio_state === 'pending'
              ? 'WAITING FOR THE OUTDOOR CLIP TO UPLOAD — LABELING UNLOCKS ONCE IT ARRIVES'
              : 'NO OUTDOOR CLIP WAS RECORDED FOR THIS PEAK — THE SOURCE CANNOT BE IDENTIFIED BY EYE, SO DISMISS IT'}
          </div>
        )}
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {([
            { title: 'WEATHER', labels: WEATHER_LABELS, color: 'var(--neon-warn)' },
            { title: 'OTHER SOURCES', labels: NON_WEATHER_LABELS, color: 'var(--neon-ok)' },
          ] as const).map((group) => (
            <div key={group.title} style={{ flex: group.title === 'WEATHER' ? '0 1 150px' : '1 1 420px' }}>
              <div className="mono" style={{ fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.12em', marginBottom: 7 }}>
                {group.title}
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {group.labels.map((label) => (
                  <button
                    key={label}
                    disabled={busy || !candidate.labelable}
                    title={candidate.labelable ? undefined : 'Requires a playable outdoor clip'}
                    onClick={() => onReview({ label })}
                    style={{
                      ...actionButton,
                      minWidth: 104,
                      padding: '7px 12px',
                      borderColor: candidate.label === label ? 'var(--neon-cool)' : 'var(--line-strong)',
                      color: group.color,
                      opacity: busy || !candidate.labelable ? 0.4 : 1,
                      cursor: candidate.labelable ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            disabled={busy}
            onClick={() => onReview({ dismissed: !candidate.dismissed })}
            style={{ ...actionButton, marginLeft: 'auto', opacity: busy ? 0.5 : 1, color: 'var(--ink-2)' }}
          >
            {candidate.dismissed ? 'Restore' : 'Dismiss · X'}
          </button>
        </div>
      </div>
    </div>
  );
}

const NUMBER_FIELDS: Array<{
  key: keyof CorrelatedEventSettingsUpdate;
  label: string;
  step?: number;
}> = [
  { key: 'baseline_window_s', label: 'Baseline window (s)' },
  { key: 'min_baseline_samples', label: 'Minimum baseline samples' },
  { key: 'outside_rise_db', label: 'Outside rise (dB)', step: 0.5 },
  { key: 'inside_rise_db', label: 'Inside rise (dB)', step: 0.5 },
  { key: 'outside_min_db', label: 'Outside floor (dB)', step: 0.5 },
  { key: 'inside_min_db', label: 'Inside floor (dB)', step: 0.5 },
  { key: 'peak_merge_window_s', label: 'Merge window (s)' },
  { key: 'peak_cooldown_s', label: 'Peak cooldown (s)' },
  { key: 'correlation_window_s', label: 'Correlation ± window (s)' },
  { key: 'snapshot_before_s', label: 'Snapshot before (s)' },
  { key: 'snapshot_after_s', label: 'Snapshot after (s)' },
  { key: 'scan_interval_s', label: 'Scan interval (s)' },
  { key: 'audio_match_window_s', label: 'Audio match ± window (s)' },
  { key: 'audio_grace_s', label: 'Audio wait before giving up (s)' },
];

function DetectionSettingsPanel({ settings, onSaved }: { settings: CorrelatedEventSettings; onSaved: (s: CorrelatedEventSettings) => void }) {
  const [draft, setDraft] = useState<CorrelatedEventSettingsUpdate>(() => {
    const { last_processed_at: _last, updated_at: _updated, ...editable } = settings;
    return editable;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const { last_processed_at: _last, updated_at: _updated, ...editable } = settings;
    setDraft(editable);
  }, [settings]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await putCorrelatedEventSettings(draft);
      onSaved(updated);
      setMessage('Saved');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: CSSProperties = {
    width: '100%', background: 'var(--bg-0)', border: '1px solid var(--line)', borderRadius: 4,
    color: 'var(--ink-0)', padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 11,
  };
  return (
    <Card title="DETECTOR PARAMETERS" subtitle="Changes apply to the next cloud scan" padding={14}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 10 }}>
        <label className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
          OUTSIDE DEVICE
          <input style={inputStyle} value={draft.outside_device_id} onChange={(e) => setDraft({ ...draft, outside_device_id: e.target.value })} />
        </label>
        <label className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
          INSIDE DEVICE
          <input style={inputStyle} value={draft.inside_device_id} onChange={(e) => setDraft({ ...draft, inside_device_id: e.target.value })} />
        </label>
        <label className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
          METRIC
          <select style={inputStyle} value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value as CorrelatedEventSettingsUpdate['metric'] })}>
            <option value="laeq">LAeq</option><option value="lafmax">LAFmax</option><option value="lcpeak">LCpeak</option>
          </select>
        </label>
        {NUMBER_FIELDS.map(({ key, label, step }) => (
          <label key={key} className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
            {label.toUpperCase()}
            <input
              type="number"
              step={step ?? 1}
              style={inputStyle}
              value={draft[key] as number}
              onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <label className="mono" style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--ink-2)', fontSize: 10 }}>
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          DETECTOR ENABLED
        </label>
        <button disabled={saving} onClick={save} style={{ ...actionButton, marginLeft: 'auto' }}>{saving ? 'Saving…' : 'Save settings'}</button>
        {message && <span className="mono" style={{ fontSize: 10, color: message === 'Saved' ? 'var(--neon-ok)' : 'var(--neon-hot)' }}>{message}</span>}
      </div>
    </Card>
  );
}

export function CandidateLabelingDashboard({ onBack }: { onBack: () => void }) {
  const [review, setReview] = useState<CandidateReviewFilter>('pending');
  const [group, setGroup] = useState<CandidateGroup | 'all'>('all');
  const [audio, setAudio] = useState<CandidateAudioFilter>('linked');
  const [items, setItems] = useState<CorrelatedEventCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [awaitingAudio, setAwaitingAudio] = useState(0);
  const [missingAudio, setMissingAudio] = useState(0);
  const [selectedHourTs, setSelectedHourTs] = useState<number | null>(null);
  const [eventIndex, setEventIndex] = useState<EventIndexEntry[]>([]);
  const [hourEvents, setHourEvents] = useState<DeviceEvent[]>([]);
  const [hourEventsLoading, setHourEventsLoading] = useState(false);
  const [hourEventsError, setHourEventsError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frames, setFrames] = useState<CorrelatedEventFrames | null>(null);
  const [settings, setSettings] = useState<CorrelatedEventSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCorrelatedEventCandidates(review, group, audio, selectedHourTs);
      setItems(result.items);
      setTotal(result.total);
      setPending(result.pending);
      setAwaitingAudio(result.awaiting_audio);
      setMissingAudio(result.missing_audio);
      setSelectedId((current) =>
        current && result.items.some((item) => item.candidate_id === current)
          ? current
          : (result.items[0]?.candidate_id ?? null),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, [review, group, audio, selectedHourTs]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetchCorrelatedEventSettings().then(setSettings).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!settings?.outside_device_id) return;
    let cancelled = false;
    const loadEvents = () => {
      const now = Date.now() / 1000;
      fetchEventIndex(settings.outside_device_id, now - 86400, now)
        .then((result) => { if (!cancelled) setEventIndex(result.events); })
        .catch(() => { /* spectrogram stays usable without event bands */ });
    };
    loadEvents();
    const id = window.setInterval(loadEvents, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [settings?.outside_device_id]);
  useEffect(() => {
    if (!settings?.outside_device_id || selectedHourTs == null) {
      setHourEvents([]);
      setHourEventsError(null);
      setHourEventsLoading(false);
      return;
    }
    let cancelled = false;
    setHourEventsLoading(true);
    setHourEventsError(null);
    fetchEventsInRange(settings.outside_device_id, selectedHourTs, selectedHourTs + 3600)
      .then((result) => { if (!cancelled) setHourEvents(result); })
      .catch((e: Error) => { if (!cancelled) setHourEventsError(e.message); })
      .finally(() => { if (!cancelled) setHourEventsLoading(false); });
    return () => { cancelled = true; };
  }, [settings?.outside_device_id, selectedHourTs]);
  useEffect(() => {
    if (!selectedId) { setFrames(null); return; }
    let cancelled = false;
    setFrames(null);
    fetchCorrelatedEventFrames(selectedId)
      .then((data) => { if (!cancelled) setFrames(data); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const queueItems = selectedEventId == null
    ? items
    : items.filter((item) => item.outside_event_id === selectedEventId);
  const selected = queueItems.find((item) => item.candidate_id === selectedId) ?? null;
  const reviewCandidate = useCallback(async (body: { label?: CandidateLabel | null; dismissed?: boolean }) => {
    if (!selectedId || busy) return;
    // Mirrors the server's 409: a label is only meaningful if the outdoor clip
    // was audible. Dismissing an unlabelable candidate stays allowed.
    if (body.label != null && selected && !selected.labelable) {
      setError('Labeling requires a playable outdoor clip for this candidate.');
      return;
    }
    const next = items.find((item) => item.candidate_id !== selectedId)?.candidate_id ?? null;
    setBusy(true);
    setError(null);
    try {
      await reviewCorrelatedEventCandidate(selectedId, body);
      setSelectedId(next);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  }, [selectedId, busy, items, load, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button')) return;
      const key = e.key.toLowerCase();
      if (key === 'x') void reviewCandidate({ dismissed: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviewCandidate]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', minHeight: 0, padding: 14, gap: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg-1)', flexWrap: 'wrap' }}>
        <button onClick={onBack} style={{ ...actionButton, padding: '6px 10px' }}>← Stations</button>
        <div>
          <div className="mono" style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--ink-1)' }}>TWO-MIC LABELING</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>Name the source you hear · weather labels are upload-suppression negatives</div>
        </div>
        <div className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-3)' }}>
          <span style={{ color: pending ? 'var(--neon-warn)' : 'var(--neon-ok)' }}>{pending}</span> LABELABLE
          {awaitingAudio > 0 && <span> · {awaitingAudio} AWAITING AUDIO</span>}
          {missingAudio > 0 && <span> · {missingAudio} NO CLIP</span>}
          {settings?.last_processed_at && <span> · SCANNED {formatMoment(settings.last_processed_at)}</span>}
        </div>
        <button onClick={() => setShowSettings((v) => !v)} style={{ ...actionButton, padding: '6px 10px' }}>
          {showSettings ? 'Hide parameters' : 'Parameters'}
        </button>
        <Clock />
        <UserChip />
      </header>

      {settings && (
        <CandidateHistoryRibbons
          settings={settings}
          selectedHourTs={selectedHourTs}
          onHourClick={(hourTs) => {
            setSelectedHourTs((current) => current === hourTs ? null : hourTs);
            setSelectedEventId(null);
          }}
          events={eventIndex}
          hourEvents={hourEvents}
          hourEventsLoading={hourEventsLoading}
          hourEventsError={hourEventsError}
          selectedEventId={selectedEventId}
          onEventClick={(eventId) => {
            const nextEventId = selectedEventId === eventId ? null : eventId;
            setSelectedEventId(nextEventId);
            setSelectedId(
              nextEventId == null
                ? (items[0]?.candidate_id ?? null)
                : (items.find((item) => item.outside_event_id === nextEventId)?.candidate_id ?? null),
            );
          }}
        />
      )}
      {showSettings && settings && <DetectionSettingsPanel settings={settings} onSaved={setSettings} />}
      {error && <div className="mono" style={{ padding: 9, color: 'var(--neon-hot)', border: '1px solid var(--line)', borderRadius: 5 }}>{error}</div>}

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '330px minmax(0, 1fr)', gap: 12, minHeight: 0 }}>
        <Card title="REVIEW QUEUE" subtitle={`${selectedEventId == null ? total : queueItems.length} matching · ${pending} labelable`} padding={0}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {REVIEW_FILTERS.map((value) => <FilterButton key={value} active={review === value} onClick={() => setReview(value)}>{value}</FilterButton>)}
          </div>
          <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {GROUP_FILTERS.map((value) => <FilterButton key={value} active={group === value} onClick={() => setGroup(value)}>{value.replace('_', ' ')}</FilterButton>)}
          </div>
          <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>AUDIO</span>
            {AUDIO_FILTERS.map(({ value, text }) => (
              <FilterButton key={value} active={audio === value} onClick={() => setAudio(value)}>{text}</FilterButton>
            ))}
          </div>
          {loading
            ? <div className="mono" style={{ padding: 28, textAlign: 'center', color: 'var(--ink-3)' }}>LOADING…</div>
            : <CandidateList items={queueItems} selectedId={selectedId} onSelect={setSelectedId} />}
        </Card>
        <Card padding={0}>
          <CandidateDetail candidate={selected} frames={frames} busy={busy} onReview={(body) => { void reviewCandidate(body); }} />
        </Card>
      </div>
    </div>
  );
}
