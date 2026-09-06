# Third-party notices and distribution boundaries

Reviewed on 2026-09-06 against the checked-out source and installed direct dependency metadata. This is a **review inventory**, not a replacement for the full license and NOTICE files required when redistributing individual dependencies or a bundle.

## DevSpace upstream

TaskQuay is derived from [Waishnav/DevSpace](https://github.com/Waishnav/devspace). Its [upstream LICENSE](https://github.com/Waishnav/devspace/blob/main/LICENSE) is MIT and contains `Copyright (c) 2026 Waishnav`. The local [LICENSE](LICENSE) is retained without removing that notice. Fork attribution is recorded in [NOTICE](NOTICE).

The project-level MIT license allows distribution of this fork's project source under its conditions. It does not make every dependency MIT, transfer ownership of upstream trademarks, or override model-provider terms.

## Direct runtime and optional dependencies

Versions below are the installed versions observed during this review, not a promise about future resolutions. Use `pnpm-lock.yaml` and inspect the exact packages included in each release.

| Dependency | Observed version | Declared license / terms |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.1.0 | Apache-2.0 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.200 | `SEE LICENSE IN README.md`; Anthropic terms apply |
| `@anthropic-ai/sandbox-runtime` | 0.0.71 | Apache-2.0 |
| `@clack/prompts` | 1.5.1 | MIT |
| `@earendil-works/pi-coding-agent` | 0.80.3 | MIT |
| `@modelcontextprotocol/ext-apps` | 1.7.2 | MIT |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT |
| `@opencode-ai/sdk` | 1.17.13 | MIT |
| `@pierre/diffs` | 1.3.6 | Apache-2.0 |
| `better-result` | 2.10.0 | MIT |
| `better-sqlite3` | 12.10.0 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `diff` | 8.0.3 | BSD-3-Clause |
| `drizzle-orm` | 0.45.2 | Apache-2.0 |
| `express` | 5.2.1 | MIT |
| `jsonc-parser` | 3.3.1 | MIT |
| `lucide` | 1.24.0 | ISC |
| `react` | 19.2.6 | MIT |
| `react-dom` | 19.2.6 | MIT |
| `semver` | 7.7.1 | ISC |
| `yaml` | 2.9.0 | ISC |
| `zod` | 4.4.3 | MIT |
| `node-pty` (optional) | 1.1.0 | MIT |

Package metadata is an entry point for review, not conclusive legal clearance. Development and transitive dependencies are not exhaustively listed here.

## Claude Agent SDK

The [official TypeScript SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript) states that use is governed by Anthropic's Commercial Terms of Service, with separately licensed components retaining their own licenses. Read the version-specific package README/LICENSE and applicable terms before distributing or offering services that depend on it.

Do not label the SDK or a provider's CLI binaries as MIT merely because TaskQuay is MIT. This source repository references dependencies; it does not include a blanket grant to redistribute vendor binaries. Native packages and frontend bundles require their own notice review at release time.

## Assets and brands

Upstream screenshots, the original DevSpace logo, and provider logos are not a new TaskQuay identity. New README files intentionally do not use upstream promotional badges or screenshots as proof of this fork's releases. Existing assets retain their original provenance; review copyright and trademark permissions before reusing them as marketing materials.

OpenAI, Codex, ChatGPT, Anthropic, Claude, DevSpace, and LINUX DO remain names of their respective owners. References describe compatibility, attribution, or a community link; they do not imply affiliation or endorsement.

## Before publishing a package or binary

Determine exactly which dependency code and assets are embedded. Preserve applicable license text, attribution, NOTICE content, and any required source/distribution material. Resolve unclassified or custom-license packages rather than replacing their labels with MIT. Review native binaries and bundled UI separately from source publication.

`package.json` remains in the upstream namespace for runtime compatibility and is marked `private: true` as a publication guard. Choose a namespace you control, update distribution metadata, review the tarball, and complete this checklist before deliberately enabling package publication.
