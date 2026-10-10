/**
 * Proposed API — enable via package.json enabledApiProposals: ["interactive"]
 * @see https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.interactive.d.ts
 */
declare module "vscode" {
  export namespace interactive {
    /**
     * Transfer the focused chat session to another single-folder workspace.
     * Call before opening that folder; transfer expires after ~5 minutes.
     */
    export function transferActiveChat(toWorkspace: Uri): Thenable<void>;
  }
}
