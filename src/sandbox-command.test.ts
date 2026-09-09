import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { createSandboxCommandPolicy, runSandboxCommand, selectSandboxEnvironment, sandboxWorkerError, SandboxCleanupError, reduceSandboxError, type SandboxErrorState } from "./sandbox-command.js";

test("worker error serialization preserves cleanup failures separately from command errors", () => {
  const wire = JSON.parse(JSON.stringify({ error: "reset failed", cleanupFailed: true }));
  assert.ok(sandboxWorkerError(wire) instanceof SandboxCleanupError);
  assert.equal((sandboxWorkerError(wire) as SandboxCleanupError).code, "SANDBOX_CLEANUP_FAILED");
  assert.ok(!(sandboxWorkerError({ error: "unsupported platform", cleanupFailed: false }) instanceof SandboxCleanupError));
});

test("cleanup failures outrank ordinary errors in either event order, even after confirmation", () => {
  const ordinary = new Error("callback failed");
  const cleanup = new SandboxCleanupError("process group cleanup failed");
  for (const ordering of [[ordinary, cleanup], [cleanup, ordinary]]) {
    let state: SandboxErrorState = { cleanupConfirmed: false };
    for (const error of ordering) state = reduceSandboxError(state, { type: "error", error });
    state = reduceSandboxError(state, { type: "workerError", error: "later command error", cleanupFailed: false });
    state = reduceSandboxError(state, { type: "cleanupConfirmed" });
    state = reduceSandboxError(state, { type: "closed" });
    assert.equal(state.cleanupFailed, cleanup);
    assert.equal(state.error, ordinary);
    assert.equal(state.cleanupConfirmed, true);
  }
});

