import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebCommands } from "./tool-surfaces/web-commands.js";
import { ProcessSessionManager } from "./process-sessions.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import type { SandboxCommandOptions, SandboxCommandResult } from "./sandbox-command.js";
import { SandboxCleanupError } from "./sandbox-command.js";
import { CommandReceipts } from "./command-receipts.js";
import { createHash } from "node:crypto";
import { openDatabase } from "./db/client.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; !predicate() && attempt < 1000; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert(predicate(), "Expected asynchronous command state");
}

test("web commands deduplicate starts, retain results, scope queries and drain on shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-command-contract-"));
  const processes = new ProcessSessionManager();
  t.after(async () => { processes.shutdown(); await processes.waitForBackground(); await rm(root, { recursive: true, force: true }); });
  let invocations = 0;
  let resolveRun!: (result: SandboxCommandResult) => void;
  let aborted = false;
  let emit!: (chunk: Buffer) => void;
  let truncate!: () => void;
  const run = (options: SandboxCommandOptions) => new Promise<SandboxCommandResult>((resolve) => {
    invocations++;
    assert.deepEqual(options.readRoots, [root]);
    assert.equal(options.allowLocalBinding, true);
    assert.deepEqual(options.protectedPaths, [join(root, "state")]);
    emit = options.onData!;
    truncate = options.onOutputTruncated!;
    resolveRun = resolve;
    options.signal?.addEventListener("abort", () => { aborted = true; resolve({ exitCode: null, signal: "SIGKILL", output: "partial", timedOut: false, aborted: true, outputTruncated: false }); });
  });
  const context = { config: { stateDir: join(root, "state"), webExecution: { allowedDomains: [], environment: [], readRoots: [root], allowLocalBinding: true } }, processSessions: processes, workspaces: {
    getWorkspace: (id: string) => ({ id, root }), resolveWorkingDirectory: () => root,
  } } as unknown as ToolRegistrationContext;
  const commands = new WebCommands(context, run);
  const input = { workspaceId: "one", requestKey: "same", command: "any command" };
  const [a, b] = await Promise.all([commands.start(input), commands.start(input)]);
  assert.equal(a.sessionId, b.sessionId);
  await until(() => invocations === 1);
  assert.equal(invocations, 1);
  const utf8 = Buffer.from("中文🙂");
  for (const byte of utf8) emit(Buffer.from([byte]));
  assert.equal(commands.status("one", a.sessionId).output, "中文🙂");
  truncate();
  assert.equal(commands.status("one", a.sessionId).running, true);
  assert.equal(commands.status("one", a.sessionId).outputTruncated, true);
  await assert.rejects(commands.start({ ...input, command: "different" }), /REQUEST_CONFLICT/);
  assert.throws(() => commands.status("two", a.sessionId), /Unknown command session/);
  resolveRun({ exitCode: 0, signal: null, output: "verified", timedOut: false, aborted: false, outputTruncated: false });
  await processes.waitForBackground();
  const completed = commands.status("one", a.sessionId);
  assert.equal(completed.running, false);
  assert.equal(completed.output, "verified");
  assert.deepEqual(commands.status("one", a.sessionId), completed);
  assert.deepEqual(await commands.start(input), completed);
  await commands.start({ ...input, requestKey: "second" });
  await until(() => invocations === 2);
  processes.shutdown();
  await processes.waitForBackground();
  assert.equal(aborted, true);
  await assert.rejects(commands.start({ ...input, requestKey: "third" }), /shutting down/);
});

test("cleanup failure prevents new starts and fails shutdown draining", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-cleanup-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processes = new ProcessSessionManager();
  const context = { config: { stateDir: join(root, "state") }, processSessions: processes, workspaces: {
    getWorkspace: (id: string) => ({ id, root }), resolveWorkingDirectory: () => root,
  } } as unknown as ToolRegistrationContext;
  const commands = new WebCommands(context, async () => { throw new SandboxCleanupError("Sandbox cleanup exceeded 2000ms"); });
  const input = { workspaceId: "one", requestKey: "cleanup", command: "fixture" };
  const receipt = await commands.start(input);
  await assert.rejects(processes.waitForBackground(), AggregateError);
  assert.match(commands.status("one", receipt.sessionId).error!, /cleanup exceeded/);
  assert.equal(commands.status("one", receipt.sessionId).running, null);
  assert.equal(commands.status("one", receipt.sessionId).executionState, "unknown");
  await assert.rejects(commands.start({ ...input, requestKey: "another" }), /shutting down/);
  processes.shutdown();
  await assert.rejects(processes.waitForBackground(), AggregateError);
  const restartedProcesses = new ProcessSessionManager();
  const restarted = new WebCommands({ ...context, processSessions: restartedProcesses }, async () => { throw new Error("must not replay"); });
  try {
    const stored = await restarted.start(input);
    assert.equal(stored.running, null);
    assert.equal(stored.executionState, "unknown");
  } finally { restartedProcesses.shutdown(); await restartedProcesses.waitForBackground(); }
});

