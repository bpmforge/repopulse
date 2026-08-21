// A JSON Schema evaluator, so "validated against the published schema" is true
// (W8-14, FR-SEC-14).
//
// WHY THIS FILE EXISTS AT ALL, since writing a schema validator is not a thing
// anyone should do lightly: the acceptance criterion is that the OpenVEX and
// CycloneDX exports are VALIDATED against their published schemas rather than
// asserted to conform, and ajv is not resolvable from this package — it is in
// the pnpm store as a transitive of other workspaces, and adding it as a
// dependency requires an install this ticket may not run. The alternative was
// to hand-transcribe the two schemas into zod, which is exactly the "assert
// they conform" the criterion rules out: a transcription can only ever check
// what its author already believed. So the PUBLISHED SCHEMA DOCUMENTS are
// vendored verbatim in ./schemas (checksums and source URLs in ./schemas.ts)
// and this evaluates them.
//
// THE RULE THAT KEEPS THIS HONEST: an unimplemented keyword THROWS. A partial
// validator that silently ignores what it does not understand passes every
// document it is given, which is worse than no validator, because it reads as
// evidence. Both vendored schemas were surveyed for their keyword set before
// this was written, and the set below covers it exactly; anything new that
// arrives with a schema update stops the suite instead of quietly weakening it.

/** One failure, located by JSON Pointer into the INSTANCE. */
export interface SchemaViolation {
  /** JSON Pointer into the document being validated, '' for the root. */
  path: string;
  /** The schema keyword that rejected it. */
  keyword: string;
  message: string;
}

/**
 * Keywords that carry no assertion.
 *
 * Not a convenience list: each of these is defined by the specification as an
 * annotation, so skipping it is conformance rather than a gap. `meta:enum` is
 * CycloneDX's own extension carrying human labels for enum values.
 */
const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'meta:enum',
]);

/**
 * Keywords that hold subschemas for `$ref` to reach but assert nothing where
 * they sit. Descending into them as if they were applicators would validate the
 * instance against every definition in the document.
 */
const CONTAINERS = new Set(['definitions', '$defs']);

type Schema = boolean | Record<string, unknown>;

interface Scope {
  /** Registry key of the document the current schema came from — `$ref` is relative to it. */
  doc: string;
}

/**
 * The vendored documents, keyed by the filename their `$ref`s use.
 *
 * CycloneDX splits its schema across files and refers to them by bare relative
 * name (`spdx.schema.json`), so the registry key IS that name and resolution
 * needs no base-URI machinery.
 */
export type SchemaRegistry = Record<string, Record<string, unknown>>;

export function validateAgainstSchema(
  registry: SchemaRegistry,
  rootDoc: string,
  instance: unknown,
): SchemaViolation[] {
  const root = registry[rootDoc];
  if (!root) throw new Error(`schema registry has no document '${rootDoc}'`);
  const violations: SchemaViolation[] = [];
  check(registry, root, { doc: rootDoc }, instance, '', violations);
  return violations;
}