test("missing cleanup confirmation is typed despite ordinary errors; explicit reset confirmation preserves them", () => {
  const ordinary = new Error("worker spawn failed");
  const initial = reduceSandboxError({ cleanupConfirmed: false }, { type: "error", error: ordinary });
  const unconfirmed = reduceSandboxError(initial, { type: "closed" });
  assert.ok(unconfirmed.cleanupFailed instanceof SandboxCleanupError);
  assert.equal(unconfirmed.cleanupFailed.cause, ordinary);
  assert.ok(reduceSandboxError({ cleanupConfirmed: false }, { type: "closed" }).cleanupFailed instanceof SandboxCleanupError);
  for (const cleanupFailed of [undefined, true, false]) {
    for (const workerFirst of [true, false]) {
      let state: SandboxErrorState = { cleanupConfirmed: false };
      const worker = { type: "workerError" as const, error: "worker error", cleanupFailed };
      const callback = { type: "error" as const, error: ordinary };
      for (const event of workerFirst ? [worker, callback] : [callback, worker]) state = reduceSandboxError(state, event);
      state = reduceSandboxError(state, { type: "closed" });
      assert.equal(state.cleanupConfirmed, cleanupFailed === false);
      assert.equal(state.cleanupFailed instanceof SandboxCleanupError, cleanupFailed !== false);
      assert.ok(state.error instanceof Error);
    }
  }
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

test("timezone selection preserves validated TZ without ambient environment expansion", () => {
  assert.equal(selectSandboxEnvironment([], { TZ: "Asia/Shanghai", SECRET: "hidden" }).TZ, "Asia/Shanghai");
  assert.equal(selectSandboxEnvironment([], {}).TZ, Intl.DateTimeFormat().resolvedOptions().timeZone);
  for (const TZ of ["/etc/localtime", ":/etc/localtime", "../secret", "invalid/zone", "Asia/Shanghai\0"]) {
    assert.throws(() => selectSandboxEnvironment([], { TZ }), /Invalid TZ/);
  }
});

test("trusted metadata grants are separate, bounded and cannot override protected paths", () => {
  const read = "/home/owner/projects/repo/.git";
  const write = `${read}/worktrees/linked`;
  const pointer = "/home/owner/projects/linked/.git";
  const policy = createSandboxCommandPolicy("/work/project", "/home/owner", "/app/server", [], {
    gitMetadata: { readRoots: [read], writeRoots: [write], readFiles: [pointer] },
  });
  assert.ok(policy.filesystem.allowRead?.includes(read));
  assert.ok(policy.filesystem.allowWrite?.includes(write));
  assert.ok(!policy.filesystem.allowWrite?.includes(read));
  assert.ok(policy.filesystem.allowRead?.includes(pointer));
  assert.ok(policy.filesystem.denyWrite?.includes(pointer));
  assert.ok(!policy.filesystem.allowRead?.includes(dirname(pointer)));
  assert.ok(!policy.filesystem.allowWrite?.includes(pointer));
  for (const root of ["/", "/home/owner", "/home/owner/.ssh", "/app/server/.git", "/var/folders", "/private/var/folders", "/Volumes", "/Volumes/disk", "/work/project", "/tmp", "/work/*"]) {
    assert.throws(() => createSandboxCommandPolicy("/work/project", "/home/owner", "/app/server", [], {
      gitMetadata: { readRoots: [], writeRoots: [root] },
    }));
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
    await t.test("actual toolchain PATH avoids Apple shim cache even for git --version", async () => {
      const result = await run("command -v git; git --version");
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /git version/);
      assert.doesNotMatch(result.output, /xcrun_db|denied|Operation not permitted/i);
      if (process.platform === "darwin") assert.match(result.output.split("\n")[0]!, /\/Developer\/usr\/bin\/git|\/CommandLineTools\/usr\/bin\/git/);
    });
    await t.test("date offset agrees with Intl system timezone", async () => {
      const result = await run("date +%z");
      assert.equal(result.exitCode, 0, result.output);
      const zone = selectSandboxEnvironment([]).TZ;
      const offset = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date()).find(p => p.type === "timeZoneName")!.value;
      assert.equal(result.output.trim(), offset === "GMT" ? "+0000" : offset.replace("GMT", "").replace(":", ""));
    });
    await t.test("explicit Apple shim is measured without global cache grants", async (t) => {
      if (process.platform !== "darwin") return;
      const result = await run("/usr/bin/git --version");
      t.diagnostic(`explicit /usr/bin/git: ${JSON.stringify(result)}`);
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /git version/);
      const previous = process.env.xcrun_nocache;
      process.env.xcrun_nocache = "1";
      try {
        const uncached = await run("/usr/bin/git --version", { environment: ["xcrun_nocache"] });
        t.diagnostic(`documented xcrun_nocache=1: ${JSON.stringify(uncached)}`);
        assert.equal(uncached.exitCode, 0, uncached.output);
        assert.match(uncached.output, /git version/);
      } finally { if (previous === undefined) delete process.env.xcrun_nocache; else process.env.xcrun_nocache = previous; }
    });
    await t.test("owned scratch directories are private, writable and cleaned on every return path", async () => {
      const root = await realpath(tmpdir());
      const before = (await readdir(root)).filter(p => p.startsWith("devspace-command-"));
      for (const mode of ["success", "failure", "abort", "callback", "timeout"] as const) {
        const controller = new AbortController();
        let output = "";
        const pending = run('printf "%s\\n%s\\n%s\\n%s\\n" "$TMPDIR" "$TEMP" "$TMP" "$XDG_CACHE_HOME"; touch "$TMPDIR/probe" "$XDG_CACHE_HOME/probe"; ' + (mode === "failure" ? "exit 7" : mode === "success" ? "true" : "sleep 30"), {
          signal: controller.signal, timeoutMs: mode === "timeout" ? 1000 : 15000,
          onData: chunk => { output += chunk.toString(); if (mode === "abort") controller.abort(); if (mode === "callback") throw new Error("callback-failure"); },
        });
        if (mode === "callback") await assert.rejects(pending, /callback-failure/);
        else {
          const result = await pending;
          if (mode === "failure") assert.equal(result.exitCode, 7);
          if (mode === "success") assert.equal(result.exitCode, 0, result.output);
          if (mode === "abort") assert.equal(result.aborted, true);
          if (mode === "timeout") assert.equal(result.timedOut, true);
        }
        const paths = output.trim().split("\n");
        assert.equal(paths[0], paths[1]); assert.equal(paths[1], paths[2]);
        assert.ok(paths[0]!.startsWith(join(root, "devspace-command-")), output);
        for (const path of paths.slice(0, 4)) assert.equal(existsSync(path), false, path);
      }
      await assert.rejects(run("true", { allowedDomains: ["https://invalid/path"] }));
      await assert.rejects(run("true", { gitMetadata: { readRoots: [], writeRoots: [root] } }));
      assert.equal((await run("true", { signal: AbortSignal.abort() })).aborted, true);
      assert.deepEqual((await readdir(root)).filter(p => p.startsWith("devspace-command-")), before);
    });
    await t.test("trusted linked git metadata grants permit only selected writes", async () => {
      const metadata = join(other, "metadata");
      await mkdir(metadata);
      await writeFile(join(metadata, "HEAD"), "fixture");
      const readOnly = await run(`cat ${quote(join(metadata, "HEAD"))}; if echo bad > ${quote(join(metadata, "HEAD"))}; then exit 40; fi`, { gitMetadata: { readRoots: [metadata], writeRoots: [] } });
      assert.equal(readOnly.exitCode, 0, readOnly.output);
      const writable = await run(`echo updated > ${quote(join(metadata, "HEAD"))}; if echo bad > ${quote(join(other, "ungranted"))}; then exit 40; fi`, { gitMetadata: { readRoots: [metadata], writeRoots: [metadata] } });
      assert.equal(writable.exitCode, 0, writable.output);
      assert.equal(await readFile(join(metadata, "HEAD"), "utf8"), "updated\n");
      const alias = join(other, "metadata-alias"); await symlink(metadata, alias);
      await assert.rejects(run("true", { gitMetadata: { readRoots: [alias], writeRoots: [] }, protectedPaths: [metadata] }), /overlap/);
    });
    await t.test("scratch cleanup errors are surfaced and a subsequent command remains usable", async () => {
      // Privileged users can bypass directory permissions; this real failure
      // injection exercises the ordinary macOS/Linux user that runs DevSpace.
      if (process.getuid?.() === 0) return;
      let scratch: string | undefined;
      try {
        await assert.rejects(run('printf "%s\\n" "$TMPDIR"', {
          onData: chunk => {
            scratch = dirname(chunk.toString().trim());
            assert.match(scratch, /\/devspace-command-[^/]+$/);
            chmodSync(scratch, 0);
          },
        }), error => error instanceof SandboxCleanupError && /scratch cleanup failed/.test(error.message));
      } finally {
        if (scratch) { await chmod(scratch, 0o700); await rm(scratch, { recursive: true, force: true }); }
      }
      assert.equal((await run("true")).exitCode, 0);
    });
    await t.test("metadata descendant symlinks never grant external reads or writes", async () => {
      const metadata = join(other, "symlink-metadata");
      const external = join(other, "ungranted-metadata-target");
      await mkdir(metadata); await mkdir(external);
      await writeFile(join(external, "secret"), "metadata-external-secret");
      await symlink(external, join(metadata, "objects"));
      await symlink(join(external, "secret"), join(metadata, "HEAD"));
      const result = await run(`if cat ${quote(join(metadata, "objects/secret"))}; then exit 40; fi; if cat ${quote(join(metadata, "HEAD"))}; then exit 41; fi; if echo bad > ${quote(join(metadata, "objects/new"))}; then exit 42; fi; if echo bad > ${quote(join(metadata, "HEAD"))}; then exit 43; fi`, {
        gitMetadata: { readRoots: [metadata], writeRoots: [metadata] },
      });
      assert.equal(result.exitCode, 0, result.output);
      assert.doesNotMatch(result.output, /metadata-external-secret/);
      assert.equal(await readFile(join(external, "secret"), "utf8"), "metadata-external-secret");
      assert.equal(existsSync(join(external, "new")), false);
    });
    await t.test("metadata readFiles canonicalizes regular files and never grants parent access or writes", async () => {
      const parent = join(other, "pointer-parent");
      await mkdir(parent);
      const pointer = join(parent, ".git");
      const contents = "gitdir: fixture\n";
      await writeFile(pointer, contents);
      await writeFile(join(parent, "unrelated"), "parent-private");
      const alias = join(other, "pointer-alias"); await symlink(pointer, alias);
      const metadata = { readRoots: [], writeRoots: [], readFiles: [alias] };
      const result = await run(`cat ${quote(pointer)}; if cat ${quote(join(parent, "unrelated"))}; then exit 40; fi; if echo bad > ${quote(pointer)}; then exit 41; fi; if rm ${quote(pointer)}; then exit 42; fi`, { gitMetadata: metadata });
      assert.equal(result.exitCode, 0, result.output);
      assert.ok(result.output.includes(contents));
      assert.doesNotMatch(result.output, /parent-private/);
      assert.equal(await readFile(pointer, "utf8"), contents);
      for (const file of [parent, "/dev/null", join(parent, "missing"), "relative"]) {
        await assert.rejects(run("true", { gitMetadata: { ...metadata, readFiles: [file] } }));
      }
      await assert.rejects(run("true", { gitMetadata: metadata, protectedPaths: [parent] }), /overlap/);
      const overlapping = await run(`if echo bad > ${quote(pointer)}; then exit 40; fi; if rm ${quote(pointer)}; then exit 41; fi`, { gitMetadata: { ...metadata, writeRoots: [parent] } });
      assert.equal(overlapping.exitCode, 0, overlapping.output);
      assert.equal(await readFile(pointer, "utf8"), contents);
    });
    await t.test("real linked worktree uses separately granted common .git and per-worktree metadata", async (t) => {
      const setup = await runSandboxCommand({ workspaceRoot: base, cwd: ".", command: "set -e; git init source; cd source; git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit --allow-empty -m fixture; git worktree add ../linked -b linked" });
      assert.equal(setup.exitCode, 0, setup.output);
      const common = join(base, "source/.git");
      const linked = join(base, "linked");
      const denied = await runSandboxCommand({ workspaceRoot: linked, cwd: ".", command: "git status --porcelain" });
      assert.notEqual(denied.exitCode, 0, denied.output);
      const granted = await runSandboxCommand({ workspaceRoot: linked, cwd: ".", command: "set -e; echo tracked > tracked; git add tracked; git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -m linked; git status --porcelain", gitMetadata: { readRoots: [common], writeRoots: [common] } });
      assert.equal(granted.exitCode, 0, granted.output);
      assert.match(granted.output, /1 file changed/);
      await t.test("restricted nested Git fails; explicit checkout-root workspace preserves nested Git semantics", async () => {
        const nested = join(linked, "nested");
        const pointer = join(linked, ".git");
        await mkdir(nested);
        await writeFile(join(linked, "unrelated"), "parent-unrelated-secret");
        const original = await readFile(pointer, "utf8");
        const expected = (await readFile(join(common, "refs/heads/linked"), "utf8")).trim();
        const metadata = { readRoots: [common], writeRoots: [], readFiles: [pointer] };
        const withoutPointer = await runSandboxCommand({ workspaceRoot: nested, cwd: ".", command: "git rev-parse HEAD", gitMetadata: { readRoots: [common], writeRoots: [] } });
        assert.notEqual(withoutPointer.exitCode, 0, withoutPointer.output);
        const restricted = await runSandboxCommand({ workspaceRoot: nested, cwd: ".", command: "git rev-parse HEAD", gitMetadata: metadata });
        assert.notEqual(restricted.exitCode, 0, restricted.output);
        assert.match(restricted.output, /Operation not permitted|Permission denied|not a git repository/i);
        const result = await runSandboxCommand({ workspaceRoot: nested, cwd: ".", command: `set -e; cat ${quote(pointer)}; if cat ../unrelated; then exit 40; fi; if echo bad > ../.git; then exit 41; fi; if rm ../.git; then exit 42; fi; if echo bad > ../unrelated; then exit 43; fi`, gitMetadata: metadata });
        assert.equal(result.exitCode, 0, result.output);
        assert.ok(result.output.includes(original.trim()), result.output);
        assert.doesNotMatch(result.output, /parent-unrelated-secret/);
        assert.equal(await readFile(pointer, "utf8"), original);
        assert.equal(await readFile(join(linked, "unrelated"), "utf8"), "parent-unrelated-secret");
        await writeFile(join(nested, "inside"), "nested-change");
        await writeFile(join(linked, "tracked"), "parent-change");
        const gitDir = original.trim().slice("gitdir: ".length);
        const indexBefore = await readFile(join(gitDir, "index"));
        const supported = await runSandboxCommand({ workspaceRoot: linked, cwd: "nested", command: "set -e; git rev-parse HEAD; git rev-parse --show-toplevel; git status --porcelain --untracked-files=all -- .", gitMetadata: metadata });
        assert.equal(supported.exitCode, 0, supported.output);
        assert.deepEqual(supported.output.trimEnd().split("\n"), [expected, linked, "?? nested/inside"]);
        assert.deepEqual(await readFile(join(gitDir, "index")), indexBefore);
        assert.equal(await readFile(pointer, "utf8"), original);
        for (const file of [linked, "/dev/null", join(linked, "missing"), "relative"]) {
          await assert.rejects(run("true", { gitMetadata: { ...metadata, readFiles: [file] } }));
        }
        const protectedFile = join(nested, ".env");
        await writeFile(protectedFile, "hidden");
        const alias = join(other, "protected-file-alias"); await symlink(protectedFile, alias);
        await assert.rejects(runSandboxCommand({ workspaceRoot: nested, cwd: ".", command: "true", gitMetadata: { ...metadata, readFiles: [alias] } }), /overlap/);
        // denyWrite must also win when a trusted directory grant covers the file.
        const commonHead = join(common, "HEAD");
        const headBefore = await readFile(commonHead, "utf8");
        const overlapping = await runSandboxCommand({ workspaceRoot: nested, cwd: ".", command: `if echo bad > ${quote(commonHead)}; then exit 40; fi`, gitMetadata: { ...metadata, writeRoots: [common], readFiles: [pointer, commonHead] } });
        assert.equal(overlapping.exitCode, 0, overlapping.output);
        assert.equal(await readFile(commonHead, "utf8"), headBefore);
        assert.equal(await readFile(pointer, "utf8"), original);
      });
    });
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
