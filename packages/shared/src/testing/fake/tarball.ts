import { gzipSync } from 'node:zlib';

// A real source archive for the fake forge (W16-30).
//
// The fake had no `/repos/:owner/:name/tarball/:sha` route at all, so every
// snapshot scanner — anti_slop, semgrep, code_health_tools, the architecture
// register — got a 404 and had never run once against it, in the demo or in
// e2e. What the coverage table said about that was "has never run", which is
// what W16-28 fixed; what it needed to say it about is this.
//
// Built by hand rather than shelled out to `tar`, because packages/security
// reads these bytes with its OWN ustar parser (snapshot/tar.ts, written so the
// extraction guards can run before anything touches disk). A fixture produced
// by the system tar would test the system tar; this tests the pair that
// actually ships together, and it works on a machine with no tar at all.

const BLOCK = 512;

/** Octal, NUL-terminated, left-padded with zeros — the ustar numeric field. */
function octalField(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name: string, size: number, type: '0' | '5'): Buffer {
  const block = Buffer.alloc(BLOCK);
  // 100 bytes of name is the ustar limit. Every path here is short by
  // construction; a longer one would need a PAX header, which snapshot/tar.ts
  // deliberately does not support and which no fixture should need.
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`fixture archive path too long for ustar: ${name}`);
  }
  block.write(name, 0, 100, 'utf8');
  block.write(octalField(type === '5' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  block.write(octalField(0, 8), 108, 8, 'ascii'); // uid
  block.write(octalField(0, 8), 116, 8, 'ascii'); // gid
  block.write(octalField(size, 12), 124, 12, 'ascii');
  // A FIXED mtime, not Date.now(). A scan is meant to be reproducible for a
  // SHA (SECURITY_SUITE §1), and an archive whose bytes change every second
  // would make two runs of the same commit differ for no reason.
  block.write(octalField(1_700_000_000, 12), 136, 12, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');

  // The checksum is computed with its own field read as eight spaces, then
  // written into it. Getting this wrong is the classic way to produce an
  // archive that every tool rejects with "invalid header".
  block.write(' '.repeat(8), 148, 8, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octalField(sum, 7).slice(0, 6) + '\0 ', 148, 8, 'ascii');
  return block;
}

function pad(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

export interface ArchiveFile {
  /** Path RELATIVE to the archive's root directory. */
  path: string;
  content: string;
}

/**
 * A gzipped ustar archive with a single root directory, the way GitHub builds
 * one: `{owner}-{repo}-{sha7}/`.
 *
 * The prefix is imitated rather than flattened. A fake that differs from the
 * real forge in a way the caller can observe is a fake that lets a bug through
 * — and this one is observable: every finding's path carries it.
 */
export function buildTarball(root: string, files: readonly ArchiveFile[]): Buffer {
  const parts: Buffer[] = [header(`${root}/`, 0, '5')];
  for (const file of files) {
    const body = Buffer.from(file.content, 'utf8');
    parts.push(header(`${root}/${file.path}`, body.byteLength, '0'), body, pad(body.byteLength));
  }
  // Two zero blocks end the archive. A reader that stops at the first one is
  // still correct; one that keeps going must not read past these.
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

/**
 * The tree the fake forge serves for any repo.
 *
 * Chosen to give the snapshot scanners something to actually say: a long
 * nested function for the complexity tools, a near-duplicate of it for the
 * duplication tools, a swallowed exception and a credential-shaped literal for
 * the pattern packs. None of it is subtle — a fixture that needs a careful
 * reading to see the problem cannot tell a working scanner from a broken one.
 */
export const FIXTURE_SOURCES: readonly ArchiveFile[] = [
  {
    path: 'src/pricing.ts',
    content: `export function priceOrder(order: Order, customer: Customer): number {
  let total = 0;
  for (const line of order.lines) {
    if (line.kind === 'physical') {
      if (customer.tier === 'gold') {
        if (line.quantity > 10) {
          total += line.unit * line.quantity * 0.8;
        } else {
          total += line.unit * line.quantity * 0.9;
        }
      } else if (customer.tier === 'silver') {
        if (line.quantity > 10) {
          total += line.unit * line.quantity * 0.9;
        } else {
          total += line.unit * line.quantity;
        }
      } else {
        total += line.unit * line.quantity;
      }
    } else if (line.kind === 'digital') {
      total += line.unit * line.quantity;
    }
  }
  return total;
}

export interface Order {
  lines: { kind: string; unit: number; quantity: number }[];
}
export interface Customer {
  tier: string;
}
`,
  },
  {
    path: 'src/quoting.ts',
    content: `import type { Order, Customer } from './pricing.js';

// Near-identical to priceOrder on purpose: the duplication tools should see it.
export function quoteOrder(order: Order, customer: Customer): number {
  let total = 0;
  for (const line of order.lines) {
    if (line.kind === 'physical') {
      if (customer.tier === 'gold') {
        if (line.quantity > 10) {
          total += line.unit * line.quantity * 0.8;
        } else {
          total += line.unit * line.quantity * 0.9;
        }
      } else if (customer.tier === 'silver') {
        if (line.quantity > 10) {
          total += line.unit * line.quantity * 0.9;
        } else {
          total += line.unit * line.quantity;
        }
      } else {
        total += line.unit * line.quantity;
      }
    } else if (line.kind === 'digital') {
      total += line.unit * line.quantity;
    }
  }
  return total;
}
`,
  },
  {
    path: 'src/settle.ts',
    content: `export async function settle(id: string): Promise<void> {
  try {
    await post('/settle', { id });
  } catch {
    // Swallowed on purpose: the error-handling checks should find this.
  }
}

async function post(path: string, body: unknown): Promise<void> {
  console.log('POST', path, JSON.stringify(body));
}
`,
  },
  {
    path: 'src/config.py',
    content: `import os

# Credential-shaped, and deliberately NOT a real one: the fixture must trip the
# pattern packs without ever being a secret anybody could try.
STRIPE_KEY = "sk_test_00000000000000000000000000"

def load():
    return {"key": os.environ.get("STRIPE_KEY", STRIPE_KEY)}
`,
  },
  {
    path: 'package.json',
    content: `{
  "name": "fixture-service",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "express": "4.17.1",
    "lodash": "4.17.11"
  }
}
`,
  },
  {
    path: 'README.md',
    content: `# fixture-service

Served by RepoPulse's fake forge. Nothing here describes a real service.
`,
  },
];

/** GitHub's root-directory name for a repo archive: `owner-name-sha7`. */
export function archiveRoot(repo: string, sha: string): string {
  return `${repo.replace('/', '-')}-${(sha || 'head').slice(0, 7)}`;
}
