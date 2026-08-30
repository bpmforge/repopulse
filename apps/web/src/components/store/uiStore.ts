import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// Ephemeral UI state ONLY (DASHBOARD §2): rail/palette/density/lastSeenAt,
// active toasts, and the live sync-chip state fed by the SSE stream. Nothing
// here belongs in a URL — view state (filters, window, sort, cursor) lives in
// the router search params. rail/density/lastSeenAt persist to localStorage;
// toasts + sync connection state are session-only.

export type Density = 'comfortable' | 'compact';
export type Theme = 'dark' | 'light';
export type ToastTone = 'info' | 'ok' | 'warn' | 'crit';
export type SseConnection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
}

export interface RepoSyncProgress {
  phase: string;
  pct: number;
}

interface UiState {
  railCollapsed: boolean;
  toggleRail: () => void;
  setRail: (collapsed: boolean) => void;

  paletteOpen: boolean;
  setPalette: (open: boolean) => void;

  density: Density;
  setDensity: (density: Density) => void;

  /** Dark-first (FR-WEB-1); persisted and applied to <html data-theme>. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  /** ISO timestamp of the last dashboard visit — drives the attention feed. */
  lastSeenAt: string | null;
  markSeen: (iso: string) => void;

  toasts: Toast[];
  pushToasts: (toasts: Toast[]) => void;
  dismissToast: (id: string) => void;

  /**
   * The crumb only the SCREEN knows (W16-42).
   *
   * A repository's NAME is not in its URL — `/repos/34083/security` carries an
   * id — so the trail said "Org › Repos › Security" and never named the
   * repository anyone was looking at. __root's own comment has said since
   * W16-05 that "that crumb has to come from the screen that loaded it"; this
   * is the half that was never built.
   *
   * Carries the PATH it belongs to, not just a label. Without that, navigating
   * from one repo to another shows the previous repo's name until the new one
   * loads — a trail that is confidently wrong, which is worse than a trail
   * that is merely thin.
   */
  entityCrumb: { pathPrefix: string; label: string; to: string } | null;
  setEntityCrumb: (crumb: { pathPrefix: string; label: string; to: string } | null) => void;

  sseConnection: SseConnection;
  setSseConnection: (state: SseConnection) => void;
  repoProgress: Record<number, RepoSyncProgress>;
  setRepoProgress: (repoId: number, progress: RepoSyncProgress) => void;
  clearRepoProgress: (repoId: number) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      railCollapsed: false,
      toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
      setRail: (railCollapsed) => set({ railCollapsed }),

      paletteOpen: false,
      setPalette: (paletteOpen) => set({ paletteOpen }),

      density: 'comfortable',
      setDensity: (density) => set({ density }),

      theme: 'dark',
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),

      lastSeenAt: null,
      markSeen: (lastSeenAt) => set({ lastSeenAt }),

      toasts: [],
      // Batched (SSE emits arrays); cap at 5 so a burst can't bury the UI.
      pushToasts: (incoming) => set((s) => ({ toasts: [...s.toasts, ...incoming].slice(-5) })),
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

      sseConnection: 'connecting',
      entityCrumb: null,
      setEntityCrumb: (entityCrumb) => set({ entityCrumb }),

      setSseConnection: (sseConnection) => set({ sseConnection }),
      repoProgress: {},
      setRepoProgress: (repoId, progress) =>
        set((s) => ({ repoProgress: { ...s.repoProgress, [repoId]: progress } })),
      clearRepoProgress: (repoId) =>
        set((s) => {
          const next = { ...s.repoProgress };
          delete next[repoId];
          return { repoProgress: next };
        }),
    }),
    {
      name: 'repopulse-ui',
      storage: createJSONStorage(() => localStorage),
      // Only durable preferences persist — never toasts or live connection state.
      partialize: (s) => ({
        railCollapsed: s.railCollapsed,
        density: s.density,
        theme: s.theme,
        lastSeenAt: s.lastSeenAt,
      }),
    },
  ),
);
