/**
 * OLLAMACODE_LIVE_FOLDER — patch workbench bundle so single-folder → single-folder
 * replace uses updateWorkspaceFolders WITHOUT createAndEnterWorkspace / EH restart.
 *
 * Usage:
 *   node scripts/_patch-live-folder.mjs
 *   node scripts/_patch-live-folder.mjs path/to/workbench.desktop.main.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MARKER = "OLLAMACODE_LIVE_FOLDER";

const DEFAULTS = [
  path.join(root, ".cache/vscode-140/out-fast/vs/workbench/workbench.desktop.main.js"),
  path.join(root, ".cache/vscode-140/out/vs/workbench/workbench.desktop.main.js"),
];

const LIVE_METHOD = `
  async liveReplaceSingleFolderWorkspace(folder) {
    // ${MARKER}: keep EH + chat alive; swap the only root in-place
    const uri = folder.uri;
    const oldWorkspace = toWorkspaceIdentifier(this.contextService.getWorkspace());
    const identifier = { id: this.contextService.getWorkspace().id, uri };
    this.logService.info(\`[${MARKER}] \${uri.toString()}\`);
    await this.contextService.initialize(identifier);
    await this.fireDidEnterWorkspace(oldWorkspace, identifier);
  }
`;

const OLD_BRANCH = `if (this.includesSingleFolderWorkspace(foldersToDelete)) {
        return this.createAndEnterWorkspace(foldersToAdd);
      }`;

const NEW_BRANCH = `if (this.includesSingleFolderWorkspace(foldersToDelete)) {
        // ${MARKER}
        if (foldersToAdd.length === 1) {
          return this.liveReplaceSingleFolderWorkspace(foldersToAdd[0]);
        }
        return this.createAndEnterWorkspace(foldersToAdd);
      }`;

function patchBundle(file) {
  if (!fs.existsSync(file)) {
    console.log(`· skip missing ${file}`);
    return false;
  }
  let s = fs.readFileSync(file, "utf8");
  if (s.includes(MARKER)) {
    console.log(`· already patched ${path.basename(path.dirname(file))}/…/${path.basename(file)}`);
    return true;
  }
  if (!s.includes(OLD_BRANCH)) {
    console.warn(`⚠ pattern not found in ${file}`);
    return false;
  }
  s = s.replace(OLD_BRANCH, NEW_BRANCH);
  // Insert method before includesSingleFolderWorkspace(folders)
  const methodAnchor = "includesSingleFolderWorkspace(folders) {";
  if (!s.includes(methodAnchor)) {
    console.warn(`⚠ method anchor missing in ${file}`);
    return false;
  }
  if (!s.includes("liveReplaceSingleFolderWorkspace(folder)")) {
    s = s.replace(methodAnchor, LIVE_METHOD + "\n  " + methodAnchor);
  }
  if (!s.includes(MARKER)) {
    console.warn(`⚠ marker missing after patch: ${file}`);
    return false;
  }
  fs.writeFileSync(file, s);
  console.log(`✓ ${MARKER} → ${file}`);
  return true;
}

const args = process.argv.slice(2).filter(Boolean);
const targets = args.length ? args : DEFAULTS;
let ok = 0;
for (const t of targets) {
  if (patchBundle(path.resolve(t))) ok++;
}
if (!ok) process.exitCode = 1;
