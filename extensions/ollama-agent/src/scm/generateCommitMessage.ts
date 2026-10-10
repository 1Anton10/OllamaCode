import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { OllamaClient } from "../ollama/client";
import { loadConfig, resolveModelRuntime } from "../config";
import { resolveInstalledOllamaModel } from "../ollama/resolveModel";

const execFileAsync = promisify(execFile);

type GitAPI = {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  openRepository?(uri: vscode.Uri): Thenable<GitRepository | null>;
};

type GitRepository = {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  state: {
    indexChanges: { uri: vscode.Uri }[];
    workingTreeChanges: { uri: vscode.Uri }[];
    untrackedChanges?: { uri: vscode.Uri }[];
    HEAD?: { name?: string };
  };
  status(): Thenable<void>;
};

async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();
  const exports = ext.exports as { getAPI?(v: number): GitAPI } | undefined;
  return exports?.getAPI?.(1);
}

async function resolveRepo(
  api: GitAPI,
  rootUri?: vscode.Uri
): Promise<GitRepository | undefined> {
  if (rootUri) {
    const byUri = api.getRepository(rootUri);
    if (byUri) return byUri;
    if (api.openRepository) {
      const opened = await api.openRepository(rootUri);
      if (opened) return opened;
    }
  }
  if (api.repositories.length === 1) return api.repositories[0];
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder) {
    const byFolder = api.getRepository(folder);
    if (byFolder) return byFolder;
  }
  return api.repositories[0];
}

async function gitDiff(cwd: string, staged: boolean): Promise<string> {
  const args = staged
    ? ["diff", "--cached", "--no-color", "--stat", "-U3"]
    : ["diff", "HEAD", "--no-color", "--stat", "-U3"];
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return stdout || "";
  } catch {
    // Untracked-only repos: fall back to status + name-status
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--porcelain", "-u"],
        { cwd, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "utf8" }
      );
      return stdout || "";
    } catch {
      return "";
    }
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(+${s.length - max} chars truncated)`;
}

function cleanMessage(raw: string): string {
  let t = raw.trim();
  // Drop leaked thinking tags if model put the answer in content anyway
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  t = t.replace(/<\/?think>/gi, "").trim();
  const fence = t.match(/```(?:\w*)?\r?\n?([\s\S]*?)```/);
  if (fence?.[1]?.trim()) t = fence[1].trim();
  t = t.replace(/^["'`]+|["'`]+$/g, "");
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^commit message:?$/i.test(l));
  if (!lines.length) return "";
  const subject = lines[0].replace(/^(subject|message)\s*:\s*/i, "").slice(0, 120);
  const body = lines.slice(1).join("\n").trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/** Qwen/agent36 often leaves content empty and puts the message in `thinking`. */
function rawFromChatMessage(message: {
  content?: string;
  thinking?: string;
}): string {
  const content = String(message?.content || "").trim();
  if (content) return content;
  const thinking = String(message?.thinking || "").trim();
  if (!thinking) return "";
  const fence = thinking.match(/```(?:\w*)?\r?\n?([\s\S]*?)```/);
  if (fence?.[1]?.trim()) return fence[1].trim();
  const lines = thinking
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/^(okay|ok|wait|hmm|thinking|размышл|пользователь|нужно|следует|я (должен|сейчас)|the user)/i.test(
          l
        ) && l.length <= 160
    );
  return lines.at(-1) || thinking.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) || "";
}

/**
 * Generate a commit message from current git changes via local Ollama,
 * then write it into the SCM input box.
 */
