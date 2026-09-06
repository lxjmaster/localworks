import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import * as z from "zod/v4";
import { readContextFile } from "../workspace-context.js";
import type { ToolRegistrationContext } from "./types.js";
import { trackedWork } from "./work-task.js";

/** Deterministic host-side context preparation. No agent client, model, or shell. */
export function registerWorkspaceContextTool({ server, config, workspaces, processSessions }: ToolRegistrationContext): void {
  server.registerTool("workspace_context", {
    title: "Inspect workspace directly without Codex",
    description: "Host-first local inspection: list one directory, capture selected source ranges and full-file hashes, or search a literal in explicitly selected files. No model invocation, automatic repository survey or recursive traversal. Prefer this and read for context gathering before deciding whether a Codex worker is needed. Follow applicable project instructions first. Captures are versioned evidence, not a shared model memory or immutable checkout.",
    inputSchema: {
      workspaceId: z.string(),
      workRunId: z.string().optional(),
      action: z.enum(["list", "capture", "search"]),
      directory: z.string().optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
      files: z.array(z.object({ path: z.string().min(1).max(1024),
        startLine: z.number().int().min(1).max(1_000_000).optional(),
        maxLines: z.number().int().min(1).max(250).optional(),
      }).strict()).max(24).optional(),
      query: z.string().min(1).max(256).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const workspace = workspaces.getWorkspace(input.workspaceId);
    const capture = () => processSessions.readWorkspace(workspace.root, async () => {
      if (input.action === "list") {
        const base = await realpath(workspace.root);
        const path = workspaces.resolvePath(workspace, input.directory ?? ".");
        const resolved = await realpath(path);
        const rest = relative(base, resolved);
        if (isAbsolute(rest) || rest === ".." || rest.startsWith(`..${sep}`)) throw new Error("Directory is outside this workspace.");
        const entries = (await readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        const offset = input.offset ?? 0;
        const page = entries.slice(offset, offset + 100).map((entry) => ({ name: entry.name,
          kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" }));
        return { providerInvoked: false, entries: page, total: entries.length,
          nextOffset: offset + page.length < entries.length ? offset + page.length : null };
      }
      if (!input.files?.length || (input.action === "search" && !input.query)) throw new Error("Select explicit files; search also needs a literal query.");
      let bytesRead = 0;
      let lineBudget = 500;
      const entries = input.files.map((selection) => {
        workspaces.resolvePath(workspace, selection.path);
        const file = readContextFile(workspace.root, selection.path);
        bytesRead += file.bytes.length;
        if (bytesRead > 4 * 1024 * 1024) throw new Error("Context capture exceeds 4 MiB; narrow the selected files.");
        const lines = file.bytes.toString("utf8").split(/\r?\n/);
        const first = selection.startLine ?? 1;
        const candidates = input.action === "search"
          ? lines.map((text, index) => ({ line: index + 1, text })).filter((line) => line.line >= first && line.text.includes(input.query!))
          : lines.slice(first - 1).map((text, index) => ({ line: first + index, text }));
        const selected = candidates.slice(0, Math.min(lineBudget, selection.maxLines ?? 80)).map((line) => ({
          ...line, text: line.text.slice(0, 2000), ...(line.text.length > 2000 ? { lineTruncated: true } : {}),
        }));
        lineBudget -= selected.length;
        return { path: file.path, sha256: file.sha256, bytes: file.bytes.length, totalLines: lines.length,
          lines: selected, truncated: selected.length < candidates.length,
          nextLine: selected.length < candidates.length ? (selected.at(-1)?.line ?? first - 1) + 1 : null };
      });
      const refs = entries.map(({ path, sha256 }) => ({ path, sha256 }));
      return { providerInvoked: false, contextId: createHash("sha256").update(JSON.stringify(refs)).digest("hex"),
        refs, entries, bytesRead,
        consistency: "Selected file versions under a cooperative read claim. External edits require revalidation. This is not a whole-repository snapshot.",
        delegation: "Use the host to summarize relevant facts; pass summary and refs as agent_task.context only when a worker is actually needed." };
    });
    const value = input.workRunId ? await trackedWork(config.stateDir, input.workRunId, { root: workspace.root, workspaceId: workspace.id }, "workspace_context", capture) : await capture();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  });
}
