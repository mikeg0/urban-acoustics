import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { hasPermission, type Permission, type Role } from './permissions';

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
    const r = await authFetch<CurrentUser>('/api/v1/auth/me');
    if (r.ok) {
      setUser(r.data);
    } else {
      setUser(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
