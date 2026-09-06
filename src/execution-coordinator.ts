import { randomUUID } from "node:crypto";
import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface ExecutionClaimInput {
  workspaceRoot: string;
  kind: "agent" | "command" | "mutation";
  agentId?: string;
  resources?: readonly string[];
  maxConcurrentAgents?: number;
}

interface ClaimRow {
  id: string;
  owner_id: string;
  owner_pid: number;
  kind: ExecutionClaimInput["kind"];
  checkout_root: string;
  agent_id: string | null;
  resources: string;
  acquired_at: string;
}

export interface ExecutionClaim {
  readonly id: string;
  release(): void;
}

export class ExecutionConflictError extends Error {
  readonly code = "EXECUTION_CONFLICT";
  constructor(readonly claimId: string, readonly agentId: string | undefined, reason: string) {
    super(`${reason}. ${agentId ? `Continue or observe existing agent ${agentId}; do not start a duplicate worker.` : "Wait for the owning operation to finish."} Claim: ${claimId}.`);
    this.name = "ExecutionConflictError";
  }
}

/** Resolve aliases and subdirectories to one real checkout, without running a shell. */
export function canonicalExecutionRoot(path: string): string {
  const real = realpathSync(resolve(path));
  let cursor = real;
  for (;;) {
    // A linked worktree has a .git file, and is deliberately a distinct checkout.
    if (existsSync(resolve(cursor, ".git"))) return normalize(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return normalize(real);
    cursor = parent;
  }
}

function normalize(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/**
 * Cooperative cross-process admission, shared by the MCP host and agent daemon.
 * It is not a filesystem sandbox. Claims are never stolen by timeout or PID alone:
 * a dead parent can leave a live child or an external side effect needing reconciliation.
 */
export class ExecutionCoordinator {
  private readonly database: DatabaseHandle;
  private readonly ownerId = randomUUID();
  private closed = false;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  acquire(input: ExecutionClaimInput): ExecutionClaim {
    if (this.closed) throw new Error("Execution coordinator is closed.");
    const root = canonicalExecutionRoot(input.workspaceRoot);
    const resources = [...new Set(input.resources ?? [])].sort();
    if (resources.length > 16 || resources.some((key) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key))) {
      throw new Error("Use at most 16 explicit resource keys with letters, digits, '.', '_', ':', '/', or '-'.");
    }
    const maximum = input.maxConcurrentAgents ?? 1;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) throw new Error("Agent concurrency must be between 1 and 16.");
    const id = `claim_${randomUUID().replaceAll("-", "")}`;
    this.database.sqlite.transaction(() => {
      const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
      const overlap = active.find((row) =>
        contains(row.checkout_root, root) || contains(root, row.checkout_root) ||
        (JSON.parse(row.resources) as string[]).some((key) => resources.includes(key)),
      );
      if (overlap) throw new ExecutionConflictError(overlap.id, overlap.agent_id ?? undefined, "Checkout or declared build resource is already in use");
      const agents = active.filter((row) => row.kind === "agent");
      if (input.kind === "agent" && agents.length >= maximum) {
        const blocker = agents[0]!;
        throw new ExecutionConflictError(blocker.id, blocker.agent_id ?? undefined, "Configured agent concurrency is exhausted before provider invocation");
      }
      this.database.sqlite.prepare(`insert into execution_claims
        (id, owner_id, owner_pid, kind, checkout_root, agent_id, resources, acquired_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, this.ownerId, process.pid, input.kind, root, input.agentId ?? null, JSON.stringify(resources), new Date().toISOString());
    }).immediate();
    let released = false;
    return {
      id,
      release: () => {
        if (released || this.closed) return;
        this.database.sqlite.prepare("delete from execution_claims where id = ? and owner_id = ?").run(id, this.ownerId);
        released = true;
      },
    };
  }

  async run<T>(input: ExecutionClaimInput, action: () => Promise<T>): Promise<T> {
    const claim = this.acquire(input);
    try { return await action(); } finally { claim.release(); }
  }

  /** Only expose claims intersecting an already-authorized workspace. */
  inspect(workspaceRoot: string) {
    const root = canonicalExecutionRoot(workspaceRoot);
    return (this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[])
      .filter((row) => contains(row.checkout_root, root) || contains(root, row.checkout_root))
      .map((row) => ({ id: row.id, kind: row.kind, agentId: row.agent_id ?? undefined,
        ownerPid: row.owner_pid, resources: JSON.parse(row.resources) as string[], acquiredAt: row.acquired_at,
        recovery: "Claims from an interrupted owner require reconciliation; they are not automatically replayed or stolen." }));
  }

  close(): void {
    if (this.closed) return;
    // Owners explicitly release after their operation has actually stopped.
    // Closing a database connection must not falsely declare a live operation finished.
    this.closed = true;
    this.database.close();
  }
}
