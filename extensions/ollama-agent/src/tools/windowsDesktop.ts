import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { checkDesktopActionSafety } from "./desktopSafety";

let extensionContext: vscode.ExtensionContext | undefined;
let desktopAutoApprove = false;

export function bindWindowsDesktopContext(ctx: vscode.ExtensionContext): void {
  extensionContext = ctx;
}

export function setWindowsDesktopAutoApprove(on: boolean): void {
  desktopAutoApprove = on;
}

export async function confirmWindowsDesktop(detail: string): Promise<boolean> {
  if (desktopAutoApprove) return true;
  const pick = (await vscode.window.showWarningMessage(
    `Control Windows desktop?\n\n${detail.slice(0, 500)}`,
    { modal: true },
    "Allow",
    "Always Allow",
    "Deny"
  )) as string | undefined;
  if (pick === "Always Allow") {
    desktopAutoApprove = true;
    void vscode.window.showInformationMessage("Windows desktop: Always Allow (this session).");
    return true;
  }
  return pick === "Allow";
}

export type WindowsDesktopInput = {
  action?: string;
  target?: string;
  title?: string;
  process?: string;
  hwnd?: number;
  x?: number;
  y?: number;
  relative?: boolean;
  button?: string;
  clicks?: number;
  delta?: number;
  text?: string;
  keys?: string;
  name?: string;
  automation_id?: string;
  control_type?: string;
  path?: string;
  window_only?: boolean;
  on_screen_only?: boolean;
  focus?: boolean;
  max_depth?: number;
  ms?: number;
};

function scriptPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "scripts", "windows-ui.ps1");
}

function defaultShotPath(): string {
  const root =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
    path.join(os.tmpdir(), "ollamacode");
  const dir = path.join(root, ".ollamacode", "ui");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `shot-${Date.now().toString(36)}.png`);
}

