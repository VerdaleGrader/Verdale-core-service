import { createHash } from 'node:crypto';

/**
 * Checks and normalises an uploaded test file (GRD-25).
 *
 * Policy (also in docs/problems.md and the TestCase schema):
 *  - Must be UTF-8 text. NUL bytes, other control characters (all of C0
 *    except TAB, LF and CR) and invalid UTF-8 mean "binary": refused.
 *  - A leading byte order mark is removed.
 *  - CRLF and lone CR become LF.
 *  - Trailing blank lines are kept (an input may end with a blank line that
 *    the program reads to know where to stop) and a non-empty file ends with
 *    an LF. Trailing spaces inside lines are kept too; Judge's line checker
 *    ignores both when comparing outputs anyway.
 *  - An empty file, or one with nothing but newlines, becomes empty (some
 *    problems have no input).
 *
 * The SHA-256 and the size are of the normalised bytes, so the same test
 * saved with different line endings is stored once.
 */
export interface NormalizedFile {
  bytes: Buffer;
  sha256: string;
  size: number;
}

export class TestFileError extends Error {
  constructor(
    /** What the author should fix, e.g. "contains a NUL byte at offset 12 (looks like a binary file)". */
    readonly reason: string,
    readonly code: 'TOO_LARGE' | 'NOT_UTF8' | 'BINARY' | 'TOO_LARGE_FOR_SAMPLE'
  ) {
    super(reason);
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Offset of the first byte that is a control character, or -1. */
function firstControlByte(bytes: Buffer): number {
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return index;
  }
  return -1;
}

export function normalizeTestFile(raw: Buffer, { maxBytes }: { maxBytes: number }): NormalizedFile {
  if (raw.length > maxBytes) {
    throw new TestFileError(`is larger than ${formatBytes(maxBytes)}`, 'TOO_LARGE');
  }
  const control = firstControlByte(raw);
  if (control !== -1) {
    const what =
      raw[control] === 0
        ? 'a NUL byte'
        : `control character 0x${raw[control]!.toString(16).padStart(2, '0')}`;
    throw new TestFileError(
      `contains ${what} at offset ${control}, so it looks like a binary file; only UTF-8 text is accepted`,
      'BINARY'
    );
  }
  let text: string;
  try {
    text = decoder.decode(raw);
  } catch {
    throw new TestFileError(
      'is not valid UTF-8 text; save it as UTF-8 and upload it again',
      'NOT_UTF8'
    );
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  if (/^\n*$/.test(text)) text = '';
  const bytes = Buffer.from(text === '' || text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  if (bytes.length > maxBytes) {
    throw new TestFileError(`is larger than ${formatBytes(maxBytes)}`, 'TOO_LARGE');
  }
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`;
  return `${bytes} bytes`;
}
