# LocalWorks web MCP mode

This is a compatible, opt-in tool surface, not a workaround for an OpenAI safety
decision. ChatGPT developer mode supports read/write MCP tools, but a local test
cannot prove that a particular ChatGPT call will pass platform checks.

## Configuration and migration

Keep the original TaskQuay service and configuration untouched. Use a separate
`DEVSPACE_CONFIG_DIR` and separate `storage.stateDir`, port and publicBaseUrl for
a LocalWorks test instance. Do not copy credentials into source control. Initialize
credentials locally using the existing CLI setup flow. Existing `codex` and
`claude` modes remain supported and retain their original execution authority.

In the new instance's configuration:

```json
{
  "tools": {
    "mode": "web",
    "webExecution": {
      "allowedDomains": [],
      "environment": [],
      "readRoots": [],
      "gitMetadataWrite": false,
      "allowLocalBinding": false
    }
  }
}
```

These are configuration fragments, not a complete credential-bearing config.
`allowedDomains`, `environment`, `readRoots` and `allowLocalBinding` are selected by the local owner, never by tool
arguments. Environment entries are host variable names, not literal values. Keep
secrets absent unless an explicitly authorized workflow requires them. Tool results
can expose anything printed by a command; environment selection is not redaction.

`readRoots` grants read access to existing toolchain directories. Paths are
canonicalized and broad/protected overlaps rejected. On macOS the selected Xcode
installation is discovered and made readable; actual toolchain executables precede
Apple command shims in PATH. The project `.git` directory is writable for ordinary
Git operations. Explicitly hardcoded Apple shim paths such as `/usr/bin/git` may
still emit cache permission warnings; the runner does not grant global temporary
directory access to silence them. Normal `git` uses the selected real toolchain.
Linked-worktree metadata is resolved from bounded `.git`, `commondir`
and reciprocal `gitdir` pointers inside owner-approved roots. Verified directories
are readable; `gitMetadataWrite: true` additionally permits shared metadata writes.
This can affect shared refs and objects, not just the selected worktree. Web commands
use a common-directory resource claim to serialize these operations. External
editors, terminals and independently configured providers still require their own
coordination and Git's native locks.

Nested workspace discovery stays inside approved roots and grants only the exact
parent `.git` pointer if needed, not the parent source directory. Git's automatic
parent traversal can still require directory access outside a nested workspace.
`open_workspace` therefore returns `gitContext` with the checkout root and relative
working directory: explicitly open that checkout as a workspace, within the user's
authorized task, and pass the subdirectory as `workingDirectory` for repository
operations. The server never silently broadens a nested file workspace or rewrites
Git environment variables to pretend that it is the repository root. Source outside
the opened workspace remains inaccessible. Unrecognized/separate-git-dir layouts or
unverifiable backlinks fail explicitly. Metadata descendants do not add further
grants, and the OS sandbox enforces symlink containment; discovery does not scan
the whole object database for every command.
Git uses the project configuration, not the owner's private home configuration;
configure the intended author identity in the project before committing. The service
does not invent an author identity or export signing credentials.

For macOS development servers, set `allowLocalBinding: true` only when intended.
The installed sandbox SDK permits inbound listening on **all interfaces**, plus
loopback connections, not just a chosen loopback port. Make the application bind
`127.0.0.1` explicitly, but do not treat that application setting as OS enforcement.
Public outbound access still follows `allowedDomains`. Linux host-reachable
listening is not supported by this integration and explicit opt-in fails rather
than silently widening its network policy. The default remains disabled.

Build with `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`.
Run from this checkout using its CLI and the separate configuration directory.
No npm package publication is implied by this repository.

After starting the test service, inspect `tools/list`, connect the new endpoint in
ChatGPT, and Refresh the connection when metadata changes. Roll back by selecting
the previous mode and refreshing again; do not describe the legacy modes as
sandboxed. No state deletion or tunnel change is needed for a tool-mode rollback.

## Contracts

All web tools now publish `outputSchema`; refresh host metadata after upgrading.
See [platform compatibility](platform-compatibility.md) for output shapes, the
logical `program`/`args` execution form and Windows/WSL migration limits.

For managed worktrees, choose `workspaces.worktreeRoot` outside protected service
or credential directories, for example a dedicated folder inside Projects. The
configured worktree root is considered owner-approved only for registry-managed
worktree workspaces; it does not authorize arbitrary checkout paths. Legacy
locations beneath `.devspace` or service state remain protected, so new web-mode
worktrees should use the dedicated project location. Existing worktrees are not
moved or rebuilt automatically.

| Tools | Behavior |
| --- | --- |
| `read_file`, `workspace_context`, `read` | Direct reads. The legacy `read`/context tools can also access explicitly advertised skill resources. |
| `create_directory`, `create_file` | Create a directory or a file without replacing an existing file. |
| `edit_file`, `replace_file` | Require the complete file SHA-256 returned by `read_file`. Stale versions fail. |
| `move_file`, `delete_file` | Version-checked individual file changes; move never overwrites a destination. |
| `command_start` | General shell execution with owner-configured OS isolation; no command-name registry. |
| `command_status` | Non-consuming result query. Repeated completed queries return the same result. |
| `command_stop` | Abort an owned command. Partial filesystem changes may remain. |
| `agent_query`, `agent_execute` | Separate observation from starting/continuing/cancelling queued agents. |
| `work_query`, `work_update` | Separate work history from recording/finishing acceptance. |
| `open_workspace`, `show_changes` | Existing workspace/worktree and Git review capabilities. |

