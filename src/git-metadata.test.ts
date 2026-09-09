import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveGitMetadata } from "./git-metadata.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "devspace-git-metadata-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "owner");
  const workspace = join(root, "linked");
  const common = join(root, "main", ".git");
  const metadata = join(common, "worktrees", "linked");
  await mkdir(workspace, { recursive: true });
  await mkdir(metadata, { recursive: true });
  await mkdir(join(common, "objects"));
  await mkdir(join(common, "refs"));
  await writeFile(join(common, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(metadata, "HEAD"), "ref: refs/heads/linked\n");
  await writeFile(join(metadata, "commondir"), "../..\n");
  await writeFile(join(metadata, "gitdir"), `${join(workspace, ".git")}\n`);
  await writeFile(join(workspace, ".git"), `gitdir: ${metadata}\n`);
  return { temp, root, workspace, common, metadata };
}

test("ordinary checkout needs no extra grants, but supplies common lock identity", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await resolveGitMetadata(dirname(f.common), [f.root]), {
    readRoots: [], writeRoots: [], commonDir: f.common,
  });
});

test("nested workspaces discover metadata only within approved ancestors", async (t) => {
  const f = await fixture(t);
  const nested = join(dirname(f.common), "source");
  await mkdir(nested);
  assert.deepEqual(await resolveGitMetadata(nested, [f.root]), { readRoots: [f.common], writeRoots: [f.common], commonDir: f.common, checkoutRoot: dirname(f.common) });
  assert.deepEqual(await resolveGitMetadata(nested, [nested]), { readRoots: [], writeRoots: [] });
  assert.deepEqual(await resolveGitMetadata(nested, [join(f.temp, "missing"), f.root]), { readRoots: [f.common], writeRoots: [f.common], commonDir: f.common, checkoutRoot: dirname(f.common) });
});

test("linked checkout returns canonical outside metadata and common identity", async (t) => {
  const f = await fixture(t);
  const expected = { readRoots: [f.metadata, f.common], writeRoots: [f.metadata, f.common], commonDir: f.common };
  assert.deepEqual(await resolveGitMetadata(f.workspace, [f.root]), expected);
  // A narrower overlapping approval must not mask a valid broader approval.
  assert.deepEqual(await resolveGitMetadata(f.workspace, [f.workspace, f.root]), expected);
  assert.deepEqual(await resolveGitMetadata(f.workspace, [f.workspace, dirname(f.common)]), expected);
  await writeFile(join(f.workspace, ".git"), `gitdir: ${relative(f.workspace, f.metadata)}\r\n`);
  await writeFile(join(f.metadata, "gitdir"), `${relative(f.metadata, join(f.workspace, ".git"))}\n`);
  const alias = join(f.temp, "owner-alias");
  await symlink(f.root, alias, "dir");
  assert.deepEqual(await resolveGitMetadata(join(alias, "linked"), [alias]), expected);
  const nested = join(f.workspace, "nested");
  await mkdir(nested);
  assert.deepEqual(await resolveGitMetadata(nested, [f.root]), { ...expected, readFiles: [join(f.workspace, ".git")], checkoutRoot: f.workspace });
});

test("worktree whose common metadata is within workspace needs no extra grants", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".git"), `gitdir: ${f.metadata}\n`);
  await writeFile(join(f.metadata, "gitdir"), `${join(f.root, ".git")}\n`);
  assert.deepEqual(await resolveGitMetadata(f.root, [f.root]), {
    readRoots: [], writeRoots: [], commonDir: f.common,
  });
});

test("workspace and metadata both require owner approval", async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolveGitMetadata(f.workspace, [f.workspace]), /outside owner-approved/);
  await assert.rejects(resolveGitMetadata(f.workspace, [f.common]), /outside owner-approved/);
  await assert.rejects(resolveGitMetadata(f.workspace, []), /outside owner-approved/);
});

for (const content of ["", "gitdir:", "gitdir: ", "garbage", "gitdir: /tmp\nsecond", "gitdir: a\0b", "x".repeat(4097)]) {
  test(`reject malformed or oversized pointer ${JSON.stringify(content.slice(0, 30))}`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.workspace, ".git"), content);
    await assert.rejects(resolveGitMetadata(f.workspace, [f.root]));
  });
}

for (const file of ["HEAD", "commondir", "gitdir"]) {
  test(`reject missing or non-regular ${file}`, async (t) => {
    const f = await fixture(t);
    const path = join(f.metadata, file);
    await rm(path);
    await assert.rejects(resolveGitMetadata(f.workspace, [f.root]));
    await mkdir(path);
    await assert.rejects(resolveGitMetadata(f.workspace, [f.root]));
  });
}

test("reject missing metadata and common object/reference structure", async (t) => {
  const f = await fixture(t);
  await rm(join(f.common, "objects"), { recursive: true });
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]));
  await mkdir(join(f.common, "objects"));
  await rm(join(f.common, "refs"), { recursive: true });
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]));
  await writeFile(join(f.workspace, ".git"), `gitdir: ${join(f.root, "absent")}\n`);
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]));
});

