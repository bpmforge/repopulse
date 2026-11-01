import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { dataStamp, shortHash } from '../../framework/data-stamp.js';
import { getScanner } from '../../registry.js';
import { scanRulesDir } from '../../../sandbox/tooling.js';
import { DEFAULT_SCAN_IMAGE } from '../semgrep/scanner.js';
import { maliciousIndexPath } from './malicious.js';
import { DEPENDENCY_SCANNER_KEY } from './findings.js';
import { checkVulnDb, vulnDbDir } from './tools.js';

// The advisory-data stamp (W23-09, INCREMENTAL_SCAN_PLAN WP-R1).
//
// A CVE answer for an unchanged tree changes when the DATA it is matched
// against changes — so "same commit" is not "same answer" the morning after
// `deploy/scan-db-sync.sh` ran. This reads what that script left behind and
// turns it into one string both the dependency runner (stamps it) and the probe
// (recomputes it) share. Nothing here starts a container or reads the tree.
//
// WHAT IS STAMPED, and from what:
//   grype DB     `<vuln-db>/<schema>/import.json` — grype's OWN record, whose
//                `source` URL carries the build timestamp (the same field the
//                age check reads). Falls back to a digest of the file, then to
//                the database file's mtime. The grype DB is where the OSV, KEV
//                and EPSS-enriched advisories live for this product: the stamp
//                changes when any of them is refreshed.
//   malicious    the OpenSSF malicious-package index (size + mtime — the file is
//                tens of MB, and the sync swaps it by rename, so the pair
//                changes exactly when a refresh landed).
//   pkg index    the slopsquat package-name index directory (mtime), because the
//                snapshot slopsquat pass runs inside the dependency run.
// Absent malicious/package indexes stamp as `none`: the run notes their absence
// itself, and it is a stable fact until a sync creates them.
//
// Null when the grype database cannot be read: the scan would FAIL with a named
// reason, and a probe that returned a stamp there would skip past that failure.

function fileSignature(file: string): string {
  try {
    const st = statSync(file);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return 'none';
  }
}

function grypeDbStamp(dir: string): string | null {
  const check = checkVulnDb(dir);
  if (!check.ok) return null;
  const schemaDir = path.join(dir, check.schema);
  try {
    const importJson = path.join(schemaDir, 'import.json');
    if (existsSync(importJson)) {
      const raw = readFileSync(importJson, 'utf8');
      const source = (JSON.parse(raw) as { source?: string }).source ?? '';
      const built = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(source)?.[1];
      return `${check.schema}:${built ?? shortHash(raw)}`;
    }
    return `${check.schema}:mtime${Math.floor(statSync(path.join(schemaDir, 'vulnerability.db')).mtimeMs)}`;
  } catch {
    return null;
  }
}

export interface AdvisoryStampOptions {
  /** Host directory holding the grype database. Defaults to vulnDbDir(). */
  vulnDb?: string;
}

/** The advisory data a dependency scan would match against, or null when unreadable. */
export function advisoryDataStamp(opts: AdvisoryStampOptions = {}): string | null {
  const grype = grypeDbStamp(opts.vulnDb ?? vulnDbDir());
  if (grype === null) return null;
  return dataStamp({
    grype,
    malicious: fileSignature(maliciousIndexPath()),
    pkgindex: fileSignature(path.join(scanRulesDir(), 'package-index')),
  });
}

/**
 * The stamp a dependency run records and its probe recomputes: advisory data,
 * the scan image (syft/grype versions are a function of it), and the in-process
 * scanner version. Null when the advisory data is unreadable.
 */
export function dependencyDataVersion(
  opts: AdvisoryStampOptions & { image?: string } = {},
): string | null {
  const advisory = advisoryDataStamp(opts);
  if (advisory === null) return null;
  return dataStamp({
    advisory: shortHash(advisory),
    image: opts.image ?? DEFAULT_SCAN_IMAGE,
    scanner: getScanner(DEPENDENCY_SCANNER_KEY)?.version,
  });
}
