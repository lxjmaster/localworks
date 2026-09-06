# Codex efficiency and coordinated execution

Historical phase-one record. Its blanket single-reader policy is superseded by
[host-first, bounded read-only workflows](host-first-readonly-workflows.md).
The original verification below remains a record of that earlier implementation.

## Goal and priority (2026-09-06)

The user's optimization target is **Codex provider token usage**, not host-model token usage. The host should receive clean, low-noise evidence and remain able to complete long tasks with rigorous acceptance. Do not lower review or release standards to reduce tokens.

The highest priority is preventing unnecessary parallel Codex contexts and concurrent writes/builds in one checkout. Queueing several fresh agents alone does not eliminate repeated context setup: related work should continue the same agent thread, while genuinely independent review retains a separate context when justified.

Starting baseline: `6378ed6`, clean working tree. Existing per-turn model/effort defaults, runtime pooling, provider thread resume, and workspace reuse must be preserved. Do not restart the server/daemon serving this session, publish packages, push Git, or modify other projects or user credentials.

## Implementation order

1. **Admission and execution coordination.** Conservative defaults; admission happens before any provider invocation. One active turn per canonical checkout, including read-only turns unless deliberately isolated. Bound global concurrency across independent checkouts/worktrees. Return actionable structured conflicts/reuse hints, not model-driven wait loops. Coordinate host mutations/commands with active managed agents, and coordinate managed builds that share outputs/resources. Never describe cooperative execution locks as an OS sandbox or claim control over arbitrary external shells.
2. **Context reuse and task identity.** Make continuing a related task explicit and easy. Prevent duplicate starts from minting additional expensive contexts; do not silently reuse an unrelated task, change authority, or remove independent security review.
3. **Actual Codex usage.** Consume provider token-usage notifications; persist per-thread/turn observations, including partial failure. Cumulative snapshots must not be summed, inherited thread history must not be charged again, cache/reasoning details must not be double counted, missing usage must remain unknown. Do not collect hidden reasoning or secrets.
4. **Low-noise status and evidence.** Incremental versioned results, durable bounded logs with scoped references, deterministic summaries, explicit raw pagination, reliable execution arguments and recovery. Extend existing managers rather than adding another model orchestrator. Durable side-effect recovery requires reconciliation, not automatic command replay.

## Acceptance

- Concurrent requests targeting the same real checkout (including aliases) cannot start overlapping provider turns. Independent checkout concurrency is bounded and configurable.
- A conflicting/queued/reused request does not consume a new provider turn. Error/cancel/close paths release only their own execution claims; uncertain owner liveness is fail-closed. Restart does not blindly replay work.
- Host file mutations/managed commands cannot race an active managed writer; do not use unsafe command-string heuristics to decide read-only status. Shared build resources remain exclusive even for otherwise independent worktrees.
- Related follow-ups preserve the provider thread; duplicate task identity does not silently submit the work twice. Existing CLI/config/tool contracts remain compatible or have explicit migration documentation.
- Test concurrency with deferred fake runtimes and counters, including failure, cancellation/close, path aliases, cross-process resource contention, and continued-thread reuse. Run deterministic regression tests before any optional live model test.
- Usage tests cover duplicate/out-of-order cumulative events, resumed history, partial failure, unsupported usage, and separation of cached/reasoning details.
- Report code implementation, deterministic tests, packaged integration, live activation, and measured token savings separately. Never claim savings percentages without usage evidence.

## Progress

## Implemented in this change

The primary concurrency problem is addressed in the execution layer, not only in prompts:

| Capability | Actual behavior |
| --- | --- |
| Admission before provider work | Default one active managed agent globally; configurable 1–16 across independent checkouts. Same real checkout is exclusive even when tasks are read-only. |
| Shared cross-process ownership | SQLite IMMEDIATE transactions coordinate the agent daemon and MCP process against the same state directory. Real paths, checkout roots and ancestor overlap prevent path aliases from bypassing the guard. |
| Write/build competition | Host patches, Claude write/edit/bash and Codex managed commands coordinate with agent turns. Commands keep their claim until process exit, not just until the first tool response. Explicit resource keys additionally cover shared build outputs/devices across worktrees. |
| Task identity and context reuse | Native starts require stable task keys. Duplicate initial requests return the stored agent without another provider call; mismatched instructions conflict. Follow-ups continue the original provider thread. Terminal CLI supports optional `--task-key`. |
| Hidden Codex fanout | Managed Codex thread start/resume passes `features.multi_agent=false`. Installed Codex 0.135.0 accepts that setting; a fake App Server verifies it is transmitted. User-wide Codex configuration is unchanged. |
| Native control-plane tool | Both tool modes expose `agent_task` with start/continue/observe/list/claims/usage. It does not acquire shell claims; bounded local wait and revision checks avoid shell-wrapped polling and repeated response delivery. |
| Provider usage evidence | Usage notifications are saved before turn completion, including partial failure. Counters are whitelisted; cumulative snapshots replace rather than sum; stale/duplicate totals are ignored; unobserved resumed history stays unknown. Cache/reasoning details are not added to totals. |
| Compatibility | New SQLite migrations 7–9, regenerated configuration schema and daemon protocol 4. Existing per-turn model/effort defaults and thread/runtime reuse remain covered by regression tests. |

