import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";
import { createLocalAgentClient, type LocalAgentClient } from "../local-agent-client.js";
import { presentAgentObservation, presentAgentReceipt, presentAgentSummary } from "../local-agent-presentation.js";
import { LocalAgentStore } from "../local-agent-store.js";
import type { ToolRegistrationContext } from "./types.js";

type AgentClient = Pick<LocalAgentClient, "start" | "continue" | "get" | "list"> & Partial<Pick<LocalAgentClient, "cancelQueued">>;

/** A control-plane call must not acquire the shell/checkout claim it is observing. */
export function registerAgentTaskTool(context: ToolRegistrationContext, client?: AgentClient): void {
  const { server, config, workspaces, processSessions } = context;
  const agents = client ?? createLocalAgentClient(config);
  server.registerTool("agent_task", {
    title: "Manage a bounded agent task",
    description: "Delegate only work that needs a Codex judgment or implementation. First inspect files directly with read/workspace_context; these do not invoke Codex. Pass a short host-prepared context, not the whole host history. Related work reuses sessions with workItemId/contextKey; use freshContext for independent review. At most two verified read-only agents share a source; writes/builds remain exclusive and excess work queues without invoking a model. Observe and usage never launch inference.",
    inputSchema: {
      workspaceId: z.string(),
      action: z.enum(["start", "continue", "observe", "list", "claims", "usage", "cancelQueued"]),
      target: z.string().optional(),
      agentId: z.string().optional(),
      prompt: z.string().min(1).optional(),
      taskKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional()
        .describe("Stable identity for one initial task. Repeating the same start returns its existing agent without a new model call; use continue for new instructions."),
      readOnly: z.boolean().optional(),
      workItemId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).optional(),
      contextKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).optional()
        .describe("Explicit problem-domain/role affinity, not the source SHA. Requires workItemId; an idle matching thread is resumed instead of creating a new context."),
      freshContext: z.boolean().optional().describe("Use a separate context for unrelated work or independent acceptance review; do not prewarm idle workers."),
      requestKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("Idempotency identity for one continuation, distinct from the session/domain identity."),
      context: z.object({ summary: z.string().max(12_000), files: z.array(z.object({
        path: z.string().min(1).max(1024), sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }).strict()).max(24) }).strict().optional().describe("Host-prepared facts and versioned files from workspace_context. References are checked before invocation, and again after shared-read analysis. No automatic full-file copy."),
      resources: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)).max(16).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      waitMs: z.number().int().min(0).max(25_000).optional(),
      knownRevision: z.string().optional(),
      includeResponse: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    const workspace = workspaces.getWorkspace(input.workspaceId);
    const scope = { workspaceId: workspace.id, workspaceRoot: workspace.root };
    const reply = (value: unknown, isError = false) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }], isError,
    });
    if (input.action === "claims") return reply({ claims: processSessions.executionCoordinator?.inspect(workspace.root) ?? [],
      coordinationEnabled: Boolean(processSessions.executionCoordinator) });
    if (input.action === "list") {
      const records = await agents.list(scope);
      if (records.isErr()) return reply({ code: records.error.code, message: records.error.message }, true);
      return reply({ agents: records.value.map((record) => ({ ...presentAgentSummary(record), workItemId: record.workItemId, contextKey: record.contextKey })), policy: {
        maxConcurrentAgents: config.subagents.maxConcurrentAgents ?? 2, readersPerCheckout: config.subagents.maxConcurrentReaders ?? 2, writersPerCheckout: 1,
        queueWaitMs: config.subagents.queueWaitMs ?? 300_000,
        maxNewSessionsPerWorkItem: config.subagents.maxNewSessionsPerWorkItem ?? 3,
        sharedResources: config.subagents.sharedResources ?? [],
      } });
    }
    if (input.action === "cancelQueued") {
      if (!input.agentId || !agents.cancelQueued) return reply({ code: "INVALID_TASK", message: "Cancellation requires an owned queued agent." }, true);
      const result = await agents.cancelQueued(input.agentId, scope);
      return result.isErr() ? reply({ code: result.error.code, message: result.error.message }, true) : reply(presentAgentReceipt(result.value));
    }
    if (input.action === "usage") {
      if (!input.agentId) return reply({ code: "INVALID_TASK", message: "usage needs agentId." }, true);
      const authorized = await agents.get(input.agentId, scope);
      if (authorized.isErr()) return reply({ code: authorized.error.code, message: authorized.error.message }, true);
      const store = new LocalAgentStore(config.stateDir);
      try { return reply(store.usage(authorized.value.id)); } finally { store.close(); }
    }
    const overrides = { model: input.model, effort: input.effort, writeMode: input.readOnly ? "read_only" as const : undefined,
      context: input.context, resources: input.resources, requestKey: input.requestKey };
    if (input.action === "start" || input.action === "continue") {
      if (!input.prompt || (input.action === "start" ? (!input.target || !input.taskKey || !input.workItemId) : (!input.agentId || !input.requestKey))) {
        return reply({ code: "INVALID_TASK", message: "start needs target, stable taskKey, workItemId and prompt; continue needs agentId, requestKey and prompt." }, true);
      }
      const result = input.action === "start"
        ? await agents.start({ ...scope, ...overrides, target: input.target!, prompt: input.prompt, taskKey: input.taskKey,
            workItemId: input.workItemId, contextKey: input.contextKey, freshContext: input.freshContext })
        : await agents.continue(input.agentId!, input.prompt, overrides, scope);
      if (result.isErr()) return reply({ code: result.error.code, message: result.error.message, retryable: result.error.retryable }, true);
      return reply({ ...presentAgentReceipt(result.value), contextKey: result.value.contextKey, workItemId: result.value.workItemId,
        contextMode: result.value.providerSessionId ? "resume" : "new", hostContextProvided: Boolean(input.context) });
    }
    if (!input.agentId) return reply({ code: "INVALID_TASK", message: "observe needs agentId." }, true);
    const deadline = Date.now() + (input.waitMs ?? 20_000);
    for (;;) {
      const found = await agents.get(input.agentId, scope);
      if (found.isErr()) return reply({ code: found.error.code, message: found.error.message }, true);
      const record = found.value;
      const revision = createHash("sha256").update(JSON.stringify([record.updatedAt, record.status, record.latestResponse, record.error])).digest("hex");
      const running = record.status === "queued" || record.status === "running" || record.status === "starting";
      if (!running || Date.now() >= deadline || (input.knownRevision && revision !== input.knownRevision)) {
        if (revision === input.knownRevision) return reply({ id: record.id, status: presentAgentReceipt(record).status, revision, unchanged: true });
        const observation = presentAgentObservation(input.includeResponse ? record : { ...record, latestResponse: undefined });
        return reply({ ...observation, revision, responseAvailable: Boolean(record.latestResponse) });
      }
      await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal: extra.signal });
    }
  });
}
