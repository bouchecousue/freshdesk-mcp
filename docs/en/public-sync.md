# Keeping the public repository up to date

[Français](../fr/public-sync.md) · [README](../../README.md)

The private MCP remains the source of functional changes. This local exporter reads
an explicit list of committed code files and prepares a public update. It never
copies Git history, private commit messages, source commit IDs or private remotes.
No private repository token is needed in public GitHub Actions.

## Preview, apply, review

Prerequisites: a clean public clone, a separate local private clone with its MCP
changes committed, Node 22 or 24, installed npm dependencies and `gitleaks` on PATH.
Use the same Node major for dependency installation and runtime.

From this public repository:

```sh
npm run sync:private -- --source /path/to/private/mcp
```

This is a preview: no files, branches, commits or pushes are created in the public
clone. The candidate is checked in a protected temporary directory and then removed.
To prepare the update after examining the preview:

```sh
npm run sync:private -- --source /path/to/private/mcp --apply
npm ci
npm run check
```

`--apply` creates a local `codex/sync-mcp-…` branch and copies only validated changes.
If there are no changes, it does not create a branch. It does not stage, commit,
push, open a PR or publish anything. On a test failure, the prepared changes stay
local. Review `git diff`, update both documentation languages when needed, commit
only intended files, then scan the committed history before pushing:

```sh
gitleaks git --redact --no-banner --log-opts=--all .
git push -u origin HEAD
gh pr create --base main
```

Merge only after reviewing the public diff and passing CI. Never merge private Git
history into the public repository or use a mirror push. Avoid private source SHAs
and private commit text in the public commit/PR description.

## What can cross the boundary

[public-sync.manifest.json](../../public-sync.manifest.json) lists code paths one by
one. New upstream source/test files, removed files and source/destination symlinks
block the export until explicitly reviewed. New scripts remain excluded unless both
the code boundary and manifest are deliberately updated.

Private documents, deployment files, environment files, runtime data, logs and exports
are not selected or read. Public documentation, artwork, CI and publishing tools
remain maintained in this repository. Public package metadata and scripts stay here;
only the private version, engines and dependency sets are merged. Lockfile dependency
URLs must point to the public npm registry without credentials or URL tokens; local
links and non-registry dependency references are rejected.

The exporter applies narrowly defined portability transforms to the database default
and connection copy. An unrecognized change to the database default blocks export.
It checks selected content for host paths, private network addresses, non-example
Freshdesk tenants and email addresses, then runs Gitleaks with allow-comments disabled.
Missing Gitleaks or a failed scan stops copying. Review remains necessary: no scanner
can recognize every confidential business fact in code or a synthetic-looking fixture.

## Private local deny list

Keep installation-specific markers outside this public repository. Pass a JSON file
with a `deniedLiterals` array (non-empty strings of at least three characters):

```sh
npm run sync:private -- --source /path/to/private/mcp --policy /path/to/private/export-policy.json --apply
```

The list is read locally, checked case-insensitively and never copied into the public
repository. Failures identify the rejected file, not the matching private value.
Add internal domains and identifying customer markers as your private implementation
evolves; do not put credentials into the policy file. Organizations can wrap this
command in their private Makefile to supply the source and policy automatically.

Keep functional changes in the private source too: a public-only MCP fix would be
overwritten by a later export if it has not been ported back. This process does not
modify or deploy any production service.