`subagents.maxConcurrentAgents` defaults to 1. `subagents.sharedResources` and managed command `resources` use matching explicit keys. Parallelism is a deliberate exception for isolated work, not the default decomposition of a coupled task. An admission conflict does not queue an expensive model invocation. After the owner finishes, continue the relevant existing agent or explicitly continue the stopped initial task via its agent ID.

## Verification performed

All verification after the initial provider failure used deterministic local tools and fake providers; no additional paid model verification tasks were launched.

- Eight concurrent fake-provider requests produced exactly **one** provider turn and seven pre-invocation conflicts.
- Identical task-key starts returned one agent ID; replay after completion did not invoke the provider again; follow-up preserved its provider thread.
- Independent database connections and a separate Node process could not acquire a held checkout. Alias/subdirectory, shared-resource, failure-release and close/interruption cases passed.
- Host mutation/build attempts were rejected before execution while an agent held the checkout; host ownership also prevented a provider from starting.
- In-memory MCP transport tested both tool surfaces, native task control while a checkout was occupied, response revisions, task-key forwarding, and usage authorization before storage reads.
- Fake Codex App Server over actual JSON-RPC pipes, including Windows, tested usage before the `turn/start` reply, old-turn filtering, duplicate notifications, partial failure, resume and callback failure isolation. Installed CLI schema was generated locally without inference.
- The final full repository test run reported **118 tests: 115 passed, 0 failed, 3 skipped**. The Pi sandbox test also explicitly reported unavailable sandbox-runtime dependencies inside its file. POSIX-only branches are not Windows validation.
- TypeScript no-emit checking passed. Server TypeScript emission and Vite production UI build passed in `node_modules/.cache/devspace-candidate/dist`, leaving live `dist` untouched. The compiled CLI help command ran successfully. Existing Vite chunk-size warnings remain; no UI redesign was attempted.
- The compiled JavaScript coordinator was loaded in a separate smoke command: conflicting checkout acquisition was rejected, release allowed the next command, and no provider was invoked. After adding CLI help text for `--task-key`, targeted task/CLI tests, type checking and isolated TypeScript emission were rerun successfully.
- Early full runs exposed old protocol-version and migration-list fixtures; these now follow the new contracts without weakening unauthorized-request or migration assertions.

Commands used (serially):

```text
node node_modules/tsx/dist/cli.mjs scripts/generate-config-schema.ts
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 --test-reporter=spec "src/**/*.test.ts"
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.build.json --outDir node_modules/.cache/devspace-candidate/dist
node node_modules/vite/bin/vite.js build --outDir D:/project/devspace/node_modules/.cache/devspace-candidate/dist/ui
node node_modules/.cache/devspace-candidate/dist/cli.js --help
```

The accepted test log is local and ignored: `node_modules/.cache/devspace-efficiency-tests-accepted.log`. Build products and logs are not committed.

## Rollout and remaining limits

This is verified source plus an isolated build, **not a hot-swapped live MCP connection**. The active server and daemon were not restarted; no npm package was published and no Git push was performed. Activate through the existing controlled build/restart procedure only after active work is settled and the host can reload the new `agent_task` schema. Old daemon protocol 3 must not be used as evidence for protocol-4 admission guarantees.

One intended coding worker could not run: first executable discovery failed before provider execution; the same agent's next attempt reached the provider and returned an execution error. The host completed implementation directly rather than launching more Codex contexts. That failed provider attempt has no trustworthy usage ledger; no saving percentage or real-task A/B result is claimed.

This change does not implement the entire earlier roadmap. Durable raw-log paging/automatic summaries, general process recovery, automatic orphan-claim reconciliation, per-task token budgets and task compaction remain separate work. Current `usage` returns at most 20 recent observations with `hasMore`; it is not an all-time billing export. A decreasing cumulative counter is ignored rather than invented as new spend. Growth is relative to its named observation baseline, not a guaranteed billing-turn delta.

Cooperative claims do not sandbox arbitrary shell commands, stop external terminals, discover undeclared cross-worktree output paths, or control separately daemonized children. Native Codex fanout is disabled, but an arbitrary shell launching an independent model CLI is not covered by that feature flag. Independent security review remains appropriate after the writer or against a separate immutable snapshot.

Interrupted claims are deliberately retained and inspectable; they cannot be stolen just from elapsed time/PID absence, and there is no automatic release or command replay. An operator must first reconcile actual processes and external effects. This fail-closed limit must not be presented as fully autonomous crash recovery.
