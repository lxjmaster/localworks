import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import { digest, WorkLedger, type WorkOrigin } from "../work-ledger.js";
import type { ToolRegistrationContext } from "./types.js";

export function hostOrigin(extra: { _meta?: Record<string, unknown>; authInfo?: { clientId?: string } }, clientLabel?: string, modelLabel?: string): WorkOrigin {
  const session = extra._meta?.["openai/session"];
  const reportedChatGPT = typeof session === "string" && session.length > 0;
  return { entryPoint: reportedChatGPT ? "chatgpt_mcp" : "other_mcp",
    evidence: reportedChatGPT || clientLabel ? "client_reported" : "server_entry",
    clientLabel: clientLabel?.slice(0, 120), modelLabel: modelLabel?.slice(0, 80),
    clientIdHash: extra.authInfo?.clientId ? digest(extra.authInfo.clientId).slice(0, 24) : undefined,
    conversationHash: reportedChatGPT ? digest(session).slice(0, 24) : undefined };
}
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const evidenceSchema = z.array(z.object({ label: z.string().max(200), reference: z.string().max(1200),
  outcome: z.enum(["passed", "failed", "not_run"]) }).strict()).max(40);

export function registerWorkTaskTool({ server, config, workspaces, processSessions }: ToolRegistrationContext): void {
  server.registerTool("work_task", {
    title: "Track work and return Codex token receipt",
    description: "Begin a top-level work run BEFORE direct host reads, commands or delegation, even when no Codex is needed. Reuse its workRunId on work/agent tools. Record bounded verification evidence. Finish only after all child work stops and acceptance is explicit; the returned receipt is the same one shown in /console. Include its Codex token totals and completeness in your final answer. This tool never starts model inference. Model labels are display labels, not verified model identities.",
    inputSchema: {
      workspaceId: z.string(), action: z.enum(["begin", "record", "finish", "get", "list"]),
      workRunId: z.string().optional(), workItemId: key.optional(), runKey: key.optional(),
      title: z.string().min(1).max(200).optional(), hostModelLabel: z.string().max(80).optional(),
      requestKey: key.optional(), kind: z.string().max(64).optional(), label: z.string().max(200).optional(),
      status: z.enum(["completed", "failed", "cancelled"]).optional(),
      acceptance: z.enum(["passed", "failed", "not_applicable"]).optional(),
      summary: z.string().max(4000).optional(), evidence: evidenceSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    const workspace = workspaces.getWorkspace(input.workspaceId);
    const ledger = new WorkLedger(config.stateDir);
    const reply = (data: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], isError });
    try {
      if (input.action === "begin") {
        if (!input.workItemId || !input.runKey || !input.title) throw new Error("begin requires workItemId, runKey and title.");
        const run = ledger.begin({ root: workspace.root, workspaceId: workspace.id, workItemId: input.workItemId,
          runKey: input.runKey, title: input.title, origin: hostOrigin(extra, server.server.getClientVersion()?.name, input.hostModelLabel) });
        return reply({ ...ledger.receipt(run.id), consolePath: `/console/?project=${run.project_id}&run=${run.id}` });
      }
      if (input.action === "list") return reply(ledger.listRuns(ledger.project(workspace.root).id));
      if (!input.workRunId) throw new Error("workRunId is required.");
      const run = ledger.requireScope(input.workRunId, workspace.root, workspace.id);
      if (input.action === "record") {
        if (!input.requestKey || !input.label) throw new Error("record requires requestKey and label.");
        const operationId = ledger.operation({ runId: run.id, requestKey: input.requestKey, kind: input.kind ?? "verification",
          label: input.label, status: input.status ?? "completed", evidence: input.evidence });
        return reply({ operationId, receipt: ledger.receipt(run.id) });
      }
      if (input.action === "finish") {
        if (!input.status || !input.acceptance || input.summary === undefined) throw new Error("finish requires status, acceptance and summary.");
        if (processSessions.executionCoordinator?.inspect(workspace.root).length) throw new Error("Managed claims/waiters remain; inspect and reconcile them before closing work.");
        return reply(ledger.finish(run.id, { status: input.status, acceptance: input.acceptance,
          summary: input.summary, evidence: input.evidence ?? [] }));
      }
      return reply(ledger.detail(run.project_id, run.id));
    } catch (error) { return reply({ code: "WORK_STATE", message: error instanceof Error ? error.message : "Work operation failed." }, true); }
    finally { ledger.close(); }
  });
}

/** A short-lived ledger handle; no raw command/source text is collected. */
export async function trackedWork<T>(stateDir: string, workRunId: string | undefined,
  scope: { root: string; workspaceId: string }, kind: string, action: () => Promise<T>): Promise<T> {
  if (!workRunId) return action();
  const ledger = new WorkLedger(stateDir);
  let operationId: string | undefined;
  try {
    ledger.requireScope(workRunId, scope.root, scope.workspaceId);
    operationId = ledger.operation({ runId: workRunId, requestKey: `${kind}:${randomUUID()}`,
      kind, label: kind, status: "running" });
    const result = await action();
    const failed = result !== null && typeof result === "object" && "isError" in result && result.isError === true;
    ledger.endOperation(operationId, failed ? "failed" : "completed"); return result;
  } catch (error) { if (operationId) ledger.endOperation(operationId, "failed"); throw error; }
  finally { ledger.close(); }
}
