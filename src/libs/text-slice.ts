import { StringDecoder } from 'node:string_decoder';

/**
 * A window of lines out of a text file (GRD-93, GRD-108): the web app shows
 * the start of an input, an expected output or a program output, with the total
 * so it can offer "View all", and asks for the next window when it wants more.
 */
export interface TextSlice {
  /** The lines of the window, without their line breaks. */
  lines: string[];
  /** 1-based number of the first line in `lines`; `total_lines + 1` when past the end. */
  from_line: number;
  /** 1-based number of the last line in `lines`; `from_line - 1` when the window is empty. */
  to_line: number;
  /** Lines in the whole file; a last line without a line break counts. */
  total_lines: number;
  size_bytes: number;
  /** A line in the window was longer than `maxLineChars` and was cut. */
  line_truncated: boolean;
}

export interface SliceOptions {
  /** 1-based. */
  fromLine?: number;
  maxLines: number;
  maxLineChars: number;
}

export const SLICE_LIMITS = {
  /** Lines in a preview, and in one "View all" window (the design pages through 1,000 lines). */
  preview_lines: 10,
  max_lines: 1000,
  max_line_chars: 10_000,
} as const;

type Chunk = Uint8Array | string;

/**
 * Reads the whole stream once (so the total is known) and keeps only the
 * lines asked for. Bytes are decoded as UTF-8; broken sequences become U+FFFD.
 * Line breaks are LF; a CR before the LF is dropped.
 */
export async function sliceText(
  source: AsyncIterable<Chunk> | Iterable<Chunk>,
  options: SliceOptions
): Promise<TextSlice> {
  const fromLine = Math.max(1, options.fromLine ?? 1);
  const toLine = fromLine + options.maxLines - 1;
  const decoder = new StringDecoder('utf8');
  const lines: string[] = [];
  let truncated = false;
  let total = 0; // lines finished by a line break
  let size = 0;
  let kept = ''; // the start of the current line, while it is inside the window
  let seen = false; // any character since the last line break

  const insideWindow = () => total + 1 >= fromLine && total + 1 <= toLine;
  // One more character more than allowed is read: it may be a CR that is dropped.
  const keepLimit = options.maxLineChars + 1;

  const append = (text: string) => {
    if (text === '') return;
    seen = true;
    if (!insideWindow()) return;
    if (kept.length + text.length > keepLimit) {
      kept += text.slice(0, Math.max(0, keepLimit - kept.length));
    } else {
      kept += text;
    }
  };

  const endLine = () => {
    if (insideWindow()) {
      const line = kept.endsWith('\r') ? kept.slice(0, -1) : kept;
      if (line.length > options.maxLineChars) {
        truncated = true;
        lines.push(line.slice(0, options.maxLineChars));
      } else {
        lines.push(line);
      }
    }
    total += 1;
    kept = '';
    seen = false;
  };

  const consume = (text: string) => {
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) {
        append(text.slice(start));
        return;
      }
      append(text.slice(start, newline));
      endLine();
      start = newline + 1;
    }
  };

  for await (const chunk of source as AsyncIterable<Chunk>) {
    if (typeof chunk === 'string') {
      size += Buffer.byteLength(chunk, 'utf8');
      consume(chunk);
    } else {
      size += chunk.byteLength;
      consume(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    }
  }
  consume(decoder.end());
  // A last line with text but no line break still counts.
  if (seen) endLine();

  return {
    lines,
    from_line: fromLine,
    to_line: fromLine + lines.length - 1,
    total_lines: total,
    size_bytes: size,
    line_truncated: truncated,
  };
}

/** The slice of a text that is already in memory (a captured program output). */
export function sliceString(text: string, options: SliceOptions): Promise<TextSlice> {
  return sliceText([text], options);
}
