import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProcessSessionManager } from "../process-sessions.js";
import { ExecutionConflictError, ExecutionCoordinator } from "../execution-coordinator.js";
import { WorkLedger } from "../work-ledger.js";
import { registerFileTools } from "./files.js";
import type { ToolRegistrationContext } from "./types.js";

for (const toolMode of ["web", "full"] as const) test(`${toolMode}: MCP file contracts, tracking and conflict recovery`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-file-tools-"));
  const server = new McpServer({ name: "file-tests", version: "1" });
  const client = new Client({ name: "test", version: "1" });
  let reads = 0, writes = 0, injectExternalEdit = false;
  const sessions = new ProcessSessionManager({ stateDir: join(root, "state") });
  const ledger = new WorkLedger(join(root, "state"));
  const read = sessions.readWorkspace.bind(sessions), mutate = sessions.mutate.bind(sessions);
  sessions.readWorkspace = async (path, operation) => { reads++; assert.equal(path, root); return read(path, operation); };
  sessions.mutate = async (path, operation) => {
    writes++;
    assert.equal(path, root);
    return mutate(path, async () => {
      if (injectExternalEdit) { await writeFile(join(root, "a"), "external"); injectExternalEdit = false; }
      return operation();
    });
  };
  t.after(async () => { await client.close(); await server.close(); sessions.shutdown(); ledger.close(); await rm(root, { recursive: true, force: true }); });
  registerFileTools({ server, config: { stateDir: join(root, "state"), toolMode }, processSessions: sessions, workspaces: {
    getWorkspace(id: string) { if (id !== "ws") throw new Error("Unknown workspace."); return { root, id }; },
  } } as unknown as ToolRegistrationContext);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map((tool) => tool.name).sort(), ["create_directory", "create_file", "delete_file", "edit_file", "move_file", "read_file", "replace_file"]);
  for (const tool of listed) {
    assert.ok(tool.inputSchema.required?.includes("workspaceId"));
    assert.ok(tool.inputSchema.properties?.workRunId);
    assert.ok(!tool.inputSchema.required?.includes("workRunId"));
    if (!["read_file", "create_file", "create_directory"].includes(tool.name)) assert.ok(tool.inputSchema.required?.includes("expectedSha256"));
    assert.equal(tool.annotations?.destructiveHint, !["read_file", "create_file", "create_directory"].includes(tool.name));
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    return CallToolResultSchema.parse(await client.callTool({ name, arguments: { workspaceId: "ws", ...args } }));
  };
  assert.equal((await call("create_file", { path: "a", content: "initial" })).isError, undefined);
  const result = await call("read_file", { path: "a" });
  assert.equal(result.structuredContent?.content, "initial");
  assert.equal(result.structuredContent?.sha256, createHash("sha256").update("initial").digest("hex"));
  assert.equal(reads, 1); assert.equal(writes, 1);
  assert.equal((await call("create_directory", { path: "src" })).structuredContent?.status, "created");
  assert.equal((await call("create_directory", { path: "src" })).structuredContent?.status, "exists");
  assert.equal((await call("create_directory", { path: "../escape" })).isError, true);
  assert.equal(writes, 4);
  injectExternalEdit = true;
  const stale = await call("replace_file", { path: "a", content: "bad", expectedSha256: result.structuredContent?.sha256 });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent?.status, "error");
  assert.match(JSON.stringify(stale.structuredContent), /version changed/);
  assert.equal(await readFile(join(root, "a"), "utf8"), "external");
  for (const args of [{ workspaceId: "unknown", path: "a" }, { path: "../outside" }, { path: "missing" }]) {
    const failure = await call("read_file", args);
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent?.status, "error");
  }
  assert.equal((await call("replace_file", { path: "a", content: "bad" })).isError, true);
  const begin = (runKey: string, workspaceId = "ws", runRoot = root) => ledger.begin({ root: runRoot, workspaceId,
    workItemId: "files", runKey, title: "File contracts", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const run = begin("valid");
  const wrongWorkspace = begin("wrong-workspace", "other");
  const otherRoot = join(root, "other-project"); await mkdir(otherRoot);
  const wrongRoot = begin("wrong-root", "ws", otherRoot);
  const beforeWrites = writes;
  for (const workRunId of ["unknown", wrongWorkspace.id, wrongRoot.id]) {
    assert.equal((await call("create_file", { workRunId, path: "unauthorized", content: "bad" })).isError, true);
    await assert.rejects(readFile(join(root, "unauthorized")), { code: "ENOENT" });
  }
  assert.equal(writes, beforeWrites, "Scope validation precedes mutation admission");
  assert.equal((await call("create_file", { workRunId: run.id, path: "tracked", content: "ok" })).isError, undefined);
  assert.equal((await call("create_file", { workRunId: run.id, path: "tracked", content: "overwrite" })).isError, true);
  assert.equal((await call("read_file", { workRunId: run.id, path: "tracked" })).isError, undefined);
  assert.equal((await call("read_file", { workRunId: run.id, path: "missing" })).isError, true);
  assert.deepEqual((ledger.detail(run.project_id, run.id).operations as Array<{ kind: string; status: string }>).map(({ kind, status }) => ({ kind, status })), [
    { kind: "create_file", status: "completed" }, { kind: "create_file", status: "failed" },
    { kind: "read_file", status: "completed" }, { kind: "read_file", status: "failed" },
  ]);
  assert.equal(await readFile(join(root, "tracked"), "utf8"), "ok");
  const owner = new ExecutionCoordinator(join(root, "state"));
  const claim = owner.acquire({ workspaceRoot: root, kind: "agent", access: "read", agentId: "agt_visible" });
  try {
    assert.equal((await call("read_file", { path: "a" })).isError, undefined);
    const blocked = await call("create_file", { path: "blocked", content: "bad" });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked.structuredContent), /EXECUTION_CONFLICT/);
    assert.deepEqual(blocked.structuredContent?.nextAction, { tool: toolMode === "web" ? "agent_query" : "agent_task", action: "claims", workspaceId: "ws" });
    assert.equal((blocked.structuredContent?.error as { claimId: string }).claimId, claim.id);
    assert.equal((blocked.structuredContent?.error as { agentId: string }).agentId, "agt_visible");
    await assert.rejects(readFile(join(root, "blocked")), { code: "ENOENT" });
  } finally { claim.release(); owner.close(); }
  const outside = await mkdtemp(join(tmpdir(), "devspace-file-owner-"));
  const foreignOwner = new ExecutionCoordinator(join(root, "state"));
  const foreignClaim = foreignOwner.acquire({ workspaceRoot: outside, kind: "agent", agentId: "agt_private" });
  const originalMutate = sessions.mutate;
  sessions.mutate = async () => { throw new ExecutionConflictError(foreignClaim.id, "agt_private", "Shared limit occupied"); };
  try {
    const blocked = await call("create_file", { path: "foreign-blocked", content: "bad" });
    assert.equal(blocked.isError, true);
    assert.doesNotMatch(JSON.stringify(blocked), new RegExp(`${foreignClaim.id}|agt_private`));
    assert.deepEqual(blocked.structuredContent?.nextAction, { tool: toolMode === "web" ? "agent_query" : "agent_task", action: "claims", workspaceId: "ws" });
    await assert.rejects(readFile(join(root, "foreign-blocked")), { code: "ENOENT" });
  } finally { sessions.mutate = originalMutate; foreignClaim.release(); foreignOwner.close(); await rm(outside, { recursive: true, force: true }); }
});
