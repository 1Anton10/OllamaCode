/**
 * Resolve which slice of a file to return for read_file.
 * Short files are returned in full so models don't offset-page.
 */

export const READ_AUTO_FULL_MAX_LINES = 500;
export const READ_MAX_CHARS = 100_000;

export function resolveReadWindow(opts: {
  text: string;
  offset?: number;
  limit?: number;
  autoFullMaxLines?: number;
  maxChars?: number;
}): {
  body: string;
  lineCount: number;
  fromLine: number;
  toLine: number;
  entireFile: boolean;
  summary: string;
  hint: string;
} {
  const lines = opts.text.split(/\r?\n/);
  const lineCount = lines.length;
  const maxLines = opts.autoFullMaxLines ?? READ_AUTO_FULL_MAX_LINES;
  const maxChars = opts.maxChars ?? READ_MAX_CHARS;
  let offset = Math.max(0, Number(opts.offset || 0) || 0);
  let limit = Math.max(0, Number(opts.limit || 0) || 0);

  // Short files: always entire content (ignore tiny/paged windows)
  const forceFull = lineCount <= maxLines;
  if (forceFull) {
    offset = 0;
    limit = 0;
  }

  let slice: string;
  let fromLine: number;
  let toLine: number;
  let entireFile: boolean;

  if (limit > 0) {
    fromLine = offset + 1;
    toLine = Math.min(lineCount, offset + limit);
    slice = lines.slice(offset, offset + limit).join("\n");
    entireFile = offset === 0 && toLine >= lineCount;
  } else if (offset > 0) {
    fromLine = offset + 1;
    toLine = lineCount;
    slice = lines.slice(offset).join("\n");
    entireFile = false;
  } else {
    fromLine = 1;
    toLine = lineCount;
    slice = opts.text;
    entireFile = true;
  }

  let body = slice;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + "\n…[truncated at char limit — use offset/limit on a large file]";
  }

  const summary = entireFile
    ? `read entire file (${lineCount} lines)`
    : `read lines ${fromLine}–${toLine} of ${lineCount}`;

  const hint = entireFile
    ? `EOF: entire file (${lineCount} lines). Do not re-read with offset/limit — next: replace_in_file / write_to_file or run_in_terminal.`
    : `Partial read ${fromLine}–${toLine} of ${lineCount}. Only continue with a higher offset if you still lack needed lines; otherwise edit/run.`;

  return { body, lineCount, fromLine, toLine, entireFile, summary, hint };
}
