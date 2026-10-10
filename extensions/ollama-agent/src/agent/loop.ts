import * as vscode from "vscode";
import { OllamaClient, ChatMessage } from "../ollama/client";
import { detectCapabilities, resolveThinking } from "../ollama/capabilities";
import { normalizeAssistantMarkdown } from "../ollama/assistantMarkdown";
import {
  ThinkingTagStreamParser,
  partialTagTail,
  scrubThinkLeaks,
  splitThinkingContent,
  stripThinkingTags,
} from "../ollama/thinkingTags";
import {
  parseToolCallsFromTurn,
  hasIncompleteToolMarkup,
  stripToolMarkup,
  TOOL_DEFINITIONS,
  ToolCall,
  trimToolsForContext,
} from "../tools/parser";
import { confirmToolPermission, executeTool, ToolResult } from "../tools/executor";
import {
  invokeNativeRunSubagent,
  invokeVscodeTool,
  VscodeToolBridge,
} from "../tools/vscodeTools";
import { runSubagent as runLocalSubagent } from "./subagent";
import {
  LOCAL_CONFIRM_TOOLS,
  NATIVE_CONFIRM_TOOLS,
  remapToNativeTerminal,
} from "../tools/lmTools";
import {
  denyTerminal,
  invokeNativeRunInTerminal,
  invokeTerminalCompanion,
  looksLikeLongRunningCommand,
  NATIVE_RUN_TERMINAL,
  TERMINAL_COMPANION_TOOLS,
} from "../tools/nativeTerminalBridge";
import { TerminalIdTracker } from "../tools/terminalIds";
import { OllamaCodeConfig, resolveModelRuntime, buildOllamaOptions } from "../config";
import { SubagentPool } from "./subagentPool";
import { formatTaskBoard } from "./tasks";
import {
  AgentLoopDetector,
  detectGenerationLoop,
  detectPingPongLoop,
  filterToolsForUserAsk,
  forgetReadFingerprintsForPath,
  forgetTerminalLaunchFingerprints,
  GENERATION_LOOP_NUDGE,
  isActionRequest,
  isProjectOverviewAsk,
  isToolAuditAsk,
  shellCommandMatchesToolName,
  toolDisableFamily,
  filterDefsExcluding,
  isRepeatToolCall,
  isSimpleWriteAsk,
  normalizeReadPath,
  pushCallSequence,
  rememberToolCall,
  continueWorkNudge,
  shouldRegenerateWithoutTools,
  SoftThinkingGuard,
  TERMINAL_LAUNCH_TOOLS,
  toolFingerprint,
} from "./loopGuards";
import * as fs from "fs";
import * as osNode from "os";
import * as path from "path";

function writeLastTurnDump(payload: Record<string, unknown>): void {
  try {
    const dir = path.join(osNode.homedir(), ".ollamacode");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "last-turn.json"), JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}
import { formatToolResult } from "../tools/format";
import { clearLoopMemory } from "../tools/antiLoop";
import {
  compactMessagesInPlace,
  ensurePlainUserQuery,
  estimateHistoryTokens,
  getVctxSessionKey,
  prepareMessagesForQwen,
  shrinkHeavyMessages,
} from "./chunkedContext";
import { autoRaisePhysicalCtx, autoRaiseVirtualCtx } from "./contextBudget";

const NO_USER_QUERY_RE = /no user query found in messages/i;
const SYSTEM_ORDER_RE = /system message must be at the beginning/i;

