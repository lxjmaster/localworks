# Publishing TaskQuay without publishing private state

This is a release checklist, not a certificate that the repository or its history contains no secrets. A zero-result scan is meaningful only when its target, exclusions, scanned bytes and exit status have been checked.

## Identity and provenance

Use the TaskQuay project name and retain the original MIT license and upstream attribution. The compatibility command remains `devspace`; `npm install @waishnav/devspace` installs the upstream distribution, not a promised TaskQuay release. Use this fork's source instructions until its own package is intentionally published.

Before creating public commits, decide which author name and email may be public. A GitHub-provided noreply address can avoid publishing a personal mailbox. Changing `git config user.email` affects future commits only; adding `.mailmap` does not erase original commit metadata.

Inspect every branch and tag that will be pushed. Do not assume a new cleanup commit removes sensitive material from earlier commits. Do not use `git push --mirror` as an unreviewed publishing shortcut.

## What to inspect

| Surface | Check |
| --- | --- |
| Tracked working tree and index | Owner tokens, API keys, private keys, real credentials in examples, personal paths, session IDs, endpoints, actual data and logs. |
| Reachable history | Deleted files, old configs, earlier screenshots, commit messages, author and committer identity, annotated tags. |
| Binary assets | Visible accounts, browser URLs, project paths, QR codes, metadata, and branding rights. Text-only secret scans cannot certify these. |
| Release archive | Exact included paths, generated `dist`, docs, source maps, test artifacts, bundled dependency notices. |
| External publication surfaces | CI logs and artifacts, releases, attachments, forks, caches and earlier shared repositories. |

Do not automatically open runtime credential stores while auditing a source release. Exclude local state such as `.devspace` auth/state, `.codex` rollouts, databases, `.env` variants, private key material, and personal inspection outputs. Include only deliberately reviewed public examples.

## Secret scanning

Use a trusted, checksum-verified scanner. For Gitleaks, review the [official usage and coverage documentation](https://github.com/gitleaks/gitleaks). A typical history scan is:

```sh
gitleaks git --log-opts="--all --full-history -m" --redact=100 --report-format=json --report-path=PRIVATE_REPORT_PATH .
```

Replace `PRIVATE_REPORT_PATH` with a private, excluded location. Inspect the scanner's log for actual commits/bytes and exclusions. An exit code of zero with zero scanned bytes is **not** a passed source audit. Large files, LFS, submodules, merge results, encoded content, and archives may need extra coverage.

Also scan the exact release candidate's current files. Do not scan an entire live work directory by blindly including dependency trees and runtime credential folders. A clean, reviewed source export is preferable. `git archive HEAD` exports committed HEAD, **not** pending working-tree edits; test the artifact you will actually publish.

Classify findings rather than blanket-allowlisting them. CI placeholder secrets and sample addresses are not automatically production credentials, but a high-confidence real credential requires revocation/rotation first. Removing a leaked secret from Git cannot revoke it.

## History remediation needs a separate decision

When private commit identity or old material must not be public, work on a separate release clone. Choose between preserving upstream history while rewriting only the sensitive fork history, or creating a reviewed source-only initial release with the original license and attribution intact. Keep the original local repository available for development and recovery.

Do not rewrite active branches or force-push collaborators' history without a deliberate plan. Existing forks, clones and cached views are separate cleanup surfaces. Follow [GitHub's sensitive-data guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Distribution gate

Before publishing, confirm the public repository address and maintainer contact, then replace draft placeholders. Keep `private: true` while npm identity and packaging are unresolved. Review the real tarball in an isolated build environment; this project's prepack script builds and replaces `dist`, so do not run packaging over an active service.

Inspect all redistributed dependency licenses, not just `package.json`'s project-level MIT field. In particular, Claude Agent SDK and model services retain their own terms. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) is a direct-dependency inventory, not a complete legal bundle notice.

Publish only after unresolved privacy findings are addressed, scans have nonzero verified coverage, expected notices are present, and the source-versus-live validation boundaries are documented. Do not claim a completed audit when a tool failed or blocked the missing verification.
