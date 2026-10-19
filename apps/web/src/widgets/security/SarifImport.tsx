import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, buildUrl } from '../../api/client.js';
import { ErrorNote } from '../../components/index.js';

// Import SARIF (W20-15, UX_TODO X-09).
//
// "Pull in other tools' results" was API-only: POST
// /repos/{id}/external-findings/sarif existed and no screen could reach it.
// Admin-only, like the route. The file is read in the browser and sent as the
// request body; nothing else leaves the page.

export interface SarifImportResult {
  commit_sha: string | null;
  results: number;
  skipped: number;
  tools: {
    tool: string;
    tool_version: string | null;
    results: number;
    created: number;
    updated: number;
    reopened: number;
    auto_resolved: number;
  }[];
}

/** One line per tool: what the upload created and what it closed. */
export function importSummary(r: SarifImportResult): string[] {
  if (r.tools.length === 0) return [`No results in the file (${r.skipped} skipped).`];
  return r.tools.map(
    (t) =>
      `${t.tool}${t.tool_version ? ` ${t.tool_version}` : ''}: ${t.created} new, ${t.updated} updated, ` +
      `${t.reopened} reopened, ${t.auto_resolved} closed`,
  );
}

const SHA = /^[0-9a-f]{7,40}$/i;

function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsText(file);
  });
}

export function SarifImport({ repoId, onImported }: { repoId: string; onImported?: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [sha, setSha] = useState('');
  const [sweep, setSweep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<SarifImportResult | null>(null);
  const shaOk = sha.trim() === '' || SHA.test(sha.trim());

  const upload = async () => {
    if (!file || !shaOk) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = await readText(file);
      const url = buildUrl('/repos/{id}/external-findings/sarif', {
        path: { id: repoId },
        query: {
          ...(sha.trim() ? { commit_sha: sha.trim() } : {}),
          sweep: sweep ? 'true' : 'false',
        },
      });
      const res = await apiFetch<SarifImportResult>(url, { method: 'POST', body });
      setResult(res);
      // The Security tab and the findings lists now hold different numbers.
      await queryClient.invalidateQueries();
      onImported?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="sarif-import">
      <p className="text-xs text-fg-muted">
        Bring in another tool&apos;s results (SARIF 2.1.0, for example from CodeQL, Snyk or Trivy).
        They are marked as imported, never as RepoPulse&apos;s own findings.
      </p>
      <label className="flex flex-col gap-1 text-xs">
        SARIF file
        <input
          type="file"
          accept=".sarif,.json,application/sarif+json,application/json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          data-testid="sarif-file"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Commit the scan ran on (optional)
        <input
          type="text"
          value={sha}
          onChange={(e) => setSha(e.target.value)}
          placeholder="the file's own, else the default branch"
          className="w-80 rounded-md border border-border bg-surface px-2 py-1 font-mono"
          aria-invalid={!shaOk}
          data-testid="sarif-sha"
        />
        {!shaOk && <span className="text-crit">A commit id is 7–40 hex characters.</span>}
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={sweep}
          onChange={(e) => setSweep(e.target.checked)}
          data-testid="sarif-sweep"
        />
        Close this tool&apos;s earlier findings that are not in the file (untick when uploading one
        category at a time)
      </label>
      <div>
        <button
          type="button"
          disabled={!file || !shaOk || busy}
          onClick={() => void upload()}
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
          data-testid="sarif-upload"
        >
          {busy ? 'Importing…' : 'Import SARIF'}
        </button>
      </div>
      <ErrorNote error={error} testId="sarif-error" />
      {result && (
        <ul className="text-xs" data-testid="sarif-result">
          {importSummary(result).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
