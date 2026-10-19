import { REACHABILITY_LABEL, type Finding } from './contracts.js';

// "Why this applies" for a dependency CVE (W20-08, UX_TODO FND-57).
//
// The scanner works out whether the package is reached, where it is called,
// how it is used, its scope and EPSS — and the panel showed only "pkg@ver is
// affected by CVE-X" and the upgrade advice. Deciding "real, or not
// affected?" needs exactly what was left out, so it is laid out here, with
// the scanner's own explaining sentence. Each line is shown only when the
// scanner recorded it; nothing is inferred on this side.

export function DependencyWhy({ finding }: { finding: Finding }) {
  const dep = finding.dependency;
  if (!dep && !finding.rationale) return null;
  const tier = dep?.reachability ?? null;
  return (
    <div data-testid="dependency-why">
      <h3 className="text-xs tracking-wide text-fg-muted uppercase">Why this applies</h3>
      {finding.rationale && (
        <p className="mt-1 text-sm" data-testid="finding-rationale">
          {finding.rationale}
        </p>
      )}
      {dep && (
        <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
          {tier && (
            <>
              <dt className="text-fg-muted">Reachability</dt>
              <dd data-testid="dependency-reachability">
                {tier.replace(/_/g, ' ')}
                {REACHABILITY_LABEL[tier] ? ` — ${REACHABILITY_LABEL[tier]}` : ''}
              </dd>
            </>
          )}
          {dep.scope && (
            <>
              <dt className="text-fg-muted">Scope</dt>
              <dd data-testid="dependency-scope">
                {dep.scope.kind}
                {dep.scope.depth !== null
                  ? dep.scope.depth <= 1
                    ? ', direct'
                    : `, transitive (depth ${dep.scope.depth})`
                  : ''}
              </dd>
            </>
          )}
          {dep.epss !== null && (
            <>
              <dt className="text-fg-muted">EPSS</dt>
              <dd data-testid="dependency-epss">
                {(dep.epss * 100).toFixed(2)}% chance of exploitation in the next 30 days
              </dd>
            </>
          )}
          {finding.kev && (
            <>
              <dt className="text-fg-muted">Known exploited</dt>
              <dd>Yes, on the CISA KEV list</dd>
            </>
          )}
          {dep.aliases.length > 0 && (
            <>
              <dt className="text-fg-muted">Also known as</dt>
              <dd className="font-mono" data-testid="dependency-aliases">
                {dep.aliases.join(', ')}
              </dd>
            </>
          )}
        </dl>
      )}
      {dep && dep.call_sites.length > 0 && (
        <div className="mt-1 text-xs">
          <p className="text-fg-muted">Call sites</p>
          <ul className="font-mono" data-testid="dependency-call-sites">
            {dep.call_sites.map((c, i) => (
              <li key={i}>
                {c.file}
                {c.line !== null ? `:${c.line}` : ''}
                {c.symbol ? ` — ${c.symbol}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dep && dep.usage_evidence.length > 0 && (
        <div className="mt-1 text-xs">
          <p className="text-fg-muted">Where it is imported</p>
          <ul className="font-mono" data-testid="dependency-usage">
            {dep.usage_evidence.map((u, i) => (
              <li key={i}>
                {u.file}
                {u.line !== null ? `:${u.line}` : ''}
                {u.quote ? ` — ${u.quote}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
