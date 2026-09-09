# Worktree/runtime repair

Workline: localworks-worktree-runtime (owner: main agent)

Goal: correct real linked-worktree Git inspection and macOS runtime cache behavior;
generalize relationship checks instead of adding a project-specific path exception. Preserve
all user's repository contents and existing remote routes/credentials.

- [✅] Prior evidence: real workspace has valid Git linkage; native HEAD resolves;
  live command receipt shows cache denial and inaccessible common Git metadata.
- [✅] Parallelism: worktree worker owns new metadata resolver/tests; runtime worker
  owns sandbox runner/tests; main owns integration/config/docs/diagnostics.
  Independent review follows integration; no conflicting write ownership.
- [✅] Validate linked Git metadata under owner-approved roots and reciprocal links.
- [✅] Expose read access to validated metadata; explicitly configure shared writes
  and cooperative shared-resource locking, rather than infer shell command effects.
- [✅] Correct toolchain cache/temp behavior and timezone without broad disk access.
- [✅] Audit nearby failures: dynamic tool-name diagnostics, Desktop capability
  status, source daemon loader, nested workspace hints and managed worktree placement.
- [✅] Test representative worktrees, malformed/outside links, ordinary checkout,
  private scratch cleanup, output/error lifecycle and real metadata inspection.
  37 required OS tests pass without skips. Metadata/lifecycle suites and 9 MCP
  integration/compatibility cases pass. Build and typecheck pass. Real API worktree
  read-only check returns exit 0, correct +0800 offset and unchanged index hash.
  Independent review closed; cleanup-error precedence finding fixed.
- [✅] Review, commit/push and deploy isolated compiled release with rollback
  (application commit 78e55ae). Existing OAuth credentials and state preserved.
- [✅] Verify public MCP against the existing API worktree without modifying its
  source, Git index/refs, branches or deployment resources; clean test artifacts.
  Public read-only command returned exit 0 at 2026-09-09T22:31:26+0800,
  clean Git status and the expected HEAD; index SHA-256 unchanged. No cache denial.
  Local agent listing/cold startup also passed without inference. Verification
  clients/tokens were removed; no active execution claims remain. Both launch
  agents are running. Deployment config enables validated shared metadata writes
  and places new managed worktrees under Projects, without moving existing ones.

Remaining documented boundaries (not claims of full platform support): explicit
Apple shim paths may still emit cache warnings; nested Git requires an explicitly
opened checkout-root workspace; Desktop synchronization needs a verified adapter.
Next steps if these additional capabilities are required: validate the specific
shim/adapter on disposable fixtures before changing its permissions or protocol.
Owner: unassigned; priority P3. These do not block the verified API-worktree path.

Actual ChatGPT platform safety behavior cannot be guaranteed by these local fixes.
