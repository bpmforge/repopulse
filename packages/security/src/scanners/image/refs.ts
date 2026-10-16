// Image references named by a repository (W18-34).
//
// Pure: it reads file text and returns the images a Dockerfile, a compose file
// or a Kubernetes manifest names, so the pull step knows what to fetch. No
// registry is contacted here, and a reference that cannot be pulled as written
// (a build-arg, a stage name, `scratch`) is reported as skipped with its reason
// rather than dropped — "scanned 3 images" over a repo that names five reads as
// "the other two are clean" unless the two are accounted for.

export type ImageSourceKind = 'dockerfile' | 'compose' | 'kubernetes';

export interface ImageRef {
  /** The reference as written, e.g. `node:20-alpine` or `ghcr.io/acme/app@sha256:…`. */
  ref: string;
  /** Registry host, `docker.io` when the reference names none. */
  registry: string;
  /** Repository path without registry or tag, e.g. `library/node`. */
  repository: string;
  tag: string | null;
  digest: string | null;
  file: string;
  line: number;
  kind: ImageSourceKind;
}

export interface SkippedImageRef {
  ref: string;
  file: string;
  line: number;
  reason: 'scratch' | 'stage' | 'variable';
}

export interface ImageRefResult {
  images: ImageRef[];
  skipped: SkippedImageRef[];
}

const MAX_FILE_BYTES = 512 * 1024;

/** Which parser a path gets, or null when it is not an image-bearing file. */
export function imageSourceKind(file: string): ImageSourceKind | null {
  const base = file.split('/').pop() ?? file;
  if (/^(Dockerfile|Containerfile)(\..+)?$/i.test(base) || /\.(dockerfile|containerfile)$/i.test(base)) {
    return 'dockerfile';
  }
  if (/\.ya?ml$/i.test(base)) return 'compose';
  return null;
}

/** Splits `host/repo/name:tag@sha256:…` into parts, with Docker's own defaults. */
export function parseImageRef(ref: string): Omit<ImageRef, 'file' | 'line' | 'kind'> {
  let rest = ref;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/');
  const first = parts[0] ?? '';
  const hasRegistry = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = hasRegistry ? first : 'docker.io';
  let repository = hasRegistry ? parts.slice(1).join('/') : rest;
  if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`;
  return { ref, registry, repository, tag: tag ?? (digest ? null : 'latest'), digest };
}

function classify(
  ref: string,
  stages: ReadonlySet<string>,
): SkippedImageRef['reason'] | null {
  if (ref.toLowerCase() === 'scratch') return 'scratch';
  if (stages.has(ref.toLowerCase())) return 'stage';
  if (/\$\{?[A-Za-z_]/.test(ref)) return 'variable';
  return null;
}

function fromDockerfile(file: string, text: string, out: ImageRefResult): void {
  const stages = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(lines[i] ?? '');
    if (!match) continue;
    const ref = match[1]!;
    const reason = classify(ref, stages);
    if (match[2]) stages.add(match[2].toLowerCase());
    if (reason) out.skipped.push({ ref, file, line: i + 1, reason });
    else out.images.push({ ...parseImageRef(ref), file, line: i + 1, kind: 'dockerfile' });
  }
}

/** `image:` keys of compose services and Kubernetes pod specs, matched by line. */
function fromYaml(file: string, text: string, out: ImageRefResult): void {
  const isK8s = /^\s*(apiVersion|kind)\s*:/m.test(text) && /^\s*kind\s*:/m.test(text);
  const kind: ImageSourceKind = isK8s ? 'kubernetes' : 'compose';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(?:-\s+)?image\s*:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/.exec(lines[i] ?? '');
    if (!match) continue;
    const ref = match[1]!;
    const reason = classify(ref, new Set());
    if (reason) out.skipped.push({ ref, file, line: i + 1, reason });
    else out.images.push({ ...parseImageRef(ref), file, line: i + 1, kind });
  }
}

export function extractImageRefs(files: readonly { path: string; content: string }[]): ImageRefResult {
  const out: ImageRefResult = { images: [], skipped: [] };
  for (const f of files) {
    const kind = imageSourceKind(f.path);
    if (!kind || f.content.length > MAX_FILE_BYTES) continue;
    if (kind === 'dockerfile') fromDockerfile(f.path, f.content, out);
    else fromYaml(f.path, f.content, out);
  }
  return out;
}

/** One entry per distinct reference, keeping every place it was named. */
export function distinctImages(images: readonly ImageRef[]): Map<string, ImageRef[]> {
  const byRef = new Map<string, ImageRef[]>();
  for (const image of images) byRef.set(image.ref, [...(byRef.get(image.ref) ?? []), image]);
  return byRef;
}
