/** Deliberately closed vocabulary. Never retain provider text, arguments or output. */
export const toolCategories = ["build", "test", "command", "read", "edit", "tool"] as const;
export type ToolCategory = typeof toolCategories[number];
export interface AgentActivity { phase: "provider" | "tool"; toolCategory?: ToolCategory }
export interface AgentProgress {
  phase: "queued" | "preparing" | "provider" | "tool" | "finished";
  startedAt: string;
  admittedAt?: string;
  lastActivityAt: string;
  toolCategory?: ToolCategory;
}

export function decodeAgentProgress(value: unknown): AgentProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const date = (v: unknown): v is string => typeof v === "string" && v.length <= 30 && Number.isFinite(Date.parse(v));
  if (!["queued", "preparing", "provider", "tool", "finished"].includes(String(p.phase)) || !date(p.startedAt) || !date(p.lastActivityAt)) return undefined;
  return { phase: p.phase as AgentProgress["phase"], startedAt: p.startedAt, lastActivityAt: p.lastActivityAt,
    ...(date(p.admittedAt) ? { admittedAt: p.admittedAt } : {}),
    ...(toolCategories.includes(p.toolCategory as ToolCategory) ? { toolCategory: p.toolCategory as ToolCategory } : {}) };
}

/** Classify only known item envelopes; command matching is a hint, never a claim of success. */
export function codexActivity(method: string, value: unknown): AgentActivity | undefined {
  if (method !== "item/started" && method !== "item/completed") return undefined;
  const item = value && typeof value === "object" ? (value as { item?: Record<string, unknown> }).item : undefined;
  if (!item || typeof item !== "object") return undefined;
  if (method === "item/completed") return { phase: "provider" };
  switch (item.type) {
    case "commandExecution": {
      const command = typeof item.command === "string" ? item.command.slice(0, 4096) : "";
      const toolCategory = /\b(?:test|vitest|pytest)\b/i.test(command) ? "test"
        : /\b(?:build|assemble\w*|tsc)\b/i.test(command) ? "build" : "command";
      return { phase: "tool", toolCategory };
    }
    case "fileChange": return { phase: "tool", toolCategory: "edit" };
    case "mcpToolCall": case "dynamicToolCall": case "webSearch": return { phase: "tool", toolCategory: "tool" };
    case "agentMessage": case "reasoning": return { phase: "provider" };
    default: return undefined;
  }
}
