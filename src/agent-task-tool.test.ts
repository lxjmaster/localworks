import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Result } from "better-result";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgentTaskTool } from "./tool-surfaces/agent-task.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { LocalAgentStore, type LocalAgentRecord } from "./local-agent-store.js";
import { AgentScopeError } from "./local-agent-errors.js";
import { WorkLedger } from "./work-ledger.js";
import { createHash } from "node:crypto";
import { executionReliabilityTrace as trace } from "./test-support/execution-reliability-fixture.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { StartLocalAgentInput } from "./local-agent-manager.js";
import { decodeLocalAgentDaemonRequest, encodeLocalAgentDaemonRequest } from "./local-agent-daemon-protocol.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";
import { parseLocalAgentRunArgs, parseLocalAgentContinueArgs } from "./local-agent-targets.js";

test("native MCP control observes an occupied checkout without shell claims and deduplicates response delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-native-task-"));
  const processSessions = new ProcessSessionManager({ stateDir: root });
  const store = new LocalAgentStore(root);
  let record: LocalAgentRecord = store.create({ workspaceId: "workspace-1", workspaceRoot: root, profileName: "codex", provider: "codex" });
  record = store.update(record.id, { status: "running" });
  const claim = processSessions.executionCoordinator!.acquire({ workspaceRoot: root, kind: "agent", agentId: record.id });
  const starts: StartLocalAgentInput[] = [];
  let scoped = true;
  const server = new McpServer({ name: "fixture", version: "1" });
  registerAgentTaskTool({ server, processSessions,
    config: { stateDir: root, subagents: { enabled: true, providers: [] } } as unknown as ServerConfig,
    workspaces: { getWorkspace: (id: string) => {
      assert.equal(id, "workspace-1"); return { id, root };
    } } as unknown as WorkspaceRegistry,
  }, {
    start: async (input) => { starts.push(input); return Result.ok(record); },
    continue: async (_id, _prompt, _overrides, scope) => { assert.equal(scope.workspaceRoot, root); return Result.ok(record); },
    get: async (_id, scope) => {
      assert.equal(scope.workspaceId, "workspace-1");
      return scoped ? Result.ok(record) : Result.err(new AgentScopeError({ code: "WORKSPACE_MISMATCH", operation: "get", retryable: false, message: "scope rejected" }));
    },
    list: async () => Result.ok([record]),
  });
  const client = new Client({ name: "fixture-host", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { claim.release(); await client.close(); await server.close(); processSessions.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "agent_task", arguments: { workspaceId: "workspace-1", ...args } });
    const text = (response.content as Array<{ type: string; text: string }>)[0]!.text;
    return { ...JSON.parse(text), isError: response.isError } as Record<string, unknown>;
  };
  const absent = await call({ action: "start", target: "codex", prompt: "work" });
  assert.equal(absent.isError, true); assert.equal(starts.length, 0);
  assert.deepEqual(absent.missingFields, ["taskKey", "workItemId"]);
  assert.equal((await call({ action: "start", target: "codex", prompt: "work", taskKey: "task-1" })).isError, true);
  assert.equal(starts.length, 0, "Native work must identify a work item for the context budget");
  await call({ action: "start", target: "codex", prompt: "work", taskKey: "task-1", workItemId: "work-1", readOnly: true });
  assert.equal(starts[0]?.taskKey, "task-1"); assert.equal(starts[0]?.writeMode, "read_only");
  const initial = await call({ action: "observe", agentId: record.id, waitMs: 0 });
  assert.equal(initial.status, "running");
  const unchanged = await call({ action: "observe", agentId: record.id, waitMs: 0, knownRevision: initial.revision });
  assert.equal(unchanged.unchanged, true);
  record = { ...record, status: "idle", latestResponse: "completed evidence" };
  const brief = await call({ action: "observe", agentId: record.id, waitMs: 0, knownRevision: initial.revision });
  assert.equal(brief.responseAvailable, true); assert.equal(brief.response, undefined);
  const expanded = await call({ action: "observe", agentId: record.id, includeResponse: true, waitMs: 0 });
  assert.equal(expanded.response, "completed evidence");
  const recovered = await call({ action: "observe", agentId: record.id, includeResponse: true, waitMs: 0,
    knownRevision: brief.revision });
  assert.equal(recovered.response, "completed evidence", "A saved revision must not hide explicitly requested terminal output after reconnect");
  const replayed = await call({ action: "observe", agentId: record.id, includeResponse: true, waitMs: 0,
    knownRevision: recovered.revision });
  assert.equal(replayed.response, "completed evidence");
  assert.equal(starts.length, 1, "Recovery never launches a model");
  const claims = await call({ action: "claims" });
  assert.equal((claims.claims as unknown[]).length, 1);
  const usage = await call({ action: "usage", agentId: record.id });
  assert.equal(usage.status, "unknown");
  scoped = false;
  assert.equal((await call({ action: "usage", agentId: record.id })).isError, true);
  assert.equal((await call({ action: "observe", agentId: record.id, includeResponse: true, waitMs: 0 })).isError, true);
});

