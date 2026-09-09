import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, lstat, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeFileOperation as run, MAX_FILE_BYTES, type FileOperation } from "./filesystem-operations.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await mkdtemp(join(tmpdir(), "devspace-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  await mkdir(root);
  return { base, root };
}

test("create/read/edit/replace/move/delete preserve exact text and version metadata", async (t) => {
  const { root } = await fixture(t);
  const original = "alpha\r\nβeta\nend";
  const created = await run(root, { action: "create", path: "a", content: original });
  assert.equal(created.sha256, sha(original));
  assert.deepEqual(await run(root, { action: "read", path: "a" }), {
    path: "a", content: original, bytes: Buffer.byteLength(original), sha256: sha(original),
  });
  await run(root, { action: "edit", path: "a", expectedSha256: sha(original), edits: [
    { oldText: "alpha", newText: "end" }, { oldText: "end", newText: "done" },
  ] });
  assert.equal(await readFile(join(root, "a"), "utf8"), "end\r\nβeta\ndone");
  await run(root, { action: "replace", path: "a", expectedSha256: sha("end\r\nβeta\ndone"), content: "x" });
  assert.equal(await readFile(join(root, "a"), "utf8"), "x");
  await run(root, { action: "move", path: "a", destination: "b", expectedSha256: sha("x") });
  await assert.rejects(lstat(join(root, "a")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "b"), "utf8"), "x");
  await run(root, { action: "delete", path: "b", expectedSha256: sha("x") });
  await assert.rejects(lstat(join(root, "b")), { code: "ENOENT" });
});

test("create_directory is confined, nonrecursive and idempotent only for real directories", async (t) => {
  const { root, base } = await fixture(t);
  assert.equal((await run(root, { action: "create_directory", path: "src" })).status, "created");
  assert.equal((await run(root, { action: "create_directory", path: "src" })).status, "exists");
  await run(root, { action: "create_directory", path: "src/nested" });
  await writeFile(join(root, "file"), "safe");
  await symlink(base, join(root, "escape"));
  await symlink("src", join(root, "alias"));
  for (const path of ["../outside", join(base, "outside"), "escape/outside", "file", "alias", "missing/nested"]) {
    await assert.rejects(run(root, { action: "create_directory", path }));
  }
  await run(root, { action: "create_directory", path: "alias/inside" });
  assert.ok((await lstat(join(root, "src/inside"))).isDirectory());
  await assert.rejects(lstat(join(base, "outside")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "missing")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "file"), "utf8"), "safe");
});

test("replacement stages a new file, preserves ordinary permissions and leaves no temporary files", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "a"), "original");
  await chmod(join(root, "a"), 0o640);
  const before = await lstat(join(root, "a"));
  await run(root, { action: "replace", path: "a", expectedSha256: sha("original"), content: "new" });
  const after = await lstat(join(root, "a"));
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.equal(await readFile(join(root, "a"), "utf8"), "new");
  assert.deepEqual(await readdir(root), ["a"]);
});

test("all existing-file mutations reject stale or missing hashes without effects", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "a"), "new");
  for (const action of ["edit", "replace", "move", "delete"] as const) {
    for (const expectedSha256 of [sha("old"), undefined]) {
      await assert.rejects(run(root, { action, path: "a", expectedSha256, content: "bad",
        destination: "b", edits: [{ oldText: "new", newText: "bad" }] } as FileOperation), /version changed|expectedSha256/);
      assert.equal(await readFile(join(root, "a"), "utf8"), "new");
      await assert.rejects(lstat(join(root, "b")), { code: "ENOENT" });
    }
  }
});

