// Git trailer extraction (W18-20), used at ingest to keep the one part of a
// commit body the authorship classifier needs.
//
// Git's own rule (git-interpret-trailers): trailers are the LAST paragraph of
// the message, and only when that paragraph is not also the subject. We are
// stricter than git, which accepts a block that is only 25% trailers when one
// of them is git-generated: a prose paragraph ending "Thanks to: Bob" must not
// become a trailer, and an over-eager parse here would show up as false
// AI-authorship further down. Precision over recall.

const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*(\S.*)$/;

/** Bounds what one commit can write into the warehouse. */
const MAX_TRAILERS = 30;
const MAX_TRAILER_LENGTH = 300;

/**
 * The trailers of a commit message as normalized `Key: value` strings, in
 * message order. `[]` when the message has none — distinct from NULL in the
 * column, which means the message was never parsed.
 */
export function parseCommitTrailers(message: string): string[] {
  const paragraphs = message
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length < 2) return [];
  const last = paragraphs[paragraphs.length - 1] as string;

  const out: string[] = [];
  for (const line of last.split('\n')) {
    // A folded continuation line belongs to the trailer above it.
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`.slice(0, MAX_TRAILER_LENGTH);
      continue;
    }
    const m = TRAILER_LINE.exec(line.trim());
    // One non-trailer line and the paragraph is prose, not a trailer block.
    if (!m) return [];
    out.push(`${m[1]}: ${(m[2] as string).trim()}`.slice(0, MAX_TRAILER_LENGTH));
  }
  return out.slice(0, MAX_TRAILERS);
}

/** Splits a stored `Key: value` trailer. Keys compare case-insensitively. */
export function splitTrailer(trailer: string): { key: string; value: string } | null {
  const idx = trailer.indexOf(':');
  if (idx <= 0) return null;
  return { key: trailer.slice(0, idx).trim().toLowerCase(), value: trailer.slice(idx + 1).trim() };
}
