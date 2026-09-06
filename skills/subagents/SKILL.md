---
name: subagents
description: Delegate focused coding, research, review, or verification work to a bounded DevSpace subagent. Use when a task benefits from separate context, a specialist perspective, or a follow-up with the same worker.
---

# DevSpace subagents

Use direct host tools first. `read` and `workspace_context` list/capture/literal-search source without invoking Codex. The host should establish project context, select relevant evidence and perform deterministic checks itself when practical. Do not create a worker just to browse a directory, repeat a repository overview, summarize a known log or wait for a process. Delegating is optional, not the default prerequisite for understanding a project.

When reasoning or implementation benefits from a worker, use native `agent_task` instead of a shell wrapper. A managed shell occupies the checkout, so a wrapper can itself block admission/observation. The direct-terminal CLI remains supported. Never bypass a conflict by changing directories, changing state directories or disabling a guard.

## Concurrency and context policy

Default to **one coherent primary session**, not a prestarted team. Continue it for related implementation, tests and fixes. Up to two pure-analysis workers may run when questions are genuinely independent. Merge high-overlap investigations rather than repeating their background. Use fresh context for an independent high-risk review when needed; do not sacrifice acceptance quality to maximize reuse.

Global active-agent and per-checkout verified-reader defaults are two; writers are exclusive. The Codex adapter applies per-thread offline read-only restrictions, disables configured external tool integrations and requires provider sandbox confirmation before an analysis turn. Unverified providers remain exclusive even with a read-only label. Pure analysis must not run builds, database writes, devices, uploads or package installation. End the read phase and request normal execution with exclusive resources instead. Unknown shell effects remain exclusive. Independent worktrees still need matching resource keys for shared outputs/devices.

Excess work queues locally before provider invocation, with earlier writers taking precedence over later readers on the same source. Default waiting is bounded to five minutes; `cancelQueued` cancels only not-yet-started work. Do not launch a model to wait. Direct host reads do not consume agent slots, but respect source write locks. Locks are cooperative, not control over external editors or terminals; a worktree is not automatically immutable.

Native `start` requires stable `taskKey` and `workItemId`. Initial-request replay returns the existing agent without another turn. For related new requests, use a new task key and a meaningful `contextKey` (module/problem/role), or explicitly continue the agent. Matching idle sessions are reused only within the same authorized workspace, work item, target and compatible model/effort/permissions/profile. `freshContext` deliberately selects a new session; it does not bypass the default three-new-sessions-per-work-item budget. Do not change workItemId to evade that budget. Busy matching sessions should be observed, not cloned.

Native `continue` requires a new `requestKey` for each new instruction; retries reuse that key and identical payload. It is not the same as contextKey. A thread accepts one active or queued turn; another distinct continuation waits at the host until that turn completes, rather than silently interleaving histories. Observe using knownRevision and bounded waitMs, expanding includeResponse only as needed.

Use `workspace_context` to capture explicitly selected file versions. The host prepares a concise `context.summary` and passes capture refs as `context.files` to agent_task. These references are validated after queueing and, for analysis, after completion. Changed inputs fail closed instead of paying for stale reasoning or claiming a stale conclusion is current. Only declared inputs are covered: include applicable rules and important dependencies. Do not paste the whole host conversation or automatically copy all files. The worker may read additional relevant code for correctness; a host summary is evidence, not an instruction overriding AGENTS.md.

## Choose a target

Discover usable targets instead of guessing names:

```bash
devspace agents targets --json
```

Configured profiles include a description and may define provider, model, effort, and task instructions. Choose a matching profile when one fits. Use a provider target when no profile fits or a specific provider is needed.

Usually rely on the target's configured model and effort. Pass `--model` or `--effort` only with a value supported by that provider. DevSpace passes these values through without translating them between providers.

## Start work

Give the subagent a self-contained brief. Include the objective, relevant paths, constraints, decisions it needs from the current conversation, and the expected result. The subagent receives the brief and its profile instructions, not the parent conversation.

```bash
devspace agents run <profile-or-provider> "<brief>" --json
devspace agents run <profile-or-provider> --model <model> --effort <effort> "<brief>" --json
```

For read-only project inspection, explanation, research, or review, pass `--read-only` to `run` and to each read-only `continue` call. This selects read-only execution and the provider's configured `readOnlyDefaults` for model and effort. Explicit `--model` and `--effort` take precedence. Direct file reads do not invoke a subagent model.

Model and effort defaults are resolved for each turn. A `continue` without `--read-only` uses the normal target defaults, so a previous read-only turn does not carry its lighter effort into development. Repeat explicit model or effort options on follow-up turns when you want to keep those overrides.

```bash
devspace agents run codex --task-key audit-1 --work-item review-records --context-key backend/records/reviewer --read-only "Review the specified record transition and its adjacent tests" --json
```

The result contains a DevSpace agent `id` and its current status. Execution continues independently, so retain the ID for later inspection or follow-up.

## Inspect and continue

```bash
devspace agents show <id> --json
devspace agents continue <id> --request-key phase-2 "<follow-up brief>" --json
devspace agents ls --json
```

- `show` waits briefly for active work, then returns the current status and any
  available response or error.
- `continue` gives the same subagent another turn with its existing provider
  session and context.
- `ls` returns sessions belonging to the current project.

Run `devspace agents show <id> --json` again later while the status is `queued` or `running`.
`completed` includes the response. `failed` includes a structured error, and
`stopped` is terminal without a successful response. Continue an agent when its
existing context is useful; start another agent for unrelated work.

No context warm-up/keepalive model calls. Resume preserves history, not a guaranteed provider cache hit. Fork/cache-affinity experiments and automatic immutable snapshot creation are not implemented here. Use provider usage as evidence; do not claim token savings from fewer host messages or from an unmeasured cache-hit assumption.

## Good uses

- Review a change for correctness, security, or missing tests.
- Investigate a bounded part of a codebase and report findings.
- Implement one isolated change with clear acceptance criteria.
- Run a focused verification pass after other work.