test("hundreds of completed commands recycle output and retain replay protection across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-receipts-"));
  const stateDir = join(root, "state");
  const processes = new ProcessSessionManager();
  t.after(async () => { processes.shutdown(); await processes.waitForBackground(); await rm(root, { recursive: true, force: true }); });
  const context = { config: { stateDir }, processSessions: processes, workspaces: {
    getWorkspace: (id: string) => ({ id, root }), resolveWorkingDirectory: () => root,
  } } as unknown as ToolRegistrationContext;
  let invocations = 0;
  const commands = new WebCommands(context, async () => {
    invocations++;
    return { exitCode: 0, signal: null, output: "kept output", timedOut: false, aborted: false, outputTruncated: false };
  });
  let first = "", last = "";
  for (let i = 0; i < 400; i++) {
    const started = await commands.start({ workspaceId: "ws", requestKey: `request-${i}`, command: "fixture-command" });
    first ||= started.sessionId; last = started.sessionId;
    await processes.waitForBackground();
  }
  assert.equal(invocations, 400);
  assert.equal(commands.status("ws", first).outputExpired, true);
  assert.equal(commands.status("ws", first).exitCode, 0);
  assert.equal(commands.status("ws", last).output, "kept output");
  const replay = await commands.start({ workspaceId: "ws", requestKey: "request-0", command: "fixture-command" });
  assert.equal(replay.sessionId, first);
  assert.equal(replay.outputExpired, true);
  assert.equal(invocations, 400);
  processes.shutdown(); await processes.waitForBackground();
  const restartedProcesses = new ProcessSessionManager();
  const restarted = new WebCommands({ ...context, processSessions: restartedProcesses }, async () => { throw new Error("must not replay"); });
  try {
    assert.deepEqual(await restarted.start({ workspaceId: "ws", requestKey: "request-0", command: "fixture-command" }), replay);
    await assert.rejects(restarted.start({ workspaceId: "ws", requestKey: "request-0", command: "changed" }), /REQUEST_CONFLICT/);
    const database = openDatabase(stateDir);
    try {
      assert.equal((database.sqlite.prepare("select count(*) as n from web_command_receipts where output is not null").get() as { n: number }).n, 128);
      const rows = JSON.stringify(database.sqlite.prepare("select * from web_command_receipts").all());
      assert(!rows.includes("fixture-command"));
      assert(!rows.includes("request-0"));
    } finally { database.close(); }
  } finally { restartedProcesses.shutdown(); await restartedProcesses.waitForBackground(); }
});

test("unavailable execution remains unknown and is never replayed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-unknown-receipt-"));
  const stateDir = join(root, "state"), p = new ProcessSessionManager();
  t.after(async () => { p.shutdown(); await p.waitForBackground(); await rm(root, { recursive: true, force: true }); });
  const scope = JSON.stringify([await realpath(root), "ws"]);
  const fingerprint = createHash("sha256").update(JSON.stringify(["fixture", ".", 120000])).digest("hex");
  const store = new CommandReceipts(stateDir);
  store.reserve(scope, "existing", fingerprint, { sessionId: "lost-process", running: true, output: "", outputTruncated: false });
  const commands = new WebCommands({ config: { stateDir }, processSessions: p,
    workspaces: { getWorkspace: (id: string) => ({ id, root }), resolveWorkingDirectory: () => root },
  } as unknown as ToolRegistrationContext, async () => { throw new Error("must not invoke runner"); });
  const result = await commands.start({ workspaceId: "ws", requestKey: "existing", command: "fixture" });
  assert.equal(result.sessionId, "lost-process");
  assert.equal(result.running, null);
  assert.equal(result.executionState, "unknown");
  assert.equal(commands.stop("ws", result.sessionId).executionState, "unknown");
});

test("active capacity is released on completion and shutdown races do not start work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "localworks-active-capacity-"));
  const p = new ProcessSessionManager();
  t.after(async () => { p.shutdown(); await p.waitForBackground(); await rm(root, { recursive: true, force: true }); });
  const context = { config: { stateDir: join(root, "state") }, processSessions: p,
    workspaces: { getWorkspace: (id: string) => ({ id, root }), resolveWorkingDirectory: () => root },
  } as unknown as ToolRegistrationContext;
  const finishes: Array<() => void> = [];
  const commands = new WebCommands(context, async options => new Promise(resolve => {
    const finish = () => resolve({ exitCode: 0, signal: null, output: "done", outputTruncated: false, timedOut: false, aborted: Boolean(options.signal?.aborted) });
    finishes.push(finish); options.signal?.addEventListener("abort", finish, { once: true });
  }));
  for (let i = 0; i < 128; i++) await commands.start({ workspaceId: "ws", requestKey: String(i), command: "fixture" });
  await until(() => finishes.length === 128);
  await assert.rejects(commands.start({ workspaceId: "ws", requestKey: "full", command: "fixture" }), /Concurrent/);
  finishes[0](); await new Promise(resolve => setImmediate(resolve));
  await commands.start({ workspaceId: "ws", requestKey: "full", command: "fixture" });
  await until(() => finishes.length === 129);
  assert.equal(finishes.length, 129);
  const racing = commands.start({ workspaceId: "ws", requestKey: "race", command: "fixture" });
  p.shutdown();
  await assert.rejects(racing);
  await p.waitForBackground();
  assert.equal(finishes.length, 129);
});
