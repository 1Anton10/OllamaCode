/**
 * Light fixups so VS Code Chat actually renders headings / GFM tables.
 * Does not rewrite prose — only structural whitespace around MD blocks.
 */
export function normalizeAssistantMarkdown(text: string): string {
  if (!text) return text;
  let t = text.replace(/\r\n/g, "\n");

  // Glued heading+table header: «## Title | Col | Col |» → split
  t = t.replace(/^(#{1,6}\s+[^\n|]+?)\s+(\|.*\|)\s*$/gm, "$1\n\n$2");

  // Ensure blank line before a markdown table that follows a heading/paragraph
  t = t.replace(/([^\n])\n(\|[^\n]+\|)\s*\n(\|[-:\s|]+\|)/g, "$1\n\n$2\n$3");

  // Heading jammed against next line without blank line
  t = t.replace(/^(#{1,6}\s+[^\n]+)\n(?!\n|#|\|)/gm, "$1\n\n");

  // Script glue (RU↔EN) without space/newline — common Qwen mid-stream switch
  t = t.replace(/([а-яёА-ЯЁ])([A-Z])/g, "$1\n\n$2");
  t = t.replace(/([a-z.!?])([А-ЯЁ])/g, "$1\n\n$2");

  // Escape __path__ style names inside table rows so emphasis doesn't eat the table
  t = t.replace(/^\|.*\|$/gm, (row) =>
    row.replace(/(^|[^`])__([A-Za-z0-9._-]+)__/g, "$1`__$2__`")
  );

  return t.replace(/\n{3,}/g, "\n\n").trim();
}
