// ---------------------------------------------------------------------------
// OLLAMACODE_LIVE_FOLDER — single-folder replace without EH restart / openFolder
// ---------------------------------------------------------------------------
patchFile(
  "src/vs/workbench/services/workspaces/browser/abstractWorkspaceEditingService.ts",
  "OLLAMACODE_LIVE_FOLDER",
  (src) => {
    if (src.includes("OLLAMACODE_LIVE_FOLDER")) return src;
    let out = src;
    const nl = out.includes("\r\n") ? "\r\n" : "\n";
    if (!out.includes("ISingleFolderWorkspaceIdentifier")) {
      out = out.replace(
        "IWorkspaceIdentifier, toWorkspaceIdentifier,",
        "IWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, toWorkspaceIdentifier,"
      );
    }
    const oldBranch = [
      "if (this.includesSingleFolderWorkspace(foldersToDelete)) {",
      "\t\t\t\treturn this.createAndEnterWorkspace(foldersToAdd);",
      "\t\t\t}",
    ].join(nl);
    const newBranch = [
      "if (this.includesSingleFolderWorkspace(foldersToDelete)) {",
      "\t\t\t\t// OLLAMACODE_LIVE_FOLDER — replace 1→1 without createAndEnterWorkspace / EH kill",
      "\t\t\t\tif (foldersToAdd.length === 1) {",
      "\t\t\t\t\treturn this.liveReplaceSingleFolderWorkspace(foldersToAdd[0]);",
      "\t\t\t\t}",
      "\t\t\t\treturn this.createAndEnterWorkspace(foldersToAdd);",
      "\t\t\t}",
    ].join(nl);
    if (!out.includes(oldBranch)) {
      console.warn("⚠ live-folder source branch pattern mismatch");
      return src;
    }
    out = out.replace(oldBranch, newBranch);
    const method = [
      "",
      "\t/** OLLAMACODE_LIVE_FOLDER: swap the only root in-place; keep EH + chat alive. */",
      "\tprivate async liveReplaceSingleFolderWorkspace(folder: IWorkspaceFolderCreationData): Promise<void> {",
      "\t\tconst uri = removeTrailingPathSeparator(folder.uri);",
      "\t\tconst oldWorkspace = toWorkspaceIdentifier(this.contextService.getWorkspace());",
      "\t\tconst identifier: ISingleFolderWorkspaceIdentifier = {",
      "\t\t\tid: this.contextService.getWorkspace().id,",
      "\t\t\turi,",
      "\t\t};",
      "\t\tthis.logService.info(`[OLLAMACODE_LIVE_FOLDER] ${uri.toString()}`);",
      "\t\tawait this.contextService.initialize(identifier);",
      "\t\tawait this.fireDidEnterWorkspace(oldWorkspace, identifier);",
      "\t}",
      "",
    ].join(nl);
    const anchor = "\tprivate includesSingleFolderWorkspace(folders: URI[]): boolean {";
    if (!out.includes(anchor)) {
      console.warn("⚠ live-folder method anchor mismatch");
      return src;
    }
    out = out.replace(anchor, method + anchor);
    return out;
  }
);

{
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "_patch-live-folder.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (r.status) console.warn("⚠ live-folder bundle patch exited", r.status);
}
