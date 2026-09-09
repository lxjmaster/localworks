# LocalWorks MCP execution improvements

Workline: localworks-mcp-boundaries (owner: main agent)

Outcome: retain general file, command and agent capabilities while exposing clear
contracts and enforceable boundaries. No claim of resolving an OpenAI-side block
without an actual ChatGPT test. Original taskquay checkout and service stay intact.

- [✅] Review official developer-mode, tool design and security documentation.
- [✅] Parallelism: file capability worker owns new file tools; execution worker
  owns command runner; main owns integration, configuration and documentation.
  Independent final review follows integration. No conflicting writes.
- [✅] Implement version-checked confined structured file tools (9 file tests).
- [✅] Implement general sandboxed process execution with explicit environment
  (required macOS integration exercised, no skipped sandbox cases).
- [✅] Add compatible web tool surface and separate observation from mutation.
- [✅] Verify advertised schemas and complete file/edit/command workflows.
- [✅] Build, review and document migration and rollback. Typecheck and build pass;
  reviewer findings for UTF-8 chunks and cleanup error propagation fixed/tested.
- [✅] Clean task-created test artifacts and reconcile workers.
- [BLOCKED] Real ChatGPT acceptance: refresh metadata and verify read/write/execute.
  Requires access to the user's connected ChatGPT session; local tests are only
  protocol/executor evidence. Owner: main agent with user for account UI.
  Priority: P0 for claiming platform compatibility; next action: connect a separate
  LocalWorks instance using docs/localworks-web.md, refresh and run the documented
  fixture. Success: web tool result matches local files and command exit status.
  Residual risk: platform may still block requests before the service receives them.
  No deployment or alteration of the existing MacMini connector has been performed.

Do not deploy over existing services, publish packages or push source changes as
part of local implementation. Rollback: existing tool modes remain available.
