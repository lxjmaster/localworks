# TaskQuay

**Visible tasks. Accountable local execution.**

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/wrfgup/taskquay) · [Security model](docs/security.md) · [MIT license](LICENSE)

TaskQuay is a self-hosted execution and project-management layer for MCP-capable AI hosts. Let ChatGPT or another host inspect your workspace directly, delegate bounded work to Codex when useful, and return a result backed by changes, checks, and a task-level usage receipt.

It is an **independent fork of [Waishnav/DevSpace](https://github.com/Waishnav/devspace)**, not an official OpenAI, Anthropic, or upstream DevSpace product. The upstream implementation and its MIT copyright notice are retained. This fork focuses on host-first context gathering, controlled agent concurrency, reusable sessions, observable work, and honest Codex usage reporting.

> **Early-stage, source-first project.** The public-facing name is TaskQuay. The CLI command, configuration directory, MCP identifiers, and existing UI labels remain `devspace` for compatibility. The upstream npm package does **not** necessarily include this fork's changes. The source repository is [wrfgup/taskquay](https://github.com/wrfgup/taskquay); no TaskQuay npm release is implied.

## Why this fork?

Remote coding is more than letting a model run a terminal command. A useful workflow should answer: Who started this task? Is something still writing or building? Which conversation already understands the problem? Did verification finish? How much Codex usage actually belongs to this run?

TaskQuay puts those questions into explicit tools and local state instead of leaving them entirely in a long chat transcript.

| Capability | What it does |
| --- | --- |
| **Host-first inspection** | `read` and `workspace_context` let the host inspect selected files, search text, and collect versioned references without starting a Codex inference request. |
| **Bounded delegation** | Verified read-only workers can share source access within configured limits. Writers and unknown-effect commands remain exclusive; shared build outputs and devices use resource claims. |
| **Session reuse** | Related work can continue an existing thread. Work-item identity, context affinity, and request idempotency are separate; independent review can deliberately use fresh context. |
| **Project console** | `/console/` groups tasks, origins, execution state, acceptance evidence, Codex sessions, usage, and unresolved claims by project. |
| **Usage receipts** | Work completion returns provider-reported Codex usage with a completeness label. Missing telemetry is not silently presented as zero. |
| **Scoped chat housekeeping** | Archive/restore workflows preview an exact project-scoped set, require confirmation, and skip conversations whose ownership or activity cannot be verified. |

The goal is to avoid unnecessary Codex contexts, repeated investigation, and conflicting work—not to maximize the number of agents running at once. No fixed token-saving percentage is promised.

## How it fits together

```text
You
  └─ MCP host: planning, direct inspection, decisions, acceptance
       └─ TaskQuay / compatible devspace tools
            ├─ Workspace reads, edits, commands and evidence
            ├─ Task ledger, concurrency and resource claims
            ├─ Bounded Codex sessions when delegation is needed
            └─ Project console and completion receipts
```

The host remains the orchestrator. TaskQuay is not an opaque autonomous manager, a replacement for Codex, or a hosted model service.

**Local execution does not mean that all data stays on your machine.** File contents returned over MCP go to your selected host; delegated prompts and tool results may go to the model provider. Choose authorized projects and follow the host/provider's current privacy settings and terms.

## Run from this source tree

Requirements are defined in `package.json`: Node.js `>=22.19 <27`, Git, and the pinned `pnpm@11.25.0`. Install and authenticate a supported Codex CLI separately when you need Codex delegation. Direct workspace tools do not require a Codex inference call.

Clone **this fork**, then run:

The package currently has `private: true` as a guard against accidental npm publication under the upstream namespace. This does not prevent publishing the reviewed source repository under MIT.

```sh
git clone https://github.com/wrfgup/taskquay.git
cd taskquay
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm build
node bin/devspace.js init
node bin/devspace.js doctor
node bin/devspace.js serve
```

Use the initializer to choose permitted roots, provider configuration, and your connection settings. Keep the generated owner authorization secret private. To avoid modifying an existing installation, test in a separate environment and back up its configuration and state first.

**Do not run a clean/rebuild over a service that is actively executing work.** `pnpm build` replaces `dist`; upgrades need a controlled stop, build, restart, and host-tool refresh after active operations settle.

### Connect an MCP host

The default local MCP endpoint is:

```text
http://127.0.0.1:7676/mcp
```

A remotely hosted client generally needs a reachable HTTPS endpoint, for example:

```text
https://your-controlled-host.example/mcp
```

Provide the base origin without `/mcp` during setup. Configure your tunnel/reverse proxy and approve the connection using the owner authorization flow. TaskQuay does not manage or own your tunnel.

The same `/mcp` endpoint retains upstream support for the 2026-07-28 per-request protocol and stateless compatibility with older 2025-era clients. There is no separate protocol mode to configure.

Custom MCP availability depends on your host, account, workspace settings, and policies. Consult the [current ChatGPT developer-mode documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt); this project does not grant product access or bypass provider controls.

### Open the project console

```text
http://127.0.0.1:7676/console/
```

The console uses the owner secret with its own authenticated browser session and is local-only by default. Remote console access is a separate explicit HTTPS opt-in, not a consequence of exposing `/mcp`. See the [console guide](docs/project-console.md) and [configuration reference](docs/configuration.md).

## A workflow worth keeping

Start one top-level work run with `work_task`, then propagate its `workRunId` through inspection, edits, commands, and agent calls. The host should first gather relevant context directly. Delegate only work that benefits from a worker, give it clear boundaries and versioned evidence, and continue the relevant session for follow-up changes and tests.

Use independent review when the risk justifies it. Finish only after child operations stop and actual acceptance evidence has been checked. A model's final message is not proof that a build, deployment, or GUI verification succeeded.

An example request to your connected host:

> Open my approved project. Begin a work record, inspect the relevant files directly, and propose the smallest safe fix. Use Codex only where useful; reuse its session for follow-ups. Run the appropriate checks, review the final diff, and return the task's Codex usage and completeness with the result. Do not deploy or publish without separate authorization.

See [host-first workflows](docs/host-first-readonly-workflows.md) for exact tool contracts and concurrency behavior.

## Understand the usage numbers

| Label | Meaning |
| --- | --- |
| **Complete** | The mapped execution boundary and provider usage observations are available. |
| **Partial** | Some usage is recorded, but the task still has measurement gaps. |
| **Unavailable** | Evidence is insufficient for an accurate number; this is not zero. |
| **Not used** | No managed Codex inference was started for the measured work. |

Cache input and reasoning output are breakdowns, not extra amounts to add to totals. Session history, manual Codex activity, and separate external model commands must not be assigned to a later task merely because they share a directory. Provider token observations are not your subscription balance or an invoice. Reusing a session does not guarantee a cache hit.

The runtime-pool callback fix and regression scope are documented in [usage accounting](docs/console-usage-callback-fix.md). Old records without reliable events may remain unavailable rather than being retrospectively invented.

## Safety and current limits

**Treat the connection as privileged local access.** File tools enforce workspace paths, but shell commands run with the local user's authority and are not a general filesystem sandbox. Source/resource claims coordinate participating processes; they cannot stop an unrelated editor or terminal.

Read-only analysis must not be confused with building, installing, writing to databases, operating a device, or publishing. Those operations need appropriate execution permissions and resource ownership. Interrupted claims require reconciliation; chat archival does not cancel processes.

The project is developed and locally exercised on Windows, with inherited cross-platform code and CI definitions. A CI matrix is not proof that every current fork feature was verified on every platform. Test your actual host/provider/OS combination. Inherited native artifact-download support also has platform-specific limits.

Automatic immutable snapshots, arbitrary-checkpoint forks, guaranteed cache affinity, and complete automatic orphan recovery are not claimed. Archive/restore safety fixtures exist, but the recorded zero-inference empty-thread experiment did not complete real restore/list verification. Validate a newly created, explicitly authorized test conversation in your own Codex instance before relying on batch archival; do not experiment on unrelated chats.

Never include owner secrets, provider credentials, private rollouts, task databases, personal paths, or unsanitized screenshots in public issues. See [publication checks](docs/open-source-checklist.md).

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

Prefer focused changes, deterministic fixtures, and tests through the actual manager → pool → provider boundary. Run live-provider experiments only with explicit authorization and report their real cost. Keep source/candidate verification separate from activation of a running installation.

## Documentation

| Guide | Scope |
| --- | --- |
| [Setup](docs/setup.md) | Existing compatible CLI and configuration flow; some upstream distribution references remain historical. |
| [Host workflow](docs/chatgpt-coding-workflow.md) | Workspaces, tools, review and task receipts. |
| [Configuration](docs/configuration.md) | Provider, concurrency, roots and console options. |
| [Console](docs/project-console.md) | Origins, accounting, acceptance and archive safeguards. |
| [Security](docs/security.md) | Authority and deployment boundaries. |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Dependency and branding caveats. |

## License and upstream credit

Project source is distributed under the [MIT license](LICENSE). The original `Copyright (c) 2026 Waishnav` notice and the MIT permission text are preserved. See [NOTICE](NOTICE) for fork attribution.

Dependencies and provider services retain their own licenses and terms. In particular, the Claude Agent SDK is not declared MIT by this repository; its package points to Anthropic's applicable terms. A binary/npm release requires an additional bundled-dependency notice review. TaskQuay has no official affiliation with its upstream or model providers.

## Community link

[LINUX DO - 新的理想型社区](https://linux.do/)

An independent community link, not a statement of sponsorship or endorsement.
