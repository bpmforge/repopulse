import {
  dedupKey,
  priceFinding,
  type IncomingFinding,
  type PricedFinding,
} from '@repopulse/insights';
import type { DependencyMatch } from '../dependency/matches.js';
import type { ImageRef } from './refs.js';

// Image matches -> stored findings (W18-34). Pure.

export const IMAGE_SCANNER_KEY = 'container_image';

export interface PricedImageFinding {
  finding: IncomingFinding;
  pricing: PricedFinding;
  key: string;
}

export function imageFinding(
  image: ImageRef,
  match: DependencyMatch,
  suggestion: string | null,
): PricedImageFinding {
  const id = match.cveId ?? match.vulnerabilityId;
  const severity = match.kev ? Math.max(4, match.severity) : match.severity;
  const upgrade =
    match.fixVersions.length > 0
      ? `Upgrade ${match.packageName} to ${match.fixVersions.join(' or ')}, or rebuild on a base image that ships it.`
      : 'No fixed package version is published yet — the options are a different base image or removing the package.';
  const finding: IncomingFinding = {
    dimension: 'dependency',
    severity,
    confidence: match.matchType.startsWith('exact-') ? 5 : 3,
    file: image.file,
    lineStart: image.line,
    lineEnd: image.line,
    title: `${id} in ${image.ref} (${match.packageName} ${match.packageVersion})`,
    evidenceQuote: `${image.ref} contains ${match.packageName} affected by ${id}`,
    rationale:
      `The image ${image.ref}, named at ${image.file}:${image.line}, ships ${match.packageName} ` +
      `${match.packageVersion}, which matches ${id} (${match.severityLabel}` +
      `${match.kev ? ', on the CISA known-exploited list' : ''}). ` +
      'This is an OS or base-image package: whether the running container exercises it was not established. ' +
      `${upgrade}${suggestion ? ` ${suggestion}` : ''}`,
    suggestedFix: suggestion ? `${upgrade} ${suggestion}` : upgrade,
    scannerKey: IMAGE_SCANNER_KEY,
    ruleId: id,
    cveId: match.cveId,
    yields: {
      ...(match.cveId ? { [`vuln-dependency:${match.cveId}`]: true } : {}),
      ...(match.kev ? { kev: true } : {}),
      ...(match.epss !== null ? { epss: match.epss } : {}),
      image: image.ref,
      package: `${match.packageName}@${match.packageVersion}`,
      // W20-21 (UX_TODO FND-28): the fixed versions, for the "Fixed in" column.
      fixed_in: match.fixVersions,
    },
  };
  const pricing = priceFinding({
    dimension: 'dependency',
    severity,
    confidence: finding.confidence,
    epss: match.epss,
    kev: match.kev,
    depScope: null,
    reachability: 'manifest_only',
    repoScoped: false,
  });
  return {
    finding,
    pricing,
    key: dedupKey({
      dimension: finding.dimension,
      file: finding.file,
      evidenceQuote: finding.evidenceQuote,
      lineStart: finding.lineStart,
      scannerKey: IMAGE_SCANNER_KEY,
      ruleId: id,
    }),
  };
}