test("trace mechanism replay: 120 cumulative usage updates do not change task/progress revisions or wake bounded longpoll", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-observe-replay-"));
  const store = new LocalAgentStore(root); const ledger = new WorkLedger(root);
  const record = store.create({ workspaceId: "ws", workspaceRoot: root, profileName: "codex", provider: "codex" });
  store.update(record.id, { status: "running" });
  const run = ledger.begin({ root, workspaceId: "ws", workItemId: "fixture", runKey: "fixture", title: "Synthetic replay",
    origin: { entryPoint: "chatgpt_mcp", evidence: "server_entry" } });
  const execution = ledger.beginExecution({ runId: run.id, agentId: record.id, provider: "codex" });
  ledger.attachThread(execution, { instanceId: "fixture", identityVerified: true, threadId: "fixture-thread",
    createdHere: true, priorTurnIds: [], priorTurnsClosed: true });
  ledger.requestStarted(execution); ledger.turnStarted(execution, "fixture-turn");
  let gets = 0;
  const processSessions = new ProcessSessionManager({ stateDir: root });
  const makeServer = () => {
    const server = new McpServer({ name: "fixture", version: "1" });
    registerAgentTaskTool({ server, processSessions, config: { stateDir: root, subagents: {} } as ServerConfig,
      workspaces: { getWorkspace: () => ({ id: "ws", root }) } as unknown as WorkspaceRegistry }, {
      start: async () => { throw new Error("No inference in replay"); }, continue: async () => { throw new Error("No inference in replay"); },
      get: async () => { gets++; return Result.ok(store.getById(record.id)!); }, list: async () => Result.ok([]),
    });
    return server;
  };
  let server = makeServer();
  let client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); processSessions.shutdown(); ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const observe = async (extra: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: "agent_task", arguments: { workspaceId: "ws", action: "observe", agentId: record.id, waitMs: 0, ...extra } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const first = await observe(); const oldRevisions = new Set<string>();
  const usage = (n: number) => {
    ledger.usage(execution, { threadId: "fixture-thread", turnId: "fixture-turn", newThread: true,
      total: { inputTokens: n * 100, outputTokens: n, totalTokens: n * 101 } });
    store.update(record.id, { model: "codex" }); // metadata updatedAt is also not task progress
    oldRevisions.add(createHash("sha256").update(JSON.stringify([store.getById(record.id)!.updatedAt, ledger.receipt(run.id)])).digest("hex"));
  };
  for (let n = 1; n <= trace.syntheticUsageUpdates; n++) {
    usage(n);
    const next = await observe({ knownRevision: first.revision });
    assert.equal(next.revision, first.revision); assert.equal(next.unchanged, true);
    assert.equal(next.completionReceipt, undefined);
  }
  assert.equal(oldRevisions.size, 120);
  const oldUsageRevisionChanges = oldRevisions.size;
  const beforeGets = gets; const started = performance.now();
  const updating = setInterval(() => usage(121), 10);
  let waited;
  try { waited = await observe({ knownRevision: first.revision, waitMs: 120 }); } finally { clearInterval(updating); }
  const waitedMs = performance.now() - started;
  const longpollReads = gets - beforeGets;
  assert(waitedMs >= 100 && waitedMs < 2000, `bounded wait: ${waitedMs}`);
  assert(gets - beforeGets <= 3); assert.equal(waited.unchanged, true);
  store.recordActivityResult(record.id, { phase: "tool", toolCategory: "build" });
  const building = await observe({ knownRevision: first.revision, waitMs: 1000 });
  assert.equal(building.taskRevision, first.taskRevision); assert.notEqual(building.progressRevision, first.progressRevision);
  assert.equal(building.progress.toolCategory, "build");
  assert(JSON.stringify(building.progress).length < 1024);
  ledger.usage(execution, { threadId: "fixture-thread", turnId: "fixture-turn", newThread: true, total: trace.delta });
  ledger.providerFinished(execution); ledger.endExecution(execution, "completed");
  store.update(record.id, { status: "idle", latestResponse: "synthetic-secret-terminal" });
  const brief = await observe();
  assert.equal(brief.acceptanceStatus, "pending"); assert.equal(brief.responseAvailable, true);
  assert.equal(brief.nextAction.includeResponse, true); assert.equal(brief.completionReceipt, undefined);
  assert(!JSON.stringify(brief).includes("synthetic-secret-terminal"));
  // Drop the host connection and register a fresh MCP server/client against persisted state.
  await client.close(); await server.close(); server = makeServer();
  client = new Client({ name: "reconnected-fixture", version: "1" });
  const [reconnectServer, reconnectClient] = InMemoryTransport.createLinkedPair();
  await server.connect(reconnectServer); await client.connect(reconnectClient);
  for (let n = 0; n < 2; n++) {
    const recovered = await observe({ knownRevision: brief.revision, includeResponse: true });
    assert.equal(recovered.response, "synthetic-secret-terminal");
    assert.equal(recovered.completionReceipt.codexUsage.totalTokens, trace.delta.totalTokens);
    assert.equal(recovered.completionReceipt.acceptanceStatus, "pending");
    assert.equal(recovered.nextAction.action, "review_result");
  }
  t.diagnostic(JSON.stringify({ syntheticUsageUpdates: 120, oldRevisionChanges: oldUsageRevisionChanges, newUsageRevisionChanges: 0,
    longpollMs: Math.round(waitedMs), longpollReads }));
});

test("initial task key survives CLI and daemon decoding; continue does not silently ignore it", () => {
  const parsed = parseLocalAgentRunArgs(["codex", "--task-key=issue-17", "inspect"]);
  assert.equal(parsed.taskKey, "issue-17");
  assert.throws(() => parseLocalAgentContinueArgs(["agt_a", "--task-key", "wrong", "next"]));
  const request = { requestId: "fixture", protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    authToken: "synthetic-test-only", method: "agent.start" as const,
    params: { target: "codex", prompt: "inspect", taskKey: parsed.taskKey, workspaceRoot: process.cwd() } };
  const decoded = decodeLocalAgentDaemonRequest(JSON.parse(encodeLocalAgentDaemonRequest(request)));
  assert.equal(decoded.method, "agent.start");
  if (decoded.method === "agent.start") assert.equal(decoded.params.taskKey, "issue-17");
});
