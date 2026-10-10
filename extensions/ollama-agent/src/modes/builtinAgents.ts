import * as vscode from "vscode";
import * as path from "path";

/**
 * Registers Ask + Plan custom agents so the mode picker matches stock VS Code
 * (Agent / Ask / Plan / Configure Custom Agents) without Copilot.
 */
export function registerBuiltinChatModes(context: vscode.ExtensionContext): void {
  const chatAny = vscode.chat as any;
  if (typeof chatAny.registerCustomAgentProvider !== "function") {
    console.warn("[OllamaCode] registerCustomAgentProvider unavailable — Ask/Plan modes hidden");
    return;
  }

  const agentsDir = path.join(context.extensionPath, "agents");
  const files = ["Ask.agent.md", "Plan.agent.md"];

  const emitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(emitter);

  const provider = {
    label: "OllamaCode Built-in Modes",
    onDidChangeCustomAgents: emitter.event,
    async provideCustomAgents(
      _context: unknown,
      _token: vscode.CancellationToken
    ): Promise<Array<{ uri: vscode.Uri; sessionTypes?: string[] }>> {
      return files.map((name) => ({
        uri: vscode.Uri.file(path.join(agentsDir, name)),
        sessionTypes: ["local"],
      }));
    },
  };

  context.subscriptions.push(chatAny.registerCustomAgentProvider(provider));
  console.info("[OllamaCode] registered Ask + Plan custom agents");
}
