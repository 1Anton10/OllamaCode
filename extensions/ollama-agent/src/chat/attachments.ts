import * as vscode from "vscode";
import * as path from "path";

const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 90_000;
const MAX_DIAG_ITEMS = 40;

function isUri(v: unknown): v is vscode.Uri {
  return !!(v && typeof v === "object" && typeof (v as any).fsPath === "string" && typeof (v as any).scheme === "string");
}

function isLocation(v: unknown): v is vscode.Location {
  return !!(v && typeof v === "object" && isUri((v as any).uri) && (v as any).range);
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(+${s.length - max} chars)`;
}

async function readUriText(uri: vscode.Uri, range?: vscode.Range): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (range) {
      return doc.getText(range);
    }
    return doc.getText();
  } catch {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch (e: any) {
      return `[не удалось прочитать ${uri.fsPath}: ${e?.message || e}]`;
    }
  }
}

function formatDiagnostic(d: vscode.Diagnostic, uri: vscode.Uri): string {
  const sev =
    d.severity === vscode.DiagnosticSeverity.Error
      ? "error"
      : d.severity === vscode.DiagnosticSeverity.Warning
        ? "warning"
        : d.severity === vscode.DiagnosticSeverity.Information
          ? "info"
          : "hint";
  const line = d.range.start.line + 1;
  const code = d.code ? ` code=${typeof d.code === "object" ? (d.code as any).value : d.code}` : "";
  return `- [${sev}] ${path.basename(uri.fsPath)}:${line}${code}: ${d.message}`;
}

/**
 * Resolve ChatRequest.references (+ menu attachments) into model-visible context.
 * Covers files, folders, selections, problems, SCM-ish strings, binary notes.
 */
export async function buildAttachmentContext(
  request: vscode.ChatRequest
): Promise<{ text: string; count: number }> {
  const refs = request.references || [];
  if (!refs.length) return { text: "", count: 0 };

  const blocks: string[] = [];
  let used = 0;
  let count = 0;

  for (const ref of refs) {
    if (used >= MAX_TOTAL_CHARS) break;
    const budget = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - used);
    const name = (ref as { name?: string }).name || ref.id || "attachment";
    const desc = ref.modelDescription ? ` (${ref.modelDescription})` : "";
    let body = "";

    const v = ref.value as any;

    // Proposed: ChatReferenceDiagnostic
    if (v && typeof v === "object" && Array.isArray(v.diagnostics)) {
      const lines: string[] = [];
      let n = 0;
      for (const tuple of v.diagnostics as [vscode.Uri, vscode.Diagnostic[]][]) {
        const [uri, diags] = tuple;
        for (const d of diags || []) {
          if (n >= MAX_DIAG_ITEMS) break;
          lines.push(formatDiagnostic(d, uri));
          n++;
        }
      }
      body = lines.join("\n") || "(no diagnostics)";
    } else if (v && typeof v === "object" && typeof v.data === "function" && v.mimeType) {
      // Proposed: ChatReferenceBinaryData (images)
      body = `[binary attachment mime=${v.mimeType}${v.isURL ? " fromURL" : ""}${v.reference ? ` uri=${v.reference}` : ""} — содержимое не встроено в текст; опиши/используй tools при необходимости]`;
    } else if (typeof v === "string") {
      body = clip(v, budget);
    } else if (isLocation(v)) {
      const text = await readUriText(v.uri, v.range);
      const start = v.range.start.line + 1;
      const end = v.range.end.line + 1;
      body = `selection ${v.uri.fsPath}:${start}-${end}\n\`\`\`\n${clip(text, budget)}\n\`\`\``;
    } else if (isUri(v)) {
      let isDir = false;
      try {
        const st = await vscode.workspace.fs.stat(v);
        isDir = !!(st.type & vscode.FileType.Directory);
      } catch {
        /* treat as file */
      }
      if (isDir) {
        try {
          const entries = await vscode.workspace.fs.readDirectory(v);
          const listing = entries
            .slice(0, 200)
            .map(([n, t]) => `${t & vscode.FileType.Directory ? "📁" : "📄"} ${n}`)
            .join("\n");
          body = `directory ${v.fsPath}\n${listing}${entries.length > 200 ? "\n…" : ""}`;
        } catch (e: any) {
          body = `directory ${v.fsPath} (list failed: ${e?.message || e})`;
        }
      } else {
        const text = await readUriText(v);
        const ext = path.extname(v.fsPath).replace(/^\./, "") || "txt";
        body = `file ${v.fsPath}\n\`\`\`${ext}\n${clip(text, budget)}\n\`\`\``;
      }
    } else if (v != null) {
      try {
        body = clip(JSON.stringify(v, null, 2), budget);
      } catch {
        body = String(v);
      }
    }

    if (!body.trim()) continue;
    const block = `<attachment id="${name}"${desc}>\n${body}\n</attachment>`;
    blocks.push(block);
    used += block.length;
    count++;
  }

  // Tools attached via #tool / paperclip Tools…
  const toolRefs = request.toolReferences || [];
  if (toolRefs.length) {
    const names = toolRefs.map((t) => t.name).filter(Boolean);
    blocks.push(
      `<attached_tools>\nПользователь явно прикрепил tools: ${names.map((n) => `\`${n}\``).join(", ")}.\nИспользуй их через tool_calls, когда уместно.\n</attached_tools>`
    );
    count += names.length;
  }

  if (!blocks.length) return { text: "", count: 0 };
  return {
    text: `\n\n[ATTACHMENTS]\n${blocks.join("\n\n")}\n[/ATTACHMENTS]`,
    count,
  };
}
