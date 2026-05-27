import { useState, type FormEvent } from 'react';
import { useAuth } from './auth';
import { LoginBackdrop } from './login_backdrop';

type Mode = 'login' | 'signup';

export function LoginPage() {
  const { login, signup, error } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalErr(null);
    setSubmitting(true);
    try {
      if (mode === 'login') await login(email, password);
      else await signup(email, password);
    } catch (err) {
      setLocalErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const shownErr = localErr ?? error;

  return (
    <div style={{
      position: 'relative',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-0)',
      color: 'var(--text)',
      fontFamily: 'var(--mono)',
      overflow: 'hidden',
    }}>
      <LoginBackdrop />
      <form
        onSubmit={submit}
        style={{
          position: 'relative',
          zIndex: 10,
          width: 360,
          padding: 28,
          background: 'var(--bg-1)',
          border: '1px solid var(--line-strong, rgba(255,255,255,0.18))',
          borderRadius: 8,
          boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 18, letterSpacing: 1 }}>
          urban acoustics · {mode}
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span style={{ opacity: 0.7 }}>email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            style={inputStyle}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span style={{ opacity: 0.7 }}>password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === 'signup' ? 8 : 1}
            style={inputStyle}
          />
          {mode === 'signup' && (
            <span style={{ opacity: 0.5, fontSize: 11 }}>min 8 characters</span>
          )}
        </label>

        {shownErr && (
          <div style={{
            color: 'var(--neon-hot, #ff5577)',
            fontSize: 12,
            background: 'rgba(255,80,90,0.07)',
            padding: '6px 8px',
            borderRadius: 4,
          }}>
            {shownErr}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '8px 12px',
            background: 'var(--accent, #6cf)',
            color: 'var(--bg-0)',
            border: 'none',
            borderRadius: 4,
            cursor: submitting ? 'wait' : 'pointer',
            fontFamily: 'inherit',
            fontWeight: 600,
            letterSpacing: 0.5,
          }}
        >
          {submitting ? '…' : mode === 'login' ? 'sign in' : 'create account'}
        </button>

        <button
          type="button"
          onClick={() => { setLocalErr(null); setMode(mode === 'login' ? 'signup' : 'login'); }}
          style={{
            background: 'none',
            color: 'var(--text)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            opacity: 0.7,
            padding: 4,
          }}
        >
          {mode === 'login' ? 'create an account →' : '← back to sign in'}
        </button>

        {mode === 'signup' && (
          <div style={{ fontSize: 11, opacity: 0.55, lineHeight: 1.45 }}>
            New accounts start as <strong>guest</strong> and can view a
            simulated preview of the dashboard. An admin can promote you to
            member, contributor, or admin.
          </div>
        )}
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--bg-0)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  fontFamily: 'inherit',
  fontSize: 13,
};
