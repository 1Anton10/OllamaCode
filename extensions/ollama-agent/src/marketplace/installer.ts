import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { MarketplaceItem } from "./types";
import {
  ensureDir,
  ollamaCodeHome,
  rulesRoot,
  skillsRoot,
  workspaceRulesDir,
  workspaceSkillsDir,
} from "./paths";
import {
  mcpEntryFromItem,
  removeMcpServer,
  reloadMcp,
  upsertMcpServer,
} from "./mcpConfig";
import { loadRegistry, saveRegistry, setRecord } from "./registry";
import { evaluateFit } from "./modelMatch";

const execFileAsync = promisify(execFile);

function copyDir(src: string, dest: string): void {
  ensureDir(dest);
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function installGitSparse(item: MarketplaceItem): Promise<string> {
  const inst = item.install;
  if (!inst?.repo || !inst.paths?.length) throw new Error("invalid git install spec");
  const root =
    item.kind === "rule"
      ? rulesRoot()
      : item.kind === "mcp"
        ? path.join(ollamaCodeHome(), "mcp")
        : skillsRoot();
  const dest = path.join(root, item.id);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  ensureDir(dest);
  const tmp = path.join(root, `.tmp-${item.id}`);
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--filter=blob:none", "--sparse", inst.repo, tmp],
    { timeout: 180_000 }
  );
  const paths = inst.paths.filter((p) => p && p !== ".");
  if (paths.length) {
    await execFileAsync("git", ["sparse-checkout", "set", ...paths], {
      cwd: tmp,
      timeout: 60_000,
    });
    for (const sub of paths) {
      const srcSub = path.join(tmp, sub);
      if (fs.existsSync(srcSub)) copyDir(srcSub, path.join(dest, path.basename(sub)));
    }
  } else {
    for (const name of fs.readdirSync(tmp)) {
      if (name === ".git") continue;
      const s = path.join(tmp, name);
      const d = path.join(dest, name);
      if (fs.statSync(s).isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return dest;
}

async function installBuiltin(item: MarketplaceItem): Promise<string> {
  const base =
    item.kind === "rule" ? path.join(rulesRoot(), item.id) : path.join(skillsRoot(), item.id);
  if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true });
  ensureDir(base);
  for (const f of item.install?.files || []) {
    const fp = path.join(base, f.dest);
    ensureDir(path.dirname(fp));
    fs.writeFileSync(fp, f.content, "utf8");
  }
  return base;
}

function linkIntoWorkspace(item: MarketplaceItem, localPath: string): void {
  if (item.kind === "skill") {
    const wsSkills = workspaceSkillsDir();
    if (!wsSkills) return;
    ensureDir(wsSkills);
    const linkName = item.id.replace(/^skill-/, "");
    const target = path.join(wsSkills, linkName);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    copyDir(localPath, target);
  }
  if (item.kind === "rule") {
    const wsRules = workspaceRulesDir();
    if (!wsRules) return;
    ensureDir(wsRules);
    for (const f of fs.readdirSync(localPath)) {
      fs.copyFileSync(path.join(localPath, f), path.join(wsRules, f));
    }
  }
}

export class MarketplaceService {
  constructor(private extensionPath: string) {}

  getModelName(): string {
    return vscode.workspace.getConfiguration("ollamaCode").get<string>("defaultModel") || "agent36:latest";
  }

  async install(item: MarketplaceItem): Promise<void> {
    if (item.kind === "link") {
      if (item.url) await vscode.env.openExternal(vscode.Uri.parse(item.url));
      return;
    }
    if (item.kind === "mcp") {
      // Prefer npm/npx MCP entry; optionally clone git pack for local servers
      let localPath: string | undefined;
      if (item.install?.type === "git-sparse" && item.install.repo?.includes("huggingface")) {
        localPath = await installGitSparse(item);
      } else if (
        item.install?.type === "git-sparse" &&
        item.mcp &&
        !/@modelcontextprotocol\//.test(item.mcp.args?.join(" ") || "")
      ) {
        localPath = await installGitSparse(item);
        // Point MCP at local entry if present
        const candidates = ["index.js", "dist/index.js", "src/index.js", "server.py"];
        for (const c of candidates) {
          const fp = path.join(localPath, c);
          if (!fs.existsSync(fp)) continue;
          if (c.endsWith(".py")) {
            item.mcp = { ...item.mcp, command: "python", args: [fp] };
          } else {
            item.mcp = { ...item.mcp, command: "node", args: [fp] };
          }
          break;
        }
      }
      const entry = mcpEntryFromItem(item);
      if (!entry || !item.mcp) throw new Error("MCP spec missing");
      upsertMcpServer(item.mcp.key, entry);
      let reg = loadRegistry();
      reg = setRecord(reg, item.id, {
        installed: true,
        enabled: true,
        installedAt: new Date().toISOString(),
        mcpKey: item.mcp.key,
        path: localPath,
      });
      saveRegistry(reg);
      await reloadMcp();
      return;
    }
    if (item.kind === "skill" || item.kind === "rule") {
      let localPath: string;
      if (item.install?.type === "git-sparse") localPath = await installGitSparse(item);
      else localPath = await installBuiltin(item);
      linkIntoWorkspace(item, localPath);
      let reg = loadRegistry();
      reg = setRecord(reg, item.id, {
        installed: true,
        enabled: true,
        installedAt: new Date().toISOString(),
        path: localPath,
      });
      saveRegistry(reg);
      return;
    }
  }

  async uninstall(item: MarketplaceItem): Promise<void> {
    if (item.kind === "mcp" && item.mcp) {
      removeMcpServer(item.mcp.key);
      await reloadMcp();
    }
    if (item.kind === "skill" || item.kind === "rule") {
      const reg = loadRegistry();
      const rec = reg.items[item.id];
      if (rec?.path && fs.existsSync(rec.path)) fs.rmSync(rec.path, { recursive: true, force: true });
    }
    let reg = loadRegistry();
    reg = setRecord(reg, item.id, { installed: false, enabled: false, path: undefined, mcpKey: undefined });
    saveRegistry(reg);
  }

  async setEnabled(item: MarketplaceItem, enabled: boolean): Promise<void> {
    if (item.kind === "mcp" && item.mcp) {
      if (enabled) {
        const entry = mcpEntryFromItem(item);
        if (entry) upsertMcpServer(item.mcp.key, entry);
      } else {
        removeMcpServer(item.mcp.key);
      }
      await reloadMcp();
    }
    let reg = loadRegistry();
    reg = setRecord(reg, item.id, { enabled, installed: reg.items[item.id]?.installed ?? enabled });
    saveRegistry(reg);
  }

  async seedDefaults(catalog: MarketplaceItem[]): Promise<void> {
    const model = this.getModelName();
    let reg = loadRegistry();

    // Disable / skip anything that conflicts with the active model
    for (const item of catalog) {
      const fit = evaluateFit(item, model);
      if (fit.status === "conflict" && reg.items[item.id]?.enabled) {
        try {
          await this.setEnabled(item, false);
        } catch {
          /* ignore */
        }
      }
    }
    reg = loadRegistry();

    for (const item of catalog) {
      const fit = evaluateFit(item, model);
      const should =
        item.defaultInstall ||
        item.fit === "required" ||
        (item.fit === "recommended" && fit.status === "compatible" && item.install?.type === "builtin");
      if (!should) continue;
      if (fit.status === "conflict" || fit.status === "needs-env" || fit.status === "external") continue;
      if (reg.items[item.id]?.installed) continue;
      try {
        await this.install(item);
        reg = loadRegistry();
      } catch (e: any) {
        console.warn(`OllamaCode seed ${item.id}:`, e?.message || e);
      }
    }
  }
}