test("create and move never overwrite files or dangling destination symlinks", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "source"), "source");
  await writeFile(join(root, "target"), "target");
  await symlink("missing", join(root, "dangling"));
  for (const path of ["target", "dangling", "source"]) {
    await assert.rejects(run(root, { action: "create", path, content: "bad" }), { code: "EEXIST" });
    await assert.rejects(run(root, { action: "move", path: "source", destination: path, expectedSha256: sha("source") }), { code: "EEXIST" });
  }
  assert.equal(await readFile(join(root, "target"), "utf8"), "target");
  assert.equal(await readFile(join(root, "source"), "utf8"), "source");
  assert.ok((await lstat(join(root, "dangling"))).isSymbolicLink());
});

test("reject traversal, escaped ancestors and nonregular leaves; allow internal parent symlinks", async (t) => {
  const { root, base } = await fixture(t);
  await writeFile(join(base, "outside"), "safe");
  await symlink(base, join(root, "escape"));
  await mkdir(join(root, "dir"));
  await symlink("dir", join(root, "alias"));
  await symlink(join(base, "outside"), join(root, "leaf"));
  for (const path of ["../outside", join(base, "outside"), "escape/outside", "escape/missing/file", "C:\\outside", "dir/../a"]) {
    await assert.rejects(run(root, { action: "create", path, content: "bad" }));
  }
  for (const path of ["dir", "leaf"]) {
    await assert.rejects(run(root, { action: "read", path }), /regular file/);
    await assert.rejects(run(root, { action: "delete", path, expectedSha256: sha("safe") }), /regular file/);
  }
  await run(root, { action: "create", path: "alias/a", content: "inside" });
  await assert.rejects(run(root, { action: "move", path: "dir/a", destination: "escape/new", expectedSha256: sha("inside") }), /outside/);
  assert.equal(await readFile(join(root, "dir/a"), "utf8"), "inside");
  assert.equal(await readFile(join(base, "outside"), "utf8"), "safe");
});

test("ambiguous, overlapping and missing edits do not partially apply", async (t) => {
  const { root } = await fixture(t);
  const content = "ababa unique";
  await writeFile(join(root, "a"), content);
  for (const edits of [
    [{ oldText: "aba", newText: "bad" }],
    [{ oldText: "ababa", newText: "bad" }, { oldText: "baba", newText: "bad" }],
    [{ oldText: "unique", newText: "changed" }, { oldText: "missing", newText: "bad" }],
    [{ oldText: "", newText: "bad" }],
  ]) {
    await assert.rejects(run(root, { action: "edit", path: "a", edits, expectedSha256: sha(content) }));
    assert.equal(await readFile(join(root, "a"), "utf8"), content);
  }
});

test("bound bytes, reject binary/invalid UTF-8 and prevent hard-link write escape", async (t) => {
  const { root, base } = await fixture(t);
  for (const content of ["é".repeat(MAX_FILE_BYTES / 2 + 1), "a\0b", "\ud800"]) {
    await assert.rejects(run(root, { action: "create", path: "bad", content }));
    await assert.rejects(lstat(join(root, "bad")), { code: "ENOENT" });
  }
  for (const bytes of [Buffer.alloc(MAX_FILE_BYTES + 1, 65), Buffer.from([0xff]), Buffer.from([0])]) {
    await writeFile(join(root, "bad"), bytes);
    await assert.rejects(run(root, { action: "read", path: "bad" }));
  }
  const boundary = "é".repeat(MAX_FILE_BYTES / 2);
  await run(root, { action: "create", path: "limit", content: boundary });
  assert.equal((await run(root, { action: "read", path: "limit" })).bytes, MAX_FILE_BYTES);
  await assert.rejects(run(root, { action: "replace", path: "limit", expectedSha256: sha(boundary), content: boundary + "a" }));
  assert.equal(await readFile(join(root, "limit"), "utf8"), boundary);
  await writeFile(join(base, "outside"), "safe");
  await link(join(base, "outside"), join(root, "linked"));
  await assert.rejects(run(root, { action: "replace", path: "linked", expectedSha256: sha("safe"), content: "bad" }), /multiply linked/);
  assert.equal(await readFile(join(base, "outside"), "utf8"), "safe");
});
