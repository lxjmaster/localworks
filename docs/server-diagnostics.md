# Diagnosing a missing server or connector 502

A connector 502 is not proof that a provider or worker failed. Check the local
`/healthz` endpoint and listener first, then compare server and tunnel timestamps.
A tunnel `initialize` error with `failure_source=connect`,
`transport_error_kind=dial` and `upstream_response_received=false` means it did
not receive an MCP response. Do not replay writes or start replacement workers
until their actual state is reconciled. Tunnel readiness alone is not evidence
that the local server is still reachable.

## Lifecycle evidence

Both `devspace serve` and the direct server entry point install diagnostics after
configuration loads. Events go to the existing stdout/stderr logger and a
synchronously appended `<stateDir>/logs/server-diagnostics.jsonl`. The file
rotates at 1 MiB to `.jsonl.1`, retaining one backup (approximately 2 MiB total).
This is best-effort append, not an fsync durability guarantee or audit journal.
Ordinary redirected stdout/stderr retention is unchanged. Use one serving process
per state directory; concurrent writers to the diagnostic file are not coordinated.

- `server_starting`, `server_listening`: distinguish initialization from a bound listener.
- Every event includes a random instance ID, PID, parent PID and monotonic uptime.
- `server_heartbeat` every 30 seconds: RSS, heap use, event-loop delay, pending HTTP
  count and oldest pending request age. This timer does not keep a process alive.
- `server_request_started/finished/aborted`: correlate MCP request lifetimes even
  when a response never finishes. All HTTP requests contribute to heartbeat counts.
  These request IDs belong to diagnostics, not the connector's upstream request IDs.
- `server_signal_received`, shutdown stage events and a 10-second shutdown waiting
  event: identify requested shutdown versus cleanup/draining that has not completed.
- `server_startup_failed`, `server_http_error`, `server_uncaught_exception`,
  `server_before_exit`, `server_exit`: narrow startup, bind, fatal and normal exit paths.

Logging respects `logging.level`; request details also respect `logging.requests`.
Use `info` to retain heartbeats and lifecycle events. Error summaries contain only
a bounded code, message fingerprint and up to eight basename/line/column locations:
no raw error message, stack text, environment, arguments, headers, query strings,
request body, credentials or task contents are added. Existing Node fatal-error
stderr behavior is preserved; review and redact original stderr before sharing it.
If file writes fail, a single `server_diagnostics_write_failed` event is attempted
on stderr; diagnostics do not replace the original failure or prevent startup.

## Limits and interpretation

The uncaught-exception monitor does not suppress Node's default crash behavior.
No unhandled-rejection handler is added. A hard Windows process termination,
SIGKILL, power loss or native abort may leave no exit event. A last heartbeat
without shutdown/exit evidence narrows the interval but does not identify who
killed the process. A blocked event loop cannot emit its heartbeat while blocked.
Failures before configuration/diagnostics installation still rely on stderr.
These changes do not add a supervisor, restart a service or repair tunnel state.

During the 2026-09-06 investigation, the last observed server HTTP log was
22:22:40 +08:00; the inspected tunnel log recorded connection-level 502s from
22:40:54 +08:00. Later checks found no listener on 7676 and no serving Node process.
No matching Windows application crash event was found. The process's exit cause
remains unknown; these observations must not be relabeled as a provider failure.

Deterministic tests cover request completion/abort, secret exclusion, rotation,
write failure, child-process natural/fatal/rejection/HTTP-error exits and shutdown
ordering. Source validation is not live activation; deploy and start the candidate
separately before expecting these events from an existing installation.

In this checkout, broader server tests and whole-project type checking were
blocked by missing installed `@modelcontextprotocol/server` and
`@modelcontextprotocol/node` packages already declared in `package.json`.
This is a separate source-installation finding, not proof of the earlier live
process's exit cause. During the subsequently authorized rollout, a frozen-lockfile
install restored the missing packages without changing the manifests or lockfile.
All 31 selected server, modern MCP, diagnostics and shutdown tests passed, followed
by whole-project type checking and an isolated production build. The candidate was
deployed on 2026-09-06; local health and console endpoints returned successfully.
No task was replayed and no tunnel configuration was changed.
