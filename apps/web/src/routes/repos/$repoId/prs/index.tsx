import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { PrListScreen } from '../../../../widgets/pr/PrList.js';

// Repo PR list. The `state` filter is a URL search param, not component state,
// so a filtered list is linkable and survives a paste (FR-WEB-2).
export const Route = createFileRoute('/repos/$repoId/prs/')({
  component: RepoPrList,
});

function RepoPrList() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const search = Route.useSearch() as Record<string, string> & { window: string; state?: string };
  const navigate = useNavigate();

  return (
    <PrListScreen
      repoId={repoId}
      window={search.window}
      search={serializeGlobalSearch(search)}
      state={search.state}
      onStateChange={(next) =>
        void navigate({
          to: '.',
          // Drop the key entirely rather than writing state=undefined — the URL
          // should read as "no filter", not carry an empty parameter.
          search: (prev: Record<string, unknown>) => {
            if (next) return { ...prev, state: next };
            // Delete the key rather than setting it undefined — the URL should
            // read as "no filter", not carry an empty parameter.
            const rest = { ...prev };
            delete rest.state;
            return rest;
          },
        } as never)
      }
    />
  );
}
