// Prepares a CycloneDX SBOM for grype (W18-51). Plain JavaScript, no dependencies:
// it runs inside the scan image between syft and grype, and the same file is
// imported by the unit tests, so there is one implementation.
//
// WHY. syft catalogues a Swift Package Manager dependency under its SHORT name
// (`swift-nio`) and carries the repository path only in the purl
// (`pkg:swift/github.com/apple/swift-nio@2.40.0`). grype's vulnerability database
// indexes Swift packages under the FULL path (`github.com/apple/swift-nio`) and
// looks a package up by the name it is handed, so a catalogued Swift package
// matched nothing: measured on the real tools, the same package matched three
// advisories the moment its name was the purl path. The purl is the one
// authoritative identifier in the document, so the name is derived from it.
//
// This writes a COPY for grype. The original SBOM (shown to users, read by the
// malicious-package index) is left as syft wrote it.
//
// Exit codes: 0 done (even when nothing needed rewriting), 2 unreadable input or
// output that could not be written. A failure is loud on purpose: the caller
// treats it as a failed scan, because grype silently running on an
// un-normalised document would report a vulnerable repository clean.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SWIFT_PURL = /^pkg:swift\/([^@?#]+)/;

/** The percent-decoded path segments of a swift purl, or null if this is not one. */
export function swiftPurlSegments(purl) {
  if (typeof purl !== 'string') return null;
  const match = SWIFT_PURL.exec(purl);
  if (!match) return null;
  try {
    return match[1].split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * The name grype's database uses for this component, or null if it already
 * matches or is not a namespaced Swift package.
 *
 * Only a component whose name IS the purl's last segment is touched: a name
 * that differs from it was set by something else, and guessing is how an
 * advisory ends up on the wrong package.
 */
export function databaseName(component) {
  const segments = swiftPurlSegments(component?.purl);
  if (!segments || segments.length < 2) return null;
  const name = segments[segments.length - 1];
  if (component.name !== name) return null;
  return segments.join('/');
}

/** Returns how many components were rewritten; mutates the document in place. */
export function normaliseComponents(components) {
  let rewritten = 0;
  if (!Array.isArray(components)) return 0;
  for (const component of components) {
    if (component === null || typeof component !== 'object') continue;
    const full = databaseName(component);
    if (full !== null) {
      component.name = full;
      rewritten += 1;
    }
    rewritten += normaliseComponents(component.components);
  }
  return rewritten;
}

/** Pure: a parsed CycloneDX document in, the same document and a count out. */
export function normaliseSbom(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('not a CycloneDX document');
  }
  const rewritten = normaliseComponents(document.components);
  return { document, rewritten };
}

function main(argv) {
  const [input, output] = argv;
  if (!input || !output) {
    process.stderr.write('usage: sbom-normalise.mjs <sbom.json> <out.json>\n');
    return 2;
  }
  try {
    const { document } = normaliseSbom(JSON.parse(readFileSync(input, 'utf8')));
    writeFileSync(output, JSON.stringify(document));
    return 0;
  } catch (error) {
    process.stderr.write(`sbom-normalise: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
