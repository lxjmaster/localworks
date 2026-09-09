import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep, win32 } from "node:path";

export const MAX_FILE_BYTES = 1024 * 1024;
export type FileOperation =
  | { action: "create_directory"; path: string }
  | { action: "read"; path: string }
  | { action: "create"; path: string; content: string }
  | { action: "replace"; path: string; content: string; expectedSha256: string }
  | { action: "edit"; path: string; edits: { oldText: string; newText: string }[]; expectedSha256: string }
  | { action: "move"; path: string; destination: string; expectedSha256: string }
  | { action: "delete"; path: string; expectedSha256: string };

function fail(message: string): never { throw new Error(message); }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function textBytes(content: string): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_FILE_BYTES) fail("Text exceeds 1 MiB.");
  if (content.includes("\0") || bytes.toString("utf8") !== content) fail("Expected valid UTF-8 text without NUL.");
  return bytes;
}

/** Parent directories must already exist. Resolve each ancestor, not just the leaf. */
async function confinedPath(root: string, path: string): Promise<string> {
  if (!path || path.length > 1024 || isAbsolute(path) || win32.isAbsolute(path) || /[\\\0:]/.test(path)) {
    fail("Use a confined relative file path.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("Path must not contain empty, dot or parent components.");
  const base = await realpath(root);
  let parent = base;
  for (const part of parts.slice(0, -1)) {
    parent = await realpath(join(parent, part));
    const rest = relative(base, parent);
    if (isAbsolute(rest) || rest === ".." || rest.startsWith(`..${sep}`)) fail("Path is outside this workspace.");
    if (!(await lstat(parent)).isDirectory()) fail("Path ancestor is not a directory.");
  }
  return join(parent, parts.at(-1)!);
}

async function existingFile(path: string, writable: boolean) {
  if (!(await lstat(path)).isFile()) fail("Expected a regular file; leaf symlinks are not supported.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("Expected a regular file.");
    if (writable && stat.nlink !== 1) fail("Cannot modify a multiply linked file.");
    if (stat.size > MAX_FILE_BYTES) fail("Text exceeds 1 MiB.");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const bytes = buffer.subarray(0, count);
    if (count > MAX_FILE_BYTES) fail("Text exceeds 1 MiB.");
    const content = bytes.toString("utf8");
    textBytes(content);
    if (!Buffer.from(content, "utf8").equals(bytes)) fail("Expected valid UTF-8 text.");
    return { handle, bytes, content, mode: stat.mode, sha256: hash(bytes) };
  } catch (error) { await handle.close(); throw error; }
}

function editedContent(content: string, edits: { oldText: string; newText: string }[]): string {
  if (!edits.length || edits.length > 100) fail("Supply between 1 and 100 edits.");
  let inputBytes = 0;
  const regions = edits.map(({ oldText, newText }) => {
    inputBytes += textBytes(oldText).length + textBytes(newText).length;
    if (inputBytes > MAX_FILE_BYTES) fail("Edit text exceeds 1 MiB.");
    const start = content.indexOf(oldText);
    if (!oldText || start < 0 || content.indexOf(oldText, start + 1) !== -1) fail("Each oldText must match exactly once in the original file.");
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < regions.length; i++) {
    if (regions[i].start < regions[i - 1].end) fail("Edits must not overlap.");
  }
  for (const region of regions.reverse()) content = content.slice(0, region.start) + region.newText + content.slice(region.end);
  return content;
}

/**
 * Call inside readWorkspace (read) or mutate (all writes), including hash validation.
 * Claims coordinate DevSpace only: external writers/ancestor renames can race checks.
 * This is NOT filesystem atomic CAS or a sandbox against hostile local processes.
 * Replace/edit stage in the same directory then rename: complete old or new content,
 * not a crash-durability guarantee. Permission bits are preserved; inode identity,
 * ownership, ACLs and extended attributes are not preserved by staged replacement.
 * Exclusive create can leave partial content on I/O failure.
 * Move uses link + unlink (no destination overwrite); it is not an atomic rename.
 * Cross-device moves fail without copying. Unlink failure leaves both names, reported.
 */
export async function executeFileOperation(root: string, input: FileOperation): Promise<Record<string, unknown>> {
  const path = await confinedPath(root, input.path);
  if (input.action === "create_directory") {
    try { await mkdir(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await lstat(path)).isDirectory()) fail("Destination exists and is not a regular directory; leaf symlinks are rejected.");
      return { status: "exists", path: input.path };
    }
    return { status: "created", path: input.path };
  }
  if (input.action === "create") {
    const bytes = textBytes(input.content);
    const handle = await open(path, "wx", 0o666);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    return { status: "created", path: input.path, bytes: bytes.length, sha256: hash(bytes) };
  }
  const writable = input.action === "edit" || input.action === "replace";
  const file = await existingFile(path, writable);
  try {
    if (input.action === "read") return { path: input.path, content: file.content, bytes: file.bytes.length, sha256: file.sha256 };
    if (!/^[a-f0-9]{64}$/i.test(input.expectedSha256 ?? "")) fail("expectedSha256 must be a SHA-256 hex digest.");
    if (file.sha256 !== input.expectedSha256.toLowerCase()) fail("File version changed; read the file again before retrying.");
    if (input.action === "delete") {
      await unlink(path);
      return { status: "deleted", path: input.path };
    }
    if (input.action === "move") {
      const destination = await confinedPath(root, input.destination);
      // link() fails if any destination entry exists, including a dangling symlink.
      await link(path, destination);
      try { await unlink(path); } catch {
        fail("Move partially completed: destination created, source retained. Inspect both paths before retrying.");
      }
      return { status: "moved", path: input.path, destination: input.destination, sha256: file.sha256 };
    }
    const bytes = textBytes(input.action === "replace" ? input.content : editedContent(file.content, input.edits));
    const temporary = join(dirname(path), `.devspace-${randomUUID()}.tmp`);
    const staged = await open(temporary, "wx", 0o600);
    let moved = false;
    try {
      try { await staged.writeFile(bytes); await staged.chmod(file.mode & 0o777); }
      finally { await staged.close(); }
      await rename(temporary, path);
      moved = true;
    } finally { if (!moved) await unlink(temporary); }
    return { status: "updated", path: input.path, bytes: bytes.length, sha256: hash(bytes) };
  } finally { await file.handle.close(); }
}
