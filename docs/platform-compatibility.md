# Platform compatibility and output contracts

## Execution host versus browser

Changing the browser's OS does not change the MCP execution host. A ChatGPT browser
on Windows can keep using a MacMini service. Moving the service itself to Windows
or Linux changes filesystem paths, native dependencies, startup and sandbox support.

| Service runtime | File operations | Web command sandbox | Local listening |
| --- | --- | --- | --- |
| macOS Node | Tested locally; canonical paths and descriptor identity checks | Implemented; requires OS sandbox runtime | Owner opt-in; SDK permits all interfaces, not loopback-only |
| Linux Node | Covered by Linux CI | Implemented; needs bubblewrap, socat, ripgrep, timezone data and permitted user namespaces | Host-reachable opt-in unsupported in this integration |
| Native Windows Node (including Git Bash) | Native CI must validate behavior; canonical paths and file identities, not hostile reparse-point isolation | Not implemented; rejects before starting execution | Not available through this web runner |
| Linux Node inside WSL2 | Uses the Linux path; prefer Linux filesystem project directories | Same dependencies and kernel requirements as Linux; WSL itself is not proof of readiness | Same current Linux limitation |

`open_workspace.runtime` reports platform implementation and prerequisites. It is
not a substitute for an actual execution check. Legacy `codex`/`claude` modes retain
their existing user-level execution authority; do not describe them as a Windows
sandbox alternative with equivalent security.

On Windows, Node does not expose POSIX no-follow/nonblocking flags consistently.
File access therefore validates canonical containment and compares exact descriptor
identities before reading, and rechecks identity before replacement. This is an
explicit cooperative access model, not a security boundary against hostile local
processes racing ancestor junctions. WSL UNC paths retain Linux case sensitivity.
File tools accept `/`-separated relative paths, including on Windows. Source handles
are closed before rename/delete, and existing/dangling destinations are rejected.

## Moving a service

Install the supported Node version and run `pnpm install --frozen-lockfile` on the
target host. Never copy `node_modules`: SQLite and optional PTY modules depend on
OS, architecture and Node ABI. Set the new allowed roots, worktree directory, state
directory and public URL. Existing workspace IDs embed old host paths; reopen the
project rather than assuming those paths or IDs migrate unchanged.

macOS launch agents do not run on Windows/Linux. Configure the target host's service
manager, and separately configure the user-owned tunnel. A source-restricted SSH
key for an old machine must not be assumed valid on a new machine. Do not create a
second reverse forward on an already occupied port. OAuth origin/credentials and
ChatGPT connection changes depend on which endpoint and state are preserved.

## Prepared execution

For a simple program, prefer:

```json
{
  "workspaceId": "the-opened-workspace-id",
  "requestKey": "a-new-request-key",
  "program": "git",
  "args": ["status", "--short"]
}
```

Program names resolve through the prepared toolchain PATH. Arguments are literal,
not interpolated shell text. The alternative `command` field still supports shell
pipelines; it cannot be combined with `program`/`args`. Do not add `bash -lc` merely
to run a tool: login configuration can introduce additional access requirements.
Explicit absolute Apple shims or a program that deliberately changes its own PATH
retain their genuine diagnostics. This interface does not rewrite arbitrary scripts,
filter stderr, or grant shared Xcode cache/FSEvents permissions.

## Output contracts

Every web-mode tool advertises an object `outputSchema` and emits matching structured
success data. File tools preserve their flat fields and add explicit status/path on
errors, because SDK clients can validate structured errors as well as successes.
Fields conditional on success/error are documented in their schema descriptions.
Context and command tools preserve their existing JSON text and expose the same
structured payload. Control tools add structured `{ action, data }`; their text
content retains the legacy JSON action result for existing consumers.

Refresh ChatGPT tool definitions after this update. Adding schemas does not turn
write tools into read-only tools or override host safety checks.

## CI evidence

The matrix retains Ubuntu, macOS and Windows installation, typecheck, tests and
package-install checks. Failed test receipts and logs are retained as short-lived
artifacts; identity directories are excluded. Native Windows command execution is
tested as unsupported, not silently skipped and reported as a working sandbox.
The required sandbox integration lane is distinct from ordinary unit tests.
