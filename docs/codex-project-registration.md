# Codex Desktop project registration

Opening a directory, saving a DevSpace project, saving a Desktop project, and assigning a thread are distinct operations. `open_workspace` now returns `projectRegistration` with the DevSpace project ID, saved Desktop project ID, requested/saved roots, provider command and home match, before/after metadata, and `uiStatus`. A missing directory requires `createDirectory: true`; existing directories are reused. A failed Desktop step returns `status: partial` and an actionable reason while retaining the usable workspace.

The Codex driver checks registration before opening a thread and assigns the resulting thread before `turn/start`. It persists the original thread identity through the normal session/ledger callbacks before reporting assignment failure. No registration or recovery operation invokes a model. Continue with the original task/request identities; never create a replacement model task to retry registration. Existing multi-root projects are reused without replacing their other roots. Ambiguous projects, a different existing thread owner, mismatched cwd/provider home, schema changes and observed concurrent metadata changes stop registration.

## Verified Desktop control protocol

Verified locally against Windows Desktop **26.901.6511.0**, bundled **codex-cli 0.153.4**. The installed client bundle invokes `project/list`, `project/create` with `idempotencyKey`, and `project/read`; its generated experimental schema defines `thread/metadata/update` with `threadId` and `projectId`. These calls were exercised against the installed binary. The generic [app-server documentation](https://learn.chatgpt.com/docs/app-server) does not by itself establish availability of this Desktop project protocol.

The PATH CLI on the repair machine was 0.135.0, while Desktop's executable was under `%LOCALAPPDATA%/OpenAI/Codex/bin/<version>/codex.exe`. The adapter discovers a verified 0.153.4 binary there; `DEVSPACE_CODEX_DESKTOP_COMMAND` can select an explicit executable. Other binary versions fail closed until validated. Desktop detection uses `.codex-global-state.json` existence only: no global state, trust configuration, auth files, session text or Codex SQLite is edited. RPCs own database persistence. A machine without detected Desktop returns `not_applicable`; a detected Desktop with unavailable control returns `partial`.

This uses real client-supported RPC, **not a JSON compatibility writer**. Consequently there is no external JSON backup/CAS/atomic-rename implementation. Project creation uses the server's stable idempotency key. Thread updates are preceded by ownership/cwd rechecks and followed by readback. The server exposes no conditional `projectId` update: there remains a race between a last read and an external writer's update. The adapter detects observed conflicts and never claims cross-client CAS. Unknown response fields are retained when parsing and never sent back wholesale.

Windows drive aliases, extended paths, UNC and `wsl$`/`wsl.localhost` aliases are normalized for identity. WSL Linux path case is retained. On Windows, pass WSL roots as accessible UNC paths, not ambiguous `/home/...` paths. Filesystem preparation validates existing real parents against the relevant allowed roots before creation, rejecting junction escapes. Other unavailable allowed roots do not block an unrelated local directory.

## Repair without restarting a running service

From the source checkout:

```powershell
pnpm exec tsx src/codex-project-cli.ts --root D:/project/gpt-projects/voice-memory --run-id run_2ef76a4393e84a2c848ec4f1ca418ba5 --thread-id 01a07628-441c-7543-8cc5-ecd6ae75b2be
```

For a new directory, use `--root <absolute-path> --create`; repeat `--root` for a multi-root project. After a normal package build, the same CLI is available as `node dist/codex-project-cli.js`. It is included through the existing TypeScript/package entry layout; no live `dist` replacement is needed for source execution.

`--run-id` obtains the thread IDs from DevSpace's ledger, verifies their original provider instance via `account/read`, and refuses to guess IDs. `--thread-id` adds an explicitly named historical thread, with cwd/ownership validation. Before mutation the CLI saves scoped history hashes and agent/usage ledger hashes in `<stateDir>/project-registration/`; the final receipt records readback and preservation checks. No chat body, reasoning or sensitive global state is printed. Re-running uses the same saved project and workspace binding. This CLI opens only disposable control app-servers and closes only those processes; it does not restart Desktop, DevSpace, the tunnel or other tasks.

## Voice Memory repair and recovery evidence

On 2026-09-06, the ledger associated `agt_d79424f1` with **01a076a1-dc5d-7bf2-93a5-720992328ce7**, not the earlier thread. Both that thread and **01a07628-441c-7543-8cc5-ecd6ae75b2be** had cwd `D:\project\gpt-projects\voice-memory`, but no saved project assignment. Real RPC registered **01a07754-bca4-7430-809a-05c77f83dc4d** and assigned both original threads. A second connection/replay reused the same project and workspace. Both history file hashes and the managed agent/usage ledger hash were unchanged. The original run's acceptance/status was not rewritten.

The evidence receipts are local to the repair machine, under `C:\Users\wrfgup\.local\share\devspace\project-registration\` (`62a3f7b4-6ae6-4795-8663-cb5c887824c8.json` initial, `1106c804-ff62-4791-b81d-5d39088c89c7.json` replay). **Persisted registration is verified; Desktop UI is unverified.** This session has no enabled native Desktop UI control. A successful RPC is not a claim that an existing window refreshed its project sidebar.

`agent_task observe` now honors explicit `includeResponse: true` even with an unchanged revision, so reconnecting clients can recover the persisted terminal response repeatedly. Work receipts retain per-evidence outcomes, including successful artifacts when overall acceptance fails. These are bounded recovery fixes: the historical host summary incorrectly describing an already completed APK is not proof that all DevSpace execution or artifact tools failed.

Validation covers real registration and idempotent replay without inference, mock RPC schema/ownership/concurrency failures, root creation and junction containment, aliases/multi-root reuse, a fake-provider integration proving registration partials never reach `turn/start`, MCP-visible schema/receipt checks, repeated terminal recovery, and artifact evidence under failed acceptance. Source tests/typechecking do not prove that the currently running old server has loaded these changes; use the standalone CLI until the user next starts an updated service.
