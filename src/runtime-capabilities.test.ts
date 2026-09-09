import assert from "node:assert/strict";
import test from "node:test";
import { regularFileReadFlags,runtimeCapabilities,runtimeCapabilitiesSchema } from "./runtime-capabilities.js";
import {isPathInsideRoot} from "./roots.js";

test("platform reporting does not claim native Windows sandbox or Linux host listening",()=>{
  for(const platform of ["darwin","linux","win32"] as const)assert(runtimeCapabilitiesSchema.safeParse(runtimeCapabilities(platform)).success);
  assert.equal(runtimeCapabilities("win32").commandSandbox.implemented,false);
  assert.equal(runtimeCapabilities("linux").commandSandbox.localListeningConfigurable,false);
  assert.equal(runtimeCapabilities("darwin").commandSandbox.localListeningConfigurable,true);
});
test("missing POSIX safe-open flags are rejected; Windows fallback is explicit",()=>{
  assert.throws(()=>regularFileReadFlags("linux",{O_RDONLY:0}),/capability is missing/);
  assert.throws(()=>regularFileReadFlags("darwin",{O_RDONLY:0,O_NOFOLLOW:0,O_NONBLOCK:4}),/capability is missing/);
  assert.equal(regularFileReadFlags("win32",{O_RDONLY:0}),0);
  assert.equal(regularFileReadFlags("linux",{O_RDONLY:0,O_NOFOLLOW:8,O_NONBLOCK:4}),12);
});
test("WSL UNC containment preserves Linux case and server aliases",()=>{
  const root="\\\\wsl.localhost\\Ubuntu\\home\\user\\Project";
  assert.equal(isPathInsideRoot("\\\\wsl$\\Ubuntu\\home\\user\\Project\\src",root,"win32"),true);
  assert.equal(isPathInsideRoot("\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\private",root,"win32"),false);
  assert.equal(isPathInsideRoot("\\\\wsl.localhost\\Debian\\home\\user\\Project",root,"win32"),false);
  assert.equal(isPathInsideRoot("D:\\project","C:\\project","win32"),false);
  assert.equal(isPathInsideRoot("C:\\PROJECT\\src","C:\\project","win32"),true);
});
