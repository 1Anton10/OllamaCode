import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export function ollamaCodeHome(): string {
  return path.join(os.homedir(), ".ollamacode");
}

export function registryPath(): string {
  return path.join(ollamaCodeHome(), "marketplace", "registry.json");
}

export function skillsRoot(): string {
  return path.join(ollamaCodeHome(), "skills");
}

export function rulesRoot(): string {
  return path.join(ollamaCodeHome(), "rules");
}

export function userMcpJsonPath(): string {
  const profile = process.env.OLLAMACODE_USER_DATA;
  if (profile) return path.join(profile, "User", "mcp.json");
  return path.join(os.homedir(), ".ollamacode", "mcp.json");
}

export function workspaceMcpPath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  return path.join(root, ".vscode", "mcp.json");
}

/** Active workspace folder, or env / cwd fallback when VS Code API has no folder yet. */
export function workspaceRoot(): string | undefined {
  const fromVs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (fromVs) return fromVs;
  const fromEnv = (process.env.OLLAMACODE_WORKSPACE || "").trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  // Dev: extension lives in <repo>/extensions/ollama-agent → repo has .github/skills
  const fromExt = path.resolve(__dirname, "..", "..", "..");
  if (fs.existsSync(path.join(fromExt, ".github", "skills"))) return fromExt;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, ".github", "skills"))) return cwd;
  return undefined;
}

export function workspaceSkillsDir(): string | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  const dir = path.join(root, ".github", "skills");
  return fs.existsSync(dir) ? dir : undefined;
}

export function workspaceRulesDir(): string | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  const oc = path.join(root, ".ollamacode", "rules");
  if (fs.existsSync(oc)) return oc;
  const cursor = path.join(root, ".cursor", "rules");
  if (fs.existsSync(cursor)) return cursor;
  return undefined;
}

export function expandPlaceholders(
  value: string,
  workspaceFolder?: string
): string {
  const ws = workspaceFolder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  return value
    .replace(/\$\{workspaceFolder\}/g, ws)
    .replace(/\$\{env:([^}]+)\}/g, (_, k) => process.env[k] || "");
}

export function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
