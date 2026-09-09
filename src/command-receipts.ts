import { createHash } from "node:crypto";
import { openDatabase, type SqliteDatabase } from "./db/client.js";

export interface CommandSnapshot {
  sessionId: string;
  running: boolean | null;
  output: string;
  outputTruncated: boolean;
  outputExpired?: boolean;
  executionState?: "unknown";
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
}
interface ReceiptRow { session_id: string; fingerprint: string; snapshot: string; output: string | null; completed: number }

/** Output is recycled; compact request tombstones are retained to prevent replay.
 * Store neither the command nor the raw client request key. Never recover a lost
 * process by executing its request again. Each access closes its database handle.
 */
export class CommandReceipts {
  constructor(private stateDir: string) {
    if (!stateDir) throw new Error("Command receipts require a configured state directory.");
  }
  private database<T>(operation: (db: SqliteDatabase) => T): T {
    const handle = openDatabase(this.stateDir);
    try { return operation(handle.sqlite); } finally { handle.close(); }
  }
  private key(value: string): string { return createHash("sha256").update(value).digest("hex"); }

  find(scope: string, requestKey: string): ReceiptRow | undefined {
    return this.database(db => db.prepare("select * from web_command_receipts where scope=? and request_key_hash=?")
      .get(scope, this.key(requestKey)) as ReceiptRow | undefined);
  }
  get(scope: string, sessionId: string): ReceiptRow | undefined {
    return this.database(db => db.prepare("select * from web_command_receipts where scope=? and session_id=?")
      .get(scope, sessionId) as ReceiptRow | undefined);
  }
  reserve(scope: string, requestKey: string, fingerprint: string, snapshot: CommandSnapshot): boolean {
    return this.database(db => db.prepare(`insert or ignore into web_command_receipts
      (session_id,scope,request_key_hash,fingerprint,snapshot) values (?,?,?,?,?)`)
      .run(snapshot.sessionId, scope, this.key(requestKey), fingerprint, JSON.stringify({ ...snapshot, output: "" })).changes === 1);
  }
  finish(scope: string, snapshot: CommandSnapshot): void {
    this.database(db => db.transaction(() => {
      const saved = db.prepare("update web_command_receipts set snapshot=?,output=?,completed=1,completed_at=? where scope=? and session_id=?")
        .run(JSON.stringify({ ...snapshot, output: "" }), snapshot.output, Date.now(), scope, snapshot.sessionId);
      if (saved.changes !== 1) throw new Error("Command receipt disappeared; refusing to report durable completion.");
      db.prepare(`update web_command_receipts set output=null where output is not null and completed=1
        and sequence not in (select sequence from web_command_receipts where completed=1 order by completed_at desc,sequence desc limit 128)`).run();
    }).immediate());
  }
  snapshot(row: ReceiptRow): CommandSnapshot {
    const snapshot = JSON.parse(row.snapshot) as CommandSnapshot;
    if (!row.completed) return { ...snapshot, running: null, executionState: "unknown", output: "",
      error: "Execution belongs to an unavailable process. Inspect actual workspace state before submitting new work; this request will not be replayed." };
    return { ...snapshot, output: row.output ?? "", ...(row.output === null ? { outputExpired: true } : {}) };
  }
}
