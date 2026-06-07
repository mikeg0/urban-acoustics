import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { useTweaks } from './tweaks';
import { formatClock } from './utils';

// Live wall-clock chip — ticks once a second and renders in the user's
// configured 12/24h format. Shared between the dashboard top bar and the
// station-network session panel.
export function Clock() {
  const [t, setT] = useState(() => new Date());
  const { timeFormat } = useTweaks();
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-1)', padding: '6px 10px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 6 }}>
      {formatClock(t.getTime() / 1000, timeFormat, { withSeconds: true })}
    </div>
  );
}

// Signed-in identity + one-click sign-out. Renders nothing when there is no
// session. Shared between the dashboard top bar and the station-network
// session panel.
export function UserChip() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div
      className="mono"
      title={`Sign out ${user.email}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
        color: 'var(--ink-1)',
        padding: '6px 10px',
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
      }}
    >
      <span style={{ opacity: 0.7 }}>{user.email}</span>
      <span style={{
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--neon-cool, #6cf)',
        fontSize: 9,
      }}>{user.role}</span>
      <button
        onClick={() => { void logout(); }}
        style={{
          background: 'transparent',
          color: 'var(--ink-3)',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 11,
        }}
      >
        ⏻
      </button>
    </div>
  );
}
