/** What App Control remembers on the device between launches. Small, local, never sent. */
export interface Local {
  /** The app version of the last launch. */
  appVersion?: string | undefined;
  /** The version the app was updated to, until a later update replaces it. */
  updatedTo?: string | undefined;
  /** How many times the user pressed Update and came back on the same version. */
  updateReturns: number;
  /** The app version when Update was pressed and the user has not come back yet. */
  pressPending?: string | undefined;
  dismissedVersion?: string | undefined;
  dismissedAt: number;
  shownAnnouncements: string[];
  whatsNewShown?: string | undefined;
}

export const MAX_IDS = 20;
export const EMPTY_LOCAL: Local = { updateReturns: 0, dismissedAt: 0, shownAnnouncements: [] };

const text = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

/** The saved state, or an empty one when the text is missing or damaged. */
export function decodeLocal(raw: string | null | undefined): Local {
  try {
    const root = JSON.parse(raw ?? '') as Record<string, unknown> | null;
    if (!root || typeof root !== 'object') return EMPTY_LOCAL;
    const returns = typeof root.updateReturns === 'number' ? Math.min(1000, Math.max(0, Math.trunc(root.updateReturns))) : 0;
    return {
      appVersion: text(root.appVersion), updatedTo: text(root.updatedTo), updateReturns: Number.isFinite(returns) ? returns : 0, pressPending: text(root.pressPending),
      dismissedVersion: text(root.dismissedVersion), dismissedAt: typeof root.dismissedAt === 'number' && Number.isFinite(root.dismissedAt) ? root.dismissedAt : 0,
      shownAnnouncements: Array.isArray(root.shownAnnouncements) ? root.shownAnnouncements.filter((s): s is string => typeof s === 'string').slice(-MAX_IDS) : [],
      whatsNewShown: text(root.whatsNewShown),
    };
  } catch { return EMPTY_LOCAL; }
}

export function encodeLocal(local: Local): string {
  return JSON.stringify({ ...local, shownAnnouncements: local.shownAnnouncements.slice(-MAX_IDS) });
}
