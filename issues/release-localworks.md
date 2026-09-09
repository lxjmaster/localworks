# LocalWorks release and cutover

Workline: localworks-release-cutover (owner: main agent)

Authorized outcome: commit/push current implementation, stop the old MacMini
service, configure the new service and remote forwarding, and provide connection
settings. Keep the second machine's 8443 endpoint intact.

- [✅] Parallelism: main owns local/remote service changes; independent reader
  checks repository release contents. No conflicting writes.
- [✅] Identify existing launch agents and remote Funnel 443/8443 routes.
- [✅] Review, commit and push source without credentials (`7adcbcc`).
- [✅] Prepare isolated runtime, configuration and generated local credentials.
- [✅] Verify new service locally before changing the public route.
- [✅] Configure new reverse tunnel and switch Funnel 443; preserve 8443.
- [✅] Stop/disable old MacMini launch agents, retain rollback files.
- [✅] Verify public HTTPS, OAuth discovery/token flow, advertised web tools and
  disposable workspace file/command calls through the public endpoint.
- [✅] Reconcile release preflight, clean test artifacts and deliver settings.

Deployment evidence (2026-09-09): the installed service runs compiled `dist/cli.js`
from the pinned release, not the source-selecting launcher. Both service and tunnel
launch agents are running. A restricted dedicated SSH identity reconnects without
interactive Tailscale SSH checks; tunnel restart and public health were verified.
Public verification used the authoritative public Funnel IPv4 while retaining TLS
hostname verification (local VPN DNS returned a synthetic address).

Checks passed: public health, unauthenticated MCP 401, DCR, authorization-code PKCE,
token exchange/refresh, modern discovery and legacy initialization, 18 web tools,
file create/read/edit, sandbox Git+Node execution and local disk readback. Agent
listing cold-start passed locally without inference. Temporary verification tokens
were revoked, client registrations removed, and temporary project files cleaned.

The other machine's unchanged 8443 route has an existing Host validation 403,
observed before this cutover; its backend health works. It is not part of the
MacMini migration. Local handoff records the separate follow-up and rollback.

Rollback: restore Funnel 443 proxy to 127.0.0.1:7676 and re-enable the retained
com.taskquay.server / com.taskquay.reverse-tunnel launch agents. Do not delete
original configuration, state, source or the second machine's resources.

ChatGPT UI-side acceptance is separate: the user connects LocalWorks and evaluates
its real tool calls. Public-protocol verification does not prove a platform block
has been lifted.
