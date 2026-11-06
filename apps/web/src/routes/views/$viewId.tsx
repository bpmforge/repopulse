import { useState } from 'react';
import { ErrorNote } from '../../components/primitives/ErrorNote.js';
import { Link, createFileRoute, useBlocker, useNavigate } from '@tanstack/react-router';
import { WidgetFrame, WidgetGrid, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { Widget } from '../../components/widget/types.js';
import {
  fromWidgets,
  isFindingsView,
  isRepoSetView,
  scopeLabel,
  scopeWidgets,
  toWidgets,
  type ViewConfig,
  type ViewResponse,
  type ViewWindow,
} from '../../views/contracts.js';
import { ViewEditor } from '../../views/ViewEditor.js';

// One saved view (W5-02, UX_SPEC §4.g). The SAME WidgetGrid the Org Overview
// uses — views differ from built-in screens by config, not code (DASHBOARD §4).

export const Route = createFileRoute('/views/$viewId')({ component: ViewDetailRoute });

function ViewDetailRoute() {
  const { viewId } = Route.useParams();
  // KEYED ON THE VIEW (W20-05, UX_TODO DSH-93). TanStack Router keeps this
  // component mounted when only `$viewId` changes, so opening a second view
  // from the command palette showed the new NAME over the old view's draft —
  // and Edit → Save then wrote the first view's layout over the second. A new
  // key is a new component: no draft or edit flag can cross between views.
  return <ViewDetail key={viewId} viewId={viewId} />;
}

const BUTTON =
  'panel-inset px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
const PRIMARY =
  'rounded-md btn-primary px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
const DANGER =
  'rounded-md border border-crit/40 px-3 py-1.5 text-sm text-crit hover:border-crit focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';

const WINDOWS: ViewWindow[] = ['7d', '14d', '30d', '90d', '365d'];

/** Everything the editor can change, as one value (W20-05, DSH-05/06). */
interface Draft {
  name: string;
  window: ViewWindow;
  repoIds: number[];
  widgets: Widget[];
}

function draftOf(view: ViewResponse): Draft {
  return {
    name: view.name,
    window: view.config.window,
    repoIds: view.config.repo_ids,
    widgets: toWidgets(view.config),
  };
}

/** Compared as stored, so a no-op edit is not "unsaved changes". */
function sameDraft(a: Draft, b: Draft): boolean {
  const stored = (d: Draft) =>
    JSON.stringify([d.name.trim(), d.window, [...d.repoIds].sort(), fromWidgets(d.widgets)]);
  return stored(a) === stored(b);
}

type Confirming = 'reset-link' | 'stop-sharing' | 'delete' | null;

export function ViewDetail({ viewId }: { viewId: string }) {
  const navigate = useNavigate();
  const descriptor = { endpoint: '/views/{id}', path: { id: viewId } } as const;
  const LIST = queryKeyFor({ endpoint: '/views' });
  const { data, isLoading, isError, error, refetch } = useApiQuery<ViewResponse>(descriptor);
  // Names for the scope line and the scope editor's repository list.
  const { data: repoList } = useApiQuery<{ items: { id: number; org: string; name: string }[] }>({
    endpoint: '/repos',
    query: { window: data?.config.window ?? '30d' },
  });
  const repos = repoList?.items ?? [];
  const repoNames = Object.fromEntries(repos.map((r) => [r.id, `${r.org}/${r.name}`]));

  // W20-05 (UX_TODO DSH-05). The draft exists ONLY while editing, and Save or
  // Cancel are the only ways out. "Done" used to leave edit mode with the draft
  // still on the grid, looking saved, and a reload then lost it.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const editing = draft !== null;
  const dirty = draft !== null && data !== undefined && !sameDraft(draft, draftOf(data));

  // Leaving with unsaved changes asks first — a route change inside the app
  // and a reload or tab close alike.
  useBlocker({
    shouldBlockFn: () => !window.confirm('Leave this view? Your unsaved changes will be lost.'),
    disabled: !dirty,
    enableBeforeUnload: dirty,
  });

  // W20-16 (UX_TODO DSH-66): every mutation is owner-only, so a colleague
  // opening a shared view gets "Duplicate to my views" instead of buttons that
  // answer 403. An older API without the flag is treated as the owner's.
  const isOwner = data?.is_owner !== false;
  const findingsView = data ? isFindingsView(data.config) : false;
  // W20-23 (UX_TODO X-06): a repository set is applied from the topbar; here
  // it is only named, re-picked or deleted. Per user (W20_DECISIONS_2 row 6),
  // so it offers no Share, and no Set as home: it has nothing to show as one.
  const repoSetView = data ? isRepoSetView(data.config) : false;
  const duplicate = useApiMutation<{ name: string; config: ViewConfig }, ViewResponse>(
    { endpoint: '/views', method: 'POST' },
    { invalidate: [LIST] },
  );

  const save = useApiMutation<{ name: string; config: ViewConfig }, ViewResponse>(
    { ...descriptor, method: 'PATCH' },
    { invalidate: [queryKeyFor(descriptor), LIST] },
  );
  const share = useApiMutation<Record<string, never>, { share_slug: string }>(
    { endpoint: '/views/{id}/share', path: { id: viewId }, method: 'POST' },
    { invalidate: [queryKeyFor(descriptor), LIST] },
  );
  // W20-05 (UX_TODO DSH-04): stop sharing, which the UI had no way to do.
  const unshare = useApiMutation<void, unknown>(
    { endpoint: '/views/{id}/share', path: { id: viewId }, method: 'DELETE' },
    { invalidate: [queryKeyFor(descriptor), LIST] },
  );
  const remove = useApiMutation<void, unknown>(
    { ...descriptor, method: 'DELETE' },
    { invalidate: [LIST] },
  );
  const setHome = useApiMutation<{ view_id: number }, unknown>(
    // PUT, matching the API (W20-01): this was POST, which the API does not
    // route, so Set as home 404'd and changed nothing.
    { endpoint: '/me/default-view', method: 'PUT' },
    { invalidate: [queryKeyFor(descriptor), LIST, queryKeyFor({ endpoint: '/me/context' })] },
  );
  // The way back from a home view (DSH-03), now that a home is honoured.
  const clearHome = useApiMutation<void, unknown>(
    { endpoint: '/me/default-view', method: 'DELETE' },
    { invalidate: [queryKeyFor(descriptor), LIST, queryKeyFor({ endpoint: '/me/context' })] },
  );

  // What the grid draws: the draft while editing (a preview, marked as such),
  // otherwise the saved view. Either way under ITS OWN scope (DSH-02).
  const shown: Draft | null = draft ?? (data ? draftOf(data) : null);
  const widgets = shown ? scopeWidgets(shown.widgets, shown.window, shown.repoIds) : [];

  const patchDraft = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const commit = () => {
    if (!draft || !data || draft.name.trim().length === 0) return;
    save.mutate(
      {
        name: draft.name.trim(),
        config: {
          repo_ids: draft.repoIds,
          window: draft.window,
          layout: fromWidgets(draft.widgets),
          // A Findings view keeps what it opens (W20-16, FND-03).
          ...(data.config.target ? { target: data.config.target } : {}),
          ...(data.config.search ? { search: data.config.search } : {}),
        },
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="view-detail">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold" data-testid="view-name">
            {data?.name ?? 'View'}
          </h1>
          {shown && !repoSetView && (
            <p className="text-xs text-fg-muted" data-testid="view-scope">
              {scopeLabel(shown.window, shown.repoIds, repoNames)}
            </p>
          )}
          {/* W20-09 (UX_TODO DSH-02): every tile now follows the view's
              repositories. What a set cannot have is said, not hidden: KPI
              sparklines are per-series, so a multi-repository view shows the
              values and deltas without the line. */}
          {shown && !repoSetView && shown.repoIds.length > 1 && (
            <p className="text-xs text-fg-faint" data-testid="view-scope-note">
              Every tile follows this scope. KPI tiles show values and changes without sparklines,
              which exist per repository and for the whole workspace only.
            </p>
          )}
        </div>

        {editing ? (
          <>
            {dirty && (
              <span className="text-xs text-warn" data-testid="unsaved-marker" role="status">
                ● Unsaved changes
              </span>
            )}
            <button
              type="button"
              className={PRIMARY}
              data-testid="save-layout"
              disabled={
                save.isPending ||
                !data ||
                draft.name.trim().length === 0 ||
                (repoSetView && draft.repoIds.length === 0)
              }
              onClick={commit}
            >
              Save
            </button>
            <button
              type="button"
              className={BUTTON}
              data-testid="cancel-edit"
              disabled={save.isPending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </>
        ) : !isOwner ? (
          <>
            <span className="text-xs text-fg-muted" data-testid="view-not-owner">
              Shared with you — only its owner can change it.
            </span>
            <button
              type="button"
              className={BUTTON}
              data-testid="duplicate-view"
              disabled={duplicate.isPending || !data}
              onClick={() =>
                data &&
                duplicate.mutate(
                  { name: `${data.name} (copy)`, config: data.config },
                  {
                    onSuccess: (view) =>
                      void navigate({
                        to: '/views/$viewId',
                        params: { viewId: String(view.id) },
                      }),
                  },
                )
              }
            >
              Duplicate to my views
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={BUTTON}
              data-testid="toggle-edit"
              disabled={!data}
              onClick={() => {
                if (data) setDraft(draftOf(data));
                setConfirming(null);
              }}
            >
              Edit
            </button>
            {repoSetView ? null : data?.is_default ? (
              <>
                <span className="text-sm text-fg-muted" data-testid="home-label">
                  ★ Home
                </span>
                <button
                  type="button"
                  className={BUTTON}
                  data-testid="clear-home"
                  disabled={clearHome.isPending}
                  onClick={() => clearHome.mutate()}
                >
                  Clear home
                </button>
              </>
            ) : (
              <button
                type="button"
                className={BUTTON}
                data-testid="set-as-home"
                disabled={setHome.isPending || !data}
                onClick={() => data && setHome.mutate({ view_id: data.id })}
              >
                Set as home
              </button>
            )}
            {/* Share once; after that the link is copied, reset or revoked —
                never silently replaced (DSH-04). */}
            {!data?.share_slug && !repoSetView && (
              <button
                type="button"
                className={BUTTON}
                data-testid="share-view"
                disabled={share.isPending || !data}
                onClick={() => share.mutate({})}
              >
                Share
              </button>
            )}
            <button
              type="button"
              className={DANGER}
              data-testid="delete-view"
              disabled={!data}
              onClick={() => setConfirming('delete')}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {data?.share_slug && !editing && (
        <div className="flex flex-wrap items-center gap-2">
          <ShareLink slug={data.share_slug} />
          <button
            type="button"
            className="panel-inset px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="share-reset"
            onClick={() => setConfirming('reset-link')}
          >
            Reset link
          </button>
          <button
            type="button"
            className="panel-inset px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="share-stop"
            onClick={() => setConfirming('stop-sharing')}
          >
            Stop sharing
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmStrip
          kind={confirming}
          pending={share.isPending || unshare.isPending || remove.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const done = { onSuccess: () => setConfirming(null) };
            if (confirming === 'reset-link') share.mutate({}, done);
            else if (confirming === 'stop-sharing') unshare.mutate(undefined, done);
            else
              remove.mutate(undefined, {
                onSuccess: () => void navigate({ to: '/views' }),
              });
          }}
        />
      )}

      <ErrorNote
        error={
          share.error ??
          unshare.error ??
          remove.error ??
          setHome.error ??
          clearHome.error ??
          duplicate.error ??
          save.error
        }
        testId="view-action-error"
      />

      {draft && (
        <>
          <ScopeEditor
            draft={draft}
            repos={repos}
            nameOnly={findingsView}
            windowless={repoSetView}
            onName={(name) => patchDraft({ name })}
            onWindow={(window) => patchDraft({ window })}
            onRepos={(repoIds) => patchDraft({ repoIds })}
          />
          {!findingsView && !repoSetView && (
            <ViewEditor
              widgets={draft.widgets}
              repos={repos}
              onChange={(next) => patchDraft({ widgets: next })}
            />
          )}
        </>
      )}

      {data && repoSetView ? (
        <RepoSetPanel repoIds={data.config.repo_ids} names={repoNames} />
      ) : data && findingsView ? (
        <FindingsViewPanel search={data.config.search ?? {}} />
      ) : (
        <WidgetFrame
          title={dirty ? 'Layout — preview, not saved' : 'Layout'}
          state={frameState({
            isLoading,
            isError,
            isEmpty: data !== undefined && widgets.length === 0,
          })}
          {...(error ? { errorMessage: error.message, error } : {})}
          onRetry={() => void refetch()}
          emptyMessage="This view has no widgets yet — use Edit to add some."
        >
          <WidgetGrid
            widgets={widgets}
            {...(isOwner && data
              ? {
                  // Opens the editor without it: the removal is a draft the
                  // owner saves (or cancels), never an instant change.
                  onRemoveUnknown: (id: string) => {
                    const base = draft ?? draftOf(data);
                    setDraft({ ...base, widgets: base.widgets.filter((w) => w.id !== id) });
                  },
                }
              : {})}
          />
        </WidgetFrame>
      )}
    </div>
  );
}

/** Plain words for a Findings view's stored filters (W20-16, FND-03). */
const FILTER_WORDS: Record<string, string> = {
  dimension: 'Kind',
  status: 'Status',
  severity_min: 'Severity at least',
  verify_status: 'Verification',
  scanner_key: 'Scanner',
  in_chain: 'In an attack chain',
  rule_id: 'Rule',
  experimental: 'Rules in trial',
  sort: 'Sorted by',
  q: 'Search',
  kev: 'Known exploited only',
  risk_band: 'Risk band',
  cve_id: 'CVE',
  confidence_min: 'Confidence at least',
  chain_id: 'Attack chain',
  repos: 'Repositories',
};

/**
 * A Findings view has no widgets: it is a set of explorer filters. Its page
 * says which, and opens the explorer with them.
 */
export function FindingsViewPanel({
  search,
}: {
  search: Record<string, string | number | boolean>;
}) {
  const entries = Object.entries(search);
  return (
    <WidgetFrame title="Findings filters" state="ready">
      <div className="flex flex-col gap-2 text-sm" data-testid="findings-view-panel">
        {entries.length === 0 ? (
          <p className="text-fg-muted">
            No filters: the explorer&rsquo;s default list (findings still to fix).
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="findings-view-filters">
            {entries.map(([key, value]) => (
              <li key={key}>
                <span className="text-fg-muted">{FILTER_WORDS[key] ?? key}:</span>{' '}
                {value === true ? 'yes' : String(value)}
              </li>
            ))}
          </ul>
        )}
        <Link
          to="/findings"
          search={search as never}
          className="self-start rounded-md btn-primary px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="open-findings-view"
        >
          Open in Findings
        </Link>
      </div>
    </WidgetFrame>
  );
}

/**
 * A saved repository set (W20-23, UX_TODO X-06): which repositories it holds,
 * and the way to apply it. The topbar's Repositories filter applies it too.
 */
export function RepoSetPanel({
  repoIds,
  names,
}: {
  repoIds: number[];
  names: Record<number, string>;
}) {
  return (
    <WidgetFrame title="Repository set" state="ready">
      <div className="flex flex-col gap-2 text-sm" data-testid="repo-set-panel">
        <p className="text-fg-muted">
          Pick it from the Repositories filter at the top of any screen to narrow that screen to
          these repositories.
        </p>
        <ul className="flex flex-col gap-0.5" data-testid="repo-set-repos">
          {repoIds.map((id) => (
            <li key={id}>{names[id] ?? `repository ${id} (no longer tracked)`}</li>
          ))}
        </ul>
        {/* Repositories honours ?repos=; Overview does not (filterScope.ts). */}
        <Link
          to="/repos"
          search={{ repos: repoIds.join(',') } as never}
          className="self-start rounded-md btn-primary px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="open-repo-set"
        >
          Open Repositories narrowed to this set
        </Link>
      </div>
    </WidgetFrame>
  );
}

const CONFIRM_COPY: Record<NonNullable<Confirming>, { text: string; action: string }> = {
  'reset-link': {
    text: 'Make a new link? The link you already sent will stop working, and you will need to send the new one.',
    action: 'Reset link',
  },
  'stop-sharing': {
    text: 'Stop sharing? The link you sent will stop working for everyone.',
    action: 'Stop sharing',
  },
  delete: {
    text: 'Delete this view? This cannot be undone, and any share link to it stops working.',
    action: 'Delete view',
  },
};

/** An inline confirm for the actions that break something already sent. */
function ConfirmStrip({
  kind,
  pending,
  onConfirm,
  onCancel,
}: {
  kind: NonNullable<Confirming>;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = CONFIRM_COPY[kind];
  return (
    <div
      className="flex flex-wrap items-center gap-2 panel-inset px-3 py-2 text-sm"
      role="alertdialog"
      aria-label={copy.action}
      data-testid={`confirm-${kind}`}
    >
      <span className="min-w-0 flex-1">{copy.text}</span>
      <button
        type="button"
        className={DANGER}
        data-testid="confirm-yes"
        disabled={pending}
        onClick={onConfirm}
      >
        {copy.action}
      </button>
      <button type="button" className={BUTTON} data-testid="confirm-no" onClick={onCancel}>
        Keep it
      </button>
    </div>
  );
}

/**
 * Name, window and repositories (W20-05, UX_TODO DSH-06). The API has taken
 * PATCH name/config since W5-01; the UI could only change the layout.
 */
function ScopeEditor({
  draft,
  repos,
  nameOnly = false,
  windowless = false,
  onName,
  onWindow,
  onRepos,
}: {
  draft: Draft;
  repos: { id: number; org: string; name: string }[];
  /** A Findings view: its filters are its scope, so only the name is editable here. */
  nameOnly?: boolean;
  /** A repository set (W20-23): name and repositories, no window. */
  windowless?: boolean;
  onName: (name: string) => void;
  onWindow: (window: ViewWindow) => void;
  onRepos: (repoIds: number[]) => void;
}) {
  const selected = new Set(draft.repoIds);
  return (
    <div className="flex flex-col gap-3 panel px-3 py-3" data-testid="scope-editor">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Name
          <input
            type="text"
            className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-sm text-fg"
            data-testid="view-name-input"
            value={draft.name}
            maxLength={200}
            onChange={(e) => onName(e.target.value)}
          />
        </label>
        {!nameOnly && !windowless && (
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Window
            <select
              className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-sm text-fg"
              data-testid="view-window"
              value={draft.window}
              onChange={(e) => onWindow(e.target.value as ViewWindow)}
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!nameOnly && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs text-fg-muted">
            Repositories{' '}
            {draft.repoIds.length > 0
              ? ''
              : windowless
                ? '(tick at least one)'
                : '(none ticked = every repository)'}
          </legend>
          <div className="max-h-40 overflow-y-auto" data-testid="view-repos">
            {repos.map((r) => (
              <label key={r.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid={`view-repo-${r.id}`}
                  checked={selected.has(r.id)}
                  onChange={(e) =>
                    onRepos(
                      e.target.checked
                        ? [...draft.repoIds, r.id]
                        : draft.repoIds.filter((id) => id !== r.id),
                    )
                  }
                />
                {r.org}/{r.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/**
 * The share link as something a person can actually send (W20-01, UX_TODO
 * DSH-01): the full address, not a bare path, and a Copy button.
 */
export function ShareLink({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/views/shared/${slug}`;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-fg-muted"
      data-testid="share-slug"
    >
      <span>Anyone signed in to this workspace can open this view:</span>
      <code className="select-all break-all" data-testid="share-url">
        {url}
      </code>
      <button
        type="button"
        className="panel-inset px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="share-copy"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}