/** Cyrillic in user text → force RU thinking/reply for the whole turn (stops EN bleed). */
function languageLockFor(userText: string): string {
  const t = String(userText || "");
  const cyr = (t.match(/[А-Яа-яЁё]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  if (cyr >= 3 && cyr >= lat * 0.35) {
    return [
      "LANGUAGE LOCK (this turn): Russian only.",
      "Write ALL thinking and the final answer in Russian.",
      "Do NOT switch to English mid-thought (no «The user wants…», no «Finished with»).",
      "After TOOL_RESULT continue in Russian from the evidence — never restate the user request.",
    ].join(" ");
  }
  return "LANGUAGE: match the user's language for thinking and the final answer; do not switch mid-turn.";
}

const TOOL_RULES = `
- Language: reply AND thinking in the user's language only (RU if user wrote RU). Never switch to English or Chinese mid-thought.
- Finish-through: plan as deeply as needed (thinking length is NOT capped for quality), then execute (write→run→fix→verify). Never re-plan from scratch after tools — extend from TOOL_RESULT.
Cursor-style agent pipeline (one continuous turn, not a checklist to narrate):
1) Thinking (as long as useful) → 2) tool_calls → 3) observe TOOL_RESULT → 4) more tools OR finished answer.
- Do NOT number steps for the user ("Шаг 1…"). Just call tools and finish.
- After any TOOL_RESULT: do NOT restart the user request. Next action from the last TOOL_RESULT only (tool_call or final answer). Thinking may be long when debugging — that is fine.
- Evidence first: hypothesis → tool → act. Prefer project files + TOOL_RESULT over guessing.
- Failures: extract the ERROR from TOOL_RESULT → edit for THAT signal → re-read/re-run to verify. Do NOT rephrase the same plan without a new tool.
- One reply = tool_calls XOR a complete final answer. app-dev-verify: read→edit→run→verify (re-read after edits is expected).
- done_reason=length → continue mid-thought; do not restart.
- Create file here → write_to_file. New project → create_project_workspace. Other existing folder / continue this chat there → move_chat_workspace(path) (in-place, NO window reload). Open folder without moving chat → open_workspace. Never pass reload=true unless user asks to hard-reopen. Fork → fork_project_workspace.
- Read with read_file — never cat/type via terminal to inspect files.
- Terminal pipeline: run_in_terminal (background for bots/servers) → keep terminal_id → await_terminal(id, pattern, timeout_ms) up to 20min → read result. No match? raise timeout, change pattern, or conclude idle. kill_terminal only on break/restart/user ask. Never type tool names into the shell.
- Subagents: run_subagent(goal, wait?). wait=true → block + native Summoning plaque; wait=false → background id (no plaque). Need result later → await_subagent(id). Relay report to the user yourself.
- Context: physical num_ctx + VCTX (~80% pack). Archived → vctx_index / vctx_recall.
- Windows GUI = windows_desktop (no vision). snapshot→hwnd→focus→ui_tree→click/type.
- After BLOCKED/FAILED runtime may REMOVE that tool from the schema this turn — switch tactic using the ERROR, do not retry the same tool.
- Skill index «use runInTerminal to read a skill» — IGNORE; use read_file.
- Secrets: placeholders only. Prefer native tool_calls.
`.trim();

export interface AgentProgress {
  type: "status" | "assistant" | "thinking" | "tool" | "tool_result" | "done" | "error";
  text?: string;
  delta?: string;
  tool?: ToolCall;
  result?: ToolResult;
  thinkingEnabled?: boolean;
  thinkingNote?: string;
  /** 1-based round index for UI (unique per agent round) */
  step?: number;
  maxSteps?: number;
}

export async function runAgentTurn(params: {
  client: OllamaClient;
  cfg: OllamaCodeConfig;
  model: string;
  history: ChatMessage[];
  userText: string;
  onProgress: (p: AgentProgress) => void;
  maxSteps?: number;
  token?: { isCancellationRequested: boolean };
  vscodeTools?: VscodeToolBridge;
  cancelToken?: vscode.CancellationToken;
}): Promise<ChatMessage[]> {
  const { client, cfg, model, onProgress } = params;
  // 0 = no ceiling (UI step count ≠ this). Finite value only if explicitly set.
  const configured = params.maxSteps ?? cfg.chat.agentMaxSteps ?? 0;
  const unlimited = !configured || configured <= 0;
  const maxSteps = unlimited ? Number.MAX_SAFE_INTEGER : configured;
  const history = [...params.history];
  const token = params.token;
  const caps = await detectCapabilities(client, model);
  const thinking = resolveThinking(cfg.chat.thinking, caps, params.userText);
  const rt = resolveModelRuntime(model, cfg);
  if (typeof cfg.ollama.numCtx === "number" && cfg.ollama.numCtx > 0) {
    rt.numCtx = cfg.ollama.numCtx;
  }
  const over =
    cfg.models?.[model] || cfg.models?.[model.replace(/:latest$/i, "")] || {};
  if (typeof over.numGpu === "number") rt.numGpu = over.numGpu;
  if (typeof over.numBatch === "number") rt.numBatch = over.numBatch;
  if (typeof over.numPredict === "number") rt.numPredict = over.numPredict;
  const ollamaOpts = buildOllamaOptions(rt);
  if (ollamaOpts.num_predict === undefined || ollamaOpts.num_predict === 0) {
    ollamaOpts.num_predict = -1;
  }

  let toolDefs: unknown[] =
    params.vscodeTools?.definitions?.length ? params.vscodeTools.definitions : TOOL_DEFINITIONS;
  toolDefs = filterToolsForUserAsk(toolDefs as any[], params.userText) as typeof toolDefs;
  toolDefs = trimToolsForContext(toolDefs as unknown[], rt.numCtx) as typeof toolDefs;
  const vscodeNames = params.vscodeTools?.names ?? new Set<string>();
  const maxRegen = 5;
  let loopNudges = 0;
  const MAX_LOOP_NUDGES = 4;
  let contextRetries = 0;

  const fitHistoryToCtx = (tools: unknown[]) => {
    const toolTok = Math.ceil(JSON.stringify(tools || []).length / 4);
    const histTok = estimateHistoryTokens(history);
    const limit = Math.max(2048, rt.numCtx || 8192);
    // Leave room for reply (~15%) + tools
    const target = Math.floor(limit * 0.72) - toolTok;
    if (histTok <= target) return;
    compactMessagesInPlace(history, {
      numCtx: Math.max(2048, limit - toolTok - 256),
      virtualCtx: rt.virtualCtx || 32768,
      userText: params.userText,
      sessionKey: getVctxSessionKey(),
    });
  };
  fitHistoryToCtx(toolDefs);

  history.push({ role: "user", content: params.userText });

  onProgress({
    type: "status",
    text: "",
    thinkingEnabled: thinking.enabled,
    thinkingNote: thinking.note,
  });

  const langLock = languageLockFor(params.userText);
  if (!history.find((m) => m.role === "system")) {
    const wsHint = vscode.workspace.workspaceFolders?.length
      ? `\nТекущий workspace: ${vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath).join("; ")}. Пиши файлы сюда.`
      : "";
    history.unshift({
      role: "system",
      content: `${cfg.chat.systemPrompt}\n\n${TOOL_RULES}\n\n${langLock}${wsHint}`,
    });
  } else {
    // Refresh language lock on existing system (multi-turn / reused history)
    const sys = history.find((m) => m.role === "system");
    if (sys && !/LANGUAGE LOCK \(this turn\)/i.test(sys.content || "")) {
      sys.content = `${sys.content || ""}\n\n${langLock}`;
    } else if (sys) {
      sys.content = String(sys.content || "").replace(
        /LANGUAGE LOCK \(this turn\):[\s\S]*?(?=\n\n|$)/i,
        langLock
      );
    }
  }

  clearLoopMemory();
  // Native Built-In runSubagent = nested copy of this Agent (UI «Summoning Clippy»).
  // Default ON when the tool exists; empty/fail → local Ollama pool. Opt-out: preferNativeSubagent=false.
  const preferNative =
    vscode.workspace.getConfiguration("ollamaCode").get<boolean>("preferNativeSubagent", true) !==
    false;
  const useNativeSub =
    preferNative && Boolean(params.vscodeTools?.hasNativeSubagent);
  const subPool = new SubagentPool({
    client,
    cfg,
    model,
    maxStepsRead: 5,
    maxStepsImplement: 8,
    run: async ({ goal, mode, maxSteps, preferNative }) => {
      const local = () =>
        runLocalSubagent({
          client,
          cfg,
          model,
          goal,
          mode: mode === "implement" ? "implement" : "read",
          maxSteps,
        });
      // Native Built-In = VS Code «Summoning…» plaque. Only when caller wants to wait
      // (preferNative / implement). Background jobs stay local — no plaque, no UI hang.
      const wantNative = preferNative !== false && useNativeSub && params.vscodeTools;
      if (!wantNative) return local();
      try {
        const res = await invokeNativeRunSubagent(
          params.vscodeTools!,
          goal,
          mode === "implement" ? "implement" : "read",
          params.cancelToken,
          120_000
        );
        const body = res.detail || res.summary || res.output || "";
        if (res.ok && body && body !== "(empty tool result)") {
          return `[SUBAGENT_RESULT]\nmode: ${mode}\nbackend: native-runSubagent\ngoal: ${goal}\n${body}\n[/SUBAGENT_RESULT]`;
        }
        const localText = await local();
        return `[SUBAGENT_RESULT]\nmode: ${mode}\nbackend: local-fallback\nnative_error: ${(body || "empty/failed").slice(0, 400)}\ngoal: ${goal}\n${localText}\n[/SUBAGENT_RESULT]`;
      } catch (e: any) {
        const localText = await local();
        return `[SUBAGENT_RESULT]\nmode: ${mode}\nbackend: local-fallback\nnative_error: ${String(e?.message || e).slice(0, 400)}\ngoal: ${goal}\n${localText}\n[/SUBAGENT_RESULT]`;
      }
    },
  });
  let toolsExecuted = 0;
  let continueNudges = 0;
  /** Shared SoftThinkingGuard — stem-restate mute after tools (language-agnostic). */
  const thinkGuard = new SoftThinkingGuard();
  thinkGuard.setUserTask(params.userText);
  const seenTools = new Map<string, "OK" | "FAILED" | "OTHER">();
  /** Sliding fingerprints for A↔B ping-pong (warn late — not after one edit/read cycle). */
  const callSequence: string[] = [];
  /** Consecutive-identical guard (agent-loop-detector): blocks only after 3 in a row. */
  const loopDetector = new AgentLoopDetector({ maxIdenticalCalls: 3, windowSize: 32 });
  /** Consecutive rounds where every tool call was a blocked duplicate */
  let dupOnlyStreak = 0;
  /** How many terminal launches this turn (hard cap — stops path-spam loops) */
  let terminalLaunchCount = 0;
  const MAX_TERMINAL_LAUNCHES = 12;
  const overviewAsk = isProjectOverviewAsk(params.userText);
  const toolAuditAsk = isToolAuditAsk(params.userText);
  let overviewNudgeSent = false;
  let toolAuditNudgeSent = false;
  /** Tools removed from the schema after BLOCKED/FAILED — forces a different approach. */
  const disabledTools = new Set<string>();
  const toolFailStreak = new Map<string, number>();

  const knownToolNames = (): Set<string> => {
    const s = new Set<string>([...vscodeNames]);
    for (const d of toolDefs as any[]) {
      const n = d?.function?.name || d?.name;
      if (n) s.add(String(n));
    }
    s.add("run_subagent");
    s.add("runSubagent");
    s.add("await_subagent");
    s.add("list_subagents");
    return s;
  };

  const disableToolsFromFailure = (name: string, why: string) => {
    const family = toolDisableFamily(name);
    let added = false;
    for (const n of family) {
      if (!disabledTools.has(n)) {
        disabledTools.add(n);
        added = true;
      }
    }
    if (added) {
      history.push({
        role: "user",
        content: `[system] Tool «${family.join(", ")}» отключён до конца хода (${why}). Выбери ДРУГОЙ tool из схемы или дай итоговый ответ. Повторять отключённый — бесполезно.`,
      });
    }
  };

  const noteToolOutcome = (name: string, ok: boolean, blocked: boolean) => {
    if (ok && !blocked) {
      toolFailStreak.set(name, 0);
      return;
    }
    const n = (toolFailStreak.get(name) || 0) + 1;
    toolFailStreak.set(name, n);
    // BLOCKED once, or 2× FAILED → drop from schema (root anti-loop)
    if (blocked || n >= 2) {
      const softExplore = /^(list_files|repo_map|grep|search_files|read_file)$/i.test(name);
      if (!(blocked && softExplore)) {
        disableToolsFromFailure(name, blocked ? "BLOCKED" : `FAILED ×${n}`);
      }
    }
  };
  const terminalIds = new TerminalIdTracker();
  let usedWindowsDesktop = false;
  let recentSubagentFail = false;

  const injectFinishedSubagents = () => {
    for (const job of subPool.drainDone()) {
      if (job.status === "failed") recentSubagentFail = true;
      const body = [
        "[SUBAGENT_DONE]",
        `id: ${job.id}`,
        `status: ${job.status}`,
        `mode: ${job.mode}`,
        `goal: ${job.goal}`,
        job.result || job.error || "",
        job.status === "failed"
          ? "hint: Subagent failed — do NOT stop. Continue YOURSELF with tools (read_file / write / terminal / windows_desktop). Retry run_subagent only if useful."
          : "",
        "[/SUBAGENT_DONE]",
      ]
        .filter(Boolean)
        .join("\n");
      history.push({
        role: "tool",
        tool_name: "run_subagent",
        content: body.slice(0, 10000),
      });
      onProgress({
        type: "tool_result",
        text: `subagent ${job.id} ${job.status}`,
      });
    }
  };

  const settleSubagents = async () => {
    // Inject any finished background jobs; never spin 90s on bg workers (that was the
    // «Thinking…» hang after «subagent started in background»).
    injectFinishedSubagents();
    await subPool.settleAll(8_000);
    injectFinishedSubagents();
  };

  const generateOnce = async (opts?: { tools?: unknown[] }): Promise<{
    assistantText: string;
    thinkingText: string;
    nativeToolCalls: ToolCall[];
    doneReason?: string;
  }> => {
    let assistantText = "";
    let thinkingText = "";
    let nativeToolCalls: ToolCall[] = [];
    let doneReason: string | undefined;
    const tagParser = new ThinkingTagStreamParser();
    const streamStarted = Date.now();
    // MUST init to now — `0` made the first chunk always emit «Ollama… 0s» and split thinking.
    let lastHeartbeatAt = streamStarted;
    const toolsForCall =
      opts?.tools !== undefined
        ? opts.tools
        : filterDefsExcluding(toolDefs as unknown[], disabledTools);
    /**
     * Soft thinking filter (shared for the whole user turn):
     * after tools, allowPostToolReflection — NOT full reset — so Qwen cannot
     * reopen with «пользователь хочет / the user wants» every round.
     */
    if (toolsExecuted > 0) thinkGuard.allowPostToolReflection();
    let uiThinking = "";
    /** Hold incomplete «assistant <thi…» so SoftThinkingGuard never emits raw leak tags. */
    let thinkTagHold = "";

    const pushThink = (piece: string, flushHold = false): boolean => {
      if (!piece && !flushHold) return false;
      let buf = thinkTagHold + (piece || "");
      if (!flushHold) {
        const holdN = partialTagTail(buf);
        if (holdN > 0) {
          thinkTagHold = buf.slice(-holdN);
          buf = buf.slice(0, -holdN);
        } else {
          thinkTagHold = "";
        }
      } else {
        thinkTagHold = "";
      }
      const clean = scrubThinkLeaks(buf);
      if (clean.length === 0) return false;
      // Append only — never re-scrub prior text (keeps SoftThinkingGuard prefix stable)
      thinkingText += clean;
      const verdict = thinkGuard.filter(thinkingText);
      if (verdict.emitDelta) {
        // Keep raw tool markup in thinkingText for parseToolCallsFromTurn; hide from UI
        const show = stripToolMarkup(scrubThinkLeaks(verdict.emitDelta), {
          trim: false,
        });
        // Never drop whitespace-only deltas — they keep words from gluing
        if (show.length) {
          uiThinking += show;
          onProgress({
            type: "thinking",
            text: uiThinking,
            delta: show,
          });
        }
      }
      // Only abort extreme tape-loops with zero tools — never cut normal long reasoning
      if (
        verdict.escalate &&
        !assistantText.trim() &&
        !nativeToolCalls.length &&
        thinkingText.length > 24_000 &&
        !/<tool_call>|<function=/i.test(thinkingText)
      ) {
        doneReason = doneReason || "think_soft_cap";
        return true;
      }
      return false;
    };

    try {
      fitHistoryToCtx(toolsForCall as unknown[]);
      // Shrink tools + pin [task] at END — Ollama front-prunes; last msg must stay a plain user.
      prepareMessagesForQwen(history, params.userText, 8000);
      let lastLoopCheckAt = 0;
      for await (const chunk of client.chatStreamResilient({
        model,
        messages: history,
        think: thinking.enabled,
        tools: toolsForCall,
        options: ollamaOpts,
        keep_alive: rt.keepAlive || cfg.ollama.keepAlive,
      })) {
        if (token?.isCancellationRequested) break;
        if (chunk?.done === true || chunk?.done_reason) {
          doneReason = String(chunk.done_reason || doneReason || (chunk.done ? "stop" : ""));
        }
        const delta = chunk?.message?.content || "";
        const th = chunk?.message?.thinking || chunk?.thinking || "";

        let stopStream = false;
        if (th) stopStream = pushThink(th);
        if (delta && !stopStream) {
          const split = tagParser.push(delta);
          for (const td of split.thinkingDeltas) {
            if (pushThink(td)) {
              stopStream = true;
              break;
            }
          }
          if (!stopStream) {
            for (const cd of split.contentDeltas) {
              // scrub only — stripThinkingTags on each delta ate leading " "/"\n" chunks
              let cleaned = scrubThinkLeaks(cd);
              if (cleaned.length === 0) continue;
              // Script glue: «…содержимого.The grep…» → break so Chat doesn't jam RU+EN
              if (
                assistantText &&
                /[а-яёА-ЯЁ]$/.test(assistantText) &&
                /^[A-Za-z]/.test(cleaned)
              ) {
                cleaned = "\n\n" + cleaned;
              } else if (
                assistantText &&
                /[a-zA-Z.]$/.test(assistantText) &&
                /^[А-ЯЁа-яё]/.test(cleaned)
              ) {
                cleaned = "\n\n" + cleaned;
              }
              if (cleaned.trim()) thinkGuard.noteVisibleProgress();
              assistantText += cleaned;
              onProgress({ type: "assistant", text: assistantText, delta: cleaned });
            }
          }
        }
        if (stopStream) break;
        // Only abort on CONTENT collapse — not on normal thinking restatements.
        const grown = assistantText.length;
        if (grown - lastLoopCheckAt >= 280 || grown > 900) {
          lastLoopCheckAt = grown;
          const hit = detectGenerationLoop(assistantText);
          if (hit.looping && grown >= 180) {
            doneReason = "repeat_abort";
            break;
          }
        }
        const tcs = chunk?.message?.tool_calls;
        if (Array.isArray(tcs) && tcs.length) {
          // Tools arrived — allow reflection on results, keep goal-reopen mute
          thinkGuard.allowPostToolReflection();
          for (const tc of tcs) {
            const name = tc?.function?.name || tc?.name;
            let args = tc?.function?.arguments ?? tc?.arguments ?? {};
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                args = { raw: args };
              }
            }
            if (!name) continue;
            const id = tc.id || `native_${nativeToolCalls.length}`;
            if (
              nativeToolCalls.some(
                (x) => x.id === id || (x.name === name && x.raw === JSON.stringify(tc))
              )
            ) {
              continue;
            }
            nativeToolCalls.push({
              id,
              name,
              arguments: args,
              source: "openai",
              raw: JSON.stringify(tc),
            });
          }
        }
        const now = Date.now();
        // Heartbeat is internal only — never stream.progress (breaks thinking merge → orphan «П»)
        if (now - lastHeartbeatAt > 15000) {
          lastHeartbeatAt = now;
          onProgress({
            type: "status",
            text: `heartbeat:${Math.round((now - streamStarted) / 1000)}`,
          });
        }
      }
      // Flush held partial tags + parser remainder
      pushThink("", true);
      const flushed = tagParser.flush();
      for (const td of flushed.thinkingDeltas) {
        if (pushThink(td, true)) break;
      }
      for (const cd of flushed.contentDeltas) {
        let cleaned = scrubThinkLeaks(cd);
        if (cleaned.length === 0) continue;
        if (
          assistantText &&
          /[а-яёА-ЯЁ]$/.test(assistantText) &&
          /^[A-Za-z]/.test(cleaned)
        ) {
          cleaned = "\n\n" + cleaned;
        }
        if (cleaned.trim()) thinkGuard.noteVisibleProgress();
        assistantText += cleaned;
        onProgress({ type: "assistant", text: assistantText, delta: cleaned });
      }
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      // Qwen: second system mid-history (VCTX) or pruned user
      if (
        (NO_USER_QUERY_RE.test(msg) || SYSTEM_ORDER_RE.test(msg)) &&
        contextRetries < 4
      ) {
        contextRetries += 1;
        onProgress({
          type: "status",
          text: SYSTEM_ORDER_RE.test(msg)
            ? `Subminimizing context (fix system order ${contextRetries})`
            : `Subminimizing context (Qwen recover ${contextRetries})`,
        });
        shrinkHeavyMessages(history, Math.max(600, 1600 - contextRetries * 300));
        // Auto-raise physical KV so the turn can fit without dying
        const bumped = await autoRaisePhysicalCtx(
          model,
          rt.numCtx,
          (rt.hardwareProfile as any) || "medium"
        );
        if (bumped) {
          rt.numCtx = bumped;
          ollamaOpts.num_ctx = bumped;
        }
        const virtUp = await autoRaiseVirtualCtx(model, rt.virtualCtx || 32768);
        if (virtUp) rt.virtualCtx = virtUp;
        compactMessagesInPlace(history, {
          numCtx: Math.max(2048, Math.floor(rt.numCtx * (0.5 - contextRetries * 0.05))),
          virtualCtx: rt.virtualCtx || 32768,
          userText: params.userText,
          sessionKey: getVctxSessionKey(),
        });
        prepareMessagesForQwen(history, params.userText, 900);
        return generateOnce({ tools: toolDefs });
      }
      // Auto-subminimize: shrink history + tools and retry once on context overflow
      if (
        (e?.code === "EXCEED_CONTEXT" ||
          /exceed_context_size|exceeds the available context|n_prompt_tokens/i.test(msg)) &&
        contextRetries < 3
      ) {
        contextRetries += 1;
        onProgress({
          type: "status",
          text: `Subminimizing context (overflow ${contextRetries})`,
        });
        const bumped = await autoRaisePhysicalCtx(
          model,
          rt.numCtx,
          (rt.hardwareProfile as any) || "medium"
        );
        if (bumped) {
          rt.numCtx = bumped;
          ollamaOpts.num_ctx = bumped;
        }
        const virtUp = await autoRaiseVirtualCtx(model, rt.virtualCtx || 32768);
        if (virtUp) rt.virtualCtx = virtUp;
        toolDefs = trimToolsForContext(toolDefs as unknown[], Math.floor(rt.numCtx * 0.7));
        fitHistoryToCtx(toolDefs);
        // Drop oldest non-system messages harder
        compactMessagesInPlace(history, {
          numCtx: Math.max(2048, Math.floor(rt.numCtx * 0.55)),
          virtualCtx: rt.virtualCtx || 32768,
          userText: params.userText,
          sessionKey: getVctxSessionKey(),
        });
        prepareMessagesForQwen(history, params.userText, 1200);
        return generateOnce({ tools: toolDefs });
      }
      try {
        prepareMessagesForQwen(history, params.userText, 1600);
        const { message, raw } = await client.chat({
          model,
          messages: history,
          think: thinking.enabled,
          tools: undefined,
          options: { ...ollamaOpts, num_ctx: rt.numCtx },
          keep_alive: rt.keepAlive || cfg.ollama.keepAlive,
        });
        doneReason = String(raw?.done_reason || "stop");
        const split = splitThinkingContent(message.content || "");
        assistantText = scrubThinkLeaks(stripThinkingTags(split.content));
        thinkingText = scrubThinkLeaks(
          [message.thinking || "", split.thinking].filter(Boolean).join("\n\n")
        );
        if (thinkingText) onProgress({ type: "thinking", text: thinkingText });
        if (assistantText) onProgress({ type: "assistant", text: assistantText });
        const tcs = raw?.message?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const name = tc?.function?.name || tc?.name;
            let args = tc?.function?.arguments ?? tc?.arguments ?? {};
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                args = { raw: args };
              }
            }
            if (name) {
              nativeToolCalls.push({
                id: tc.id || `native_${nativeToolCalls.length}`,
                name,
                arguments: args,
                source: "openai",
                raw: JSON.stringify(tc),
              });
            }
          }
        }
      } catch (e2: any) {
        const msg2 = String(e2?.message || e2 || "");
        if (
          (NO_USER_QUERY_RE.test(msg2) || SYSTEM_ORDER_RE.test(msg2)) &&
          contextRetries < 4
        ) {
          contextRetries += 1;
          shrinkHeavyMessages(history, 700);
          prepareMessagesForQwen(history, params.userText, 700);
          return generateOnce({ tools: toolDefs });
        }
        throw e2;
      }
    }
    return { assistantText, thinkingText, nativeToolCalls, doneReason };
  };

  /** One more model turn with tools disabled — normal end of a turn, not a fake user poke. */
  const generateFinalAnswer = async (): Promise<{ text: string; thinking?: string }> => {
    const wrap = await generateOnce({ tools: [] });
    const text = stripToolMarkup(wrap.assistantText) || wrap.assistantText;
    return { text, thinking: wrap.thinkingText || undefined };
  };

  const normalizeCall = (raw: ToolCall): ToolCall => {
    const remapped = remapToNativeTerminal(raw.name, raw.arguments || {});
    if (!remapped) return raw;
    return { ...raw, name: remapped.name, arguments: remapped.arguments };
  };

  try {
  for (let step = 0; step < maxSteps; step++) {
    if (token?.isCancellationRequested) break;
    // Deliver background subagent results before the model thinks again
    injectFinishedSubagents();
    // Keep physical num_ctx stable: archive overflow into VCTX mid-turn
    if (rt.chunkedContext !== false) {
      const packed = compactMessagesInPlace(history, {
        numCtx: rt.numCtx,
        virtualCtx: rt.virtualCtx || 32768,
        userText: params.userText,
        sessionKey: getVctxSessionKey(),
      });
      if (packed.compacted) {
        onProgress({
          type: "status",
          // Shown as its own chat step (Subminimizing context)
          text: packed.note
            ? `Subminimizing context · ${packed.note.slice(0, 60)}`
            : "Subminimizing context",
          step: step + 1,
          maxSteps,
        });
      }
    }
    onProgress({
      type: "status",
      text: "round",
      step: step + 1,
      maxSteps,
    });

    let assistantText = "";
    let thinkingText = "";
    let nativeToolCalls: ToolCall[] = [];
    let calls: ToolCall[] = [];
    let lastDoneReason = "";

    try {
      // Same round: discard incomplete gen and sample again (no fake user pokes)
      for (let attempt = 0; attempt < maxRegen; attempt++) {
        injectFinishedSubagents();
        const gen = await generateOnce();
        assistantText = gen.assistantText;
        thinkingText = gen.thinkingText;
        nativeToolCalls = gen.nativeToolCalls;
        lastDoneReason = gen.doneReason || "";
        const parseOpts = {
          allowJson: cfg.tools.allowJson !== false,
          allowXml: cfg.tools.allowXml !== false,
        };
        // Thinking channel often holds Qwen <tool_call> — must parse both
        const parsed = parseToolCallsFromTurn(assistantText, thinkingText, parseOpts);
        calls = [...nativeToolCalls, ...parsed];
        if (calls.length) break;
        const cleaned = stripToolMarkup(assistantText) || assistantText;
        const incomplete =
          hasIncompleteToolMarkup(assistantText) || hasIncompleteToolMarkup(thinkingText);
        const empty = !cleaned.trim() && !stripToolMarkup(thinkingText).trim();
        const truncatedByLimit = /^length$/i.test(lastDoneReason);
        // Content-only loop check — never punish long reasoning restatements
        const loopHit = detectGenerationLoop(cleaned);
        if (loopHit.looping && !incomplete) {
          lastDoneReason = lastDoneReason || "repeat_abort";
          break;
        }
        if (
          attempt + 1 < maxRegen &&
          (empty ||
            incomplete ||
            truncatedByLimit ||
            shouldRegenerateWithoutTools(params.userText, cleaned, thinkingText, toolsExecuted))
        ) {
          continue;
        }
        break;
      }
    } catch (e: any) {
      onProgress({ type: "error", text: String(e?.message || e) });
      break;
    }

    const ollamaToolCalls = (nativeToolCalls.length ? nativeToolCalls : calls).map((c) => ({
      type: "function",
      function: {
        name: c.name,
        arguments: c.arguments || {},
      },
    }));
    history.push({
      role: "assistant",
      content: stripToolMarkup(assistantText) || (calls.length ? "" : assistantText),
      thinking: stripToolMarkup(thinkingText) || thinkingText || undefined,
      ...(ollamaToolCalls.length ? { tool_calls: ollamaToolCalls } : {}),
    });

    if (!calls.length) {
      const cleaned = stripToolMarkup(assistantText) || assistantText;
      const truncatedByLimit = /^length$/i.test(lastDoneReason);
      const incompleteMarkup =
        hasIncompleteToolMarkup(assistantText) || hasIncompleteToolMarkup(thinkingText);
      const loopHit = detectGenerationLoop(cleaned);
      // Soft recovery — keep going on long tasks (do not force early final)
      if (loopHit.looping && step + 1 < maxSteps && loopNudges < MAX_LOOP_NUDGES) {
        loopNudges += 1;
        history.pop();
        history.push({ role: "user", content: GENERATION_LOOP_NUDGE });
        continue;
      }
      if ((truncatedByLimit || incompleteMarkup) && step + 1 < maxSteps) {
        history.pop();
        history.push({
          role: "user",
          content: incompleteMarkup
            ? "[system] tool_call обрезан / не закрыт. Допиши полный tool_call (или native tool_calls) и продолжи. Не итог."
            : "[system] Ответ обрезан лимитом токенов (done_reason=length). Продолжи с того места или вызови tools. Не начинай заново.",
        });
        continue;
      }
      // Before first tool: silent regen for action/plan
      if (
        toolsExecuted === 0 &&
        loopNudges < MAX_LOOP_NUDGES &&
        shouldRegenerateWithoutTools(params.userText, cleaned, thinkingText, toolsExecuted) &&
        (isActionRequest(params.userText) || isSimpleWriteAsk(params.userText)) &&
        step + 1 < maxSteps
      ) {
        loopNudges += 1;
        history.pop();
        continue;
      }
      // After tools: prose-only next-step → nudge + continue (root of mid-task silence)
      if (
        toolsExecuted > 0 &&
        continueNudges < 6 &&
        shouldRegenerateWithoutTools(params.userText, cleaned, thinkingText, toolsExecuted) &&
        step + 1 < maxSteps
      ) {
        continueNudges += 1;
        history.pop();
        history.push({
          role: "user",
          content: continueWorkNudge(params.userText),
        });
        continue;
      }
      // «проверь все инструменты» — model often plans 16 and stops after 5 OK
      if (
        toolAuditAsk &&
        !toolAuditNudgeSent &&
        toolsExecuted > 0 &&
        toolsExecuted < 10 &&
        step + 1 < maxSteps
      ) {
        toolAuditNudgeSent = true;
        history.pop();
        history.push({
          role: "user",
          content:
            `[system] Аудит tools: уже вызвал ${toolsExecuted}. Пользователь просил пройтись пошире (в т.ч. пустые/ошибочные вызовы). Продолжи remaining tools через tool_calls — не своди итог, пока не покроешь основный набор (read/write/replace/terminal/vctx/…) или явно не перечислишь, что сознательно пропускаешь.`,
        });
        continue;
      }
      const board = formatTaskBoard();
      let safeCleaned = loopHit.looping
        ? cleaned.slice(0, 400).trim()
        : cleaned;
      // Thinking-only turn (Qwen): produce a short final instead of empty / endless regen
      if (!safeCleaned.trim() && thinkingText.trim().length >= 40) {
        try {
          const fin = await generateFinalAnswer();
          safeCleaned = (fin.text || "").trim() || safeCleaned;
          if (fin.thinking) {
            onProgress({ type: "thinking", text: fin.thinking, delta: fin.thinking });
          }
        } catch {
          /* keep empty — fallback below */
        }
      }
      if (!safeCleaned.trim() && thinkingText.trim()) {
        // Last resort: last non-empty paragraph of thinking as the spoken answer
        const paras = thinkingText
          .split(/\n{2,}/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 40 && !/^(\*|-|\d+\.)/m.test(s.slice(0, 12)));
        safeCleaned = paras[paras.length - 1] || thinkingText.slice(-500).trim();
      }
      if (!safeCleaned.trim()) {
        safeCleaned = isSimpleWriteAsk(params.userText)
          ? "Не удалось вызвать write_to_file — повтори запрос."
          : "Готово. Уточни, если нужно продолжить.";
      }
      const doneText =
        normalizeAssistantMarkdown(stripThinkingTags(safeCleaned) || safeCleaned) +
        (board ? `\n\n${board}` : "");
      writeLastTurnDump({
        at: new Date().toISOString(),
        model,
        doneReason: lastDoneReason || "stop",
        userText: String(params.userText || "").slice(0, 500),
        thinkingChars: thinkingText.length,
        thinkingPreview: thinkingText.slice(0, 1500),
        assistantPreview: doneText.slice(0, 1500),
        toolsExecuted,
        toolAuditAsk,
        numCtx: rt.numCtx,
        virtualCtx: rt.virtualCtx || 32768,
      });
      onProgress({ type: "done", text: doneText });
      await settleSubagents();
      return history;
    }

    // Partition: only execute new fingerprints. Rewrite terminal companion ids first
    // so invented UUIDs don't create endless FAILED→BLOCKED cycles.
    const normalized = calls.map(normalizeCall).map((c) => {
      if (!TERMINAL_COMPANION_TOOLS.test(c.name)) return c;
      const { args } = terminalIds.rewriteCompanionArgs(c.name, {
        ...(c.arguments || {}),
      });
      return { ...c, arguments: args };
    });
    const fresh: ToolCall[] = [];
    const dups: ToolCall[] = [];
    for (const c of normalized) {
      // Ping-pong only after 3 full A-B cycles — edit↔read must not trip this
      const wouldPing = detectPingPongLoop(
        [...callSequence, toolFingerprint(c.name, c.arguments)],
        3
      );
      const mapHit = isRepeatToolCall(seenTools, c.name, c.arguments);
      const consecHit = loopDetector.wouldBlock(c.name, c.arguments);
      if (mapHit || consecHit || wouldPing) dups.push(c);
      else fresh.push(c);
    }

    if (!fresh.length) {
      dupOnlyStreak += 1;
      const sample = dups[0];
      pushCallSequence(callSequence, sample.name, sample.arguments);
      loopDetector.record(sample.name, sample.arguments);
      const allTerminal = dups.every((c) => TERMINAL_COMPANION_TOOLS.test(c.name));
      const allLaunches = dups.every((c) => TERMINAL_LAUNCH_TOOLS.test(c.name));
      const allReads = dups.every((c) => /^read_file$/i.test(c.name));
      // Terminal id lost / same poll blocked — recover instead of giving up
      if (allTerminal && terminalIds.last && dupOnlyStreak < 3 && step + 1 < maxSteps) {
        const tid = terminalIds.last;
        history.push({
          role: "tool",
          tool_name: sample.name,
          content: [
            "[TOOL_RESULT]",
            `tool: ${sample.name}`,
            "status: BLOCKED",
            `summary: duplicate terminal tool — use pinned id`,
            `terminal_id: ${tid}`,
            `hint: Do NOT invent ids. Call get_terminal_output / send_to_terminal with id="${tid}" exactly. Healthy bot — leave running, remember this id; kill_terminal only if broken/restart/user asks. Or continue other non-terminal work.`,
            "[/TOOL_RESULT]",
          ].join("\n"),
        });
        history.push({
          role: "user",
          content: `[system] terminal_id=${tid}. Повтори companion-tool с этим UUID или сделай другой шаг (правка кода). Не сдавайся с «подвожу итог» из-за BLOCKED id.`,
        });
        continue;
      }
      // Same bot launch command — don't tell model to mangle the command
      if (allLaunches && dupOnlyStreak < 3 && step + 1 < maxSteps) {
        const cmd = String(sample.arguments?.command || "");
        const longRun = looksLikeLongRunningCommand(cmd, String(sample.arguments?.explanation || ""));
        const tid = terminalIds.last;
        history.push({
          role: "tool",
          tool_name: sample.name,
          content: [
            "[TOOL_RESULT]",
            `tool: ${sample.name}`,
            "status: BLOCKED",
            `summary: повтор запуска с теми же args`,
            tid ? `terminal_id: ${tid}` : "",
            longRun
              ? `hint: Бот/сервер с этой командой уже стартовал. Не меняй command ради обхода. Если процесс жив — get_terminal_output${tid ? ` id="${tid}"` : ""}. Рестарт после фикса: kill_terminal${tid ? ` id="${tid}"` : ""} → тот же run_in_terminal (после kill/правки повтор разрешён). Или windows_desktop для UI-проверки.`
              : `hint: Эта команда уже выполнялась. Смени command или сначала правь код (после write/replace повтор запуска разрешён).`,
            "[/TOOL_RESULT]",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        history.push({
          role: "user",
          content: longRun
            ? `[system] Не коверкай command. Живой бот → get_terminal_output${tid ? `(${tid})` : ""}. Рестарт → kill_terminal затем тот же run_in_terminal. UI → windows_desktop.`
            : "[system] Команда уже была. Правь код или смени command; после replace/write повторный запуск снова можно.",
        });
        continue;
      }
      const skip = formatToolResult({
        call: sample,
        status: "BLOCKED",
        summary: allReads
          ? `read_file ×3 подряд без изменений — смени подход`
          : `повтор: ${sample.name}`,
        hint:
          /^read_file$/i.test(sample.name)
            ? "3 одинаковых read подряд. Если нужна проверка после правки — сначала replace/write, потом read снова (это разрешено). Иначе другой path/offset или итог."
            : TERMINAL_LAUNCH_TOOLS.test(sample.name) && terminalIds.last
              ? `Не меняй command. get_terminal_output id=${terminalIds.last} или kill_terminal → тот же запуск. После правки файла повтор разрешён.`
              : terminalIds.last
                ? `Смени args или другой tool. Если терминал — id=${terminalIds.last}. Если задача ещё не решена — продолжай tools.`
                : "Смени args или другой tool. Не повторяй тот же FAILED вызов. Продолжай работу по ошибке из последнего TOOL_RESULT.",
      });
      onProgress({
        type: "status",
        text: "skip duplicate tool",
        step: step + 1,
        maxSteps,
      });
      history.push({ role: "tool", tool_name: sample.name, content: skip.output });
      if (dupOnlyStreak < 3 && step + 1 < maxSteps) {
        history.push({
          role: "user",
          content:
            "[system] Петля tool+args. НЕ крути тот же вызов. Возьми ошибку/данные из последнего TOOL_RESULT → правь код → потом verify (read/run). Можно перечитывать файл ПОСЛЕ правки. Не останавливайся — другой tool или другие args.",
        });
        continue;
      }
      try {
        const fin = await generateFinalAnswer();
        history.push({
          role: "assistant",
          content: fin.text,
          thinking: fin.thinking,
        });
        onProgress({
          type: "done",
          text:
            fin.text.trim() ||
            "Одинаковые tools без прогресса остановлены. Уточни следующий шаг.",
        });
      } catch {
        onProgress({
          type: "done",
          text: "Одинаковые tools без прогресса остановлены. Уточни задачу.",
        });
      }
      await settleSubagents();
      return history;
    }
    dupOnlyStreak = 0;

    const toolOpts = { subPool };

    for (const call of fresh) {
      if (token?.isCancellationRequested) break;
      onProgress({ type: "tool", tool: call, text: `${call.source}:${call.name}` });

      let result: ToolResult;
      // Model can still emit a tool we already disabled — hard-block, don't execute
      if ([...disabledTools].some((d) => d.toLowerCase() === call.name.toLowerCase())) {
        result = formatToolResult({
          call,
          status: "BLOCKED",
          summary: `${call.name} disabled this turn`,
          detail: "Этот tool снят со схемы после прошлых BLOCKED/FAILED.",
          hint: "Вызови другой tool или дай итоговый ответ.",
        });
        noteToolOutcome(call.name, false, true);
        onProgress({ type: "tool_result", result, text: result.summary });
        history.push({ role: "tool", tool_name: call.name, content: result.output });
        toolsExecuted += 1;
        continue;
      }

      const forceLocal = LOCAL_CONFIRM_TOOLS.has(call.name);
      const preferNativeConfirm =
        !forceLocal &&
        Boolean(params.vscodeTools?.toolInvocationToken) &&
        NATIVE_CONFIRM_TOOLS.has(call.name);
      const isNativeShell = call.name === NATIVE_RUN_TERMINAL;
      const isTerminalCompanion = TERMINAL_COMPANION_TOOLS.test(call.name);

      if (isNativeShell && params.vscodeTools) {
        const cmd = String(call.arguments?.command || "").trim();
        const strippedCmd = cmd.replace(/^["']|["']$/g, "");
        const looksLikeBarePath =
          /^[a-zA-Z]:\\/.test(strippedCmd) &&
          !/\.(exe|bat|cmd|ps1|py|js|mjs|ts)(\s|$|"|')/i.test(strippedCmd) &&
          !/^(cd|dir|ls|type|cat|copy|move|del|Get-|Set-|python|node|npm|pnpm|yarn|git|ollama|start)\b/i.test(
            strippedCmd
          );
        // First token equals a known tool → not a shell command (live name set, not a regex list)
        const mistakenTool = shellCommandMatchesToolName(cmd, knownToolNames());
        if (mistakenTool) {
          result = formatToolResult({
            call,
            status: "BLOCKED",
            summary: "tool name is not a shell command",
            detail: `«${cmd}» — это имя tool «${mistakenTool}», не команда терминала.`,
            hint: `Вызови tool_call ${mistakenTool} напрямую. Терминал снят со схемы на этот ход.`,
          });
        } else if (looksLikeBarePath) {
          result = formatToolResult({
            call,
            status: "FAILED",
            summary: "path is not a command",
            detail: `«${cmd}» — это путь к папке/файлу, не команда терминала.`,
            hint: "Используй list_files/read_file или спроси пользователя.",
          });
        } else if (terminalLaunchCount >= MAX_TERMINAL_LAUNCHES) {
          result = formatToolResult({
            call,
            status: "BLOCKED",
            summary: `terminal launch cap (${MAX_TERMINAL_LAUNCHES})`,
            detail: "Слишком много запусков терминала в одном ходе.",
            hint: "Терминал снят со схемы. Другой tool или итог.",
          });
        } else {
          const allowed = await confirmToolPermission(cfg, "terminal", cmd);
          if (!allowed) {
            result = denyTerminal(call, "denied by user");
          } else {
            terminalLaunchCount += 1;
            result = await invokeNativeRunInTerminal(
              call,
              params.vscodeTools,
              params.cancelToken,
              terminalIds
            );
            const miss =
              !result.ok &&
              /not found|unknown tool|no tool|is not registered|ToolError/i.test(
                `${result.summary}\n${result.detail}`
              );
            if (miss) {
              result = await executeTool(
                {
                  ...call,
                  name: "execute_command",
                  arguments: { command: call.arguments?.command, new_tab: false },
                },
                cfg,
                { skipConfirm: true, ...toolOpts }
              );
            }
          }
        }
      } else if (isTerminalCompanion && params.vscodeTools) {
        result = await invokeTerminalCompanion(
          call,
          params.vscodeTools,
          terminalIds,
          params.cancelToken
        );
      } else if (/^runSubagent$/i.test(call.name)) {
        // Never block forever on Built-In Summoning Clippy — route through pool/local
        const goal = String(
          call.arguments?.prompt || call.arguments?.goal || call.arguments?.description || ""
        ).trim();
        if (!goal) {
          recentSubagentFail = true;
          result = formatToolResult({
            call,
            status: "FAILED",
            summary: "runSubagent needs prompt/goal",
            hint: "Call run_subagent with goal=… instead.",
          });
        } else {
          try {
            const localText = await runLocalSubagent({
              client,
              cfg,
              model,
              goal,
              mode: /implement|edit|write|fix|исправ/i.test(goal) ? "implement" : "read",
              maxSteps: 8,
            });
            result = formatToolResult({
              call,
              status: "OK",
              action: "OTHER",
              summary: "runSubagent → local pool ok",
              detail: localText,
              hint: "Prefer run_subagent next time. Relay the result to the user in chat.",
            });
          } catch (e: any) {
            recentSubagentFail = true;
            result = formatToolResult({
              call,
              status: "FAILED",
              summary: `runSubagent failed: ${e?.message || e}`,
              detail: String(e?.stack || e?.message || e),
              hint: "Continue yourself with tools — do not stop with a text-only answer.",
            });
          }
        }
      } else if (
        !forceLocal &&
        params.vscodeTools &&
        (vscodeNames.has(call.name) || preferNativeConfirm)
      ) {
        result = await invokeVscodeTool(call, params.vscodeTools, params.cancelToken);
        const miss =
          !result.ok &&
          /not found|unknown tool|no tool|is not registered|ToolError/i.test(
            `${result.summary}\n${result.detail}`
          );
        if (miss) result = await executeTool(call, cfg, toolOpts);
      } else if (/^(execute_command|run_in_terminal)$/i.test(call.name)) {
        const cmd = String(call.arguments?.command || call.arguments?.cmd || "");
        const mistaken = shellCommandMatchesToolName(cmd, knownToolNames());
        if (mistaken) {
          result = formatToolResult({
            call,
            status: "BLOCKED",
            summary: "tool name is not a shell command",
            detail: `«${cmd}» — имя tool «${mistaken}», не shell.`,
            hint: `Вызови tool_call ${mistaken}.`,
          });
        } else {
          result = await executeTool(call, cfg, toolOpts);
        }
      } else {
        result = await executeTool(call, cfg, toolOpts);
      }

      noteToolOutcome(
        call.name,
        Boolean(result.ok),
        result.status === "BLOCKED" || result.status === "DENIED"
      );

      // Always harvest UUIDs from any tool output
      terminalIds.rememberFromText(`${result.detail || ""}\n${result.output || ""}`);
      if (/^windows_desktop$/i.test(call.name) && result.ok) {
        usedWindowsDesktop = true;
      }
      if (
        /^(run_subagent|await_subagent|runSubagent)$/i.test(call.name) &&
        (!result.ok ||
          /status:\s*FAILED/i.test(result.output || "") ||
          /subagent \S+ failed/i.test(result.summary || ""))
      ) {
        recentSubagentFail = true;
      } else if (/^(run_subagent|await_subagent|runSubagent)$/i.test(call.name) && result.ok) {
        recentSubagentFail = false;
      }

      // Fingerprint companions after id rewrite so polls with fixed id aren't fake "new"
      const rememberedArgs =
        isTerminalCompanion && call.arguments
          ? terminalIds.rewriteCompanionArgs(call.name, { ...call.arguments }).args
          : call.arguments;
      rememberToolCall(seenTools, call.name, rememberedArgs, result.ok);
      pushCallSequence(callSequence, call.name, rememberedArgs);
      loopDetector.record(call.name, rememberedArgs);
      // After edit or kill — same bot command may run again (restart after fix)
      if (
        result.ok &&
        (/^(write_to_file|replace_in_file|create_file)$/i.test(call.name) ||
          /^kill_terminal$/i.test(call.name))
      ) {
        forgetTerminalLaunchFingerprints(seenTools);
      }
      // After write — clear read fingerprints + consecutive streak (edit→verify)
      if (
        result.ok &&
        /^(write_to_file|replace_in_file|create_file)$/i.test(call.name)
      ) {
        const written = normalizeReadPath(call.arguments) || String(result.path || "");
        if (written) forgetReadFingerprintsForPath(seenTools, written);
        callSequence.length = 0;
        loopDetector.noteProgress();
      }
      onProgress({
        type: "tool_result",
        result,
        text: result.summary || result.output.slice(0, 400),
      });
      toolsExecuted += 1;
      history.push({
        role: "tool",
        tool_name: call.name,
        content: result.output,
      });

      // File tool failed → fix from ERROR (don't verbal-loop). Terminal has its own nudges below.
      if (
        !result.ok &&
        /^(write_to_file|replace_in_file|create_file|read_file)$/i.test(call.name) &&
        step + 1 < maxSteps
      ) {
        const errBite = `${result.summary || ""}\n${result.detail || ""}`.slice(0, 400);
        history.push({
          role: "user",
          content:
            `[system] ${call.name} FAILED. Не пересказывай план. Исправь по ошибке → снова read/replace/run для verify.\n${errBite}`,
        });
      }

      // «посмотри проект»: soft nudge after map/list — still allow reads for detail
      if (
        overviewAsk &&
        !overviewNudgeSent &&
        result.ok &&
        /^(list_files|repo_map)$/i.test(call.name) &&
        toolsExecuted >= 2 &&
        step + 1 < maxSteps
      ) {
        overviewNudgeSent = true;
        history.push({
          role: "user",
          content:
            "[system] Обзор: list/map по этому пути уже есть. Можно list_files других папок, read_file ключевых файлов, затем итог. Не повторяй тот же path.",
        });
      }

      // Failed run with traceback → fix code, don't poll terminal / rename command
      if (
        TERMINAL_LAUNCH_TOOLS.test(call.name) &&
        !result.ok &&
        /SyntaxError|Traceback|Error:|Exception/i.test(`${result.detail}\n${result.output}`) &&
        step + 1 < maxSteps
      ) {
        history.push({
          role: "user",
          content:
            "[system] Процесс упал с ошибкой в коде (это НЕ блок повтора). Сейчас: read_file → replace_in_file/write_to_file по traceback. Потом снова run_in_terminal с ТЕМ ЖЕ command. Не get_terminal_output «чтобы обойти блок» и не меняй команду ради обхода.",
        });
      }
      // Empty bot launch (exit 0, only PS prompt) → missing entrypoint, not "success"
      if (
        !result.ok &&
        /EMPTY_OUTPUT|output_empty:\s*true/i.test(`${result.summary}\n${result.output}`) &&
        step + 1 < maxSteps
      ) {
        history.push({
          role: "user",
          content:
            '[system] EMPTY_OUTPUT: бот/сервер не запустился (терминал пустой или только prompt). Проверь точку входа: if __name__ == "__main__": asyncio.run(main()). Исправь файл → снова run_in_terminal → get_terminal_output должен показать лог, не пустой PS.',
        });
      }
    }
  }

  // Only reached if a finite maxSteps was set and the loop ran out mid-tools
  if (!unlimited && history.length && history[history.length - 1]?.role === "tool") {
    onProgress({ type: "status", text: "round", step: maxSteps + 1 });
    try {
      const wrap = await generateOnce();
      const cleaned = stripToolMarkup(wrap.assistantText) || wrap.assistantText;
      history.push({
        role: "assistant",
        content: cleaned,
        thinking: wrap.thinkingText || undefined,
      });
      onProgress({ type: "done", text: cleaned.trim() ? cleaned : "Готово." });
    } catch {
      onProgress({ type: "done", text: toolsExecuted > 0 ? "Готово." : "" });
    }
  }
  } finally {
    await settleSubagents();
  }

  return history;
}
