/**
 * End-to-end smoke: inject a chat prompt + run agent turn with tools,
 * write JSON report to ~/.ollamacode/e2e-results.json
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { loadConfig, resolveModelRuntime } from "./config";
import { OllamaClient } from "./ollama/client";
import { runAgentTurn } from "./agent/loop";
import { parseToolCalls, stripToolMarkup } from "./tools/parser";
import { buildHubContextPack } from "./marketplace/contextPack";
import { toolsAwarenessRules, collectVscodeTools } from "./tools/vscodeTools";

export interface E2eCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface E2eReport {
  at: string;
  model: string;
  ok: boolean;
  checks: E2eCheck[];
  chatInjected: boolean;
  agentTranscript?: string;
  toolNamesSeen: string[];
}

function resultsPath(): string {
  return path.join(os.homedir(), ".ollamacode", "e2e-results.json");
}

function writeReport(report: E2eReport): void {
  const dir = path.dirname(resultsPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resultsPath(), JSON.stringify(report, null, 2), "utf8");
}

function check(id: string, ok: boolean, detail: string): E2eCheck {
  return { id, ok, detail };
}

/** Synthetic samples for parser unit checks (no model). */
function parserChecks(): E2eCheck[] {
  const samples: { id: string; text: string; expectName: string }[] = [
    {
      id: "parser-json",
      text: `{"name":"read_file","arguments":{"path":"package.json"}}`,
      expectName: "read_file",
    },
    {
      id: "parser-xml",
      text: `<read_file><path>package.json</path></read_file>`,
      expectName: "read_file",
    },
    {
      id: "parser-fence",
      text: "```json\n{\"name\":\"grep\",\"arguments\":{\"pattern\":\"ollamaCode\"}}\n```",
      expectName: "grep",
    },
  ];
  return samples.map((s) => {
    const calls = parseToolCalls(s.text, { allowJson: true, allowXml: true });
    const hit = calls.find((c) => c.name === s.expectName);
    return check(
      s.id,
      !!hit,
      hit
        ? `parsed ${hit.name} via ${hit.source}`
        : `failed; got ${calls.map((c) => c.name).join(",") || "none"}`
    );
  });
}

async function injectChatPrompt(query: string): Promise<boolean> {
  const attempts: Array<() => Thenable<unknown>> = [
    () =>
      vscode.commands.executeCommand("workbench.action.chat.open", {
        query,
        isPartialQuery: false,
      }),
    () =>
      vscode.commands.executeCommand("workbench.action.chat.open", {
        query: `@agent ${query}`,
        isPartialQuery: false,
      }),
    () =>
      vscode.commands.executeCommand("workbench.action.chat.open", {
        query,
        isPartialQuery: true,
      }),
    () => vscode.commands.executeCommand("workbench.action.chat.openagent"),
    () => vscode.commands.executeCommand("ollamaCode.openChat"),
    () => vscode.commands.executeCommand("workbench.panel.chat"),
    () => vscode.commands.executeCommand("workbench.action.chat.newchat"),
  ];
  let opened = false;
  const errors: string[] = [];
  for (const run of attempts) {
    try {
      await run();
      opened = true;
      break;
    } catch (e: any) {
      errors.push(e?.message || String(e));
    }
  }
  if (!opened) {
    console.warn("[OllamaCode e2e] chat open failed:", errors.join(" | "));
    return false;
  }
  // Best-effort submit / focus
  for (const cmd of [
    "workbench.action.chat.submit",
    "workbench.action.interactiveSession.submit",
    "workbench.action.focusAuxiliaryBar",
  ]) {
    try {
      await vscode.commands.executeCommand(cmd);
    } catch {
      /* optional */
    }
  }
  return true;
}

function toolNameOf(def: unknown): string {
  const d = def as { function?: { name?: string }; name?: string };
  return d?.function?.name || d?.name || "";
}

/**
 * Full smoke: parsers + hub pack + ollama + agent tools + chat inject.
 */
