export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface AgentTask {
  id: string;
  title: string;
  status: TaskStatus;
  note?: string;
}

const tasks: AgentTask[] = [];

export function listTasks(): AgentTask[] {
  return [...tasks];
}

export function upsertTask(input: {
  id?: string;
  title: string;
  status?: TaskStatus;
  note?: string;
}): AgentTask {
  const id = input.id || `t${Date.now().toString(36)}`;
  const existing = tasks.find((t) => t.id === id);
  if (existing) {
    existing.title = input.title || existing.title;
    if (input.status) existing.status = input.status;
    if (input.note !== undefined) existing.note = input.note;
    return existing;
  }
  const t: AgentTask = {
    id,
    title: input.title,
    status: input.status || "pending",
    note: input.note,
  };
  tasks.push(t);
  return t;
}

export function formatTaskBoard(): string {
  if (!tasks.length) return "";
  const lines = ["[TASK_BOARD]"];
  for (const t of tasks) {
    lines.push(`- [${t.status}] ${t.id}: ${t.title}${t.note ? ` — ${t.note}` : ""}`);
  }
  lines.push("[/TASK_BOARD]");
  return lines.join("\n");
}

export function clearTasks(): void {
  tasks.length = 0;
}