File tools handle bounded UTF-8 text. Use the existing artifact workflow for binary
transfers. Parent directories must exist; create them explicitly. Hash checks detect
stale content but are not an atomic compare-and-swap against hostile external
writers. Cooperative claims serialize participating tools, not arbitrary editors.
Git-backed review remains required for `show_changes`; ordinary file tools work in
non-Git directories too.

Each file tool accepts optional `workRunId`. When provided, the run/workspace scope
is checked before effects and successful/failed operations are recorded. Conflicts
return only workspace-visible ownership and a mode-correct query action; they do
not permit stealing claims or replaying writes automatically.

Command isolation is separate from agent-provider permissions. A configured agent
may have broader access; this mode does not silently downgrade it or claim it is
protected by the command runner. Local skill instructions cannot change runner
policy. Review provider permissions before enabling delegation.

## Process semantics

`command_start` returns a session ID before completion. Query status until
`running` is false, then inspect `exitCode`, `timedOut`, `error` and output. A
successful start is not successful execution. Start requests need a `requestKey`:
the same workspace/key and inputs return the existing session; changing inputs
under that key fails. Only active sessions occupy memory (at most 128 concurrently).
Completed receipts are saved in the service SQLite database. The latest 128
completed outputs are retained; older results return `outputExpired: true`, their
exit status, and no output. Compact request hashes and terminal metadata remain on
disk so an old request is not executed again after output recycling or restart.
This metadata grows with request count; output retention is bounded, not total
database size. Raw commands and raw request keys are not saved. Command output can
contain private information and remains local to this state directory.

Reservation is committed before execution. If a process is unavailable (including
after a crash), the saved request returns `running: null` and
`executionState: "unknown"`, never a fabricated completion or automatic replay.
Inspect actual workspace state before submitting a new request key. This is replay
prevention, not a guarantee that an interrupted command executed exactly once or
completed. Deleting the state database removes that protection and is not a normal
cleanup or recovery procedure. Migration 13 adds the receipt table without altering
existing records; older modes remain usable with the additional table present.

Commands are noninteractive in this initial web surface. Existing local execution
modes retain interactive terminals. The sandbox supports macOS/Linux, must
initialize successfully, and never falls back to an unrestricted shell. System
tools need read access outside the project; this is not a claim of workspace-only
reads. Runner installation and protected credential locations are excluded.
Timeout is bounded to ten minutes; retained output is bounded to 200,000 bytes.
Additional output is drained and discarded, not used to kill an otherwise healthy
command. `outputTruncated` signals omitted output. Runaway commands still stop at
their timeout. These are
not hard CPU, memory or disk quotas. Deliberately daemonized processes that escape
POSIX process groups are not a supported lifecycle.

A cleanup failure stops further managed execution and causes shutdown to report
failure. It is not treated as a successful command or clean teardown. The runner
installation cannot itself be a command workspace; keep the installed service
separate from source checkouts you want to develop through it.

Each command receives private temporary/cache directories which are removed after
completion, failure or cancellation. The runner does not grant the whole system
temporary directory. The owner timezone is passed explicitly and its timezone
data made readable, so `date` uses the local offset rather than silently falling
back to UTC. Always format `%z`; do not append a literal timezone to UTC output.

Request diagnostics use the actual registered tool catalog, so new tool names are
not collapsed to `other`. Command session IDs and exit state can be correlated
without logging command text, credentials or output. Desktop synchronization remains
optional: on platforms without a configured verified Desktop adapter, registration
reports `DESKTOP_ADAPTER_NOT_CONFIGURED`/`not_applicable`, not a workspace failure.
This does not claim a Desktop integration was performed. Source-based daemon
startup explicitly installs its loader; compiled releases do not need it.

Require the macOS/Linux sandbox integration explicitly:

```sh
DEVSPACE_REQUIRE_SANDBOX_COMMAND=1 pnpm exec tsx --test src/sandbox-command.test.ts
DEVSPACE_REQUIRE_SANDBOX_COMMAND=1 pnpm exec tsx --test --test-name-pattern='web MCP' src/server.test.ts
```

## Acceptance

Local automated tests must verify the actual advertised schemas, normal edits,
stale-version rejection, path/symlink boundaries, repeated start recovery, result
retention and shutdown. Sandbox integration must run in a required lane rather than
silently passing after skipping prerequisites.

ChatGPT acceptance remains a distinct step: open a disposable project, create a
file, read its hash, edit it, run a test, inspect the command result, and independently
compare disk contents. Record the exact tool arguments (redacted), error, confirmation
state and server receipt time. Include follow-up and out-of-scope prompts. If a
normal request is blocked before the server receives it, use the evidence for
OpenAI support; do not rename or tunnel the rejected action through another tool.

Official references:
- https://developers.openai.com/api/docs/guides/developer-mode
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/plugins/guides/security-privacy
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/api/docs/guides/tools-shell
