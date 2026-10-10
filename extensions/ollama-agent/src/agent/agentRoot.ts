import * as path from "path";
import * as vscode from "vscode";

/**
 * Logical agent workspace root.
 * With OLLAMACODE_LIVE_FOLDER host patch, updateWorkspaceFolders(0, n, {uri})
 * replaces the single root in-place without openFolder / EH kill.
 */
let overrideRoot: string | undefined;

export function getAgentRoot(): string | undefined {
  return overrideRoot;
}

export function setAgentRoot(folder: string | undefined): void {
  if (!folder) {
    overrideRoot = undefined;
    return;
  }
  overrideRoot = path.normalize(folder);
}

export function clearAgentRoot(): void {
  overrideRoot = undefined;
}

/** Effective root for tools: override → first workspace folder → cwd. */
export function resolveWorkspaceRoot(): string {
  if (overrideRoot) return overrideRoot;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

/**
 * Switch the open folder in-place (no vscode.openFolder).
 * Host patch OLLAMACODE_LIVE_FOLDER makes 1→1 replace keep EH + chat alive.
 */
export function switchWorkspaceFolderInPlace(folder: string): {
  ok: boolean;
  mode: "unchanged" | "replaced" | "added" | "agent_only";
  note: string;
} {
  const uri = vscode.Uri.file(folder);
  const norm = path.normalize(folder);
  const folders = vscode.workspace.workspaceFolders || [];
  const idx = folders.findIndex(
    (f) => path.normalize(f.uri.fsPath).toLowerCase() === norm.toLowerCase()
  );

  setAgentRoot(norm);

  if (idx === 0 && folders.length === 1) {
    return {
      ok: true,
      mode: "unchanged",
      note: "уже текущий workspace root",
    };
  }

  if (idx > 0) {
    // Already present — promote via full replace so only this root remains
    const replaced = vscode.workspace.updateWorkspaceFolders(0, folders.length, {
      uri,
      name: path.basename(norm),
    });
    return replaced
      ? {
          ok: true,
          mode: "replaced",
          note: `workspace → ${norm} (live replace)`,
        }
      : {
          ok: true,
          mode: "unchanged",
          note: `папка уже в workspace (index ${idx}); agent root → ${norm}`,
        };
  }

  if (folders.length === 0) {
    const ok = vscode.workspace.updateWorkspaceFolders(0, 0, {
      uri,
      name: path.basename(norm),
    });
    return ok
      ? {
          ok: true,
          mode: "added",
          note: `opened as workspace root: ${norm}`,
        }
      : {
          ok: true,
          mode: "agent_only",
          note: `agent root → ${norm} (Explorer update failed)`,
        };
  }

  // Replace all roots with the target (1→1 live path when host patch is present)
  const replaced = vscode.workspace.updateWorkspaceFolders(0, folders.length, {
    uri,
    name: path.basename(norm),
  });
  if (replaced) {
    void vscode.commands.executeCommand("revealInExplorer", uri);
    return {
      ok: true,
      mode: "replaced",
      note: `workspace → ${norm} (live in-place, без openFolder)`,
    };
  }

  return {
    ok: true,
    mode: "agent_only",
    note: `agent root → ${norm} (updateWorkspaceFolders rejected; tools use this path)`,
  };
}
