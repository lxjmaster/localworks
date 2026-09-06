import { randomUUID } from "node:crypto";
import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { canonicalPathIdentity } from "./roots.js";

export type SourceAccess = "read" | "write";

export interface ExecutionClaimInput {
  workspaceRoot: string;
  kind: "agent" | "command" | "mutation" | "read";
  /** Only the trusted adapter/host reader assigns read, never inferred from a prompt. */
  access?: SourceAccess;
  agentId?: string;
  threadKey?: string;
  resources?: readonly string[];
  maxConcurrentAgents?: number;
  maxConcurrentReaders?: number;
}

interface ClaimRow {
  id: string; owner_id: string; owner_pid: number;
  kind: ExecutionClaimInput["kind"];
  checkout_root: string; agent_id: string | null; thread_key: string | null;
  access_mode: SourceAccess; resources: string; acquired_at?: string;
}
interface WaiterRow extends ClaimRow { sequence: number; expires_at_ms: number }

export interface ExecutionClaim {
  readonly id: string;
  bindThread(threadKey: string): void;
  release(): void;
}
export interface ExecutionTicket {
  readonly id: string;
  tryAcquire(): ExecutionClaim | undefined;
  cancel(): void;
}

export class ExecutionConflictError extends Error {
  readonly code = "EXECUTION_CONFLICT";
  constructor(readonly claimId: string, readonly agentId: string | undefined, reason: string) {
    super(`${reason}. Wait or observe the owner; reuse its session only for related work. Claim: ${claimId}.`);
    this.name = "ExecutionConflictError";
  }
}

