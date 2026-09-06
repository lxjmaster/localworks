import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerRuntime } from "./local-agent-codex.js";
import type { ProjectReceipt } from "./codex-projects.js";

test("project partial blocks inference and preserves an already-created thread identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "fake.cjs"), log = join(root, "requests.jsonl");
  await writeFile(source, `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
    if(m.id==null)return;const result=m.method==='thread/start'?{thread:{id:'preserved-thread'}}:{};
    process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
  });`);
  const command = join(root, process.platform === "win32" ? "fake.cmd" : "fake");
  await writeFile(command, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${source}"\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${source}'\n`);
  await chmod(command, 0o700);
  let failBeforeOpen = true;
  const runtime = new CodexAppServerRuntime({ command, env: process.env,
    registerProject: async (roots, threads): Promise<ProjectReceipt> => ({ protocol: "fixture",
      status: failBeforeOpen || threads.length ? "partial" : "persisted_registration", roots, createdDirectories: [],
      uiStatus: "unverified", action: "Re-observe registration before retrying" }),
  });
  try {
    await runtime.initialize();
    const first = await runtime.run({ workspaceRoot: root, prompt: "never invoke a model" });
    assert(first.isErr());
    assert(!JSON.parse(`[${(await readFile(log, "utf8")).trim().split("\n").join(",")}]`).some((m: any) => m.method === "thread/start"));
    failBeforeOpen = false;
    let preserved: string | undefined;
    const second = await runtime.run({ workspaceRoot: root, prompt: "never invoke a model" }, { onSessionId: (id) => { preserved = id; } });
    assert(second.isErr());
    assert.equal(preserved, "preserved-thread");
    if (second.isErr()) assert.equal(second.error.retryable, false);
    assert(!(await readFile(log, "utf8")).includes('"turn/start"'));
  } finally { await runtime.close(); }
});
