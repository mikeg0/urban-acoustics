import { useEffect, useState, type ReactNode } from 'react';
import { applyTweaks, getDefaults, useTweaks } from './tweaks';
import { PALETTES } from './palettes';
import type { Tweaks } from './types';

function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path
        d="M10 7.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM16.2 10a6.3 6.3 0 0 0-.1-1.15l1.52-1.17a.4.4 0 0 0 .09-.5l-1.44-2.5a.4.4 0 0 0-.47-.18l-1.79.72a6.3 6.3 0 0 0-1.99-1.15L11.74 2.2a.4.4 0 0 0-.4-.34H8.66a.4.4 0 0 0-.4.34l-.28 1.87a6.3 6.3 0 0 0-1.99 1.15l-1.79-.72a.4.4 0 0 0-.47.18l-1.44 2.5a.4.4 0 0 0 .09.5l1.52 1.17A6.3 6.3 0 0 0 3.8 10c0 .39.04.77.1 1.15l-1.52 1.17a.4.4 0 0 0-.09.5l1.44 2.5c.1.18.32.25.47.18l1.79-.72c.6.47 1.27.86 1.99 1.15l.28 1.87c.03.2.2.34.4.34h2.68c.2 0 .37-.14.4-.34l.28-1.87a6.3 6.3 0 0 0 1.99-1.15l1.79.72c.16.07.38 0 .47-.18l1.44-2.5a.4.4 0 0 0-.09-.5l-1.52-1.17c.07-.38.1-.76.1-1.15z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Open settings"
      title="Settings"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: hover ? 'var(--bg-3)' : 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        color: 'var(--ink-1)',
        cursor: 'pointer',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        transition: 'background 120ms, transform 300ms',
      }}
    >
      <span style={{
        display: 'inline-flex',
        transition: 'transform 400ms cubic-bezier(.2,.8,.2,1)',
        transform: hover ? 'rotate(60deg)' : 'rotate(0deg)',
      }}>
        <GearIcon />
      </span>
      <span>Settings</span>
    </button>
  );
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tweaks = useTweaks();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const update = (partial: Partial<Tweaks>) => applyTweaks(partial);
  const resetAll = () => applyTweaks(getDefaults());

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4, 4, 6, 0.6)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '8vh',
        zIndex: 2000,
        animation: 'settings-fade 180ms ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
        style={{
          width: 520, maxWidth: '92vw',
          background: 'var(--bg-1)',
          border: '1px solid var(--line-strong)',
          borderRadius: 12,
          boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px oklch(28% 0.008 60 / 0.6)',
          overflow: 'hidden',
          animation: 'settings-pop 220ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: 'var(--ink-1)' }}><GearIcon size={18} /></span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ink-0)' }}>
                Dashboard settings
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Display · Thresholds · Detection
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--bg-2)', border: '1px solid var(--line)',
              color: 'var(--ink-2)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.25" /></svg>
          </button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 22 }}>
          <section>
            <SectionHead label="Spectrogram palette"
              hint="Heat ramp reads most intuitively; Ice emphasises sub-bass; Mono is print-safe."
              value={PALETTES[tweaks.spectroColor]?.label} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 10 }}>
              {(Object.entries(PALETTES) as [Tweaks['spectroColor'], typeof PALETTES[keyof typeof PALETTES]][]).map(([k, p]) => {
                const active = tweaks.spectroColor === k;
                return (
                  <button
                    key={k}
                    onClick={() => update({ spectroColor: k })}
                    style={{
                      padding: 0,
                      background: active ? 'var(--bg-3)' : 'var(--bg-2)',
                      border: `1px solid ${active ? 'var(--neon-focus)' : 'var(--line)'}`,
                      borderRadius: 6,
                      overflow: 'hidden',
                      cursor: 'pointer',
                      textAlign: 'left',
                      boxShadow: active ? '0 0 0 2px oklch(82% 0.18 310 / 0.25)' : 'none',
                      transition: 'all 120ms',
                    }}
                  >
                    <div style={{ height: 44, background: p.css }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px' }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-1)' }}>{p.label}</span>
                      {active && (
                        <svg width="10" height="10" viewBox="0 0 10 10">
                          <path d="M1 5 L4 8 L9 2" stroke="var(--neon-focus)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <SectionHead label="Breach threshold"
              hint="Hours at or above this level are counted as breaches across the dashboard."
              value={`${tweaks.dbThreshold} dB`} />
            <div style={{ marginTop: 12 }}>
              <input type="range" min="65" max="100" step="1"
                value={tweaks.dbThreshold}
                onChange={(e) => update({ dbThreshold: +e.target.value })}
                style={{ width: '100%' }} />
              <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-3)', marginTop: 2 }}>
                <span>65 dB · quiet street</span>
                <span>WHO · 85 dB</span>
                <span>100 dB · jackhammer</span>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                {[70, 75, 80, 85, 90].map((v) => (
                  <Preset key={v} active={tweaks.dbThreshold === v} onClick={() => update({ dbThreshold: v })}>
                    {v} dB
                  </Preset>
                ))}
              </div>
            </div>
          </section>

          <section>
            <SectionHead label="Anomaly sensitivity"
              hint="Lower z-score surfaces more events; higher is stricter."
              value={`z ≥ ${tweaks.anomalySensitivity.toFixed(1)}`} />
            <div style={{ marginTop: 12 }}>
              <input type="range" min="1.5" max="4" step="0.1"
                value={tweaks.anomalySensitivity}
                onChange={(e) => update({ anomalySensitivity: +e.target.value })}
                style={{ width: '100%' }} />
              <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-3)', marginTop: 2 }}>
                <span>loose · 1.5</span>
                <span>balanced · 2.3</span>
                <span>strict · 4.0</span>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                {[1.8, 2.3, 2.9, 3.5].map((v) => (
                  <Preset key={v} active={Math.abs(tweaks.anomalySensitivity - v) < 0.05} onClick={() => update({ anomalySensitivity: v })}>
                    z ≥ {v.toFixed(1)}
                  </Preset>
                ))}
              </div>
            </div>
          </section>
        </div>

        <div style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--bg-0)',
        }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>
            CHANGES APPLY LIVE · SAVED TO DEVICE
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={resetAll}
              style={{
                padding: '6px 12px',
                fontSize: 11, fontFamily: 'var(--mono)',
                letterSpacing: '0.1em', textTransform: 'uppercase',
                background: 'var(--bg-2)', border: '1px solid var(--line)',
                borderRadius: 6, color: 'var(--ink-2)', cursor: 'pointer',
              }}>Reset</button>
            <button onClick={onClose}
              style={{
                padding: '6px 14px',
                fontSize: 11, fontFamily: 'var(--mono)',
                letterSpacing: '0.1em', textTransform: 'uppercase',
                background: 'var(--ink-0)', border: '1px solid var(--ink-0)',
                borderRadius: 6, color: 'var(--bg-0)', cursor: 'pointer', fontWeight: 600,
              }}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHead({ label, hint, value }: { label: string; hint?: string; value: ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--ink-0)', fontWeight: 500 }}>{label}</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--neon-cool)' }}>{value}</div>
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.4 }}>{hint}</div>
      )}
    </div>
  );
}

function Preset({ children, active, onClick }: { children: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        fontSize: 10,
        fontFamily: 'var(--mono)',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        background: active ? 'var(--bg-3)' : 'var(--bg-2)',
        border: `1px solid ${active ? 'var(--line-strong)' : 'var(--line)'}`,
        borderRadius: 4,
        color: active ? 'var(--ink-0)' : 'var(--ink-2)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
