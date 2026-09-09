import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import * as z from "zod/v4";
import { StringDecoder } from "node:string_decoder";
import { runSandboxCommand, SandboxCleanupError } from "../sandbox-command.js";
import type { ToolRegistrationContext } from "./types.js";
import { CommandReceipts, type CommandSnapshot } from "../command-receipts.js";
import { resolveGitMetadata } from "../git-metadata.js";
import { canonicalPathIdentity } from "../roots.js";

type CommandInput = { workspaceId: string; requestKey: string; command: string; workingDirectory?: string; timeoutMs?: number };
type Snapshot = CommandSnapshot;
type Session = { workspaceId: string; scope: string; snapshot: Snapshot; abort: AbortController };

export class WebCommands {
  private sessions = new Map<string, Session>();
  private readonly receipts: CommandReceipts;
  private closed = false;
  constructor(private context: ToolRegistrationContext, private run = runSandboxCommand) {
    this.receipts = new CommandReceipts(context.config.stateDir);
    context.processSessions.onShutdown(() => {
      this.closed = true;
      for (const session of this.sessions.values()) session.abort.abort();
    });
  }

  async start(input: CommandInput): Promise<Snapshot> {
    if (this.closed) throw new Error("Command service is shutting down.");
    const workspace = this.context.workspaces.getWorkspace(input.workspaceId);
    const root = await realpath(workspace.root);
    const scope = JSON.stringify([root, workspace.id]);
    const fingerprint = createHash("sha256").update(JSON.stringify([input.command, input.workingDirectory ?? ".", input.timeoutMs ?? 120000])).digest("hex");
    const existing = this.receipts.find(scope, input.requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("REQUEST_CONFLICT: requestKey already belongs to different command inputs.");
      const active = this.sessions.get(existing.session_id);
      return active ? { ...active.snapshot } : this.receipts.snapshot(existing);
    }
    if (this.sessions.size >= 128) throw new Error("Concurrent command limit reached; wait for active commands to finish.");
    const cwd = await realpath(this.context.workspaces.resolveWorkingDirectory(workspace, input.workingDirectory));
    const approvedRoots = [...(this.context.config.allowedRoots ?? [root]),
      ...(workspace.mode === "worktree" && this.context.config.worktreeRoot ? [this.context.config.worktreeRoot] : [])];
    const rest = relative(root, cwd);
    if (isAbsolute(rest) || rest === ".." || rest.startsWith(`..${sep}`)) throw new Error("Working directory escapes the workspace.");
    const gitMetadata = await resolveGitMetadata(root, approvedRoots);
    const gitResources = gitMetadata.commonDir
      ? ['git-metadata:' + createHash('sha256').update(canonicalPathIdentity(gitMetadata.commonDir)).digest('hex')] : [];
    // Recheck after path I/O: duplicate concurrent starts must not both execute.
    if (this.receipts.find(scope, input.requestKey)) return this.start(input);
    if (this.closed || this.sessions.size >= 128) throw new Error("Command service is unavailable; no command was started.");
    const sessionId = randomUUID();
    const session: Session = { workspaceId: workspace.id, scope, abort: new AbortController(),
      snapshot: { sessionId, running: true, output: "", outputTruncated: false } };
    if (!this.receipts.reserve(scope, input.requestKey, fingerprint, session.snapshot)) return this.start(input);
    this.sessions.set(sessionId, session);
    const decoder = new StringDecoder("utf8");
    const completion = this.context.processSessions.mutate(root, async () => {
      const currentMetadata = await resolveGitMetadata(root, approvedRoots);
      if (session.abort.signal.aborted) {
        Object.assign(session.snapshot, { exitCode: null, aborted: true });
        return;
      }
      if (JSON.stringify(currentMetadata) !== JSON.stringify(gitMetadata)) throw new Error("Git metadata changed while acquiring the command claim; inspect the workspace before retrying.");
      const result = await this.run({ workspaceRoot: root, cwd, command: input.command,
        allowedDomains: this.context.config.webExecution?.allowedDomains ?? [],
        environment: this.context.config.webExecution?.environment ?? [],
        readRoots: this.context.config.webExecution?.readRoots ?? [],
        allowLocalBinding: this.context.config.webExecution?.allowLocalBinding ?? false,
        protectedPaths: [this.context.config.stateDir, this.context.config.configDir].filter((path): path is string => Boolean(path)),
        gitMetadata: { readRoots: gitMetadata.readRoots, readFiles: gitMetadata.readFiles ?? [],
          writeRoots: this.context.config.webExecution?.gitMetadataWrite ? gitMetadata.writeRoots : [] },
        timeoutMs: input.timeoutMs ?? 120000, signal: session.abort.signal,
        onOutputTruncated: () => { session.snapshot.outputTruncated = true; },
        maxOutputBytes: 200000, onData: (chunk) => { session.snapshot.output += decoder.write(chunk); } });
      Object.assign(session.snapshot, result);
    }, gitResources).catch((error: unknown) => {
      session.snapshot.error = error instanceof Error ? error.message : String(error);
      if (error instanceof SandboxCleanupError) {
        session.snapshot.running = null;
        session.snapshot.executionState = "unknown";
        this.closed = true;
        this.context.processSessions.recordBackgroundFailure(error);
      }
    }).finally(() => {
      if (session.snapshot.executionState !== "unknown") session.snapshot.running = false;
      try {
        this.receipts.finish(scope, session.snapshot);
        this.sessions.delete(sessionId);
      } catch (error) {
        // A missing durable result must never turn a retry into a second execution.
        session.snapshot.error = "Command finished but its receipt could not be saved. Inspect actual state before retrying.";
        this.closed = true;
        this.context.processSessions.recordBackgroundFailure(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.context.processSessions.trackBackground(completion);
    return { ...session.snapshot };
  }

  status(workspaceId: string, sessionId: string): Snapshot {
    const workspace = this.context.workspaces.getWorkspace(workspaceId);
    const scope = JSON.stringify([realpathSync(workspace.root), workspaceId]);
    const session = this.sessions.get(sessionId);
    if (session && session.scope === scope) return { ...session.snapshot };
    const stored = this.receipts.get(scope, sessionId);
    if (!stored) throw new Error("Unknown command session in this workspace.");
    return this.receipts.snapshot(stored);
  }

  stop(workspaceId: string, sessionId: string): Snapshot {
    this.status(workspaceId, sessionId);
    this.sessions.get(sessionId)?.abort.abort();
    return this.status(workspaceId, sessionId);
  }
}

export function registerWebCommands(context: ToolRegistrationContext): void {
  const commands = new WebCommands(context);
  const scope = { workspaceId: z.string(), sessionId: z.string() };
  const wrap = (operation: () => unknown) => Promise.resolve().then(operation).then(
    (data) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] }),
    (error) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }),
  );
  context.server.registerTool("command_start", {
    description: "Run a general shell command in the owner-configured OS sandbox. Returns a session; use command_status for output and completion. Reuse requestKey to recover the same request without executing it again, including after a restart. An unavailable process is reported as unknown. No interactive terminal. Agent execution has separate permissions.",
    inputSchema: { workspaceId: z.string(), requestKey: z.string().min(1).max(160), command: z.string().min(1).max(64000),
      workingDirectory: z.string().optional(), timeoutMs: z.number().int().min(100).max(600000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: Boolean(context.config.webExecution?.allowedDomains.length || context.config.webExecution?.allowLocalBinding), idempotentHint: false },
  }, (input) => wrap(() => commands.start(input)));
  context.server.registerTool("command_status", {
    description: "Read command output and status without consuming it or sending input. Only the latest 128 completed outputs are retained; older receipts report outputExpired. Interrupted or externally owned execution reports running=null and executionState=unknown; inspect actual state, never infer completion.",
    inputSchema: scope, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (input) => wrap(() => commands.status(input.workspaceId, input.sessionId)));
  context.server.registerTool("command_stop", {
    description: "Stop an owned command and its process tree. Partial filesystem changes may remain. Query command_status until it is no longer running.",
    inputSchema: scope, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, (input) => wrap(() => commands.stop(input.workspaceId, input.sessionId)));
}
