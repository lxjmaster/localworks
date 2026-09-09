import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { createSandboxCommandPolicy, runSandboxCommand, selectSandboxEnvironment, sandboxWorkerError, SandboxCleanupError } from "./sandbox-command.js";

test("worker error serialization preserves cleanup failures separately from command errors", () => {
  const wire = JSON.parse(JSON.stringify({ error: "reset failed", cleanupFailed: true }));
  assert.ok(sandboxWorkerError(wire) instanceof SandboxCleanupError);
  assert.equal((sandboxWorkerError(wire) as SandboxCleanupError).code, "SANDBOX_CLEANUP_FAILED");
  assert.ok(!(sandboxWorkerError({ error: "unsupported platform", cleanupFailed: false }) instanceof SandboxCleanupError));
});

test("environment selection never copies ambient secrets and rejects wrapper injection", () => {
  const env = selectSandboxEnvironment(["CHOSEN"], { CHOSEN: "yes", SECRET: "no", NODE_OPTIONS: "bad" });
  assert.equal(env.CHOSEN, "yes");
  assert.equal(env.SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  for (const name of ["NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HOME", "CLAUDE_CODE_TMPDIR", "HTTP_PROXY", "BAD=NAME"]) {
    assert.throws(() => selectSandboxEnvironment([name]), /Unsafe/);
  }
});

test("policy denies by default, protects application paths and closes SDK write exceptions", () => {
  const policy = createSandboxCommandPolicy("/work/project", "/home/owner", "/app/server");
  assert.deepEqual(policy.network.allowedDomains, []);
  assert.deepEqual(policy.filesystem.allowWrite, ["/work/project"]);
  assert.ok(policy.filesystem.denyRead.includes("/"));
  assert.ok(policy.filesystem.denyRead.includes("/work/project/.env"));
  assert.ok(policy.filesystem.denyWrite.includes("/tmp/claude"));
  assert.ok(policy.filesystem.denyWrite.includes("/app/server"));
  assert.equal(policy.network.allowLocalBinding, false);
  assert.equal(policy.filesystem.allowGitConfig, true);
  assert.ok(!policy.filesystem.denyWrite.includes("/work/project/.git"));
  const custom = createSandboxCommandPolicy("/work/project", "/home/owner", "/app/server", [], {
    readRoots: ["/tools/compiler"], protectedPaths: ["/work/project/receipts"], allowLocalBinding: true,
  });
  assert.ok(custom.filesystem.allowRead?.includes("/tools/compiler"));
  assert.ok(custom.filesystem.denyRead.includes("/work/project/receipts"));
  assert.ok(custom.filesystem.denyWrite.includes("/work/project/receipts"));
  assert.equal(custom.network.allowLocalBinding, true);
  assert.throws(() => createSandboxCommandPolicy("/work/project", "/home/owner", "/app/server", [], {
    protectedPaths: ["/usr"],
  }), /conflict/);
  for (const root of ["/", "/Applications", "/home/owner", "/home/owner/.ssh", "/tools/*", "relative"]) {
    assert.throws(() => createSandboxCommandPolicy("/work/project", "/home/owner", "/app/server", [], { readRoots: [root] }));
  }
  assert.deepEqual(createSandboxCommandPolicy("/work/project", "/home/owner", "/app/server", ["example.com"]).network.allowedDomains, ["example.com"]);
  for (const root of ["/", "/home", "/home/owner", "/app/server", "/app/server/src", "/home/owner/.ssh", "/work/*"]) {
    assert.throws(() => createSandboxCommandPolicy(root, "/home/owner", "/app/server"));
  }
});

test("validates bounds before execution", async () => {
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxOutputBytes: -1 }, { command: "\0" }]) {
    await assert.rejects(runSandboxCommand({ workspaceRoot: "/absent", cwd: ".", command: "true", ...extra }));
  }
});

