import assert from "node:assert/strict";
import test from "node:test";
import { daemonExecArgv, daemonNodeArgs } from "./local-agent-client.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("source daemon entrypoints get an explicit loader even when caller registered tsx at runtime", async t => {
  const root=await mkdtemp(join(tmpdir(),"localworks-daemon-loader-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,"module.ts"),"export const value: number = 42;\n");
  await writeFile(join(root,"main.ts"),"import {value} from './module.js'; console.log(value);\n");
  const result=spawnSync(process.execPath,daemonNodeArgs(join(root,"main.ts"),[]),{encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"42");
  assert.deepEqual(daemonNodeArgs("/compiled/main.js",[]),["/compiled/main.js"]);
});

test("daemon inherits loaders but never a caller eval, print or input entry mode", () => {
  assert.deepEqual(daemonExecArgv(["--import", "tsx", "--input-type=module", "-e", "spawnAgain()"]),
    ["--import", "tsx"]);
  assert.deepEqual(daemonExecArgv(["--eval=private()", "--print", "secret", "--input-type", "module"]), []);
  assert.deepEqual(daemonExecArgv(["-p42", "--check", "--test", "--inspect=127.0.0.1:9229", "--no-warnings"]),
    ["--no-warnings"]);
});
