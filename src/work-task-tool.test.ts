import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWorkTaskTool, trackedWork } from "./tool-surfaces/work-task.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkLedger } from "./work-ledger.js";

test("actual MCP finish returns the same receipt as the dashboard and waits for yielded processes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-work-tool-")); const project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true }); const stateDir = join(root, "state");
  writeFileSync(join(project, "wait.cjs"), "setTimeout(()=>process.exit(0),400)");
  const processes = new ProcessSessionManager({ stateDir }); const ledger = new WorkLedger(stateDir);
  const server = new McpServer({ name: "fixture", version: "1" }); const client = new Client({ name: "fixture-host", version: "1" });
  registerWorkTaskTool({ server, config: { stateDir }, processSessions: processes,
    workspaces: { getWorkspace: (key: string) => { assert.equal(key, "ws"); return { id: "ws", root: project }; } } } as unknown as ToolRegistrationContext);
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); processes.shutdown(); ledger.close(); await delay(50); rmSync(root, { recursive: true, force: true }); });
  const call = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "work_task", arguments: { workspaceId: "ws", ...args } });
    const content = response.content as { type: string; text: string }[];
    return { error: Boolean(response.isError), data: JSON.parse(content[0]!.text) };
  };
  const begun = await call({ action: "begin", workItemId: "host-implementation", runKey: "first", title: "Host-only verification", hostModelLabel: "User display label" });
  assert(!begun.error); assert.equal(begun.data.origin.evidence, "client_reported");
  assert.equal(begun.data.usageStatus, "not_used"); const workRunId = begun.data.workRunId;
  await trackedWork(stateDir, workRunId, { root: project, workspaceId: "ws" }, "read", async () => ({ isError: false }));
  let process = await processes.start({ workspaceId: "ws", workspaceRoot: project, cwd: project,
    command: `"${globalThis.process.execPath}" wait.cjs`, yieldTimeMs: 0, workRunId });
  const finish = { action: "finish", workRunId, status: "completed", acceptance: "passed", summary: "Verified the process and source",
    evidence: [{ label: "Process exit", reference: "test://isolated-wait-process", outcome: "passed" }] };
  assert(process.running); assert((await call(finish)).error, "A returned process handle is not completion");
  while (process.running) process = await processes.write({ workspaceId: "ws", sessionId: process.sessionId!, yieldTimeMs: 1000 });
  const completed = await call(finish); assert(!completed.error);
  assert.deepEqual(completed.data, ledger.receipt(workRunId));
  assert.equal(completed.data.codexUsage?.totalTokens, 0); assert.equal(completed.data.acceptanceStatus, "passed");
  assert.equal(ledger.detail(completed.data.projectId, workRunId).operations.length, 2);
  assert.deepEqual((await call(finish)).data, completed.data);
});
