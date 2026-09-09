import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AccessDeniedError, canonicalPathIdentity, expandHomePath, isPathInsideRoot } from "./roots.js";
import { regularFileReadFlags } from "./runtime-capabilities.js";

export interface GitMetadata {
  /** Canonical directories for the caller's sandbox read allowlist. */
  readRoots: string[];
  /** Exact parent .git pointer needed when the workspace is a worktree subdirectory. */
  readFiles?: string[];
  /** Candidates only: requires owner gitMetadataWrite=true and a commonDir lock. */
  writeRoots: string[];
  /** Canonical shared directory; use canonicalPathIdentity(commonDir) as lock key. */
  commonDir?: string;
  /** Present only for a workspace nested beneath the actual checkout root. */
  checkoutRoot?: string;
}

const POINTER_LIMIT = 4096;

function invalid(message: string): never {
  throw new AccessDeniedError(`Invalid Git metadata: ${message}`);
}

function same(a: string, b: string): boolean {
  return canonicalPathIdentity(a) === canonicalPathIdentity(b);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Read-only, fail-closed discovery; never invokes Git or reads Git configuration.
 * Supports ordinary checkouts and reciprocal linked worktrees (including relative
 * pointers). Ancestor discovery stays inside approved roots; environment-based
 * Git directory overrides never grant access.
 * Separate git-dir pointers without a worktree backlink cannot prove association.
 * This is a filesystem snapshot, not protection against concurrent path replacement:
 * the caller must maintain sandbox containment and serialize metadata writes.
 */
export async function resolveGitMetadata(
  workspaceRoot: string,
  allowedRoots: readonly string[],
): Promise<GitMetadata> {
  const approved = (await Promise.all(allowedRoots.map(async root => {
    try { return await realpath(resolve(expandHomePath(root))); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }))).filter((root): root is string => root !== undefined);
  const authorize = (path: string): string => {
    if (!approved.some((root) => isPathInsideRoot(path, root))) {
      invalid(`path outside owner-approved roots: ${path}`);
    }
    return path;
  };
  const canonical = async (path: string): Promise<string> => authorize(await realpath(path));
  const directory = async (path: string): Promise<string> => {
    const target = await canonical(path);
    if (!(await stat(target)).isDirectory()) invalid(`expected directory: ${path}`);
    return target;
  };
  const pointer = async (path: string): Promise<string> => {
    const target = await canonical(path);
    const before = await lstat(path,{bigint:true});
    if (!before.isFile()) invalid(`expected regular pointer file: ${path}`);
    // NONBLOCK prevents a raced FIFO open from hanging; NOFOLLOW rejects a raced
    // final symlink. fstat binds validation to the descriptor actually read.
    const handle = await open(target, regularFileReadFlags());
    try {
      const info = await handle.stat({bigint:true});
      if (!info.isFile() || info.size > POINTER_LIMIT || info.dev !== before.dev || info.ino !== before.ino) {
        invalid(`non-regular, oversized or changed pointer: ${path}`);
      }
      const bytes = Buffer.alloc(POINTER_LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > POINTER_LIMIT) invalid(`oversized pointer: ${path}`);
      const value = bytes.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
      if (!value || /[\x00-\x1f\x7f\ufffd]/u.test(value)) invalid(`malformed pointer: ${path}`);
      if (!same(await canonical(path), target)) invalid(`changed pointer: ${path}`);
      return value;
    } finally {
      await handle.close();
    }
  };
  const workspace = await directory(resolve(expandHomePath(workspaceRoot)));
  let checkout = workspace;
  let dotGit = join(checkout, ".git");
  let entry;
  for (;;) {
    dotGit = join(checkout, ".git");
    try { entry = await lstat(dotGit); break; }
    catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(checkout);
    if (parent === checkout || !approved.some(root => isPathInsideRoot(parent, root))) return { readRoots: [], writeRoots: [] };
    checkout = parent;
  }
  let gitDir: string;
  let commonDir: string;
  if (entry.isDirectory()) {
    gitDir = commonDir = await directory(dotGit);
    // commondir on an ordinary directory would redirect Git outside this grant.
    try {
      await lstat(join(gitDir, "commondir"));
      invalid("ordinary .git directory unexpectedly contains commondir");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  } else if (entry.isFile()) {
    const value = await pointer(dotGit);
    if (!value.startsWith("gitdir: ") || !value.slice(8)) invalid("malformed .git pointer");
    gitDir = await directory(resolve(checkout, value.slice(8)));
    commonDir = await directory(resolve(gitDir, await pointer(join(gitDir, "commondir"))));
    const registry = await directory(join(commonDir, "worktrees"));
    if (!same(registry, join(commonDir, "worktrees")) || !same(dirname(gitDir), registry)) {
      invalid("linked metadata is not a direct entry in commonDir/worktrees");
    }
    if (!same(await directory(join(registry, basename(gitDir))), gitDir)) invalid("invalid worktree registration");
    const reciprocal = resolve(gitDir, await pointer(join(gitDir, "gitdir")));
    if (!same(await canonical(reciprocal), await canonical(dotGit))) invalid("worktree backlink mismatch");
  } else {
    invalid(".git must be a regular pointer file or directory, not a symlink");
  }

  const head = await pointer(join(gitDir, "HEAD"));
  if (!/^(?:ref: refs\/[^\s\x00-\x1f]+|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(head)) invalid("malformed HEAD");
  await directory(join(commonDir, "objects"));
  // Reftable repositories need not use the traditional loose-reference layout.
  try {
    await directory(join(commonDir, "refs"));
  } catch (error) {
    if (!missing(error)) throw error;
    await directory(join(commonDir, "reftable"));
  }
  if (!same(commonDir, gitDir)) await pointer(join(commonDir, "HEAD"));

  // Do not scan the entire Git object database on each command. Grants cover only
  // these canonical directories: sandbox real-path enforcement must deny access
  // through any descendant symlink/alternates outside the granted roots. Such
  // references never cause discovery to add another directory to the grant.

  const readRoots = [...new Set([gitDir, commonDir])].filter((path) => !isPathInsideRoot(path, workspace));
  return { readRoots, writeRoots: [...readRoots], commonDir,
    ...(checkout !== workspace ? { checkoutRoot: checkout } : {}),
    ...(entry.isFile() && !isPathInsideRoot(dotGit, workspace) ? { readFiles: [await canonical(dotGit)] } : {}) };
}
