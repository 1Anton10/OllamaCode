import * as vscode from "vscode";
import { loadConfig, resolveModelRuntime } from "./config";
import { syncDefaultModel } from "./ollama/resolveModel";
import { OllamaClient, ChatMessage } from "./ollama/client";
import { runAgentTurn } from "./agent/loop";
import {
  estimateTokens,
  autoRaisePhysicalCtx,
  autoRaiseVirtualCtx,
  maybeOfferContextIncrease,
  maybeOfferVirtualIncrease,
  ContextMeter,
} from "./agent/contextBudget";
import { getRepoMapSummary } from "./index/repoMap";
import { formatTaskBoard } from "./agent/tasks";
import { collectVscodeTools, toolsAwarenessRules } from "./tools/vscodeTools";
import { buildAttachmentContext } from "./chat/attachments";
import { buildHubContextPack } from "./marketplace/contextPack";
import { stripToolMarkup } from "./tools/parser";
import { normalizeAssistantMarkdown } from "./ollama/assistantMarkdown";
import { partialTagTail, scrubThinkLeaks, stripThinkingTags } from "./ollama/thinkingTags";
import { isOomError } from "./ollama/capabilities";
import { packChunkedContext, setVctxSessionKey } from "./agent/chunkedContext";

/** Chat markdown only parses HTML when supportHtml is set (otherwise <details> dumps as text). */

function presentToolResultUi(
  stream: vscode.ChatResponseStream,
  res: { ok?: boolean; call?: { name?: string }; path?: string; ui?: any; action?: string } | undefined
): void {
  if (!res?.ok || !res.ui) return;
  const streamAny = stream as vscode.ChatResponseStream & {
    textEdit?: (uri: vscode.Uri, edits: unknown) => void;
    codeblockUri?: (uri: vscode.Uri, isEdit?: boolean) => void;
  };
  try {
    if (res.ui.kind === "filetree") {
      const base = vscode.Uri.file(res.ui.path);
      type Ent = { name: string; dir: boolean; children?: Ent[] };
      type TreeNode = { name: string; children?: TreeNode[] };
      const toNode = (e: Ent): TreeNode => {
        if (!e.dir) return { name: e.name };
        // Real children (may be []) so twistie expands; host starts collapsed + max-height.
        return {
          name: e.name,
          children: (e.children || []).map(toNode),
        };
      };
      const nodes = (res.ui.entries || []).slice(0, 48).map(toNode);
      stream.filetree(nodes, base);
      if (Number(res.ui.truncated) > 0) {
        stream.markdown(
          new vscode.MarkdownString(`_…и ещё ${res.ui.truncated} в detail tool-результата_`)
        );
      }
      return;
    }
    if (res.ui.kind === "read") {
      const uri = vscode.Uri.file(res.ui.path);
      stream.reference(uri);
      if (typeof streamAny.codeblockUri === "function") streamAny.codeblockUri(uri, false);
      return;
    }
    if (res.ui.kind === "edit") {
      const uri = vscode.Uri.file(res.ui.path);
      if (typeof streamAny.textEdit === "function") {
        const before = String(res.ui.before ?? "");
        const after = String(res.ui.after ?? "");
        // Full-file replace → chat "Edited …" diff card (ChatResponseTextEditPart)
        const beforeLines = before.length ? before.split(/\r?\n/) : [""];
        const endLine = Math.max(0, beforeLines.length - 1);
        const endChar = beforeLines[endLine]?.length ?? 0;
        const range = new vscode.Range(0, 0, endLine, endChar);
        streamAny.textEdit(uri, [new vscode.TextEdit(range, after)]);
        streamAny.textEdit(uri, true);
      } else if (typeof streamAny.codeblockUri === "function") {
        streamAny.codeblockUri(uri, true);
      } else {
        stream.reference(uri);
      }
    }
  } catch (e) {
    console.warn("OllamaCode presentToolResultUi", e);
  }
}

function mdHtml(value: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(value);
  md.supportHtml = true;
  md.isTrusted = false;
  return md;
}

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function historyFromChatContext(chatContext: vscode.ChatContext): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const turn of chatContext.history || []) {
    const anyTurn = turn as any;
    if (typeof anyTurn.prompt === "string") {
      out.push({ role: "user", content: anyTurn.prompt });
      continue;
    }
    if (Array.isArray(anyTurn.response)) {
      const parts: string[] = [];
      for (const p of anyTurn.response) {
        const v = p?.value;
        if (typeof v === "string") parts.push(v);
        else if (v && typeof v.value === "string") parts.push(v.value);
      }
      const text = parts.join("\n").trim();
      if (text) out.push({ role: "assistant", content: text });
    }
  }
  return out.slice(-24);
}

function firstUserPrompt(chatContext: vscode.ChatContext): string {
  for (const turn of chatContext.history || []) {
    const anyTurn = turn as any;
    if (typeof anyTurn.prompt === "string" && anyTurn.prompt.trim()) {
      return anyTurn.prompt.trim();
    }
    // Some hosts wrap the request turn
    if (typeof anyTurn.request?.prompt === "string" && anyTurn.request.prompt.trim()) {
      return anyTurn.request.prompt.trim();
    }
  }
  return "";
}

