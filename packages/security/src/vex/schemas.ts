import { readFileSync } from 'node:fs';
import type { SchemaRegistry } from './jsonschema.js';

// The vendored published schemas, and where each one came from (W8-14).
//
// VENDORED RATHER THAN FETCHED, for the same reason the grype database is
// mounted rather than downloaded: a test that reaches the network is a test
// that fails when the network does, and a schema that can change under us
// turns "the export is valid" into a statement about today's internet. Each
// file below is the published document byte for byte — the sha256 recorded
// beside it is how a reviewer confirms that, and how a refresh becomes a
// visible diff rather than a silent one.
//
// Fetched 2026-08-20. Re-verify with, from the repository root:
//   shasum -a 256 packages/security/src/vex/schemas/*.json
//
// bom-1.7.schema.json is the version SYFT ACTUALLY EMITS — the fixture SBOMs
// captured in W8-06/W8-13 declare `"specVersion": "1.7"`, so validating the
// embedded-VEX export against 1.6 would be checking a document we never
// produce. It is not self-contained: it $refs three sibling files, all of them
// vendored here because a $ref that cannot resolve throws in this evaluator
// rather than being skipped.

interface VendoredSchema {
  /** Filename, which is also the key CycloneDX's cross-file `$ref`s use. */
  file: string;
  url: string;
  sha256: string;
}

export const VENDORED_SCHEMAS: readonly VendoredSchema[] = [
  {
    file: 'openvex_json_schema.json',
    url: 'https://raw.githubusercontent.com/openvex/spec/main/openvex_json_schema.json',
    sha256: '9373597734ed1d3ea5161a8b46d3866c4a8cfe76fd632fdd16aef01fb34b3238',
  },
  {
    file: 'bom-1.7.schema.json',
    url: 'https://raw.githubusercontent.com/CycloneDX/specification/master/schema/bom-1.7.schema.json',
    sha256: '73308edec3ab2d38bfffd993e96a042b594314143b6971a6e9ed98bbb6bd76ce',
  },
  {
    file: 'spdx.schema.json',
    url: 'https://raw.githubusercontent.com/CycloneDX/specification/master/schema/spdx.schema.json',
    sha256: 'ea6e844ee6fba1e93473d94834d0ee0996970533497935f932f73d488ffdf4a3',
  },
  {
    file: 'jsf-0.82.schema.json',
    url: 'https://raw.githubusercontent.com/CycloneDX/specification/master/schema/jsf-0.82.schema.json',
    sha256: '8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae',
  },
  {
    file: 'cryptography-defs.schema.json',
    url: 'https://raw.githubusercontent.com/CycloneDX/specification/master/schema/cryptography-defs.schema.json',
    sha256: '027b059a729a06d591bac79a584ef04f83fc32d91a826fdba6ad3c98a10e5b44',
  },
];

export const OPENVEX_SCHEMA = 'openvex_json_schema.json';
export const CYCLONEDX_SCHEMA = 'bom-1.7.schema.json';

let registry: SchemaRegistry | null = null;

/**
 * Every vendored schema, parsed once.
 *
 * Read from disk with `new URL(..., import.meta.url)` rather than imported:
 * a JSON import would need `resolveJsonModule` in the package tsconfig, and a
 * compiler-flag change to ship a data file is a wider blast radius than this
 * needs.
 */
export function schemaRegistry(): SchemaRegistry {
  if (registry) return registry;
  const loaded: SchemaRegistry = {};
  for (const schema of VENDORED_SCHEMAS) {
    const path = new URL(`./schemas/${schema.file}`, import.meta.url);
    loaded[schema.file] = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  }
  registry = loaded;
  return loaded;
}
