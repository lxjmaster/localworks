import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { WorkLedger } from "./work-ledger.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WebCommands } from "./tool-surfaces/web-commands.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";

test("migration 12 to 13 preserves existing ledger data and is repeatable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-receipt-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new WorkLedger(root);
  const project = ledger.project(root, "preserve me");
  // Reconstruct the previous schema in this disposable database. Migration 13
  // adds only this table/index and its version record.
  ledger.db.exec("drop table web_command_receipts; delete from devspace_schema_migrations where version=13");
  ledger.close();
  for (let i = 0; i < 2; i++) {
    const upgraded = new WorkLedger(root);
    try {
      assert.deepEqual(upgraded.getProject(project.id), project);
      assert.equal((upgraded.db.prepare("select count(*) as n from devspace_schema_migrations where version=13").get() as { n: number }).n, 1);
      assert.deepEqual(upgraded.db.prepare("select * from web_command_receipts").all(), []);
    } finally { upgraded.close(); }
  }
});

test("real workspace registry restores a completed command without replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-receipt-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"); await mkdir(project);
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: { allowedRoots: [project] }, storage: { stateDir: join(root, "state") },
    skills: { enabled: false, agentDir: join(root, "agents") },
  }));
  let id = "", invocations = 0;
  for (let boot = 0; boot < 2; boot++) {
    const store = new SqliteWorkspaceStore(config.stateDir);
    const workspaces = new WorkspaceRegistry(config, store);
    const processes = new ProcessSessionManager({ stateDir: config.stateDir });
    try {
      const opened = await workspaces.openWorkspace({ path: project }, { conversationScopeId: "same-conversation" });
      if (id) assert.equal(opened.workspace.id, id);
      id = opened.workspace.id;
      const commands = new WebCommands({ config, workspaces, processSessions: processes } as ToolRegistrationContext, async () => {
        invocations++;
        return { exitCode: 0, signal: null, output: "persisted", outputTruncated: false, aborted: false, timedOut: false };
      });
      const request = await commands.start({ workspaceId: id, requestKey: "one", command: "fixture" });
      await processes.waitForBackground();
      assert.equal(commands.status(id, request.sessionId).output, "persisted");
      assert.equal(invocations, 1);
    } finally { processes.shutdown(); await processes.waitForBackground(); store.close(); }
  }
});

test("failed receipt update prevents new execution and leaves restart status unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-receipt-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = new ProcessSessionManager();
  const context = { config: { stateDir: join(root, "state") }, processSessions: p,
    workspaces: { getWorkspace: (id: string) => ({ id, root }), resolveWorkingDirectory: () => root },
  } as unknown as ToolRegistrationContext;
  const commands = new WebCommands(context, async () => {
    const db = openDatabase(context.config.stateDir);
    try { db.sqlite.exec("create trigger fail_receipt before update on web_command_receipts begin select raise(abort,'fixture save failure'); end"); }
    finally { db.close(); }
    return { exitCode: 0, signal: null, output: "executed", outputTruncated: false, timedOut: false, aborted: false };
  });
  const input = { workspaceId: "ws", requestKey: "one", command: "fixture" };
  const receipt = await commands.start(input);
  await assert.rejects(p.waitForBackground(), AggregateError);
  assert.match(commands.status("ws", receipt.sessionId).error!, /could not be saved/);
  await assert.rejects(commands.start({ ...input, requestKey: "new" }), /shutting down/);
  const nextProcesses = new ProcessSessionManager();
  const next = new WebCommands({ ...context, processSessions: nextProcesses }, async () => { throw new Error("must not replay"); });
  try { assert.equal((await next.start(input)).executionState, "unknown"); }
  finally { nextProcesses.shutdown(); await nextProcesses.waitForBackground(); p.shutdown(); }
});
