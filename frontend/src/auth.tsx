import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { SESSION_EXPIRED_EVENT } from './api';
import { hasPermission, type Permission, type Role } from './permissions';

// The backend re-issues the session cookie on any authenticated request once
// it's past half its TTL (sliding session). Data pollers usually provide that
// traffic, but views without polling would silently let the cookie lapse —
// this ping guarantees a fresh cookie while a logged-in tab stays open. Must
// be well under half of JWT_TTL_SECONDS (default 3600s → half is 30 min).
const SESSION_KEEPALIVE_MS = 4 * 60_000;

export interface CurrentUser {
  user_id: string;
  email: string;
  role: Role;
  permissions: string[];
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function authFetch<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  const r = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    let message = `${url} → ${r.status}`;
    try {
      const j = await r.json();
      if (j?.detail) message = typeof j.detail === 'string' ? j.detail : message;
    } catch {
      /* body not JSON */
    }
    return { ok: false, status: r.status, message };
  }
  if (r.status === 204) return { ok: true, data: undefined as unknown as T };
  return { ok: true, data: (await r.json()) as T };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await authFetch<CurrentUser>('/api/v1/auth/me');
      if (r.ok) {
        setUser(r.data);
      } else if (r.status === 401 || r.status === 403) {
        setUser(null);
      }
      // Other statuses (proxy 502 while the backend hot-reloads, transient
      // 5xx) keep the current session state — only a real auth failure
      // should bounce the user to the login page.
    } catch {
      // Network blip — keep the current session state.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Any data fetch that 401s fires SESSION_EXPIRED_EVENT (see api.ts).
  // Re-check the session: a dead one resolves to user=null, which routes
  // the app to <LoginPage/>. The inFlight guard collapses the burst of
  // events a page full of simultaneous pollers produces.
  useEffect(() => {
    let inFlight = false;
    const onExpired = () => {
      if (inFlight) return;
      inFlight = true;
      void refresh().finally(() => {
        inFlight = false;
      });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [refresh]);

  // While logged in, ping /auth/me so the backend's sliding session keeps
  // re-issuing the cookie even on views with no data polling, plus once
  // immediately when a hidden tab becomes visible again (background tabs
  // get their timers throttled, so the interval alone can't be trusted).
  const loggedIn = user !== null;
  useEffect(() => {
    if (!loggedIn) return;
    const id = window.setInterval(() => void refresh(), SESSION_KEEPALIVE_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loggedIn, refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    const r = await authFetch<CurrentUser>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      setError(r.message);
      throw new Error(r.message);
    }
    setUser(r.data);
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    setError(null);
    const r = await authFetch<CurrentUser>('/api/v1/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      setError(r.message);
      throw new Error(r.message);
    }
    setUser(r.data);
  }, []);

  const logout = useCallback(async () => {
    await authFetch<void>('/api/v1/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, error, login, signup, logout, refresh }),
    [user, loading, error, login, signup, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

export function useHasPermission(perm: Permission): boolean {
  const { user } = useAuth();
  return hasPermission(user?.role ?? null, perm);
}