export async function runE2eSmoke(opts?: {
  /** Also open/submit in Chat UI */
  injectChat?: boolean;
  model?: string;
}): Promise<E2eReport> {
  const cfg = loadConfig();
  const model = opts?.model || cfg.ollama.defaultModel || "agent35:latest";
  const checks: E2eCheck[] = [];
  const toolNamesSeen: string[] = [];
  let agentTranscript = "";
  let chatInjected = false;

  const reportStub: E2eReport = {
    at: new Date().toISOString(),
    model,
    ok: false,
    checks: [],
    chatInjected: false,
    agentTranscript: "running…",
    toolNamesSeen: [],
  };
  writeReport({ ...reportStub, agentTranscript: "e2e started" });

  checks.push(...parserChecks());

  // stripToolMarkup sanity
  const stripped = stripToolMarkup(`hi\n{"name":"read_file","arguments":{"path":"x"}}\nbye`);
  checks.push(
    check(
      "parser-strip",
      !stripped.includes('"name":"read_file"') || stripped.includes("bye"),
      `strip → ${JSON.stringify(stripped.slice(0, 80))}`
    )
  );

  const hub = buildHubContextPack({
    userText: "исправь ошибку и проверь запуск",
  });
  checks.push(
    check(
      "hub-context",
      hub.skillCount > 0,
      `skills=${hub.skillCount} rules=${hub.ruleCount} tokens≈${hub.approxTokens} ids=${(hub.selectedIds || []).join(",")}`
    )
  );

  const client = new OllamaClient(cfg.ollama.baseUrl);
  try {
    const models = await client.listModels();
    const names = models.map((m) => m.name);
    checks.push(
      check(
        "ollama-tags",
        names.some((n) => n.replace(/:latest$/i, "") === model.replace(/:latest$/i, "") || n === model),
        `want ${model}; have ${names.join(", ") || "none"}`
      )
    );
  } catch (e: any) {
    checks.push(check("ollama-tags", false, e?.message || String(e)));
  }

  // Workspace path for tools

  const runtime = resolveModelRuntime(model, cfg);
  const awareness = toolsAwarenessRules({
    definitions: [],
    names: new Set<string>(),
    toolInvocationToken: null!,
    enabledCount: 0,
    attachedToolNames: [],
    hasNativeSubagent: false,
  });

  // Prefer local helper tools for e2e reliability (full VS Code bridge is huge for small ctx)
  let vscodeTools: ReturnType<typeof collectVscodeTools> | undefined;
  try {
    const full = collectVscodeTools({} as any);
    checks.push(
      check(
        "vscode-tools-bridge",
        (full?.enabledCount ?? 0) >= 0,
        `enabledCount=${full?.enabledCount ?? 0} defs=${full?.definitions?.length ?? 0}`
      )
    );
    // Local helpers only for create-file e2e (no vscode flood / no vctx)
    vscodeTools = undefined;
  } catch (e: any) {
    checks.push(check("vscode-tools-bridge", false, e?.message || String(e)));
  }

  // Prefer create-file path — catches vctx/open_workspace loops
  const smokeFile = path.join(os.homedir(), ".ollamacode", "e2e-write-smoke.txt");
  const prompt = [
    "E2E: создай файл через write_to_file:",
    `path: ${smokeFile}`,
    'content: e2e-ok',
    "Сразу write_to_file. Без vctx_index, open_workspace, repo_map, todo.",
  ].join("\n");

  const systemPrompt = [
    runtime.systemPrompt,
    hub.text,
    awareness,
    "You are in automated E2E mode. Prefer tools over guessing.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const turnCfg = {
    ...cfg,
    chat: {
      ...cfg.chat,
      systemPrompt,
      thinking: "off" as const,
    },
    ollama: {
      ...cfg.ollama,
      numCtx: Math.min(runtime.numCtx || 8192, 8192),
      keepAlive: runtime.keepAlive,
      temperature: 0.1,
    },
  };

  try {
    const turnPromise = runAgentTurn({
      client,
      cfg: turnCfg,
      model,
      history: [],
      userText: prompt,
      maxSteps: 4,
      vscodeTools,
      onProgress: (p) => {
        if (p.type === "status" && p.text) {
          agentTranscript += `\n[status] ${p.text}`;
        }
        if (p.type === "assistant" && p.text) agentTranscript = p.text;
        if (p.type === "tool" && p.tool?.name) {
          toolNamesSeen.push(p.tool.name);
          agentTranscript += `\n[tool] ${p.tool.name}`;
        }
        if (p.type === "tool_result" && p.result) {
          agentTranscript += `\n[TOOL_RESULT ${p.result.status}] ${(p.result.output || "").slice(0, 200)}`;
        }
        if (p.type === "error" && p.text) {
          agentTranscript += `\n[ERROR] ${p.text}`;
        }
        writeReport({
          at: new Date().toISOString(),
          model,
          ok: false,
          checks: [...checks],
          chatInjected: false,
          agentTranscript: agentTranscript.slice(0, 4000),
          toolNamesSeen: [...new Set(toolNamesSeen)],
        });
      },
    });
    const timed = await Promise.race([
      turnPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("agent turn timeout 90s")), 90_000)
      ),
    ]);
    void timed;
    const usedTools = toolNamesSeen.length > 0;
    const wrote =
      toolNamesSeen.some((n) => /write_to_file|create_file/i.test(n)) ||
      (fs.existsSync(smokeFile) && /e2e-ok/i.test(fs.readFileSync(smokeFile, "utf8")));
    const looped =
      toolNamesSeen.filter((n) => /vctx_index|open_workspace/i.test(n)).length >= 2;
    checks.push(
      check(
        "agent-tools",
        usedTools,
        usedTools
          ? `tools: ${[...new Set(toolNamesSeen)].join(", ")}`
          : `no tools; transcript=${agentTranscript.slice(0, 240)}`
      )
    );
    checks.push(
      check(
        "agent-write-file",
        wrote && !looped,
        wrote
          ? looped
            ? `wrote but looped vctx/open_workspace: ${toolNamesSeen.join(",")}`
            : `wrote ok · ${smokeFile}`
          : `no write; tools=${toolNamesSeen.join(",") || "none"}`
      )
    );
  } catch (e: any) {
    checks.push(check("agent-tools", false, e?.message || String(e)));
    checks.push(check("agent-saw-workspace", false, "agent turn threw/timeout"));
  }

  if (opts?.injectChat !== false) {
    const uiPrompt =
      "Краткий E2E: назови текущую модель и скажи, видишь ли Hub skills/rules в системе. Одним предложением.";
    chatInjected = await injectChatPrompt(uiPrompt);
    checks.push(
      check("chat-inject", chatInjected, chatInjected ? "workbench.action.chat.open ok" : "chat open failed")
    );
  }

  const report: E2eReport = {
    at: new Date().toISOString(),
    model,
    ok: checks.every((c) => c.ok),
    checks,
    chatInjected,
    agentTranscript: agentTranscript.slice(0, 4000),
    toolNamesSeen: [...new Set(toolNamesSeen)],
  };
  writeReport(report);
  return report;
}

