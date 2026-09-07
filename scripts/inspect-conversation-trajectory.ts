/** Read-only metadata for one observed parent run's exact persisted conversation. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const anchor = process.argv[2];
if (!/^run_[a-f0-9]{32}$/.test(anchor ?? "")) throw new Error("Provide an explicitly observed parent workRunId.");
const config = loadConfig();
const db = new Database(join(config.stateDir, "devspace.sqlite"), { readonly: true, fileMustExist: true });
let result: Record<string, unknown>;
try {
  result = db.transaction(() => {
    const row = db.prepare("select origin from console_work_runs where id=?").get(anchor) as { origin: string } | undefined;
    if (!row) throw new Error("Observed parent run is unavailable.");
    const origin = JSON.parse(row.origin) as { conversationHash?: string; entryPoint?: string };
    if (!/^[a-f0-9]{20,64}$/.test(origin.conversationHash ?? "") || origin.entryPoint !== "chatgpt_mcp") throw new Error("Exact parent conversation origin unavailable; do not substitute a child run or whole project.");
    const runs = db.prepare("select id,status,acceptance,created_at,finished_at from console_work_runs where json_extract(origin,'$.conversationHash')=? and json_extract(origin,'$.entryPoint')=? order by created_at,id")
      .all(origin.conversationHash, origin.entryPoint) as Array<{ id: string; status: string; acceptance: string; created_at: string; finished_at: string | null }>;
    const grouped: Record<string, { count: number; failed: number; totalRecordedDurationMs: number }> = {};
    const longest: Array<{ runId: string; operationId: string; kind: string; status: string; durationMs: number }> = [];
    let operationCount = 0, executionCount = 0, unavailableExecutions = 0, knownDeltaTokens = 0;
    const executionStates: Record<string, number> = {};
    for (const run of runs) {
      const operations = db.prepare("select id,kind,status,created_at,finished_at from console_operations where run_id=? order by rowid").iterate(run.id) as Iterable<{id:string;kind:string;status:string;created_at:string;finished_at:string|null}>;
      for (const operation of operations) {
        operationCount++;
        const kind = /^[a-zA-Z0-9_.:-]{1,64}$/.test(operation.kind) ? operation.kind : "other";
        const group = grouped[kind] ??= { count: 0, failed: 0, totalRecordedDurationMs: 0 };
        group.count++; if (operation.status === "failed") group.failed++;
        if (operation.finished_at) {
          const durationMs = Math.max(0, Date.parse(operation.finished_at) - Date.parse(operation.created_at));
          if (Number.isFinite(durationMs)) {
            group.totalRecordedDurationMs += durationMs;
            longest.push({ runId:run.id, operationId:operation.id, kind, status:operation.status, durationMs });
            longest.sort((a,b) => b.durationMs-a.durationMs); longest.length=Math.min(longest.length,8);
          }
        }
      }
      const executions = db.prepare("select status,usage_quality,delta,requested,provider_turn_id,provider_finished,boundary_reason from console_executions where run_id=? and provider='codex'").iterate(run.id) as Iterable<{status:string;usage_quality:string;delta:string|null;requested:number;provider_turn_id:string|null;provider_finished:number;boundary_reason:string}>;
      for (const execution of executions) {
        executionCount++; executionStates[execution.status]=(executionStates[execution.status] ?? 0)+1;
        const definitelyUnused = execution.usage_quality==='not_used' && !execution.requested && !execution.provider_turn_id && !execution.provider_finished && execution.status!=='completed' && execution.boundary_reason!=='provider_dispatch_unconfirmed';
        if (definitelyUnused) continue;
        if (!execution.delta || execution.usage_quality!=='complete') unavailableExecutions++;
        if (execution.delta) {
          const delta=JSON.parse(execution.delta) as { totalTokens?: number };
          if (Number.isSafeInteger(delta.totalTokens) && delta.totalTokens!>=0) knownDeltaTokens+=delta.totalTokens!;
        }
      }
    }
    return { schema:"devspace.parent-trajectory-metadata",version:1,collectedAt:new Date().toISOString(),anchorWorkRunId:anchor,
      origin:{entryPoint:origin.entryPoint,conversationHash:origin.conversationHash},runCount:runs.length,operationCount,executionCount,
      runStates:runs.reduce<Record<string,number>>((out,run)=>{const key=`${run.status}/${run.acceptance}`;out[key]=(out[key]??0)+1;return out;},{}),
      operationTypes:grouped,longestRecordedOperations:longest,executionStates,
      usage:{completeness:unavailableExecutions?'partial':'complete',unavailableExecutions,knownManagedDeltaTokens:knownDeltaTokens,notAccountBilling:true,notHostTokens:true},
      scopeNotes:["exact observed parent conversation only; worker-created child conversations are not implicitly linked","recorded operation durations may overlap and are not total wall-clock time","discovery/observe calls without a ledger operation are not counted","no raw prompts, responses, thoughts, environment or credential fields read"],
      providerInvoked:false,ledgerModified:false };
  })();
} finally { db.close(); }
const directory=join(process.cwd(),"releases","trajectory-audit-20260907");
mkdirSync(directory,{recursive:true,mode:0o700});
const raw=JSON.stringify(result,null,2),path=join(directory,"parent-conversation-metadata.json");
writeFileSync(path,raw,{mode:0o600});
console.log(JSON.stringify({...result,receiptPath:path,sha256:createHash('sha256').update(raw).digest('hex')}));
