import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProcessSessionManager } from "./process-sessions.js";
import { WebCommands } from "./tool-surfaces/web-commands.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import type { SandboxCommandResult } from "./sandbox-command.js";

test("web commands validate metadata grants and serialize linked/ordinary checkouts", async t => {
  const root=await mkdtemp(join(tmpdir(),"localworks-web-git-"));
  const main=join(root,"main"), linked=join(root,"linked"), state=join(root,"state");
  await mkdir(main);
  const git=(...args:string[])=>promisify(execFile)("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false",...args],{
    cwd:main,env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"},timeout:15000,
  });
  await git("init");await git("commit","--allow-empty","-m","fixture");await git("worktree","add","-b","linked",linked);
  const processes=new ProcessSessionManager({stateDir:state});
  t.after(async()=>{processes.shutdown();await processes.waitForBackground();await rm(root,{recursive:true,force:true});});
  let invocations=0;
  let finish!:()=>void;
  const result:SandboxCommandResult={exitCode:0,signal:null,output:"ok",outputTruncated:false,timedOut:false,aborted:false};
  const context={config:{stateDir:state,allowedRoots:[main],worktreeRoot:linked,webExecution:{gitMetadataWrite:true}},processSessions:processes,
    workspaces:{getWorkspace:(id:string)=>({id,root:id==="main"?main:linked,mode:id==="linked"?"worktree":"checkout"}),resolveWorkingDirectory:(workspace:{root:string})=>workspace.root},
  } as unknown as ToolRegistrationContext;
  const commands=new WebCommands(context,async options=>{
    invocations++;
    if(invocations===1)return new Promise(resolve=>{finish=()=>resolve(result);options.signal?.addEventListener("abort",finish,{once:true});});
    assert.equal(options.gitMetadata?.readRoots.length,2);
    assert.deepEqual(options.gitMetadata?.writeRoots,options.gitMetadata?.readRoots);
    return result;
  });
  const until=async(predicate:()=>boolean)=>{for(let i=0;i<1000&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,2));assert(predicate());};
  await assert.rejects(commands.start({workspaceId:"unmanaged",requestKey:"outside",command:"fixture"}), /outside owner-approved/);
  await commands.start({workspaceId:"main",requestKey:"owner",command:"fixture"});
  await until(()=>invocations===1);
  const blocked=await commands.start({workspaceId:"linked",requestKey:"blocked",command:"fixture"});
  await until(()=>commands.status("linked",blocked.sessionId).running===false);
  assert.match(commands.status("linked",blocked.sessionId).error!,/Wait|occupied|conflict/i);
  assert.equal(invocations,1);
  finish();await processes.waitForBackground();
  const accepted=await commands.start({workspaceId:"linked",requestKey:"after-release",command:"fixture"});
  await processes.waitForBackground();
  assert.equal(commands.status("linked",accepted.sessionId).exitCode,0);
  assert.equal(invocations,2);
});
