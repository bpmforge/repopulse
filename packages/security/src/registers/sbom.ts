// Reading a CycloneDX document (W10-02, FR-REG-2/4).
//
// The SBOM is an INPUT here, never a thing this package produces: generating
// it is W8-06's job and W8-06 is blocked for missing syft. What that means in
// practice is that these registers are correct and tested but will find no
// components until a producer exists — stated in the ticket notes rather than
// papered over with a lockfile parser, which would be reimplementing syft
// under a different name.

import type { Ecosystem } from '../sync/release-meta.js';

export type { Ecosystem };

export interface SbomComponent {
  ecosystem: Ecosystem;
  name: string;
  version: string | null;
  /** SPDX id or expression as the document states it; null when it says nothing. */
  license: string | null;
  /** Dev-only dependency, per CycloneDX scope/properties. */
  dev: boolean;
  /** bom-ref, for walking the dependency graph. */
  ref: string | null;
}

export interface ResolvedComponent extends SbomComponent {
  /** 'prod-direct' | 'prod-transitive' | 'dev' — the D12 exposure input. */
  scope: 'prod-direct' | 'prod-transitive' | 'dev';
  /** Hops from the root component; 1 for a direct dependency. */
  depth: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * purl -> ecosystem, name and version. Only syncable ecosystems are admitted.
 *
 * The VERSION is read here as well as from the component field because the two
 * are allowed to differ in emphasis and a document may carry only the purl.
 * Without it a component's version silently becomes null, and every signal
 * that needs it — major lag, libyear — goes quiet without saying why.
 */
export function parsePurl(
  purl: string,
): { ecosystem: Ecosystem; name: string; version: string | null } | null {
  const match = /^pkg:(npm|pypi)\/([^@?#]+)(?:@([^?#]+))?/.exec(purl);
  if (!match) return null;
  return {
    ecosystem: match[1] as Ecosystem,
    name: decodeURIComponent(match[2]!),
    version: match[3] ? decodeURIComponent(match[3]) : null,
  };
}

/** SPDX string out of a CycloneDX licenses[] entry, which has two shapes. */
function licenseOf(component: Record<string, unknown>): string | null {
  for (const entry of asArray(component['licenses'])) {
    const record = asRecord(entry);
    const expression = asString(record['expression']);
    if (expression) return expression;
    const license = asRecord(record['license']);
    const id = asString(license['id']) ?? asString(license['name']);
    if (id) return id;
  }
  return null;
}

/**
 * Dev-ness, from the two places real generators put it.
 *
 * `scope: 'excluded'` is the CycloneDX-native answer; the
 * `cdx:npm:package:development` property is what the npm generators actually
 * emit. Reading only one of them mislabels half the ecosystem as production.
 */
function isDev(component: Record<string, unknown>): boolean {
  if (asString(component['scope']) === 'excluded') return true;
  return asArray(component['properties']).some((entry) => {
    const property = asRecord(entry);
    const name = asString(property['name']) ?? '';
    return (
      /development$/i.test(name) &&
      (property['value'] === true || asString(property['value']) === 'true')
    );
  });
}

export function readComponents(document: Record<string, unknown>): SbomComponent[] {
  return asArray(document['components']).flatMap((entry) => {
    const component = asRecord(entry);
    const purl = asString(component['purl']);
    const parsed = purl ? parsePurl(purl) : null;
    if (!parsed) return [];
    return [
      {
        ecosystem: parsed.ecosystem,
        name: parsed.name,
        version: asString(component['version']) ?? parsed.version,
        license: licenseOf(component),
        dev: isDev(component),
        ref: asString(component['bom-ref']),
      },
    ];
  });
}

/**
 * Walks the `dependencies` graph to a depth per component.
 *
 * A flat component list cannot tell a direct dependency from one six levels
 * down, and the D12 exposure factors ramp on exactly that. When the document
 * carries no graph — a legal CycloneDX document — everything prod is treated
 * as PROD-DIRECT: over-stating exposure keeps a finding visible, where
 * under-stating it would quietly bury one, and the honest default is the one
 * that fails loudly.
 */
export function resolveScopes(document: Record<string, unknown>): ResolvedComponent[] {
  const components = readComponents(document);
  const graph = asArray(document['dependencies']);
  const rootRef = asString(asRecord(asRecord(document['metadata'])['component'])['bom-ref']);

  const edges = new Map<string, string[]>();
  for (const entry of graph) {
    const node = asRecord(entry);
    const ref = asString(node['ref']);
    if (!ref) continue;
    edges.set(
      ref,
      asArray(node['dependsOn']).flatMap((d) => (asString(d) ? [asString(d)!] : [])),
    );
  }

  const depthByRef = new Map<string, number>();
  if (rootRef && edges.size > 0) {
    const queue: { ref: string; depth: number }[] = [{ ref: rootRef, depth: 0 }];
    while (queue.length > 0) {
      const { ref, depth } = queue.shift()!;
      for (const child of edges.get(ref) ?? []) {
        const known = depthByRef.get(child);
        if (known !== undefined && known <= depth + 1) continue;
        depthByRef.set(child, depth + 1);
        queue.push({ ref: child, depth: depth + 1 });
      }
    }
  }

  return components.map((component) => {
    const depth = component.ref ? (depthByRef.get(component.ref) ?? 1) : 1;
    return {
      ...component,
      depth,
      scope: component.dev ? 'dev' : depth <= 1 ? 'prod-direct' : 'prod-transitive',
    };
  });
}
