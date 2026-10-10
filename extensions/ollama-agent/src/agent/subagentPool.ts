/**
 * Claude-style subagent pool: spawn background workers, keep main agent moving,
 * await only when the parent actually needs that result.
 */
import { runSubagent } from "./subagent";
import type { OllamaClient } from "../ollama/client";
import type { OllamaCodeConfig } from "../config";

export type SubMode = "read" | "implement";

export type SubJobStatus = "running" | "done" | "failed";

export interface SubJob {
  id: string;
  goal: string;
  mode: SubMode;
  status: SubJobStatus;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  /** Internal promise — not serialized to the model */
  promise: Promise<string>;
  /** True after drainDone() delivered this job to the parent history */
  drained?: boolean;
}

export interface SpawnResult {
  id: string;
  status: SubJobStatus;
  result?: string;
  error?: string;
}

export class SubagentPool {
  private jobs = new Map<string, SubJob>();
  /** wait=true jobs — already awaited in spawn; listed for completeness */
  private foregroundIds = new Set<string>();
  private seq = 0;
  private readonly maxConcurrent: number;

  constructor(
    private readonly deps: {
      client: OllamaClient;
      cfg: OllamaCodeConfig;
      model: string;
      maxStepsRead?: number;
      maxStepsImplement?: number;
      /** Test seam / custom runner — preferNative=true → show VS Code Summoning plaque */
      run?: (opts: {
        client: OllamaClient;
        cfg: OllamaCodeConfig;
        model: string;
        goal: string;
        mode: SubMode;
        maxSteps?: number;
        preferNative?: boolean;
      }) => Promise<string>;
    },
    maxConcurrent = 3
  ) {
    this.maxConcurrent = Math.max(1, Math.min(6, maxConcurrent));
  }

  private running(): SubJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "running");
  }

  private async waitForSlot(): Promise<void> {
    while (this.running().length >= this.maxConcurrent) {
      const pending = this.running().map((j) => j.promise.catch(() => ""));
      if (!pending.length) break;
      await Promise.race(pending);
    }
  }

  /** Start a subagent. wait=false → return immediately with id; wait=true → block until done. */
  async spawn(goal: string, mode: SubMode, wait: boolean): Promise<SpawnResult> {
    const g = (goal || "").trim();
    if (!g) throw new Error("goal required");

    await this.waitForSlot();

    const id = `sub-${++this.seq}`;
    const maxSteps =
      mode === "implement"
        ? this.deps.maxStepsImplement ?? 8
        : this.deps.maxStepsRead ?? 5;

    const run = this.deps.run || runSubagent;
    // wait=true → allow native plaque; background stays local (no Summoning UI / no hang)
    const preferNative = wait;
    const jobTimeoutMs = wait ? (mode === "implement" ? 180_000 : 120_000) : 55_000;
    const promise = Promise.race([
      run({
        client: this.deps.client,
        cfg: this.deps.cfg,
        model: this.deps.model,
        goal: g,
        mode,
        maxSteps,
        preferNative,
      }),
      new Promise<string>((_, reject) => {
        setTimeout(
          () => reject(new Error(`subagent ${id} timeout after ${jobTimeoutMs}ms`)),
          jobTimeoutMs
        );
      }),
    ]);

    const job: SubJob = {
      id,
      goal: g,
      mode,
      status: "running",
      startedAt: Date.now(),
      promise,
    };
    this.jobs.set(id, job);
    if (wait) this.foregroundIds.add(id);

    void promise.then(
      (text) => {
        job.status = "done";
        job.result = text;
        job.finishedAt = Date.now();
      },
      (err) => {
        job.status = "failed";
        job.error = String((err as any)?.message || err);
        job.finishedAt = Date.now();
      }
    );

    if (!wait) {
      // Background: return immediately — do NOT block parent settleAll / chat UI
      return { id, status: "running" };
    }

    try {
      const result = await promise;
      return { id, status: job.status, result, error: job.error };
    } catch (e: any) {
      return { id, status: "failed", error: String(e?.message || e) };
    }
  }

  async awaitJob(id: string, timeoutMs = 180_000): Promise<SpawnResult> {
    const job = this.jobs.get(id);
    if (!job) return { id, status: "failed", error: `unknown subagent id: ${id}` };

    if (job.status !== "running") {
      return {
        id,
        status: job.status,
        result: job.result,
        error: job.error,
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        job.promise.catch(() => ""),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`await_subagent timeout ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (e: any) {
      return { id, status: "failed", error: String(e?.message || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }

    return {
      id,
      status: job.status,
      result: job.result,
      error: job.error,
    };
  }

  /** Jobs finished since last drain — for injecting into parent chat history. */
  drainDone(): SubJob[] {
    const out: SubJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.drained) continue;
      if (job.status === "done" || job.status === "failed") {
        job.drained = true;
        out.push(job);
      }
    }
    return out;
  }

  list(): Array<{
    id: string;
    status: SubJobStatus;
    mode: SubMode;
    goal: string;
    ms: number;
  }> {
    const now = Date.now();
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      status: j.status,
      mode: j.mode,
      goal: j.goal.slice(0, 160),
      ms: (j.finishedAt || now) - j.startedAt,
    }));
  }

  /**
   * End-of-turn: only wait for foreground (wait=true) stragglers.
   * Background jobs must NOT block the chat spinner — they inject via drainDone next round.
   */
  async settleAll(timeoutMs = 15_000): Promise<void> {
    const running = this.running().filter((j) => this.foregroundIds.has(j.id));
    if (!running.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(running.map((j) => j.promise.catch(() => ""))),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error("settleAll timeout")), timeoutMs);
        }),
      ]);
    } catch {
      /* leave stragglers */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Default wait policy: explore in background; implement blocks unless wait=false. */
export function defaultWaitForMode(mode: SubMode, waitArg: unknown): boolean {
  if (waitArg === true || waitArg === "true" || waitArg === 1) return true;
  if (waitArg === false || waitArg === "false" || waitArg === 0) return false;
  return mode === "implement";
}