export async function runWindowsDesktop(
  input: WindowsDesktopInput,
  context?: vscode.ExtensionContext
): Promise<string> {
  if (process.platform !== "win32") {
    return "[TOOL_RESULT]\ntool: windows_desktop\nstatus: FAILED\nsummary: Windows only\n[/TOOL_RESULT]";
  }
  const ctx = context || extensionContext;
  if (!ctx) {
    return "[TOOL_RESULT]\ntool: windows_desktop\nstatus: FAILED\nsummary: extension context missing\n[/TOOL_RESULT]";
  }
  const action = String(input.action || "").trim();
  if (!action) {
    return "[TOOL_RESULT]\ntool: windows_desktop\nstatus: FAILED\nsummary: action required\n[/TOOL_RESULT]";
  }

  const safety = checkDesktopActionSafety(input);
  if (safety) {
    return [
      "[TOOL_RESULT]",
      "tool: windows_desktop",
      "status: FAILED",
      `summary: ${safety.slice(0, 400)}`,
      "hint: Bot E2E = focus messenger chat → type/click test message. NEVER close/Alt+F4 Telegram or other protected apps.",
      "[/TOOL_RESULT]",
    ].join("\n");
  }

  try {
    const auditDir = path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir(),
      ".ollamacode",
      "ui"
    );
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(
      path.join(auditDir, "desktop-audit.log"),
      `${new Date().toISOString()}\t${action}\t${JSON.stringify({
        title: input.title,
        process: input.process,
        hwnd: input.hwnd,
        keys: input.keys,
        name: input.name,
      })}\n`,
      "utf8"
    );
  } catch {
    /* ignore audit errors */
  }

  const ps1 = scriptPath(ctx);
  if (!fs.existsSync(ps1)) {
    return `[TOOL_RESULT]\ntool: windows_desktop\nstatus: FAILED\nsummary: missing script ${ps1}\n[/TOOL_RESULT]`;
  }

  const payload: Record<string, unknown> = { ...input, action };
  if (action === "screenshot" && !payload.path) {
    payload.path = defaultShotPath();
  }
  // Models sometimes send max_depth: "∞" / Infinity — coerce before PowerShell
  if (payload.max_depth !== undefined && payload.max_depth !== null) {
    const n = Number(payload.max_depth);
    payload.max_depth = Number.isFinite(n) ? Math.max(1, Math.min(6, Math.round(n))) : 3;
  }

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
        { windowsHide: true }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString("utf8");
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.write(Buffer.from(JSON.stringify(payload), "utf8"));
      child.stdin.end();
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 45_000);
    }
  );

  let parsed: any = null;
  try {
    const rawOut = (result.stdout || "").replace(/^\uFEFF/, "").trim();
    parsed = JSON.parse(rawOut || "{}");
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.ok === false) {
    const err =
      parsed?.error ||
      result.stderr ||
      result.stdout ||
      (result.code ? `exit ${result.code}` : "windows_desktop failed");
    return [
      "[TOOL_RESULT]",
      "tool: windows_desktop",
      "status: FAILED",
      `summary: ${String(err).slice(0, 400)}`,
      `detail:\n${(result.stdout || result.stderr || "").slice(0, 4000)}`,
      "hint: If parse/script error — ask user to reload extension. For missing window: snapshot without filter, then pick hwnd by process=Telegram.",
      "[/TOOL_RESULT]",
    ].join("\n");
  }

  const detail = JSON.stringify(parsed, null, 2).slice(0, 12000);
  const visionNote =
    "TEXT_VISION (no image pixels): this TOOL_RESULT is your only eyes - read pick/elements/bounds below. Never claim you saw a screenshot.";
  const hint =
    action === "screenshot"
      ? `PNG path only - model has NO vision. Ignore the image file. Call snapshot(process=Telegram) then focus(hwnd) then ui_tree.`
      : action === "snapshot" || action === "list_windows" || action === "foreground"
        ? "Read pick + match.hwnd. Next: focus(hwnd=<number>) then ui_tree(hwnd=..., max_depth=3, focus=false). Never screenshot to see."
        : action === "ui_tree" || action === "find"
          ? "elements[] is your UI map. If process is OllamaCode/Cursor - WRONG window, re-snapshot process=Telegram. click_element|type only on messenger."
          : action === "focus"
            ? parsed.focused
              ? "Focused. Call ui_tree(hwnd=..., focus=false). Do not click IDE chrome."
              : "Focus may have failed (focused=false). Retry with hwnd from pick/match."
            : "Prefer hwnd from pick/match. Re-run ui_tree after UI changes.";

  const summaryBits = [`windows_desktop ${action} ok`];
  const extraLines: string[] = [visionNote];
  if (action === "list_windows" || action === "snapshot" || action === "screenshot") {
    const wins = Array.isArray(parsed.windows) ? parsed.windows : [];
    const count = parsed.count ?? wins.length;
    summaryBits.push(`${count} windows`);
    if (parsed.match?.hwnd) {
      extraLines.push(
        `match: hwnd=${parsed.match.hwnd} process=${parsed.match.process || "?"} on_screen=${parsed.match.on_screen !== false} title=${String(parsed.match.title || "").slice(0, 70)}`
      );
      summaryBits.push(`match=${parsed.match.hwnd}`);
    }
    if (parsed.process_alive === true) {
      extraLines.push("process_alive: true");
    } else if (parsed.process_alive === false && (parsed.filter?.process || parsed.filter?.title)) {
      extraLines.push(
        "process_alive: false - app not running. Ask user to open it, or windows_desktop launch."
      );
    }
    const picks = wins
      .filter(
        (w: any) =>
          w &&
          w.on_screen !== false &&
          Number(w.width) > 40 &&
          Number(w.height) > 40 &&
          String(w.title || "").trim()
      )
      .slice(0, 24)
      .map((w: any) => {
        const L = w.left ?? w.x ?? "?";
        const T = w.top ?? w.y ?? "?";
        return `${w.hwnd}\t@${L},${T}\t${w.width}x${w.height}\t${w.process || "?"}\t${String(w.title).slice(0, 70)}`;
      });
    if (picks.length) {
      extraLines.push(
        "pick (hwnd / @left,top / size / process / title) - use hwnd for focus/ui_tree:",
        ...picks
      );
    } else {
      extraLines.push(
        "pick: EMPTY - filters matched nothing. Retry snapshot WITHOUT title, or snapshot(process=Telegram). Telegram titles are often chat names, not 'Telegram'."
      );
      if (parsed.filter && (parsed.filter.title || parsed.filter.process)) {
        extraLines.push(
          `filter_used: title=${parsed.filter.title || ""} process=${parsed.filter.process || ""}`
        );
      }
    }
    const fg = parsed.foreground;
    if (fg?.hwnd) {
      extraLines.push(
        `foreground: hwnd=${fg.hwnd} process=${fg.process || "?"} title=${String(fg.title || "").slice(0, 80)}`
      );
    }
    if (parsed.screen) {
      extraLines.push(
        `screen: ${parsed.screen.width || "?"}x${parsed.screen.height || "?"}`
      );
    }
    if (parsed.tip) extraLines.push(`tip: ${parsed.tip}`);
    if (action === "screenshot") {
      extraLines.push(
        `screenshot_file: ${parsed.path || "(saved)"} - NOT usable by text models; use pick + ui_tree.`
      );
    }
  }
  if (action === "ui_tree") {
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    summaryBits.push(`${parsed.node_count ?? nodes.length} nodes`);
    if (parsed.process) {
      extraLines.push(`tree_process: ${parsed.process}`);
      if (/ollamacode|cursor|^code$/i.test(String(parsed.process))) {
        extraLines.push(
          "WARNING: ui_tree is on the IDE, not Telegram. Re-snapshot(process=Telegram) and use that hwnd."
        );
      }
    }
    const interesting = nodes
      .filter(
        (n: any) =>
          n &&
          n.enabled !== false &&
          Number(n.w) > 2 &&
          Number(n.h) > 2 &&
          (String(n.name || "").trim() ||
            String(n.automation_id || "").trim() ||
            /Button|Edit|Document|ListItem|MenuItem|Hyperlink|ComboBox|CheckBox|TabItem|TreeItem|Text/i.test(
              String(n.type || "")
            ))
      )
      .slice(0, 50)
      .map((n: any) => {
        const label = String(n.name || n.automation_id || "(unnamed)").slice(0, 55);
        const t = String(n.type || "").replace(/^ControlType\./, "");
        const L = n.x ?? n.left ?? "?";
        const T = n.y ?? n.top ?? "?";
        return `${label}\t${t}\t@${L},${T}\t${n.w}x${n.h}\tcx=${n.cx},cy=${n.cy}\taid=${n.automation_id || ""}`;
      });
    if (interesting.length) {
      extraLines.push(
        "elements (name / type / @left,top / size / cx,cy / automation_id) - your button/field map:",
        ...interesting
      );
    } else {
      extraLines.push(
        "elements: (empty/sparse) - try max_depth 4..6, or find(name=...), or snapshot for another hwnd."
      );
    }
    if (parsed.hwnd != null) {
      extraLines.push(`tree_hwnd: ${parsed.hwnd}`);
    }
  }
  if (action === "focus") {
    summaryBits.push(parsed.focused ? "focused" : "NOT foreground");
    if (parsed.process) extraLines.push(`focused_process: ${parsed.process}`);
  }
  if (action === "find" || action === "click_element" || action === "set_value") {
    const el = parsed.element || parsed;
    if (el.name || el.automation_id || el.cx != null || parsed.name) {
      extraLines.push(
        `element: name=${el.name || parsed.name || ""} type=${el.type || parsed.type || ""} @${el.x ?? "?"},${el.y ?? "?"} ${el.w ?? "?"}x${el.h ?? "?"} cx=${el.cx ?? parsed.cx ?? "?"} cy=${el.cy ?? parsed.cy ?? "?"} aid=${el.automation_id || parsed.automation_id || ""}`
      );
    }
  }

  return [
    "[TOOL_RESULT]",
    "tool: windows_desktop",
    "status: OK",
    `action: ${action}`,
    `summary: ${summaryBits.join(" · ")}`,
    "",
    ...extraLines,
    "",
    `detail:\n${detail}`,
    `hint: ${hint}`,
    "[/TOOL_RESULT]",
  ].join("\n");
}

export function windowsDesktopModelDescription(): string {
  return [
    "Control Windows desktop apps (NOT the IDE terminal).",
    "NO vision: never use screenshot to see. Eyes = TOOL_RESULT text.",
    "Recipe: snapshot(process=Telegram) -> read match.hwnd/pick -> focus(hwnd) -> ui_tree(hwnd,max_depth=3,focus=false) -> click_element|type.",
    "Telegram window titles are often chat names - filter by process=Telegram, not title=Telegram.",
    "NEVER close/Alt+F4 messengers or IDE. keys/close need hwnd|title|process.",
    "Actions: snapshot|list_windows|foreground|focus|ui_tree|find|click_element|click|type|keys|set_value|wait|launch|minimize|maximize|close|screenshot|clipboard_get|clipboard_set.",
  ].join(" ");
}