test("support detached SHA-256 HEAD and reftable layout", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.metadata, "HEAD"), `${"a".repeat(64)}\n`);
  await rm(join(f.common, "refs"), { recursive: true });
  await mkdir(join(f.common, "reftable"));
  assert.equal((await resolveGitMetadata(f.workspace, [f.root])).commonDir, f.common);
});

test("reject forged backlink, copied pointer and unexpected registry", async (t) => {
  const f = await fixture(t);
  const fake = join(f.root, "fake");
  await mkdir(fake);
  await writeFile(join(fake, ".git"), await readFile(join(f.workspace, ".git")));
  await assert.rejects(resolveGitMetadata(fake, [f.root]), /backlink mismatch/);
  await writeFile(join(f.metadata, "gitdir"), `${join(fake, ".git")}\n`);
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]), /backlink mismatch/);
  await writeFile(join(f.metadata, "commondir"), `${f.root}\n`);
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]));
});

test("reject symlink .git and symlink pointer files even within approval", async (t) => {
  const f = await fixture(t);
  const pointer = join(f.workspace, ".git");
  await rm(pointer);
  await symlink(f.common, pointer, "dir");
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]), /not a symlink/);
  await rm(pointer);
  await writeFile(pointer, `gitdir: ${f.metadata}\n`);
  const backlink = join(f.metadata, "gitdir");
  await rm(backlink);
  const other = join(f.root, "backlink");
  await writeFile(other, `${pointer}\n`);
  await symlink(other, backlink);
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]), /regular pointer/);
});

test("descendant symlinks never extend the metadata grant", async (t) => {
  const f = await fixture(t);
  const nested = join(f.common, "objects", "nested");
  await mkdir(nested);
  const outside = join(f.temp, "outside");
  await mkdir(outside);
  const link = join(nested, "escape");
  await symlink(outside, link, "dir");
  assert.deepEqual((await resolveGitMetadata(f.workspace, [f.root])).readRoots, [f.metadata, f.common]);
  assert.deepEqual((await resolveGitMetadata(f.workspace, [f.temp])).readRoots, [f.metadata, f.common]);
  await rm(link);
  await symlink(join(f.common, "refs"), link, "dir");
  assert.equal((await resolveGitMetadata(f.workspace, [f.root])).commonDir, f.common);
  await rm(link);
  await symlink(join(outside, "missing"), link);
  assert.deepEqual((await resolveGitMetadata(f.workspace, [f.root])).readRoots, [f.metadata, f.common]);
});

test("reject an intermediate symlink concealing outside metadata", async (t) => {
  const f = await fixture(t);
  const alias = join(f.workspace, "hidden");
  await symlink(dirname(f.common), alias, "dir");
  await writeFile(join(f.workspace, ".git"), `gitdir: ${join(alias, ".git", "worktrees", "linked")}\n`);
  await assert.rejects(resolveGitMetadata(f.workspace, [f.workspace]), /outside owner-approved/);
});

test("reject ordinary commondir redirection and malformed HEAD", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.common, "commondir"), "../elsewhere\n");
  await assert.rejects(resolveGitMetadata(dirname(f.common), [f.root]), /unexpectedly contains commondir/);
  await rm(join(f.common, "commondir"));
  await writeFile(join(f.metadata, "HEAD"), "not a HEAD\n");
  await assert.rejects(resolveGitMetadata(f.workspace, [f.root]), /malformed HEAD/);
});

test("real disposable Git worktrees share identity; discovery never runs hooks or config", async (t) => {
  const f = await fixture(t);
  const main = join(f.root, "real-main");
  const linked = join(f.root, "real-linked");
  const second = join(f.root, "real-second");
  const home = join(f.temp, "isolated-home");
  const template = join(f.temp, "empty-template");
  await mkdir(home);
  await mkdir(template);
  // Explicitly clean environment: no inherited GIT_CONFIG/GIT_DIR, user config,
  // templates or hooks. Commands only create repositories inside this fixture.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "absent-config"), GIT_TEMPLATE_DIR: template,
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = async (...args: string[]) => promisify(execFile)("git", args, { cwd: f.temp, env, timeout: 15_000 });
  await git("init", main);
  await git("-C", main, "commit", "--allow-empty", "-m", "fixture");
  await git("-C", main, "worktree", "add", "-b", "fixture-linked", linked);
  await git("-C", main, "worktree", "add", "-b", "fixture-second", second);
  const expectedCommon = await realpath(join(main, ".git"));
  const marker = await readFile(join(linked, ".git"), "utf8");
  const config = join(expectedCommon, "config");
  await writeFile(config, "intentionally invalid config; discovery must not invoke Git\n");
  const first = await resolveGitMetadata(linked, [f.root]);
  assert.equal(first.commonDir, expectedCommon);
  assert.equal((await resolveGitMetadata(second, [f.root])).commonDir, first.commonDir);
  assert.deepEqual((await resolveGitMetadata(main, [f.root])).readRoots, []);
  assert.equal(first.writeRoots.length, 2);
  assert.equal(await readFile(join(linked, ".git"), "utf8"), marker);
  assert.equal(await readFile(config, "utf8"), "intentionally invalid config; discovery must not invoke Git\n");
});