// Opt-in, but DEVSPACE_REQUIRE_SANDBOX_COMMAND=1 makes unsupported/missing/broken sandbox
// a test failure, never a false green skip. No mocked sandbox in this suite.
test("real OS sandbox: writes, reads, environment, network, limits, cancellation and isolation", {
  skip: process.env.DEVSPACE_REQUIRE_SANDBOX_COMMAND !== "1" && process.env.REQUIRED_SANDBOX_TESTS !== "1" ? "Set DEVSPACE_REQUIRE_SANDBOX_COMMAND=1 (or REQUIRED_SANDBOX_TESTS=1) to require real OS isolation" : false,
  timeout: 120_000,
}, async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "localworks-sandbox-test-")));
  const workspace = join(base, "workspace");
  const other = join(base, "other");
  await mkdir(workspace); await mkdir(other);
  const run = (command: string, extra: Partial<Parameters<typeof runSandboxCommand>[0]> = {}) => runSandboxCommand({ workspaceRoot: workspace, cwd: ".", command, timeoutMs: 15_000, ...extra });
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  try {
    await t.test("installed Node executes a workspace script with filesystem assertions", async () => {
      await writeFile(join(workspace, "build.mjs"), [
        'import { mkdir, writeFile, readFile } from "node:fs/promises";',
        'import assert from "node:assert/strict";',
        'await mkdir("build", { recursive: true });',
        'await writeFile("build/result.json", JSON.stringify({ built: true }));',
        'assert.deepEqual(JSON.parse(await readFile("build/result.json", "utf8")), { built: true });',
        'console.log("node-build-ok");',
      ].join("\n"));
      const result = await run(`${quote(process.execPath)} build.mjs`);
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.output.trim(), "node-build-ok");
      assert.deepEqual(JSON.parse(await readFile(join(workspace, "build/result.json"), "utf8")), { built: true });
    });
    await t.test("arbitrary pipelines work; inside write succeeds; outside write and read fail", async () => {
      await writeFile(join(other, "secret"), "outside-secret");
      const result = await run(`printf 'hello' | tr a-z A-Z > inside; cat inside; if printf bad > ${quote(join(other, "escape"))}; then exit 41; fi; if cat ${quote(join(other, "secret"))}; then exit 42; fi`);
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(await readFile(join(workspace, "inside"), "utf8"), "HELLO");
      await assert.rejects(readFile(join(other, "escape")));
      assert.ok(!result.output.includes("outside-secret"));
    });
    await t.test("symlink escapes and protected credential files are denied", async () => {
      await symlink(other, join(workspace, "escape-link"));
      await writeFile(join(workspace, ".env"), "credential-canary");
      const result = await run("if cat .env; then exit 40; fi; if echo bad > .env; then exit 41; fi; if echo bad > escape-link/new; then exit 42; fi");
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(await readFile(join(workspace, ".env"), "utf8"), "credential-canary");
      await assert.rejects(run("true", { cwd: "escape-link" }), /cwd/);
    });
    await t.test("selected variables only; onData receives buffers", async () => {
      process.env.LOCALWORKS_SANDBOX_TEST_SELECTED = "selected";
      process.env.LOCALWORKS_SANDBOX_TEST_SECRET = "hidden";
      try {
        const chunks: Buffer[] = [];
        const result = await run('printf "%s:%s" "$LOCALWORKS_SANDBOX_TEST_SELECTED" "${LOCALWORKS_SANDBOX_TEST_SECRET-unset}"', {
          environment: ["LOCALWORKS_SANDBOX_TEST_SELECTED"], onData: chunk => { assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk); },
        });
        assert.equal(result.exitCode, 0, result.output);
        assert.equal(result.output, "selected:unset");
        assert.equal(Buffer.concat(chunks).toString(), result.output);
      } finally {
        delete process.env.LOCALWORKS_SANDBOX_TEST_SELECTED;
        delete process.env.LOCALWORKS_SANDBOX_TEST_SECRET;
      }
    });
    await t.test("network denied by default", async () => {
      const result = await run("if /usr/bin/curl -fsS --max-time 3 https://example.com; then exit 40; fi");
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.ok(/403|denied|connect|resolve|Operation not permitted/i.test(result.output), result.output);
    });
    await t.test("raw loopback connection is denied against a verified live server", async () => {
      let hits = 0;
      const server = createServer((_req, res) => { hits++; res.end("reachable"); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}`;
        assert.equal(await (await fetch(url)).text(), "reachable");
        assert.equal(hits, 1);
        const result = await run(`/usr/bin/curl --noproxy '*' -fsS --max-time 2 ${url}`);
        assert.notEqual(result.exitCode, 0, JSON.stringify(result));
        assert.equal(hits, 1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
    await t.test("output retention drains 250k log and permits final artifact", async () => {
      let delivered = 0;
      let truncations = 0;
      let completed = false;
      const result = await run(`${quote(process.execPath)} -e 'const fs = require("fs"); fs.writeFileSync("producer-pid", String(process.pid)); process.stdout.write("x".repeat(250000), () => setTimeout(() => fs.writeFileSync("final-artifact", "success"), 1000))'`, {
        maxOutputBytes: 100, onData: chunk => { delivered += chunk.length; },
        onOutputTruncated: () => {
          truncations++;
          assert.equal(completed, false);
          assert.equal(existsSync(join(workspace, "final-artifact")), false);
          process.kill(Number(readFileSync(join(workspace, "producer-pid"), "utf8")), 0);
        },
      });
      completed = true;
      assert.equal(truncations, 1);
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.outputTruncated, true);
      assert.equal(delivered, 100);
      assert.equal(result.output, "x".repeat(100));
      assert.equal(await readFile(join(workspace, "final-artifact"), "utf8"), "success");
    });
    await t.test("output overflow does not defeat runaway timeout", async () => {
      const result = await run("while :; do printf 1234567890; done", { maxOutputBytes: 100, timeoutMs: 2000 });
      assert.equal(result.outputTruncated, true);
      assert.equal(result.timedOut, true);
      assert.ok(Buffer.byteLength(result.output) <= 100);
    });
    await t.test("UTF8 truncation never returns a split codepoint", async () => {
      const result = await run("printf '你好世界'", { maxOutputBytes: 4 });
      assert.equal(result.exitCode, 0);
      assert.equal(result.output, "你");
      assert.equal(result.outputTruncated, true);
    });
    await t.test("Apple/system git init status diff add commit uses fixture identity", async () => {
      const result = await run("set -e; mkdir repo; cd repo; git init; printf first > tracked; git add tracked; git -c user.name=SandboxFixture -c user.email=sandbox@example.invalid -c commit.gpgsign=false commit -m fixture; git status --porcelain; printf second > tracked; if git diff --exit-code; then exit 40; else test $? = 1; fi");
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.match(result.output, /SandboxFixture|fixture/);
      assert.match(result.output, /diff --git/);
    });
    await t.test("external git directory is never granted worktree writes", async () => {
      await mkdir(join(other, "git-state"));
      await mkdir(join(workspace, "linked-worktree"));
      await writeFile(join(workspace, "linked-worktree/.git"), `gitdir: ${join(other, "git-state")}\n`);
      const result = await run(`if git -C linked-worktree status; then exit 40; fi; if echo tampered > ${quote(join(other, "git-state/config"))}; then exit 41; fi`);
      assert.equal(result.exitCode, 0, result.output);
      await assert.rejects(readFile(join(other, "git-state/config")));
    });
    await t.test("owner toolchain reads are bounded and state aliases are protected", async () => {
      const toolchain = join(other, "toolchain");
      const state = join(workspace, "receipts");
      await mkdir(toolchain); await mkdir(state);
      await writeFile(join(toolchain, "resource"), "tool-resource");
      await writeFile(join(state, "receipt"), "state-secret");
      const alias = join(other, "state-alias");
      await symlink(state, alias);
      const result = await run(`cat ${quote(join(toolchain, "resource"))}; if cat receipts/receipt; then exit 40; fi; if echo tamper > receipts/receipt; then exit 41; fi; if mv receipts moved-state; then exit 42; fi`, {
        readRoots: [toolchain], protectedPaths: [alias],
      });
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /tool-resource/);
      assert.ok(!result.output.includes("state-secret"));
      assert.equal(await readFile(join(state, "receipt"), "utf8"), "state-secret");
      await assert.rejects(run("true", { readRoots: [alias], protectedPaths: [state] }), /overlaps/);
      await assert.rejects(run("true", { protectedPaths: [join(other, "missing")] }));
      await assert.rejects(run("true", { readRoots: [join(toolchain, "resource")] }), /directories/);
    });
    await t.test("local listening default denied; explicit host HTTP access and stop releases port", async () => {
      await writeFile(join(workspace, "listen.mjs"), 'import { createServer } from "node:http"; const s = createServer((q,r) => r.end("sandbox-http")); s.on("error", e => { console.error(e.code); process.exitCode=1; }); s.listen(0,"127.0.0.1", () => console.log(s.address().port));');
      const denied = await run(`${quote(process.execPath)} listen.mjs`);
      assert.notEqual(denied.exitCode, 0, JSON.stringify(denied));
      assert.match(denied.output, /EPERM|EACCES/);
      if (process.platform !== "darwin") {
        await assert.rejects(run("true", { allowLocalBinding: true }), /cannot enforce/);
        return;
      }
      const controller = new AbortController();
      let resolvePort!: (port: number) => void;
      let rejectPort!: (error: unknown) => void;
      const portReady = new Promise<number>((resolve, reject) => { resolvePort = resolve; rejectPort = reject; });
      let output = "";
      const pending = run(`${quote(process.execPath)} listen.mjs`, {
        allowLocalBinding: true, signal: controller.signal,
        onData: chunk => { output += chunk.toString(); if (/^\d+\n/.test(output)) resolvePort(Number(output.trim())); },
      });
      void pending.then(() => rejectPort(new Error(`Server stopped before ready: ${output}`)), rejectPort);
      try {
        const port = await portReady;
        assert.equal(await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) })).text(), "sandbox-http");
        controller.abort();
        assert.equal((await pending).aborted, true);
        const probe = createServer();
        await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
        await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
      } finally { controller.abort(); await pending; }
    });
    await t.test("timeout terminates shell and ordinary background descendants", async () => {
      const result = await run("sleep 30 & echo $! > descendant; wait", { timeoutMs: 2000 });
      assert.equal(result.timedOut, true);
      const pid = Number(await readFile(join(workspace, "descendant"), "utf8"));
      // Killing the process group happens before the promise resolves.
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    });
    await t.test("abort is propagated", async () => {
      const controller = new AbortController();
      const pending = run("echo ready; sleep 30", { signal: controller.signal, onData: () => controller.abort() });
      assert.equal((await pending).aborted, true);
    });
    await t.test("normal completion removes background descendants", async () => {
      const result = await run("sleep 30 > /dev/null 2>&1 & echo $! > background; exit 0");
      assert.equal(result.exitCode, 0, result.output);
      const pid = Number(await readFile(join(workspace, "background"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    });
    await t.test("invalid sandbox policy fails closed without running command", async () => {
      await assert.rejects(run("echo unsafe > never-executed", { allowedDomains: ["https://example.com/path"] }), /Sandbox/);
      await assert.rejects(readFile(join(workspace, "never-executed")));
    });
    await t.test("concurrent policies cannot grant another workspace writes", async () => {
      const [a, b] = await Promise.all([
        run(`if echo bad > ${quote(join(other, "cross"))}; then exit 41; fi; echo own > own`),
        runSandboxCommand({ workspaceRoot: other, cwd: ".", command: "echo second > own", timeoutMs: 15_000 }),
      ]);
      assert.equal(a.exitCode, 0, a.output); assert.equal(b.exitCode, 0, b.output);
      await assert.rejects(readFile(join(other, "cross")));
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
