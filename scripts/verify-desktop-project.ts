// Pure control verification. Creates one empty thread in an explicitly authorized
// verification root; never sends a prompt or invokes turn/start.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { connectDesktopProjects, desktopHome, prepareProjectRoots, projectPathKey, registerProject } from "../src/codex-projects.js";
import { readDesktopCatalog } from "../src/codex-desktop-catalog.js";
import { ensureSavedDesktopProject } from "../src/codex-desktop-open.js";

const root = process.argv[2];
const existingThreadId = process.argv[3];
if (existingThreadId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(existingThreadId)) throw new Error("Invalid verification thread ID.");
if (!root || !/desktop-auto-verification-[0-9]{8}$/.test(root)) throw new Error("Provide the explicit verification directory.");
const config = loadConfig();
const prepared = await prepareProjectRoots([root], config.allowedRoots, false);
const client = await connectDesktopProjects();
try {
  if (projectPathKey(client.home) !== projectPathKey(desktopHome())) throw new Error("Provider home mismatch.");
  const saved = await ensureSavedDesktopProject(prepared.roots, desktopHome(), projectPathKey);
  const started = await client.request(existingThreadId ? "thread/read" : "thread/start", existingThreadId
    ? { threadId: existingThreadId, includeTurns: true }
    : { cwd: prepared.roots[0], approvalPolicy: "never", sandbox: "read-only", ephemeral: false }) as {
    thread?: { id?: string; cwd?: string; turns?: unknown[] };
  };
  const thread = started.thread;
  if (!thread?.id || !thread.cwd || projectPathKey(thread.cwd) !== projectPathKey(prepared.roots[0]!) || (thread.turns?.length ?? 0) !== 0) throw new Error("Empty thread identity could not be verified.");
  // Mirror the managed creation flow, which names a new thread before binding.
  await client.request("thread/name/set", { threadId: thread.id, name: "[DevSpace verification] empty project-bound thread, no inference" });
  const registration = await registerProject(client, { roots: prepared.roots, expectedHome: desktopHome(), threadIds: [thread.id], desktopCatalog: saved.catalog });
  const catalog = await readDesktopCatalog(prepared.roots, desktopHome(), projectPathKey);
  const value = { verification: "empty_thread_project_assignment", createdThreadId: thread.id, requestedInference: false,
    registration, clientAssignmentVerified: catalog.threadIds.includes(thread.id), clientProjectId: catalog.clientProjectId,
    serverProjectId: catalog.projectId };
  const out = join(config.stateDir, "project-registration");
  await mkdir(out, { recursive: true, mode: 0o700 });
  const receiptPath = join(out, `${randomUUID()}.json`);
  await writeFile(receiptPath, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...value, receiptPath }));
  if (registration.status !== "persisted_registration") process.exitCode = 1;
} finally { await client.close(); }