/** Aliases and subdirectories identify one real checkout; linked worktrees remain distinct. */
export function canonicalExecutionRoot(path: string): string {
  const real = realpathSync(resolve(path));
  let cursor = real;
  for (;;) {
    if (existsSync(resolve(cursor, ".git"))) return canonicalPathIdentity(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return canonicalPathIdentity(real);
    cursor = parent;
  }
}
function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
function resourceOverlap(a: ClaimRow, b: ClaimRow): boolean {
  const resources = JSON.parse(a.resources) as string[];
  return (JSON.parse(b.resources) as string[]).some((key) => resources.includes(key));
}
function exclusiveConflict(a: ClaimRow, b: ClaimRow): boolean {
  return Boolean((a.agent_id && a.agent_id === b.agent_id) ||
    (a.thread_key && a.thread_key === b.thread_key) || resourceOverlap(a, b) ||
    (overlaps(a.checkout_root, b.checkout_root) && (a.access_mode !== "read" || b.access_mode !== "read")));
}

/** Cooperative cross-process admission, not an OS sandbox. Active claims are never stolen. */
export class ExecutionCoordinator {
  private readonly database: DatabaseHandle;
  private readonly ownerId = randomUUID();
  private closed = false;

  constructor(stateDir: string) { this.database = openDatabase(stateDir); }

  private row(input: ExecutionClaimInput): ClaimRow {
    if (this.closed) throw new Error("Execution coordinator is closed.");
    const resources = [...new Set(input.resources ?? [])].sort();
    if (resources.length > 16 || resources.some((key) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key))) {
      throw new Error("Use at most 16 explicit, bounded resource keys.");
    }
    for (const value of [input.maxConcurrentAgents ?? 2, input.maxConcurrentReaders ?? 2]) {
      if (!Number.isInteger(value) || value < 1 || value > 16) throw new Error("Concurrency must be between 1 and 16.");
    }
    if (input.access !== undefined && input.access !== "read" && input.access !== "write") throw new Error("Invalid source access.");
    return { id: `claim_${randomUUID().replaceAll("-", "")}`, owner_id: this.ownerId, owner_pid: process.pid,
      kind: input.kind, checkout_root: canonicalExecutionRoot(input.workspaceRoot), agent_id: input.agentId ?? null,
      thread_key: input.threadKey ?? null, access_mode: input.access ?? "write", resources: JSON.stringify(resources) };
  }

  private blocker(candidate: ClaimRow, input: ExecutionClaimInput, sequence = Number.MAX_SAFE_INTEGER): ClaimRow | undefined {
    // Expired WAITERS never started work. Active claims have no timeout-steal path.
    this.database.sqlite.prepare("delete from execution_waiters where expires_at_ms <= ?").run(Date.now());
    const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
    const conflict = active.find((row) => exclusiveConflict(candidate, row));
    if (conflict) return conflict;
    const prior = this.database.sqlite.prepare("select * from execution_waiters where sequence < ? order by sequence")
      .all(sequence) as WaiterRow[];
    // An earlier writer blocks later readers; neither reader-to-writer upgrades nor reader barging.
    const waiting = prior.find((row) => exclusiveConflict(candidate, row));
    if (waiting) return waiting;
    if (candidate.kind === "agent") {
      const agents = active.filter((row) => row.kind === "agent");
      if (agents.length >= (input.maxConcurrentAgents ?? 2)) return agents[0];
      const readers = agents.filter((row) => row.access_mode === "read" && overlaps(row.checkout_root, candidate.checkout_root));
      if (candidate.access_mode === "read" && readers.length >= (input.maxConcurrentReaders ?? 2)) return readers[0];
    }
    return undefined;
  }

  private insert(row: ClaimRow): ExecutionClaim {
    this.database.sqlite.prepare(`insert into execution_claims
      (id, owner_id, owner_pid, kind, checkout_root, agent_id, resources, acquired_at, access_mode, thread_key)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.owner_id, row.owner_pid, row.kind, row.checkout_root, row.agent_id, row.resources,
        new Date().toISOString(), row.access_mode, row.thread_key);
    let released = false;
    return {
      id: row.id,
      bindThread: (threadKey) => {
        if (released || this.closed) throw new Error("Execution claim is no longer active.");
        this.database.sqlite.transaction(() => {
          const other = this.database.sqlite.prepare("select * from execution_claims where thread_key = ? and id != ?")
            .get(threadKey, row.id) as ClaimRow | undefined;
          if (other) throw new ExecutionConflictError(other.id, other.agent_id ?? undefined, "Provider thread already active");
          this.database.sqlite.prepare("update execution_claims set thread_key = ? where id = ? and owner_id = ?")
            .run(threadKey, row.id, this.ownerId);
        }).immediate();
      },
      release: () => {
        if (released || this.closed) return;
        this.database.sqlite.prepare("delete from execution_claims where id = ? and owner_id = ?").run(row.id, this.ownerId);
        released = true;
      },
    };
  }

  acquire(input: ExecutionClaimInput): ExecutionClaim {
    const candidate = this.row(input);
    return this.database.sqlite.transaction(() => {
      const blocker = this.blocker(candidate, input);
      if (blocker) throw new ExecutionConflictError(blocker.id, blocker.agent_id ?? undefined, "Source, thread, resource or concurrency limit is occupied");
      return this.insert(candidate);
    }).immediate();
  }

  enqueue(input: ExecutionClaimInput, waitMs: number): ExecutionTicket {
    const candidate = this.row(input);
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 900_000) throw new Error("Queue timeout must be 1–900000 ms.");
    this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare("delete from execution_waiters where expires_at_ms <= ?").run(Date.now());
      const count = (this.database.sqlite.prepare("select count(*) as n from execution_waiters").get() as { n: number }).n;
      if (count >= 64) throw new ExecutionConflictError("queue", undefined, "Local queue capacity reached; no provider invoked");
      this.database.sqlite.prepare(`insert into execution_waiters
        (id, owner_id, owner_pid, kind, checkout_root, agent_id, thread_key, access_mode, resources, expires_at_ms)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.id, this.ownerId, process.pid, candidate.kind, candidate.checkout_root, candidate.agent_id,
          candidate.thread_key, candidate.access_mode, candidate.resources, Date.now() + waitMs);
    }).immediate();
    return {
      id: candidate.id,
      tryAcquire: () => this.database.sqlite.transaction(() => {
        const ticket = this.database.sqlite.prepare("select * from execution_waiters where id = ? and owner_id = ?")
          .get(candidate.id, this.ownerId) as WaiterRow | undefined;
        if (!ticket || ticket.expires_at_ms <= Date.now()) throw new Error("Execution wait expired or was cancelled; no provider invoked.");
        if (this.blocker(candidate, input, ticket.sequence)) return undefined;
        this.database.sqlite.prepare("delete from execution_waiters where id = ? and owner_id = ?").run(candidate.id, this.ownerId);
        return this.insert(candidate);
      }).immediate(),
      cancel: () => {
        if (!this.closed) this.database.sqlite.prepare("delete from execution_waiters where id = ? and owner_id = ?").run(candidate.id, this.ownerId);
      },
    };
  }

  async run<T>(input: ExecutionClaimInput, action: () => Promise<T>): Promise<T> {
    const claim = this.acquire(input);
    try { return await action(); } finally { claim.release(); }
  }

  inspect(workspaceRoot: string) {
    const root = canonicalExecutionRoot(workspaceRoot);
    const active = this.database.sqlite.prepare("select * from execution_claims").all() as ClaimRow[];
    const waiting = this.database.sqlite.prepare("select * from execution_waiters where expires_at_ms > ? order by sequence").all(Date.now()) as WaiterRow[];
    return [...active.map((row) => ({ ...row, state: "active" })), ...waiting.map((row) => ({ ...row, state: "queued" }))]
      .filter((row) => overlaps(row.checkout_root, root))
      .map((row) => ({ id: row.id, kind: row.kind, access: row.access_mode, state: row.state,
        agentId: row.agent_id ?? undefined, ownerPid: row.owner_pid, resources: JSON.parse(row.resources) as string[],
        acquiredAt: row.acquired_at,
        recovery: "Active claims require reconciliation after an interrupted owner; never replay or steal them by timeout." }));
  }

  close(): void {
    if (this.closed) return;
    // A waiting intent can safely disappear; an active child may still be running.
    this.database.sqlite.prepare("delete from execution_waiters where owner_id = ?").run(this.ownerId);
    this.closed = true;
    this.database.close();
  }
}
