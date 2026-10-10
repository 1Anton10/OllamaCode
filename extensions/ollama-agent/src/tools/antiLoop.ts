import { createHash } from "crypto";
import { ToolCall } from "./parser";

export interface LoopMemoryEntry {
  key: string;
  tool: string;
  exitCode?: number;
  status: string;
  at: number;
}

const memory: LoopMemoryEntry[] = [];
const MAX = 24;

export function argsHash(args: Record<string, unknown>): string {
  const raw = JSON.stringify(args, Object.keys(args || {}).sort());
  return createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

export function loopKey(call: ToolCall, exitCode?: number): string {
  return `${call.name}:${argsHash(call.arguments || {})}:${exitCode ?? "x"}`;
}

export function recordToolAttempt(
  call: ToolCall,
  status: string,
  exitCode?: number
): void {
  memory.push({
    key: loopKey(call, exitCode),
    tool: call.name,
    exitCode,
    status,
    at: Date.now(),
  });
  while (memory.length > MAX) memory.shift();
}

/** True if the same failed tool+args was already attempted recently. */
export function isRepeatFailure(call: ToolCall, exitCode?: number): boolean {
  const key = loopKey(call, exitCode);
  const sameArgsFail = memory.filter(
    (m) =>
      m.tool === call.name &&
      m.key.startsWith(`${call.name}:${argsHash(call.arguments || {})}:`) &&
      (m.status === "FAILED" || (typeof m.exitCode === "number" && m.exitCode !== 0))
  );
  return sameArgsFail.length >= 1;
}

export function clearLoopMemory(): void {
  memory.length = 0;
}
