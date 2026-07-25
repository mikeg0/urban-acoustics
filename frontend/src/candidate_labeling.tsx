import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  fetchCorrelatedEventCandidates,
  fetchCorrelatedEventFrames,
  fetchCorrelatedEventSettings,
  putCorrelatedEventSettings,
  reviewCorrelatedEventCandidate,
} from './api';
import { Card, Pill } from './atoms';
import { Clock, UserChip } from './chrome';
import { SpectrogramCanvas } from './spectrogram';
import type {
  CandidateGroup,
  CandidateLabel,
  CandidateReviewFilter,
  CorrelatedEventCandidate,
  CorrelatedEventFrames,
  CorrelatedEventSettings,
  CorrelatedEventSettingsUpdate,
} from './types';


const REVIEW_FILTERS: CandidateReviewFilter[] = ['pending', 'labeled', 'dismissed', 'all'];
const GROUP_FILTERS: Array<CandidateGroup | 'all'> = ['all', 'correlated', 'outside_only'];
const LABELS: CandidateLabel[] = ['real', 'wind', 'unsure'];

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

function streamMatrix(frames: CorrelatedEventFrames['streams'][number]['frames']): number[][] {
  if (frames.length === 0) return [];
  const bands = frames[0].bands.length;
  return Array.from({ length: bands }, (_, band) =>
    frames.map((frame) => Math.max(0, Math.min(1, (frame.bands[band] - 20) / 90))),
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
}: {
  title: string;
  frames: CorrelatedEventFrames['streams'][number] | undefined;
  peak: number | null;
  baseline: number | null;
  rise: number | null;
}) {
  const matrix = useMemo(() => streamMatrix(frames?.frames ?? []), [frames]);
  return (
    <div style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg-1)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-2)', letterSpacing: '0.1em' }}>{title}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-1)', marginTop: 2 }}>{frames?.device_name ?? frames?.device_id ?? 'No stream'}</div>
        </div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-2)', textAlign: 'right' }}>
          <div>{peak == null ? 'NO PEAK' : `${peak.toFixed(1)} dB PEAK`}</div>
          <div style={{ color: 'var(--ink-3)', marginTop: 2 }}>
            {baseline == null || rise == null ? '—' : `${baseline.toFixed(1)} baseline · +${rise.toFixed(1)}`}
          </div>
        </div>
      </div>
      {matrix.length ? (
        <SpectrogramCanvas data={matrix} palette="heat" height={145} showGrid />
      ) : (
        <div className="mono" style={{ height: 145, display: 'grid', placeItems: 'center', color: 'var(--ink-3)', background: 'var(--bg-0)', borderRadius: 4, fontSize: 10 }}>
          NO SNAPSHOTTED FRAMES
        </div>
      )}
      <div className="mono" style={{ fontSize: 9, color: 'var(--ink-3)', marginTop: 6 }}>
        {frames?.frames.length ?? 0} permanent frames · low → high frequency, bottom → top
      </div>
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
        />
        <MicSnapshot
          title="INSIDE · WIND-IMMUNE"
          frames={inside}
          peak={candidate.inside_peak_db}
          baseline={candidate.inside_baseline_db}
          rise={candidate.inside_rise_db}
        />
      </div>

      <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg-1)' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 10 }}>
          HUMAN LABEL · R/W/U shortcuts
        </div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {LABELS.map((label) => (
            <button
              key={label}
              disabled={busy}
              onClick={() => onReview({ label })}
              style={{
                ...actionButton,
                minWidth: 110,
                borderColor: candidate.label === label ? 'var(--neon-cool)' : 'var(--line-strong)',
                color: label === 'real' ? 'var(--neon-ok)' : label === 'wind' ? 'var(--neon-warn)' : 'var(--ink-1)',
                opacity: busy ? 0.5 : 1,
              }}
            >
              {label}
            </button>
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
  const [items, setItems] = useState<CorrelatedEventCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
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
      const result = await fetchCorrelatedEventCandidates(review, group);
      setItems(result.items);
      setTotal(result.total);
      setPending(result.pending);
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
  }, [review, group]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetchCorrelatedEventSettings().then(setSettings).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!selectedId) { setFrames(null); return; }
    let cancelled = false;
    setFrames(null);
    fetchCorrelatedEventFrames(selectedId)
      .then((data) => { if (!cancelled) setFrames(data); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const selected = items.find((item) => item.candidate_id === selectedId) ?? null;
  const reviewCandidate = useCallback(async (body: { label?: CandidateLabel | null; dismissed?: boolean }) => {
    if (!selectedId || busy) return;
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
  }, [selectedId, busy, items, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button')) return;
      const key = e.key.toLowerCase();
      if (key === 'r') void reviewCandidate({ label: 'real' });
      if (key === 'w') void reviewCandidate({ label: 'wind' });
      if (key === 'u') void reviewCandidate({ label: 'unsure' });
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
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>Correlated peaks suggest real traffic · outside-only peaks suggest wind</div>
        </div>
        <div className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-3)' }}>
          <span style={{ color: pending ? 'var(--neon-warn)' : 'var(--neon-ok)' }}>{pending}</span> PENDING
          {settings?.last_processed_at && <span> · SCANNED {formatMoment(settings.last_processed_at)}</span>}
        </div>
        <button onClick={() => setShowSettings((v) => !v)} style={{ ...actionButton, padding: '6px 10px' }}>
          {showSettings ? 'Hide parameters' : 'Parameters'}
        </button>
        <Clock />
        <UserChip />
      </header>

      {showSettings && settings && <DetectionSettingsPanel settings={settings} onSaved={setSettings} />}
      {error && <div className="mono" style={{ padding: 9, color: 'var(--neon-hot)', border: '1px solid var(--line)', borderRadius: 5 }}>{error}</div>}

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '330px minmax(0, 1fr)', gap: 12, minHeight: 0 }}>
        <Card title="REVIEW QUEUE" subtitle={`${total} matching · ${pending} pending`} padding={0}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {REVIEW_FILTERS.map((value) => <FilterButton key={value} active={review === value} onClick={() => setReview(value)}>{value}</FilterButton>)}
          </div>
          <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {GROUP_FILTERS.map((value) => <FilterButton key={value} active={group === value} onClick={() => setGroup(value)}>{value.replace('_', ' ')}</FilterButton>)}
          </div>
          {loading
            ? <div className="mono" style={{ padding: 28, textAlign: 'center', color: 'var(--ink-3)' }}>LOADING…</div>
            : <CandidateList items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        </Card>
        <Card padding={0}>
          <CandidateDetail candidate={selected} frames={frames} busy={busy} onReview={(body) => { void reviewCandidate(body); }} />
        </Card>
      </div>
    </div>
  );
}
