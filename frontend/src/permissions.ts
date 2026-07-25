// Permission identifiers — must match backend/app/auth/permissions.py
// character-for-character. Endpoint guards on the backend check
// permissions, never role strings; UI gates do the same.

export const PERM = {
  DASHBOARD_PREVIEW: 'dashboard.preview',
  DASHBOARD_VIEW: 'dashboard.view',
  LIVE_REALTIME: 'live.realtime',
  EVENT_LABEL_WRITE: 'event.label.write',
  EVENT_DELETE: 'event.delete',
  DEVICE_CONFIG_WRITE: 'device.config.write',
  DEVICE_REGISTER: 'device.register',
  USER_MANAGE: 'user.manage',
  EVENT_CANDIDATE_MANAGE: 'event.candidate.manage',
} as const;

export type Permission = (typeof PERM)[keyof typeof PERM];

export type Role = 'guest' | 'member' | 'contributor' | 'admin';

// Mirror of ROLE_PERMISSIONS on the backend. Kept here for client-side
// gating only — the server is still the source of truth.
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  guest: new Set<Permission>([PERM.DASHBOARD_PREVIEW]),
  member: new Set<Permission>([PERM.DASHBOARD_VIEW, PERM.LIVE_REALTIME]),
  contributor: new Set<Permission>([
    PERM.DASHBOARD_VIEW,
    PERM.LIVE_REALTIME,
    PERM.EVENT_LABEL_WRITE,
    PERM.EVENT_DELETE,
  ]),
  admin: new Set<Permission>([
    PERM.DASHBOARD_VIEW,
    PERM.LIVE_REALTIME,
    PERM.EVENT_LABEL_WRITE,
    PERM.EVENT_DELETE,
    PERM.DEVICE_CONFIG_WRITE,
    PERM.DEVICE_REGISTER,
    PERM.USER_MANAGE,
    PERM.EVENT_CANDIDATE_MANAGE,
  ]),
};

export function hasPermission(role: Role | null, perm: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}
