// A streaming POSIX/ustar reader (W8-03, SECURITY_SUITE.md 2.1).
//
// Written here rather than taken as a dependency for one reason: the guards in
// extract.ts have to run on an entry BEFORE a single byte of it is written to
// disk, which means the code that decides what an entry is must be code we can
// read. A parser that hands back an already-extracted tree gives the guards
// nothing to guard. The parsing itself is the boring part - 512-byte headers
// with octal numeric fields - and it is covered by fixture archives produced by
// the system tar, not by hand-built bytes.
//
// Deliberately NOT supported: sparse files, GNU multi-volume, and anything else
// that would need seeking. A source archive from a forge uses none of them, and
// an entry type we do not understand is dropped and counted rather than guessed
// at.

const BLOCK = 512;

export type TarEntryType = 'file' | 'dir' | 'symlink' | 'hardlink' | 'longname' | 'pax' | 'other';

export interface TarHeader {
  name: string;
  type: TarEntryType;
  size: number;
  mode: number;
  linkname: string;
}

export interface TarEntry extends TarHeader {
  /** Entry bytes. Undefined for entries with no body (dirs, links). */
  body?: Uint8Array;
}

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarFormatError';
  }
}

function str(block: Uint8Array, start: number, len: number): string {
  const slice = block.subarray(start, start + len);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

function octal(block: Uint8Array, start: number, len: number): number {
  const raw = str(block, start, len).trim();
  if (raw === '') return 0;
  // GNU base-256 encoding for values that do not fit in the octal field. A
  // 50MB-capped file never needs it, but a crafted archive can set the high
  // bit, and misreading that as octal would give a size of 0 - which would
  // silently skip the entry's bytes and desynchronise the whole stream.
  if ((block[start] as number) & 0x80) {
    let value = 0n;
    for (let i = start + 1; i < start + len; i++)
      value = (value << 8n) | BigInt(block[i] as number);
    return Number(value);
  }
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function typeOf(flag: string): TarEntryType {
  switch (flag) {
    case '0':
    case '\0':
    case '7':
      return 'file';
    case '1':
      return 'hardlink';
    case '2':
      return 'symlink';
    case '5':
      return 'dir';
    case 'L':
      return 'longname';
    case 'x':
    case 'X':
    case 'g':
      return 'pax';
    default:
      return 'other';
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((b) => b === 0);
}

function parseHeader(block: Uint8Array): TarHeader {
  const name = str(block, 0, 100);
  const prefix = str(block, 345, 155);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    type: typeOf(String.fromCharCode(block[156] as number)),
    size: octal(block, 124, 12),
    mode: octal(block, 100, 8),
    linkname: str(block, 157, 100),
  };
}

/** `path=` from a pax extended header, which overrides the ustar name. */
function paxPath(body: Uint8Array): string | undefined {
  const text = Buffer.from(body).toString('utf8');
  for (const line of text.split('\n')) {
    // "%d %s=%s\n" - length prefix, then key=value.
    const eq = line.indexOf('=');
    const space = line.indexOf(' ');
    if (eq === -1 || space === -1 || space > eq) continue;
    if (line.slice(space + 1, eq) === 'path') return line.slice(eq + 1);
  }
  return undefined;
}

class ChunkReader {
  private buffered: Buffer[] = [];
  private length = 0;
  private done = false;

  constructor(private readonly iterator: AsyncIterator<Uint8Array>) {}

  /** Exactly n bytes, or null at a clean end of stream. */
  async read(n: number): Promise<Buffer | null> {
    while (this.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      const chunk = Buffer.from(next.value);
      if (chunk.length === 0) continue;
      this.buffered.push(chunk);
      this.length += chunk.length;
    }
    if (this.length === 0) return null;
    if (this.length < n) throw new TarFormatError(`archive truncated: wanted ${n} bytes`);
    const joined = Buffer.concat(this.buffered, this.length);
    this.buffered = [joined.subarray(n)];
    this.length = joined.length - n;
    return joined.subarray(0, n);
  }
}

export interface ReadTarOptions {
  /** Per-entry byte cap. An entry larger than this aborts the whole read. */
  maxEntryBytes?: number;
  /** Total uncompressed byte cap - the zip-bomb guard. */
  maxTotalBytes?: number;
  /** Entry-count cap: many tiny files are a bomb too. */
  maxEntries?: number;
}

export class TarLimitError extends Error {
  constructor(
    message: string,
    readonly limit: 'entry_bytes' | 'total_bytes' | 'entries',
  ) {
    super(message);
    this.name = 'TarLimitError';
  }
}

/**
 * Yields entries as they arrive, aborting the moment a cap is crossed.
 *
 * The caps are checked mid-stream on purpose: a 10GB archive that decompresses
 * from 3MB must stop after the cap's worth of bytes, not after it has been
 * fully decompressed and measured. That is the whole difference between a
 * zip-bomb guard and a size report.
 */
export async function* readTar(
  chunks: AsyncIterable<Uint8Array>,
  opts: ReadTarOptions = {},
): AsyncGenerator<TarEntry> {
  const maxEntryBytes = opts.maxEntryBytes ?? 50 * 1024 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
  const maxEntries = opts.maxEntries ?? 200_000;

  const reader = new ChunkReader(chunks[Symbol.asyncIterator]());
  let total = 0;
  let count = 0;
  let pendingName: string | undefined;
  let zeroBlocks = 0;

  for (;;) {
    const header = await reader.read(BLOCK);
    if (!header) return;
    if (isZeroBlock(header)) {
      // Two consecutive zero blocks end the archive; one alone is padding.
      if (++zeroBlocks >= 2) return;
      continue;
    }
    zeroBlocks = 0;

    const parsed = parseHeader(header);
    if (parsed.size < 0) throw new TarFormatError('negative entry size');
    if (parsed.size > maxEntryBytes) {
      throw new TarLimitError(
        `entry ${parsed.name} is ${parsed.size} bytes, over the ${maxEntryBytes} cap`,
        'entry_bytes',
      );
    }
    total += parsed.size;
    if (total > maxTotalBytes) {
      throw new TarLimitError(`archive exceeds ${maxTotalBytes} uncompressed bytes`, 'total_bytes');
    }
    if (++count > maxEntries) {
      throw new TarLimitError(`archive holds more than ${maxEntries} entries`, 'entries');
    }

    const padded = Math.ceil(parsed.size / BLOCK) * BLOCK;
    const body = padded > 0 ? await reader.read(padded) : Buffer.alloc(0);
    if (!body) throw new TarFormatError(`archive truncated inside ${parsed.name}`);
    const data = body.subarray(0, parsed.size);

    if (parsed.type === 'longname') {
      pendingName = Buffer.from(data).toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (parsed.type === 'pax') {
      pendingName = paxPath(data) ?? pendingName;
      continue;
    }

    const name = pendingName ?? parsed.name;
    pendingName = undefined;
    yield parsed.type === 'file'
      ? { ...parsed, name, body: data }
      : { ...parsed, name, size: parsed.size };
  }
}
