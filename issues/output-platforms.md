# Output contracts and platform portability

Workline: localworks-output-platforms (owner: main agent)

Scope: address remaining Git execution-environment ambiguity, add meaningful MCP
output schemas, and analyze OS portability including Windows. Do not claim native
Windows sandbox support or suppress diagnostics. Preserve existing text responses,
credentials and other machine endpoints.

- [✅] Parallelism: file/context schema worker owns those registrations/tests;
  platform reviewer is read-only; main owns command/control schemas and integration.
- [✅] Verify SDK/official outputSchema + structuredContent behavior, including errors.
- [✅] Add file/context output contracts and validate actual MCP results; preserve
  legacy text separately from additive structured status/path fields.
- [✅] Add command/control output contracts and platform capability reporting.
- [✅] Add logical program/literal args execution and prepared-shell guidance;
  raw absolute shims/login shells retain real diagnostics, no stderr filtering.
- [✅] Record Windows/Linux/macOS boundaries; fix UNC case containment, explicit
  safe-open flag handling, exact file identities and close-before-rename behavior.
- [✅] Investigate Actions logs: Ubuntu passed; Windows failed on receipt path
  resolution, open-handle rename/destination handling and POSIX policy tests;
  macOS failed on console canonical root aliases. Fixes implemented; local full
  suite passed (283 pass, zero failures) and focused post-review checks passed.
- [ ] Verify the integrated commit on all three GitHub Actions platforms.
- [ ] Review, verify, build, commit/push and deploy compiled release; preserve rollback.
- [ ] Verify public tools/output schemas, actual worktree read checks and cleanup.
