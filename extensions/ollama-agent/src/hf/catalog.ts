import * as vscode from "vscode";
import { HfBrowserPanel } from "./browser";

/** Opens HF browser panel (search + author filters + download). */
export async function interactivePullModel(
  onModelsChanged: () => void,
  extensionUri?: vscode.Uri
) {
  const uri = extensionUri || vscode.Uri.file(__dirname);
  HfBrowserPanel.open(uri, onModelsChanged);
}

// Re-exports for older imports
export { searchHfModels as searchHfGguf } from "./api";
export type { HfModelHit } from "./api";
export { listHfGgufFiles } from "./api";