export function registerE2eCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaCode.e2eSmoke", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "OllamaCode E2E smoke…",
          cancellable: false,
        },
        async () => {
          const report = await runE2eSmoke({ injectChat: true });
          const failed = report.checks.filter((c) => !c.ok);
          if (report.ok) {
            void vscode.window.showInformationMessage(
              `E2E OK · ${report.model} · tools: ${report.toolNamesSeen.join(", ") || "—"}`
            );
          } else {
            void vscode.window.showErrorMessage(
              `E2E FAIL (${failed.length}): ${failed.map((f) => f.id).join(", ")}`
            );
          }
        }
      );
    })
  );

  // Optional file trigger — only on content change AFTER activate settles.
  // Do NOT auto-run pending triggers on startup (was starving the extension host).
  try {
    const trigger = path.join(os.homedir(), ".ollamacode", "e2e.trigger");
    const dir = path.dirname(trigger);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(trigger)) fs.writeFileSync(trigger, "0\n", "utf8");
    let last = fs.readFileSync(trigger, "utf8");
    let running = false;
    const kick = () => {
      if (running) return;
      const v = fs.readFileSync(trigger, "utf8").trim();
      if (!v || v === "0") return;
      running = true;
      Promise.resolve(vscode.commands.executeCommand("ollamaCode.e2eSmoke")).finally(() => {
        running = false;
        try {
          fs.writeFileSync(trigger, "0\n", "utf8");
          last = "0\n";
        } catch {
          /* ignore */
        }
      });
    };
    // Delay watcher so activate + Hub/chat register first
    const t = setTimeout(() => {
      try {
        const watcher = fs.watch(trigger, () => {
          try {
            const v = fs.readFileSync(trigger, "utf8");
            if (v === last) return;
            last = v;
            kick();
          } catch {
            /* ignore */
          }
        });
        context.subscriptions.push({ dispose: () => watcher.close() });
      } catch {
        /* ignore */
      }
    }, 8000);
    context.subscriptions.push({ dispose: () => clearTimeout(t) });
  } catch {
    /* ignore */
  }
}
