# LocalWorks release and cutover

Workline: localworks-release-cutover (owner: main agent)

Authorized outcome: commit/push current implementation, stop the old MacMini
service, configure the new service and remote forwarding, and provide connection
settings. Keep the second machine's 8443 endpoint intact.

- [✅] Parallelism: main owns local/remote service changes; independent reader
  checks repository release contents. No conflicting writes.
- [✅] Identify existing launch agents and remote Funnel 443/8443 routes.
- [ ] Review, commit and push source without credentials.
- [ ] Prepare isolated runtime, configuration and generated local credentials.
- [ ] Verify new service locally before changing the public route.
- [ ] Configure new reverse tunnel and switch Funnel 443; preserve 8443.
- [ ] Stop/disable old MacMini launch agents, retain rollback files.
- [ ] Verify public HTTPS, OAuth discovery/token flow, advertised web tools and
  disposable workspace file/command calls through the public endpoint.
- [ ] Reconcile release preflight, clean test artifacts and deliver settings.

Rollback: restore Funnel 443 proxy to 127.0.0.1:7676 and re-enable the retained
com.taskquay.server / com.taskquay.reverse-tunnel launch agents. Do not delete
original configuration, state, source or the second machine's resources.

ChatGPT UI-side acceptance is separate: the user connects LocalWorks and evaluates
its real tool calls. Public-protocol verification does not prove a platform block
has been lifted.
