import { constants } from "node:fs";
import * as z from "zod/v4";

export const runtimeCapabilitiesSchema=z.object({
  platform:z.string(),
  commandSandbox:z.object({implemented:z.boolean(),shell:z.string().nullable(),prerequisites:z.string(),localListeningConfigurable:z.boolean()}),
  fileOperations:z.object({pathFormat:z.literal("workspace-relative paths with / separators"),containment:z.string(),nativeValidation:z.string()}),
});

export function runtimeCapabilities(platform:NodeJS.Platform=process.platform){
  const implemented=platform==="darwin"||platform==="linux";
  return {platform,commandSandbox:{implemented,shell:implemented?"/bin/bash":null,
    prerequisites:platform==="win32"?"Native Windows command sandbox is not implemented. Use a Linux Node runtime in WSL2 with sandbox dependencies, or an explicitly chosen legacy mode with its existing authority.":platform==="linux"?"Requires bubblewrap, socat, ripgrep, timezone data and permitted user namespaces. Actual readiness is checked on execution.":"Requires the installed OS sandbox runtime. Actual readiness is checked on execution.",
    localListeningConfigurable:platform==="darwin"},
    fileOperations:{pathFormat:"workspace-relative paths with / separators" as const,
      containment:"Canonical path and file identity checks; cooperative coordination, not a sandbox against hostile concurrent filesystem changes.",
      nativeValidation:platform==="win32"?"Windows behavior must pass native CI; WSL UNC paths retain Linux path case. Native reparse-point race isolation is not claimed.":"POSIX regular-file checks and no-follow opens are required."},
  };
}

/** Windows has no equivalent O_NOFOLLOW/O_NONBLOCK constants in Node. Its
 * callers must bind lstat identity to fstat before reading; this is explicit
 * cooperative file access, not a native Windows OS sandbox. */
export function regularFileReadFlags(platform:NodeJS.Platform=process.platform, flags:Record<string,number|undefined>=constants):number{
  let result=flags.O_RDONLY??0;
  for(const name of ["O_NOFOLLOW","O_NONBLOCK"]){
    const value=flags[name];
    if(typeof value!=="number"||!Number.isInteger(value)||value<=0){
      if(platform!=="win32")throw new Error(`Required regular-file open capability is missing: ${name}`);
    }else result|=value;
  }
  return result;
}
