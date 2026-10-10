import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { expandPlaceholders, ensureDir, userMcpJsonPath, workspaceMcpPath } from "./paths";
import { MarketplaceItem } from "./types";

type McpFile = { mcpServers?: Record<string, unknown> };

function readMcpFile(p: string): McpFile {
  if (!fs.existsSync(p)) return { mcpServers: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as McpFile;
  } catch {
    return { mcpServers: {} };
  }
}

function writeMcpFile(p: string, data: McpFile): void {
  ensureDir(path.dirname(p));
  if (!data.mcpServers) data.mcpServers = {};
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

export function mcpEntryFromItem(item: MarketplaceItem): Record<string, unknown> | undefined {
  if (!item.mcp) return undefined;
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const entry: Record<string, unknown> = {
    command: item.mcp.command,
    args: item.mcp.args.map((a) => expandPlaceholders(a, ws)),
  };
  if (item.mcp.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.mcp.env)) {
      env[k] = expandPlaceholders(v, ws);
    }
    if (Object.keys(env).length) entry.env = env;
  }
  return entry;
}

export function upsertMcpServer(key: string, server: Record<string, unknown>): void {
  const targets = [userMcpJsonPath(), workspaceMcpPath()].filter(Boolean) as string[];
  for (const p of targets) {
    const doc = readMcpFile(p);
    doc.mcpServers![key] = server;
    writeMcpFile(p, doc);
  }
}

export function removeMcpServer(key: string): void {
  const targets = [userMcpJsonPath(), workspaceMcpPath()].filter(Boolean) as string[];
  for (const p of targets) {
    const doc = readMcpFile(p);
    if (doc.mcpServers?.[key]) {
      delete doc.mcpServers[key];
      writeMcpFile(p, doc);
    }
  }
}

export async function reloadMcp(): Promise<void> {
  for (const id of ["mcp.reloadServers", "workbench.mcp.reload", "mcp.reload"]) {
    try {
      await vscode.commands.executeCommand(id);
      return;
    } catch {
      /* try next */
    }
  }
}

export function seedDefaultMcpFromFile(defaultsPath: string): void {
  if (!fs.existsSync(defaultsPath)) return;
  const defaults = readMcpFile(defaultsPath);
  const userPath = userMcpJsonPath();
  const user = readMcpFile(userPath);
  let changed = false;
  for (const [k, v] of Object.entries(defaults.mcpServers || {})) {
    if (!user.mcpServers![k]) {
      user.mcpServers![k] = v as Record<string, unknown>;
      changed = true;
    }
  }
  if (changed) writeMcpFile(userPath, user);
  const wsPath = workspaceMcpPath();
  if (wsPath && !fs.existsSync(wsPath)) {
    writeMcpFile(wsPath, defaults);
  }
}