export async function generateCommitMessage(
  rootUri?: vscode.Uri,
  _context?: unknown,
  token?: vscode.CancellationToken
): Promise<void> {
  const api = await getGitApi();
  if (!api) {
    void vscode.window.showErrorMessage("Git extension недоступен.");
    return;
  }
  const repo = await resolveRepo(api, rootUri);
  if (!repo) {
    void vscode.window.showErrorMessage("Репозиторий Git не найден.");
    return;
  }

  try {
    await repo.status();
  } catch {
    /* best effort */
  }

  const staged =
    repo.state.indexChanges.length > 0
      ? true
      : false;
  const changeCount =
    repo.state.indexChanges.length +
    repo.state.workingTreeChanges.length +
    (repo.state.untrackedChanges?.length ?? 0);

  if (changeCount === 0) {
    void vscode.window.showInformationMessage("Нет изменений для commit message.");
    return;
  }

  const cwd = repo.rootUri.fsPath;
  let diff = await gitDiff(cwd, staged);
  if (!diff.trim() && !staged) {
    diff = await gitDiff(cwd, true);
  }
  if (!diff.trim()) {
    // Last resort: list paths
    const paths = [
      ...repo.state.indexChanges,
      ...repo.state.workingTreeChanges,
      ...(repo.state.untrackedChanges ?? []),
    ].map((c) => c.uri.fsPath);
    diff = paths.map((p) => `changed: ${p}`).join("\n");
  }

  const cfg = loadConfig();
  const client = new OllamaClient(cfg.ollama.baseUrl);
  let model: string;
  let modelNote: string | undefined;
  try {
    const resolved = await resolveInstalledOllamaModel(client);
    model = resolved.model;
    modelNote = resolved.note;
  } catch (e: any) {
    void vscode.window.showErrorMessage(
      `Не удалось сгенерировать commit message: ${e?.message || e}`
    );
    return;
  }
  const rt = resolveModelRuntime(model, cfg);
  if (modelNote) {
    void vscode.window.setStatusBarMessage(`Commit msg: ${modelNote}`, 5000);
  }
  const branch = repo.state.HEAD?.name || "HEAD";
  const scope = staged ? "staged (index)" : "working tree";

  const system = `Ты помощник для git commit messages в OllamaCode.
Правила:
- Ответь ТОЛЬКО текстом commit message, без кавычек и без пояснений.
- Первая строка — краткий subject (до 72 символов), по-русски если правки на русском/смешанные, иначе английский conventional style (feat/fix/chore/…).
- При необходимости 1–3 строки body после пустой строки.
- Не выдумывай файлы, которых нет в diff.`;

  const user = `Ветка: ${branch}
Область: ${scope}
Diff / status:\n${clip(diff, 28000)}`;

  if (token?.isCancellationRequested) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Ollama: commit message (${model})…`,
      cancellable: true,
    },
    async (_progress, cancel) => {
      try {
        const chatOpts = {
          model,
          messages: [
            { role: "system" as const, content: system },
            { role: "user" as const, content: user },
          ],
          think: false as const,
          options: {
            temperature: Math.min(0.4, rt.temperature ?? 0.3),
            num_ctx: Math.min(rt.numCtx || 8192, 16384),
            num_predict: 384,
          },
          keep_alive: rt.keepAlive,
        };
        let { message } = await client.chat(chatOpts);
        let text = cleanMessage(rawFromChatMessage(message));
        // One retry: some builds ignore omit-think and still return empty content
        if (!text && !cancel.isCancellationRequested) {
          const retry = await client.chat({
            ...chatOpts,
            messages: [
              {
                role: "system",
                content:
                  system +
                  "\nОтвет должен быть в обычном content (не в thinking). Одна строка subject.",
              },
              { role: "user", content: user },
            ],
          });
          message = retry.message;
          text = cleanMessage(rawFromChatMessage(message));
        }

        if (cancel.isCancellationRequested || token?.isCancellationRequested) return;

        if (!text) {
          void vscode.window.showWarningMessage("Модель вернула пустой commit message.");
          return;
        }
        repo.inputBox.value = text;
      } catch (e: any) {
        if (cancel.isCancellationRequested) return;
        const msg = String(e?.message || e);
        const hint = /not found|404/i.test(msg)
          ? " — смени модель в чате/хабе или ollama pull …"
          : "";
        void vscode.window.showErrorMessage(
          `Не удалось сгенерировать commit message: ${msg}${hint}`
        );
      }
    }
  );
}

export function registerGenerateCommitMessage(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ollamaCode.generateCommitMessage",
      (rootUri?: vscode.Uri, ctx?: unknown, token?: vscode.CancellationToken) =>
        generateCommitMessage(rootUri, ctx, token)
    )
  );
}