/** Extract path/basename hints from the prompt for richer titles. */
function titleObjectHints(text: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const base = raw.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || raw;
    const s = base.slice(0, 32);
    if (s && !out.includes(s)) out.push(s);
  };
  for (const m of text.matchAll(/([A-Za-z]:\\[^\s"'«»]+)/g)) push(m[1]);
  for (const m of text.matchAll(/(~\/[^\s"'«»]+)/g)) push(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g)) push(m[1]);
  for (const m of text.matchAll(
    /(?:папк[уеаи]|folder|проект|project|в|из|в\s+папк[уе])\s+[«"]?([A-Za-z0-9_.-]{2,40})/gi
  )) {
    push(m[1]);
  }
  // Bare product / folder tokens often present without paths
  for (const tok of [
    "LocalCursor",
    "cursor-local",
    "openclaw",
    "OllamaCode",
    "LocalC",
  ]) {
    if (new RegExp(`\\b${tok}\\b`, "i").test(text)) push(tok);
  }
  return out;
}

function clipTitle(t: string, max = 72): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function contentWordTitle(clean: string, maxWords = 9): string {
  const goal = clean
    .replace(/^(привет|hello|hi|хай|здарова|смотри|смотри,|глянь)[,!.\s]*/i, "")
    .trim();
  const stop = new Set(
    [
      "пожалуйста",
      "please",
      "pls",
      "нужно",
      "надо",
      "сделай",
      "сделать",
      "просто",
      "очень",
      "мне",
      "тут",
      "здесь",
      "давай",
      "хочу",
      "чтобы",
      "this",
      "that",
      "just",
      "can",
      "you",
    ].map((w) => w.toLowerCase())
  );
  const words = (goal || clean)
    .split(/\s+/)
    .filter((w) => w && !stop.has(w.toLowerCase().replace(/^[«"]|[»"]$/g, "")))
    .slice(0, maxWords)
    .join(" ");
  return words;
}

/** Informative human title even when Ollama is busy (title API often races the agent). */
function heuristicTitle(prompt: string): string {
  const clean = prompt
    .replace(/\[ATTACHMENTS\][\s\S]*$/i, " ")
    .replace(/<attachment[\s\S]*?<\/attachment>/gi, " ")
    .replace(/@\w+/g, " ")
    .replace(/ипроект/gi, "проект")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Chat";
  const objs = titleObjectHints(clean);
  const obj = objs[0] || "";
  const obj2 = objs[1] || "";
  const withObj = (label: string, extra?: string) => {
    const tail = [obj, extra || obj2].filter(Boolean);
    if (!tail.length) {
      // Never return a 1–2 word bucket — fall through to content words
      const words = contentWordTitle(clean);
      return clipTitle(words.length >= 12 ? words : `${label}: ${words || "задача"}`);
    }
    if (tail.length >= 2 && /форк|fork|клон|clone|перенос|move/i.test(label)) {
      return clipTitle(`${label} ${tail[0]} → ${tail[1]}`);
    }
    return clipTitle(`${label}: ${tail[0]}`);
  };

  if (/пуст(ой|ого)?\s+файл|empty\s+file|touch\s+\S+/i.test(clean)) return withObj("Пустой файл");
  if (/новый\s+проект|create\s+(a\s+)?project|create_project/i.test(clean)) return withObj("Новый проект");
  if (/тг\s*бот|telegram\s*bot|телеграм/i.test(clean)) return withObj("Telegram-бот");
  if (/каркас|skeleton|scaffold|boilerplate/i.test(clean)) return withObj("Каркас");
  if (/привет|hello|hi\b/i.test(clean) && /друг|friend|напиш/i.test(clean)) return "Сообщение другу";
  if (
    /(проверь|проверить|check|тест).{0,48}(инструмент|tools?\b)/i.test(clean) ||
    /(инструмент|tools?).{0,40}(пуст|ошибк|error|empty)/i.test(clean) ||
    /все\s+инструмент/i.test(clean)
  ) {
    return "Проверка инструментов агента";
  }
  if (/thinking|цинкинг|<think>|тег(и|и)?\s+прос/i.test(clean)) return "Thinking UI / теги";
  if (/комфорт|open\s*claw|openclow|зацикл/i.test(clean)) return withObj("Комфорт агента");
  if (/контекст|vctx|num_ctx|виртуал/i.test(clean)) return withObj("Контекст VCTX");
  if (/мув|move_chat|переключ|смен(и|ить)\s+(папк|workspace|воркспейс)|перенос\s+workspace/i.test(clean)) {
    return withObj("Перенос workspace");
  }
  if (/форк|fork|клон|clone/i.test(clean)) {
    // Prefer «Форк LocalCursor → cursor-local» over vague «Форк проекта»
    return withObj("Форк");
  }
  if (
    /(посмотр|посмотри|обзор|разбер|explore|look\s+at|анализ|анализир).{0,40}(проект|project|repo|код|LocalCursor|облак)/i.test(
      clean
    ) ||
    (/проект/i.test(clean) && /посмотр|глянь|look|обзор|анализ/i.test(clean))
  ) {
    return withObj("Обзор проекта");
  }
  if (/посмотр/i.test(clean) && /проект/i.test(clean)) return withObj("Обзор проекта");
  if (/запуст|запусти|run\b|start\b/i.test(clean)) return withObj("Запуск");
  if (/исправ|почин|fix|debug/i.test(clean)) return withObj("Исправление");
  if (/переимен|rename/i.test(clean)) return withObj("Переименование");
  if (/markdown|таблиц/i.test(clean)) return "Markdown / таблица";
  if (/тест|test/i.test(clean) && !/инструмент/i.test(clean)) return withObj("Тесты");

  const words = contentWordTitle(clean, 10);
  if (!words) return withObj("Чат");
  return clipTitle(words, 72);
}

function fallbackTitle(prompt: string): string {
  return heuristicTitle(prompt);
}

function normalizeTitle(raw: string, prompt: string): string | undefined {
  let t = (raw || "")
    .replace(/<\/?think>/gi, " ")
    .split("\n")[0]
    .replace(/^["'«»`#]+|["'«»`.!?:;]+$/g, "")
    .replace(/^(title|название)\s*[:\-–]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length < 2) return undefined;
  if (t.length > 72) t = t.slice(0, 69).trimEnd() + "…";
  const p = prompt.replace(/\s+/g, " ").trim().toLowerCase();
  const tl = t.toLowerCase();
  // Reject verbatim / near-verbatim copies of the user prompt
  if (tl === p || (p.startsWith(tl) && t.length >= 28)) {
    return undefined;
  }
  // Reject ultra-vague 1–3 word buckets the model sometimes emits
  if (
    /^(форк|fork|чат|chat|проект|project|обзор|fix|баг|задача|task)(\s+(проекта|project|папки|folder|чата))?$/i.test(
      t
    )
  ) {
    return undefined;
  }
  if (t.split(/\s+/).length <= 2 && t.length < 18) {
    return undefined;
  }
  return t;
}

function titlePromptKey(prompt: string): string {
  return prompt.replace(/@\w+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Host fires titleProvider in parallel with the agent. We gate naming until the
 * handler finishes model warmup, then share one title promise so Sessions update
 * with a meaning-based name before agent work starts.
 */
type TitleSlot = {
  ready: Promise<void>;
  signalReady: () => void;
  title?: Promise<string>;
};

const titleSlots = new Map<string, TitleSlot>();

/** Latest request prompt — titleProvider often runs before history has the user turn. */
let pendingChatTitlePrompt = "";

function getTitleSlot(prompt: string): TitleSlot {
  const key = titlePromptKey(prompt) || "chat";
  let slot = titleSlots.get(key);
  if (!slot) {
    let settled = false;
    let signalReady = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // Safety: never block titleProvider forever if handler never signals
      setTimeout(() => signalReady(), 90_000);
    });
    slot = { ready, signalReady };
    titleSlots.set(key, slot);
    setTimeout(() => titleSlots.delete(key), 180_000);
  }
  return slot;
}

async function suggestChatTitle(
  prompt: string,
  model: string,
  client: OllamaClient,
  token: vscode.CancellationToken,
  timeoutMs = 12_000
): Promise<string> {
  const fallback = heuristicTitle(prompt);
  if (!prompt.trim() || token.isCancellationRequested) return fallback;
  try {
    const { message } = await Promise.race([
      client.chat({
        model,
        think: false,
        messages: [
          {
            role: "system",
            content:
              "You name chat sessions. Reply with ONLY one informative title (5–12 words) in the user's language: action + concrete object/path/product. Good: «Форк LocalCursor в cursor-local», «Разбор облачных API LocalCursor», «Перенос чата в openclaw workspace». Bad (never): «Форк проекта», «Чат», «Обзор», «Fix», or a verbatim quote of the user. No quotes, no trailing punctuation.",
          },
          { role: "user", content: prompt.slice(0, 600) },
        ],
        options: { num_predict: 56, temperature: 0.2, num_ctx: 1536 },
      }),
      new Promise<{ message: { content: string } }>((resolve) =>
        setTimeout(() => resolve({ message: { content: "" } }), timeoutMs)
      ),
    ]);
    if (token.isCancellationRequested) return fallback;
    return normalizeTitle(message.content || "", prompt) || fallback;
  } catch {
    return fallback;
  }
}

/** After model is in VRAM (or titleProvider waiting on that): one shared title job. */
async function resolveSessionTitle(
  prompt: string,
  model: string,
  client: OllamaClient,
  token: vscode.CancellationToken,
  opts: { modelReady: boolean }
): Promise<string> {
  const slot = getTitleSlot(prompt);
  if (opts.modelReady) {
    // Start naming before unblocking titleProvider so both share one Ollama call
    if (!slot.title) {
      slot.title = suggestChatTitle(prompt, model, client, token, 15_000);
    }
    slot.signalReady();
    return slot.title;
  }
  await slot.ready;
  if (!slot.title) {
    slot.title = suggestChatTitle(prompt, model, client, token, 12_000);
  }
  return slot.title;
}

export function registerAgentParticipant(
  context: vscode.ExtensionContext,
  hooks?: {
    onChat?: (title: string, preview?: string) => void;
    contextMeter?: ContextMeter;
  }
) {
  const participant = vscode.chat.createChatParticipant(
    "ollamacode.agent",
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      const cfg = loadConfig();
      // Synchronously pin prompt for titleProvider (runs in parallel, history often empty)
      pendingChatTitlePrompt = request.prompt || "";
      const selected =
        request.model?.vendor === "ollamacode" ? request.model : undefined;
      const picked =
        selected ||
        (
          await vscode.lm.selectChatModels({
            vendor: "ollamacode",
            id: cfg.ollama.defaultModel,
          })
        )[0] ||
        (await vscode.lm.selectChatModels({ vendor: "ollamacode" }))[0];

      if (!picked) {
        stream.markdown(
          "❌ **Ollama** недоступна или нет моделей. Открой **OllamaCode: Manage Models** — установи Ollama и выбери модели."
        );
        void vscode.commands.executeCommand("ollamaCode.manageModels");
        return {};
      }

      if (request.model && request.model.vendor !== "ollamacode") {
        stream.markdown(
          `⚠️ Выбрана модель \`${request.model.vendor}/${request.model.id}\` — переключаю на Ollama \`${picked.id}\`.\n\n`
        );
      }

      const runtime = resolveModelRuntime(picked.id, cfg);
      void syncDefaultModel(picked.id);
      const modelCfg = (request as any).modelConfiguration as
        | { thinkingEffort?: string; contextSize?: number }
        | undefined;
      if (typeof modelCfg?.contextSize === "number" && modelCfg.contextSize > 0) {
        // Chip drives virtual window + physical num_ctx (profile-capped). Stops stuck-at-8192.
        const { applyContextChip } = await import("./agent/contextChipSync");
        applyContextChip(runtime, modelCfg.contextSize);
      }
      if (
        modelCfg?.thinkingEffort === "auto" ||
        modelCfg?.thinkingEffort === "on" ||
        modelCfg?.thinkingEffort === "off"
      ) {
        runtime.thinking = modelCfg.thinkingEffort;
      }
      const client = new OllamaClient(cfg.ollama.baseUrl);

      // Ensure selected model is the only one in VRAM; reload if num_ctx drifted (chip used to inflate it)
      try {
        const running = await client.listRunning();
        const norm = (s: string) => s.replace(/:latest$/i, "").toLowerCase();
        const pick = norm(picked.id);
        const match = running.find(
          (m) =>
            norm(m.name || m.model) === pick ||
            (m.name || m.model).toLowerCase() === picked.id.toLowerCase()
        );
        const loadedCtx =
          typeof match?.context_length === "number" && match.context_length > 0
            ? match.context_length
            : 0;
        const ctxMismatch =
          !!match && loadedCtx > 0 && Math.abs(loadedCtx - runtime.numCtx) > 256;
        if (!match || ctxMismatch) {
          if (ctxMismatch) {
            stream.progress(
              `перезагрузка ${picked.id}: ctx ${loadedCtx} → ${runtime.numCtx}…`
            );
          } else {
            stream.progress(`загрузка ${picked.id} в VRAM…`);
          }
          for (const m of running) {
            try {
              await client.unloadModel(m.name || m.model);
            } catch {
              /* ignore */
            }
          }
          await client.warmupModel(picked.id, {
            keepAlive: runtime.keepAlive,
            numCtx: runtime.numCtx,
            numGpu: runtime.numGpu,
            numBatch: runtime.numBatch,
          });
        }
      } catch (e: any) {
        const warmErr = String(e?.message || e || "");
        if (isOomError(warmErr)) {
          // Halve once on OOM — keep a usable window, not a 2k stub
          const safeCtx = Math.max(8192, Math.floor(runtime.numCtx / 2));
          stream.markdown(
            `\n⚠️ Warmup OOM — ctx **${runtime.numCtx} → ${safeCtx}**, batch ↓ перед чатом…\n\n`
          );
          runtime.numCtx = safeCtx;
          runtime.numBatch = Math.min(runtime.numBatch || 128, 64);
          try {
            await client.unloadModel(picked.id);
          } catch {
            /* ignore */
          }
        }
        /* Ollama ps/warmup optional otherwise */
      }

      const history = historyFromChatContext(chatContext);
      // First turn: heuristic title immediately (do NOT await Ollama — that delayed the agent
      // and left the raw prompt as the tab name when titleProvider raced with empty history).
      let sessionTitle = "";
      if (history.length === 0 && request.prompt.trim()) {
        sessionTitle = heuristicTitle(request.prompt);
        hooks?.onChat?.(sessionTitle, request.prompt.slice(0, 200));
        const slot = getTitleSlot(request.prompt);
        if (!slot.title) {
          // Longer budget — titleProvider waits up to ~7s and only runs once
          slot.title = suggestChatTitle(request.prompt, picked.id, client, token, 8_000).then(
            (named) => {
              if (named && named !== sessionTitle) {
                sessionTitle = named;
                hooks?.onChat?.(sessionTitle, request.prompt.slice(0, 200));
              }
              return named || sessionTitle;
            }
          );
        }
        slot.signalReady();
      } else {
        getTitleSlot(request.prompt).signalReady();
      }
      const vscodeTools = collectVscodeTools(request);
      const attachments = await buildAttachmentContext(request);

      let repoHint = "";
      try {
        repoHint = await getRepoMapSummary(1200);
      } catch {
        /* ignore */
      }

      const userText = [
        request.prompt,
        attachments.text,
        repoHint ? `\n\n[REPO_MAP]\n${repoHint}\n[/REPO_MAP]` : "",
        formatTaskBoard() ? `\n\n${formatTaskBoard()}` : "",
      ]
        .filter(Boolean)
        .join("");

      // Scale skill pack to physical num_ctx (133k chip is virtual — Ollama still uses numCtx)
      const skillBudget = Math.max(
        2500,
        Math.min(8000, Math.floor(runtime.numCtx * 0.35) * 4)
      );
      const hubPack = buildHubContextPack({
        userText: request.prompt,
        maxChars: skillBudget,
      });
      const langLock =
        cfg.chat.language === "ru"
          ? "Language lock: ответ и thinking только по-русски (язык пользователя). Не переключайся на китайский/中文."
          : cfg.chat.language && cfg.chat.language !== "auto"
            ? `Language lock: reply AND thinking only in ${cfg.chat.language}. Never switch to Chinese mid-thought.`
            : "Language lock: reply AND thinking in the user's language. Never switch to Chinese mid-thought.";
      const baseSystem = `${runtime.systemPrompt}\n\n${langLock}`;
      const systemWithHub = hubPack.text
        ? `${baseSystem}\n\n${hubPack.text}`
        : baseSystem;
      // Skills/ctx live on the status chip — do not emit parallel progress lines
      // (those stacked under Working and looked like «Working» ×2/×3).

      // Chunked / virtual context — keep physical num_ctx, remember far more
      let historyForTurn = history;
      let packNote = "";
      const wsName = vscode.workspace.workspaceFolders?.[0]?.name || "nows";
      const vctxSession = `${wsName}__${picked.id}`;
      setVctxSessionKey(vctxSession);
      if (runtime.chunkedContext !== false) {
        const packed = packChunkedContext(history, {
          windowTokens: Math.max(1024, runtime.numCtx - Math.min(2048, Math.floor(runtime.numCtx / 4))),
          virtualTargetTokens: runtime.virtualCtx || 32768,
          userText,
          systemPrompt: systemWithHub,
          persistSlots: true,
          sessionKey: vctxSession,
        });
        historyForTurn = packed.messages;
        packNote = packed.packed
          ? ` · ctx-pack: \`${packed.note}\` · virt ~${packed.virtualTokens}/${runtime.virtualCtx || 32768}`
          : "";
        // Meter = physical fill estimate, not virtual archive size
        hooks?.contextMeter?.update(packed.usedTokens || packed.virtualTokens, runtime.numCtx);
      }

      const est = estimateTokens(historyForTurn, userText, systemWithHub);
      const toolDefsEst = Math.ceil(
        Math.max(2800, (vscodeTools.enabledCount || 12) * 180)
      );
      const attachEst = Math.ceil((attachments.text || "").length / 4);
      const systemEst = Math.max(1, Math.ceil((systemWithHub || "").length / 4));
      const rulesEst = Math.max(1, hubPack.approxTokens || Math.ceil(200));
      const conversationEst = Math.max(1, est - systemEst);
      // Session Info must track PHYSICAL KV (what Ollama loads). Virtual/VCTX is archive capacity only.
      const meterLimit = Math.max(2048, runtime.numCtx);
      const virtCap = runtime.virtualCtx || 32768;
      let promptEst = Math.max(1, est + toolDefsEst + rulesEst + attachEst);
      hooks?.contextMeter?.update(promptEst, meterLimit);
      // VCTX full → silent raise (same as physical KV); optional UI offer as fallback
      if (runtime.chunkedContext !== false && promptEst / Math.max(1, virtCap) >= 0.85) {
        const raisedV =
          (await autoRaiseVirtualCtx(picked.id, virtCap)) ||
          (await maybeOfferVirtualIncrease(picked.id, virtCap));
        if (raisedV) runtime.virtualCtx = raisedV;
      }
      if (promptEst / meterLimit >= 0.85) {
        // Silent auto-raise physical KV so the agent does not die mid-turn
        const raised =
          (await autoRaisePhysicalCtx(
            picked.id,
            runtime.numCtx,
            (runtime.hardwareProfile as any) || "medium"
          )) || (await maybeOfferContextIncrease(picked.id, runtime.numCtx, cfg));
        if (raised) runtime.numCtx = raised;
      }

      // Session Info ring = response.usage. Always re-report (early chunks can race/drop).
      let lastUsageAt = 0;
      const reportUsage = (promptTokens: number, completionTokens: number, force = false) => {
        const now = Date.now();
        if (!force && now - lastUsageAt < 250) return;
        const prompt = Math.max(1, promptTokens);
        const completion = Math.max(0, completionTokens);
        const pct = (n: number) => Math.max(0, Math.min(100, Math.round((n / prompt) * 100)));
        const windowForReserve = meterLimit;
        const payload = {
          promptTokens: prompt,
          completionTokens: completion,
          outputBuffer: Math.min(8192, Math.max(512, Math.floor(windowForReserve / 4))),
          promptTokenDetails: [
            { category: "System", label: "System prompt", percentageOfPrompt: pct(systemEst) },
            { category: "Context", label: "Tool definitions", percentageOfPrompt: pct(toolDefsEst) },
            { category: "Context", label: "Attachments", percentageOfPrompt: pct(attachEst) },
            { category: "Context", label: "Rules", percentageOfPrompt: pct(rulesEst) },
            {
              category: "Conversation",
              label: "Conversation",
              percentageOfPrompt: pct(Math.max(1, conversationEst)),
            },
            {
              category: "Context",
              label: `VCTX archive cap ${virtCap} (not KV)`,
              percentageOfPrompt: 0,
            },
          ],
        };
        const usageFn = (stream as any).usage as ((u: typeof payload) => void) | undefined;
        try {
          if (typeof usageFn === "function") {
            usageFn(payload);
            lastUsageAt = now;
            return;
          }
          if (typeof (stream as any).push === "function") {
            (stream as any).push({ kind: "usage", ...payload });
            lastUsageAt = now;
            return;
          }
          console.warn("[OllamaCode] stream.usage unavailable — enable chatParticipantAdditions");
        } catch (e) {
          console.warn("[OllamaCode] stream.usage deferred", e);
        }
      };

      // Report usage without seeding empty markdown (was a huge blank gap above Working)
      await new Promise<void>((r) => setTimeout(r, 0));
      reportUsage(promptEst, 0, true);
      hooks?.contextMeter?.update(promptEst, meterLimit);
      if (sessionTitle) {
        hooks?.onChat?.(sessionTitle, request.prompt.slice(0, 200));
      }

      const awareness = toolsAwarenessRules(vscodeTools);
      const turnCfg = {
        ...cfg,
        chat: {
          ...cfg.chat,
          systemPrompt: `${systemWithHub}\n\n${awareness}`,
          thinking: runtime.thinking,
        },
        ollama: {
          ...cfg.ollama,
          temperature: runtime.temperature,
          numCtx: runtime.numCtx,
          keepAlive: runtime.keepAlive,
        },
      };

      let lastAssistant = "";
      let lastThinking = "";
      let streamedAssistant = false;
      let assistantHadTools = false;
      let lastError = "";

      const bumpUsage = (extraCompletion = 0, force = false) => {
        promptEst = Math.max(
          promptEst,
          estimateTokens(historyForTurn, userText, systemWithHub) + toolDefsEst + rulesEst + attachEst
        );
        const completionEst = Math.max(
          extraCompletion,
          Math.ceil(((lastAssistant || "") + (lastThinking || "")).length / 4)
        );
        hooks?.contextMeter?.update(promptEst + Math.max(0, completionEst), meterLimit);
        reportUsage(promptEst, completionEst, force);
      };
      const streamAny = stream as vscode.ChatResponseStream & {
        thinkingProgress?: (d: { text?: string | string[]; id?: string }) => void;
        progress(
          value: string,
          task?: (
            progress: vscode.Progress<{ message?: string; increment?: number }>
          ) => Thenable<string | void>
        ): void;
      };

      /**
       * Host merges thinkingProgress by APPENDING deltas (same id). Cumulative
       * re-sends duplicated text / split «П» into its own «Finished with 1 step».
       * Do NOT open progress(task) «Working» before/during thinking — that inserts a
       * non-thinking part and breaks merge → orphan grapheme steps + empty Working gap.
       * Visible stream = thinking accordion; tools = progress(task); wait = plain progress.
       */
      type NativeStep = { finish: (label: string) => void };
      let activeToolStep: NativeStep | undefined;
      let thinkingId = `think-${Date.now().toString(36)}`;
      let thinkingStarted = false;
      let lastStatusPlain = "";

      const beginNativeStep = (title: string): NativeStep => {
        let finish!: (label: string) => void;
        const done = new Promise<string>((resolve) => {
          finish = resolve;
        });
        streamAny.progress(title, async () => done);
        return {
          finish: (label: string) => finish(label.slice(0, 120)),
        };
      };
      const endToolStep = (label: string) => {
        if (!activeToolStep) return;
        activeToolStep.finish(label);
        activeToolStep = undefined;
      };
      const newThinkingRound = () => {
        thinkingId = `think-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        thinkingStarted = false;
        lastThinking = "";
      };
      /** Ephemeral status — no task, so no empty expandable Working shell. */
      const plainStatus = (msg: string) => {
        const m = (msg || "").slice(0, 100);
        if (!m || m === lastStatusPlain) return;
        lastStatusPlain = m;
        try {
          stream.progress(m);
        } catch {
          /* ignore */
        }
      };

      /** Buffer tiny leading deltas so a lone «П» never becomes its own thinking part. */
      let thinkBuf = "";
      const flushThinkBuf = (force = false) => {
        if (!thinkBuf) return;
        if (!force && thinkBuf.length < 2 && !/\s/.test(thinkBuf)) return;
        // Hold back partial «assistant <thi…» so we don't flash a leaked tag
        if (!force && partialTagTail(thinkBuf) > 0) return;
        const out = scrubThinkLeaks(thinkBuf);
        thinkBuf = "";
        if (!out) return;
        if (typeof streamAny.thinkingProgress !== "function") {
          plainStatus(out.replace(/\s+/g, " ").slice(0, 80));
          return;
        }
        thinkingStarted = true;
        streamAny.thinkingProgress({ text: out, id: thinkingId });
      };
      const pushThinkingDelta = (rawDelta: string) => {
        // trim:false — streamed " " must survive or Russian/English words glue
        const delta = stripToolMarkup(rawDelta, { trim: false });
        if (!delta || !cfg.ui.showThinking) return;
        thinkBuf += delta;
        flushThinkBuf(false);
      };

      const runOnce = async (cfgOnce: typeof turnCfg, seedHistory: typeof history) => {
        lastAssistant = "";
        lastThinking = "";
        streamedAssistant = false;
        assistantHadTools = false;
        lastError = "";
        lastStatusPlain = "";
        thinkBuf = "";
        endToolStep("—");
        newThinkingRound();
        // Do NOT plainStatus before thinking — any progress() part breaks thinking merge.

        await runAgentTurn({
          client,
          cfg: cfgOnce,
          model: picked.id,
          history: [...seedHistory],
          userText,
          token,
          cancelToken: token,
          vscodeTools,
          onProgress: (p) => {
            if (token.isCancellationRequested) return;
            if (p.type === "status") {
              if (p.text && /^model=/i.test(p.text)) return;
              const label = (p.text || "").trim();
              // Silent round / internal heartbeat — never inject progress during thinking
              if (/^round$/i.test(label) || !label || /^heartbeat:/i.test(label)) return;
              if (/^Ollama/i.test(label)) return;
              // Compact / recover — own chat step (Cursor-like subminimize job)
              if (/Subminimizing context|Chat context summarized/i.test(label)) {
                flushThinkBuf(true);
                thinkingStarted = false;
                endToolStep("—");
                const job = beginNativeStep("Subminimizing context");
                job.finish(
                  /Qwen/i.test(label)
                    ? "recovered"
                    : /overflow/i.test(label)
                      ? "trimmed"
                      : "summarized"
                );
                return;
              }
              if (!thinkingStarted && !thinkBuf) {
                if (/^VCTX/i.test(label) || /already have|skip duplicate/i.test(label)) {
                  plainStatus(label.slice(0, 80));
                }
              }
              return;
            } else if (p.type === "thinking" && (p.delta || p.text)) {
              const prev = lastThinking;
              if (p.text && p.text.length >= prev.length && p.text.startsWith(prev)) {
                const d = p.text.slice(prev.length);
                lastThinking = p.text;
                if (d) pushThinkingDelta(d);
              } else if (p.delta) {
                lastThinking += p.delta;
                pushThinkingDelta(p.delta);
              } else if (p.text && !prev) {
                lastThinking = p.text;
                pushThinkingDelta(p.text);
              }
              bumpUsage();
            } else if (p.type === "assistant" && (p.delta || p.text)) {
              flushThinkBuf(true);
              lastAssistant = p.text || lastAssistant;
              bumpUsage();
            } else if (p.type === "tool" && p.tool) {
              flushThinkBuf(true);
              assistantHadTools = true;
              thinkingStarted = false;
              endToolStep("—");
              const argsPreview = (() => {
                try {
                  return JSON.stringify(p.tool!.arguments || {}).slice(0, 80);
                } catch {
                  return "";
                }
              })();
              activeToolStep = beginNativeStep(
                `${p.tool.name}${argsPreview ? ` ${argsPreview}` : ""}`
              );
              bumpUsage();
            } else if (p.type === "tool_result") {
              const res = p.result;
              const ok = res ? res.ok : !/FAILED|DENIED|BLOCKED/i.test((p.text || "").slice(0, 200));
              const name = res?.call?.name || "tool";
              const summary = res?.summary || (ok ? "ok" : "ошибка");
              endToolStep(`${name} — ${summary}`);
              presentToolResultUi(stream, res);
              // Keep same thinking id — newThinkingRound after every tool caused
              // «Finished with 1 step» + fresh «user wants…» reopen spam.
              flushThinkBuf(true);
              thinkBuf = "";
              bumpUsage();
            } else if (p.type === "done") {
              flushThinkBuf(true);
              endToolStep(assistantHadTools ? "ok" : "—");
              thinkingStarted = false;
              lastAssistant = p.text || lastAssistant;
              bumpUsage(0, true);
              const cleaned = normalizeAssistantMarkdown(
                stripThinkingTags(stripToolMarkup(lastAssistant) || lastAssistant) || ""
              );
              const junk =
                !assistantHadTools &&
                (/(чтобы|сейчас|посмотрю|нужно)\s*$/i.test(cleaned.trim()) ||
                  /файл\s+открыт/i.test(cleaned) ||
                  /assistant\s*<think>/i.test(cleaned));
              if (cleaned.trim() && !junk) {
                // Plain MarkdownString (no supportHtml) — avoids DOMPurify flattening MD
                stream.markdown(new vscode.MarkdownString(`\n\n${cleaned}`));
                streamedAssistant = true;
              } else if (assistantHadTools && cleaned.trim()) {
                stream.markdown(new vscode.MarkdownString(`\n\n${cleaned}`));
                streamedAssistant = true;
              }
            } else if (p.type === "error") {
              lastError = p.text || "error";
              endToolStep("ошибка");
              thinkingStarted = false;
              stream.markdown(`\n\n❌ ${p.text}\n`);
            }
          },
        });
        endToolStep("—");
      };

      try {
        await runOnce(turnCfg, historyForTurn);

        // OOM → retry with lighter physical footprint (thinking stays on; VCTX kept)
        if (lastError && isOomError(lastError)) {
          const cpuOom = /cpu.?buffer|allocate.*cpu|backend_cpu/i.test(lastError);
          const safeCtx = Math.max(8192, Math.floor(runtime.numCtx / 2));
          const safeBatch = Math.max(64, Math.min(128, Math.floor((runtime.numBatch || 256) / 2)));
          // CPU buffer OOM → pin more layers on GPU; VRAM OOM → fewer GPU layers
          let safeGpu = runtime.numGpu ?? 20;
          if (cpuOom) safeGpu = Math.min(40, Math.max(safeGpu + 8, 32));
          else safeGpu = Math.max(8, Math.floor(safeGpu * 0.6));

          stream.markdown(
            mdHtml(
              `\n\n⚠️ **Out of memory** (GGML). Retry: ctx **${safeCtx}**, batch **${safeBatch}**, num_gpu **${safeGpu}**` +
                `${cpuOom ? " (больше на GPU — меньше CPU RAM)" : " (меньше GPU)"}` +
                `. Thinking on · VCTX on.\n\n`
            )
          );
          runtime.numCtx = safeCtx;
          runtime.numBatch = safeBatch;
          runtime.numGpu = safeGpu;
          const modelOver = {
            ...(turnCfg.models?.[picked.id] || {}),
            numCtx: safeCtx,
            numBatch: safeBatch,
            numGpu: safeGpu,
            chunkedContext: true,
            virtualCtx: runtime.virtualCtx || 32768,
          };
          const retryCfg = {
            ...turnCfg,
            ollama: { ...turnCfg.ollama, numCtx: safeCtx },
            models: { ...turnCfg.models, [picked.id]: modelOver },
          };
          try {
            const running = await client.listRunning();
            for (const m of running) {
              try {
                await client.unloadModel(m.name || m.model);
              } catch {
                /* ignore */
              }
            }
          } catch {
            try {
              await client.unloadModel(picked.id);
            } catch {
              /* ignore */
            }
          }
          const retryPacked = packChunkedContext(historyFromChatContext(chatContext), {
            windowTokens: Math.max(1024, safeCtx - 512),
            virtualTargetTokens: runtime.virtualCtx || 32768,
            userText,
            systemPrompt: systemWithHub,
            persistSlots: true,
            sessionKey: vctxSession,
          });
          lastError = "";
          await runOnce(retryCfg, retryPacked.messages);

          // Second emergency retry if still OOM
          if (lastError && isOomError(lastError)) {
            const emergencyCtx = 2048;
            const emergencyGpu = cpuOom ? 36 : 12;
            stream.markdown(
              mdHtml(
                `\n\n⚠️ OOM снова — аварийный режим: ctx **${emergencyCtx}**, batch **32**, num_gpu **${emergencyGpu}**…\n\n`
              )
            );
            runtime.numCtx = emergencyCtx;
            runtime.numBatch = 32;
            runtime.numGpu = emergencyGpu;
            const emergencyCfg = {
              ...retryCfg,
              ollama: { ...retryCfg.ollama, numCtx: emergencyCtx },
              models: {
                ...retryCfg.models,
                [picked.id]: {
                  ...modelOver,
                  numCtx: emergencyCtx,
                  numBatch: 32,
                  numGpu: emergencyGpu,
                },
              },
            };
            try {
              await client.unloadModel(picked.id);
            } catch {
              /* ignore */
            }
            const packed2 = packChunkedContext(historyFromChatContext(chatContext), {
              windowTokens: 1536,
              virtualTargetTokens: runtime.virtualCtx || 32768,
              userText,
              systemPrompt: systemWithHub,
              persistSlots: true,
              sessionKey: vctxSession,
            });
            lastError = "";
            await runOnce(emergencyCfg, packed2.messages);
          }
        }

        // Final answer already painted on "done"; only fill if something aborted early
        if (!streamedAssistant && lastAssistant) {
          const cleaned = normalizeAssistantMarkdown(
            stripThinkingTags(stripToolMarkup(lastAssistant) || lastAssistant) || ""
          );
          if (cleaned.trim()) {
            stream.markdown(
              /<\/?(?:details|summary)\b/i.test(cleaned)
                ? mdHtml(`\n\n${cleaned}`)
                : new vscode.MarkdownString(`\n\n${cleaned}`)
            );
          }
        }
        bumpUsage(1, true);
        // Flush extHost send queue before invoke finally clears pendingProgress
        await new Promise<void>((r) => queueMicrotask(() => r()));
        await new Promise<void>((r) => setTimeout(r, 0));
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (isOomError(msg)) {
          stream.markdown(
            `\n\n❌ **Память кончилась** при прогоне \`${picked.id}\`.\n` +
              `- Это MoE ~23 ГБ на RTX 2060 Super 8 ГБ — нормальный риск при thinking + большом ctx.\n` +
              `- Сейчас в конфиге: ctx **${runtime.numCtx}**, thinking **${runtime.thinking}**.\n` +
              `- Закрой лишние приложения / выгрузи модель из статус-бара VRAM и повтори.\n` +
              `\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\`\n`
          );
        } else if (/context|num_ctx|too long|exceed/i.test(msg)) {
          if (runtime.chunkedContext !== false) {
            const raisedV = await maybeOfferVirtualIncrease(
              picked.id,
              runtime.virtualCtx || 32768
            );
            stream.markdown(
              raisedV
                ? `⚠️ VCTX цель → ${raisedV} (физический num_ctx=${runtime.numCtx} без изменений). Повтори запрос.`
                : `❌ Переполнение окна — VCTX должен упаковать историю. ${msg}`
            );
          } else {
            const raised = await maybeOfferContextIncrease(picked.id, runtime.numCtx, cfg);
            stream.markdown(
              raised
                ? `⚠️ Контекст увеличен до ${raised}. Повтори запрос.`
                : `❌ ${msg}`
            );
          }
        } else {
          stream.markdown(`❌ ${msg}`);
        }
      }

      return {};
    }
  );

  // Desktop brand (dark plate + cyan llama in < >) — same PNG as shortcut
  const brandIcon = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  participant.iconPath = brandIcon;
  (participant as any).welcomeMessageContent = {
    icon: brandIcon,
    title: "Build with Agent",
    message: new vscode.MarkdownString(
      "All responses may be inaccurate. Local Ollama agent — tools & thinking."
    ),
  };

  (participant as any).titleProvider = {
    async provideChatTitle(ctx: vscode.ChatContext, token: vscode.CancellationToken) {
      // Host calls this ONCE per chat — whatever we return sticks as the tab name.
      // History is often empty; prefer pending prompt pinned by the agent handler.
      let prompt = firstUserPrompt(ctx) || pendingChatTitlePrompt;
      if (!prompt.trim()) {
        // Tiny wait: handler sets pendingChatTitlePrompt synchronously at start
        await new Promise<void>((r) => setTimeout(r, 80));
        prompt = firstUserPrompt(ctx) || pendingChatTitlePrompt;
      }
      if (!prompt.trim()) return undefined;
      const quick = heuristicTitle(prompt);
      const slot = getTitleSlot(prompt);
      // Give the agent handler a moment to start the shared Ollama title job
      await Promise.race([slot.ready, new Promise<void>((r) => setTimeout(r, 2_500))]);
      if (!slot.title) {
        const cfg = loadConfig();
        const client = new OllamaClient(cfg.ollama.baseUrl);
        const model = cfg.ollama.defaultModel || "llama3.2";
        slot.title = suggestChatTitle(prompt, model, client, token, 8_000);
      }
      // Do NOT signalReady here early — that used to unblock with empty title.
      // Wait for a real name: 600ms was too short while the agent holds the GPU.
      try {
        const better = await Promise.race([
          slot.title,
          new Promise<string>((r) => setTimeout(() => r(quick), 7_000)),
        ]);
        const out = normalizeTitle((better || quick).trim(), prompt) || quick;
        return out;
      } catch {
        return quick;
      }
    },
  };

  // Native chat subminimize / archive summary (VS Code calls this when compacting sessions)
  const summarizer = {
    async provideChatSummary(ctx: vscode.ChatContext, token: vscode.CancellationToken) {
      const hist = historyFromChatContext(ctx);
      if (!hist.length) return undefined;
      const cfg = loadConfig();
      const rt = resolveModelRuntime(cfg.ollama.defaultModel || "llama3.2", cfg);
      const client = new OllamaClient(cfg.ollama.baseUrl);
      const model = cfg.ollama.defaultModel || "llama3.2";
      const digest = hist
        .slice(-20)
        .map((m) => `${m.role}: ${(m.content || "").slice(0, 600)}`)
        .join("\n");
      try {
        const { message } = await client.chat({
          model,
          think: false,
          messages: [
            {
              role: "system",
              content:
                "Summarize this coding chat in 2–5 short bullet points (same language as the user). Focus on goals, decisions, files touched, remaining work. No preamble.",
            },
            { role: "user", content: digest.slice(0, 8000) },
          ],
          options: {
            num_predict: 320,
            temperature: 0.2,
            num_ctx: Math.min(Math.max(rt.numCtx || 8192, 4096), 16384),
          },
        });
        if (token.isCancellationRequested) return undefined;
        return (message.content || "").trim() || undefined;
      } catch {
        const first = hist.find((m) => m.role === "user")?.content || "";
        return first ? fallbackTitle(first) : undefined;
      }
    },
  };
  (participant as any).summarizer = summarizer;
  // Some Code-OSS builds read these alternate hooks for subminimize
  (participant as any).chatSummarizer = summarizer;
  (participant as any).provideChatSummary = summarizer.provideChatSummary.bind(summarizer);

  context.subscriptions.push(participant);
}