function check(
  registry: SchemaRegistry,
  schema: Schema,
  scope: Scope,
  value: unknown,
  path: string,
  out: SchemaViolation[],
): void {
  // A boolean schema: `true` accepts anything, `false` rejects everything.
  if (typeof schema === 'boolean') {
    if (!schema) out.push({ path, keyword: 'false', message: 'schema forbids any value' });
    return;
  }

  for (const [keyword, arg] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword) || CONTAINERS.has(keyword)) continue;

    switch (keyword) {
      case '$ref': {
        const resolved = resolveRef(registry, scope, arg as string);
        check(registry, resolved.schema, resolved.scope, value, path, out);
        break;
      }
      case 'type':
        if (!matchesType(value, arg as string | string[])) {
          out.push({
            path,
            keyword,
            message: `expected ${Array.isArray(arg) ? arg.join('|') : String(arg)}, got ${typeName(value)}`,
          });
        }
        break;
      case 'enum':
        if (!(arg as unknown[]).some((option) => deepEqual(option, value))) {
          out.push({ path, keyword, message: `${JSON.stringify(value)} is not one of the enum` });
        }
        break;
      case 'const':
        if (!deepEqual(arg, value)) {
          out.push({ path, keyword, message: `expected ${JSON.stringify(arg)}` });
        }
        break;
      case 'required':
        if (isObject(value)) {
          for (const key of arg as string[]) {
            if (!(key in value)) out.push({ path, keyword, message: `missing property '${key}'` });
          }
        }
        break;
      case 'properties':
        if (isObject(value)) {
          for (const [key, sub] of Object.entries(arg as Record<string, Schema>)) {
            if (key in value)
              check(registry, sub, scope, value[key], `${path}/${escape(key)}`, out);
          }
        }
        break;
      case 'additionalProperties':
        if (isObject(value)) {
          const declared = new Set(Object.keys((schema['properties'] as object) ?? {}));
          for (const [key, sub] of Object.entries(value)) {
            if (declared.has(key)) continue;
            check(registry, arg as Schema, scope, sub, `${path}/${escape(key)}`, out);
          }
        }
        break;
      case 'items':
        if (Array.isArray(value)) {
          // Draft-07 allows a tuple form here. Neither vendored schema uses it,
          // and guessing at its semantics unexercised is how a validator gets a
          // silent hole — so it is refused rather than approximated.
          if (Array.isArray(arg)) throw new Error("tuple-form 'items' is not implemented");
          value.forEach((item, i) =>
            check(registry, arg as Schema, scope, item, `${path}/${i}`, out),
          );
        }
        break;
      case 'minItems':
        if (Array.isArray(value) && value.length < (arg as number)) {
          out.push({ path, keyword, message: `needs at least ${arg} items, has ${value.length}` });
        }
        break;
      case 'uniqueItems':
        if (arg === true && Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 1) {
            for (let j = i + 1; j < value.length; j += 1) {
              if (deepEqual(value[i], value[j])) {
                out.push({ path, keyword, message: `items ${i} and ${j} are identical` });
              }
            }
          }
        }
        break;
      case 'minLength':
        if (typeof value === 'string' && [...value].length < (arg as number)) {
          out.push({ path, keyword, message: `shorter than ${arg}` });
        }
        break;
      case 'maxLength':
        if (typeof value === 'string' && [...value].length > (arg as number)) {
          out.push({ path, keyword, message: `longer than ${arg}` });
        }
        break;
      case 'pattern':
        if (typeof value === 'string' && !compile(arg as string).test(value)) {
          out.push({ path, keyword, message: `does not match /${arg}/` });
        }
        break;
      case 'minimum':
        if (typeof value === 'number' && value < (arg as number)) {
          out.push({ path, keyword, message: `below minimum ${arg}` });
        }
        break;
      case 'maximum':
        if (typeof value === 'number' && value > (arg as number)) {
          out.push({ path, keyword, message: `above maximum ${arg}` });
        }
        break;
      case 'format':
        // FORMAT IS AN ANNOTATION by default in both draft-07 and 2020-12, so
        // not asserting it is what the specification says to do. `date-time` is
        // asserted anyway because OpenVEX puts one on every statement and a
        // malformed timestamp is a bug we would rather catch here than have a
        // consumer's parser find.
        if (typeof value === 'string') {
          if (arg === 'date-time' && !isDateTime(value)) {
            out.push({ path, keyword, message: `'${value}' is not an RFC 3339 date-time` });
          }
          // A NARROW IRI CHECK, added after a real bug got past this file: the
          // OpenVEX exporter put a version range in a product `@id`, producing
          // `pkg:npm/jquery@>=3.0.0 <3.4.0` — a string no consumer can resolve,
          // in a field the schema declares `format: iri`. Full RFC 3987 is not
          // worth reimplementing, but a space or an angle bracket is illegal in
          // every IRI, and that is the whole class of mistake an identifier
          // assembled by string concatenation makes.
          if ((arg === 'iri' || arg === 'iri-reference') && /[\s<>"{}|\\^`]/.test(value)) {
            out.push({
              path,
              keyword,
              message: `'${value}' contains a character no IRI may hold`,
            });
          }
        }
        break;
      case 'allOf':
        for (const sub of arg as Schema[]) check(registry, sub, scope, value, path, out);
        break;
      case 'anyOf': {
        const branches = (arg as Schema[]).map((sub) => collect(registry, sub, scope, value, path));
        if (branches.every((b) => b.length > 0)) {
          out.push({
            path,
            keyword,
            message: `matched none of the ${branches.length} alternatives`,
          });
        }
        break;
      }
      case 'oneOf': {
        const passed = (arg as Schema[]).filter(
          (sub) => collect(registry, sub, scope, value, path).length === 0,
        );
        if (passed.length !== 1) {
          out.push({
            path,
            keyword,
            message: `matched ${passed.length} alternatives, needs exactly 1`,
          });
        }
        break;
      }
      case 'not':
        if (collect(registry, arg as Schema, scope, value, path).length === 0) {
          out.push({ path, keyword, message: 'matched a schema it must not match' });
        }
        break;
      case 'if': {
        // `then`/`else` are handled here, with their own cases below skipping,
        // because they are meaningless without the `if` that selects them.
        const matched = collect(registry, arg as Schema, scope, value, path).length === 0;
        const branch = matched ? schema['then'] : schema['else'];
        if (branch !== undefined) check(registry, branch as Schema, scope, value, path, out);
        break;
      }
      case 'then':
      case 'else':
        break;
      default:
        // The honesty guard. See the header: silence here would make every
        // document valid for a reason nobody could see.
        throw new Error(`json schema keyword '${keyword}' is not implemented (at ${path || '/'})`);
    }
  }
}

/** Runs a subschema for its verdict only — used by the branching applicators. */
function collect(
  registry: SchemaRegistry,
  schema: Schema,
  scope: Scope,
  value: unknown,
  path: string,
): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  check(registry, schema, scope, value, path, out);
  return out;
}

function resolveRef(
  registry: SchemaRegistry,
  scope: Scope,
  ref: string,
): { schema: Schema; scope: Scope } {
  const hash = ref.indexOf('#');
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  // An empty file part means "this document"; CycloneDX's cross-file refs name
  // the sibling file directly, which is why the registry is keyed by filename.
  const docKey = file === '' ? scope.doc : file;
  const doc = registry[docKey];
  if (!doc) throw new Error(`$ref '${ref}' names document '${docKey}', which is not registered`);

  let node: unknown = doc;
  for (const rawSegment of pointer.split('/')) {
    if (rawSegment === '') continue;
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) || !(segment in node)) {
      throw new Error(`$ref '${ref}' does not resolve (stopped at '${segment}')`);
    }
    node = node[segment];
  }
  return { schema: node as Schema, scope: { doc: docKey } };
}

function matchesType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case 'object':
        return isObject(value);
      case 'array':
        return Array.isArray(value);
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      // JSON has one number type; an integer is a number with no fraction.
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'null':
        return value === null;
      default:
        throw new Error(`json schema type '${t}' is not implemented`);
    }
  });
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escape(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

const compiled = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  // JSON Schema patterns are ECMA-262 regexes, so the engine is the right one
  // already; the unicode retry covers \p{...} classes, which only parse with
  // the flag set.
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    regex = new RegExp(pattern, 'u');
  }
  compiled.set(pattern, regex);
  return regex;
}

/** RFC 3339, which is what both specs mean by `date-time`. */
function isDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}
